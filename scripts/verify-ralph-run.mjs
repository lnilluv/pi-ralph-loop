import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Run one real /ralph iteration in a credential-free Pi host against a local fake model.
// PATH has no `pi`, like native Windows where npm installs only pi.cmd/pi.ps1 shims.
const root = fileURLToPath(new URL("../", import.meta.url));
const piPackage = join(root, "node_modules/@earendil-works/pi-coding-agent");
const piCli = join(piPackage, JSON.parse(await readFile(join(piPackage, "package.json"), "utf8")).bin.pi);

// providerSource: "models-json" (built-in config), "discovered-extension" (an installed provider
// extension, found by discovery), "cli-extension" (passed with -e to a --no-extensions session), or
// "project-extension" (in the project's .pi/extensions, trusted for this session only via --approve).
async function runRalph(failures, { providerSource = "models-json" } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const failure = failures[requests++];
      if (failure) {
        res.writeHead(failure.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: failure.message } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]) res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", ...chunk })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const home = await mkdtemp(join(tmpdir(), "ralph-run-"));
  const work = join(home, "work");
  const agentDir = join(home, "agent");
  await Promise.all([mkdir(join(work, "task"), { recursive: true }), mkdir(agentDir)]);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const providerExtension = {
    "discovered-extension": join(agentDir, "extensions", "fake-provider.ts"),
    "project-extension": join(work, ".pi", "extensions", "fake-provider.ts"),
  }[providerSource] ?? join(home, "fake-provider.ts");
  if (providerSource === "models-json") {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { fake: { baseUrl, api: "openai-completions", apiKey: "dummy", models: [{ id: "model" }] } },
    }));
  } else {
    await mkdir(join(providerExtension, ".."), { recursive: true });
    const model = { id: "model", name: "model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
    await writeFile(providerExtension, `export default function (pi) {
  pi.registerProvider("fake", ${JSON.stringify({ baseUrl, api: "openai-completions", apiKey: "dummy", models: [model] })});
}
`);
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "model", retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } }));
  await writeFile(join(work, "task", "RALPH.md"), "---\nmax_iterations: 1\ntimeout: 60\ncommands: []\n---\nSay hello.\n");

  const systemPath = process.platform === "win32" ? [process.env.SystemRoot && join(process.env.SystemRoot, "System32")] : ["/usr/bin", "/bin"];
  const extensionArgs = {
    "models-json": ["--no-extensions"],
    "discovered-extension": [],
    "cli-extension": ["--no-extensions", "-e", providerExtension],
    "project-extension": ["--approve"],
  }[providerSource];
  const child = spawn(process.execPath, [
    piCli, "--mode", "rpc", "--offline", "--no-session", ...extensionArgs,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "-e", join(root, "src/index.ts"),
  ], {
    cwd: work,
    env: { PATH: systemPath.filter(Boolean).join(delimiter), HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const notices = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Ralph run timed out: ${notices.join("\n")}\n${stderr}`)), 60_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Host exited ${code}: ${stderr}`)));
      let buffer = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== "extension_ui_request" || event.method !== "notify") continue;
          notices.push(event.message);
          if (/^Ralph loop (?!started)/.test(event.message)) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: "ralph", type: "prompt", message: "/ralph --path task" }) + "\n");
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
    server.close();
    await rm(home, { recursive: true, force: true });
  }
  return { notices, requests };
}

const retried = await runRalph([{ status: 503, message: "Service overloaded" }]);
assert.ok(!retried.notices.some((notice) => /ENOENT|error/i.test(notice)), retried.notices.join("\n"));
assert.ok(retried.notices.some((notice) => /^Iteration 1 complete/.test(notice)), retried.notices.join("\n"));
assert.equal(retried.requests, 2, "Pi should retry the transient model error inside the iteration");

const rejected = await runRalph([{ status: 400, message: "Out of extra usage" }]);
assert.ok(rejected.notices.some((notice) => /^Iteration 1 error: Model request failed: 400\b.*Out of extra usage/.test(notice)), rejected.notices.join("\n"));

// Issue #30: models from provider extensions must reach the iteration's Pi process.
for (const providerSource of ["discovered-extension", "cli-extension", "project-extension"]) {
  const extensionModel = await runRalph([], { providerSource });
  assert.ok(!extensionModel.notices.some((notice) => /error/i.test(notice)), `${providerSource}:\n${extensionModel.notices.join("\n")}`);
  assert.ok(extensionModel.notices.some((notice) => /^Iteration 1 complete/.test(notice)), `${providerSource}:\n${extensionModel.notices.join("\n")}`);
  assert.equal(extensionModel.requests, 1, `${providerSource}: the iteration should call the extension's model`);
}

console.log("Ralph ran an iteration without pi on PATH, retried a transient model error, reported a rejected model request, and used models from discovered, -e, and session-trusted project provider extensions.");
