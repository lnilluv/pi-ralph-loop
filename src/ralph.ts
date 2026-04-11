import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type CommandDef = { name: string; run: string; timeout: number };
export type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  invalidCommandEntries?: number[];
};
export type ParsedRalph = { frontmatter: Frontmatter; body: string };
export type CommandOutput = { name: string; output: string };
export type RalphTargetResolution = {
  target: string;
  absoluteTarget: string;
  markdownPath: string;
};
export type CommandArgs =
  | { mode: "path" | "task"; value: string }
  | { mode: "auto"; value: string };
export type ExistingTargetInspection =
  | { kind: "run"; ralphPath: string }
  | { kind: "invalid-markdown"; path: string }
  | { kind: "dir-without-ralph"; dirPath: string; ralphPath: string }
  | { kind: "missing-path"; dirPath: string; ralphPath: string }
  | { kind: "not-path" };
export type DraftMode = "analysis" | "fix" | "migration" | "general";
export type DraftMetadata = {
  generator: "pi-ralph-loop";
  version: 1;
  task: string;
  mode: DraftMode;
};
export type DraftTarget = {
  slug: string;
  dirPath: string;
  ralphPath: string;
};
export type PlannedTaskTarget =
  | { kind: "draft"; target: DraftTarget }
  | { kind: "conflict"; target: DraftTarget };
export type RepoSignals = {
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  testCommand?: string;
  lintCommand?: string;
  hasGit: boolean;
  topLevelDirs: string[];
  topLevelFiles: string[];
};
export type DraftPlan = {
  task: string;
  mode: DraftMode;
  target: DraftTarget;
  content: string;
  commandLabels: string[];
  safetyLabel: string;
  finishLabel: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRalphFrontmatter(raw: string): UnknownRecord {
  const parsed: unknown = parseYaml(raw);
  return isRecord(parsed) ? parsed : {};
}

function parseCommandDef(value: unknown): CommandDef | null {
  if (!isRecord(value)) return null;
  return {
    name: String(value.name ?? ""),
    run: String(value.run ?? ""),
    timeout: Number(value.timeout ?? 60),
  };
}

function toUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeRawRalph(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function matchRalphMarkdown(raw: string): RegExpMatchArray | null {
  return normalizeRawRalph(raw).match(/^(?:\s*<!--[\s\S]*?-->\s*)*---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
}

function hasRalphFrontmatter(raw: string): boolean {
  return matchRalphMarkdown(raw) !== null;
}

function safeParseRalphMarkdown(raw: string): ParsedRalph | undefined {
  try {
    return parseRalphMarkdown(raw);
  } catch {
    return undefined;
  }
}

function normalizeMissingMarkdownTarget(absoluteTarget: string): { dirPath: string; ralphPath: string } {
  if (basename(absoluteTarget) === "RALPH.md") {
    return { dirPath: dirname(absoluteTarget), ralphPath: absoluteTarget };
  }

  const dirPath = absoluteTarget.slice(0, -3);
  return { dirPath, ralphPath: join(dirPath, "RALPH.md") };
}

function summarizeSafetyLabel(mode: DraftMode, guardrails: Frontmatter["guardrails"]): string {
  const labels: string[] = [];
  if (mode === "analysis") labels.push("Prefer read-only inspection");
  if (guardrails.blockCommands.some((pattern) => pattern.includes("git") && pattern.includes("push"))) {
    labels.push("blocks git push");
  } else if (guardrails.blockCommands.length > 0) {
    labels.push(`blocks ${guardrails.blockCommands.length} command pattern${guardrails.blockCommands.length === 1 ? "" : "s"}`);
  }
  if (guardrails.protectedFiles.some((pattern) => pattern.includes(".env") || pattern.includes("secret"))) {
    labels.push("protects secret files");
  } else if (guardrails.protectedFiles.length > 0) {
    labels.push(`protects ${guardrails.protectedFiles.length} file glob${guardrails.protectedFiles.length === 1 ? "" : "s"}`);
  }
  return labels.length > 0 ? labels.join(" and ") : "No extra safety rules";
}

function summarizeFinishLabel(maxIterations: number): string {
  return `Stop after ${maxIterations} iterations or /ralph-stop`;
}

function isRalphMarkdownPath(path: string): boolean {
  return basename(path) === "RALPH.md";
}

function detectPackageManager(cwd: string): RepoSignals["packageManager"] {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "package.json"))) return "npm";
  return undefined;
}

function packageRunCommand(packageManager: RepoSignals["packageManager"], script: string): string {
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  if (script === "test") return "npm test";
  return `npm run ${script}`;
}

function detectPackageScripts(cwd: string, packageManager: RepoSignals["packageManager"]): Pick<RepoSignals, "testCommand" | "lintCommand"> {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return {};

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    const testValue = typeof scripts.test === "string" ? scripts.test : undefined;
    const lintValue = typeof scripts.lint === "string" ? scripts.lint : undefined;

    const testCommand = testValue && !/no test specified/i.test(testValue) ? packageRunCommand(packageManager, "test") : undefined;
    const lintCommand = lintValue ? packageRunCommand(packageManager, "lint") : undefined;
    return { testCommand, lintCommand };
  } catch {
    return {};
  }
}

function metadataComment(metadata: DraftMetadata): string {
  return `<!-- pi-ralph-loop: ${JSON.stringify(metadata)} -->`;
}

function yamlBlock(lines: string[]): string {
  return `---\n${lines.join("\n")}\n---`;
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function renderCommandsYaml(commands: CommandDef[]): string[] {
  if (commands.length === 0) return ["commands: []"];
  return [
    "commands:",
    ...commands.flatMap((command) => [
      `  - name: ${command.name}`,
      `    run: ${command.run}`,
      `    timeout: ${command.timeout}`,
    ]),
  ];
}

function bodySection(title: string, placeholder: string): string {
  return `${title}:\n${placeholder}`;
}

export function defaultFrontmatter(): Frontmatter {
  return { commands: [], maxIterations: 50, timeout: 300, guardrails: { blockCommands: [], protectedFiles: [] } };
}

export function parseRalphMarkdown(raw: string): ParsedRalph {
  const normalized = normalizeRawRalph(raw);
  const match = matchRalphMarkdown(normalized);
  if (!match) return { frontmatter: defaultFrontmatter(), body: normalized };

  const yaml = parseRalphFrontmatter(match[1]);
  const invalidCommandEntries: number[] = [];
  const commands = toUnknownArray(yaml.commands).flatMap((command, index) => {
    const parsed = parseCommandDef(command);
    if (!parsed) {
      invalidCommandEntries.push(index);
      return [];
    }
    return [parsed];
  });
  const guardrails = isRecord(yaml.guardrails) ? yaml.guardrails : {};

  return {
    frontmatter: {
      commands,
      maxIterations: Number(yaml.max_iterations ?? 50),
      timeout: Number(yaml.timeout ?? 300),
      completionPromise:
        typeof yaml.completion_promise === "string" && yaml.completion_promise.trim() ? yaml.completion_promise : undefined,
      guardrails: {
        blockCommands: toStringArray(guardrails.block_commands),
        protectedFiles: toStringArray(guardrails.protected_files),
      },
      invalidCommandEntries: invalidCommandEntries.length > 0 ? invalidCommandEntries : undefined,
    },
    body: match[2] ?? "",
  };
}

export function validateFrontmatter(fm: Frontmatter): string | null {
  if ((fm.invalidCommandEntries?.length ?? 0) > 0) {
    return `Invalid command entry at index ${fm.invalidCommandEntries![0]}`;
  }
  if (!Number.isFinite(fm.maxIterations) || !Number.isInteger(fm.maxIterations) || fm.maxIterations <= 0) {
    return "Invalid max_iterations: must be a positive finite integer";
  }
  if (!Number.isFinite(fm.timeout) || fm.timeout <= 0) {
    return "Invalid timeout: must be a positive finite number";
  }
  for (const pattern of fm.guardrails.blockCommands) {
    try {
      new RegExp(pattern);
    } catch {
      return `Invalid block_commands regex: ${pattern}`;
    }
  }
  for (const cmd of fm.commands) {
    if (!cmd.name.trim()) {
      return "Invalid command: name is required";
    }
    if (!cmd.run.trim()) {
      return `Invalid command ${cmd.name}: run is required`;
    }
    if (!Number.isFinite(cmd.timeout) || cmd.timeout <= 0) {
      return `Invalid command ${cmd.name}: timeout must be positive`;
    }
  }
  return null;
}

export function parseCommandArgs(raw: string): CommandArgs {
  const trimmed = raw.trim();
  if (trimmed.startsWith("--task=")) return { mode: "task", value: trimmed.slice("--task=".length).trim() };
  if (trimmed.startsWith("--path=")) return { mode: "path", value: trimmed.slice("--path=".length).trim() };
  if (trimmed.startsWith("--task ")) return { mode: "task", value: trimmed.slice("--task ".length).trim() };
  if (trimmed.startsWith("--path ")) return { mode: "path", value: trimmed.slice("--path ".length).trim() };
  return { mode: "auto", value: trimmed };
}

export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  return (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/") ||
    trimmed.endsWith(".md") ||
    trimmed.includes("-")
  );
}

export function resolveRalphTarget(args: string): string {
  return args.trim() || ".";
}

export function resolveRalphTargetResolution(args: string, cwd: string): RalphTargetResolution {
  const target = resolveRalphTarget(args);
  const absoluteTarget = resolve(cwd, target);
  return {
    target,
    absoluteTarget,
    markdownPath: absoluteTarget.endsWith(".md") ? absoluteTarget : join(absoluteTarget, "RALPH.md"),
  };
}

export function inspectExistingTarget(input: string, cwd: string): ExistingTargetInspection {
  const resolution = resolveRalphTargetResolution(input, cwd);
  const absoluteTarget = resolution.absoluteTarget;
  const markdownPath = resolution.markdownPath;

  if (existsSync(absoluteTarget)) {
    if (absoluteTarget.endsWith(".md")) {
      return isRalphMarkdownPath(absoluteTarget)
        ? { kind: "run", ralphPath: absoluteTarget }
        : { kind: "invalid-markdown", path: absoluteTarget };
    }
    return existsSync(markdownPath)
      ? { kind: "run", ralphPath: markdownPath }
      : { kind: "dir-without-ralph", dirPath: absoluteTarget, ralphPath: markdownPath };
  }

  if (!looksLikePath(input)) {
    return { kind: "not-path" };
  }

  if (absoluteTarget.endsWith(".md")) {
    return { kind: "missing-path", ...normalizeMissingMarkdownTarget(absoluteTarget) };
  }

  return { kind: "missing-path", dirPath: absoluteTarget, ralphPath: markdownPath };
}

export function slugifyTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug || "ralph-task";
}

export function nextSiblingSlug(baseSlug: string, hasRalphAtSlug: (slug: string) => boolean): string {
  let suffix = 2;
  let next = `${baseSlug}-${suffix}`;
  while (hasRalphAtSlug(next)) {
    suffix += 1;
    next = `${baseSlug}-${suffix}`;
  }
  return next;
}

export function classifyTaskMode(task: string): DraftMode {
  const normalized = task.toLowerCase();
  if (/(reverse engineer|analy[sz]e|understand|investigate|map|audit|explore)/.test(normalized)) return "analysis";
  if (/(fix|debug|repair|failing test|flaky|failure|broken)/.test(normalized)) return "fix";
  if (/(migrate|upgrade|convert|port|modernize)/.test(normalized)) return "migration";
  return "general";
}

export function planTaskDraftTarget(cwd: string, task: string): PlannedTaskTarget {
  const slug = slugifyTask(task);
  const target: DraftTarget = {
    slug,
    dirPath: join(cwd, slug),
    ralphPath: join(cwd, slug, "RALPH.md"),
  };
  return existsSync(target.ralphPath) ? { kind: "conflict", target } : { kind: "draft", target };
}

export function createSiblingTarget(cwd: string, baseSlug: string): DraftTarget {
  const siblingSlug = nextSiblingSlug(baseSlug, (candidate) => existsSync(join(cwd, candidate, "RALPH.md")));
  return {
    slug: siblingSlug,
    dirPath: join(cwd, siblingSlug),
    ralphPath: join(cwd, siblingSlug, "RALPH.md"),
  };
}

export function inspectRepo(cwd: string): RepoSignals {
  const packageManager = detectPackageManager(cwd);
  const packageScripts = detectPackageScripts(cwd, packageManager);
  let topLevelDirs: string[] = [];
  let topLevelFiles: string[] = [];

  try {
    const entries = readdirSync(cwd, { withFileTypes: true }).slice(0, 50);
    topLevelDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, 10);
    topLevelFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).slice(0, 10);
  } catch {
    // ignore bounded inspection failures
  }

  return {
    packageManager,
    testCommand: packageScripts.testCommand,
    lintCommand: packageScripts.lintCommand,
    hasGit: existsSync(join(cwd, ".git")),
    topLevelDirs,
    topLevelFiles,
  };
}

export function suggestedCommandsForMode(mode: DraftMode, signals: RepoSignals): CommandDef[] {
  if (mode === "analysis") {
    const commands: CommandDef[] = [{ name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20 }];
    if (signals.hasGit) commands.unshift({ name: "git-log", run: "git log --oneline -10", timeout: 20 });
    return commands;
  }

  const commands: CommandDef[] = [];
  if (signals.testCommand) commands.push({ name: "tests", run: signals.testCommand, timeout: 120 });
  if (signals.lintCommand) commands.push({ name: "lint", run: signals.lintCommand, timeout: 90 });
  if (signals.hasGit) commands.push({ name: "git-log", run: "git log --oneline -10", timeout: 20 });
  if (commands.length === 0) commands.push({ name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20 });
  return commands;
}

function formatCommandLabel(command: CommandDef): string {
  return `${command.name}: ${command.run}`;
}

export function generateDraft(task: string, target: DraftTarget, signals: RepoSignals): DraftPlan {
  const mode = classifyTaskMode(task);
  const commands = suggestedCommandsForMode(mode, signals);
  const metadata: DraftMetadata = { generator: "pi-ralph-loop", version: 1, task, mode };
  const guardrails = {
    blockCommands: ["git\\s+push"],
    protectedFiles: mode === "analysis" ? ["**/*"] : [".env*", "**/secrets/**"],
  };
  const maxIterations = mode === "analysis" ? 12 : mode === "migration" ? 30 : 25;
  const frontmatterLines = [
    ...renderCommandsYaml(commands),
    `max_iterations: ${maxIterations}`,
    "timeout: 300",
    "guardrails:",
    "  block_commands:",
    ...guardrails.blockCommands.map((pattern) => `    - ${yamlQuote(pattern)}`),
    "  protected_files:",
    ...guardrails.protectedFiles.map((pattern) => `    - ${yamlQuote(pattern)}`),
  ];

  const commandSections = commands.map((command) => bodySection(command.name === "git-log" ? "Recent git history" : `Latest ${command.name} output`, `{{ commands.${command.name} }}`));
  const body =
    mode === "analysis"
      ? [
          `Task: ${task}`,
          "",
          ...commandSections,
          "",
          "Start with read-only inspection. Avoid edits and commits until you have a clear plan.",
          "Map the architecture, identify entry points, and summarize the important moving parts.",
          "End each iteration with concrete findings, open questions, and the next files to inspect.",
          "Iteration {{ ralph.iteration }} of {{ ralph.name }}.",
        ].join("\n")
      : [
          `Task: ${task}`,
          "",
          ...commandSections,
          "",
          mode === "fix"
            ? "If tests or lint are failing, fix those failures before starting new work."
            : "Make the smallest safe change that moves the task forward.",
          "Prefer concrete, verifiable progress. Explain why your change works.",
          "Iteration {{ ralph.iteration }} of {{ ralph.name }}.",
        ].join("\n");

  return {
    task,
    mode,
    target,
    content: `${metadataComment(metadata)}\n${yamlBlock(frontmatterLines)}\n\n${body}`,
    commandLabels: commands.map(formatCommandLabel),
    safetyLabel: summarizeSafetyLabel(mode, guardrails),
    finishLabel: summarizeFinishLabel(maxIterations),
  };
}

export function extractDraftMetadata(raw: string): DraftMetadata | undefined {
  const match = raw.match(/^<!-- pi-ralph-loop: (.+?) -->/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as DraftMetadata;
    return parsed?.generator === "pi-ralph-loop" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function buildMissionBrief(plan: DraftPlan): string {
  const parsed = hasRalphFrontmatter(plan.content) ? safeParseRalphMarkdown(plan.content) : undefined;
  const metadata = extractDraftMetadata(plan.content);
  const task = metadata?.task ?? plan.task;
  const mode = metadata?.mode ?? plan.mode;
  const commandLabels = parsed ? parsed.frontmatter.commands.map(formatCommandLabel) : plan.commandLabels;
  const finishLabel = parsed ? summarizeFinishLabel(parsed.frontmatter.maxIterations) : plan.finishLabel;
  const safetyLabel = parsed ? summarizeSafetyLabel(mode, parsed.frontmatter.guardrails) : plan.safetyLabel;

  return [
    "Mission Brief",
    "Review what Ralph will do before it starts.",
    "",
    "Task",
    task,
    "",
    "File",
    plan.target.ralphPath,
    "",
    "Suggested checks",
    ...commandLabels.map((label) => `- ${label}`),
    "",
    "Finish behavior",
    `- ${finishLabel}`,
    "",
    "Safety",
    `- ${safetyLabel}`,
  ].join("\n");
}

export function extractCompletionPromise(text: string): string | undefined {
  const match = text.match(/<promise>([^<]+)<\/promise>/);
  return match?.[1]?.trim() || undefined;
}

export function shouldStopForCompletionPromise(text: string, expected: string): boolean {
  return extractCompletionPromise(text) === expected.trim();
}

export function resolvePlaceholders(body: string, outputs: CommandOutput[], ralph: { iteration: number; name: string }): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  return body
    .replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "")
    .replace(/\{\{\s*ralph\.iteration\s*\}\}/g, String(ralph.iteration))
    .replace(/\{\{\s*ralph\.name\s*\}\}/g, ralph.name);
}

export function renderRalphBody(body: string, outputs: CommandOutput[], ralph: { iteration: number; name: string }): string {
  return resolvePlaceholders(body, outputs, ralph).replace(/<!--[\s\S]*?-->/g, "");
}

export function renderIterationPrompt(body: string, iteration: number, maxIterations: number): string {
  return `[ralph: iteration ${iteration}/${maxIterations}]\n\n${body}`;
}

export function shouldWarnForBashFailure(output: string): boolean {
  return /FAIL|ERROR|error:|failed/i.test(output);
}

export function classifyIdleState(timedOut: boolean, idleError?: Error): "ok" | "timeout" | "error" {
  if (timedOut) return "timeout";
  if (idleError) return "error";
  return "ok";
}

export function shouldResetFailCount(previousSessionFile?: string, nextSessionFile?: string): boolean {
  return Boolean(previousSessionFile && nextSessionFile && previousSessionFile !== nextSessionFile);
}
