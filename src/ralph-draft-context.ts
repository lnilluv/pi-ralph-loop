import { closeSync, openSync, opendirSync, readSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { slugifyTask, type DraftMode, type RepoContext, type RepoContextSelectedFile, type RepoSignals } from "./ralph.ts";

export const MAX_SCAN_DEPTH = 3;
export const MAX_CANDIDATE_PATHS = 200;
export const MAX_SELECTED_FILES = 6;
export const MAX_FILE_BYTES = 8_000;
export const MAX_TOTAL_BYTES = 40_000;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const SECRET_PATH_SEGMENTS = new Set(["secret", "secrets", "credential", "credentials", ".aws", ".ssh"]);
const SECRET_BASENAMES = new Set([".npmrc", ".pypirc", ".netrc", "authorized_keys", "known_hosts", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SECRET_SUFFIXES = [".pem", ".key", ".crt", ".cer", ".der", ".p12", ".pfx", ".jks", ".keystore"];
const STOPWORDS = new Set(["fix", "reverse", "engineer", "this", "app", "tests", "the", "and", "to"]);

const TOP_LEVEL_PRIORITY = new Map<string, { score: number; reason: string }>([
  ["README.md", { score: 10_000, reason: "repo overview" }],
  ["package.json", { score: 9_900, reason: "package manifest" }],
  ["pyproject.toml", { score: 9_800, reason: "python project manifest" }],
  ["Cargo.toml", { score: 9_700, reason: "cargo manifest" }],
  ["tsconfig.json", { score: 9_600, reason: "typescript config" }],
]);

const DIRECTORY_PRIORITY_NAMES = new Map<string, { score: number; reason: string }>([
  ["src", { score: 3_000, reason: "source directory" }],
  ["app", { score: 2_900, reason: "application directory" }],
  ["lib", { score: 2_800, reason: "library directory" }],
  ["server", { score: 2_700, reason: "server directory" }],
  ["client", { score: 2_600, reason: "client directory" }],
  ["config", { score: 2_500, reason: "config directory" }],
  ["configs", { score: 2_500, reason: "config directory" }],
  ["settings", { score: 2_500, reason: "config directory" }],
  ["test", { score: 2_400, reason: "test directory" }],
  ["tests", { score: 2_400, reason: "test directory" }],
  ["__tests__", { score: 2_400, reason: "test directory" }],
]);

const MAX_DIR_ENTRIES_PER_DIR = 200;
const MAX_PRIORITY_SCAN_ENTRIES_PER_DIR = 1_000;

const CONFIG_PRIORITY: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /^vitest\.config\.[^.\/]+$/, score: 9_000, reason: "test runner config" },
  { pattern: /^jest\.config\.[^.\/]+$/, score: 8_900, reason: "test runner config" },
  { pattern: /^eslint\.config\.[^.\/]+$/, score: 8_800, reason: "lint config" },
  { pattern: /^vite\.config\.[^.\/]+$/, score: 8_700, reason: "build config" },
  { pattern: /^next\.config\.[^.\/]+$/, score: 8_600, reason: "framework config" },
  { pattern: /^[^.\/]+\.config\.[^.\/]+$/, score: 8_500, reason: "config file" },
];

const ENTRYPOINT_PRIORITY: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /^src\/index\.[^.\/]+$/, score: 8_000, reason: "likely app entrypoint" },
  { pattern: /^src\/main\.[^.\/]+$/, score: 7_900, reason: "likely app entrypoint" },
  { pattern: /^src\/app\.[^.\/]+$/, score: 7_800, reason: "likely app entrypoint" },
  { pattern: /^src\/server\.[^.\/]+$/, score: 7_700, reason: "likely app entrypoint" },
  { pattern: /^(app|server)\.[^.\/]+$/, score: 7_600, reason: "likely app entrypoint" },
];

type DirectoryPriority = { score: number; reason: string };

type DirectoryEntryCandidate = {
  entry: { name: string; isDirectory(): boolean; isFile(): boolean };
  absolutePath: string;
  relativePath: string;
  priority: DirectoryPriority;
};

type Candidate = {
  path: string;
  absolutePath: string;
  depth: number;
  size: number;
  score: number;
  reason: string;
  matchedKeywords: string[];
  category: "top-level" | "config" | "entrypoint" | "test" | "keyword" | "fallback";
};

type RootCandidate =
  | {
      kind: "file";
      name: string;
      absolutePath: string;
      relativePath: string;
      score: ReturnType<typeof scoreCandidate>;
    }
  | {
      kind: "directory";
      name: string;
      absolutePath: string;
      relativePath: string;
      score: DirectoryPriority;
    };

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

function isSecretBearingPath(relativePath: string): boolean {
  const normalizedPath = toPosixPath(relativePath).toLowerCase();
  if (!normalizedPath || normalizedPath.startsWith("..")) return false;

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.some((segment) => SECRET_PATH_SEGMENTS.has(segment))) return true;

  const normalizedName = basename(normalizedPath);
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SECRET_BASENAMES.has(normalizedName) ||
    SECRET_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix)) ||
    normalizedName.includes("secret") ||
    normalizedName.includes("credential")
  );
}

function isSecretBearingFile(relativePath: string): boolean {
  return isSecretBearingPath(relativePath);
}

function isPriorityEntrypointFile(relativePath: string): boolean {
  return ENTRYPOINT_PRIORITY.some((entry) => entry.pattern.test(relativePath));
}

function isTopLevelPriorityFile(relativePath: string): boolean {
  if (relativePath.indexOf("/") !== -1) return false;
  return TOP_LEVEL_PRIORITY.has(relativePath) || CONFIG_PRIORITY.some((entry) => entry.pattern.test(relativePath)) || isPriorityEntrypointFile(relativePath);
}

function isPriorityWildcardFile(relativePath: string): boolean {
  return CONFIG_PRIORITY.some((entry) => entry.pattern.test(relativePath)) || isPriorityEntrypointFile(relativePath);
}

function directoryNamePriority(name: string, keywords: string[]): DirectoryPriority {
  const normalized = name.toLowerCase();
  const fixed = DIRECTORY_PRIORITY_NAMES.get(normalized);
  if (fixed) return fixed;

  const matchedKeywords = keywords.filter((keyword) => tokenizePath(name).includes(keyword));
  if (matchedKeywords.length > 0) {
    return {
      score: 2_200 + matchedKeywords.length * 100,
      reason: `matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}`,
    };
  }

  return { score: 0, reason: "directory" };
}

function readDirBounded(
  absolutePath: string,
  limit: number,
  cache: Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>,
  offset = 0,
): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
  const cacheKey = `${absolutePath}\0${offset}\0${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let dir;
  try {
    dir = opendirSync(absolutePath);
  } catch {
    cache.set(cacheKey, []);
    return [];
  }

  const entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  let skipped = 0;

  try {
    while (entries.length < limit) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      entries.push(entry as { name: string; isDirectory(): boolean; isFile(): boolean });
    }
  } catch {
    // Keep the bounded snapshot gathered so far.
  } finally {
    try {
      dir.closeSync();
    } catch {
      // Ignore close failures after a bounded read.
    }
  }

  cache.set(cacheKey, entries);
  return entries;
}

function directoryPriority(
  cwd: string,
  absolutePath: string,
  mode: DraftMode,
  keywords: string[],
  dirEntriesCache: Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>,
  directoryPriorityCache: Map<string, DirectoryPriority>,
): DirectoryPriority {
  const cached = directoryPriorityCache.get(absolutePath);
  if (cached) return cached;

  let best = directoryNamePriority(basename(absolutePath), keywords);
  const entries = readDirBounded(absolutePath, MAX_DIR_ENTRIES_PER_DIR, dirEntriesCache);

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const childAbsolutePath = join(absolutePath, entry.name);
    const childRelativePath = toPosixPath(relative(cwd, childAbsolutePath));
    if (!childRelativePath || childRelativePath.startsWith("..")) continue;
    if (isSecretBearingFile(childRelativePath)) continue;

    const childScore = scoreCandidate(childRelativePath, mode, keywords);
    if (childScore.score > best.score) {
      best = { score: childScore.score, reason: childScore.reason };
    }
  }

  directoryPriorityCache.set(absolutePath, best);
  return best;
}

function fileDepth(relativePath: string): number {
  const normalized = toPosixPath(relativePath);
  if (!normalized || normalized === ".") return 0;
  return normalized.split("/").length - 1;
}

function collectCandidates(cwd: string, mode: DraftMode, keywords: string[], signals: RepoSignals): Candidate[] {
  const candidates: Candidate[] = [];
  const seenPaths = new Set<string>();
  const directoryEntriesCache = new Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>();
  const directoryPriorityCache = new Map<string, DirectoryPriority>();
  const rootFileCandidates = new Map<string, Candidate>();
  const rootDirectoryCandidates = new Map<string, { absolutePath: string; relativePath: string; priority: DirectoryPriority }>();
  const priorityDirectoryEntriesCache = new Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>();

  const addCandidate = (candidate: Candidate): void => {
    if (seenPaths.has(candidate.path) || candidates.length >= MAX_CANDIDATE_PATHS) return;
    seenPaths.add(candidate.path);
    candidates.push(candidate);
  };

  const probeRootFile = (relativePath: string): void => {
    if (rootFileCandidates.has(relativePath)) return;

    const absolutePath = join(cwd, relativePath);
    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      return;
    }

    if (!stats.isFile()) return;
    if (isSecretBearingFile(relativePath)) return;

    const { score, reason, matchedKeywords, category } = scoreCandidate(relativePath, mode, keywords);
    rootFileCandidates.set(relativePath, {
      path: relativePath,
      absolutePath,
      depth: fileDepth(relativePath),
      size: stats.size,
      score,
      reason,
      matchedKeywords,
      category,
    });
  };

  const probePriorityFilesFromDirectory = (absolutePath: string, matcher: (relativePath: string) => boolean): void => {
    const entries = readDirBounded(absolutePath, MAX_PRIORITY_SCAN_ENTRIES_PER_DIR, priorityDirectoryEntriesCache);

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const childAbsolutePath = join(absolutePath, entry.name);
      const childRelativePath = toPosixPath(relative(cwd, childAbsolutePath));
      if (!childRelativePath || childRelativePath.startsWith("..")) continue;
      if (isSecretBearingFile(childRelativePath)) continue;
      if (!matcher(childRelativePath)) continue;

      probeRootFile(childRelativePath);
    }
  };

  const probeRootDirectory = (relativePath: string): void => {
    if (rootDirectoryCandidates.has(relativePath)) return;

    const absolutePath = join(cwd, relativePath);
    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      return;
    }

    if (!stats.isDirectory()) return;
    if (isExcludedDir(basename(relativePath)) || isSecretBearingPath(relativePath)) return;

    const priority = directoryPriority(cwd, absolutePath, mode, keywords, directoryEntriesCache, directoryPriorityCache);
    rootDirectoryCandidates.set(relativePath, { absolutePath, relativePath, priority });
  };

  for (const relativePath of signals.topLevelFiles) {
    probeRootFile(relativePath);
  }
  for (const relativePath of TOP_LEVEL_PRIORITY.keys()) {
    probeRootFile(relativePath);
  }

  probePriorityFilesFromDirectory(cwd, isTopLevelPriorityFile);
  probePriorityFilesFromDirectory(join(cwd, "src"), isPriorityWildcardFile);

  for (const relativePath of signals.topLevelDirs) {
    probeRootDirectory(relativePath);
  }
  for (const relativePath of DIRECTORY_PRIORITY_NAMES.keys()) {
    probeRootDirectory(relativePath);
  }

  const rootFiles = [...rootFileCandidates.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path.localeCompare(right.path);
  });

  for (const entry of rootFiles) {
    addCandidate(entry);
  }

  const rootDirectories = [...rootDirectoryCandidates.values()].sort((left, right) => {
    if (right.priority.score !== left.priority.score) return right.priority.score - left.priority.score;
    return left.relativePath.localeCompare(right.relativePath);
  });

  const visit = (currentDir: string, depth: number): void => {
    if (candidates.length >= MAX_CANDIDATE_PATHS || depth > MAX_SCAN_DEPTH) return;

    const entries = readDirBounded(currentDir, MAX_DIR_ENTRIES_PER_DIR, directoryEntriesCache);
    const extraEntries =
      entries.length === MAX_DIR_ENTRIES_PER_DIR
        ? readDirBounded(currentDir, MAX_DIR_ENTRIES_PER_DIR, directoryEntriesCache, MAX_DIR_ENTRIES_PER_DIR)
        : [];
    const scannedEntries = extraEntries.length > 0 ? [...entries, ...extraEntries] : entries;
    const fileEntries = scannedEntries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const absolutePath = join(currentDir, entry.name);
        const relativePath = toPosixPath(relative(cwd, absolutePath));
        return {
          entry,
          absolutePath,
          relativePath,
          isEntrypoint: isPriorityEntrypointFile(relativePath),
        };
      })
      .sort((left, right) => {
        if (left.isEntrypoint !== right.isEntrypoint) return Number(right.isEntrypoint) - Number(left.isEntrypoint);
        return left.entry.name.localeCompare(right.entry.name);
      });

    const directoryEntries: DirectoryEntryCandidate[] = scannedEntries
      .filter((entry) => entry.isDirectory() && !isExcludedDir(entry.name))
      .map((entry) => {
        const absolutePath = join(currentDir, entry.name);
        const relativePath = toPosixPath(relative(cwd, absolutePath));
        if (!relativePath || relativePath.startsWith("..") || isSecretBearingPath(relativePath)) {
          return null;
        }

        return {
          entry,
          absolutePath,
          relativePath,
          priority: directoryPriority(cwd, absolutePath, mode, keywords, directoryEntriesCache, directoryPriorityCache),
        };
      })
      .filter((directoryEntry): directoryEntry is DirectoryEntryCandidate => directoryEntry !== null)
      .sort((left, right) => {
        if (right.priority.score !== left.priority.score) return right.priority.score - left.priority.score;
        return left.entry.name.localeCompare(right.entry.name);
      });

    const addFileCandidate = (fileEntry: (typeof fileEntries)[number], candidate: ReturnType<typeof scoreCandidate>): void => {
      if (candidates.length >= MAX_CANDIDATE_PATHS) return;
      if (!fileEntry.relativePath || fileEntry.relativePath.startsWith("..")) return;
      if (isSecretBearingFile(fileEntry.relativePath)) return;

      const size = (() => {
        try {
          return statSync(fileEntry.absolutePath).size;
        } catch {
          return 0;
        }
      })();

      addCandidate({
        path: fileEntry.relativePath,
        absolutePath: fileEntry.absolutePath,
        depth: fileDepth(fileEntry.relativePath),
        size,
        score: candidate.score,
        reason: candidate.reason,
        matchedKeywords: candidate.matchedKeywords,
        category: candidate.category,
      });
    };

    const materializedFileEntries = fileEntries.map((fileEntry) => ({
      fileEntry,
      candidate: scoreCandidate(fileEntry.relativePath, mode, keywords),
    }));

    if (extraEntries.length > 0) {
      const priorityFileEntries = materializedFileEntries
        .filter(({ candidate }) => candidate.category !== "fallback")
        .sort((left, right) => {
          if (right.candidate.score !== left.candidate.score) return right.candidate.score - left.candidate.score;
          return left.fileEntry.entry.name.localeCompare(right.fileEntry.entry.name);
        });

      for (const { fileEntry, candidate } of priorityFileEntries) {
        addFileCandidate(fileEntry, candidate);
      }

      for (const directoryEntry of directoryEntries) {
        if (candidates.length >= MAX_CANDIDATE_PATHS) return;
        if (!directoryEntry.relativePath || directoryEntry.relativePath.startsWith("..")) continue;
        visit(directoryEntry.absolutePath, depth + 1);
      }

      const fallbackFileEntries = materializedFileEntries
        .filter(({ candidate }) => candidate.category === "fallback")
        .sort((left, right) => {
          if (right.candidate.score !== left.candidate.score) return right.candidate.score - left.candidate.score;
          return left.fileEntry.entry.name.localeCompare(right.fileEntry.entry.name);
        });

      for (const { fileEntry, candidate } of fallbackFileEntries) {
        addFileCandidate(fileEntry, candidate);
      }
    } else {
      for (const { fileEntry, candidate } of materializedFileEntries) {
        addFileCandidate(fileEntry, candidate);
      }

      for (const directoryEntry of directoryEntries) {
        if (candidates.length >= MAX_CANDIDATE_PATHS) return;
        if (!directoryEntry.relativePath || directoryEntry.relativePath.startsWith("..")) continue;
        visit(directoryEntry.absolutePath, depth + 1);
      }
    }
  };

  for (const rootDirectory of rootDirectories) {
    if (candidates.length >= MAX_CANDIDATE_PATHS) break;
    visit(rootDirectory.absolutePath, 1);
  }

  return candidates;
}

function taskKeywords(task: string): string[] {
  const keywords = slugifyTask(task)
    .split("-")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !STOPWORDS.has(part));
  return [...new Set(keywords)];
}

function tokenizePath(relativePath: string): string[] {
  return relativePath
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreCandidate(relativePath: string, mode: DraftMode, keywords: string[]): Pick<Candidate, "score" | "reason" | "matchedKeywords" | "category"> {
  const pathTokens = tokenizePath(relativePath);
  const basenameTokens = tokenizePath(basename(relativePath));
  const matchedKeywords = keywords.filter((keyword) => pathTokens.includes(keyword) || basenameTokens.includes(keyword));
  const fixMode = isFixMode(mode);
  const isTopLevel = relativePath.indexOf("/") === -1;
  const topLevelPriority = isTopLevel ? TOP_LEVEL_PRIORITY.get(relativePath) : undefined;

  if (topLevelPriority) {
    let score = topLevelPriority.score;
    if (matchedKeywords.length > 0) score += matchedKeywords.length * 75;
    if (fixMode && matchedKeywords.length > 0) score += 100;
    return {
      score,
      reason: matchedKeywords.length > 0 ? `${topLevelPriority.reason}; matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}` : topLevelPriority.reason,
      matchedKeywords,
      category: "top-level",
    };
  }

  const configPriority = isTopLevel ? CONFIG_PRIORITY.find((entry) => entry.pattern.test(relativePath)) : undefined;
  if (configPriority) {
    let score = configPriority.score;
    if (matchedKeywords.length > 0) score += matchedKeywords.length * 80;
    if (fixMode && matchedKeywords.length > 0) score += 100;
    return {
      score,
      reason: matchedKeywords.length > 0 ? `${configPriority.reason}; matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}` : configPriority.reason,
      matchedKeywords,
      category: "config",
    };
  }

  const entrypointPriority = ENTRYPOINT_PRIORITY.find((entry) => entry.pattern.test(relativePath));
  if (entrypointPriority) {
    let score = entrypointPriority.score;
    if (matchedKeywords.length > 0) score += matchedKeywords.length * 120;
    if (fixMode && matchedKeywords.length > 0) score += 125;
    return {
      score,
      reason: matchedKeywords.length > 0 ? `${entrypointPriority.reason}; matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}` : entrypointPriority.reason,
      matchedKeywords,
      category: "entrypoint",
    };
  }

  const isTestFile = /(^|\/)tests?(\/|\.|-)|\.(test|spec)\.[^.\/]+$|__tests__/.test(relativePath.toLowerCase());
  if (isTestFile) {
    let score = fixMode ? 7_200 : 4_000;
    if (matchedKeywords.length > 0) score += matchedKeywords.length * (fixMode ? 250 : 100);
    return {
      score,
      reason: matchedKeywords.length > 0 ? `test file; matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}` : "test file",
      matchedKeywords,
      category: "test",
    };
  }

  let score = fixMode ? 3_000 : 2_000;
  if (matchedKeywords.length > 0) score += matchedKeywords.length * (fixMode ? 200 : 90);
  if (relativePath.startsWith("src/")) score += fixMode ? 150 : 100;
  return {
    score,
    reason: matchedKeywords.length > 0 ? `related file; matches task keyword${matchedKeywords.length > 1 ? "s" : ""} ${matchedKeywords.join(", ")}` : "related file",
    matchedKeywords,
    category: matchedKeywords.length > 0 ? "keyword" : "fallback",
  };
}

function loadFileContent(absolutePath: string, byteLimit: number): { content: string; bytes: number } {
  const fileDescriptor = openSync(absolutePath, "r");

  try {
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fileDescriptor, buffer, 0, byteLimit, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead };
  } finally {
    closeSync(fileDescriptor);
  }
}

function isFixMode(mode: DraftMode): boolean {
  return mode === "fix";
}

function scoreCandidates(cwd: string, task: string, mode: DraftMode, signals: RepoSignals): Candidate[] {
  const keywords = taskKeywords(task);
  const candidates = collectCandidates(cwd, mode, keywords, signals);

  return candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.size !== right.size) return left.size - right.size;
    return left.path.localeCompare(right.path);
  });
}

function selectFiles(candidates: Candidate[]): RepoContextSelectedFile[] {
  const selected: RepoContextSelectedFile[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (selected.length >= MAX_SELECTED_FILES || totalBytes >= MAX_TOTAL_BYTES) break;

    const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
    if (remainingBytes <= 0) break;

    const byteLimit = Math.min(MAX_FILE_BYTES, remainingBytes);
    if (byteLimit <= 0) break;

    let content = "";
    let bytes = 0;
    try {
      ({ content, bytes } = loadFileContent(candidate.absolutePath, byteLimit));
    } catch {
      continue;
    }

    if (bytes <= 0) continue;

    totalBytes += bytes;
    selected.push({
      path: candidate.path,
      content,
      reason: candidate.reason,
    });
  }

  return selected;
}

function summarizeSignals(signals: RepoSignals): string[] {
  const scripts = [signals.testCommand ? `test=${signals.testCommand}` : undefined, signals.lintCommand ? `lint=${signals.lintCommand}` : undefined].filter((value): value is string => Boolean(value));

  return [
    `package manager: ${signals.packageManager ?? "unknown"}`,
    `scripts: ${scripts.length > 0 ? scripts.join(", ") : "none"}`,
    `git repository: ${signals.hasGit ? "present" : "absent"}`,
    `top-level dirs: ${signals.topLevelDirs.length > 0 ? signals.topLevelDirs.join(", ") : "none"}`,
    `top-level files: ${signals.topLevelFiles.length > 0 ? signals.topLevelFiles.join(", ") : "none"}`,
  ];
}

function summarizeSelectedFiles(selectedFiles: RepoContextSelectedFile[]): string {
  if (selectedFiles.length === 0) return "selected files: none";
  return `selected files: ${selectedFiles.map((file) => `${file.path} (${file.reason})`).join("; ")}`;
}

export function assembleRepoContext(cwd: string, task: string, mode: DraftMode, signals: RepoSignals): RepoContext {
  const candidates = scoreCandidates(cwd, task, mode, signals);
  const selectedFiles = selectFiles(candidates);

  return {
    summaryLines: [...summarizeSignals(signals), summarizeSelectedFiles(selectedFiles)],
    selectedFiles,
  };
}
