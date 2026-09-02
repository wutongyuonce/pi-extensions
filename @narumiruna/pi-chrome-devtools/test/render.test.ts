import assert from "node:assert/strict";
import { test } from "vitest";
import { withStatus } from "../src/render.js";

test("concurrent tool statuses restore the latest remaining activity", async () => {
	const statuses: Array<string | undefined> = [];
	const sessionManager = {};
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
	};
	const firstContext = { sessionManager, ui };
	const secondContext = { sessionManager, ui };
	let finishFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	let finishSecond: (() => void) | undefined;
	const secondBlocked = new Promise<void>((resolve) => {
		finishSecond = resolve;
	});
	const first = withStatus(firstContext, "first", () => firstBlocked);
	const second = withStatus(secondContext, "second", () => secondBlocked);
	finishFirst?.();
	await first;
	assert.equal(statuses.at(-1), "second");
	finishSecond?.();
	await second;
	assert.equal(statuses.at(-1), undefined);
});
