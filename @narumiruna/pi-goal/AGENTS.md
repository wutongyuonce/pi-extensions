# Pi Goal Guidelines

## Continuations and lifecycle

- Record continuation intent at `agent_end`, and dispatch or retry it only after `agent_settled` proves the session idle.
- Use one owned cancellable task for the narrowly idle-gated manual-compaction fallback because `session_compact` fires before Pi clears its controller and does not emit `agent_settled`.
- Revalidate session and goal ownership after `pi.events.emit()` because sibling listeners can synchronously re-enter the extension.
- Record a tool-using turn's final usage at `tool_execution_end`, with `agent_end` as the no-tool fallback.
- Activate completed-goal successors and busy priority changes only at the settled idle boundary, and persist pending priority intent across reload.
- Classify only explicit quota, subscription, credit, or billing exhaustion as `usage_limited`; do not include rate limits, HTTP 429, or server failures.
- Keep external waits canonically active but continuation-ineligible, and exclude their quiet wall time from active elapsed accounting.
- Route wait deadlines through the settled continuation dispatcher, bind timers to exact session and Goal identity, and cancel them on every superseding transition and shutdown.
- Treat an extension message as Goal-owned only when its exact accepted prompt fingerprint or an accepted transformed-prompt boundary matches; quoted markers in external messages must still wake waiting work.

## Ownership and recovery

- Bind goal-owned markers to the originating goal ID and add a unique nonce when iterations can repeat.
- Restore failed-delivery state only while that prompt still owns the current goal.
- [UNREVIEWED] Keep Goal helper schemas stable from registration onward, and reject or pause when an external active-tool policy removes required helpers instead of changing the active tool set.
- Reject exhausted stopped goals before rotating their ID, and restore the original stopped state, ID, and stale-tool guard if `/goal resume` delivery fails.
- When blocking a Pi `tool_call` in a bounded flow, abort the turn too because a blocked tool result does not terminate agent-core.
