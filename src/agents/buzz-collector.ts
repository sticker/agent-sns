// ============================================================
// Buzz Collector — バズ投稿を収集して口調を分析
// ============================================================
// Threads APIのキーワード検索でライフハック系のバズ投稿を取得し、
// LLMで口調・言い回しの特徴を分析してナレッジに保存する。
// ============================================================

import { callLLMJSON } from "../core/llm";
import { log, loadJSON, saveJSON, PATHS, DATA_DIR } from "../core/store";
import { join } from "path";

const THREADS_API = "https://graph.threads.net/v1.0";
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN ?? "";
const USER_ID = process.env.THREADS_USER_ID ?? "";

// 収集した投稿の保存先
const BUZZ_DATA_PATH = join(DATA_DIR, "buzz_posts.json");

// 分析結果の保存先（ライターが参照する）
const TONE_ANALYSIS_PATH = join(DATA_DIR, "tone_analysis.json");

// --- 検索キーワード ---

const SEARCH_KEYWORDS = [
  "時短料理",
  "作り置き",
  "節約 固定費",
  "掃除 ルーティン",
  "100均 便利",
  "一人暮らし コツ",
  "睡眠 質",
  "デスク環境",
  "ライフハック",
  "生活 便利",
  "買ってよかった",
  "やめてよかった",
];

// --- 型定義 ---

interface ThreadsPost {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  like_count?: number;
  reply_count?: number;
  repost_count?: number;
  quote_count?: number;
}

interface BuzzPost {
  id: string;
  text: string;
  timestamp: string;
  username: string;
  likes: number;
  replies: number;
  reposts: number;
  keyword: string;
  collectedAt: string;
}

interface ToneAnalysis {
  analyzedAt: string;
  postCount: number;
  sourceUser?: string;
  toneFeatures: string[];
  hookPatterns: string[];
  expressions: string[];
  rhythmNotes: string[];
  examplePosts: string[];
}

// --- Threads API 検索 ---

async function searchPosts(keyword: string): Promise<ThreadsPost[]> {
  const fields = "id,text,timestamp,username,like_count,reply_count,repost_count,quote_count";
  const url = `${THREADS_API}/keyword_search?q=${encodeURIComponent(keyword)}&search_type=TOP&fields=${fields}&limit=25&access_token=${ACCESS_TOKEN}`;

  const res = await fetch(url);

  if (res.status === 429) {
    log(`検索レート制限: "${keyword}" をスキップ`);
    return [];
  }

  if (!res.ok) {
    const body = await res.text();
    log(`検索エラー (${res.status}): ${body.slice(0, 200)}`);
    return [];
  }

  const json = (await res.json()) as { data?: ThreadsPost[] };
  return json.data ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- メイン ---

async function main() {
  log("Buzz Collector 開始");

  if (!ACCESS_TOKEN || !USER_ID) {
    throw new Error("THREADS_ACCESS_TOKEN / THREADS_USER_ID が未設定");
  }

  // 既存データ読み込み
  const existingPosts = loadJSON<BuzzPost[]>(BUZZ_DATA_PATH, []);
  const existingIds = new Set(existingPosts.map((p) => p.id));

  const newPosts: BuzzPost[] = [];

  // 各キーワードで検索
  for (const keyword of SEARCH_KEYWORDS) {
    log(`検索中: "${keyword}"`);

    const posts = await searchPosts(keyword);

    for (const post of posts) {
      // 既に収集済みならスキップ
      if (existingIds.has(post.id)) continue;
      // テキストがないものはスキップ
      if (!post.text || post.text.length < 30) continue;

      const likes = post.like_count ?? 0;
      const replies = post.reply_count ?? 0;
      const reposts = post.repost_count ?? 0;

      // バズ判定: いいね10以上 or リプ+リポスト5以上
      if (likes >= 10 || (replies + reposts) >= 5) {
        newPosts.push({
          id: post.id,
          text: post.text,
          timestamp: post.timestamp,
          username: post.username ?? "unknown",
          likes,
          replies,
          reposts,
          keyword,
          collectedAt: new Date().toISOString(),
        });
        existingIds.add(post.id);
      }
    }

    // レート制限対策: リクエスト間隔 1秒
    await sleep(1000);
  }

  if (newPosts.length === 0) {
    log("新規バズ投稿なし");
  } else {
    // エンゲージメント順にソートして保存
    const allPosts = [...existingPosts, ...newPosts]
      .sort((a, b) => (b.likes + b.reposts) - (a.likes + a.reposts))
      .slice(0, 200); // 上位200件を保持

    saveJSON(BUZZ_DATA_PATH, allPosts);
    log(`新規バズ投稿${newPosts.length}件を収集（合計${allPosts.length}件）`);
  }

  // --- 投稿者別集計 ---

  const allPosts = loadJSON<BuzzPost[]>(BUZZ_DATA_PATH, []);

  if (allPosts.length < 5) {
    log("分析にはバズ投稿が5件以上必要です");
    log("Buzz Collector 完了");
    return;
  }

  // ユーザー別に投稿を集計
  const byUser = new Map<string, BuzzPost[]>();
  for (const post of allPosts) {
    if (post.username === "unknown") continue;
    const existing = byUser.get(post.username) ?? [];
    existing.push(post);
    byUser.set(post.username, existing);
  }

  // 投稿数2件以上 & 合計エンゲージメント順にソート
  const userRanking = [...byUser.entries()]
    .filter(([, posts]) => posts.length >= 2)
    .map(([username, posts]) => ({
      username,
      postCount: posts.length,
      totalLikes: posts.reduce((s, p) => s + p.likes, 0),
      totalReposts: posts.reduce((s, p) => s + p.reposts, 0),
      avgLikes: Math.round(posts.reduce((s, p) => s + p.likes, 0) / posts.length),
      posts,
    }))
    .sort((a, b) => b.totalLikes - a.totalLikes);

  log(`\n===== バズ投稿者ランキング（${userRanking.length}人） =====`);
  for (const user of userRanking.slice(0, 15)) {
    log(`\n@${user.username}（投稿${user.postCount}件, 平均❤️${user.avgLikes}）`);
    // 上位2投稿をプレビュー
    for (const post of user.posts.slice(0, 2)) {
      const preview = post.text.replace(/\n/g, " ").slice(0, 80);
      log(`  ❤️${post.likes} | ${preview}...`);
    }
  }

  // CLI引数で特定ユーザーの口調分析モード
  const targetUser = process.argv[2];

  if (targetUser) {
    await analyzeSingleUser(targetUser, allPosts);
  } else {
    log(`\n口調分析するには: bun run agent:buzz <ユーザー名>`);
    log("上記ランキングから気になるユーザー名を指定してください");
  }

  log("\nBuzz Collector 完了");
}

// --- 特定ユーザーの口調を分析 ---

async function analyzeSingleUser(targetUser: string, allPosts: BuzzPost[]) {
  const userPosts = allPosts.filter((p) => p.username === targetUser);

  if (userPosts.length === 0) {
    log(`@${targetUser} の投稿が見つかりません`);
    return;
  }

  log(`\n@${targetUser} の投稿${userPosts.length}件を口調分析中...`);

  const analysisPrompt = `以下はThreadsの@${targetUser}というユーザーの投稿です。
この人の口調・言い回し・テンポを徹底的に分析してください。
この人の口調を完コピして別の話題で投稿を書けるレベルまで特徴を抽出してください。

# @${targetUser}の投稿
${userPosts.map((p, i) => `--- 投稿${i + 1}（❤️${p.likes} 💬${p.replies} 🔁${p.reposts}）---\n${p.text}`).join("\n\n")}

# 分析してほしいこと
1. toneFeatures: 口調の特徴（5〜8個）。語尾の癖、一人称、呼びかけ方、距離感、敬語/タメ口のバランス。具体的に「〜なんよ」「〜してみて」のように実際の語尾を抽出
2. hookPatterns: 冒頭の引き込み方のパターン（5〜8個）。この人がよくやる書き出しの型
3. expressions: この人特有の言い回し・フレーズ（8〜12個）。実際の表現をそのまま抽出
4. rhythmNotes: 文のリズム・テンポの特徴（3〜5個）。1文の長さ、改行の癖、句読点の使い方、箇条書きの使い方
5. examplePosts: 特にこの人らしさが出ている投稿を5本、そのまま抜粋

JSON形式で出力:
{
  "toneFeatures": ["特徴1", "特徴2", ...],
  "hookPatterns": ["パターン1", "パターン2", ...],
  "expressions": ["フレーズ1", "フレーズ2", ...],
  "rhythmNotes": ["特徴1", "特徴2", ...],
  "examplePosts": ["投稿本文1", "投稿本文2", ...]
}`;

  const analysis = await callLLMJSON<Omit<ToneAnalysis, "analyzedAt" | "postCount" | "sourceUser">>(
    analysisPrompt,
    {
      systemPrompt: "あなたはSNSの文体分析の専門家です。特定の人物の口調・クセ・リズムを完全に再現できるレベルで分析してください。抽象的な説明ではなく、具体的な語尾・表現・構造を抽出すること。",
      model: "opus",
    }
  );

  const toneAnalysis: ToneAnalysis = {
    analyzedAt: new Date().toISOString(),
    postCount: userPosts.length,
    sourceUser: targetUser,
    toneFeatures: analysis.toneFeatures ?? [],
    hookPatterns: analysis.hookPatterns ?? [],
    expressions: analysis.expressions ?? [],
    rhythmNotes: analysis.rhythmNotes ?? [],
    examplePosts: analysis.examplePosts ?? [],
  };

  saveJSON(TONE_ANALYSIS_PATH, toneAnalysis);

  log(`\n@${targetUser} の口調分析完了:`);
  log(`  口調の特徴: ${toneAnalysis.toneFeatures.length}件`);
  for (const f of toneAnalysis.toneFeatures) log(`    - ${f}`);
  log(`  フックパターン: ${toneAnalysis.hookPatterns.length}件`);
  for (const p of toneAnalysis.hookPatterns) log(`    - ${p}`);
  log(`  頻出表現: ${toneAnalysis.expressions.length}件`);
  for (const e of toneAnalysis.expressions) log(`    - ${e}`);
  log(`  リズム・テンポ: ${toneAnalysis.rhythmNotes.length}件`);
  for (const r of toneAnalysis.rhythmNotes) log(`    - ${r}`);
  log(`\n→ data/tone_analysis.json に保存しました`);
  log(`→ 次回の bun run agent:write で自動的に反映されます`);
}

main().catch((e) => {
  log(`Buzz Collector エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
