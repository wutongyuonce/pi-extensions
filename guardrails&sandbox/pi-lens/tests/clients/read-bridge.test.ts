/**
 * Tests for the generic read-recording bridge (clients/read-bridge.ts).
 *
 * Verifies:
 * - registerReadBridge mounts the bridge at globalThis[READ_BRIDGE_KEY]
 * - recordRead forwards entries into the read-guard with correct fields
 * - isRecordable gates forwarding (no-read-guard flag, scope checks)
 * - Second call to registerReadBridge is a no-op (singleton)
 * - turnIndex / writeIndex are sampled at call-time, not registration-time
 * - undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)
 *
 * Locked-bridge behaviour:
 * - global property is non-writable and non-configurable (TypeError on assign/delete)
 * - bridge object is frozen (TypeError on mutation)
 *
 * Adversarial / hardening cases:
 * - Malformed payloads (null, non-object, empty/non-string filePath,
 *   non-number/non-finite/non-integer/out-of-range offsets and limits) are
 *   silently dropped
 * - timestamp is always stamped by the bridge (Date.now()), never caller-supplied
 * - bridge.version is 1
 * - consumer field sets source provenance in forwarded record
 * - Full read-then-edit authorization path: bridge-registered read unblocks
 *   a subsequent edit that would otherwise be blocked
 *
 * ## Test structure
 *
 * The bridge is registered with `configurable: false` — once set the global
 * property cannot be deleted or reconfigured between tests. To handle this:
 *
 * - The "bridge absent" assertion runs as a top-level `it` BEFORE the describe
 *   that owns `beforeAll`, so it executes before registration fires.
 * - All other tests live inside a single `describe` whose `beforeAll` registers
 *   the bridge once using closures that delegate to mutable per-test state.
 * - `beforeEach` resets that mutable state — it never touches the global.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	READ_BRIDGE_KEY,
	type ReadBridge,
	type ReadBridgeEntry,
	registerReadBridge,
} from "../../clients/read-bridge.js";
import type { ReadContentBinding } from "../../clients/read-guard.js";
import {
	_currentContentMatchesBindingForTests,
	captureReadContentBinding,
	ReadGuard,
} from "../../clients/read-guard.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

type RecordReadArgs = {
	filePath: string;
	requestedOffset: number;
	requestedLimit: number;
	effectiveOffset: number;
	effectiveLimit: number;
	expandedByLsp: boolean;
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
	source?: string;
	contentBinding?: ReadContentBinding;
};

// ── Shared mutable per-test bridge state ─────────────────────────────────────
//
// Registered once in beforeAll; each test resets these in beforeEach.

let _calls: RecordReadArgs[];
let _guardFn: (r: RecordReadArgs) => void;
let _turnIndex: number;
let _writeIndex: number;
let _isRecordable: (fp: string) => boolean;

/** A well-formed entry that always passes validation. */
function validEntry(overrides: Partial<ReadBridgeEntry> = {}): ReadBridgeEntry {
	return {
		filePath: "/project/src/main.go",
		requestedOffset: 10,
		requestedLimit: 50,
		...overrides,
	};
}

// ── Bridge absent — must run before the describe below fires its beforeAll ───

it("bridge is absent before registerReadBridge is called", () => {
	expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(false);
});

// ── All other tests — bridge registered once, state reset per test ───────────

describe("read-bridge", () => {
	beforeAll(() => {
		registerReadBridge({
			getReadGuard: () => ({
				recordRead: (r: RecordReadArgs) => {
					_guardFn(r);
					_calls.push(r);
				},
			}),
			getTurnIndex: () => _turnIndex,
			peekWriteIndex: () => _writeIndex,
			isRecordable: (fp) => _isRecordable(fp),
		});
	});

	beforeEach(() => {
		_calls = [];
		_guardFn = vi.fn();
		_turnIndex = 0;
		_writeIndex = 0;
		_isRecordable = () => true;
	});

	// ── Bridge metadata ──────────────────────────────────────────────────────

	it("bridge is defined after registration", () => {
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBeDefined();
	});

	it("bridge.version is 1", () => {
		const bridge: ReadBridge = (globalThis as any)[READ_BRIDGE_KEY];
		expect(bridge.version).toBe(1);
	});

	// ── Locked-bridge behaviour ──────────────────────────────────────────────

	it("global is non-writable — assigning throws", () => {
		const original = (globalThis as any)[READ_BRIDGE_KEY];
		expect(() => {
			(globalThis as any)[READ_BRIDGE_KEY] = {};
		}).toThrow(TypeError);
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBe(original);
	});

	it("global is non-configurable — delete throws", () => {
		expect(() => {
			// In strict mode (TS modules) deleting a non-configurable property
			// throws; verify the global is still intact afterwards.
			delete (globalThis as any)[READ_BRIDGE_KEY];
		}).toThrow(TypeError);
		expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(true);
	});

	it("bridge object is frozen — adding or replacing a property throws", () => {
		const bridge: ReadBridge = (globalThis as any)[READ_BRIDGE_KEY];
		expect(() => {
			(bridge as any).recordRead = () => {};
		}).toThrow(TypeError);
		expect(() => {
			(bridge as any).newProp = "x";
		}).toThrow(TypeError);
	});

	// ── First-wins registration ──────────────────────────────────────────────

	it("second call to registerReadBridge is a no-op — first registration wins", () => {
		const separateGuard = { recordRead: vi.fn() };
		registerReadBridge({
			getReadGuard: () => separateGuard,
			getTurnIndex: () => 99,
			peekWriteIndex: () => 99,
			isRecordable: () => true,
		});

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: "/a.ts" }),
		);

		// Original bridge captured the call
		expect(_guardFn).toHaveBeenCalledOnce();
		// The ignored second registration's guard was never invoked
		expect(separateGuard.recordRead).not.toHaveBeenCalled();
	});

	// ── Baseline forwarding ──────────────────────────────────────────────────

	it("recordRead forwards the entry into the read-guard with correct fields", () => {
		_turnIndex = 3;
		_writeIndex = 7;
		const before = Date.now();

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ requestedOffset: 10, requestedLimit: 50 }),
		);

		expect(_guardFn).toHaveBeenCalledOnce();
		const call = _calls[0];
		expect(call.filePath).toBe("/project/src/main.go");
		expect(call.requestedOffset).toBe(10);
		expect(call.requestedLimit).toBe(50);
		expect(call.effectiveOffset).toBe(10);
		expect(call.effectiveLimit).toBe(50);
		expect(call.expandedByLsp).toBe(false);
		expect(call.turnIndex).toBe(3);
		expect(call.writeIndex).toBe(7);
		expect(call.timestamp).toBeGreaterThanOrEqual(before);
		expect(call.timestamp).toBeLessThanOrEqual(Date.now());
	});

	it("undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)", () => {
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ requestedLimit: undefined }),
		);
		expect(_calls[0].requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		expect(_calls[0].effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isRecordable returning false suppresses forwarding", () => {
		_isRecordable = () => false;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry());
		expect(_guardFn).not.toHaveBeenCalled();
	});

	it("isRecordable receives the entry filePath", () => {
		const seen: string[] = [];
		_isRecordable = (fp) => {
			seen.push(fp);
			return true;
		};
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: "/project/checked.ts" }),
		);
		expect(seen).toEqual(["/project/checked.ts"]);
	});

	it("turnIndex and writeIndex are sampled at call-time, not registration-time", () => {
		_turnIndex = 5;
		_writeIndex = 2;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: "/a.ts" }),
		);
		expect(_calls[0].turnIndex).toBe(5);
		expect(_calls[0].writeIndex).toBe(2);

		_turnIndex = 9;
		_writeIndex = 4;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: "/b.ts" }),
		);
		expect(_calls[1].turnIndex).toBe(9);
		expect(_calls[1].writeIndex).toBe(4);
	});

	// ── Malformed payload validation ─────────────────────────────────────────

	describe("malformed payloads", () => {
		it("null entry is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(null);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-object entry (string) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead("not-an-object");
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("empty filePath is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: "" }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("numeric filePath is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				filePath: 42 as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = 0 (below minimum) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: 0 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = NaN is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: NaN }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = Infinity is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: Infinity }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-integer requestedOffset (1.5) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: 1.5 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("string requestedOffset is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				requestedOffset: "10" as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = 0 (below minimum) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: 0 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = NaN is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: NaN }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = Infinity is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: Infinity }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("string requestedLimit is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				requestedLimit: "50" as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-integer requestedLimit (3.7) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: 3.7 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});
	});

	// ── Consumer provenance ──────────────────────────────────────────────────

	describe("consumer provenance", () => {
		it('source defaults to "bridge:unknown" when consumer is omitted', () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry());
			expect(_calls[0].source).toBe("bridge:unknown");
		});

		it('source is "bridge:<consumer>" when consumer is provided', () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ consumer: "my-extension" }),
			);
			expect(_calls[0].source).toBe("bridge:my-extension");
		});
	});

	// ── Full read-then-edit authorization path ───────────────────────────────

	describe("read-then-edit authorization path", () => {
		it("rejects a same-length mutation through the content-binding verifier itself", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-"));
			try {
				const filePath = join(dir, "binding.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const binding = captureReadContentBinding(filePath, 1, 1);
				expect(binding).toBeDefined();
				writeFileSync(filePath, "const value = 2;\n", "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					false,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("range bindings cap at 3,000 lines with inclusive boundaries", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-range-"));
			try {
				const filePath = join(dir, "large.ts");
				const original = Array.from(
					{ length: 3_101 },
					(_, i) => `line ${i + 1}`,
				);
				writeFileSync(filePath, original.join("\n"), "utf-8");
				const binding = captureReadContentBinding(filePath, 1, 3_101);
				expect(binding).toMatchObject({
					fullFile: false,
					offset: 1,
					limit: 3_000,
				});

				for (const lineNumber of [1, 3_000]) {
					const mutated = [...original];
					mutated[lineNumber - 1] = `MUTATED ${lineNumber}`;
					writeFileSync(filePath, mutated.join("\n"), "utf-8");
					expect(
						_currentContentMatchesBindingForTests(filePath, binding!),
					).toBe(false);
				}

				const outside = [...original];
				outside[3_000] = "MUTATED 3001";
				writeFileSync(filePath, outside.join("\n"), "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					true,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("range binding hashes are coherent across LF and CRLF", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-eol-"));
			try {
				const filePath = join(dir, "large.ts");
				const lines = Array.from({ length: 3_001 }, (_, i) => `line ${i + 1}`);
				writeFileSync(filePath, lines.join("\r\n"), "utf-8");
				const binding = captureReadContentBinding(filePath, 2, 10);
				expect(binding?.fullFile).toBe(false);
				writeFileSync(filePath, lines.join("\n"), "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					true,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("skips binding capture above the 4 MiB hot-path ceiling", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-size-"));
			try {
				const filePath = join(dir, "oversized.ts");
				writeFileSync(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf-8");
				expect(captureReadContentBinding(filePath, 1, 1)).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("allows verification when bridge-bound disk content is unchanged", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-"));
			try {
				const filePath = join(dir, "green.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const guard = new ReadGuard("bridge-green", { mode: "block" });
				_guardFn = (record) => guard.recordRead(record);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead(
					validEntry({
						filePath,
						requestedOffset: 1,
						requestedLimit: undefined,
					}),
				);
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("blocks verification when bridge-bound disk content has mutated", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-"));
			try {
				const filePath = join(dir, "mutated.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const guard = new ReadGuard("bridge-mismatch", { mode: "block" });
				_guardFn = (record) => guard.recordRead(record);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead(
					validEntry({
						filePath,
						requestedOffset: 1,
						requestedLimit: undefined,
					}),
				);
				// Isolate the binding path: FileTime must report unchanged so it cannot
				// mask a broken hash comparison with its own stale-file rejection.
				const fileTime = (
					guard as unknown as { fileTime: { hasChanged: () => boolean } }
				).fileTime;
				fileTime.hasChanged = vi.fn(() => false);
				writeFileSync(filePath, "const value = 2;\n", "utf-8");
				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("bridge-registered read forwards all fields the guard needs to authorize a subsequent edit", () => {
			_turnIndex = 1;
			_writeIndex = 0;
			const filePath = "/project/src/handler.ts";
			const beforeCall = Date.now();

			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({
					filePath,
					requestedOffset: 1,
					requestedLimit: 100,
					consumer: "test-ext",
				}),
			);

			expect(_guardFn).toHaveBeenCalledOnce();
			const read = _calls[0];
			expect(read.filePath).toBe(filePath);
			expect(read.requestedOffset).toBe(1);
			expect(read.requestedLimit).toBe(100);
			expect(read.effectiveOffset).toBe(1);
			expect(read.effectiveLimit).toBe(100);
			expect(read.expandedByLsp).toBe(false);
			expect(read.turnIndex).toBe(1);
			expect(read.writeIndex).toBe(0);
			expect(read.timestamp).toBeGreaterThanOrEqual(beforeCall);
			expect(read.timestamp).toBeLessThanOrEqual(Date.now());
			expect(read.source).toBe("bridge:test-ext");
		});

		it("a read for file A does not authorize edits on file B", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: "/project/a.ts" }),
			);
			expect(_guardFn).toHaveBeenCalledOnce();
			expect(_calls[0].filePath).toBe("/project/a.ts");
			const readsForB = _calls.filter((c) => c.filePath === "/project/b.ts");
			expect(readsForB).toHaveLength(0);
		});

		it("multiple reads on the same file are all forwarded", () => {
			const bridge = (globalThis as any)[READ_BRIDGE_KEY];
			const filePath = "/project/big.ts";
			bridge.recordRead(
				validEntry({ filePath, requestedOffset: 1, requestedLimit: 50 }),
			);
			bridge.recordRead(
				validEntry({ filePath, requestedOffset: 51, requestedLimit: 50 }),
			);
			bridge.recordRead(
				validEntry({
					filePath,
					requestedOffset: 101,
					requestedLimit: undefined,
				}),
			);
			expect(_guardFn).toHaveBeenCalledTimes(3);
			expect(_calls[0].requestedOffset).toBe(1);
			expect(_calls[1].requestedOffset).toBe(51);
			expect(_calls[2].requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		});
	});
});
