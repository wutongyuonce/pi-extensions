import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFilePath } from "../../clients/path-utils.js";

const appendRecentTouches = vi.fn().mockResolvedValue(undefined);
vi.mock("../../clients/recent-touches.js", () => ({
	appendRecentTouches: (...args: unknown[]) => appendRecentTouches(...args),
}));

const logBusEvent = vi.fn();
vi.mock("../../clients/bus-events-logger.js", () => ({
	logBusEvent: (...args: unknown[]) => logBusEvent(...args),
}));

import {
	_resetForTests,
	BUS_FILES_TOUCHED_EVENT,
	BUS_FILES_TOUCHED_VERSION,
	isBusPublishEnabled,
	publishFilesTouched,
	wireBusEmitter,
	wireBusEmitterGetter,
} from "../../clients/bus-publish.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

describe("bus-publish — pilens:files:touched (#482)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(() => {
		_resetForTests();
		resetDegradationLedger();
		appendRecentTouches.mockClear();
		appendRecentTouches.mockResolvedValue(undefined);
		logBusEvent.mockClear();
	});

	afterEach(() => {
		_resetForTests();
		resetDegradationLedger();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	it("no-ops when never wired (unit tests / MCP server path have no pi host)", () => {
		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/src/a.ts"],
				cwd: "/repo",
			}),
		).not.toThrow();
	});

	it("resolves the live emitter after session replacement", () => {
		const oldEmit = vi.fn(() => {
			throw new Error("This extension ctx is stale after session replacement");
		});
		const newEmit = vi.fn();
		let currentEmit: (channel: string, data: unknown) => void = oldEmit;
		wireBusEmitterGetter(() => currentEmit);
		currentEmit = newEmit;

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(oldEmit).not.toHaveBeenCalled();
		expect(newEmit).toHaveBeenCalledTimes(1);
		expect(
			logBusEvent.mock.calls.some(
				([entry]) => (entry as { outcome?: string }).outcome === "emit_failed",
			),
		).toBe(false);
	});

	it("skips a resolved emitter whose session ctx is stale", () => {
		const emit = vi.fn();
		const staleCtx = {
			isIdle: () => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			},
		};
		wireBusEmitterGetter(() => ({ emit, ctx: staleCtx }));

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(emit).not.toHaveBeenCalled();
		expect(logBusEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: BUS_FILES_TOUCHED_EVENT,
				outcome: "skipped_stale_session",
				level: "info",
				ctxSource: "own",
			}),
		);
		expect(
			logBusEvent.mock.calls.some(
				([entry]) => (entry as { outcome?: string }).outcome === "emit_failed",
			),
		).toBe(false);
	});

	it("fails open when the probe cannot classify the ctx", () => {
		// The tri-state matters: only a CONFIRMED-stale ctx (probe === false)
		// may skip delivery. A ctx without isIdle (undefined) and a ctx whose
		// probe throws a NON-stale error (undefined — "don't guess") must both
		// fall through to the emit, where a real failure still logs
		// emit_failed. Silent inversion here would drop telemetry for any
		// odd-shaped ctx.
		for (const oddCtx of [
			{},
			{
				isIdle: () => {
					throw new Error("boom, not the stale fragment");
				},
			},
		]) {
			const emit = vi.fn();
			wireBusEmitterGetter(() => ({ emit, ctx: oddCtx }));
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/src/a.ts"],
				cwd: "/repo",
			});
			expect(emit).toHaveBeenCalledTimes(1);
			expect(
				logBusEvent.mock.calls.some(
					([entry]) =>
						(entry as { outcome?: string }).outcome === "skipped_stale_session",
				),
			).toBe(false);
			vi.clearAllMocks();
		}
	});

	it("re-resolves and publishes through the fresh session ctx", () => {
		const staleEmit = vi.fn();
		const freshEmit = vi.fn();
		let current: {
			emit: (channel: string, data: unknown) => void;
			ctx: { isIdle: () => unknown };
		} = {
			emit: staleEmit,
			ctx: {
				isIdle: () => {
					throw new Error(
						"This extension ctx is stale after session replacement or reload",
					);
				},
			},
		};
		wireBusEmitterGetter(() => current);
		current = { emit: freshEmit, ctx: { isIdle: () => false } };

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(staleEmit).not.toHaveBeenCalled();
		expect(freshEmit).toHaveBeenCalledTimes(1);
	});

	it("emits the exact payload shape from the issue: v, source, reason, paths, cwd", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(channel).toBe(BUS_FILES_TOUCHED_EVENT);
		expect(payload).toMatchObject({
			v: BUS_FILES_TOUCHED_VERSION,
			source: "pi-lens",
			reason: "autofix",
		});
		expect(payload.paths).toHaveLength(2);
		expect(payload.cwd).toEqual(expect.any(String));
	});

	it("normalizes paths and cwd (backslashes -> forward slashes)", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "format",
			paths: ["C:\\repo\\src\\a.ts"],
			cwd: "C:\\repo",
		});

		const payload = emit.mock.calls[0][1] as { paths: string[]; cwd: string };
		expect(payload.paths[0]).not.toContain("\\");
		expect(payload.cwd).not.toContain("\\");
	});

	it("batches: one emit call per publishFilesTouched invocation regardless of path count", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "format",
			paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		expect((emit.mock.calls[0][1] as { paths: string[] }).paths).toHaveLength(
			3,
		);
	});

	it("does not emit for an empty paths batch", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });

		expect(emit).not.toHaveBeenCalled();
	});

	it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetForTests(); // re-arm lazy env read after mutating env
		const emit = vi.fn();
		wireBusEmitter(emit);

		expect(isBusPublishEnabled()).toBe(false);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/a.ts"],
			cwd: "/repo",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("is enabled by default (no env var set)", () => {
		delete process.env.PI_LENS_BUS_PUBLISH;
		_resetForTests();
		expect(isBusPublishEnabled()).toBe(true);
	});

	it("origin-flag loop guard: events originating from an ingested bus event never re-publish", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/a.ts"],
			cwd: "/repo",
			origin: "bus",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("swallows emit throws and logs once via dbg without affecting the caller", () => {
		const emit = vi.fn(() => {
			throw new Error("bus explosion");
		});
		wireBusEmitter(emit);
		const dbg = vi.fn();

		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);

		// Second failure is swallowed but NOT re-logged (log-once).
		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);
	});

	it("logs and ledgers each stale occurrence after a successful recovery", () => {
		const stale = vi.fn(() => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload",
			);
		});
		const recovered = vi.fn();
		let currentEmit: (channel: string, data: unknown) => void = stale;
		wireBusEmitterGetter(() => currentEmit);
		const dbg = vi.fn();
		const publish = (path: string) =>
			publishFilesTouched({
				reason: "autofix",
				paths: [path],
				cwd: "/repo",
				dbg,
			});

		publish("/repo/a.ts");
		publish("/repo/b.ts");
		expect(dbg).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 1 }),
		]);

		currentEmit = recovered;
		publish("/repo/recovered.ts");
		expect(recovered).toHaveBeenCalledTimes(1);

		currentEmit = stale;
		publish("/repo/c.ts");
		expect(dbg).toHaveBeenCalledTimes(2);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 2 }),
		]);
	});

	it("records the pi-lens writer and bounded paths for drift correlation", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);
		const paths = Array.from(
			{ length: 70 },
			(_, index) => `/repo/src/file-${index}.ts`,
		);

		publishFilesTouched({
			reason: "autofix",
			paths,
			cwd: "/repo",
		});

		expect(logBusEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: BUS_FILES_TOUCHED_EVENT,
				outcome: "emitted",
				writer: "pi-lens",
				paths: expect.arrayContaining([
					normalizeFilePath(paths[0]),
					normalizeFilePath(paths[63]),
				]),
			}),
		);
		const record = logBusEvent.mock.calls[0]?.[0] as { paths?: string[] };
		expect(record.paths).toHaveLength(64);
	});

	describe("#502: fix-provenance additive fields", () => {
		it("omits fixes when not provided (old-shape payload unaffected)", () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "format",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			const payload = emit.mock.calls[0][1] as Record<string, unknown>;
			expect(payload.fixes).toBeUndefined();
		});

		it("includes fixes when provided, normalizing each entry's path", () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "format",
				paths: ["C:\\repo\\a.ts"],
				cwd: "C:\\repo",
				fixes: [{ path: "C:\\repo\\a.ts", tool: "prettier", kind: "format" }],
			});

			const payload = emit.mock.calls[0][1] as {
				fixes: Array<{ path: string; tool: string; kind: string }>;
			};
			expect(payload.fixes).toHaveLength(1);
			expect(payload.fixes[0].tool).toBe("prettier");
			expect(payload.fixes[0].kind).toBe("format");
			expect(payload.fixes[0].path).not.toContain("\\");
		});

		it("omits fixes when an empty array is passed", () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				fixes: [],
			});

			const payload = emit.mock.calls[0][1] as Record<string, unknown>;
			expect(payload.fixes).toBeUndefined();
		});

		it("supports multiple fix entries per path (multi-tool autofix batch)", () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				fixes: [
					{ path: "/repo/a.ts", tool: "ruff", kind: "autofix" },
					{ path: "/repo/a.ts", tool: "biome", kind: "autofix" },
				],
			});

			const payload = emit.mock.calls[0][1] as {
				fixes: Array<{ path: string; tool: string; kind: string }>;
			};
			expect(payload.fixes).toHaveLength(2);
			expect(payload.fixes.map((f) => f.tool)).toEqual(["ruff", "biome"]);
		});
	});

	describe("#492: recent-touches producer seam", () => {
		it("appends to the cross-process record at the same call, even with no busEmit wired", () => {
			// No wireBusEmitter call — mirrors a bare/MCP host with no pi.events.
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			expect(appendRecentTouches).toHaveBeenCalledTimes(1);
			expect(appendRecentTouches).toHaveBeenCalledWith(
				expect.objectContaining({
					cwd: "/repo",
					reason: "autofix",
					paths: ["/repo/a.ts"],
				}),
			);
		});

		it("passes sessionId through to the record when provided", () => {
			publishFilesTouched({
				reason: "format",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
				sessionId: "session-123",
			});

			expect(appendRecentTouches).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "session-123" }),
			);
		});

		it("does not append for an empty paths batch (same guard as the bus emit)", () => {
			publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("does not append when origin is 'bus' (loop guard applies to both deliveries)", () => {
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				origin: "bus",
			});
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("does not append when PI_LENS_BUS_PUBLISH=0 (same kill switch as the bus emit)", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetForTests();
			appendRecentTouches.mockClear();

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("a record-append rejection is swallowed and dbg-logged, never thrown into the publish path", async () => {
			appendRecentTouches.mockRejectedValueOnce(new Error("disk full"));
			const dbg = vi.fn();

			expect(() =>
				publishFilesTouched({
					reason: "autofix",
					paths: ["/repo/a.ts"],
					cwd: "/repo",
					dbg,
				}),
			).not.toThrow();

			// The append is fire-and-forget (not awaited by publishFilesTouched) —
			// flush the microtask queue so the rejection handler has run.
			await new Promise((r) => setImmediate(r));
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("recent-touches append failed"),
			);
		});
	});

	describe("bus-events.log (persistent trace)", () => {
		it("logs 'emitted' with a file count on a successful emit", () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts", "/repo/b.ts"],
				cwd: "/repo",
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_FILES_TOUCHED_EVENT,
					outcome: "emitted",
					reason: "autofix",
					fileCount: 2,
				}),
			);
		});

		it("logs 'skipped_unwired' once when busEmit was never wired", () => {
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
			});

			const unwiredCalls = logBusEvent.mock.calls.filter(
				(c) => (c[0] as { outcome: string }).outcome === "skipped_unwired",
			);
			expect(unwiredCalls).toHaveLength(1);
		});

		it("logs 'skipped_disabled' once when the kill switch is off", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetForTests();
			logBusEvent.mockClear();
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
			});

			const disabledCalls = logBusEvent.mock.calls.filter(
				(c) => (c[0] as { outcome: string }).outcome === "skipped_disabled",
			);
			expect(disabledCalls).toHaveLength(1);
		});

		it("logs 'emit_failed' with the error message when emit throws", () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_FILES_TOUCHED_EVENT,
					outcome: "emit_failed",
					error: expect.stringContaining("bus explosion"),
					ctxSource: "global-fallback",
				}),
			);
		});

		it("does not log anything for an empty paths batch", () => {
			publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });
			expect(logBusEvent).not.toHaveBeenCalled();
		});
	});
});
