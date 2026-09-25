/**
 * #1846: `LSPService.getOperationSupport(undefined)` describes the whole
 * workspace, so it must OR each capability across the clients that
 * `selectWorkspaceScopeClient` would route the operation to. Reporting one
 * client's capabilities let an incapable client spawned first hide a capable
 * client spawned later: `tools/lsp-navigation.ts`'s workspaceSymbol gate read
 * that snapshot and threw `__UNSUPPORTED__` before `LSPService.workspaceSymbol`
 * — which #1812 taught to find the supporting client — was ever reached.
 *
 * Aggregation must not widen past that routing. A capability only counts when
 * a LIVE client advertises it, because a dead client cannot answer the
 * request either.
 */

import { describe, expect, it, vi } from "vitest";
import type { LSPOperationSupport } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";

const NO_SUPPORT: LSPOperationSupport = {
	definition: false,
	typeDefinition: false,
	declaration: false,
	references: false,
	hover: false,
	signatureHelp: false,
	documentSymbol: false,
	workspaceSymbol: false,
	codeAction: false,
	codeActionResolve: false,
	rename: false,
	willRenameFiles: false,
	didRenameFiles: false,
	implementation: false,
	callHierarchy: false,
};

function makeFakeClient(support: Partial<LSPOperationSupport>, alive = true) {
	return {
		isAlive: () => alive,
		getOperationSupport: () => ({ ...NO_SUPPORT, ...support }),
		workspaceSymbol: vi.fn(async () => [{ name: "greet", kind: 12 }]),
	};
}

function injectClient(svc: LSPService, key: string, client: unknown) {
	(
		svc as unknown as { state: { clients: Map<string, unknown> } }
	).state.clients.set(key, client);
}

describe("LSPService.getOperationSupport workspace aggregation (#1846)", () => {
	it("ORs each capability across multiple live primary clients", async () => {
		const svc = new LSPService();
		// `json` is spawned first and never advertises workspaceSymbolProvider.
		const json = makeFakeClient({ documentSymbol: true });
		const typescript = makeFakeClient({ workspaceSymbol: true });
		injectClient(svc, "json:C:/repo", json);
		injectClient(svc, "typescript:C:/repo", typescript);

		const support = await svc.getOperationSupport(undefined);

		expect(support).toMatchObject({
			documentSymbol: true,
			workspaceSymbol: true,
			rename: false,
		});

		// The capability the snapshot now reports is the one #1812's selection
		// actually reaches, so probe and call agree.
		const symbols = await svc.workspaceSymbol("greet");
		expect(json.workspaceSymbol).not.toHaveBeenCalled();
		expect(typescript.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(symbols).toEqual([{ name: "greet", kind: 12 }]);
	});

	it("ignores a dead client's capabilities", async () => {
		const svc = new LSPService();
		const deadTypescript = makeFakeClient({ workspaceSymbol: true }, false);
		const liveJson = makeFakeClient({ documentSymbol: true });
		injectClient(svc, "typescript:C:/repo", deadTypescript);
		injectClient(svc, "json:C:/repo", liveJson);

		const support = await svc.getOperationSupport(undefined);

		expect(support).toMatchObject({
			documentSymbol: true,
			workspaceSymbol: false,
		});
	});

	it("aggregates across a client that exposes no capability getter", async () => {
		const svc = new LSPService();
		injectClient(svc, "astgrep:C:/repo", { isAlive: () => true });
		injectClient(svc, "typescript:C:/repo", makeFakeClient({ rename: true }));

		const support = await svc.getOperationSupport(undefined);

		expect(support).toMatchObject({ rename: true, workspaceSymbol: false });
	});

	it("returns the single client's snapshot unchanged", async () => {
		const svc = new LSPService();
		const only = makeFakeClient({ hover: true, definition: true });
		injectClient(svc, "typescript:C:/repo", only);

		expect(await svc.getOperationSupport(undefined)).toEqual(
			only.getOperationSupport(),
		);
	});

	it("returns null when no client is active", async () => {
		const svc = new LSPService();
		expect(await svc.getOperationSupport(undefined)).toBeNull();
	});

	it("leaves the file-scoped snapshot alone", async () => {
		const svc = new LSPService();
		const typescript = makeFakeClient({ workspaceSymbol: true });
		const json = makeFakeClient({ documentSymbol: true });
		injectClient(svc, "json:C:/repo", json);
		injectClient(svc, "typescript:C:/repo", typescript);
		vi.spyOn(
			svc as unknown as {
				getClientForFile: (p: string) => Promise<unknown>;
			},
			"getClientForFile",
		).mockResolvedValue({ client: json });

		// File-scoped stays the routed server's own answer: no aggregation.
		expect(await svc.getOperationSupport("C:/repo/a.json")).toMatchObject({
			documentSymbol: true,
			workspaceSymbol: false,
		});
	});
});
