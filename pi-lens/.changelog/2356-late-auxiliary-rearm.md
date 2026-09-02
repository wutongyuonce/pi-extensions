---
section: Fixed
---

- **Re-arm late auxiliary coverage after notify-stall teardown (refs #2356)** —
  pending pairs survive temporary client absence, re-raise a bounded scanner
  coverage gap when replacement does not arrive, and correlate demotion state
  with each pair generation.
