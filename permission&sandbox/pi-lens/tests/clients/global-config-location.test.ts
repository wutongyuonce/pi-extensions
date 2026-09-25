import * as fs from "node:fs";
import { symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getPiLensGlobalConfigPath,
	getProductionGlobalConfigResolution,
	isResolvedGlobalConfigPath,
	loadPiLensGlobalConfig,
	resetGlobalConfigLocationCache,
	resolveGlobalConfigLocation,
} from "../../clients/lens-config.js";
import {
	findPiLensConfigInDir,
	loadPiLensConfigInDir,
	loadPiLensProjectConfig,
	EMPTY_PROJECT_CONFIG,
} from "../../clients/project-lens-config.js";
import { resolvePiLensConfig } from "../../clients/config-resolve.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { removeTempDirSync } from "./test-utils.js";

// Same sink-forwarding mock the other config suites use (#1333): config
// notices go to the ndjson sink, and the mock forwards messages to
// `console.error` so assertions here cover message content and the warn-once
// contract without re-deriving the sink machinery.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const tmpDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const OVERRIDDEN_ENV_KEYS = [
	"PI_LENS_CONFIG_PATH",
	"PI_CODING_AGENT_DIR",
	"PI_LENS_HOME",
	"HOME",
	"USERPROFILE",
] as const;

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-globalcfg-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Point the process's real homedir at the fixture home. The PRODUCTION
 * resolution (no `homeDir` injection) probes `$HOME/.pi-lens/config.json`
 * for the grandfathering tier, so the tests that exercise it must not depend
 * on the maintainer's real home (the #525 hermeticity class). Both spellings
 * are set because `os.homedir()` reads `$HOME` on POSIX and `USERPROFILE` on
 * Windows.
 */
function adoptHomeEnv(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
}

function writeLegacyConfig(home: string): string {
	fs.mkdirSync(path.join(home, ".pi-lens"), { recursive: true });
	fs.writeFileSync(path.join(home, ".pi-lens", "config.json"), "{}");
	return path.join(home, ".pi-lens", "config.json");
}

function agentDirFixture(home: string): {
	agentDir: string;
	globalConfigPath: string;
} {
	const agentDir = path.join(home, ".config", "pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetGlobalConfigLocationCache();
	return {
		agentDir,
		globalConfigPath: path.join(agentDir, "extensions", "pi-lens.json"),
	};
}

function warnedFor(substring: string): boolean {
	return (console.error as ReturnType<typeof vi.fn>).mock.calls
		.flat()
		.some((arg) => typeof arg === "string" && arg.includes(substring));
}

function warnCountFor(substring: string): number {
	return (console.error as ReturnType<typeof vi.fn>).mock.calls
		.flat()
		.filter((arg) => typeof arg === "string" && arg.includes(substring)).length;
}

beforeEach(() => {
	for (const key of OVERRIDDEN_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	resetDegradationLedger();
	resetGlobalConfigLocationCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetDegradationLedger();
	resetGlobalConfigLocationCache();
	for (const key of OVERRIDDEN_ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tmpDirs.splice(0)) removeTempDirSync(dir);
});

describe("global config location resolution", () => {
	it("PI_LENS_CONFIG_PATH wins over every tier, unchanged", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const override = path.join(home, "custom-config.json");
		process.env.PI_LENS_CONFIG_PATH = override;
		const agentDir = path.join(home, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "pi-lens.json"), "{}");
		fs.mkdirSync(path.join(home, ".pi-lens"), { recursive: true });
		fs.writeFileSync(path.join(home, ".pi-lens", "config.json"), "{}");
		resetGlobalConfigLocationCache();

		const resolution = resolveGlobalConfigLocation({ homeDir: home });
		expect(resolution.source).toBe("pi-lens-config-path");
		expect(resolution.path).toBe(path.resolve(override));
		loadPiLensGlobalConfig();
		expect(
			getDegradationSummary().some(
				(candidate) => candidate.kind === "config-location-shadowed",
			),
		).toBe(false);
	});

	it("a legacy ~/.pi-lens/config.json stays authoritative while it exists, even when the agent-dir file also exists (production)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		writeLegacyConfig(home);
		const { globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		resetGlobalConfigLocationCache();

		expect(resolveGlobalConfigLocation()).toEqual({
			path: path.join(home, ".pi-lens", "config.json"),
			source: "legacy-default-existing",
			shadowedPath: globalConfigPath,
		});
	});

	it("records one bounded notice when both global config files exist", () => {
		// Regression for #3299: selecting the grandfathered legacy file must not
		// silently hide a separately-created agent-dir configuration.
		const maintainerHome = os.homedir();
		const home = makeTempHome();
		adoptHomeEnv(home);
		const legacyPath = writeLegacyConfig(home);
		const { agentDir, globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		const realHomeConfigBefore = fs.existsSync(
			path.join(maintainerHome, ".pi-lens"),
		);
		const realAgentDir = process.env.PI_CODING_AGENT_DIR;
		resetGlobalConfigLocationCache();

		loadPiLensGlobalConfig();
		loadPiLensGlobalConfig();

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "config-location-shadowed",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(legacyPath);
		expect(group?.latestReasons[0]?.reason).toContain(globalConfigPath);
		expect(fs.existsSync(path.join(maintainerHome, ".pi-lens"))).toBe(
			realHomeConfigBefore,
		);
		expect(realAgentDir).toBe(agentDir);
	});

	it("records canonical paths when both files are reached through symlink aliases", () => {
		// Regression for #3323 M1: durable path identities must not vary with
		// symlink spellings of HOME or PI_CODING_AGENT_DIR.
		const root = makeTempHome();
		const realHome = path.join(root, "real-home");
		const realAgent = path.join(root, "real-agent");
		const homeAlias = path.join(root, "home-alias");
		const agentAlias = path.join(root, "agent-alias");
		fs.mkdirSync(path.join(realHome, ".pi-lens"), { recursive: true });
		fs.mkdirSync(path.join(realAgent, "extensions"), { recursive: true });
		symlinkSync(realHome, homeAlias, "dir");
		symlinkSync(realAgent, agentAlias, "dir");
		adoptHomeEnv(homeAlias);
		process.env.PI_CODING_AGENT_DIR = agentAlias;
		fs.writeFileSync(path.join(homeAlias, ".pi-lens", "config.json"), "{}");
		const shadowedPath = path.join(agentAlias, "extensions", "pi-lens.json");
		fs.writeFileSync(shadowedPath, "{}");
		resetGlobalConfigLocationCache();

		loadPiLensGlobalConfig();

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "config-location-shadowed",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(
			fs.realpathSync(path.join(realHome, ".pi-lens", "config.json")),
		);
		expect(group?.latestReasons[0]?.reason).toContain(
			fs.realpathSync(path.join(realAgent, "extensions", "pi-lens.json")),
		);
		expect(group?.latestReasons[0]?.reason).not.toContain("home-alias");
		expect(group?.latestReasons[0]?.reason).not.toContain("agent-alias");
	});

	it("the agent-dir file wins only when it EXISTS and the legacy default is missing (opt-in by creation)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		resetGlobalConfigLocationCache();

		expect(resolveGlobalConfigLocation()).toEqual({
			path: globalConfigPath,
			source: "pi-coding-agent-dir",
		});
	});

	it("an absent agent-dir file is NOT chosen for reading, even when PI_CODING_AGENT_DIR is set", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		agentDirFixture(home);
		resetGlobalConfigLocationCache();

		expect(resolveGlobalConfigLocation()).toEqual({
			path: path.join(home, ".pi-lens", "config.json"),
			source: "canonical-default",
		});
	});

	it("an empty or whitespace PI_CODING_AGENT_DIR is unset (production)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		resetGlobalConfigLocationCache();
		for (const value of ["", "   "]) {
			process.env.PI_CODING_AGENT_DIR = value;
			resetGlobalConfigLocationCache();
			expect(resolveGlobalConfigLocation().source).toBe("canonical-default");
		}
	});

	it("an owned context (injected homeDir) is hermetic: ambient PI_CODING_AGENT_DIR is ignored", () => {
		// Incident regression (global-config-location PR): with the ambient host
		// env live, a suite that resolved-then-wrote "under its own home" landed
		// in the maintainer's REAL extensions/pi-lens.json. An owned context
		// must resolve inside the home the caller named, full stop.
		const ambientHome = makeTempHome();
		const ambientAgentDir = path.join(ambientHome, "ambient-agent");
		fs.mkdirSync(path.join(ambientAgentDir, "extensions"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(ambientAgentDir, "extensions", "pi-lens.json"),
			"{}",
		);
		process.env.PI_CODING_AGENT_DIR = ambientAgentDir;

		const home = makeTempHome();
		const resolution = resolveGlobalConfigLocation({ homeDir: home });
		expect(resolution.source).toBe("canonical-default");
		expect(resolution.path).toBe(path.join(home, ".pi-lens", "config.json"));
		expect(resolution.path.startsWith(ambientHome)).toBe(false);
		// An owned context with the legacy file present still grandfather-pins
		// to that home's file, even though the ambient agent-dir file exists.
		writeLegacyConfig(home);
		expect(resolveGlobalConfigLocation({ homeDir: home }).path).toBe(
			path.join(home, ".pi-lens", "config.json"),
		);
	});

	it("a probe ERROR retains the errored tier instead of switching sources (#3251 review H2)", () => {
		const home = makeTempHome();
		const resolution = resolveGlobalConfigLocation({
			homeDir: home,
			exists: () => {
				throw new Error("EPERM: probe denied");
			},
		});
		// Fail closed at the location the probe could not evaluate: the file
		// might exist, and falling through would silently swap the user's
		// settings with no diagnostic.
		expect(resolution.source).toBe("legacy-default-unprobed");
		expect(resolution.path).toBe(path.join(home, ".pi-lens", "config.json"));
	});
});

describe("degraded global config reads are retained and reported (#3251 review H2)", () => {
	it("a legacy probe failure does NOT silently select an existing agent-dir config", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		// The reviewer's exact probe: `home/.pi-lens` is a FILE, so the legacy
		// probe (statSync) fails with ENOTDIR, while the agent-dir config
		// EXISTS and would silently take over under absorb-as-absent semantics.
		fs.writeFileSync(path.join(home, ".pi-lens"), "not a directory");
		const { globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({ lens: { enabled: false } }),
		);
		resetGlobalConfigLocationCache();

		// The resolution RETAINS the failed legacy identity...
		expect(resolveGlobalConfigLocation()).toEqual({
			path: path.join(home, ".pi-lens", "config.json"),
			source: "legacy-default-unprobed",
			existsProbeFailed: {
				path: path.join(home, ".pi-lens", "config.json"),
				errorClassName: "Error",
			},
		});
		// ...and the read of it fails, reported by the pre-existing
		// PILENS_CFG_0001 seam naming the failed path - NOT the agent config.
		loadPiLensGlobalConfig();
		expect(warnCountFor("PILENS_CFG_0001")).toBe(1);
		expect(warnedFor(path.join(home, ".pi-lens", "config.json"))).toBe(true);
		expect(warnedFor(globalConfigPath)).toBe(false);
		// The retention decision carries its own bounded record (H2 remedy B):
		// kind + retained path as subject + the error class in the reason.
		const group = getDegradationSummary().find(
			(group) => group.kind === "config-location-probe-failed",
		);
		expect(group?.latestReasons[0]?.subject).toBe(
			path.join(home, ".pi-lens", "config.json"),
		);
		// The reason names the error CLASS, never the message (#2431/#2451):
		// statSync's ENOTDIR is a plain Error, so the class is "Error".
		expect(group?.latestReasons[0]?.reason).toContain("(Error)");
	});

	it("an agent-dir probe failure retains the agent identity rather than falling to the canonical default", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		// `home/agent` is a FILE: the agent-dir path is unstatable (ENOTDIR),
		// while the legacy probe answers clean-absent. The agent identity is
		// retained; the read of it reports the failure.
		fs.writeFileSync(path.join(home, "agent"), "not a directory");
		process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
		resetGlobalConfigLocationCache();

		expect(resolveGlobalConfigLocation()).toEqual({
			path: path.join(home, "agent", "extensions", "pi-lens.json"),
			source: "pi-coding-agent-dir-unprobed",
			existsProbeFailed: {
				path: path.join(home, "agent", "extensions", "pi-lens.json"),
				errorClassName: "Error",
			},
		});
		loadPiLensGlobalConfig();
		expect(warnCountFor("PILENS_CFG_0001")).toBe(1);
		expect(
			warnedFor(path.join(home, "agent", "extensions", "pi-lens.json")),
		).toBe(true);
		const group = getDegradationSummary().find(
			(group) => group.kind === "config-location-probe-failed",
		);
		expect(group?.latestReasons[0]?.subject).toBe(
			path.join(home, "agent", "extensions", "pi-lens.json"),
		);
		// The reason names the error CLASS, never the message (#2431/#2451):
		// statSync's ENOTDIR is a plain Error, so the class is "Error".
		expect(group?.latestReasons[0]?.reason).toContain("(Error)");
	});

	it("the retention policy holds for every stat error class: EACCES, ELOOP, generic", () => {
		const home = makeTempHome();
		// The reviewer's remedy B asks for the policy per error class. The
		// record names the error CLASS (all plain Errors here report "Error" -
		// the message is never carried, #2431/#2451), and every class retains
		// the legacy identity instead of switching sources.
		for (const thrown of [
			Object.assign(new Error("denied"), { code: "EACCES" }),
			Object.assign(new Error("loop"), { code: "ELOOP" }),
			new Error("generic failure"),
		]) {
			resetGlobalConfigLocationCache();
			const resolution = resolveGlobalConfigLocation({
				homeDir: home,
				exists: () => {
					throw thrown;
				},
			});
			expect(resolution.source).toBe("legacy-default-unprobed");
			expect(resolution.existsProbeFailed?.errorClassName).toBe("Error");
		}
	});

	it("a clean-absent legacy path with no agent dir still resolves canonically (no error, no notice)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		resetGlobalConfigLocationCache();

		expect(resolveGlobalConfigLocation()).toEqual({
			path: path.join(home, ".pi-lens", "config.json"),
			source: "canonical-default",
		});
		loadPiLensGlobalConfig();
		expect(warnCountFor("PILENS_CFG_0001")).toBe(0);
	});
});

describe("production resolution memo", () => {
	it("freezes the existence axis per env fingerprint: a file created later does not flip the resolution", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		resetGlobalConfigLocationCache();

		expect(getProductionResolutionSource()).toBe("canonical-default");

		// The agent-dir file appears AFTER the first production resolution.
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		expect(getProductionResolutionSource()).toBe("canonical-default");
	});

	it("an env change re-resolves without a reset", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		resetGlobalConfigLocationCache();
		expect(getProductionResolutionSource()).toBe("canonical-default");

		// The file appears under the CURRENT agent dir, but the fingerprint
		// stays the same — the existence axis stays frozen. Point the env at a
		// DIFFERENT agent dir whose file already exists: the fingerprint change
		// re-resolves and the new location wins.
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		const otherAgentDir = path.join(home, "other-agent");
		fs.mkdirSync(path.join(otherAgentDir, "extensions"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(otherAgentDir, "extensions", "pi-lens.json"),
			"{}",
		);
		process.env.PI_CODING_AGENT_DIR = otherAgentDir;
		expect(getProductionResolutionPath()).toBe(
			path.join(otherAgentDir, "extensions", "pi-lens.json"),
		);
	});

	it("resetGlobalConfigLocationCache re-probes the existence axis", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		resetGlobalConfigLocationCache();
		expect(getProductionResolutionSource()).toBe("canonical-default");

		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		resetGlobalConfigLocationCache();
		expect(getProductionResolutionSource()).toBe("pi-coding-agent-dir");
	});

	it("isResolvedGlobalConfigPath matches every POTENTIAL global location, not just the read winner", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const override = path.join(home, "override.json");
		process.env.PI_LENS_CONFIG_PATH = override;
		const { globalConfigPath } = agentDirFixture(home);
		resetGlobalConfigLocationCache();

		// The override won the read, but the OTHER recognized locations are
		// equally not project configs.
		for (const globalPath of [
			override,
			path.join(home, ".pi-lens", "config.json"),
			globalConfigPath,
		]) {
			expect(isResolvedGlobalConfigPath(globalPath)).toBe(true);
		}
		// Dot-segment spellings normalize to the same absolute.
		expect(
			isResolvedGlobalConfigPath(
				path.join(globalConfigPath, "..", "pi-lens.json"),
			),
		).toBe(true);
		expect(isResolvedGlobalConfigPath(path.join(home, "unrelated.json"))).toBe(
			false,
		);
	});

	it("a symlinked-home alias of a recognized location matches its real spelling (#3251 review M1 round 2)", () => {
		// The reviewer's probe: the resolution resolves through a SYMLINKED
		// home, and a candidate spelled through the REAL home identifies the
		// same file. `normalizeFilePath` alone preserves the caller's
		// directory spelling when realpath differs, so the alias evaded the
		// refusal; the identity is now realpath-anchored on both sides.
		const realHome = makeTempHome();
		const linkHome = path.join(
			path.dirname(realHome),
			`link-${path.basename(realHome)}`,
		);
		symlinkSync(realHome, linkHome, "dir");
		const legacyConfig = path.join(realHome, ".pi-lens", "config.json");
		fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
		fs.writeFileSync(legacyConfig, "{}");

		// Resolution through the LINK: the recognized set canonicalizes to the
		// real spelling.
		process.env.HOME = linkHome;
		process.env.USERPROFILE = linkHome;
		resetGlobalConfigLocationCache();
		const candidateThroughRealHome = path.join(
			realHome,
			".pi-lens",
			"config.json",
		);
		expect(isResolvedGlobalConfigPath(candidateThroughRealHome)).toBe(true);

		// And the mirror: resolution through the REAL home, candidate through
		// the LINK.
		process.env.HOME = realHome;
		process.env.USERPROFILE = realHome;
		resetGlobalConfigLocationCache();
		const candidateThroughLinkHome = path.join(
			linkHome,
			".pi-lens",
			"config.json",
		);
		expect(isResolvedGlobalConfigPath(candidateThroughLinkHome)).toBe(true);
		// An unrelated real path under the same home is still not recognized.
		expect(isResolvedGlobalConfigPath(path.join(realHome, "x.json"))).toBe(
			false,
		);
	});

	it("the comparison is canonical: case-folded and separator-spelled Windows spellings still match (#3251 review M1)", () => {
		// Drive the predicate with Windows-shaped spellings through the
		// injectable normalization seam: `normalizeFilePath` folds separators
		// everywhere and case-folds on win32 semantics, so a case-differing or
		// backslash-spelled candidate cannot dodge the refusal the way a raw
		// string equality would.
		const winPath = "C:\\Users\\dev\\agent\\extensions\\PI-LENS.JSON";
		const sameFileDifferentSpelling =
			"c:/users/dev/agent/extensions/pi-lens.json";
		process.env.PI_CODING_AGENT_DIR = "c:\\users\\dev\\agent";
		resetGlobalConfigLocationCache();

		expect(
			resolveGlobalConfigLocation({ exists: () => true }).path,
		).toBeDefined();
		// The recognized set is normalized; a case-differing spelling matches.
		expect(isResolvedGlobalConfigPath(winPath)).toBe(true);
		expect(isResolvedGlobalConfigPath(sameFileDifferentSpelling)).toBe(true);
	});
});

function getProductionResolutionSource(): string {
	return getProductionGlobalConfigResolution().source;
}

function getProductionResolutionPath(): string {
	return getProductionGlobalConfigResolution().path;
}

describe("project-config discovery refuses the resolved global config path", () => {
	it("findPiLensConfigInDir refuses the global config file (pre-fix: full-validated and warned about)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { agentDir, globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({ ignore: ["*.log"], lens: { enabled: true } }),
		);

		expect(findPiLensConfigInDir(path.join(agentDir, "extensions"))).toBe(
			undefined,
		);
		expect(loadPiLensConfigInDir(path.join(agentDir, "extensions"))).toEqual(
			EMPTY_PROJECT_CONFIG,
		);
		// Pre-fix this file produced "ignoring invalid project config …
		// 'lens' is a global-only pi-lens setting … [PILENS_CFG_0001]" once per
		// ancestor layer. None may fire now.
		expect(warnedFor("ignoring invalid project config")).toBe(false);
		expect(warnedFor("PILENS_CFG_0001")).toBe(false);
	});

	it("the LOSING global location is also refused (grandfathered legacy beside an adopted agent-dir file)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		writeLegacyConfig(home);
		const { agentDir, globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");
		resetGlobalConfigLocationCache();

		// The READ winner is the legacy file, but the agent-dir file is still a
		// recognized global location — not a project config.
		expect(resolveGlobalConfigLocation().source).toBe(
			"legacy-default-existing",
		);
		expect(findPiLensConfigInDir(path.join(agentDir, "extensions"))).toBe(
			undefined,
		);
	});

	it("a sibling pi-lens.json in an unrelated directory is still discovered", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		agentDirFixture(home);
		const siblingDir = path.join(home, "packages", "app");
		fs.mkdirSync(siblingDir, { recursive: true });
		fs.writeFileSync(
			path.join(siblingDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["generated/**"] }),
		);

		const config = loadPiLensConfigInDir(siblingDir);
		expect(config).not.toBe(undefined);
		expect(config?.ignore).toEqual(["generated/**"]);
	});

	it("the upward walk refuses the global config file and finds nothing else in its place", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");

		// Session cwd inside the agent dir: the walk from extensions upward
		// used to adopt the global file as the project config.
		const startDir = path.dirname(globalConfigPath);
		const config = loadPiLensProjectConfig(startDir);
		expect(config).toEqual(EMPTY_PROJECT_CONFIG);
		expect(warnedFor("ignoring invalid project config")).toBe(false);
	});
});

describe("config-resolve's project walk refuses the global config path", () => {
	it("a cwd inside the agent dir does not surface the global config as a nested-project document", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const { globalConfigPath } = agentDirFixture(home);
		fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
		fs.writeFileSync(globalConfigPath, "{}");

		const resolution = resolvePiLensConfig({
			cwd: path.dirname(globalConfigPath),
			homeDir: home,
			globalDir: path.join(home, ".pi-lens"),
			globalConfigPath: getPiLensGlobalConfigPath(),
		});
		// The global tier reads the agent-dir file exactly once; the project
		// walk from a cwd INSIDE the agent dir must not rediscover it as a
		// project/nested-project document (pre-fix: double-read at two tiers).
		const projectTierHits = resolution.documents.filter(
			(document) =>
				document.tier !== "global" && document.file === globalConfigPath,
		);
		expect(projectTierHits).toEqual([]);
	});
});
