/**
 * #2442: behavior-preservation for napiFallbackCoverage, the second
 * `keys().next().value` evict-oldest site in clients/lsp/pending-aux-coverage
 * .ts, migrated to BoundedFifoMap. `recordNapiFallbackCoverage` does its own
 * delete+set to refresh recency on a re-record (the module's own doc comment
 * says "Bounded like the pending-pair store itself; oldest evicted first"),
 * while `napiFallbackCoveredSince` (a plain `get`) must never reorder.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_NAPI_COVERAGE_ENTRIES,
	napiFallbackCoveredSince,
	recordNapiFallbackCoverage,
	resetNapiFallbackCoverageForTests,
} from "../../../clients/lsp/pending-aux-coverage.js";

afterEach(() => resetNapiFallbackCoverageForTests());

describe("#2442 napiFallbackCoverage (FIFO, write-refresh)", () => {
	it("evicts the single oldest file once filled past capacity", () => {
		for (let i = 0; i < MAX_NAPI_COVERAGE_ENTRIES; i++) {
			recordNapiFallbackCoverage(`/w/file${i}.ts`, 1000 + i);
		}
		expect(napiFallbackCoveredSince("/w/file0.ts", 0)).toBe(true);

		recordNapiFallbackCoverage("/w/overflow.ts", 9999);

		expect(napiFallbackCoveredSince("/w/file0.ts", 0)).toBe(false);
		expect(napiFallbackCoveredSince("/w/file1.ts", 0)).toBe(true);
		expect(napiFallbackCoveredSince("/w/overflow.ts", 0)).toBe(true);
	});

	it("a read (napiFallbackCoveredSince) never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_NAPI_COVERAGE_ENTRIES; i++) {
			recordNapiFallbackCoverage(`/w/read${i}.ts`, 1000 + i);
		}
		for (let i = 0; i < 5; i++) napiFallbackCoveredSince("/w/read0.ts", 0);

		recordNapiFallbackCoverage("/w/read-overflow.ts", 9999);

		expect(napiFallbackCoveredSince("/w/read0.ts", 0)).toBe(false);
	});

	it("a re-record of an already-resident key refreshes recency", () => {
		for (let i = 0; i < MAX_NAPI_COVERAGE_ENTRIES; i++) {
			recordNapiFallbackCoverage(`/w/refresh${i}.ts`, 1000 + i);
		}
		recordNapiFallbackCoverage("/w/refresh0.ts", 5000); // re-record: refresh

		recordNapiFallbackCoverage("/w/refresh-overflow.ts", 9999);

		expect(napiFallbackCoveredSince("/w/refresh0.ts", 0)).toBe(true);
		expect(napiFallbackCoveredSince("/w/refresh1.ts", 0)).toBe(false);
	});
});
