const MIN_RENDER_ROWS = 4;
const MAX_HEIGHT_RATIO = 0.85;

// Top-clip so banner + latest transcript + footer stay visible at the bottom.
export function clipToTerminalHeight(lines: readonly string[], terminalRows: number): string[] {
	const maxRows = Math.max(MIN_RENDER_ROWS, Math.floor(terminalRows * MAX_HEIGHT_RATIO));
	if (lines.length <= maxRows) return [...lines];
	return lines.slice(lines.length - maxRows);
}
