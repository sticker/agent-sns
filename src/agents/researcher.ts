import { BaseAgent } from "../core/base-agent";
import type { AgentConfig, ResearchItem, ThemeNode } from "../types";

// ============================================================
// Agent ① リサーチャー — ネタ収集担当
// ============================================================
// - テーマツリーを参照し、ネタが足りないテーマを特定
// - YouTube / X / Web から最新ネタを収集
// - 使えるインサイトを抽出してJSON化
// ============================================================

interface ResearcherInput {
  themeTree: ThemeNode[];
  existingItems: ResearchItem[];
  postHistory: { theme: string; subTheme: string }[];
  persona?: { account?: { name?: string; genre?: string } };
}

interface ResearcherOutput {
  newItems: ResearchItem[];
  gapAnalysis: {
    underservedThemes: string[];
    oversaturatedThemes: string[];
  };
}

/** ジャンル名を埋め込んだシステムプロンプトを生成する */
function buildSystemPrompt(genreName: string): string {
  return `あなたは最高のSNSリサーチャーです。
${genreName}Threadsアカウントのネタ収集を担当しています。

# あなたの仕事
1. テーマツリーの各テーマについて、投稿ネタの充足度を分析する
2. ネタが不足しているテーマを特定する
3. そのテーマに関する最新の話題・インサイトを生成する

# ネタの品質基準
- 具体的であること（抽象論NG）
- 実用的であること（読者がすぐ使える）
- 感情を動かすこと（驚き、共感、怒り、好奇心）
- 鮮度があること（最新トレンドを反映）

# 出力形式
必ず以下のJSON形式で出力してください。余計なテキストは不要です。
{
  "newItems": [
    {
      "id": "res_YYYYMMDD_001",
      "source": "generated",
      "sourceUrl": "",
      "title": "ネタのタイトル",
      "summary": "ネタの概要（2-3文）",
      "keyInsights": ["インサイト1", "インサイト2"],
      "theme": "親テーマのID",
      "subTheme": "サブテーマのID",
      "usedCount": 0,
      "quality": 4,
      "collectedAt": "ISO日時"
    }
  ],
  "gapAnalysis": {
    "underservedThemes": ["不足テーマ1", "不足テーマ2"],
    "oversaturatedThemes": ["過剰テーマ1"]
  }
}`;
}

export class ResearcherAgent extends BaseAgent<ResearcherInput, ResearcherOutput> {
  constructor() {
    // デフォルトのシステムプロンプトで初期化（execute時に上書きされる）
    const config: AgentConfig = {
      role: "researcher",
      name: "リサーチャー",
      description: "テーマツリーに基づいてネタを収集し、不足テーマを補充する",
      systemPrompt: buildSystemPrompt("AI・テック系"),
      model: "claude-sonnet-4-20250514",
      maxRetries: 3,
      timeoutMs: 60000,
    };
    super(config);
  }

  async execute(input: ResearcherInput): Promise<ResearcherOutput> {
    // ペルソナからジャンル名を取得（未指定時はデフォルト）
    const genreName = input.persona?.account?.genre ?? "AI・テック系";

    // ジャンルに応じたシステムプロンプトを設定
    this.config.systemPrompt = buildSystemPrompt(genreName);

    // テーマ別の投稿数を集計
    const themeCounts: Record<string, number> = {};
    for (const post of input.postHistory) {
      const key = post.subTheme || post.theme;
      themeCounts[key] = (themeCounts[key] || 0) + 1;
    }

    // 既存ネタ数を集計
    const existingByTheme: Record<string, number> = {};
    for (const item of input.existingItems) {
      const key = item.subTheme || item.theme;
      existingByTheme[key] = (existingByTheme[key] || 0) + 1;
    }

    const today = new Date().toISOString().split("T")[0];
    const prompt = `
# 現在のテーマツリー
${JSON.stringify(input.themeTree, null, 2)}

# テーマ別の投稿実績（過去30日）
${JSON.stringify(themeCounts, null, 2)}

# テーマ別の既存ネタストック数
${JSON.stringify(existingByTheme, null, 2)}

# 指示
1. 投稿実績とネタストックが少ないテーマを特定してください
2. それらのテーマに対して、合計10〜15件のネタを生成してください
3. ネタは「${genreName}」ジャンルで、日本語のThreadsに投稿することを前提にしてください
4. 今日は${today}です。最新のトレンドや話題を意識してください
5. IDは "res_${today.replace(/-/g, "")}_001" から連番にしてください

具体的で実用的な、読者が「これ知りたかった！」と思うネタを生成してください。`;

    const result = await this.chatJSON<ResearcherOutput>(prompt);

    console.log(
      `[リサーチャー] ${result.newItems.length}件のネタを生成 | 不足テーマ: ${result.gapAnalysis.underservedThemes.join(", ")}`
    );

    return result;
  }
}
