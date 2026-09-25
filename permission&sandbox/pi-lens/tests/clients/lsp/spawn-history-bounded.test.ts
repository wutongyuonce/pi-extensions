/**
 * #2442: behavior-preservation for successfulSpawnDurationMs in
 * clients/lsp/spawn-history.ts, migrated from a hand-rolled evict-oldest Map
 * to BoundedFifoMap. `recordSuccessfulLspSpawn` does its own delete+set to
 * refresh recency on a re-record; `getSuccessfulLspSpawnDurationMs` (a plain
 * `get`) must never reorder.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	_clearSuccessfulLspSpawnHistoryForTests,
	getSuccessfulLspSpawnDurationMs,
	recordSuccessfulLspSpawn,
} from "../../../clients/lsp/spawn-history.js";

const MAX_SERVER_HISTORIES = 64;

afterEach(() => _clearSuccessfulLspSpawnHistoryForTests());

describe("#2442 successfulSpawnDurationMs (FIFO, write-refresh)", () => {
	it("evicts the single oldest server once filled past capacity", () => {
		for (let i = 0; i < MAX_SERVER_HISTORIES; i++) {
			recordSuccessfulLspSpawn(`server-${i}`, 100 + i);
		}
		expect(getSuccessfulLspSpawnDurationMs("server-0")).toBe(100);

		recordSuccessfulLspSpawn("server-overflow", 9999);

		expect(getSuccessfulLspSpawnDurationMs("server-0")).toBeUndefined();
		expect(getSuccessfulLspSpawnDurationMs("server-1")).toBe(101);
		expect(getSuccessfulLspSpawnDurationMs("server-overflow")).toBe(9999);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_SERVER_HISTORIES; i++) {
			recordSuccessfulLspSpawn(`read-${i}`, 100 + i);
		}
		for (let i = 0; i < 5; i++) getSuccessfulLspSpawnDurationMs("read-0");

		recordSuccessfulLspSpawn("read-overflow", 9999);

		expect(getSuccessfulLspSpawnDurationMs("read-0")).toBeUndefined();
	});

	it("a re-record of an already-resident server refreshes recency", () => {
		for (let i = 0; i < MAX_SERVER_HISTORIES; i++) {
			recordSuccessfulLspSpawn(`refresh-${i}`, 100 + i);
		}
		recordSuccessfulLspSpawn("refresh-0", 500); // re-record: refresh

		recordSuccessfulLspSpawn("refresh-overflow", 9999);

		expect(getSuccessfulLspSpawnDurationMs("refresh-0")).toBe(500);
		expect(getSuccessfulLspSpawnDurationMs("refresh-1")).toBeUndefined();
	});
});
