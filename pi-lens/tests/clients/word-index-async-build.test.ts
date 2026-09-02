import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	buildWordIndexAsync,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";

function makeDocs(count: number, linesPerFile: number) {
	return Object.assign(
		Array.from({ length: count }, (_, file) => ({
			path: `src/file-${file}.ts`,
			content: Array.from(
				{ length: linesPerFile },
				(_, line) =>
					`export function handler${file}_${line}(value: string) { return value.length + ${line}; }`,
			).join("\n"),
			mtimeMs: file + 1,
			size: file + 100,
		})),
		{ truncated: true },
	);
}

describe("cooperative word-index full build (#1197)", () => {
	it("is byte-equivalent to the synchronous reference builder", async () => {
		const docs = makeDocs(40, 25);

		const expected = serializeWordIndex(buildWordIndex(docs));
		const actual = serializeWordIndex(await buildWordIndexAsync(docs));

		expect(actual).toEqual(expected);
	});

	it(
		"keeps scaled full-build event-loop occupancy bounded",
		{
			retry: 2,
			timeout: 30_000,
		},
		async () => {
			const docs = makeDocs(1_000, 100);

			const maxBlockMs = await measureMaxSyncBlockMs(() =>
				buildWordIndexAsync(docs),
			);

			// The builder's budget is 8 ms; a block can exceed it only by the cost of
			// the work between two checkpoints (50 lines). 100 ms is ~5x the value this
			// fixture actually measures (20 ms on a loaded Windows dev box) — the old
			// 300 ms left 37x slack, which no realistic regression could have tripped.
			expect(maxBlockMs).toBeLessThan(100);
		},
	);

	it(
		"yields between very long lines inside one document",
		{
			retry: 2,
			timeout: 30_000,
		},
		async () => {
			// A minified/bundled file the source filter did not exclude: few lines, but
			// each one enormous. The per-50-lines checkpoint never fires here, so
			// without the long-line checkpoint the whole document is ONE synchronous
			// burst (#1197 review finding 4).
			const longLine = Array.from(
				{ length: 300 },
				(_, k) => `payloadSegment${k}Value renderedTemplate${k}Node`,
			).join(" ");
			const docs = Object.assign(
				Array.from({ length: 4 }, (_, file) => ({
					path: `src/bundle-${file}.ts`,
					// ~410 KB: a realistic bundle, under WORD_INDEX_MAX_BYTES (512 KB).
					content: Array.from({ length: 30 }, () => longLine).join("\n"),
					mtimeMs: file + 1,
					size: file + 100,
				})),
				{ truncated: false },
			);

			const startedAt = Date.now();
			const maxBlockMs = await measureMaxSyncBlockMs(() =>
				buildWordIndexAsync(docs),
			);
			const totalMs = Date.now() - startedAt;

			// Hardware-independent: yielding only between DOCUMENTS caps the ratio at
			// 1/4 (four documents); yielding between long lines drives it to ~1/120.
			// Asserting a fraction of this run's own duration keeps the guard honest on
			// a fast CI box, where an absolute millisecond bound would pass either way.
			expect(totalMs).toBeGreaterThan(50);
			expect(maxBlockMs).toBeLessThan(totalMs / 8);
		},
	);

	it("aborts a superseded build without returning a partial index", async () => {
		const docs = makeDocs(100, 100);
		let current = true;
		setImmediate(() => {
			current = false;
		});

		await expect(buildWordIndexAsync(docs, () => current)).rejects.toThrow(
			"word index build superseded",
		);
	});
});
