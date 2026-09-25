import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileAttemptUsage } from "../../src/runs/shared/usage-reconciliation.ts";
import type { Usage } from "../../src/shared/types.ts";

const live: Usage = { input: 20, output: 10, cacheRead: 3, cacheWrite: 4, cost: 2, turns: 9 };
const assistant = (usage: Record<string, unknown>, timestamp?: number) => ({ role: "assistant", content: [], usage, ...(timestamp === undefined ? {} : { timestamp }) });

describe("attempt usage reconciliation", () => {
	it("applies the public field-completeness and attempt-baseline contract", () => {
		assert.deepEqual(reconcileAttemptUsage(live, [{ role: "user" }], 0), live);
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 999, output: 999, cacheRead: 999, cacheWrite: 999, cost: 999 }), { role: "user" }, assistant({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } })], 2), { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.2, turns: 1 });
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 2, output: 1, cacheRead: 3, cacheWrite: 4, cost: 0.25 }), assistant({ input: 4, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } })], 0), { input: 6, output: 4, cacheRead: 5, cacheWrite: 5, cost: 0.75, turns: 2 });
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: -1, inputTokens: 5, output: Number.NaN, outputTokens: 2, cacheRead: 0, cacheWriteTokens: 1, cost: { total: 0 } })], 0), { input: 5, output: 2, cacheRead: 0, cacheWrite: 1, cost: 0, turns: 1 });
		assert.deepEqual(reconcileAttemptUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 }, [assistant({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, cost: 0.25 })], 0), { input: 5, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.25, turns: 1 });
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })], 0), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 }), assistant({ input: 2, output: "bad", cacheRead: -1, cacheWrite: 2, cost: {} })], 0), { input: 3, output: 10, cacheRead: 3, cacheWrite: 3, cost: 2, turns: 2 });
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 }, 10), assistant({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 }, 10), assistant({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 }, 11)], 0), { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cost: 10, turns: 2 });
		assert.equal(reconcileAttemptUsage(live, [assistant({ input: 1 }, 10), { role: "user" }, assistant({ input: 1 }, 10)], 0).turns, 2, "only adjacent duplicate projections collapse");
		assert.equal(reconcileAttemptUsage(live, [assistant({ input: 1 }), assistant({ input: 1 })], 0).turns, 2, "messages without timestamp identity remain distinct");
		assert.deepEqual(reconcileAttemptUsage(live, [assistant({ input: 1 }, 10)], 2), live, "contracted message lists retain live evidence");
	});
});
