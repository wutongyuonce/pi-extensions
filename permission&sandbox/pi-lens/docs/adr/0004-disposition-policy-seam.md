# ADR 0004: fold dispositions onto the policy seam

## Status

Accepted — 2026-09-23

## Context

The #1892 brief found freshness and disposition to be different gates with
different failure directions. The #3247 and #3254 slices showed that missing
turn-end disposition stages are existing-surface wiring gaps, not proof that a
new findings store is required.

## Decision

Fold disposition application onto `applyFindingPolicy` and its existing pushed
finding-policy seam. Do not introduce a new findings store until #1892 has a
measured structured-store slice with a deletion sweep.

## Consequences

Existing producers keep their freshness, identity, and coverage contracts while
delivery surfaces converge on the shared policy. A future store migration must
measure the request and delete parallel identity/count logic in the same slice.
The measured host-adapter population is two: the pi extension adapter activates
through `activateExtension` and assembles `HostPorts` in `index.ts:725-767`, and
the MCP server imports the host-neutral facade and serves requests in
`mcp/server.ts:40-45,1881`. `LensEngine` (`clients/lens-engine.ts:2`) and
`HostPorts` (`clients/host-ports.ts:10`) are the shared internal engine/ports
seam, not additional adapters. Because the heuristic says two adapters are a
real seam, #1358 (the ports layer) is **re-assess**, not held on a one-adapter
claim.

## Links

- Catalog shapes: `AGENTS.md` shapes 10 and 26.
- Issue/brief: #1892, 2026-09-22 brief.
- PRs: #3247 and #3254.
