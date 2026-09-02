/**
 * Shared memoized-import-with-eviction helper (#1570).
 *
 * `x ??= import(...)` looks harmless but caches a REJECTED promise for the
 * process lifetime: once a dynamic import fails (a transient EMFILE, a
 * momentary fs hiccup, a race with a file still being written), every later
 * caller awaits that same rejected promise forever — one bad load poisons
 * the module for the rest of the process. Module loads are cheap, so a
 * rejection should evict the memo immediately and let the next demand
 * retry; no cooldown is needed (unlike a network-backed memo such as the
 * grammar-download retry in #1536, which does need one).
 *
 * Caveat (#1592): the eviction genuinely helps for a RESOLUTION failure
 * (`ERR_MODULE_NOT_FOUND` — the file did not exist yet, or a transient fs
 * error before `load()` gets to `import()` at all) and for any pre-import
 * throw. It does NOT help for an EVALUATION failure — `load()`'s `import()`
 * running the target module's top-level code and that code throwing. Node's
 * ESM loader permanently memoizes a module record that threw during
 * evaluation: a later `import()` of the SAME resolved URL replays the
 * cached rejection instead of re-running the module, even after whatever
 * was broken gets fixed on disk. Measured in #1583's review: replaying that
 * cached rejection costs ~0.01ms — cheap precisely because nothing is
 * re-attempted. Evicting the memo here still lets `get()` call `load()`
 * again, but if `load()` wraps an `import()` of a URL that failed during
 * evaluation, that call is a dead retry — it looks like a second attempt
 * and structurally cannot be one. Callers must not read "retries" as "can
 * recover from a broken compiled module mid-process."
 */
export interface LazyImport<T> {
	/** Start (or reuse) the load. A rejected load evicts itself first, so the
	 * next call retries instead of replaying the same rejection forever. */
	get(): Promise<T>;
	/** Test-only: drop the memo unconditionally, independent of settlement. */
	resetForTests(): void;
}

export function createLazyImport<T>(load: () => Promise<T>): LazyImport<T> {
	let cached: Promise<T> | undefined;
	return {
		get(): Promise<T> {
			// `Promise.resolve().then(load)` (not a bare `load()`) so a loader
			// that throws SYNCHRONOUSLY — rather than returning a rejected
			// promise — still yields a rejected promise instead of throwing out
			// of `get()` itself. `import(...)` never throws synchronously, but a
			// caller-supplied `load` is not guaranteed to keep that contract.
			return (cached ??= Promise.resolve()
				.then(() => load())
				.catch((err: unknown) => {
					cached = undefined;
					throw err;
				}));
		},
		resetForTests(): void {
			cached = undefined;
		},
	};
}
