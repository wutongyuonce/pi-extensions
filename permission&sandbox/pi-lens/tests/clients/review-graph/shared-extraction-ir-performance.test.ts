import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import {
	clearReviewGraphFileIr,
	getReviewGraphIrStats,
	resetReviewGraphIrStats,
} from "../../../clients/review-graph/shared-extraction-ir.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

function makeFixture(label: string): { root: string; files: string[] } {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-ir-bench-${label}-`),
	);
	roots.push(root);
	const src = path.join(root, "src");
	fs.mkdirSync(src);
	const files: string[] = [];
	for (let i = 0; i < 400; i++) {
		const file = path.join(src, `module-${i}.ts`);
		const prior =
			i === 0 ? "" : `import { fn${i - 1} } from "./module-${i - 1}";\n`;
		fs.writeFileSync(
			file,
			`${prior}export async function fn${i}(value: number) {\n  if (value > ${i}) return await Promise.resolve(value + ${i});\n  return value;\n}\n`,
		);
		files.push(file);
	}
	return { root, files };
}

afterAll(() => {
	clearGraphCache();
	clearReviewGraphWorkspaceCache();
	clearReviewGraphFileIr();
	for (const root of roots) removeTempDirSync(root);
});

describe("shared extraction IR micro-benchmark (#939)", () => {
	it.skipIf(process.env.PI_LENS_RUN_IR_BENCHMARK !== "1")(
		"logs cold graph build versus graph build after a scanner pass",
		async () => {
			const cold = makeFixture("cold");
			let started = performance.now();
			await buildOrUpdateGraph(cold.root, [], new FactStore());
			const coldBuildMs = performance.now() - started;

			clearGraphCache();
			const shared = makeFixture("shared");
			await scanProjectDiagnostics({
				cwd: shared.root,
				tier: "cheap",
				files: shared.files,
				maxFiles: shared.files.length,
			});
			resetReviewGraphIrStats();
			started = performance.now();
			await buildOrUpdateGraph(shared.root, [], new FactStore());
			const sharedBuildMs = performance.now() - started;
			const stats = getReviewGraphIrStats();

			console.log(
				JSON.stringify({
					benchmark: "review-graph-shared-extraction-ir",
					files: shared.files.length,
					coldBuildMs: Math.round(coldBuildMs),
					sharedBuildMs: Math.round(sharedBuildMs),
					speedup: Number((coldBuildMs / sharedBuildMs).toFixed(2)),
					irAccepted: stats.accepted,
				}),
			);
		},
		120_000,
	);
});
