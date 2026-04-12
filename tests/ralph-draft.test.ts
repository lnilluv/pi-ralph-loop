import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDraftPlan } from "../src/ralph-draft.ts";
import { generateDraft, slugifyTask, type DraftPlan, type DraftTarget } from "../src/ralph.ts";
import type { StrengthenDraftRuntime } from "../src/ralph-draft-llm.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-loop-draft-"));
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

function makeRuntime(): StrengthenDraftRuntime {
  return {
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
  };
}

const CLEAN_ENV_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "HF_TOKEN",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

function clearEnv() {
  const snapshot = new Map<string, string | undefined>();
  for (const key of CLEAN_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>) {
  for (const [key, value] of snapshot) {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test("createDraftPlan strengthens with an injected active model runtime", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const snapshot = clearEnv();
  t.after(() => restoreEnv(snapshot));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  const runtime = makeRuntime();
  const activeModel = runtime.model;
  assert.ok(activeModel);
  let strengthenCalls = 0;

  const draft = await createDraftPlan(task, target, cwd, runtime, {
    strengthenDraftWithLlmImpl: async (request, runtimeArg, options) => {
      strengthenCalls += 1;
      assert.equal(runtimeArg.model?.id, activeModel.id);
      assert.equal(runtimeArg.modelRegistry, runtime.modelRegistry);
      assert.equal(options?.scope, "body-only");
      assert.match(request.baselineDraft, /reverse engineer this app/);
      return { kind: "llm-strengthened", draft: makeDraftPlan(task, target, "llm-strengthened", cwd) };
    },
  });

  assert.equal(strengthenCalls, 1);
  assert.equal(draft.source, "llm-strengthened");
  assert.deepEqual(draft.target, target);
});

test("createDraftPlan falls back when no active model is selected", async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const snapshot = clearEnv();
  t.after(() => restoreEnv(snapshot));

  const task = "reverse engineer this app";
  const target = createTarget(cwd, task);
  let strengthenCalls = 0;

  const draft = await createDraftPlan(task, target, cwd, undefined, {
    strengthenDraftWithLlmImpl: async () => {
      strengthenCalls += 1;
      throw new Error("should not be called when no active model is available");
    },
  });

  assert.equal(strengthenCalls, 0);
  assert.equal(draft.source, "fallback");
});
