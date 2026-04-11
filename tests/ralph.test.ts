import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  defaultFrontmatter,
  parseRalphMarkdown,
  renderIterationPrompt,
  renderRalphBody,
  resolveRalphTarget,
  resolveRalphTargetResolution,
  resolvePlaceholders,
  validateFrontmatter,
} from "../src/ralph.ts";

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
    validateFrontmatter({ ...defaultFrontmatter(), guardrails: { blockCommands: ["["] , protectedFiles: [] } }),
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
});

test("resolvePlaceholders and rendering helpers expand placeholders and strip comments", () => {
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

test("resolveRalphTarget logic normalizes args and resolves markdown candidates", () => {
  const cwd = "/workspace/project";

  assert.equal(resolveRalphTarget("  "), ".");
  assert.equal(resolveRalphTarget("docs"), "docs");

  const directoryResolution = resolveRalphTargetResolution("docs", cwd);
  assert.deepEqual(directoryResolution, {
    target: "docs",
    absoluteTarget: resolve(cwd, "docs"),
    markdownPath: resolve(cwd, "docs", "RALPH.md"),
  });

  const fileResolution = resolveRalphTargetResolution("guide/RALPH.md", cwd);
  assert.equal(fileResolution.absoluteTarget, resolve(cwd, "guide/RALPH.md"));
  assert.equal(fileResolution.markdownPath, fileResolution.absoluteTarget);
});
