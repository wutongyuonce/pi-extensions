/**
 * Vitest globalSetup: fail fast if the in-place compiled `.js` is stale (#198).
 *
 * `npm run build` (tsconfig.build) emits compiled `.js` in place next to each
 * `.ts`. Vitest resolves a test's `../clients/foo.js` import specifier to that
 * **literal compiled file**, not the `.ts` source — so if you edit a source
 * `.ts` and run the suite WITHOUT rebuilding, vitest exercises the *previous*
 * build and your change is silently untested (it can pass against code that no
 * longer exists). `npm run lint` type-checks the `.ts` and stays green, so the
 * change *looks* validated. CI is safe only because its `test` job runs
 * `npm run build` first; there is no `pretest` hook, and a direct `npx vitest
 * run` (what agents/devs use constantly) bypasses one anyway.
 *
 * This guard runs once per vitest process — before any test, for EVERY launch
 * (`npm test`, `npx vitest run`, watch start) — and throws with an actionable
 * message if any compiled-source `.ts` is newer than its `.js` (or has none).
 * Throwing here aborts the run, so stale output can never silently pass.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testSourceFiles } from "./module-instance-scan.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Directories compiled in place by `npm run build` that tests import as `.js`.
// (tests/ is excluded from the build and loaded as `.ts`, so it's not at risk.)
const COMPILED_DIRS = ["clients", "commands", "tools"];
const COMPILED_ROOT_FILES = ["index.ts", "i18n.ts"];

function* walkSourceTs(dir: string): Generator<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			yield* walkSourceTs(full);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts")
		) {
			yield full;
		}
	}
}

function collectCompiledSources(
	root: string,
	dirs: string[],
	rootFiles: string[],
): string[] {
	const sources: string[] = [];
	for (const d of dirs) sources.push(...walkSourceTs(join(root, d)));
	for (const f of rootFiles) {
		const p = join(root, f);
		if (existsSync(p)) sources.push(p);
	}
	return sources;
}

/**
 * Pure(ish) staleness check, exported for unit testing. Returns the source
 * `.ts` files whose compiled `.js` sibling is missing or older than the source.
 */
export function findStaleCompiledSources(opts: {
	root: string;
	dirs?: string[];
	rootFiles?: string[];
}): string[] {
	const { root, dirs = COMPILED_DIRS, rootFiles = COMPILED_ROOT_FILES } = opts;
	const stale: string[] = [];
	for (const ts of collectCompiledSources(root, dirs, rootFiles)) {
		const js = `${ts.slice(0, -3)}.js`;
		if (!existsSync(js)) {
			stale.push(ts);
			continue;
		}
		// Strict `>`: a freshly built `.js` is written after the `.ts` it compiles,
		// so jsMtime >= tsMtime; equal counts as fresh.
		if (statSync(ts).mtimeMs > statSync(js).mtimeMs) stale.push(ts);
	}
	return stale;
}

/**
 * `tests/` is excluded from `tsconfig.build.json` (#2232), so `npm run
 * build` NEVER writes a `.js` sibling there. Any `.js` sibling of a
 * `tests/**\/*.ts` therefore isn't "stale" in the mtime sense above — it's
 * pure residue from an earlier local `tsc` invocation that DID include
 * tests/ (a different tsconfig, an editor auto-compile-on-save, a manual
 * `npx tsc`). Import specifiers in tests end in `.js`, so that residue
 * silently wins module resolution over the real `.ts` source and every
 * later test run in the worktree quietly exercises stale code — this is
 * exactly what fooled a PR #2226 reviewer into a false "fix doesn't work"
 * finding. Presence alone is the defect; there's no mtime check to make
 * because a legitimately fresh compiled `.js` under tests/ can never exist.
 *
 * Reuses `testSourceFiles` (module-instance-scan.ts, #1565) rather than a
 * second hand-rolled `tests/` walker: it already excludes `tests/fixtures`
 * (inputs the fixture's own toolchain owns, not repo tests — e.g. the
 * native-TS7/Vitest fixture the live integration suite copies out and
 * type-checks) and `tests/native-ts7-live-*` (that suite's copied-out temp
 * projects), both proven live false-positive classes for a naive walk. A
 * duplicate walker that didn't exclude them would abort every run at
 * `globalSetup`, before a single test executes.
 */
export function findResidueCompiledTestSources(opts: {
	root: string;
}): string[] {
	const residue: string[] = [];
	for (const ts of testSourceFiles(join(opts.root, "tests"))) {
		if (ts.endsWith(".d.ts")) continue;
		const js = `${ts.slice(0, -3)}.js`;
		if (existsSync(js)) residue.push(js);
	}
	return residue;
}

/**
 * The checks vitest's `globalSetup` runs, against an injectable `root` so
 * tests can point it at an isolated temp tree instead of racing the live
 * repo (#2270 review: the previous end-to-end test planted files directly
 * under the real `tests/support/`, which a concurrent `module-instance-scan`
 * walk of the same live tree could observe mid-write — `ENOENT` under
 * parallel test workers, not a `.gitignore`/build-freshness violation).
 */
export function runFreshnessChecks(root: string): void {
	const stale = findStaleCompiledSources({ root });
	if (stale.length > 0) {
		const rel = (p: string) => p.slice(root.length + 1).replace(/\\/g, "/");
		const shown = stale.slice(0, 10).map(rel);
		const more = stale.length > 10 ? `\n  …and ${stale.length - 10} more` : "";
		throw new Error(
			`\n⛔ Stale build: ${stale.length} source file(s) are newer than their compiled .js (or have none).\n` +
				`Vitest loads the compiled .js next to each .ts (\`npm run build\` emits in place),\n` +
				`so these edits are NOT under test. Run \`npm run build\` before testing.\n` +
				`Stale:\n  ${shown.join("\n  ")}${more}\n`,
		);
	}

	const residue = findResidueCompiledTestSources({ root });
	if (residue.length > 0) {
		const rel = (p: string) => p.slice(root.length + 1).replace(/\\/g, "/");
		const shown = residue.slice(0, 10).map(rel);
		const more =
			residue.length > 10 ? `\n  …and ${residue.length - 10} more` : "";
		throw new Error(
			`\n⛔ Stale test residue: ${residue.length} compiled .js file(s) sit beside tests/**/*.ts source.\n` +
				`tests/ is excluded from \`npm run build\`, so these were never freshly built — an\n` +
				`import ending in ".js" resolves to this STALE file instead of the real .ts source,\n` +
				`silently running old code (#2232). Delete them:\n  ${shown.join("\n  ")}${more}\n`,
		);
	}
}

export default function setup(): void {
	runFreshnessChecks(repoRoot);
}
