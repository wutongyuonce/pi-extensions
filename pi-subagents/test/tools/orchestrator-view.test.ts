import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { OrchestratorSnapshot } from "../../src/runtime/orchestrator-controller.ts";
import { readOrchestratorSessionState } from "../../src/session/orchestrator-state.ts";
import type { OverlayRuntime } from "../../src/tools/overlay/index.ts";
import {
	keepOrchestratorSelectionVisible,
	renderOrchestrator,
} from "../../src/tools/overlay/orchestrator-view.ts";
import {
	registerSubagentsView,
	SubagentsOverlay,
} from "../../src/tools/subagents-view.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";

type SnapshotOverrides = Partial<OrchestratorSnapshot>;

const baseSnapshot: OrchestratorSnapshot = {
	currentMode: false,
	savedGlobalDefault: false,
	savedGlobalDefaultSource: "missing",
	effectiveGlobalDefault: false,
	effectiveGlobalDefaultSource: "missing",
	currentActiveTools: ["read", "subagent"],
	normalActiveTools: ["read", "subagent"],
	runningSubagents: 0,
	parentIdle: true,
	hasPendingMessages: false,
	blockedReason: null,
	isChildSession: false,
};

function createRuntime(
	overrides: SnapshotOverrides = {},
	saveGlobalDefaultError?: string,
) {
	let snapshot = { ...baseSnapshot, ...overrides };
	const calls = {
		setMode: [] as boolean[],
		saveGlobalDefault: [] as boolean[],
	};
	const orchestrator = {
		getSnapshot: () => snapshot,
		setMode(enabled: boolean) {
			calls.setMode.push(enabled);
			snapshot = { ...snapshot, currentMode: enabled, blockedReason: null };
			return { ok: true, changed: true, snapshot };
		},
		saveGlobalDefault(enabled: boolean) {
			calls.saveGlobalDefault.push(enabled);
			if (saveGlobalDefaultError) {
				snapshot = { ...snapshot, persistenceError: saveGlobalDefaultError };
				return {
					ok: false,
					changed: false,
					snapshot,
					reason: "persistence-error",
					error: saveGlobalDefaultError,
				};
			}
			snapshot = {
				...snapshot,
				savedGlobalDefault: enabled,
				effectiveGlobalDefault:
					snapshot.effectiveGlobalDefaultSource === "env"
						? snapshot.effectiveGlobalDefault
						: enabled,
			};
			return { ok: true, changed: true, snapshot };
		},
	};
	const runtime = {
		getShellReadyDelayMs: () => 800,
		isMuxAvailable: () => false,
		watchBackgroundSubagent: async () => ({
			name: "",
			task: "",
			summary: "",
			exitCode: 0,
			elapsed: 0,
		}),
		watchSubagent: async () => ({
			name: "",
			task: "",
			summary: "",
			exitCode: 0,
			elapsed: 0,
		}),
		getWatcherSignal: (_running: unknown, controller: AbortController) =>
			controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map(),
		pi: { on() {} },
		wireSubagentSteerBack: () => {},
		orchestrator,
	} as unknown as OverlayRuntime;
	return {
		runtime,
		calls,
		setSnapshot: (next: SnapshotOverrides) =>
			(snapshot = { ...snapshot, ...next }),
	};
}

function createContext() {
	return {
		cwd: "/tmp",
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify() {} },
		sessionManager: { getSessionFile: () => undefined },
	};
}

function createOverlay(
	overrides: SnapshotOverrides = {},
	rows = 18,
	saveGlobalDefaultError?: string,
) {
	const { runtime, calls, setSnapshot } = createRuntime(
		overrides,
		saveGlobalDefaultError,
	);
	let result: unknown;
	const overlay = new SubagentsOverlay(
		(value) => {
			result = value;
		},
		createContext() as unknown as ExtensionContext,
		{
			fg: (_tone, text) => text,
			bg: (_color, text) => "[" + text + "]",
			bold: (text) => text,
		},
		runtime,
		{ requestRender() {}, terminal: { columns: 80, rows } } as TUI,
	);
	return { overlay, calls, setSnapshot, getResult: () => result };
}

function renderText(overlay: SubagentsOverlay, width = 80): string {
	return overlay.render(width).join("\n");
}

function renderBottomViewport(
	overlay: SubagentsOverlay,
	width: number,
	rows: number,
	piFooterRows = 2,
): string {
	const piFooter = Array.from({ length: piFooterRows }, (_, index) =>
		`Pi footer row ${index + 1}`,
	);
	return [...overlay.render(width), ...piFooter].slice(-rows).join("\n");
}

function openOrchestrator(overlay: SubagentsOverlay): void {
	for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[C");
}

describe("orchestrator overlay", () => {
	it("keeps the explicit current mode in the visible tab strip above Pi footers", () => {
		for (const [currentMode, mode] of [
			[false, "Off"],
			[true, "On"],
		] as const) {
			for (const [width, rows] of [
				[42, 24],
				[80, 10],
				[18, 24],
			] as const) {
				const { overlay } = createOverlay({ currentMode }, rows);
				try {
					openOrchestrator(overlay);
					const visible = renderBottomViewport(overlay, width, rows);
					const tabLabel = width === 18 ? `Orch. ${mode}` : `Orchestrator: ${mode}`;
					assert.ok(visible.includes(tabLabel), visible);
				} finally {
					overlay.dispose();
				}
			}
		}
	});

	it("adds Orchestrator after the existing tabs and renders the current session state", () => {
		const { overlay } = createOverlay();
		try {
			openOrchestrator(overlay);
			const text = renderText(overlay);
			assert.match(text, /Orchestrator/);
			assert.match(text, /Current session: Off/);
			assert.match(text, /Enable in this session/);
			assert.match(text, /Start a fresh orchestrator session/);
			assert.match(text, /keeps conversation\/context/);
			assert.match(
				text,
				/Fresh: empty conversation; old session remains available via \/resume/,
			);
			assert.match(text, /delegate-only/i);
		} finally {
			overlay.dispose();
		}
	});

	it("renders on-state actions and global saved/effective values", () => {
		const { overlay } = createOverlay(
			{
				currentMode: true,
				savedGlobalDefault: true,
				savedGlobalDefaultSource: "saved",
				effectiveGlobalDefault: false,
				effectiveGlobalDefaultSource: "env",
			},
			24,
		);
		try {
			openOrchestrator(overlay);
			const text = renderText(overlay);
			assert.match(text, /Current session: On/);
			assert.match(text, /Disable in this session/);
			assert.match(text, /Start a fresh normal session/);
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\x1b[B");
			const defaultText = renderText(overlay);
			assert.match(defaultText, /Global preference/);
			assert.match(defaultText, /Default for new sessions: On/);
			assert.match(defaultText, /saved: On/);
			assert.match(defaultText, /effective: Off/);
			assert.match(defaultText, /PI_ORCHESTRATOR_MODE override/);
		} finally {
			overlay.dispose();
		}
	});

	it("keeps global default editing available while session changes are blocked", () => {
		const { overlay, calls } = createOverlay({
			blockedReason: "running-subagents",
			runningSubagents: 2,
		});
		try {
			openOrchestrator(overlay);
			const before = renderText(overlay);
			assert.match(before, /wait.*stop|stop.*wait/i);
			overlay.handleInput("\r");
			assert.deepEqual(calls.setMode, []);

			overlay.handleInput("\x1b[B");
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\r");
			assert.deepEqual(calls.saveGlobalDefault, [true]);
		} finally {
			overlay.dispose();
		}
	});

	it("reopens fresh confirmation after Cancel and rechecks busy state before starting", () => {
		const { overlay, setSnapshot, getResult } = createOverlay();
		try {
			openOrchestrator(overlay);
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\r");
			assert.match(renderText(overlay), /\[ Cancel \]/);

			// Cancel is the explicit default. Enter must leave the session unchanged.
			overlay.handleInput("\r");
			assert.equal(getResult(), undefined);
			assert.match(renderText(overlay), /Start a fresh orchestrator session/);

			// The same selected Fresh action must reopen confirmation; no extra Down
			// may move selection onto the global preference row.
			overlay.handleInput("\r");
			assert.match(renderText(overlay), /\[ Cancel \]/);
			setSnapshot({ blockedReason: "parent-busy", parentIdle: false });
			overlay.handleInput("\x1b[C");
			assert.match(renderText(overlay), /\[ Start \]/);
			overlay.handleInput("\r");
			assert.equal(getResult(), undefined);
			assert.match(renderText(overlay), /parent.*busy|running|wait/i);
		} finally {
			overlay.dispose();
		}
	});

	it("confirms fresh sessions in both directions only after Start is selected", () => {
		const off = createOverlay();
		try {
			openOrchestrator(off.overlay);
			off.overlay.handleInput("\x1b[B");
			off.overlay.handleInput("\r");
			off.overlay.handleInput("\x1b[C");
			off.overlay.handleInput("\r");
			assert.deepEqual(off.getResult(), {
				kind: "fresh-session",
				targetMode: true,
			});
		} finally {
			off.overlay.dispose();
		}

		const on = createOverlay({ currentMode: true });
		try {
			openOrchestrator(on.overlay);
			on.overlay.handleInput("\x1b[B");
			on.overlay.handleInput("\r");
			assert.match(renderText(on.overlay), /Start a fresh normal session/);
			on.overlay.handleInput("\x1b[C");
			on.overlay.handleInput("\r");
			assert.deepEqual(on.getResult(), {
				kind: "fresh-session",
				targetMode: false,
			});
		} finally {
			on.overlay.dispose();
		}
	});

	it("reflows and scrolls the action list at narrow widths", () => {
		const { overlay } = createOverlay({
			currentMode: true,
			runningSubagents: 3,
			blockedReason: "running-subagents",
		});
		try {
			openOrchestrator(overlay);
			for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
			const lines = overlay.render(24);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= 24),
				lines.join("\n"),
			);
			assert.match(lines.join("\n"), /Orchestrator/);
			assert.match(lines.join("\n"), /Current session/);
			assert.match(lines.join("\n"), /children|Blocked/);
			assert.match(lines.join("\n"), /Enter select/);
			assert.match(lines.join("\n"), /Esc close/);
			assert.match(lines.join("\n"), /Default for new|Start a fresh|Enter|Esc/);
		} finally {
			overlay.dispose();
		}
	});

	it("keeps a selected action label visible when a compact body scrolls", () => {
		const selectedIndex = 1;
		const scroll = keepOrchestratorSelectionVisible(
			baseSnapshot,
			selectedIndex,
			0,
			80,
			2,
		);
		const lines = renderOrchestrator(
			baseSnapshot,
			selectedIndex,
			scroll,
			{
				fg: (_tone, text) => text,
				bg: (_color, text) => `[${text}]`,
				bold: (text) => text,
			},
			80,
			2,
		);
		const selectedLine = lines.find((line) => line.startsWith("["));
		assert.match(selectedLine ?? "", /Start a fresh orchestrator session/);
	});

	it("keeps global-save errors accessible after keyboard activation while busy", () => {
		const error = `Could not write pi-subagents.json: ${"detail ".repeat(24)}error-tail`;
		const { overlay, calls } = createOverlay(
			{ blockedReason: "running-subagents", runningSubagents: 2 },
			24,
			error,
		);
		try {
			openOrchestrator(overlay);
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\r");
			const text = renderText(overlay);
			assert.deepEqual(calls.saveGlobalDefault, [true]);
			assert.match(text, /Current session: Off/);
			assert.match(text, /children are running|Blocked: children running/);
			assert.match(text, /error-tail/);
		} finally {
			overlay.dispose();
		}
	});

	it("fits fresh-session confirmation into a short terminal", () => {
		const { overlay } = createOverlay({}, 10);
		try {
			openOrchestrator(overlay);
			overlay.handleInput("\x1b[B");
			overlay.handleInput("\r");
			const lines = overlay.render(80);
			const text = lines.join("\n");
			assert.equal(lines.length, 10);
			assert.match(text, /fresh orchestrator session/i);
			assert.match(text, /Cancel/);
			assert.match(text, /Start/);
		} finally {
			overlay.dispose();
		}
	});

	it("hides the orchestration tab for child sessions", () => {
		const { overlay } = createOverlay({
			isChildSession: true,
			blockedReason: "child-session",
		});
		try {
			openOrchestrator(overlay);
			assert.doesNotMatch(
				renderText(overlay),
				/Current session:|delegate-only/,
			);
		} finally {
			overlay.dispose();
		}
	});
});

describe("subagents command bridge", () => {
	it("uses existing command dispatch for Alt+S without starting a model turn", async () => {
		const { runtime } = createRuntime();
		let shortcut: ((ctx: unknown) => Promise<void>) | undefined;
		const sent: Array<{ message: string; options: unknown }> = [];
		registerSubagentsView(
			{
				registerCommand() {},
				registerShortcut(
					_shortcut: string,
					options: { handler: (ctx: unknown) => Promise<void> },
				) {
					shortcut = options.handler;
				},
				sendUserMessage(message: string, options: unknown) {
					sent.push({ message, options });
				},
				on() {},
			} as unknown as ExtensionAPI,
			runtime,
		);
		assert.ok(shortcut);
		await shortcut({});
		assert.deepEqual(sent, [
			{ message: "/subagents", options: { expandPromptTemplates: true } },
		]);
	});

	it("keeps command open idempotent while Alt+S explicitly toggles", async () => {
		const { runtime } = createRuntime();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		let shutdown: (() => Promise<void>) | undefined;
		let shortcut: ((ctx: unknown) => Promise<void>) | undefined;
		let customCalls = 0;
		const results: unknown[] = [];
		const custom = (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => unknown,
		) => {
			customCalls++;
			return new Promise<unknown>((resolve) => {
				factory(
					{ requestRender() {}, terminal: { columns: 80, rows: 24 } },
					{
						fg: (_tone: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					},
					{},
					(result) => {
						results.push(result);
						resolve(result);
					},
				);
			});
		};
		const context = {
			cwd: "/tmp",
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: { custom, notify() {} },
			sessionManager: { getSessionFile: () => undefined },
		};
		registerSubagentsView(
			{
				registerCommand(
					_name: string,
					options: { handler: (args: string, ctx: unknown) => Promise<void> },
				) {
					command = options.handler;
				},
				registerShortcut(
					_name: string,
					options: { handler: (ctx: unknown) => Promise<void> },
				) {
					shortcut = options.handler;
				},
				on(event: string, handler: () => Promise<void>) {
					if (event === "session_shutdown") shutdown = handler;
				},
			} as unknown as ExtensionAPI,
			runtime,
		);
		assert.ok(command);
		assert.ok(shutdown);

		const first = command("", context);
		await Promise.resolve();
		assert.equal(customCalls, 1);
		const second = command("", context);
		await second;
		assert.equal(customCalls, 1);
		assert.deepEqual(results, []);
		assert.ok(shortcut);
		await shortcut(context);
		await first;
		assert.deepEqual(results, [null]);

		const third = command("", context);
		await Promise.resolve();
		assert.equal(customCalls, 2);
		await shutdown();
		await third;
		assert.deepEqual(results, [null, null]);
	});

	it("does not let a stale overlay completion clear a newer manager", async () => {
		const { runtime } = createRuntime();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		let shutdown: (() => Promise<void>) | undefined;
		let customCalls = 0;
		const custom = (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => unknown,
		) => {
			customCalls++;
			return new Promise<unknown>((resolve) => {
				factory(
					{ requestRender() {}, terminal: { columns: 80, rows: 24 } },
					{
						fg: (_tone: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					},
					{},
					(result) => resolve(result),
				);
			});
		};
		const context = {
			cwd: "/tmp",
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: { custom, notify() {} },
			sessionManager: { getSessionFile: () => undefined },
		};
		registerSubagentsView(
			{
				registerCommand(
					_name: string,
					options: { handler: (args: string, ctx: unknown) => Promise<void> },
				) {
					command = options.handler;
				},
				registerShortcut() {},
				on(event: string, handler: () => Promise<void>) {
					if (event === "session_shutdown") shutdown = handler;
				},
			} as unknown as ExtensionAPI,
			runtime,
		);
		assert.ok(command);
		assert.ok(shutdown);

		const first = command("", context);
		await Promise.resolve();
		const firstShutdown = shutdown();
		const second = command("", context);
		await firstShutdown;
		await Promise.resolve();
		assert.equal(customCalls, 2);
		const third = command("", context);
		await third;
		assert.equal(customCalls, 2);
		await shutdown();
		await Promise.all([first, second]);
		assert.equal(customCalls, 2);
	});

	it("rechecks parent and child guards immediately before creating a fresh session", async () => {
		for (const blocked of [
			{
				blockedReason: "parent-busy" as const,
				parentIdle: false,
				message: /parent.*busy|wait/i,
			},
			{
				blockedReason: "child-session" as const,
				isChildSession: true,
				message: /child session|parent.*global/i,
			},
		]) {
			const { runtime, setSnapshot } = createRuntime();
			let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			let newSessionCalls = 0;
			const notifications: string[] = [];
			registerSubagentsView(
				{
					registerCommand(
						_name: string,
						options: { handler: (args: string, ctx: unknown) => Promise<void> },
					) {
						command = options.handler;
					},
					registerShortcut() {},
					on() {},
				} as unknown as ExtensionAPI,
				runtime,
			);
			assert.ok(command);
			await command("", {
				cwd: "/tmp",
				mode: "tui",
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
				ui: {
					custom: async () => ({ kind: "fresh-session", targetMode: true }),
					notify(message: string) {
						notifications.push(message);
					},
				},
				sessionManager: {
					getSessionFile: () => {
						setSnapshot(blocked);
						return undefined;
					},
				},
				newSession: async () => {
					newSessionCalls++;
					return { cancelled: false };
				},
			});
			assert.equal(newSessionCalls, 0);
			assert.ok(
				notifications.some((message) => blocked.message.test(message)),
				notifications.join("\n"),
			);
		}
	});

	it("writes the requested mode into a real fresh session before replacement", async () => {
		const dir = createTestDir();
		const oldSession = SessionManager.create(dir, dir);
		const { runtime } = createRuntime();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		let newSessionOptions:
			| {
					parentSession?: string;
					setup?: (session: SessionManager) => Promise<void> | void;
			  }
			| undefined;
		let freshSession: SessionManager | undefined;
		registerSubagentsView(
			{
				registerCommand(
					_name: string,
					options: { handler: (args: string, ctx: unknown) => Promise<void> },
				) {
					command = options.handler;
				},
				registerShortcut() {},
				on() {},
			} as unknown as ExtensionAPI,
			runtime,
		);
		assert.ok(command);
		await command("", {
			cwd: dir,
			mode: "tui",
			hasUI: true,
			sessionManager: oldSession,
			ui: {
				custom: async (_factory: unknown) => ({
					kind: "fresh-session",
					targetMode: true,
				}),
				notify() {},
			},
			newSession: async (options: typeof newSessionOptions) => {
				newSessionOptions = options;
				freshSession = SessionManager.create(dir, dir, {
					parentSession: options?.parentSession,
				});
				await options?.setup?.(freshSession);
				return { cancelled: false };
			},
		});

		assert.equal(newSessionOptions?.parentSession, oldSession.getSessionFile());
		assert.ok(freshSession);
		assert.equal(
			freshSession.getHeader()?.parentSession,
			oldSession.getSessionFile(),
		);
		assert.equal(
			readOrchestratorSessionState(freshSession.getBranch())?.enabled,
			true,
		);
	});
});
