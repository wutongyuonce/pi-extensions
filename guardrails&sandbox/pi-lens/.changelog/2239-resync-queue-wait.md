---
section: Fixed
---

- **Stop starving auxiliary LSP resyncs behind a cold primary spawn (closes #2239)** —
  the auxiliary resync queue wait now derives from the same effective
  per-server wait floor `getClientForFile` uses internally, instead of the
  caller's flat budget alone. A cold primary spawn that legitimately runs
  past that flat budget (Ruby's 30s override, and the Bash/JSON/Vue/Svelte/
  Prisma overrides from #2233) no longer zeroes the auxiliary's queue time
  and reports it uncovered on every such touch.
