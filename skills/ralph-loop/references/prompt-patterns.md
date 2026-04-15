# Prompt Patterns

Detailed patterns for writing effective RALPH.md prompts. Each pattern includes the structure, when to use it, and a fully annotated example.

## The five-section structure

Every effective prompt follows the same skeleton:

```markdown
---
frontmatter
---

## Orientation
Who you are and how the loop works.

## Evidence
{{ commands.* }} — current state.

## Task
One specific thing to do this iteration.

## Rules
Constraints on what you can and can't do.

## Completion
When to stop and what <promise>DONE</promise> means.
```

Not every section needs a heading. Short prompts fold rules into the task. But every effective prompt addresses all five.

## Pattern: Self-healing test loop

The most common pattern. Run tests, see failures, fix them, verify. The command output is both evidence and a natural stopping signal.

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

You are an autonomous coding agent running in a loop.
Each iteration starts with a fresh context.
Your progress lives in the code and git history.

## Test results

{{ commands.tests }}

## Recent commits

{{ commands.git-log }}

If tests are failing, fix them before starting new work.
Then pick the next task from TODO.md.

## Rules

- One task per iteration
- No placeholder code — full, working implementations only
- Run tests before committing
- Commit with descriptive messages: `fix: ...`, `feat: ...`, `test: ...`

## Completion

Stop with <promise>DONE</promise> when all tests pass and TODO.md has no remaining items.
```

**Why it works:**
- `tests` command gives the agent live evidence each iteration
- `git-log` command reminds the agent what it already did
- `completion_promise: DONE` gives a clear stop signal
- `guardrails` prevents accidental pushes

## Pattern: Ordered task list

When work can be decomposed into a checklist. The agent works through items one at a time, marking them done.

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
required_outputs:
  - MIGRATION_NOTES.md
stop_on_error: false
---

You are migrating from REST to GraphQL. Work through MIGRATION_TODO.md one item at a time.

## Build

{{ commands.build }}

## Tests

{{ commands.tests }}

If the build fails or tests fail, fix the issue before continuing migration.

## Each iteration

1. Read MIGRATION_TODO.md, pick the first incomplete item
2. Migrate that one endpoint
3. Verify the build passes and tests pass
4. Mark the item complete in MIGRATION_TODO.md
5. Commit: `refactor: migrate <endpoint> from REST to GraphQL`

## Completion

Stop with <promise>DONE</promise> when MIGRATION_TODO.md has no remaining items AND MIGRATION_NOTES.md exists with a summary of all changes.
```

**Why it works:**
- `stop_on_error: false` — migration often has transient failures; the loop should keep going
- `required_outputs` gates completion on an actual deliverable file
- The task list in MIGRATION_TODO.md is the progress memory

## Pattern: Evidence-driven improvement

When there's no fixed checklist — the agent discovers what to improve from running commands.

```yaml
---
commands:
  - name: tests
    run: uv run pytest -x
    timeout: 120
  - name: coverage
    run: uv run pytest --cov=src --cov-report=term-missing -q
    timeout: 120
  - name: git-log
    run: git log --oneline -10
max_iterations: 15
completion_promise: DONE
args:
  - target
---

You are increasing test coverage for {{ args.target }}.

## Coverage report

{{ commands.coverage }}

## Test results

{{ commands.tests }}

## Recent commits

{{ commands.git-log }}

Pick the module with the most missing lines from the coverage report.
Read the source code, understand what it does, and write thorough tests.
Commit with `test: add coverage for <module>`.

## Rules

- One module per iteration
- Write tests that verify behavior, not just hit lines
- All existing tests must still pass
- Do not add `# pragma: no cover` comments

## Completion

Stop with <promise>DONE</promise> when coverage for {{ args.target }} exceeds 80%.
```

**Why it works:**
- Two evidence commands give the agent both test results and coverage data
- `args.target` makes the loop reusable for different modules
- The coverage report naturally focuses the agent on the biggest gap

## Pattern: Research and synthesis

For tasks that produce a document rather than code. The loop writes files, and `required_outputs` gates completion.

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

You are a research agent building a comprehensive report.

## Recent changes

{{ commands.git-log }}

## Each iteration

1. Read REPORT.md to see what exists
2. Identify the weakest or most incomplete section
3. Research the topic using available tools
4. Write detailed findings into the appropriate section
5. Update the report outline if needed

## Rules

- Write to REPORT.md and section files in research/
- One section per iteration
- Cite sources with URLs
- Do not fabricate references

## Completion

Stop with <promise>DONE</promise> when REPORT.md exists and all sections referenced in its table of contents have corresponding files with substantial content (>500 words each).
```

**Why it works:**
- `timeout: 300` — research iterations need more time
- `required_outputs: [REPORT.md]` — completion gated on the deliverable
- Minimal commands — the agent does its own research each iteration
- Progress lives in the files, not in commands

## Pattern: Security audit

Strict guardrails with self-healing.

```yaml
---
commands:
  - name: scan
    run: npx audit-ci --moderate
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

You are a security auditor. Find and fix vulnerabilities.

## Vulnerability scan

{{ commands.scan }}

## Test results

{{ commands.tests }}

## Recent commits

{{ commands.git-log }}

If tests are failing, fix them before addressing security findings.

## Each iteration

1. Review the vulnerability scan above
2. Pick one finding
3. Fix the underlying issue (do not suppress warnings)
4. Verify tests still pass
5. Log the finding in SECURITY_FINDINGS.md with: severity, location, description, resolution

## Rules

- One finding per iteration
- Fix root causes, never suppress warnings
- Never modify .env, .pem, or .key files
- Commit with `security: fix <description>`

## Completion

Stop with <promise>DONE</promise> when SECURITY_FINDINGS.md exists and the vulnerability scan reports no moderate or high issues.
```

**Why it works:**
- Heavy guardrails — this is a security task, block pushes and protect secrets
- `policy:secret-bearing-paths` as a catch-all for credential files
- `required_outputs` gates on the audit deliverable
- Self-healing: if code changes break tests, fix those first

## Anti-patterns to avoid

### Vague goals

```markdown
# Bad
Improve the codebase.

# Good
Find the module with the lowest test coverage and write tests for it.
```

### Missing evidence

```markdown
# Bad — no commands, the agent is blind
---
max_iterations: 10
---
Fix the failing tests.

# Good — agent sees current state each iteration
---
commands:
  - name: tests
    run: npm test
    timeout: 60
---
{{ commands.tests }}

Fix the failing tests.
```

### No completion criteria

```markdown
# Bad — the loop never knows when it's done
---
max_iterations: 20
---
Write tests until coverage is good.

# Good — explicit completion gate
---
max_iterations: 20
completion_promise: DONE
required_outputs:
  - COVERAGE_REPORT.md
---
Stop with <promise>DONE</promise> when all tests pass
and COVERAGE_REPORT.md exists.
```

### Too many tasks per iteration

```markdown
# Bad — the agent tries to do everything at once
Fix all the bugs, write docs, and refactor the API.

# Good — one thing per iteration
Pick the highest-priority bug from BUGS.md and fix it.
Write a regression test that proves the fix.
```

### Missing progress memory

Without RALPH_PROGRESS.md, the agent re-does work across iterations. Add a section:

```markdown
## Progress

At the end of each iteration, append a one-line summary to RALPH_PROGRESS.md:
- What you did
- What files changed
- What still needs doing
```

### Walls of text

Keep prompts under 200 lines. The loop re-reads the entire prompt every iteration. Long prompts waste context window and dilute focus. If you're writing a novel, you're overthinking it.

## Command selection guide

| What you're measuring | Command to use |
|---|---|
| Test results | `npm test`, `pytest`, `go test ./...` |
| Type checking | `tsc --noEmit`, `mypy .`, `go vet ./...` |
| Linting | `eslint .`, `ruff check .`, `golangci-lint run` |
| Build status | `npm run build`, `cargo build`, `go build ./...` |
| Coverage | `pytest --cov`, `go test -cover` |
| Git history | `git log --oneline -10` |
| Changed files | `git diff --name-only HEAD~5` |
| Vulnerability scan | `npm audit`, `bandit -r src/` |
| Custom metrics | `./scripts/check-coverage.sh` |

Commands starting with `./` run from the task directory. Others run from the project root.