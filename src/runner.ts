import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseRalphMarkdown,
  validateFrontmatter,
  renderRalphBody,
  renderIterationPrompt,
  shouldStopForCompletionPromise,
  type CommandDef,
  type CommandOutput,
  type Frontmatter,
} from "./ralph.ts";
import { runCommands } from "./index.ts";
import {
  type IterationRecord,
  type ProgressState,
  type RunnerStatus,
  type RunnerStatusFile,
  appendIterationRecord,
  checkStopSignal,
  clearRunnerDir,
  clearStopSignal,
  ensureRunnerDir,
  readIterationRecords,
  readStatusFile,
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
  /** Callbacks */
  onIterationStart?: (iteration: number, maxIterations: number) => void;
  onIterationComplete?: (record: IterationRecord) => void;
  onStatusChange?: (status: RunnerStatus) => void;
  onNotify?: (message: string, level: "info" | "warning" | "error") => void;
  /** Extension API for running commands */
  runCommandsFn?: (commands: CommandDef[], blockPatterns: string[], pi: unknown) => Promise<CommandOutput[]>;
  /** Extension API reference for running commands */
  pi?: unknown;
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

function normalizeSnapshotPath(filePath: string): string {
  return filePath.split("\\").join("/");
}

export function captureTaskDirectorySnapshot(ralphPath: string): WorkspaceSnapshot {
  const taskDir = dirname(ralphPath);
  const files = new Map<string, string>();
  let truncated = false;
  let bytesRead = 0;
  let errorCount = 0;

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
      if (!entry.isFile() || fullPath === ralphPath) continue;
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
  const snapshotTruncated = before.truncated || after.truncated;
  const snapshotErrorCount = before.errorCount + after.errorCount;

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
  } = config;

  const taskDir = dirname(ralphPath);
  const name = basename(taskDir);
  const loopToken = randomUUID();
  let currentMaxIterations = initialMaxIterations;
  let currentTimeout = timeout;
  let currentCompletionPromise = initialCompletionPromise;
  let currentGuardrails = initialGuardrails;
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
  writeStatusFile(taskDir, initialStatus);
  onStatusChange?.("initializing");
  onNotify?.(`Ralph runner started: ${name} (max ${currentMaxIterations} iterations)`, "info");

  let finalStatus: RunnerStatus = "running";

  try {
    for (let i = 1; i <= currentMaxIterations; i++) {
      // Check stop signal from durable state
      if (checkStopSignal(taskDir)) {
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
      const draftError = validateFrontmatter(parseRalphMarkdown(raw).frontmatter);
      if (draftError) {
        onNotify?.(`Invalid RALPH.md on iteration ${i}: ${draftError}`, "error");
        finalStatus = "error";
        break;
      }

      const { frontmatter: fm, body: rawBody } = parseRalphMarkdown(raw);
      currentMaxIterations = fm.maxIterations;
      currentTimeout = fm.timeout;
      currentCompletionPromise = fm.completionPromise;
      currentGuardrails = { blockCommands: fm.guardrails.blockCommands, protectedFiles: fm.guardrails.protectedFiles };

      // Update status to running
      writeStatusFile(taskDir, {
        ...initialStatus,
        status: "running",
        currentIteration: i,
        maxIterations: currentMaxIterations,
        timeout: currentTimeout,
        completionPromise: currentCompletionPromise,
        guardrails: { blockCommands: currentGuardrails.blockCommands, protectedFiles: currentGuardrails.protectedFiles },
      });
      onStatusChange?.("running");
      onIterationStart?.(i, currentMaxIterations);

      const iterStartMs = Date.now();

      // Run commands
      const commandsOutput: CommandOutput[] = runCommandsFn && pi
        ? await runCommandsFn(fm.commands, currentGuardrails.blockCommands, pi)
        : [];

      // Before snapshot
      const snapshotBefore = captureTaskDirectorySnapshot(ralphPath);

      // Render prompt
      const body = renderRalphBody(rawBody, commandsOutput, { iteration: i, name });
      const prompt = renderIterationPrompt(body, i, currentMaxIterations);

      // Run RPC iteration
      onNotify?.(`Iteration ${i}/${currentMaxIterations} starting`, "info");

      const rpcResult = await runRpcIteration({
        prompt,
        cwd,
        timeoutMs: currentTimeout * 1000,
        spawnCommand,
        spawnArgs,
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
        };
        iterations.push(iterRecord);
        appendIterationRecord(taskDir, iterRecord);

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
      } else if (progress === false) {
        noProgressStreak += 1;
      }
      // "unknown" doesn't increment streak

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
              break;
            }
          }
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
        completionPromiseMatched: completionPromiseMatched || undefined,
        snapshotTruncated,
        snapshotErrorCount,
      };
      iterations.push(iterRecord);
      appendIterationRecord(taskDir, iterRecord);

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
          onNotify?.(
            `Completion promise matched on iteration ${i}, but no durable progress was detected. Continuing.`,
            "warning",
          );
          // Don't stop - continue iterating
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
    // Write final status
    const completedAt = new Date().toISOString();
    const finalStatusFile: RunnerStatusFile = {
      ...initialStatus,
      status: finalStatus,
      currentIteration: iterations.length > 0 ? iterations[iterations.length - 1].iteration : 0,
      completedAt,
    };
    writeStatusFile(taskDir, finalStatusFile);
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