/**
 * pilens_symbol_search MCP smoke (#348).
 *
 * Drives the real stdio JSON-RPC transport against a tiny synthetic project with
 * a pre-seeded word-index snapshot (avoids depending on session-start's
 * background build finishing inside the test window) to assert the #517-slimmed
 * payload: startLine/endLine, no per-hit `read` block, path relative to cwd.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import {
	flushProjectSnapshotPersistsForTests,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { McpHarness } from "./harness.js";

let snapshotDataRoot: string;

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

function parseTrailer(res: Record<string, unknown>): Record<string, unknown> {
	const text = textOf(res);
	return JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as Record<string, unknown>;
}

function makeTinyProject(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	snapshotDataRoot = mkdtempSync(path.join(tmpdir(), `${prefix}data-`));
	writeFileSync(
		path.join(dir, "auth.ts"),
		"export function authenticateUser(id) {\n  return id;\n}\n",
	);
	const index = buildWordIndex([
		{
			path: path.join(dir, "auth.ts"),
			content: "export function authenticateUser(id) {\n  return id;\n}\n",
		},
	]);
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = snapshotDataRoot;
	try {
		saveProjectSnapshot(dir, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: dir,
			generatedAt: new Date().toISOString(),
			seq: 0,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
			wordIndex: serializeWordIndex(index),
		});
		// The production snapshot body is worker-persisted. Flush the test seed
		// before spawning a separate MCP process; otherwise a loaded CI worker can
		// race the child and make a valid pre-seeded index look unavailable.
		flushProjectSnapshotPersistsForTests();
	} finally {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
	}
	return dir;
}

describe("pilens_symbol_search over MCP (tiny project, pre-seeded index)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-symbolsearch-mcp-");
		harness = new McpHarness({
			cwd: projectDir,
			env: { PILENS_DATA_DIR: snapshotDataRoot },
		});
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "symbolsearch-smoke", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		try {
			rmSync(projectDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
			rmSync(snapshotDataRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch {
			// OS reclaims the temp dir eventually.
		}
	});

	it("returns a slimmed (#517) ranked payload for a warm index", async () => {
		const res = await harness.request(10, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "authenticate user", cwd: projectDir },
		});
		expect((res.result as { isError?: boolean }).isError).toBeFalsy();
		const payload = parseTrailer(res) as {
			query: string;
			coverage: { files: number; truncated: boolean };
			results: Array<{
				file: string;
				score: number;
				hits: number;
				startLine: number;
				endLine: number;
				read?: unknown;
				lines?: unknown;
			}>;
		};
		expect(payload.coverage).toEqual({ files: 1, truncated: false });
		expect(textOf(res)).toContain("Index covers 1 files.");
		expect(payload.results.length).toBeGreaterThan(0);
		const hit = payload.results[0];
		expect(hit.file.replace(/\\/g, "/")).toBe("auth.ts");
		expect(hit.startLine).toBeGreaterThan(0);
		expect(hit.endLine).toBe(hit.startLine);
		expect(hit.read).toBeUndefined();
		expect(hit.lines).toBeUndefined();
	}, 30_000);

	it("returns available:false with an actionable hint when no index exists for cwd", async () => {
		const coldDir = mkdtempSync(
			path.join(tmpdir(), "pi-lens-symbolsearch-cold-mcp-"),
		);
		try {
			const res = await harness.request(11, "tools/call", {
				name: "pilens_symbol_search",
				arguments: { query: "anything", cwd: coldDir },
			});
			const payload = parseTrailer(res) as {
				available: boolean;
				hint?: string;
			};
			expect(payload.available).toBe(false);
			expect(String(payload.hint)).toMatch(/background|retry|session_start/i);
		} finally {
			rmSync(coldDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		}
	}, 30_000);
});
