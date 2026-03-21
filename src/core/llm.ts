// ============================================================
// LLM — claude -p (ヘッドレスモード) ラッパー
// ============================================================
// サブスクリプション内で動作。API課金なし。
// claude CLI がインストール済み & ログイン済みであること。
// ============================================================

export interface LLMOptions {
  systemPrompt: string;
  model?: "sonnet" | "opus" | "haiku";
  maxTurns?: number;
  jsonSchema?: Record<string, unknown>;
}

interface ClaudeOutput {
  result: string;
  is_error: boolean;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  structured_output?: unknown;
}

// claude -p でテキスト応答を取得
export async function callLLM(
  prompt: string,
  options: LLMOptions
): Promise<string> {
  const args: string[] = [
    "claude",
    "-p",
    prompt,
    "--output-format", "json",
    "--no-chrome",             // Chrome統合を無効化
    "--strict-mcp-config",     // --mcp-config未指定時にMCPサーバーを読み込まない
  ];

  args.push("--max-turns", String(options.maxTurns ?? 1));
  args.push("--tools", "");  // ビルトインツール使用を無効化

  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`claude -p failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let output: ClaudeOutput;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p の出力をパースできません: ${stdout.slice(0, 300)}`);
  }

  if (output.is_error) {
    throw new Error(`LLM error: ${output.result}`);
  }

  if (typeof output.result !== "string") {
    throw new Error(`LLM応答のresultが文字列ではありません: ${JSON.stringify(output).slice(0, 300)}`);
  }

  return output.result;
}

// claude -p でJSON応答を取得してパース
export async function callLLMJSON<T>(
  prompt: string,
  options: LLMOptions
): Promise<T> {
  // jsonSchema指定時は structured_output を直接取得
  if (options.jsonSchema) {
    return callLLMStructured<T>(prompt, options);
  }

  const raw = await callLLM(prompt, options);

  // ```json ... ``` のフェンスを除去
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // まず全体をパース
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // pass
  }

  // ```json ... ``` ブロックを抽出（複数行対応）
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // pass
    }
  }

  // JSONブロックを探す（配列 or オブジェクト）
  const match = cleaned.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // pass
    }
  }

  throw new Error(
    `LLM応答からJSONをパースできません: ${cleaned.slice(0, 200)}`
  );
}

// claude -p --json-schema による構造化出力を取得
async function callLLMStructured<T>(
  prompt: string,
  options: LLMOptions
): Promise<T> {
  const args: string[] = [
    "claude",
    "-p",
    prompt,
    "--output-format", "json",
    "--no-chrome",
    "--strict-mcp-config",
    "--max-turns", String(options.maxTurns ?? 2),
    "--json-schema", JSON.stringify(options.jsonSchema),
  ];

  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`claude -p failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let output: ClaudeOutput;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p の出力をパースできません: ${stdout.slice(0, 300)}`);
  }

  if (output.is_error) {
    throw new Error(`LLM error: ${output.result}`);
  }

  if (output.structured_output != null) {
    return output.structured_output as T;
  }

  // structured_outputがない場合はresultからパースを試みる
  if (typeof output.result === "string" && output.result.trim()) {
    return JSON.parse(output.result) as T;
  }

  throw new Error(
    `LLM構造化出力を取得できません: ${JSON.stringify(output).slice(0, 300)}`
  );
}
