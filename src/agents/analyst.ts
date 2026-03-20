// ============================================================
// Analyst Agent — 投稿パフォーマンス分析 + ライター向けフィードバック
// ============================================================
// 独立実行スクリプト。claude -p 経由でLLM呼び出し。
// 投稿データ + メトリクスを分析し、writerへの改善指示を生成。
// データ不足時はデフォルトインサイトで対応（コールドスタート）。
// ============================================================

import { callLLMJSON } from "../core/llm";
import {
  log,
  loadState,
  saveState,
  loadPosts,
  loadMetrics,
  loadInsights,
  saveJSON,
  PATHS,
} from "../core/store";
import type { AnalystInsight, Post, PostMetrics, PostPattern } from "../types";

// --- 投稿 + メトリクスの紐付け型 ---

interface PostWithMetrics {
  id: string;
  pattern: PostPattern;
  theme: string;
  subTheme: string;
  hook: string;
  qualityAverage: number;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  engagementRate: number;
  postedAt: string;
}

// --- パターン別統計 ---

interface PatternStat {
  pattern: PostPattern;
  count: number;
  avgEngagement: number;
  totalViews: number;
}

// --- 投稿とメトリクスの紐付け ---

function linkPostsToMetrics(
  posts: Post[],
  metrics: PostMetrics[]
): PostWithMetrics[] {
  const metricsMap = new Map<string, PostMetrics>();
  for (const m of metrics) {
    metricsMap.set(m.postId, m);
  }

  const linked: PostWithMetrics[] = [];
  for (const post of posts) {
    if (post.status !== "posted") continue;
    const m = metricsMap.get(post.id);
    if (!m) continue;
    linked.push({
      id: post.id,
      pattern: post.pattern,
      theme: post.theme,
      subTheme: post.subTheme,
      hook: post.hook,
      qualityAverage: post.qualityScore?.average ?? 0,
      views: m.views,
      likes: m.likes,
      replies: m.replies,
      reposts: m.reposts,
      engagementRate: m.engagementRate,
      postedAt: post.postedAt ?? post.createdAt,
    });
  }
  return linked;
}

// --- パターン別統計を算出 ---

function calcPatternStats(data: PostWithMetrics[]): PatternStat[] {
  const grouped = new Map<
    PostPattern,
    { engagements: number[]; views: number }
  >();

  for (const d of data) {
    const existing = grouped.get(d.pattern) ?? { engagements: [], views: 0 };
    existing.engagements.push(d.engagementRate);
    existing.views += d.views;
    grouped.set(d.pattern, existing);
  }

  const stats: PatternStat[] = [];
  for (const [pattern, { engagements, views }] of grouped) {
    const avg =
      engagements.length > 0
        ? engagements.reduce((a, b) => a + b, 0) / engagements.length
        : 0;
    stats.push({
      pattern,
      count: engagements.length,
      avgEngagement: Math.round(avg * 10000) / 10000,
      totalViews: views,
    });
  }

  return stats.sort((a, b) => b.avgEngagement - a.avgEngagement);
}

// --- データ不足時のデフォルトインサイト（コールドスタート対応） ---

function generateDefaultInsight(): AnalystInsight {
  const now = new Date().toISOString();
  return {
    id: "insight_default",
    period: "initial",
    topPatterns: [
      { pattern: "short_statement" as PostPattern, avgEngagement: 0 },
      { pattern: "list_3" as PostPattern, avgEngagement: 0 },
    ],
    weakPatterns: [],
    trendingThemes: ["ai_tools", "prompt_eng", "ai_coding"],
    fadingThemes: [],
    recommendations: [
      "初期フェーズ：全パターンを均等に試してデータを集める",
      "断言型フックとリスト型を多めに。Threadsでは短くて強い投稿が伸びやすい",
      "AIツールの具体名を出す。抽象的な話より「○○を使ったらこうなった」が強い",
      "プロンプト系は保存率が高いので積極的に投稿する",
      "ニュースリアクション型は速報性が命。鮮度を意識する",
    ],
    hookAnalysis: {
      bestHooks: [],
      hookStyles: ["断言型", "疑問型", "暴露型"],
    },
    createdAt: now,
  };
}

// --- メイン ---

async function main() {
  log("Analyst 開始");
  const startTime = Date.now();

  const state = loadState();
  if (state.killSwitch) {
    log("KILL SWITCH 有効。中止。");
    return;
  }

  // データ読み込み
  const posts = loadPosts();
  const metrics = loadMetrics();
  const previousInsights = loadInsights();

  // 投稿とメトリクスを紐付け
  const linked = linkPostsToMetrics(posts, metrics);

  // データ不足の場合はデフォルトインサイトを返す（LLM不要）
  if (linked.length === 0) {
    log("分析対象データなし。デフォルトインサイトを生成。");

    const defaultInsight = generateDefaultInsight();
    const allInsights = [...previousInsights, defaultInsight].slice(-10);
    saveJSON(PATHS.insights, allInsights);

    state.lastRun.analyst = new Date().toISOString();
    saveState(state);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`Analyst 完了（デフォルト） (${elapsed}秒)`);
    return;
  }

  // パターン別統計を算出
  const patternStats = calcPatternStats(linked);

  // システムプロンプト
  const systemPrompt = `あなたはSNS分析の専門家です。
Threads投稿のパフォーマンスデータを分析し、次の投稿バッチへの具体的なフィードバックを生成します。

# 分析の観点
- パターン別の平均エンゲージメント率
- テーマ別の反応傾向
- 1行目（フック）のスタイル別パフォーマンス
- 伸びる投稿と伸びない投稿の共通点

# 出力形式
必ず以下のJSON形式で出力してください。
{
  "id": "insight_YYYYMMDD",
  "period": "YYYY-MM-DD〜YYYY-MM-DD",
  "topPatterns": [{"pattern": "パターン名", "avgEngagement": 0.05}],
  "weakPatterns": [{"pattern": "パターン名", "avgEngagement": 0.01}],
  "trendingThemes": ["テーマ1"],
  "fadingThemes": ["テーマ1"],
  "recommendations": ["具体的な指示1", "具体的な指示2"],
  "hookAnalysis": {
    "bestHooks": ["バズったフック文"],
    "hookStyles": ["断言型", "疑問型"]
  },
  "createdAt": "ISO日時"
}`;

  const today = new Date().toISOString().split("T")[0];

  const userPrompt = `以下のデータを分析し、ライターへの具体的なフィードバックを生成してください。

# 投稿パフォーマンスデータ（${linked.length}件）
${JSON.stringify(
  linked.map((d) => ({
    id: d.id,
    pattern: d.pattern,
    theme: d.theme,
    hook: d.hook,
    qualityAverage: d.qualityAverage,
    views: d.views,
    likes: d.likes,
    replies: d.replies,
    engagementRate: d.engagementRate,
    postedAt: d.postedAt,
  })),
  null,
  2
)}

# パターン別集計
${JSON.stringify(patternStats, null, 2)}

${
  previousInsights.length > 0
    ? `# 前回の推奨事項（参考）\n${JSON.stringify(previousInsights[previousInsights.length - 1]?.recommendations, null, 2)}`
    : ""
}

# 指示
- 「もっと○○を増やせ」「△△は控えろ」のように具体的に
- 数値に基づいた根拠を示す
- IDは "insight_${today.replace(/-/g, "")}" にしてください
- 今日は${today}です`;

  log(`分析対象: ${linked.length}件の投稿データ`);

  const insight = await callLLMJSON<AnalystInsight>(userPrompt, {
    systemPrompt,
    model: "sonnet",
  });

  // createdAtが未設定の場合は補完
  if (!insight.createdAt) {
    insight.createdAt = new Date().toISOString();
  }

  // 直近10件のインサイトを保持
  const allInsights = [...previousInsights, insight].slice(-10);
  saveJSON(PATHS.insights, allInsights);

  log(
    `分析完了 | トップパターン: ${insight.topPatterns?.[0]?.pattern ?? "N/A"} | 推奨事項: ${insight.recommendations?.length ?? 0}件`
  );

  // ステート更新
  state.lastRun.analyst = new Date().toISOString();
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Analyst 完了 (${elapsed}秒)`);
}

main().catch((e) => {
  log(`Analyst エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
