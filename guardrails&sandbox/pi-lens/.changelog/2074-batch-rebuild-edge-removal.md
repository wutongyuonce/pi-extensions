---
section: Changed
---

- **Bound a multi-file review-graph rebuild's edge removal (refs #2074)** — `removeFileOwnedGraphData` now finds a changed file's owned edges through `edgesByFrom`/`edgesByTo`, batches adjacency-index removal once per touched bucket, and compacts the edge array once per batch. A multi-file rebuild previously scanned the whole edge array `changedFiles` times and rescanned high-fan-in buckets once per edge; it now keeps both costs proportional to touched buckets.
