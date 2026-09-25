/**
 * #2442: behavior-preservation for `recentOldTextFailures` in
 * clients/read-guard-tool-lines.ts, migrated from a hand-rolled evict-oldest
 * Map to BoundedFifoMap. `trackOldTextFailure` writes unconditionally (no
 * delete-first refresh, matching the original), so a re-track of an
 * already-resident key does NOT move it, and a read (`_hasOldTextFailureForTests`)
 * must never reorder. No reset seam exists (module-global, process-lifetime
 * tracker) — each test uses a unique key prefix to stay isolated.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_FAILURE_TRACKER_SIZE,
	_hasOldTextFailureForTests,
	_trackOldTextFailureForTests,
} from "../../clients/read-guard-tool-lines.js";

describe("#2442 recentOldTextFailures (FIFO)", () => {
	it("evicts the single oldest (filePath, preview) pair once filled past capacity", () => {
		for (let i = 0; i < MAX_FAILURE_TRACKER_SIZE; i++) {
			_trackOldTextFailureForTests(`/repo/cap-${i}.ts`, "preview");
		}
		expect(_hasOldTextFailureForTests("/repo/cap-0.ts", "preview")).toBe(true);

		_trackOldTextFailureForTests("/repo/cap-overflow.ts", "preview");

		expect(_hasOldTextFailureForTests("/repo/cap-0.ts", "preview")).toBe(false);
		expect(_hasOldTextFailureForTests("/repo/cap-1.ts", "preview")).toBe(true);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_FAILURE_TRACKER_SIZE; i++) {
			_trackOldTextFailureForTests(`/repo/read-${i}.ts`, "preview");
		}
		// The observation has to go through the tracker's REAL read, which is
		// `recentOldTextFailures.get(key)` inside `trackOldTextFailure` — the
		// escalation counter (#2442 review F4). `_hasOldTextFailureForTests` is
		// a `.has()`, and `.has()` never reorders a BoundedLruCache either, so
		// the earlier version of this test passed under the very substitution
		// it claimed to catch. A repeat failure is also the production shape:
		// the escalation path is exactly a get-then-set of a resident key.
		expect(
			_trackOldTextFailureForTests("/repo/read-0.ts", "preview"),
		).toBeGreaterThan(1); // the get saw the previous entry: a real hit

		_trackOldTextFailureForTests("/repo/read-overflow.ts", "preview");

		// FIFO: the escalation neither promoted read-0 on the get nor on the
		// set, so read-0 is still the oldest and is the one evicted. Under an
		// LRU substitution BOTH assertions flip — read-0 survives and read-1,
		// never touched, is evicted in its place.
		expect(_hasOldTextFailureForTests("/repo/read-0.ts", "preview")).toBe(
			false,
		);
		expect(_hasOldTextFailureForTests("/repo/read-1.ts", "preview")).toBe(true);
	});

	it("escalates the count for a genuine repeat within the TTL window", () => {
		const first = _trackOldTextFailureForTests("/repo/escalate.ts", "preview");
		const second = _trackOldTextFailureForTests("/repo/escalate.ts", "preview");
		expect(first).toBe(1);
		expect(second).toBe(2);
	});
});
