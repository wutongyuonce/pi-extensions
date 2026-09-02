import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";
import { _resetProjectScaleBaseForTests } from "../../clients/project-scale.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// A controllable read-failure set: only readFileSync is overridden (statSync,
// the walk, and every write helper delegate to the real fs), so a path in
// `failReads` looks present-and-stat-able but throws on read — the transient
// exclusive-lock scenario, portably and without ESM namespace-spy limits.
const { failReads, readCounter, statCounter, walkCounter } = vi.hoisted(() => ({
	failReads: new Set<string>(),
	// Counts reads of files under a watched root, so a test can assert that a
	// refresh aborted BEFORE it read (and therefore before it mutated) anything.
	readCounter: { root: "", calls: 0 },
	statCounter: { root: "", calls: 0 },
	walkCounter: { calls: 0 },
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		statSync: ((path: unknown, options?: unknown) => {
			if (
				statCounter.root &&
				typeof path === "string" &&
				path.startsWith(statCounter.root)
			) {
				statCounter.calls += 1;
			}
			return (actual.statSync as (...a: unknown[]) => unknown)(path, options);
		}) as typeof fs.statSync,
		readFileSync: ((path: unknown, options?: unknown) => {
			if (typeof path === "string" && failReads.has(path)) {
				throw Object.assign(new Error("EBUSY: resource busy or locked"), {
					code: "EBUSY",
				});
			}
			if (
				readCounter.root &&
				typeof path === "string" &&
				path.startsWith(readCounter.root)
			) {
				readCounter.calls += 1;
			}
			return (actual.readFileSync as (...a: unknown[]) => unknown)(
				path,
				options,
			);
		}) as typeof fs.readFileSync,
	};
});
vi.mock("../../clients/source-filter.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/source-filter.js")>();
	return {
		...actual,
		collectSourceFilesAsync: async (
			...args: Parameters<typeof actual.collectSourceFilesAsync>
		) => {
			walkCounter.calls += 1;
			return actual.collectSourceFilesAsync(...args);
		},
	};
});

afterEach(() => {
	delete process.env.PI_LENS_MAX_PROJECT_FILES;
	_resetProjectScaleBaseForTests();
	failReads.clear();
	readCounter.root = "";
	readCounter.calls = 0;
	statCounter.root = "";
	statCounter.calls = 0;
	walkCounter.calls = 0;
	vi.restoreAllMocks();
});

describe("session-start incremental word-index refresh (#958)", () => {
	it("reads and refreshes exactly one stale file while reusing the rest", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-stale-");
		try {
			const a = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const oldZephyr = 1;",
			);
			createTempFile(env.tmpDir, "src/b.ts", "export const stableBeta = 2;");
			createTempFile(env.tmpDir, "src/c.ts", "export const stableGamma = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			fs.writeFileSync(a, "export const newQuartz = 1;", "utf8");
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(a, future, future);
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			expect(result).toMatchObject({
				mode: "incremental",
				refreshed: 1,
				dropped: 0,
				skipped: 0,
				reused: 2,
			});
			expect(searchWordIndex(index, "newQuartz")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "oldZephyr")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("skips an unreadable stale file instead of aborting the whole pass (#958 review F1)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-unreadable-");
		try {
			// Distinct, non-overlapping identifiers: the tokenizer splits camelCase
			// into shared subtokens, so any shared stem would let a query match via
			// a surviving posting and mask the behavior under test.
			const locked = createTempFile(
				env.tmpDir,
				"src/locked.ts",
				"export const mackerel = 1;",
			);
			const other = createTempFile(
				env.tmpDir,
				"src/other.ts",
				"export const walrus = 2;",
			);
			createTempFile(env.tmpDir, "src/third.ts", "export const parsnip = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			// Both files change on disk; `locked` then throws on read (a transient
			// exclusive lock — antivirus, an editor, a build step — that the walk
			// and statSync don't see). statSync must still succeed so the file is a
			// current, stale entry rather than a dropped one.
			fs.writeFileSync(locked, "export const tugboat = 1;", "utf8");
			fs.writeFileSync(other, "export const cinnamon = 2;", "utf8");
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(locked, future, future);
			fs.utimesSync(other, future, future);
			failReads.add(locked);

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("incremental");
			if (result.mode !== "incremental") throw new Error(result.reason);

			// The whole pass survived: the readable stale file refreshed, the
			// unreadable one was skipped (its old posting kept), not a rebuild.
			expect(result.mode).toBe("incremental");
			expect(result.skipped).toBe(1);
			expect(result.refreshed).toBe(1);
			expect(searchWordIndex(index, "cinnamon")[0]?.file).toBe(other);
			// Skipped file keeps its prior posting rather than vanishing, and its
			// new (unread) content is NOT indexed.
			expect(searchWordIndex(index, "mackerel")[0]?.file).toBe(locked);
			expect(searchWordIndex(index, "tugboat")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("drops a deleted file", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-delete-");
		try {
			const deleted = createTempFile(
				env.tmpDir,
				"src/deleted.ts",
				"export const deletedZephyr = 1;",
			);
			createTempFile(env.tmpDir, "src/kept.ts", "export const keptQuartz = 2;");
			createTempFile(env.tmpDir, "src/kept2.ts", "export const keptTwo = 2;");
			createTempFile(env.tmpDir, "src/kept3.ts", "export const keptThree = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			fs.unlinkSync(deleted);

			expect(
				await refreshWordIndexIncrementally(index, env.tmpDir),
			).toMatchObject({
				refreshed: 0,
				dropped: 1,
				reused: 3,
			});
			expect(searchWordIndex(index, "deletedZephyr")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("re-tokenizes an edited file whose disk mtime is the Unix epoch (#958 review F2)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-epoch-");
		try {
			// Distinct, non-overlapping identifiers (see the F1 test note).
			const edited = createTempFile(
				env.tmpDir,
				"src/edited.ts",
				"export const mackerel = 1;",
			);
			createTempFile(env.tmpDir, "src/keep.ts", "export const walrus = 2;");
			createTempFile(env.tmpDir, "src/keep2.ts", "export const parsnip = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			// A per-edit update stamps the impossible-mtime sentinel (never 0).
			updateWordIndexDocument(index, {
				path: edited,
				content: "export const tugboat = 1;",
			});

			// The on-disk file lands at the Unix epoch — a legal mtime some tools
			// produce (archive extraction, SOURCE_DATE_EPOCH=0). With a 0 sentinel
			// this would compare equal and never refresh; the sentinel must differ.
			fs.writeFileSync(edited, "export const cinnamon = 1;", "utf8");
			const epoch = new Date(0);
			fs.utimesSync(edited, epoch, epoch);

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("incremental");
			if (result.mode !== "incremental") throw new Error(result.reason);

			expect(result.refreshed).toBe(1);
			expect(searchWordIndex(index, "cinnamon")[0]?.file).toBe(edited);
			expect(searchWordIndex(index, "tugboat")).toEqual([]);
			expect(searchWordIndex(index, "mackerel")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("re-evaluates the derived cap and flips truncated on growth", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-cap-");
		try {
			process.env.PI_LENS_MAX_PROJECT_FILES = "2"; // word-index ratio => cap 6
			_resetProjectScaleBaseForTests();
			for (let i = 0; i < 5; i++) {
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const value${i} = ${i};`,
				);
			}
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			expect(index.truncated).toBe(false);

			createTempFile(env.tmpDir, "src/f5.ts", "export const value5 = 5;");
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("incremental");
			if (result.mode !== "incremental") throw new Error(result.reason);
			expect(result.refreshed).toBe(1);
			expect(index.docCount).toBe(6);
			expect(index.truncated).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// 200 documents so the 32-document floor is NOT the deciding branch and the
	// 0.30 ratio genuinely is: 60/200 is exactly 0.30 (not "> 0.30") and 61/200 is
	// 0.305. The previous 100/30 fixture sat below the floor, so the test named
	// after the ratio boundary never reached the ratio comparison at all. Content
	// is one short line per file, so the work model (which decides independently)
	// stays far from its own crossover and cannot mask either direction.
	function makeRatioBoundaryFixture(tmpDir: string): string[] {
		return Array.from({ length: 200 }, (_, i) =>
			createTempFile(
				tmpDir,
				`src/f${i}.ts`,
				`export const original${i} = ${i};`,
			),
		);
	}

	async function staleAndRefresh(
		tmpDir: string,
		files: string[],
		staleCount: number,
	) {
		const index = buildWordIndex(await collectWordIndexDocs(tmpDir));
		const future = new Date(Date.now() + 2_000);
		for (const [i, file] of files.slice(0, staleCount).entries()) {
			fs.writeFileSync(file, `export const refreshed${i} = ${i};\n`, "utf8");
			fs.utimesSync(file, future, future);
		}
		return refreshWordIndexIncrementally(index, tmpDir);
	}

	it("keeps exactly-threshold stale density incremental", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-threshold-");
		try {
			const files = makeRatioBoundaryFixture(env.tmpDir);

			const result = await staleAndRefresh(env.tmpDir, files, 60);

			expect(result).toMatchObject({
				mode: "incremental",
				refreshed: 60,
				reused: 140,
			});
		} finally {
			env.cleanup();
		}
	});

	it("crosses to a full rebuild one document above the threshold", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-threshold-over-");
		try {
			const files = makeRatioBoundaryFixture(env.tmpDir);

			const result = await staleAndRefresh(env.tmpDir, files, 61);

			expect(result).toMatchObject({
				mode: "full-required",
				reason: "stale-document-churn",
			});
		} finally {
			env.cleanup();
		}
	});

	it("selects an atomic full rebuild before dense stale mutation (#1197)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-dense-");
		try {
			const files = Array.from({ length: 100 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const original${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const before = serializeWordIndex(index);
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, 32).entries()) {
				fs.writeFileSync(file, `export const refreshed${i} = ${i};\n`, "utf8");
				fs.utimesSync(file, future, future);
			}

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			expect(result).toMatchObject({
				mode: "full-required",
				reason: "stale-document-churn",
			});
			// The preflight decision precedes every drop/posting mutation. The
			// caller can continue serving this index until a full replacement is
			// built and published atomically.
			expect(serializeWordIndex(index)).toEqual(before);
		} finally {
			env.cleanup();
		}
	});

	it("aborts during stat preflight without mutating the old index", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-superseded-");
		try {
			// Every document is made stale, so the refresh loop WOULD read and
			// replace documents if the abort were allowed to reach it. Without the
			// preflight's own abort check the loop's pre-existing every-100 check
			// throws the same message — but only after mutating the first hundred
			// documents, which is what this test now distinguishes.
			const files = Array.from({ length: 200 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const value${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const before = serializeWordIndex(index);
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.entries()) {
				fs.writeFileSync(file, `export const rotated${i} = ${i};\n`, "utf8");
				fs.utimesSync(file, future, future);
			}
			readCounter.root = env.tmpDir;
			readCounter.calls = 0;
			let continuationChecks = 0;

			await expect(
				refreshWordIndexIncrementally(
					index,
					env.tmpDir,
					() => ++continuationChecks < 2,
				),
			).rejects.toThrow("word index refresh superseded");
			expect(serializeWordIndex(index)).toEqual(before);
			// The decisive assertion: the abort landed in the stat preflight, before
			// the churn computation and before a single document was re-read.
			expect(readCounter.calls).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("chooses a full rebuild for a 600-document dense-stale refresh below the density ratio (#1197)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-scaled-dense-");
		try {
			// #1197's acceptance criterion: a guard at the 500+ document dense-stale
			// shape. 150/600 is 25% — UNDER the 0.30 ratio and therefore incremental
			// under a density-only gate, while the per-document posting-array filter
			// over a corpus this size costs far more than one linear rebuild.
			const body = (i: number, tag: string) =>
				Array.from(
					{ length: 6 },
					(_, l) =>
						`export function render${tag}${i}_${l}(requestContext: RequestContext) { return projectSnapshotStore.resolveDocumentEntry(requestContext, ${l}); }`,
				).join("\n");
			const files = Array.from({ length: 600 }, (_, i) =>
				createTempFile(env.tmpDir, `src/f${i}.ts`, body(i, "Original")),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const before = serializeWordIndex(index);
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, 150).entries()) {
				fs.writeFileSync(file, body(i, "Refreshed"), "utf8");
				fs.utimesSync(file, future, future);
			}

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			expect(result).toMatchObject({
				mode: "full-required",
				reason: "stale-document-churn",
			});
			expect(serializeWordIndex(index)).toEqual(before);
		} finally {
			env.cleanup();
		}
	}, 60_000);

	it("reuses the full-required preflight walk when collecting rebuild documents (#1226)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-reuse-preflight-");
		try {
			const files = Array.from({ length: 100 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const original${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, 32).entries()) {
				fs.writeFileSync(file, `export const refreshed${i} = ${i};\n`, "utf8");
				fs.utimesSync(file, future, future);
			}
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("full-required");
			if (result.mode !== "full-required") throw new Error("expected rebuild");
			const afterPreflightWalks = walkCounter.calls;
			const docs = await collectWordIndexDocs(
				env.tmpDir,
				() => true,
				result.preflightFiles,
			);
			expect(docs).toHaveLength(100);
			expect(walkCounter.calls).toBe(afterPreflightWalks);
		} finally {
			env.cleanup();
		}
	});

	it("re-stats rebuild documents changed after the preflight walk (#1302)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-stale-window-");
		try {
			const files = Array.from({ length: 100 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const original${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const preflightMtime = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, 32).entries()) {
				fs.writeFileSync(file, `export const refreshed${i} = ${i};\n`, "utf8");
				fs.utimesSync(file, preflightMtime, preflightMtime);
			}

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("full-required");
			if (result.mode !== "full-required") throw new Error("expected rebuild");

			const target = files[0];
			const readMtime = new Date(preflightMtime.getTime() + 2_000);
			fs.writeFileSync(target, "export const changedAfterWalk = 1;\n", "utf8");
			fs.utimesSync(target, readMtime, readMtime);
			const rebuilt = buildWordIndex(
				await collectWordIndexDocs(
					env.tmpDir,
					() => true,
					result.preflightFiles,
				),
			);
			expect(rebuilt.fileMtimes?.get(target)).toBe(fs.statSync(target).mtimeMs);

			const nextMtime = new Date(readMtime.getTime() + 2_000);
			fs.writeFileSync(target, "export const changedAgain = 2;\n", "utf8");
			fs.utimesSync(target, nextMtime, nextMtime);
			await expect(
				refreshWordIndexIncrementally(rebuilt, env.tmpDir),
			).resolves.toMatchObject({
				mode: "incremental",
				refreshed: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("yields the refresh loop on a time budget, not only every 100 documents (#1197)", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-budget-");
		try {
			// Fewer than 100 documents, so the every-100 checkpoint NEVER fires and a
			// count-only refresh loop runs the whole stale set as one synchronous
			// burst. The vocabulary is unique per (file, line, token) so posting
			// arrays stay short and the work model keeps this on the incremental
			// path — the point under test is the loop's cooperativeness, not the
			// dense-refresh gate.
			const enc = (n: number) => {
				let out = "";
				let v = n + 1;
				while (v > 0) {
					out += String.fromCharCode(97 + (v % 26));
					v = Math.floor(v / 26);
				}
				return out;
			};
			const body = (i: number, tag: string) =>
				Array.from({ length: 200 }, (_, l) =>
					Array.from(
						{ length: 20 },
						(_, k) => `qq${enc(i)}${tag}${enc(l)}${enc(k)}zz`,
					).join(" "),
				).join("\n");
			const files = Array.from({ length: 40 }, (_, i) =>
				createTempFile(env.tmpDir, `src/f${i}.ts`, body(i, "aa")),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const future = new Date(Date.now() + 2_000);
			for (const [i, file] of files.slice(0, 25).entries()) {
				fs.writeFileSync(file, body(i, "bb"), "utf8");
				fs.utimesSync(file, future, future);
			}

			// `shouldContinue` is re-checked after every yield, so its call count is
			// a direct, timing-free read of how often the pass yielded. A count-only
			// loop over 40 documents yields zero times and calls it exactly once (the
			// post-walk check).
			let continuationChecks = 0;
			const result = await refreshWordIndexIncrementally(
				index,
				env.tmpDir,
				() => {
					continuationChecks += 1;
					return true;
				},
			);

			expect(result).toMatchObject({ mode: "incremental", refreshed: 25 });
			expect(continuationChecks).toBeGreaterThan(4);
		} finally {
			env.cleanup();
		}
	}, 60_000);
});
