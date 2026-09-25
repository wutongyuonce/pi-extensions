/**
 * The shared web-tree-sitter package-directory ladder (#3409), tested at the
 * module the three callers now share: `clients/tree-sitter-client.ts`,
 * `clients/install-diagnostics.ts` and `scripts/install-selftest.mjs`.
 *
 * Round 1 review of PR #3418 raised two things this file pins:
 *
 * R3418-1 — the constructed rungs (pi-lens's package root, the working
 * directory) accepted any directory that merely EXISTED at
 * `<base>/node_modules/web-tree-sitter`, so an empty or foreign directory of
 * that name became the runtime fetch's write target and a downloaded grammar
 * would land in an unrelated tree.
 *
 * R3418-2 — `scripts/install-selftest.mjs` still resolved the BARE specifier and
 * walked up, so on the host pi ships as (a `bun build --compile` binary, where a
 * bare specifier throws MODULE_NOT_FOUND while the exported wasm subpath
 * resolves) the installed-host diagnostic reported the grammar asset missing
 * even though it was there. The compiled host is reproduced here by the injected
 * resolver — the same contract the reporter's transcript states — and the layouts
 * are real directories.
 *
 * No mock: this module takes its resolver, package root and cwd as arguments.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isWebTreeSitterPackageDir,
	resolveWebTreeSitterPackageDir,
} from "../../scripts/lib/web-tree-sitter-dir.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

/** The shape an installed web-tree-sitter package actually has. */
function writePackage(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "tree-sitter.wasm"), "");
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "web-tree-sitter", version: "0.25.10" }),
	);
	return dir;
}

function moduleNotFound(id: string): never {
	const err = new Error(`Cannot find module '${id}'`) as Error & {
		code?: string;
	};
	err.code = "MODULE_NOT_FOUND";
	throw err;
}

/** A `bun build --compile` resolver: bare throws, an explicit subpath resolves. */
function compiledHostResolver(pkgDir: string) {
	return (specifier: string): string =>
		specifier === "web-tree-sitter/tree-sitter.wasm"
			? path.join(pkgDir, "tree-sitter.wasm")
			: moduleNotFound(specifier);
}

describe("web-tree-sitter package identity (#3409 r1 R3418-1)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-wts-dir-");
	});
	afterEach(() => env.cleanup());

	it("accepts a directory carrying the package's own manifest and wasm", () => {
		expect(
			isWebTreeSitterPackageDir(
				writePackage(path.join(env.tmpDir, "node_modules", "web-tree-sitter")),
			),
		).toBe(true);
	});

	it("rejects an empty directory of that name", () => {
		const dir = path.join(env.tmpDir, "node_modules", "web-tree-sitter");
		fs.mkdirSync(dir, { recursive: true });

		expect(isWebTreeSitterPackageDir(dir)).toBe(false);
	});

	it("rejects a directory whose manifest names another package", () => {
		const dir = path.join(env.tmpDir, "node_modules", "web-tree-sitter");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "tree-sitter.wasm"), "");
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "web-tree-sitter-fork" }),
		);

		expect(isWebTreeSitterPackageDir(dir)).toBe(false);
	});

	it("rejects a manifest-only directory with no runtime wasm", () => {
		// A partial or interrupted install: grammars written next to a package the
		// runtime cannot load are unusable, so this is not a write target.
		const dir = path.join(env.tmpDir, "node_modules", "web-tree-sitter");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "web-tree-sitter" }),
		);

		expect(isWebTreeSitterPackageDir(dir)).toBe(false);
	});

	it("rejects a directory whose manifest is not readable JSON", () => {
		const dir = path.join(env.tmpDir, "node_modules", "web-tree-sitter");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "tree-sitter.wasm"), "");
		fs.writeFileSync(path.join(dir, "package.json"), "{ not json");

		expect(isWebTreeSitterPackageDir(dir)).toBe(false);
	});
});

describe("install-selftest's grammar probe on a compiled host (#3409 r1 R3418-2)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-wts-selftest-");
	});
	afterEach(() => env.cleanup());

	it("sees the installed grammar asset when only the wasm subpath resolves", () => {
		// Exactly how `scripts/install-selftest.mjs` now asks the question, and
		// exactly what it then checks. Pre-fix that script walked up from the BARE
		// specifier, so this host reported "web-tree-sitter unresolved" and the
		// asset row read as missing.
		const pkgDir = writePackage(
			path.join(env.tmpDir, "install", "node_modules", "web-tree-sitter"),
		);
		fs.mkdirSync(path.join(pkgDir, "grammars"), { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, "grammars", "tree-sitter-typescript.wasm"),
			"",
		);
		const emptyDir = path.join(env.tmpDir, "elsewhere");
		fs.mkdirSync(emptyDir, { recursive: true });

		const resolved = resolveWebTreeSitterPackageDir({
			resolve: compiledHostResolver(pkgDir),
			packageRoot: () => emptyDir,
			cwd: () => emptyDir,
		});

		expect(resolved).toBe(pkgDir);
		expect(
			fs.existsSync(
				path.join(
					resolved as string,
					"grammars",
					"tree-sitter-typescript.wasm",
				),
			),
		).toBe(true);
	});

	it("reports nothing rather than a foreign directory when the package is absent", () => {
		// The selftest's failure row has to say "unresolvable", not name a
		// directory that is not web-tree-sitter.
		const cwd = path.join(env.tmpDir, "project");
		fs.mkdirSync(path.join(cwd, "node_modules", "web-tree-sitter"), {
			recursive: true,
		});

		expect(
			resolveWebTreeSitterPackageDir({
				resolve: (specifier) => moduleNotFound(specifier),
				packageRoot: () => cwd,
				cwd: () => cwd,
			}),
		).toBeUndefined();
	});
});
