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
  - OPEN_QUESTIONS.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# dependency-security-review

Triage dependency risk and keep the verification trail current.

## Evidence
- Audit:
  {{ commands.audit }}
- Tests:
  {{ commands.tests }}
- Typecheck:
  {{ commands.typecheck }}

## Task
- Sort findings by risk.
- Fix the most important issues first.
- Capture unresolved P0/P1 items in OPEN_QUESTIONS.md.
- Update SECURITY_AUDIT.md with residual risk and verification.

## Completion
Stop with <promise>DONE</promise> only when SECURITY_AUDIT.md exists, OPEN_QUESTIONS.md has no remaining P0/P1 items, and the audit is addressed.
