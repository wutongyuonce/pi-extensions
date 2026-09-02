import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { functionFactProvider } from "../../../../clients/dispatch/facts/function-facts.js";
import { asyncNoiseRule } from "../../../../clients/dispatch/rules/async-noise.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import type { FileKind } from "../../../../clients/file-kinds.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
	return {
		filePath,
		cwd: "/tmp",
		kind: "jsts" as FileKind,
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		hasTool: async () => false,
		log: () => {},
	};
}

describe("asyncNoiseRule", () => {
	it("flags async function with no await", async () => {
		const filePath = "/tmp/noise.ts";
		const content = `
async function noisy(v: number) {
  const result = v + 1;
  return result;
}
`;

		const facts = new FactStore();
		const ctx = makeCtx(filePath, facts);
		facts.setFileFact(filePath, "file.content", content);
		await functionFactProvider.run(ctx, facts);

		const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("async-noise");
	});

	it("does not flag async function with await", async () => {
		const filePath = "/tmp/awaited.ts";
		const content = `
async function good(v: Promise<number>) {
  return await v;
}
`;

		const facts = new FactStore();
		const ctx = makeCtx(filePath, facts);
		facts.setFileFact(filePath, "file.content", content);
		await functionFactProvider.run(ctx, facts);

		const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("does not flag pass-through wrappers", async () => {
		const filePath = "/tmp/wrapper.ts";
		const content = `
async function wrapper(v: number) {
  return transform(v);
}
`;

		const facts = new FactStore();
		const ctx = makeCtx(filePath, facts);
		facts.setFileFact(filePath, "file.content", content);
		await functionFactProvider.run(ctx, facts);

		const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("does not flag an async function with an explicit Promise return type implementing an interface contract (#970)", async () => {
		// Mirrors providers/kilo/kilo-auth.ts's resolveKiloApiKey: implements
		// `ApiKeyAuth.resolve(): Promise<AuthResult | undefined>`. The body is
		// synchronous (no await), but `async` is required by the declared
		// Promise return type — dropping it is a type error, and
		// `Promise.resolve(...)` is equivalent noise, not an improvement.
		const filePath = "/tmp/resolve.ts";
		const content = `
async function resolveKiloApiKey(config: Config): Promise<AuthResult | undefined> {
  if (!config.apiKey) {
    return undefined;
  }
  return { apiKey: config.apiKey };
}
`;

		const facts = new FactStore();
		const ctx = makeCtx(filePath, facts);
		facts.setFileFact(filePath, "file.content", content);
		await functionFactProvider.run(ctx, facts);

		const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("still flags async noise on a plain function with no Promise return type annotation", async () => {
		const filePath = "/tmp/noise-multi.ts";
		const content = `
async function noisy(v: number) {
  const a = v + 1;
  return a * 2;
}
`;

		const facts = new FactStore();
		const ctx = makeCtx(filePath, facts);
		facts.setFileFact(filePath, "file.content", content);
		await functionFactProvider.run(ctx, facts);

		const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("async-noise");
	});
});
