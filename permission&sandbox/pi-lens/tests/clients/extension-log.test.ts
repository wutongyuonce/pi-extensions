/**
 * Behavior of the terminal-safe extension sink and the console guard (#1333).
 *
 * These load `clients/extension-log.ts` with `PI_LENS_TEST_MODE=0` and a
 * throwaway `PI_LENS_HOME`, because the sink deliberately no-ops under test
 * mode (the same contract every other pi-lens ndjson logger keeps).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;
const savedEnv: Record<string, string | undefined> = {};

async function loadSink(): Promise<
	typeof import("../../clients/extension-log.js")
> {
	vi.resetModules();
	return await import("../../clients/extension-log.js");
}

function readLines(logFile: string): Record<string, unknown>[] {
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1333-"));
	for (const key of [
		"PI_LENS_TEST_MODE",
		"PI_LENS_HOME",
		"PI_LENS_CONSOLE_GUARD",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_TEST_MODE = "0";
	process.env.PI_LENS_HOME = tempHome;
	delete process.env.PI_LENS_CONSOLE_GUARD;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("extension-log sink (#1333)", () => {
	it("writes an ndjson line instead of touching the terminal", async () => {
		const sink = await loadSink();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			sink.logExtension({
				subsystem: "dispatch",
				message: "no config detected, using defaults",
				metadata: { filePath: "a.ts" },
			});
			await sink.flushExtensionLog();
			expect(stderr).not.toHaveBeenCalled();
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
		}

		const lines = readLines(sink.getExtensionLogPath());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			subsystem: "dispatch",
			level: "error",
			message: "no config detected, using defaults",
			metadata: { filePath: "a.ts" },
		});
		expect(typeof lines[0].ts).toBe("string");
	});

	it("createSubsystemLogger is callable and level-aware", async () => {
		const sink = await loadSink();
		const log = sink.createSubsystemLogger("ruff");
		log("verbose detail");
		log.warn("a warning");
		log.error("an error");
		await sink.flushExtensionLog();

		const lines = readLines(sink.getExtensionLogPath());
		expect(lines.map((l) => [l.subsystem, l.level, l.message])).toEqual([
			["ruff", "debug", "verbose detail"],
			["ruff", "warn", "a warning"],
			["ruff", "error", "an error"],
		]);
	});

	it("stays terminal-silent whether the verbose gate is on or off", async () => {
		const sink = await loadSink();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			// verbose OFF
			sink.noopSubsystemLogger()("hidden");
			// verbose ON — the migrated sink, not console
			sink.createSubsystemLogger("biome")("shown");
			await sink.flushExtensionLog();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
		const messages = readLines(sink.getExtensionLogPath()).map(
			(l) => l.message,
		);
		expect(messages).toEqual(["shown"]);
	});
});

describe("console guard (#1333)", () => {
	it("reroutes console.* into the sink inside a window and is idempotent", async () => {
		const sink = await loadSink();
		const original = console.error;
		expect(sink.installConsoleGuard()).toBe(true);
		expect(sink.installConsoleGuard()).toBe(false);
		try {
			expect(console.error).not.toBe(original);
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			sink.runInConsoleCaptureWindow(() => {
				console.error("rogue dependency line", { detail: 1 });
				console.log("rogue stdout line");
			});
			expect(stderr).not.toHaveBeenCalled();
			stderr.mockRestore();
			await sink.flushExtensionLog();
		} finally {
			sink.uninstallConsoleGuard();
		}

		const lines = readLines(sink.getExtensionLogPath()).filter(
			(l) => l.subsystem === "console",
		);
		expect(lines.map((l) => [l.level, l.message])).toEqual([
			["error", 'rogue dependency line {"detail":1}'],
			["debug", "rogue stdout line"],
		]);
	});

	it("is inert under test mode and under PI_LENS_CONSOLE_GUARD=0", async () => {
		process.env.PI_LENS_TEST_MODE = "1";
		let sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(false);

		process.env.PI_LENS_TEST_MODE = "0";
		process.env.PI_LENS_CONSOLE_GUARD = "0";
		sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(false);
	});
});

/**
 * The guard used to replace console globally and permanently, so pi's own
 * one-shot CLI commands printed nothing: `pi list` exited 0 with no output in
 * any project whose cwd loaded the extension first. The guard now captures only
 * while pi-lens owns execution.
 */
describe("console guard capture windows (#1434)", () => {
	/** Console methods the sink patches, captured before any install. */
	function snapshotConsole(): Record<string, unknown> {
		const target = console as unknown as Record<string, unknown>;
		return Object.fromEntries(
			["log", "info", "warn", "error", "debug", "trace", "dir"].map((name) => [
				name,
				target[name],
			]),
		);
	}

	function consoleLines(sink: {
		getExtensionLogPath(): string;
	}): [unknown, unknown][] {
		return readLines(sink.getExtensionLogPath())
			.filter((l) => l.subsystem === "console")
			.map((l) => [l.level, l.message]);
	}

	it("lets host output outside every window reach the real console", async () => {
		const sink = await loadSink();
		const seen: unknown[][] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]): void => {
			seen.push(args);
		};
		try {
			expect(sink.installConsoleGuard()).toBe(true);
			// The host CLI printing its own command output — no pi-lens frame on
			// the stack, so this must land on the real sink.
			console.log("pi list output");
			await sink.flushExtensionLog();
			expect(seen).toEqual([["pi list output"]]);
			expect(consoleLines(sink)).toEqual([]);
		} finally {
			sink.uninstallConsoleGuard();
			console.log = originalLog;
		}
	});

	it("captures a write from inside a window, including after an await", async () => {
		const sink = await loadSink();
		const seen: unknown[][] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]): void => {
			seen.push(args);
		};
		try {
			sink.installConsoleGuard();
			await sink.runInConsoleCaptureWindow(async () => {
				console.log("sync inside the window");
				await new Promise((resolve) => setTimeout(resolve, 1));
				console.log("async continuation inside the window");
			});
			console.log("back on host time");
			await sink.flushExtensionLog();
			expect(seen).toEqual([["back on host time"]]);
			expect(consoleLines(sink)).toEqual([
				["debug", "sync inside the window"],
				["debug", "async continuation inside the window"],
			]);
		} finally {
			sink.uninstallConsoleGuard();
			console.log = originalLog;
		}
	});

	it("captures module evaluation until the module window closes", async () => {
		const sink = await loadSink();
		const seen: unknown[][] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]): void => {
			seen.push(args);
		};
		try {
			sink.installConsoleGuard();
			sink.openModuleLoadConsoleWindow();
			expect(sink.isConsoleCaptureActive()).toBe(true);
			console.log("dependency init noise");
			sink.closeModuleLoadConsoleWindow();
			expect(sink.isConsoleCaptureActive()).toBe(false);
			console.log("host output after load");
			await sink.flushExtensionLog();
			expect(seen).toEqual([["host output after load"]]);
			expect(consoleLines(sink)).toEqual([["debug", "dependency init noise"]]);
		} finally {
			sink.uninstallConsoleGuard();
			sink.closeModuleLoadConsoleWindow();
			console.log = originalLog;
		}
	});

	it("leaves console untouched under PI_LENS_CONSOLE_GUARD=0", async () => {
		process.env.PI_LENS_CONSOLE_GUARD = "0";
		const sink = await loadSink();
		const before = snapshotConsole();
		const seen: unknown[][] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]): void => {
			seen.push(args);
		};
		try {
			expect(sink.installConsoleGuard()).toBe(false);
			sink.openModuleLoadConsoleWindow();
			console.log("kill switch keeps this visible");
			expect(seen).toEqual([["kill switch keeps this visible"]]);
			await sink.flushExtensionLog();
			expect(consoleLines(sink)).toEqual([]);
		} finally {
			sink.closeModuleLoadConsoleWindow();
			console.log = originalLog;
		}
		for (const name of Object.keys(before)) {
			expect((console as unknown as Record<string, unknown>)[name]).toBe(
				before[name],
			);
		}
	});

	it("restores the exact original methods and reinstalls cleanly", async () => {
		const sink = await loadSink();
		const before = snapshotConsole();
		expect(sink.installConsoleGuard()).toBe(true);
		expect(console.log).not.toBe(before.log);
		expect(sink.uninstallConsoleGuard()).toBe(true);
		for (const name of Object.keys(before)) {
			expect((console as unknown as Record<string, unknown>)[name]).toBe(
				before[name],
			);
		}
		// Idempotent: a second uninstall reports that it did nothing.
		expect(sink.uninstallConsoleGuard()).toBe(false);
		// A later window must not resurrect the patch on its own.
		sink.runInConsoleCaptureWindow(() => {
			expect(console.log).toBe(before.log);
		});
		expect(sink.installConsoleGuard()).toBe(true);
		expect(console.log).not.toBe(before.log);
		expect(sink.uninstallConsoleGuard()).toBe(true);
		expect(console.log).toBe(before.log);
	});

	it("opens a window around every handler and tool registered through the API", async () => {
		const sink = await loadSink();
		// #1434 S1b: the capture-window AsyncLocalStorage is now built lazily,
		// and only once the guard has actually installed -- install it first so
		// runInConsoleCaptureWindow (which inCaptureWindow calls under the hood)
		// does not treat "guard never installed" as "no window" here.
		expect(sink.installConsoleGuard()).toBe(true);
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const tools: { execute?: (...args: unknown[]) => unknown }[] = [];
		const hostApi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
				return this;
			},
			registerTool(tool: { execute?: (...args: unknown[]) => unknown }) {
				tools.push(tool);
			},
			unrelated: 7,
		};
		const api = sink.withConsoleCaptureWindows(hostApi);
		expect(api.unrelated).toBe(7);

		// A chaining host returns `this`; the chain must stay wrapped.
		expect(api.on("noop", () => {})).toBe(api);

		let handlerSawWindow: boolean | undefined;
		api.on("session_start", async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			handlerSawWindow = sink.isConsoleCaptureActive();
			return "handler-result";
		});
		let toolSawWindow: boolean | undefined;
		const tool = {
			name: "lens_diagnostics",
			execute: async () => {
				toolSawWindow = sink.isConsoleCaptureActive();
				return "tool-result";
			},
		};
		api.registerTool(tool);

		expect(sink.isConsoleCaptureActive()).toBe(false);
		await expect(handlers.get("session_start")?.()).resolves.toBe(
			"handler-result",
		);
		await expect(tools[0].execute?.()).resolves.toBe("tool-result");
		expect(handlerSawWindow).toBe(true);
		expect(toolSawWindow).toBe(true);
		expect(sink.isConsoleCaptureActive()).toBe(false);
		sink.uninstallConsoleGuard();
	});
});
