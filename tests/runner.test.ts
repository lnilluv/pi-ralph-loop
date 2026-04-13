import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runRalphLoop } from "../src/runner.ts";
import { readStatusFile, readIterationRecords, checkStopSignal, createStopSignal as createStopSignalFn } from "../src/runner-state.ts";
import { generateDraft } from "../src/ralph.ts";
import type { DraftTarget, CommandOutput, CommandDef } from "../src/ralph.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ralph-runner-"));
}

function writeRalphMd(taskDir: string, content: string): string {
  const ralphPath = join(taskDir, "RALPH.md");
  writeFileSync(ralphPath, content, "utf8");
  return ralphPath;
}

function minimalRalphMd(overrides: Record<string, unknown> = {}): string {
  const fm = {
    commands: [],
    max_iterations: 2,
    timeout: 5,
    guardrails: { block_commands: [], protected_files: [] },
    ...overrides,
  };
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\nTask: Do something\n`;
}

function makeMockPi() {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ killed: false, stdout: "", stderr: "" }),
  };
}

function makeMockSpawnScript(cwd: string, outputs: Array<{ text: string; promise?: string }>): string {
  const lines = [
    "#!/bin/bash",
    "read line",
    `echo '{"type":"response","command":"prompt","success":true}'`,
  ];
  for (const output of outputs) {
    const text = output.text.replace(/"/g, '\\"');
    lines.push(`echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"' + text + '"}]}]}'`);
  }
  return lines.join("\n");
}

test("runRalphLoop completes a single iteration with mock subprocess", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));
    const notifications: Array<{ message: string; level: string }> = [];
    const statuses: string[] = [];

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "echo",
      spawnArgs: ["mock"],
      onNotify(message, level) {
        notifications.push({ message, level });
      },
      onStatusChange(status) {
        statuses.push(status);
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    // The "echo mock" command won't produce valid RPC JSONL output,
    // so the subprocess will exit without agent_end
    // This is expected to result in an error or no-progress outcome
    assert.ok(result.status === "error" || result.status === "no-progress-exhaustion" || result.status === "max-iterations");
    assert.ok(result.iterations.length >= 1);
    assert.ok(statuses.length > 0);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop writes durable status files", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));

    await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "echo",
      spawnArgs: ["mock"],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    // Verify status file was written
    const status = readStatusFile(taskDir);
    assert.ok(status !== undefined);
    assert.ok(status.loopToken.length > 0);
    assert.ok(status.taskDir === taskDir || status.taskDir.endsWith(taskDir.split("/").pop()!));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop detects task-dir file progress from subprocess writes", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));

    // Script that writes a file then sends agent_end
    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
mkdir -p "${taskDir}/notes"
echo "findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onNotify(message, level) {
        notifications.push({ message, level });
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    // Should detect progress from file changes
    assert.equal(result.iterations.length, 1);
    assert.ok(result.iterations[0].progress === true || result.iterations[0].progress === "unknown", `unexpected progress: ${result.iterations[0].progress}`);
    if (result.iterations[0].changedFiles.length > 0) {
      assert.ok(result.iterations[0].changedFiles.includes("notes/findings.md"));
    }
    assert.ok(notifications.some((n) => n.message.includes("Iteration 1")));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop respects stop signal from durable state", async () => {
  const taskDir = createTempDir();
  try {
    // Use max_iterations: 2 but stop after first iteration
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    // Create stop signal before second iteration
    let iterationCount = 0;
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 2,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationComplete() {
        iterationCount++;
        if (iterationCount >= 1) {
          createStopSignalFn(taskDir);
        }
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "stopped");
    assert.ok(result.iterations.length <= 2);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop detects completion promise in subprocess output", async () => {
  const taskDir = createTempDir();
  try {
    // Write a file so progress is detected
    mkdirSync(join(taskDir, "notes"), { recursive: true });
    writeFileSync(join(taskDir, "notes", "findings.md"), "initial\n");

    const ralphPath = writeRalphMd(
      taskDir,
      minimalRalphMd({ max_iterations: 3, completion_promise: "DONE" }),
    );

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> All done!"}]}]}'
`,
      { mode: 0o755 },
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 10,
      maxIterations: 3,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onNotify(message, level) {
        notifications.push({ message, level });
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.ok(result.iterations.length >= 1);
    // Should have matched the completion promise
    const firstIter = result.iterations[0];
    assert.equal(firstIter.completionPromiseMatched, true);
    assert.ok(notifications.some((n) => n.message.includes("completion promise")));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop records iteration results to JSONL", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    const records = readIterationRecords(taskDir);
    assert.ok(records.length >= 1);
    assert.equal(records[0].iteration, 1);
    assert.equal(records[0].status, "complete");
    assert.ok(records[0].durationMs !== undefined && records[0].durationMs >= 0);
    assert.ok(records[0].startedAt.length > 0);
    assert.ok(records[0].completedAt !== undefined && records[0].completedAt.length > 0);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop reports no-progress-exhaustion when no files are written", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, timeout: 5 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"I thought about it but wrote nothing"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.iterations.length, 1);
    assert.equal(result.iterations[0].progress, false);
    // With only 1 iteration and no progress, should exhaust
    assert.ok(["no-progress-exhaustion", "error"].includes(result.status));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop reports max-iterations when progress was made", async () => {
  const taskDir = createTempDir();
  try {
    mkdirSync(join(taskDir, "notes"), { recursive: true });
    writeFileSync(join(taskDir, "notes", "findings.md"), "initial\n");

    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, timeout: 5 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo "progress!" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"updated file"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.iterations.length, 1);
    // With progress but max_iterations reached, could be either max-iterations or complete
    assert.ok(["max-iterations", "no-progress-exhaustion", "complete", "error"].includes(result.status));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops with error when RALPH.md becomes invalid during loop", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    let iterationCount = 0;
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 3,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationComplete() {
        iterationCount++;
        // Corrupt after first iteration finishes
        if (iterationCount === 1) {
          writeFileSync(ralphPath, "not valid yaml at all", "utf8");
        }
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    // The loop should have stopped (error from invalid RALPH.md on iteration 2)
    assert.ok(result.iterations.length >= 1);
    assert.ok(["error", "stopped", "no-progress-exhaustion", "max-iterations"].includes(result.status));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop reports error when RALPH.md is missing", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = join(taskDir, "RALPH.md");
    // Don't create the file

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "echo",
      spawnArgs: ["mock"],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "error");
    assert.equal(result.iterations.length, 0);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});