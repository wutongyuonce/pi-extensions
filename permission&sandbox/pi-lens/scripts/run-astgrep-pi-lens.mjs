// CLI wrapper for the pi-lens self-scan (#1718). Runs the dogfooded
// pi-lens-self-scan rule subset (see scripts/lib/astgrep-self-scan.mjs)
// against clients/ + tests/ and fails when a NEW finding shows up that isn't
// already triaged into rules/ast-grep-rules/self-scan-baseline.json.
//
// Previously this script hardcoded a single author's now-nonexistent machine
// paths (C:/Users/R3LiC/Desktop/pi-lens[-rules2]) as both the scan target and
// the rules source, so it ran nowhere -- not in CI, not on any other
// contributor's machine. It silently printed nothing and exited 0. Fixed by
// deriving every path from this file's own location and the shipped
// rules/ast-grep-rules/.sgconfig.yml.
//
// Usage:
//   node scripts/run-astgrep-pi-lens.mjs                 # scan and report; exit 1 on an untriaged hit
//   node scripts/run-astgrep-pi-lens.mjs --update-baseline # regenerate the baseline from the current scan
//   node scripts/run-astgrep-pi-lens.mjs <path> [<path> ...] # scan explicit path(s) instead of clients/+tests/
//
// npm scripts: `npm run astgrep:self-scan` / `npm run astgrep:self-scan:update-baseline`.
//
// Test-only override (tests/scripts/astgrep-self-scan.test.ts spawns this
// file for real via execFileSync to prove the exit code, not just the lib
// function's return value): PI_LENS_SELF_SCAN_SGCONFIG points the scan at an
// explicit sgconfig path, so the wrapper's failure handling can be exercised
// against a genuinely broken config without touching the real one.
import {
	findingSignature,
	loadBaseline,
	runSelfScan,
	selfScanRuleIds,
	writeBaseline,
} from "./lib/astgrep-self-scan.mjs";

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const scanPathArgs = args.filter((a) => a !== "--update-baseline");
const sgConfigOverride = process.env.PI_LENS_SELF_SCAN_SGCONFIG || undefined;

function main() {
	const ruleIds = selfScanRuleIds();
	console.log(
		`[astgrep-self-scan] running ${ruleIds.length} pi-lens-self-scan rule(s): ${ruleIds.join(", ")}`,
	);

	let result;
	try {
		result = runSelfScan({
			ruleIds,
			...(scanPathArgs.length > 0 ? { scanPaths: scanPathArgs } : {}),
			...(sgConfigOverride ? { sgConfigPath: sgConfigOverride } : {}),
		});
	} catch (e) {
		console.error(`[astgrep-self-scan] scan failed to run: ${e?.message ?? e}`);
		process.exit(1);
	}

	// Shape 10: an empty finding list must be distinguishable from a scan that
	// silently matched nothing. scannedFileCount is ast-grep's own count of
	// files it actually walked, parsed from `--inspect summary`'s stderr --
	// independent of whether any rule fired.
	if (!result.scannedFileCount) {
		console.error(
			`[astgrep-self-scan] scanned 0 files (or the file count could not be parsed from ast-grep's --inspect summary output) -- this is a DEAD scan, not a clean one. stderr:\n${result.stderr}`,
		);
		process.exit(1);
	}
	console.log(
		`[astgrep-self-scan] scanned ${result.scannedFileCount} file(s) with ${result.effectiveRuleCount ?? "?"} effective rule(s); ${result.findings.length} raw finding(s)`,
	);

	if (updateBaseline) {
		const signatures = result.findings.map(findingSignature);
		const p = writeBaseline(signatures);
		console.log(
			`[astgrep-self-scan] wrote ${signatures.length} allowed finding(s) to ${p}`,
		);
		return;
	}

	const baseline = loadBaseline();
	const newFindings = result.findings.filter(
		(f) => !baseline.has(findingSignature(f)),
	);

	if (newFindings.length > 0) {
		console.error(
			`[astgrep-self-scan] ${newFindings.length} NEW finding(s) not in the committed baseline:`,
		);
		for (const f of newFindings) {
			const file = String(f.file ?? "?").replace(/\\/g, "/");
			const line = (f.range?.start?.line ?? 0) + 1;
			console.error(`  ${f.ruleId} ${file}:${line} -- ${f.message ?? ""}`);
		}
		console.error(
			"[astgrep-self-scan] fix the finding, or if it's a legitimate exception, triage it and regenerate the baseline with `npm run astgrep:self-scan:update-baseline`.",
		);
		process.exit(1);
	}

	console.log(
		`[astgrep-self-scan] clean: ${result.findings.length} finding(s), all present in the baseline (${baseline.size} allowed entries).`,
	);
}

main();
