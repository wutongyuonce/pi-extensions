import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// `tests/config/git-fixture-governance.test.ts` requires every direct Git
// spawn under tests/ to route through this helper. It is also the RIGHT
// wrapper here rather than a concession: it pins GIT_CONFIG_NOSYSTEM and
// points GIT_CONFIG_GLOBAL at a nonexistent fixture file, so a developer's
// own `core.excludesFile` cannot be what makes the assertion below pass —
// the repo's committed `.gitignore` has to do the work on its own.
import { execFileSync } from "../support/git-fixture-env.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import {
	_resetProbeHomeRedirectStateForTests,
	getGlobalPiLensLogDir,
	getProbeHomeResolution,
} from "../../clients/probe-home-state.js";

// #2506: an ad-hoc probe against the BUILT `clients/*.js` (a bare `node -e`, a
// throwaway `.mjs`, a harness script run OUTSIDE vitest) has no test-mode gate
// and no `PI_LENS_HOME` pin, so the log resolver used to fall straight through
// to `os.homedir()`. Confirmed live: two review probes wrote 42
// `config-ignored` rows into the maintainer's real `~/.pi-lens/latency.log` on
// 2026-09-02. A REAL child `node` process is load-bearing here — an in-process
// call can't exercise "PI_LENS_HOME was never set in this process's
// environment" the way a freshly spawned child can; mocking `process.env` /
// `process.cwd()` in-process would test the mock, not the production
// import-time resolution in `latency-logger.ts`/`file-utils.ts`.
//
// ROUND 3, F3 — why each case steers the child's `os.tmpdir()`. Round 2 rooted
// every fixture under `os.tmpdir()`, so the worktree case and the
// `PILENS_PROBE=1` case were BOTH also satisfied by the tmpdir branch: all
// three branches were individually vacuous and deleting any one of them left
// the suite green. Fixtures still live in the real temp dir (that is where
// throwaway trees belong), but each child is given its own
// `TEMP`/`TMP`/`TMPDIR` so that `os.tmpdir()` inside it points somewhere that
// does or does not contain the fixture, exactly as the case requires. This is
// real Node behaviour — `os.tmpdir()` reads those variables — so the branch
// under test sees a genuine `os.tmpdir()`, not a stub. Every case asserts on
// the child's reported `tmpdir:` line, so a fixture that drifts back under the
// child's temp dir fails loudly instead of going quietly vacuous.
//
// Safety: every child below gets its OWN throwaway `USERPROFILE`/`HOME`
// (verified live on this Node/Windows combination: `os.homedir()` honors an
// overridden `USERPROFILE`), standing in for "the real home". This is
// deliberate, not a weaker substitute: the pre-fix path resolves straight to
// `os.homedir()` with no other gate, so running the proof against the ACTUAL
// developer home would reproduce the exact #2506 incident as a side effect of
// proving the bug exists. The code path is identical either way —
// `path.join(os.homedir(), ".pi-lens")` never distinguishes a real profile
// from a faked one.
const CHILD_FIXTURE = fileURLToPath(
	new URL("../fixtures/global-dir-probe-redirect-child.mjs", import.meta.url),
);
const CHILD_TIMEOUT_MS = 30_000;
const REPO_ROOT = path.resolve(".");

interface ChildFacts {
	tmpdir: string;
	globalDir: string;
	logDir: string;
	toolsDir: string;
}

function runChild(
	cwd: string,
	fakeHome: string,
	childTmpDir: string,
	extraEnv: Record<string, string> = {},
): Promise<ChildFacts> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// The exact hazard: no home pin, no test-mode signal — a bare probe run
		// inherits the ambient shell environment minus these.
		delete env.PI_LENS_HOME;
		delete env.VITEST;
		delete env.PI_LENS_TEST_MODE;
		delete env.PILENS_PROBE;
		delete env.PILENS_DATA_DIR;
		env.USERPROFILE = fakeHome;
		env.HOME = fakeHome;
		// Steers `os.tmpdir()` inside the child — see the F3 note above.
		env.TEMP = childTmpDir;
		env.TMP = childTmpDir;
		env.TMPDIR = childTmpDir;
		Object.assign(env, extraEnv);

		const child = spawn(process.execPath, [CHILD_FIXTURE], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`probe child timed out after ${CHILD_TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
				),
			);
		}, CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						`probe child exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
					),
				);
				return;
			}
			const read = (label: string): string => {
				const line = stdout
					.split(/\r?\n/)
					.find((candidate) => candidate.startsWith(`${label}:`));
				if (!line) {
					throw new Error(
						`child stdout carried no ${label} line: ${stdout}\nstderr: ${stderr}`,
					);
				}
				return line.slice(label.length + 1).trim();
			};
			try {
				resolve({
					tmpdir: read("tmpdir"),
					globalDir: read("global-dir"),
					logDir: read("log-dir"),
					toolsDir: read("tools-dir"),
				});
			} catch (error) {
				reject(error as Error);
			}
		});
	});
}

/** A fresh throwaway tree plus the two directories every case needs. */
function makeFixture(slug: string): {
	root: string;
	fakeHome: string;
	/** A temp dir for the child that contains NOTHING else in the fixture. */
	isolatedTmp: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-${slug}-`));
	const fakeHome = path.join(root, "fake-real-home");
	const isolatedTmp = path.join(root, "child-tmp");
	fs.mkdirSync(fakeHome, { recursive: true });
	fs.mkdirSync(isolatedTmp, { recursive: true });
	return { root, fakeHome, isolatedTmp };
}

/**
 * The anti-vacuity guard for the two branches that must NOT be reachable via
 * the tmpdir branch. `isolatedTmp` is a sibling of the fixture cwd, so a cwd
 * under it would mean the case proves nothing about its own branch.
 */
function expectCwdOutsideChildTmpdir(facts: ChildFacts, cwd: string): void {
	const normalizedTmp = path.resolve(facts.tmpdir);
	expect(path.resolve(cwd).startsWith(normalizedTmp + path.sep)).toBe(false);
	expect(path.resolve(cwd)).not.toBe(normalizedTmp);
}

describe("getGlobalPiLensLogDir probe-home redirect (#2506)", () => {
	it("redirects a worktree probe's LOGS while leaving tools/registry on the real home", async () => {
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-worktree");
		// Deliberately NESTED below the worktree: the probe home must anchor at
		// the worktree itself, not at whatever directory the probe happened to
		// run from (F5). A per-cwd anchor would scatter one worktree's probe
		// logs across a directory per subfolder.
		const worktree = path.join(root, ".claude", "worktrees", "agent-x");
		const probeCwd = path.join(worktree, "clients");
		fs.mkdirSync(probeCwd, { recursive: true });

		try {
			const facts = await runChild(probeCwd, fakeHome, isolatedTmp);
			// The tmpdir branch cannot be what satisfied this case.
			expectCwdOutsideChildTmpdir(facts, probeCwd);

			// The log root moved — and anchored at the WORKTREE, not at `cwd`.
			expect(facts.logDir).toBe(path.join(worktree, ".pi-lens-probe-home"));

			// ...while every machine-global path stayed on the (fake) real home.
			// This is the whole point of the round-3 split: a pi session running
			// from a worktree must still find the tools it installed and the one
			// instances.json every other process on the box reads.
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(facts.toolsDir).toBe(path.join(fakeHome, ".pi-lens", "tools"));

			// The degradation row actually landed under the redirected log dir.
			const probeLatencyLog = path.join(facts.logDir, "latency.log");
			expect(fs.existsSync(probeLatencyLog)).toBe(true);
			const body = fs.readFileSync(probeLatencyLog, "utf8");
			expect(body).toContain("config-ignored");
			expect(body).toContain("/p/.pi-lens.json");

			// The real-home canary was never created — pre-fix, the row went here.
			expect(
				fs.existsSync(path.join(fakeHome, ".pi-lens", "latency.log")),
			).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("redirects a probe whose cwd is under os.tmpdir() with no worktree segment", async () => {
		const { root, fakeHome } = makeFixture("probe-tmpdir");
		// No `.claude/worktrees` anywhere in this path and no PILENS_PROBE: the
		// tmpdir branch is the ONLY thing that can fire here.
		const probeCwd = path.join(root, "scratch-probe");
		fs.mkdirSync(probeCwd, { recursive: true });

		try {
			// The child's os.tmpdir() IS the fixture root, so cwd sits under it.
			const facts = await runChild(probeCwd, fakeHome, root);
			expect(
				path.resolve(probeCwd).startsWith(path.resolve(facts.tmpdir)),
			).toBe(true);
			expect(probeCwd).not.toContain(".claude");

			expect(facts.logDir).toBe(path.join(probeCwd, ".pi-lens-probe-home"));
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(facts.toolsDir).toBe(path.join(fakeHome, ".pi-lens", "tools"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("PILENS_PROBE=1 forces the redirect from an ordinary checkout neither branch would catch", async () => {
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-force");
		// Neither under `.claude/worktrees/` nor under the child's os.tmpdir():
		// only the explicit force can fire here.
		const ordinaryCwd = path.join(root, "ordinary-project");
		fs.mkdirSync(ordinaryCwd, { recursive: true });

		try {
			const facts = await runChild(ordinaryCwd, fakeHome, isolatedTmp, {
				PILENS_PROBE: "1",
			});
			expectCwdOutsideChildTmpdir(facts, ordinaryCwd);
			expect(ordinaryCwd).not.toContain(".claude");

			expect(facts.logDir).toBe(path.join(ordinaryCwd, ".pi-lens-probe-home"));
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("leaves an ordinary checkout alone when nothing marks it as a probe", async () => {
		// The negative case. Without it, an unconditional redirect — the
		// simplest possible over-fix — would pass every other test in this file.
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-none");
		const ordinaryCwd = path.join(root, "ordinary-project");
		fs.mkdirSync(ordinaryCwd, { recursive: true });

		try {
			const facts = await runChild(ordinaryCwd, fakeHome, isolatedTmp);
			expectCwdOutsideChildTmpdir(facts, ordinaryCwd);

			const realHome = path.join(fakeHome, ".pi-lens");
			expect(facts.logDir).toBe(realHome);
			expect(facts.globalDir).toBe(realHome);
			expect(fs.existsSync(path.join(ordinaryCwd, ".pi-lens-probe-home"))).toBe(
				false,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("never claims the SHARED .claude/worktrees parent as a probe home", async () => {
		// F5, the cross-agent collision. Round 2's trailing `(\/|$)` alternative
		// matched a cwd of `.claude/worktrees` itself, so a probe run from there
		// would have put its probe home in the directory EVERY concurrent agent
		// on the box shares. The redirect must require a specific worktree.
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-shared-parent");
		const sharedParent = path.join(root, ".claude", "worktrees");
		fs.mkdirSync(sharedParent, { recursive: true });

		try {
			const facts = await runChild(sharedParent, fakeHome, isolatedTmp);
			expectCwdOutsideChildTmpdir(facts, sharedParent);

			expect(facts.logDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(
				fs.existsSync(path.join(sharedParent, ".pi-lens-probe-home")),
			).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	// round 3 (#2515/#2516): `isUnderRealDir` (probe-home-state.ts:247-248)
	// realpath-resolves BOTH sides of the tmpdir containment check before
	// comparing them. Off Windows that is the only thing that makes the
	// tmpdir branch fire when `os.tmpdir()` itself is a symlink — macOS's
	// `/var` -> `/private/var` is the textbook case, but any Linux box with
	// TMPDIR pointed at a symlinked directory hits the identical shape. A
	// plain `isUnderDir` (no realpath) would never see the symlinked tmpdir
	// and the literal, real cwd as related, and this case would go red.
	// Windows is excluded deliberately: this repo's path handling already
	// resolves through `normalizeFilePath` elsewhere on that platform, and
	// creating a real filesystem symlink from an unprivileged Windows
	// process is unreliable — this case runs only in the ubuntu Unit tests
	// CI lane.
	it.runIf(process.platform !== "win32")(
		"resolves a symlinked TMPDIR to its real target before the containment check",
		async () => {
			const { root, fakeHome } = makeFixture("probe-tmpdir-symlink");
			const realTmpTarget = path.join(root, "real-tmp-target");
			const tmpSymlink = path.join(root, "tmp-symlink");
			fs.mkdirSync(realTmpTarget, { recursive: true });
			fs.symlinkSync(realTmpTarget, tmpSymlink, "dir");

			// The child's cwd sits INSIDE THE REAL directory, not through the
			// symlink — TMPDIR points the child's `os.tmpdir()` at the symlink,
			// so the two only relate once both are realpath-resolved.
			const probeCwd = path.join(realTmpTarget, "scratch-probe");
			fs.mkdirSync(probeCwd, { recursive: true });

			try {
				const facts = await runChild(probeCwd, fakeHome, tmpSymlink);
				// The child really did see the SYMLINK path, unresolved — proving
				// the redirect below can only have matched via realpath, not
				// because the literal paths already agreed.
				expect(facts.tmpdir).toBe(tmpSymlink);
				expect(facts.logDir).toBe(path.join(probeCwd, ".pi-lens-probe-home"));
				expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		40_000,
	);
});

describe("probe-home resolution is memoized per process (#2506 F5)", () => {
	const savedHome = process.env.PI_LENS_HOME;
	const savedProbe = process.env.PILENS_PROBE;
	const savedCwd = process.cwd();

	afterEach(() => {
		process.chdir(savedCwd);
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedProbe === undefined) delete process.env.PILENS_PROBE;
		else process.env.PILENS_PROBE = savedProbe;
		_resetProbeHomeRedirectStateForTests();
	});

	it("resolves once and holds that answer across a process.chdir()", () => {
		// Round 2 read `process.cwd()` live on every call, so one process could
		// scatter its logs across three roots as it chdir'd. The resolution is
		// a property of the PROCESS, decided once.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-memo-"));
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		fs.mkdirSync(first, { recursive: true });
		fs.mkdirSync(second, { recursive: true });

		try {
			delete process.env.PI_LENS_HOME;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();

			process.chdir(first);
			const before = getGlobalPiLensLogDir();
			expect(before).toBe(
				path.join(fs.realpathSync(first), ".pi-lens-probe-home"),
			);

			process.chdir(second);
			// Same answer despite a different cwd: memoized, not re-derived.
			expect(getGlobalPiLensLogDir()).toBe(before);

			// ...and the reset really does clear the memo, so the helper is not
			// a no-op the way round 2's orphaned version was (F6).
			_resetProbeHomeRedirectStateForTests();
			expect(getGlobalPiLensLogDir()).toBe(
				path.join(fs.realpathSync(second), ".pi-lens-probe-home"),
			);
		} finally {
			process.chdir(savedCwd);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("an explicit PI_LENS_HOME pin still wins over the redirect", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-pin-"));
		try {
			process.env.PI_LENS_HOME = root;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();
			// Both resolvers honour the pin — this is how vitest stays hermetic.
			expect(getGlobalPiLensLogDir()).toBe(path.resolve(root));
			expect(getGlobalPiLensDir()).toBe(path.resolve(root));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the probe home is gitignored (#2506 F2)", () => {
	it("git check-ignore accepts a file under .pi-lens-probe-home/", () => {
		// Without this entry every agent worktree that ever ran one probe is
		// dirty forever, and #2435's aged worktree sweep — which only removes
		// CLEAN worktrees — can never reap it.
		const probed = execFileSync(
			"git",
			["check-ignore", "-v", ".pi-lens-probe-home/latency.log"],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		// check-ignore -v prints "<source>:<line>:<pattern>\t<path>", so this
		// also proves the match came from .gitignore rather than from an
		// ambient exclude file.
		expect(probed).toContain(".gitignore");
		expect(probed).toContain(".pi-lens-probe-home/");
	});

	it("the ignore rule is anchored to the directory, not a loose glob", () => {
		const gitignore = fs.readFileSync(
			path.join(REPO_ROOT, ".gitignore"),
			"utf8",
		);
		expect(gitignore).toContain(".pi-lens-probe-home/");
	});
});

describe("a VITEST-marked process with no PI_LENS_HOME pin (#2516 round 2)", () => {
	// THE hermeticity hole round 2 opened. `computeProbeHomeDir` opened with
	// `if (isTestMode()) return undefined;`, and `isTestMode()` is true for
	// anything carrying `VITEST` — including processes vitest starts that
	// `tests/support/vitest-setup.ts` never reaches: globalSetup, and any child
	// they spawn. Those have `VITEST` set and NO `PI_LENS_HOME`, so the guard
	// sent every one of them straight to the developer's real `~/.pi-lens` —
	// the exact leak #2506 exists to stop, re-opened by the fix for it.
	//
	// A real spawned child is load-bearing: `VITEST` present with no home pin
	// is a property of a process's environment at import time, and this worker
	// has the pin. Deleting the redirect (the pre-round-2 state) makes this
	// case resolve to `<fakeHome>/.pi-lens` instead.
	it("still redirects to the probe home rather than the real home", async () => {
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-vitest-marked");
		const worktree = path.join(root, ".claude", "worktrees", "agent-vitest");
		const probeCwd = path.join(worktree, "clients");
		fs.mkdirSync(probeCwd, { recursive: true });

		try {
			const facts = await runChild(probeCwd, fakeHome, isolatedTmp, {
				VITEST: "1",
			});
			// Neither the tmpdir branch nor the PILENS_PROBE force can be what
			// satisfies this: `runChild` deletes PILENS_PROBE, and the child's
			// own os.tmpdir() is a sibling of the fixture cwd.
			expectCwdOutsideChildTmpdir(facts, probeCwd);

			expect(facts.logDir).toBe(path.join(worktree, ".pi-lens-probe-home"));
			expect(facts.logDir).not.toBe(path.join(fakeHome, ".pi-lens"));
			// ...and nothing was written into the stand-in for the real home.
			expect(
				fs.existsSync(path.join(fakeHome, ".pi-lens", "latency.log")),
			).toBe(false);
			// Machine-global state is still NOT redirected, VITEST or not.
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);
});

describe("the log-dir resolver is reachable without a cycle (#2516 round 2)", () => {
	// WHY THIS IS A TEST AND NOT A COMMENT. Round 2 kept the resolver in
	// `file-utils.ts` and made it survive by placing an `isTestMode()` early
	// return ahead of the first module-scope binding it dereferenced. That is
	// load-order luck: `file-utils.ts` is on an import cycle, its FIFTH import
	// (`spawn-timeout-cooldown.js`) is what re-enters it, and moving the guard's
	// own `isTestMode` import after that point makes the GUARD LINE throw
	// `ReferenceError: Cannot access '__vite_ssr_import_N__' before
	// initialization`. Reproduced both ways while writing this.
	//
	// The invariant that makes import order irrelevant is structural: the
	// resolver lives in a module that is off every cycle, so it is fully
	// evaluated before any importer's body runs. These cases pin exactly that,
	// derived from the source rather than hand-listed.
	const CLIENTS = path.join(REPO_ROOT, "clients");

	/**
	 * Every relative specifier a `clients/` module imports, as repo paths.
	 * Matches both `import ... from "./x.js"` / `export ... from "./x.js"`
	 * AND a bare side-effect `import "./x.js";` with no `from` clause — the
	 * first pattern alone missed the second (round 3, #2515/#2516), which
	 * would have let a bare import re-establish a walked-around cycle edge
	 * without this walk ever noticing.
	 */
	function localImportsOf(relative: string): string[] {
		const source = fs.readFileSync(path.join(CLIENTS, relative), "utf8");
		const dir = path.dirname(relative);
		const found: string[] = [];
		for (const match of source.matchAll(
			/^\s*(?:import|export)[\s\S]*?from\s+"(\.[^"]+)";|^\s*import\s+"(\.[^"]+)";/gm,
		)) {
			const specifier = match[1] ?? match[2];
			const resolved = path
				.normalize(path.join(dir, specifier.replace(/\.js$/, ".ts")))
				.replace(/\\/g, "/");
			if (fs.existsSync(path.join(CLIENTS, resolved))) found.push(resolved);
		}
		return found;
	}

	it("probe-home-state.ts's transitive imports never reach file-utils.ts", () => {
		const seen = new Set<string>();
		const queue = ["probe-home-state.ts"];
		while (queue.length > 0) {
			const next = queue.shift() as string;
			if (seen.has(next)) continue;
			seen.add(next);
			queue.push(...localImportsOf(next));
		}
		// Anti-vacuity: the walk really did traverse something.
		expect(seen.size).toBeGreaterThan(1);
		expect([...seen].sort()).not.toContain("file-utils.ts");
		// Every module the resolver reached through before the move, named
		// explicitly so that pulling any one of them back in fails loudly
		// rather than silently re-arming the TDZ. Each is on, or one edge from,
		// a no-client-cycles cycle.
		for (const onCycle of [
			"file-utils.ts",
			"safe-spawn.ts",
			"degradation-ledger.ts",
			"extension-log.ts",
			"log-cleanup.ts",
			"spawn-timeout-cooldown.ts",
		]) {
			expect([...seen]).not.toContain(onCycle);
		}
	});

	it("file-utils.ts neither defines nor re-exports getGlobalPiLensLogDir", () => {
		// If it drifts back, every log-family module's module-top-level call
		// resolves through a module record that can be mid-initialization again.
		const source = fs.readFileSync(path.join(CLIENTS, "file-utils.ts"), "utf8");
		expect(source).not.toMatch(/^export .*getGlobalPiLensLogDir/m);
		// ...and the machine-state sibling really is still there, so this case
		// cannot pass by the file having been renamed out from under it.
		expect(source).toMatch(/^export function getGlobalPiLensDir\(\)/m);
	});
});

describe("the recorded resolution is visible through the leaf's reader (#2506)", () => {
	// The write side and the read side agreeing end to end, in one process:
	// `getGlobalPiLensLogDir()` stores the decision, and the reader
	// `degradation-ledger.ts` folds at summary time returns the same fact. A
	// drift between them would mean the ledger never sees a redirect that
	// actually happened.
	it("stores the redirect the resolver returned, event and all", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-slot-"));
		const savedHome = process.env.PI_LENS_HOME;
		const savedProbe = process.env.PILENS_PROBE;
		const savedCwd = process.cwd();
		try {
			delete process.env.PI_LENS_HOME;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();
			process.chdir(root);

			const resolved = getGlobalPiLensLogDir();
			const stored = getProbeHomeResolution();
			expect(stored?.probeHome).toBe(resolved);
			expect(stored?.event?.probeHome).toBe(resolved);
			expect(stored?.event?.cwd).toBe(process.cwd());
		} finally {
			process.chdir(savedCwd);
			if (savedHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = savedHome;
			if (savedProbe === undefined) delete process.env.PILENS_PROBE;
			else process.env.PILENS_PROBE = savedProbe;
			_resetProbeHomeRedirectStateForTests();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// round 3 (#2515/#2516): the reason string used to say "PI_LENS_HOME
	// unset outside test mode", a leftover from the #2516 round 2 `isTestMode()`
	// guard that this module's redirect no longer has — `computeProbeHomeDir`
	// fires under vitest too (globalSetup, children spawned without the
	// `PI_LENS_HOME` pin), and via `PILENS_PROBE=1` from an ordinary checkout
	// that vitest never touches at all. The old text told a reader the redirect
	// was test-mode-scoped when it is not.
	it("describes the actual trigger, not a removed test-mode gate", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-probe-reason-"),
		);
		const savedHome = process.env.PI_LENS_HOME;
		const savedProbe = process.env.PILENS_PROBE;
		const savedCwd = process.cwd();
		try {
			delete process.env.PI_LENS_HOME;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();
			process.chdir(root);
			getGlobalPiLensLogDir();

			const group = getDegradationSummary().find(
				(entry) => entry.kind === "global-dir-probe-redirect",
			);
			const reason = group?.latestReasons[0]?.reason ?? "";
			expect(reason).not.toContain("outside test mode");
			expect(reason).toContain("PILENS_PROBE=1");
		} finally {
			process.chdir(savedCwd);
			if (savedHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = savedHome;
			if (savedProbe === undefined) delete process.env.PILENS_PROBE;
			else process.env.PILENS_PROBE = savedProbe;
			_resetProbeHomeRedirectStateForTests();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
