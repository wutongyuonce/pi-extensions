// Live channel (spec §6.5): volatile streaming path for card patches.
// In-memory, coalesced per card, throttled. Correctness NEVER depends on this
// channel — a dropped patch is fine because the finalize pass reconciles.

export interface StreamPatch {
	cardId: string;
	/** Incremental text delta to append. */
	delta?: string;
	/** Full replacement content (for update-in-place cards). */
	content?: unknown;
}

export interface LiveChannelOptions {
	throttleMs: number;
	send: (patch: StreamPatch) => Promise<void>;
	now?: () => number;
}

interface CardState {
	pendingDelta: string;
	pendingContent: unknown;
	lastSentAt: number;
	timer: NodeJS.Timeout | undefined;
	closed: boolean;
}

export class LiveChannel {
	private readonly throttleMs: number;
	private readonly send: (patch: StreamPatch) => Promise<void>;
	private readonly now: () => number;
	private readonly cards = new Map<string, CardState>();

	constructor(options: LiveChannelOptions) {
		this.throttleMs = options.throttleMs;
		this.send = options.send;
		this.now = options.now ?? Date.now;
	}

	/** Append a text delta to a card (coalesced + throttled). */
	patchDelta(cardId: string, delta: string): void {
		if (!delta) return;
		const state = this.getOrCreate(cardId);
		if (state.closed) return; // finalized — no more live updates
		state.pendingDelta += delta;
		this.scheduleFlush(cardId, state);
	}

	/** Replace card content (e.g. status field update). */
	patchContent(cardId: string, content: unknown): void {
		const state = this.getOrCreate(cardId);
		if (state.closed) return;
		state.pendingContent = content;
		this.scheduleFlush(cardId, state);
	}

	/**
	 * Settle a card: flush any pending deltas now, then mark it closed so no
	 * later patch can clobber the durable finalize pass (I10).
	 */
	async finalize(cardId: string): Promise<void> {
		const state = this.cards.get(cardId);
		if (!state) return;
		state.closed = true;
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		await this.flushNow(cardId, state);
	}

	/** Flush a card immediately (used by finalize). */
	async flushCard(cardId: string): Promise<void> {
		const state = this.cards.get(cardId);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		await this.flushNow(cardId, state);
	}

	async flushAll(): Promise<void> {
		for (const [id] of [...this.cards.entries()]) {
			await this.flushCard(id);
		}
	}

	stop(): void {
		for (const [, state] of this.cards) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.cards.clear();
	}

	private getOrCreate(cardId: string): CardState {
		let state = this.cards.get(cardId);
		if (!state) {
			state = {
				pendingDelta: "",
				pendingContent: undefined,
				lastSentAt: 0,
				timer: undefined,
				closed: false,
			};
			this.cards.set(cardId, state);
		}
		return state;
	}

	private scheduleFlush(cardId: string, state: CardState): void {
		if (state.timer) return;
		const wait = Math.max(0, this.throttleMs - (this.now() - state.lastSentAt));
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void this.flushNow(cardId, state);
		}, wait);
		state.timer.unref?.();
	}

	private async flushNow(cardId: string, state: CardState): Promise<void> {
		const patch: StreamPatch = { cardId };
		if (state.pendingDelta) {
			patch.delta = state.pendingDelta;
			state.pendingDelta = "";
		}
		if (state.pendingContent !== undefined) {
			patch.content = state.pendingContent;
			state.pendingContent = undefined;
		}
		if (!patch.delta && patch.content === undefined) return;
		state.lastSentAt = this.now();
		try {
			await this.send(patch);
		} catch {
			// Volatile by design: drop on failure, finalize will reconcile.
		}
	}
}
