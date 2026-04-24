import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionEvent, SessionEntry, AgentEndEvent as PiAgentEndEvent, BeforeAgentStartEvent, ToolCallEvent, ToolResultEvent as PiToolResultEvent } from "@mariozechner/pi-coding-agent";

type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
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
  findShellPolicyBlockedCommandPattern,
} from "./ralph.ts";
import { matchesProtectedPath } from "./secret-paths.ts";
import type { CommandDef, CommandOutput, DraftPlan, DraftTarget, Frontmatter, RuntimeArgs } from "./ralph.ts";
import { createDraftPlan as createDraftPlanService } from "./ralph-draft.ts";
import type { StrengthenDraftRuntime } from "./ralph-draft-llm.ts";
import { runRalphLoop } from "./runner.ts";
import {
  checkStopSignal,
  createStopSignal,
  createCancelSignal,
  checkCancelSignal,
  listActiveLoopRegistryEntries,
  readActiveLoopRegistry,
  readIterationRecords,
  readStatusFile,
  recordActiveLoopStopRequest,
  writeActiveLoopRegistryEntry,
  type ActiveLoopRegistryEntry,
  type IterationRecord,
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
  guardrails: Frontmatter["guardrails"];
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
  guardrails?: Frontmatter["guardrails"];
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

type CommandContext = ExtensionCommandContext;
type CommandSessionEntry = SessionEntry;

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

type StopTargetSource = "session" | "registry" | "status";

type StopTarget = {
  cwd: string;
  taskDir: string;
  ralphPath: string;
  loopToken: string;
  currentIteration: number;
  maxIterations: number;
  startedAt: string;
  source: StopTargetSource;
};

type ResolveRalphTargetResult =
  | { kind: "resolved"; taskDir: string }
  | { kind: "not-found" };

function resolveRalphTarget(
  ctx: Pick<CommandContext, "cwd" | "sessionManager" | "ui">,
  options: {
    commandName: string;
    explicitPath?: string;
    checkCrossProcess?: boolean;
    allowCompletedRuns?: boolean;
  },
): ResolveRalphTargetResult | undefined {
  const { commandName, explicitPath, checkCrossProcess = false, allowCompletedRuns = false } = options;
  const now = new Date().toISOString();
  const activeRegistryEntries = () => listActiveLoopRegistryEntries(ctx.cwd);
  const { target: sessionTarget } = resolveSessionStopTarget(ctx, now);
  const resolvedExplicitPath = explicitPath?.trim();

  if (resolvedExplicitPath) {
    const inspection = inspectExistingTarget(resolvedExplicitPath, ctx.cwd, true);
    if (inspection.kind === "run") {
      const taskDir = dirname(inspection.ralphPath);
      if (checkCrossProcess) {
        const registryTarget = activeRegistryEntries().find((entry) => entry.taskDir === taskDir);
        if (registryTarget) {
          return { kind: "resolved", taskDir: registryTarget.taskDir };
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
            return { kind: "resolved", taskDir: statusRegistryTarget.taskDir };
          }
        }
      }

      return { kind: "resolved", taskDir };
    }

    if (allowCompletedRuns) {
      const taskDir = resolve(ctx.cwd, resolvedExplicitPath);
      if (existsSync(join(taskDir, ".ralph-runner"))) {
        return { kind: "resolved", taskDir };
      }
      ctx.ui.notify(`No ralph run data found at ${displayPath(ctx.cwd, taskDir)}.`, "error");
      return { kind: "not-found" };
    }

    if (inspection.kind === "invalid-markdown") {
      ctx.ui.notify(`Only task folders or RALPH.md can be stopped directly. ${displayPath(ctx.cwd, inspection.path)} is not stoppable.`, "error");
      return undefined;
    }
    if (inspection.kind === "invalid-target") {
      ctx.ui.notify(`Only task folders or RALPH.md can be stopped directly. ${displayPath(ctx.cwd, inspection.path)} is a file, not a task folder.`, "error");
      return undefined;
    }
    if (inspection.kind === "dir-without-ralph" || inspection.kind === "missing-path") {
      ctx.ui.notify(`No active ralph loop found at ${displayPath(ctx.cwd, inspection.dirPath)}.`, "warning");
      return { kind: "not-found" };
    }

    ctx.ui.notify(`${commandName} expects a task folder or RALPH.md path.`, "error");
    return undefined;
  }

  if (sessionTarget) {
    return { kind: "resolved", taskDir: sessionTarget.taskDir };
  }

  const activeEntries = activeRegistryEntries();
  if (activeEntries.length === 0) {
    ctx.ui.notify(
      allowCompletedRuns
        ? `No ralph run data found. Specify a task path with ${commandName} <path>.`
        : "No active ralph loops found.",
      "warning",
    );
    return { kind: "not-found" };
  }

  if (activeEntries.length > 1) {
    ctx.ui.notify(
      `Multiple active ralph loops found. Use ${commandName} <task folder or RALPH.md> for an explicit target path.`,
      "error",
    );
    return undefined;
  }

  return { kind: "resolved", taskDir: activeEntries[0].taskDir };
}

type AgentEndEvent = PiAgentEndEvent;

type ToolResultEvent = PiToolResultEvent;

type EventContext = ExtensionContext;

type NewSessionOptions = NonNullable<Parameters<NonNullable<CommandContext["newSession"]>>[0]>;
type ForkOptions = NonNullable<Parameters<NonNullable<CommandContext["fork"]>>[1]>;
type SwitchSessionOptions = NonNullable<Parameters<NonNullable<CommandContext["switchSession"]>>[1]>;
type SessionReplacementWithSession = NonNullable<NewSessionOptions["withSession"]>;
type SessionReplacementContext = Parameters<SessionReplacementWithSession>[0];
type SessionReplacementOptions = {
  withSession?: SessionReplacementWithSession;
};

function resolveSessionUi(ctx: CommandContext): CommandContext["ui"] {
  return ctx.ui;
}

function installSessionReplacementHooks(
  ctx: CommandContext,
  onSessionReplacement: (replacementCtx: SessionReplacementContext) => void,
): () => void {
  const commandCtx = ctx as CommandContext & {
    newSession?: NonNullable<CommandContext["newSession"]>;
    fork?: NonNullable<CommandContext["fork"]>;
    switchSession?: NonNullable<CommandContext["switchSession"]>;
  };
  const restorers: Array<() => void> = [];

  const wrapOptions = <T extends { withSession?: SessionReplacementWithSession } | undefined>(options: T): T => {
    const existingWithSession = options?.withSession;
    return {
      ...(options ?? {}),
      withSession: async (replacementCtx: SessionReplacementContext) => {
        onSessionReplacement(replacementCtx);
        await existingWithSession?.(replacementCtx);
      },
    } as T;
  };

  const originalNewSession = commandCtx.newSession;
  if (originalNewSession) {
    commandCtx.newSession = ((options?: NewSessionOptions) => originalNewSession.call(commandCtx, wrapOptions(options))) as typeof originalNewSession;
    restorers.push(() => {
      commandCtx.newSession = originalNewSession;
    });
  }

  const originalFork = commandCtx.fork;
  if (originalFork) {
    commandCtx.fork = ((entryId: string, options?: ForkOptions) => originalFork.call(commandCtx, entryId, wrapOptions(options))) as typeof originalFork;
    restorers.push(() => {
      commandCtx.fork = originalFork;
    });
  }

  const originalSwitchSession = commandCtx.switchSession;
  if (originalSwitchSession) {
    commandCtx.switchSession = ((sessionPath: string, options?: SwitchSessionOptions) =>
      originalSwitchSession.call(commandCtx, sessionPath, wrapOptions(options))) as typeof originalSwitchSession;
    restorers.push(() => {
      commandCtx.switchSession = originalSwitchSession;
    });
  }

  return () => {
    while (restorers.length > 0) {
      restorers.pop()?.();
    }
  };
}

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
  guardrailsOrBlockPatterns: Frontmatter["guardrails"] | string[],
  pi: ExtensionAPI,
  runtimeArgs: RuntimeArgs = {},
  cwd?: string,
  taskDir?: string,
): Promise<CommandOutput[]> {
  const repoCwd = cwd ?? process.cwd();
  const guardrails: Frontmatter["guardrails"] = Array.isArray(guardrailsOrBlockPatterns)
    ? { blockCommands: guardrailsOrBlockPatterns, protectedFiles: [] }
    : guardrailsOrBlockPatterns;
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    const semanticRun = replaceArgsPlaceholders(cmd.run, runtimeArgs);
    const shellPolicyBlocked = findShellPolicyBlockedCommandPattern(semanticRun, guardrails.shellPolicy);
    const blockedPattern = shellPolicyBlocked ?? findBlockedCommandPattern(semanticRun, guardrails.blockCommands);
    const resolvedRun = resolveCommandRun(cmd.run, runtimeArgs);
    if (blockedPattern) {
      try {
        pi.appendEntry?.("ralph-blocked-command", { name: cmd.name, command: semanticRun, blockedPattern, cwd: repoCwd, taskDir });
      } catch (err) {
        if (!isKnownPiStaleExtensionContextError(err)) {
          throw err;
        }
      }
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
  messages: PiAgentEndEvent["messages"];
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

function isKnownPiStaleExtensionContextError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("stale extension ctx") ||
    normalizedMessage.includes("stale extension context") ||
    normalizedMessage.includes("extension instance is stale after session replacement or reload") ||
    normalizedMessage.includes("provided replacement-session context") ||
    normalizedMessage.includes("replacement-session context")
  );
}

function appendLoopEntryBestEffort(pi: ExtensionAPI, customType: string, data: unknown) {
  try {
    pi.appendEntry?.(customType, data);
  } catch (err) {
    if (isKnownPiStaleExtensionContextError(err)) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(`Ralph append logging failed for ${customType}: ${message}\n`);
    } catch {
      // Best-effort surfacing only.
    }
  }
}

function persistLoopState(pi: ExtensionAPI, data: PersistedLoopState) {
  appendLoopEntryBestEffort(pi, "ralph-loop-state", data);
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
    guardrails: cloneGuardrails(state.guardrails),
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

type ShellPolicy = NonNullable<Frontmatter["guardrails"]["shellPolicy"]>;

function isShellPolicy(value: unknown): value is ShellPolicy {
  if (!value || typeof value !== "object") return false;
  const shellPolicy = value as { mode?: unknown; allow?: unknown };
  if (shellPolicy.mode === "allowlist") {
    return Array.isArray(shellPolicy.allow) && shellPolicy.allow.length > 0 && shellPolicy.allow.every((item) => typeof item === "string");
  }
  if (shellPolicy.mode === "blocklist") {
    return shellPolicy.allow === undefined || (Array.isArray(shellPolicy.allow) && shellPolicy.allow.length === 0);
  }
  return false;
}

function shellPolicyAllowPatterns(shellPolicy?: ShellPolicy): string[] {
  return shellPolicy?.mode === "allowlist" ? shellPolicy.allow : [];
}

function areShellPoliciesEqual(left?: ShellPolicy, right?: ShellPolicy): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.mode !== right.mode) return false;
  return areStringArraysEqual(shellPolicyAllowPatterns(left), shellPolicyAllowPatterns(right));
}

function cloneShellPolicy(shellPolicy?: ShellPolicy): ShellPolicy | undefined {
  if (!shellPolicy) return undefined;
  return shellPolicy.mode === "allowlist"
    ? { mode: "allowlist", allow: [...shellPolicy.allow] }
    : { mode: "blocklist" };
}

function cloneGuardrails(guardrails: { blockCommands: string[]; protectedFiles: string[]; shellPolicy?: ShellPolicy }): Frontmatter["guardrails"] {
  const shellPolicy = cloneShellPolicy(guardrails.shellPolicy);
  return {
    blockCommands: [...guardrails.blockCommands],
    protectedFiles: [...guardrails.protectedFiles],
    ...(shellPolicy ? { shellPolicy } : {}),
  };
}

function sanitizeGuardrails(value: unknown): Frontmatter["guardrails"] {
  if (!value || typeof value !== "object") {
    return { blockCommands: [], protectedFiles: [] };
  }
  const guardrails = value as { blockCommands?: unknown; protectedFiles?: unknown; shellPolicy?: unknown };
  return cloneGuardrails({
    blockCommands: sanitizeStringArray(guardrails.blockCommands),
    protectedFiles: sanitizeStringArray(guardrails.protectedFiles),
    ...(isShellPolicy(guardrails.shellPolicy) ? { shellPolicy: guardrails.shellPolicy } : {}),
  });
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

function parseLoopContractGuardrails(raw: string | undefined): Frontmatter["guardrails"] | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const guardrails = parsed as { blockCommands?: unknown; protectedFiles?: unknown; shellPolicy?: unknown };
    if (
      !Array.isArray(guardrails.blockCommands) ||
      !guardrails.blockCommands.every((item) => typeof item === "string") ||
      !Array.isArray(guardrails.protectedFiles) ||
      !guardrails.protectedFiles.every((item) => typeof item === "string") ||
      (guardrails.shellPolicy !== undefined && !isShellPolicy(guardrails.shellPolicy))
    ) {
      return undefined;
    }
    return cloneGuardrails({
      blockCommands: [...guardrails.blockCommands],
      protectedFiles: [...guardrails.protectedFiles],
      ...(guardrails.shellPolicy ? { shellPolicy: guardrails.shellPolicy } : {}),
    });
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
    !isStringArray(guardrails.protectedFiles) ||
    (guardrails.shellPolicy !== undefined && !isShellPolicy(guardrails.shellPolicy))
  ) {
    return undefined;
  }

  const durableLoopToken = status.loopToken;
  const durableCwd = status.cwd;
  const durableGuardrails = guardrails as Frontmatter["guardrails"];

  if (
    durableLoopToken !== envState.loopToken ||
    durableCwd !== envState.cwd ||
    status.currentIteration !== envState.iteration ||
    status.maxIterations !== envState.maxIterations ||
    !areStringArraysEqual(durableGuardrails.blockCommands, envGuardrails.blockCommands) ||
    !areStringArraysEqual(durableGuardrails.protectedFiles, envGuardrails.protectedFiles) ||
    !areShellPoliciesEqual(durableGuardrails.shellPolicy, envGuardrails.shellPolicy)
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
    guardrails: cloneGuardrails(durableGuardrails),
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

type LifecycleTarget = { taskDir: string; ralphPath: string };

function resolveLifecycleTarget(ctx: Pick<CommandContext, "cwd" | "ui">, input: string, commandName: string): LifecycleTarget | undefined {
  const inspection = inspectExistingTarget(input, ctx.cwd, true);
  switch (inspection.kind) {
    case "run":
      return { taskDir: dirname(inspection.ralphPath), ralphPath: inspection.ralphPath };
    case "invalid-markdown":
      ctx.ui.notify(`Only task folders or RALPH.md can be used with ${commandName}. ${displayPath(ctx.cwd, inspection.path)} is not runnable.`, "error");
      return undefined;
    case "invalid-target":
      ctx.ui.notify(`Only task folders or RALPH.md can be used with ${commandName}. ${displayPath(ctx.cwd, inspection.path)} is a file, not a task folder.`, "error");
      return undefined;
    case "dir-without-ralph":
    case "missing-path":
      return { taskDir: inspection.dirPath, ralphPath: inspection.ralphPath };
    case "not-path": {
      const taskDir = resolve(ctx.cwd, input);
      return { taskDir, ralphPath: join(taskDir, "RALPH.md") };
    }
  }
}

function findActiveLifecycleRegistryEntry(ctx: Pick<CommandContext, "cwd">, taskDir: string): ActiveLoopRegistryEntry | undefined {
  const activeEntry = listActiveLoopRegistryEntries(ctx.cwd).find((entry) => entry.taskDir === taskDir);
  if (activeEntry) {
    return activeEntry;
  }

  const statusFile = readStatusFile(taskDir);
  if (
    statusFile &&
    (statusFile.status === "running" || statusFile.status === "initializing") &&
    typeof statusFile.cwd === "string" &&
    statusFile.cwd.length > 0
  ) {
    return listActiveLoopRegistryEntries(statusFile.cwd).find(
      (entry) => entry.taskDir === taskDir && entry.loopToken === statusFile.loopToken,
    );
  }

  return undefined;
}

function summarizeIterationRecord(record: IterationRecord): string {
  const parts = [`lastIteration: #${record.iteration}`];
  if (typeof record.durationMs === "number") {
    parts.push(`durationMs=${record.durationMs}`);
  }
  parts.push(`progress=${record.progress}`);
  if (record.completionGate) {
    const gateStatus = record.completionGate.ready
      ? "ready"
      : `blocked${record.completionGate.reasons.length > 0 ? ` (${record.completionGate.reasons.join("; ")})` : ""}`;
    parts.push(`completionGate=${gateStatus}`);
  } else if (record.completion?.blockingReasons?.length) {
    parts.push(`completionGate=blocked (${record.completion.blockingReasons.join("; ")})`);
  }
  return parts.join(" ");
}

function isWithinPath(basePath: string, targetPath: string): boolean {
  const pathRelative = relative(basePath, targetPath);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

function archiveRunnerArtifacts(taskDir: string, archiveName = new Date().toISOString().replace(/[:.]/g, "-")): string {
  const runnerDir = join(taskDir, ".ralph-runner");
  const archiveRoot = join(taskDir, ".ralph-runner-archive");
  const archiveDir = join(archiveRoot, archiveName);
  const taskRootRealPath = realpathSync(taskDir);

  if (existsSync(archiveRoot)) {
    const archiveRootStat = lstatSync(archiveRoot);
    if (archiveRootStat.isSymbolicLink()) {
      throw new Error(`Unsafe archive root: ${archiveRoot} is a symlink`);
    }
    if (!archiveRootStat.isDirectory()) {
      throw new Error(`Unsafe archive root: ${archiveRoot} is not a directory`);
    }
  } else {
    mkdirSync(archiveRoot, { recursive: true });
  }

  const archiveRootRealPath = realpathSync(archiveRoot);
  if (!isWithinPath(taskRootRealPath, archiveRootRealPath)) {
    throw new Error(`Unsafe archive root: ${archiveRoot} resolves outside the task directory`);
  }

  renameSync(runnerDir, archiveDir);

  const archiveDirRealPath = realpathSync(archiveDir);
  if (!isWithinPath(taskRootRealPath, archiveDirRealPath)) {
    throw new Error(`Unsafe archive destination: ${archiveDir} resolves outside the task directory`);
  }

  return archiveDir;
}

function exportRalphLogs(taskDir: string, destDir: string): { iterations: number; events: number; transcripts: number } {
  const runnerDir = join(taskDir, ".ralph-runner");
  if (!existsSync(runnerDir)) {
    throw new Error(`No .ralph-runner directory found at ${taskDir}`);
  }

  mkdirSync(destDir, { recursive: true });

  const filesToCopy = ["status.json", "iterations.jsonl", "events.jsonl"];
  for (const file of filesToCopy) {
    const src = join(runnerDir, file);
    if (existsSync(src)) {
      copyFileSync(src, join(destDir, file));
    }
  }

  // Copy transcripts directory
  const transcriptsDir = join(runnerDir, "transcripts");
  let transcripts = 0;
  if (existsSync(transcriptsDir)) {
    const destTranscripts = join(destDir, "transcripts");
    mkdirSync(destTranscripts, { recursive: true });
    for (const entry of readdirSync(transcriptsDir)) {
      const srcPath = join(transcriptsDir, entry);
      try {
        const stat = lstatSync(srcPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          copyFileSync(srcPath, join(destTranscripts, entry));
          transcripts++;
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  // Count iterations and events
  let iterations = 0;
  let events = 0;
  const iterPath = join(destDir, "iterations.jsonl");
  if (existsSync(iterPath)) {
    iterations = readFileSync(iterPath, "utf8").split("\n").filter((l) => l.trim()).length;
  }
  const evPath = join(destDir, "events.jsonl");
  if (existsSync(evPath)) {
    events = readFileSync(evPath, "utf8").split("\n").filter((l) => l.trim()).length;
  }

  return { iterations, events, transcripts };
}

export function parseLogExportArgs(raw: string): { path?: string; dest?: string; error?: string } {
  const parts = raw.trim().split(/\s+/);
  let path: string | undefined;
  let dest: string | undefined;
  let i = 0;
  while (i < parts.length) {
    if (parts[i] === "--dest" || parts[i] === "-d") {
      if (i + 1 >= parts.length) return { error: "--dest requires a directory path" };
      dest = parts[i + 1];
      i += 2;
    } else if (parts[i] === "--path" || parts[i] === "-p") {
      if (i + 1 >= parts.length) return { error: "--path requires a task path" };
      path = parts[i + 1];
      i += 2;
    } else if (!path && parts[i]) {
      path = parts[i];
      i++;
    } else {
      i++;
    }
  }
  return { path, dest };
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

function resolveSessionStopTarget(ctx: Pick<CommandContext, "cwd" | "sessionManager">, now: string): {
  target?: StopTarget;
  persistedSessionState?: ActiveLoopState;
} {
  if (loopState.active) {
    return {
      target: {
        cwd: loopState.cwd || ctx.cwd,
        taskDir: loopState.taskDir,
        ralphPath: loopState.ralphPath,
        loopToken: loopState.loopToken ?? "",
        currentIteration: loopState.iteration,
        maxIterations: loopState.maxIterations,
        startedAt: now,
        source: "session",
      },
    };
  }

  const persistedSessionState = readActiveLoopState(ctx);
  if (
    !persistedSessionState ||
    typeof persistedSessionState.taskDir !== "string" ||
    persistedSessionState.taskDir.length === 0 ||
    typeof persistedSessionState.loopToken !== "string" ||
    persistedSessionState.loopToken.length === 0 ||
    typeof persistedSessionState.iteration !== "number" ||
    typeof persistedSessionState.maxIterations !== "number"
  ) {
    return { persistedSessionState };
  }

  return {
    persistedSessionState,
    target: {
      cwd: typeof persistedSessionState.cwd === "string" && persistedSessionState.cwd.length > 0 ? persistedSessionState.cwd : ctx.cwd,
      taskDir: persistedSessionState.taskDir,
      ralphPath: join(persistedSessionState.taskDir, "RALPH.md"),
      loopToken: persistedSessionState.loopToken,
      currentIteration: persistedSessionState.iteration,
      maxIterations: persistedSessionState.maxIterations,
      startedAt: now,
      source: "session",
    },
  };
}

function materializeRegistryStopTarget(entry: ActiveLoopRegistryEntry): StopTarget {
  return {
    cwd: entry.cwd,
    taskDir: entry.taskDir,
    ralphPath: entry.ralphPath,
    loopToken: entry.loopToken,
    currentIteration: entry.currentIteration,
    maxIterations: entry.maxIterations,
    startedAt: entry.startedAt,
    source: "registry",
  };
}

function applyStopTarget(
  pi: ExtensionAPI,
  ctx: Pick<CommandContext, "cwd" | "ui">,
  target: StopTarget,
  now: string,
  persistedSessionState?: ActiveLoopState,
): void {
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
}

let loopState: LoopState = defaultLoopState();
const RALPH_EXTENSION_REGISTERED = Symbol.for("pi-ralph-loop.registered");

const SCAFFOLD_PRESET_FILES = {
  "fix-tests": new URL("../presets/fix-tests/RALPH.md", import.meta.url),
  migration: new URL("../presets/migration/RALPH.md", import.meta.url),
  "research-report": new URL("../presets/research-report/RALPH.md", import.meta.url),
  "security-audit": new URL("../presets/security-audit/RALPH.md", import.meta.url),
} as const;

type ScaffoldPresetName = keyof typeof SCAFFOLD_PRESET_FILES;

type ScaffoldArgs = {
  preset?: ScaffoldPresetName;
  target?: string;
  error?: string;
};

const SCAFFOLD_PRESET_NAMES = Object.keys(SCAFFOLD_PRESET_FILES) as ScaffoldPresetName[];

function scaffoldRalphTemplate(): string {
  return `---
max_iterations: 10
timeout: 120
commands: []
completion_promise: DONE
completion_gate: optional
---
# {{ ralph.name }}

Describe the task here.

## Evidence
Use {{ commands.* }} outputs as evidence.

## Completion
Stop with <promise>DONE</promise> when finished.
`;
}

function tokenizeScaffoldArgs(raw: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let inToken = false;

  for (const char of raw) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    current += char;
    inToken = true;
  }

  if (quote) {
    return { tokens, error: "Unterminated quote in /ralph-scaffold arguments." };
  }

  if (inToken) {
    tokens.push(current);
  }

  return { tokens };
}

function parseScaffoldArgs(raw: string): ScaffoldArgs {
  const tokenized = tokenizeScaffoldArgs(raw);
  if (tokenized.error) return { error: tokenized.error };

  const positional: string[] = [];
  let presetName: string | undefined;

  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token === "--preset" || token === "-p") {
      const value = tokenized.tokens[index + 1];
      if (!value) return { error: "/ralph-scaffold --preset requires a preset name." };
      presetName = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--preset=")) {
      const value = token.slice("--preset=".length).trim();
      if (!value) return { error: "/ralph-scaffold --preset requires a preset name." };
      presetName = value;
      continue;
    }

    if (token.startsWith("-")) {
      return { error: `Unknown /ralph-scaffold option: ${token}` };
    }

    positional.push(token);
  }

  if (positional.length === 0) {
    return { error: "/ralph-scaffold expects a task name or path." };
  }
  if (positional.length > 1) {
    return { error: "/ralph-scaffold expects a single task name or path. Use quotes for paths with spaces." };
  }

  if (presetName !== undefined && !Object.prototype.hasOwnProperty.call(SCAFFOLD_PRESET_FILES, presetName)) {
    return { error: `Unknown scaffold preset "${presetName}". Available presets: ${SCAFFOLD_PRESET_NAMES.join(", ")}.` };
  }

  return { preset: presetName as ScaffoldPresetName | undefined, target: positional[0] };
}

function readScaffoldPresetTemplate(preset: ScaffoldPresetName): string {
  return readFileSync(fileURLToPath(SCAFFOLD_PRESET_FILES[preset]), "utf8");
}

function scaffoldTemplateForPreset(preset?: ScaffoldPresetName): string {
  return preset ? readScaffoldPresetTemplate(preset) : scaffoldRalphTemplate();
}

function slugifyTaskName(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function (pi: ExtensionAPI, services: RegisterRalphCommandServices = {}) {
  const registeredPi = pi as ExtensionAPI & Record<symbol, boolean | undefined>;
  if (registeredPi[RALPH_EXTENSION_REGISTERED]) return;
  registeredPi[RALPH_EXTENSION_REGISTERED] = true;
  const failCounts = new Map<string, number>();
  const pendingIterations = new Map<string, PendingIterationState>();
  const draftPlanFactory = services.createDraftPlan ?? createDraftPlanService;
  const isLoopSession = (ctx: Pick<CommandContext, "sessionManager">): boolean => resolveActiveLoopState(ctx) !== undefined;
  const appendLoopProofEntry = (customType: string, data: Record<string, unknown>): void => {
    try {
      pi.appendEntry?.(customType, data);
    } catch (err) {
      if (isKnownPiStaleExtensionContextError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(`Ralph proof logging failed for ${customType}: ${message}\n`);
      } catch {
        // Best-effort surfacing only.
      }
    }
  };
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
  const resolvePendingIteration = (ctx: EventContext, event: AgentEndEvent) => {
    const state = resolveActiveIterationState(ctx);
    if (!state) return;
    const pendingKey = getLoopIterationKey(state.loopToken, state.iteration);
    const pending = pendingIterations.get(pendingKey);
    if (!pending) return;
    pendingIterations.delete(pendingKey);
    const rawError = (event as { error?: unknown }).error;
    const error = rawError instanceof Error ? rawError : rawError ? new Error(String(rawError)) : undefined;
    pending.completion.resolve({
      messages: event.messages ?? [],
      observedTaskDirWrites: new Set(pending.observedTaskDirWrites),
      error,
    });
  };
  const recordPendingToolPath = (ctx: EventContext, event: ToolCallEvent | ToolExecutionStartEvent) => {
    const pending = getPendingIteration(ctx);
    if (!pending) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const filePath = ("input" in event ? event.input : event.args)?.path ?? "";
    if (toolCallId && filePath) pending.toolCallPaths.set(toolCallId, filePath);
  };
  const recordSuccessfulTaskDirWrite = (ctx: EventContext, event: ToolExecutionEndEvent) => {
    const pending = getPendingIteration(ctx);
    if (!pending) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const filePath = toolCallId ? pending.toolCallPaths.get(toolCallId) : undefined;
    if (toolCallId) pending.toolCallPaths.delete(toolCallId);
    if (event.isError === true || !filePath) return;
    const persisted = resolveActiveLoopState(ctx);
    const taskDirPath = persisted?.taskDir ?? loopState.taskDir;
    const cwd = persisted?.cwd ?? loopState.cwd;
    const relPath = resolveTaskDirObservedPath(taskDirPath ?? "", cwd ?? taskDirPath ?? "", filePath);
    if (relPath && relPath !== RALPH_PROGRESS_FILE) pending.observedTaskDirWrites.add(relPath);
  };

  async function startRalphLoop(ralphPath: string, ctx: CommandContext, runLoopFn: typeof runRalphLoop = runRalphLoop, runtimeArgs: RuntimeArgs = {}) {
    let currentCommandCtx: CommandContext = ctx;
    const sessionPi = pi;
    let name: string;
    let currentStopOnError = true;
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
      currentStopOnError = frontmatter.stopOnError;
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
        guardrails: cloneGuardrails(frontmatter.guardrails),
        observedTaskDirWrites: new Set(),
        loopToken: randomUUID(),
      };
    } catch (err) {
      ctx.ui.notify(String(err), "error");
      return;
    }
    ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations)`, "info");
    const restoreSessionReplacementHooks = installSessionReplacementHooks(ctx, (replacementCtx) => {
      currentCommandCtx = replacementCtx as CommandContext;
    });

    try {
      const result = await runLoopFn({
        ralphPath,
        cwd: ctx.cwd,
        timeout: loopState.timeout,
        maxIterations: loopState.maxIterations,
        guardrails: loopState.guardrails,
        stopOnError: currentStopOnError,
        runtimeArgs,
        modelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.model?.reasoning ? "high" : undefined,
        runCommandsFn: async (commands, guardrails, commandPi, cwd, taskDir) => runCommands(commands, guardrails, commandPi as ExtensionAPI, runtimeArgs, cwd, taskDir),
        onStatusChange(status) {
          const runtimeUi = resolveSessionUi(currentCommandCtx);
          runtimeUi.setStatus("ralph", status === "running" || status === "initializing" ? `🔁 ${name}: running` : undefined);
        },
        onNotify(message, level) {
          const runtimeUi = resolveSessionUi(currentCommandCtx);
          runtimeUi.notify(message, level);
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
          appendLoopEntryBestEffort(sessionPi, "ralph-iteration", {
            iteration: record.iteration,
            duration: summary.duration,
            ralphPath: loopState.ralphPath,
            progress: record.progress,
            changedFiles: record.changedFiles,
            noProgressStreak: record.noProgressStreak,
          });
          persistLoopState(sessionPi, toPersistedLoopState(loopState, { active: true, stopRequested: false }));
        },
        pi: sessionPi,
      });

      // Map runner result to UI notifications
      const total = loopState.iterationSummaries.reduce((a, s) => a + s.duration, 0);
      const runtimeUi = resolveSessionUi(currentCommandCtx);
      switch (result.status) {
        case "complete":
          runtimeUi.notify(`Ralph loop complete: completion promise matched on iteration ${result.iterations.length} (${total}s total)`, "info");
          break;
        case "max-iterations":
          runtimeUi.notify(`Ralph loop reached max iterations: ${result.iterations.length} iterations, ${total}s total`, "info");
          break;
        case "no-progress-exhaustion":
          runtimeUi.notify(`Ralph loop exhausted without verified progress: ${result.iterations.length} iterations, ${total}s total`, "warning");
          break;
        case "stopped":
          runtimeUi.notify(`Ralph loop stopped: ${result.iterations.length} iterations, ${total}s total`, "info");
          break;
        case "timeout":
          runtimeUi.notify(`Ralph loop stopped after a timeout: ${result.iterations.length} iterations, ${total}s total`, "warning");
          break;
        case "error":
          runtimeUi.notify(`Ralph loop failed: ${result.iterations.length} iterations, ${total}s total`, "error");
          break;
        default:
          runtimeUi.notify(`Ralph loop ended: ${result.status} (${total}s total)`, "info");
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolveSessionUi(currentCommandCtx).notify(`Ralph loop failed: ${message}`, "error");
    } finally {
      failCounts.clear();
      pendingIterations.clear();
      loopState.active = false;
      loopState.stopRequested = false;
      loopState.loopToken = undefined;
      restoreSessionReplacementHooks();
      resolveSessionUi(currentCommandCtx).setStatus("ralph", undefined);
      persistLoopState(sessionPi, toPersistedLoopState(loopState, { active: false, stopRequested: false }));
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

  pi.on("tool_call", async (event: ToolCallEvent, ctx: EventContext) => {
    const persisted = resolveActiveLoopState(ctx);
    if (!persisted) return;

    if (persisted.envMalformed && (event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit")) {
      return { block: true, reason: "ralph: invalid loop contract" };
    }

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const shellPolicyBlocked = findShellPolicyBlockedCommandPattern(cmd, persisted.guardrails?.shellPolicy);
      const blockedPattern = shellPolicyBlocked ?? findBlockedCommandPattern(cmd, persisted.guardrails?.blockCommands ?? []);
      if (blockedPattern) {
        appendLoopProofEntry("ralph-blocked-command", {
          loopToken: persisted.loopToken,
          iteration: persisted.iteration,
          command: cmd,
          blockedPattern,
        });
        return { block: true, reason: `ralph: blocked (${blockedPattern})` };
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      if (matchesProtectedPath(filePath, persisted.guardrails?.protectedFiles ?? [], persisted.cwd)) {
        appendLoopProofEntry("ralph-blocked-write", {
          loopToken: persisted.loopToken,
          iteration: persisted.iteration,
          toolName: event.toolName,
          path: filePath,
          reason: `ralph: ${filePath} is protected`,
        });
        return { block: true, reason: `ralph: ${filePath} is protected` };
      }
    }

    recordPendingToolPath(ctx, event);
  });

  pi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx: EventContext) => {
    recordPendingToolPath(ctx, event);
  });

  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx: EventContext) => {
    recordSuccessfulTaskDirWrite(ctx, event);
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: EventContext) => {
    resolvePendingIteration(ctx, event);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: EventContext) => {
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
    appendLoopProofEntry("ralph-steering-injected", {
      loopToken: persisted?.loopToken,
      iteration: persisted?.iteration,
      maxIterations: persisted?.maxIterations,
      taskDir: taskDirLabel,
    });
    appendLoopProofEntry("ralph-loop-context-injected", {
      loopToken: persisted?.loopToken,
      iteration: persisted?.iteration,
      maxIterations: persisted?.maxIterations,
      taskDir: taskDirLabel,
      summaryCount: summaries.length,
    });

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\nTask directory: ${taskDirLabel}\n\nPrevious iterations:\n${history}\n\n${lastFeedback}\nPersist findings to files in the Ralph task directory. Do not only report them in chat. If you make progress this iteration, leave durable file changes and mention the changed paths.\nDo not repeat completed work. Check git log for recent changes.`,
    };
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: EventContext) => {
    const persisted = resolveActiveLoopState(ctx);
    if (!persisted) return;

    if (event.toolName !== "bash") return;
    const output = event.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
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

  pi.registerCommand("ralph-list", {
    description: "List active Ralph loops",
    handler: async (_args: string, ctx: CommandContext) => {
      const entries = listActiveLoopRegistryEntries(ctx.cwd).slice().sort((a, b) => a.taskDir.localeCompare(b.taskDir));
      if (entries.length === 0) {
        ctx.ui.notify("No active ralph loops found.", "info");
        return;
      }

      const lines = entries.map((entry) => `${basename(entry.taskDir)} | ${displayPath(ctx.cwd, entry.taskDir)} | ${entry.status} | ${entry.currentIteration}/${entry.maxIterations}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ralph-status", {
    description: "Show durable Ralph run status",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const target = resolveLifecycleTarget(ctx, parsed.value?.trim() || ".", "/ralph-status");
      if (!target) return;

      const statusFile = readStatusFile(target.taskDir);
      if (!statusFile) {
        ctx.ui.notify(`No ralph run data found at ${displayPath(ctx.cwd, target.taskDir)}.`, "warning");
        return;
      }

      const lines = [
        `task: ${displayPath(ctx.cwd, target.taskDir)}`,
        `status: ${statusFile.status}`,
        `startedAt: ${statusFile.startedAt}`,
        `currentIteration: ${statusFile.currentIteration}/${statusFile.maxIterations}`,
        `lastUpdate: ${statusFile.completedAt ?? statusFile.startedAt}`,
      ];

      const iterationRecords = readIterationRecords(target.taskDir);
      const lastIteration = iterationRecords[iterationRecords.length - 1];
      if (lastIteration) {
        lines.push(summarizeIterationRecord(lastIteration));
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ralph-resume", {
    description: "Start a new Ralph run from an existing RALPH.md",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const target = resolveLifecycleTarget(ctx, parsed.value?.trim() || ".", "/ralph-resume");
      if (!target) return;

      const activeEntry = findActiveLifecycleRegistryEntry(ctx, target.taskDir);
      if (activeEntry) {
        ctx.ui.notify(`A ralph loop is already active at ${displayPath(ctx.cwd, target.taskDir)}. Use /ralph-stop or /ralph-cancel first.`, "warning");
        return;
      }

      if (!existsSync(target.ralphPath)) {
        ctx.ui.notify(`No RALPH.md found at ${displayPath(ctx.cwd, target.ralphPath)}.`, "error");
        return;
      }

      await startRalphLoop(target.ralphPath, ctx, services.runRalphLoopFn, {});
    },
  });

  pi.registerCommand("ralph-archive", {
    description: "Archive Ralph run artifacts",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const target = resolveLifecycleTarget(ctx, parsed.value?.trim() || ".", "/ralph-archive");
      if (!target) return;

      const activeEntry = findActiveLifecycleRegistryEntry(ctx, target.taskDir);
      if (activeEntry) {
        ctx.ui.notify(`A ralph loop is already active at ${displayPath(ctx.cwd, target.taskDir)}. Use /ralph-stop or /ralph-cancel first.`, "warning");
        return;
      }

      const runnerDir = join(target.taskDir, ".ralph-runner");
      if (!existsSync(runnerDir) || !lstatSync(runnerDir).isDirectory()) {
        ctx.ui.notify(`No .ralph-runner directory found at ${displayPath(ctx.cwd, runnerDir)}.`, "warning");
        return;
      }

      try {
        const archiveDir = archiveRunnerArtifacts(target.taskDir);
        ctx.ui.notify(`Archived run artifacts to ${displayPath(ctx.cwd, archiveDir)}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to archive run artifacts: ${message}`, "error");
      }
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

      const now = new Date().toISOString();
      const activeRegistryEntries = () => listActiveLoopRegistryEntries(ctx.cwd);
      const { target: sessionTarget, persistedSessionState } = resolveSessionStopTarget(ctx, now);

      if (sessionTarget && !parsed.value) {
        applyStopTarget(pi, ctx, sessionTarget, now, persistedSessionState);
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
          applyStopTarget(pi, ctx, sessionTarget, now, persistedSessionState);
          return;
        }

        const registryTarget = activeRegistryEntries().find((entry) => entry.taskDir === taskDir || entry.ralphPath === inspection.ralphPath);
        if (registryTarget) {
          applyStopTarget(pi, ctx, materializeRegistryStopTarget(registryTarget), now);
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
            applyStopTarget(pi, ctx, materializeRegistryStopTarget(statusRegistryTarget), now);
            return;
          }
        }

        ctx.ui.notify(`No active ralph loop found at ${displayPath(ctx.cwd, inspection.ralphPath)}.`, "warning");
        return;
      }

      if (sessionTarget) {
        applyStopTarget(pi, ctx, sessionTarget, now, persistedSessionState);
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

      applyStopTarget(pi, ctx, materializeRegistryStopTarget(activeEntries[0]), now);
    },
  });

  pi.registerCommand("ralph-cancel", {
    description: "Cancel the active ralph iteration immediately",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      if (parsed.mode === "task") {
        ctx.ui.notify("/ralph-cancel expects a task folder or RALPH.md path, not task text.", "error");
        return;
      }

      const result = resolveRalphTarget(ctx, {
        commandName: "/ralph-cancel",
        explicitPath: parsed.value || undefined,
        checkCrossProcess: true,
      });
      if (!result || result.kind === "not-found") return;

      const statusPath = join(result.taskDir, ".ralph-runner", "status.json");
      if (!existsSync(statusPath)) {
        ctx.ui.notify(`No active loop found at ${displayPath(ctx.cwd, result.taskDir)}. No run data exists.`, "warning");
        return;
      }

      const statusFile = readStatusFile(result.taskDir);
      const finishedStatuses = new Set([
        "complete",
        "max-iterations",
        "no-progress-exhaustion",
        "stopped",
        "timeout",
        "error",
        "cancelled",
      ]);
      if (statusFile?.status && finishedStatuses.has(statusFile.status)) {
        ctx.ui.notify(
          `No active loop found at ${displayPath(ctx.cwd, result.taskDir)}. The loop already ended with status: ${statusFile.status}.`,
          "warning",
        );
        return;
      }

      createCancelSignal(result.taskDir);
      ctx.ui.notify("Cancel requested. The active iteration will be terminated immediately.", "warning");
    },
  });

  pi.registerCommand("ralph-scaffold", {
    description: "Create a non-interactive RALPH.md starter template",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseScaffoldArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const name = parsed.target;
      const preset = parsed.preset;
      if (!name) {
        ctx.ui.notify("/ralph-scaffold expects a task name or path.", "error");
        return;
      }

      let taskDir: string;
      let ralphPath: string;

      if (name.includes("/") || name.startsWith("./")) {
        ralphPath = resolve(ctx.cwd, name.endsWith("/RALPH.md") ? name : join(name, "RALPH.md"));
        taskDir = dirname(ralphPath);
      } else {
        const slug = slugifyTaskName(name);
        if (!slug) {
          ctx.ui.notify(`Cannot slugify "${name}" into a valid directory name.`, "error");
          return;
        }
        taskDir = join(ctx.cwd, slug);
        ralphPath = join(taskDir, "RALPH.md");
      }

      const resolvedTaskDir = resolve(taskDir);
      const resolvedCwd = resolve(ctx.cwd);
      const realCwd = (() => {
        try {
          return realpathSync(resolvedCwd);
        } catch {
          return resolvedCwd;
        }
      })();
      const isWithinRoot = (root: string, candidate: string): boolean => {
        const relativePath = relative(root, candidate);
        return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
      };
      const hasSymlinkedSegment = (root: string, candidate: string): boolean => {
        const relativePath = relative(root, candidate);
        if (relativePath === "") return false;
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
          return true;
        }

        const segments = relativePath.split(/[\\/]/).filter(Boolean);
        let currentPath = root;
        for (const segment of segments) {
          currentPath = join(currentPath, segment);
          if (!existsSync(currentPath)) continue;
          try {
            if (lstatSync(currentPath).isSymbolicLink()) return true;
          } catch {
            return true;
          }
        }

        return false;
      };

      if (!isWithinRoot(resolvedCwd, resolvedTaskDir)) {
        ctx.ui.notify("Task path must be within the current working directory.", "error");
        return;
      }

      if (hasSymlinkedSegment(resolvedCwd, resolvedTaskDir)) {
        ctx.ui.notify("Task path must be within the current working directory.", "error");
        return;
      }

      if (existsSync(ralphPath)) {
        ctx.ui.notify(`RALPH.md already exists at ${displayPath(ctx.cwd, ralphPath)}. Not overwriting.`, "error");
        return;
      }

      if (existsSync(taskDir) && readdirSync(taskDir).length > 0) {
        ctx.ui.notify(`Directory ${displayPath(ctx.cwd, taskDir)} already exists and is not empty. Not overwriting.`, "error");
        return;
      }

      mkdirSync(taskDir, { recursive: true });
      const realTaskDir = realpathSync(taskDir);
      if (!isWithinRoot(realCwd, realTaskDir)) {
        ctx.ui.notify("Task path must be within the current working directory.", "error");
        return;
      }

      let scaffoldTemplate: string;
      try {
        scaffoldTemplate = scaffoldTemplateForPreset(preset);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to load scaffold preset${preset ? ` "${preset}"` : ""}: ${message}`, "error");
        return;
      }

      writeFileSync(ralphPath, scaffoldTemplate, "utf8");
      ctx.ui.notify(`Scaffolded ${displayPath(ctx.cwd, ralphPath)}`, "info");
    },
  });

  pi.registerCommand("ralph-logs", {
    description: "Export run logs from a ralph task to an external directory",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseLogExportArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const resolvedTarget = resolveRalphTarget(ctx, {
        commandName: "/ralph-logs",
        explicitPath: parsed.path,
        allowCompletedRuns: true,
      });
      if (!resolvedTarget || resolvedTarget.kind === "not-found") return;
      const taskDir = resolvedTarget.taskDir;

      // Resolve dest directory
      const destDir = parsed.dest
        ? resolve(ctx.cwd, parsed.dest)
        : join(ctx.cwd, `ralph-logs-${new Date().toISOString().replace(/[:.]/g, "-")}`);

      try {
        const result = exportRalphLogs(taskDir, destDir);
        ctx.ui.notify(`Exported ${result.iterations} iteration records, ${result.events} events, ${result.transcripts} transcripts to ${displayPath(ctx.cwd, destDir)}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Log export failed: ${message}`, "error");
      }
    },
  });
}
