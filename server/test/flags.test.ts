import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolsFor } from "../src/live.ts";

test("flags off -> exactly the M1 tool set; flags add find_item / add_medication only", () => {
  assert.deepEqual(toolsFor(new Set()), TOOLS);
  assert.deepEqual(toolsFor(new Set(["sonar", "datamatrix"])), TOOLS);
  assert.deepEqual(toolsFor(new Set(["scene"])).map((t) => t.name), ["verify_label", "show_cue", "log_dose", "find_item"]);
  assert.deepEqual(toolsFor(new Set(["scene", "addmed"])).map((t) => t.name), ["verify_label", "show_cue", "log_dose", "find_item", "add_medication"]);
});
