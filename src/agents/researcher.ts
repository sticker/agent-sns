// ============================================================
// Researcher Agent — テーマツリーに基づくリサーチアイテム生成
// ============================================================
// 独立実行スクリプト。claude -p 経由でLLM呼び出し。
// テーマツリーから手薄なテーマを特定し、10〜15件のネタを生成。
// ============================================================

import { callLLMJSON } from "../core/llm";
import {
  log,
  loadState,
  saveState,
  loadThemes,
  loadResearch,
  loadPosts,
  loadPersona,
  saveJSON,
  PATHS,
} from "../core/store";
import type { ResearchItem, ThemeNode } from "../types";

// --- テーマツリーをフラット化 ---

interface FlatTheme {
  id: string;
  name: string;
  description: string;
  parentName?: string;
  priority: number;
}

function flattenThemes(nodes: ThemeNode[], parentName?: string): FlatTheme[] {
  const result: FlatTheme[] = [];
  for (const node of nodes) {
    result.push({
      id: node.id,
      name: node.name,
      description: node.description,
      parentName,
      priority: node.priority,
    });
    if (node.children?.length) {
      result.push(...flattenThemes(node.children, node.name));
    }
  }
  return result;
}

// --- テーマ別カウント集計（投稿履歴 + 既存リサーチ） ---

function countByTheme(
  posts: { theme: string }[],
  research: { theme: string }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of posts) {
    counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
  }
  for (const r of research) {
    counts.set(r.theme, (counts.get(r.theme) ?? 0) + 1);
  }
  return counts;
}

// --- LLM応答の型 ---

interface ResearchLLMItem {
  source: string;
  sourceUrl: string;
  title: string;
  summary: string;
  keyInsights: string[];
  theme: string;
  subTheme: string;
  quality: number;
}

// --- メイン ---

async function main() {
  log("Researcher 開始");
  const startTime = Date.now();

  const state = loadState();
  if (state.killSwitch) {
    log("KILL SWITCH 有効。中止。");
    return;
  }

  // データ読み込み
  const themes = loadThemes();
  const existingResearch = loadResearch();
  const posts = loadPosts();
  const persona = loadPersona();

  // ペルソナからジャンル名を動的取得
  const account = persona.account as
    | { name?: string; genre?: string }
    | undefined;
  const genreName = account?.name ?? "AI・テック系";

  // テーマをフラット化し、カウント集計
  const flatThemes = flattenThemes(themes);
  const themeCounts = countByTheme(posts, existingResearch);

  // カウントが少ない順にソートし、優先度を加味
  const sortedThemes = [...flatThemes].sort((a, b) => {
    const countA = themeCounts.get(a.id) ?? 0;
    const countB = themeCounts.get(b.id) ?? 0;
    // カウントが少なく、優先度が高いものを先に
    return countA - countB || b.priority - a.priority;
  });

  // 上位テーマ（手薄なテーマ）を抽出
  const underservedThemes = sortedThemes.slice(0, 15);

  // テーマ情報をプロンプト用にフォーマット
  const themeList = underservedThemes
    .map((t) => {
      const count = themeCounts.get(t.id) ?? 0;
      const parent = t.parentName ? `（${t.parentName}）` : "";
      return `- ${t.name}${parent}: ${t.description} [既存${count}件, 優先度${t.priority}]`;
    })
    .join("\n");

  // 既存リサーチのタイトル一覧（重複回避用）
  const existingTitles = existingResearch
    .slice(-50)
    .map((r) => r.title)
    .join("\n");

  // システムプロンプト（ジャンル名を動的に埋め込み）
  const systemPrompt = `あなたは「${genreName}」ジャンルの専門リサーチャーです。
SNS投稿のネタになるリサーチアイテムを生成してください。

## 要件
- 各アイテムは具体的で、実際の投稿に使える情報量があること
- sourceはリアルなWebサイト名、sourceUrlは存在しうるURL形式
- keyInsightsは2〜4個、それぞれ1文で簡潔に
- qualityは1〜10のスコア（7以上を推奨）
- theme/subThemeはテーマツリーのidを使用
- 既存タイトルと重複しないこと

## 出力形式
JSON配列を返してください:
[
  {
    "source": "サイト名",
    "sourceUrl": "https://...",
    "title": "タイトル",
    "summary": "要約（2〜3文）",
    "keyInsights": ["ポイント1", "ポイント2"],
    "theme": "theme_id",
    "subTheme": "sub_theme_id",
    "quality": 8
  }
]`;

  const userPrompt = `以下のテーマについて、10〜15件のリサーチアイテムを生成してください。
手薄なテーマを優先し、バランスよく分散させてください。

## 対象テーマ（手薄な順）
${themeList}

## 既存リサーチタイトル（重複回避）
${existingTitles || "（なし）"}

## 現在の日付
${new Date().toISOString().split("T")[0]}

JSON配列のみを返してください。`;

  log(`手薄テーマ${underservedThemes.length}件を対象にリサーチ生成`);

  const items = await callLLMJSON<ResearchLLMItem[]>(userPrompt, {
    systemPrompt,
    model: "sonnet",
  });

  if (!Array.isArray(items) || items.length === 0) {
    log("LLMからリサーチアイテムを取得できませんでした");
    return;
  }

  // IDとタイムスタンプを付与して保存形式に変換
  const now = new Date().toISOString();
  const newItems: ResearchItem[] = items.map((item, i) => ({
    id: `research_${Date.now()}_${i}`,
    source: item.source,
    sourceUrl: item.sourceUrl,
    title: item.title,
    summary: item.summary,
    keyInsights: item.keyInsights ?? [],
    theme: item.theme,
    subTheme: item.subTheme ?? "",
    usedCount: 0,
    quality: item.quality ?? 7,
    collectedAt: now,
  }));

  // 既存データとマージして保存
  const merged = [...existingResearch, ...newItems];
  saveJSON(PATHS.research, merged);

  log(`リサーチアイテム${newItems.length}件を追加（合計${merged.length}件）`);

  // ステート更新
  state.lastRun.researcher = new Date().toISOString();
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Researcher 完了 (${elapsed}秒)`);
}

main().catch((e) => {
  log(`Researcher エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
