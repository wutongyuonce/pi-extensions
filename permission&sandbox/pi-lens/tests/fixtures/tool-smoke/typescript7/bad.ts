// Known defect: assigning a string to a number — the native TypeScript 7 `tsc
// --lsp --stdio` server must flag this as a type error (tool-smoke fixture for
// #530, exercising the native launch path shipped in #526).
export const count: number = "not a number";

export function double(n: number): number {
	return n * 2;
}
