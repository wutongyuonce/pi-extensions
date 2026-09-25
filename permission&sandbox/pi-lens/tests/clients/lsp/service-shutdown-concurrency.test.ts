/** Regression coverage for #851: service teardown must not serialize clients. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("LSPService shutdown concurrency (#851)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	it("starts every client teardown before waiting for the shared grace gate", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const fleetSize = 17;
		const shutdownGate = deferred();
		const allStarted = deferred();
		let started = 0;

		const clients = Array.from({ length: fleetSize }, (_, index) => ({
			isAlive: () => true,
			serverId: `server-${index}`,
			shutdown: vi.fn(async () => {
				started += 1;
				if (started === fleetSize) allStarted.resolve();
				await shutdownGate.promise;
			}),
		}));
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		for (const [index, client] of clients.entries()) {
			state.clients.set(`server-${index}:root-${index}`, client);
		}

		let settled = false;
		const shutdown = service.shutdown().then(() => {
			settled = true;
		});
		await allStarted.promise;

		expect(
			clients.every(
				(client) => client.shutdown.mock.invocationCallOrder.length === 1,
			),
		).toBe(true);
		expect(settled).toBe(false);

		shutdownGate.resolve();
		await shutdown;
		expect(settled).toBe(true);
	});
});
