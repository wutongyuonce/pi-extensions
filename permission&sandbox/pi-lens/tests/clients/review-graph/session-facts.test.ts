import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatchContext } from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
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

	// #2477 round 2 (reviewer F1/F2): folding `cwd` into the snapshot key was
	// REVERTED — the writer's `ctx.cwd` (nearest LANGUAGE ROOT) and the
	// builder's cascade reader's cwd (WORKSPACE root) diverge in a monorepo,
	// so a folded key the reader can never hit zeroed `graphChangedSymbolCount`
	// on every build. #2477's OTHER acceptance branch ("confirm and enforce
	// that one warmGraphFacts instance is scoped to one project root") is what
	// ships instead: this test drives the REAL production writer path
	// (`createDispatchContext`) for two project roots that share a relative
	// file spelling and confirms the #2477 collision cannot occur, because
	// `createDispatchContext` always resolves `filePath` to an absolute,
	// per-root path (the #2016 invariant) before any FactStore key is built.
	it("createDispatchContext resolves two project roots sharing a relative path to distinct absolute keys, so recordEntitySnapshotDiff does not cross-contaminate (#2477)", () => {
		const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2477-root-a-"));
		const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2477-root-b-"));
		roots.push(cwdA, cwdB);
		for (const root of [cwdA, cwdB]) {
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(root, "src", "index.ts"),
				"export const x = 1;\n",
			);
		}
		const relativeFile = path.join("src", "index.ts");
		const pi = {
			getFlag: () => undefined,
		} as unknown as Parameters<typeof createDispatchContext>[2];
		const facts = new FactStore("warm-graph-cross-project-2477");

		const ctxA = createDispatchContext(
			relativeFile,
			cwdA,
			pi,
			facts,
			false,
			undefined,
			cwdA,
		);
		const ctxB = createDispatchContext(
			relativeFile,
			cwdB,
			pi,
			facts,
			false,
			undefined,
			cwdB,
		);

		// Both roots share the SAME relative spelling, but the real writer's
		// key material (createDispatchContext's resolved filePath) differs.
		expect(ctxA.filePath).not.toBe(ctxB.filePath);
		expect(path.isAbsolute(ctxA.filePath)).toBe(true);
		expect(path.isAbsolute(ctxB.filePath)).toBe(true);

		const snapshotA = new Map([["function:alpha", "alpha-v1"]]);
		recordEntitySnapshotDiff(facts, ctxA.filePath, snapshotA);

		const snapshotB = new Map([["function:gamma", "gamma-v1"]]);
		const diffB = recordEntitySnapshotDiff(facts, ctxB.filePath, snapshotB);

		// Project B's first observation of this file must read as a fresh
		// baseline (everything "added") — not as a diff against project A's
		// "function:alpha" snapshot.
		expect(diffB.added).toEqual(["function:gamma"]);
		expect(diffB.removed).toEqual([]);
		expect(diffB.modified).toEqual([]);

		// Project A's own snapshot must also be untouched by B's write.
		const diffA = recordEntitySnapshotDiff(facts, ctxA.filePath, snapshotA);
		expect(diffA).toEqual({ added: [], removed: [], modified: [] });
	});

	// #2477 round 2: the invariant `recordEntitySnapshotDiff` now enforces
	// instead of re-keying (see clients/review-graph/service.ts). Red with the
	// guard removed: pre-guard code computes a diff under a key the builder's
	// real reader (always absolute) can never read back, silently.
	it("rejects a non-absolute filePath with a visible degradation record and skips the diff, rather than computing one under an unreachable key (#2477 round 2)", () => {
		resetDegradationLedger();
		const facts = new FactStore("dispatch");
		const snapshot = new Map([["function:alpha", "alpha-v1"]]);

		const diff = recordEntitySnapshotDiff(facts, "src/index.ts", snapshot);

		expect(diff).toEqual({ added: [], removed: [], modified: [] });
		const group = getDegradationSummary().find(
			(g) => g.kind === "review-graph-non-absolute-entity-path",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("src/index.ts");

		// No fact was written under a normalized-but-unreachable key — a
		// second call with the same relative path must still be treated as a
		// fresh reject, not a "prior write found" diff.
		const secondDiff = recordEntitySnapshotDiff(
			facts,
			"src/index.ts",
			snapshot,
		);
		expect(secondDiff).toEqual({ added: [], removed: [], modified: [] });
	});
});
