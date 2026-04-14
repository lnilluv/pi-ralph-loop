#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

for file in \
  snapshots/app-factory-ai-cli.md \
  snapshots/docs-factory-ai-cli-features-missions.md \
  snapshots/factory-ai-news-missions.md; do
  printf '## %s\n' "$file"
  cat "$file"
  printf '\n'
done
