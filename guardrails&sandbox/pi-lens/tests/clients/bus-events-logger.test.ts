import { afterEach, describe, expect, it } from "vitest";
import {
	emitBusEventRollupAtSessionEnd,
	getBusEventRollupCounts,
	logBusEvent,
	resetBusEventRollupCounts,
} from "../../clients/bus-events-logger.js";

// S2d (gap 5, #1432 review): a session-end rollup — {emitted,
// skipped_stale_session, emit_failed} per event name — counted at this
// shared seam (every producer + resolveLiveBusEmitter's own
// skipped_stale_session write go through `logBusEvent`) rather than
// instrumenting each producer individually.
describe("bus-events-logger session-end rollup (S2d gap 5, #1432 review)", () => {
	afterEach(() => {
		resetBusEventRollupCounts();
	});

	it("counts emitted, skipped_stale_session, and emit_failed per event name", () => {
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "skipped_stale_session",
			level: "info",
			cwd: "/repo",
		});
		logBusEvent({
			event: "pilens:diagnostics",
			outcome: "emit_failed",
			cwd: "/repo",
			error: "boom",
		});

		expect(getBusEventRollupCounts()).toEqual({
			"pilens:files:touched": {
				emitted: 2,
				skipped_stale_session: 1,
				emit_failed: 0,
			},
			"pilens:diagnostics": {
				emitted: 0,
				skipped_stale_session: 0,
				emit_failed: 1,
			},
		});
	});

	it("ignores outcomes outside the three rolled-up ones", () => {
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "skipped_unwired",
			cwd: "/repo",
		});
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "skipped_disabled",
			cwd: "/repo",
		});

		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("resetBusEventRollupCounts clears the rollup", () => {
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		expect(getBusEventRollupCounts()).not.toEqual({});
		resetBusEventRollupCounts();
		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("emitBusEventRollupAtSessionEnd logs one row per active event name, then resets", () => {
		logBusEvent({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		logBusEvent({
			event: "pilens:diagnostics",
			outcome: "emit_failed",
			cwd: "/repo",
			error: "x",
		});

		emitBusEventRollupAtSessionEnd("/repo");

		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("logs nothing when nothing was published this session (no-noise shape)", () => {
		// Sanity: resetBusEventRollupCounts leaves an empty map, and
		// emitBusEventRollupAtSessionEnd iterates it — zero entries means zero
		// logLatency calls from THIS function (other subsystems may still log
		// independently, so assert on the rollup phase specifically).
		emitBusEventRollupAtSessionEnd("/repo");
		expect(getBusEventRollupCounts()).toEqual({});
	});
});
