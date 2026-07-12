import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, BeforeAgentStartEvent, ToolCallEvent, ToolResultEvent as PiToolResultEvent } from "@mariozechner/pi-coding-agent";

import {
  buildMissionBrief,
  inspectExistingTarget,
  hasRuntimeArgToken,
  parseCommandArgs,
  parseRalphMarkdown,
  planTaskDraftTarget,
  resolveCommandRun,
  replaceArgsPlaceholders,
  runtimeArgEntriesToMap,
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
import { generateStaticRunnerReport } from "./runner-report.ts";
import { buildRalphRunSummary } from "./runner-summary.ts";
import { sessionRunKey, sessionRunStatusText, sessionRunWidgetLines, sortedSessionRuns, type SessionRunHandle } from "./session-runs.ts";
import {
  checkStopSignal,
  createStopSignal,
  createCancelSignal,
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
  loopToken?: string;
};

type ActiveSessionRun = SessionRunHandle & {
  state: LoopState;
  currentCommandCtx: CommandContext;
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

type LifecycleRunChoice = {
  taskDir: string;
  currentIteration: number;
  maxIterations: number;
  stopTarget: StopTarget;
  sessionRun?: ActiveSessionRun;
  persistedSessionState?: ActiveLoopState;
};

type LifecycleRunSelection =
  | { kind: "none" }
  | { kind: "selected"; choice: LifecycleRunChoice }
  | { kind: "cancelled" };

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
  const { target: sessionTarget } = resolvePersistedSessionStopTarget(ctx, now);
  const resolvedExplicitPath = explicitPath?.trim();

  if (resolvedExplicitPath) {
    const inspection = inspectExistingTarget(resolvedExplicitPath, ctx.cwd, true);
    if (inspection.kind === "run") {
      const taskDir = dirname(inspection.ralphPath);
      if (checkCrossProcess) {
        const registryTarget = activeRegistryEntries().find((entry) => pathsReferToSameLocation(entry.taskDir, taskDir));
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
            (entry) => pathsReferToSameLocation(entry.taskDir, taskDir) && entry.loopToken === statusFile.loopToken,
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


type ToolResultEvent = PiToolResultEvent;

type EventContext = ExtensionContext;

type NewSessionOptions = NonNullable<Parameters<NonNullable<CommandContext["newSession"]>>[0]>;
type ForkOptions = NonNullable<Parameters<NonNullable<CommandContext["fork"]>>[1]>;
type SwitchSessionOptions = NonNullable<Parameters<NonNullable<CommandContext["switchSession"]>>[1]>;
type SessionReplacementWithSession = NonNullable<NewSessionOptions["withSession"]>;
type SessionReplacementContext = Parameters<SessionReplacementWithSession>[0];

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

const COMMAND_OUTPUT_MAX_CHARS = 12_000;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateCommandOutput(output: string, originalBytes?: number, forceTruncated = false): { output: string; outputTruncated?: true; outputBytes?: number } {
  const outputBytes = originalBytes ?? byteLength(output);
  if (!forceTruncated && output.length <= COMMAND_OUTPUT_MAX_CHARS) return { output };

  const marker = `\n[ralph: command output truncated after ${COMMAND_OUTPUT_MAX_CHARS} chars; original ${outputBytes} bytes]\n`;
  const visibleChars = Math.max(0, COMMAND_OUTPUT_MAX_CHARS - marker.length);
  const headChars = Math.floor(visibleChars * 0.7);
  const tailChars = visibleChars - headChars;
  const truncated = [
    output.slice(0, headChars),
    marker,
    output.slice(-tailChars),
  ].join("");
  return { output: truncated, outputTruncated: true, outputBytes };
}

function commandOutputWithMetadata(output: string, extra: Omit<CommandOutput, "output" | "outputBytes" | "outputTruncated">, outputBytes?: number, forceTruncated = false): CommandOutput {
  const capped = truncateCommandOutput(output, outputBytes, forceTruncated);
  return { ...extra, ...capped };
}

type BoundedCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed: boolean;
  outputBytes: number;
  outputTruncated: boolean;
};

type BoundedCommandExecutor = (command: string, timeoutMs: number, cwd: string | undefined) => Promise<BoundedCommandResult>;

function injectedBoundedCommandExecutor(pi: unknown): BoundedCommandExecutor | undefined {
  const maybe = pi as { __ralphRunShellCommandBounded?: unknown };
  return typeof maybe.__ralphRunShellCommandBounded === "function" ? maybe.__ralphRunShellCommandBounded as BoundedCommandExecutor : undefined;
}

function runShellCommandBounded(command: string, timeoutMs: number, cwd: string | undefined): Promise<BoundedCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: useProcessGroup });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let capturedChars = 0;
    let outputTruncated = false;
    let settled = false;

    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      outputBytes += chunk.length;
      if (capturedChars >= COMMAND_OUTPUT_MAX_CHARS) {
        outputTruncated = true;
        return;
      }
      const remaining = COMMAND_OUTPUT_MAX_CHARS - capturedChars;
      const slice = text.slice(0, remaining);
      capturedChars += slice.length;
      if (stream === "stdout") stdout += slice;
      else stderr += slice;
      if (text.length > remaining) outputTruncated = true;
    };

    const finish = (result: BoundedCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };

    const killCommandTree = (): void => {
      try {
        if (useProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    };

    const timeout = setTimeout(() => {
      killCommandTree();
      finish({ stdout, stderr, code: null, signal: "SIGKILL", killed: true, outputBytes, outputTruncated });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      finish({ stdout, stderr, code, signal, killed: false, outputBytes, outputTruncated });
    });
  });
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
  const executeCommand = injectedBoundedCommandExecutor(pi) ?? runShellCommandBounded;
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    const semanticRun = replaceArgsPlaceholders(cmd.run, runtimeArgs);
    const shellPolicyBlocked = findShellPolicyBlockedCommandPattern(semanticRun, guardrails.shellPolicy);
    const blockedPattern = shellPolicyBlocked ?? findBlockedCommandPattern(semanticRun, guardrails.blockCommands);
    const resolvedRun = resolveCommandRun(cmd.run, runtimeArgs);
    const baseOutput = {
      name: cmd.name,
      command: semanticRun,
      ...(cmd.acceptance ? { acceptance: true } : {}),
    } satisfies Partial<CommandOutput> & { name: string; command: string };
    if (blockedPattern) {
      try {
        pi.appendEntry?.("ralph-blocked-command", { name: cmd.name, command: semanticRun, blockedPattern, cwd: repoCwd, taskDir });
      } catch (err) {
        if (!isKnownPiStaleExtensionContextError(err)) {
          throw err;
        }
      }
      results.push(commandOutputWithMetadata(`[blocked by guardrail: ${blockedPattern}]`, {
        ...baseOutput,
        status: "blocked",
        blockedPattern,
      }));
      continue;
    }

    const commandCwd = semanticRun.trim().startsWith("./") ? taskDir ?? repoCwd : repoCwd;

    try {
      const result = await executeCommand(resolvedRun, cmd.timeout * 1000, commandCwd);
      const output = (result.stdout + result.stderr).trim();
      const exitCode = typeof result.code === "number" ? result.code : 0;
      const signal = result.signal ?? (result.code === null ? "unknown" : undefined);
      results.push(
        result.killed
          ? commandOutputWithMetadata(`[timed out after ${cmd.timeout}s]`, {
              ...baseOutput,
              status: "timeout",
              timedOut: true,
            }, result.outputBytes, result.outputTruncated)
          : signal
            ? commandOutputWithMetadata(output ? `[signal ${signal}]\n${output}` : `[signal ${signal}]`, {
                ...baseOutput,
                status: "error",
              }, result.outputBytes, result.outputTruncated)
            : exitCode !== 0
              ? commandOutputWithMetadata(output ? `[exit ${exitCode}]\n${output}` : `[exit ${exitCode}]`, {
                  ...baseOutput,
                  status: "error",
                }, result.outputBytes, result.outputTruncated)
              : commandOutputWithMetadata(output, {
                  ...baseOutput,
                  status: "ok",
                }, result.outputBytes, result.outputTruncated),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push(commandOutputWithMetadata(`[error: ${message}]`, {
        ...baseOutput,
        status: "error",
      }));
    }
  }
  return results;
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


function getLoopIterationKey(loopToken: string, iteration: number): string {
  return `${loopToken}:${iteration}`;
}

function comparablePath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

function pathsReferToSameLocation(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
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
  const activeEntry = listActiveLoopRegistryEntries(ctx.cwd).find((entry) => pathsReferToSameLocation(entry.taskDir, taskDir));
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
      (entry) => pathsReferToSameLocation(entry.taskDir, taskDir) && entry.loopToken === statusFile.loopToken,
    );
  }

  return undefined;
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function getSelectedThinkingLevel(ctx: CommandContext, fallback?: string): string | undefined {
  const contextCandidates = ctx as unknown as {
    thinkingLevel?: unknown;
    currentThinkingLevel?: unknown;
    modelThinkingLevel?: unknown;
  };
  for (const candidate of [contextCandidates.thinkingLevel, contextCandidates.currentThinkingLevel, contextCandidates.modelThinkingLevel]) {
    if (typeof candidate === "string" && VALID_THINKING_LEVELS.has(candidate)) return candidate;
  }

  if (fallback && VALID_THINKING_LEVELS.has(fallback)) return fallback;
  const reasoning = (ctx.model as unknown as { reasoning?: unknown } | undefined)?.reasoning;
  if (typeof reasoning === "string" && VALID_THINKING_LEVELS.has(reasoning)) return reasoning;
  if (reasoning === true) return "high";
  return undefined;
}

export function parseStatusCommandArgs(raw: string): { value: string; summary: boolean; error?: string } {
  const tokenized = tokenizeArgsWithQuoteInfo(raw, "/ralph-status");
  if (tokenized.error) return { value: "", summary: false, error: tokenized.error };
  const valueTokens: string[] = [];
  let summary = false;
  for (const token of tokenized.tokens) {
    if (!token.quoted && token.value === "--summary") {
      summary = true;
    } else {
      valueTokens.push(token.value);
    }
  }
  return { value: valueTokens.join(" ").trim(), summary };
}

function summarizeIterationRecord(record: IterationRecord): string {
  const parts = [`lastIteration: #${record.iteration}`];
  if (typeof record.durationMs === "number") {
    parts.push(`durationMs=${record.durationMs}`);
  }
  parts.push(`progress=${record.progress}`);
  parts.push(`changedFiles=${record.changedFiles.length}`);
  parts.push(`noProgressStreak=${record.noProgressStreak}`);
  if (record.commandOutcomes?.length) {
    parts.push(`commands=${record.commandOutcomes.map((outcome) => `${outcome.name}:${outcome.status}`).join(",")}`);
  }
  if (record.completion?.acceptanceOutcomes?.length) {
    parts.push(`acceptance=${record.completion.acceptanceOutcomes.map((outcome) => `${outcome.name}:${outcome.status}`).join(",")}`);
  }
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

function assertSafeExistingDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe ${label}: ${path}`);
  }
}

function isAllowedDarwinSystemRootAlias(path: string): boolean {
  return process.platform === "darwin" && (path === "/var" || path === "/tmp" || path === "/etc");
}

function assertNoSymlinkedExistingPathSegments(targetPath: string, label: string): void {
  const resolvedTarget = resolve(targetPath);
  const parsed = parsePath(resolvedTarget);
  let current = parsed.root;
  const segments = resolvedTarget.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);

  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`Unsafe ${label}: ${current}`);
    }
    if (stat.isSymbolicLink() && !isAllowedDarwinSystemRootAlias(current)) {
      throw new Error(`Unsafe ${label}: ${current}`);
    }
  }
}

function ensureDirectoryPathWithoutSymlinks(targetPath: string, label: string): void {
  const resolvedTarget = resolve(targetPath);
  const parsed = parsePath(resolvedTarget);
  let current = parsed.root;
  const segments = resolvedTarget.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);

  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (!isAllowedDarwinSystemRootAlias(current)) {
          throw new Error(`Unsafe ${label}: ${current}`);
        }
        continue;
      }
      if (!stat.isDirectory()) {
        throw new Error(`Unsafe ${label}: ${current}`);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      mkdirSync(current);
      const createdStat = lstatSync(current);
      if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
        throw new Error(`Unsafe ${label}: ${current}`);
      }
    }
  }
}

type PreparedExportDirectory = {
  finalDestDir: string;
  stagingDir: string;
};

function prepareExportDirectory(destDir: string): PreparedExportDirectory {
  const finalDestDir = resolve(destDir);
  const parentDir = dirname(finalDestDir);
  ensureDirectoryPathWithoutSymlinks(parentDir, "export destination parent path segment");
  assertSafeExistingDirectory(parentDir, "export destination parent");

  if (existsSync(finalDestDir)) {
    assertSafeExistingDirectory(finalDestDir, "export destination");
    if (readdirSync(finalDestDir).length > 0) {
      throw new Error(`Export destination must be empty: ${finalDestDir}`);
    }
  } else {
    assertNoSymlinkedExistingPathSegments(finalDestDir, "export destination path segment");
  }

  const stagingDir = join(parentDir, `.ralph-logs-${basename(finalDestDir)}-${process.pid}-${randomUUID()}.tmp`);
  mkdirSync(stagingDir, { mode: 0o700 });
  assertNoSymlinkedExistingPathSegments(stagingDir, "export staging destination path segment");
  assertSafeExistingDirectory(stagingDir, "export staging destination");
  return { finalDestDir, stagingDir };
}

function finalizeExportDirectory(prepared: PreparedExportDirectory): string {
  assertNoSymlinkedExistingPathSegments(prepared.finalDestDir, "export destination path segment");
  if (existsSync(prepared.finalDestDir)) {
    assertSafeExistingDirectory(prepared.finalDestDir, "export destination");
    if (readdirSync(prepared.finalDestDir).length > 0) {
      throw new Error(`Export destination must be empty: ${prepared.finalDestDir}`);
    }
    rmdirSync(prepared.finalDestDir);
  }
  renameSync(prepared.stagingDir, prepared.finalDestDir);
  assertNoSymlinkedExistingPathSegments(prepared.finalDestDir, "export destination path segment");
  assertSafeExistingDirectory(prepared.finalDestDir, "export destination");
  return prepared.finalDestDir;
}

function prepareExportSubdirectory(parentDir: string, name: string): string {
  const dest = join(parentDir, name);
  if (existsSync(dest)) {
    assertSafeExistingDirectory(dest, `export ${name} destination`);
    if (readdirSync(dest).length > 0) {
      throw new Error(`Export ${name} destination must be empty: ${dest}`);
    }
  } else {
    mkdirSync(dest);
  }
  assertNoSymlinkedExistingPathSegments(dest, `export ${name} destination path segment`);
  assertSafeExistingDirectory(dest, `export ${name} destination`);
  return dest;
}

function assertOpenedSourceIsUnderRoot(src: string, srcFd: number, sourceRootRealPath: string) {
  const openedStat = fstatSync(srcFd);
  if (!openedStat.isFile()) {
    throw new Error(`Unsafe export source: ${src}`);
  }
  const currentStat = lstatSync(src);
  if (currentStat.isSymbolicLink() || !currentStat.isFile() || currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
    throw new Error(`Unsafe export source: ${src}`);
  }
  const realSource = realpathSync(src);
  if (!isWithinPath(sourceRootRealPath, realSource)) {
    throw new Error(`Unsafe export source: ${src}`);
  }
  return openedStat;
}

function assertDestinationParentUnderRoot(dest: string, destRootRealPath: string): void {
  const parentDir = dirname(dest);
  assertSafeExistingDirectory(parentDir, "export destination parent");
  const realParent = realpathSync(parentDir);
  if (!isWithinPath(destRootRealPath, realParent)) {
    throw new Error(`Unsafe export destination: ${dest}`);
  }
}

function copyExportFileNoOverwrite(src: string, dest: string, sourceRootRealPath: string, destRootRealPath: string, transform?: (data: Buffer) => Buffer): void {
  assertNoSymlinkedExistingPathSegments(dest, "export destination path segment");
  if (existsSync(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe export destination: ${dest}`);
    }
    throw new Error(`Export destination already exists: ${dest}`);
  }

  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let srcFd: number | undefined;
  let destFd: number | undefined;
  try {
    srcFd = openSync(src, fsConstants.O_RDONLY | noFollowFlag);
    const srcStat = assertOpenedSourceIsUnderRoot(src, srcFd, sourceRootRealPath);
    const sourceData = readFileSync(srcFd);
    const data = transform ? transform(sourceData) : sourceData;

    assertDestinationParentUnderRoot(dest, destRootRealPath);
    destFd = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, srcStat.mode & 0o666);
    assertDestinationParentUnderRoot(dest, destRootRealPath);
    const destStat = fstatSync(destFd);
    const currentDestStat = lstatSync(dest);
    if (!destStat.isFile() || currentDestStat.isSymbolicLink() || currentDestStat.dev !== destStat.dev || currentDestStat.ino !== destStat.ino) {
      throw new Error(`Unsafe export destination: ${dest}`);
    }
    if (!isWithinPath(destRootRealPath, realpathSync(dest))) {
      throw new Error(`Unsafe export destination: ${dest}`);
    }
    writeSync(destFd, data, 0, data.length);
  } finally {
    if (destFd !== undefined) closeSync(destFd);
    if (srcFd !== undefined) closeSync(srcFd);
  }
}

function parseLoopTokenFromStatusBytes(data: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const token = (parsed as { loopToken?: unknown }).loopToken;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    }
  } catch {
    // malformed status is still copied as raw evidence
  }
  return undefined;
}

function filterJsonlBytesByLoopToken(data: Buffer, loopToken: string | undefined): Buffer {
  if (!loopToken) return data;
  const lines = data.toString("utf8").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { loopToken?: unknown }).loopToken === loopToken) {
        kept.push(line);
      }
    } catch {
      // malformed lines are not current-loop evidence
    }
  }
  return Buffer.from(kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
}

function transcriptMatchesLoopToken(entry: string, loopToken: string | undefined): boolean {
  return !loopToken || entry.endsWith(`-${loopToken}.md`);
}

function countNonEmptyLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim()).length;
}

function exportRalphLogs(taskDir: string, destDir: string, options: { report?: boolean } = {}): { iterations: number; events: number; transcripts: number; reportPath?: string } {
  assertNoSymlinkedExistingPathSegments(taskDir, "task path");
  const runnerDir = join(taskDir, ".ralph-runner");
  assertNoSymlinkedExistingPathSegments(runnerDir, ".ralph-runner path");
  if (!existsSync(runnerDir)) {
    throw new Error(`No .ralph-runner directory found at ${taskDir}`);
  }
  const runnerStat = lstatSync(runnerDir);
  if (runnerStat.isSymbolicLink() || !runnerStat.isDirectory()) {
    throw new Error(`Unsafe .ralph-runner directory at ${taskDir}`);
  }
  const runnerRootRealPath = realpathSync(runnerDir);

  const preparedDest = prepareExportDirectory(destDir);
  const stagingRootRealPath = realpathSync(preparedDest.stagingDir);
  let finalized = false;

  try {
    let loopToken: string | undefined;
    const statusPath = join(runnerDir, "status.json");
    if (existsSync(statusPath)) {
      copyExportFileNoOverwrite(statusPath, join(preparedDest.stagingDir, "status.json"), runnerRootRealPath, stagingRootRealPath, (data) => {
        loopToken = parseLoopTokenFromStatusBytes(data);
        return data;
      });
    }

    writeFileSync(join(preparedDest.stagingDir, "final-summary.md"), buildRalphRunSummary(taskDir), { encoding: "utf8", flag: "wx" });

    for (const file of ["iterations.jsonl", "events.jsonl"]) {
      const src = join(runnerDir, file);
      if (!existsSync(src)) continue;
      let stat;
      try {
        stat = lstatSync(src);
      } catch {
        continue;
      }
      if (stat.isFile() && !stat.isSymbolicLink()) {
        copyExportFileNoOverwrite(src, join(preparedDest.stagingDir, file), runnerRootRealPath, stagingRootRealPath, (data) => filterJsonlBytesByLoopToken(data, loopToken));
      }
    }

    const transcriptsDir = join(runnerDir, "transcripts");
    let transcripts = 0;
    if (existsSync(transcriptsDir)) {
      assertNoSymlinkedExistingPathSegments(transcriptsDir, "transcripts path");
      const transcriptsStat = lstatSync(transcriptsDir);
      if (transcriptsStat.isDirectory() && !transcriptsStat.isSymbolicLink()) {
        const destTranscripts = prepareExportSubdirectory(preparedDest.stagingDir, "transcripts");
        for (const entry of readdirSync(transcriptsDir)) {
          if (!transcriptMatchesLoopToken(entry, loopToken)) continue;
          const srcPath = join(transcriptsDir, entry);
          let stat;
          try {
            stat = lstatSync(srcPath);
          } catch {
            continue;
          }
          if (stat.isFile() && !stat.isSymbolicLink()) {
            copyExportFileNoOverwrite(srcPath, join(destTranscripts, entry), runnerRootRealPath, stagingRootRealPath);
            transcripts++;
          }
        }
      }
    }

    let reportPath: string | undefined;
    if (options.report) {
      generateStaticRunnerReport(preparedDest.stagingDir);
      reportPath = join(preparedDest.finalDestDir, "report.html");
    }

    const iterations = countNonEmptyLines(join(preparedDest.stagingDir, "iterations.jsonl"));
    const events = countNonEmptyLines(join(preparedDest.stagingDir, "events.jsonl"));

    finalizeExportDirectory(preparedDest);
    finalized = true;

    return { iterations, events, transcripts, ...(reportPath ? { reportPath } : {}) };
  } finally {
    if (!finalized) {
      rmSync(preparedDest.stagingDir, { recursive: true, force: true });
    }
  }
}

export function parseLogExportArgs(raw: string): { path?: string; dest?: string; report?: boolean; error?: string } {
  const tokenized = tokenizeScaffoldArgs(raw);
  if (tokenized.error) return { error: tokenized.error.replace("/ralph-scaffold", "/ralph-logs") };
  const parts = tokenized.tokens;
  let path: string | undefined;
  let dest: string | undefined;
  let report = false;
  let i = 0;
  while (i < parts.length) {
    if (parts[i] === "--report") {
      report = true;
      i++;
    } else if (parts[i] === "--dest" || parts[i] === "-d") {
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
  return { path, dest, ...(report ? { report } : {}) };
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

function resolvePersistedSessionStopTarget(ctx: Pick<CommandContext, "cwd" | "sessionManager">, now: string): {
  target?: StopTarget;
  persistedSessionState?: ActiveLoopState;
} {

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

function materializeSessionStopTarget(run: ActiveSessionRun, now: string): StopTarget {
  return {
    cwd: run.settings.cwd,
    taskDir: run.settings.taskDir,
    ralphPath: run.settings.ralphPath,
    loopToken: run.loopToken,
    currentIteration: run.iteration,
    maxIterations: run.settings.maxIterations,
    startedAt: now,
    source: "session",
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
  sessionRun?: ActiveSessionRun,
): void {
  if (!createStopSignal(target.taskDir, target.loopToken)) {
    ctx.ui.notify("The active run changed before the stop request; no signal was written.", "warning");
    return;
  }

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
  try {
    const registryClaimed = writeActiveLoopRegistryEntry(registryCwd, registryEntry);
    const stopRequest = recordActiveLoopStopRequest(registryCwd, target.taskDir, now, registryEntry.loopToken);
    if (!registryClaimed || !stopRequest) {
      ctx.ui.notify("The stop signal was created, but active-run registry ownership changed.", "warning");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`The stop signal was created, but active-run registry update failed: ${message}`, "warning");
  }

  if (sessionRun) {
    sessionRun.state.stopRequested = true;
    persistLoopState(pi, toPersistedLoopState(sessionRun.state, { active: true, stopRequested: true }));
  } else if (target.source === "session" && persistedSessionState?.active) {
    persistLoopState(pi, { ...persistedSessionState, stopRequested: true });
  }

  ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
}

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

type RalphStartArgs = {
  value: string;
  parallel: boolean;
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

function tokenizeArgsWithQuoteInfo(raw: string, commandName: string): { tokens: Array<{ value: string; quoted: boolean }>; error?: string } {
  const tokens: Array<{ value: string; quoted: boolean }> = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let inToken = false;
  let quoted = false;

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
      quoted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push({ value: current, quoted });
        current = "";
        inToken = false;
        quoted = false;
      }
      continue;
    }

    current += char;
    inToken = true;
  }

  if (quote) {
    return { tokens, error: `Unterminated quote in ${commandName} arguments.` };
  }

  if (inToken) {
    tokens.push({ value: current, quoted });
  }

  return { tokens };
}

export function parseRalphStartArgs(raw: string): RalphStartArgs {
  const removals: Array<{ start: number; end: number }> = [];
  let quote: "'" | '"' | undefined;
  let tokenStart = -1;
  let tokenQuoted = false;

  for (let index = 0; index <= raw.length; index += 1) {
    const char = raw[index];
    const tokenBoundary = index === raw.length || (!quote && /\s/.test(char));
    if (tokenBoundary) {
      if (tokenStart >= 0 && !tokenQuoted && raw.slice(tokenStart, index) === "--parallel") {
        removals.push({ start: tokenStart, end: index });
      }
      tokenStart = -1;
      tokenQuoted = false;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      if (tokenStart < 0) tokenStart = index;
      tokenQuoted = true;
      quote = char;
      continue;
    }
    if (tokenStart < 0) tokenStart = index;
  }

  if (quote) {
    return { value: raw, parallel: false, error: "Unterminated quote in /ralph arguments." };
  }
  if (removals.length === 0) return { value: raw, parallel: false };

  let cursor = 0;
  let value = "";
  for (const removal of removals) {
    value += raw.slice(cursor, removal.start);
    cursor = removal.end;
  }
  value += raw.slice(cursor);
  return { value, parallel: true };
}

function tokenizeScaffoldArgs(raw: string): { tokens: string[]; error?: string } {
  const tokenized = tokenizeArgsWithQuoteInfo(raw, "/ralph-scaffold");
  return { tokens: tokenized.tokens.map((token) => token.value), error: tokenized.error };
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
  const sessionRuns = new Map<string, ActiveSessionRun>();
  type ContextSubscription = {
    context: CommandContext;
    callbacks: Set<(replacementCtx: CommandContext) => void>;
    restore?: () => void;
  };
  const contextSubscriptions = new WeakMap<CommandContext, ContextSubscription>();
  const bindContextSubscription = (subscription: ContextSubscription, ctx: CommandContext): void => {
    const existing = contextSubscriptions.get(ctx);
    if (existing && existing !== subscription) {
      throw new Error("Replacement context already has an independent Ralph subscription");
    }
    subscription.restore?.();
    contextSubscriptions.delete(subscription.context);
    subscription.context = ctx;
    subscription.restore = installSessionReplacementHooks(ctx, (replacementCtx) => {
      const nextContext = replacementCtx as CommandContext;
      bindContextSubscription(subscription, nextContext);
      for (const subscriber of subscription.callbacks) subscriber(nextContext);
    });
    contextSubscriptions.set(ctx, subscription);
  };
  const subscribeToSessionReplacement = (
    ctx: CommandContext,
    callback: (replacementCtx: CommandContext) => void,
  ): (() => void) => {
    let subscription = contextSubscriptions.get(ctx);
    if (!subscription) {
      subscription = { context: ctx, callbacks: new Set() };
      bindContextSubscription(subscription, ctx);
    }
    subscription.callbacks.add(callback);
    return () => {
      subscription?.callbacks.delete(callback);
      if (subscription?.callbacks.size === 0) {
        subscription.restore?.();
        contextSubscriptions.delete(subscription.context);
      }
    };
  };
  const updateSessionRunUi = (ctx: CommandContext): void => {
    ctx.ui.setStatus("ralph", sessionRunStatusText(sessionRuns));
    ctx.ui.setWidget?.("ralph-runs", sessionRunWidgetLines(sessionRuns));
  };
  let selectedThinkingLevel: string | undefined;
  const draftPlanFactory = services.createDraftPlan ?? createDraftPlanService;
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
  const collectLifecycleRuns = (ctx: CommandContext, now: string): LifecycleRunChoice[] => {
    const runs: LifecycleRunChoice[] = [];
    for (const sessionRun of sessionRuns.values()) {
      runs.push({
        taskDir: sessionRun.settings.taskDir,
        currentIteration: sessionRun.iteration,
        maxIterations: sessionRun.settings.maxIterations,
        stopTarget: materializeSessionStopTarget(sessionRun, now),
        sessionRun,
      });
    }
    for (const entry of listActiveLoopRegistryEntries(ctx.cwd)) {
      if (runs.some((run) => pathsReferToSameLocation(run.taskDir, entry.taskDir))) continue;
      runs.push({
        taskDir: entry.taskDir,
        currentIteration: entry.currentIteration,
        maxIterations: entry.maxIterations,
        stopTarget: materializeRegistryStopTarget(entry),
      });
    }
    const { target, persistedSessionState } = resolvePersistedSessionStopTarget(ctx, now);
    if (target && !runs.some((run) => pathsReferToSameLocation(run.taskDir, target.taskDir))) {
      runs.push({
        taskDir: target.taskDir,
        currentIteration: target.currentIteration,
        maxIterations: target.maxIterations,
        stopTarget: target,
        persistedSessionState,
      });
    }
    return runs.sort((left, right) => left.taskDir.localeCompare(right.taskDir));
  };
  const chooseLifecycleRun = async (
    ctx: CommandContext,
    commandName: "/ralph-status" | "/ralph-stop" | "/ralph-cancel",
    now: string,
  ): Promise<LifecycleRunSelection> => {
    const runs = collectLifecycleRuns(ctx, now);
    if (runs.length === 0) return { kind: "none" };
    if (runs.length === 1) return { kind: "selected", choice: runs[0] };

    const labels = runs.map((run) => `${basename(run.taskDir)} | ${displayPath(ctx.cwd, run.taskDir)} | ${run.currentIteration}/${run.maxIterations}`);
    const interactiveTui = ctx.hasUI && (ctx.ui.getAllThemes?.().length ?? 0) > 0;
    if (!interactiveTui) {
      ctx.ui.notify(`Multiple active ralph loops found. Use ${commandName} <task folder or RALPH.md> for an explicit target path:\n${labels.join("\n")}`, "error");
      return { kind: "cancelled" };
    }
    const choice = await ctx.ui.select(`Choose a Ralph run for ${commandName}`, [...labels, "Cancel"]);
    if (!choice || choice === "Cancel") return { kind: "cancelled" };
    const selectedIndex = labels.indexOf(choice);
    if (selectedIndex < 0) return { kind: "cancelled" };
    return { kind: "selected", choice: runs[selectedIndex] };
  };
  const resolveScopedActiveLoopState = (ctx: Pick<CommandContext, "sessionManager">): ActiveLoopState | undefined => {
    if (process.env[RALPH_RUNNER_TASK_DIR_ENV]?.trim()) return resolveActiveLoopState(ctx);
    const runs = sortedSessionRuns(sessionRuns);
    // No single run owns parent-session tools; each child enforces its own token-scoped guardrails.
    if (runs.length > 1) return undefined;
    if (runs.length === 0) return resolveActiveLoopState(ctx);

    const run = sessionRuns.get(runs[0].key)!;
    return {
      active: true,
      loopToken: run.loopToken,
      cwd: run.settings.cwd,
      taskDir: run.settings.taskDir,
      iteration: run.state.iteration,
      maxIterations: run.settings.maxIterations,
      noProgressStreak: run.state.noProgressStreak,
      iterationSummaries: [...run.state.iterationSummaries],
      guardrails: cloneGuardrails(run.state.guardrails),
      stopRequested: run.state.stopRequested,
    };
  };

  async function finalizeRalphRun(
    handle: ActiveSessionRun,
    initialCommandCtx: CommandContext,
    runLoopFn: typeof runRalphLoop,
    sessionPi: ExtensionAPI,
  ): Promise<void> {
    const { state: runState, settings } = handle;
    let unsubscribeFromSessionReplacement: (() => void) | undefined;
    try {
      unsubscribeFromSessionReplacement = subscribeToSessionReplacement(initialCommandCtx, (replacementCtx) => {
        handle.currentCommandCtx = replacementCtx;
        updateSessionRunUi(replacementCtx);
      });
      initialCommandCtx.ui.notify(`Ralph loop started: ${handle.name} (max ${runState.maxIterations} iterations)`, "info");
      const result = await runLoopFn({
        loopToken: handle.loopToken,
        ralphPath: settings.ralphPath,
        cwd: settings.cwd,
        timeout: settings.timeout,
        maxIterations: settings.maxIterations,
        guardrails: runState.guardrails,
        stopOnError: settings.stopOnError,
        runtimeArgs: settings.runtimeArgs,
        modelPattern: settings.modelPattern,
        thinkingLevel: settings.thinkingLevel,
        runCommandsFn: async (commands, guardrails, commandPi, cwd, taskDir, commandRuntimeArgs) => runCommands(commands, guardrails, commandPi as ExtensionAPI, commandRuntimeArgs ?? settings.runtimeArgs, cwd, taskDir),
        onStatusChange(status) {
          if (status === "initializing" || status === "running") handle.phase = status;
          updateSessionRunUi(handle.currentCommandCtx);
        },
        onIterationStart(iteration) {
          handle.iteration = iteration;
          runState.iteration = iteration;
          updateSessionRunUi(handle.currentCommandCtx);
        },
        onNotify(message, level) {
          const prefix = sessionRuns.size > 1 ? `[${handle.name}] ` : "";
          handle.currentCommandCtx.ui.notify(`${prefix}${message}`, level);
        },
        onIterationComplete(record) {
          handle.iteration = record.iteration;
          runState.iteration = record.iteration;
          runState.noProgressStreak = record.noProgressStreak;
          const summary: IterationSummary = {
            iteration: record.iteration,
            duration: record.durationMs ? Math.round(record.durationMs / 1000) : 0,
            progress: record.progress,
            changedFiles: record.changedFiles,
            noProgressStreak: record.noProgressStreak,
          };
          runState.iterationSummaries.push(summary);
          appendLoopEntryBestEffort(sessionPi, "ralph-iteration", {
            iteration: record.iteration,
            duration: summary.duration,
            ralphPath: runState.ralphPath,
            progress: record.progress,
            changedFiles: record.changedFiles,
            noProgressStreak: record.noProgressStreak,
          });
          persistLoopState(sessionPi, toPersistedLoopState(runState, { active: true, stopRequested: false }));
          updateSessionRunUi(handle.currentCommandCtx);
        },
        pi: sessionPi,
      });

      const total = runState.iterationSummaries.reduce((sum, iteration) => sum + iteration.duration, 0);
      const runtimeUi = handle.currentCommandCtx.ui;
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
      handle.currentCommandCtx.ui.notify(`Ralph loop failed: ${message}`, "error");
    } finally {
      for (const key of [...failCounts.keys()]) {
        if (key.startsWith(`${handle.loopToken}:`)) failCounts.delete(key);
      }
      runState.active = false;
      runState.stopRequested = false;
      sessionRuns.delete(handle.key);
      persistLoopState(sessionPi, toPersistedLoopState(runState, { active: false, stopRequested: false }));
      try {
        unsubscribeFromSessionReplacement?.();
      } catch {
        // Session replacement cleanup is best-effort after the run is removed.
      }
      try {
        updateSessionRunUi(handle.currentCommandCtx);
      } catch {
        // The command context may be stale after session replacement.
      }
    }
  }

  async function startRalphLoop(
    ralphPath: string,
    ctx: CommandContext,
    runLoopFn: typeof runRalphLoop = runRalphLoop,
    runtimeArgs: RuntimeArgs = {},
    parallelRequested = false,
  ) {
    const sessionPi = pi;
    const interactiveTui = ctx.hasUI && (ctx.ui.getAllThemes?.().length ?? 0) > 0;
    let handle: ActiveSessionRun;
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
      const taskDir = dirname(ralphPath);
      const activeForTask = [...sessionRuns.values()].find((run) => pathsReferToSameLocation(run.settings.taskDir, taskDir));
      const activeEntry = findActiveLifecycleRegistryEntry(ctx, taskDir);
      if (activeForTask || activeEntry) {
        ctx.ui.notify(`A ralph loop is already active at ${displayPath(ctx.cwd, taskDir)}. Use /ralph-stop or /ralph-cancel first.`, "warning");
        return;
      }

      const hasOtherActiveRun = sessionRuns.size > 0
        || listActiveLoopRegistryEntries(ctx.cwd).some((entry) => !pathsReferToSameLocation(entry.taskDir, taskDir));
      if (hasOtherActiveRun && !parallelRequested) {
        const warning = "Another Ralph run is active. Concurrent current-workspace runs can edit the same repository; Ralph does not lock files.";
        if (!interactiveTui) {
          ctx.ui.notify(`${warning} Re-run with --parallel to start explicitly.`, "error");
          return;
        }
        const choice = await ctx.ui.select(warning, ["Start in parallel", "Cancel"]);
        if (choice !== "Start in parallel") return;
      }

      currentStopOnError = frontmatter.stopOnError;
      const runtimeValidationError = validateRuntimeArgs(frontmatter, parsed.body, frontmatter.commands, runtimeArgs);
      if (runtimeValidationError) {
        ctx.ui.notify(runtimeValidationError, "error");
        return;
      }

      const loopToken = randomUUID();
      const runState: LoopState = {
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
        loopToken,
      };
      const modelPattern = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const thinkingLevel = getSelectedThinkingLevel(ctx, selectedThinkingLevel);
      const runtimeArgsSnapshot: RuntimeArgs = Object.create(null);
      Object.assign(runtimeArgsSnapshot, runtimeArgs);
      Object.freeze(runtimeArgsSnapshot);
      handle = {
        key: sessionRunKey(taskDir, loopToken),
        name: basename(taskDir),
        loopToken,
        phase: "initializing",
        iteration: 0,
        settings: Object.freeze({
          cwd: ctx.cwd,
          taskDir,
          ralphPath,
          modelPattern,
          thinkingLevel,
          runtimeArgs: runtimeArgsSnapshot,
          timeout: runState.timeout,
          maxIterations: runState.maxIterations,
          stopOnError: currentStopOnError,
        }),
        state: runState,
        currentCommandCtx: ctx,
      };
      sessionRuns.set(handle.key, handle);
      try {
        updateSessionRunUi(ctx);
      } catch (error) {
        sessionRuns.delete(handle.key);
        throw error;
      }
    } catch (err) {
      ctx.ui.notify(String(err), "error");
      return;
    }

    const finalizer = finalizeRalphRun(handle, ctx, runLoopFn, sessionPi);
    if (interactiveTui) {
      finalizer.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          process.stderr.write(`Ralph background run failed unexpectedly: ${message}\n`);
        } catch {
          // Best-effort surfacing only.
        }
      });
      return;
    }
    await finalizer;
  }


  async function handleDraftCommand(
    commandName: "ralph" | "ralph-draft",
    args: string,
    ctx: CommandContext,
    captureRuntimeArgs?: (runtimeArgs: RuntimeArgs) => void,
  ): Promise<string | undefined> {
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
    captureRuntimeArgs?.(runtimeArgs);
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
          const recovery = await chooseRecoveryMode(inspection.dirPath, ctx, !explicitPath);
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

  (pi.on as any)("thinking_level_select", async (event: { level?: unknown }) => {
    if (typeof event.level === "string" && VALID_THINKING_LEVELS.has(event.level)) selectedThinkingLevel = event.level;
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: EventContext) => {
    const persisted = resolveScopedActiveLoopState(ctx);
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

  });



  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: EventContext) => {
    const persisted = resolveScopedActiveLoopState(ctx);
    if (!persisted) return;
    const summaries = persisted?.iterationSummaries ?? [];
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
    const persisted = resolveScopedActiveLoopState(ctx);
    if (!persisted) return;

    if (event.toolName !== "bash") return;
    const output = event.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
    if (!shouldWarnForBashFailure(output)) return;

    if (typeof persisted.iteration !== "number") return;
    const failKey = getLoopIterationKey(persisted.loopToken, persisted.iteration);
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
      const startArgs = parseRalphStartArgs(args ?? "");
      if (startArgs.error) {
        ctx.ui.notify(startArgs.error, "error");
        return;
      }
      let runtimeArgs: RuntimeArgs = Object.create(null);
      const ralphPath = await handleDraftCommand("ralph", startArgs.value, ctx, (parsedRuntimeArgs) => {
        runtimeArgs = parsedRuntimeArgs;
      });
      if (!ralphPath) return;
      await startRalphLoop(ralphPath, ctx, services.runRalphLoopFn, runtimeArgs, startArgs.parallel);
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
      const statusArgs = parseStatusCommandArgs(args ?? "");
      if (statusArgs.error) {
        ctx.ui.notify(statusArgs.error, "error");
        return;
      }
      const parsed = parseCommandArgs(statusArgs.value);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      let taskDir: string;
      if (!parsed.value) {
        const selection = await chooseLifecycleRun(ctx, "/ralph-status", new Date().toISOString());
        if (selection.kind === "selected") {
          taskDir = selection.choice.taskDir;
        } else if (selection.kind === "cancelled") {
          return;
        } else {
          const target = resolveLifecycleTarget(ctx, ".", "/ralph-status");
          if (!target) return;
          taskDir = target.taskDir;
        }
      } else {
        const target = resolveLifecycleTarget(ctx, parsed.value.trim(), "/ralph-status");
        if (!target) return;
        taskDir = target.taskDir;
      }

      if (statusArgs.summary) {
        ctx.ui.notify(buildRalphRunSummary(taskDir), "info");
        return;
      }

      const statusFile = readStatusFile(taskDir);
      if (!statusFile) {
        ctx.ui.notify(`No ralph run data found at ${displayPath(ctx.cwd, taskDir)}.`, "warning");
        return;
      }

      const lines = [
        `task: ${displayPath(ctx.cwd, taskDir)}`,
        `status: ${statusFile.status}`,
        `startedAt: ${statusFile.startedAt}`,
        `currentIteration: ${statusFile.currentIteration}/${statusFile.maxIterations}`,
        `lastUpdate: ${statusFile.completedAt ?? statusFile.startedAt}`,
      ];

      const iterationRecords = readIterationRecords(taskDir);
      const matchingIterationRecords = statusFile.loopToken ? iterationRecords.filter((record) => record.loopToken === statusFile.loopToken) : iterationRecords;
      const lastIteration = matchingIterationRecords[matchingIterationRecords.length - 1];
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
      if (hasRuntimeArgToken(args ?? "")) {
        ctx.ui.notify("/ralph-stop does not accept --arg. Use a task folder or RALPH.md path only.", "error");
        return;
      }
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
        const liveRun = [...sessionRuns.values()].find((run) => pathsReferToSameLocation(run.settings.taskDir, taskDir));
        if (liveRun) {
          applyStopTarget(pi, ctx, materializeSessionStopTarget(liveRun, now), now, undefined, liveRun);
          return;
        }

        const { target: persistedTarget, persistedSessionState } = resolvePersistedSessionStopTarget(ctx, now);
        if (persistedTarget && pathsReferToSameLocation(persistedTarget.taskDir, taskDir)) {
          applyStopTarget(pi, ctx, persistedTarget, now, persistedSessionState);
          return;
        }

        const registryTarget = activeRegistryEntries().find(
          (entry) => pathsReferToSameLocation(entry.taskDir, taskDir) || pathsReferToSameLocation(entry.ralphPath, inspection.ralphPath),
        );
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
            (entry) => pathsReferToSameLocation(entry.taskDir, taskDir) && entry.loopToken === statusFile.loopToken,
          );
          if (statusRegistryTarget) {
            applyStopTarget(pi, ctx, materializeRegistryStopTarget(statusRegistryTarget), now);
            return;
          }
        }

        ctx.ui.notify(`No active ralph loop found at ${displayPath(ctx.cwd, inspection.ralphPath)}.`, "warning");
        return;
      }

      const selection = await chooseLifecycleRun(ctx, "/ralph-stop", now);
      if (selection.kind === "none") {
        ctx.ui.notify("No active ralph loops found.", "warning");
        return;
      }
      if (selection.kind === "selected") {
        applyStopTarget(
          pi,
          ctx,
          selection.choice.stopTarget,
          now,
          selection.choice.persistedSessionState,
          selection.choice.sessionRun,
        );
      }
    },
  });

  pi.registerCommand("ralph-cancel", {
    description: "Cancel the active ralph iteration immediately",
    handler: async (args: string, ctx: CommandContext) => {
      if (hasRuntimeArgToken(args ?? "")) {
        ctx.ui.notify("/ralph-cancel does not accept --arg. Use a task folder or RALPH.md path only.", "error");
        return;
      }
      const parsed = parseCommandArgs(args ?? "");
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      if (parsed.mode === "task") {
        ctx.ui.notify("/ralph-cancel expects a task folder or RALPH.md path, not task text.", "error");
        return;
      }

      if (!parsed.value) {
        const selection = await chooseLifecycleRun(ctx, "/ralph-cancel", new Date().toISOString());
        if (selection.kind === "selected") {
          if (selection.choice.persistedSessionState) {
            const statusFile = readStatusFile(selection.choice.taskDir);
            if (!statusFile) {
              ctx.ui.notify(`No active loop found at ${displayPath(ctx.cwd, selection.choice.taskDir)}. No run data exists.`, "warning");
              return;
            }
            if (statusFile.loopToken !== selection.choice.stopTarget.loopToken) {
              ctx.ui.notify(
                `No active loop found at ${displayPath(ctx.cwd, selection.choice.taskDir)}. The durable status belongs to a different run.`,
                "warning",
              );
              return;
            }
            if (["complete", "max-iterations", "no-progress-exhaustion", "stopped", "timeout", "error", "cancelled"].includes(statusFile.status)) {
              ctx.ui.notify(
                `No active loop found at ${displayPath(ctx.cwd, selection.choice.taskDir)}. The loop already ended with status: ${statusFile.status}.`,
                "warning",
              );
              return;
            }
          }
          if (!createCancelSignal(selection.choice.taskDir, selection.choice.stopTarget.loopToken)) {
            ctx.ui.notify("The active run changed before cancellation; no signal was written.", "warning");
            return;
          }
          ctx.ui.notify("Cancel requested. The active iteration will be terminated immediately.", "warning");
          return;
        }
        if (selection.kind === "cancelled") return;
        ctx.ui.notify("No active ralph loops found.", "warning");
        return;
      }

      const result = resolveRalphTarget(ctx, {
        commandName: "/ralph-cancel",
        explicitPath: parsed.value || undefined,
        checkCrossProcess: true,
      });
      if (!result || result.kind === "not-found") return;

      const liveRun = [...sessionRuns.values()].find((run) => pathsReferToSameLocation(run.settings.taskDir, result.taskDir));
      if (liveRun) {
        if (!createCancelSignal(liveRun.settings.taskDir, liveRun.loopToken)) {
          ctx.ui.notify("The active run changed before cancellation; no signal was written.", "warning");
          return;
        }
        ctx.ui.notify("Cancel requested. The active iteration will be terminated immediately.", "warning");
        return;
      }

      const statusPath = join(result.taskDir, ".ralph-runner", "status.json");
      if (!existsSync(statusPath)) {
        ctx.ui.notify(`No active loop found at ${displayPath(ctx.cwd, result.taskDir)}. No run data exists.`, "warning");
        return;
      }

      const statusFile = readStatusFile(result.taskDir);
      if (!statusFile) {
        ctx.ui.notify(`No active loop found at ${displayPath(ctx.cwd, result.taskDir)}. No readable run status exists.`, "warning");
        return;
      }
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

      if (!createCancelSignal(result.taskDir, statusFile.loopToken)) {
        ctx.ui.notify("The active run changed before cancellation; no signal was written.", "warning");
        return;
      }
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
        const result = exportRalphLogs(taskDir, destDir, { report: parsed.report });
        const reportNote = result.reportPath ? ` with static report ${displayPath(ctx.cwd, result.reportPath)}` : "";
        ctx.ui.notify(`Exported ${result.iterations} iteration records, ${result.events} events, ${result.transcripts} transcripts to ${displayPath(ctx.cwd, destDir)}${reportNote}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Log export failed: ${message}`, "error");
      }
    },
  });
}
