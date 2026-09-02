/**
 * Tests for the cross-file dead-code harness (#127), Phase 1 (Python/vulture).
 *
 * Parser tests run against CAPTURED real vulture 2.16 output (no spawn). A
 * guarded integration test exercises the real binary end-to-end when vulture is
 * on PATH, and skips cleanly otherwise (mirrors the LSP smoke-skip pattern).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	PythonDeadCodeClient,
	parseVultureOutput,
	deadCodeIssueKey,
	deadCodeIssues,
	formatDeadCodeDelta,
	deadCodeIssueCount,
	getDeadCodeClients,
	type DeadCodeResult,
} from "../../clients/dead-code-client.js";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { gatedPromise } from "../support/fault-injection.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const PY_FIXTURE = path.join(
	REPO_ROOT,
	"tests/fixtures/dead-code/python-project",
);

// Real vulture 2.16 output (Windows + POSIX path forms both covered).
const VULTURE_OUTPUT = [
	"src/mod.py:1: unused import 'os' (90% confidence)",
	"src/mod.py:9: unused function 'unused_func' (60% confidence)",
	"src/mod.py:13: unused class 'UnusedClass' (60% confidence)",
	"src/mod.py:14: unused method 'unused_method' (60% confidence)",
	"vulture banner line that should be ignored",
	"",
].join("\n");

function vultureAvailable(): boolean {
	// #902: was `execFileSync(cmd[0], cmd[1], { stdio: "pipe" })`. On Windows,
	// pip's console_scripts launcher for `vulture` is a bare-extension shim
	// resolved via PATH+PATHEXT, which raw execFileSync (shell:false, no
	// PATHEXT walk) can silently fail to find under load — a probe failure
	// here means the whole guarded suite skips, so a spurious failure isn't
	// just noise, it's a false "vulture unavailable" that hides real
	// coverage. `safeSpawn` (shared with production, `clients/safe-spawn.ts`)
	// resolves the command via a cached PATH+PATHEXT walk, same hardening
	// #817 already gave the real dispatch spawn path (single source of
	// truth, #883).
	for (const cmd of [
		["vulture", ["--version"]],
		["python", ["-m", "vulture", "--version"]],
	] as const) {
		const result = safeSpawn(cmd[0], [...cmd[1]]);
		if (result.status === 0 && !result.error) return true;
	}
	return false;
}

describe("parseVultureOutput", () => {
	it("parses each kind with name/line/confidence and ignores noise", () => {
		const issues = parseVultureOutput(VULTURE_OUTPUT, "/proj");
		expect(issues).toHaveLength(4);
		expect(issues.map((i) => i.kind)).toEqual([
			"import",
			"function",
			"class",
			"method",
		]);
		expect(issues[1]).toMatchObject({
			category: "export",
			kind: "function",
			name: "unused_func",
			line: 9,
			confidence: 60,
		});
		expect(issues.every((i) => i.category === "export")).toBe(true);
	});

	it("returns [] for clean output", () => {
		expect(parseVultureOutput("", "/proj")).toEqual([]);
		expect(parseVultureOutput("no findings here\n", "/proj")).toEqual([]);
	});
});

describe("PythonDeadCodeClient.detect", () => {
	const client = new PythonDeadCodeClient();

	it("detects a Python project by its marker", () => {
		expect(client.detect(PY_FIXTURE)).toBe(true);
	});

	it("does not detect a non-Python directory", () => {
		// A temp dir with no marker and a VCS-less parent — walks to root, null.
		expect(client.detect(path.join(REPO_ROOT, "tests/fixtures"))).toBe(false);
	});
});

describe("PythonDeadCodeClient resolveProjectRoot (pin, refs #625)", () => {
	// Pins the exact current behavior of the private resolveProjectRoot method
	// (depth-64 climb, home-ceiling check, .git/.hg/.svn boundary short-circuit)
	// BEFORE migrating it onto the shared clients/path-utils.ts helper, mirroring
	// the equivalent knip-client.test.ts pins for its structurally-identical
	// resolveProjectRoot.
	type ResolveProjectRoot = {
		resolveProjectRoot: (startDir: string, homeDir?: string) => string | null;
	};

	it("resolves the project root from a nested directory", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-deadcode-");
		try {
			fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]");
			const nested = path.join(tmpDir, "src", "pkg");
			fs.mkdirSync(nested, { recursive: true });

			const client =
				new PythonDeadCodeClient() as unknown as ResolveProjectRoot;
			expect(client.resolveProjectRoot(nested)).toBe(tmpDir);
		} finally {
			cleanup();
		}
	});

	it("does not resolve a marker at or above home", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-deadcode-home-ceiling-"),
		);
		try {
			const ancestor = path.join(tmpRoot, "ancestor");
			const home = path.join(ancestor, "home");
			const nested = path.join(home, "empty-folder");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(ancestor, "setup.py"), "");

			const client =
				new PythonDeadCodeClient() as unknown as ResolveProjectRoot;
			expect(client.resolveProjectRoot(nested, home)).toBeNull();
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("does not resolve a marker at the home dir itself", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-deadcode-home-marker-"),
		);
		try {
			const home = path.join(tmpRoot, "home");
			fs.mkdirSync(home, { recursive: true });
			fs.writeFileSync(path.join(home, "tox.ini"), "");

			const client =
				new PythonDeadCodeClient() as unknown as ResolveProjectRoot;
			expect(client.resolveProjectRoot(home, home)).toBeNull();
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("does not walk past a VCS boundary to a parent marker", () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-deadcode-boundary-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]");
			const repoRoot = path.join(tmpDir, "sub-repo");
			const nested = path.join(repoRoot, "src", "pkg");
			fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });

			const client =
				new PythonDeadCodeClient() as unknown as ResolveProjectRoot;
			expect(client.resolveProjectRoot(nested)).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("returns null (never the start dir) when no marker exists up the tree", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-deadcode-none-"),
		);
		try {
			const nested = path.join(tmpRoot, "deep", "nowhere");
			fs.mkdirSync(nested, { recursive: true });

			const client =
				new PythonDeadCodeClient() as unknown as ResolveProjectRoot;
			const resolved = client.resolveProjectRoot(nested);
			expect(resolved).not.toBe(nested);
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});
});

describe("getDeadCodeClients", () => {
	it("returns the Python client in Phase 1", () => {
		const clients = getDeadCodeClients();
		expect(clients.map((c) => c.id)).toContain("python");
	});
});

describe("PythonDeadCodeClient.owns", () => {
	it("claims Python sources only, so a JS-only turn skips the re-scan", () => {
		const client = new PythonDeadCodeClient();
		expect(client.owns("/repo/pkg/mod.py")).toBe(true);
		expect(client.owns("/repo/pkg/mod.PY")).toBe(true);
		expect(client.owns("/repo/pkg/stub.pyi")).toBe(true);
		expect(client.owns("/repo/src/app.ts")).toBe(false);
		expect(client.owns("/repo/README.md")).toBe(false);
	});
});

describe("dead-code turn delta helpers", () => {
	const result = (over: Partial<DeadCodeResult>): DeadCodeResult => ({
		success: true,
		language: "Python",
		unusedExports: [],
		unusedFiles: [],
		unusedDeps: [],
		unlistedDeps: [],
		summary: "",
		...over,
	});
	const issue = (name: string, line: number) => ({
		category: "export" as const,
		kind: "function",
		name,
		file: "mod.py",
		line,
		confidence: 60,
	});

	it("flattens every bucket so no finding escapes the diff", () => {
		const r = result({
			unusedExports: [issue("a", 1)],
			unusedFiles: [{ category: "file", kind: "file", name: "orphan.py" }],
		});
		expect(deadCodeIssues(r).map((i) => i.name)).toEqual(["a", "orphan.py"]);
		expect(deadCodeIssueCount(r)).toBe(2);
	});

	it("keys an issue by category/file/name so a moved symbol is not new", () => {
		expect(deadCodeIssueKey(issue("a", 1))).toBe("export:mod.py:a");
		expect(deadCodeIssueKey(issue("a", 1))).toBe(
			deadCodeIssueKey(issue("a", 2)),
		);
	});
});

describe("formatDeadCodeDelta", () => {
	const issue = (name: string, line: number) => ({
		category: "export" as const,
		kind: "function",
		name,
		file: "mod.py",
		line,
		confidence: 60,
	});

	it("returns empty string when the edit created nothing", () => {
		expect(formatDeadCodeDelta([], "Python")).toBe("");
	});

	it("names the edited symbols and caps with a +more line", () => {
		const out = formatDeadCodeDelta(
			Array.from({ length: 7 }, (_, i) => issue(`f${i}`, i + 1)),
			"Python",
		);
		expect(out).toContain("Newly unused Python symbols in files you edited");
		expect(out).toContain("mod.py:1 — unused function f0");
		expect(out).toContain("… and 2 more");
	});
});

describe("PythonDeadCodeClient.analyze (integration, real vulture)", () => {
	it.skipIf(!vultureAvailable())(
		"finds the unused symbols in the fixture project",
		async () => {
			const client = new PythonDeadCodeClient();
			const result = await client.analyze(PY_FIXTURE);
			expect(result.success).toBe(true);
			const names = result.unusedExports.map((i) => i.name);
			expect(names).toContain("unused_func");
			expect(names).toContain("UnusedClass");
			// Framework-invoked symbols have no visible call site, so reporting them
			// is permanent noise the reader can never resolve (--ignore-decorators).
			expect(names).not.toContain("framework_called_fixture");
			// file paths are project-relative
			expect(result.unusedExports[0]?.file).not.toContain(PY_FIXTURE);
		},
		20_000,
	);
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe).
 *
 * The race needs a SECOND WRITER replacing the map entry mid-flight (a future
 * force-refresh/eviction path) — public API alone cannot produce it (single
 * set site; microtask FIFO orders every observer after A's cleanup). So the
 * test simulates that writer directly, exactly the mechanism the #1838
 * reachability probe established. Red on the pre-fix bare `.finally` delete:
 * A's cleanup evicted B and the third caller started a duplicate build.
 */
describe("in-flight ABA release (#1968)", () => {
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	interface Internals {
		resolveProjectRoot: (cwd: string) => string | null;
		ensureAvailable: (root?: string) => Promise<boolean>;
		runAnalyze: (key: string) => Promise<DeadCodeResult>;
		inFlight: Map<string, Promise<DeadCodeResult>>;
	}

	function emptyResult(): DeadCodeResult {
		return {
			success: true,
			language: "python",
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "",
		};
	}

	it("a late-settling build does not evict its mid-flight successor", async () => {
		const client = new PythonDeadCodeClient(false);
		const internals = client as unknown as Internals;
		vi.spyOn(internals, "resolveProjectRoot").mockReturnValue("/probe-root");
		vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
		const gateA = gatedPromise<DeadCodeResult>();
		let analyzeCalls = 0;
		vi.spyOn(internals, "runAnalyze").mockImplementation(() => {
			analyzeCalls += 1;
			return analyzeCalls === 1
				? gateA.promise
				: gatedPromise<DeadCodeResult>().promise;
		});

		void client.analyze("/probe-root"); // build A in flight
		await tick();
		expect(internals.inFlight.size).toBe(1);
		const key = [...internals.inFlight.keys()][0]!;

		// B replaces the entry under the same key while A is still in flight.
		const successor = gatedPromise<DeadCodeResult>();
		internals.inFlight.set(key, successor.promise);

		gateA.resolve(emptyResult()); // A settles late
		await tick();
		await tick();

		// B's entry survived A's cleanup...
		expect(internals.inFlight.get(key)).toBe(successor.promise);
		// ...and a third caller SHARES B instead of starting a duplicate build.
		void client.analyze("/probe-root");
		await tick();
		// Only build A ever ran: B was registered by the simulated second
		// writer, and the third caller shared it instead of starting a build.
		expect(analyzeCalls).toBe(1);

		successor.resolve(emptyResult());
	});

	it("a normally-settling build still cleans up its own entry", async () => {
		const client = new PythonDeadCodeClient(false);
		const internals = client as unknown as Internals;
		vi.spyOn(internals, "resolveProjectRoot").mockReturnValue("/probe-root");
		vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(internals, "runAnalyze").mockResolvedValue(emptyResult());

		await client.analyze("/probe-root");
		await tick();
		expect(internals.inFlight.size).toBe(0);
	});
});
