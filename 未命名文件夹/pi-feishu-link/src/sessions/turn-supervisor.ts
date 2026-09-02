// Turn supervisor: per-conversation watchdog that prevents silent hangs —
// the "发了消息没反应" root cause. Detects a turn running past its timeout
// (abort + notify + queue unlock), slow-turns needing an ack, and messages
// waiting in queue too long. Injected clock for deterministic tests.

export interface TurnCallbacks {
	/** Called once when the turn exceeds timeoutMs. */
	onTimeout(key: string, elapsedMs: number): Promise<void> | void;
	/** Called once when the turn exceeds ackAfterMs ("still processing"). */
	onAck(key: string, elapsedMs: number): Promise<void> | void;
	/** Called once when a queued message waits longer than queueWarnMs. */
	onQueueWarn(key: string, queuedMs: number): Promise<void> | void;
}

export interface TurnOptions {
	tickIntervalMs?: number;
	now?: () => number;
}

interface ActiveTurn {
	key: string;
	startedAt: number;
	timeoutMs: number;
	ackAfterMs: number;
	ackSent: boolean;
	timedOut: boolean;
}

export class TurnSupervisor {
	private readonly active = new Map<string, ActiveTurn>();
	private readonly queued = new Map<string, number>();
	private readonly callbacks: TurnCallbacks;
	private readonly tickIntervalMs: number;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;

	constructor(callbacks: TurnCallbacks, options: TurnOptions = {}) {
		this.callbacks = callbacks;
		this.tickIntervalMs = options.tickIntervalMs ?? 10_000;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	beginTurn(key: string, timeoutMs: number, ackAfterMs: number): void {
		const existing = this.active.get(key);
		if (existing) {
			// A turn is already running for this key — the new message will queue.
			return;
		}
		this.active.set(key, {
			key,
			startedAt: this.now(),
			timeoutMs,
			ackAfterMs,
			ackSent: false,
			timedOut: false,
		});
	}

	/** Mark the message as queued behind an active turn. */
	markQueued(key: string): void {
		if (!this.queued.has(key)) this.queued.set(key, this.now());
	}

	/** Clear queue-warning state after a message starts processing. */
	dequeue(key: string): void {
		this.queued.delete(key);
	}

	endTurn(key: string): void {
		this.active.delete(key);
		this.queued.delete(key);
	}

	isTurnActive(key: string): boolean {
		return this.active.has(key);
	}

	activeCount(): number {
		return this.active.size;
	}

	getActive(key: string): { startedAt: number; timedOut: boolean } | undefined {
		const t = this.active.get(key);
		return t ? { startedAt: t.startedAt, timedOut: t.timedOut } : undefined;
	}

	async tick(now: number = this.now()): Promise<void> {
		for (const [key, turn] of [...this.active.entries()]) {
			const elapsed = now - turn.startedAt;
			if (!turn.timedOut && elapsed >= turn.timeoutMs) {
				turn.timedOut = true;
				await this.callbacks.onTimeout(key, elapsed);
				// The turn is aborted; keep it in the map (timedOut) so queue
				// warnings don't fire for it, and let endTurn clear it.
			} else if (
				!turn.ackSent &&
				turn.ackAfterMs > 0 &&
				elapsed >= turn.ackAfterMs
			) {
				turn.ackSent = true;
				await this.callbacks.onAck(key, elapsed);
			}
		}
		for (const [key, queuedAt] of [...this.queued.entries()]) {
			const waited = now - queuedAt;
			if (waited >= 0 && this.active.has(key)) {
				await this.callbacks.onQueueWarn(key, waited);
				this.queued.delete(key);
			}
		}
	}
}
