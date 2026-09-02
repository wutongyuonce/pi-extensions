---
section: Fixed
---

- **Honor runner language scope inside dispatch groups (closes #2353)** — grouped runners now use the same `appliesTo` contract as registry selection, so a runner cannot execute against a mismatched file kind and is recorded as skipped instead of failed.
