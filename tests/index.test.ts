import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerRalphCommands from "../src/index.ts";
import { generateDraft, slugifyTask, type DraftPlan, type DraftTarget } from "../src/ralph.ts";
import type { StrengthenDraftRuntime } from "../src/ralph-draft-llm.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-loop-index-"));
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

function createHarness(options?: { createDraftPlan?: (...args: Array<any>) => Promise<DraftPlan> }) {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<string | undefined>>();
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<string | undefined> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
  } as any;

  registerRalphCommands(pi, options as any);

  return {
    handler(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing handler for ${name}`);
      return handler;
    },
  };
}

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
