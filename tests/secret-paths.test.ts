import assert from "node:assert/strict";
import test from "node:test";
import { SECRET_PATH_POLICY_TOKEN, matchesProtectedPath } from "../src/secret-paths.ts";

test("policy token protects secret-bearing paths and ignores a non-secret control", () => {
  const protectedFiles = [SECRET_PATH_POLICY_TOKEN];

  for (const filePath of [
    "credentials/api.json",
    "credentials/payments/service-account.json",
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
