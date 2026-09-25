import { describe, expect, it } from "vitest";

import { createSingleFlight } from "../../clients/single-flight.js";

/**
 * A promise you settle by hand, so a test can hold a flight open and observe
 * what the primitive does while it is running.
 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let every already-queued microtask run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("singleFlight — sharing", () => {
	it("runs fn once for N concurrent callers and gives them all the same value", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		const gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const callers = Array.from({ length: 10 }, () => sf.run("k", fn));
		await flush();
		expect(calls).toBe(1);
		expect(sf.size()).toBe(1);

		gate.resolve(42);
		expect(await Promise.all(callers)).toEqual(Array(10).fill(42));
		expect(calls).toBe(1);
	});

	it("keys independently — different keys do not share a flight", async () => {
		const sf = createSingleFlight<string>();
		const seen: string[] = [];
		const fn = (id: string) => async () => {
			seen.push(id);
			return id;
		};
		const [a, b] = await Promise.all([
			sf.run("a", fn("a")),
			sf.run("b", fn("b")),
		]);
		expect([a, b]).toEqual(["a", "b"]);
		expect(seen.sort()).toEqual(["a", "b"]);
	});
});

describe("singleFlight — clear in finally", () => {
	it("frees the key on success, so the next call re-executes", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		const fn = async () => ++calls;

		expect(await sf.run("k", fn)).toBe(1);
		// The key must already be free the instant an awaiting caller resumes.
		// Releasing in a plain `.finally()` would let this line join the flight
		// that just finished and return its settled value — #1690's leak
		// reintroduced by scheduling rather than by a missing clear.
		expect(sf.has("k")).toBe(false);
		expect(await sf.run("k", fn)).toBe(2);
		expect(calls).toBe(2);
	});

	it("frees the key on rejection rather than wedging it", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		const fn = async () => {
			calls++;
			if (calls === 1) throw new Error("probe blew up");
			return calls;
		};

		await expect(sf.run("k", fn)).rejects.toThrow("probe blew up");
		expect(sf.has("k")).toBe(false);
		// A wedged key would hand this caller the FIRST call's settled rejection
		// forever, and the tool behind it would never be probed again.
		expect(await sf.run("k", fn)).toBe(2);
	});

	it("rejects every concurrent caller with the same error, once", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		const gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const callers = Array.from({ length: 5 }, () => sf.run("k", fn));
		await flush();
		const boom = new Error("boom");
		gate.reject(boom);
		const settled = await Promise.allSettled(callers);
		expect(settled.every((s) => s.status === "rejected")).toBe(true);
		expect(settled.map((s) => (s as PromiseRejectedResult).reason)).toEqual(
			Array(5).fill(boom),
		);
		expect(calls).toBe(1);
		expect(sf.size()).toBe(0);
	});
});

describe("singleFlight — generation supersedes", () => {
	it("does not serve a pre-reset flight to a post-reset caller", async () => {
		let generation = 0;
		const sf = createSingleFlight<string>({ generation: () => generation });

		const stale = deferred<string>();
		let calls = 0;
		const stalePromise = sf.run("k", () => {
			calls++;
			return stale.promise;
		});
		await flush();
		expect(calls).toBe(1);

		// A session reset that bumps the generation WITHOUT clearing the map —
		// the case the eviction-side check cannot see, and the reason this option
		// exists at all. The pre-reset flight answers a question the reset
		// invalidated, so joining it would serve a stale verdict.
		generation = 1;

		const fresh = deferred<string>();
		const freshPromise = sf.run("k", () => {
			calls++;
			return fresh.promise;
		});
		await flush();
		expect(calls).toBe(2);
		expect(freshPromise).not.toBe(stalePromise);

		fresh.resolve("fresh");
		expect(await freshPromise).toBe("fresh");

		// The superseded flight settles last and must not evict anything, but its
		// replacement has already been released by then, so assert the pair
		// directly: the key is free and no exception escaped.
		stale.resolve("stale");
		expect(await stalePromise).toBe("stale");
		expect(sf.has("k")).toBe(false);
	});

	it("still shares within one generation", async () => {
		const generation = 3;
		const sf = createSingleFlight<number>({ generation: () => generation });
		let calls = 0;
		const gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};
		const callers = [sf.run("k", fn), sf.run("k", fn), sf.run("k", fn)];
		await flush();
		expect(calls).toBe(1);
		gate.resolve(9);
		expect(await Promise.all(callers)).toEqual([9, 9, 9]);
	});
});

describe("singleFlight — never clears a successor", () => {
	it("does not evict a newer-generation flight when a stale one settles (#1674)", async () => {
		let generation = 0;
		const sf = createSingleFlight<string>({ generation: () => generation });

		const stale = deferred<string>();
		const stalePromise = sf.run("k", () => stale.promise);
		expect(sf.has("k")).toBe(true);

		// A session reset: drop the claim on the old flight and bump the
		// generation, exactly as `resetDispatchAvailabilityState` does.
		sf.clear();
		generation = 1;

		const fresh = deferred<string>();
		const freshPromise = sf.run("k", () => fresh.promise);
		expect(sf.size()).toBe(1);

		// The old-generation flight settles LAST. It must not delete the entry
		// the new session already installed under the same key.
		stale.resolve("stale");
		expect(await stalePromise).toBe("stale");
		expect(sf.has("k")).toBe(true);

		fresh.resolve("fresh");
		expect(await freshPromise).toBe("fresh");
		expect(sf.has("k")).toBe(false);
	});

	it("does not evict a successor started in the SAME generation", async () => {
		// No generation callback at all — the identity check alone must carry
		// this case, which is why both checks exist.
		const sf = createSingleFlight<string>();

		const stale = deferred<string>();
		const stalePromise = sf.run("k", () => stale.promise);
		sf.clear();

		const fresh = deferred<string>();
		const freshPromise = sf.run("k", () => fresh.promise);
		expect(sf.size()).toBe(1);

		stale.resolve("stale");
		expect(await stalePromise).toBe("stale");
		expect(sf.has("k")).toBe(true);

		fresh.resolve("fresh");
		await freshPromise;
		expect(sf.has("k")).toBe(false);
	});

	it("does not evict a successor when the stale flight REJECTS", async () => {
		let generation = 0;
		const sf = createSingleFlight<string>({ generation: () => generation });

		const stale = deferred<string>();
		const stalePromise = sf.run("k", () => stale.promise);
		sf.clear();
		generation = 1;

		const fresh = deferred<string>();
		const freshPromise = sf.run("k", () => fresh.promise);

		stale.reject(new Error("stale failed"));
		await expect(stalePromise).rejects.toThrow("stale failed");
		expect(sf.has("k")).toBe(true);

		fresh.resolve("fresh");
		await freshPromise;
	});
});

describe("singleFlight — trailing-rerun coalescing (#1687)", () => {
	it("coalesces 10 mid-flight requests into EXACTLY one trailing rerun", async () => {
		const sf = createSingleFlight<number>({ coalesceTrailing: true });
		let calls = 0;
		let gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const first = sf.run("k", fn);
		await flush();
		expect(calls).toBe(1);

		const joiners = Array.from({ length: 10 }, () => sf.run("k", fn));
		await flush();
		// Still one pass: the burst set the rerun bit, it did not start passes.
		expect(calls).toBe(1);

		const pass1 = gate;
		gate = deferred<number>();
		pass1.resolve(1);
		await flush();
		// Pinned on BOTH sides. `toBeLessThanOrEqual(2)` — #1687's original
		// assertion — is also satisfied by a coalescer that drops the rerun
		// entirely, which is how that bit shipped unpinned.
		expect(calls).toBe(2);

		gate.resolve(2);
		expect(await first).toBe(2);
		expect(await Promise.all(joiners)).toEqual(Array(10).fill(2));
		// And no third pass: nothing arrived during pass 2.
		expect(calls).toBe(2);
		expect(sf.size()).toBe(0);
	});

	it("does NOT rerun when nothing arrived mid-flight", async () => {
		const sf = createSingleFlight<number>({ coalesceTrailing: true });
		let calls = 0;
		expect(await sf.run("k", async () => ++calls)).toBe(1);
		expect(calls).toBe(1);
	});

	it("shares without rerunning when coalescing is off (the default)", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		const gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const first = sf.run("k", fn);
		await flush();
		const joiners = Array.from({ length: 10 }, () => sf.run("k", fn));
		await flush();
		gate.resolve(7);
		await Promise.all([first, ...joiners]);
		expect(calls).toBe(1);
	});

	it("runs the trailing rerun over a FRESH snapshot, not the burst's stale one", async () => {
		const sf = createSingleFlight<string[]>({ coalesceTrailing: true });
		// Stands in for `state.openDocuments`: the input the rerun must re-read.
		const openDocuments = ["a.ts"];
		const passes: string[][] = [];
		let gate = deferred<void>();
		const fn = async (): Promise<string[]> => {
			const snapshot = [...openDocuments];
			passes.push(snapshot);
			await gate.promise;
			return snapshot;
		};

		const first = sf.run("k", fn);
		await flush();
		// The event that caused the rerun also changed the input.
		openDocuments.push("b.ts");
		void sf.run("k", fn);
		await flush();

		const pass1 = gate;
		gate = deferred<void>();
		pass1.resolve();
		await flush();
		gate.resolve();

		expect(await first).toEqual(["a.ts", "b.ts"]);
		expect(passes).toEqual([["a.ts"], ["a.ts", "b.ts"]]);
	});

	it("gives a request arriving during the RERUN one more pass, not one per request", async () => {
		const sf = createSingleFlight<number>({ coalesceTrailing: true });
		let calls = 0;
		let gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const first = sf.run("k", fn);
		await flush();
		sf.run("k", fn).catch(() => {});
		sf.run("k", fn).catch(() => {});
		await flush();

		let pass = gate;
		gate = deferred<number>();
		pass.resolve(1);
		await flush();
		expect(calls).toBe(2);

		// Three requests during pass 2 earn ONE pass 3 between them.
		sf.run("k", fn).catch(() => {});
		sf.run("k", fn).catch(() => {});
		sf.run("k", fn).catch(() => {});
		pass = gate;
		gate = deferred<number>();
		pass.resolve(2);
		await flush();
		expect(calls).toBe(3);

		gate.resolve(3);
		expect(await first).toBe(3);
		expect(calls).toBe(3);
	});

	it("abandons a pending rerun when a pass rejects, and still frees the key", async () => {
		const sf = createSingleFlight<number>({ coalesceTrailing: true });
		let calls = 0;
		const gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const first = sf.run("k", fn);
		await flush();
		const joiner = sf.run("k", fn);
		await flush();
		expect(calls).toBe(1);

		gate.reject(new Error("pass 1 failed"));
		await expect(first).rejects.toThrow("pass 1 failed");
		await expect(joiner).rejects.toThrow("pass 1 failed");
		// No blind retry of work that just threw, and no wedged key either.
		expect(calls).toBe(1);
		expect(sf.has("k")).toBe(false);
	});

	it("propagates a REJECTED trailing rerun to every caller and frees the key", async () => {
		const sf = createSingleFlight<number>({ coalesceTrailing: true });
		let calls = 0;
		let gate = deferred<number>();
		const fn = () => {
			calls++;
			return gate.promise;
		};

		const first = sf.run("k", fn);
		await flush();
		const joiner = sf.run("k", fn);
		await flush();

		const pass1 = gate;
		gate = deferred<number>();
		pass1.resolve(1);
		await flush();
		expect(calls).toBe(2);

		gate.reject(new Error("rerun failed"));
		await expect(first).rejects.toThrow("rerun failed");
		await expect(joiner).rejects.toThrow("rerun failed");
		expect(sf.has("k")).toBe(false);
	});
});

describe("singleFlight — reentrancy", () => {
	it("shares with a caller that reenters SYNCHRONOUSLY from inside fn", async () => {
		const sf = createSingleFlight<number>();
		let calls = 0;
		let inner: Promise<number> | null = null;
		const fn = async (): Promise<number> => {
			calls++;
			// The map entry must already be published, carrying a real pending
			// promise, before `fn` gets to run. Publishing it after the work
			// starts — what every hand-rolled site does — leaves this window open.
			if (calls === 1) inner = sf.run("k", fn);
			return calls;
		};

		const outer = await sf.run("k", fn);
		expect(calls).toBe(1);
		expect(outer).toBe(1);
		expect(await inner).toBe(1);
	});
});
