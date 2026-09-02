// Missed-message compensation (spec §12 开放问题 #2/#4 落地): when the WS
// reconnects after an outage, Feishu does not replay missed events. This
// module lists recent messages per known chat and re-injects any that the
// dedupe store has not seen. Best-effort — requires the "read chat history"
// permission scope, and is bounded by lookback + page size to avoid floods.

import type { FeishuInboundMessage } from "../common/types.js";

export interface CompensationOptions {
	enabled: boolean;
	/** How far back to scan after recovery. Default 5 minutes. */
	lookbackMs: number;
	/** Max messages pulled per chat. */
	maxPerChat: number;
	/** Only compensate when the outage lasted at least this long. */
	minOutageMs: number;
}

export const DEFAULT_COMPENSATION: CompensationOptions = {
	enabled: true,
	lookbackMs: 5 * 60 * 1000,
	maxPerChat: 50,
	minOutageMs: 5_000,
};

export interface CompensationDeps {
	listChatMessages: (
		chatId: string,
		opts: { startTimeMs?: number },
	) => Promise<Array<Record<string, unknown>>>;
	knownChatIds: () => string[];
	admitMessage: (messageId: string) => boolean;
	/** opts.skipDedupe tells the inbound pipeline the message is already admitted (C2). */
	onMessage: (
		msg: FeishuInboundMessage,
		opts?: { skipDedupe?: boolean },
	) => Promise<void>;
	normalize: (raw: Record<string, unknown>) => FeishuInboundMessage | undefined;
	now?: () => number;
	logger?: {
		info(event: string, data?: Record<string, unknown>): void;
		warn(event: string, data?: Record<string, unknown>): void;
	};
}

export class MissedMessageCompensation {
	private readonly deps: CompensationDeps;
	private readonly options: CompensationOptions;
	private readonly now: () => number;

	constructor(
		deps: CompensationDeps,
		options: Partial<CompensationOptions> = {},
	) {
		this.deps = deps;
		this.options = { ...DEFAULT_COMPENSATION, ...options };
		this.now = deps.now ?? Date.now;
	}

	/** Run compensation; returns the number of recovered messages injected. */
	async compensate(downMs: number): Promise<number> {
		if (!this.options.enabled) return 0;
		if (downMs < this.options.minOutageMs) return 0;
		const now = this.now();
		const startTime = now - this.options.lookbackMs;
		let recovered = 0;
		for (const chatId of this.deps.knownChatIds()) {
			let items: Array<Record<string, unknown>>;
			try {
				items = await this.deps.listChatMessages(chatId, {
					startTimeMs: startTime,
				});
			} catch (err) {
				this.deps.logger?.warn("feishu.compensation.list_failed", {
					chatId,
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			for (const raw of items.slice(0, this.options.maxPerChat)) {
				const msg = this.deps.normalize(raw);
				if (!msg) continue;
				if (msg.senderType === "bot") continue;
				// Admit-first = skip messages the WS already delivered; then inject
				// with skipDedupe so handleInbound does not drop them as duplicates.
				if (!this.deps.admitMessage(msg.messageId)) continue;
				try {
					await this.deps.onMessage(msg, { skipDedupe: true });
					recovered++;
				} catch (err) {
					this.deps.logger?.warn("feishu.compensation.inject_failed", {
						messageId: msg.messageId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
		if (recovered > 0) {
			this.deps.logger?.info("feishu.compensation.recovered", {
				count: recovered,
			});
		}
		return recovered;
	}
}
