import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDiagnostics,
	buildIssueMd,
	runDoctorChecks,
	sanitizeEvent,
} from "../../../src/common/diagnostics.ts";
import type { DiagnosticsInput } from "../../../src/common/diagnostics.ts";
import { DEFAULT_CONFIG } from "../../../src/common/config.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "feishu-link-diag-"));
}

function baseInput(
	overrides: Partial<DiagnosticsInput> = {},
): DiagnosticsInput {
	return {
		config: {
			...DEFAULT_CONFIG,
			appId: "cli_longsecretappid123456",
			appSecret: "super-secret-value",
			allowUsers: ["ou_abc123"],
			admins: ["ou_admin1"],
		},
		status: {
			connState: "connected",
			reconnectCount: 2,
			inboundCount: 10,
			outboundCount: 9,
			outboxPending: 0,
			outboxFailed: 0,
			residentSessions: 1,
			maxResident: 8,
			schedulerDetected: false,
			boundJobs: 0,
			startedAt: Date.now() - 60_000,
		},
		stateTransitions: [
			{ from: "disconnected", to: "connecting", ts: 1 },
			{ from: "connecting", to: "connected", ts: 2 },
		],
		recentEvents: [
			{
				ts: 1,
				level: "info",
				event: "feishu.conn.connected",
				data: { chatId: "oc_xyz" },
			},
			{
				ts: 2,
				level: "error",
				event: "feishu.outbox.fatal",
				data: { id: "env-1", lastError: "boom" },
			},
			{
				ts: 3,
				level: "info",
				event: "feishu.msg.received",
				data: { text: "a".repeat(200) },
			},
		],
		doctor: [],
		outboxPending: 0,
		outboxFailed: [],
		reproTrace: [{ event: "inbound", chatId: "oc_xyz", text: "hello" }],
		versions: {
			extension: "0.1.0",
			pi: "0.84.0",
			node: "v24.16.0",
			os: "linux",
			arch: "x64",
			sdk: "1.72.0",
			uptimeMs: 60_000,
			configSchema: 1,
		},
		includeContent: false,
		...overrides,
	};
}

test("sanitizeEvent hashes ids and truncates long content by default", () => {
	const ev = sanitizeEvent(
		{
			ts: 1,
			level: "info",
			event: "x",
			data: { chatId: "oc_xyz", text: "a".repeat(200) },
		},
		false,
	);
	const d = ev.data as Record<string, unknown>;
	assert.notEqual(d.chatId, "oc_xyz");
	assert.equal(String(d.chatId).length, 12);
	assert.ok(String(d.text).startsWith("["), "long content replaced by summary");
	assert.ok(!String(d.text).includes("a".repeat(200)));
});

test("sanitizeEvent keeps content when includeContent is true", () => {
	const ev = sanitizeEvent(
		{ ts: 1, level: "info", event: "x", data: { text: "hello world" } },
		true,
	);
	assert.equal((ev.data as Record<string, unknown>).text, "hello world");
});

test("buildDiagnostics produces all files, secrets masked, ids hashed", () => {
	const dir = tempDir();
	try {
		const result = buildDiagnostics(baseInput(), join(dir, "bundle"));
		assert.equal(result.files.length, 9);
		const cfg = JSON.parse(
			readFileSync(join(dir, "bundle", "config.json"), "utf8"),
		);
		assert.ok(!cfg.appSecret.includes("super-secret"));
		assert.ok(!cfg.appId.includes("longsecret"));
		assert.equal(cfg.allowUsers[0].length, 12);
		const events = readFileSync(join(dir, "bundle", "events.jsonl"), "utf8")
			.trim()
			.split("\n");
		assert.equal(events.length, 3);
		const first = JSON.parse(events[0]!);
		assert.notEqual(first.data.chatId, "oc_xyz");
		const trace = readFileSync(join(dir, "bundle", "repro-trace.jsonl"), "utf8")
			.trim()
			.split("\n");
		assert.ok(trace.length >= 1);
		const traceObj = JSON.parse(trace[0]!);
		assert.notEqual(traceObj.chatId, "oc_xyz");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ISSUE.md includes environment, doctor red items, and trace", () => {
	const input = baseInput();
	input.doctor = runDoctorChecks(input);
	const md = buildIssueMd(input);
	assert.ok(md.includes("## 问题描述"));
	assert.ok(md.includes("Extension: 0.1.0"));
	assert.ok(md.includes("Pi: 0.84.0"));
	const input2 = baseInput({
		status: { ...input.status, connState: "degraded" },
	});
	input2.doctor = runDoctorChecks(input2);
	const md2 = buildIssueMd(input2);
	assert.ok(md2.includes("⚠️ connection"));
});

test("doctor checks flag config and connection problems", () => {
	const good = runDoctorChecks(baseInput());
	assert.equal(good.find((c) => c.check === "config")?.status, "ok");
	assert.equal(good.find((c) => c.check === "connection")?.status, "ok");

	const bad = runDoctorChecks(
		baseInput({
			config: { ...DEFAULT_CONFIG },
			status: {
				...baseInput().status,
				connState: "degraded",
				lastProbeOk: false,
			},
			outboxPending: 9,
		}),
	);
	assert.equal(bad.find((c) => c.check === "config")?.status, "error");
	assert.equal(bad.find((c) => c.check === "connection")?.status, "warn");
	assert.equal(bad.find((c) => c.check === "outbox")?.status, "error");
});

test("outbox summary excludes payload, hashes ids", () => {
	const dir = tempDir();
	try {
		const input = baseInput({
			outboxFailed: [
				{
					id: "env-1",
					kind: "final",
					laneKey: "ou_owner1",
					attempts: 9,
					lastError: "429 too many requests",
					createdAt: Date.now(),
				},
			],
		});
		buildDiagnostics(input, join(dir, "b"));
		const summary = JSON.parse(
			readFileSync(join(dir, "b", "outbox-summary.json"), "utf8"),
		);
		assert.equal(summary.failed.length, 1);
		assert.notEqual(summary.failed[0].laneKey, "ou_owner1");
		assert.equal(summary.failed[0].lastError, "429 too many requests");
		assert.equal(summary.failed[0].kind, "final");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rebuild clears stale files from a previous bundle", () => {
	const dir = tempDir();
	try {
		const bundleDir = join(dir, "b");
		buildDiagnostics(baseInput(), bundleDir);
		writeFileSync(join(bundleDir, "stale.txt"), "x");
		buildDiagnostics(baseInput(), bundleDir);
		assert.equal(existsSync(join(bundleDir, "stale.txt")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
