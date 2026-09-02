#!/usr/bin/env node
// CI entry point for the merge-train warden (#1844). See
// scripts/lib/merge-train-warden.mjs for the decision logic and
// .github/workflows/merge-train-warden.yml for the schedule.

import { appendFileSync } from "node:fs";
import { runWarden } from "./lib/merge-train-warden.mjs";

async function main() {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!repository || !token)
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
	const [owner, repo] = repository.split("/");

	const fetcher = (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});

	const results = await runWarden({ fetcher, owner, repo });

	const lines = [
		`Merge-train warden: swept ${results.length} record(s) (PR sweep + any list-level errors).`,
	];
	for (const r of results) {
		// #2184 AC3: every PR gets a line naming its run-health classification,
		// even a quiet one. The stall this workflow exists to catch looks exactly
		// like "nothing needed doing" from the old actions-only summary.
		const quiet =
			r.applied.length === 0 && r.errors.length === 0 && r.runHealth === null;
		if (quiet) continue;
		lines.push(
			`- ${r.number === null ? "(list fetch)" : `#${r.number} (${r.mergeStateStatus}) ${r.url}`}`,
		);
		if (r.runHealth)
			lines.push(
				`  runs: ${r.runHealth.classification}${r.runHealth.detail ? ` — ${r.runHealth.detail}` : ""}`,
			);
		if (r.applied.length > 0) lines.push(`  applied: ${r.applied.join(", ")}`);
		if (r.errors.length > 0) {
			lines.push(
				`  ${r.errors.map((e) => `${e.benign ? "note" : "ERROR"}: ${e.message}`).join("; ")}`,
			);
		}
	}
	if (lines.length === 1) lines.push("No PR needed a warden action this run.");
	const summary = lines.join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

	// Only a NON-benign error marks the scheduled run red (review round 1, F4)
	// -- a closed PR racing a label call, or an update-branch 422 on a fork,
	// is expected noise on a 10-minute cadence, not a warden failure worth
	// emailing about every tick.
	const hadFatalErrors = results.some((r) => r.errors.some((e) => !e.benign));
	if (hadFatalErrors) process.exitCode = 1;
}

main().catch((error) => {
	// Defense in depth (review round 1, F6): runWarden already catches and
	// records everything it can attribute to a specific PR or the list call,
	// but a startup failure (bad env, DNS) must still fail loudly and visibly
	// instead of an unhandled-rejection stack trace with no summary line.
	console.error(
		`Merge-train warden failed to run: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
