import { describe, expect, it } from "vitest";
import {
	classifyRunOutcome,
	firstOutputLine,
	spawnFailedWithNoOutput,
} from "../../../../../clients/dispatch/runners/utils/spawn-outcome.js";
import {
	formatRunOutcomeFailure,
	formatToolFailure,
} from "../../../../../clients/dispatch/runners/utils/tool-failure.js";
import type { SpawnResult } from "../../../../../clients/safe-spawn.js";
import {
	capKilledSpawnResult,
	capThenTimedOutSpawnResult,
} from "../../../../support/spawn-shapes.js";

function spawnResult(partial: Partial<SpawnResult>): SpawnResult {
	return { stdout: "", stderr: "", status: 0, ...partial };
}

describe("firstOutputLine", () => {
	it("skips leading blank lines the hand-rolled copies returned as empty", () => {
		expect(firstOutputLine("\n\n  error: bad config\nmore")).toBe(
			"error: bad config",
		);
	});

	it('strips the carriage return that split("\\n")[0] left behind', () => {
		expect(firstOutputLine("first\r\nsecond")).toBe("first");
	});

	it("bounds the line and marks the elision", () => {
		expect(firstOutputLine("x".repeat(400))).toBe(`${"x".repeat(200)}…`);
	});

	it("returns an empty string for silence, so callers can || a fallback", () => {
		expect(firstOutputLine("   \n\n")).toBe("");
		expect(firstOutputLine(undefined)).toBe("");
	});
});

describe("classifyRunOutcome", () => {
	it("calls a clean exit a run", () => {
		expect(classifyRunOutcome({ result: spawnResult({}) }).kind).toBe("ran");
	});

	it("calls a nonzero exit WITH output a run — linters exit nonzero on findings", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 1, stdout: '[{"line":1}]' }),
		});
		expect(outcome.kind).toBe("ran");
	});

	it("calls a nonzero exit with nothing to parse did-not-run", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 2, stderr: "unknown flag --nope" }),
		});
		expect(outcome.kind).toBe("did-not-run");
		expect(outcome.status).toBe(2);
		expect(outcome.firstOutputLine).toBe("unknown flag --nope");
	});

	it("names the signal that killed the tool", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({
				status: null,
				signal: "SIGKILL",
				error: new Error("Process killed by signal: SIGKILL"),
				failure: "signal",
			}),
		});
		expect(outcome.kind).toBe("did-not-run");
		expect(outcome.signal).toBe("SIGKILL");
	});

	it("calls a null status with no error did-not-run, never a clean run", () => {
		expect(
			classifyRunOutcome({ result: spawnResult({ status: null }) }).kind,
		).toBe("did-not-run");
	});

	// A null status is decisive on its own: a process that never reported an
	// exit code did not complete an analysis, even if it printed something
	// first. Without this the partial output would read as a clean run.
	it("calls a null status did-not-run even when output arrived", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: null, stdout: '[{"line":1}]' }),
			}).kind,
		).toBe("did-not-run");
	});

	// The declared exit table is the only thing that can catch a rejection that
	// still printed to stdout. Deleting the table branch must red this.
	it("calls a nonzero status outside the declared table a rejected invocation", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 78, stdout: "[]" }),
			exitCodes: { ran: [2] },
		});
		expect(outcome.kind).toBe("rejected-invocation");
	});

	it("respects a declared findings code as a real run", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 2, stdout: "[]" }),
				exitCodes: { ran: [2] },
			}).kind,
		).toBe("ran");
	});

	it("calls a missing report after a nonzero exit report-missing", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 1 }),
				reportMissing: true,
			}).kind,
		).toBe("report-missing");
	});

	it("calls a missing report after a CLEAN exit a run — nothing to report is clean", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 0 }),
				reportMissing: true,
			}).kind,
		).toBe("ran");
	});
});

// The delegation must not widen the old predicate: existing callers depend on
// a partial-output spawn failure still reaching their parser.
describe("spawnFailedWithNoOutput keeps its historical semantics", () => {
	it("is false when a spawn failure still produced output", () => {
		expect(
			spawnFailedWithNoOutput(
				spawnResult({
					status: null,
					error: new Error("Process timed out after 30000ms"),
					stdout: "[]",
				}),
			),
		).toBe(false);
	});

	it("is true for a nonzero exit with empty stdout", () => {
		expect(spawnFailedWithNoOutput(spawnResult({ status: 1 }))).toBe(true);
	});
});

describe("formatToolFailure", () => {
	it("names the signal instead of a null exit status", () => {
		expect(
			formatToolFailure({
				tool: "mypy",
				status: null,
				signal: "SIGKILL",
				stderr: "",
			}),
		).toBe("mypy was killed by SIGKILL with no output: no stderr");
	});

	it("uses one wording for an exit-code failure", () => {
		expect(
			formatToolFailure({
				tool: "vulture",
				status: 2,
				stderr: "error: bad config\ntrace",
			}),
		).toBe("vulture exited 2 with no output: error: bad config");
	});

	it("keeps discriminating fields, so knip's binary source survives", () => {
		expect(
			formatToolFailure({
				tool: "knip",
				status: 2,
				stderr: "config not found",
				fields: { source: "project", command: "npx knip" },
			}),
		).toBe(
			"knip (source=project, command=npx knip) exited 2 with no output: config not found",
		);
	});

	it("says report file, not output, for artifact tools", () => {
		expect(
			formatToolFailure({
				tool: "jscpd",
				status: 1,
				stderr: "boom",
				reportMissing: true,
			}),
		).toBe("jscpd exited 1 with no report file: boom");
	});

	it("truncates once, at the ledger bound", () => {
		const reason = formatToolFailure({
			tool: "vale",
			status: 1,
			stderr: "y".repeat(500),
		});
		expect(reason.length).toBeLessThanOrEqual(201);
		expect(reason.endsWith("…")).toBe(true);
	});

	it("falls back to stdout when stderr is silent", () => {
		expect(
			formatToolFailure({ tool: "taplo", status: 1, stdout: "usage: taplo" }),
		).toBe("taplo exited 1 with no output: usage: taplo");
	});

	// #2100 review F3: an output-cap kill reaches this seam as a plain SIGTERM,
	// so the ledger row read "killed by SIGTERM" — the tool blamed for a kill we
	// sent because WE stopped reading. The cap is the stronger explanation and
	// displaces the signal, exactly as the signal displaces a null exit status.
	it("names the output cap instead of the signal it killed with", () => {
		expect(
			formatToolFailure({
				tool: "oxlint",
				status: null,
				signal: "SIGTERM",
				outputCapped: true,
				stderr: "",
			}),
		).toBe("oxlint was stopped at its output cap with no output: no stderr");
	});
});

describe("classifyRunOutcome output-cap evidence (#2100)", () => {
	it("carries the cap verdict without moving the classification", () => {
		const capped = classifyRunOutcome({
			result: capKilledSpawnResult({ stdout: "partial" }),
		});
		expect(capped.kind).toBe("did-not-run");
		expect(capped.outputCapped).toBe(true);

		// A timeout that also truncated is a timeout, not a cap kill.
		const timedOut = classifyRunOutcome({
			result: capThenTimedOutSpawnResult({ stdout: "partial" }),
		});
		expect(timedOut.kind).toBe("did-not-run");
		expect(timedOut.outputCapped).toBe(false);

		// And an ordinary run is untouched.
		const ran = classifyRunOutcome({
			result: { stdout: "findings", stderr: "", status: 0 },
		});
		expect(ran.kind).toBe("ran");
		expect(ran.outputCapped).toBe(false);
	});

	it("routes the cap wording all the way into the ledger reason", () => {
		const outcome = classifyRunOutcome({
			result: capKilledSpawnResult({ stdout: "partial" }),
		});
		expect(formatRunOutcomeFailure("oxlint", outcome)).toContain(
			"was stopped at its output cap",
		);
	});
});
