import { BaseAgent } from "../core/base-agent";
import type { AgentConfig, Post, ScheduleConfig, TimeSlot } from "../types";

// ============================================================
// Agent ④ ポスター — 投稿実行担当
// ============================================================
// - キューに入った投稿をThreads APIで実行
// - タイムスロットに分散して投稿
// - コメント誘導型 → 自己返信付き
// - ツリー型 → 返信チェーン
// - アフィリエイト → コメントにリンク配置
// ============================================================

interface PosterInput {
  posts: Post[];
  schedule: ScheduleConfig;
  accessToken: string;
  userId: string;
}

interface PosterOutput {
  posted: { postId: string; threadsPostId: string; scheduledAt: string }[];
  failed: { postId: string; error: string }[];
}

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

export class PosterAgent extends BaseAgent<PosterInput, PosterOutput> {
  constructor() {
    const config: AgentConfig = {
      role: "poster",
      name: "ポスター",
      description: "キューの投稿をThreads APIでスケジュール投稿する",
      systemPrompt: "",
      model: "claude-sonnet-4-20250514",
      maxRetries: 2,
      timeoutMs: 30000,
    };
    super(config);
  }

  async execute(input: PosterInput): Promise<PosterOutput> {
    const posted: PosterOutput["posted"] = [];
    const failed: PosterOutput["failed"] = [];

    // 投稿をタイムスロットに割り当て（過去のスロットをスキップ）
    const now = new Date();
    const assignments = this.assignToSlots(input.posts, input.schedule, now);

    for (const { post, slot } of assignments) {
      try {
        // --- Step 1: メイン投稿 ---
        const mainPostId = await this.createTextPost(
          input.userId,
          input.accessToken,
          post.content
        );

        // --- Step 2: ツリー型の場合、返信チェーンを作成 ---
        if (post.threadParts && post.threadParts.length > 0) {
          let parentId = mainPostId;
          for (const part of post.threadParts) {
            parentId = await this.createReplyPost(
              input.userId,
              input.accessToken,
              part,
              parentId
            );
          }
        }

        // --- Step 3: コメント誘導型の自己返信 ---
        if (post.commentReply) {
          await this.createReplyPost(
            input.userId,
            input.accessToken,
            post.commentReply,
            mainPostId
          );
        }

        // --- Step 4: アフィリエイトリンクの配置 ---
        if (post.affiliateLink) {
          await this.createReplyPost(
            input.userId,
            input.accessToken,
            post.affiliateLink,
            mainPostId
          );
        }

        posted.push({
          postId: post.id,
          threadsPostId: mainPostId,
          scheduledAt: this.formatSlotTime(slot),
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        failed.push({ postId: post.id, error: errMsg });
      }
    }

    console.log(
      `[ポスター] 投稿完了: ${posted.length}件 | 失敗: ${failed.length}件`
    );

    return { posted, failed };
  }

  /**
   * テキスト投稿を作成（Threads API 2-step: create → publish）
   */
  private async createTextPost(
    userId: string,
    accessToken: string,
    text: string
  ): Promise<string> {
    // Step 1: メディアコンテナ作成
    const createRes = await fetch(
      `${THREADS_API_BASE}/${userId}/threads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "TEXT",
          text,
          access_token: accessToken,
        }),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Threads API create failed: ${err}`);
    }

    const { id: containerId } = (await createRes.json()) as { id: string };

    // Threads APIの推奨: コンテナ作成後に待機してから公開
    await new Promise((r) => setTimeout(r, 3000));

    // Step 2: 公開
    const publishRes = await fetch(
      `${THREADS_API_BASE}/${userId}/threads_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id: containerId,
          access_token: accessToken,
        }),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.text();
      throw new Error(`Threads API publish failed: ${err}`);
    }

    const { id: postId } = (await publishRes.json()) as { id: string };
    return postId;
  }

  /**
   * 返信投稿を作成
   */
  private async createReplyPost(
    userId: string,
    accessToken: string,
    text: string,
    replyToId: string
  ): Promise<string> {
    const createRes = await fetch(
      `${THREADS_API_BASE}/${userId}/threads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "TEXT",
          text,
          reply_to_id: replyToId,
          access_token: accessToken,
        }),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Threads API reply create failed: ${err}`);
    }

    const { id: containerId } = (await createRes.json()) as { id: string };

    const publishRes = await fetch(
      `${THREADS_API_BASE}/${userId}/threads_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id: containerId,
          access_token: accessToken,
        }),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.text();
      throw new Error(`Threads API reply publish failed: ${err}`);
    }

    const { id: postId } = (await publishRes.json()) as { id: string };
    return postId;
  }

  /**
   * 投稿を未来のタイムスロットに割り当て（過去のスロットはスキップ）
   */
  private assignToSlots(
    posts: Post[],
    schedule: ScheduleConfig,
    now: Date
  ): { post: Post; slot: TimeSlot }[] {
    // 現在時刻をJST（Asia/Tokyo）で取得
    const jstNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
    );
    const currentHour = jstNow.getHours();
    const currentMinute = jstNow.getMinutes();

    // 過去のスロットを除外
    const futureSlots = schedule.slots.filter(
      (slot) =>
        slot.hour > currentHour ||
        (slot.hour === currentHour && slot.minute > currentMinute)
    );

    return posts.slice(0, futureSlots.length).map((post, i) => ({
      post,
      slot: futureSlots[i],
    }));
  }

  private formatSlotTime(slot: TimeSlot): string {
    return `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
  }
}
