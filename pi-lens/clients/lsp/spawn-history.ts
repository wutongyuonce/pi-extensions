/** Process-lifetime history of successful LSP spawn plus initialize durations. */

const MAX_SERVER_HISTORIES = 64;
const successfulSpawnDurationMs = new Map<string, number>();

export function recordSuccessfulLspSpawn(
	serverId: string,
	durationMs: number,
): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) return;
	successfulSpawnDurationMs.delete(serverId);
	successfulSpawnDurationMs.set(serverId, durationMs);
	while (successfulSpawnDurationMs.size > MAX_SERVER_HISTORIES) {
		const oldest = successfulSpawnDurationMs.keys().next().value;
		if (oldest === undefined) break;
		successfulSpawnDurationMs.delete(oldest);
	}
}

export function getSuccessfulLspSpawnDurationMs(
	serverId: string,
): number | undefined {
	return successfulSpawnDurationMs.get(serverId);
}

/** Test-only: isolate process-lifetime history between cases. */
export function _clearSuccessfulLspSpawnHistoryForTests(): void {
	successfulSpawnDurationMs.clear();
}
