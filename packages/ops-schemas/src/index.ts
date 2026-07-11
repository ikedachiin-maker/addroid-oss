import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const ProjectYamlSchema = z
  .object({
    version: z.literal(1),
    workspace: z.object({
      slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ"),
      displayName: z.string().min(1),
    }),
  })
  .strict();

export type ProjectYaml = z.infer<typeof ProjectYamlSchema>;

const CRON_FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

function parseCronInteger(s: string): number | null {
  if (s.length === 0 || !/^\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function validateCronAtom(
  atom: string,
  field: { name: string; min: number; max: number }
): string | null {
  if (atom.length === 0) return `${field.name}: empty atom`;
  let body = atom;
  const slashIdx = atom.indexOf("/");
  if (slashIdx !== -1) {
    body = atom.slice(0, slashIdx);
    const stepStr = atom.slice(slashIdx + 1);
    const step = parseCronInteger(stepStr);
    if (step === null || step <= 0) {
      return `${field.name}: step must be a positive integer (got "${stepStr}")`;
    }
  }
  if (body === "*") return null;
  if (body.length === 0) return `${field.name}: missing value before "/"`;
  const dashIdx = body.indexOf("-");
  if (dashIdx !== -1) {
    const start = parseCronInteger(body.slice(0, dashIdx));
    const end = parseCronInteger(body.slice(dashIdx + 1));
    if (start === null || end === null) return `${field.name}: invalid range "${body}"`;
    if (start < field.min || start > field.max) {
      return `${field.name}: range start ${start} not in [${field.min}, ${field.max}]`;
    }
    if (end < field.min || end > field.max) {
      return `${field.name}: range end ${end} not in [${field.min}, ${field.max}]`;
    }
    if (start > end) return `${field.name}: range start (${start}) is greater than end (${end})`;
    return null;
  }
  const n = parseCronInteger(body);
  if (n === null) return `${field.name}: invalid value "${body}"`;
  if (n < field.min || n > field.max) return `${field.name}: value ${n} not in [${field.min}, ${field.max}]`;
  return null;
}

function validateCronExpression(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `5 フィールドの cron 式である必要があります (got ${fields.length} fields)`;
  for (let i = 0; i < CRON_FIELDS.length; i += 1) {
    const raw = fields[i]!;
    if (raw.length === 0) return `${CRON_FIELDS[i]!.name}: empty field`;
    for (const atom of raw.split(",")) {
      const err = validateCronAtom(atom, CRON_FIELDS[i]!);
      if (err) return err;
    }
  }
  return null;
}

const CronExpressionSchema = z.string().min(1).superRefine((value, ctx) => {
  const err = validateCronExpression(value);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

export const CronEntrySchema = z
  .object({
    name: z.enum([
      "github_poll",
      "daily_report",
      "today_report",
      "budget_guard",
      "improvement_pr",
      "auto_creative_generation",
      "retention_sweep",
    ]),
    cron: CronExpressionSchema,
    enabled: z.boolean().default(false),
  })
  .strict();

export const CronYamlSchema = z
  .object({
    version: z.literal(1),
    schedules: z.array(CronEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.schedules.length; i += 1) {
      const name = value.schedules[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedules", i, "name"],
          message: `duplicate schedule name: ${name}`,
        });
      }
      seen.add(name);
    }
  });

export type CronYaml = z.infer<typeof CronYamlSchema>;

export const BudgetGuardPolicyAlertsSchema = z
  .object({
    dailyBudgetAlertRatio: z.number().nonnegative().optional(),
    monthlyPaceRatio: z.number().nonnegative().optional(),
    dayOverDayRatio: z.number().nonnegative().optional(),
    noConversionsSpendMin: z.number().nonnegative().optional(),
  })
  .strict();

export const BudgetGuardAutoPauseSchema = z
  .object({
    enabled: z.boolean(),
    minDailyBudgetRatio: z.number().nonnegative().optional(),
    minDayOverDayRatio: z.number().nonnegative().optional(),
    safeCategories: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const BudgetGuardAccountBudgetSchema = z
  .object({
    dailyBudget: z.number().nonnegative().default(0),
    monthlyBudget: z.number().nonnegative().default(0),
    currency: z.string().min(1).optional(),
  })
  .strict();

export const BudgetGuardPolicyYamlSchema = z
  .object({
    version: z.literal(1),
    alerts: BudgetGuardPolicyAlertsSchema.default({}),
    autoPause: BudgetGuardAutoPauseSchema.optional(),
    accounts: z.record(BudgetGuardAccountBudgetSchema).default({}),
  })
  .strict();

export type BudgetGuardPolicyYaml = z.infer<typeof BudgetGuardPolicyYamlSchema>;

export const SubmissionGuardBudgetIncreaseSchema = z
  .object({
    warnOverRatio: z.number().positive().default(2),
    blockOverRatio: z.number().positive().default(5),
  })
  .strict()
  .refine((value) => value.warnOverRatio < value.blockOverRatio, {
    message: "warnOverRatio は blockOverRatio より小さくしてください",
    path: ["warnOverRatio"],
  });

export const SubmissionGuardAwarenessOptimizationGoalSchema = z
  .object({
    mode: z.enum(["off", "warn", "block"]).default("warn"),
    /** 認知(OUTCOME_AWARENESS)キャンペーン配下の adset で許可する optimization_goal。 */
    allowedGoals: z.array(z.string().min(1)).default(["AD_RECALL_LIFT", "THRUPLAY"]),
    /** キャンペーン objective に関わらず提出時に指摘する optimization_goal。 */
    forbiddenGoals: z.array(z.string().min(1)).default(["REACH", "IMPRESSIONS"]),
    /**
     * 検査を免除する operation manifest の相対パス。ガード導入以前に apply 済みの
     * 歴史的ファイル (後続 manifest で修正済み) が毎回警告を出し続けるのを防ぐ。
     */
    exemptFiles: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const DEFAULT_AWARENESS_OPTIMIZATION_GOAL_GUARD: z.infer<
  typeof SubmissionGuardAwarenessOptimizationGoalSchema
> = {
  mode: "warn",
  allowedGoals: ["AD_RECALL_LIFT", "THRUPLAY"],
  forbiddenGoals: ["REACH", "IMPRESSIONS"],
  exemptFiles: [],
};

export const SubmissionGuardsYamlSchema = z
  .object({
    version: z.literal(1),
    guards: z
      .object({
        budgetIncrease: SubmissionGuardBudgetIncreaseSchema.default({
          warnOverRatio: 2,
          blockOverRatio: 5,
        }),
        awarenessOptimizationGoal: SubmissionGuardAwarenessOptimizationGoalSchema.default(
          DEFAULT_AWARENESS_OPTIMIZATION_GOAL_GUARD
        ),
      })
      .strict()
      .default({
        budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 },
        awarenessOptimizationGoal: DEFAULT_AWARENESS_OPTIMIZATION_GOAL_GUARD,
      }),
  })
  .strict();

export type SubmissionGuardsYaml = z.infer<typeof SubmissionGuardsYamlSchema>;

export const AutomationMetricWindowSchema = z
  .object({
    preset: z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d"]).optional(),
    since: z.string().min(1).optional(),
    until: z.string().min(1).optional(),
    timezone: z.union([z.literal("account"), z.literal("utc"), z.string().min(1)]).optional(),
    lookbackHours: z.number().int().positive().max(24 * 30).optional(),
  })
  .passthrough();

export const AutomationRuleScopeSchema = z
  .object({
    level: z.enum(["account", "campaign", "adset", "ad"]),
    accounts: z.array(z.string().min(1)).optional(),
    includePaused: z.boolean().optional(),
  })
  .passthrough();

export const AutomationMetricSpecSchema = z
  .object({
    field: z.string().min(1),
    actionTypes: z.array(z.string().min(1)).optional(),
    unit: z.enum(["currency", "count", "ratio"]).optional(),
  })
  .passthrough();

export const AutomationConditionSchema = z
  .object({
    metric: z.string().min(1),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    eq: z.number().optional(),
    ne: z.number().optional(),
  })
  .strict();

export const AutomationConditionGroupSchema = z
  .object({
    all: z.array(AutomationConditionSchema).optional(),
    any: z.array(AutomationConditionSchema).optional(),
  })
  .strict()
  .refine((v) => (v.all?.length ?? 0) > 0 || (v.any?.length ?? 0) > 0, {
    message: "automation rule requires when.all or when.any",
  });

export const AutomationActionSchema = z
  .object({
    type: z.string().min(1),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    targetLevel: z.enum(["account", "campaign", "adset", "ad"]).optional(),
    operation: z.enum(["increase_percent", "decrease_percent", "set_amount"]).optional(),
    percent: z.number().positive().optional(),
    amount: z.number().positive().optional(),
    targetBudgetLevel: z.enum(["campaign", "adset", "auto"]).optional(),
  })
  .passthrough();

export const AutomationSafetySchema = z
  .object({
    mode: z.enum(["report_only", "proposal", "auto_apply"]).optional(),
    minConversions: z.number().nonnegative().optional(),
    minSpend: z.number().nonnegative().optional(),
    maxIncreasePercentPerDay: z.number().positive().optional(),
    maxDailyBudget: z.number().positive().optional(),
    cooldownHours: z.number().nonnegative().optional(),
  })
  .passthrough();

export const AutomationApprovalSchema = z
  .object({
    mode: z
      .enum([
        "report_only",
        "proposal",
        "auto_apply",
        "auto_apply_if_policy_matched",
        "auto_merge_if_policy_matched",
      ])
      .optional(),
  })
  .passthrough();

export const AutomationLimitsSchema = z
  .object({
    maxActionsPerRun: z.number().int().positive().optional(),
    maxCampaignsPerRun: z.number().int().positive().optional(),
    maxDailyBudgetAffected: z.number().nonnegative().optional(),
  })
  .passthrough();

export const AutomationCalibrationSchema = z
  .object({
    mode: z.enum(["static", "adaptive_with_bounds"]).optional(),
    source: z.literal("account_history").optional(),
    generatedAt: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    lookbackDays: z.number().int().positive().optional(),
    minSampleDays: z.number().int().positive().optional(),
    quality: z.enum(["sufficient", "insufficient", "empty"]).optional(),
    baseline: z.unknown().optional(),
    recommended: z.unknown().optional(),
    bounds: z.unknown().optional(),
    drift: z.unknown().optional(),
  })
  .passthrough();

export const AutomationRuleYamlSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "id は英数字・_・- のみ"),
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    scope: AutomationRuleScopeSchema,
    window: AutomationMetricWindowSchema.default({ preset: "today", timezone: "account" }),
    metrics: z.record(AutomationMetricSpecSchema).default({}),
    computed: z.record(z.string().min(1)).optional(),
    when: AutomationConditionGroupSchema,
    action: AutomationActionSchema,
    safety: AutomationSafetySchema.optional(),
    approval: AutomationApprovalSchema.optional(),
    limits: AutomationLimitsSchema.optional(),
    calibration: AutomationCalibrationSchema.optional(),
    sourceText: z.string().min(1).optional(),
  })
  .passthrough();

export const AutomationRulesYamlSchema = z
  .object({
    version: z.literal(1).default(1),
    policies: z.unknown().optional(),
    rules: z.array(AutomationRuleYamlSchema).default([]),
  })
  .passthrough();

export type AutomationRuleYaml = z.infer<typeof AutomationRuleYamlSchema>;
export type AutomationRulesYaml = z.infer<typeof AutomationRulesYamlSchema>;

// ---------------------------------------------------------------------
// Awareness playbook — 認知広告運用プレイブック (workflows/awareness-playbook.yaml)
//
// オペレーターの認知広告メソッド (最適化目標の選び方 / 完全視聴率2%の合格ライン /
// 小予算テスト / 動画視聴者→類似オーディエンス) を数値閾値 + prompt 注入用
// ブリーフとして ops repo で管理する。正本の解説は ops repo の
// knowledge/awareness-ads-playbook.md。
// ---------------------------------------------------------------------

export const AwarenessPlaybookKpiSchema = z
  .object({
    /** 動画100%完全視聴率 (video_p100 ÷ 動画再生数) の合格ライン。既定 2%。 */
    videoCompletionRateMin: z.number().nonnegative().default(0.02),
    /** CTR の参考合格ライン (無形商材)。 */
    ctrReferenceIntangible: z.number().nonnegative().default(0.01),
    /** CTR の参考合格ライン (店舗)。 */
    ctrReferenceStore: z.number().nonnegative().default(0.02),
  })
  .strict();

export const AwarenessPlaybookOptimizationGoalsSchema = z
  .object({
    allowed: z.array(z.string().min(1)).default(["AD_RECALL_LIFT", "THRUPLAY"]),
    forbidden: z.array(z.string().min(1)).default(["REACH", "IMPRESSIONS"]),
  })
  .strict();

export const AwarenessPlaybookTestingSchema = z
  .object({
    /** 1 クリエイティブあたりのテスト日予算 (アカウント通貨)。 */
    dailyBudgetPerCreative: z.number().nonnegative().default(1000),
    /** 冒頭 (フック) テストの目安日数。 */
    minTestDays: z.number().int().positive().default(2),
    /** 1 バッチの変異体数の目安。 */
    batchSize: z.number().int().positive().default(5),
  })
  .strict();

export const AwarenessPlaybookAudienceSchema = z
  .object({
    /** 類似オーディエンス化に必要な動画視聴者リストの分母目標。 */
    videoViewersSeedTarget: z.number().int().positive().default(1000),
    /** 作成する類似オーディエンスの % 段階。 */
    lookalikePercents: z.array(z.number().positive()).default([1, 3, 5]),
  })
  .strict();

export const AwarenessPlaybookYamlSchema = z
  .object({
    version: z.literal(1),
    kpi: AwarenessPlaybookKpiSchema.default({}),
    optimizationGoals: AwarenessPlaybookOptimizationGoalsSchema.default({}),
    testing: AwarenessPlaybookTestingSchema.default({}),
    audience: AwarenessPlaybookAudienceSchema.default({}),
    /**
     * improvement_pr の各 AI agent に knowledgeBriefs としてそのまま注入する
     * 運用ノウハウ (日本語可)。1 要素 = 1 ルール程度の短文にする。
     */
    briefs: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type AwarenessPlaybookYaml = z.infer<typeof AwarenessPlaybookYamlSchema>;

/**
 * プレイブックの数値閾値を、AI agent へ注入する knowledgeBriefs (文字列配列)
 * に変換する。YAML の `briefs` 自由文の先頭に、構造化閾値から機械生成した
 * サマリ 1 行を付ける。プレイブック未配備 (null) なら空配列。
 */
export function awarenessPlaybookToKnowledgeBriefs(
  playbook: AwarenessPlaybookYaml | null
): string[] {
  if (!playbook) return [];
  const goals = playbook.optimizationGoals;
  const kpi = playbook.kpi;
  const testing = playbook.testing;
  const audience = playbook.audience;
  const summary =
    `認知(OUTCOME_AWARENESS)キャンペーンの運用ルール: ` +
    `最適化目標は ${goals.allowed.join(" / ")} のみ使用し、${goals.forbidden.join(" / ")} は使用禁止。` +
    `クリエイティブ合格ラインは動画100%完全視聴率 ${(kpi.videoCompletionRateMin * 100).toFixed(1)}% 以上 ` +
    `(認知段階では CPA/CV を判定に使わない)。` +
    `テストは 1 本あたり日 ${testing.dailyBudgetPerCreative} 予算 × ${testing.minTestDays} 日以上を ${testing.batchSize} 本並行し、勝者へ予算を寄せる。` +
    `動画視聴者リスト ${audience.videoViewersSeedTarget} 件到達で類似オーディエンス ` +
    `${audience.lookalikePercents.map((p) => `${p}%`).join("/")} の作成を提案する。`;
  return [summary, ...playbook.briefs];
}

export interface OpsRepoLayout {
  projectYaml: string;
  cronYaml: string;
  budgetGuardYaml: string;
  submissionGuardsYaml: string;
  automationRulesYaml: string;
  awarenessPlaybookYaml: string;
}

export const DEFAULT_OPS_REPO_LAYOUT: OpsRepoLayout = {
  projectYaml: ".addroid/project.yaml",
  cronYaml: "workflows/cron.yaml",
  budgetGuardYaml: "workflows/budget-guard.yaml",
  submissionGuardsYaml: "workflows/guards.yaml",
  automationRulesYaml: "workflows/automation-rules.yaml",
  awarenessPlaybookYaml: "workflows/awareness-playbook.yaml",
};

export function loadBudgetGuardPolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): BudgetGuardPolicyYaml | null {
  return loadYamlFile(rootDir, layout.budgetGuardYaml, BudgetGuardPolicyYamlSchema);
}

export function loadSubmissionGuardsPolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): SubmissionGuardsYaml | null {
  return loadYamlFile(rootDir, layout.submissionGuardsYaml, SubmissionGuardsYamlSchema);
}

export function loadAutomationRules(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): AutomationRulesYaml | null {
  return loadYamlFile(rootDir, layout.automationRulesYaml, AutomationRulesYamlSchema);
}

export function loadAwarenessPlaybook(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): AwarenessPlaybookYaml | null {
  return loadYamlFile(rootDir, layout.awarenessPlaybookYaml, AwarenessPlaybookYamlSchema);
}

function loadYamlFile<TSchema extends z.ZodTypeAny>(
  rootDir: string,
  relPath: string,
  schema: TSchema
): z.infer<TSchema> | null {
  const abs = path.join(rootDir, relPath);
  if (!fs.existsSync(abs)) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const out = schema.safeParse(parsed);
  return out.success ? out.data : null;
}
