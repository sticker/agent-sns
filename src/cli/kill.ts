// ============================================================
// CLI: kill — キルスイッチ
// ============================================================
// bun run kill
// 全エージェントを緊急停止する
// ============================================================

import { loadState, saveState, log } from "../core/store";

function main(): void {
  const state = loadState();

  if (state.killSwitch) {
    console.log();
    console.log("\x1b[33m  ⚠ キルスイッチは既に有効です。\x1b[0m");
    console.log();
    process.exit(0);
  }

  state.killSwitch = true;
  state.isRunning = false;
  saveState(state);

  log("キルスイッチが有効化されました");

  console.log();
  console.log("\x1b[31m  🛑 キルスイッチを有効化しました\x1b[0m");
  console.log();
  console.log("  全エージェントの実行が停止されます。");
  console.log(
    "  復旧するには: bun run agent:supervise -- --reset"
  );
  console.log();
}

main();
