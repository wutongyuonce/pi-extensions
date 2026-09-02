/**
 * #2208: playground-verify-rule.mjs wrote the caller's `--code` into the
 * playground URL-hash payload's `query` field. The upstream playground
 * (ast-grep/ast-grep.github.io, website/src/components/astGrep/state.ts +
 * index.ts) only reads `query` in its "Pattern" mode — this harness always
 * runs "Config" mode, where matches come from `state.source`. With no
 * `source` field in the hash, the playground's `{...defaultState, ...parsed}`
 * merge silently fell back to its own hardcoded sample, so `--code` never
 * reached the engine and every run graded a fixed sample instead.
 *
 * This is a fast, no-Chrome unit test on the URL-building step alone: decode
 * the hash the harness builds and assert the caller's code lands in
 * `source`, not `query`. It is the mutation-proof lock for the fix — deleting
 * the `source: code` line (or resurrecting `query: code`) fails this test
 * without needing headless Chrome or network access.
 */

import { describe, expect, it } from "vitest";
import { buildPlaygroundUrl } from "../../scripts/playground-verify-rule.mjs";

function decodeHash(url: string): Record<string, unknown> {
	const b64 = url.split("#")[1];
	return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

describe("playground-verify-rule.mjs buildPlaygroundUrl (#2208)", () => {
	it("puts the caller's code in `source`, the field Config mode actually matches against", () => {
		const code = "const A = () => <div>{items.length && <b>hi</b>}</div>;";
		const url = buildPlaygroundUrl("id: r\nrule:\n  pattern: x", code, "tsx");
		const payload = decodeHash(url);
		expect(payload.source).toBe(code);
	});

	it("does not put the caller's code in `query` (Pattern-mode-only field)", () => {
		const code = "const A = () => <div>{items.length && <b>hi</b>}</div>;";
		const url = buildPlaygroundUrl("id: r\nrule:\n  pattern: x", code, "tsx");
		const payload = decodeHash(url);
		expect(payload.query).not.toBe(code);
	});

	it("always requests Config mode with the rule YAML in `config`", () => {
		const ruleYaml = "id: r\nrule:\n  pattern: x";
		const url = buildPlaygroundUrl(ruleYaml, "ignored", "typescript");
		const payload = decodeHash(url);
		expect(payload.mode).toBe("Config");
		expect(payload.config).toBe(ruleYaml);
		expect(payload.lang).toBe("typescript");
	});
});
