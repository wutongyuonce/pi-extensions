import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionSupervisor } from "../../../src/inbound/connection-supervisor.ts";
import { QuotaGovernor } from "../../../src/common/quota-governor.ts";
import type { ConnState } from "../../../src/common/types.ts";
import type {
	SupervisorTransport,
	ConnectionSupervisorOptions,
} from "../../../src/inbound/connection-supervisor.ts";

class FakeTransport implements SupervisorTransport {
	startCalls = 0;
	stopCalls = 0;
	probeOk = true;
	probeCalls = 0;
	failStart = false;
	started = false;
	wsConnected = true;

	async start(): Promise<void> {
		this.startCalls++;
		if (this.failStart) throw new Error("start failed");
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopCalls++;
		this.started = false;
	}
	async probe(): Promise<{ ok: boolean; latencyMs: number }> {
		this.probeCalls++;
		return { ok: this.probeOk, latencyMs: 42 };
	}
	/** 模拟 WS 是否握手成功（2026-08-07 加固） */
	isConnected(): boolean {
		return this.started && this.wsConnected;
	}
}

function makeSupervisor(
	transport: FakeTransport,
	overrides: Partial<ConnectionSupervisorOptions> = {},
) {
	let now = 0;
	const states: Array<{ state: ConnState; detail?: string }> = [];
	const events: { onRecovered: number[]; onDownReport: number[] } = {
		onRecovered: [],
		onDownReport: [],
	};
	const sup = new ConnectionSupervisor({
		transport,
		tickIntervalMs: 15_000,
		probeIntervalMs: 1_000,
		silenceSuspectMs: 5_000,
		reconnectBackoffBaseMs: 10,
		reconnectBackoffMaxMs: 50,
		downReportEnabled: true,
		onStateChange: (state: ConnState, detail?: string) =>
			states.push({ state, detail }),
		onRecovered: (ms: number) => {
			events.onRecovered.push(ms);
		},
		onDownReport: (ms: number) => {
			events.onDownReport.push(ms);
		},
		now: () => now,
		...overrides,
	});
	return {
		sup,
		transport,
		states,
		events,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("start connects and reaches connected", async () => {
	const t = new FakeTransport();
	const { sup } = makeSupervisor(t);
	await sup.start();
	assert.equal(t.startCalls, 1);
	assert.equal(sup.getState(), "connected");
	await sup.stop();
});

test("connect failure → degraded, then backoff retries until connected", async () => {
	const t = new FakeTransport();
	t.failStart = true;
	const { sup, states } = makeSupervisor(t);
	await sup.start();
	assert.equal(sup.getState(), "degraded");
	// Wait out the backoff retry (base 10ms → retry).
	t.failStart = false;
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(sup.getState(), "connected");
	assert.ok(states.some((s) => s.state === "degraded"));
	await sup.stop();
});

test("event silence + probe 健康 → 不重建（2026-08-08：空闲 20min 误判修复）", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	const startCalls = t.startCalls;
	assert.equal(sup.getState(), "connected");
	// 先让 probe 跑一次（心跳确认连接健康）
	advance(1_000);
	await sup.tick();
	assert.equal(t.probeCalls, 1);
	// 静默超过阈值 + probe 健康 → 不重建（连接活着，只是没人说话）
	advance(5_000); // now=6000, beyond silenceSuspectMs (5000)
	await sup.tick();
	assert.equal(
		t.startCalls,
		startCalls,
		"probe 健康时静默不触发重建（连接活着，只是没人说话）",
	);
	await sup.stop();
});

test("event silence + probe 失败 → 重建（真断连才重启）", async () => {
	const t = new FakeTransport();
	t.probeOk = false; // 网络/服务端真断
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	const startCalls = t.startCalls;
	advance(1_000);
	await sup.tick(); // probe #1 fail
	advance(1_000);
	await sup.tick(); // probe #2 fail
	advance(4_000); // beyond silenceSuspectMs
	await sup.tick();
	assert.ok(t.startCalls > startCalls, "probe 持续失败 + 静默 → 应重建");
	await sup.stop();
});

test("events reset the silence timer (no rebuild while active)", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	const startCalls = t.startCalls;
	for (let i = 0; i < 5; i++) {
		advance(4_000);
		sup.recordEvent();
		await sup.tick();
	}
	assert.equal(t.startCalls, startCalls);
	await sup.stop();
});

test("probe failures degrade after threshold, probe recovery restores", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	assert.equal(sup.getState(), "connected");
	t.probeOk = false;
	// probeIntervalMs = 1000; tick at 1s, 2s, 3s → 3 failures → degraded
	advance(1_000);
	await sup.tick();
	advance(1_000);
	await sup.tick();
	advance(1_000);
	await sup.tick();
	assert.equal(sup.getState(), "degraded");
	// recovery
	t.probeOk = true;
	advance(1_000);
	await sup.tick();
	assert.equal(sup.getState(), "connected");
	await sup.stop();
});

test("down report fires after 5+ consecutive connect failures, once", async () => {
	const t = new FakeTransport();
	t.failStart = true;
	const { sup, events } = makeSupervisor(t, { downReportEnabled: true });
	await sup.start();
	assert.equal(sup.getState(), "degraded");
	// Each backoff retry fails; after 5 attempts onDownReport fires.
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(events.onDownReport.length, 1);
	await sup.stop();
});

test("recovery via event after restart emits onRecovered with down duration", async () => {
	const t = new FakeTransport();
	const { sup, advance, events } = makeSupervisor(t);
	await sup.start();
	// Force a silence rebuild → connect success triggers recovery notification.
	advance(6_000);
	await sup.tick();
	assert.ok(t.startCalls >= 2);
	assert.ok(events.onRecovered.length >= 1, "recovery reported after rebuild");
	await sup.stop();
});

test("tick is a no-op when stopped", async () => {
	const t = new FakeTransport();
	const { sup } = makeSupervisor(t);
	await sup.stop();
	const startCalls = t.startCalls;
	await sup.tick();
	assert.equal(t.startCalls, startCalls);
});

test("熔断后 tick 静默重启被门禁拦截：不发起真实连接烧配额（2026-08-08 修复）", async () => {
	const t = new FakeTransport();
	t.failStart = true; // 连接总是失败
	const tmpDir = mkdtempSync(join(tmpdir(), "qg-test-"));
	const { sup, advance, states } = makeSupervisor(t, {
		governor: new QuotaGovernor({
			dir: tmpDir,
			maxFailures: 2,
			windowMs: 60_000,
		}),
		silenceRestartCooldownMs: 0, // 关闭冷却，单独验证熔断门禁
		wsHandshakeTimeoutMs: 40,
		reconnectBackoffBaseMs: 10,
		reconnectBackoffMaxMs: 30,
	});
	await sup.start();
	// 退避重试跑完：第 2 次失败触发熔断（maxFailures=2）
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(sup.getState(), "degraded");
	assert.ok(
		states.some((s) => s.detail?.includes("配额熔断")),
		"应进入配额熔断 degraded 状态",
	);
	const calls = t.startCalls;
	// 模拟 tick 静默重启（旧代码：无视熔断每 15s 发起连接烧配额）
	advance(6_000);
	await sup.tick();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(t.startCalls, calls, "熔断窗口内 tick 不得再发起真实连接");
	await sup.stop();
});

test("silence 重启有冷却：触发后短时间 tick 不重复重建（2026-08-08 修复）", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t, {
		silenceSuspectMs: 5_000,
		silenceRestartCooldownMs: 60_000,
	});
	await sup.start();
	const calls = t.startCalls;
	advance(60_000); // 跨过首次冷却窗口
	await sup.tick(); // 触发 silence 重启 #1
	assert.equal(t.startCalls, calls + 1);
	// 冷却期内再次 silence → 不得重复重启
	advance(6_000);
	await sup.tick();
	assert.equal(t.startCalls, calls + 1, "冷却期内不得重复重启");
	// 跨过冷却后允许再次重启
	advance(60_000);
	await sup.tick();
	assert.equal(t.startCalls, calls + 2, "冷却期后可再次重启");
	await sup.stop();
});

test("WS 握手未完成（isConnected=false）→ 进入退化并计划重试（2026-08-07 加固）", async () => {
	const t = new FakeTransport();
	// 模拟 start() 成功但 WS 握手失败（如连接配额受限）
	t.wsConnected = false;
	const sup = makeSupervisor(t, {
		wsHandshakeTimeoutMs: 40,
		reconnectBackoffBaseMs: 20,
		reconnectBackoffMaxMs: 40,
	});
	await sup.sup.start();
	// 握手超时后 connect() 应走 catch → degraded + 计划重试（startCalls 继续增长）
	const callsAfterStart = t.startCalls;
	assert.ok(callsAfterStart >= 1, "start 至少被调用一次");
	await new Promise((r) => setTimeout(r, 120));
	assert.ok(
		t.startCalls > callsAfterStart,
		"握手失败后应自动重试（startCalls 增长）",
	);
});
