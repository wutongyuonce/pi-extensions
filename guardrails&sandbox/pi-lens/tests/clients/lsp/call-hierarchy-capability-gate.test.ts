/**
 * #1803: `LSPService.incomingCalls`/`outgoingCalls` must not send
 * `callHierarchy/incomingCalls` or `callHierarchy/outgoingCalls` to a server
 * that never advertised `callHierarchyProvider` in its initialize result.
 * Both methods resolve their target via `getClientForFile(uriToPath(item.uri))`
 * and call straight through — the same "chokepoint resolves the target
 * without a getOperationSupport() check" shape #1789 fixed for
 * `workspaceSymbol` (see workspace-symbol-capability-gate.test.ts). The gate
 * reuses the same single source of truth — `client.getOperationSupport().<key>`,
 * populated from the initialize result's `capabilities` via
 * `detectOperationSupport` in clients/lsp/client.ts (callHierarchy key set at
 * client.ts:5253 from `hasProvider("callHierarchyProvider")`) — rather than a
 * second, hand-rolled capability check.
 */

import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

function makeFakeClient(supportsCallHierarchy: boolean) {
	const incomingCalls = vi.fn(async () => [
		{ from: { name: "caller" }, fromRanges: [] },
	]);
	const outgoingCalls = vi.fn(async () => [
		{ to: { name: "callee" }, fromRanges: [] },
	]);
	return {
		incomingCalls,
		outgoingCalls,
		getOperationSupport: () => ({
			definition: false,
			typeDefinition: false,
			declaration: false,
			references: false,
			hover: false,
			signatureHelp: false,
			documentSymbol: false,
			workspaceSymbol: false,
			codeAction: false,
			rename: false,
			implementation: false,
			callHierarchy: supportsCallHierarchy,
		}),
	};
}

const item = {
	uri: "file:///C:/repo/main.ts",
	name: "greet",
	kind: 12,
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 0 },
	},
	selectionRange: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 0 },
	},
} as unknown as import("../../../clients/lsp/client.js").LSPCallHierarchyItem;

describe("LSPService incomingCalls/outgoingCalls capability gate (#1803)", () => {
	it("does not call incomingCalls on a client that never advertised callHierarchyProvider", async () => {
		const resolved = makeFakeClient(false);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.incomingCalls(item);

		expect(resolved.incomingCalls).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("still calls incomingCalls when the resolved client advertises support", async () => {
		const resolved = makeFakeClient(true);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.incomingCalls(item);

		expect(resolved.incomingCalls).toHaveBeenCalledWith(item);
		expect(result).toEqual([{ from: { name: "caller" }, fromRanges: [] }]);
	});

	it("does not call outgoingCalls on a client that never advertised callHierarchyProvider", async () => {
		const resolved = makeFakeClient(false);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.outgoingCalls(item);

		expect(resolved.outgoingCalls).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("still calls outgoingCalls when the resolved client advertises support", async () => {
		const resolved = makeFakeClient(true);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.outgoingCalls(item);

		expect(resolved.outgoingCalls).toHaveBeenCalledWith(item);
		expect(result).toEqual([{ to: { name: "callee" }, fromRanges: [] }]);
	});
});
