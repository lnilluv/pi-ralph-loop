import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Types ---

export type RpcEvent = {
  type: string;
  [key: string]: unknown;
};

export type RpcSubprocessConfig = {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** Override the spawn command for testing. Defaults to "pi" */
  spawnCommand?: string;
  /** Override spawn args for testing. Defaults to ["--mode", "rpc", "--no-session"] */
  spawnArgs?: string[];
  /** Additional environment variables for the subprocess */
  env?: Record<string, string>;
  /** Model pattern, e.g. "openai-codex/gpt-5.4" */
  modelPattern?: string;
  /** Provider, e.g. "openai-codex" */
  provider?: string;
  /** Callback for observing events as they stream */
  onEvent?: (event: RpcEvent) => void;
};

export type RpcSubprocessResult = {
  success: boolean;
  lastAssistantText: string;
  agentEndMessages: unknown[];
  timedOut: boolean;
  error?: string;
};

export type RpcPromptResult = {
  success: boolean;
  error?: string;
};

// --- RPC JSONL Parsing ---

export function parseRpcEvent(line: string): RpcEvent {
  const trimmed = line.trim();
  if (!trimmed) return { type: "empty" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as RpcEvent;
    }
    return { type: "unknown" };
  } catch {
    return { type: "unknown" };
  }
}

function extractAssistantText(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  const texts: string[] = [];
  for (const msg of messages) {
    if (
      typeof msg === "object" &&
      msg !== null &&
      "role" in msg &&
      (msg as Record<string, unknown>).role === "assistant" &&
      "content" in msg
    ) {
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as Record<string, unknown>).type === "text" &&
            "text" in block
          ) {
            texts.push(String((block as Record<string, unknown>).text));
          }
        }
      } else if (typeof content === "string") {
        texts.push(content);
      }
    }
  }
  return texts.join("");
}

// --- RPC Subprocess Execution ---

export async function runRpcIteration(config: RpcSubprocessConfig): Promise<RpcSubprocessResult> {
  const {
    prompt,
    cwd,
    timeoutMs,
    spawnCommand = "pi",
    spawnArgs,
    env,
    modelPattern,
    provider,
    onEvent,
  } = config;

  const args = spawnArgs ?? ["--mode", "rpc", "--no-session"];
  const subprocessEnv = { ...process.env, ...env };

  let childProcess: ReturnType<typeof spawn>;
  try {
    childProcess = spawn(spawnCommand, args, {
      cwd,
      env: subprocessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      success: false,
      lastAssistantText: "",
      agentEndMessages: [],
      timedOut: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return new Promise<RpcSubprocessResult>((resolve) => {
    let settled = false;
    let lastAssistantText = "";
    let agentEndMessages: unknown[] = [];
    let promptSent = false;
    let promptAcknowledged = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        childProcess.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
      resolve({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: true,
      });
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
    };

    const settle = (result: RpcSubprocessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Kill subprocess if still running
      try {
        childProcess.kill();
      } catch {
        // already dead
      }
      resolve(result);
    };

    // Set up stderr collection
    let stderrText = "";
    childProcess.stderr?.on("data", (data: Buffer) => {
      stderrText += data.toString("utf8");
    });

    // Set up stdout line reader
    let stdoutBuffer = "";
    childProcess.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf8");

      // Parse complete lines
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        // Handle \r\n
        const trimmedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmedLine) continue;

        const event = parseRpcEvent(trimmedLine);
        onEvent?.(event);

        if (event.type === "response") {
          const resp = event as { command?: string; success?: boolean };
          if (resp.command === "prompt" && resp.success === true) {
            promptAcknowledged = true;
          }
          continue;
        }

        if (event.type === "agent_end") {
          const endEvent = event as { messages?: unknown[] };
          agentEndMessages = Array.isArray(endEvent.messages) ? endEvent.messages : [];
          lastAssistantText = extractAssistantText(agentEndMessages);

          settle({
            success: true,
            lastAssistantText,
            agentEndMessages,
            timedOut: false,
          });
          return;
        }
      }
    });

    childProcess.on("error", (err: Error) => {
      settle({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error: err.message,
      });
    });

    childProcess.on("close", (code: number | null) => {
      if (settled) return;

      // If the subprocess exited but we never got an agent_end
      if (code !== 0 && code !== null) {
        settle({
          success: false,
          lastAssistantText,
          agentEndMessages,
          timedOut: false,
          error: `Subprocess exited with code ${code}${stderrText ? `: ${stderrText.slice(0, 200)}` : ""}`,
        });
        return;
      }

      // Process exited normally but no agent_end received
      settle({
        success: agentEndMessages.length > 0,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error: agentEndMessages.length > 0 ? undefined : "Subprocess exited without sending agent_end",
      });
    });

    // Send the prompt command
    const promptCommand = JSON.stringify({
      type: "prompt",
      id: `ralph-${randomUUID()}`,
      message: prompt,
    });

    try {
      childProcess.stdin?.write(promptCommand + "\n");
      childProcess.stdin?.end();
      promptSent = true;
    } catch (err) {
      settle({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}