/**
 * Provider derivation for worklog/disposition attribution (#1448).
 *
 * The host reports `provider` and `model` as separate fields on its telemetry
 * events (see `updateRuntimeIdentityFromEvent` in index.ts and the
 * `tool_result` handler in clients/runtime-tool-result.ts) MOST of the time —
 * so the common case needs no parsing at all. This parser exists only for the
 * fallback: a model id supplied without an explicit provider.
 *
 * Derivation rule (conservative — returns "" rather than guess):
 *   1. A single `/` or `:` separator splits the id into `<provider>/<rest>`
 *      or `<provider>:<rest>` — e.g. "anthropic/claude-sonnet-4-5",
 *      "openai:gpt-5". The left segment is lowercased and returned AS-IS
 *      (no allowlist check) since an explicit separator is deliberate host
 *      structure, not a guess.
 *   2. No separator: match a known model-id PREFIX against a small table of
 *      vendor naming conventions (claude- -> anthropic; gpt-, o1-, o3- ->
 *      openai; gemini- -> google; llama- -> meta; mistral-, mixtral- ->
 *      mistral; command- -> cohere). First match wins.
 *   3. Anything else (unrecognized prefix, multiple separators, empty
 *      string) is ambiguous -> "".
 */

const KNOWN_PREFIXES: [prefix: string, provider: string][] = [
	["claude-", "anthropic"],
	["gpt-", "openai"],
	["o1-", "openai"],
	["o3-", "openai"],
	["gemini-", "google"],
	["llama-", "meta"],
	["mistral-", "mistral"],
	["mixtral-", "mistral"],
	["command-", "cohere"],
];

export function deriveProviderFromModelId(modelId: string | undefined): string {
	const id = modelId?.trim().toLowerCase();
	if (!id) return "";

	const separators = [...id].filter((c) => c === "/" || c === ":").length;
	if (separators === 1) {
		const sep = id.includes("/") ? "/" : ":";
		const [providerPart, ...rest] = id.split(sep);
		if (providerPart && rest.join(sep).length > 0) return providerPart;
		return "";
	}
	if (separators > 1) return "";

	for (const [prefix, provider] of KNOWN_PREFIXES) {
		if (id.startsWith(prefix)) return provider;
	}
	return "";
}
