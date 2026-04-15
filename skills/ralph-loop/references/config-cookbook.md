# Config Cookbook

Frontmatter recipes for common scenarios. Copy, adjust, and run.

## Minimal loop

The simplest useful loop. Just a prompt and a max.

```yaml
---
max_iterations: 10
---
Read TODO.md and implement the next task.
Commit when done.
```

When to use: Quick tasks where you trust the agent to know when it's done, or you'll stop it manually with `/ralph-stop`.

## Self-healing loop

The workhorse pattern. Commands feed evidence, the completion gate stops the loop.

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 60
  - name: git-log
    run: git log --oneline -10
max_iterations: 20
completion_promise: DONE
guardrails:
  block_commands:
    - 'git\s+push'
---

Fix the failing auth tests for {{ args.owner }}.

{{ commands.tests }}

{{ commands.git-log }}

If tests are failing, fix them before starting new work.
Stop with <promise>DONE</promise> when all tests pass.
```

When to use: Bug fixing, test writing, any task where command output shows current state.

## Gated completion loop

Adds `required_outputs` to the completion gate. The loop won't stop until both the promise appears AND the files exist.

```yaml
---
commands:
  - name: build
    run: npm run build
    timeout: 60
  - name: tests
    run: npm test
    timeout: 120
max_iterations: 25
completion_promise: DONE
required_outputs:
  - MIGRATION_NOTES.md
---

Migrate one module per iteration from the legacy API to the new one.

{{ commands.build }}

{{ commands.tests }}

Stop with <promise>DONE</promise> only when all tests pass
and MIGRATION_NOTES.md exists with a summary of changes.
```

When to use: Migration, documentation, research — any task where "done" means a deliverable file exists, not just that the agent says it's done.

## Resilient loop

Continues past errors. Use when individual iterations may fail but the overall task should keep going.

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 120
  - name: lint
    run: npm run lint
    timeout: 30
max_iterations: 30
completion_promise: DONE
stop_on_error: false
required_outputs:
  - REFACTOR_LOG.md
---

Refactor one module per iteration.

{{ commands.tests }}

{{ commands.lint }}

If an iteration fails, note it in REFACTOR_LOG.md and move to the next module.
Stop with <promise>DONE</promise> when REFACTOR_LOG.md covers all modules.
```

When to use: Migration across many files, batch operations where some items may fail, long-running tasks that need resilience.

## Parameterized loop

Accepts runtime arguments via `--arg`. Makes the loop reusable across different targets.

```yaml
---
args:
  - env
  - target
commands:
  - name: tests
    run: npm test -- --env={{ args.env }}
    timeout: 120
  - name: coverage
    run: npm run test:coverage -- --env={{ args.env }}
    timeout: 120
max_iterations: 15
completion_promise: DONE
guardrails:
  protected_files:
    - 'policy:secret-bearing-paths'
---

Environment: {{ args.env }}
Target: {{ args.target }}

{{ commands.tests }}

{{ commands.coverage }}

Increase test coverage for {{ args.target }}.
Stop with <promise>DONE</promise> when coverage exceeds 80%.
```

Run with: `/ralph --path my-task --arg env=staging --arg target="src/auth"`

When to use: Reusable loops for different environments, targets, or configurations.

## Security audit loop

Strict guardrails with evidence-driven improvement.

```yaml
---
commands:
  - name: scan
    run: npm audit --audit-level=moderate
    timeout: 60
  - name: tests
    run: npm test
    timeout: 120
  - name: git-log
    run: git log --oneline -10
max_iterations: 20
completion_promise: DONE
required_outputs:
  - SECURITY_FINDINGS.md
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

Find and fix security vulnerabilities.

{{ commands.scan }}

{{ commands.tests }}

{{ commands.git-log }}

Pick one finding and fix it.
Log everything in SECURITY_FINDINGS.md.
Stop with <promise>DONE</promise> when the scan is clean and SECURITY_FINDINGS.md is complete.
```

When to use: Security audits, compliance checks, any task that handles sensitive data.

## Research loop

Long timeout, minimal commands, progress lives in files.

```yaml
---
commands:
  - name: git-log
    run: git log --oneline -15
max_iterations: 20
timeout: 300
completion_promise: DONE
required_outputs:
  - REPORT.md
---

Build a comprehensive research report on {{ args.topic }}.

{{ commands.git-log }}

Each iteration:
1. Read REPORT.md to see what exists
2. Identify the weakest section
3. Research and write findings
4. Commit your changes

Stop with <promise>DONE</promise> when REPORT.md exists
and all referenced sections have substantial content.
```

When to use: Deep research, documentation generation, knowledge base construction.

## High-autonomy loop

Trust the agent, minimize constraints. Use when you've verified the loop works correctly and want it to run freely.

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 120
  - name: git-log
    run: git log --oneline -10
max_iterations: 50
completion_promise: DONE
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
---

{{ commands.tests }}

{{ commands.git-log }}

Read TODO.md and implement the next task.
Stop with <promise>DONE</promise> when all items are complete.
```

When to use: Long autonomous runs where you want maximum flexibility. Always keep at least `git push` blocked.

## Low-autonomy loop

Strict constraints, stop on any error. Use when exploring or when mistakes are costly.

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 60
  - name: lint
    run: npm run lint
    timeout: 30
max_iterations: 10
completion_promise: DONE
stop_on_error: true
guardrails:
  block_commands:
    - 'git\s+push'
    - 'npm\s+publish'
    - 'rm\s+-rf'
  protected_files:
    - '.env*'
    - '*.pem'
    - '*.key'
    - 'config/production.*'
    - 'policy:secret-bearing-paths'
---

Carefully improve one thing per iteration.

{{ commands.test }}

{{ commands.lint }}

If anything is broken, fix it before doing anything else.
Stop with <promise>DONE</promise> when all tests and lint pass.
```

When to use: Sensitive codebases, production-adjacent work, first loops on a new project.

## Choosing stop_on_error

| Value | Behavior | When to use |
|---|---|---|
| `true` (default) | Stop on any RPC error or timeout | Bug fixing, single-target tasks, cautious loops |
| `false` | Continue past errors | Migration, batch operations, research, long autonomous runs |

## Choosing guardrails

| Guardrail | What it blocks | When to use |
|---|---|---|
| `git\s+push` | Pushes to remote | Almost always — prevents accidental publishes |
| `npm\s+publish` | Package publishes | When working on published packages |
| `rm\s+-rf\s+/` | Destructive root deletes | Always worth including |
| `.env*` | Environment files | Any task touching config or deployment |
| `*.pem`, `*.key` | Certificate and key files | Security-related tasks |
| `policy:secret-bearing-paths` | All secret-bearing paths | Default good practice |

## Choosing required_outputs

| Scenario | required_outputs |
|---|---|
| Bug fixing | None — test pass is sufficient |
| Migration | `[MIGRATION_NOTES.md]` — deliverable summary |
| Documentation | `[DOCS_INDEX.md]` — proof of coverage |
| Security audit | `[SECURITY_FINDINGS.md]` — audit deliverable |
| Research | `[REPORT.md]` — final synthesis |
| Test coverage | None — coverage command shows progress |