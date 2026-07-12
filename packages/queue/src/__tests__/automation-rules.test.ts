import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAutomationRule,
  interpretAutomationRequestTiming,
  validateAutomationRule,
  type AutomationMetricSubject,
  type AutomationRuleDsl,
} from "../index.js";

const SUBJECTS: AutomationMetricSubject[] = [
  {
    accountId: "acc-1",
    level: "campaign",
    targetKey: "cmp_1",
    hierarchyId: "h-cmp-1",
    status: "ACTIVE",
    budgetOwnerLevel: "campaign",
    budgetOwnerKey: "cmp_1",
    budgetOwnerHierarchyId: "h-cmp-1",
    currentDailyBudget: 10000,
    metrics: { spend: 6000, cv: 0 },
  },
  {
    accountId: "acc-1",
    level: "campaign",
    targetKey: "cmp_2",
    hierarchyId: "h-cmp-2",
    status: "ACTIVE",
    budgetOwnerLevel: "campaign",
    budgetOwnerKey: "cmp_2",
    budgetOwnerHierarchyId: "h-cmp-2",
    currentDailyBudget: 10000,
    metrics: { spend: 2500, cv: 1 },
  },
];

test("evaluateAutomationRule plans campaign pause from spend and zero CV conditions", () => {
  const rule: AutomationRuleDsl = {
    id: "pause_zero_cv_campaigns",
    scope: { level: "campaign" },
    window: { preset: "today", timezone: "account" },
    when: {
      all: [
        { metric: "spend", gte: 5000 },
        { metric: "cv", eq: 0 },
      ],
    },
    action: { type: "set_status", status: "PAUSED", targetLevel: "campaign" },
    safety: { mode: "proposal" },
  };
  const result = evaluateAutomationRule(rule, SUBJECTS);
  assert.equal(result.matched, 1);
  assert.equal(result.plannedActions[0]!.actionType, "set_status");
  assert.equal(result.plannedActions[0]!.level, "campaign");
  assert.equal(result.plannedActions[0]!.targetKey, "cmp_1");
  assert.deepEqual(result.plannedActions[0]!.payload, { status: "PAUSED" });
  assert.equal(result.plannedActions[0]!.safetyMode, "proposal");
});

test("evaluateAutomationRule plans budget increase with computed CPA and safeguards", () => {
  const rule: AutomationRuleDsl = {
    id: "raise_budget_low_cpa_campaigns",
    scope: { level: "campaign" },
    window: { preset: "last_7d", timezone: "account" },
    computed: { cpa: "spend / cv" },
    when: {
      all: [
        { metric: "cv", gte: 3 },
        { metric: "cpa", lte: 3000 },
      ],
    },
    action: {
      type: "adjust_budget",
      operation: "increase_percent",
      percent: 20,
      targetBudgetLevel: "auto",
    },
    safety: {
      mode: "proposal",
      minConversions: 3,
      maxIncreasePercentPerDay: 20,
      maxDailyBudget: 15000,
    },
  };
  const result = evaluateAutomationRule(rule, [
    {
      accountId: "acc-1",
      level: "campaign",
      targetKey: "cmp_1",
      hierarchyId: "h-cmp-1",
      status: "ACTIVE",
      budgetOwnerLevel: "campaign",
      budgetOwnerKey: "cmp_1",
      budgetOwnerHierarchyId: "h-cmp-1",
      currentDailyBudget: 10000,
      metrics: { spend: 9000, cv: 4 },
    },
  ]);
  assert.equal(result.matched, 1);
  assert.equal(result.plannedActions[0]!.actionType, "adjust_budget");
  assert.equal(result.plannedActions[0]!.payload.proposedDailyBudget, 12000);
  assert.equal(result.plannedActions[0]!.observedMetrics.cpa, 2250);
});

test("validateAutomationRule rejects ambiguous budget percent actions", () => {
  assert.throws(
    () =>
      validateAutomationRule({
        id: "bad",
        scope: { level: "campaign" },
        window: { preset: "today" },
        when: { all: [{ metric: "spend", gt: 0 }] },
        action: { type: "adjust_budget", operation: "increase_percent" },
      }),
    /positive percent/
  );
});

test("interpretAutomationRequestTiming asks when mutating timing is ambiguous", () => {
  const rule: AutomationRuleDsl = {
    id: "raise_budget_low_cpa_campaigns",
    scope: { level: "campaign" },
    window: { preset: "last_7d", timezone: "account" },
    computed: { cpa: "spend / cv" },
    when: { all: [{ metric: "cpa", lte: 3000 }] },
    action: {
      type: "adjust_budget",
      operation: "increase_percent",
      percent: 20,
      targetBudgetLevel: "auto",
    },
    safety: { mode: "proposal", minConversions: 3 },
  };
  const intent = interpretAutomationRequestTiming({
    sourceText: "過去7日でCPA3000円以下のキャンペーン予算を20%アップして",
    draftDsl: rule,
  });
  assert.equal(intent.kind, "clarification_required");
  if (intent.kind !== "clarification_required") throw new Error("expected clarification");
  assert.equal(intent.reason, "execution_timing_ambiguous");
  assert.deepEqual(
    intent.options.map((o) => o.id),
    ["run_once", "save_rule", "run_and_save"]
  );
});

test("interpretAutomationRequestTiming returns immediate when one-time wording is explicit", () => {
  const rule: AutomationRuleDsl = {
    id: "pause_now",
    scope: { level: "campaign" },
    window: { preset: "today" },
    when: { all: [{ metric: "spend", gte: 5000 }] },
    action: { type: "set_status", status: "PAUSED" },
    schedule: "0 * * * *",
  };
  const intent = interpretAutomationRequestTiming({
    sourceText: "今すぐ一度だけ、本日消化5000円以上のキャンペーンを停止して",
    draftDsl: rule,
  });
  assert.equal(intent.kind, "immediate");
  if (intent.kind !== "immediate") throw new Error("expected immediate");
  assert.equal(intent.dsl.schedule, undefined);
});

test("interpretAutomationRequestTiming infers recurring hourly schedule from text", () => {
  const rule: AutomationRuleDsl = {
    id: "pause_hourly",
    scope: { level: "campaign" },
    window: { preset: "today" },
    when: { all: [{ metric: "cv", eq: 0 }] },
    action: { type: "set_status", status: "PAUSED" },
  };
  const intent = interpretAutomationRequestTiming({
    sourceText: "1時間おきに、本日0CVのキャンペーンを自動で停止して",
    draftDsl: rule,
  });
  assert.equal(intent.kind, "recurring");
  if (intent.kind !== "recurring") throw new Error("expected recurring");
  assert.equal(intent.schedule, "0 * * * *");
});

test("interpretAutomationRequestTiming asks when text says both now and recurring", () => {
  const rule: AutomationRuleDsl = {
    id: "pause_now_and_later",
    scope: { level: "campaign" },
    window: { preset: "today" },
    when: { all: [{ metric: "cv", eq: 0 }] },
    action: { type: "set_status", status: "PAUSED" },
  };
  const intent = interpretAutomationRequestTiming({
    sourceText: "今すぐ実行して、今後も毎日同じ条件で停止して",
    draftDsl: rule,
  });
  assert.equal(intent.kind, "clarification_required");
  if (intent.kind !== "clarification_required") throw new Error("expected clarification");
  assert.equal(intent.reason, "execution_timing_conflicting");
});

test("interpretAutomationRequestTiming asks for frequency when recurring wording lacks schedule", () => {
  const rule: AutomationRuleDsl = {
    id: "monitor_low_cpa",
    scope: { level: "campaign" },
    window: { preset: "last_7d" },
    computed: { cpa: "spend / cv" },
    when: { all: [{ metric: "cpa", lte: 3000 }] },
    action: {
      type: "adjust_budget",
      operation: "increase_percent",
      percent: 20,
    },
  };
  const intent = interpretAutomationRequestTiming({
    sourceText: "今後、CPA3000円以下のキャンペーンを継続監視して予算を上げて",
    draftDsl: rule,
  });
  assert.equal(intent.kind, "clarification_required");
  if (intent.kind !== "clarification_required") throw new Error("expected clarification");
  assert.equal(intent.reason, "recurring_schedule_missing");
  assert.deepEqual(
    intent.options.map((o) => o.id),
    ["schedule_hourly", "schedule_daily", "custom_schedule"]
  );
});

// ---- CV プレイブック由来ルールの評価 (computed reach/ctr + any 条件) --------

test("evaluateAutomationRule: 1000リーチ CV0 ルールが computed reach で発火する", () => {
  const rule: AutomationRuleDsl = {
    id: "pause-cv0-after-1000reach",
    scope: { level: "ad" },
    window: { preset: "last_7d" },
    metrics: {},
    computed: { reach: "impressions / frequency" },
    when: {
      all: [{ metric: "conversions", eq: 0 }],
      any: [
        { metric: "reach", gte: 1000 },
        { metric: "impressions", gte: 1500 },
      ],
    },
    action: { type: "set_status", status: "PAUSED" },
    safety: { mode: "proposal" },
  };
  const subjects: AutomationMetricSubject[] = [
    {
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-hit",
      status: "ACTIVE",
      metrics: { conversions: 0, impressions: 1300, frequency: 1.2, spend: 900 },
    },
    {
      // reach 未達 (1000 未満) かつ impressions 未達 → skip
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-early",
      status: "ACTIVE",
      metrics: { conversions: 0, impressions: 600, frequency: 1.1, spend: 300 },
    },
    {
      // CV が付いている → skip
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-converting",
      status: "ACTIVE",
      metrics: { conversions: 3, impressions: 4000, frequency: 1.5, spend: 4000 },
    },
    {
      // frequency 無し → reach null だが impressions フォールバックで発火
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-no-frequency",
      status: "ACTIVE",
      metrics: { conversions: 0, impressions: 2000, frequency: null, spend: 1500 },
    },
  ];
  const out = evaluateAutomationRule(rule, subjects);
  assert.deepEqual(
    out.plannedActions.map((a) => a.targetKey).sort(),
    ["ad-hit", "ad-no-frequency"]
  );
});

test("evaluateAutomationRule: 低CTRルール (リーチ超え & CTR<1%) が computed ctr で発火する", () => {
  const rule: AutomationRuleDsl = {
    id: "pause-low-ctr-ads",
    scope: { level: "ad" },
    window: { preset: "last_7d" },
    metrics: {},
    computed: { ctr: "clicks / impressions", reach: "impressions / frequency" },
    when: {
      all: [{ metric: "ctr", lt: 0.01 }],
      any: [
        { metric: "reach", gte: 1000 },
        { metric: "impressions", gte: 1500 },
      ],
    },
    action: { type: "set_status", status: "PAUSED" },
    safety: { mode: "proposal" },
  };
  const subjects: AutomationMetricSubject[] = [
    {
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-low-ctr",
      status: "ACTIVE",
      metrics: { clicks: 5, impressions: 2000, frequency: 1.3, conversions: 0 },
    },
    {
      // CTR 1.5% → skip
      accountId: "acc-1",
      level: "ad",
      targetKey: "ad-good-ctr",
      status: "ACTIVE",
      metrics: { clicks: 30, impressions: 2000, frequency: 1.3, conversions: 1 },
    },
  ];
  const out = evaluateAutomationRule(rule, subjects);
  assert.deepEqual(out.plannedActions.map((a) => a.targetKey), ["ad-low-ctr"]);
});
