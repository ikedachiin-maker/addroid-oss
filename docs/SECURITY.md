# AdDroid OSS — Security & Network Posture

AdDroid は **localhost-only / outbound-only** で動作するセルフホスト OSS です。
このドキュメントは AdDroid OSS のセキュリティ前提と、OSS リリース衛生を維持するための
ルールをまとめます。

---

## 1. ネットワーク前提

| 項目 | 既定値 | 補足 |
|---|---|---|
| Web UI バインドアドレス | `127.0.0.1:3000` | `0.0.0.0` でリッスンしてはならない |
| Web UI 認証 | なし (ローカルプロセスを信頼) | 多人数運用では将来 SSO を検討 |
| GitHub Webhook | **使用しない** | `merged PR` 検知は API ポーリング (ETag-aware) |
| Meta Webhook | **使用しない** | レポート / 階層同期は AdDroid からの outbound のみ |
| Slack request URL / event URL | **使用しない** | Socket Mode (WebSocket outbound) のみ |
| Public IP | **不要** | inbound 接続は受け付けない |
| 専用ドメイン / SSL 証明書 | **不要** | `https://` は要求しない |
| トンネリングサービス (ngrok 等) | **不要** | outbound のみ |

すべての外部統合 (GitHub, Meta, Slack, LLM Provider, Image Provider) は
**AdDroid 側から outbound** で起動します。inbound webhook / 公開 URL を要求する変更は
**コントラクト違反** であり受け入れません。

### 1.1 Web UI を外部公開する場合 (最重要)

**Web UI にはログイン機能がありません。**弱い認証ではなく、認証そのものが存在しません。
`/approvals` `/accounts` `/budget` `/setup` を含む全ページが素通しで、
**ポートに到達できた人はそのまま広告アカウントの管理者**です。127.0.0.1 でしか
listen しない前提で成立している設計です。

`apps/web/lib/request-guard.ts` は名前が紛らわしいのですが **CSRF 対策であって認証では
ありません**。合言葉は tracked source に書かれた固定値で、ブラウザ以外からのリクエストは
素通しします。

したがって、トンネル (Cloudflare Tunnel / ngrok / Tailscale Funnel 等) で外から
アクセスできるようにする場合は、**認証プロキシを必ず前段に置いてください**。

| やること | 内容 |
|---|---|
| 必須 | Cloudflare Access / Tailscale ACL / mTLS など、**AdDroid に到達する前に認証を終える**仕組みを置く |
| 必須 | `ADDROID_DEV_ORIGINS=<公開ホスト名>` を env で設定する (`next.config.mjs` に直書きしない) |
| 確認 | 公開後に `curl -I https://<公開ホスト>/api/health` が **認証画面へリダイレクトされる**ことを実測する |
| 禁止 | 認証プロキシ無しでの公開。広告費の承認画面が誰でも押せる状態になります |

`addroid status` や `/setup` が表示するバインドアドレスは **env から導出した「意図」**であり、
実際の listen 状態ではありません。`next dev -H 0.0.0.0` のように直接起動すると
127.0.0.1 の保証は破れますが、画面上は `127.0.0.1:3000` のまま表示されます。

---

## 2. Secrets の取扱い

### 2.1 リポジトリに **絶対** コミットしてはならないファイル

- `.env`, `.env.local`, `.env.production` など `.env.example` 以外の `.env*`
- `secrets.local.yaml`, `secrets.local.yml`
- AdDroid の `~/.addroid/` 配下のファイル一切
- GitHub OAuth トークン / Personal Access Token
- Meta Access Token / OAuth リフレッシュトークン
- Slack Bot トークン (`xoxb-*`) / App-level トークン (`xapp-*`) / User トークン (`xoxp-*`)
- Codex / OpenAI OAuth トークン / API Key
- `ENCRYPTION_KEY` 値
- 個人 GitHub アカウント名 / 組織名 / リポジトリ名のハードコード
- 個人パス (例: `/Users/<username>/...`)
- 特定の `act_<id>` / Slack `team_id` / `channel_id` のハードコード

これらは `.gitignore` に登録済みです。`git add -A` を避け、コミット前に
`git status` で意図しないファイルが含まれないことを確認してください。

### 2.2 OAuth / API トークンの保存

すべての外部 provider トークン (GitHub / Meta / Codex / Slack) は Prisma の
`oauth_tokens` テーブルに **暗号化境界越しで** 保存します。

- 暗号化アルゴリズム: AES-256-GCM (`packages/config` の `getCryptoBoundary()`)
- 鍵: 環境変数 `ENCRYPTION_KEY` (32 byte 以上の base64 / hex / raw)
  - base64 (44 字, padded) → 32 byte に decode
  - hex (64 字) → 32 byte に decode
  - raw UTF-8 (>=32 byte) → SHA-256 で 32 byte に派生
- ciphertext 形式: `v1.aes256gcm.<iv-b64>.<tag-b64>.<payload-b64>` (各 IV はランダム生成)
- `oauth_tokens` の主要列:
  - `provider` — `github` / `meta` / `openai` / `anthropic` / `slack`
  - `accountIdentifier` — provider 内のテナント識別子 (例: GitHub login、Meta user id、Slack team_id)
  - `accessTokenCiphertext` / `refreshTokenCiphertext`
  - `scopes` / `expiresAt` / `connectedAt` / `lastRefreshedAt`
- 鍵を `.env*` に書く場合も `.env` または `.env.local` のみ。`.env.example` には placeholder のみ。
- DB スナップショットを共有する場合は `oauth_tokens.access_token_ciphertext` ごと
  共有しても、`ENCRYPTION_KEY` を共有しなければトークン本体は漏れません。

### 2.3 secrets.local.yaml

`secrets.local.yaml` はユーザーがローカルでのみ参照する補助 secrets ファイルで、
AdDroid runtime は `~/.addroid/secrets.local.yaml` を読み取り得ます。
このファイルは `.gitignore` で除外され、コミット対象外です。`packages/config` の
`readLocalSecrets()` / `getLocalSecret(dottedKey)` 経由で参照し、ファイル mode は
`addroid init` / `ensureSecretsFilePermissions()` が `0600` を強制します。

### 2.4 Provider 別の token 取扱い

| provider | 取得経路 | 保存場所 |
|---|---|---|
| GitHub | CLI `addroid connect github` の OAuth Device Flow / Web UI `/github` の OAuth Code Flow | `oauth_tokens` (provider="github") |
| Meta | `addroid connect meta` または Web UI `/accounts` の OAuth Code Flow | `oauth_tokens` (provider="meta") |
| Codex | ローカル Codex CLI / `codex app-server` のログイン状態を利用 | AdDroid には保存しない |
| OpenAI / Anthropic | CLI `addroid connect ai` の API key 登録 | `oauth_tokens` (provider="openai" / "anthropic") |
| Slack | `addroid connect slack` で Bot/App トークンを暗号化保存 (Socket Mode 接続テスト後) | `oauth_tokens` (provider="slack") |

トークンはすべて **平文をプロセス内変数のみで保持**し、ログ出力や `console.log` を
行わない契約です。Web UI / CLI / Slack の sanitize-on-render により、表示直前に
`access_token` / `Bearer ` / `xoxb-` / `xapp-` / `xoxp-` / `sk-` プレフィックスを
`[REDACTED]` に置換します。

---

## 3. 暗号化境界

```
+------------------+    plaintext     +-------------------+
|   addroid CLI    |  -------------->  |  packages/config  |
|   addroid Web    |                  |   crypto layer    |
|   addroid Worker |                  +-------------------+
+------------------+                          |
                                       AES-256-GCM
                                              |
                                              v
                                      +----------------+
                                      |  PostgreSQL    |
                                      |  oauth_tokens  |
                                      +----------------+
```

- 平文トークンはプロセス内変数のみで保持し、ログ出力しない。
- DB に書き込む時点で常に暗号化文字列に変換する。
- 暗号化器は `packages/config` の `crypto.ts` に集約し、他コードは平文を直接 DB に
  書く API を持たない。改ざん検知 (GCM auth tag) は `decrypt` が `CiphertextFormatError`
  として例外で報告し、サイレントに復号成功させない。
- 大きめのバイナリ / テキスト (ops repo クローン、生成画像、ai_run の大きな payload) は
  `LocalDiskStorage` 経由で `~/.addroid/storage/` に置く。書き込み時に常に mode `0600` を
  付与し、相対 key の path-traversal を `StoragePathError` で拒否する。

---

## 4. GitOps と監査ログ

- 広告配信または予算を変える可能性があるすべての操作は、
  Pull Request + 監査ログ (`audit_logs`) の二重記録を必須とします。
- Apply (PR merge → PAUSED 作成) と Activate (PAUSED → ACTIVE 遷移) は別の承認境界です。
  両者は `approval_records` の polymorphic targetType で区別され、独立に許可 / 却下できます。
- Zod スキーマ (`packages/ops-schemas`) と dry-run plan で以下を必ず拒否します:
  - 不正な GitOps operation manifest / cron 設定の構造
  - `account.key` パスの不整合
  - 安全でない予算変更 (既定では 2x 以上を警告、5x 以上をブロック)
  - 初期 active キャンペーンの作成
- 入稿ガードの設定は ops repo の `workflows/guards.yaml` に保存します。
  Web UI `/guards`、CLI chat、ダッシュボード chat、Slack chat から自然言語でも変更できます。

### 4.1 audit_logs.actor の規約

| actor 値 | 用途 |
|---|---|
| `addroid` | システム自身 (cron / pg-boss / apply executor) |
| `user:<github_login>` | ops repo 上の merge 操作 (GitHub merge) |
| `user:web-ui` | Web UI からの merge / Activate / cron 起動 |
| `user:cli` | `addroid` CLI からの操作 (`activate` 等) |
| `slack:<user_id>` | Slack `/adops` 経由の操作 |
| `ai:<model>` | AI workflow による自動操作 (`improvement_pr` ほか) |

### 4.2 主な audit_logs.action

- `ops_repo.bootstrapped` — ops repo を初めて連携した
- `apply.enqueued` — merged PR を検知し `execute_apply` を queue に投入
- `apply.blocked_unapproved` — merge を検知したが承認 / mode / branch protection で遮断
- `activate.requested` / `activate.executed` — Activate 要求と実行
- 実装中の追加 action は `apps/worker/src/lib/audit-store.ts` を確認

---

## 5. Meta token / sandbox / mock の取扱い

- Meta Access Token / OAuth トークンは `oauth_tokens` (provider="meta") に AES-256-GCM で保存。
- 開発・E2E では `ADDROID_META_OAUTH_MOCK=1` で `MockMetaAdapter` を選択。Mock は
  外部 `graph.facebook.com` への通信を一切行わず、in-memory `MockMetaSandbox` で
  campaign / adset / ad / creative / insights を deterministic に再現します。
- 本番運用では mock フラグを必ず外すこと。`addroid doctor` および
  `/setup` の OSS Release Readiness カードで mock 設定の残置を warn として提示します。
- Sandbox 用の Meta App と本番 Meta App はトークン自身の app type で区別され、Web UI の
  TopBar / `/setup#meta` / `/accounts` で `live` / `sandbox` / `mock` / `unconfigured` を
  常時可視化します。Apply / Activate の ConfirmDialog body 先頭に mode を mono で表示し、
  `mock` / `sandbox` 中は確認ボタンに対応するサフィックスを付けます。
- Apply は新規オブジェクトを **すべて PAUSED で作成**するため、誤って本番 token で
  Apply が走っても予算消費は発生しません。Activate は別経路で人間承認が必要です。

詳細は [`docs/META.md`](./META.md) を参照してください。

---

## 6. Slack token の取扱い

- Slack 連携は **任意**。トークンを設定しなくても AdDroid OSS は通常通り稼働し、
  `/setup#slack` および Dashboard の Slack カードは benign idle を表示します。
- 連携時は `addroid connect slack` で Bot Token (`xoxb-*`) と App-Level Token (`xapp-*`、
  `connections:write` scope) を暗号化保存します。コマンドは Socket Mode 接続テストを
  実行し、成功時のみトークンを永続化します。
- Slack は **Socket Mode 専用**。public な request URL / event URL を要求しません。
  `templates/slack-app-manifest.yaml` をそのまま Slack 管理画面に貼り付けて App を作成できます。
- `/adops` slash command は 3 秒以内 ack → pg-boss キュー → `response_url` で応答する
  契約を維持し、長時間実行は worker 側で安全に処理します。

詳細は [`docs/SLACK.md`](./SLACK.md) を参照してください。

---

## 7. LLM / Image Provider token の取扱い

- LLM Provider 未設定時は `StubLLMProvider` が **fail-closed** し、AI workflow は GitOps
  状態を破壊せずに失敗します。`improvement_pr` は提案を生成できないため `skipped` 扱いで
  PR は作成されません。
- Codex はローカル Codex CLI / `codex app-server` のログイン状態を利用し、AdDroid DB には
  Codex token を保存しません。
- OpenAI / Anthropic API key 認証を使う場合、API key は `oauth_tokens.access_token_ciphertext`
  に AES-256-GCM で暗号化保存します。`.env` に恒久保存する必要はありません。
- Image Provider 未設定時は creative 生成を skip し、improvement_pr は **テキストのみで PR
  を作成**します (UI は `succeeded_text_only` の benign idle 表示)。
- LLM 入力 / 出力 JSON は ai_runs に保存される前に redactor を通し、token-shape の値や
  個人 path / GitHub login を `[REDACTED]` / `~/<rest>` に置換します。

詳細は [`docs/LLM_PROVIDER.md`](./LLM_PROVIDER.md) を参照してください。

---

## 8. OSS リリース衛生チェックリスト

リリース前に必ず確認します。リリース手順全体 (バージョニング / CHANGELOG /
`npm publish` 実発行 / git tag / ロールバック) は [`docs/RELEASE.md`](./RELEASE.md) を、
リリースごとの変更点は [`CHANGELOG.md`](../CHANGELOG.md) を参照してください。本節は
**衛生 (secret / 個人 path / hardcoded value の不在)** に限定したチェックリストです。

- [ ] `git ls-files` の出力に `.env*` が含まれていない (`.env.example` のみ tracked)
- [ ] `git ls-files` の出力に `secrets.local.yaml` が含まれていない
- [ ] `git ls-files | grep -E '\.png$'` で個人 path や個人 GitHub login が含まれる
      Playwright / Puppeteer 取得画像が混入していない
- [ ] コードベース内に `/Users/<personal>` のような絶対個人パスが残っていない
- [ ] コードベース内に `/home/<personal>` / `C:\Users\<personal>` が残っていない
- [ ] 個人 GitHub アカウント名 / 組織名 / リポジトリ名がハードコードされていない
- [ ] 特定 `act_<id>` / Slack `team_id` / `channel_id` がハードコードされていない
- [ ] `ENCRYPTION_KEY` の実値が `.env.example` 等に書かれていない (placeholder のみ)
- [ ] `addroid doctor` で `secrets.local.yaml` のパーミッション (`0600`) チェックが
      `ok` になる (`apps/cli/src/lib/checks.ts` の `checkSecretsLocal`)
- [ ] Web UI `/setup` の "Security & Network Posture" パネルで
      `.gitignore` が `.env` / `secrets.local.yaml` を除外していることが
      `ok` になる (`apps/web/app/setup/page.tsx` で `.gitignore` を読み取り検証)
- [ ] Web UI `/setup#release` の OSS Release Readiness カードが warn / fail を表示していない
- [ ] README / docs に inbound webhook / public domain を要求する記述がない
- [ ] `ADDROID_*_MOCK` / `ENABLE_MOCK_*` フラグが `.env.example` で commented-out のままで、
      実値が書かれていない
- [ ] `npm run publish:dry-run` が成功する (実 publish は人間承認後に手動実行)

---

## 9. 報告窓口

セキュリティ脆弱性を発見した場合は、GitHub の Security Advisories 経由で
**非公開**報告してください。OSS であるためパブリックなチケットには記載しないでください。

contribution 全般のガイドラインは [`CONTRIBUTING.md`](../CONTRIBUTING.md) を参照してください。
