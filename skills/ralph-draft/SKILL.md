---
name: ralph-draft
description: Use when turning a plain-language task into a RALPH.md or scaffolding a loop prompt. Covers task classification, bounded project detection, frontmatter generation, and guardrail selection.
---

# Draft a RALPH.md

Create an effective `RALPH.md` from a plain-language task description. Match the task to the shipped mode, inspect only the bounded repo signals the generator actually uses, and keep the prompt body aligned with what `/ralph-draft` emits today.

## Phase 1: Classify the task

The shipped classifier only produces four modes.

| Mode | Signals | Typical draft shape |
|---|---|---|
| **analysis** | `reverse engineer`, `analy[sz]e`, `understand`, `investigate`, `map`, `audit`, `explore` | read-only inspection, repo map, no edits |
| **fix** | `fix`, `debug`, `repair`, `failing test`, `flaky`, `failure`, `broken` | tests first, regression coverage, smallest fix |
| **migration** | `migrate`, `upgrade`, `convert`, `port`, `modernize` | targeted transformation, verify build/tests, one slice per iteration |
| **general** | fallback for everything else | smallest safe next step |

Do not invent extra categories such as docs, research, or security.

## Phase 2: Detect the project environment

Use only the bounded signals the shipped draft generator collects.

| Signal | What it detects | How to use it in the draft |
|---|---|---|
| Package manifest | `package.json` plus the package manager in use | If `scripts.test` or `scripts.lint` exist, surface those exact package scripts |
| Git repository | presence of `.git` | Include `git log --oneline -10` when available |
| Top-level context | a bounded root scan of directories/files | Summarize the top-level shape of the repo without recursing indefinitely |
| Secret filtering | secret-bearing names are excluded from the root scan | Do not mention filtered secret paths in the draft |

The deterministic baseline comes from these bounded repo signals only. The bounded repo-context snapshot is a strengthening input: it may add a small set of additional files via bounded sampling. Treat that extra context as guidance, not as proof of exhaustive repository discovery.

Keep the scan bounded. The shipped implementation only inspects the repo root, filters secret-bearing names, and keeps a small set of top-level dirs/files. It does not promise deep filesystem discovery or language-specific tooling beyond the detected package scripts.

## Phase 3: Generate frontmatter

Baseline drafts include the detected commands, iteration limit, timeout, and guardrails. `stop_on_error` defaults to `true` and is typically omitted from generated drafts unless it is `false`.

Baseline drafts do **not** automatically add `completion_promise`, `completion_gate`, or `required_outputs`.

### Baseline draft example

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 60
  - name: git-log
    run: git log --oneline -10
    timeout: 20
max_iterations: 25
timeout: 300
guardrails:
  block_commands:
    - 'git\s+push'
---
```

### Add completion gating manually when you want a hard stop

Only add these keys when the task needs an explicit stop condition:

```yaml
completion_promise: DONE
completion_gate: required
required_outputs:
  - ARCHITECTURE.md
```

`required` means the loop waits for three things before stopping:

1. The promise is emitted
2. Every file in `required_outputs` exists
3. `OPEN_QUESTIONS.md` is ready to stop, meaning it has no remaining P0/P1 items

If `RALPH_PROGRESS.md` is listed in `required_outputs`, it is ignored and does not block completion.

Use `optional` when you want the prompt to remind the agent about outputs and `OPEN_QUESTIONS.md`, but you still want the loop to stop on the promise alone. Use `disabled` when you want to suppress the gate reminders and checks entirely.

If you add a gate, include a short body section that names the stop condition explicitly:

```markdown
## Completion

Stop with <promise>DONE</promise> when ARCHITECTURE.md exists and OPEN_QUESTIONS.md has no remaining P0/P1 items.
```

## Phase 4: Write the prompt body

### What `/ralph-draft` emits today

The generated body is compact. It does **not** include the richer Orientation / Evidence / Rules / Completion scaffold below unless you add that manually.

#### Analysis mode

```markdown
Task: Reverse engineer this app

Recent git history:
{{ commands.git-log }}

Latest repo-map output:
{{ commands.repo-map }}

Start with read-only inspection. Avoid edits and commits until you have a clear plan.
Map the architecture, identify entry points, and summarize the important moving parts.
End each iteration with concrete findings, open questions, and the next files to inspect.
Iteration {{ ralph.iteration }} of {{ ralph.name }}.
```

#### Fix mode

```markdown
Task: Fix the failing auth tests

Latest tests output:
{{ commands.tests }}

Latest lint output:
{{ commands.lint }}

Recent git history:
{{ commands.git-log }}

If tests or lint are failing, fix those failures before starting new work.
Prefer concrete, verifiable progress. Explain why your change works.
Iteration {{ ralph.iteration }} of {{ ralph.name }}.
```

#### Migration / general modes

```markdown
Task: Migrate the auth flow to v2

Latest tests output:
{{ commands.tests }}

Latest lint output:
{{ commands.lint }}

Recent git history:
{{ commands.git-log }}

Make the smallest safe change that moves the task forward.
Prefer concrete, verifiable progress. Explain why your change works.
Iteration {{ ralph.iteration }} of {{ ralph.name }}.
```

Notes:

- The command sections are plain label-plus-placeholder blocks.
- `git-log` is rendered as `Recent git history`; every other command is rendered as `Latest <command> output`.
- If the generator falls back to `repo-map`, the label is `Latest repo-map output:`.
- The current body does not add separate evidence, rules, or completion sections automatically.

### Manual enhancement guidance, not generator output

If you want a richer hand-authored prompt, you can layer it on top of the shipped baseline. Keep the manual guidance clearly labeled so it does not read like emitted output.

A practical enhancement shape is:

```markdown
## Orientation

You are an autonomous coding agent running in a loop.
Each iteration starts with a fresh context.
Your progress lives in the code and git history.

## Evidence

{{ commands.tests }}
{{ commands.git-log }}

## Task

Pick the top-priority issue and fix it.
Write a regression test that proves the fix.

## Rules

- One task per iteration
- No placeholder code
- Descriptive commit messages

## Completion

Stop with <promise>DONE</promise> when the required outputs exist and OPEN_QUESTIONS.md is ready.
```

Use that only as an enhancement path. It is not what the current generator emits.

## Phase 5: Assemble and present

1. Create the task directory
2. Write `RALPH.md`
3. Add any helper files the task needs
4. Present the draft for review before starting

Tell the user:
- What mode you detected
- Which commands you included and why
- Which guardrails you set and why
- What the completion criteria are, if you added them

## Quick examples

- `/ralph-draft "reverse engineer this app"` → analysis
- `/ralph-draft "fix the failing auth tests"` → fix
- `/ralph-draft "migrate the auth flow to v2"` → migration
- `/ralph-draft "draft a release note"` → general
