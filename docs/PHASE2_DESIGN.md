# Phase 2 設計書 — クリエイティブ量産テストループ

作成: 2026-07-08 / ステータス: 設計確定・Tier 1 実装待ち

## 目的

新しい広告クリエイティブを継続的に量産し、少額で自動テストして、勝ちパターンに
予算を寄せ、負けを止めるループを AdDroid 上で回す。商用 SaaS（Meteo 等）の
「月30〜50本テスト・24時間最適化・承認だけ」に相当する体験を、AdDroid の
GitOps 承認基盤の上で実現する。

## 確定した運用方針（ユーザー決定 2026-07-08）

- **自動化レベル**: 全て提案・承認制。負けの停止も勝ちの昇格・増額も、AI は提案まで。
  実行（実課金）は必ず人間が Web UI で承認する（Phase 0+1 と同じ安全境界）。
- **初回実装範囲**: Tier 1（画像クリエイティブでループを完成）。動画接続は Tier 3 に後回し。
- **テスト予算**: 1クリエイティブあたり日 1,000 円 × 5本 = 日 5,000 円を目安（後で変更可）。

## アーキテクチャ（2026 Meta 標準に準拠）

キャンペーンを2つに分離する。

- **テスト用キャンペーン（ABO / ad set 単位予算）**: 各変異体を 1 ad set = 日 1,000 円で
  公平に配信し、実力を測る。ここが変異体の「登竜門」。
- **スケール用キャンペーン（CBO）**: テストで勝った変異体だけを昇格。Meta が自動で
  予算を勝者へ寄せる。

### ループ

1. **生成**: N 本（初回=5本）の変異体を作る。既存 `improvement_pr` のクリエイティブ生成
   （image_prompt → creative_qa）を再利用。Tier 1 は画像のみ。
2. **投入**: テスト用キャンペーンに、各変異体を `experiment_run_id` で束ねて投入。
   全て PAUSED → ユーザー承認 → 配信（既存の Apply/Activate フロー）。
3. **計測**: 既存の日次/毎時インサイト収集（`performance_snapshots`, 広告単位）をそのまま使う。
4. **判定**: 新 cron `experiment_evaluator` が変異体単位に集計し、サンプル下限に達したものを評価。
5. **繰り返し**: 空いたテスト予算で次バッチへ。

## 判定ロジック（統計ガードレール込み）

**サンプル下限（これを満たすまで勝敗を決めない）**: 変異体ごとに
`spend ≥ 目標CPAの2倍` または `conversions ≥ 50` または `経過 ≥ 7日` のいずれか。
（ノイズで勝敗を決めない。これが既存 automation_rules DSL に無い部分。）

**目的別の判定指標**（objective-aware）:
- コンバージョン目的: CPA / ROAS が主。
- 認知目的（現行の AD_RECALL_LIFT 等）: フック率（3秒視聴率）/ CPM / 結果単価が主。CPA は使わない。

**負けを停止（提案）**:
- サンプル下限到達後、CPA > 目標CPA × 1.5（または口座平均比で大幅悪化）
- フック率が口座平均の 75% 未満（動画）
- 48時間 Meta が予算をほぼ回さない（アルゴリズムが見切った）

**勝ちを昇格（提案）**:
- サンプル下限到達 かつ CPA ≤ 目標CPA（または ROAS ≥ 目標）
- → スケール用キャンペーンへ複製 + 予算増額（+20%/日・上限つき）を提案

すべて提案 = Web UI `/approvals` に届く。承認して初めて実行。

## データモデル（新規3テーブル）

- **experiment_runs**: 1 実験（= 1 バッチのテスト）。account / campaign / adset、status
  (running|paused|completed|failed)、config（変異体数・テスト予算・判定閾値・目的）。
- **experiment_variants**: 変異体。run への FK、variant_index、creative への FK、
  展開した Meta ad_ids[]、status、評価時点の成績スナップショット。
- **experiment_evaluations**: 評価履歴。run への FK、evaluatedAt、変異体別メトリクス、
  winner、停止対象[]、昇格対象[]、recommendation。

Prisma 規約（`prisma/schema.prisma`）に準拠: `@@map` スネークケース、子テーブルは
`onDelete: Cascade`、頻出クエリ列に `@@index`。`Creative` に `experimentRunId` FK を追加。

## 既存資産の再利用マップ

| 使うもの | 状態 |
|---|---|
| クリエイティブ生成（image_prompt + creative_qa） | ✅ 再利用（`improvement-pr.ts`） |
| ops YAML → PR → apply → Meta 反映 | ✅ 再利用（`apply-meta-executor.ts`、画像/動画両対応済み） |
| 広告単位の成績（`performance_snapshots`） | ✅ 再利用 |
| 停止/増減額の実行系（`automation_actions` + executor） | ✅ 再利用 |
| 承認・監査（`approval_records` / `audit_logs`） | ✅ 再利用 |
| cron 登録（`presets.ts` / `boot.ts` / `runtime.ts`） | ✅ 同パターンで追加 |
| ops repo YAML ローダ | ✅ 同パターンで `experiment-config.yaml` を追加 |

追加は「実験管理 + 判定エンジン」層のみ。CI/CD の中核フローは変更なし。

## 安全境界

- 新規の実験広告は常に PAUSED で作成。配信開始（ACTIVE 化 = 課金）は人間承認。
- 停止・昇格・増額はすべて提案（proposal）。auto_apply はしない（ユーザー決定）。
- テスト予算は config で上限を持つ（日 5,000 円目安）。増額提案は +20%/日・日予算上限つき。
- 配信ルール（新規 ad set は翌日 0:00 JST 開始）を踏襲。

## Tier 1 実装チェックリスト（画像でループを完成）

1. Prisma 3 モデル追加 + `Creative.experimentRunId` → `db:push`
2. `experiment-config.yaml` ローダ（テスト予算・閾値・目的）
3. `experiment_evaluator` cron を `CRON_PRESETS` に追加 + `runtime.ts` にハンドラ
4. 判定ロジック実装: 変異体別に `performance_snapshots` を集計 → サンプル下限判定 →
   停止/昇格候補を算出 → `automation_actions`（提案）に落とす
5. 実験セットアップ経路: 5 変異体を生成 → テスト用キャンペーンに ad set 展開する
   ops YAML を組み、`experiment_run` と `experiment_variants` を記録
6. Web UI: 実験の一覧・変異体別成績・評価結果を表示する `/experiments` ページ（最小）
7. テスト（判定ロジックのユニット + E2E モック）

## Tier 2 / 3（後続）

- **Tier 2**: 明らかな負けの自動停止（サンプル下限超 + CPA 大幅超のみ、安全上限つき）。
  勝ちの昇格・増額は引き続き承認制。
- **Tier 3**: 縦型短尺の動画パイプライン（現行の認知動画 `build.mjs` = 1080×1920）を
  「動画クリエイティブプロバイダ」として接続。`VideoProvider` インターフェース新設、
  `improvement_pr` パイプラインに注入。注意: `vsl-movie` は横型長尺 VSL 用で広告には不適。
  Codex 画像がクォータ制（約5h周期・15〜25枚/周期）のため量産はバッチ/資産再利用が前提。

## 確定した判定指標・パラメータ（ユーザー決定 2026-07-08）

- **1バッチの変異体数**: 初回 5 本（慣れたら増やす）。
- **現行の認知キャンペーンのテスト判定指標**: 「動画100%完全視聴」ベース。
  - 完全視聴率 = `video_p100_watched ÷ impressions`（クリエイティブの引きの強さ）
  - 完全視聴単価 = `spend ÷ video_p100_watched`（効率）
  - 5本をこの2指標で相対比較し、勝ち=完全視聴が安く多く取れる動画を昇格、負けを停止。
- **目標 CPA 2,000 円**: 最終（商品/リード）目標。スケール段階、およびコンバージョン目的に
  切り替えた際の判定基準に使用。認知段階では CPA は判定に使わない。

### 実装上の含意

判定ジョブ（`experiment_evaluator`）は基本4指標（impressions/clicks/conversions/spend）
に加え、Meta insights から **`video_p100_watched_actions`（100%完全視聴）** を追加取得する。
`insight_rows`（柔軟 breakdown 対応）経由で action-type 別メトリクスを取得できるため、
その経路を使う。完全視聴率・完全視聴単価を変異体別に算出してサンプル下限判定にかける。

### なお未確定（実装時に確認）

- スケール用キャンペーンの CBO 予算上限。
- コンバージョン目的へ切り替える時期（現状は認知目的で完全視聴ベース）。

## 2026-07-11 追記 — 認知広告運用プレイブック取り込み

池田式の認知広告メソッド（Meta動画広告の教科書 講座 2025-10-22）を AdDroid に取り込んだ。
正本: ops repo `knowledge/awareness-ads-playbook.md`、閾値: `workflows/awareness-playbook.yaml`。

**実装済み（Phase 2 を待たず稼働）:**

- `improvement_pr`（週次AI改善提案）の 8 agent パイプラインに、プレイブックの運用ルールを
  `knowledgeBriefs` として注入（analyst / strategy / copy / image_prompt / media_buyer）。
- 認知広告ガード（`workflows/guards.yaml` の `awarenessOptimizationGoal`、plan/PR検証層）:
  adset の optimization_goal が REACH / IMPRESSIONS なら警告（既定 warn・block 可）。
  認知(OUTCOME_AWARENESS)キャンペーン配下は AD_RECALL_LIFT / THRUPLAY のみ許可。

**Phase 2 判定ロジックへの反映事項（Tier 1 実装時に組み込む）:**

- 完全視聴率の**絶対合格ライン 2%**（`awareness-playbook.yaml` の `kpi.videoCompletionRateMin`）を
  相対比較に追加する。5本全てが 2% 未満なら「勝者なし・全滅（フック差し替えで再生成）」の判定を出す。
- 実験テンプレートとして**想起リフト(AD_RECALL_LIFT) vs ThruPlay(THRUPLAY) の並行テスト**を持つ。
  同一クリエイティブでもファイル名を変えて別アップロードし、視聴者オーディエンスを分離する。
- **動画視聴者リスト 1,000 件到達**（`audience.videoViewersSeedTarget`）を
  類似オーディエンス 1%/3%/5% 作成 + CV広告投入の提案トリガーにする（experiment_evaluator の副次出力）。
- テスト予算の既定は `testing.dailyBudgetPerCreative`（日1,000円）× `testing.batchSize`（5本）を参照する
  （本設計書の日5,000円と整合）。
- ThruPlay 成果課金（15秒以上視聴のみ課金）の可用性をアカウント実績に応じてチェックし、
  選択可能になったら billing_event=THRUPLAY への切り替えを提案する。
