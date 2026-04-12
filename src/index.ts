import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CommandDef = { name: string; run: string; timeout: number };
type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
};
type ParsedRalph = { frontmatter: Frontmatter; body: string };
type CommandOutput = { name: string; output: string };
type LoopState = {
  active: boolean;
  ralphPath: string;
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
  iteration?: number;
  maxIterations?: number;
  iterationSummaries?: Array<{ iteration: number; duration: number }>;
  guardrails?: { blockCommands: string[]; protectedFiles: string[] };
  stopRequested?: boolean;
};

function defaultFrontmatter(): Frontmatter {
  return { commands: [], maxIterations: 50, timeout: 300, guardrails: { blockCommands: [], protectedFiles: [] } };
}

function parseRalphMd(filePath: string): ParsedRalph {
  let raw = readFileSync(filePath, "utf8");
  raw = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: defaultFrontmatter(), body: raw };

  const yaml = (parseYaml(match[1]) ?? {}) as Record<string, any>;
  const commands: CommandDef[] = Array.isArray(yaml.commands)
    ? yaml.commands.map((c: Record<string, any>) => ({ name: String(c.name ?? ""), run: String(c.run ?? ""), timeout: Number(c.timeout ?? 60) }))
    : [];
  const guardrails = (yaml.guardrails ?? {}) as Record<string, any>;

  return {
    frontmatter: {
      commands,
      maxIterations: Number(yaml.max_iterations ?? 50),
      timeout: Number(yaml.timeout ?? 300),
      completionPromise:
        typeof yaml.completion_promise === "string" && yaml.completion_promise.trim() ? yaml.completion_promise : undefined,
      guardrails: {
        blockCommands: Array.isArray(guardrails.block_commands) ? guardrails.block_commands.map((p: unknown) => String(p)) : [],
        protectedFiles: Array.isArray(guardrails.protected_files) ? guardrails.protected_files.map((p: unknown) => String(p)) : [],
      },
    },
    body: match[2] ?? "",
  };
}

function validateFrontmatter(fm: Frontmatter, ctx: any): boolean {
  if (!Number.isFinite(fm.maxIterations) || !Number.isInteger(fm.maxIterations) || fm.maxIterations <= 0) {
    ctx.ui.notify("Invalid max_iterations: must be a positive finite integer", "error");
    return false;
  }
  if (!Number.isFinite(fm.timeout) || fm.timeout <= 0) {
    ctx.ui.notify("Invalid timeout: must be a positive finite number", "error");
    return false;
  }
  for (const pattern of fm.guardrails.blockCommands) {
    try { new RegExp(pattern); } catch {
      ctx.ui.notify(`Invalid block_commands regex: ${pattern}`, "error");
      return false;
    }
  }
  for (const cmd of fm.commands) {
    if (!cmd.name.trim()) {
      ctx.ui.notify("Invalid command: name is required", "error");
      return false;
    }
    if (!cmd.run.trim()) {
      ctx.ui.notify(`Invalid command ${cmd.name}: run is required`, "error");
      return false;
    }
    if (!Number.isFinite(cmd.timeout) || cmd.timeout <= 0) {
      ctx.ui.notify(`Invalid command ${cmd.name}: timeout must be positive`, "error");
      return false;
    }
  }
  return true;
}

function resolveRalphPath(args: string, cwd: string): string {
  const target = args.trim() || ".";
  const abs = resolve(cwd, target);
  if (existsSync(abs) && abs.endsWith(".md")) return abs;
  if (existsSync(join(abs, "RALPH.md"))) return join(abs, "RALPH.md");
  throw new Error(`No RALPH.md found at ${abs}`);
}

function resolvePlaceholders(body: string, outputs: CommandOutput[], ralph: { iteration: number; name: string }): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  return body
    .replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "")
    .replace(/\{\{\s*ralph\.iteration\s*\}\}/g, String(ralph.iteration))
    .replace(/\{\{\s*ralph\.name\s*\}\}/g, ralph.name);
}

async function runCommands(commands: CommandDef[], pi: ExtensionAPI): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      results.push(result.killed
        ? { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` }
        : { name: cmd.name, output: (result.stdout + result.stderr).trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: cmd.name, output: `[error: ${message}]` });
    }
  }
  return results;
}

function defaultLoopState(): LoopState {
  return { active: false, ralphPath: "", iteration: 0, maxIterations: 50, timeout: 300, completionPromise: undefined, stopRequested: false, iterationSummaries: [], guardrails: { blockCommands: [], protectedFiles: [] }, loopSessionFile: undefined };
}

function readPersistedLoopState(ctx: any): PersistedLoopState | undefined {
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

let loopState: LoopState = defaultLoopState();

export default function (pi: ExtensionAPI) {
  const failCounts = new Map<string, number>();
  const isLoopSession = (ctx: any): boolean => {
    const state = readPersistedLoopState(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    return state?.active === true && state.sessionFile === sessionFile;
  };

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    if (!persisted) return;

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      for (const pattern of persisted.guardrails?.blockCommands ?? []) {
        try {
          if (new RegExp(pattern).test(cmd)) return { block: true, reason: `ralph: blocked (${pattern})` };
        } catch {
          // ignore malformed persisted regex
        }
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      for (const glob of persisted.guardrails?.protectedFiles ?? []) {
        if (minimatch(filePath, glob, { matchBase: true })) return { block: true, reason: `ralph: ${filePath} is protected` };
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
    if (!/FAIL|ERROR|error:|failed/i.test(output)) return;

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
    description: "Start an autonomous ralph loop from a RALPH.md file",
    handler: async (args: string, ctx: any) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      let name: string;
      try {
        const ralphPath = resolveRalphPath(args ?? "", ctx.cwd);
        const { frontmatter } = parseRalphMd(ralphPath);
        if (!validateFrontmatter(frontmatter, ctx)) return;
        name = basename(dirname(ralphPath));
        loopState = {
          active: true,
          ralphPath,
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
          const { frontmatter: fm, body: rawBody } = parseRalphMd(loopState.ralphPath);
          if (!validateFrontmatter(fm, ctx)) {
            ctx.ui.notify(`Invalid RALPH.md on iteration ${i}, stopping loop`, "error");
            break;
          }

          loopState.maxIterations = fm.maxIterations;
          loopState.timeout = fm.timeout;
          loopState.completionPromise = fm.completionPromise;
          loopState.guardrails = { blockCommands: fm.guardrails.blockCommands, protectedFiles: fm.guardrails.protectedFiles };

          const outputs = await runCommands(fm.commands, pi);
          let body = resolvePlaceholders(rawBody, outputs, { iteration: i, name });
          body = body.replace(/<!--[\s\S]*?-->/g, "");
          const prompt = `[ralph: iteration ${i}/${loopState.maxIterations}]\n\n${body}`;

          const prevPersisted = readPersistedLoopState(ctx);
          if (prevPersisted?.active && prevPersisted.sessionFile === ctx.sessionManager.getSessionFile()) persistLoopState(pi, { ...prevPersisted, active: false });
          ctx.ui.setStatus("ralph", `🔁 ${name}: iteration ${i}/${loopState.maxIterations}`);
          const prevSessionFile = loopState.loopSessionFile;
          const { cancelled } = await ctx.newSession();
          if (cancelled) {
            ctx.ui.notify("Session switch cancelled, stopping loop", "warning");
            break;
          }

          loopState.loopSessionFile = ctx.sessionManager.getSessionFile();
          if (prevSessionFile && prevSessionFile !== loopState.loopSessionFile) failCounts.delete(prevSessionFile);
          if (loopState.loopSessionFile) failCounts.set(loopState.loopSessionFile, 0);
          persistLoopState(pi, {
            active: true,
            sessionFile: loopState.loopSessionFile,
            iteration: loopState.iteration,
            maxIterations: loopState.maxIterations,
            iterationSummaries: loopState.iterationSummaries,
            guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
            stopRequested: false,
          });

          pi.sendUserMessage(prompt);
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
            // timedOut is set by timer; idleError means waitForIdle failed
          }
          if (timer) clearTimeout(timer);
          if (timedOut) {
            ctx.ui.notify(`Iteration ${i} timed out after ${fm.timeout}s, stopping loop`, "warning");
            break;
          }
          if (idleError) {
            ctx.ui.notify(`Iteration ${i} agent error: ${idleError.message}, stopping loop`, "error");
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
                const match = text.match(/<promise>([^<]+)<\/promise>/);
                if (match && fm.completionPromise && match[1].trim() === fm.completionPromise.trim()) {
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
        persistLoopState(pi, { active: false });
      }
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop the ralph loop after the current iteration",
    handler: async (_args: string, ctx: any) => {
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
