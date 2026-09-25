/**
 * #2423 — the in-process mutation bridge, sibling of `clients/read-bridge.ts`.
 *
 * These tests drive the bridge against a REAL `RuntimeCoordinator` and a REAL
 * `CacheManager`, so what they assert is the durable turn state and change log
 * a later phase actually reads, not a spy's call log.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	MUTATION_BRIDGE_KEY,
	getMutationBridge,
	isValidMutationEntry,
	recordMutationThroughSeam,
	registerMutationBridge,
	type MutationBridgeDeps,
} from "../../clients/mutation-bridge.js";
import {
	_observedMutationStateForTests,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["import a from 'a';", "const b = 2;", "const c = 3;", ""].join(
	"\n",
);

function makeDeps(args: {
	tmpDir: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	isRecordable?: (filePath: string) => boolean;
	shouldStampReadGuard?: () => boolean;
}): MutationBridgeDeps {
	return {
		getRuntime: () => args.runtime as never,
		getCacheManager: () => args.cacheManager,
		getProjectRoot: () => args.tmpDir,
		getDispatchCwd: () => args.tmpDir,
		countFileLines,
		isRecordable: args.isRecordable ?? (() => true),
		shouldStampReadGuard: args.shouldStampReadGuard,
		dbg: () => {},
	};
}

describe("mutation bridge payload validation", () => {
	it("accepts a well-formed entry", () => {
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				editRanges: [[2, 4]],
				consumer: "x",
			}),
		).toBe(true);
	});

	it("rejects malformed entries rather than recording a guess", () => {
		expect(isValidMutationEntry(null)).toBe(false);
		expect(isValidMutationEntry({ filePath: "", kind: "edit" })).toBe(false);
		expect(isValidMutationEntry({ filePath: "/a.ts", kind: "patch" })).toBe(
			false,
		);
		expect(
			isValidMutationEntry({ filePath: "/a.ts", kind: "edit", editRanges: [] }),
		).toBe(false);
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				touchedLines: [4, 2],
			}),
		).toBe(false);
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				touchedLines: [0, 2],
			}),
		).toBe(false);
	});
});

describe("mutation bridge bookkeeping", () => {
	it("writes turn state, an attributed change-log entry, and a deferred queue entry", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "bridged.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					editRanges: [
						[2, 2],
						[3, 3],
					],
					consumer: "my-extension",
				},
				makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager }),
			);

			expect(accepted).toBe(true);

			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files).toHaveLength(1);
			expect(files[0]).toContain("bridged.ts");

			// One change-log entry, attributed to the producer rather than folded
			// onto agent-edit, carrying the bounding box of the recorded ranges.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{
					source: "agent-tool:my-extension",
					filePath,
					changedRange: { start: 2, end: 3 },
				},
			]);

			// Deferred, never immediate.
			expect(runtime.pendingDeferredFormatCount).toBe(1);
			const queued = runtime.consumeDeferredFormatFiles();
			expect(queued[0].kinds).toEqual(new Set(["autofix", "format"]));
			expect(queued[0].toolNames).toEqual(new Set(["my-extension"]));
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("treats a write with no stated range as the whole file", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-write-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "whole.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-write" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			recordMutationThroughSeam(
				{ filePath, kind: "write", consumer: "my-extension" },
				makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager }),
			);

			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ changedRange: { start: 1, end: countFileLines(filePath) } },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("#2465: under no-read-guard, a recordable write still gets turn-state + receipt + the observed-handled mark, but skips only the read-guard stamp", () => {
		const env = setupTestEnvironment("pi-lens-2465-no-read-guard-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "noguard.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-no-read-guard" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			// #2423's own recordability gate (`isRecordable`) is the wiring
			// `index.ts` produces AFTER #2465: path-scope only, no `no-read-guard`
			// clause. `shouldStampReadGuard` is the live `getLensFlag("no-read-guard")`
			// read `index.ts` threads separately — `false` here is the
			// `--no-read-guard` case under test.
			const recordWrittenSpy = vi.spyOn(runtime.readGuard, "recordWritten");
			resetObservedMutationNet();

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					consumer: "my-extension",
				},
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager,
					isRecordable: () => true,
					shouldStampReadGuard: () => false,
				}),
			);

			expect(accepted).toBe(true);

			// The stamp alone is suppressed.
			expect(recordWrittenSpy).not.toHaveBeenCalled();

			// Turn-state, the change-log receipt, and the deferred format queue —
			// none of them consult the flag — are all still present.
			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files).toHaveLength(1);
			expect(files[0]).toContain("noguard.ts");
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:my-extension", filePath },
			]);
			expect(runtime.pendingDeferredFormatCount).toBe(1);

			// The observed-mutation net's handled mark (#2430/#2449) — reached
			// only when `isRecordable` lets the call through the early return —
			// is present too, so the `agent_settled` sweep re-baselines this file
			// instead of reporting it as unattributed drift.
			expect(_observedMutationStateForTests().handled).toContain(
				normalizeMapKey(path.resolve(filePath)),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			resetObservedMutationNet();
			env.cleanup();
		}
	});

	it("drops an out-of-scope path without touching any store", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-scope-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "ignored.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-scope" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const accepted = recordMutationThroughSeam(
				{ filePath, kind: "edit", touchedLines: [1, 2] },
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager,
					isRecordable: () => false,
				}),
			);

			expect(accepted).toBe(false);
			expect(
				Object.keys(cacheManager.readTurnState(env.tmpDir).files ?? {}),
			).toHaveLength(0);
			expect(readChangesSince(env.tmpDir, 0)).toEqual([]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("never lets a bookkeeping failure escape to the producer", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-throw-");
		try {
			const filePath = path.join(env.tmpDir, "boom.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const deps = makeDeps({
				tmpDir: env.tmpDir,
				runtime,
				cacheManager: {
					addModifiedRange: () => {
						throw new Error("turn state exploded");
					},
				} as never,
			});
			expect(() =>
				recordMutationThroughSeam({ filePath, kind: "write" }, deps),
			).not.toThrow();
			expect(recordMutationThroughSeam({ filePath, kind: "write" }, deps)).toBe(
				false,
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("mutation bridge registration", () => {
	it("mounts once, first-wins, and is reachable through the public symbol", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-register-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const first = vi.fn(() => true);
			registerMutationBridge({
				...makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: { addModifiedRange: first } as never,
				}),
			});
			const bridge = getMutationBridge();
			expect(bridge?.version).toBe(1);
			expect((globalThis as Record<symbol, unknown>)[MUTATION_BRIDGE_KEY]).toBe(
				bridge,
			);

			// A second registration is a no-op: the mounted bridge keeps its deps.
			const second = vi.fn(() => true);
			registerMutationBridge({
				...makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: { addModifiedRange: second } as never,
				}),
			});
			expect(getMutationBridge()).toBe(bridge);

			const filePath = path.join(env.tmpDir, "registered.ts");
			fs.writeFileSync(filePath, SOURCE);
			bridge?.recordMutation({ filePath, kind: "write", consumer: "probe" });
			expect(first).toHaveBeenCalled();
			expect(second).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps the deps its live-getter claim depends on at module scope", () => {
		// #2423 review round 1 (F6). The module header claims "every dep is a
		// GETTER resolved at call time, so a replaced runtime or cache manager is
		// picked up without re-registration". Registration happens ONCE per
		// process, so the claim only holds if what the getters close over
		// outlives one activation. `runtime` always did; `cacheManager` was
		// declared INSIDE `activateExtension`, which pinned the first
		// activation's instance for the life of the process.
		//
		// A source assertion, deliberately: both instances write the same
		// on-disk turn state, so the difference is invisible at runtime right up
		// until something holds per-activation state in memory. The invariant is
		// the thing worth pinning.
		const indexSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "..", "..", "index.ts"),
			"utf8",
		);
		const declarations = indexSource
			.split("\n")
			.filter((line) => /\bcacheManager\s*=\s*new CacheManager\(/.test(line));
		expect(declarations).toHaveLength(1);
		// Module scope: everything inside `activateExtension` is indented.
		expect(declarations[0]).toMatch(/^const cacheManager = new CacheManager\(/);
		expect(
			indexSource
				.split("\n")
				.filter((line) => /\bruntime\s*=\s*new RuntimeCoordinator\(/.test(line))
				.every((line) => !/^\s/.test(line)),
		).toBe(true);
	});
});
