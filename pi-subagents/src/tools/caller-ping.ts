import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optionalRequire } from "./optional-dependency.ts";
import { CALLER_PING_TOOL_NAME } from "./tool-names.ts";

// ctx.shutdown() cannot interrupt a model that keeps emitting tool calls inside
// one response, so a ping arms a hard backstop: the sidecar is already durable
// on disk, and exiting 0 lets the parent deliver the ping instead of watching a
// looping child run forever.
export const CALLER_PING_FORCED_EXIT_DELAY_MS = 750;

export interface CallerPingState {
	count: number;
	exitTimer: ReturnType<typeof setTimeout> | undefined;
	// An operator takeover suppresses the ping kill; /auto-exit clears the
	// suppression because the operator just re-enabled autonomous closing.
	exitSuppressed: boolean;
	outcomeDurable: boolean;
}

export function createCallerPingState(): CallerPingState {
	return { count: 0, exitTimer: undefined, exitSuppressed: false, outcomeDurable: false };
}

export function armCallerPingExit(state: CallerPingState) {
	state.exitTimer ??= setTimeout(() => {
		state.exitTimer = undefined;
		// Re-check at fire time: an operator who took over during the
		// delay owns the pane, and the takeover path also cleared this
		// timer — this guard is defense in depth for that race.
		if (state.exitSuppressed) return;
		// ctx.shutdown() cannot stop a model that keeps emitting tool
		// calls inside one response. The ping sidecar is durable, so a
		// hard exit 0 is what actually delivers it to the parent.
		process.exit(0);
	}, CALLER_PING_FORCED_EXIT_DELAY_MS);
}

/** Operator takeover: the pane is theirs; cancel any pending hard exit. */
export function suppressCallerPingExit(state: CallerPingState) {
	state.exitSuppressed = true;
	if (state.exitTimer) {
		clearTimeout(state.exitTimer);
		state.exitTimer = undefined;
	}
}

/** /auto-exit re-enabled autonomous closing: deliver a durable ping again. */
export function rearmCallerPingExitAfterReenable(state: CallerPingState) {
	if (state.outcomeDurable && state.exitSuppressed) {
		state.exitSuppressed = false;
		armCallerPingExit(state);
	}
}

export interface CallerPingDeps {
	writeExitSignal: (payload: object, opts?: { supersede?: boolean }) => "accepted" | "owned" | "no-session";
	requestShutdown: (ctx: { shutdown: () => void }) => void;
	getOutputTokens: () => number;
}

function buildCallerPingParams() {
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	return typebox?.Type?.Object
		? typebox.Type.Object({
				message: typebox.Type.String({
					description: "What you need help with",
				}),
			})
		: {
				type: "object",
				properties: {
					message: { type: "string", description: "What you need help with" },
				},
				required: ["message"],
				additionalProperties: false,
			};
}

/**
 * caller_ping is registered for most agents as an escape hatch.
 * Only interactive agents with autoExit: false don't get it —
 * the operator is in the pane and can handle things directly.
 */
export function registerCallerPingTool(pi: ExtensionAPI, state: CallerPingState, deps: CallerPingDeps) {
	pi.registerTool({
		name: CALLER_PING_TOOL_NAME,
		label: "Caller Ping",
		description:
			"Ask the launching chat for help, send your message there, then close this helper session. " +
			"The launching chat can later send follow-up instructions to continue this helper. Call it once.",
		parameters: buildCallerPingParams(),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (!sessionFile) {
				throw new Error(
					"caller_ping is only available in subagent contexts. " +
						"PI_SUBAGENT_SESSION environment variable is not set.",
				);
			}

			state.count += 1;
			// The count is attempts, not deliveries: a first ping refused
			// because a done/error outcome already owns this child still
			// one-shots the tool for the rest of this process.
			if (state.count > 1) {
				throw new Error(
					"caller_ping already ran for this session. This session is closing; " +
						"the launching chat will follow up with further instructions. Do not call caller_ping again.",
				);
			}

			const pingWrite = deps.writeExitSignal(
				{
					type: "ping",
					name: process.env.PI_SUBAGENT_NAME ?? "subagent",
					message: params.message,
					outputTokens: deps.getOutputTokens(),
				},
				{ supersede: true },
			);
			deps.requestShutdown(ctx);
			// "no-session" is unreachable here: the sessionFile guard above
			// already threw for a missing subagent context.
			state.outcomeDurable = true;
			// Both "accepted" and "owned" mean a durable verdict exists for the
			// parent to consume on exit, and ctx.shutdown() alone cannot enforce
			// that exit — so the backstop arms either way.
			armCallerPingExit(state);
			if (pingWrite === "owned") {
				// A done or error outcome already owns this child, so the parent
				// will see that verdict, not a ping. Say so instead of pretending.
				return {
					content: [
						{
							type: "text",
							text: "A final outcome was already recorded for this session; it is closing now. Do not call caller_ping again.",
						},
					],
					details: {},
				};
			}
			return {
				content: [
					{
						type: "text",
						text: "Ping sent. Parent will be notified. This session is closing; do not call caller_ping again.",
					},
				],
				details: {},
			};
		},
	});
}
