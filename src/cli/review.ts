// ============================================================
// CLI: review — 投稿レビューUI (Human-in-the-loop)
// ============================================================
// bun run review
// draft状態の投稿を1件ずつレビューし、承認/却下/編集/スキップする
// ============================================================

import { readSync, openSync, closeSync, writeSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import {
  loadQueue,
  loadPosts,
  saveJSON,
  PATHS,
  log,
} from "../core/store";
import type { Post, QualityScore } from "../types";

// --- ANSI helpers ---

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

// --- Prompt (synchronous /dev/tty read) ---

function prompt(msg: string): string {
  process.stdout.write(msg);
  const buf = Buffer.alloc(1024);
  const n = readSync(0, buf, 0, 1024, null);
  return buf.toString("utf-8", 0, n).trim();
}

// --- Box drawing helpers ---

const BOX_WIDTH = 56;

function boxTop(): string {
  return `╔${"═".repeat(BOX_WIDTH)}╗`;
}

function boxBottom(): string {
  return `╚${"═".repeat(BOX_WIDTH)}╝`;
}

function boxSep(): string {
  return `╠${"═".repeat(BOX_WIDTH)}╣`;
}

function boxLine(text: string): string {
  // Strip ANSI codes for length calculation
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, BOX_WIDTH - 2 - plain.length);
  return `║ ${text}${" ".repeat(pad)} ║`;
}

function boxEmpty(): string {
  return `║${" ".repeat(BOX_WIDTH)}║`;
}

// Wrap long text into multiple boxLine rows
function boxWrapped(text: string, indent = 0): string[] {
  const maxWidth = BOX_WIDTH - 4 - indent;
  const lines: string[] = [];
  const prefix = " ".repeat(indent);

  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push(boxEmpty());
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > maxWidth) {
      lines.push(boxLine(prefix + remaining.slice(0, maxWidth)));
      remaining = remaining.slice(maxWidth);
    }
    lines.push(boxLine(prefix + remaining));
  }
  return lines;
}

// --- Score formatting ---

function scoreBar(value: number): string {
  const filled = Math.round(value);
  const empty = 10 - filled;
  const color = value >= 8 ? green : value >= 6 ? yellow : red;
  return color("█".repeat(filled)) + dim("░".repeat(empty));
}

function formatScore(label: string, value: number): string {
  const paddedLabel = label.padEnd(16);
  return `${dim(paddedLabel)} ${scoreBar(value)} ${bold(value.toFixed(1))}`;
}

// --- Quality score labels ---

const SCORE_LABELS: Record<keyof Omit<QualityScore, "average">, string> = {
  hookStrength: "フック力",
  usefulness: "有用性",
  specificity: "具体性",
  tempo: "テンポ",
  personaMatch: "ペルソナ適合",
  uniqueness: "独自性",
  emotionalTrigger: "感情喚起",
  readability: "読みやすさ",
  ctaPower: "CTA力",
  platformFit: "プラットフォーム適合",
};

// --- Display a single post ---

function displayPost(post: Post, index: number, total: number): void {
  const avgColor =
    post.qualityScore.average >= 8
      ? green
      : post.qualityScore.average >= 6
        ? yellow
        : red;

  console.log();
  console.log(boxTop());
  console.log(
    boxLine(
      `${bold(`[${index + 1}/${total}]`)} ${cyan(post.id)}`
    )
  );
  console.log(
    boxLine(
      `パターン: ${magenta(post.pattern)} │ テーマ: ${cyan(post.theme)}`
    )
  );
  if (post.subTheme) {
    console.log(boxLine(`サブテーマ: ${dim(post.subTheme)}`));
  }
  console.log(
    boxLine(`平均スコア: ${avgColor(post.qualityScore.average.toFixed(1))}`)
  );
  console.log(boxSep());

  // Quality score breakdown
  console.log(boxLine(bold("📊 品質スコア詳細")));
  console.log(boxEmpty());
  for (const [key, label] of Object.entries(SCORE_LABELS)) {
    const value = post.qualityScore[key as keyof QualityScore] as number;
    console.log(boxLine(formatScore(label, value)));
  }

  console.log(boxSep());

  // Content
  console.log(boxLine(bold("📝 投稿内容")));
  console.log(boxEmpty());
  for (const line of boxWrapped(post.content, 1)) {
    console.log(line);
  }

  // Thread parts
  if (post.threadParts && post.threadParts.length > 0) {
    console.log(boxSep());
    console.log(boxLine(bold("🧵 スレッド")));
    for (let i = 0; i < post.threadParts.length; i++) {
      console.log(boxEmpty());
      console.log(boxLine(dim(`--- パート ${i + 1} ---`)));
      for (const line of boxWrapped(post.threadParts[i], 1)) {
        console.log(line);
      }
    }
  }

  // Comment reply
  if (post.commentReply) {
    console.log(boxSep());
    console.log(boxLine(bold("💬 コメント返信テンプレ")));
    console.log(boxEmpty());
    for (const line of boxWrapped(post.commentReply, 1)) {
      console.log(line);
    }
  }

  // Hook
  if (post.hook) {
    console.log(boxSep());
    console.log(boxLine(`${bold("🎣 フック:")} ${post.hook}`));
  }

  console.log(boxSep());
  console.log(
    boxLine(
      `${green("[a]承認")}  ${red("[r]却下")}  ${yellow("[e]編集")}  ${dim("[s]スキップ")}  ${bold("[q]終了")}`
    )
  );
  console.log(boxBottom());
}

// --- Edit content via $EDITOR or stdin ---

function editContent(currentContent: string): string {
  const editor = process.env.EDITOR || process.env.VISUAL;

  if (editor) {
    const tmpFile = join(tmpdir(), `review_edit_${Date.now()}.txt`);
    writeFileSync(tmpFile, currentContent, "utf-8");
    try {
      execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });
      const newContent = readFileSync(tmpFile, "utf-8").trim();
      unlinkSync(tmpFile);
      return newContent || currentContent;
    } catch {
      console.log(yellow("  エディタの起動に失敗しました。直接入力に切り替えます。"));
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
  }

  // Fallback: direct input
  console.log(dim("  現在の内容:"));
  console.log(dim(`  ${currentContent.split("\n").join("\n  ")}`));
  console.log();
  const newContent = prompt("  新しい内容（空欄でキャンセル）: ");
  return newContent || currentContent;
}

// --- Main ---

function main(): void {
  console.log();
  console.log(bold("  🔍 投稿レビュー"));
  console.log(dim("  ─────────────────────────────────"));

  const queue = loadQueue();
  const drafts = queue.filter((p) => p.status === "draft");

  if (drafts.length === 0) {
    console.log();
    console.log(green("  ✓ レビュー待ちの投稿はありません。"));
    console.log();
    process.exit(0);
  }

  console.log(`  ${bold(String(drafts.length))}件のドラフトがレビュー待ちです。`);

  let approved = 0;
  let rejected = 0;
  let edited = 0;
  let skipped = 0;

  for (let i = 0; i < drafts.length; i++) {
    const post = drafts[i];
    displayPost(post, i, drafts.length);

    let decided = false;
    while (!decided) {
      const input = prompt(`\n  選択 [${green("a")}/${red("r")}/${yellow("e")}/${dim("s")}/${bold("q")}]: `).toLowerCase();

      switch (input) {
        case "a":
        case "": {
          post.status = "queued";
          post.reviewedAt = new Date().toISOString();
          console.log(green("  → 承認しました ✓"));
          approved++;
          decided = true;
          break;
        }
        case "r": {
          const note = prompt("  却下理由（省略可）: ");
          post.status = "rejected";
          post.reviewedAt = new Date().toISOString();
          if (note) post.reviewNote = note;
          console.log(red("  → 却下しました ✗"));
          rejected++;
          decided = true;
          break;
        }
        case "e": {
          const newContent = editContent(post.content);
          if (newContent !== post.content) {
            post.content = newContent;
            edited++;
            console.log(yellow("  → 内容を更新しました ✎"));
            console.log(dim("  ※ もう一度選択してください（承認/却下/スキップ）"));
          } else {
            console.log(dim("  → 変更なし"));
          }
          // Don't mark as decided — let user choose approve/reject/skip after edit
          break;
        }
        case "s": {
          console.log(dim("  → スキップ"));
          skipped++;
          decided = true;
          break;
        }
        case "q": {
          console.log();
          console.log(bold("  保存して終了します..."));
          saveResults(queue);
          printSummary(approved, rejected, edited, skipped);
          process.exit(0);
          break; // unreachable but satisfy TS
        }
        default: {
          console.log(dim("  無効な入力です。a/r/e/s/q のいずれかを入力してください。"));
          break;
        }
      }
    }
  }

  // All posts processed
  saveResults(queue);
  printSummary(approved, rejected, edited, skipped);
}

function saveResults(queue: Post[]): void {
  saveJSON(PATHS.queue, queue);

  // Also update posts.json for rejected ones (move from queue to history)
  const posts = loadPosts();
  const rejected = queue.filter((p) => p.status === "rejected");
  for (const rp of rejected) {
    if (!posts.find((p) => p.id === rp.id)) {
      posts.push(rp);
    }
  }
  saveJSON(PATHS.posts, posts);

  // Remove rejected from queue
  const cleaned = queue.filter((p) => p.status !== "rejected");
  saveJSON(PATHS.queue, cleaned);

  log(`レビュー完了: キュー更新済み`);
}

function printSummary(
  approved: number,
  rejected: number,
  edited: number,
  skipped: number
): void {
  console.log();
  console.log(bold("  ── レビュー結果 ──"));
  console.log(`  ${green("承認:")} ${approved}件`);
  console.log(`  ${red("却下:")} ${rejected}件`);
  console.log(`  ${yellow("編集:")} ${edited}件`);
  console.log(`  ${dim("スキップ:")} ${skipped}件`);
  console.log();
}

main();
