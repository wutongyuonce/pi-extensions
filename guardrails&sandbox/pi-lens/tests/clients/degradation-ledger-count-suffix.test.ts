import { beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	incrementDegradationCount,
	LEDGER_FIELD_MAX,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

describe("incrementDegradationCount keeps the count on a long reason", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});

	// #1816: the reason was truncated, the count suffix appended, and the whole
	// concatenation truncated AGAIN at the same bound — so any reason at or over
	// LEDGER_FIELD_MAX lost the one field that says how often it fired.
	it("appends the count after truncation, not before", () => {
		const reason = "z".repeat(LEDGER_FIELD_MAX + 50);
		incrementDegradationCount({
			kind: "runner-empty-result",
			subject: "vale",
			reason,
		});
		incrementDegradationCount({
			kind: "runner-empty-result",
			subject: "vale",
			reason,
		});

		const entry = getDegradationSummary()
			.find((group) => group.kind === "runner-empty-result")
			?.latestReasons.find((candidate) => candidate.subject === "vale");
		expect(entry?.reason).toContain("(count: 2)");
	});

	it("still bounds the reason itself", () => {
		incrementDegradationCount({
			kind: "runner-empty-result",
			subject: "vale",
			reason: "z".repeat(1000),
		});
		const entry = getDegradationSummary()
			.find((group) => group.kind === "runner-empty-result")
			?.latestReasons.find((candidate) => candidate.subject === "vale");
		// The bounded reason, the elision marker, and " (count: 1)".
		expect(entry?.reason.length).toBeLessThanOrEqual(LEDGER_FIELD_MAX + 20);
		expect(entry?.reason).toContain("…");
	});

	it("leaves a short reason exactly as written", () => {
		incrementDegradationCount({
			kind: "runner-empty-result",
			subject: "mypy",
			reason: "mypy exited 2 with no output: bad flag",
		});
		const entry = getDegradationSummary()
			.find((group) => group.kind === "runner-empty-result")
			?.latestReasons.find((candidate) => candidate.subject === "mypy");
		expect(entry?.reason).toBe(
			"mypy exited 2 with no output: bad flag (count: 1)",
		);
	});
});
