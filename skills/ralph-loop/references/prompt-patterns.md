# Prompt patterns for Ralph loops

Use these as starting points when you want the loop to keep working until a concrete deliverable is ready.

## Self-healing test loop

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 60
max_iterations: 20
completion_promise: DONE
completion_gate: required
required_outputs:
  - TEST_REPORT.md
  - OPEN_QUESTIONS.md
stop_on_error: true
guardrails:
  block_commands:
    - 'git\s+push'
---
```

```markdown
You are an autonomous coding agent running in a loop.
Each iteration starts with a fresh context.
Your progress lives in the code and git history.

## Test results
{{ commands.tests }}

Fix failing tests before starting new work.
Write a regression test for the bug you fix.
Stop with <promise>DONE</promise> only when the tests pass, TEST_REPORT.md exists, and OPEN_QUESTIONS.md has no unresolved P0/P1 items.
```

## Migration loop

Use when you are moving a pattern across several files and want the loop to keep going until the migration lands.

```yaml
---
commands:
  - name: build
    run: npm run build
    timeout: 60
  - name: tests
    run: npm test
    timeout: 120
max_iterations: 30
completion_promise: DONE
completion_gate: required
required_outputs:
  - MIGRATION_NOTES.md
  - OPEN_QUESTIONS.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
---
```

Focus on one module or one pattern per iteration. Keep the prompt specific so the loop can make visible progress every pass.
Stop with <promise>DONE</promise> only when the build and tests pass, MIGRATION_NOTES.md exists, and OPEN_QUESTIONS.md has no unresolved P0/P1 items.

## Research loop

Use when the goal is to gather evidence and write it down.

```yaml
---
commands:
  - name: inspect
    run: git log --oneline -10
    timeout: 20
max_iterations: 20
completion_promise: DONE
completion_gate: optional
required_outputs:
  - REPORT.md
stop_on_error: false
---
```

Tell the agent what to measure, what to compare, and where to write the findings.

## Security loop

Use when the task is about reducing risk or auditing dangerous paths.

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 120
max_iterations: 20
completion_promise: DONE
completion_gate: required
required_outputs:
  - SECURITY_FINDINGS.md
  - OPEN_QUESTIONS.md
stop_on_error: true
guardrails:
  block_commands:
    - 'git\s+push'
    - 'npm\s+publish'
  protected_files:
    - '.env*'
    - '*.pem'
    - '*.key'
    - 'policy:secret-bearing-paths'
---
```

Keep the prompt explicit about what counts as a finding, what evidence matters, and when the loop may stop.
Stop with <promise>DONE</promise> only when tests pass, SECURITY_FINDINGS.md exists, and OPEN_QUESTIONS.md has no unresolved P0/P1 items.

## Good completion-gate reminders

- Make the gate mode explicit in the prompt body.
- Use `required` when the loop should not stop until the deliverable exists.
- Use `optional` when the prompt should remind the agent about the gate without blocking the stop condition.
- Use `disabled` when the loop should ignore the gate entirely.
- Keep `required_outputs` short and concrete.
