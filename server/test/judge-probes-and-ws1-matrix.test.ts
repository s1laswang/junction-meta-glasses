import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, Gs1Code, LabelRead, Med, Profile, Verdict } from "../../shared/types.ts";
import { REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { gtin14, parseGs1 } from "../src/gs1.ts";
import {
  allergenHits,
  allergyLabel,
  allergyParts,
  applyQuestion,
  checkLabel,
  checkLabelText,
  isPerVolume,
  lastDoseWithin,
  productIngredientClash,
  sameStrength,
  unmappedAllergies,
} from "../src/safety.ts";

const NOW = new Date(2026, 10, 15, 20, 0, 0, 0);
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

const f = <T>(value: T | null, confidence = 0.95): Field<T> => ({ value, confidence });
const N_STR: Field<string> = { value: null, confidence: 0 };
const N_ARR: Field<string[]> = { value: null, confidence: 0 };

const BASE_AML: Med = {
  id: "aml",
  name: "Amlodipin Orion",
  ingredient: "amlodipine besilate",
  strength: "5 mg",
  schedule: ["evening"],
  gtin: "06414100000001",
};

function mkMedRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: f("Amlodipin Orion"),
    ingredient: f("amlodipine"),
    strength: f("5 mg"),
    dosing: N_STR,
    expiry: f("2027-03"),
    allergens: N_ARR,
    barcode: N_STR,
    readability: 0.92,
    ...overrides,
  };
}

function mkFoodRead(allergens: string[] | null, overrides: Partial<LabelRead> = {}, conf = 0.98): LabelRead {
  return {
    kind: "food",
    product: f("Nordic Oat Snack"),
    ingredient: N_STR,
    strength: N_STR,
    dosing: N_STR,
    expiry: f("2027-06"),
    allergens: allergens === null ? N_ARR : f(allergens, conf),
    barcode: N_STR,
    readability: 0.95,
    ...overrides,
  };
}

function mkProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    meds: [BASE_AML],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...overrides,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

let auditedVerdictCount = 0;

function auditVerdict(verdict: Verdict, tag: string): Verdict {
  auditedVerdictCount += 1;
  const words = countWords(verdict.headline);
  const sentences = countSentences(verdict.speech);
  assert.ok(words >= 1 && words <= 8, `${tag}: expected 1..8 headline words, got ${words} in "${verdict.headline}"`);
  assert.ok(sentences >= 1 && sentences <= 2, `${tag}: expected 1..2 speech sentences, got ${sentences} in "${verdict.speech}"`);
  assert.equal(/may contain\s+may contain/i.test(verdict.headline), false, `${tag}: duplicate may contain in headline "${verdict.headline}"`);
  assert.equal(/may contain\s+may contain/i.test(verdict.speech), false, `${tag}: duplicate may contain in speech "${verdict.speech}"`);
  return verdict;
}

function runCheck(
  tag: string,
  read: LabelRead,
  profile: Profile,
  now: Date = NOW,
  code?: Gs1Code,
  question?: string,
): Verdict {
  return auditVerdict(checkLabel(read, profile, now, code, question), tag);
}

function runCheckText(tag: string, read: LabelRead, profile: Profile, now: Date = NOW): Verdict {
  return auditVerdict(checkLabelText(read, profile, now), tag);
}

function runApplyQuestion(tag: string, verdict: Verdict, profile: Profile, question?: string): Verdict {
  return auditVerdict(applyQuestion(verdict, profile, question), tag);
}

test("probe 7a: productIngredientClash catches brand-vs-INN and INN-vs-INN conflicts as unsure, never match", () => {
  const clashCases: Array<{
    label: string;
    product: string;
    ingredient: string;
    expectedProduct: string;
    expectedIngredient: string;
    meds?: Med[];
  }> = [
    {
      label: "Bisoprolol box with amlodipine ingredient",
      product: "Bisoprolol Orion 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "bisoprolol",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Burana brand box with amlodipine ingredient",
      product: "Burana 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "ibuprofen",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Marevan brand box with amlodipine ingredient",
      product: "Marevan 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "warfarin",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Metformin generic box with amlodipine ingredient",
      product: "Metformin Teva 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "metformin",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Cardace brand box with amlodipine ingredient",
      product: "Cardace 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "ramipril",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Norvasc brand box with bisoprolol ingredient",
      product: "Norvasc 5 mg",
      ingredient: "bisoprolol fumarate",
      expectedProduct: "amlodipine",
      expectedIngredient: "bisoprolol",
      meds: [{ id: "biso", name: "Emconcor", ingredient: "bisoprolol", strength: "5 mg", schedule: ["morning"] }],
    },
    {
      label: "INN-suffix candesartan box with amlodipine ingredient",
      product: "Candesartan Krka 5 mg",
      ingredient: "amlodipine",
      expectedProduct: "candesartan",
      expectedIngredient: "amlodipine",
    },
    {
      label: "Profile-derived drug token digoxin clashing with levothyroxine",
      product: "Digoxin Orion 0.25 mg",
      ingredient: "levothyroxine",
      expectedProduct: "digoxin",
      expectedIngredient: "levothyroxine",
      meds: [
        { id: "dig", name: "Digoxin Orion", ingredient: "digoxin", strength: "0.25 mg", schedule: ["morning"] },
        { id: "levo", name: "Thyroxin", ingredient: "levothyroxine", strength: "0.25 mg", schedule: ["morning"] },
      ],
    },
  ];

  for (const c of clashCases) {
    const profile = mkProfile(c.meds ? { meds: c.meds } : {});
    const strength = c.meds?.[0]?.strength ?? "5 mg";
    const read = mkMedRead({ product: f(c.product, 0.92), ingredient: f(c.ingredient, 0.91), strength: f(strength, 0.95) });
    const clash = productIngredientClash(read, profile);
    assert.deepEqual(clash, { product: c.expectedProduct, ingredient: c.expectedIngredient }, c.label);
    const verdict = runCheck(`clash:${c.label}`, read, profile);
    assert.equal(verdict.level, "unsure", c.label);
    assert.notEqual(verdict.level, "match", c.label);
    assert.equal(verdict.headline, "Name and ingredient disagree", c.label);
    assert.ok(verdict.reasons.some((r) => r.includes(`product names ${c.expectedProduct}`)), c.label);
  }
});

test("probe 7b: legitimate single and combination brand+INN pairs have no clash and match saved meds", () => {
  const validBrandInnPairs: Array<{
    brand: string;
    ingredient: string;
    strength: string;
  }> = [
    { brand: "Norvasc 5 mg", ingredient: "amlodipine", strength: "5 mg" },
    { brand: "Norvasc", ingredient: "amlodipine besilate", strength: "5 mg" },
    { brand: "Burana 400 mg", ingredient: "ibuprofen", strength: "400 mg" },
    { brand: "Marevan 3 mg", ingredient: "warfarin", strength: "3 mg" },
    { brand: "Marevan 3 mg", ingredient: "warfarin sodium", strength: "3 mg" },
    { brand: "Panacod 500 mg/30 mg", ingredient: "paracetamol, codeine", strength: "500 mg/30 mg" },
    { brand: "Exforge 5 mg/80 mg", ingredient: "amlodipine, valsartan", strength: "5 mg/80 mg" },
  ];

  for (const pair of validBrandInnPairs) {
    const profile = mkProfile({
      meds: [{ id: "m1", name: pair.brand, ingredient: pair.ingredient, strength: pair.strength, schedule: ["evening"] }],
    });
    const read = mkMedRead({
      product: f(pair.brand, 0.96),
      ingredient: f(pair.ingredient, 0.96),
      strength: f(pair.strength, 0.96),
    });
    assert.equal(productIngredientClash(read, profile), undefined, `expected no clash for ${pair.brand}`);
    const verdict = runCheck(`valid-pair:${pair.brand}:${pair.ingredient}`, read, profile);
    assert.equal(verdict.level, "match", `expected match for ${pair.brand}`);
    assert.equal(verdict.matchedMedId, "m1");
  }

  const lev1Typo = mkMedRead({ product: f("Amlodipime 5 mg", 0.95), ingredient: f("amlodipine", 0.95) });
  assert.equal(productIngredientClash(lev1Typo, mkProfile()), undefined);
  assert.equal(runCheck("lev1-product-typo", lev1Typo, mkProfile()).level, "match");

  const exforgeVsMono = runCheck(
    "exforge-vs-amlodipine-mono",
    mkMedRead({ product: f("Exforge 5 mg/80 mg"), ingredient: f("amlodipine, valsartan"), strength: f("5 mg/80 mg") }),
    mkProfile(),
  );
  assert.equal(exforgeVsMono.level, "warning");
  assert.equal(exforgeVsMono.matchedMedId, undefined);
});

test("probe 7c: productIngredientClash enforces the < 0.6 vs >= 0.6 confidence threshold and ignores non-drug pack words", () => {
  const prof = mkProfile();

  const belowProd = mkMedRead({ product: f("Bisoprolol Orion 5 mg", 0.59), ingredient: f("amlodipine", 0.95) });
  assert.equal(productIngredientClash(belowProd, prof), undefined);
  assert.equal(runCheck("clash-conf-prod-0.59", belowProd, prof).level, "match");

  const belowIng = mkMedRead({ product: f("Bisoprolol Orion 5 mg", 0.95), ingredient: f("amlodipine", 0.59) });
  assert.equal(productIngredientClash(belowIng, prof), undefined);

  const belowBoth = mkMedRead({ product: f("Bisoprolol Orion 5 mg", 0.59), ingredient: f("amlodipine", 0.59) });
  assert.equal(productIngredientClash(belowBoth, prof), undefined);
  assert.equal(runCheck("clash-conf-both-0.59", belowBoth, prof).level, "unsure");

  for (const [pConf, iConf] of [
    [0.6, 0.6],
    [0.6, 0.95],
    [0.95, 0.6],
  ] as const) {
    const atGate = mkMedRead({ product: f("Bisoprolol Orion 5 mg", pConf), ingredient: f("amlodipine", iConf) });
    assert.deepEqual(productIngredientClash(atGate, prof), { product: "bisoprolol", ingredient: "amlodipine" });
    const verdict = runCheck(`clash-conf-${pConf}-${iConf}`, atGate, prof);
    assert.equal(verdict.level, "unsure");
    assert.equal(verdict.headline, "Name and ingredient disagree");
  }

  const nonDrugPackWords = mkMedRead({ product: f("Orion tabletti 5 mg", 0.95), ingredient: f("amlodipine", 0.95) });
  assert.equal(productIngredientClash(nonDrugPackWords, prof), undefined);
  assert.equal(runCheck("non-drug-pack-words", nonDrugPackWords, prof).level, "match");

  assert.equal(productIngredientClash(mkMedRead({ product: N_STR, ingredient: f("amlodipine", 0.95) }), prof), undefined);
  assert.equal(productIngredientClash(mkMedRead({ product: f("Bisoprolol 5 mg", 0.95), ingredient: N_STR }), prof), undefined);
});

test("probe 8a: saved med GTIN or barcode vs different scanned GTIN yields unsure ('not your saved pack')", () => {
  const wrongPack = runCheck("gtin-mismatch-bare", mkMedRead(), mkProfile(), NOW, {
    raw: "(01)06414100099999",
    gtin: "06414100099999",
  });
  assert.equal(wrongPack.level, "unsure");
  assert.equal(wrongPack.headline, "Amlodipine: not your saved pack");
  assert.equal(wrongPack.matchedMedId, "aml");
  assert.equal(wrongPack.crossCheck?.source, "datamatrix");
  assert.equal(wrongPack.crossCheck?.agrees, null);
  assert.ok(wrongPack.reasons.some((r) => r.includes("is not your saved Amlodipin Orion pack")));
  assert.doesNotMatch(wrongPack.speech, /double-checked/i);

  const wrongPackSameExpiry = runCheck("gtin-mismatch-matching-expiry", mkMedRead({ expiry: f("2027-03") }), mkProfile(), NOW, {
    raw: "(01)06414100099999(17)270300",
    gtin: "06414100099999",
    expiry: "2027-03",
  });
  assert.equal(wrongPackSameExpiry.level, "unsure");
  assert.equal(wrongPackSameExpiry.headline, "Amlodipine: not your saved pack");
  assert.doesNotMatch(wrongPackSameExpiry.speech, /double-checked/i);

  const barcodeSavedMed: Med = {
    id: "aml-bc",
    name: "Amlodipin Orion",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
    barcode: "6414100000001",
  };
  const barcodeMismatch = runCheck(
    "barcode-ean13-vs-wrong-gtin14",
    mkMedRead(),
    mkProfile({ meds: [barcodeSavedMed] }),
    NOW,
    { raw: "(01)06414100088888", gtin: "06414100088888" },
  );
  assert.equal(barcodeMismatch.level, "unsure");
  assert.match(barcodeMismatch.headline, /not your saved pack/);

  const twoMedsProfile = mkProfile({
    meds: [
      BASE_AML,
      { id: "biso", name: "Bisoprolol Orion", ingredient: "bisoprolol", strength: "5 mg", schedule: ["morning"], gtin: "06414100022222" },
    ],
  });
  const otherSavedMedGtin = runCheck("gtin-belongs-to-other-med", mkMedRead(), twoMedsProfile, NOW, {
    raw: "(01)06414100022222",
    gtin: "06414100022222",
  });
  assert.equal(otherSavedMedGtin.level, "unsure");
  assert.equal(otherSavedMedGtin.crossCheck?.agrees, false);
  assert.equal(otherSavedMedGtin.headline, "Label and pack code disagree");
});

test("probe 8b: EAN-13 and GTIN-14 leading-zero normalization (gtin14) yields match with double-checked confirmation", () => {
  assert.equal(gtin14("6414100000001"), "06414100000001");
  assert.equal(gtin14("06414100000001"), "06414100000001");
  assert.equal(gtin14("6414 1000 00001"), "06414100000001");
  assert.equal(gtin14("64141009"), "00000064141009");
  assert.equal(gtin14("00000000000000"), undefined);
  assert.equal(gtin14("1234567"), undefined);

  const ean13SavedMed: Med = {
    id: "aml-ean",
    name: "Amlodipin Orion",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
    gtin: "6414100000001",
  };
  const eanVsGtin14 = runCheck(
    "ean13-saved-vs-gtin14-code",
    mkMedRead({ expiry: f("2027-03") }),
    mkProfile({ meds: [ean13SavedMed] }),
    NOW,
    parseGs1("(01)06414100000001(17)270300"),
  );
  assert.equal(eanVsGtin14.level, "match");
  assert.equal(eanVsGtin14.crossCheck?.agrees, true);
  assert.match(eanVsGtin14.speech, /double-checked with the pack's code/i);

  const gtin14VsEan13 = runCheck(
    "gtin14-saved-vs-ean13-code",
    mkMedRead({ expiry: f("2027-03") }),
    mkProfile(),
    NOW,
    { raw: "6414100000001", gtin: "6414100000001" },
  );
  assert.equal(gtin14VsEan13.level, "match");
  assert.equal(gtin14VsEan13.crossCheck?.agrees, true);
  assert.match(gtin14VsEan13.speech, /double-checked with the pack's code/i);

  const barcodeSavedMed: Med = {
    id: "aml-bc",
    name: "Amlodipin Orion",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
    barcode: "6414100000001",
  };
  const barcodeMatch = runCheck(
    "barcode-ean13-vs-gtin14-code",
    mkMedRead(),
    mkProfile({ meds: [barcodeSavedMed] }),
    NOW,
    { raw: "(01)06414100000001", gtin: "06414100000001" },
  );
  assert.equal(barcodeMatch.level, "match");
  assert.equal(barcodeMatch.crossCheck?.agrees, true);
  assert.match(barcodeMatch.speech, /double-checked with the pack's code/i);
});

test("probe 9a: isPerVolume detects liquid concentrations and warns ('different form') against solid tablets in both directions", () => {
  for (const liquid of [
    "5 mg/5 ml",
    "10 mg/ml",
    "5 mg/ml",
    "5 mg per 5 ml",
    "per 5 ml",
    "5 mg / milliliter",
    "5 mg / millilitre",
    "2,5 mg/ml",
    "5 mg/ml (5 mg millilitrassa)",
  ]) {
    assert.equal(isPerVolume(liquid), true, `expected isPerVolume true for "${liquid}"`);
  }

  for (const nonLiquid of ["5 mg", "500 mg", "5 mg/80 mg", "10 mg/g", "25 mcg/h", "", null, undefined]) {
    assert.equal(isPerVolume(nonLiquid), false, `expected isPerVolume false for "${String(nonLiquid)}"`);
  }

  for (const liquidStrength of [
    "5 mg/5 ml",
    "10 mg/ml",
    "5 mg/ml",
    "5 mg per 5 ml",
    "5 mg / milliliter",
    "5 mg/ml (5 mg millilitrassa)",
  ]) {
    const verdict = runCheck(
      `liquid-vs-solid:${liquidStrength}`,
      mkMedRead({ product: f("Amlodipine oral solution"), strength: f(liquidStrength) }),
      mkProfile(),
    );
    assert.equal(verdict.level, "warning", liquidStrength);
    assert.equal(verdict.headline, "Amlodipine: different form", liquidStrength);
    assert.ok(verdict.reasons.some((r) => r.includes("form differs")), liquidStrength);
  }

  const solidAgainstSavedLiquid = runCheck(
    "solid-vs-saved-liquid",
    mkMedRead({ strength: f("5 mg") }),
    mkProfile({
      meds: [{ id: "liq", name: "Amlodipine Oral", ingredient: "amlodipine", strength: "5 mg/5 ml", schedule: ["evening"] }],
    }),
  );
  assert.equal(solidAgainstSavedLiquid.level, "warning");
  assert.equal(solidAgainstSavedLiquid.headline, "Amlodipine: different form");

  const fiMillilitrassaDiff = runCheck(
    "millilitrassa-1mg-vs-5mg-tablet",
    mkMedRead({ product: f("Amlodipiini oraaliliuos"), strength: f("1 mg millilitrassa") }),
    mkProfile(),
  );
  assert.equal(fiMillilitrassaDiff.level, "warning");
});

test("probe 9b: liquid-to-liquid matching concentration ratios yield match while wrong liquid ratios yield warning", () => {
  const liquidMedProfile = (strength: string) =>
    mkProfile({
      meds: [{ id: "liq", name: "Amlodipine Oral", ingredient: "amlodipine", strength, schedule: ["evening"] }],
    });

  assert.equal(sameStrength("5 mg / millilitrassa", "25 mg/5 ml"), true);
  assert.equal(sameStrength("5 mg / millilitrassa", "10 mg/5 ml"), false);

  const matchingLiquidPairs: Array<[string, string]> = [
    ["5 mg/5 ml", "1 mg/ml"],
    ["5 mg/ml", "25 mg/5 ml"],
    ["10 mg/ml", "20 mg per 2 ml"],
    ["2.5 mg/ml", "2,5 mg / millilitre"],
  ];
  for (const [savedStrength, readStrength] of matchingLiquidPairs) {
    const verdict = runCheck(
      `liquid-match:${savedStrength}==${readStrength}`,
      mkMedRead({ product: f("Amlodipine Oral"), strength: f(readStrength) }),
      liquidMedProfile(savedStrength),
    );
    assert.equal(verdict.level, "match", `${savedStrength} vs ${readStrength}`);
  }

  const wrongLiquidPairs: Array<[string, string]> = [
    ["5 mg/5 ml", "5 mg/ml"],
    ["10 mg/ml", "10 mg/5 ml"],
    ["5 mg/ml", "2 mg/ml"],
  ];
  for (const [savedStrength, readStrength] of wrongLiquidPairs) {
    const verdict = runCheck(
      `liquid-wrong-ratio:${savedStrength}!=${readStrength}`,
      mkMedRead({ product: f("Amlodipine Oral"), strength: f(readStrength) }),
      liquidMedProfile(savedStrength),
    );
    assert.equal(verdict.level, "warning", `${savedStrength} vs ${readStrength}`);
    assert.match(verdict.headline, /wrong strength/, `${savedStrength} vs ${readStrength}`);
  }
});

test("probes 11 & 13a: lastDoseWithin enforces exact windowMs boundary, selects latest past dose, and ignores future timestamps", () => {
  const refNow = new Date(2026, 10, 15, 12, 0, 0, 0);
  const t = refNow.getTime();
  const sixHours = 6 * HOUR_MS;

  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "aml", ts: t - sixHours + 1 }] }), "aml", refNow, sixHours), t - sixHours + 1);
  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "aml", ts: t - sixHours }] }), "aml", refNow, sixHours), undefined);
  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "aml", ts: t }] }), "aml", refNow, sixHours), t);
  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "aml", ts: t + 1 }] }), "aml", refNow, sixHours), undefined);
  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "aml", ts: t + HOUR_MS }] }), "aml", refNow, sixHours), undefined);
  assert.equal(lastDoseWithin(mkProfile({ doseLog: [{ medId: "other", ts: t - MIN_MS }] }), "aml", refNow, sixHours), undefined);
  assert.equal(
    lastDoseWithin(
      mkProfile({
        doseLog: [
          { medId: "aml", ts: t - 3 * HOUR_MS },
          { medId: "aml", ts: t - 30 * MIN_MS },
          { medId: "aml", ts: t + 15 * MIN_MS },
        ],
      }),
      "aml",
      refNow,
      sixHours,
    ),
    t - 30 * MIN_MS,
  );
});

test("probes 11 & 13b: checkLabel rolling dose window enforces 12h (1x/day), 6h (2x/day), 4h (3x/day) and ignores ts > now", () => {
  const doseNov14Late = new Date(2026, 10, 14, 23, 50, 0, 0).getTime();
  const onceDailyProf = mkProfile({ doseLog: [{ medId: "aml", ts: doseNov14Late }] });
  const afterMidnight20m = runCheck("1x-midnight-20m", mkMedRead(), onceDailyProf, new Date(2026, 10, 15, 0, 10, 0, 0));
  assert.equal(afterMidnight20m.level, "warning");
  assert.equal(afterMidnight20m.takenToday, true);
  assert.match(afterMidnight20m.headline, /taken at 23:50/);

  const onceAt11h59m = runCheck("1x-11h59m", mkMedRead(), onceDailyProf, new Date(doseNov14Late + 12 * HOUR_MS - MIN_MS));
  assert.equal(onceAt11h59m.level, "warning");

  const onceAt12h01m = runCheck("1x-12h01m", mkMedRead(), onceDailyProf, new Date(doseNov14Late + 12 * HOUR_MS + MIN_MS));
  assert.equal(onceAt12h01m.level, "match");
  assert.equal(onceAt12h01m.takenToday, false);

  const bidMed: Med = { ...BASE_AML, schedule: ["morning", "evening"] };
  const bidMorningTs = new Date(2026, 10, 15, 7, 0, 0, 0).getTime();
  const bidProf = mkProfile({ meds: [bidMed], doseLog: [{ medId: "aml", ts: bidMorningTs }] });

  const bid5h59m = runCheck("2x-5h59m-warns", mkMedRead(), bidProf, new Date(bidMorningTs + 6 * HOUR_MS - MIN_MS));
  assert.equal(bid5h59m.level, "warning");
  assert.equal(bid5h59m.takenToday, true);
  assert.match(bid5h59m.headline, /taken at 07:00/);

  const bid6h01m = runCheck("2x-6h01m-matches", mkMedRead(), bidProf, new Date(bidMorningTs + 6 * HOUR_MS + MIN_MS));
  assert.equal(bid6h01m.level, "match");
  assert.equal(bid6h01m.takenToday, true);
  assert.match(bid6h01m.speech, /1 of 2 doses today/);

  const bidLateTs = new Date(2026, 10, 14, 23, 30, 0, 0).getTime();
  const bidMidnightProf = mkProfile({ meds: [bidMed], doseLog: [{ medId: "aml", ts: bidLateTs }] });
  assert.equal(runCheck("2x-midnight-5h59m", mkMedRead(), bidMidnightProf, new Date(bidLateTs + 6 * HOUR_MS - MIN_MS)).level, "warning");
  assert.equal(runCheck("2x-midnight-6h01m", mkMedRead(), bidMidnightProf, new Date(bidLateTs + 6 * HOUR_MS + MIN_MS)).level, "match");

  const tidMed: Med = { ...BASE_AML, schedule: ["morning", "midday", "evening"] };
  const tidDose1 = new Date(2026, 10, 15, 8, 0, 0, 0).getTime();
  const tidProf1 = mkProfile({ meds: [tidMed], doseLog: [{ medId: "aml", ts: tidDose1 }] });

  const tid3h59m = runCheck("3x-3h59m-warns", mkMedRead(), tidProf1, new Date(tidDose1 + 4 * HOUR_MS - MIN_MS));
  assert.equal(tid3h59m.level, "warning");
  assert.match(tid3h59m.headline, /taken at 08:00/);

  const tid4h01m = runCheck("3x-4h01m-matches", mkMedRead(), tidProf1, new Date(tidDose1 + 4 * HOUR_MS + MIN_MS));
  assert.equal(tid4h01m.level, "match");
  assert.match(tid4h01m.speech, /1 of 3 doses today/);

  const tidAllThree = mkProfile({
    meds: [tidMed],
    doseLog: [
      { medId: "aml", ts: new Date(2026, 10, 15, 8, 0).getTime() },
      { medId: "aml", ts: new Date(2026, 10, 15, 13, 0).getTime() },
      { medId: "aml", ts: new Date(2026, 10, 15, 18, 0).getTime() },
    ],
  });
  const tidFourthAttempt = runCheck("3x-all-taken", mkMedRead(), tidAllThree, new Date(2026, 10, 15, 22, 30));
  assert.equal(tidFourthAttempt.level, "warning");
  assert.match(tidFourthAttempt.headline, /already taken today/);

  const futureDoseProf = mkProfile({ doseLog: [{ medId: "aml", ts: NOW.getTime() + 10 * MIN_MS }] });
  const withFutureDose = runCheck("future-ts-ignored", mkMedRead(), futureDoseProf, NOW);
  assert.equal(withFutureDose.level, "match");
  assert.equal(withFutureDose.takenToday, false);
  assert.match(withFutureDose.speech, /haven't taken it today/);
});

test("probe 19a: allergyParts, allergyLabel, and unmappedAllergies normalize free-text entries and preserve Nordic diacritics", () => {
  assert.deepEqual(allergyParts("Allergic to peanuts"), ["peanuts"]);
  assert.deepEqual(allergyParts("Peanut allergy (severe)"), ["peanut"]);
  assert.deepEqual(allergyParts("peanuts and tree nuts"), ["peanuts", "tree nuts"]);
  assert.deepEqual(allergyParts("sesame seeds"), ["sesame"]);
  assert.deepEqual(allergyParts("milk protein"), ["milk"]);
  assert.deepEqual(allergyParts("maapähkinä ja manteli (vakava)"), ["maapahkina", "manteli"]);
  assert.deepEqual(allergyParts("jordnötter och mjölk"), ["jordnotter", "mjolk"]);

  assert.equal(allergyLabel("Allergic to peanuts (severe)"), "peanuts");
  assert.equal(allergyLabel("Peanut allergy (severe)"), "peanut");
  assert.equal(allergyLabel("peanuts, tree nuts"), "peanuts and tree nuts");
  assert.equal(allergyLabel("sesame seeds"), "sesame");
  assert.equal(allergyLabel("milk protein"), "milk");
  assert.equal(allergyLabel("pähkinä"), "pähkinä");
  assert.equal(allergyLabel("mjölk"), "mjölk");

  assert.deepEqual(
    unmappedAllergies([
      "Allergic to peanuts",
      "Peanut allergy (severe)",
      "peanuts and tree nuts",
      "sesame seeds",
      "milk protein",
      "penicillin",
      "NSAIDs",
    ]),
    [],
  );
  assert.deepEqual(unmappedAllergies(["kiwi", "buckwheat", "latex"]), ["kiwi", "buckwheat", "latex"]);
  assert.deepEqual(unmappedAllergies(["peanuts", "kiwi", "peanuts and buckwheat"]), ["kiwi", "peanuts and buckwheat"]);
});

test("probe 21: precautionary nut traces warn for peanut allergy without double 'may contain', whereas 'tree nuts' alone does not trigger peanut fallback", () => {
  for (const precautionary of [
    "may contain traces of nuts",
    "May contain: peanuts",
    "May contain peanuts",
    "Kan innehålla spår av jordnötter",
    "Voi sisältää maapähkinää",
    "Saattaa sisältää pähkinää",
  ]) {
    const foodWarn = runCheck(`may-contain-food:${precautionary}`, mkFoodRead([precautionary]), mkProfile({ allergies: ["peanut"] }));
    assert.equal(foodWarn.level, "warning", precautionary);
    assert.match(foodWarn.speech, /\bmay contain\b/i, precautionary);

    const medWarn = runCheck(
      `may-contain-med:${precautionary}`,
      mkMedRead({ allergens: f([precautionary], 0.95) }),
      mkProfile({ allergies: ["Allergic to peanuts (severe)"] }),
    );
    assert.equal(medWarn.level, "warning", precautionary);
    assert.match(medWarn.speech, /\bmay contain\b/i, precautionary);
  }

  for (const treeNutOnly of [["tree nuts"], ["may contain tree nuts"], ["tree nut"]]) {
    assert.deepEqual(allergenHits(mkFoodRead(treeNutOnly), ["peanut"]), []);
    const peanutSafeOnTreeNuts = runCheck(
      `peanut-vs-${treeNutOnly[0]}`,
      mkFoodRead(treeNutOnly),
      mkProfile({ allergies: ["peanut"] }),
    );
    assert.equal(peanutSafeOnTreeNuts.level, "info", treeNutOnly[0]);
    assert.match(peanutSafeOnTreeNuts.speech, /no peanut listed/i);
  }

  const treeNutAllergyHitsTreeNuts = runCheck(
    "treenut-allergy-vs-treenuts",
    mkFoodRead(["tree nuts"]),
    mkProfile({ allergies: ["tree nuts"] }),
  );
  assert.equal(treeNutAllergyHitsTreeNuts.level, "warning");
});

test("probe 19b: unmapped allergies ('kiwi', 'buckwheat', 'latex') abstain as unsure and never reassure 'none of your allergens'", () => {
  for (const unmapped of ["kiwi", "buckwheat", "latex"]) {
    const singleUnmapped = runCheck(
      `unmapped-single:${unmapped}`,
      mkFoodRead(["milk", "soy"]),
      mkProfile({ allergies: [unmapped] }),
    );
    assert.equal(singleUnmapped.level, "unsure", unmapped);
    assert.equal(singleUnmapped.headline, "Can't check one of your allergies", unmapped);
    assert.doesNotMatch(singleUnmapped.headline, /none of your allergens/i, unmapped);
    assert.doesNotMatch(singleUnmapped.speech, /none of your allergens|no .* listed/i, unmapped);
    assert.ok(singleUnmapped.speech.includes(`"${unmapped}"`), unmapped);

    const mixedUnmapped = runCheck(
      `unmapped-mixed:${unmapped}`,
      mkFoodRead(["milk", "soy"]),
      mkProfile({ allergies: ["Allergic to peanuts", unmapped] }),
    );
    assert.equal(mixedUnmapped.level, "unsure", unmapped);
    assert.equal(mixedUnmapped.headline, "Can't check one of your allergies", unmapped);

    const explicitHit = runCheck(
      `unmapped-explicit-present:${unmapped}`,
      mkFoodRead(["milk", unmapped]),
      mkProfile({ allergies: [unmapped] }),
    );
    assert.equal(explicitHit.level, "warning", unmapped);
  }
});

test("OC-07a: applyQuestion warns across EN/FI/SV slot queries and clock schedules (08:00, 13:00, 19:00, 22:30) when slots differ", () => {
  type Slot = "morning" | "midday" | "evening" | "night";
  const slotQueries: Record<Slot, [string, string, string]> = {
    morning: ["Is this my morning pill?", "Onko tämä aamulääke?", "Är det här min morgonmedicin?"],
    midday: ["Is this my midday pill?", "Onko tämä lounaslääke?", "Är det här min lunchmedicin?"],
    evening: ["Is this my evening pill?", "Onko tämä iltalääke?", "Är det här min kvällsmedicin?"],
    night: ["Is this my night pill?", "Onko tämä yölääke?", "Är det här min nattmedicin?"],
  };

  const clockSchedules: Record<Slot, string> = {
    morning: "08:00",
    midday: "13:00",
    evening: "19:00",
    night: "22:30",
  };

  const wordSchedules: Record<Slot, string> = {
    morning: "aamu",
    midday: "lounas",
    evening: "kväll",
    night: "yö",
  };

  const slots: Slot[] = ["morning", "midday", "evening", "night"];

  for (const medSlot of slots) {
    for (const schedValue of [clockSchedules[medSlot], wordSchedules[medSlot]]) {
      const profile = mkProfile({
        meds: [{ ...BASE_AML, schedule: [schedValue] }],
      });
      for (const asked of slots) {
        for (const query of slotQueries[asked]) {
          const verdict = runCheck(`slot:${schedValue}->${asked}:${query}`, mkMedRead(), profile, NOW, undefined, query);
          if (asked === medSlot) {
            assert.equal(verdict.level, "match", `${schedValue} with "${query}" should match`);
          } else {
            assert.equal(verdict.level, "warning", `${schedValue} with "${query}" should warn`);
            assert.match(verdict.headline, new RegExp(`not your ${asked} pill`), `${schedValue} vs ${asked}`);
            assert.ok(verdict.reasons.includes(`asked about ${asked}, scheduled ${medSlot}`), `${schedValue} vs ${asked}`);
          }
        }
      }
    }
  }
});

test("OC-07b: applyQuestion respects clock boundaries, multi-slot schedules, unscheduled meds, and non-match base verdicts", () => {
  type Slot = "morning" | "midday" | "evening" | "night";
  const enQuery: Record<Slot, string> = {
    morning: "Is this my morning pill?",
    midday: "Is this my midday pill?",
    evening: "Is this my evening pill?",
    night: "Is this my night pill?",
  };
  const fiQuery: Record<Slot, string> = {
    morning: "Onko tämä aamulääke?",
    midday: "Onko tämä lounaslääke?",
    evening: "Onko tämä iltalääke?",
    night: "Onko tämä yölääke?",
  };

  const clockBoundaries: Array<[string, Slot]> = [
    ["00:00", "morning"],
    ["10:59", "morning"],
    ["11:00", "midday"],
    ["14:59", "midday"],
    ["15:00", "evening"],
    ["20:59", "evening"],
    ["21:00", "night"],
    ["23:59", "night"],
  ];
  for (const [clock, expectedSlot] of clockBoundaries) {
    const prof = mkProfile({ meds: [{ ...BASE_AML, schedule: [clock] }] });
    const baseVerdict = runCheckText(`clock-base:${clock}`, mkMedRead(), prof, NOW);
    assert.equal(baseVerdict.level, "match");
    assert.equal(runApplyQuestion(`clock-same:${clock}`, baseVerdict, prof, enQuery[expectedSlot]).level, "match");
    const otherSlot: Slot = expectedSlot === "morning" ? "evening" : "morning";
    const diff = runApplyQuestion(`clock-diff:${clock}`, baseVerdict, prof, fiQuery[otherSlot]);
    assert.equal(diff.level, "warning");
    assert.ok(diff.reasons.includes(`asked about ${otherSlot}, scheduled ${expectedSlot}`));
  }

  const multiSlotProf = mkProfile({ meds: [{ ...BASE_AML, schedule: ["08:00", "19:00"] }] });
  assert.equal(runCheck("multi-slot-aamu", mkMedRead(), multiSlotProf, NOW, undefined, "Onko tämä aamulääke?").level, "match");
  assert.equal(runCheck("multi-slot-kvall", mkMedRead(), multiSlotProf, NOW, undefined, "Är det här min kvällsmedicin?").level, "match");
  const multiMidday = runCheck("multi-slot-lounas", mkMedRead(), multiSlotProf, NOW, undefined, "Onko tämä lounaslääke?");
  assert.equal(multiMidday.level, "warning");
  assert.ok(multiMidday.reasons.includes("asked about midday, scheduled morning and evening"));

  const unscheduledProf = mkProfile({ meds: [{ ...BASE_AML, schedule: [] }] });
  assert.equal(runCheck("unscheduled-slot-query", mkMedRead(), unscheduledProf, NOW, undefined, "Is this my morning pill?").level, "match");
  assert.equal(runCheck("no-slot-query", mkMedRead(), mkProfile(), NOW, undefined, "Is this my pill?").level, "match");

  const unsureBase = runCheckText("unsure-unchanged-base", mkMedRead({ strength: f("5 mg", 0.5) }), mkProfile(), NOW);
  assert.equal(unsureBase.level, "unsure");
  const unsureAfterQuestion = runApplyQuestion("unsure-unchanged-apply", unsureBase, mkProfile(), "Is this my morning pill?");
  assert.equal(unsureAfterQuestion.level, "unsure");
  assert.equal(unsureAfterQuestion.headline, unsureBase.headline);
});

test("judge-probe.ts subprocess exits 0 with clean stderr and all matrix verdicts satisfy <= 8 headline words and <= 2 speech sentences", () => {
  const scriptPath = path.join(SERVER_DIR, "scripts", "judge-probe.ts");
  const importIdx = process.execArgv.indexOf("--import");
  const tsxHook = importIdx >= 0 && process.execArgv[importIdx + 1] ? process.execArgv[importIdx + 1] : "tsx";

  const proc = spawnSync(process.execPath, ["--import", tsxHook, scriptPath], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(proc.status, 0, `judge-probe.ts failed with status ${String(proc.status)}: ${proc.stderr}`);
  assert.equal(proc.stderr, "");

  const lines = proc.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length % 2, 0, `expected paired output lines from judge-probe.ts, got ${lines.length}`);

  const parsed = new Map<string, { level: string; speech: string }>();
  for (let i = 0; i < lines.length; i += 2) {
    const probeTitle = lines[i].trim();
    const verdictLine = lines[i + 1] ?? "";
    const match = /^\s*->\s*(MATCH|WARNING|UNSURE|INFO)\s*\|\s*(.+)$/.exec(verdictLine);
    assert.ok(match, `unexpected verdict line for "${probeTitle}": "${verdictLine}"`);
    const [, level, speech] = match;
    const sentences = countSentences(speech);
    assert.ok(sentences >= 1 && sentences <= 2, `probe "${probeTitle}" exceeded 2 speech sentences (${sentences}): "${speech}"`);
    assert.equal(/may contain\s+may contain/i.test(speech), false, `duplicate may contain in "${probeTitle}": "${speech}"`);
    parsed.set(probeTitle, { level, speech });
  }

  assert.equal(parsed.size, 39);
  assert.equal(parsed.get("1 baseline")?.level, "MATCH");
  assert.equal(parsed.get("7 conflict product=Ibuprofen vs ingredient=amlodipine (no avoid list)")?.level, "UNSURE");
  assert.equal(parsed.get("7b conflict product=Metformin vs ingredient=amlodipine")?.level, "UNSURE");
  assert.equal(parsed.get("7c conflict product=Bisoprolol 5 mg (look-alike box) ingredient amlodipine conf .9")?.level, "UNSURE");
  assert.equal(parsed.get("8 DataMatrix GTIN unknown (≠ saved amlodipine GTIN)")?.level, "UNSURE");
  assert.equal(parsed.get("9 oral solution 5 mg/5 ml vs 5 mg tablet")?.level, "WARNING");
  assert.equal(parsed.get("11 taken 23:50 yesterday, now 00:10")?.level, "WARNING");
  assert.equal(parsed.get("13 BID med, morning dose taken 07:00, asked 'my morning pill' 08:00")?.level, "WARNING");
  assert.equal(parsed.get("21 food 'may contain traces of nuts', allergy peanut")?.level, "WARNING");

  assert.ok(auditedVerdictCount >= 165, `expected >= 165 audited verdicts across matrix tests, got ${auditedVerdictCount}`);
});
