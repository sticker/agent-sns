// ============================================================
// Store — データ永続化 + パス解決 + ログ
// ============================================================

import { join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  unlinkSync,
} from "fs";
import type {
  SystemState,
  AgentRole,
  Post,
  PostMetrics,
  ResearchItem,
  AnalystInsight,
  ThemeNode,
  ScheduleConfig,
} from "../types";

// --- パス解決（import.meta.dir 基準で絶対パス） ---

export const PROJECT_ROOT = join(import.meta.dir, "../..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const CONFIG_DIR = join(PROJECT_ROOT, "config");
export const KNOWLEDGE_DIR = join(PROJECT_ROOT, "knowledge");
const LOG_DIR = join(DATA_DIR, "logs");

export const PATHS = {
  posts: join(DATA_DIR, "history", "posts.json"),
  metrics: join(DATA_DIR, "metrics", "metrics.json"),
  queue: join(DATA_DIR, "queue", "queue.json"),
  research: join(DATA_DIR, "research_items.json"),
  insights: join(DATA_DIR, "insights.json"),
  state: join(DATA_DIR, "system_state.json"),
  config: join(CONFIG_DIR, "system.json"),
  persona: join(KNOWLEDGE_DIR, "persona", "life_hack.json"),
  patterns: join(KNOWLEDGE_DIR, "patterns", "post_patterns.json"),
  themes: join(KNOWLEDGE_DIR, "themes", "life_hack_tree.json"),
} as const;

// --- 簡易ファイルロック（同時書き込み防止） ---

function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 5000): T {
  const lockFile = lockPath + ".lock";
  const start = Date.now();

  // ロック取得を試みる
  while (existsSync(lockFile)) {
    // ロックファイルが古い場合（30秒以上）は強制解除
    try {
      const lockTime = parseInt(readFileSync(lockFile, "utf-8"), 10);
      if (Date.now() - lockTime > 30000) {
        unlinkSync(lockFile);
        break;
      }
    } catch {
      break; // ロックファイル読み取り失敗 → 再試行
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ファイルロックタイムアウト: ${lockPath}`);
    }
    // 50ms待機
    Bun.sleepSync(50);
  }

  // ロック取得
  writeFileSync(lockFile, String(Date.now()));
  try {
    return fn();
  } finally {
    try { unlinkSync(lockFile); } catch {}
  }
}

// --- 汎用JSON読み書き ---

export function loadJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (e) {
    console.error(`JSONパースエラー (${path}): ${(e as Error).message}`);
    return fallback;
  }
}

export function saveJSON(path: string, data: unknown): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLock(path, () => {
    writeFileSync(path, JSON.stringify(data, null, 2));
  });
}

// --- 型付きデータアクセス ---

export function loadPosts(): Post[] {
  return loadJSON<Post[]>(PATHS.posts, []);
}

export function loadMetrics(): PostMetrics[] {
  return loadJSON<PostMetrics[]>(PATHS.metrics, []);
}

export function loadQueue(): Post[] {
  return loadJSON<Post[]>(PATHS.queue, []);
}

export function loadResearch(): ResearchItem[] {
  return loadJSON<ResearchItem[]>(PATHS.research, []);
}

export function loadInsights(): AnalystInsight[] {
  return loadJSON<AnalystInsight[]>(PATHS.insights, []);
}

export function loadThemes(): ThemeNode[] {
  const data = loadJSON<{ themes: ThemeNode[] }>(PATHS.themes, { themes: [] });
  return data.themes;
}

export function loadConfig(): Record<string, unknown> {
  return loadJSON<Record<string, unknown>>(PATHS.config, {});
}

export function loadSchedule(): ScheduleConfig {
  const config = loadConfig() as { schedule?: ScheduleConfig };
  return config.schedule ?? {
    slots: [],
    timezone: "Asia/Tokyo",
    maxPostsPerDay: 10,
    minIntervalMinutes: 60,
  };
}

export function loadPersona(): Record<string, unknown> {
  return loadJSON<Record<string, unknown>>(PATHS.persona, {});
}

export function loadPatterns(): Record<string, unknown> {
  return loadJSON<Record<string, unknown>>(PATHS.patterns, {});
}

export function loadState(): SystemState {
  return loadJSON<SystemState>(PATHS.state, {
    isRunning: false,
    killSwitch: false,
    lastRun: {} as Record<AgentRole, string>,
    errorCounts: {} as Record<AgentRole, number>,
    dailyPostCount: 0,
    todayDate: new Date().toISOString().split("T")[0],
  });
}

export function saveState(state: SystemState): void {
  saveJSON(PATHS.state, state);
}

// --- ログ ---

export function log(message: string): void {
  const now = new Date();
  const line = `[${now.toISOString()}] ${message}`;
  console.log(line);

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const dateStr = now.toISOString().split("T")[0].replace(/-/g, "");
  const logFile = join(LOG_DIR, `agent_${dateStr}.log`);
  appendFileSync(logFile, line + "\n");
}

// --- データ整理 ---

export function pruneData(): void {
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // research_items: usedCount > 2 かつ 30日以上前を削除
  const research = loadResearch();
  const prunedResearch = research.filter((r) => {
    if (r.usedCount > 2 && now - new Date(r.collectedAt).getTime() > thirtyDaysMs) {
      return false;
    }
    return true;
  });
  if (prunedResearch.length < research.length) {
    saveJSON(PATHS.research, prunedResearch);
    log(`リサーチデータ整理: ${research.length} → ${prunedResearch.length}件`);
  }

  // posts: 直近500件のみ保持
  const posts = loadPosts();
  if (posts.length > 500) {
    saveJSON(PATHS.posts, posts.slice(-500));
    log(`投稿履歴整理: ${posts.length} → 500件`);
  }

  // queue: queued 以外を除去
  const queue = loadQueue();
  const prunedQueue = queue.filter((p) => p.status === "queued" || p.status === "draft");
  if (prunedQueue.length < queue.length) {
    saveJSON(PATHS.queue, prunedQueue);
    log(`キュー整理: ${queue.length} → ${prunedQueue.length}件`);
  }
}
