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
import {
  loadMemory,
  saveMemory,
  formatMemoryForPrompt,
  pruneMemory,
  type AgentMemory,
} from "../core/memory";
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

  // メモリ読み込み（自己改善ループ）
  const memory = loadMemory("researcher");
  memory.stats.totalRuns++;
  memory.stats.lastRunAt = new Date().toISOString();

  // メモリをプロンプト注入用に変換
  const memoryContext = formatMemoryForPrompt(memory);

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
${memoryContext}

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

  // 振り返り: リサーチの質と活用状況を分析
  const updatedMemory = await reflectResearcher(newItems, existingResearch, posts, memory);
  saveMemory("researcher", updatedMemory);

  // ステート更新
  state.lastRun.researcher = new Date().toISOString();
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Researcher 完了 (${elapsed}秒)`);
}

// --- 振り返り: リサーチアイテムの質と活用状況を分析 ---

async function reflectResearcher(
  newItems: ResearchItem[],
  existingResearch: ResearchItem[],
  posts: { theme: string; subTheme: string }[],
  memory: AgentMemory
): Promise<AgentMemory> {
  // 既存リサーチの活用状況を集計
  const usedItems = existingResearch.filter((r) => r.usedCount > 0);
  const unusedItems = existingResearch.filter((r) => r.usedCount === 0);
  const usedThemes = new Map<string, number>();
  const unusedThemes = new Map<string, number>();
  for (const item of usedItems) {
    usedThemes.set(item.theme, (usedThemes.get(item.theme) ?? 0) + 1);
  }
  for (const item of unusedItems) {
    unusedThemes.set(item.theme, (unusedThemes.get(item.theme) ?? 0) + 1);
  }

  const reflectionPrompt = `
あなたはSNSリサーチャーの自己改善アドバイザーです。
以下のリサーチ結果と活用状況を分析し、次回の改善点を抽出してください。

# 今回の生成
- 新規リサーチアイテム: ${newItems.length}件
- テーマ分布: ${[...new Set(newItems.map((i) => i.theme))].join(", ")}

# 既存リサーチの活用状況
- 活用済み: ${usedItems.length}件
- 未使用: ${unusedItems.length}件
- 活用されやすいテーマ: ${[...usedThemes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c}件)`).join(", ") || "（データなし）"}
- 活用されにくいテーマ: ${[...unusedThemes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c}件)`).join(", ") || "（データなし）"}

# 投稿で実際に使われたテーマ
${[...new Set(posts.slice(-50).map((p) => p.theme))].join(", ") || "（データなし）"}

# 現在の学び
${memory.learnings.map((l) => `- [${l.category}] ${l.insight} (id: ${l.id})`).join("\n") || "（まだなし）"}

# 指示
1. どのテーマ/タイプのリサーチが実際に活用されるか、1〜3件の学びを抽出
2. 未使用アイテムが多いテーマの原因を分析
3. リサーチアイテムの具体性・質について改善点を述べる

JSON形式で出力:
{
  "newLearnings": [
    {
      "category": "theme|quality|pattern|process",
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
      systemPrompt: "あなたはSNSリサーチの品質改善アドバイザーです。データに基づいた具体的な改善提案をしてください。",
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
    log(`[リサーチャー] 振り返りでエラー（スキップ）: ${e instanceof Error ? e.message : String(e)}`);
    return memory;
  }
}

main().catch((e) => {
  log(`Researcher エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
