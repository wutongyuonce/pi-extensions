/**
 * #3190 witness (ADR 0007) — the deleted-path retraction through the pi HOST
 * entry, with the REAL producer.
 *
 * Round 1 review (M3357-1): the other witnesses in this tree double
 * `clients/pipeline.js`, which is the very producer #3190 changes, so none of
 * them can see this fix. This one keeps `index.ts`'s registered
 * `session_start` / `turn_start` / `tool_result` / `turn_end` / `context`
 * handlers, the real `handleToolResult`, the real `runPipeline`, the real
 * dispatcher and helm-lint runner, the real `RuntimeCoordinator`, the real
 * `CacheManager` and the real `handleTurnEnd`, and replaces only
 * `clients/safe-spawn.js` — the true PROCESS boundary — with deterministic
 * tool output. A mocked process boundary is an EXEMPTION (no real spawn is
 * admitted), not a `flake-shape-ratchet` admission: nothing here spawns, waits
 * on a wall clock, or touches the network.
 *
 * Why helm-lint is the runner under the mock: it is one of the runners whose
 * findings are POOLED across files (`clients/pipeline.ts`'s `inlineBlockerLines`
 * comment names helm-lint / helm-render alongside javac / dotnet-build), so it
 * can report a blocker against a chart sibling of the edited file. That is the
 * shape #1245's read-time reconcile cannot see and the shape this PR fixes.
 * Its spawn contract is the one pinned in
 * `tests/clients/dispatch/runners/helm-lint.test.ts` (`[LEVEL] <file>[:line]:
 * message` lines, non-zero exit when a chart fails).
 *
 * Two cells in ONE golden (`turn-end-delivery.txt`), in this order:
 *
 *   - cell 1 — `values.yaml` is deleted; its blocker must be retracted from
 *     the tool result AND from the turn-end delivery, while the blocker on the
 *     edited template is served on both. This is the cell the fix changes.
 *   - cell 2 — a second chart with every cited file present: both blockers are
 *     served on both surfaces. This is the byte-identity cell — its text is
 *     what `origin/master` produces too, proven by re-running this file with
 *     the pre-fix `clients/pipeline.ts` restored.
 *
 * Every host-dependent spelling is scrubbed (the project root, the pinned
 * `PI_LENS_HOME` and its `~`-folded form, millisecond timings), and the suite
 * is proven to match with `HOME` moved.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticLogger } from "../clients/diagnostic-logger.js";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";

/**
 * The router lives in the hoisted block, NOT inside the `vi.mock` factory:
 * `tests/config/vi-mock-export-sweep.test.ts` reads a factory's export list off
 * the first `return` statement it finds, so a factory that returns anything but
 * its one spread object literal is read as dropping every production export
 * (measured: it reported this file as exporting `["status","stderr","stdout"]`).
 * Same rule the `read-guard` double in `tests/index-integration.test.ts`
 * follows with class fields.
 */
const spawnRouter = vi.hoisted(() => {
	/** Every command this witness's chain tried to run, in order. */
	const calls: Array<{ command: string; args: string[] }> = [];
	/** Set per cell: the `helm lint` stdout that cell's chart produces. */
	const state = { helmLintStdout: "" };
	const isHelm = (command: string): boolean =>
		/(^|[\\/])helm(\.exe)?$/i.test(command);
	function run(
		command: string,
		args: readonly string[] = [],
	): {
		stdout: string;
		stderr: string;
		status: number;
		failure?: "spawn";
		spawnFailure?: { kind: "tool-not-found" };
	} {
		calls.push({ command, args: [...args] });
		// Every binary except helm is simply not on this host, which is how the
		// runners that do not matter here skip without inventing failures the
		// golden would then have to carry.
		if (!isHelm(command))
			return {
				stdout: "",
				stderr: "command not found",
				status: 127,
				failure: "spawn",
				spawnFailure: { kind: "tool-not-found" },
			};
		if (args[0] === "lint")
			return {
				stdout: state.helmLintStdout,
				stderr: "Error: 1 chart(s) linted, 1 chart(s) failed",
				status: 1,
			};
		return {
			stdout: 'version.BuildInfo{Version:"v3.16.2"}',
			stderr: "",
			status: 0,
		};
	}
	return { calls, state, isHelm, run };
});

/** The ONE double: the process boundary. */
vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: spawnRouter.run,
	safeSpawnAsync: async (command: string, args: readonly string[] = []) =>
		spawnRouter.run(command, args),
	isCommandAvailable: spawnRouter.isHelm,
	isCommandAvailableAsync: async (command: string) =>
		spawnRouter.isHelm(command),
	findCommand: (command: string) =>
		spawnRouter.isHelm(command) ? "helm" : null,
	findCommandAsync: async (command: string) =>
		spawnRouter.isHelm(command) ? "helm" : null,
}));

import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const GOLDEN_DIR = path.join(
	import.meta.dirname,
	"fixtures/witness/inline-blocker-deleted-path",
);

let tmpDir: string;
const originalTestMode = process.env.PI_LENS_TEST_MODE;

function diagnosticLogPath(): string {
	const date = new Date().toISOString().split("T")[0];
	return path.join(getGlobalPiLensLogDir(), "logs", `${date}.jsonl`);
}

async function readNewDiagnosticRows(
	offset: number,
): Promise<Array<Record<string, unknown>>> {
	await getDiagnosticLogger().flush();
	const file = diagnosticLogPath();
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.slice(offset)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	process.env.PI_LENS_TEST_MODE = "0";
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3190-witness-")),
	);
	spawnRouter.calls.length = 0;
	spawnRouter.state.helmLintStdout = "";
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
});

/**
 * A minimal chart in its OWN directory, so the two cells never share a chart
 * root, an inline-blocker record or a turn-state entry.
 */
function createChart(name: string): {
	chartRoot: string;
	template: string;
	values: string;
} {
	const chartRoot = path.join(tmpDir, "charts", name);
	fs.mkdirSync(path.join(chartRoot, "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(chartRoot, "Chart.yaml"),
		"apiVersion: v2\nname: witness\nversion: 0.1.0\n",
	);
	const values = path.join(chartRoot, "values.yaml");
	fs.writeFileSync(values, "replicas: 2\n");
	const template = path.join(chartRoot, "templates", "deployment.yaml");
	fs.writeFileSync(
		template,
		"apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: {{ .Values.replicas }}\n",
	);
	return { chartRoot, template, values };
}

/**
 * `helm lint`'s own output shape (the contract pinned by
 * `tests/clients/dispatch/runners/helm-lint.test.ts`): one `[LEVEL] <path>:
 * <message>` line per finding, paths relative to the chart root.
 */
const HELM_LINT_OUTPUT = [
	"==> Linting .",
	"[ERROR] values.yaml:1: replicas must be an integer, got string",
	"[ERROR] templates/deployment.yaml:4: nil pointer evaluating interface {}.image",
].join("\n");

function scrub(text: string): string {
	const probeHome = path.resolve(process.env.PI_LENS_HOME ?? "");
	const home = os.homedir();
	const relativeHome = path.relative(home, probeHome);
	// `displayProjectDataPath` folds `$HOME` to `~` when the store is not under
	// cwd, so the same directory can reach the agent under two spellings and
	// both are scrubbed (#3290's golden lost a round to exactly that). The
	// fallback is a string no delivered text can contain.
	const tildeHome =
		relativeHome &&
		!relativeHome.startsWith("..") &&
		!path.isAbsolute(relativeHome)
			? `~/${relativeHome.split(path.sep).join("/")}`
			: "<never-matches-any-delivered-text>";
	return (
		text
			.replaceAll(tmpDir, "<PROJECT>")
			.replaceAll(probeHome, "<PROBE_HOME>")
			.replaceAll(tildeHome, "<PROBE_HOME>")
			.replaceAll(home, "<HOME>")
			.replaceAll("\\", "/")
			// Every duration the pipeline prints (`✓ … · 12ms`).
			.replace(/·\s*\d+ms/g, "· <MS>ms")
			.trimEnd()
	);
}

/** Drive one turn through the REAL registered host handlers. */
async function witnessTurn(
	name: string,
	deleteValues: boolean,
): Promise<{
	chartRoot: string;
	toolResult: string;
	turnEnd: string;
	diagnosticRows: Array<Record<string, unknown>>;
}> {
	const { chartRoot, template, values } = createChart(name);
	const logFile = diagnosticLogPath();
	const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
	spawnRouter.state.helmLintStdout = HELM_LINT_OUTPUT;
	if (deleteValues) fs.rmSync(values);

	const pi = createPiMock({ "no-lsp": true });
	extension(pi.asExtensionAPI());
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: "pi-lens-3190-witness" }),
	);
	await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
	const returned = (await pi.emit(
		"tool_result",
		{
			toolName: "edit",
			input: { path: template },
			details: { diff: "+  4   replicas: {{ .Values.replicas }}" },
			content: [{ type: "text", text: "base" }],
		},
		makeCtx({ cwd: tmpDir }),
	)) as { content?: Array<{ text?: string }> } | undefined;
	await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
	const injected = (await pi.emit(
		"context",
		{ messages: [{ role: "user", content: "keep working" }] },
		makeCtx({ cwd: tmpDir }),
	)) as { messages?: Array<{ content: string }> } | undefined;

	return {
		chartRoot,
		toolResult:
			scrub(
				(returned?.content ?? [])
					.map((part) => part.text ?? "")
					.join("\n")
					.trim(),
			) || "(nothing delivered)",
		turnEnd:
			scrub((injected?.messages ?? []).map((m) => m.content).join("\n\n")) ||
			"(nothing injected)",
		diagnosticRows: await readNewDiagnosticRows(logOffset),
	};
}

function assertGolden(name: string, actual: string): void {
	const golden = path.join(GOLDEN_DIR, name);
	if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
		fs.mkdirSync(GOLDEN_DIR, { recursive: true });
		fs.writeFileSync(golden, `${actual}\n`);
	}
	expect(`${actual}\n`).toBe(fs.readFileSync(golden, "utf-8"));
}

describe("#3190 witness: a retracted deleted-path blocker through pi", () => {
	it("matches the golden across the retracted and unretracted cells", async () => {
		// Both cells in ONE case, in this order, so the golden records one
		// deterministic process history: `index.ts`'s module graph is a process
		// singleton (the session banner below is once-per-process), and two
		// separate cases would make each golden depend on whether its sibling
		// ran first.
		const retracted = await witnessTurn("retracted", true);
		const intact = await witnessTurn("intact", false);

		const retractedRows = retracted.diagnosticRows.filter(
			(row) =>
				typeof row.filePath === "string" &&
				row.filePath.includes("charts/retracted"),
		);
		expect(retractedRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: expect.stringContaining("values.yaml"),
					shownInline: false,
					shownToAgent: false,
				}),
				expect.objectContaining({
					filePath: expect.stringContaining("deployment.yaml"),
					shownInline: true,
					shownToAgent: true,
				}),
			]),
		);

		// The real helm-lint runner really ran, once per cell, through the mocked
		// process boundary — without this the golden could record silence from a
		// chain that never dispatched anything.
		//
		// Review round 2 (M3357-2): counting the calls was not enough. The
		// reviewer mutated the real runner from `["lint", chartRoot]` to
		// `["lint", cwd]` and this case stayed green, so a dispatch aimed at the
		// wrong chart could ride behind the golden. Equality on the WHOLE
		// recorded call — the resolved helm command, the subcommand and the exact
		// chart root — in dispatch order, so linting the workspace root, the
		// other cell's chart, or the two charts in the wrong order all red.
		expect(spawnRouter.calls.filter((call) => call.args[0] === "lint")).toEqual(
			[
				{ command: "helm", args: ["lint", retracted.chartRoot] },
				{ command: "helm", args: ["lint", intact.chartRoot] },
			],
		);

		assertGolden(
			"turn-end-delivery.txt",
			[
				"=== cell 1: helm lint reported two blockers; values.yaml was deleted this turn ===",
				"--- tool_result delivered to the agent ---",
				retracted.toolResult,
				"--- turn_end context message ---",
				retracted.turnEnd,
				"",
				"=== cell 2: the same two blockers; every cited file exists ===",
				"--- tool_result delivered to the agent ---",
				intact.toolResult,
				"--- turn_end context message ---",
				intact.turnEnd,
			].join("\n"),
		);
	});
});
