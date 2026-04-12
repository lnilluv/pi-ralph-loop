import { complete, type AssistantMessage, type Context, type Model } from "@mariozechner/pi-ai";
import {
  normalizeStrengthenedDraft,
  parseRalphMarkdown,
  validateFrontmatter,
  type DraftPlan,
  type DraftRequest,
  type DraftStrengtheningScope,
  type ParsedRalph,
} from "./ralph.ts";

export const DRAFT_LLM_TIMEOUT_MS = 20_000;

export type StrengthenDraftRuntime = {
  model: Model<string> | undefined;
  modelRegistry: {
    getApiKeyAndHeaders(model: Model<string>): Promise<AuthResult | AuthFailure>;
  };
};

export type StrengthenDraftOptions = {
  scope?: DraftStrengtheningScope;
  timeoutMs?: number;
  completeImpl?: typeof complete;
};

export type StrengthenDraftResult =
  | {
      kind: "llm-strengthened";
      draft: DraftPlan;
    }
  | {
      kind: "fallback";
    };

type AuthResult = {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
};

type AuthFailure = {
  ok: false;
  error?: string;
};

type CompleteOutcome =
  | {
      kind: "message";
      message: AssistantMessage;
    }
  | {
      kind: "timeout";
    }
  | {
      kind: "error";
      error: unknown;
    };

function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function hasCompleteRalphFrontmatter(raw: string): boolean {
  return /^(?:\s*<!--[\s\S]*?-->\s*)*---\n[\s\S]*?\n---\n?[\s\S]*$/.test(normalizeText(raw).trimStart());
}

function joinTextBlocks(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function areFrontmattersEquivalent(
  baseline: ParsedRalph["frontmatter"],
  strengthened: ParsedRalph["frontmatter"],
): boolean {
  return JSON.stringify(baseline) === JSON.stringify(strengthened);
}

function hasFakeRuntimeEnforcementClaim(text: string): boolean {
  return /read[-\s]?only enforced|write protection is enforced/i.test(text);
}

function isWeakStrengthenedDraftForScope(
  baseline: ParsedRalph,
  strengthened: ParsedRalph,
  scope: DraftStrengtheningScope,
  analysisText: string,
): boolean {
  const bodyUnchanged = baseline.body.trim() === strengthened.body.trim();
  const frontmatterUnchanged = areFrontmattersEquivalent(baseline.frontmatter, strengthened.frontmatter);

  if (scope === "body-only") {
    return bodyUnchanged || hasFakeRuntimeEnforcementClaim(analysisText) || hasFakeRuntimeEnforcementClaim(strengthened.body);
  }

  return (bodyUnchanged && frontmatterUnchanged) || hasFakeRuntimeEnforcementClaim(analysisText) || hasFakeRuntimeEnforcementClaim(strengthened.body);
}

function summarizeRepoSignals(request: DraftRequest): string[] {
  if (request.repoContext.summaryLines.length > 0) return request.repoContext.summaryLines.map((line) => String(line));

  return [
    `package manager: ${request.repoSignals.packageManager ?? "unknown"}`,
    `test command: ${request.repoSignals.testCommand ?? "none"}`,
    `lint command: ${request.repoSignals.lintCommand ?? "none"}`,
    `git repository: ${request.repoSignals.hasGit ? "present" : "absent"}`,
    `top-level dirs: ${request.repoSignals.topLevelDirs.length > 0 ? request.repoSignals.topLevelDirs.join(", ") : "none"}`,
    `top-level files: ${request.repoSignals.topLevelFiles.length > 0 ? request.repoSignals.topLevelFiles.join(", ") : "none"}`,
  ];
}

function truncateExcerpt(content: string, maxChars = 800): string {
  const normalized = normalizeText(content).trim();
  if (normalized.length <= maxChars) return normalized || "(no excerpt available)";
  return `${normalized.slice(0, maxChars)}\n… [truncated]`;
}

function renderSelectedFilesSection(request: DraftRequest): string {
  if (request.repoContext.selectedFiles.length === 0) {
    return "- none";
  }

  return request.repoContext.selectedFiles
    .map((file) => {
      const excerpt = truncateExcerpt(file.content);
      return [
        `### ${file.path}`,
        `Reason: ${file.reason}`,
        "Excerpt:",
        "```text",
        excerpt,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function buildStrengtheningPromptText(request: DraftRequest, scope: DraftStrengtheningScope): string {
  const repoSignals = summarizeRepoSignals(request).map((line) => `- ${line}`).join("\n");
  const selectedFiles = renderSelectedFilesSection(request);

  return [
    `Task: ${request.task}`,
    `Inferred mode: ${request.mode}`,
    `Target path: ${request.target.ralphPath}`,
    `Strengthening scope: ${scope}`,
    "",
    "Repo signals summary:",
    repoSignals,
    "",
    "Selected file excerpts with reasons:",
    selectedFiles,
    "",
    "Deterministic baseline draft:",
    "~~~md",
    request.baselineDraft,
    "~~~",
  ].join("\n");
}

export function buildStrengtheningPrompt(request: DraftRequest, scope: DraftStrengtheningScope): Context {
  return {
    systemPrompt:
      "You strengthen existing RALPH.md drafts. Return only a complete RALPH.md. Do not explain, do not wrap the output in fences, and do not omit required frontmatter.",
    messages: [
      {
        role: "user",
        content: buildStrengtheningPromptText(request, scope),
        timestamp: 0,
      },
    ],
  };
}

async function runCompleteWithTimeout(
  model: NonNullable<StrengthenDraftRuntime["model"]>,
  prompt: Context,
  options: Required<Pick<StrengthenDraftOptions, "timeoutMs" | "completeImpl">>,
  apiKey: string,
  headers?: Record<string, string>,
): Promise<CompleteOutcome> {
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const completion = Promise.resolve()
    .then(() =>
      options.completeImpl(model, prompt, {
        apiKey,
        headers,
        signal: abortController.signal,
        temperature: 0,
      }),
    )
    .then((message): CompleteOutcome => ({ kind: "message", message }))
    .catch((error): CompleteOutcome => ({ kind: "error", error }));

  const timeout = new Promise<CompleteOutcome>((resolve) => {
    timer = setTimeout(() => {
      abortController.abort();
      resolve({ kind: "timeout" });
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAuthFailure(result: AuthResult | AuthFailure): result is AuthFailure {
  return result.ok === false;
}

export async function strengthenDraftWithLlm(
  request: DraftRequest,
  runtime: StrengthenDraftRuntime,
  options: StrengthenDraftOptions = {},
): Promise<StrengthenDraftResult> {
  try {
    const model = runtime.model;
    if (!model) return { kind: "fallback" };

    const authResult = await runtime.modelRegistry.getApiKeyAndHeaders(model);
    if (!authResult.ok || !authResult.apiKey) return { kind: "fallback" };

    const scope = options.scope ?? "body-only";
    const prompt = buildStrengtheningPrompt(request, scope);
    const completion = await runCompleteWithTimeout(
      model,
      prompt,
      {
        timeoutMs: options.timeoutMs ?? DRAFT_LLM_TIMEOUT_MS,
        completeImpl: options.completeImpl ?? complete,
      },
      authResult.apiKey,
      authResult.headers,
    );

    if (completion.kind !== "message") return { kind: "fallback" };

    const rawText = joinTextBlocks(completion.message).trim();
    if (!rawText) return { kind: "fallback" };
    if (!hasCompleteRalphFrontmatter(rawText)) return { kind: "fallback" };

    const baseline = parseRalphMarkdown(request.baselineDraft);
    const strengthened = parseRalphMarkdown(rawText);
    const validationError = validateFrontmatter(strengthened.frontmatter);
    if (validationError) return { kind: "fallback" };

    if (strengthened.body.trim().length === 0) return { kind: "fallback" };
    if (isWeakStrengthenedDraftForScope(baseline, strengthened, scope, rawText)) return { kind: "fallback" };

    return {
      kind: "llm-strengthened",
      draft: normalizeStrengthenedDraft(request, rawText, scope),
    };
  } catch {
    return { kind: "fallback" };
  }
}
