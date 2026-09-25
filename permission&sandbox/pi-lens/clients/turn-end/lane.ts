/**
 * The ONE interface every turn-end delivery lane implements (#1892).
 *
 * `clients/runtime-turn.ts`'s `handleTurnEnd` grew fourteen delivery lanes
 * inline: each read its own store, applied its own freshness/disposition
 * policy, and formatted its own section into `blockerParts`/`advisoryParts`,
 * so the composer had to know every lane's rules and no lane could be read,
 * tested, or reasoned about on its own. The lanes converged on ONE shape
 * anyway — read a store, gate the rows, render a tier — and that shape is
 * this module. A lane is a deep module: three narrow calls over whatever its
 * store's rules happen to be, and the composer states none of them.
 *
 * ── The three stages, and why they are three ──────────────────────────────
 *
 * 1. `collect(ctx)` — read this lane's stores and declare, per STORE, the
 *    findings plus the freshness policy that store's rows need. It returns
 *    structured rows keyed by store name (the source identity the shared
 *    pass and its bounded records carry), never a rendered string.
 *
 *    It does NOT call the freshness gate. #3264 folded the turn-end scanner
 *    stores into ONE `gateFindingsByPathFreshness` call so a file two stores
 *    cite is stat'd once, spends one stat budget, and writes one bounded
 *    decision record per delivery instead of up to six. A lane that gated
 *    itself would re-split that pass the moment a second lane appeared, so
 *    the pass is the COMPOSER's (it is a cross-lane resource — a filesystem
 *    pass, a budget and a record, not a per-lane rule), and a lane only
 *    DECLARES its sources. `tests/config/turn-end-lane-boundaries.test.ts`
 *    pins that: a lane that calls the gate itself reds.
 *
 * 2. `gate(gates, ctx)` — apply the per-lane policy the shared pass cannot:
 *    dispositions (`filterFindingsByDisposition`, the seam in
 *    `clients/dispatch/finding-policy.ts`), and whatever existence or
 *    lifecycle contract the lane's own store carries. Takes the freshness
 *    partition the composer got for THIS lane's sources and returns the
 *    lane's own kept shape, which no other module reads.
 *
 * 3. `render(kept, ctx)` — format the tiers. A lane returns its sections; it
 *    never pushes into the turn's arrays. The push stays in the composer so
 *    the `@delivery-surface:` seam scan in
 *    `tests/clients/finding-delivery-gate.test.ts` — which reads
 *    `clients/runtime-turn.ts` and `tools/lens-diagnostics.ts` — keeps seeing
 *    every agent-facing render seam. A lane that pushed from its own file
 *    would be invisible to that scan; the boundary test reds on it.
 *
 * The composer still owns everything that is not one lane's rule: the order
 * the tiers are assembled in, the display and message caps, the turn
 * signature dedupe, the `turn-end-findings` cache write, the git-guard
 * record, and the one-per-turn disposition-suppressed notice that every
 * lane's counts fold into.
 */

import type { ActionableWarningRecord } from "../actionable-warnings.js";
import type {
	FindingFreshnessGate,
	FindingFreshnessSource,
	SourceFinding,
} from "../advisory-provenance.js";
import type { CacheEntry } from "../cache-manager.js";

/**
 * The narrow window a lane gets onto the turn's shared state. Everything a
 * lane needs that it cannot import: the project root, the hook's abort
 * signal, and the two stores it may read.
 */
export interface TurnEndLaneContext {
	cwd: string;
	/** The turn_end hook's abort signal, for any bounded work in `collect`. */
	signal?: AbortSignal | undefined;
	/**
	 * Read a scanner result cache. Memoized per turn by the composer: two
	 * envelopes of ONE store inside one delivery is the parallel-store shape
	 * this umbrella exists to kill, and the cache's TTL boundary can fall
	 * between two reads, so the secrets tier and the CVE tier would disagree
	 * about a store they both read. The inline lanes got one-read-per-store
	 * for free by reading into a local; a lane that reads its own store gets
	 * it from here.
	 *
	 * Asynchronous since #3274, and the memo holds the PROMISE: the read
	 * suspends (`CacheManager.readCacheAsync`) so the composer can put it
	 * under `bounded()` with the turn_end budget and the hook's signal, which
	 * the synchronous read made impossible — it completed during argument
	 * evaluation, before `bounded()` was handed anything. Two lanes awaiting
	 * one store therefore still share ONE read and ONE TTL boundary.
	 *
	 * `null` means "no envelope inside the bound" as well as "cold cache", and
	 * a lane must treat the two identically — it never means an EMPTY store
	 * (AGENTS.md defect shape 10). Every lane here already renders nothing for
	 * a cold store, which is the correct answer for an abandoned read too: the
	 * bound's own `hook-await-exceeded` row is what makes it visible.
	 */
	readScannerCache<T>(scanner: string): Promise<CacheEntry<T> | null>;
	/** This turn's dispatch actionable warnings (already disposition-filtered). */
	peekActionableWarnings(): readonly ActionableWarningRecord[];
}

/**
 * One lane's stores: store name → that store's rows and freshness policy.
 * `any` mirrors the gate's own source map, which is heterogeneous by
 * construction — each store has its own finding type, recovered per key by
 * {@link TurnEndLaneGates}.
 */
export type TurnEndLaneSources = Record<string, FindingFreshnessSource<any>>;

/** The freshness partition the composer's shared pass produced for one lane. */
export type TurnEndLaneGates<S extends TurnEndLaneSources> = {
	[K in keyof S]: FindingFreshnessGate<SourceFinding<S[K]>>;
};

/**
 * What a lane contributes to the turn. Sections only — the composer pushes
 * them into the tiers it owns (see the module doc for why the push stays
 * there).
 *
 * There is a field per tier the composer PUSHES, and no others: a field the
 * composer does not read is a side channel that silently drops a lane's
 * output (AGENTS.md shape 5), so the advisory tier joins this type in the
 * round that extracts a lane which renders one — together with its tagged
 * push and its registry id, which is what makes that tier a delivery surface
 * rather than a string. Optional because the next lanes will fill one tier,
 * not all of them.
 */
export interface TurnEndLaneParts {
	/** Blocker sections: findings that must be addressed before continuing. */
	blockerParts?: readonly string[];
	/** Demoted-finding sections (#1622 review M2's own tier). */
	staleSecretParts?: readonly string[];
	/**
	 * ℹ️ Advisory sections: informational this turn, never blocking.
	 *
	 * Withheld from this type until #1892's govulncheck round, by the rule
	 * above and not by oversight: the secrets lane renders no advisory, so an
	 * `advisoryParts` declared with the interface would have been a field
	 * nothing pushed — a lane could have filled it and had its whole output
	 * dropped in silence, which is exactly the side channel the rule prevents.
	 * It arrives with `clients/turn-end/lanes/govulncheck.ts`, the first lane
	 * that renders an advisory, together with the composer's tagged push
	 * (`// @delivery-surface: runtime-turn:govulncheck-advisory` above
	 * `advisoryParts.push(...)` in `clients/runtime-turn.ts`) — the tag is
	 * what makes this tier a registered delivery surface rather than a string.
	 */
	advisoryParts?: readonly string[];
	/**
	 * Store name → findings this lane dropped because of a stored disposition.
	 * The composer folds these into the turn's ONE suppressed-by-disposition
	 * notice (#1616's rule: a security finding never vanishes without a
	 * trace), per lane, so the trace still says whose marks did the
	 * suppressing.
	 */
	dispositionSuppressed?: Readonly<Record<string, number>>;
	/**
	 * `secretLocationKey` keys this lane already delivered as blockers, so a
	 * later advisory lane does not report the same location a second time
	 * (#131 Mode 3: one secret, one report, combined provenance).
	 */
	deliveredLocationKeys?: ReadonlySet<string>;
}

/**
 * One turn-end delivery lane. `S` is the lane's store map (so the composer's
 * gate result is typed per store) and `Kept` is the lane's own post-policy
 * shape, which only the lane reads.
 *
 * Three stages and nothing else — no lane id, because nothing reads one: the
 * store names inside `S` are the identity the gate's records carry, and the
 * module path is the identity a human needs.
 */
export interface TurnEndLane<S extends TurnEndLaneSources, Kept> {
	collect(ctx: TurnEndLaneContext): Promise<S>;
	gate(gates: TurnEndLaneGates<S>, ctx: TurnEndLaneContext): Kept;
	render(kept: Kept, ctx: TurnEndLaneContext): TurnEndLaneParts;
}
