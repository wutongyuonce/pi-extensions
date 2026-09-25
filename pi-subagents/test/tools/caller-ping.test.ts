import { mock } from "node:test";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	rmSync,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";
describe("caller_ping loop guard", () => {
	function registerPingToolForLoopGuard() {
		const tools2 = new Map<string, any>();
		// Arrays, not last-write-wins: the extension registers several handlers
		// per event, and firing only the last one can pass a test vacuously.
		const handlers = new Map<string, any[]>();
		const commands = new Map<string, any>();
		subagentDoneExtension({
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
			registerTool(definition: { name: string }) {
				tools2.set(definition.name, definition);
				return definition;
			},
			on(event: string, handler: any) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerShortcut() {},
			registerCommand(name: string, definition: any) {
				commands.set(name, definition);
			},
		} as any);
		return { pingTool: tools2.get("caller_ping"), handlers, commands };
	}

	it("rejects caller_ping outside a subagent session and falls back to the default name", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { pingTool } = registerPingToolForLoopGuard();
		const { sessionFile, restore } = setupLoopGuardSession();
		const originalName = process.env.PI_SUBAGENT_NAME;
		try {
			delete process.env.PI_SUBAGENT_SESSION;
			await assert.rejects(
				pingTool.execute("t1", { message: "no session" }, undefined, undefined, { shutdown() {} }),
				/subagent contexts/,
			);

			process.env.PI_SUBAGENT_SESSION = sessionFile;
			delete process.env.PI_SUBAGENT_NAME;
			await pingTool.execute("t2", { message: "nameless" }, undefined, undefined, { shutdown() {} });
			assert.equal(JSON.parse(readFileSync(sessionFile + ".exit", "utf8")).name, "subagent");
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			if (originalName == null) delete process.env.PI_SUBAGENT_NAME;
			else process.env.PI_SUBAGENT_NAME = originalName;
			restore();
		}
	});

	function setupLoopGuardSession() {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, "");
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		const originalName = process.env.PI_SUBAGENT_NAME;
		const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_NAME = "Loop Guard Child";
		// The takeover machinery (input handler, disableAutoExitByOperator) only
		// registers under auto-exit, matching real auto-exit children.
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		return {
			sessionFile,
			restore() {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalName == null) delete process.env.PI_SUBAGENT_NAME;
				else process.env.PI_SUBAGENT_NAME = originalName;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				rmSync(dir, { recursive: true, force: true });
			},
		};
	}

	it("arms a one-shot forced exit after the first durable ping", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { pingTool } = registerPingToolForLoopGuard();
		const { sessionFile, restore } = setupLoopGuardSession();
		try {
			const result = await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, {
				shutdown() {},
			});
			assert.match(String((result as any).content?.[0]?.text ?? ""), /Ping sent/);
			assert.equal(JSON.parse(readFileSync(sessionFile + ".exit", "utf8")).type, "ping");
			assert.equal(exitMock.mock.callCount(), 0);
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 1);
			assert.equal(exitMock.mock.calls[0].arguments[0], 0);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("one-shots by attempts: a refused first ping still blocks the second", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { pingTool } = registerPingToolForLoopGuard();
		const { sessionFile, restore } = setupLoopGuardSession();
		try {
			writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done", outputTokens: 9 }));
			const refused = await pingTool.execute("t1", { message: "tri-state" }, undefined, undefined, {
				shutdown() {},
			});
			assert.match(String((refused as any).content?.[0]?.text ?? ""), /already recorded/);
			await assert.rejects(
				pingTool.execute("t2", { message: "tri-state" }, undefined, undefined, { shutdown() {} }),
				/caller_ping/,
			);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("throws on repeat pings and never stacks exit timers", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { pingTool } = registerPingToolForLoopGuard();
		const { restore } = setupLoopGuardSession();
		try {
			await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, { shutdown() {} });
			await assert.rejects(
				pingTool.execute("t2", { message: "placeholder" }, undefined, undefined, { shutdown() {} }),
				/caller_ping/,
			);
			await assert.rejects(
				pingTool.execute("t3", { message: "placeholder" }, undefined, undefined, { shutdown() {} }),
				/caller_ping/,
			);
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 1);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("arms the exit for an already-owned outcome but never claims the ping was sent", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { pingTool } = registerPingToolForLoopGuard();
		const { sessionFile, restore } = setupLoopGuardSession();
		try {
			writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done", outputTokens: 3 }));
			const result = await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, {
				shutdown() {},
			});
			const text = String((result as any).content?.[0]?.text ?? "");
			assert.match(text, /already recorded/);
			assert.doesNotMatch(text, /Ping sent/);
			assert.equal(JSON.parse(readFileSync(sessionFile + ".exit", "utf8")).type, "done");
			mock.timers.tick(751);
			// The done sidecar is durable, so the backstop must still enforce
			// delivery: the parent only consumes outcomes on process exit.
			assert.equal(exitMock.mock.callCount(), 1);
			assert.equal(exitMock.mock.calls[0].arguments[0], 0);
			await assert.rejects(
				pingTool.execute("t2", { message: "placeholder" }, undefined, undefined, { shutdown() {} }),
				/caller_ping/,
			);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("cancels the forced exit when the operator takes over after arming", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { restore } = setupLoopGuardSession();
		// The takeover handlers only register under auto-exit, so the env must be
		// in place before the extension factory runs.
		const { pingTool, handlers } = registerPingToolForLoopGuard();
		try {
			await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, { shutdown() {} });
			for (const handler of handlers.get("agent_start") ?? []) handler();
			for (const handler of handlers.get("input") ?? []) handler({}, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 0);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("keeps the exit cancelled on a second takeover input and never re-arms without a durable ping", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { restore } = setupLoopGuardSession();
		const { pingTool, handlers, commands } = registerPingToolForLoopGuard();
		try {
			await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, { shutdown() {} });
			for (const handler of handlers.get("agent_start") ?? []) handler();
			for (const handler of handlers.get("input") ?? []) handler({}, { ui: { setStatus() {}, notify() {} } });
			// A second operator input hits the already-disabled early return.
			for (const handler of handlers.get("input") ?? []) handler({}, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 0);

			// /auto-exit after a takeover that never armed a ping must not arm one.
			const autoExitCommand = commands.get("auto-exit");
			assert.ok(autoExitCommand);
			await autoExitCommand.handler(undefined, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 1);

			// Fresh child: takeover without any ping, then /auto-exit. No
			// durable outcome exists, so the re-arm gate must stay closed.
			const fresh = registerPingToolForLoopGuard();
			for (const handler of fresh.handlers.get("agent_start") ?? []) handler();
			for (const handler of fresh.handlers.get("input") ?? []) handler({}, { ui: { setStatus() {}, notify() {} } });
			const freshCommand = fresh.commands.get("auto-exit");
			assert.ok(freshCommand);
			await freshCommand.handler(undefined, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 1);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("re-arms the forced exit when /auto-exit re-enables autonomous closing", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { restore } = setupLoopGuardSession();
		const { pingTool, handlers, commands } = registerPingToolForLoopGuard();
		try {
			await pingTool.execute("t1", { message: "placeholder" }, undefined, undefined, { shutdown() {} });
			for (const handler of handlers.get("agent_start") ?? []) handler();
			for (const handler of handlers.get("input") ?? []) handler({}, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 0);
			const autoExitCommand = commands.get("auto-exit");
			assert.ok(autoExitCommand);
			await autoExitCommand.handler(undefined, { ui: { setStatus() {}, notify() {} } });
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 1);
			assert.equal(exitMock.mock.calls[0].arguments[0], 0);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});

	it("notifies and does nothing when /auto-exit runs while already enabled", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const exitMock = mock.method(process, "exit", (() => {}) as never);
		const { restore } = setupLoopGuardSession();
		const { commands } = registerPingToolForLoopGuard();
		try {
			const notifications: string[] = [];
			const autoExitCommand = commands.get("auto-exit");
			assert.ok(autoExitCommand);
			await autoExitCommand.handler(undefined, {
				ui: { setStatus() {}, notify(message: string) { notifications.push(message); } },
			});
			assert.deepEqual(notifications, ["Auto-exit is already enabled."]);
			mock.timers.tick(751);
			assert.equal(exitMock.mock.callCount(), 0);
		} finally {
			exitMock.mock.restore();
			mock.timers.reset();
			restore();
		}
	});
});
