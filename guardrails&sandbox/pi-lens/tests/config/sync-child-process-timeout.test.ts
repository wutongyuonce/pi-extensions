/**
 * #1980 AC3, as a recurrence guard rather than a one-off census.
 *
 * A synchronous child-process call parks the event loop for exactly as long
 * as the child takes. With no `timeout`, that park is unbounded — and #1980's
 * whole finding is that such a park used to read as ordinary compute in
 * `loop_block`, because `windowCpuMs` was recorded beside every block and
 * never read.
 *
 * The one-off sweep found three real call sites with no bound. Two are fixed
 * (`findBinaryOnPath` in clients/lsp/launch.ts, on the LSP spawn path;
 * `ensureUtf8ConsoleCodePageOnce` in clients/safe-spawn.ts, on the first spawn
 * of the process); the third is exempted below with its reason. This walks the
 * family so the next one cannot land silently: a hand-written list of "the
 * sync spawn sites" goes stale the first time someone adds one, which is the
 * single-source-of-truth rule this repo already applies to language and runner
 * registries.
 *
 * Built on tests/support/sweep-kit.ts — `listSourceFiles` for the walk,
 * `stripSource` for comment/string masking, `auditRegistry` for
 * exempted-with-a-reason plus stale-exemption and dead-scan floors. Those
 * floors are the point: this repo's catalog shape 10 is a sweep that matches
 * nothing and reads as clean.
 *
 * Scope: the shipped source tree (clients/, index.ts, tools/, mcp/). Tests and
 * scripts are out — neither runs on pi's event loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The family: every synchronous child-process launcher Node offers. */
const SYNC_SPAWN_CALLS = ["spawnSync", "execSync", "execFileSync"];

/**
 * Sites that legitimately carry no literal `timeout:` in their own options,
 * each with the reason `auditRegistry` requires. Keyed `file:snippet`, where
 * the snippet appears in the call's arguments or just above it, so a moved
 * call is still recognised but a genuinely new one is not.
 *
 * Keep this SHORT and reasoned. "It is probably fast" is not a reason — both
 * bugs this guard exists for were probably fast.
 */
const EXEMPT_SITES: Readonly<Record<string, string>> = {
	"clients/safe-spawn.ts:taskkill.exe":
		"killPidTreeSync runs from process exit and signal handlers. The process is already tearing down, so there is no event loop left to protect, and a timeout would only orphan the kill it was asked to perform.",
	"clients/safe-spawn.ts:...(options as SpawnOptions)":
		"safeSpawn's own spawnSync calls spread the CALLER's options, which is where the timeout comes from; its only in-repo callers, isCommandAvailable and findCommand, both pass timeout: 5000.",
};

/**
 * Slice from `(` to its matching `)`, so a multi-line options object is read
 * whole rather than by a line-bounded regex that a formatted call defeats.
 */
function callArguments(source: string, openParenIndex: number): string {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openParenIndex + 1, i);
		}
	}
	return source.slice(openParenIndex + 1);
}

interface CallSite {
	/** `file:line fn` — the id the audit reports. */
	id: string;
	file: string;
	/** Argument list plus a little preceding source, for exemption matching. */
	haystack: string;
	bounded: boolean;
}

function shippedSourceFiles(): string[] {
	const files = ["clients", "tools", "mcp"].flatMap((dir) => {
		const abs = path.join(REPO_ROOT, dir);
		return fs.existsSync(abs)
			? listSourceFiles(abs, { extensions: [".ts"], skipTests: true })
			: [];
	});
	const indexTs = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files;
}

function findCallSites(): { sites: CallSite[]; scanned: number } {
	const files = shippedSourceFiles();
	const sites: CallSite[] = [];
	for (const abs of files) {
		const raw = fs.readFileSync(abs, "utf8");
		// Comment/string masking is necessary, not fussy: this repo documents
		// its own sync-to-async migrations in prose, so clients/lsp/server.ts
		// and clients/safe-spawn.ts both contain `spawnSync(` inside doc
		// comments explaining that the call USED to be synchronous. A raw regex
		// reports those as unbounded sites, which is a false failure that would
		// push a maintainer to weaken this guard. `stripSource` blanks comments
		// and string bodies while preserving every offset.
		const masked = stripSource(raw);
		const rel = relativePosix(REPO_ROOT, abs);
		for (const fn of SYNC_SPAWN_CALLS) {
			// A CALL, not an import, type, or prose mention: the name must be
			// followed by `(` and must not be preceded by an identifier
			// character, so `safeSpawnSync(` never matches `spawnSync`.
			const pattern = new RegExp(`(?<![\\w$.])${fn}\\s*\\(`, "g");
			for (const match of masked.matchAll(pattern)) {
				const openParen = masked.indexOf("(", match.index);
				const args = callArguments(raw, openParen);
				sites.push({
					id: `${rel}:${raw.slice(0, match.index).split("\n").length} ${fn}`,
					file: rel,
					haystack:
						raw.slice(Math.max(0, match.index - 600), match.index) + args,
					bounded: /\btimeout\s*:/.test(args),
				});
			}
		}
	}
	return { sites, scanned: files.length };
}

/** The exemption key a site matches, if any. */
function exemptionKey(site: CallSite): string | undefined {
	return Object.keys(EXEMPT_SITES).find((key) => {
		const [file, ...rest] = key.split(":");
		return file === site.file && site.haystack.includes(rest.join(":"));
	});
}

describe("#1980 every synchronous child-process call bounds the event-loop park", () => {
	const { sites, scanned } = findCallSites();
	const unbounded = sites.filter((site) => !site.bounded);

	const audit = auditRegistry({
		sweepName: "sync child-process timeout sweep",
		// Flagged = the unbounded sites, reported under their exemption key when
		// they have one, so a stale exemption is detectable by the kit itself.
		flagged: unbounded.map((site) => exemptionKey(site) ?? site.id),
		registered: [],
		exemptions: EXEMPT_SITES,
		scannedCount: scanned,
		// Floors, not decoration (catalog shape 10): a walk that finds no
		// source files, or a detector that flags nothing, must fail rather than
		// read as clean. 200 is well under the ~450 shipped .ts files; 1 is the
		// single exempt site that will always be flagged.
		minScanned: 200,
		minFlagged: 1,
		remediation:
			"Pass an explicit `timeout` (5000 matches every other sync child-process site), or add an entry to EXEMPT_SITES with a real reason.",
	});

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// Vacuity guard on the DETECTOR, separate from the audit's floors: if
		// the call-site regex breaks, every assertion below passes for free.
		// There were 7 sites across 3 files when this landed.
		expect(sites.length).toBeGreaterThanOrEqual(5);
		expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(3);
	});

	it("bounds every site, or exempts it with a reason", () => {
		// Pre-fix, `audit.unaccounted` reads:
		//   clients/lsp/launch.ts:310 execFileSync
		//   clients/safe-spawn.ts:1062 spawnSync
		expect(audit.problems).toEqual([]);
	});

	it("keeps the exemption list live and reasoned", () => {
		// An exemption whose site no longer exists must be deleted, not left to
		// silently cover some future call it was never reasoned about.
		expect(audit.staleExemptions).toEqual([]);
		expect(audit.reasonlessExemptions).toEqual([]);
	});
});
