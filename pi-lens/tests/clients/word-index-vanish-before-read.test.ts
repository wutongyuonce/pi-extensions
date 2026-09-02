/**
 * #1227 matrix row 2: file vanishes between walk and read.
 *
 * `refreshWordIndexIncrementally` stats every walked file in a preflight pass
 * (building the `current` map), decides incremental-vs-full from that
 * snapshot, then — for each file it judged stale — calls `fs.readFileSync` in
 * a SECOND pass. `word-index-session-refresh.test.ts` already covers a stale
 * file that is unreadable throughout (EBUSY, a locked file present the whole
 * time) — this covers the specific ORDERING the issue calls out: the file is
 * genuinely present when the preflight `fs.statSync` runs (so it lands in
 * `current`, un-dropped), and is deleted in the gap before the read in the
 * second pass. The interception below unlinks the real file the instant
 * `readFileSync` is called for it, so the resulting ENOENT is the real
 * filesystem's, not a synthetic stand-in for a lock.
 *
 * Invariant lock (#1227 acceptance 2): the skip contract this asserts already
 * holds on current code via the same try/catch as #958 F1's unreadable-file
 * case — this pins the vanish-between-walk-and-read cause specifically.
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
	searchWordIndex,
} from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { vanishOnRead } = vi.hoisted(() => ({
	vanishOnRead: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		readFileSync: ((path: unknown, options?: unknown) => {
			if (typeof path === "string" && vanishOnRead.has(path)) {
				vanishOnRead.delete(path);
				// The file was present for the preflight `statSync` (it landed in
				// `current`) and is deleted in the window before this read — the
				// exact ordering under test. The real fs throws its own real ENOENT.
				actual.unlinkSync(path);
			}
			return (actual.readFileSync as (...a: unknown[]) => unknown)(
				path,
				options,
			);
		}) as typeof fs.readFileSync,
	};
});

afterEach(() => {
	vanishOnRead.clear();
	vi.restoreAllMocks();
});

describe("word-index refresh: file vanishes between walk-stat and read (#1227)", () => {
	it("skips the vanished file and retains its old posting, without aborting the pass", async () => {
		const env = setupTestEnvironment("pi-lens-word-vanish-read-");
		try {
			const vanishing = createTempFile(
				env.tmpDir,
				"src/vanishing.ts",
				"export const narwhal = 1;",
			);
			const other = createTempFile(
				env.tmpDir,
				"src/other.ts",
				"export const walrus = 2;",
			);
			createTempFile(env.tmpDir, "src/third.ts", "export const parsnip = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			expect(index.docCount).toBe(3);

			// Both files become stale (content + mtime moved forward); `vanishing`
			// is still present on disk right now — statSync in the preflight pass
			// will see it — but is deleted the instant its read is attempted.
			fs.writeFileSync(vanishing, "export const beluga = 1;", "utf8");
			fs.writeFileSync(other, "export const cinnamon = 2;", "utf8");
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(vanishing, future, future);
			fs.utimesSync(other, future, future);
			vanishOnRead.add(vanishing);

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.mode).toBe("incremental");
			if (result.mode !== "incremental") throw new Error(result.reason);

			// The readable stale file refreshed; the vanished one was skipped, not
			// dropped — its prior posting is retained (it will be picked up as a
			// genuine deletion on the NEXT session's walk, once it no longer
			// appears at all).
			expect(result.skipped).toBe(1);
			expect(result.dropped).toBe(0);
			expect(result.refreshed).toBe(1);
			expect(searchWordIndex(index, "cinnamon")[0]?.file).toBe(other);
			expect(searchWordIndex(index, "narwhal")[0]?.file).toBe(vanishing);
			expect(searchWordIndex(index, "beluga")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
