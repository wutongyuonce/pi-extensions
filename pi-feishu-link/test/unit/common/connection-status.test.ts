// TUI 状态行文本（2026-08-07）：setup/start 成功后刷新状态行，文本统一。

import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyConnectionStatus,
	connectionStatusText,
} from "../../../src/common/connection-status.ts";
import type { FeishuConfig } from "../../../src/common/types.ts";
import type { GatewayOwner } from "../../../src/host/gateway-lock.ts";

const cfg: FeishuConfig = {
	schemaVersion: 1,
	appId: "cli_x",
	appSecret: "s",
	domain: "feishu",
	autoStart: true,
	groupPolicy: "open",
	groupKeywords: [],
	groupAlsoOnReply: true,
	allowUsers: [],
	allowChats: [],
	admins: [],
	forward: {
		aiReply: { mode: "card" },
		streaming: { enabled: true, throttleMs: 800 },
		toolCalls: { mode: "summary" },
		reasoning: { mode: "off" },
		progress: { enabled: true },
		reactions: { enabled: true, emojis: ["THUMBSUP"], doneEmoji: "DONE" },
	},
	connection: {
		probeIntervalMs: 30_000,
		silenceSuspectMs: 1_200_000,
		reconnectBackoffMaxMs: 60_000,
		downReportEnabled: true,
	},
	turns: { turnTimeoutMs: 1_800_000, ackAfterMs: 15_000, queueWarnMs: 120_000 },
	sessions: { maxResident: 8, idleDisposeMs: 1_800_000 },
	outbox: {
		dir: "",
		maxAttemptsBeforeAlert: 8,
		sentRetentionMs: 604_800_000,
		maxPendingEnvelopes: 1000,
		maxEnvelopeBytes: 262_144,
		maxOutboxDirBytes: 52_428_800,
		compactIntervalMs: 3_600_000,
	},
	media: { maxAttachments: 4, maxTotalBytes: 31_457_280 },
	storage: { sessionRetentionDays: 0 },
	permissions: {
		policy: "relaxed",
		autoApprove: ["read"],
		approvalTimeoutMs: 300_000,
		sessionMemory: true,
	},
	notifications: { mergeWindowMs: 600_000 },
	logging: { level: "info" },
};

const owner: GatewayOwner = { pid: 12345, startedAt: 0, status: "connected" };

test("classifyConnectionStatus 四态", () => {
	assert.equal(
		classifyConnectionStatus(undefined, undefined, 1),
		"unconfigured",
	);
	assert.equal(
		classifyConnectionStatus(cfg, undefined, 1),
		"configured_stopped",
	);
	assert.equal(classifyConnectionStatus(cfg, owner, 1), "daemon_running");
	assert.equal(classifyConnectionStatus(cfg, owner, owner.pid), "self_running");
});

test("connectionStatusText 覆盖 setup 前/后与启动后", () => {
	assert.match(connectionStatusText(undefined, undefined, 1), /未配置/);
	assert.match(connectionStatusText(cfg, undefined, 1), /已配置，未运行/);
	assert.match(connectionStatusText(cfg, owner, 1), /daemon pid 12345/);
	assert.match(connectionStatusText(cfg, owner, owner.pid), /本进程持有/);
});
