#!/usr/bin/env node
/**
 * Lane 1 (#1605): real-host PSScriptAnalyzer `-File` classification smoke.
 *
 * Classifiers that parse tool stderr are built against synthetic samples;
 * real host formats drift. #1540 fixed the primary gap (a durable
 * `-ExecutionPolicy Restricted`/`AllSigned` block on `-File` was previously
 * invisible -- see `clients/dispatch/runners/psscriptanalyzer.ts`'s
 * `policyDenied` regex, `securityerror` + one of `execution polic(y|ies)` /
 * `running scripts is disabled` / `unauthorizedaccess`). #1604 is the open
 * follow-up worry: PowerShell 7 (`pwsh`)'s default `$ErrorView =
 * 'ConciseView'` OMITS the `CategoryInfo: SecurityError` block that stderr
 * pairing was written against (verified live only on Windows PowerShell 5.1
 * -- see `tests/clients/dispatch/runners/psscriptanalyzer-availability.test.ts`'s
 * fixture). This script is the real-host check: it drives the ACTUAL
 * `psScriptAnalyzerRunner.run()` against a real, spawned `pwsh`/`powershell`
 * under a real execution-policy block, and asserts the availability decision
 * it writes to `latency.log`. If pwsh's ConciseView stderr evades the
 * pairing, this lane goes RED -- that is the point (see #1604; this script
 * does not change the classifier regex, only proves whether it holds).
 *
 * Mechanism: PowerShell's "Process" execution-policy scope is stored in the
 * `PSExecutionPolicyPreference` environment variable (NOT
 * `__PSExecutionPolicyPreference` -- verified live against a real Windows
 * host: `$env:PSExecutionPolicyPreference` is what `Get-ChildItem Env:`
 * actually shows after `Set-ExecutionPolicy -Scope Process`). Child processes
 * inherit environment variables, so setting it on THIS script's env before
 * spawning the real runner forces the exact `-File` block a Restricted host
 * would produce, without ever passing `-ExecutionPolicy` on the runner's own
 * argv (the runner never does -- that asymmetry between the `-Command`
 * probes, which the policy doesn't gate, and the `-File` run, which it does,
 * is the whole #1540 defect shape).
 *
 * Legs (each its own child `node` process -- the runner's latches are
 * process-lifetime module singletons, so legs must not share state):
 *   - "pwsh-restricted"   -- REQUIRED. windows-latest always ships pwsh; this
 *                            is the real #1604 leg, so its absence is an
 *                            infra failure, not a silent skip (a runner image
 *                            change that drops pwsh must not go unnoticed).
 *   - "powershell-forced" -- Windows PowerShell 5.1, reached by hiding pwsh's
 *                            directory from the child's PATH so
 *                            `resolvePowerShellCmd`'s pwsh->powershell
 *                            fallback naturally selects it. Only run when a
 *                            SEPARATE `powershell.exe` exists (windows-latest
 *                            always ships both).
 *   - "healthy"           -- no execution-policy override: a negative control
 *                            so a mis-classifying script can't pass by always
 *                            reporting policy-denied. `PSExecutionPolicyPreference`
 *                            is explicitly DELETED (not merely omitted) from
 *                            this leg's env, so an already-Restricted host
 *                            process can't turn "healthy" into a third policy
 *                            leg by inheritance.
 *
 * Before any leg runs, a preflight confirms the PSScriptAnalyzer MODULE is
 * actually installed for every interpreter a leg will use. Without it, the
 * runner's `checkModuleAvailable` gate returns `skipped` for a reason that has
 * nothing to do with execution-policy classification -- and that `skipped`
 * status is IDENTICAL to a genuine policy-denied classification failure, so a
 * missing module would silently read as "the lane passed" or produce the same
 * failure text as a real #1604 regression. The preflight fails distinctly
 * (INFRA, exit 2) so the two can never be confused.
 *
 * `PI_LENS_SMOKE_PSA_PWSH_MODE` (default `required`) gates the pwsh leg's
 * effect on the exit code: `required` (default) treats a pwsh-leg failure as
 * a real lane failure; `expected-fail` still runs and reports the leg, but a
 * FAIL is annotated "(expected-fail pending #1604)" and does not fail the
 * job. This is a deliberate one-line workflow toggle for #1604: if the pwsh
 * leg reds by reproducing ConciseView's stderr evasion, set this env var to
 * `expected-fail` in the workflow rather than leaving a permanently-red
 * nightly, until #1604 lands a fix.
 *
 * pwsh is REQUIRED (see the "pwsh-restricted" leg above), including for a
 * local run of this script -- a Windows dev box without PowerShell 7
 * installed will exit 2 here, not silently narrow to the powershell-forced
 * and healthy legs.
 *
 * Usage: node scripts/smoke-psscriptanalyzer-classification.mjs
 * Exit codes: 0 all required legs classified correctly (a gated pwsh-leg
 * failure under `expected-fail` mode still exits 0 -- see
 * `PI_LENS_SMOKE_PSA_PWSH_MODE` above); 1 a real-host classification mismatch
 * on a required leg (the defect this lane exists to catch); 2 infra failure
 * (no pwsh on PATH, the PSScriptAnalyzer module not installed for an
 * interpreter under test, or the dist build is missing).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const LEG_ENV = "PI_LENS_SMOKE_PSA_LEG";
const SCRATCH_ENV = "PI_LENS_SMOKE_PSA_SCRATCH";
const RESULT_MARKER = "PI_LENS_SMOKE_RESULT ";

async function runChildLeg(legName) {
	const scratch = process.env[SCRATCH_ENV];
	const runnerEntry = pathToFileURL(
		path.join(
			repoRoot,
			"dist",
			"clients",
			"dispatch",
			"runners",
			"psscriptanalyzer.js",
		),
	).href;
	const { default: runner } = await import(runnerEntry);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-psa-smoke-"));
	const filePath = path.join(cwd, "repro.ps1");
	fs.writeFileSync(filePath, "Write-Output 'hi'\n");

	let runnerResult;
	let runnerError = null;
	try {
		runnerResult = await runner.run({ cwd, filePath });
	} catch (err) {
		runnerError = err instanceof Error ? err.message : String(err);
	}

	// latency.log writes go through an async queue (`createNdjsonLogger`) --
	// flush it before reading, or a read immediately after `run()` returns can
	// race a still-pending write and miss the decision it just made (observed
	// live: flaked on whichever leg's write happened to still be in flight).
	const { flushLatencyLog } = await import(
		pathToFileURL(path.join(repoRoot, "dist", "clients", "latency-logger.js"))
			.href
	);
	await flushLatencyLog();

	const latencyLogPath = path.join(scratch, "latency.log");
	let decisions = [];
	if (fs.existsSync(latencyLogPath)) {
		decisions = fs
			.readFileSync(latencyLogPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(
				(e) =>
					e &&
					e.phase === "availability_decision" &&
					e.metadata?.tool === "psscriptanalyzer-exec",
			);
	}
	const last = decisions.at(-1) ?? null;

	console.log(
		RESULT_MARKER +
			JSON.stringify({
				leg: legName,
				runnerStatus: runnerResult?.status ?? null,
				runnerError,
				decision: last
					? {
							verdict: last.metadata.verdict,
							outcome: last.metadata.outcome,
							cause: last.metadata.cause,
							latched: last.metadata.latched,
						}
					: null,
				decisionCount: decisions.length,
			}),
	);
}

function findOnPath(binName) {
	const finder = process.platform === "win32" ? "where" : "which";
	const res = spawnSync(finder, [binName], { encoding: "utf8" });
	if (res.status !== 0) return null;
	const lines = res.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return lines[0] ?? null;
}

/** F1: does `cmd` see the PSScriptAnalyzer module at all? Distinct from
 * execution-policy classification -- a missing module makes the runner
 * `skip` for a reason unrelated to #1540/#1604, and that `skipped` status is
 * indistinguishable from a real policy-denied classification failure unless
 * this is checked first. */
function moduleAvailable(cmd) {
	const res = spawnSync(
		cmd,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }",
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	return res.status === 0;
}

function pathWithoutDirOf(binPath) {
	const dir = path.dirname(binPath);
	const sep = path.delimiter;
	const entries = (process.env.PATH ?? "").split(sep);
	return entries
		.filter((e) => path.resolve(e || ".") !== path.resolve(dir))
		.join(sep);
}

function runLeg(legName, envOverrides) {
	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-psa-smoke-scratch-${legName}-`),
	);
	const env = {
		...process.env,
		[LEG_ENV]: legName,
		[SCRATCH_ENV]: scratch,
		PI_LENS_HOME: scratch,
	};
	// F5: delete, don't just omit -- `...process.env` above already copied any
	// inherited value, and on a host whose OWN process scope is already
	// Restricted (e.g. a corporate runner image) that inherited value would
	// turn a leg that never asked for a policy override into a THIRD
	// policy-denied leg. Every leg starts clean; only an explicit override
	// below re-adds it.
	delete env.PSExecutionPolicyPreference;
	Object.assign(env, envOverrides);
	const res = spawnSync(process.execPath, [__filename], {
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	fs.rmSync(scratch, { recursive: true, force: true });
	if (res.error) {
		return { leg: legName, infra: `child spawn failed: ${res.error.message}` };
	}
	const line = (res.stdout ?? "")
		.split("\n")
		.find((l) => l.startsWith(RESULT_MARKER));
	if (!line) {
		return {
			leg: legName,
			infra: `no result marker in child output (status ${res.status}); stderr: ${(res.stderr ?? "").slice(0, 500)}`,
		};
	}
	try {
		return JSON.parse(line.slice(RESULT_MARKER.length));
	} catch (err) {
		return { leg: legName, infra: `unparseable child result: ${err.message}` };
	}
}

function assertLeg(result, expected) {
	const problems = [];
	if (result.infra) {
		return {
			pass: false,
			id: result.leg,
			problems: [`INFRA: ${result.infra}`],
		};
	}
	if (result.runnerError) {
		problems.push(`runner threw: ${result.runnerError}`);
	}
	if (result.runnerStatus !== expected.runnerStatus) {
		problems.push(
			`runner status: expected ${expected.runnerStatus}, got ${result.runnerStatus}`,
		);
	}
	if (!result.decision) {
		problems.push(
			"no availability_decision record was written for psscriptanalyzer-exec",
		);
	} else {
		for (const key of ["outcome", "cause", "latched"]) {
			if (result.decision[key] !== expected.decision[key]) {
				problems.push(
					`decision.${key}: expected ${JSON.stringify(expected.decision[key])}, got ${JSON.stringify(result.decision[key])}`,
				);
			}
		}
	}
	return { pass: problems.length === 0, id: result.leg, problems };
}

async function main() {
	if (process.platform !== "win32") {
		console.log(
			"skip: PSScriptAnalyzer real-host classification is Windows-only.",
		);
		process.exit(0);
	}

	const runnerEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"dispatch",
		"runners",
		"psscriptanalyzer.js",
	);
	if (!fs.existsSync(runnerEntry)) {
		console.error(
			`dist build missing: ${runnerEntry}\nRun \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}

	const pwshPath = findOnPath("pwsh");
	const powershellPath = findOnPath("powershell");
	// F2: pwsh is REQUIRED, not optional -- windows-latest always ships it, and
	// this leg is the lane's whole reason to exist (the #1604 headline). A
	// silent narrow-to-zero-pwsh-legs must never read as a green job.
	if (!pwshPath) {
		console.error(
			"INFRA FAILURE: pwsh not found on PATH. It is required on windows-latest -- " +
				"the pwsh-restricted leg is this lane's #1604 headline check, and a runner " +
				"image that dropped pwsh must not silently narrow to zero coverage.",
		);
		process.exit(2);
	}

	// F1: preflight every interpreter a leg below will actually spawn. A
	// missing module makes the runner `skip` for a reason that has nothing to
	// do with execution-policy classification, and that `skipped` status
	// prints identically to a real #1604 classification failure -- so this
	// must fail distinctly (INFRA) rather than let the two be confused.
	for (const cmd of [pwshPath, powershellPath].filter(Boolean)) {
		if (!moduleAvailable(cmd)) {
			console.error(`INFRA: PSScriptAnalyzer not available for ${cmd}`);
			process.exit(2);
		}
	}

	// F3: one-line workflow toggle for #1604. `required` (default) treats a
	// pwsh-leg failure as a real lane failure; `expected-fail` still runs and
	// reports it, but does not fail the job -- set this if the pwsh leg reds
	// by reproducing ConciseView's stderr evasion, instead of leaving a
	// permanently-red nightly, until #1604 lands a fix.
	const pwshMode = process.env.PI_LENS_SMOKE_PSA_PWSH_MODE ?? "required";
	if (pwshMode !== "required" && pwshMode !== "expected-fail") {
		console.error(
			`INFRA: PI_LENS_SMOKE_PSA_PWSH_MODE must be "required" or "expected-fail", got ${JSON.stringify(pwshMode)}`,
		);
		process.exit(2);
	}

	const legs = [
		{
			name: "pwsh-restricted",
			env: { PSExecutionPolicyPreference: "Restricted" },
			gated: pwshMode === "expected-fail",
			expected: {
				runnerStatus: "skipped",
				decision: {
					outcome: "non-installable",
					cause: "policy-denied",
					latched: true,
				},
			},
		},
	];
	if (powershellPath) {
		// Force the fallback so this leg exercises powershell.exe (5.1) even
		// though pwsh is (now unconditionally) present -- resolvePowerShellCmd
		// tries pwsh first.
		const env = {
			PSExecutionPolicyPreference: "Restricted",
			PATH: pathWithoutDirOf(pwshPath),
		};
		legs.push({
			name: "powershell-forced",
			env,
			expected: {
				runnerStatus: "skipped",
				decision: {
					outcome: "non-installable",
					cause: "policy-denied",
					latched: true,
				},
			},
		});
	}
	// Negative control: no policy override, whatever PowerShell is naturally
	// present should run cleanly. Guards against a lane that always reports
	// policy-denied regardless of real host behavior (defect shape 7).
	legs.push({
		name: "healthy",
		env: {},
		expected: {
			runnerStatus: "succeeded",
			// `latched` here means "the verdict is memoized for reuse", which is
			// also true of a successful probe (`notePsDecision` sets
			// `latched: verdict.available || isLatchingOutcome(outcome)`) --
			// only a still-cooling TRANSIENT failure would read `false`.
			decision: { outcome: "success", cause: "ok", latched: true },
		},
	});

	console.log(`legs: ${legs.map((l) => l.name).join(", ")}`);
	const outcomes = [];
	for (const leg of legs) {
		const result = runLeg(leg.name, leg.env);
		const verdict = { ...assertLeg(result, leg.expected), gated: !!leg.gated };
		outcomes.push(verdict);
		const tag =
			verdict.gated && !verdict.pass ? " (expected-fail pending #1604)" : "";
		console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.id}${tag}`);
		for (const p of verdict.problems) console.log(`         ${p}`);
		if (verdict.gated && verdict.pass) {
			console.log(
				"         note: this leg is gated expected-fail but PASSED -- consider removing the gate.",
			);
		}
	}

	// A gated leg's failure never blocks the job (F3) -- it is still printed
	// above so the run stays legible about what actually happened.
	const blocking = outcomes.filter((o) => !(o.gated && !o.pass));
	// V3: computed over ALL outcomes, not just `blocking` -- a gated leg's own
	// INFRA failure (e.g. its child never spawned at all) must still be
	// visible in the exit-code decision, even though it can't block the job.
	const anyInfra = outcomes.some((o) =>
		o.problems.some((p) => p.startsWith("INFRA:")),
	);
	const allPass = blocking.every((o) => o.pass);
	const gatedFailedCount = outcomes.filter((o) => o.gated && !o.pass).length;
	if (allPass) {
		// V3: a gated leg's [FAIL] two lines up must not be followed by "ALL
		// LEGS CLASSIFIED CORRECTLY" -- name what's actually gated instead.
		console.log(
			gatedFailedCount > 0
				? `\nREQUIRED LEGS CLASSIFIED CORRECTLY (${gatedFailedCount} gated leg${gatedFailedCount === 1 ? "" : "s"} failed, pending #1604)`
				: "\nALL LEGS CLASSIFIED CORRECTLY",
		);
		process.exit(0);
	}
	console.log("\nCLASSIFICATION MISMATCH DETECTED");
	process.exit(
		anyInfra &&
			blocking.every(
				(o) => !o.pass || o.problems.every((p) => p.startsWith("INFRA:")),
			)
			? 2
			: 1,
	);
}

if (process.env[LEG_ENV]) {
	runChildLeg(process.env[LEG_ENV]).then(
		() => process.exit(0),
		(err) => {
			console.error(err);
			process.exit(2);
		},
	);
} else {
	main().catch((err) => {
		console.error("smoke-psscriptanalyzer-classification.mjs crashed:", err);
		process.exit(2);
	});
}
