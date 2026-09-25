/**
 * Shared fake `ChildProcess` for `safe-spawn.ts` tests.
 *
 * Single source of truth for the fixture `safe-spawn-close-before-error-
 * race.test.ts` introduced during the #1673 review (round F1b): a real
 * spawned child ALWAYS has real `stdout`/`stderr` `EventEmitter`-backed
 * streams (Node creates them the moment `stdio: "pipe"` is requested, even
 * for a child that goes on to fail to launch), and `child` itself is a real
 * `EventEmitter` — not a hand-rolled `{on, emit}` object. A bare-object
 * double is production-unfaithful (AGENTS.md shape 7: a double that skips a
 * real seam the production code path always exercises): `safeSpawnAsync`'s
 * post-exit wait (`waitForPipeIdle`, #1656) short-circuits when a child has
 * no pipes at all, hiding a real race (#1673 review F1) where a late
 * 'error' landing DURING that wait could steal an already-decided verdict.
 *
 * `kill()` sets `killed = true` as a side effect, mirroring Node's real
 * behavior (safe-spawn.ts's escalation logic reads `child.killed`, #1114)
 * — and is itself a `vi.fn()` so callers can assert on `kill` invocations
 * (e.g. `expect(child.kill).toHaveBeenCalledWith("SIGTERM")`).
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";

export interface FakeChild extends EventEmitter {
	stdout: EventEmitter & { setEncoding: (encoding: string) => void };
	stderr: EventEmitter & { setEncoding: (encoding: string) => void };
	pid?: number;
	killed?: boolean;
	kill: (...args: unknown[]) => boolean;
}

/**
 * @param pid Only set on the fixture when passed explicitly — several
 *   `safe-spawn.ts` branches gate on `if (child.pid)`, so leaving it
 *   `undefined` by default matches a child that never resolved a pid (the
 *   ENOENT/never-spawned shapes these tests exercise).
 */
export function makeFakeChild(pid?: number): FakeChild {
	const child = new EventEmitter() as FakeChild;
	if (pid !== undefined) child.pid = pid;
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	});
	child.stdout = Object.assign(new EventEmitter(), {
		setEncoding: () => {},
	});
	child.stderr = Object.assign(new EventEmitter(), {
		setEncoding: () => {},
	});
	return child;
}
