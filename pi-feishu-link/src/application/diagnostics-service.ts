// DDD 应用层（spec 2026-08-08-1700 Step 5）：诊断服务——exportDiagnostics /
// sendDiagnosticsBundle 从 index.ts 迁出（依赖注入，可单测）。

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { FeishuConfig, FeishuInboundMessage } from "../common/types.js";
import type { StatusStore } from "../common/status.js";
import type { Logger } from "../common/logger.js";
import type { Outbox } from "../outbound/outbox.js";
import type { OutboundRouter } from "../outbound/outbound-router.js";
import type { FeishuTransport } from "../inbound/transport.js";
import {
	runDoctorChecks,
	buildDiagnostics,
	type DiagnosticsInput,
} from "../common/diagnostics.js";
import { DEFAULT_CONFIG } from "../common/config.js";
import { probeGroupMessagePermission } from "../inbound/permission-probe.js";

export interface DiagnosticsDeps {
	cfg(): FeishuConfig | undefined;
	statusStore: StatusStore;
	logger: Logger;
	outbox?: Outbox;
	router: OutboundRouter;
	transport?: FeishuTransport;
	rootDir(): string;
	conversationKeyFor(msg: FeishuInboundMessage): string;
	replyTo(
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void>;
	notifyConversation(key: string, text: string): Promise<void>;
}

/**
 * 生成脱敏诊断包；Feishu 触发时作为文件发回会话（I2，spec §6.17/§9.6）。
 */
export async function exportDiagnostics(
	deps: DiagnosticsDeps,
	msg?: FeishuInboundMessage,
	cardKey?: string,
): Promise<void> {
	const cfg = deps.cfg();
	const outDir = deps.rootDir() + "/diag-" + Date.now();
	const input: DiagnosticsInput = {
		config: cfg ?? DEFAULT_CONFIG,
		status: deps.statusStore.get(),
		stateTransitions: deps.statusStore.transitionsLog(),
		recentEvents: deps.logger.recent?.(500) ?? [],
		doctor: [],
		outboxPending: deps.outbox?.summary().pending ?? 0,
		outboxFailed: [],
		reproTrace: [],
		versions: {
			extension: "0.2.0",
			pi: process.env.PI_VERSION ?? "unknown",
			node: process.version,
			os: process.platform,
			arch: process.arch,
			sdk: "lark-node-sdk",
			uptimeMs: Date.now() - (deps.statusStore.get().startedAt ?? Date.now()),
			configSchema: cfg?.schemaVersion ?? 1,
		},
		includeContent: false,
	};
	// Permission self-check: group open policy needs "获取群组中所有消息".
	if (deps.transport) {
		const perm = await probeGroupMessagePermission({
			listMessages: (chatId: string, opts: { startTimeMs: number }) =>
				deps.transport!.listMessages(chatId, opts),
			groupChatIds: () => Object.keys(deps.router.routesSnapshot()),
		});
		input.doctor.push({
			check: "group-read-permission",
			status:
				perm.status === "ok"
					? "ok"
					: perm.status === "missing"
						? "error"
						: "warn",
			detail: perm.detail,
		});
	}
	input.doctor = runDoctorChecks(input);
	const result = buildDiagnostics(input, outDir);
	deps.logger.info("feishu.diagnostics.built", {
		files: result.files.length,
		bytes: result.bytes,
	});
	const summary = `诊断包已生成（${Math.round(result.bytes / 1024)}KB，${result.files.length} 个文件）：\n\`${outDir}\``;
	// I2: deliver the bundle as a FILE to the requesting chat.
	if (msg) {
		await deps.replyTo(msg, summary);
		await sendDiagnosticsBundle(deps, outDir, {
			conversationKey: deps.conversationKeyFor(msg),
			chatId: msg.chatId,
			chatType: msg.chatType,
			threadMessageId: msg.messageId,
		});
	} else if (cardKey) {
		const route = deps.router.getRoute(cardKey);
		if (route)
			await sendDiagnosticsBundle(deps, outDir, {
				conversationKey: route.sessionKey,
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
			});
		else deps.logger.info("feishu.diagnostics.local", { outDir });
	} else {
		deps.logger.info("feishu.diagnostics.local", { outDir });
	}
}

/** I2: tar the bundle and send it via the outbox media lane (≤20MB). */
export async function sendDiagnosticsBundle(
	deps: DiagnosticsDeps,
	outDir: string,
	route: {
		conversationKey: string;
		chatId: string;
		chatType: "p2p" | "group";
		threadMessageId?: string;
	},
): Promise<void> {
	if (!deps.outbox) return;
	try {
		const tarPath = `${outDir}.tar.gz`;
		execFileSync(
			"tar",
			["-czf", tarPath, "-C", deps.rootDir(), basename(outDir)],
			{ stdio: "ignore" },
		);
		const { readFileSync, statSync } = await import("node:fs");
		const st = statSync(tarPath);
		if (st.size > 20 * 1024 * 1024) {
			await deps.notifyConversation(
				route.conversationKey,
				"诊断包超过 20MB，未发送。可本地 /feishu doctor 查看。",
			);
			return;
		}
		await deps.outbox.enqueue({
			dedupeKey: `diag:${Date.now()}`,
			laneKey: route.conversationKey,
			route: {
				conversationKey: route.conversationKey,
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
			},
			kind: "media",
			payload: {
				type: "media",
				fileType: 4,
				fileData: readFileSync(tarPath).toString("base64"),
				fileName: basename(tarPath),
			},
		});
	} catch (err) {
		deps.logger.info("feishu.diagnostics.send_failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
