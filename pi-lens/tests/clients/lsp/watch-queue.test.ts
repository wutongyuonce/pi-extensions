import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WATCH_DEBOUNCE_MS,
	WatchedFilesQueue,
	type WatchedFileChange,
} from "../../../clients/lsp/watch-queue.js";

/**
 * #271 — per-client debounced `workspace/didChangeWatchedFiles` batching.
 */
describe("WatchedFilesQueue (#271)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("coalesces a burst into ONE flush, last-type-wins, insertion order", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));

		// (uriA,Changed), (uriA,Changed), (uriB,Created)
		q.enqueue("file:///a", 2);
		q.enqueue("file:///a", 2);
		q.enqueue("file:///b", 1);

		expect(flushes).toHaveLength(0); // nothing sent before the window
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

		expect(flushes).toEqual([
			[
				{ uri: "file:///a", type: 2 },
				{ uri: "file:///b", type: 1 },
			],
		]);
	});

	it("last enqueue wins when a URI's type changes within the window", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 1); // Created
		q.enqueue("file:///a", 2); // …then Changed
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([[{ uri: "file:///a", type: 2 }]]);
	});

	it("flushes once after the window with no further enqueues", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 5); // long idle
		expect(flushes).toHaveLength(1);
	});

	it("does not flush before the debounce window elapses", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
		expect(flushes).toHaveLength(0);
	});

	it("re-arms for a second burst after a flush", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		q.enqueue("file:///b", 1);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([
			[{ uri: "file:///a", type: 2 }],
			[{ uri: "file:///b", type: 1 }],
		]);
	});

	it("cancel() drops the timer + pending changes without emitting", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		expect(q.size).toBe(1);
		q.cancel();
		expect(q.size).toBe(0);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 5);
		expect(flushes).toHaveLength(0);
	});

	it("manual flush() emits immediately and empties the queue", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		q.flush();
		expect(flushes).toEqual([[{ uri: "file:///a", type: 2 }]]);
		// the armed timer is cleared, so the window passing does not double-emit
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toHaveLength(1);
	});

	it("flush() on an empty queue is a no-op", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.flush();
		expect(flushes).toHaveLength(0);
	});
});
