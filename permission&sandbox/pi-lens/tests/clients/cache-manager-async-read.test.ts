/**
 * #3274: `CacheManager.readCacheAsync` — the boundable sibling of `readCache`.
 *
 * Recurrence prevented: `turn_end` read three scanner stores through the
 * SYNCHRONOUS `readCache`, and nothing could bound it. `bounded()`
 * (`clients/deadline-utils.ts`) takes a promise, and the sync read completes
 * during ARGUMENT EVALUATION — #3274's probe against the built seam, with an
 * already-aborted signal and `ms: 0`, got `undefined` back from `bounded()`
 * while the read had already parsed its JSON. A wrapper there registered a
 * turn_end budget that could never be spent.
 *
 * So the property that matters is not "it returns a promise" (an `async`
 * function whose body is synchronous does too, and would be just as
 * unboundable). It is that the read SUSPENDS before it touches the data file,
 * which the first case here measures by rewriting that file in the same tick
 * as the call and watching the new bytes come back.
 *
 * Everything else is parity with the seam it must be able to replace: the same
 * verdicts for a warm, missing, stale and corrupt store, from the real
 * filesystem through the real `CacheManager` — no mocks, no doubles.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import { bounded } from "../../clients/deadline-utils.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;
let cacheManager: CacheManager;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3274-async-read-")),
	);
	cacheManager = new CacheManager(false);
});

afterEach(() => removeTempDirSync(tmpDir));

const storePath = (scanner: string) =>
	path.join(getProjectDataDir(tmpDir), "cache", `${scanner}.json`);
const metaPath = (scanner: string) =>
	path.join(getProjectDataDir(tmpDir), "cache", `${scanner}.meta.json`);

describe("#3274 CacheManager.readCacheAsync", () => {
	it("suspends before reading the store, so a bound can abandon it", async () => {
		cacheManager.writeCache("probe", { marker: "before" }, tmpDir);

		const pending = cacheManager.readCacheAsync<{ marker: string }>(
			"probe",
			tmpDir,
		);
		// Still in the SAME tick as the call. A synchronous read has already
		// parsed `before` by now (that is the whole defect); an `fs.promises`
		// read has not even started this file — the meta envelope has to resolve
		// first — so the bytes it returns are the ones written here.
		fs.writeFileSync(storePath("probe"), JSON.stringify({ marker: "after" }));

		expect((await pending)?.data.marker).toBe("after");
	});

	it("is a promise `bounded()` can abandon, and abandoning yields undefined", async () => {
		cacheManager.writeCache("probe", { marker: "warm" }, tmpDir);

		// #3274's probe, inverted: the same tightest-possible bound that could
		// not stop the synchronous read stops this one before it delivers.
		const abandoned = await bounded(
			cacheManager.readCacheAsync<{ marker: string }>("probe", tmpDir),
			{
				ms: 0,
				signal: AbortSignal.abort(),
				hook: "turn_end",
				label: "readCacheAsync-probe",
			},
		);
		expect(abandoned).toBeUndefined();

		// And with a live budget the same call delivers, so the bound is what
		// made the difference rather than a broken read.
		const delivered = await bounded(
			cacheManager.readCacheAsync<{ marker: string }>("probe", tmpDir),
			{
				ms: 5_000,
				signal: undefined,
				hook: "turn_end",
				label: "readCacheAsync-probe",
			},
		);
		expect(delivered?.data.marker).toBe("warm");
	});

	it("returns the same envelope as the synchronous read for a warm store", async () => {
		cacheManager.writeCache("parity", { findings: [1, 2, 3] }, tmpDir);

		const sync = cacheManager.readCache<{ findings: number[] }>(
			"parity",
			tmpDir,
		);
		const async_ = await cacheManager.readCacheAsync<{ findings: number[] }>(
			"parity",
			tmpDir,
		);

		expect(async_).toEqual(sync);
		expect(async_?.data.findings).toEqual([1, 2, 3]);
		expect(async_?.meta.timestamp).toBe(sync?.meta.timestamp);
	});

	it("returns null for a store that was never written", async () => {
		expect(await cacheManager.readCacheAsync("missing", tmpDir)).toBeNull();
		expect(cacheManager.readCache("missing", tmpDir)).toBeNull();
	});

	it("returns null past the TTL, on the same boundary as the sync read", async () => {
		cacheManager.writeCache("aged", { findings: [] }, tmpDir);
		const written = JSON.parse(fs.readFileSync(metaPath("aged"), "utf-8")) as {
			timestamp: string;
		};
		const ageMs = Date.now() - new Date(written.timestamp).getTime();

		// One shared `freshAgeMs` decides both, so the two seams cannot disagree
		// about a store one of them read a moment before the other.
		expect(await cacheManager.readCacheAsync("aged", tmpDir, -1)).toBeNull();
		expect(cacheManager.readCache("aged", tmpDir, -1)).toBeNull();
		expect(
			await cacheManager.readCacheAsync("aged", tmpDir, ageMs + 60_000),
		).not.toBeNull();
		expect(
			cacheManager.readCache("aged", tmpDir, ageMs + 60_000),
		).not.toBeNull();
	});

	it("keeps an envelope at EXACTLY maxAgeMs, and drops it one ms later — both seams (F10)", async () => {
		// #3305 review M3305-1: the shared `freshAgeMs` compares `age > maxAgeMs`,
		// and nothing redded when that became `>=`. The boundary is the whole
		// content of a TTL rule, and it has to hold IDENTICALLY on the two seams
		// while #3300 migrates callers across — a delivery that reads one store
		// through each method must not see it fresh and stale at once.
		vi.useFakeTimers();
		try {
			const written = new Date("2026-08-18T07:00:00.000Z");
			vi.setSystemTime(written);
			cacheManager.writeCache("boundary", { findings: [] }, tmpDir);

			// age === maxAgeMs exactly: still fresh, on both seams.
			vi.setSystemTime(new Date(written.getTime() + 1_000));
			expect(cacheManager.readCache("boundary", tmpDir, 1_000)).not.toBeNull();
			expect(
				await cacheManager.readCacheAsync("boundary", tmpDir, 1_000),
			).not.toBeNull();

			// One millisecond past it: stale, on both seams.
			vi.setSystemTime(new Date(written.getTime() + 1_001));
			expect(cacheManager.readCache("boundary", tmpDir, 1_000)).toBeNull();
			expect(
				await cacheManager.readCacheAsync("boundary", tmpDir, 1_000),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns null — never a throw — for a corrupt store (F4)", async () => {
		cacheManager.writeCache("corrupt", { findings: [] }, tmpDir);
		fs.writeFileSync(storePath("corrupt"), "{not json");

		await expect(
			cacheManager.readCacheAsync("corrupt", tmpDir),
		).resolves.toBeNull();
		expect(cacheManager.readCache("corrupt", tmpDir)).toBeNull();
	});

	it("returns null — never a throw — for a corrupt META file", async () => {
		cacheManager.writeCache("corrupt-meta", { findings: [] }, tmpDir);
		fs.writeFileSync(metaPath("corrupt-meta"), "{not json");

		await expect(
			cacheManager.readCacheAsync("corrupt-meta", tmpDir),
		).resolves.toBeNull();
		expect(cacheManager.readCache("corrupt-meta", tmpDir)).toBeNull();
	});
});
