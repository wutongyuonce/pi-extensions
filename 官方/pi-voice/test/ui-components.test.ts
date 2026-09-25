import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paneRowBudget,
  selectedWindow,
  windowSizeForBudget,
} from "../src/ui-components.js";
import { testTui } from "./ui-helpers.js";

test("pane sizing reserves host rows and centers the selected window", () => {
  assert.equal(paneRowBudget(testTui(24)), 22);
  assert.equal(paneRowBudget(testTui()), undefined);
  assert.equal(windowSizeForBudget(5, 10), 5);
  assert.equal(windowSizeForBudget(20, 10), 10);
  assert.deepEqual(selectedWindow(Array.from({ length: 20 }), 10, 5), [8, 13]);
});
