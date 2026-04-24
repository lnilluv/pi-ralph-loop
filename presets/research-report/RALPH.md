---
max_iterations: 15
timeout: 180
commands:
  - name: repo-map
    run: find . -maxdepth 2 \( -path '*/node_modules' -o -path '*/node_modules/*' -o -path '*/.git' -o -path '*/.git/*' -o -path '*/dist' -o -path '*/dist/*' -o -path '*/build' -o -path '*/build/*' -o -path '*/coverage' -o -path '*/coverage/*' -o -path '*/.cache' -o -path '*/.cache/*' -o -path '*/.turbo' -o -path '*/.turbo/*' -o -path '*/vendor' -o -path '*/vendor/*' -o -path '*/.env*' -o -path '*/.npmrc' -o -path '*/.pypirc' -o -path '*/.netrc' -o -path '*/secrets' -o -path '*/secrets/*' -o -path '*/credentials' -o -path '*/credentials/*' -o -path '*/ops-secrets' -o -path '*/ops-secrets/*' -o -path '*/credentials-prod' -o -path '*/credentials-prod/*' -o -path '*/.aws' -o -path '*/.aws/*' -o -path '*/.ssh' -o -path '*/.ssh/*' -o -path '*/.gcloud' -o -path '*/.gcloud/*' -o -path '*/.azure' -o -path '*/.azure/*' -o -name '*.pem' -o -name '*.key' -o -name '*.asc' \) -prune -o -type f -print | sort | head -n 120
    timeout: 30
  - name: history
    run: git log --oneline -10
    timeout: 30
completion_promise: DONE
completion_gate: required
required_outputs:
  - RESEARCH_REPORT.md
  - OPEN_QUESTIONS.md
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
- Record unresolved P0/P1 items in OPEN_QUESTIONS.md.
- Capture open questions and confidence levels.

## Completion
Stop with <promise>DONE</promise> only when RESEARCH_REPORT.md exists and OPEN_QUESTIONS.md has no remaining P0/P1 items.
