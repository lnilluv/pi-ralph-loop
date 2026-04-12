import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  buildMissionBrief,
  classifyIdleState,
  inspectExistingTarget,
  parseCommandArgs,
  parseRalphMarkdown,
  planTaskDraftTarget,
  renderIterationPrompt,
  renderRalphBody,
  shouldResetFailCount,
  shouldStopForCompletionPromise,
  shouldWarnForBashFailure,
  shouldValidateExistingDraft,
  validateDraftContent,
  validateFrontmatter as validateFrontmatterMessage,
  createSiblingTarget,
  findBlockedCommandPattern,
} from "./ralph.ts";
import { matchesProtectedPath } from "./secret-paths.ts";
import type { CommandDef, CommandOutput, DraftPlan, DraftTarget, Frontmatter } from "./ralph.ts";
import { createDraftPlan as createDraftPlanService } from "./ralph-draft.ts";
import type { StrengthenDraftRuntime } from "./ralph-draft-llm.ts";

type LoopState = {
  active: boolean;
  ralphPath: string;
  cwd: string;
  iteration: number;
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  stopRequested: boolean;
  iterationSummaries: Array<{ iteration: number; duration: number }>;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  loopSessionFile?: string;
};
type PersistedLoopState = {
  active: boolean;
  sessionFile?: string;
  cwd?: string;
  iteration?: number;
  maxIterations?: number;
  iterationSummaries?: Array<{ iteration: number; duration: number }>;
  guardrails?: { blockCommands: string[]; protectedFiles: string[] };
  stopRequested?: boolean;
};

type CommandUI = {
  input(title: string, placeholder: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, content: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(name: string, status?: string): void;
};

type CommandSessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: Array<{ type: string; text?: string }> };
};

type CommandContext = {
  cwd: string;
  hasUI: boolean;
  ui: CommandUI;
  sessionManager: {
    getEntries(): CommandSessionEntry[];
    getSessionFile(): string | undefined;
  };
  newSession(): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
  model?: StrengthenDraftRuntime["model"];
  modelRegistry?: StrengthenDraftRuntime["modelRegistry"];
};

type DraftPlanFactory = (
  task: string,
  target: DraftTarget,
  cwd: string,
  runtime?: StrengthenDraftRuntime,
) => Promise<DraftPlan>;

type RegisterRalphCommandServices = {
  createDraftPlan?: DraftPlanFactory;
};


function validateFrontmatter(fm: Frontmatter, ctx: Pick<CommandContext, "ui">): boolean {
  const error = validateFrontmatterMessage(fm);
  if (error) {
    ctx.ui.notify(error, "error");
    return false;
  }
  return true;
}

export async function runCommands(commands: CommandDef[], blockPatterns: string[], pi: ExtensionAPI): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    const blockedPattern = findBlockedCommandPattern(cmd.run, blockPatterns);
    if (blockedPattern) {
      results.push({ name: cmd.name, output: `[blocked by guardrail: ${blockedPattern}]` });
      continue;
    }

    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      results.push(
        result.killed
          ? { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` }
          : { name: cmd.name, output: (result.stdout + result.stderr).trim() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: cmd.name, output: `[error: ${message}]` });
    }
  }
  return results;
}

function defaultLoopState(): LoopState {
  return {
    active: false,
    ralphPath: "",
    iteration: 0,
    maxIterations: 50,
    timeout: 300,
    completionPromise: undefined,
    stopRequested: false,
    iterationSummaries: [],
    guardrails: { blockCommands: [], protectedFiles: [] },
    loopSessionFile: undefined,
    cwd: "",
  };
}

function readPersistedLoopState(ctx: Pick<CommandContext, "sessionManager">): PersistedLoopState | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === "ralph-loop-state") {
      return typeof entry.data === "object" && entry.data ? (entry.data as PersistedLoopState) : undefined;
    }
  }
  return undefined;
}

function persistLoopState(pi: ExtensionAPI, data: PersistedLoopState) {
  pi.appendEntry("ralph-loop-state", data);
}

function writeDraftFile(ralphPath: string, content: string) {
  mkdirSync(dirname(ralphPath), { recursive: true });
  writeFileSync(ralphPath, content, "utf8");
}

function displayPath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") ? `./${rel}` : filePath;
}

async function promptForTask(ctx: Pick<CommandContext, "hasUI" | "ui">, title: string, placeholder: string): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const value = await ctx.ui.input(title, placeholder);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function reviewDraft(plan: DraftPlan, mode: "run" | "draft", ctx: Pick<CommandContext, "ui">): Promise<{ action: "start" | "save" | "cancel"; content: string }> {
  let content = plan.content;

  while (true) {
    const nextPlan = { ...plan, content };
    const contentError = validateDraftContent(content);
    const options = contentError
      ? ["Open RALPH.md", "Cancel"]
      : mode === "run"
        ? ["Start", "Open RALPH.md", "Cancel"]
        : ["Save draft", "Open RALPH.md", "Cancel"];
    const choice = await ctx.ui.select(buildMissionBrief(nextPlan), options);

    if (!choice || choice === "Cancel") {
      return { action: "cancel", content };
    }
    if (choice === "Open RALPH.md") {
      const edited = await ctx.ui.editor("Edit RALPH.md", content);
      if (typeof edited === "string") content = edited;
      continue;
    }
    if (contentError) {
      ctx.ui.notify(`Invalid RALPH.md: ${contentError}`, "error");
      continue;
    }
    if (choice === "Save draft") {
      return { action: "save", content };
    }
    return { action: "start", content };
  }
}

async function editExistingDraft(ralphPath: string, ctx: Pick<CommandContext, "cwd" | "hasUI" | "ui">, saveMessage = "Saved RALPH.md") {
  if (!ctx.hasUI) {
    ctx.ui.notify(`Use ${displayPath(ctx.cwd, ralphPath)} in an interactive session to edit the draft.`, "warning");
    return;
  }

  let content = readFileSync(ralphPath, "utf8");
  const strictValidation = shouldValidateExistingDraft(content);
  while (true) {
    const edited = await ctx.ui.editor("Edit RALPH.md", content);
    if (typeof edited !== "string") return;

    if (strictValidation) {
      const error = validateDraftContent(edited);
      if (error) {
        ctx.ui.notify(`Invalid RALPH.md: ${error}`, "error");
        content = edited;
        continue;
      }
    }

    if (edited !== content) {
      writeDraftFile(ralphPath, edited);
      ctx.ui.notify(saveMessage, "info");
    }
    return;
  }
}

async function chooseRecoveryMode(
  input: string,
  dirPath: string,
  ctx: Pick<CommandContext, "cwd" | "ui">,
  allowTaskFallback = true,
): Promise<"draft-path" | "task" | "cancel"> {
  const options = allowTaskFallback ? ["Draft in that folder", "Treat as task text", "Cancel"] : ["Draft in that folder", "Cancel"];
  const choice = await ctx.ui.select(`No RALPH.md in ${displayPath(ctx.cwd, dirPath)}.`, options);
  if (choice === "Draft in that folder") return "draft-path";
  if (choice === "Treat as task text") return "task";
  return "cancel";
}

async function chooseConflictTarget(commandName: "ralph" | "ralph-draft", task: string, target: DraftTarget, ctx: Pick<CommandContext, "cwd" | "ui">): Promise<{ action: "run-existing" | "open-existing" | "draft-target" | "cancel"; target?: DraftTarget }> {
  const hasExistingDraft = existsSync(target.ralphPath);
  const title = hasExistingDraft
    ? `Found an existing RALPH at ${displayPath(ctx.cwd, target.ralphPath)} for “${task}”.`
    : `Found an occupied draft directory at ${displayPath(ctx.cwd, target.dirPath)} for “${task}”.`;
  const options =
    commandName === "ralph"
      ? hasExistingDraft
        ? ["Run existing", "Open existing RALPH.md", "Create sibling", "Cancel"]
        : ["Create sibling", "Cancel"]
      : hasExistingDraft
        ? ["Open existing RALPH.md", "Create sibling", "Cancel"]
        : ["Create sibling", "Cancel"];
  const choice = await ctx.ui.select(title, options);

  if (!choice || choice === "Cancel") return { action: "cancel" };
  if (choice === "Run existing") return { action: "run-existing" };
  if (choice === "Open existing RALPH.md") return { action: "open-existing" };
  return { action: "draft-target", target: createSiblingTarget(ctx.cwd, target.slug) };
}

function getDraftStrengtheningRuntime(ctx: Pick<CommandContext, "model" | "modelRegistry">): StrengthenDraftRuntime | undefined {
  if (!ctx.model || !ctx.modelRegistry) return undefined;
  return {
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
  };
}

async function draftFromTask(
  commandName: "ralph" | "ralph-draft",
  task: string,
  target: DraftTarget,
  ctx: Pick<CommandContext, "cwd" | "ui">,
  draftPlanFactory: DraftPlanFactory,
  runtime?: StrengthenDraftRuntime,
): Promise<string | undefined> {
  const plan = await draftPlanFactory(task, target, ctx.cwd, runtime);
  const review = await reviewDraft(plan, commandName === "ralph" ? "run" : "draft", ctx);
  if (review.action === "cancel") return undefined;

  writeDraftFile(target.ralphPath, review.content);
  if (review.action === "save") {
    ctx.ui.notify(`Draft saved to ${displayPath(ctx.cwd, target.ralphPath)}`, "info");
    return undefined;
  }
  return target.ralphPath;
}

let loopState: LoopState = defaultLoopState();

export default function (pi: ExtensionAPI, services: RegisterRalphCommandServices = {}) {
  const failCounts = new Map<string, number>();
  const draftPlanFactory = services.createDraftPlan ?? createDraftPlanService;
  const isLoopSession = (ctx: Pick<CommandContext, "sessionManager">): boolean => {
    const state = readPersistedLoopState(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    return state?.active === true && state.sessionFile === sessionFile;
  };

  async function startRalphLoop(ralphPath: string, ctx: CommandContext) {
    let name: string;
    try {
      const raw = readFileSync(ralphPath, "utf8");
      const draftError = validateDraftContent(raw);
      if (draftError) {
        ctx.ui.notify(`Invalid RALPH.md: ${draftError}`, "error");
        return;
      }
      const { frontmatter } = parseRalphMarkdown(raw);
      if (!validateFrontmatter(frontmatter, ctx)) return;
      name = basename(dirname(ralphPath));
      loopState = {
        active: true,
        ralphPath,
        cwd: ctx.cwd,
        iteration: 0,
        maxIterations: frontmatter.maxIterations,
        timeout: frontmatter.timeout,
        completionPromise: frontmatter.completionPromise,
        stopRequested: false,
        iterationSummaries: [],
        guardrails: { blockCommands: frontmatter.guardrails.blockCommands, protectedFiles: frontmatter.guardrails.protectedFiles },
        loopSessionFile: undefined,
      };
    } catch (err) {
      ctx.ui.notify(String(err), "error");
      return;
    }
    ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations)`, "info");

    try {
      iterationLoop: for (let i = 1; i <= loopState.maxIterations; i++) {
        if (loopState.stopRequested) break;
        const persistedBefore = readPersistedLoopState(ctx);
        if (persistedBefore?.active && persistedBefore.stopRequested) {
          loopState.stopRequested = true;
          ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
          break;
        }

        loopState.iteration = i;
        const iterStart = Date.now();
        const raw = readFileSync(loopState.ralphPath, "utf8");
        const draftError = validateDraftContent(raw);
        if (draftError) {
          ctx.ui.notify(`Invalid RALPH.md on iteration ${i}, stopping loop`, "error");
          break;
        }
        const { frontmatter: fm, body: rawBody } = parseRalphMarkdown(raw);

        loopState.maxIterations = fm.maxIterations;
        loopState.timeout = fm.timeout;
        loopState.completionPromise = fm.completionPromise;
        loopState.guardrails = { blockCommands: fm.guardrails.blockCommands, protectedFiles: fm.guardrails.protectedFiles };

        const outputs = await runCommands(fm.commands, fm.guardrails.blockCommands, pi);
        const body = renderRalphBody(rawBody, outputs, { iteration: i, name });
        const prompt = renderIterationPrompt(body, i, loopState.maxIterations);

        const prevPersisted = readPersistedLoopState(ctx);
        if (prevPersisted?.active && prevPersisted.sessionFile === ctx.sessionManager.getSessionFile()) {
          persistLoopState(pi, { ...prevPersisted, active: false });
        }
        ctx.ui.setStatus("ralph", `🔁 ${name}: iteration ${i}/${loopState.maxIterations}`);
        const prevSessionFile = loopState.loopSessionFile;
        const { cancelled } = await ctx.newSession();
        if (cancelled) {
          ctx.ui.notify("Session switch cancelled, stopping loop", "warning");
          break;
        }

        loopState.loopSessionFile = ctx.sessionManager.getSessionFile();
        if (shouldResetFailCount(prevSessionFile, loopState.loopSessionFile)) failCounts.delete(prevSessionFile!);
        if (loopState.loopSessionFile) failCounts.set(loopState.loopSessionFile, 0);
        persistLoopState(pi, {
          active: true,
          sessionFile: loopState.loopSessionFile,
          cwd: loopState.cwd,
          iteration: loopState.iteration,
          maxIterations: loopState.maxIterations,
          iterationSummaries: loopState.iterationSummaries,
          guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
          stopRequested: false,
        });

        await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        const timeoutMs = fm.timeout * 1000;
        let timedOut = false;
        let idleError: Error | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ctx.waitForIdle().catch((e: any) => {
              idleError = e instanceof Error ? e : new Error(String(e));
              throw e;
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("timeout"));
              }, timeoutMs);
            }),
          ]);
        } catch {
          // handled below
        }
        if (timer) clearTimeout(timer);

        const idleState = classifyIdleState(timedOut, idleError);
        if (idleState === "timeout") {
          ctx.ui.notify(`Iteration ${i} timed out after ${fm.timeout}s, stopping loop`, "warning");
          break;
        }
        if (idleState === "error") {
          ctx.ui.notify(`Iteration ${i} agent error: ${idleError!.message}, stopping loop`, "error");
          break;
        }

        const elapsed = Math.round((Date.now() - iterStart) / 1000);
        loopState.iterationSummaries.push({ iteration: i, duration: elapsed });
        pi.appendEntry("ralph-iteration", { iteration: i, duration: elapsed, ralphPath: loopState.ralphPath });

        const persistedAfter = readPersistedLoopState(ctx);
        if (persistedAfter?.active && persistedAfter.stopRequested) {
          loopState.stopRequested = true;
          ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
          break;
        }

        if (fm.completionPromise) {
          const entries = ctx.sessionManager.getEntries();
          for (const entry of entries) {
            if (entry.type === "message" && entry.message?.role === "assistant") {
              const text = entry.message.content?.filter((b: any) => b.type === "text")?.map((b: any) => b.text)?.join("") ?? "";
              if (shouldStopForCompletionPromise(text, fm.completionPromise)) {
                ctx.ui.notify(`Completion promise matched on iteration ${i}`, "info");
                break iterationLoop;
              }
            }
          }
        }

        ctx.ui.notify(`Iteration ${i} complete (${elapsed}s)`, "info");
      }

      const total = loopState.iterationSummaries.reduce((a, s) => a + s.duration, 0);
      ctx.ui.notify(`Ralph loop done: ${loopState.iteration} iterations, ${total}s total`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Ralph loop failed: ${message}`, "error");
    } finally {
      failCounts.clear();
      loopState.active = false;
      loopState.stopRequested = false;
      loopState.loopSessionFile = undefined;
      ctx.ui.setStatus("ralph", undefined);
      persistLoopState(pi, { active: false, cwd: loopState.cwd });
    }
  }

  async function handleDraftCommand(commandName: "ralph" | "ralph-draft", args: string, ctx: CommandContext): Promise<string | undefined> {
    const parsed = parseCommandArgs(args);
    const draftRuntime = getDraftStrengtheningRuntime(ctx);

    const resolveTaskForFolder = async (target: DraftTarget): Promise<string | undefined> => {
      const task = await promptForTask(ctx, "What should Ralph work on in this folder?", "reverse engineer this app");
      if (!task) return undefined;
      return draftFromTask(commandName, task, target, ctx, draftPlanFactory, draftRuntime);
    };

    const handleExistingInspection = async (input: string, explicitPath = false): Promise<string | undefined> => {
      const inspection = inspectExistingTarget(input, ctx.cwd, explicitPath);
      switch (inspection.kind) {
        case "run":
          if (commandName === "ralph") return inspection.ralphPath;
          await editExistingDraft(inspection.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, inspection.ralphPath)}`);
          return undefined;
        case "invalid-markdown":
          ctx.ui.notify(`Only task folders or RALPH.md can be run directly. ${displayPath(ctx.cwd, inspection.path)} is not runnable.`, "error");
          return undefined;
        case "invalid-target":
          ctx.ui.notify(`Only task folders or RALPH.md can be run directly. ${displayPath(ctx.cwd, inspection.path)} is a file, not a task folder.`, "error");
          return undefined;
        case "dir-without-ralph":
        case "missing-path": {
          if (!ctx.hasUI) {
            ctx.ui.notify("Draft review requires an interactive session. Pass a task folder or RALPH.md path instead.", "warning");
            return undefined;
          }
          const recovery = await chooseRecoveryMode(input, inspection.dirPath, ctx, !explicitPath);
          if (recovery === "cancel") return undefined;
          if (recovery === "task") {
            return handleTaskFlow(input);
          }
          return resolveTaskForFolder({ slug: basename(inspection.dirPath), dirPath: inspection.dirPath, ralphPath: inspection.ralphPath });
        }
        case "not-path":
          return handleTaskFlow(input);
      }
    };

    const handleTaskFlow = async (taskInput: string): Promise<string | undefined> => {
      const task = taskInput.trim();
      if (!task) return undefined;
      if (!ctx.hasUI) {
        ctx.ui.notify("Draft review requires an interactive session. Use /ralph with a task folder or RALPH.md path instead.", "warning");
        return undefined;
      }

      let planned = planTaskDraftTarget(ctx.cwd, task);
      if (planned.kind === "conflict") {
        const decision = await chooseConflictTarget(commandName, task, planned.target, ctx);
        if (decision.action === "cancel") return undefined;
        if (decision.action === "run-existing") return planned.target.ralphPath;
        if (decision.action === "open-existing") {
          await editExistingDraft(planned.target.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, planned.target.ralphPath)}`);
          return undefined;
        }
        planned = { kind: "draft", target: decision.target! };
      }
      return draftFromTask(commandName, task, planned.target, ctx, draftPlanFactory, draftRuntime);
    };

    if (parsed.mode === "task") {
      return handleTaskFlow(parsed.value);
    }
    if (parsed.mode === "path") {
      return handleExistingInspection(parsed.value || ".", true);
    }
    if (!parsed.value) {
      const inspection = inspectExistingTarget(".", ctx.cwd);
      if (inspection.kind === "run") {
        if (commandName === "ralph") return inspection.ralphPath;
        await editExistingDraft(inspection.ralphPath, ctx, `Saved ${displayPath(ctx.cwd, inspection.ralphPath)}`);
        return undefined;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Draft review requires an interactive session. Pass a task folder or RALPH.md path instead.", "warning");
        return undefined;
      }
      return resolveTaskForFolder({ slug: basename(ctx.cwd), dirPath: ctx.cwd, ralphPath: join(ctx.cwd, "RALPH.md") });
    }
    return handleExistingInspection(parsed.value);
  }

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    if (!persisted) return;

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const blockedPattern = findBlockedCommandPattern(cmd, persisted.guardrails?.blockCommands ?? []);
      if (blockedPattern) return { block: true, reason: `ralph: blocked (${blockedPattern})` };
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      if (matchesProtectedPath(filePath, persisted.guardrails?.protectedFiles ?? [], persisted.cwd)) {
        return { block: true, reason: `ralph: ${filePath} is protected` };
      }
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    const summaries = persisted?.iterationSummaries ?? [];
    if (summaries.length === 0) return;

    const history = summaries.map((s) => `- Iteration ${s.iteration}: ${s.duration}s`).join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\n\nPrevious iterations:\n${history}\n\nDo not repeat completed work. Check git log for recent changes.`,
    };
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx) || event.toolName !== "bash") return;
    const output = event.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("");
    if (!shouldWarnForBashFailure(output)) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const next = (failCounts.get(sessionFile) ?? 0) + 1;
    failCounts.set(sessionFile, next);
    if (next >= 3) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: "\n\n⚠️ ralph: 3+ failures this iteration. Stop and describe the root cause before retrying." },
        ],
      };
    }
  });

  pi.registerCommand("ralph", {
    description: "Start Ralph from a task folder or RALPH.md",
    handler: async (args: string, ctx: CommandContext) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      const ralphPath = await handleDraftCommand("ralph", args ?? "", ctx);
      if (!ralphPath) return;
      await startRalphLoop(ralphPath, ctx);
    },
  });

  pi.registerCommand("ralph-draft", {
    description: "Draft a Ralph task without starting it",
    handler: async (args: string, ctx: CommandContext) => {
      await handleDraftCommand("ralph-draft", args ?? "", ctx);
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop the ralph loop after the current iteration",
    handler: async (_args: string, ctx: CommandContext) => {
      const persisted = readPersistedLoopState(ctx);
      if (!persisted?.active) {
        if (!loopState.active) {
          ctx.ui.notify("No active ralph loop", "warning");
          return;
        }
        loopState.stopRequested = true;
        ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
        return;
      }
      loopState.stopRequested = true;
      persistLoopState(pi, { ...persisted, stopRequested: true });
      ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
    },
  });
}
