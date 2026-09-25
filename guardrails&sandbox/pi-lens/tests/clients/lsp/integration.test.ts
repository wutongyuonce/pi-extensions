/**
 * LSP Integration Tests
 *
 * Tests createLSPClient against a real JSON-RPC fake server over stdio.
 * Validates the full wire protocol: message framing, initialize handshake,
 * request/response round-trips, and shutdown lifecycle.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// SHUTDOWN_REQUEST_TIMEOUT_MS is read at MODULE LOAD in client.ts, so the env
// override must land before the static import below evaluates — vi.hoisted
// runs this ahead of every import in the file. Shrinks the "cold start
// shutdown falls back to process kill" test's real wait for a server that
// never replies to the shutdown request; that fake server's ignore branch
// never replies either way, so there's no race and the assertions are
// magnitude-independent.
vi.hoisted(() => {
	process.env.PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS = "150";
});
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { removeTempDirSync } from "../test-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);

describe("LSP Client Integration", () => {
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;

	beforeEach(async () => {
		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			client = undefined;
		}
		if (proc) {
			try {
				await stopLSP(proc);
			} catch {
				/* ignore */
			}
			proc = undefined;
		}
	});

	it("initializes and reports connected", () => {
		expect(client).toBeDefined();
		expect(client!.isAlive()).toBe(true);
	});

	it("detects operation capabilities from initialize result", () => {
		const support = client!.getOperationSupport();
		expect(support.definition).toBe(true);
		expect(support.references).toBe(true);
		expect(support.hover).toBe(true);
		expect(support.documentSymbol).toBe(true);
		expect(support.workspaceSymbol).toBe(true);
		expect(support.codeAction).toBe(true);
		expect(support.codeActionResolve).toBe(true);
		expect(support.willRenameFiles).toBe(false);
		expect(support.callHierarchy).toBe(false);
	});

	it("detects pull diagnostics support from object provider", () => {
		const ws = client!.getWorkspaceDiagnosticsSupport();
		expect(ws.advertised).toBe(true);
		expect(ws.mode).toBe("pull");
	});

	it("sends didOpen and tracks the document", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		expect(client!.getDiagnostics(filePath)).toEqual([]);
	});

	it("returns document symbols", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "function greet() {}", "typescript");
		const symbols = await client!.documentSymbol(filePath);
		expect(symbols.length).toBeGreaterThanOrEqual(1);
		expect(symbols[0].name).toBe("greet");
		expect(symbols[0].kind).toBe(12); // Function
	});

	it("strips noisy URL lines from pulled diagnostics", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "oops();", "typescript");
		await client!.waitForDiagnostics(filePath, 1000);

		const diagnostics = client!.getDiagnostics(filePath);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("actual diagnostic");
	});

	it("returns hover info", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const message = 'hi';", "typescript");
		const hover = await client!.hover(filePath, 0, 6);
		expect(hover).not.toBeNull();
		expect(hover!.contents).toBeDefined();
	});

	it("returns definition location", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		const locations = await client!.definition(filePath, 0, 6);
		expect(locations.length).toBeGreaterThanOrEqual(1);
		expect(locations[0].range).toBeDefined();
	});

	it("returns references", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(
			filePath,
			"const x = 1; console.log(x);",
			"typescript",
		);
		const refs = await client!.references(filePath, 0, 6);
		expect(refs.length).toBeGreaterThanOrEqual(1);
	});

	it("returns workspace symbols", async () => {
		const symbols = await client!.workspaceSymbol("greet");
		expect(symbols.length).toBeGreaterThanOrEqual(1);
	});

	it("resolves lightweight code actions before returning them", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "greet();", "typescript");
		const actions = await client!.codeAction(filePath, 0, 0, 0, 5);

		expect(actions).toHaveLength(1);
		expect(actions[0].title).toBe("Replace greeting");
		expect(actions[0].edit).toBeDefined();
	});

	it("finds nested symbol via document symbol children", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(
			filePath,
			"function greet() { const message = 'hi'; }",
			"typescript",
		);
		const symbols = await client!.documentSymbol(filePath);
		// Fake server returns 'greet' with a child 'message'
		const greet = symbols.find((s) => s.name === "greet");
		expect(greet).toBeDefined();
		expect(greet!.children?.length).toBeGreaterThanOrEqual(1);
		expect(greet!.children![0].name).toBe("message");
	});

	it("advertises executeCommand commands from initialize", () => {
		expect(client!.getAdvertisedCommands().sort()).toEqual([
			"fake.applyEdit",
			"fake.doThing",
		]);
	});

	it("runs an advertised command via executeCommand", async () => {
		const res = await client!.executeCommand("fake.doThing");
		expect(res.executed).toBe(true);
		expect(res.result).toEqual({ ran: "fake.doThing" });
	});

	it("refuses an unadvertised command without sending it", async () => {
		const res = await client!.executeCommand("evil.command");
		expect(res.executed).toBe(false);
		expect(res.reason).toContain("not advertised");
	});

	it("applies a server-initiated edit solicited during executeCommand", async () => {
		const file = path.join(
			process.cwd(),
			`.lsp-exec-${process.pid}-${Date.now()}.ts`,
		);
		fs.writeFileSync(file, "hello world", "utf-8");
		try {
			const res = await client!.executeCommand("fake.applyEdit", [
				pathToFileURL(file).href,
			]);
			expect(res.executed).toBe(true);
			expect((res.result as { applied?: boolean }).applied).toBe(true);
			// The gate (serverEditsAllowed) was open during the call, so the edit landed.
			expect(fs.readFileSync(file, "utf-8")).toBe("EDITED world");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("shuts down gracefully", async () => {
		expect(client!.isAlive()).toBe(true);
		await client!.shutdown();
		expect(client!.isAlive()).toBe(false);
	});
});

describe("LSP Client Integration — nested capability gates (#1971)", () => {
	const capabilityCases = [
		{ name: "absent", env: {}, supported: false },
		{ name: "false", env: { FAKE_LSP_WILL_RENAME: "false" }, supported: false },
		{
			name: "malformed",
			env: { FAKE_LSP_WILL_RENAME: "malformed" },
			supported: false,
		},
		{
			name: "object without filters",
			env: { FAKE_LSP_WILL_RENAME: "empty-object" },
			supported: false,
		},
		{ name: "present", env: { FAKE_LSP_WILL_RENAME: "true" }, supported: true },
	] as const;

	it.each(capabilityCases)(
		"sends workspace/willRenameFiles only when nested capability is $name",
		async ({ env, supported }) => {
			const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-rename-capability",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const result = await client.willRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				await new Promise((resolve) => setImmediate(resolve));
				expect(client.getOperationSupport().willRenameFiles).toBe(supported);
				expect(result).toBeNull();
				expect(received).toEqual(
					supported ? ["workspace/willRenameFiles"] : [],
				);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		},
	);

	it("sends didRenameFiles only when didRename is registered and filters match", async () => {
		const cases: Array<{
			name: string;
			env: Record<string, string>;
			sent: boolean;
		}> = [
			{
				name: "not registered",
				env: {},
				sent: false,
			},
			{
				name: "registered with matching glob",
				env: { FAKE_LSP_DID_RENAME: "true" },
				sent: true,
			},
			{
				name: "registered but glob excludes the paths",
				env: {
					FAKE_LSP_DID_RENAME: "true",
					FAKE_LSP_DID_RENAME_GLOB: "**/*.go",
				},
				sent: false,
			},
		];

		for (const { name, env, sent } of cases) {
			const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_WILL_RENAME: "true",
					FAKE_LSP_ECHO_NOTIFY_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-did-rename-capability",
				process: proc,
				root: process.cwd(),
			});
			const notified: string[] = [];
			client.connection.onNotification(
				"$/test/notifyReceived",
				(params: { method: string }) => {
					notified.push(params.method);
				},
			);
			try {
				await client.notify.open(
					path.join(process.cwd(), "doc.ts"),
					"greet();",
					"typescript",
				);
				notified.length = 0;
				await client.didRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				// A notification has no awaitable reply, so the echo's stdio
				// round-trip needs several event-loop turns — a single
				// setImmediate yield cannot cover it. Poll until the echo
				// arrives; for the negative cases, give the pipe a bounded
				// grace window before asserting nothing was sent.
				const graceMs = sent ? 5000 : 500;
				for (
					let i = 0;
					i < graceMs / 25 && !notified.includes("workspace/didRenameFiles");
					i++
				) {
					await new Promise((r) => setTimeout(r, 25));
				}
				// Support reflects REGISTRATION at initialize time (a static
				// capability fact); the per-path FILTER decision happens at
				// send time, so the glob case suppresses the send without
				// un-advertising support.
				expect(client.getOperationSupport().didRenameFiles, name).toBe(
					env.FAKE_LSP_DID_RENAME === "true",
				);
				expect(notified.includes("workspace/didRenameFiles"), name).toBe(sent);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		}
	}, 20_000); // so a regression fails on an ASSERTION, not this timeout. // Three real server launches plus a bounded echo round-trip; generous

	it("applies willRename filter matching before sending the preflight request", async () => {
		const cases = [
			{ glob: undefined as string | undefined, sent: true },
			{ glob: "**/*.ts", sent: true },
			{ glob: "**/*.go", sent: false },
		] as const;

		for (const { glob, sent } of cases) {
			const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
				cwd: process.cwd(),
				env: {
					...process.env,
					FAKE_LSP_WILL_RENAME: "true",
					...(glob ? { FAKE_LSP_WILL_RENAME_GLOB: glob } : {}),
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-will-rename-filter",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const result = await client.willRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				// Same bounded-poll rationale as the didRename matrix above: the
				// echo notification rides the stdio round-trip and can land after
				// one event-loop turn under load.
				const graceMs = sent ? 5000 : 500;
				for (
					let i = 0;
					i < graceMs / 25 && !received.includes("workspace/willRenameFiles");
					i++
				) {
					await new Promise((r) => setTimeout(r, 25));
				}
				expect(result, `glob=${glob ?? "default"}`).toBeNull();
				expect(
					received.includes("workspace/willRenameFiles"),
					`glob=${glob ?? "default"}`,
				).toBe(sent);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		}
	}, 20_000);

	it("honors complete file-operation filters on the protocol wire", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lsp-rename-filter-"),
		);
		const oldFile = path.join(tempRoot, "OLD.TS");
		const newFile = path.join(tempRoot, "NEW.TS");
		const oldFolder = path.join(tempRoot, "old-folder");
		const newFolder = path.join(tempRoot, "new-folder");
		const nestedDir = path.join(tempRoot, "a", "b");
		const nestedOldFile = path.join(nestedDir, "old.ts");
		const nestedNewFile = path.join(nestedDir, "new.ts");
		fs.writeFileSync(oldFile, "export {};\n");
		fs.mkdirSync(oldFolder);
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(nestedOldFile, "export {};\n");

		const filter = (
			glob: unknown,
			extra: Record<string, unknown> = {},
		): Record<string, unknown> => ({
			scheme: "file",
			pattern: { glob, ...extra },
		});
		const cases: Array<{
			name: string;
			filters: unknown;
			oldPath?: string;
			newPath?: string;
			oldUri?: string;
			newUri?: string;
			sent: boolean;
			registered?: boolean;
		}> = [
			{
				name: "mixed filters match when one complete filter matches",
				filters: [
					filter("**/*.go"),
					filter("**/*.ts", { options: { ignoreCase: true } }),
				],
				sent: true,
			},
			{
				name: "ignoreCase defaults to false independent of host",
				filters: [filter("**/*.ts")],
				sent: false,
			},
			{
				name: "basename does not widen a nested path glob",
				filters: [filter("*.ts")],
				oldPath: nestedOldFile,
				newPath: nestedNewFile,
				sent: false,
			},
			{
				name: "folder kind matches a probed folder",
				filters: [filter("**/old-folder", { matches: "folder" })],
				oldPath: oldFolder,
				newPath: newFolder,
				sent: true,
			},
			{
				name: "file kind rejects a probed folder",
				filters: [filter("**/old-folder", { matches: "file" })],
				oldPath: oldFolder,
				newPath: newFolder,
				sent: false,
			},
			{
				name: "unsupported URI scheme fails closed",
				filters: [{ scheme: "untitled", pattern: { glob: "**/*.ts" } }],
				oldUri: "untitled:///OLD.TS",
				newUri: "untitled:///NEW.TS",
				sent: false,
			},
			{
				name: "unsupported wire URI scheme fails closed without filter scheme",
				filters: [{ pattern: { glob: "**/*.ts" } }],
				oldUri: "vscode-vfs://host/old.ts",
				newUri: "vscode-vfs://host/new.ts",
				sent: false,
			},
			{
				name: "omitted scheme matches a supported file URI",
				filters: [{ pattern: { glob: "**/*.TS" } }],
				sent: true,
			},
			{
				name: "empty scheme is malformed",
				filters: [{ scheme: "", pattern: { glob: "**/*.TS" } }],
				sent: false,
				registered: false,
			},
			{
				name: "invalid matches value is malformed",
				filters: [filter("**/*.TS", { matches: "document" })],
				sent: false,
				registered: false,
			},
			{
				name: "invalid options are malformed",
				filters: [filter("**/*.TS", { options: { ignoreCase: "yes" } })],
				sent: false,
				registered: false,
			},
		];
		let symlinkPaths: { oldPath: string; newPath: string } | undefined;
		try {
			const oldLink = path.join(tempRoot, "old-link");
			const newLink = path.join(tempRoot, "new-link");
			fs.symlinkSync(oldFolder, oldLink, "junction");
			symlinkPaths = { oldPath: oldLink, newPath: newLink };
		} catch {
			// Symlink-specific coverage is omitted when the platform denies creation;
			// the non-symlink protocol matrix still runs below.
		}
		if (symlinkPaths) {
			cases.push({
				name: "matches file treats a directory symlink as the renamed entity",
				filters: [filter("**/old-link", { matches: "file" })],
				...symlinkPaths,
				sent: true,
			});
		}

		try {
			for (const operation of ["will", "did"] as const) {
				for (const testCase of cases) {
					const envKey =
						operation === "will"
							? "FAKE_LSP_WILL_RENAME_FILTERS"
							: "FAKE_LSP_DID_RENAME_FILTERS";
					const launched = await launchLSP(
						process.execPath,
						[FAKE_SERVER_PATH],
						{
							cwd: tempRoot,
							env: {
								...process.env,
								FAKE_LSP_WILL_RENAME: "true",
								FAKE_LSP_DID_RENAME: "true",
								[envKey]: JSON.stringify(testCase.filters),
								...(operation === "will"
									? { FAKE_LSP_ECHO_REQUEST_METHODS: "1" }
									: { FAKE_LSP_ECHO_NOTIFY_METHODS: "1" }),
							},
						},
					);
					const filteredClient = await createLSPClient({
						serverId: `fake-${operation}-${testCase.name}`,
						process: launched,
						root: tempRoot,
					});
					const received: string[] = [];
					filteredClient.connection.onNotification(
						operation === "will"
							? "$/test/requestReceived"
							: "$/test/notifyReceived",
						(params: { method: string }) => {
							received.push(params.method);
						},
					);
					try {
						expect(
							filteredClient.getOperationSupport()[
								operation === "will" ? "willRenameFiles" : "didRenameFiles"
							],
							`${operation}: ${testCase.name} registration`,
						).toBe(testCase.registered ?? true);
						const oldPath = testCase.oldPath ?? oldFile;
						const newPath = testCase.newPath ?? newFile;
						if (operation === "will") {
							await filteredClient.willRenameFiles(oldPath, newPath);
						} else {
							await filteredClient.didRenameFiles(
								oldPath,
								newPath,
								testCase.oldUri,
								testCase.newUri,
							);
						}
						const method = `workspace/${operation}RenameFiles`;
						const graceMs = testCase.sent ? 5000 : 300;
						for (
							let i = 0;
							i < graceMs / 25 && !received.includes(method);
							i++
						) {
							await new Promise((resolve) => setTimeout(resolve, 25));
						}
						expect(
							received.includes(method),
							`${operation}: ${testCase.name}`,
						).toBe(testCase.sent);
					} finally {
						await filteredClient.shutdown();
						await stopLSP(launched);
					}
				}
			}
		} finally {
			removeTempDirSync(tempRoot);
		}
	}, 60_000);

	const resolveCases = [
		{
			name: "absent",
			env: { FAKE_LSP_NO_CODE_ACTION_RESOLVE: "1" },
			supported: false,
		},
		{
			name: "false",
			env: { FAKE_LSP_CODE_ACTION_PROVIDER: "false" },
			supported: false,
		},
		{
			name: "malformed",
			env: { FAKE_LSP_CODE_ACTION_PROVIDER: "malformed" },
			supported: false,
		},
		{ name: "present", env: {}, supported: true },
	] as const;

	it.each(resolveCases)(
		"sends codeAction/resolve only when resolveProvider is $name",
		async ({ env, supported }) => {
			const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-code-action-capability",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const filePath = path.join(process.cwd(), "resolve.ts");
				await client.notify.open(filePath, "greet();", "typescript");
				const actions = await client.codeAction(filePath, 0, 0, 0, 5);
				await new Promise((resolve) => setImmediate(resolve));
				expect(client.getOperationSupport().codeActionResolve).toBe(supported);
				if (supported) expect(actions[0]?.edit).toBeDefined();
				else expect(actions[0]?.edit).toBeUndefined();
				expect(received).toEqual(
					supported
						? ["textDocument/codeAction", "codeAction/resolve"]
						: ["textDocument/codeAction"],
				);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		},
	);
});

describe("LSP Client Integration — cold start", () => {
	it("rejects when fake server exits immediately", async () => {
		// Pass invalid args to make the process crash on startup
		await expect(
			launchLSP(process.execPath, ["--nonexistent-flag"], {
				cwd: process.cwd(),
			}),
		).rejects.toThrow();
	});

	it("shutdown falls back to process kill when server ignores shutdown", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_IGNORE_SHUTDOWN: "1" },
		});
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(client.isAlive()).toBe(false);
	});
});

describe("LSP Client Integration — UTF-8 position encoding (#269)", () => {
	const prevEnv = process.env.FAKE_LSP_POSITION_ENCODING;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let tmpDir: string;
	let filePath: string;
	// 'value' begins at UTF-16 char 13 but UTF-8 byte 14 (é is 2 bytes).
	const SRC = "const café = value;\n";

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-posenc-"));
		filePath = path.join(tmpDir, "a.ts");
		fs.writeFileSync(filePath, SRC); // toWirePosition reads the line from disk
		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_POSITION_ENCODING: "utf-8" },
		});
		client = await createLSPClient({
			serverId: "fake-utf8",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		removeTempDirSync(tmpDir);
		if (prevEnv === undefined) delete process.env.FAKE_LSP_POSITION_ENCODING;
		else process.env.FAKE_LSP_POSITION_ENCODING = prevEnv;
	});

	it("sends a UTF-8 byte offset (not the raw UTF-16 offset) when the server negotiates utf-8", async () => {
		await client!.notify.open(filePath, SRC, "typescript");
		// 'value' is at UTF-16 char 13; the fake echoes back the position it received.
		const locations = await client!.definition(filePath, 0, 13);
		expect(locations.length).toBeGreaterThanOrEqual(1);
		const sentChar = locations[0].range.start.character;
		// The é before the offset costs one extra UTF-8 byte, so 13 → 14.
		expect(sentChar).toBe(Buffer.byteLength("const café = ", "utf8"));
		expect(sentChar).toBe(14);
		expect(sentChar).toBeGreaterThan(13);
	});
});

describe("LSP Client Integration — stale navigation drop (#276)", () => {
	const prevDelay = process.env.FAKE_LSP_DEFINITION_DELAY_MS;
	const prevFlag = process.env.PI_LENS_LSP_NAV_STALE_DROP;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let filePath: string;
	// Let the in-flight request's version get captured before we bump it. The
	// nav method yields at `await toWirePosition` before navRequest reads the
	// version, so a change issued too eagerly would be seen as the request's own
	// version. This gap (≪ the reply delay) makes the ordering deterministic.
	const settle = () => new Promise((r) => setTimeout(r, 40));

	beforeEach(async () => {
		filePath = path.join(process.cwd(), "stale-nav.ts");
		// The fake holds its definition reply for 300ms so we can land a
		// notify.change (which bumps the client's documentVersions) mid-request.
		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_DEFINITION_DELAY_MS: "300" },
		});
		client = await createLSPClient({
			serverId: "fake-stale",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		if (prevDelay === undefined)
			delete process.env.FAKE_LSP_DEFINITION_DELAY_MS;
		else process.env.FAKE_LSP_DEFINITION_DELAY_MS = prevDelay;
		if (prevFlag === undefined) delete process.env.PI_LENS_LSP_NAV_STALE_DROP;
		else process.env.PI_LENS_LSP_NAV_STALE_DROP = prevFlag;
	});

	it("drops a nav result when the document is edited mid-request", async () => {
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		// Fire the (delayed) request, let it send, then bump the version before
		// it replies.
		const pending = client!.definition(filePath, 0, 6);
		await settle();
		await client!.notify.change(filePath, "const x = 2;\nconst y = 3;");
		const locations = await pending;
		// The in-flight result referred to the pre-edit document → dropped.
		expect(locations).toEqual([]);
	});

	it("returns a nav result when the document is not edited mid-request", async () => {
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		// Same delay, but no edit lands → result is returned unchanged.
		const locations = await client!.definition(filePath, 0, 6);
		expect(locations.length).toBeGreaterThanOrEqual(1);
	});

	it("returns the stale result when the drop is disabled via env", async () => {
		process.env.PI_LENS_LSP_NAV_STALE_DROP = "0";
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		const pending = client!.definition(filePath, 0, 6);
		await settle();
		await client!.notify.change(filePath, "const x = 2;\nconst y = 3;");
		const locations = await pending;
		// Kill-switch off → the (now-stale) result is still returned.
		expect(locations.length).toBeGreaterThanOrEqual(1);
	});
});

describe("LSP Client Integration — batched watched-files (#271)", () => {
	const prev = process.env.FAKE_LSP_ECHO_WATCHED_FILES;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	// Frames the fake SERVER actually received over the wire (one entry = one
	// didChangeWatchedFiles notification), echoed back via $/test/watchedFilesReceived.
	let received: Array<Array<{ uri: string; type: number }>> = [];

	beforeEach(async () => {
		received = [];
		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_ECHO_WATCHED_FILES: "1" },
		});
		client = await createLSPClient({
			serverId: "fake-watch",
			process: proc,
			root: process.cwd(),
		});
		client.connection.onNotification(
			"$/test/watchedFilesReceived",
			(params: { changes: Array<{ uri: string; type: number }> }) => {
				received.push(params.changes);
			},
		);
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		if (prev === undefined) delete process.env.FAKE_LSP_ECHO_WATCHED_FILES;
		else process.env.FAKE_LSP_ECHO_WATCHED_FILES = prev;
	});

	// Poll until the server has echoed at least one frame (the flush is on a
	// ~100ms debounce + a stdio round-trip), with a generous ceiling.
	const waitForEcho = async () => {
		for (let i = 0; i < 60 && received.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};

	it("coalesces N rapid file opens into ONE wire frame with N changes", async () => {
		const files = ["wf-a.ts", "wf-b.ts", "wf-c.ts"].map((f) =>
			path.join(process.cwd(), f),
		);
		// Open three distinct files within the debounce window.
		for (const f of files) {
			await client!.notify.open(f, "const x = 1;", "typescript");
		}

		await waitForEcho();

		// Exactly one notification reached the server for the whole burst…
		expect(received).toHaveLength(1);
		// …carrying all three URIs (deduped, insertion order).
		expect(received[0]).toHaveLength(3);
		const uris = received[0].map((c) => c.uri);
		for (const f of files) {
			expect(uris).toContain(pathToFileURL(f).href);
		}
	});

	it("does not emit a frame for a silent open (cascade read)", async () => {
		await client!.notify.open(
			path.join(process.cwd(), "wf-silent.ts"),
			"const x = 1;",
			"typescript",
			false,
			true, // silent
		);
		// Wait out the debounce window — nothing should have been enqueued/sent.
		await new Promise((r) => setTimeout(r, 200));
		expect(received).toHaveLength(0);
	});
});
