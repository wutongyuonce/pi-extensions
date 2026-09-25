/**
 * #1080 baseline guard: the review graph is (and must stay) tests-free.
 *
 * This is the established baseline the cascade fix relies on — `builder.ts`
 * applies `detectFileRole(file) !== "test"` at its source-walk / incremental
 * chokepoints. Locking it in with a real fixture ensures a recognized test
 * importer never enters the graph as a node, even when it is passed explicitly
 * in `changedFiles` on an incremental rebuild.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

function makeEnv(prefix = "pi-lens-graph-tests-free-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

/** Any node/file entry whose path contains the test-file basename. */
function referencesFile(graph: ReviewGraph, needle: string): boolean {
	const norm = needle.replace(/\\/g, "/").toLowerCase();
	for (const node of graph.nodes.values()) {
		if (node.filePath?.replace(/\\/g, "/").toLowerCase().includes(norm))
			return true;
	}
	for (const key of graph.fileNodes.keys()) {
		if (key.replace(/\\/g, "/").toLowerCase().includes(norm)) return true;
	}
	return false;
}

describe("review graph stays tests-free (#1080 baseline)", () => {
	it("a recognized test importer never enters the graph — full build and incremental rebuild", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"reader.ts",
			["export function countTotal(): number {", "  return 1;", "}"].join("\n"),
		);
		// A recognized test file that imports+uses the source symbol.
		createTempFile(
			env.tmpDir,
			"reader.test.ts",
			["import { countTotal } from './reader';", "countTotal();"].join("\n"),
		);

		const facts = new FactStore();
		const full = await buildOrUpdateGraph(env.tmpDir, [], facts);
		expect(referencesFile(full, "reader.ts")).toBe(true); // source IS present
		expect(referencesFile(full, "reader.test.ts")).toBe(false); // test is NOT

		// Incremental rebuild with the test file explicitly in changedFiles must
		// still refuse to add it as a node.
		const testFile = `${env.tmpDir.replace(/\\/g, "/")}/reader.test.ts`;
		const incremental = await buildOrUpdateGraph(env.tmpDir, [testFile], facts);
		expect(referencesFile(incremental, "reader.test.ts")).toBe(false);
	});
});
