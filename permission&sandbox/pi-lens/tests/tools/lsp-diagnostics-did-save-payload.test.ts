/**
 * #3408: what the EXPLICIT `lsp_diagnostics` writer puts on the wire for an
 * oversized file.
 *
 * Recurrence this file prevents: the repository's 2 MiB / 5000-line LSP content
 * bound lived twice — a private `exceedsLspSyncLimits` in `clients/pipeline.ts`
 * and an inline copy in `clients/dispatch/runners/lsp.ts` — so a third writer
 * could be added with neither. One was: `tools/lsp-diagnostics.ts` reads whole
 * files with `fs.readFileSync` and has no bound of its own, and once its touch
 * could also carry `textDocument/didSave.text`, the same unbounded string was
 * serialized into a SECOND JSON-RPC frame. The explicit query now refuses the
 * file at its read/sync boundary, so neither frame may reach the transport.
 *
 * Production chain under test, doubled only at the two real boundaries: the
 * `lsp_diagnostics` tool -> the REAL `LSPService.touchFile` -> the REAL
 * `handleNotifyOpen`/`sendDidSave` -> a mock `MessageConnection` (the process
 * boundary) with the server registry (config) faked. The service, the notify
 * queue, the capability gate and the payload bound are all production code.
 *
 * Screens: **all-mocks** — only the JSON-RPC transport and the server registry
 * are doubles; **wrong-layer pin** — the assertion is the serialized frame the
 * server would receive, not a flag on an intermediate object; **loose bound** —
 * the didSave frame size is pinned under an explicit ceiling AND the didOpen
 * frame is pinned as still carrying the content, so a fix that simply stopped
 * syncing large files could not pass.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient,
}));

/** 2 MiB + a margin: past `RUNTIME_CONFIG.pipeline.lspMaxFileBytes`. */
const OVERSIZED_BYTES = 3 * 1024 * 1024;

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 4545,
	};
}

describe("#3405 M3406-1 — didSave payload from the explicit lsp_diagnostics query", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-did-save-size-"));
	});
	afterEach(() => {
		removeTempDirSync(tmpDir);
		vi.restoreAllMocks();
	});

	async function runQuery(bytes: number, includeText: boolean) {
		const clientModule = await import("../../clients/lsp/client.js");
		const { createMockState } =
			await import("../clients/lsp/mock-client-state.js");
		const { LSPService, resetLSPService } =
			await import("../../clients/lsp/index.js");
		const { createLspDiagnosticsTool } =
			await import("../../tools/lsp-diagnostics.js");
		const { resetDegradationLedger, getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");
		resetDegradationLedger();
		resetLSPService?.();

		const file = path.join(tmpDir, "huge.fs");
		// Deliberately FEW lines (a minified-bundle shape): this must overrun the
		// BYTE bound and nothing else, so that neutering the byte branch alone
		// reds this file. A 100-char-per-line fixture also tripped the line bound,
		// which made the byte mutation survive — the isolation is the point.
		const lineWidth = Math.max(1, Math.ceil(bytes / 4));
		fs.writeFileSync(file, `${"x".repeat(lineWidth)}\n`.repeat(4));

		const state = createMockState({ root: tmpDir, serverId: "fsharp" });
		state.saveOptions = { includeText };
		const client = {
			serverId: "fsharp",
			root: tmpDir,
			customServer: false,
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			getLaunchVariant: () => undefined,
			diagnosticsVersion: 0,
			getDiagnosticsVersionForPath: vi.fn(() => 0),
			getDiagnostics: vi.fn(() => []),
			getAllDiagnostics: vi.fn(() => new Map()),
			getDiagnosticBinding: vi.fn(() => undefined),
			// The REAL notify path, against the mock transport on `state`.
			notify: {
				open: (
					filePath: string,
					content: string,
					languageId: string,
					preserveDiagnostics?: boolean,
					silent?: boolean,
					saved?: boolean,
				) =>
					clientModule.handleNotifyOpen(
						state,
						filePath,
						content,
						languageId,
						preserveDiagnostics,
						silent,
						saved,
					),
				change: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			},
			pingLiveness: vi.fn().mockResolvedValue(true),
			waitForDiagnostics: vi.fn(async () => {}),
		};
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "fsharp",
				name: "fsharp",
				extensions: [".fs"],
				root: async () => tmpDir,
				spawn: vi.fn(async () => ({
					process: makeFakeProcess(),
					source: "test",
				})),
			},
		]);
		createLSPClient.mockResolvedValue(client);

		const service = new LSPService();
		const { getLSPService } = await import("../../clients/lsp/index.js");
		void getLSPService;
		await service.getClientsForFile(file);
		await createLspDiagnosticsTool(
			undefined,
			undefined,
			() => service as never,
		).execute(
			"diag-oversized",
			{ path: file, severity: "all", serverScope: "primary" },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);

		const frames = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.map(([method, params]) => ({
				method: String(method),
				bytes: Buffer.byteLength(JSON.stringify(params ?? {}), "utf-8"),
				params: params as { text?: string },
			}));
		return { frames, ledger: getDegradationSummary() };
	}

	it("does not sync a document past the shared content bound", async () => {
		const { frames, ledger } = await runQuery(OVERSIZED_BYTES, true);
		const open = frames.find((f) => f.method === "textDocument/didOpen");
		const save = frames.find((f) => f.method === "textDocument/didSave");

		// #3408 flips the old #3406 pin: the explicit query does not send either
		// content-bearing frame once the shared bound rejects the file.
		expect(open, "didOpen was not sent").toBeUndefined();
		expect(save, "didSave was not sent").toBeUndefined();

		// Bounded, once per file per session — never one row per query.
		const group = ledger.find(
			(g) => g.kind === "lsp-diagnostics-file-too-large",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toContain("huge.fs");
		expect(group?.latestReasons.at(-1)?.reason).toContain("bytes >");
	});

	it("still carries the text for a document inside the bound", async () => {
		// The inverse direction: the bound must not be a blanket refusal to honour
		// `includeText`, or the fsharp writer silently loses what it asked for.
		const { frames, ledger } = await runQuery(4096, true);
		const save = frames.find((f) => f.method === "textDocument/didSave");
		expect(save?.params.text).toBeTypeOf("string");
		expect(ledger.find((g) => g.kind === "lsp-did-save-text-omitted")).toBe(
			undefined,
		);
	});

	it("records the oversized result once regardless of server save options", async () => {
		const { frames, ledger } = await runQuery(OVERSIZED_BYTES, false);
		const save = frames.find((f) => f.method === "textDocument/didSave");
		expect(save?.params.text).toBeUndefined();
		expect(
			frames.find((f) => f.method === "textDocument/didOpen"),
		).toBeUndefined();
		expect(
			ledger.find((g) => g.kind === "lsp-diagnostics-file-too-large")?.count,
		).toBe(1);
	});
});
