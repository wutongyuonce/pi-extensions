/**
 * Tests for clients/atomic-write.ts (#762) — the shared tmp+rename atomic
 * writer that replaces the five hand-rolled `${target}.tmp-${pid}` +
 * `renameSync`/`rename` writers (instance-registry.ts, session-state-store.ts,
 * recent-touches.ts, review-graph/builder.ts, diagnostic-dispositions.ts).
 *
 * Covers the sync (`writeFileAtomic`) and async (`writeFileAtomicAsync`)
 * variants: success replaces content atomically, no tmp file is left behind
 * on success or on a swallowed failure, `bestEffort: true` (default) swallows
 * a rename failure, and `bestEffort: false` rethrows it (the #757
 * diagnostic-dispositions policy) after the same best-effort tmp cleanup.
 *
 * Rename failures are induced with a REAL filesystem obstruction (renaming a
 * file onto an existing non-empty directory), not a mocked `fs` — this repo's
 * `atomic-write.ts` uses `import * as fs from "node:fs"`, and Node's builtin
 * module namespace bindings don't reliably re-bind under `vi.spyOn` here, so
 * a genuine EPERM/ENOTEMPTY/EISDIR exercises the real failure path end to end
 * on every platform (verified: renaming onto a non-empty dir fails with EPERM
 * on Windows, ENOTEMPTY/EISDIR on POSIX).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	writeFileAtomic,
	writeFileAtomicAsync,
} from "../../clients/atomic-write.js";
import {
	STAGE_TMP_PATTERN,
	stageOwnerPidFromName,
	stagePathFor,
} from "../../clients/atomic-write-staging.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

function tmpLeftovers(): string[] {
	return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

/** A target path that already exists as a non-empty directory: renaming a
 * file onto it reliably fails on every platform. */
function makeUnrenamableTarget(): string {
	const target = path.join(dir, "state.json");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "keep.txt"), "occupied");
	return target;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-atomic-write-"));
});

afterEach(() => {
	removeTempDirSync(dir);
});

describe("writeFileAtomic (sync)", () => {
	it("replaces the target's content atomically on success", () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		writeFileAtomic(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("creates the target when it doesn't exist yet", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
	});

	it("leaves no tmp-<pid> file behind on success", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("leaves no tmp-<pid> file behind when the rename fails (bestEffort)", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
		expect(tmpLeftovers()).toEqual([]);
		// The obstruction directory is untouched — only the tmp file was cleaned up.
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: true (default) swallows a rename failure", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", () => {
		const target = makeUnrenamableTarget();
		expect(() =>
			writeFileAtomic(target, "hello", { bestEffort: false }),
		).toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: false lets a successful write/rename through untouched", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello", { bestEffort: false });
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
		expect(tmpLeftovers()).toEqual([]);
	});
});

/**
 * #1609 review F4: `WriteFileAtomicOptions.mode` (added so the installer's
 * downloaded binaries keep their executable bit across the staged-file
 * rename) had zero coverage on any OS — the install-test CI matrix never
 * runs the installer itself. POSIX-only: Windows' `fs` mode support does not
 * carry a POSIX permission-bit meaning (`statSync(...).mode` on Windows
 * reflects the read-only attribute only, not `0o750`-style bits), so this
 * would either vacuously pass or need a separate Windows-specific assertion
 * that tests something else entirely — skip there rather than assert
 * something not actually being verified (defect shape 7).
 */
describe.skipIf(process.platform === "win32")(
	"writeFileAtomic mode option (#1609 review F4)",
	() => {
		it("writeFileAtomic (sync) applies the requested mode to the published file", () => {
			const target = path.join(dir, "tool-binary");
			writeFileAtomic(target, "#!/bin/sh\necho hi\n", { mode: 0o750 });
			expect(fs.statSync(target).mode & 0o777).toBe(0o750);
		});

		it("writeFileAtomicAsync applies the requested mode to the published file", async () => {
			const target = path.join(dir, "tool-binary-async");
			await writeFileAtomicAsync(target, "#!/bin/sh\necho hi\n", {
				mode: 0o750,
			});
			expect(fs.statSync(target).mode & 0o777).toBe(0o750);
		});

		it("omitting mode falls back to the umask-governed default (does not force 0o750)", () => {
			const target = path.join(dir, "plain-file");
			writeFileAtomic(target, "no mode option here");
			expect(fs.statSync(target).mode & 0o111).toBe(0); // not executable
		});
	},
);

describe("writeFileAtomicAsync", () => {
	it("replaces the target's content atomically on success", async () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		await writeFileAtomicAsync(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("leaves no tmp-<pid> file behind on success", async () => {
		const target = path.join(dir, "state.json");
		await writeFileAtomicAsync(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: true (default) swallows a rename failure and leaves no tmp file", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello"),
		).resolves.toBeUndefined();
		expect(tmpLeftovers()).toEqual([]);
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello", { bestEffort: false }),
		).rejects.toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});
});

/**
 * #1205 regression: the staging file used to be named `${target}.tmp-${pid}` —
 * per-PROCESS, not per-CALL. Two concurrent writes from one process to one
 * target therefore shared a staging inode: both `open(O_TRUNC)`ed it, the
 * first `rename` published that inode to the target, and the second writer's
 * still-open fd kept writing into the now-PUBLISHED file. The result was a
 * torn hybrid at the target path.
 *
 * Two independent assertions, so this has teeth on every OS rather than only
 * where the interleaving happens to be observable:
 *
 *  1. STRUCTURAL — deterministic on every platform, no scheduler race to win:
 *     two concurrent writes must use DISTINCT staging paths on the real
 *     filesystem (observed via the `path` on the rename error, which is the
 *     staging file the writer actually created), and `stagePathFor` must never
 *     repeat a name. Pre-fix both collapse to the single `.tmp-<pid>` name.
 *  2. BEHAVIOURAL: the published file must be byte-exactly one of the two
 *     payloads, never a hybrid. Mismatched payload sizes (2 MB vs 50 KB) make
 *     a hybrid trivially detectable. This is the assertion that was observed
 *     failing 35/40 on Windows in the issue report (13/40 when re-measured
 *     while developing this test). Whether the interleaving is *observable*
 *     is timing- and OS-dependent, which is exactly why assertion 1 exists.
 *
 * Nothing here branches on `process.platform`; the filesystem is probed
 * directly (recurring defect shape 2/7 — dev is Windows, CI is Linux).
 */
describe("concurrent same-process writes to one target (#1205)", () => {
	const ITERATIONS = 40;
	// Mismatched sizes: a hybrid is detectable by length alone, and a 2 MB
	// payload is large enough that Node's writeFile issues multiple chunked
	// writes, widening the interleaving window on every platform.
	const BIG = "A".repeat(2 * 1024 * 1024);
	const SMALL = "B".repeat(50 * 1024);

	/** Byte-exact identity against one of the two payloads, with a cheap
	 * failure message (never dump 2 MB into the diff). */
	function describePublished(published: string): string {
		if (published === BIG) return "BIG";
		if (published === SMALL) return "SMALL";
		return `HYBRID(len=${published.length}, A=${
			published.split("A").length - 1
		}, B=${published.split("B").length - 1})`;
	}

	it("async vs async: publishes exactly one payload, never a hybrid", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const target = path.join(dir, `race-async-${i}.json`);
			// Alternate launch order so neither writer is systematically first.
			const [first, second] = i % 2 === 0 ? [BIG, SMALL] : [SMALL, BIG];
			await Promise.all([
				writeFileAtomicAsync(target, first),
				writeFileAtomicAsync(target, second),
			]);
			outcomes.push(describePublished(fs.readFileSync(target, "utf-8")));
		}
		expect(outcomes.filter((o) => o.startsWith("HYBRID"))).toEqual([]);
	});

	it("sync vs in-flight async: publishes exactly one payload, never a hybrid", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const target = path.join(dir, `race-sync-${i}.json`);
			const pending = writeFileAtomicAsync(target, BIG);
			writeFileAtomic(target, SMALL);
			await pending;
			outcomes.push(describePublished(fs.readFileSync(target, "utf-8")));
		}
		expect(outcomes.filter((o) => o.startsWith("HYBRID"))).toEqual([]);
	});

	/**
	 * Deterministic structural guard — no scheduler race required, so this
	 * fires identically on Windows and on Linux CI.
	 *
	 * `bestEffort: false` against a target obstructed by a non-empty directory
	 * makes the rename fail, and Node populates `err.path` with the staging
	 * file the writer actually created on disk. Two concurrent writers must
	 * report two different staging paths; pre-fix they report the same one,
	 * which IS the shared-inode condition that produces the torn publish.
	 */
	it("concurrent writers create distinct staging files on disk", async () => {
		const target = makeUnrenamableTarget();
		const stagePaths = await Promise.all(
			[BIG, SMALL].map(async (payload) => {
				try {
					await writeFileAtomicAsync(target, payload, { bestEffort: false });
				} catch (err) {
					return (err as NodeJS.ErrnoException).path;
				}
				throw new Error("expected the rename onto a non-empty dir to fail");
			}),
		);
		expect(stagePaths.every((p) => typeof p === "string")).toBe(true);
		expect(new Set(stagePaths).size).toBe(2);
		for (const p of stagePaths) {
			expect(STAGE_TMP_PATTERN.test(p as string)).toBe(true);
		}
	});

	it("leaves no staging files behind after concurrent writes", async () => {
		const target = path.join(dir, "state.json");
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				writeFileAtomicAsync(target, i % 2 === 0 ? BIG : SMALL),
			),
		);
		expect(tmpLeftovers()).toEqual([]);
	});
});

describe("stagePathFor (#1205)", () => {
	it("returns a distinct path on every call for the same target", () => {
		const target = path.join(dir, "state.json");
		const paths = Array.from({ length: 100 }, () => stagePathFor(target));
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("keeps the target as a prefix and carries this process's pid and thread id", () => {
		const target = path.join(dir, "state.json");
		const staged = stagePathFor(target);
		expect(staged.startsWith(`${target}.tmp-${process.pid}-${threadId}-`)).toBe(
			true,
		);
	});

	it("STAGE_TMP_PATTERN matches the names stagePathFor produces", () => {
		const staged = path.basename(stagePathFor(path.join(dir, "state.json")));
		expect(STAGE_TMP_PATTERN.test(staged)).toBe(true);
	});

	it("STAGE_TMP_PATTERN matches only the current staging shape", () => {
		expect(STAGE_TMP_PATTERN.test("review-graph.json.gz.tmp-4242-3-7")).toBe(
			true,
		);
		expect(STAGE_TMP_PATTERN.test("review-graph.json.gz.tmp-4242")).toBe(false);
		expect(STAGE_TMP_PATTERN.test("review-graph.json.gz.tmp-4242-7")).toBe(
			false,
		);
		expect(STAGE_TMP_PATTERN.test("x.tmp-000123-02-03")).toBe(false);
		expect(stageOwnerPidFromName("backup.tmp-01-02-03")).toBeUndefined();
	});

	it("STAGE_TMP_PATTERN does not match ordinary store files", () => {
		for (const name of [
			"review-graph.json.gz",
			"state.json",
			"project-snapshot.json.gz.stage-4242-7",
			// One group past the widest staging shape — still not ours.
			"x.tmp-1-2-3-4",
			"data.tmp-",
			"x.tmp--1",
			"foo.TMP-42",
		]) {
			expect(STAGE_TMP_PATTERN.test(name)).toBe(false);
		}
	});
});

/**
 * #1217: `stagePathFor`'s counter is per-THREAD (a worker gets its own module
 * instance, so its own `_stageSeq` starting at 0) while `process.pid` is shared
 * across every thread of the process. Pid + counter alone therefore let two
 * threads mint the identical `${target}.tmp-<pid>-0` — #1205's shared-inode
 * tear, reintroduced one axis over. `threadId` is the part that closes it, and
 * `gzip-stage-write.ts` (which runs on the review-graph and project-snapshot
 * persist workers) is a real worker-side caller, not a hypothetical one.
 *
 * Real `Worker`s rather than a simulated thread id: the property under test is
 * that a *fresh module instance* on another thread cannot collide, which a
 * same-thread test cannot exercise at all. The workers import the compiled
 * sibling `.js` — the same file vitest itself loads for this suite (see
 * tests/support/check-build-freshness.ts), so it is never a stale build.
 */
describe("stagePathFor across worker threads (#1217)", () => {
	const atomicWriteUrl = new URL(
		"../../clients/atomic-write.js",
		import.meta.url,
	).href;

	// CommonJS body (Node's `eval: true` workers are CJS) that dynamic-imports
	// the ESM module and reports the first staging name it mints.
	const WORKER_SRC = `
		const { parentPort, workerData, threadId } = require("node:worker_threads");
		import(workerData.url)
			.then((m) => parentPort.postMessage({ threadId, staged: m.stagePathFor(workerData.target) }))
			.catch((err) => parentPort.postMessage({ error: String(err && err.stack || err) }));
	`;

	interface StageReport {
		threadId: number;
		staged?: string;
		error?: string;
	}

	function stageOnWorker(target: string): Promise<StageReport> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER_SRC, {
				eval: true,
				workerData: { url: atomicWriteUrl, target },
			});
			worker.once("message", (msg: StageReport) => {
				resolve(msg);
				void worker.terminate();
			});
			worker.once("error", reject);
		});
	}

	it("two workers minting for one target produce distinct staging paths", async () => {
		const target = path.join(dir, "state.json");
		const results = await Promise.all([
			stageOnWorker(target),
			stageOnWorker(target),
		]);
		for (const r of results) expect(r.error).toBeUndefined();

		const staged = results.map((r) => r.staged as string);
		// Both are each thread's FIRST mint, so both carry seq 0 — pre-fix that
		// made them byte-identical.
		expect(staged.every((s) => s.endsWith("-0"))).toBe(true);
		expect(new Set(staged).size).toBe(2);
		expect(new Set(results.map((r) => r.threadId)).size).toBe(2);
		for (const s of staged) {
			expect(s.startsWith(`${target}.tmp-${process.pid}-`)).toBe(true);
			expect(STAGE_TMP_PATTERN.test(s)).toBe(true);
		}
	});

	it("a worker's staging path does not collide with the main thread's", async () => {
		const target = path.join(dir, "state.json");
		// Reset nothing: the main thread's counter has already advanced, so this
		// asserts the thread-id segment rather than counter luck.
		const mine = stagePathFor(target);
		const theirs = await stageOnWorker(target);
		expect(theirs.error).toBeUndefined();
		expect(theirs.staged).not.toBe(mine);
		expect(mine.startsWith(`${target}.tmp-${process.pid}-${threadId}-`)).toBe(
			true,
		);
		expect(
			(theirs.staged as string).startsWith(
				`${target}.tmp-${process.pid}-${threadId}-`,
			),
		).toBe(false);
	});
});
