---
section: Fixed
---

- **Remove the unused runner default declaration (closes #2354)** — runner availability remains controlled by dispatch groups and explicit feature gates, so definitions no longer claim an `enabledByDefault` behavior that dispatch never enforced.
