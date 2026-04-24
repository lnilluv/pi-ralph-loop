import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import registerRalphCommands, { parseLogExportArgs, runCommands } from "../src/index.ts";
import { SECRET_PATH_POLICY_TOKEN } from "../src/secret-paths.ts";
import { generateDraft, inspectDraftContent, parseRalphMarkdown, slugifyTask, validateFrontmatter, type DraftPlan, type DraftTarget } from "../src/ralph.ts";
import type { StrengthenDraftRuntime } from "../src/ralph-draft-llm.ts";
import type { RunnerConfig, RunnerResult } from "../src/runner.ts";
import { runRalphLoop as realRunRalphLoop, captureTaskDirectorySnapshot, assessTaskDirectoryProgress, summarizeChangedFiles } from "../src/runner.ts";
import {
  appendIterationRecord,
  listActiveLoopRegistryEntries,
  readActiveLoopRegistry,
  recordActiveLoopStopRequest,
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

function makeDraftPlan(task: string, target: DraftTarget, source: DraftPlan["source"], cwd: string): DraftPlan {
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
  const observedTaskDirPaths = new Set<string>();
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
    const entriesBefore = currentCtx?.sessionManager?.getEntries?.().length ?? 0;
    await options?.sendUserMessage?.(message, sendOptions);
    if (currentCtx?.suppressAutoAgentEnd) return;
    await currentCtx?.waitForIdle?.();
    const agentEnd = eventHandlers.get("agent_end");
    if (!agentEnd || !currentCtx) return;
    const messages = Array.isArray(currentCtx.agentEndMessages)
      ? currentCtx.agentEndMessages
      : currentCtx.sessionManager?.getEntries?.().slice(entriesBefore) ?? [];
    await agentEnd({ messages }, currentCtx);
  };
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
    exec:
      options?.exec ??
      (async () => ({
        killed: false,
        stdout: "",
        stderr: "",
      })),
  } as any;

  // Default mock runner that simulates iterations using the test context's
  // waitForIdle and directory snapshot detection
  const defaultRunLoopFn = async (config: RunnerConfig): Promise<RunnerResult> => {
    const { ralphPath, cwd, maxIterations, onIterationStart, onIterationComplete, onStatusChange, onNotify, runCommandsFn, pi } = config;
    const iterations: IterationRecord[] = [];
    let noProgressStreak = 0;
    let finalStatus: RunnerResult["status"] = "max-iterations";

    onStatusChange?.("running");

    for (let i = 1; i <= maxIterations; i++) {
      const iterStart = Date.now();
      onIterationStart?.(i, maxIterations);

      const raw = readFileSync(ralphPath, "utf8");
      const parsed = parseRalphMarkdown(raw);
      const draftError = validateFrontmatter(parsed.frontmatter);
      if (draftError) {
        onNotify?.(`Invalid RALPH.md on iteration ${i}: ${draftError}`, "error");
        finalStatus = "error";
        break;
      }

      const fm = parsed.frontmatter;
      const currentTimeout = fm.timeout;
      const currentCompletionPromise = fm.completionPromise;
      const currentGuardrails = {
        blockCommands: fm.guardrails.blockCommands,
        protectedFiles: fm.guardrails.protectedFiles,
      };

      const { cancelled } = await (activeCtx?.newSession?.() ?? { cancelled: false });
      if (cancelled) {
        const record: IterationRecord = {
          iteration: i,
          status: "error",
          startedAt: new Date(iterStart).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - iterStart,
          progress: "unknown" as any,
          changedFiles: [],
          noProgressStreak,
        };
        iterations.push(record);
        onIterationComplete?.(record);
        finalStatus = "stopped";
        break;
      }

      const runtimeCtx = resolveRuntimeCtx();

      if (runCommandsFn && pi) {
        await runCommandsFn(fm.commands, currentGuardrails.blockCommands, pi, cwd, dirname(ralphPath));
      }

      const snapshotBefore = captureTaskDirectorySnapshot(ralphPath);
      observedTaskDirPaths.clear();
      const entriesBefore = runtimeCtx?.sessionManager?.getEntries?.().length ?? 0;
      const waitForIdlePromise = Promise.resolve(runtimeCtx?.waitForIdle?.());
      const timeoutMs = currentTimeout * 1000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const waitResult = timeoutMs > 0
        ? await Promise.race([
            waitForIdlePromise.then(() => "done" as const),
            new Promise<"timeout">((resolve) => {
              timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
          ])
        : await waitForIdlePromise.then(() => "done" as const);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (waitResult === "timeout") {
        const elapsed = Date.now() - iterStart;
        const record: IterationRecord = {
          iteration: i,
          status: "timeout",
          startedAt: new Date(iterStart).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: elapsed,
          progress: false,
          changedFiles: [],
          noProgressStreak: noProgressStreak + 1,
        };
        iterations.push(record);
        onIterationComplete?.(record);
        onNotify?.(`Iteration ${i} timed out after ${currentTimeout}s, stopping loop`, "warning");
        finalStatus = "timeout";
        break;
      }

      const { progress: assessedProgress, changedFiles: assessedChangedFiles, snapshotTruncated, snapshotErrorCount } =
        await assessTaskDirectoryProgress(ralphPath, snapshotBefore);
      let progress = assessedProgress;
      let changedFiles = assessedChangedFiles;
      const iterationEntries = runtimeCtx?.sessionManager?.getEntries?.().slice(entriesBefore) ?? [];
      if (
        progress === false &&
        [...observedTaskDirPaths].some((observedPath) => observedPath.startsWith(dirname(ralphPath)))
      ) {
        progress = "unknown";
        changedFiles = [];
      }

      if (progress === true) {
        noProgressStreak = 0;
      } else if (progress === false) {
        noProgressStreak += 1;
      }

      let completionPromiseMatched = false;
      if (currentCompletionPromise) {
        const completionMessages = Array.isArray(runtimeCtx?.agentEndMessages) && runtimeCtx.agentEndMessages.length > 0
          ? runtimeCtx.agentEndMessages
          : iterationEntries;
        const completionText = completionMessages
          .map((entry: any) => {
            if (entry?.type === "message" && entry?.message?.role === "assistant") {
              const text = entry.message.content?.filter((b: any) => b.type === "text")?.map((b: any) => b.text)?.join("") ?? "";
              return text;
            }
            try {
              return JSON.stringify(entry);
            } catch {
              return String(entry);
            }
          })
          .join("\n");
        completionPromiseMatched = completionText.includes(currentCompletionPromise);
      }

      const elapsed = Date.now() - iterStart;
      const record: IterationRecord = {
        iteration: i,
        status: "complete",
        startedAt: new Date(iterStart).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsed,
        progress,
        changedFiles,
        noProgressStreak,
        completionPromiseMatched: completionPromiseMatched || undefined,
        snapshotTruncated,
        snapshotErrorCount,
      };
      iterations.push(record);
      onIterationComplete?.(record);

      if (progress === true) {
        onNotify?.(`Iteration ${i} durable progress: ${summarizeChangedFiles(changedFiles)}`, "info");
      } else if (progress === false) {
        onNotify?.(`Iteration ${i} made no durable progress. No-progress streak: ${noProgressStreak}.`, "warning");
      } else {
        onNotify?.(
          `Iteration ${i} durable progress could not be verified${snapshotTruncated ? " (snapshot truncated)" : ""}. No-progress streak remains ${noProgressStreak}.`,
          "warning",
        );
      }
      onNotify?.(`Iteration ${i} complete (${Math.round(elapsed / 1000)}s)`, "info");

      if (completionPromiseMatched) {
        if (progress === false) {
          onNotify?.(`Completion promise matched on iteration ${i}, but no durable progress was detected. Continuing.`, "warning");
        } else {
          if (progress === "unknown") {
            onNotify?.(`Completion promise matched on iteration ${i}, and durable progress could not be verified. Stopping.`, "info");
          } else {
            onNotify?.(`Completion promise matched on iteration ${i} after durable progress`, "info");
          }
          finalStatus = "complete";
          break;
        }
      }
    }

    const hadConfirmedProgress = iterations.some((r) => r.progress === true);
    if (finalStatus !== "complete" && finalStatus !== "stopped" && finalStatus !== "timeout") {
      finalStatus = hadConfirmedProgress ? "max-iterations" : "no-progress-exhaustion";
    }

    return {
      status: finalStatus,
      iterations,
      totalDurationMs: iterations.reduce((a, r) => a + (r.durationMs ?? 0), 0),
    };
  };

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
      return async (event: any, ctx: any) => {
        if (name === "tool_call" && (event?.toolName === "write" || event?.toolName === "edit") && typeof event?.input?.path === "string") {
          observedTaskDirPaths.add(event.input.path);
        }
        return await handler(event, ctx);
      };
    },
  };
}

function latestLoopState(entries: Array<any>): any {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === "ralph-loop-state") {
      return entry.data;
    }
  }
  return undefined;
}

function createSessionManager(entries: Array<any>, sessionFile: string) {
  return {
    getEntries: () => entries,
    getSessionFile: () => sessionFile,
  };
}

function createRuntimeSession(entries: Array<any>, sessionFile: string, waitForIdle: () => Promise<void> | void) {
  return {
    sessionManager: createSessionManager(entries, sessionFile),
    appendSessionEntry: (entry: any) => entries.push(entry),
    waitForIdle: async () => {
      await waitForIdle();
    },
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

  assert.deepEqual(registeredCommands, ["ralph", "ralph-draft", "ralph-stop", "ralph-cancel", "ralph-scaffold", "ralph-logs"]);
  assert.deepEqual(registeredEvents, [
    "tool_call",
    "tool_execution_start",
    "tool_execution_end",
    "agent_end",
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
    const observed: Array<{ tool: string; args: string[]; options?: { cwd?: string }; cwdAtExec: string }> = [];
    const pi = {
      exec: async (tool: string, args: string[], options?: { cwd?: string }) => {
        observed.push({ tool, args, options, cwdAtExec: process.cwd() });
        return { killed: false, stdout: "", stderr: "" };
      },
    } as any;

    await runCommands(
      [
        { name: "npm test", run: "npm test", timeout: 1 },
        { name: "git log", run: "git log --oneline", timeout: 1 },
      ],
      [],
      pi,
      {},
      repoCwd,
      taskDir,
    );

    assert.equal(observed.length, 2);
    assert.deepEqual(observed.map(({ options }) => options?.cwd), [repoCwd, repoCwd]);
    assert.equal(observed[0].cwdAtExec, originalCwd);
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
    const observed: Array<{ tool: string; args: string[]; options?: { cwd?: string }; cwdAtExec: string }> = [];
    const pi = {
      exec: async (tool: string, args: string[], options?: { cwd?: string }) => {
        observed.push({ tool, args, options, cwdAtExec: process.cwd() });
        return { killed: false, stdout: "", stderr: "" };
      },
    } as any;

    await runCommands([{ name: "build", run: "  ./scripts/build", timeout: 1 }], [], pi, {}, repoCwd, taskDir);

    assert.equal(observed.length, 1);
    assert.equal(observed[0].tool, "bash");
    assert.equal(observed[0].options?.cwd, taskDir);
    assert.equal(observed[0].cwdAtExec, originalCwd);
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
    const observed: Array<{ tool: string; args: string[]; options?: { cwd?: string }; cwdAtExec: string }> = [];
    const pi = {
      exec: async (tool: string, args: string[], options?: { cwd?: string }) => {
        observed.push({ tool, args, options, cwdAtExec: process.cwd() });
        return { killed: false, stdout: "", stderr: "" };
      },
    } as any;

    await runCommands(
      [{ name: "check", run: "{{ args.tool }} --flag", timeout: 1 }],
      [],
      pi,
      { tool: "./scripts/check.sh" },
      repoCwd,
      taskDir,
    );

    assert.equal(observed.length, 1);
    assert.equal(observed[0].tool, "bash");
    assert.equal(observed[0].args[1], "'./scripts/check.sh' --flag");
    assert.equal(observed[0].options?.cwd, taskDir);
    assert.equal(observed[0].cwdAtExec, originalCwd);
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

test("/ralph-stop writes the durable stop flag from persisted active loop state after reload", async (t) => {
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

test("/ralph-cancel refuses when no status.json exists", async (t) => {
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

test("/ralph-logs exports artifacts from a task with .ralph-runner/", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const taskDir = join(cwd, "my-task");
  mkdirSync(join(taskDir, ".ralph-runner", "transcripts"), { recursive: true });
  writeFileSync(join(taskDir, "RALPH.md"), "---\nmax_iterations: 10\ntimeout: 120\ncommands: []\n---\n# my-task\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "status.json"), JSON.stringify({ status: "running" }), "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "iterations.jsonl"), "{\"iteration\":1}\n{\"iteration\":2}\n", "utf8");
  writeFileSync(join(taskDir, ".ralph-runner", "events.jsonl"), "{\"event\":1}\n", "utf8");
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

  await handler("my-task --dest exported", ctx);

  const exportedDir = join(cwd, "exported");
  assert.equal(existsSync(join(exportedDir, "status.json")), true);
  assert.equal(readFileSync(join(exportedDir, "iterations.jsonl"), "utf8"), "{\"iteration\":1}\n{\"iteration\":2}\n");
  assert.equal(readFileSync(join(exportedDir, "events.jsonl"), "utf8"), "{\"event\":1}\n");
  assert.equal(readFileSync(join(exportedDir, "transcripts", "one.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(exportedDir, "transcripts", "two.txt"), "utf8"), "two");
  assert.ok(notifications.some(({ message, level }) => level === "info" && message.includes("Exported 2 iteration records, 1 events, 2 transcripts to ./exported")));
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

test("parseLogExportArgs parses --dest correctly", () => {
  assert.deepEqual(parseLogExportArgs("my-task --dest exported"), { path: "my-task", dest: "exported" });
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
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened", cwd);
  const harness = createHarness({
    createDraftPlan: async (taskArg: string, targetArg: DraftTarget, cwdArg: string) => {
      draftCalls.push({ task: taskArg, target: targetArg, cwd: cwdArg });
      return draftPlan;
    },
  });

  const notifications: Array<{ message: string; level: string }> = [];
  let selectTitle = "";
  let selectOptions: string[] = [];
  let newSessionCalls = 0;
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
    newSession: async () => {
      newSessionCalls += 1;
      assert.equal(existsSync(target.ralphPath), true, "draft file should be written before the loop starts");
      return { cancelled: true };
    },
    waitForIdle: async () => {
      throw new Error("loop should not continue after cancelled session start");
    },
  };

  await handler(task, ctx);

  assert.equal(draftCalls.length, 1);
  assert.equal(newSessionCalls, 1);
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
  const draftPlan = makeDraftPlan(task, target, "fallback", cwd);
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
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened", cwd);
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
      return makeDraftPlan(task, target, "llm-strengthened", cwd);
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
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened", cwd);
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
        [],
        config.pi,
        config.cwd,
        dirname(config.ralphPath),
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

test("/ralph re-validates raw draft content before each loop iteration", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "Fix flaky auth tests";
  const target = createTarget(cwd, task);
  const targetDir = target.dirPath;
  mkdirSync(targetDir, { recursive: true });
  const draft = generateDraft(task, target, {
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json"],
  });
  const validContent = draft.content.replace("max_iterations: 25", "max_iterations: 2");
  writeFileSync(target.ralphPath, validContent, "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  let newSessionCalls = 0;
  let mutated = false;
  const expectedExecCalls = parseRalphMarkdown(validContent).frontmatter.commands.length;
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
      return { cancelled: false };
    },
    waitForIdle: async () => {
      if (!mutated) {
        mutated = true;
        const invalidContent = validContent.replace("max_iterations: 2", "max_iterations: two");
        writeFileSync(target.ralphPath, invalidContent, "utf8");
      }
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(execCalls, expectedExecCalls);
  assert.ok(
    notifications.some(
      ({ level, message }) => level === "error" && message.includes("Invalid RALPH.md on iteration 2"),
    ),
  );
});

test("/ralph uses follow-up delivery for later iterations that resume a busy session", async (t) => {
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
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 2"), "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  let newSessionCalls = 0;
  const harness = createHarness();

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
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(newSessionCalls, 2);
  assert.ok(
    notifications.some(({ message }) =>
      message.includes("Ralph loop reached max iterations: 2 iterations") || message.includes("Ralph loop exhausted without verified progress: 2 iterations"),
    ),
  );
  assert.equal(notifications.some(({ level, message }) => level === "error" && message.includes("Ralph loop failed")), false);
});

test("/ralph completes iterations when runtime session rebinds after newSession", { concurrency: false }, async (t) => {
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
  writeFileSync(
    target.ralphPath,
    draft.content
      .replaceAll("timeout: 120", "timeout: 1")
      .replaceAll("timeout: 90", "timeout: 1")
      .replaceAll("timeout: 20", "timeout: 1")
      .replace("max_iterations: 25", "max_iterations: 1")
      .replace("timeout: 300\n", "timeout: 1\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const oldEntries: Array<any> = [];
  const newEntries: Array<any> = [];
  const handler = harness.handler("ralph");
  const oldRuntimeCtx = createRuntimeSession(oldEntries, "session-a", async () => {
    throw new Error("runtime should rebind before the agent runs");
  });
  const newRuntimeCtx = createRuntimeSession(newEntries, "session-b", async () => {
    mkdirSync(join(target.dirPath, "notes"), { recursive: true });
    writeFileSync(join(target.dirPath, "notes", "findings.md"), "persisted change\n", "utf8");
  });
  let runtimeCtx = oldRuntimeCtx;
  const ctx: any = {
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
    getRuntimeCtx: () => runtimeCtx,
    sessionManager: createSessionManager(oldEntries, "session-a"),
    newSession: async () => {
      runtimeCtx = newRuntimeCtx;
      return { cancelled: false };
    },
    waitForIdle: async () => {
      throw new Error("command ctx should stay stale after newSession");
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(newEntries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, true);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, ["notes/findings.md"]);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress: notes/findings.md")));
  assert.equal(notifications.some(({ message }) => message.includes("timed out")), false);
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


test("/ralph still resolves completion_promise after runtime session rebinding", { concurrency: false }, async (t) => {
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
  writeFileSync(
    target.ralphPath,
    draft.content
      .replaceAll("timeout: 120", "timeout: 1")
      .replaceAll("timeout: 90", "timeout: 1")
      .replaceAll("timeout: 20", "timeout: 1")
      .replace("max_iterations: 25", "max_iterations: 2")
      .replace("timeout: 300\n", "timeout: 1\ncompletion_promise: done\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const oldEntries: Array<any> = [];
  const newEntries: Array<any> = [];
  const handler = harness.handler("ralph");
  const oldRuntimeCtx = createRuntimeSession(oldEntries, "session-a", async () => {
    throw new Error("runtime should rebind before the agent runs");
  });
  const newRuntimeCtx = createRuntimeSession(newEntries, "session-b", async () => {
    mkdirSync(join(target.dirPath, "notes"), { recursive: true });
    writeFileSync(join(target.dirPath, "notes", "findings.md"), "persisted change\n", "utf8");
    newEntries.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "<promise>done</promise>" }] },
    });
  });
  let runtimeCtx = oldRuntimeCtx;
  const ctx: any = {
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
    getRuntimeCtx: () => runtimeCtx,
    sessionManager: createSessionManager(oldEntries, "session-a"),
    newSession: async () => {
      runtimeCtx = newRuntimeCtx;
      return { cancelled: false };
    },
    waitForIdle: async () => {
      throw new Error("command ctx should stay stale after newSession");
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(newEntries);
  assert.equal(finalState?.iterationSummaries?.length, 1);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, true);
});

test("/ralph records durable progress from task-directory file mutations", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      mkdirSync(join(target.dirPath, "notes"), { recursive: true });
      writeFileSync(join(target.dirPath, "notes", "findings.md"), "persisted change\n", "utf8");
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, true);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, ["notes/findings.md"]);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 0);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress: notes/findings.md")));
});

test("/ralph confirms late task-dir writes after agent_end with a bounded snapshot poll even without observed write/edit tool results", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const handler = harness.handler("ralph");
  let lateWriteScheduled = false;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      if (!lateWriteScheduled) {
        lateWriteScheduled = true;
        setTimeout(() => {
          mkdirSync(join(target.dirPath, "notes"), { recursive: true });
          writeFileSync(join(target.dirPath, "notes", "findings.md"), "persisted change\n", "utf8");
        }, 40);
      }
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, true);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, ["notes/findings.md"]);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 0);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress: notes/findings.md")));
});

test("/ralph downgrades observed task-dir edits without a final diff to unknown progress", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const toolCall = harness.event("tool_call");
  const toolExecutionEnd = harness.event("tool_execution_end");
  const handler = harness.handler("ralph");
  let ctx: any;
  ctx = {
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      await toolCall(
        {
          toolName: "edit",
          toolCallId: "edit-call-1",
          input: { path: join(target.dirPath, "notes", "findings.md") },
        },
        ctx,
      );
      await toolExecutionEnd(
        {
          toolName: "edit",
          toolCallId: "edit-call-1",
          isError: false,
        },
        ctx,
      );
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, "unknown");
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 0);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress could not be verified")));
  assert.equal(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")), false);
});

test("/ralph still reports no progress when no task-dir write or edit activity was observed", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
});

test("/ralph ignores observed write activity outside the Ralph task directory", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const toolCall = harness.event("tool_call");
  const toolExecutionEnd = harness.event("tool_execution_end");
  const handler = harness.handler("ralph");
  const outsidePath = join(cwd, "outside.txt");
  let ctx: any;
  ctx = {
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      await toolCall(
        {
          toolName: "write",
          toolCallId: "write-call-1",
          input: { path: outsidePath },
        },
        ctx,
      );
      await toolExecutionEnd(
        {
          toolName: "write",
          toolCallId: "write-call-1",
          isError: false,
        },
        ctx,
      );
      writeFileSync(outsidePath, "outside\n", "utf8");
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(existsSync(outsidePath), true);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
});

test("/ralph does not count pre-agent command mutations as durable progress", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness({
    exec: async () => {
      writeFileSync(join(target.dirPath, "command-log.txt"), "from command\n", "utf8");
      return { killed: false, stdout: "ok", stderr: "" };
    },
  });
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(existsSync(join(target.dirPath, "command-log.txt")), true);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
});

test("/ralph does not count RALPH_PROGRESS.md churn as durable progress", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness({
    exec: async () => {
      writeFileSync(join(target.dirPath, "RALPH_PROGRESS.md"), "rolling note\n", "utf8");
      return { killed: false, stdout: "ok", stderr: "" };
    },
  });
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
});

test("/ralph reports non-success when all iterations exhaust with unknown durable progress", async (t) => {
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
  for (let i = 0; i < 205; i++) {
    writeFileSync(join(target.dirPath, `note-${String(i).padStart(3, "0")}.txt`), `seed ${i}\n`, "utf8");
  }

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, "unknown");
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 0);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress could not be verified")));
  assert.equal(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")), false);
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress: 1 iterations")));
  assert.equal(notifications.some(({ message }) => message.includes("Ralph loop reached max iterations")), false);
});

test("/ralph reports non-success when false and unknown progress exhaust without any verified progress", async (t) => {
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
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 2"), "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  let newSessionCalls = 0;
  let seededUnknownState = false;
  const harness = createHarness({
    exec: async () => {
      if (newSessionCalls === 2 && !seededUnknownState) {
        seededUnknownState = true;
        for (let i = 0; i < 205; i++) {
          writeFileSync(join(target.dirPath, `note-${String(i).padStart(3, "0")}.txt`), `seed ${i}\n`, "utf8");
        }
      }
      return { killed: false, stdout: "ok", stderr: "" };
    },
  });
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: false };
    },
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.length, 2);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 1);
  assert.equal(finalState?.iterationSummaries?.[1]?.progress, "unknown");
  assert.equal(finalState?.iterationSummaries?.[1]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 2 durable progress could not be verified")));
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress: 2 iterations")));
  assert.equal(notifications.some(({ message }) => message.includes("Ralph loop reached max iterations")), false);
});

test("/ralph treats byte-budget snapshot truncation as unknown progress and a non-success exhaustion", async (t) => {
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
  const largeContent = "x".repeat(800_000);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(target.dirPath, `large-${i}.txt`), largeContent, "utf8");
  }

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, "unknown");
  assert.deepEqual(finalState?.iterationSummaries?.[0]?.changedFiles, []);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress could not be verified (snapshot truncated)")));
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress: 1 iterations")));
  assert.equal(notifications.some(({ message }) => message.includes("Ralph loop reached max iterations")), false);
});

test("/ralph can stop on completion_promise when durable progress detection is unknown", async (t) => {
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
  writeFileSync(
    target.ralphPath,
    draft.content
      .replace("max_iterations: 25", "max_iterations: 2")
      .replace("timeout: 300\n", "timeout: 300\ncompletion_promise: done\n"),
    "utf8",
  );
  for (let i = 0; i < 205; i++) {
    writeFileSync(join(target.dirPath, `note-${String(i).padStart(3, "0")}.txt`), `seed ${i}\n`, "utf8");
  }

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  let waitCalls = 0;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      waitCalls += 1;
      entries.push({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "<promise>done</promise>" }] },
      });
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(waitCalls, 1);
  assert.equal(finalState?.iterationSummaries?.length, 1);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, "unknown");
  assert.equal(finalState?.iterationSummaries?.[0]?.noProgressStreak, 0);
});

test("/ralph matches completion_promise from agent_end messages instead of session entry slices", async (t) => {
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
  writeFileSync(
    target.ralphPath,
    draft.content
      .replace("max_iterations: 25", "max_iterations: 2")
      .replace("timeout: 300\n", "timeout: 300\ncompletion_promise: done\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const handler = harness.handler("ralph");
  const ctx: any = {
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
    agentEndMessages: [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "<promise>done</promise>" }] },
      },
    ],
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, false);
  assert.equal(finalState?.iterationSummaries?.length, 2);
  assert.ok(
    notifications.some(({ message }) =>
      message.includes("Completion promise matched on iteration 1") && message.includes("no durable progress"),
    ),
  );
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress: 2 iterations")));
});

test("/ralph scopes successful write/edit bookkeeping to the active loop session and iteration", async (t) => {
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
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 2"), "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const toolCall = harness.event("tool_call");
  const toolExecutionEnd = harness.event("tool_execution_end");
  const handler = harness.handler("ralph");
  const sessionFiles = ["session-a", "session-b"];
  let sessionIndex = -1;
  let currentSessionFile = "session-a";
  let ctx: any;
  ctx = {
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => currentSessionFile },
    newSession: async () => {
      sessionIndex += 1;
      currentSessionFile = sessionFiles[sessionIndex] ?? sessionFiles[sessionFiles.length - 1]!;
      return { cancelled: false };
    },
    waitForIdle: async () => {
      if (currentSessionFile === "session-a") {
        await toolCall(
          {
            toolName: "write",
            toolCallId: "write-call-1",
            input: { path: join(target.dirPath, "notes", "findings.md") },
          },
          ctx,
        );
        await toolExecutionEnd(
          {
            toolName: "write",
            toolCallId: "write-call-1",
            isError: false,
          },
          ctx,
        );
        return;
      }

      await toolExecutionEnd(
        {
          toolName: "write",
          toolCallId: "write-call-1",
          isError: false,
        },
        { ...ctx, sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" } },
      );
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  const finalState = latestLoopState(entries);
  assert.equal(finalState?.iterationSummaries?.length, 2);
  assert.equal(finalState?.iterationSummaries?.[0]?.progress, "unknown");
  assert.equal(finalState?.iterationSummaries?.[1]?.progress, false);
  assert.equal(finalState?.iterationSummaries?.[1]?.noProgressStreak, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 durable progress could not be verified")));
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 2 made no durable progress")));
});

test("/ralph times out when agent_end never arrives", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "Fix flaky auth tests";
  const target = createTarget(cwd, task);
  mkdirSync(target.dirPath, { recursive: true });
  writeFileSync(
    target.ralphPath,
    [
      "---",
      "commands: []",
      "max_iterations: 1",
      "timeout: 1",
      "guardrails:",
      "  block_commands: []",
      "  protected_files: []",
      "---",
      "Task: Fix flaky auth tests",
      "",
      "Wait for the agent to finish.",
    ].join("\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  const handler = harness.handler("ralph");
  let waitCalls = 0;
  const ctx: any = {
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
    suppressAutoAgentEnd: true,
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      waitCalls += 1;
      await new Promise<void>(() => undefined);
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(waitCalls, 1);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 timed out after 1s, stopping loop")));
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop stopped after a timeout: 1 iterations")));
});

test("/ralph reports no-progress iterations in notifications and next-iteration handoff", async (t) => {
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
  writeFileSync(target.ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 2"), "utf8");

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  let waitCalls = 0;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      waitCalls += 1;
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(waitCalls, 2);
  assert.ok(notifications.some(({ message }) => message.includes("Iteration 1 made no durable progress")));
});

test("/ralph ignores completion_promise matches when the iteration made no durable progress", async (t) => {
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
  writeFileSync(
    target.ralphPath,
    draft.content
      .replace("max_iterations: 25", "max_iterations: 2")
      .replace("timeout: 300\n", "timeout: 300\ncompletion_promise: done\n"),
    "utf8",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
  let waitCalls = 0;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {
      waitCalls += 1;
      if (waitCalls === 1) {
        entries.push({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "<promise>done</promise>" }] },
        });
      }
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(waitCalls, 2);
  assert.ok(
    notifications.some(({ message }) =>
      message.includes("Completion promise matched on iteration 1") && message.includes("no durable progress"),
    ),
  );
  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress")));
});

test("/ralph reports non-success when the loop exhausts without verified progress", async (t) => {
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

  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createHarness();
  const entries = harness.appendedEntries;
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
    sessionManager: { getEntries: () => entries, getSessionFile: () => "session-a" },
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.ok(notifications.some(({ message }) => message.includes("Ralph loop exhausted without verified progress")));
  assert.equal(notifications.some(({ message }) => message.includes("Ralph loop done")), false);
});

test("/ralph-draft passes the active model runtime to the draft planner", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const draftCalls: Array<{ task: string; target: DraftTarget; cwd: string; runtime: StrengthenDraftRuntime | undefined }> = [];
  const draftPlan = makeDraftPlan(task, target, "llm-strengthened", cwd);
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
