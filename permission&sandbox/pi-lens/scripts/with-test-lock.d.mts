// Type declarations for with-test-lock.mjs (untyped .mjs imported from .ts
// tests, so quoteForWindowsCmd's edge cases can be pinned down directly).
// #1101.

export function quoteForWindowsCmd(arg: string): string;

export function resolveVitestEntry(): string | null;

export function sharedModeRequiresPaths(commandArgs: string[]): boolean;

export function parseWrapperArgs(argv: string[]): {
	shared: boolean;
	slots: number | null;
	commandArgs: string[];
	errors: string[];
};
