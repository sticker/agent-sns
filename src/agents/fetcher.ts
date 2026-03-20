// ============================================================
// Fetcher Agent — メトリクス取得
// ============================================================
// LLM不要。Threads Insights API で投稿指標を取得する。
// ============================================================

import {
  loadPosts,
  loadMetrics,
  loadState,
  saveState,
  saveJSON,
  PATHS,
  log,
} from "../core/store";
import type { PostMetrics } from "../types";

const THREADS_API = "https://graph.threads.net/v1.0";
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN!;
const METRIC_FIELDS = "views,likes,replies,reposts,quotes";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Threads Insights API から1投稿分のメトリクスを取得 */
async function fetchInsights(threadsPostId: string): Promise<PostMetrics | null> {
  const url = `${THREADS_API}/${threadsPostId}/insights?metric=${METRIC_FIELDS}&access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);

  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) {
    const body = await res.text();
    log(`fetcher: Insights API エラー (${res.status}): ${body}`);
    return null;
  }

  const json = (await res.json()) as {
    data: { name: string; values: { value: number }[] }[];
  };

  // レスポンスパース
  const m: Record<string, number> = {};
  for (const item of json.data) {
    m[item.name] = item.values?.[0]?.value ?? 0;
  }

  const views = m.views ?? 0;
  const likes = m.likes ?? 0;
  const replies = m.replies ?? 0;
  const reposts = m.reposts ?? 0;
  const quotes = m.quotes ?? 0;
  const engagementRate = views > 0
    ? Math.round(((likes + replies + reposts + quotes) / views) * 10000) / 100
    : 0;

  return {
    postId: "",  // 呼び出し元でセット
    threadsPostId,
    views,
    likes,
    replies,
    reposts,
    quotes,
    engagementRate,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  log("fetcher 開始");

  if (!ACCESS_TOKEN) {
    throw new Error("THREADS_ACCESS_TOKEN が未設定");
  }

  const state = loadState();

  if (state.killSwitch) {
    log("fetcher: キルスイッチ有効 → スキップ");
    return;
  }

  // posted かつ threadsPostId がある投稿を取得
  const posts = loadPosts();
  const postedPosts = posts.filter((p) => p.status === "posted" && p.threadsPostId);

  // 既存メトリクスのIDセット
  const existingMetrics = loadMetrics();
  const existingIds = new Set(existingMetrics.map((m) => m.threadsPostId));

  // まだメトリクスを取得していない投稿
  const targets = postedPosts.filter((p) => !existingIds.has(p.threadsPostId!));

  if (targets.length === 0) {
    log("fetcher: 新規メトリクス取得対象なし");
    state.lastRun.fetcher = new Date().toISOString();
    saveState(state);
    log("fetcher 完了");
    return;
  }

  log(`fetcher: ${targets.length}件のメトリクスを取得`);

  const newMetrics: PostMetrics[] = [];
  let errorCount = 0;

  for (const post of targets) {
    try {
      const metrics = await fetchInsights(post.threadsPostId!);
      if (metrics) {
        metrics.postId = post.id;
        newMetrics.push(metrics);
        log(`fetcher: ${post.id} → views=${metrics.views}, engagement=${metrics.engagementRate}%`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      if (msg === "RATE_LIMITED") {
        // 429 → 5秒待ってリトライ1回
        log("fetcher: 429 レート制限 → 5秒バックオフ後リトライ");
        await sleep(5000);
        try {
          const metrics = await fetchInsights(post.threadsPostId!);
          if (metrics) {
            metrics.postId = post.id;
            newMetrics.push(metrics);
            log(`fetcher: ${post.id} (リトライ成功) → views=${metrics.views}`);
          }
        } catch {
          log(`fetcher: ${post.id} リトライも失敗 → スキップ`);
          errorCount++;
        }
      } else {
        log(`fetcher: ${post.id} 取得失敗 → ${msg}`);
        errorCount++;
      }
    }

    // リクエスト間隔 500ms
    await sleep(500);
  }

  // メトリクス保存
  if (newMetrics.length > 0) {
    const allMetrics = [...existingMetrics, ...newMetrics];
    saveJSON(PATHS.metrics, allMetrics);
    log(`fetcher: ${newMetrics.length}件保存 (合計 ${allMetrics.length}件)`);
  }

  // ステート更新
  if (errorCount > 0) {
    state.errorCounts.fetcher = (state.errorCounts.fetcher ?? 0) + 1;
  } else {
    state.errorCounts.fetcher = 0;
  }

  state.lastRun.fetcher = new Date().toISOString();
  saveState(state);
  log("fetcher 完了");
}

main().catch((e) => {
  log(`fetcher エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
