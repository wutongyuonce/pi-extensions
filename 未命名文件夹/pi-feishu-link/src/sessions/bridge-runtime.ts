// Bridge runtime (spec §6.6 / M6): captures my-pi-scheduler markers from pi
// sessions and delivers results to the bound Feishu route via the outbox
// (kind=scheduled, at-least-once with delivery dedupe). Also tracks which
// sessions are "feishu inputs" to distinguish scheduled results from chat
// replies.

import type { Route, OutboundEnvelope } from "../common/types.js";

export interface ScheduledMarker {
	jobId: string;
	jobName?: string;
	mode?: string;
	output?: string;
	error?: string;
}

export interface BridgeRuntimeDeps {
	resolveJobRoute: (jobId: string) => Route | undefined;
	enqueue: (
		partial: Omit<
			OutboundEnvelope,
			"id" | "status" | "attempts" | "nextRetryAt" | "createdAt"
		>,
	) => Promise<unknown>;
	hasSent: (deliveryKey: string) => boolean;
	markSent: (deliveryKey: string) => void;
	bindJob?: (jobId: string, key: string, jobName?: string) => void;
}

export class BridgeRuntime {
	private readonly deps: BridgeRuntimeDeps;
	/** Bridge conversation keys with an in-flight prompt (C3: key-based tracking). */
	private readonly activeFeishuInputs = new Set<string>();
	private readonly pendingBySession = new Map<string, ScheduledMarker[]>();

	constructor(deps: BridgeRuntimeDeps) {
		this.deps = deps;
	}

	beginFeishuInput(key: string): void {
		this.activeFeishuInputs.add(key);
	}

	endFeishuInput(key: string): void {
		this.activeFeishuInputs.delete(key);
	}

	isFeishuInput(key: string): boolean {
		return this.activeFeishuInputs.has(key);
	}

	/**
	 * Handle a session message event. Returns true when it was consumed.
	 * - toolResult with toolName=schedule_prompt + action=add → bind jobs
	 * - custom message customType=scheduled_prompt → marker start
	 * - assistant message → deliver pending results for that session
	 */
	handleMessageEnd(
		sessionId: string,
		sessionKey: string | undefined,
		message: unknown,
	): boolean {
		const m = message as {
			role?: string;
			toolName?: string;
			customType?: string;
			details?: Record<string, unknown>;
			content?: unknown;
			id?: string;
			timestamp?: number;
		};
		if (!sessionId || !m) return false;
		if (m.role === "toolResult" && m.toolName === "schedule_prompt") {
			this.captureCreatedJobs(sessionKey, m);
			return true;
		}
		if (m.role === "custom" && m.customType === "scheduled_prompt") {
			void this.handleScheduledMarker(sessionId, m);
			return true;
		}
		if (m.role === "assistant") {
			void this.handleAssistantResult(sessionId, m);
			return true;
		}
		return false;
	}

	private captureCreatedJobs(
		sessionKey: string | undefined,
		message: { details?: Record<string, unknown> },
	): void {
		if (!sessionKey || !this.activeFeishuInputs.has(sessionKey)) return;
		const details = message.details ?? {};
		if (details.action !== "add") return;
		const jobs = Array.isArray(details.jobs)
			? (details.jobs as Array<{ id?: string; name?: string }>)
			: [];
		for (const job of jobs) {
			if (!job.id) continue;
			this.deps.bindJob?.(
				String(job.id),
				sessionKey,
				typeof job.name === "string" ? job.name : undefined,
			);
		}
	}

	private async handleScheduledMarker(
		sessionId: string,
		message: { details?: Record<string, unknown>; id?: string },
	): Promise<void> {
		const details = message.details ?? {};
		const jobId = typeof details.jobId === "string" ? details.jobId : "";
		if (!jobId) return;
		if (
			details.mode === "subagent_done" &&
			typeof details.output === "string"
		) {
			const route = this.deps.resolveJobRoute(jobId);
			if (route) {
				await this.deliverOnce(
					`subagent_done:${jobId}:${message.id ?? details.output}`,
					route,
					details.output,
				);
			}
			return;
		}
		if (
			details.mode === "subagent_error" &&
			typeof details.error === "string"
		) {
			const route = this.deps.resolveJobRoute(jobId);
			if (route) {
				await this.deliverOnce(
					`subagent_error:${jobId}:${message.id ?? details.error}`,
					route,
					`定时任务执行失败：${details.error}`,
				);
			}
			return;
		}
		const pending = this.pendingBySession.get(sessionId) ?? [];
		pending.push({
			jobId,
			jobName:
				typeof details.jobName === "string" ? details.jobName : undefined,
		});
		this.pendingBySession.set(sessionId, pending);
	}

	private async handleAssistantResult(
		sessionId: string,
		message: { content?: unknown; id?: string; timestamp?: number },
	): Promise<void> {
		const pending = this.pendingBySession.get(sessionId);
		const next = pending?.[0];
		if (!next) return;
		const route = this.deps.resolveJobRoute(next.jobId);
		if (!route) {
			pending?.shift();
			if (!pending?.length) this.pendingBySession.delete(sessionId);
			return;
		}
		const text = extractText(message.content);
		if (!text) return;
		const deliveryKey = `assistant:${next.jobId}:${message.id ?? message.timestamp ?? text}`;
		await this.deliverOnce(deliveryKey, route, text);
		pending?.shift();
		if (!pending?.length) this.pendingBySession.delete(sessionId);
	}

	private async deliverOnce(
		deliveryKey: string,
		route: Route,
		text: string,
	): Promise<void> {
		if (this.deps.hasSent(deliveryKey)) return;
		try {
			await this.deps.enqueue({
				dedupeKey: deliveryKey,
				laneKey: route.sessionKey,
				route: {
					conversationKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
				},
				kind: "scheduled",
				payload: { type: "text", text },
			});
			this.deps.markSent(deliveryKey);
		} catch {
			// Enqueue rejected (outbox cap) — do not mark sent, will retry next message.
		}
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: string }).type === "text"
				? ((p as { text?: string }).text ?? "")
				: "",
		)
		.join("")
		.trim();
}
