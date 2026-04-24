---
max_iterations: 15
timeout: 180
commands:
  - name: audit
    run: npm audit --omit=dev
    timeout: 120
  - name: tests
    run: npm test
    timeout: 120
  - name: typecheck
    run: npm run typecheck
    timeout: 120
completion_promise: DONE
completion_gate: required
required_outputs:
  - SECURITY_AUDIT.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# {{ ralph.name }}

You are performing a security audit.

## Evidence
- Audit:
  {{ commands.audit }}
- Tests:
  {{ commands.tests }}
- Typecheck:
  {{ commands.typecheck }}

## Task
- Triage the findings.
- Fix the highest-risk issues first.
- Update SECURITY_AUDIT.md with residual risk and verification.

## Completion
Stop with <promise>DONE</promise> only when the audit is addressed and the report is complete.
