import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dropHashlineAnchorMemo,
	computeHashlineAnchors,
	normalizeHashlineAnchorToken,
	resolveHashlineAnchor,
	xxh32Bytes,
} from "../../clients/hashline-anchor.js";

/**
 * #2423 review round 1, finding F1.
 *
 * `clients/hashline-anchor.ts` is a port of another project's hash function, so
 * the only test that means anything is one against that project's own output.
 * `tests/fixtures/hashline-edit-pro/anchor-vectors.json` was produced by
 * RUNNING pi-hashline-edit-pro's `_lineHashesPure` with the real `xxhash-wasm`
 * (see the sibling `generate-anchor-vectors.mjs`), at the upstream commit the
 * fixture names. If either side drifts, these cases go red instead of pi-lens
 * silently attributing an edit to the wrong lines.
 */
const VECTORS = JSON.parse(
	fs.readFileSync(
		path.resolve(
			import.meta.dirname,
			"..",
			"fixtures",
			"hashline-edit-pro",
			"anchor-vectors.json",
		),
		"utf8",
	),
) as {
	upstream: { commit: string; repo: string; generatedWith: string };
	xxh32: Array<{ input: string; h32: number }>;
	lineAnchors: Record<string, { content: string; hashes: string[] }>;
	/**
	 * Review round 3, finding F1. Each entry is ONE simulated edit run through
	 * upstream's own `mapStableHashes` — the function `lineHashes(after, path,
	 * {previous})` calls and persists after every edit — so `hashesAfter` is
	 * literally the anchor list the extension's hash store serves on the next
	 * read and the agent quotes back in the next tool call.
	 */
	storeCarried: Record<
		string,
		{
			description: string;
			before: string;
			after: string;
			removedHashes: string[];
			hashesBefore: string[];
			hashesAfter: string[];
		}
	>;
};

/** `splitLines` in the extension's `src/utils.ts`: an empty file is ONE line. */
function splitLines(text: string): string[] {
	if (text.length === 0) return [""];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

describe("#2423 hashline-edit-pro anchor algorithm", () => {
	it("names the upstream commit the vectors came from", () => {
		expect(VECTORS.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(VECTORS.upstream.repo).toContain("pi-hashline-edit-pro");
		expect(VECTORS.upstream.generatedWith).toContain("xxhash-wasm");
	});

	it("reproduces xxhash-wasm's h32 for every vector", () => {
		// Non-empty floor: an empty vector table would make this pass vacuously.
		expect(VECTORS.xxh32.length).toBeGreaterThanOrEqual(8);
		const mismatches = VECTORS.xxh32
			.filter(
				({ input, h32 }) => xxh32Bytes(Buffer.from(input, "utf8")) !== h32,
			)
			.map(({ input }) => input.slice(0, 40));
		expect(mismatches).toEqual([]);
	});

	it("reproduces the extension's per-line anchors for every fixture file", () => {
		expect(Object.keys(VECTORS.lineAnchors).length).toBeGreaterThanOrEqual(8);
		for (const [name, { content, hashes }] of Object.entries(
			VECTORS.lineAnchors,
		)) {
			expect(computeHashlineAnchors(content), name).toEqual(hashes);
		}
	});

	it("covers the cases a naive port gets wrong", () => {
		// Collision probing: duplicate line content must NOT produce duplicate
		// anchors, and the upstream fixture pins the exact probe sequence.
		const duplicates = VECTORS.lineAnchors.duplicates!;
		expect(new Set(duplicates.hashes).size).toBe(duplicates.hashes.length);
		// An empty file is one empty line, not zero lines.
		expect(VECTORS.lineAnchors.emptyFile!.hashes).toHaveLength(1);
		// The 500-byte source cap has to cut on a code-point boundary.
		expect(VECTORS.lineAnchors.longMultibyteLine).toBeDefined();
		expect(VECTORS.lineAnchors.astralAndTrim).toBeDefined();
	});
});

describe("#2423 hashline anchor tokens", () => {
	it("accepts a bare three-char base62 anchor and nothing else", () => {
		expect(normalizeHashlineAnchorToken("aB3")).toBe("aB3");
		expect(normalizeHashlineAnchorToken("  aB3  ")).toBe("aB3");
		expect(normalizeHashlineAnchorToken("123")).toBe("123");
		// The decimal form the first cut of the adapter assumed is NOT an anchor.
		expect(normalizeHashlineAnchorToken("9")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("12")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("1234")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("12: const x = 1;")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("aB3│const x = 1;")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("a-3")).toBeUndefined();
		expect(normalizeHashlineAnchorToken(12)).toBeUndefined();
		expect(normalizeHashlineAnchorToken(undefined)).toBeUndefined();
	});
});

describe("#2423 resolving an anchor against a file", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dropHashlineAnchorMemo();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-anchor-"));
		file = path.join(dir, "sample.ts");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		dropHashlineAnchorMemo();
	});

	function write(content: string): string[] {
		fs.writeFileSync(file, content, "utf8");
		return computeHashlineAnchors(content)!;
	}

	it("resolves a unique anchor to its 1-based line", () => {
		const anchors = write("alpha\nbeta\ngamma\ndelta\n");
		expect(resolveHashlineAnchor(file, anchors[2]!)).toEqual({ line: 3 });
		expect(resolveHashlineAnchor(file, ` ${anchors[0]!} `)).toEqual({
			line: 1,
		});
	});

	it("reports a stale anchor instead of guessing a line", () => {
		const anchors = write("alpha\nbeta\ngamma\n");
		const stale = anchors[1]!;
		write("alpha\ndelta\nepsilon\nzeta\n");
		dropHashlineAnchorMemo();
		const resolved = resolveHashlineAnchor(file, stale);
		// `beta` is gone, so its anchor either matches nothing or (astronomically
		// unlikely) some other line. What must never happen is a claim about the
		// line it USED to be on.
		expect(resolved.line === undefined || resolved.line !== 2).toBe(true);
	});

	it("reports a non-anchor and an unreadable file rather than throwing", () => {
		write("alpha\n");
		expect(resolveHashlineAnchor(file, "12").failure).toBe("not_an_anchor");
		expect(
			resolveHashlineAnchor(path.join(dir, "nope.ts"), "aB3").failure,
		).toBe("file_unreadable");
	});

	it("re-reads the file after it changes on disk", () => {
		const first = write("alpha\nbeta\ngamma\n");
		expect(resolveHashlineAnchor(file, first[0]!)).toEqual({ line: 1 });
		// Same path, new content: a memo keyed only by path would answer 1 again
		// for an anchor that has moved to line 3.
		const second = write("zeta\neta\nalpha\n");
		fs.utimesSync(
			file,
			new Date(Date.now() + 4000),
			new Date(Date.now() + 4000),
		);
		expect(resolveHashlineAnchor(file, second[2]!)).toEqual({ line: 3 });
	});

	it("normalizes CRLF and a BOM the way the extension does", () => {
		const anchors = computeHashlineAnchors("alpha\nbeta\ngamma\n")!;
		fs.writeFileSync(file, "﻿alpha\r\nbeta\r\ngamma\r\n", "utf8");
		// Review round 3, finding F3: asserting only `anchors[1] -> line 2` was
		// vacuous. `beta` and `gamma` hash the same with or without the BOM,
		// because the BOM only ever prefixes line 1 — so the case passed whether
		// or not the strip existed. LINE 1 is the one that carries the proof.
		expect(
			computeHashlineAnchors("﻿alpha\nbeta\ngamma\n")![0],
			"a BOM must change line 1's anchor, or this case cannot prove the strip",
		).not.toBe(anchors[0]);
		expect(resolveHashlineAnchor(file, anchors[0]!)).toEqual({ line: 1 });
		expect(resolveHashlineAnchor(file, anchors[1]!)).toEqual({ line: 2 });
	});
});

/**
 * Review round 3, finding F1 — the defect this gate exists for.
 *
 * The extension does not recompute hashes on every read: after each edit it
 * runs `mapStableHashes`, carries surviving lines' old anchors forward and
 * persists them (`src/hashline/hash.ts` -> `src/hash-store.ts`). pi-lens can
 * only recompute with `_lineHashesPure`. For a line whose canonical content is
 * unique the two agree. For a duplicate-content line — `}`, a blank line, a
 * bare comment-close — the anchor is a probing artifact, so its anchor
 * matches a DIFFERENT one under recomputation: a unique, confident, wrong
 * answer that used to flow straight into `readGuard.checkEdit` and
 * `addModifiedRange`.
 *
 * The vector below is not written from that description — it is generated by
 * running the extension's own `mapStableHashes` (see
 * `tests/fixtures/hashline-edit-pro/generate-anchor-vectors.mjs`, and the
 * `upstream` block for the commit and the real `xxhash-wasm` version).
 */
describe("#2423 review round 3 (F1) — store-carried anchors", () => {
	const SCENARIO = "insertedFunctionAtTop";
	let dir: string;
	let file: string;
	let scenario: (typeof VECTORS.storeCarried)[string];
	let afterLines: string[];

	beforeEach(() => {
		dropHashlineAnchorMemo();
		scenario = VECTORS.storeCarried[SCENARIO]!;
		afterLines = splitLines(scenario.after);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-carried-"));
		file = path.join(dir, "carried.ts");
		fs.writeFileSync(file, scenario.after, "utf8");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		dropHashlineAnchorMemo();
	});

	it("carries a vector generated by the extension's own mapStableHashes", () => {
		expect(Object.keys(VECTORS.storeCarried).length).toBeGreaterThanOrEqual(1);
		expect(scenario.hashesAfter).toHaveLength(afterLines.length);
		expect(scenario.hashesBefore).toHaveLength(
			splitLines(scenario.before).length,
		);
		// The edit is an INSERT: nothing removed, every old anchor survives.
		expect(scenario.removedHashes).toEqual([]);
		expect(new Set(scenario.hashesBefore).size).toBe(
			scenario.hashesBefore.length,
		);
		// Non-vacuous floor: the file must actually contain duplicate content,
		// or there is nothing for the gate to refuse.
		const duplicated = afterLines.filter(
			(line, index) => afterLines.indexOf(line) !== index,
		);
		expect(duplicated.length).toBeGreaterThanOrEqual(6);
		expect(duplicated).toContain("}");
	});

	it("never resolves a store-carried anchor to a line it does not belong to", () => {
		const wrong: string[] = [];
		scenario.hashesAfter.forEach((anchor, index) => {
			const resolved = resolveHashlineAnchor(file, anchor);
			if (resolved.line !== undefined && resolved.line !== index + 1) {
				wrong.push(
					`anchor ${anchor} belongs to line ${index + 1} ` +
						`(${JSON.stringify(afterLines[index])}) but resolved to ` +
						`line ${resolved.line} (${JSON.stringify(afterLines[resolved.line - 1])})`,
				);
			}
		});
		expect(wrong).toEqual([]);
	});

	it("leaves the drifted closing-brace anchor unresolved, with a reason", () => {
		// Line 10 of the edited file closes `alpha`. Upstream carried its
		// pre-edit anchor forward; recomputation hands that same anchor to the
		// `}` on line 17, seven lines away — the exact wrong-line case.
		const line = 10;
		const anchor = scenario.hashesAfter[line - 1]!;
		expect(afterLines[line - 1]).toBe("}");
		expect(resolveHashlineAnchor(file, anchor)).toEqual({
			failure: "content_not_unique",
		});
		// And it is not a one-off: every duplicate-content line is refused.
		for (const [index, text] of afterLines.entries()) {
			if (
				afterLines.indexOf(text) === index &&
				afterLines.lastIndexOf(text) === index
			)
				continue;
			expect(
				resolveHashlineAnchor(file, scenario.hashesAfter[index]!).line,
				`line ${index + 1} ${JSON.stringify(text)} must not be answered`,
			).toBeUndefined();
		}
	});

	it("still answers for every unique-content line", () => {
		let answered = 0;
		for (const [index, text] of afterLines.entries()) {
			const unique =
				afterLines.indexOf(text) === index &&
				afterLines.lastIndexOf(text) === index;
			if (!unique) continue;
			expect(
				resolveHashlineAnchor(file, scenario.hashesAfter[index]!),
				`line ${index + 1} ${JSON.stringify(text)}`,
			).toEqual({ line: index + 1 });
			answered += 1;
		}
		// The gate must not have collapsed into "answer nothing". Eight of the
		// 25 lines of this fixture carry content that occurs exactly once.
		expect(answered).toBe(8);
	});
});

/**
 * Review round 4, finding F1, mechanism (b) — content uniqueness does not
 * imply base-index uniqueness. `baseIdx = (xxh32(hashSource) >>> 14) % 238328`
 * has only 238,328 slots, so two DIFFERENT line contents can collide on it;
 * the second one scanned is probed to a different slot by the identical
 * open-addressing mechanism a literal duplicate line uses, even though its
 * content is unique in the file. `const value29 = 29;` and
 * `const value298 = 298;` are two such contents (found by brute-force search
 * against this exact vendored arithmetic — see
 * `tests/fixtures/hashline-edit-pro/generate-anchor-vectors.mjs`).
 *
 * This is NOT a fix. The content-uniqueness gate cannot see an anchor's
 * provenance (F1 mechanism (a) has the same blind spot from the other side —
 * see the module header), so it still answers for a probe-derived anchor
 * whenever the matched line's content happens to be unique. These cases pin
 * TODAY's answer so a future change to the residual is a visible red, not a
 * silent drift.
 */
describe("#2423 review round 4 (F1) — content uniqueness does not imply base-index uniqueness (mechanism b)", () => {
	const SCENARIO = "collidingBaseIndexUniqueContent";
	let dir: string;
	let file: string;
	let scenario: (typeof VECTORS.storeCarried)[string];
	let afterLines: string[];

	beforeEach(() => {
		dropHashlineAnchorMemo();
		scenario = VECTORS.storeCarried[SCENARIO]!;
		afterLines = splitLines(scenario.after);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-collide-"));
		file = path.join(dir, "collide.ts");
		fs.writeFileSync(file, scenario.after, "utf8");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		dropHashlineAnchorMemo();
	});

	it("carries a vector where two distinct unique-content lines collide on baseIdx", () => {
		expect(scenario.hashesAfter).toHaveLength(afterLines.length);
		expect(scenario.removedHashes).toEqual([]);
		// Both colliding lines occur exactly once each in the file: this is the
		// "unique content" case the F1 gate answers confidently, NOT the
		// duplicate-content case `content_not_unique` refuses.
		const lineA = "const value29 = 29;";
		const lineB = "const value298 = 298;";
		expect(afterLines.filter((line) => line === lineA)).toHaveLength(1);
		expect(afterLines.filter((line) => line === lineB)).toHaveLength(1);
		// Two DIFFERENT contents, not a literal duplicate — their anchors must
		// differ, or this vector does not test collision-by-baseIdx at all.
		expect(scenario.hashesAfter[0]).not.toBe(scenario.hashesAfter[1]);
	});

	it("still answers for both colliding unique-content lines, pinning today's residual", () => {
		expect(resolveHashlineAnchor(file, scenario.hashesAfter[0]!)).toEqual({
			line: 1,
		});
		expect(resolveHashlineAnchor(file, scenario.hashesAfter[1]!)).toEqual({
			line: 2,
		});
	});
});
