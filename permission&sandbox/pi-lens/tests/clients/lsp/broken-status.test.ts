import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { renderLspBrokenStatusLines } from "../../../clients/lens-engine.js";

describe("LSP circuit-breaker health (#927)", () => {
	it("exposes permanently disabled servers even without a live client", () => {
		const service = new LSPService();
		const key = "typescript:c:/work/project";
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			failureCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};
		internal.state.broken.set(key, Date.now() + 60_000);
		internal.failureCounts.set(key, 5);
		internal.permanentlyBroken.add(key);

		expect(service.getStatus()).toEqual([]);
		const broken = service.getBrokenStatus();
		expect(broken).toEqual([
			{
				serverId: "typescript",
				root: "c:/work/project",
				failures: 5,
				permanentlyBroken: true,
				cooldownUntil: expect.any(Number),
			},
		]);
		expect(renderLspBrokenStatusLines(broken)[0]).toContain(
			"✗ typescript — disabled after 5 failures",
		);
	});

	it("renders temporary cooldowns with their deadline", () => {
		const service = new LSPService();
		const until = Date.parse("2026-07-30T12:00:00.000Z");
		const key = "ruff:/work/project";
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			failureCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};
		internal.state.broken.set(key, until);
		internal.failureCounts.set(key, 2);

		const line = renderLspBrokenStatusLines(service.getBrokenStatus())[0];
		expect(line).toContain("ruff — cooling down after 2 failure(s)");
		expect(line).toContain("2026-07-30T12:00:00.000Z");
	});
});
