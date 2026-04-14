import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// --- Types ---

export type RunnerStatus =
  | "initializing"
  | "running"
  | "complete"
  | "max-iterations"
  | "no-progress-exhaustion"
  | "stopped"
  | "timeout"
  | "error"
  | "cancelled";

export type ProgressState = boolean | "unknown";

export type CompletionRecord = {
  promiseSeen: boolean;
  durableProgressObserved: boolean;
  gateChecked: boolean;
  gatePassed: boolean;
  gateBlocked: boolean;
  blockingReasons: string[];
};

export type Guardrails = {
  blockCommands: string[];
  protectedFiles: string[];
};

export type IterationRecord = {
  iteration: number;
  status: "running" | "complete" | "timeout" | "error";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  progress: ProgressState;
  changedFiles: string[];
  noProgressStreak: number;
  completionPromiseMatched?: boolean;
  completionGate?: { ready: boolean; reasons: string[] };
  completion?: CompletionRecord;
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
  loopToken?: string;
};

export type RunnerStartedEvent = {
  type: "runner.started";
  timestamp: string;
  loopToken: string;
  cwd: string;
  taskDir: string;
  status: "initializing";
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  guardrails: Guardrails;
};

export type IterationStartedEvent = {
  type: "iteration.started";
  timestamp: string;
  iteration: number;
  loopToken: string;
  status: "running";
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
};

export type DurableProgressObservedEvent = {
  type: "durable.progress.observed";
  timestamp: string;
  iteration: number;
  loopToken: string;
  progress: ProgressState;
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type DurableProgressMissingEvent = {
  type: "durable.progress.missing";
  timestamp: string;
  iteration: number;
  loopToken: string;
  progress: ProgressState;
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type DurableProgressUnknownEvent = {
  type: "durable.progress.unknown";
  timestamp: string;
  iteration: number;
  loopToken: string;
  progress: ProgressState;
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type CompletionPromiseSeenEvent = {
  type: "completion.promise.seen";
  timestamp: string;
  iteration: number;
  loopToken: string;
  completionPromise: string;
};

export type CompletionGateCheckedEvent = {
  type: "completion.gate.checked";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: boolean;
  reasons: string[];
};

export type CompletionGatePassedEvent = {
  type: "completion.gate.passed";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: boolean;
  reasons: string[];
};

export type CompletionGateBlockedEvent = {
  type: "completion.gate.blocked";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: boolean;
  reasons: string[];
};

export type IterationCompletedEvent = {
  type: "iteration.completed";
  timestamp: string;
  iteration: number;
  loopToken: string;
  status: "complete" | "timeout" | "error";
  progress: ProgressState;
  changedFiles: string[];
  noProgressStreak: number;
  completionPromiseMatched?: boolean;
  completionGate?: { ready: boolean; reasons: string[] };
  completion?: CompletionRecord;
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
  reason?: string;
};

export type RunnerFinishedEvent = {
  type: "runner.finished";
  timestamp: string;
  loopToken: string;
  status: RunnerStatus;
  iterations: number;
  totalDurationMs: number;
};

export type RunnerEvent =
  | RunnerStartedEvent
  | IterationStartedEvent
  | IterationCompletedEvent
  | DurableProgressObservedEvent
  | DurableProgressMissingEvent
  | DurableProgressUnknownEvent
  | CompletionPromiseSeenEvent
  | CompletionGateCheckedEvent
  | CompletionGatePassedEvent
  | CompletionGateBlockedEvent
  | RunnerFinishedEvent;

export type RunnerStatusFile = {
  loopToken: string;
  ralphPath: string;
  taskDir: string;
  cwd: string;
  status: RunnerStatus;
  currentIteration: number;
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  startedAt: string;
  completedAt?: string;
  guardrails: Guardrails;
};

export type ActiveLoopRegistryEntry = {
  taskDir: string;
  ralphPath: string;
  cwd: string;
  loopToken: string;
  status: RunnerStatus;
  currentIteration: number;
  maxIterations: number;
  startedAt: string;
  updatedAt: string;
  stopRequestedAt?: string;
  stopObservedAt?: string;
};

export type TranscriptCommandOutput = {
  name: string;
  output: string;
};

export type IterationTranscriptInput = {
  record: IterationRecord;
  prompt: string;
  commandOutputs: TranscriptCommandOutput[];
  assistantText?: string;
  note?: string;
};

// --- Constants ---

const RUNNER_DIR_NAME = ".ralph-runner";
const TRANSCRIPTS_DIR = "transcripts";
const STATUS_FILE = "status.json";
const ITERATIONS_FILE = "iterations.jsonl";
const EVENTS_FILE = "events.jsonl";
const STOP_FLAG_FILE = "stop.flag";
const ACTIVE_LOOP_REGISTRY_DIR = "active-loops";
const ACTIVE_LOOP_REGISTRY_LEGACY_FILE = "active-loops.json";
const ACTIVE_LOOP_REGISTRY_FILE_EXTENSION = ".json";
const ACTIVE_LOOP_REGISTRY_STALE_AFTER_MS = 30 * 60 * 1000;
const ACTIVE_LOOP_ACTIVE_STATUSES = new Set<RunnerStatus>(["initializing", "running"]);

// --- Helper ---

function runnerDir(taskDir: string): string {
  return join(taskDir, RUNNER_DIR_NAME);
}

function transcriptDir(taskDir: string): string {
  return join(runnerDir(taskDir), TRANSCRIPTS_DIR);
}

// --- Public API ---

export function ensureRunnerDir(taskDir: string): string {
  const dir = runnerDir(taskDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function writeStatusFile(taskDir: string, status: RunnerStatusFile): void {
  const dir = ensureRunnerDir(taskDir);
  writeFileSync(join(dir, STATUS_FILE), JSON.stringify(status, null, 2), "utf8");
}

export function readStatusFile(taskDir: string): RunnerStatusFile | undefined {
  const filePath = join(runnerDir(taskDir), STATUS_FILE);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as RunnerStatusFile;
  } catch {
    return undefined;
  }
}

export function appendIterationRecord(taskDir: string, record: IterationRecord): void {
  const dir = ensureRunnerDir(taskDir);
  const filePath = join(dir, ITERATIONS_FILE);
  const line = JSON.stringify(record) + "\n";
  writeFileSync(filePath, line, { flag: "a", encoding: "utf8" });
}

export function appendRunnerEvent(taskDir: string, event: RunnerEvent): void {
  const dir = ensureRunnerDir(taskDir);
  const filePath = join(dir, EVENTS_FILE);
  writeFileSync(filePath, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isProgressState(value: unknown): value is ProgressState {
  return value === true || value === false || value === "unknown";
}

function isGuardrails(value: unknown): value is Guardrails {
  if (!isRecord(value)) return false;
  return isStringArray(value.blockCommands) && isStringArray(value.protectedFiles);
}

function isCompletionRecord(value: unknown): value is CompletionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.promiseSeen === "boolean" &&
    typeof value.durableProgressObserved === "boolean" &&
    typeof value.gateChecked === "boolean" &&
    typeof value.gatePassed === "boolean" &&
    typeof value.gateBlocked === "boolean" &&
    isStringArray(value.blockingReasons)
  );
}

function isCompletionGate(value: unknown): value is { ready: boolean; reasons: string[] } {
  if (!isRecord(value)) return false;
  return typeof value.ready === "boolean" && isStringArray(value.reasons);
}

function isIterationCompletedStatus(value: unknown): value is IterationRecord["status"] {
  return value === "complete" || value === "timeout" || value === "error";
}

function isRunnerEvent(value: unknown): value is RunnerEvent {
  if (!isRecord(value) || !isString(value.type) || !isString(value.timestamp)) return false;

  switch (value.type) {
    case "runner.started":
      return (
        isString(value.loopToken) &&
        isString(value.cwd) &&
        isString(value.taskDir) &&
        value.status === "initializing" &&
        isNumber(value.maxIterations) &&
        Number.isInteger(value.maxIterations) &&
        value.maxIterations > 0 &&
        isNumber(value.timeout) &&
        (value.completionPromise === undefined || isString(value.completionPromise)) &&
        isGuardrails(value.guardrails)
      );
    case "iteration.started":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.status === "running" &&
        isNumber(value.maxIterations) &&
        Number.isInteger(value.maxIterations) &&
        value.maxIterations > 0 &&
        isNumber(value.timeout) &&
        (value.completionPromise === undefined || isString(value.completionPromise))
      );
    case "durable.progress.observed":
    case "durable.progress.missing":
    case "durable.progress.unknown":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        isProgressState(value.progress) &&
        isStringArray(value.changedFiles) &&
        (value.snapshotTruncated === undefined || typeof value.snapshotTruncated === "boolean") &&
        (value.snapshotErrorCount === undefined || (isNumber(value.snapshotErrorCount) && Number.isInteger(value.snapshotErrorCount) && value.snapshotErrorCount >= 0))
      );
    case "completion.promise.seen":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        isString(value.completionPromise)
      );
    case "completion.gate.checked":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        typeof value.ready === "boolean" &&
        isStringArray(value.reasons)
      );
    case "completion.gate.passed":
    case "completion.gate.blocked":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        typeof value.ready === "boolean" &&
        isStringArray(value.reasons)
      );
    case "iteration.completed":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        isIterationCompletedStatus(value.status) &&
        isProgressState(value.progress) &&
        isStringArray(value.changedFiles) &&
        isNumber(value.noProgressStreak) &&
        Number.isInteger(value.noProgressStreak) &&
        value.noProgressStreak >= 0 &&
        (value.completionPromiseMatched === undefined || typeof value.completionPromiseMatched === "boolean") &&
        (value.completionGate === undefined || isCompletionGate(value.completionGate)) &&
        (value.completion === undefined || isCompletionRecord(value.completion)) &&
        (value.snapshotTruncated === undefined || typeof value.snapshotTruncated === "boolean") &&
        (value.snapshotErrorCount === undefined || (isNumber(value.snapshotErrorCount) && Number.isInteger(value.snapshotErrorCount) && value.snapshotErrorCount >= 0)) &&
        (value.reason === undefined || isString(value.reason))
      );
    case "runner.finished":
      return (
        isString(value.loopToken) &&
        isRunnerStatus(value.status) &&
        isNumber(value.iterations) &&
        Number.isInteger(value.iterations) &&
        value.iterations >= 0 &&
        isNumber(value.totalDurationMs) &&
        value.totalDurationMs >= 0
      );
    default:
      return false;
  }
}

export function readRunnerEvents(taskDir: string): RunnerEvent[] {
  const filePath = join(runnerDir(taskDir), EVENTS_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isRunnerEvent(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function normalizeTranscriptText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function summarizeCompletionRecord(record: IterationRecord): CompletionRecord | undefined {
  if (record.completion) return record.completion;
  if (record.completionPromiseMatched === undefined && record.completionGate === undefined) return undefined;
  return {
    promiseSeen: record.completionPromiseMatched ?? false,
    durableProgressObserved: record.progress === true,
    gateChecked: record.completionPromiseMatched === true && record.progress !== false,
    gatePassed: record.completionGate?.ready === true,
    gateBlocked: record.completionGate?.ready === false,
    blockingReasons: record.completionGate?.reasons ?? [],
  };
}

function completionHeaderLines(record: IterationRecord): string[] {
  const completion = summarizeCompletionRecord(record);
  if (!completion) return [];
  return [
    `- Completion promise seen: ${completion.promiseSeen ? "yes" : "no"}`,
    `- Durable progress observed: ${completion.durableProgressObserved ? "yes" : "no"}`,
    `- Completion gate checked: ${completion.gateChecked ? "yes" : "no"}`,
    `- Completion gate: ${completion.gateChecked ? (completion.gatePassed ? "passed" : completion.gateBlocked ? "blocked" : "pending") : "not checked"}`,
    `- Blocking reasons: ${completion.blockingReasons.length > 0 ? completion.blockingReasons.join("; ") : "none"}`,
  ];
}

function transcriptHeaderLines(record: IterationRecord): string[] {
  const lines = [
    `- Status: ${record.status}`,
    `- Started: ${record.startedAt}`,
    `- Progress: ${String(record.progress)}`,
    `- Changed files: ${record.changedFiles.length > 0 ? record.changedFiles.join(", ") : "none"}`,
    `- No-progress streak: ${record.noProgressStreak}`,
    ...completionHeaderLines(record),
  ];
  if (record.completedAt) lines.push(`- Completed: ${record.completedAt}`);
  if (typeof record.durationMs === "number") lines.push(`- Duration: ${Math.round(record.durationMs / 1000)}s`);
  if (record.snapshotTruncated !== undefined) lines.push(`- Snapshot truncated: ${record.snapshotTruncated ? "yes" : "no"}`);
  if (record.snapshotErrorCount !== undefined) lines.push(`- Snapshot errors: ${record.snapshotErrorCount}`);
  return lines;
}

export function writeIterationTranscript(taskDir: string, transcript: IterationTranscriptInput): string {
  const dir = transcriptDir(taskDir);
  mkdirSync(dir, { recursive: true });
  const runToken = transcript.record.loopToken ?? "unknown";
  const filePath = join(dir, `iteration-${String(transcript.record.iteration).padStart(3, "0")}-${runToken}.md`);
  const lines: string[] = [`# Iteration ${transcript.record.iteration}`, "", ...transcriptHeaderLines(transcript.record), "", "## Rendered prompt", "", "```text", normalizeTranscriptText(transcript.prompt), "```", "", "## Command outputs", ""];

  if (transcript.commandOutputs.length === 0) {
    lines.push("None.");
  } else {
    for (const output of transcript.commandOutputs) {
      lines.push(`### ${output.name}`, "", "```text", normalizeTranscriptText(output.output), "```", "");
    }
    lines.pop();
  }

  if (transcript.assistantText !== undefined) {
    lines.push("", "## Assistant text", "", "```text", normalizeTranscriptText(transcript.assistantText), "```");
  } else if (transcript.note) {
    lines.push("", "## Outcome", "", transcript.note);
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

export function readIterationRecords(taskDir: string): IterationRecord[] {
  const filePath = join(runnerDir(taskDir), ITERATIONS_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as IterationRecord);
  } catch {
    return [];
  }
}

export function createStopSignal(taskDir: string): void {
  const dir = ensureRunnerDir(taskDir);
  writeFileSync(join(dir, STOP_FLAG_FILE), "", "utf8");
}

export function checkStopSignal(taskDir: string): boolean {
  return existsSync(join(runnerDir(taskDir), STOP_FLAG_FILE));
}

export function clearStopSignal(taskDir: string): void {
  const filePath = join(runnerDir(taskDir), STOP_FLAG_FILE);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

export function clearRunnerDir(taskDir: string): void {
  const dir = runnerDir(taskDir);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function activeLoopRegistryDir(cwd: string): string {
  return join(runnerDir(cwd), ACTIVE_LOOP_REGISTRY_DIR);
}

function activeLoopRegistryEntryPath(cwd: string, taskDir: string): string {
  return join(activeLoopRegistryDir(cwd), `${createHash("sha256").update(taskDir).digest("hex")}${ACTIVE_LOOP_REGISTRY_FILE_EXTENSION}`);
}

function ensureActiveLoopRegistryDir(cwd: string): string {
  const dir = activeLoopRegistryDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function writeFileAtomic(filePath: string, contents: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, filePath);
}

function parseIsoTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isActiveLoopRegistryEntryStale(entry: ActiveLoopRegistryEntry): boolean {
  const updatedAtMs = parseIsoTimestamp(entry.updatedAt);
  return updatedAtMs === undefined || Date.now() - updatedAtMs > ACTIVE_LOOP_REGISTRY_STALE_AFTER_MS;
}

function isRunnerStatus(value: unknown): value is RunnerStatus {
  return (
    value === "initializing" ||
    value === "running" ||
    value === "complete" ||
    value === "max-iterations" ||
    value === "no-progress-exhaustion" ||
    value === "stopped" ||
    value === "timeout" ||
    value === "error" ||
    value === "cancelled"
  );
}

function normalizeActiveLoopRegistryEntry(entry: unknown): ActiveLoopRegistryEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as Record<string, unknown>;
  if (
    typeof candidate.taskDir !== "string" ||
    candidate.taskDir.length === 0 ||
    typeof candidate.ralphPath !== "string" ||
    candidate.ralphPath.length === 0 ||
    typeof candidate.cwd !== "string" ||
    candidate.cwd.length === 0 ||
    typeof candidate.loopToken !== "string" ||
    candidate.loopToken.length === 0 ||
    !isRunnerStatus(candidate.status) ||
    typeof candidate.currentIteration !== "number" ||
    !Number.isInteger(candidate.currentIteration) ||
    candidate.currentIteration < 0 ||
    typeof candidate.maxIterations !== "number" ||
    !Number.isInteger(candidate.maxIterations) ||
    candidate.maxIterations <= 0 ||
    typeof candidate.startedAt !== "string" ||
    candidate.startedAt.length === 0 ||
    typeof candidate.updatedAt !== "string" ||
    candidate.updatedAt.length === 0
  ) {
    return undefined;
  }

  const stopRequestedAt = candidate.stopRequestedAt;
  const stopObservedAt = candidate.stopObservedAt;
  if ((stopRequestedAt !== undefined && typeof stopRequestedAt !== "string") || (stopObservedAt !== undefined && typeof stopObservedAt !== "string")) {
    return undefined;
  }

  const normalized: ActiveLoopRegistryEntry = {
    taskDir: candidate.taskDir,
    ralphPath: candidate.ralphPath,
    cwd: candidate.cwd,
    loopToken: candidate.loopToken,
    status: candidate.status,
    currentIteration: candidate.currentIteration,
    maxIterations: candidate.maxIterations,
    startedAt: candidate.startedAt,
    updatedAt: candidate.updatedAt,
  };
  if (typeof stopRequestedAt === "string") normalized.stopRequestedAt = stopRequestedAt;
  if (typeof stopObservedAt === "string") normalized.stopObservedAt = stopObservedAt;
  return normalized;
}

function readActiveLoopRegistryEntryFile(filePath: string): ActiveLoopRegistryEntry | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const entry = normalizeActiveLoopRegistryEntry(parsed);
    if (!entry) {
      rmSync(filePath, { force: true });
      return undefined;
    }
    if (isActiveLoopRegistryEntryStale(entry)) {
      rmSync(filePath, { force: true });
      return undefined;
    }
    return entry;
  } catch {
    rmSync(filePath, { force: true });
    return undefined;
  }
}

function readLegacyActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  const filePath = join(runnerDir(cwd), ACTIVE_LOOP_REGISTRY_LEGACY_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const normalizedEntries = parsed.map(normalizeActiveLoopRegistryEntry).filter((entry): entry is ActiveLoopRegistryEntry => entry !== undefined);
    const freshEntries = normalizedEntries.filter((entry) => !isActiveLoopRegistryEntryStale(entry));

    if (freshEntries.length !== normalizedEntries.length) {
      if (freshEntries.length > 0) {
        writeFileSync(filePath, `${JSON.stringify(freshEntries, null, 2)}\n`, "utf8");
      } else {
        rmSync(filePath, { force: true });
      }
    }

    return freshEntries;
  } catch {
    return [];
  }
}

function readRawActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  const dir = activeLoopRegistryDir(cwd);
  const entriesByTaskDir = new Map<string, ActiveLoopRegistryEntry>();

  for (const entry of readLegacyActiveLoopRegistryEntries(cwd)) {
    entriesByTaskDir.set(entry.taskDir, entry);
  }

  if (existsSync(dir)) {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (!dirent.isFile() || !dirent.name.endsWith(ACTIVE_LOOP_REGISTRY_FILE_EXTENSION)) continue;
      const entry = readActiveLoopRegistryEntryFile(join(dir, dirent.name));
      if (entry) entriesByTaskDir.set(entry.taskDir, entry);
    }
  }

  return [...entriesByTaskDir.values()].sort((left, right) => left.taskDir.localeCompare(right.taskDir));
}

function readActiveLoopRegistryEntry(cwd: string, taskDir: string): ActiveLoopRegistryEntry | undefined {
  return readRawActiveLoopRegistryEntries(cwd).find((entry) => entry.taskDir === taskDir);
}

export function readActiveLoopRegistry(cwd: string): ActiveLoopRegistryEntry[] {
  return readRawActiveLoopRegistryEntries(cwd);
}

export function listActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  return readRawActiveLoopRegistryEntries(cwd).filter((entry) => ACTIVE_LOOP_ACTIVE_STATUSES.has(entry.status));
}

export function writeActiveLoopRegistryEntry(cwd: string, entry: ActiveLoopRegistryEntry): ActiveLoopRegistryEntry[] {
  ensureActiveLoopRegistryDir(cwd);
  writeFileAtomic(activeLoopRegistryEntryPath(cwd, entry.taskDir), `${JSON.stringify(entry, null, 2)}\n`);
  return readRawActiveLoopRegistryEntries(cwd);
}

export function recordActiveLoopStopRequest(cwd: string, taskDir: string, requestedAt: string): ActiveLoopRegistryEntry | undefined {
  const current = readActiveLoopRegistryEntry(cwd, taskDir);
  if (!current) return undefined;
  const updated: ActiveLoopRegistryEntry = {
    ...current,
    stopRequestedAt: requestedAt,
    updatedAt: requestedAt,
  };
  writeActiveLoopRegistryEntry(cwd, updated);
  return updated;
}

export function recordActiveLoopStopObservation(cwd: string, taskDir: string, observedAt: string): ActiveLoopRegistryEntry | undefined {
  const current = readActiveLoopRegistryEntry(cwd, taskDir);
  if (!current) return undefined;
  const updated: ActiveLoopRegistryEntry = {
    ...current,
    status: "stopped",
    stopObservedAt: observedAt,
    updatedAt: observedAt,
  };
  writeActiveLoopRegistryEntry(cwd, updated);
  return updated;
}
