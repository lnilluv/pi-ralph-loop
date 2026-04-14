# Research Source Manifest

Frozen sources for the Factory.ai research fixture.

## Checked-in snapshot sources

| Path | SHA-256 | Purpose |
| --- | --- | --- |
| `snapshots/app-factory-ai-cli.md` | `2e05c955f02a7f363cb34eab1bd16a2c35e0aee8d720fb7d15eec9b926c7bb95` | Canonical app-facing public surface |
| `snapshots/docs-factory-ai-cli-features-missions.md` | `588ca106d5d2ea42f908745c39d517594f6c61e0fe8cd3b8660257aab5002b75` | CLI feature page and Missions guidance |
| `snapshots/factory-ai-news-missions.md` | `8cdfbe84f96c1521f114172204f7be41b64b24dea6c90e15be3f2a279a3b0cfc` | Launch announcement / independent citation |

## Checked-in helper scripts

| Path | SHA-256 | Purpose |
| --- | --- | --- |
| `scripts/show-snapshots.sh` | `ec99441bb5a0835e350908c0fb3425fe8a7a9d625dd71b844a522b4f05f4f957` | Prints the frozen snapshots verbatim |
| `scripts/verify.sh` | `c97b07f393110101e3aa09a8c9fa3ee530fb975d6018e65dd250152320f25a5f` | Verifies the frozen fixture outputs |

These files are the immutable inputs for the research pass. Refreshing them from live docs would break the fixture.
