/**
 * Shared builders for the five event payloads pi-lens's tests fire through
 * `PiMock.emit(eventName, payload, ctx)` — #1681 acceptance criterion 3.
 *
 * Each builder's field set is derived from the pinned host contract (see
 * `host-event-shape-scan.ts`'s doc comment for the file:line citations into
 * `packages/coding-agent/src/core/extensions/types.ts`), so a call site that
 * only ever goes through these cannot drift into a host-unfaithful shape.
 * These are optional, not mandatory: existing tests may keep constructing a
 * payload literal by hand (the scan in `host-event-shape-scan.ts` still
 * catches a drift either way), but a NEW suite should prefer these over a
 * hand-rolled literal.
 *
 * `sessionId`/`provider`/`model` are deliberately not parameters here — the
 * host never puts them on any of these five events. A test that needs one
 * passes it to `makeCtx({ sessionId, model })` (`tests/support/pi-mock.ts`)
 * instead, which is where the host actually carries it.
 */

export interface SessionStartEventFixture {
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

/** `SessionStartEvent` — `types.ts:561-568`. Defaults to a fresh "startup". */
export function makeSessionStartEvent(
	overrides: Partial<SessionStartEventFixture> = {},
): SessionStartEventFixture {
	const event: SessionStartEventFixture = {
		reason: overrides.reason ?? "startup",
	};
	if (overrides.previousSessionFile !== undefined) {
		event.previousSessionFile = overrides.previousSessionFile;
	}
	return event;
}

export interface ToolCallEventFixture {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

/** `ToolCallEventBase` plus its per-tool variants — `types.ts:869-872`. */
export function makeToolCallEvent(
	overrides: Partial<ToolCallEventFixture> = {},
): ToolCallEventFixture {
	return {
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "read",
		input: overrides.input ?? {},
	};
}

export interface ToolResultEventFixture {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError: boolean;
	usage?: unknown;
}

/**
 * `ToolResultEventBase` — `types.ts:930-939`, pinned against the host's own
 * compiled build by `tests/clients/pi-host-contract.test.ts`'s
 * `HOST_TOOL_RESULT_KEYS`.
 */
export function makeToolResultEvent(
	overrides: Partial<ToolResultEventFixture> = {},
): ToolResultEventFixture {
	const event: ToolResultEventFixture = {
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "read",
		input: overrides.input ?? {},
		content: overrides.content ?? [{ type: "text", text: "" }],
		isError: overrides.isError ?? false,
	};
	if (overrides.details !== undefined) event.details = overrides.details;
	if (overrides.usage !== undefined) event.usage = overrides.usage;
	return event;
}

export interface AgentEndEventFixture {
	messages: unknown[];
}

/** `AgentEndEvent` — `types.ts:733-736`. */
export function makeAgentEndEvent(
	overrides: Partial<AgentEndEventFixture> = {},
): AgentEndEventFixture {
	return { messages: overrides.messages ?? [] };
}

/** `AgentSettledEvent` — `types.ts:739-741`. No fields beyond `type`. */
export function makeAgentSettledEvent(): Record<string, never> {
	return {};
}
