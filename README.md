# pi-ralph-loop

Autonomous coding loops for [pi](https://github.com/mariozechner/pi-coding-agent).

Describe what you want done. The loop runs your agent, re-reads the task, feeds fresh command output every iteration, and stops when the work is finished — or when you tell it to stop.

```
/ralph "fix the flaky auth tests"
```

## Why loops

A single agent run can fix a bug. But the real leverage is **sustained, autonomous work** — campaigns that run for hours, making progress one commit at a time while you do something else.

| Without a loop | With a loop |
|---|---|
| Run an agent once, hope it finishes | Re-run until the work is done |
| Copy-paste test output back into chat | Commands feed fresh evidence each iteration |
| Watch the terminal and Ctrl+C when bored | Completion gating stops when the goal is met |
| One long context that gets stale | Fresh context every iteration |
| No guardrails — agent can push to main or delete secrets | Block commands, protect files, confine paths |

People use ralph loops for:

| Task | How the loop helps |
|---|---|
| Grow test coverage | Run the suite each iteration, only commit when coverage increases |
| Fix flaky tests | Run tests, find failures, fix, verify, repeat |
| Migrate a codebase | Transform one module per iteration, keep the build green |
| Write documentation | Check for doc build warnings, fix them, commit |
| Security audit | Scan for vulnerabilities, fix them, verify |
| Deep research | Write findings to files, iterate until the report is complete |

## Install

```bash
pi install npm:@lnilluv/pi-ralph-loop
```

## Quick start

### From plain language

Draft and run in one command:

```
/ralph "fix the failing auth tests"
```

Draft only:

```
/ralph-draft "fix the failing auth tests"
```

The extension creates a `RALPH.md` draft and shows it for review. Edit, start, or cancel.

### With an existing task folder

```
/ralph --path ./my-task --arg owner="Ada"
```

### From a scaffold

```
/ralph-scaffold my-task
```

Creates `my-task/RALPH.md` with a starter template — edit it, then run with `/ralph --path my-task`.

### What a run looks like

```
▶ Ralph loop started: my-task (max 20 iterations)

── Iteration 1 ──
  Commands: 2 ran (tests, verify)
  ✗ auth/login.test.ts — 2 failures
✓ Iteration 1 completed (48.2s)

── Iteration 2 ──
  Commands: 2 ran
  ✓ All tests passing
✓ Iteration 2 completed (23.1s)

Ralph loop complete: completion promise matched on iteration 2 (71s total)
```

## The task folder

```
my-task/
├── RALPH.md               ← the prompt (required)
├── check-coverage.sh      ← helper script (optional)
├── testing-conventions.md ← reference doc (optional)
├── RALPH_PROGRESS.md      ← rolling memory (auto-managed)
├── .ralph-runner/         ← live run state (auto-managed)
│   ├── status.json
│   ├── iterations.jsonl
│   ├── events.jsonl
│   └── transcripts/
└── .ralph-runner-archive/ ← archived run state (auto-managed)
    └── <ISO>/
```

Put scripts, reference docs, and data files alongside `RALPH.md`. The agent can read them every iteration. `RALPH_PROGRESS.md` is injected as rolling memory — the loop reads and writes it between iterations. Archived runs move `.ralph-runner/` into `.ralph-runner-archive/<ISO>/`.

## RALPH.md format

YAML header (configuration) + Markdown body (the prompt). The header uses `snake_case` keys.

```yaml
---
args:
  - owner
commands:
  - name: tests
    run: npm test
    timeout: 60
  - name: verify
    run: ./scripts/verify.sh
    timeout: 60
max_iterations: 20
timeout: 120
completion_promise: DONE
completion_gate: required
required_outputs:
  - AUTH_FIXES.md
stop_on_error: false
guardrails:
  block_commands:
    - 'git\s+push'
  protected_files:
    - '.env*'
    - 'policy:secret-bearing-paths'
---

Fix the failing auth tests for {{ args.owner }}.

## Current test results

{{ commands.tests }}

## Verification

{{ commands.verify }}

Stop with <promise>DONE</promise> only when all tests pass, AUTH_FIXES.md exists, and OPEN_QUESTIONS.md has no remaining P0/P1 items.
```

### Frontmatter reference

| YAML key | Type | Default | Description |
|---|---|---|---|
| `commands` | CommandDef[] | `[]` | Shell commands run each iteration. Each: `name`, `run`, `timeout` (1–300s, default 60) |
| `args` | string[] | `[]` | Declared runtime parameters for `--arg name=value` |
| `max_iterations` | integer | `50` | 1–50 |
| `inter_iteration_delay` | integer | `0` | Seconds between iterations |
| `items_per_iteration` | integer | — | Pacing cap for each iteration. Valid values: 1–20 |
| `reflect_every` | integer | — | Reflection cadence. Valid values: 2–20 |
| `timeout` | integer | `300` | 1–300 seconds per iteration |
| `completion_promise` | string | — | Done marker. Single line, no `<>` or line breaks |
| `completion_gate` | `required` \| `optional` \| `disabled` | `required` when `completion_promise` is set | Controls whether the promise, required outputs, and OPEN_QUESTIONS.md readiness block stopping |
| `required_outputs` | string[] | `[]` | Relative file paths that must exist for early stop |
| `stop_on_error` | boolean | `true` | `false` continues past RPC errors and timeouts |
| `guardrails.block_commands` | string[] | `[]` | Default shell blocklist. Matching bash commands are blocked |
| `guardrails.protected_files` | string[] | `[]` | Glob patterns + `policy:secret-bearing-paths` |
| `guardrails.shell_policy` | object | — | Optional shell allowlist. Use only when you want to permit specific bash commands; `mode: allowlist` requires `allow` |

### Pacing controls

Use these to slow the loop down or add periodic self-checks:

```yaml
items_per_iteration: 3
reflect_every: 4
```

`items_per_iteration` adds a short constraint section on every iteration. `reflect_every` adds a reflection request on iterations 4, 8, 12, ...

### Body placeholders

| Placeholder | Resolves to |
|---|---|
| `{{ commands.NAME }}` | Output of the named command |
| `{{ args.NAME }}` | Value of the named runtime arg |
| `{{ ralph.iteration }}` | Current iteration number |
| `{{ ralph.name }}` | Task directory basename |
| `{{ ralph.max_iterations }}` | Current max iterations |

Commands starting with `./` run from the task directory. Others run from the project root. Blocked commands produce `[blocked by guardrail: PATTERN]`. Timed-out commands produce `[timed out after Ns]`.

## Commands

| Command | What it does |
|---|---|
| `/ralph [path-or-task]` | Start or draft+start a loop |
| `/ralph-draft [path-or-task]` | Create or edit a draft without starting |
| `/ralph-list` | List active loops |
| `/ralph-status [path]` | Show durable status and the latest iteration summary |
| `/ralph-resume <path>` | Start a new run from an existing `RALPH.md` |
| `/ralph-archive <path>` | Move `.ralph-runner/` into `.ralph-runner-archive/<ISO>/` |
| `/ralph-stop [path-or-task]` | Finish current iteration, then stop |
| `/ralph-cancel [path-or-task]` | Kill the current iteration immediately |
| `/ralph-scaffold [--preset <name>] <name-or-path>` | Create a starter `RALPH.md` template |
| `/ralph-logs [--path] [--dest]` | Export run artifacts to a directory |

### Argument passing

`--arg name=value` is only valid with `--path` to an existing `RALPH.md`:

```
/ralph --path ./my-task --arg owner="Ada" --arg env=staging
```

`/ralph-draft`, `/ralph-stop [path-or-task]`, and `/ralph-cancel [path-or-task]` reject `--arg`. Names must match `^\w[\w-]*$` and be declared in `args`.

### Stopping

| Action | Behavior |
|---|---|
| `/ralph-stop [path-or-task]` | Finish current iteration, then stop |
| `/ralph-cancel [path-or-task]` | Kill the current iteration immediately |
| Completion promise + gate | Stop when the promise is matched; only `required` gates also wait for `required_outputs` and OPEN_QUESTIONS.md readiness |
| Max iterations reached | Stop after the last iteration |
| No progress for all iterations | Stop with `no-progress-exhaustion` |

## Completion gating

`completion_gate` controls how strictly the loop treats completion promises:

| Mode | Behavior |
|---|---|
| `required` | Default when `completion_promise` is set. The loop waits for the promise, every file in `required_outputs`, and an OPEN_QUESTIONS.md that is ready to stop (no remaining P0/P1 items). |
| `optional` | The prompt still reminds the agent about outputs and OPEN_QUESTIONS.md readiness, but the loop may stop once the promise is emitted. |
| `disabled` | The loop skips completion-gate reminders and checks. |

In `optional` and `disabled` mode, `complete` means the promise was matched; those modes do not block on `required_outputs` or OPEN_QUESTIONS.md readiness.

When the gate is `required`, completion still needs **all three** conditions:

1. The agent emits `<promise>DONE</promise>` (or whatever marker you set)
2. Every file in `required_outputs` exists on disk
3. `OPEN_QUESTIONS.md` is ready to stop, meaning it has no remaining P0/P1 items

If the promise is seen but files or OPEN_QUESTIONS.md are not ready, the loop continues — the next iteration gets a rejection notice telling the agent what still needs to be fixed.

`RALPH_PROGRESS.md` is injected as rolling memory (max 4096 chars) and excluded from the `required_outputs` gate.

## Guardrails

### Block commands

Regex patterns matched against the full bash command. If any pattern matches, the command is blocked:

```yaml
guardrails:
  block_commands:
    - 'git\s+push'
    - 'rm\s+-rf\s+/'
```

### Protect files

Glob patterns matched against file paths. Blocks `write` and `edit` tool calls:

```yaml
guardrails:
  protected_files:
    - '.env*'
    - '*.pem'
    - 'policy:secret-bearing-paths'
```

`policy:secret-bearing-paths` is a built-in policy that blocks `.aws/`, `.ssh/`, `secrets/`, `.npmrc`, `.pem`, `.key`, and other secret-bearing paths.

### Shell allowlist

Use `shell_policy` only when you want to allow a narrow set of bash commands. The allowlist is checked before `block_commands`. If a command does not match any allow regex, it is blocked with `[blocked by guardrail: shell_policy.allowlist]`.

```yaml
guardrails:
  shell_policy:
    mode: allowlist
    allow:
      - '^npm test$'
      - '^npm run lint$'
```

You can omit `shell_policy` entirely unless you need an allowlist.

## Common patterns

### Minimal loop

```yaml
---
max_iterations: 10
---
Read TODO.md and implement the next task. Commit when done.
```

### Self-healing with test feedback

```yaml
---
commands:
  - name: tests
    run: npm test
    timeout: 60
max_iterations: 20
completion_promise: DONE
---

{{ commands.tests }}

Fix failing tests before starting new work.
Read TODO.md and implement the next task.
Stop with <promise>DONE</promise> when all tests pass and OPEN_QUESTIONS.md has no remaining P0/P1 items.
```

### Parameterized multi-env loop

```yaml
---
args:
  - env
  - focus
commands:
  - name: tests
    run: npm test -- --env={{ args.env }}
    timeout: 120
max_iterations: 15
guardrails:
  protected_files:
    - 'policy:secret-bearing-paths'
---

Environment: {{ args.env }}
Focus: {{ args.focus }}

{{ commands.tests }}
```

Run: `/ralph --path my-task --arg env=staging --arg focus="auth"`

### Incremental migration

```yaml
---
commands:
  - name: build
    run: npm run build
    timeout: 60
  - name: tests
    run: npm test
    timeout: 120
required_outputs:
  - MIGRATION_NOTES.md
stop_on_error: false
max_iterations: 30
completion_promise: DONE
---

Migrate one module per iteration from the legacy API to the new one.

Build output:
{{ commands.build }}

Test results:
{{ commands.tests }}

Stop with <promise>DONE</promise> when MIGRATION_NOTES.md exists, all tests pass, and OPEN_QUESTIONS.md has no remaining P0/P1 items.
```

## Run state

`.ralph-runner/` is auto-created in the task directory. Everything the loop needs to resume, inspect, or export:

| File | Purpose |
|---|---|
| `status.json` | Current loop state (status, iteration, guardrails, timing) |
| `iterations.jsonl` | Append-only iteration records |
| `events.jsonl` | Append-only runner events (progress, gates, starts, finishes) |
| `transcripts/` | Per-iteration markdown transcripts |
| `active-loops/` | Registry of running loops (pruned after 30 minutes) |

### Log export

`/ralph-logs` copies `status.json`, `iterations.jsonl`, `events.jsonl`, and `transcripts/` to a destination directory. Skips symlinks and excludes control files. Default destination: `./ralph-logs-<ISO-timestamp>`.

## Termination statuses

| Status | Meaning |
|---|---|
| `complete` | Completion promise matched; `required` gates also passed when configured |
| `max-iterations` | Reached `max_iterations` without completion |
| `no-progress-exhaustion` | No durable progress in any iteration |
| `stopped` | `/ralph-stop` observed |
| `timeout` | An iteration exceeded the `timeout` limit |
| `error` | Structural failure (parse error, missing file) |
| `cancelled` | `/ralph-cancel` observed |

## Draft workflow

`/ralph-draft` and `/ralph` without a path produce a draft:

1. Task text is classified as `analysis`, `fix`, `migration`, or `general`
2. A deterministic draft is generated from repo signals (package manager, test/lint commands)
3. If an authenticated model is available, the draft may be strengthened by LLM review
4. The draft is presented for interactive review — edit, start, or cancel
5. Guardrails and `required_outputs` from the baseline are preserved during strengthening

Drafts include a metadata comment (`<!-- pi-ralph-loop: ... -->`) used for re-validation on edits.

## Scaffold

`/ralph-scaffold [--preset <name>] <name-or-path>` creates a starter template:

```yaml
---
max_iterations: 10
timeout: 120
commands: []
completion_promise: DONE
completion_gate: optional
---
# {{ ralph.name }}

Describe the task here.

## Evidence
Use {{ commands.* }} outputs as evidence.

## Completion
Stop with <promise>DONE</promise> when finished.
```

Bundled presets:

- `fix-tests`
- `migration`
- `research-report`
- `security-audit`

Use `/ralph-scaffold --preset fix-tests my-task` to start from one of the bundled templates. Quoted paths are supported, for example `/ralph-scaffold --preset migration "feature/new task"`.

Refuses to overwrite an existing `RALPH.md` or write outside the current working directory.

## Agent skills

pi-ralph-loop ships two skills that pi auto-discovers when the package is installed:

| Skill | When it activates | What it teaches |
|---|---|---|
| [`ralph-loop`](./skills/ralph-loop/SKILL.md) | Starting or configuring a loop | When to loop vs. single-session, prompt structure, guardrails, completion gating, common mistakes |
| [`ralph-draft`](./skills/ralph-draft/SKILL.md) | Creating a RALPH.md from plain language | Task classification, project detection, frontmatter generation, guardrail selection |

The `ralph-loop` skill includes detailed references:
- [Prompt patterns](./skills/ralph-loop/references/prompt-patterns.md) — annotated examples for self-healing, migration, research, security, and evidence-driven loops
- [Config cookbook](./skills/ralph-loop/references/config-cookbook.md) — copy-paste frontmatter recipes for common scenarios

## License

MIT