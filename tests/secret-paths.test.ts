import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECRET_PATH_POLICY_TOKEN, isSecretBearingPath, matchesProtectedPath } from "../src/secret-paths.ts";

const symlinkTest = process.platform === "win32" ? test.skip : test;

test("secret-bearing path detection uses exact rules and ignores similarly named public files", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".aws/config",
    ".azure/config",
    ".gcloud/config",
    ".ssh/id_rsa",
    "config/secrets/prod.json",
    "config/credentials/service.json",
    "ops-secrets/config.json",
    "credentials-prod/token.txt",
    "keys/server.pem",
    "keys/private.key",
    "keys/release.asc",
  ]) {
    assert.equal(isSecretBearingPath(path), true, path);
  }

  for (const path of ["src/secretary.ts", "src/credential-form.tsx"]) {
    assert.equal(isSecretBearingPath(path), false, path);
  }
});

test("secret-bearing path detection includes .env* directories", () => {
  for (const path of [
    ".env/config.json",
    ".env.local/config.json",
    "config/.env/settings.json",
    "config/.env.local/settings.json",
  ]) {
    assert.equal(isSecretBearingPath(path), true, path);
  }

  const protectedFiles = [SECRET_PATH_POLICY_TOKEN];

  for (const filePath of [
    ".env/config.json",
    ".env.local/config.json",
    "config/.env/settings.json",
    "config/.env.local/settings.json",
  ]) {
    assert.equal(matchesProtectedPath(filePath, protectedFiles), true, filePath);
  }
});

test("policy token protects secret-bearing paths and ignores a non-secret control", () => {
  const protectedFiles = [SECRET_PATH_POLICY_TOKEN];

  for (const filePath of [
    "credentials/api.json",
    "credentials/payments/service-account.json",
    ".azure/config",
    ".gcloud/config",
    ".ssh/config",
    ".npmrc",
    "releases/signing-key.asc",
    ".env",
    ".env.local",
  ]) {
    assert.equal(matchesProtectedPath(filePath, protectedFiles), true, filePath);
  }

  assert.equal(matchesProtectedPath("src/app.ts", protectedFiles), false);
});

test("matchesProtectedPath checks repo-relative globs against absolute and relative inputs when cwd is known", () => {
  const cwd = "/repo/project";
  const protectedFiles = ["src/generated/**"];

  assert.equal(matchesProtectedPath("src/generated/output.ts", protectedFiles, cwd), true);
  assert.equal(matchesProtectedPath("/repo/project/src/generated/output.ts", protectedFiles, cwd), true);
  assert.equal(matchesProtectedPath("/repo/project/src/app.ts", protectedFiles, cwd), false);
});

symlinkTest("matchesProtectedPath resolves symlinked parent segments before checking secret policy", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-secret-paths-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const secretsDir = join(cwd, "secrets");
  const secretsSubdir = join(secretsDir, "subdir");
  mkdirSync(secretsSubdir, { recursive: true });
  writeFileSync(join(secretsDir, "token.txt"), "content", "utf8");
  symlinkSync(secretsSubdir, join(cwd, "link"));

  assert.equal(matchesProtectedPath("link/../token.txt", [SECRET_PATH_POLICY_TOKEN], cwd), true);
  assert.equal(matchesProtectedPath("link/../token.txt", ["secrets/**"], cwd), true);
});
