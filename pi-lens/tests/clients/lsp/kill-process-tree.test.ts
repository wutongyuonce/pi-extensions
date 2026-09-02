/**
 * Guards the Windows process-exit teardown path. On `session_shutdown` (e.g.
 * during `pi update`) the event loop is already closing, so spawning a child
 * process to kill LSP servers makes libuv call uv_async_send on the closing
 * loop-wakeup handle and hard-aborts:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * killProcessTree must therefore kill via the handle it already holds
 * (TerminateProcess — synchronous, no new async handle) when `processExiting`
 * is set, and only fall back to the `taskkill /T` tree-kill spawn for
 * mid-session shutdowns where the host keeps running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn((..._args: unknown[]) => ({
	once: vi.fn(),
	unref: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

const { killProcessTree } = await import("../../../clients/lsp/client.js");

describe("killProcessTree", () => {
	const realPlatform = process.platform;
	let processKillSpy: ReturnType<typeof vi.spyOn> | undefined;

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		processKillSpy?.mockRestore();
		processKillSpy = undefined;
		vi.useRealTimers();
	});

	describe("Windows process-exit teardown", () => {
		beforeEach(() => {
			spawnMock.mockClear();
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
		});

		it("processExiting: kills via the existing handle and NEVER spawns taskkill", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true, processExiting: true });
			// The whole point: no child spawn while the loop is closing.
			expect(spawnMock).not.toHaveBeenCalled();
			expect(proc.kill).toHaveBeenCalled();
			expect(proc.unref).toHaveBeenCalled();
		});

		it("non-exiting fast shutdown kills wrapper descendants via taskkill /T", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });
			expect(spawnMock).toHaveBeenCalledTimes(1);
			const call = spawnMock.mock.calls[0];
			expect(String(call[0]).toLowerCase()).toContain("taskkill");
			expect(call[1]).toEqual(expect.arrayContaining(["/T", "/PID", "4242"]));
		});
	});

	describe("POSIX process-group teardown", () => {
		beforeEach(() => {
			spawnMock.mockClear();
			Object.defineProperty(process, "platform", {
				value: "linux",
				configurable: true,
			});
			// Fake timers keep the escalation test deterministic and stop the
			// unref'd 1500ms SIGKILL timer from firing against the real
			// process.kill once processKillSpy is restored.
			vi.useFakeTimers();
			processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		});

		it("fast shutdown signals the LSP process group before unref", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).not.toHaveBeenCalledWith("SIGTERM");
			expect(proc.unref).toHaveBeenCalled();
		});

		it("falls back to the direct child when group signaling fails (ESRCH)", async () => {
			// A non-detached child has no process group whose id == pid, so
			// process.kill(-pid) throws ESRCH. Teardown must not give up — it
			// falls back to killing the handle we already hold.
			processKillSpy?.mockImplementation(() => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			});
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(proc.unref).toHaveBeenCalled();
		});

		it("never negates a non-positive pid into a group kill (guards process.kill(-0))", async () => {
			// process.kill(-0, sig) would signal pi-lens's OWN process group.
			// The pid<=0 guard must skip the group path entirely and only touch
			// the child handle.
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 0, { fast: true });

			expect(processKillSpy).not.toHaveBeenCalled();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("non-fast shutdown escalates SIGTERM → SIGKILL on the process group", async () => {
			// #1114 follow-up: this mock must be `once`-capable so the
			// escalation logic's real gate (an observed "exit" event, not the
			// unreachable `proc.killed` send-flag) is actually exercised —
			// without `.once`, `proc.once?.(...)` optional-chains to a no-op
			// and the "exited" flag can never be set from true code changes,
			// making the assertions below pass vacuously regardless of
			// whether the escalation logic is correct.
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn(),
				off: vi.fn(),
			};
			const done = killProcessTree(proc, 4242, {});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");

			await vi.advanceTimersByTimeAsync(1500);
			await done;

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		// #1114 follow-up (adversarial review of PR #1130): the pre-existing
		// tests above use mocks that lack `.once`/never set `.killed`, so both
		// the pre-fix `!proc.killed` guard AND the post-fix `!exited` guard
		// were vacuously permissive there — neither test could actually catch
		// a regression in the escalation logic. These two tests use an
		// `.once`-capable mock that captures the real "exit" listener the fix
		// registers, and assert BOTH directions of the `fast`-shutdown
		// escalation timer (client.ts's `killProcessTree`, `options.fast`
		// branch): no premature SIGKILL when the process is observed to exit
		// within the window, and a real SIGKILL when it isn't.
		it("fast shutdown SIGKILLs the process group when no exit is observed by the 1.5s window", async () => {
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn(),
				off: vi.fn(),
			};
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");

			await vi.advanceTimersByTimeAsync(1500);

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		it("fast shutdown skips the group SIGKILL when the process's exit is observed before the 1.5s window", async () => {
			let exitListener: (() => void) | undefined;
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn((event: string, listener: () => void) => {
					if (event === "exit") exitListener = listener;
				}),
				off: vi.fn(),
			};
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(exitListener).toBeDefined();

			// The process dies well inside the escalation window.
			exitListener?.();
			await vi.advanceTimersByTimeAsync(1500);

			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		it("resolves on the process's exit event without waiting out the escalation window", async () => {
			// A graceful shutdown (server honored `exit`) used to still sleep the
			// full 1500ms before checking whether to SIGKILL — every LSP teardown
			// paid the window even when the process was already dead.
			let exitListener: (() => void) | undefined;
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn((event: string, listener: () => void) => {
					if (event === "exit") exitListener = listener;
				}),
				off: vi.fn(),
			};
			const done = killProcessTree(proc, 4242, {});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(exitListener).toBeDefined();
			exitListener?.();
			// No timer advance: with fake timers active, resolution proves the
			// exit event settled the wait, not the 1500ms escalation timer.
			await done;

			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");
		});
	});
});
