/**
 * #1621 — LSPService.renameFile must stay bounded when a client's
 * `textDocument/didClose` or `workspace/didRenameFiles` notify is wedged.
 *
 * Same primitive as #1620's exit-notify hang: a notification write on a pipe
 * that is not draining neither resolves nor rejects, so a bare
 * `await client.closeDocument(...)` / `await client.didRenameFiles(...)` never
 * settles. Unlike #1620's teardown path there is no process to kill here —
 * rename propagation is best-effort advice to servers, not a correctness
 * gate, so a wedged client's notify must be bounded, recorded in the existing
 * failure ledger with a disposition that survives the message string, and
 * must not stall the `Promise.all` for the healthy clients settling
 * alongside it.
 *
 * Both tests set a short `PI_LENS_LSP_RENAME_NOTIFY_TIMEOUT_MS` before
 * dynamically importing `clients/lsp/index.js`, since the budget is read from
 * `process.env` at module load time. Pre-fix, both tests hang to vitest's own
 * per-test timeout because the bare `await` on the wedged double never
 * settles.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// Keep the budget short so a wedged double is bounded well inside the
// per-test timeout. Assigned before the dynamic `index.js` import in each
// test below, so the module-load-time env read sees this value.
process.env.PI_LENS_LSP_RENAME_NOTIFY_TIMEOUT_MS = "80";

type LSPServiceModule = typeof import("../../../clients/lsp/index.js");

type MockRenameClient = {
	root: string;
	isAlive: ReturnType<typeof vi.fn>;
	isDocumentOpen: ReturnType<typeof vi.fn>;
	getDocumentUri: ReturnType<typeof vi.fn>;
	closeDocument: ReturnType<typeof vi.fn>;
	notify: { open: ReturnType<typeof vi.fn> };
	willRenameFiles: ReturnType<typeof vi.fn>;
	getOperationSupport: ReturnType<typeof vi.fn>;
	didRenameFiles: ReturnType<typeof vi.fn>;
};

function makeClient(root: string): MockRenameClient {
	return {
		root,
		isAlive: vi.fn(() => true),
		isDocumentOpen: vi.fn(() => false),
		getDocumentUri: vi.fn(() => undefined),
		closeDocument: vi.fn(async () => undefined),
		notify: { open: vi.fn(async () => undefined) },
		willRenameFiles: vi.fn(async () => null),
		getOperationSupport: vi.fn(() => ({
			willRenameFiles: true,
			didRenameFiles: true,
		})),
		didRenameFiles: vi.fn(async () => undefined),
	};
}

function addClient(
	// biome-ignore lint/suspicious/noExplicitAny: test double, mirrors service-rename-file.test.ts
	service: any,
	serverId: string,
	root: string,
	client: MockRenameClient,
	normalizeMapKey: (path: string) => string,
): void {
	const state = (
		service as unknown as { state: { clients: Map<string, unknown> } }
	).state;
	state.clients.set(`${serverId}:${normalizeMapKey(root)}`, client);
}

describe("LSPService.renameFile with a wedged notify (#1621)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("bounds a wedged closeDocument notify, recording it as timedOut instead of hanging the rename", async () => {
		const mod: LSPServiceModule = await import("../../../clients/lsp/index.js");
		const { normalizeMapKey } = await import("../../../clients/path-utils.js");
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-wedged-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		const client = makeClient(tmpDir);
		client.isDocumentOpen.mockReturnValue(true);
		// A wedged pipe wedges every write on it, not just the first one: the
		// didClose notify AND the resync `notify.open` that runs after it both
		// go out over the same stdin. A double that only wedges closeDocument
		// while leaving notify.open healthy is not production-faithful (F1 —
		// the abort path's reopen is the identical unbounded-notify primitive
		// one write later), so both are wedged here.
		client.closeDocument.mockImplementation(() => new Promise<void>(() => {}));
		client.notify.open.mockImplementation(() => new Promise<void>(() => {}));

		const service = new mod.LSPService();
		addClient(service, "typescript", tmpDir, client, normalizeMapKey);

		try {
			let settled = false;
			const renamePromise = service
				.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true })
				.catch((err: unknown) => err)
				.then((result: unknown) => {
					settled = true;
					return result;
				});

			// Well inside vitest's default per-test timeout, but comfortably
			// beyond even TWO sequential 80ms notify budgets (close, then resync).
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(settled, "renameFile must settle within its notify budget").toBe(
				true,
			);

			const result = await renamePromise;
			expect(result).toBeInstanceOf(Error);
			const message = (result as Error).message;
			expect(message).toMatch(/didClose failed; rename aborted/);
			// The disposition must distinguish "timed out" from "rejected" — not
			// collapse to a generic failure string.
			expect(message).toMatch(/typescript \(timedOut\)/);
			// The wedged resync must also be bounded and its own disposition
			// recorded, not silently swallowed or left to hang the abort path.
			expect(message).toMatch(/resync also failed.*typescript \(timedOut\)/);
		} finally {
			removeTempDirSync(tmpDir);
		}
	}, 5_000);

	it("bounds a wedged didRenameFiles notify, applying the rename and recording the stall instead of hanging", async () => {
		const mod: LSPServiceModule = await import("../../../clients/lsp/index.js");
		const { normalizeMapKey } = await import("../../../clients/path-utils.js");
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-wedged-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		const client = makeClient(tmpDir);
		// The wedged write: never resolves, never rejects.
		client.didRenameFiles.mockImplementation(() => new Promise<void>(() => {}));

		const service = new mod.LSPService();
		addClient(service, "typescript", tmpDir, client, normalizeMapKey);

		try {
			let settled = false;
			const renamePromise = service
				.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true })
				.then((result: unknown) => {
					settled = true;
					return result;
				});

			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(settled, "renameFile must settle within its notify budget").toBe(
				true,
			);

			const result = (await renamePromise) as {
				applied: boolean;
				didRenameFailures: Array<{
					serverId: string;
					error: string;
					disposition: string;
				}>;
			};
			// Rename propagation is best-effort advice, not a correctness gate: a
			// wedged didRenameFiles notify must not block the rename itself.
			expect(result.applied).toBe(true);
			expect(fs.existsSync(newPath)).toBe(true);
			expect(result.didRenameFailures).toEqual([
				expect.objectContaining({
					serverId: "typescript",
					disposition: "timedOut",
				}),
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	}, 5_000);
});
