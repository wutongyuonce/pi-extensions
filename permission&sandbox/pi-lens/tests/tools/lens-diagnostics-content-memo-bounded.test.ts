/**
 * #2442: behavior-preservation for `cachedContentMemo` in
 * tools/lens-diagnostics.ts, migrated from a hand-rolled evict-oldest Map to
 * BoundedLruCache. A cache HIT (`readContentForAnchors`'s own `get`) refreshes
 * recency, so filling to capacity and re-reading the oldest key must keep it
 * alive past an overflow that would otherwise evict it (LRU) — the inverse of
 * the FIFO sites' "read never reorders" case, and the discriminating check
 * against an accidental FIFO substitution.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CACHED_CONTENT_MEMO_CAP,
	_readContentForAnchorsForTests,
} from "../../tools/lens-diagnostics.js";

describe("#2442 cachedContentMemo (true LRU)", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-content-memo-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeFixture(
		name: string,
		content = "hello",
	): {
		file: string;
		stat: { mtimeMs: number; size: number };
	} {
		const file = path.join(dir, name);
		fs.writeFileSync(file, content, "utf8");
		const s = fs.statSync(file);
		return { file, stat: { mtimeMs: s.mtimeMs, size: s.size } };
	}

	it("evicts the single oldest file's memo once filled past capacity", () => {
		const fixtures = Array.from({ length: CACHED_CONTENT_MEMO_CAP }, (_, i) =>
			writeFixture(`cap-${i}.txt`),
		);
		for (const f of fixtures) {
			expect(_readContentForAnchorsForTests(f.file, f.stat)).toBe("hello");
		}

		// Delete file 0 from disk so a MISS (re-read) is observably distinct
		// from a HIT (served from memo, never touches disk again).
		const overflow = writeFixture("cap-overflow.txt");
		_readContentForAnchorsForTests(overflow.file, overflow.stat);

		fs.rmSync(fixtures[0]!.file);
		expect(
			_readContentForAnchorsForTests(fixtures[0]!.file, fixtures[0]!.stat),
		).toBeUndefined(); // evicted: tried to re-read from disk, file is gone

		fs.rmSync(fixtures[1]!.file);
		expect(
			_readContentForAnchorsForTests(fixtures[1]!.file, fixtures[1]!.stat),
		).toBe("hello"); // still cached: served from memo despite the delete
	});

	it("repeated reads keep a key alive past what FIFO order alone would allow (red on an accidental FIFO substitution)", () => {
		const fixtures = Array.from({ length: CACHED_CONTENT_MEMO_CAP }, (_, i) =>
			writeFixture(`hot-${i}.txt`),
		);
		for (const f of fixtures) _readContentForAnchorsForTests(f.file, f.stat);

		// Re-read the oldest (a cache HIT each time) — true LRU moves it to MRU.
		for (let i = 0; i < 5; i++) {
			_readContentForAnchorsForTests(fixtures[0]!.file, fixtures[0]!.stat);
		}

		const overflow = writeFixture("hot-overflow.txt");
		_readContentForAnchorsForTests(overflow.file, overflow.stat);

		fs.rmSync(fixtures[0]!.file);
		expect(
			_readContentForAnchorsForTests(fixtures[0]!.file, fixtures[0]!.stat),
		).toBe("hello"); // survived: still cached, never touched disk
	});
});
