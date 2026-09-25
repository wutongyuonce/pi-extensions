/**
 * Regression coverage for #850: resetLSPService must not publish a replacement
 * generation that can spawn while an older generation is still tearing down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function nextImmediate(): Promise<"blocked"> {
	return new Promise((resolve) => setImmediate(() => resolve("blocked")));
}

describe("LSP singleton generation handoff (#850)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks replacement spawn until the retiring generation finishes shutdown", async () => {
		const { getLSPService, resetLSPService } =
			await import("../../../clients/lsp/index.js");
		const retiringShutdown = deferred();
		const secondSpawned = deferred();
		let spawnCount = 0;
		const spawn = vi.fn(async () => {
			spawnCount += 1;
			if (spawnCount === 2) secondSpawned.resolve();
			return {
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 850 + spawnCount,
				},
			};
		});
		const replacementShutdown = vi.fn().mockResolvedValue(undefined);
		createLSPClient
			.mockResolvedValueOnce({
				isAlive: () => true,
				shutdown: vi.fn(() => retiringShutdown.promise),
				serverId: "python",
			})
			.mockResolvedValueOnce({
				isAlive: () => true,
				shutdown: replacementShutdown,
				serverId: "python",
			});
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const retiringService = getLSPService();
		await retiringService.getClientForFile(file);

		resetLSPService({ reason: "idle" });
		const replacementService = getLSPService();
		expect(replacementService).not.toBe(retiringService);
		const replacementRequest = replacementService.getClientForFile(file);

		const beforeShutdown = await Promise.race([
			secondSpawned.promise.then(() => "spawned" as const),
			nextImmediate(),
		]);
		expect(beforeShutdown).toBe("blocked");
		expect(spawn).toHaveBeenCalledTimes(1);

		retiringShutdown.resolve();
		await replacementRequest;
		expect(spawn).toHaveBeenCalledTimes(2);

		await replacementService.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(2);

		resetLSPService({ fast: true });
	});

	it("never revives an intermediate generation reset while waiting for handoff", async () => {
		const { getLSPService, resetLSPService } =
			await import("../../../clients/lsp/index.js");
		const retiringShutdown = deferred();
		let spawnCount = 0;
		const spawn = vi.fn(async () => {
			spawnCount += 1;
			return {
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 860 + spawnCount,
				},
			};
		});
		createLSPClient
			.mockResolvedValueOnce({
				isAlive: () => true,
				shutdown: vi.fn(() => retiringShutdown.promise),
				serverId: "python",
			})
			.mockResolvedValue({
				isAlive: () => true,
				shutdown: vi.fn().mockResolvedValue(undefined),
				serverId: "python",
			});
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		await getLSPService().getClientForFile(file);
		resetLSPService({ reason: "idle" });

		const intermediateService = getLSPService();
		const intermediateRequest = intermediateService.getClientForFile(file);
		resetLSPService({ reason: "idle" });

		const currentService = getLSPService();
		const currentRequest = currentService.getClientForFile(file);
		retiringShutdown.resolve();

		expect(await intermediateRequest).toBeUndefined();
		await currentRequest;
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(currentService.getAliveClientCount()).toBe(1);

		resetLSPService({ fast: true });
	});

	it("passes service cwd through child-first client identity synthesis", async () => {
		const { getLSPService, resetLSPService } =
			await import("../../../clients/lsp/index.js");
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 870,
			},
		}));
		let synthesizedRootSource: string | undefined;
		createLSPClient.mockImplementation(
			async (options: { sessionCwd?: string }) => {
				synthesizedRootSource = options.sessionCwd
					? "service-cwd"
					: "lsp-fallback";
				return { isAlive: () => true, shutdown: vi.fn(), serverId: "python" };
			},
		);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		await getLSPService().getClientForFile("C:/repo/main.py");

		expect(synthesizedRootSource).toBe("service-cwd");
		resetLSPService({ fast: true });
	});
});
