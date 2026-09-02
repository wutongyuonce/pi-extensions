import test from "node:test";
import assert from "node:assert/strict";
import {
	formatStatusLine,
	statusDetailLines,
} from "../../../src/application/status-formatter.ts";
import type { StatusSnapshot } from "../../../src/common/types.ts";

const base: StatusSnapshot = {
	connState: "connected",
	reconnectCount: 3,
	inboundCount: 10,
	outboundCount: 8,
	outboxPending: 2,
	outboxFailed: 0,
	residentSessions: 2,
	maxResident: 8,
	schedulerDetected: false,
	boundJobs: 1,
	startedAt: 1_000_000,
};

test("formatStatusLine 含连接状态与运行时长（now 可注入）", () => {
	const line = formatStatusLine(base, () => 1_000_000 + 5 * 60_000);
	assert.match(line, /🟢 已连接/);
	assert.match(line, /5min/);
});

test("formatStatusLine 未知状态原样显示", () => {
	const line = formatStatusLine(
		{ ...base, connState: "weird" as never },
		() => 1_000_000,
	);
	assert.match(line, /weird/);
});

test("statusDetailLines 汇总入站/出站/积压/会话/任务", () => {
	const lines = statusDetailLines(base);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /入站 10 \/ 出站 8 \/ outbox 积压 2/);
	assert.match(lines[1]!, /重连 3 次 · 会话 2\/8/);
	assert.match(lines[2]!, /定时任务路由 1 个/);
});
