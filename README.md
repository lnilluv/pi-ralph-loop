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

## How it works

On each iteration, pi-ralph reads `RALPH.md`, runs the configured commands, injects their output into the prompt through `{{ commands.<name> }}` placeholders, starts a fresh session, sends the prompt, and waits for completion. Failed command output appears in the next iteration, which creates a self-healing loop.

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
/ralph --path my-task
/ralph --task "reverse engineer the billing flow"
/ralph-draft --path my-task
/ralph-draft --task "fix flaky auth tests"
```

### Interactive review

Draft flows require an interactive UI because the extension uses a Mission Brief and editor dialog before saving or starting. In non-interactive contexts, pass an existing task folder or `RALPH.md` path instead.

## RALPH.md format

```md
---
commands:
  - name: tests
    run: npm test
    timeout: 90
  - name: lint
    run: npm run lint
    timeout: 60
max_iterations: 25
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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands` | array | `[]` | Commands to run each iteration |
| `commands[].name` | string | required | Key for `{{ commands.<name> }}` |
| `commands[].run` | string | required | Shell command |
| `commands[].timeout` | number | `60` | Seconds before kill |
| `max_iterations` | number | `50` | Stop after N iterations |
| `timeout` | number | `300` | Per-iteration timeout in seconds; stops the loop if the agent is stuck |
| `completion_promise` | string | — | Agent signals completion by sending `<promise>DONE</promise>`; loop breaks on match |
| `guardrails.block_commands` | string[] | `[]` | Regex patterns to block in bash |
| `guardrails.protected_files` | string[] | `[]` | Glob patterns to block writes |

### Placeholders

| Placeholder | Description |
|-------------|-------------|
| `{{ commands.<name> }}` | Output from the named command |
| `{{ ralph.iteration }}` | Current 1-based iteration number |
| `{{ ralph.name }}` | Directory name containing the `RALPH.md` |

HTML comments (`<!-- ... -->`) are stripped from the prompt body after placeholder resolution, so you can annotate your `RALPH.md` freely. Generated-draft metadata is stored in a URL-encoded leading HTML comment so task text can safely contain comment-like sequences.

## Commands

- `/ralph [path-or-task]` - Start Ralph from a task folder or `RALPH.md`, or draft a new loop from natural language.
- `/ralph-draft [path-or-task]` - Draft or edit a Ralph task without starting it.
- `/ralph-stop` - Request a graceful stop after the current iteration.

## Pi-only features

### Guardrails

`guardrails.block_commands` and `guardrails.protected_files` come from RALPH frontmatter. The extension enforces them in the `tool_call` hook — but only for sessions created by the loop, so they don't leak into unrelated conversations. Matching bash commands are blocked, and writes/edits to protected file globs are denied.

### Cross-iteration memory

After each iteration, the extension stores a short summary with iteration number and duration. In `before_agent_start`, it injects that history into the system prompt so the next run can avoid repeating completed work.

### Mid-turn steering

In the `tool_result` hook, bash outputs are scanned for failure patterns. After three or more failures in the same iteration, the extension appends a stop-and-think warning to push root-cause analysis before another retry.

### Completion promise

When `completion_promise` is set (for example, `"DONE"`), the loop scans the agent's messages for `<promise>DONE</promise>` after each iteration. If found, the loop stops early.

### Iteration timeout

Each iteration has a configurable timeout (default 300 seconds). If the agent is stuck and doesn't become idle within the timeout, the loop stops with a warning.

### Input validation

The extension validates `RALPH.md` frontmatter before starting and on each re-parse: `max_iterations` must be a positive integer, `timeout` must be positive, `block_commands` regexes must compile, and commands must have non-empty names and run strings with positive timeouts.

## Comparison table

| Feature | **@lnilluv/pi-ralph-loop** | pi-ralph | pi-ralph-wiggum | ralphi | ralphify |
|---------|----------------------------|----------|-----------------|--------|----------|
| Command output injection | ✓ | ✗ | ✗ | ✗ | ✓ |
| Fresh-context sessions | ✓ | ✓ | ✗ | ✓ | ✓ |
| Mid-turn guardrails | ✓ | ✗ | ✗ | ✗ | ✗ |
| Cross-iteration memory | ✓ | ✗ | ✗ | ✗ | ✗ |
| Mid-turn steering | ✓ | ✗ | ✗ | ✗ | ✗ |
| Guided task drafting | ✓ | ✗ | ✗ | ✗ | separate scaffold |
| Completion promise | ✓ | ✗ | ✗ | ✗ | ✓ |
| Iteration timeout | ✓ | ✗ | ✗ | ✗ | ✗ |
| Session-scoped hooks | ✓ | ✗ | ✗ | ✗ | ✗ |
| Input validation | ✓ | ✗ | ✗ | ✗ | ✗ |
| Setup required | task folder or draft flow | config | RALPH.md | PRD pipeline | scaffold + RALPH.md |

## License

MIT
