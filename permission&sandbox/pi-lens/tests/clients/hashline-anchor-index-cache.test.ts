/**
 * #2442: behavior-preservation for ANCHOR_INDEX_CACHE, the other evict-oldest
 * site #2432's round-3 review named as hand-rolled. FIFO, migrated to
 * BoundedFifoMap. `buildAnchorIndex` always re-stats the file first (even on
 * a cache HIT — see the module's own comment on that), so the only
 * observable difference between "still cached" and "evicted, rebuilt" is
 * whether `readFileSync` runs again — a cache hit skips it entirely.
 *
 * `vi.spyOn(fs, "readFileSync")` cannot redefine node:fs's ESM namespace
 * export directly (see grammar-stale-version.test.ts / workspace-topology
 * .test.ts) — wrap via vi.mock instead, keeping the real implementation.
 */
import * as fsRaw from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
	dropHashlineAnchorMemo,
	resolveHashlineAnchor,
} from "../../clients/hashline-anchor.js";

const ANCHOR_INDEX_CACHE_LIMIT = 8;

describe("#2442 ANCHOR_INDEX_CACHE (FIFO)", () => {
	let dir: string;

	beforeEach(() => {
		dir = fsRaw.mkdtempSync(path.join(os.tmpdir(), "pi-lens-anchor-cache-"));
		dropHashlineAnchorMemo();
		vi.mocked(fsRaw.readFileSync).mockClear();
	});

	afterEach(() => {
		fsRaw.rmSync(dir, { recursive: true, force: true });
		dropHashlineAnchorMemo();
	});

	function writeFixture(name: string): string {
		const file = path.join(dir, name);
		fsRaw.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
		return file;
	}

	function readCallsFor(file: string): number {
		return vi
			.mocked(fsRaw.readFileSync)
			.mock.calls.filter((call) => call[0] === file).length;
	}

	it("evicts the single oldest file's memo once filled past capacity", () => {
		const files = Array.from({ length: ANCHOR_INDEX_CACHE_LIMIT }, (_, i) =>
			writeFixture(`file-${i}.txt`),
		);
		for (const f of files) resolveHashlineAnchor(f, "aB3");
		for (const f of files) expect(readCallsFor(f)).toBe(1);

		// One more file pushes the cache past capacity — the FIRST file's memo
		// (oldest, never re-touched) must be evicted; re-resolving it triggers a
		// fresh readFileSync instead of a cache hit. Check the SURVIVOR (file 1)
		// first: re-resolving the EVICTED file 0 below reinserts it, which would
		// itself trigger a second eviction and confound a check done afterward.
		const overflow = writeFixture("overflow.txt");
		resolveHashlineAnchor(overflow, "aB3");

		resolveHashlineAnchor(files[1]!, "aB3");
		expect(readCallsFor(files[1]!)).toBe(1); // still cached: no re-read

		resolveHashlineAnchor(files[0]!, "aB3");
		expect(readCallsFor(files[0]!)).toBe(2); // evicted: re-read from disk
	});

	it("a cache hit (get) never reorders eviction order (red on an accidental LRU substitution)", () => {
		const files = Array.from({ length: ANCHOR_INDEX_CACHE_LIMIT }, (_, i) =>
			writeFixture(`hit-${i}.txt`),
		);
		for (const f of files) resolveHashlineAnchor(f, "aB3");

		// Re-resolve the oldest file repeatedly (a cache HIT each time, since its
		// mtime/size are unchanged) — an LRU cache would move it to
		// most-recently-used and it would survive the overflow below; a FIFO map
		// must not.
		for (let i = 0; i < 5; i++) resolveHashlineAnchor(files[0]!, "aB3");
		expect(readCallsFor(files[0]!)).toBe(1); // every repeat was a cache hit

		const overflow = writeFixture("hit-overflow.txt");
		resolveHashlineAnchor(overflow, "aB3");

		resolveHashlineAnchor(files[0]!, "aB3");
		expect(readCallsFor(files[0]!)).toBe(2); // evicted despite the repeat reads
	});
});
