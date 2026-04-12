import { basename, normalize, relative, resolve } from "node:path";
import { minimatch } from "minimatch";

const SECRET_PATH_SEGMENTS = new Set([".aws", ".ssh", "secrets", "credentials", "ops-secrets", "credentials-prod"]);
const SECRET_BASENAMES = new Set([".npmrc", ".pypirc", ".netrc"]);
const SECRET_SUFFIXES = [".pem", ".key", ".asc"];
export const SECRET_PATH_POLICY_TOKEN = "policy:secret-bearing-paths";

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizePath(value: string): string {
  return toPosixPath(normalize(value));
}

function candidatePaths(path: string, cwd?: string): string[] {
  const candidates = new Set<string>();
  const normalizedRaw = normalizePath(path);
  if (normalizedRaw) candidates.add(normalizedRaw);

  const absolutePath = normalizePath(resolve(cwd ?? process.cwd(), path));
  if (absolutePath) candidates.add(absolutePath);

  if (cwd) {
    const repoRelative = toPosixPath(relative(cwd, absolutePath));
    if (repoRelative && !repoRelative.startsWith("..")) candidates.add(repoRelative);
  }

  return [...candidates];
}

function isSecretPathCandidate(candidatePath: string): boolean {
  const normalizedPath = toPosixPath(candidatePath).toLowerCase();
  if (!normalizedPath || normalizedPath.startsWith("..")) return false;

  const segments = normalizedPath.split("/").filter(Boolean);
  const normalizedName = basename(normalizedPath);
  return (
    normalizedName.startsWith(".env") ||
    SECRET_BASENAMES.has(normalizedName) ||
    SECRET_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix)) ||
    segments.some((segment) => SECRET_PATH_SEGMENTS.has(segment))
  );
}

export function isSecretBearingPath(relativePath: string): boolean {
  return isSecretPathCandidate(normalizePath(relativePath));
}

export function matchesProtectedPath(relativePath: string, protectedFiles: string[], cwd?: string): boolean {
  const candidates = candidatePaths(relativePath, cwd);
  return protectedFiles.some((pattern) =>
    candidates.some((candidate) =>
      pattern === SECRET_PATH_POLICY_TOKEN ? isSecretPathCandidate(candidate) : minimatch(candidate, pattern, { matchBase: true }),
    ),
  );
}

export function isSecretBearingTopLevelName(name: string): boolean {
  return isSecretBearingPath(name);
}

export function filterSecretBearingTopLevelNames(names: string[]): string[] {
  return names.filter((name) => !isSecretBearingTopLevelName(name));
}
