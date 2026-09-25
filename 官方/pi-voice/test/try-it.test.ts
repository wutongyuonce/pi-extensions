import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFasterModel } from "../src/try-it.js";

test("speed nudge ignores takes that are too short to judge", () => {
  assert.equal(needsFasterModel(30, 6), true);
  assert.equal(needsFasterModel(30, 5), false);
  assert.equal(needsFasterModel(3, 2), false);
  assert.equal(needsFasterModel(30, 0.3), false);
});
