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

async function runRalph(failures) {
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
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "model" }] } },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "model", retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } }));
  await writeFile(join(work, "task", "RALPH.md"), "---\nmax_iterations: 1\ntimeout: 60\ncommands: []\n---\nSay hello.\n");

  const systemPath = process.platform === "win32" ? [process.env.SystemRoot && join(process.env.SystemRoot, "System32")] : ["/usr/bin", "/bin"];
  const child = spawn(process.execPath, [
    piCli, "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
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

console.log("Ralph ran an iteration without pi on PATH, retried a transient model error, and reported a rejected model request.");
