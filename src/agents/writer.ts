import { BaseAgent } from "../core/base-agent";
import type {
  AgentConfig,
  AnalystInsight,
  Post,
  PostPattern,
  QualityScore,
  ResearchItem,
} from "../types";
import {
  QUALITY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  MAX_CONSECUTIVE_SAME_THEME,
} from "../types";

// ============================================================
// Agent ③ ライター — 投稿作成担当（メインエンジン）
// ============================================================
// - リサーチャーのネタ + アナリストのフィードバックを入力
// - 投稿パターンをローテーションしながら投稿を生成
// - 独立した厳格レビュアーによる品質採点
// - 品質不合格時はフィードバック付きで最大2回リトライ
// - 過去投稿との類似度チェック（日本語対応n-gram + Intl.Segmenter）
// ============================================================

interface WriterInput {
  researchItems: ResearchItem[];
  analystInsight: AnalystInsight;
  recentPosts: Post[];                // 直近の投稿（類似度チェック用）
  persona: Record<string, unknown>;   // ペルソナ設定
  patterns: Record<string, unknown>;  // 投稿パターン定義
  batchSize: number;
}

interface WriterOutput {
  posts: Post[];
  rejected: { post: Partial<Post>; reason: string }[];
  stats: {
    generated: number;
    accepted: number;
    rejectedByQuality: number;
    rejectedBySimilarity: number;
    rejectedByRotation: number;
  };
}

/** 品質リトライの最大回数 */
const MAX_QUALITY_RETRIES = 2;

/** 厳格レビュアーのシステムプロンプト */
const REVIEWER_SYSTEM_PROMPT = `あなたは厳格なSNS投稿の品質審査員です。採点は厳しく、7.0以上は全体の60%以下にしてください。甘い採点は絶対にしないでください。

# 採点の10項目（各10点満点）
1. hookStrength: フックの強さ（スクロールを止める力）
2. usefulness: 有益性（読者にとっての価値）
3. specificity: 具体性（抽象論でなく具体的か）
4. tempo: テンポ感（リズムよく読めるか）
5. personaMatch: ペルソナ一致度（設定した口調・キャラに合ってるか）
6. uniqueness: オリジナリティ（ありきたりでないか）
7. emotionalTrigger: 感情トリガー（驚き・共感・好奇心を刺激するか）
8. readability: 読みやすさ（改行・文の長さ・構造）
9. ctaPower: 行動喚起力（いいね・コメント・保存したくなるか）
10. platformFit: Threads最適化度（Threadsの文化に合ってるか）

# 出力形式
必ず以下のJSON形式で出力してください。
{
  "hookStrength": 7,
  "usefulness": 6,
  "specificity": 7,
  "tempo": 6,
  "personaMatch": 7,
  "uniqueness": 5,
  "emotionalTrigger": 6,
  "readability": 7,
  "ctaPower": 6,
  "platformFit": 7,
  "average": 6.4
}`;

export class WriterAgent extends BaseAgent<WriterInput, WriterOutput> {
  constructor() {
    const config: AgentConfig = {
      role: "writer",
      name: "ライター",
      description:
        "リサーチとフィードバックを元に高品質な投稿を生成する",
      // 初期値は空文字。execute() 内で動的に構築する
      systemPrompt: "",
      model: "claude-sonnet-4-20250514",
      maxRetries: 2,
      timeoutMs: 120000,
    };
    super(config);
  }

  /**
   * ペルソナとパターン定義からシステムプロンプトを動的に構築する
   */
  private buildSystemPrompt(
    persona: Record<string, unknown>,
    patterns: Record<string, unknown>
  ): string {
    // ペルソナ情報を安全に抽出
    const personaData = (persona as Record<string, Record<string, unknown>>).persona ?? {};
    const rules = (persona as Record<string, Record<string, unknown>>).rules ?? {};
    const tone = personaData.tone ?? "フランクだけど知的";
    const firstPerson = personaData.firstPerson ?? "僕";
    const mustFollow = (rules.mustFollow as string[]) ?? [];
    const ngWords = (rules.ngWords as string[]) ?? [];

    // パターン定義をテキスト化
    const patternEntries = Object.entries(patterns);
    const patternText = patternEntries.length > 0
      ? patternEntries
          .map(([key, val]) => {
            const desc = typeof val === "object" && val !== null
              ? (val as Record<string, unknown>).description ?? key
              : key;
            return `- ${key}: ${desc}`;
          })
          .join("\n")
      : "（パターン定義なし）";

    // 必須ルールをテキスト化
    const mustFollowText = mustFollow.length > 0
      ? mustFollow.map((rule, i) => `${i + 1}. ${rule}`).join("\n")
      : `1. 1投稿1メッセージ。情報を詰め込まない
2. 1行目（フック）が命。スクロールを止めるインパクト
3. 改行を多用。1文ごとに改行。壁打ちテキストNG
4. 具体的なツール名・数字・手順を入れる`;

    // NGワードをテキスト化
    const ngWordsText = ngWords.length > 0
      ? ngWords.map((w) => `「${w}」`).join("、")
      : "「〜かもしれません」、「〜と思われます」";

    return `あなたはThreadsで圧倒的にバズる投稿を書くプロのライターです。
AI・テック系アカウントの投稿を作成します。

# トーン
${tone}

# 一人称
${firstPerson}

# 絶対に守るルール
${mustFollowText}

# NGワード（絶対に使わないこと）
${ngWordsText}

# 使用可能な投稿パターン
${patternText}

# 投稿生成の流れ
1. 指定されたパターンとテーマで投稿を書く
2. 書いた投稿を10項目で自己採点する
3. 平均7.0以上なら合格、未満なら書き直し

# 自己採点の10項目（各10点満点）
1. hookStrength: フックの強さ（スクロールを止める力）
2. usefulness: 有益性（読者にとっての価値）
3. specificity: 具体性（抽象論でなく具体的か）
4. tempo: テンポ感（リズムよく読めるか）
5. personaMatch: ペルソナ一致度（設定した口調・キャラに合ってるか）
6. uniqueness: オリジナリティ（ありきたりでないか）
7. emotionalTrigger: 感情トリガー（驚き・共感・好奇心を刺激するか）
8. readability: 読みやすさ（改行・文の長さ・構造）
9. ctaPower: 行動喚起力（いいね・コメント・保存したくなるか）
10. platformFit: Threads最適化度（Threadsの文化に合ってるか）

# 出力形式
必ず以下のJSON形式で出力してください。
{
  "posts": [
    {
      "content": "投稿本文",
      "pattern": "パターン名",
      "theme": "テーマID",
      "subTheme": "サブテーマID",
      "hook": "1行目のテキスト",
      "qualityScore": {
        "hookStrength": 8,
        "usefulness": 7,
        "specificity": 8,
        "tempo": 7,
        "personaMatch": 8,
        "uniqueness": 7,
        "emotionalTrigger": 7,
        "readability": 8,
        "ctaPower": 7,
        "platformFit": 8,
        "average": 7.5
      },
      "threadParts": ["パート1", "パート2"],
      "commentReply": "コメント欄の自己返信（必要な場合のみ）"
    }
  ]
}`;
  }

  async execute(input: WriterInput): Promise<WriterOutput> {
    // P1 #13: システムプロンプトを動的に構築
    this.config.systemPrompt = this.buildSystemPrompt(input.persona, input.patterns);

    const stats = {
      generated: 0,
      accepted: 0,
      rejectedByQuality: 0,
      rejectedBySimilarity: 0,
      rejectedByRotation: 0,
    };
    const acceptedPosts: Post[] = [];
    const rejected: { post: Partial<Post>; reason: string }[] = [];

    // 使用可能なパターンを決定（直近の重複を避ける）
    const recentPatterns = input.recentPosts.slice(0, 3).map((p) => p.pattern);
    const recentThemes = input.recentPosts.slice(0, MAX_CONSECUTIVE_SAME_THEME).map((p) => p.theme);

    // テーマの偏り検出
    const themeIsRepeating =
      recentThemes.length >= MAX_CONSECUTIVE_SAME_THEME &&
      recentThemes.every((t) => t === recentThemes[0]);

    const prompt = `
# ペルソナ設定
${JSON.stringify(input.persona, null, 2)}

# 投稿パターン定義
${JSON.stringify(input.patterns, null, 2)}

# アナリストからのフィードバック
${JSON.stringify(input.analystInsight.recommendations, null, 2)}

# 伸びてるパターン
${JSON.stringify(input.analystInsight.topPatterns, null, 2)}

# 避けるべきパターン
${JSON.stringify(input.analystInsight.weakPatterns, null, 2)}

# フック分析
${JSON.stringify(input.analystInsight.hookAnalysis, null, 2)}

# 使えるネタ一覧
${JSON.stringify(
  input.researchItems.slice(0, 15).map((r) => ({
    title: r.title,
    summary: r.summary,
    keyInsights: r.keyInsights,
    theme: r.theme,
    subTheme: r.subTheme,
  })),
  null,
  2
)}

# 制約条件
- 直近3件で使ったパターン（使用禁止）: ${JSON.stringify(recentPatterns)}
${themeIsRepeating ? `- テーマ「${recentThemes[0]}」が${MAX_CONSECUTIVE_SAME_THEME}回連続しているので、必ず別テーマにすること` : ""}
- 生成本数: ${input.batchSize}本
- 全て異なるテーマ・パターンの組み合わせにすること
- 各投稿に自己採点を付けること（平均7.0以上を目指す）

# 指示
上記を踏まえて${input.batchSize}本の投稿を生成してください。
パターンとテーマをバランスよくローテーションしてください。
1本目の投稿のIDは "post_${new Date().toISOString().split("T")[0].replace(/-/g, "")}_001" から連番にしてください。`;

    const raw = await this.chatJSON<{
      posts: Array<{
        content: string;
        pattern: PostPattern;
        theme: string;
        subTheme: string;
        hook: string;
        qualityScore: QualityScore;
        threadParts?: string[];
        commentReply?: string;
      }>;
    }>(prompt);

    stats.generated = raw.posts.length;

    // 各投稿をバリデーション
    for (let i = 0; i < raw.posts.length; i++) {
      let p = raw.posts[i];
      const postId = `post_${new Date().toISOString().split("T")[0].replace(/-/g, "")}_${String(i + 1).padStart(3, "0")}`;

      // P1 #7: 独立した厳格レビュアーによる再採点
      let qualityScore = await this.rescorePost(p.content, p.pattern, p.theme);

      // P1 #8: 品質不合格時はフィードバック付きでリトライ（最大2回）
      let retryCount = 0;
      while (qualityScore.average < QUALITY_THRESHOLD && retryCount < MAX_QUALITY_RETRIES) {
        retryCount++;
        console.log(
          `[ライター] 投稿${postId} 品質スコア${qualityScore.average} — リトライ ${retryCount}/${MAX_QUALITY_RETRIES}`
        );

        // 低スコア項目を列挙
        const lowScoreItems = this.getLowScoreItems(qualityScore);
        const feedbackPrompt = `この投稿は品質スコア ${qualityScore.average} で不合格でした。以下の改善点を踏まえて書き直してください:
${lowScoreItems.map((item) => `- ${item.name}: ${item.score}点 — 改善が必要`).join("\n")}

# 元の投稿
${p.content}

# パターン: ${p.pattern}
# テーマ: ${p.theme}

# 出力形式
以下のJSON形式で出力してください。
{
  "content": "書き直した投稿本文",
  "hook": "1行目のテキスト",
  "threadParts": ["パート1", "パート2"],
  "commentReply": "コメント欄の自己返信（必要な場合のみ）"
}`;

        try {
          const rewritten = await this.chatJSON<{
            content: string;
            hook: string;
            threadParts?: string[];
            commentReply?: string;
          }>(feedbackPrompt);

          // 書き直した内容で更新
          p = {
            ...p,
            content: rewritten.content,
            hook: rewritten.hook,
            threadParts: rewritten.threadParts ?? p.threadParts,
            commentReply: rewritten.commentReply ?? p.commentReply,
          };

          // 再度厳格レビュアーで採点
          qualityScore = await this.rescorePost(p.content, p.pattern, p.theme);
        } catch (e) {
          console.error(
            `[ライター] リトライ${retryCount}回目の書き直しに失敗: ${(e as Error).message}`
          );
          break;
        }
      }

      // 品質スコアチェック（リトライ後も不合格なら棄却）
      if (qualityScore.average < QUALITY_THRESHOLD) {
        stats.rejectedByQuality++;
        rejected.push({
          post: { ...p, id: postId, qualityScore },
          reason: `品質スコア ${qualityScore.average} < 閾値 ${QUALITY_THRESHOLD}（リトライ${retryCount}回後）`,
        });
        continue;
      }

      // 類似度チェック（日本語対応n-gram + Intl.Segmenter）
      const similarity = this.checkSimilarity(p.content, input.recentPosts);
      if (similarity > SIMILARITY_THRESHOLD) {
        stats.rejectedBySimilarity++;
        rejected.push({
          post: { ...p, id: postId, qualityScore },
          reason: `類似度 ${similarity.toFixed(2)} > 閾値 ${SIMILARITY_THRESHOLD}`,
        });
        continue;
      }

      // パターンローテーションチェック
      const allPatterns = [...acceptedPosts.map((ap) => ap.pattern), ...recentPatterns];
      const lastTwo = allPatterns.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((pat) => pat === p.pattern)) {
        stats.rejectedByRotation++;
        rejected.push({
          post: { ...p, id: postId, qualityScore },
          reason: `パターン「${p.pattern}」が3連続になるためスキップ`,
        });
        continue;
      }

      // 合格
      stats.accepted++;
      acceptedPosts.push({
        id: postId,
        content: p.content,
        pattern: p.pattern,
        theme: p.theme,
        subTheme: p.subTheme,
        hook: p.hook,
        qualityScore,
        similarityScore: similarity,
        threadParts: p.threadParts,
        commentReply: p.commentReply,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
    }

    console.log(
      `[ライター] 生成:${stats.generated} → 採用:${stats.accepted} | ` +
        `品質NG:${stats.rejectedByQuality} 類似NG:${stats.rejectedBySimilarity} ` +
        `ローテNG:${stats.rejectedByRotation}`
    );

    return { posts: acceptedPosts, rejected, stats };
  }

  /**
   * P1 #7: 独立した厳格レビュアーによる品質再採点
   * ライター自身の甘い自己採点を排除するため、別のシステムプロンプトで採点する
   */
  private async rescorePost(
    content: string,
    pattern: PostPattern,
    theme: string
  ): Promise<QualityScore> {
    const reviewPrompt = `以下のSNS投稿を厳格に採点してください。

# 投稿パターン: ${pattern}
# テーマ: ${theme}

# 投稿本文
${content}

上記の投稿を10項目で採点し、JSON形式で出力してください。`;

    try {
      const score = await this.chatJSON<QualityScore>(reviewPrompt, {
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
      });

      // averageが未設定または不正な場合は再計算
      const scoreKeys: (keyof Omit<QualityScore, "average">)[] = [
        "hookStrength", "usefulness", "specificity", "tempo",
        "personaMatch", "uniqueness", "emotionalTrigger",
        "readability", "ctaPower", "platformFit",
      ];
      const sum = scoreKeys.reduce((acc, key) => acc + (score[key] ?? 0), 0);
      score.average = Math.round((sum / scoreKeys.length) * 10) / 10;

      return score;
    } catch (e) {
      console.error(
        `[ライター] 再採点に失敗、デフォルトスコアを使用: ${(e as Error).message}`
      );
      // 再採点失敗時は安全側に倒して低めのスコアを返す
      return {
        hookStrength: 5,
        usefulness: 5,
        specificity: 5,
        tempo: 5,
        personaMatch: 5,
        uniqueness: 5,
        emotionalTrigger: 5,
        readability: 5,
        ctaPower: 5,
        platformFit: 5,
        average: 5.0,
      };
    }
  }

  /**
   * P1 #8: 品質スコアのうち低い項目を抽出する（リトライ時のフィードバック用）
   */
  private getLowScoreItems(
    score: QualityScore
  ): { name: string; score: number }[] {
    const items: { name: string; score: number }[] = [
      { name: "hookStrength（フックの強さ）", score: score.hookStrength },
      { name: "usefulness（有益性）", score: score.usefulness },
      { name: "specificity（具体性）", score: score.specificity },
      { name: "tempo（テンポ感）", score: score.tempo },
      { name: "personaMatch（ペルソナ一致度）", score: score.personaMatch },
      { name: "uniqueness（オリジナリティ）", score: score.uniqueness },
      { name: "emotionalTrigger（感情トリガー）", score: score.emotionalTrigger },
      { name: "readability（読みやすさ）", score: score.readability },
      { name: "ctaPower（行動喚起力）", score: score.ctaPower },
      { name: "platformFit（Threads最適化度）", score: score.platformFit },
    ];
    // 7.0未満の項目を低い順にソートして返す
    return items
      .filter((item) => item.score < QUALITY_THRESHOLD)
      .sort((a, b) => a.score - b.score);
  }

  /**
   * P1 #6: 日本語対応の類似度チェック（Jaccard係数ベース）
   * 文字レベルn-gram + Intl.Segmenter による分かち書きのハイブリッド
   */
  private checkSimilarity(content: string, recentPosts: Post[]): number {
    if (recentPosts.length === 0) return 0;

    const tokenize = (text: string): Set<string> => {
      const normalized = text.replace(/[\n\r\s]+/g, "");
      const tokens: string[] = [];

      // 文字レベル2-gram
      for (let i = 0; i < normalized.length - 1; i++) {
        tokens.push(normalized.slice(i, i + 2));
      }
      // 文字レベル3-gram
      for (let i = 0; i < normalized.length - 2; i++) {
        tokens.push(normalized.slice(i, i + 3));
      }

      // Intl.Segmenter による日本語分かち書き
      const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
      for (const { segment, isWordLike } of segmenter.segment(text)) {
        if (isWordLike && segment.length > 1) {
          tokens.push(segment);
        }
      }

      return new Set(tokens);
    };

    const contentTokens = tokenize(content);
    let maxSimilarity = 0;

    for (const post of recentPosts.slice(0, 100)) {
      const postTokens = tokenize(post.content);
      const intersection = new Set(
        [...contentTokens].filter((t) => postTokens.has(t))
      );
      const union = new Set([...contentTokens, ...postTokens]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      maxSimilarity = Math.max(maxSimilarity, jaccard);
    }

    return maxSimilarity;
  }
}
