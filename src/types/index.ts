// ============================================================
// Threads Multi-Agent System — Type Definitions
// ============================================================
// v2: パイプライン廃止 → 各エージェント独立実行
//     BaseAgent/AgentConfig 廃止 → claude -p ベース
//     Human-in-the-loop: draft → review → queued → posted
// ============================================================

// --- Agent Types ---

export type AgentRole =
  | "researcher"
  | "analyst"
  | "writer"
  | "poster"
  | "fetcher"
  | "supervisor";

// --- Post Types ---

export type PostPattern =
  | "short_statement"
  | "short_question"
  | "short_exposure"
  | "demand_check"
  | "list_3"
  | "list_5"
  | "list_7"
  | "comparison"
  | "before_after"
  | "myth_busting"
  | "comment_bait"
  | "thread_story"
  | "thread_tips"
  | "hot_take"
  | "news_react"
  | "tool_review"
  | "tutorial_mini";

export interface Post {
  id: string;
  content: string;
  pattern: PostPattern;
  theme: string;
  subTheme: string;
  hook: string;
  qualityScore: QualityScore;
  similarityScore: number;
  threadParts?: string[];
  commentReply?: string;
  affiliateLink?: string;
  status: PostStatus;
  createdAt: string;
  scheduledAt?: string;
  postedAt?: string;
  threadsPostId?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

// draft → (人間承認) → queued → (cron投稿) → posted
//                     ↘ rejected
export type PostStatus =
  | "draft"
  | "queued"
  | "scheduled"
  | "posted"
  | "rejected"
  | "failed";

// --- Quality Scoring ---

export interface QualityScore {
  hookStrength: number;
  usefulness: number;
  specificity: number;
  tempo: number;
  personaMatch: number;
  uniqueness: number;
  emotionalTrigger: number;
  readability: number;
  ctaPower: number;
  platformFit: number;
  average: number;
}

export const QUALITY_THRESHOLD = 7.0;
export const SIMILARITY_THRESHOLD = 0.85;
export const MAX_CONSECUTIVE_SAME_THEME = 3;
export const MAX_DAILY_POSTS = 15;
export const MIN_POST_INTERVAL_MINUTES = 60;

// --- Research Types ---

export interface ResearchItem {
  id: string;
  source: string;
  sourceUrl: string;
  title: string;
  summary: string;
  keyInsights: string[];
  theme: string;
  subTheme: string;
  usedCount: number;
  quality: number;
  collectedAt: string;
}

export interface ThemeNode {
  id: string;
  name: string;
  description: string;
  children: ThemeNode[];
  postCount: number;
  avgPerformance: number;
  lastUsedAt?: string;
  priority: number;
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
  engagementRate: number;
  fetchedAt: string;
}

export interface AnalystInsight {
  id: string;
  period: string;
  topPatterns: { pattern: PostPattern; avgEngagement: number }[];
  weakPatterns: { pattern: PostPattern; avgEngagement: number }[];
  trendingThemes: string[];
  fadingThemes: string[];
  recommendations: string[];
  hookAnalysis: {
    bestHooks: string[];
    hookStyles: string[];
  };
  createdAt: string;
}

// --- Scheduling Types ---

export interface TimeSlot {
  hour: number;
  minute: number;
  label: string;
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
