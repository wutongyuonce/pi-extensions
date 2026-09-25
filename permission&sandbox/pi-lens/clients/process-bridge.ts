/**
 * Shared process-bridge registration helper (#2437).
 *
 * `clients/read-bridge.ts` (#1265) and `clients/mutation-bridge.ts` (#2423)
 * each mount a versioned, frozen method-table object at a well-known
 * `globalThis[Symbol.for("pi-lens:...")]` key so a same-process producer can
 * reach pi-lens's bookkeeping without importing its internals. Both bridges
 * carried an identical mount body — a first-wins existence check,
 * `Object.freeze`, and a non-writable/non-configurable `Object.defineProperty`
 * — differing only in their key and method table (named by the #2432 review,
 * refs #2423). This module owns that body once.
 *
 * NOT `clients/process-singletons.ts` (#2146): that module keeps a single
 * MUTABLE, adopt-if-version-compatible value per "family" inside ONE shared
 * container (a different, single key mounts the container itself, and a
 * version mismatch there means "discard and rebuild"). A bridge's contract is
 * the opposite: the documented producer protocol reads
 * `globalThis[Symbol.for("pi-lens:mutation-bridge")]` directly as a frozen,
 * first-wins, unreplaceable property, and a version mismatch is the
 * PRODUCER's problem — an unsupported bridge it should not call — never a
 * signal for pi-lens to silently reset its own mount. Reusing the singleton
 * container would change that documented external contract, so this stays a
 * separate, deliberately smaller leaf built for the bridge shape only.
 *
 * STATIC IMPORTS: none, deliberately. Both `read-bridge.ts` and
 * `mutation-bridge.ts` import this module; it must stay a dependency leaf so
 * neither gains an edge onto anything else in `clients/` (`no-client-cycles`).
 */

/** A bridge object mountable through {@link registerProcessBridge}. */
export interface ProcessBridge {
	readonly version: number;
}

/**
 * Mount `build()`'s result at `globalThis[key]`, once per process.
 *
 * First-wins: if `key` already exists on `globalThis` — from an earlier call
 * in this process, whether this bridge's own prior registration or a
 * redundant re-activation — `build()` is never invoked and the existing
 * mount is left untouched. The mounted value is frozen and installed
 * non-writable/non-configurable so no later code can silently replace or
 * extend it; the `in` check above is what keeps a redundant call from
 * throwing on that now-frozen property.
 */
export function registerProcessBridge<T extends ProcessBridge>(
	key: symbol,
	build: () => T,
): void {
	if (key in (globalThis as object)) return;

	const bridge = Object.freeze(build());

	Object.defineProperty(globalThis, key, {
		value: bridge,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

/**
 * The bridge mounted at `key`, or `undefined` when nothing is mounted, the
 * mounted value is not an object, or its `version` does not equal `version`.
 * A version mismatch means "not a bridge this caller recognizes" — never
 * adopted and never reset; the reset-on-mismatch behavior belongs to
 * `process-singletons.ts`'s different contract, not this one.
 */
export function getProcessBridge<T extends ProcessBridge>(
	key: symbol,
	version: number,
): T | undefined {
	const bridge = (globalThis as Record<symbol, unknown>)[key];
	if (!bridge || typeof bridge !== "object") return undefined;
	const candidate = bridge as Partial<T>;
	if (candidate.version !== version) return undefined;
	return candidate as T;
}
