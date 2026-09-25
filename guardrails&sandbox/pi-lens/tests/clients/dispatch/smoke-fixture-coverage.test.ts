/**
 * Smoke-fixture coverage drift guard (#209 requirement 4, #1937).
 *
 * `dispatch-coverage` proves every runner is wired into a PLAN. This proves
 * every runner's TOOL OUTPUT is covered by evidence, in one of three ways:
 *
 *   1. a live tool-smoke fixture (`scripts/smoke-tools.mjs`) — the nightly lane
 *      spawns the real binary against a planted violation;
 *   2. a captured real-bytes fixture (`tests/fixtures/runner-output/`) — the
 *      binary's actual stdout/stderr/exit code, replayed through the parser by
 *      `runners/captured-real-output.test.ts`;
 *   3. an explicit exemption below, which must name a CATEGORY explaining why
 *      real output is unreachable.
 *
 * #1937 rewrote the exemption rules. The map used to accept free text, and
 * "no fixture yet" sat in it for nine runners. A standing exemption turns
 * "forces a decision" into "permanently undecided", and that is how the vale
 * parser (#1933) shipped reading `Data.Files` — a shape vale has never emitted.
 * Every exemption now carries one of a closed set of categories, each of which
 * says something true about the world rather than about the backlog. Only
 * `pending` defers, and it must name the issue that closes it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import {
	FIXTURES,
	passFloorBreach,
	tier1Fixtures,
} from "../../../scripts/smoke-tools.mjs";
import {
	CAPTURED_OUTPUT_DIR,
	listCapturedOutputs,
	provenanceProblems,
} from "../../helpers/captured-runner-output.js";

const repoRoot = path.resolve(CAPTURED_OUTPUT_DIR, "../../..");

/**
 * Why a runner has no real tool output on file. The category is the load-bearing
 * part: it states a fact about the tool, not a position in a queue.
 */
const EXEMPTION_CATEGORIES = {
	/** In-process analysis. There is no external binary whose bytes to capture. */
	structural: "structural",
	/**
	 * A per-language alternate whose primary is covered. The detail must START
	 * with the covering runner's id, and that runner must itself be covered —
	 * otherwise the two exempt each other.
	 */
	alternate: "alternate",
	/** Exercised through the LSP lane rather than the dispatch CLI path. */
	lsp: "lsp",
	/** Needs a language toolchain or build artifact absent from dev and CI. */
	toolchain: "toolchain",
	/** No binary exists for any platform pi-lens develops or tests on. */
	platform: "platform",
	/** Flag-gated off by default; running it has side effects. */
	"opt-in": "opt-in",
	/**
	 * The only category that expires. The detail must reference the issue or PR
	 * that removes it, so the deferral has an owner and an end.
	 */
	pending: "pending",
} as const;

/**
 * Runners with neither a live tool-smoke fixture nor captured real bytes.
 * Format: `"<category>: <detail>"`.
 */
const EXEMPT = new Map<string, string>([
	[
		"tree-sitter",
		"structural: in-process grammar queries on every dispatch; no external process emits bytes to parse",
	],
	[
		"fact-rules",
		"structural: in-process fact evaluation on every dispatch; no external process emits bytes to parse",
	],
	[
		"ast-grep-napi",
		"structural: in-process napi engine; real-engine coverage via ast-grep-rule-tests plus the sonar and utils-block suites",
	],
	[
		"credo",
		"alternate: elixir-check is the Elixir primary; credo is the config-gated alternate",
	],
	[
		"detekt",
		"alternate: ktlint is the Kotlin primary; detekt needs the detekt CLI plus its formatting plugin, which is not a single-binary install",
	],
	[
		"golangci-lint",
		"alternate: go-vet is the Go lint primary; golangci-lint is config-first and exercised by the --autofix lane",
	],
	[
		"prisma-validate",
		"lsp: covered through the --lsp prisma fixture; the runner shells out to the same @prisma/language-server package",
	],
	[
		"spotbugs",
		"toolchain: analyses compiled JVM bytecode, so it needs a JDK plus a built artifact, and it is flag-gated behind withSpotbugsGroup",
	],
	[
		"cpp-check",
		"toolchain: shells out to the platform C/C++ compiler (cl, gcc, or clang); output shape is compiler-specific and no compiler is guaranteed in dev or CI",
	],
	// swiftlint and fish-indent are NOT `platform` exemptions: swift.org ships
	// a Windows toolchain and fish is apt-installable on the CI image. The
	// operative fact is that neither is on the image today, which is
	// `toolchain`. swiftlint additionally carries an inline literal in
	// exit-blind-runners.test.ts, and `toolchain` is not an escape from that
	// rule, so it is filed as `pending` against the issue that captures it.
	[
		"swiftlint",
		"pending: #1937 captures it on a CI image carrying the Swift toolchain; ubuntu-latest ships neither swift nor swiftlint today",
	],
	[
		"fish-indent",
		"toolchain: ships inside the fish shell, which is apt-installable but absent from the CI image and unavailable on the Windows dev host",
	],
	[
		"trivy-config",
		"opt-in: trivy.enabled is off by default; a capture would need trivy plus an opt-in fixture",
	],
	[
		"helm-render",
		"opt-in: helm.renderValidation.enabled is off by default because rendering executes chart templates",
	],
]);

function liveFixtureRunnerIds(): Set<string> {
	const ids = new Set<string>();
	for (const fx of FIXTURES) {
		for (const target of fx.targets ?? []) ids.add(target);
	}
	return ids;
}

function capturedFixtureRunnerIds(): Set<string> {
	return new Set(listCapturedOutputs().map((f) => f.provenance?.runner));
}

function registeredRunnerIds(): string[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list().map((r) => r.id);
}

/** Runner ids backed by real tool output, live or captured. */
function coveredRunnerIds(): Set<string> {
	return new Set([...liveFixtureRunnerIds(), ...capturedFixtureRunnerIds()]);
}

/** Split `"<category>: <detail>"`; null when the reason is not in that form. */
function parseExemptionReason(
	reason: string,
): { category: string; detail: string } | null {
	const match = reason.match(/^([a-z-]+):\s*(.+)$/);
	if (!match) return null;
	return { category: match[1], detail: match[2].trim() };
}

/**
 * Everything wrong with a set of exemptions, as human-readable strings.
 *
 * Taken as a parameter rather than closing over `EXEMPT` so the rules can be
 * exercised against a synthetic map. Without that, a rule with no matching
 * entry in the real map — `pending` has none most of the time — is a loop over
 * an empty set that passes no matter what it says (#1937 round 2). The tests
 * below run this same function on both.
 */
function exemptionProblems(
	exempt: Iterable<[string, string]>,
	covered: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const [id, reason] of exempt) {
		const parsed = parseExemptionReason(reason);
		if (!parsed) {
			problems.push(
				`${id}: reason is not "<category>: <detail>" — got "${reason}"`,
			);
			continue;
		}
		if (!(parsed.category in EXEMPTION_CATEGORIES)) {
			problems.push(
				`${id}: unknown category "${parsed.category}" (allowed: ${Object.keys(EXEMPTION_CATEGORIES).join(", ")})`,
			);
		}
		if (parsed.detail.length < 20) {
			problems.push(
				`${id}: detail "${parsed.detail}" is too short to explain why real output is unreachable`,
			);
		}
		// `alternate` is the easiest category to abuse: two uncovered runners
		// can name each other and neither ever meets a binary.
		if (parsed.category === "alternate") {
			const primary = parsed.detail.split(/[\s,;]/)[0];
			if (!covered.has(primary)) {
				problems.push(
					`${id}: names "${primary}" as its primary, but that runner has no live or captured fixture either`,
				);
			}
		}
		// `pending` is the only category that expires, so it must name the
		// issue or PR that removes it.
		if (parsed.category === "pending" && !/#\d+/.test(parsed.detail)) {
			problems.push(
				`${id}: a pending exemption must reference the issue or PR that removes it — got "${parsed.detail}"`,
			);
		}
	}
	return problems;
}

describe("smoke-fixture coverage", () => {
	it("every registered runner has real tool output or an explicit exemption", () => {
		const covered = coveredRunnerIds();
		const uncovered = registeredRunnerIds().filter(
			(id) => !covered.has(id) && !EXEMPT.has(id),
		);
		expect(
			uncovered,
			`registered runner(s) with no live tool-smoke fixture, no captured real-bytes fixture, and no exemption. Add a fixture in scripts/smoke-tools.mjs, capture bytes with scripts/capture-runner-output.mjs, or exempt with a category: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("no stale exemptions (every exempted id is still a registered runner)", () => {
		const registered = new Set(registeredRunnerIds());
		const stale = [...EXEMPT.keys()].filter((id) => !registered.has(id));
		expect(
			stale,
			`exemption(s) for non-existent runner(s): ${stale.join(", ")}`,
		).toEqual([]);
	});

	// A runner that gained coverage must LOSE its exemption. Otherwise the map
	// keeps growing and stops describing anything; #209's `lsp` and `pyright`
	// entries had both outlived their reasons by the time #1937 looked.
	it("no exemption for a runner that already has real tool output", () => {
		const covered = coveredRunnerIds();
		const redundant = [...EXEMPT.keys()].filter((id) => covered.has(id));
		expect(
			redundant,
			`runner(s) exempted despite having a live or captured fixture — delete the exemption: ${redundant.join(", ")}`,
		).toEqual([]);
	});

	it("every exemption is well formed under the shared rules", () => {
		const problems = exemptionProblems(EXEMPT, coveredRunnerIds());
		expect(problems, `malformed exemption(s): ${problems.join(" | ")}`).toEqual(
			[],
		);
	});

	// The rules above are only as good as their coverage of cases the real map
	// does not currently contain. Run the SAME function over a synthetic map so
	// each rule is proven to fire, rather than proven to loop over nothing.
	it("the shared rules reject every malformed shape", () => {
		const covered = new Set(["oxlint"]);
		const reject = (id: string, reason: string, expected: RegExp) => {
			const problems = exemptionProblems([[id, reason]], covered);
			expect(problems, `expected "${reason}" to be rejected`).toHaveLength(1);
			expect(problems[0]).toMatch(expected);
		};

		reject("a", "no fixture yet", /not "<category>: <detail>"/);
		reject(
			"b",
			"someday: we will get to this eventually, honestly",
			/unknown category "someday"/,
		);
		reject("c", "platform: too short", /too short/);
		reject(
			"d",
			"alternate: detekt is the primary here and covers this language",
			/names "detekt" as its primary/,
		);
		reject(
			"e",
			"pending: someone will get around to capturing this one",
			/must reference the issue or PR/,
		);

		// The well-formed shapes must pass, so the rules are not simply
		// rejecting everything.
		expect(
			exemptionProblems(
				[
					["f", "alternate: oxlint is the JS/TS lint primary for this kind"],
					[
						"g",
						"pending: #1937 captures it once the toolchain is on the image",
					],
				],
				covered,
			),
		).toEqual([]);
	});
});

describe("captured real-bytes fixture provenance", () => {
	const captured = listCapturedOutputs();

	it("there is at least one captured fixture", () => {
		expect(
			captured.length,
			`${CAPTURED_OUTPUT_DIR} is empty — the provenance assertions below would pass vacuously`,
		).toBeGreaterThan(0);
	});

	// A fixture whose bytes nobody can trace is a hand-written fixture one step
	// removed: you cannot tell whether it came from a binary or from a guess.
	it("every captured fixture carries a complete provenance header", () => {
		const problems = captured.flatMap(provenanceProblems);
		expect(
			problems,
			`captured fixture(s) with an incomplete provenance header. Re-capture with scripts/capture-runner-output.mjs rather than editing the header by hand:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	it("every captured fixture belongs to a registered runner", () => {
		const registered = new Set(registeredRunnerIds());
		const orphans = captured
			.filter((f) => !registered.has(f.provenance?.runner))
			.map((f) => `${f.relPath} (runner "${f.provenance?.runner}")`);
		expect(
			orphans,
			`captured fixture(s) for a runner that is no longer registered: ${orphans.join(", ")}`,
		).toEqual([]);
	});

	// The recorded workspace is the re-capture recipe. If it is gone, the
	// fixture can be replayed but never refreshed against a newer tool version.
	it("every captured fixture's recorded workspace still exists", () => {
		const missing = captured
			.filter(
				(f) =>
					!f.provenance?.workspace ||
					!fs.existsSync(path.join(repoRoot, f.provenance.workspace)),
			)
			.map((f) => `${f.relPath} → ${f.provenance?.workspace}`);
		expect(
			missing,
			`captured fixture(s) whose recorded workspace is missing: ${missing.join(", ")}`,
		).toEqual([]);
	});

	// #1933's vale bug survived its first review round because
	// exit-blind-runners.test.ts carried a HAND-WRITTEN vale fixture in the same
	// wrong envelope shape as the parser. Test and code shared one wrong
	// assumption, so the test proved nothing.
	//
	// The rule: a runner whose tool output is asserted from an inline literal in
	// that file must also have captured real bytes, so the literal has something
	// to be wrong against. Exemption categories `platform` and `pending` are the
	// only escapes — a binary that cannot run here, or one another PR owns.
	it("every runner with an inline tool-output literal also has captured bytes", () => {
		const source = fs.readFileSync(
			path.join(
				repoRoot,
				"tests/clients/dispatch/runners/exit-blind-runners.test.ts",
			),
			"utf8",
		);
		const inlineTools = [...source.matchAll(/^\t\ttool:\s*"([^"]+)"/gm)].map(
			(m) => m[1],
		);
		expect(
			inlineTools.length,
			"found no inline `tool:` cases — this guard has lost its target and must be repointed",
		).toBeGreaterThan(0);

		const capturedIds = capturedFixtureRunnerIds();
		const excused = new Set(
			[...EXEMPT.entries()]
				.filter(([, reason]) => {
					const category = parseExemptionReason(reason)?.category;
					return category === "platform" || category === "pending";
				})
				.map(([id]) => id),
		);
		const unbacked = inlineTools.filter(
			(id) => !capturedIds.has(id) && !excused.has(id),
		);
		expect(
			unbacked,
			`exit-blind-runners.test.ts asserts hand-written output for runner(s) that have never met a real binary: ${unbacked.join(", ")}. Capture bytes with scripts/capture-runner-output.mjs, or exempt the runner as platform/pending.`,
		).toEqual([]);
	});
});

/**
 * The scheduled parser lane (.github/workflows/parser-smoke.yml) runs
 * `smoke-tools.mjs --step2 --tier1`: install the real binary, dispatch over a
 * planted violation, fail when the runner finds nothing. These assertions keep
 * that lane from quietly becoming a no-op.
 */
describe("tier-1 parser lane", () => {
	const workflowPath = ".github/workflows/parser-smoke.yml";
	const workflow = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");

	it("selects a non-empty set of fixtures", () => {
		expect(
			tier1Fixtures().length,
			"no fixture carries `tier1: true` — the scheduled lane would exit 2 with nothing to run",
		).toBeGreaterThan(0);
	});

	// A tier-1 fixture with no `tools` cannot be provisioned by `--install`, and
	// one without `expectDiagnostic` is exempt from the Step-2 verdict — either
	// way the lane runs it and asserts nothing.
	it("every tier-1 fixture is installable and asserted", () => {
		const bad = tier1Fixtures()
			.filter((fx) => !(fx.tools ?? []).length || fx.expectDiagnostic !== true)
			.map((fx) => fx.lang);
		expect(
			bad,
			`tier-1 fixture(s) that --install cannot provision or --step2 does not assert: ${bad.join(", ")}`,
		).toEqual([]);
	});

	it("every tier-1 fixture's project directory exists", () => {
		const missing = tier1Fixtures()
			.filter((fx) => !fs.existsSync(path.join(repoRoot, fx.dir)))
			.map((fx) => `${fx.lang} → ${fx.dir}`);
		expect(
			missing,
			`tier-1 fixture(s) with no project dir: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("the workflow asserts findings and keeps no language list of its own", () => {
		expect(
			workflow,
			`${workflowPath} must run the Step-2 verdict, not the Step-1 spawn check`,
		).toContain("--step2");
		expect(
			workflow,
			`${workflowPath} must select through --tier1 so the fixture rows stay the single source`,
		).toContain("--tier1");
		const invocation =
			workflow.match(/node scripts\/smoke-tools\.mjs[^\n]*/)?.[0] ?? "";
		const positional = invocation
			.split(/\s+/)
			.slice(2)
			.filter((token) => !token.startsWith("--"));
		expect(
			positional,
			`${workflowPath} names languages inline (${positional.join(", ")}) — that list duplicates the \`tier1\` flags in scripts/smoke-tools.mjs and will drift`,
		).toEqual([]);
	});

	/**
	 * An unavailable tool reports the warning state, never a failure, so a run
	 * where every install failed exits 0 with a clean report. That is an
	 * unspawnable prober delivering a durable green verdict. `--min-pass` is
	 * the floor that makes mass unavailability red while a single missing tool
	 * stays a visible warning.
	 */
	it("the workflow sets a pass floor that tracks the tier-1 fixture rows", () => {
		const declared = workflow.match(/--min-pass=(\d+)/)?.[1];
		expect(
			declared,
			`${workflowPath} sets no --min-pass, so a run where every tool failed to install would exit 0`,
		).toBeDefined();

		const targets = tier1Fixtures().flatMap((fx) => fx.targets ?? []);
		// 80% of the tier-1 targets. Below that the lane is not measuring the
		// tier it claims to; above it, one tool missing on a given night is
		// still allowed through as a warning.
		const required = Math.floor(targets.length * 0.8);
		expect(
			Number(declared),
			`--min-pass=${declared} is too low for ${targets.length} tier-1 target(s) — it must be at least ${required}, so adding fixtures without raising the floor reds here`,
		).toBeGreaterThanOrEqual(required);
		expect(
			Number(declared),
			`--min-pass=${declared} exceeds the ${targets.length} tier-1 target(s), so the lane can never pass`,
		).toBeLessThanOrEqual(targets.length);
	});

	it("the pass floor fires on mass unavailability and holds otherwise", () => {
		const unavailable = [
			{ state: "skip" as const },
			{ state: "skip" as const },
			{ state: "pass" as const },
		];
		expect(passFloorBreach(unavailable, 3)).toMatch(/pass floor/);
		expect(passFloorBreach(unavailable, 1)).toBeNull();
		// No floor declared is the pre-existing behaviour, unchanged.
		expect(passFloorBreach(unavailable, null)).toBeNull();
	});
});
