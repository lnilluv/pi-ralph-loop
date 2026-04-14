# Parity harness

This directory holds the checked-in parity fixtures and the harness used to replay them.

## What it runs

- `research/` — a frozen Factory.ai public-surface research pass backed by checked-in snapshot files.
- `migrate/` — a deterministic migration-style task with helper scripts and a golden/verifier check.

## Replay command

From the repo root:

```bash
python3 parity/harness.py --implementation pi-ralph-loop --fixture research --fixture migrate
```

The harness creates a fresh temp artifact root by default, runs each selected fixture in its own copied workspace, and prints the absolute artifact root path when it finishes.

## Model selection

By default the parity harness uses the currently active pi model. Set `--model` or `PI_RALPH_PARITY_MODEL` to pin a specific model, including models chosen from `/scoped-models`.

If you need to replace the entire RPC invocation, use `--loop-rpc-command` or `PI_RALPH_PARITY_LOOP_RPC_COMMAND`.

The harness writes fresh artifact bundles on demand; it does not depend on checked-in baseline snapshots.

## Alternate implementation

The harness can also replay a supplied compatible RPC command with `--implementation ralphify` or `--implementation both`.

If the alternate flow needs a different prompt command, override `PI_RALPH_PARITY_RALPHIFY_PROMPT_TEMPLATE`.

## Useful environment variables

- `PI_RALPH_PARITY_ROOT` — reuse a specific artifact root instead of creating a fresh temp directory.
- `PI_RALPH_PARITY_MODEL` — pin a model for the built-in `pi-ralph-loop` command.
- `PI_RALPH_PARITY_LOOP_RPC_COMMAND` — replace the built-in `pi-ralph-loop` RPC command entirely.
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
