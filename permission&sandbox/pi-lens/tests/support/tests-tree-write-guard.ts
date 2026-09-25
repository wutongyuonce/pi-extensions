/**
 * Run-level guard against a test creating a source file inside the repo's own
 * `tests/` tree (#3082).
 *
 * Named recurrence: `tests/clients/pi-lens-home-hermeticity.test.ts`'s
 * red-first proof wrote a real `tests/scratch-3050-pre-3048-vanished-wiring.
 * test.ts` into the walked tree so its own `listSourceFiles` walk would pick
 * it up, and removed it in a `finally`. Every OTHER governance sweep lists
 * `tests/**` and then reads each path; whichever one was mid-enumeration
 * during that ~1 ms window died with `ENOENT` on a file that exists on no
 * branch. Four suites took the hit on rotating runs — `sweep-floor-coverage`,
 * `vacuous-skip-coverage`, `latency-logger-mock-shape`,
 * `lsp-spawn-heavy-coverage` — two of four laps red in the reproduction on
 * #3092. AGENTS.md's "test that drives shared state it does not own", where
 * the shared state is the `tests/` directory itself.
 *
 * ## Why a watcher rather than a source scan or an fs wrapper
 *
 * A runtime observation, not a source scan (AGENTS.md defect shape 33), and
 * not a list of syntactic spellings (shape 34): the guard watches the
 * DIRECTORY, so it fires the same way for `fs.writeFileSync`, `cpSync`, a
 * `fs.promises` write, a shell redirect in a spawned child, or any spelling
 * nobody has thought of yet.
 *
 * The fs-wrapping alternative (the shape `tests/support/kill-guard.ts` uses
 * for `process.kill`) cannot work here: an ES module namespace object is
 * frozen, so `fs.writeFileSync = ...` throws `TypeError: Cannot assign to
 * read only property 'writeFileSync' of object '[object Module]'` and a
 * `node:fs` named import would bypass a patched copy anyway.
 *
 * A before/after snapshot (the shape `tests/support/git-config-guard.ts` uses
 * for git config) cannot work either, and for the reason that defines this
 * defect: the producer created AND removed the file inside one `it` body, so
 * both snapshots are identical. Only something watching the window sees it.
 *
 * ## What counts
 *
 * A CREATED path under the watched root whose extension is one the governance
 * walkers enumerate under `tests/` (`.ts`/`.mts`/`.mjs` today — see the walk
 * options in tests/config/tmp-fixture-hygiene.test.ts,
 * tests/support/flake-shape-scan.ts and the eleven `listSourceFiles(TESTS_ROOT
 * …)` callers). A path that already existed when the run started is NOT a
 * violation: editing a tracked test file mid-run is the maintainer's business,
 * and only a file the walk did not start with can surprise a sweep that has
 * already enumerated.
 *
 * ## Known blind spot: a file that was already there
 *
 * The baseline is snapshotted at `globalSetup`, so a scratch file a KILLED
 * earlier run left behind (a `finally` does not run through SIGKILL) is part
 * of the baseline and invisible to this guard for the whole run — it will also
 * be read happily by every sweep, since it is simply a file now. Nothing else
 * in the suite catches it either: no governance test asserts "no untracked
 * source file under tests/" (#3104 review note (b)). `git status` shows it,
 * and that is the current answer; a guard that shelled out to `git ls-files`
 * at globalSetup would trade this gap for a real child process on every run.
 *
 * ## What it cannot see, measured rather than assumed
 *
 * A file created and removed without the WATCHING process's event loop
 * turning in between produces no callback at all: probed on Node 22.22.1,
 * `write` + `rm` in one tick delivered zero events, the same two operations
 * separated by one turn delivered both. That bound does not weaken the guard
 * where it runs — the watcher lives in the main process (globalSetup) while
 * producers run in worker forks, so the main loop is free to turn during the
 * producer's window, and #3082's own producer held the file across a full
 * 1,200-file `listSourceFiles` walk. It is stated because it is exactly the
 * kind of gap a "green means clean" reading would hide: a sub-millisecond
 * create/delete inside one fork is a race no sweep can hit either.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { listSourceFiles } from "./sweep-kit.js";

/**
 * Exactly the extensions a governance walker enumerates under `tests/` today:
 * `.ts` (every `listSourceFiles(TESTS_ROOT …)` caller), `.mts`
 * (tests/support/flake-shape-scan.ts's support population) and `.mjs`
 * (tests/config/tmp-fixture-hygiene.test.ts). `.js`/`.cjs` are deliberately
 * absent — no walker enumerates them under `tests/`, and a fixture
 * `npm install` dropping JavaScript into a fixture workspace is not this
 * defect. A walker that adds an extension adds it here.
 */
export const GUARDED_EXTENSIONS: readonly string[] = [".ts", ".mts", ".mjs"];

/** Per-run record cap (bounded observability, AGENTS.md shape 9): a runaway
 *  producer must not retain an unbounded list. The first paths are the
 *  informative ones; the report says how many were dropped. */
const MAX_VIOLATIONS = 20;

export interface TestsTreeWriteGuard {
	/** Feed one watch event, as `fs.watch`'s callback receives it. */
	record(filename: string | null): void;
	/** The report for this run, or `undefined` when nothing was created. */
	report(): string | undefined;
	/** Stop watching. Safe to call when the watch never started. */
	close(): void;
}

/**
 * Is `relative` (a path relative to the watched root) a file kind a
 * governance walker would list and then read?
 *
 * `node_modules` is excluded whole: a fixture workspace that installs
 * dependencies drops thousands of files no sweep walks (every walker either
 * roots below the fixture trees or reads only `.test.ts`), and inotify would
 * otherwise turn one `npm install` into a wall of noise.
 */
export function isGuardedTreeEntry(relative: string): boolean {
	const segments = relative.split(/[\\/]/);
	if (segments.includes("node_modules")) return false;
	return GUARDED_EXTENSIONS.some((extension) => relative.endsWith(extension));
}

/**
 * Start watching `root` for source files that did not exist when the run
 * started.
 *
 * `watch` is the seam: `false` installs no watcher (the classification cases
 * feed {@link TestsTreeWriteGuard.record} directly and stay deterministic),
 * and any other function stands in for `fs.watch` — the failure case uses one
 * that throws. The default is the real `fs.watch`; no test replaces it to
 * prove delivery.
 *
 * `allow` excuses a path that WOULD otherwise violate — a test-owned scratch
 * dir under the watched root whose producer writes and removes a file inside
 * one run, the same shape `tests/clients/pi-lens-home-hermeticity.test.ts`
 * causes for a moment and cleans up (#3105). Takes the relative path (as
 * `record` receives it) and returns whether to excuse it; callers are
 * expected to match a whole scratch-directory prefix rather than enumerate
 * filenames, so a producer adding a second file to its own scratch dir needs
 * no guard update.
 */
export function installTestsTreeWriteGuard(
	root: string,
	options: {
		watch?: typeof fs.watch | false;
		allow?: (relative: string) => boolean;
	} = {},
): TestsTreeWriteGuard {
	const baseline = new Set(
		listSourceFiles(root, {
			extensions: GUARDED_EXTENSIONS,
			skipDeclarations: false,
		}),
	);
	const created: string[] = [];
	const seen = new Set<string>();
	let dropped = 0;

	const record = (filename: string | null): void => {
		if (filename === null) return;
		if (!isGuardedTreeEntry(filename)) return;
		if (options.allow?.(filename)) return;
		const absolute = path.join(root, filename);
		if (baseline.has(absolute)) return;
		if (seen.has(absolute)) return;
		seen.add(absolute);
		if (created.length >= MAX_VIOLATIONS) {
			dropped += 1;
			return;
		}
		created.push(absolute);
	};

	let warnedUnexpectedError = false;

	let watcher: fs.FSWatcher | undefined;
	const watch = options.watch ?? fs.watch;
	if (watch !== false) {
		try {
			watcher = watch(root, { recursive: true }, (_event, filename) =>
				record(filename === null ? null : String(filename)),
			);
			// Unref'd: the guard must never be the reason the process stays
			// alive (AGENTS.md shape 4). Events are still delivered.
			watcher.unref();
			// #3179: on Linux (inotify has no recursive primitive) node's
			// recursive watch is the JS polyfill in
			// lib/internal/fs/recursive_watch.js, which re-scans a changed
			// subfolder with a synchronous readdirSync (`#watchFolder`). When
			// that subfolder is removed between the change event that triggers
			// the rescan and the readdirSync itself, `#watchFolder`'s own catch
			// unconditionally re-emits the failure as an 'error' event on this
			// FSWatcher. With no listener, that is an unhandled 'error' event —
			// Node throws it back onto the event loop and, absent a process-level
			// uncaughtException handler, the whole vitest process dies with exit
			// 1 and no failing test (PR #3178 run 35154740539). The race is
			// cross-process (the removal happens in whichever worker fork owns
			// the exempt scratch producer while this watcher runs in the main
			// globalSetup process), so nothing on this side can close the
			// window — only handling the event can. ENOENT whose folder falls
			// under an exempt prefix (the same `allow` callback callers already
			// use to excuse a producer's own create/remove churn from being
			// reported as a #3082 violation) is exactly that expected churn and
			// is swallowed; every other error is recorded once — never silently
			// dropped (AGENTS.md shape 10) and never used to widen `allow`'s
			// existing exemptions.
			watcher.on("error", (error: NodeJS.ErrnoException) => {
				const errorPath =
					typeof error.path === "string" ? error.path : undefined;
				const relative =
					errorPath !== undefined ? path.relative(root, errorPath) : undefined;
				if (
					error.code === "ENOENT" &&
					relative !== undefined &&
					options.allow?.(relative)
				) {
					return;
				}
				if (warnedUnexpectedError) return;
				warnedUnexpectedError = true;
				process.stderr.write(
					`[tests-tree-write-guard] fs.watch error on ${root}: ${String(error)}\n`,
				);
			});
		} catch (error) {
			// Recursive watch is unavailable on some platforms/filesystems. Say
			// so once rather than failing the run over a missing detector, and
			// never pretend the tree was clean (shape 10).
			process.stderr.write(
				`[tests-tree-write-guard] not watching ${root}: ${String(error)} — #3082 recurrences will not be caught on this platform\n`,
			);
		}
	}

	return {
		record,
		report(): string | undefined {
			if (created.length === 0) return undefined;
			const extra = dropped > 0 ? `\n  ... and ${dropped} more` : "";
			return (
				`#3082: ${created.length + dropped} source file(s) were created inside the repo's own tests/ tree during this run:\n` +
				`${created.map((file) => `  ${file}`).join("\n")}${extra}\n` +
				"Every governance sweep lists tests/** and then reads each path, so a " +
				"file that appears and disappears mid-run kills whichever walker was " +
				"enumerating (ENOENT, rotating victim). Write the fixture into the " +
				"test's own mkdtemp root and walk THAT — listSourceFiles does not care " +
				"which root it is given (tests/clients/pi-lens-home-hermeticity.test.ts " +
				"is the worked example)."
			);
		},
		close(): void {
			watcher?.close();
		},
	};
}
