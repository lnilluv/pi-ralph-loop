---
commands:
  - name: legacy
    run: ./scripts/show-legacy.sh
    timeout: 20
  - name: verify
    run: ./scripts/verify.sh
    timeout: 20
required_outputs:
  - MIGRATED.md
  - MIGRATION_NOTES.md
max_iterations: 2
timeout: 300
completion_promise: DONE
guardrails:
  block_commands: []
  protected_files: []
---
You are migrating a deterministic legacy task into a checked-in summary.

Use only the checked-in legacy files under `legacy/`.
Do not browse the network.

First, inspect `{{ commands.legacy }}`.
Then write `MIGRATED.md` so it matches `golden/MIGRATED.md` exactly.
Write `MIGRATION_NOTES.md` with short bullets that mention `legacy/source.md`, `legacy/source.yaml`, `scripts/show-legacy.sh`, `scripts/verify.sh`, and `golden/MIGRATED.md`.
Before finishing, run `{{ commands.verify }}`. If the verifier passes and the required outputs exist, clear `OPEN_QUESTIONS.md` of any P0/P1 items and emit <promise>DONE</promise>.
