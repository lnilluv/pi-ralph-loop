# Release checklist

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm pack --dry-run`
  - Confirm the tarball includes `src/`, `skills/`, `presets/`, `examples/`, and `README.md`.
- [ ] Manual Pi smoke test from the packed tarball or a clean worktree
  - Commands are registered.
  - Skills are discovered.
  - `/ralph-scaffold --preset fix-tests smoke-test` creates a scaffold.
- [ ] `npm audit --omit=dev`
  - Record any findings for review; do not auto-fix without checking the impact.
