import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getGraphBuildInfoForGraph,
	graphBuildInfoIsTrustworthy,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

// #1179 (latent P3 from the #1108/#1180 side-channel audit). `getGraphBuildInfoForGraph`
// falls back to the global last-build slot on a `_graphBuildInfoByGraph` WeakMap
// identity miss. Once a real build has stamped, that slot holds a REAL build's info,
// so serving it for a DIFFERENT (unstamped/rehydrated) graph would leak a SIBLING
// graph's skipped/healthy state — which the `graph_degraded` marker gate would then
// mistake for a clean leaf (#533 false-clean trap). `graphBuildInfoIsTrustworthy`
// fails CLOSED for that case so the gate surfaces a degraded/unknown verdict instead.

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

async function buildRealGraph(): Promise<{ graph: ReviewGraph; root: string }> {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-graph-failclosed-"),
	);
	roots.push(root);
	const file = path.join(root, "a.ts");
	fs.writeFileSync(file, "export const a = 1;\n");
	clearGraphCache();
	const graph = await buildOrUpdateGraph(root, [file], new FactStore());
	return { graph, root };
}

describe("graphBuildInfoIsTrustworthy — #1179 fail-closed WeakMap guard", () => {
	it("a freshly built graph is trustworthy and reads its OWN build-info", async () => {
		const { graph } = await buildRealGraph();
		// Live-path invariant: the cascade reads the same-identity stamped instance.
		expect(graphBuildInfoIsTrustworthy(graph)).toBe(true);
		expect(graph).toBe(graph);
		expect(getGraphBuildInfoForGraph(graph).mode).not.toBe(undefined);
	});

	it("an identity MISS after a sibling was stamped is UNtrustworthy — the raw fallback would leak the sibling's state", async () => {
		const { graph: stamped } = await buildRealGraph();
		const siblingInfo = getGraphBuildInfoForGraph(stamped);
		// A graph never passed through the stamping path (a future rehydrated /
		// deserialized instance). Its identity is absent from the WeakMap.
		const rehydrated = {} as unknown as ReviewGraph;

		// The RAW fallback serves the sibling's build-info verbatim (the hazard):
		// `graph_degraded` would read this graph's coverage off a DIFFERENT graph.
		expect(getGraphBuildInfoForGraph(rehydrated)).toBe(siblingInfo);

		// The fail-closed guard refuses to trust that fallback for THIS graph, so the
		// degraded-marker gate treats coverage as unknown rather than serving a
		// (possibly healthy) sibling verdict.
		expect(graphBuildInfoIsTrustworthy(rehydrated)).toBe(false);
		// And the stamped sibling itself stays trustworthy (identity present).
		expect(graphBuildInfoIsTrustworthy(stamped)).toBe(true);
	});

	it("with NOTHING stamped (pristine default slot), a miss is trustworthy — the default is nobody's real state", () => {
		// No build has run since the afterEach clear reset `_anyGraphStamped`; the
		// global slot is still the pristine `mode: "full"` default, which cannot be a
		// sibling's state, so an unstamped graph safely reads it (no false degraded).
		const fresh = {} as unknown as ReviewGraph;
		expect(graphBuildInfoIsTrustworthy(fresh)).toBe(true);
	});

	it("clearing the workspace cache re-pristines the slot, so a subsequent miss is trustworthy again", async () => {
		await buildRealGraph();
		const rehydrated = {} as unknown as ReviewGraph;
		expect(graphBuildInfoIsTrustworthy(rehydrated)).toBe(false);
		clearReviewGraphWorkspaceCache();
		// Slot is back to the default; the miss can no longer leak a sibling's state.
		expect(graphBuildInfoIsTrustworthy(rehydrated)).toBe(true);
	});
});
