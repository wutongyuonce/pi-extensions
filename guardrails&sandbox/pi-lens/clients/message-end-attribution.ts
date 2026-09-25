/** Session-local attribution captured before a stale message_end can drain. */

let lastStableSessionId: string | undefined;
let previousSessionId: string | undefined;

/** Remember the stable id used by a live message_end's own cache row. */
export function noteLiveMessageEndSessionId(
	sessionId: string | undefined,
): void {
	lastStableSessionId = sessionId;
}

/** Return the newest usable id for a stale message_end attribution. */
export function getLastLiveMessageEndSessionId(): string | undefined {
	return lastStableSessionId ?? previousSessionId;
}

/**
 * Rotate the attribution anchor at the real session boundary. A queued stale
 * message_end from the session being replaced may drain after this boundary,
 * so retain exactly one prior anchor while making room for the replacement.
 */
export function rotateMessageEndAttribution(): void {
	// Keep the prior anchor when no live message_end arrived this session:
	// two back-to-back boundaries (reload/resume re-announcing) must not
	// erase the only id a still-queued stale drain can use (#1956 R10).
	if (lastStableSessionId !== undefined) {
		previousSessionId = lastStableSessionId;
	}
	lastStableSessionId = undefined;
}

/** Full reset seam used by the session-state registry and test isolation. */
export function resetMessageEndAttribution(): void {
	lastStableSessionId = undefined;
	previousSessionId = undefined;
}
