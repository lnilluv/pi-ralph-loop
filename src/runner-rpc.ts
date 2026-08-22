import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

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
  if (modelPattern) {
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
      if (!explicitProvider) modelProvider = patternWithoutThinking.slice(0, slashIdx);
      if (!explicitModelId) modelModelId = patternWithoutThinking.slice(slashIdx + 1);
    }
  }

  const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const args = spawnArgs ?? ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extensionPath];
  const subprocessEnv = { ...process.env, ...env };
  const telemetry: RpcTelemetry = {
    spawnedAt: "",
  };

  if (signal?.aborted) {
    telemetry.error = "cancelled";
    return {
      success: false,
      lastAssistantText: "",
      agentEndMessages: [],
      timedOut: false,
      cancelled: true,
      error: "cancelled",
      telemetry,
    };
  }

  let childProcess: ReturnType<typeof spawn>;
  let stderrText = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  const STDERR_TEXT_MAX_CHARS = 4000;
  // Terminal RPC events include the complete assistant message. Image attachments and
  // large tool results can legitimately push one JSONL record beyond 8 MB, so retain a
  // bounded guard while allowing attachment-rich iterations to finish.
  const STDOUT_LINE_MAX_CHARS = 32_000_000;
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
    telemetry.spawnedAt = new Date().toISOString();
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

    signal?.addEventListener("abort", onAbort, { once: true });

    const startIterationTimeout = () => {
      if (timeout) return;
      timeout = setTimeout(() => {
        if (settled) return;
        telemetry.timedOutAt = nowIso();
        settle(buildResult({
          success: false,
          lastAssistantText,
          agentEndMessages,
          timedOut: true,
        }));
      }, timeoutMs);
    };

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
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutLineParts: string[] = [];
    let stdoutLineChars = 0;
    let stdoutLineBytes = 0;
    const appendStdoutLinePart = (part: string) => {
      if (!part) return;
      stdoutLineParts.push(part);
      stdoutLineChars += part.length;
      stdoutLineBytes += Buffer.byteLength(part, "utf8");
    };
    const takeStdoutLine = () => {
      const line = stdoutLineParts.join("");
      stdoutLineParts = [];
      stdoutLineChars = 0;
      stdoutLineBytes = 0;
      return line;
    };
    const failStdoutBufferLimit = () => {
      const stdoutBufferBytes = stdoutLineBytes;
      stdoutLineParts = [];
      stdoutLineChars = 0;
      stdoutLineBytes = 0;
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
    const processStdoutLine = (line: string): boolean => {
      const trimmedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!trimmedLine) return true;

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
          return false;
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
          return false;
        }
        if (resp.command === "prompt" && resp.success === false) {
          const error = `prompt failed${resp.error ? `: ${String(resp.error)}` : ""}`;
          telemetry.error = error;
          settle(buildResult({
            success: false,
            lastAssistantText,
            agentEndMessages,
            timedOut: false,
            error,
          }));
          return false;
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
        return !settled;
      }

      if (event.type === "agent_end") {
        const endEvent = event as { messages?: unknown[] };
        sawAgentEnd = true;
        agentEndMessages = Array.isArray(endEvent.messages) ? endEvent.messages : [];
        lastAssistantText = extractAssistantText(agentEndMessages);
        endStdin();
      }
      return !settled;
    };

    const consumeStdoutChunk = (chunk: string): boolean => {
      let segmentStart = 0;
      let newlineIndex: number;
      while ((newlineIndex = chunk.indexOf("\n", segmentStart)) !== -1) {
        appendStdoutLinePart(chunk.slice(segmentStart, newlineIndex));
        if (stdoutLineChars > STDOUT_LINE_MAX_CHARS) {
          failStdoutBufferLimit();
          return false;
        }
        const line = takeStdoutLine();
        segmentStart = newlineIndex + 1;
        if (!processStdoutLine(line)) return false;
      }

      appendStdoutLinePart(chunk.slice(segmentStart));
      if (stdoutLineChars > STDOUT_LINE_MAX_CHARS) {
        failStdoutBufferLimit();
        return false;
      }
      return true;
    };

    let stdoutEnded = false;
    const flushStdout = () => {
      if (stdoutEnded || settled) return;
      stdoutEnded = true;
      if (!consumeStdoutChunk(stdoutDecoder.end()) || settled || stdoutLineChars === 0) return;
      processStdoutLine(takeStdoutLine());
    };

    childProcess.stdout?.on("data", (data: Buffer) => {
      if (settled) return;
      consumeStdoutChunk(stdoutDecoder.write(data));
    });
    childProcess.stdout?.on("end", flushStdout);

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
      flushStdout();
      if (settled) return;
      telemetry.exitedAt = nowIso();
      telemetry.exitCode = code;
      telemetry.exitSignal = signal;

      const promptAckError = promptSent
        ? promptAcknowledged
          ? undefined
          : "Subprocess exited without acknowledging prompt"
        : "Subprocess exited before prompt could be sent";
      const closeError =
        code !== 0 && code !== null
          ? `Subprocess exited with code ${code}${stderrText ? `: ${stderrText.slice(0, 200)}` : ""}`
          : signal
            ? `Subprocess exited due to signal ${signal}${stderrText ? `: ${stderrText.slice(0, 200)}` : ""}`
            : promptAckError
              ? promptAckError
              : sawAgentEnd
                ? undefined
                : "Subprocess exited without sending agent_end";
      if (closeError) telemetry.error = closeError;

      settle(buildResult({
        success: sawAgentEnd && promptAcknowledged && code === 0 && signal === null,
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
        startIterationTimeout();
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
      settle(buildResult({
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