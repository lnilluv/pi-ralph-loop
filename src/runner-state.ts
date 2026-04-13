import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  snapshotTruncated?: boolean;
  snapshotErrorCount?: number;
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

// --- Constants ---

const RUNNER_DIR_NAME = ".ralph-runner";
const STATUS_FILE = "status.json";
const ITERATIONS_FILE = "iterations.jsonl";
const STOP_FLAG_FILE = "stop.flag";

// --- Helper ---

function runnerDir(taskDir: string): string {
  return join(taskDir, RUNNER_DIR_NAME);
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