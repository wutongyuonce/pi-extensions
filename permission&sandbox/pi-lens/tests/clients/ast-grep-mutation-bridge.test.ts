/**
 * #2423 acceptance 3 — `ast_grep_replace apply:true` records through the seam.
 *
 * `--update-all` rewrites files on disk with no `tool_result` describing it, so
 * pi-lens's OWN tool was as invisible to the mutation bookkeeping as any
 * third-party one: no read-guard stamp, no turn state, no deferred format.
 *
 * This file imports nothing new. It mounts a capture bridge under the public
 * `Symbol.for("pi-lens:mutation-bridge")` key exactly the way a co-process
 * extension would read it, so the assertion below fails on pre-fix code rather
 * than on a missing module.
 */
import { describe, expect, it, vi } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";

const MUTATION_BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");

type Recorded = {
	filePath: string;
	kind: string;
	editRanges?: [number, number][];
	consumer?: string;
};

const recorded: Recorded[] = [];

Object.defineProperty(globalThis, MUTATION_BRIDGE_KEY, {
	value: Object.freeze({
		version: 1 as const,
		recordMutation(entry: Recorded): boolean {
			recorded.push(entry);
			return true;
		},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

function clientWithExec(exec: (args: string[]) => unknown): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: typeof exec } }).runner = { exec };
	return client;
}

/**
 * ast-grep reports 0-based lines. The two matches below sit on source lines 5
 * and 21, so a correct record carries `[[5, 5], [21, 21]]`.
 */
const MATCHES = [
	{
		file: "src/a.ts",
		range: { start: { line: 4, column: 0 }, end: { line: 4, column: 5 } },
		text: "var x",
	},
	{
		file: "src/a.ts",
		range: { start: { line: 20, column: 0 }, end: { line: 20, column: 5 } },
		text: "var y",
	},
	{
		file: "src/b.ts",
		range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
		text: "var z",
	},
];

function execFor(matches: typeof MATCHES) {
	return vi.fn(async (args: string[]) => {
		if (args.includes("--update-all"))
			return { matches: [], totalMatches: 0, truncated: false };
		return { matches, totalMatches: matches.length, truncated: false };
	});
}

describe("#2423 ast_grep_replace records its applied rewrites", () => {
	it("records one mutation per rewritten file, with 1-based ranges", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor(MATCHES));

		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["src"],
			true,
		);

		expect(result.applied).toBe(true);
		expect(recorded).toHaveLength(2);
		expect(recorded[0]).toMatchObject({
			filePath: "src/a.ts",
			kind: "edit",
			consumer: "ast_grep_replace",
			editRanges: [
				[5, 5],
				[21, 21],
			],
		});
		expect(recorded[1]).toMatchObject({
			filePath: "src/b.ts",
			kind: "edit",
			editRanges: [[1, 1]],
		});
	});

	it("records nothing for a dry run", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor(MATCHES));
		await client.replace("var $X", "let $X", "typescript", ["src"], false);
		expect(recorded).toHaveLength(0);
	});

	it("records nothing when the stale-preview check finds no matches", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor([]));
		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["src"],
			true,
		);
		expect(result.stalePreview).toBe(true);
		expect(recorded).toHaveLength(0);
	});
});
