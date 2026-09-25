import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { spawnCollectStdoutResult } =
	await import("../../clients/child-unref.js");

function fakeChild() {
	const stdout = { on: vi.fn(), unref: vi.fn() };
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const child = {
		stdout,
		stderr: null,
		stdin: null,
		pid: 4242,
		unref: vi.fn(),
		kill: vi.fn(),
		once: (event: string, callback: (...args: unknown[]) => void) => {
			handlers.set(event, callback);
		},
	};
	return { child, handlers };
}

describe("spawnCollectStdoutResult", () => {
	it("reports a non-zero close as exit-error and discards partial stdout", async () => {
		const fake = fakeChild();
		spawnMock.mockReturnValueOnce(fake.child);
		const resultPromise = spawnCollectStdoutResult("tool", [], {});
		fake.handlers.get("close")?.(1, null);

		expect(await resultPromise).toMatchObject({
			stdout: "",
			status: "exit-error",
			exitCode: 1,
			exitSignal: null,
		});
	});

	it("settles a timeout only after the injected kill hook resolves", async () => {
		const fake = fakeChild();
		spawnMock.mockReturnValueOnce(fake.child);
		let release!: (outcome: "gone") => void;
		const resultPromise = spawnCollectStdoutResult(
			"tool",
			[],
			{},
			{
				timeoutMs: 1,
				onTimeout: () =>
					new Promise<"gone">((resolve) => {
						release = resolve;
					}),
			},
		);
		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe(false);
		release("gone");
		expect(await resultPromise).toMatchObject({
			status: "timeout",
			timeoutKill: "gone",
		});
	});
});
