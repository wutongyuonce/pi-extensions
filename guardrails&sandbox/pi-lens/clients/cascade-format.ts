import type { CascadeNeighborResult, CascadeRun } from "./cascade-types.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";

export function formatCascadeNeighborDiagnostics(
	cwd: string,
	neighbors: CascadeNeighborResult[],
	options: { noun?: string; includeReason?: boolean } = {},
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	const inconclusive = neighbors.filter(
		(n) => n.inconclusive === true && n.diagnostics.length === 0,
	);
	// #1459: a neighbour whose scanner never looked at it is not a clean leaf. It
	// is also not `inconclusive` — the language server answered — so it gets its
	// own honest line instead of being folded into either bucket. Only the
	// zero-diagnostic case needs saying: a neighbour with findings already renders.
	const uncovered = neighbors.filter(
		(n) =>
			n.diagnostics.length === 0 &&
			n.inconclusive !== true &&
			(n.unconfirmedServerIds?.length ?? 0) > 0,
	);
	if (
		withErrors.length === 0 &&
		inconclusive.length === 0 &&
		uncovered.length === 0
	) {
		return "";
	}

	const noun = options.noun ?? "neighbor";
	let out =
		withErrors.length > 0
			? `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`
			: "";
	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
		out += `\n<diagnostics file="${display}"${reason}>`;
		for (const d of neighbor.diagnostics) {
			const line = d.line ?? 1;
			const col = d.column ?? 1;
			const rule = d.rule ? ` rule=${d.rule}` : "";
			out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}`;
		}
		out += "\n</diagnostics>";
	}
	if (inconclusive.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade diagnostics inconclusive for ${inconclusive.length} ${noun} file(s) — no clean result was confirmed:`;
		for (const neighbor of inconclusive) {
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)}`;
		}
	}
	if (uncovered.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade scanners did not cover ${uncovered.length} ${noun} file(s) — no findings does NOT mean clean here:`;
		for (const neighbor of uncovered) {
			const servers = (neighbor.unconfirmedServerIds ?? []).join(", ");
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)} (not scanned by ${servers})`;
		}
	}
	return out;
}

/**
 * Build the turn-end `CascadeRun` for a neighbour whose diagnostics landed only
 * AFTER its cascade touch skipped the in-lane wait (#1023's `resolved-found`
 * quiet-window outcome; #1444 made native TS7 take that same path). Returns
 * `undefined` when there is nothing agent-facing to say — no ERROR-severity
 * diagnostics, or nothing the formatter renders.
 *
 * Lives here rather than inline in the quiet-window callback so the delivery
 * path (reconcile → run → turn_end) is testable end to end; index.ts only wires
 * it to `runtime.appendCascadeRun`.
 */
export function buildResolvedFoundCascadeRun(
	cwd: string,
	neighbor: { filePath: string; diagnostics: LSPDiagnostic[] },
): CascadeRun | undefined {
	const { filePath } = neighbor;
	const diagnostics = convertLspDiagnostics(
		neighbor.diagnostics.filter((d) => d.severity === 1),
		filePath,
		{ tool: "lsp" },
	);
	if (diagnostics.length === 0) return undefined;
	const neighbors: CascadeNeighborResult[] = [
		{ filePath, reason: "references", diagnostics, lspTouched: true },
	];
	const formatted = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: "cold neighbor",
	});
	if (!formatted) return undefined;
	return {
		filePath,
		result: {
			filePath,
			impact: {
				filePath,
				changedSymbols: [],
				directImporters: [],
				directCallers: [],
				neighborFiles: [filePath],
				riskFlags: [],
			},
			neighbors,
			formatted,
		},
		neighborCount: 1,
		diagnosticCount: diagnostics.length,
	};
}
