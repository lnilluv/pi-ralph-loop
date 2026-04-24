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
  acceptStrengthenedDraft,
  normalizeStrengthenedDraft,
  inspectDraftContent,
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
  resolveCommandRun,
  runtimeArgEntriesToMap,
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

function makeFixRequest() {
  return buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
}

function makeCommandIntentRequest(signals: Partial<RepoSignals>) {
  return buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    {
      packageManager: "npm",
      hasGit: false,
      topLevelDirs: ["src"],
      topLevelFiles: ["package.json"],
      ...signals,
    },
  );
}

function makeFixRequestWithArgs(args: readonly string[]) {
  const request = makeFixRequest();
  return {
    ...request,
    baselineDraft: request.baselineDraft.replace(`commands:\n`, `args:\n  - ${args.join("\n  - ")}\ncommands:\n`),
  };
}

function makeFixRequestWithCompletionPromise(completionPromise: string) {
  const request = makeFixRequest();
  return {
    ...request,
    baselineDraft: request.baselineDraft.replace("timeout: 300\n", `completion_promise: ${completionPromise}\ntimeout: 300\n`),
  };
}

function makeStrengthenedDraft(frontmatterLines: readonly string[], body: string, task = "Fix flaky auth tests") {
  return `${encodeMetadata({ generator: "pi-ralph-loop", version: 2, source: "llm-strengthened", task, mode: "fix" })}\n---\n${frontmatterLines.join("\n")}\n---\n${body}`;
}

test("parseRalphMarkdown falls back to default frontmatter when no frontmatter is present", () => {
  const parsed = parseRalphMarkdown("hello\nworld");

  assert.deepEqual(parsed.frontmatter, defaultFrontmatter());
  assert.equal(parsed.body, "hello\nworld");
});

test("parseRalphMarkdown parses frontmatter and normalizes line endings", () => {
  const parsed = parseRalphMarkdown(
    "\uFEFF---\r\ncommands:\r\n  - name: build\r\n    run: npm test\r\n    timeout: 15\r\nmax_iterations: 3\r\ninter_iteration_delay: 7\r\ntimeout: 12.5\r\nrequired_outputs:\r\n  - docs/ARCHITECTURE.md\r\ncompletion_promise: done\r\ncompletion_gate: optional\r\nguardrails:\r\n  block_commands:\r\n    - rm .*\r\n  protected_files:\r\n    - src/**\r\n---\r\nBody\r\n",
  );

  assert.deepEqual(parsed.frontmatter, {
    commands: [{ name: "build", run: "npm test", timeout: 15 }],
    maxIterations: 3,
    interIterationDelay: 7,
    timeout: 12.5,
    completionPromise: "done",
    completionGate: "optional",
    requiredOutputs: ["docs/ARCHITECTURE.md"],
    stopOnError: true,
    guardrails: { blockCommands: ["rm .*"], protectedFiles: ["src/**"] },
    invalidCommandEntries: undefined,
  });
  assert.equal(parsed.body, "Body\n");
});

test("parseRalphMarkdown parses declared args as runtime parameters", () => {
  const parsed = parseRalphMarkdown(
    "---\nargs:\n  - owner\n  - mode\ncommands: []\nmax_iterations: 1\ntimeout: 1\nguardrails:\n  block_commands: []\n  protected_files: []\n---\nBody\n",
  );

  assert.deepEqual(parsed.frontmatter.args, ["owner", "mode"]);
  assert.equal(validateFrontmatter(parsed.frontmatter), null);
});

test("parseRalphMarkdown parses stop_on_error from frontmatter", () => {
  const parsed = parseRalphMarkdown("---\nstop_on_error: false\nmax_iterations: 5\ntimeout: 60\ncommands: []\nguardrails: { block_commands: [], protected_files: [] }\n---\nTask\n");
  assert.equal(parsed.frontmatter.stopOnError, false);
});

test("parseRalphMarkdown defaults stop_on_error to true", () => {
  const parsed = parseRalphMarkdown("---\nmax_iterations: 5\ntimeout: 60\ncommands: []\nguardrails: { block_commands: [], protected_files: [] }\n---\nTask\n");
  assert.equal(parsed.frontmatter.stopOnError, true);
});

test("parseRalphMarkdown treats non-false stop_on_error as true (safe default)", () => {
  const parsed = parseRalphMarkdown("---\nstop_on_error: yes\nmax_iterations: 5\ntimeout: 60\ncommands: []\nguardrails: { block_commands: [], protected_files: [] }\n---\nTask\n");
  assert.equal(parsed.frontmatter.stopOnError, true);
});

test("validateFrontmatter accepts valid input and rejects invalid bounds, names, args, and globs", () => {
  assert.equal(validateFrontmatter(defaultFrontmatter()), null);
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), args: ["owner"] }),
    null,
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), args: ["owner", "owner"] }),
    "Invalid args: names must be unique",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), args: ["build now"] }),
    "Invalid arg name: build now must match ^\\w[\\w-]*$",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), maxIterations: 0 }),
    "Invalid max_iterations: must be between 1 and 50",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), maxIterations: 51 }),
    "Invalid max_iterations: must be between 1 and 50",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), interIterationDelay: 3 }),
    null,
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), interIterationDelay: -1 }),
    "Invalid inter_iteration_delay: must be a non-negative integer",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), interIterationDelay: 1.5 }),
    "Invalid inter_iteration_delay: must be a non-negative integer",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), timeout: 0 }),
    "Invalid timeout: must be greater than 0 and at most 300",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), timeout: 301 }),
    "Invalid timeout: must be greater than 0 and at most 300",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), guardrails: { blockCommands: ["["], protectedFiles: [] } }),
    "Invalid block_commands regex: [",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), guardrails: { blockCommands: [], protectedFiles: ["**/*"] } }),
    "Invalid protected_files glob: **/*",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "", run: "echo ok", timeout: 1 }] }),
    "Invalid command: name is required",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build now", run: "echo ok", timeout: 1 }] }),
    "Invalid command name: build now must match ^\\w[\\w-]*$",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build", run: "", timeout: 1 }] }),
    "Invalid command build: run is required",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build", run: "echo ok", timeout: 0 }] }),
    "Invalid command build: timeout must be greater than 0 and at most 300",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), commands: [{ name: "build", run: "echo ok", timeout: 301 }] }),
    "Invalid command build: timeout must be greater than 0 and at most 300",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), timeout: 20, commands: [{ name: "build", run: "echo ok", timeout: 21 }] }),
    "Invalid command build: timeout must not exceed top-level timeout",
  );
  assert.equal(
    validateFrontmatter(parseRalphMarkdown("---\ncommands:\n  - nope\n  - null\n---\nbody").frontmatter),
    "Invalid command entry at index 0",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: [""] }),
    "Invalid required_outputs entry:  must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["/abs.md"] }),
    "Invalid required_outputs entry: /abs.md must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["../oops.md"] }),
    "Invalid required_outputs entry: ../oops.md must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["docs/"] }),
    "Invalid required_outputs entry: docs/ must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["./file.md"] }),
    "Invalid required_outputs entry: ./file.md must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["docs/./guide.md"] }),
    "Invalid required_outputs entry: docs/./guide.md must be a relative file path",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), requiredOutputs: ["docs/\nREADME.md"] }),
    "Invalid required_outputs entry: docs/\nREADME.md must be a relative file path",
  );
});

test("validateFrontmatter accepts stop_on_error true and false", () => {
  const fmTrue = { ...defaultFrontmatter(), stopOnError: true };
  const fmFalse = { ...defaultFrontmatter(), stopOnError: false };
  assert.equal(validateFrontmatter(fmTrue), null);
  assert.equal(validateFrontmatter(fmFalse), null);
  assert.equal(validateFrontmatter({ ...defaultFrontmatter(), completionGate: "required" }), null);
});

test("validateFrontmatter rejects unsafe completion_promise values and Mission Brief fails closed", () => {
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), completionPromise: "ready\nnow" }),
    "Invalid completion_promise: must be a single-line string without line breaks or angle brackets",
  );
  assert.equal(
    validateFrontmatter({ ...defaultFrontmatter(), completionPromise: "<promise>ready</promise>" }),
    "Invalid completion_promise: must be a single-line string without line breaks or angle brackets",
  );

  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );
  const brief = buildMissionBrief({
    ...plan,
    content: plan.content.replace(
      "timeout: 300\n",
      "timeout: 45\ncompletion_promise: |\n  ready\n  now\n",
    ),
  });

  assert.match(brief, /^Mission Brief/m);
  assert.match(brief, /Invalid RALPH\.md: Invalid completion_promise: must be a single-line string without line breaks or angle brackets/);
  assert.match(brief, /^Draft status$/m);
  assert.doesNotMatch(brief, /Finish behavior/);
  assert.doesNotMatch(brief, /<promise>/);
});

test("inspectDraftContent, validateDraftContent, and Mission Brief fail closed on raw invalid completion_promise values", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  for (const [label, rawValue] of [
    ["array", "completion_promise: [oops]"],
    ["number", "completion_promise: 7"],
    ["blank string", 'completion_promise: ""'],
  ] as const) {
    const raw = plan.content.replace("timeout: 300\n", `${rawValue}\ntimeout: 300\n`);

    assert.equal(
      inspectDraftContent(raw).error,
      "Invalid completion_promise: must be a single-line string without line breaks or angle brackets",
      label,
    );
    assert.equal(
      validateDraftContent(raw),
      "Invalid completion_promise: must be a single-line string without line breaks or angle brackets",
      label,
    );

    const brief = buildMissionBrief({ ...plan, content: raw });
    assert.match(brief, /^Mission Brief/m, label);
    assert.match(brief, /Invalid RALPH\.md: Invalid completion_promise: must be a single-line string without line breaks or angle brackets/, label);
    assert.doesNotMatch(brief, /Finish behavior/, label);
    assert.doesNotMatch(brief, /<promise>/, label);
  }
});

test("inspectDraftContent rejects completion_gate values that are the wrong type or invalid", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  const wrongType = plan.content.replace("timeout: 300\n", "completion_gate: [required]\ntimeout: 300\n");
  assert.equal(inspectDraftContent(wrongType).error, "Invalid RALPH frontmatter: completion_gate must be a YAML string");

  const invalidValue = plan.content.replace("timeout: 300\n", "completion_gate: maybe\ntimeout: 300\n");
  assert.equal(inspectDraftContent(invalidValue).error, "Invalid completion_gate: must be required, optional, or disabled");
});

test("acceptStrengthenedDraft rejects required_outputs changes", () => {
  const request = makeFixRequest();
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "commands:",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 20",
      "max_iterations: 20",
      "timeout: 120",
      "required_outputs:",
      "  - ARCHITECTURE.md",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nKeep the change small.",
  );

  assert.equal(acceptStrengthenedDraft(request, strengthenedDraft), null);
});

test("inspectDraftContent, validateDraftContent, and Mission Brief fail closed on raw malformed guardrails values", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  for (const { label, frontmatterLines, expectedError, briefError } of [
    {
      label: "block_commands scalar",
      frontmatterLines: [
        "commands: []",
        "max_iterations: 25",
        "timeout: 300",
        "guardrails:",
        "  block_commands: 'git\\s+push'",
        "  protected_files: []",
      ],
      expectedError: "Invalid RALPH frontmatter: guardrails.block_commands must be a YAML sequence",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: guardrails\.block_commands must be a YAML sequence/,
    },
    {
      label: "block_commands null",
      frontmatterLines: [
        "commands: []",
        "max_iterations: 25",
        "timeout: 300",
        "guardrails:",
        "  block_commands: null",
        "  protected_files: []",
      ],
      expectedError: "Invalid RALPH frontmatter: guardrails.block_commands must be a YAML sequence",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: guardrails\.block_commands must be a YAML sequence/,
    },
    {
      label: "protected_files scalar",
      frontmatterLines: [
        "commands: []",
        "max_iterations: 25",
        "timeout: 300",
        "guardrails:",
        "  block_commands: []",
        "  protected_files: 'src/generated/**'",
      ],
      expectedError: "Invalid RALPH frontmatter: guardrails.protected_files must be a YAML sequence",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: guardrails\.protected_files must be a YAML sequence/,
    },
    {
      label: "protected_files null",
      frontmatterLines: [
        "commands: []",
        "max_iterations: 25",
        "timeout: 300",
        "guardrails:",
        "  block_commands: []",
        "  protected_files: null",
      ],
      expectedError: "Invalid RALPH frontmatter: guardrails.protected_files must be a YAML sequence",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: guardrails\.protected_files must be a YAML sequence/,
    },
  ] as const) {
    const raw = makeStrengthenedDraft(frontmatterLines, "Task: Fix flaky auth tests\n\nKeep the change small.");
    const inspection = inspectDraftContent(raw);

    assert.equal(inspection.error, expectedError, label);
    assert.equal(validateDraftContent(raw), expectedError, label);

    const brief = buildMissionBrief({ ...plan, content: raw });
    assert.match(brief, /^Mission Brief/m, label);
    assert.match(brief, briefError, label);
    assert.doesNotMatch(brief, /Finish behavior/, label);
    assert.doesNotMatch(brief, /<promise>/, label);
  }
});

test("acceptStrengthenedDraft rejects raw malformed guardrails shapes", () => {
  const request = makeFixRequest();

  for (const { label, frontmatterLines } of [
    {
      label: "block_commands scalar",
      frontmatterLines: [
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 20",
        "timeout: 120",
        "guardrails:",
        "  block_commands: 'git\\s+push'",
        "  protected_files:",
        `    - '${SECRET_PATH_POLICY_TOKEN}'`,
      ],
    },
    {
      label: "protected_files scalar",
      frontmatterLines: [
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 20",
        "timeout: 120",
        "guardrails:",
        "  block_commands:",
        "    - 'git\\s+push'",
        "  protected_files: 'src/generated/**'",
      ],
    },
  ] as const) {
    const strengthenedDraft = makeStrengthenedDraft(frontmatterLines, "Task: Fix flaky auth tests\n\nKeep the change small.");

    assert.equal(acceptStrengthenedDraft(request, strengthenedDraft), null, label);
  }
});

test("runCommands skips blocked commands before shelling out", async () => {
  const calls: string[] = [];
  const proofEntries: Array<{ customType: string; data: any }> = [];
  const pi = {
    appendEntry: (customType: string, data: any) => {
      proofEntries.push({ customType, data });
    },
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
  assert.equal(proofEntries.length, 1);
  assert.equal(proofEntries[0].customType, "ralph-blocked-command");
  assert.equal(proofEntries[0].data.command, "git push origin main");
});

test("runCommands resolves args before shelling out", async () => {
  const calls: string[] = [];
  const pi = {
    exec: async (_tool: string, args: string[]) => {
      calls.push(args.join(" "));
      return { killed: false, stdout: "ok", stderr: "" };
    },
  } as any;

  const outputs = await runCommands(
    [{ name: "greet", run: "echo {{ args.owner }}", timeout: 1 }],
    [],
    pi,
    { owner: "Ada" },
  );

  assert.deepEqual(outputs, [{ name: "greet", output: "ok" }]);
  assert.deepEqual(calls, ["-c echo 'Ada'"]);
});

test("runCommands blocks anchored guardrails even when the first token comes from an arg", async () => {
  const pi = {
    exec: async () => {
      throw new Error("should not execute blocked command");
    },
  } as any;

  const outputs = await runCommands(
    [{ name: "blocked", run: "{{ args.tool }} hello", timeout: 1 }],
    ["^printf\\b"],
    pi,
    { tool: "printf" },
  );

  assert.deepEqual(outputs, [{ name: "blocked", output: "[blocked by guardrail: ^printf\\b]" }]);
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

test("inspectDraftContent rejects malformed args frontmatter shapes", () => {
  const invalid = inspectDraftContent(["---", "args: owner", "commands: []", "max_iterations: 1", "timeout: 1", "guardrails:", "  block_commands: []", "  protected_files: []", "---", "Body"].join("\n"));

  assert.equal(invalid.error, "Invalid RALPH frontmatter: args must be a YAML sequence");
});

test("inspectDraftContent rejects malformed inter_iteration_delay frontmatter shapes", () => {
  const invalid = inspectDraftContent(["---", "commands: []", "max_iterations: 1", "inter_iteration_delay: true", "timeout: 1", "guardrails:", "  block_commands: []", "  protected_files: []", "---", "Body"].join("\n"));

  assert.equal(invalid.error, "Invalid RALPH frontmatter: inter_iteration_delay must be a YAML number");
});

test("render helpers expand placeholders, keep body text plain, and shell-quote command args", () => {
  const outputs = [{ name: "build", output: "done" }];

  assert.equal(
    resolvePlaceholders("{{ commands.build }} {{ ralph.iteration }} {{ ralph.name }} {{ ralph.max_iterations }} {{ args.owner }} {{ commands.missing }}", outputs, {
      iteration: 7,
      name: "ralph",
      maxIterations: 12,
    }, { owner: "Ada" }),
    "done 7 ralph 12 Ada ",
  );
  assert.equal(
    renderRalphBody("keep<!-- hidden -->{{ args.owner }}{{ ralph.name }}", [], { iteration: 1, name: "ralph", maxIterations: 1 }, { owner: "Ada; echo injected" }),
    "keepAda; echo injectedralph",
  );
  assert.equal(resolveCommandRun("npm run {{ args.script }}", { script: "test" }), "npm run 'test'");
  assert.equal(resolveCommandRun("echo {{ args.owner }}", { owner: "Ada; echo injected" }), "echo 'Ada; echo injected'");
  assert.throws(() => resolveCommandRun("npm run {{ args.missing }}", { script: "test" }), /Missing required arg: missing/);
  assert.equal(renderIterationPrompt("Body", 2, 5), "[ralph: iteration 2/5]\n\nBody");
});

test("resolvePlaceholders leaves command output placeholders literal", () => {
  const outputs = [{ name: "build", output: "echo {{ args.owner }}" }];

  assert.equal(
    resolvePlaceholders("{{ commands.build }} {{ args.owner }}", outputs, {
      iteration: 7,
      name: "ralph",
      maxIterations: 12,
    }, { owner: "Ada" }),
    "echo {{ args.owner }} Ada",
  );
});

test("renderIterationPrompt includes completion-gate reminders and previous failure reasons", () => {
  const prompt = renderIterationPrompt("Body", 2, 5, {
    completionPromise: "DONE",
    requiredOutputs: ["ARCHITECTURE.md", "OPEN_QUESTIONS.md"],
    failureReasons: ["Missing required output: ARCHITECTURE.md", "OPEN_QUESTIONS.md still has P0 items"],
  });

  assert.match(prompt, /Required outputs must exist before stopping: ARCHITECTURE\.md, OPEN_QUESTIONS\.md/);
  assert.match(prompt, /OPEN_QUESTIONS\.md must have no remaining P0\/P1 items before stopping\./);
  assert.match(prompt, /Label inferred claims as HYPOTHESIS\./);
  assert.match(prompt, /Previous gate failures: Missing required output: ARCHITECTURE\.md; OPEN_QUESTIONS\.md still has P0 items/);
  assert.match(prompt, /Emit <promise>DONE<\/promise> only when the gate is truly satisfied\./);
});

test("renderIterationPrompt handles optional and disabled completion gates", () => {
  const optionalPrompt = renderIterationPrompt("Body", 2, 5, {
    completionPromise: "DONE",
    requiredOutputs: ["ARCHITECTURE.md"],
    completionGateMode: "optional",
  });

  assert.match(optionalPrompt, /Completion gate is advisory: ARCHITECTURE\.md/);
  assert.match(optionalPrompt, /OPEN_QUESTIONS\.md should have no remaining P0\/P1 items before stopping\./);
  assert.match(optionalPrompt, /Emit <promise>DONE<\/promise> once the work is complete, even if advisory outputs are still missing\./);

  const disabledPrompt = renderIterationPrompt("Body", 2, 5, {
    completionPromise: "DONE",
    requiredOutputs: ["ARCHITECTURE.md"],
    completionGateMode: "disabled",
  });

  assert.equal(disabledPrompt, "[ralph: iteration 2/5]\n\nBody");
});

test("renderIterationPrompt includes a rejection section when durable progress is still missing", () => {
  const prompt = renderIterationPrompt("Body", 2, 5, {
    completionPromise: "DONE",
    requiredOutputs: ["ARCHITECTURE.md"],
    rejectionReasons: ["durable progress"],
  });

  assert.match(prompt, /\[completion gate rejection\]/);
  assert.match(prompt, /Still missing: durable progress/);
  assert.match(prompt, /Emit <promise>DONE<\/promise> only when the gate is truly satisfied\./);
});

test("parseCommandArgs handles explicit path args, leaves task text alone, and rejects task args", () => {
  assert.deepEqual(parseCommandArgs("--path my-task"), { mode: "path", value: "my-task", runtimeArgs: [], error: undefined });
  assert.deepEqual(parseCommandArgs("--path my-task --arg owner=Ada --arg mode=fix"), {
    mode: "path",
    value: "my-task",
    runtimeArgs: [
      { name: "owner", value: "Ada" },
      { name: "mode", value: "fix" },
    ],
    error: undefined,
  });
  assert.deepEqual(parseCommandArgs("  reverse engineer this app  "), { mode: "auto", value: "reverse engineer this app", runtimeArgs: [], error: undefined });
  assert.deepEqual(parseCommandArgs("reverse engineer --arg name=value literally"), {
    mode: "auto",
    value: "reverse engineer --arg name=value literally",
    runtimeArgs: [],
    error: undefined,
  });
  assert.deepEqual(parseCommandArgs("--path my --argument task"), {
    mode: "path",
    value: "my --argument task",
    runtimeArgs: [],
    error: undefined,
  });
  assert.equal(parseCommandArgs("--task reverse engineer auth --arg owner=Ada").error, "--arg is only supported with /ralph --path");
});

test("parseCommandArgs parses quoted explicit-path args and preserves literal equals", () => {
  assert.deepEqual(parseCommandArgs('--path my-task --arg owner="Ada Lovelace"'), {
    mode: "path",
    value: "my-task",
    runtimeArgs: [{ name: "owner", value: "Ada Lovelace" }],
    error: undefined,
  });
  assert.deepEqual(parseCommandArgs("--path my-task --arg team='core infra' --arg note='a=b=c'"), {
    mode: "path",
    value: "my-task",
    runtimeArgs: [
      { name: "team", value: "core infra" },
      { name: "note", value: "a=b=c" },
    ],
    error: undefined,
  });
  assert.equal(parseCommandArgs('--path my-task --arg owner="Ada Lovelace" --arg owner=\'Ada Smith\'').error, "Duplicate --arg: owner");
});

test("parseCommandArgs rejects malformed explicit-path args", () => {
  assert.equal(parseCommandArgs("--path my-task --arg owner=").error, "Invalid --arg entry: value is required");
  assert.equal(parseCommandArgs("--path my-task --arg =Ada").error, "Invalid --arg entry: name is required");
  assert.equal(
    parseCommandArgs("--path my-task --arg owner=Ada Lovelace").error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs("--path my-task --arg owner=Ada extra text").error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs("--path my-task --arg=name=value").error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs("--path my-task --argowner=Ada").error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs('--path my-task --arg owner="Ada"extra').error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs('--path my-task --arg owner="Ada"--arg team=core').error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs('--path my-task --arg owner=pre"Ada Lovelace"post').error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
  assert.equal(
    parseCommandArgs("--path my-task --arg owner='Ada'--arg team=core").error,
    "Invalid --arg syntax: values must be a single token and no trailing text is allowed",
  );
});

test("runtimeArgEntriesToMap preserves special arg names and command substitution can read them", () => {
  const parsed = parseCommandArgs("--path my-task --arg __proto__=safe");
  assert.equal(parsed.error, undefined);

  const mapped = runtimeArgEntriesToMap(parsed.runtimeArgs);
  assert.equal(mapped.error, undefined);
  assert.equal(Object.getPrototypeOf(mapped.runtimeArgs), null);
  assert.deepEqual(Object.keys(mapped.runtimeArgs), ["__proto__"]);
  assert.equal(resolveCommandRun("echo {{ args.__proto__ }}", mapped.runtimeArgs), "echo 'safe'");
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
    "Invalid max_iterations: must be between 1 and 50",
  );
});

test("validateDraftContent fails closed on YAML frontmatter that is not a mapping", () => {
  assert.equal(validateDraftContent("---\n- nope\n---\nBody"), "Invalid RALPH frontmatter: Frontmatter must be a YAML mapping");
});

test("inspectDraftContent and validateDraftContent fail closed on raw malformed frontmatter shapes and scalars", () => {
  const makeRawDraft = (frontmatterLines: readonly string[]) => `---\n${frontmatterLines.join("\n")}\n---\nTask: Fix flaky auth tests\n\nKeep the change small.`;

  for (const { label, raw, expectedError } of [
    {
      label: "commands mapping",
      raw: makeRawDraft([
        "commands:",
        "  name: tests",
        "  run: npm test",
        "  timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
      ]),
      expectedError: "Invalid RALPH frontmatter: commands must be a YAML sequence",
    },
    {
      label: "max_iterations boolean",
      raw: makeRawDraft(["commands: []", "max_iterations: true", "timeout: 300"]),
      expectedError: "Invalid RALPH frontmatter: max_iterations must be a YAML number",
    },
    {
      label: "timeout boolean",
      raw: makeRawDraft(["commands: []", "max_iterations: 2", "timeout: true"]),
      expectedError: "Invalid RALPH frontmatter: timeout must be a YAML number",
    },
    {
      label: "command name array",
      raw: makeRawDraft([
        "commands:",
        "  - name:",
        "      - build",
        "    run: npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
      ]),
      expectedError: "Invalid RALPH frontmatter: commands[0].name must be a YAML string",
    },
    {
      label: "command run array",
      raw: makeRawDraft([
        "commands:",
        "  - name: build",
        "    run:",
        "      - npm test",
        "    timeout: 20",
        "max_iterations: 2",
        "timeout: 300",
      ]),
      expectedError: "Invalid RALPH frontmatter: commands[0].run must be a YAML string",
    },
    {
      label: "command timeout array",
      raw: makeRawDraft([
        "commands:",
        "  - name: build",
        "    run: npm test",
        "    timeout:",
        "      - 20",
        "max_iterations: 2",
        "timeout: 300",
      ]),
      expectedError: "Invalid RALPH frontmatter: commands[0].timeout must be a YAML number",
    },
  ] as const) {
    assert.equal(inspectDraftContent(raw).error, expectedError, label);
    assert.equal(validateDraftContent(raw), expectedError, label);
  }
});

test("inspectDraftContent, validateDraftContent, and Mission Brief fail closed on raw malformed required_outputs values", () => {
  const plan = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    { packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src"], topLevelFiles: ["package.json"] },
  );

  for (const { label, rawValue, expectedError, briefError } of [
    {
      label: "required_outputs scalar",
      rawValue: "required_outputs: docs/ARCHITECTURE.md",
      expectedError: "Invalid RALPH frontmatter: required_outputs must be a YAML sequence",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: required_outputs must be a YAML sequence/,
    },
    {
      label: "required_outputs entry number",
      rawValue: "required_outputs:\n  - 123",
      expectedError: "Invalid RALPH frontmatter: required_outputs[0] must be a YAML string",
      briefError: /Invalid RALPH\.md: Invalid RALPH frontmatter: required_outputs\[0\] must be a YAML string/,
    },
  ] as const) {
    const raw = plan.content.replace("timeout: 300\n", `${rawValue}\ntimeout: 300\n`);

    assert.equal(inspectDraftContent(raw).error, expectedError, label);
    assert.equal(validateDraftContent(raw), expectedError, label);

    const brief = buildMissionBrief({ ...plan, content: raw });
    assert.match(brief, /^Mission Brief/m, label);
    assert.match(brief, briefError, label);
    assert.doesNotMatch(brief, /Finish behavior/, label);
    assert.doesNotMatch(brief, /<promise>/, label);
  }
});


test("inspectDraftContent and validateDraftContent reject metadata-tagged generated drafts with malformed commands mappings", () => {
  const raw = makeStrengthenedDraft(
    [
      "commands:",
      "  name: tests",
      "  run: npm test",
      "  timeout: 20",
      "max_iterations: 20",
      "timeout: 120",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nKeep the change small.",
  );

  assert.equal(inspectDraftContent(raw).error, "Invalid RALPH frontmatter: commands must be a YAML sequence");
  assert.equal(validateDraftContent(raw), "Invalid RALPH frontmatter: commands must be a YAML sequence");
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
    JSON.stringify({
      name: "demo",
      scripts: {
        test: "vitest",
        typecheck: "tsc --noEmit",
        check: "npm run lint:check",
        build: "vite build",
        verify: "scripts/verify.sh",
        lint: "eslint .",
      },
    }, null, 2),
    "utf8",
  );

  assert.deepEqual(inspectRepo(cwd), {
    packageManager: "npm",
    testCommand: "npm test",
    typecheckCommand: "npm run typecheck",
    checkCommand: "npm run check",
    buildCommand: "npm run build",
    verifyCommand: "npm run verify",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: [".git", "src"],
    topLevelFiles: ["package-lock.json", "package.json"],
  });
});

test("inspectRepo uses yarn run for check scripts in yarn projects", () => {
  const cwd = createTempDir();
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        scripts: {
          check: "eslint .",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(cwd, "yarn.lock"), "", "utf8");

  assert.deepEqual(inspectRepo(cwd), {
    packageManager: "yarn",
    checkCommand: "yarn run check",
    hasGit: false,
    topLevelDirs: [],
    topLevelFiles: ["package.json", "yarn.lock"],
  });
});

test("buildDraftRequest includes verify when verify is the only repo signal", () => {
  const request = makeCommandIntentRequest({ verifyCommand: "npm run verify" });

  assert.deepEqual(request.commandIntent.map(({ name, run }) => ({ name, run })), [
    { name: "verify", run: "npm run verify" },
  ]);
});

test("buildDraftRequest uses check when check is the only repo signal", () => {
  const request = makeCommandIntentRequest({ checkCommand: "npm run check" });

  assert.deepEqual(request.commandIntent.map(({ name, run }) => ({ name, run })), [
    { name: "check", run: "npm run check" },
  ]);
});

test("buildDraftRequest prefers typecheck over check when both are present", () => {
  const request = makeCommandIntentRequest({ typecheckCommand: "npm run typecheck", checkCommand: "npm run check" });

  assert.deepEqual(request.commandIntent.map(({ name, run }) => ({ name, run })), [
    { name: "typecheck", run: "npm run typecheck" },
  ]);
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
    interIterationDelay: 0,
    timeout: 300,
    completionPromise: undefined,
    requiredOutputs: [],
    stopOnError: true,
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

test("normalizeStrengthenedDraft keeps declared args placeholders in body-only mode", () => {
  const request = makeFixRequestWithArgs(["owner"]);
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "args:",
      "  - mode",
      "commands:",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 20",
      "max_iterations: 25",
      "timeout: 300",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nUse {{ args.owner }} to scope the fix.",
  );

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  const { args: _args, ...baselineFrontmatter } = baseline.frontmatter;
  assert.deepEqual(reparsed.frontmatter, baselineFrontmatter);
  assert.equal(reparsed.body.trimStart(), "Task: Fix flaky auth tests\n\nUse {{ args.owner }} to scope the fix.");
});

test("normalizeStrengthenedDraft falls back to the baseline body when body-only args placeholders are undeclared", () => {
  const request = makeFixRequestWithArgs(["owner"]);
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "args:",
      "  - mode",
      "commands:",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 20",
      "max_iterations: 25",
      "timeout: 300",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nUse {{ args.mode }} to scope the fix.",
  );

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  const { args: _args, ...baselineFrontmatter } = baseline.frontmatter;
  assert.deepEqual(reparsed.frontmatter, baselineFrontmatter);
  assert.equal(reparsed.body.trimStart(), baseline.body.trimStart());
});

test("normalizeStrengthenedDraft falls back to the baseline body when body-only frontmatter is invalid", () => {
  const request = makeFixRequest();
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "commands:",
      "  name: rogue",
      "  run: rm -rf /",
      "  timeout: 1",
      "max_iterations: 20",
      "timeout: 120",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nRead-only enforced and write protection is enforced.",
  );

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter, baseline.frontmatter);
  assert.equal(reparsed.body.trimStart(), baseline.body.trimStart());
});

test("normalizeStrengthenedDraft falls back to the baseline body when body-only YAML syntax is malformed", () => {
  const request = makeFixRequest();
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "commands: [",
      "max_iterations: 20",
      "timeout: 120",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nRead-only enforced and write protection is enforced.",
  );

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter, baseline.frontmatter);
  assert.equal(reparsed.body.trimStart(), baseline.body.trimStart());
});

test("normalizeStrengthenedDraft applies strengthened commands in body-and-commands mode", () => {
  const request = makeFixRequest();
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "commands:",
      "  - name: git-log",
      "    run: git log --oneline -10",
      "    timeout: 15",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 45",
      "max_iterations: 20",
      "timeout: 120",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nUse {{ commands.tests }} and {{ commands.git-log }}.\n\nIteration {{ ralph.iteration }} of {{ ralph.name }}.",
  );

  const accepted = acceptStrengthenedDraft(request, strengthenedDraft);
  if (!accepted) {
    assert.fail("expected strengthened draft to be accepted");
  }

  const normalized = normalizeStrengthenedDraft(request, strengthenedDraft, "body-and-commands");
  assert.equal(normalized.content, accepted.content);
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter.commands, [
    { name: "git-log", run: "git log --oneline -10", timeout: 15 },
    { name: "tests", run: "npm test", timeout: 45 },
  ]);
  assert.equal(reparsed.frontmatter.maxIterations, 20);
  assert.equal(reparsed.frontmatter.timeout, 120);
  assert.deepEqual(reparsed.frontmatter.guardrails, baseline.frontmatter.guardrails);
  assert.equal(validateFrontmatter(reparsed.frontmatter), null);
  assert.match(reparsed.body, /Use \{\{ commands\.tests \}\} and \{\{ commands\.git-log \}\}\./);
});

test("acceptStrengthenedDraft rejects malformed commands frontmatter shapes", () => {
  const request = makeFixRequest();
  const body = "Task: Fix flaky auth tests\n\nKeep the change small.";

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  name: tests",
          "  run: npm test",
          "  timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft rejects invented, renamed, swapped, and duplicate commands", () => {
  const request = makeFixRequest();
  const body = "Task: Fix flaky auth tests\n\nKeep the change small.";

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: smoke",
          "    run: npm run smoke",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: unit-tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: tests",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: git-log",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft rejects placeholder drift, increased limits, and command-timeout overflow", () => {
  const request = makeFixRequest();

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 26",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        "Task: Fix flaky auth tests\n\nUse {{ commands.tests }} and {{ commands.lint }}.",
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 21",
          "max_iterations: 20",
          "timeout: 20",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        "Task: Fix flaky auth tests\n\nUse {{ commands.tests }} and {{ commands.git-log }}.",
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 301",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        "Task: Fix flaky auth tests\n\nUse {{ commands.tests }} and {{ commands.git-log }}.",
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft rejects args placeholders in strengthened bodies", () => {
  const request = makeFixRequest();

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "args:",
          "  - owner",
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        "Task: Fix flaky auth tests\n\nUse {{ args.owner }} and {{ commands.tests }}.",
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft rejects args frontmatter drift", () => {
  const request = makeFixRequestWithArgs(["owner"]);
  const body = "Task: Fix flaky auth tests\n\nKeep the change small.";

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "args:",
          "  - owner",
          "  - mode",
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
        ],
        body,
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft rejects changed guardrails and missing secret-path protection", () => {
  const request = makeFixRequest();
  const body = "Task: Fix flaky auth tests\n\nKeep the change small.";

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          "    - .env*",
        ],
        body,
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files: [],",
        ],
        body,
      ),
    ),
    null,
  );
});

test("acceptStrengthenedDraft accepts unchanged completion_promise and rejects new or invalid ones", () => {
  const request = makeFixRequest();
  const body = "Task: Fix flaky auth tests\n\nKeep the change small.";

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
          "completion_promise: ship-it",
        ],
        body,
      ),
    ),
    null,
  );

  const promisedRequest = makeFixRequestWithCompletionPromise("ship-it");
  const promisedDraft = makeStrengthenedDraft(
    [
      "commands:",
      "  - name: git-log",
      "    run: git log --oneline -10",
      "    timeout: 20",
      "  - name: tests",
      "    run: npm test",
      "    timeout: 20",
      "max_iterations: 20",
      "timeout: 120",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
      "completion_promise: ship-it",
    ],
    body,
  );
  const accepted = acceptStrengthenedDraft(promisedRequest, promisedDraft);
  if (!accepted) {
    assert.fail("expected unchanged completion_promise to be accepted");
  }
  assert.equal(parseRalphMarkdown(accepted.content).frontmatter.completionPromise, "ship-it");

  assert.equal(
    acceptStrengthenedDraft(
      promisedRequest,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
          "completion_promise: ship-it-too",
        ],
        body,
      ),
    ),
    null,
  );

  assert.equal(
    acceptStrengthenedDraft(
      request,
      makeStrengthenedDraft(
        [
          "commands:",
          "  - name: git-log",
          "    run: git log --oneline -10",
          "    timeout: 20",
          "  - name: tests",
          "    run: npm test",
          "    timeout: 20",
          "max_iterations: 20",
          "timeout: 120",
          "guardrails:",
          "  block_commands:",
          "    - 'git\\s+push'",
          "  protected_files:",
          `    - '${SECRET_PATH_POLICY_TOKEN}'`,
          "completion_promise: [oops]",
        ],
        body,
      ),
    ),
    null,
  );
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

  assert.deepEqual(notifications, [{ level: "error", message: "Invalid RALPH.md: Invalid max_iterations: must be between 1 and 50" }]);
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
  assert.doesNotMatch(analysisBrief, /Required outputs must exist before stopping/);
  assert.doesNotMatch(analysisBrief, /OPEN_QUESTIONS\.md must have no remaining P0\/P1 items before stopping\./);

  const fixDraft = generateDraft(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    {
      packageManager: "npm",
      testCommand: "npm test",
      typecheckCommand: "npm run typecheck",
      checkCommand: "npm run check",
      buildCommand: "npm run build",
      verifyCommand: "npm run verify",
      lintCommand: "npm run lint",
      hasGit: false,
      topLevelDirs: ["src"],
      topLevelFiles: ["package.json"],
    },
  );
  const fixParsed = parseRalphMarkdown(fixDraft.content);
  assert.equal(fixDraft.mode, "fix");
  assert.equal(fixDraft.source, "deterministic");
  assert.match(fixDraft.content, /If tests or lint are failing/);
  assert.match(fixDraft.content, /\{\{ commands.tests \}\}/);
  assert.match(fixDraft.content, /\{\{ commands.typecheck \}\}/);
  assert.match(fixDraft.content, /\{\{ commands.build \}\}/);
  assert.match(fixDraft.content, /\{\{ commands.lint \}\}/);
  assert.doesNotMatch(fixDraft.content, /\{\{ commands.check \}\}/);
  assert.doesNotMatch(fixDraft.content, /\{\{ commands.verify \}\}/);
  assert.match(fixDraft.content, /run: 'npm test'/);
  assert.match(fixDraft.content, /run: 'npm run typecheck'/);
  assert.match(fixDraft.content, /run: 'npm run build'/);
  assert.match(fixDraft.content, /run: 'npm run lint'/);
  assert.equal(extractDraftMetadata(fixDraft.content)?.task, "Fix flaky auth tests");
  assertMetadataSource(extractDraftMetadata(fixDraft.content), "deterministic");
  assert.deepEqual(fixParsed.frontmatter.commands, [
    { name: "tests", run: "npm test", timeout: 120 },
    { name: "typecheck", run: "npm run typecheck", timeout: 120 },
    { name: "build", run: "npm run build", timeout: 120 },
    { name: "lint", run: "npm run lint", timeout: 90 },
  ]);
  assert.deepEqual(fixParsed.frontmatter.guardrails.protectedFiles, [SECRET_PATH_POLICY_TOKEN]);
  assert.match(fixDraft.safetyLabel, /secret files/);
});

test("normalizeStrengthenedDraft preserves parseable quoted command scalars", () => {
  const request = makeFixRequest();
  const baseline = makeStrengthenedDraft(
    [
      "commands:",
      "  - name: tests",
      "    run: 'npm run typecheck:fast'",
      "    timeout: 20",
      "  - name: build",
      "    run: 'sh -c \"echo # build\"'",
      "    timeout: 45",
      "max_iterations: 25",
      "timeout: 300",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nOriginal body.",
  );
  const strengthenedDraft = makeStrengthenedDraft(
    [
      "commands:",
      "  - name: tests",
      "    run: 'npm run typecheck:fast'",
      "    timeout: 20",
      "  - name: build",
      "    run: 'sh -c \"echo # build\"'",
      "    timeout: 45",
      "max_iterations: 25",
      "timeout: 300",
      "guardrails:",
      "  block_commands:",
      "    - 'git\\s+push'",
      "  protected_files:",
      `    - '${SECRET_PATH_POLICY_TOKEN}'`,
    ],
    "Task: Fix flaky auth tests\n\nUpdated body.",
  );

  const normalized = normalizeStrengthenedDraft({ ...request, baselineDraft: baseline }, strengthenedDraft, "body-only");
  const reparsed = parseRalphMarkdown(normalized.content);

  assert.deepEqual(reparsed.frontmatter.commands, [
    { name: "tests", run: "npm run typecheck:fast", timeout: 20 },
    { name: "build", run: 'sh -c "echo # build"', timeout: 45 },
  ]);
  assert.match(normalized.content, /run: 'npm run typecheck:fast'/);
  assert.match(normalized.content, /run: 'sh -c "echo # build"'/);
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
  const rendered = renderRalphBody(parsed.body, [], { iteration: 1, name: "ralph", maxIterations: 1 });
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
      .replace("name: tests\n    run: 'npm test'\n    timeout: 120", "name: smoke\n    run: 'npm run smoke'\n    timeout: 45")
      .replace("max_iterations: 25", "max_iterations: 7")
      .replace("timeout: 300\n", "timeout: 90\ncompletion_promise: deploy-ready\n"),
  };

  const brief = buildMissionBrief(editedPlan);
  assert.match(brief, /Mission Brief/);
  assert.match(brief, /Fix flaky auth regressions/);
  assert.doesNotMatch(brief, /Fix flaky auth tests/);
  assert.match(brief, /smoke: npm run smoke/);
  assert.match(brief, /Stop after 7 iterations or \/ralph-stop/);
  assert.match(brief, /Stop if an iteration exceeds 90s/);
  assert.match(brief, /OPEN_QUESTIONS\.md must have no remaining P0\/P1 items before stopping\./);
  assert.match(brief, /Stop early on <promise>deploy-ready<\/promise>/);
  assert.match(brief, /OPEN_QUESTIONS\.md must have no remaining P0\/P1 items before stopping\./);
  assert.doesNotMatch(brief, /tests: npm test/);
});
