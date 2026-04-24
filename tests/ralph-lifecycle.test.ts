import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerRalphCommands from "../src/index.ts";
import { appendIterationRecord, listActiveLoopRegistryEntries, writeActiveLoopRegistryEntry, writeStatusFile } from "../src/runner-state.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-loop-lifecycle-"));
}

function createValidRalphMarkdown(): string {
  return [
    "---",
    "commands:",
    "  - name: tests",
    "    run: echo ok",
    "    timeout: 1",
    "max_iterations: 3",
    "timeout: 1",
    "guardrails:",
    "  block_commands: []",
    "  protected_files: []",
    "---",
    "Run the task.",
  ].join("\n");
}

function createHarness(options?: { runRalphLoopFn?: (...args: Array<any>) => Promise<any> }) {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<any>>();
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const sessionEntries: Array<any> = [];

  const pi = {
    on: () => undefined,
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<any> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    },
    sendUserMessage: async () => undefined,
    exec: async () => ({ killed: false, stdout: "", stderr: "" }),
  } as any;

  registerRalphCommands(pi, {
    runRalphLoopFn:
      options?.runRalphLoopFn ??
      (async () => ({
        status: "complete",
        iterations: [],
        totalDurationMs: 0,
      })),
  } as any);

  const ui = {
    notify: (message: string, level: "info" | "warning" | "error") => {
      notifications.push({ message, level });
    },
    setStatus: () => undefined,
    input: async () => undefined,
    select: async () => undefined,
    editor: async () => undefined,
  };

  const ctx = (cwd: string) => ({
    cwd,
    hasUI: true,
    ui,
    sessionManager: {
      getEntries: () => sessionEntries,
      getSessionFile: () => join(cwd, ".session.json"),
    },
    appendSessionEntry: (entry: any) => sessionEntries.push(entry),
    waitForIdle: async () => undefined,
  });

  return {
    handlers,
    notifications,
    sessionEntries,
    ctx,
  };
}

async function invoke(harness: ReturnType<typeof createHarness>, name: string, args: string, cwd: string) {
  const handler = harness.handlers.get(name);
  assert.ok(handler, `missing handler for ${name}`);
  return await handler(args, harness.ctx(cwd));
}

test("/ralph-list shows active loops from the durable registry", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "alpha-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), createValidRalphMarkdown(), "utf8");
  writeActiveLoopRegistryEntry(cwd, {
    taskDir,
    ralphPath: join(taskDir, "RALPH.md"),
    cwd,
    loopToken: "token-alpha",
    status: "running",
    currentIteration: 2,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const harness = createHarness();
  await invoke(harness, "ralph-list", "", cwd);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].level, "info");
  assert.equal(harness.notifications[0].message, `alpha-task | ./alpha-task | running | 2/10`);
});

test("/ralph-status reads durable status and last iteration details", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "beta-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), createValidRalphMarkdown(), "utf8");

  writeStatusFile(taskDir, {
    loopToken: "token-beta",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "complete",
    currentIteration: 3,
    maxIterations: 3,
    timeout: 1,
    startedAt: "2026-04-23T12:00:00.000Z",
    completedAt: "2026-04-23T12:05:00.000Z",
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  appendIterationRecord(taskDir, {
    iteration: 3,
    status: "complete",
    startedAt: "2026-04-23T12:04:00.000Z",
    completedAt: "2026-04-23T12:05:00.000Z",
    durationMs: 60000,
    progress: true,
    changedFiles: ["src/example.ts"],
    noProgressStreak: 0,
    completionGate: { ready: false, reasons: ["OPEN_QUESTIONS.md still has P0 items"] },
  });

  const harness = createHarness();
  await invoke(harness, "ralph-status", taskDir, cwd);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].level, "info");
  assert.match(harness.notifications[0].message, /status: complete/);
  assert.match(harness.notifications[0].message, /startedAt: 2026-04-23T12:00:00\.000Z/);
  assert.match(harness.notifications[0].message, /currentIteration: 3\/3/);
  assert.match(harness.notifications[0].message, /lastUpdate: 2026-04-23T12:05:00\.000Z/);
  assert.match(harness.notifications[0].message, /lastIteration: #3 durationMs=60000 progress=true completionGate=blocked \(OPEN_QUESTIONS\.md still has P0 items\)/);
});

test("/ralph-resume refuses when active and starts when inactive", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "gamma-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, createValidRalphMarkdown(), "utf8");
  writeActiveLoopRegistryEntry(cwd, {
    taskDir,
    ralphPath,
    cwd,
    loopToken: "token-gamma",
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const capturedCalls: Array<any> = [];
  const activeHarness = createHarness({
    runRalphLoopFn: async (...args: Array<any>) => {
      capturedCalls.push(args[0]);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });

  await invoke(activeHarness, "ralph-resume", taskDir, cwd);
  assert.equal(capturedCalls.length, 0);
  assert.equal(activeHarness.notifications.length, 1);
  assert.equal(activeHarness.notifications[0].level, "warning");
  assert.match(activeHarness.notifications[0].message, /Use \/ralph-stop or \/ralph-cancel first\./);

  rmSync(join(cwd, ".ralph-runner"), { recursive: true, force: true });
  const inactiveHarness = createHarness({
    runRalphLoopFn: async (config: any) => {
      capturedCalls.push(config);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });

  await invoke(inactiveHarness, "ralph-resume", taskDir, cwd);
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].ralphPath, ralphPath);
  assert.equal(capturedCalls[0].cwd, cwd);
  assert.ok(inactiveHarness.notifications.some((entry) => entry.level === "info" && entry.message.startsWith("Ralph loop started:")));
});

test("/ralph-archive moves the runner directory into the archive area", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "delta-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), createValidRalphMarkdown(), "utf8");
  writeStatusFile(taskDir, {
    loopToken: "token-delta",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "complete",
    currentIteration: 2,
    maxIterations: 2,
    timeout: 1,
    startedAt: "2026-04-23T12:10:00.000Z",
    completedAt: "2026-04-23T12:11:00.000Z",
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  appendIterationRecord(taskDir, {
    iteration: 2,
    status: "complete",
    startedAt: "2026-04-23T12:10:30.000Z",
    completedAt: "2026-04-23T12:11:00.000Z",
    durationMs: 30000,
    progress: true,
    changedFiles: ["docs/summary.md"],
    noProgressStreak: 0,
  });

  const harness = createHarness();
  await invoke(harness, "ralph-archive", taskDir, cwd);

  const runnerDir = join(taskDir, ".ralph-runner");
  const archiveRoot = join(taskDir, ".ralph-runner-archive");
  assert.equal(existsSync(runnerDir), false);
  assert.equal(existsSync(archiveRoot), true);
  const archiveEntries = readdirSync(archiveRoot);
  assert.equal(archiveEntries.length, 1);
  assert.doesNotMatch(archiveEntries[0], /:/);
  const archiveDir = join(archiveRoot, archiveEntries[0]);
  assert.equal(existsSync(join(archiveDir, "status.json")), true);
  assert.equal(existsSync(join(archiveDir, "iterations.jsonl")), true);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].level, "info");
  assert.match(harness.notifications[0].message, /Archived run artifacts to/);
});

test("/ralph-resume and /ralph-archive refuse active loops discovered through status.cwd from another cwd", async (t) => {
  const originCwd = createTempDir();
  const invocationCwd = createTempDir();
  t.after(() => rmSync(originCwd, { recursive: true, force: true }));
  t.after(() => rmSync(invocationCwd, { recursive: true, force: true }));

  const taskDir = join(originCwd, "epsilon-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  const now = new Date().toISOString();
  writeFileSync(ralphPath, createValidRalphMarkdown(), "utf8");
  writeStatusFile(taskDir, {
    loopToken: "token-epsilon",
    ralphPath,
    taskDir,
    cwd: originCwd,
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    timeout: 1,
    startedAt: now,
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  writeActiveLoopRegistryEntry(originCwd, {
    taskDir,
    ralphPath,
    cwd: originCwd,
    loopToken: "token-epsilon",
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    startedAt: now,
    updatedAt: now,
  });

  const capturedCalls: Array<any> = [];
  const resumeHarness = createHarness({
    runRalphLoopFn: async (...args: Array<any>) => {
      capturedCalls.push(args[0]);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });

  await invoke(resumeHarness, "ralph-resume", taskDir, invocationCwd);
  assert.equal(capturedCalls.length, 0);
  assert.equal(resumeHarness.notifications.length, 1);
  assert.equal(resumeHarness.notifications[0].level, "warning");
  assert.match(resumeHarness.notifications[0].message, /Use \/ralph-stop or \/ralph-cancel first\./);

  const archiveHarness = createHarness();
  await invoke(archiveHarness, "ralph-archive", taskDir, invocationCwd);
  assert.equal(existsSync(join(taskDir, ".ralph-runner-archive")), false);
  assert.equal(archiveHarness.notifications.length, 1);
  assert.equal(archiveHarness.notifications[0].level, "warning");
  assert.match(archiveHarness.notifications[0].message, /Use \/ralph-stop or \/ralph-cancel first\./);
});
