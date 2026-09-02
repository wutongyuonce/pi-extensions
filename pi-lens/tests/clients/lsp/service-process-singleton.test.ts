import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LspModule = typeof import("../../../clients/lsp/index.js");

async function freshEvaluation(): Promise<LspModule> {
	vi.resetModules();
	return (await import("../../../clients/lsp/index.js")) as LspModule;
}

describe("LSP process singleton (#2157)", () => {
	beforeEach(async () => {
		const singletons = await import("../../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const lsp = await import("../../../clients/lsp/index.js");
		lsp.resetLSPService({ fast: true, reason: "test" });
		const singletons = await import("../../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
		vi.restoreAllMocks();
	});

	it("adopts one live service across two module evaluations", async () => {
		const first = await freshEvaluation();
		const firstService = first.getLSPService();
		const second = await freshEvaluation();
		expect(second).not.toBe(first);
		expect(second.getLSPService()).toBe(firstService);
	});

	it("reset from the second evaluation tears down the first service", async () => {
		const first = await freshEvaluation();
		const firstService = first.getLSPService();
		const shutdown = vi
			.spyOn(firstService, "shutdown")
			.mockResolvedValue(undefined);
		const second = await freshEvaluation();
		second.resetLSPService({ reason: "session_start", fast: true });
		expect(shutdown).toHaveBeenCalledWith({
			reason: "session_start",
			fast: true,
		});
		expect(second.getLSPService()).not.toBe(firstService);
	});

	it("fast-shuts down a live service in an incompatible cell", async () => {
		const singletons = await import("../../../clients/process-singletons.js");
		const shutdown = vi.fn().mockResolvedValue(undefined);
		singletons._seedProcessSingletonCellForTests("lsp.service", {
			schema: "pi-lens.process-singletons",
			version: 99,
			value: { service: { shutdown }, generationHandoff: undefined },
		});

		const lsp = await freshEvaluation();
		lsp.getLSPService();

		expect(shutdown).toHaveBeenCalledWith({
			fast: true,
			reason: "process_singleton_reset",
		});
	});
});
