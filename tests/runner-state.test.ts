import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  type ActiveLoopRegistryEntry,
  type IterationRecord,
  type RunnerEvent,
  type RunnerStatusFile,
  appendIterationRecord,
  appendRunnerEvent,
  checkCancelSignal,
  checkStopSignal,
  clearCancelSignal,
  clearRunnerDir,
  clearStopSignal,
  createCancelSignal,
  createStopSignal,
  ensureRunnerDir,
  listActiveLoopRegistryEntries,
  readActiveLoopRegistry,
  readIterationRecords,
  readRunnerEvents,
  readStatusFile,
  recordActiveLoopStopObservation,
  recordActiveLoopStopRequest,
  writeActiveLoopRegistryEntry,
  writeIterationTranscript,
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

function makeCompletionRecord(overrides: Record<string, unknown> = {}) {
  return {
    promiseSeen: true,
    durableProgressObserved: true,
    gateChecked: true,
    gatePassed: true,
    gateBlocked: false,
    blockingReasons: [],
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

test("readIterationRecords skips corrupted JSONL lines without discarding valid entries", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    writeFileSync(
      join(taskDir, ".ralph-runner", "iterations.jsonl"),
      [
        JSON.stringify(makeIterationRecord({ iteration: 1, changedFiles: ["one.md"] })),
        "{not json",
        JSON.stringify(makeIterationRecord({ iteration: 2, progress: false, changedFiles: [], noProgressStreak: 1 })),
      ].join("\n") + "\n",
      "utf8",
    );

    const records = readIterationRecords(taskDir);
    assert.equal(records.length, 2);
    assert.equal(records[0].iteration, 1);
    assert.equal(records[1].iteration, 2);
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

test("appendRunnerEvent and readRunnerEvents round-trip", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const event = {
      type: "completion_gate_blocked",
      timestamp: new Date().toISOString(),
      iteration: 2,
      loopToken: "test-loop-token",
      ready: false,
      reasons: ["Missing required output: ARCHITECTURE.md"],
    } satisfies Extract<RunnerEvent, { type: "completion_gate_blocked" }>;

    appendRunnerEvent(taskDir, event);

    const events = readRunnerEvents(taskDir);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], event);
    assert.ok(existsSync(join(taskDir, ".ralph-runner", "events.jsonl")));
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

test("createCancelSignal writes cancel.flag and checkCancelSignal detects it", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    assert.equal(checkCancelSignal(taskDir), false);
    createCancelSignal(taskDir);
    assert.equal(checkCancelSignal(taskDir), true);
    clearCancelSignal(taskDir);
    assert.equal(checkCancelSignal(taskDir), false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("clearCancelSignal is safe when cancel.flag does not exist", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    clearCancelSignal(taskDir); // should not throw
    assert.equal(checkCancelSignal(taskDir), false);
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
      completionGate: { ready: false, reasons: ["Missing required output: ARCHITECTURE.md"] },
      completion: makeCompletionRecord({
        promiseSeen: true,
        durableProgressObserved: true,
        gateChecked: true,
        gatePassed: false,
        gateBlocked: true,
        blockingReasons: ["Missing required output: ARCHITECTURE.md"],
      }),
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

test("writeIterationTranscript writes a human-reviewable markdown transcript", () => {
  const taskDir = createTempDir();
  try {
    const transcriptPath = writeIterationTranscript(taskDir, {
      record: makeIterationRecord({
        iteration: 2,
        status: "complete",
        progress: true,
        changedFiles: ["notes/findings.md", "src/index.ts"],
        noProgressStreak: 0,
        completionPromiseMatched: true,
        completionGate: { ready: false, reasons: ["Missing required output: ARCHITECTURE.md"] },
        completion: makeCompletionRecord({
          promiseSeen: true,
          durableProgressObserved: true,
          gateChecked: true,
          gatePassed: false,
          gateBlocked: true,
          blockingReasons: ["Missing required output: ARCHITECTURE.md"],
        }),
      }),
      prompt: "Rendered prompt for iteration 2",
      commandOutputs: [{ name: "tests", output: "all green" }],
      assistantText: "Finished the task.",
    });

    assert.ok(transcriptPath.includes(".ralph-runner/transcripts"));
    const raw = readFileSync(transcriptPath, "utf8");
    assert.ok(raw.includes("Iteration 2"));
    assert.ok(raw.includes("Status: complete"));
    assert.ok(raw.includes("Rendered prompt for iteration 2"));
    assert.ok(raw.includes("tests"));
    assert.ok(raw.includes("all green"));
    assert.ok(raw.includes("Finished the task."));
    assert.ok(raw.includes("Completion promise seen: yes"));
    assert.ok(raw.includes("Durable progress observed: yes"));
    assert.ok(raw.includes("Completion gate checked: yes"));
    assert.ok(raw.includes("Completion gate: blocked"));
    assert.ok(raw.includes("Missing required output: ARCHITECTURE.md"));
    assert.ok(raw.includes("notes/findings.md"));
    assert.ok(raw.includes("src/index.ts"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("active loop registry prunes stale entries and preserves fresh ones", () => {
  const cwd = createTempDir();
  try {
    const taskDir = join(cwd, "fresh-task");
    const staleTaskDir = join(cwd, "stale-task");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(staleTaskDir, { recursive: true });

    const freshEntry: ActiveLoopRegistryEntry = {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "fresh-loop-token",
      status: "running",
      currentIteration: 3,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const staleEntry: ActiveLoopRegistryEntry = {
      taskDir: staleTaskDir,
      ralphPath: join(staleTaskDir, "RALPH.md"),
      cwd,
      loopToken: "stale-loop-token",
      status: "running",
      currentIteration: 1,
      maxIterations: 5,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };

    writeActiveLoopRegistryEntry(cwd, freshEntry);
    writeActiveLoopRegistryEntry(cwd, staleEntry);

    const activeEntries = listActiveLoopRegistryEntries(cwd);
    assert.deepEqual(activeEntries.map((entry) => entry.taskDir), [taskDir]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active loop registry reads legacy active-loops.json files", () => {
  const cwd = createTempDir();
  try {
    const taskDir = join(cwd, "legacy-task");
    mkdirSync(taskDir, { recursive: true });
    ensureRunnerDir(cwd);

    const entry: ActiveLoopRegistryEntry = {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "legacy-loop-token",
      status: "running",
      currentIteration: 2,
      maxIterations: 4,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(join(cwd, ".ralph-runner", "active-loops.json"), JSON.stringify([entry], null, 2), "utf8");

    assert.deepEqual(readActiveLoopRegistry(cwd), [entry]);
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), [entry]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active loop registry prunes stale legacy active-loops.json entries", () => {
  const cwd = createTempDir();
  try {
    const taskDir = join(cwd, "legacy-stale-task");
    mkdirSync(taskDir, { recursive: true });
    ensureRunnerDir(cwd);

    const staleEntry: ActiveLoopRegistryEntry = {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "legacy-stale-loop-token",
      status: "running",
      currentIteration: 2,
      maxIterations: 4,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };

    writeFileSync(join(cwd, ".ralph-runner", "active-loops.json"), JSON.stringify([staleEntry], null, 2), "utf8");

    assert.deepEqual(readActiveLoopRegistry(cwd), []);
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active loop registry records stop request and observation timestamps", () => {
  const cwd = createTempDir();
  try {
    const taskDir = join(cwd, "registry-task");
    mkdirSync(taskDir, { recursive: true });
    const entry: ActiveLoopRegistryEntry = {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "registry-loop-token",
      status: "running",
      currentIteration: 4,
      maxIterations: 7,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    writeActiveLoopRegistryEntry(cwd, entry);

    const requestedAt = new Date().toISOString();
    const requested = recordActiveLoopStopRequest(cwd, taskDir, requestedAt);
    assert.equal(requested?.stopRequestedAt, requestedAt);
    assert.equal(listActiveLoopRegistryEntries(cwd).length, 1);

    const observedAt = new Date(Date.now() + 1000).toISOString();
    const observed = recordActiveLoopStopObservation(cwd, taskDir, observedAt);
    assert.equal(observed?.stopObservedAt, observedAt);
    assert.equal(observed?.status, "stopped");
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
