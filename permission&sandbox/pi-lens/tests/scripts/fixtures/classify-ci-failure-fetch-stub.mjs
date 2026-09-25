// Fetch stub for the end-to-end CLI test (#2668 review F2). Loaded via
// `node --import` BEFORE scripts/classify-ci-failure.mjs runs, so it can
// replace globalThis.fetch before the CLI's own module-level code executes.
// This is what makes the test exercise the REAL CLI argv-parsing and
// process wiring (spawned as a genuine child process) rather than calling
// the exported library functions directly -- the axis the pre-existing
// `tests/scripts/ci-failure-classifier.test.ts` suite cannot reach, per
// review F2 ("the shipped seam scripts/classify-ci-failure.mjs has zero
// tests").
//
// Configuration is via env vars (the parent test process controls the
// child's env when spawning): a `--import` module takes no CLI args of its
// own.
//   CLASSIFY_CLI_TEST_CALL_LOG   required: path this stub appends one JSON
//                                 line per intercepted fetch call to, so the
//                                 parent test can assert on them after the
//                                 child process exits (a different process
//                                 can't share the parent's in-memory array).
//   CLASSIFY_CLI_TEST_RERUN_STATUS  optional (default "201"): HTTP status
//                                 the rerun-failed-jobs endpoint returns.
//   CLASSIFY_CLI_TEST_RUN_ATTEMPT   optional (default "1"): the run's own
//                                 `run_attempt`, exactly as GitHub's
//                                 GET /actions/runs/:id reports it (#2042).
//                                 Without it this stub could only ever
//                                 exercise attempt 1, so the shipped CLI's
//                                 attempt handling -- the second infra kill
//                                 on one head, and the two-rerun bound --
//                                 had no end-to-end coverage at all.
//   CLASSIFY_CLI_TEST_PR_COMMENT    optional: when set, this run reports PR
//                                 #42 and that PR already carries ONE
//                                 classifier comment with this body. This
//                                 is the PR lane, and it is a different
//                                 lane from the push one above, not a
//                                 cosmetic variation: only here does a
//                                 sticky-comment MARKER exist for the rerun
//                                 guard to read, which is precisely why the
//                                 PR lane stayed broken on a second infra
//                                 kill after the workflow gate was widened
//                                 (#2042). Unset keeps the push shape.
//
// Fixed to run id 999 / job id 111 / job name "Unit tests", matching the
// exact production argv this test exercises
// (`--run 999 --sha deadbeef --infra-kill-only --skip-missing-job
// --allow-missing-pr`) and the same real infra-kill log fixture the
// library's own unit tests use.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawLog = readFileSync(
	join(
		here,
		"..",
		"..",
		"fixtures",
		"ci-failure-logs",
		"infra-kill-wrapper-killed.real.log",
	),
	"utf8",
);

const callLogPath = process.env.CLASSIFY_CLI_TEST_CALL_LOG;
const rerunStatus = Number(process.env.CLASSIFY_CLI_TEST_RERUN_STATUS ?? "201");
const runAttempt = Number(process.env.CLASSIFY_CLI_TEST_RUN_ATTEMPT ?? "1");
const priorComment = process.env.CLASSIFY_CLI_TEST_PR_COMMENT;
const PR_NUMBER = 42;
const comments = priorComment ? [{ id: 555, body: priorComment }] : [];

function record(method, url) {
	if (!callLogPath) return;
	appendFileSync(callLogPath, `${JSON.stringify({ method, url })}\n`);
}

globalThis.fetch = async (url, init = {}) => {
	const method = init?.method ?? "GET";
	const urlStr = String(url);
	record(method, urlStr);

	if (urlStr.endsWith("/actions/runs/999")) {
		// Production-faithful: a push/repository_dispatch run's
		// `pull_requests` array is always empty (#2668); a PR run's carries
		// the PR the workflow also passes with --pr.
		return new Response(
			JSON.stringify({
				head_sha: "deadbeef",
				run_attempt: runAttempt,
				pull_requests: priorComment ? [{ number: PR_NUMBER }] : [],
			}),
			{ status: 200 },
		);
	}
	if (urlStr.endsWith("/actions/runs/999/jobs")) {
		return new Response(
			JSON.stringify({
				jobs: [{ id: 111, name: "Unit tests", conclusion: "failure" }],
			}),
			{ status: 200 },
		);
	}
	if (urlStr.endsWith("/actions/jobs/111/logs")) {
		return new Response(rawLog, { status: 200 });
	}
	if (urlStr.endsWith("/actions/runs/999/rerun-failed-jobs")) {
		return new Response("{}", { status: rerunStatus });
	}
	// PR lane only (CLASSIFY_CLI_TEST_PR_COMMENT). Upsert, never append:
	// the CLI finds the one existing classifier comment and PATCHes it, so
	// the POST branch is deliberately absent -- a POST here would mean the
	// CLI failed to find a comment this stub definitely served.
	if (method === "GET" && urlStr.includes(`/issues/${PR_NUMBER}/comments`)) {
		return new Response(JSON.stringify(comments), { status: 200 });
	}
	if (method === "POST" && urlStr.includes(`/issues/${PR_NUMBER}/comments`)) {
		// Present so a stub GAP can never masquerade as a red: GitHub accepts
		// this call, so a CLI that appends instead of upserting must fail on
		// the test's own POST assertion, not on an "unmocked URL" throw.
		const body = JSON.parse(init?.body ?? "{}");
		const created = { id: 900 + comments.length, body: body.body };
		comments.push(created);
		return new Response(JSON.stringify(created), { status: 201 });
	}
	if (method === "PATCH" && /\/issues\/comments\/\d+$/.test(urlStr)) {
		const body = JSON.parse(init?.body ?? "{}");
		if (comments[0]) comments[0].body = body.body;
		record("PATCHED_BODY", body.body ?? "");
		return new Response(JSON.stringify(comments[0] ?? null), { status: 200 });
	}
	throw new Error(`unmocked URL in CLI fetch stub: ${method} ${urlStr}`);
};
