// Event forwarder (spec §6.7): maps normalized pi session events to the
// outbox / live channel / progress card according to ForwardConfig.
// Dependencies are injected (outbox, liveChannel, sink callbacks) so this
// module is fully unit-testable without the pi SDK.

import type { ForwardConfig, OutboundEnvelope, RouteRef } from "../common/types.js";

export interface SessionEventBase {
	type: string;
}

export type ForwardEvent =
	| { type: "text_delta"; delta: string; cardId: string }
	| { type: "reasoning_delta"; delta: string; cardId: string }
	| { type: "tool_start"; toolName: string; detail?: string; runId: string }
	| { type: "tool_end"; toolName: string; runId: string }
	| { type: "progress"; phase: string; runId: string }
	| {
			type: "turn_end";
			finalText: string;
			cardId?: string;
			assistantMsgId: string;
	  };

export interface TurnContext {
	key: string;
	route: RouteRef;
	sessionId: string;
	runId: string;
	/** Set when a streaming card was created for this turn. */
	streamCardId?: string;
}

export interface EventForwarderDeps {
	getConfig: () => ForwardConfig;
	enqueue: (
		partial: Omit<
			OutboundEnvelope,
			"id" | "status" | "attempts" | "nextRetryAt" | "createdAt"
		>,
	) => Promise<unknown>;
	liveDelta: (cardId: string, delta: string) => void;
	liveContent: (cardId: string, content: unknown) => void;
	onProgress?: (ctx: TurnContext, phase: string) => void;
}

function dedupeKey(prefix: string, ctx: TurnContext, id: string): string {
	return `${prefix}:${ctx.sessionId}:${id}`;
}

export class EventForwarder {
	private readonly deps: EventForwarderDeps;

	constructor(deps: EventForwarderDeps) {
		this.deps = deps;
	}

	async handle(event: ForwardEvent, ctx: TurnContext): Promise<void> {
		const cfg = this.deps.getConfig();
		switch (event.type) {
			case "text_delta": {
				if (cfg.streaming.enabled) {
					this.deps.liveDelta(event.cardId, event.delta);
				}
				return;
			}
			case "reasoning_delta": {
				if (cfg.reasoning.mode === "card") {
					this.deps.liveDelta(event.cardId, event.delta);
				}
				return;
			}
			case "tool_start":
			case "tool_end": {
				if (cfg.toolCalls.mode === "off") return;
				const text =
					event.type === "tool_start"
						? `⚙️ ${event.toolName}${event.detail ? `: ${event.detail}` : ""}`
						: `✅ ${event.toolName}`;
				if (cfg.toolCalls.mode === "detail") {
					await this.deps.enqueue({
						dedupeKey: dedupeKey(
							"tool",
							ctx,
							`${event.runId}:${event.toolName}:${event.type}`,
						),
						laneKey: ctx.key,
						route: ctx.route,
						kind: "tool",
						payload: { type: "text", text },
					});
				} else {
					// summary mode → progress card line
					this.deps.onProgress?.(ctx, text);
				}
				return;
			}
			case "progress": {
				if (cfg.progress.enabled) {
					this.deps.onProgress?.(ctx, event.phase);
				}
				return;
			}
			case "turn_end": {
				// Final answer: always durable via outbox (kind=final). When a stream
				// card exists, the outbox sender patches it with the final text
				// (unconditional finalize, ADR-10).
				await this.deps.enqueue({
					dedupeKey: dedupeKey("final", ctx, event.assistantMsgId),
					laneKey: ctx.key,
					route: ctx.route,
					kind: "final",
					payload: {
						type: "text",
						text: event.finalText,
						cardId: event.cardId ?? ctx.streamCardId,
					},
				});
				return;
			}
		}
	}
}
