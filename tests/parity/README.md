# Parity harness

Run from the repo root:

```bash
python3 tests/parity/harness.py --implementation pi-ralph-loop --fixture research --fixture migrate
```

Fixtures live under `tests/fixtures/parity/`. The harness copies each fixture into a temporary task workspace, replays it, and writes the bundle root path when it finishes.
