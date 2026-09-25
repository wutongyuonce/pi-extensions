/**
 * #1227 matrix row 1: cap-bound corpus size.
 *
 * #1197's review found the old DENSITY-only gate failed worst exactly at the
 * file-count cap: 1,799 stale documents out of 6,000 is 29.98% — just under
 * the 30% ratio threshold — so a ratio-only gate would have kept that dense,
 * cap-sized refresh on the per-document incremental path (#1197's measured
 * 90.6s / 39.6s-blocking shape, scaled up). #1200's work-based gate (compare
 * estimated incremental work against one full rebuild, in tokenizer-token
 * units) is supposed to make this safe regardless of absolute corpus size.
 * `word-index-session-refresh.test.ts` already guards the 500+ document
 * dense-stale shape at 600 documents, but nothing exercises the two things
 * unique to being AT the cap: (a) the corpus is genuinely truncated
 * (`walked.length === maxFiles`, extra files beyond the cap exist on disk and
 * must NOT be counted), and (b) the stale set is sized off the CAPPED corpus,
 * not the full one on disk.
 *
 * Realistic scale, not a miniature (#1227 acceptance criterion 3): the cap is
 * lowered via `PI_LENS_MAX_PROJECT_FILES` (word-index ratio 3x) to 900 files
 * so the test suite stays fast, but the fixture still creates hundreds of
 * real files with realistic identifier-sharing content (mirroring the
 * `word-index-session-refresh.test.ts` 600-document fixture's shared
 * `projectSnapshotStore.resolveDocumentEntry` identifier, which is what makes
 * posting-array filtering costly) plus 100 MORE files beyond the cap to prove
 * truncation is respected.
 *
 * The work-based-gate teeth here duplicate
 * `word-index-session-refresh.test.ts`'s 600-document dense-stale case; what
 * is NEW in this file is the pair of truncation assertions (capped corpus
 * count and `truncated` flag survival through build + refresh).
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { _resetProjectScaleBaseForTests } from "../../clients/project-scale.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	delete process.env.PI_LENS_MAX_PROJECT_FILES;
	_resetProjectScaleBaseForTests();
});

const CAP = 900; // base 300 * wordIndex ratio 3x

const body = (i: number, tag: string) =>
	Array.from(
		{ length: 6 },
		(_, l) =>
			`export function render${tag}${i}_${l}(requestContext: RequestContext) { return projectSnapshotStore.resolveDocumentEntry(requestContext, ${l}); }`,
	).join("\n");

describe("word-index incremental refresh at the file-count cap (#1227)", () => {
	it("selects a full rebuild for a dense-stale refresh AT the cap, honoring truncation", async () => {
		const env = setupTestEnvironment("pi-lens-word-cap-bound-");
		try {
			process.env.PI_LENS_MAX_PROJECT_FILES = "300";
			_resetProjectScaleBaseForTests();

			// 100 files beyond the cap — must be walked-and-truncated away, not
			// counted toward the corpus or the stale ratio.
			const files = Array.from({ length: CAP + 100 }, (_, i) =>
				createTempFile(env.tmpDir, `src/f${i}.ts`, body(i, "Original")),
			);

			const docs = await collectWordIndexDocs(env.tmpDir);
			expect(docs.truncated).toBe(true);
			expect(docs.length).toBe(CAP);

			const index = buildWordIndex(docs);
			expect(index.docCount).toBe(CAP);
			expect(index.truncated).toBe(true);
			const before = serializeWordIndex(index);

			// 25% of the CAPPED corpus — comfortably under the 30% ratio
			// threshold (the shape the old ratio-only gate would have waved
			// through), at cap-bound absolute scale.
			const staleCount = Math.round(CAP * 0.25);
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, staleCount).entries()) {
				fs.writeFileSync(file, body(i, "Refreshed"), "utf8");
				fs.utimesSync(file, future, future);
			}

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			expect(result).toMatchObject({
				mode: "full-required",
				reason: "stale-document-churn",
			});
			// Atomic: the old index is untouched, cap-bound or not.
			expect(serializeWordIndex(index)).toEqual(before);
		} finally {
			env.cleanup();
		}
	}, 30_000);
});
