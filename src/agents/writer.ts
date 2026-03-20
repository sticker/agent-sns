// ============================================================
// Writer Agent — 投稿生成（メインエンジン）
// ============================================================
// 独立実行スクリプト。claude -p 経由でLLM呼び出し。
//
// 生成フロー:
//   1. リサーチ + インサイトを読み込み
//   2. ペルソナ/パターン情報からシステムプロンプトを動的構築
//   3. LLMで投稿バッチ生成
//   4. 各投稿を独立レビュアーで再採点
//   5. 品質不合格 → フィードバック付きリトライ（最大2回）
//   6. 類似度チェック（日本語n-gram + Intl.Segmenter）
//   7. パターン/テーマローテーションチェック
//   8. 合格投稿を status="draft" で queue.json + posts.json に保存
// ============================================================

import { callLLMJSON } from "../core/llm";
import {
  log,
  loadState,
  saveState,
  loadPosts,
  loadQueue,
  loadResearch,
  loadInsights,
  loadPersona,
  loadPatterns,
  loadConfig,
  saveJSON,
  pruneData,
  PATHS,
} from "../core/store";
import {
  loadMemory,
  saveMemory,
  formatMemoryForPrompt,
  pruneMemory,
  type AgentMemory,
} from "../core/memory";
import type {
  Post,
  PostPattern,
  QualityScore,
  ResearchItem,
  AnalystInsight,
} from "../types";
import {
  QUALITY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  MAX_CONSECUTIVE_SAME_THEME,
} from "../types";

// --- 定数 ---

const MAX_QUALITY_RETRIES = 2;

// --- 厳格レビュアーのシステムプロンプト ---

const REVIEWER_SYSTEM_PROMPT = `あなたは厳格なSNS投稿の品質審査員です。
採点は厳しく、7.0以上は全体の60%以下にしてください。甘い採点は絶対にしないでください。

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
  "average": 6.4,
  "feedback": "改善すべき点の簡潔な説明"
}`;

// --- ペルソナ/パターンからシステムプロンプトを動的構築 ---

function buildWriterSystemPrompt(
  persona: Record<string, unknown>,
  patterns: Record<string, unknown>
): string {
  // ペルソナ情報を安全に抽出
  const personaData =
    (persona as Record<string, Record<string, unknown>>).persona ?? {};
  const rules =
    (persona as Record<string, Record<string, unknown>>).rules ?? {};
  const tone = Array.isArray(personaData.tone)
    ? (personaData.tone as string[]).join("\n- ")
    : String(personaData.tone ?? "フランクだけど知的");
  const firstPerson = String(personaData.firstPerson ?? "僕");
  const mustFollow = (rules.mustFollow as string[]) ?? [];
  const ngWords = (rules.ngWords as string[]) ?? [];

  // パターン定義をテキスト化
  const patternsObj =
    (patterns as Record<string, Record<string, unknown>>).patterns ?? patterns;
  const patternEntries = Object.entries(patternsObj);
  const patternText =
    patternEntries.length > 0
      ? patternEntries
          .map(([key, val]) => {
            if (typeof val !== "object" || val === null) return `- ${key}`;
            const v = val as Record<string, unknown>;
            const name = v.name ?? key;
            const desc = v.description ?? "";
            const structure = v.structure ?? "";
            const maxLen = v.maxLength ?? "";
            return `- ${key}（${name}）: ${desc}\n  構成: ${structure} / 最大${maxLen}文字`;
          })
          .join("\n")
      : "（パターン定義なし）";

  const mustFollowText =
    mustFollow.length > 0
      ? mustFollow.map((r, i) => `${i + 1}. ${r}`).join("\n")
      : "1. 1投稿1メッセージ\n2. フックが命\n3. 改行多用\n4. 具体的に書く";

  const ngWordsText =
    ngWords.length > 0
      ? ngWords.map((w) => `「${w}」`).join("、")
      : "（未設定）";

  return `あなたはThreadsで圧倒的にバズる投稿を書くプロのライターです。

# トーン
- ${tone}

# 一人称
${firstPerson}

# 絶対に守るルール
${mustFollowText}

# NGワード（絶対に使わないこと）
${ngWordsText}

# 使用可能な投稿パターン
${patternText}

# 出力形式
必ず以下のJSON形式で出力してください。
{
  "posts": [
    {
      "content": "投稿本文",
      "pattern": "パターンID",
      "theme": "テーマID",
      "subTheme": "サブテーマID",
      "hook": "1行目のテキスト",
      "threadParts": ["パート1", "パート2"],
      "commentReply": "コメント欄の自己返信（必要な場合のみ）"
    }
  ]
}`;
}

// --- 日本語対応の類似度チェック（Jaccard係数 + n-gram + Intl.Segmenter） ---

function tokenize(text: string): Set<string> {
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
}

function checkSimilarity(content: string, recentPosts: Post[]): number {
  if (recentPosts.length === 0) return 0;

  const contentTokens = tokenize(content);
  let max = 0;

  for (const post of recentPosts.slice(0, 100)) {
    const postTokens = tokenize(post.content);
    const intersection = [...contentTokens].filter((t) =>
      postTokens.has(t)
    ).length;
    const union = new Set([...contentTokens, ...postTokens]).size;
    max = Math.max(max, union > 0 ? intersection / union : 0);
  }

  return max;
}

// --- 独立レビュアーによる品質再採点 ---

async function rescorePost(
  content: string,
  pattern: PostPattern,
  theme: string
): Promise<QualityScore & { feedback?: string }> {
  const prompt = `以下のSNS投稿を厳格に採点してください。

# 投稿パターン: ${pattern}
# テーマ: ${theme}

# 投稿本文
${content}

上記の投稿を10項目で採点し、JSON形式で出力してください。`;

  const qualityJsonSchema = {
    type: "object",
    properties: {
      hookStrength: { type: "number" },
      usefulness: { type: "number" },
      specificity: { type: "number" },
      tempo: { type: "number" },
      personaMatch: { type: "number" },
      uniqueness: { type: "number" },
      emotionalTrigger: { type: "number" },
      readability: { type: "number" },
      ctaPower: { type: "number" },
      platformFit: { type: "number" },
      average: { type: "number" },
      feedback: { type: "string" },
    },
    required: [
      "hookStrength", "usefulness", "specificity", "tempo",
      "personaMatch", "uniqueness", "emotionalTrigger", "readability",
      "ctaPower", "platformFit", "average", "feedback",
    ],
  };

  try {
    const score = await callLLMJSON<QualityScore & { feedback?: string }>(
      prompt,
      {
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        model: "opus",
        jsonSchema: qualityJsonSchema,
      }
    );

    // averageを再計算（LLMの計算ミス防止）
    const scoreKeys: (keyof Omit<QualityScore, "average">)[] = [
      "hookStrength",
      "usefulness",
      "specificity",
      "tempo",
      "personaMatch",
      "uniqueness",
      "emotionalTrigger",
      "readability",
      "ctaPower",
      "platformFit",
    ];
    const sum = scoreKeys.reduce((acc, key) => acc + (score[key] ?? 0), 0);
    score.average = Math.round((sum / scoreKeys.length) * 10) / 10;

    return score;
  } catch (e) {
    log(
      `再採点失敗、安全側スコアを使用: ${e instanceof Error ? e.message : String(e)}`
    );
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

// --- 低スコア項目を抽出（リトライフィードバック用） ---

function getLowScoreItems(
  score: QualityScore
): { name: string; score: number }[] {
  const items = [
    { name: "hookStrength（フックの強さ）", score: score.hookStrength },
    { name: "usefulness（有益性）", score: score.usefulness },
    { name: "specificity（具体性）", score: score.specificity },
    { name: "tempo（テンポ感）", score: score.tempo },
    { name: "personaMatch（ペルソナ一致度）", score: score.personaMatch },
    { name: "uniqueness（オリジナリティ）", score: score.uniqueness },
    {
      name: "emotionalTrigger（感情トリガー）",
      score: score.emotionalTrigger,
    },
    { name: "readability（読みやすさ）", score: score.readability },
    { name: "ctaPower（行動喚起力）", score: score.ctaPower },
    { name: "platformFit（Threads最適化度）", score: score.platformFit },
  ];
  return items
    .filter((item) => item.score < QUALITY_THRESHOLD)
    .sort((a, b) => a.score - b.score);
}

// --- LLM生成結果の型 ---

interface GeneratedPost {
  content: string;
  pattern: PostPattern;
  theme: string;
  subTheme: string;
  hook: string;
  threadParts?: string[];
  commentReply?: string;
}

// --- メイン ---

async function main() {
  log("Writer 開始");
  const startTime = Date.now();

  const state = loadState();
  if (state.killSwitch) {
    log("KILL SWITCH 有効。中止。");
    return;
  }

  // 設定読み込み
  const config = loadConfig() as { agents?: { writerBatchSize?: number } };
  const batchSize = config.agents?.writerBatchSize ?? 5;

  // データ整理
  pruneData();

  // メモリ読み込み（自己改善ループ）
  const memory = loadMemory("writer");
  memory.stats.totalRuns++;
  memory.stats.lastRunAt = new Date().toISOString();

  // メモリをプロンプト注入用に変換
  const memoryContext = formatMemoryForPrompt(memory);

  // データ読み込み
  const posts = loadPosts();
  const queue = loadQueue();
  const research = loadResearch();
  const insights = loadInsights();
  const persona = loadPersona();
  const patterns = loadPatterns();

  // 最新のインサイト（なければデフォルト）
  const latestInsight: AnalystInsight = insights[insights.length - 1] ?? {
    id: "default",
    period: "initial",
    topPatterns: [],
    weakPatterns: [],
    trendingThemes: ["ai_tools", "prompt_eng"],
    fadingThemes: [],
    recommendations: [
      "全パターンを均等に試す",
      "具体的なツール名を出す",
    ],
    hookAnalysis: { bestHooks: [], hookStyles: ["断言型"] },
    createdAt: new Date().toISOString(),
  };

  // 直近の投稿（類似度チェック + ローテーション用）
  const recentPosts = posts.slice(-100);

  // 直近パターン/テーマ（ローテーション判定用）
  const recentPatterns = recentPosts.slice(-3).map((p) => p.pattern);
  const recentThemes = recentPosts
    .slice(-MAX_CONSECUTIVE_SAME_THEME)
    .map((p) => p.theme);
  const themeIsRepeating =
    recentThemes.length >= MAX_CONSECUTIVE_SAME_THEME &&
    recentThemes.every((t) => t === recentThemes[0]);

  // 使えるリサーチアイテム（usedCountが少ない順、上位15件）
  const availableResearch = [...research]
    .sort((a, b) => a.usedCount - b.usedCount)
    .slice(0, 15);

  // システムプロンプトを動的構築
  const writerSystemPrompt = buildWriterSystemPrompt(persona, patterns);

  // 生成プロンプト
  const userPrompt = `以下の情報を元に${batchSize}本の投稿を生成してください。

# アナリストからのフィードバック
${JSON.stringify(latestInsight.recommendations, null, 2)}

# 伸びてるパターン
${JSON.stringify(latestInsight.topPatterns, null, 2)}

# フック分析
${JSON.stringify(latestInsight.hookAnalysis, null, 2)}

# 使えるネタ一覧
${JSON.stringify(
  availableResearch.map((r) => ({
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
- 直近で使ったパターン（避けること）: ${JSON.stringify(recentPatterns)}
${themeIsRepeating ? `- テーマ「${recentThemes[0]}」が${MAX_CONSECUTIVE_SAME_THEME}回連続中。必ず別テーマにすること` : ""}
- 全て異なるパターン・テーマの組み合わせにすること
- 生成本数: ${batchSize}本
${memoryContext}

JSON形式で出力してください。`;

  log(`投稿${batchSize}本を生成開始`);

  const raw = await callLLMJSON<{ posts: GeneratedPost[] }>(userPrompt, {
    systemPrompt: writerSystemPrompt,
    model: "opus",
  });

  if (!raw.posts || !Array.isArray(raw.posts) || raw.posts.length === 0) {
    log("LLMから投稿を取得できませんでした");
    return;
  }

  log(`LLMから${raw.posts.length}本の投稿を受領。品質チェック開始。`);

  // --- 各投稿のバリデーション ---

  const stats = {
    generated: raw.posts.length,
    accepted: 0,
    rejectedByQuality: 0,
    rejectedBySimilarity: 0,
    rejectedByRotation: 0,
  };
  const acceptedPosts: Post[] = [];
  const rejectedPosts: { post: Partial<Post>; reason: string }[] = [];
  const allRecentForCheck = [...recentPosts]; // ローテーション判定用（採用分を追加していく）

  for (let i = 0; i < raw.posts.length; i++) {
    let p = raw.posts[i];
    const postId = `post_${new Date().toISOString().split("T")[0].replace(/-/g, "")}_${String(i + 1).padStart(3, "0")}`;

    log(`投稿${postId}（${p.pattern} / ${p.theme}）を審査中...`);

    // 1. 独立レビュアーで再採点
    let qualityScore = await rescorePost(p.content, p.pattern, p.theme);

    // 2. 品質不合格時はリトライ（最大2回）
    let retryCount = 0;
    while (
      qualityScore.average < QUALITY_THRESHOLD &&
      retryCount < MAX_QUALITY_RETRIES
    ) {
      retryCount++;
      log(
        `  品質スコア${qualityScore.average} < ${QUALITY_THRESHOLD}。リトライ${retryCount}/${MAX_QUALITY_RETRIES}`
      );

      const lowItems = getLowScoreItems(qualityScore);
      const feedbackPrompt = `この投稿は品質スコア${qualityScore.average}で不合格でした。以下を改善して書き直してください:
${lowItems.map((item) => `- ${item.name}: ${item.score}点`).join("\n")}

# 元の投稿
${p.content}

# パターン: ${p.pattern}
# テーマ: ${p.theme}

書き直した投稿をJSON形式で出力してください:
{
  "content": "書き直した投稿本文",
  "hook": "1行目",
  "threadParts": ["パート1"],
  "commentReply": "自己返信（任意）"
}`;

      try {
        const rewritten = await callLLMJSON<{
          content: string;
          hook: string;
          threadParts?: string[];
          commentReply?: string;
        }>(feedbackPrompt, {
          systemPrompt: writerSystemPrompt,
          model: "opus",
        });

        p = {
          ...p,
          content: rewritten.content,
          hook: rewritten.hook,
          threadParts: rewritten.threadParts ?? p.threadParts,
          commentReply: rewritten.commentReply ?? p.commentReply,
        };

        qualityScore = await rescorePost(p.content, p.pattern, p.theme);
      } catch (e) {
        log(
          `  リトライ${retryCount}失敗: ${e instanceof Error ? e.message : String(e)}`
        );
        break;
      }
    }

    // 品質チェック最終判定
    if (qualityScore.average < QUALITY_THRESHOLD) {
      stats.rejectedByQuality++;
      rejectedPosts.push({ post: { content: p.content, pattern: p.pattern, theme: p.theme }, reason: `品質不合格（${qualityScore.average} < ${QUALITY_THRESHOLD}、リトライ${retryCount}回後）` });
      log(
        `  品質不合格（${qualityScore.average} < ${QUALITY_THRESHOLD}、リトライ${retryCount}回後）`
      );
      continue;
    }

    // 3. 類似度チェック
    const similarity = checkSimilarity(p.content, allRecentForCheck);
    if (similarity > SIMILARITY_THRESHOLD) {
      stats.rejectedBySimilarity++;
      rejectedPosts.push({ post: { content: p.content, pattern: p.pattern, theme: p.theme }, reason: `類似度超過（${similarity.toFixed(2)} > ${SIMILARITY_THRESHOLD}）` });
      log(
        `  類似度超過（${similarity.toFixed(2)} > ${SIMILARITY_THRESHOLD}）`
      );
      continue;
    }

    // 4. パターンローテーションチェック
    const allPatterns = [
      ...allRecentForCheck.slice(-2).map((ap) => ap.pattern),
    ];
    if (
      allPatterns.length >= 2 &&
      allPatterns.every((pat) => pat === p.pattern)
    ) {
      stats.rejectedByRotation++;
      rejectedPosts.push({ post: { content: p.content, pattern: p.pattern, theme: p.theme }, reason: `パターン「${p.pattern}」が3連続` });
      log(`  パターン「${p.pattern}」が3連続になるためスキップ`);
      continue;
    }

    // テーマローテーションチェック
    const recentThemeList = allRecentForCheck
      .slice(-(MAX_CONSECUTIVE_SAME_THEME - 1))
      .map((ap) => ap.theme);
    if (
      recentThemeList.length >= MAX_CONSECUTIVE_SAME_THEME - 1 &&
      recentThemeList.every((t) => t === p.theme)
    ) {
      stats.rejectedByRotation++;
      rejectedPosts.push({ post: { content: p.content, pattern: p.pattern, theme: p.theme }, reason: `テーマ「${p.theme}」が${MAX_CONSECUTIVE_SAME_THEME}連続` });
      log(
        `  テーマ「${p.theme}」が${MAX_CONSECUTIVE_SAME_THEME}連続になるためスキップ`
      );
      continue;
    }

    // 5. 合格 → draft として保存（人間レビュー必須）
    const acceptedPost: Post = {
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
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    acceptedPosts.push(acceptedPost);
    allRecentForCheck.push(acceptedPost);
    stats.accepted++;
    log(
      `  採用（品質${qualityScore.average}, 類似度${similarity.toFixed(2)}）`
    );
  }

  // --- 保存 ---

  if (acceptedPosts.length > 0) {
    // queue.json に追加（ドラフトとして）
    const currentQueue = loadQueue();
    saveJSON(PATHS.queue, [...currentQueue, ...acceptedPosts]);

    // posts.json にも追加（履歴として）
    const currentPosts = loadPosts();
    saveJSON(PATHS.posts, [...currentPosts, ...acceptedPosts]);

    // 使用したリサーチアイテムのusedCountを更新
    const usedSubThemes = new Set(acceptedPosts.map((p) => `${p.theme}:${p.subTheme}`));
    const updatedResearch = research.map((r) => {
      if (usedSubThemes.has(`${r.theme}:${r.subTheme}`)) {
        return { ...r, usedCount: r.usedCount + 1 };
      }
      return r;
    });
    saveJSON(PATHS.research, updatedResearch);
  }

  log(
    `生成:${stats.generated} 採用:${stats.accepted} | ` +
      `品質NG:${stats.rejectedByQuality} 類似NG:${stats.rejectedBySimilarity} ` +
      `ローテNG:${stats.rejectedByRotation}`
  );

  // 振り返り: 今回の結果を分析して学びを抽出
  const updatedMemory = await reflectWriter(stats, acceptedPosts, rejectedPosts, memory);
  saveMemory("writer", updatedMemory);

  // ステート更新
  state.lastRun.writer = new Date().toISOString();
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Writer 完了 (${elapsed}秒)`);
}

// --- 振り返り: 実行結果から学びを抽出 ---

async function reflectWriter(
  stats: { generated: number; accepted: number; rejectedByQuality: number; rejectedBySimilarity: number; rejectedByRotation: number },
  acceptedPosts: Post[],
  rejectedPosts: { post: Partial<Post>; reason: string }[],
  memory: AgentMemory
): Promise<AgentMemory> {
  const reflectionPrompt = `
あなたはSNS投稿ライターの自己改善アドバイザーです。
以下の実行結果を分析し、次回の改善点を抽出してください。

# 今回の実行結果
- 生成: ${stats.generated}件
- 採用: ${stats.accepted}件
- 品質NG: ${stats.rejectedByQuality}件
- 類似NG: ${stats.rejectedBySimilarity}件
- ローテNG: ${stats.rejectedByRotation}件

# 採用された投稿のパターンとスコア
${acceptedPosts.map((p) => `- ${p.pattern} (${p.theme}): スコア${p.qualityScore?.average ?? "N/A"}`).join("\n") || "（なし）"}

# 棄却された投稿の理由
${rejectedPosts.slice(0, 5).map((r) => `- ${r.reason}`).join("\n") || "（なし）"}

# 現在の学び
${memory.learnings.map((l) => `- [${l.category}] ${l.insight} (id: ${l.id})`).join("\n") || "（まだなし）"}

# 指示
1. 今回の結果から得られる具体的な学びを1〜3件抽出してください
2. 既存の学びの中で、今回の結果で確信度が上下したものがあれば指摘してください
3. 次回の投稿生成で具体的に改善すべき点を述べてください

JSON形式で出力:
{
  "newLearnings": [
    {
      "category": "quality|pattern|theme|process",
      "insight": "具体的な学び",
      "confidence": 0.7,
      "evidence": "根拠となる今回のデータ"
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
      systemPrompt: "あなたはSNS投稿の品質改善アドバイザーです。データに基づいた具体的な改善提案をしてください。",
      model: "opus",
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
    memory.stats.successfulRuns = (memory.stats.successfulRuns || 0) + (stats.accepted > 0 ? 1 : 0);

    return pruneMemory(memory);
  } catch (e) {
    log(`[ライター] 振り返りでエラー（スキップ）: ${e instanceof Error ? e.message : String(e)}`);
    return memory;
  }
}

main().catch((e) => {
  log(`Writer エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
