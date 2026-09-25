/**
 * The session-root registry: which project roots does this process serve?
 *
 * #2052. A file is IN-SESSION when it lies within any initialized session cwd.
 * `initLSPConfig` (`clients/lsp/config.ts`) is the single writer, and every
 * entry point funnels through it — `ensureLSPConfigInitialized` (`index.ts`),
 * `ensureReady` (`mcp/server.ts`), `clients/runtime-session.ts`, and
 * `clients/lens-engine.ts` — so registration needs no second call site.
 *
 * WHY THIS IS ITS OWN MODULE, not a helper inside `config.ts`: `clients/lsp/
 * index.ts`'s import surface from `config.js` is mirrored by an explicit
 * `vi.mock` factory in ~58 test files. Importing a new symbol from `config.js`
 * breaks every one of them with "No export is defined on the mock", which is a
 * standing tax on any future export. The registry is also a different concern
 * from `workspaceConfigs`: that map stores per-root CONFIG PAYLOAD and is
 * LRU-capped at 32, whereas this set answers "is this root served" and must
 * not silently evict a live root and start declining its files.
 *
 * WHY IT IS NOT A LATCH. The first attempt at #2052 used a single
 * last-writer-wins session cwd that fell back to `process.cwd()`. Two bugs
 * followed directly from that shape, and this module's contract excludes both:
 *
 *  - MULTI-ROOT. A process that initializes projA and then projB serves BOTH.
 *    A latch silently made projA's files foreign the moment projB registered.
 *  - FAIL-OPEN ON EMPTY. An empty registry declines NOTHING. Declining is a
 *    hard refusal to answer, so it must rest on positive evidence that a
 *    session exists AND that the file sits outside it — never on the absence
 *    of evidence. Callers that never declared a session (isolated tests, API
 *    consumers, a request racing initialization) therefore keep the pre-#2052
 *    clamp behavior instead of having `process.cwd()` gate a refusal.
 *
 * This is also the seam #2053 needs: an explicit `analysisRoot` registers here.
 */

import { isSameOrWithin } from "./server.js";
import path from "node:path";

/**
 * Insertion-ordered, so eviction drops the OLDEST root. Matches
 * `LSP_CONFIG_CWD_CAP` in `index.ts`, the cap on the set of cwds that
 * `ensureLSPConfigInitialized` will initialize at all — a root this process
 * cannot re-initialize must not still be considered served.
 */
const sessionRoots = new Set<string>();
const SESSION_ROOT_CAP = 128;

/** Record a session cwd as served. Idempotent; re-registering refreshes nothing. */
export function registerSessionRoot(cwd: string): void {
	sessionRoots.add(path.resolve(cwd));
	while (sessionRoots.size > SESSION_ROOT_CAP) {
		const oldest = sessionRoots.values().next().value;
		if (oldest === undefined) break;
		sessionRoots.delete(oldest);
	}
}

/** Return whether this exact root is still served after cap eviction. */
export function isSessionRootRegistered(cwd: string): boolean {
	return sessionRoots.has(path.resolve(cwd));
}

/** True when a readiness memo must run initialization for this root. */
export function shouldInitializeSessionRoot(
	cwd: string,
	readyRoots: ReadonlySet<string>,
): boolean {
	const normalized = path.resolve(cwd);
	return !readyRoots.has(normalized) || !isSessionRootRegistered(normalized);
}

/**
 * Is `filePath` outside EVERY registered session root?
 *
 * Returns false (serve it) when the registry is empty — see the fail-open rule
 * in this module's header. Containment uses `isSameOrWithin`, the same
 * comparator the LSP root ceiling uses, which selects `path.win32` by path
 * SHAPE rather than by `process.platform` (shape 2 / #1150).
 */
export function isOutsideAllSessionRoots(filePath: string): boolean {
	if (sessionRoots.size === 0) return false;
	const resolved = path.resolve(filePath);
	for (const root of sessionRoots) {
		if (isSameOrWithin(root, resolved)) return false;
	}
	return true;
}

/**
 * The registered roots, for the decline telemetry record. Sorted with a
 * code-unit comparator so the emitted string is deterministic across locales
 * (#1883), and capped because the record is BOUNDED — a process with many
 * roots must not emit an unbounded path list.
 */
export function getSessionRootsForTelemetry(limit = 4): string[] {
	return [...sessionRoots]
		.sort((a, b) => Number(a > b) - Number(a < b))
		.slice(0, limit);
}

/**
 * Clear the registry. Called by `resetLSPConfigStateForTests` so the registry
 * and the config store reset together and cannot disagree about which roots
 * exist.
 */
export function resetSessionRootsForTests(): void {
	sessionRoots.clear();
}
