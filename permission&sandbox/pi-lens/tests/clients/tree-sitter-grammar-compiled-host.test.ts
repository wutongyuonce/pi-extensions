/**
 * #3409: on a host whose runtime cannot resolve a BARE package specifier, no
 * non-core tree-sitter grammar could ever be fetched.
 *
 * pi ships as a `bun build --compile` binary. Inside that runtime
 * `require.resolve("web-tree-sitter")` throws MODULE_NOT_FOUND while
 * `require.resolve("web-tree-sitter/tree-sitter.wasm")` — an explicit file
 * subpath — still resolves (reporter's transcript, issue #3409). The only rung
 * `grammarsWriteDir()` had was the bare specifier, so it returned `undefined`,
 * `ensureGrammar` had no write target, and every C#/C++/OCaml file reported the
 * language unavailable with a message blaming pnpm/bun build scripts and the
 * network — none of which was involved.
 *
 * Recurrence these tests prevent: a grammar-directory rung that depends on a
 * bare specifier resolving, and a "could not find anywhere to write" failure
 * reported as a download/build-scripts/network problem.
 *
 * The compiled host is simulated at the ONE boundary that actually differs —
 * the resolver object `node:module`'s `createRequire` hands back. Everything
 * inside the client is real, the install layouts on disk are real files, and
 * `resolvePackagePath(import.meta.url, …)` (pure `fs`) is never faked, because
 * it is the rung the reporter proved still works on that host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/**
 * Flipped per test. `true` reproduces the compiled host: a bare specifier
 * throws MODULE_NOT_FOUND, an explicit subpath resolves normally. Read lazily
 * inside `resolve`, so the flag can move after the client module (and its
 * module-level `createRequire`) has already been imported.
 */
const compiledHost = vi.hoisted(() => ({ bareSpecifiersThrow: false }));

/** `web-tree-sitter` and `@scope/pkg` are bare; `pkg/file.wasm` is not. */
function isBareSpecifier(id: string): boolean {
	if (id.startsWith(".") || path.isAbsolute(id)) return false;
	const withoutScope = id.startsWith("@")
		? id.split("/").slice(1).join("/")
		: id;
	return !withoutScope.includes("/");
}

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: (from: string | URL) => {
			const real = actual.createRequire(from);
			const resolve = ((id: string, options?: { paths?: string[] }) => {
				if (compiledHost.bareSpecifiersThrow && isBareSpecifier(id)) {
					const err = new Error(`Cannot find module '${id}'`) as Error & {
						code?: string;
					};
					err.code = "MODULE_NOT_FOUND";
					throw err;
				}
				return real.resolve(id, options as never);
			}) as NodeJS.Require["resolve"];
			resolve.paths = (id: string) => real.resolve.paths(id);
			return Object.assign((id: string) => real(id), real, {
				resolve,
			}) as NodeJS.Require;
		},
	};
});

type DiagnosticRecord = {
	message?: string;
	metadata?: Record<string, unknown>;
};

const logged = vi.hoisted(() => [] as DiagnosticRecord[]);
vi.mock("../../clients/tree-sitter-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/tree-sitter-logger.js")
		>();
	return {
		...actual,
		logTreeSitterDiagnostic: (entry: DiagnosticRecord) => {
			logged.push(entry);
		},
	};
});

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

/** The private surface these tests observe, all of it pre-existing. */
type GrammarDirClient = {
	grammarsDir: string;
	grammarsWriteDir(): string | undefined;
	resolveWebTreeSitterAsset(asset: string): string | undefined;
	resolveGrammarFile(file: string): string | undefined;
	fetchGrammar(file: string): Promise<boolean>;
	grammarDirResolutionDeps: {
		resolveAsset: (asset: string) => string | undefined;
		resolvePackage: (specifier: string) => string;
		packageRoot: () => string;
		cwd: () => string;
	};
};

/**
 * A grammar filename with no entry in `scripts/grammars.lock.json`, so the
 * read-back case pins directory resolution without depending on which real
 * grammars this host happens to have downloaded (CI has none in
 * `node_modules/web-tree-sitter/grammars`).
 */
const GRAMMAR_FIXTURE = "tree-sitter-unpinned3409.wasm";

/**
 * Write the shape an installed web-tree-sitter package actually has: its own
 * manifest and the wasm the runtime loads. Round 1 review R3418-1: a directory
 * merely NAMED web-tree-sitter is not the package, and accepting one on
 * existence alone let `grammarsWriteDir()` pick a write target in an unrelated
 * tree.
 */
function writeWebTreeSitterPackage(dir: string): string {
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

/**
 * A client whose module resolver behaves like the reporter's host: the bare
 * specifier throws, and `web-tree-sitter/tree-sitter.wasm` resolves into
 * `pkgDir` — a HOISTED sibling install. pi-lens's own package root is a real
 * directory with no nested `node_modules`, which is what a hoisted install
 * looks like (web-tree-sitter is pi-lens's SIBLING there, not its child), and
 * `cwd` points at a decoy that also holds a `web-tree-sitter/grammars`, so an
 * answer that came from either fallback rung is distinguishable from one that
 * came from the resolved package directory.
 */
/**
 * `grammarsWriteDir()` with BOTH resolver rungs unavailable, so only the
 * package-root and cwd fallbacks can answer. Round 1 review: those two rungs had
 * no signature of their own and no identity check.
 */
async function writeDirWithFallbacks(
	packageRoot: string,
	cwd: string,
): Promise<string | undefined> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	let instance: GrammarDirClient | undefined;
	const client = new TreeSitterClient(false, undefined, {
		resolveAsset: (asset: string) => instance?.resolveWebTreeSitterAsset(asset),
		resolvePackage: (specifier: string) => moduleNotFound(specifier),
		packageRoot: () => packageRoot,
		cwd: () => cwd,
	}) as unknown as GrammarDirClient;
	instance = client;
	return client.grammarsWriteDir();
}

async function hoistedHostClient(
	pkgDir: string,
	decoyCwd: string,
	packageRoot: string,
): Promise<GrammarDirClient> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	let instance: GrammarDirClient | undefined;
	const client = new TreeSitterClient(false, undefined, {
		// The constructor's own findGrammarsDir() call runs before `instance` is
		// assigned; answering undefined there leaves grammarsDir "", which is the
		// state this issue is about (nothing on disk yet).
		resolveAsset: (asset: string) => instance?.resolveWebTreeSitterAsset(asset),
		resolvePackage: (specifier: string) =>
			specifier === "web-tree-sitter/tree-sitter.wasm"
				? path.join(pkgDir, "tree-sitter.wasm")
				: moduleNotFound(specifier),
		packageRoot: () => packageRoot,
		cwd: () => decoyCwd,
	}) as unknown as GrammarDirClient;
	instance = client;
	return client;
}

describe("#3409 compiled host — bare specifier unresolvable", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-3409-");
		logged.length = 0;
		notifyUserDegradation.mockClear();
		compiledHost.bareSpecifiersThrow = true;
	});

	afterEach(() => {
		compiledHost.bareSpecifiersThrow = false;
		vi.restoreAllMocks();
		env.cleanup();
	});

	it("resolves web-tree-sitter's grammars dir as the runtime-fetch write target when only the wasm subpath resolves", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as GrammarDirClient;

		const dir = client.grammarsWriteDir();

		// Shape, not an absolute path: node_modules may be a symlink in a
		// worktree, so require.resolve's realpath answer is not textually
		// predictable. The last assertion ties it to the REAL installed package
		// through a file the package itself ships — `grammars/` is populated by a
		// postinstall download and is EMPTY in CI, so asserting a grammar here
		// would pin the install lottery rather than the resolution.
		expect(dir).toBeDefined();
		expect(path.basename(dir as string)).toBe("grammars");
		expect(path.basename(path.dirname(dir as string))).toBe("web-tree-sitter");
		expect(
			fs.existsSync(path.join(path.dirname(dir as string), "tree-sitter.wasm")),
		).toBe(true);
	});

	it("derives the write dir from a hoisted sibling install, not from pi-lens's own package root", async () => {
		const pkgDir = writeWebTreeSitterPackage(
			path.join(env.tmpDir, "hoisted", "web-tree-sitter"),
		);
		const client = await hoistedHostClient(
			pkgDir,
			path.join(env.tmpDir, "decoy"),
			path.join(env.tmpDir, "pi-lens"),
		);

		expect(client.grammarsWriteDir()).toBe(path.join(pkgDir, "grammars"));
	});

	it("reads a grammars dir out of the resolved package instead of process.cwd()", async () => {
		const pkgDir = writeWebTreeSitterPackage(
			path.join(env.tmpDir, "hoisted", "web-tree-sitter"),
		);
		fs.mkdirSync(path.join(pkgDir, "grammars"), { recursive: true });
		const decoyCwd = path.join(env.tmpDir, "decoy");
		fs.mkdirSync(
			path.join(decoyCwd, "node_modules", "web-tree-sitter", "grammars"),
			{ recursive: true },
		);
		const client = await hoistedHostClient(
			pkgDir,
			decoyCwd,
			path.join(env.tmpDir, "pi-lens"),
		);

		expect(client.resolveWebTreeSitterAsset("grammars")).toBe(
			path.join(pkgDir, "grammars"),
		);
	});

	it("finds a grammar already on disk in the resolved package's grammars dir", async () => {
		const pkgDir = writeWebTreeSitterPackage(
			path.join(env.tmpDir, "hoisted", "web-tree-sitter"),
		);
		const grammars = path.join(pkgDir, "grammars");
		fs.mkdirSync(grammars, { recursive: true });
		// A real wasm preamble: `resolveGrammarFile` rejects a body without it as
		// poisoned (#1548), so a three-byte stub would prove nothing. The filename
		// is deliberately NOT one of the pinned grammars: with no entry in
		// scripts/grammars.lock.json the sha256 check is "cannot verify" rather
		// than a mismatch (#1760), which keeps this case about WHERE the file was
		// found — the only thing #3409 changed — and off the install lottery of
		// which real grammars happen to be on this host.
		fs.writeFileSync(
			path.join(grammars, GRAMMAR_FIXTURE),
			Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
		);
		const client = await hoistedHostClient(
			pkgDir,
			path.join(env.tmpDir, "decoy"),
			path.join(env.tmpDir, "pi-lens"),
		);

		expect(client.resolveGrammarFile(GRAMMAR_FIXTURE)).toBe(
			path.join(grammars, GRAMMAR_FIXTURE),
		);
	});

	it("climbs to the package directory when the exported subpath lives in a subdirectory", async () => {
		// Not today's layout (0.25.10 maps "./tree-sitter.wasm" to the package
		// root) but the one the #381 0.26 migration may bring: an exports map that
		// points into a subdirectory. The rung must land on the PACKAGE, never on
		// the subdirectory that happened to hold the file.
		const pkgDir = writeWebTreeSitterPackage(
			path.join(env.tmpDir, "hoisted", "web-tree-sitter"),
		);
		fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
		fs.writeFileSync(path.join(pkgDir, "lib", "tree-sitter.wasm"), "");
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		let instance: GrammarDirClient | undefined;
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: (asset: string) =>
				instance?.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier: string) =>
				specifier === "web-tree-sitter/tree-sitter.wasm"
					? path.join(pkgDir, "lib", "tree-sitter.wasm")
					: moduleNotFound(specifier),
			packageRoot: () => path.join(env.tmpDir, "pi-lens"),
			cwd: () => path.join(env.tmpDir, "decoy"),
		}) as unknown as GrammarDirClient;
		instance = client;

		expect(client.grammarsWriteDir()).toBe(path.join(pkgDir, "grammars"));
	});

	it("prefers the package the runtime will actually load over a nested copy", async () => {
		// Both rungs can answer, and they disagree: a nested
		// `<pi-lens>/node_modules/web-tree-sitter` next to a hoisted sibling the
		// resolver points at. The grammars have to come from the SAME package whose
		// `tree-sitter.wasm` the runtime loaded — a grammar built for another
		// web-tree-sitter is the ABI-drift decode failure #1564 is about — so the
		// resolver's answer outranks the package-root guess.
		const pkgDir = writeWebTreeSitterPackage(
			path.join(env.tmpDir, "hoisted", "web-tree-sitter"),
		);
		const nestedRoot = path.join(env.tmpDir, "pi-lens");
		// A REAL package, not just a directory with the name: otherwise the
		// identity check alone would decide this case and the ORDER would go
		// unpinned (round 1 review R3418-1).
		fs.mkdirSync(
			path.join(
				writeWebTreeSitterPackage(
					path.join(nestedRoot, "node_modules", "web-tree-sitter"),
				),
				"grammars",
			),
			{ recursive: true },
		);
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		let instance: GrammarDirClient | undefined;
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: (asset: string) =>
				instance?.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier: string) =>
				specifier === "web-tree-sitter/tree-sitter.wasm"
					? path.join(pkgDir, "tree-sitter.wasm")
					: moduleNotFound(specifier),
			packageRoot: () => nestedRoot,
			cwd: () => path.join(env.tmpDir, "decoy"),
		}) as unknown as GrammarDirClient;
		instance = client;

		expect(client.grammarsWriteDir()).toBe(path.join(pkgDir, "grammars"));
	});

	it("refuses a resolved path with no web-tree-sitter ancestor instead of walking out to the filesystem root", async () => {
		// The walk-up has to stop SOMEWHERE. Without the identity check at its end
		// it returns "/" for any resolver that answers outside the package, and the
		// write dir becomes "/grammars".
		const stray = path.join(env.tmpDir, "elsewhere");
		fs.mkdirSync(stray, { recursive: true });
		fs.writeFileSync(path.join(stray, "tree-sitter.wasm"), "");
		const emptyCwd = path.join(env.tmpDir, "empty");
		fs.mkdirSync(emptyCwd, { recursive: true });
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		let instance: GrammarDirClient | undefined;
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: (asset: string) =>
				instance?.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier: string) =>
				specifier === "web-tree-sitter/tree-sitter.wasm"
					? path.join(stray, "tree-sitter.wasm")
					: moduleNotFound(specifier),
			packageRoot: () => emptyCwd,
			cwd: () => emptyCwd,
		}) as unknown as GrammarDirClient;
		instance = client;

		expect(client.grammarsWriteDir()).toBeUndefined();
	});

	it("refuses a cwd directory that is merely NAMED web-tree-sitter", async () => {
		// Round 1 review R3418-1, reproduced: the reviewer's probe got a write
		// target out of an EMPTY `cwd/node_modules/web-tree-sitter`, so a fetched
		// grammar would have been written into an unrelated tree.
		const cwd = path.join(env.tmpDir, "project");
		fs.mkdirSync(path.join(cwd, "node_modules", "web-tree-sitter"), {
			recursive: true,
		});

		expect(await writeDirWithFallbacks(cwd, cwd)).toBeUndefined();
	});

	it("refuses a cwd web-tree-sitter directory belonging to another package", async () => {
		// The name is right, the wasm is there, and the manifest says it is
		// something else — a vendored fork, a stale rename, a coincidence.
		const cwd = path.join(env.tmpDir, "project");
		const foreign = path.join(cwd, "node_modules", "web-tree-sitter");
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(foreign, "tree-sitter.wasm"), "");
		fs.writeFileSync(
			path.join(foreign, "package.json"),
			JSON.stringify({ name: "web-tree-sitter-fork", version: "9.9.9" }),
		);

		expect(await writeDirWithFallbacks(cwd, cwd)).toBeUndefined();
	});

	it("refuses a package-root directory that is merely NAMED web-tree-sitter", async () => {
		const root = path.join(env.tmpDir, "pi-lens");
		fs.mkdirSync(path.join(root, "node_modules", "web-tree-sitter"), {
			recursive: true,
		});
		const emptyCwd = path.join(env.tmpDir, "empty");
		fs.mkdirSync(emptyCwd, { recursive: true });

		expect(await writeDirWithFallbacks(root, emptyCwd)).toBeUndefined();
	});

	it("accepts a real package under pi-lens's own package root when the resolver cannot answer", async () => {
		// The #20 temp-dir-compile rung, with a signature of its own: before this
		// round, deleting it left every case green.
		const root = path.join(env.tmpDir, "pi-lens");
		const pkgDir = writeWebTreeSitterPackage(
			path.join(root, "node_modules", "web-tree-sitter"),
		);
		const emptyCwd = path.join(env.tmpDir, "empty");
		fs.mkdirSync(emptyCwd, { recursive: true });

		expect(await writeDirWithFallbacks(root, emptyCwd)).toBe(
			path.join(pkgDir, "grammars"),
		);
	});

	it("accepts a real package under the working directory as the last resort", async () => {
		const cwd = path.join(env.tmpDir, "project");
		const pkgDir = writeWebTreeSitterPackage(
			path.join(cwd, "node_modules", "web-tree-sitter"),
		);
		const emptyRoot = path.join(env.tmpDir, "pi-lens");
		fs.mkdirSync(emptyRoot, { recursive: true });

		expect(await writeDirWithFallbacks(emptyRoot, cwd)).toBe(
			path.join(pkgDir, "grammars"),
		);
	});

	it("still returns undefined, and never invents a path, when web-tree-sitter is absent everywhere", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const emptyCwd = path.join(env.tmpDir, "empty");
		fs.mkdirSync(emptyCwd, { recursive: true });
		let instance: GrammarDirClient | undefined;
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: (asset: string) =>
				instance?.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier: string) => moduleNotFound(specifier),
			packageRoot: () => emptyCwd,
			cwd: () => emptyCwd,
		}) as unknown as GrammarDirClient;
		instance = client;

		expect(client.grammarsWriteDir()).toBeUndefined();
	});

	it("names the resolution gap — not build scripts or the network — when no destination resolves", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const emptyCwd = path.join(env.tmpDir, "empty");
		fs.mkdirSync(emptyCwd, { recursive: true });
		let instance: GrammarDirClient | undefined;
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: (asset: string) =>
				instance?.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier: string) => moduleNotFound(specifier),
			packageRoot: () => emptyCwd,
			cwd: () => emptyCwd,
		}) as unknown as GrammarDirClient;
		instance = client;
		client.grammarsDir = "";
		vi.spyOn(client, "resolveGrammarFile").mockReturnValue(undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(await client.fetchGrammar("tree-sitter-c_sharp.wasm")).toBe(false);

		expect(fetchSpy).not.toHaveBeenCalled();
		const record = logged.at(-1) as DiagnosticRecord;
		expect(record.metadata).toMatchObject({
			outcome: "unavailable",
			cause: "write-dir-unresolvable",
		});
		expect(record.message).toContain("web-tree-sitter");
		expect(record.message).not.toContain("approve-builds");
		expect(record.message).not.toContain("network access");
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(notifyUserDegradation.mock.calls[0][0]).not.toContain(
			"approve-builds",
		);
	});

	it("reports an unwritable destination as such, without spending a download on it", async (ctx) => {
		const readOnly = path.join(env.tmpDir, "read-only");
		fs.mkdirSync(readOnly, { recursive: true });
		fs.chmodSync(readOnly, 0o500);
		// MEASURED precondition, not an asserted platform skip: root and most
		// Windows ACL setups can write into a 0o500 directory, and there the case
		// under test cannot exist at all.
		let enforced = false;
		try {
			fs.writeFileSync(path.join(readOnly, ".probe"), "x");
		} catch {
			enforced = true;
		}
		if (!enforced) {
			fs.chmodSync(readOnly, 0o700);
			// A VISIBLE skip (#2089): root, and most Windows ACL setups, can write
			// into a 0o500 directory, so the case under test cannot exist there.
			ctx.skip(
				"this process can write into a 0o500 directory — no unwritable destination to test",
			);
		}

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as GrammarDirClient;
		client.grammarsDir = "";
		vi.spyOn(client, "resolveGrammarFile").mockReturnValue(undefined);
		vi.spyOn(client, "grammarsWriteDir").mockReturnValue(
			path.join(readOnly, "grammars"),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(await client.fetchGrammar("tree-sitter-c_sharp.wasm")).toBe(false);

		expect(fetchSpy).not.toHaveBeenCalled();
		const record = logged.at(-1) as DiagnosticRecord;
		expect(record.metadata).toMatchObject({
			outcome: "unavailable",
			cause: "write-dir-unwritable",
		});
		expect(record.message).toContain(readOnly);
		expect(record.message).not.toContain("approve-builds");
		fs.chmodSync(readOnly, 0o700);
	});
});

describe("#3409 normal host — behaviour unchanged", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-3409-node-");
		compiledHost.bareSpecifiersThrow = false;
		logged.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		env.cleanup();
		removeTempDirSync(env.tmpDir);
	});

	it("resolves the same write dir on a host where the bare specifier works", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as GrammarDirClient;

		const dir = client.grammarsWriteDir();

		expect(dir).toBeDefined();
		expect(path.basename(dir as string)).toBe("grammars");
		expect(path.basename(path.dirname(dir as string))).toBe("web-tree-sitter");
		expect(
			fs.existsSync(path.join(path.dirname(dir as string), "tree-sitter.wasm")),
		).toBe(true);
	});

	it("keeps the direct subpath resolve as the first rung for an exported asset", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as GrammarDirClient;

		const wasm = client.resolveWebTreeSitterAsset("tree-sitter.wasm");

		expect(wasm).toBeDefined();
		expect(path.basename(wasm as string)).toBe("tree-sitter.wasm");
		expect(fs.existsSync(wasm as string)).toBe(true);
	});
});
