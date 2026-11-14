import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { parseGs1 } from "../src/gs1.ts";
import { checkLabel, checkLabelText } from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const read = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication", product: f(null, 0), ingredient: f(null, 0), strength: f(null, 0), dosing: f(null, 0),
  expiry: f(null, 0), allergens: f<string[]>(null, 0), barcode: f(null, 0), readability: 0.9, ...p,
});
const AML_GTIN = "09501101530003";
const IBU_GTIN = "04006381333931";
const profile: Profile = {
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
    { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["as needed"], barcode: "4006381333931" },
  ],
  allergies: [], avoid: [], doseLog: [], lang: "en",
};
const amlRead = (expiry = f<string>("2027-08")) => read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry });
const code = (s: string) => parseGs1(s)!;
const sentences = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;

test("no code -> identical to the text-only check", () => {
  assert.deepEqual(checkLabel(amlRead(), profile, NOW), checkLabelText(amlRead(), profile, NOW));
  assert.deepEqual(checkLabel(amlRead(), profile, NOW, { raw: "x" }), checkLabelText(amlRead(), profile, NOW));
});

test("agreement (gtin + expiry) -> match, agrees=true, 'double-checked' within 2 sentences", () => {
  const v = checkLabel(amlRead(), profile, NOW, code(`(01)${AML_GTIN}(17)270831(10)B1`));
  assert.equal(v.level, "match");
  assert.equal(v.crossCheck?.agrees, true);
  assert.equal(v.speech, "Yes, Amlodipine 5 mg, your evening pill, double-checked with the pack's code. You haven't taken it today.");
  assert.ok(sentences(v.speech) <= 2);
});

test("saved EAN-13 barcode counts as the med's GTIN", () => {
  const v = checkLabel(read({ ingredient: f("ibuprofen"), strength: f("400 mg"), expiry: f("2027-01") }), profile, NOW, code(`(01)${IBU_GTIN}(17)270100`));
  assert.equal(v.crossCheck?.agrees, true);
});

test("expiry conflict (code vs legible print) -> unsure, ask a pharmacist", () => {
  const v = checkLabel(amlRead(f("2027-08")), profile, NOW, code(`(01)${AML_GTIN}(17)280300`));
  assert.equal(v.level, "unsure");
  assert.equal(v.crossCheck?.agrees, false);
  assert.equal(v.speech, "The printed label and the pack's code disagree. Please ask a pharmacist.");
});

test("GTIN of a different saved med than the text match -> unsure", () => {
  const v = checkLabel(amlRead(), profile, NOW, code(`(01)${IBU_GTIN}`));
  assert.equal(v.level, "unsure");
  assert.equal(v.crossCheck?.agrees, false);
});

test("GTIN of a saved med but legible text names an unlisted medicine -> unsure", () => {
  const v = checkLabel(read({ ingredient: f("metformin"), strength: f("500 mg") }), profile, NOW, code(`(01)${AML_GTIN}`));
  assert.equal(v.level, "unsure");
  assert.equal(v.crossCheck?.agrees, false);
});

test("code expiry in the past -> warning even if the print is illegible", () => {
  const v = checkLabel(amlRead(f<string>(null, 0.1)), profile, NOW, code(`(01)${AML_GTIN}(17)241100`));
  assert.equal(v.level, "warning");
  assert.match(v.speech, /pack's code says it expired in November 2024/);
  assert.equal(v.matchedMedId, "aml");
});

test("code GTIN = saved med but no legible text -> still unsure online", () => {
  const v = checkLabel(read({ kind: "medication", readability: 0.3, guidance: "Bring it closer." }), profile, NOW, code(`(01)${AML_GTIN}(17)270831`));
  assert.equal(v.level, "unsure");
  assert.match(v.speech, /code matches your Amlodipine, but I can't read the label/);
  assert.equal(v.crossCheck?.agrees, null);
});

test("code fills an illegible printed expiry (no 'couldn't read the expiry' note)", () => {
  const v = checkLabel(amlRead(f<string>(null, 0.1)), profile, NOW, code(`(17)270831`));
  assert.equal(v.level, "match");
  assert.doesNotMatch(v.speech, /couldn't read the expiry/);
  assert.equal(v.crossCheck?.agrees, null);
  assert.equal(v.read.expiry.value, null); // the verdict still shows what was actually printed/legible
});

test("unknown GTIN (not in the list) + matching expiry -> agrees on expiry only", () => {
  const v = checkLabel(amlRead(), profile, NOW, code("(01)05000000000017(17)270800"));
  assert.equal(v.level, "match");
  assert.equal(v.crossCheck?.agrees, true);
  assert.ok(v.crossCheck?.details.some((d) => d.includes("not saved")));
});
