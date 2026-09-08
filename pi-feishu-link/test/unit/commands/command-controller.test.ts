import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../../../src/commands/command-controller.ts";

test("parseCommand parses /name args", () => {
	assert.deepEqual(parseCommand("/model"), {
		name: "model",
		rawArgs: "",
		args: [],
	});
	assert.deepEqual(parseCommand("/workspace /home/proj"), {
		name: "workspace",
		rawArgs: "/home/proj",
		args: ["/home/proj"],
	});
	assert.deepEqual(parseCommand("  /NEW  a   b "), {
		name: "new",
		rawArgs: "a   b",
		args: ["a", "b"],
	});
});

test("parseCommand returns null for non-commands", () => {
	assert.equal(parseCommand("hello"), null);
	assert.equal(parseCommand(""), null);
	assert.equal(parseCommand("/"), null);
	assert.equal(parseCommand("not a /command"), null);
});
