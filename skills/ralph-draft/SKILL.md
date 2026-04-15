---
name: ralph-draft
description: Use when creating a RALPH.md from a plain-language task description. Covers task classification, project detection, frontmatter generation, and guardrail selection.
---

# Draft a RALPH.md

Create an effective RALPH.md from a plain-language task description. This skill covers how to classify the task, detect the project environment, generate appropriate frontmatter, and write an effective prompt body.

## Phase 1: Classify the task

Map the user's description to a task category. Each category has different needs.

| Category | Signals | Default settings |
|---|---|---|
| **fix** | "bug", "broken", "failing", "error", "crash" | `stop_on_error: true`, test commands, completion promise |
| **test** | "coverage", "tests", "unit test", "integration" | `stop_on_error: true`, coverage commands, completion promise |
| **migrate** | "migrate", "upgrade", "refactor", "convert" | `stop_on_error: false`, build + test commands, required_outputs |
| **docs** | "document", "readme", "docs", "explain" | `stop_on_error: false`, build commands, required_outputs |
| **research** | "research", "investigate", "analyze", "audit" | `stop_on_error: false`, minimal commands, required_outputs |
| **security** | "security", "vulnerability", "audit", "cve" | `stop_on_error: true`, strict guardrails, required_outputs |
| **general** | anything else | `stop_on_error: true`, basic commands |

## Phase 2: Detect the project environment

Scan the project directory for signals. Use these to pick appropriate commands.

| Signal | Detection | Implication |
|---|---|---|
| Node.js | `package.json` exists | `npm test`, `npm run build`, `npm run lint` |
| Python | `pyproject.toml` or `setup.py` | `pytest`, `ruff check .`, `mypy .` |
| Go | `go.mod` exists | `go test ./...`, `go vet ./...` |
| Rust | `Cargo.toml` exists | `cargo test`, `cargo clippy` |
| Tests present | `__tests__/`, `tests/`, `*_test.*`, `*.test.*` | Include test command |
| Linter config | `.eslintrc*`, `ruff.toml`, `.golangci.yml` | Include lint command |
| CI config | `.github/workflows/`, `.gitlab-ci.yml` | Read CI to find test/lint commands |
| TODO/PLAN file | `TODO.md`, `PLAN.md`, `BUGS.md` exists | Use as task source |

Always include `git log --oneline -10` as a command. It gives the agent iteration-over-iteration memory.

## Phase 3: Generate frontmatter

### Tasks by category

#### fix / test

```yaml
---
commands:
  - name: tests
    run: <detected-test-command>
    timeout: 60
  - name: git-log
    run: git log --oneline -10
max_iterations: 20
completion_promise: DONE
guardrails:
  block_commands:
    - 'git\s+push'
---
```

#### migrate

```yaml
---
commands:
  - name: build
    run: <detected-build-command>
    timeout: 60
  - name: tests
    run: <detected-test-command>
    timeout: 120
  - name: git-log
    run: git log --oneline -10
max_iterations: 30
completion_promise: DONE
required_outputs:
  - MIGRATION_NOTES.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
---
```

#### docs

```yaml
---
commands:
  - name: build
    run: <detected-build-command>
    timeout: 60
  - name: git-log
    run: git log --oneline -10
max_iterations: 15
completion_promise: DONE
required_outputs:
  - DOCS_INDEX.md
stop_on_error: false
---
```

#### research

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
```

#### security

```yaml
---
commands:
  - name: scan
    run: <detected-security-scanner>
    timeout: 60
  - name: tests
    run: <detected-test-command>
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
```

## Phase 4: Write the prompt body

Follow the five-section structure:

### Orientation (always include)

```markdown
You are an autonomous coding agent running in a loop.
Each iteration starts with a fresh context.
Your progress lives in the code and git history.
```

### Evidence (include detected commands)

```markdown
## Test results

{{ commands.tests }}

## Recent commits

{{ commands.git-log }}

If tests are failing, fix them before starting new work.
```

### Task (one thing per iteration)

For **fix/test** tasks:
```markdown
Pick the top-priority issue and fix it.
Write a regression test that proves the fix.
Commit with `fix: resolve <description>`.
```

For **migrate** tasks:
```markdown
Read MIGRATION_TODO.md and pick the first incomplete item.
Migrate that one file or pattern.
Verify the build and tests pass.
Mark it complete and commit.
```

For **research** tasks:
```markdown
Read REPORT.md to see what exists.
Identify the weakest section.
Research and write detailed findings.
Commit your changes.
```

### Rules (task-specific constraints)

Common rules for all tasks:
- One task per iteration
- No placeholder code
- Descriptive commit messages

Additional rules by category:

| Category | Extra rules |
|---|---|
| fix | Always write a regression test before fixing |
| test | Cover edge cases, not just happy paths |
| migrate | Only change behavior for the migration pattern |
| docs | Include working code examples |
| security | Never suppress warnings — fix root causes |
| research | Cite sources, don't fabricate references |

### Completion (explicit stop condition)

Always include both `completion_promise` in frontmatter AND a completion section in the body:

```markdown
## Completion

Stop with <promise>DONE</promise> when <specific condition>.
```

Match the condition to `required_outputs` if you set them.

## Phase 5: Assemble and present

1. Create the task directory (e.g., `fix-auth-tests/`)
2. Write `RALPH.md` with the generated frontmatter and body
3. If a task source file is needed (TODO.md, BUGS.md), create it
4. Present to the user for review before starting

Tell the user:
- What task category you detected
- What commands you included and why
- What guardrails you set and why
- What the completion criteria are

## Guardrail selection guide

| Task type | block_commands | protected_files | stop_on_error |
|---|---|---|---|
| fix | `git push` | none | true |
| test | `git push` | none | true |
| migrate | `git push` | none | false |
| docs | `git push` | none | false |
| research | none | none | false |
| security | `git push`, `npm publish` | `.env*`, `*.pem`, `*.key`, `policy:secret-bearing-paths` | true |

Always block `git push` unless the task explicitly needs it. Always protect secret-bearing paths for security tasks.

## Quick templates

### From plain language

```
/ralph "fix the failing auth tests"
```

→ Classifies as **fix**, detects test framework, generates appropriate frontmatter.

### From existing folder

```
/ralph --path ./my-task --arg env=staging
```

→ Uses the RALPH.md that already exists in `./my-task/`.

### From scaffold

```
/ralph-scaffold my-task
```

→ Creates `my-task/RALPH.md` with a starter template. Edit it, then run with `/ralph --path my-task`.