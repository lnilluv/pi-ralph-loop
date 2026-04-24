---
max_iterations: 15
timeout: 180
commands:
  - name: repo-map
    run: find . -maxdepth 2 -type f | sort | head -n 120
    timeout: 30
  - name: history
    run: git log --oneline -10
    timeout: 30
completion_promise: DONE
completion_gate: required
required_outputs:
  - RESEARCH_REPORT.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - 'policy:secret-bearing-paths'
---
# {{ ralph.name }}

You are building a concise research report.

## Evidence
- Repository map:
  {{ commands.repo-map }}
- Recent history:
  {{ commands.history }}

## Task
- Identify the important signals.
- Write the report in RESEARCH_REPORT.md.
- Capture open questions and confidence levels.

## Completion
Stop with <promise>DONE</promise> only when the report is complete.
