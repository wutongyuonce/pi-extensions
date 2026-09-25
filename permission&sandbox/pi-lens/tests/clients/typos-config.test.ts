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
	findLocalTyposConfig,
	LOCAL_TYPOS_CONFIG_NAMES,
} from "../../clients/typos-config.js";
import { removeTempDirSync } from "./test-utils.js";

describe("findLocalTyposConfig (#283)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-typos-cfg-"));
	});
	afterEach(() => {
		removeTempDirSync(root);
	});

	it("finds a root-level typos.toml", () => {
		const cfg = path.join(root, "typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it.each([...LOCAL_TYPOS_CONFIG_NAMES])("discovers %s", (name) => {
		const cfg = path.join(root, name);
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it("walks up from a nested start dir", () => {
		const cfg = path.join(root, "_typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		const nested = path.join(root, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		expect(findLocalTyposConfig(nested)).toBe(cfg);
	});

	it("returns undefined when no config exists", () => {
		expect(findLocalTyposConfig(root)).toBeUndefined();
	});

	// #2472 review round 3, F1 (maintainer-decision reversal): a round-2 fold
	// made findLocalTyposConfig's ancestor climb stop at $HOME by default, but
	// `~/typos.toml` is a legitimate global config typos itself discovers —
	// the ceiling silently hid the user's config from `typos-lsp`'s own
	// merge (injected config wins), letting pi-lens's shipped `_typos.toml`
	// clobber it instead. The climb is unceilinged again: a config sitting
	// exactly AT `os.homedir()` resolves.
	it("finds a config sitting AT (mocked) $HOME — no default ceiling (#2472 review round 3 F1)", () => {
		const mockedHome = path.join(root, "mocked-home");
		fs.mkdirSync(mockedHome, { recursive: true });
		homedirOverride.value = mockedHome;
		try {
			const cfg = path.join(mockedHome, "typos.toml");
			fs.writeFileSync(cfg, "[default]\n");
			const startDir = path.join(mockedHome, "project", "src");
			fs.mkdirSync(startDir, { recursive: true });

			expect(findLocalTyposConfig(startDir)).toBe(cfg);

			// Cross-form (forward-slash) startDir resolves identically.
			const crossFormStartDir = startDir.split(path.sep).join("/");
			expect(findLocalTyposConfig(crossFormStartDir)).toBe(cfg);
		} finally {
			homedirOverride.value = undefined;
		}
	});
});
