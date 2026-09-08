import test from "node:test";
import assert from "node:assert/strict";
import { TurnSupervisor } from "../../../src/sessions/turn-supervisor.ts";

interface TurnCall {
	key: string;
	ms: number;
}

interface CallLog {
	onTimeout: TurnCall[];
	onAck: TurnCall[];
	onQueueWarn: TurnCall[];
}

function makeSupervisor() {
	let now = 0;
	const calls: CallLog = { onTimeout: [], onAck: [], onQueueWarn: [] };
	const sup = new TurnSupervisor(
		{
			onTimeout: (key, ms) => {
				calls.onTimeout.push({ key, ms });
			},
			onAck: (key, ms) => {
				calls.onAck.push({ key, ms });
			},
			onQueueWarn: (key, ms) => {
				calls.onQueueWarn.push({ key, ms });
			},
		},
		{ tickIntervalMs: 10_000, now: () => now },
	);
	return {
		sup,
		calls,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("timeout fires once after timeoutMs and not again", async () => {
	const { sup, calls, advance } = makeSupervisor();
	sup.beginTurn("k", 100, 0);
	advance(50);
	await sup.tick();
	assert.equal(calls.onTimeout.length, 0);
	advance(60);
	await sup.tick();
	assert.equal(calls.onTimeout.length, 1);
	assert.equal(calls.onTimeout[0]?.key, "k");
	assert.ok((calls.onTimeout[0]?.ms ?? 0) >= 100);
	// Not fired again on later ticks.
	advance(500);
	await sup.tick();
	assert.equal(calls.onTimeout.length, 1);
});

test("ack fires once after ackAfterMs", async () => {
	const { sup, calls, advance } = makeSupervisor();
	sup.beginTurn("k", 1000, 15);
	advance(10);
	await sup.tick();
	assert.equal(calls.onAck.length, 0);
	advance(10);
	await sup.tick();
	assert.equal(calls.onAck.length, 1);
	advance(100);
	await sup.tick();
	assert.equal(calls.onAck.length, 1);
});

test("endTurn clears state; queue warning fires once while active", async () => {
	const { sup, calls, advance } = makeSupervisor();
	sup.beginTurn("k", 1000, 0);
	sup.markQueued("k");
	advance(130);
	await sup.tick();
	assert.equal(calls.onQueueWarn.length, 1);
	assert.ok((calls.onQueueWarn[0]?.ms ?? 0) >= 120);
	// second markQueued after first warn → warns again (new queue wait)
	sup.markQueued("k");
	advance(130);
	await sup.tick();
	assert.equal(calls.onQueueWarn.length, 2);
	sup.endTurn("k");
	assert.equal(sup.isTurnActive("k"), false);
	advance(1000);
	await sup.tick();
	assert.equal(calls.onQueueWarn.length, 2);
});

test("beginTurn during an active turn does not reset the watchdog", async () => {
	const { sup, advance } = makeSupervisor();
	sup.beginTurn("k", 100, 0);
	advance(80);
	sup.beginTurn("k", 100, 0); // queued follow-up, must not reset
	advance(30);
	await sup.tick();
	const t = sup.getActive("k");
	assert.ok(t);
	assert.ok(t.timedOut); // timed out by original start + 110ms
});

test("start/stop manage the interval timer", () => {
	const { sup } = makeSupervisor();
	sup.start();
	sup.start(); // idempotent
	sup.stop();
	sup.tick(); // no-op after stop
});

test("activeCount tracks concurrent turns", () => {
	const { sup } = makeSupervisor();
	sup.beginTurn("a", 100, 0);
	sup.beginTurn("b", 100, 0);
	assert.equal(sup.activeCount(), 2);
	sup.endTurn("a");
	assert.equal(sup.activeCount(), 1);
});
