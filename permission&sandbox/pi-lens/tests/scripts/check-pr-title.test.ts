import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MISSING_ISSUE_REF_MESSAGE,
	MISSING_PREFIX_MESSAGE,
	lintPrTitle,
	resolveLivePrTitle,
} from "../../scripts/check-pr-title.mjs";

const payloadPr = {
	number: 2083,
	title: "fix: stale payload title",
	body: "Refs #2083",
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PR title lint (#1844)", () => {
	it("accepts a conventional prefix with an issue ref in the title", () => {
		expect(lintPrTitle("fix: repair the widget cache (refs #123)")).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("accepts a scoped prefix", () => {
		expect(
			lintPrTitle("feat(lsp): add native fallback (closes #456)"),
		).toMatchObject({
			valid: true,
		});
	});

	// Policy (#1917 review F1): the issue ref must live in the TITLE. Merges
	// are merge commits from the PR title, so a ref sitting only in the body
	// never survives into the merge-commit subject line -- it must not
	// rescue an otherwise-unreferenced title. This is the regression case
	// for the fallback (`|| ISSUE_REF.test(body)`) that used to live here.
	it("rejects a title with no issue ref even when the body has one", () => {
		const result = lintPrTitle("chore: tidy scripts", "Refs #789");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_ISSUE_REF_MESSAGE);
	});

	it("rejects a title with no conventional prefix", () => {
		const result = lintPrTitle("Repair the widget cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("rejects a prefix not in the allowed set", () => {
		const result = lintPrTitle("wip: repair the widget cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("rejects a title with no issue reference", () => {
		const result = lintPrTitle("fix: repair the widget cache");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_ISSUE_REF_MESSAGE);
	});

	it("rejects a prefix with no colon-space separator", () => {
		const result = lintPrTitle("fix:repair the cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("reports both errors when both are missing", () => {
		const result = lintPrTitle("repair the cache");
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			MISSING_PREFIX_MESSAGE,
			MISSING_ISSUE_REF_MESSAGE,
		]);
	});

	it("accepts a cross-repo style issue ref count in the title (# followed by digits only)", () => {
		expect(lintPrTitle("fix: repair cache #123")).toMatchObject({
			valid: true,
		});
	});
});

describe("live PR title resolution (#2083)", () => {
	it("uses the live title when it differs from the event payload", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ title: "fix: current title (refs #2083)" }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const title = await resolveLivePrTitle(payloadPr, fetchImpl);
		expect(title).toBe("fix: current title (refs #2083)");
		expect(lintPrTitle(title).valid).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2083",
			expect.objectContaining({
				headers: {
					Authorization: "Bearer test-token",
					Accept: "application/vnd.github+json",
				},
			}),
		);
	});

	it("uses the live invalid title instead of a compliant payload title", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "needs a prefix (#2083)" }), {
				status: 200,
			}),
		);

		const title = await resolveLivePrTitle(
			{ ...payloadPr, title: "fix: payload title (refs #2083)" },
			fetchImpl,
		);
		expect(title).toBe("needs a prefix (#2083)");
		expect(lintPrTitle(title).valid).toBe(false);
	});

	it("falls back to the payload title and warns when fetching fails", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

		await expect(resolveLivePrTitle(payloadPr, fetchImpl)).resolves.toBe(
			payloadPr.title,
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("network down"),
		);
		warning.mockRestore();
	});

	it("falls back with an annotation when GitHub returns a non-2xx response", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("forbidden", { status: 403 }));

		await expect(resolveLivePrTitle(payloadPr, fetchImpl)).resolves.toBe(
			payloadPr.title,
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
	});

	it("falls back with an annotation when the response has no string title", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ title: 2083 }), { status: 200 }),
			);

		await expect(resolveLivePrTitle(payloadPr, fetchImpl)).resolves.toBe(
			payloadPr.title,
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("response has no title"),
		);
	});

	it("falls back with an annotation when GITHUB_TOKEN is unset", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn();

		await expect(resolveLivePrTitle(payloadPr, fetchImpl)).resolves.toBe(
			payloadPr.title,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("GITHUB_TOKEN is missing"),
		);
	});
});
