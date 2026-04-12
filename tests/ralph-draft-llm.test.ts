import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  buildDraftRequest,
  buildRepoContext,
  extractDraftMetadata,
  parseRalphMarkdown,
  type DraftRequest,
} from "../src/ralph.ts";
import {
  buildStrengtheningPrompt,
  strengthenDraftWithLlm,
  type StrengthenDraftRuntime,
} from "../src/ralph-draft-llm.ts";

function makeRequest(): DraftRequest {
  const repoSignals = {
    packageManager: "npm" as const,
    testCommand: "npm test",
    lintCommand: "npm run lint",
    hasGit: true,
    topLevelDirs: ["src", "tests"],
    topLevelFiles: ["package.json", "README.md"],
  };

  return buildDraftRequest(
    "Fix flaky auth tests",
    { slug: "fix-flaky-auth-tests", dirPath: "/repo/fix-flaky-auth-tests", ralphPath: "/repo/fix-flaky-auth-tests/RALPH.md" },
    repoSignals,
    {
      ...buildRepoContext(repoSignals),
      summaryLines: [
        "package manager: npm",
        "test command: npm test",
        "lint command: npm run lint",
        "git repository: present",
        "top-level dirs: src, tests",
        "top-level files: package.json, README.md",
      ],
      selectedFiles: [
        {
          path: "src/auth.ts",
          reason: "auth logic looks relevant",
          content: "export const authEnabled = true;\nexport function login() { return true; }\n",
        },
        {
          path: "tests/auth.test.ts",
          reason: "captures the flaky auth path",
          content: "import assert from 'node:assert/strict';\nassert.equal(true, true);\n",
        },
      ],
    },
  );
}

function makeRuntime(overrides: Partial<StrengthenDraftRuntime> = {}): StrengthenDraftRuntime {
  const model: NonNullable<StrengthenDraftRuntime["model"]> = {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    api: "anthropic-messages",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };

  const modelRegistry: StrengthenDraftRuntime["modelRegistry"] = {
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-api-key", headers: { "x-test": "1" } };
    },
  };

  return {
    model: Object.prototype.hasOwnProperty.call(overrides, "model") ? overrides.model : model,
    modelRegistry: overrides.modelRegistry ?? modelRegistry,
  };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "anthropic",
    model: "claude-sonnet",
    content,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function promptText(prompt: ReturnType<typeof buildStrengtheningPrompt>): string {
  return [prompt.systemPrompt ?? "", ...prompt.messages.map((message) => (typeof message.content === "string" ? message.content : ""))].join("\n");
}

test("buildStrengtheningPrompt includes the full prompt contract and repo signals", () => {
  const request = makeRequest();
  const prompt = buildStrengtheningPrompt(request, "body-only");
  const text = promptText(prompt);

  assert.match(text, /Fix flaky auth tests/);
  assert.match(text, /inferred mode: fix/i);
  assert.match(text, /package manager: npm/);
  assert.match(text, /test command: npm test/);
  assert.match(text, /lint command: npm run lint/);
  assert.match(text, /src\/auth\.ts/);
  assert.match(text, /auth logic looks relevant/);
  assert.match(text, /export const authEnabled = true;/);
  assert.match(text, /tests\/auth\.test\.ts/);
  assert.match(text, /captures the flaky auth path/);
  assert.match(text, /export function login\(\) \{ return true; \}/);
  assert.match(text, /deterministic baseline draft/i);
  assert.match(text, /return only a complete RALPH\.md/i);
});

test("strengthenDraftWithLlm falls back when the selected model is missing", async () => {
  const request = makeRequest();
  const result = await strengthenDraftWithLlm(request, makeRuntime({ model: undefined }), {
    completeImpl: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(result, { kind: "fallback" });
});

test("strengthenDraftWithLlm falls back when auth lookup fails", async () => {
  const request = makeRequest();
  const runtime = makeRuntime({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: false, error: "no auth" };
      },
    },
  });

  const result = await strengthenDraftWithLlm(request, runtime, {
    completeImpl: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(result, { kind: "fallback" });
});

test("strengthenDraftWithLlm falls back when auth succeeds but apiKey is missing", async () => {
  const request = makeRequest();
  const runtime = makeRuntime({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, headers: { "x-test": "1" } };
      },
    },
  });

  const result = await strengthenDraftWithLlm(request, runtime, {
    completeImpl: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(result, { kind: "fallback" });
});

test("strengthenDraftWithLlm falls back on timeout", async () => {
  const request = makeRequest();
  const runtime = makeRuntime();
  const result = await strengthenDraftWithLlm(request, runtime, {
    timeoutMs: 1,
    completeImpl: async () => await new Promise<never>(() => {}),
  });

  assert.deepEqual(result, { kind: "fallback" });
});

test("strengthenDraftWithLlm normalizes a stronger full draft while preserving deterministic frontmatter", async () => {
  const request = makeRequest();
  const runtime = makeRuntime();
  const rawDraft = `---\ncommands:\n  - name: rogue\n    run: rm -rf /\n    timeout: 1\nmax_iterations: 1\ntimeout: 1\nguardrails:\n  block_commands:\n    - allow-all\n  protected_files:\n    - tmp/**\n---\nTask: Fix flaky auth tests\n\nAdd concrete verification steps, summarize the auth regression, and end with a concrete checklist.`;

  const result = await strengthenDraftWithLlm(request, runtime, {
    scope: "body-only",
    completeImpl: async () =>
      makeAssistantMessage([
        { type: "thinking", thinking: "drafting" },
        { type: "text", text: rawDraft },
      ]),
  });

  assert.equal(result.kind, "llm-strengthened");
  const parsed = parseRalphMarkdown(result.draft.content);
  const baseline = parseRalphMarkdown(request.baselineDraft);

  assert.deepEqual(result.draft.target, request.target);
  assert.deepEqual(parsed.frontmatter, baseline.frontmatter);
  assert.match(parsed.body, /Add concrete verification steps/);
  assert.deepEqual(extractDraftMetadata(result.draft.content), {
    generator: "pi-ralph-loop",
    version: 2,
    source: "llm-strengthened",
    task: "Fix flaky auth tests",
    mode: "fix",
  });
});

test("strengthenDraftWithLlm accepts improved frontmatter and commands in body-and-commands scope", async () => {
  const request = makeRequest();
  const runtime = makeRuntime();
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const rawDraft = `---\ncommands:\n  - name: smoke\n    run: npm run smoke\n    timeout: 45\nmax_iterations: 7\ntimeout: 120\nguardrails:\n  block_commands:\n    - git\\s+push\n  protected_files:\n    - .env*\n---\n${baseline.body}`;

  const result = await strengthenDraftWithLlm(request, runtime, {
    scope: "body-and-commands",
    completeImpl: async () => makeAssistantMessage([{ type: "text", text: rawDraft }]),
  });

  assert.equal(result.kind, "llm-strengthened");
  const parsed = parseRalphMarkdown(result.draft.content);

  assert.deepEqual(result.draft.target, request.target);
  assert.deepEqual(parsed.frontmatter.commands, [{ name: "smoke", run: "npm run smoke", timeout: 45 }]);
  assert.equal(parsed.frontmatter.maxIterations, 7);
  assert.deepEqual(parsed.frontmatter.guardrails, {
    blockCommands: ["git\\s+push"],
    protectedFiles: [".env*"],
  });
  assert.equal(parsed.body.trim(), baseline.body.trim());
  assert.deepEqual(extractDraftMetadata(result.draft.content), {
    generator: "pi-ralph-loop",
    version: 2,
    source: "llm-strengthened",
    task: "Fix flaky auth tests",
    mode: "fix",
  });
});

test("strengthenDraftWithLlm falls back on invalid model output", async () => {
  const request = makeRequest();
  const runtime = makeRuntime();
  const result = await strengthenDraftWithLlm(request, runtime, {
    completeImpl: async () => makeAssistantMessage([{ type: "text", text: "This is not a complete RALPH draft." }]),
  });

  assert.deepEqual(result, { kind: "fallback" });
});
