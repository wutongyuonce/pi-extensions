import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { functionFactProvider } from "../../../../clients/dispatch/facts/function-facts.js";
import { tryCatchFactProvider } from "../../../../clients/dispatch/facts/try-catch-facts.js";
import { unsafeBoundaryRule } from "../../../../clients/dispatch/rules/unsafe-boundary.js";
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

async function evaluate(filePath: string, content: string) {
	const facts = new FactStore();
	const ctx = makeCtx(filePath, facts);
	facts.setFileFact(filePath, "file.content", content);
	await functionFactProvider.run(ctx, facts);
	await tryCatchFactProvider.run(ctx, facts);
	return unsafeBoundaryRule.evaluate(ctx, facts);
}

describe("unsafeBoundaryRule", () => {
	it("flags a genuinely uncovered async boundary call", async () => {
		const content = `
async function refreshToken(a: number, b: number, c: number, d: number, e: number) {
  if (a) { if (b) { if (c) { if (d) { if (e) { console.log("deep"); } } } } }
  return await fetch("https://example.com/refresh");
}
`;
		const diagnostics = await evaluate("/tmp/uncovered.ts", content);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("unsafe-boundary");
	});

	it("does not flag a nested catch that falls back via state mutation (#969)", async () => {
		// Mirrors providers/qoder/auth.ts's refreshQoderToken shape: high
		// complexity from an if/else branch structure, each branch wraps its
		// IO call in a try/catch whose fallback is an assignment (extend
		// validity) rather than a rethrow/log/return.
		const content = `
async function refreshQoderToken(a: number, b: number, c: number, d: number, e: number) {
  let tokenExpiresAt = 0;
  if (a) {
    if (b) {
      if (c) {
        try {
          credentialsFromPat(a);
        } catch (err) {
          tokenExpiresAt = Date.now() + 1000;
        }
      }
    }
  } else {
    if (d) {
      if (e) {
        try {
          await fetch("https://example.com/refresh");
        } catch (err) {
          tokenExpiresAt = Date.now() + 1000;
        }
      }
    }
  }
  return tokenExpiresAt;
}
`;
		const diagnostics = await evaluate("/tmp/covered.ts", content);
		expect(diagnostics).toHaveLength(0);
	});
});
