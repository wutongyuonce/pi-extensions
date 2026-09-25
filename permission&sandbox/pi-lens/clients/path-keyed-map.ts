/**
 * A `Map` for file-path keys that folds every key through a caller-supplied
 * normalizer INTERNALLY, so keying on a raw (non-normalized) path is
 * structurally impossible — the whole path-key divergence class (#1025,
 * follow-up to #1020/#210) collapses to "pick the right normalizer once, at
 * construction," instead of every call site having to remember to normalize on
 * write AND read AND delete (the exact discipline #210 declared and #1020
 * proved is easy to miss).
 *
 * The normalizer runs on EVERY `get`/`set`/`has`/`delete`, so two
 * differently-formed keys for the same path (`SUB\a.ts` vs `sub/a.ts`, on a
 * case-insensitive FS) collapse to a single entry — no silent duplicate, no
 * `has()` miss, no orphaned stale entry.
 *
 * Values retain their ORIGINAL display path. Consumers that render paths
 * (symbol_search results, footer widgets) must not see a lowercased /
 * slash-folded key, so the entry stores the display path alongside the value
 * and every iteration surface (`keys`/`values`/`entries`/`forEach`/the default
 * iterator) yields that display path — the exact form last written, never the
 * folded internal key. `set` refreshes the display path to the most recent
 * write (last-writer-wins), matching a plain `Map`'s "the key you set is the
 * key you see" intuition while still de-duplicating by normalized identity.
 *
 * Optionally BOUNDED: pass `maxEntries` and the backing store becomes a
 * `BoundedFifoMap` (see the constructor). Unbounded by default.
 *
 * Choose the normalizer to match how the keyed state is used:
 *  - `normalizeEphemeralMapKey` (path-utils.ts) — cheap slash-fold +
 *    win32-lowercase, NO filesystem I/O — for hot, single-process, in-memory
 *    indexes whose keys this process produced itself (e.g. the word index).
 *  - `normalizeMapKey` — realpath-canonicalizing — for long-lived state shared
 *    across call sites where symlink/real-casing resolution matters.
 */
import { BoundedFifoMap } from "./bounded-cache.js";

/**
 * The slice of `Map` this class actually uses, so the backing store can be
 * either a plain `Map` (unbounded) or a `BoundedFifoMap` (bounded) without
 * either leaking into the public surface. `set` is declared `void` — the two
 * implementations return different things (`this` vs the evicted pairs) and
 * neither is this class's to hand out; TypeScript's void-return assignability
 * rule accepts both.
 */
interface PathKeyedStore<E> {
	get(key: string): E | undefined;
	has(key: string): boolean;
	set(key: string, value: E): void;
	delete(key: string): boolean;
	clear(): void;
	readonly size: number;
	values(): IterableIterator<E>;
	[Symbol.iterator](): IterableIterator<[string, E]>;
}

export class PathKeyedMap<V> {
	private readonly store: PathKeyedStore<{ displayPath: string; value: V }>;

	/**
	 * `maxEntries` bounds the map with insertion-order (FIFO) eviction, on
	 * `BoundedFifoMap` — the repo's one eviction implementation (#2442). Omit
	 * it for an unbounded map. A path-keyed map that needs a bound gets it
	 * here rather than hand-rolling `keys().next().value` at the call site,
	 * which is what `PartialApplyRecordStore` did before #2442's review round.
	 *
	 * FIFO, not LRU, and evicting AFTER the write, not before: a `set` of an
	 * already-resident path is an update, and must not drop an unrelated file
	 * to make room for a key that needs none.
	 */
	constructor(
		private readonly normalize: (p: string) => string,
		maxEntries?: number,
	) {
		this.store =
			maxEntries === undefined
				? new Map()
				: new BoundedFifoMap<string, { displayPath: string; value: V }>(
						maxEntries,
					);
	}

	get size(): number {
		return this.store.size;
	}

	get(path: string): V | undefined {
		return this.store.get(this.normalize(path))?.value;
	}

	has(path: string): boolean {
		return this.store.has(this.normalize(path));
	}

	set(path: string, value: V): this {
		this.store.set(this.normalize(path), { displayPath: path, value });
		return this;
	}

	delete(path: string): boolean {
		if (this.store.delete(this.normalize(path))) return true;
		// A filesystem-aware normalizer can change after the keyed file is
		// deleted (for example, real on-disk casing becomes a lowercased missing
		// tail on Windows). The caller may still hold the exact display key it
		// received from this map. Honor that captured identity without deriving a
		// second path form, so deletion remains possible across existence changes.
		for (const [key, entry] of this.store) {
			if (entry.displayPath !== path) continue;
			this.store.delete(key);
			return true;
		}
		return false;
	}

	clear(): void {
		this.store.clear();
	}

	*keys(): IterableIterator<string> {
		for (const entry of this.store.values()) yield entry.displayPath;
	}

	*values(): IterableIterator<V> {
		for (const entry of this.store.values()) yield entry.value;
	}

	*entries(): IterableIterator<[string, V]> {
		for (const entry of this.store.values())
			yield [entry.displayPath, entry.value];
	}

	forEach(callback: (value: V, path: string, map: this) => void): void {
		for (const entry of this.store.values()) {
			callback(entry.value, entry.displayPath, this);
		}
	}

	[Symbol.iterator](): IterableIterator<[string, V]> {
		return this.entries();
	}
}
