// ============================================================
// Threads Multi-Agent System — Type Definitions
// ============================================================

// --- Agent Types ---

export type AgentRole =
  | "researcher"
  | "analyst"
  | "writer"
  | "poster"
  | "fetcher"
  | "supervisor";

export interface AgentConfig {
  role: AgentRole;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface AgentResult<T = unknown> {
  agent: AgentRole;
  success: boolean;
  data: T;
  timestamp: string;
  durationMs: number;
  error?: string;
}

// --- Post Types ---

export type PostPattern =
  | "short_statement"      // 短文完結（断言型）
  | "short_question"       // 短文完結（問いかけ型）
  | "short_exposure"       // 短文完結（暴露系）
  | "demand_check"         // 需要確認型
  | "list_3"               // リスト型（3選）
  | "list_5"               // リスト型（5選）
  | "list_7"               // リスト型（7選）
  | "comparison"           // 比較型
  | "before_after"         // ビフォーアフター型
  | "myth_busting"         // 常識破壊型
  | "comment_bait"         // コメント誘導型
  | "thread_story"         // ツリー展開型（ストーリー）
  | "thread_tips"          // ツリー展開型（Tips連投）
  | "hot_take"             // 持論展開型
  | "news_react"           // ニュースリアクション型
  | "tool_review"          // ツール紹介型（AI/テック特化）
  | "tutorial_mini";       // ミニチュートリアル型

export interface Post {
  id: string;
  content: string;
  pattern: PostPattern;
  theme: string;
  subTheme: string;
  hook: string;                    // 1行目
  qualityScore: QualityScore;
  similarityScore: number;         // 過去投稿との最大類似度
  threadParts?: string[];          // ツリー型の場合
  commentReply?: string;           // コメント誘導型の自己返信
  affiliateLink?: string;          // アフィリエイトリンク
  status: PostStatus;
  createdAt: string;
  scheduledAt?: string;
  postedAt?: string;
  threadsPostId?: string;
}

export type PostStatus =
  | "draft"
  | "queued"
  | "scheduled"
  | "posted"
  | "rejected"
  | "failed";

// --- Quality Scoring ---

export interface QualityScore {
  hookStrength: number;           // フックの強さ (0-10)
  usefulness: number;             // 有益性 (0-10)
  specificity: number;            // 具体性 (0-10)
  tempo: number;                  // テンポ感 (0-10)
  personaMatch: number;           // ペルソナ一致度 (0-10)
  uniqueness: number;             // オリジナリティ (0-10)
  emotionalTrigger: number;       // 感情トリガー (0-10)
  readability: number;            // 読みやすさ (0-10)
  ctaPower: number;               // 行動喚起力 (0-10)
  platformFit: number;            // Threads最適化度 (0-10)
  average: number;                // 平均スコア
}

export const QUALITY_THRESHOLD = 7.0;
export const SIMILARITY_THRESHOLD = 0.85;
export const MAX_CONSECUTIVE_SAME_THEME = 3;
export const MAX_DAILY_POSTS = 15;
export const MIN_POST_INTERVAL_MINUTES = 60;

// --- Research Types ---

export interface ResearchItem {
  id: string;
  source: string;                 // "youtube" | "x" | "web" | "manual"
  sourceUrl: string;
  title: string;
  summary: string;
  keyInsights: string[];
  theme: string;
  subTheme: string;
  usedCount: number;
  quality: number;                // 1-5
  collectedAt: string;
}

export interface ThemeNode {
  id: string;
  name: string;
  description: string;
  children: ThemeNode[];
  postCount: number;              // このテーマの投稿数
  avgPerformance: number;         // 平均パフォーマンス
  lastUsedAt?: string;
  priority: number;               // 1(低) - 5(高)
}

// --- Analytics Types ---

export interface PostMetrics {
  postId: string;
  threadsPostId: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  engagementRate: number;         // (likes + replies + reposts) / views
  fetchedAt: string;
}

export interface AnalystInsight {
  id: string;
  period: string;                 // e.g., "2026-03-15_to_2026-03-20"
  topPatterns: { pattern: PostPattern; avgEngagement: number }[];
  weakPatterns: { pattern: PostPattern; avgEngagement: number }[];
  trendingThemes: string[];
  fadingThemes: string[];
  recommendations: string[];      // ライターへの指示
  hookAnalysis: {
    bestHooks: string[];
    hookStyles: string[];         // "断言型", "疑問型", etc.
  };
  createdAt: string;
}

// --- Scheduling Types ---

export interface TimeSlot {
  hour: number;
  minute: number;
  label: string;                  // e.g., "朝の通勤帯"
}

export interface ScheduleConfig {
  slots: TimeSlot[];
  timezone: string;
  maxPostsPerDay: number;
  minIntervalMinutes: number;
}

// --- System Types ---

export interface SystemState {
  isRunning: boolean;
  killSwitch: boolean;
  lastRun: Record<AgentRole, string>;
  errorCounts: Record<AgentRole, number>;
  dailyPostCount: number;
  todayDate: string;
}

export interface PipelineResult {
  fetcherResult?: AgentResult;
  analystResult?: AgentResult;
  researcherResult?: AgentResult;
  writerResult?: AgentResult;
  errors: string[];
  startedAt: string;
  completedAt: string;
}
