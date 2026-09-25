/** Process-lifetime history of successful LSP spawn plus initialize durations. */
import { BoundedFifoMap } from "../bounded-cache.js";

const MAX_SERVER_HISTORIES = 64;
const successfulSpawnDurationMs = new BoundedFifoMap<string, number>(
	MAX_SERVER_HISTORIES,
);

export function recordSuccessfulLspSpawn(
	serverId: string,
	durationMs: number,
): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) return;
	successfulSpawnDurationMs.delete(serverId);
	successfulSpawnDurationMs.set(serverId, durationMs);
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
