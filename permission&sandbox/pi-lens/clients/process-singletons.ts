/**
 * Process singletons — state that must exist ONCE PER PROCESS, not once per
 * module evaluation (#2146).
 *
 * WHY THIS MODULE EXISTS. pi evaluates the pi-lens module graph more than once
 * in a single process: dogfood pass 3 measured one pid emitting `host_boot`
 * nine times, another four times. Source and compiled entries load through
 * separate module graphs, in-process subagent sessions re-enter the extension
 * loader, and vitest re-evaluates modules on `vi.resetModules()`. Every
 * module-scope `let` therefore exists N times, and any state whose CORRECTNESS
 * depends on being the process's only copy silently breaks:
 *
 *  - `session-lifecycle.ts`'s registered primary: evaluation 2 starts with an
 *    empty registration, classifies a subagent temp root as `primary`, and runs
 *    the full session_start battery the #473/#2129/#2133 guard exists to
 *    decline. Measured cost: three identical word-index full rebuilds in one
 *    90s burst, 240.8s of CPU for one index.
 *  - `instance-registry.ts`'s mutation tail: N tails are N concurrent
 *    read-modify-write cycles over one `instances.json`. Measured: three
 *    `instance-registry-corrupt` records in a 9s window, with two project roots
 *    and one live instance lost from the file.
 *
 * PRECEDENT, both in-repo and both cited rather than invented:
 *  - `clients/runtime-session.ts:1826` hangs `__piLensFirstSessionDone` /
 *    `__piLensWarmupScheduled` on `globalThis` for exactly this reason.
 *  - `clients/ndjson-logger.ts:125` does the versioned form: a
 *    `Symbol.for()` key, a schema string, a version number, and an explicit
 *    adopt-or-decline decision for a state written by a different build.
 *
 * This module generalizes the second one so each state family gets the same
 * treatment without re-deriving the protocol per site.
 *
 * WHAT BELONGS HERE. Only state that is WRONG when duplicated: process-wide
 * registrations, serialization points, and once-per-process latches. A memo or
 * cache that re-derives the same answer from a stable source (an env read, a
 * host probe) is merely wasteful when duplicated, not wrong, and stays at
 * module scope — see the class-sweep table in the #2146 PR body for the
 * per-family verdicts.
 *
 * VERSIONING AND THE OLDER-SHAPE FALLBACK. Two builds can meet in one process:
 * a stale `dist/` graph and a fresh source graph, or an extension reload after
 * an upgrade. Each family carries its own `version`. The rule is
 * adopt-if-compatible, reset otherwise:
 *
 *  - Same schema and same version -> ADOPT the existing value. This is the
 *    common case and the whole point of the module.
 *  - Anything else (missing schema, different schema, older version, NEWER
 *    version) -> do NOT adopt. A shape this build cannot read is not safely
 *    readable in either direction, so guessing is worse than starting clean.
 *    The cell is replaced with a fresh value from `create()` and ONE bounded
 *    `process-singleton-reset` entry is logged per family, so a nine-evaluation
 *    process still reports at most one row per family. Behavior after a reset is
 *    exactly today's module-scope behavior for that family, which is the
 *    fail-safe direction.
 *
 * The container key itself is versioned (`SINGLETON_HOST_KEY`). A future change
 * to the CONTAINER shape bumps the key, so an old container is simply not
 * found rather than mis-read.
 */

/**
 * STATIC IMPORTS: none, deliberately. This module is a dependency leaf.
 *
 * It cannot import the degradation ledger. `instance-registry.ts` imports this
 * module, and the ledger reaches `instance-reaper.ts` (through `extension-log`
 * -> `file-utils` -> `git-tracked-ignore` -> `safe-spawn` -> `resource-sampler`),
 * and `instance-reaper` imports the registry back. Any edge from here to the
 * ledger closes a `no-client-cycles` cycle, which CI's dependency-boundaries
 * lane rejects. A dynamic import does not help: the rule excludes
 * `dynamic-import` only on the edge it evaluates, not on the intermediate edges
 * of the cycle it walks.
 *
 * So the direction is inverted, exactly as `ndjson-logger.ts` already does for
 * its own sink-write failures: this module keeps a bounded reset log, and
 * `degradation-ledger.ts` PULLS it at read time through
 * {@link getProcessSingletonResets} and folds it into `getDegradationSummary()`.
 * The record still reaches `pilens_health`, with no import from here.
 */

/** Bump only when the CONTAINER shape changes, never for a family's shape. */
const SINGLETON_HOST_KEY = Symbol.for("pi-lens.process-singletons.v1");

const SINGLETON_SCHEMA = "pi-lens.process-singletons";

/** Degradation kind emitted when an incompatible cell is discarded. */
export const PROCESS_SINGLETON_RESET_KIND = "process-singleton-reset";

interface SingletonCell {
	schema: string;
	version: number;
	value: unknown;
}

type SingletonContainer = Map<string, SingletonCell>;

const singletonHost = globalThis as typeof globalThis & {
	[key: symbol]: unknown;
};

/**
 * The process's one container. Deliberately created on first read rather than
 * at module scope of a single graph: whichever evaluation runs first wins, and
 * every later evaluation adopts it.
 */
function container(): SingletonContainer {
	const existing = singletonHost[SINGLETON_HOST_KEY];
	if (existing instanceof Map) return existing as SingletonContainer;
	const fresh: SingletonContainer = new Map();
	singletonHost[SINGLETON_HOST_KEY] = fresh;
	return fresh;
}

function isAdoptable(cell: unknown, version: number): cell is SingletonCell {
	if (!cell || typeof cell !== "object") return false;
	const candidate = cell as Partial<SingletonCell>;
	return (
		candidate.schema === SINGLETON_SCHEMA &&
		candidate.version === version &&
		candidate.value !== undefined
	);
}

/** One bounded reset log per process, capped so a pathological build pair
 * cannot grow it without limit. */
export const PROCESS_SINGLETON_RESET_LOG_FAMILY = "process-singleton-reset-log";
const RESET_LOG_FAMILY = PROCESS_SINGLETON_RESET_LOG_FAMILY;
const RESET_LOG_VERSION = 1;
const RESET_LOG_CAP = 16;

export interface ProcessSingletonReset {
	family: string;
	reason: string;
}

function resetLog(): { entries: ProcessSingletonReset[] } {
	return getProcessSingleton(RESET_LOG_FAMILY, RESET_LOG_VERSION, () => ({
		entries: [] as ProcessSingletonReset[],
	}));
}

/**
 * Record that an incompatible cell was discarded. Bounded twice: once per
 * family (a nine-evaluation process logs at most one entry per family) and once
 * overall by {@link RESET_LOG_CAP}.
 */
function recordIncompatibleCell(
	family: string,
	wantedVersion: number,
	found: Partial<SingletonCell>,
): void {
	// The reset log is itself a family, so recording ITS reset would recurse.
	// Dropping that one record is correct: the log it would be written to is the
	// thing being discarded.
	if (family === RESET_LOG_FAMILY) return;
	const log = resetLog();
	if (log.entries.some((entry) => entry.family === family)) return;
	if (log.entries.length >= RESET_LOG_CAP) return;
	log.entries.push({
		family,
		reason:
			`incompatible process singleton discarded (found schema=${String(found.schema)} ` +
			`version=${String(found.version)}, this build wants schema=${SINGLETON_SCHEMA} ` +
			`version=${wantedVersion})`,
	});
}

/**
 * Read-time view for `degradation-ledger.ts` (see the header). Never performs
 * I/O and never throws, so folding it into a health summary is free.
 */
export function getProcessSingletonResets(): readonly ProcessSingletonReset[] {
	return resetLog().entries.map((entry) => ({ ...entry }));
}

/**
 * Return the process-wide value for `family`, creating it on the first
 * evaluation that asks and adopting it on every later one.
 *
 * `version` describes the SHAPE of the value `create()` builds. Bump it when a
 * build changes that shape, so a graph carrying the old shape is discarded
 * instead of mis-read (see the module docstring's fallback rules).
 *
 * `create()` runs at most once per process per family, unless an incompatible
 * cell forced a reset.
 *
 * `onIncompatible` is for values that own external resources. It runs before
 * the cell is replaced, so the owner can tear those resources down safely.
 */
export function getProcessSingleton<T extends object>(
	family: string,
	version: number,
	create: () => T,
	onIncompatible?: (value: unknown) => void,
): T {
	const cells = container();
	const existing = cells.get(family);
	if (isAdoptable(existing, version)) return existing.value as T;
	if (existing !== undefined) {
		// An incompatible cell from another build. One bounded row per family:
		// nine evaluations must not write nine records (AGENTS.md's bounded-record
		// rule; `recordDegradationOnce` keys on kind + subject).
		recordIncompatibleCell(family, version, existing as Partial<SingletonCell>);
		onIncompatible?.((existing as Partial<SingletonCell>).value);
	}
	const value = create();
	cells.set(family, { schema: SINGLETON_SCHEMA, version, value });
	return value;
}

/**
 * Test-only: drop the process-wide container so the next
 * {@link getProcessSingleton} call rebuilds every family from `create()`.
 *
 * This clears the GLOBAL state, not a module-local copy — a reset that only
 * cleared module scope would be the very defect this module fixes, and would
 * make every suite that relies on isolation pass vacuously (catalog shape 7).
 */
export function _resetProcessSingletonsForTests(): void {
	singletonHost[SINGLETON_HOST_KEY] = new Map<string, SingletonCell>();
}

/**
 * Test-only: install a raw cell so a suite can exercise the older/newer-shape
 * fallback without needing two real builds in one process.
 */
export function _seedProcessSingletonCellForTests(
	family: string,
	cell: { schema?: string; version?: number; value?: unknown },
): void {
	container().set(family, cell as SingletonCell);
}

// --- Module-evaluation ordinal (#2146 observability) ---

const EVALUATION_ORDINAL_FAMILY = "module-evaluation-ordinal";
const EVALUATION_ORDINAL_VERSION = 1;

/**
 * How many times this process has evaluated the pi-lens module graph, 1-based.
 *
 * Called once, at module scope of `clients/startup-timing.ts`, so the number it
 * returns is the evaluation count of the graph that contains the extension
 * entry. It is carried on `host_boot.metadata.evaluationOrdinal` so a multi-eval
 * process is greppable from `latency.log` instead of having to be inferred by
 * counting `host_boot` lines per pid — the observability gap #2146 names.
 */
export function nextModuleEvaluationOrdinal(): number {
	const state = getProcessSingleton(
		EVALUATION_ORDINAL_FAMILY,
		EVALUATION_ORDINAL_VERSION,
		() => ({ evaluations: 0 }),
	);
	state.evaluations += 1;
	return state.evaluations;
}
