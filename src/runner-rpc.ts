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
  /** Optional timeout for the handshake acks before the prompt is sent. Defaults to 15000. */
  handshakeTimeoutMs?: number;
  /** Override the spawn command for testing. Defaults to "pi" */
  spawnCommand?: string;
  /** Override spawn args for testing. Defaults to ["--mode", "rpc", "--no-session", "--no-extensions", "-e", <ralph extension>] */
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
  /** AbortSignal for cooperative cancellation. On abort, the RPC subprocess tree is SIGKILLed on Unix.
   *  Windows falls back to direct-child termination. */
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
  stderrTruncated?: boolean;
  stderrBytes?: number;
  stdoutBufferBytes?: number;
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

const DETACHED_RPC_PROCESS_GROUP = process.platform !== "win32";

function killRpcSubprocessTree(childProcess: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): void {
  if (DETACHED_RPC_PROCESS_GROUP && typeof childProcess.pid === "number") {
    try {
      process.kill(-childProcess.pid, signal);
      return;
    } catch {
      // Fall back to direct-child termination below.
    }
  }
  try {
    childProcess.kill(signal);
  } catch {
    // Process may already be dead.
  }
}

export async function runRpcIteration(config: RpcSubprocessConfig): Promise<RpcSubprocessResult> {
  const {
    prompt,
    cwd,
    timeoutMs,
    handshakeTimeoutMs = 15_000,
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
  const args = spawnArgs ?? ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extensionPath];
  const subprocessEnv = { ...process.env, ...env };
  const telemetry: RpcTelemetry = {
    spawnedAt: new Date().toISOString(),
  };

  let childProcess: ReturnType<typeof spawn>;
  let stderrText = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  const STDERR_TEXT_MAX_CHARS = 4000;
  const STDOUT_LINE_MAX_CHARS = 1_000_000;
  const appendStderr = (text: string): void => {
    stderrBytes += Buffer.byteLength(text, "utf8");
    if (stderrText.length >= STDERR_TEXT_MAX_CHARS) {
      stderrTruncated = true;
      return;
    }
    const remaining = STDERR_TEXT_MAX_CHARS - stderrText.length;
    stderrText += text.slice(0, remaining);
    if (text.length > remaining) {
      stderrTruncated = true;
    }
  };
  const buildResult = (result: Omit<RpcSubprocessResult, "telemetry">): RpcSubprocessResult => ({
    ...result,
    telemetry: {
      ...telemetry,
      ...(stderrText ? { stderrText } : {}),
      ...(stderrBytes > 0 ? { stderrBytes } : {}),
      ...(stderrTruncated ? { stderrTruncated: true } : {}),
      ...(telemetry.stdoutBufferBytes !== undefined ? { stdoutBufferBytes: telemetry.stdoutBufferBytes } : {}),
    },
  });

  try {
    childProcess = spawn(spawnCommand, args, {
      cwd,
      env: subprocessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: DETACHED_RPC_PROCESS_GROUP,
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
    const requiresModelHandshake = Boolean(modelProvider && modelModelId);
    const requiresThinkingHandshake = Boolean(thinkingLevel);
    let modelSetAcknowledged = !requiresModelHandshake;
    let thinkingLevelAcknowledged = !requiresThinkingHandshake;

    const nowIso = () => new Date().toISOString();
    const markStdoutEvent = (eventType: string) => {
      const observedAt = nowIso();
      if (!telemetry.firstStdoutEventAt) telemetry.firstStdoutEventAt = observedAt;
      telemetry.lastEventAt = observedAt;
      telemetry.lastEventType = eventType;
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      telemetry.error = "cancelled";
      killRpcSubprocessTree(childProcess, "SIGKILL");
      clearTimeout(timeout);
      clearTimeout(handshakeTimeout);
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
      killRpcSubprocessTree(childProcess, "SIGKILL");
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
      clearTimeout(handshakeTimeout);
      endStdin();
      signal?.removeEventListener("abort", onAbort);
    };

    const settle = (result: RpcSubprocessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Kill subprocess if still running.
      killRpcSubprocessTree(childProcess, "SIGKILL");
      resolve(result);
    };

    // Set up stderr collection
    childProcess.stderr?.on("data", (data: Buffer) => {
      appendStderr(data.toString("utf8"));
    });

    // Set up stdout line reader
    let stdoutBuffer = "";
    const failStdoutBufferLimit = () => {
      const stdoutBufferBytes = Buffer.byteLength(stdoutBuffer, "utf8");
      stdoutBuffer = "";
      telemetry.stdoutBufferBytes = stdoutBufferBytes;
      const error = `RPC stdout line exceeded ${STDOUT_LINE_MAX_CHARS} chars before newline (${stdoutBufferBytes} bytes buffered)`;
      telemetry.error = error;
      killRpcSubprocessTree(childProcess, "SIGKILL");
      settle(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error,
      }));
    };
    childProcess.stdout?.on("data", (data: Buffer) => {
      if (settled) return;
      stdoutBuffer += data.toString("utf8");

      // Parse complete lines
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        if (newlineIndex > STDOUT_LINE_MAX_CHARS) {
          failStdoutBufferLimit();
          return;
        }
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        // Handle \r\n
        const trimmedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmedLine) continue;

        const event = parseRpcEvent(trimmedLine);
        markStdoutEvent(event.type);
        onEvent?.(event);

        if (event.type === "response") {
          const resp = event as { command?: string; success?: boolean; error?: unknown };
          if (resp.command === "set_model" && resp.success === false) {
            const error = `set_model failed${resp.error ? `: ${String(resp.error)}` : ""}`;
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
          if (resp.command === "set_thinking_level" && resp.success === false) {
            const error = `set_thinking_level failed${resp.error ? `: ${String(resp.error)}` : ""}`;
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
          if (resp.command === "set_model" && resp.success === true) {
            modelSetAcknowledged = true;
          }
          if (resp.command === "set_thinking_level" && resp.success === true) {
            thinkingLevelAcknowledged = true;
          }
          if (resp.command === "prompt" && resp.success === true) {
            promptAcknowledged = true;
          }

          if (!settled && !promptSent && (!requiresModelHandshake || modelSetAcknowledged) && (!requiresThinkingHandshake || thinkingLevelAcknowledged)) {
            clearTimeout(handshakeTimeout);
            sendPrompt();
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

      if (stdoutBuffer.length > STDOUT_LINE_MAX_CHARS) {
        failStdoutBufferLimit();
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

    const sendPrompt = () => {
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

    const handshakeMissingRequirements = (): string[] => {
      const missing: string[] = [];
      if (requiresModelHandshake && !modelSetAcknowledged) missing.push("set_model");
      if (requiresThinkingHandshake && !thinkingLevelAcknowledged) missing.push("set_thinking_level");
      return missing;
    };

    const failHandshakeTimeout = () => {
      const missing = handshakeMissingRequirements();
      if (missing.length === 0) return;
      const error =
        missing.length === 1
          ? `RPC handshake timed out waiting for ${missing[0]} ack`
          : `RPC handshake timed out waiting for ${missing.join(" and ")} acknowledgements`;
      telemetry.error = error;
      settled = true;
      killRpcSubprocessTree(childProcess, "SIGKILL");
      clearTimeout(timeout);
      clearTimeout(handshakeTimeout);
      resolve(buildResult({
        success: false,
        lastAssistantText,
        agentEndMessages,
        timedOut: false,
        error,
      }));
    };

    const checkHandshakeReady = () => {
      if (settled || promptSent) return;
      if (!requiresModelHandshake && !requiresThinkingHandshake) {
        sendPrompt();
        return;
      }
      if (requiresModelHandshake && !modelSetAcknowledged) return;
      if (requiresThinkingHandshake && !thinkingLevelAcknowledged) return;
      clearTimeout(handshakeTimeout);
      sendPrompt();
    };

    if (requiresModelHandshake || requiresThinkingHandshake) {
      handshakeTimeout = setTimeout(failHandshakeTimeout, handshakeTimeoutMs);
    }

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

    checkHandshakeReady();
  });
}