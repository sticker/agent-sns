import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { ResearcherAgent } from "./agents/researcher";
import { AnalystAgent } from "./agents/analyst";
import { WriterAgent } from "./agents/writer";
import { PosterAgent } from "./agents/poster";
import { FetcherAgent } from "./agents/fetcher";
import { SupervisorAgent } from "./agents/supervisor";
import type {
  AnalystInsight,
  PipelineResult,
  Post,
  PostMetrics,
  ResearchItem,
  SystemState,
  ThemeNode,
  AgentRole,
  ScheduleConfig,
  TimeSlot,
} from "./types";
import { MAX_DAILY_POSTS } from "./types";

// ============================================================
// Pipeline — 全エージェントのオーケストレーション
// ============================================================
// 実行順序:
//   1. フェッチャー  → 昨日の投稿メトリクスを取得
//   2. アナリスト    → パフォーマンス分析 + ライターへの指示書
//   3. リサーチャー  → 不足テーマのネタ補充
//   4. ライター      → 投稿バッチ生成（品質チェック込み）
//   5. スーパーバイザー → 全体の健全性チェック
//   ※ ポスターはcronで別途実行（投稿キューから取り出し）
// ============================================================

// --- パス解決（import.meta.dirで絶対パスを使用） ---
const PROJECT_ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const CONFIG_DIR = join(PROJECT_ROOT, "config");
const KNOWLEDGE_DIR = join(PROJECT_ROOT, "knowledge");

// データファイルパス
const PATHS = {
  posts: join(DATA_DIR, "history", "posts.json"),
  metrics: join(DATA_DIR, "metrics", "metrics.json"),
  queue: join(DATA_DIR, "queue", "queue.json"),
  research: join(DATA_DIR, "research_items.json"),
  insights: join(DATA_DIR, "insights.json"),
  state: join(DATA_DIR, "system_state.json"),
  config: join(CONFIG_DIR, "system.json"),
  persona: join(KNOWLEDGE_DIR, "persona", "ai_tech.json"),
  patterns: join(KNOWLEDGE_DIR, "patterns", "post_patterns.json"),
  themes: join(KNOWLEDGE_DIR, "themes", "ai_tech_tree.json"),
};

// --- dry-runフラグ ---
const DRY_RUN = process.argv.includes("--dry-run");

// --- ファイルベースロガー ---

function getLogFilePath(): string {
  const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const logDir = join(DATA_DIR, "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  return join(logDir, `pipeline_${today}.log`);
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  try {
    appendFileSync(getLogFilePath(), line + "\n");
  } catch {
    // ログ書き込み失敗は無視（パイプラインを止めない）
  }
}

// --- ユーティリティ ---

function loadJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function saveJSON(path: string, data: unknown): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// --- データ整理 ---

function pruneData(): void {
  log("データ整理を実行中...");

  // research_items.json: usedCount > 2 かつ 30日以上前のアイテムを削除
  const researchItems = loadJSON<ResearchItem[]>(PATHS.research, []);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const prunedResearch = researchItems.filter((item) => {
    if (item.usedCount > 2 && new Date(item.collectedAt).getTime() < thirtyDaysAgo) {
      return false;
    }
    return true;
  });
  if (prunedResearch.length < researchItems.length) {
    log(`  リサーチ: ${researchItems.length - prunedResearch.length}件削除`);
    saveJSON(PATHS.research, prunedResearch);
  }

  // posts.json: 最新500件のみ保持
  const posts = loadJSON<Post[]>(PATHS.posts, []);
  if (posts.length > 500) {
    log(`  投稿履歴: ${posts.length}件 → 500件に削減`);
    saveJSON(PATHS.posts, posts.slice(-500));
  }

  // queue.json: status が "queued" でないアイテムを除去
  const queue = loadJSON<Post[]>(PATHS.queue, []);
  const prunedQueue = queue.filter((item) => item.status === "queued");
  if (prunedQueue.length < queue.length) {
    log(`  キュー: ${queue.length - prunedQueue.length}件削除`);
    saveJSON(PATHS.queue, prunedQueue);
  }
}

// --- メインパイプライン ---

async function runPipeline() {
  // isRunning チェック
  const preState = loadJSON<SystemState>(PATHS.state, {
    isRunning: false,
    killSwitch: false,
    lastRun: {} as Record<AgentRole, string>,
    errorCounts: {} as Record<AgentRole, number>,
    dailyPostCount: 0,
    todayDate: new Date().toISOString().split("T")[0],
  });

  if (preState.isRunning) {
    log("パイプラインは既に実行中です。終了します。");
    return;
  }

  // データ整理
  pruneData();

  log("=".repeat(60));
  log(`パイプライン開始: ${new Date().toISOString()}${DRY_RUN ? " [DRY-RUN]" : ""}`);
  log("=".repeat(60));

  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const result: PipelineResult = {
    errors,
    startedAt,
    completedAt: "",
  };

  // 設定とナレッジの読み込み
  const config = loadJSON<Record<string, unknown>>(PATHS.config, {});
  const persona = loadJSON<Record<string, unknown>>(PATHS.persona, {});
  const patterns = loadJSON<Record<string, unknown>>(PATHS.patterns, {});
  const themeData = loadJSON<{ themes: ThemeNode[] }>(PATHS.themes, {
    themes: [],
  });

  // 既存データの読み込み
  const allPosts = loadJSON<Post[]>(PATHS.posts, []);
  const allMetrics = loadJSON<PostMetrics[]>(PATHS.metrics, []);
  const researchItems = loadJSON<ResearchItem[]>(PATHS.research, []);
  const previousInsights = loadJSON<AnalystInsight[]>(PATHS.insights, []);
  const queue = loadJSON<Post[]>(PATHS.queue, []);
  const systemState = loadJSON<SystemState>(PATHS.state, {
    isRunning: false,
    killSwitch: false,
    lastRun: {} as Record<AgentRole, string>,
    errorCounts: {} as Record<AgentRole, number>,
    dailyPostCount: 0,
    todayDate: new Date().toISOString().split("T")[0],
  });

  // KILL SWITCH チェック
  if (systemState.killSwitch) {
    log("KILL SWITCH が有効です。パイプラインを停止します。");
    return;
  }

  systemState.isRunning = true;
  saveJSON(PATHS.state, systemState);

  try {
    // Threads API認証情報（環境変数から取得）
    const accessToken = process.env.THREADS_ACCESS_TOKEN ?? "";
    const userId = process.env.THREADS_USER_ID ?? "";

    // ============================
    // Step 1: フェッチャー
    // ============================
    log("Step 1: フェッチャー — メトリクス取得");
    const fetcherStart = Date.now();
    const fetcher = new FetcherAgent();
    const postsNeedingMetrics = allPosts.filter(
      (p) =>
        p.status === "posted" &&
        p.threadsPostId &&
        !allMetrics.find((m) => m.postId === p.id)
    );

    if (postsNeedingMetrics.length > 0 && accessToken) {
      if (DRY_RUN) {
        log("  [DRY-RUN] Threads APIコールをスキップ");
      } else {
        result.fetcherResult = await fetcher.run({
          posts: postsNeedingMetrics,
          accessToken,
          userId,
        });
        if (result.fetcherResult.success && result.fetcherResult.data) {
          const newMetrics = (result.fetcherResult.data as { metrics: PostMetrics[] }).metrics;
          allMetrics.push(...newMetrics);
          saveJSON(PATHS.metrics, allMetrics);
        }
      }
    } else {
      log("  メトリクス取得対象なし。スキップ。");
    }
    log(`  フェッチャー完了: ${Date.now() - fetcherStart}ms`);

    // ============================
    // Step 2: アナリスト
    // ============================
    log("Step 2: アナリスト — パフォーマンス分析");
    const analystStart = Date.now();
    const analyst = new AnalystAgent();
    result.analystResult = await analyst.run({
      posts: allPosts.filter((p) => p.status === "posted"),
      metrics: allMetrics,
      previousInsights,
    });

    let currentInsight: AnalystInsight;
    if (result.analystResult.success) {
      currentInsight = result.analystResult.data as AnalystInsight;
      previousInsights.unshift(currentInsight);
      saveJSON(PATHS.insights, previousInsights.slice(0, 10)); // 直近10件保持
      log(`  アナリスト成功: ${Date.now() - analystStart}ms`);
    } else {
      errors.push(`アナリスト失敗: ${result.analystResult.error}`);
      currentInsight = previousInsights[0] ?? ({} as AnalystInsight);
      log(`  アナリスト失敗: ${result.analystResult.error} (${Date.now() - analystStart}ms)`);
    }

    // ============================
    // Step 3: リサーチャー
    // ============================
    log("Step 3: リサーチャー — ネタ収集");
    const researcherStart = Date.now();
    const researcher = new ResearcherAgent();
    result.researcherResult = await researcher.run({
      themeTree: themeData.themes,
      existingItems: researchItems,
      postHistory: allPosts.map((p) => ({
        theme: p.theme,
        subTheme: p.subTheme,
      })),
    });

    if (result.researcherResult.success) {
      const newItems = (result.researcherResult.data as { newItems: ResearchItem[] }).newItems;
      researchItems.push(...newItems);
      saveJSON(PATHS.research, researchItems);
      log(`  リサーチャー成功: ${newItems.length}件追加 (${Date.now() - researcherStart}ms)`);
    } else {
      errors.push(`リサーチャー失敗: ${result.researcherResult.error}`);
      log(`  リサーチャー失敗: ${result.researcherResult.error} (${Date.now() - researcherStart}ms)`);
    }

    // ============================
    // Step 4: ライター
    // ============================
    log("Step 4: ライター — 投稿生成");
    const writerStart = Date.now();
    const writer = new WriterAgent();
    const batchSize = (config as { pipeline?: { writerBatchSize?: number } })
      .pipeline?.writerBatchSize ?? 10;

    result.writerResult = await writer.run({
      researchItems: researchItems.filter((r) => r.usedCount === 0),
      analystInsight: currentInsight,
      recentPosts: allPosts.slice(-100),
      persona,
      patterns,
      batchSize,
    });

    if (result.writerResult.success) {
      const writerOutput = result.writerResult.data as { posts: Post[] };
      const newPosts = writerOutput.posts;

      // キューに追加
      queue.push(...newPosts);
      saveJSON(PATHS.queue, queue);

      // 投稿履歴に追加
      allPosts.push(...newPosts);
      saveJSON(PATHS.posts, allPosts);
      log(`  ライター成功: ${newPosts.length}件生成 (${Date.now() - writerStart}ms)`);
    } else {
      errors.push(`ライター失敗: ${result.writerResult.error}`);
      log(`  ライター失敗: ${result.writerResult.error} (${Date.now() - writerStart}ms)`);
    }

    // ============================
    // Step 5: スーパーバイザー
    // ============================
    log("Step 5: スーパーバイザー — 監視チェック");
    const supervisorStart = Date.now();
    result.completedAt = new Date().toISOString();
    const supervisor = new SupervisorAgent();
    const supervisorResult = await supervisor.run({
      pipelineResult: result,
      systemState,
      stateFilePath: PATHS.state,
    });

    if (supervisorResult.success) {
      const output = supervisorResult.data as {
        status: string;
        alerts: unknown[];
        updatedState: SystemState;
      };
      saveJSON(PATHS.state, output.updatedState);

      if (output.status === "critical" || output.status === "killed") {
        log(`スーパーバイザー: ${output.status.toUpperCase()}`);
      }
    }
    log(`  スーパーバイザー完了: ${Date.now() - supervisorStart}ms`);

    // ============================
    // 完了サマリー
    // ============================
    const elapsed = Date.now() - new Date(startedAt).getTime();
    log("=".repeat(60));
    log("パイプライン完了");
    log(`   所要時間: ${(elapsed / 1000).toFixed(1)}秒`);
    log(`   エラー: ${errors.length}件`);
    log(`   キュー内投稿数: ${queue.length}件`);
    log("=".repeat(60));
  } finally {
    // isRunning を必ず解除する
    const finalState = loadJSON<SystemState>(PATHS.state, systemState);
    finalState.isRunning = false;
    saveJSON(PATHS.state, finalState);
  }
}

// --- postコマンド: キューから1件投稿 ---

async function runPost() {
  log(`ポスター開始: ${new Date().toISOString()}${DRY_RUN ? " [DRY-RUN]" : ""}`);

  // データ読み込み
  const systemState = loadJSON<SystemState>(PATHS.state, {
    isRunning: false,
    killSwitch: false,
    lastRun: {} as Record<AgentRole, string>,
    errorCounts: {} as Record<AgentRole, number>,
    dailyPostCount: 0,
    todayDate: new Date().toISOString().split("T")[0],
  });
  const queue = loadJSON<Post[]>(PATHS.queue, []);
  const allPosts = loadJSON<Post[]>(PATHS.posts, []);
  const config = loadJSON<{ schedule?: ScheduleConfig }>(PATHS.config, {});

  // キルスイッチチェック
  if (systemState.killSwitch) {
    log("KILL SWITCH が有効です。投稿を中止します。");
    return;
  }

  // 日付リセット（日付が変わっていたらカウントをリセット）
  const today = new Date().toISOString().split("T")[0];
  if (systemState.todayDate !== today) {
    systemState.dailyPostCount = 0;
    systemState.todayDate = today;
  }

  // 日次投稿上限チェック
  if (systemState.dailyPostCount >= MAX_DAILY_POSTS) {
    log(`日次投稿上限に達しています (${systemState.dailyPostCount}/${MAX_DAILY_POSTS})。スキップ。`);
    return;
  }

  // スケジュールスロット確認
  const schedule = config.schedule;
  if (schedule && schedule.slots.length > 0) {
    const now = new Date();
    // タイムゾーン対応: 設定のタイムゾーンでの現在時刻を取得
    const tz = schedule.timezone || "Asia/Tokyo";
    const nowInTz = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const currentMinutes = nowInTz.getHours() * 60 + nowInTz.getMinutes();

    // 現在時刻に最も近いスロット（現在時刻以降で最初、またはちょうどのスロット）を探す
    const slotMinutes = schedule.slots.map((s: TimeSlot) => s.hour * 60 + s.minute);
    const tolerance = 15; // 15分の許容範囲

    const isNearSlot = slotMinutes.some(
      (sm: number) => Math.abs(currentMinutes - sm) <= tolerance
    );

    if (!isNearSlot) {
      log(`現在時刻はスケジュールスロットの範囲外です。スキップ。`);
      return;
    }
  }

  // キューから "queued" ステータスの投稿を1件取得
  const nextPost = queue.find((p) => p.status === "queued");
  if (!nextPost) {
    log("キューに投稿可能なアイテムがありません。");
    return;
  }

  log(`投稿対象: ${nextPost.id} — ${nextPost.hook.substring(0, 40)}...`);

  if (DRY_RUN) {
    // dry-runモード: APIコールをスキップ
    log("[DRY-RUN] Threads APIへの投稿をスキップします。");
    log(`[DRY-RUN] 投稿内容: ${nextPost.content.substring(0, 100)}...`);
  } else {
    // PosterAgentで投稿実行
    const accessToken = process.env.THREADS_ACCESS_TOKEN ?? "";
    const userId = process.env.THREADS_USER_ID ?? "";

    if (!accessToken || !userId) {
      log("エラー: THREADS_ACCESS_TOKEN または THREADS_USER_ID が設定されていません。");
      return;
    }

    const poster = new PosterAgent();
    const schedule = config.schedule ?? {
      slots: [],
      timezone: "Asia/Tokyo",
      maxPostsPerDay: MAX_DAILY_POSTS,
      minIntervalMinutes: 60,
    };
    const posterResult = await poster.run({
      posts: [nextPost],
      schedule,
      accessToken,
      userId,
    });

    if (!posterResult.success) {
      log(`投稿失敗: ${posterResult.error}`);
      return;
    }

    // 投稿IDを保存
    const posterData = posterResult.data as {
      posted: { postId: string; threadsPostId: string }[];
      failed: { postId: string; error: string }[];
    };
    if (posterData.failed.length > 0) {
      log(`投稿失敗: ${posterData.failed[0].error}`);
      return;
    }
    if (posterData.posted.length > 0) {
      nextPost.threadsPostId = posterData.posted[0].threadsPostId;
    }
  }

  // 投稿ステータス更新
  nextPost.status = "posted";
  nextPost.postedAt = new Date().toISOString();

  // posts.json を更新
  const postIndex = allPosts.findIndex((p) => p.id === nextPost.id);
  if (postIndex >= 0) {
    allPosts[postIndex] = nextPost;
  } else {
    allPosts.push(nextPost);
  }
  saveJSON(PATHS.posts, allPosts);

  // queue.json から削除
  const updatedQueue = queue.filter((p) => p.id !== nextPost.id);
  saveJSON(PATHS.queue, updatedQueue);

  // dailyPostCount を更新
  systemState.dailyPostCount += 1;
  saveJSON(PATHS.state, systemState);

  log(`投稿完了: ${nextPost.id} (本日 ${systemState.dailyPostCount}/${MAX_DAILY_POSTS}件目)`);
}

// --- エントリーポイント ---

const command = process.argv[2];

switch (command) {
  case "kill":
    SupervisorAgent.activateKillSwitch(PATHS.state);
    break;
  case "post":
    runPost().catch((e) => {
      log(`Fatal post error: ${e}`);
      process.exit(1);
    });
    break;
  default:
    runPipeline().catch((e) => {
      console.error("Fatal pipeline error:", e);
      process.exit(1);
    });
}
