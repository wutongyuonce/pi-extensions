/**
 * Guards LSPService.getAliveServerIds (#267) — the accessor the status footer
 * uses to render `LSP Active: <names>`. Contract:
 *   - distinct serverIds of currently-alive clients,
 *   - ordered primary (role !== "auxiliary") first, then auxiliary
 *     (cross-cutting scanners like opengrep/ast-grep), stable within each group,
 *   - deduped across roots (one warm server on two roots → one id),
 *   - dead clients excluded.
 * We inject minimal fake clients into the real service so no server is spawned.
 * serverIds must be REAL ids so the role lookup against LSP_SERVERS resolves:
 *   typescript → language (primary); opengrep / ast-grep → auxiliary.
 */

import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

type FakeClient = { serverId: string; isAlive: () => boolean };

function serviceWith(clients: Array<{ key: string } & FakeClient>): LSPService {
	const svc = new LSPService();
	const map = (svc as unknown as { state: { clients: Map<string, unknown> } })
		.state.clients;
	for (const { key, ...client } of clients) map.set(key, client);
	return svc;
}

describe("LSPService.getAliveServerIds (#267)", () => {
	it("orders primaries before auxiliaries regardless of insertion order", () => {
		// Insert an auxiliary FIRST to prove ordering is by role, not map order.
		const svc = serviceWith([
			{ key: "opengrep:/r", serverId: "opengrep", isAlive: () => true },
			{ key: "typescript:/r", serverId: "typescript", isAlive: () => true },
			{ key: "ast-grep:/r", serverId: "ast-grep", isAlive: () => true },
		]);
		// typescript (primary) leads; opengrep/ast-grep follow in insertion order.
		expect(svc.getAliveServerIds()).toEqual([
			"typescript",
			"opengrep",
			"ast-grep",
		]);
	});

	it("dedupes one server warm on two roots to a single id", () => {
		const svc = serviceWith([
			{ key: "typescript:/a", serverId: "typescript", isAlive: () => true },
			{ key: "typescript:/b", serverId: "typescript", isAlive: () => true },
		]);
		expect(svc.getAliveServerIds()).toEqual(["typescript"]);
	});

	it("excludes dead clients (e.g. released by the idle timer)", () => {
		const svc = serviceWith([
			{ key: "typescript:/r", serverId: "typescript", isAlive: () => true },
			{ key: "opengrep:/r", serverId: "opengrep", isAlive: () => false },
		]);
		expect(svc.getAliveServerIds()).toEqual(["typescript"]);
	});

	it("returns an empty array when nothing is alive", () => {
		const svc = serviceWith([
			{ key: "typescript:/r", serverId: "typescript", isAlive: () => false },
		]);
		expect(svc.getAliveServerIds()).toEqual([]);
	});
});
