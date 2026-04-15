import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  inspectDraftContent,
  renderRalphBody,
  renderIterationPrompt,
  shouldStopForCompletionPromise,
  validateRuntimeArgs,
  type CommandDef,
  type CommandOutput,
  type RuntimeArgs,
} from "./ralph.ts";
import { runCommands } from "./index.ts";
import {
  type CompletionRecord,
  type IterationRecord,
  type ProgressState,
  type RunnerEvent,
  type RunnerStatus,
  type RunnerStatusFile,
  appendIterationRecord,
  appendRunnerEvent,
  checkStopSignal,
  clearRunnerDir,
  clearStopSignal,
  ensureRunnerDir,
  readActiveLoopRegistry,
  readIterationRecords,
  readStatusFile,
  recordActiveLoopStopObservation,
  writeActiveLoopRegistryEntry,
  writeIterationTranscript,
  writeStatusFile,
} from "./runner-state.ts";
import {
  type RpcSubprocessResult,
  runRpcIteration,
} from "./runner-rpc.ts";
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync as readFileSyncForSnapshot,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

// --- Types ---

export type RunnerConfig = {
  ralphPath: string;
  cwd: string;
  timeout: number;
  maxIterations: number;
  /** Completion promise string from RALPH.md */
  completionPromise?: string;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  /** Override for the RPC spawn command, for testing */
  spawnCommand?: string;
  /** Override for the RPC spawn args, for testing */
  spawnArgs?: string[];
  /** Model pattern for RPC subprocess, e.g. "openai-codex/gpt-5.4-mini" or "anthropic/claude-sonnet-4"
   * Format: "provider/modelId" or "provider/modelId:thinkingLevel"
   * The thinking level suffix (e.g. ":high") is sent via set_thinking_level.
   */
  modelPattern?: string;
  /** Provider for set_model (overrides modelPattern provider) */
  provider?: string;
  /** ModelId for set_model (overrides modelPattern modelId) */
  modelId?: string;
  /** Thinking level for set_thinking_level: "off", "minimal", "low", "medium", "high", "xhigh" */
  thinkingLevel?: string;
  /** Callbacks */
  onIterationStart?: (iteration: number, maxIterations: number) => void;
  onIterationComplete?: (record: IterationRecord) => void;
  onStatusChange?: (status: RunnerStatus) => void;
  onNotify?: (message: string, level: "info" | "warning" | "error") => void;
  /** Extension API for running commands */
  runCommandsFn?: (
    commands: CommandDef[],
    blockPatterns: string[],
    pi: unknown,
    cwd?: string,
    taskDir?: string,
  ) => Promise<CommandOutput[]>;
  /** Extension API reference for running commands */
  pi?: unknown;
  /** Runtime args resolved from RALPH frontmatter */
  runtimeArgs?: RuntimeArgs;
};

export type RunnerResult = {
  status: RunnerStatus;
  iterations: IterationRecord[];
  totalDurationMs: number;
};

// --- Task directory snapshot ---

const SNAPSHOT_IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  ".ralph-runner",
]);

const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS = 20;
const SNAPSHOT_POST_IDLE_POLL_WINDOW_MS = 100;
const RALPH_PROGRESS_FILE = "RALPH_PROGRESS.md";
const RALPH_PROGRESS_MAX_CHARS = 4096;
const INTER_ITERATION_DELAY_POLL_INTERVAL_MS = 100;

export type WorkspaceSnapshot = {
  files: Map<string, string>;
  truncated: boolean;
  errorCount: number;
};

export type ProgressAssessment = {
  progress: ProgressState;
  changedFiles: string[];
  snapshotTruncated: boolean;
  snapshotErrorCount: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCompletionRecord(): CompletionRecord {
  return {
    promiseSeen: false,
    durableProgressObserved: false,
    gateChecked: false,
    gatePassed: false,
    gateBlocked: false,
    blockingReasons: [],
  };
}

function logRunnerEvent(taskDir: string, event: RunnerEvent): void {
  try {
    appendRunnerEvent(taskDir, event);
  } catch {
    // Event logging should not break the runner.
  }
}

function readProgressMemory(taskDir: string): string | undefined {
  const progressPath = join(taskDir, RALPH_PROGRESS_FILE);
  if (!existsSync(progressPath)) return undefined;
  try {
    const raw = readFileSync(progressPath, "utf8");
    if (raw.length <= RALPH_PROGRESS_MAX_CHARS) return raw;
    return `${raw.slice(0, RALPH_PROGRESS_MAX_CHARS)}\n[truncated]`;
  } catch {
    return undefined;
  }
}

function renderProgressMemoryPrompt(progressMemory: string): string {
  return [
    "[RALPH_PROGRESS.md]",
    "Use this file for a short rolling memory. Keep it short and overwrite in place.",
    "",
    progressMemory,
  ].join("\n");
}

async function waitForInterIterationDelay(taskDir: string, cwd: string, delaySeconds: number): Promise<boolean> {
  const delayMs = delaySeconds * 1000;
  if (delayMs <= 0) return false;

  const pollIntervalMs = Math.min(INTER_ITERATION_DELAY_POLL_INTERVAL_MS, delayMs);
  let remainingMs = delayMs;

  while (remainingMs > 0) {
    if (checkStopSignal(taskDir)) {
      recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString());
      clearStopSignal(taskDir);
      return true;
    }
    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    await delay(sleepMs);
    remainingMs -= sleepMs;
  }

  return false;
}

function normalizeSnapshotPath(filePath: string): string {
  return filePath.split("\\").join("/");
}

export function captureTaskDirectorySnapshot(ralphPath: string): WorkspaceSnapshot {
  const taskDir = dirname(ralphPath);
  const files = new Map<string, string>();
  let truncated = false;
  let bytesRead = 0;
  let errorCount = 0;

  const progressMemoryPath = join(taskDir, RALPH_PROGRESS_FILE);

  const walk = (dirPath: string) => {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      errorCount += 1;
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || fullPath === ralphPath || fullPath === progressMemoryPath) continue;
      if (files.size >= SNAPSHOT_MAX_FILES) {
        truncated = true;
        return;
      }

      const relPath = normalizeSnapshotPath(relative(taskDir, fullPath));
      if (!relPath || relPath.startsWith("..")) continue;

      let content;
      try {
        content = readFileSyncForSnapshot(fullPath);
      } catch {
        errorCount += 1;
        continue;
      }
      if (bytesRead + content.byteLength > SNAPSHOT_MAX_BYTES) {
        truncated = true;
        return;
      }

      bytesRead += content.byteLength;
      files.set(relPath, `${content.byteLength}:${createHash("sha1").update(content).digest("hex")}`);
    }
  };

  if (existsSync(taskDir)) walk(taskDir);
  return { files, truncated, errorCount };
}

function diffTaskDirectorySnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const [filePath, fingerprint] of before.files) {
    if (after.files.get(filePath) !== fingerprint) changed.add(filePath);
  }
  for (const filePath of after.files.keys()) {
    if (!before.files.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort((a, b) => a.localeCompare(b));
}

export async function assessTaskDirectoryProgress(
  ralphPath: string,
  before: WorkspaceSnapshot,
): Promise<ProgressAssessment> {
  let after = captureTaskDirectorySnapshot(ralphPath);
  let changedFiles = diffTaskDirectorySnapshots(before, after);
  let snapshotTruncated = before.truncated || after.truncated;
  let snapshotErrorCount = before.errorCount + after.errorCount;

  if (changedFiles.length > 0) {
    return { progress: true, changedFiles, snapshotTruncated, snapshotErrorCount };
  }

  for (
    let remainingMs = SNAPSHOT_POST_IDLE_POLL_WINDOW_MS;
    remainingMs > 0;
    remainingMs -= SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS
  ) {
    await delay(Math.min(SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS, remainingMs));
    after = captureTaskDirectorySnapshot(ralphPath);
    changedFiles = diffTaskDirectorySnapshots(before, after);
    snapshotTruncated ||= after.truncated;
    snapshotErrorCount += after.errorCount;
    if (changedFiles.length > 0) {
      return { progress: true, changedFiles, snapshotTruncated, snapshotErrorCount };
    }
  }

  return {
    progress: snapshotTruncated || snapshotErrorCount > 0 ? "unknown" : false,
    changedFiles,
    snapshotTruncated,
    snapshotErrorCount,
  };
}

export function summarizeChangedFiles(changedFiles: string[]): string {
  if (changedFiles.length === 0) return "none";
  const visible = changedFiles.slice(0, 5);
  if (visible.length === changedFiles.length) return visible.join(", ");
  return `${visible.join(", ")} (+${changedFiles.length - visible.length} more)`;
}

export type CompletionReadiness = {
  ready: boolean;
  reasons: string[];
};

function addReadinessReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function collectOpenQuestionsBlockingReasons(raw: string): string[] {
  const reasons: string[] = [];
  let currentPriority: "P0" | "P1" | undefined;
  let currentPriorityDepth = 0;
  let sawP0 = false;
  let sawP1 = false;

  for (const line of raw.split(/\r?\n/)) {
    const priorityHeading = line.match(/^(#{1,6})\s+(P0|P1)\b/i);
    if (priorityHeading) {
      currentPriority = priorityHeading[2].toUpperCase() as "P0" | "P1";
      currentPriorityDepth = priorityHeading[1].length;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+/);
    if (heading && currentPriority && heading[1].length <= currentPriorityDepth) {
      currentPriority = undefined;
      currentPriorityDepth = 0;
      continue;
    }

    if (!currentPriority) continue;

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!bullet) continue;

    const content = bullet[1].trim();
    if (!content || /^\[[xX]\]\s*/.test(content)) continue;

    if (currentPriority === "P0") sawP0 = true;
    if (currentPriority === "P1") sawP1 = true;
  }

  if (sawP0) reasons.push("OPEN_QUESTIONS.md still has P0 items");
  if (sawP1) reasons.push("OPEN_QUESTIONS.md still has P1 items");
  return reasons;
}

export function validateCompletionReadiness(taskDir: string, requiredOutputs: string[]): CompletionReadiness {
  const reasons: string[] = [];

  for (const requiredOutput of requiredOutputs) {
    const filePath = join(taskDir, requiredOutput);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      addReadinessReason(reasons, `Missing required output: ${requiredOutput}`);
    }
  }

  const openQuestionsPath = join(taskDir, "OPEN_QUESTIONS.md");
  if (!existsSync(openQuestionsPath) || !statSync(openQuestionsPath).isFile()) {
    addReadinessReason(reasons, "Missing OPEN_QUESTIONS.md");
  } else {
    try {
      const raw = readFileSync(openQuestionsPath, "utf8");
      for (const reason of collectOpenQuestionsBlockingReasons(raw)) {
        addReadinessReason(reasons, reason);
      }
    } catch {
      addReadinessReason(reasons, "Missing OPEN_QUESTIONS.md");
    }
  }

  return { ready: reasons.length === 0, reasons };
}

// --- Core Runner ---

export async function runRalphLoop(config: RunnerConfig): Promise<RunnerResult> {
  const {
    ralphPath,
    cwd,
    timeout,
    maxIterations: initialMaxIterations,
    completionPromise: initialCompletionPromise,
    guardrails: initialGuardrails,
    spawnCommand,
    spawnArgs,
    onIterationStart,
    onIterationComplete,
    onStatusChange,
    onNotify,
    runCommandsFn,
    pi,
    runtimeArgs: initialRuntimeArgs = {},
  } = config;
  const runtimeArgs = initialRuntimeArgs;

  const taskDir = dirname(ralphPath);
  const name = basename(taskDir);
  const loopToken = randomUUID();
  let currentMaxIterations = initialMaxIterations;
  let currentTimeout = timeout;
  let currentCompletionPromise = initialCompletionPromise;
  let currentRequiredOutputs: string[] = [];
  let currentInterIterationDelay = 0;
  let currentGuardrails = initialGuardrails;
  let completionGateFailureReasons: string[] = [];
  let completionGateRejectionReasons: string[] = [];
  let noProgressStreak = 0;
  const iterations: IterationRecord[] = [];
  const startMs = Date.now();

  // Initialize durable state
  ensureRunnerDir(taskDir);
  const initialStatus: RunnerStatusFile = {
    loopToken,
    ralphPath,
    taskDir,
    cwd,
    status: "initializing",
    currentIteration: 0,
    maxIterations: currentMaxIterations,
    timeout: currentTimeout,
    completionPromise: currentCompletionPromise,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: currentGuardrails.blockCommands, protectedFiles: currentGuardrails.protectedFiles },
  };
  let latestRegistryStatus = initialStatus;
  const syncActiveLoopRegistry = (statusFile: RunnerStatusFile): void => {
    latestRegistryStatus = statusFile;
    const existing = readActiveLoopRegistry(cwd).find((entry) => entry.taskDir === taskDir && entry.loopToken === loopToken);
    writeActiveLoopRegistryEntry(cwd, {
      taskDir,
      ralphPath,
      cwd,
      loopToken,
      status: statusFile.status,
      currentIteration: statusFile.currentIteration,
      maxIterations: statusFile.maxIterations,
      startedAt: statusFile.startedAt,
      updatedAt: statusFile.completedAt ?? new Date().toISOString(),
      stopRequestedAt: existing?.stopRequestedAt,
      stopObservedAt: existing?.stopObservedAt,
    });
  };
  const activeLoopHeartbeat = setInterval(() => {
    syncActiveLoopRegistry(latestRegistryStatus);
  }, 60_000);
  activeLoopHeartbeat.unref?.();
  writeStatusFile(taskDir, initialStatus);
  syncActiveLoopRegistry(initialStatus);
  logRunnerEvent(taskDir, {
    type: "runner.started",
    timestamp: initialStatus.startedAt,
    loopToken,
    cwd,
    taskDir,
    status: "initializing",
    maxIterations: currentMaxIterations,
    timeout: currentTimeout,
    completionPromise: currentCompletionPromise,
    guardrails: currentGuardrails,
  });
  onStatusChange?.("initializing");
  onNotify?.(`Ralph runner started: ${name} (max ${currentMaxIterations} iterations)`, "info");

  let finalStatus: RunnerStatus = "running";

  try {
    for (let i = 1; i <= currentMaxIterations; i++) {
      // Check stop signal from durable state
      if (checkStopSignal(taskDir)) {
        recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString());
        finalStatus = "stopped";
        clearStopSignal(taskDir);
        break;
      }

      // Re-parse RALPH.md every iteration (live editing support)
      if (!existsSync(ralphPath)) {
        onNotify?.(`RALPH.md not found at ${ralphPath}, stopping runner`, "error");
        finalStatus = "error";
        break;
      }

      const raw = readFileSync(ralphPath, "utf8");
      const inspection = inspectDraftContent(raw);
      if (inspection.error) {
        onNotify?.(`Invalid RALPH.md on iteration ${i}: ${inspection.error}`, "error");
        finalStatus = "error";
        break;
      }

      const { frontmatter: fm, body: rawBody } = inspection.parsed!;
      const runtimeValidationError = validateRuntimeArgs(fm, rawBody, fm.commands, runtimeArgs);
      if (runtimeValidationError) {
        onNotify?.(`Invalid RALPH.md on iteration ${i}: ${runtimeValidationError}`, "error");
        finalStatus = "error";
        break;
      }
      currentMaxIterations = fm.maxIterations;
      currentTimeout = fm.timeout;
      currentCompletionPromise = fm.completionPromise;
      currentRequiredOutputs = fm.requiredOutputs ?? [];
      currentInterIterationDelay = fm.interIterationDelay;
      currentGuardrails = { blockCommands: fm.guardrails.blockCommands, protectedFiles: fm.guardrails.protectedFiles };

      // Update status to running
      const runningStatus: RunnerStatusFile = {
        ...initialStatus,
        status: "running",
        currentIteration: i,
        maxIterations: currentMaxIterations,
        timeout: currentTimeout,
        completionPromise: currentCompletionPromise,
        guardrails: { blockCommands: currentGuardrails.blockCommands, protectedFiles: currentGuardrails.protectedFiles },
      };
      writeStatusFile(taskDir, runningStatus);
      syncActiveLoopRegistry(runningStatus);
      onStatusChange?.("running");
      onIterationStart?.(i, currentMaxIterations);

      const iterStartMs = Date.now();
      const completionRecord = currentCompletionPromise ? createCompletionRecord() : undefined;
      logRunnerEvent(taskDir, {
        type: "iteration.started",
        timestamp: new Date(iterStartMs).toISOString(),
        iteration: i,
        loopToken,
        status: "running",
        maxIterations: currentMaxIterations,
        timeout: currentTimeout,
        completionPromise: currentCompletionPromise,
      });

      // Run commands
      const commandsOutput: CommandOutput[] = runCommandsFn && pi
        ? await runCommandsFn(fm.commands, currentGuardrails.blockCommands, pi, cwd, taskDir)
        : [];

      // Before snapshot
      const snapshotBefore = captureTaskDirectorySnapshot(ralphPath);

      // Render prompt
      const body = renderRalphBody(rawBody, commandsOutput, { iteration: i, name, maxIterations: currentMaxIterations }, runtimeArgs);
      const progressMemory = readProgressMemory(taskDir);
      const promptBody = progressMemory !== undefined ? `${renderProgressMemoryPrompt(progressMemory)}\n\n${body}` : body;
      const prompt = renderIterationPrompt(promptBody, i, currentMaxIterations, currentCompletionPromise ? { completionPromise: currentCompletionPromise, requiredOutputs: currentRequiredOutputs, failureReasons: completionGateFailureReasons, rejectionReasons: completionGateRejectionReasons } : undefined);
      const writeIterationTranscriptSafe = (record: IterationRecord, assistantText?: string, note?: string) => {
        try {
          writeIterationTranscript(taskDir, { record, prompt, commandOutputs: commandsOutput, assistantText, note });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onNotify?.(`Failed to write iteration transcript for iteration ${record.iteration}: ${message}`, "warning");
        }
      };

      // Run RPC iteration
      onNotify?.(`Iteration ${i}/${currentMaxIterations} starting`, "info");

      const rpcResult = await runRpcIteration({
        prompt,
        cwd,
        timeoutMs: currentTimeout * 1000,
        spawnCommand,
        spawnArgs,
        env: {
          RALPH_RUNNER_TASK_DIR: taskDir,
          RALPH_RUNNER_CWD: cwd,
          RALPH_RUNNER_LOOP_TOKEN: loopToken,
          RALPH_RUNNER_CURRENT_ITERATION: String(i),
          RALPH_RUNNER_MAX_ITERATIONS: String(currentMaxIterations),
          RALPH_RUNNER_NO_PROGRESS_STREAK: String(noProgressStreak),
          RALPH_RUNNER_GUARDRAILS: JSON.stringify(currentGuardrails),
        },
        modelPattern: config.modelPattern,
        provider: config.provider,
        modelId: config.modelId,
        thinkingLevel: config.thinkingLevel,
      });

      const iterEndMs = Date.now();

      // Handle RPC failure
      if (!rpcResult.success) {
        const iterRecord: IterationRecord = {
          iteration: i,
          status: rpcResult.timedOut ? "timeout" : "error",
          startedAt: new Date(iterStartMs).toISOString(),
          completedAt: new Date(iterEndMs).toISOString(),
          durationMs: iterEndMs - iterStartMs,
          progress: false,
          changedFiles: [],
          noProgressStreak: noProgressStreak + 1,
          completion: completionRecord,
          loopToken,
          rpcTelemetry: rpcResult.telemetry,
        };
        iterations.push(iterRecord);
        appendIterationRecord(taskDir, iterRecord);
        writeIterationTranscriptSafe(
          iterRecord,
          undefined,
          rpcResult.timedOut
            ? `Timed out after ${currentTimeout}s waiting for the RPC subprocess.`
            : `RPC subprocess error: ${rpcResult.error ?? "unknown"}`,
        );
        logRunnerEvent(taskDir, {
          type: "iteration.completed",
          timestamp: new Date(iterEndMs).toISOString(),
          iteration: i,
          loopToken,
          status: rpcResult.timedOut ? "timeout" : "error",
          progress: iterRecord.progress,
          changedFiles: iterRecord.changedFiles,
          noProgressStreak: iterRecord.noProgressStreak,
          completion: iterRecord.completion,
          reason: rpcResult.timedOut ? "rpc-timeout" : "rpc-error",
        });

        if (rpcResult.timedOut) {
          onNotify?.(`Iteration ${i} timed out after ${currentTimeout}s`, "warning");
          finalStatus = "timeout";
        } else {
          onNotify?.(`Iteration ${i} error: ${rpcResult.error ?? "unknown"}`, "error");
          finalStatus = "error";
        }
        onIterationComplete?.(iterRecord);
        break;
      }

      // After snapshot
      const { progress, changedFiles, snapshotTruncated, snapshotErrorCount } =
        await assessTaskDirectoryProgress(ralphPath, snapshotBefore);

      // Update no-progress streak
      if (progress === true) {
        noProgressStreak = 0;
        completionGateRejectionReasons = [];
      } else if (progress === false) {
        noProgressStreak += 1;
      }
      // "unknown" doesn't increment streak

      if (completionRecord) {
        completionRecord.durableProgressObserved = progress === true;
        if (progress === true) {
          logRunnerEvent(taskDir, {
            type: "durable.progress.observed",
            timestamp: new Date(iterEndMs).toISOString(),
            iteration: i,
            loopToken,
            progress: true,
            changedFiles,
            snapshotTruncated,
            snapshotErrorCount,
          });
        } else if (progress === false) {
          logRunnerEvent(taskDir, {
            type: "durable.progress.missing",
            timestamp: new Date(iterEndMs).toISOString(),
            iteration: i,
            loopToken,
            progress: false,
            changedFiles,
            snapshotTruncated,
            snapshotErrorCount,
          });
        } else {
          logRunnerEvent(taskDir, {
            type: "durable.progress.unknown",
            timestamp: new Date(iterEndMs).toISOString(),
            iteration: i,
            loopToken,
            progress: "unknown",
            changedFiles,
            snapshotTruncated,
            snapshotErrorCount,
          });
        }
      }

      // Check completion promise
      let completionPromiseMatched = false;
      if (currentCompletionPromise) {
        for (const msg of rpcResult.agentEndMessages) {
          if (
            typeof msg === "object" &&
            msg !== null &&
            "role" in msg &&
            (msg as Record<string, unknown>).role === "assistant" &&
            "content" in msg
          ) {
            const content = (msg as Record<string, unknown>).content;
            let text = "";
            if (Array.isArray(content)) {
              text = content
                .filter(
                  (block: unknown) =>
                    typeof block === "object" &&
                    block !== null &&
                    "type" in block &&
                    (block as Record<string, unknown>).type === "text" &&
                    "text" in block,
                )
                .map((block: Record<string, unknown>) => String(block.text))
                .join("");
            } else if (typeof content === "string") {
              text = content;
            }
            if (shouldStopForCompletionPromise(text, currentCompletionPromise)) {
              completionPromiseMatched = true;
              if (completionRecord) {
                completionRecord.promiseSeen = true;
                logRunnerEvent(taskDir, {
                  type: "completion_promise_seen",
                  timestamp: new Date(iterEndMs).toISOString(),
                  iteration: i,
                  loopToken,
                  completionPromise: currentCompletionPromise,
                });
              }
              break;
            }
          }
        }
      }

      let completionGate: CompletionReadiness | undefined;
      if (completionPromiseMatched && progress !== false) {
        completionGate = validateCompletionReadiness(taskDir, currentRequiredOutputs);
        if (completionRecord) {
          completionRecord.gateChecked = true;
          completionRecord.gatePassed = completionGate.ready;
          completionRecord.gateBlocked = !completionGate.ready;
          completionRecord.blockingReasons = completionGate.reasons;
          logRunnerEvent(taskDir, {
            type: "completion.gate.checked",
            timestamp: new Date(iterEndMs).toISOString(),
            iteration: i,
            loopToken,
            ready: completionGate.ready,
            reasons: completionGate.reasons,
          });
          if (completionGate.ready) {
            logRunnerEvent(taskDir, {
              type: "completion_gate_passed",
              timestamp: new Date(iterEndMs).toISOString(),
              iteration: i,
              loopToken,
              ready: true,
              reasons: completionGate.reasons,
            });
          } else {
            logRunnerEvent(taskDir, {
              type: "completion_gate_blocked",
              timestamp: new Date(iterEndMs).toISOString(),
              iteration: i,
              loopToken,
              ready: false,
              reasons: completionGate.reasons,
            });
          }
        }
        if (!completionGate.ready) {
          completionGateFailureReasons = completionGate.reasons;
          onNotify?.(
            `Completion gate blocked on iteration ${i}: ${completionGate.reasons.join("; ")}`,
            "warning",
          );
        } else {
          completionGateFailureReasons = [];
        }
      }

      // Build iteration record
      const iterRecord: IterationRecord = {
        iteration: i,
        status: "complete",
        startedAt: new Date(iterStartMs).toISOString(),
        completedAt: new Date(iterEndMs).toISOString(),
        durationMs: iterEndMs - iterStartMs,
        progress,
        changedFiles,
        noProgressStreak,
        loopToken,
        completionPromiseMatched: completionPromiseMatched || undefined,
        completionGate,
        completion: completionRecord,
        snapshotTruncated,
        snapshotErrorCount,
        rpcTelemetry: rpcResult.telemetry,
      };
      iterations.push(iterRecord);
      appendIterationRecord(taskDir, iterRecord);
      writeIterationTranscriptSafe(iterRecord, rpcResult.lastAssistantText);
      logRunnerEvent(taskDir, {
        type: "iteration.completed",
        timestamp: new Date(iterEndMs).toISOString(),
        iteration: i,
        loopToken,
        status: "complete",
        progress: iterRecord.progress,
        changedFiles: iterRecord.changedFiles,
        noProgressStreak: iterRecord.noProgressStreak,
        completionPromiseMatched: iterRecord.completionPromiseMatched,
        completionGate: iterRecord.completionGate,
        completion: iterRecord.completion,
        snapshotTruncated: iterRecord.snapshotTruncated,
        snapshotErrorCount: iterRecord.snapshotErrorCount,
      });

      // Notify progress
      if (progress === true) {
        onNotify?.(`Iteration ${i} durable progress: ${summarizeChangedFiles(changedFiles)}`, "info");
      } else if (progress === false) {
        onNotify?.(
          `Iteration ${i} made no durable progress. No-progress streak: ${noProgressStreak}.`,
          "warning",
        );
      } else {
        onNotify?.(
          `Iteration ${i} durable progress could not be verified. No-progress streak remains ${noProgressStreak}.`,
          "warning",
        );
      }

      onIterationComplete?.(iterRecord);

      // Check completion promise
      if (completionPromiseMatched) {
        if (progress === false) {
          completionGateRejectionReasons = ["durable progress (no durable file changes were observed)"];
          onNotify?.(
            `Completion promise matched on iteration ${i}, but no durable progress was detected. Continuing.`,
            "warning",
          );
        } else if (completionGate && !completionGate.ready) {
          onNotify?.(
            `completion promise matched on iteration ${i}, but the completion gate failed. Continuing.`,
            "warning",
          );
        } else {
          if (progress === "unknown") {
            onNotify?.(
              `Completion promise matched on iteration ${i}, and durable progress could not be verified. Stopping.`,
              "info",
            );
          } else {
            onNotify?.(
              `Completion promise matched after durable progress on iteration ${i}`,
              "info",
            );
          }
          finalStatus = "complete";
          break;
        }
      }

      onNotify?.(`Iteration ${i} complete (${Math.round((iterEndMs - iterStartMs) / 1000)}s)`, "info");

      if (i < currentMaxIterations && currentInterIterationDelay > 0) {
        const stoppedDuringDelay = await waitForInterIterationDelay(taskDir, cwd, currentInterIterationDelay);
        if (stoppedDuringDelay) {
          finalStatus = "stopped";
          break;
        }
      }
    }

    // Determine final status if loop completed without break
    if (finalStatus === "running") {
      const hadConfirmedProgress = iterations.some((r) => r.progress === true);
      finalStatus = hadConfirmedProgress ? "max-iterations" : "no-progress-exhaustion";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onNotify?.(`Ralph runner failed: ${message}`, "error");
    finalStatus = "error";
  } finally {
    clearInterval(activeLoopHeartbeat);
    // Write final status
    const completedAt = new Date().toISOString();
    const finalStatusFile: RunnerStatusFile = {
      ...initialStatus,
      status: finalStatus,
      currentIteration: iterations.length > 0 ? iterations[iterations.length - 1].iteration : 0,
      completedAt,
    };
    writeStatusFile(taskDir, finalStatusFile);
    syncActiveLoopRegistry(finalStatusFile);
    logRunnerEvent(taskDir, {
      type: "runner.finished",
      timestamp: completedAt,
      loopToken,
      status: finalStatus,
      iterations: iterations.length,
      totalDurationMs: Date.now() - startMs,
    });
    onStatusChange?.(finalStatus);

    const totalMs = Date.now() - startMs;
    const totalSec = Math.round(totalMs / 1000);

    switch (finalStatus) {
      case "complete":
        onNotify?.(`Ralph runner complete: completion promise matched (${totalSec}s total)`, "info");
        break;
      case "max-iterations":
        onNotify?.(`Ralph runner reached max iterations (${totalSec}s total)`, "info");
        break;
      case "no-progress-exhaustion":
        onNotify?.(`Ralph runner exhausted without verified progress (${totalSec}s total)`, "warning");
        break;
      case "stopped":
        onNotify?.(`Ralph runner stopped (${totalSec}s total)`, "info");
        break;
      case "timeout":
        onNotify?.(`Ralph runner timed out (${totalSec}s total)`, "warning");
        break;
      case "error":
        onNotify?.(`Ralph runner errored (${totalSec}s total)`, "error");
        break;
      default:
        // Cancelled or other status
        onNotify?.(`Ralph runner ended: ${finalStatus} (${totalSec}s total)`, "info");
        break;
    }

    // Don't clear runner dir - keep for diagnostics
  }

  return {
    status: finalStatus,
    iterations,
    totalDurationMs: Date.now() - startMs,
  };
}