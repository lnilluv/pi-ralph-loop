import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SECRET_PATH_POLICY_TOKEN, filterSecretBearingTopLevelNames, isSecretBearingPath, isSecretBearingTopLevelName } from "./secret-paths.ts";

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

function isUniversalProtectedGlob(pattern: string): boolean {
  const trimmed = pattern.trim().replace(/\/+$/, "");
  if (!trimmed) return true;
  if (/^\*+$/.test(trimmed)) return true;
  return /^(?:\*\*?\/)+\*\*?$/.test(trimmed);
}

function normalizeRawRalph(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function matchRalphMarkdown(raw: string): RegExpMatchArray | null {
  return normalizeRawRalph(raw).match(/^(?:\s*<!--[\s\S]*?-->\s*)*---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
}


function validateRawGuardrailsShape(rawFrontmatter: UnknownRecord): string | null {
  if (!Object.prototype.hasOwnProperty.call(rawFrontmatter, "guardrails")) {
    return null;
  }

  const guardrails = rawFrontmatter.guardrails;
  if (!isRecord(guardrails)) {
    return "Invalid RALPH frontmatter: guardrails must be a YAML mapping";
  }
  if (
    Object.prototype.hasOwnProperty.call(guardrails, "block_commands") &&
    !Array.isArray(guardrails.block_commands)
  ) {
    return "Invalid RALPH frontmatter: guardrails.block_commands must be a YAML sequence";
  }
  if (
    Object.prototype.hasOwnProperty.call(guardrails, "protected_files") &&
    !Array.isArray(guardrails.protected_files)
  ) {
    return "Invalid RALPH frontmatter: guardrails.protected_files must be a YAML sequence";
  }
  return null;
}

function validateRawCommandEntryShape(command: unknown, index: number): string | null {
  if (!isRecord(command)) {
    return `Invalid RALPH frontmatter: commands[${index}] must be a YAML mapping`;
  }
  if (Object.prototype.hasOwnProperty.call(command, "name") && typeof command.name !== "string") {
    return `Invalid RALPH frontmatter: commands[${index}].name must be a YAML string`;
  }
  if (Object.prototype.hasOwnProperty.call(command, "run") && typeof command.run !== "string") {
    return `Invalid RALPH frontmatter: commands[${index}].run must be a YAML string`;
  }
  if (Object.prototype.hasOwnProperty.call(command, "timeout") && typeof command.timeout !== "number") {
    return `Invalid RALPH frontmatter: commands[${index}].timeout must be a YAML number`;
  }
  return null;
}

function validateRawFrontmatterShape(rawFrontmatter: UnknownRecord): string | null {
  if (Object.prototype.hasOwnProperty.call(rawFrontmatter, "commands")) {
    const commands = rawFrontmatter.commands;
    if (!Array.isArray(commands)) {
      return "Invalid RALPH frontmatter: commands must be a YAML sequence";
    }
    for (const [index, command] of commands.entries()) {
      const commandError = validateRawCommandEntryShape(command, index);
      if (commandError) return commandError;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "max_iterations") &&
    (typeof rawFrontmatter.max_iterations !== "number" || !Number.isFinite(rawFrontmatter.max_iterations))
  ) {
    return "Invalid RALPH frontmatter: max_iterations must be a YAML number";
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "timeout") &&
    (typeof rawFrontmatter.timeout !== "number" || !Number.isFinite(rawFrontmatter.timeout))
  ) {
    return "Invalid RALPH frontmatter: timeout must be a YAML number";
  }

  return null;
}

function parseStrictRalphMarkdown(raw: string): { parsed: ParsedRalph; rawFrontmatter: UnknownRecord } | { error: string } {
  const normalized = normalizeRawRalph(raw);
  const match = matchRalphMarkdown(normalized);
  if (!match) return { error: "Missing RALPH frontmatter" };

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Invalid RALPH frontmatter: ${message}` };
  }

  if (!isRecord(parsedYaml)) {
    return { error: "Invalid RALPH frontmatter: Frontmatter must be a YAML mapping" };
  }

  const guardrailsError = validateRawGuardrailsShape(parsedYaml);
  if (guardrailsError) {
    return { error: guardrailsError };
  }

  const rawShapeError = validateRawFrontmatterShape(parsedYaml);
  if (rawShapeError) {
    return { error: rawShapeError };
  }

  return { parsed: parseRalphMarkdown(normalized), rawFrontmatter: parsedYaml };
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
  if (guardrails.protectedFiles.some((pattern) => pattern === SECRET_PATH_POLICY_TOKEN || isSecretBearingPath(pattern))) {
    labels.push("blocks write/edit to secret files");
  } else if (guardrails.protectedFiles.length > 0) {
    labels.push(`blocks write/edit to ${guardrails.protectedFiles.length} file glob${guardrails.protectedFiles.length === 1 ? "" : "s"}`);
  }
  return labels.length > 0 ? labels.join(" and ") : "No extra safety rules";
}

function summarizeFinishLabel(maxIterations: number): string {
  return `Stop after ${maxIterations} iterations or /ralph-stop`;
}

function summarizeFinishBehavior(frontmatter: Frontmatter): string[] {
  const lines = [
    `- Stop after ${frontmatter.maxIterations} iterations or /ralph-stop`,
    `- Stop if an iteration exceeds ${frontmatter.timeout}s`,
  ];
  if (frontmatter.completionPromise) {
    lines.push(`- Stop early on <promise>${frontmatter.completionPromise}</promise>`);
  }
  return lines;
}

function isSafeCompletionPromise(value: string): boolean {
  return !/[\r\n<>]/.test(value);
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
  if (!Number.isFinite(fm.maxIterations) || !Number.isInteger(fm.maxIterations) || fm.maxIterations < 1 || fm.maxIterations > 50) {
    return "Invalid max_iterations: must be between 1 and 50";
  }
  if (!Number.isFinite(fm.timeout) || fm.timeout <= 0 || fm.timeout > 300) {
    return "Invalid timeout: must be greater than 0 and at most 300";
  }
  if (fm.completionPromise !== undefined && !isSafeCompletionPromise(fm.completionPromise)) {
    return "Invalid completion_promise: must be a single-line string without line breaks or angle brackets";
  }
  for (const pattern of fm.guardrails.blockCommands) {
    try {
      new RegExp(pattern);
    } catch {
      return `Invalid block_commands regex: ${pattern}`;
    }
  }
  for (const pattern of fm.guardrails.protectedFiles) {
    if (isUniversalProtectedGlob(pattern)) {
      return `Invalid protected_files glob: ${pattern}`;
    }
  }
  for (const cmd of fm.commands) {
    if (!cmd.name.trim()) {
      return "Invalid command: name is required";
    }
    if (!/^\w[\w-]*$/.test(cmd.name)) {
      return `Invalid command name: ${cmd.name} must match ^\\w[\\w-]*$`;
    }
    if (!cmd.run.trim()) {
      return `Invalid command ${cmd.name}: run is required`;
    }
    if (!Number.isFinite(cmd.timeout) || cmd.timeout <= 0 || cmd.timeout > 300) {
      return `Invalid command ${cmd.name}: timeout must be greater than 0 and at most 300`;
    }
    if (cmd.timeout > fm.timeout) {
      return `Invalid command ${cmd.name}: timeout must not exceed top-level timeout`;
    }
  }
  return null;
}

function parseCompletionPromiseValue(yaml: UnknownRecord): { present: boolean; value?: string; invalid: boolean } {
  if (!Object.prototype.hasOwnProperty.call(yaml, "completion_promise")) {
    return { present: false, invalid: false };
  }
  const value = yaml.completion_promise;
  if (typeof value !== "string" || !value.trim() || !isSafeCompletionPromise(value)) {
    return { present: true, invalid: true };
  }
  return { present: true, value, invalid: false };
}

export function acceptStrengthenedDraft(request: DraftRequest, strengthenedDraft: string): DraftPlan | null {
  const baseline = parseStrictRalphMarkdown(request.baselineDraft);
  const strengthened = parseStrictRalphMarkdown(strengthenedDraft);
  if ("error" in baseline || "error" in strengthened) {
    return null;
  }

  const validationError = validateFrontmatter(strengthened.parsed.frontmatter);
  if (validationError) {
    return null;
  }

  const baselineCompletion = parseCompletionPromiseValue(baseline.rawFrontmatter);
  const strengthenedCompletion = parseCompletionPromiseValue(strengthened.rawFrontmatter);
  if (baselineCompletion.invalid || strengthenedCompletion.invalid) {
    return null;
  }
  if (baselineCompletion.present !== strengthenedCompletion.present || baselineCompletion.value !== strengthenedCompletion.value) {
    return null;
  }

  if (baseline.parsed.frontmatter.maxIterations < strengthened.parsed.frontmatter.maxIterations) {
    return null;
  }
  if (baseline.parsed.frontmatter.timeout < strengthened.parsed.frontmatter.timeout) {
    return null;
  }
  if (
    baseline.parsed.frontmatter.guardrails.blockCommands.join("\n") !== strengthened.parsed.frontmatter.guardrails.blockCommands.join("\n") ||
    baseline.parsed.frontmatter.guardrails.protectedFiles.join("\n") !== strengthened.parsed.frontmatter.guardrails.protectedFiles.join("\n")
  ) {
    return null;
  }

  const baselineCommands = new Map(baseline.parsed.frontmatter.commands.map((command) => [command.name, command]));
  const seenCommands = new Set<string>();
  for (const command of strengthened.parsed.frontmatter.commands) {
    if (seenCommands.has(command.name)) {
      return null;
    }
    seenCommands.add(command.name);

    const baselineCommand = baselineCommands.get(command.name);
    if (!baselineCommand || baselineCommand.run !== command.run) {
      return null;
    }
    if (command.timeout > baselineCommand.timeout || command.timeout > strengthened.parsed.frontmatter.timeout) {
      return null;
    }
  }

  for (const placeholder of strengthened.parsed.body.matchAll(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g)) {
    if (!seenCommands.has(placeholder[1])) {
      return null;
    }
  }

  return renderDraftPlan(request.task, request.mode, request.target, strengthened.parsed.frontmatter, "llm-strengthened", strengthened.parsed.body);
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
    protectedFiles: mode === "analysis" ? [] : [SECRET_PATH_POLICY_TOKEN],
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
    ...(frontmatter.completionPromise ? [`completion_promise: ${yamlQuote(frontmatter.completionPromise)}`] : []),
    "guardrails:",
    ...(frontmatter.guardrails.blockCommands.length > 0
      ? ["  block_commands:", ...frontmatter.guardrails.blockCommands.map((pattern) => `    - ${yamlQuote(pattern)}`)]
      : ["  block_commands: []"]),
    ...(frontmatter.guardrails.protectedFiles.length > 0
      ? ["  protected_files:", ...frontmatter.guardrails.protectedFiles.map((pattern) => `    - ${yamlQuote(pattern)}`)]
      : ["  protected_files: []"]),
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
  const strengthened = parseStrictRalphMarkdown(strengthenedDraft);

  if (scope === "body-only") {
    if ("error" in strengthened || validateFrontmatter(strengthened.parsed.frontmatter)) {
      return renderDraftPlan(request.task, request.mode, request.target, baseline.frontmatter, "llm-strengthened", baseline.body);
    }

    return renderDraftPlan(request.task, request.mode, request.target, baseline.frontmatter, "llm-strengthened", strengthened.parsed.body);
  }

  const accepted = acceptStrengthenedDraft(request, strengthenedDraft);
  if (accepted) {
    return accepted;
  }

  return renderDraftPlan(request.task, request.mode, request.target, baseline.frontmatter, "llm-strengthened", baseline.body);
}

export function hasFakeRuntimeEnforcementClaim(text: string): boolean {
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
  const parsed = parseStrictRalphMarkdown(raw);

  if ("error" in parsed) {
    return { metadata, error: parsed.error };
  }

  const rawCompletionPromise = parseCompletionPromiseValue(parsed.rawFrontmatter);
  if (rawCompletionPromise.invalid) {
    return { metadata, parsed: parsed.parsed, error: "Invalid completion_promise: must be a single-line string without line breaks or angle brackets" };
  }

  const error = validateFrontmatter(parsed.parsed.frontmatter);
  return error ? { metadata, parsed: parsed.parsed, error } : { metadata, parsed: parsed.parsed };
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
  const commandLabels = parsed.frontmatter.commands.map(formatCommandLabel);
  const finishBehavior = summarizeFinishBehavior(parsed.frontmatter);
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
    ...finishBehavior,
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
