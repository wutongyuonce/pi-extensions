/**
 * #2281 — every latency-logger mock must preserve the real export surface.
 *
 * A bare factory replacement hides exports added after the test was written.
 * This guard derives its inventory from every test source and checks only the
 * factory body, so an unrelated importActual cannot satisfy the check.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const legacyBareFactoryExemptions = new Set([
	// Dated 2026-08-27. These non-LSP mocks remain isolated to tests that do
	// not load the full logger; convert them in the follow-up to #2281.
	"tests/clients/advisory-provenance-finding-freshness.test.ts",
	"tests/clients/advisory-provenance-finding-paths.test.ts",
	"tests/clients/agent-nudge.test.ts",
	"tests/clients/availability-classification-evidence.test.ts",
	"tests/clients/biome-install-evidence.test.ts",
	"tests/clients/cache-observability.test.ts",
	"tests/clients/degradation-ledger.test.ts",
	"tests/clients/diagnostic-line-freshness.test.ts",
	"tests/clients/dotnet-root-markers.test.ts",
	"tests/clients/formatter-degraded-selection.test.ts",
	"tests/clients/formatter-probe-commands.test.ts",
	"tests/clients/formatter-selection-outcome.test.ts",
	"tests/clients/formatters-which-latch.test.ts",
	"tests/clients/install-attempt-evidence.test.ts",
	"tests/clients/install-retry-session-rearm.test.ts",
	"tests/clients/instance-reaper-backstop.test.ts",
	"tests/clients/pipeline-eslint-availability-latch.test.ts",
	"tests/clients/runtime-context-provenance.test.ts",
	"tests/clients/safe-spawn-cap-race.test.ts",
	"tests/clients/safe-spawn-close-before-error-race.test.ts",
	"tests/clients/safe-spawn-resource-usage.test.ts",
	"tests/clients/safe-spawn-sync-throw.test.ts",
	"tests/clients/session-start-observability.test.ts",
	"tests/clients/tool-set-policy.test.ts",
	"tests/clients/dispatch/runners/ast-grep-utils-block.test.ts",
	"tests/clients/dispatch/runners/availability-latching.test.ts",
	"tests/clients/dispatch/runners/cwd-probe-latching.test.ts",
	"tests/clients/dispatch/runners/psscriptanalyzer-availability.test.ts",
	"tests/clients/dispatch/runners/runner-helpers.test.ts",
	"tests/config/module-instance-binding.test.ts",
	"tests/source-filter-skip-observability.test.ts",
	"tests/tools/lsp-navigation-workspace-attribution.test.ts",
]);

function walkTestFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile() && entry.name.endsWith(".test.ts"))
				files.push(file);
		}
	};
	walk(root);
	return files.sort();
}

type LatencyMock = { relativePath: string; factory: string };

function callEnd(source: string, openParen: number): number {
	let depth = 0;
	let quote = "";
	for (let index = openParen; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") depth += 1;
		if (character === ")" && --depth === 0) return index;
	}
	throw new Error(`Unclosed vi.mock call in ${source.slice(0, openParen)}`);
}

function findLatencyMocks(file: string): LatencyMock[] {
	const source = fs.readFileSync(file, "utf8");
	const mocks: LatencyMock[] = [];
	const pattern = /vi\.mock\s*\(\s*(["'])([^"']*latency-logger[^"']*)\1\s*,/g;
	for (const match of source.matchAll(pattern)) {
		const start = match.index ?? 0;
		const openParen = source.indexOf("(", start);
		const end = callEnd(source, openParen);
		mocks.push({
			relativePath: path.relative(repoRoot, file).replaceAll("\\", "/"),
			factory: source.slice(match.index! + match[0].length, end),
		});
	}
	return mocks;
}

describe("latency-logger mock shape (#2281)", () => {
	it("derives every factory and requires a partial import", () => {
		const files = walkTestFiles(path.join(repoRoot, "tests"));
		assertNonEmptyScan("latency-logger test file walk", files.length);
		const mocks = files.flatMap(findLatencyMocks);
		assertNonEmptyScan("latency-logger mock scan", mocks.length);
		const bare = mocks.filter(
			({ relativePath, factory }) =>
				!factory.includes("importActual") &&
				!factory.includes("importOriginal") &&
				!legacyBareFactoryExemptions.has(relativePath),
		);
		const flagged = mocks.filter(
			({ factory }) =>
				!factory.includes("importActual") &&
				!factory.includes("importOriginal"),
		);
		expect(bare).toEqual([]);
		expect([...legacyBareFactoryExemptions].sort()).toEqual(
			[...new Set(flagged.map(({ relativePath }) => relativePath))].sort(),
		);
	});
});
