import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { allergenHits, avoidHits, checkLabel, ingredientsOf, matchMed, parseStrength, sameStrength } from "../src/safety.ts";
import { toLabelRead, toProfile } from "../src/verify.ts";

const NOW = new Date(2026, 10, 14, 9, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const makeRead = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication", product: f(null, 0), ingredient: f(null, 0), strength: f(null, 0), dosing: f(null, 0),
  expiry: f(null, 0), allergens: f<string[]>(null, 0), barcode: f(null, 0), readability: 0.92, ...p,
});
const makeProfile = (p: Partial<Profile> = {}): Profile => ({ meds: [], allergies: [], avoid: [], doseLog: [], lang: "en", ...p });

test("1000x unit mismatch hazard: saved levothyroxine 100 mikrog vs 100 mg label is warning, never match", () => {
  const levo: Med = { id: "levo", name: "Thyroxin", ingredient: "levothyroxine", strength: "100 mikrog", schedule: ["morning"] };
  const p = makeProfile({ meds: [levo] });
  const hazard = checkLabel(makeRead({ product: f("Levothyroxine"), ingredient: f("levothyroxine"), strength: f("100 mg") }), p, NOW);
  assert.equal(hazard.level, "warning");
  assert.notEqual(hazard.level, "match");
  assert.equal(hazard.matchedMedId, "levo");
  assert.match(hazard.headline, /wrong strength/i);
  assert.ok(hazard.reasons.some((r) => r.includes("100 mg") && r.includes("100 mikrog")));

  const okMicrog = checkLabel(makeRead({ product: f("Thyroxin"), ingredient: f("levothyroxine"), strength: f("100 \u00b5g"), expiry: f("2027-09") }), p, NOW);
  assert.equal(okMicrog.level, "match");
  assert.equal(okMicrog.matchedMedId, "levo");
});

test("unit equivalences and non-equivalences across mg, mcg, ug, microg, mikrog, g, ml, IU, KY, %", () => {
  assert.ok(sameStrength("50 mcg", "0.05 mg"));
  assert.ok(sameStrength("100 \u00b5g", "100 mikrog"));
  assert.ok(sameStrength("100 ug", "100 microgram"));
  assert.ok(sameStrength("0.5 g", "500 mg"));
  assert.ok(sameStrength("1 g", "1000 mg"));
  assert.ok(sameStrength("2,5 mg", "2.5 mg"));
  assert.ok(!sameStrength("2,5 mg", "25 mg"));
  assert.ok(sameStrength("1000 IU", "1000 KY"));
  assert.ok(!sameStrength("1000 IU", "1000 mg"));
  assert.ok(!sameStrength("1 %", "1 mg"));
  assert.ok(!sameStrength("500 mg/5 ml", "250 mg/5 ml"));
  assert.deepEqual(parseStrength("100 \u00b5g"), [{ amount: 0.1, unit: "mg" }]);
  assert.deepEqual(parseStrength("1000 KY"), [{ amount: 1000, unit: "iu" }]);
  assert.deepEqual(parseStrength("1 %"), [{ amount: 1, unit: "%" }]);
});

test("combination strengths: amlodipine/valsartan and amoxicillin/clavulanic acid", () => {
  const p = makeProfile({
    meds: [
      { id: "amlval", name: "Exforge", ingredient: "amlodipine, valsartan", strength: "5 mg / 160 mg", schedule: ["morning"] },
      { id: "amoxclav", name: "Bioclavid", ingredient: "amoxicillin, clavulanic acid", strength: "875 mg / 125 mg", schedule: ["08:00", "20:00"] },
    ],
  });
  const wrongVal = checkLabel(makeRead({ ingredient: f("amlodipine, valsartan"), strength: f("5 mg / 80 mg") }), p, NOW);
  assert.equal(wrongVal.level, "warning");
  assert.equal(wrongVal.matchedMedId, "amlval");
  assert.match(wrongVal.headline, /wrong/i);
  assert.ok(wrongVal.reasons.some((r) => r.includes("5 mg / 80 mg") && r.includes("5 mg / 160 mg")));

  const exactVal = checkLabel(makeRead({ ingredient: f("amlodipine, valsartan"), strength: f("5 mg / 160 mg"), expiry: f("2027-12") }), p, NOW);
  assert.equal(exactVal.level, "match");
  assert.equal(exactVal.matchedMedId, "amlval");

  const wrongAmox = checkLabel(makeRead({ ingredient: f("amoxicillin, clavulanic acid"), strength: f("500 mg / 125 mg") }), p, NOW);
  assert.equal(wrongAmox.level, "warning");
  assert.ok(wrongAmox.reasons.some((r) => r.includes("500 mg / 125 mg") && r.includes("875 mg / 125 mg")));
});

test("combo paracetamol + codeine flags opioid avoid or allergy even when paracetamol is on meds", () => {
  const paraMed: Med = { id: "para", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] };
  const comboBox = makeRead({ product: f("Panacod"), ingredient: f("paracetamol, codeine"), strength: f("500 mg / 30 mg") });

  const withAvoid = checkLabel(comboBox, makeProfile({ meds: [paraMed], avoid: ["opioids"] }), NOW);
  assert.equal(withAvoid.level, "warning");
  assert.ok(withAvoid.reasons.some((r) => r.includes("codeine") && r.includes("opioid")));

  const withAllergy = checkLabel(comboBox, makeProfile({ meds: [paraMed], allergies: ["opioids"] }), NOW);
  assert.equal(withAllergy.level, "warning");
  assert.match(withAllergy.speech, /codeine/i);
  assert.match(withAllergy.speech, /opioids/i);
});

test("combo naproxen + esomeprazole warns on tulehduskipulaake and NSAIDs avoid rules", () => {
  const esoMed: Med = { id: "eso", name: "Nexium", ingredient: "esomeprazole", strength: "20 mg", schedule: ["morning"] };
  const combo = makeRead({ product: f("Vimovo"), ingredient: f("naproxen, esomeprazole"), strength: f("500 mg / 20 mg") });
  for (const term of ["tulehduskipulaake", "NSAIDs"]) {
    assert.ok(avoidHits(combo, [term]).some((h) => h.includes("naproxen") && h.includes("NSAID")));
    const verdict = checkLabel(combo, makeProfile({ meds: [esoMed], avoid: [term] }), NOW);
    assert.equal(verdict.level, "warning");
    assert.ok(verdict.reasons.some((r) => r.includes("naproxen")));
  }
});

test("manufacturer and dosage-form STOP words never cross-match unrelated medications", () => {
  assert.equal(ingredientsOf("Orion Ratiopharm Sandoz Krka tabletti kalvopaallysteinen depot forte").size, 0);
  const p = makeProfile({
    meds: [
      { id: "m1", name: "Metforem Orion Ratiopharm depot tabletti", ingredient: "metformin", strength: "500 mg", schedule: ["morning"] },
      { id: "m2", name: "Atorvastatin Sandoz Krka kalvopaallysteinen forte tabletti", ingredient: "atorvastatin", strength: "20 mg", schedule: ["evening"] },
    ],
  });
  const otherBox = makeRead({ product: f("Bisoprolol Orion Ratiopharm Sandoz Krka kalvopaallysteinen depot forte tabletti"), ingredient: f("bisoprolol"), strength: f("5 mg") });
  assert.equal(matchMed(otherBox, p.meds), undefined);
  const verdict = checkLabel(otherBox, p, NOW);
  assert.equal(verdict.level, "warning");
  assert.equal(verdict.matchedMedId, undefined);
  assert.ok(verdict.reasons.includes("not on your medication list"));
});

test("Finnish and Swedish pharmacy brands and penisilliini class resolution", () => {
  const brandPairs: [string, string][] = [
    ["Burana", "ibuprofen"], ["Ibumax", "ibuprofen"], ["Panadol", "paracetamol"], ["Pamol", "paracetamol"],
    ["Paratabs", "paracetamol"], ["Primaspan", "aspirin"], ["Disperin", "aspirin"], ["Marevan", "warfarin"],
    ["Zopinox", "zopiclone"], ["Imovane", "zopiclone"], ["Thyroxin", "levothyroxine"], ["Cardace", "ramipril"], ["Emconcor", "bisoprolol"],
  ];
  for (const [brand, inn] of brandPairs) assert.ok(ingredientsOf(brand).has(inn), `${brand} -> ${inn}`);

  const p = makeProfile({
    meds: [
      { id: "w", name: "", ingredient: "warfarin", strength: "3 mg", schedule: ["evening"] },
      { id: "z", name: "", ingredient: "zopiclone", strength: "7.5 mg", schedule: ["bedtime"] },
      { id: "b", name: "", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["morning"] },
    ],
    avoid: ["NSAIDs"],
  });
  assert.equal(checkLabel(makeRead({ product: f("Marevan 3 mg"), strength: f("3 mg") }), p, NOW).level, "match");
  assert.equal(checkLabel(makeRead({ product: f("Zopinox 7,5 mg"), strength: f("7,5 mg") }), p, NOW).level, "match");
  assert.equal(checkLabel(makeRead({ product: f("Emconcor 2,5 mg"), strength: f("2,5 mg") }), p, NOW).level, "match");
  for (const nsaidBrand of ["Burana", "Ibumax", "Primaspan", "Disperin"]) {
    assert.equal(checkLabel(makeRead({ product: f(`${nsaidBrand} 100 mg`), strength: f("100 mg") }), p, NOW).level, "warning");
  }
  for (const betaLactam of ["amoxicillin", "pivmecillinam"]) {
    const r = makeRead({ ingredient: f(betaLactam), strength: f("500 mg") });
    assert.equal(allergenHits(r, ["penisilliini"])[0]?.found, betaLactam);
    assert.equal(checkLabel(r, makeProfile({ allergies: ["penisilliini"] }), NOW).level, "warning");
  }
});

test("Nordic food and medication excipient allergens, may-contain phrasing, and expired food", () => {
  const foodCases: [string, string][] = [
    ["peanut", "maapahkina"], ["peanut", "jordnot"], ["tree nut", "hasselpahkina"], ["tree nut", "mandel"],
    ["milk", "maito"], ["milk", "laktoosi"], ["milk", "mjolk"], ["gluten", "vehna"], ["gluten", "gluteeni"], ["gluten", "vete"],
  ];
  for (const [allergy, labelTerm] of foodCases) {
    const r = makeRead({ kind: "food", product: f("Valipala"), allergens: f([labelTerm]) });
    assert.equal(allergenHits(r, [allergy])[0]?.mayContain, false);
    assert.equal(checkLabel(r, makeProfile({ allergies: [allergy] }), NOW).level, "warning");
  }
  for (const traceText of ["voi sisaltaa: manteli", "kan innehalla hasselnot"]) {
    const r = makeRead({ kind: "food", product: f("Mysli"), allergens: f([traceText]) });
    assert.equal(allergenHits(r, ["tree nuts"])[0]?.mayContain, true);
    const v = checkLabel(r, makeProfile({ allergies: ["tree nuts"] }), NOW);
    assert.equal(v.level, "warning");
    assert.match(v.headline, /may contain/i);
  }
  const medLactose = makeRead({ kind: "medication", ingredient: f("amlodipine"), strength: f("5 mg"), allergens: f(["laktoosi"], 0.2) });
  const medVerdict = checkLabel(medLactose, makeProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["lactose"],
  }), NOW);
  assert.equal(medVerdict.level, "warning");
  assert.match(medVerdict.speech, /laktoosi/i);

  const expiredFood = checkLabel(makeRead({ kind: "food", product: f("Kaurajuoma"), allergens: f(["kaura"]), expiry: f("2026-10-01", 0.9) }), makeProfile({ allergies: ["peanut"] }), NOW);
  assert.equal(expiredFood.level, "warning");
  assert.match(expiredFood.headline, /past its date/i);
});

test("toLabelRead and toProfile boundary coercion", () => {
  assert.equal(toLabelRead(null).kind, "unreadable");
  const coerced = toLabelRead({
    kind: "medication", product: { value: null, confidence: 0.95 }, ingredient: { value: "amlodipine", confidence: Number.NaN },
    strength: { value: "5 mg", confidence: Number.POSITIVE_INFINITY }, dosing: { value: "1 daily", confidence: -0.5 },
    expiry: { value: "11/2027", confidence: 0.95 }, allergens: { value: ["laktoosi", 42], confidence: 0.9 }, readability: Number.POSITIVE_INFINITY,
  });
  assert.equal(coerced.product.value, null);
  assert.ok(coerced.product.confidence <= 0.3);
  assert.equal(coerced.ingredient.confidence, 0);
  assert.equal(coerced.strength.confidence, 0);
  assert.equal(coerced.dosing.confidence, 0);
  assert.equal(coerced.readability, 0);
  assert.equal(coerced.expiry.value, "11/2027");
  assert.ok(coerced.expiry.confidence <= 0.5);
  assert.equal(coerced.allergens.value, null);

  const meds = Array.from({ length: 60 }, (_, i) => ({ name: `Med${i}`, ingredient: "amlodipine", strength: "5 mg", schedule: ["morning"] }));
  const doseLog = [{ medId: "bad", ts: "not-a-number" }, ...Array.from({ length: 520 }, (_, i) => ({ medId: `m${i}`, ts: 1000 + i }))];
  const prof = toProfile({ meds, doseLog, allergies: ["", "peanut"], avoid: [null, "NSAIDs"], lang: "" });
  assert.equal(prof.meds.length, 50);
  assert.equal(prof.meds[0].id, "med0");
  assert.equal(prof.doseLog.length, 500);
  assert.equal(prof.doseLog[0].medId, "m20");
  assert.equal(prof.doseLog[499].medId, "m519");
  assert.deepEqual(prof.allergies, ["peanut"]);
  assert.deepEqual(prof.avoid, ["NSAIDs"]);
  assert.equal(prof.lang, "en");
});
