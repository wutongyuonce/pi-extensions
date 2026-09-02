// Notification throttler: merges same-type notifications within a window so
// a flapping connection can't spam the user. info/warn are mergeable (first
// one goes out, rest collapse into a window-end summary); critical goes
// through immediately. Injected clock for tests.

import type { NotificationEvent } from "../common/types.js";

export interface ThrottlerOptions {
	mergeWindowMs: number;
	now?: () => number;
	onSend?: (events: NotificationEvent[], summary?: string) => void;
}

interface WindowState {
	first: NotificationEvent;
	total: number;
	timer: NodeJS.Timeout;
}

export class NotificationThrottler {
	private readonly mergeWindowMs: number;
	private readonly now: () => number;
	private readonly onSend?: (
		events: NotificationEvent[],
		summary?: string,
	) => void;
	private readonly windows = new Map<string, WindowState>();
	private lastFlushAt: number;

	constructor(options: ThrottlerOptions) {
		this.mergeWindowMs = options.mergeWindowMs;
		this.now = options.now ?? Date.now;
		this.onSend = options.onSend;
		this.lastFlushAt = -options.mergeWindowMs - 1;
	}

	/** Submit a notification; critical bypasses merging. */
	submit(notification: NotificationEvent): void {
		if (notification.severity === "critical") {
			this.onSend?.([notification]);
			return;
		}
		const existing = this.windows.get(notification.type);
		if (existing) {
			existing.total += 1;
			return;
		}
		// First of type goes out immediately (spec §6.16).
		this.onSend?.([notification]);
		const window: WindowState = {
			first: notification,
			total: 1,
			timer: undefined as unknown as NodeJS.Timeout,
		};
		window.timer = setTimeout(() => {
			this.windows.delete(notification.type);
			if (window.total > 1) {
				const summary = `过去 ${Math.round(this.mergeWindowMs / 1000)} 秒内同类事件共 ${window.total} 次（${notification.type}）`;
				this.onSend?.([window.first], summary);
			}
		}, this.mergeWindowMs);
		window.timer.unref?.();
		this.windows.set(notification.type, window);
	}

	/** Force-flush pending windows (e.g. on shutdown). */
	flush(): void {
		const now = this.now();
		if (now - this.lastFlushAt < this.mergeWindowMs && this.windows.size > 0)
			return;
		this.lastFlushAt = now;
		for (const [type, window] of [...this.windows.entries()]) {
			clearTimeout(window.timer);
			this.windows.delete(type);
			if (window.total > 1) {
				const summary = `过去 ${Math.round(this.mergeWindowMs / 1000)} 秒内同类事件共 ${window.total} 次（${type}）`;
				this.onSend?.([window.first], summary);
			}
		}
	}

	pendingWindows(): number {
		return this.windows.size;
	}

	stop(): void {
		for (const [, window] of this.windows) clearTimeout(window.timer);
		this.windows.clear();
	}
}
