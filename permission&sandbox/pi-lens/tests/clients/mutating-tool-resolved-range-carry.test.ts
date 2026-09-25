/**
 * #2442: behavior-preservation for RESOLVED_RANGE_CARRY, one of the two
 * evict-oldest sites #2432's round-3 review named as hand-rolled. FIFO,
 * migrated to BoundedFifoMap — the module's own doc comment says reads must
 * NOT consume the entry (several call sites classify the same event), so
 * `readCarriedRanges` (a plain `get`) must never reorder eviction order.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	RESOLVED_RANGE_CARRY_LIMIT_FOR_TESTS,
	_carryResolvedRangesForTests,
	_hasCarriedRangeForTests,
	_resetMutationRangeCarryForTests,
} from "../../clients/mutating-tool.js";

afterEach(() => _resetMutationRangeCarryForTests());

describe("#2442 RESOLVED_RANGE_CARRY (FIFO)", () => {
	it("evicts the single oldest toolCallId once filled past capacity", () => {
		for (let i = 0; i < RESOLVED_RANGE_CARRY_LIMIT_FOR_TESTS; i++) {
			_carryResolvedRangesForTests(`call-${i}`, [1, 2]);
		}
		expect(_hasCarriedRangeForTests("call-0")).toBe(true);

		_carryResolvedRangesForTests("call-overflow", [1, 2]);

		expect(_hasCarriedRangeForTests("call-0")).toBe(false);
		expect(_hasCarriedRangeForTests("call-1")).toBe(true);
		expect(_hasCarriedRangeForTests("call-overflow")).toBe(true);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < RESOLVED_RANGE_CARRY_LIMIT_FOR_TESTS; i++) {
			_carryResolvedRangesForTests(`read-${i}`, [1, 2]);
		}
		// Read the oldest entry repeatedly — an LRU get() would move it to MRU
		// and it would survive the overflow below; a FIFO get() must not.
		for (let i = 0; i < 5; i++) _hasCarriedRangeForTests("read-0");

		_carryResolvedRangesForTests("read-overflow", [1, 2]);

		expect(_hasCarriedRangeForTests("read-0")).toBe(false);
		expect(_hasCarriedRangeForTests("read-1")).toBe(true);
	});
});
