import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EnqueueRejectedError,
	FatalDeliveryError,
	Outbox,
	RetryableError,
} from "../../../src/outbound/outbox.ts";
import type { OutboundEnvelope, Payload } from "../../../src/common/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "feishu-link-outbox-"));
}

function textPayload(t: string): Payload {
	return { type: "text", text: t };
}

function textOf(p: Payload): string {
	return p.type === "text" ? p.text : "";
}

function makeEnv(
	laneKey: string,
	kind: OutboundEnvelope["kind"] = "final",
	seq = 0,
): Omit<
	OutboundEnvelope,
	"id" | "status" | "attempts" | "nextRetryAt" | "createdAt"
> {
	return {
		dedupeKey: `${kind}:lane:${laneKey}:${seq}`,
		laneKey,
		route: {
			conversationKey: laneKey,
			chatId: `oc_${laneKey}`,
			chatType: "p2p",
		},
		kind,
		payload: textPayload(`${laneKey}-msg-${seq}`),
	};
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs)
				return reject(new Error("waitFor timed out"));
			setTimeout(tick, 20);
		};
		tick();
	});
}

test("enqueue → sender called → status sent", async () => {
	const dir = tempDir();
	try {
		const sent: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				sent.push(textOf(env.payload));
				return { messageId: `m-${env.id}` };
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		const env = await outbox.enqueue(makeEnv("k1", "final", 1));
		await outbox.drainIdle();
		assert.deepEqual(sent, ["k1-msg-1"]);
		const summary = outbox.summary();
		assert.equal(summary.sent, 1);
		assert.equal(outbox.getEnvelope(env.id)?.status, "sent");
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FIFO within a lane", async () => {
	const dir = tempDir();
	try {
		const order: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				order.push(textOf(env.payload));
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("lane-a", "final", 1));
		await outbox.enqueue(makeEnv("lane-a", "final", 2));
		await outbox.enqueue(makeEnv("lane-a", "final", 3));
		await outbox.drainIdle();
		assert.deepEqual(order, ["lane-a-msg-1", "lane-a-msg-2", "lane-a-msg-3"]);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("失败消息不阻塞 lane：排队尾重试（2026-08-08 spec §3.1）", async () => {
	const dir = tempDir();
	try {
		const order: string[] = [];
		let failFirst = true;
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				const t = textOf(env.payload);
				order.push(t);
				if (t.includes("msg-1") && failFirst) {
					failFirst = false;
					throw new Error("temporary failure");
				}
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 100,
			backoffMaxMs: 200,
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("lane-a", "final", 1));
		await outbox.enqueue(makeEnv("lane-a", "final", 2));
		await outbox.drainIdle();
		// msg-1 首次失败（移出 lane）→ msg-2 立即发（不被阻塞）→ msg-1 定时重试成功
		assert.equal(order.length, 3, "msg-1 首次失败 + msg-2 + msg-1 重试");
		const i2 = order.indexOf("lane-a-msg-2");
		const last1 = order.lastIndexOf("lane-a-msg-1");
		assert.ok(i2 >= 0 && i2 < last1, "后续消息不应被失败消息阻塞");
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stuck lane does not block other lanes (per-lane parallelism)", async () => {
	const dir = tempDir();
	try {
		const blocked: string[] = [];
		const delivered: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				if (env.laneKey === "lane-stuck") {
					blocked.push(textOf(env.payload));
					throw new RetryableError("feishu 5xx");
				}
				delivered.push(textOf(env.payload));
				return {};
			},
			maxAttemptsBeforeAlert: 2,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 5,
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("lane-stuck", "final", 1));
		await outbox.enqueue(makeEnv("lane-ok", "final", 1));
		await waitFor(() => delivered.length === 1);
		assert.deepEqual(delivered, ["lane-ok-msg-1"]);
		assert.ok(blocked.length >= 1, "stuck lane kept retrying");
		// stuck lane is still pending (never gave up), alert fired once
		assert.ok(outbox.summary().pending >= 1);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dedupeKey idempotency: same key enqueued twice sends once", async () => {
	const dir = tempDir();
	try {
		const sent: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				sent.push(env.id);
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		const a = await outbox.enqueue(makeEnv("k", "final", 7));
		const b = await outbox.enqueue(makeEnv("k", "final", 7));
		assert.equal(a.id, b.id);
		await outbox.drainIdle();
		assert.equal(sent.length, 1);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retryable error → backoff retries → eventually sent; alert fires once", async () => {
	const dir = tempDir();
	try {
		let attempts = 0;
		let alerts = 0;
		const outbox = new Outbox({
			dir,
			sender: async () => {
				attempts++;
				if (attempts < 4) throw new RetryableError("flaky 429");
				return {};
			},
			maxAttemptsBeforeAlert: 2,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 5,
			onAlert: () => {
				alerts++;
			},
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("k", "final", 1));
		await outbox.drainIdle(20_000);
		assert.equal(attempts, 4);
		assert.equal(alerts, 1);
		assert.equal(outbox.summary().sent, 1);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fatal error → failed terminal, onFatal called, lane continues", async () => {
	const dir = tempDir();
	try {
		const fatal: Array<{ id: string; error: string }> = [];
		const ok: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				if (textOf(env.payload) === "bad")
					throw new FatalDeliveryError("chat gone 4xx");
				ok.push(textOf(env.payload));
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
			onFatal: (env, err) => {
				fatal.push({ id: env.id, error: err.message });
			},
		});
		await outbox.init();
		await outbox.enqueue({
			...makeEnv("k", "final", 1),
			payload: textPayload("bad"),
		});
		await outbox.enqueue(makeEnv("k", "final", 2));
		await outbox.drainIdle();
		assert.equal(fatal.length, 1);
		assert.ok(fatal[0]?.error.includes("4xx"));
		assert.deepEqual(ok, ["k-msg-2"]);
		const summary = outbox.summary();
		assert.equal(summary.failed, 1);
		assert.equal(summary.sent, 1);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("crash recovery: sending on disk resets to pending and delivers", async () => {
	const dir = tempDir();
	try {
		// Simulate a crash mid-send: write an append + sending patch by hand.
		const env = {
			...makeEnv("k", "final", 9),
			id: "crash-1",
			status: "pending" as const,
			attempts: 0,
			nextRetryAt: Date.now(),
			createdAt: Date.now(),
		};
		const seg = join(dir, "seg-000.jsonl");
		writeFileSync(
			seg,
			[
				JSON.stringify({ op: "append", env }),
				JSON.stringify({ op: "patch", id: "crash-1", status: "sending" }),
			].join("\n") + "\n",
			"utf8",
		);

		const sent: string[] = [];
		const outbox = new Outbox({
			dir,
			sender: async (e) => {
				sent.push(e.id);
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.drainIdle();
		assert.deepEqual(sent, ["crash-1"]);
		assert.equal(outbox.summary().sent, 1);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restart replay: sent stays sent (dedupeKey preserved), pending resumes", async () => {
	const dir = tempDir();
	try {
		const sent: string[] = [];
		const sender = async (env: OutboundEnvelope) => {
			sent.push(env.id);
			return {};
		};
		const opts = {
			dir,
			sender,
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		};
		const a = new Outbox(opts);
		await a.init();
		await a.enqueue(makeEnv("k", "final", 1));
		await a.drainIdle();
		await a.enqueue(makeEnv("k2", "final", 1));
		await a.drainIdle();
		await a.close();

		// "Restart": new instance over the same dir. k's final is already sent
		// and must NOT be re-sent; k2's pending must be delivered.
		const b = new Outbox({
			...opts,
			sender: async (env) => {
				sent.push(env.id);
				return {};
			},
		});
		await b.init();
		await b.drainIdle();
		assert.equal(sent.length, 2, "both sent exactly once across restart");
		await b.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compaction keeps live + recent terminal, drops old terminal", async () => {
	const dir = tempDir();
	try {
		const opts = {
			dir,
			sender: async () => ({}),
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		};
		const a = new Outbox(opts);
		await a.init();
		await a.enqueue(makeEnv("k", "final", 1));
		await a.drainIdle();
		await a.enqueue(makeEnv("k", "final", 2));
		await a.drainIdle();
		await a.close();

		// Age the FIRST sent envelope beyond retention by rewriting its sentAt on disk.
		const seg = readdirSync(dir).find(
			(f) => f.startsWith("seg-") && f.endsWith(".jsonl"),
		)!;
		const file = join(dir, seg);
		const text = readFileSync(file, "utf8");
		const aged = text.replace(
			/"sentAt":(\d+)/,
			(_, ts) => `"sentAt":${Number(ts) - 120_000}`,
		);
		writeFileSync(file, aged, "utf8");

		// "Restart": fresh instance rebuilds from disk, then compacts.
		const b = new Outbox(opts);
		await b.init();
		assert.equal(b.summary().sent, 2);
		const result = await b.compact(Date.now());
		assert.ok(result.dropped >= 1, "old terminal dropped");
		assert.ok(result.kept >= 1, "recent kept");
		assert.equal(b.summary().sent, 1);
		await b.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pending cap rejects new enqueues", async () => {
	const dir = tempDir();
	try {
		const outbox = new Outbox({
			dir,
			sender: async () => {
				throw new RetryableError("stuck forever");
			},
			maxAttemptsBeforeAlert: 1,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 2,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 60_000, // long backoff → stays pending
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("k", "final", 1));
		await outbox.enqueue(makeEnv("k", "final", 2));
		await assert.rejects(
			outbox.enqueue(makeEnv("k", "final", 3)),
			EnqueueRejectedError,
		);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("large payload spills to blob and still delivers", async () => {
	const dir = tempDir();
	try {
		let got: string | undefined;
		const outbox = new Outbox({
			dir,
			sender: async (env) => {
				got = textOf(env.payload);
				return {};
			},
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 100, // tiny cap forces spill
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.enqueue({
			...makeEnv("k", "final", 1),
			payload: textPayload("x".repeat(2000)),
		});
		await outbox.drainIdle();
		assert.equal(got, "x".repeat(2000));
		assert.ok(existsSync(join(dir, "blobs")));
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dir guard evicts oldest sent when over budget", async () => {
	const dir = tempDir();
	try {
		const outbox = new Outbox({
			dir,
			sender: async () => ({}),
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 3_600_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 1, // tiny budget → everything must be evicted
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("k", "final", 1));
		await outbox.drainIdle();
		await outbox.compact(Date.now());
		assert.equal(outbox.summary().sent, 0);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("summary counts are accurate", async () => {
	const dir = tempDir();
	try {
		const outbox = new Outbox({
			dir,
			sender: async () => ({}),
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.enqueue(makeEnv("a", "final", 1));
		await outbox.enqueue(makeEnv("b", "final", 1));
		await outbox.drainIdle();
		const s = outbox.summary();
		assert.equal(s.sent, 2);
		assert.equal(s.pending, 0);
		assert.ok(s.bytes > 0);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("M1: dir guard evicts terminal records until under budget", async () => {
	const dir = tempDir();
	try {
		const opts = {
			dir,
			sender: async () => ({}),
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 3_600_000, // long retention → records stay terminal
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 1024,
			maxOutboxDirBytes: 2_000, // tiny guard
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		};
		const a = new Outbox(opts);
		await a.init();
		for (let i = 0; i < 20; i++) {
			await a.enqueue(makeEnv("k", "final", i));
		}
		await a.drainIdle();
		assert.ok(
			a.summary().bytes > opts.maxOutboxDirBytes,
			"over budget before guard",
		);
		const before = a.summary().sent;
		const result = await a.compact(Date.now());
		assert.ok(result.dropped > 0, "guard evicted records");
		// After the guard run the directory is back under the cap.
		assert.ok(
			dirBytesOf(dir) <= opts.maxOutboxDirBytes,
			`dir ${dirBytesOf(dir)} should be ≤ ${opts.maxOutboxDirBytes}`,
		);
		// Pending envelopes are never evicted.
		assert.equal(a.summary().pending, 0);
		void before;
		await a.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function dirBytesOf(dir: string): number {
	let total = 0;
	for (const f of readdirSync(dir, { recursive: true })) {
		const p = typeof f === "string" ? join(dir, f) : f;
		try {
			total += statSync(p).size;
		} catch {
			/* ignore */
		}
	}
	return total;
}
