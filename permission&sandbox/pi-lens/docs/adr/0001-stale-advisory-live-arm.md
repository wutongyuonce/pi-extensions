# ADR 0001: stale advisory skips disposition policy

## Status

Accepted — 2026-09-23

## Context

The #3247 review found an asymmetry: the live turn-end arm applies disposition
policy, but the freshness arm that demotes dependency-drift records does not.
The stale arm drives delivery-count commits and bounded retirement, so changing
it would change the freshness gate's accounting rather than merely filter text.

## Decision

Apply disposition policy on the live arm only. Keep the stale advisory visible
with its stale marker and its existing bounded delivery accounting.

## Consequences

Marked findings in a stale record may remain in the bounded stale advisory.
This is deliberate and does not recreate the unbounded replay fixed by #3247.

## Links

- Catalog shape: `AGENTS.md` shape 10.
- Issue: #3246.
- PR: #3247, section “Known asymmetry: the stale arm does not run the policy”.

