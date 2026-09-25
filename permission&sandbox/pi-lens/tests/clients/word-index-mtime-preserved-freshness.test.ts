import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	deserializeWordIndex,
	refreshWordIndexIncrementally,
	searchWordIndex,
	serializeWordIndex,
	type WordIndexRefreshOutcome,
	type WordIndexRefreshResult,
} from "../../clients/word-index.js";
import { _resetProjectScaleBaseForTests } from "../../clients/project-scale.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	_resetProjectScaleBaseForTests();
});

function expectIncremental(
	outcome: WordIndexRefreshOutcome,
): WordIndexRefreshResult {
	expect(outcome.mode).toBe("incremental");
	if (outcome.mode !== "incremental") throw new Error(outcome.reason);
	return outcome;
}

// #1105: the incremental refresh gate was mtime-ONLY, so a content change that
// PRESERVES mtime (git checkout timestamp restoration, a formatter preserving
// mtime, a same-clock write) left the old postings serving STALE identifiers to
// symbol_search. The fix adds the review-graph gold-standard second axis — byte
// size, free from the stat the walk already runs — so any content change that
// alters length is caught even when mtime is identical.
//
// To make the mtime axis match EXACTLY (so it is size ALONE that must trigger
// the re-read — the test cannot pass vacuously via an accidental mtime delta),
// the file's mtime is pinned to the SAME fixed Date before indexing and again
// after the edit: setting an identical Date twice yields an identical on-disk
// `mtimeMs`, which `fs.utimesSync`'s round-trip of a natural mtime does not.
const PINNED_MTIME = new Date(Date.now() - 60_000);

describe("word-index freshness: mtime preserved, content changed (#1105)", () => {
	it("re-reads a file whose content+size changed but mtime did not", async () => {
		const env = setupTestEnvironment("pi-lens-word-mtime-preserved-");
		try {
			const a = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const zephyrAlpha = 1;",
			);
			createTempFile(env.tmpDir, "src/b.ts", "export const stableBeta = 2;");
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const recorded = fs.statSync(a);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			// Sanity: the pre-edit identifier is indexed, the post-edit one is not.
			expect(searchWordIndex(index, "zephyrAlpha")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "quokka")).toEqual([]);

			// Different identifier AND a different byte length (longer), then re-pin
			// the SAME mtime so the mtime axis is byte-for-byte unchanged.
			fs.writeFileSync(a, "export const quokkaOmegaDistinct = 1;", "utf8");
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);

			const after = fs.statSync(a);
			// Precondition: mtime preserved exactly; only size moved. If this ever
			// fails the test fails loudly rather than proving the wrong thing.
			expect(after.mtimeMs).toBe(recorded.mtimeMs);
			expect(after.size).not.toBe(recorded.size);

			const result = expectIncremental(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			);

			// Post-fix: the size delta forces the re-read of exactly this one file.
			// Pre-fix (mtime-only gate) this file was skipped: `refreshed` was 0 and
			// "quokka" never became searchable while "zephyrAlpha" lingered.
			expect(result.refreshed).toBe(1);
			expect(result.dropped).toBe(0);
			expect(searchWordIndex(index, "quokka")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "zephyrAlpha")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("survives a deserialize→refresh round-trip carrying the size axis", async () => {
		const env = setupTestEnvironment("pi-lens-word-mtime-preserved-rt-");
		try {
			const a = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const roundTripAlpha = 1;",
			);
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const recorded = fs.statSync(a);
			const built = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			// Round-trip through the persisted (snapshot) shape, as a real session
			// does — proves the size axis survives serialize/deserialize.
			const index = deserializeWordIndex(serializeWordIndex(built));
			if (!index) throw new Error("deserialize returned null");

			fs.writeFileSync(a, "export const quokkaOmegaDistinct = 1;", "utf8");
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const after = fs.statSync(a);
			expect(after.mtimeMs).toBe(recorded.mtimeMs);
			expect(after.size).not.toBe(recorded.size);

			const result = expectIncremental(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			);
			expect(result.refreshed).toBe(1);
			expect(searchWordIndex(index, "quokka")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "roundTripAlpha")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});

// The PR's headline compat claim — "a pre-#1105 snapshot lacking fileSizes
// forces one self-healing full re-read" — is enforced by TWO guards in different
// functions: deserializeWordIndex only populates fileSizes when the array is
// present AND parallel to files, and the refresh gate reads a missing size as
// `?? -1` (an impossible real size that always mismatches). These tests pin both
// guards so an independent refactor (`?? size`, or populating a misaligned
// array) can't silently downgrade a legacy snapshot to trusting absent sizes.
describe("word-index legacy snapshot (no fileSizes) self-heals (#1105)", () => {
	it("full-re-reads every file when the serialized snapshot omits fileSizes", async () => {
		const env = setupTestEnvironment("pi-lens-word-legacy-nosize-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export const legacyAlpha = 1;");
			createTempFile(env.tmpDir, "src/b.ts", "export const legacyBeta = 2;");
			createTempFile(env.tmpDir, "src/c.ts", "export const legacyGamma = 3;");
			const built = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const fileCount = built.docCount;
			expect(fileCount).toBe(3);

			// Simulate a pre-#1105 (v2, no fileSizes) persisted snapshot.
			const serialized = serializeWordIndex(built);
			serialized.fileSizes = undefined;
			const index = deserializeWordIndex(serialized);
			if (!index) throw new Error("deserialize returned null");
			// Guard 1: a missing array must NOT be populated — an empty size map is
			// what makes the refresh gate treat every file as size-unknown.
			expect(index.fileSizes.size).toBe(0);

			// NO file content changes — mtime matches for every file. The ONLY reason
			// to re-read is the absent size (`?? -1` mismatch). Pre-guard (`?? size`)
			// this would be 0.
			const result = expectIncremental(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			);
			expect(result.refreshed).toBe(fileCount);
			expect(result.dropped).toBe(0);
			// Post-heal the sizes are populated, so an immediate second refresh is a
			// no-op — the full re-read happens exactly once.
			const second = expectIncremental(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			);
			expect(second.refreshed).toBe(0);
			expect(second.reused).toBe(fileCount);
		} finally {
			env.cleanup();
		}
	});

	it("ignores a length-mismatched fileSizes array and full-re-reads", async () => {
		const env = setupTestEnvironment("pi-lens-word-legacy-badsize-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export const badAlpha = 1;");
			createTempFile(env.tmpDir, "src/b.ts", "export const badBeta = 2;");
			const built = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const fileCount = built.docCount;
			expect(fileCount).toBe(2);

			// A corrupt/misaligned fileSizes (wrong length) must be rejected wholesale
			// rather than positionally trusted (which would pair a file with the wrong
			// file's size).
			const serialized = serializeWordIndex(built);
			serialized.fileSizes = [123]; // length 1 vs files length 2
			const index = deserializeWordIndex(serialized);
			if (!index) throw new Error("deserialize returned null");
			expect(index.fileSizes.size).toBe(0);

			const result = expectIncremental(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			);
			expect(result.refreshed).toBe(fileCount);
		} finally {
			env.cleanup();
		}
	});
});
