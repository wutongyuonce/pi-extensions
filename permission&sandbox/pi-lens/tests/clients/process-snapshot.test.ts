/**
 * Tests for clients/process-snapshot.ts (#2443) — the clients-side door onto
 * the shared process-table seam.
 *
 * The seam's query composition and row parsing are pinned in
 * tests/scripts/process-scan.test.ts. What is pinned HERE is the half this
 * module owns and the scripts-side `snapshotProcesses` deliberately does not:
 * the extension's spawn rails. `node:child_process` is mocked, so nothing
 * spawns; each test drives the fake child to exercise one path.
 *
 * The platform is forced per test because both branches ship — the Windows
 * CIM one to every Windows user, the POSIX `ps` one to everyone else — and
 * neither CI runner covers both.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type SpawnFn = (...args: unknown[]) => unknown;
let fakeSpawn: SpawnFn = () => makeFakeChild({ stdout: "" });
const spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: unknown[]) => {
			spawnCalls.push({
				command: args[0] as string,
				args: (args[1] as string[]) ?? [],
			});
			return fakeSpawn(...args);
		},
	};
});

const { queryProcessTable } = await import("../../clients/process-snapshot.js");

interface FakeChild {
	stdout: {
		on: (event: string, cb: (chunk: Buffer) => void) => void;
		unref: ReturnType<typeof vi.fn>;
	};
	once: (event: string, cb: (...a: unknown[]) => void) => void;
	unref: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	pid: number;
}

function makeFakeChild(opts: {
	stdout?: string;
	code?: number;
	holdOpen?: boolean;
}): FakeChild {
	const handlers = new Map<string, (...a: unknown[]) => void>();
	const dataCbs: Array<(chunk: Buffer) => void> = [];
	const child: FakeChild = {
		stdout: {
			on: (event: string, cb: (chunk: Buffer) => void) => {
				if (event === "data") dataCbs.push(cb);
			},
			unref: vi.fn(),
		},
		once: (event: string, cb: (...a: unknown[]) => void) => {
			handlers.set(event, cb);
		},
		unref: vi.fn(),
		kill: vi.fn(),
		pid: 4242,
	};
	queueMicrotask(() => {
		if (opts.holdOpen) return;
		if (opts.stdout) for (const cb of dataCbs) cb(Buffer.from(opts.stdout));
		handlers.get("close")?.(opts.code ?? 0, null);
	});
	return child;
}

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

const realPlatform = process.platform;

afterEach(() => {
	setPlatform(realPlatform);
	fakeSpawn = () => makeFakeChild({ stdout: "" });
	spawnCalls.length = 0;
	vi.useRealTimers();
});

describe("queryProcessTable", () => {
	it("spawns the composed query and returns its parsed rows", async () => {
		setPlatform("win32");
		fakeSpawn = () =>
			makeFakeChild({ stdout: "111\t7\tnode a.js\r\n222\t7\tnode b.js\r\n" });

		const result = await queryProcessTable(
			{ fields: ["pid", "ppid", "command"] },
			{ timeoutMs: 2_000 },
		);

		expect(result.status).toBe("ok");
		expect(result.rows).toEqual([
			{ pid: 111, ppid: 7, command: "node a.js" },
			{ pid: 222, ppid: 7, command: "node b.js" },
		]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command.toLowerCase()).toContain("powershell.exe");
	});

	it("reports whether the platform applied the filter itself", async () => {
		setPlatform("linux");
		fakeSpawn = () => makeFakeChild({ stdout: "  111 node a.js\n" });

		const filtered = await queryProcessTable(
			{
				fields: ["pid", "command"],
				filter: { column: "ProcessId", op: "eq", values: [111] },
			},
			{ timeoutMs: 2_000 },
		);
		expect(filtered.serverSideFiltered).toBe(true);
		expect(spawnCalls[0]?.args).toEqual(["-p", "111", "-o", "pid=,args="]);

		spawnCalls.length = 0;
		const unfiltered = await queryProcessTable(
			{
				fields: ["pid", "command"],
				// ps has no server-side name filter: the caller gets the whole
				// table and must narrow it, which is only safe if it is TOLD.
				filter: { column: "Name", op: "eq", values: ["node"] },
			},
			{ timeoutMs: 2_000 },
		);
		expect(unfiltered.serverSideFiltered).toBe(false);
		expect(spawnCalls[0]?.args).toEqual(["-eo", "pid=,args="]);
	});

	it("keeps a non-zero exit distinguishable from an empty table", async () => {
		// The #2438 S5 rule, carried into the clients-side runner: a listing
		// that printed a table and then died is not evidence of what is NOT
		// running, so those rows are dropped — and `status` is what tells the
		// caller that the resulting empty table means nothing.
		setPlatform("win32");
		fakeSpawn = () =>
			makeFakeChild({ stdout: "111\t7\tnode a.js\r\n", code: 1 });

		const result = await queryProcessTable(
			{ fields: ["pid", "ppid", "command"] },
			{ timeoutMs: 2_000 },
		);

		expect(result.status).toBe("exit-error");
		expect(result.exitCode).toBe(1);
		expect(result.rows).toEqual([]);
	});

	it("never spawns for a query the platform cannot answer", async () => {
		// A Windows-only column on POSIX would become a `ps` invocation with an
		// unknown column: usage text on stderr, an EMPTY table on stdout, which
		// reads exactly like "no such process".
		setPlatform("linux");

		const result = await queryProcessTable(
			{ fields: ["pid", "rssBytes"] },
			{ timeoutMs: 2_000 },
		);

		expect(result.status).toBe("spawn-error");
		expect(result.rows).toEqual([]);
		expect(result.serverSideFiltered).toBe(false);
		expect(spawnCalls).toHaveLength(0);
	});

	it("unrefs the child and its stdout pipe (#1155)", async () => {
		// A piped, data-listener-attached child re-references the libuv loop
		// even after child.unref() unless its stdout pipe is unref'd too, and a
		// settled `pi --print` must not wait on a best-effort process listing.
		setPlatform("win32");
		const spawned: FakeChild[] = [];
		fakeSpawn = () => {
			const child = makeFakeChild({ stdout: "" });
			spawned.push(child);
			return child;
		};

		await queryProcessTable({ fields: ["pid"] }, { timeoutMs: 2_000 });

		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.unref).toHaveBeenCalled();
		expect(spawned[0]?.stdout.unref).toHaveBeenCalled();
	});

	it("hands a timed-out child to the caller's own terminator", async () => {
		// The reaper and the sampler both own tree-kill-and-verify machinery; a
		// scan that abandons its own scanner child is the defect the scan
		// exists to fix (#1864 F3), so the handler is INJECTED, not defaulted.
		setPlatform("win32");
		vi.useFakeTimers();
		fakeSpawn = () => makeFakeChild({ holdOpen: true });
		const onTimeout = vi.fn(async () => "gone" as const);

		const pending = queryProcessTable(
			{ fields: ["pid"] },
			{ timeoutMs: 1_000, onTimeout },
		);
		await vi.advanceTimersByTimeAsync(1_500);
		const result = await pending;

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("timeout");
		expect(result.timeoutKill).toBe("gone");
		// A timed-out listing is bounded, not discarded: whatever it printed
		// before the deadline is parsed, and `status` carries the warning.
		expect(result.rows).toEqual([]);
	});
});
