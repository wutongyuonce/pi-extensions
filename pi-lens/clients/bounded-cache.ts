/** Small insertion-ordered LRU used for process-lifetime memo tables. */
export class BoundedLruCache<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly maxEntries: number) {}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	set(key: K, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}
	clear(): void {
		this.entries.clear();
	}
	get size(): number {
		return this.entries.size;
	}
	keys(): IterableIterator<K> {
		return this.entries.keys();
	}
	values(): IterableIterator<V> {
		return this.entries.values();
	}
	entriesArray(): Array<[K, V]> {
		return [...this.entries.entries()];
	}
	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries[Symbol.iterator]();
	}
}
