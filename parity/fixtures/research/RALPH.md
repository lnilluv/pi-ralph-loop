---
commands:
  - name: snapshots
    run: ./scripts/show-snapshots.sh
    timeout: 20
  - name: verify
    run: ./scripts/verify.sh
    timeout: 20
required_outputs:
  - evidence/raw/docs-factory-ai-cli-features-missions.md
  - evidence/raw/factory-ai-news-missions.md
  - evidence/raw/app-factory-ai-cli.md
  - INSTALL_FLOW.md
  - MISSIONS_FINDINGS.md
  - evidence/INDEX.md
max_iterations: 2
timeout: 300
completion_promise: DONE
guardrails:
  block_commands: []
  protected_files: []
---
You are doing a frozen research pass on the Factory.ai public surface.

Use only the checked-in snapshot files under `snapshots/` and the checked-in metadata files in this fixture.
Do not fetch network content and do not rely on live docs.

The snapshot files are:
- `snapshots/docs-factory-ai-cli-features-missions.md`
- `snapshots/factory-ai-news-missions.md`
- `snapshots/app-factory-ai-cli.md`

The checked-in metadata files are:
- `source-manifest.md`
- `claim-evidence-checklist.md`
- `expected-outputs.md`

First, inspect `{{ commands.snapshots }}`.
Then review the metadata files above.
Then copy each snapshot verbatim into `evidence/raw/` with the same file name.
Write `INSTALL_FLOW.md` with the installer path and a short explanation of the public claims.
Write `MISSIONS_FINDINGS.md` with citations that point at the snapshot file paths.
Write `evidence/INDEX.md` that maps each raw evidence file back to its source snapshot.

Before you finish, run `{{ commands.verify }}`. If the verifier passes and the required outputs exist, clear `OPEN_QUESTIONS.md` of any P0/P1 items and emit <promise>DONE</promise>.
