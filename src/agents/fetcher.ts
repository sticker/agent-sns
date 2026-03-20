import { BaseAgent } from "../core/base-agent";
import type { AgentConfig, Post, PostMetrics } from "../types";

// ============================================================
// Agent ⑤ フェッチャー — データ取得担当
// ============================================================
// - 投稿済みのpostからThreads APIでメトリクスを取得
// - 閲覧数・いいね・リプライ・リポストを記録
// - アナリストの分析に必要なデータを蓄積
// ============================================================

interface FetcherInput {
  posts: Post[];          // メトリクス未取得 or 更新対象の投稿
  accessToken: string;
  userId: string;
}

interface FetcherOutput {
  metrics: PostMetrics[];
  errors: { postId: string; error: string }[];
}

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

export class FetcherAgent extends BaseAgent<FetcherInput, FetcherOutput> {
  constructor() {
    const config: AgentConfig = {
      role: "fetcher",
      name: "フェッチャー",
      description: "Threads APIから投稿のメトリクスを取得する",
      systemPrompt: "",
      model: "claude-sonnet-4-20250514",
      maxRetries: 3,
      timeoutMs: 30000,
    };
    super(config);
  }

  async execute(input: FetcherInput): Promise<FetcherOutput> {
    const metrics: PostMetrics[] = [];
    const errors: FetcherOutput["errors"] = [];

    for (const post of input.posts) {
      if (!post.threadsPostId) {
        errors.push({ postId: post.id, error: "No Threads post ID" });
        continue;
      }

      try {
        const data = await this.fetchMetrics(
          post.threadsPostId,
          input.accessToken
        );

        const views = data.views ?? 0;
        const likes = data.likes ?? 0;
        const replies = data.replies ?? 0;
        const reposts = data.reposts ?? 0;
        const quotes = data.quotes ?? 0;

        metrics.push({
          postId: post.id,
          threadsPostId: post.threadsPostId,
          views,
          likes,
          replies,
          reposts,
          quotes,
          engagementRate: views > 0 ? (likes + replies + reposts) / views : 0,
          fetchedAt: new Date().toISOString(),
        });

        // レートリミット対策
        await new Promise((r) => setTimeout(r, 500));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push({ postId: post.id, error: errMsg });
      }
    }

    console.log(
      `[フェッチャー] メトリクス取得: ${metrics.length}件 | エラー: ${errors.length}件`
    );

    return { metrics, errors };
  }

  /**
   * Threads APIからメトリクスを取得
   */
  private async fetchMetrics(
    threadsPostId: string,
    accessToken: string,
    isRetry = false
  ): Promise<Record<string, number>> {
    const metricsToFetch = "views,likes,replies,reposts,quotes";
    const url = `${THREADS_API_BASE}/${threadsPostId}/insights?metric=${metricsToFetch}&access_token=${accessToken}`;

    const res = await fetch(url);

    // レートリミット(429)の場合、バックオフして1回だけリトライ
    if (res.status === 429 && !isRetry) {
      await new Promise((r) => setTimeout(r, 5000));
      return this.fetchMetrics(threadsPostId, accessToken, true);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Threads Insights API failed: ${err}`);
    }

    const json = (await res.json()) as {
      data: Array<{ name: string; values: Array<{ value: number }> }>;
    };

    const result: Record<string, number> = {};
    for (const metric of json.data) {
      result[metric.name] = metric.values?.[0]?.value ?? 0;
    }

    return result;
  }
}
