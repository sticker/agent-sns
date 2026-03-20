// ============================================================
// CLI: status — システムダッシュボード
// ============================================================
// bun run status
// システム状態・キュー・メトリクスのサマリーを表示
// ============================================================

import {
  loadState,
  loadQueue,
  loadPosts,
  loadMetrics,
  loadSchedule,
} from "../core/store";
import type { AgentRole } from "../types";

// --- ANSI helpers ---

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

// --- Agent role labels ---

const AGENT_LABELS: Record<AgentRole, string> = {
  researcher: "リサーチャー",
  analyst: "アナリスト",
  writer: "ライター",
  poster: "ポスター",
  fetcher: "フェッチャー",
  supervisor: "スーパーバイザー",
};

// --- Time formatting ---

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

// --- Main ---

function main(): void {
  const state = loadState();
  const queue = loadQueue();
  const posts = loadPosts();
  const metrics = loadMetrics();
  const schedule = loadSchedule();

  const today = new Date().toISOString().split("T")[0];

  // Determine system health
  let healthStatus: string;
  let healthIcon: string;
  if (state.killSwitch) {
    healthStatus = red("KILLED");
    healthIcon = "🛑";
  } else {
    const totalErrors = Object.values(state.errorCounts).reduce(
      (a, b) => a + b,
      0
    );
    if (totalErrors >= 10) {
      healthStatus = red("CRITICAL");
      healthIcon = "🔴";
    } else if (totalErrors >= 3) {
      healthStatus = yellow("WARNING");
      healthIcon = "🟡";
    } else {
      healthStatus = green("HEALTHY");
      healthIcon = "🟢";
    }
  }

  // Queue stats
  const drafts = queue.filter((p) => p.status === "draft");
  const queued = queue.filter((p) => p.status === "queued");
  const postedToday = posts.filter(
    (p) => p.status === "posted" && p.postedAt?.startsWith(today)
  );

  // Header
  console.log();
  console.log(
    bold("  ╔══════════════════════════════════════════════════╗")
  );
  console.log(
    bold("  ║     Threads AI Agent System — Dashboard         ║")
  );
  console.log(
    bold("  ╚══════════════════════════════════════════════════╝")
  );
  console.log();

  // System status
  console.log(bold("  ── システム状態 ──"));
  console.log(`  ${healthIcon} ステータス:  ${healthStatus}`);
  console.log(
    `  🔘 キルスイッチ: ${state.killSwitch ? red("ON（停止中）") : green("OFF（正常）")}`
  );
  console.log(
    `  📊 本日の投稿:   ${bold(String(state.todayDate === today ? state.dailyPostCount : 0))} / ${schedule.maxPostsPerDay}`
  );
  console.log();

  // Queue stats
  console.log(bold("  ── キュー状態 ──"));
  console.log(`  📝 ドラフト（レビュー待ち）: ${yellow(String(drafts.length))}件`);
  console.log(`  ✅ 承認済み（投稿待ち）:     ${green(String(queued.length))}件`);
  console.log(`  📮 本日投稿済み:             ${cyan(String(postedToday.length))}件`);
  console.log();

  // Agent last run
  console.log(bold("  ── エージェント稼働状況 ──"));
  const roles: AgentRole[] = [
    "researcher",
    "analyst",
    "writer",
    "poster",
    "fetcher",
    "supervisor",
  ];
  for (const role of roles) {
    const label = AGENT_LABELS[role].padEnd(14);
    const lastRun = state.lastRun[role];
    const errorCount = state.errorCounts[role] || 0;

    const lastRunStr = lastRun
      ? dim(timeAgo(lastRun))
      : dim("未実行");
    const errorStr =
      errorCount > 0
        ? red(` [エラー: ${errorCount}]`)
        : "";

    console.log(`  ${label} 最終実行: ${lastRunStr}${errorStr}`);
  }
  console.log();

  // Recent post performance
  if (metrics.length > 0) {
    console.log(bold("  ── 最近の投稿パフォーマンス ──"));

    // Get last 5 metrics, join with post data
    const recentMetrics = metrics.slice(-5).reverse();
    for (const m of recentMetrics) {
      const post = posts.find((p) => p.id === m.postId);
      const pattern = post ? dim(`[${post.pattern}]`) : "";
      const preview = post
        ? post.content.slice(0, 30).replace(/\n/g, " ") + (post.content.length > 30 ? "..." : "")
        : m.postId;

      const engColor =
        m.engagementRate >= 5
          ? green
          : m.engagementRate >= 2
            ? yellow
            : red;

      console.log(
        `  ${dim(preview)} ${pattern}`
      );
      console.log(
        `    👁 ${m.views}  ❤️ ${m.likes}  💬 ${m.replies}  🔄 ${m.reposts}  📈 ${engColor(m.engagementRate.toFixed(1) + "%")}`
      );
    }
    console.log();
  }

  // Warnings
  const warnings: string[] = [];
  if (state.killSwitch) {
    warnings.push("キルスイッチが有効です。全エージェントが停止しています。");
  }
  if (drafts.length >= 10) {
    warnings.push(
      `未レビューのドラフトが${drafts.length}件あります。bun run review を実行してください。`
    );
  }
  if (queued.length === 0 && postedToday.length === 0) {
    warnings.push("投稿待ちのコンテンツがありません。");
  }
  const totalErrors = Object.values(state.errorCounts).reduce(
    (a, b) => a + b,
    0
  );
  if (totalErrors >= 5) {
    warnings.push(`エラーが合計${totalErrors}件発生しています。ログを確認してください。`);
  }
  for (const role of roles) {
    const lastRun = state.lastRun[role];
    if (lastRun) {
      const hoursSince =
        (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
      if (hoursSince > 48) {
        warnings.push(
          `${AGENT_LABELS[role]}が48時間以上実行されていません。`
        );
      }
    }
  }

  if (warnings.length > 0) {
    console.log(bold(yellow("  ── ⚠ 警告 ──")));
    for (const w of warnings) {
      console.log(`  ${yellow("⚠")} ${w}`);
    }
    console.log();
  }

  // Schedule info
  if (schedule.slots.length > 0) {
    console.log(bold("  ── 投稿スケジュール ──"));
    console.log(
      `  タイムゾーン: ${dim(schedule.timezone)} │ 最小間隔: ${dim(String(schedule.minIntervalMinutes) + "分")}`
    );
    const slotStr = schedule.slots
      .map(
        (s) =>
          `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}(${s.label})`
      )
      .join("  ");
    console.log(`  ${dim(slotStr)}`);
    console.log();
  }
}

main();
