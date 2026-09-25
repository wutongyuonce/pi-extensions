// A deliberately CLEAN TypeScript file (no diagnostics) exercised through the
// native TypeScript 7 `tsc --lsp --stdio` path (#530). Doubles as the future
// #529 clean-signal probe workspace for measuring the native variant's
// publish-on-clean behavior.
export function add(a: number, b: number): number {
	return a + b;
}

export const total: number = add(2, 3);
