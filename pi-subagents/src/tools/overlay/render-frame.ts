import { visibleWidth } from "@earendil-works/pi-tui";
import { fitLine } from "./render-helpers.ts";
import type { FooterHint, OverlayState, TabDef, Theme } from "./render-types.ts";

/**
 * Render the overlay header: accent border, title, tab bar.
 */
export function renderHeader(state: OverlayState, tabs: TabDef[], theme: Theme, width: number): string[] {
	const lines: string[] = [];

	// Top border
	lines.push(theme.fg("accent", "─".repeat(width)));

	lines.push(fitLine(` ${theme.bold(theme.fg("accent", "Subagents"))}`, width));
	lines.push(" ".repeat(width));
	lines.push(renderTabBar(state.activeTab, tabs, theme, width));
	lines.push(" ".repeat(width));

	return lines;
}

/**
 * Render the overlay footer: context-sensitive keymaps + bottom border.
 */
export function renderFooter(hints: FooterHint[], theme: Theme, width: number): string[] {
	const lines: string[] = [];
	lines.push(" ".repeat(width));

	lines.push(...wrapFooterHints(hints, theme, width));
	lines.push(theme.fg("accent", "─".repeat(width)));

	return lines;
}

/**
 * Get context-sensitive footer hints based on current view state.
 */
export function getFooterHints(state: OverlayState): FooterHint[] {
	if (state.view.kind === "detail") {
		return [
			{ key: "↑↓", action: "scroll" },
			{ key: "Esc", action: "back" },
			{ key: "alt+s", action: "close" },
		];
	}

	if (state.view.kind === "confirm") {
		return [
			{ key: "←→", action: "choose" },
			{ key: "Enter", action: "confirm" },
			{ key: "Esc", action: "cancel" },
		];
	}

	if (state.view.kind === "editor") {
		return [
			{ key: "Enter", action: "send" },
			{ key: "Esc", action: "cancel" },
		];
	}

	if (state.view.kind === "orchestrator-confirm") {
		return [
			{ key: "←→", action: "choose" },
			{ key: "Enter", action: "select" },
			{ key: "Esc", action: "cancel" },
		];
	}

	const hints: FooterHint[] = [
		{ key: "↑↓", action: "navigate" },
		{ key: "←→", action: "tabs" },
	];

	if (state.activeTab === "running" && state.items.length > 0) {
		hints.push({ key: "k", action: "kill" });
	}
	if (state.activeTab === "completed" && state.items.length > 0) {
		hints.push({ key: "m", action: "resume" });
	}
	if (state.activeTab === "orchestrator") {
		hints.push({ key: "Enter", action: "select" });
	}
	if (state.items.length > 0) {
		hints.push({ key: "Enter", action: "details" });
	}
	hints.push({ key: "Esc", action: "close" });

	return hints;
}

function renderTabBar(activeTab: string, tabs: TabDef[], theme: Theme, width: number): string {
	const rendered = tabs.map((tab) => {
		const text = ` ${tab.label} `;
		if (tab.id === activeTab) {
			return theme.bg("selectedBg", theme.fg("text", text));
		}
		return theme.fg("muted", text);
	});

	const separator = " ";
	const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
	const leftArrow = activeIndex > 0 ? theme.fg("dim", "←  ") : "   ";
	const rightArrow = activeIndex >= 0 && activeIndex < tabs.length - 1 ? theme.fg("dim", "  →") : "";
	const tabContent = rendered.join(separator);

	const fullBar = `${leftArrow}${tabContent}${rightArrow}`;
	if (visibleWidth(fullBar) <= width) return fitLine(fullBar, width);

	const active = tabs[activeIndex];
	if (!active) return fitLine("", width);

	const compactLeft = activeIndex > 0 ? theme.fg("dim", "← ") : "  ";
	const compactRight = activeIndex >= 0 && activeIndex < tabs.length - 1 ? theme.fg("dim", " →") : "";
	const availableLabelWidth = Math.max(1, width - visibleWidth(compactLeft) - visibleWidth(compactRight) - 2);
	const label = compactTabLabel(active.label, availableLabelWidth);
	const selected = theme.bg("selectedBg", theme.fg("text", ` ${label} `));
	return fitLine(`${compactLeft}${selected}${compactRight}`, width);
}

function wrapFooterHints(hints: FooterHint[], theme: Theme, width: number): string[] {
	const separator = theme.fg("muted", "  ·  ");
	const renderedHints = hints.map((hint) => ({
		plain: `${hint.key} ${hint.action}`,
		rendered: `${theme.fg("accent", hint.key)} ${theme.fg("dim", hint.action)}`,
	}));
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;

	for (const hint of renderedHints) {
		const hintWidth = visibleWidth(hint.plain);
		const separatorWidth = row ? visibleWidth("  ·  ") : 0;
		if (row && 1 + rowWidth + separatorWidth + hintWidth > width) {
			rows.push(fitLine(` ${row}`, width));
			row = hint.rendered;
			rowWidth = hintWidth;
			continue;
		}
		row = row ? `${row}${separator}${hint.rendered}` : hint.rendered;
		rowWidth += separatorWidth + hintWidth;
	}

	if (row) rows.push(fitLine(` ${row}`, width));
	return rows.length > 0 ? rows : [fitLine("", width)];
}

function compactTabLabel(label: string, width: number): string {
	if (label.length <= width) return label;
	const orchestratorModePrefix = "Orchestrator: ";
	if (label.startsWith(orchestratorModePrefix)) {
		const mode = label.slice(orchestratorModePrefix.length);
		const compact = `Orch. ${mode}`;
		if (compact.length <= width) return compact;
		if (mode.length <= width) return mode;
	}
	if (label === "Orchestrator" && width >= 4) return "Orch.".slice(0, width);
	return label.slice(0, width);
}
