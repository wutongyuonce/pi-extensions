/**
 * #3436: madge's `--warning` is inert under `--json`, so the turn-end lane's
 * "skipped local file" count was structurally always zero.
 *
 * madge 8.0.0's CLI gates the flag on `!program.json` (`bin/cli.js:195`), and
 * `buildMadgeArgs` always passes `--json`; even ungated, `lib/output.js` prints
 * the skip list to STDOUT, where it would corrupt the JSON. So
 * `parseMadgeSkips(result.stderr)` could only ever return `{ total: 0, local:
 * [] }` and `DepCheckResult.localSkips` was a discriminator nothing could
 * observe. This change deletes the flag, the parser and the field, and records
 * the lost visibility once per session/root instead.
 *
 * Recurrence these tests prevent: a skip/parse channel keyed on bytes the tool
 * never writes, and a second "possible silent cycle-miss" claim that cannot
 * fire. The real tool behaviour is pinned from a captured fixture
 * (`tests/fixtures/madge-scan/skip-warning-inert.captured.json`), not from the
 * comment the code used to carry.
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

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

describe("madge --warning is not a usable skip channel under --json (#3436)", () => {
	let tmp: string;

	beforeEach(async () => {
		vi.resetAllMocks();
		const { resetDegradationLedger } =
			await import("../../clients/degradation-ledger.js");
		resetDegradationLedger();
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pilens-madge-warn-")),
		);
		findNodeToolBinary.mockResolvedValue("madge");
		ensureTool.mockResolvedValue(undefined);
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	function writeWorkspace(): string {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(
			file,
			'import { b } from "./b.js";\nexport const a = 1;\n',
		);
		fs.writeFileSync(path.join(tmp, "b.ts"), "export const b = 1;\n");
		fs.writeFileSync(
			path.join(tmp, "tsconfig.json"),
			'{ "compilerOptions": { "module": "nodenext", "target": "es2022" } }\n',
		);
		return file;
	}

	/** Answer the version probe, then replay a no-cycle madge run. */
	function replayNoCycles(stderr = ""): void {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return { status: 0, error: null, stdout: "[]", stderr };
		});
	}

	it("does not ask madge for --warning (the flag is inert under --json)", async () => {
		const { buildMadgeArgs } =
			await import("../../clients/dependency-checker.js");
		const args = buildMadgeArgs(tmp, tmp);
		expect(args).not.toContain("--warning");
		// The flag it was inert under stays: the reader parses JSON.
		expect(args).toContain("--json");
		expect(args[args.length - 1]).toBe(tmp);
	});

	it("no longer exposes a per-result localSkips count", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const file = writeWorkspace();
		replayNoCycles();

		const { results } = await new DependencyChecker().checkFilesBatch(
			[file],
			tmp,
		);

		const result = results.get(file) as object;
		expect(result).toBeDefined();
		// Pre-fix the miss result always carried `localSkips: 0`; the field is
		// gone with the parser that could only produce zeros.
		expect("localSkips" in result).toBe(false);
	});

	it("records the unavailable skip visibility from the whole-project scan lane", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const { getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");
		writeWorkspace();
		replayNoCycles();

		// The session-start `scanProject` lane shares the argv blind spot with
		// the turn-end lane (#3441 F1): pre-fix it recorded nothing, so a hidden
		// local file was read as a clean graph on the lane whose output becomes
		// the user-facing `circular` diagnostics.
		await new DependencyChecker().scanProject(tmp);

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "madge-skip-visibility-unavailable",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		const latest = group?.latestReasons.at(-1);
		expect(latest?.subject).toBe(tmp);
		expect(latest?.reason).toContain("--json");
		expect(latest?.reason).toContain("--warning");
	});

	it("records the unavailable skip visibility once per session/root", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const { getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");
		const file = writeWorkspace();
		replayNoCycles();

		// Two scans on the SAME root through different lanes, both funnelling
		// through `parseMadgeCycles`. The once-wrapper keys on (kind, root), so
		// the second scan must not add a record; swapping it for the unbounded
		// `recordDegradation` would make this count 2 (#3441 F3).
		const checker = new DependencyChecker();
		await checker.checkFilesBatch([file], tmp);
		await checker.scanProject(tmp);

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "madge-skip-visibility-unavailable",
		);
		expect(group?.count).toBe(1);
		const latest = group?.latestReasons.at(-1);
		expect(latest?.subject).toBe(tmp);
		// The reason names the discriminator a reader acts on.
		expect(latest?.reason).toContain("--json");
		expect(latest?.reason).toContain("--warning");
	});

	it("pins the captured tool behaviour: --warning --json leaves stderr empty", () => {
		const capture: MadgeCapture = JSON.parse(
			fs.readFileSync(
				path.join(FIXTURE_DIR, "skip-warning-inert.captured.json"),
				"utf8",
			),
		);
		// The workspace behind the capture has an unresolvable LOCAL import, so a
		// usable warning channel would have written something. It wrote nothing:
		// stderr is empty and the JSON is a clean cycle array.
		expect(capture.stdout).toBe("[]\n");
		expect(capture.stderr).toBe("");
		expect(JSON.parse(capture.stdout)).toEqual([]);
		// The captured argv is the PRE-fix one — kept as the evidence that the
		// flag was inert, not as the current argv.
		expect(capture.provenance.argv).toContain("--warning");
	});
});
