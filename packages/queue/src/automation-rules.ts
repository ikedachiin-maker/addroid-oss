// AdDroid OSS — deterministic automation rule engine.
//
// Natural-language requests are compiled into this DSL first. This module never
// calls an LLM and never mutates Meta directly; it only evaluates normalized
// metric rows and returns auditable action plans.

export type AutomationLevel = "account" | "campaign" | "adset" | "ad";
export type AutomationSafetyMode = "report_only" | "proposal" | "auto_apply";
export type AutomationStatus = "ACTIVE" | "PAUSED";
export type AutomationBudgetOperation =
  | "increase_percent"
  | "decrease_percent"
  | "set_amount";

export interface AutomationMetricWindow {
  preset?: "today" | "yesterday" | "last_7d" | "last_14d" | "last_30d";
  since?: string;
  until?: string;
  timezone?: "account" | "utc" | string;
}

export interface AutomationRuleScope {
  level: AutomationLevel;
  accounts?: string[];
  includePaused?: boolean;
  /**
   * 親キャンペーンの objective による絞り込み (worker 側の subject 構築時に適用)。
   * includes 指定時は objective が判明かつ一致する subject のみ残す。
   * excludes 指定時は objective が判明かつ一致する subject を除外する
   * (objective 不明の subject は残す)。
   * 例: CV 判定ルールに campaignObjectiveExcludes: [OUTCOME_AWARENESS] を付け、
   * 認知広告 (CV=0 が正常) への誤発火を防ぐ。
   */
  campaignObjectiveIncludes?: string[];
  campaignObjectiveExcludes?: string[];
}

export interface AutomationMetricSpec {
  field: string;
  actionTypes?: string[];
  unit?: "currency" | "count" | "ratio";
}

export interface AutomationCondition {
  metric: string;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  eq?: number;
  ne?: number;
}

export interface AutomationConditionGroup {
  all?: AutomationCondition[];
  any?: AutomationCondition[];
}

export interface AutomationSetStatusAction {
  type: "set_status";
  status: AutomationStatus;
  targetLevel?: AutomationLevel;
}

export interface AutomationAdjustBudgetAction {
  type: "adjust_budget";
  operation: AutomationBudgetOperation;
  percent?: number;
  amount?: number;
  targetBudgetLevel?: "campaign" | "adset" | "auto";
}

export type AutomationRuleAction =
  | AutomationSetStatusAction
  | AutomationAdjustBudgetAction;

export interface AutomationSafetyPolicy {
  mode?: AutomationSafetyMode;
  minConversions?: number;
  minSpend?: number;
  maxIncreasePercentPerDay?: number;
  maxDailyBudget?: number;
  cooldownHours?: number;
}

export interface AutomationRuleDsl {
  id: string;
  schedule?: string;
  scope: AutomationRuleScope;
  window: AutomationMetricWindow;
  metrics?: Record<string, AutomationMetricSpec>;
  /**
   * Computed metrics. The first implementation intentionally supports only
   * a narrow arithmetic grammar such as "spend / cv" or "spend * 0.2".
   */
  computed?: Record<string, string>;
  when: AutomationConditionGroup;
  action: AutomationRuleAction;
  safety?: AutomationSafetyPolicy;
}

export interface AutomationMetricSubject {
  accountId: string;
  accountKey?: string;
  level: AutomationLevel;
  targetKey: string;
  hierarchyId?: string | null;
  displayName?: string;
  status?: string | null;
  parentCampaignKey?: string | null;
  parentCampaignHierarchyId?: string | null;
  parentAdsetKey?: string | null;
  parentAdsetHierarchyId?: string | null;
  /**
   * Budget owner for this subject. For CBO campaign rows this is usually the
   * campaign itself; for ad rows this is commonly the parent adset.
   */
  budgetOwnerLevel?: "campaign" | "adset" | null;
  budgetOwnerKey?: string | null;
  budgetOwnerHierarchyId?: string | null;
  currentDailyBudget?: number | null;
  metrics: Record<string, number | null | undefined>;
}

export interface AutomationPlannedAction {
  ruleId: string;
  accountId: string;
  accountKey?: string;
  level: AutomationLevel;
  targetKey: string;
  hierarchyId: string | null;
  actionType: AutomationRuleAction["type"];
  payload: Record<string, unknown>;
  reasons: string[];
  observedMetrics: Record<string, number | null>;
  safetyMode: AutomationSafetyMode;
}

export interface AutomationSkippedSubject {
  accountId: string;
  level: AutomationLevel;
  targetKey: string;
  reason: string;
}

export interface AutomationRuleEvaluation {
  ruleId: string;
  matched: number;
  plannedActions: AutomationPlannedAction[];
  skipped: AutomationSkippedSubject[];
}

export type AutomationRequestIntentKind =
  | "immediate"
  | "recurring"
  | "clarification_required"
  | "unsupported";

export type AutomationClarificationReason =
  | "execution_timing_ambiguous"
  | "execution_timing_conflicting"
  | "recurring_schedule_missing"
  | "unsupported_request";

export interface AutomationClarificationOption {
  id: string;
  label: string;
  description: string;
}

export interface AutomationImmediateIntent {
  kind: "immediate";
  dsl: AutomationRuleDsl;
  requiresApproval: boolean;
  reason: string;
}

export interface AutomationRecurringIntent {
  kind: "recurring";
  dsl: AutomationRuleDsl;
  schedule: string;
  requiresApproval: boolean;
  reason: string;
}

export interface AutomationClarificationIntent {
  kind: "clarification_required";
  reason: AutomationClarificationReason;
  question: string;
  options: AutomationClarificationOption[];
  draftDsl: AutomationRuleDsl;
}

export interface AutomationUnsupportedIntent {
  kind: "unsupported";
  reason: AutomationClarificationReason;
  message: string;
  draftDsl?: AutomationRuleDsl;
}

export type AutomationRequestIntent =
  | AutomationImmediateIntent
  | AutomationRecurringIntent
  | AutomationClarificationIntent
  | AutomationUnsupportedIntent;

export interface InterpretAutomationRequestTimingInput {
  sourceText: string;
  draftDsl: AutomationRuleDsl;
}

/**
 * Classify whether a natural-language automation request should run once now,
 * become a recurring rule, or stop for a user clarification. This is a
 * deterministic safety gate that should run after LLM draft DSL generation and
 * before any insights fetch or Meta mutation.
 */
export function interpretAutomationRequestTiming(
  input: InterpretAutomationRequestTimingInput
): AutomationRequestIntent {
  const text = normalizeRequestText(input.sourceText);
  const draft = input.draftDsl;
  try {
    validateAutomationRule(draft);
  } catch (err) {
    return {
      kind: "unsupported",
      reason: "unsupported_request",
      message: err instanceof Error ? err.message : "automation request is invalid",
      draftDsl: draft,
    };
  }

  const schedule =
    (typeof draft.schedule === "string" ? draft.schedule.trim() : "") ||
    inferScheduleFromText(text);
  const hasImmediateSignal = IMMEDIATE_REQUEST_PATTERNS.some((p) => p.test(text));
  const hasRecurringTextSignal = RECURRING_REQUEST_PATTERNS.some((p) => p.test(text));
  const hasRecurringSignal =
    hasRecurringTextSignal || Boolean(schedule && !hasImmediateSignal);
  const mutates = isMutatingAutomationAction(draft.action);
  const requiresApproval = mutates;

  if (hasImmediateSignal && hasRecurringSignal) {
    return timingClarification(
      draft,
      "execution_timing_conflicting",
      "この依頼には即時実行と定期実行の両方に読める表現があります。どの扱いにしますか？"
    );
  }

  if (hasRecurringSignal) {
    if (!schedule) {
      return {
        kind: "clarification_required",
        reason: "recurring_schedule_missing",
        question:
          "この依頼は定期ルールとして扱えますが、実行頻度が指定されていません。どの頻度にしますか？",
        options: [
          {
            id: "schedule_hourly",
            label: "1時間おき",
            description: "毎時0分に条件を評価するルールとして保存します。",
          },
          {
            id: "schedule_daily",
            label: "毎日",
            description: "毎日朝に条件を評価するルールとして保存します。",
          },
          {
            id: "custom_schedule",
            label: "別の頻度",
            description: "ユーザーに任意の頻度または cron 式を指定してもらいます。",
          },
        ],
        draftDsl: draft,
      };
    }
    return {
      kind: "recurring",
      dsl: draft,
      schedule,
      requiresApproval,
      reason: "recurring schedule was explicit",
    };
  }

  if (hasImmediateSignal) {
    return {
      kind: "immediate",
      dsl: { ...draft, schedule: undefined },
      requiresApproval,
      reason: "one-time execution was explicit",
    };
  }

  if (mutates) {
    return timingClarification(
      draft,
      "execution_timing_ambiguous",
      "この依頼は「今すぐ一度だけ実行」なのか「今後も定期的に実行するルール」なのか判断できません。どちらにしますか？"
    );
  }

  return {
    kind: "immediate",
    dsl: { ...draft, schedule: undefined },
    requiresApproval,
    reason: "non-mutating automation can run as an ad-hoc evaluation",
  };
}

export function evaluateAutomationRule(
  rule: AutomationRuleDsl,
  subjects: readonly AutomationMetricSubject[]
): AutomationRuleEvaluation {
  validateAutomationRule(rule);
  const plannedActions: AutomationPlannedAction[] = [];
  const skipped: AutomationSkippedSubject[] = [];
  const safetyMode = normalizeSafetyMode(rule.safety?.mode);

  for (const subject of subjects) {
    if (subject.level !== rule.scope.level) continue;
    if (!rule.scope.includePaused && normalizeStatus(subject.status) === "PAUSED") {
      skipped.push(skip(subject, "subject is already paused"));
      continue;
    }
    const metrics = materializeMetrics(subject.metrics, rule.computed);
    const condition = evaluateConditionGroup(rule.when, metrics);
    if (!condition.ok) {
      skipped.push(skip(subject, condition.reason));
      continue;
    }
    const safety = evaluateSafety(rule, subject, metrics);
    if (!safety.ok) {
      skipped.push(skip(subject, safety.reason));
      continue;
    }
    const action = buildPlannedAction(rule, subject, metrics, [
      ...condition.reasons,
      ...safety.reasons,
    ]);
    if (!action) {
      skipped.push(skip(subject, "action could not be resolved for subject"));
      continue;
    }
    plannedActions.push({ ...action, safetyMode });
  }

  return {
    ruleId: rule.id,
    matched: plannedActions.length,
    plannedActions,
    skipped,
  };
}

function timingClarification(
  draftDsl: AutomationRuleDsl,
  reason: AutomationClarificationReason,
  question: string
): AutomationClarificationIntent {
  return {
    kind: "clarification_required",
    reason,
    question,
    options: [
      {
        id: "run_once",
        label: "今すぐ一度だけ",
        description: "現在のデータで対象を抽出し、今回だけ実行案を作ります。",
      },
      {
        id: "save_rule",
        label: "定期ルールにする",
        description: "条件と頻度を保存し、今後も自動で評価します。",
      },
      {
        id: "run_and_save",
        label: "両方",
        description: "今すぐ一度評価し、同じ条件を定期ルールとしても保存します。",
      },
    ],
    draftDsl,
  };
}

export function validateAutomationRule(rule: AutomationRuleDsl): void {
  if (!rule.id || typeof rule.id !== "string") {
    throw new Error("automation rule id is required");
  }
  if (!rule.scope || !isAutomationLevel(rule.scope.level)) {
    throw new Error("automation rule scope.level must be account/campaign/adset/ad");
  }
  if (!rule.when || (!rule.when.all?.length && !rule.when.any?.length)) {
    throw new Error("automation rule requires when.all or when.any");
  }
  if (!rule.action || typeof rule.action.type !== "string") {
    throw new Error("automation rule action is required");
  }
  if (rule.action.type === "set_status") {
    if (rule.action.status !== "ACTIVE" && rule.action.status !== "PAUSED") {
      throw new Error("set_status action requires status ACTIVE or PAUSED");
    }
    if (rule.action.targetLevel && !isAutomationLevel(rule.action.targetLevel)) {
      throw new Error("set_status targetLevel is invalid");
    }
  } else if (rule.action.type === "adjust_budget") {
    if (
      rule.action.operation === "increase_percent" ||
      rule.action.operation === "decrease_percent"
    ) {
      if (!finitePositive(rule.action.percent)) {
        throw new Error("percent budget action requires a positive percent");
      }
    } else if (rule.action.operation === "set_amount") {
      if (!finitePositive(rule.action.amount)) {
        throw new Error("set_amount budget action requires a positive amount");
      }
    } else {
      throw new Error("adjust_budget operation is invalid");
    }
  } else {
    throw new Error(`unsupported automation action: ${(rule.action as { type: string }).type}`);
  }
}

function buildPlannedAction(
  rule: AutomationRuleDsl,
  subject: AutomationMetricSubject,
  metrics: Record<string, number | null>,
  reasons: string[]
): Omit<AutomationPlannedAction, "safetyMode"> | null {
  if (rule.action.type === "set_status") {
    const targetLevel = rule.action.targetLevel ?? subject.level;
    const resolved = resolveStatusTarget(subject, targetLevel);
    if (!resolved) return null;
    return {
      ruleId: rule.id,
      accountId: subject.accountId,
      ...(subject.accountKey ? { accountKey: subject.accountKey } : {}),
      level: resolved.level,
      targetKey: resolved.targetKey,
      hierarchyId: resolved.hierarchyId,
      actionType: "set_status",
      payload: { status: rule.action.status },
      reasons,
      observedMetrics: metrics,
    };
  }

  const resolved = resolveBudgetTarget(subject, rule.action.targetBudgetLevel ?? "auto");
  if (!resolved) return null;
  const payload: Record<string, unknown> = {
    operation: rule.action.operation,
    targetBudgetLevel: resolved.level,
  };
  if (rule.action.percent !== undefined) payload.percent = rule.action.percent;
  if (rule.action.amount !== undefined) payload.amount = rule.action.amount;
  if (subject.currentDailyBudget !== undefined && subject.currentDailyBudget !== null) {
    payload.currentDailyBudget = subject.currentDailyBudget;
    const next = nextBudget(rule.action, subject.currentDailyBudget);
    if (next !== null) payload.proposedDailyBudget = next;
  }
  return {
    ruleId: rule.id,
    accountId: subject.accountId,
    ...(subject.accountKey ? { accountKey: subject.accountKey } : {}),
    level: resolved.level,
    targetKey: resolved.targetKey,
    hierarchyId: resolved.hierarchyId,
    actionType: "adjust_budget",
    payload,
    reasons,
    observedMetrics: metrics,
  };
}

function resolveStatusTarget(
  subject: AutomationMetricSubject,
  level: AutomationLevel
): { level: AutomationLevel; targetKey: string; hierarchyId: string | null } | null {
  if (level === subject.level) {
    return {
      level,
      targetKey: subject.targetKey,
      hierarchyId: subject.hierarchyId ?? null,
    };
  }
  if (level === "campaign" && subject.parentCampaignKey) {
    return {
      level,
      targetKey: subject.parentCampaignKey,
      hierarchyId: subject.parentCampaignHierarchyId ?? null,
    };
  }
  if (level === "adset" && subject.parentAdsetKey) {
    return {
      level,
      targetKey: subject.parentAdsetKey,
      hierarchyId: subject.parentAdsetHierarchyId ?? null,
    };
  }
  return null;
}

function resolveBudgetTarget(
  subject: AutomationMetricSubject,
  target: "campaign" | "adset" | "auto"
): { level: "campaign" | "adset"; targetKey: string; hierarchyId: string | null } | null {
  if (target === "auto" && subject.budgetOwnerLevel && subject.budgetOwnerKey) {
    return {
      level: subject.budgetOwnerLevel,
      targetKey: subject.budgetOwnerKey,
      hierarchyId: subject.budgetOwnerHierarchyId ?? null,
    };
  }
  const wanted = target === "auto" ? subject.level : target;
  if (wanted === "campaign") {
    if (subject.level === "campaign") {
      return {
        level: "campaign",
        targetKey: subject.targetKey,
        hierarchyId: subject.hierarchyId ?? null,
      };
    }
    if (subject.parentCampaignKey) {
      return {
        level: "campaign",
        targetKey: subject.parentCampaignKey,
        hierarchyId: subject.parentCampaignHierarchyId ?? null,
      };
    }
  }
  if (wanted === "adset") {
    if (subject.level === "adset") {
      return {
        level: "adset",
        targetKey: subject.targetKey,
        hierarchyId: subject.hierarchyId ?? null,
      };
    }
    if (subject.parentAdsetKey) {
      return {
        level: "adset",
        targetKey: subject.parentAdsetKey,
        hierarchyId: subject.parentAdsetHierarchyId ?? null,
      };
    }
  }
  return null;
}

function evaluateConditionGroup(
  group: AutomationConditionGroup,
  metrics: Record<string, number | null>
): { ok: boolean; reason: string; reasons: string[] } {
  const all = group.all ?? [];
  const any = group.any ?? [];
  const reasons: string[] = [];
  for (const cond of all) {
    const result = evaluateCondition(cond, metrics);
    if (!result.ok) return { ok: false, reason: result.reason, reasons };
    reasons.push(result.reason);
  }
  if (any.length > 0) {
    const anyResults = any.map((cond) => evaluateCondition(cond, metrics));
    const passed = anyResults.filter((r) => r.ok);
    if (passed.length === 0) {
      return {
        ok: false,
        reason: anyResults[0]?.reason ?? "no any condition matched",
        reasons,
      };
    }
    reasons.push(...passed.map((r) => r.reason));
  }
  return { ok: true, reason: "matched", reasons };
}

function evaluateCondition(
  cond: AutomationCondition,
  metrics: Record<string, number | null>
): { ok: boolean; reason: string } {
  const value = metrics[cond.metric];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: `${cond.metric} is unavailable` };
  }
  const checks: Array<[string, number | undefined, boolean]> = [
    [">", cond.gt, cond.gt === undefined || value > cond.gt],
    [">=", cond.gte, cond.gte === undefined || value >= cond.gte],
    ["<", cond.lt, cond.lt === undefined || value < cond.lt],
    ["<=", cond.lte, cond.lte === undefined || value <= cond.lte],
    ["==", cond.eq, cond.eq === undefined || value === cond.eq],
    ["!=", cond.ne, cond.ne === undefined || value !== cond.ne],
  ];
  for (const [op, threshold, ok] of checks) {
    if (threshold !== undefined && !ok) {
      return { ok: false, reason: `${cond.metric} ${value} failed ${op} ${threshold}` };
    }
  }
  const expected = checks
    .filter(([, threshold]) => threshold !== undefined)
    .map(([op, threshold]) => `${op} ${threshold}`)
    .join(" and ");
  return { ok: true, reason: `${cond.metric} ${value} matched ${expected}` };
}

function evaluateSafety(
  rule: AutomationRuleDsl,
  subject: AutomationMetricSubject,
  metrics: Record<string, number | null>
): { ok: boolean; reason: string; reasons: string[] } {
  const safety = rule.safety;
  if (!safety) return { ok: true, reason: "no safety policy", reasons: [] };
  const reasons: string[] = [];
  if (safety.minConversions !== undefined) {
    const cv = metrics.cv ?? metrics.conversions ?? null;
    if (typeof cv !== "number" || cv < safety.minConversions) {
      return {
        ok: false,
        reason: `conversions below safety minimum ${safety.minConversions}`,
        reasons,
      };
    }
    reasons.push(`conversions ${cv} >= safety minimum ${safety.minConversions}`);
  }
  if (safety.minSpend !== undefined) {
    const spend = metrics.spend ?? null;
    if (typeof spend !== "number" || spend < safety.minSpend) {
      return {
        ok: false,
        reason: `spend below safety minimum ${safety.minSpend}`,
        reasons,
      };
    }
    reasons.push(`spend ${spend} >= safety minimum ${safety.minSpend}`);
  }
  if (
    rule.action.type === "adjust_budget" &&
    rule.action.operation === "increase_percent" &&
    safety.maxIncreasePercentPerDay !== undefined &&
    rule.action.percent !== undefined &&
    rule.action.percent > safety.maxIncreasePercentPerDay
  ) {
    return {
      ok: false,
      reason: `increase percent exceeds safety maximum ${safety.maxIncreasePercentPerDay}`,
      reasons,
    };
  }
  if (
    rule.action.type === "adjust_budget" &&
    safety.maxDailyBudget !== undefined &&
    subject.currentDailyBudget !== undefined &&
    subject.currentDailyBudget !== null
  ) {
    const next = nextBudget(rule.action, subject.currentDailyBudget);
    if (next !== null && next > safety.maxDailyBudget) {
      return {
        ok: false,
        reason: `proposed daily budget exceeds safety maximum ${safety.maxDailyBudget}`,
        reasons,
      };
    }
  }
  return { ok: true, reason: "safety passed", reasons };
}

function materializeMetrics(
  base: Record<string, number | null | undefined>,
  computed?: Record<string, string>
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(base)) {
    out[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  for (const [key, expression] of Object.entries(computed ?? {})) {
    out[key] = evaluateExpression(expression, out);
  }
  return out;
}

function evaluateExpression(
  expression: string,
  metrics: Record<string, number | null>
): number | null {
  const match = expression
    .trim()
    .match(/^([A-Za-z0-9_.-]+)\s*([/*+-])\s*([A-Za-z0-9_.-]+|-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const left = metricOperand(match[1]!, metrics);
  const right = metricOperand(match[3]!, metrics);
  if (left === null || right === null) return null;
  switch (match[2]) {
    case "/":
      return right === 0 ? null : left / right;
    case "*":
      return left * right;
    case "+":
      return left + right;
    case "-":
      return left - right;
    default:
      return null;
  }
}

function metricOperand(token: string, metrics: Record<string, number | null>): number | null {
  const literal = Number(token);
  if (Number.isFinite(literal)) return literal;
  const value = metrics[token];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nextBudget(action: AutomationAdjustBudgetAction, current: number): number | null {
  if (action.operation === "set_amount") return action.amount ?? null;
  if (action.percent === undefined) return null;
  if (action.operation === "increase_percent") return roundCurrency(current * (1 + action.percent / 100));
  if (action.operation === "decrease_percent") return roundCurrency(current * (1 - action.percent / 100));
  return null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMutatingAutomationAction(action: AutomationRuleAction): boolean {
  return action.type === "set_status" || action.type === "adjust_budget";
}

function normalizeRequestText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function inferScheduleFromText(text: string): string {
  const hourly = text.match(/(\d+)時間(?:ごと|おき|毎)/);
  if (hourly) {
    const hours = Number(hourly[1]);
    if (Number.isInteger(hours) && hours > 0 && hours <= 23) {
      return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
    }
  }
  const minutely = text.match(/(\d+)分(?:ごと|おき|毎)/);
  if (minutely) {
    const minutes = Number(minutely[1]);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 59) {
      return `*/${minutes} * * * *`;
    }
  }
  if (/毎日|日次|daily/.test(text)) return "0 9 * * *";
  if (/毎週|週次|weekly/.test(text)) return "0 9 * * 1";
  if (/毎月|月次|monthly/.test(text)) return "0 9 1 * *";
  return "";
}

const IMMEDIATE_REQUEST_PATTERNS: readonly RegExp[] = [
  /今すぐ/,
  /即時/,
  /今回だけ/,
  /一度だけ/,
  /1回だけ/,
  /単発/,
  /今の状態/,
  /現在のデータ/,
  /対象を(?:抽出|出して|洗い出)/,
  /run now/,
  /immediately/,
  /one[- ]?time/,
  /once/,
  /ad hoc/,
];

const RECURRING_REQUEST_PATTERNS: readonly RegExp[] = [
  /定期/,
  /継続/,
  /今後/,
  /監視/,
  /自動で(?:毎|継続|監視|判定)/,
  /条件に(?:合った|該当した)ら/,
  /(?:時間|分)(?:ごと|おき|毎)/,
  /毎日/,
  /毎週/,
  /毎月/,
  /日次/,
  /週次/,
  /月次/,
  /cron/,
  /schedule/,
  /recurring/,
  /periodic/,
  /monitor/,
];

function normalizeSafetyMode(value: string | undefined): AutomationSafetyMode {
  return value === "report_only" || value === "auto_apply" || value === "proposal"
    ? value
    : "proposal";
}

function normalizeStatus(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

function finitePositive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isAutomationLevel(value: string): value is AutomationLevel {
  return value === "account" || value === "campaign" || value === "adset" || value === "ad";
}

function skip(subject: AutomationMetricSubject, reason: string): AutomationSkippedSubject {
  return {
    accountId: subject.accountId,
    level: subject.level,
    targetKey: subject.targetKey,
    reason,
  };
}
