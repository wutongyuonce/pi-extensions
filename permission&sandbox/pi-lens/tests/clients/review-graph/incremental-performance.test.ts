import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { generateSourceTree } from "../../support/perf-harness.js";
import { removeTempDirSync } from "../test-utils.js";

const FILE_COUNT = 3_000;
const RUNS = 7;
const enabled = process.env.PI_LENS_RUN_MICRO_BENCH === "1";
let cwd: string;

describe.skipIf(!enabled)("review-graph incremental micro-benchmark", () => {
	beforeAll(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-bench-"));
		generateSourceTree(cwd, FILE_COUNT);
	}, 60_000);

	afterAll(() => {
		clearReviewGraphWorkspaceCache();
		removeTempDirSync(cwd);
	});

	it(
		"logs single-file update latency without a CI timing assertion",
		{
			timeout: 120_000,
		},
		async () => {
			const changed = path.join(cwd, "src", "file0.ts");
			let seq = 0;
			const seqHint = {
				projectSeq: () => seq,
				getFilesChangedSince: () => [changed],
			};
			await buildOrUpdateGraph(cwd, [changed], new FactStore(), seqHint);
			const samples: number[] = [];
			for (let run = 0; run < RUNS; run++) {
				seq++;
				fs.appendFileSync(changed, `\n// benchmark edit ${run}\n`);
				clearGraphCache();
				const startedAt = performance.now();
				await buildOrUpdateGraph(cwd, [changed], new FactStore(), seqHint);
				samples.push(performance.now() - startedAt);
			}
			samples.sort((a, b) => a - b);
			const median = samples[Math.floor(samples.length / 2)];
			console.log(
				`review-graph incremental ${FILE_COUNT} files: median=${median.toFixed(2)}ms samples=${samples.map((value) => value.toFixed(2)).join(",")}`,
			);
		},
	);
});
