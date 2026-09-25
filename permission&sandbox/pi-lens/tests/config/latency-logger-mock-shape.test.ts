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
import {
	assertNonEmptyScan,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

/** Every `*.test.ts` under `root`, through the shared walker (#3082): this
 *  file used to hand-roll the identical recursive `readdirSync` walk. */
function walkTestFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	return listSourceFiles(root, { extensions: [".ts"] }).filter((file) =>
		file.endsWith(".test.ts"),
	);
}

type LatencyMock = { relativePath: string; factory: string };

/**
 * Index of the `)` balancing the `(` at `openParen`, quote-aware. #3134: the
 * depth count is `sweep-kit.ts`'s `matchingCloseIndex` with the same
 * `quoteAware: true` option `availability-classifiedby-scan.ts`'s
 * `readBalancedArgs` uses; only this member throws instead of returning -1
 * on an unclosed call, so that convention stays local to this caller.
 */
function callEnd(source: string, openParen: number): number {
	const close = matchingCloseIndex(source, openParen, "(", ")", {
		quoteAware: true,
	});
	if (close === -1) {
		throw new Error(`Unclosed vi.mock call in ${source.slice(0, openParen)}`);
	}
	return close;
}

function findLatencyMocks({
	file,
	source,
}: {
	file: string;
	source: string;
}): LatencyMock[] {
	const code = stripSource(source);
	const mocks: LatencyMock[] = [];
	const pattern = /vi\.mock\s*\(/g;
	for (const match of code.matchAll(pattern)) {
		const start = match.index ?? 0;
		const header = source
			.slice(start)
			.match(/^vi\.mock\s*\(\s*(["'])([^"']*latency-logger[^"']*)\1\s*,/);
		if (!header) continue;
		const openParen = source.indexOf("(", start);
		const end = callEnd(source, openParen);
		mocks.push({
			relativePath: path.relative(repoRoot, file).replaceAll("\\", "/"),
			factory: source.slice(start + header[0].length, end),
		});
	}
	return mocks;
}

describe("latency-logger mock shape (#2281)", () => {
	it("derives every factory and requires a partial import", () => {
		// Recurrence guard for #2272 and #2281: comments and strings must not
		// excuse or trigger a code-only latency-logger mock scan.
		// Floors against 1,098 `.test.ts` files and ~114 latency-mocking files
		// at authoring time: well below live counts so normal growth never
		// trips them, but a silently dropped directory does. The population is
		// `tests/` source, which routine processes (e.g. the 4.1.4
		// `.changelog/` roll) never delete.
		const files = walkTestFiles(path.join(repoRoot, "tests"));
		assertNonEmptyScan("latency-logger test file walk", files.length, 900);
		// readWalkedFiles: a path that vanished between the walk and the read is
		// out of the population, not a finding (#3082 — this scan was one of the
		// four rotating ENOENT victims).
		const mocks = readWalkedFiles(files).flatMap(findLatencyMocks);
		assertNonEmptyScan("latency-logger mock scan", mocks.length, 80);
		const bare = mocks.filter(
			({ factory }) =>
				!factory.includes("importActual") &&
				!factory.includes("importOriginal"),
		);
		expect(bare).toEqual([]);
	});

	it("keeps the factory boundary quote-aware when a string inside it carries a bare `)` (#3145 review round 2)", () => {
		// Regression pin for the #3145 review finding: the `quoteAware` option
		// on `matchingCloseIndex` looked dead by mutation (neutering it reds no
		// existing test) until the reviewer probed a factory whose own body
		// contains a string with an unbalanced `)`. Without quote-awareness,
		// that `)` reads as the call's OWN closing paren, truncating `factory`
		// long before the real end — dropping the `importActual` call this
		// sweep exists to require, and silently passing a bare-replacement mock
		// the sweep is supposed to catch.
		const source = [
			'vi.mock("../../clients/latency-logger.js", () => {',
			'\tconst note = "see docs)";',
			"\treturn {",
			'\t\t...vi.importActual("../../clients/latency-logger.js"),',
			"\t\tlogLatency: vi.fn(),",
			"\t};",
			"});",
		].join("\n");
		const mocks = findLatencyMocks({ file: "fixture.test.ts", source });
		expect(mocks).toHaveLength(1);
		expect(mocks[0]?.factory).toContain("importActual");
	});
});
