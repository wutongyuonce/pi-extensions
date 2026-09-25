/**
 * #1025 item #2 — the word-index path-key divergence regression.
 *
 * The bug: the full/incremental BUILD keys documents on the on-disk casing the
 * `readdirSync` walk reports, while the per-edit UPDATE seams
 * (`dispatch/integration.ts`, `clients/mcp/analyze.ts`) key via
 * `path.resolve()` on the raw tool-input path. When those two forms differ only
 * by separator or (on a case-insensitive FS) case, the pre-fix plain-`Map`
 * keying made `forward.has(doc.path)` MISS, so the stale build-form entry was
 * never removed — a duplicate doc entry with stale postings, served until a
 * full rebuild. The fix folds every path key through the ONE `wordIndexKey`
 * normalizer via `PathKeyedMap`, so build-form and edit-form collapse to a
 * single entry.
 *
 * OS-agnostic design: the SEPARATOR case (`\` vs `/`) folds on EVERY platform
 * (Linux CI included), so that test always runs and is the primary regression
 * guard — it fails on pre-fix code on Linux too. The CASE variant only folds
 * where `wordIndexKey` actually lowercases (win32), so it is probe-guarded on
 * the normalizer's real behavior (`wordIndexKey("A") !== wordIndexKey("a")`),
 * skipping HONESTLY on a case-sensitive FS rather than vacuously passing (the
 * #1024 trap).
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	countWordIndexPostingEntries,
	refreshWordIndexIncrementally,
	serializeWordIndex,
	updateWordIndexDocument,
	wordIndexKey,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

/** True when the shared normalizer folds case (win32) — probe its real behavior. */
const NORMALIZER_FOLDS_CASE = wordIndexKey("A.ts") === wordIndexKey("a.ts");

describe("word-index build/update key convergence (#1025 item #2)", () => {
	it("serializes postings under a spelling-divergent docLengths key", () => {
		const index = buildWordIndex([
			{ path: "walk\\alpha.ts", content: "foldedToken" },
			{ path: "walk/alpha.ts", content: "foldedToken" },
		]);
		// Two walk spellings fold to one path key, so the file table interned ONE
		// file id, keyed on the FOLDED form. The serializer enumerates files from
		// `docLengths`, which yields the raw display spelling, so its slot lookup
		// must fold too. The backslash spelling below differs from its folded form
		// on every platform, so a raw-string lookup finds nothing and silently
		// drops every posting — on Linux CI as well as Windows.
		const divergent = "walk\\alpha.ts";
		expect(wordIndexKey(divergent)).not.toBe(divergent);
		expect(wordIndexKey(divergent)).toBe(wordIndexKey("walk/alpha.ts"));
		index.docLengths.clear();
		index.docLengths.set(divergent, 1);
		const serializedEntries = serializeWordIndex(index).postings.reduce(
			(total, [, flat]) => total + flat.length / 2,
			0,
		);
		expect(serializedEntries).toBeGreaterThan(0);
		expect(serializedEntries).toBe(countWordIndexPostingEntries(index));
	});

	it("serializes folded walk spellings with the live file table intact", () => {
		const index = buildWordIndex([
			{ path: "walk\\alpha.ts", content: "firstWalkToken" },
			{ path: "walk/alpha.ts", content: "secondWalkToken" },
		]);
		const serialized = serializeWordIndex(index);
		const tokens = new Set(serialized.postings.map(([token]) => token));
		expect(tokens.has("firstwalktoken")).toBe(true);
		expect(tokens.has("secondwalktoken")).toBe(true);
		expect(
			serialized.postings.reduce((n, [, flat]) => n + flat.length / 2, 0),
		).toBe(countWordIndexPostingEntries(index));
	});

	it("separator-divergent build vs edit forms collapse to one entry (all platforms)", () => {
		// BUILD keys the doc with a backslash separator (as a Windows walk would).
		const index = buildWordIndex([
			{ path: "sub\\alpha.ts", content: "export function alpha() {}" },
		]);
		expect(index.docCount).toBe(1);

		// A later per-edit UPDATE arrives with the SAME file in forward-slash form
		// (as `path.resolve` on a `/`-separated tool-input path yields). Pre-fix:
		// `forward.has("sub/alpha.ts")` missed the "sub\\alpha.ts" entry, so this
		// ADDED a second doc and left the old postings stale.
		const ok = updateWordIndexDocument(index, {
			path: "sub/alpha.ts",
			content: "export function alpha() {}\nexport function beta() {}",
		});
		expect(ok).toBe(true);

		// Convergence: exactly one document, no orphaned build-form entry.
		expect(index.docCount).toBe(1);
		expect([...index.docLengths.keys()]).toHaveLength(1);
		expect([...index.fileMtimes.keys()]).toHaveLength(1);
		expect([...index.forward!.keys()]).toHaveLength(1);

		// The update REPLACED the doc: `beta` (added) is present, and every `alpha`
		// posting points at the single current doc — no stale duplicate posting.
		const alphaPostings = wordIndexPostingHits(index, "alpha");
		expect(alphaPostings).toHaveLength(1);
		expect(index.postings.get("beta")).toBeDefined();
		// All postings normalize to the one file key (no split across two forms).
		const distinctKeys = new Set(
			[...index.postings.keys()]
				.flatMap((token) => wordIndexPostingHits(index, token))
				.map((hit) => wordIndexKey(hit.file)),
		);
		expect(distinctKeys.size).toBe(1);
	});

	it.skipIf(!NORMALIZER_FOLDS_CASE)(
		"case-divergent build vs edit forms collapse to one entry (case-insensitive FS)",
		() => {
			const index = buildWordIndex([
				{ path: "SUB/Alpha.ts", content: "export function alpha() {}" },
			]);
			expect(index.docCount).toBe(1);

			const ok = updateWordIndexDocument(index, {
				path: "sub/alpha.ts",
				content: "export function omega() {}",
			});
			expect(ok).toBe(true);

			// One doc, replaced (not duplicated): omega present, alpha gone.
			expect(index.docCount).toBe(1);
			expect([...index.docLengths.keys()]).toHaveLength(1);
			expect(index.postings.get("omega")).toBeDefined();
			expect(index.postings.has("alpha")).toBe(false);
		},
	);
});

describe("word-index incremental refresh key convergence (#1025 review)", () => {
	it("an unchanged file stored under a separator-divergent key is not churned or dropped (all platforms)", async () => {
		const env = setupTestEnvironment("pi-lens-wi-refresh-divergence-");
		try {
			// A REAL on-disk file: the refresh walk/stat reads it back verbatim.
			const realPath = createTempFile(
				env.tmpDir,
				"sub/alpha.ts",
				"export function alpha() {}\n",
			);
			const realMtime = fs.statSync(realPath).mtimeMs;

			// Simulate a prior per-edit update that keyed this SAME file under the
			// OPPOSITE separator form (last-writer-wins display path). Flipping the
			// separator diverges the raw string on EVERY platform yet folds to the
			// same `wordIndexKey`, so this reproduces the bug — and fails on pre-fix
			// code — on case-sensitive Linux CI too, not just Windows.
			const storedForm = realPath.includes("\\")
				? realPath.replace(/\\/g, "/")
				: realPath.replace(/\//g, "\\");
			expect(storedForm).not.toBe(realPath); // genuinely raw-divergent …
			expect(wordIndexKey(storedForm)).toBe(wordIndexKey(realPath)); // … but folds equal

			// Build the index keyed on that edit-form, with the REAL mtime so the
			// file is genuinely UNCHANGED at refresh time.
			const index = buildWordIndex([
				{
					path: storedForm,
					content: "export function alpha() {}\n",
					mtimeMs: realMtime,
				},
			]);
			expect(index.docCount).toBe(1);

			// Pre-fix, the raw-keyed set-difference double-counts this one file as
			// both dropped and added (changed/denominator = 2/1 > 0.3) and REJECTS
			// with "file-set churn exceeds incremental threshold"; post-fix the
			// normalized-space diff recognizes it as the same unchanged document.
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("incremental");
			if (result.mode !== "incremental") throw new Error(result.reason);

			expect(result.dropped).toBe(0); // not dropped-then-re-added
			expect(result.refreshed).toBe(0); // mtime matches → not re-tokenized
			expect(result.reused).toBe(1);
			expect(index.docCount).toBe(1);
			// Postings survive untouched — no drop-before-readd regression window.
			expect(wordIndexPostingHits(index, "alpha")).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});
