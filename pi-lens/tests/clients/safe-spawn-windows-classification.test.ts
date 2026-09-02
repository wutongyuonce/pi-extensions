/**
 * #1201 scoped-re-review gaps: the three fix commits shipped with zero tests.
 * Nothing in tests/clients/safe-spawn* covered the path-classification
 * helpers (`isFullyQualifiedWindowsPath` / `isRootedWindowsPath` /
 * `resolveRootedWindowsPath`), the explicit-extension resolution fix, or the
 * drive-less-cwd regression — and the move to absolute `C:\` fixtures in the
 * sibling resolution suite makes it systematically *avoid* the drive-less
 * landmine rather than detect it.
 *
 * Every test here runs on every host OS. `resolveWindowsCommandForEnvironment`
 * is pure win32 string logic over a mocked `statSync`, so no Windows
 * filesystem (and no `describe.runIf(process.platform === "win32")`, which
 * would skip on Linux CI and recreate the original review's finding 4) is
 * required.
 *
 * The drive-less block stubs `process.cwd()` to the literal Linux-CI shape
 * rather than calling `process.chdir`, so the "host has no drive letters"
 * condition is reproduced identically on a Windows dev box and on Linux CI.
 * That matters: this exact divergence is how the bug in `cb60a3b8` shipped
 * green through every local run and all of CI.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: statSyncMock };
});

import {
	resetSafeSpawnWindowsCommandCache,
	resolveWindowsCommandForEnvironment,
} from "../../clients/safe-spawn.js";

function markFilesAsPresent(...files: string[]): void {
	const present = new Set(files);
	statSyncMock.mockImplementation((candidate: unknown) => {
		if (present.has(String(candidate))) return { isFile: () => true };
		throw new Error("ENOENT");
	});
}

describe("drive-less host cwd must not fail resolution closed (#1201)", () => {
	// The literal shape of `process.cwd()` on GitHub-hosted Linux runners.
	const LINUX_CI_CWD = "/home/runner/work/pi-lens/pi-lens";
	// Node permits a UNC cwd on real Windows, and `\\server\share\...` carries
	// no drive letter either — the one production-reachable instance of this
	// class.
	const UNC_CWD = "\\\\server\\share\\work";

	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubProcessCwd(value: string): void {
		vi.spyOn(process, "cwd").mockReturnValue(value);
	}

	it("resolves a relative PATH entry under a POSIX-absolute caller cwd", () => {
		stubProcessCwd(LINUX_CI_CWD);
		const expected = path.win32.resolve("/tmp/proj", "bin", "tool.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "/tmp/proj", {
				PATH: "bin",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("resolves an explicit relative command under a POSIX-absolute caller cwd", () => {
		stubProcessCwd(LINUX_CI_CWD);
		const expected = path.win32.resolve("/tmp/proj", "tools/tool.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tools/tool.exe", "/tmp/proj", {
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("resolves a rooted PATH entry under a POSIX-absolute caller cwd", () => {
		stubProcessCwd(LINUX_CI_CWD);
		const expected = path.win32.resolve("/tmp/proj/bin", "tool.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "/tmp/proj", {
				PATH: "/tmp/proj/bin",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	// The signature of the bug, independent of any particular expected path: a
	// drive-less cwd used to collapse `effectiveCwd` to `undefined`, which
	// skipped every relative and rooted PATH entry and returned `null` without
	// ever touching the filesystem. A genuine "not installed" answer always
	// stats at least one candidate first.
	it("still probes the filesystem instead of returning null with zero stats", () => {
		stubProcessCwd(LINUX_CI_CWD);
		markFilesAsPresent();

		expect(
			resolveWindowsCommandForEnvironment("tool", "/tmp/proj", {
				PATH: "bin",
				PATHEXT: ".EXE",
			}),
		).toBeNull();
		expect(statSyncMock.mock.calls.length).toBeGreaterThan(0);
	});

	it("does not fail a rooted caller cwd closed under a UNC process cwd", () => {
		stubProcessCwd(UNC_CWD);
		// A UNC drive source supplies no drive letter, so the rooted value
		// normalizes as-is rather than collapsing to `undefined` — and Node's
		// own `path.win32.resolve` then re-anchors it onto the UNC share,
		// which is what Windows does too. What this test locks is that the
		// drive-less provenance no longer produces a false ENOENT; the
		// expected path is computed through win32.resolve rather than
		// hardcoded so it stays honest about that anchoring.
		const expected = path.win32.resolve("\\tools", "bin", "tool.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "\\tools", {
				PATH: "bin",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("keeps a relative caller cwd working on a drive-less host", () => {
		stubProcessCwd(LINUX_CI_CWD);
		const expected = path.win32.resolve(
			LINUX_CI_CWD,
			"child",
			"bin",
			"tool.exe",
		);
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "child", {
				PATH: "bin",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});
});

describe("Windows path classification: rooted vs fully qualified (#1201)", () => {
	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
	});

	it("anchors a rooted PATH entry to the child cwd's drive, not the host drive", () => {
		// `path.win32.isAbsolute("\\tools")` is true, so the pre-fix classifier
		// treated `\tools` as fully qualified: it stat'd the host drive's
		// `\tools\tool.exe` and returned a drive-less path that cmd.exe would
		// then re-root on the CHILD's drive — validating one file and executing
		// another. Only the D: candidate exists here, so a host-drive lookup
		// resolves to null.
		const expected = "D:\\tools\\tool.exe";
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "D:\\work\\project", {
				PATH: "\\tools",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("anchors a rooted explicit command to the child cwd's drive root", () => {
		// Rooted means "root of the current drive", NOT "relative to the current
		// directory" — `D:\work\project` + `\tools\tool.exe` is `D:\tools\...`,
		// never `D:\work\project\tools\...`.
		const expected = "D:\\tools\\tool.exe";
		markFilesAsPresent(expected, "D:\\work\\project\\tools\\tool.exe");

		expect(
			resolveWindowsCommandForEnvironment(
				"\\tools\\tool.exe",
				"D:\\work\\project",
				{ PATHEXT: ".EXE" },
			),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("treats a UNC path as fully qualified and never re-anchors it", () => {
		const expected = "\\\\srv\\share\\bin\\tool.exe";
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tool", "D:\\work", {
				PATH: "\\\\srv\\share\\bin",
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("resolves a UNC command path directly", () => {
		const expected = "\\\\srv\\share\\bin\\tool.exe";
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment(expected, "D:\\work", {
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});
});

describe("explicit command suffixes are additive, not exclusive (#1201)", () => {
	const bin = "C:\\__pi_lens_ext_tests__\\bin";

	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
	});

	it("appends PATHEXT to a versioned interpreter whose basename contains a dot", () => {
		// `path.win32.extname("python3.11")` is ".11". Treating any dot as an
		// explicit exact-match extension skipped the PATHEXT append loop and
		// turned every versioned interpreter into a hard ENOENT.
		const expected = path.win32.join(bin, "python3.11.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("python3.11", undefined, {
				PATH: bin,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("appends PATHEXT to a dotted command in an explicit relative path too", () => {
		const cwd = "C:\\__pi_lens_ext_tests__\\workspace";
		const expected = path.win32.join(cwd, "tools", "node-v20.1.exe");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("tools\\node-v20.1", cwd, {
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".exe" });
	});

	it("never short-circuits an unknown suffix into a spawnable result", () => {
		// `foo.txt` exists, but `.txt` is neither a directly spawnable extension
		// nor listed in PATHEXT. Returning it would hand a non-executable file
		// to the direct-spawn branch; the only acceptable answers are
		// `foo.txt.exe` (from the append loop) or null.
		markFilesAsPresent(path.win32.join(bin, "foo.txt"));

		expect(
			resolveWindowsCommandForEnvironment("foo.txt", undefined, {
				PATH: bin,
				PATHEXT: ".EXE",
			}),
		).toBeNull();
	});

	it("honors an explicit known-executable suffix that PATHEXT omits", () => {
		const expected = path.win32.join(bin, "knip.cmd");
		markFilesAsPresent(expected);

		expect(
			resolveWindowsCommandForEnvironment("knip.cmd", undefined, {
				PATH: bin,
				PATHEXT: ".EXE",
			}),
		).toEqual({ resolvedPath: expected, ext: ".cmd" });
	});

	it("still refuses a trailing-dot command rather than stripping it", () => {
		// Invariant lock, not a regression test: `"knip."` must never reach the
		// real `knip.exe`/`knip.cmd`. The additive append loop now runs for the
		// `.` suffix, so this guards the widening it could have introduced —
		// candidates become `knip..exe`/`knip..cmd`, which do not exist.
		markFilesAsPresent(
			path.win32.join(bin, "knip.exe"),
			path.win32.join(bin, "knip.cmd"),
			path.win32.join(bin, "knip"),
		);

		expect(
			resolveWindowsCommandForEnvironment("knip.", undefined, {
				PATH: bin,
				PATHEXT: ".EXE;.CMD",
			}),
		).toBeNull();
	});
});
