// ============================================================
// Poster Agent — 投稿実行（cron用、1回で1件投稿）
// ============================================================
// LLM不要。Threads API経由で queued 投稿を1件投稿する。
// ============================================================

import {
  loadState,
  saveState,
  loadPosts,
  loadQueue,
  loadSchedule,
  saveJSON,
  PATHS,
  log,
} from "../core/store";
import type { Post } from "../types";
import { MAX_DAILY_POSTS } from "../types";

const THREADS_API = "https://graph.threads.net/v1.0";
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN!;
const USER_ID = process.env.THREADS_USER_ID!;
const SLOT_TOLERANCE_MINUTES = 15;

// --- ユーティリティ ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getJSTNow(): Date {
  const now = new Date();
  const jstStr = now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
  return new Date(jstStr);
}

function getTodayDateJST(): string {
  const jst = getJSTNow();
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// --- Threads API ---

/** コンテナ作成 → 3秒待機 → 公開 の2ステップ投稿 */
async function publishSinglePost(text: string, replyToId?: string): Promise<string> {
  const createParams: Record<string, string> = {
    media_type: "TEXT",
    text,
    access_token: ACCESS_TOKEN,
  };
  if (replyToId) {
    createParams.reply_to_id = replyToId;
  }

  // Step 1: コンテナ作成
  const createRes = await fetch(`${THREADS_API}/${USER_ID}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(createParams),
  });

  if (createRes.status === 429) throw new Error("RATE_LIMITED");
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`コンテナ作成失敗 (${createRes.status}): ${body}`);
  }

  const { id: containerId } = (await createRes.json()) as { id: string };

  // Step 2: 3秒待機（Threads API推奨）
  await sleep(3000);

  // Step 3: 公開
  const publishRes = await fetch(`${THREADS_API}/${USER_ID}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: containerId,
      access_token: ACCESS_TOKEN,
    }),
  });

  if (publishRes.status === 429) throw new Error("RATE_LIMITED");
  if (!publishRes.ok) {
    const body = await publishRes.text();
    throw new Error(`公開失敗 (${publishRes.status}): ${body}`);
  }

  const { id: postId } = (await publishRes.json()) as { id: string };
  return postId;
}

/** スレッド投稿（threadParts を連鎖リプライで投稿） */
async function publishThread(parts: string[]): Promise<string> {
  let rootId = "";
  let parentId = "";

  for (let i = 0; i < parts.length; i++) {
    const replyTo = i === 0 ? undefined : parentId;
    const postId = await publishSinglePost(parts[i], replyTo);
    if (i === 0) rootId = postId;
    parentId = postId;
    if (i < parts.length - 1) await sleep(1000);
  }

  return rootId;
}

/** コメントリプライ付き投稿（本文 → セルフリプライ） */
async function publishWithCommentReply(
  content: string,
  commentReply: string,
): Promise<string> {
  const rootId = await publishSinglePost(content);
  await sleep(1000);
  await publishSinglePost(commentReply, rootId);
  return rootId;
}

// --- スケジュールスロット判定 ---

function isNearSlot(schedule: ReturnType<typeof loadSchedule>): boolean {
  // スロット未設定 → 常に許可
  if (schedule.slots.length === 0) return true;

  const now = getJSTNow();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const slot of schedule.slots) {
    const slotMinutes = slot.hour * 60 + slot.minute;
    if (Math.abs(nowMinutes - slotMinutes) <= SLOT_TOLERANCE_MINUTES) {
      return true;
    }
  }
  return false;
}

// --- メイン ---

async function main() {
  log("poster 開始");

  if (!ACCESS_TOKEN || !USER_ID) {
    throw new Error("THREADS_ACCESS_TOKEN / THREADS_USER_ID が未設定");
  }

  const state = loadState();

  // キルスイッチ確認
  if (state.killSwitch) {
    log("poster: キルスイッチ有効 → スキップ");
    return;
  }

  // 日付変更 → カウントリセット
  const today = getTodayDateJST();
  if (state.todayDate !== today) {
    state.dailyPostCount = 0;
    state.todayDate = today;
    log(`poster: 日付変更 → カウントリセット (${today})`);
  }

  // 日次上限チェック
  if (state.dailyPostCount >= MAX_DAILY_POSTS) {
    log(`poster: 日次上限到達 (${state.dailyPostCount}/${MAX_DAILY_POSTS}) → スキップ`);
    state.lastRun.poster = new Date().toISOString();
    saveState(state);
    return;
  }

  // スケジュールスロットチェック
  const schedule = loadSchedule();
  if (!isNearSlot(schedule)) {
    log("poster: 現在時刻はスケジュールスロット外 → スキップ");
    state.lastRun.poster = new Date().toISOString();
    saveState(state);
    return;
  }

  // キューから queued 投稿を1件取得（draft は対象外）
  const queue = loadQueue();
  const target = queue.find((p) => p.status === "queued");
  if (!target) {
    log("poster: キューに queued 投稿なし → スキップ");
    state.lastRun.poster = new Date().toISOString();
    saveState(state);
    return;
  }

  log(`poster: 投稿実行 → ${target.id} (${target.pattern})`);

  try {
    let threadsPostId: string;

    // アフィリエイトリンクがあればコンテンツに追記
    let content = target.content;
    if (target.affiliateLink) {
      content += `\n\n${target.affiliateLink}`;
    }

    if (target.threadParts && target.threadParts.length > 0) {
      // スレッド（連鎖リプライ）
      threadsPostId = await publishThread(target.threadParts);
    } else if (target.commentReply) {
      // コメント誘導型（セルフリプライ付き）
      threadsPostId = await publishWithCommentReply(content, target.commentReply);
    } else {
      // 通常の単発投稿
      threadsPostId = await publishSinglePost(content);
    }

    // 投稿成功 → ステータス更新
    const now = new Date().toISOString();
    target.status = "posted";
    target.postedAt = now;
    target.threadsPostId = threadsPostId;

    // posts.json 更新（既存なら上書き、なければ追加）
    const posts = loadPosts();
    const idx = posts.findIndex((p) => p.id === target.id);
    if (idx >= 0) {
      posts[idx] = target;
    } else {
      posts.push(target);
    }
    saveJSON(PATHS.posts, posts);

    // queue.json から除去
    const updatedQueue = queue.filter((p) => p.id !== target.id);
    saveJSON(PATHS.queue, updatedQueue);

    // ステート更新
    state.dailyPostCount += 1;
    state.errorCounts.poster = 0;

    log(`poster: 投稿成功 → ${threadsPostId} (本日 ${state.dailyPostCount}件目)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg === "RATE_LIMITED") {
      log("poster: 429 レート制限 → バックオフしてスキップ");
    } else {
      log(`poster: 投稿失敗 → ${msg}`);
      target.status = "failed";
      const updatedQueue = queue.map((p) => (p.id === target.id ? target : p));
      saveJSON(PATHS.queue, updatedQueue);
    }

    state.errorCounts.poster = (state.errorCounts.poster ?? 0) + 1;
  }

  state.lastRun.poster = new Date().toISOString();
  saveState(state);
  log("poster 完了");
}

main().catch((e) => {
  log(`poster エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
