import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the real extension in a credential-free host without making an LLM request.
const root = fileURLToPath(new URL("../", import.meta.url));
const piPackage = join(root, "node_modules/@earendil-works/pi-coding-agent");
const piCli = join(piPackage, JSON.parse(await readFile(join(piPackage, "package.json"), "utf8")).bin.pi);
const home = await mkdtemp(join(tmpdir(), "ralph-host-"));
const child = spawn(process.execPath, [
  piCli,
  "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  "--no-approve", "-e", join(root, "src/index.ts"),
], {
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((resolve) => child.once("close", resolve));
try {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), 20_000);
    let buffer = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Host exited ${code}: ${stderr}`)));
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.id === "commands") {
            clearTimeout(timer);
            resolve(event);
          }
        } catch { /* Non-JSON startup output is not an RPC response. */ }
      }
    });
    child.stdin.end(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
  });
  assert.equal(response.success, true, stderr);
  const names = response.data.commands.filter((command) => command.source === "extension").map((command) => command.name);
  for (const name of ["ralph", "ralph-draft", "ralph-list", "ralph-status", "ralph-resume", "ralph-archive", "ralph-stop", "ralph-cancel", "ralph-scaffold", "ralph-logs"]) {
    assert.ok(names.includes(name), `Missing /${name}: ${stderr}`);
  }
  console.log("Maintained Pi host loaded all 10 Ralph commands.");
} finally {
  child.kill("SIGKILL");
  await exited;
  await rm(home, { recursive: true, force: true });
}
