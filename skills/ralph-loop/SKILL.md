---
name: ralph-loop
description: Use when starting or configuring an autonomous coding loop with pi-ralph-loop. Triggered by phrases like autonomous loop, repeat until done, keep running tests until green, or a long-running coding campaign. Covers when to loop, how to write RALPH.md, guardrails, completion gating, and iteration prompt patterns.
---

# Ralph Loop Skill

You know how to code. This skill teaches you when and how to run autonomous loops with pi-ralph-loop.

## When to loop

A ralph loop is the right tool when the task is **repetitive, verifiable, or progressive** — when one pass won't finish it and you can define what "done" looks like.

| Use a loop | Don't use a loop |
|---|---|
| Fix all failing tests (one per iteration) | Fix one specific bug |
| Increase test coverage module by module | Write one test |
| Migrate code pattern across many files | Rename a variable |
| Write documentation for 20 modules | Fix a typo |
| Security audit across a codebase | Review one function |
| Research and build a knowledge base | Answer a question |

**Rule of thumb:** If the task needs more than 3 iterations or you can write a command that measures progress, loop it.

## Commands

You have ten command names available:

| Command | Purpose |
|---|---|
| `/ralph [path-or-task]` | Draft and start from plain language or an existing task folder |
| `/ralph --path ./dir --arg key=val` | Start an existing task folder with args |
| `/ralph-draft "task description"` | Create a draft without starting |
| `/ralph-list` | List active loops |
| `/ralph-status [path]` | Show durable status and the latest iteration summary |
| `/ralph-resume <path>` | Start a new run from an existing `RALPH.md` |
| `/ralph-archive <path>` | Move `.ralph-runner/` into `.ralph-runner-archive/<ISO>/` |
| `/ralph-stop [path-or-task]` | Graceful stop after current iteration |
| `/ralph-cancel [path-or-task]` | Kill the current iteration immediately |
| `/ralph-scaffold [--preset <name>] <name-or-path>` | Create a starter RALPH.md template |
| `/ralph-logs [--path] [--dest]` | Export run artifacts |

Bundled presets:

- `fix-tests`
- `migration`
- `research-report`
- `security-audit`

Use `/ralph-scaffold --preset fix-tests my-task` to scaffold from a bundled template. Quoted paths are supported, for example `/ralph-scaffold --preset migration "feature/new task"`.

## RALPH.md structure

Every loop needs a `RALPH.md` file — YAML frontmatter for config, Markdown body for the prompt.

```
my-task/
├── RALPH.md        ← required: config + prompt
├── scripts/        ← optional: helper scripts for commands
└── references/     ← optional: context the agent can read
```

### Frontmatter reference

| Key | Type | Default | Purpose |
|---|---|---|---|
| `commands` | CommandDef[] | `[]` | Shell commands run each iteration. Each: `name`, `run`, `timeout` (1–300s, default 60) |
| `args` | string[] | `[]` | Declared runtime parameters for `--arg name=value` |
| `max_iterations` | integer | `50` | 1–50 |
| `inter_iteration_delay` | integer | `0` | Seconds between iterations |
| `items_per_iteration` | integer | — | Pacing cap for each iteration. Valid values: 1–20 |
| `reflect_every` | integer | — | Reflection cadence. Valid values: 2–20 |
| `timeout` | integer | `300` | Seconds per iteration |
| `completion_promise` | string | — | Done marker. Single line, no `<>` or line breaks |
| `completion_gate` | `required` \| `optional` \| `disabled` | `required` when `completion_promise` is set | Controls whether required outputs and OPEN_QUESTIONS.md block stopping |
| `required_outputs` | string[] | `[]` | Relative file paths that must exist for completion |
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
| `{{ ralph.iteration }}` | Current iteration number (1-based) |
| `{{ ralph.name }}` | Task directory basename |
| `{{ ralph.max_iterations }}` | Current max iterations |

## Prompt structure

An effective prompt has five sections. Not all are required every time, but this is the structure that works:

```
1. Orientation   — Who you are, what you're doing, and how the loop works
2. Evidence      — Command output ({{ commands.* }}) showing current state
3. Task          — What to do this iteration
4. Rules         — Constraints and guardrails
5. Completion    — When to stop and what "done" looks like
```

### Orientation (always include)

Tell the agent it's in a loop and what that means:

```markdown
You are an autonomous coding agent running in a loop.
Each iteration starts with a fresh context.
Your progress lives in the code and git history.
```

### Evidence (always include)

Feed command output into the prompt so the agent sees current state:

```yaml
commands:
  - name: tests
    run: npm test
    timeout: 60
  - name: git-log
    run: git log --oneline -10
```

```markdown
## Test results
{{ commands.tests }}

## Recent commits
{{ commands.git-log }}

If tests are failing, fix them before starting new work.
```

### Task (always include)

One task per iteration. Be specific:

```markdown
Pick the module with the lowest test coverage.
Write thorough tests for it.
Commit with `test: add coverage for <module>`.
```

### Rules (include for safety)

```markdown
- One module per iteration
- No placeholder code — full, working implementations only
- Run tests before committing
- Do not modify files outside the task scope
```

### Completion (always include)

Use `completion_promise` to define the stop signal. Use `completion_gate` to decide whether required outputs and OPEN_QUESTIONS.md can block stopping:

- `required` — the default when `completion_promise` is set; the loop stops only when the promise, required outputs, and OPEN_QUESTIONS.md are all ready
- `optional` — the prompt still reminds the agent about outputs and OPEN_QUESTIONS.md, but `complete` can happen once the promise is emitted
- `disabled` — the loop skips completion-gate reminders and checks, so `complete` can happen once the promise is emitted

```yaml
completion_promise: DONE
completion_gate: required
required_outputs:
  - COVERAGE_REPORT.md
  - OPEN_QUESTIONS.md
```

```markdown
Stop with <promise>DONE</promise> only when:
1. All tests pass
2. COVERAGE_REPORT.md exists and is complete
3. OPEN_QUESTIONS.md exists and has no unresolved P0/P1 items
```

If the promise appears but files are missing, the loop continues with a rejection notice.

## Guardrails

Guardrails constrain what the loop agent can do. Use them.

### Block dangerous commands

```yaml
guardrails:
  block_commands:
    - 'git\s+push'
    - 'rm\s+-rf\s+/'
    - 'npm\s+publish'
```

Any bash command matching a pattern is blocked. The agent sees `[blocked by guardrail: PATTERN]`.

### Protect sensitive files

```yaml
guardrails:
  protected_files:
    - '.env*'
    - '*.pem'
    - '*.key'
    - 'policy:secret-bearing-paths'
```

`policy:secret-bearing-paths` is a built-in policy blocking `.aws/`, `.ssh/`, `secrets/`, `.npmrc`, `.pem`, `.key`, and other secret-bearing paths.

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

### Choose the right level

| Autonomy | Guardrails | stop_on_error |
|---|---|---|
| Low (exploring) | Strict block + protect | `true` |
| Medium (fixing) | Block push/publish | `true` |
| High (migrating) | Block push only | `false` |
| Maximum (research) | None | `false` |

## Stopping behavior

| Action | Behavior |
|---|---|
| `/ralph-stop [path-or-task]` | Finish current iteration, then stop |
| `/ralph-cancel [path-or-task]` | Kill current iteration immediately |
| Completion promise + gate | Stop when the promise is matched; `required` gates also require `required_outputs` and OPEN_QUESTIONS.md |
| `max_iterations` reached | Stop after N iterations |
| No progress in every iteration | Stop with `no-progress-exhaustion` |
| `stop_on_error: true` (default) | Stop on RPC error or timeout |
| `stop_on_error: false` | Continue past RPC errors and timeouts |

## Progress memory

`RALPH_PROGRESS.md` in the task directory is injected as rolling memory (max 4096 chars) each iteration. The loop reads it before each iteration and truncates it if it grows too large.

Use it for:
- Tracking what's been done across iterations
- Maintaining a todo list that shrinks as work completes
- Storing findings or decisions between iterations

The agent should write progress to this file at the end of each iteration.

## Common mistakes

| Mistake | Fix |
|---|---|
| Vague task ("improve the codebase") | Be specific: "fix the 3 failing tests in auth.test.ts" |
| No completion criteria | Set `completion_promise` and `required_outputs` |
| No evidence commands | Add commands that show current state |
| Too many tasks per iteration | One task per iteration works best |
| Missing guardrails on production code | Block `git push` and protect secrets |
| Not using progress memory | Add a progress section to track work across iterations |
| Overly long prompt | Keep it under 200 lines; the loop re-reads it every iteration |

## Deeper reading

- [Prompt patterns](references/prompt-patterns.md) — detailed prompt-writing patterns with annotated examples
- [Config cookbook](references/config-cookbook.md) — frontmatter recipes for common scenarios

## Quick start

For a task you can describe in plain language:

```
/ralph "fix the failing auth tests"
/ralph-draft "fix the failing auth tests"
```

For a task folder you've already set up:

```
/ralph --path ./my-task --arg owner="Ada"
```

To create a starter template or start from a bundled preset:

```
/ralph-scaffold my-task
/ralph-scaffold --preset security-audit security-review
```