import { describe, expect, it } from "vitest";
import {
	checkPriorityCoverage,
	detectStaleOpenIssues,
	formatSummary,
	MAX_COMMIT_DETAILS,
	MAX_PAGES,
	PAGE_SIZE,
	shouldPost,
} from "../../scripts/lib/stale-open-issues.mjs";

function fakeGithub(data: Record<string, unknown>) {
	const calls: string[] = [];
	const fetcher = async (url: string) => {
		calls.push(url);
		const key = url.replace("https://api.github.com", "").split("?")[0];
		return { ok: true, status: 200, json: async () => data[key] ?? [] };
	};
	return { fetcher, calls };
}

describe("stale open-issue detector (#1323)", () => {
	it("flags open issues from closing-shaped commits and issue-named regression tests", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [
				{
					number: 10,
					title: "still open",
					html_url: "https://github.com/acme/repo/issues/10",
				},
				{
					number: 11,
					title: "already a PR",
					pull_request: {},
					html_url: "https://github.com/acme/repo/issues/11",
				},
			],
			"/repos/acme/repo/commits": [
				{
					sha: "abcdef123",
					commit: { message: "fix: finished it (closes #10)" },
				},
			],
			"/repos/acme/repo/commits/abcdef123": {
				files: [{ filename: "tests/regression-10.test.ts" }],
			},
		});
		const { candidates, truncatedCommits } = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(candidates).toEqual([
			{
				issue: expect.objectContaining({ number: 10 }),
				evidence: [
					"closing-shaped commit abcdef1",
					"regression-test file tests/regression-10.test.ts",
				],
			},
		]);
		expect(truncatedCommits).toBe(0);
	});

	it("fails loudly instead of returning a population beyond the page bound", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": Array.from({ length: PAGE_SIZE }, (_, i) => ({
				number: i + 1,
				labels: [{ name: "priority:p3" }],
			})),
			"/repos/acme/repo/commits": [],
		});
		await expect(
			detectStaleOpenIssues({ fetcher, repository: "acme/repo" }),
		).rejects.toThrow("refusing to use a partial response");
	});

	it("paginates the open population until GitHub returns an empty page", async () => {
		const pages = [
			Array.from({ length: PAGE_SIZE }, (_, i) => ({
				number: i + 1,
				labels: [{ name: "priority:p3" }],
			})),
			[{ number: PAGE_SIZE + 1, labels: [{ name: "priority:p3" }] }],
			[],
		];
		const fetcher = async (url: string) => {
			const parsed = new URL(url);
			const page = Number(parsed.searchParams.get("page"));
			return {
				ok: true,
				status: 200,
				json: async () =>
					parsed.pathname.endsWith("/issues") ? pages[page - 1] : [],
			};
		};
		const result = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(result.scannedOpenItems).toBe(PAGE_SIZE + 1);
		expect(
			formatSummary([], { scannedOpenItems: result.scannedOpenItems }),
		).toContain("Scanned population: 101 open item(s).");
	});

	it("ignores issues absent from the open-issue response and non-test filenames", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [
				{ number: 10, title: "open" },
				{ number: 12, title: "pull request", pull_request: {} },
			],
			"/repos/acme/repo/commits": [
				{ sha: "abc", commit: { message: "docs: mention fixes #12" } },
			],
			"/repos/acme/repo/commits/abc": { files: [{ filename: "src/12.ts" }] },
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
	});

	// #1356 review: quoted keyword text and reverts are not closing intent.
	it("ignores quoted and reverted closing-shaped text", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [{ number: 42, title: "open" }],
			"/repos/acme/repo/commits": [
				{
					sha: "a1",
					commit: { message: 'docs: quote "closes #42" as an example' },
				},
				{ sha: "a2", commit: { message: 'Revert "fix: closes #42"' } },
			],
			"/repos/acme/repo/commits/a1": { files: [] },
			"/repos/acme/repo/commits/a2": { files: [] },
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
	});

	// #1356 review: the commit-detail cap must be reported, never silent.
	it("reports commits beyond the detail cap in the summary", async () => {
		const commits = Array.from({ length: MAX_COMMIT_DETAILS + 5 }, (_, i) => ({
			sha: `sha${i}`,
			commit: { message: "chore: routine" },
		}));
		const data: Record<string, unknown> = {
			"/repos/acme/repo/issues": [],
			"/repos/acme/repo/commits": commits,
		};
		for (const c of commits)
			data[`/repos/acme/repo/commits/${c.sha}`] = { files: [] };
		// Page-aware: the commit list is served once, then empty, so pagination
		// terminates and the cap arithmetic sees exactly `commits.length`.
		const served = new Set<string>();
		const fetcher = async (url: string) => {
			const key = url.replace("https://api.github.com", "").split("?")[0];
			let payload = data[key] ?? [];
			if (key === "/repos/acme/repo/commits") {
				payload = served.has(url) || served.has(key) ? [] : payload;
				served.add(key);
			}
			return { ok: true, status: 200, json: async () => payload };
		};
		const { candidates, truncatedCommits } = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(truncatedCommits).toBe(5);
		expect(formatSummary(candidates, { truncatedCommits })).toContain(
			"5 commit(s) beyond",
		);
	});

	it("keeps the bounded commit window and reports truncation", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			Array.from({ length: PAGE_SIZE }, (_, itemIndex) => ({
				sha: `page${pageIndex}-sha${itemIndex}`,
				commit: { message: "chore: routine" },
			})),
		);
		const commits = pages.flat();
		const fetcher = async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith("/issues"))
				return { ok: true, status: 200, json: async () => [] };
			if (parsed.pathname.endsWith("/commits"))
				return {
					ok: true,
					status: 200,
					json: async () => pages[Number(parsed.searchParams.get("page")) - 1],
				};
			return { ok: true, status: 200, json: async () => ({ files: [] }) };
		};

		const result = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(result.candidates).toEqual([]);
		expect(result.truncatedCommits).toBe(commits.length - MAX_COMMIT_DETAILS);
	});

	it("keeps API work bounded and formats one detection-only summary", async () => {
		const { fetcher, calls } = fakeGithub({
			"/repos/acme/repo/issues": [],
			"/repos/acme/repo/commits": [],
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
		expect(MAX_PAGES).toBe(3);
		expect(PAGE_SIZE).toBe(100);
		expect(MAX_COMMIT_DETAILS).toBe(100);
		expect(calls[0]).toContain("per_page=100");
		expect(formatSummary([], { runUrl: "https://example/run" })).toContain(
			"never closes issues",
		);
	});
});

describe("priority label coverage (#1676)", () => {
	it("flags an open issue with zero priority:* labels", () => {
		const issues = [
			{
				number: 1,
				title: "no priority",
				html_url: "https://github.com/acme/repo/issues/1",
				labels: [{ name: "bug" }],
			},
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([expect.objectContaining({ number: 1 })]);
		expect(multiple).toEqual([]);
	});

	it("does not flag an open issue with exactly one priority:* label", () => {
		const issues = [
			{
				number: 2,
				title: "one priority",
				html_url: "https://github.com/acme/repo/issues/2",
				labels: [{ name: "bug" }, { name: "priority:p2" }],
			},
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([]);
		expect(multiple).toEqual([]);
	});

	it("flags an open issue with more than one priority:* label", () => {
		const issues = [
			{
				number: 3,
				title: "two priorities",
				html_url: "https://github.com/acme/repo/issues/3",
				labels: [{ name: "priority:p1" }, { name: "priority:p2" }],
			},
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([]);
		expect(multiple).toEqual([expect.objectContaining({ number: 3 })]);
	});

	it("treats labels that merely contain 'priority' but aren't priority:* as zero coverage", () => {
		const issues = [
			{
				number: 4,
				title: "decoy label",
				html_url: "https://github.com/acme/repo/issues/4",
				labels: [{ name: "high-priority" }, { name: "not-priority:p1" }],
			},
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([expect.objectContaining({ number: 4 })]);
		expect(multiple).toEqual([]);
	});

	it("ignores pull requests when checking priority coverage", () => {
		const issues = [
			{
				number: 5,
				title: "a pull request",
				html_url: "https://github.com/acme/repo/pull/5",
				pull_request: {},
				labels: [],
			},
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([]);
		expect(multiple).toEqual([]);
	});

	it("accepts plain-string labels, not only label objects", () => {
		const issues = [
			{ number: 6, title: "string label", labels: ["priority:p3"] },
		];
		const { zero, multiple } = checkPriorityCoverage(issues);
		expect(zero).toEqual([]);
		expect(multiple).toEqual([]);
	});

	it("sorts both lists by issue number", () => {
		const issues = [
			{ number: 20, title: "b", labels: [] },
			{ number: 7, title: "a", labels: [] },
		];
		const { zero } = checkPriorityCoverage(issues);
		expect(zero.map((issue) => issue.number)).toEqual([7, 20]);
	});
});

describe("formatSummary priority coverage section", () => {
	it("lists zero- and multiple-priority issues by number and title", () => {
		const summary = formatSummary([], {
			priorityCoverage: {
				zero: [
					{
						number: 8,
						title: "missing priority",
						html_url: "https://github.com/acme/repo/issues/8",
					},
				],
				multiple: [
					{
						number: 9,
						title: "double priority",
						html_url: "https://github.com/acme/repo/issues/9",
					},
				],
			},
		});
		expect(summary).toContain("Priority label coverage");
		expect(summary).toContain("#8");
		expect(summary).toContain("missing priority");
		expect(summary).toContain("#9");
		expect(summary).toContain("double priority");
	});

	it("omits the priority coverage section when not provided (byte-identical for existing callers)", () => {
		const before = formatSummary([], { runUrl: "https://example/run" });
		expect(before).not.toContain("Priority label coverage");
	});
});

describe("shouldPost (#1676 fix round)", () => {
	it("posts when priority gaps exist even with zero stale candidates", () => {
		expect(
			shouldPost({
				candidates: [],
				priorityCoverage: { zero: [{ number: 1, title: "x" }], multiple: [] },
			}),
		).toBe(true);
	});

	it("stays silent when there are neither stale candidates nor priority gaps", () => {
		expect(
			shouldPost({
				candidates: [],
				priorityCoverage: { zero: [], multiple: [] },
			}),
		).toBe(false);
	});

	it("posts when multiple priority labels exist even without zero-label gaps", () => {
		expect(
			shouldPost({
				candidates: [],
				priorityCoverage: { zero: [], multiple: [{ number: 2, title: "x" }] },
			}),
		).toBe(true);
	});
});
