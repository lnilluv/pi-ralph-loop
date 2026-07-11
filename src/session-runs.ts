import { resolve } from "node:path";

export type SessionRunPhase = "initializing" | "running";

export type SessionRunSettings = {
  cwd: string;
  taskDir: string;
  ralphPath: string;
  modelPattern?: string;
  thinkingLevel?: string;
  runtimeArgs: Readonly<Record<string, string>>;
  timeout: number;
  maxIterations: number;
  stopOnError: boolean;
};

export type SessionRunHandle = {
  key: string;
  name: string;
  loopToken: string;
  phase: SessionRunPhase;
  iteration: number;
  settings: Readonly<SessionRunSettings>;
};

export function sessionRunKey(taskDir: string, loopToken: string): string {
  return JSON.stringify([resolve(taskDir), loopToken]);
}

export function sortedSessionRuns(runs: ReadonlyMap<string, SessionRunHandle>): SessionRunHandle[] {
  return [...runs.values()].sort((left, right) => {
    const leftPath = resolve(left.settings.taskDir);
    const rightPath = resolve(right.settings.taskDir);
    if (leftPath < rightPath) return -1;
    if (leftPath > rightPath) return 1;
    return left.loopToken < right.loopToken ? -1 : left.loopToken > right.loopToken ? 1 : 0;
  });
}

export function sessionRunStatusText(runs: ReadonlyMap<string, SessionRunHandle>): string | undefined {
  if (runs.size === 0) return undefined;
  if (runs.size > 1) return `Ralph: ${runs.size} active`;

  const [run] = runs.values();
  return `Ralph: ${run.name} — ${run.phase} (${run.iteration}/${run.settings.maxIterations})`;
}

export function sessionRunWidgetLines(runs: ReadonlyMap<string, SessionRunHandle>): string[] | undefined {
  if (runs.size < 2) return undefined;

  return sortedSessionRuns(runs).map(
    (run) => `${run.name} (${run.settings.taskDir}) — ${run.phase}, ${run.iteration}/${run.settings.maxIterations}`,
  );
}
