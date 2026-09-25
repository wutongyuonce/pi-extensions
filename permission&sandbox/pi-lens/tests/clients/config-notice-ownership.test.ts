/**
 * WHO reports a config migration notice, and WHICH file it tells the user to
 * write (#2426 review round 2, F1 + F2).
 *
 * Two defects, one surface — the notice a user actually reads:
 *
 * F1. The destination was RECOMPUTED from the legacy file's own directory
 *     (`dirname(<legacy>) + config.json`), while the resolver reads the
 *     canonical global from `getPiLensGlobalConfigPath()`. Those two agree only
 *     because most environments leave `PI_LENS_HOME` unset — under it they
 *     diverge and the notice names a file nothing ever reads. The test below is
 *     behavioral rather than string-shaped: it WRITES the file the notice names
 *     and asserts that file then wins.
 *
 * F2. Both the LSP loader and the project loader reported EVERY record of the
 *     resolution, and the warn-once latch is keyed per subsystem, so a session
 *     that ran both emitted two notices for every `(file, key)` — and labelled
 *     a project-config key "deprecated LSP config". Each loader now reports only
 *     the records it owns.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { resetGlobalConfigLocationCache } from "../../clients/lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

const notices: string[] = [];

vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			notices.push(entry.message);
		},
	};
});

const roots: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function write(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

let previousConfigPath: string | undefined;
let previousHome: string | undefined;
let previousAgentDir: string | undefined;
let previousRealHome: string | undefined;
let previousRealUserProfile: string | undefined;

beforeEach(() => {
	notices.length = 0;
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousHome = process.env.PI_LENS_HOME;
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	// The production resolution is homedir-anchored (the canonical default and
	// its grandfathering probe read `$HOME/.pi-lens/config.json`), and THIS
	// suite writes the notice's named destination. Without adopting a fixture
	// home, that destination is the maintainer's real global config — seen
	// live during development: the F1 test below created and wrote the real
	// file twice. `os.homedir()` reads `$HOME` on POSIX and `USERPROFILE` on
	// Windows, so both spellings are adopted.
	const adoptedHome = tmpRoot("pi-lens-notice-fakehome-");
	previousRealHome = process.env.HOME;
	previousRealUserProfile = process.env.USERPROFILE;
	process.env.HOME = adoptedHome;
	process.env.USERPROFILE = adoptedHome;
	resetIgnoredConfigWarnCache();
	resetGlobalConfigLocationCache();
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousRealHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousRealHome;
	if (previousRealUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = previousRealUserProfile;
	}
	resetIgnoredConfigWarnCache();
	resetGlobalConfigLocationCache();
	const { resetProjectLensConfigCache } =
		await import("../../clients/project-lens-config.js");
	resetProjectLensConfigCache();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

/** The migration notices only — never the `ignoring invalid …` shape. */
function deprecationNotices(): string[] {
	return notices.filter((message) => message.startsWith("deprecated "));
}

describe("a migration notice names the file the resolver actually reads (#2426 F1)", () => {
	it("names the canonical global path under PI_LENS_HOME, not the legacy file's sibling", async () => {
		// The divergent environment: `PI_LENS_HOME` relocates the pi-lens dir the
		// LEGACY global config is read from, while the CANONICAL global path is
		// derived from `$HOME` because `PI_LENS_CONFIG_PATH` is unset. The golden
		// harness sets both in lockstep, which is exactly what hides this.
		const home = tmpRoot("pi-lens-notice-home-");
		const globalDir = tmpRoot("pi-lens-notice-globaldir-");
		process.env.PI_LENS_HOME = globalDir;
		delete process.env.PI_LENS_CONFIG_PATH;

		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(globalDir, "lsp.json"), {
			warmFiles: ["from-legacy-global"],
		});

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const before = await loadLSPConfig(projectDir, home);
		expect(before.warmFiles).toEqual(["from-legacy-global"]);

		const notice = deprecationNotices().find((message) =>
			message.includes('move "warmFiles"'),
		);
		expect(
			notice,
			"no migration notice for the legacy global file",
		).toBeDefined();

		// `move "warmFiles" to <destination> under "lsp.warmFiles" (deprecated …)`
		const match = /move "warmFiles" to (\S+) under/.exec(notice ?? "");
		expect(match, notice).not.toBeNull();
		const named = match?.[1] ?? "";
		const destination = named.startsWith("~/")
			? path.join(home, named.slice(2))
			: named;

		// THE assertion: write the file the user was told to write, and it wins.
		write(destination, { lsp: { warmFiles: ["from-canonical-global"] } });
		const after = await loadLSPConfig(projectDir, home);
		expect(after.warmFiles).toEqual(["from-canonical-global"]);
	});
});

describe("each loader reports only the records it owns (#2426 F2)", () => {
	it("emits ONE notice for a legacy root LSP key in a canonical project file", async () => {
		const home = tmpRoot("pi-lens-own-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-own-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, ".pi-lens.json"), { warmFiles: ["x"] });

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		await loadLSPConfig(projectDir, home);
		loadPiLensProjectConfig(projectDir);

		const emitted = deprecationNotices();
		expect(emitted).toHaveLength(1);
		// `warmFiles` is an LSP setting, so the LSP loader owns the notice.
		expect(emitted[0]).toContain("deprecated LSP config key");
		expect(emitted[0]).toContain('move "warmFiles" to "lsp.warmFiles"');
	});

	it("splits a legacy project file's keys between the loaders that consume them", async () => {
		const home = tmpRoot("pi-lens-own2-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-own2-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		// The undotted legacy project file, carrying one LSP key and two
		// pi-lens-project keys. Both loaders read this same file.
		write(path.join(projectDir, "pi-lens.json"), {
			ignore: ["dist/**"],
			maxProjectFiles: 500,
			warmFiles: ["x"],
		});

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		await loadLSPConfig(projectDir, home);
		loadPiLensProjectConfig(projectDir);

		const emitted = deprecationNotices();
		// THREE keys, three notices — not six.
		expect(emitted).toHaveLength(3);

		const forKey = (key: string): string | undefined =>
			emitted.find((message) => message.includes(`move "${key}" to`));
		// Correctly LABELLED: `ignore`/`maxProjectFiles` are project settings and
		// must never be announced as "deprecated LSP config".
		expect(forKey("ignore")).toContain("deprecated project config location");
		expect(forKey("maxProjectFiles")).toContain(
			"deprecated project config location",
		);
		expect(forKey("warmFiles")).toContain("deprecated LSP config location");
		for (const key of ["ignore", "maxProjectFiles", "warmFiles"]) {
			expect(
				emitted.filter((message) => message.includes(`move "${key}" to`)),
				key,
			).toHaveLength(1);
		}
	});
});

describe("a pi-lens-owned record is reported even when the project loader never opens the document (#2426 review round 3, F1)", () => {
	it("reports a legacy sibling file's keys the project loader's precedence skips", async () => {
		// `loadPiLensProjectConfig`'s discovery is a SINGLE nearest-file probe:
		// with both a canonical `.pi-lens.json` AND a legacy `pi-lens.json` in the
		// same directory, it opens only the canonical one (higher precedence) and
		// never resolves the legacy file at all. `loadLSPConfig`'s multi-document
		// walk resolves BOTH. Filtering the LSP loader's report to what it "owns"
		// (round 2) dropped the legacy file's pi-lens-owned keys silently: the LSP
		// loader saw them but wasn't allowed to report them, and the project
		// loader never saw them to report in the first place.
		const home = tmpRoot("pi-lens-sibling-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-sibling-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, "pi-lens.json"), {
			ignore: ["legacy/**"],
			maxProjectFiles: 500,
		});
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["canonical/**"] });

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		await loadLSPConfig(projectDir, home);
		// The nearest-file walk finds `.pi-lens.json` and stops there — it never
		// opens `pi-lens.json`, the exact gap this test pins.
		loadPiLensProjectConfig(projectDir);

		const emitted = deprecationNotices();
		const forKey = (key: string): string[] =>
			emitted.filter((message) => message.includes(`move "${key}" to`));

		expect(forKey("ignore"), "ignore").toHaveLength(1);
		expect(forKey("ignore")[0]).toContain("deprecated project config location");
		expect(forKey("maxProjectFiles"), "maxProjectFiles").toHaveLength(1);
		expect(forKey("maxProjectFiles")[0]).toContain(
			"deprecated project config location",
		);
	});

	it("reports a legacy ANCESTOR file's keys a nearer canonical file's precedence skips", async () => {
		// Same gap, one directory further out: the project loader's upward walk
		// stops at the FIRST directory carrying any recognized file — the nearer
		// canonical `.pi-lens.json` in `root/pkg` — and never continues up to
		// `root`'s legacy `pi-lens.json`. The LSP loader's walk is not a
		// stop-at-first probe: it collects from every bearing directory between
		// the start and the `$HOME` ceiling, so it resolves `root/pi-lens.json`
		// too, at `project` tier (the OUTERMOST bearing directory).
		const home = tmpRoot("pi-lens-ancestor-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-ancestor-global-");
		const root = path.join(home, "root");
		const nested = path.join(root, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		write(path.join(root, "pi-lens.json"), {
			ignore: ["root-legacy/**"],
			maxProjectFiles: 700,
		});
		write(path.join(nested, ".pi-lens.json"), { ignore: ["pkg/**"] });

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		await loadLSPConfig(nested, home);
		loadPiLensProjectConfig(nested);

		const emitted = deprecationNotices();
		const forKey = (key: string): string[] =>
			emitted.filter((message) => message.includes(`move "${key}" to`));

		expect(forKey("ignore"), "ignore").toHaveLength(1);
		expect(forKey("ignore")[0]).toContain("deprecated project config location");
		expect(forKey("maxProjectFiles"), "maxProjectFiles").toHaveLength(1);
		expect(forKey("maxProjectFiles")[0]).toContain(
			"deprecated project config location",
		);
	});
});
