import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable `os.homedir()` override — `vi.spyOn(os, "homedir")` fails
// under Vitest's ESM interop ("Cannot redefine property"), so the module is
// replaced with a thin wrapper that defers to the REAL os.homedir() unless a
// test has set an override (refs #2472 review round 3, F1). Never used to
// touch the real HOME directory — only to redirect os.homedir() to a temp
// dir for the duration of one test.
const homedirOverride = vi.hoisted(() => ({
	value: undefined as string | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const homedir = () => homedirOverride.value ?? actual.homedir();
	return { ...actual, default: { ...actual, homedir }, homedir };
});

import {
	findLocalOpengrepConfig,
	normalizeOpengrepConfigArg,
	resolveOpengrepConfig,
} from "../../clients/opengrep-config.js";
import { removeTempDirSync } from "./test-utils.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opengrep-cfg-"));
});

afterEach(() => {
	removeTempDirSync(tmp);
});

describe("opengrep config resolution", () => {
	it("is disabled with a reason when no config exists and the flag is unset", () => {
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(false);
		expect(r.source).toBe("disabled");
		expect(r.reason).toMatch(/--lens-opengrep not set/);
	});

	it("auto-enables from a local .opengrep.yml", () => {
		const cfg = path.join(tmp, ".opengrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("local");
		expect(r.configArg).toBe(cfg);
	});

	it("also detects a legacy .semgrep.yml (shared rule format)", () => {
		const cfg = path.join(tmp, ".semgrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		expect(findLocalOpengrepConfig(tmp)).toBe(cfg);
		expect(resolveOpengrepConfig(tmp).enabled).toBe(true);
	});

	// #2472 review round 3, F1 (maintainer-decision reversal): a round-2 fold
	// made findLocalOpengrepConfig's ancestor climb stop at $HOME by default,
	// but a user-level `~/.opengrep.yml` is opengrep's own legitimate global
	// config — the ceiling hid it from pi-lens for no benefit. The climb is
	// unceilinged again: a config sitting exactly AT `os.homedir()` resolves.
	it("finds a config sitting AT (mocked) $HOME — no default ceiling (#2472 review round 3 F1)", () => {
		const mockedHome = path.join(tmp, "mocked-home");
		fs.mkdirSync(mockedHome, { recursive: true });
		homedirOverride.value = mockedHome;
		try {
			const cfg = path.join(mockedHome, ".opengrep.yml");
			fs.writeFileSync(cfg, "rules: []\n");
			const startDir = path.join(mockedHome, "project", "src");
			fs.mkdirSync(startDir, { recursive: true });

			expect(findLocalOpengrepConfig(startDir)).toBe(cfg);

			// Cross-form (forward-slash) startDir resolves identically.
			const crossFormStartDir = startDir.split(path.sep).join("/");
			expect(findLocalOpengrepConfig(crossFormStartDir)).toBe(cfg);
		} finally {
			homedirOverride.value = undefined;
		}
	});

	it("--lens-opengrep alone defaults to the 'auto' ruleset (seamless)", () => {
		const r = resolveOpengrepConfig(tmp, { enabled: true });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("flag");
		expect(r.configArg).toBe("auto");
	});

	it("--lens-opengrep prefers a discovered local rule file over 'auto'", () => {
		const cfg = path.join(tmp, ".opengrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		const r = resolveOpengrepConfig(tmp, { enabled: true });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("local");
		expect(r.configArg).toBe(cfg);
	});

	it("an explicit --lens-opengrep-config implies enable and overrides", () => {
		const r = resolveOpengrepConfig(tmp, { config: "p/ci" });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("flag");
		expect(r.configArg).toBe("p/ci");
	});
});

describe("normalizeOpengrepConfigArg", () => {
	it("passes registry/auto configs through verbatim", () => {
		expect(normalizeOpengrepConfigArg("auto", tmp)).toBe("auto");
		expect(normalizeOpengrepConfigArg("p/security", tmp)).toBe("p/security");
		expect(normalizeOpengrepConfigArg("r/some.rule", tmp)).toBe("r/some.rule");
	});

	it("resolves relative paths against cwd and keeps absolute paths", () => {
		expect(normalizeOpengrepConfigArg("rules/x.yml", tmp)).toBe(
			path.resolve(tmp, "rules/x.yml"),
		);
		const abs = path.join(tmp, "abs.yml");
		expect(normalizeOpengrepConfigArg(abs, tmp)).toBe(abs);
	});

	it("returns undefined for empty/missing input", () => {
		expect(normalizeOpengrepConfigArg(undefined, tmp)).toBeUndefined();
		expect(normalizeOpengrepConfigArg("   ", tmp)).toBeUndefined();
	});
});
