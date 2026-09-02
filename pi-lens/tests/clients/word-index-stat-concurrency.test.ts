import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
} from "../../clients/word-index.js";
import { waitFor } from "./interleaving-kit.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const yieldTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("word-index parallel stat walk (#1409)", () => {
	it("bounds concurrent stats while statting every reused file once", async () => {
		const env = setupTestEnvironment("pi-lens-word-stat-concurrency-");
		const gate = deferred();
		try {
			const files = Array.from({ length: 8 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const value${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const calls = new Map<string, number>();
			let inFlight = 0;
			let maxInFlight = 0;
			const refresh = refreshWordIndexIncrementally(
				index,
				env.tmpDir,
				undefined,
				{
					statConcurrency: 3,
					statFile: async (file) => {
						calls.set(file, (calls.get(file) ?? 0) + 1);
						inFlight++;
						maxInFlight = Math.max(maxInFlight, inFlight);
						await gate.promise;
						inFlight--;
						return fs.promises.stat(file);
					},
				},
			);
			try {
				await waitFor(
					() => maxInFlight,
					(value) => value > 1,
					{
						timeoutMs: 100,
						yieldControl: yieldTick,
					},
				);
			} finally {
				gate.resolve();
			}
			const result = await refresh;
			expect(maxInFlight).toBeGreaterThan(1);
			expect(maxInFlight).toBeLessThanOrEqual(3);
			expect([...calls.values()]).toEqual(files.map(() => 1));
			expect(result).toMatchObject({
				mode: "incremental",
				refreshed: 0,
				dropped: 0,
				skipped: 0,
				reused: files.length,
			});
		} finally {
			gate.resolve();
			env.cleanup();
		}
	});

	it("preserves walk order when stats complete in reverse", async () => {
		const env = setupTestEnvironment("pi-lens-word-stat-order-");
		const barriers = new Map<string, ReturnType<typeof deferred>>();
		try {
			const original = Array.from({ length: 8 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const old${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			fs.unlinkSync(original[0]);
			fs.unlinkSync(original[1]);
			createTempFile(env.tmpDir, "src/new-a.ts", "export const newA = 1;");
			createTempFile(env.tmpDir, "src/new-b.ts", "export const newB = 2;");

			const claims: string[] = [];
			const refresh = refreshWordIndexIncrementally(
				index,
				env.tmpDir,
				undefined,
				{
					statConcurrency: 8,
					statFile: async (file) => {
						claims.push(file);
						const barrier = deferred();
						barriers.set(file, barrier);
						await barrier.promise;
						return fs.promises.stat(file);
					},
				},
			);
			await waitFor(
				() => claims.length,
				(count) => count === 8,
				{
					yieldControl: yieldTick,
				},
			);
			for (const file of [...claims].reverse()) barriers.get(file)?.resolve();
			const result = await refresh;
			expect(result.mode).toBe("full-required");
			if (result.mode !== "full-required")
				throw new Error("expected churn fallback");
			expect(result.reason).toBe("file-set-churn");
			expect(result.preflightFiles?.map((file) => file.path)).toEqual(claims);
		} finally {
			for (const barrier of barriers.values()) barrier.resolve();
			env.cleanup();
		}
	});

	it("treats rejected stats as absent without counting them skipped", async () => {
		const env = setupTestEnvironment("pi-lens-word-stat-reject-");
		try {
			const files = Array.from({ length: 4 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const value${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const rejected = files[0];
			const result = await refreshWordIndexIncrementally(
				index,
				env.tmpDir,
				undefined,
				{
					statFile: async (file) => {
						if (file === rejected) throw new Error("injected stat rejection");
						return fs.promises.stat(file);
					},
				},
			);
			expect(result).toMatchObject({
				mode: "incremental",
				refreshed: 0,
				dropped: 1,
				skipped: 0,
				reused: 3,
			});
			expect(index.docLengths.has(rejected)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("stops new claims after supersession and settles in-flight stats", async () => {
		const env = setupTestEnvironment("pi-lens-word-stat-supersession-");
		const gate = deferred();
		try {
			Array.from({ length: 8 }, (_, i) =>
				createTempFile(
					env.tmpDir,
					`src/f${i}.ts`,
					`export const value${i} = ${i};`,
				),
			);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			let current = true;
			const claims: string[] = [];
			const refresh = refreshWordIndexIncrementally(
				index,
				env.tmpDir,
				() => current,
				{
					statConcurrency: 2,
					statFile: async (file) => {
						claims.push(file);
						await gate.promise;
						return fs.promises.stat(file);
					},
				},
			);
			await waitFor(
				() => claims.length,
				(count) => count === 2,
				{
					yieldControl: yieldTick,
				},
			);
			current = false;
			gate.resolve();
			await expect(refresh).rejects.toThrow("word index refresh superseded");
			expect(claims).toHaveLength(2);
		} finally {
			gate.resolve();
			env.cleanup();
		}
	});
});
