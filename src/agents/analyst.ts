import { BaseAgent } from "../core/base-agent";
import type {
  AgentConfig,
  AnalystInsight,
  Post,
  PostMetrics,
  PostPattern,
} from "../types";

// ============================================================
// Agent ② アナリスト — 分析担当
// ============================================================
// - 過去投稿のパフォーマンスデータを分析
// - 伸びるパターン/テーマを特定
// - ライターへのフィードバック（指示書）を生成
// ============================================================

interface AnalystInput {
  posts: Post[];
  metrics: PostMetrics[];
  previousInsights?: AnalystInsight[];
}

const SYSTEM_PROMPT = `あなたはSNS分析の専門家です。
Threads投稿のパフォーマンスデータを分析し、次の投稿バッチへの具体的なフィードバックを生成します。

# あなたの仕事
1. 投稿データとメトリクスを分析
2. 伸びるパターン・テーマと、伸びないパターン・テーマを特定
3. 次のバッチでライターが守るべき具体的な指示書を作成

# 分析の観点
- パターン別の平均エンゲージメント率
- テーマ別の反応傾向
- 1行目（フック）のスタイル別パフォーマンス
- 曜日・時間帯別の傾向
- コメント内容の傾向分析

# 出力形式
必ず以下のJSON形式で出力してください。
{
  "id": "insight_YYYYMMDD",
  "period": "YYYY-MM-DD_to_YYYY-MM-DD",
  "topPatterns": [{"pattern": "パターン名", "avgEngagement": 0.05}],
  "weakPatterns": [{"pattern": "パターン名", "avgEngagement": 0.01}],
  "trendingThemes": ["テーマ1"],
  "fadingThemes": ["テーマ1"],
  "recommendations": [
    "具体的な指示1",
    "具体的な指示2"
  ],
  "hookAnalysis": {
    "bestHooks": ["実際にバズったフック文"],
    "hookStyles": ["断言型", "疑問型"]
  },
  "createdAt": "ISO日時"
}`;

export class AnalystAgent extends BaseAgent<AnalystInput, AnalystInsight> {
  constructor() {
    const config: AgentConfig = {
      role: "analyst",
      name: "アナリスト",
      description:
        "投稿パフォーマンスを分析し、ライターへのフィードバックを生成する",
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-sonnet-4-20250514",
      maxRetries: 2,
      timeoutMs: 60000,
    };
    super(config);
  }

  async execute(input: AnalystInput): Promise<AnalystInsight> {
    // 投稿とメトリクスを紐付け
    const postsWithMetrics = input.posts
      .map((post) => {
        const m = input.metrics.find((m) => m.postId === post.id);
        return { ...post, metrics: m || null };
      })
      .filter((p) => p.metrics !== null);

    if (postsWithMetrics.length === 0) {
      console.log("[アナリスト] 分析対象のデータがありません。デフォルト指示を生成します。");
      return this.generateDefaultInsight();
    }

    // パターン別集計
    const patternStats: Record<string, { total: number; engagements: number[] }> = {};
    for (const p of postsWithMetrics) {
      if (!patternStats[p.pattern]) {
        patternStats[p.pattern] = { total: 0, engagements: [] };
      }
      patternStats[p.pattern].total++;
      if (p.metrics) {
        patternStats[p.pattern].engagements.push(p.metrics.engagementRate);
      }
    }

    const today = new Date().toISOString().split("T")[0];
    const prompt = `
# 分析対象データ（直近の投稿パフォーマンス）
${JSON.stringify(
  postsWithMetrics.map((p) => ({
    id: p.id,
    pattern: p.pattern,
    theme: p.theme,
    subTheme: p.subTheme,
    hook: p.hook,
    qualityScore: p.qualityScore?.average,
    views: p.metrics?.views,
    likes: p.metrics?.likes,
    replies: p.metrics?.replies,
    engagementRate: p.metrics?.engagementRate,
    postedAt: p.postedAt,
  })),
  null,
  2
)}

# パターン別の集計サマリー
${JSON.stringify(patternStats, null, 2)}

${
  input.previousInsights?.length
    ? `# 前回の分析結果（参考）\n${JSON.stringify(input.previousInsights[0]?.recommendations, null, 2)}`
    : ""
}

# 指示
上記データを分析し、ライターへの具体的なフィードバックを生成してください。
- 「もっと○○を増やせ」「△△は控えろ」のように具体的に
- 数値データに基づいた根拠を示す
- 今日は${today}です
- IDは "insight_${today.replace(/-/g, "")}" にしてください`;

    const result = await this.chatJSON<AnalystInsight>(prompt);

    console.log(
      `[アナリスト] 分析完了 | トップパターン: ${result.topPatterns[0]?.pattern} | 推奨事項: ${result.recommendations.length}件`
    );

    return result;
  }

  private generateDefaultInsight(): AnalystInsight {
    const today = new Date().toISOString();
    return {
      id: `insight_default`,
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
      createdAt: today,
    };
  }
}
