/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `checkInFlight` and `scanInFlight` each cleared with a bare delete-by-key.
 * The race needs a SECOND WRITER replacing the map entry mid-flight — the
 * public API alone cannot produce it today (single set site per map;
 * microtask FIFO orders every observer after A's cleanup) — so each test
 * simulates that writer directly, exactly the mechanism the #1838
 * reachability probe established for the original two sites. Red on the
 * pre-fix bare `.finally` delete: A's cleanup evicted B and the third caller
 * started a duplicate check/scan.
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyChecker } from "../../clients/dependency-checker.js";
import { gatedPromise } from "../support/fault-injection.js";
import { setupTestEnvironment } from "./test-utils.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

interface CheckInternals {
	ensureAvailable: (cwd?: string) => Promise<boolean>;
	importsChanged: (filePath: string) => boolean;
	runCheckFile: (
		normalized: string,
		projectRoot: string,
		gen: number,
	) => Promise<unknown>;
	checkInFlight: Map<string, Promise<unknown>>;
	scanInFlight: Map<string, Promise<unknown>>;
}

describe("DependencyChecker.checkFile in-flight ABA release (#1968)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("a late-settling check does not evict its mid-flight successor", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-dep-check-aba-");
		try {
			const filePath = `${tmpDir}/probe.ts`;
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const checker = new DependencyChecker();
			const internals = checker as unknown as CheckInternals;
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
			vi.spyOn(internals, "importsChanged").mockReturnValue(true);

			const gateA = gatedPromise<unknown>();
			let calls = 0;
			vi.spyOn(internals, "runCheckFile").mockImplementation(() => {
				calls += 1;
				return calls === 1 ? gateA.promise : gatedPromise<unknown>().promise;
			});

			void checker.checkFile(filePath, tmpDir); // check A in flight
			await tick();
			expect(internals.checkInFlight.size).toBe(1);
			const key = [...internals.checkInFlight.keys()][0]!;

			// B replaces the entry under the same key while A is still in flight.
			const successor = gatedPromise<unknown>();
			internals.checkInFlight.set(key, successor.promise);

			gateA.resolve({ hasCircular: false, circular: [] }); // A settles late
			await tick();
			await tick();

			// B's entry survived A's cleanup...
			expect(internals.checkInFlight.get(key)).toBe(successor.promise);
			// ...and a third caller SHARES B instead of starting a duplicate check.
			void checker.checkFile(filePath, tmpDir);
			await tick();
			expect(calls).toBe(1);

			successor.resolve({ hasCircular: false, circular: [] });
		} finally {
			cleanup();
		}
	});

	// Mutation-proof companion: a guard that never releases (deleting or
	// neutering the identity check by always clearing) is a leak in the OTHER
	// direction. This pins that a normal, uncontested settlement still empties
	// the slot, so a mutant that makes the guard permanently `false` reds here.
	it("a normally-settling check still cleans up its own entry", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-dep-check-clean-",
		);
		try {
			const filePath = `${tmpDir}/probe.ts`;
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const checker = new DependencyChecker();
			const internals = checker as unknown as CheckInternals;
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
			vi.spyOn(internals, "importsChanged").mockReturnValue(true);
			vi.spyOn(internals, "runCheckFile").mockResolvedValue({
				hasCircular: false,
				circular: [],
			});

			await checker.checkFile(filePath, tmpDir);
			await tick();
			expect(internals.checkInFlight.size).toBe(0);
		} finally {
			cleanup();
		}
	});
});

describe("DependencyChecker.scanProject in-flight ABA release (#1968)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("a late-settling scan does not evict its mid-flight successor", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-dep-scan-aba-");
		try {
			fs.writeFileSync(`${tmpDir}/probe.ts`, "export const x = 1;\n");

			const checker = new DependencyChecker();
			const internals = checker as unknown as CheckInternals & {
				runScanProject: (projectRoot: string, gen: number) => Promise<unknown>;
			};
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);

			const gateA = gatedPromise<unknown>();
			let calls = 0;
			vi.spyOn(internals, "runScanProject").mockImplementation(() => {
				calls += 1;
				return calls === 1 ? gateA.promise : gatedPromise<unknown>().promise;
			});

			void checker.scanProject(tmpDir); // scan A in flight
			await tick();
			expect(internals.scanInFlight.size).toBe(1);
			const key = [...internals.scanInFlight.keys()][0]!;

			// B replaces the entry under the same key while A is still in flight.
			const successor = gatedPromise<unknown>();
			internals.scanInFlight.set(key, successor.promise);

			gateA.resolve({ circular: [], count: 0 }); // A settles late
			await tick();
			await tick();

			// B's entry survived A's cleanup...
			expect(internals.scanInFlight.get(key)).toBe(successor.promise);
			// ...and a third caller SHARES B instead of starting a duplicate scan.
			void checker.scanProject(tmpDir);
			await tick();
			expect(calls).toBe(1);

			successor.resolve({ circular: [], count: 0 });
		} finally {
			cleanup();
		}
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here.
	it("a normally-settling scan still cleans up its own entry", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-dep-scan-clean-");
		try {
			fs.writeFileSync(`${tmpDir}/probe.ts`, "export const x = 1;\n");

			const checker = new DependencyChecker();
			const internals = checker as unknown as CheckInternals;
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
			vi.spyOn(
				internals as unknown as {
					runScanProject: (
						projectRoot: string,
						gen: number,
					) => Promise<unknown>;
				},
				"runScanProject",
			).mockResolvedValue({ circular: [], count: 0 });

			await checker.scanProject(tmpDir);
			await tick();
			expect(internals.scanInFlight.size).toBe(0);
		} finally {
			cleanup();
		}
	});
});
