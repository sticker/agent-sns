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
import {
  loadMemory,
  saveMemory,
  formatMemoryForPrompt,
  pruneMemory,
  type AgentMemory,
} from "../core/memory";
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

  // メモリ読み込み（自己改善ループ）
  const memory = loadMemory("analyst");
  memory.stats.totalRuns++;
  memory.stats.lastRunAt = new Date().toISOString();

  // メモリをプロンプト注入用に変換
  const memoryContext = formatMemoryForPrompt(memory);

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

    // メモリ保存（データ不足時もrun記録は残す）
    saveMemory("analyst", memory);

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
- 今日は${today}です
${memoryContext}`;

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

  // 振り返り: 過去の推奨事項の精度を分析
  const updatedMemory = await reflectAnalyst(insight, previousInsights, linked, memory);
  saveMemory("analyst", updatedMemory);

  // ステート更新
  state.lastRun.analyst = new Date().toISOString();
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Analyst 完了 (${elapsed}秒)`);
}

// --- 振り返り: 過去の予測・推奨の精度を分析 ---

async function reflectAnalyst(
  currentInsight: AnalystInsight,
  previousInsights: AnalystInsight[],
  linkedData: PostWithMetrics[],
  memory: AgentMemory
): Promise<AgentMemory> {
  // 前回の推奨事項を取得
  const lastInsight = previousInsights.length > 0
    ? previousInsights[previousInsights.length - 1]
    : null;

  const reflectionPrompt = `
あなたはSNS分析アナリストの自己改善アドバイザーです。
過去の予測・推奨が正しかったかを検証し、分析精度を向上させる学びを抽出してください。

# 今回の分析結果
- トップパターン: ${currentInsight.topPatterns?.map((p) => `${p.pattern}(${p.avgEngagement})`).join(", ") || "N/A"}
- 弱いパターン: ${currentInsight.weakPatterns?.map((p) => `${p.pattern}(${p.avgEngagement})`).join(", ") || "N/A"}
- トレンドテーマ: ${currentInsight.trendingThemes?.join(", ") || "N/A"}
- 推奨事項: ${currentInsight.recommendations?.join(" / ") || "N/A"}

${lastInsight ? `# 前回の推奨事項（検証対象）
- トップパターン: ${lastInsight.topPatterns?.map((p) => `${p.pattern}(${p.avgEngagement})`).join(", ") || "N/A"}
- 推奨事項: ${lastInsight.recommendations?.join(" / ") || "N/A"}
- トレンド予測: ${lastInsight.trendingThemes?.join(", ") || "N/A"}` : "（前回データなし）"}

# 分析対象データ件数
${linkedData.length}件

# 現在の学び
${memory.learnings.map((l) => `- [${l.category}] ${l.insight} (id: ${l.id})`).join("\n") || "（まだなし）"}

# 指示
1. 前回の予測・推奨は正確だったか？ 1〜3件の学びを抽出
2. 分析の盲点（見落としがち観点）があれば指摘
3. 次回の分析で重点的に見るべきポイント

JSON形式で出力:
{
  "newLearnings": [
    {
      "category": "accuracy|pattern|theme|process",
      "insight": "具体的な学び",
      "confidence": 0.7,
      "evidence": "根拠"
    }
  ],
  "updatedConfidences": [
    { "learningId": "既存の学びのID", "newConfidence": 0.8, "reason": "理由" }
  ]
}`;

  try {
    const result = await callLLMJSON<{
      newLearnings: { category: string; insight: string; confidence: number; evidence: string }[];
      updatedConfidences: { learningId: string; newConfidence: number; reason: string }[];
    }>(reflectionPrompt, {
      systemPrompt: "あなたはSNS分析の精度改善アドバイザーです。過去の予測と実績を比較し、分析の盲点を見つけてください。",
      model: "haiku",
    });

    // 新しい学びを追加
    const now = new Date().toISOString();
    for (const learning of result.newLearnings) {
      memory.learnings.push({
        id: `learn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        category: learning.category,
        insight: learning.insight,
        confidence: learning.confidence,
        evidence: learning.evidence,
        createdAt: now,
        appliedCount: 0,
        effectiveScore: 0,
      });
    }

    // 既存の学びの確信度を更新
    for (const update of result.updatedConfidences) {
      const existing = memory.learnings.find((l) => l.id === update.learningId);
      if (existing) {
        existing.confidence = update.newConfidence;
      }
    }

    memory.lastReflection = now;
    memory.stats.successfulRuns = (memory.stats.successfulRuns || 0) + 1;

    return pruneMemory(memory);
  } catch (e) {
    log(`[アナリスト] 振り返りでエラー（スキップ）: ${e instanceof Error ? e.message : String(e)}`);
    return memory;
  }
}

main().catch((e) => {
  log(`Analyst エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
