/**
 * #3435: a single-file madge target's cycle members are resolved against the
 * project root instead of the analysed file's directory.
 *
 * `runMadgeSpawn` is the turn-end lane (`checkFilesBatch`, reached from
 * `clients/runtime-turn.ts`) and points madge at ONE file. madge prints cycle
 * members relative to its TARGET, so a nested file `src/a.ts` comes back as
 * `a.ts`/`b.ts`; resolving those against `projectRoot` yields `<root>/a.ts`, a
 * path that does not exist. The shared `circularFiles` set is then keyed by
 * nonexistent paths, so `isInCircular` / `getCircularForFile` answer false for
 * the real nested files.
 *
 * Recurrence these tests prevent: the base for madge's relative members
 * drifting from the target the client actually spawned. The whole-project scan
 * (#3428) passes `projectRoot` because its target IS the root; this lane must
 * pass `path.dirname(target)`. Both go through one `parseMadgeCycles` reader,
 * so a future divergence has to red here.
 *
 * The bytes are not invented: each case replays a fixture captured from madge
 * 8.0.0 driven with `buildMadgeArgs`'s own argv, and asserts the client still
 * spawns that argv. See `tests/fixtures/madge-scan/`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn,
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	// No managed install and no installer work: this suite is about the PARSE
	// base, and resolution is pinned by dependency-checker-madge-resolution.test.ts.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => path.join(os.tmpdir(), "pilens-fake-home", "tools"),
	isSpawnableCommand: vi.fn(async () => true),
}));

const FIXTURE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/madge-scan",
);

interface MadgeCapture {
	provenance: { version: string; argv: string[] };
	exitCode: number;
	stdout: string;
	stderr: string;
}

function loadCapture(caseName: string): MadgeCapture {
	return JSON.parse(
		fs.readFileSync(
			path.join(FIXTURE_DIR, `${caseName}.captured.json`),
			"utf8",
		),
	);
}

/** The captured argv with the recorded workspace token bound to `root`. */
function recordedArgv(capture: MadgeCapture, root: string): string[] {
	return capture.provenance.argv.map((token) =>
		token.split("__WORKSPACE__").join(root),
	);
}

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

describe("DependencyChecker single-file madge target (#3435)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pilens-madge-single-")),
		);
		findNodeToolBinary.mockResolvedValue("madge");
		ensureTool.mockResolvedValue(undefined);
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	/** The same workspace the #3428 captures use: a top-level entry file plus a
	 * nested two-file cycle and one orphan. */
	function writeSameDirWorkspace(): void {
		fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "index.ts"),
			'import { a } from "./src/a.js";\nexport const entry = a;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "a.ts"),
			'import { b } from "./b.js";\nexport const a = () => b();\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "b.ts"),
			'import { a } from "./a.js";\nexport const b = () => a;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "orphan.ts"),
			"export const orphan = 1;\n",
		);
		fs.writeFileSync(
			path.join(tmp, "tsconfig.json"),
			'{ "compilerOptions": { "module": "nodenext", "target": "es2022" } }\n',
		);
	}

	/** A cycle that leaves the target's directory, so madge emits a `../` member. */
	function writeCrossDirWorkspace(): void {
		fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
		fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "src", "a.ts"),
			'import { b } from "../lib/b.js";\nexport const a = () => b;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "lib", "b.ts"),
			'import { a } from "../src/a.js";\nexport const b = () => a;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "tsconfig.json"),
			'{ "compilerOptions": { "module": "nodenext", "target": "es2022" } }\n',
		);
	}

	/** Answer the version probe, then replay the captured single-file bytes. */
	function replay(capture: MadgeCapture): void {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return {
				status: capture.exitCode,
				error: null,
				stdout: capture.stdout,
				stderr: capture.stderr,
			};
		});
	}

	/** The single-file madge spawn's argv, excluding `ensureAvailable`'s probe. */
	function madgeArgv(): string[] {
		const call = safeSpawnAsync.mock.calls.find((c) =>
			(c[1] as string[]).includes("--circular"),
		);
		return (call?.[1] ?? []) as string[];
	}

	it("resolves a nested file's members to the sibling files that exist", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeSameDirWorkspace();
		const capture = loadCapture("single-file-target");
		// madge exits 1 precisely BECAUSE it found a cycle (bin/cli.js:266-267),
		// so the findings have to survive a nonzero exit.
		expect(capture.exitCode).toBe(1);
		replay(capture);
		const target = path.join(tmp, "src", "a.ts");

		const checker = new DependencyChecker();
		const { results } = await checker.checkFilesBatch([target], tmp);

		// The captured bytes are evidence about THIS client only while it still
		// asks madge for them the same way.
		expect(madgeArgv()).toEqual(recordedArgv(capture, tmp));

		const a = path.join(tmp, "src", "a.ts");
		const b = path.join(tmp, "src", "b.ts");
		const bogus = path.join(tmp, "a.ts");

		const result = results.get(target);
		expect(result?.checked).toBe(true);
		// madge printed `a.ts`/`b.ts` relative to the TARGET's directory (`src/`).
		expect(result?.circular).toEqual([{ file: a, path: [a, b] }]);

		// The shared state the batch publishes: the real nested paths, not the
		// pre-fix `<root>/a.ts`, which does not exist.
		expect(checker.isInCircular(a)).toBe(true);
		expect(checker.isInCircular(b)).toBe(true);
		expect(checker.isInCircular(bogus)).toBe(false);

		// `getCircularForFile` reads the same set; map its cwd-relative output
		// back to absolutes so the assertion does not depend on the test cwd.
		expect(
			checker
				.getCircularForFile(a)
				.map((dep) => path.resolve(process.cwd(), dep)),
		).toEqual([b]);
	});

	it("resolves a `../` member relative to the target's directory, not the target path", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCrossDirWorkspace();
		const capture = loadCapture("single-file-cross-dir");
		replay(capture);
		const target = path.join(tmp, "src", "a.ts");

		const checker = new DependencyChecker();
		const { results } = await checker.checkFilesBatch([target], tmp);

		expect(madgeArgv()).toEqual(recordedArgv(capture, tmp));

		const a = path.join(tmp, "src", "a.ts");
		const b = path.join(tmp, "lib", "b.ts");
		// Resolving `../lib/b.ts` against the FILE path (`<root>/src/a.ts`)
		// lands at `<root>/src/lib/b.ts`; only dirname(`<root>/src`) reaches the
		// real `<root>/lib/b.ts`.
		expect(results.get(target)?.circular).toEqual([{ file: b, path: [b, a] }]);
		expect(checker.isInCircular(a)).toBe(true);
		expect(checker.isInCircular(b)).toBe(true);
		expect(checker.isInCircular(path.join(tmp, "src", "lib", "b.ts"))).toBe(
			false,
		);
	});
});
