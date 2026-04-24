import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SECRET_PATH_POLICY_TOKEN, filterSecretBearingTopLevelNames, isSecretBearingPath, isSecretBearingTopLevelName } from "./secret-paths.ts";

export type CommandDef = { name: string; run: string; timeout: number };
export type DraftSource = "deterministic" | "llm-strengthened" | "fallback";
export type DraftStrengtheningScope = "body-only" | "body-and-commands";
export type CompletionGateMode = "required" | "optional" | "disabled";
export type CommandIntent = CommandDef & { source: "heuristic" | "repo-signal" };
export type RuntimeArg = { name: string; value: string };
export type RuntimeArgs = Record<string, string>;
export type ShellPolicy =
  | { mode: "blocklist" }
  | { mode: "allowlist"; allow: string[] };
export type Frontmatter = {
  commands: CommandDef[];
  args?: string[];
  maxIterations: number;
  interIterationDelay: number;
  itemsPerIteration?: number;
  reflectEvery?: number;
  timeout: number;
  completionPromise?: string;
  completionGate?: CompletionGateMode;
  requiredOutputs?: string[];
  stopOnError: boolean;
  guardrails: { blockCommands: string[]; protectedFiles: string[]; shellPolicy?: ShellPolicy };
  invalidCommandEntries?: number[];
  invalidArgEntries?: number[];
};
export type ParsedRalph = { frontmatter: Frontmatter; body: string };
export type CommandOutput = { name: string; output: string };
export type RalphTargetResolution = {
  target: string;
  absoluteTarget: string;
  markdownPath: string;
};
export type CommandArgs = {
  mode: "path" | "task" | "auto";
  value: string;
  runtimeArgs: RuntimeArg[];
  error?: string;
};
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
  typecheckCommand?: string;
  checkCommand?: string;
  buildCommand?: string;
  verifyCommand?: string;
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

function parseStringArray(value: unknown): { values: string[]; invalidEntries?: number[] } {
  if (!Array.isArray(value)) return { values: [] };

  const invalidEntries: number[] = [];
  const values = value.flatMap((item, index) => {
    if (typeof item !== "string") {
      invalidEntries.push(index);
      return [];
    }
    return [item];
  });

  return { values, invalidEntries: invalidEntries.length > 0 ? invalidEntries : undefined };
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return Number(value);
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
  if (Object.prototype.hasOwnProperty.call(guardrails, "shell_policy")) {
    const shellPolicy = guardrails.shell_policy;
    if (!isRecord(shellPolicy)) {
      return "Invalid RALPH frontmatter: guardrails.shell_policy must be a YAML mapping";
    }
    if (Object.prototype.hasOwnProperty.call(shellPolicy, "mode") && typeof shellPolicy.mode !== "string") {
      return "Invalid RALPH frontmatter: guardrails.shell_policy.mode must be a YAML string";
    }
    if (Object.prototype.hasOwnProperty.call(shellPolicy, "allow") && !Array.isArray(shellPolicy.allow)) {
      return "Invalid RALPH frontmatter: guardrails.shell_policy.allow must be a YAML sequence";
    }
    if (Array.isArray(shellPolicy.allow)) {
      for (const [index, entry] of shellPolicy.allow.entries()) {
        if (typeof entry !== "string") {
          return `Invalid RALPH frontmatter: guardrails.shell_policy.allow[${index}] must be a YAML string`;
        }
      }
      if (shellPolicy.mode === "blocklist" && shellPolicy.allow.length > 0) {
        return "Invalid RALPH frontmatter: guardrails.shell_policy.allow must be absent or empty when mode is blocklist";
      }
    }
  }
  return null;
}

function validateRawCompletionGateShape(rawFrontmatter: UnknownRecord): string | null {
  if (!Object.prototype.hasOwnProperty.call(rawFrontmatter, "completion_gate")) {
    return null;
  }

  const completionGate = rawFrontmatter.completion_gate;
  if (typeof completionGate !== "string") {
    return "Invalid RALPH frontmatter: completion_gate must be a YAML string";
  }
  return null;
}

function validateRawRequiredOutputsShape(rawFrontmatter: UnknownRecord): string | null {
  if (!Object.prototype.hasOwnProperty.call(rawFrontmatter, "required_outputs")) {
    return null;
  }

  const requiredOutputs = rawFrontmatter.required_outputs;
  if (!Array.isArray(requiredOutputs)) {
    return "Invalid RALPH frontmatter: required_outputs must be a YAML sequence";
  }
  for (const [index, output] of requiredOutputs.entries()) {
    if (typeof output !== "string") {
      return `Invalid RALPH frontmatter: required_outputs[${index}] must be a YAML string`;
    }
  }
  return null;
}

function validateRawArgsShape(rawFrontmatter: UnknownRecord): string | null {
  if (!Object.prototype.hasOwnProperty.call(rawFrontmatter, "args")) {
    return null;
  }

  const args = rawFrontmatter.args;
  if (!Array.isArray(args)) {
    return "Invalid RALPH frontmatter: args must be a YAML sequence";
  }
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== "string") {
      return `Invalid RALPH frontmatter: args[${index}] must be a YAML string`;
    }
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

  if (Object.prototype.hasOwnProperty.call(rawFrontmatter, "completion_gate")) {
    const completionGateError = validateRawCompletionGateShape(rawFrontmatter);
    if (completionGateError) {
      return completionGateError;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "required_outputs")
  ) {
    const requiredOutputsError = validateRawRequiredOutputsShape(rawFrontmatter);
    if (requiredOutputsError) {
      return requiredOutputsError;
    }
  }

  if (Object.prototype.hasOwnProperty.call(rawFrontmatter, "args")) {
    const argsError = validateRawArgsShape(rawFrontmatter);
    if (argsError) {
      return argsError;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "max_iterations") &&
    (typeof rawFrontmatter.max_iterations !== "number" || !Number.isFinite(rawFrontmatter.max_iterations))
  ) {
    return "Invalid RALPH frontmatter: max_iterations must be a YAML number";
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "items_per_iteration") &&
    (typeof rawFrontmatter.items_per_iteration !== "number" || !Number.isFinite(rawFrontmatter.items_per_iteration))
  ) {
    return "Invalid RALPH frontmatter: items_per_iteration must be a YAML number";
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "reflect_every") &&
    (typeof rawFrontmatter.reflect_every !== "number" || !Number.isFinite(rawFrontmatter.reflect_every))
  ) {
    return "Invalid RALPH frontmatter: reflect_every must be a YAML number";
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrontmatter, "inter_iteration_delay") &&
    (typeof rawFrontmatter.inter_iteration_delay !== "number" || !Number.isFinite(rawFrontmatter.inter_iteration_delay))
  ) {
    return "Invalid RALPH frontmatter: inter_iteration_delay must be a YAML number";
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
  if (guardrails.shellPolicy?.mode === "allowlist") {
    labels.push(
      guardrails.shellPolicy.allow.length > 0
        ? `shell allowlist with ${guardrails.shellPolicy.allow.length} regex${guardrails.shellPolicy.allow.length === 1 ? "" : "es"}`
        : "shell allowlist",
    );
  } else if (guardrails.shellPolicy?.mode === "blocklist") {
    labels.push("shell command blocklist");
  }
  if (guardrails.protectedFiles.some((pattern) => pattern === SECRET_PATH_POLICY_TOKEN || isSecretBearingPath(pattern))) {
    labels.push("blocks write/edit to secret files");
  } else if (guardrails.protectedFiles.length > 0) {
    labels.push(`blocks write/edit to ${guardrails.protectedFiles.length} file glob${guardrails.protectedFiles.length === 1 ? "" : "s"}`);
  }
  return labels.length > 0 ? labels.join(" and ") : "No extra safety rules";
}

export function resolveCompletionGateMode(frontmatter: Frontmatter): CompletionGateMode {
  return frontmatter.completionGate ?? (frontmatter.completionPromise ? "required" : "disabled");
}

function summarizeFinishLabel(frontmatter: Frontmatter): string {
  const requiredOutputs = frontmatter.requiredOutputs ?? [];
  const labels = [`Stop after ${frontmatter.maxIterations} iterations or /ralph-stop`];
  if (frontmatter.completionPromise) {
    labels.push(`completion gate: ${resolveCompletionGateMode(frontmatter)}`);
    if (requiredOutputs.length > 0) {
      labels.push(`required outputs: ${requiredOutputs.join(", ")}`);
    }
  }
  return labels.join("; ");
}

function summarizeFinishBehavior(frontmatter: Frontmatter): string[] {
  const requiredOutputs = frontmatter.requiredOutputs ?? [];
  const gateMode = resolveCompletionGateMode(frontmatter);
  const lines = [
    `- Stop after ${frontmatter.maxIterations} iterations or /ralph-stop`,
    `- Stop if an iteration exceeds ${frontmatter.timeout}s`,
  ];

  if (frontmatter.completionPromise) {
    if (gateMode === "disabled") {
      lines.push(`- Stop early on <promise>${frontmatter.completionPromise}</promise>`);
      lines.push("- Completion gate is disabled, so required outputs and OPEN_QUESTIONS.md are not checked.");
    } else if (gateMode === "optional") {
      if (requiredOutputs.length > 0) {
        lines.push(`- Required outputs should exist before stopping: ${requiredOutputs.join(", ")}`);
      }
      lines.push("- OPEN_QUESTIONS.md should have no remaining P0/P1 items before stopping.");
      lines.push("- Completion gate is advisory; the loop may still stop when the promise is emitted.");
      lines.push(`- Stop early on <promise>${frontmatter.completionPromise}</promise>`);
    } else {
      if (requiredOutputs.length > 0) {
        lines.push(`- Required outputs must exist before stopping: ${requiredOutputs.join(", ")}`);
      }
      lines.push("- OPEN_QUESTIONS.md must have no remaining P0/P1 items before stopping.");
      lines.push(`- Stop early on <promise>${frontmatter.completionPromise}</promise>`);
    }
  }

  return lines;
}

function isSafeCompletionPromise(value: string): boolean {
  return !/[\r\n<>]/.test(value);
}

function validateRequiredOutputEntry(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith("\\") ||
    trimmed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return `Invalid required_outputs entry: ${value} must be a relative file path`;
  }
  return null;
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
  if (packageManager === "yarn") return `yarn run ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  if (script === "test") return "npm test";
  return `npm run ${script}`;
}

function detectPackageScripts(cwd: string, packageManager: RepoSignals["packageManager"]): Pick<RepoSignals, "testCommand" | "typecheckCommand" | "checkCommand" | "buildCommand" | "verifyCommand" | "lintCommand"> {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return {};

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    const result: Partial<Pick<RepoSignals, "testCommand" | "typecheckCommand" | "checkCommand" | "buildCommand" | "verifyCommand" | "lintCommand">> = {};

    const testValue = typeof scripts.test === "string" ? scripts.test : undefined;
    if (testValue && !/no test specified/i.test(testValue)) result.testCommand = packageRunCommand(packageManager, "test");
    if (typeof scripts.typecheck === "string") result.typecheckCommand = packageRunCommand(packageManager, "typecheck");
    if (typeof scripts.check === "string") result.checkCommand = packageRunCommand(packageManager, "check");
    if (typeof scripts.build === "string") result.buildCommand = packageRunCommand(packageManager, "build");
    if (typeof scripts.verify === "string") result.verifyCommand = packageRunCommand(packageManager, "verify");
    if (typeof scripts.lint === "string") result.lintCommand = packageRunCommand(packageManager, "lint");

    return result;
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
      `    run: ${yamlQuote(command.run)}`,
      `    timeout: ${command.timeout}`,
    ]),
  ];
}

function shellPolicyAllowPatterns(shellPolicy?: ShellPolicy): string[] {
  return shellPolicy?.mode === "allowlist" ? shellPolicy.allow : [];
}

function renderShellPolicyYaml(shellPolicy?: ShellPolicy): string[] {
  if (!shellPolicy) return [];
  return shellPolicy.mode === "allowlist"
    ? [
        "  shell_policy:",
        "    mode: allowlist",
        ...(shellPolicy.allow.length > 0
          ? ["    allow:", ...shellPolicy.allow.map((pattern) => `      - ${yamlQuote(pattern)}`)]
          : ["    allow: []"]),
      ]
    : ["  shell_policy:", "    mode: blocklist"];
}

function bodySection(title: string, placeholder: string): string {
  return `${title}:\n${placeholder}`;
}

function escapeHtmlCommentMarkers(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

export function defaultFrontmatter(): Frontmatter {
  return { commands: [], maxIterations: 50, interIterationDelay: 0, timeout: 300, requiredOutputs: [], stopOnError: true, guardrails: { blockCommands: [], protectedFiles: [] } };
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
  const parsedArgs = parseStringArray(yaml.args);
  const guardrails = isRecord(yaml.guardrails) ? yaml.guardrails : {};
  const rawShellPolicy = isRecord(guardrails.shell_policy) ? guardrails.shell_policy : undefined;
  const itemsPerIteration = parseOptionalNumber(yaml.items_per_iteration);
  const reflectEvery = parseOptionalNumber(yaml.reflect_every);

  return {
    frontmatter: {
      commands,
      ...(parsedArgs.values.length > 0 ? { args: parsedArgs.values } : {}),
      maxIterations: Number(yaml.max_iterations ?? 50),
      interIterationDelay: Number(yaml.inter_iteration_delay ?? 0),
      ...(itemsPerIteration !== undefined ? { itemsPerIteration } : {}),
      ...(reflectEvery !== undefined ? { reflectEvery } : {}),
      timeout: Number(yaml.timeout ?? 300),
      completionPromise:
        typeof yaml.completion_promise === "string" && yaml.completion_promise.trim() ? yaml.completion_promise : undefined,
      ...(typeof yaml.completion_gate === "string" && yaml.completion_gate.trim() ? { completionGate: yaml.completion_gate as CompletionGateMode } : {}),
      requiredOutputs: toStringArray(yaml.required_outputs),
      stopOnError: yaml.stop_on_error === false ? false : true,
      guardrails: {
        blockCommands: toStringArray(guardrails.block_commands),
        protectedFiles: toStringArray(guardrails.protected_files),
        ...(rawShellPolicy
          ? {
              shellPolicy:
                String(rawShellPolicy.mode ?? "") === "allowlist"
                  ? { mode: "allowlist", allow: toStringArray(rawShellPolicy.allow) }
                  : ({ mode: String(rawShellPolicy.mode ?? "") as ShellPolicy["mode"] } as ShellPolicy),
            }
          : {}),
      },
      invalidCommandEntries: invalidCommandEntries.length > 0 ? invalidCommandEntries : undefined,
      ...(parsedArgs.invalidEntries ? { invalidArgEntries: parsedArgs.invalidEntries } : {}),
    },
    body: match[2] ?? "",
  };
}

export function validateFrontmatter(fm: Frontmatter): string | null {
  if ((fm.invalidCommandEntries?.length ?? 0) > 0) {
    return `Invalid command entry at index ${fm.invalidCommandEntries![0]}`;
  }
  if ((fm.invalidArgEntries?.length ?? 0) > 0) {
    return `Invalid args entry at index ${fm.invalidArgEntries![0]}`;
  }
  if (!Number.isFinite(fm.maxIterations) || !Number.isInteger(fm.maxIterations) || fm.maxIterations < 1 || fm.maxIterations > 50) {
    return "Invalid max_iterations: must be between 1 and 50";
  }
  if (!Number.isFinite(fm.interIterationDelay) || !Number.isInteger(fm.interIterationDelay) || fm.interIterationDelay < 0) {
    return "Invalid inter_iteration_delay: must be a non-negative integer";
  }
  if (fm.itemsPerIteration !== undefined && (!Number.isFinite(fm.itemsPerIteration) || !Number.isInteger(fm.itemsPerIteration) || fm.itemsPerIteration < 1 || fm.itemsPerIteration > 20)) {
    return "Invalid items_per_iteration: must be an integer between 1 and 20";
  }
  if (fm.reflectEvery !== undefined && (!Number.isFinite(fm.reflectEvery) || !Number.isInteger(fm.reflectEvery) || fm.reflectEvery < 2 || fm.reflectEvery > 20)) {
    return "Invalid reflect_every: must be an integer between 2 and 20";
  }
  if (!Number.isFinite(fm.timeout) || fm.timeout <= 0 || fm.timeout > 300) {
    return "Invalid timeout: must be greater than 0 and at most 300";
  }
  if (fm.completionPromise !== undefined && !isSafeCompletionPromise(fm.completionPromise)) {
    return "Invalid completion_promise: must be a single-line string without line breaks or angle brackets";
  }
  if (fm.completionGate !== undefined && !["required", "optional", "disabled"].includes(fm.completionGate)) {
    return "Invalid completion_gate: must be required, optional, or disabled";
  }
  const args = fm.args ?? [];
  const seenArgNames = new Set<string>();
  for (const arg of args) {
    if (!arg.trim()) {
      return "Invalid arg: name is required";
    }
    if (!/^\w[\w-]*$/.test(arg)) {
      return `Invalid arg name: ${arg} must match ^\\w[\\w-]*$`;
    }
    if (seenArgNames.has(arg)) {
      return "Invalid args: names must be unique";
    }
    seenArgNames.add(arg);
  }
  if (typeof fm.stopOnError !== "boolean") {
    return "Invalid stop_on_error: must be true or false";
  }
  for (const output of fm.requiredOutputs ?? []) {
    const requiredOutputError = validateRequiredOutputEntry(output);
    if (requiredOutputError) {
      return requiredOutputError;
    }
  }
  for (const pattern of fm.guardrails.blockCommands) {
    try {
      new RegExp(pattern);
    } catch {
      return `Invalid block_commands regex: ${pattern}`;
    }
  }
  const shellPolicy = fm.guardrails.shellPolicy;
  if (shellPolicy !== undefined) {
    if (shellPolicy.mode !== "blocklist" && shellPolicy.mode !== "allowlist") {
      return "Invalid shell_policy.mode: must be blocklist or allowlist";
    }
    if (shellPolicy.mode === "allowlist") {
      const allow = (shellPolicy as { allow?: string[] }).allow;
      if (!Array.isArray(allow) || allow.length === 0) {
        return "Invalid shell_policy.allow: allowlist mode requires at least one regex";
      }
      for (const pattern of allow) {
        try {
          new RegExp(pattern);
        } catch {
          return `Invalid shell_policy.allow regex: ${pattern}`;
        }
      }
    } else if ((shellPolicy as { allow?: string[] }).allow?.length) {
      return "Invalid shell_policy.allow: blocklist mode must be absent or empty when mode is blocklist";
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

  const baselineRequiredOutputs = baseline.parsed.frontmatter.requiredOutputs ?? [];
  const strengthenedRequiredOutputs = strengthened.parsed.frontmatter.requiredOutputs ?? [];
  if (baselineRequiredOutputs.join("\n") !== strengthenedRequiredOutputs.join("\n")) {
    return null;
  }

  const baselineArgs = baseline.parsed.frontmatter.args ?? [];
  const strengthenedArgs = strengthened.parsed.frontmatter.args ?? [];
  if (baselineArgs.join("\n") !== strengthenedArgs.join("\n")) {
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
  const baselineShellPolicy = baseline.parsed.frontmatter.guardrails.shellPolicy;
  const strengthenedShellPolicy = strengthened.parsed.frontmatter.guardrails.shellPolicy;
  if (
    baseline.parsed.frontmatter.guardrails.blockCommands.join("\n") !== strengthened.parsed.frontmatter.guardrails.blockCommands.join("\n") ||
    baseline.parsed.frontmatter.guardrails.protectedFiles.join("\n") !== strengthened.parsed.frontmatter.guardrails.protectedFiles.join("\n") ||
    baselineShellPolicy?.mode !== strengthenedShellPolicy?.mode ||
    shellPolicyAllowPatterns(baselineShellPolicy).join("\n") !== shellPolicyAllowPatterns(strengthenedShellPolicy).join("\n")
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

  if (collectArgPlaceholderNames(strengthened.parsed.body).length > 0) {
    return null;
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

export function findAllowedCommandPattern(command: string, allowPatterns: string[]): string | undefined {
  for (const pattern of allowPatterns) {
    try {
      if (new RegExp(`^(?:${pattern})$`).test(command)) return pattern;
    } catch {
      // ignore malformed regexes; validateFrontmatter should catch these first
    }
  }
  return undefined;
}

export function findShellPolicyBlockedCommandPattern(command: string, shellPolicy?: Frontmatter["guardrails"]["shellPolicy"]): string | undefined {
  if (!shellPolicy || shellPolicy.mode !== "allowlist") return undefined;
  return findAllowedCommandPattern(command, shellPolicy.allow) ? undefined : "shell_policy.allowlist";
}

function hasRuntimeArgToken(text: string): boolean {
  return /(?:^|\s)--arg(?:\s|=)/.test(text);
}

function parseRuntimeArgEntry(token: string): { entry?: RuntimeArg; error?: string } {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex < 0) {
    return { error: "Invalid --arg entry: name=value is required" };
  }

  const name = token.slice(0, equalsIndex).trim();
  const value = token.slice(equalsIndex + 1);
  if (!name) {
    return { error: "Invalid --arg entry: name is required" };
  }
  if (!value) {
    return { error: "Invalid --arg entry: value is required" };
  }

  return { entry: { name, value } };
}

function parseExplicitPathRuntimeArgs(rawTail: string): { runtimeArgs: RuntimeArg[]; error?: string } {
  const runtimeArgs: RuntimeArg[] = [];
  const trimmed = rawTail.trim();
  if (!trimmed) {
    return { runtimeArgs };
  }

  const syntaxError = "Invalid --arg syntax: values must be a single token and no trailing text is allowed";
  let index = 0;

  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index])) {
      index += 1;
    }
    if (index >= trimmed.length) {
      break;
    }

    if (!trimmed.startsWith("--arg", index) || (trimmed[index + 5] !== undefined && !/\s/.test(trimmed[index + 5]))) {
      return { runtimeArgs, error: syntaxError };
    }
    index += 5;

    while (index < trimmed.length && /\s/.test(trimmed[index])) {
      index += 1;
    }
    if (index >= trimmed.length) {
      return { runtimeArgs, error: "Invalid --arg entry: name=value is required" };
    }

    const nameStart = index;
    while (index < trimmed.length && trimmed[index] !== "=" && !/\s/.test(trimmed[index])) {
      index += 1;
    }

    const name = trimmed.slice(nameStart, index).trim();
    if (!name) {
      return { runtimeArgs, error: "Invalid --arg entry: name is required" };
    }
    if (index >= trimmed.length || trimmed[index] !== "=") {
      return { runtimeArgs, error: "Invalid --arg entry: name=value is required" };
    }
    index += 1;

    if (index >= trimmed.length || /\s/.test(trimmed[index])) {
      return { runtimeArgs, error: "Invalid --arg entry: value is required" };
    }

    let value = "";
    const quote = trimmed[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      while (index < trimmed.length && trimmed[index] !== quote) {
        value += trimmed[index];
        index += 1;
      }
      if (index >= trimmed.length) {
        return { runtimeArgs, error: syntaxError };
      }
      if (index + 1 < trimmed.length && !/\s/.test(trimmed[index + 1])) {
        return { runtimeArgs, error: syntaxError };
      }
      index += 1;
    } else {
      while (index < trimmed.length && !/\s/.test(trimmed[index])) {
        const char = trimmed[index];
        if (char === "'" || char === '"') {
          return { runtimeArgs, error: syntaxError };
        }
        value += char;
        index += 1;
      }
    }

    const parsed = parseRuntimeArgEntry(`${name}=${value}`);
    if (parsed.error) {
      return { runtimeArgs, error: parsed.error };
    }

    const entry = parsed.entry;
    if (!entry) {
      return { runtimeArgs, error: "Invalid --arg entry: name=value is required" };
    }

    if (runtimeArgs.some((existing) => existing.name === entry.name)) {
      return { runtimeArgs, error: `Duplicate --arg: ${entry.name}` };
    }

    runtimeArgs.push(entry);

    while (index < trimmed.length && /\s/.test(trimmed[index])) {
      index += 1;
    }
    if (index < trimmed.length && !trimmed.startsWith("--arg", index)) {
      return { runtimeArgs, error: syntaxError };
    }
  }

  return { runtimeArgs };
}

function parseExplicitPathCommandArgs(valueWithArgs: string): CommandArgs {
  const argMatch = valueWithArgs.match(/(?:^|\s)--arg(?:\s|=|[^\s=]*=|$)/);
  const argIndex = argMatch?.index ?? valueWithArgs.length;
  const value = argMatch ? valueWithArgs.slice(0, argIndex).trim() : valueWithArgs.trim();
  const parsedArgs = parseExplicitPathRuntimeArgs(argMatch ? valueWithArgs.slice(argIndex).trim() : "");
  return { mode: "path", value, runtimeArgs: parsedArgs.runtimeArgs, error: parsedArgs.error ?? undefined };
}

export function parseCommandArgs(raw: string): CommandArgs {
  const cleaned = raw.trim();

  if (cleaned.startsWith("--task=")) {
    const value = cleaned.slice("--task=".length).trim();
    if (hasRuntimeArgToken(value)) {
      return { mode: "task", value, runtimeArgs: [], error: "--arg is only supported with /ralph --path" };
    }
    return { mode: "task", value, runtimeArgs: [], error: undefined };
  }
  if (cleaned.startsWith("--task ")) {
    const value = cleaned.slice("--task ".length).trim();
    if (hasRuntimeArgToken(value)) {
      return { mode: "task", value, runtimeArgs: [], error: "--arg is only supported with /ralph --path" };
    }
    return { mode: "task", value, runtimeArgs: [], error: undefined };
  }
  if (cleaned.startsWith("--path=")) {
    return parseExplicitPathCommandArgs(cleaned.slice("--path=".length).trimStart());
  }
  if (cleaned.startsWith("--path ")) {
    return parseExplicitPathCommandArgs(cleaned.slice("--path ".length).trimStart());
  }
  return { mode: "auto", value: cleaned, runtimeArgs: [], error: undefined };
}

export function runtimeArgEntriesToMap(entries: RuntimeArg[]): { runtimeArgs: RuntimeArgs; error?: string } {
  const runtimeArgs = Object.create(null) as RuntimeArgs;
  for (const entry of entries) {
    if (!entry.name.trim()) {
      return { runtimeArgs, error: "Invalid --arg entry: name is required" };
    }
    if (!entry.value.trim()) {
      return { runtimeArgs, error: "Invalid --arg entry: value is required" };
    }
    if (!/^\w[\w-]*$/.test(entry.name)) {
      return { runtimeArgs, error: `Invalid --arg name: ${entry.name} must match ^\\w[\\w-]*$` };
    }
    if (Object.prototype.hasOwnProperty.call(runtimeArgs, entry.name)) {
      return { runtimeArgs, error: `Duplicate --arg: ${entry.name}` };
    }
    runtimeArgs[entry.name] = entry.value;
  }
  return { runtimeArgs };
}

function collectArgPlaceholderNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\{\{\s*args\.(\w[\w-]*)\s*\}\}/g)) {
    names.add(match[1]);
  }
  return [...names];
}

function validateBodyArgsAgainstContract(body: string, declaredArgs: string[] | undefined): string | null {
  const declaredSet = new Set(declaredArgs ?? []);
  for (const name of collectArgPlaceholderNames(body)) {
    if (!declaredSet.has(name)) {
      return `Undeclared arg placeholder: ${name}`;
    }
  }
  return null;
}

export function validateRuntimeArgs(frontmatter: Frontmatter, body: string, commands: CommandDef[], runtimeArgs: RuntimeArgs): string | null {
  const declaredArgs = frontmatter.args ?? [];
  const declaredSet = new Set(declaredArgs);

  for (const name of Object.keys(runtimeArgs)) {
    if (!declaredSet.has(name)) {
      return `Undeclared arg: ${name}`;
    }
  }

  for (const name of declaredArgs) {
    if (!Object.prototype.hasOwnProperty.call(runtimeArgs, name)) {
      return `Missing required arg: ${name}`;
    }
  }

  for (const name of collectArgPlaceholderNames(body)) {
    if (!declaredSet.has(name)) {
      return `Undeclared arg placeholder: ${name}`;
    }
  }
  for (const command of commands) {
    for (const name of collectArgPlaceholderNames(command.run)) {
      if (!declaredSet.has(name)) {
        return `Undeclared arg placeholder: ${name}`;
      }
    }
  }

  return null;
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
    ...packageScripts,
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
      ...(signals.typecheckCommand ? [`typecheck command: ${signals.typecheckCommand}`] : []),
      ...(signals.checkCommand ? [`check command: ${signals.checkCommand}`] : []),
      ...(signals.buildCommand ? [`build command: ${signals.buildCommand}`] : []),
      ...(signals.verifyCommand ? [`verify command: ${signals.verifyCommand}`] : []),
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

const REPO_MAP_PRUNED_DIR_NAMES = [".git", ".env*", "node_modules", "dist", "build", "coverage", ".cache", ".turbo", "vendor"];
const REPO_MAP_SECRET_DIR_NAMES = [".aws", ".azure", ".gcloud", ".ssh", "secrets", "credentials", "ops-secrets", "credentials-prod"];
const REPO_MAP_SECRET_FILE_GLOBS = [".git", ".env*", ".npmrc", ".pypirc", ".netrc", "*.pem", "*.key", "*.asc"];

function buildRepoMapPruneSequence(kind: "d" | "f", names: readonly string[]): string {
  return names.map((name) => `-type ${kind} -name ${shellQuote(name)} -prune`).join(" -o ");
}

export function buildRepoMapCommand(): string {
  return `find . -maxdepth 2 ${buildRepoMapPruneSequence("d", REPO_MAP_PRUNED_DIR_NAMES)} -o ${buildRepoMapPruneSequence("d", REPO_MAP_SECRET_DIR_NAMES)} -o ${buildRepoMapPruneSequence("f", REPO_MAP_SECRET_FILE_GLOBS)} -o -type f -print | sort | head -n 120`;
}

export const REPO_MAP_COMMAND = buildRepoMapCommand();

export function buildCommandIntent(mode: DraftMode, signals: RepoSignals): CommandIntent[] {
  if (mode === "analysis") {
    const commands: CommandIntent[] = [{ name: "repo-map", run: REPO_MAP_COMMAND, timeout: 20, source: "heuristic" }];
    if (signals.hasGit) commands.unshift({ name: "git-log", run: "git log --oneline -10", timeout: 20, source: "heuristic" });
    return commands;
  }

  const commands: CommandIntent[] = [];
  if (signals.testCommand) {
    commands.push({ name: "tests", run: signals.testCommand, timeout: 120, source: "repo-signal" });
  } else if (signals.verifyCommand) {
    commands.push({ name: "verify", run: signals.verifyCommand, timeout: 120, source: "repo-signal" });
  }

  if (signals.typecheckCommand) {
    commands.push({ name: "typecheck", run: signals.typecheckCommand, timeout: 120, source: "repo-signal" });
  } else if (signals.checkCommand) {
    commands.push({ name: "check", run: signals.checkCommand, timeout: 120, source: "repo-signal" });
  }

  if (signals.buildCommand) commands.push({ name: "build", run: signals.buildCommand, timeout: 120, source: "repo-signal" });
  if (signals.lintCommand) commands.push({ name: "lint", run: signals.lintCommand, timeout: 90, source: "repo-signal" });
  if (signals.hasGit) commands.push({ name: "git-log", run: "git log --oneline -10", timeout: 20, source: "heuristic" });
  if (commands.length === 0) commands.push({ name: "repo-map", run: REPO_MAP_COMMAND, timeout: 20, source: "heuristic" });
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
    interIterationDelay: 0,
    timeout: 300,
    requiredOutputs: [],
    stopOnError: true,
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
  const requiredOutputs = frontmatter.requiredOutputs ?? [];
  const frontmatterLines = [
    ...renderCommandsYaml(frontmatter.commands),
    `max_iterations: ${frontmatter.maxIterations}`,
    `inter_iteration_delay: ${frontmatter.interIterationDelay}`,
    `timeout: ${frontmatter.timeout}`,
    ...(frontmatter.stopOnError === false ? ["stop_on_error: false"] : []),
    ...(requiredOutputs.length > 0
      ? ["required_outputs:", ...requiredOutputs.map((output) => `  - ${yamlQuote(output)}`)]
      : []),
    ...(frontmatter.completionPromise ? [`completion_promise: ${yamlQuote(frontmatter.completionPromise)}`] : []),
    "guardrails:",
    ...(frontmatter.guardrails.shellPolicy ? renderShellPolicyYaml(frontmatter.guardrails.shellPolicy) : []),
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
    finishLabel: summarizeFinishLabel(frontmatter),
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
    if (
      "error" in strengthened ||
      validateFrontmatter(strengthened.parsed.frontmatter) ||
      validateBodyArgsAgainstContract(strengthened.parsed.body, baseline.frontmatter.args)
    ) {
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

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

export function replaceArgsPlaceholders(text: string, runtimeArgs: RuntimeArgs, shellSafe = false): string {
  return text.replace(/\{\{\s*args\.(\w[\w-]*)\s*\}\}/g, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(runtimeArgs, name)) {
      throw new Error(`Missing required arg: ${name}`);
    }
    const value = runtimeArgs[name];
    return shellSafe ? shellQuote(value) : value;
  });
}

export function resolvePlaceholders(
  body: string,
  outputs: CommandOutput[],
  ralph: { iteration: number; name: string; maxIterations: number },
  runtimeArgs: RuntimeArgs = {},
): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  const resolved = replaceArgsPlaceholders(
    body
      .replace(/\{\{\s*ralph\.iteration\s*\}\}/g, String(ralph.iteration))
      .replace(/\{\{\s*ralph\.name\s*\}\}/g, ralph.name)
      .replace(/\{\{\s*ralph\.max_iterations\s*\}\}/g, String(ralph.maxIterations)),
    runtimeArgs,
  );
  return resolved.replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "");
}

export function resolveCommandRun(run: string, runtimeArgs: RuntimeArgs): string {
  return replaceArgsPlaceholders(run, runtimeArgs, true);
}

export function renderRalphBody(
  body: string,
  outputs: CommandOutput[],
  ralph: { iteration: number; name: string; maxIterations: number },
  runtimeArgs: RuntimeArgs = {},
): string {
  return resolvePlaceholders(body, outputs, ralph, runtimeArgs).replace(/<!--[\s\S]*?-->/g, "");
}

export function renderIterationPrompt(
  body: string,
  iteration: number,
  maxIterations: number,
  completionGate?: { completionPromise?: string; requiredOutputs?: string[]; completionGateMode?: CompletionGateMode; failureReasons?: string[]; rejectionReasons?: string[] },
  pacing?: { itemsPerIteration?: number; reflectEvery?: number },
): string {
  const extraBlocks: string[] = [];

  const pacingLines: string[] = [];
  if (pacing?.itemsPerIteration !== undefined) {
    pacingLines.push("[pacing]", `- Keep this iteration to at most ${pacing.itemsPerIteration} items.`);
  }
  if (pacing?.reflectEvery !== undefined && iteration % pacing.reflectEvery === 0) {
    pacingLines.push("[reflection checkpoint]", `- This iteration is a reflection checkpoint. Pause to reflect on progress, remaining work, and blockers before continuing.`);
  }
  if (pacingLines.length > 0) {
    extraBlocks.push(pacingLines.join("\n"));
  }

  if (completionGate) {
    const requiredOutputs = completionGate.requiredOutputs ?? [];
    const failureReasons = completionGate.failureReasons ?? [];
    const rejectionReasons = completionGate.rejectionReasons ?? [];
    const completionPromise = completionGate.completionPromise ?? "DONE";
    const completionGateMode = completionGate.completionGateMode ?? "required";
    if (completionGateMode !== "disabled") {
      const gateLines = [
        "[completion gate]",
        completionGateMode === "optional"
          ? `- Completion gate is advisory${requiredOutputs.length > 0 ? `: ${requiredOutputs.join(", ")}` : "."}`
          : `- Required outputs must exist before stopping${requiredOutputs.length > 0 ? `: ${requiredOutputs.join(", ")}` : "."}`,
        completionGateMode === "optional"
          ? "- OPEN_QUESTIONS.md should have no remaining P0/P1 items before stopping."
          : "- OPEN_QUESTIONS.md must have no remaining P0/P1 items before stopping.",
        "- Label inferred claims as HYPOTHESIS.",
        ...(rejectionReasons.length > 0
          ? ["[completion gate rejection]", `- Still missing: ${rejectionReasons.join("; ")}`]
          : []),
        ...(failureReasons.length > 0 ? [`- Previous gate failures: ${failureReasons.join("; ")}`] : []),
        completionGateMode === "optional"
          ? `- Emit <promise>${completionPromise}</promise> once the work is complete, even if advisory outputs are still missing.`
          : `- Emit <promise>${completionPromise}</promise> only when the gate is truly satisfied.`,
      ];
      extraBlocks.push(gateLines.join("\n"));
    }
  }

  return extraBlocks.length > 0
    ? `[ralph: iteration ${iteration}/${maxIterations}]\n\n${body}\n\n${extraBlocks.join("\n\n")}`
    : `[ralph: iteration ${iteration}/${maxIterations}]\n\n${body}`;
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
