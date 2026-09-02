import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, statSync: statSyncMock };
});

import {
	mergeWindowsEnvironment,
	resetSafeSpawnWindowsCommandCache,
	resolveWindowsCommandForEnvironment,
} from "../../clients/safe-spawn.js";

// Absolute fixtures keep pure resolver tests independent from process.cwd;
// relative-cwd/PATH behavior is covered explicitly in the dedicated cases.
const WINDOWS_TEST_ROOT = "C:\\__pi_lens_safe_spawn_tests__";

function winAbsolute(...segments: string[]): string {
	return path.win32.join(WINDOWS_TEST_ROOT, ...segments);
}

function markFilesAsPresent(...files: string[]): void {
	const present = new Set(files);
	statSyncMock.mockImplementation((candidate: unknown) => {
		if (present.has(String(candidate))) return { isFile: () => true };
		throw new Error("ENOENT");
	});
}

describe("Windows command resolution against a child environment (#1199)", () => {
	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
	});

	it("resolves the Knip managed-bin call shape from caller PATH, not ambient PATH", () => {
		const ambientBin = winAbsolute("ambient", "node_modules", ".bin");
		const managedBin = winAbsolute("managed", "node_modules", ".bin");
		const managedKnip = path.win32.join(managedBin, "knip.cmd");
		markFilesAsPresent(managedKnip);

		// This is the environment shape supplied by KnipClient: both Windows
		// spellings are present and the managed directory is first.
		const knipEnv = mergeWindowsEnvironment(
			{ PATH: ambientBin, Path: ambientBin, PATHEXT: ".EXE" },
			{ PATH: managedBin, Path: managedBin, PATHEXT: ".CMD;.EXE" },
		);
		const resolved = resolveWindowsCommandForEnvironment(
			"knip",
			winAbsolute("workspace", "project"),
			knipEnv,
		);

		expect(resolved).toEqual({ resolvedPath: managedKnip, ext: ".cmd" });
	});

	/**
	 * #1221 / #1289: RESOLVER-LEVEL locks only. #1199's acceptance criteria
	 * asked for managed-npm-path coverage of Knip, Madge, jscpd, and Biome —
	 * but today only Knip's client actually constructs a managed environment
	 * and threads it into its spawn (`getKnipEnvironment`); the madge/jscpd
	 * availability probes pass no `env` at all, and Biome resolves through
	 * `npx`, never a bare `biome` (#1289 tracks that plumbing gap). Until
	 * #1289 lands, client-level tests asserting managed-env spawn options are
	 * unwritable, so these cases lock the RESOLVER seam those clients will be
	 * routed through: caller-supplied PATH is consulted, ambient
	 * `process.env.PATH` is not. The first block has regression teeth (a
	 * resolver reverted to ambient `process.env.PATH`, the pre-#1199 defect in
	 * `f7387277~1`, finds no file and returns `null`); the second block is an
	 * INVARIANT LOCK — it also passes on the pre-#1199 resolver (which finds
	 * nothing under the mocked fs either) and exists to pin caller-PATH
	 * authority against future additive-merge regressions.
	 */
	it.each(["madge", "jscpd", "biome"])(
		"resolver-level: resolves the %s managed-bin shape from caller PATH, not ambient PATH",
		(tool) => {
			const ambientBin = winAbsolute("ambient", "node_modules", ".bin");
			const managedBin = winAbsolute("managed", "node_modules", ".bin");
			const managedShim = path.win32.join(managedBin, `${tool}.cmd`);
			markFilesAsPresent(managedShim);

			const toolEnv = mergeWindowsEnvironment(
				{ PATH: ambientBin, Path: ambientBin, PATHEXT: ".EXE" },
				{ PATH: managedBin, Path: managedBin, PATHEXT: ".CMD;.EXE" },
			);
			const resolved = resolveWindowsCommandForEnvironment(
				tool,
				winAbsolute("workspace", "project"),
				toolEnv,
			);

			expect(resolved).toEqual({ resolvedPath: managedShim, ext: ".cmd" });
		},
	);

	it.each(["madge", "jscpd", "biome"])(
		"invariant lock: never falls back to an ambient %s shim once a caller PATH is supplied",
		(tool) => {
			// The inverse of the case above: an ambient-only shim (nothing in the
			// caller-supplied managed PATH) must NOT resolve, proving the caller
			// PATH is authoritative rather than merely additive/ignored.
			const ambientBin = winAbsolute("ambient", "node_modules", ".bin");
			const managedBin = winAbsolute("managed", "node_modules", ".bin");
			markFilesAsPresent(path.win32.join(ambientBin, `${tool}.cmd`));

			const toolEnv = mergeWindowsEnvironment(
				{ PATH: ambientBin, Path: ambientBin, PATHEXT: ".EXE" },
				{ PATH: managedBin, Path: managedBin, PATHEXT: ".CMD;.EXE" },
			);

			expect(
				resolveWindowsCommandForEnvironment(
					tool,
					winAbsolute("workspace", "project"),
					toolEnv,
				),
			).toBeNull();
		},
	);

	it("lets a caller PATH override every ambient PATH/Path casing and emits one key", () => {
		const ambient = { PATH: "ambient-path", Path: "ambient-duplicate" };
		const merged = mergeWindowsEnvironment(ambient, { pAtH: "caller-path" });
		const pathEntries = Object.entries(merged).filter(
			([key]) => key.toLowerCase() === "path",
		);

		expect(pathEntries).toEqual([["pAtH", "caller-path"]]);
	});

	it("reads PATH and PATHEXT case-insensitively", () => {
		const bin = winAbsolute("case-variant", "bin");
		const executable = path.win32.join(bin, "tool.cmd");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, {
				pAtH: bin,
				pAtHeXt: ".CmD",
			}),
		).toEqual({ resolvedPath: executable, ext: ".cmd" });
	});

	it("does not reuse a cached result across PATH or PATHEXT changes", () => {
		const cmdBin = winAbsolute("first", "bin");
		const exeBin = winAbsolute("second", "bin");
		const cmdPath = path.win32.join(cmdBin, "cache-tool.cmd");
		const exePath = path.win32.join(exeBin, "cache-tool.exe");
		markFilesAsPresent(cmdPath, exePath);

		const first = resolveWindowsCommandForEnvironment("cache-tool", "cwd", {
			Path: cmdBin,
			PATHEXT: ".CMD",
		});
		const callsAfterFirst = statSyncMock.mock.calls.length;
		const second = resolveWindowsCommandForEnvironment("cache-tool", "cwd", {
			PATH: exeBin,
			PATHEXT: ".EXE",
		});
		const callsAfterSecond = statSyncMock.mock.calls.length;
		const secondAgain = resolveWindowsCommandForEnvironment(
			"cache-tool",
			"cwd",
			{
				PATH: exeBin,
				PATHEXT: ".EXE",
			},
		);

		expect(first).toEqual({ resolvedPath: cmdPath, ext: ".cmd" });
		expect(second).toEqual({ resolvedPath: exePath, ext: ".exe" });
		expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
		expect(secondAgain).toEqual(second);
		// A positive cache hit re-stats exactly once so deletion/replacement is
		// visible immediately; it must not repeat the PATH/PATHEXT candidate walk.
		expect(statSyncMock.mock.calls.length).toBe(callsAfterSecond + 1);
	});

	it("uses win32 parsing for explicit relative paths on every host OS", () => {
		const cwd = winAbsolute("workspace", "project");
		const relativeCommand = path.win32.join("tools", "tool.exe");
		const resolvedPath = path.win32.resolve(cwd, relativeCommand);
		markFilesAsPresent(resolvedPath);

		expect(
			resolveWindowsCommandForEnvironment(relativeCommand, cwd, {}),
		).toEqual({ resolvedPath, ext: ".exe" });
	});

	it("treats a drive-relative command as an explicit path, never as a PATH name", () => {
		const cwd = path.win32.join("C:\\workspace", "project");
		const command = "C:tool.exe";
		const resolvedPath = path.win32.resolve(cwd, command);
		const unrelatedPathTool = path.win32.join("C:\\unrelated", "tool.exe");
		markFilesAsPresent(resolvedPath, unrelatedPathTool);

		expect(
			resolveWindowsCommandForEnvironment(command, cwd, {
				PATH: path.win32.dirname(unrelatedPathTool),
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath, ext: ".exe" });
	});

	it("fails closed for a different-drive command without per-drive provenance", () => {
		const cwd = "C:\\workspace\\project";
		const unrelatedPathTool = "C:\\unrelated\\tool.exe";
		markFilesAsPresent(unrelatedPathTool);

		expect(
			resolveWindowsCommandForEnvironment("D:tool.exe", cwd, {
				PATH: "C:\\unrelated",
				PATHEXT: ".EXE",
			}),
		).toBeNull();
	});

	it("uses validated per-drive provenance for a different-drive command", () => {
		const cwd = "C:\\workspace\\project";
		const perDriveCwd = "D:\\users\\tooling";
		const resolvedPath = path.win32.resolve(perDriveCwd, "D:tool.exe");
		markFilesAsPresent(resolvedPath);

		expect(
			resolveWindowsCommandForEnvironment("D:tool.exe", cwd, {
				PATH: "C:\\unrelated",
				"=D:": perDriveCwd,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath, ext: ".exe" });
	});

	it("rejects malformed or wrong-drive per-drive provenance", () => {
		const cwd = "C:\\workspace\\project";
		const command = "D:tool.exe";
		const unrelatedPathTool = "C:\\unrelated\\tool.exe";
		markFilesAsPresent(unrelatedPathTool);

		for (const provenance of ["D:relative", "C:\\wrong-drive"]) {
			expect(
				resolveWindowsCommandForEnvironment(command, cwd, {
					PATH: "C:\\unrelated",
					"=D:": provenance,
					PATHEXT: ".EXE",
				}),
			).toBeNull();
		}
	});

	it("fails closed for a drive-relative child cwd without provenance", () => {
		markFilesAsPresent("D:\\users\\tooling\\bin\\tool.exe");

		expect(
			resolveWindowsCommandForEnvironment("tool", "D:child", {
				PATH: "bin",
				PATHEXT: ".EXE",
			}),
		).toBeNull();
	});

	it("uses validated provenance for a drive-relative child cwd", () => {
		const perDriveCwd = "D:\\users\\tooling";
		const expected = path.win32.resolve(
			perDriveCwd,
			"D:child",
			"bin",
			"tool.exe",
		);
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "D:child", {
				PATH: "bin",
				"=D:": perDriveCwd,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("fails closed for a drive-relative PATH entry without provenance", () => {
		const expected = "D:\\untrusted\\bin\\tool.exe";
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "C:\\workspace", {
				PATH: "D:bin",
				PATHEXT: ".EXE",
			}),
		).toBeNull();
	});

	it("resolves a drive-relative PATH entry only with validated provenance", () => {
		const perDriveCwd = "D:\\users\\tooling";
		const expected = path.win32.resolve(perDriveCwd, "D:bin", "tool.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "C:\\workspace", {
				PATH: "D:bin",
				"=D:": perDriveCwd,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	// #1201: `process.chdir` is safe here only because this repo's vitest
	// config pins the `forks` pool everywhere (each test file gets its own
	// process, so mutating the process-wide cwd can't race a sibling test) —
	// it would throw under the `threads` pool. And `os.tmpdir()` itself can
	// diverge from what `process.cwd()` reports after a `chdir` into it
	// (macOS symlinks `/var` -> `/private/var`), so the expected path is
	// built from `fs.realpathSync` of the directory actually chdir'd into,
	// not the raw `mkdtempSync` result — otherwise this suite could
	// spuriously fail on macOS CI while passing on Linux/Windows.
	it("resolves relative PATH entries against the effective child cwd", () => {
		const originalCwd = process.cwd();
		const parent = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-safe-cwd-")),
		);
		const child = path.join(parent, "child");
		fs.mkdirSync(child);
		const expectedCwd = path.win32.resolve(parent, "child");
		const expected = path.win32.join(expectedCwd, "bin", "tool.exe");
		markFilesAsPresent(expected);
		try {
			process.chdir(parent);
			expect(
				resolveWindowsCommandForEnvironment("tool", "child", {
					PATH: "bin",
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: expected, ext: ".exe" });
		} finally {
			process.chdir(originalCwd);
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	it("re-resolves a relative child cwd when process.chdir changes", () => {
		const originalCwd = process.cwd();
		const firstParent = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-safe-cwd-a-")),
		);
		const secondParent = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-safe-cwd-b-")),
		);
		const command = "tools\\tool.exe";
		const firstResolved = path.win32.resolve(firstParent, "child", command);
		const secondResolved = path.win32.resolve(secondParent, "child", command);
		markFilesAsPresent(firstResolved, secondResolved);
		try {
			process.chdir(firstParent);
			expect(
				resolveWindowsCommandForEnvironment(command, "child", {
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: firstResolved, ext: ".exe" });
			process.chdir(secondParent);
			expect(
				resolveWindowsCommandForEnvironment(command, "child", {
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: secondResolved, ext: ".exe" });
		} finally {
			process.chdir(originalCwd);
			fs.rmSync(firstParent, { recursive: true, force: true });
			fs.rmSync(secondParent, { recursive: true, force: true });
		}
	});

	it("uses the effective process cwd in cache identity when cwd is omitted", () => {
		const originalCwd = process.cwd();
		const firstCwd = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-safe-spawn-cache-first-")),
		);
		const secondCwd = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-safe-spawn-cache-second-"),
			),
		);
		const command = "tools\\cache-tool.exe";
		const firstResolvedPath = path.win32.resolve(firstCwd, command);
		const secondResolvedPath = path.win32.resolve(secondCwd, command);
		markFilesAsPresent(firstResolvedPath, secondResolvedPath);

		try {
			process.chdir(firstCwd);
			expect(
				resolveWindowsCommandForEnvironment(command, undefined, {
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: firstResolvedPath, ext: ".exe" });

			process.chdir(secondCwd);
			expect(
				resolveWindowsCommandForEnvironment(command, undefined, {
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: secondResolvedPath, ext: ".exe" });
		} finally {
			process.chdir(originalCwd);
			fs.rmSync(firstCwd, { recursive: true, force: true });
			fs.rmSync(secondCwd, { recursive: true, force: true });
		}
	});

	it("honors an explicit extension even when PATHEXT omits it", () => {
		const bin = winAbsolute("explicit-extension", "bin");
		const executable = path.win32.join(bin, "tool.cmd");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool.cmd", undefined, {
				PATH: bin,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: executable, ext: ".cmd" });
	});

	it("follows PATHEXT order for a bare command", () => {
		const bin = winAbsolute("pathext-order", "bin");
		const exe = path.win32.join(bin, "tool.exe");
		const cmd = path.win32.join(bin, "tool.cmd");
		markFilesAsPresent(exe, cmd);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, {
				PATH: bin,
				PATHEXT: ".EXE;.CMD",
			}),
		).toEqual({ resolvedPath: exe, ext: ".exe" });
	});

	it("clears session resolution entries", () => {
		const bin = winAbsolute("session-reset", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		markFilesAsPresent(executable);
		const env = { PATH: bin, PATHEXT: ".EXE" };

		const first = resolveWindowsCommandForEnvironment("tool", undefined, env);
		const callsAfterFirst = statSyncMock.mock.calls.length;
		resetSafeSpawnWindowsCommandCache();
		const second = resolveWindowsCommandForEnvironment("tool", undefined, env);

		expect(first).toEqual({ resolvedPath: executable, ext: ".exe" });
		expect(second).toEqual(first);
		expect(statSyncMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});

	it("revalidates a cached positive result after deletion without a reset", () => {
		const bin = winAbsolute("positive-revalidate", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		const env = { PATH: bin, PATHEXT: ".EXE" };
		markFilesAsPresent(executable);
		expect(resolveWindowsCommandForEnvironment("tool", undefined, env)).toEqual(
			{
				resolvedPath: executable,
				ext: ".exe",
			},
		);
		markFilesAsPresent();
		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, env),
		).toBeNull();
	});

	it("expires a cached negative result after the bounded TTL", () => {
		const bin = winAbsolute("negative-ttl", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		const env = { PATH: bin, PATHEXT: ".EXE" };
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
		try {
			markFilesAsPresent();
			expect(
				resolveWindowsCommandForEnvironment("tool", undefined, env),
			).toBeNull();
			markFilesAsPresent(executable);
			vi.advanceTimersByTime(1001);
			expect(
				resolveWindowsCommandForEnvironment("tool", undefined, env),
			).toEqual({ resolvedPath: executable, ext: ".exe" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("reset invalidates a cached negative result after an install", () => {
		const bin = winAbsolute("stale-negative", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		const env = { PATH: bin, PATHEXT: ".EXE" };
		markFilesAsPresent();
		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, env),
		).toBeNull();
		markFilesAsPresent(executable);
		resetSafeSpawnWindowsCommandCache();
		expect(resolveWindowsCommandForEnvironment("tool", undefined, env)).toEqual(
			{
				resolvedPath: executable,
				ext: ".exe",
			},
		);
	});

	it("reset invalidates a cached positive result after deletion", () => {
		const bin = winAbsolute("stale-positive", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		const env = { PATH: bin, PATHEXT: ".EXE" };
		markFilesAsPresent(executable);
		expect(resolveWindowsCommandForEnvironment("tool", undefined, env)).toEqual(
			{
				resolvedPath: executable,
				ext: ".exe",
			},
		);
		markFilesAsPresent();
		resetSafeSpawnWindowsCommandCache();
		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, env),
		).toBeNull();
	});

	it("evicts the oldest session entry at the cache bound", () => {
		const entries = Array.from({ length: 257 }, (_, index) => {
			const bin = winAbsolute("bounded-cache", String(index));
			const command = `tool-${index}.exe`;
			return {
				bin,
				command,
				resolvedPath: path.win32.join(bin, command),
			};
		});
		markFilesAsPresent(...entries.map((entry) => entry.resolvedPath));

		for (const entry of entries) {
			expect(
				resolveWindowsCommandForEnvironment(entry.command, undefined, {
					PATH: entry.bin,
					PATHEXT: ".EXE",
				}),
			).toEqual({ resolvedPath: entry.resolvedPath, ext: ".exe" });
		}

		const callsBeforeOldestRetry = statSyncMock.mock.calls.length;
		const oldest = entries[0];
		expect(oldest).toBeDefined();
		const retried = resolveWindowsCommandForEnvironment(
			oldest.command,
			undefined,
			{ PATH: oldest.bin, PATHEXT: ".EXE" },
		);
		expect(retried).toEqual({ resolvedPath: oldest.resolvedPath, ext: ".exe" });
		expect(statSyncMock.mock.calls.length).toBeGreaterThan(
			callsBeforeOldestRetry,
		);
	});

	it("distinguishes absent PATHEXT from an explicitly empty PATHEXT", () => {
		const bin = winAbsolute("empty-pathext", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, {
				PATH: bin,
				PATHEXT: "",
			}),
		).toBeNull();
		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, { PATH: bin }),
		).toEqual({ resolvedPath: executable, ext: ".exe" });
	});

	it("distinguishes absent PATHEXT after an explicit empty lookup", () => {
		const bin = winAbsolute("empty-pathext-reverse", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, { PATH: bin }),
		).toEqual({ resolvedPath: executable, ext: ".exe" });
		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, {
				PATH: bin,
				PATHEXT: "",
			}),
		).toBeNull();
	});

	it("keeps the default PATHEXT behavior when the caller supplies no PATHEXT", () => {
		const bin = winAbsolute("default", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, { PATH: bin }),
		).toEqual({ resolvedPath: executable, ext: ".exe" });
	});
});
