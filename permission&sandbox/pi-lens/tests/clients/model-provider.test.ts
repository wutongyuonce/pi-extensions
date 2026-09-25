import { describe, expect, it } from "vitest";
import { deriveProviderFromModelId } from "../../clients/model-provider.js";

describe("deriveProviderFromModelId (#1448)", () => {
	it("returns blank for undefined/empty input", () => {
		expect(deriveProviderFromModelId(undefined)).toBe("");
		expect(deriveProviderFromModelId("")).toBe("");
		expect(deriveProviderFromModelId("   ")).toBe("");
	});

	it("splits a provider/model id on a single slash separator", () => {
		expect(deriveProviderFromModelId("anthropic/claude-sonnet-4-5")).toBe(
			"anthropic",
		);
	});

	it("splits a provider:model id on a single colon separator", () => {
		expect(deriveProviderFromModelId("openai:gpt-5")).toBe("openai");
	});

	it("lowercases the derived provider", () => {
		expect(deriveProviderFromModelId("Anthropic/Claude-Sonnet-4-5")).toBe(
			"anthropic",
		);
	});

	it("matches known vendor prefixes when there is no separator", () => {
		expect(deriveProviderFromModelId("claude-sonnet-4-5")).toBe("anthropic");
		expect(deriveProviderFromModelId("gpt-5")).toBe("openai");
		expect(deriveProviderFromModelId("o1-preview")).toBe("openai");
		expect(deriveProviderFromModelId("o3-mini")).toBe("openai");
		expect(deriveProviderFromModelId("gemini-2.5-pro")).toBe("google");
		expect(deriveProviderFromModelId("llama-3.1-70b")).toBe("meta");
		expect(deriveProviderFromModelId("mistral-large")).toBe("mistral");
		expect(deriveProviderFromModelId("mixtral-8x7b")).toBe("mistral");
		expect(deriveProviderFromModelId("command-r-plus")).toBe("cohere");
	});

	it("returns blank for an unrecognized prefix rather than guessing", () => {
		expect(deriveProviderFromModelId("some-custom-finetune")).toBe("");
	});

	it("returns blank when the id has more than one separator (ambiguous)", () => {
		expect(deriveProviderFromModelId("anthropic/claude/sonnet")).toBe("");
		expect(deriveProviderFromModelId("a/b:c")).toBe("");
	});

	it("returns blank when a separator has nothing on one side", () => {
		expect(deriveProviderFromModelId("/claude-sonnet-4-5")).toBe("");
		expect(deriveProviderFromModelId("anthropic/")).toBe("");
	});
});
