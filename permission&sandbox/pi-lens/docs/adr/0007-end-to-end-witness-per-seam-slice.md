# ADR 0007: end-to-end witness per seam slice

## Status

Accepted — 2026-09-23

## Context

Seam umbrellas #1892, #1816, #1193, #1894, and #1844 need evidence that
survives adapter wiring and records both what the model receives and what the
degradation ledger recorded. The #3247 round-2 adapter tests establish the
shape through the pi and MCP turn-end surfaces.

## Decision

Every slice under those seam umbrellas adds one witness test through the real
host entry: pi `index.ts` `turn_end` to the runtime-context message, or the MCP
turn-end entry in `clients/mcp/session.ts`. The test commits the rendered
context message and degradation-ledger rows as a golden fixture under
`tests/fixtures/witness/<slice>/` and diffs it on every run. The witness is
owned by the #1605 lane umbrella. Process boundaries, including LSP servers
and tool binaries, use the real-wire fake server rather than a module mock.

## Consequences

Witnesses are the verifiable, repeatable artifact for each seam slice and
expose adapter drift at the host boundary. A witness is not the sole mechanism
at a process boundary: a module mock cannot prove argv, wire framing, process
lifecycle, or tool output, so those boundaries require the real-wire fake
server. In-process stores, sinks, coordinators, and dispatchers remain real.

## Links

- Umbrella: #1605.
- Seam slices: #1892, #1816, #1193, #1894, #1844.
- Shape: `tests/index-3246-turn-end-delivery.test.ts` and
  `tests/clients/mcp/session-inline-blocker-dispositions.test.ts`.
- Adapter evidence: #3247 round 2.
