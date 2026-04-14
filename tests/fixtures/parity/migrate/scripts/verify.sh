#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

cmp -s golden/MIGRATED.md MIGRATED.md

grep -Fq 'legacy/source.md' MIGRATION_NOTES.md
grep -Fq 'legacy/source.yaml' MIGRATION_NOTES.md
grep -Fq 'scripts/show-legacy.sh' MIGRATION_NOTES.md
grep -Fq 'scripts/verify.sh' MIGRATION_NOTES.md
grep -Fq 'golden/MIGRATED.md' MIGRATION_NOTES.md

test -s MIGRATED.md
test -s MIGRATION_NOTES.md
