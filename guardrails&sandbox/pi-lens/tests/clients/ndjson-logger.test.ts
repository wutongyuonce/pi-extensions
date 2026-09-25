import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.spyOn(fs, "appendFileSync")` cannot redefine node:fs's ESM namespace
// export directly (see workspace-topology.test.ts) — wrap it via vi.mock
// instead, keeping the real implementation by default so every other test in
// this file is unaffected; the #1970 flushSync tests override it per-call via
// mockImplementationOnce. `fsMockState` is `vi.hoisted` so the factory below
// (itself hoisted above this file's imports) can stash the real
// implementation somewhere `afterEach` can reach it to fully reset the mock
// (see `afterEach` below) — a `mockClear()` alone leaves queued
// `mockImplementationOnce` entries from a test whose retry path never
// consumed them (e.g. after the retry-removal mutation probe) to leak into
// whichever test runs next.
const fsMockState = vi.hoisted(() => ({
	realAppendFileSync:
		undefined as unknown as typeof import("node:fs").appendFileSync,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMockState.realAppendFileSync = actual.appendFileSync;
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

import {
	_exitFlushersForTest,
	createNdjsonLogger,
	getSinkWriteFailures,
	resetSinkWriteFailures,
} from "../../clients/ndjson-logger.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;
let logFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-logger-"));
	logFile = path.join(tmpDir, "test.log");
});

afterEach(() => {
	vi.restoreAllMocks();
	// `fs.appendFileSync` is a module-scope `vi.fn()` (see the `vi.mock` above),
	// not a per-test `vi.spyOn` — `restoreAllMocks()` doesn't touch it at all.
	// `mockReset()` (not `mockClear()`) also drops any QUEUED
	// `mockImplementationOnce` entries a test left unconsumed, then the real
	// implementation is restored as the default so every other test's writes
	// still land on disk.
	const appendFileSync = fs.appendFileSync as unknown as ReturnType<
		typeof vi.fn
	>;
	appendFileSync.mockReset();
	if (fsMockState.realAppendFileSync) {
		appendFileSync.mockImplementation(fsMockState.realAppendFileSync);
	}
	removeTempDirSync(tmpDir);
	resetSinkWriteFailures();
});

function readLines(file: string): string[] {
	return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
}

describe("createNdjsonLogger", () => {
	it("serializes a burst of log() calls in enqueue order", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 50; i++) {
			logger.log({ i });
		}
		await logger.flush();

		const lines = readLines(logFile);
		expect(lines).toHaveLength(50);
		lines.forEach((line, idx) => {
			expect(JSON.parse(line)).toEqual({ i: idx });
		});
		expect(appendFile).toHaveBeenCalledTimes(1);
	});

	it("splits batches at truncate boundaries", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const writeFile = vi.spyOn(fs.promises, "writeFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		logger.log({ after: 2 });
		await logger.flush();

		expect(appendFile).toHaveBeenCalledTimes(2);
		expect(writeFile).toHaveBeenCalledTimes(1);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: 1 },
			{ after: 2 },
		]);
	});

	it("flush() resolves only once everything enqueued is on disk", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ a: 1 });
		logger.log({ b: 2 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(2);

		// A second batch after a completed flush drains independently.
		logger.log({ c: 3 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(3);
	});

	it("lazily creates the parent directory", async () => {
		const nested = path.join(tmpDir, "a", "b", "c", "deep.log");
		const logger = createNdjsonLogger({ filePath: nested });
		logger.log({ ok: true });
		await logger.flush();
		expect(fs.existsSync(nested)).toBe(true);
	});

	it("rotates to <file>.1 at the byte threshold", async () => {
		const backup = `${logFile}.1`;
		// Keep each line below the threshold. Rotation is checked before a batch,
		// so the second line may take the active file over the limit; the third
		// line is the one that rotates the first two.
		const logger = createNdjsonLogger({ filePath: logFile, maxBytes: 40 });
		const first = '{"entry":"1234567890123456789"}';
		const second = '{"entry":"abcdefghijABCDEFGHIJ"}';
		const third = '{"entry":"third"}';

		logger.append(first);
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);

		logger.append(second);
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);
		expect(readLines(logFile)).toEqual([first, second]);

		logger.append(third);
		await logger.flush();
		expect(readLines(backup)).toEqual([first, second]);
		expect(readLines(logFile)).toEqual([third]);
	});

	it("never rotates when maxBytes is absent", async () => {
		const backup = `${logFile}.1`;
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 100; i++) {
			logger.log({ padding: "x".repeat(100), i });
		}
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);
		expect(readLines(logFile)).toHaveLength(100);
	});

	it("a truncate op does not race pending writes (clear is serialized)", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		await logger.flush();

		// Enqueue order: two writes, truncate (empties file), one write. The
		// truncate cannot jump ahead of the earlier writes, so the final file
		// holds exactly the single post-truncate line.
		const lines = readLines(logFile);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ after: 1 });
	});

	it("append() adds the trailing newline itself", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.append('{"raw":true}');
		await logger.flush();
		expect(fs.readFileSync(logFile, "utf-8")).toBe('{"raw":true}\n');
	});

	it("redacts secrets from structured and pre-serialized log lines", async () => {
		const githubToken = `ghp_${"a".repeat(36)}`;
		const jwt = [
			"ey",
			"JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value",
		].join("");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ message: githubToken });
		logger.append(JSON.stringify({ message: jwt }));
		logger.log({ [githubToken]: true });
		logger.append(
			JSON.stringify({
				message: `before ${["-----BEGIN ", "PRIVATE KEY-----"].join("")}\nprivate material`,
			}),
		);
		await logger.flush();

		const lines = readLines(logFile).map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{ message: "[REDACTED:github-token]" },
			{ message: "[REDACTED:jwt]" },
			{ "[REDACTED:github-token]": true },
			{ message: "before [REDACTED:private-key]" },
		]);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(githubToken);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(jwt);
	});

	it("flushSync drains buffered lines synchronously (exit-handler path)", () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ buffered: 1 });
		logger.log({ buffered: 2 });
		// Do NOT await drain — call the sync flush directly, as process.on("exit")
		// would. Everything buffered must land on disk.
		logger.flushSync();
		expect(readLines(logFile)).toHaveLength(2);
	});

	it("flushSync writes the in-flight batch (dupes over drops) and never removes newer lines", async () => {
		// #935 review: if the process dies before an in-flight threadpool
		// append issues, a skipped prefix would drop the whole batch. flushSync
		// therefore rewrites the in-flight batch synchronously — a duplicate
		// line when the async write ALSO landed is the accepted cost, a dropped
		// line is not. The async completion handler must still leave the
		// (now-empty) queue alone.
		let release: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await realAppendFile(file, data, options);
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ async: 1 });

		// Let the first append reach disk while keeping its promise unresolved,
		// then enqueue a remainder and flush everything synchronously.
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
		logger.log({ sync: 2 });
		logger.flushSync();
		// The in-flight line appears twice (async write landed AND flushSync
		// rewrote it — never-drops), the newer line exactly once.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);

		release?.();
		await logger.flush();
		// Async completion must not shift the newer items flushSync already
		// wrote, nor re-write anything.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);
	});

	it("registers one canonical per-file flusher", () => {
		const before = _exitFlushersForTest().size;
		createNdjsonLogger({ filePath: logFile });
		const second = createNdjsonLogger({
			filePath: path.join(tmpDir, ".", "test.log"),
		});
		// The shared process 'exit' handler owns one flusher per canonical file,
		// not one closure per logger facade.
		expect(_exitFlushersForTest().size).toBe(before + 1);
		second.log({ canonical: true });
		second.flushSync();
		expect(readLines(logFile)).toHaveLength(1);
	});

	it("keeps a single shared process 'exit' listener regardless of logger count", () => {
		const count = process.listenerCount("exit");
		createNdjsonLogger({ filePath: path.join(tmpDir, "a.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "b.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "c.log") });
		// No per-logger listener growth — the MaxListeners warning cannot fire.
		expect(process.listenerCount("exit")).toBe(count);
	});

	it("shares the writer and queued operations across module re-evaluation", async () => {
		const count = process.listenerCount("exit");
		let releaseFirstAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseFirstAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const first = createNdjsonLogger({ filePath: logFile, maxBytes: 100 });
		first.log({ source: "before-reload", payload: "x".repeat(20) });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));

		const flusherCount = _exitFlushersForTest().size;
		vi.resetModules();
		const freshModule = await import("../../clients/ndjson-logger.js");
		const second = freshModule.createNdjsonLogger({
			filePath: path.join(tmpDir, ".", "test.log"),
			maxBytes: 100,
		});
		expect(process.listenerCount("exit")).toBe(count);
		expect(freshModule._exitFlushersForTest().size).toBe(flusherCount);

		second.log({ source: "after-reload", payload: "y".repeat(20) });
		expect(appendFile).toHaveBeenCalledTimes(1);
		releaseFirstAppend?.();
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "before-reload", payload: "x".repeat(20) },
			{ source: "after-reload", payload: "y".repeat(20) },
		]);

		// Rotation and truncate are also serialized through the same state. The
		// next write rotates the oversized active batch, preserving every line.
		second.log({ source: "rotated", payload: "z".repeat(20) });
		await second.flush();
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ source: "before-reload", payload: "x".repeat(20) },
			{ source: "after-reload", payload: "y".repeat(20) },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "rotated", payload: "z".repeat(20) },
		]);

		first.truncate();
		second.log({ source: "after-truncate" });
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "after-truncate" },
		]);
	});

	it("preserves the documented late in-flight append after rotation", async () => {
		fs.writeFileSync(logFile, "seed-data\n");
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const logger = createNdjsonLogger({ filePath: logFile, maxBytes: 1 });

		logger.log({ first: true });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
		logger.log({ afterFlush: true });
		logger.flushSync();

		// maxBytes:1 means each sync line rotates the active file. The second
		// line therefore replaces .1 with the serialized in-flight line; the
		// seed data is not expected to survive a second rotation.
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ first: true },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ afterFlush: true },
		]);

		releaseAppend?.();
		await logger.flush();
		// The in-flight append may still land after the synchronous exit flush.
		// Duplicating that line is the intentional dupes-over-drops tradeoff;
		// rotation itself remains deterministic and the late line is retained.
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ first: true },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ afterFlush: true },
			{ first: true },
		]);
	});

	it("repairs a late append that would otherwise reintroduce pre-truncate data", async () => {
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(
			async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			},
		);
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: true });
		await vi.waitFor(() => expect(releaseAppend).toBeDefined());
		logger.truncate();
		logger.log({ after: true });
		logger.flushSync();
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: true },
		]);

		releaseAppend?.();
		await logger.flush();
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: true },
		]);
	});

	it("upgrades a version-1 writer through a parent module graph", async () => {
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const oldFacade = createNdjsonLogger({ filePath: logFile });
		oldFacade.log({ queuedBeforeUpgrade: true });
		oldFacade.log({ queuedAfterFirstAppend: true });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));

		const key = Symbol.for("pi-lens.ndjson-logger.state");
		const globalHost = globalThis as unknown as Record<symbol, unknown>;
		const globalState = globalHost[key] as {
			schema?: string;
			version: number;
			writers: Map<string, { file: string; exitFlusher: () => void }>;
			exitFlushers: Set<() => void>;
		};
		const writerState = [...globalState.writers.values()].find((state) =>
			path.normalize(state.file).endsWith(path.normalize(logFile)),
		);
		expect(writerState).toBeDefined();
		const staleExitFlusher = writerState?.exitFlusher;
		// 6a8a0994's parent module graph writes version 1. Do not model it by
		// deleting the version marker: that only exercises the 7e4b9120 bridge.
		globalState.version = 1;

		try {
			// Import through a real logger facade, rather than re-evaluating the
			// current module directly. This is the parent-module graph shape that
			// can leave an older child graph's closure in the shared registry.
			vi.resetModules();
			await import("../../clients/sessionstart-logger.js");

			expect(globalState.version).toBe(2);
			expect(writerState?.exitFlusher).not.toBe(staleExitFlusher);
			expect(globalState.exitFlushers).not.toContain(staleExitFlusher);
			expect(globalState.exitFlushers).toContain(writerState?.exitFlusher);
			// Replacing the stale closure must not add a second flusher for this
			// writer, even though importing the parent facade may register other
			// static log paths.
			expect(
				[...globalState.exitFlushers].filter(
					(flush) => flush === writerState?.exitFlusher,
				),
			).toHaveLength(1);
			// The current flusher must drain the old facade's queue, including the
			// item enqueued by the old module graph after its first append started.
			for (const flush of globalState.exitFlushers) flush();
			expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual(
				expect.arrayContaining([
					{ queuedBeforeUpgrade: true },
					{ queuedAfterFirstAppend: true },
				]),
			);
		} finally {
			releaseAppend?.();
			await oldFacade.flush();
		}
	});

	it("fences a pre-7e4b9120 private-queue module graph without dropping its exit flusher", async () => {
		const key = Symbol.for("pi-lens.ndjson-logger.state");
		const globalHost = globalThis as unknown as Record<symbol, unknown>;
		const previous = globalHost[key];
		const legacyFlusher = vi.fn();
		globalHost[key] = {
			exitFlushers: new Set([legacyFlusher]),
			exitHandlerRegistered: true,
			registeredLogFiles: new Set([logFile]),
		};
		try {
			vi.resetModules();
			const freshModule = await import("../../clients/ndjson-logger.js");
			expect(freshModule._exitFlushersForTest()).toContain(legacyFlusher);
			expect(() =>
				freshModule.createNdjsonLogger({ filePath: logFile }),
			).toThrow(/pre-7e4b9120.*private queues/);
		} finally {
			globalHost[key] = previous;
			vi.resetModules();
		}
	});

	it("rejects incompatible options for one canonical path", () => {
		createNdjsonLogger({ filePath: logFile, maxBytes: 40 });
		const samePath = path.join(tmpDir, ".", "test.log");

		expect(() =>
			createNdjsonLogger({ filePath: samePath, maxBytes: 80 }),
		).toThrow(/incompatible options.*maxBytes\/backupPath/);
		expect(() =>
			createNdjsonLogger({
				filePath: samePath,
				maxBytes: 40,
				backupPath: path.join(tmpDir, "custom.backup"),
			}),
		).toThrow(/incompatible options.*maxBytes\/backupPath/);
	});

	it("keeps distinct paths isolated", async () => {
		const firstPath = path.join(tmpDir, "first.log");
		const secondPath = path.join(tmpDir, "second.log");
		const first = createNdjsonLogger({ filePath: firstPath });
		const second = createNdjsonLogger({ filePath: secondPath });
		first.log({ path: "first" });
		second.log({ path: "second" });
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(firstPath).map((line) => JSON.parse(line))).toEqual([
			{ path: "first" },
		]);
		expect(readLines(secondPath).map((line) => JSON.parse(line))).toEqual([
			{ path: "second" },
		]);
	});

	it("swallows write errors (best-effort telemetry)", async () => {
		// Point at a path whose parent is a file, so mkdir/append fail.
		const asFile = path.join(tmpDir, "not-a-dir");
		fs.writeFileSync(asFile, "x");
		const logger = createNdjsonLogger({
			filePath: path.join(asFile, "child.log"),
		});
		logger.log({ nope: true });
		await expect(logger.flush()).resolves.toBeUndefined();
	});

	describe("reopen-and-retry on write failure (#1970)", () => {
		it("recovers a write that fails once (e.g. a destroyed sink), no loss recorded", async () => {
			const realAppendFile = fs.promises.appendFile.bind(fs.promises);
			const appendFile = vi
				.spyOn(fs.promises, "appendFile")
				.mockImplementationOnce(async () => {
					const err = new Error(
						"Cannot call write after a stream was destroyed",
					) as NodeJS.ErrnoException;
					err.code = "ERR_STREAM_DESTROYED";
					throw err;
				})
				.mockImplementation(realAppendFile);

			const logger = createNdjsonLogger({ filePath: logFile });
			logger.log({ recovered: true });
			await logger.flush();

			// The retry landed the line — nothing was lost.
			expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
				{ recovered: true },
			]);
			expect(appendFile).toHaveBeenCalledTimes(2);
			expect(getSinkWriteFailures()).toEqual([]);
		});

		it("counts an unrecoverable write as a loss instead of throwing or dropping silently", async () => {
			const err = new Error(
				"Cannot call write after a stream was destroyed",
			) as NodeJS.ErrnoException;
			err.code = "ERR_STREAM_DESTROYED";
			const appendFile = vi
				.spyOn(fs.promises, "appendFile")
				.mockRejectedValue(err);

			const logger = createNdjsonLogger({ filePath: logFile });
			logger.log({ lost: true });

			// Never throws or rejects — the write is dropped, not fatal.
			await expect(logger.flush()).resolves.toBeUndefined();
			// Exactly one retry (two attempts total), not an unbounded loop.
			expect(appendFile).toHaveBeenCalledTimes(2);
			expect(fs.existsSync(logFile)).toBe(false);

			const failures = getSinkWriteFailures();
			expect(failures).toHaveLength(1);
			expect(failures[0]?.file).toContain("test.log");
			expect(failures[0]?.droppedCount).toBe(1);
		});

		it("flushSync (the exit-handler path) recovers a write that fails once, no loss recorded", () => {
			const err = new Error(
				"Cannot call write after a stream was destroyed",
			) as NodeJS.ErrnoException;
			err.code = "ERR_STREAM_DESTROYED";
			const appendFileSync = fs.appendFileSync as unknown as ReturnType<
				typeof vi.fn
			>;
			// Only the FIRST attempt fails; the retry (2nd call) falls through to
			// the real implementation the mock was created with — proving the
			// sync path's reopen-and-retry actually recovers, not just counts.
			appendFileSync.mockImplementationOnce(() => {
				throw err;
			});

			const logger = createNdjsonLogger({ filePath: logFile });
			logger.log({ recovered: true });
			expect(() => logger.flushSync()).not.toThrow();

			expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
				{ recovered: true },
			]);
			expect(appendFileSync).toHaveBeenCalledTimes(2);
			expect(getSinkWriteFailures()).toEqual([]);
		});

		it("flushSync (the exit-handler path) also reopens-and-retries, and counts an unrecoverable loss", () => {
			const err = new Error(
				"Cannot call write after a stream was destroyed",
			) as NodeJS.ErrnoException;
			err.code = "ERR_STREAM_DESTROYED";
			const appendFileSync = fs.appendFileSync as unknown as ReturnType<
				typeof vi.fn
			>;
			// Both attempts (initial write + the one reopen-retry) fail; further
			// calls (there should be none) fall back to the real implementation.
			appendFileSync
				.mockImplementationOnce(() => {
					throw err;
				})
				.mockImplementationOnce(() => {
					throw err;
				});

			const logger = createNdjsonLogger({ filePath: logFile });
			logger.log({ lost: true });
			// Must not throw out of the process-exit path.
			expect(() => logger.flushSync()).not.toThrow();

			const failures = getSinkWriteFailures();
			expect(failures).toHaveLength(1);
			expect(failures[0]?.droppedCount).toBe(1);
		});

		it("a lost write's loss is observable through the degradation ledger (pilens_health)", async () => {
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const err = new Error(
				"Cannot call write after a stream was destroyed",
			) as NodeJS.ErrnoException;
			err.code = "ERR_STREAM_DESTROYED";
			vi.spyOn(fs.promises, "appendFile").mockRejectedValue(err);

			const logger = createNdjsonLogger({ filePath: logFile });
			logger.log({ lost: true });
			await logger.flush();

			const summary = getDegradationSummary();
			const group = summary.find((g) => g.kind === "log-sink-write-failure");
			expect(group).toBeDefined();
			expect(group?.count).toBeGreaterThanOrEqual(1);
			expect(
				group?.latestReasons.some((entry) =>
					entry.subject.includes("test.log"),
				),
			).toBe(true);

			resetDegradationLedger();
		});

		it("does not recurse: reporting a loss never itself performs I/O through the failing sink", async () => {
			// Regression for the stated recursion hazard: recording a dropped
			// write must never enqueue another write against the same dying sink
			// (which would itself fail, be recorded, enqueue again, ... forever).
			const err = new Error(
				"Cannot call write after a stream was destroyed",
			) as NodeJS.ErrnoException;
			err.code = "ERR_STREAM_DESTROYED";
			const appendFile = vi
				.spyOn(fs.promises, "appendFile")
				.mockRejectedValue(err);

			const logger = createNdjsonLogger({ filePath: logFile });
			for (let i = 0; i < 10; i++) logger.log({ i });
			await logger.flush();

			// 10 lines batched into one write attempt (plus its one retry) = 2
			// calls, not an ever-growing chain of self-reporting writes.
			expect(appendFile).toHaveBeenCalledTimes(2);
			expect(getSinkWriteFailures()[0]?.droppedCount).toBe(10);
		});

		// applyQueueItemAsync (the single-item write helper) is only reachable in
		// production through drainLoop's `syncRepairItems` replay — the same race
		// "repairs a late append that would otherwise reintroduce pre-truncate
		// data" above exercises: an in-flight append is still pending when
		// flushSync races ahead of it across a truncate, so the truncate and
		// whatever followed it get replayed through applyQueueItemAsync once the
		// late append settles, to guarantee they land AFTER it.
		describe("applyQueueItemAsync's reopen-and-retry (the syncRepairItems replay path)", () => {
			interface RepairReplaySetup {
				logger: ReturnType<typeof createNdjsonLogger>;
				release: () => void;
			}

			async function triggerRepairReplay(): Promise<RepairReplaySetup> {
				let releaseAppend: (() => void) | undefined;
				const realAppendFile = fs.promises.appendFile.bind(fs.promises);
				vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(
					async (file, data, options) => {
						await new Promise<void>((resolve) => {
							releaseAppend = resolve;
						});
						return realAppendFile(file, data, options);
					},
				);
				const logger = createNdjsonLogger({ filePath: logFile });
				logger.log({ before: true });
				await vi.waitFor(() => expect(releaseAppend).toBeDefined());
				logger.truncate();
				logger.log({ after: true });
				logger.flushSync();
				// Same assertion as the un-mocked repair test: flushSync already
				// wrote the post-truncate state synchronously.
				expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
					{ after: true },
				]);
				return { logger, release: () => releaseAppend?.() };
			}

			it("recovers a repair-replay write that fails once, no loss recorded", async () => {
				const { logger, release } = await triggerRepairReplay();
				// Call 1 (already consumed) was the hung-then-real "before" write.
				// Call 2 is the repair replay's first attempt at "after" — fails.
				// Call 3 is applyQueueItemAsync's own retry — falls through to real.
				const appendFile = vi
					.spyOn(fs.promises, "appendFile")
					.mockImplementationOnce(async () => {
						const err = new Error(
							"Cannot call write after a stream was destroyed",
						) as NodeJS.ErrnoException;
						err.code = "ERR_STREAM_DESTROYED";
						throw err;
					});

				release();
				await logger.flush();

				expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
					{ after: true },
				]);
				// vi.spyOn returns the SAME spy across repeated calls on an
				// already-mocked property, so this count includes the earlier
				// hung-then-real "before" write too: 1 (before) + 1 (repair attempt,
				// fails) + 1 (repair retry, recovers) = 3.
				expect(appendFile).toHaveBeenCalledTimes(3);
				expect(getSinkWriteFailures()).toEqual([]);
			});

			it("counts a repair-replay write that never recovers as a loss, without throwing", async () => {
				const { logger, release } = await triggerRepairReplay();
				const err = new Error(
					"Cannot call write after a stream was destroyed",
				) as NodeJS.ErrnoException;
				err.code = "ERR_STREAM_DESTROYED";
				// Both the repair replay's initial attempt and its one retry fail.
				const appendFile = vi
					.spyOn(fs.promises, "appendFile")
					.mockImplementationOnce(async () => {
						throw err;
					})
					.mockImplementationOnce(async () => {
						throw err;
					});

				release();
				await expect(logger.flush()).resolves.toBeUndefined();

				// 1 (before) + 1 (repair attempt) + 1 (repair retry) = 3, same
				// accumulation as the recovery test above.
				expect(appendFile).toHaveBeenCalledTimes(3);
				const failures = getSinkWriteFailures();
				expect(failures).toHaveLength(1);
				expect(failures[0]?.droppedCount).toBe(1);
			});
		});
	});
});
