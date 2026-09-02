import { describe, expect, it } from "vitest";

import {
	DEFAULTS,
	OBSERVER_CHUNK_CONTEXT_RATIO,
	OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
	OBSERVER_CHUNK_MIN_TOKENS,
	resolveObserverChunkMaxTokens,
	type Config,
} from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULTS, ...overrides };
}

describe("resolveObserverChunkMaxTokens", () => {
	it("uses the explicit config value when set", () => {
		expect(resolveObserverChunkMaxTokens(config({ observerChunkMaxTokens: 12_345 }), 1_000_000)).toBe(12_345);
		expect(resolveObserverChunkMaxTokens(config({ observerChunkMaxTokens: 12_345 }), undefined)).toBe(12_345);
	});

	it("derives the cap from the model context window when unset", () => {
		expect(resolveObserverChunkMaxTokens(config(), 1_000_000)).toBe(Math.floor(1_000_000 * OBSERVER_CHUNK_CONTEXT_RATIO));
		expect(resolveObserverChunkMaxTokens(config(), 200_000)).toBe(Math.floor(200_000 * OBSERVER_CHUNK_CONTEXT_RATIO));
		expect(resolveObserverChunkMaxTokens(config(), 3)).toBe(OBSERVER_CHUNK_MIN_TOKENS);
	});

	it("falls back to the static default when the context window is unknown or invalid", () => {
		expect(resolveObserverChunkMaxTokens(config(), undefined)).toBe(OBSERVER_CHUNK_FALLBACK_MAX_TOKENS);
		expect(resolveObserverChunkMaxTokens(config(), 0)).toBe(OBSERVER_CHUNK_FALLBACK_MAX_TOKENS);
		expect(resolveObserverChunkMaxTokens(config(), -1)).toBe(OBSERVER_CHUNK_FALLBACK_MAX_TOKENS);
		expect(resolveObserverChunkMaxTokens(config(), Number.NaN)).toBe(OBSERVER_CHUNK_FALLBACK_MAX_TOKENS);
	});

	it("clamps explicit values to the minimum useful chunk size", () => {
		expect(resolveObserverChunkMaxTokens(config({ observerChunkMaxTokens: 1 }), 100_000)).toBe(OBSERVER_CHUNK_MIN_TOKENS);
	});

	it("ignores non-positive config values", () => {
		expect(resolveObserverChunkMaxTokens(config({ observerChunkMaxTokens: 0 }), 100_000)).toBe(Math.floor(100_000 * OBSERVER_CHUNK_CONTEXT_RATIO));
	});
});
