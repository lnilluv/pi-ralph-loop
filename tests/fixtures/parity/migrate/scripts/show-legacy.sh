#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

for file in legacy/source.md legacy/source.yaml; do
  printf '## %s\n' "$file"
  cat "$file"
  printf '\n'
done
