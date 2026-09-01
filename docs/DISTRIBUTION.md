# AdDroid OSS — 配布ガイド (fork maintainer 向け)

この fork を **他の人に渡す** ときの手順とチェックリストです。
受け取る側の手順は [`docs/SETUP.md`](./SETUP.md) を参照してください。

---

## 0. いちばん重要なこと

**配布は `git clone` 経由に限定してください。フォルダごとのコピーは禁止です。**

リポジトリ直下の `.env` には `ENCRYPTION_KEY` が入っています。これは
`oauth_tokens` に保存された **Meta / GitHub / LLM のトークンを復号できる鍵**です。
`.gitignore` 済みで履歴にも入っていないため git 経由なら渡りませんが、
zip / AirDrop / rsync / Time Machine 復元では一緒に渡ります。

さらに `addroid init` は、既に実値が入っている `ENCRYPTION_KEY` / `DATABASE_URL` を
**上書きしません**(既存環境の復号能力を壊さないための仕様)。受け取った人が素直に
`addroid init` を実行しても鍵は作り直されず、警告が出るだけです。

やむを得ずディレクトリを渡す場合は、渡す前に `.env` を削除し、
渡した後で **元の環境の鍵と DB パスワードも入れ替えて**ください。

---

## 1. 配布前チェックリスト

```bash
# 1) 個人情報の混入検査 (denylist は自分の値を入れて実行する)
ADDROID_PERSONAL_GITHUB_DENYLIST="<自分のGitHubログイン>" \
ADDROID_PERSONAL_HOSTNAME_DENYLIST="<自分のドメイン>" \
  npm run oss:hygiene

# 2) 型検査とテスト
npm run typecheck
npm test

# 3) .env が tracked になっていないこと
git ls-files --error-unmatch .env 2>/dev/null && echo "NG: .env が tracked" || echo "OK"
```

`oss:hygiene` は次を検出します。**denylist 系は env を設定しないと no-op** なので、
配布のたびに自分の値を渡して実行してください。

| 検出項目 | env 設定 |
|---|---|
| 個人の絶対パス (`/Users/<name>/` 等) | 不要 (常時) |
| 実在の広告アカウント ID (`act_` + 11桁以上) | 不要 (常時) |
| 実在の Meta オブジェクト ID (17桁以上) | 不要 (常時) |
| 各種 API キー / トークン形状 | 不要 (常時) |
| 個人 GitHub ログイン | `ADDROID_PERSONAL_GITHUB_DENYLIST` |
| 自前ドメイン / トンネルのホスト名 | `ADDROID_PERSONAL_HOSTNAME_DENYLIST` |

---

## 2. ブランチ運用

個人設定を含む運用ブランチと配布ブランチを **必ず分けてください**。
同じブランチで運用すると、いずれ個人設定が混ざったまま出ていきます。

| ブランチ | 用途 | 個人設定 |
|---|---|---|
| `main` | fork maintainer 自身の運用 | 含んでよい |
| `dist` | 配布用 | **含めない** (`oss:hygiene` が通ること) |

配布用ブランチには、自分の案件専用スクリプト (レポート生成など) を置かないでください。
受け取る側の環境ではパスが存在せず、実行時に落ちるだけです。

---

## 3. 受け取る側に必ず伝えること

### 3.1 Web UI に認証は無い

外から使えるようにする場合は認証プロキシが必須です。
詳細は [`docs/SECURITY.md` §1.1](./SECURITY.md) を渡してください。
ここを伝え忘れると、広告費の承認画面が公開状態になります。

### 3.2 費用は「トグルを入れた瞬間」から発生する

初期状態で動く cron は内部処理の 2 本 (`github_poll` / `retention_sweep`) だけで、
LLM も画像生成も呼ばれません。**課金はゼロ**です。

一方、次を有効にすると費用が発生し、**上限を掛ける仕組みはありません**。

| cron | 既定 | 有効化したときの費用 |
|---|---|---|
| `daily_report` | off | 1 日 1 回 × アカウント数の LLM 呼び出し |
| `today_report` | off | **1 日 24 回** × アカウント数の LLM 呼び出し |
| `budget_guard` | off | 1 日 1 回の LLM 呼び出し (対象ゼロでも呼ばれる) |
| `improvement_pr` | off | 週 1 回 × 8 エージェントの LLM 呼び出し |
| `auto_creative_generation` | off | **毎日** 8 エージェント + 画像生成 |

**画像生成の費用は `ai_runs` に $0 として記録されます。**台帳を見ても
画像の実費は分かりません。これは口頭で伝えてください。

### 3.3 予算アラートは初期値では鳴らない

`workflows/budget-guard.yaml` のテンプレートは全しきい値が `0` (= 無効) で、
`accounts` も空です。実弾を使う前に日予算・月予算・アラート比率を設定するよう
伝えてください。

### 3.4 Meta App は各自で作る

配布元の Meta App にフォールバックする仕組みはありません。受け取る側が自分で
Business App を作り、System User トークンを発行します。手順は
[`docs/META.md` §2.1](./META.md)。**開発モードのままだとトークン登録までは成功し、
入稿の段階で初めて失敗します。**問い合わせの大半はここです。

### 3.5 Windows はそのままでは動かない

WSL2 が必要です。`addroid doctor` の `platform` チェックが Windows native を
`error` で止めます。

---

## 4. ライセンス

本リポジトリは [`bb8ad8/addroid-oss`](https://github.com/bb8ad8/addroid-oss) の
fork です。Apache-2.0 で配布する場合、次の 2 点が条件です。

1. `LICENSE` をそのまま同梱する
2. 変更点を明示する (本 fork の変更点は [`README.md`](../README.md) 冒頭に記載)

本家に `NOTICE` ファイルは無いため、`NOTICE` の作成は不要です。
なお Apache-2.0 は**商標の使用許諾を含みません**。"AdDroid" の名称をそのまま
使って再配布する場合は、その点を認識したうえで判断してください。
