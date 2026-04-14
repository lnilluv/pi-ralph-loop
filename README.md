# pi-ralph

Autonomous coding loops for pi with mid-turn supervision.

## Install

```bash
pi install npm:@lnilluv/pi-ralph-loop
```

## Quick start

### Run an existing task folder

```md
# my-task/RALPH.md
---
commands:
  - name: tests
    run: npm test
    timeout: 60
---
Fix failing tests using this output:

{{ commands.tests }}
```

Run:

```text
/ralph my-task
```

### Draft a loop from natural language

```text
/ralph reverse engineer this app
```

pi drafts `./reverse-engineer-this-app/RALPH.md`, shows a short Mission Brief, lets you edit the file, and only starts after you confirm.

### Draft without starting

```text
/ralph-draft fix flaky auth tests
```

That saves the draft but does not launch the loop.

### Smart drafting

Smart drafting sends the selected repo excerpts from the current repo context to the currently selected active pi model when you start `/ralph` interactively, including models chosen with `/model` or by cycling within `/scoped-models`. It excludes common secret-bearing paths from that context, and non-analysis drafts use the shared `policy:secret-bearing-paths` token so runtime write protection stays aligned with the same policy. It does not switch models automatically. When the active model is used to strengthen an existing draft, it now accepts validated body-and-commands drafts instead of body-only drafts. If no active authenticated model is available, drafting falls back to the deterministic path.

## How it works

Each iteration re-reads `RALPH.md`, runs the configured commands, injects their output into `{{ commands.<name> }}` placeholders, and sends the task to a fresh `pi --mode rpc` subprocess instead of keeping a long-lived in-process session. If `RALPH_PROGRESS.md` exists at the task root, Ralph injects it into every prompt as a short writable memory and ignores its churn when deciding whether the loop made durable progress. Failed command output appears in the next iteration, which keeps the loop self-healing.

### Subprocess runner

`runner.ts` orchestrates the loop for each iteration:
- re-read `RALPH.md` so live edits apply on the next turn
- run any configured pre-iteration commands
- snapshot the task directory before the agent runs
- spawn a fresh RPC subprocess
- compare before/after snapshots and evaluate completion
- stop on max iterations, timeout, or no-progress exhaustion

`runner-rpc.ts` manages the subprocess:
- starts `pi --mode rpc --no-session`
- sends `set_model`, `set_thinking_level`, and `prompt` over stdin as JSONL
- reads JSONL events from stdout
- keeps stdin open until `agent_end`
- handles timeouts and process lifecycle

### Model selection

`modelPattern` supports `provider/modelId` and `provider/modelId:thinkingLevel`. When a thinking level is present, the runner sends `set_model` first, then `set_thinking_level`, and only then sends the prompt. The RPC manager waits for acknowledgments before continuing.

### Progress detection

The runner hashes task-directory files before and after each iteration and diffs the snapshots. New or modified files count as progress. `.git`, `node_modules`, `.ralph-runner`, and similar ignored paths are excluded. If a snapshot is truncated because it exceeds 200 files or 2 MB, progress is reported as `"unknown"` instead of `false`. After the subprocess exits, the runner waits 100 ms and polls once more for late file writes.

### Durable state

`runner-state.ts` stores durable state in `.ralph-runner/` inside the task directory:
- `status.json` — current status, loop token, and timestamps
- `iterations.jsonl` — appended iteration records
- `stop.flag` — graceful stop signal

`status.json` records runner states such as `initializing`, `running`, `complete`, `max-iterations`, `no-progress-exhaustion`, `stopped`, `timeout`, `error`, and `cancelled`. `/ralph-stop` now writes `stop.flag`, and the runner checks it before each iteration.

## Smart `/ralph` behavior

`/ralph` is path-first:

- task folder with `RALPH.md` -> runs it
- direct `RALPH.md` path -> runs it
- no args in a folder without `RALPH.md` -> asks what the loop should work on, drafts `./RALPH.md`, then asks before starting
- natural-language task -> drafts `./<slug>/RALPH.md`, then asks before starting
- unresolved path-like input like `foo/bar` or `notes.md` -> offers recovery choices and normalizes missing markdown targets to `./<folder>/RALPH.md`
- arbitrary markdown files like `README.md` -> rejected instead of auto-run

### Explicit flags

Use these when you want to skip heuristics:

```text
/ralph --path my-task --arg owner="Ada Lovelace"
/ralph --task "reverse engineer the billing flow"
/ralph-draft --path my-task
/ralph-draft --task "fix flaky auth tests"
```

`--arg` is for reusable templates that already declare runtime parameters. It is applied only when `/ralph` runs an existing `RALPH.md`; `/ralph-draft` leaves arg placeholders untouched for now. It accepts quoted multiword values like `--arg owner="Ada Lovelace"`.

### Interactive review

Draft flows require an interactive UI because the extension uses a Mission Brief and editor dialog before saving or starting. In non-interactive contexts, pass an existing task folder or `RALPH.md` path instead.

## RALPH.md format

```md
---
args:
  - owner
commands:
  - name: tests
    run: npm test
    timeout: 90
  - name: lint
    run: npm run lint
    timeout: 60
max_iterations: 25
inter_iteration_delay: 0
timeout: 300
completion_promise: "DONE"
guardrails:
  block_commands:
    - "rm\\s+-rf\\s+/"
    - "git\\s+push"
  protected_files:
    - ".env*"
    - "**/secrets/**"
---
You are fixing flaky tests in the auth module.

<!-- This comment is stripped before sending to the agent -->

Latest test output:
{{ commands.tests }}

Latest lint output:
{{ commands.lint }}

Iteration {{ ralph.iteration }} of {{ ralph.name }}.
Apply the smallest safe fix and explain why it works.
```

Strengthened body-and-commands drafts keep the deterministic baseline exact: command `name -> run` pairs must match the baseline, commands may only be reordered, dropped, or have timeouts stay the same or decrease, `max_iterations` and top-level `timeout` may stay the same or decrease, every `{{ commands.<name> }}` used in the strengthened draft must point to an accepted command, `completion_promise` must stay unchanged, including staying absent when absent, and guardrails stay fixed in this phase. If the strengthened frontmatter is invalid or unsupported, pi rejects the whole strengthened draft and falls back automatically instead of splicing fields.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands` | array | `[]` | Commands to run each iteration |
| `commands[].name` | string | required | Must match `^\w[\w-]*$`; key for `{{ commands.<name> }}` |
| `commands[].run` | string | required | Shell command |
| `commands[].timeout` | number | `60` | Seconds before kill; greater than 0 and at most 300 seconds, and must be `<= timeout` |
| `args` | string[] | `[]` | Declared runtime parameters for reusable templates |
| `args[]` | string | required | Must match `^\w[\w-]*$`; key for `{{ args.<name> }}` |
| `max_iterations` | integer | `50` | Stop after N iterations; must be 1-50 |
| `inter_iteration_delay` | integer | `0` | Wait N seconds between completed iterations; must be a non-negative integer |
| `timeout` | number | `300` | Per-iteration timeout in seconds; must be greater than 0 and at most 300; stops the loop if the agent is stuck |
| `completion_promise` | string | — | Agent signals completion by sending `<promise>DONE</promise>`; loop breaks on match |
| `guardrails.block_commands` | string[] | `[]` | Regex patterns to block in bash |
| `guardrails.protected_files` | string[] | `[]` | Glob patterns, or the shared `policy:secret-bearing-paths` token, enforced on `write`/`edit` tool calls |

### Placeholders

| Placeholder | Description |
|-------------|-------------|
| `{{ commands.<name> }}` | Output from the command named `<name>` |
| `{{ args.<name> }}` | Runtime value supplied with `--arg name=value` during `/ralph` |
| `{{ ralph.iteration }}` | Current 1-based iteration number |
| `{{ ralph.name }}` | Directory name containing the `RALPH.md` |
| `{{ ralph.max_iterations }}` | Top-level iteration limit from the current frontmatter |

HTML comments (`<!-- ... -->`) are stripped from the prompt body after placeholder resolution, so you can annotate your `RALPH.md` freely. `args` are resolved at runtime during `/ralph` runs only; the template file is never rewritten with supplied values. Generated drafts also escape literal `<!--` and `-->` in the visible task line, and the leading metadata comment is URL-encoded so task text can safely contain comment-like sequences.

## Commands

- `/ralph [path-or-task]` - Start Ralph from a task folder or `RALPH.md`, or draft a new loop from natural language.
- `/ralph-draft [path-or-task]` - Draft or edit a Ralph task without starting it.
- `/ralph-stop` - Request a graceful stop after the current iteration by writing `.ralph-runner/stop.flag`.

## Pi-only features

### Guardrails

`guardrails.block_commands` and `guardrails.protected_files` come from RALPH frontmatter. The extension enforces them in the `tool_call` hook — but only for sessions created by the loop, so they don't leak into unrelated conversations. Matching bash commands are blocked, and `write`/`edit` tool calls targeting protected file globs or the shared secret-path policy token are denied.

### Cross-iteration memory

After each iteration, the extension stores a short summary with iteration number and duration. In `before_agent_start`, it injects that history into the system prompt so the next run can avoid repeating completed work.

### Mid-turn steering

In the `tool_result` hook, bash outputs are scanned for failure patterns. After three or more failures in the same iteration, the extension appends a stop-and-think warning to push root-cause analysis before another retry.

### Completion promise

When `completion_promise` is set (for example, `"DONE"`), the loop scans the agent's messages for `<promise>DONE</promise>` after each iteration. If found, the loop only stops early once the completion gate passes: any configured required outputs must exist, and `OPEN_QUESTIONS.md` must have no remaining P0/P1 items.

### Iteration timeout

Each iteration has a configurable timeout (default 300 seconds). If the agent is stuck and doesn't become idle within the timeout, the loop stops with a warning.

### Input validation

The extension validates `RALPH.md` frontmatter before starting and on each re-parse: `max_iterations` must be an integer from 1 to 50, `timeout` must be greater than 0 and at most 300 seconds, command names must match `^\w[\w-]*$`, command timeouts must be greater than 0 and at most 300 seconds and no greater than top-level `timeout`, `block_commands` regexes must compile, and commands must have non-empty names and run strings. The current runtime also rejects unsafe `completion_promise` values (non-string, blank, multiline, or angle-bracketed) and universal `guardrails.protected_files` globs such as `**/*`.

## Comparison table

| Feature | **@lnilluv/pi-ralph-loop** | pi-ralph | pi-ralph-wiggum | ralphi | ralphify |
|---------|----------------------------|----------|-----------------|--------|----------|
| Command output injection | ✓ | ✗ | ✗ | ✗ | ✓ |
| Fresh-context sessions | ✓ | ✓ | ✗ | ✓ | ✓ |
| Subprocess isolation | ✓ | ✗ | ✗ | ✗ | ✗ |
| Durable state | ✓ | ✗ | ✗ | ✗ | ✗ |
| Model selection | ✓ | ✗ | ✗ | ✗ | ✗ |
| Progress detection | ✓ | ✗ | ✗ | ✗ | ✗ |
| Live RALPH.md editing | ✓ | ✗ | ✗ | ✗ | ✗ | |
| Mid-turn guardrails | ✓ | ✗ | ✗ | ✗ | ✗ |
| Cross-iteration memory | ✓ | ✗ | ✗ | ✗ | ✗ |
| Mid-turn steering | ✓ | ✗ | ✗ | ✗ | ✗ |
| Guided task drafting | ✓ | ✗ | ✗ | ✗ | separate scaffold |
| Completion promise | ✓ | ✗ | ✗ | ✗ | ✓ |
| Iteration timeout | ✓ | ✗ | ✗ | ✗ | ✗ |
| Session-scoped hooks | ✓ | ✗ | ✗ | ✗ | ✗ |
| Input validation | ✓ | ✗ | ✗ | ✗ | ✗ |
| Setup required | task folder or draft flow | config | RALPH.md | PRD pipeline | scaffold + RALPH.md |

## Parity harness

Checked-in parity fixtures and the replay harness live in `parity/`. The harness uses the active pi model by default and can pin a specific model with `--model` or `PI_RALPH_PARITY_MODEL`. See `parity/README.md` for the exact rerun command, artifact layout, and environment variables.

## License

MIT
