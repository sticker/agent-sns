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
}

interface ClaudeOutput {
  result: string;
  is_error: boolean;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
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
    "--max-turns", String(options.maxTurns ?? 1),
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

  return output.result;
}

// claude -p でJSON応答を取得してパース
export async function callLLMJSON<T>(
  prompt: string,
  options: LLMOptions
): Promise<T> {
  const raw = await callLLM(prompt, options);

  // ```json ... ``` のフェンスを除去
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // JSONブロックを探す
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(
      `LLM応答からJSONをパースできません: ${cleaned.slice(0, 200)}`
    );
  }
}
