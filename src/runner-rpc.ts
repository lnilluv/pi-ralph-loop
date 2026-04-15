import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
  /** Model selection for RPC subprocess. Format: "provider/modelId" or "provider/modelId:thinkingLevel"
   * Examples: "anthropic/claude-sonnet-4-20250514" or "openai-codex/gpt-5.4-mini:high"
   * Parsed into set_model + set_thinking_level commands.
   */
  modelPattern?: string;
  /** Explicit provider for set_model (overrides modelPattern provider) */
  provider?: string;
  /** Explicit modelId for set_model (overrides modelPattern modelId) */
  modelId?: string;
  /** Thinking level for set_thinking_level: "off", "minimal", "low", "medium", "high", "xhigh".
   * Also parsed from modelPattern suffix (e.g. ":high").
   */
  thinkingLevel?: string;
  /** Callback for observing events as they stream */
  onEvent?: (event: RpcEvent) => void;
  /** AbortSignal for cooperative cancellation. On abort, the direct child process is SIGKILLed.
   *  Grandchild processes may survive — the caller is responsible for process group cleanup
   *  if full-tree termination is required. */
  signal?: AbortSignal;
};

export type RpcTelemetry = {
  spawnedAt: string;
  promptSentAt?: string;
  firstStdoutEventAt?: string;
  lastEventAt?: string;
  lastEventType?: string;
  exitedAt?: string;
  timedOutAt?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  stderrText?: string;
  error?: string;
};

export type RpcSubprocessResult = {
  success: boolean;
  lastAssistantText: string;
  agentEndMessages: unknown[];
  timedOut: boolean;
  cancelled?: boolean;
  error?: string;
  telemetry: RpcTelemetry;
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
    provider: explicitProvider,
    modelId: explicitModelId,
    onEvent,
    signal,
  } = config;

  // Parse modelPattern ("provider/modelId" or "provider/modelId:thinking") into provider and modelId
  let modelProvider = explicitProvider;
  let modelModelId = explicitModelId;
  let thinkingLevel = config.thinkingLevel;
  if (modelPattern && !explicitModelId) {
    // Extract thinking level suffix (e.g. ":high")
    const lastColonIdx = modelPattern.lastIndexOf(":");
    const validThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
    let patternWithoutThinking = modelPattern;
    if (lastColonIdx > 0 && validThinkingLevels.has(modelPattern.slice(lastColonIdx + 1))) {
      thinkingLevel = modelPattern.slice(lastColonIdx + 1);
      patternWithoutThinking = modelPattern.slice(0, lastColonIdx);
    }
    
    const slashIdx = patternWithoutThinking.indexOf("/");
    if (slashIdx > 0) {
      modelProvider = patternWithoutThinking.slice(0, slashIdx);
      modelModelId = patternWithoutThinking.slice(slashIdx + 1);
    }
  }

  const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const args = spawnArgs ?? ["--mode", "rpc", "--no-session", "-e", extensionPath];
  const subprocessEnv = { ...process.env, ...env };
  const telemetry: RpcTelemetry = {
    spawnedAt: new Date().toISOString(),
  };

  let childProcess: ReturnType<typeof spawn>;
  let stderrText = "";
  const buildResult = (result: Omit<RpcSubprocessResult, "telemetry">): RpcSubprocessResult => ({
    ...result,
    telemetry: {
      ...telemetry,
      ...(stderrText ? { stderrText } : {}),
    },
  });

  try {
    childProcess = spawn(spawnCommand, args, {
      cwd,
      env: subprocessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    telemetry.error = err instanceof Error ? err.message : String(err);
    return buildResult({
      success: false,
      lastAssistantText: "",
      agentEndMessages: [],
      timedOut: false,
      error: telemetry.error,
    });
  }

  return new Promise<RpcSubprocessResult>((resolve) => {
    let settled = false;
    let lastAssistantText = "";
    let agentEndMessages: unknown[] = [];
    let promptSent = false;
    let promptAcknowledged = false;
    let sawAgentEnd = false;
    let modelSetAcknowledged = !(modelProvider && modelModelId); // true if no set_model needed
    let thinkingLevelAcknowledged = !thinkingLevel; // true if no set_thinking_level needed

    const nowIso = () => new Date().toISOString();
    const markStdoutEvent = (eventType: string) => {
      const observedAt = nowIso();
      if (!telemetry.firstStdoutEventAt) telemetry.firstStdoutEventAt = observedAt;
      telemetry.lastEventAt = observedAt;
      telemetry.lastEventType = eventType;
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      telemetry.error = "cancelled";
      try {
        childProcess.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
      clearTimeout(timeout);
      resolve(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        cancelled: true,
        error: "cancelled",
      }));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      telemetry.timedOutAt = nowIso();
      try {
        childProcess.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
      resolve(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: true,
      }));
    }, timeoutMs);

    const endStdin = () => {
      // Close stdin so the subprocess knows no more commands are coming
      try {
        childProcess.stdin?.end();
      } catch {
        // already closed
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      endStdin();
      signal?.removeEventListener("abort", onAbort);
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
        markStdoutEvent(event.type);
        onEvent?.(event);

        if (event.type === "response") {
          const resp = event as { command?: string; success?: boolean };
          if (resp.command === "set_model" && resp.success === true) {
            modelSetAcknowledged = true;
          }
          if (resp.command === "set_thinking_level" && resp.success === true) {
            thinkingLevelAcknowledged = true;
          }
          if (resp.command === "prompt" && resp.success === true) {
            promptAcknowledged = true;
          }
          continue;
        }

        if (event.type === "agent_end") {
          const endEvent = event as { messages?: unknown[] };
          sawAgentEnd = true;
          agentEndMessages = Array.isArray(endEvent.messages) ? endEvent.messages : [];
          lastAssistantText = extractAssistantText(agentEndMessages);
          endStdin();
          continue;
        }
      }
    });

    childProcess.on("error", (err: Error) => {
      telemetry.error = err.message;
      settle(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error: err.message,
      }));
    });
    childProcess.stdin?.on("error", (err: Error & { code?: string }) => {
      if (settled) return;
      const error = err.code === "EPIPE" ? "Subprocess closed stdin before prompt could be sent" : err.message;
      telemetry.error = error;
      settle(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error,
      }));
    });

    childProcess.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      telemetry.exitedAt = nowIso();
      telemetry.exitCode = code;
      telemetry.exitSignal = signal;

      const closeError =
        code !== 0 && code !== null
          ? `Subprocess exited with code ${code}${stderrText ? `: ${stderrText.slice(0, 200)}` : ""}`
          : signal
            ? `Subprocess exited due to signal ${signal}${stderrText ? `: ${stderrText.slice(0, 200)}` : ""}`
            : sawAgentEnd
              ? undefined
              : "Subprocess exited without sending agent_end";
      if (closeError) telemetry.error = closeError;

      settle(buildResult({
        success: sawAgentEnd && code === 0 && signal === null,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error: closeError,
      }));
    });

    // Send set_model command if provider/model are specified
    if (modelProvider && modelModelId) {
      const setModelCommand = JSON.stringify({
        type: "set_model",
        provider: modelProvider,
        modelId: modelModelId,
      });
      try {
        childProcess.stdin?.write(setModelCommand + "\n");
      } catch (err) {
        const error = `Failed to send set_model command: ${err instanceof Error ? err.message : String(err)}`;
        telemetry.error = error;
        settle(buildResult({
          success: false,
          lastAssistantText,
          agentEndMessages,
          timedOut: false,
          error,
        }));
        return;
      }
    }

    // Send set_thinking_level if specified
    if (thinkingLevel) {
      const setThinkingCommand = JSON.stringify({
        type: "set_thinking_level",
        level: thinkingLevel,
      });
      try {
        childProcess.stdin?.write(setThinkingCommand + "\n");
      } catch (err) {
        const error = `Failed to send set_thinking_level command: ${err instanceof Error ? err.message : String(err)}`;
        telemetry.error = error;
        settle(buildResult({
          success: false,
          lastAssistantText,
          agentEndMessages,
          timedOut: false,
          error,
        }));
        return;
      }
    }

    // Wait for set_model acknowledgment before sending prompt
    const sendPrompt = () => {
      // Send the prompt command
      const promptCommand = JSON.stringify({
        type: "prompt",
        id: `ralph-${randomUUID()}`,
        message: prompt,
      });

      try {
        telemetry.promptSentAt = telemetry.promptSentAt ?? nowIso();
        childProcess.stdin?.write(promptCommand + "\n");
        promptSent = true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        telemetry.error = error;
        settle(buildResult({
          success: false,
          lastAssistantText,
          agentEndMessages,
          timedOut: false,
          error,
        }));
      }
    };

    if (modelSetAcknowledged && thinkingLevelAcknowledged) {
      sendPrompt();
    } else {
      const waitForAcknowledgements = async () => {
        const deadline = Date.now() + 5000;
        while (!settled && !promptSent && Date.now() < deadline) {
          if (modelSetAcknowledged && thinkingLevelAcknowledged) break;
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        }
      };

      void waitForAcknowledgements().then(() => {
        if (!settled && !promptSent) {
          sendPrompt();
        }
      });
    }
  });
}