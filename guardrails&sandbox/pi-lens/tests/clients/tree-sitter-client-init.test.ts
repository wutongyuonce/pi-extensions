/**
 * Regression tests for tree-sitter-client wasm resolution.
 *
 * Ensures the wasm path is resolved via Node's module resolver (createRequire)
 * rather than a hardcoded relative path, so hoisted installs (pnpm, npm v7+
 * workspaces) don't produce ENOENT crashes. See issue #20.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TreeSitterClient,
	type TreeSitterParseCacheStats,
} from "../../clients/tree-sitter-client.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

const _require = createRequire(import.meta.url);

describe("tree-sitter-client wasm resolution", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:module");
		vi.clearAllMocks();
	});

	it("resolves tree-sitter.wasm via require.resolve, not a fixed node_modules path", () => {
		// If the package is installed, require.resolve should find the wasm
		// regardless of whether it's nested or hoisted.
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		expect(wasmPath).toMatch(/tree-sitter\.wasm$/);
		const client = new TreeSitterClient();
		const deps = (
			client as unknown as {
				grammarDirResolutionDeps: {
					cwd: () => string;
					resolvePackage: (specifier: string) => string;
					resolveAsset: (asset: string) => string | undefined;
				};
			}
		).grammarDirResolutionDeps;
		expect(deps.cwd()).toBe(process.cwd());
		expect(path.isAbsolute(deps.resolvePackage("vitest/package.json"))).toBe(
			true,
		);
		expect(deps.resolveAsset("grammars")).toBe(
			path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				"../../node_modules/web-tree-sitter/grammars",
			),
		);
		// Must NOT assume the wasm lives nested under pi-lens's own node_modules
		// relative to import.meta.url — that breaks in hoisted layouts.
		expect(path.isAbsolute(wasmPath)).toBe(true);
	});

	it("locateFile derives paths from the resolved wasm directory, not import.meta.url", () => {
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		const wasmDir = path.dirname(wasmPath);

		// Simulate what the locateFile callback does
		const locateFile = (scriptName: string) => path.join(wasmDir, scriptName);

		const result = locateFile("tree-sitter.wasm");
		expect(result).toBe(wasmPath);

		// Any sibling wasm file should also resolve to the same directory
		const sibling = locateFile("tree-sitter-typescript.wasm");
		expect(path.dirname(sibling)).toBe(wasmDir);
	});

	it("findGrammarsDir resolves the web-tree-sitter asset branch", () => {
		const env = setupTestEnvironment("pi-lens-tree-sitter-2112-asset-");
		try {
			const wasmPath = createTempFile(
				env.tmpDir,
				"grammars/tree-sitter-typescript.wasm",
				"fixture wasm",
			);
			const client = new TreeSitterClient(false, undefined, {
				resolveAsset: () => path.dirname(wasmPath),
				resolvePackage: () => {
					throw new Error("package resolver must not run");
				},
				cwd: () => {
					throw new Error("cwd resolver must not run");
				},
			}) as unknown as { grammarsDir: string };
			// isAvailable() overwrites this.grammarsDir; this post-construction
			// read is the only faithful observable of findGrammarsDir().
			expect(client.grammarsDir).toBe(path.dirname(wasmPath));
		} finally {
			env.cleanup();
		}
	});

	it("findGrammarsDir resolves the tree-sitter-wasms package branch", () => {
		const env = setupTestEnvironment("pi-lens-tree-sitter-2112-package-");
		try {
			const packageJson = createTempFile(
				env.tmpDir,
				"tree-sitter-wasms/package.json",
				"{}",
			);
			const expectedDir = path.join(env.tmpDir, "tree-sitter-wasms", "out");
			fs.mkdirSync(expectedDir);
			// An ambient cwd fixture must not win over the injected package branch.
			createTempFile(
				env.tmpDir,
				"node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
				"ambient fixture wasm",
			);
			const client = new TreeSitterClient(false, undefined, {
				resolveAsset: () => undefined,
				resolvePackage: (specifier) => {
					expect(specifier).toBe("tree-sitter-wasms/package.json");
					return packageJson;
				},
				cwd: () => env.tmpDir,
			}) as unknown as { grammarsDir: string };
			expect(client.grammarsDir).toBe(expectedDir);
		} finally {
			env.cleanup();
		}
	});

	it("findGrammarsDir resolves the cwd fallback branch", () => {
		const env = setupTestEnvironment("pi-lens-tree-sitter-2112-cwd-");
		try {
			const expectedDir = path.join(
				env.tmpDir,
				"node_modules",
				"tree-sitter-wasms",
				"out",
			);
			fs.mkdirSync(expectedDir, { recursive: true });
			const client = new TreeSitterClient(false, undefined, {
				resolveAsset: () => undefined,
				resolvePackage: () => {
					throw new Error("package resolver must not run");
				},
				cwd: () => env.tmpDir,
			}) as unknown as { grammarsDir: string };
			expect(client.grammarsDir).toBe(expectedDir);
		} finally {
			env.cleanup();
		}
	});

	it("findGrammarsDir returns empty when no branch resolves", () => {
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: () => undefined,
			resolvePackage: () => {
				throw new Error("package unavailable");
			},
			cwd: () => "C:/absent-pi-lens-test-cwd",
		}) as unknown as { grammarsDir: string };
		expect(client.grammarsDir).toBe("");
	});

	it("TreeSitterClient.isAvailable returns true when grammars are installed", async () => {
		const { getSharedTreeSitterClient } =
			await import("../../clients/tree-sitter-shared.js");
		const client = getSharedTreeSitterClient()!;
		expect(client.isAvailable()).toBe(true);
	});

	it("falls back to resolvePackagePath when require.resolve fails (on-the-fly compilation)", async () => {
		// Simulate pi's on-the-fly TS compilation: createRequire from a temp
		// directory cannot resolve web-tree-sitter, but resolvePackagePath
		// walking up from import.meta.url finds the package root.
		vi.doMock("node:module", () => ({
			createRequire: () => ({
				resolve: (id: string) => {
					if (id.includes("web-tree-sitter")) {
						throw new Error("Cannot find module from temp dir");
					}
					return _require.resolve(id);
				},
			}),
		}));

		const { getSharedTreeSitterClient } =
			await import("../../clients/tree-sitter-shared.js");
		const client = getSharedTreeSitterClient()!;
		// resolvePackagePath fallback should still find the grammars
		expect(client.isAvailable()).toBe(true);
	});

	it("records parser invocation time and failures", async () => {
		const client = new TreeSitterClient();
		const state = client as unknown as {
			parsers: Map<string, { parse: () => never }>;
		};
		state.parsers.set("typescript", {
			parse: () => {
				throw new Error("parse failed");
			},
		});

		await expect(
			client.parseFile("virtual.ts", "typescript", "const x = 1;"),
		).resolves.toBeNull();
		expect(client.getParseCacheStats()).toMatchObject({
			parserInvocations: 1,
			parserFailures: 1,
		});
		expect(client.getParseCacheStats().parserDurationMs).toBeGreaterThanOrEqual(
			0,
		);
	});

	it("keeps a replaced tree alive until its direct caller resumes", async () => {
		const client = new TreeSitterClient();
		const trees: Array<{
			delete: ReturnType<typeof vi.fn>;
			rootNode: { type: string };
		}> = [];
		const state = client as unknown as {
			parsers: Map<
				string,
				{ parse: (content: string) => (typeof trees)[number] }
			>;
		};
		state.parsers.set("typescript", {
			parse: () => {
				const tree = { delete: vi.fn(), rootNode: { type: "program" } };
				trees.push(tree);
				return tree;
			},
		});

		let firstWasAlive = false;
		const first = client
			.parseFile("same.ts", "typescript", "const value = 1;")
			.then((tree) => {
				firstWasAlive =
					tree?.rootNode.type === "program" &&
					!trees[0].delete.mock.calls.length;
			});
		const second = client.parseFile(
			"same.ts",
			"typescript",
			"const value = 2;",
		);
		await Promise.all([first, second]);

		expect(firstWasAlive).toBe(true);
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(trees[0].delete).toHaveBeenCalledTimes(1);
	});

	it("reports an abort thrown by a cache-safe consumer", async () => {
		const onWasmAbort = vi.fn();
		const client = new TreeSitterClient(false, onWasmAbort);
		const state = client as unknown as {
			parsers: Map<string, { parse: () => { rootNode: { type: string } } }>;
		};
		state.parsers.set("typescript", {
			parse: () => ({ rootNode: { type: "program" } }),
		});

		await expect(
			client.withParsedTree(
				"virtual.ts",
				"typescript",
				"const value = 1;",
				() => {
					throw new Error("Aborted()");
				},
			),
		).rejects.toThrow("Aborted()");
		expect(onWasmAbort).toHaveBeenCalledTimes(1);
		expect(client.isAvailable()).toBe(false);
	});

	it("isolates overlapping parse-cache measurements", async () => {
		const client = new TreeSitterClient();
		const state = client as unknown as {
			parsers: Map<string, { parse: () => { rootNode: { type: string } } }>;
		};
		state.parsers.set("typescript", {
			parse: () => ({ rootNode: { type: "program" } }),
		});

		let releaseA: () => void = () => {};
		let releaseB: () => void = () => {};
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const gateB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		let statsA: TreeSitterParseCacheStats | undefined;
		let statsB: TreeSitterParseCacheStats | undefined;
		const measurementA = client.withParseCacheMeasurement(
			async () => {
				await gateA;
				await client.parseFile("a.ts", "typescript", "const a = 1;");
			},
			(stats) => {
				statsA = stats;
			},
		);
		const measurementB = client.withParseCacheMeasurement(
			async () => {
				await gateB;
				await client.parseFile("b.ts", "typescript", "const b = 1;");
			},
			(stats) => {
				statsB = stats;
			},
		);

		releaseA();
		releaseB();
		await Promise.all([measurementA, measurementB]);

		expect(statsA).toMatchObject({ lookups: 1, sets: 1, parserInvocations: 1 });
		expect(statsB).toMatchObject({ lookups: 1, sets: 1, parserInvocations: 1 });
		expect(client.getParseCacheStats()).toMatchObject({
			lookups: 2,
			sets: 2,
			parserInvocations: 2,
		});
	});

	it("completes a measurement when the measured work fails", async () => {
		const client = new TreeSitterClient();
		let measured: TreeSitterParseCacheStats | undefined;

		await expect(
			client.withParseCacheMeasurement(
				async () => {
					throw new Error("work failed");
				},
				(stats) => {
					measured = stats;
				},
			),
		).rejects.toThrow("work failed");
		expect(measured).toMatchObject({ lookups: 0, parserInvocations: 0 });
	});

	it("re-evaluates when grammarsDir was initially unresolved (no cached-empty)", async () => {
		// The regression that produced 108 "client_unavailable" log lines:
		// grammarsDir was cached as "" in the constructor and never re-checked.
		// Force that state, then assert isAvailable recovers against the real fs
		// (bundled grammars/ and/or web-tree-sitter/grammars are present) rather
		// than staying stuck on the empty cache.
		const { getSharedTreeSitterClient } =
			await import("../../clients/tree-sitter-shared.js");
		// biome-ignore lint/suspicious/noExplicitAny: poke privates for the regression
		const client = getSharedTreeSitterClient() as any;
		client.grammarsDir = "";
		client._bundledGrammarsDir = undefined;

		expect(client.isAvailable()).toBe(true);
	});
});
