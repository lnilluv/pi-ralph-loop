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
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
  loopToken?: string;
};

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
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
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
const STOP_FLAG_FILE = "stop.flag";
const ACTIVE_LOOP_REGISTRY_DIR = "active-loops";
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

function normalizeTranscriptText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function transcriptHeaderLines(record: IterationRecord): string[] {
  const lines = [
    `- Status: ${record.status}`,
    `- Started: ${record.startedAt}`,
    `- Progress: ${String(record.progress)}`,
    `- Changed files: ${record.changedFiles.length > 0 ? record.changedFiles.join(", ") : "none"}`,
    `- No-progress streak: ${record.noProgressStreak}`,
  ];
  if (record.completedAt) lines.push(`- Completed: ${record.completedAt}`);
  if (typeof record.durationMs === "number") lines.push(`- Duration: ${Math.round(record.durationMs / 1000)}s`);
  if (record.completionPromiseMatched !== undefined) {
    lines.push(`- Completion promise matched: ${record.completionPromiseMatched ? "yes" : "no"}`);
  }
  if (record.completionGate) {
    const gateState = record.completionGate.ready ? "ready" : "blocked";
    const gateReasons = record.completionGate.reasons.length > 0 ? ` (${record.completionGate.reasons.join("; ")})` : "";
    lines.push(`- Completion gate: ${gateState}${gateReasons}`);
  }
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

  return {
    taskDir: candidate.taskDir,
    ralphPath: candidate.ralphPath,
    cwd: candidate.cwd,
    loopToken: candidate.loopToken,
    status: candidate.status,
    currentIteration: candidate.currentIteration,
    maxIterations: candidate.maxIterations,
    startedAt: candidate.startedAt,
    updatedAt: candidate.updatedAt,
    stopRequestedAt: typeof stopRequestedAt === "string" ? stopRequestedAt : undefined,
    stopObservedAt: typeof stopObservedAt === "string" ? stopObservedAt : undefined,
  };
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
    const updatedAtMs = parseIsoTimestamp(entry.updatedAt);
    if (updatedAtMs === undefined || Date.now() - updatedAtMs > ACTIVE_LOOP_REGISTRY_STALE_AFTER_MS) {
      rmSync(filePath, { force: true });
      return undefined;
    }
    return entry;
  } catch {
    rmSync(filePath, { force: true });
    return undefined;
  }
}

function readRawActiveLoopRegistryEntries(cwd: string): ActiveLoopRegistryEntry[] {
  const dir = activeLoopRegistryDir(cwd);
  if (!existsSync(dir)) return [];

  const entries: ActiveLoopRegistryEntry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(ACTIVE_LOOP_REGISTRY_FILE_EXTENSION)) continue;
    const entry = readActiveLoopRegistryEntryFile(join(dir, dirent.name));
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) => left.taskDir.localeCompare(right.taskDir));
  return entries;
}

function readActiveLoopRegistryEntry(cwd: string, taskDir: string): ActiveLoopRegistryEntry | undefined {
  return readActiveLoopRegistryEntryFile(activeLoopRegistryEntryPath(cwd, taskDir));
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
