import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

describe("central js-yaml accessor", () => {
	it("loads rule documents and dumps synthesized objects", () => {
		const document = yaml.load(
			"id: example-rule\nmessage: prefer the example\nrules:\n  - kind: identifier\n",
		) as { id: string; message: string; rules: Array<{ kind: string }> };

		expect(document).toEqual({
			id: "example-rule",
			message: "prefer the example",
			rules: [{ kind: "identifier" }],
		});
		expect(yaml.dump({ id: document.id, enabled: true })).toBe(
			"id: example-rule\nenabled: true\n",
		);
	});
});
