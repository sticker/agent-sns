// ============================================================
// Memory — エージェント自己改善のための永続メモリシステム
// ============================================================
// 各エージェントが実行結果から学びを抽出・蓄積し、
// 次回実行時にプロンプトへ注入することで継続的に改善する。
// ============================================================

import { join } from "path";
import { loadJSON, saveJSON, DATA_DIR, log } from "./store";

export interface AgentMemory {
  agent: string;
  learnings: Learning[];       // 学んだこと
  lastReflection: string;      // 最後の振り返り日時
  stats: {
    totalRuns: number;
    successfulRuns: number;
    lastRunAt: string;
  };
}

export interface Learning {
  id: string;
  category: string;            // "quality" | "pattern" | "theme" | "process" | "accuracy"
  insight: string;             // 学んだ内容
  confidence: number;          // 確信度 0-1
  evidence: string;            // 根拠
  createdAt: string;
  appliedCount: number;        // 何回活用されたか
  effectiveScore: number;      // 活用の効果 (-1 to 1)
}

const MEMORY_DIR = join(DATA_DIR, "memory");

export function loadMemory(agent: string): AgentMemory {
  return loadJSON<AgentMemory>(join(MEMORY_DIR, `${agent}.json`), {
    agent,
    learnings: [],
    lastReflection: "",
    stats: { totalRuns: 0, successfulRuns: 0, lastRunAt: "" },
  });
}

export function saveMemory(agent: string, memory: AgentMemory): void {
  saveJSON(join(MEMORY_DIR, `${agent}.json`), memory);
}

// メモリを文字列でプロンプトに注入可能な形式に変換
export function formatMemoryForPrompt(memory: AgentMemory): string {
  if (memory.learnings.length === 0) return "";

  // confidence が高く、最新のものから最大10件
  const relevant = memory.learnings
    .filter((l) => l.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  if (relevant.length === 0) return "";

  return `\n# 過去の経験から学んだこと（必ず考慮すること）\n${relevant.map((l, i) => `${i + 1}. [${l.category}] ${l.insight} (確信度: ${(l.confidence * 100).toFixed(0)}%)`).join("\n")}`;
}

// 古い・低効果の学びを整理（最大30件保持）
export function pruneMemory(memory: AgentMemory): AgentMemory {
  if (memory.learnings.length <= 30) return memory;

  // effectiveScore が低いものから削除
  const sorted = [...memory.learnings].sort((a, b) => {
    // confidence * effectiveScore の複合スコアでソート
    const scoreA = a.confidence * Math.max(a.effectiveScore, 0.1);
    const scoreB = b.confidence * Math.max(b.effectiveScore, 0.1);
    return scoreB - scoreA;
  });

  return { ...memory, learnings: sorted.slice(0, 30) };
}
