import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { TypeScriptServer } from "../../../clients/lsp/server.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

type RootPolicyHarness = {
	state: {
		clients: Map<string, LSPClientInfo>;
		inFlight: Map<string, Promise<unknown>>;
	};
	resolveServerRoot(
		server: typeof TypeScriptServer,
		filePath: string,
	): Promise<string | undefined>;
};

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	vi.restoreAllMocks();
});

function tempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function write(file: string, content = "{}\n"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("TypeScript config-aware roots (#1412)", () => {
	it("hosts a tsconfig-only project at its config directory", async () => {
		const project = tempProject("pi-lens-tsconfig-only-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "tsconfig.json"));
		const file = path.join(project, "src", "app.ts");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(project);
	});

	it("prefers a nested governing config over the package/tooling root", async () => {
		const project = tempProject("pi-lens-tsconfig-nested-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "package.json"));
		const nested = path.join(project, "packages", "configured");
		write(path.join(nested, "jsconfig.json"));
		const file = path.join(nested, "src", "app.js");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(nested);
	});

	it("keeps a nested config plus package manifest as an independent client root", async () => {
		const project = tempProject("pi-lens-tsconfig-boundary-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "package.json"));
		const nested = path.join(project, "packages", "independent");
		write(path.join(nested, "tsconfig.json"));
		write(path.join(nested, "package.json"));
		const file = path.join(nested, "src", "app.ts");
		write(file, "export {};\n");

		const service = new LSPService() as unknown as RootPolicyHarness;
		service.state.clients.set(`typescript:${normalizeMapKey(project)}`, {
			root: project,
			isAlive: () => true,
		} as unknown as LSPClientInfo);
		await expect(
			service.resolveServerRoot(TypeScriptServer, file),
		).resolves.toBe(nested);
	});

	it("does not cross a nearer package boundary for an ancestor config", async () => {
		const project = tempProject("pi-lens-tsconfig-package-boundary-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "tsconfig.json"));
		const nested = path.join(project, "packages", "independent");
		write(path.join(nested, "package.json"));
		const file = path.join(nested, "src", "app.ts");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(nested);
	});

	it("clamps a governing config above the session cwd", async () => {
		const parent = tempProject("pi-lens-tsconfig-ceiling-");
		write(path.join(parent, "tsconfig.json"));
		const session = path.join(parent, "workspace");
		const file = path.join(session, "src", "app.ts");
		write(file, "export {};\n");
		vi.spyOn(process, "cwd").mockReturnValue(session);

		await expect(TypeScriptServer.root(file)).resolves.toBe(session);
	});

	// Case (a) from the #1412 review's case table: config + manifest in the
	// SAME directory — the overwhelmingly common layout — must resolve
	// identically to before this change (the directory itself, not a nested
	// or ancestor root).
	it("hosts a project at the same directory when config and manifest are colocated (case a)", async () => {
		const project = tempProject("pi-lens-tsconfig-colocated-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "tsconfig.json"));
		write(path.join(project, "package.json"));
		const file = path.join(project, "src", "app.ts");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(project);
	});

	// #1412 M3, case (g): tsserver associates jsconfig.json with JS files only
	// — a .ts file under a jsconfig-only directory must NOT root there. It must
	// keep walking up for a real tsconfig.json.
	it("skips a jsconfig-only directory for a .ts file and roots at the ancestor tsconfig (case g)", async () => {
		const project = tempProject("pi-lens-jsconfig-ts-skip-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "tsconfig.json"));
		const nested = path.join(project, "legacy-js");
		write(path.join(nested, "jsconfig.json"));
		const file = path.join(nested, "src", "app.ts");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(project);
	});

	// The JS-family counterpart: a .js file under the same jsconfig-only
	// directory DOES root there — jsconfig governs JS files.
	it("still roots a .js file at a jsconfig-only directory (case g counterpart)", async () => {
		const project = tempProject("pi-lens-jsconfig-js-accept-");
		vi.spyOn(process, "cwd").mockReturnValue(project);
		write(path.join(project, "tsconfig.json"));
		const nested = path.join(project, "legacy-js");
		write(path.join(nested, "jsconfig.json"));
		const file = path.join(nested, "src", "app.js");
		write(file, "export {};\n");

		await expect(TypeScriptServer.root(file)).resolves.toBe(nested);
	});
});
