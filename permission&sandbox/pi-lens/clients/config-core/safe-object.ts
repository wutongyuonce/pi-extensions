/**
 * The two structural bounds every walk in the config core obeys (#2425).
 *
 * `normalize.ts` and `merge.ts` both build objects out of KEYS THE USER CHOSE.
 * That makes plain assignment (`out[name] = value`) unsafe in a way that is
 * invisible at the call site: `out["__proto__"] = x` does not create a property,
 * it invokes the inherited `__proto__` SETTER and re-parents `out`. The result
 * serializes as `{}` while `out.injected` answers with the attacker's value, so
 * every downstream check that reads a field rather than enumerating one is
 * answered by the hijacked prototype. `constructor` and `prototype` are the same
 * family: an own property that shadows a name the rest of the runtime reads.
 *
 * The rule is REJECT, not sanitize-and-keep. A config file that spells
 * `__proto__` is never expressing a setting pi-lens has, so there is nothing to
 * preserve; a record naming the key is the whole of the useful outcome. Both
 * builders route every key through `safeAssign`, and the assignment itself uses
 * `Object.defineProperty`, so even a key that somehow reached it could only ever
 * become an own data property.
 *
 * `MAX_CONFIG_DEPTH` lives here rather than in `normalize.ts` because BOTH
 * halves of the pipeline need it. The validator bounds the walk it performs;
 * the merger bounds the walk it performs over already-validated values, because
 * `merge()` is exported and a caller can hand it a value `validate()` never saw.
 * One constant, two enforcement points, no second number to drift.
 *
 * Pure and dependency-free apart from the domain types. No state, no I/O.
 */

import type { ConfigObject, ConfigValue } from "./schema.js";

/**
 * Deepest nesting either half of the pipeline walks. A config is a settings
 * document, not a tree; 32 levels is far past anything a human writes and far
 * short of a stack overflow. Deeper nodes are dropped with a record rather than
 * truncated silently.
 */
export const MAX_CONFIG_DEPTH = 32;

/**
 * Keys that change an object's BEHAVIOR rather than its contents when assigned.
 *
 * A closed list rather than a heuristic (`/^__/`, "anything with `proto` in
 * it"): a heuristic silently claims keys a user legitimately meant and silently
 * misses the next name the runtime gives meaning to. These three are the names
 * `Object.prototype` actually defines a setter or a read for.
 */
export const UNSAFE_CONFIG_KEYS: readonly string[] = [
	"__proto__",
	"constructor",
	"prototype",
];

const UNSAFE_KEY_SET: ReadonlySet<string> = new Set(UNSAFE_CONFIG_KEYS);

/** True for a key no config object may carry. */
export function isUnsafeConfigKey(name: string): boolean {
	return UNSAFE_KEY_SET.has(name);
}

/**
 * The reason text a rejected key produces. One template, shared by both
 * builders, so the two halves of the pipeline cannot describe the same defect
 * two ways. The KEY is supplied by the caller's own bounded/redacted label; this
 * function never sees a value.
 */
export const UNSAFE_KEY_REASON =
	"config key would modify the object prototype; ignored";

/**
 * Assign one validated value under one user-chosen key, or refuse.
 *
 * Returns `false` when the key was refused, so the caller can record it. The
 * write is a `defineProperty` rather than a `=` so no inherited setter can run,
 * which makes the refusal the policy and the mechanism the backstop rather than
 * the other way round.
 */
export function safeAssign(
	target: ConfigObject,
	name: string,
	value: ConfigValue,
): boolean {
	if (isUnsafeConfigKey(name)) return false;
	Object.defineProperty(target, name, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return true;
}
