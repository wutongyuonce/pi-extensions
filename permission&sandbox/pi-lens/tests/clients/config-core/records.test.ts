import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../../clients/config-warn.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { validate } from "../../../clients/config-core/normalize.js";
import { MigrationRecordCollector } from "../../../clients/config-core/records.js";
// The reporting step moved OUT of config-core in #2426, to the module that owns
// the loaders' subsystem vocabulary — a "pure, no-I/O" library must not import
// the warn seam. The cases below still belong here: what they pin is that a
// record PRODUCED by `validate()` reaches the ledger correctly, and `validate`
// is this directory's subject.
import { reportPiLensConfigRecords as reportMigrationRecords } from "../../../clients/config-resolve.js";
import { DEMO_CONFIG_SCHEMA } from "../../support/config-core-fixtures.js";

const NUL = String.fromCharCode(0);

beforeEach(() => {
	resetDegradationLedger();
	resetIgnoredConfigWarnCache();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
});

describe("records reach the user through the ONE config warn seam (#2418/#2425)", () => {
	it("writes a coded config-ignored row per rejected key", () => {
		const result = validate(
			{ nonsense: 1, lsp: { enabled: "yes" } },
			DEMO_CONFIG_SCHEMA,
			{ file: ".pi-lens.json", tier: "project" },
		);
		expect(result.records).toHaveLength(2);

		reportMigrationRecords(result.records);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "config-ignored",
		);
		expect(group?.count).toBe(2);
		expect(group?.latestReasons.map((entry) => entry.subject).sort()).toEqual(
			[
				`.pi-lens.json${NUL}/lsp/enabled`,
				`.pi-lens.json${NUL}/nonsense`,
			].sort(),
		);
	});

	it("dedupes a repeated report on the ledger's own once-per-session key", () => {
		const result = validate({ nonsense: 1 }, DEMO_CONFIG_SCHEMA, {
			file: ".pi-lens.json",
			tier: "global",
		});
		reportMigrationRecords(result.records);
		reportMigrationRecords(result.records);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "config-ignored",
		);
		expect(group?.count).toBe(1);
	});

	it("reports nothing for a clean config", () => {
		const result = validate({ lsp: { enabled: true } }, DEMO_CONFIG_SCHEMA);
		expect(result.records).toEqual([]);
		reportMigrationRecords(result.records);
		expect(
			getDegradationSummary().some((entry) => entry.kind === "config-ignored"),
		).toBe(false);
	});
});

describe("the record bound is counted, never silent (#2425)", () => {
	it("keeps up to the limit and counts the rest", () => {
		const collector = new MigrationRecordCollector(2);
		for (let index = 0; index < 5; index += 1) {
			collector.add({
				code: "PILENS_CFG_0004",
				file: "a.json",
				key: `/k${index}`,
				subject: `a.json${NUL}/k${index}`,
				reason: "unknown config field; ignored",
			});
		}
		expect(collector.records).toHaveLength(2);
		expect(collector.droppedCount).toBe(3);
	});

	it("seeds the count with what an earlier bound already dropped", () => {
		// #2426 review round 6, F1: a list the core's own collector already
		// truncated is finalized by a SECOND bound, and the count the user reads
		// is the whole truncation or it is a lie about how partial the list is.
		const collector = new MigrationRecordCollector(2, 7);
		collector.add({
			code: "PILENS_CFG_0004",
			file: "a.json",
			key: "/k",
			subject: `a.json${NUL}/k`,
			reason: "unknown config field; ignored",
		});
		expect(collector.droppedCount).toBe(7);
		collector.add({
			code: "PILENS_CFG_0004",
			file: "a.json",
			key: "/k2",
			subject: `a.json${NUL}/k2`,
			reason: "unknown config field; ignored",
		});
		collector.add({
			code: "PILENS_CFG_0004",
			file: "a.json",
			key: "/k3",
			subject: `a.json${NUL}/k3`,
			reason: "unknown config field; ignored",
		});
		expect(collector.droppedCount).toBe(8);
	});

	it("accepts a zero limit without throwing", () => {
		const collector = new MigrationRecordCollector(0);
		collector.add({
			code: "PILENS_CFG_0005",
			file: "a.json",
			key: "/k",
			subject: `a.json${NUL}/k`,
			reason: "expected boolean, got string; ignored",
		});
		expect(collector.records).toEqual([]);
		expect(collector.droppedCount).toBe(1);
	});
});
