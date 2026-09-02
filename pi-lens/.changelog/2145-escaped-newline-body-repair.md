---
section: Fixed
---

- **Normalize escaped-newline flattened PR bodies for checking (refs #2145)** — a body can arrive with the literal two-character sequence `\\n` (or `\\r\\n`) standing in for a real line break, burying close keywords and section headings. The shared live-body read seam restores high-confidence joins only in memory, warns that the original body was not edited, and preserves genuine `\\n` content inside inline code spans. Strict live-body fetch failures remain fail-closed for close-keyword checks. This change withdraws the auto-repair behavior shipped in v4.1.3; the checks never edit pull request bodies.
