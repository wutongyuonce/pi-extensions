// Persistent inbound message dedupe. Feishu may deliver the same message_id
// more than once; we must admit each message exactly once within the TTL.
// JSONL append-only; pruned on load + periodically.

import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";

export const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 100_000;

export class DedupeStore {
	private seen = new Map<string, number>();
	private readonly filePath: string;
	private readonly ttlMs: number;

	constructor(filePath: string, ttlMs: number = DEDUPE_TTL_MS) {
		this.filePath = filePath;
		this.ttlMs = ttlMs;
	}

	/** Load persisted entries and drop expired ones. Returns loaded count. */
	async init(): Promise<number> {
		if (!existsSync(this.filePath)) return 0;
		try {
			const text = readFileSync(this.filePath, "utf8");
			const now = Date.now();
			let count = 0;
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line) as { id: string; ts: number };
					if (now - rec.ts > this.ttlMs) continue;
					this.seen.set(rec.id, rec.ts);
					count++;
				} catch {
					/* skip corrupt line */
				}
			}
			return count;
		} catch {
			return 0;
		}
	}

	/** True when this id is new (admitted); false when already seen. */
	admit(id: string): boolean {
		if (!id) return true;
		const now = Date.now();
		const existing = this.seen.get(id);
		if (existing !== undefined && now - existing <= this.ttlMs) return false;
		this.seen.set(id, now);
		this.append(id, now);
		this.maybePrune(now);
		return true;
	}

	has(id: string): boolean {
		const ts = this.seen.get(id);
		if (ts === undefined) return false;
		return Date.now() - ts <= this.ttlMs;
	}

	size(): number {
		return this.seen.size;
	}

	/** Drop expired entries from memory and rewrite the file compacted. */
	prune(now: number = Date.now()): number {
		const cutoff = now - this.ttlMs;
		let removed = 0;
		for (const [id, ts] of this.seen) {
			if (ts < cutoff) {
				this.seen.delete(id);
				removed++;
			}
		}
		this.rewrite();
		return removed;
	}

	private maybePrune(now: number): void {
		if (this.seen.size > MAX_MEMORY_ENTRIES) this.prune(now);
	}

	private append(id: string, ts: number): void {
		try {
			appendFileSync(this.filePath, `${JSON.stringify({ id, ts })}\n`, "utf8");
		} catch {
			// Persistence failure must not break inbound processing.
		}
	}

	private rewrite(): void {
		try {
			const lines = [...this.seen.entries()]
				.map(([id, ts]) => JSON.stringify({ id, ts }))
				.join("\n");
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, lines ? `${lines}\n` : "", "utf8");
			renameSync(tmp, this.filePath);
		} catch {
			// Best-effort compaction.
		}
	}
}
