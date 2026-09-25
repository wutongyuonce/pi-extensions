/**
 * Opt-in compact one-line tool-result rendering (#1327).
 *
 * pi renders a tool call as two rows by default: the tool-name/args row
 * (`renderCall`) and the result row (`renderResult`). Most pi-lens tools
 * already supply a `renderResult` via `tools/render-compact.ts`'s
 * `compactRenderResult` — a collapsed one-line summary (brand-blue) plus the
 * full output when expanded. This module adds a further, OPT-IN layer that
 * collapses those two rows into ONE — `<status glyph> <name> — <summary>` —
 * by reusing each tool's EXISTING collapsed summary text verbatim (never
 * inventing new strings) and re-styling it through semantic `Theme` tokens
 * instead of a fixed color.
 *
 * Applied generically at the registration seam (index.ts's registerTool
 * loop), not as a per-tool copy: `wrapToolForCompactLine` decorates any
 * `ToolDefinition` that already defines `renderResult`; tools without one are
 * returned untouched. Callers gate the whole thing behind the `ui.compactToolLine`
 * flag (`clients/lens-flag-registry.ts`) — when it is off, the ORIGINAL tool
 * array is registered unwrapped, so behavior is byte-identical to today (no
 * `renderCall`/`renderResult` are added or altered).
 *
 * `clients/` intentionally does NOT import `tools/render-compact.ts` (tools/
 * depends on clients/, never the reverse — see AGENTS.md's seam discipline),
 * so `fullTextOf` is duplicated here in miniature rather than inverting that
 * dependency.
 *
 * API limitation vs the issue's ask: `ToolRenderResultOptions` (the type pi
 * hands `renderResult`) exposes only `{ expanded, isPartial }` — no
 * `outputPad`. `outputPad` exists solely on the unrelated `MessageRenderOptions`
 * (custom message renderers, e.g. clients/turn-summary-render.ts), not on the
 * tool-result render path. There is nothing to honor here; the collapsed line
 * still respects the render width via `fitLines` so it never overflows the
 * terminal (#513's crash class).
 */

import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "./deps/pi-tui.js";
import { stripAnsi } from "./sanitize.js";
import { fitLines } from "./tui-fit.js";

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

/** Minimal shape of a tool result — kept structural, mirrors
 * tools/render-compact.ts's CompactResultLike (duplicated per the layering
 * note above, not re-exported). */
interface CompactLineResultLike {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

function fullTextOf(result: CompactLineResultLike): string {
	return (result.content ?? [])
		.filter(
			(c): c is { type: string; text: string } =>
				c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

/**
 * Build the collapsed compact line from a tool's ALREADY-COMPUTED summary
 * text (verbatim reuse — see module doc). `summaryText` is expected in the
 * `<name/hint> — <detail>` shape every pi-lens summarizer already produces
 * (e.g. `lens_diagnostics all — 3 blocking · 3 errors · 2 warnings (1 file)`);
 * when the separator is absent the whole string is styled as one span
 * instead of guessing a split point.
 *
 * Pure and theme-driven: a status glyph (success/error tokens), the name
 * portion (`toolTitle`, bold), and the detail portion (`error`/`toolOutput`)
 * are each styled through semantic `Theme.fg` tokens — never a fixed color.
 */
export function buildCompactToolLine(
	summaryText: string,
	isError: boolean,
	theme: Theme,
): string {
	const glyph = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const detailColor = isError ? "error" : "toolOutput";
	const sepIndex = summaryText.indexOf(" — ");
	if (sepIndex === -1) {
		return `${glyph} ${theme.fg(detailColor, summaryText)}`;
	}
	const namePart = summaryText.slice(0, sepIndex);
	const detailPart = summaryText.slice(sepIndex + " — ".length);
	const styledName = theme.fg("toolTitle", theme.bold(namePart));
	const styledDash = theme.fg("dim", "—");
	const styledDetail = theme.fg(detailColor, detailPart);
	return `${glyph} ${styledName} ${styledDash} ${styledDetail}`;
}

/** Render a component at a wide probe width to capture its full text,
 * stripped of ANSI — the collapsed summary is re-styled through this
 * module's own theme tokens rather than carrying over fixed-color escapes
 * (e.g. tools/render-compact.ts's brand-blue). */
function captureComponentText(component: Component): string {
	try {
		const lines = component.render(4096);
		return stripAnsi(lines.join(" ")).trim();
	} catch {
		return "";
	}
}

/**
 * Decorate a single tool definition with the opt-in compact-line renderers.
 * Tools with no `renderResult` are returned UNCHANGED (nothing to compact).
 * Call this only when the `ui.compactToolLine` flag is already known to be
 * on — the caller (index.ts) skips the wrap entirely when it is off, which
 * is what keeps the off path byte-identical to today rather than this
 * function branching on a live flag read per render.
 */
export function wrapToolForCompactLine<T extends ToolDefinition<any, any, any>>(
	tool: T,
): T {
	const originalRenderResult = tool.renderResult;
	if (!originalRenderResult) return tool;
	const originalRenderCall = tool.renderCall;

	const renderCall: ToolDefinition<any, any, any>["renderCall"] = (
		args,
		theme,
		context,
	) => {
		// Only blank the call row once a settled (non-partial) result exists —
		// `renderResult` is about to paint the single combined line. While the
		// tool is still running/streaming, keep showing the normal call row
		// (mirrors the host's own createCallFallback) so the UI isn't blank.
		if (!context.expanded && context.isPartial === false) {
			return EMPTY_COMPONENT;
		}
		if (originalRenderCall) return originalRenderCall(args, theme, context);
		// Mirrors the host's own createCallFallback exactly: styled `tool.name`
		// (the registered name, e.g. "lens_diagnostics"), not the display label.
		const line = theme.fg("toolTitle", theme.bold(tool.name));
		return {
			render: (width: number) => fitLines([line], width),
			invalidate: () => {},
		};
	};

	const renderResult: ToolDefinition<any, any, any>["renderResult"] = (
		result,
		options,
		theme,
		context,
	) => {
		if (options.expanded) {
			return originalRenderResult(result, options, theme, context);
		}
		let summaryText: string;
		try {
			// Probe the tool's OWN collapsed renderer to capture its already-built
			// summary text; `lastComponent` is cleared so the probe never reuses
			// (and thereby mutates) the real row's retained component.
			const probeContext = { ...context, lastComponent: undefined };
			const component = originalRenderResult(
				result,
				{ ...options, expanded: false },
				theme,
				probeContext,
			);
			summaryText = captureComponentText(component);
		} catch {
			summaryText = "";
		}
		const resultLike = result as CompactLineResultLike;
		if (!summaryText) {
			summaryText = stripAnsi(
				fullTextOf(resultLike).split("\n")[0] ?? "",
			).trim();
		}
		// pi invokes tool renderers with `{ content, details }` -- the failure
		// bit lives on `context.isError`, not the result (#1341 review). Keep
		// `result.isError` as a fallback for direct/legacy callers.
		const contextIsError = (context as { isError?: boolean } | undefined)
			?.isError;
		const isError = contextIsError ?? resultLike.isError === true;
		const line = buildCompactToolLine(summaryText, isError === true, theme);
		return {
			render: (width: number) => fitLines([line], width),
			invalidate: () => {},
		};
	};

	return { ...tool, renderCall, renderResult };
}

/** Wrap every tool in an array — tools without `renderResult` pass through
 * unchanged. Used by index.ts's registerTool loop, only when the
 * `ui.compactToolLine` flag resolved on for this session. */
export function wrapToolsForCompactLine<
	T extends ToolDefinition<any, any, any>,
>(tools: readonly T[]): T[] {
	return tools.map((tool) => wrapToolForCompactLine(tool));
}
