import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

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

export type CommandOutcomeStatus = "ok" | "blocked" | "timeout" | "error";

export type CommandOutcomeRecord = {
  name: string;
  status: CommandOutcomeStatus;
  acceptance?: boolean;
  blockedPattern?: string;
  durationMs?: number;
  outputPreview?: string;
  outputTruncated?: boolean;
  outputBytes?: number;
};

export type CompletionRecord = {
  promiseSeen: boolean;
  durableProgressObserved: boolean;
  gateChecked: boolean;
  gatePassed: boolean;
  gateBlocked: boolean;
  blockingReasons: string[];
  acceptanceOutcomes?: CommandOutcomeRecord[];
};

export type ShellPolicy =
  | { mode: "blocklist" }
  | { mode: "allowlist"; allow: string[] };

export type Guardrails = {
  blockCommands: string[];
  protectedFiles: string[];
  shellPolicy?: ShellPolicy;
};

export type IterationRecord = {
  iteration: number;
  status: "running" | "complete" | "timeout" | "error" | "cancelled";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  progress: ProgressState;
  changedFiles: string[];
  noProgressStreak: number;
  completionPromiseMatched?: boolean;
  completionGate?: { ready: boolean; reasons: string[] };
  completion?: CompletionRecord;
  commandOutcomes?: CommandOutcomeRecord[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
  loopToken?: string;
  rpcTelemetry?: import("./runner-rpc.ts").RpcTelemetry;
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
  progress: true;
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type DurableProgressMissingEvent = {
  type: "durable.progress.missing";
  timestamp: string;
  iteration: number;
  loopToken: string;
  progress: false;
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type DurableProgressUnknownEvent = {
  type: "durable.progress.unknown";
  timestamp: string;
  iteration: number;
  loopToken: string;
  progress: "unknown";
  changedFiles: string[];
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
};

export type CompletionPromiseSeenEvent = {
  type: "completion_promise_seen";
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
  type: "completion_gate_passed";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: true;
  reasons: string[];
};

export type CompletionGateBlockedEvent = {
  type: "completion_gate_blocked";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: false;
  reasons: string[];
};

export type CompletionAcceptanceCheckedEvent = {
  type: "completion.acceptance.checked";
  timestamp: string;
  iteration: number;
  loopToken: string;
  ready: boolean;
  reasons: string[];
  outcomes: CommandOutcomeRecord[];
};

export type IterationCompletedEvent = {
  type: "iteration.completed";
  timestamp: string;
  iteration: number;
  loopToken: string;
  status: "complete" | "timeout" | "error" | "cancelled";
  progress: ProgressState;
  changedFiles: string[];
  noProgressStreak: number;
  completionPromiseMatched?: boolean;
  completionGate?: { ready: boolean; reasons: string[] };
  completion?: CompletionRecord;
  commandOutcomes?: CommandOutcomeRecord[];
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
  | CompletionAcceptanceCheckedEvent
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
const CANCEL_FLAG_FILE = "cancel.flag";
const ACTIVE_LOOP_REGISTRY_DIR = "active-loops";
const ACTIVE_LOOP_REGISTRY_LEGACY_FILE = "active-loops.json";
const ACTIVE_LOOP_REGISTRY_FILE_EXTENSION = ".json";
const ACTIVE_LOOP_REGISTRY_STALE_AFTER_MS = 30 * 60 * 1000;
const ACTIVE_LOOP_ACTIVE_STATUSES = new Set<RunnerStatus>(["initializing", "running"]);
const STATUS_FILE_MAX_BYTES = 64 * 1024;
const JSONL_ARTIFACT_MAX_BYTES = 1024 * 1024;
const JSONL_ARTIFACT_MAX_RECORDS = 1000;
const ACTIVE_LOOP_REGISTRY_MAX_BYTES = 64 * 1024;
const ACTIVE_LOOP_REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const ACTIVE_LOOP_REGISTRY_LOCK_STALE_AFTER_MS = 30_000;
const ACTIVE_LOOP_REGISTRY_LOCK_RETRY_MS = 5;
const activeLoopRegistryLockWait = new Int32Array(new SharedArrayBuffer(4));

// --- Helper ---

function runnerDir(taskDir: string): string {
  return join(taskDir, RUNNER_DIR_NAME);
}

function transcriptDir(taskDir: string): string {
  return join(runnerDir(taskDir), TRANSCRIPTS_DIR);
}

// --- Public API ---

function assertRegularDirectory(dir: string, label: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe ${label}: ${dir}`);
  }
}

function assertSafeFileForWrite(filePath: string, label: string): void {
  if (!existsSync(filePath)) return;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Unsafe ${label}: ${filePath}`);
  }
}

function tempSiblingPath(filePath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return join(dirname(filePath), `.${basename(filePath)}.${suffix}.tmp`);
}

function writeFileReplacing(filePath: string, contents: string, label: string): void {
  assertSafeFileForWrite(filePath, label);
  const tempPath = tempSiblingPath(filePath);
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, filePath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

function appendFileNoFollow(filePath: string, contents: string, label: string): void {
  assertSafeFileForWrite(filePath, label);
  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Unsafe ${label}: ${filePath}`);
    }
    writeSync(fd, contents, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readRegularFileNoFollowBounded(filePath: string, maxBytes: number): string | undefined {
  if (!existsSync(filePath)) return undefined;
  let fd: number | undefined;
  try {
    const preOpenStat = lstatSync(filePath);
    if (preOpenStat.isSymbolicLink() || !preOpenStat.isFile() || preOpenStat.size > maxBytes) return undefined;
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    const postOpenStat = fstatSync(fd);
    if (!postOpenStat.isFile() || postOpenStat.size > maxBytes) return undefined;
    const bytesToRead = Math.min(postOpenStat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = bytesToRead > 0 ? readSync(fd, buffer, 0, bytesToRead, 0) : 0;
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isSafeExistingRunnerDir(taskDir: string): boolean {
  const dir = runnerDir(taskDir);
  if (!existsSync(dir)) return false;
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseJsonLinesBounded<T>(raw: string | undefined, predicate?: (value: unknown) => value is T): T[] {
  if (raw === undefined) return [];
  const records: T[] = [];
  for (const line of raw.split("\n")) {
    if (records.length >= JSONL_ARTIFACT_MAX_RECORDS) break;
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!predicate || predicate(parsed)) records.push(parsed as T);
    } catch {
      // skip malformed JSONL lines
    }
  }
  return records;
}

export function ensureRunnerDir(taskDir: string): string {
  const dir = runnerDir(taskDir);
  if (existsSync(dir)) {
    assertRegularDirectory(dir, ".ralph-runner directory");
  } else {
    mkdirSync(dir, { recursive: true });
    assertRegularDirectory(dir, ".ralph-runner directory");
  }
  return dir;
}

function ensureTranscriptDir(taskDir: string): string {
  const dir = transcriptDir(taskDir);
  ensureRunnerDir(taskDir);
  if (existsSync(dir)) {
    assertRegularDirectory(dir, "transcripts directory");
  } else {
    mkdirSync(dir, { recursive: true });
    assertRegularDirectory(dir, "transcripts directory");
  }
  return dir;
}

export function writeStatusFile(taskDir: string, status: RunnerStatusFile): void {
  const dir = ensureRunnerDir(taskDir);
  writeFileReplacing(join(dir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`, "status file");
}

export function readStatusFile(taskDir: string): RunnerStatusFile | undefined {
  if (!isSafeExistingRunnerDir(taskDir)) return undefined;
  const filePath = join(runnerDir(taskDir), STATUS_FILE);
  const raw = readRegularFileNoFollowBounded(filePath, STATUS_FILE_MAX_BYTES);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRunnerStatusFile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const RPC_TELEMETRY_STDERR_MAX_CHARS = 4000;

function boundedIterationRecord(record: IterationRecord): IterationRecord {
  const telemetry = record.rpcTelemetry;
  const stderrText = telemetry?.stderrText;
  if (!telemetry || typeof stderrText !== "string" || stderrText.length <= RPC_TELEMETRY_STDERR_MAX_CHARS) return record;
  return {
    ...record,
    rpcTelemetry: {
      ...telemetry,
      stderrText: `${stderrText.slice(0, RPC_TELEMETRY_STDERR_MAX_CHARS)}\n[ralph: rpc stderr truncated in iteration metadata]`,
    },
  };
}

export function appendIterationRecord(taskDir: string, record: IterationRecord): void {
  const dir = ensureRunnerDir(taskDir);
  const filePath = join(dir, ITERATIONS_FILE);
  const line = JSON.stringify(boundedIterationRecord(record)) + "\n";
  appendFileNoFollow(filePath, line, "iteration record file");
}

export function appendRunnerEvent(taskDir: string, event: RunnerEvent): void {
  const dir = ensureRunnerDir(taskDir);
  const filePath = join(dir, EVENTS_FILE);
  appendFileNoFollow(filePath, `${JSON.stringify(event)}\n`, "runner event file");
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

function isRunnerStatusFile(value: unknown): value is RunnerStatusFile {
  if (!isRecord(value)) return false;
  return (
    isString(value.loopToken)
    && value.loopToken.length > 0
    && isString(value.ralphPath)
    && isString(value.taskDir)
    && isString(value.cwd)
    && isRunnerStatus(value.status)
    && Number.isInteger(value.currentIteration)
    && isNumber(value.currentIteration)
    && value.currentIteration >= 0
    && Number.isInteger(value.maxIterations)
    && isNumber(value.maxIterations)
    && value.maxIterations > 0
    && isNumber(value.timeout)
    && value.timeout > 0
    && (value.completionPromise === undefined || isString(value.completionPromise))
    && isString(value.startedAt)
    && (value.completedAt === undefined || isString(value.completedAt))
    && isGuardrails(value.guardrails)
  );
}


function isShellPolicy(value: unknown): value is ShellPolicy {
  if (!isRecord(value) || typeof value.mode !== "string") return false;
  if (value.mode === "allowlist") {
    return Array.isArray(value.allow) && value.allow.length > 0 && value.allow.every((entry) => typeof entry === "string");
  }
  if (value.mode === "blocklist") {
    return value.allow === undefined || (Array.isArray(value.allow) && value.allow.length === 0);
  }
  return false;
}

function isProgressState(value: unknown): value is ProgressState {
  return value === true || value === false || value === "unknown";
}

function isCommandOutcomeRecord(value: unknown): value is CommandOutcomeRecord {
  if (!isRecord(value)) return false;
  return (
    isString(value.name) &&
    (value.status === "ok" || value.status === "blocked" || value.status === "timeout" || value.status === "error") &&
    (value.acceptance === undefined || typeof value.acceptance === "boolean") &&
    (value.blockedPattern === undefined || isString(value.blockedPattern)) &&
    (value.durationMs === undefined || (isNumber(value.durationMs) && value.durationMs >= 0)) &&
    (value.outputPreview === undefined || isString(value.outputPreview)) &&
    (value.outputTruncated === undefined || typeof value.outputTruncated === "boolean") &&
    (value.outputBytes === undefined || (isNumber(value.outputBytes) && value.outputBytes >= 0))
  );
}

function isCommandOutcomeArray(value: unknown): value is CommandOutcomeRecord[] {
  return Array.isArray(value) && value.every(isCommandOutcomeRecord);
}

function isGuardrails(value: unknown): value is Guardrails {
  if (!isRecord(value)) return false;
  return isStringArray(value.blockCommands) && isStringArray(value.protectedFiles) && (value.shellPolicy === undefined || isShellPolicy(value.shellPolicy));
}

function isCompletionRecord(value: unknown): value is CompletionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.promiseSeen === "boolean" &&
    typeof value.durableProgressObserved === "boolean" &&
    typeof value.gateChecked === "boolean" &&
    typeof value.gatePassed === "boolean" &&
    typeof value.gateBlocked === "boolean" &&
    isStringArray(value.blockingReasons) &&
    (value.acceptanceOutcomes === undefined || isCommandOutcomeArray(value.acceptanceOutcomes))
  );
}

function isCompletionGate(value: unknown): value is { ready: boolean; reasons: string[] } {
  if (!isRecord(value)) return false;
  return typeof value.ready === "boolean" && isStringArray(value.reasons);
}

function isIterationCompletedStatus(value: unknown): value is IterationRecord["status"] {
  return value === "complete" || value === "timeout" || value === "error" || value === "cancelled";
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
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.progress === true &&
        isStringArray(value.changedFiles) &&
        (value.snapshotTruncated === undefined || typeof value.snapshotTruncated === "boolean") &&
        (value.snapshotErrorCount === undefined || (isNumber(value.snapshotErrorCount) && Number.isInteger(value.snapshotErrorCount) && value.snapshotErrorCount >= 0))
      );
    case "durable.progress.missing":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.progress === false &&
        isStringArray(value.changedFiles) &&
        (value.snapshotTruncated === undefined || typeof value.snapshotTruncated === "boolean") &&
        (value.snapshotErrorCount === undefined || (isNumber(value.snapshotErrorCount) && Number.isInteger(value.snapshotErrorCount) && value.snapshotErrorCount >= 0))
      );
    case "durable.progress.unknown":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.progress === "unknown" &&
        isStringArray(value.changedFiles) &&
        (value.snapshotTruncated === undefined || typeof value.snapshotTruncated === "boolean") &&
        (value.snapshotErrorCount === undefined || (isNumber(value.snapshotErrorCount) && Number.isInteger(value.snapshotErrorCount) && value.snapshotErrorCount >= 0))
      );
    case "completion_promise_seen":
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
    case "completion_gate_passed":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.ready === true &&
        isStringArray(value.reasons)
      );
    case "completion_gate_blocked":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        value.ready === false &&
        isStringArray(value.reasons)
      );
    case "completion.acceptance.checked":
      return (
        isNumber(value.iteration) &&
        Number.isInteger(value.iteration) &&
        value.iteration > 0 &&
        isString(value.loopToken) &&
        typeof value.ready === "boolean" &&
        isStringArray(value.reasons) &&
        isCommandOutcomeArray(value.outcomes)
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
        (value.commandOutcomes === undefined || isCommandOutcomeArray(value.commandOutcomes)) &&
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
  if (!isSafeExistingRunnerDir(taskDir)) return [];
  const filePath = join(runnerDir(taskDir), EVENTS_FILE);
  const raw = readRegularFileNoFollowBounded(filePath, JSONL_ARTIFACT_MAX_BYTES);
  return parseJsonLinesBounded(raw, isRunnerEvent);
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
    ...(completion.acceptanceOutcomes?.length
      ? [`- Acceptance outcomes: ${completion.acceptanceOutcomes.map((outcome) => `${outcome.name}:${outcome.status}`).join(", ")}`]
      : []),
  ];
}

function rpcTelemetryHeaderLines(record: IterationRecord): string[] {
  const telemetry = record.rpcTelemetry;
  if (!telemetry) return [];
  return [
    `- RPC telemetry:`,
    `  - Spawned: ${telemetry.spawnedAt}`,
    ...(telemetry.promptSentAt ? [`  - Prompt sent: ${telemetry.promptSentAt}`] : []),
    ...(telemetry.firstStdoutEventAt ? [`  - First stdout event: ${telemetry.firstStdoutEventAt}`] : []),
    ...(telemetry.lastEventAt && telemetry.lastEventType ? [`  - Last stdout event: ${telemetry.lastEventType} at ${telemetry.lastEventAt}`] : []),
    ...(telemetry.exitedAt ? [`  - Exited: ${telemetry.exitedAt}`] : []),
    ...(telemetry.timedOutAt ? [`  - Timed out: ${telemetry.timedOutAt}`] : []),
    ...(telemetry.exitCode !== undefined ? [`  - Exit code: ${String(telemetry.exitCode)}`] : []),
    ...(telemetry.exitSignal !== undefined ? [`  - Exit signal: ${String(telemetry.exitSignal)}`] : []),
    ...(telemetry.stderrText ? [`  - Stderr: ${telemetry.stderrText.trimEnd()}${telemetry.stderrTruncated ? ` [truncated, ${telemetry.stderrBytes ?? "unknown"} bytes total]` : ""}`] : []),
    ...(telemetry.error ? [`  - Error: ${telemetry.error}`] : []),
  ];
}

const TRANSCRIPT_ASSISTANT_TEXT_MAX_CODE_UNITS = 12_000;

// Keep each slice within its code-unit budget without splitting a surrogate pair.
function utf16SafePrefix(text: string, maxCodeUnits: number): string {
  const end = Math.min(text.length, maxCodeUnits);
  const splitsPair = (text.codePointAt(end - 1) ?? 0) > 0xffff;
  return text.slice(0, splitsPair ? end - 1 : end);
}

function utf16SafeSuffix(text: string, maxCodeUnits: number): string {
  const start = Math.max(0, text.length - maxCodeUnits);
  const splitsPair = (text.codePointAt(start - 1) ?? 0) > 0xffff;
  return text.slice(splitsPair ? start + 1 : start);
}

function boundedTranscriptAssistantText(text: string): string {
  if (text.length <= TRANSCRIPT_ASSISTANT_TEXT_MAX_CODE_UNITS) return text;
  const originalBytes = Buffer.byteLength(text, "utf8");
  const marker = `\n[ralph: assistant text truncated to ${TRANSCRIPT_ASSISTANT_TEXT_MAX_CODE_UNITS} UTF-16 code units; original ${originalBytes} bytes]\n`;
  const visibleUnits = TRANSCRIPT_ASSISTANT_TEXT_MAX_CODE_UNITS - marker.length;
  const headUnits = Math.floor(visibleUnits * 0.7);
  const tailUnits = visibleUnits - headUnits;
  return `${utf16SafePrefix(text, headUnits)}${marker}${utf16SafeSuffix(text, tailUnits)}`;
}

const TRANSCRIPT_COMMAND_OUTPUT_MAX_CHARS = 12_000;

function boundedTranscriptCommandOutput(output: string): string {
  if (output.length <= TRANSCRIPT_COMMAND_OUTPUT_MAX_CHARS) return output;
  const outputBytes = Buffer.byteLength(output, "utf8");
  const marker = `\n[ralph: command output truncated after ${TRANSCRIPT_COMMAND_OUTPUT_MAX_CHARS} chars; original ${outputBytes} bytes]\n`;
  const visibleChars = Math.max(0, TRANSCRIPT_COMMAND_OUTPUT_MAX_CHARS - marker.length);
  const headChars = Math.floor(visibleChars * 0.7);
  const tailChars = visibleChars - headChars;
  return `${output.slice(0, headChars)}${marker}${output.slice(-tailChars)}`;
}

function transcriptHeaderLines(record: IterationRecord): string[] {
  const lines = [
    `- Status: ${record.status}`,
    `- Started: ${record.startedAt}`,
    `- Progress: ${String(record.progress)}`,
    `- Changed files: ${record.changedFiles.length > 0 ? record.changedFiles.join(", ") : "none"}`,
    `- No-progress streak: ${record.noProgressStreak}`,
    ...(record.commandOutcomes?.length ? [`- Command outcomes: ${record.commandOutcomes.map((outcome) => `${outcome.name}:${outcome.status}`).join(", ")}`] : []),
    ...completionHeaderLines(record),
    ...rpcTelemetryHeaderLines(record),
  ];
  if (record.completedAt) lines.push(`- Completed: ${record.completedAt}`);
  if (typeof record.durationMs === "number") lines.push(`- Duration: ${Math.round(record.durationMs / 1000)}s`);
  if (record.snapshotTruncated !== undefined) lines.push(`- Snapshot truncated: ${record.snapshotTruncated ? "yes" : "no"}`);
  if (record.snapshotErrorCount !== undefined) lines.push(`- Snapshot errors: ${record.snapshotErrorCount}`);
  return lines;
}

export function writeIterationTranscript(taskDir: string, transcript: IterationTranscriptInput): string {
  const dir = ensureTranscriptDir(taskDir);
  const runToken = transcript.record.loopToken ?? "unknown";
  const filePath = join(dir, `iteration-${String(transcript.record.iteration).padStart(3, "0")}-${runToken}.md`);
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe transcript path: ${filePath}`);
    }
  }
  const lines: string[] = [`# Iteration ${transcript.record.iteration}`, "", ...transcriptHeaderLines(transcript.record), "", "## Rendered prompt", "", "```text", normalizeTranscriptText(transcript.prompt), "```", "", "## Command outputs", ""];

  if (transcript.commandOutputs.length === 0) {
    lines.push("None.");
  } else {
    for (const output of transcript.commandOutputs) {
      lines.push(`### ${output.name}`, "", "```text", normalizeTranscriptText(boundedTranscriptCommandOutput(output.output)), "```", "");
    }
    lines.pop();
  }

  if (transcript.assistantText !== undefined) {
    lines.push("", "## Assistant text", "", "```text", normalizeTranscriptText(boundedTranscriptAssistantText(transcript.assistantText)), "```");
  } else if (transcript.note) {
    lines.push("", "## Outcome", "", transcript.note);
  }

  writeFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf8", flag: "wx" });
  return filePath;
}

export function readIterationRecords(taskDir: string): IterationRecord[] {
  if (!isSafeExistingRunnerDir(taskDir)) return [];
  const filePath = join(runnerDir(taskDir), ITERATIONS_FILE);
  const raw = readRegularFileNoFollowBounded(filePath, JSONL_ARTIFACT_MAX_BYTES);
  return parseJsonLinesBounded<IterationRecord>(raw);
}

function writeControlSignal(
  taskDir: string,
  fileName: string,
  label: string,
  loopToken?: string,
): boolean {
  const dir = ensureRunnerDir(taskDir);
  if (!loopToken) {
    writeFileReplacing(join(dir, fileName), "", label);
    return true;
  }
  return withActiveLoopRegistryEntryLock(taskDir, taskDir, (entryPath) => {
    const claim = readActiveLoopRegistryEntryFile(entryPath);
    if (claim && (claim.loopToken !== loopToken || !ACTIVE_LOOP_ACTIVE_STATUSES.has(claim.status))) return false;
    if (claim && fileName === STOP_FLAG_FILE) {
      const requestedAt = new Date().toISOString();
      writeFileAtomic(entryPath, `${JSON.stringify({
        ...claim,
        stopRequestedAt: requestedAt,
        updatedAt: requestedAt,
      }, null, 2)}\n`);
    }
    writeFileReplacing(join(dir, fileName), `${loopToken}\n`, label);
    return true;
  });
}

function checkControlSignal(taskDir: string, fileName: string, loopToken?: string): boolean {
  if (!isSafeExistingRunnerDir(taskDir)) return false;
  const filePath = join(runnerDir(taskDir), fileName);
  if (!loopToken) return readRegularFileNoFollowBounded(filePath, 256) !== undefined;
  return withActiveLoopRegistryEntryLock(taskDir, taskDir, (entryPath) => {
    const claim = readActiveLoopRegistryEntryFile(entryPath);
    if (!claim || claim.loopToken !== loopToken || !ACTIVE_LOOP_ACTIVE_STATUSES.has(claim.status)) return false;
    const signalToken = readRegularFileNoFollowBounded(filePath, 256)?.trim();
    if (signalToken === undefined) return false;
    if (signalToken === loopToken) return true;
    rmSync(filePath, { force: true });
    return false;
  });
}

export function createStopSignal(taskDir: string, loopToken?: string): boolean {
  return writeControlSignal(taskDir, STOP_FLAG_FILE, "stop flag", loopToken);
}

export function checkStopSignal(taskDir: string, loopToken?: string): boolean {
  return checkControlSignal(taskDir, STOP_FLAG_FILE, loopToken);
}

export function clearStopSignal(taskDir: string): void {
  const filePath = join(runnerDir(taskDir), STOP_FLAG_FILE);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

export function createCancelSignal(taskDir: string, loopToken?: string): boolean {
  return writeControlSignal(taskDir, CANCEL_FLAG_FILE, "cancel flag", loopToken);
}

export function checkCancelSignal(taskDir: string, loopToken?: string): boolean {
  return checkControlSignal(taskDir, CANCEL_FLAG_FILE, loopToken);
}

export function clearCancelSignal(taskDir: string): void {
  const filePath = join(runnerDir(taskDir), CANCEL_FLAG_FILE);
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

function activeLoopRegistryTaskIdentity(taskDir: string): string {
  try {
    return realpathSync.native(taskDir);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return resolve(taskDir);
    throw error;
  }
}

function activeLoopRegistryEntryPath(cwd: string, taskDir: string): string {
  const taskIdentity = activeLoopRegistryTaskIdentity(taskDir);
  return join(activeLoopRegistryDir(cwd), `${createHash("sha256").update(taskIdentity).digest("hex")}${ACTIVE_LOOP_REGISTRY_FILE_EXTENSION}`);
}

function ensureActiveLoopRegistryDir(cwd: string): string {
  const runner = ensureRunnerDir(cwd);
  const dir = join(runner, ACTIVE_LOOP_REGISTRY_DIR);
  if (existsSync(dir)) {
    assertRegularDirectory(dir, "active loop registry directory");
  } else {
    mkdirSync(dir, { recursive: true });
    assertRegularDirectory(dir, "active loop registry directory");
  }
  return dir;
}

function writeFileAtomic(filePath: string, contents: string): void {
  writeFileReplacing(filePath, contents, "active loop registry file");
}

type ActiveLoopRegistryLockIdentity = {
  dev: number;
  ino: number;
};

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
}
function removeActiveLoopRegistryLockIfOwned(
  lockPath: string,
  identity: ActiveLoopRegistryLockIdentity,
  expectedKind: "file" | "symlink" = "file",
): void {
  try {
    const current = lstatSync(lockPath);
    const expectedType = expectedKind === "file" ? current.isFile() : current.isSymbolicLink();
    if (expectedType && current.dev === identity.dev && current.ino === identity.ino) {
      rmSync(lockPath, { force: true });
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

function withActiveLoopRegistryEntryLock<T>(cwd: string, taskDir: string, operation: (filePath: string) => T): T {
  ensureActiveLoopRegistryDir(cwd);
  const filePath = activeLoopRegistryEntryPath(cwd, taskDir);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + ACTIVE_LOOP_REGISTRY_LOCK_TIMEOUT_MS;
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let lockFd: number | undefined;
  let lockIdentity: ActiveLoopRegistryLockIdentity | undefined;

  while (lockFd === undefined) {
    try {
      const acquiredFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
      try {
        writeSync(acquiredFd, `${process.pid}\n`);
        const stat = fstatSync(acquiredFd);
        lockIdentity = { dev: stat.dev, ino: stat.ino };
        lockFd = acquiredFd;
      } catch (error) {
        const stat = fstatSync(acquiredFd);
        closeSync(acquiredFd);
        removeActiveLoopRegistryLockIfOwned(lockPath, { dev: stat.dev, ino: stat.ino });
        throw error;
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const stat = lstatSync(lockPath);
        if (stat.isSymbolicLink()) {
          removeActiveLoopRegistryLockIfOwned(lockPath, { dev: stat.dev, ino: stat.ino }, "symlink");
          continue;
        }
        if (!stat.isFile()) throw new Error(`Unsafe active loop registry lock: ${lockPath}`);
        const ownerPid = Number.parseInt(readRegularFileNoFollowBounded(lockPath, 128)?.trim() ?? "", 10);
        const stale = Date.now() - stat.mtimeMs > ACTIVE_LOOP_REGISTRY_LOCK_STALE_AFTER_MS;
        if (stale && !isProcessAlive(ownerPid)) {
          removeActiveLoopRegistryLockIfOwned(lockPath, { dev: stat.dev, ino: stat.ino });
          continue;
        }
      } catch (statError) {
        if (isRecord(statError) && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring active loop registry lock: ${lockPath}`);
      // Synchronous waiting is bounded and isolated to one task registry entry.
      Atomics.wait(activeLoopRegistryLockWait, 0, 0, ACTIVE_LOOP_REGISTRY_LOCK_RETRY_MS);
    }
  }

  try {
    return operation(filePath);
  } finally {
    const identity = lockIdentity;
    closeSync(lockFd);
    if (!identity) throw new Error(`Active loop registry lock identity missing: ${lockPath}`);
    removeActiveLoopRegistryLockIfOwned(lockPath, identity);
  }
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
    const raw = readRegularFileNoFollowBounded(filePath, ACTIVE_LOOP_REGISTRY_MAX_BYTES);
    if (raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(raw);
    const entry = normalizeActiveLoopRegistryEntry(parsed);
    if (!entry || isActiveLoopRegistryEntryStale(entry)) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

function readLegacyActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  const baseDir = runnerDir(cwd);
  if (existsSync(baseDir)) {
    try {
      assertRegularDirectory(baseDir, ".ralph-runner directory");
    } catch {
      return [];
    }
  }
  const filePath = join(baseDir, ACTIVE_LOOP_REGISTRY_LEGACY_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readRegularFileNoFollowBounded(filePath, ACTIVE_LOOP_REGISTRY_MAX_BYTES);
    if (raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const normalizedEntries = parsed.map(normalizeActiveLoopRegistryEntry).filter((entry): entry is ActiveLoopRegistryEntry => entry !== undefined);
    const freshEntries = normalizedEntries.filter((entry) => !isActiveLoopRegistryEntryStale(entry));

    if (freshEntries.length !== normalizedEntries.length) {
      if (freshEntries.length > 0) {
        writeFileReplacing(filePath, `${JSON.stringify(freshEntries, null, 2)}\n`, "legacy active loop registry file");
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
  if (!isSafeExistingRunnerDir(cwd)) return [];
  const dir = activeLoopRegistryDir(cwd);
  const entriesByTaskDir = new Map<string, ActiveLoopRegistryEntry>();

  for (const entry of readLegacyActiveLoopRegistryEntries(cwd)) {
    entriesByTaskDir.set(entry.taskDir, entry);
  }

  if (existsSync(dir)) {
    try {
      assertRegularDirectory(dir, "active loop registry directory");
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (!dirent.isFile() || !dirent.name.endsWith(ACTIVE_LOOP_REGISTRY_FILE_EXTENSION)) continue;
        const entry = readActiveLoopRegistryEntryFile(join(dir, dirent.name));
        if (entry) entriesByTaskDir.set(entry.taskDir, entry);
      }
    } catch {
      // Ignore unsafe or concurrently removed registry directories.
    }
  }

  return [...entriesByTaskDir.values()].sort((left, right) => left.taskDir.localeCompare(right.taskDir));
}

function readActiveLoopRegistryEntry(cwd: string, taskDir: string): ActiveLoopRegistryEntry | undefined {
  const taskIdentity = activeLoopRegistryTaskIdentity(taskDir);
  return readRawActiveLoopRegistryEntries(cwd).find((entry) => {
    if (entry.taskDir === taskDir) return true;
    try {
      return activeLoopRegistryTaskIdentity(entry.taskDir) === taskIdentity;
    } catch {
      return false;
    }
  });
}

export function readActiveLoopRegistry(cwd: string): ActiveLoopRegistryEntry[] {
  return readRawActiveLoopRegistryEntries(cwd);
}

export function listActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  return readRawActiveLoopRegistryEntries(cwd).filter((entry) => ACTIVE_LOOP_ACTIVE_STATUSES.has(entry.status));
}

export function updateActiveLoopRegistryEntry(
  cwd: string,
  taskDir: string,
  loopToken: string,
  update: (entry: ActiveLoopRegistryEntry) => ActiveLoopRegistryEntry,
): ActiveLoopRegistryEntry | undefined {
  return withActiveLoopRegistryEntryLock(cwd, taskDir, (filePath) => {
    const current = readActiveLoopRegistryEntryFile(filePath);
    if (!current || current.loopToken !== loopToken) return undefined;
    const updated = update({ ...current });
    const next: ActiveLoopRegistryEntry = {
      ...updated,
      taskDir: current.taskDir,
      ralphPath: current.ralphPath,
      cwd: current.cwd,
      loopToken: current.loopToken,
    };
    writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function writeActiveLoopRegistryEntry(cwd: string, entry: ActiveLoopRegistryEntry): boolean {
  return withActiveLoopRegistryEntryLock(cwd, entry.taskDir, (filePath) => {
    const current = readActiveLoopRegistryEntryFile(filePath);
    if (current && current.loopToken !== entry.loopToken && ACTIVE_LOOP_ACTIVE_STATUSES.has(current.status)) {
      return false;
    }

    const sameRun = current?.loopToken === entry.loopToken;
    const preserveTerminal = sameRun && !ACTIVE_LOOP_ACTIVE_STATUSES.has(current.status) && ACTIVE_LOOP_ACTIVE_STATUSES.has(entry.status);
    const next = preserveTerminal
      ? current
      : sameRun
        ? {
            ...entry,
            stopRequestedAt: entry.stopRequestedAt ?? current.stopRequestedAt,
            stopObservedAt: entry.stopObservedAt ?? current.stopObservedAt,
          }
        : entry;
    writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}

export function recordActiveLoopStopRequest(
  cwd: string,
  taskDir: string,
  requestedAt: string,
  loopToken = readActiveLoopRegistryEntry(cwd, taskDir)?.loopToken,
): ActiveLoopRegistryEntry | undefined {
  if (!loopToken) return undefined;
  return updateActiveLoopRegistryEntry(cwd, taskDir, loopToken, (current) => ({
    ...current,
    stopRequestedAt: requestedAt,
    updatedAt: requestedAt,
  }));
}

export function recordActiveLoopStopObservation(
  cwd: string,
  taskDir: string,
  observedAt: string,
  loopToken = readActiveLoopRegistryEntry(cwd, taskDir)?.loopToken,
  status: "stopped" | "cancelled" = "stopped",
): ActiveLoopRegistryEntry | undefined {
  if (!loopToken) return undefined;
  return updateActiveLoopRegistryEntry(cwd, taskDir, loopToken, (current) => ({
    ...current,
    status,
    stopObservedAt: observedAt,
    updatedAt: observedAt,
  }));
}
