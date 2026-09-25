/**
 * #2468/#2481: `clients/formatters.ts` invoked bare `ktfmt <file>` with no
 * style flag, so ktfmt formatted under its own default style instead of the
 * project's actual Gradle or Spotless style selection — the same
 * manifest-detected-but-not-carried defect shape #2466 fixed for rustfmt
 * `--edition`.
 *
 * The two argv cases (the carried `--google-style`, and the fallback that
 * must carry nothing) call `ktfmtFormatter.resolveCommand` (the same pattern
 * as `formatters-rustfmt-edition.test.ts`) with a project-local PATH shim so
 * the real `which`/`where` spawn resolves `ktfmt` for real — that pair is the
 * load-bearing regression proof that the style flag reaches, and stays out
 * of, ktfmt's actual argv. The remaining cases call `resolveKtfmtGradleStyle`
 * (`clients/gradle-ktfmt-style.ts`) directly, the same way
 * `formatters-rustfmt-edition.test.ts`'s F5 case calls
 * `resolveCargoPackageEdition` directly for the `homeDir`-override case that
 * `resolveCommand` doesn't expose.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	flushExtensionLog,
	getExtensionLogPath,
} from "../../clients/extension-log.js";
import { ktfmtFormatter } from "../../clients/formatters.js";
import { resolveKtfmtGradleStyle } from "../../clients/gradle-ktfmt-style.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const tmpDirs: string[] = [];
const isWin = process.platform === "win32";

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
	}
});

function newTmpDir(prefix: string): string {
	const env = setupTestEnvironment(prefix);
	tmpDirs.push(env.tmpDir);
	return env.tmpDir;
}

function readExtensionLogRows(): Array<Record<string, unknown>> {
	const logPath = getExtensionLogPath();
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

function makeFakeKtfmtExe(shimDir: string): void {
	const exeName = isWin ? "ktfmt.cmd" : "ktfmt";
	const filePath = path.join(shimDir, exeName);
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(
		filePath,
		isWin ? "@echo off\r\n" : "#!/bin/sh\necho fake\n",
	);
	if (!isWin) fs.chmodSync(filePath, 0o755);
}

async function withKtfmtOnPath(
	shimDir: string,
	fn: () => Promise<void>,
): Promise<void> {
	makeFakeKtfmtExe(shimDir);
	const origPath = process.env.PATH;
	process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;
	try {
		await fn();
	} finally {
		process.env.PATH = origPath;
	}
}

describe("ktfmtFormatter — Gradle and Spotless style carriage (#2468/#2481)", () => {
	it("passes --google-style from the nearest ktfmt {} block's googleStyle()", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-google-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n\n' +
				"ktfmt {\n  googleStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "main", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			// The load-bearing assertion: removing the style-flag carriage from
			// the fix collapses this back to [shimPath, filePath] and this line
			// goes red.
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [binary, ...rest] = resolved as string[];
			expect(binary.toLowerCase()).toContain("ktfmt");
			expect(rest).toEqual(["--google-style", filePath]);
		});
	});

	it("passes --google-style from a Spotless ktfmt fluent chain", async () => {
		const tmpDir = newTmpDir("pi-lens-spotless-ktfmt-google-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'spotless {\n  kotlin {\n    ktfmt("0.63").googleStyle()\n  }\n}\n',
		);
		const filePath = path.join(tmpDir, "src", "main", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [, ...args] = resolved as string[];
			expect(args).toEqual(["--google-style", filePath]);
		});
	});

	it("passes --kotlinlang-style from Spotless kotlinlangStyle()", async () => {
		const tmpDir = newTmpDir("pi-lens-spotless-ktfmt-kotlinlang-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle"),
			"spotless {\n  kotlin {\n    ktfmt('0.63').kotlinlangStyle()\n  }\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [, ...args] = resolved as string[];
			expect(args).toEqual(["--kotlinlang-style", filePath]);
		});
	});

	it("logs the Spotless dropboxStyle() limitation and falls back to bare ktfmt", async () => {
		const tmpDir = newTmpDir("pi-lens-spotless-ktfmt-dropbox-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'spotless {\n  kotlin {\n    ktfmt("0.63").dropboxStyle()\n  }\n}\n',
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		const secondFilePath = path.join(tmpDir, "src", "Other.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");
		fs.writeFileSync(secondFilePath, "fun other() {}\n");

		resetDegradationLedger();
		const originalTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
				const resolved = await ktfmtFormatter.resolveCommand?.(
					filePath,
					tmpDir,
				);
				expect(resolved).not.toBeNull();
				expect(resolved).not.toBeUndefined();
				expect((resolved as string[]).slice(1)).toEqual([filePath]);

				const second = await ktfmtFormatter.resolveCommand?.(
					secondFilePath,
					tmpDir,
				);
				expect(second).not.toBeNull();
				expect(second).not.toBeUndefined();
				expect((second as string[]).slice(1)).toEqual([secondFilePath]);
			});

			await flushExtensionLog();
			const message =
				"Spotless ktfmt dropboxStyle(): pi-lens standalone CLI cannot express " +
				"the style; falling back to bare ktfmt";
			const emitted = readExtensionLogRows().filter((row) => {
				const metadata = row.metadata as
					| { filePath?: unknown; gradleDir?: unknown }
					| undefined;
				return (
					row.message === message &&
					metadata?.filePath === filePath &&
					metadata?.gradleDir === tmpDir
				);
			});
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toMatchObject({
				level: "debug",
				subsystem: "format",
				message,
				metadata: { filePath, gradleDir: tmpDir },
			});
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "formatter-skip",
				),
			).toMatchObject({ count: 2 });
		} finally {
			if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = originalTestMode;
			resetDegradationLedger();
		}
	});

	it("resolves --kotlinlang-style for a kotlinLangStyle() declaration", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-kotlinlang-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  kotlinLangStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBe("--kotlinlang-style");
	});

	it("nested module's own ktfmt {} declaration overrides the root's (nearest wins)", async () => {
		const root = newTmpDir("pi-lens-ktfmt-nearest-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			"ktfmt {\n  kotlinLangStyle()\n}\n",
		);
		const filePath = path.join(moduleDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBe("--kotlinlang-style");
	});

	it("falls back (undefined) when no build.gradle(.kts) is found", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-nogradle-");
		const filePath = path.join(tmpDir, "loose.kt");
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBeUndefined();
	});

	it("falls back when the ktfmt {} block declares no recognized style", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-nostyle-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n\n' +
				"ktfmt {\n  maxWidth.set(120)\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBeUndefined();
	});

	it("falls back to the bare argv when the block declares the removed dropboxStyle()", async () => {
		// dropboxStyle() was removed from ktfmt-gradle in 0.19.0 (2024-07-03,
		// "no longer supported by ktfmt") and ktfmt's own CLI never exposed a
		// --dropbox-style flag (verified against ParsedArgs.kt, v0.63). A
		// project still calling it (stale plugin / manual block) must not get
		// a guessed/nonexistent flag passed through.
		//
		// Review round 2, F2: this case used to be routed through a
		// "dropbox-unsupported" sentinel return whose only effect was a debug
		// log — deleting the sentinel branch left every assertion green
		// because the ordinary no-recognized-style fall-through produced the
		// identical argv. The sentinel is gone; the case stays, asserting the
		// thing that is actually load-bearing for a user: the argv ktfmt is
		// spawned with carries no style flag.
		const tmpDir = newTmpDir("pi-lens-ktfmt-dropbox-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  dropboxStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [binary, ...rest] = resolved as string[];
			expect(binary.toLowerCase()).toContain("ktfmt");
			expect(rest).toEqual([filePath]);
		});
	});

	it("stops the ancestor climb at the injected HOME ceiling even when a style sits one level above it", async () => {
		// Mutation-proof HOME-ceiling fixture (mirrors formatters-rustfmt-
		// edition.test.ts's F5 case): the fixture tree puts a build.gradle.kts
		// declaring a style ABOVE an injected `homeDir`, with the formatted
		// file BELOW it and no gradle file of its own between them. If the
		// `homeDir` ceiling inside `findNearestMarkerRoot`'s climb were
		// neutered, the climb would sail past the injected home, find the
		// root's googleStyle(), and this assertion would go red.
		const tmpDir = newTmpDir("pi-lens-ktfmt-homeceiling-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const homeDir = path.join(tmpDir, "home");
		const projectDir = path.join(homeDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const filePath = path.join(projectDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath, homeDir);

		expect(resolved).toBeUndefined();
	});
});

/**
 * Review round 2, F1: the round-1 resolver stopped the ancestor climb at the
 * FIRST directory holding any gradle file (even one declaring no style) and
 * matched `ktfmt {` anywhere in the file with no project scoping. Both halves
 * are wrong in the layout `com.ncorti.ktfmt.gradle` actually gets used in for
 * multi-module builds — the style lives in the ROOT build file's
 * `subprojects { }` / `allprojects { }` body, and the module's own
 * `build.gradle.kts` declares only its plugins.
 *
 * `homeDir` is pinned to the fixture root's parent in every case here so the
 * multi-hop climb is hermetic (it can never reach a real gradle file above
 * `os.tmpdir()`) and so the ceiling is proven to bound the NEW, multi-hop
 * walk, not just the round-1 single-hop one.
 */
describe("resolveKtfmtGradleStyle — Gradle project scoping (#2468 review round 2)", () => {
	function makeSubprojectsFixture(prefix: string, styleCall: string): string {
		const root = newTmpDir(prefix);
		fs.writeFileSync(
			path.join(root, "settings.gradle.kts"),
			'rootProject.name = "demo"\ninclude(":app")\n',
		);
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0" apply false\n}\n\n' +
				"subprojects {\n" +
				'  apply(plugin = "com.ncorti.ktfmt.gradle")\n' +
				`  ktfmt {\n    ${styleCall}\n  }\n` +
				"}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  kotlin("jvm")\n}\n',
		);
		return root;
	}

	function writeKt(dir: string, ...segments: string[]): string {
		const filePath = path.join(dir, ...segments);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");
		return filePath;
	}

	it("B1: carries a root subprojects { ktfmt { googleStyle() } } into a module whose own build file declares no style", async () => {
		// The module's build.gradle.kts exists but declares no ktfmt block, so
		// the round-1 resolver stopped there and returned undefined — while
		// `hasKtfmtConfig` climbed to the root, matched `ktfmt`, and elected
		// ktfmt for this very file. #2468's defect (style detected, not
		// carried) survived in exactly the layout the plugin is used in.
		const root = makeSubprojectsFixture(
			"pi-lens-ktfmt-subprojects-",
			"googleStyle()",
		);
		const filePath = writeKt(root, "app", "src", "main", "kotlin", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--google-style");
	});

	it("B2: does NOT apply a subprojects-only style to a source file of the DECLARING (root) project", async () => {
		// Gradle's `subprojects { }` configures the children, never the
		// project it is written in. The round-1 resolver matched `ktfmt {`
		// anywhere in the root build file and handed --google-style to the
		// root's own sources — a NEW disagreement with ./gradlew ktfmtFormat
		// that the pre-#2468 bare invocation did not have.
		const root = makeSubprojectsFixture(
			"pi-lens-ktfmt-subprojects-root-",
			"googleStyle()",
		);
		const filePath = writeKt(root, "src", "main", "kotlin", "Root.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBeUndefined();
	});

	it("continues the climb past a module ktfmt { } block that declares only non-style settings", async () => {
		// The climb past a style-less nearer gradle directory is what B1 needs.
		// The DECLARING block here is `subprojects { }` — after review round 3
		// that is the only top-of-tree form (with `allprojects { }`) that
		// Gradle actually propagates down into a module, so it is the only one
		// that can keep this case green.
		const root = newTmpDir("pi-lens-ktfmt-inherit-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"subprojects {\n  ktfmt {\n    googleStyle()\n  }\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			"ktfmt {\n  maxWidth.set(100)\n}\n",
		);
		const filePath = writeKt(moduleDir, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--google-style");
	});

	it("P1: a root TOP-LEVEL ktfmt { } block does not reach a module that declares no ktfmt block at all", async () => {
		// Review round 3, F1. Round 2 shipped a documented HEURISTIC that
		// handed a top-level `ktfmt { }` style to every descendant declaring
		// no style of its own. Gradle does not do that: the ktfmt-gradle
		// plugin gives each project its OWN `KtfmtExtension` seeded with the
		// plugin conventions, so a module that applies the plugin and calls no
		// style function formats under ktfmt's DEFAULT — which is exactly the
		// bare invocation pi-lens made before #2468. The heuristic therefore
		// manufactured a NEW pi-lens/Gradle disagreement the pre-fix code did
		// not have: pi-lens writes `--google-style`, and `./gradlew ktfmtCheck`
		// then rejects the very file pi-lens just formatted.
		const root = newTmpDir("pi-lens-ktfmt-toplevel-noblock-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n\n' +
				"ktfmt {\n  googleStyle()\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle")\n}\n',
		);
		const filePath = writeKt(moduleDir, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBeUndefined();
	});

	it("P2: a root TOP-LEVEL ktfmt { } block does not reach a module whose own ktfmt { } declares only non-style settings", async () => {
		// The P1 shape with the module spelling its style-less configuration
		// out in its own `ktfmt { }` block instead of omitting it: same Gradle
		// semantics (the module's extension keeps the plugin conventions),
		// same required answer.
		const root = newTmpDir("pi-lens-ktfmt-toplevel-nonstyle-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			"ktfmt {\n  maxWidth.set(100)\n}\n",
		);
		const filePath = writeKt(moduleDir, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBeUndefined();
	});

	it("applies allprojects { ktfmt { } } to BOTH the declaring project and its modules", async () => {
		const root = newTmpDir("pi-lens-ktfmt-allprojects-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"allprojects {\n  ktfmt {\n    kotlinLangStyle()\n  }\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  kotlin("jvm")\n}\n',
		);
		const moduleFile = writeKt(moduleDir, "src", "Main.kt");
		const rootFile = writeKt(root, "src", "Root.kt");

		expect(await resolveKtfmtGradleStyle(moduleFile, path.dirname(root))).toBe(
			"--kotlinlang-style",
		);
		expect(await resolveKtfmtGradleStyle(rootFile, path.dirname(root))).toBe(
			"--kotlinlang-style",
		);
	});

	it("F3: a block calling both style functions resolves to the LAST call, as Gradle does", async () => {
		// `googleStyle()` and `kotlinLangStyle()` are plain setters on
		// KtfmtExtension (blockIndent/continuationIndent/
		// trailingCommaManagementStrategy `.set(...)`), verified against
		// cortinico/ktfmt-gradle @23bdedc8d5d641731a0cf128f1a386d5a127ce4e —
		// so the LAST call in the block body is the one whose values survive.
		// Round 1 returned the first recognized call instead.
		const root = newTmpDir("pi-lens-ktfmt-lastcall-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n  kotlinLangStyle()\n}\n",
		);
		const filePath = writeKt(root, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--kotlinlang-style");
	});
});

/**
 * Review round 3, F1/F2/S1. Round 2 decided a `ktfmt { }` block's reach with
 * one negative test — "is it inside `subprojects { }`?" — and gave DESCENDANT
 * scope to everything else. Two consequences, both proven below:
 *
 * - a top-level `ktfmt { }` leaked into modules (F1: P1/P2 above, and P3's
 *   order sensitivity here);
 * - `allprojects { }` was never actually read, so ANY unrecognized enclosing
 *   block — `configure(subprojects.filter { … }) { }`, `project(":app") { }`,
 *   `tasks.register(…) { }`, a convention-plugin wrapper — silently granted
 *   BOTH scopes (F2), which is B2's bug in three further spellings.
 *
 * The fix classifies each `ktfmt { }` by its ACTUAL brace nesting on the
 * stripped source: no enclosing block → the declaring project only;
 * `allprojects` → declaring project and descendants; `subprojects` →
 * descendants only; anything else → NEITHER, i.e. fall back to the bare
 * (`--meta-style`-equivalent) invocation pi-lens made before #2468.
 *
 * `homeDir` is pinned to the fixture root's parent in every case, as in the
 * round-2 block above.
 */
describe("resolveKtfmtGradleStyle — enclosing-block scope (#2468 review round 3)", () => {
	interface ScopeFixture {
		rootFile: string;
		moduleFile: string;
		homeDir: string;
	}

	/**
	 * A two-project build: `root` holds the build file under test, `app` is a
	 * module whose own build file applies the plugin and declares no style.
	 */
	function makeScopeFixture(prefix: string, rootBuild: string): ScopeFixture {
		const root = newTmpDir(prefix);
		fs.writeFileSync(
			path.join(root, "settings.gradle.kts"),
			'rootProject.name = "demo"\ninclude(":app")\n',
		);
		fs.writeFileSync(path.join(root, "build.gradle.kts"), rootBuild);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle")\n}\n',
		);
		const writeAt = (dir: string, name: string): string => {
			const filePath = path.join(dir, "src", "main", "kotlin", name);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "fun main() {}\n");
			return filePath;
		};
		return {
			rootFile: writeAt(root, "Root.kt"),
			moduleFile: writeAt(moduleDir, "Main.kt"),
			homeDir: path.dirname(root),
		};
	}

	const SUBPROJECTS_KOTLINLANG =
		"subprojects {\n" +
		'  apply(plugin = "com.ncorti.ktfmt.gradle")\n' +
		"  ktfmt {\n    kotlinLangStyle()\n  }\n" +
		"}\n";
	const TOP_LEVEL_GOOGLE = "ktfmt {\n  googleStyle()\n}\n";

	it("P3a: subprojects-then-top-level — the module gets the subprojects style, the root its own", async () => {
		// Round 2 assigned `descendants` from EVERY ktfmt block in source
		// order, so the trailing top-level `googleStyle()` overwrote the
		// module's `subprojects { kotlinLangStyle() }`: two blocks that reach
		// disjoint sets of projects were made to fight over one slot, and the
		// SOURCE ORDER of unrelated scopes decided which project got the wrong
		// flag.
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-order-sub-first-",
			`${SUBPROJECTS_KOTLINLANG}\n${TOP_LEVEL_GOOGLE}`,
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBe(
			"--kotlinlang-style",
		);
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBe(
			"--google-style",
		);
	});

	it("P3b: top-level-then-subprojects — the same answers, order-independently", async () => {
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-order-top-first-",
			`${TOP_LEVEL_GOOGLE}\n${SUBPROJECTS_KOTLINLANG}`,
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBe(
			"--kotlinlang-style",
		);
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBe(
			"--google-style",
		);
	});

	it("P4: configure(subprojects.filter { … }) { ktfmt { } } reaches neither project", async () => {
		// A real convention-plugin spelling. pi-lens cannot evaluate the
		// predicate, so it cannot know WHICH projects this configures — and a
		// scope it cannot compute must fall back to the bare invocation, not
		// be handed to every project. Round 2 gave it both scopes because the
		// `subprojects` token here is a receiver expression (`subprojects
		// .filter`), not a `subprojects { }` block, so the one negative test
		// it ran did not fire.
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-configure-filter-",
			'configure(subprojects.filter { it.name != "buildSrc" }) {\n' +
				"  ktfmt {\n    googleStyle()\n  }\n" +
				"}\n",
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBeUndefined();
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBeUndefined();
	});

	it('P5: project(":app") { ktfmt { } } reaches neither project by inheritance', async () => {
		// `project(":app") { }` configures exactly one named project. Resolving
		// the path back to that project is a settings.gradle `include(…)`
		// question pi-lens does not answer, so this is a fail-closed case too —
		// but round 2 gave it BOTH scopes, which is wrong for the root in the
		// same way B2 was.
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-project-block-",
			'project(":app") {\n  ktfmt {\n    googleStyle()\n  }\n}\n',
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBeUndefined();
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBeUndefined();
	});

	it("P6: tasks.register(…) { ktfmt { } } reaches neither project", async () => {
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-task-block-",
			'tasks.register("formatEverything") {\n' +
				"  ktfmt {\n    googleStyle()\n  }\n" +
				"}\n",
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBeUndefined();
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBeUndefined();
	});

	it("S1: an UNRECOGNIZED wrapper in allprojects' place reaches neither project", async () => {
		// The `allprojects { }` case above was decorative until this one
		// existed: round 2 never called `namedGradleBlockRanges(…,
		// "allprojects")`, so swapping `allprojects` for a name the resolver
		// has never heard of produced the identical (both-scopes) answer and
		// the allprojects assertion could not fail for the right reason. With
		// the enclosing-block classifier, this is the negative twin that makes
		// it load-bearing.
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-unknown-wrapper-",
			"zzUnknownWrapper {\n  ktfmt {\n    kotlinLangStyle()\n  }\n}\n",
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBeUndefined();
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBeUndefined();
	});

	it("S2: allprojects { subprojects { ktfmt { } } } — two RECOGNIZED enclosing blocks still reach neither project", async () => {
		// S1 proved an unrecognized wrapper fails closed; this is the negative
		// twin for two blocks the resolver DOES recognize individually.
		// `scopeOfKtfmtBlock` rejects any `ktfmt { }` with more than one
		// enclosing block outright (`enclosing.length > 1 → undefined`) before
		// ever consulting SCOPE_BY_ENCLOSING_BLOCK — composing `allprojects { }`
		// and `subprojects { }` is exactly the kind of build-script evaluation
		// this lexical pass cannot do, so it must fail closed here too, not
		// pick one of the two enclosing names and grant its scope. Deleting
		// that length check would let `enclosing[0]` (the outermost —
		// `allprojects`, "both") decide instead, wrongly handing --google-style
		// to the root's own sources (an `allprojects` never actually applies
		// to here) and to the module (via a `subprojects` nesting that
		// pi-lens cannot evaluate).
		const { rootFile, moduleFile, homeDir } = makeScopeFixture(
			"pi-lens-ktfmt-double-wrapper-",
			"allprojects {\n  subprojects {\n    ktfmt {\n      googleStyle()\n    }\n  }\n}\n",
		);

		expect(await resolveKtfmtGradleStyle(moduleFile, homeDir)).toBeUndefined();
		expect(await resolveKtfmtGradleStyle(rootFile, homeDir)).toBeUndefined();
	});
});
