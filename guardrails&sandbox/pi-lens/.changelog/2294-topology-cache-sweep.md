---
section: Changed
---

- **Registered-or-fail sweep for topology-derived caches (closes #2294)** — a conformance test enumerates every module that calls a workspace-topology probe seam (`getDirectoryMarkers`, `findNearestDirWithAnyBasename`, `findNearestProjectRoot`, and the rest of the canonical list) and asserts each either registers a downstream reset through `registerWorkspaceTopologyReset` or carries a documented freshness-key exemption. A future consumer that memoizes from a topology seam and forgets to register now fails the sweep instead of silently leveraging a push-only registry. No runtime behavior changes; the sweep is the compensating guard.