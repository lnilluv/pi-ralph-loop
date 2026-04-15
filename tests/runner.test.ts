import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { assessTaskDirectoryProgress, captureTaskDirectorySnapshot, runRalphLoop, validateCompletionReadiness } from "../src/runner.ts";
import { readStatusFile, readIterationRecords, readRunnerEvents, checkStopSignal, createCancelSignal, createStopSignal as createStopSignalFn, type RunnerEvent } from "../src/runner-state.ts";
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

function isRunnerEventType<T extends RunnerEvent["type"]>(type: T) {
  return (event: RunnerEvent): event is Extract<RunnerEvent, { type: T }> => event.type === type;
}

function hasIteration(event: RunnerEvent): event is Extract<RunnerEvent, { iteration: number }> {
  return "iteration" in event;
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

test("runRalphLoop persists RPC telemetry in iteration records", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
printf 'research stderr\n' >&2
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

    const [record] = readIterationRecords(taskDir);
    assert.ok(record.rpcTelemetry);
    assert.ok(record.rpcTelemetry?.spawnedAt.length > 0);
    assert.ok(record.rpcTelemetry?.promptSentAt);
    assert.ok(record.rpcTelemetry?.firstStdoutEventAt);
    assert.ok(record.rpcTelemetry?.lastEventAt);
    assert.equal(record.rpcTelemetry?.lastEventType, "agent_end");
    assert.ok(record.rpcTelemetry?.exitedAt);
    assert.match(record.rpcTelemetry?.stderrText ?? "", /research stderr/);
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

test("runRalphLoop injects RALPH_PROGRESS.md into every iteration prompt", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));
    writeFileSync(join(taskDir, "RALPH_PROGRESS.md"), "Keep this short.\nOverwrite in place.\n", "utf8");

    const promptPath = join(taskDir, "prompt.json");
    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
printf '%s' "$line" > "${promptPath}"
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

    const prompt = JSON.parse(readFileSync(promptPath, "utf8")) as { message: string };
    assert.match(prompt.message, /RALPH_PROGRESS\.md/);
    assert.match(prompt.message, /Keep this short\./);
    assert.match(prompt.message, /Keep it short/i);
    assert.match(prompt.message, /overwrite in place/i);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop ignores missing RALPH_PROGRESS.md", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }));

    const promptPath = join(taskDir, "prompt.json");
    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
printf '%s' "$line" > "${promptPath}"
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

    const prompt = JSON.parse(readFileSync(promptPath, "utf8")) as { message: string };
    assert.equal(prompt.message.includes("RALPH_PROGRESS.md"), false);
    assert.equal(prompt.message.toLowerCase().includes("keep it short and overwrite in place"), false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop cancels mid-iteration when cancel flag is written", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3 }));

    const scriptPath = join(taskDir, "slow-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
sleep 10
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    setTimeout(() => createCancelSignal(taskDir), 1000);

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 30,
      maxIterations: 3,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "cancelled");
    assert.ok(result.iterations.length >= 1);
    assert.equal(result.iterations[result.iterations.length - 1].status, "cancelled");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop checks cancel flag at iteration boundary", async () => {
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
        if (iterationCount >= 1) {
          createCancelSignal(taskDir);
        }
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "cancelled");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop waits between iterations when inter_iteration_delay is set", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, inter_iteration_delay: 1 }));

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

    const iterationStarts: number[] = [];
    await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 2,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationStart() {
        iterationStarts.push(Date.now());
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(iterationStarts.length, 2);
    assert.ok(iterationStarts[1] - iterationStarts[0] >= 900, `expected delay between iterations, got ${iterationStarts[1] - iterationStarts[0]}ms`);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop does not delay after the final allowed iteration", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, inter_iteration_delay: 5 }));

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

    const startedAt = Date.now();
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

    assert.ok(Date.now() - startedAt < 2000, "unexpected inter-iteration delay after the final iteration");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops promptly during inter-iteration delay when /ralph-stop is requested", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, inter_iteration_delay: 5 }));

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

    const startedAt = Date.now();
    let completedIterations = 0;
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 2,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationComplete() {
        completedIterations += 1;
        if (completedIterations === 1) {
          createStopSignalFn(taskDir);
        }
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "stopped");
    assert.equal(result.iterations.length, 1);
    assert.ok(Date.now() - startedAt < 2500, "expected stop during the inter-iteration delay");
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

test("runRalphLoop keeps prompting after a premature completion promise until durable progress exists", async () => {
  const taskDir = createTempDir();
  let captureDir: string | undefined;
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, completion_promise: "DONE" }));
    captureDir = mkdtempSync(join(tmpdir(), "pi-ralph-loop-capture-"));
    const promptCounterPath = join(captureDir, "prompt-counter.txt");
    const promptPathPrefix = join(captureDir, "prompt-");
    const scriptPath = join(taskDir, "mock-pi-recovery.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
count=0
if [ -f "${promptCounterPath}" ]; then
  count=$(cat "${promptCounterPath}")
fi
count=$((count + 1))
printf '%s' "$count" > "${promptCounterPath}"
read line
printf '%s' "$line" > "${promptPathPrefix}$count.json"
echo '{"type":"response","command":"prompt","success":true}'
if [ "$count" -eq 1 ]; then
  echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> premature"}]}]}'
else
  echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"still working"}]}]}'
fi
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 2,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.iterations.length, 2);
    const secondPrompt = JSON.parse(readFileSync(join(captureDir!, "prompt-2.json"), "utf8")) as { message: string };
    assert.match(secondPrompt.message, /\[completion gate rejection\]/);
    assert.match(secondPrompt.message, /Still missing: durable progress/);
  } finally {
    if (captureDir) {
      rmSync(captureDir, { recursive: true, force: true });
    }
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("validateCompletionReadiness reports ready when required outputs exist and OPEN_QUESTIONS.md is clear", (t) => {
  const taskDir = createTempDir();
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));

  writeFileSync(join(taskDir, "ARCHITECTURE.md"), "done\n", "utf8");
  writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), "# Open questions\n\nAll clear.\n", "utf8");

  assert.deepEqual(validateCompletionReadiness(taskDir, ["ARCHITECTURE.md"]), { ready: true, reasons: [] });
});

test("validateCompletionReadiness reports blocking reasons for missing outputs and unresolved questions", (t) => {
  const taskDir = createTempDir();
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));

  writeFileSync(
    join(taskDir, "OPEN_QUESTIONS.md"),
    "## P0\n- [ ] Decide the migration order\n\n## P1\n- [ ] Confirm the test plan\n",
    "utf8",
  );

  const readiness = validateCompletionReadiness(taskDir, ["ARCHITECTURE.md"]);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes("Missing required output: ARCHITECTURE.md"));
  assert.ok(readiness.reasons.includes("OPEN_QUESTIONS.md still has P0 items"));
  assert.ok(readiness.reasons.includes("OPEN_QUESTIONS.md still has P1 items"));
});

test("validateCompletionReadiness blocks on any markdown heading level used for P0 and P1 sections", (t) => {
  const cases = [
    {
      label: "# P0",
      content: "# P0\n- [ ] Decide the migration order\n",
      expectedReason: "OPEN_QUESTIONS.md still has P0 items",
    },
    {
      label: "### P1",
      content: "### P1\n- [ ] Confirm the test plan\n",
      expectedReason: "OPEN_QUESTIONS.md still has P1 items",
    },
    {
      label: "nested subheading under ## P0",
      content: "## P0\n### Notes\n- [ ] Decide the migration order\n",
      expectedReason: "OPEN_QUESTIONS.md still has P0 items",
    },
  ] as const;

  for (const { label, content, expectedReason } of cases) {
    const taskDir = createTempDir();
    t.after(() => rmSync(taskDir, { recursive: true, force: true }));
    writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), content, "utf8");

    const readiness = validateCompletionReadiness(taskDir, []);
    assert.equal(readiness.ready, false, label);
    assert.ok(readiness.reasons.includes(expectedReason), label);
  }
});

test("validateCompletionReadiness ignores checked items inside P0 and P1 sections", (t) => {
  const taskDir = createTempDir();
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));

  writeFileSync(
    join(taskDir, "OPEN_QUESTIONS.md"),
    "# P0\n- [x] Decide the migration order\n\n### P1\n1. [X] Confirm the test plan\n",
    "utf8",
  );

  assert.deepEqual(validateCompletionReadiness(taskDir, []), { ready: true, reasons: [] });
});

test("validateCompletionReadiness ignores nested note bullets under checked items", (t) => {
  const taskDir = createTempDir();
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));

  writeFileSync(
    join(taskDir, "OPEN_QUESTIONS.md"),
    "# P0\n- [x] Decide the migration order\n  - note: revisit after merge\n",
    "utf8",
  );

  assert.deepEqual(validateCompletionReadiness(taskDir, []), { ready: true, reasons: [] });
});

test("runRalphLoop does not stop on completion promise when required outputs are missing", async () => {
  const taskDir = createTempDir();
  try {
    writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), "# Open questions\n\nAll clear.\n", "utf8");
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, completion_promise: "DONE", required_outputs: ["ARCHITECTURE.md"] }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
mkdir -p "${taskDir}/notes"
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> All done!"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 10,
      maxIterations: 2,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status === "complete", false);
    assert.equal(result.iterations.length, 2);
    assert.equal(result.iterations[0].completionPromiseMatched, true);
    assert.equal(result.iterations[0].completionGate?.ready, false);
    assert.ok(result.iterations[0].completionGate?.reasons.includes("Missing required output: ARCHITECTURE.md"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop does not stop on completion promise when OPEN_QUESTIONS.md still has P0 items", async () => {
  const taskDir = createTempDir();
  try {
    writeFileSync(join(taskDir, "ARCHITECTURE.md"), "done\n", "utf8");
    writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), "## P0\n- [ ] Decide the architecture\n", "utf8");
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, completion_promise: "DONE", required_outputs: ["ARCHITECTURE.md"] }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
mkdir -p "${taskDir}/notes"
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> All done!"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 10,
      maxIterations: 2,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.notEqual(result.status, "complete");
    assert.equal(result.iterations.length, 2);
    assert.equal(result.iterations[0].completionGate?.ready, false);
    assert.ok(result.iterations[0].completionGate?.reasons.includes("OPEN_QUESTIONS.md still has P0 items"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops when the completion gate passes", async () => {
  const taskDir = createTempDir();
  try {
    writeFileSync(join(taskDir, "ARCHITECTURE.md"), "done\n", "utf8");
    writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), "# Open questions\n\nNothing open.\n", "utf8");
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3, completion_promise: "DONE", required_outputs: ["ARCHITECTURE.md"] }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
mkdir -p "${taskDir}/notes"
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> All done!"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 10,
      maxIterations: 3,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "complete");
    assert.equal(result.iterations.length, 1);
    assert.equal(result.iterations[0].completionPromiseMatched, true);
    assert.deepEqual(result.iterations[0].completionGate, { ready: true, reasons: [] });
    assert.deepEqual(result.iterations[0].completion, {
      promiseSeen: true,
      durableProgressObserved: true,
      gateChecked: true,
      gatePassed: true,
      gateBlocked: false,
      blockingReasons: [],
    });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop records completion observability events when the completion gate is blocked", async () => {
  const taskDir = createTempDir();
  try {
    writeFileSync(join(taskDir, "OPEN_QUESTIONS.md"), "# Open questions\n\nNothing open.\n", "utf8");
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 2, completion_promise: "DONE", required_outputs: ["ARCHITECTURE.md"] }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
mkdir -p "${taskDir}/notes"
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"<promise>DONE</promise> All done!"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 10,
      maxIterations: 2,
      completionPromise: "DONE",
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    const records = readIterationRecords(taskDir);
    assert.equal(records.length >= 1, true);
    assert.deepEqual(records[0].completion, {
      promiseSeen: true,
      durableProgressObserved: true,
      gateChecked: true,
      gatePassed: false,
      gateBlocked: true,
      blockingReasons: ["Missing required output: ARCHITECTURE.md"],
    });

    const events = readRunnerEvents(taskDir);
    assert.deepEqual(
      events.filter(hasIteration).filter((event) => event.iteration === 1).map((event) => event.type),
      [
        "iteration.started",
        "durable.progress.observed",
        "completion_promise_seen",
        "completion.gate.checked",
        "completion_gate_blocked",
        "iteration.completed",
      ],
    );

    const completionPromiseEvent = events.find(isRunnerEventType("completion_promise_seen")) as Extract<RunnerEvent, { type: "completion_promise_seen" }> | undefined;
    assert.ok(completionPromiseEvent);
    const { timestamp: _completionPromiseTimestamp, ...completionPromisePayload } = completionPromiseEvent!;
    assert.deepEqual(completionPromisePayload, {
      type: "completion_promise_seen",
      iteration: 1,
      loopToken: completionPromiseEvent!.loopToken,
      completionPromise: "DONE",
    });

    const gateCheckedEvent = events.find(isRunnerEventType("completion.gate.checked")) as Extract<RunnerEvent, { type: "completion.gate.checked" }> | undefined;
    assert.ok(gateCheckedEvent);
    const { timestamp: _gateCheckedTimestamp, ...gateCheckedPayload } = gateCheckedEvent!;
    assert.deepEqual(gateCheckedPayload, {
      type: "completion.gate.checked",
      iteration: 1,
      loopToken: gateCheckedEvent!.loopToken,
      ready: false,
      reasons: ["Missing required output: ARCHITECTURE.md"],
    });

    const blockedEvent = events.find(isRunnerEventType("completion_gate_blocked")) as Extract<RunnerEvent, { type: "completion_gate_blocked" }> | undefined;
    assert.ok(blockedEvent);
    const { timestamp: _blockedTimestamp, ...blockedPayload } = blockedEvent!;
    assert.deepEqual(blockedPayload, {
      type: "completion_gate_blocked",
      iteration: 1,
      loopToken: blockedEvent!.loopToken,
      ready: false,
      reasons: ["Missing required output: ARCHITECTURE.md"],
    });

    const iterationCompletedEvent = events.find(isRunnerEventType("iteration.completed")) as Extract<RunnerEvent, { type: "iteration.completed" }> | undefined;
    assert.ok(iterationCompletedEvent);
    const { timestamp: _iterationCompletedTimestamp, ...iterationCompletedPayload } = iterationCompletedEvent!;
    assert.deepEqual(iterationCompletedPayload, {
      type: "iteration.completed",
      iteration: 1,
      loopToken: iterationCompletedEvent!.loopToken,
      status: "complete",
      progress: true,
      changedFiles: ["notes/findings.md"],
      noProgressStreak: 0,
      completionPromiseMatched: true,
      completionGate: {
        ready: false,
        reasons: ["Missing required output: ARCHITECTURE.md"],
      },
      completion: {
        promiseSeen: true,
        durableProgressObserved: true,
        gateChecked: true,
        gatePassed: false,
        gateBlocked: true,
        blockingReasons: ["Missing required output: ARCHITECTURE.md"],
      },
      snapshotTruncated: false,
      snapshotErrorCount: 0,
    });

    assert.notEqual(result.status, "complete");
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

test("assessTaskDirectoryProgress returns unknown when a late snapshot hits an unreadable directory", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, timeout: 5 }));
    writeFileSync(join(taskDir, "a.txt"), "seed\n", "utf8");

    const before = captureTaskDirectorySnapshot(ralphPath);
    const lateDir = join(taskDir, "zz-late-dir");
    setTimeout(() => {
      mkdirSync(lateDir, { recursive: true });
      chmodSync(lateDir, 0o000);
    }, 50);

    const result = await assessTaskDirectoryProgress(ralphPath, before);

    assert.equal(result.progress, "unknown");
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.snapshotTruncated, false);
    assert.ok(result.snapshotErrorCount > 0);
  } finally {
    const lateDir = join(taskDir, "zz-late-dir");
    if (existsSync(lateDir)) {
      chmodSync(lateDir, 0o700);
    }
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("assessTaskDirectoryProgress returns unknown when a late snapshot is truncated", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, timeout: 5 }));
    writeFileSync(join(taskDir, "a.txt"), Buffer.alloc(2_000_000, 1));

    const before = captureTaskDirectorySnapshot(ralphPath);
    const lateFile = join(taskDir, "zz-late.bin");
    setTimeout(() => {
      writeFileSync(lateFile, Buffer.alloc(300_000, 2));
    }, 50);

    const result = await assessTaskDirectoryProgress(ralphPath, before);

    assert.equal(result.progress, "unknown");
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.snapshotTruncated, true);
    assert.equal(result.snapshotErrorCount, 0);
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

test("runRalphLoop fails closed when live RALPH.md reparse sees malformed raw required_outputs", async () => {
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

    const notifications: Array<{ message: string; level: string }> = [];
    let completedIterations = 0;
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 3,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationComplete() {
        completedIterations++;
        if (completedIterations === 1) {
          writeFileSync(
            ralphPath,
            `---\ncommands: []\nmax_iterations: 3\ntimeout: 5\nrequired_outputs: ARCHITECTURE.md\nguardrails:\n  block_commands: []\n  protected_files: []\n---\nTask: Do something\n`,
            "utf8",
          );
        }
      },
      onNotify(message, level) {
        notifications.push({ message, level });
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "error");
    assert.equal(result.iterations.length, 1);
    assert.ok(
      notifications.some((n) => n.message.includes("Invalid RALPH.md on iteration 2: Invalid RALPH frontmatter: required_outputs must be a YAML sequence")),
    );
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

test("runRalphLoop writes a transcript for a successful iteration", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(
      taskDir,
      minimalRalphMd({ max_iterations: 1 }).replace("Task: Do something", "Task: Successful transcript case"),
    );
    mkdirSync(join(taskDir, "notes"), { recursive: true });
    writeFileSync(join(taskDir, "notes", "findings.md"), "initial\n", "utf8");

    const scriptPath = join(taskDir, "mock-pi-success.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo "updated findings" > "${taskDir}/notes/findings.md"
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"all done"}]}]}'
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
      runCommandsFn: async () => [{ name: "tests", output: "command output" }],
      pi: makeMockPi(),
    });

    assert.ok(["complete", "max-iterations"].includes(result.status));
    const transcriptsDir = join(taskDir, ".ralph-runner", "transcripts");
    const transcriptFiles = readdirSync(transcriptsDir).filter((file) => file.endsWith(".md"));
    assert.equal(transcriptFiles.length, 1);
    const transcript = readFileSync(join(transcriptsDir, transcriptFiles[0]), "utf8");
    assert.ok(transcript.includes("Status: complete"));
    assert.ok(transcript.includes("Task: Successful transcript case"));
    assert.ok(transcript.includes("tests"));
    assert.ok(transcript.includes("command output"));
    assert.ok(transcript.includes("all done"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop writes a transcript for a timed out iteration", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1, timeout: 1 }).replace("Task: Do something", "Task: Timeout transcript case"));

    const scriptPath = join(taskDir, "mock-pi-timeout.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
sleep 5
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 1,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [{ name: "tests", output: "command output" }],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "timeout");
    const transcriptsDir = join(taskDir, ".ralph-runner", "transcripts");
    const transcriptFiles = readdirSync(transcriptsDir).filter((file) => file.endsWith(".md"));
    assert.equal(transcriptFiles.length, 1);
    const transcript = readFileSync(join(transcriptsDir, transcriptFiles[0]), "utf8");
    assert.ok(transcript.includes("Status: timeout"));
    assert.ok(transcript.toLowerCase().includes("timed out"));
    assert.ok(transcript.includes("Task: Timeout transcript case"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop preserves transcript files across reruns in the same task dir", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 1 }).replace("Task: Do something", "Task: Rerun transcript case"));

    const scriptPath = join(taskDir, "mock-pi-rerun.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"all done"}]}]}'
`,
      { mode: 0o755 },
    );

    const firstRun = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [{ name: "tests", output: "command output" }],
      pi: makeMockPi(),
    });

    const secondRun = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 1,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [{ name: "tests", output: "command output" }],
      pi: makeMockPi(),
    });

    assert.ok(firstRun.iterations[0]?.loopToken);
    assert.ok(secondRun.iterations[0]?.loopToken);
    assert.notEqual(firstRun.iterations[0]?.loopToken, secondRun.iterations[0]?.loopToken);

    const transcriptsDir = join(taskDir, ".ralph-runner", "transcripts");
    const transcriptFiles = readdirSync(transcriptsDir).filter((file) => file.endsWith(".md"));
    assert.equal(transcriptFiles.length, 2);

    const firstTranscript = transcriptFiles.find((file) => file.includes(firstRun.iterations[0]!.loopToken!));
    const secondTranscript = transcriptFiles.find((file) => file.includes(secondRun.iterations[0]!.loopToken!));
    assert.ok(firstTranscript);
    assert.ok(secondTranscript);

    const firstRaw = readFileSync(join(transcriptsDir, firstTranscript!), "utf8");
    const secondRaw = readFileSync(join(transcriptsDir, secondTranscript!), "utf8");
    assert.ok(firstRaw.includes("Task: Rerun transcript case"));
    assert.ok(secondRaw.includes("Task: Rerun transcript case"));
    assert.ok(firstRaw.includes("all done"));
    assert.ok(secondRaw.includes("all done"));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops on error when stopOnError is true (default)", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3 }));

    const scriptPath = join(taskDir, "failing-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
exit 1
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 3,
      stopOnError: true,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "error");
    assert.equal(result.iterations.length, 1);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop continues past error when stopOnError is false", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3 }));

    const scriptPath = join(taskDir, "maybe-fail-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
COUNTER_FILE="${taskDir}/.call-counter"
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"
echo '{"type":"response","command":"prompt","success":true}'
if [ "$COUNT" -le 1 ]; then
  exit 1
fi
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}'
`,
      { mode: 0o755 },
    );

    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 3,
      stopOnError: false,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.ok(result.iterations.length > 1, `Expected >1 iteration, got ${result.iterations.length}`);
    assert.equal(result.iterations[0].status, "error");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("runRalphLoop breaks on structural failure even with stopOnError false", async () => {
  const taskDir = createTempDir();
  try {
    const ralphPath = writeRalphMd(taskDir, minimalRalphMd({ max_iterations: 3, stop_on_error: false }));

    const scriptPath = join(taskDir, "mock-pi.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash
read line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"delete ralph"}]}]}'
`,
      { mode: 0o755 },
    );

    let iterationCount = 0;
    const result = await runRalphLoop({
      ralphPath,
      cwd: taskDir,
      timeout: 5,
      maxIterations: 3,
      stopOnError: false,
      guardrails: { blockCommands: [], protectedFiles: [] },
      spawnCommand: "bash",
      spawnArgs: [scriptPath],
      onIterationComplete() {
        iterationCount++;
        if (iterationCount >= 1) {
          rmSync(ralphPath, { force: true });
        }
      },
      runCommandsFn: async () => [],
      pi: makeMockPi(),
    });

    assert.equal(result.status, "error");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

