/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `SecurityScanClient.dedupeScan` (base for gitleaks/trivy/govulncheck) cleared
 * its `inFlight` entry with a bare delete-by-key. The race needs a SECOND
 * WRITER replacing the map entry mid-flight — the public API alone cannot
 * produce it today (single set site; microtask FIFO orders every observer
 * after A's cleanup) — so this test simulates that writer directly, exactly
 * the mechanism the #1838 reachability probe established for the original two
 * sites. Red on the pre-fix bare `.finally` delete: A's cleanup evicted B and
 * the third caller started a duplicate scan.
 */

import { describe, expect, it } from "vitest";
import { SecurityScanClient } from "../../clients/security-scan-client.js";
import { gatedPromise } from "../support/fault-injection.js";

class ProbeScanClient extends SecurityScanClient<{ ok: boolean }> {
	constructor() {
		super("probe-tool", false);
	}
	protected async doEnsureAvailable(): Promise<boolean> {
		return true;
	}
	runCount = 0;
	run: (() => Promise<{ ok: boolean }>) | null = null;
	scan(key: string): Promise<{ ok: boolean }> {
		return this.dedupeScan(key, () => {
			this.runCount += 1;
			return this.run!();
		});
	}
	get flights(): Map<string, Promise<{ ok: boolean }>> {
		return this.inFlight;
	}
}

describe("SecurityScanClient dedupeScan in-flight ABA release (#1968)", () => {
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	it("a late-settling scan does not evict its mid-flight successor", async () => {
		const client = new ProbeScanClient();
		const gateA = gatedPromise<{ ok: boolean }>();
		let calls = 0;
		client.run = () => {
			calls += 1;
			return calls === 1
				? gateA.promise
				: gatedPromise<{ ok: boolean }>().promise;
		};

		void client.scan("/probe-root"); // scan A in flight
		await tick();
		expect(client.flights.size).toBe(1);
		const key = [...client.flights.keys()][0]!;

		// B replaces the entry under the same key while A is still in flight.
		const successor = gatedPromise<{ ok: boolean }>();
		client.flights.set(key, successor.promise);

		gateA.resolve({ ok: true }); // A settles late
		await tick();
		await tick();

		// B's entry survived A's cleanup...
		expect(client.flights.get(key)).toBe(successor.promise);
		// ...and a third caller SHARES B instead of starting a duplicate scan.
		void client.scan("/probe-root");
		await tick();
		expect(client.runCount).toBe(1);

		successor.resolve({ ok: true });
	});

	it("a normally-settling scan still cleans up its own entry", async () => {
		const client = new ProbeScanClient();
		client.run = async () => ({ ok: true });

		await client.scan("/probe-root");
		await tick();
		expect(client.flights.size).toBe(0);
	});
});
