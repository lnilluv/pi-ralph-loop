import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerRalphCommands from "../src/index.ts";
import { SECRET_PATH_POLICY_TOKEN } from "../src/secret-paths.ts";
import { generateDraft, parseRalphMarkdown, slugifyTask, type DraftPlan, type DraftTarget } from "../src/ralph.ts";
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

function createHarness(options?: { createDraftPlan?: (...args: Array<any>) => Promise<DraftPlan>; exec?: (...args: Array<any>) => Promise<any> }) {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<string | undefined>>();
  const eventHandlers = new Map<string, (...args: Array<any>) => Promise<any> | any>();
  const pi = {
    on: (eventName: string, handler: (...args: Array<any>) => Promise<any> | any) => {
      eventHandlers.set(eventName, handler);
    },
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<string | undefined> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
    exec:
      options?.exec ??
      (async () => ({
        killed: false,
        stdout: "",
        stderr: "",
      })),
  } as any;

  registerRalphCommands(pi, options as any);

  return {
    handler(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing handler for ${name}`);
      return handler;
    },
    event(name: string) {
      const handler = eventHandlers.get(name);
      assert.ok(handler, `missing event handler for ${name}`);
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
        const invalidContent = validContent.replace(
          /commands:\n(?:  - name: .+\n    run: .+\n    timeout: .+\n)+max_iterations: 2/,
          "commands:\n  name: tests\n  run: npm test\n  timeout: 20\nmax_iterations: 2",
        );
        writeFileSync(target.ralphPath, invalidContent, "utf8");
      }
    },
  };

  await handler(`--path ${target.ralphPath}`, ctx);

  assert.equal(execCalls, expectedExecCalls);
  assert.equal(newSessionCalls, 1);
  assert.ok(
    notifications.some(
      ({ level, message }) => level === "error" && message.includes("Invalid RALPH.md on iteration 2"),
    ),
  );
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
            sessionFile: "session-a",
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
            sessionFile: "session-a",
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
            sessionFile: "session-a",
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
});
