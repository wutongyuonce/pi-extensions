#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import {
	DETECTOR_ISSUE,
	defaultFetcher,
	detectStaleOpenIssues,
	formatSummary,
	shouldPost,
} from "./lib/stale-open-issues.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!repository || !token)
	throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
const runUrl =
	process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
		: undefined;
const { candidates, truncatedCommits, scannedOpenItems, priorityCoverage } =
	await detectStaleOpenIssues({
		fetcher: defaultFetcher(token),
		repository,
	});
const summary = formatSummary(candidates, {
	runUrl,
	truncatedCommits,
	scannedOpenItems,
	priorityCoverage,
});
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (shouldPost({ candidates, priorityCoverage })) {
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	// Idempotence (#1356 review): update the previous detector comment instead
	// of stacking a new one every week. The marker is the first summary line.
	const marker = "<!-- pi-lens-stale-open-issue-detector -->";
	let existingId;
	try {
		const listed = await fetch(
			`https://api.github.com/repos/${repository}/issues/${DETECTOR_ISSUE}/comments?per_page=100`,
			{ headers },
		);
		if (listed.ok) {
			for (const comment of await listed.json()) {
				if (
					typeof comment?.body === "string" &&
					comment.body.startsWith(marker)
				)
					existingId = comment.id;
			}
		}
	} catch {
		// listing failed -- fall through to POST rather than stay silent
	}
	const url = existingId
		? `https://api.github.com/repos/${repository}/issues/comments/${existingId}`
		: `https://api.github.com/repos/${repository}/issues/${DETECTOR_ISSUE}/comments`;
	await fetch(url, {
		method: existingId ? "PATCH" : "POST",
		headers,
		body: JSON.stringify({ body: summary }),
	});
}
