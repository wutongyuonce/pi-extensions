/**
 * #2442: behavior-preservation for `lspServers` in clients/widget-state.ts,
 * migrated from a hand-rolled evict-oldest Map to BoundedFifoMap. `recordLsp`
 * writes unconditionally (no delete-first refresh) so a re-record of an
 * already-resident key does NOT move it; `getFailedLspServerIds` (a read
 * over `.values()`) must never reorder eviction order.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_LSP_SERVER_RECORDS,
	clearWidgetState,
	getFailedLspServerIds,
	recordLsp,
} from "../../clients/widget-state.js";

afterEach(() => clearWidgetState());

describe("#2442 lspServers (FIFO)", () => {
	it("evicts the single oldest server record once filled past capacity", () => {
		for (let i = 0; i < MAX_LSP_SERVER_RECORDS; i++) {
			recordLsp(`server-${i}`, "/repo", "spawn_failed");
		}
		expect(getFailedLspServerIds()).toContain("server-0");

		recordLsp("server-overflow", "/repo", "spawn_failed");

		const ids = getFailedLspServerIds();
		expect(ids).not.toContain("server-0");
		expect(ids).toContain("server-1");
		expect(ids).toContain("server-overflow");
	});

	it("a re-record of the oldest server never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_LSP_SERVER_RECORDS; i++) {
			recordLsp(`read-${i}`, "/repo", "spawn_failed");
		}
		// `lspServers` has NO production `get` — every read is
		// `getFailedLspServerIds`'s `.values()` iteration, which reorders
		// nothing under either class, so iterating it proved nothing (#2442
		// review F4). The discriminating production access here is the WRITE
		// path: `recordLsp` on an already-resident key is a bare `set`, which
		// FIFO leaves in place and LRU promotes to newest.
		recordLsp("read-0", "/repo", "spawn_failed");

		recordLsp("read-overflow", "/repo", "spawn_failed");

		const ids = getFailedLspServerIds();
		// FIFO: the re-record did not move read-0, so it is still the oldest
		// and is evicted. Under an LRU substitution both flip — read-0 survives
		// and read-1, never re-recorded, is evicted instead.
		expect(ids).not.toContain("read-0");
		expect(ids).toContain("read-1");
	});
});
