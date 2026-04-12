import { assembleRepoContext } from "./ralph-draft-context.ts";
import {
  buildDraftRequest,
  classifyTaskMode,
  generateDraftFromRequest,
  inspectRepo,
  type DraftPlan,
  type DraftTarget,
} from "./ralph.ts";
import { strengthenDraftWithLlm, type StrengthenDraftRuntime } from "./ralph-draft-llm.ts";

export type CreateDraftPlanOptions = {
  strengthenDraftWithLlmImpl?: typeof strengthenDraftWithLlm;
};
export async function createDraftPlan(
  task: string,
  target: DraftTarget,
  cwd: string,
  runtime?: StrengthenDraftRuntime,
  options: CreateDraftPlanOptions = {},
): Promise<DraftPlan> {
  const repoSignals = inspectRepo(cwd);
  const mode = classifyTaskMode(task);
  const repoContext = assembleRepoContext(cwd, task, mode, repoSignals);
  const request = buildDraftRequest(task, target, repoSignals, repoContext);
  if (runtime?.model) {
    const strengthen = options.strengthenDraftWithLlmImpl ?? strengthenDraftWithLlm;
    const strengthened = await strengthen(request, runtime, { scope: "body-only" });
    if (strengthened.kind === "llm-strengthened") return strengthened.draft;
  }

  return generateDraftFromRequest(request, "fallback");
}
