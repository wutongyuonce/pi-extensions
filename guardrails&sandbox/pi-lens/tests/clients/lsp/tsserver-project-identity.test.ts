import { beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

import {
	probeTsserverProjectIdentity,
	type TsserverProjectIdentityCommandChannel,
} from "../../../clients/lsp/tsserver-sync.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

function options(
	executeCommand: NonNullable<
		TsserverProjectIdentityCommandChannel["executeCommand"]
	>,
) {
	return {
		serverId: "typescript",
		launchVariant: "classic" as const,
		clientRoot: "/repo",
		file: "/repo/src/app.ts",
		probedFiles: new Set<string>(),
		commandChannel: { executeCommand },
	};
}

describe("classic TypeScript project-identity telemetry (#1412)", () => {
	beforeEach(() => {
		logLatency.mockReset();
	});

	it("logs a configured project after a successful projectInfo response", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: {
				success: true,
				body: {
					configFileName: "/repo/tsconfig.json",
					languageServiceDisabled: false,
				},
			},
		});
		await probeTsserverProjectIdentity(options(executeCommand));

		expect(executeCommand).toHaveBeenCalledWith("typescript.tsserverRequest", [
			"projectInfo",
			{ file: "/repo/src/app.ts", needFileNameList: false },
		]);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_typescript_project_identity",
				filePath: normalizeMapKey("/repo/src/app.ts"),
				metadata: expect.objectContaining({
					serverId: "typescript",
					launchVariant: "classic",
					clientRoot: "/repo",
					projectKind: "configured",
					configFile: "/repo/tsconfig.json",
					association: "associated",
				}),
			}),
		);
	});

	it("classifies the inferred-project sentinel", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		});
		await probeTsserverProjectIdentity(options(executeCommand));

		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					projectKind: "inferred",
					association: "associated",
				}),
			}),
		);
	});

	it.each([
		[
			"error",
			"threw",
			vi.fn().mockRejectedValue(new Error("projectInfo failed")),
		],
		[
			"timeout",
			"not-executed",
			vi.fn().mockResolvedValue({ executed: false, reason: "timed out" }),
		],
		[
			"no response",
			"no-response",
			vi.fn().mockResolvedValue({ executed: true }),
		],
		[
			"unsuccessful",
			"unsuccessful",
			vi.fn().mockResolvedValue({ executed: true, result: { success: false } }),
		],
	])(
		"logs a bounded outcome for a command %s",
		async (_name, expectedOutcome, executeCommand) => {
			await expect(
				probeTsserverProjectIdentity(options(executeCommand)),
			).resolves.toBeUndefined();
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({ outcome: expectedOutcome }),
				}),
			);
		},
	);

	it("deduplicates normalized aliases once per client and file, without logging the dedupe", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: { success: true, body: {} },
		});
		const first = { ...options(executeCommand), file: "C:\\Repo\\src\\app.ts" };
		await probeTsserverProjectIdentity(first);
		await probeTsserverProjectIdentity({
			...first,
			file: "c:\\repo\\src\\APP.ts",
		});

		expect(executeCommand).toHaveBeenCalledTimes(1);
		// Dedupe is a routine, high-volume no-op — it must NOT write a second
		// telemetry row (that was the #1432-review log-flood finding).
		expect(logLatency).toHaveBeenCalledTimes(1);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					projectKind: "unassociated",
					association: "unassociated",
				}),
			}),
		);
	});

	// #1412 L2: handleNotifyOpen already computes normalizeMapKey(filePath)
	// before calling in — the probe must use that value verbatim instead of
	// recomputing it. Pass a normalizedFile that deliberately does NOT match
	// normalizeMapKey(file) to prove the supplied value wins.
	it("uses the caller-supplied normalizedFile instead of recomputing it", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: { success: true, body: {} },
		});
		const probedFiles = new Set<string>();
		const customKey = "already-normalized-key";
		await probeTsserverProjectIdentity({
			serverId: "typescript",
			launchVariant: "classic",
			clientRoot: "/repo",
			file: "/repo/src/app.ts",
			normalizedFile: customKey,
			probedFiles,
			commandChannel: { executeCommand },
		});

		expect(probedFiles.has(customKey)).toBe(true);
		expect(probedFiles.has(normalizeMapKey("/repo/src/app.ts"))).toBe(false);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: customKey }),
		);
	});

	it("is a silent no-op for native TS7 (ineligible servers must not log)", async () => {
		const executeCommand = vi.fn();
		await probeTsserverProjectIdentity({
			...options(executeCommand),
			launchVariant: "native-ts7",
		});
		expect(executeCommand).not.toHaveBeenCalled();
		// Ineligible servers (wrong launchVariant/serverId) are the common case
		// on every non-TS didOpen (python, go, opengrep, ...) — logging here was
		// the #1432-review log-flood finding.
		expect(logLatency).not.toHaveBeenCalled();
	});
});
