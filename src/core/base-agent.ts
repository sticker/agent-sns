import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult, AgentRole } from "../types";

// ============================================================
// BaseAgent — 全エージェントの基底クラス
// ============================================================

export abstract class BaseAgent<TInput = unknown, TOutput = unknown> {
  private _client: Anthropic | null = null;
  protected config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** Anthropicクライアントを遅延初期化（LLMを使わないエージェントではインスタンス化しない） */
  protected get client(): Anthropic {
    if (!this._client) {
      this._client = new Anthropic();
    }
    return this._client;
  }

  /**
   * エージェント固有の処理を実装する（サブクラスでオーバーライド）
   */
  abstract execute(input: TInput): Promise<TOutput>;

  /**
   * LLMにメッセージを送信して応答を取得
   */
  protected async chat(
    userMessage: string,
    options?: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: options?.maxTokens ?? 4096,
      system: options?.systemPrompt ?? this.config.systemPrompt,
      messages: [{ role: "user" as const, content: userMessage }],
      // temperatureが指定されている場合のみ渡す
      ...(options?.temperature !== undefined && {
        temperature: options.temperature,
      }),
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`[${this.config.role}] No text response from LLM`);
    }
    return textBlock.text;
  }

  /**
   * JSON形式の応答を取得してパース
   */
  protected async chatJSON<T>(
    userMessage: string,
    options?: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<T> {
    const raw = await this.chat(userMessage, options);

    // ```json ... ``` のフェンスを除去
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned) as T;
    } catch (e) {
      // JSONブロックを探す
      const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]) as T;
      }
      throw new Error(
        `[${this.config.role}] Failed to parse JSON response: ${(e as Error).message}`
      );
    }
  }

  /**
   * リトライ付きの実行ラッパー
   */
  async run(input: TInput): Promise<AgentResult<TOutput>> {
    const startTime = Date.now();

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const data = await this.execute(input);
        return {
          agent: this.config.role,
          success: true,
          data,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[${this.config.role}] Attempt ${attempt}/${this.config.maxRetries} failed: ${errMsg}`
        );

        if (attempt === this.config.maxRetries) {
          return {
            agent: this.config.role,
            success: false,
            data: null as unknown as TOutput,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            error: errMsg,
          };
        }

        // バックオフ
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    // unreachable
    throw new Error("Unreachable");
  }

  get role(): AgentRole {
    return this.config.role;
  }

  get name(): string {
    return this.config.name;
  }
}
