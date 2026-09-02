/**
 * #873 item 2 — the dispatch LSP runner against a real stdio JSON-RPC server.
 *
 * The workspace config and process availability are environment setup only:
 * server launch, initialize/open/diagnostic/code-action requests, LSPService
 * collection, runner conversion, and tier mapping all remain production code.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../../clients/lsp/config.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../../clients/lsp/index.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fakeServerPath = path.resolve(
	fixtureDir,
	"../../../fixtures/fake-lsp-server.mjs",
);
const serverAvailable =
	fs.existsSync(process.execPath) && fs.existsSync(fakeServerPath);
const d = serverAvailable ? describe : describe.skip;

if (!serverAvailable) {
	console.warn(
		`[CI LOUD] skipping real LSP runner tests: Node or fake server unavailable ` +
			`(node=${process.execPath}, server=${fakeServerPath})`,
	);
}

d("LSP dispatch runner — real server (#873)", () => {
	let env: RealRunnerEnv;

	beforeAll(async () => {
		env = makeRealRunnerEnv({ kind: "jsts" });
		const configDir = path.join(env.cwd, ".pi-lens");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "lsp.json"),
			JSON.stringify({
				servers: {
					"fake-real-runner": {
						name: "Fake real-runner LSP",
						extensions: [".real-lsp"],
						command: process.execPath,
						args: [fakeServerPath],
					},
				},
			}),
		);
		await initLSPConfig(env.cwd);
	});

	afterAll(async () => {
		await getLSPService().shutdown();
		resetLSPService({ fast: true });
		resetLSPConfigStateForTests();
		env?.cleanup();
	});

	it("maps a genuine server error to a 1-indexed blocking diagnostic", async () => {
		const { ctx } = env.addFile("broken.real-lsp", "greet();\n");

		const result = await lspRunner.run(ctx);
		const diagnostic = result.diagnostics.find(
			(item) => item.rule === "fake-lsp:FAKE1001",
		);

		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(diagnostic).toMatchObject({
			rule: "fake-lsp:FAKE1001",
			severity: "error",
			semantic: "blocking",
			line: 1,
			column: 1,
		});
		expect(getLSPService().getAliveServerIds()).toContain("fake-real-runner");
	}, 30_000);

	it("attaches real quick-fix suggestions to blocking diagnostics", async () => {
		const { ctx } = env.addFile("fixable.real-lsp", "greet();\n");

		const result = await lspRunner.run(ctx);
		const diagnostic = result.diagnostics.find(
			(item) => item.rule === "fake-lsp:FAKE1001",
		);

		expect(diagnostic).toMatchObject({
			fixable: true,
			fixKind: "suggestion",
		});
		expect(diagnostic?.fixSuggestion).toContain("Replace greeting");
	}, 30_000);

	it("reports confirmed clean only after the real server attaches", async () => {
		const { ctx } = env.addFile(
			"clean.real-lsp",
			"// fake-lsp-clean\nconst value = 1;\n",
		);

		const result = await lspRunner.run(ctx);

		expect(getLSPService().getAliveServerIds()).toContain("fake-real-runner");
		expect(result).toMatchObject({
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
			rawOutput: "no-diagnostics",
		});
	}, 30_000);
});
