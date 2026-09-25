import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadGuard } from "../../clients/read-guard.js";
import {
	registerSearchReads,
	type SearchReadLocation,
} from "../../clients/search-read-registration.js";
import { removeTempDirSync } from "./test-utils.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));
vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
	FileTimeError: class extends Error {},
}));

let tmp: string;
function fileWithLines(name: string, lines: number): string {
	const p = path.join(tmp, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(
		p,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	const past = new Date(Date.now() - 3_600_000);
	fs.utimesSync(p, past, past);
	return p;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-srr-"));
});
afterEach(() => {
	removeTempDirSync(tmp);
});

describe("registerSearchReads", () => {
	function spyGuard() {
		const calls: Array<{
			effectiveOffset: number;
			effectiveLimit: number;
			filePath: string;
			searchCredit?: {
				marginBefore: number;
				marginAfter: number;
				reason: string;
			};
		}> = [];
		return {
			calls,
			recordRead: (r: (typeof calls)[number]) => calls.push(r),
		};
	}

	// ── #1904 item 2: only delivered lines are credited ──────────────────────

	it("credits the shown lines only when no context was delivered", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		const locs: SearchReadLocation[] = [
			{ file: "a.ts", startLine: 10, endLine: 12 },
		];
		const n = registerSearchReads(guard, locs, {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(n).toBe(1);
		// lines 10..12 exactly → offset 10, limit 3. No ±2 slack (#1904).
		expect(guard.calls[0]).toMatchObject({
			effectiveOffset: 10,
			effectiveLimit: 3,
		});
	});

	it("credits delivered context asymmetrically and records why", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(
			guard,
			[
				{
					file: "a.ts",
					startLine: 10,
					endLine: 10,
					contextBefore: 1,
					contextAfter: 3,
				},
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		// 9..13 → offset 9, limit 5
		expect(guard.calls[0]).toMatchObject({
			effectiveOffset: 9,
			effectiveLimit: 5,
			searchCredit: {
				marginBefore: 1,
				marginAfter: 3,
				reason: "delivered-context-flags",
			},
		});
	});

	it("records a bare hit as match-lines-only on the ledger record", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(guard, [{ file: "a.ts", startLine: 10 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(guard.calls[0].searchCredit).toEqual({
			marginBefore: 0,
			marginAfter: 0,
			reason: "match-lines-only",
		});
	});

	it("still honors an explicit caller margin and labels it as such", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(guard, [{ file: "a.ts", startLine: 10 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
			contextMargin: 2,
		});
		expect(guard.calls[0]).toMatchObject({
			effectiveOffset: 8,
			effectiveLimit: 5,
			searchCredit: { reason: "caller-margin" },
		});
	});

	it("clamps the start at line 1", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(guard, [{ file: "a.ts", startLine: 1, endLine: 1 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(guard.calls[0].effectiveOffset).toBe(1);
	});

	it("dedupes identical spans", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(
			guard,
			[
				{ file: "a.ts", startLine: 10, endLine: 10 },
				{ file: "a.ts", startLine: 10, endLine: 10 },
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		expect(guard.calls).toHaveLength(1);
	});

	it("skips non-existent and external/vendor files", () => {
		fileWithLines("node_modules/pkg/x.ts", 100);
		const guard = spyGuard();
		const n = registerSearchReads(
			guard,
			[
				{ file: "missing.ts", startLine: 5 },
				{ file: "node_modules/pkg/x.ts", startLine: 5 },
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		expect(n).toBe(0);
	});
});

describe("search reads → read-guard (end-to-end)", () => {
	it("unblocks edits to a revealed match but still blocks far edits", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		registerSearchReads(guard, [{ file: f, startLine: 10, endLine: 12 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(guard.checkEdit(f, [11, 11]).action).toBe("allow"); // inside match
		// The guard's own contextLines band (3) still covers 7..15.
		expect(guard.checkEdit(f, [8, 8]).action).toBe("allow");
		expect(guard.checkEdit(f, [60, 60]).action).toBe("block"); // far outside
	});

	it("blocks an edit that only the removed ±2 search margin used to cover", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		registerSearchReads(guard, [{ file: f, startLine: 10, endLine: 12 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		// Old credit 8..14 plus contextLines 3 reached line 5. Delivered-lines
		// credit 10..12 plus contextLines 3 stops at line 7 (#1904 item 2).
		expect(guard.checkEdit(f, [5, 5]).action).toBe("block");
	});

	it("re-covers those lines when the search delivered the context", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		registerSearchReads(
			guard,
			[
				{
					file: f,
					startLine: 10,
					endLine: 12,
					contextBefore: 2,
					contextAfter: 2,
				},
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		expect(guard.checkEdit(f, [5, 5]).action).toBe("allow");
	});
});
