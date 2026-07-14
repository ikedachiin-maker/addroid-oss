// 古物商×激安不動産_認知キャンペーン 日次レポート → 池田ブレインLINE 通知。
//
// AdDroid の暗号化 Meta トークンを復号し、対象キャンペーン配下の広告(ad)単位
// insights を Graph API から取得。認知プレイブック(workflows/awareness-playbook.yaml)
// の基準(完全視聴率2%・CTR参考1%・想起 vs ThruPlay 並行比較・高頻度OK)に照らして
// 課題と解決策を自動生成し、ikeda-os の notify.sh 経由で LINE(池田本人)へ push する。
//
// 実行: node_modules/.bin/tsx apps/worker/src/reports/furugomi-awareness-report.mts [--dry-run] [--date YYYY-MM-DD]
//   --dry-run … LINE送信せず標準出力にメッセージ表示
//   --date    … 集計対象日(JST)。省略時は「昨日(JST)」
// launchd: com.ikeda-os.furugomi-awareness-line (毎朝9:10 JST)。

import { execFileSync } from "node:child_process";
import { prisma } from "@addroid/db";
import { loadEnvFilesFromRepoRoot } from "@addroid/config";
import { META_GRAPH_API_VERSION } from "@addroid/meta-adapter";
import { buildPrismaMetaAdapterSelection } from "../lib/meta-runtime.js";

const REPO_ROOT = "/Users/apple/Desktop/addroid-oss";
const NOTIFY_SH = "/Users/apple/Desktop/ikeda-os/runtime/runner/notify.sh";
const WEB_URL = "https://addroid.ad-marketing.net";

const ACCOUNT = "act_315366547698354";
const CAMPAIGN_ID = "120248975357870649";
const CAMPAIGN_NAME = "古物商×激安不動産_認知";
const SEGMENTS: Record<string, string> = {
  "120248975471800649": "想起リフト(AD_RECALL_LIFT)",
  "120248975472990649": "ThruPlay(視聴)",
};
// 認知プレイブック基準
const COMPLETION_RATE_MIN = 0.02; // 動画100%完全視聴率の合格ライン
const CTR_REF = 0.01; // 無形商材のCTR参考ライン
const VIEWER_SEED_TARGET = 1000; // 類似オーディエンス化に必要な視聴者数

loadEnvFilesFromRepoRoot(REPO_ROOT);

const DRY_RUN = process.argv.includes("--dry-run");
const dateArg = (() => {
  const i = process.argv.indexOf("--date");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

// JST の「昨日」(または指定日) を YYYY-MM-DD で返す
function jstDate(offsetDays: number): string {
  const now = new Date();
  const jstMs = now.getTime() + 9 * 3600000 + offsetDays * 86400000;
  return new Date(jstMs).toISOString().slice(0, 10);
}
const METRIC_DATE = dateArg ?? jstDate(-1);

const yen = (v: number) => `${Math.round(v || 0).toLocaleString("ja-JP")}円`;
const num = (v: number) => Math.round(v || 0).toLocaleString("ja-JP");
const pct = (v: number) => `${(Math.round((v || 0) * 10000) / 100).toFixed(2)}%`;

function actionValue(arr: unknown, types?: string[]): number {
  if (!Array.isArray(arr)) return 0;
  let sum = 0;
  for (const a of arr) {
    if (a && typeof a === "object") {
      const t = (a as Record<string, unknown>).action_type;
      if (types && !types.includes(String(t))) continue;
      sum += Number((a as Record<string, unknown>).value) || 0;
    }
  }
  return sum;
}

type AdRow = {
  adId: string;
  adName: string;
  adsetId: string;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  ctr: number;
  cpm: number;
  videoPlays: number;
  p100: number;
  thruplay: number;
  completionRate: number; // p100 / impressions
};

async function fetchAdRows(accessToken: string): Promise<AdRow[]> {
  const fields = [
    "ad_id", "ad_name", "adset_id", "adset_name",
    "spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpm",
    "video_play_actions", "video_p100_watched_actions", "video_thruplay_watched_actions",
  ].join(",");
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${ACCOUNT}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set("fields", fields);
  url.searchParams.set("time_range", JSON.stringify({ since: METRIC_DATE, until: METRIC_DATE }));
  url.searchParams.set("filtering", JSON.stringify([{ field: "campaign.id", operator: "IN", value: [CAMPAIGN_ID] }]));
  url.searchParams.set("limit", "200");
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message ?? `Graph insights failed (${res.status})`);
  }
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((r) => {
    const impressions = Number(r.impressions) || 0;
    const p100 = actionValue(r.video_p100_watched_actions);
    return {
      adId: String(r.ad_id ?? ""),
      adName: String(r.ad_name ?? ""),
      adsetId: String(r.adset_id ?? ""),
      spend: Number(r.spend) || 0,
      impressions,
      reach: Number(r.reach) || 0,
      frequency: Number(r.frequency) || 0,
      clicks: Number(r.clicks) || 0,
      ctr: (Number(r.ctr) || 0) / 100, // Graph は % 値
      cpm: Number(r.cpm) || 0,
      videoPlays: actionValue(r.video_play_actions),
      p100,
      thruplay: actionValue(r.video_thruplay_watched_actions),
      completionRate: impressions > 0 ? p100 / impressions : 0,
    };
  });
}

function shortName(name: string): string {
  // 例: 認知_古物商動画_v03_10万円→利回り151%_RECALL → v03 10万円→利回り151%
  const m = name.match(/_(v\d{2})_(.+?)_(RECALL|THRUPLAY)$/);
  return m ? `${m[1]} ${m[2]}` : name;
}

function buildMessage(rows: AdRow[]): string {
  const H = `📊 ${CAMPAIGN_NAME} 日報 (${METRIC_DATE})`;
  const parts: string[] = [H];

  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalImpr = rows.reduce((s, r) => s + r.impressions, 0);

  if (rows.length === 0 || totalImpr === 0) {
    parts.push("");
    parts.push(`配信データなし・消化 ${yen(totalSpend)}`);
    parts.push("");
    parts.push("【課題】まだ配信実績がありません（配信開始直後・審査中・全PAUSEDのいずれか）。");
    parts.push("【解決策】広告マネージャで審査ステータスと配信ON/予算を確認。翌日の日報で完全視聴率を評価します。");
    parts.push("");
    parts.push(`詳細: ${WEB_URL}`);
    return parts.join("\n");
  }

  // セグメント(想起 / ThruPlay)別サマリ
  const bySeg = new Map<string, AdRow[]>();
  for (const r of rows) {
    const arr = bySeg.get(r.adsetId) ?? [];
    arr.push(r);
    bySeg.set(r.adsetId, arr);
  }
  const segStats = [...bySeg.entries()].map(([adsetId, list]) => {
    const spend = list.reduce((s, r) => s + r.spend, 0);
    const impr = list.reduce((s, r) => s + r.impressions, 0);
    const p100 = list.reduce((s, r) => s + r.p100, 0);
    const clicks = list.reduce((s, r) => s + r.clicks, 0);
    const reach = list.reduce((s, r) => s + r.reach, 0);
    return {
      adsetId,
      label: SEGMENTS[adsetId] ?? adsetId,
      spend, impr, p100, clicks, reach,
      completionRate: impr > 0 ? p100 / impr : 0,
      ctr: impr > 0 ? clicks / impr : 0,
      cvView: spend > 0 && p100 > 0 ? spend / p100 : 0, // 完全視聴単価
    };
  });

  parts.push("");
  parts.push(`消化 ${yen(totalSpend)} / 表示 ${num(totalImpr)}回`);
  for (const s of segStats) {
    parts.push(
      `▼${s.label}: 消化${yen(s.spend)}・表示${num(s.impr)}・完全視聴率${pct(s.completionRate)}` +
      (s.cvView > 0 ? `・完全視聴単価${yen(s.cvView)}` : "")
    );
  }

  // 動画別 完全視聴率ランキング(全体)
  const ranked = [...rows].filter((r) => r.impressions > 0).sort((a, b) => b.completionRate - a.completionRate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  // 課題 / 解決策の自動生成
  const issues: string[] = [];
  const fixes: string[] = [];

  // 1. 完全視聴率が基準未満
  const belowMin = ranked.filter((r) => r.completionRate < COMPLETION_RATE_MIN);
  if (belowMin.length > 0) {
    issues.push(
      `完全視聴率が基準${pct(COMPLETION_RATE_MIN)}未満の動画が${belowMin.length}本` +
      `（最低: ${shortName(worst.adName)} ${pct(worst.completionRate)}）。`
    );
    fixes.push(
      `冒頭3秒(フック)の差し替えで視聴維持は大きく改善します。` +
      `最下位「${shortName(worst.adName)}」から冒頭違いを作り再テスト、` +
      (best ? `勝ち筋「${shortName(best.adName)}(${pct(best.completionRate)})」へ予算を寄せる提案を用意します。` : "")
    );
  } else if (best) {
    issues.push(`全動画が基準${pct(COMPLETION_RATE_MIN)}を達成（最高 ${shortName(best.adName)} ${pct(best.completionRate)}）。`);
    fixes.push(`勝ち筋が明確な動画へ日予算を寄せ、下位は冒頭差し替えの新バリエーションでテスト継続。`);
  }

  // 2. 想起 vs ThruPlay の比較
  if (segStats.length >= 2) {
    const sorted = [...segStats].sort((a, b) => b.completionRate - a.completionRate);
    const win = sorted[0], lose = sorted[1];
    if (win.completionRate > 0 || lose.completionRate > 0) {
      issues.push(`最適化目標の比較: ${win.label} ${pct(win.completionRate)} > ${lose.label} ${pct(lose.completionRate)}。`);
      fixes.push(`完全視聴率が高い${win.label}側に配分を厚くし、視聴者オーディエンスの積み上げを優先。`);
    }
  }

  // 3. CTR 参考ライン
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const overallCtr = totalImpr > 0 ? totalClicks / totalImpr : 0;
  if (overallCtr < CTR_REF) {
    issues.push(`CTR ${pct(overallCtr)} は参考値${pct(CTR_REF)}未満（※認知はCTRより完全視聴率を優先）。`);
    fixes.push(`CTRは認知段階では補助指標。サムネ/冒頭の訴求見直しで底上げしつつ、判断は完全視聴率主軸で。`);
  }

  // 4. 視聴者オーディエンスの積み上げ
  const cumThruplay = rows.reduce((s, r) => s + r.thruplay, 0);
  if (cumThruplay < VIEWER_SEED_TARGET) {
    issues.push(`視聴者(ThruPlay)累計 ${num(cumThruplay)} / 目標${num(VIEWER_SEED_TARGET)}件（類似オーディエンス化の分母）。`);
    fixes.push(`視聴者${num(VIEWER_SEED_TARGET)}件に到達したら類似1%/3%/5%を作成→CV広告へ接続（ROAS実績あり）。`);
  } else {
    issues.push(`視聴者(ThruPlay)累計 ${num(cumThruplay)}件が目標${num(VIEWER_SEED_TARGET)}件に到達。`);
    fixes.push(`類似オーディエンス1%/3%/5%を作成し、コンバージョン広告の投入を提案します。`);
  }

  // 補足: 認知は高頻度OK(フリークエンシー警告は出さない)
  parts.push("");
  parts.push("【課題】");
  issues.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
  parts.push("");
  parts.push("【解決策】");
  fixes.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
  parts.push("");
  parts.push("※認知広告はフリークエンシーが2を超えても問題なし（高頻度OK）。判断軸は完全視聴率2%。");
  parts.push(`詳細: ${WEB_URL}`);
  return parts.join("\n");
}

async function main() {
  let message: string;
  try {
    const selection = await buildPrismaMetaAdapterSelection({ prisma });
    const lease = await selection.adapter.loadAccessTokenPlaintext();
    if (!lease) throw new Error("Meta token 未接続");
    const rows = await fetchAdRows(lease.accessToken);
    message = buildMessage(rows);
  } catch (e) {
    message =
      `📊 ${CAMPAIGN_NAME} 日報 (${METRIC_DATE})\n` +
      `取得に失敗しました: ${String((e as Error).message).slice(0, 200)}\n` +
      `MacのDB(postgres)とAdDroid workerの状態を確認してください。`;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  if (DRY_RUN) {
    console.log(message);
  } else {
    execFileSync("bash", [NOTIFY_SH, message], { timeout: 30000 });
    console.log(new Date().toISOString(), "LINE通知を送信しました");
  }
}

main();
