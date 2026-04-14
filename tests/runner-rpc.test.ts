import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseRpcEvent, runRpcIteration } from "../src/runner-rpc.ts";

// --- parseRpcEvent ---

test("parseRpcEvent parses agent_end events", () => {
  const event = parseRpcEvent('{"type":"agent_end","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"done"}]}]}');
  assert.equal(event.type, "agent_end");
  assert.ok(Array.isArray(event.messages));
});

test("parseRpcEvent returns unknown for unrecognized lines", () => {
  const event = parseRpcEvent("not json at all");
  assert.equal(event.type, "unknown");
});

test("parseRpcEvent returns unknown for lines without type", () => {
  const event = parseRpcEvent('{"foo":"bar"}');
  assert.equal(event.type, "unknown");
});

test("parseRpcEvent handles response events", () => {
  const event = parseRpcEvent('{"type":"response","command":"prompt","success":true,"id":"req-1"}');
  assert.equal(event.type, "response");
});

test("parseRpcEvent handles message_update events with text deltas", () => {
  const event = parseRpcEvent('{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}');
  assert.equal(event.type, "message_update");
});

test("parseRpcEvent handles extension_ui_request events", () => {
  const event = parseRpcEvent('{"type":"extension_ui_request","id":"ui-1","method":"notify","message":"test"}');
  assert.equal(event.type, "extension_ui_request");
});

// --- runRpcIteration with mock subprocess ---

async function writeMockScript(cwd: string, name: string, script: string): Promise<string> {
  const path = join(cwd, name);
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

test("runRpcIteration returns success when subprocess completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi.sh", `#!/bin/bash
read line
printf 'mock stderr\n' >&2
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_start"}'
echo '{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"done"}}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });
    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.lastAssistantText, "done");
    assert.equal(result.agentEndMessages.length, 1);
    assert.equal(result.error, undefined);
    assert.ok(result.telemetry.spawnedAt.length > 0);
    assert.ok(result.telemetry.promptSentAt);
    assert.ok(result.telemetry.firstStdoutEventAt);
    assert.ok(result.telemetry.lastEventAt);
    assert.equal(result.telemetry.lastEventType, "agent_end");
    assert.ok(result.telemetry.exitedAt);
    assert.equal(result.telemetry.timedOutAt, undefined);
    assert.match(result.telemetry.stderrText ?? "", /mock stderr/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration captures close telemetry after agent_end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-close.sh", `#!/bin/bash
read line
printf 'mock stderr\n' >&2
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
sleep 0.2
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });

    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.lastAssistantText, "done");
    assert.ok(result.telemetry.exitedAt);
    assert.equal(result.telemetry.exitCode, 0);
    assert.equal(result.telemetry.exitSignal, null);
    assert.equal(result.telemetry.error, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration records close-derived failure telemetry errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-close-failure.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
exit 7
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });

    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.telemetry.exitedAt);
    assert.equal(result.telemetry.exitCode, 7);
    assert.equal(result.telemetry.exitSignal, null);
    assert.match(result.telemetry.error ?? "", /Subprocess exited with code 7/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration closes stdin after agent_end so the subprocess can exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-wait-for-stdin-close.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
cat >/dev/null
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });

    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.lastAssistantText, "done");
    assert.equal(result.telemetry.exitCode, 0);
    assert.equal(result.telemetry.exitSignal, null);
    assert.ok(result.telemetry.exitedAt);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration records timeout telemetry when subprocess takes too long", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-slow.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
sleep 30
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 500,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.telemetry.spawnedAt.length > 0);
    assert.ok(result.telemetry.promptSentAt);
    assert.ok(result.telemetry.firstStdoutEventAt);
    assert.ok(result.telemetry.lastEventAt);
    assert.equal(result.telemetry.lastEventType, "response");
    assert.ok(result.telemetry.timedOutAt);
    assert.equal(result.telemetry.exitedAt, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration returns error when subprocess fails to start", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "/nonexistent/command/that/does/not/exist",
      spawnArgs: [],
    });
    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.error);
    assert.ok(result.error.length > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration collects completion promise text from agent_end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-promise.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"I am done. <promise>DONE</promise> Please review."}]}]}'
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });
    assert.equal(result.success, true);
    assert.equal(result.lastAssistantText, "I am done. <promise>DONE</promise> Please review.");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration handles empty agent_end messages gracefully", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-empty.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[]}'
`);

    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
    });
    assert.equal(result.success, true);
    assert.equal(result.lastAssistantText, "");
    assert.equal(result.agentEndMessages.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration passes explicit extension loading and task-dir env into the subprocess", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const taskDir = join(cwd, "task-dir");
    const argsFile = join(cwd, "args.txt");
    const envFile = join(cwd, "env.txt");
    const mockScript = await writeMockScript(cwd, "mock-pi-capture.sh", `#!/bin/bash
printf '%s\n' "$@" > "${argsFile}"
printf 'taskDir=%s\n' "\${RALPH_RUNNER_TASK_DIR}" > "${envFile}"
printf 'cwd=%s\n' "\${RALPH_RUNNER_CWD}" >> "${envFile}"
printf 'loopToken=%s\n' "\${RALPH_RUNNER_LOOP_TOKEN}" >> "${envFile}"
printf 'currentIteration=%s\n' "\${RALPH_RUNNER_CURRENT_ITERATION}" >> "${envFile}"
printf 'maxIterations=%s\n' "\${RALPH_RUNNER_MAX_ITERATIONS}" >> "${envFile}"
printf 'noProgressStreak=%s\n' "\${RALPH_RUNNER_NO_PROGRESS_STREAK}" >> "${envFile}"
printf 'guardrails=%s\n' "\${RALPH_RUNNER_GUARDRAILS}" >> "${envFile}"
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`);

    const guardrails = { blockCommands: ["git\\s+push"], protectedFiles: ["src/generated/**"] };
    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: mockScript,
      env: {
        RALPH_RUNNER_TASK_DIR: taskDir,
        RALPH_RUNNER_CWD: cwd,
        RALPH_RUNNER_LOOP_TOKEN: "test-loop-token",
        RALPH_RUNNER_CURRENT_ITERATION: "2",
        RALPH_RUNNER_MAX_ITERATIONS: "5",
        RALPH_RUNNER_NO_PROGRESS_STREAK: "1",
        RALPH_RUNNER_GUARDRAILS: JSON.stringify(guardrails),
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
      "--mode",
      "rpc",
      "--no-session",
      "-e",
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ]);
    assert.deepEqual(readFileSync(envFile, "utf8").trim().split("\n"), [
      `taskDir=${taskDir}`,
      `cwd=${cwd}`,
      `loopToken=test-loop-token`,
      `currentIteration=2`,
      `maxIterations=5`,
      `noProgressStreak=1`,
      `guardrails=${JSON.stringify(guardrails)}`,
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRpcIteration calls onEvent callback for streamed events", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ralph-rpc-"));
  try {
    const mockScript = await writeMockScript(cwd, "mock-pi-events.sh", `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_start"}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"hello"}]}]}'
`);

    const events: string[] = [];
    const result = await runRpcIteration({
      prompt: "test prompt",
      cwd,
      timeoutMs: 5000,
      spawnCommand: "bash",
      spawnArgs: [mockScript],
      onEvent(event) {
        events.push(event.type);
      },
    });
    assert.equal(result.success, true);
    assert.ok(events.includes("agent_start"));
    assert.ok(events.includes("agent_end"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});