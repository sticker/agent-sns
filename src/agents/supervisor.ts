// ============================================================
// Supervisor Agent — システム監視（LLM不要）
// ============================================================
// ヘルスチェック、キルスイッチ管理、エラー監視を行う。
// --kill  : キルスイッチ有効化
// --reset : エラーカウント＋キルスイッチをリセット
// ============================================================

import {
  loadState,
  saveState,
  loadQueue,
  loadPosts,
  loadMetrics,
  log,
} from "../core/store";
import { loadMemory, saveMemory, type AgentMemory, type Learning } from "../core/memory";
import type { AgentRole, SystemState, Post, PostMetrics } from "../types";
import { MAX_DAILY_POSTS } from "../types";

type HealthStatus = "healthy" | "warning" | "critical" | "killed";

const ERROR_THRESHOLD = 3;  // 連続エラー閾値
const STALE_HOURS = 24;     // エージェント停滞判定（時間）

const ALL_AGENTS: AgentRole[] = [
  "researcher",
  "analyst",
  "writer",
  "poster",
  "fetcher",
  "supervisor",
];

function parseArgs(): { kill: boolean; reset: boolean } {
  const args = process.argv.slice(2);
  return {
    kill: args.includes("--kill"),
    reset: args.includes("--reset"),
  };
}

// ============================================================
// システム全体のパターン検出（ルールベース自己改善）
// ============================================================

function detectSystemPatterns(state: SystemState, queue: Post[], posts: Post[], metrics: PostMetrics[]): Learning[] {
  const newLearnings: Learning[] = [];
  const now = new Date().toISOString();

  // パターン1: 品質スコアの分布偏り検出
  const recentDrafts = posts.filter(p => p.status === "draft" || p.status === "queued").slice(-20);
  if (recentDrafts.length >= 5) {
    const avgScore = recentDrafts.reduce((sum, p) => sum + (p.qualityScore?.average ?? 0), 0) / recentDrafts.length;
    if (avgScore > 8.5) {
      newLearnings.push({
        id: `sys_${Date.now()}_score_high`,
        category: "system",
        insight: `品質スコアが高すぎる (平均${avgScore.toFixed(1)})。ライターの採点が甘い可能性あり`,
        confidence: 0.8,
        evidence: `直近${recentDrafts.length}件の平均: ${avgScore.toFixed(1)}`,
        createdAt: now,
        appliedCount: 0,
        effectiveScore: 0,
      });
    }
  }

  // パターン2: 特定パターンの棄却率
  const rejected = posts.filter(p => p.status === "rejected").slice(-30);
  if (rejected.length >= 3) {
    const patternCounts: Record<string, number> = {};
    for (const p of rejected) {
      patternCounts[p.pattern] = (patternCounts[p.pattern] || 0) + 1;
    }
    for (const [pattern, count] of Object.entries(patternCounts)) {
      if (count >= 3) {
        newLearnings.push({
          id: `sys_${Date.now()}_pattern_${pattern}`,
          category: "pattern",
          insight: `パターン「${pattern}」の棄却率が高い (${count}/${rejected.length}件)。ライターに改善を促す`,
          confidence: 0.7,
          evidence: `直近の棄却${rejected.length}件中${count}件が${pattern}`,
          createdAt: now,
          appliedCount: 0,
          effectiveScore: 0,
        });
      }
    }
  }

  // パターン3: 投稿間隔の偏り（短時間に集中していないか）
  const postedRecent = posts.filter(p => p.status === "posted" && p.postedAt).slice(-10);
  if (postedRecent.length >= 3) {
    const timestamps = postedRecent.map(p => new Date(p.postedAt!).getTime()).sort((a, b) => a - b);
    let clusterCount = 0;
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] - timestamps[i - 1] < 30 * 60 * 1000) { // 30分以内
        clusterCount++;
      }
    }
    if (clusterCount >= 2) {
      newLearnings.push({
        id: `sys_${Date.now()}_cluster`,
        category: "schedule",
        insight: `投稿が短時間に集中している (30分以内の連続投稿${clusterCount}回)。投稿間隔の分散が必要`,
        confidence: 0.7,
        evidence: `直近${postedRecent.length}件の投稿タイムスタンプ分析`,
        createdAt: now,
        appliedCount: 0,
        effectiveScore: 0,
      });
    }
  }

  // パターン4: テーマの偏り
  const queuedThemes = queue.filter(p => p.status === "queued" || p.status === "draft").map(p => p.theme);
  if (queuedThemes.length >= 5) {
    const themeCounts: Record<string, number> = {};
    for (const t of queuedThemes) themeCounts[t] = (themeCounts[t] || 0) + 1;
    const maxTheme = Object.entries(themeCounts).sort((a, b) => b[1] - a[1])[0];
    if (maxTheme && maxTheme[1] / queuedThemes.length > 0.5) {
      newLearnings.push({
        id: `sys_${Date.now()}_theme_bias`,
        category: "theme",
        insight: `キュー内でテーマ「${maxTheme[0]}」が偏りすぎ (${maxTheme[1]}/${queuedThemes.length}件)`,
        confidence: 0.9,
        evidence: `キュー分布: ${JSON.stringify(themeCounts)}`,
        createdAt: now,
        appliedCount: 0,
        effectiveScore: 0,
      });
    }
  }

  // パターン5: エンゲージメント低下トレンド
  if (metrics.length >= 10) {
    const recent = metrics.slice(-5);
    const older = metrics.slice(-10, -5);
    const recentAvg = recent.reduce((s, m) => s + m.engagementRate, 0) / recent.length;
    const olderAvg = older.reduce((s, m) => s + m.engagementRate, 0) / older.length;
    if (olderAvg > 0 && recentAvg < olderAvg * 0.7) {
      newLearnings.push({
        id: `sys_${Date.now()}_engagement_drop`,
        category: "performance",
        insight: `エンゲージメント率が低下傾向 (${(olderAvg * 100).toFixed(2)}% → ${(recentAvg * 100).toFixed(2)}%)`,
        confidence: 0.8,
        evidence: `直近5件 vs その前5件の比較`,
        createdAt: now,
        appliedCount: 0,
        effectiveScore: 0,
      });
    }
  }

  return newLearnings;
}

async function main() {
  const { kill, reset } = parseArgs();
  const state = loadState();

  // --kill: キルスイッチ有効化
  if (kill) {
    state.killSwitch = true;
    state.isRunning = false;
    saveState(state);
    log("supervisor: キルスイッチを有効化しました");
    console.log("KILLED — 全エージェントが停止します");
    return;
  }

  // --reset: エラーカウント＋キルスイッチをリセット
  if (reset) {
    state.killSwitch = false;
    state.isRunning = false;
    for (const role of ALL_AGENTS) {
      state.errorCounts[role] = 0;
    }
    saveState(state);
    log("supervisor: エラーカウント＋キルスイッチをリセットしました");
    console.log("RESET — システム正常化");
    return;
  }

  // --- 通常監視モード ---
  log("supervisor 開始");

  let status: HealthStatus = "healthy";
  const warnings: string[] = [];
  const criticals: string[] = [];

  // 1. キルスイッチ確認
  if (state.killSwitch) {
    status = "killed";
    criticals.push("キルスイッチが有効です");
  }

  // 2. エージェント連続エラーチェック
  for (const role of ALL_AGENTS) {
    const count = state.errorCounts[role] ?? 0;
    if (count >= ERROR_THRESHOLD) {
      criticals.push(`${role}: 連続エラー ${count}回（閾値: ${ERROR_THRESHOLD}）`);
      if (status !== "killed") status = "critical";
    }
  }

  // 3. 日次投稿数チェック
  if (state.dailyPostCount >= MAX_DAILY_POSTS) {
    warnings.push(`日次投稿上限到達: ${state.dailyPostCount}/${MAX_DAILY_POSTS}`);
    if (status === "healthy") status = "warning";
  }

  // 4. キュー健全性チェック（queued 投稿があるか）
  const queue = loadQueue();
  const queuedCount = queue.filter((p) => p.status === "queued").length;
  if (queuedCount === 0) {
    warnings.push("キューに queued 投稿がありません");
    if (status === "healthy") status = "warning";
  }

  // 5. エージェント停滞チェック（24時間以上未実行）
  const now = Date.now();
  const staleMs = STALE_HOURS * 60 * 60 * 1000;

  for (const role of ALL_AGENTS) {
    const lastRun = state.lastRun[role];
    if (!lastRun) continue;  // 未実行はスキップ
    const elapsed = now - new Date(lastRun).getTime();
    if (elapsed > staleMs) {
      const hours = Math.round(elapsed / (60 * 60 * 1000));
      warnings.push(`${role}: ${hours}時間未実行`);
      if (status === "healthy") status = "warning";
    }
  }

  // --- ルールベース自己改善: システムパターン検出 ---
  const posts = loadPosts();
  const metrics = loadMetrics();
  const memory = loadMemory("supervisor");

  const detected = detectSystemPatterns(state, queue, posts, metrics);

  // 重複排除: 既存の学びと category+insight が類似するものは追加しない
  const newLearnings = detected.filter((d) => {
    return !memory.learnings.some(
      (existing) => existing.category === d.category && existing.insight === d.insight
    );
  });

  if (newLearnings.length > 0) {
    memory.learnings.push(...newLearnings);
    // 最大30件に制限（古い・低スコアのものから除去）
    if (memory.learnings.length > 30) {
      memory.learnings.sort((a, b) => {
        const scoreA = a.confidence * Math.max(a.effectiveScore, 0.1);
        const scoreB = b.confidence * Math.max(b.effectiveScore, 0.1);
        return scoreB - scoreA;
      });
      memory.learnings = memory.learnings.slice(0, 30);
    }
    for (const l of newLearnings) {
      log(`supervisor 新しい学び: [${l.category}] ${l.insight}`);
    }
  }

  // メモリ統計更新・保存
  memory.stats.totalRuns += 1;
  memory.stats.successfulRuns += (status === "healthy" || status === "warning") ? 1 : 0;
  memory.stats.lastRunAt = new Date().toISOString();
  memory.lastReflection = new Date().toISOString();
  saveMemory("supervisor", memory);

  // --- レポート出力 ---
  console.log(`\n=== Supervisor Report ===`);
  console.log(`ステータス: ${status.toUpperCase()}`);
  console.log(`日次投稿数: ${state.dailyPostCount}/${MAX_DAILY_POSTS}`);
  console.log(`キュー (queued): ${queuedCount}件`);
  console.log(`日付: ${state.todayDate}`);

  if (criticals.length > 0) {
    console.log(`\n[CRITICAL]`);
    for (const c of criticals) console.log(`  - ${c}`);
  }
  if (warnings.length > 0) {
    console.log(`\n[WARNING]`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (criticals.length === 0 && warnings.length === 0) {
    console.log(`\n全システム正常稼働中`);
  }

  // 学びレポート
  if (newLearnings.length > 0) {
    console.log(`\n[新しい学び] ${newLearnings.length}件検出`);
    for (const l of newLearnings) console.log(`  - [${l.category}] ${l.insight}`);
  }
  console.log(`メモリ: 学び${memory.learnings.length}件蓄積 / 実行${memory.stats.totalRuns}回`);

  // 最終実行時刻一覧
  console.log(`\n最終実行:`);
  for (const role of ALL_AGENTS) {
    const lr = state.lastRun[role];
    console.log(`  ${role}: ${lr ?? "未実行"}`);
  }

  // ステート更新
  state.lastRun.supervisor = new Date().toISOString();
  saveState(state);
  log(`supervisor 完了 — ステータス: ${status}`);
}

main().catch((e) => {
  log(`supervisor エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
