// AdDroid OSS — queue 層の永続化境界 (test seam)。
//
// pg-boss の cron / apply 連携は最終的に Prisma の cron_schedules / cron_runs /
// execution_logs / github_pull_requests / github_polling_state / apply_jobs を
// 触るが、queue パッケージから @addroid/db を直接 import すると pg-boss を
// 持たない場所でも prisma を引き込んでしまう。
//
// そこで queue パッケージは「最小限のメソッドだけを持つ Store インタフェース」
// に依存し、apps/worker 側で Prisma を実装として注入する。
// テストでは in-memory な fake を実装して挙動を検証する。

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------
// CronOpsStore — cron_schedules / cron_runs / execution_logs を扱う境界
// ---------------------------------------------------------------------
export interface UpsertCronScheduleInput {
  workspaceId: string;
  name: string;
  cron: string;
  enabled: boolean;
}

export interface StartCronRunInput {
  scheduleId: string | null;
  name: string;
  jobId: string;
}

export interface FinishCronRunInput {
  cronRunId: string;
  scheduleName: string;
  durationMs: number;
  output?: JsonValue;
}

export interface FailCronRunInput {
  cronRunId: string;
  scheduleName: string;
  durationMs: number;
  error: string;
}

export interface ExecutionLogInput {
  cronRunId?: string;
  workspaceId?: string;
  kind: string;
  refType?: string;
  refId?: string;
  level?: "info" | "warn" | "error";
  message: string;
  payload?: JsonValue;
}

export interface CronOpsStore {
  upsertCronSchedule(input: UpsertCronScheduleInput): Promise<{ id: string }>;
  startCronRun(input: StartCronRunInput): Promise<{ id: string }>;
  finishCronRun(input: FinishCronRunInput): Promise<void>;
  failCronRun(input: FailCronRunInput): Promise<void>;
  recordExecutionLog(input: ExecutionLogInput): Promise<void>;
}

// ---------------------------------------------------------------------
// GithubPollStore — github_repos / github_polling_state /
//   github_pull_requests / apply_jobs を扱う境界
// ---------------------------------------------------------------------
export interface OpsRepoSnapshot {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  etag: string | null;
  lastModified: string | null;
}

export type PrApprovalDecision =
  | "approved"
  | "rejected"
  | "auto_blocked"
  | "auto_approved";

export interface PrApprovalEvidence {
  id: string;
  decision: PrApprovalDecision;
  approvedBy: string;
  headSha: string | null;
  mergeSha: string | null;
  decisionSource: string | null;
}

export interface RecordPollingStateInput {
  repoId: string;
  etag?: string | null;
  lastModified?: string | null;
  lastStatusCode: number;
  nextPollAt?: Date | null;
}

export interface UpsertPullRequestInput {
  repoId: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  baseRef: string;
  htmlUrl: string;
  mergedAt: string | null;
  mergeSha?: string | null;
  mergedBy?: string | null;
}

export interface RecordApplyJobInput {
  pullRequestId: string;
  jobId: string;
  state: "queued";
}

/**
 * merged PR を検知して execute_apply を enqueue したことを audit_logs に残す境界。
 * GitOps 経由で広告配信を変えうる操作はすべて監査対象という契約要件
 * (the current implementation acceptance §10) を満たすため、merge 検出時に 1 行記録する。
 */
export interface RecordMergeAuditInput {
  workspaceId: string;
  pullRequestId: string;
  prNumber: number;
  headSha: string;
  htmlUrl: string;
  /** pg-boss が返した job id。null の場合は enqueue 自体は試みたが id が取れなかったケース。 */
  jobId: string | null;
  applyJobId: string;
}

/**
 * merged PR が検知されたが、AdDroid の承認境界を確認できないため execute_apply
 * の enqueue を拒否したことを記録する境界。
 *
 * the current implementation 制約「All Meta mutation must originate from approved GitOps state」
 * を満たすため、同じ headSha に対する承認レコードが無い場合は apply path を通さない。
 */
export interface RecordApplyBlockedInput {
  workspaceId: string;
  pullRequestId: string;
  prNumber: number;
  headSha: string;
  htmlUrl: string;
  /**
   * - `missing_addroid_approval` : 承認レコードが無く、GitHub merge も承認として
   *   記録できなかった。
   * - `approval_head_sha_mismatch` : 承認レコードの headSha と merged PR の headSha
   *   が一致しない。
   * - `invalid_approval_source` : 承認レコードが対応済み承認ルート由来ではない。
   * - `approval_record_failed` : GitHub merge を承認として記録できなかった。
   * - `prior_blocked_approval` : 当該 PR には既に `auto_blocked` (もしくは
   *   `rejected`) の approval_records が存在する (improvement_pr ワークフローで
   *   policy / audit が報告した結果や、UI / CLI からの拒否)。merge 検出時点で
   *   fail-closed させ、上流決定を保存する。
   * - `report_only_mode` : workspace.executionMode が `report_only` で、かつ
   *   どの active ad_account の `modeOverride` も `report_only` を覆していない。
   *   契約上「report_only never mutates Meta」なので merge 検出時点で
   *   execute_apply の enqueue を拒否する (regression fix)。
   */
  reason:
    | "missing_addroid_approval"
    | "approval_head_sha_mismatch"
    | "invalid_approval_source"
    | "approval_record_failed"
    | "prior_blocked_approval"
    | "report_only_mode";
  /** sanitized 1 行説明 (UI/監査ビュー向け)。 */
  detail: string;
}

/**
 * `approval_records` に PR レベルの承認・却下・自動承認・自動却下を 1 行残す境界。
 *
 * the current implementation 受入: 「approval_records、execution_logs、audit_logs に PR マージ、
 * Apply、Activate、CLI 実行、失敗分類、再認証要求を記録する」。
 * 本レコードは PR 単位の最終決定を 1:N で残し (再開・差し戻し含む)、`audit_logs`
 * の 1 行 + `execution_logs` の `github_poll` ステップと組み合わせて GitOps の
 * 承認境界を 3 重に記録するために使う。
 *
 * - `decision="approved"` : Web UI / CLI / Slack / GitHub などで承認された。
 * - `decision="rejected"` : 対話型に否決された。
 * - `decision="auto_blocked"` : merged だが AdDroid 承認境界を満たさないため
 *   enqueue を拒否した。
 */
export interface RecordPrApprovalInput {
  workspaceId: string;
  pullRequestId: string;
  /**
   * 承認/拒否の主体。AdDroid 自身が判断したケースは "addroid"。将来 UI から
   * 人間レビュアが操作する場合は `user:<github_login>` を入れる。
   */
  approvedBy: string;
  decision: "approved" | "rejected" | "auto_blocked" | "auto_approved";
  /** 表示用の短い理由 (sanitized)。 */
  comment?: string;
  /** 追加 metadata (PR 番号、headSha、htmlUrl、apply_job 紐付け等)。 */
  metadata?: JsonValue;
}

/**
 * regression fix: workspace 全体の `executionMode` と、配下 active な
 * ad_account の `modeOverride` をまとめて返す。
 *
 * `runGithubPollOnce` が merged PR の execute_apply enqueue を許すかを
 * 判定する際に使う。queue 層の `resolveExecutionMode` で各 account の
 * 実効 mode を計算し、すべての候補が `report_only` に解決される場合のみ
 * fail-closed で enqueue を拒否する (override が一つでも `proposal` /
 * `auto_apply` を要求していれば、apply-executor 側の per-account
 * revalidation に判断を委ねる)。
 *
 * `accountOverrides` が空配列のときは「active な ad_account がまだ未登録」
 * の状態であり、呼び出し側は workspace mode 単独で評価する。
 */
export interface WorkspaceExecutionModeContext {
  /** `workspaces.executionMode`。null は worker 起動前 / 不明値。 */
  workspaceMode: string | null;
  /**
   * active な ad_account の `modeOverride` 一覧。順序は重要ではない (各値は
   * `resolveExecutionMode` の override 引数として個別に評価される)。
   */
  accountOverrides: Array<string | null>;
}

export interface GithubPollStore {
  /** 当該 workspace に紐付いた ops repo を返す。未登録なら null。 */
  findOpsRepo(workspaceId: string): Promise<OpsRepoSnapshot | null>;
  /**
   * regression fix: 当該 workspace の `executionMode` と active な
   * ad_account の `modeOverride` 集合を返す。`runGithubPollOnce` が
   * merge 検出時に「`report_only` で Meta mutation を許してよいか」を
   * fail-closed で判定するため。
   */
  loadWorkspaceExecutionModeContext(input: {
    workspaceId: string;
  }): Promise<WorkspaceExecutionModeContext>;
  recordPollingState(input: RecordPollingStateInput): Promise<void>;
  /**
   * PR を upsert する。`transitionedToMerged` は「直前は merged ではなかったが
   * 今回 merged になった」場合に true。merged 検出 → execute_apply enqueue の
   * トリガに使う。
   */
  upsertPullRequest(
    input: UpsertPullRequestInput
  ): Promise<{ id: string; transitionedToMerged: boolean }>;
  recordApplyJob(input: RecordApplyJobInput): Promise<{ id: string }>;
  recordMergeAudit(input: RecordMergeAuditInput): Promise<void>;
  /**
   * AdDroid の承認境界を満たさない merged PR の execute_apply enqueue を拒否した
   * ことを audit_logs / execution_logs に残す。apply_jobs は作成しない。
   */
  recordApplyBlocked(input: RecordApplyBlockedInput): Promise<void>;
  /**
   * PR 単位の承認決定を `approval_records` に 1 行記録する。
   */
  recordPrApproval(input: RecordPrApprovalInput): Promise<void>;
  /**
   * 当該 PR の最新 `approval_records` を返す。
   *
   * `loadApplyApprovalSnapshot` と同じく `createdAt desc` で 1 行のみ参照する
   * (PR は 1:N の決定履歴を持つ)。merge 検出時に `approved` と同じ headSha
   * を確認できたときだけ execute_apply を enqueue する。
   */
  findLatestPrApproval(input: {
    pullRequestId: string;
  }): Promise<PrApprovalEvidence | null>;
}

// ---------------------------------------------------------------------
// ApplyJobStore — execute_apply ハンドラが触る境界。
//   apply_jobs / execution_logs / audit_logs を扱う。Prisma 依存を queue に
//   持ち込まないため、apps/worker 側で実装を注入する。
// ---------------------------------------------------------------------

export interface ApplyJobContext {
  /** apply_jobs.id */
  applyJobId: string;
  /** apply_jobs.pullRequestId */
  pullRequestId: string;
  /** github_pull_requests.number */
  prNumber: number;
  /** github_pull_requests.headSha */
  headSha: string;
  /** github_pull_requests.htmlUrl */
  htmlUrl: string | null;
  /** github_pull_requests.repoId */
  repoId: string;
  /**
   * regression fix: 実行直前の `loadApplyApprovalSnapshot` で確定した
   * `approval_records.id`。`runExecuteApply` が revalidation 成功後に
   * `context` に焼き付け、`MetaActionExecutor` 経由で Meta CLI invocation の
   * `refs.approvalRecordId` に伝播する (Apply の command evidence を承認境界に
   * 紐付けるため)。
   *
   * `findApplyJobContext` 段階では取得できないため optional。snapshot が
   * 取れなかったケース (= revalidation 失敗で Meta mutation に到達しない) では
   * undefined のまま。
   */
  approvalRecordId?: string | null;
  /**
   * 当該 PR が base branch に入った merge/squash/rebase commit SHA。
   * Apply loader はこの commit とその first parent の差分を読むことで、
   * 他 PR の未承認/別承認差分を巻き込まず、承認PR単位の状態だけを適用する。
   */
  mergeSha?: string | null;
}

export interface MarkApplyRunningInput {
  applyJobId: string;
}

export type ApplyTerminalState = "succeeded" | "failed" | "simulated";

export interface MarkApplyFinishedInput {
  applyJobId: string;
  state: ApplyTerminalState;
  errorMessage?: string;
  /** 任意の summary JSON。UI の `/apply/[id]` で表示される想定。 */
  result?: JsonValue;
}

export type ApplyAuditAction =
  | "apply.simulated"
  | "apply.executed"
  | "apply.failed"
  | "apply.blocked_unapproved"
  | "creative.modified_via_apply"
  | "oauth.meta.reauth_required"
  | "meta.api_error"
  | "meta.cli_unknown_error";

/**
 * Execute-time revalidation snapshot (regression fix)。
 *
 * `runExecuteApply` は実行直前に「現在の」ops repo / PR / approval_records 状態を
 * このスナップショットで再取得する。その後 PR が closed に戻された / approval が
 * rejected に上書きされた / approval headSha と PR headSha がズレた場合は
 * 実行段階で fail-closed させる。
 * 手で `apply_jobs` 行を作ってもこのチェックを通らない限り Meta mutation 経路に
 * 到達しない。
 */
export interface ApplyApprovalSnapshot {
  /** 現在の PR state ("open" / "closed" / "merged")。null なら PR 行が消えている。 */
  pullRequestState: "open" | "closed" | "merged";
  /** 現在の PR head SHA。AdDroid 承認が同じ変更に対するものか検証する。 */
  pullRequestHeadSha: string;
  /**
   * 当該 PR に対する最新の approval_records.decision。null なら 1 行も存在しない
   * (= 手で apply_jobs を挿入したケース)。
   */
  latestApprovalDecision:
    | "approved"
    | "rejected"
    | "auto_blocked"
    | "auto_approved"
    | null;
  /** 最新 approval_records.metadata.headSha。無い場合は null。 */
  approvalRecordHeadSha: string | null;
  /** 最新 approval_records.metadata.mergeSha。無い場合は null。 */
  approvalRecordMergeSha?: string | null;
  /** 最新 approval_records.metadata.decisionSource。無い場合は null。 */
  approvalDecisionSource: string | null;
  /**
   * regression fix: 当該 PR の最新 `approval_records.id`。
   * `runExecuteApply` がこれを `ApplyJobContext.approvalRecordId` に焼き付け、
   * Meta CLI invocation の `refs.approvalRecordId` 経由で `execution_logs` の
   * 各 Apply CLI 行に承認境界を紐付ける (Apply command evidence ↔ approval boundary)。
   * `latestApprovalDecision` が null のときは null。
   */
  approvalRecordId: string | null;
  /** PR が merged 化したタイムスタンプ。表示用 (= UI の audit 詳細で使う)。 */
  mergedAt: Date | null;
}

export interface RecordApplyAuditInput {
  workspaceId: string;
  action: ApplyAuditAction;
  applyJobId: string;
  pullRequestId: string;
  prNumber: number;
  headSha: string;
  ref?: string;
  /**
   * Meta 側 creative_id。指定時、実装は audit の target を既定の
   * `apply_job:<id>` ではなく `creative:<id>` にする。`creatives.externalId`
   * に一致する行があれば内部 id に解決し、per-creative の Audit trail
   * パネル (creatives/[id]) からも辿れるようにする。
   */
  creativeExternalId?: string;
  /** Sanitized JSON metadata (token は決して載せない)。 */
  metadata?: JsonValue;
}

/**
 * regression fix: Apply 経路で正常に Meta 反映できた create_* / update_* の
 * campaign / adset / ad を `ads_hierarchy` に PAUSED で永続化するための入力。
 *
 * Activate (PAUSED → ACTIVE) は `ads_hierarchy.externalId` を読んで Meta を叩く
 * ため、Apply が externalId と PR の commit sha を保存しないと Activate が
 * `external_id 未確定` で永久に拒否される (acceptance: "Activate is separate
 * from Apply ... before changing PAUSED to ACTIVE"). 本入力でその欠落を埋める。
 *
 * - `accountKey` は AdDroid の ad account key で、実装側が
 *   `ad_accounts.(workspaceId, key)` を参照して `accountId` を解決する。
 * - `parentNodeType` / `parentNodeKey` はノード階層の親 (adset → campaign,
 *   ad → adset) を指し、実装側が同じ accountId 配下から `parentId` を解決する。
 * - `displayName` は create 時のみ必須。update 時は既存行を更新するため、
 *   YAML 名前変更があった場合のみ渡す (= update_* の changes.name.to)。
 * - `externalId` は Meta 側で確定した campaign/adset/ad/creative ID。
 * - `lastCommitSha` は apply の元 PR の headSha (= Apply 操作の commit metadata)。
 * - `spec` は sanitized な apply action snapshot (token を含めない)。
 * - `status` は Apply 経路では常に "paused" (Activate 経路で "active" に上書き)。
 */
export interface UpsertAppliedAdsNodeInput {
  workspaceId: string;
  accountKey: string;
  nodeType: "campaign" | "adset" | "ad";
  nodeKey: string;
  displayName?: string;
  parentNodeType?: "campaign" | "adset";
  parentNodeKey?: string;
  externalId?: string;
  lastCommitSha: string;
  spec?: JsonValue;
  status?: "paused" | "active" | "archived";
}

/**
 * regression fix: AdsLoader が返した account 集合に対する execution mode
 * 解決のための入力。`runExecuteApply` は Meta executor を呼ぶ前にこの値を
 * 引いて per-account に `resolveExecutionMode` を評価し、`report_only` に
 * なる account が 1 件でもあれば fail-closed する。
 *
 * - `workspaceMode` は `workspaces.executionMode`。null は不明値で、
 *   `resolveExecutionMode` が `report_only` にフォールバックする。
 * - `overrideByAccountKey` のキーは AdsLoader の `accountKey` (= YAML 上の
 *   ad account key)。値が無いキーは `null` (= override 未設定) として
 *   扱われ、workspace mode が採用される。
 */
export interface AccountExecutionModes {
  workspaceMode: string | null;
  overrideByAccountKey: Record<string, string | null>;
}

export interface ApplyJobStore {
  /**
   * 当該 apply_job が依存する PR のメタを返す。見つからない / すでに deleted
   * なら null。null のときは pg-boss handler 側で skip する。
   */
  findApplyJobContext(applyJobId: string): Promise<ApplyJobContext | null>;
  /**
   * regression fix: `runExecuteApply` が AdsLoader からの account 集合に
   * 対し execution mode を再評価するための境界。`resolveExecutionMode` を
   * 通して `report_only` に解決される account が 1 つでもあれば、Meta CLI
   * 経路を通さず fail-closed する (acceptance: "report_only never mutates
   * Meta", "auto_apply only executes pre-approved safe operations")。
   */
  loadAccountExecutionModes(input: {
    workspaceId: string;
    accountKeys: readonly string[];
  }): Promise<AccountExecutionModes>;
  /**
   * 実行直前に PR / ops repo / approval_records の「現在の状態」を取り直す
   * (regression fix)。`runExecuteApply` はこのスナップショットを使って、
   * stale / 手挿入 apply_jobs を Meta mutation 前に fail-closed する。
   * apply_job 自体が見つからない、PR が消えている等の場合は null を返す。
   */
  loadApplyApprovalSnapshot(
    applyJobId: string
  ): Promise<ApplyApprovalSnapshot | null>;
  markApplyRunning(input: MarkApplyRunningInput): Promise<void>;
  markApplyFinished(input: MarkApplyFinishedInput): Promise<void>;
  /** apply 全体・個別 apply action・MetaCli 結果を記録する。 */
  recordApplyExecutionLog(input: ExecutionLogInput): Promise<void>;
  recordApplyAudit(input: RecordApplyAuditInput): Promise<void>;
  /**
   * regression fix: Meta 反映に成功した create_* / update_* (campaign/adset/ad)
   * を `ads_hierarchy` に PAUSED で upsert する。`runExecuteApply` は
   * `executeAction` が `status="success"` を返した直後にこの境界を呼び、
   * `externalId` と `lastCommitSha` を含めて永続化する。
   *
   * - 既存行があれば update のみ (insert しない) で displayName を保護できる。
   * - 行が無ければ create する。`displayName` 未指定時は `nodeKey` を使う。
   * - 親ノードの解決に失敗した場合 `parentId` は null のまま続行する
   *   (creates の依存順序により通常は親が先に永続化されている想定)。
   *
   * 実装は呼び出し側 (apps/worker の Prisma store) が AdAccount lookup と
   * 親ノード lookup を担う。失敗時は throw され、orchestrator 側で warn
   * execution_log を残しつつ apply 全体は abort せず継続する。
   */
  upsertAppliedAdsNode(
    input: UpsertAppliedAdsNodeInput
  ): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------
// QueueGithubAdapter — github-adapter を直接 import せずに型結合するための
//   structural な adapter インタフェース。
//   @addroid/github-adapter の `GithubAdapter` はこの interface を満たす。
// ---------------------------------------------------------------------
export interface QueuePullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  baseRef: string;
  htmlUrl: string;
  mergedAt: string | null;
  mergeSha?: string | null;
  mergedBy?: string | null;
}

export interface QueuePollResult {
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  pullRequests: QueuePullRequestSummary[];
}

export interface QueueGithubAdapter {
  pollPullRequests(
    spec: { owner: string; name: string; defaultBranch: string },
    prev: { etag?: string }
  ): Promise<QueuePollResult>;
}
