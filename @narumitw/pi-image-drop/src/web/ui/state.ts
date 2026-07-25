import type { BatchPhase, ItemStatus, PublicBatchState, PublicHistoryState } from "./types.js";

interface BatchLike {
	phase: BatchPhase | string;
	items?: Array<{ status?: ItemStatus | string }>;
	totalSourceBytes?: number;
}

interface HistoryLike {
	items?: unknown[];
	totalBytes?: number;
	maxImages?: number;
	maxBytes?: number;
}

export function summarizeBatch(batch: BatchLike) {
	const counts = { ready: 0, uploading: 0, error: 0 };
	for (const item of batch.items ?? []) {
		if (item.status === "ready") counts.ready += 1;
		else if (item.status === "error") counts.error += 1;
		else counts.uploading += 1;
	}
	return {
		...counts,
		total: (batch.items ?? []).length,
		bytes: Number(batch.totalSourceBytes ?? 0),
		label: statusLabel(batch.phase, counts, (batch.items ?? []).length),
	};
}

export function summarizeHistory(history?: HistoryLike) {
	const total = (history?.items ?? []).length;
	const bytes = Number(history?.totalBytes ?? 0);
	const maxImages = Number(history?.maxImages ?? 0);
	const maxBytes = Number(history?.maxBytes ?? 0);
	return {
		total,
		bytes,
		maxImages,
		maxBytes,
		label:
			total === 0
				? "No images sent yet"
				: `${total} ${plural(total, "image")} · ${formatBytes(bytes)}`,
		usage: `${total}/${maxImages} images · ${formatBytes(bytes)} of ${formatBytes(maxBytes)}`,
	};
}

const SHARED_METADATA_NOTE = "Sensitive image metadata removed";

export function draftPresentation(batch: BatchLike) {
	const summary = summarizeBatch(batch);
	return {
		status: summary.total === 0 ? "" : `${summary.label} · ${formatBytes(summary.bytes)}`,
		guidance: draftGuidance(batch),
	};
}

export function draftGuidance(batch: BatchLike): string {
	const summary = summarizeBatch(batch);
	if (batch.phase === "closed") return "This Pi session is no longer accepting images.";
	if (batch.phase === "reserved") {
		return "Queued with Pi. These images will be attached when Pi sends this message.";
	}
	if (summary.total === 0) return "Choose images to add them to your next Pi message.";
	if (summary.error > 0) {
		return `Fix or delete ${summary.error} ${plural(summary.error, "image")} that ${summary.error === 1 ? "needs" : "need"} attention before sending from Pi.`;
	}
	if (summary.uploading > 0) {
		return `Wait for ${summary.uploading} ${plural(summary.uploading, "image")} to finish processing before sending from Pi.`;
	}
	return `Return to Pi and send a non-empty message. ${summary.ready} ready ${plural(summary.ready, "image")} will be attached automatically.`;
}

export function statusLabel(
	phase: BatchPhase | string,
	counts: { ready: number; uploading: number; error: number },
	total: number,
): string {
	if (phase === "empty" || total === 0) return "No images staged";
	if (phase === "reserved") return `${total} ${plural(total, "image")} queued with Pi`;
	const parts = [`${counts.ready}/${total} ready`];
	if (counts.uploading > 0) parts.push(`${counts.uploading} uploading`);
	if (counts.error > 0) parts.push(`${counts.error} need attention`);
	return parts.join(" · ");
}

export function visibleItemNotes(notes: unknown): string[] {
	return Array.isArray(notes)
		? notes.filter(
				(note): note is string => typeof note === "string" && note !== SHARED_METADATA_NOTE,
			)
		: [];
}

export function moveItem(ids: readonly string[], id: string, direction: number): string[] {
	const from = ids.indexOf(id);
	if (from === -1) return [...ids];
	const to = Math.max(0, Math.min(ids.length - 1, from + direction));
	if (to === from) return [...ids];
	const next = [...ids];
	next.splice(from, 1);
	next.splice(to, 0, id);
	return next;
}

export function moveItemBefore(ids: readonly string[], id: string, targetId: string): string[] {
	if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return [...ids];
	const next = ids.filter((candidate) => candidate !== id);
	next.splice(next.indexOf(targetId), 0, id);
	return next;
}

export function canMutate(batch: Pick<PublicBatchState, "phase"> | { phase: string }): boolean {
	return batch.phase !== "reserved" && batch.phase !== "closed";
}

export function preferNewestState<T extends { batch: { revision: number } }>(
	current: T | undefined,
	next: T,
): T {
	if (!current || next.batch.revision >= current.batch.revision) return next;
	return current;
}

export async function attemptMutation<T>(
	operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		return { ok: false, error };
	}
}

export function formatBytes(value: number): string {
	const bytes = Math.max(0, Number(value) || 0);
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function plural(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

export type { PublicBatchState, PublicHistoryState };
