import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { setupTestEnvironment } from "../test-utils.js";

interface PublicationGateHarness {
	state: { clients: Map<string, unknown> };
	resolveServerRoot: () => Promise<string>;
	hasServerPublishedForFileRoot(
		serverId: string,
		filePath: string,
	): Promise<boolean>;
}

/**
 * Production-faithful double: `diagnosticsVersion` is the client-GLOBAL
 * counter (bumped by ANY path's publication); `getDiagnosticsVersionForPath`
 * is the per-path stamp the gate is REQUIRED to read (client.ts:339-352). A
 * double that only carries the global counter can't catch a gate that
 * regresses to reading it — see the sibling-file case below.
 */
function makeFakeClient() {
	const perPath = new Map<string, number>();
	let global = 0;
	return {
		isAlive: () => true,
		get diagnosticsVersion() {
			return global;
		},
		getDiagnosticsVersionForPath(filePath: string) {
			return perPath.get(normalizeMapKey(filePath)) ?? 0;
		},
		publishFor(filePath: string) {
			global += 1;
			perPath.set(normalizeMapKey(filePath), global);
		},
	};
}

describe("auxiliary first-publication gate", () => {
	it("requires a live root client to publish before it supersedes a fallback", async () => {
		const env = setupTestEnvironment("pi-lens-aux-publication-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			const service = new LSPService() as unknown as PublicationGateHarness;
			service.resolveServerRoot = async () => env.tmpDir;
			const client = makeFakeClient();
			service.state.clients.set(
				`ast-grep:${normalizeMapKey(env.tmpDir)}`,
				client,
			);

			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", filePath),
			).toBe(false);

			client.publishFor(filePath);
			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", filePath),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// #2324 F1: the gate must answer per FILE, not per client. A client is
	// shared by every file under its root, so a sibling file's publication
	// bumping the client-global counter must never satisfy the gate for a
	// file this server has not published for — that gap left findings
	// silently lost for the second file (the issue's warm-silence headline).
	it("does not let a sibling file's publication satisfy the gate for an unpublished file", async () => {
		const env = setupTestEnvironment("pi-lens-aux-publication-gate-sibling-");
		try {
			const fileA = path.join(env.tmpDir, "a.ts");
			const fileB = path.join(env.tmpDir, "b.ts");
			fs.writeFileSync(fileA, "const a = 1;\n");
			fs.writeFileSync(fileB, "const b = 2;\n");
			const service = new LSPService() as unknown as PublicationGateHarness;
			service.resolveServerRoot = async () => env.tmpDir;
			const client = makeFakeClient();
			service.state.clients.set(
				`ast-grep:${normalizeMapKey(env.tmpDir)}`,
				client,
			);

			client.publishFor(fileA);

			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", fileA),
			).toBe(true);
			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", fileB),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
