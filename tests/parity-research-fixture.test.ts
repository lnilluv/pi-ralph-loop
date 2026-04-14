import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const fixtureDir = join(process.cwd(), "parity/fixtures/research");

const generatedOutputs = [
  "INSTALL_FLOW.md",
  "MISSIONS_FINDINGS.md",
  "evidence/INDEX.md",
  "evidence/raw/app-factory-ai-cli.md",
  "evidence/raw/docs-factory-ai-cli-features-missions.md",
  "evidence/raw/factory-ai-news-missions.md",
];

test("research fixture does not include generated outputs", () => {
  for (const rel of generatedOutputs) {
    assert.equal(existsSync(join(fixtureDir, rel)), false, `${rel} should not be checked in`);
  }
});

test("research fixture instructions name the helper scripts explicitly", () => {
  const ralph = readFileSync(join(fixtureDir, "RALPH.md"), "utf8");
  assert.match(ralph, /First, inspect `\.\/scripts\/show-snapshots\.sh`\./);
  assert.match(ralph, /Before you finish, run `\.\/scripts\/verify\.sh`\./);
});

test("research checklist leaves generated outputs as pending work", () => {
  const checklist = readFileSync(join(fixtureDir, "claim-evidence-checklist.md"), "utf8");
  assert.match(checklist, /- \[ \] `INSTALL_FLOW\.md` must synthesize the shared installer claim across all three snapshots\./);
  assert.match(checklist, /- \[ \] `MISSIONS_FINDINGS\.md` must cite each snapshot path directly\./);
  assert.match(checklist, /- \[ \] `evidence\/INDEX\.md` must map each raw evidence file back to its snapshot\./);
});
