import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildDraftRequest,
  buildMissionBrief,
  buildRepoContext,
  classifyTaskMode,
  createSiblingTarget,
  defaultFrontmatter,
  extractDraftMetadata,
  generateDraft,
  isWeakStrengthenedDraft,
  normalizeStrengthenedDraft,
  inspectExistingTarget,
  inspectRepo,
  looksLikePath,
  nextSiblingSlug,
  parseCommandArgs,
  parseRalphMarkdown,
  planTaskDraftTarget,
  renderIterationPrompt,
  renderRalphBody,
  resolvePlaceholders,
  slugifyTask,
  shouldValidateExistingDraft,
  validateDraftContent,
  validateFrontmatter,
} from "../src/ralph.ts";
import { SECRET_PATH_POLICY_TOKEN } from "../src/secret-paths.ts";
import type { RepoSignals } from "../src/ralph.ts";
import registerRalphCommands, { runCommands } from "../src/index.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-loop-"));
}

function encodeMetadata(metadata: Record<string, unknown>): string {
  return `<!-- pi-ralph-loop: ${encodeURIComponent(JSON.stringify(metadata))} -->`;
}

function createCommandHarness() {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<string | undefined>>();
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<string | undefined> }) => {
      handlers.set(name, spec.handler);
    },
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
  } as any;

  registerRalphCommands(pi);

  return {
    handler(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler);
      return handler;
    },
  };
}

function assertMetadataSource(metadata: ReturnType<typeof extractDraftMetadata>, expected: "deterministic" | "llm-strengthened" | "fallback") {
  if (!metadata || !("source" in metadata)) {
    assert.fail("Expected draft metadata with a source");
  }
  assert.equal(metadata.source, expected);
}

test("parseRalphMarkdown falls back to default frontmatter when no frontmatter is present", () => {
  const parsed = parseRalphMarkdown("hello\nworld");

  assert.deepEqual(parsed.frontmatter, defaultFrontmatter());
  assert.equal(parsed.body, "hello\nworld");
});

test("parseRalphMarkdown parses frontmatter and normalizes line endings", () => {
  const parsed = parseRalphMarkdown(
    "\uFEFF---\r\ncommands:\r\n  - name: build\r\n    run: npm test\r\n    timeout: 15\r\nmax_iterations: 3\r\ntimeout: 12.5\r\ncompletion_promise: done\r\nguardrails:\r\n  block_commands:\r\n    - rm .*\r\n  protected_files:\r\n    - src/**\r\n---\r\nBody\r\n",
  );

  assert.deepEqual(parsed.frontmatter, {
    commands: [{ name: "build", run: "npm test", timeout: 15 }],
    maxIterations: 3,
    timeout: 12.5,
    completionPromise: "done",
    guardrails: { blockCommands: ["rm .*"], protectedFiles: ["src/**"] },
    invalidCommandEntries: undefined,
  });
  assert.equal(parsed.body, "Body\n");
});

test("validateFrontmatter accepts valid input and rejects invalid values", () => {
  assert.equal(validateFrontmatter(defaultFrontmatter()), null);
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), maxIterations: 0 }),
    "Invalid max_iterations: must be a positive finite integer",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), timeout: 0 }),
    "Invalid timeout: must be a positive finite number",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), guardrails: { blockCommands: ["["], protectedFiles: [] } }),
    "Invalid block_commands regex: [",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "", run: "echo ok", timeout: 1 }] }),
    "Invalid command: name is required",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build", run: "", timeout: 1 }] }),
    "Invalid command build: run is required",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build", run: "echo ok", timeout: 0 }] }),
    "Invalid command build: timeout must be positive",
  );
  assert.equal(
    validateFrontmatter(parseRalphMarkdown("---\ncommands:\n  - nope\n  - null\n---\nbody").frontmatter),
    "Invalid command entry at index 0",
  );
});

test("runCommands skips blocked commands before shelling out", async () => {
  const calls: string[] = [];
  const pi = {
    exec: async (_tool: string, args: string[]) => {
      calls.push(args.join(" "));
      return { killed: false, stdout: "allowed", stderr: "" };
    },
  } as any;

  const outputs = await runCommands(
    [
      { name: "blocked", run: "git push origin main", timeout: 1 },
      { name: "allowed", run: "echo ok", timeout: 1 },
    ],
    ["git\\s+push"],
    pi,
  );

  assert.deepEqual(outputs, [
    { name: "blocked", output: "[blocked by guardrail: git\\s+push]" },
    { name: "allowed", output: "allowed" },
  ]);
  assert.deepEqual(calls, ["-c echo ok"]);
});

test("legacy RALPH.md drafts bypass the generated-draft validation gate", () => {
  assert.equal(shouldValidateExistingDraft("Task body"), false);

  const draft = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", hasGit: false, topLevelDirs: [], topLevelFiles: [] },
  );
  assert.equal(shouldValidateExistingDraft(draft.content), true);
});

test("render helpers expand placeholders and strip comments", () => {
  const outputs = [{ name: "build", output: "done" }];

  assert.equal(
    resolvePlaceholders("{{ commands.build }} {{ ralph.iteration }} {{ ralph.name }} {{ commands.missing }}", outputs, {
      iteration: 7,
      name: "ralph",
    }),
    "done 7 ralph ",
  );
  assert.equal(renderRalphBody("keep<!-- hidden -->{{ ralph.name }}", [], { iteration: 1, name: "ralph" }), "keepralph");
  assert.equal(renderIterationPrompt("Body", 2, 5), "[ralph: iteration 2/5]\n\nBody");
});

test("parseCommandArgs handles explicit task/path flags and auto mode", () => {
  assert.deepEqual(parseCommandArgs("--task reverse engineer auth"), { mode: "task", value: "reverse engineer auth" });
  assert.deepEqual(parseCommandArgs("--path my-task"), { mode: "path", value: "my-task" });
  assert.deepEqual(parseCommandArgs("--task=fix flaky tests"), { mode: "task", value: "fix flaky tests" });
  assert.deepEqual(parseCommandArgs("  reverse engineer this app  "), { mode: "auto", value: "reverse engineer this app" });
});

test("explicit path mode stays path-centric and does not offer task fallback", async () => {
  const harness = createCommandHarness();
  const handler = harness.handler("ralph");
  const selectOptions: string[][] = [];
  const ctx = {
    cwd: createTempDir(),
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        selectOptions.push(options);
        return "Cancel";
      },
      input: async () => {
        throw new Error("should not prompt for task text");
      },
      notify: () => undefined,
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: true }),
    waitForIdle: async () => undefined,
  };

  await handler("--path reverse engineer auth", ctx);

  assert.deepEqual(selectOptions, [["Draft in that folder", "Cancel"]]);
});

test("path detection and existing-target inspection distinguish runnable Ralph targets from arbitrary markdown", (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  mkdirSync(join(cwd, "task"), { recursive: true });
  mkdirSync(join(cwd, "empty"), { recursive: true });
  writeFileSync(join(cwd, "task", "RALPH.md"), "Task body", "utf8");
  writeFileSync(join(cwd, "README.md"), "not runnable", "utf8");
  writeFileSync(join(cwd, "package.json"), "{}", "utf8");

  assert.equal(looksLikePath("reverse engineer auth"), false);
  assert.equal(looksLikePath("auth-audit"), true);
  assert.equal(looksLikePath("README.md"), true);
  assert.equal(looksLikePath("foo/bar"), true);
  assert.equal(looksLikePath("~draft"), false);

  assert.deepEqual(inspectExistingTarget("task", cwd), { kind: "run", ralphPath: join(cwd, "task", "RALPH.md") });
  assert.deepEqual(inspectExistingTarget("reverse engineer auth", cwd, true), {
    kind: "missing-path",
    dirPath: join(cwd, "reverse engineer auth"),
    ralphPath: join(cwd, "reverse engineer auth", "RALPH.md"),
  });
  assert.deepEqual(inspectExistingTarget("README.md", cwd), { kind: "invalid-markdown", path: join(cwd, "README.md") });
  assert.deepEqual(inspectExistingTarget("package.json", cwd), { kind: "invalid-target", path: join(cwd, "package.json") });
  assert.deepEqual(inspectExistingTarget("empty", cwd), {
    kind: "dir-without-ralph",
    dirPath: join(cwd, "empty"),
    ralphPath: join(cwd, "empty", "RALPH.md"),
  });
  assert.deepEqual(inspectExistingTarget("missing-path", cwd), {
    kind: "missing-path",
    dirPath: join(cwd, "missing-path"),
    ralphPath: join(cwd, "missing-path", "RALPH.md"),
  });
  assert.deepEqual(inspectExistingTarget("foo/bar", cwd), {
    kind: "missing-path",
    dirPath: join(cwd, "foo/bar"),
    ralphPath: join(cwd, "foo/bar", "RALPH.md"),
  });
  assert.deepEqual(inspectExistingTarget("notes.md", cwd), {
    kind: "missing-path",
    dirPath: join(cwd, "notes"),
    ralphPath: join(cwd, "notes", "RALPH.md"),
  });
  assert.deepEqual(inspectExistingTarget("reverse engineer auth", cwd), { kind: "not-path" });
});

test("validateDraftContent rejects missing and malformed frontmatter", () => {
  assert.equal(validateDraftContent("Task body"), "Missing RALPH frontmatter");
  assert.equal(
    validateDraftContent("---\nmax_iterations: 0\n---\nBody"),
    "Invalid max_iterations: must be a positive finite integer",
  );
});

test("buildMissionBrief fails closed when the current draft content is invalid", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  const brief = buildMissionBrief({ ...plan, content: "Task: Fix flaky auth tests\n\nThis draft no longer has frontmatter." });

  assert.match(brief, /Invalid RALPH\.md: Missing RALPH frontmatter/);
  assert.match(brief, /Task metadata missing from current draft|Fix flaky auth tests/);
  assert.doesNotMatch(brief, /Suggested checks/);
  assert.doesNotMatch(brief, /Finish behavior/);
  assert.doesNotMatch(brief, /Safety/);
  assert.doesNotMatch(brief, /tests: npm test/);
  assert.doesNotMatch(brief, /Stop after 25 iterations or \/ralph-stop/);
});

test("slug helpers skip occupied directories when planning siblings", (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  mkdirSync(join(cwd, "reverse-engineer-this-app"), { recursive: true });
  mkdirSync(join(cwd, "reverse-engineer-this-app-2"), { recursive: true });
  mkdirSync(join(cwd, "reverse-engineer-this-app-3"), { recursive: true });

  assert.equal(slugifyTask("Reverse engineer this app!"), "reverse-engineer-this-app");
  assert.equal(slugifyTask("!!!"), "ralph-task");
  assert.equal(
    nextSiblingSlug(
      "reverse-engineer-this-app",
      (slug) => slug === "reverse-engineer-this-app-2" || slug === "reverse-engineer-this-app-3",
    ),
    "reverse-engineer-this-app-4",
  );
  assert.deepEqual(planTaskDraftTarget(cwd, "Reverse engineer this app"), {
    kind: "conflict",
    target: {
      slug: "reverse-engineer-this-app",
      dirPath: join(cwd, "reverse-engineer-this-app"),
      ralphPath: join(cwd, "reverse-engineer-this-app", "RALPH.md"),
    },
  });
  assert.equal(createSiblingTarget(cwd, "reverse-engineer-this-app").slug, "reverse-engineer-this-app-4");
});

test("task classification identifies analysis, fix, migration, and general modes", () => {
  assert.equal(classifyTaskMode("Reverse engineer the billing flow"), "analysis");
  assert.equal(classifyTaskMode("Fix flaky auth tests"), "fix");
  assert.equal(classifyTaskMode("Migrate this package to ESM"), "migration");
  assert.equal(classifyTaskMode("Improve the login page"), "general");
});

test("inspectRepo detects bounded package signals", (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  mkdirSync(join(cwd, ".git"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "package-lock.json"), "{}", "utf8");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "vitest", lint: "eslint ." } }, null, 2),
    "utf8",
  );

  assert.deepEqual(inspectRepo(cwd), {
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: [".git", "src"],
    topLevelFiles: ["package-lock.json", "package.json"],
  });
});

test("generated drafts reparse as valid RALPH files", () => {
  const draft = generateDraft(
    "Reverse engineer this app",
    { slug: "reverse-engineer-this-app", dirPath: "/repo/reverse-engineer-this-app", ralphPath: "/repo/reverse-engineer-this-app/RALPH.md" },
    { packageManager: "npm", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  const reparsed = parseRalphMarkdown(draft.content);
  assert.equal(validateFrontmatter(reparsed.frontmatter), null);
  assert.equal(draft.source, "deterministic");
  assertMetadataSource(extractDraftMetadata(draft.content), "deterministic");
  assert.deepEqual(reparsed.frontmatter.commands, [
    { name: "git-log", run: "git log --oneline -10", timeout: 20 },
    { name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20 },
  ]);
  assert.deepEqual(reparsed.frontmatter, {
    commands: [
      { name: "git-log", run: "git log --oneline -10", timeout: 20 },
      { name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20 },
    ],
    maxIterations: 12,
    timeout: 300,
    completionPromise: undefined,
    guardrails: { blockCommands: ["git\\s+push"], protectedFiles: [] },
    invalidCommandEntries: undefined,
  });
  assert.match(reparsed.body, /Task: Reverse engineer this app/);
  assert.match(reparsed.body, /\{\{ commands.git-log \}\}/);
  assert.match(reparsed.body, /\{\{ ralph.iteration \}\}/);
  assert.equal(extractDraftMetadata(draft.content)?.mode, "analysis");
  assertMetadataSource(extractDraftMetadata(draft.content), "deterministic");
});

test("extractDraftMetadata accepts Phase 1 and Phase 2 metadata", () => {
  const phase1 = `${encodeMetadata({ generator: "pi-ralph-loop", version: 1, task: "Fix flaky auth tests", mode: "fix" })}\n---\ncommands: []\nmax_iterations: 25\ntimeout: 300\nguardrails:\n  block_commands: []\n  protected_files: []\n---\nBody`;
  const phase2 = `${encodeMetadata({ generator: "pi-ralph-loop", version: 2, source: "llm-strengthened", task: "Fix flaky auth tests", mode: "fix" })}\n---\ncommands: []\nmax_iterations: 25\ntimeout: 300\nguardrails:\n  block_commands: []\n  protected_files: []\n---\nBody`;

  assert.deepEqual(extractDraftMetadata(phase1), {
    generator: "pi-ralph-loop",
    version: 1,
    task: "Fix flaky auth tests",
    mode: "fix",
  });
  assert.deepEqual(extractDraftMetadata(phase2), {
    generator: "pi-ralph-loop",
    version: 2,
    source: "llm-strengthened",
    task: "Fix flaky auth tests",
    mode: "fix",
  });
});

test("buildDraftRequest tags deterministic command intents and seeds a baseline draft", () => {
  const repoSignals: RepoSignals = { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] };
  const repoContext = buildRepoContext(repoSignals);
  const request = buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    repoSignals,
    repoContext,
  );

  assert.equal(request.mode, "fix");
  assert.deepEqual(request.repoSignals, repoSignals);
  assert.deepEqual(request.repoContext, repoContext);
  assert.deepEqual(request.repoContext.selectedFiles, [{ path: "package.json", content: "", reason: "top-level file" }]);
  assert.deepEqual(
    request.commandIntent.map(({ name, source }) => ({ name, source })),
    [
      { name: "tests", source: "repo-signal" },
      { name: "lint", source: "repo-signal" },
      { name: "git-log", source: "heuristic" },
    ],
  );
  assertMetadataSource(extractDraftMetadata(request.baselineDraft), "deterministic");
  assert.ok(request.baselineDraft.length > 0);
});

test("normalizeStrengthenedDraft keeps deterministic frontmatter in body-only mode", () => {
  const request = buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
    { summaryLines: ["repo summary"], selectedFiles: [{ path: "package.json", content: "", reason: "top-level file" }] },
  );
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = `${encodeMetadata({ generator: "pi-ralph-loop", version: 2, source: "llm-strengthened", task: "Fix flaky auth tests", mode: "fix" })}\n---\ncommands:\n  - name: rogue\n    run: rm -rf /\n    timeout: 1\nmax_iterations: 1\ntimeout: 1\nguardrails:\n  block_commands:\n    - allow-all\n  protected_files:\n    - tmp/**\n---\nTask: Fix flaky auth tests\n\nRead-only enforced and write protection is enforced.`;

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter.commands, baseline.frontmatter.commands);
  assert.deepEqual(reparsed.frontmatter.guardrails, baseline.frontmatter.guardrails);
  assert.equal(reparsed.body.trimStart(), "Task: Fix flaky auth tests\n\nRead-only enforced and write protection is enforced.");
  assert.deepEqual(extractDraftMetadata(normalized.content), {
    generator: "pi-ralph-loop",
    version: 2,
    source: "llm-strengthened",
    task: "Fix flaky auth tests",
    mode: "fix",
  });
});

test("normalizeStrengthenedDraft applies strengthened commands in body-and-commands mode", () => {
  const request = buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
    { summaryLines: ["repo summary"], selectedFiles: [{ path: "package.json", content: "", reason: "top-level file" }] },
  );
  const strengthenedDraft = `${encodeMetadata({ generator: "pi-ralph-loop", version: 2, source: "llm-strengthened", task: "Fix flaky auth tests", mode: "fix" })}\n---\ncommands:\n  - name: smoke\n    run: npm run smoke\n    timeout: 45\nmax_iterations: 7\ntimeout: 120\nguardrails:\n  block_commands:\n    - git\\s+push\n  protected_files:\n    - .env*\n---\nTask: Fix flaky auth tests\n\nUse the smoke check and keep the output concise.`;

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-and-commands");
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter.commands, [{ name: "smoke", run: "npm run smoke", timeout: 45 }]);
  assert.equal(reparsed.frontmatter.maxIterations, 7);
  assert.deepEqual(reparsed.frontmatter.guardrails, { blockCommands: ["git\\s+push"], protectedFiles: [".env*"] });
  assert.match(reparsed.body, /Use the smoke check and keep the output concise\./);
  assert.deepEqual(extractDraftMetadata(normalized.content), {
    generator: "pi-ralph-loop",
    version: 2,
    source: "llm-strengthened",
    task: "Fix flaky auth tests",
    mode: "fix",
  });
});

test("isWeakStrengthenedDraft rejects unchanged bodies and fake runtime enforcement claims", () => {
  const request = buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
    { summaryLines: ["repo summary"], selectedFiles: [{ path: "package.json", content: "", reason: "top-level file" }] },
  );
  const baselineBody = parseRalphMarkdown(request.baselineDraft).body;
  const unchangedBody = baselineBody;
  const changedBody = `${baselineBody}\n\nAdd concrete verification steps.`;

  assert.equal(isWeakStrengthenedDraft(baselineBody, "analysis text", unchangedBody), true);
  assert.equal(isWeakStrengthenedDraft(baselineBody, "read-only enforced", changedBody), true);
  assert.equal(isWeakStrengthenedDraft(baselineBody, "analysis text", `write protection is enforced\n\n${changedBody}`), true);
  assert.equal(isWeakStrengthenedDraft(baselineBody, "analysis text", changedBody), false);
});

test("generated draft starts fail closed when validation no longer passes", async () => {
  const cwd = createTempDir();
  const targetDir = join(cwd, "generated-draft");
  const ralphPath = join(targetDir, "RALPH.md");
  mkdirSync(targetDir, { recursive: true });
  const draft = generateDraft(
    "Fix flaky auth tests",
    { slug: "generated-draft", dirPath: targetDir, ralphPath },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
  writeFileSync(ralphPath, draft.content.replace("max_iterations: 25", "max_iterations: 0"), "utf8");

  const notifications: Array<{ level: string; message: string }> = [];
  const harness = createCommandHarness();
  const handler = harness.handler("ralph");
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ level, message }),
      select: async () => {
        throw new Error("should not prompt");
      },
      input: async () => {
        throw new Error("should not prompt");
      },
      editor: async () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    newSession: async () => {
      throw new Error("should not start");
    },
    waitForIdle: async () => undefined,
  };

  await handler(`--path ${ralphPath}`, ctx);

  assert.deepEqual(notifications, [{ level: "error", message: "Invalid RALPH.md: Invalid max_iterations: must be a positive finite integer" }]);
});

test("generateDraft creates metadata-rich analysis and fix drafts", () => {
  const analysisDraft = generateDraft(
    "Reverse engineer this app",
    { slug: "reverse-engineer-this-app", dirPath: "/repo/reverse-engineer-this-app", ralphPath: "/repo/reverse-engineer-this-app/RALPH.md" },
    { packageManager: "npm", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
  const analysisParsed = parseRalphMarkdown(analysisDraft.content);
  assert.equal(analysisDraft.mode, "analysis");
  assert.equal(analysisDraft.source, "deterministic");
  assert.equal(extractDraftMetadata(analysisDraft.content)?.mode, "analysis");
  assertMetadataSource(extractDraftMetadata(analysisDraft.content), "deterministic");
  assert.match(analysisDraft.content, /Start with read-only inspection/);
  assert.match(analysisDraft.content, /\{\{ commands.repo-map \}\}/);
  assert.equal(analysisDraft.safetyLabel, "blocks git push");
  assert.deepEqual(analysisParsed.frontmatter.guardrails.protectedFiles, []);
  assert.doesNotMatch(analysisDraft.content, /\*\*\/\*/);
  const analysisBrief = buildMissionBrief(analysisDraft);
  assert.match(analysisBrief, /- blocks git push/);
  assert.doesNotMatch(analysisBrief, /read-only/);

  const fixDraft = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
  const fixParsed = parseRalphMarkdown(fixDraft.content);
  assert.equal(fixDraft.mode, "fix");
  assert.equal(fixDraft.source, "deterministic");
  assert.match(fixDraft.content, /If tests or lint are failing/);
  assert.match(fixDraft.content, /\{\{ commands.tests \}\}/);
  assert.match(fixDraft.content, /\{\{ commands.lint \}\}/);
  assert.equal(extractDraftMetadata(fixDraft.content)?.task, "Fix flaky auth tests");
  assertMetadataSource(extractDraftMetadata(fixDraft.content), "deterministic");
  assert.deepEqual(fixParsed.frontmatter.guardrails.protectedFiles, [SECRET_PATH_POLICY_TOKEN]);
  assert.match(fixDraft.safetyLabel, /secret files/);
});

test("generated draft metadata survives task text containing HTML comment markers", () => {
  const task = "Reverse engineer the parser <!-- tricky --> and document the edge case";
  const draft = generateDraft(
    task,
    {
      slug: "reverse-engineer-the-parser-and-document-the-edge-case",
      dirPath: "/repo/reverse-engineer-the-parser-and-document-the-edge-case",
      ralphPath: "/repo/reverse-engineer-the-parser-and-document-the-edge-case/RALPH.md",
    },
    { packageManager: "npm", hasGit: false, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
  const parsed = parseRalphMarkdown(draft.content);

  assert.equal(extractDraftMetadata(draft.content)?.task, task);
  assert.equal(validateDraftContent(draft.content), null);
  assert.match(draft.content, /Task: Reverse engineer the parser &lt;!-- tricky --&gt; and document the edge case/);
  assert.match(parsed.body, /Task: Reverse engineer the parser &lt;!-- tricky --&gt; and document the edge case/);
  const rendered = renderRalphBody(parsed.body, [], { iteration: 1, name: "ralph" });
  assert.match(rendered, /Task: Reverse engineer the parser &lt;!-- tricky --&gt; and document the edge case/);
  assert.doesNotMatch(rendered, /<!-- tricky -->/);
});

test("buildMissionBrief refreshes after draft edits", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: false, topLevelDirs: [], topLevelFiles: [] },
  );
  const editedPlan = {
    ...plan,
    content: plan.content
      .replace("Task: Fix flaky auth tests", "Task: Fix flaky auth regressions")
      .replace("name: tests\n    run: npm test\n    timeout: 120", "name: smoke\n    run: npm run smoke\n    timeout: 45")
      .replace("max_iterations: 25", "max_iterations: 7"),
  };

  const brief = buildMissionBrief(editedPlan);
  assert.match(brief, /Mission Brief/);
  assert.match(brief, /Fix flaky auth regressions/);
  assert.doesNotMatch(brief, /Fix flaky auth tests/);
  assert.match(brief, /smoke: npm run smoke/);
  assert.match(brief, /Stop after 7 iterations or \/ralph-stop/);
  assert.doesNotMatch(brief, /tests: npm test/);
});
