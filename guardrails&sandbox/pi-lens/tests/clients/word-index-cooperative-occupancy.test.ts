import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
	updateWordIndexDocumentAsync,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const sharedBody = (file: number, tag: string, lines = 120) =>
	Array.from(
		{ length: lines },
		(_, line) =>
			`export function ${tag}${file}_${line}(context: RequestContext) { return projectSnapshotStore.resolveDocumentEntry(context); }`,
	).join("\n");

describe("cooperative word-index refresh occupancy (#1215/#1224/#1225)", () => {
	it(
		"time-budgets the shared walk and document-read preflight",
		{
			retry: 2,
			timeout: 30_000,
		},
		async () => {
			const env = setupTestEnvironment("pi-lens-word-preflight-occupancy-");
			try {
				for (let i = 0; i < 700; i++) {
					createTempFile(
						env.tmpDir,
						`src/f${i}.ts`,
						`export const value${i} = ${i};`,
					);
				}
				let count = 0;
				const maxBlockMs = await measureMaxSyncBlockMs(async () => {
					count = (await collectWordIndexDocs(env.tmpDir)).length;
				});
				expect(count).toBe(700);
				// 8 ms budget plus one bounded stat/read/classification unit.
				expect(maxBlockMs).toBeLessThan(80);
			} finally {
				env.cleanup();
			}
		},
	);

	it(
		"yields within one high-df document replacement and stays equivalent",
		{
			retry: 2,
			timeout: 60_000,
		},
		async () => {
			const docs = Object.assign(
				Array.from({ length: 700 }, (_, file) => ({
					path: `src/f${file}.ts`,
					content: sharedBody(file, "original"),
					mtimeMs: file + 1,
					size: 1,
				})),
				{ truncated: false },
			);
			const syncIndex = buildWordIndex(docs);
			const asyncIndex = buildWordIndex(docs);
			const replacement = {
				path: docs[0].path,
				content: sharedBody(0, "updated"),
			};
			updateWordIndexDocument(syncIndex, replacement);

			const maxBlockMs = await measureMaxSyncBlockMs(() =>
				updateWordIndexDocumentAsync(asyncIndex, replacement),
			);

			expect(maxBlockMs).toBeLessThan(80);
			expect(serializeWordIndex(asyncIndex)).toEqual(
				serializeWordIndex(syncIndex),
			);
		},
	);

	it("keeps the old document observable until the async replacement commits", async () => {
		const path = "src/atomic.ts";
		const index = buildWordIndex(
			Object.assign(
				[
					{ path, content: sharedBody(0, "old", 300), mtimeMs: 1, size: 1 },
					{
						path: "src/peer.ts",
						content: sharedBody(1, "peer", 300),
						mtimeMs: 1,
						size: 1,
					},
				],
				{ truncated: false },
			),
		);
		let checks = 0;
		await updateWordIndexDocumentAsync(
			index,
			{ path, content: sharedBody(0, "novel", 300) },
			() => {
				checks += 1;
				expect(
					searchWordIndex(index, "old").some((hit) => hit.file === path),
				).toBe(true);
				expect(
					searchWordIndex(index, "novel").some((hit) => hit.file === path),
				).toBe(false);
				return true;
			},
		);
		expect(checks).toBeGreaterThan(1);
		expect(searchWordIndex(index, "old").some((hit) => hit.file === path)).toBe(
			false,
		);
		expect(
			searchWordIndex(index, "novel").some((hit) => hit.file === path),
		).toBe(true);
	});

	it(
		"serializes concurrent async replacements and preserves postings/forward consistency",
		{ timeout: 30_000 },
		async () => {
			const docs = Object.assign(
				Array.from({ length: 300 }, (_, file) => ({
					path: `src/f${file}.ts`,
					content: sharedBody(file, "original", 20),
				})),
				{ truncated: false },
			);
			const index = buildWordIndex(docs);
			const expected = buildWordIndex(docs);
			const updates = [0, 1].map((file) => ({
				path: docs[file].path,
				content: sharedBody(file, "updated", 20),
			}));
			for (const update of updates) updateWordIndexDocument(expected, update);

			await Promise.all(
				updates.map((update) => updateWordIndexDocumentAsync(index, update)),
			);

			expect(serializeWordIndex(index)).toEqual(serializeWordIndex(expected));
			for (const [file, tokenCounts] of index.forward!) {
				for (const [token, count] of tokenCounts) {
					expect(
						wordIndexPostingHits(index, token).filter(
							(hit) => hit.file === file,
						),
					).toHaveLength(count);
				}
			}
		},
	);
});
