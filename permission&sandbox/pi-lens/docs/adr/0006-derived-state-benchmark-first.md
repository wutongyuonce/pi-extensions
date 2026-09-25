# ADR 0006: benchmark before a derived-state cache

## Status

Accepted — 2026-09-23

## Context

The staleness arc fixed caches whose invalidation keys could not express the
truth. For signatures, line counts, hashes, and import graphs, a bounded
request-local recompute can remove that invalidation surface. Tool-run caches
are a separate class because the expensive operation is the tool run.

## Decision

Do not add a cross-request derived-state cache until a fresh-process benchmark
shows that request-local recomputation is the cost. A justified cache carries
the generation from which it was derived.

## Consequences

Cheap derived state has no stale cache to invalidate. Any future cache needs a
benchmark with a control row, explicit freshness axes, and a measured reason
that the request-local pass is insufficient.

## Links

- Catalog shape: `AGENTS.md` shape 51.
- Issue: #1644 closure decision, 2026-09-22.
- PR: #3253.

