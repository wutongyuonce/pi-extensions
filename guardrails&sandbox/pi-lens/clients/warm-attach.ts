import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
	type InstanceEntry,
	readInstanceRegistry,
	selectLivePeerInstances,
} from "./instance-registry.js";
import { realIsPidAlive } from "./instance-reaper.js";
import { logLatency } from "./latency-logger.js";
import { touchCoverageGap } from "./lsp/diagnostic-binding.js";
import { loadLspService } from "./lsp-lazy.js";
import {
	contentHash,
	createWarmIpcLineReader,
	diagnosticsIpcPathForCwd,
	requestWarmCodeActions,
	requestWarmDiagnostics,
	type WarmCodeActionRange,
	type WarmCodeActionsResult,
	type WarmCodeActionsRequest,
	type WarmCodeActionsResponse,
	type WarmDiagnosticsRequest,
	type WarmDiagnosticsResult,
	WARM_CODE_ACTION_LOOKUP_LIMIT,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "./mcp/ipc.js";
import { normalizeFilePath } from "./path-utils.js";

interface AttachState {
	cwd?: string;
	incumbentPid?: number;
	local: boolean;
	server?: net.Server;
	servedDiagnosticHashes: Map<string, string>;
}

const state: AttachState = { local: true, servedDiagnosticHashes: new Map() };

function record(
	event: string,
	cwd: string,
	reason?: string,
	pid?: number,
	source?: "per-edit" | "sweep",
): void {
	logLatency({
		type: "phase",
		phase: "lsp_warm_attach",
		filePath: cwd,
		durationMs: 0,
		metadata: { event, reason, incumbentPid: pid, source },
	});
}

/**
 * The oldest live peer on this root, if any. The liveness rule itself lives
 * in `selectLivePeerInstances` (#2007) so warm-attach and the shared-checkout
 * guard cannot drift apart about what "another session is here" means.
 */
export function selectWarmAttachIncumbent(
	entries: readonly InstanceEntry[],
	cwd: string,
	now = Date.now(),
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): InstanceEntry | undefined {
	return selectLivePeerInstances(entries, cwd, now, isPidAlive)[0];
}

async function serveRequest(
	req: WarmDiagnosticsRequest | WarmCodeActionsRequest,
): Promise<{ result?: unknown; error?: string }> {
	if (req.route === "code-actions") {
		if (
			req.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION ||
			req.ranges.length > WARM_CODE_ACTION_LOOKUP_LIMIT ||
			Date.now() > req.deadlineAt ||
			state.servedDiagnosticHashes.get(normalizeFilePath(req.file)) !==
				req.contentHash
		) {
			return { error: "stale request" };
		}
		try {
			const actions = await Promise.all(
				req.ranges.map(async (range) => {
					if (Date.now() > req.deadlineAt) {
						throw new Error("deadline exceeded");
					}
					return (await loadLspService())
						.getLSPService()
						.codeAction(
							req.file,
							range.start.line,
							range.start.character,
							range.end.line,
							range.end.character,
						);
				}),
			);
			const servedAt = Date.now();
			if (servedAt > req.deadlineAt) return { error: "deadline exceeded" };
			return {
				result: {
					route: "code-actions",
					version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
					contentHash: req.contentHash,
					servedAt,
					actions,
				} satisfies WarmCodeActionsResponse,
			};
		} catch (error) {
			return { error: String(error) };
		}
	}
	if (
		req.route !== "diagnostics" ||
		req.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION
	) {
		return { error: "schema mismatch" };
	}
	if (
		Date.now() > req.deadlineAt ||
		contentHash(req.content) !== req.contentHash
	) {
		return { error: "stale request" };
	}
	const touched = await (
		await loadLspService()
	)
		.getLSPService()
		.touchFile(req.file, req.content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			maxClientWaitMs: Math.max(1, req.deadlineAt - Date.now()),
			maxDiagnosticsWaitMs: Math.max(1, req.deadlineAt - Date.now()),
			source: "warm-attach-incumbent",
		});
	const servedAt = Date.now();
	// #1470: the coverage gap is read through the shared helper, never re-derived
	// from `confirmation === "partial"`. The two fields are set together today, so
	// either test passes — which is exactly the coincidence `touchCoverageGap`'s
	// own doc comment warns against. One reader, one rule.
	const coverageGap = touchCoverageGap(touched);
	if (
		servedAt <= req.deadlineAt &&
		touched !== undefined &&
		!touched.inconclusive
	) {
		state.servedDiagnosticHashes.set(
			normalizeFilePath(req.file),
			req.contentHash,
		);
	}
	return {
		result: {
			route: "diagnostics",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			// #1179: `touchFile` now returns the `{ diags, inconclusive, binding }`
			// wrapper — take the array off `.diags`. This is the canonical shape-5
			// serialization boundary: the diagnostics array crosses the IPC socket
			// and `inconclusive` is re-surfaced below as an EXPLICIT enumerable DTO
			// field (no side-channel survives `JSON.stringify`).
			diagnostics: touched?.diags ?? [],
			contentHash: req.contentHash,
			servedAt,
			fresh: servedAt <= req.deadlineAt && touched !== undefined,
			inconclusive: touched?.inconclusive === true,
			// #1253: carry the touch's own confirmation verdict across the socket
			// as an explicit enumerable field (same doctrine as `inconclusive`) —
			// without it, an incumbent-served empty result from a silent-on-clean
			// server is indistinguishable from "never answered" on the far side.
			...(touched?.confirmation === "confirmed"
				? { confirmation: "confirmed" as const }
				: {}),
			// #1470: a PARTIAL touch crosses the socket as itself rather than as a
			// missing key. Omitting it would still fail closed on the far side, but it
			// would be indistinguishable from an old incumbent that never sent the
			// field — and the whole point of narrowing is that the reader can tell
			// which coverage is real.
			...(coverageGap.length > 0
				? {
						confirmation: "partial" as const,
						unconfirmedServerIds: [...coverageGap],
					}
				: {}),
		},
	};
}

function startServer(cwd: string): void {
	state.server?.close();
	const endpoint = diagnosticsIpcPathForCwd(cwd, process.pid);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// No stale socket.
		}
	}
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		// One-shot per connection (#1219 family): the same defect shape as the
		// MCP warm socket — clients write exactly one request and read one
		// reply, so a handler that kept re-reading the same buffered line
		// re-dispatched the request on stray bytes. The shared reader consumes
		// the line and ignores anything after it.
		socket.on(
			"data",
			createWarmIpcLineReader((line) => {
				void (async () => {
					try {
						const req = JSON.parse(line) as
							| WarmDiagnosticsRequest
							| WarmCodeActionsRequest;
						socket.end(`${JSON.stringify(await serveRequest(req))}\n`);
					} catch (error) {
						socket.end(`${JSON.stringify({ error: String(error) })}\n`);
					}
				})();
			}),
		);
	});
	server.on("error", (error) => {
		record("listener-error", cwd, String(error));
	});
	server.listen(endpoint);
	server.unref();
	state.server = server;
}

export async function configureWarmAttach(cwd: string): Promise<void> {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = undefined;
	state.local = true;
	if (process.env.PI_LENS_WARM_ATTACH !== "1") {
		record("disabled", state.cwd, "opt-in-not-enabled");
		return;
	}
	startServer(state.cwd);
	const incumbent = selectWarmAttachIncumbent(
		await readInstanceRegistry(),
		state.cwd,
	);
	if (!incumbent) {
		record("local", state.cwd, "no-live-incumbent");
		return;
	}
	state.incumbentPid = incumbent.pid;
	state.local = false;
	record("attached", state.cwd, undefined, incumbent.pid);
}

export async function tryWarmAttachedDiagnostics(
	file: string,
	content: string,
	timeoutMs: number,
	source: "per-edit" | "sweep" = "per-edit",
): Promise<WarmDiagnosticsResult | undefined> {
	if (state.local || !state.cwd || !state.incumbentPid) return undefined;
	const entries = await readInstanceRegistry();
	const incumbent = selectWarmAttachIncumbent(entries, state.cwd);
	if (incumbent?.pid !== state.incumbentPid) {
		promoteToLocal("incumbent-stale-or-exited");
		return undefined;
	}
	const result = await requestWarmDiagnostics(
		state.cwd,
		state.incumbentPid,
		file,
		content,
		timeoutMs,
	);
	if (!result.available) {
		promoteToLocal(result.reason);
	} else {
		record("diagnostics-served", file, undefined, state.incumbentPid, source);
	}
	return result;
}

export async function tryWarmAttachedCodeActions(
	file: string,
	expectedContentHash: string,
	ranges: WarmCodeActionRange[],
	timeoutMs: number,
): Promise<WarmCodeActionsResult | undefined> {
	if (state.local || !state.cwd || !state.incumbentPid) return undefined;
	const result = await requestWarmCodeActions(
		state.cwd,
		state.incumbentPid,
		file,
		expectedContentHash,
		ranges,
		timeoutMs,
	);
	if (result.available) {
		record("code-actions-served", file, undefined, state.incumbentPid);
	} else {
		// Quickfixes are optional enrichment. Diagnostics already succeeded, so a
		// code-action failure is deliberately softer and must not trigger takeover.
		record("code-actions-skipped", file, result.reason, state.incumbentPid);
	}
	return result;
}

export function isWarmAttached(): boolean {
	return !state.local && state.incumbentPid !== undefined;
}

function promoteToLocal(reason: string): void {
	if (state.local) return;
	const pid = state.incumbentPid;
	state.local = true;
	state.incumbentPid = undefined;
	record("takeover", state.cwd ?? process.cwd(), reason, pid);
}

export function _resetWarmAttachForTests(): void {
	state.server?.close();
	state.server = undefined;
	state.cwd = undefined;
	state.incumbentPid = undefined;
	state.local = true;
	state.servedDiagnosticHashes.clear();
}

export function _setWarmAttachForTests(
	cwd: string,
	incumbentPid: number,
): void {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = incumbentPid;
	state.local = false;
}

/**
 * The incumbent-side request handler, exposed for tests. The socket wiring
 * around it (`startServer`) can only be exercised by a test that actually
 * binds a unix socket, which is not available in every sandbox — this seam
 * lets the DTO-composition half (notably the #1253 `confirmation` field, whose
 * absence is what a consumer reads as unconfirmed) be pinned directly.
 */
export const _serveWarmRequestForTests = serveRequest;
