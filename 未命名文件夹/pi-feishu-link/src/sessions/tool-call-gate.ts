// Tool-call gate (spec §6.15 wiring, C1 fix): turns pi's `tool_call` event
// into a PermissionBridge decision and BLOCKS the tool until a Feishu
// approval card resolves (or times out). Pure enough to unit-test with fake
// deps; index.ts wires it to the real PermissionBridge + ConversationManager.

import type { PermissionBridge } from "./permission-bridge.js";
import type { ApprovalVerdict } from "./permission-bridge.js";

export interface ToolCallGateDeps {
	getPermissionBridge(): PermissionBridge | undefined;
	/** Reverse lookup: bridge sessionId → conversation key (undefined = not a bridge session). */
	getConversations():
		| { keyForSessionId(sessionId: string): string | undefined }
		| undefined;
	approvalTimeoutMs: number;
	/** Called when a tool was denied / timed out (user-facing notice). */
	notifyDenied?(key: string, toolName: string, reason: string): void;
	/** Stash toolCallId → conversation key for tools like feishu_send_local_file. */
	recordToolSession?(toolCallId: string, key: string): void;
}

export interface ToolCallEventLike {
	toolCallId: string;
	toolName: string;
	input?: Record<string, unknown>;
}

export interface ToolCallCtxLike {
	sessionManager: { getSessionId(): string };
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

const SAFETY_RACE_MS = 5000;

/**
 * Build a pi `tool_call` handler (model v1.3):
 *  - non-bridge sessions pass through untouched (TUI keeps its own flow)
 *  - safe tools (autoApprove/session allowlist) pass
 *  - blacklist items and strict-mode non-safe tools → ask: hold the tool
 *    until the Feishu approval card resolves; deny/timeout → block with a
 *    user-facing reason.
 */
export function createToolCallHandler(deps: ToolCallGateDeps) {
	return async (
		event: ToolCallEventLike,
		ctx: ToolCallCtxLike,
	): Promise<ToolCallResult | undefined> => {
		const conversations = deps.getConversations();
		const bridge = deps.getPermissionBridge();
		if (!conversations || !bridge) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const key = conversations.keyForSessionId(sessionId);
		if (!key) return undefined;

		const paramsText = JSON.stringify(event.input ?? {});
		deps.recordToolSession?.(event.toolCallId, key);

		const isGroup = key.startsWith("group:") || key.startsWith("topic:");

		const result = await bridge.gate({
			key,
			toolName: event.toolName,
			paramsText,
			isGroup,
		});
		if (result.decision === "allow") return undefined;
		// ask: wait for the approval card.
		if (!result.approvalId || !result.verdict) {
			return { block: true, reason: "审批已失效，请重试" };
		}
		const verdict = await raceVerdict(
			result.verdict,
			deps.approvalTimeoutMs + SAFETY_RACE_MS,
		);
		if (verdict === "approved") return undefined;
		const reason = verdict === "denied" ? "已被拒绝" : "审批超时，已自动拒绝";
		deps.notifyDenied?.(key, event.toolName, reason);
		return { block: true, reason };
	};
}

async function raceVerdict(
	verdict: Promise<ApprovalVerdict>,
	timeoutMs: number,
): Promise<ApprovalVerdict> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<ApprovalVerdict>((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([verdict, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
