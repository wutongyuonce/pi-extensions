import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const dirs: string[] = [];
const defaultGlobalDir = process.env.PI_LENS_HOME;

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	if (defaultGlobalDir === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = defaultGlobalDir;
});

describe("loadLSPConfig global configuration (#870)", () => {
	it("applies global configuration when the project has no config", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					global: {
						name: "Global",
						extensions: [".global"],
						command: "global-lsp",
					},
				},
				disabledServers: ["typescript"],
				warmFiles: ["src/global.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toMatchObject({
			servers: { global: { command: "global-lsp" } },
			disabledServers: ["typescript"],
			warmFiles: ["src/global.ts"],
		});
	});

	it("merges maps by id and replaces project-owned array fields", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Global", extensions: [".g"], command: "global" },
					globalOnly: {
						name: "Global only",
						extensions: [".go"],
						command: "global-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "check" } } },
					go: { initializationOptions: { gofumpt: true } },
				},
				disabledServers: ["global-disabled"],
				warmFiles: ["global.ts"],
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".pi-lens"));
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Project", extensions: [".p"], command: "project" },
					projectOnly: {
						name: "Project only",
						extensions: [".po"],
						command: "project-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
					nix: { initializationOptions: { nixpkgs: { expr: "global" } } },
				},
				disabledServers: [],
				warmFiles: ["project.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir);

		expect(Object.keys(config.servers ?? {}).sort()).toEqual([
			"globalOnly",
			"projectOnly",
			"shared",
		]);
		expect(config.servers?.shared.command).toBe("project");
		expect(Object.keys(config.serverOverrides ?? {}).sort()).toEqual([
			"go",
			"nix",
			"rust",
		]);
		expect(config.serverOverrides?.rust.initializationOptions).toEqual({
			check: { command: "clippy" },
		});
		expect(config.disabledServers).toEqual([]);
		expect(config.warmFiles).toEqual(["project.ts"]);
	});

	it("degrades a malformed global file to built-in defaults", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid LSP config"),
		);
	});

	it("treats a missing global file as a silent no-op", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).not.toHaveBeenCalled();
	});
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `initLSPConfig`'s in-flight map cleared with a bare delete-by-key. The race
 * needs a SECOND WRITER replacing the map entry mid-flight — the public API
 * alone cannot produce it today (single set site; microtask FIFO orders every
 * observer after A's cleanup) — so this test simulates that writer directly.
 * `initLSPConfig` registers the map entry synchronously (before its first
 * internal `await loadLSPConfig(cwd)` settles), so the successor can be
 * installed with zero awaits between the call and the injection. Red on the
 * pre-fix bare `.finally` delete: A's cleanup evicted B and the third caller
 * started a duplicate config load.
 */
describe("initLSPConfig in-flight ABA release (#1968)", () => {
	it("a late-settling init does not evict its mid-flight successor", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-aba-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const buildA = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, before A's
		// `await loadLSPConfig(cwd)` has had a chance to resolve.
		const inFlight = _peekConfigInFlightForTests();
		expect(inFlight.size).toBe(1);
		const key = [...inFlight.keys()][0]!;

		// B replaces the entry under the same key while A is still in flight.
		let resolveSuccessor: () => void;
		const successor = new Promise<void>((resolve) => {
			resolveSuccessor = resolve;
		});
		inFlight.set(key, successor);

		await buildA; // A settles

		// B's entry survived A's cleanup.
		expect(inFlight.get(key)).toBe(successor);

		resolveSuccessor!();
		await successor;
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here. Checked by KEY, not
	// overall map size — the sibling test above leaves a synthetic successor
	// entry under its OWN key that nothing but a real `initLSPConfig` call for
	// that same cwd would ever clear.
	it("a normally-settling init still cleans up its own entry", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-clean-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const inFlight = _peekConfigInFlightForTests();
		const before = new Set(inFlight.keys());
		const pass = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, exactly as the
		// ABA test above relies on.
		const key = [...inFlight.keys()].find((k) => !before.has(k))!;
		expect(key).toBeDefined();

		await pass;
		expect(inFlight.has(key)).toBe(false);
	});
});
