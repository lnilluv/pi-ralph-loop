# pi-ralph
Autonomous coding loops for pi with task folders, editable drafts, durable state, and per-iteration supervision.

## Why use it
- Keep work in a task folder instead of a single chat turn.
- Re-run commands each iteration and feed the output back into the prompt.
- Keep short rolling memory in `RALPH_PROGRESS.md`.
- Store durable loop state in `.ralph-runner/`.
- Draft from plain language, then review before starting.

## Install
```bash
pi install npm:@lnilluv/pi-ralph-loop
```

## Quick start
1. Create `work/RALPH.md`.
2. Run `/ralph --path work --arg owner="Ada Lovelace"`.
3. If you want a draft first, use `/ralph-draft fix flaky auth tests`.

## Concise `RALPH.md`
```md
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
max_iterations: 25
timeout: 300
completion_promise: DONE
---
Fix the failing auth tests for {{ args.owner }}.

Use {{ commands.tests }} and {{ commands.verify }} as evidence.
Stop with <promise>DONE</promise> only when the gate passes.
```

## Key features
- `/ralph` runs an existing task folder or `RALPH.md`, or drafts a new loop from plain language.
- `/ralph-draft` saves the draft without starting the loop.
- `/ralph-stop` writes a stop flag under `.ralph-runner/` so the loop exits after the current iteration.
- Frontmatter can declare `args` and `{{ args.name }}` placeholders; `--arg name=value` fills them when you run an existing task folder with `/ralph --path`.
- Commands that start with `./` run from the task directory, so checked-in helper scripts work.
- `RALPH_PROGRESS.md` is injected as short rolling memory and excluded from progress snapshots.
- The runner stores status, iteration records, events, transcripts, and stop signals in `.ralph-runner/`.
- Completion gating only stops early when the promise is seen and the readiness checks pass; a clear no-progress result will not trigger early stop.
- The loop can use a selected model and thinking level; if interactive draft strengthening has no authenticated model, it falls back to the deterministic draft path.

## Commands
| Command | Use |
|---|---|
| `/ralph [path-or-task]` | Run an existing task folder or `RALPH.md`, or draft a new loop from a task description. |
| `/ralph-draft [path-or-task]` | Draft or edit a loop without starting it. |
| `/ralph-stop [path-or-task]` | Request a graceful stop after the current iteration. |

## Config reference
| Field | Purpose |
|---|---|
| `commands` | Shell commands to run each iteration. |
| `args` | Declared runtime parameters for `--arg`. |
| `max_iterations` | Maximum iterations, from 1 to 50. |
| `inter_iteration_delay` | Delay between iterations, in seconds. |
| `timeout` | Per-iteration timeout, up to 300 seconds. |
| `completion_promise` | Early-stop marker such as `DONE`. |
| `required_outputs` | Files that must exist before early stop. |
| `guardrails.block_commands` | Regexes blocked in bash commands. |
| `guardrails.protected_files` | File globs protected from `write` and `edit`. |
| Model selection | Use a selected model and optional thinking level; the runner applies it before the prompt. |

Advanced behavior, validation, and edge cases live in `src/runner.ts`, `src/runner-state.ts`, `src/runner-rpc.ts`, `src/ralph.ts`, and `tests/`.

## License
MIT
