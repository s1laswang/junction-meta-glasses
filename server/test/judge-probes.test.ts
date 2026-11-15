// Regression tests from the independent four-challenge judge panel's safety probes (Sun 15 Nov, ~05:00).
// Every case here was an unsafe MATCH ("yes") or INFO ("none of your allergens") before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { checkLabel } from "../src/safety.ts";

const F = (v: any, c = 0.95) => ({ value: v, confidence: c });
const N = { value: null, confidence: 0 };
const base = (o: Partial<LabelRead> = {}): LabelRead => ({ kind: "medication", product: F("Amlodipin Orion"), ingredient: F("amlodipine"), strength: F("5 mg"), dosing: N, expiry: F("2027-03"), allergens: N, barcode: N, readability: 0.9, ...o } as LabelRead);
const aml = { id: "aml", name: "Amlodipin Orion", ingredient: "amlodipine besilate", strength: "5 mg", schedule: ["evening"], gtin: "06414100000001" };
const prof = (o: Partial<Profile> = {}): Profile => ({ meds: [aml], allergies: [], avoid: [], doseLog: [], lang: "en", ...o });
const now = new Date(2026, 10, 15, 20, 0);
const food = (al: string[]): LabelRead => ({ kind: "food", product: F("Chocolate oat bar"), ingredient: N, strength: N, dosing: N, expiry: N, allergens: F(al, 0.97), barcode: N, readability: 0.9 } as LabelRead);
const notYes = (lvl: string) => assert.ok(lvl === "unsure" || lvl === "warning", `got ${lvl}`);

test("baseline still matches (no over-correction)", () => {
  assert.equal(checkLabel(base(), prof(), now).level, "match");
});
test("probe 7: product and ingredient name different medicines -> never a yes", () => {
  for (const product of ["Ibuprofen 5 mg", "Metformin Teva", "Bisoprolol Orion 5 mg"])
    assert.equal(checkLabel(base({ product: F(product), ingredient: F("amlodipine", 0.9) }), prof(), now).level, "unsure", product);
});
test("probe 8: pack code GTIN differs from the saved med's GTIN -> unsure", () => {
  assert.equal(checkLabel(base(), prof(), now, { raw: "x", gtin: "06414100099999" }).level, "unsure");
});
test("probe 9: oral solution vs tablet with the same number -> never a yes", () => {
  notYes(checkLabel(base({ strength: F("5 mg/5 ml"), product: F("Amlodipine oral solution") }), prof(), now).level);
});
test("probes 11 and 13: rolling dose window (midnight, twice-daily repeat) -> warning", () => {
  const late = prof({ doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 23, 50).getTime() }] });
  assert.equal(checkLabel(base(), late, new Date(2026, 10, 15, 0, 10)).level, "warning");
  const bid = prof({ meds: [{ ...aml, schedule: ["morning", "evening"] }], doseLog: [{ medId: "aml", ts: new Date(2026, 10, 15, 7, 0).getTime() }] });
  assert.equal(checkLabel(base(), bid, new Date(2026, 10, 15, 8, 0), undefined, "is this my morning pill").level, "warning");
  // ...but the evening dose of a twice-daily med is still a yes
  assert.equal(checkLabel(base(), bid, new Date(2026, 10, 15, 20, 0), undefined, "is this my evening pill").level, "match");
});
test("probe 19: free-text allergies are normalised, never reassured about", () => {
  for (const a of ["Allergic to peanuts", "Peanut allergy (severe)", "peanuts and tree nuts", "nut", "pähkinäallergia"])
    assert.equal(checkLabel(food(["peanuts"]), prof({ allergies: [a] }), now).level, "warning", a);
  // mapped and genuinely absent -> reassurance is fine, and it names the clean allergen
  const v = checkLabel(food(["peanuts"]), prof({ allergies: ["sesame seeds"] }), now);
  assert.equal(v.level, "info");
  assert.match(v.speech, /no sesame listed/);
  // an allergy the rules can't map -> never "none of your allergens"
  notYes(checkLabel(food(["peanuts"]), prof({ allergies: ["kiwi fruit enzyme thing"] }), now).level);
});
test("probe 21: 'may contain traces of nuts' with a peanut allergy -> warning", () => {
  const v = checkLabel(food(["may contain traces of nuts"]), prof({ allergies: ["peanut"] }), now);
  assert.equal(v.level, "warning");
  assert.doesNotMatch(v.speech, /may contain may contain/);
});
