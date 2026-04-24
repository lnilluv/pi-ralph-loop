---
max_iterations: 20
timeout: 180
commands:
  - name: tests
    run: npm test
    timeout: 120
  - name: typecheck
    run: npm run typecheck
    timeout: 120
completion_promise: DONE
completion_gate: required
required_outputs:
  - MIGRATION_NOTES.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# api-surface-migration

Migrate the legacy API in small, reviewable steps.

## Evidence
- Tests:
  {{ commands.tests }}
- Typecheck:
  {{ commands.typecheck }}

## Task
- Move one module or boundary per iteration.
- Keep compatibility shims explicit.
- Capture decisions in MIGRATION_NOTES.md.

## Completion
Stop with <promise>DONE</promise> only when MIGRATION_NOTES.md exists and the checks stay green.
