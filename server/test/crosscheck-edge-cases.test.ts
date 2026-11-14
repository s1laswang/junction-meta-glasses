import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile, Verdict } from "../../shared/types.ts";
import { parseGs1 } from "../src/gs1.ts";
import { checkLabel, STRENGTH_MIN_CONF } from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const read = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication",
  product: f(null, 0),
  ingredient: f(null, 0),
  strength: f(null, 0),
  dosing: f(null, 0),
  expiry: f(null, 0),
  allergens: f<string[]>(null, 0),
  barcode: f(null, 0),
  readability: 0.9,
  ...p,
});

const AML_GTIN = "09501101530003";
const IBU_GTIN = "04006381333931";
const AMOX_GTIN = "06416542002149";
const GEN_GTIN = "05000000000017";
const PHARMACIST = "The printed label and the pack's code disagree. Please ask a pharmacist.";

const makeProfile = (overrides: Partial<Profile> = {}): Profile => ({
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
    { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["as needed"], gtin: IBU_GTIN },
    { id: "amox", name: "Amorion", ingredient: "amoxicillin", strength: "500 mg", schedule: ["morning", "evening"], gtin: AMOX_GTIN },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
  ...overrides,
});

const code = (s: string) => parseGs1(s)!;
const sentences = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;
const wordCount = (s: string) => s.trim().split(/\s+/).length;

function assertNoDoubleChecked(v: Verdict): void {
  assert.doesNotMatch(v.speech, /double-checked/i);
  assert.ok(sentences(v.speech) <= 2, `expected <= 2 sentences, got: ${v.speech}`);
  assert.ok(wordCount(v.headline) <= 8, `expected <= 8 words, got: ${v.headline}`);
}

test("known GTIN (5 mg) + legible wrong printed strength (10 mg) -> unsure, agrees=false, pharmacist speech", () => {
  const profile = makeProfile();
  const v = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("10 mg", 0.95), expiry: f("2027-08") }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)270831(10)B1`),
  );
  assert.equal(v.level, "unsure");
  assert.equal(v.headline, "Label and pack code disagree");
  assert.equal(v.speech, PHARMACIST);
  assert.equal(v.crossCheck?.agrees, false);
  assert.ok(v.crossCheck?.details.some((d) => d.includes(`GTIN ${AML_GTIN} = your Amlodipine 5 mg, but the print reads 10 mg`)));
  assertNoDoubleChecked(v);

  const atMinConf = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("2.5 mg", STRENGTH_MIN_CONF), expiry: f("2027-08") }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)270831`),
  );
  assert.equal(atMinConf.level, "unsure");
  assert.equal(atMinConf.crossCheck?.agrees, false);
  assert.equal(atMinConf.speech, PHARMACIST);

  const illegibleNameWrongStrength = checkLabel(
    read({ ingredient: f(null, 0), product: f(null, 0), strength: f("10 mg", 0.92), expiry: f("2027-08") }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)270831`),
  );
  assert.equal(illegibleNameWrongStrength.level, "unsure");
  assert.equal(illegibleNameWrongStrength.crossCheck?.agrees, false);
  assert.equal(illegibleNameWrongStrength.speech, PHARMACIST);

  const sameNormalizedStrength = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5,0 mg", 0.92), expiry: f("2027-08") }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)270831`),
  );
  assert.equal(sameNormalizedStrength.level, "match");
  assert.equal(sameNormalizedStrength.crossCheck?.agrees, true);
  assert.match(sameNormalizedStrength.speech, /double-checked with the pack's code/);
});

test("thumb-over-strength (null or conf 0.5) with matching GTIN + matching expiry -> unsure, agrees=null, no double-checked speech", () => {
  const profile = makeProfile();
  const dm = code(`(01)${AML_GTIN}(17)270831(10)B1`);

  const nullStrength = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f<string>(null, 0), expiry: f("2027-08") }),
    profile,
    NOW,
    dm,
  );
  assert.equal(nullStrength.level, "unsure");
  assert.equal(nullStrength.crossCheck?.agrees, null);
  assertNoDoubleChecked(nullStrength);

  const lowConfSame = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg", 0.5), expiry: f("2027-08") }),
    profile,
    NOW,
    dm,
  );
  assert.equal(lowConfSame.level, "unsure");
  assert.equal(lowConfSame.crossCheck?.agrees, null);
  assertNoDoubleChecked(lowConfSame);

  const lowConfWrong = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("10 mg", 0.5), expiry: f("2027-08") }),
    profile,
    NOW,
    dm,
  );
  assert.equal(lowConfWrong.level, "unsure");
  assert.equal(lowConfWrong.crossCheck?.agrees, null);
  assertNoDoubleChecked(lowConfWrong);

  const thumbOverNameMatchingExpiry = checkLabel(
    read({ ingredient: f(null, 0), product: f(null, 0), expiry: f("2027-08"), readability: 0.4 }),
    profile,
    NOW,
    dm,
  );
  assert.equal(thumbOverNameMatchingExpiry.level, "unsure");
  assert.equal(thumbOverNameMatchingExpiry.crossCheck?.agrees, null);
  assertNoDoubleChecked(thumbOverNameMatchingExpiry);
});

test("already-taken dose today, avoid-list drug, and allergen drug with matching DataMatrix expiry/GTIN -> warning, agrees=null, no double-checked speech", () => {
  const alreadyTaken = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }),
    makeProfile({ doseLog: [{ medId: "aml", ts: NOW.getTime() - 3600_000 }] }),
    NOW,
    code(`(01)${AML_GTIN}(17)270831`),
  );
  assert.equal(alreadyTaken.level, "warning");
  assert.equal(alreadyTaken.takenToday, true);
  assert.equal(alreadyTaken.crossCheck?.agrees, null);
  assertNoDoubleChecked(alreadyTaken);

  const avoidSaved = checkLabel(
    read({ ingredient: f("ibuprofen"), strength: f("400 mg"), expiry: f("2027-08") }),
    makeProfile({ avoid: ["NSAIDs"] }),
    NOW,
    code(`(01)${IBU_GTIN}(17)270831`),
  );
  assert.equal(avoidSaved.level, "warning");
  assert.equal(avoidSaved.crossCheck?.agrees, null);
  assertNoDoubleChecked(avoidSaved);

  const avoidUnlisted = checkLabel(
    read({ product: f("Pronaxen"), ingredient: f("naproxen"), strength: f("250 mg"), expiry: f("2027-08") }),
    makeProfile({ avoid: ["NSAIDs"] }),
    NOW,
    code(`(01)${GEN_GTIN}(17)270831`),
  );
  assert.equal(avoidUnlisted.level, "warning");
  assert.equal(avoidUnlisted.crossCheck?.agrees, null);
  assertNoDoubleChecked(avoidUnlisted);

  const drugAllergy = checkLabel(
    read({ ingredient: f("amoxicillin"), strength: f("500 mg"), expiry: f("2027-08") }),
    makeProfile({ allergies: ["penicillin"] }),
    NOW,
    code(`(01)${AMOX_GTIN}(17)270831`),
  );
  assert.equal(drugAllergy.level, "warning");
  assert.equal(drugAllergy.crossCheck?.agrees, null);
  assertNoDoubleChecked(drugAllergy);

  const excipientAllergy = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08"), allergens: f(["lactose monohydrate"], 0.95) }),
    makeProfile({ allergies: ["milk"] }),
    NOW,
    code(`(01)${AML_GTIN}(17)270831`),
  );
  assert.equal(excipientAllergy.level, "warning");
  assert.equal(excipientAllergy.crossCheck?.agrees, null);
  assertNoDoubleChecked(excipientAllergy);
});

test("expired DataMatrix code + matching GTIN -> warning, agrees=null, no double-checked speech", () => {
  const profile = makeProfile();

  const expiredIllegiblePrint = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f<string>(null, 0.1) }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)241100`),
  );
  assert.equal(expiredIllegiblePrint.level, "warning");
  assert.equal(expiredIllegiblePrint.crossCheck?.agrees, null);
  assertNoDoubleChecked(expiredIllegiblePrint);

  const expiredMatchingPrint = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2024-11", 0.95) }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}(17)241100`),
  );
  assert.equal(expiredMatchingPrint.level, "warning");
  assert.equal(expiredMatchingPrint.crossCheck?.agrees, null);
  assertNoDoubleChecked(expiredMatchingPrint);

  const gtinOnlyExpiredPrint = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2024-11", 0.95) }),
    profile,
    NOW,
    code(`(01)${AML_GTIN}`),
  );
  assert.equal(gtinOnlyExpiredPrint.level, "warning");
  assert.equal(gtinOnlyExpiredPrint.crossCheck?.agrees, null);
  assertNoDoubleChecked(gtinOnlyExpiredPrint);
});

test("food item with matching DataMatrix expiry -> info, agrees=null, no double-checked speech", () => {
  const foodRead = read({
    kind: "food",
    product: f("Oat drink", 0.96),
    allergens: f(["oats"], 0.98),
    expiry: f("2027-08-31", 0.95),
    readability: 0.95,
  });

  const withoutAllergies = checkLabel(
    foodRead,
    makeProfile({ allergies: [] }),
    NOW,
    code(`(01)${GEN_GTIN}(17)270831`),
  );
  assert.equal(withoutAllergies.level, "info");
  assert.equal(withoutAllergies.crossCheck?.agrees, null);
  assertNoDoubleChecked(withoutAllergies);

  const withSafeAllergies = checkLabel(
    foodRead,
    makeProfile({ allergies: ["peanut"] }),
    NOW,
    code(`(01)${GEN_GTIN}(17)270831`),
  );
  assert.equal(withSafeAllergies.level, "info");
  assert.equal(withSafeAllergies.crossCheck?.agrees, null);
  assertNoDoubleChecked(withSafeAllergies);

  const genericMedSubstitution = checkLabel(
    read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }),
    makeProfile(),
    NOW,
    code(`(01)${GEN_GTIN}(17)270800`),
  );
  assert.equal(genericMedSubstitution.level, "match");
  assert.equal(genericMedSubstitution.crossCheck?.agrees, true);
  assert.ok(genericMedSubstitution.crossCheck?.details.some((d) => d.includes("not saved in your list")));
  assert.match(genericMedSubstitution.speech, /double-checked with the pack's code/);
});
