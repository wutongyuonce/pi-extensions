import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { moduleReport } from "../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// #1089: `readCallGraph`'s "identity-missing" reason (module-report.ts) fires
// when the review graph IS warm (getCachedReviewGraph returns a graph) but its
// canonical cache identity cannot be resolved (getReviewGraphCacheIdentity
// returns undefined) — the single-call moduleReport flow only hits this in a
// genuine concurrent-build race (#1088: a caller's `graph` reference going
// stale relative to `_workspaceGraphCache` between the two lookups), which
// isn't reproducible synchronously without racing real builds. Isolated in its
// own file (rather than module-report.test.ts) because the mock below replaces
// getReviewGraphCacheIdentity for every test in the file — sharing it with the
// suite's many real-identity call-graph assertions would be fragile.
vi.mock("../../clients/review-graph/builder.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/review-graph/builder.js")
		>();
	return {
		...actual,
		getReviewGraphCacheIdentity: vi.fn(() => undefined),
	};
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

describe("moduleReport — call-graph identity-missing (#1089)", () => {
	it("reports identity-missing (never zero calls) when the graph is warm but its cache identity can't be resolved", async () => {
		const env = setupTestEnvironment("pi-lens-modreport-identity-");
		cleanups.push(env.cleanup);
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(): number { return 1; }\n",
		);
		await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

		const report = await moduleReport("a.ts", env.tmpDir, { callGraph: true });

		expect(report.callGraph).toMatchObject({
			available: false,
			reason: "identity-missing",
		});
		// Honesty contract: an unavailable call graph must never be indistinguishable
		// from cached-but-actually-called data in the provenance field either.
		expect(report.provenance?.callGraph).toBe("none");
	});
});
