import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import {
	getProjectIgnoreMatcher,
	isPathIgnoredByProject,
	PROJECT_IGNORE_FRESHNESS_CADENCE_MS,
} from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("nested ignore freshness clock (#2071)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps two paths under one nested rule in agreement after an external edit", () => {
		const env = setupTestEnvironment("pi-lens-2071-divergence-");
		try {
			const nested = path.join(env.tmpDir, "sub");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "node_modules\n");
			fs.writeFileSync(path.join(nested, ".gitignore"), "placeholder-keep\n");
			const memoized = path.join(nested, "x.ts");
			const fresh = path.join(nested, "y.ts");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoized)).toBe(false);

			// External edit, no pi-lens write hook: the IDE-edit shape.
			fs.writeFileSync(path.join(nested, ".gitignore"), "*.ts\n");

			// Same matcher, same directory, same rule. Before the shared clock the
			// fresh path re-read the nested rules while the memoized path replayed
			// its pre-edit verdict, so these two disagreed.
			expect(matcher.isIgnored(fresh)).toBe(matcher.isIgnored(memoized));
		} finally {
			env.cleanup();
		}
	});

	it("drops subtree verdicts when a walk rebuilds drifted nested patterns", () => {
		const env = setupTestEnvironment("pi-lens-2071-drift-drop-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "a.ts\n");
			const memoized = path.join(nested, "a.ts");
			const walked = path.join(nested, "b.ts");

			vi.useFakeTimers();
			const start = Date.now();
			// Held once, as a walk loop holds it. No further getProjectIgnoreMatcher
			// lookups, so the #2159 sweep cannot be what fixes this.
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoized)).toBe(true);

			fs.writeFileSync(ignorePath, "!a.ts\n");
			vi.setSystemTime(start + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			// This fresh path rebuilds the drifted directory. That rebuild must take
			// the superseded verdicts with it.
			matcher.isIgnored(walked);

			expect(matcher.isIgnored(memoized)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("stats a nested ignore source once per cadence window, not once per file", () => {
		const env = setupTestEnvironment("pi-lens-2071-bounded-cost-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");

			vi.useFakeTimers();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			// First lookup builds the entry and arms the clock.
			matcher.isIgnored(path.join(nested, "seed.ts"));

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath)
					.length;
			statSpy.mockClear();

			// Fifty distinct paths in one directory, all inside one window.
			for (let index = 0; index < 50; index++) {
				matcher.isIgnored(path.join(nested, `f${index}.ts`));
			}

			expect(sourceStats()).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("reads the nested ignore source once per check instead of twice", () => {
		const env = setupTestEnvironment("pi-lens-2071-single-stat-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath)
					.length;
			statSpy.mockClear();

			// One cold lookup: one freshness check of this one nested source.
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(
				path.join(nested, "generated.ts"),
			);

			expect(sourceStats()).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("re-arms the shared clock after an unchanged check crosses a window", () => {
		const env = setupTestEnvironment("pi-lens-2071-rearm-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");

			vi.useFakeTimers();
			const start = Date.now();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			matcher.isIgnored(path.join(nested, "seed.ts"));

			// Cross the boundary. This check finds no drift, so it must stamp the
			// entry with the CURRENT time. Without the re-arm the entry keeps its
			// build time, every later call still reads as expired, and the
			// per-file stat storm this PR removed comes straight back. The
			// existing bounded-cost case never crosses a window, so it cannot see
			// the difference.
			vi.setSystemTime(start + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath)
					.length;
			statSpy.mockClear();

			// The first of these pays the one boundary-crossing stat. The other
			// forty-nine are inside the window the re-arm just opened.
			for (let index = 0; index < 50; index++) {
				matcher.isIgnored(path.join(nested, `f${index}.ts`));
			}

			expect(sourceStats()).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("catches a same-size nested edit through the mtime axis", () => {
		const env = setupTestEnvironment("pi-lens-2071-mtime-axis-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			// "aaa.ts" and "bbb.ts" are the same length, so only mtime separates
			// these two rule sets. The #1105 cases pin the size axis by holding
			// mtime fixed; this is the mirror, and without it the mtime comparison
			// is removable with every test still green.
			fs.writeFileSync(ignorePath, "aaa.ts\n");
			const target = path.join(nested, "bbb.ts");

			vi.useFakeTimers();
			const start = Date.now();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(target)).toBe(false);

			fs.writeFileSync(ignorePath, "bbb.ts\n");
			expect(fs.statSync(ignorePath).size).toBe(7);
			// PIN the mtime rather than trusting the clock to tick. Size is held
			// constant here on purpose, so mtime is the ONLY axis that can carry
			// the edit — and two same-size writes land in one coarse mtime bucket
			// most of the time (measured 181/200 back to back on Windows). The
			// real test does enough work between the writes to usually escape the
			// bucket, which is worse than always failing: it failed 1 of 15
			// unmutated runs here, and Linux CI would never show it. This is the
			// mirror of the #1105 cases, which pin mtime with `utimesSync` to
			// isolate the size axis; this pins it to isolate the mtime axis.
			const bumped = new Date(fs.statSync(ignorePath).mtimeMs + 5_000);
			fs.utimesSync(ignorePath, bumped, bumped);
			vi.setSystemTime(start + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);
			// A fresh path in the same directory rebuilds the drifted entry and
			// drops the subtree's verdicts with it.
			matcher.isIgnored(path.join(nested, "other.ts"));

			expect(matcher.isIgnored(target)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("publishes a newly discovered nested source before the sweep that must see it", () => {
		const env = setupTestEnvironment("pi-lens-2071-publish-order-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "placeholder-keep\n");
			const target = path.join(nested, "x.ts");

			vi.useFakeTimers();
			const start = Date.now();
			// Lookup one consumes the nested source for the first time. There is
			// no cache entry yet, so the source cannot be published until a later
			// call.
			expect(isPathIgnoredByProject(target, env.tmpDir)).toBe(false);

			fs.writeFileSync(ignorePath, "*.ts\n");

			// Lookup two lands one cadence later. Its sweep must see the source
			// discovered by lookup one. With the publish AFTER the sweep, this
			// sweep ran against a source list that did not yet contain the nested
			// file, found no drift, and still reset the clock — so pickup took a
			// second full window (measured: stale at 2 s and 3 s, fresh at 4 s).
			vi.setSystemTime(start + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			expect(isPathIgnoredByProject(target, env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
