#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

snapshots=(
  snapshots/app-factory-ai-cli.md
  snapshots/docs-factory-ai-cli-features-missions.md
  snapshots/factory-ai-news-missions.md
)
raws=(
  evidence/raw/app-factory-ai-cli.md
  evidence/raw/docs-factory-ai-cli-features-missions.md
  evidence/raw/factory-ai-news-missions.md
)

for index in "${!snapshots[@]}"; do
  file="${snapshots[$index]}"
  raw="${raws[$index]}"
  test -f "$raw"
  cmp -s "$file" "$raw"
done

for required in \
  INSTALL_FLOW.md \
  MISSIONS_FINDINGS.md \
  evidence/INDEX.md \
  OPEN_QUESTIONS.md \
  source-manifest.md \
  claim-evidence-checklist.md \
  expected-outputs.md; do
  test -s "$required"
done

for snapshot in "${snapshots[@]}"; do
  grep -Fq "$snapshot" MISSIONS_FINDINGS.md
  grep -Fq "$snapshot" claim-evidence-checklist.md
done

for raw in "${raws[@]}"; do
  grep -Fq "$raw" evidence/INDEX.md
  grep -Fq "$raw" expected-outputs.md
done

for source in \
  snapshots/app-factory-ai-cli.md \
  snapshots/docs-factory-ai-cli-features-missions.md \
  snapshots/factory-ai-news-missions.md \
  scripts/show-snapshots.sh \
  scripts/verify.sh; do
  grep -Fq "$source" source-manifest.md
done

grep -Fq 'Factory.ai' INSTALL_FLOW.md
! grep -Eq '(^|[^A-Z0-9])P[01]([^A-Z0-9]|$)' OPEN_QUESTIONS.md
