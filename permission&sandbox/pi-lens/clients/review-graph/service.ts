import type { FactStore } from "../dispatch/fact-store.js";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { isAbsoluteFilePath, normalizeMapKey } from "../path-utils.js";
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
	// #2477 round 2 (reviewer F1/F2): folding `cwd` into this key was REVERTED.
	// The writer (`clients/dispatch/runners/tree-sitter.ts`) passes `ctx.cwd`,
	// which `createDispatchContext` (`clients/dispatch/dispatcher.ts:324-326`)
	// sets to the file's NEAREST LANGUAGE-ROOT (`resolveLanguageRootForFile`),
	// while the reader (`upsertChangedSymbols`, `clients/review-graph/builder.ts`,
	// reached via `computeCascadeForFile` → `buildOrUpdateGraph`) keys off the
	// WORKSPACE cwd. In a monorepo/cargo-workspace/go-module layout those two
	// cwd values diverge, so a folded `(cwd, path)` key the builder reader can
	// never hit zeroed `graphChangedSymbolCount` on every build — reproduced:
	// master returns `["alpha","beta"]`, the folded-key version returns `[]`
	// — and made the cascade over-fan to every symbol (`query.ts:230-238`
	// treats an empty `changedSymbols` as "no narrowing").
	//
	// The #2477 cross-project collision this was meant to close cannot reach
	// this function in production: the sole writer always passes `ctx.filePath`,
	// which `createDispatchContext` sets via `resolveRunnerPath` to an
	// ALWAYS-ABSOLUTE path (the #2016 invariant, `dispatcher.ts:320,327,346`).
	// A relative `filePath` here can only happen through a caller regression.
	// Enforce that instead of re-keying: reject a non-absolute `filePath` with
	// a visible, bounded ledger record (never silently, per AGENTS.md) and
	// skip the diff rather than compute one under a key the real reader could
	// never reach anyway. `recordDegradationOnce` (not a thrown error) is used
	// because the sole call site's surrounding try/catch
	// (`tree-sitter.ts` — "entity snapshot / blast-radius enrichment is
	// best-effort") is a BARE, UNLOGGED catch: a thrown error there vanishes
	// with no trace, which is strictly worse than a ledger record.
	if (!isAbsoluteFilePath(filePath)) {
		recordDegradationOnce({
			kind: "review-graph-non-absolute-entity-path",
			subject: filePath,
			reason:
				"recordEntitySnapshotDiff requires an absolute filePath (refs #2477)",
		});
		return { added: [], removed: [], modified: [] };
	}
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
