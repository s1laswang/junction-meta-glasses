import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import {
  allergenHits,
  avoidHits,
  checkLabel,
  fmtStrength,
  ingredientsOf,
  matchMed,
  parseStrength,
  sameStrength,
} from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function makeRead(p: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2027-08", 0.95),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...p,
  };
}

function makeProfile(meds: Med[], extra: Partial<Profile> = {}): Profile {
  return {
    meds,
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...extra,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertVerdictBounds(headline: string, speech: string, tag: string) {
  assert.ok(wordCount(headline) <= 8, `${tag} headline words: "${headline}"`);
  assert.ok(sentenceCount(speech) <= 2, `${tag} speech sentences: "${speech}"`);
}

test("microgram and Nordic unit variants normalise including Greek mu U+03BC and micro sign U+00B5", () => {
  const fiftyMcgVariants = [
    "50 \u03bcg",
    "50\u03bcg",
    "50 \u039cg",
    "50 \u00b5g",
    "50\u00b5g",
    "50 mcg",
    "50mcg",
    "50 ug",
    "50 mikrog",
    "50 mikrog.",
    "50 mikrogram",
    "50 mikrogramm",
    "50 mikrogramma",
    "50 mikrogrammaa",
    "50 microgram",
    "50 micrograms",
    "50 microgrammes",
  ];

  for (const variant of fiftyMcgVariants) {
    assert.deepEqual(parseStrength(variant), [{ amount: 0.05, unit: "mg" }], variant);
    assert.equal(sameStrength(variant, "50 mcg"), true, variant);
    assert.equal(sameStrength(variant, "0.05 mg"), true, variant);
    assert.equal(sameStrength(variant, "0,05 mg"), true, variant);
    assert.equal(sameStrength(variant, "50 mg"), false, variant);
  }

  assert.deepEqual(parseStrength("5 milligrammaa"), [{ amount: 5, unit: "mg" }]);
  assert.deepEqual(parseStrength("5 milligramma"), [{ amount: 5, unit: "mg" }]);
  assert.deepEqual(parseStrength("1 grammaa"), [{ amount: 1000, unit: "mg" }]);
  assert.deepEqual(parseStrength("0,5 grammaa"), [{ amount: 500, unit: "mg" }]);
  assert.deepEqual(parseStrength("5 millilitraa"), [{ amount: 5, unit: "ml" }]);
  assert.deepEqual(parseStrength("1000 KY"), [{ amount: 1000, unit: "iu" }]);
  assert.deepEqual(parseStrength("1000 IE"), [{ amount: 1000, unit: "iu" }]);
  assert.equal(sameStrength("1000 KY", "1000 IU"), true);
  assert.equal(sameStrength("1000 IE", "1000 IU"), true);
  assert.equal(sameStrength("1000 IE", "1000 KY"), true);
  assert.equal(sameStrength("1000 IE", "400 IU"), false);
  assert.equal(sameStrength("1000 KY", "1000 mg"), false);

  assert.equal(fmtStrength("50\u03bcg"), "50 \u03bcg");
  assert.equal(fmtStrength("50\u00b5g"), "50 \u00b5g");
  assert.equal(fmtStrength("50mikrog"), "50 mikrog");
  assert.equal(fmtStrength("1000KY"), "1000 KY");
  assert.equal(fmtStrength("1000IE"), "1000 IE");
});

test("1000x mcg vs mg guard: Thyroxin 100 mcg matches 0.1 mg and never matches 100 mg or 250 mg", () => {
  const thyroxin100: Med = {
    id: "thy100",
    name: "Thyroxin",
    ingredient: "levothyroxine",
    strength: "100 mcg",
    schedule: ["morning"],
  };
  const profile100 = makeProfile([thyroxin100]);

  for (const eqStrength of ["100 mcg", "100 \u03bcg", "100 \u00b5g", "100 mikrog", "100 mikrogrammaa", "0.1 mg", "0,1 mg"]) {
    const ok = checkLabel(
      makeRead({ product: f(`Thyroxin ${eqStrength}`), ingredient: f("levothyroxine"), strength: f(eqStrength) }),
      profile100,
      NOW,
    );
    assert.equal(ok.level, "match", eqStrength);
    assert.equal(ok.matchedMedId, "thy100", eqStrength);
    assertVerdictBounds(ok.headline, ok.speech, eqStrength);
  }

  for (const wrongStrength of ["100 mg", "10 mg", "1 mg", "25 mcg", "50 \u03bcg", "150 mikrog"]) {
    const bad = checkLabel(
      makeRead({ product: f(`Levothyroxine ${wrongStrength}`), ingredient: f("levothyroxine"), strength: f(wrongStrength) }),
      profile100,
      NOW,
    );
    assert.equal(bad.level, "warning", wrongStrength);
    assert.equal(bad.matchedMedId, "thy100", wrongStrength);
    assert.match(bad.headline, /wrong strength/, wrongStrength);
    assertVerdictBounds(bad.headline, bad.speech, wrongStrength);
  }

  assert.equal(sameStrength("250 mcg", "250 mg"), false);
  assert.equal(sameStrength("250 \u03bcg", "250 mg"), false);
  assert.equal(sameStrength("250 mikrog", "0.25 mg"), true);

  const digoxinProfile = makeProfile([
    { id: "dig", name: "Digoxin", ingredient: "digoxin", strength: "250 mcg", schedule: ["morning"] },
  ]);
  const dig250mg = checkLabel(makeRead({ ingredient: f("digoxin"), strength: f("250 mg") }), digoxinProfile, NOW);
  assert.equal(dig250mg.level, "warning");
  assert.match(dig250mg.headline, /wrong strength/);
  const dig025mg = checkLabel(makeRead({ ingredient: f("digoxin"), strength: f("0,25 mg") }), digoxinProfile, NOW);
  assert.equal(dig025mg.level, "match");
});

test("shared-unit slash and plus combination strengths parse all components and reject single-mass matches", () => {
  assert.deepEqual(parseStrength("5/160 mg"), [
    { amount: 5, unit: "mg" },
    { amount: 160, unit: "mg" },
  ]);
  assert.deepEqual(parseStrength("50/12,5 mg"), [
    { amount: 50, unit: "mg" },
    { amount: 12.5, unit: "mg" },
  ]);
  assert.deepEqual(parseStrength("100/25 mcg"), [
    { amount: 0.1, unit: "mg" },
    { amount: 0.025, unit: "mg" },
  ]);
  assert.deepEqual(parseStrength("160/4,5 mikrog/annos"), [
    { amount: 0.16, unit: "mg" },
    { amount: 0.0045, unit: "mg" },
  ]);
  assert.deepEqual(parseStrength("200/50/200 mg"), [
    { amount: 200, unit: "mg" },
    { amount: 50, unit: "mg" },
    { amount: 200, unit: "mg" },
  ]);

  assert.equal(sameStrength("5/160 mg", "5 mg + 160 mg"), true);
  assert.equal(sameStrength("5/160 mg", "5 mg / 160 mg"), true);
  assert.equal(sameStrength("50/12,5 mg", "50 mg + 12.5 mg"), true);
  assert.equal(sameStrength("100/25 mcg", "0.1 mg + 0.025 mg"), true);

  assert.equal(sameStrength("5/160 mg", "5 mg"), false);
  assert.equal(sameStrength("5/160 mg", "160 mg"), false);
  assert.equal(sameStrength("5 mg / 160 mg", "5 mg"), false);
  assert.equal(sameStrength("5 mg / 160 mg", "160 mg"), false);
  assert.equal(sameStrength("5 mg + 160 mg", "5 mg"), false);
  assert.equal(sameStrength("50/12,5 mg", "50 mg"), false);
  assert.equal(sameStrength("50/12,5 mg", "12.5 mg"), false);
  assert.equal(sameStrength("100/25 mcg", "100 mcg"), false);
  assert.equal(sameStrength("100/25 mcg", "25 mcg"), false);
  assert.equal(sameStrength("100/25 mcg", "100/25 mg"), false);
  assert.equal(sameStrength("5 mg + 5 mg", "5 mg + 160 mg"), false);
});

test("oral solution mass-per-volume preserves 500 mg / 5 ml matching 500 mg while rejecting volume mismatch", () => {
  assert.equal(sameStrength("500 mg / 5 ml", "500 mg"), true);
  assert.equal(sameStrength("500 mg", "500 mg/5 ml"), true);
  assert.equal(sameStrength("500 mg / 5 ml", "500 mg/5 ml"), true);
  assert.equal(sameStrength("500 mg / 5 ml", "500 mg / 10 ml"), false);
  assert.equal(sameStrength("500 mg / 5 ml", "250 mg / 5 ml"), false);
  assert.equal(sameStrength("500 mg + 125 mg / 5 ml", "500 mg / 5 ml"), false);
  assert.equal(sameStrength("500 mg + 125 mg / 5 ml", "500 mg"), false);
});

test("combination medication never matches a single-ingredient saved med even with matching primary strength", () => {
  const singleMeds: Med[] = [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] },
    { id: "ram", name: "Cardace", ingredient: "ramipril", strength: "5 mg", schedule: ["morning"] },
    { id: "amx", name: "Amoxin", ingredient: "amoxicillin", strength: "875 mg", schedule: ["morning", "evening"] },
  ];
  const profile = makeProfile(singleMeds);

  const comboReads: Array<{ tag: string; read: LabelRead }> = [
    {
      tag: "amlodipine+valsartan explicit",
      read: makeRead({ product: f("Amlodipine/Valsartan 5 mg/160 mg"), ingredient: f("amlodipine, valsartan"), strength: f("5 mg / 160 mg") }),
    },
    {
      tag: "amlodipine+valsartan partial strength 5 mg",
      read: makeRead({ product: f("Amlodipine/Valsartan"), ingredient: f("amlodipine + valsartan"), strength: f("5 mg") }),
    },
    {
      tag: "Exforge brand only",
      read: makeRead({ product: f("Exforge 5/160 mg"), strength: f("5/160 mg") }),
    },
    {
      tag: "paracetamol+codeine explicit",
      read: makeRead({ product: f("Panacod 500 mg / 30 mg"), ingredient: f("paracetamol, codeine phosphate"), strength: f("500 mg + 30 mg") }),
    },
    {
      tag: "Panacod brand only with partial strength",
      read: makeRead({ product: f("Panacod 500/30 mg"), strength: f("500 mg") }),
    },
    {
      tag: "Cardace Comp modifier without explicit ingredient",
      read: makeRead({ product: f("Cardace Comp 5 mg / 25 mg"), strength: f("5 mg") }),
    },
    {
      tag: "amoxicillin+clavulanic acid",
      read: makeRead({ product: f("Augmentin 875/125 mg"), ingredient: f("amoxicillin, clavulanic acid"), strength: f("875/125 mg") }),
    },
  ];

  for (const c of comboReads) {
    assert.equal(matchMed(c.read, singleMeds), undefined, c.tag);
    const v = checkLabel(c.read, profile, NOW);
    assert.equal(v.level, "warning", c.tag);
    assert.equal(v.matchedMedId, undefined, c.tag);
    assert.ok(v.reasons.includes("not on your medication list"), c.tag);
    assertVerdictBounds(v.headline, v.speech, c.tag);
  }
});

test("single-ingredient pack never matches a saved combination med, while true combo matches its saved combo med", () => {
  const comboProfile = makeProfile([
    { id: "amv", name: "Exforge", ingredient: "amlodipine, valsartan", strength: "5 mg / 160 mg", schedule: ["morning"] },
    { id: "sta", name: "Stalevo", ingredient: "levodopa, carbidopa, entacapone", strength: "100/25/200 mg", schedule: ["morning"] },
  ]);

  const plainAml = makeRead({ product: f("Amlodipin Orion 5 mg"), ingredient: f("amlodipine"), strength: f("5 mg") });
  assert.equal(matchMed(plainAml, comboProfile.meds), undefined);
  const vPlain = checkLabel(plainAml, comboProfile, NOW);
  assert.equal(vPlain.level, "warning");
  assert.equal(vPlain.matchedMedId, undefined);
  assertVerdictBounds(vPlain.headline, vPlain.speech, "plain-aml-vs-combo");

  const twoOfThree = makeRead({ product: f("Sinemet 100/25 mg"), ingredient: f("levodopa, carbidopa"), strength: f("100/25 mg") });
  assert.equal(matchMed(twoOfThree, comboProfile.meds), undefined);

  const trueCombo = makeRead({
    product: f("Amlodipine/Valsartan Orion 5/160 mg"),
    ingredient: f("valsartan, amlodipine besilate"),
    strength: f("5/160 mg"),
  });
  const vCombo = checkLabel(trueCombo, comboProfile, NOW);
  assert.equal(vCombo.level, "match");
  assert.equal(vCombo.matchedMedId, "amv");
  assertVerdictBounds(vCombo.headline, vCombo.speech, "true-combo-match");

  const brandCombo = makeRead({ product: f("Exforge"), strength: f("5 mg + 160 mg") });
  const vBrand = checkLabel(brandCombo, comboProfile, NOW);
  assert.equal(vBrand.level, "match");
  assert.equal(vBrand.matchedMedId, "amv");

  const bothProfile = makeProfile([
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "amv", name: "Exforge", ingredient: "amlodipine, valsartan", strength: "5/160 mg", schedule: ["morning"] },
  ]);
  assert.equal(checkLabel(plainAml, bothProfile, NOW).matchedMedId, "aml");
  assert.equal(checkLabel(trueCombo, bothProfile, NOW).matchedMedId, "amv");

  const wrongComboStrength = makeRead({
    product: f("Amlodipine/Valsartan 10/160 mg"),
    ingredient: f("amlodipine, valsartan"),
    strength: f("10/160 mg"),
  });
  const vWrongCombo = checkLabel(wrongComboStrength, bothProfile, NOW);
  assert.equal(vWrongCombo.level, "warning");
  assert.equal(vWrongCombo.matchedMedId, "amv");
  assert.match(vWrongCombo.headline, /wrong strength/);
});

test("combo brands expand in ingredientsOf so opioid, NSAID, and penicillin checks fire on brand-only reads", () => {
  assert.equal(ingredientsOf("Panacod 500/30 mg").has("codeine"), true);
  assert.equal(ingredientsOf("Augmentin 875/125 mg").has("amoxicillin"), true);
  assert.equal(ingredientsOf("Vimovo 500/20 mg").has("naproxen"), true);

  const panacodRead = makeRead({ product: f("Panacod 500/30 mg"), strength: f("500/30 mg") });
  assert.equal(avoidHits(panacodRead, ["opioids"]).length, 1);

  const augmentinRead = makeRead({ product: f("Augmentin 875/125 mg"), strength: f("875/125 mg") });
  const penHits = allergenHits(augmentinRead, ["penisilliini"]);
  assert.equal(penHits.length, 1);
  assert.equal(penHits[0].found, "amoxicillin");

  const vimovoRead = makeRead({ product: f("Vimovo 500/20 mg"), strength: f("500/20 mg") });
  assert.equal(avoidHits(vimovoRead, ["NSAIDs"]).length, 1);
});

test("bilingual FI/SV/EU slash-separated single-ingredient packs coalesce while true combinations still reject", () => {
  const profile = makeProfile([
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] },
    { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["morning", "evening"] },
  ]);

  const ml11Occluded = makeRead({
    product: f("AMLODIPIN / AMLODIPINE", 0.98),
    ingredient: f("amlodipine", 0.98),
    strength: f(null, 0.1),
    readability: 0.6,
    guidance: "Move your thumb away from the text.",
  });
  const vOccluded = checkLabel(ml11Occluded, profile, NOW);
  assert.equal(vOccluded.level, "unsure");
  assert.equal(vOccluded.matchedMedId, "aml");
  assert.ok(vOccluded.reasons.includes("strength not readable"));
  assert.ok(!vOccluded.reasons.includes("not on your medication list"));
  assertVerdictBounds(vOccluded.headline, vOccluded.speech, "ml11-occluded");

  const bilingualMatches: Array<{ tag: string; read: LabelRead; expectedId: string }> = [
    {
      tag: "AMLODIPIN / AMLODIPINE 5 mg",
      read: makeRead({ product: f("AMLODIPIN / AMLODIPINE"), ingredient: f("amlodipine"), strength: f("5 mg") }),
      expectedId: "aml",
    },
    {
      tag: "amlodipiini / amlodipin FI/SV",
      read: makeRead({ product: f("Amlodipiini / Amlodipin Orion 5 mg"), ingredient: f("amlodipiini / amlodipin"), strength: f("5 mg") }),
      expectedId: "aml",
    },
    {
      tag: "Active substance / Wirkstoff multilingual header",
      read: makeRead({
        product: f("AMLODIPIN / AMLODIPINE 5 mg"),
        ingredient: f("Active substance: amlodipine / Wirkstoff: Amlodipin"),
        strength: f("5 mg"),
      }),
      expectedId: "aml",
    },
    {
      tag: "Vaikuttava aine / Aktiv substans FI/SV header",
      read: makeRead({
        product: f("Metformiini / Metformin 500 mg"),
        ingredient: f("Vaikuttava aine: metformiini / Aktiv substans: metformin"),
        strength: f("500 mg"),
      }),
      expectedId: "met",
    },
    {
      tag: "parasetamoli / paracetamol FI/SV",
      read: makeRead({ product: f("Parasetamoli / Paracetamol 500 mg"), ingredient: f("parasetamoli / paracetamol"), strength: f("500 mg") }),
      expectedId: "par",
    },
  ];

  for (const bm of bilingualMatches) {
    const v = checkLabel(bm.read, profile, NOW);
    assert.equal(v.level, "match", bm.tag);
    assert.equal(v.matchedMedId, bm.expectedId, bm.tag);
    assertVerdictBounds(v.headline, v.speech, bm.tag);
  }

  for (const comboIng of ["amlodipine / valsartan", "paracetamol / codeine", "amoxicillin / clavulanic acid"]) {
    const cr = makeRead({ product: f(comboIng), ingredient: f(comboIng), strength: f("5 mg") });
    assert.equal(matchMed(cr, profile.meds), undefined, comboIng);
    const cv = checkLabel(cr, profile, NOW);
    assert.equal(cv.level, "warning", comboIng);
    assert.ok(cv.reasons.includes("not on your medication list"), comboIng);
  }
});
