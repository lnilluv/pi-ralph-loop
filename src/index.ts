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
  shouldStopForCompletionPromise,
  shouldWarnForBashFailure,
  shouldValidateExistingDraft,
  validateDraftContent,
  validateFrontmatter as validateFrontmatterMessage,
  createSiblingTarget,
  findBlockedCommandPattern,
} from "./ralph.ts";
import { matchesProtectedPath } from "./secret-paths.ts";
import type { CommandDef, CommandOutput, DraftPlan, DraftTarget, Frontmatter } from "./ralph.ts";
import { createDraftPlan as createDraftPlanService } from "./ralph-draft.ts";
import type { StrengthenDraftRuntime } from "./ralph-draft-llm.ts";
import { runRalphLoop } from "./runner.ts";
import { readStatusFile, checkStopSignal, createStopSignal } from "./runner-state.ts";

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

type ActiveLoopState = PersistedLoopState & { active: true; loopToken: string };
type ActiveIterationState = ActiveLoopState & { iteration: number };

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

export async function runCommands(commands: CommandDef[], blockPatterns: string[], pi: ExtensionAPI): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    const blockedPattern = findBlockedCommandPattern(cmd.run, blockPatterns);
    if (blockedPattern) {
      results.push({ name: cmd.name, output: `[blocked by guardrail: ${blockedPattern}]` });
      continue;
    }

    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
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
]);
const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_POST_IDLE_POLL_INTERVAL_MS = 20;
const SNAPSHOT_POST_IDLE_POLL_WINDOW_MS = 100;

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

function readActiveIterationState(ctx: Pick<CommandContext, "sessionManager">): ActiveIterationState | undefined {
  const state = readActiveLoopState(ctx);
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
      if (!entry.isFile() || fullPath === ralphPath) continue;
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

export default function (pi: ExtensionAPI, services: RegisterRalphCommandServices = {}) {
  const failCounts = new Map<string, number>();
  const pendingIterations = new Map<string, PendingIterationState>();
  const draftPlanFactory = services.createDraftPlan ?? createDraftPlanService;
  const isLoopSession = (ctx: Pick<CommandContext, "sessionManager">): boolean => readActiveLoopState(ctx) !== undefined;
  const getPendingIteration = (ctx: Pick<CommandContext, "sessionManager">): PendingIterationState | undefined => {
    const state = readActiveIterationState(ctx);
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
    const state = readActiveIterationState(ctx);
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
    const persisted = readPersistedLoopState(ctx);
    const taskDirPath = persisted?.taskDir ?? loopState.taskDir;
    const cwd = persisted?.cwd ?? loopState.cwd;
    const relPath = resolveTaskDirObservedPath(taskDirPath ?? "", cwd ?? taskDirPath ?? "", filePath);
    if (relPath) pending.observedTaskDirWrites.add(relPath);
  };

  async function startRalphLoop(ralphPath: string, ctx: CommandContext, runLoopFn: typeof runRalphLoop = runRalphLoop) {
    let name: string;
    try {
      const raw = readFileSync(ralphPath, "utf8");
      const draftError = validateDraftContent(raw);
      if (draftError) {
        ctx.ui.notify(`Invalid RALPH.md: ${draftError}`, "error");
        return;
      }
      const { frontmatter } = parseRalphMarkdown(raw);
      if (!validateFrontmatter(frontmatter, ctx)) return;
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
        modelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.model?.reasoning ? "high" : undefined,
        runCommandsFn: async (commands, blocked) => runCommands(commands, blocked, pi),
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

  async function handleDraftCommand(commandName: "ralph" | "ralph-draft", args: string, ctx: CommandContext): Promise<string | undefined> {
    const parsed = parseCommandArgs(args);
    const draftRuntime = getDraftStrengtheningRuntime(ctx);

    const resolveTaskForFolder = async (target: DraftTarget): Promise<string | undefined> => {
      const task = await promptForTask(ctx, "What should Ralph work on in this folder?", "reverse engineer this app");
      if (!task) return undefined;
      return draftFromTask(commandName, task, target, ctx, draftPlanFactory, draftRuntime);
    };

    const handleExistingInspection = async (input: string, explicitPath = false): Promise<string | undefined> => {
      const inspection = inspectExistingTarget(input, ctx.cwd, explicitPath);
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
      return handleExistingInspection(parsed.value || ".", true);
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
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    if (!persisted) return;

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
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
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
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    if (!persisted) return;

    if (event.toolName !== "bash") return;
    const output = event.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("");
    if (!shouldWarnForBashFailure(output)) return;

    const state = readActiveIterationState(ctx);
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
      await startRalphLoop(ralphPath, ctx, services.runRalphLoopFn);
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
    handler: async (_args: string, ctx: CommandContext) => {
      // First try durable stop signal (subprocess runner mode)
      const loopTaskDir = loopState.active ? loopState.taskDir : undefined;
      if (loopTaskDir) {
        createStopSignal(loopTaskDir);
      }
      // Also set in-process flag for backwards compatibility
      const persisted = readPersistedLoopState(ctx);
      if (persisted?.active) {
        loopState.stopRequested = true;
        persistLoopState(pi, { ...persisted, stopRequested: true });
      } else if (loopState.active) {
        loopState.stopRequested = true;
      } else {
        ctx.ui.notify("No active ralph loop", "warning");
        return;
      }
      ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
    },
  });
}
