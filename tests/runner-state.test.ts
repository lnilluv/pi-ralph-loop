import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
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
  updateActiveLoopRegistryEntry,
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

test("runner readers ignore a symlinked .ralph-runner root", () => {
  const root = createTempDir();
  try {
    const taskDir = join(root, "task");
    const outsideDir = join(root, "outside");
    mkdirSync(taskDir);
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "status.json"), `${JSON.stringify(makeStatusFile({ taskDir }))}\n`, "utf8");
    writeFileSync(join(outsideDir, "iterations.jsonl"), `${JSON.stringify(makeIterationRecord({ loopToken: "outside" }))}\n`, "utf8");
    writeFileSync(join(outsideDir, "events.jsonl"), `${JSON.stringify({ type: "runner.finished", timestamp: new Date().toISOString(), loopToken: "outside", status: "complete", iterations: 1, totalDurationMs: 1 } satisfies RunnerEvent)}\n`, "utf8");
    writeFileSync(join(outsideDir, "stop.flag"), "", "utf8");
    writeFileSync(join(outsideDir, "cancel.flag"), "", "utf8");
    symlinkSync(outsideDir, join(taskDir, ".ralph-runner"), "dir");

    assert.equal(readStatusFile(taskDir), undefined);
    assert.deepEqual(readIterationRecords(taskDir), []);
    assert.deepEqual(readRunnerEvents(taskDir), []);
    assert.equal(checkStopSignal(taskDir), false);
    assert.equal(checkCancelSignal(taskDir), false);
    assert.deepEqual(listActiveLoopRegistryEntries(taskDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner writers reject a symlinked .ralph-runner root", () => {
  const root = createTempDir();
  try {
    const taskDir = join(root, "task");
    const outsideDir = join(root, "outside");
    mkdirSync(taskDir);
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(taskDir, ".ralph-runner"), "dir");

    assert.throws(() => writeStatusFile(taskDir, makeStatusFile({ taskDir })), /Unsafe \.ralph-runner directory/);
    assert.throws(() => appendIterationRecord(taskDir, makeIterationRecord({ loopToken: "token-a" })), /Unsafe \.ralph-runner directory/);
    assert.throws(() => appendRunnerEvent(taskDir, { type: "runner.started", timestamp: new Date().toISOString(), loopToken: "token-a", cwd: root, taskDir, status: "initializing", maxIterations: 1, timeout: 300, guardrails: { blockCommands: [], protectedFiles: [] } }), /Unsafe \.ralph-runner directory/);
    assert.throws(() => createStopSignal(taskDir), /Unsafe \.ralph-runner directory/);
    assert.throws(() => createCancelSignal(taskDir), /Unsafe \.ralph-runner directory/);
    assert.throws(
      () =>
        writeIterationTranscript(taskDir, {
          record: makeIterationRecord({ loopToken: "token-a" }),
          prompt: "prompt",
          commandOutputs: [],
        }),
      /Unsafe \.ralph-runner directory/,
    );

    assert.equal(existsSync(join(outsideDir, "status.json")), false);
    assert.equal(existsSync(join(outsideDir, "iterations.jsonl")), false);
    assert.equal(existsSync(join(outsideDir, "events.jsonl")), false);
    assert.equal(existsSync(join(outsideDir, "stop.flag")), false);
    assert.equal(existsSync(join(outsideDir, "cancel.flag")), false);
    assert.equal(existsSync(join(outsideDir, "transcripts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("readStatusFile rejects invalid JSON and incomplete status shapes", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir = ensureRunnerDir(taskDir);
    for (const raw of ["{", JSON.stringify({ status: "running" })]) {
      writeFileSync(join(runnerDir, "status.json"), raw, "utf8");
      assert.equal(readStatusFile(taskDir), undefined);
    }
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readStatusFile rejects oversized status.json", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir = ensureRunnerDir(taskDir);
    writeFileSync(join(runnerDir, "status.json"), JSON.stringify({ status: "running", padding: "x".repeat(80_000) }), "utf8");
    assert.equal(readStatusFile(taskDir), undefined);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readIterationRecords and readRunnerEvents reject oversized JSONL artifacts", () => {
  const taskDir = createTempDir();
  try {
    const runnerDir = ensureRunnerDir(taskDir);
    writeFileSync(join(runnerDir, "iterations.jsonl"), `${JSON.stringify(makeIterationRecord())}\n${"x".repeat(1_100_000)}`, "utf8");
    writeFileSync(join(runnerDir, "events.jsonl"), `${JSON.stringify({ type: "runner.finished", timestamp: new Date().toISOString(), loopToken: "token-a", status: "complete", iterations: 1, totalDurationMs: 1 })}\n${"x".repeat(1_100_000)}`, "utf8");

    assert.deepEqual(readIterationRecords(taskDir), []);
    assert.deepEqual(readRunnerEvents(taskDir), []);
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
      guardrails: {
        blockCommands: ["git\\s+push", "rm\\s+-rf"],
        protectedFiles: ["secret.pem"],
        shellPolicy: { mode: "allowlist", allow: ["^echo ok$"] },
      },
    });
    writeStatusFile(taskDir, status);
    const read = readStatusFile(taskDir);
    assert.equal(read?.completionPromise, "DONE");
    assert.deepEqual(read?.guardrails.blockCommands, ["git\\s+push", "rm\\s+-rf"]);
    assert.deepEqual(read?.guardrails.protectedFiles, ["secret.pem"]);
    assert.deepEqual(read?.guardrails.shellPolicy, { mode: "allowlist", allow: ["^echo ok$"] });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readStatusFile rejects symlinked status.json", () => {
  const taskDir = createTempDir();
  const outside = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const outsideStatus = join(outside, "status.json");
    writeFileSync(outsideStatus, JSON.stringify(makeStatusFile({ taskDir, status: "complete" })), "utf8");
    symlinkSync(outsideStatus, join(taskDir, ".ralph-runner", "status.json"));

    assert.equal(readStatusFile(taskDir), undefined);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("readStatusFile rejects oversized status.json", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ ...makeStatusFile({ taskDir }), padding: "x".repeat(70 * 1024) }), "utf8");

    assert.equal(readStatusFile(taskDir), undefined);
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

test("readIterationRecords rejects symlinked iterations.jsonl", () => {
  const taskDir = createTempDir();
  const outside = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const outsideIterations = join(outside, "iterations.jsonl");
    writeFileSync(outsideIterations, `${JSON.stringify(makeIterationRecord({ iteration: 99, changedFiles: ["secret.md"] }))}\n`, "utf8");
    symlinkSync(outsideIterations, join(taskDir, ".ralph-runner", "iterations.jsonl"));

    assert.deepEqual(readIterationRecords(taskDir), []);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("readIterationRecords caps parsed records", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const lines = Array.from({ length: 1100 }, (_, index) => JSON.stringify(makeIterationRecord({ iteration: index + 1 })));
    writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const records = readIterationRecords(taskDir);
    assert.equal(records.length, 1000);
    assert.equal(records[999].iteration, 1000);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readIterationRecords rejects oversized iterations.jsonl", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), `${JSON.stringify(makeIterationRecord({ iteration: 1 }))}\n${"x".repeat(1024 * 1024)}\n`, "utf8");

    assert.deepEqual(readIterationRecords(taskDir), []);
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

test("readRunnerEvents rejects symlinked events.jsonl", () => {
  const taskDir = createTempDir();
  const outside = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const event = { type: "runner.finished", timestamp: new Date().toISOString(), loopToken: "secret", status: "complete", iterations: 1, totalDurationMs: 1 } satisfies Extract<RunnerEvent, { type: "runner.finished" }>;
    const outsideEvents = join(outside, "events.jsonl");
    writeFileSync(outsideEvents, `${JSON.stringify(event)}\n`, "utf8");
    symlinkSync(outsideEvents, join(taskDir, ".ralph-runner", "events.jsonl"));

    assert.deepEqual(readRunnerEvents(taskDir), []);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("readRunnerEvents caps parsed events", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const lines = Array.from({ length: 1100 }, (_, index) => JSON.stringify({
      type: "runner.finished",
      timestamp: new Date().toISOString(),
      loopToken: `loop-${index + 1}`,
      status: "complete",
      iterations: index + 1,
      totalDurationMs: 1,
    } satisfies Extract<RunnerEvent, { type: "runner.finished" }>));
    writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const events = readRunnerEvents(taskDir);
    assert.equal(events.length, 1000);
    assert.equal(events[999].loopToken, "loop-1000");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("readRunnerEvents rejects oversized events.jsonl", () => {
  const taskDir = createTempDir();
  try {
    ensureRunnerDir(taskDir);
    const event = { type: "runner.finished", timestamp: new Date().toISOString(), loopToken: "loop-1", status: "complete", iterations: 1, totalDurationMs: 1 } satisfies Extract<RunnerEvent, { type: "runner.finished" }>;
    writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), `${JSON.stringify(event)}\n${"x".repeat(1024 * 1024)}\n`, "utf8");

    assert.deepEqual(readRunnerEvents(taskDir), []);
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

test("control signals are token-bound and stale requests cannot stop a successor", () => {
  const taskDir = createTempDir();
  try {
    const startedAt = new Date().toISOString();
    const first: ActiveLoopRegistryEntry = {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd: taskDir,
      loopToken: "first-signal-token",
      status: "running",
      currentIteration: 1,
      maxIterations: 3,
      startedAt,
      updatedAt: startedAt,
    };
    assert.equal(writeActiveLoopRegistryEntry(taskDir, first), true);
    assert.equal(createStopSignal(taskDir, first.loopToken), true);
    assert.equal(checkStopSignal(taskDir, first.loopToken), true);

    recordActiveLoopStopObservation(taskDir, taskDir, new Date().toISOString(), first.loopToken);
    const successor: ActiveLoopRegistryEntry = {
      ...first,
      loopToken: "successor-signal-token",
      status: "running",
      currentIteration: 0,
      updatedAt: new Date().toISOString(),
    };
    assert.equal(writeActiveLoopRegistryEntry(taskDir, successor), true);
    assert.equal(checkStopSignal(taskDir, successor.loopToken), false);
    assert.equal(checkStopSignal(taskDir), false);

    assert.equal(createCancelSignal(taskDir, first.loopToken), false);
    assert.equal(checkCancelSignal(taskDir), false);
    assert.equal(createCancelSignal(taskDir, successor.loopToken), true);
    assert.equal(checkCancelSignal(taskDir, successor.loopToken), true);
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

test("writeIterationTranscript independently bounds assistant text with a head/tail preview", () => {
  const taskDir = createTempDir();
  try {
    const cases = [
      "Finished the task.",
      "x".repeat(12_000),
      "HEAD" + "x".repeat(11_997) + "TAIL",
      "HEAD" + "界😀".repeat(10_000) + "TAIL",
    ];
    for (const [index, assistantText] of cases.entries()) {
      const transcriptPath = writeIterationTranscript(taskDir, {
        record: makeIterationRecord({ iteration: index + 1, status: "complete" }),
        prompt: "Rendered prompt",
        commandOutputs: [],
        assistantText,
      });
      const raw = readFileSync(transcriptPath, "utf8");
      const preview = raw.split("## Assistant text\n\n```text\n")[1].split("\n```\n")[0];
      if (assistantText.length <= 12_000) {
        assert.equal(preview, assistantText);
      } else {
        assert.ok(preview.length <= 12_000);
        assert.ok(preview.startsWith("HEAD"));
        assert.ok(preview.endsWith("TAIL"));
        assert.ok(preview.includes("assistant text truncated to 12000 UTF-16 code units"));
        assert.ok(preview.includes(`original ${Buffer.byteLength(assistantText, "utf8")} bytes`));
        assert.ok(!preview.includes("\ufffd"), "retained Unicode must not be corrupted");
        assert.ok(Buffer.byteLength(preview, "utf8") <= 36_000);
      }
    }
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("writeIterationTranscript does not split surrogate pairs at either preview boundary", () => {
  const taskDir = createTempDir();
  try {
    // Each emoji replaces two ASCII code units, adding two UTF-8 bytes.
    const marker = "\n[ralph: assistant text truncated to 12000 UTF-16 code units; original 20004 bytes]\n";
    const visibleUnits = 12_000 - marker.length;
    const headUnits = Math.floor(visibleUnits * 0.7);
    const tailStart = 20_000 - (visibleUnits - headUnits);
    const assistantText = "x".repeat(headUnits - 1) + "😀"
      + "x".repeat(tailStart - headUnits - 2) + "😀"
      + "x".repeat(20_000 - tailStart - 1);
    assert.equal(assistantText.length, 20_000);
    assert.equal(Buffer.byteLength(assistantText, "utf8"), 20_004);

    const transcriptPath = writeIterationTranscript(taskDir, {
      record: makeIterationRecord({ iteration: 1, status: "complete" }),
      prompt: "Rendered prompt",
      commandOutputs: [],
      assistantText,
    });
    const raw = readFileSync(transcriptPath, "utf8");
    const preview = raw.split("## Assistant text\n\n```text\n")[1].split("\n```\n")[0];
    assert.equal(preview, "x".repeat(headUnits - 1) + marker
      + "x".repeat(visibleUnits - headUnits - 1));
    assert.equal(preview.length, 11_998);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("writeIterationTranscript caps oversized command output", () => {
  const taskDir = createTempDir();
  try {
    const largeOutput = "x".repeat(20_000);
    const transcriptPath = writeIterationTranscript(taskDir, {
      record: makeIterationRecord({ iteration: 1, status: "complete" }),
      prompt: "Rendered prompt",
      commandOutputs: [{ name: "logs", output: largeOutput }],
      assistantText: "Done.",
    });

    const raw = readFileSync(transcriptPath, "utf8");
    assert.ok(raw.length < largeOutput.length + 1000);
    assert.ok(raw.includes("command output truncated"));
    assert.ok(raw.includes("original 20000 bytes"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("active loop registry filters stale entries without deleting registry files", () => {
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
    const registryFiles = readdirSync(join(cwd, ".ralph-runner", "active-loops")).filter((name) => name.endsWith(".json"));
    assert.equal(registryFiles.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active loop registry ignores symlinked per-loop registry files", () => {
  const cwd = createTempDir();
  const outside = createTempDir();
  try {
    const taskDir = join(cwd, "symlink-registry-task");
    mkdirSync(taskDir, { recursive: true });
    writeActiveLoopRegistryEntry(cwd, {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "symlink-loop-token",
      status: "running",
      currentIteration: 1,
      maxIterations: 2,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const registryDir = join(cwd, ".ralph-runner", "active-loops");
    const [entryFile] = readdirSync(registryDir).filter((name) => name.endsWith(".json"));
    rmSync(join(registryDir, entryFile), { force: true });
    const outsideFile = join(outside, "outside.json");
    writeFileSync(outsideFile, JSON.stringify({ taskDir, ralphPath: join(taskDir, "RALPH.md"), cwd, loopToken: "outside", status: "running", currentIteration: 1, maxIterations: 2, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), "utf8");
    symlinkSync(outsideFile, join(registryDir, entryFile));

    assert.deepEqual(readActiveLoopRegistry(cwd), []);
    assert.equal(readFileSync(outsideFile, "utf8").includes("outside"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("active loop registry ignores oversized per-loop registry files", () => {
  const cwd = createTempDir();
  try {
    const taskDir = join(cwd, "oversized-registry-task");
    mkdirSync(taskDir, { recursive: true });
    writeActiveLoopRegistryEntry(cwd, {
      taskDir,
      ralphPath: join(taskDir, "RALPH.md"),
      cwd,
      loopToken: "oversized-loop-token",
      status: "running",
      currentIteration: 1,
      maxIterations: 2,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const registryDir = join(cwd, ".ralph-runner", "active-loops");
    const [entryFile] = readdirSync(registryDir).filter((name) => name.endsWith(".json"));
    writeFileSync(join(registryDir, entryFile), `${"x".repeat(70 * 1024)}`, "utf8");

    assert.deepEqual(readActiveLoopRegistry(cwd), []);
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), []);
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

test("active loop registry ignores symlinked legacy active-loops.json files", () => {
  const cwd = createTempDir();
  const outside = createTempDir();
  try {
    ensureRunnerDir(cwd);
    const outsideFile = join(outside, "active-loops.json");
    writeFileSync(outsideFile, JSON.stringify([{ taskDir: join(cwd, "task"), ralphPath: join(cwd, "task", "RALPH.md"), cwd, loopToken: "outside", status: "running", currentIteration: 1, maxIterations: 2, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]), "utf8");
    symlinkSync(outsideFile, join(cwd, ".ralph-runner", "active-loops.json"));

    assert.deepEqual(readActiveLoopRegistry(cwd), []);
    assert.equal(readFileSync(outsideFile, "utf8").includes("outside"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("active loop registry ignores oversized legacy active-loops.json files", () => {
  const cwd = createTempDir();
  try {
    ensureRunnerDir(cwd);
    writeFileSync(join(cwd, ".ralph-runner", "active-loops.json"), `${"x".repeat(70 * 1024)}`, "utf8");

    assert.deepEqual(readActiveLoopRegistry(cwd), []);
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), []);
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

    const mismatched = recordActiveLoopStopRequest(cwd, taskDir, new Date().toISOString(), "other-loop-token");
    assert.equal(mismatched, undefined);
    assert.equal(readActiveLoopRegistry(cwd)[0]?.stopRequestedAt, undefined);

    const requestedAt = new Date().toISOString();
    const requested = recordActiveLoopStopRequest(cwd, taskDir, requestedAt, entry.loopToken);
    assert.equal(requested?.stopRequestedAt, requestedAt);
    assert.equal(listActiveLoopRegistryEntries(cwd).length, 1);

    const observedAt = new Date(Date.now() + 1000).toISOString();
    const observed = recordActiveLoopStopObservation(cwd, taskDir, observedAt, entry.loopToken);
    assert.equal(observed?.stopObservedAt, observedAt);
    assert.equal(observed?.status, "stopped");
    writeActiveLoopRegistryEntry(cwd, {
      ...entry,
      currentIteration: 5,
      updatedAt: new Date(Date.now() + 2000).toISOString(),
    });
    const terminal = readActiveLoopRegistry(cwd)[0];
    assert.equal(terminal?.status, "stopped");
    assert.equal(terminal?.stopObservedAt, observedAt);
    assert.deepEqual(listActiveLoopRegistryEntries(cwd), []);
    const cancelledEntry: ActiveLoopRegistryEntry = {
      ...entry,
      loopToken: "registry-cancel-token",
      status: "running",
      currentIteration: 1,
      updatedAt: new Date(Date.now() + 3000).toISOString(),
    };
    assert.equal(writeActiveLoopRegistryEntry(cwd, cancelledEntry), true);
    const cancelled = recordActiveLoopStopObservation(
      cwd,
      taskDir,
      new Date(Date.now() + 4000).toISOString(),
      cancelledEntry.loopToken,
      "cancelled",
    );
    assert.equal(cancelled?.status, "cancelled");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active loop registry refuses a different token while a run is active", (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const taskDir = join(cwd, "registry-claim-task");
  mkdirSync(taskDir, { recursive: true });
  const aliasDir = join(cwd, "registry-claim-alias");
  symlinkSync(taskDir, aliasDir, "dir");
  const first: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath: join(taskDir, "RALPH.md"),
    cwd,
    loopToken: "first-token",
    status: "running",
    currentIteration: 1,
    maxIterations: 4,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const successor: ActiveLoopRegistryEntry = {
    ...first,
    taskDir: aliasDir,
    ralphPath: join(aliasDir, "RALPH.md"),
    loopToken: "successor-token",
    currentIteration: 0,
  };

  assert.equal(writeActiveLoopRegistryEntry(cwd, first), true);
  assert.equal(writeActiveLoopRegistryEntry(cwd, successor), false);
  assert.equal(readActiveLoopRegistry(cwd)[0]?.loopToken, first.loopToken);
  const aliasRequest = recordActiveLoopStopRequest(cwd, aliasDir, new Date().toISOString());
  assert.equal(aliasRequest?.loopToken, first.loopToken);

  recordActiveLoopStopObservation(cwd, taskDir, new Date().toISOString(), first.loopToken);
  assert.equal(writeActiveLoopRegistryEntry(cwd, successor), true);
  assert.equal(readActiveLoopRegistry(cwd)[0]?.loopToken, successor.loopToken);
});

test("active loop registry serializes a stop request ahead of a heartbeat", { timeout: 5000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const taskDir = join(cwd, "registry-race-task");
  mkdirSync(taskDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const requestedAt = new Date(Date.now() + 1000).toISOString();
  const initial: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath: join(taskDir, "RALPH.md"),
    cwd,
    loopToken: "registry-race-token",
    status: "running",
    currentIteration: 1,
    maxIterations: 4,
    startedAt,
    updatedAt: startedAt,
  };
  writeActiveLoopRegistryEntry(cwd, initial);

  const acquiredPath = join(cwd, "child-lock-acquired");
  const releasePath = join(cwd, "release-child-lock");
  execFileSync("mkfifo", [releasePath]);
  const childScript = join(cwd, "registry-lock-child.ts");
  const runnerStateUrl = pathToFileURL(join(process.cwd(), "src", "runner-state.ts")).href;
  writeFileSync(
    childScript,
    `import { readFileSync, writeFileSync } from "node:fs";
import { updateActiveLoopRegistryEntry } from ${JSON.stringify(runnerStateUrl)};
const [cwd, taskDir, acquiredPath, releasePath, requestedAt] = process.argv.slice(2);
updateActiveLoopRegistryEntry(cwd, taskDir, "registry-race-token", (entry) => {
  writeFileSync(acquiredPath, "acquired");
  readFileSync(releasePath);
  return { ...entry, stopRequestedAt: requestedAt, updatedAt: requestedAt };
});
`,
    "utf8",
  );

  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    childScript,
    cwd,
    taskDir,
    acquiredPath,
    releasePath,
    requestedAt,
  ], { stdio: "inherit" });
  t.after(() => child.kill("SIGKILL"));

  if (!existsSync(acquiredPath)) {
    const ready = Promise.withResolvers<void>();
    const watcher = watch(cwd, () => {
      if (!existsSync(acquiredPath)) return;
      watcher.close();
      ready.resolve();
    });
    t.after(() => watcher.close());
    if (existsSync(acquiredPath)) {
      watcher.close();
      ready.resolve();
    }
    await ready.promise;
  }

  writeFileSync(releasePath, "release", "utf8");
  writeActiveLoopRegistryEntry(cwd, {
    ...initial,
    currentIteration: 2,
    updatedAt: new Date(Date.now() + 2000).toISOString(),
  });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);

  const [final] = readActiveLoopRegistry(cwd);
  assert.equal(final.currentIteration, 2);
  assert.equal(final.stopRequestedAt, requestedAt);
});

test("active loop registry owner cleanup leaves a successor lock intact", { timeout: 5000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const taskDir = join(cwd, "registry-lock-owner-task");
  mkdirSync(taskDir, { recursive: true });
  const initial: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath: join(taskDir, "RALPH.md"),
    cwd,
    loopToken: "registry-owner-token",
    status: "running",
    currentIteration: 1,
    maxIterations: 4,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeActiveLoopRegistryEntry(cwd, initial);

  const acquiredPath = join(cwd, "owner-lock-acquired");
  const releasePath = join(cwd, "release-owner-lock");
  execFileSync("mkfifo", [releasePath]);
  const childScript = join(cwd, "registry-owner-child.ts");
  const runnerStateUrl = pathToFileURL(join(process.cwd(), "src", "runner-state.ts")).href;
  writeFileSync(
    childScript,
    `import { readFileSync, writeFileSync } from "node:fs";
import { updateActiveLoopRegistryEntry } from ${JSON.stringify(runnerStateUrl)};
const [cwd, taskDir, acquiredPath, releasePath] = process.argv.slice(2);
updateActiveLoopRegistryEntry(cwd, taskDir, "registry-owner-token", (entry) => {
  writeFileSync(acquiredPath, "acquired");
  readFileSync(releasePath);
  return { ...entry, currentIteration: 2 };
});
`,
    "utf8",
  );

  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    childScript,
    cwd,
    taskDir,
    acquiredPath,
    releasePath,
  ], { stdio: "inherit" });
  t.after(() => child.kill("SIGKILL"));

  if (!existsSync(acquiredPath)) {
    const ready = Promise.withResolvers<void>();
    const watcher = watch(cwd, () => {
      if (!existsSync(acquiredPath)) return;
      watcher.close();
      ready.resolve();
    });
    t.after(() => watcher.close());
    if (existsSync(acquiredPath)) {
      watcher.close();
      ready.resolve();
    }
    await ready.promise;
  }

  const registryHash = createHash("sha256").update(taskDir).digest("hex");
  const lockPath = join(cwd, ".ralph-runner", "active-loops", `${registryHash}.json.lock`);
  rmSync(lockPath, { force: true });
  writeFileSync(lockPath, "replacement-owner", "utf8");
  writeFileSync(releasePath, "release", "utf8");

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(lockPath, "utf8"), "replacement-owner");
});
