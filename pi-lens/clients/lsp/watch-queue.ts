/**
 * Debounced `workspace/didChangeWatchedFiles` batching (#271).
 *
 * `handleNotifyOpen` previously sent one `workspace/didChangeWatchedFiles` per
 * file as each was opened. Many servers (TypeScript, …) kick off a project-wide
 * re-analysis on every such notification, so a turn that edits N files in one
 * project triggered ~N full re-analyses. This per-client queue coalesces the
 * changes within a short window and flushes them as a SINGLE notification, so the
 * server re-indexes once per burst instead of once per file.
 *
 * One queue lives per LSP client (= per serverId+root), so batching is naturally
 * scoped to a single server/project. Worst-case added latency before the server
 * learns of a change is the debounce window — negligible against the multi-second
 * re-analysis it gates.
 */

/** LSP `FileChangeType`: 1 Created, 2 Changed, 3 Deleted. */
export interface WatchedFileChange {
	uri: string;
	type: number;
}

export const WATCH_DEBOUNCE_MS = 100;

export class WatchedFilesQueue {
	// uri → latest FileChangeType. A Map collapses repeated events for the same
	// URI (last-type-wins) while preserving first-seen insertion order.
	private readonly pending = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly flushFn: (changes: WatchedFileChange[]) => void,
		private readonly debounceMs: number = WATCH_DEBOUNCE_MS,
	) {}

	/** Queue a change; arms the debounce timer if not already pending. */
	enqueue(uri: string, type: number): void {
		this.pending.set(uri, type);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), this.debounceMs);
		// Never hold the event loop open for a pending watched-files flush.
		this.timer.unref?.();
	}

	/** Emit all queued changes as one notification (no-op when empty). */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) return;
		const changes: WatchedFileChange[] = [...this.pending.entries()].map(
			([uri, type]) => ({ uri, type }),
		);
		this.pending.clear();
		this.flushFn(changes);
	}

	/** Drop the timer + any queued changes without emitting (client teardown). */
	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
	}

	/** Number of distinct URIs currently queued (for tests/introspection). */
	get size(): number {
		return this.pending.size;
	}
}
