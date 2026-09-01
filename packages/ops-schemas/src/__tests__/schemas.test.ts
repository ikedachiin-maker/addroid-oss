import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AutomationRulesYamlSchema,
  AwarenessPlaybookYamlSchema,
  ConversionPlaybookYamlSchema,
  BudgetRebalancePolicyYamlSchema,
  BudgetGuardPolicyYamlSchema,
  CronYamlSchema,
  ProjectYamlSchema,
  SubmissionGuardsYamlSchema,
  awarenessPlaybookToKnowledgeBriefs,
  conversionPlaybookToKnowledgeBriefs,
  loadAutomationRules,
  loadAwarenessPlaybook,
  loadConversionPlaybook,
  loadBudgetRebalancePolicy,
  loadBudgetGuardPolicy,
  loadSubmissionGuardsPolicy,
} from "../index.js";

test("ProjectYamlSchema accepts project metadata", () => {
  const out = ProjectYamlSchema.safeParse({
    version: 1,
    workspace: { slug: "default-workspace", displayName: "Default" },
  });
  assert.equal(out.success, true);
});

test("CronYamlSchema validates cron fields and duplicates", () => {
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [{ name: "budget_rebalance", cron: "0 10 * * 2", enabled: false }],
    }).success,
    true
  );
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [{ name: "daily_report", cron: "60 9 * * *", enabled: true }],
    }).success,
    false
  );
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [
        { name: "daily_report", cron: "0 9 * * *", enabled: true },
        { name: "daily_report", cron: "0 10 * * *", enabled: false },
      ],
    }).success,
    false
  );
});

test("BudgetGuardPolicyYamlSchema accepts optional policy fields", () => {
  const out = BudgetGuardPolicyYamlSchema.safeParse({
    version: 1,
    alerts: { dailyBudgetAlertRatio: 0.8 },
    autoPause: { enabled: false, safeCategories: [] },
    accounts: { primary: { dailyBudget: 500, monthlyBudget: 15000, currency: "JPY" } },
  });
  assert.equal(out.success, true);
});

test("BudgetRebalancePolicyYamlSchema defaults optional controls and caps ranges", () => {
  const out = BudgetRebalancePolicyYamlSchema.safeParse({
    version: 1,
    enabled: true,
  });
  assert.equal(out.success, true);
  if (!out.success) throw new Error("expected success");
  assert.equal(out.data.lookbackDays, 14);
  assert.equal(out.data.keepTotalBudget, true);
  assert.equal(
    BudgetRebalancePolicyYamlSchema.safeParse({
      version: 1,
      enabled: true,
      lookbackDays: 90,
    }).success,
    false
  );
});

test("SubmissionGuardsYamlSchema accepts budget increase guard and rejects inverted ratios", () => {
  assert.equal(
    SubmissionGuardsYamlSchema.safeParse({
      version: 1,
      guards: { budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 } },
    }).success,
    true
  );
  assert.equal(
    SubmissionGuardsYamlSchema.safeParse({
      version: 1,
      guards: { budgetIncrease: { warnOverRatio: 5, blockOverRatio: 2 } },
    }).success,
    false
  );
});

test("AutomationRulesYamlSchema accepts a rule document", () => {
  const out = AutomationRulesYamlSchema.safeParse({
    version: 1,
    rules: [
      {
        id: "pause_waste",
        enabled: true,
        scope: { level: "ad" },
        when: { all: [{ metric: "spend", gte: 1000 }] },
        action: { type: "pause", status: "PAUSED" },
      },
    ],
  });
  assert.equal(out.success, true);
});

test("loadBudgetGuardPolicy and loadAutomationRules read ops policy files leniently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-schemas-"));
  try {
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workflows/budget-guard.yaml"),
      "version: 1\nalerts:\n  dailyBudgetAlertRatio: 0.8\naccounts: {}\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/automation-rules.yaml"),
      "version: 1\nrules: []\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/budget-rebalance.yaml"),
      "version: 1\nenabled: true\nlookbackDays: 14\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/guards.yaml"),
      "version: 1\nguards:\n  budgetIncrease:\n    warnOverRatio: 2\n    blockOverRatio: 5\n",
      "utf8"
    );
    assert.equal(loadBudgetGuardPolicy(dir)?.version, 1);
    assert.equal(loadBudgetRebalancePolicy(dir)?.enabled, true);
    assert.equal(loadAutomationRules(dir)?.rules.length, 0);
    assert.equal(loadSubmissionGuardsPolicy(dir)?.guards.budgetIncrease.blockOverRatio, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SubmissionGuardsYamlSchema fills awarenessOptimizationGoal defaults for legacy guards.yaml", () => {
  const out = SubmissionGuardsYamlSchema.safeParse({
    version: 1,
    guards: { budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 } },
  });
  assert.equal(out.success, true);
  if (out.success) {
    const guard = out.data.guards.awarenessOptimizationGoal;
    assert.equal(guard.mode, "warn");
    assert.deepEqual(guard.allowedGoals, ["AD_RECALL_LIFT", "THRUPLAY"]);
    assert.deepEqual(guard.forbiddenGoals, ["REACH", "IMPRESSIONS"]);
    assert.deepEqual(guard.exemptFiles, []);
  }
});

test("AwarenessPlaybookYamlSchema fills defaults from minimal yaml", () => {
  const out = AwarenessPlaybookYamlSchema.safeParse({ version: 1 });
  assert.equal(out.success, true);
  if (out.success) {
    assert.equal(out.data.kpi.videoCompletionRateMin, 0.02);
    assert.deepEqual(out.data.optimizationGoals.allowed, ["AD_RECALL_LIFT", "THRUPLAY"]);
    assert.equal(out.data.testing.dailyBudgetPerCreative, 1000);
    assert.equal(out.data.audience.videoViewersSeedTarget, 1000);
    assert.deepEqual(out.data.audience.lookalikePercents, [1, 3, 5]);
    assert.deepEqual(out.data.briefs, []);
  }
});

test("loadAwarenessPlaybook reads workflows/awareness-playbook.yaml and null when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-schemas-"));
  try {
    assert.equal(loadAwarenessPlaybook(dir), null);
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workflows", "awareness-playbook.yaml"),
      [
        "version: 1",
        "kpi:",
        "  videoCompletionRateMin: 0.03",
        "briefs:",
        '  - "認知広告は開始2週間以上前から出稿する"',
        "",
      ].join("\n"),
      "utf8"
    );
    const playbook = loadAwarenessPlaybook(dir);
    assert.ok(playbook);
    assert.equal(playbook!.kpi.videoCompletionRateMin, 0.03);
    assert.equal(playbook!.briefs.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("awarenessPlaybookToKnowledgeBriefs builds summary + free-form briefs", () => {
  assert.deepEqual(awarenessPlaybookToKnowledgeBriefs(null), []);
  const parsed = AwarenessPlaybookYamlSchema.parse({
    version: 1,
    briefs: ["フックを3パターン作って完全視聴率で比較する"],
  });
  const briefs = awarenessPlaybookToKnowledgeBriefs(parsed);
  assert.equal(briefs.length, 2);
  assert.match(briefs[0]!, /AD_RECALL_LIFT \/ THRUPLAY/);
  assert.match(briefs[0]!, /2\.0% 以上/);
  assert.match(briefs[0]!, /REACH \/ IMPRESSIONS/);
  assert.equal(briefs[1], "フックを3パターン作って完全視聴率で比較する");
});

test("ConversionPlaybookYamlSchema fills defaults and loader reads yaml", () => {
  const out = ConversionPlaybookYamlSchema.safeParse({ version: 1 });
  assert.equal(out.success, true);
  if (out.success) {
    assert.equal(out.data.kpi.seminarApplicationRateMin, 0.05);
    assert.equal(out.data.kpi.lpRegistrationRateMin, 0.2);
    assert.equal(out.data.kpi.roasMin, 3);
    assert.equal(out.data.judgment.noCvReachCutoff, 1000);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-schemas-cv-"));
  try {
    assert.equal(loadConversionPlaybook(dir), null);
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workflows", "conversion-playbook.yaml"),
      ["version: 1", "judgment:", "  noCvReachCutoff: 2000", ""].join("\n"),
      "utf8"
    );
    const playbook = loadConversionPlaybook(dir);
    assert.ok(playbook);
    assert.equal(playbook!.judgment.noCvReachCutoff, 2000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("conversionPlaybookToKnowledgeBriefs builds priority summary + free-form briefs", () => {
  assert.deepEqual(conversionPlaybookToKnowledgeBriefs(null), []);
  const parsed = ConversionPlaybookYamlSchema.parse({
    version: 1,
    briefs: ["LPと広告の訴求を一致させる"],
  });
  const briefs = conversionPlaybookToKnowledgeBriefs(parsed);
  assert.equal(briefs.length, 2);
  assert.match(briefs[0]!, /バックエンド売上\/CPO\/ROAS > セミナー申し込み率/);
  assert.match(briefs[0]!, /1000リーチで CV 0 件/);
  assert.match(briefs[0]!, /CTR 1% 未満/);
  assert.match(briefs[0]!, /ROAS 300%/);
  assert.equal(briefs[1], "LPと広告の訴求を一致させる");
});

test("AutomationRuleScopeSchema accepts campaignObjective filters", () => {
  const out = AutomationRulesYamlSchema.safeParse({
    version: 1,
    rules: [
      {
        id: "pause-cv0-after-1000reach",
        enabled: true,
        scope: {
          level: "ad",
          campaignObjectiveExcludes: ["OUTCOME_AWARENESS"],
        },
        when: { all: [{ metric: "conversions", eq: 0 }] },
        action: { type: "set_status", status: "PAUSED" },
      },
    ],
  });
  assert.equal(out.success, true);
  if (out.success) {
    assert.deepEqual(
      (out.data.rules[0]!.scope as { campaignObjectiveExcludes?: string[] })
        .campaignObjectiveExcludes,
      ["OUTCOME_AWARENESS"]
    );
  }
});
