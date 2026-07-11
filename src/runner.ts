import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  inspectDraftContent,
  renderRalphBody,
  renderIterationPrompt,
  resolveCompletionGateMode,
  shouldStopForCompletionPromise,
  validateRuntimeArgs,
  type CommandDef,
  type CommandOutput,
  type Frontmatter,
  type RuntimeArgs,
} from "./ralph.ts";
import {
  type CommandOutcomeRecord,
  type CompletionRecord,
  type ActiveLoopRegistryEntry,
  type IterationRecord,
  type ProgressState,
  type RunnerEvent,
  type RunnerStatus,
  type RunnerStatusFile,
  appendIterationRecord,
  appendRunnerEvent,
  checkCancelSignal,
  checkStopSignal,
  clearCancelSignal,
  clearStopSignal,
  ensureRunnerDir,
  recordActiveLoopStopObservation,
  writeActiveLoopRegistryEntry,
  writeIterationTranscript,
  writeStatusFile,
} from "./runner-state.ts";
import {
  type RpcSubprocessResult,
  runRpcIteration,
} from "./runner-rpc.ts";
import { writeRalphFinalSummary } from "./runner-summary.ts";
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync as readFileSyncForSnapshot,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

// --- Types ---

export type RunnerConfig = {
  ralphPath: string;
  cwd: string;
  /** Stable token supplied by the owning session; generated when omitted. */
  loopToken?: string;
  timeout: number;
  maxIterations: number;
  /** Error policy: true = stop on error (default), false = continue on error */
  stopOnError?: boolean;
  /** Completion promise string from RALPH.md */
  completionPromise?: string;
  guardrails: Frontmatter["guardrails"];
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
    guardrails: Frontmatter["guardrails"],
    pi: unknown,
    cwd?: string,
    taskDir?: string,
    runtimeArgs?: RuntimeArgs,
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
  if (!existsSync(progressPath) || !isRealRegularFileUnderTaskDir(taskDir, RALPH_PROGRESS_FILE)) return undefined;
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

async function waitForInterIterationDelay(taskDir: string, cwd: string, loopToken: string, delaySeconds: number): Promise<boolean> {
  const delayMs = delaySeconds * 1000;
  if (delayMs <= 0) return false;

  const pollIntervalMs = Math.min(INTER_ITERATION_DELAY_POLL_INTERVAL_MS, delayMs);
  let remainingMs = delayMs;

  while (remainingMs > 0) {
    if (checkStopSignal(taskDir, loopToken)) {
      recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), loopToken);
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

const COMMAND_OUTPUT_PREVIEW_MAX_CHARS = 500;

function previewCommandOutput(output: string): string {
  if (output.length <= COMMAND_OUTPUT_PREVIEW_MAX_CHARS) return output;
  const headLength = Math.floor((COMMAND_OUTPUT_PREVIEW_MAX_CHARS - 32) / 2);
  const tailLength = COMMAND_OUTPUT_PREVIEW_MAX_CHARS - 32 - headLength;
  return `${output.slice(0, headLength)}\n...[truncated]...\n${output.slice(output.length - tailLength)}`;
}

function commandOutcomeRecords(outputs: CommandOutput[]): CommandOutcomeRecord[] {
  return outputs.map((output) => {
    const record: CommandOutcomeRecord = {
      name: output.name,
      status: output.status ?? "ok",
      ...(output.acceptance ? { acceptance: true } : {}),
      ...(output.blockedPattern ? { blockedPattern: output.blockedPattern } : {}),
      ...(typeof output.durationMs === "number" ? { durationMs: output.durationMs } : {}),
      ...(output.outputTruncated ? { outputTruncated: true } : {}),
      ...(typeof output.outputBytes === "number" ? { outputBytes: output.outputBytes } : {}),
      outputPreview: previewCommandOutput(output.output),
    };
    return record;
  });
}

function acceptanceCoverageFailureReasons(commands: CommandDef[], outcomes: CommandOutcomeRecord[]): string[] {
  const reasons: string[] = [];
  if (outcomes.length !== commands.length) {
    reasons.push(`Acceptance command outcome count mismatch: expected ${commands.length}, got ${outcomes.length}`);
  }
  const count = Math.min(commands.length, outcomes.length);
  for (let index = 0; index < count; index += 1) {
    if (outcomes[index].name !== commands[index].name) {
      reasons.push(`Acceptance command outcome mismatch: expected ${commands[index].name}, got ${outcomes[index].name}`);
    }
  }
  return reasons;
}

function acceptanceFailureReasons(commands: CommandDef[], outcomes: CommandOutcomeRecord[]): string[] {
  return [
    ...acceptanceCoverageFailureReasons(commands, outcomes),
    ...outcomes
      .filter((outcome) => outcome.status !== "ok")
      .map((outcome) => `Acceptance command failed: ${outcome.name} (${outcome.status})`),
  ];
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
  let checkedParentIndent: number | undefined;

  const lines = raw.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const priorityHeading = line.match(/^ {0,3}(#{1,6})\s+(P0|P1)\b/i);
    if (priorityHeading) {
      currentPriority = priorityHeading[2].toUpperCase() as "P0" | "P1";
      currentPriorityDepth = priorityHeading[1].length;
      checkedParentIndent = undefined;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+/);
    if (heading && currentPriority && heading[1].length <= currentPriorityDepth) {
      currentPriority = undefined;
      currentPriorityDepth = 0;
      checkedParentIndent = undefined;
      continue;
    }

    const nextLine = lines[lineIndex + 1];
    const setextUnderline = nextLine?.match(/^ {0,3}(=+|-+)\s*$/);
    const setextHeading = setextUnderline ? line.match(/^ {0,3}(.+?)\s*$/) : undefined;
    if (setextUnderline && setextHeading) {
      const headingText = setextHeading[1].trim();
      const headingDepth = setextUnderline[1].startsWith("=") ? 1 : 2;
      const setextPriority = headingText.match(/^(P0|P1)\b/i);
      if (setextPriority) {
        currentPriority = setextPriority[1].toUpperCase() as "P0" | "P1";
        currentPriorityDepth = headingDepth;
        checkedParentIndent = undefined;
        lineIndex += 1;
        continue;
      }
      if (currentPriority && headingDepth <= currentPriorityDepth) {
        currentPriority = undefined;
        currentPriorityDepth = 0;
        checkedParentIndent = undefined;
        lineIndex += 1;
        continue;
      }
    }

    if (!currentPriority) continue;

    const bullet = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!bullet) {
      if (line.trim().length > 0) checkedParentIndent = undefined;
      continue;
    }

    const indent = bullet[1].length;
    const content = bullet[2].trim();
    if (!content) continue;
    if (checkedParentIndent !== undefined && indent <= checkedParentIndent) {
      checkedParentIndent = undefined;
    }
    const isTaskListItem = /^\[[ xX]\]\s*/.test(content);
    const isCheckedItem = /^\[[xX]\]\s*/.test(content);
    if (checkedParentIndent !== undefined && indent > checkedParentIndent && !isTaskListItem) continue;
    if (isCheckedItem) {
      checkedParentIndent = indent;
      continue;
    }

    if (currentPriority === "P0") sawP0 = true;
    if (currentPriority === "P1") sawP1 = true;
  }

  if (sawP0) reasons.push("OPEN_QUESTIONS.md still has P0 items");
  if (sawP1) reasons.push("OPEN_QUESTIONS.md still has P1 items");
  return reasons;
}

function isRealRegularFileUnderTaskDir(taskDir: string, relativePath: string): boolean {
  try {
    const realTaskDir = realpathSync(taskDir);
    const filePath = join(taskDir, relativePath);
    if (!lstatSync(filePath).isFile()) return false;

    const realFilePath = realpathSync(filePath);
    const realRelativePath = relative(realTaskDir, realFilePath);
    return realRelativePath !== "" && realRelativePath !== ".." && !realRelativePath.startsWith(`..${sep}`) && !isAbsolute(realRelativePath);
  } catch {
    return false;
  }
}

export function validateCompletionReadiness(taskDir: string, requiredOutputs: string[]): CompletionReadiness {
  const reasons: string[] = [];

  for (const requiredOutput of requiredOutputs) {
    if (requiredOutput === RALPH_PROGRESS_FILE) continue;

    if (!isRealRegularFileUnderTaskDir(taskDir, requiredOutput)) {
      addReadinessReason(reasons, `Missing required output: ${requiredOutput}`);
    }
  }

  const openQuestionsPath = join(taskDir, "OPEN_QUESTIONS.md");
  if (!isRealRegularFileUnderTaskDir(taskDir, "OPEN_QUESTIONS.md")) {
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
    loopToken: configuredLoopToken,
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
  const notify = (message: string, level: "info" | "warning" | "error"): void => {
    try {
      if (onNotify) onNotify(message, level);
    } catch {
      // UI callbacks are best-effort and must not break runner cleanup.
    }
  };
  const changeStatus = (status: RunnerStatus): void => {
    try {
      if (onStatusChange) onStatusChange(status);
    } catch {
      // UI callbacks are best-effort and must not break runner cleanup.
    }
  };
  const iterationStarted = (iteration: number, maxIterations: number): void => {
    try {
      if (onIterationStart) onIterationStart(iteration, maxIterations);
    } catch {
      // UI callbacks are best-effort and must not break the run.
    }
  };
  const iterationCompleted = (record: IterationRecord): void => {
    try {
      if (onIterationComplete) onIterationComplete(record);
    } catch {
      // UI callbacks are best-effort and must not break the run.
    }
  };
  let currentStopOnError = config.stopOnError ?? true;
  const runtimeArgs = initialRuntimeArgs;

  const taskDir = dirname(ralphPath);
  const name = basename(taskDir);
  const loopToken = configuredLoopToken ?? randomUUID();
  let currentMaxIterations = initialMaxIterations;
  let currentTimeout = timeout;
  let currentCompletionPromise = initialCompletionPromise;
  let currentCompletionGateMode: "required" | "optional" | "disabled" = initialCompletionPromise ? "required" : "disabled";
  let currentRequiredOutputs: string[] = [];
  let currentInterIterationDelay = 0;
  let currentGuardrails = initialGuardrails;
  let completionGateFailureReasons: string[] = [];
  let completionGateRejectionReasons: string[] = [];
  let noProgressStreak = 0;
  const iterations: IterationRecord[] = [];
  const startMs = Date.now();

  // Claim the task before writing task-local artifacts or starting a child.
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
    guardrails: currentGuardrails,
  };
  const registryEntryForStatus = (statusFile: RunnerStatusFile): ActiveLoopRegistryEntry => ({
    taskDir,
    ralphPath,
    cwd,
    loopToken,
    status: statusFile.status,
    currentIteration: statusFile.currentIteration,
    maxIterations: statusFile.maxIterations,
    startedAt: statusFile.startedAt,
    updatedAt: statusFile.completedAt ?? new Date().toISOString(),
  });
  const registryRoots = cwd === taskDir ? [taskDir] : [taskDir, cwd];
  const claimedRegistryRoots: string[] = [];
  let claimConflict = false;
  let claimFailure: string | undefined;
  for (const registryRoot of registryRoots) {
    try {
      if (!writeActiveLoopRegistryEntry(registryRoot, registryEntryForStatus(initialStatus))) {
        claimConflict = true;
        break;
      }
      claimedRegistryRoots.push(registryRoot);
    } catch (error) {
      claimFailure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (claimConflict || claimFailure) {
    const completedAt = new Date().toISOString();
    for (const registryRoot of claimedRegistryRoots) {
      try {
        writeActiveLoopRegistryEntry(registryRoot, registryEntryForStatus({
          ...initialStatus,
          status: "error",
          completedAt,
        }));
      } catch {
        // Best-effort release of claims already acquired.
      }
    }
    changeStatus("error");
    notify(
      claimConflict
        ? `A different Ralph run is already active for ${taskDir}.`
        : `Failed to claim active run: ${claimFailure}`,
      "error",
    );
    return { status: "error", iterations, totalDurationMs: Date.now() - startMs };
  }

  let latestRegistryStatus = initialStatus;
  const syncActiveLoopRegistry = (statusFile: RunnerStatusFile): void => {
    latestRegistryStatus = statusFile;
    for (const registryRoot of registryRoots) {
      try {
        if (!writeActiveLoopRegistryEntry(registryRoot, registryEntryForStatus(statusFile))) {
          notify(`Active-run registry ownership changed at ${registryRoot}; refresh skipped.`, "warning");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify(`Failed to refresh active run registry at ${registryRoot}: ${message}`, "warning");
      }
    }
  };
  let activeLoopHeartbeat: NodeJS.Timeout | undefined;
  try {
    ensureRunnerDir(taskDir);
    activeLoopHeartbeat = setInterval(() => {
      syncActiveLoopRegistry(latestRegistryStatus);
    }, 60_000);
    activeLoopHeartbeat.unref?.();
    writeStatusFile(taskDir, initialStatus);
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
  } catch (err) {
    clearInterval(activeLoopHeartbeat);
    const completedAt = new Date().toISOString();
    syncActiveLoopRegistry({
      ...initialStatus,
      status: "error",
      completedAt,
    });
    const message = err instanceof Error ? err.message : String(err);
    changeStatus("error");
    notify(`Failed to initialize durable state: ${message}`, "error");
    return { status: "error", iterations, totalDurationMs: Date.now() - startMs };
  }
  changeStatus("initializing");
  notify(`Ralph runner started: ${name} (max ${currentMaxIterations} iterations)`, "info");

  let finalStatus: RunnerStatus = "running";

  try {
    for (let i = 1; i <= currentMaxIterations; i++) {
      // Check stop signal from durable state
      if (checkStopSignal(taskDir, loopToken)) {
        recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), loopToken);
        finalStatus = "stopped";
        clearStopSignal(taskDir);
        break;
      }

      if (checkCancelSignal(taskDir, loopToken)) {
        recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), loopToken, "cancelled");
        clearCancelSignal(taskDir);
        finalStatus = "cancelled";
        break;
      }

      // Re-parse RALPH.md every iteration (live editing support)
      if (!existsSync(ralphPath)) {
        notify(`RALPH.md not found at ${ralphPath}, stopping runner`, "error");
        finalStatus = "error";
        break;
      }

      const raw = readFileSync(ralphPath, "utf8");
      const inspection = inspectDraftContent(raw);
      if (inspection.error) {
        notify(`Invalid RALPH.md on iteration ${i}: ${inspection.error}`, "error");
        finalStatus = "error";
        break;
      }

      const { frontmatter: fm, body: rawBody } = inspection.parsed!;
      const runtimeValidationError = validateRuntimeArgs(fm, rawBody, fm.commands, runtimeArgs);
      if (runtimeValidationError) {
        notify(`Invalid RALPH.md on iteration ${i}: ${runtimeValidationError}`, "error");
        finalStatus = "error";
        break;
      }
      currentMaxIterations = fm.maxIterations;
      currentTimeout = fm.timeout;
      currentCompletionPromise = fm.completionPromise;
      currentCompletionGateMode = resolveCompletionGateMode(fm);
      currentRequiredOutputs = fm.requiredOutputs ?? [];
      currentInterIterationDelay = fm.interIterationDelay;
      currentGuardrails = fm.guardrails;
      currentStopOnError = config.stopOnError ?? fm.stopOnError;

      // Update status to running
      const runningStatus: RunnerStatusFile = {
        ...initialStatus,
        status: "running",
        currentIteration: i,
        maxIterations: currentMaxIterations,
        timeout: currentTimeout,
        completionPromise: currentCompletionPromise,
        guardrails: currentGuardrails,
      };
      writeStatusFile(taskDir, runningStatus);
      syncActiveLoopRegistry(runningStatus);
      changeStatus("running");
      iterationStarted(i, currentMaxIterations);

      const iterStartMs = Date.now();
      const iterationAbortController = new AbortController();
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
        ? await runCommandsFn(fm.commands, currentGuardrails, pi, cwd, taskDir, runtimeArgs)
        : [];
      const commandOutcomes = commandOutcomeRecords(commandsOutput);
      const nonEmptyCommandOutcomes = commandOutcomes.length > 0 ? commandOutcomes : undefined;

      // Before snapshot
      const snapshotBefore = captureTaskDirectorySnapshot(ralphPath);

      // Render prompt
      const body = renderRalphBody(rawBody, commandsOutput, { iteration: i, name, maxIterations: currentMaxIterations }, runtimeArgs);
      const progressMemory = readProgressMemory(taskDir);
      const promptBody = progressMemory !== undefined ? `${renderProgressMemoryPrompt(progressMemory)}\n\n${body}` : body;
      const prompt = renderIterationPrompt(
        promptBody,
        i,
        currentMaxIterations,
        currentCompletionPromise && currentCompletionGateMode !== "disabled"
          ? {
              completionPromise: currentCompletionPromise,
              requiredOutputs: currentRequiredOutputs,
              completionGateMode: currentCompletionGateMode,
              failureReasons: completionGateFailureReasons,
              rejectionReasons: completionGateRejectionReasons,
            }
          : undefined,
        {
          itemsPerIteration: fm.itemsPerIteration,
          reflectEvery: fm.reflectEvery,
        },
        {
          elapsedSeconds: Math.round((Date.now() - startMs) / 1000),
          completionPromise: currentCompletionPromise,
        },
      );
      const writeIterationTranscriptSafe = (record: IterationRecord, assistantText?: string, note?: string) => {
        try {
          writeIterationTranscript(taskDir, { record, prompt, commandOutputs: commandsOutput, assistantText, note });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          notify(`Failed to write iteration transcript for iteration ${record.iteration}: ${message}`, "warning");
        }
      };

      // Run RPC iteration
      notify(`Iteration ${i}/${currentMaxIterations} starting`, "info");

      const cancelPollInterval = setInterval(() => {
        if (checkCancelSignal(taskDir, loopToken)) {
          iterationAbortController.abort();
        }
      }, 500);

      let rpcResult: RpcSubprocessResult;
      try {
        rpcResult = await runRpcIteration({
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
          signal: iterationAbortController.signal,
        });
      } finally {
        clearInterval(cancelPollInterval);
      }

      let iterEndMs = Date.now();

      if (rpcResult.cancelled) {
        const iterRecord: IterationRecord = {
          iteration: i,
          status: "cancelled",
          startedAt: new Date(iterStartMs).toISOString(),
          completedAt: new Date(iterEndMs).toISOString(),
          durationMs: iterEndMs - iterStartMs,
          progress: false,
          changedFiles: [],
          noProgressStreak: noProgressStreak + 1,
          commandOutcomes: nonEmptyCommandOutcomes,
          loopToken,
          rpcTelemetry: rpcResult.telemetry,
        };
        iterations.push(iterRecord);
        appendIterationRecord(taskDir, iterRecord);
        writeIterationTranscriptSafe(iterRecord, rpcResult.lastAssistantText, "Iteration cancelled by operator");
        logRunnerEvent(taskDir, {
          type: "iteration.completed",
          timestamp: new Date(iterEndMs).toISOString(),
          iteration: i,
          loopToken,
          status: "cancelled",
          progress: iterRecord.progress,
          changedFiles: [],
          noProgressStreak: iterRecord.noProgressStreak,
          ...(iterRecord.commandOutcomes ? { commandOutcomes: iterRecord.commandOutcomes } : {}),
          reason: "operator-cancel",
        });
        recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), loopToken, "cancelled");
        clearCancelSignal(taskDir);
        finalStatus = "cancelled";
        iterationCompleted(iterRecord);
        break;
      }

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
          commandOutcomes: nonEmptyCommandOutcomes,
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
          ...(iterRecord.commandOutcomes ? { commandOutcomes: iterRecord.commandOutcomes } : {}),
          reason: rpcResult.timedOut ? "rpc-timeout" : "rpc-error",
        });

        if (rpcResult.timedOut) {
          notify(`Iteration ${i} timed out after ${currentTimeout}s`, "warning");
          if (currentStopOnError) {
            finalStatus = "timeout";
            iterationCompleted(iterRecord);
            break;
          } else {
            noProgressStreak += 1;
            notify(`Continuing (stop_on_error=false).`, "warning");
            iterationCompleted(iterRecord);
            continue;
          }
        } else {
          notify(`Iteration ${i} error: ${rpcResult.error ?? "unknown"}`, "error");
          if (currentStopOnError) {
            finalStatus = "error";
            iterationCompleted(iterRecord);
            break;
          } else {
            noProgressStreak += 1;
            notify(`Continuing (stop_on_error=false).`, "warning");
            iterationCompleted(iterRecord);
            continue;
          }
        }
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
      if (completionPromiseMatched && currentCompletionGateMode !== "disabled") {
        completionGate = validateCompletionReadiness(taskDir, currentRequiredOutputs);
        const acceptanceCommands = fm.commands.filter((command) => command.acceptance === true);
        if (completionGate.ready && currentCompletionGateMode === "required" && acceptanceCommands.length > 0) {
          if (!runCommandsFn || !pi) {
            completionGate = { ready: false, reasons: ["Acceptance commands could not be run: executor unavailable"] };
            logRunnerEvent(taskDir, {
              type: "completion.acceptance.checked",
              timestamp: new Date().toISOString(),
              iteration: i,
              loopToken,
              ready: false,
              reasons: completionGate.reasons,
              outcomes: [],
            });
          } else {
            const acceptanceOutputs = await runCommandsFn(acceptanceCommands, currentGuardrails, pi, cwd, taskDir, runtimeArgs);
            iterEndMs = Date.now();
            const acceptanceOutcomes = commandOutcomeRecords(acceptanceOutputs.map((output) => ({ ...output, acceptance: true })));
            const acceptanceReasons = acceptanceFailureReasons(acceptanceCommands, acceptanceOutcomes);
            if (completionRecord) {
              completionRecord.acceptanceOutcomes = acceptanceOutcomes;
            }
            logRunnerEvent(taskDir, {
              type: "completion.acceptance.checked",
              timestamp: new Date(iterEndMs).toISOString(),
              iteration: i,
              loopToken,
              ready: acceptanceReasons.length === 0,
              reasons: acceptanceReasons,
              outcomes: acceptanceOutcomes,
            });
            if (acceptanceReasons.length > 0) {
              completionGate = { ready: false, reasons: acceptanceReasons };
            }
          }
        }
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
          notify(`${currentCompletionGateMode === "required" ? "Completion gate blocked" : "Completion gate not ready"} on iteration ${i}: ${completionGate.reasons.join("; ")}`,
          "warning",);
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
        commandOutcomes: nonEmptyCommandOutcomes,
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
        ...(iterRecord.commandOutcomes ? { commandOutcomes: iterRecord.commandOutcomes } : {}),
        snapshotTruncated: iterRecord.snapshotTruncated,
        snapshotErrorCount: iterRecord.snapshotErrorCount,
      });

      // Notify progress
      if (progress === true) {
        notify(`Iteration ${i} durable progress: ${summarizeChangedFiles(changedFiles)}`, "info");
      } else if (progress === false) {
        notify(`Iteration ${i} made no durable progress. No-progress streak: ${noProgressStreak}.`,
        "warning",);
      } else {
        notify(`Iteration ${i} durable progress could not be verified. No-progress streak remains ${noProgressStreak}.`,
        "warning",);
      }

      iterationCompleted(iterRecord);

      // Check completion promise
      if (completionPromiseMatched) {
        const requiredCompletionGateBlocked = currentCompletionGateMode === "required" && completionGate !== undefined && !completionGate.ready;
        if (progress === false && requiredCompletionGateBlocked) {
          completionGateRejectionReasons = [
            "durable progress (no durable file changes were observed)",
            ...(completionGate?.reasons ?? []),
          ];
          notify(`Completion promise matched on iteration ${i}, but no durable progress was detected and the completion gate failed. Continuing.`,
          "warning",);
        } else if (requiredCompletionGateBlocked) {
          notify(`completion promise matched on iteration ${i}, but the completion gate failed. Continuing.`,
          "warning",);
        } else {
          completionGateRejectionReasons = [];
          if (progress === "unknown") {
            notify(`Completion promise matched on iteration ${i}, and durable progress could not be verified. Stopping.`,
            "info",);
          } else if (progress === false) {
            notify(`Completion promise matched on iteration ${i} without new durable progress; current completion criteria allow stopping.`,
            "info",);
          } else {
            notify(`Completion promise matched after durable progress on iteration ${i}`,
            "info",);
          }
          finalStatus = "complete";
          break;
        }
      }

      notify(`Iteration ${i} complete (${Math.round((iterEndMs - iterStartMs) / 1000)}s)`, "info");

      // Quick cancel check before delay
      if (checkCancelSignal(taskDir, loopToken)) {
        recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), loopToken, "cancelled");
        clearCancelSignal(taskDir);
        finalStatus = "cancelled";
        break;
      }

      if (i < currentMaxIterations && currentInterIterationDelay > 0) {
        const stoppedDuringDelay = await waitForInterIterationDelay(taskDir, cwd, loopToken, currentInterIterationDelay);
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
    notify(`Ralph runner failed: ${message}`, "error");
    finalStatus = "error";
  } finally {
    clearInterval(activeLoopHeartbeat);
    const completedAt = new Date().toISOString();
    let finalStatusFile: RunnerStatusFile = {
      ...initialStatus,
      status: finalStatus,
      currentIteration: iterations.length > 0 ? iterations[iterations.length - 1].iteration : 0,
      maxIterations: currentMaxIterations,
      timeout: currentTimeout,
      completionPromise: currentCompletionPromise,
      completedAt,
      guardrails: currentGuardrails,
    };
    try {
      writeStatusFile(taskDir, finalStatusFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finalStatus = "error";
      finalStatusFile = { ...finalStatusFile, status: finalStatus };
      notify(`Failed to write final status: ${message}`, "error");
    }
    syncActiveLoopRegistry(finalStatusFile);
    try {
      logRunnerEvent(taskDir, {
        type: "runner.finished",
        timestamp: completedAt,
        loopToken,
        status: finalStatus,
        iterations: iterations.length,
        totalDurationMs: Date.now() - startMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`Failed to write final runner event: ${message}`, "warning");
    }
    try {
      writeRalphFinalSummary(taskDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`Failed to write final Ralph summary: ${message}`, "warning");
    }
    changeStatus(finalStatus);

    const totalMs = Date.now() - startMs;
    const totalSec = Math.round(totalMs / 1000);

    switch (finalStatus) {
      case "complete":
        notify(`Ralph runner complete: completion promise matched (${totalSec}s total)`, "info");
        break;
      case "max-iterations":
        notify(`Ralph runner reached max iterations (${totalSec}s total)`, "info");
        break;
      case "no-progress-exhaustion":
        notify(`Ralph runner exhausted without verified progress (${totalSec}s total)`, "warning");
        break;
      case "stopped":
        notify(`Ralph runner stopped (${totalSec}s total)`, "info");
        break;
      case "timeout":
        notify(`Ralph runner timed out (${totalSec}s total)`, "warning");
        break;
      case "error":
        notify(`Ralph runner errored (${totalSec}s total)`, "error");
        break;
      default:
        // Cancelled or other status
        notify(`Ralph runner ended: ${finalStatus} (${totalSec}s total)`, "info");
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