---
section: Fixed
---

- **Run review-graph changed-symbols and entity snapshots under one normalized key per file (refs #2355)** — the session-fact key for a file's changed symbols was written under the agent-supplied spelling, while the review-graph builder read it under `normalizeMapKey`, so a case- or separator-variant path (`src/Target.ts` written, `src/target.ts` read) never hit its own write and the family sat write-only. The entity snapshot used a raw key on both sides, which forked a second empty snapshot when the same file arrived under a re-spelled path and inverted every symbol to `added`, scheduling a blast-radius run for a file nothing changed. Both keys now fold through `normalizeMapKey` at write and read, matching the #210/#1020 raw-path-key discipline.