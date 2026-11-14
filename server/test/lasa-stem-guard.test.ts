import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { avoidHits, checkLabel, fuzzyEq } from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0);
const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function mkRead(ingredient: string, strength: string, product?: string): LabelRead {
  return {
    kind: "medication",
    product: f(product ?? `${ingredient} ${strength}`),
    ingredient: f(ingredient),
    strength: f(strength),
    dosing: f(null, 0),
    expiry: f("2027-08"),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
  };
}

function mkProfile(id: string, name: string, ingredient: string, strength: string): Profile {
  return {
    meds: [{ id, name, ingredient, strength, schedule: ["evening"] }],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };
}

test("LASA INN-stem and chiral-prefix pairs never fuzzy-match each other", () => {
  const lasaPairs: [string, string, string][] = [
    ["amlodipine", "felodipine", "5 mg"],
    ["nifedipine", "nimodipine", "30 mg"],
    ["oxazepam", "diazepam", "10 mg"],
    ["oxazepam", "lorazepam", "1 mg"],
    ["prednisone", "prednisolone", "5 mg"],
    ["omeprazole", "esomeprazole", "20 mg"],
    ["citalopram", "escitalopram", "10 mg"],
    ["zopiclone", "eszopiclone", "5 mg"],
    ["timolol", "esmolol", "10 mg"],
    ["sufentanil", "alfentanil", "50 mcg"],
    ["dexamethasone", "betamethasone", "4 mg"],
    ["cyclosporine", "cycloserine", "250 mg"],
    ["bupivacaine", "ropivacaine", "5 mg"],
    ["bupivacaine", "mepivacaine", "5 mg"],
    ["prilocaine", "procaine", "10 mg"],
    ["miconazole", "econazole", "2 %"],
    ["miconazole", "tioconazole", "1 %"],
    ["aciclovir", "ganciclovir", "250 mg"],
    ["ganciclovir", "penciclovir", "1 %"],
    ["terazosin", "prazosin", "2 mg"],
    ["ofloxacin", "norfloxacin", "400 mg"],
    ["oxacillin", "cloxacillin", "500 mg"],
    ["amantadine", "rimantadine", "100 mg"],
  ];

  for (const [savedIng, heldIng, strength] of lasaPairs) {
    assert.equal(fuzzyEq(savedIng, heldIng), false, `${savedIng} vs ${heldIng}`);
    assert.equal(fuzzyEq(heldIng, savedIng), false, `${heldIng} vs ${savedIng}`);

    const profile = mkProfile("m1", savedIng, savedIng, strength);
    const verdict = checkLabel(mkRead(heldIng, strength), profile, NOW);
    assert.equal(verdict.level, "warning", `expected warning for ${heldIng} when saved med is ${savedIng}`);
    assert.equal(verdict.matchedMedId, undefined, `${heldIng} must not match ${savedIng}`);
    assert.ok(verdict.reasons.includes("not on your medication list"), `${heldIng} vs ${savedIng}`);
  }
});

test("chemical suffix swaps with edit distance 1 do not fuzzy-match", () => {
  assert.equal(fuzzyEq("retinol", "retinal"), false);
  assert.equal(fuzzyEq("retinal", "retinol"), false);
  assert.equal(fuzzyEq("sulfate", "sulfite"), false);
  assert.equal(fuzzyEq("testosterone", "testosterine"), false);
  assert.equal(fuzzyEq("timolol", "tamolol"), false);
});

test("single-character OCR typos and European spelling variants still match", () => {
  const validVariants: [string, string, string][] = [
    ["amlodipine", "amlodipin", "5 mg"],
    ["amlodipine", "amlodpine", "5 mg"],
    ["metformin", "metformine", "500 mg"],
    ["ibuprofen", "ibuprofene", "400 mg"],
    ["bisoprolol", "bisoprololi", "5 mg"],
    ["simvastatin", "simvastatine", "20 mg"],
    ["atorvastatin", "atorvastatine", "10 mg"],
  ];

  for (const [savedIng, readVariant, strength] of validVariants) {
    assert.equal(fuzzyEq(savedIng, readVariant), true, `${savedIng} vs ${readVariant}`);
    const profile = mkProfile("m1", savedIng, savedIng, strength);
    const verdict = checkLabel(mkRead(readVariant, strength), profile, NOW);
    assert.equal(verdict.level, "match", `expected match for ${readVariant} -> ${savedIng}`);
    assert.equal(verdict.matchedMedId, "m1");
  }
});

test("avoidHits does not cross-fire across distinct LASA INN-stem drugs", () => {
  const readFelodipine = mkRead("felodipine", "5 mg");
  assert.deepEqual(avoidHits(readFelodipine, ["amlodipine"]), []);
  assert.equal(avoidHits(readFelodipine, ["felodipine"]).length, 1);

  const readEsomeprazole = mkRead("esomeprazole", "20 mg");
  assert.deepEqual(avoidHits(readEsomeprazole, ["omeprazole"]), []);
});
