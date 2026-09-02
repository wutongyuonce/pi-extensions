/**
 * Save/restore `process.env` overrides for a test, handling the "the
 * variable didn't exist before" case correctly.
 *
 * #1816 found four incompatible hand-rolled save/restore idioms across the
 * `PI_LENS_DISABLE_TOOL_INSTALL` test files, two of which (`tool-discovery.
 * test.ts`, `version-drift.test.ts`) hard-restored the literal `"1"` in
 * `afterEach` instead of the value that was actually ambient before the
 * file's tests ran — correct today only because `vitest-setup.ts` happens to
 * default that variable to `"1"`, and silently wrong the moment anything
 * upstream in the same worker leaves it at something else. `withEnv` is the
 * single source of truth for the correct pattern: capture whatever was
 * there (including `undefined`), and restore exactly that.
 */
export type EnvOverrides = Record<string, string | undefined>;

/**
 * Apply `overrides` to `process.env` and return a function that undoes
 * exactly this call's change — deleting a key that was previously unset
 * rather than leaving it at its override value or a hardcoded default.
 *
 * @example
 * const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
 * try {
 *   // ... test body ...
 * } finally {
 *   restore();
 * }
 */
export function withEnv(overrides: EnvOverrides): () => void {
	const previous: EnvOverrides = {};
	for (const key of Object.keys(overrides)) {
		previous[key] = process.env[key];
		const value = overrides[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(previous)) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
