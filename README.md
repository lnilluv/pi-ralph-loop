<p align="center">
  <img src="./assets/pi-ralph-loop.png" alt="pi-ralph-loop autonomous coding loop hero image" width="900">
</p>

# pi-ralph-loop

Autonomous coding loops for [pi](https://github.com/mariozechner/pi-coding-agent).

Describe what you want done. The loop runs your agent, re-reads the task, feeds fresh command output every iteration, and stops when the work is finished — or when you tell it to stop.

```
/ralph "fix the flaky auth tests"
```

## Why loops

A single agent run can fix a bug. But the real leverage is **sustained, autonomous work** — campaigns that run for hours, making progress one commit at a time while you do something else.

### Ralph and `/goal` solve different layers

`/goal` answers “what should this Pi session keep pursuing?” Ralph answers “how should a campaign be executed, verified, stopped, inspected, and resumed across fresh child Pi runs?”

Use `/goal` for continuity inside one conversation. Use Ralph when the work needs fresh command evidence every iteration, acceptance checks after the agent claims completion, durable transcripts and reports, or process-level stop/cancel controls for unattended work. They are complementary: a goal defines intent; Ralph runs a bounded, evidence-producing campaign.

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

## For Pi agents and automation

`/ralph` is a **Pi slash command**, not a shell executable. Do not run `/ralph ...` with `bash`; bash will correctly say `No such file or directory`.

If the user intended a bare `/ralph ...` command but it reaches the assistant as normal chat, the command was not intercepted by Pi. Treat that as an extension loading problem, not as a request to manually simulate the loop. Ask the user to run `pi install npm:@lnilluv/pi-ralph-loop`, then `/reload` or restart Pi, and retry the slash command.

Useful checks (`pi list` is authoritative; `npm list -g` only checks global npm installs):

```bash
pi list | grep '@lnilluv/pi-ralph-loop'
npm list -g @lnilluv/pi-ralph-loop --depth=0
```

`pi --help` lists CLI flags, not extension slash commands, so `pi --help | grep ralph` is not a valid install check.

From an assistant turn, either:

1. prepare a task folder with `RALPH.md`, then tell the user to run `/ralph --path ./task`, or
2. when a noninteractive smoke test is explicitly wanted, run Pi itself with the slash command as the prompt:

```bash
pi -p "/ralph --path ./task"
```

For extension-development smoke tests, isolate the run from the user's installed extensions and skills so you test the checkout you intend to test:

```bash
pi --offline --no-extensions --no-skills \
  --extension ./src/index.ts \
  --session-dir /tmp/ralph-smoke-sessions \
  -p "/ralph --path ./task/RALPH.md"
```

When authoring `RALPH.md` for a user or for CI-style verification:

- Use `snake_case` frontmatter keys. Common camelCase aliases are accepted for compatibility with LLM-authored drafts, but new files should prefer `max_iterations`, `inter_iteration_delay`, `completion_promise`, `completion_gate`, `required_outputs`, `stop_on_error`, `guardrails.block_commands`, and `guardrails.protected_files`.
- Remember that normal `commands` run **before** the agent edits files in each iteration. Their output is evidence for the next action, not proof of what the same iteration eventually changed.
- Mark true final checks with `acceptance: true`. With `completion_gate: required`, Ralph reruns acceptance commands after the completion promise before stopping.
- For multi-line shell commands, use `set -euo pipefail` or chain checks with `&&`. Plain shell scripts return the status of the last command, so an earlier failing `test` or `grep` can be hidden by a later successful command.
- If `completion_gate` is `required`, include an `OPEN_QUESTIONS.md` policy in the task: either create one with no remaining P0/P1 items, or, when no command uses `acceptance: true`, set `completion_gate: optional`/`disabled` if that readiness check is not desired.

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

### Parallel runs

One Pi session can own multiple independent Ralph child runs. When another run is active, interactive starts ask for confirmation; noninteractive starts must opt in explicitly:

```
/ralph --parallel --path ./second-task
```

Parallel current-workspace runs can edit the same repository. Ralph does not lock files or prevent conflicts, so use independent tasks. Only one active run may use a given Ralph task directory because its artifacts and stop/cancel signals are task-local.

#### Live Pi TUI release smoke

Run this credentialed check for releases, not normal CI:

1. Create two temporary task directories with distinct completion promises, `max_iterations: 5`, and `inter_iteration_delay: 10`; instruct each task never to emit its promise.
2. From a temporary workspace, start one authenticated Pi process loading only this checkout:
   ```
   pi --no-extensions --no-skills \
     --extension /absolute/path/to/checkout/src/index.ts \
     --session-dir /tmp/ralph-live-sessions
   ```
3. Start task A with `/ralph --path <task-a>/RALPH.md`, then start task B while A is active with `/ralph --parallel --path <task-b>/RALPH.md`. Require both to become active and their task-scoped status artifacts to contain distinct loop tokens.
4. Run pathless `/ralph-stop`, require both runs in the picker, cancel it, and verify neither run gains a stop flag.
5. Stop A with `/ralph-stop --path <task-a>/RALPH.md`; require B to remain active. Cancel B with `/ralph-cancel --path <task-b>/RALPH.md`; require terminal `stopped` and `cancelled` statuses respectively.
6. Export each run to its own empty destination with `/ralph-logs --path <task-a>/RALPH.md --dest <evidence-a>` and `/ralph-logs --path <task-b>/RALPH.md --dest <evidence-b>`. Review each `status.json`, `events.jsonl`, `iterations.jsonl`, transcripts, generated `final-summary.md`, and the saved TUI transcript.
7. Fail the release gate for a blocked second command, wrong target, duplicate token, or stale registry/UI entry. If no authenticated model is available, record the gate as **blocked**, never passed.
8. Remove the temporary task, evidence, and session directories. Fail if any stop/cancel flag, child Pi process, active claim, or temporary directory remains. Herdr may drive an already-available session, but this gate must not depend on it.


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

YAML header (configuration) + Markdown body (the prompt). The header uses `snake_case` keys. Common camelCase aliases are accepted for compatibility, but new `RALPH.md` files should use the documented `snake_case` form.

```yaml
---
args:
  - owner
commands:
  - name: tests
    run: npm test
    timeout: 60
    acceptance: true
  - name: verify
    run: ./scripts/verify.sh
    timeout: 60
    acceptance: true
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
| `commands` | CommandDef[] | `[]` | Shell commands run each iteration. Every entry requires string `name` and `run`; `command` is not an alias. Names must match `^\w[\w-]*$`. `timeout` is 1–3600s (default 60; must not exceed top-level `timeout`); `acceptance: true` is optional. |
| `args` | string[] | `[]` | Declared runtime parameters for `--arg name=value` |
| `max_iterations` | integer | `50` | 1–50 |
| `inter_iteration_delay` | integer | `0` | Seconds between iterations |
| `items_per_iteration` | integer | — | Pacing cap for each iteration. Valid values: 1–20 |
| `reflect_every` | integer | — | Reflection cadence. Valid values: 2–20 |
| `timeout` | integer | `300` | 1–3600 seconds per iteration |
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

Commands starting with `./` run from the task directory. Others run from the project root. Blocked commands produce `[blocked by guardrail: PATTERN]`. Timed-out commands produce `[timed out after Ns]`. Non-zero exits are recorded as `error`. Ralph records each command outcome as `ok`, `blocked`, `timeout`, or `error` in durable iteration metadata with a bounded output preview. Command output included in prompts/transcripts is capped with a truncation marker and byte count.

Normal command output is pre-iteration evidence: it shows what Ralph observed before the agent made that iteration's edits. If you need post-edit proof, mark the command with `acceptance: true` so a required completion gate reruns it after the promise is emitted. For multi-line shell commands, prefer `set -euo pipefail` or `&&` chains so intermediate failures cannot be masked by a later successful command.

### Goal continuation audits

Every Ralph iteration now includes goal-continuation steering: the agent sees elapsed time and a completion-audit checklist. It should map the original prompt to concrete deliverables and inspect real artifacts/tests/status. If `completion_promise` is configured, the agent should emit it only when the evidence covers every requirement; otherwise, it should keep making verified progress until normal loop termination or operator stop.

## Commands

| Command | What it does |
|---|---|
| `/ralph [--parallel] [path-or-task]` | Start or draft+start a loop; `--parallel` explicitly permits a second noninteractive run |
| `/ralph-draft [path-or-task]` | Create or edit a draft without starting |
| `/ralph-list` | List active loops |
| `/ralph-status [path] [--summary]` | Show durable status and the latest iteration summary; `--summary` renders a deterministic run summary |
| `/ralph-resume <path>` | Start a new run from an existing `RALPH.md` |
| `/ralph-archive <path>` | Move `.ralph-runner/` into `.ralph-runner-archive/<ISO>/` |
| `/ralph-stop [task folder or RALPH.md]` | Finish current iteration, then stop |
| `/ralph-cancel [task folder or RALPH.md]` | Kill the current iteration immediately |
| `/ralph-scaffold [--preset <name>] <name-or-path>` | Create a starter `RALPH.md` template |
| `/ralph-logs [<task folder or RALPH.md>] [--path <task folder or RALPH.md>] [--dest <dir>] [--report]` | Export run artifacts to a directory; optionally add a static HTML report |

Ralph runs each iteration in a child `pi --mode rpc` process. The child explicitly loads the Ralph extension but disables normal Pi extension discovery, so unrelated local extensions or MCP gateways do not slow or alter loop startup.

With one active run, the status line shows its name, phase, and iteration. With multiple active runs, the status line shows the active count and a widget lists each run.

### Argument passing

`--arg name=value` is only valid with `--path` to an existing `RALPH.md`:

```
/ralph --path ./my-task --arg owner="Ada" --arg env=staging
```

`/ralph-draft`, `/ralph-stop [task folder or RALPH.md]`, and `/ralph-cancel [task folder or RALPH.md]` reject `--arg`. Names must match `^\w[\w-]*$` and be declared in `args`.

### Stopping

| Action | Behavior |
|---|---|
| `/ralph-stop [task folder or RALPH.md]` | Finish current iteration, then stop |
| `/ralph-cancel [task folder or RALPH.md]` | Kill the current iteration immediately |
| Completion promise + gate | Stop when the promise is matched; `required` gates also wait for `required_outputs`, OPEN_QUESTIONS.md readiness, and successful `acceptance: true` reruns |
| Max iterations reached | Stop after the last iteration |
| No progress for all iterations | Stop with `no-progress-exhaustion` |

With multiple active runs, an interactive stop, cancel, or pathless status command opens a picker. Noninteractive commands refuse ambiguous targeting and list the active task paths; an explicit task folder or `RALPH.md` path always wins.

## Completion gating

`completion_gate` controls how strictly the loop treats completion promises. Commands marked `acceptance: true` still provide normal pre-iteration evidence, and when a `required` gate is otherwise ready after a completion promise, Ralph reruns those acceptance commands before stopping. Any acceptance outcome other than `ok` blocks completion and is recorded in iteration metadata/events.

| Mode | Behavior |
|---|---|
| `required` | Default when `completion_promise` is set. The loop waits for the promise, every file in `required_outputs`, and an OPEN_QUESTIONS.md that is ready to stop (no remaining P0/P1 items). |
| `optional` | The prompt still reminds the agent about outputs and OPEN_QUESTIONS.md readiness, but the loop may stop once the promise is emitted. |
| `disabled` | The loop skips completion-gate reminders and checks. |

In `optional` and `disabled` mode, `complete` means the promise was matched; those modes do not block on `required_outputs` or OPEN_QUESTIONS.md readiness.
Commands with `acceptance: true` require `completion_promise` and an effective `required` gate. To migrate an invalid configuration, add `completion_promise` plus `completion_gate: required` (or omit the gate so it defaults to `required`), or remove `acceptance: true`.

When the gate is `required`, completion still needs **all conditions**:

1. The agent emits `<promise>DONE</promise>` (or whatever marker you set)
2. Every file in `required_outputs` exists on disk
3. `OPEN_QUESTIONS.md` is ready to stop, meaning it has no remaining P0/P1 items
4. Every `commands[].acceptance: true` rerun exits with outcome `ok`

If the promise is seen but files, OPEN_QUESTIONS.md, or acceptance commands are not ready, the loop continues — the next iteration gets a rejection notice telling the agent what still needs to be fixed.

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
| `final-summary.md` | Deterministic summary written when a run reaches a terminal state |
| `transcripts/` | Per-iteration markdown transcripts |

The workspace-level active-run registry lives at `<cwd>/.ralph-runner/active-loops/`. Entries older than 30 minutes are ignored.
Each task also keeps a token-scoped claim under `<task>/.ralph-runner/active-loops/`, so the same physical task cannot run concurrently from different working directories. Stop and cancel signals are bound to that claim token.

### Log export

`/ralph-status --summary <task>` builds a deterministic summary from `RALPH.md`, `RALPH_PROGRESS.md`, durable status, iteration/event JSONL, and transcript references. It is intended for handoff, review, and compaction-safe context without relying on an LLM summary.

`/ralph-logs` copies `status.json`, `iterations.jsonl`, `events.jsonl`, and `transcripts/` to a new or empty destination directory, then generates a fresh `final-summary.md`. Use a positional task path or `--path <task folder or RALPH.md>`; use `--dest <dir>` to choose the export directory. Short aliases `-p` and `-d` are also supported. Add `--report` to generate `report.html`, an escaped static HTML view derived from the copied artifacts. JSONL files remain canonical; there is no server or SSE dependency. Skips symlinks and excludes control files. Default destination: `./ralph-logs-<ISO-timestamp>`.

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