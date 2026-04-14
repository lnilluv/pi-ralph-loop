import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ensureRunnerDir, readRunnerEvents, type CompletionRecord, type ProgressState, type RunnerEvent, type RunnerStatus, type RunnerStatusFile } from "../src/runner-state.ts";

type Guardrails = RunnerStatusFile["guardrails"];

type ExpectedRunnerEvent =
  | {
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
    }
  | {
      type: "iteration.started";
      timestamp: string;
      iteration: number;
      loopToken: string;
      status: "running";
      maxIterations: number;
      timeout: number;
      completionPromise?: string;
    }
  | {
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
    }
  | {
      type: "durable.progress.observed";
      timestamp: string;
      iteration: number;
      loopToken: string;
      progress: true;
      changedFiles: string[];
      snapshotTruncated?: boolean;
      snapshotErrorCount?: number;
    }
  | {
      type: "durable.progress.missing";
      timestamp: string;
      iteration: number;
      loopToken: string;
      progress: false;
      changedFiles: string[];
      snapshotTruncated?: boolean;
      snapshotErrorCount?: number;
    }
  | {
      type: "durable.progress.unknown";
      timestamp: string;
      iteration: number;
      loopToken: string;
      progress: "unknown";
      changedFiles: string[];
      snapshotTruncated?: boolean;
      snapshotErrorCount?: number;
    }
  | {
      type: "completion_promise_seen";
      timestamp: string;
      iteration: number;
      loopToken: string;
      completionPromise: string;
    }
  | {
      type: "completion.gate.checked";
      timestamp: string;
      iteration: number;
      loopToken: string;
      ready: boolean;
      reasons: string[];
    }
  | {
      type: "completion_gate_passed";
      timestamp: string;
      iteration: number;
      loopToken: string;
      ready: true;
      reasons: string[];
    }
  | {
      type: "completion_gate_blocked";
      timestamp: string;
      iteration: number;
      loopToken: string;
      ready: false;
      reasons: string[];
    }
  | {
      type: "runner.finished";
      timestamp: string;
      loopToken: string;
      status: RunnerStatus;
      iterations: number;
      totalDurationMs: number;
    };

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
    (<T>() => T extends Right ? 1 : 2)
    ? ((<T>() => T extends Right ? 1 : 2) extends (<T>() => T extends Left ? 1 : 2) ? true : false)
    : false;

type Assert<T extends true> = T;

type _runnerEventContract = Assert<Equal<RunnerEvent, ExpectedRunnerEvent>>;

// Compile-time contract checks: these contradictory payloads must be rejected.
const invalidDurableProgressObservedEvent: Extract<ExpectedRunnerEvent, { type: "durable.progress.observed" }> = {
  type: "durable.progress.observed",
  timestamp: new Date("2026-04-13T12:00:01.000Z").toISOString(),
  iteration: 1,
  loopToken: "test-loop-token",
  // @ts-expect-error durable.progress.observed requires progress: true
  progress: false,
  changedFiles: ["src/loop.ts"],
};

const invalidCompletionGatePassedEvent: Extract<ExpectedRunnerEvent, { type: "completion_gate_passed" }> = {
  type: "completion_gate_passed",
  timestamp: new Date("2026-04-13T12:00:02.000Z").toISOString(),
  iteration: 1,
  loopToken: "test-loop-token",
  // @ts-expect-error completion_gate_passed requires ready: true
  ready: false,
  reasons: ["ready=false is contradictory"],
};

const invalidCompletionGateBlockedEvent: Extract<ExpectedRunnerEvent, { type: "completion_gate_blocked" }> = {
  type: "completion_gate_blocked",
  timestamp: new Date("2026-04-13T12:00:03.000Z").toISOString(),
  iteration: 1,
  loopToken: "test-loop-token",
  // @ts-expect-error completion_gate_blocked requires ready: false
  ready: true,
  reasons: ["ready=true is contradictory"],
};

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-runner-event-contract-"));
}

function writeEventsFile(taskDir: string, events: unknown[]): void {
  const runnerDir = ensureRunnerDir(taskDir);
  const eventsFile = join(runnerDir, "events.jsonl");
  writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function makeValidStartedEvent(taskDir: string): Extract<ExpectedRunnerEvent, { type: "runner.started" }> {
  return {
    type: "runner.started",
    timestamp: new Date("2026-04-13T12:00:00.000Z").toISOString(),
    loopToken: "test-loop-token",
    cwd: taskDir,
    taskDir,
    status: "initializing",
    maxIterations: 3,
    timeout: 10,
    completionPromise: "DONE",
    guardrails: { blockCommands: [], protectedFiles: [] },
  };
}

const malformedRunnerEventCases = [
  {
    name: "durable.progress.observed with progress false",
    event: {
      type: "durable.progress.observed",
      timestamp: new Date("2026-04-13T12:00:01.000Z").toISOString(),
      iteration: 1,
      loopToken: "test-loop-token",
      progress: false,
      changedFiles: ["src/loop.ts"],
    },
  },
  {
    name: "completion_gate_passed with ready false",
    event: {
      type: "completion_gate_passed",
      timestamp: new Date("2026-04-13T12:00:02.000Z").toISOString(),
      iteration: 1,
      loopToken: "test-loop-token",
      ready: false,
      reasons: ["ready=false is contradictory"],
    },
  },
  {
    name: "completion_gate_blocked with ready true",
    event: {
      type: "completion_gate_blocked",
      timestamp: new Date("2026-04-13T12:00:03.000Z").toISOString(),
      iteration: 1,
      loopToken: "test-loop-token",
      ready: true,
      reasons: ["ready=true is contradictory"],
    },
  },
] as const;

for (const { name, event } of malformedRunnerEventCases) {
  test(`readRunnerEvents rejects ${name}`, () => {
    const taskDir = createTempDir();
    try {
      const validEvent = makeValidStartedEvent(taskDir);
      writeEventsFile(taskDir, [validEvent, event]);

      const events = readRunnerEvents(taskDir);
      assert.deepEqual(events, [validEvent]);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });
}
