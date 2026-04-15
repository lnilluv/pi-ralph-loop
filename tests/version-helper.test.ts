import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/version-helper.ts", import.meta.url));

function runVersionHelper(
  branch: "main" | "dev",
  bump: "major" | "minor" | "patch",
  npmVersions: string[] | string,
  gitTags: string[] | string,
): string {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", scriptPath, branch, bump, encodeInput(npmVersions), encodeInput(gitTags)],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function encodeInput(input: string[] | string): string {
  return Array.isArray(input) ? JSON.stringify(input) : input;
}

test("highest stable npm beats stale package line assumptions", () => {
  assert.equal(
    runVersionHelper(
      "main",
      "patch",
      ["0.1.4-dev.1", "1.2.3", "1.2.3-dev.0"],
      ["v1.1.9"],
    ),
    "1.2.4",
  );
});

test("highest stable git tag beats stale package line assumptions", () => {
  assert.equal(
    runVersionHelper(
      "main",
      "patch",
      ["0.1.4-dev.1", "1.1.9"],
      ["v1.2.5", "v1.2.4-dev.0"],
    ),
    "1.2.6",
  );
});

test("before any stable >= 1.0.0 exists, the next stable floors to 1.0.0", () => {
  assert.equal(runVersionHelper("main", "patch", ["0.9.9"], ["v0.9.8"]), "1.0.0");
});

test("main returns exact 1.0.0 in the current-style stale prerelease scenario", () => {
  assert.equal(
    runVersionHelper("main", "patch", ["0.1.4-dev.1", "1.0.0-dev.0"], ["v0.1.4-dev.1"]),
    "1.0.0",
  );
});

test("dev returns exact 1.0.0-dev.1 when prior prereleases exist on that line", () => {
  assert.equal(
    runVersionHelper("dev", "patch", "0.1.4-dev.1\n1.0.0-dev.0", ["v0.1.4-dev.1"]),
    "1.0.0-dev.1",
  );
});

test("once 1.0.0 exists, bumping resumes normally from the highest stable version", () => {
  assert.equal(
    runVersionHelper("main", "patch", ["1.0.0", "1.2.3"], ["v1.1.9"]),
    "1.2.4",
  );
});
