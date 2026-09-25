import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import {
	computeImpactCascade,
	recordEntitySnapshotDiff,
} from "../../../clients/review-graph/service.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

describe("review-graph session facts", () => {
	it("builder consumes changed symbols written under an alternate path spelling", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-facts-"),
		);
		roots.push(cwd);
		const file = path.join(cwd, "target.ts");
		fs.writeFileSync(
			file,
			"export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\n",
		);

		const facts = new FactStore("dispatch");
		const snapshot = new Map([
			["function:alpha", "alpha-v1"],
			["function:beta", "beta-v1"],
		]);
		// The dispatch runner can hand the service a backslash-spelled path while
		// the graph walk later supplies the platform's canonical spelling. The
		// service is the writer; the builder and query are the real readers.
		const backslashSpelling = file
			.split(path.sep)
			.join(String.fromCharCode(92));
		recordEntitySnapshotDiff(facts, backslashSpelling, snapshot);

		const graph = await buildOrUpdateGraph(cwd, [file], facts);
		const impact = computeImpactCascade(graph, file, cwd);

		// This value comes from the builder's session-fact lookup and the query's
		// symbol selection, not from reading the FactStore key in the test.
		expect(graph.fileNodes.has(normalizeMapKey(file))).toBe(true);
		expect(impact.changedSymbols).toEqual(["alpha", "beta"]);
	});
});
