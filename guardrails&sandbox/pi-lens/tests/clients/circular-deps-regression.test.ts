import { describe, expect, it } from "vitest";

/**
 * Regression tests for circular dependency fixes.
 *
 * These tests verify that the circular dependencies that were fixed
 * don't get reintroduced. The tests import from both sides of the
 * former circular dependency to ensure they can still be resolved.
 */
describe("circular dependency regression - diagnostic taxonomy", () => {
	it("can import from diagnostic-taxonomy.ts without circular errors", async () => {
		const { classifyDefect, classifyDiagnostic } =
			await import("../../clients/dispatch/diagnostic-taxonomy.js");

		expect(classifyDefect).toBeDefined();
		expect(classifyDiagnostic).toBeDefined();

		// Test actual classification behavior
		const result = classifyDefect("empty-catch", undefined, "some message");
		expect(result).toBe("silent-error");
	});

	it("classifies various defect types correctly", () => {
		// Test cases for classifyDefect to ensure it works
		const testCases: Array<{
			rule: string | undefined;
			tool: string | undefined;
			message: string;
			expected: string;
		}> = [
			{
				rule: "empty-catch",
				tool: undefined,
				message: "",
				expected: "silent-error",
			},
			{
				rule: "sql-injection",
				tool: undefined,
				message: "",
				expected: "injection",
			},
			{
				rule: "hardcoded-secrets",
				tool: undefined,
				message: "",
				expected: "secrets",
			},
			{
				rule: "await-in-loop",
				tool: undefined,
				message: "",
				expected: "async-misuse",
			},
			{
				rule: "no-return",
				tool: undefined,
				message: "",
				expected: "correctness",
			},
			{
				rule: "unsafe-block",
				tool: undefined,
				message: "",
				expected: "safety",
			},
			{ rule: "format", tool: undefined, message: "", expected: "style" },
			{
				rule: "unknown-rule",
				tool: undefined,
				message: "",
				expected: "unknown",
			},
		];

		// Dynamic import to get the function
		return import("../../clients/dispatch/diagnostic-taxonomy.js").then(
			({ classifyDefect }) => {
				for (const { rule, tool, message, expected } of testCases) {
					const result = classifyDefect(rule, tool, message);
					expect(result).toBe(expected);
				}
			},
		);
	});
});

describe("circular dependency regression - language policy", () => {
	it("can import from language-profile.ts without circular errors", async () => {
		const profileModule = await import("../../clients/language-profile.js");
		expect(profileModule).toBeDefined();
		expect(profileModule.getDefaultStartupTools).toBeDefined();
	});

	it("getDefaultStartupTools respects heavyScansRequireConfig", async () => {
		const { getDefaultStartupTools } =
			await import("../../clients/language-profile.js");

		// Create a profile where jsts is present but NOT configured
		// jsts has heavyScansRequireConfig: true
		const unconfiguredProfile = {
			present: {
				jsts: true,
				python: true,
				go: false,
				rust: false,
				cxx: false,
				cmake: false,
				shell: false,
				json: false,
				markdown: false,
				css: false,
				yaml: false,
				sql: false,
				ruby: false,
				html: false,
				docker: false,
				php: false,
				powershell: false,
				prisma: false,
				csharp: false,
				fsharp: false,
				java: false,
				kotlin: false,
				swift: false,
				dart: false,
				lua: false,
				zig: false,
				haskell: false,
				elixir: false,
				gleam: false,
				ocaml: false,
				clojure: false,
				terraform: false,
				nix: false,
				toml: false,
			},
			configured: {
				// jsts is NOT configured
				jsts: false,
				python: true,
			},
			counts: {},
			detectedKinds: ["jsts", "python"],
		} as unknown as import("../../clients/language-policy.js").ProjectLanguageProfile;

		const tools = getDefaultStartupTools(unconfiguredProfile);

		// Python tools should be present (no config required)
		expect(tools).toContain("pyright");
		expect(tools).toContain("ruff");

		// TypeScript tools should NOT be present (jsts needs config)
		expect(tools).not.toContain("typescript-language-server");
		expect(tools).not.toContain("biome");
	});
});
