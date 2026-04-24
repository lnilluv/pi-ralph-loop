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
  - OPEN_QUESTIONS.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# {{ ralph.name }}

Migrate one slice at a time.

## Evidence
- Tests:
  {{ commands.tests }}
- Typecheck:
  {{ commands.typecheck }}

## Task
- Move one module or API boundary per iteration.
- Keep compatibility shims explicit.
- Capture unresolved P0/P1 items in OPEN_QUESTIONS.md.
- Record decisions in MIGRATION_NOTES.md.

## Completion
Stop with <promise>DONE</promise> only when MIGRATION_NOTES.md exists, OPEN_QUESTIONS.md has no remaining P0/P1 items, and the checks stay green.
