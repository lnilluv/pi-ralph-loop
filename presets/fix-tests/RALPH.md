---
max_iterations: 12
timeout: 120
commands:
  - name: tests
    run: npm test
    timeout: 120
  - name: typecheck
    run: npm run typecheck
    timeout: 120
completion_promise: DONE
completion_gate: optional
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# {{ ralph.name }}

You are fixing failing tests in this repository.

## Evidence
- Latest tests:
  {{ commands.tests }}
- Latest typecheck:
  {{ commands.typecheck }}

## Task
- Reproduce the failures.
- Make the smallest safe fix.
- Re-run the checks until they stay green.

## Completion
Stop with <promise>DONE</promise> when the failures are gone.
