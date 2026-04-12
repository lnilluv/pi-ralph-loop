import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleRepoContext } from "../src/ralph-draft-context.ts";

function createTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-context-"));
}

function writeTextFile(root: string, relativePath: string, content: string): void {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function makeSignals(overrides: Partial<{ packageManager: "npm" | "pnpm" | "yarn" | "bun"; testCommand: string; lintCommand: string; hasGit: boolean; topLevelDirs: string[]; topLevelFiles: string[]; }> = {}) {
  return {
    packageManager: overrides.packageManager,
    testCommand: overrides.testCommand,
    lintCommand: overrides.lintCommand,
    hasGit: overrides.hasGit ?? false,
    topLevelDirs: overrides.topLevelDirs ?? [],
    topLevelFiles: overrides.topLevelFiles ?? [],
  };
}

test("analysis mode prioritizes repo overview, manifests, and likely entrypoints", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "README.md", "# Demo app\n");
  writeTextFile(cwd, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest", lint: "eslint ." } }, null, 2));
  writeTextFile(cwd, "tsconfig.json", "{\n  \"compilerOptions\": {}\n}\n");
  writeTextFile(cwd, "src/index.ts", "export function main() { return 'ok'; }\n");
  writeTextFile(cwd, "src/router.ts", "export const router = [];\n");
  writeTextFile(cwd, "tests/auth.test.ts", "import assert from 'node:assert/strict';\n");
  writeTextFile(cwd, "node_modules/ignored.js", "ignored\n");
  writeTextFile(cwd, "dist/bundle.js", "ignored\n");

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      packageManager: "npm",
      testCommand: "npm test",
      lintCommand: "npm run lint",
      hasGit: true,
      topLevelDirs: ["src", "tests", "node_modules", "dist"],
      topLevelFiles: ["README.md", "package.json", "tsconfig.json"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("README.md"));
  assert.ok(selectedPaths.includes("package.json"));
  assert.ok(selectedPaths.includes("src/index.ts"));
  assert.ok(selectedPaths.indexOf("README.md") < selectedPaths.indexOf("package.json"));
  assert.ok(selectedPaths.indexOf("package.json") < selectedPaths.indexOf("src/index.ts"));
  assert.match(context.selectedFiles.find((file) => file.path === "README.md")?.reason ?? "", /repo overview/i);
  assert.match(context.selectedFiles.find((file) => file.path === "package.json")?.reason ?? "", /package manifest/i);
  assert.match(context.selectedFiles.find((file) => file.path === "src/index.ts")?.reason ?? "", /entrypoint/i);
  assert.ok(context.summaryLines.some((line) => line.includes("package manager: npm")));
  assert.ok(context.summaryLines.some((line) => line.includes("scripts: test=npm test, lint=npm run lint")));
  assert.ok(context.summaryLines.some((line) => line.includes("git repository: present")));
  assert.ok(context.summaryLines.some((line) => line.includes("top-level dirs:")));
  assert.ok(context.summaryLines.some((line) => line.includes("top-level files:")));
  assert.ok(context.summaryLines.some((line) => line.includes("selected files:")));
});

test("analysis mode probes wildcard src entrypoints even after the first 200 src entries", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalOpendirSync = fs.opendirSync;
  t.after(() => {
    fs.opendirSync = originalOpendirSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  writeTextFile(cwd, "README.md", "# Demo app\n");
  writeTextFile(cwd, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest", lint: "eslint ." } }, null, 2));
  writeTextFile(cwd, "tsconfig.json", "{\n  \"compilerOptions\": {}\n}\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `src/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }
  writeTextFile(cwd, "src/main.py", "def main():\n    return 'ok'\n");

  const srcEntries = [
    ...Array.from({ length: 200 }, (_, index) => ({
      name: `file-${String(index).padStart(3, "0")}.ts`,
      isFile: () => true,
      isDirectory: () => false,
    })),
    { name: "main.py", isFile: () => true, isDirectory: () => false },
  ];

  let opendirCalls = 0;
  fs.opendirSync = (...args: any[]) => {
    const [dirPath] = args as [string];
    if (dirPath === join(cwd, "src")) {
      opendirCalls += 1;
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < srcEntries.length ? srcEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    return Reflect.apply(originalOpendirSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["src"],
      topLevelFiles: ["README.md", "package.json", "tsconfig.json"],
    }),
  );
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("README.md"));
  assert.ok(selectedPaths.includes("package.json"));
  assert.ok(selectedPaths.includes("tsconfig.json"));
  assert.ok(selectedPaths.includes("src/main.py"));
  assert.ok(opendirCalls <= 3);
  assert.match(context.selectedFiles.find((file) => file.path === "src/main.py")?.reason ?? "", /entrypoint/i);
});

test("fix mode discovers src/auth/login.ts after 200 unrelated sibling files", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalOpendirSync = fs.opendirSync;
  t.after(() => {
    fs.opendirSync = originalOpendirSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  for (let index = 0; index < 200; index++) {
    writeTextFile(cwd, `src/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }
  writeTextFile(cwd, "src/auth/login.ts", "export const login = true;\n");

  const srcEntries = [
    ...Array.from({ length: 200 }, (_, index) => ({
      name: `file-${String(index).padStart(3, "0")}.ts`,
      isFile: () => true,
      isDirectory: () => false,
    })),
    { name: "auth", isFile: () => false, isDirectory: () => true },
  ];
  const authEntries = [{ name: "login.ts", isFile: () => true, isDirectory: () => false }];

  let opendirCalls = 0;
  fs.opendirSync = (...args: any[]) => {
    const [dirPath] = args as [string];
    if (dirPath === join(cwd, "src")) {
      opendirCalls += 1;
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < srcEntries.length ? srcEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    if (dirPath === join(cwd, "src", "auth")) {
      opendirCalls += 1;
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < authEntries.length ? authEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    return Reflect.apply(originalOpendirSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(cwd, "Fix auth bug", "fix", makeSignals({ topLevelDirs: ["src"] }));
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/auth/login.ts"));
  assert.equal(selectedPaths[0], "src/auth/login.ts");
  assert.match(context.selectedFiles.find((file) => file.path === "src/auth/login.ts")?.reason ?? "", /auth|task keyword/i);
  assert.ok(opendirCalls <= 4);
});

test("fix mode keeps src/auth.ts ahead of a second-page auth subtree", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalOpendirSync = fs.opendirSync;
  t.after(() => {
    fs.opendirSync = originalOpendirSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  writeTextFile(cwd, "src/auth.ts", "export const auth = true;\n");
  for (let index = 0; index < 199; index++) {
    writeTextFile(cwd, `src/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }
  for (let index = 0; index < 200; index++) {
    writeTextFile(cwd, `src/auth/nested-${String(index).padStart(3, "0")}.ts`, `export const nested${index} = ${index};\n`);
  }

  const srcEntries = [
    { name: "auth.ts", isFile: () => true, isDirectory: () => false },
    ...Array.from({ length: 199 }, (_, index) => ({
      name: `file-${String(index).padStart(3, "0")}.ts`,
      isFile: () => true,
      isDirectory: () => false,
    })),
    { name: "auth", isFile: () => false, isDirectory: () => true },
  ];
  const authEntries = Array.from({ length: 200 }, (_, index) => ({
    name: `nested-${String(index).padStart(3, "0")}.ts`,
    isFile: () => true,
    isDirectory: () => false,
  }));

  fs.opendirSync = (...args: any[]) => {
    const [dirPath] = args as [string];
    if (dirPath === join(cwd, "src")) {
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < srcEntries.length ? srcEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    if (dirPath === join(cwd, "src", "auth")) {
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < authEntries.length ? authEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    return Reflect.apply(originalOpendirSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(cwd, "Fix auth bug", "fix", makeSignals({ topLevelDirs: ["src"] }));
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/auth.ts"));
  assert.equal(selectedPaths[0], "src/auth.ts");
  assert.match(context.selectedFiles.find((file) => file.path === "src/auth.ts")?.reason ?? "", /auth|task keyword/i);
});

test("analysis mode probes wildcard root configs and entrypoints beyond the first 200 root entries", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalOpendirSync = fs.opendirSync;
  t.after(() => {
    fs.opendirSync = originalOpendirSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `root-${String(index).padStart(3, "0")}.txt`, `unrelated ${index}\n`);
  }
  writeTextFile(cwd, "app.py", "def main():\n    return 'ok'\n");
  writeTextFile(cwd, "custom-tool.config.py", "value = True\n");

  const rootEntries = [
    ...Array.from({ length: 200 }, (_, index) => ({
      name: `root-${String(index).padStart(3, "0")}.txt`,
      isFile: () => true,
      isDirectory: () => false,
    })),
    { name: "app.py", isFile: () => true, isDirectory: () => false },
    { name: "custom-tool.config.py", isFile: () => true, isDirectory: () => false },
  ];

  let opendirCalls = 0;
  fs.opendirSync = (...args: any[]) => {
    const [dirPath] = args as [string];
    if (dirPath === cwd) {
      opendirCalls += 1;
      let entryIndex = 0;
      return {
        readSync: () => (entryIndex < rootEntries.length ? rootEntries[entryIndex++] : null),
        closeSync: () => {},
      };
    }
    return Reflect.apply(originalOpendirSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(cwd, "Reverse engineer this app", "analysis", makeSignals());
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.equal(opendirCalls, 1);
  assert.equal(selectedPaths.length, 2);
  assert.equal(selectedPaths[0], "custom-tool.config.py");
  assert.equal(selectedPaths[1], "app.py");
  assert.match(context.selectedFiles.find((file) => file.path === "custom-tool.config.py")?.reason ?? "", /config/i);
  assert.match(context.selectedFiles.find((file) => file.path === "app.py")?.reason ?? "", /entrypoint/i);
});

test("analysis mode keeps top-level configs and explicit entrypoints ahead of the candidate cap", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "tsconfig.json", "{\n  \"compilerOptions\": {}\n}\n");
  writeTextFile(cwd, "src/index.ts", "export function main() { return 'ok'; }\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `src/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["src"],
      topLevelFiles: ["tsconfig.json"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("tsconfig.json"));
  assert.ok(selectedPaths.includes("src/index.ts"));
  assert.equal(selectedPaths[0], "tsconfig.json");
  assert.equal(selectedPaths[1], "src/index.ts");
  assert.match(context.selectedFiles.find((file) => file.path === "src/index.ts")?.reason ?? "", /entrypoint/i);
});

test("analysis mode still selects src/index.ts when an earlier sibling directory exceeds the candidate cap", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "src/index.ts", "export function main() { return 'ok'; }\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `aaa/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["aaa", "src"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/index.ts"));
  assert.match(context.selectedFiles.find((file) => file.path === "src/index.ts")?.reason ?? "", /entrypoint/i);
});


test("analysis mode keeps src/index.ts ahead of 205 unrelated root files", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "src/index.ts", "export function main() { return 'ok'; }\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `root-${String(index).padStart(3, "0")}.txt`, `unrelated ${index}\n`);
  }

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["src"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/index.ts"));
  assert.equal(selectedPaths[0], "src/index.ts");
  assert.match(context.selectedFiles.find((file) => file.path === "src/index.ts")?.reason ?? "", /entrypoint/i);
});


test("fix mode ranks task-matching source and test files above unrelated files", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "src/auth.ts", "export const auth = true;\n");
  writeTextFile(cwd, "tests/auth.test.ts", "import assert from 'node:assert/strict';\n");
  writeTextFile(cwd, "src/payments.ts", "export const payments = true;\n");

  const context = assembleRepoContext(cwd, "Fix flaky auth tests", "fix", makeSignals({ topLevelDirs: ["src", "tests"] }));
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.indexOf("src/auth.ts") >= 0);
  assert.ok(selectedPaths.indexOf("tests/auth.test.ts") >= 0);
  assert.ok(selectedPaths.indexOf("src/payments.ts") >= 0);
  assert.ok(selectedPaths.indexOf("src/auth.ts") < selectedPaths.indexOf("src/payments.ts"));
  assert.ok(selectedPaths.indexOf("tests/auth.test.ts") < selectedPaths.indexOf("src/payments.ts"));
  assert.match(context.selectedFiles.find((file) => file.path === "src/auth.ts")?.reason ?? "", /auth|task keyword/i);
  assert.match(context.selectedFiles.find((file) => file.path === "tests/auth.test.ts")?.reason ?? "", /test|auth|task keyword/i);
});

test("fix mode keeps src/auth.ts and tests/auth.test.ts ahead of 205 unrelated root files", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "src/auth.ts", "export const auth = true;\n");
  writeTextFile(cwd, "tests/auth.test.ts", "import assert from 'node:assert/strict';\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `root-${String(index).padStart(3, "0")}.txt`, `unrelated ${index}\n`);
  }

  const context = assembleRepoContext(
    cwd,
    "Fix flaky auth tests",
    "fix",
    makeSignals({
      topLevelDirs: ["src", "tests"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/auth.ts"));
  assert.ok(selectedPaths.includes("tests/auth.test.ts"));
  assert.match(context.selectedFiles.find((file) => file.path === "src/auth.ts")?.reason ?? "", /auth|task keyword/i);
  assert.match(context.selectedFiles.find((file) => file.path === "tests/auth.test.ts")?.reason ?? "", /test|auth|task keyword/i);
});

test("oversized selected files are truncated and total context stays within budget", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const huge = "x".repeat(9_500);
  writeTextFile(cwd, "README.md", huge);
  writeTextFile(cwd, "package.json", huge);
  writeTextFile(cwd, "src/index.ts", huge);
  writeTextFile(cwd, "src/auth.ts", huge);
  writeTextFile(cwd, "tests/auth.test.ts", huge);
  writeTextFile(cwd, "src/router.ts", huge);

  const context = assembleRepoContext(
    cwd,
    "Fix flaky auth tests",
    "fix",
    makeSignals({ packageManager: "npm", testCommand: "npm test", lintCommand: "npm run lint", hasGit: true, topLevelDirs: ["src", "tests"], topLevelFiles: ["README.md", "package.json"] }),
  );

  const totalBytes = context.selectedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  assert.ok(context.selectedFiles.length <= 6);
  assert.ok(context.selectedFiles.some((file) => Buffer.byteLength(file.content, "utf8") === 8_000));
  assert.ok(context.selectedFiles.every((file) => Buffer.byteLength(file.content, "utf8") <= 8_000));
  assert.ok(totalBytes <= 40_000);
});

test("analysis mode keeps deep sibling trees from being recursively scored before selection", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalOpendirSync = fs.opendirSync;
  t.after(() => {
    fs.opendirSync = originalOpendirSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  writeTextFile(cwd, "src/index.ts", "export function main() { return 'ok'; }\n");
  for (let index = 0; index < 205; index++) {
    writeTextFile(cwd, `src/file-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
  }

  for (const first of ["one", "two", "three"]) {
    for (const second of ["one", "two", "three"]) {
      for (const third of ["one", "two", "three"]) {
        mkdirSync(join(cwd, "aaa", first, second, third), { recursive: true });
      }
    }
  }
  writeTextFile(cwd, "aaa/one/two/three/deep.ts", "export const deep = true;\n");

  let opendirCalls = 0;
  fs.opendirSync = (...args: any[]) => {
    opendirCalls += 1;
    return Reflect.apply(originalOpendirSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(cwd, "Reverse engineer this app", "analysis", makeSignals({ topLevelDirs: ["aaa", "src"] }));
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("src/index.ts"));
  assert.equal(selectedPaths[0], "src/index.ts");
  assert.ok(opendirCalls <= 6, `expected bounded directory scan, saw ${opendirCalls} opendir calls`);
});

test("file loading reads only the configured byte limit", (t) => {
  const cwd = createTempRepo();
  const fs = createRequire(import.meta.url)("node:fs") as any;
  const originalReadSync = fs.readSync;
  t.after(() => {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  });

  writeTextFile(cwd, "README.md", "x".repeat(9_500));

  let readCalls = 0;
  let maxRequestedLength = 0;
  fs.readSync = (...args: any[]) => {
    readCalls += 1;
    if (typeof args[3] === "number") {
      maxRequestedLength = Math.max(maxRequestedLength, args[3]);
    }
    return Reflect.apply(originalReadSync, fs, args);
  };
  syncBuiltinESMExports();

  const context = assembleRepoContext(cwd, "Reverse engineer this app", "analysis", makeSignals({ topLevelFiles: ["README.md"] }));

  assert.equal(context.selectedFiles.length, 1);
  assert.equal(readCalls, 1);
  assert.equal(maxRequestedLength, 8_000);
  assert.equal(Buffer.byteLength(context.selectedFiles[0]?.content ?? "", "utf8"), 8_000);
});

test("secret-like files are excluded from selected files", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "README.md", "# Demo\n");
  writeTextFile(cwd, "src/index.ts", "export {};\n");
  writeTextFile(cwd, ".env", "TOKEN=one\n");
  writeTextFile(cwd, ".env.local", "TOKEN=two\n");
  writeTextFile(cwd, ".npmrc", "registry=https://example.invalid\n");
  writeTextFile(cwd, ".pypirc", "[distutils]\nindex-servers = test\n");
  writeTextFile(cwd, ".netrc", "machine example.invalid login user password secret\n");
  writeTextFile(cwd, "keys/server.pem", "pem\n");
  writeTextFile(cwd, "keys/private.key", "key\n");
  writeTextFile(cwd, "keys/release.asc", "asc\n");
  writeTextFile(cwd, "ops-secrets/config.json", "{}\n");
  writeTextFile(cwd, "credentials-prod/token.txt", "token\n");
  writeTextFile(cwd, "config/secrets/prod.json", "{}\n");
  writeTextFile(cwd, "config/credentials/service.json", "{}\n");
  writeTextFile(cwd, "config/secret-config.json", "{}\n");
  writeTextFile(cwd, "config/credential-store.json", "{}\n");
  writeTextFile(cwd, ".aws/config", "[default]\nregion = us-west-2\n");
  writeTextFile(cwd, ".ssh/id_rsa", "private-key\n");

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["src", "keys", "ops-secrets", "credentials-prod", "config", ".aws", ".ssh"],
      topLevelFiles: ["README.md", "ops-secrets/config.json", "credentials-prod/token.txt", ".env", ".env.local", ".npmrc", ".pypirc", ".netrc"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);
  const secretLikePaths = [
    ".env",
    ".env.local",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "keys/server.pem",
    "keys/private.key",
    "keys/release.asc",
    "ops-secrets/config.json",
    "credentials-prod/token.txt",
    "config/secrets/prod.json",
    "config/credentials/service.json",
    "config/secret-config.json",
    "config/credential-store.json",
    ".aws/config",
    ".ssh/id_rsa",
  ];

  assert.ok(selectedPaths.includes("README.md"));
  assert.ok(selectedPaths.includes("src/index.ts"));
  for (const path of secretLikePaths) {
    assert.ok(!selectedPaths.includes(path), `unexpected secret-like file selected: ${path}`);
  }
  assert.ok(selectedPaths.every((path) => !/(?:\.env(?:\..*)?$|\.npmrc$|\.pypirc$|\.netrc$|\.pem$|\.key$|secret|credential|\.aws\/|\.ssh\/)/i.test(path)));
  for (const token of [".env", ".npmrc", ".ssh", "secrets", "credentials", "ops-secrets", "credentials-prod", "release.asc"]) {
    assert.ok(context.summaryLines.every((line) => !line.includes(token)), `unexpected secret-like token in summary lines: ${token}`);
  }
});

test("basename .env* files are excluded from selected files and summaries", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "README.md", "# Demo\n");
  writeTextFile(cwd, "src/index.ts", "export {};\n");
  writeTextFile(cwd, ".envrc", "export TOKEN=one\n");
  writeTextFile(cwd, ".env.production", "TOKEN=two\n");
  writeTextFile(cwd, ".envrc.local", "export TOKEN=three\n");

  const context = assembleRepoContext(
    cwd,
    "Reverse engineer this app",
    "analysis",
    makeSignals({
      topLevelDirs: ["src"],
      topLevelFiles: ["README.md", ".envrc", ".env.production", ".envrc.local"],
    }),
  );

  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.includes("README.md"));
  assert.ok(selectedPaths.includes("src/index.ts"));
  for (const path of [".envrc", ".env.production", ".envrc.local"]) {
    assert.ok(!selectedPaths.includes(path), `unexpected secret-like file selected: ${path}`);
  }
  for (const token of [".envrc", ".env.production", ".envrc.local"]) {
    assert.ok(context.summaryLines.every((line) => !line.includes(token)), `unexpected secret-like token in summary lines: ${token}`);
  }
});

test("excluded directories never contribute selected files", (t) => {
  const cwd = createTempRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeTextFile(cwd, "README.md", "# Demo\n");
  writeTextFile(cwd, "src/index.ts", "export {};\n");
  writeTextFile(cwd, ".git/config", "ignored\n");
  writeTextFile(cwd, "node_modules/ignored.js", "ignored\n");
  writeTextFile(cwd, "dist/bundle.js", "ignored\n");
  writeTextFile(cwd, "build/output.js", "ignored\n");
  writeTextFile(cwd, "coverage/report.txt", "ignored\n");
  writeTextFile(cwd, ".next/server.js", "ignored\n");

  const context = assembleRepoContext(cwd, "Reverse engineer this app", "analysis", makeSignals({ topLevelDirs: ["src", "node_modules", "dist", "build", "coverage", ".next"], topLevelFiles: ["README.md"] }));
  const selectedPaths = context.selectedFiles.map((file) => file.path);

  assert.ok(selectedPaths.every((path) => !path.startsWith(".git/")));
  assert.ok(selectedPaths.every((path) => !path.startsWith("node_modules/")));
  assert.ok(selectedPaths.every((path) => !path.startsWith("dist/")));
  assert.ok(selectedPaths.every((path) => !path.startsWith("build/")));
  assert.ok(selectedPaths.every((path) => !path.startsWith("coverage/")));
  assert.ok(selectedPaths.every((path) => !path.startsWith(".next/")));
});
