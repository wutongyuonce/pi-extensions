/**
 * Opt-in diagnostic benchmark for #958. Run with
 * PI_LENS_RUN_PERF_TESTS=1 npx vitest run this-file.
 * Timings are logged for dogfood comparison, never asserted.
 */
import * as fs from "node:fs";
import { describe, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
} from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const perfIt = process.env.PI_LENS_RUN_PERF_TESTS === "1" ? it : it.skip;

describe("word-index incremental refresh performance (#958)", () => {
	perfIt("logs full-build versus one-stale-file refresh timings", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-perf-");
		try {
			for (let i = 0; i < 500; i++) {
				createTempFile(
					env.tmpDir,
					`src/file-${i}.ts`,
					`export function handler${i}(value: string) { return value.length + ${i}; }`,
				);
			}
			const fullStarted = performance.now();
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const fullMs = performance.now() - fullStarted;

			const stale = `${env.tmpDir}/src/file-250.ts`;
			fs.appendFileSync(stale, "\nexport const incrementalNeedle = true;\n");
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(stale, future, future);
			const incrementalStarted = performance.now();
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			const incrementalMs = performance.now() - incrementalStarted;

			console.log(
				JSON.stringify({
					files: index.docCount,
					fullMs: Number(fullMs.toFixed(1)),
					incrementalMs: Number(incrementalMs.toFixed(1)),
					...result,
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
