import { BaseAgent } from "../core/base-agent";
import type { AgentConfig, AgentRole, PipelineResult, SystemState } from "../types";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ============================================================
// Agent ⑥ スーパーバイザー — 監視担当
// ============================================================
// - パイプライン全体の異常検知
// - エラー3回連続で自動停止
// - 投稿スケジュールの遅延検知
// - KILL SWITCH による緊急停止
// ============================================================

interface SupervisorInput {
  pipelineResult: PipelineResult;
  systemState: SystemState;
  stateFilePath: string;
}

interface SupervisorOutput {
  status: "healthy" | "warning" | "critical" | "killed";
  alerts: Alert[];
  actions: Action[];
  updatedState: SystemState;
}

interface Alert {
  level: "info" | "warning" | "critical";
  agent?: AgentRole;
  message: string;
  timestamp: string;
}

interface Action {
  type: "pause" | "resume" | "kill" | "reset_errors" | "notify";
  target?: AgentRole;
  reason: string;
}

const MAX_CONSECUTIVE_ERRORS = 3;

export class SupervisorAgent extends BaseAgent<SupervisorInput, SupervisorOutput> {
  constructor() {
    const config: AgentConfig = {
      role: "supervisor",
      name: "スーパーバイザー",
      description: "システム全体の監視と異常検知を行う",
      systemPrompt: "",
      model: "claude-sonnet-4-20250514",
      maxRetries: 1,
      timeoutMs: 10000,
    };
    super(config);
  }

  async execute(input: SupervisorInput): Promise<SupervisorOutput> {
    const alerts: Alert[] = [];
    const actions: Action[] = [];
    const state = { ...input.systemState };
    const now = new Date().toISOString();

    // --- Check 1: KILL SWITCH ---
    if (state.killSwitch) {
      alerts.push({
        level: "critical",
        message: "🚨 KILL SWITCH が有効です。全投稿を停止中。",
        timestamp: now,
      });
      return {
        status: "killed",
        alerts,
        actions: [{ type: "kill", reason: "KILL SWITCH activated" }],
        updatedState: { ...state, isRunning: false },
      };
    }

    // --- Check 2: パイプライン結果のエラーチェック ---
    const pipeline = input.pipelineResult;
    const agentResults = [
      pipeline.fetcherResult,
      pipeline.analystResult,
      pipeline.researcherResult,
      pipeline.writerResult,
    ].filter(Boolean);

    for (const result of agentResults) {
      if (!result) continue;

      if (!result.success) {
        state.errorCounts[result.agent] =
          (state.errorCounts[result.agent] || 0) + 1;

        alerts.push({
          level: "warning",
          agent: result.agent,
          message: `${result.agent} がエラー: ${result.error}（連続${state.errorCounts[result.agent]}回目）`,
          timestamp: now,
        });

        // 3回連続エラーで自動停止
        if (state.errorCounts[result.agent] >= MAX_CONSECUTIVE_ERRORS) {
          alerts.push({
            level: "critical",
            agent: result.agent,
            message: `${result.agent} が${MAX_CONSECUTIVE_ERRORS}回連続エラー。自動停止します。`,
            timestamp: now,
          });
          actions.push({
            type: "pause",
            target: result.agent,
            reason: `${MAX_CONSECUTIVE_ERRORS} consecutive errors`,
          });
        }
      } else {
        // 成功したらエラーカウントリセット
        state.errorCounts[result.agent] = 0;
      }

      state.lastRun[result.agent] = now;
    }

    // --- Check 3: 日次投稿数チェック ---
    const today = new Date().toISOString().split("T")[0];
    if (state.todayDate !== today) {
      state.dailyPostCount = 0;
      state.todayDate = today;
    }

    if (state.dailyPostCount > 15) {
      alerts.push({
        level: "critical",
        message: `日次投稿数が上限を超えています: ${state.dailyPostCount}/15`,
        timestamp: now,
      });
      actions.push({
        type: "pause",
        target: "poster",
        reason: "Daily post limit exceeded",
      });
    }

    // --- Check 4: パイプラインエラーチェック ---
    if (pipeline.errors.length > 0) {
      for (const err of pipeline.errors) {
        alerts.push({
          level: "warning",
          message: `パイプラインエラー: ${err}`,
          timestamp: now,
        });
      }
    }

    // --- 状態をファイルに永続化 ---
    try {
      writeFileSync(input.stateFilePath, JSON.stringify(state, null, 2));
    } catch (e) {
      alerts.push({
        level: "warning",
        message: `状態ファイルの保存に失敗: ${(e as Error).message}`,
        timestamp: now,
      });
    }

    // --- 最終ステータス判定 ---
    const hasCritical = alerts.some((a) => a.level === "critical");
    const hasWarning = alerts.some((a) => a.level === "warning");
    const status = hasCritical ? "critical" : hasWarning ? "warning" : "healthy";

    console.log(
      `[スーパーバイザー] ステータス: ${status} | アラート: ${alerts.length}件 | アクション: ${actions.length}件`
    );

    return { status, alerts, actions, updatedState: state };
  }

  /**
   * KILL SWITCH を有効化
   */
  static activateKillSwitch(stateFilePath: string): void {
    let state: SystemState;
    if (existsSync(stateFilePath)) {
      state = JSON.parse(readFileSync(stateFilePath, "utf-8"));
    } else {
      state = {
        isRunning: false,
        killSwitch: true,
        lastRun: {} as Record<AgentRole, string>,
        errorCounts: {} as Record<AgentRole, number>,
        dailyPostCount: 0,
        todayDate: new Date().toISOString().split("T")[0],
      };
    }
    state.killSwitch = true;
    state.isRunning = false;
    writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
    console.log("🚨 KILL SWITCH ACTIVATED — 全投稿を停止しました");
  }
}
