/**
 * #3310 — the expiry check on the `emptyFirstPublish` class.
 *
 * ## The recurrence this guards
 *
 * `emptyFirstPublish: "indexing"` (clients/lsp/wait-policy/strategies.ts) makes
 * the publish handler HOLD a server's empty first publish, because intelephense
 * answers `didOpen` with `[]` while it indexes and pi-lens read that as
 * "confirmed clean" for a file with an error. A per-server marker derived from a
 * measurement goes stale the moment the measurement changes, and the two stale
 * directions fail differently:
 *
 *  - a server measured `empty-first` with NO marker is a LIVE false clean (the
 *    #3310 defect, for that server);
 *  - a marker whose server now measures `direct` makes the client hold a publish
 *    that was the answer, paying the index budget for nothing.
 *
 * So this census compares the two committed sources against each other: the
 * `first-publish` column of docs/lsp-capability-matrix.md — which the nightly
 * `probe-clean-signal.mjs` step re-measures and merges through the
 * `bot/lsp-docs-refresh` auto-PR — and the marker in the strategy table. When a
 * server's measured class changes, that auto-PR reds here until the marker moves
 * with it. Deterministic by construction: it reads two files in the repo and
 * spawns nothing.
 *
 * `unknown` / `empty-only` / `TBD` / `n/a (pull)` cells are evidence of nothing
 * in either direction (the #240 doctrine, as `clean-behavior`'s own drift check
 * applies it) and are excluded — with a floor, so a column that somehow became
 * all-`TBD` cannot pass this sweep silently.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	COMPARABLE_FIRST_PUBLISH,
	strategyKeyForLang,
} from "../../scripts/lib/clean-signal.mjs";
import { parseTable } from "../../scripts/lib/md-matrix.mjs";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const MATRIX_PATH = path.join(repoRoot, "docs", "lsp-capability-matrix.md");

interface MatrixRow {
	lang: string;
	server: string;
	firstPublish: string;
}

function matrixRows(): MatrixRow[] {
	const text = fs.readFileSync(MATRIX_PATH, "utf8");
	const table = parseTable(text, "| lang | server |");
	expect(table, "capability matrix table is parseable").not.toBeNull();
	const header = table!.header;
	const langIdx = header.indexOf("lang");
	const serverIdx = header.indexOf("server");
	const firstPublishIdx = header.indexOf("first-publish");
	expect(
		firstPublishIdx,
		"the matrix carries a first-publish column (#3310)",
	).toBeGreaterThan(-1);
	return table!.rows.map((cells) => ({
		lang: cells[langIdx] ?? "",
		server: cells[serverIdx] ?? "",
		firstPublish: cells[firstPublishIdx] ?? "",
	}));
}

describe("#3310 first-publish census", () => {
	it("compares a non-trivial number of measured rows", () => {
		const comparable = matrixRows().filter((row) =>
			COMPARABLE_FIRST_PUBLISH.has(row.firstPublish),
		);
		// A floor, not a ratchet: the sweep must never pass by comparing nothing
		// (defect shape 10 — an empty census fails loud).
		expect(comparable.length).toBeGreaterThanOrEqual(2);
	});

	it("marks every server measured empty-first, and no server measured direct", () => {
		const mismatches: string[] = [];
		for (const row of matrixRows()) {
			if (!COMPARABLE_FIRST_PUBLISH.has(row.firstPublish)) continue;
			const key = strategyKeyForLang(row.lang);
			const marked =
				SERVER_DIAGNOSTIC_STRATEGIES[key]?.emptyFirstPublish === "indexing";
			if (row.firstPublish === "empty-first" && !marked) {
				mismatches.push(
					`${row.lang} (${row.server}): measured empty-first but wait-policy/strategies.ts has no emptyFirstPublish marker for "${key}" — its empty pre-index publish still resolves the push wait, which is a live #3310 false clean for that server`,
				);
			}
			if (row.firstPublish === "direct" && marked) {
				mismatches.push(
					`${row.lang} (${row.server}): wait-policy/strategies.ts marks "${key}" emptyFirstPublish:"indexing" but this measurement says direct — the marker is stale and the client is holding a publish that was the answer`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("keeps every marked server inside the measured population", () => {
		// A marker for a server with no row at all cannot be re-measured, so it
		// could never expire — the registry entry and its measurement ship together.
		const langs = new Set(
			matrixRows().map((row) => strategyKeyForLang(row.lang)),
		);
		const orphans = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(([, strategy]) => strategy.emptyFirstPublish === "indexing")
			.map(([serverId]) => serverId)
			.filter((serverId) => !langs.has(serverId));
		expect(orphans).toEqual([]);
	});

	it("never marks one server both seedFirstPush and emptyFirstPublish", () => {
		// "the first push is complete" and "the first push is provisional" cannot
		// both hold; the publish handler evaluates the hold first, so a server with
		// both markers would silently lose its seed fast path.
		const contradictory = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(
				([, strategy]) =>
					strategy.emptyFirstPublish === "indexing" && strategy.seedFirstPush,
			)
			.map(([serverId]) => serverId);
		expect(contradictory).toEqual([]);
	});
});
