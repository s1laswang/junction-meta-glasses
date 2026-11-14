import { test } from "node:test";
import assert from "node:assert/strict";
import { leadFor, speakInstruction, VERDICT_LEAD } from "../src/live.ts";

test("FI/SV verdicts start with a fixed, human-written opener for every level", () => {
  for (const lang of ["fi", "sv"]) {
    for (const level of ["match", "warning", "unsure", "info"] as const) {
      const l = leadFor(lang, level).lead;
      assert.ok(l && l.length > 0, `${lang}/${level}`);
      assert.equal(l, VERDICT_LEAD[lang][level]);
    }
    assert.match(speakInstruction(lang, ""), /First say `lead` exactly/);
  }
  assert.equal(leadFor("fi", "warning").lead, "Varoitus.");
  assert.equal(leadFor("sv-SE", "unsure").lead, "Jag är inte säker.");
});

test("English needs no opener and keeps word-for-word speech", () => {
  assert.deepEqual(leadFor("en", "match"), {});
  assert.match(speakInstruction("en", "x"), /^Say `speech` word for word/);
});
