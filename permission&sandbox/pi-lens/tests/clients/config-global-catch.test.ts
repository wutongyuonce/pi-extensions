/**
 * The LAST silent drop in the global config loader (#2426 review round 5, S-C).
 *
 * #2445 fixed the read/parse half: an unreadable or unparsable
 * `~/.pi-lens/config.json` now reports under `lens-config` instead of being
 * mislabelled by the LSP loader. Everything AFTER the parse — the resolution
 * through `config-core` and the field-by-field projection — was still wrapped
 * in a bare `catch { return undefined; }`, so a throw anywhere in it dropped
 * the WHOLE global config with no log line, no ledger row and no
 * notification. pi-lens ran on defaults and said nothing, which is the exact
 * shape #2445 was filed for.
 *
 * The throw is INJECTED at the seam the body calls, because no config file can
 * reach it today — `resolveConfig` is contractually non-throwing and the
 * projection reads plain `JSON.parse` output. That is the point: the guard is
 * a floor, and a floor that swallows is worse than no floor. The probe asserts
 * what the floor does when it catches, not that a particular input reaches it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { removeTempDirSync } from "./test-utils.js";

const notices: string[] = [];
const ledgerRows: Array<{ kind: string; subject: string; code?: string }> = [];
const fault = vi.hoisted(() => ({ throwOnResolve: false }));

vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			notices.push(entry.message);
		},
	};
});

vi.mock("../../clients/user-notify.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/user-notify.js")>();
	return { ...actual, notifyUserDegradation: () => {} };
});

vi.mock("../../clients/degradation-ledger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/degradation-ledger.js")
		>();
	return {
		...actual,
		recordDegradationOnce: (entry: {
			kind: string;
			subject: string;
			code?: string;
		}) => {
			ledgerRows.push({
				kind: entry.kind,
				subject: entry.subject,
				...(entry.code === undefined ? {} : { code: entry.code }),
			});
		},
	};
});

// Fault injection at the ONE seam `loadPiLensGlobalConfig` calls inside its
// try block. Everything else in the module stays real, and the flag is off
// unless a case arms it, so no other test in this file sees a double.
vi.mock("../../clients/config-resolve.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/config-resolve.js")>();
	return {
		...actual,
		resolveOnePiLensConfigDocument: (
			...args: Parameters<typeof actual.resolveOnePiLensConfigDocument>
		) => {
			if (fault.throwOnResolve) {
				throw new RangeError("Maximum call stack size exceeded");
			}
			return actual.resolveOnePiLensConfigDocument(...args);
		},
	};
});

const roots: string[] = [];
let previousConfigPath: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
	notices.length = 0;
	ledgerRows.length = 0;
	fault.throwOnResolve = false;
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousHome = process.env.PI_LENS_HOME;
	resetIgnoredConfigWarnCache();
});

afterEach(() => {
	fault.throwOnResolve = false;
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetIgnoredConfigWarnCache();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

function globalConfigAt(prefix: string, value: unknown): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(home);
	const file = path.join(home, ".pi-lens", "config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
	process.env.PI_LENS_CONFIG_PATH = file;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	return file;
}

describe("S-C: a post-parse failure in the global loader is not silent", () => {
	it("reports the dropped global config under lens-config with a stable code", async () => {
		const file = globalConfigAt("pi-lens-sc-", { ignore: ["dist/**"] });
		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();

		fault.throwOnResolve = true;
		expect(loadPiLensGlobalConfig(file)).toBeUndefined();

		const reported = notices.filter(
			(message) =>
				message.includes("ignoring invalid global config") &&
				message.includes(file),
		);
		expect(
			reported,
			`notices for a post-parse failure: ${JSON.stringify(notices)}`,
		).toHaveLength(1);
		// The error CLASS, never its message — the same rule the core's own
		// internal-failure record follows, for the same reason: the message can
		// quote the file.
		expect(reported[0]).toContain("RangeError");
		expect(reported[0]).toContain("configuration ignored");

		const rows = ledgerRows.filter((row) => row.kind === "config-ignored");
		expect(rows, `ledger rows: ${JSON.stringify(ledgerRows)}`).toHaveLength(1);
		expect(rows[0]?.subject).toBe(file);
		// A WHOLE-config failure, so the whole-config code (#2426 review round 6,
		// S1) — never `PILENS_CFG_0005`, which is registered as a per-FIELD
		// rejection and would tell a user matching on it that one setting is
		// missing rather than all of them.
		expect(rows[0]?.code).toBe("PILENS_CFG_0008");
	});

	it("leaves a healthy global config unreported", async () => {
		const file = globalConfigAt("pi-lens-sc-ok-", { ignore: ["dist/**"] });
		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();

		expect(loadPiLensGlobalConfig(file)?.ignore).toEqual(["dist/**"]);
		expect(
			notices.filter((message) => message.includes(file)),
			`unexpected notices: ${JSON.stringify(notices)}`,
		).toEqual([]);
	});
});
