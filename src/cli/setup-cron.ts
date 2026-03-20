// ============================================================
// CLI: setup-cron — crontabエントリ生成
// ============================================================
// bun run setup-cron
// config/system.json のスケジュール設定からcrontabエントリを出力
// ============================================================

import { PROJECT_ROOT, loadSchedule } from "../core/store";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function main(): void {
  const schedule = loadSchedule();
  const root = PROJECT_ROOT;
  const logPath = "data/logs/cron.log";

  const lines: string[] = [];

  lines.push("# === Threads AI Agent System ===");
  lines.push(`# 生成日時: ${new Date().toISOString()}`);
  lines.push(`# プロジェクト: ${root}`);
  lines.push("");

  // Daily agents — research, analyze, write (morning sequence)
  lines.push("# 日次エージェント（毎朝順次実行）");
  lines.push(
    `0  6 * * * cd ${root} && bun run agent:research >> ${logPath} 2>&1`
  );
  lines.push(
    `30 6 * * * cd ${root} && bun run agent:analyze >> ${logPath} 2>&1`
  );
  lines.push(
    `0  7 * * * cd ${root} && bun run agent:write >> ${logPath} 2>&1`
  );
  lines.push("");

  // Metrics fetching (twice daily)
  lines.push("# メトリクス取得（1日2回）");
  lines.push(
    `0 10 * * * cd ${root} && bun run agent:fetch >> ${logPath} 2>&1`
  );
  lines.push(
    `0 22 * * * cd ${root} && bun run agent:fetch >> ${logPath} 2>&1`
  );
  lines.push("");

  // Posting at each scheduled slot
  if (schedule.slots.length > 0) {
    lines.push("# 投稿実行（各スロット時刻）");
    for (const slot of schedule.slots) {
      lines.push(
        `${slot.minute} ${slot.hour} * * * cd ${root} && bun run agent:post >> ${logPath} 2>&1  # ${slot.label}`
      );
    }
    lines.push("");
  }

  // Supervisor (hourly)
  lines.push("# 監視（毎時）");
  lines.push(
    `0 * * * * cd ${root} && bun run agent:supervise >> ${logPath} 2>&1`
  );
  lines.push("");

  lines.push("# === End Threads AI Agent System ===");

  // Output
  const output = lines.join("\n");

  console.log();
  console.log("\x1b[1m  crontab エントリを生成しました\x1b[0m");
  console.log("\x1b[2m  以下の内容を crontab -e で追加してください:\x1b[0m");
  console.log();
  console.log(output);
  console.log();
  console.log(
    "\x1b[2m  ヒント: 以下のコマンドで既存のcrontabに追記できます:\x1b[0m"
  );
  console.log(
    `\x1b[2m  $ bun run setup-cron | grep -v "^$" | grep "^[^#]" | crontab -\x1b[0m`
  );
  console.log();
}

main();
