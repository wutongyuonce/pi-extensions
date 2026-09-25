import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { TypeScriptServer } from "../../../clients/lsp/server.js";

const RUN_REAL_TS_DOCUMENT_SYMBOL =
	process.env.PI_LENS_REAL_TS_DOCUMENT_SYMBOL === "1";

function percentile(samples: number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

describe.skipIf(!RUN_REAL_TS_DOCUMENT_SYMBOL)(
	"real TypeScript documentSymbol grounding",
	() => {
		const root = process.cwd();
		const filePath = path.join(root, "clients", "tree-sitter-client.ts");
		let spawned: Awaited<ReturnType<typeof TypeScriptServer.spawn>>;
		let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;

		afterAll(async () => {
			if (client) await client.shutdown().catch(() => {});
			if (spawned) await stopLSP(spawned.process).catch(() => {});
		});

		it("measures the workspace-native TS7 response after opening a real repo file", async () => {
			spawned = await TypeScriptServer.spawn(root, { allowInstall: false });
			expect(spawned?.launchVariant).toBe("native-ts7");
			client = await createLSPClient({
				serverId: TypeScriptServer.id,
				process: spawned!.process,
				root,
				initialization: spawned!.initialization,
				launchVariant: spawned!.launchVariant,
			});

			await client.notify.open(
				filePath,
				fs.readFileSync(filePath, "utf8"),
				"typescript",
			);
			await client.documentSymbol(filePath);

			const samples: number[] = [];
			let symbols = await client.documentSymbol(filePath);
			for (let index = 0; index < 20; index++) {
				const start = performance.now();
				symbols = await client.documentSymbol(filePath);
				samples.push(performance.now() - start);
			}

			const treeSitterClient = symbols.find(
				(symbol) => symbol.name === "TreeSitterClient",
			);
			const method =
				treeSitterClient?.children?.find(
					(symbol) => symbol.name === "reportWasmAbort",
				) ??
				symbols.find(
					(symbol) =>
						symbol.name === "reportWasmAbort" &&
						symbol.containerName === "TreeSitterClient",
				);
			const result = {
				launchVariant: client.getLaunchVariant(),
				p50Ms: percentile(samples, 0.5),
				p95Ms: percentile(samples, 0.95),
				topLevelCount: symbols.length,
				responseShape: treeSitterClient?.children
					? "hierarchical DocumentSymbol[]"
					: symbols.some((symbol) => symbol.location)
						? "flat SymbolInformation[]"
						: "unknown",
				classSymbol: treeSitterClient && {
					name: treeSitterClient.name,
					kind: treeSitterClient.kind,
					containerName: treeSitterClient.containerName,
				},
				methodSymbol: method && {
					name: method.name,
					kind: method.kind,
					containerName: method.containerName,
				},
			};
			console.info(`TS documentSymbol grounding: ${JSON.stringify(result)}`);

			expect(result.launchVariant).toBe("native-ts7");
			expect([
				"hierarchical DocumentSymbol[]",
				"flat SymbolInformation[]",
			]).toContain(result.responseShape);
			expect(result.classSymbol).toMatchObject({
				name: "TreeSitterClient",
				kind: 5,
			});
			expect(result.methodSymbol).toMatchObject({
				name: "reportWasmAbort",
				kind: 6,
			});
		}, 30_000);
	},
);
