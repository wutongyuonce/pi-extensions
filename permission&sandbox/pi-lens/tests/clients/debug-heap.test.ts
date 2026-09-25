import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";

/**
 * `clients/debug-heap.ts` reads `PI_LENS_DEBUG_HEAP` ONCE at module load (the
 * `PI_LENS_DEBUG_HANDLES` sibling for #1126). As in the debug-handles test,
 * every test here must `vi.resetModules()` and set the env var BEFORE the
 * dynamic `import()` — setting it after import would not take effect, by design.
 *
 * `PI_LENS_HOME` is already pointed at a per-worker temp dir by
 * `tests/support/vitest-setup.ts`, so `getGlobalPiLensDir()` is hermetic.
 */

function heapSnapshotLogPath(): string {
	return path.join(getGlobalPiLensDir(), "heap-snapshots.log");
}

function listSnapshots(): string[] {
	return fs
		.readdirSync(getGlobalPiLensDir())
		.filter((n) => n.startsWith("heap-") && n.endsWith(".heapsnapshot"));
}

function cleanSnapshots(): void {
	const dir = getGlobalPiLensDir();
	try {
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith("heap-") && name.endsWith(".heapsnapshot")) {
				fs.rmSync(path.join(dir, name), { force: true });
			}
		}
	} catch {
		// dir may not exist yet
	}
	fs.rmSync(heapSnapshotLogPath(), { force: true });
}

async function importFresh(enabled: boolean) {
	vi.resetModules();
	if (enabled) {
		process.env.PI_LENS_DEBUG_HEAP = "1";
	} else {
		delete process.env.PI_LENS_DEBUG_HEAP;
	}
	return import("../../clients/debug-heap.js");
}

describe("debug-heap: PI_LENS_DEBUG_HEAP unset (default)", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HEAP;
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HEAP;
		else process.env.PI_LENS_DEBUG_HEAP = originalFlag;
		vi.resetModules();
	});

	it("isDebugHeapEnabled() is false", async () => {
		const mod = await importFresh(false);
		expect(mod.isDebugHeapEnabled()).toBe(false);
	});

	it("writeHeapSnapshotNow is a no-op — returns null and writes no file", async () => {
		const mod = await importFresh(false);
		const before = listSnapshots().length;
		expect(mod.writeHeapSnapshotNow("lens_health")).toBeNull();
		await mod.flushHeapSnapshotLog();
		expect(listSnapshots().length).toBe(before);
		expect(fs.existsSync(mod.getHeapSnapshotLogPath())).toBe(false);
	});
});

describe("debug-heap: snapshot filename (pure)", () => {
	it("folds ISO ':' and '.' to '-' so the name is a legal Windows path", async () => {
		const mod = await importFresh(false); // pure fn — flag irrelevant
		const name = mod.snapshotFileName(1234, "2026-08-08T12:34:56.789Z");
		expect(name).toBe("heap-1234-2026-08-08T12-34-56-789Z.heapsnapshot");
		expect(name).not.toMatch(/[:*?"<>|]/);
	});
});

describe("debug-heap: pruneOldSnapshots (bounded on-disk axis, shape 9)", () => {
	afterEach(() => cleanSnapshots());

	it("keeps the newest N by mtime and removes older snapshots; ignores non-snapshot files", () => {
		const dir = getGlobalPiLensDir();
		fs.mkdirSync(dir, { recursive: true });
		cleanSnapshots();

		// Five snapshots with strictly increasing mtimes; oldest → newest.
		const created: string[] = [];
		for (let i = 0; i < 5; i++) {
			const full = path.join(
				dir,
				`heap-999-2026-08-08T00-00-0${i}-000Z.heapsnapshot`,
			);
			fs.writeFileSync(full, "x");
			const t = new Date(2026, 0, 1, 0, 0, i).getTime() / 1000;
			fs.utimesSync(full, t, t);
			created.push(full);
		}
		// A sibling file that must never be touched.
		const bystander = path.join(dir, "heap-snapshots.log");
		fs.writeFileSync(bystander, "keep-me");

		// Import fresh AFTER files exist so nothing races the module writer.
		return importFresh(false).then((mod) => {
			const removed = mod.pruneOldSnapshots(dir, 3);
			// Oldest two removed.
			expect(removed.sort()).toEqual([created[0], created[1]].sort());
			expect(listSnapshots().length).toBe(3);
			// The three newest survive.
			for (const full of created.slice(2))
				expect(fs.existsSync(full)).toBe(true);
			// The breadcrumb log is untouched.
			expect(fs.readFileSync(bystander, "utf-8")).toBe("keep-me");
		});
	});

	it("returns [] for a nonexistent directory (best-effort, never throws)", async () => {
		const mod = await importFresh(false);
		const missing = path.join(getGlobalPiLensDir(), "does-not-exist-xyz");
		expect(mod.pruneOldSnapshots(missing)).toEqual([]);
	});
});

describe("debug-heap: PI_LENS_DEBUG_HEAP=1 set at startup", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HEAP;
		cleanSnapshots();
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HEAP;
		else process.env.PI_LENS_DEBUG_HEAP = originalFlag;
		cleanSnapshots();
		vi.resetModules();
	});

	it("isDebugHeapEnabled() is true", async () => {
		const mod = await importFresh(true);
		expect(mod.isDebugHeapEnabled()).toBe(true);
	});

	it("writeHeapSnapshotNow writes a real .heapsnapshot and one breadcrumb line", async () => {
		const mod = await importFresh(true);
		const result = mod.writeHeapSnapshotNow("lens_health");
		await mod.flushHeapSnapshotLog();

		expect(result).not.toBeNull();
		if (!result) return;
		// The file exists and is non-empty (a real V8 snapshot of this worker).
		expect(fs.existsSync(result.path)).toBe(true);
		expect(fs.statSync(result.path).size).toBeGreaterThan(0);
		expect(result.rssBytes).toBeGreaterThan(0);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		const raw = fs.readFileSync(mod.getHeapSnapshotLogPath(), "utf-8");
		const linesOut = raw.split("\n").filter(Boolean);
		expect(linesOut).toHaveLength(1);
		const entry = JSON.parse(linesOut[0]);
		expect(entry.label).toBe("lens_health");
		expect(entry.path).toBe(result.path);
		expect(entry.pid).toBe(process.pid);
		expect(typeof entry.rssBytes).toBe("number");
		expect(typeof entry.durationMs).toBe("number");
		expect(typeof entry.ts).toBe("string");
	});

	it("repeated writes never exceed SNAPSHOT_RETENTION files on disk", async () => {
		const mod = await importFresh(true);
		// Each real V8 snapshot write takes >1ms, so the ISO-ms-stamped filenames
		// differ naturally; a rare same-ms collision merely overwrites, which only
		// lowers the count — the bound still holds either way.
		for (let i = 0; i < mod.SNAPSHOT_RETENTION + 2; i++) {
			mod.writeHeapSnapshotNow("lens_health");
		}
		await mod.flushHeapSnapshotLog();
		expect(listSnapshots().length).toBeLessThanOrEqual(mod.SNAPSHOT_RETENTION);
	});
});
