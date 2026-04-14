# Parity harness

This directory holds the checked-in parity fixtures and the harness used to replay them.

## What it runs

- `research/` — a frozen Factory.ai public-surface research pass backed by checked-in snapshot files.
- `migrate/` — a deterministic migration-style task with helper scripts and a golden/verifier check.

## Baseline command

From the repo root:

```bash
python3 parity/harness.py --implementation pi-ralph-loop --fixture research --fixture migrate
```

The harness creates a fresh temp artifact root by default, runs each selected fixture in its own copied workspace, and prints the absolute artifact root path when it finishes.

## Checked-in baseline

The checked-in baseline evidence is named for the commit it covers: `a941a79830a2110ecf0ec69fe28419f04d49627a`.

- Pointer file: `parity/baselines/a941a79830a2110ecf0ec69fe28419f04d49627a.json`
- Evidence bundle: `parity/baselines/a941a79830a2110ecf0ec69fe28419f04d49627a/`

`parity/latest-baseline.json` points at that snapshot.

## Running Ralphify later

To compare against Ralphify, point the harness at the Ralphify RPC command and switch the implementation flag:

```bash
PI_RALPH_PARITY_RALPHIFY_RPC_COMMAND='pi --mode rpc --no-extensions -e /path/to/ralphify/src/index.ts --model openai-codex/gpt-5.4-mini:high' \
python3 parity/harness.py --implementation ralphify --fixture research --fixture migrate
```

If the Ralphify flow needs a different prompt command, override `PI_RALPH_PARITY_RALPHIFY_PROMPT_TEMPLATE`.

## Useful environment variables

- `PI_RALPH_PARITY_ROOT` — reuse a specific artifact root instead of creating a fresh temp directory.
- `PI_RALPH_PARITY_MODEL` — override the default model used by the built-in `pi-ralph-loop` command.
- `PI_RALPH_PARITY_LOOP_RPC_COMMAND` — replace the default `pi-ralph-loop` RPC command.
- `PI_RALPH_PARITY_RALPHIFY_RPC_COMMAND` — set the Ralphify RPC command.
- `PI_RALPH_PARITY_LOOP_PROMPT_TEMPLATE` — override the prompt command for `pi-ralph-loop`.
- `PI_RALPH_PARITY_RALPHIFY_PROMPT_TEMPLATE` — override the prompt command for Ralphify.

## Bundle layout

Each run writes a bundle under the artifact root:

```text
<artifact-root>/
  manifest.json
  agent/
  runs/
    <fixture>/<implementation>/
      command.txt
      inventory-before.tsv
      inventory-after.tsv
      prompt.txt
      top-level-rpc.jsonl
      top-level-stderr.log
      verify.json
      verify.stdout.log
      verify.stderr.log
      verify.command.txt
      task/
        RALPH.md
        .ralph-runner/
        ...fixture files and generated outputs...
```

The `task/` directory is the fresh copied workspace that the extension actually ran against.
