import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type CommandDef = { name: string; run: string; timeout: number };
export type DraftSource = "deterministic" | "llm-strengthened" | "fallback";
export type DraftStrengtheningScope = "body-only" | "body-and-commands";
export type CommandIntent = CommandDef & { source: "heuristic" | "repo-signal" };
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
  | { kind: "invalid-target"; path: string }
  | { kind: "dir-without-ralph"; dirPath: string; ralphPath: string }
  | { kind: "missing-path"; dirPath: string; ralphPath: string }
  | { kind: "not-path" };
export type DraftMode = "analysis" | "fix" | "migration" | "general";
export type DraftMetadata =
  | {
      generator: "pi-ralph-loop";
      version: 1;
      task: string;
      mode: DraftMode;
    }
  | {
      generator: "pi-ralph-loop";
      version: 2;
      source: DraftSource;
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
export type RepoContextSelectedFile = {
  path: string;
  content: string;
  reason: string;
};
export type RepoContext = {
  summaryLines: string[];
  selectedFiles: RepoContextSelectedFile[];
};
export type DraftRequest = {
  task: string;
  mode: DraftMode;
  target: DraftTarget;
  repoSignals: RepoSignals;
  repoContext: RepoContext;
  commandIntent: CommandIntent[];
  baselineDraft: string;
};
export type DraftPlan = {
  task: string;
  mode: DraftMode;
  target: DraftTarget;
  source: DraftSource;
  content: string;
  commandLabels: string[];
  safetyLabel: string;
  finishLabel: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const draftModes: DraftMode[] = ["analysis", "fix", "migration", "general"];
const draftSources: DraftSource[] = ["deterministic", "llm-strengthened", "fallback"];

function isDraftMode(value: unknown): value is DraftMode {
  return typeof value === "string" && draftModes.includes(value as DraftMode);
}

function isDraftSource(value: unknown): value is DraftSource {
  return typeof value === "string" && draftSources.includes(value as DraftSource);
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

function normalizeMissingMarkdownTarget(absoluteTarget: string): { dirPath: string; ralphPath: string } {
  if (basename(absoluteTarget) === "RALPH.md") {
    return { dirPath: dirname(absoluteTarget), ralphPath: absoluteTarget };
  }

  const dirPath = absoluteTarget.slice(0, -3);
  return { dirPath, ralphPath: join(dirPath, "RALPH.md") };
}

function summarizeSafetyLabel(guardrails: Frontmatter["guardrails"]): string {
  const labels: string[] = [];
  if (guardrails.blockCommands.some((pattern) => pattern.includes("git") && pattern.includes("push"))) {
    labels.push("blocks git push");
  } else if (guardrails.blockCommands.length > 0) {
    labels.push(`blocks ${guardrails.blockCommands.length} command pattern${guardrails.blockCommands.length === 1 ? "" : "s"}`);
  }
  if (guardrails.protectedFiles.some((pattern) => pattern.includes(".env") || pattern.includes("secret"))) {
    labels.push("blocks write/edit to secret files");
  } else if (guardrails.protectedFiles.length > 0) {
    labels.push(`blocks write/edit to ${guardrails.protectedFiles.length} file glob${guardrails.protectedFiles.length === 1 ? "" : "s"}`);
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

function encodeDraftMetadata(metadata: DraftMetadata): string {
  return encodeURIComponent(JSON.stringify(metadata));
}

function decodeDraftMetadata(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function metadataComment(metadata: DraftMetadata): string {
  return `<!-- pi-ralph-loop: ${encodeDraftMetadata(metadata)} -->`;
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

function escapeHtmlCommentMarkers(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
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

export function findBlockedCommandPattern(command: string, blockPatterns: string[]): string | undefined {
  for (const pattern of blockPatterns) {
    try {
      if (new RegExp(pattern).test(command)) return pattern;
    } catch {
      // ignore malformed regexes; validateFrontmatter should catch these first
    }
  }
  return undefined;
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

export function inspectExistingTarget(input: string, cwd: string, explicitPath = false): ExistingTargetInspection {
  const resolution = resolveRalphTargetResolution(input, cwd);
  const absoluteTarget = resolution.absoluteTarget;
  const markdownPath = resolution.markdownPath;

  if (existsSync(absoluteTarget)) {
    const stats = statSync(absoluteTarget);
    if (stats.isDirectory()) {
      return existsSync(markdownPath)
        ? { kind: "run", ralphPath: markdownPath }
        : { kind: "dir-without-ralph", dirPath: absoluteTarget, ralphPath: markdownPath };
    }
    if (isRalphMarkdownPath(absoluteTarget)) {
      return { kind: "run", ralphPath: absoluteTarget };
    }
    if (absoluteTarget.endsWith(".md")) {
      return { kind: "invalid-markdown", path: absoluteTarget };
    }
    return { kind: "invalid-target", path: absoluteTarget };
  }

  if (!explicitPath && !looksLikePath(input)) {
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
  return existsSync(target.dirPath) ? { kind: "conflict", target } : { kind: "draft", target };
}

export function createSiblingTarget(cwd: string, baseSlug: string): DraftTarget {
  const siblingSlug = nextSiblingSlug(baseSlug, (candidate) => existsSync(join(cwd, candidate)));
  return {
    slug: siblingSlug,
    dirPath: join(cwd, siblingSlug),
    ralphPath: join(cwd, siblingSlug, "RALPH.md"),
  };
}

function isSecretBearingTopLevelName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName.startsWith(".env") ||
    normalizedName === ".npmrc" ||
    normalizedName === ".pypirc" ||
    normalizedName === ".netrc" ||
    normalizedName === ".aws" ||
    normalizedName === ".ssh" ||
    normalizedName === "authorized_keys" ||
    normalizedName === "known_hosts" ||
    normalizedName.includes("secret") ||
    normalizedName.includes("credential") ||
    normalizedName.endsWith(".pem") ||
    normalizedName.endsWith(".key") ||
    normalizedName.endsWith(".crt") ||
    normalizedName.endsWith(".cer") ||
    normalizedName.endsWith(".der") ||
    normalizedName.endsWith(".p12") ||
    normalizedName.endsWith(".pfx") ||
    normalizedName.endsWith(".asc")
  );
}

export function filterSecretBearingTopLevelNames(names: string[]): string[] {
  return names.filter((name) => !isSecretBearingTopLevelName(name));
}

export function inspectRepo(cwd: string): RepoSignals {
  const packageManager = detectPackageManager(cwd);
  const packageScripts = detectPackageScripts(cwd, packageManager);
  let topLevelDirs: string[] = [];
  let topLevelFiles: string[] = [];

  try {
    const entries = readdirSync(cwd, { withFileTypes: true }).slice(0, 50);
    const filteredEntries = entries.filter((entry) => !isSecretBearingTopLevelName(entry.name));
    topLevelDirs = filteredEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, 10);
    topLevelFiles = filteredEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).slice(0, 10);
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

export function buildRepoContext(signals: RepoSignals): RepoContext {
  const topLevelDirs = filterSecretBearingTopLevelNames(signals.topLevelDirs);
  const topLevelFiles = filterSecretBearingTopLevelNames(signals.topLevelFiles);

  return {
    summaryLines: [
      `package manager: ${signals.packageManager ?? "unknown"}`,
      `test command: ${signals.testCommand ?? "none"}`,
      `lint command: ${signals.lintCommand ?? "none"}`,
      `git repository: ${signals.hasGit ? "present" : "absent"}`,
      `top-level dirs: ${topLevelDirs.length > 0 ? topLevelDirs.join(", ") : "none"}`,
      `top-level files: ${topLevelFiles.length > 0 ? topLevelFiles.join(", ") : "none"}`,
    ],
    selectedFiles: topLevelFiles.slice(0, 10).map((path) => ({
      path,
      content: "",
      reason: "top-level file",
    })),
  };
}

function normalizeSelectedFile(file: unknown): RepoContextSelectedFile {
  if (isRecord(file)) {
    return {
      path: String(file.path ?? ""),
      content: String(file.content ?? ""),
      reason: String(file.reason ?? "selected file"),
    };
  }
  if (typeof file === "string") {
    return { path: file, content: "", reason: "selected file" };
  }
  return { path: String(file), content: "", reason: "selected file" };
}

function normalizeRepoContext(repoContext: RepoContext | undefined, signals: RepoSignals): RepoContext {
  if (repoContext && Array.isArray(repoContext.summaryLines) && Array.isArray(repoContext.selectedFiles)) {
    return {
      summaryLines: repoContext.summaryLines.map((line) => String(line)),
      selectedFiles: repoContext.selectedFiles.map((file) => normalizeSelectedFile(file)),
    };
  }
  return buildRepoContext(signals);
}

export function buildCommandIntent(mode: DraftMode, signals: RepoSignals): CommandIntent[] {
  if (mode === "analysis") {
    const commands: CommandIntent[] = [{ name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20, source: "heuristic" }];
    if (signals.hasGit) commands.unshift({ name: "git-log", run: "git log --oneline -10", timeout: 20, source: "heuristic" });
    return commands;
  }

  const commands: CommandIntent[] = [];
  if (signals.testCommand) commands.push({ name: "tests", run: signals.testCommand, timeout: 120, source: "repo-signal" });
  if (signals.lintCommand) commands.push({ name: "lint", run: signals.lintCommand, timeout: 90, source: "repo-signal" });
  if (signals.hasGit) commands.push({ name: "git-log", run: "git log --oneline -10", timeout: 20, source: "heuristic" });
  if (commands.length === 0) commands.push({ name: "repo-map", run: "find . -maxdepth 2 -type f | sort | head -n 120", timeout: 20, source: "heuristic" });
  return commands;
}

export function suggestedCommandsForMode(mode: DraftMode, signals: RepoSignals): CommandDef[] {
  return buildCommandIntent(mode, signals).map(({ source: _source, ...command }) => command);
}

function formatCommandLabel(command: CommandDef): string {
  return `${command.name}: ${command.run}`;
}

function extractVisibleTask(body: string): string | undefined {
  const match = body.match(/^Task:\s*(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

function buildDraftFrontmatter(mode: DraftMode, commands: CommandDef[]): Frontmatter {
  const guardrails = {
    blockCommands: ["git\\s+push"],
    protectedFiles: mode === "analysis" ? [] : [".env*", "**/secrets/**"],
  };
  return {
    commands,
    maxIterations: mode === "analysis" ? 12 : mode === "migration" ? 30 : 25,
    timeout: 300,
    guardrails,
  };
}

function renderDraftBody(task: string, mode: DraftMode, commands: CommandDef[]): string {
  const commandSections = commands.map((command) => bodySection(command.name === "git-log" ? "Recent git history" : `Latest ${command.name} output`, `{{ commands.${command.name} }}`));
  return mode === "analysis"
    ? [
        `Task: ${escapeHtmlCommentMarkers(task)}`,
        "",
        ...commandSections,
        "",
        "Start with read-only inspection. Avoid edits and commits until you have a clear plan.",
        "Map the architecture, identify entry points, and summarize the important moving parts.",
        "End each iteration with concrete findings, open questions, and the next files to inspect.",
        "Iteration {{ ralph.iteration }} of {{ ralph.name }}.",
      ].join("\n")
    : [
        `Task: ${escapeHtmlCommentMarkers(task)}`,
        "",
        ...commandSections,
        "",
        mode === "fix" ? "If tests or lint are failing, fix those failures before starting new work." : "Make the smallest safe change that moves the task forward.",
        "Prefer concrete, verifiable progress. Explain why your change works.",
        "Iteration {{ ralph.iteration }} of {{ ralph.name }}.",
      ].join("\n");
}

function commandIntentsToCommands(commandIntents: CommandIntent[]): CommandDef[] {
  return commandIntents.map(({ source: _source, ...command }) => command);
}

function renderDraftPlan(task: string, mode: DraftMode, target: DraftTarget, frontmatter: Frontmatter, source: DraftSource, body: string): DraftPlan {
  const metadata: DraftMetadata = { generator: "pi-ralph-loop", version: 2, source, task, mode };
  const frontmatterLines = [
    ...renderCommandsYaml(frontmatter.commands),
    `max_iterations: ${frontmatter.maxIterations}`,
    `timeout: ${frontmatter.timeout}`,
    "guardrails:",
    "  block_commands:",
    ...frontmatter.guardrails.blockCommands.map((pattern) => `    - ${yamlQuote(pattern)}`),
    "  protected_files:",
    ...frontmatter.guardrails.protectedFiles.map((pattern) => `    - ${yamlQuote(pattern)}`),
  ];

  return {
    task,
    mode,
    target,
    source,
    content: `${metadataComment(metadata)}\n${yamlBlock(frontmatterLines)}\n\n${body}`,
    commandLabels: frontmatter.commands.map(formatCommandLabel),
    safetyLabel: summarizeSafetyLabel(frontmatter.guardrails),
    finishLabel: summarizeFinishLabel(frontmatter.maxIterations),
  };
}

export function generateDraftFromRequest(request: Omit<DraftRequest, "baselineDraft">, source: DraftSource): DraftPlan {
  const commands = commandIntentsToCommands(request.commandIntent);
  const frontmatter = buildDraftFrontmatter(request.mode, commands);
  return renderDraftPlan(request.task, request.mode, request.target, frontmatter, source, renderDraftBody(request.task, request.mode, commands));
}

export function buildDraftRequest(task: string, target: DraftTarget, repoSignals: RepoSignals, repoContext?: RepoContext): DraftRequest {
  const mode = classifyTaskMode(task);
  const commandIntents = buildCommandIntent(mode, repoSignals);
  const request: Omit<DraftRequest, "baselineDraft"> = {
    task,
    mode,
    target,
    repoSignals,
    repoContext: normalizeRepoContext(repoContext, repoSignals),
    commandIntent: commandIntents,
  };
  return { ...request, baselineDraft: generateDraftFromRequest(request, "deterministic").content };
}

export function normalizeStrengthenedDraft(request: DraftRequest, strengthenedDraft: string, scope: DraftStrengtheningScope): DraftPlan {
  const baseline = parseRalphMarkdown(request.baselineDraft);
  const strengthened = parseRalphMarkdown(strengthenedDraft);

  if (scope === "body-only") {
    return renderDraftPlan(request.task, request.mode, request.target, baseline.frontmatter, "llm-strengthened", strengthened.body);
  }

  return renderDraftPlan(request.task, request.mode, request.target, strengthened.frontmatter, "llm-strengthened", strengthened.body);
}

function hasFakeRuntimeEnforcementClaim(text: string): boolean {
  return /read[-\s]?only enforced|write protection is enforced/i.test(text);
}

export function isWeakStrengthenedDraft(baselineBody: string, analysisText: string, strengthenedBody: string): boolean {
  return baselineBody.trim() === strengthenedBody.trim() || hasFakeRuntimeEnforcementClaim(analysisText) || hasFakeRuntimeEnforcementClaim(strengthenedBody);
}

export function generateDraft(task: string, target: DraftTarget, signals: RepoSignals): DraftPlan {
  const request = buildDraftRequest(task, target, signals);
  return generateDraftFromRequest(request, "deterministic");
}

export function extractDraftMetadata(raw: string): DraftMetadata | undefined {
  const match = raw.match(/^<!-- pi-ralph-loop: (.+?) -->/);
  if (!match) return undefined;

  try {
    const parsed: unknown = JSON.parse(decodeDraftMetadata(match[1]));
    if (!isRecord(parsed) || parsed.generator !== "pi-ralph-loop") return undefined;
    if (!isDraftMode(parsed.mode) || typeof parsed.task !== "string") return undefined;

    if (parsed.version === 1) {
      return { generator: "pi-ralph-loop", version: 1, task: parsed.task, mode: parsed.mode };
    }

    if (parsed.version === 2 && isDraftSource(parsed.source)) {
      return { generator: "pi-ralph-loop", version: 2, source: parsed.source, task: parsed.task, mode: parsed.mode };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function shouldValidateExistingDraft(raw: string): boolean {
  return extractDraftMetadata(raw) !== undefined;
}

export type DraftContentInspection = {
  metadata?: DraftMetadata;
  parsed?: ParsedRalph;
  error?: string;
};

export function inspectDraftContent(raw: string): DraftContentInspection {
  const metadata = extractDraftMetadata(raw);
  const normalized = normalizeRawRalph(raw);

  if (!hasRalphFrontmatter(normalized)) {
    return { metadata, error: "Missing RALPH frontmatter" };
  }

  try {
    const parsed = parseRalphMarkdown(normalized);
    const error = validateFrontmatter(parsed.frontmatter);
    return error ? { metadata, parsed, error } : { metadata, parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { metadata, error: `Invalid RALPH frontmatter: ${message}` };
  }
}

export function validateDraftContent(raw: string): string | null {
  return inspectDraftContent(raw).error ?? null;
}

export function buildMissionBrief(plan: DraftPlan): string {
  const inspection = inspectDraftContent(plan.content);
  const task = extractVisibleTask(inspection.parsed?.body ?? "") ?? inspection.metadata?.task ?? "Task metadata missing from current draft";

  if (inspection.error) {
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
      "Draft status",
      `- Invalid RALPH.md: ${inspection.error}`,
      "- Reopen RALPH.md to fix it or cancel",
    ].join("\n");
  }

  const parsed = inspection.parsed!;
  const mode = inspection.metadata?.mode ?? "general";
  const commandLabels = parsed.frontmatter.commands.map(formatCommandLabel);
  const finishLabel = summarizeFinishLabel(parsed.frontmatter.maxIterations);
  const safetyLabel = summarizeSafetyLabel(parsed.frontmatter.guardrails);

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
