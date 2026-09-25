import type { FactStore } from "../dispatch/fact-store.js";
import { normalizeMapKey } from "../path-utils.js";
import {
	computeImpactCascade as computeImpactCascadeImpl,
	computeTransitiveImpact as computeTransitiveImpactImpl,
	type TransitiveImpactResult,
} from "./query.js";
import {
	buildOrUpdateGraph as buildOrUpdateGraphImpl,
	type GraphSeqHint,
} from "./builder.js";
import { formatImpactCascade as formatImpactCascadeImpl } from "./format.js";
import { buildModuleGraph } from "./workspace-modules.js";
import type { ImpactCascadeResult, ReviewGraph } from "./types.js";

const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const ENTITY_SNAPSHOT_PREFIX = "session.reviewGraph.entitySnapshot:";

export async function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
	seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
	return buildOrUpdateGraphImpl(cwd, changedFiles, facts, seqHint);
}

export function computeImpactCascade(
	graph: ReviewGraph,
	changedFile: string,
	cwd?: string,
): ImpactCascadeResult {
	const moduleGraph = cwd ? buildModuleGraph(cwd) : null;
	return computeImpactCascadeImpl(graph, changedFile, moduleGraph);
}

export function formatImpactCascade(
	result: ImpactCascadeResult,
	maxFiles?: number,
): string | undefined {
	return formatImpactCascadeImpl(result, maxFiles);
}

/** Transitive (depth-bounded) dependents of a file — see query.computeTransitiveImpact. */
export function computeTransitiveImpact(
	graph: ReviewGraph,
	seedFile: string,
	options?: Parameters<typeof computeTransitiveImpactImpl>[2],
): TransitiveImpactResult {
	return computeTransitiveImpactImpl(graph, seedFile, options);
}

export function recordEntitySnapshotDiff(
	facts: FactStore,
	filePath: string,
	nextSnapshot: Map<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
	// Normalize once at this boundary, then reuse the folded path for both
	// per-file facts. An unnormalized write is a key the builder reader can never
	// hit, and an unnormalized snapshot forks a second empty diff (#2355).
	const normalizedFilePath = normalizeMapKey(filePath);
	const snapshotKey = `${ENTITY_SNAPSHOT_PREFIX}${normalizedFilePath}`;
	const changedSymbolsKey = `${CHANGED_SYMBOLS_PREFIX}${normalizedFilePath}`;
	const stored = facts.getBoundedSessionFact<Map<string, string>>(snapshotKey);
	// An evicted snapshot is unknown, not empty. Diffing against an empty Map
	// puts every entity in `added`, which reads downstream as "the whole file
	// changed" and schedules a blast-radius run for a file that did not change.
	// Re-seed the snapshot and report no diff instead (#2282 review F1).
	if (stored === undefined && facts.wasBoundedSessionFactEvicted(snapshotKey)) {
		facts.setBoundedSessionFact(snapshotKey, new Map(nextSnapshot));
		facts.setBoundedSessionFact(changedSymbolsKey, []);
		return { added: [], removed: [], modified: [] };
	}
	const prev = stored ?? new Map<string, string>();
	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];

	for (const [key, value] of nextSnapshot.entries()) {
		if (!prev.has(key)) added.push(key);
		else if (prev.get(key) !== value) modified.push(key);
	}
	for (const key of prev.keys()) {
		if (!nextSnapshot.has(key)) removed.push(key);
	}

	const changedSymbols = [
		...new Set(
			[...added, ...modified, ...removed]
				.map((key) => key.split(":")[1])
				.filter(Boolean),
		),
	];
	facts.setBoundedSessionFact(snapshotKey, new Map(nextSnapshot));
	facts.setBoundedSessionFact(changedSymbolsKey, changedSymbols);
	return { added, removed, modified };
}
