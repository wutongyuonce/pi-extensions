# HISTORY

Completed arcs and dissolved sections moved out of `AGENTS.md` by the
2026-08-25 reorganization. Nothing here changes a future decision; the live
guidance those sections carried stayed in `AGENTS.md`.

- **Current version / state (dissolved).** The section carried a version
  number that had gone stale (it read v3.8.74 while the repo was at v4.1.2).
  `CHANGELOG.md` owns version and release history; the section's two live
  invariants (#1306 formatter policy, #833 markdownlint default config) moved
  to "Standing invariants: dispatch". Its own instruction survives: do not
  refill AGENTS.md with a highlights list.
- **Async-spawn migration (#197)** completed; the deliberate sync residue and
  its mocking guidance remain live in AGENTS.md under the same heading.
