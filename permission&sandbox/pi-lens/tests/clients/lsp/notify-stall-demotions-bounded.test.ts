/**
 * #2442: behavior-preservation for `notifyStallDemotions` in
 * clients/lsp/index.ts, migrated from a hand-rolled evict-oldest Map to
 * BoundedFifoMap. `demoteForNotifyStall` writes unconditionally (no
 * delete-first refresh, matching the original hand-rolled `set()` then
 * `while (size > MAX) evict` shape) — so a re-demotion of an already-tracked
 * key does not move it. There is no read accessor for this map in production
 * (it exists purely to gate a later re-demotion decision at
 * clients/lsp/index.ts:~3237), so eviction is observed via `.get()` through
 * the same private-method harness cast the existing
 * typescript-idle-eviction.test.ts / service-scanner-coverage-gap.test.ts
 * suites already use for `demoteForNotifyStall`.
 *
 * `demoteForNotifyStall`'s only guard is identity: `state.clients.get(key)
 * === entry.client`. Seeding `state.clients` directly with fake client
 * doubles (a `shutdown()` stub) exercises the real eviction path without a
 * real spawn.
 */
import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

const MAX_NOTIFY_STALL_DEMOTIONS = 50;

function fakeClient() {
	return { shutdown: async () => undefined };
}

interface Harness {
	state: { clients: Map<string, { shutdown: () => Promise<void> }> };
	// Structural, not `Map`: the real field is a BoundedFifoMap. Declaring the
	// surface this test uses keeps the cast honest about what it reaches for.
	notifyStallDemotions: {
		get(key: string): number | undefined;
		has(key: string): boolean;
		readonly size: number;
	};
	demoteForNotifyStall(
		key: string,
		entry: { client: { shutdown: () => Promise<void> }; info: { id: string } },
		filePath: string,
		reason: unknown,
	): void;
}

function harnessOf(service: LSPService): Harness {
	return service as unknown as Harness;
}

const REASON = { outstandingMs: 1, discriminator: "budget-exceeded" };

describe("#2442 notifyStallDemotions (FIFO)", () => {
	it("evicts the single oldest key once filled past capacity", async () => {
		const service = new LSPService();
		const harness = harnessOf(service);

		for (let i = 0; i < MAX_NOTIFY_STALL_DEMOTIONS; i++) {
			const key = `server-${i}@/repo`;
			const client = fakeClient();
			harness.state.clients.set(key, client);
			harness.demoteForNotifyStall(
				key,
				{ client, info: { id: "fake" } },
				"/repo/main.ts",
				REASON,
			);
		}
		expect(harness.notifyStallDemotions.has("server-0@/repo")).toBe(true);
		expect(harness.notifyStallDemotions.size).toBe(MAX_NOTIFY_STALL_DEMOTIONS);

		const overflowKey = "server-overflow@/repo";
		const overflowClient = fakeClient();
		harness.state.clients.set(overflowKey, overflowClient);
		harness.demoteForNotifyStall(
			overflowKey,
			{ client: overflowClient, info: { id: "fake" } },
			"/repo/main.ts",
			REASON,
		);

		expect(harness.notifyStallDemotions.size).toBe(MAX_NOTIFY_STALL_DEMOTIONS);
		expect(harness.notifyStallDemotions.has("server-0@/repo")).toBe(false);
		expect(harness.notifyStallDemotions.has("server-1@/repo")).toBe(true);
		expect(harness.notifyStallDemotions.has(overflowKey)).toBe(true);

		await service.shutdown();
	});

	it("a production `get` of the oldest key never reorders eviction order (red on an accidental LRU substitution)", async () => {
		// The map's ONE production read is `this.notifyStallDemotions.get(key)`
		// at clients/lsp/index.ts:~3233 (the "was this server demoted for a
		// notify stall?" branch of the per-file diagnostics gather). The
		// capacity test above only ever calls `.has()`, and `.has()` reorders
		// nothing under either bounded class — so it passed under the exact LRU
		// substitution it was written to catch (#2442 review F4). This one
		// performs that `get` on the OLDEST key BEFORE the overflow write.
		const service = new LSPService();
		const harness = harnessOf(service);

		for (let i = 0; i < MAX_NOTIFY_STALL_DEMOTIONS; i++) {
			const key = `read-${i}@/repo`;
			const client = fakeClient();
			harness.state.clients.set(key, client);
			harness.demoteForNotifyStall(
				key,
				{ client, info: { id: "fake" } },
				"/repo/main.ts",
				REASON,
			);
		}

		// The production read, five times over, on the oldest key.
		for (let i = 0; i < 5; i++) {
			expect(harness.notifyStallDemotions.get("read-0@/repo")).toBeTypeOf(
				"number",
			);
		}

		const overflowKey = "read-overflow@/repo";
		const overflowClient = fakeClient();
		harness.state.clients.set(overflowKey, overflowClient);
		harness.demoteForNotifyStall(
			overflowKey,
			{ client: overflowClient, info: { id: "fake" } },
			"/repo/main.ts",
			REASON,
		);

		// FIFO: the reads left insertion order alone, so read-0 is still the
		// oldest and is the one evicted. Under LRU both assertions flip.
		expect(harness.notifyStallDemotions.has("read-0@/repo")).toBe(false);
		expect(harness.notifyStallDemotions.has("read-1@/repo")).toBe(true);

		await service.shutdown();
	});
});
