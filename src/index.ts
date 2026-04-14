import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  buildMissionBrief,
  inspectExistingTarget,
  parseCommandArgs,
  parseRalphMarkdown,
  planTaskDraftTarget,
  renderIterationPrompt,
  renderRalphBody,
  resolveCommandRun,
  replaceArgsPlaceholders,
  runtimeArgEntriesToMap,
  shouldStopForCompletionPromise,
  shouldWarnForBashFailure,
  shouldValidateExistingDraft,
  validateDraftContent,
  validateFrontmatter as validateFrontmatterMessage,
  validateRuntimeArgs,
  createSiblingTarget,
  findBlockedCommandPattern,
} from "./ralph.ts";
import { matchesProtectedPath } from "./secret-paths.ts";
import type { CommandDef, CommandOutput, DraftPlan, DraftTarget, Frontmatter, RuntimeArgs } from "./ralph.ts";
import { createDraftPlan as createDraftPlanService } from "./ralph-draft.ts";
import type { StrengthenDraftRuntime } from "./ralph-draft-llm.ts";
import { runRalphLoop } from "./runner.ts";
import {
  checkStopSignal,
  createStopSignal,
  listActiveLoopRegistryEntries,
  readActiveLoopRegistry,
  readIterationRecords,
  readStatusFile,
  recordActiveLoopStopRequest,
  writeActiveLoopRegistryEntry,
  type ActiveLoopRegistryEntry,
} from "./runner-state.ts";

type ProgressState = boolean | "unknown";

type IterationSummary = {
  iteration: number;
  duration: number;
  progress: ProgressState;
  changedFiles: string[];
  noProgressStreak: number;
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

type LoopState = {
  active: boolean;
  ralphPath: string;
  taskDir: string;
  cwd: string;
  iteration: number;
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  stopRequested: boolean;
  noProgressStreak: number;
  iterationSummaries: IterationSummary[];
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  observedTaskDirWrites: Set<string>;
  loopToken?: string;
};
type PersistedLoopState = {
  active: boolean;
  loopToken?: string;
  cwd?: string;
  taskDir?: string;
  iteration?: number;
  maxIterations?: number;
  noProgressStreak?: number;
  iterationSummaries?: IterationSummary[];
  guardrails?: { blockCommands: string[]; protectedFiles: string[] };
  stopRequested?: boolean;
};

type ActiveLoopState = PersistedLoopState & { active: true; loopToken: string; envMalformed?: boolean };
type ActiveIterationState = ActiveLoopState & { iteration: number };

const RALPH_RUNNER_TASK_DIR_ENV = "RALPH_RUNNER_TASK_DIR";
const RALPH_RUNNER_CWD_ENV = "RALPH_RUNNER_CWD";
const RALPH_RUNNER_LOOP_TOKEN_ENV = "RALPH_RUNNER_LOOP_TOKEN";
const RALPH_RUNNER_CURRENT_ITERATION_ENV = "RALPH_RUNNER_CURRENT_ITERATION";
const RALPH_RUNNER_MAX_ITERATIONS_ENV = "RALPH_RUNNER_MAX_ITERATIONS";
const RALPH_RUNNER_NO_PROGRESS_STREAK_ENV = "RALPH_RUNNER_NO_PROGRESS_STREAK";
const RALPH_RUNNER_GUARDRAILS_ENV = "RALPH_RUNNER_GUARDRAILS";

type CommandUI = {
  input(title: string, placeholder: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, content: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(name: string, status?: string): void;
};

type CommandSessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: Array<{ type: string; text?: string }> };
};

type CommandContext = {
  cwd: string;
  hasUI: boolean;
  ui: CommandUI;
  sessionManager: {
    getEntries(): CommandSessionEntry[];
    getSessionFile(): string | undefined;
  };
  newSession(): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
  model?: StrengthenDraftRuntime["model"];
  modelRegistry?: StrengthenDraftRuntime["modelRegistry"];
};

type DraftPlanFactory = (
  task: string,
  target: DraftTarget,
  cwd: string,
  runtime?: StrengthenDraftRuntime,
) => Promise<DraftPlan>;

type RegisterRalphCommandServices = {
  createDraftPlan?: DraftPlanFactory;
  runRalphLoopFn?: typeof runRalphLoop;
};


function validateFrontmatter(fm: Frontmatter, ctx: Pick<CommandContext, "ui">): boolean {
  const error = validateFrontmatterMessage(fm);
  if (error) {
    ctx.ui.notify(error, "error");
    return false;
  }
  return true;
}

export async function runCommands(
  commands: CommandDef[],
  blockPatterns: string[],
  pi: ExtensionAPI,
  runtimeArgs: RuntimeArgs = {},
  cwd?: string,
  taskDir?: string,
): Promise<CommandOutput[]> {
  const repoCwd = cwd ?? process.cwd();
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    const semanticRun = replaceArgsPlaceholders(cmd.run, runtimeArgs);
    const blockedPattern = findBlockedCommandPattern(semanticRun, blockPatterns);
    const resolvedRun = resolveCommandRun(cmd.run, runtimeArgs);
    if (blockedPattern) {
      results.push({ name: cmd.name, output: `[blocked by guardrail: ${blockedPattern}]` });
      continue;
    }

    const commandCwd = semanticRun.trim().startsWith("./") ? taskDir ?? repoCwd : repoCwd;

    try {
      const result = await pi.exec("bash", ["-c", resolvedRun], { timeout: cmd.timeout * 1000, cwd: commandCwd });
      results.push(
        result.killed
          ? { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` }
          : { name: cmd.name, output: (result.stdout + result.stderr).trim() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: cmd.name, output: `[error: ${message}]` });
    }
  }
  return results;
}

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

type WorkspaceSnapshot = {
  files: Map<string, string>;
  truncated: boolean;
  errorCount: number;
};

type ProgressAssessment = {
  progress: ProgressState;
  changedFiles: string[];
  snapshotTruncated: boolean;
  snapshotErrorCount: number;
};

type IterationCompletion = {
  messages: CommandSessionEntry[];
  observedTaskDirWrites: Set<string>;
  error?: Error;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
  settled: boolean;
};

type PendingIterationState = {
  prompt: string;
  completion: Deferred<IterationCompletion>;
  toolCallPaths: Map<string, string>;
  observedTaskDirWrites: Set<string>;
};

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value: T) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject(reason?: unknown) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(reason);
    },
    settled: false,
  };
  return deferred;
}

function defaultLoopState(): LoopState {
  return {
    active: false,
    ralphPath: "",
    taskDir: "",
    iteration: 0,
    maxIterations: 50,
    timeout: 300,
    completionPromise: undefined,
    stopRequested: false,
    noProgressStreak: 0,
    iterationSummaries: [],
    guardrails: { blockCommands: [], protectedFiles: [] },
    observedTaskDirWrites: new Set(),
    loopToken: undefined,
    cwd: "",
  };
}

function readPersistedLoopState(ctx: Pick<CommandContext, "sessionManager">): PersistedLoopState | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === "ralph-loop-state") {
      return typeof entry.data === "object" && entry.data ? (entry.data as PersistedLoopState) : undefined;
    }
  }
  return undefined;
}

function persistLoopState(pi: ExtensionAPI, data: PersistedLoopState) {
  pi.appendEntry("ralph-loop-state", data);
}

function toPersistedLoopState(state: LoopState, overrides: Partial<PersistedLoopState> = {}): PersistedLoopState {
  return {
    active: state.active,
    loopToken: state.loopToken,
    cwd: state.cwd,
    taskDir: state.taskDir,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    noProgressStreak: state.noProgressStreak,
    iterationSummaries: state.iterationSummaries,
    guardrails: { blockCommands: state.guardrails.blockCommands, protectedFiles: state.guardrails.protectedFiles },
    stopRequested: state.stopRequested,
    ...overrides,
  };
}

function readActiveLoopState(ctx: Pick<CommandContext, "sessionManager">): ActiveLoopState | undefined {
  const state = readPersistedLoopState(ctx);
  if (state?.active !== true) return undefined;
  if (typeof state.loopToken !== "string" || state.loopToken.length === 0) return undefined;
  return state as ActiveLoopState;
}

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sanitizeGuardrails(value: unknown): { blockCommands: string[]; protectedFiles: string[] } {
  if (!value || typeof value !== "object") {
    return { blockCommands: [], protectedFiles: [] };
  }
  const guardrails = value as { blockCommands?: unknown; protectedFiles?: unknown };
  return {
    blockCommands: sanitizeStringArray(guardrails.blockCommands),
    protectedFiles: sanitizeStringArray(guardrails.protectedFiles),
  };
}

function sanitizeProgressState(value: unknown): ProgressState {
  return value === true || value === false || value === "unknown" ? value : "unknown";
}

function sanitizeIterationSummary(record: unknown, loopToken: string): IterationSummary | undefined {
  if (!record || typeof record !== "object") return undefined;
  const iterationRecord = record as {
    loopToken?: unknown;
    iteration?: unknown;
    durationMs?: unknown;
    progress?: unknown;
    changedFiles?: unknown;
    noProgressStreak?: unknown;
    snapshotTruncated?: unknown;
    snapshotErrorCount?: unknown;
  };
  if (iterationRecord.loopToken !== loopToken) return undefined;
  if (typeof iterationRecord.iteration !== "number" || !Number.isFinite(iterationRecord.iteration)) return undefined;

  const durationMs = typeof iterationRecord.durationMs === "number" && Number.isFinite(iterationRecord.durationMs)
    ? iterationRecord.durationMs
    : 0;
  const noProgressStreak = typeof iterationRecord.noProgressStreak === "number" && Number.isFinite(iterationRecord.noProgressStreak)
    ? iterationRecord.noProgressStreak
    : 0;
  const snapshotErrorCount = typeof iterationRecord.snapshotErrorCount === "number" && Number.isFinite(iterationRecord.snapshotErrorCount)
    ? iterationRecord.snapshotErrorCount
    : undefined;

  return {
    iteration: iterationRecord.iteration,
    duration: Math.round(durationMs / 1000),
    progress: sanitizeProgressState(iterationRecord.progress),
    changedFiles: sanitizeStringArray(iterationRecord.changedFiles),
    noProgressStreak,
    snapshotTruncated: typeof iterationRecord.snapshotTruncated === "boolean" ? iterationRecord.snapshotTruncated : undefined,
    snapshotErrorCount,
  };
}

function parseLoopContractInteger(raw: string | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseLoopContractGuardrails(raw: string | undefined): { blockCommands: string[]; protectedFiles: string[] } | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const guardrails = parsed as { blockCommands?: unknown; protectedFiles?: unknown };
    if (
      !Array.isArray(guardrails.blockCommands) ||
      !guardrails.blockCommands.every((item) => typeof item === "string") ||
      !Array.isArray(guardrails.protectedFiles) ||
      !guardrails.protectedFiles.every((item) => typeof item === "string")
    ) {
      return undefined;
    }
    return {
      blockCommands: [...guardrails.blockCommands],
      protectedFiles: [...guardrails.protectedFiles],
    };
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function createFailClosedLoopState(taskDir: string, cwd?: string): ActiveLoopState {
  return {
    active: true,
    loopToken: "",
    cwd: cwd && cwd.length > 0 ? cwd : taskDir,
    taskDir,
    iteration: 0,
    maxIterations: 0,
    noProgressStreak: 0,
    iterationSummaries: [],
    guardrails: { blockCommands: [".*"], protectedFiles: ["**/*"] },
    stopRequested: checkStopSignal(taskDir),
    envMalformed: true,
  };
}

function readEnvLoopState(taskDir: string): ActiveLoopState | undefined {
  const cwd = process.env[RALPH_RUNNER_CWD_ENV]?.trim();
  const loopToken = process.env[RALPH_RUNNER_LOOP_TOKEN_ENV]?.trim();
  const currentIteration = parseLoopContractInteger(process.env[RALPH_RUNNER_CURRENT_ITERATION_ENV]);
  const maxIterations = parseLoopContractInteger(process.env[RALPH_RUNNER_MAX_ITERATIONS_ENV]);
  const noProgressStreak = parseLoopContractInteger(process.env[RALPH_RUNNER_NO_PROGRESS_STREAK_ENV]);
  const guardrails = parseLoopContractGuardrails(process.env[RALPH_RUNNER_GUARDRAILS_ENV]);

  if (
    !cwd ||
    !loopToken ||
    currentIteration === undefined ||
    currentIteration < 0 ||
    maxIterations === undefined ||
    maxIterations <= 0 ||
    noProgressStreak === undefined ||
    noProgressStreak < 0 ||
    !guardrails
  ) {
    return undefined;
  }

  const iterationSummaries = readIterationRecords(taskDir)
    .map((record) => sanitizeIterationSummary(record, loopToken))
    .filter((summary): summary is IterationSummary => summary !== undefined);

  return {
    active: true,
    loopToken,
    cwd,
    taskDir,
    iteration: currentIteration,
    maxIterations,
    noProgressStreak,
    iterationSummaries,
    guardrails,
    stopRequested: checkStopSignal(taskDir),
  };
}

function readDurableLoopState(taskDir: string, envState: ActiveLoopState): ActiveLoopState | undefined {
  const envGuardrails = envState.guardrails;
  if (!envGuardrails) return undefined;

  const durableStatus = readStatusFile(taskDir);
  if (!durableStatus || typeof durableStatus !== "object") return undefined;

  const status = durableStatus as Record<string, unknown>;
  const guardrails = status.guardrails as Record<string, unknown> | undefined;
  if (
    typeof status.loopToken !== "string" ||
    status.loopToken.length === 0 ||
    typeof status.cwd !== "string" ||
    status.cwd.length === 0 ||
    typeof status.currentIteration !== "number" ||
    !Number.isInteger(status.currentIteration) ||
    status.currentIteration < 0 ||
    typeof status.maxIterations !== "number" ||
    !Number.isInteger(status.maxIterations) ||
    status.maxIterations <= 0 ||
    typeof status.taskDir !== "string" ||
    status.taskDir !== taskDir ||
    !guardrails ||
    !isStringArray(guardrails.blockCommands) ||
    !isStringArray(guardrails.protectedFiles)
  ) {
    return undefined;
  }

  const durableLoopToken = status.loopToken;
  const durableCwd = status.cwd;
  const durableGuardrails = guardrails as { blockCommands: string[]; protectedFiles: string[] };

  if (
    durableLoopToken !== envState.loopToken ||
    durableCwd !== envState.cwd ||
    status.currentIteration !== envState.iteration ||
    status.maxIterations !== envState.maxIterations ||
    !areStringArraysEqual(durableGuardrails.blockCommands, envGuardrails.blockCommands) ||
    !areStringArraysEqual(durableGuardrails.protectedFiles, envGuardrails.protectedFiles)
  ) {
    return undefined;
  }

  const iterationSummaries = readIterationRecords(taskDir)
    .map((record) => sanitizeIterationSummary(record, durableLoopToken))
    .filter((summary): summary is IterationSummary => summary !== undefined);

  return {
    active: true,
    loopToken: durableLoopToken,
    cwd: durableCwd,
    taskDir,
    iteration: status.currentIteration,
    maxIterations: status.maxIterations,
    noProgressStreak: envState.noProgressStreak,
    iterationSummaries,
    guardrails: {
      blockCommands: [...durableGuardrails.blockCommands],
      protectedFiles: [...durableGuardrails.protectedFiles],
    },
    stopRequested: checkStopSignal(taskDir),
  };
}

function resolveActiveLoopState(ctx: Pick<CommandContext, "sessionManager">): ActiveLoopState | undefined {
  const taskDir = process.env[RALPH_RUNNER_TASK_DIR_ENV]?.trim();
  if (taskDir) {
    const envState = readEnvLoopState(taskDir);
    if (!envState) return createFailClosedLoopState(taskDir, process.env[RALPH_RUNNER_CWD_ENV]?.trim() || undefined);
    return readDurableLoopState(taskDir, envState) ?? createFailClosedLoopState(taskDir, envState.cwd);
  }
  return readActiveLoopState(ctx);
}

function resolveActiveIterationState(ctx: Pick<CommandContext, "sessionManager">): ActiveIterationState | undefined {
  const state = resolveActiveLoopState(ctx);
  if (!state || typeof state.iteration !== "number") return undefined;
  return state as ActiveIterationState;
}

function getLoopIterationKey(loopToken: string, iteration: number): string {
  return `${loopToken}:${iteration}`;
}

function normalizeSnapshotPath(filePath: string): string {
  return filePath.split("\\").join("/");
}

function captureTaskDirectorySnapshot(ralphPath: string): WorkspaceSnapshot {
  const taskDir = dirname(ralphPath);
  const progressMemoryPath = join(taskDir, RALPH_PROGRESS_FILE);
  const files = new Map<string, string>();
  let truncated = false;
  let bytesRead = 0;
  let errorCount = 0;

  const walk = (dirPath: string) => {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
        content = readFileSync(fullPath);
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

function diffTaskDirectorySnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changed = new Set<string>();
  for (const [filePath, fingerprint] of before.files) {
    if (after.files.get(filePath) !== fingerprint) changed.add(filePath);
  }
  for (const filePath of after.files.keys()) {
    if (!before.files.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort((a, b) => a.localeCompare(b));
}

function resolveTaskDirObservedPath(taskDir: string, cwd: string, filePath: string): string | undefined {
  if (!taskDir || !cwd || !filePath) return undefined;
  const relPath = normalizeSnapshotPath(relative(resolve(taskDir), resolve(cwd, filePath)));
  if (!relPath || relPath === "." || relPath.startsWith("..")) return undefined;
  return relPath;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function assessTaskDirectoryProgress(
  ralphPath: string,
  before: WorkspaceSnapshot,
  observedTaskDirWrites: ReadonlySet<string>,
): Promise<ProgressAssessment> {
  let after = captureTaskDirectorySnapshot(ralphPath);
  let changedFiles = diffTaskDirectorySnapshots(before, after);
  let snapshotTruncated = before.truncated || after.truncated;
  let snapshotErrorCount = before.errorCount + after.errorCount;

  if (changedFiles.length > 0) {
    return { progress: true, changedFiles, snapshotTruncated, snapshotErrorCount };
  }

  for (let remainingMs = SNAPSHOT_POST_IDLE_POLL_WINDOW_MS; remainingMs > 0; remainingMs -= SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS) {
    await delay(Math.min(SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS, remainingMs));
    after = captureTaskDirectorySnapshot(ralphPath);
    changedFiles = diffTaskDirectorySnapshots(before, after);
    snapshotTruncated ||= after.truncated;
    snapshotErrorCount += after.errorCount;
    if (changedFiles.length > 0) {
      return { progress: true, changedFiles, snapshotTruncated, snapshotErrorCount };
    }
  }

  if (observedTaskDirWrites.size > 0) {
    return { progress: "unknown", changedFiles: [], snapshotTruncated, snapshotErrorCount };
  }

  return {
    progress: snapshotTruncated || snapshotErrorCount > 0 ? "unknown" : false,
    changedFiles,
    snapshotTruncated,
    snapshotErrorCount,
  };
}

function summarizeChangedFiles(changedFiles: string[]): string {
  if (changedFiles.length === 0) return "none";
  const visible = changedFiles.slice(0, 5);
  if (visible.length === changedFiles.length) return visible.join(", ");
  return `${visible.join(", ")} (+${changedFiles.length - visible.length} more)`;
}

function summarizeSnapshotCoverage(truncated: boolean, errorCount: number): string {
  const parts: string[] = [];
  if (truncated) parts.push("snapshot truncated");
  if (errorCount > 0) parts.push(errorCount === 1 ? "1 file unreadable" : `${errorCount} files unreadable`);
  return parts.join(", ");
}

function summarizeIterationProgress(summary: Pick<IterationSummary, "progress" | "changedFiles" | "snapshotTruncated" | "snapshotErrorCount">): string {
  if (summary.progress === true) return `durable progress (${summarizeChangedFiles(summary.changedFiles)})`;
  if (summary.progress === false) return "no durable progress";
  const coverage = summarizeSnapshotCoverage(summary.snapshotTruncated ?? false, summary.snapshotErrorCount ?? 0);
  return coverage ? `durable progress unknown (${coverage})` : "durable progress unknown";
}

function summarizeLastIterationFeedback(summary: IterationSummary | undefined, fallbackNoProgressStreak: number): string {
  if (!summary) return "";
  if (summary.progress === true) {
    return `Last iteration durable progress: ${summarizeChangedFiles(summary.changedFiles)}.`;
  }
  if (summary.progress === false) {
    return `Last iteration made no durable progress. No-progress streak: ${summary.noProgressStreak ?? fallbackNoProgressStreak}.`;
  }
  const coverage = summarizeSnapshotCoverage(summary.snapshotTruncated ?? false, summary.snapshotErrorCount ?? 0);
  const detail = coverage ? ` (${coverage})` : "";
  return `Last iteration durable progress could not be verified${detail}. No-progress streak remains ${summary.noProgressStreak ?? fallbackNoProgressStreak}.`;
}

function writeDraftFile(ralphPath: string, content: string) {
  mkdirSync(dirname(ralphPath), { recursive: true });
  writeFileSync(ralphPath, content, "utf8");
}

function displayPath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") ? `./${rel}` : filePath;
}

async function promptForTask(ctx: Pick<CommandContext, "hasUI" | "ui">, title: string, placeholder: string): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const value = await ctx.ui.input(title, placeholder);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function reviewDraft(plan: DraftPlan, mode: "run" | "draft", ctx: Pick<CommandContext, "ui">): Promise<{ action: "start" | "save" | "cancel"; content: string }> {
  let content = plan.content;

  while (true) {
    const nextPlan = { ...plan, content };
    const contentError = validateDraftContent(content);
    const options = contentError
      ? ["Open RALPH.md", "Cancel"]
      : mode === "run"
        ? ["Start", "Open RALPH.md", "Cancel"]
        : ["Save draft", "Open RALPH.md", "Cancel"];
    const choice = await ctx.ui.select(buildMissionBrief(nextPlan), options);

    if (!choice || choice === "Cancel") {
      return { action: "cancel", content };
    }
    if (choice === "Open RALPH.md") {
      const edited = await ctx.ui.editor("Edit RALPH.md", content);
      if (typeof edited === "string") content = edited;
      continue;
    }
    if (contentError) {
      ctx.ui.notify(`Invalid RALPH.md: ${contentError}`, "error");
      continue;
    }
    if (choice === "Save draft") {
      return { action: "save", content };
    }
    return { action: "start", content };
  }
}

async function editExistingDraft(ralphPath: string, ctx: Pick<CommandContext, "cwd" | "hasUI" | "ui">, saveMessage = "Saved RALPH.md") {
  if (!ctx.hasUI) {
    ctx.ui.notify(`Use ${displayPath(ctx.cwd, ralphPath)} in an interactive session to edit the draft.`, "warning");
    return;
  }

  let content = readFileSync(ralphPath, "utf8");
  const strictValidation = shouldValidateExistingDraft(content);
  while (true) {
    const edited = await ctx.ui.editor("Edit RALPH.md", content);
    if (typeof edited !== "string") return;

    if (strictValidation) {
      const error = validateDraftContent(edited);
      if (error) {
        ctx.ui.notify(`Invalid RALPH.md: ${error}`, "error");
        content = edited;
        continue;
      }
    }

    if (edited !== content) {
      writeDraftFile(ralphPath, edited);
      ctx.ui.notify(saveMessage, "info");
    }
    return;
  }
}

async function chooseRecoveryMode(
  input: string,
  dirPath: string,
  ctx: Pick<CommandContext, "cwd" | "ui">,
  allowTaskFallback = true,
): Promise<"draft-path" | "task" | "cancel"> {
  const options = allowTaskFallback ? ["Draft in that folder", "Treat as task text", "Cancel"] : ["Draft in that folder", "Cancel"];
  const choice = await ctx.ui.select(`No RALPH.md in ${displayPath(ctx.cwd, dirPath)}.`, options);
  if (choice === "Draft in that folder") return "draft-path";
  if (choice === "Treat as task text") return "task";
  return "cancel";
}

async function chooseConflictTarget(commandName: "ralph" | "ralph-draft", task: string, target: DraftTarget, ctx: Pick<CommandContext, "cwd" | "ui">): Promise<{ action: "run-existing" | "open-existing" | "draft-target" | "cancel"; target?: DraftTarget }> {
  const hasExistingDraft = existsSync(target.ralphPath);
  const title = hasExistingDraft
    ? `Found an existing RALPH at ${displayPath(ctx.cwd, target.ralphPath)} for “${task}”.`
    : `Found an occupied draft directory at ${displayPath(ctx.cwd, target.dirPath)} for “${task}”.`;
  const options =
    commandName === "ralph"
      ? hasExistingDraft
        ? ["Run existing", "Open existing RALPH.md", "Create sibling", "Cancel"]
        : ["Create sibling", "Cancel"]
      : hasExistingDraft
        ? ["Open existing RALPH.md", "Create sibling", "Cancel"]
        : ["Create sibling", "Cancel"];
  const choice = await ctx.ui.select(title, options);

  if (!choice || choice === "Cancel") return { action: "cancel" };
  if (choice === "Run existing") return { action: "run-existing" };
  if (choice === "Open existing RALPH.md") return { action: "open-existing" };
  return { action: "draft-target", target: createSiblingTarget(ctx.cwd, target.slug) };
}

function getDraftStrengtheningRuntime(ctx: Pick<CommandContext, "model" | "modelRegistry">): StrengthenDraftRuntime | undefined {
  if (!ctx.model || !ctx.modelRegistry) return undefined;
  return {
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
  };
}

async function draftFromTask(
  commandName: "ralph" | "ralph-draft",
  task: string,
  target: DraftTarget,
  ctx: Pick<CommandContext, "cwd" | "ui">,
  draftPlanFactory: DraftPlanFactory,
  runtime?: StrengthenDraftRuntime,
): Promise<string | undefined> {
  const plan = await draftPlanFactory(task, target, ctx.cwd, runtime);
  const review = await reviewDraft(plan, commandName === "ralph" ? "run" : "draft", ctx);
  if (review.action === "cancel") return undefined;

  writeDraftFile(target.ralphPath, review.content);
  if (review.action === "save") {
    ctx.ui.notify(`Draft saved to ${displayPath(ctx.cwd, target.ralphPath)}`, "info");
    return undefined;
  }
  return target.ralphPath;
}

let loopState: LoopState = defaultLoopState();
const RALPH_EXTENSION_REGISTERED = Symbol.for("pi-ralph-loop.registered");

export default function (pi: ExtensionAPI, services: RegisterRalphCommandServices = {}) {
  const registeredPi = pi as ExtensionAPI & Record<symbol, boolean | undefined>;
  if (registeredPi[RALPH_EXTENSION_REGISTERED]) return;
  registeredPi[RALPH_EXTENSION_REGISTERED] = true;
  const failCounts = new Map<string, number>();
  const pendingIterations = new Map<string, PendingIterationState>();
  const draftPlanFactory = services.createDraftPlan ?? createDraftPlanService;
  const isLoopSession = (ctx: Pick<CommandContext, "sessionManager">): boolean => resolveActiveLoopState(ctx) !== undefined;
  const getPendingIteration = (ctx: Pick<CommandContext, "sessionManager">): PendingIterationState | undefined => {
    const state = resolveActiveIterationState(ctx);
    return state ? pendingIterations.get(getLoopIterationKey(state.loopToken, state.iteration)) : undefined;
  };
  const registerPendingIteration = (loopToken: string, iteration: number, prompt: string): PendingIterationState => {
    const pending: PendingIterationState = {
      prompt,
      completion: createDeferred<IterationCompletion>(),
      toolCallPaths: new Map(),
      observedTaskDirWrites: new Set(),
    };
    pendingIterations.set(getLoopIterationKey(loopToken, iteration), pending);
    return pending;
  };
  const clearPendingIteration = (loopToken: string, iteration: number) => {
    pendingIterations.delete(getLoopIterationKey(loopToken, iteration));
  };
  const resolvePendingIteration = (ctx: Pick<CommandContext, "sessionManager">, event: any) => {
    const state = resolveActiveIterationState(ctx);
    if (!state) return;
    const pendingKey = getLoopIterationKey(state.loopToken, state.iteration);
    const pending = pendingIterations.get(pendingKey);
    if (!pending) return;
    pendingIterations.delete(pendingKey);
    const error = event.error instanceof Error ? event.error : event.error ? new Error(String(event.error)) : undefined;
    pending.completion.resolve({
      messages: Array.isArray(event.messages) ? event.messages : [],
      observedTaskDirWrites: new Set(pending.observedTaskDirWrites),
      error,
    });
  };
  const recordPendingToolPath = (ctx: Pick<CommandContext, "sessionManager">, event: any) => {
    const pending = getPendingIteration(ctx);
    if (!pending) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const filePath = (event.input as { path?: string } | undefined)?.path ?? "";
    if (toolCallId && filePath) pending.toolCallPaths.set(toolCallId, filePath);
  };
  const recordSuccessfulTaskDirWrite = (ctx: Pick<CommandContext, "sessionManager">, event: any) => {
    const pending = getPendingIteration(ctx);
    if (!pending) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const filePath = toolCallId ? pending.toolCallPaths.get(toolCallId) : undefined;
    if (toolCallId) pending.toolCallPaths.delete(toolCallId);
    if (event.isError === true || event.success === false || !filePath) return;
    const persisted = resolveActiveLoopState(ctx);
    const taskDirPath = persisted?.taskDir ?? loopState.taskDir;
    const cwd = persisted?.cwd ?? loopState.cwd;
    const relPath = resolveTaskDirObservedPath(taskDirPath ?? "", cwd ?? taskDirPath ?? "", filePath);
    if (relPath && relPath !== RALPH_PROGRESS_FILE) pending.observedTaskDirWrites.add(relPath);
  };

  async function startRalphLoop(ralphPath: string, ctx: CommandContext, runLoopFn: typeof runRalphLoop = runRalphLoop, runtimeArgs: RuntimeArgs = {}) {
    let name: string;
    try {
      const raw = readFileSync(ralphPath, "utf8");
      const draftError = validateDraftContent(raw);
      if (draftError) {
        ctx.ui.notify(`Invalid RALPH.md: ${draftError}`, "error");
        return;
      }
      const parsed = parseRalphMarkdown(raw);
      const { frontmatter } = parsed;
      if (!validateFrontmatter(frontmatter, ctx)) return;
      const runtimeValidationError = validateRuntimeArgs(frontmatter, parsed.body, frontmatter.commands, runtimeArgs);
      if (runtimeValidationError) {
        ctx.ui.notify(runtimeValidationError, "error");
        return;
      }
      const taskDir = dirname(ralphPath);
      name = basename(taskDir);
      loopState = {
        active: true,
        ralphPath,
        taskDir,
        cwd: ctx.cwd,
        iteration: 0,
        maxIterations: frontmatter.maxIterations,
        timeout: frontmatter.timeout,
        completionPromise: frontmatter.completionPromise,
        stopRequested: false,
        noProgressStreak: 0,
        iterationSummaries: [],
        guardrails: { blockCommands: frontmatter.guardrails.blockCommands, protectedFiles: frontmatter.guardrails.protectedFiles },
        observedTaskDirWrites: new Set(),
        loopToken: randomUUID(),
      };
    } catch (err) {
      ctx.ui.notify(String(err), "error");
      return;
    }
    ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations)`, "info");

    try {
      const result = await runLoopFn({
        ralphPath,
        cwd: ctx.cwd,
        timeout: loopState.timeout,
        maxIterations: loopState.maxIterations,
        guardrails: loopState.guardrails,
        runtimeArgs,
        modelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.model?.reasoning ? "high" : undefined,
        runCommandsFn: async (commands, blocked, commandPi, cwd, taskDir) => runCommands(commands, blocked, commandPi as ExtensionAPI, runtimeArgs, cwd, taskDir),
        onStatusChange(status) {
          ctx.ui.setStatus("ralph", status === "running" || status === "initializing" ? `🔁 ${name}: running` : undefined);
        },
        onNotify(message, level) {
          ctx.ui.notify(message, level);
        },
        onIterationComplete(record) {
          loopState.iteration = record.iteration;
          loopState.noProgressStreak = record.noProgressStreak;
          const summary: IterationSummary = {
            iteration: record.iteration,
            duration: record.durationMs ? Math.round(record.durationMs / 1000) : 0,
            progress: record.progress,
            changedFiles: record.changedFiles,
            noProgressStreak: record.noProgressStreak,
          };
          loopState.iterationSummaries.push(summary);
          pi.appendEntry("ralph-iteration", {
            iteration: record.iteration,
            duration: summary.duration,
            ralphPath: loopState.ralphPath,
            progress: record.progress,
            changedFiles: record.changedFiles,
            noProgressStreak: record.noProgressStreak,
          });
          persistLoopState(pi, toPersistedLoopState(loopState, { active: true, stopRequested: false }));
        },
        pi,
      });

      // Map runner result to UI notifications
      const total = loopState.iterationSummaries.reduce((a, s) => a + s.duration, 0);
      switch (result.status) {
        case "complete":
          ctx.ui.notify(`Ralph loop complete: completion promise matched on iteration ${result.iterations.length} (${total}s total)`, "info");
          break;
        case "max-iterations":
          ctx.ui.notify(`Ralph loop reached max iterations: ${result.iterations.length} iterations, ${total}s total`, "info");
          break;
        case "no-progress-exhaustion":
          ctx.ui.notify(`Ralph loop exhausted without verified progress: ${result.iterations.length} iterations, ${total}s total`, "warning");
          break;
        case "stopped":
          ctx.ui.notify(`Ralph loop stopped: ${result.iterations.length} iterations, ${total}s total`, "info");
          break;
        case "timeout":
          ctx.ui.notify(`Ralph loop stopped after a timeout: ${result.iterations.length} iterations, ${total}s total`, "warning");
          break;
        case "error":
          ctx.ui.notify(`Ralph loop failed: ${result.iterations.length} iterations, ${total}s total`, "error");
          break;
        default:
          ctx.ui.notify(`Ralph loop ended: ${result.status} (${total}s total)`, "info");
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Ralph loop failed: ${message}`, "error");
    } finally {
      failCounts.clear();
      pendingIterations.clear();
      loopState.active = false;
      loopState.stopRequested = false;
      loopState.loopToken = undefined;
      ctx.ui.setStatus("ralph", undefined);
      persistLoopState(pi, toPersistedLoopState(loopState, { active: false, stopRequested: false }));
    }
  }

  let runtimeArgsForStart: RuntimeArgs = {};

  async function handleDraftCommand(commandName: "ralph" | "ralph-draft", args: string, ctx: CommandContext): Promise<string | undefined> {
    const parsed = parseCommandArgs(args);
    if (parsed.error) {
      ctx.ui.notify(parsed.error, "error");
      return undefined;
    }
    const runtimeArgsResult = runtimeArgEntriesToMap(parsed.runtimeArgs);
    if (runtimeArgsResult.error) {
      ctx.ui.notify(runtimeArgsResult.error, "error");
      return undefined;
    }
    const runtimeArgs = runtimeArgsResult.runtimeArgs;
    if (parsed.runtimeArgs.length > 0 && (commandName === "ralph-draft" || parsed.mode !== "path")) {
      ctx.ui.notify("--arg is only supported with /ralph --path", "error");
      return undefined;
    }
    runtimeArgsForStart = runtimeArgs;
    const draftRuntime = getDraftStrengtheningRuntime(ctx);

    const resolveTaskForFolder = async (target: DraftTarget): Promise<string | undefined> => {
      const task = await promptForTask(ctx, "What should Ralph work on in this folder?", "reverse engineer this app");
      if (!task) return undefined;
      return draftFromTask(commandName, task, target, ctx, draftPlanFactory, draftRuntime);
    };

    const handleExistingInspection = async (input: string, explicitPath = false, runtimeArgsProvided = false): Promise<string | undefined> => {
      const inspection = inspectExistingTarget(input, ctx.cwd, explicitPath);
      if (runtimeArgsProvided && inspection.kind !== "run") {
        ctx.ui.notify("--arg is only supported with /ralph --path to an existing RALPH.md", "error");
        return undefined;
      }
      switch (inspection.kind) {
        case "run":
          if (commandName === "ralph") return inspection.ralphPath;
          await editExistingDraft(inspection.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, inspection.ralphPath)}`);
          return undefined;
        case "invalid-markdown":
          ctx.ui.notify(`Only task folders or RALPH.md can be run directly. ${displayPath(ctx.cwd, inspection.path)} is not runnable.`, "error");
          return undefined;
        case "invalid-target":
          ctx.ui.notify(`Only task folders or RALPH.md can be run directly. ${displayPath(ctx.cwd, inspection.path)} is a file, not a task folder.`, "error");
          return undefined;
        case "dir-without-ralph":
        case "missing-path": {
          if (!ctx.hasUI) {
            ctx.ui.notify("Draft review requires an interactive session. Pass a task folder or RALPH.md path instead.", "warning");
            return undefined;
          }
          const recovery = await chooseRecoveryMode(input, inspection.dirPath, ctx, !explicitPath);
          if (recovery === "cancel") return undefined;
          if (recovery === "task") {
            return handleTaskFlow(input);
          }
          return resolveTaskForFolder({ slug: basename(inspection.dirPath), dirPath: inspection.dirPath, ralphPath: inspection.ralphPath });
        }
        case "not-path":
          return handleTaskFlow(input);
      }
    };

    const handleTaskFlow = async (taskInput: string): Promise<string | undefined> => {
      const task = taskInput.trim();
      if (!task) return undefined;
      if (!ctx.hasUI) {
        ctx.ui.notify("Draft review requires an interactive session. Use /ralph with a task folder or RALPH.md path instead.", "warning");
        return undefined;
      }

      let planned = planTaskDraftTarget(ctx.cwd, task);
      if (planned.kind === "conflict") {
        const decision = await chooseConflictTarget(commandName, task, planned.target, ctx);
        if (decision.action === "cancel") return undefined;
        if (decision.action === "run-existing") return planned.target.ralphPath;
        if (decision.action === "open-existing") {
          await editExistingDraft(planned.target.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, planned.target.ralphPath)}`);
          return undefined;
        }
        planned = { kind: "draft", target: decision.target! };
      }
      return draftFromTask(commandName, task, planned.target, ctx, draftPlanFactory, draftRuntime);
    };

    if (parsed.mode === "task") {
      return handleTaskFlow(parsed.value);
    }
    if (parsed.mode === "path") {
      return handleExistingInspection(parsed.value || ".", true, parsed.runtimeArgs.length > 0);
    }
    if (!parsed.value) {
      const inspection = inspectExistingTarget(".", ctx.cwd);
      if (inspection.kind === "run") {
        if (commandName === "ralph") return inspection.ralphPath;
        await editExistingDraft(inspection.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, inspection.ralphPath)}`);
        return undefined;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Draft review requires an interactive session. Pass a task folder or RALPH.md path instead.", "warning");
        return undefined;
      }
      return resolveTaskForFolder({ slug: basename(ctx.cwd), dirPath: ctx.cwd, ralphPath: join(ctx.cwd, "RALPH.md") });
    }
    return handleExistingInspection(parsed.value);
  }

  pi.on("tool_call", async (event: any, ctx: any) => {
    const persisted = resolveActiveLoopState(ctx);
    if (!persisted) return;

    if (persisted.envMalformed && (event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit")) {
      return { block: true, reason: "ralph: invalid loop contract" };
    }

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const blockedPattern = findBlockedCommandPattern(cmd, persisted.guardrails?.blockCommands ?? []);
      if (blockedPattern) return { block: true, reason: `ralph: blocked (${blockedPattern})` };
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      if (matchesProtectedPath(filePath, persisted.guardrails?.protectedFiles ?? [], persisted.cwd)) {
        return { block: true, reason: `ralph: ${filePath} is protected` };
      }
    }

    recordPendingToolPath(ctx, event);
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    recordPendingToolPath(ctx, event);
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    recordSuccessfulTaskDirWrite(ctx, event);
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    resolvePendingIteration(ctx, event);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const persisted = resolveActiveLoopState(ctx);
    if (!persisted) return;
    const summaries = persisted?.iterationSummaries ?? [];
    if (summaries.length === 0) return;

    const history = summaries
      .map((summary) => {
        const status = summarizeIterationProgress(summary);
        return `- Iteration ${summary.iteration}: ${summary.duration}s — ${status}; no-progress streak: ${summary.noProgressStreak ?? persisted?.noProgressStreak ?? 0}`;
      })
      .join("\n");
    const lastSummary = summaries[summaries.length - 1];
    const lastFeedback = summarizeLastIterationFeedback(lastSummary, persisted?.noProgressStreak ?? 0);
    const taskDirLabel = persisted?.taskDir ? displayPath(persisted.cwd ?? persisted.taskDir, persisted.taskDir) : "the Ralph task directory";

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\nTask directory: ${taskDirLabel}\n\nPrevious iterations:\n${history}\n\n${lastFeedback}\nPersist findings to files in the Ralph task directory. Do not only report them in chat. If you make progress this iteration, leave durable file changes and mention the changed paths.\nDo not repeat completed work. Check git log for recent changes.`,
    };
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const persisted = resolveActiveLoopState(ctx);
    if (!persisted) return;
    if (!persisted) return;

    if (event.toolName !== "bash") return;
    const output = event.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("");
    if (!shouldWarnForBashFailure(output)) return;

    const state = resolveActiveIterationState(ctx);
    if (!state) return;

    const failKey = getLoopIterationKey(state.loopToken, state.iteration);
    const next = (failCounts.get(failKey) ?? 0) + 1;
    failCounts.set(failKey, next);
    if (next >= 3) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: "\n\n⚠️ ralph: 3+ failures this iteration. Stop and describe the root cause before retrying." },
        ],
      };
    }
  });

  pi.registerCommand("ralph", {
    description: "Start Ralph from a task folder or RALPH.md",
    handler: async (args: string, ctx: CommandContext) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      const ralphPath = await handleDraftCommand("ralph", args ?? "", ctx);
      if (!ralphPath) return;
      await startRalphLoop(ralphPath, ctx, services.runRalphLoopFn, runtimeArgsForStart);
    },
  });

  pi.registerCommand("ralph-draft", {
    description: "Draft a Ralph task without starting it",
    handler: async (args: string, ctx: CommandContext) => {
      await handleDraftCommand("ralph-draft", args ?? "", ctx);
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop the ralph loop after the current iteration",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      if (parsed.mode === "task") {
        ctx.ui.notify("/ralph-stop expects a task folder or RALPH.md path, not task text.", "error");
        return;
      }

      type StopTarget = {
        cwd: string;
        taskDir: string;
        ralphPath: string;
        loopToken: string;
        currentIteration: number;
        maxIterations: number;
        startedAt: string;
        source: "session" | "registry" | "status";
      };

      const now = new Date().toISOString();
      const activeRegistryEntries = () => listActiveLoopRegistryEntries(ctx.cwd);
      const inProcessSessionTarget: StopTarget | undefined = loopState.active
        ? {
            cwd: loopState.cwd || ctx.cwd,
            taskDir: loopState.taskDir,
            ralphPath: loopState.ralphPath,
            loopToken: loopState.loopToken ?? "",
            currentIteration: loopState.iteration,
            maxIterations: loopState.maxIterations,
            startedAt: now,
            source: "session",
          }
        : undefined;
      const persistedSessionState = inProcessSessionTarget ? undefined : readActiveLoopState(ctx);
      const sessionTarget: StopTarget | undefined =
        persistedSessionState &&
        typeof persistedSessionState.taskDir === "string" &&
        persistedSessionState.taskDir.length > 0 &&
        typeof persistedSessionState.loopToken === "string" &&
        persistedSessionState.loopToken.length > 0 &&
        typeof persistedSessionState.iteration === "number" &&
        typeof persistedSessionState.maxIterations === "number"
          ? {
              cwd: typeof persistedSessionState.cwd === "string" && persistedSessionState.cwd.length > 0 ? persistedSessionState.cwd : ctx.cwd,
              taskDir: persistedSessionState.taskDir,
              ralphPath: join(persistedSessionState.taskDir, "RALPH.md"),
              loopToken: persistedSessionState.loopToken,
              currentIteration: persistedSessionState.iteration,
              maxIterations: persistedSessionState.maxIterations,
              startedAt: now,
              source: "session",
            }
          : inProcessSessionTarget;

      const materializeRegistryTarget = (entry: ActiveLoopRegistryEntry): StopTarget => ({
        cwd: entry.cwd,
        taskDir: entry.taskDir,
        ralphPath: entry.ralphPath,
        loopToken: entry.loopToken,
        currentIteration: entry.currentIteration,
        maxIterations: entry.maxIterations,
        startedAt: entry.startedAt,
        source: "registry",
      });

      const stopTarget = (target: StopTarget): void => {
        createStopSignal(target.taskDir);

        const registryCwd = target.cwd;
        const existingEntry = readActiveLoopRegistry(registryCwd).find((entry) => entry.taskDir === target.taskDir);
        const registryEntry: ActiveLoopRegistryEntry = existingEntry
          ? {
              ...existingEntry,
              taskDir: target.taskDir,
              ralphPath: target.ralphPath,
              cwd: registryCwd,
              updatedAt: now,
            }
          : {
              taskDir: target.taskDir,
              ralphPath: target.ralphPath,
              cwd: registryCwd,
              loopToken: target.loopToken,
              status: "running",
              currentIteration: target.currentIteration,
              maxIterations: target.maxIterations,
              startedAt: target.startedAt,
              updatedAt: now,
            };
        writeActiveLoopRegistryEntry(registryCwd, registryEntry);
        recordActiveLoopStopRequest(registryCwd, target.taskDir, now);

        if (target.source === "session") {
          loopState.stopRequested = true;
          if (loopState.active) {
            persistLoopState(pi, toPersistedLoopState(loopState, { active: true, stopRequested: true }));
          } else if (persistedSessionState?.active) {
            persistLoopState(pi, { ...persistedSessionState, stopRequested: true });
          }
        }

        ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
      };

      if (sessionTarget && !parsed.value) {
        stopTarget(sessionTarget);
        return;
      }

      if (parsed.value) {
        const inspection = inspectExistingTarget(parsed.value, ctx.cwd, true);
        if (inspection.kind !== "run") {
          if (inspection.kind === "invalid-markdown") {
            ctx.ui.notify(`Only task folders or RALPH.md can be stopped directly. ${displayPath(ctx.cwd, inspection.path)} is not stoppable.`, "error");
            return;
          }
          if (inspection.kind === "invalid-target") {
            ctx.ui.notify(`Only task folders or RALPH.md can be stopped directly. ${displayPath(ctx.cwd, inspection.path)} is a file, not a task folder.`, "error");
            return;
          }
          if (inspection.kind === "dir-without-ralph" || inspection.kind === "missing-path") {
            ctx.ui.notify(`No active ralph loop found at ${displayPath(ctx.cwd, inspection.dirPath)}.`, "warning");
            return;
          }
          ctx.ui.notify("/ralph-stop expects a task folder or RALPH.md path.", "error");
          return;
        }

        const taskDir = dirname(inspection.ralphPath);
        if (sessionTarget && sessionTarget.taskDir === taskDir) {
          stopTarget(sessionTarget);
          return;
        }

        const registryTarget = activeRegistryEntries().find((entry) => entry.taskDir === taskDir || entry.ralphPath === inspection.ralphPath);
        if (registryTarget) {
          stopTarget(materializeRegistryTarget(registryTarget));
          return;
        }

        const statusFile = readStatusFile(taskDir);
        if (
          statusFile &&
          (statusFile.status === "running" || statusFile.status === "initializing") &&
          typeof statusFile.cwd === "string" &&
          statusFile.cwd.length > 0
        ) {
          const statusRegistryTarget = listActiveLoopRegistryEntries(statusFile.cwd).find(
            (entry) => entry.taskDir === taskDir && entry.loopToken === statusFile.loopToken,
          );
          if (statusRegistryTarget) {
            stopTarget(materializeRegistryTarget(statusRegistryTarget));
            return;
          }
        }

        ctx.ui.notify(`No active ralph loop found at ${displayPath(ctx.cwd, inspection.ralphPath)}.`, "warning");
        return;
      }

      if (sessionTarget) {
        stopTarget(sessionTarget);
        return;
      }

      const activeEntries = activeRegistryEntries();
      if (activeEntries.length === 0) {
        ctx.ui.notify("No active ralph loops found.", "warning");
        return;
      }
      if (activeEntries.length > 1) {
        ctx.ui.notify("Multiple active ralph loops found. Use /ralph-stop --path <task folder or RALPH.md> for an explicit target path.", "error");
        return;
      }

      stopTarget(materializeRegistryTarget(activeEntries[0]));
    },
  });
}
