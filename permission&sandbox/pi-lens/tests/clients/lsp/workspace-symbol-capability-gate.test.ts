/**
 * #1789: `LSPService.workspaceSymbol` must not send `workspace/symbol` to a
 * server that never advertised `workspaceSymbolProvider` in its initialize
 * result. Without a `filePath`, the target is `this.state.clients`' first
 * entry by insertion order — every spawned client, auxiliary scanners
 * (ast-grep, opengrep, zizmor, ...) included, not just primary language
 * servers. A workspace whose only spawned client (yet) is an auxiliary sent
 * every workspace-wide symbol query to it, wasting a round trip per call
 * (dogfood: 2026-08-20, ast-grep). The gate reuses the same single source of
 * truth `lsp-document-symbols.ts`'s documentSymbol gate reads —
 * `client.getOperationSupport().<key>`, populated from the initialize
 * result's `capabilities` (clients/lsp/client.ts `detectOperationSupport`) —
 * rather than a second, hand-rolled capability check.
 */

import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

function makeFakeClient(supportsWorkspaceSymbol: boolean, alive = true) {
	const workspaceSymbol = vi.fn(async () => [{ name: "greet", kind: 12 }]);
	return {
		workspaceSymbol,
		isAlive: () => alive,
		getOperationSupport: () => ({
			definition: false,
			typeDefinition: false,
			declaration: false,
			references: false,
			hover: false,
			signatureHelp: false,
			documentSymbol: false,
			workspaceSymbol: supportsWorkspaceSymbol,
			codeAction: false,
			codeActionResolve: false,
			rename: false,
			willRenameFiles: false,
			didRenameFiles: false,
			implementation: false,
			callHierarchy: false,
		}),
	};
}

function injectClient(svc: LSPService, key: string, client: unknown) {
	(
		svc as unknown as { state: { clients: Map<string, unknown> } }
	).state.clients.set(key, client);
}

describe("LSPService.workspaceSymbol capability gate (#1789)", () => {
	it("does not call workspaceSymbol on a client that never advertised workspaceSymbolProvider", async () => {
		const auxOnly = makeFakeClient(false);
		const svc = new LSPService();
		// The only spawned client is an auxiliary (e.g. ast-grep) that never
		// advertised workspaceSymbolProvider — this is "the first active
		// client" `workspaceSymbol(query)` resolves to when no path is given.
		injectClient(svc, "ast-grep:root", auxOnly);

		const result = await svc.workspaceSymbol("greet");

		expect(auxOnly.workspaceSymbol).not.toHaveBeenCalled();
		// Caller-visible shape must match what an unsupported/failed request
		// already produced (client.ts's workspaceSymbol maps `result ?? []`
		// to `[]`) — the gate only removes the wasted round trip, not the
		// empty-result contract.
		expect(result).toEqual([]);
	});

	it("still calls workspaceSymbol when the first active client advertises support", async () => {
		const primary = makeFakeClient(true);
		const svc = new LSPService();
		injectClient(svc, "typescript:root", primary);

		const result = await svc.workspaceSymbol("greet");

		expect(primary.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	// F1 (review round): the filePath branch resolves its own target via
	// getClientForFile, independent of the no-filePath "first active client"
	// branch above — a separate guard, at a separate line, with a separate
	// reachable path (openFileBestEffort can spawn a NEW client between the
	// tool layer's own capability read and this service call landing, so the
	// server this branch actually calls is not guaranteed to be the one the
	// caller already checked). Deleting this guard must fail this test even
	// though the no-filePath tests above stay green.
	it("does not call workspaceSymbol on the filePath-resolved client when it lacks support", async () => {
		const resolved = makeFakeClient(false);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.workspaceSymbol("greet", "C:/repo/main.ts");

		expect(resolved.workspaceSymbol).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("still calls workspaceSymbol on the filePath-resolved client when it advertises support", async () => {
		const resolved = makeFakeClient(true);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.workspaceSymbol("greet", "C:/repo/main.ts");

		expect(resolved.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});
});

describe("LSPService.workspaceSymbol supporting-client selection (#1812)", () => {
	// #1812: the no-filePath branch used to stop at `state.clients`' FIRST
	// entry by insertion order even after the #1789 gate — so an auxiliary
	// scanner (ast-grep, opengrep, zizmor, ...) that spawned before the
	// workspace's supporting primary server still won every query with `[]`
	// and zero requests, never trying the primary at all. This pins the fix:
	// the no-filePath branch now keeps scanning past a non-supporting
	// candidate for one that DOES support workspace/symbol.
	it("skips a non-supporting auxiliary spawned first and queries a supporting primary spawned second", async () => {
		const auxOnly = makeFakeClient(false);
		const primary = makeFakeClient(true);
		const svc = new LSPService();
		// Insertion order matters: the auxiliary is the map's first entry.
		injectClient(svc, "ast-grep:root", auxOnly);
		injectClient(svc, "typescript:root", primary);

		const result = await svc.workspaceSymbol("greet");

		expect(auxOnly.workspaceSymbol).not.toHaveBeenCalled();
		expect(primary.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	it("falls back to a supporting auxiliary when no primary supports it", async () => {
		const auxSupporting = makeFakeClient(true);
		const primaryUnsupported = makeFakeClient(false);
		const svc = new LSPService();
		injectClient(svc, "opengrep:root", auxSupporting);
		injectClient(svc, "typescript:root", primaryUnsupported);

		const result = await svc.workspaceSymbol("greet");

		expect(primaryUnsupported.workspaceSymbol).not.toHaveBeenCalled();
		expect(auxSupporting.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	it("returns [] when NO spawned client supports workspace/symbol", async () => {
		const auxOnly = makeFakeClient(false);
		const primaryUnsupported = makeFakeClient(false);
		const svc = new LSPService();
		injectClient(svc, "ast-grep:root", auxOnly);
		injectClient(svc, "typescript:root", primaryUnsupported);

		const result = await svc.workspaceSymbol("greet");

		expect(auxOnly.workspaceSymbol).not.toHaveBeenCalled();
		expect(primaryUnsupported.workspaceSymbol).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	// F1 (review round on #1835): the previous test set never exercised the
	// primary-over-auxiliary PREFERENCE itself — every prior "aux first"
	// fixture had a non-supporting aux, so the predicate alone already
	// skipped it before role ever mattered. Here BOTH the aux (first) and the
	// primary (second) support workspace/symbol: a selector that returns the
	// first predicate match regardless of role would wrongly pick the aux.
	// Deleting the role-preference branch in `selectWorkspaceScopeClient`
	// must fail this test even though every other test in this file stays
	// green.
	it("prefers a supporting primary over a supporting auxiliary spawned first", async () => {
		const auxSupporting = makeFakeClient(true);
		const primarySupporting = makeFakeClient(true);
		const svc = new LSPService();
		// Insertion order: auxiliary first, primary second — both support the
		// query, so only the role preference decides which one gets called.
		injectClient(svc, "ast-grep:root", auxSupporting);
		injectClient(svc, "typescript:root", primarySupporting);

		const result = await svc.workspaceSymbol("greet");

		expect(auxSupporting.workspaceSymbol).not.toHaveBeenCalled();
		expect(primarySupporting.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	// F2 (review round on #1835): `selectWorkspaceScopeClient` must skip a
	// dead client for BOTH the preferred (primary) and fallback (auxiliary)
	// role, mirroring `getCapabilitySnapshots`'s own `isAlive()` filter — a
	// dead primary must never beat a live, answering auxiliary just because
	// role preference ran before liveness was checked.
	it("skips a dead primary and falls through to a live supporting auxiliary", async () => {
		const deadPrimary = makeFakeClient(true, false);
		const liveAux = makeFakeClient(true, true);
		const svc = new LSPService();
		injectClient(svc, "typescript:root", deadPrimary);
		injectClient(svc, "ast-grep:root", liveAux);

		const result = await svc.workspaceSymbol("greet");

		expect(deadPrimary.workspaceSymbol).not.toHaveBeenCalled();
		expect(liveAux.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	it("returns [] when the only supporting client is dead", async () => {
		const deadPrimary = makeFakeClient(true, false);
		const svc = new LSPService();
		injectClient(svc, "typescript:root", deadPrimary);

		const result = await svc.workspaceSymbol("greet");

		expect(deadPrimary.workspaceSymbol).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});
});
