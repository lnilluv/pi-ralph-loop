import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_RALPH_PARITY_MODEL;
  delete env.PI_RALPH_PARITY_LOOP_RPC_COMMAND;
  return env;
}

test("parity harness builds a pi command without pinning a model by default", async () => {
  const { stdout } = await execFileAsync(
    "python3",
    [
      "-c",
      "from parity.harness import build_loop_rpc_command; print(' '.join(build_loop_rpc_command(None)))",
    ],
    { cwd: repoRoot, env: cleanEnv() },
  );

  assert.match(stdout.trim(), /^pi --mode rpc --no-extensions -e .*\/src\/index\.ts$/);
  assert.equal(stdout.includes("--model"), false);
});

test("parity harness appends an explicit model when requested", async () => {
  const { stdout } = await execFileAsync(
    "python3",
    [
      "-c",
      "from parity.harness import build_loop_rpc_command; print(' '.join(build_loop_rpc_command('openai-codex/gpt-5.4-mini:high')))"
    ],
    { cwd: repoRoot, env: cleanEnv() },
  );

  assert.match(stdout.trim(), /^pi --mode rpc --no-extensions -e .*\/src\/index\.ts --model openai-codex\/gpt-5\.4-mini:high$/);
});
