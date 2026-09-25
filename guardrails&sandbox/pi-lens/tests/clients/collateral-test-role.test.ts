import { afterEach, describe, expect, it, vi } from "vitest";

// The shared collateral test-role predicate (#1080). Kept in its OWN module so
// the fail-open honesty case can mock `file-role.js` to throw without disturbing
// the real classifier used by the cascade/integration suites.

describe("isTestRoleCollateral — classifier-positive coverage", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("../../clients/file-role.js");
	});

	it("recognizes the same test names/locations detectFileRole already classifies", async () => {
		const { isTestRoleCollateral } =
			await import("../../clients/collateral-test-role.js");
		// name-based
		expect(isTestRoleCollateral("/repo/src/foo.test.ts")).toBe(true);
		expect(isTestRoleCollateral("/repo/src/foo.spec.ts")).toBe(true);
		expect(isTestRoleCollateral("/repo/pkg/test_widget.py")).toBe(true);
		expect(isTestRoleCollateral("/repo/pkg/spec_widget.rb")).toBe(true);
		// location-based (forward slash — production always feeds native-separator
		// paths, which on POSIX means `/`; detectFileRole's directory match relies
		// on the OS's own path.dirname, so a foreign-separator directory path is an
		// OS-specific artifact never produced in real dispatch).
		expect(isTestRoleCollateral("/repo/src/__tests__/sub/foo.ts")).toBe(true);
		expect(isTestRoleCollateral("/repo/tests/foo.ts")).toBe(true);
		expect(isTestRoleCollateral("/repo/spec/foo.ts")).toBe(true);
		// NAME-based detection is separator-agnostic on every OS: a `.test.`
		// basename is matched via a substring check on the whole path, so a
		// Windows-style backslash path still classifies on Linux CI too. (A
		// backslash DIRECTORY path — e.g. `\__tests__\` — is deliberately NOT
		// asserted here: its detection depends on win32 `path.dirname`, so it is
		// genuinely OS-specific and would vacuously fail on POSIX; #1024 discipline.)
		expect(isTestRoleCollateral("C:\\repo\\src\\foo.test.ts")).toBe(true);
	});

	it("retains ordinary source / init files (non-test roles)", async () => {
		const { isTestRoleCollateral } =
			await import("../../clients/collateral-test-role.js");
		expect(isTestRoleCollateral("/repo/src/foo.ts")).toBe(false);
		expect(isTestRoleCollateral("/repo/src/index.ts")).toBe(false);
		expect(isTestRoleCollateral("/repo/pkg/widget.py")).toBe(false);
		// A file that merely mentions "test" in the name but isn't a test file.
		expect(isTestRoleCollateral("/repo/src/attestation.ts")).toBe(false);
	});

	it("fail-open: a classifier throw RETAINS the candidate (never a silent drop)", async () => {
		vi.doMock("../../clients/file-role.js", () => ({
			detectFileRole: () => {
				throw new Error("role classification unavailable");
			},
		}));
		const { isTestRoleCollateral } =
			await import("../../clients/collateral-test-role.js");
		// Even a path that "looks" like a test is RETAINED when the role decision
		// cannot be obtained — #1080 honesty rule (no false clean, no invented
		// heuristic).
		expect(isTestRoleCollateral("/repo/src/foo.test.ts")).toBe(false);
		expect(isTestRoleCollateral("/repo/src/foo.ts")).toBe(false);
	});
});
