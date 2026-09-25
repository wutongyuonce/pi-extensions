import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import {
	clearReviewGraphFileIr,
	getFreshReviewGraphFileIr,
	getReviewGraphIrStats,
	publishReviewGraphFileIr,
	resetReviewGraphIrStats,
	reviewGraphIrContentHash,
} from "../../../clients/review-graph/shared-extraction-ir.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

beforeAll(() => {
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});

afterAll(() => {
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
});

afterEach(() => {
	clearGraphCache();
	clearReviewGraphWorkspaceCache();
	clearReviewGraphFileIr();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function fixture(seed: number): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-ir-${seed}-`));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"));
	for (let i = 0; i < 8; i++) {
		const prior =
			i === 0 ? "" : `import { value${i - 1} } from "./f${i - 1}";\n`;
		fs.writeFileSync(
			path.join(root, "src", `f${i}.ts`),
			`${prior}export function value${i}(input: number) { return input + ${seed + i}; }\n`,
		);
	}
	fs.writeFileSync(
		path.join(root, "src", "worker.py"),
		"class Worker:\n    def run(self):\n        return 1\n",
	);
	return root;
}

function shape(graph: ReviewGraph, root: string): unknown {
	const scrub = (value: string) =>
		value
			.replaceAll("\\", "/")
			.replaceAll(root.replaceAll("\\", "/"), "<root>");
	const nodes = [...graph.nodes.entries()]
		.map(([id, node]) => [
			scrub(id),
			JSON.parse(JSON.stringify(node), (_k, v) =>
				typeof v === "string" ? scrub(v) : v,
			),
		])
		.sort(([a], [b]) => String(a).localeCompare(String(b)));
	const edges = graph.edges
		.map((edge) =>
			JSON.parse(JSON.stringify(edge), (_k, v) =>
				typeof v === "string" ? scrub(v) : v,
			),
		)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return { nodes, edges };
}

describe("scanner to review-graph structural IR (#939)", () => {
	for (const seed of [93911, 93912, 93913]) {
		it(
			`is graph-equivalent to a cold parse for seed ${seed}`,
			{
				timeout: 120_000,
			},
			async () => {
				const coldRoot = fixture(seed);
				const sharedRoot = fixture(seed);
				const cold = await buildOrUpdateGraph(coldRoot, [], new FactStore());

				clearGraphCache();
				await scanProjectDiagnostics({
					cwd: sharedRoot,
					tier: "cheap",
					files: fs
						.readdirSync(path.join(sharedRoot, "src"))
						.map((name) => path.join(sharedRoot, "src", name)),
					maxFiles: 100,
				});
				resetReviewGraphIrStats();
				const shared = await buildOrUpdateGraph(
					sharedRoot,
					[],
					new FactStore(),
				);

				expect(shape(shared, sharedRoot)).toEqual(shape(cold, coldRoot));
				expect(getReviewGraphIrStats().accepted).toBe(9);
			},
		);
	}

	it("rejects stale IR for an edited file and reparses its new content", async () => {
		const root = fixture(93920);
		const files = fs
			.readdirSync(path.join(root, "src"))
			.map((name) => path.join(root, "src", name));
		await scanProjectDiagnostics({
			cwd: root,
			tier: "cheap",
			files,
			maxFiles: 100,
		});
		fs.writeFileSync(
			path.join(root, "src", "f7.ts"),
			'import { value0 } from "./f0";\nexport function changed() { return value0(1); }\n',
		);

		resetReviewGraphIrStats();
		const graph = await buildOrUpdateGraph(root, [], new FactStore());
		const file = path.join(root, "src", "f7.ts").replaceAll("\\", "/");
		expect(
			[...graph.nodes.values()].some(
				(node) => node.filePath === file && node.symbolName === "changed",
			),
		).toBe(true);
		expect(getReviewGraphIrStats()).toEqual({ accepted: 8, rejected: 1 });
	});

	it("keeps the no-scan cold path unchanged", async () => {
		const leftRoot = fixture(93930);
		const rightRoot = fixture(93930);
		const left = await buildOrUpdateGraph(leftRoot, [], new FactStore());
		clearGraphCache();
		const right = await buildOrUpdateGraph(rightRoot, [], new FactStore());
		expect(shape(left, leftRoot)).toEqual(shape(right, rightRoot));
	});

	it("registry lifecycle: consume-once, publish guard, stale-only rejection (#955 review)", () => {
		clearReviewGraphFileIr();
		resetReviewGraphIrStats();
		const cwd = path.join(os.tmpdir(), "ir-lifecycle-root");
		const hash = reviewGraphIrContentHash("const a = 1;");
		const structural = {
			kind: "tree-sitter" as const,
			languageId: "python",
			extracted: { symbols: [], refs: [], imports: [] },
		};
		// Incomplete / structural-less entries are never stored.
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: false,
		});
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: true,
		});
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeUndefined();
		// Absence is not "rejected" — only present-but-stale counts.
		expect(getReviewGraphIrStats().rejected).toBe(0);

		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: true,
			structural,
		});
		// A transient failed re-publication must not clobber a valid entry.
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: false,
		});
		// Stale lookup: present but wrong hash → rejected, entry retained.
		expect(
			getFreshReviewGraphFileIr(cwd, "/p/a.py", "different"),
		).toBeUndefined();
		expect(getReviewGraphIrStats().rejected).toBe(1);
		// Fresh lookup consumes the entry…
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeDefined();
		// …exactly once (consume-once bounds retention and kills aliasing).
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeUndefined();
		expect(getReviewGraphIrStats().accepted).toBe(1);
		clearReviewGraphFileIr();
		resetReviewGraphIrStats();
	});
});
