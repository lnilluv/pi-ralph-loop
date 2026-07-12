import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import registerRalphCommands, { parseLogExportArgs, parseRalphStartArgs, parseStatusCommandArgs, runCommands } from "../src/index.ts";
import { SECRET_PATH_POLICY_TOKEN } from "../src/secret-paths.ts";
import { generateDraft, inspectDraftContent, slugifyTask, type DraftPlan, type DraftTarget } from "../src/ralph.ts";
import type { StrengthenDraftRuntime } from "../src/ralph-draft-llm.ts";
import type { RunnerConfig, RunnerResult } from "../src/runner.ts";
import { runRalphLoop as realRunRalphLoop } from "../src/runner.ts";
import {
  appendIterationRecord,
  checkCancelSignal,
  checkStopSignal,
  listActiveLoopRegistryEntries,
  readActiveLoopRegistry,
  writeActiveLoopRegistryEntry,
  writeStatusFile,
  type ActiveLoopRegistryEntry,
  type IterationRecord,
  type RunnerStatusFile,
} from "../src/runner-state.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-loop-index-"));
}

function setRunnerEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function createTarget(cwd: string, task: string): DraftTarget {
  const slug = slugifyTask(task);
  return {
    slug,
    dirPath: join(cwd, slug),
    ralphPath: join(cwd, slug, "RALPH.md"),
  };
}

function makeDraftPlan(task: string, target: DraftTarget, source: DraftPlan["source"]): DraftPlan {
  const base = generateDraft(task, target, {
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });

  return {
    ...base,
    source,
    target,
    content: base.content,
  };
}

function createHarness(options?: {
  createDraftPlan?: (...args: Array<any>) => Promise<DraftPlan>;
  exec?: (...args: Array<any>) => Promise<any>;
  sendUserMessage?: (...args: Array<any>) => any;
  appendEntry?: (customType: string, data: unknown) => void;
  runRalphLoopFn?: (config: RunnerConfig) => Promise<RunnerResult>;
}) {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<string | undefined>>();
  const eventHandlers = new Map<string, (...args: Array<any>) => Promise<any> | any>();
  const appendedEntries: Array<any> = [];
  let activeCtx: any;
  const resolveRuntimeCtx = () => activeCtx?.getRuntimeCtx?.() ?? activeCtx;
  const appendSessionEntry = (entry: any) => {
    const currentCtx = resolveRuntimeCtx();
    if (typeof currentCtx?.appendSessionEntry === "function") {
      currentCtx.appendSessionEntry(entry);
      return;
    }
    appendedEntries.push(entry);
  };
  const sendUserMessage = async (message: string, sendOptions?: { deliverAs?: string }) => {
    const currentCtx = resolveRuntimeCtx();
    await options?.sendUserMessage?.(message, sendOptions);
    if (currentCtx?.suppressAutoAgentEnd) return;
    await currentCtx?.waitForIdle?.();
  };
  const exec = options?.exec ?? (async () => ({ killed: false, stdout: "", stderr: "", code: 0 }));
  const pi = {
    on: (eventName: string, handler: (...args: Array<any>) => Promise<any> | any) => {
      eventHandlers.set(eventName, handler);
    },
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<string | undefined> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      appendSessionEntry({ type: "custom", customType, data });
      options?.appendEntry?.(customType, data);
    },
    sendUserMessage,
    exec,
    __ralphRunShellCommandBounded: async (command: string, timeoutMs: number, cwd: string | undefined) => {
      const result = await exec("bash", ["-c", command], { timeout: timeoutMs, cwd });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      return {
        stdout,
        stderr,
        code: typeof result.code === "number" ? result.code : null,
        signal: result.signal ?? null,
        killed: result.killed === true,
        outputBytes: Buffer.byteLength(stdout + stderr, "utf8"),
        outputTruncated: false,
      };
    },
  } as any;

  // Default no-op runner for command-only tests.
  const defaultRunLoopFn = async (): Promise<RunnerResult> => ({
    status: "complete",
    iterations: [],
    totalDurationMs: 0,
  });

  registerRalphCommands(pi, {
    createDraftPlan: options?.createDraftPlan,
    runRalphLoopFn: options?.runRalphLoopFn ?? defaultRunLoopFn,
  } as any);

  return {
    appendedEntries,
    handler(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing handler for ${name}`);
      return async (args: string, ctx: any) => {
        const effectiveCtx =
          typeof ctx?.getRuntimeCtx === "function"
            ? ctx
            : {
                ...ctx,
                appendSessionEntry: (entry: any) => appendedEntries.push(entry),
                sessionManager: {
                  ...ctx.sessionManager,
                  getEntries: () => appendedEntries,
                },
              };
        activeCtx = effectiveCtx;
        try {
          return await handler(args, effectiveCtx);
        } finally {
          activeCtx = undefined;
        }
      };
    },
    event(name: string) {
      const handler = eventHandlers.get(name);
      assert.ok(handler, `missing event handler for ${name}`);
      return handler;
    },
  };
}


function createSessionManager(entries: Array<any>, sessionFile: string) {
  return {
    getEntries: () => entries,
    getSessionFile: () => sessionFile,
  };
}


test("registerRalphCommands is idempotent for the same extension API instance", () => {
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];
  const pi = {
    on: (eventName: string) => {
      registeredEvents.push(eventName);
    },
    registerCommand: (name: string) => {
      registeredCommands.push(name);
    },
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ killed: false, stdout: "", stderr: "" }),
  } as any;

  registerRalphCommands(pi, {} as any);
  registerRalphCommands(pi, {} as any);

  assert.deepEqual(registeredCommands, ["ralph", "ralph-draft", "ralph-list", "ralph-status", "ralph-resume", "ralph-archive", "ralph-stop", "ralph-cancel", "ralph-scaffold", "ralph-logs"]);
  assert.deepEqual(registeredEvents, [
    "thinking_level_select",
    "tool_call",
    "before_agent_start",
    "tool_result",
  ]);
});

test("runCommands keeps plain frontmatter commands in the repo cwd", async () => {
  const repoCwd = createTempDir();
  const taskDir = join(repoCwd, "task");
  mkdirSync(taskDir, { recursive: true });
  try {
    const originalCwd = process.cwd();
    const outputs = await runCommands(
      [
        { name: "pwd-a", run: "pwd", timeout: 1 },
        { name: "pwd-b", run: "pwd", timeout: 1 },
      ],
      [],
      {} as any,
      {},
      repoCwd,
      taskDir,
    );

    assert.deepEqual(outputs.map((output) => output.output), [realpathSync(repoCwd), realpathSync(repoCwd)]);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

test("runCommands runs ./-prefixed frontmatter commands from the task directory", async () => {
  const repoCwd = createTempDir();
  const taskDir = join(repoCwd, "task");
  mkdirSync(taskDir, { recursive: true });
  try {
    const originalCwd = process.cwd();
    mkdirSync(join(taskDir, "scripts"), { recursive: true });
    writeFileSync(join(taskDir, "scripts", "build"), "#!/bin/sh\npwd\n", { mode: 0o755 });

    const outputs = await runCommands([{ name: "build", run: "  ./scripts/build", timeout: 1 }], [], {} as any, {}, repoCwd, taskDir);

    assert.equal(outputs[0].output, realpathSync(taskDir));
    assert.equal(process.cwd(), originalCwd);
  } finally {
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

test("runCommands uses the semantic command form to choose taskDir for templated ./-prefixed args", async () => {
  const repoCwd = createTempDir();
  const taskDir = join(repoCwd, "task");
  mkdirSync(taskDir, { recursive: true });
  try {
    const originalCwd = process.cwd();
    mkdirSync(join(taskDir, "scripts"), { recursive: true });
    writeFileSync(join(taskDir, "scripts", "check.sh"), "#!/bin/sh\nprintf '%s %s' \"$PWD\" \"$1\"\n", { mode: 0o755 });

    const outputs = await runCommands(
      [{ name: "check", run: "{{ args.tool }} --flag", timeout: 1 }],
      [],
      {} as any,
      { tool: "./scripts/check.sh" },
      repoCwd,
      taskDir,
    );

    assert.equal(outputs[0].output, `${realpathSync(taskDir)} --flag`);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

test("runCommands surfaces blocked-command appendEntry failures", async () => {
  const repoCwd = createTempDir();
  const taskDir = join(repoCwd, "task");
  mkdirSync(taskDir, { recursive: true });
  try {
    const pi = {
      appendEntry: () => {
        throw new Error("append failed");
      },
      exec: async () => ({ killed: false, stdout: "", stderr: "" }),
    } as any;

    await assert.rejects(
      runCommands([{ name: "blocked", run: "git push origin main", timeout: 1 }], ["git\\s+push"], pi, {}, repoCwd, taskDir),
      /append failed/,
    );
  } finally {
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

test("runCommands suppresses stale blocked-command appendEntry failures", async () => {
  const repoCwd = createTempDir();
  const taskDir = join(repoCwd, "task");
  mkdirSync(taskDir, { recursive: true });
  const stderrWrites: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const pi = {
      appendEntry: () => {
        throw new Error("This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.");
      },
    } as any;

    const result = await runCommands([{ name: "blocked", run: "git push origin main", timeout: 1 }], ["git\\s+push"], pi, {}, repoCwd, taskDir);

    assert.deepEqual(result, [{ name: "blocked", output: "[blocked by guardrail: git\\s+push]", status: "blocked", blockedPattern: "git\\s+push", command: "git push origin main" }]);
    assert.equal(stderrWrites.some((entry) => entry.toLowerCase().includes("stale")), false);
  } finally {
    process.stderr.write = originalStderrWrite;
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

test("/ralph-stop writes the durable stop flag from persisted active loop state after reload", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const outsideDir = createTempDir();
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));

  const taskDir = join(cwd, "persisted-loop-task");
  mkdirSync(taskDir, { recursive: true });
  symlinkSync(outsideDir, join(cwd, ".ralph-runner"), "dir");
  const persistedState = {
    active: true,
    loopToken: "persisted-loop-token",
    cwd,
    taskDir,
    iteration: 3,
    maxIterations: 5,
    noProgressStreak: 0,
    iterationSummaries: [],
    guardrails: { blockCommands: [], protectedFiles: [] },
    stopRequested: false,
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  let ctx: any;
  ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: persistedState,
      },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), true);
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop stopping after current iteration")));
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("registry")));
  assert.equal(notifications.some(({ message }) => message.includes("No active ralph loop")), false);
});

test("/ralph-cancel writes the cancel flag from persisted active loop state after reload", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "persisted-loop-task");
  mkdirSync(taskDir, { recursive: true });
  const persistedState = {
    active: true,
    loopToken: "persisted-loop-token",
    cwd,
    taskDir,
    iteration: 3,
    maxIterations: 5,
    noProgressStreak: 0,
    iterationSummaries: [],
    guardrails: { blockCommands: [], protectedFiles: [] },
    stopRequested: false,
  };
  writeStatusFile(taskDir, {
    loopToken: persistedState.loopToken,
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 3,
    maxIterations: 5,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-cancel");
  let ctx: any;
  ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: persistedState,
      },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "cancel.flag")), true);
  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), false);
  assert.ok(notifications.some(({ message }) => message.includes("Cancel requested. The active iteration will be terminated immediately.")));
  assert.equal(notifications.some(({ message }) => message.includes("No active ralph loop")), false);
});

test("/ralph-cancel refuses when the loop already finished", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "finished-loop-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "finished-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "complete",
    currentIteration: 3,
    maxIterations: 5,
    timeout: 300,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-cancel");
  let ctx: any;
  ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          active: true,
          loopToken: "finished-loop-token",
          cwd,
          taskDir,
          iteration: 3,
          maxIterations: 5,
          noProgressStreak: 0,
          iterationSummaries: [],
          guardrails: { blockCommands: [], protectedFiles: [] },
          stopRequested: false,
        },
      },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "cancel.flag")), false);
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("The loop already ended with status: complete.")));
});

test("/ralph-cancel refuses when status is missing or belongs to a different run", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "missing-status-task");
  mkdirSync(taskDir, { recursive: true });
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-cancel");
  let ctx: any;
  ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          active: true,
          loopToken: "missing-status-loop-token",
          cwd,
          taskDir,
          iteration: 3,
          maxIterations: 5,
          noProgressStreak: 0,
          iterationSummaries: [],
          guardrails: { blockCommands: [], protectedFiles: [] },
          stopRequested: false,
        },
      },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "cancel.flag")), false);
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("No run data exists.")));

  writeStatusFile(taskDir, {
    loopToken: "newer-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  notifications.length = 0;
  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "cancel.flag")), false);
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("belongs to a different run")));
});

test("/ralph-scaffold creates a parseable scaffold from a task name", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task", ctx);

  const ralphPath = join(cwd, "my-task", "RALPH.md");
  assert.equal(existsSync(ralphPath), true);
  const inspection = inspectDraftContent(readFileSync(ralphPath, "utf8"));
  assert.equal(inspection.error, undefined);
  assert.equal(inspection.parsed?.frontmatter.maxIterations, 10);
  assert.equal(inspection.parsed?.frontmatter.timeout, 120);
  assert.deepEqual(inspection.parsed?.frontmatter.commands, []);
  assert.equal(inspection.parsed?.frontmatter.completionPromise, "DONE");
  assert.equal(inspection.parsed?.frontmatter.completionGate, "optional");
  assert.match(readFileSync(ralphPath, "utf8"), /# \{\{ ralph\.name \}\}/);
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Scaffolded")));
});

test("/ralph-scaffold accepts path-style arguments", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("feature/new-task", ctx);

  assert.equal(existsSync(join(cwd, "feature", "new-task", "RALPH.md")), true);
});

test("/ralph-scaffold accepts the current working directory path", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("./", ctx);

  assert.equal(existsSync(join(cwd, "RALPH.md")), true);
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Scaffolded")));
});

test("/ralph-scaffold supports bundled presets", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("--preset fix-tests my-task", ctx);

  const ralphPath = join(cwd, "my-task", "RALPH.md");
  const inspection = inspectDraftContent(readFileSync(ralphPath, "utf8"));
  assert.equal(existsSync(ralphPath), true);
  assert.equal(inspection.error, undefined);
  assert.deepEqual(inspection.parsed?.frontmatter.commands.map((command) => command.name), ["tests", "typecheck"]);
  assert.equal(inspection.parsed?.frontmatter.completionPromise, "DONE");
  assert.equal(inspection.parsed?.frontmatter.completionGate, "optional");
  assert.match(readFileSync(ralphPath, "utf8"), /You are fixing failing tests/);
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Scaffolded")));
});

test("/ralph-scaffold rejects unknown presets", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("--preset unknown my-task", ctx);

  assert.deepEqual(notifications, [{ message: 'Unknown scaffold preset "unknown". Available presets: fix-tests, migration, research-report, security-audit.', level: "error" }]);
  assert.equal(existsSync(join(cwd, "my-task", "RALPH.md")), false);
});

test("/ralph-scaffold accepts quoted path-style arguments", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler('"feature/new task"', ctx);

  assert.equal(existsSync(join(cwd, "feature", "new task", "RALPH.md")), true);
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Scaffolded")));
});

test("/ralph-scaffold rejects quoted traversal attempts", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler('"../escape"', ctx);

  assert.equal(existsSync(join(cwd, "..", "escape", "RALPH.md")), false);
  assert.deepEqual(notifications, [{ message: "Task path must be within the current working directory.", level: "error" }]);
});

test("/ralph-scaffold rejects unterminated quotes", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler('"broken', ctx);

  assert.deepEqual(notifications, [{ message: "Unterminated quote in /ralph-scaffold arguments.", level: "error" }]);
});

test("/ralph-scaffold rejects symlinked child directories inside the current working directory", async (t) => {
  const cwd = createTempDir();
  const outsideDir = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));

  symlinkSync(outsideDir, join(cwd, "linked-outside"));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("linked-outside/task", ctx);

  assert.equal(existsSync(join(outsideDir, "task", "RALPH.md")), false);
  assert.deepEqual(notifications, [{ message: "Task path must be within the current working directory.", level: "error" }]);
});

test("/ralph-scaffold rejects paths outside the current working directory", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const escapedTaskDir = join(cwd, "..", "escape");
  t.after(() => rmSync(escapedTaskDir, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("../escape", ctx);

  assert.equal(existsSync(join(escapedTaskDir, "RALPH.md")), false);
  assert.deepEqual(notifications, [{ message: "Task path must be within the current working directory.", level: "error" }]);
});

test("/ralph-scaffold refuses to overwrite an existing RALPH.md", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task", ctx);

  assert.equal(readFileSync(ralphPath, "utf8"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n");
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("already exists at")));
});

test("/ralph-scaffold requires a task name", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-scaffold");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("   ", ctx);

  assert.deepEqual(notifications, [{ message: "/ralph-scaffold expects a task name or path.", level: "error" }]);
});

test("/ralph-logs exports artifacts and static report from a task with .ralph-runner/", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "transcripts"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), "{\"iteration\":1}\n{\"iteration\":2}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), "{\"event\":1}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "final-summary.md"), "# Stale previous summary\nsecret stale data\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "one.txt"), "one", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "two.txt"), "two", "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported --report", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(existsSync(join(exportedDir, "status.json")), true);
  assert.equal(readFileSync(join(exportedDir, "iterations.jsonl"), "utf8"), "{\"iteration\":1}\n{\"iteration\":2}\n");
  assert.equal(readFileSync(join(exportedDir, "events.jsonl"), "utf8"), "{\"event\":1}\n");
  const exportedSummary = readFileSync(join(exportedDir, "final-summary.md"), "utf8");
  assert.match(exportedSummary, /# Ralph Run Summary/);
  assert.doesNotMatch(exportedSummary, /Stale previous summary|secret stale data/);
  assert.equal(readFileSync(join(exportedDir, "transcripts", "one.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(exportedDir, "transcripts", "two.txt"), "utf8"), "two");
  const reportHtml = readFileSync(join(exportedDir, "report.html"), "utf8");
  assert.match(reportHtml, /Ralph Loop Dossier/);
  assert.match(reportHtml, /href="transcripts\/one\.txt"/);
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Exported 2 iteration records, 1 events, 2 transcripts to ./exported with static report ./exported/report.html")));
});

test("/ralph-logs fails when no .ralph-runner/ exists", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task", ctx);

  assert.ok(notifications.some(({ message, level }) => level === "error" && message.startsWith("Log export failed: No .ralph-runner directory found at ")));
});

test("parseLogExportArgs parses --dest and quoted paths correctly", () => {
  assert.deepEqual(parseLogExportArgs("my-task --dest exported"), { path: "my-task", dest: "exported" });
  assert.deepEqual(parseLogExportArgs("my-task --dest exported --report"), { path: "my-task", dest: "exported", report: true });
  assert.deepEqual(parseLogExportArgs('"my task" --dest "export dir"'), { path: "my task", dest: "export dir" });
  assert.deepEqual(parseLogExportArgs('"unterminated'), { error: "Unterminated quote in /ralph-logs arguments." });
});

test("parseStatusCommandArgs treats --summary as an unquoted flag only", () => {
  assert.deepEqual(parseStatusCommandArgs("my-task --summary"), { value: "my-task", summary: true });
  assert.deepEqual(parseStatusCommandArgs('"my task" --summary'), { value: "my task", summary: true });
  assert.deepEqual(parseStatusCommandArgs('"my task --summary"'), { value: "my task --summary", summary: false });
  assert.deepEqual(parseStatusCommandArgs('"unterminated'), { value: "", summary: false, error: "Unterminated quote in /ralph-status arguments." });
});

test("parseRalphStartArgs removes only an unquoted standalone parallel flag", () => {
  assert.deepEqual(parseRalphStartArgs('--path="my task/RALPH.md"'), {
    value: '--path="my task/RALPH.md"',
    parallel: false,
  });
  assert.deepEqual(parseRalphStartArgs('--parallel --path="my task/RALPH.md"'), {
    value: ' --path="my task/RALPH.md"',
    parallel: true,
  });
  assert.deepEqual(parseRalphStartArgs('"--parallel" --task="literal flag"'), {
    value: '"--parallel" --task="literal flag"',
    parallel: false,
  });
  assert.deepEqual(parseRalphStartArgs('--parallel "unterminated'), {
    value: '--parallel "unterminated',
    parallel: false,
    error: "Unterminated quote in /ralph arguments.",
  });
});

test("/ralph-logs generates final-summary instead of copying symlinked stale artifacts", async (t) => {
  const cwd = createTempDir();
  const outside = createTempDir();
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(outside, "secret-summary.md"), "secret", "utf8");
  symlinkSync(join(outside, "secret-summary.md"), join(taskDir, ".ralph-runner", "final-summary.md"));

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(existsSync(join(exportedDir, "status.json")), true);
  const exportedSummary = readFileSync(join(exportedDir, "final-summary.md"), "utf8");
  assert.match(exportedSummary, /# Ralph Run Summary/);
  assert.doesNotMatch(exportedSummary, /secret/);
});

test("/ralph-logs rejects symlinked destination parent path segments", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  const outside = join(cwd, "outside");
  mkdirSync(join(outside, "exported"), { recursive: true });
  symlinkSync(outside, join(cwd, "linked-parent"), "dir");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest linked-parent/exported", ctx);

  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Log export failed")));
  assert.equal(existsSync(join(outside, "exported", "status.json")), false);
});

test("/ralph-logs rejects source task paths reached through symlinked parents", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const realRoot = join(cwd, "real-root");
  const taskDir = join(realRoot, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  symlinkSync(realRoot, join(cwd, "linked-root"), "dir");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("linked-root/my-task --dest exported", ctx);

  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Log export failed")));
  assert.equal(existsSync(join(cwd, "exported", "status.json")), false);
});

test("/ralph-logs rejects non-empty destinations instead of using stale artifacts", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  mkdirSync(join(cwd, "exported"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(cwd, "exported", "iterations.jsonl"), "{\"stale\":true}\n", "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Export destination must be empty")));
  assert.equal(existsSync(join(cwd, "exported", "status.json")), false);
});

test("/ralph-logs rejects non-empty destination with symlinked final summary without overwriting it", async (t) => {
  const cwd = createTempDir();
  const outside = createTempDir();
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  mkdirSync(join(cwd, "exported"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "final-summary.md"), "# Safe summary\n", "utf8");
  const outsideFile = join(outside, "outside.md");
  writeFileSync(outsideFile, "do not overwrite", "utf8");
  symlinkSync(outsideFile, join(cwd, "exported", "final-summary.md"));

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  assert.equal(readFileSync(outsideFile, "utf8"), "do not overwrite");
});

test("/ralph-logs rejects non-empty destination with symlinked transcript without overwriting it", async (t) => {
  const cwd = createTempDir();
  const outside = createTempDir();
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "transcripts"), { recursive: true });
  mkdirSync(join(cwd, "exported", "transcripts"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "one.txt"), "safe transcript", "utf8");
  const outsideFile = join(outside, "outside.txt");
  writeFileSync(outsideFile, "do not overwrite", "utf8");
  symlinkSync(outsideFile, join(cwd, "exported", "transcripts", "one.txt"));

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  assert.equal(readFileSync(outsideFile, "utf8"), "do not overwrite");
});

test("parseLogExportArgs parses quoted paths with spaces", () => {
  assert.deepEqual(parseLogExportArgs('--path "task with spaces" --dest "out logs"'), { path: "task with spaces", dest: "out logs" });
});

test("/ralph-logs rejects non-empty destinations without overwriting files", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  const destDir = join(cwd, "exported");
  mkdirSync(destDir);
  writeFileSync(join(destDir, "status.json"), "important", "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  assert.equal(readFileSync(join(destDir, "status.json"), "utf8"), "important");
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Export destination must be empty")));
});

test("/ralph-logs rejects symlinked destinations without writing through them", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  const outsideDir = join(cwd, "outside");
  mkdirSync(join(taskDir, ".ralph-runner"), { recursive: true });
  mkdirSync(outsideDir);
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  symlinkSync(outsideDir, join(cwd, "exported"), "dir");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  assert.equal(existsSync(join(outsideDir, "status.json")), false);
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Unsafe export destination")));
});

test("/ralph-logs exports only records for the current loop token when status has one", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "transcripts"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "complete", loopToken: "current-token" }), "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), `${JSON.stringify({ iteration: 1, loopToken: "stale-token" })}\n${JSON.stringify({ iteration: 2, loopToken: "current-token" })}\n`, "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), `${JSON.stringify({ type: "iteration.completed", loopToken: "stale-token" })}\n${JSON.stringify({ type: "iteration.completed", loopToken: "current-token" })}\n`, "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "iteration-001-stale-token.md"), "stale", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "iteration-002-current-token.md"), "current", "utf8");

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(readFileSync(join(exportedDir, "iterations.jsonl"), "utf8"), `${JSON.stringify({ iteration: 2, loopToken: "current-token" })}\n`);
  assert.equal(readFileSync(join(exportedDir, "events.jsonl"), "utf8"), `${JSON.stringify({ type: "iteration.completed", loopToken: "current-token" })}\n`);
  assert.equal(existsSync(join(exportedDir, "transcripts", "iteration-001-stale-token.md")), false);
  assert.equal(readFileSync(join(exportedDir, "transcripts", "iteration-002-current-token.md"), "utf8"), "current");

});

test("/ralph-logs excludes runtime control files", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "active-loops"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), "{\"iteration\":1}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), "{\"event\":1}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "stop.flag"), "", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "cancel.flag"), "", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "active-loops", "nested.txt"), "skip me", "utf8");

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(existsSync(join(exportedDir, "stop.flag")), false);
  assert.equal(existsSync(join(exportedDir, "cancel.flag")), false);
  assert.equal(existsSync(join(exportedDir, "active-loops")), false);
});

test("/ralph-logs skips symlinked transcript entries", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "transcripts"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), "{\"iteration\":1}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), "{\"event\":1}\n", "utf8");
  writeFileSync(join(taskDir, "secret.txt"), "top secret", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "transcripts", "good.txt"), "good", "utf8");
  symlinkSync(join(taskDir, "secret.txt"), join(taskDir, ".ralph-runner", "transcripts", "leak.txt"));

  const harness = createHarness();
  const handler = harness.handler("ralph-logs");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
  };

  await handler("my-task --dest exported", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(existsSync(join(exportedDir, "transcripts", "good.txt")), true);
  assert.equal(existsSync(join(exportedDir, "transcripts", "leak.txt")), false);
});

test("/ralph reverse engineer this app with an injected llm-strengthened draft still shows review before start", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string }> = [];
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened");
  let runLoopCalls = 0;
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg });
      return draftPlan;
    },
    runRalphLoopFn: async () => {
      runLoopCalls += 1;
      assert.equal(existsSync(target.ralphPath), true, "draft file should be written before the loop starts");
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });

  const notifications: Array<{ message: string; level: string }> = [];
  let selectTitle = "";
  let selectOptions: string[] = [];
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        selectTitle = title;
        selectOptions = options;
        assert.deepEqual(draftCalls, [{ task, target, cwd }]);
        assert.equal(existsSync(target.ralphPath), false, "draft file should not exist before review acceptance");
        return "Start";
      },
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: true }),
  };

  await handler(task, ctx);

  assert.equal(draftCalls.length, 1);
  assert.equal(runLoopCalls, 1);
  assert.equal(existsSync(target.ralphPath), true);
  assert.match(selectTitle, /Mission Brief/);
  assert.deepEqual(selectOptions, ["Start", "Open RALPH.md", "Cancel"]);
  assert.equal(notifications.some(({ message }) => message.includes("Invalid RALPH.md")), false);
});

test("/ralph-draft with an injected fallback draft reviews and writes without surfacing model failure details", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string }> = [];
  const draftPlan = makeDraftPlan(task, target, "fallback");
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg });
      return draftPlan;
    },
  });

  let selectTitle = "";
  let selectOptions: string[] = [];
  const handler = harness.handler("ralph-draft");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        selectTitle = title;
        selectOptions = options;
        assert.deepEqual(draftCalls, [{ task, target, cwd }]);
        assert.equal(existsSync(target.ralphPath), false, "draft file should not exist before Save draft");
        return "Save draft";
      },
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => {
      throw new Error("/ralph-draft should not start the loop");
    },
    waitForIdle: async () => {
      throw new Error("/ralph-draft should not wait for idle");
    },
  };

  await handler(task, ctx);

  assert.equal(draftCalls.length, 1);
  assert.equal(existsSync(target.ralphPath), true);
  assert.match(selectTitle, /Mission Brief/);
  assert.match(selectTitle, /Task\s+reverse engineer this app/);
  assert.doesNotMatch(selectTitle, /fallback|source|provenance|model failure/i);
  assert.deepEqual(selectOptions, ["Save draft", "Open RALPH.md", "Cancel"]);
});

test("Mission Brief surface stays limited to the visible fields", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened");
  draftPlan.content = draftPlan.content
    .replace("max_iterations: 12", "max_iterations: 8")
    .replace("timeout: 300\n", "timeout: 45\ncompletion_promise: ready\n");
  const harness = createHarness({
    createDraftPlan: async () => draftPlan,
  });

  let brief = "";
  const handler = harness.handler("ralph-draft");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string) => {
        brief = title;
        return "Cancel";
      },
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(task, ctx);

  assert.match(brief, /^Mission Brief/m);
  assert.match(brief, /^Task$/m);
  assert.match(brief, /^File$/m);
  assert.match(brief, /^Suggested checks$/m);
  assert.match(brief, /^Finish behavior$/m);
  assert.match(brief, /- Stop after 8 iterations or \/ralph-stop/);
  assert.match(brief, /- Stop if an iteration exceeds 45s/);
  assert.match(brief, /- Stop early on <promise>ready<\/promise>/);
  assert.match(brief, /^Safety$/m);
  assert.doesNotMatch(brief, /source|fallback|provenance|model failure/i);
  assert.doesNotMatch(brief, /Draft status/);
});

test("natural-language drafting without UI warns and exits without creating a draft", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string }> = [];
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg });
      return makeDraftPlan(task, target, "llm-strengthened");
    },
  });

  const notifications: Array<{ message: string; level: string }> = [];
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not open review UI");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(task, ctx);

  assert.equal(draftCalls.length, 0);
  assert.equal(existsSync(target.ralphPath), false);
  assert.deepEqual(notifications, [
    {
      level: "warning",
      message: "Draft review requires an interactive session. Use /ralph with a task folder or RALPH.md path instead.",
    },
  ]);
});

test("/ralph --path existing-task/RALPH.md bypasses the drafting pipeline", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string }> = [];
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened");
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg });
      return draftPlan;
    },
  });

  const existingDir = join(cwd, "existing-task");
  const existingRalphPath = join(existingDir, "RALPH.md");
  await t.test("setup", () => undefined);
  await import("node:fs").then(({ mkdirSync, writeFileSync }) => {
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(existingRalphPath, draftPlan.content, "utf8");
  });

  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      select: async () => {
        throw new Error("should not show review UI for existing RALPH.md");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${existingRalphPath}`, ctx);

  assert.equal(draftCalls.length, 0);
});

test("/ralph --path preserves explicit thinking level from the active model", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened");
  const existingDir = join(cwd, "thinking-task");
  const existingRalphPath = join(existingDir, "RALPH.md");
  mkdirSync(existingDir, { recursive: true });
  writeFileSync(existingRalphPath, draftPlan.content, "utf8");

  const capturedConfigs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config: RunnerConfig) => {
      capturedConfigs.push(config);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });

  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      select: async () => {
        throw new Error("should not show review UI for existing RALPH.md");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await harness.event("thinking_level_select")({ level: "low" }, ctx);
  await handler(`--path ${existingRalphPath}`, ctx);

  assert.equal(capturedConfigs.length, 1);
  assert.equal(capturedConfigs[0].modelPattern, "anthropic/claude-sonnet-4-5");
  assert.equal(capturedConfigs[0].thinkingLevel, "low");
});

test("/ralph --path existing-task/RALPH.md with args resolves them safely at runtime", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "arg-task");
  const ralphPath = join(taskDir, "RALPH.md");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    ralphPath,
    [
      "---",
      "args:",
      "  - owner",
      "commands:",
      "  - name: greet",
      "    run: echo {{ args.owner }}",
      "    timeout: 1",
      "max_iterations: 1",
      "timeout: 1",
      "guardrails:",
      "  block_commands: []",
      "  protected_files: []",
      "---",
      "Hello {{ args.owner }}",
    ].join("\n"),
    "utf8",
  );

  const execCalls: string[] = [];
  let observedRuntimeArgs: Record<string, string> | undefined;
  const harness = createHarness({
    exec: async (_tool: string, args: string[]) => {
      execCalls.push(args.join(" "));
      return { killed: false, stdout: "hello Ada", stderr: "" };
    },
    runRalphLoopFn: async (config: RunnerConfig) => {
      observedRuntimeArgs = config.runtimeArgs;
      await config.runCommandsFn?.(
        [{ name: "greet", run: "echo {{ args.owner }}", timeout: 1 }],
        { blockCommands: [], protectedFiles: [] },
        config.pi,
        config.cwd,
        dirname(config.ralphPath),
        config.runtimeArgs ?? {},
      );
      return {
        status: "complete",
        iterations: [
          {
            iteration: 1,
            status: "complete",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 0,
            progress: false,
            changedFiles: [],
            noProgressStreak: 0,
          },
        ],
        totalDurationMs: 0,
      };
    },
  });

  const handler = harness.handler("ralph");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${ralphPath} --arg owner=Ada`, ctx);

  assert.equal(Object.getPrototypeOf(observedRuntimeArgs), null);
  assert.deepEqual({ ...observedRuntimeArgs }, { owner: "Ada" });
  assert.deepEqual(execCalls, ["-c echo 'Ada'"]);
  assert.equal(notifications.some(({ message }) => message.includes("Invalid RALPH.md")), false);
});

test("/ralph keeps runtime args local to concurrent start handlers", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const targets = ["first-arg-task", "second-arg-task"].map((name) => {
    const taskDir = join(cwd, name);
    const ralphPath = join(taskDir, "RALPH.md");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      ralphPath,
      [
        "---",
        "args:",
        "  - owner",
        "commands: []",
        "max_iterations: 1",
        "timeout: 1",
        "guardrails:",
        "  block_commands: []",
        "  protected_files: []",
        "---",
        "Hello {{ args.owner }}",
      ].join("\n"),
      "utf8",
    );
    return { taskDir, ralphPath };
  });

  const configs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config) => {
      configs.push(config);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };
  const handler = harness.handler("ralph");

  await Promise.all([
    handler(`--path ${targets[0].ralphPath} --arg owner=first`, ctx),
    handler(`--parallel --path ${targets[1].ralphPath} --arg owner=second`, ctx),
  ]);

  assert.deepEqual(
    configs.map((config) => ({ ralphPath: config.ralphPath, owner: config.runtimeArgs?.owner })),
    [
      { ralphPath: targets[0].ralphPath, owner: "first" },
      { ralphPath: targets[1].ralphPath, owner: "second" },
    ],
  );
});

test("/ralph --path existing-task/RALPH.md rejects missing and extra args", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "arg-task");
  const ralphPath = join(taskDir, "RALPH.md");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    ralphPath,
    [
      "---",
      "args:",
      "  - owner",
      "commands:",
      "  - name: greet",
      "    run: echo {{ args.owner }}",
      "    timeout: 1",
      "max_iterations: 1",
      "timeout: 1",
      "guardrails:",
      "  block_commands: []",
      "  protected_files: []",
      "---",
      "Hello {{ args.owner }}",
    ].join("\n"),
    "utf8",
  );

  const harness = createHarness({
    runRalphLoopFn: async () => {
      throw new Error("loop should not start when args are invalid");
    },
  });
  const handler = harness.handler("ralph");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${ralphPath}`, ctx);
  await handler(`--path ${ralphPath} --arg extra=value`, ctx);

  assert.deepEqual(notifications, [
    { level: "error", message: "Missing required arg: owner" },
    { level: "error", message: "Undeclared arg: extra" },
  ]);
});

test("/ralph --task ... --arg ... is rejected", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const harness = createHarness({
    runRalphLoopFn: async () => {
      throw new Error("loop should not start");
    },
  });
  const handler = harness.handler("ralph");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("--task reverse engineer auth --arg owner=Ada", ctx);

  assert.deepEqual(notifications, [
    { level: "error", message: "--arg is only supported with /ralph --path" },
  ]);
});

test("/ralph-draft rejects runtime args for now", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const harness = createHarness({
    runRalphLoopFn: async () => {
      throw new Error("loop should not start");
    },
  });
  const handler = harness.handler("ralph-draft");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("--path task-folder --arg owner=Ada", ctx);

  assert.deepEqual(notifications, [
    { level: "error", message: "--arg is only supported with /ralph --path" },
  ]);
});

test("/ralph rejects raw invalid completion_promise values before parsing loop state", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const targetDir = join(cwd, "raw-invalid-completion-promise");
  const ralphPath = join(targetDir, "RALPH.md");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    ralphPath,
    [
      "---",
      "commands:",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 20",
      "max_iterations: 2",
      "timeout: 300",
      "completion_promise: |",
      "  DONE",
      "guardrails:",
      "  block_commands: []",
      "  protected_files: []",
      "---",
      "Task: Fix flaky auth tests",
      "",
      "Keep the change small.",
    ].join("\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  let newSessionCalls = 0;
  let execCalls = 0;
  const harness = createHarness({
    exec: async () => {
      execCalls += 1;
      return { killed: false, stdout: "ok", stderr: "" };
    },
  });
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => {
        throw new Error("should not prompt");
      },
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: true };
    },
    waitForIdle: async () => {
      throw new Error("should not reach the loop");
    },
  };

  await handler(`--path ${ralphPath}`, ctx);

  assert.equal(newSessionCalls, 0);
  assert.equal(execCalls, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "error");
  assert.match(notifications[0]?.message ?? "", /Invalid completion_promise/);
});

test("/ralph --path waits for the loop promise before returning in noninteractive mode", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "Fix flaky auth tests";
  const target = createTarget(cwd, task);
  const draft = generateDraft(task, target, {
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");

  let loopStarted = false;
  let resolveLoop: (() => void) | undefined;
  const loopFinished = new Promise<void>((resolve) => {
    resolveLoop = resolve;
  });
  t.after(() => resolveLoop?.());
  const harness = createHarness({
    runRalphLoopFn: async () => {
      loopStarted = true;
      await loopFinished;
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  let handlerResolved = false;
  const handlerPromise = handler(`--path ${target.ralphPath}`, ctx).then(() => {
    handlerResolved = true;
  });

  for (let i = 0; i < 10 && !loopStarted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(loopStarted, true);
  assert.equal(handlerResolved, false);

  resolveLoop?.();
  await handlerPromise;

  assert.equal(handlerResolved, true);
});

test("/ralph removes a run handle when its initial UI update fails", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = createTarget(cwd, "Recover from stale UI");
  const draft = generateDraft(target.slug, target, {
    packageManager: "npm",
    testCommand: "npm test",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");

  const configs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config) => {
      configs.push(config);
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const notifications: string[] = [];
  const sessionManager = createSessionManager([], "session-a");
  const makeCtx = (setStatus: () => void) => ({
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus,
      setWidget: () => undefined,
    },
    sessionManager,
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  });
  const handler = harness.handler("ralph");

  await handler(`--path ${target.ralphPath}`, makeCtx(() => {
    throw new Error("stale UI");
  }));
  await handler(`--path ${target.ralphPath}`, makeCtx(() => undefined));

  assert.equal(configs.length, 1);
  assert.ok(notifications.some((message) => message.includes("stale UI")));
});

test("/ralph persists terminal state when its final UI update fails", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = createTarget(cwd, "Persist after stale final UI");
  const draft = generateDraft(target.slug, target, {
    packageManager: "npm",
    testCommand: "npm test",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");
  const harness = createHarness({
    runRalphLoopFn: async () => ({ status: "complete", iterations: [], totalDurationMs: 0 }),
  });
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: (_key: string, text: string | undefined) => {
        if (text === undefined) throw new Error("stale final UI");
      },
      setWidget: () => undefined,
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await harness.handler("ralph")(`--path ${target.ralphPath}`, ctx);

  const terminalEntry = harness.appendedEntries.findLast((entry) => entry?.customType === "ralph-loop-state");
  assert.equal(terminalEntry?.data?.active, false);
});

test("/ralph requires durable parallel consent and refuses mixed-source lifecycle ambiguity", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const durableTarget = createTarget(cwd, "Durable active task");
  const requestedTarget = createTarget(cwd, "Requested task");
  mkdirSync(durableTarget.dirPath, { recursive: true });
  mkdirSync(requestedTarget.dirPath, { recursive: true });
  const draft = generateDraft(requestedTarget.slug, requestedTarget, {
    packageManager: "npm",
    testCommand: "npm test",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  writeFileSync(requestedTarget.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");
  const now = new Date().toISOString();
  writeActiveLoopRegistryEntry(cwd, {
    taskDir: durableTarget.dirPath,
    ralphPath: durableTarget.ralphPath,
    cwd,
    loopToken: "durable-active-token",
    status: "running",
    currentIteration: 1,
    maxIterations: 2,
    startedAt: now,
    updatedAt: now,
  });

  const runStarted = Promise.withResolvers<void>();
  const runRelease = Promise.withResolvers<void>();
  t.after(() => runRelease.resolve());

  const configs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config) => {
      configs.push(config);
      runStarted.resolve();
      await runRelease.promise;
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("noninteractive starts must not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };
  const handler = harness.handler("ralph");

  await handler(`--path ${requestedTarget.ralphPath}`, ctx);
  assert.equal(configs.length, 0);
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("--parallel")));

  const runPromise = handler(`--parallel --path ${requestedTarget.ralphPath}`, ctx);
  await runStarted.promise;
  assert.equal(configs.length, 1);

  await harness.handler("ralph-status")("", ctx);
  await harness.handler("ralph-stop")("", ctx);
  await harness.handler("ralph-cancel")("", ctx);
  assert.equal(notifications.filter(({ message, level }) => level === "error" && message.includes("Multiple active")).length, 3);
  assert.equal(checkStopSignal(requestedTarget.dirPath), false);
  assert.equal(checkCancelSignal(requestedTarget.dirPath), false);

  runRelease.resolve();
  await runPromise;
});

test("/ralph requires --parallel for a second noninteractive run and keeps both runs independent", { timeout: 2000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const firstTarget = createTarget(cwd, "First parallel task");
  const secondTarget = createTarget(cwd, "Second parallel task");
  for (const target of [firstTarget, secondTarget]) {
    const draft = generateDraft(target.slug, target, {
      packageManager: "npm",
      testCommand: "npm test",
      hasGit: true,
      topLevelDirs: ["src", "tests"],
      topLevelFiles: ["package.json"],
    });
    mkdirSync(target.dirPath, { recursive: true });
    writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");
  }

  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  t.after(() => {
    firstRelease.resolve();
    secondRelease.resolve();
  });

  const runConfigs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config) => {
      runConfigs.push(config);
      if (config.ralphPath === firstTarget.ralphPath) {
        firstStarted.resolve();
        await firstRelease.promise;
      } else {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    cwd,
    hasUI: false,
    model: { provider: "provider", id: "first-model" },
    thinkingLevel: "low",
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("noninteractive starts must not prompt");
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };
  const handler = harness.handler("ralph");
  const publishIteration = (config: RunnerConfig, changedFile: string) => {
    const timestamp = "2026-07-10T00:00:00.000Z";
    config.onStatusChange?.("running");
    config.onIterationComplete?.({
      iteration: 1,
      status: "complete",
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
      progress: true,
      changedFiles: [changedFile],
      noProgressStreak: 0,
    });
  };

  const firstRun = handler(`--path ${firstTarget.ralphPath}`, ctx);
  await firstStarted.promise;
  ctx.model.id = "second-model";
  ctx.thinkingLevel = "high";

  await handler(`--parallel --path ${firstTarget.ralphPath}`, ctx);
  assert.equal(runConfigs.length, 1);
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("already active")));
  const firstAlias = join(cwd, "first-task-alias");
  symlinkSync(firstTarget.dirPath, firstAlias, "dir");
  await handler(`--parallel --path ${join(firstAlias, "RALPH.md")}`, ctx);
  assert.equal(runConfigs.length, 1);


  await handler(`--path ${secondTarget.ralphPath}`, ctx);
  assert.equal(runConfigs.length, 1);
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("--parallel")));

  const secondRun = handler(`--parallel --path ${secondTarget.ralphPath}`, ctx);
  const secondOutcome = await Promise.race([
    secondStarted.promise.then(() => "started" as const),
    secondRun.then(() => "returned" as const),
  ]);
  assert.equal(secondOutcome, "started");
  assert.equal(runConfigs.length, 2);
  assert.deepEqual(runConfigs.map(({ modelPattern }) => modelPattern), ["provider/first-model", "provider/second-model"]);
  assert.deepEqual(runConfigs.map(({ thinkingLevel }) => thinkingLevel), ["low", "high"]);
  assert.ok(statuses.some((text) => text === "Ralph: 2 active"));
  assert.ok(widgets.some((lines) => lines?.length === 2));
  publishIteration(runConfigs[1], "second.txt");
  assert.ok(widgets.at(-1)?.some((line) => line.includes(secondTarget.slug) && line.includes("1/1")));
  assert.ok(widgets.at(-1)?.some((line) => line.includes(firstTarget.slug) && line.includes("0/1")));


  const parentGuardrailResult = await harness.event("tool_call")(
    { toolName: "write", input: { path: "src/generated/output.ts" } },
    {
      sessionManager: {
        getEntries: () => [{
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken: "latest-run",
            iteration: 1,
            guardrails: { blockCommands: [], protectedFiles: ["src/generated/**"] },
          },
        }],
      },
    },
  );
  assert.equal(parentGuardrailResult, undefined);

  await harness.handler("ralph-status")("", ctx);
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Multiple active")));

  await harness.handler("ralph-stop")(`--path ${secondTarget.ralphPath}`, ctx);
  assert.equal(checkStopSignal(secondTarget.dirPath), true);
  assert.equal(checkStopSignal(firstTarget.dirPath), false);

  await harness.handler("ralph-cancel")("", ctx);
  assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("Multiple active")));

  await harness.handler("ralph-cancel")(`--path ${firstTarget.ralphPath}`, ctx);
  assert.equal(checkCancelSignal(firstTarget.dirPath), true);
  assert.equal(checkCancelSignal(secondTarget.dirPath), false);

  secondRelease.resolve();
  await secondRun;
  publishIteration(runConfigs[0], "first.txt");
  assert.equal(statuses.at(-1), `Ralph: ${firstTarget.slug} — running (1/1)`);
  assert.equal(widgets.at(-1), undefined);

  firstRelease.resolve();
  await firstRun;

  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
});

test("/ralph confirms an interactive parallel start and picks the requested run", { timeout: 2000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const firstTarget = createTarget(cwd, "Interactive first task");
  const secondTarget = createTarget(cwd, "Interactive second task");
  const durableTarget = createTarget(cwd, "Interactive durable task");
  for (const target of [firstTarget, secondTarget]) {
    const draft = generateDraft(target.slug, target, {
      packageManager: "npm",
      testCommand: "npm test",
      hasGit: true,
      topLevelDirs: ["src", "tests"],
      topLevelFiles: ["package.json"],
    });
    mkdirSync(target.dirPath, { recursive: true });
    writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");
  }
  mkdirSync(durableTarget.dirPath, { recursive: true });

  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  const firstInactive = Promise.withResolvers<void>();
  const secondInactive = Promise.withResolvers<void>();
  let firstReleased = false;
  let secondReleased = false;
  const releaseFirst = () => {
    firstReleased = true;
    firstRelease.resolve();
  };
  const releaseSecond = () => {
    secondReleased = true;
    secondRelease.resolve();
  };
  t.after(() => {
    releaseFirst();
    releaseSecond();
  });

  const configs: RunnerConfig[] = [];
  const harness = createHarness({
    appendEntry: (customType, data) => {
      if (
        customType !== "ralph-loop-state"
        || !data
        || typeof data !== "object"
        || !("active" in data)
        || data.active !== false
        || !("loopToken" in data)
      ) return;
      if (data.loopToken === configs[0]?.loopToken) firstInactive.resolve();
      if (data.loopToken === configs[1]?.loopToken) secondInactive.resolve();
    },
    runRalphLoopFn: async (config) => {
      configs.push(config);
      if (config.ralphPath === firstTarget.ralphPath) {
        firstStarted.resolve();
        await firstRelease.promise;
      } else {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const prompts: string[] = [];
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async (title: string, options: string[]) => {
        prompts.push(title);
        if (title.includes("/ralph-stop")) {
          return options.find((option) => option.includes(secondTarget.slug));
        }
        if (title.includes("/ralph-cancel")) {
          return options.find((option) => option.includes(durableTarget.slug));
        }
        return "Start in parallel";
      },
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await harness.handler("ralph")(`--path ${firstTarget.ralphPath}`, ctx);
  await firstStarted.promise;
  assert.equal(firstReleased, false);

  await harness.handler("ralph")(`--path ${secondTarget.ralphPath}`, ctx);
  await secondStarted.promise;
  assert.equal(secondReleased, false);
  assert.ok(prompts.some((prompt) => prompt.includes("does not lock files")));
  assert.equal(configs.length, 2);
  assert.notEqual(configs[0]?.loopToken, configs[1]?.loopToken);
  assert.ok(statuses.some((status) => status === "Ralph: 2 active"));

  const now = new Date().toISOString();
  writeActiveLoopRegistryEntry(cwd, {
    taskDir: durableTarget.dirPath,
    ralphPath: durableTarget.ralphPath,
    cwd,
    loopToken: "interactive-durable-token",
    status: "running",
    currentIteration: 1,
    maxIterations: 3,
    startedAt: now,
    updatedAt: now,
  });

  await harness.handler("ralph-stop")("", ctx);
  assert.equal(checkStopSignal(secondTarget.dirPath), true);
  assert.equal(checkStopSignal(firstTarget.dirPath), false);
  assert.ok(prompts.some((prompt) => prompt.includes("/ralph-stop")));
  await harness.handler("ralph-cancel")("", ctx);
  assert.equal(checkCancelSignal(durableTarget.dirPath), true);
  assert.equal(checkCancelSignal(firstTarget.dirPath), false);
  assert.equal(checkCancelSignal(secondTarget.dirPath), false);
  assert.ok(prompts.some((prompt) => prompt.includes("/ralph-cancel")));

  releaseSecond();
  await secondInactive.promise;
  assert.equal(statuses.at(-1), `Ralph: ${firstTarget.slug} — initializing (0/1)`);
  assert.equal(widgets.at(-1), undefined);

  releaseFirst();
  await firstInactive.promise;
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
});
test("/ralph observes interactive background finalizer failures and cleans up", { timeout: 2000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = createTarget(cwd, "Background failure");
  const draft = generateDraft(target.slug, target, {
    packageManager: "npm",
    testCommand: "npm test",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");

  const runStarted = Promise.withResolvers<void>();
  const runResult = Promise.withResolvers<RunnerResult>();
  const inactive = Promise.withResolvers<void>();
  const stderrObserved = Promise.withResolvers<void>();
  let runCalls = 0;
  const notifications: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  t.after(() => {
    process.stderr.write = originalStderrWrite;
    runResult.reject(new Error("test cleanup"));
  });
  process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
    if (String(chunk) === "Ralph background run failed unexpectedly: notification failed\n") {
      stderrObserved.resolve();
    }
    return true;
  }) as typeof process.stderr.write;

  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const harness = createHarness({
    appendEntry: (customType, data) => {
      if (customType === "ralph-loop-state" && data && typeof data === "object" && "active" in data && data.active === false) {
        inactive.resolve();
        throw new Error("append failed");
      }
    },
    runRalphLoopFn: async () => {
      runCalls += 1;
      if (runCalls > 1) return { status: "complete", iterations: [], totalDurationMs: 0 };
      runStarted.resolve();
      return runResult.promise;
    },
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
        if (message.startsWith("Ralph loop failed:")) throw new Error("notification failed");
      },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await harness.handler("ralph")(`--path ${target.ralphPath}`, ctx);
  await runStarted.promise;
  runResult.reject(new Error("runner failed"));
  await Promise.all([inactive.promise, stderrObserved.promise]);

  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
  await harness.handler("ralph")(`--path ${target.ralphPath}`, ctx);
  assert.equal(runCalls, 2);
  assert.equal(notifications.some((message) => message.includes("already active")), false);
});

test("/ralph keeps every active run on successive replacement contexts", { timeout: 2000 }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const firstTarget = createTarget(cwd, "Replacement first task");
  const secondTarget = createTarget(cwd, "Replacement second task");
  for (const target of [firstTarget, secondTarget]) {
    const draft = generateDraft(target.slug, target, {
      packageManager: "npm",
      testCommand: "npm test",
      hasGit: true,
      topLevelDirs: ["src", "tests"],
      topLevelFiles: ["package.json"],
    });
    mkdirSync(target.dirPath, { recursive: true });
    writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");
  }

  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  t.after(() => {
    firstRelease.resolve();
    secondRelease.resolve();
  });

  const configs: RunnerConfig[] = [];
  const harness = createHarness({
    runRalphLoopFn: async (config) => {
      configs.push(config);
      if (config.ralphPath === firstTarget.ralphPath) {
        firstStarted.resolve();
        await firstRelease.promise;
      } else {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  });
  const baseNotifications: string[] = [];
  const firstNotifications: string[] = [];
  const secondNotifications: string[] = [];
  const makeUi = (notifications: string[]) => ({
    notify: (message: string) => notifications.push(message),
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  });
  const sessionManager = createSessionManager([], "session-a");
  const secondCtx = {
    cwd,
    hasUI: false,
    ui: makeUi(secondNotifications),
    sessionManager,
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };
  const firstCtx = {
    cwd,
    hasUI: false,
    ui: makeUi(firstNotifications),
    sessionManager,
    newSession: async (options?: { withSession?: (replacementCtx: typeof secondCtx) => Promise<void> | void }) => {
      await options?.withSession?.(secondCtx);
      return { cancelled: false };
    },
    waitForIdle: async () => undefined,
  };
  const baseCtx = {
    getRuntimeCtx: () => undefined,
    cwd,
    hasUI: false,
    ui: makeUi(baseNotifications),
    sessionManager,
    newSession: async (options?: { withSession?: (replacementCtx: typeof firstCtx) => Promise<void> | void }) => {
      await options?.withSession?.(firstCtx);
      return { cancelled: false };
    },
    waitForIdle: async () => undefined,
  };

  const firstRun = harness.handler("ralph")(`--path ${firstTarget.ralphPath}`, baseCtx);
  await firstStarted.promise;
  const secondRun = harness.handler("ralph")(`--parallel --path ${secondTarget.ralphPath}`, baseCtx);
  await secondStarted.promise;

  await baseCtx.newSession({ withSession: async () => undefined });
  await firstCtx.newSession({ withSession: async () => undefined });
  for (const config of configs) config.onNotify?.("after-second-replacement", "info");

  assert.deepEqual(
    {
      base: baseNotifications.filter((message) => message.includes("after-second-replacement")),
      first: firstNotifications.filter((message) => message.includes("after-second-replacement")),
      second: secondNotifications.filter((message) => message.includes("after-second-replacement")),
    },
    {
      base: [],
      first: [],
      second: [
        "[replacement-first-task] after-second-replacement",
        "[replacement-second-task] after-second-replacement",
      ],
    },
  );

  secondRelease.resolve();
  firstRelease.resolve();
  await Promise.all([firstRun, secondRun]);
});

test("/ralph --path keeps using the live command context after session replacement", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "Fix flaky auth tests";
  const target = createTarget(cwd, task);
  const draft = generateDraft(task, target, {
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 1"), "utf8");

  const staleNotifications: Array<{ message: string; level: string }> = [];
  const staleStatuses: Array<{ key: string; text: string | undefined }> = [];
  const liveNotifications: Array<{ message: string; level: string }> = [];
  const liveStatuses: Array<{ key: string; text: string | undefined }> = [];
  const appendedEntries: Array<any> = [];
  const stderrWrites: string[] = [];
  let stale = false;
  let resolveLoop: (() => void) | undefined;
  const loopFinished = new Promise<void>((resolve) => {
    resolveLoop = resolve;
  });
  t.after(() => resolveLoop?.());

  const liveReplacementCtx = {
    sendMessage: async () => undefined,
    sendUserMessage: async () => undefined,
    ui: {
      notify: (message: string, level: string) => {
        liveNotifications.push({ message, level });
      },
      setStatus: (key: string, text: string | undefined) => {
        liveStatuses.push({ key, text });
      },
      input: async () => undefined,
      select: async () => undefined,
      editor: async () => undefined,
    },
  };

  const userWithSession = async (replacementCtx: typeof liveReplacementCtx) => {
    assert.equal(replacementCtx, liveReplacementCtx);
    assert.equal(typeof replacementCtx.sendMessage, "function");
    assert.equal(typeof replacementCtx.sendUserMessage, "function");
    assert.equal(replacementCtx.ui, liveReplacementCtx.ui);
  };

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  t.after(() => {
    (process.stderr as any).write = originalStderrWrite;
  });

  const handlers = new Map<string, (args: string, ctx: any) => Promise<any>>();
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<any> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      if (stale) {
        throw new Error("This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.");
      }
      appendedEntries.push({ type: "custom", customType, data });
    },
    sendUserMessage: async () => undefined,
    exec: async () => ({ killed: false, stdout: "", stderr: "" }),
  } as any;

  const runtimeUi = {
    notify: (message: string, level: string) => {
      if (stale) {
        throw new Error("stale runtime notify");
      }
      staleNotifications.push({ message, level });
    },
    setStatus: (key: string, text: string | undefined) => {
      if (stale) {
        throw new Error("stale runtime setStatus");
      }
      staleStatuses.push({ key, text });
    },
    input: async () => undefined,
    select: async () => undefined,
    editor: async () => undefined,
  };
  const runtimeSessionManager = createSessionManager([], "session-a");
  const ctx = {
    get cwd() {
      if (stale) {
        throw new Error("stale command cwd");
      }
      return cwd;
    },
    hasUI: false,
    get ui() {
      if (stale) {
        throw new Error("stale command ui");
      }
      return runtimeUi;
    },
    get sessionManager() {
      if (stale) {
        throw new Error("stale command sessionManager");
      }
      return runtimeSessionManager;
    },
    newSession: async (options?: { withSession?: (replacementCtx: typeof liveReplacementCtx) => Promise<void> | void }) => {
      assert.equal(typeof options?.withSession, "function");
      assert.notEqual(options?.withSession, userWithSession);
      stale = true;
      await options?.withSession?.(liveReplacementCtx);
      return { cancelled: false };
    },
    waitForIdle: async () => undefined,
  };
  const originalNewSession = ctx.newSession;

  let runLoopEntered = false;
  registerRalphCommands(pi, {
    runRalphLoopFn: async (config: RunnerConfig) => {
      config.onStatusChange?.("running");
      runLoopEntered = true;
      const result = await ctx.newSession({ withSession: userWithSession });
      assert.equal(result.cancelled, false);
      config.onNotify?.("rebound notification", "info");
      config.onIterationComplete?.({
        iteration: 1,
        status: "complete",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        progress: true,
        changedFiles: ["src/index.ts"],
        noProgressStreak: 0,
      } as IterationRecord);
      config.onStatusChange?.("complete");
      await loopFinished;
      return { status: "complete", iterations: [], totalDurationMs: 0 };
    },
  } as any);

  const handler = handlers.get("ralph");
  assert.ok(handler);

  let handlerResolved = false;
  const handlerPromise = handler(`--path ${target.ralphPath}`, ctx).then(() => {
    handlerResolved = true;
  });

  for (let i = 0; i < 10 && !runLoopEntered; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(runLoopEntered, true);
  assert.equal(handlerResolved, false);
  assert.ok(staleNotifications.some(({ message }) => message.includes("Ralph loop started:")));
  assert.ok(staleStatuses.some(({ text }) => text?.includes("running")));
  assert.ok(liveNotifications.some(({ message }) => message === "rebound notification"));
  assert.equal(appendedEntries.length, 0);

  resolveLoop?.();
  await handlerPromise;

  assert.equal(handlerResolved, true);
  assert.equal(ctx.newSession, originalNewSession);
  assert.equal(stale, true);
  assert.ok(liveNotifications.some(({ message }) => message.startsWith("Ralph loop complete:")));
  assert.ok(liveStatuses.some(({ text }) => text === undefined));
  assert.equal(appendedEntries.length, 0);
  assert.equal(stderrWrites.some((line) => /stale extension (?:ctx|context)/i.test(line)), false);
});

test("/ralph maps real runner completion, timeout, and unverified-progress outcomes", async (t) => {
  const scenarios: Array<{
    name: string;
    scriptBody: string;
    timeout: number;
    completionPromise?: string;
    expectedMessages: RegExp[];
    expectedLevel: string;
  }> = [
    {
      name: "completion promise",
      scriptBody: `echo "done" > "$RALPH_RUNNER_TASK_DIR/result.txt"
echo "none" > "$RALPH_RUNNER_TASK_DIR/OPEN_QUESTIONS.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise>"}]}]}'`,
      timeout: 5,
      completionPromise: "DONE",
      expectedMessages: [/Ralph loop complete:/],
      expectedLevel: "info",
    },
    {
      name: "timeout",
      scriptBody: "sleep 2",
      timeout: 1,
      expectedMessages: [/Ralph loop stopped after a timeout:/],
      expectedLevel: "warning",
    },
    {
      name: "no progress",
      scriptBody: `echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"not done"}]}]}'`,
      timeout: 5,
      expectedMessages: [/made no durable progress/, /exhausted without verified progress/],
      expectedLevel: "warning",
    },
    {
      name: "unverified progress",
      scriptBody: `head -c 2097153 /dev/zero > "$RALPH_RUNNER_TASK_DIR/oversized.bin"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"not done"}]}]}'`,
      timeout: 5,
      expectedMessages: [/durable progress could not be verified/, /exhausted without verified progress/],
      expectedLevel: "warning",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (st) => {
      const cwd = createTempDir();
      st.after(() => rmSync(cwd, { recursive: true, force: true }));

      const task = `Exercise ${scenario.name}`;
      const target = createTarget(cwd, task);
      const draft = generateDraft(task, target, {
        packageManager: "npm",
        testCommand: "npm test",
        hasGit: true,
        topLevelDirs: ["src", "tests"],
        topLevelFiles: ["package.json"],
      });
      let content = draft.content
        .replace("max_iterations: 25", "max_iterations: 1")
        .replace("timeout: 300", `timeout: ${scenario.timeout}`)
        .replace(/    timeout: \d+/g, `    timeout: ${scenario.timeout}`);
      if (scenario.completionPromise) {
        const requiredOutputsHeader = /^required_outputs:$/m;
        content = (
          requiredOutputsHeader.test(content)
            ? content.replace(requiredOutputsHeader, "required_outputs:\n  - result.txt")
            : content.replace(/^timeout:/m, "required_outputs:\n  - result.txt\n$&")
        ).replace(
          /^timeout: \d+$/m,
          `timeout: ${scenario.timeout}\ncompletion_promise: ${scenario.completionPromise}`,
        );
        assert.match(content, /^  - result\.txt$/m);
      }
      mkdirSync(target.dirPath, { recursive: true });
      writeFileSync(target.ralphPath, content, "utf8");

      const scriptPath = join(target.dirPath, "mock-pi.sh");
      writeFileSync(
        scriptPath,
        `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
${scenario.scriptBody}
`,
        { mode: 0o755 },
      );

      const notifications: Array<{ message: string; level: string }> = [];
      const harness = createHarness({
        runRalphLoopFn: async (config) => realRunRalphLoop({
          ...config,
          spawnCommand: "bash",
          spawnArgs: [scriptPath],
          runCommandsFn: async () => [],
        }),
      });
      const ctx = {
        cwd,
        hasUI: false,
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
          select: async () => undefined,
          input: async () => undefined,
          editor: async () => undefined,
          setStatus: () => undefined,
        },
        sessionManager: createSessionManager([], "session-a"),
        newSession: async () => ({ cancelled: false }),
        waitForIdle: async () => undefined,
      };

      await harness.handler("ralph")(`--path ${target.ralphPath}`, ctx);

      for (const expected of scenario.expectedMessages) {
        assert.ok(notifications.some(({ message }) => expected.test(message)), `${scenario.name}: missing ${expected}; notifications=${JSON.stringify(notifications)}`);
      }
      const terminalNotification = notifications.find(({ message }) => scenario.expectedMessages.at(-1)?.test(message));
      assert.equal(terminalNotification?.level, scenario.expectedLevel);
    });
  }
});

test("/ralph rejects raw malformed guardrails shapes before starting the loop", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const targetDir = join(cwd, "raw-invalid-guardrails");
  const ralphPath = join(targetDir, "RALPH.md");
  mkdirSync(targetDir, { recursive: true });

  let newSessionCalls = 0;
  let execCalls = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness({
    exec: async () => {
      execCalls += 1;
      return { killed: false, stdout: "", stderr: "" };
    },
  });
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => {
        throw new Error("should not prompt");
      },
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: false };
    },
    waitForIdle: async () => {
      throw new Error("should not reach the loop");
    },
  };

  for (const [label, raw] of [
    [
      "block_commands scalar",
      [
        "---",
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
        "guardrails:",
        "  block_commands: 'git\\s+push'",
        "  protected_files: []",
        "---",
        "Task: Fix flaky auth tests",
        "",
        "Keep the change small.",
      ].join("\n"),
    ],
    [
      "block_commands null",
      [
        "---",
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
        "guardrails:",
        "  block_commands: null",
        "  protected_files: []",
        "---",
        "Task: Fix flaky auth tests",
        "",
        "Keep the change small.",
      ].join("\n"),
    ],
    [
      "protected_files scalar",
      [
        "---",
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
        "guardrails:",
        "  block_commands: []",
        "  protected_files: 'src/generated/**'",
        "---",
        "Task: Fix flaky auth tests",
        "",
        "Keep the change small.",
      ].join("\n"),
    ],
    [
      "protected_files null",
      [
        "---",
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
        "guardrails:",
        "  block_commands: []",
        "  protected_files: null",
        "---",
        "Task: Fix flaky auth tests",
        "",
        "Keep the change small.",
      ].join("\n"),
    ],
  ] as const) {
    writeFileSync(ralphPath, raw, "utf8");
    notifications.length = 0;
    newSessionCalls = 0;
    execCalls = 0;

    await handler(`--path ${ralphPath}`, ctx);

    assert.equal(newSessionCalls, 0, label);
    assert.equal(execCalls, 0, label);
    assert.equal(notifications.length, 1, label);
    assert.equal(notifications[0]?.level, "error", label);
    assert.match(notifications[0]?.message ?? "", /Invalid RALPH\.md: Invalid RALPH frontmatter: guardrails\.(block_commands|protected_files) must be a YAML sequence/, label);
  }
});

test("/ralph rejects raw malformed max_iterations arrays before starting the loop", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const targetDir = join(cwd, "raw-invalid-max-iterations");
  const ralphPath = join(targetDir, "RALPH.md");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    ralphPath,
    [
      "---",
      "commands: []",
      "max_iterations:",
      "  - 2",
      "timeout: 300",
      "guardrails:",
      "  block_commands: []",
      "  protected_files: []",
      "---",
      "Task: Fix flaky auth tests",
      "",
      "Keep the change small.",
    ].join("\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  let newSessionCalls = 0;
  let execCalls = 0;
  const harness = createHarness({
    exec: async () => {
      execCalls += 1;
      return { killed: false, stdout: "ok", stderr: "" };
    },
  });
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => {
        throw new Error("should not prompt");
      },
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: true };
    },
    waitForIdle: async () => {
      throw new Error("should not reach the loop");
    },
  };

  await handler(`--path ${ralphPath}`, ctx);

  assert.equal(newSessionCalls, 0);
  assert.equal(execCalls, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "error");
  assert.match(notifications[0]?.message ?? "", /Invalid RALPH\.md: Invalid RALPH frontmatter: max_iterations must be a YAML number/);
});

test("tool_call scopes guardrails to the session with the active persisted Ralph token", { concurrency: false }, async () => {
  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const loopToken = "loop-rebind-token";
  const protectedPath = "src/generated/output.ts";
  const oldCtx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: false,
            loopToken,
            iteration: 1,
            guardrails: { blockCommands: [], protectedFiles: ["src/generated/**"] },
          },
        },
      ],
      getSessionFile: () => "session-a",
    },
  };
  const activeCtx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken,
            iteration: 1,
            guardrails: { blockCommands: [], protectedFiles: ["src/generated/**"] },
          },
        },
      ],
      getSessionFile: () => "session-b",
    },
  };

  const inactiveResult = await toolCall({ toolName: "write", input: { path: protectedPath } }, oldCtx);
  const activeResult = await toolCall({ toolName: "write", input: { path: protectedPath } }, activeCtx);

  assert.equal(inactiveResult, undefined);
  assert.deepEqual(activeResult, { block: true, reason: `ralph: ${protectedPath} is protected` });
});

test("tool_call blocks when durable status is restrictive even if env contract is permissive", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "task");
  mkdirSync(taskDir, { recursive: true });
  const durableStatus: RunnerStatusFile = {
    loopToken: "loop-status-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd: taskDir,
    status: "running",
    currentIteration: 2,
    maxIterations: 4,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: ["git\\s+push"], protectedFiles: ["src/generated/**"] },
  };
  writeStatusFile(taskDir, durableStatus);

  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: taskDir,
    RALPH_RUNNER_LOOP_TOKEN: "loop-status-token",
    RALPH_RUNNER_CURRENT_ITERATION: "2",
    RALPH_RUNNER_MAX_ITERATIONS: "4",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: [], protectedFiles: [] }),
  });

  try {
    const result = await toolCall({ toolName: "write", input: { path: "src/generated/output.ts" } }, {
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => "session-a",
      },
    });

    assert.equal(result?.block, true);
  } finally {
    restoreEnv();
  }
});

test("tool_call blocks a bash allowlist violation from active loop guardrails", { concurrency: false }, async () => {
  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const loopToken = "loop-allowlist-token";
  const activeCtx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken,
            cwd: "/repo",
            taskDir: "/repo/task",
            iteration: 1,
            maxIterations: 3,
            guardrails: {
              blockCommands: [],
              protectedFiles: [],
              shellPolicy: { mode: "allowlist", allow: ["^echo ok$"] },
            },
          },
        },
      ],
      getSessionFile: () => "session-b",
    },
  };

  const result = await toolCall({ toolName: "bash", input: { command: "echo nope" } }, activeCtx);

  assert.deepEqual(result, { block: true, reason: "ralph: blocked (shell_policy.allowlist)" });
});

test("/ralph-draft passes the active model runtime to the draft planner", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string; runtime: StrengthenDraftRuntime | undefined }> = [];
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened");
  const runtime = {
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    modelRegistry: {
      async getApiKeyAndHeaders(model) {
        assert.equal(model.id, "claude-sonnet-4-5");
        return { ok: true, apiKey: "active-api-key", headers: { "x-runtime": "1" } };
      },
    },
  } satisfies StrengthenDraftRuntime;
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string, runtimeArg: StrengthenDraftRuntime | undefined) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg, runtime: runtimeArg });
      assert.ok(runtimeArg, "expected the active model runtime to reach the draft planner");
      assert.equal(runtimeArg?.model?.id, runtime.model.id);
      assert.equal(runtimeArg?.modelRegistry, runtime.modelRegistry);
      return draftPlan;
    },
  });

  const handler = harness.handler("ralph-draft");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      select: async () => "Save draft",
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => undefined,
      setStatus: () => undefined,
    },
    model: runtime.model,
    modelRegistry: runtime.modelRegistry,
    sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" },
    newSession: async () => {
      throw new Error("/ralph-draft should not start the loop");
    },
    waitForIdle: async () => {
      throw new Error("/ralph-draft should not wait for idle");
    },
  };

  await handler(task, ctx);

  assert.equal(draftCalls.length, 1);
  assert.equal(existsSync(target.ralphPath), true);
});

test("tool_call blocks write and edit for token-covered secret paths", async () => {
  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const ctx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken: "loop-secret-token",
            iteration: 1,
            guardrails: { blockCommands: [], protectedFiles: [SECRET_PATH_POLICY_TOKEN] },
          },
        },
      ],
      getSessionFile: () => "session-a",
    },
  };

  for (const toolName of ["write", "edit"] as const) {
    const result = await toolCall({ toolName, input: { path: ".ssh/config" } }, ctx);
    assert.deepEqual(result, { block: true, reason: "ralph: .ssh/config is protected" });
  }
});

test("tool_call blocks absolute write paths against repo-relative protected globs", async () => {
  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const cwd = "/repo/project";
  const absolutePath = join(cwd, "src", "generated", "output.ts");
  const ctx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken: "loop-absolute-token",
            iteration: 1,
            cwd,
            guardrails: { blockCommands: [], protectedFiles: ["src/generated/**"] },
          },
        },
      ],
      getSessionFile: () => "session-a",
    },
  };

  for (const toolName of ["write", "edit"] as const) {
    const result = await toolCall({ toolName, input: { path: absolutePath } }, ctx);
    assert.deepEqual(result, { block: true, reason: `ralph: ${absolutePath} is protected` });
  }
});

test("tool_call keeps explicit protected-file globs working", async () => {
  const proofEntries: Array<{ customType: string; data: any }> = [];
  const harness = createHarness({
    appendEntry: (customType, data) => {
      proofEntries.push({ customType, data });
    },
  });
  const toolCall = harness.event("tool_call");
  const ctx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "ralph-loop-state",
          data: {
            active: true,
            loopToken: "loop-glob-token",
            iteration: 1,
            guardrails: { blockCommands: [], protectedFiles: ["src/generated/**"] },
          },
        },
      ],
      getSessionFile: () => "session-a",
    },
  };

  for (const toolName of ["write", "edit"] as const) {
    const result = await toolCall({ toolName, input: { path: "src/generated/output.ts" } }, ctx);
    assert.deepEqual(result, { block: true, reason: "ralph: src/generated/output.ts is protected" });
  }

  const allowed = await toolCall({ toolName: "write", input: { path: "src/app.ts" } }, ctx);

  assert.equal(allowed, undefined);
  assert.equal(proofEntries.filter((entry) => entry.customType === "ralph-blocked-write").length, 2);
  assert.ok(proofEntries.some((entry) => entry.data.toolName === "write" && entry.data.path === "src/generated/output.ts"));
  assert.ok(proofEntries.some((entry) => entry.data.toolName === "edit" && entry.data.path === "src/generated/output.ts"));
});

test("/ralph subprocess child surfaces proof appendEntry failures", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "subprocess-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 2,
    maxIterations: 4,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  appendIterationRecord(taskDir, {
    iteration: 1,
    status: "complete",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1000,
    progress: true,
    changedFiles: ["notes/findings.md"],
    noProgressStreak: 0,
    snapshotTruncated: false,
    snapshotErrorCount: 0,
    loopToken: "subprocess-loop-token",
  } as any);

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "subprocess-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "2",
    RALPH_RUNNER_MAX_ITERATIONS: "4",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: [], protectedFiles: [] }),
  });
  t.after(restoreEnv);

  const stderrWrites: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  t.after(() => {
    (process.stderr as any).write = originalStderrWrite;
  });

  const harness = createHarness({
    appendEntry: () => {
      throw new Error("append failed");
    },
  });
  const beforeAgentStart = harness.event("before_agent_start");

  await assert.doesNotReject(
    beforeAgentStart(
      { systemPrompt: "Base prompt" },
      { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } },
    ),
  );

  const stderrOutput = stderrWrites.join("");
  assert.match(stderrOutput, /Ralph proof logging failed/);
  assert.match(stderrOutput, /ralph-steering-injected/);
  assert.match(stderrOutput, /ralph-loop-context-injected/);
});

test("/ralph subprocess child injects durable loop context into before_agent_start when session entries are empty", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "subprocess-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 2,
    maxIterations: 4,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  appendIterationRecord(taskDir, {
    iteration: 1,
    status: "complete",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1000,
    progress: true,
    changedFiles: ["notes/findings.md"],
    noProgressStreak: 0,
    snapshotTruncated: false,
    snapshotErrorCount: 0,
    loopToken: "subprocess-loop-token",
  } as any);

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "subprocess-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "2",
    RALPH_RUNNER_MAX_ITERATIONS: "4",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: [], protectedFiles: [] }),
  });
  t.after(restoreEnv);

  const proofEntries: Array<{ customType: string; data: any }> = [];
  const harness = createHarness({
    appendEntry: (customType, data) => {
      proofEntries.push({ customType, data });
    },
  });
  const beforeAgentStart = harness.event("before_agent_start");
  const result = await beforeAgentStart(
    { systemPrompt: "Base prompt" },
    { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } },
  );

  assert.ok(result);
  assert.match(result.systemPrompt, /## Ralph Loop Context/);
  assert.match(result.systemPrompt, /Iteration 2\/4/);
  assert.match(result.systemPrompt, /Task directory: \.\/subprocess-child-task/);
  assert.match(result.systemPrompt, /Previous iterations:\n- Iteration 1: 1s — durable progress \(notes\/findings\.md\); no-progress streak: 0/);
  assert.match(result.systemPrompt, /Last iteration durable progress: notes\/findings\.md\./);
  assert.deepEqual(proofEntries.map((entry) => entry.customType), ["ralph-steering-injected", "ralph-loop-context-injected"]);
});

test("/ralph subprocess child scopes durable history to the current loop token", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "current-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 2,
    maxIterations: 5,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });
  appendIterationRecord(taskDir, {
    loopToken: "stale-loop-token",
    iteration: 1,
    status: "complete",
    startedAt: new Date(Date.now() - 2000).toISOString(),
    completedAt: new Date(Date.now() - 1000).toISOString(),
    durationMs: 1000,
    progress: true,
    changedFiles: ["stale/findings.md"],
    noProgressStreak: 0,
  } as any);
  appendIterationRecord(taskDir, {
    loopToken: "current-loop-token",
    iteration: 2,
    status: "complete",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1000,
    progress: true,
    changedFiles: ["current/findings.md"],
    noProgressStreak: 0,
  } as any);

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "current-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "2",
    RALPH_RUNNER_MAX_ITERATIONS: "5",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: [], protectedFiles: [] }),
  });
  t.after(restoreEnv);

  const harness = createHarness();
  const beforeAgentStart = harness.event("before_agent_start");
  const result = await beforeAgentStart(
    { systemPrompt: "Base prompt" },
    { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } },
  );

  assert.ok(result);
  assert.match(result.systemPrompt, /## Ralph Loop Context/);
  assert.match(result.systemPrompt, /Iteration 2\/5/);
  assert.match(result.systemPrompt, /Previous iterations:/);
  assert.match(result.systemPrompt, /Iteration 2: 1s — durable progress \(current\/findings\.md\); no-progress streak: 0/);
  assert.doesNotMatch(result.systemPrompt, /stale\/findings\.md/);
});

test("/ralph subprocess child fails closed on malformed durable status files", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "malformed-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: null,
  } as any);

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "malformed-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "1",
    RALPH_RUNNER_MAX_ITERATIONS: "5",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: ["git\\s+push"], protectedFiles: ["src/generated/**"] }),
  });
  t.after(restoreEnv);

  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const result = await toolCall(
    { toolName: "bash", input: { command: "git push origin main" } },
    { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } },
  );

  assert.deepEqual(result, { block: true, reason: "ralph: invalid loop contract" });
});

test("/ralph subprocess child fails closed when the env loop contract is malformed", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "env-contract-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "1",
    RALPH_RUNNER_MAX_ITERATIONS: "5",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: "not-json",
  });
  t.after(restoreEnv);

  const harness = createHarness();
  const toolCall = harness.event("tool_call");
  const result = await toolCall(
    { toolName: "bash", input: { command: "git push origin main" } },
    { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } },
  );

  assert.deepEqual(result, { block: true, reason: "ralph: invalid loop contract" });
});

test("/ralph subprocess child steers repeated bash failures from durable runner state", { concurrency: false }, async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "subprocess-child-task");
  mkdirSync(taskDir, { recursive: true });
  writeStatusFile(taskDir, {
    loopToken: "subprocess-loop-token",
    ralphPath: join(taskDir, "RALPH.md"),
    taskDir,
    cwd,
    status: "running",
    currentIteration: 3,
    maxIterations: 4,
    timeout: 300,
    startedAt: new Date().toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });

  const restoreEnv = setRunnerEnv({
    RALPH_RUNNER_TASK_DIR: taskDir,
    RALPH_RUNNER_CWD: cwd,
    RALPH_RUNNER_LOOP_TOKEN: "subprocess-loop-token",
    RALPH_RUNNER_CURRENT_ITERATION: "3",
    RALPH_RUNNER_MAX_ITERATIONS: "4",
    RALPH_RUNNER_NO_PROGRESS_STREAK: "0",
    RALPH_RUNNER_GUARDRAILS: JSON.stringify({ blockCommands: [], protectedFiles: [] }),
  });
  t.after(restoreEnv);

  const harness = createHarness();
  const toolResult = harness.event("tool_result");
  const ctx = { sessionManager: { getEntries: () => [], getSessionFile: () => "session-a" } };
  const failureEvent = {
    toolName: "bash",
    content: [{ type: "text", text: "ERROR: command failed" }],
  };

  assert.equal(await toolResult(failureEvent, ctx), undefined);
  assert.equal(await toolResult(failureEvent, ctx), undefined);
  assert.deepEqual(await toolResult(failureEvent, ctx), {
    content: [
      { type: "text", text: "ERROR: command failed" },
      { type: "text", text: "\n\n⚠️ ralph: 3+ failures this iteration. Stop and describe the root cause before retrying." },
    ],
  });
});


test("/ralph-stop --path prefers session state and uses the session registry cwd", async (t) => {
  const callerCwd = createTempDir();
  const sessionCwd = createTempDir();
  t.after(() => rmSync(callerCwd, { recursive: true, force: true }));
  t.after(() => rmSync(sessionCwd, { recursive: true, force: true }));

  const taskDir = join(sessionCwd, "session-precedence-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, "Task: Stop me\n", "utf8");

  const durableEntry: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath,
    cwd: sessionCwd,
    loopToken: "durable-loop-token",
    status: "running",
    currentIteration: 4,
    maxIterations: 8,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeActiveLoopRegistryEntry(sessionCwd, durableEntry);

  const persistedState = {
    active: true,
    loopToken: "session-loop-token",
    cwd: sessionCwd,
    taskDir,
    iteration: 2,
    maxIterations: 10,
    noProgressStreak: 0,
    iterationSummaries: [],
    guardrails: { blockCommands: [], protectedFiles: [] },
    stopRequested: false,
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  let ctx: any;
  ctx = {
    cwd: callerCwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      { type: "custom", customType: "ralph-loop-state", data: persistedState },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${ralphPath}`, ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), true);
  assert.equal(readActiveLoopRegistry(callerCwd).length, 0);
  const sessionRegistry = readActiveLoopRegistry(sessionCwd).find((entry) => entry.taskDir === taskDir);
  assert.ok(sessionRegistry);
  assert.equal(sessionRegistry?.currentIteration, durableEntry.currentIteration);
  assert.equal(sessionRegistry?.maxIterations, durableEntry.maxIterations);
  assert.equal(sessionRegistry?.status, durableEntry.status);
  assert.equal(sessionRegistry?.startedAt, durableEntry.startedAt);
  assert.equal(typeof sessionRegistry?.stopRequestedAt, "string");
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop stopping after current iteration")));
});

test("/ralph-stop preserves a stop that was already observed before the registry update", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "mid-iteration-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, "Task: Stop me\n", "utf8");

  const stopRequestedAt = new Date(Date.now() - 2000).toISOString();
  const stopObservedAt = new Date().toISOString();
  const durableEntry: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath,
    cwd,
    loopToken: "durable-loop-token",
    status: "stopped",
    currentIteration: 5,
    maxIterations: 8,
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    updatedAt: stopObservedAt,
    stopRequestedAt,
    stopObservedAt,
  };
  writeActiveLoopRegistryEntry(cwd, durableEntry);

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  let ctx: any;
  ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          active: true,
          loopToken: "session-loop-token",
          cwd,
          taskDir,
          iteration: 2,
          maxIterations: 10,
          noProgressStreak: 1,
          iterationSummaries: [],
          guardrails: { blockCommands: [], protectedFiles: [] },
          stopRequested: false,
        },
      },
    ], "session-a"),
    getRuntimeCtx: () => ctx,
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), true);
  const updated = readActiveLoopRegistry(cwd).find((entry) => entry.taskDir === taskDir);
  assert.ok(updated);
  assert.equal(updated?.currentIteration, durableEntry.currentIteration);
  assert.equal(updated?.maxIterations, durableEntry.maxIterations);
  assert.equal(updated?.status, "stopped");
  assert.equal(updated?.startedAt, durableEntry.startedAt);
  assert.equal(updated?.stopObservedAt, stopObservedAt);
  assert.equal(typeof updated?.stopRequestedAt, "string");
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop stopping after current iteration")));
});

test("/ralph-stop reports no active loops when nothing is active", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("", ctx);

  assert.ok(notifications.some(({ message, level }) => level === "warning" && message === "No active ralph loops found."));
  assert.equal(existsSync(join(cwd, ".ralph-runner", "stop.flag")), false);
});

test("/ralph-stop --path ignores a stale status file without a matching active registry entry", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "stale-status-task");
  mkdirSync(taskDir, { recursive: true });
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, "Task: stale status\n", "utf8");
  writeStatusFile(taskDir, {
    loopToken: "stale-status-token",
    ralphPath,
    taskDir,
    cwd,
    status: "running",
    currentIteration: 99,
    maxIterations: 100,
    timeout: 300,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    guardrails: { blockCommands: [], protectedFiles: [] },
  });

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: createSessionManager([], "session-a"),
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${ralphPath}`, ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), false);
  assert.equal(readActiveLoopRegistry(cwd).length, 0);
  assert.ok(notifications.some(({ message }) => message.includes("No active ralph loop found")));
});

test("/ralph-stop falls back to the durable registry when session state is absent", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "registry-task");
  mkdirSync(taskDir, { recursive: true });
  const registryEntry: ActiveLoopRegistryEntry = {
    taskDir,
    ralphPath: join(taskDir, "RALPH.md"),
    cwd,
    loopToken: "registry-loop-token",
    status: "running",
    currentIteration: 2,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeActiveLoopRegistryEntry(cwd, registryEntry);

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDir, ".ralph-runner", "stop.flag")), true);
  const activeEntries = listActiveLoopRegistryEntries(cwd);
  assert.equal(activeEntries.length, 1);
  assert.equal(typeof activeEntries[0]?.stopRequestedAt, "string");
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop stopping after current iteration")));
  assert.equal(notifications.some(({ message }) => message.includes("No active ralph loop")), false);
});

test("/ralph-stop refuses to guess when multiple durable active loops exist", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDirA = join(cwd, "registry-task-a");
  const taskDirB = join(cwd, "registry-task-b");
  mkdirSync(taskDirA, { recursive: true });
  mkdirSync(taskDirB, { recursive: true });
  writeActiveLoopRegistryEntry(cwd, {
    taskDir: taskDirA,
    ralphPath: join(taskDirA, "RALPH.md"),
    cwd,
    loopToken: "registry-loop-token-a",
    status: "running",
    currentIteration: 2,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  writeActiveLoopRegistryEntry(cwd, {
    taskDir: taskDirB,
    ralphPath: join(taskDirB, "RALPH.md"),
    cwd,
    loopToken: "registry-loop-token-b",
    status: "running",
    currentIteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const handler = harness.handler("ralph-stop");
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("", ctx);

  assert.equal(existsSync(join(taskDirA, ".ralph-runner", "stop.flag")), false);
  assert.equal(existsSync(join(taskDirB, ".ralph-runner", "stop.flag")), false);
  assert.ok(notifications.some(({ message }) => message.toLowerCase().includes("multiple active ralph loops")));
  assert.ok(notifications.some(({ message }) => message.toLowerCase().includes("explicit target path")));
});

test("before_agent_start injects task directory context for iteration 1 (no previous summaries)", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(taskDir, { recursive: true });

  // Set up persisted loop state for iteration 1 with no summaries
  const entries = [
    {
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        active: true,
        loopToken: "test-loop-token",
        cwd,
        taskDir,
        iteration: 1,
        maxIterations: 10,
        noProgressStreak: 0,
        iterationSummaries: [],
        guardrails: { blockCommands: [], protectedFiles: [] },
        stopRequested: false,
      },
    },
  ];

  const harness = createHarness();
  const handler = harness.event("before_agent_start");
  const ctx = {
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => "session-a",
    },
  };
  const event = {
    systemPrompt: "You are an AI assistant.",
  };

  const result = await handler(event, ctx);

  assert.ok(result, "should return a response with system prompt modifications");
  assert.ok(
    typeof result === "object" && result !== null && "systemPrompt" in result,
    "response should include a systemPrompt field",
  );
  const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
  assert.ok(
    systemPrompt.includes("Task directory:"),
    "system prompt should include 'Task directory:' for iteration 1",
  );
  assert.ok(
    systemPrompt.includes("Ralph Loop Context"),
    "system prompt should include 'Ralph Loop Context' section",
  );
  assert.ok(
    systemPrompt.includes("Persist findings to files in the Ralph task directory"),
    "system prompt should include instructions to persist in task directory",
  );
  assert.ok(
    systemPrompt.includes("Iteration 1/10"),
    "system prompt should include iteration count",
  );
});
