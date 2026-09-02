---
section: Fixed
---

- **Coalesce superseded LSP document notifications (refs #2357)** — same-file
  `didOpen` and `didChange` bursts now keep only the newest unwritten entry,
  preserve started writes and different-file ordering, and record the bounded
  coalesced count in `lsp_document_send` telemetry.
