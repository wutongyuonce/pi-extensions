// Persistent reliable outbound queue (R1 core).
//
// Design (spec §6.5):
//  - JSONL segment files (~1MB each), append-only; crash-safe via per-line
//    appends and a durable status-patch log. Rebuilt into memory at boot.
//  - Per-lane parallel drains: laneKey = conversationKey, strict FIFO within
//    a lane, lanes independent (no cross-conversation head-of-line blocking).
//  - at-least-once + dedupeKey = effectively-once for re-enqueues.
//  - RetryableError → exponential backoff, never give up (only blocks its lane).
//  - FatalDeliveryError → terminal failed.
//  - Compaction keeps pending/sending + recent terminal records; enforces
//    capacity hard caps and a directory-size guard.
//
// No pi SDK dependency — sender is injected.

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { OutboundEnvelope, EnvelopeStatus } from "../common/types.js";

export class RetryableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetryableError";
	}
}

export class FatalDeliveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalDeliveryError";
	}
}

export class EnqueueRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnqueueRejectedError";
	}
}

export interface SendResult {
	messageId?: string;
}

export type Sender = (env: OutboundEnvelope) => Promise<SendResult>;

export interface OutboxLogger {
	debug(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, data?: Record<string, unknown>): void;
}

export interface OutboxOptions {
	dir: string;
	sender: Sender;
	maxAttemptsBeforeAlert: number;
	sentRetentionMs: number;
	maxPendingEnvelopes: number;
	maxEnvelopeBytes: number;
	maxOutboxDirBytes: number;
	compactIntervalMs: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	maxConcurrentLanes?: number;
	segmentMaxBytes?: number;
	onAlert?: (env: OutboundEnvelope, attempts: number) => void;
	onFatal?: (env: OutboundEnvelope, error: Error) => void;
	logger?: OutboxLogger;
}

const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 600_000;
const DEFAULT_MAX_LANES = 8;
const DEFAULT_SEGMENT_BYTES = 1024 * 1024;
const RETRY_SAFETY_SLEEP_MS = 1000;

interface SegmentRecord {
	op: "append" | "patch";
	env?: OutboundEnvelope;
	id?: string;
	status?: EnvelopeStatus;
	attempts?: number;
	nextRetryAt?: number;
	sentAt?: number;
	lastError?: string;
}

export interface OutboxSummary {
	pending: number;
	sending: number;
	sent: number;
	failed: number;
	lanes: number;
	bytes: number;
}

export class Outbox {
	private readonly dir: string;
	private readonly sender: Sender;
	private readonly maxAttemptsBeforeAlert: number;
	private readonly sentRetentionMs: number;
	private readonly maxPendingEnvelopes: number;
	private readonly maxEnvelopeBytes: number;
	private readonly maxOutboxDirBytes: number;
	private readonly compactIntervalMs: number;
	private readonly backoffBaseMs: number;
	private readonly backoffMaxMs: number;
	private readonly maxConcurrentLanes: number;
	private readonly segmentMaxBytes: number;
	private readonly onAlert?: (env: OutboundEnvelope, attempts: number) => void;
	private readonly onFatal?: (env: OutboundEnvelope, error: Error) => void;
	private readonly logger?: OutboxLogger;

	private envById = new Map<string, OutboundEnvelope>();
	private sentKeys = new Map<string, string>();
	private lanes = new Map<string, string[]>();
	private pumping = new Set<string>();
	private currentSegment: string | undefined;
	private closed = false;
	private compactTimer: NodeJS.Timeout | undefined;
	private activePumps = new Map<string, Promise<void>>();

	constructor(options: OutboxOptions) {
		this.dir = options.dir;
		this.sender = options.sender;
		this.maxAttemptsBeforeAlert = options.maxAttemptsBeforeAlert;
		this.sentRetentionMs = options.sentRetentionMs;
		this.maxPendingEnvelopes = options.maxPendingEnvelopes;
		this.maxEnvelopeBytes = options.maxEnvelopeBytes;
		this.maxOutboxDirBytes = options.maxOutboxDirBytes;
		this.compactIntervalMs = options.compactIntervalMs;
		this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
		this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.maxConcurrentLanes = options.maxConcurrentLanes ?? DEFAULT_MAX_LANES;
		this.segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_SEGMENT_BYTES;
		this.onAlert = options.onAlert;
		this.onFatal = options.onFatal;
		this.logger = options.logger;
	}

	/** Load segments, rebuild index, reset sending→pending, start drains + compactor. */
	async init(): Promise<number> {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const loaded = await this.rebuildFromDisk();
		this.closed = false;
		if (this.compactIntervalMs > 0) {
			this.compactTimer = setInterval(() => {
				void this.compact(Date.now());
			}, this.compactIntervalMs);
			this.compactTimer.unref?.();
		}
		// Resume any lanes with pending work.
		for (const laneKey of this.lanes.keys()) {
			if (this.lanes.get(laneKey)?.length) this.schedulePump(laneKey);
		}
		return loaded;
	}

	/** Persist + queue an envelope. Throws EnqueueRejectedError when over capacity. */
	async enqueue(
		partial: Omit<
			OutboundEnvelope,
			"id" | "status" | "attempts" | "nextRetryAt" | "createdAt"
		>,
	): Promise<OutboundEnvelope> {
		if (this.closed) throw new EnqueueRejectedError("outbox is closed");
		if (this.sentKeys.has(partial.dedupeKey)) {
			const existing = this.envById.get(this.sentKeys.get(partial.dedupeKey)!);
			if (existing) {
				this.logger?.debug("feishu.outbox.dedup_skip", {
					dedupeKey: partial.dedupeKey,
				});
				return existing;
			}
		}
		const pendingCount = this.countPending();
		if (pendingCount >= this.maxPendingEnvelopes) {
			throw new EnqueueRejectedError(
				`outbox pending cap reached (${this.maxPendingEnvelopes})`,
			);
		}
		const now = Date.now();
		const env: OutboundEnvelope = {
			...partial,
			id: genId(),
			status: "pending",
			attempts: 0,
			nextRetryAt: now,
			createdAt: now,
		};
		this.appendRecord({ op: "append", env: this.serializeEnv(env) });
		this.envById.set(env.id, env);
		const lane = this.lanes.get(env.laneKey) ?? [];
		lane.push(env.id);
		this.lanes.set(env.laneKey, lane);
		this.schedulePump(env.laneKey);
		this.logger?.debug("feishu.outbox.enqueued", {
			id: env.id,
			kind: env.kind,
			laneKey: env.laneKey,
		});
		return env;
	}

	summary(): OutboxSummary {
		let pending = 0;
		let sending = 0;
		let sent = 0;
		let failed = 0;
		for (const env of this.envById.values()) {
			if (env.status === "pending") pending++;
			else if (env.status === "sending") sending++;
			else if (env.status === "sent") sent++;
			else if (env.status === "failed") failed++;
		}
		return {
			pending,
			sending,
			sent,
			failed,
			lanes: this.lanes.size,
			bytes: dirBytes(this.dir),
		};
	}

	/** Wait until all lanes are idle (nothing pumping, nothing pending to send now). */
	async drainIdle(timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.pumping.size === 0 && this.countPending() === 0) return;
			await sleep(25);
		}
		throw new Error("outbox drainIdle timed out");
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.compactTimer) {
			clearInterval(this.compactTimer);
			this.compactTimer = undefined;
		}
		// Let in-flight sends settle briefly, then stop pumps by closing flag.
		await sleep(50);
	}

	/** Compaction: keep live + recent terminal, rewrite segments, enforce caps. */
	async compact(
		now: number = Date.now(),
	): Promise<{ kept: number; dropped: number }> {
		const cutoff = now - this.sentRetentionMs;
		const kept: OutboundEnvelope[] = [];
		const dropped: string[] = [];
		for (const env of this.envById.values()) {
			const terminalAt = env.sentAt ?? env.createdAt;
			const keep =
				env.status === "pending" ||
				env.status === "sending" ||
				((env.status === "sent" || env.status === "failed") &&
					terminalAt >= cutoff);
			if (keep) kept.push(env);
			else dropped.push(env.id);
		}
		for (const id of dropped) this.dropBlob(id);
		this.rewriteSegments(kept);
		this.rebuildSentKeys();
		let evicted = 0;
		const before = dirBytes(this.dir);
		if (before > this.maxOutboxDirBytes) {
			evicted = this.evictForDirGuard(cutoff);
		}
		this.logger?.debug("feishu.outbox.compacted", {
			kept: kept.length,
			dropped: dropped.length,
			evicted,
		});
		return { kept: kept.length, dropped: dropped.length + evicted };
	}

	getEnvelope(id: string): OutboundEnvelope | undefined {
		return this.envById.get(id);
	}

	hasSentKey(dedupeKey: string): boolean {
		return this.sentKeys.has(dedupeKey);
	}

	private countPending(): number {
		let n = 0;
		for (const env of this.envById.values()) {
			if (env.status === "pending" || env.status === "sending") n++;
		}
		return n;
	}

	private schedulePump(laneKey: string): void {
		if (this.closed) return;
		if (this.pumping.has(laneKey)) return;
		if (this.pumping.size >= this.maxConcurrentLanes) {
			// Respect the concurrency cap: retry soon.
			setTimeout(() => this.schedulePump(laneKey), 100).unref?.();
			return;
		}
		this.pumping.add(laneKey);
		const p = this.pumpLane(laneKey).finally(() => {
			this.pumping.delete(laneKey);
			this.activePumps.delete(laneKey);
			// Close the microtask race: a message enqueued right as the pump exited
			// may have skipped scheduling (pumping still had the lane). Re-check.
			if (!this.closed && (this.lanes.get(laneKey)?.length ?? 0) > 0) {
				this.schedulePump(laneKey);
			}
		});
		this.activePumps.set(laneKey, p);
	}

	private async pumpLane(laneKey: string): Promise<void> {
		while (!this.closed) {
			const lane = this.lanes.get(laneKey);
			const id = lane?.[0];
			if (!id) break;
			const env = this.envById.get(id);
			if (!env) {
				lane?.shift();
				continue;
			}
			// Terminal envelopes must never be re-sent (survive restart replay).
			if (env.status === "sent" || env.status === "failed") {
				lane!.shift();
				continue;
			}
			const now = Date.now();
			if (env.nextRetryAt > now) {
				await sleep(Math.min(env.nextRetryAt - now, RETRY_SAFETY_SLEEP_MS));
				continue;
			}
			lane!.shift();
			env.status = "sending";
			this.appendRecord({ op: "patch", id: env.id, status: "sending" });
			try {
				const result = await this.sender(env);
				env.status = "sent";
				env.sentAt = Date.now();
				env.lastError = undefined;
				this.appendRecord({
					op: "patch",
					id: env.id,
					status: "sent",
					sentAt: env.sentAt,
				});
				this.sentKeys.set(env.dedupeKey, env.id);
				this.logger?.debug("feishu.outbox.sent", {
					id: env.id,
					kind: env.kind,
					messageId: result.messageId,
					laneKey,
				});
			} catch (error) {
				if (error instanceof FatalDeliveryError) {
					env.status = "failed";
					env.lastError = error.message;
					this.appendRecord({
						op: "patch",
						id: env.id,
						status: "failed",
						lastError: error.message,
					});
					this.onFatal?.(env, error);
					this.logger?.error("feishu.outbox.fatal", {
						id: env.id,
						error: error.message,
					});
				} else {
					env.attempts += 1;
					env.lastError =
						error instanceof Error ? error.message : String(error);
					env.status = "pending";
					env.nextRetryAt = Date.now() + this.backoffMs(env.attempts);
					this.appendRecord({
						op: "patch",
						id: env.id,
						status: "pending",
						attempts: env.attempts,
						nextRetryAt: env.nextRetryAt,
						lastError: env.lastError,
					});
					if (env.attempts === this.maxAttemptsBeforeAlert) {
						this.onAlert?.(env, env.attempts);
						this.logger?.warn("feishu.outbox.alert", {
							id: env.id,
							attempts: env.attempts,
						});
					}
					// 2026-08-08（spec §3.1）：失败消息**移出 lane**，用定时器到点
					// 重新入队重试——不留在队列里阻塞后续消息（此前 unshift 回队头
					// + sleep 退避会卡死整个 lane，"发消息没回复"故障 F1）。牺牲
					// 严格 FIFO，换取会话可用性（飞书会话可接受乱序）。
					const retryMs = Math.max(1, env.nextRetryAt - Date.now());
					setTimeout(() => {
						if (this.closed) return;
						let lane = this.lanes.get(laneKey);
						if (!lane) {
							lane = [];
							this.lanes.set(laneKey, lane);
						}
						lane.push(env.id);
						this.schedulePump(laneKey);
					}, retryMs).unref?.();
				}
			}
		}
	}

	private backoffMs(attempts: number): number {
		return Math.min(
			this.backoffBaseMs * 2 ** (attempts - 1),
			this.backoffMaxMs,
		);
	}

	// ---- persistence ----

	private appendRecord(rec: SegmentRecord): void {
		try {
			this.ensureSegment();
			writeFileSync(this.currentSegment!, `${JSON.stringify(rec)}\n`, {
				flag: "a",
				encoding: "utf8",
			});
		} catch (error) {
			this.logger?.error("feishu.outbox.persist_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private ensureSegment(): void {
		const name = this.currentSegment;
		if (name) {
			try {
				if (statSync(name).size < this.segmentMaxBytes) return;
			} catch {
				/* missing → rotate */
			}
		}
		this.currentSegment = join(
			this.dir,
			`seg-${Date.now().toString(36)}.jsonl`,
		);
	}

	private async rebuildFromDisk(): Promise<number> {
		let count = 0;
		for (const file of segmentFiles(this.dir)) {
			try {
				const text = readFileSync(file, "utf8");
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					try {
						const rec = JSON.parse(line) as SegmentRecord;
						if (rec.op === "append" && rec.env) {
							this.envById.set(rec.env.id, {
								...rec.env,
								payload: this.hydratePayload(rec.env),
							});
							const lane = this.lanes.get(rec.env.laneKey) ?? [];
							lane.push(rec.env.id);
							this.lanes.set(rec.env.laneKey, lane);
							count++;
						} else if (rec.op === "patch" && rec.id) {
							const env = this.envById.get(rec.id);
							if (!env) continue;
							if (rec.status) env.status = rec.status;
							if (typeof rec.attempts === "number") env.attempts = rec.attempts;
							if (typeof rec.nextRetryAt === "number")
								env.nextRetryAt = rec.nextRetryAt;
							if (typeof rec.sentAt === "number") env.sentAt = rec.sentAt;
							if (typeof rec.lastError === "string")
								env.lastError = rec.lastError;
						}
					} catch {
						/* skip corrupt line */
					}
				}
			} catch {
				/* skip unreadable segment */
			}
		}
		// Crash recovery: sending → pending; drop payload from memory for terminal
		// records (dedupe only), hydrate payload for live ones.
		for (const env of this.envById.values()) {
			if (env.status === "sending") {
				env.status = "pending";
				env.nextRetryAt = Math.min(env.nextRetryAt, Date.now());
				this.appendRecord({
					op: "patch",
					id: env.id,
					status: "pending",
					nextRetryAt: env.nextRetryAt,
				});
			}
			if (env.status === "sent") this.sentKeys.set(env.dedupeKey, env.id);
			if (env.status === "sent" || env.status === "failed") {
				env.payload = undefined as never;
			}
		}
		return count;
	}

	private hydratePayload(env: OutboundEnvelope): OutboundEnvelope["payload"] {
		const ref = (env as unknown as { payloadRef?: string }).payloadRef;
		if (ref) {
			try {
				const blob = readFileSync(
					join(this.dir, "blobs", `${ref}.json`),
					"utf8",
				);
				return JSON.parse(blob) as OutboundEnvelope["payload"];
			} catch {
				return {
					type: "text",
					text: "(payload unavailable)",
				} as OutboundEnvelope["payload"];
			}
		}
		return env.payload;
	}

	private rewriteSegments(kept: OutboundEnvelope[]): void {
		const sorted = [...kept].sort((a, b) => a.createdAt - b.createdAt);
		const newFile = join(this.dir, `seg-${Date.now().toString(36)}-c.jsonl`);
		const lines: string[] = [];
		for (const env of sorted) {
			if (env.payload === undefined) {
				// Terminal record with no payload in memory: store patch-style line.
				lines.push(
					JSON.stringify({
						op: "patch",
						id: env.id,
						status: env.status,
						sentAt: env.sentAt,
						lastError: env.lastError,
					}),
				);
				continue;
			}
			const rec: SegmentRecord = { op: "append", env: this.serializeEnv(env) };
			lines.push(JSON.stringify(rec));
		}
		try {
			writeFileSync(
				newFile,
				lines.length ? `${lines.join("\n")}\n` : "",
				"utf8",
			);
			for (const file of segmentFiles(this.dir)) {
				if (file === newFile) continue;
				try {
					rmSync(file, { force: true });
				} catch {
					/* ignore */
				}
			}
			this.currentSegment = newFile;
			this.envById = new Map(sorted.map((e) => [e.id, e]));
		} catch (error) {
			this.logger?.error("feishu.outbox.compact_write_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private serializeEnv(env: OutboundEnvelope): OutboundEnvelope {
		const jsonSize = Buffer.byteLength(
			JSON.stringify({ ...env, payload: env.payload }),
			"utf8",
		);
		if (jsonSize <= this.maxEnvelopeBytes) return env;
		// Spill payload to blob file.
		const id = env.id;
		try {
			mkdirSync(join(this.dir, "blobs"), { recursive: true, mode: 0o700 });
			writeFileSync(
				join(this.dir, "blobs", `${id}.json`),
				JSON.stringify(env.payload),
				"utf8",
			);
		} catch {
			/* fall through to inline */
		}
		return {
			...env,
			payload: undefined as never,
			payloadRef: id,
		} as OutboundEnvelope;
	}

	private dropBlob(id: string): void {
		try {
			rmSync(join(this.dir, "blobs", `${id}.json`), { force: true });
		} catch {
			/* ignore */
		}
	}

	private rebuildSentKeys(): void {
		this.sentKeys.clear();
		for (const env of this.envById.values()) {
			if (env.status === "sent") this.sentKeys.set(env.dedupeKey, env.id);
		}
	}

	private evictForDirGuard(cutoff: number): number {
		// Evict oldest sent first, then oldest failed, until the directory is
		// back under the guard (bounded per run so a pathological backlog cannot
		// stall this forever). Pending records are never evicted.
		const evictable = [...this.envById.values()]
			.filter(
				(e) =>
					(e.status === "sent" || e.status === "failed") &&
					(e.sentAt ?? e.createdAt) >= cutoff,
			)
			.sort((a, b) => (a.sentAt ?? a.createdAt) - (b.sentAt ?? b.createdAt));
		let evicted = 0;
		for (const env of evictable) {
			if (evicted >= 1000) break;
			// Cheap progress check every 25 evictions (dirBytes is O(n)).
			if (evicted % 25 === 0 && dirBytes(this.dir) <= this.maxOutboxDirBytes) {
				break;
			}
			this.envById.delete(env.id);
			if (env.status === "sent") this.sentKeys.delete(env.dedupeKey);
			this.dropBlob(env.id);
			evicted++;
		}
		if (this.envById.size > 0) this.rewriteSegments([...this.envById.values()]);
		else this.clearSegments();
		if (dirBytes(this.dir) > this.maxOutboxDirBytes) {
			this.logger?.warn("feishu.outbox.dir_guard_alert", {
				bytes: dirBytes(this.dir),
			});
		}
		return evicted;
	}

	private clearSegments(): void {
		for (const file of segmentFiles(this.dir)) {
			try {
				rmSync(file, { force: true });
			} catch {
				/* ignore */
			}
		}
		this.currentSegment = undefined;
	}
}

function segmentFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith("seg-") && f.endsWith(".jsonl"))
			.sort()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

function dirBytes(dir: string): number {
	let total = 0;
	try {
		for (const f of readdirSync(dir, { recursive: true })) {
			const p = typeof f === "string" ? join(dir, f) : f;
			try {
				total += statSync(p).size;
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	return total;
}

function genId(): string {
	return `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
