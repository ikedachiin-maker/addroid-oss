// AdDroid OSS — automation-rules-runtime のユニットテスト.
//
// filterSubjectsByCampaignObjective (キャンペーン objective による subject の
// 絞り込み) を pure 関数として検証する。CV 判定ルール (1000リーチ CV0 停止提案
// 等) が認知広告 (CV=0 が正常) に誤発火しないための load-bearing なフィルタ。

import test from "node:test";
import assert from "node:assert/strict";

import type { AutomationMetricSubject, AutomationRuleDsl } from "@addroid/queue";
import { filterSubjectsByCampaignObjective } from "../automation-rules-runtime.js";

function subject(targetKey: string): AutomationMetricSubject {
  return {
    accountId: "acc-1",
    accountKey: "act_1",
    level: "ad",
    targetKey,
    metrics: { spend: 1000, conversions: 0, impressions: 5000, clicks: 10 },
  };
}

const BASE_SCOPE: AutomationRuleDsl["scope"] = { level: "ad" };

test("filterSubjectsByCampaignObjective returns subjects unchanged without objective filters", () => {
  const subjects = [subject("ad-1"), subject("ad-2")];
  const out = filterSubjectsByCampaignObjective(subjects, BASE_SCOPE, new Map());
  assert.deepEqual(out, subjects);
});

test("campaignObjectiveExcludes drops matching subjects and keeps unknown-objective subjects", () => {
  const subjects = [subject("ad-aware"), subject("ad-sales"), subject("ad-unknown")];
  const objectives = new Map([
    ["ad-aware", "OUTCOME_AWARENESS"],
    ["ad-sales", "OUTCOME_SALES"],
  ]);
  const out = filterSubjectsByCampaignObjective(
    subjects,
    { ...BASE_SCOPE, campaignObjectiveExcludes: ["OUTCOME_AWARENESS"] },
    objectives
  );
  assert.deepEqual(
    out.map((s) => s.targetKey),
    ["ad-sales", "ad-unknown"]
  );
});

test("campaignObjectiveIncludes keeps only known matching subjects (case-insensitive)", () => {
  const subjects = [subject("ad-aware"), subject("ad-sales"), subject("ad-unknown")];
  const objectives = new Map([
    ["ad-aware", "outcome_awareness"],
    ["ad-sales", "OUTCOME_SALES"],
  ]);
  const out = filterSubjectsByCampaignObjective(
    subjects,
    { ...BASE_SCOPE, campaignObjectiveIncludes: ["OUTCOME_AWARENESS"] },
    objectives
  );
  assert.deepEqual(
    out.map((s) => s.targetKey),
    ["ad-aware"]
  );
});
