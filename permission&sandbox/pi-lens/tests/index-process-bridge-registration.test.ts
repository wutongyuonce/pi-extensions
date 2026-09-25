/**
 * #2437 — both `clients/read-bridge.ts` and `clients/mutation-bridge.ts` now
 * delegate their mount body to the shared `clients/process-bridge.ts`
 * helper. `tests/clients/{read,mutation}-bridge.test.ts` drive
 * `registerReadBridge`/`registerMutationBridge` with hand-built deps objects,
 * bypassing `index.ts`'s wiring entirely; this file drives the REAL
 * extension factory through `tests/support/pi-mock.ts` so a regression in
 * how `index.ts` calls the shared helper (not just in the helper itself, or
 * in an isolated bridge module) is caught here.
 *
 * `registerReadBridge`/`registerMutationBridge` run synchronously inside
 * `activateExtension`, unconditional on any event — activating the mock host
 * is enough to trigger both.
 */
import { describe, expect, it } from "vitest";
import {
	getMutationBridge,
	MUTATION_BRIDGE_KEY,
} from "../clients/mutation-bridge.js";
import { READ_BRIDGE_KEY } from "../clients/read-bridge.js";
import extension from "../index.js";
import { createPiMock } from "./support/pi-mock.js";

// Runs before the describe below activates the extension — each test FILE
// gets a fresh child process (vitest forks pool, `isolate: true`), so
// `globalThis` here has never seen either bridge key yet.
it("neither bridge is mounted before the extension activates", () => {
	expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(false);
	expect(MUTATION_BRIDGE_KEY in (globalThis as object)).toBe(false);
});

describe("process-bridge registration through the real extension factory (#2437)", () => {
	it("mounts the read bridge via the shared helper, version 1, frozen", () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(true);
		const bridge = (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY] as
			| { version: number; recordRead: unknown }
			| undefined;
		expect(bridge?.version).toBe(1);
		expect(typeof bridge?.recordRead).toBe("function");
		expect(Object.isFrozen(bridge)).toBe(true);
	});

	it("mounts the mutation bridge via the shared helper, reachable through getMutationBridge", () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		expect(MUTATION_BRIDGE_KEY in (globalThis as object)).toBe(true);
		const mounted = getMutationBridge();
		expect(mounted?.version).toBe(1);
		expect(typeof mounted?.recordMutation).toBe("function");
	});

	it("is first-wins across activations, same contract for both bridges", () => {
		// A second activation (a re-activation / secondary in-process session,
		// #473) must not replace either mount.
		const readBefore = (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY];
		const mutationBefore = getMutationBridge();

		const second = createPiMock();
		extension(second.asExtensionAPI());

		expect((globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY]).toBe(
			readBefore,
		);
		expect(getMutationBridge()).toBe(mutationBefore);
	});

	it("the mounted properties are non-writable and non-configurable", () => {
		expect(() => {
			(globalThis as Record<symbol, unknown>)[MUTATION_BRIDGE_KEY] = {};
		}).toThrow(TypeError);
		expect(() => {
			delete (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY];
		}).toThrow(TypeError);
	});
});
