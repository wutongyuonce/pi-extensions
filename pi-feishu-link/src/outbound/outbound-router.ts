// Outbound router: persistent conversation/job → Feishu chat/thread routes,
// plus at-least-once delivery dedupe for scheduled results (30d TTL).
// No pi SDK dependency.

import { readJson, writeJson } from "../common/config.js";
import type { FeishuInboundMessage, Route } from "../common/types.js";

export const DELIVERY_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Job routes are forgotten after this long (M9: prevent unbounded growth). */
export const JOB_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface JobRoute extends Route {
	jobId: string;
	jobName?: string;
	createdAt: number;
	updatedAt: number;
}

interface BridgeState {
	version: number;
	routes: Record<string, Route>;
	jobs: Record<string, JobRoute>;
	sent: Record<string, number>;
}

const DEFAULT_STATE: BridgeState = {
	version: 1,
	routes: {},
	jobs: {},
	sent: {},
};

export class OutboundRouter {
	private state: BridgeState;
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.state = readJson<BridgeState>(filePath, DEFAULT_STATE);
		this.state.version ||= 1;
		this.state.routes ||= {};
		this.state.jobs ||= {};
		this.state.sent ||= {};
		this.pruneJobs();
		this.pruneSent();
	}

	private persist(): void {
		try {
			writeJson(this.filePath, this.state);
		} catch {
			// Persistence failure must not break delivery decisions.
		}
	}

	bindConversation(
		key: string,
		msg: FeishuInboundMessage,
		sessionId?: string,
	): Route {
		const previous = this.state.routes[key];
		const route: Route = {
			sessionKey: key,
			sessionId: sessionId || previous?.sessionId,
			chatId: msg.chatId,
			chatType: msg.chatType,
			threadMessageId: this.routeThreadMessageId(msg, previous),
			lastMessageId: msg.messageId,
			updatedAt: Date.now(),
		};
		this.state.routes[key] = route;
		this.persist();
		return route;
	}

	attachSession(key: string, sessionId: string): void {
		const route = this.state.routes[key];
		if (!route || route.sessionId === sessionId) return;
		this.state.routes[key] = { ...route, sessionId, updatedAt: Date.now() };
		this.persist();
	}

	getRoute(key: string): Route | undefined {
		return this.state.routes[key];
	}

	bindJob(
		jobId: string,
		key: string,
		jobName?: string,
		sessionId?: string,
	): JobRoute | undefined {
		const route = this.state.routes[key];
		if (!route) return undefined;
		const job: JobRoute = {
			...route,
			sessionId: sessionId || route.sessionId,
			jobId,
			jobName,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.state.jobs[jobId] = job;
		this.persist();
		return job;
	}

	getJob(jobId: string): JobRoute | undefined {
		return this.state.jobs[jobId];
	}

	/** Resolve a destination by conversation key or job id. */
	resolve(keyOrJobId: string): Route | undefined {
		return this.state.routes[keyOrJobId] ?? this.state.jobs[keyOrJobId];
	}

	/** Snapshot of all conversation routes (for notifications). */
	routesSnapshot(): Record<string, Route> {
		return { ...this.state.routes };
	}

	boundJobCount(): number {
		return Object.keys(this.state.jobs).length;
	}

	hasSent(deliveryKey: string): boolean {
		const ts = this.state.sent[deliveryKey];
		if (ts === undefined) return false;
		return Date.now() - ts <= DELIVERY_SENT_TTL_MS;
	}

	markSent(deliveryKey: string): void {
		this.state.sent[deliveryKey] = Date.now();
		this.pruneSent();
		this.persist();
	}

	pruneSent(): void {
		const cutoff = Date.now() - DELIVERY_SENT_TTL_MS;
		for (const [key, ts] of Object.entries(this.state.sent)) {
			if (ts < cutoff) delete this.state.sent[key];
		}
	}

	/** Forget stale job bindings (M9). */
	pruneJobs(): void {
		const cutoff = Date.now() - JOB_TTL_MS;
		for (const [id, job] of Object.entries(this.state.jobs)) {
			if (job.updatedAt < cutoff) delete this.state.jobs[id];
		}
	}

	private routeThreadMessageId(
		msg: FeishuInboundMessage,
		previous?: Route,
	): string | undefined {
		if (msg.rootId || msg.parentId) return msg.rootId || msg.parentId;
		if (previous?.threadMessageId) return previous.threadMessageId;
		if (msg.threadId || msg.chatMode === "topic") return msg.messageId;
		return undefined;
	}
}
