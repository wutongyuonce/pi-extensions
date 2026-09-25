---
section: Changed
---

- **Govern lsp-spawn-heavy lane membership (refs #2344).** A registered-or-fail sweep now derives lsp-spawn-heavy candidacy from the real spawn seams and fails when a new real-LSP-spawn test lands in the default vitest project without a documented exemption. The dispatch LSP real-runner suite and the plain-`npm test` integration suite join the lane, and each detector marker has an independent synthetic proof.
