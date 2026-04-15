import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VersionBump = "major" | "minor" | "patch";
export type ReleaseBranch = "main" | "dev";

export interface ReleaseVersionRequest {
  branch: ReleaseBranch;
  bump: VersionBump;
  npmVersions: readonly string[] | string;
  gitTags: readonly string[] | string;
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const SEMVER_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const DEV_PRERELEASE = /^dev\.(\d+)$/;

function normalizeVersionList(input: readonly string[] | string): string[] {
  if (Array.isArray(input)) {
    return input.map((version) => version.trim()).filter(Boolean);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value).trim()).filter(Boolean);
    }

    if (typeof parsed === "string") {
      return parsed.trim() ? [parsed.trim()] : [];
    }
  } catch {
    // Fall through to line-based parsing.
  }

  return trimmed
    .split(/[\r\n,]+/)
    .map((version) => version.trim())
    .filter(Boolean);
}

function stripGitTagPrefix(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.match(SEMVER_VERSION);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function isStableVersion(version: string): boolean {
  return STABLE_VERSION.test(version);
}

function compareVersions(left: string, right: string): number {
  const leftParsed = parseVersion(left);
  const rightParsed = parseVersion(right);

  if (!leftParsed || !rightParsed) {
    return 0;
  }

  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major - rightParsed.major;
  }

  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor - rightParsed.minor;
  }

  return leftParsed.patch - rightParsed.patch;
}

function maxVersion(versions: string[]): string | null {
  return versions.reduce<string | null>((currentMax, version) => {
    if (!currentMax) {
      return version;
    }

    return compareVersions(version, currentMax) > 0 ? version : currentMax;
  }, null);
}

function incStable(version: string, bump: VersionBump): string {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Unsupported version: ${version}`);
  }

  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function collectStableVersions(input: readonly string[] | string): string[] {
  return normalizeVersionList(input)
    .map(stripGitTagPrefix)
    .filter(isStableVersion);
}

function highestStableVersion(npmVersions: readonly string[] | string, gitTags: readonly string[] | string): string {
  const stableNpm = collectStableVersions(npmVersions);
  const stableTags = collectStableVersions(gitTags);
  const highest = maxVersion([...stableNpm, ...stableTags]);
  return highest ?? "0.0.0";
}

function stableReleaseExistsAtOrAboveOne(npmVersions: readonly string[] | string, gitTags: readonly string[] | string): boolean {
  return [...collectStableVersions(npmVersions), ...collectStableVersions(gitTags)].some(
    (version) => compareVersions(version, "1.0.0") >= 0,
  );
}

function nextPrereleaseNumber(targetStable: string, npmVersions: readonly string[] | string, gitTags: readonly string[] | string): number {
  const used = new Set<number>();

  for (const rawVersion of [...normalizeVersionList(npmVersions), ...normalizeVersionList(gitTags)]) {
    const version = stripGitTagPrefix(rawVersion);
    const parsed = parseVersion(version);
    if (!parsed || `${parsed.major}.${parsed.minor}.${parsed.patch}` !== targetStable) {
      continue;
    }

    const prerelease = parsed.prerelease;
    if (!prerelease) {
      continue;
    }

    const match = prerelease.match(DEV_PRERELEASE);
    if (!match) {
      continue;
    }

    used.add(Number(match[1]));
  }

  let next = 0;
  while (used.has(next)) {
    next += 1;
  }

  return next;
}

export function computeReleaseVersion({ branch, bump, npmVersions, gitTags }: ReleaseVersionRequest): string {
  const baseStable = highestStableVersion(npmVersions, gitTags);
  let targetStable = incStable(baseStable, bump);

  if (!stableReleaseExistsAtOrAboveOne(npmVersions, gitTags)) {
    targetStable = compareVersions(targetStable, "1.0.0") < 0 ? "1.0.0" : targetStable;
  }

  if (branch === "main") {
    return targetStable;
  }

  const prereleaseNumber = nextPrereleaseNumber(targetStable, npmVersions, gitTags);
  return `${targetStable}-dev.${prereleaseNumber}`;
}

export const nextReleaseVersion = computeReleaseVersion;

function isReleaseBranch(value: string): value is ReleaseBranch {
  return value === "main" || value === "dev";
}

function isVersionBump(value: string): value is VersionBump {
  return value === "major" || value === "minor" || value === "patch";
}

function main(argv: string[]): void {
  const [branch, bump, npmVersions, gitTags] = argv;

  if (!branch || !bump || !npmVersions || !gitTags || !isReleaseBranch(branch) || !isVersionBump(bump)) {
    throw new Error("Usage: version-helper <main|dev> <major|minor|patch> <npm-versions> <git-tags>");
  }

  process.stdout.write(computeReleaseVersion({ branch, bump, npmVersions, gitTags }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
