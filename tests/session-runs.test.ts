import assert from "node:assert/strict";
import test from "node:test";

import {
  type SessionRunHandle,
  sessionRunKey,
  sessionRunStatusText,
  sessionRunWidgetLines,
  sortedSessionRuns,
} from "../src/session-runs.ts";

function makeHandle(
  name: string,
  taskDir: string,
  loopToken: string,
  phase: "initializing" | "running" = "running",
  iteration = 0,
): SessionRunHandle {
  return {
    key: sessionRunKey(taskDir, loopToken),
    name,
    loopToken,
    phase,
    iteration,
    settings: {
      cwd: "/workspace",
      taskDir,
      ralphPath: `${taskDir}/RALPH.md`,
      runtimeArgs: {},
      timeout: 300,
      maxIterations: 5,
      stopOnError: true,
    },
  };
}

test("empty session runs render no status or widget", () => {
  const runs = new Map<string, SessionRunHandle>();

  assert.deepEqual(sortedSessionRuns(runs), []);
  assert.equal(sessionRunStatusText(runs), undefined);
  assert.equal(sessionRunWidgetLines(runs), undefined);
});

test("one session run renders its name and iteration without a widget", () => {
  const handle = makeHandle("api", "/workspace/api", "token-a", "initializing", 2);
  const runs = new Map([[handle.key, handle]]);

  assert.equal(sessionRunStatusText(runs), "Ralph: api — initializing (2/5)");
  assert.equal(sessionRunWidgetLines(runs), undefined);
});

test("multiple session runs render deterministic task-path rows", () => {
  const zeta = makeHandle("zeta", "/workspace/zeta", "token-z", "running", 4);
  const alpha = makeHandle("alpha", "/workspace/alpha", "token-a", "initializing", 1);
  const runs = new Map([
    [zeta.key, zeta],
    [alpha.key, alpha],
  ]);

  assert.deepEqual(sortedSessionRuns(runs).map((handle) => handle.settings.taskDir), ["/workspace/alpha", "/workspace/zeta"]);
  assert.equal(sessionRunStatusText(runs), "Ralph: 2 active");
  assert.deepEqual(sessionRunWidgetLines(runs), [
    "alpha (/workspace/alpha) — initializing, 1/5",
    "zeta (/workspace/zeta) — running, 4/5",
  ]);
});

test("session run keys include both task directory and loop token", () => {
  const taskDir = "/workspace/api";

  assert.notEqual(sessionRunKey(taskDir, "token-a"), sessionRunKey(taskDir, "token-b"));
  assert.notEqual(sessionRunKey("/workspace/web", "token-a"), sessionRunKey(taskDir, "token-a"));
});

test("removing a terminal handle from the map rerenders the remaining run", () => {
  const alpha = makeHandle("alpha", "/workspace/alpha", "token-a", "running", 1);
  const zeta = makeHandle("zeta", "/workspace/zeta", "token-z", "running", 3);
  const runs = new Map([
    [alpha.key, alpha],
    [zeta.key, zeta],
  ]);

  runs.delete(zeta.key);

  assert.equal(sessionRunStatusText(runs), "Ralph: alpha — running (1/5)");
  assert.equal(sessionRunWidgetLines(runs), undefined);
});
