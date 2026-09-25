# ADR 0002: workspace hash is a rendezvous derivation

## Status

Accepted — 2026-09-23

## Context

`workspaceHash` names the warm IPC endpoint and turn-end status file. Separate
processes derive it at different times and must reproduce identical bytes.
Path-map normalizers can consult filesystem state, so they cannot be used for
this cross-process rendezvous.

## Decision

Keep `workspaceHash` as pure string math. Neither the long-lived canonical path
key nor the process-local ephemeral path-key seam applies.

## Consequences

The derivation remains independently reproducible and avoids filesystem-state
staleness. Its deliberate lowercase fold can collide for case-distinct POSIX
directories; changing those bytes requires a separate invalidation decision.

## Links

- Catalog shapes: `AGENTS.md` shapes 1 and 2.
- Issue: #3255.
- PR: #3256; source record: `clients/mcp/ipc.ts:44-77`.

