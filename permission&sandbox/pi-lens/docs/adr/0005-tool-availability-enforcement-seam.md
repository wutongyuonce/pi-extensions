# ADR 0005: tool availability is one seam by enforcement

## Status

Accepted — 2026-09-23

## Context

The availability policy and `createAvailabilityLatch` already define the shared
taxonomy, but nine stores answer the same “can this tool run, at what path?”
question. Migrating all stores at once is not justified by the evidence.

## Decision

Enforce one seam with a registry ratchet. A change touching a registered store
migrates that store onto the shared policy in the same change and removes it
from the registry; the registry never grows.

## Consequences

The population can shrink without speculative migration. The runner/formatter
mid-session uninstall divergence remains the first red slice under #1894.

## Links

- Catalog shape: `AGENTS.md` shape 52.
- Issue: #1894, rewritten 2026-09-22.
- Catalog PR: #3253.

