import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  type IterationRecord,
  type RunnerStatusFile,
  appendIterationRecord,
  checkStopSignal,
  clearRunnerDir,
  clearStopSignal,
  createStopSignal,
  ensureRunnerDir,
  readIterationRecords,
  readStatusFile,
  writeStatusFile,
} from "../src/runner-state.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-runner-state-"));
}

function makeStatusFile(overrides: Partial<RunnerStatusFile> = {}): RunnerStatusFile {
  return {
    loopToken: "test-token",
    ralphPath: "/test/RALPH.md",
    taskDir: "/test",
    cwd: "/test",
    status: "running",
    currentIteration: 1,
    maxIterations: 10,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: ["git\\s+push"], protectedFiles: [] },
    ...overrides,
  };
}

function makeIterationRecord(overrides: Partial<IterationRecord> = {}): IterationRecord {
  return {
    iteration: 1,
    status: "complete",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 5000,
    progress: true,
    changedFiles: ["notes.md"],
    noProgressStreak: 0,
    ...overrides,
  };
}

// --- ensureRunnerDir ---

test("ensureRunnerDir creates .ralph-runner directory", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir = ensureRunnerDir(taskDir);
    assert.ok(existsSync(runnerDir));
    assert.ok(runnerDir.endsWith(".ralph-runner"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("ensureRunnerDir is idempotent", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir1 = ensureRunnerDir(taskDir);
    const runnerDir2 = ensureRunnerDir(taskDir);
    assert.equal(runnerDir1, runnerDir2);
    assert.ok(existsSync(runnerDir1));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- writeStatusFile / readStatusFile ---

test("writeStatusFile and readStatusFile round-trip", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const status: RunnerStatusFile = makeStatusFile({ taskDir });
    writeStatusFile(taskDir, status);
    const read = readStatusFile(taskDir);
    assert.deepEqual(read, status);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readStatusFile returns undefined when no status file exists", () => {
  const taskDir = createTempDir();
  try {
    const result = readStatusFile(taskDir);
    assert.equal(result, undefined);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("writeStatusFile overwrites previous status", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const status1 = makeStatusFile({ taskDir, status: "running", currentIteration: 1 });
    writeStatusFile(taskDir, status1);
    const status2 = makeStatusFile({ taskDir, status: "complete", currentIteration: 3 });
    writeStatusFile(taskDir, status2);
    const read = readStatusFile(taskDir);
    assert.equal(read?.status, "complete");
    assert.equal(read?.currentIteration, 3);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("writeStatusFile preserves completionPromise and guardrails", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const status: RunnerStatusFile = makeStatusFile({
      taskDir,
      completionPromise: "DONE",
      guardrails: { blockCommands: ["git\\s+push", "rm\\s+-rf"], protectedFiles: ["secret.pem"] },
    });
    writeStatusFile(taskDir, status);
    const read = readStatusFile(taskDir);
    assert.equal(read?.completionPromise, "DONE");
    assert.deepEqual(read?.guardrails.blockCommands, ["git\\s+push", "rm\\s+-rf"]);
    assert.deepEqual(read?.guardrails.protectedFiles, ["secret.pem"]);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- appendIterationRecord / readIterationRecords ---

test("appendIterationRecord and readIterationRecords round-trip", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const record1 = makeIterationRecord({ iteration: 1, progress: true, changedFiles: ["a.md"] });
    const record2 = makeIterationRecord({ iteration: 2, progress: false, changedFiles: [], noProgressStreak: 1 });
    appendIterationRecord(taskDir, record1);
    appendIterationRecord(taskDir, record2);
    const records = readIterationRecords(taskDir);
    assert.equal(records.length, 2);
    assert.equal(records[0].iteration, 1);
    assert.equal(records[0].progress, true);
    assert.deepEqual(records[0].changedFiles, ["a.md"]);
    assert.equal(records[1].iteration, 2);
    assert.equal(records[1].progress, false);
    assert.equal(records[1].noProgressStreak, 1);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readIterationRecords returns empty array when no file exists", () => {
  const taskDir = createTempDir();
  try {
    const records = readIterationRecords(taskDir);
    assert.deepEqual(records, []);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("appendIterationRecord creates iterations.jsonl if missing", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const record = makeIterationRecord({ iteration: 1 });
    appendIterationRecord(taskDir, record);
    const records = readIterationRecords(taskDir);
    assert.equal(records.length, 1);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- Stop signal ---

test("createStopSignal and checkStopSignal", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    assert.equal(checkStopSignal(taskDir), false);
    createStopSignal(taskDir);
    assert.equal(checkStopSignal(taskDir), true);
    clearStopSignal(taskDir);
    assert.equal(checkStopSignal(taskDir), false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("checkStopSignal returns false without runner dir", () => {
  const taskDir = createTempDir();
  try {
    assert.equal(checkStopSignal(taskDir), false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("clearStopSignal is idempotent when no signal exists", () => {
  const taskDir = createTempDir();
  try {
    clearStopSignal(taskDir);
    clearStopSignal(taskDir);
    assert.equal(checkStopSignal(taskDir), false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- clearRunnerDir ---

test("clearRunnerDir removes .ralph-runner directory", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir = ensureRunnerDir(taskDir);
    writeFileSync(join(runnerDir, "status.json"), "{}", "utf8");
    assert.ok(existsSync(runnerDir));
    clearRunnerDir(taskDir);
    assert.ok(!existsSync(runnerDir));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("clearRunnerDir is safe when no runner dir exists", () => {
  const taskDir = createTempDir();
  try {
    clearRunnerDir(taskDir);
    assert.ok(!existsSync(join(taskDir, ".ralph-runner")));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- Iteration record with all fields ---

test("iteration record captures all status fields", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const record: IterationRecord = {
      iteration: 3,
      status: "complete",
      startedAt: "2026-04-13T10:00:00.000Z",
      completedAt: "2026-04-13T10:05:00.000Z",
      durationMs: 300000,
      progress: true,
      changedFiles: ["notes/findings.md", "src/index.ts"],
      noProgressStreak: 0,
      completionPromiseMatched: true,
      snapshotTruncated: false,
      snapshotErrorCount: 0,
    };
    appendIterationRecord(taskDir, record);
    const records = readIterationRecords(taskDir);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], record);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// --- Runner status progression ---

test("runner status follows expected lifecycle", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const token = "lifecycle-test";

    // initializing
    writeStatusFile(taskDir, makeStatusFile({ taskDir, status: "initializing", loopToken: token, currentIteration: 0 }));
    assert.equal(readStatusFile(taskDir)?.status, "initializing");

    // running iteration 1
    writeStatusFile(taskDir, makeStatusFile({ taskDir, status: "running", loopToken: token, currentIteration: 1 }));
    assert.equal(readStatusFile(taskDir)?.status, "running");

    // complete
    writeStatusFile(taskDir, makeStatusFile({ taskDir, status: "complete", loopToken: token, currentIteration: 3 }));
    assert.equal(readStatusFile(taskDir)?.status, "complete");
    assert.equal(readStatusFile(taskDir)?.currentIteration, 3);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});