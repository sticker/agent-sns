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
  log,
} from "../core/store";
import type { AgentRole } from "../types";
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
