import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { parseGs1 } from "../src/gs1.ts";
import {
  applyQuestion,
  checkLabel,
  isPerVolume,
  lastDoseWithin,
  productIngredientClash,
} from "../src/safety.ts";

const EVENING_NOW = new Date(2026, 10, 15, 20, 0, 0, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function makeRead(partial: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f("5 mg", 0.95),
    dosing: f(null, 0),
    expiry: f("2028-06", 0.95),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...partial,
  };
}

const baseAml: Med = {
  id: "aml",
  name: "Norvasc",
  ingredient: "amlodipine",
  strength: "5 mg",
  schedule: ["evening"],
};

function makeProfile(partial: Partial<Profile> = {}): Profile {
  return {
    meds: [baseAml],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...partial,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertVerdictBounds(headline: string, speech: string) {
  assert.ok(wordCount(headline) <= 8, `Headline exceeded 8 words: ${headline}`);
  assert.ok(sentenceCount(speech) <= 2, `Speech exceeded 2 sentences: ${speech}`);
}

test("productIngredientClash detects INN suffixes across drug classes even when unlisted in profile", () => {
  const profile = makeProfile();
  const suffixPacks: Array<[string, string]> = [
    ["Nebivolol 5 mg", "nebivolol"],
    ["Enalapril 5 mg", "enalapril"],
    ["Losartan 50 mg", "losartan"],
    ["Felodipine 5 mg", "felodipine"],
    ["Pravastatin 20 mg", "pravastatin"],
    ["Flurbiprofen 50 mg", "flurbiprofen"],
    ["Betrixaban 40 mg", "betrixaban"],
    ["Ximelagatran 24 mg", "ximelagatran"],
    ["Omeprazole 20 mg", "omeprazole"],
    ["Furosemide 40 mg", "furosemide"],
    ["Hydrochlorothiazide 25 mg", "hydrochlorothiazide"],
    ["Ciprofloxacin 500 mg", "ciprofloxacin"],
    ["Empagliflozin 10 mg", "empagliflozin"],
    ["Ondansetron 4 mg", "ondansetron"],
  ];

  for (const [productLabel, expectedProductToken] of suffixPacks) {
    const r = makeRead({ product: f(productLabel, 0.92), ingredient: f("amlodipine", 0.94) });
    const clash = productIngredientClash(r, profile);
    assert.deepEqual(clash, { product: expectedProductToken, ingredient: "amlodipine" });

    const verdict = checkLabel(r, profile, EVENING_NOW);
    assert.equal(verdict.level, "unsure");
    assert.equal(verdict.headline, "Name and ingredient disagree");
    assert.equal(verdict.matchedMedId, "aml");
    assert.ok(verdict.reasons.includes(`product names ${expectedProductToken}, ingredient reads amlodipine`));
    assertVerdictBounds(verdict.headline, verdict.speech);
  }

  const customProfile = makeProfile({
    meds: [
      baseAml,
      { id: "dig", name: "Lanoxin", ingredient: "digoxin", strength: "0.25 mg", schedule: ["morning"] },
    ],
  });
  const profileTokenClash = productIngredientClash(
    makeRead({ product: f("Digoxin 5 mg", 0.9), ingredient: f("amlodipine", 0.9) }),
    customProfile,
  );
  assert.deepEqual(profileTokenClash, { product: "digoxin", ingredient: "amlodipine" });
});

test("productIngredientClash and checkLabel flag brand vs ingredient conflicts as unsure", () => {
  const profile = makeProfile();
  const brandConflicts: Array<{ product: string; expectedInn: string; spokenCap: string }> = [
    { product: "Xarelto 5 mg", expectedInn: "rivaroxaban", spokenCap: "Rivaroxaban" },
    { product: "Eliquis 5 mg", expectedInn: "apixaban", spokenCap: "Apixaban" },
    { product: "Pradaxa 110 mg", expectedInn: "dabigatran", spokenCap: "Dabigatran" },
    { product: "Cardace 5 mg", expectedInn: "ramipril", spokenCap: "Ramipril" },
    { product: "Emconcor 5 mg", expectedInn: "bisoprolol", spokenCap: "Bisoprolol" },
    { product: "Lipitor 10 mg", expectedInn: "atorvastatin", spokenCap: "Atorvastatin" },
  ];

  for (const c of brandConflicts) {
    const r = makeRead({ product: f(c.product, 0.95), ingredient: f("amlodipine", 0.95) });
    assert.deepEqual(productIngredientClash(r, profile), {
      product: c.expectedInn,
      ingredient: "amlodipine",
    });

    const v = checkLabel(r, profile, EVENING_NOW);
    assert.equal(v.level, "unsure");
    assert.equal(v.headline, "Name and ingredient disagree");
    assert.equal(
      v.speech,
      `The box name says ${c.spokenCap} but the ingredient reads amlodipine. I can't be sure which medicine this is, so please ask a pharmacist.`,
    );
    assert.equal(v.matchedMedId, "aml");
    assertVerdictBounds(v.headline, v.speech);
  }
});

test("productIngredientClash enforces NAME_MIN_CONF 0.59 vs 0.60 cliff on both fields", () => {
  const profile = makeProfile();

  const prod059 = makeRead({ product: f("Bisoprolol 5 mg", 0.59), ingredient: f("amlodipine", 0.92) });
  assert.equal(productIngredientClash(prod059, profile), undefined);
  assert.equal(checkLabel(prod059, profile, EVENING_NOW).level, "match");

  const prod060 = makeRead({ product: f("Bisoprolol 5 mg", 0.6), ingredient: f("amlodipine", 0.92) });
  assert.deepEqual(productIngredientClash(prod060, profile), {
    product: "bisoprolol",
    ingredient: "amlodipine",
  });
  const vProd060 = checkLabel(prod060, profile, EVENING_NOW);
  assert.equal(vProd060.level, "unsure");
  assert.equal(vProd060.headline, "Name and ingredient disagree");

  const ing059 = makeRead({ product: f("Norvasc 5 mg", 0.92), ingredient: f("bisoprolol", 0.59) });
  assert.equal(productIngredientClash(ing059, profile), undefined);

  const ing060 = makeRead({ product: f("Norvasc 5 mg", 0.92), ingredient: f("bisoprolol", 0.6) });
  assert.deepEqual(productIngredientClash(ing060, profile), {
    product: "amlodipine",
    ingredient: "bisoprolol",
  });
  const vIng060 = checkLabel(ing060, profile, EVENING_NOW);
  assert.equal(vIng060.level, "unsure");
  assert.equal(vIng060.headline, "Name and ingredient disagree");

  assert.equal(productIngredientClash(makeRead({ product: f(null, 0.95), ingredient: f("amlodipine", 0.95) }), profile), undefined);
  assert.equal(productIngredientClash(makeRead({ product: f("Norvasc", 0.95), ingredient: f(null, 0.95) }), profile), undefined);
  assert.equal(
    productIngredientClash(makeRead({ product: f("Orion tabletti 5 mg", 0.95), ingredient: f("amlodipine", 0.95) }), profile),
    undefined,
  );
});

test("productIngredientClash returns undefined on legitimate brand+INN pairs and 1-char OCR typos", () => {
  const ibuMed: Med = { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["morning"] };
  const atoMed: Med = { id: "ato", name: "Lipitor", ingredient: "atorvastatin", strength: "10 mg", schedule: ["evening"] };
  const profile = makeProfile({ meds: [baseAml, ibuMed, atoMed] });

  const validPairs: Array<{ product: string; ingredient: string; strength: string; expectedMedId: string }> = [
    { product: "Norvasc 5 mg", ingredient: "amlodipine", strength: "5 mg", expectedMedId: "aml" },
    { product: "Norvasc 5 mg tabletti", ingredient: "amlodipine besilate", strength: "5 mg", expectedMedId: "aml" },
    { product: "Amlodipin Orion 5 mg", ingredient: "amlodipiini", strength: "5 mg", expectedMedId: "aml" },
    { product: "Burana 400 mg", ingredient: "ibuprofen", strength: "400 mg", expectedMedId: "ibu" },
    { product: "Burana 400 mg kapseli", ingredient: "ibuprofeeni", strength: "400 mg", expectedMedId: "ibu" },
    { product: "Amlodipime 5 mg", ingredient: "amlodipine", strength: "5 mg", expectedMedId: "aml" },
    { product: "Amlodipine 5 mg", ingredient: "amlodipime", strength: "5 mg", expectedMedId: "aml" },
    { product: "Atorvastatln 10 mg", ingredient: "atorvastatin", strength: "10 mg", expectedMedId: "ato" },
  ];

  for (const pair of validPairs) {
    const r = makeRead({
      product: f(pair.product, 0.95),
      ingredient: f(pair.ingredient, 0.95),
      strength: f(pair.strength, 0.95),
    });
    assert.equal(productIngredientClash(r, profile), undefined, `${pair.product} + ${pair.ingredient}`);
    const v = checkLabel(r, profile, EVENING_NOW);
    assert.equal(v.level, "match", `${pair.product} + ${pair.ingredient}`);
    assert.equal(v.matchedMedId, pair.expectedMedId);
  }
});

test("isPerVolume and checkLabel form-mismatch guard separate liquid strengths from solid oral strengths", () => {
  const liquids = [
    "5 mg/5 ml",
    "10 mg/ml",
    "2 mg per 5 ml",
    "100 mg / 1,5 ml",
    "1 mg per ml",
    "20 mg / 2.5 millilitre",
    "5 mg/milliliter",
  ];
  for (const s of liquids) {
    assert.equal(isPerVolume(s), true, `Expected liquid per-volume true for ${s}`);
  }

  const solids = ["5 mg", "500 mg", "50 mcg", "80/12.5 mg", "2,5 mg", "", null, undefined];
  for (const s of solids) {
    assert.equal(isPerVolume(s), false, `Expected solid per-volume false for ${String(s)}`);
  }

  const tabletProfile = makeProfile();
  for (const liq of ["5 mg/5 ml", "10 mg/ml", "2 mg per 5 ml", "100 mg / 1,5 ml"]) {
    const v = checkLabel(
      makeRead({ product: f("Amlodipine oral solution"), ingredient: f("amlodipine"), strength: f(liq, 0.95) }),
      tabletProfile,
      EVENING_NOW,
    );
    assert.equal(v.level, "warning", liq);
    assert.equal(v.headline, "Amlodipine: different form");
    assert.match(v.speech, /your list has 5 mg, a different form/);
    assert.equal(v.matchedMedId, "aml");
    assert.ok(v.reasons.includes(`form differs: label ${liq}, your list 5 mg`));
    assertVerdictBounds(v.headline, v.speech);
  }

  const liquidProfile = makeProfile({
    meds: [{ id: "aml-sol", name: "Amlodipine Solution", ingredient: "amlodipine", strength: "5 mg/5 ml", schedule: ["evening"] }],
  });
  const solidAgainstLiquid = checkLabel(
    makeRead({ product: f("Amlodipine 5 mg tablets"), ingredient: f("amlodipine"), strength: f("5 mg", 0.95) }),
    liquidProfile,
    EVENING_NOW,
  );
  assert.equal(solidAgainstLiquid.level, "warning");
  assert.equal(solidAgainstLiquid.headline, "Amlodipine: different form");
  assert.ok(solidAgainstLiquid.reasons.includes("form differs: label 5 mg, your list 5 mg/5 ml"));
  assertVerdictBounds(solidAgainstLiquid.headline, solidAgainstLiquid.speech);

  const equivalentLiquid = checkLabel(
    makeRead({ product: f("Amlodipine Solution"), ingredient: f("amlodipine"), strength: f("1 mg/ml", 0.95) }),
    liquidProfile,
    EVENING_NOW,
  );
  assert.equal(equivalentLiquid.level, "match");
  assert.equal(equivalentLiquid.matchedMedId, "aml-sol");
});

test("lastDoseWithin rolling half-interval window handles once-daily cross-midnight cliffs", () => {
  const dose2350 = new Date(2026, 10, 14, 23, 50, 0, 0).getTime();
  const profile = makeProfile({ doseLog: [{ medId: "aml", ts: dose2350 }] });
  const amlRead = makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg") });
  const twelveHoursMs = 12 * 3600_000;

  const at0010 = new Date(2026, 10, 15, 0, 10, 0, 0);
  assert.equal(lastDoseWithin(profile, "aml", at0010, twelveHoursMs), dose2350);
  const v0010 = checkLabel(amlRead, profile, at0010);
  assert.equal(v0010.level, "warning");
  assert.equal(v0010.takenToday, true);
  assert.equal(v0010.headline, "Amlodipine 5 mg: taken at 23:50");
  assert.match(v0010.speech, /already took it at 23:50/);
  assert.ok(v0010.reasons.includes("dose logged at 23:50, within the dosing interval"));
  assertVerdictBounds(v0010.headline, v0010.speech);

  const at1149 = new Date(2026, 10, 15, 11, 49, 59, 999);
  assert.equal(lastDoseWithin(profile, "aml", at1149, twelveHoursMs), dose2350);
  assert.equal(checkLabel(amlRead, profile, at1149).level, "warning");

  const at1150Exact = new Date(2026, 10, 15, 11, 50, 0, 0);
  assert.equal(lastDoseWithin(profile, "aml", at1150Exact, twelveHoursMs), undefined);
  assert.equal(checkLabel(amlRead, profile, at1150Exact).level, "match");

  const at1200 = new Date(2026, 10, 15, 12, 0, 0, 0);
  assert.equal(lastDoseWithin(profile, "aml", at1200, twelveHoursMs), undefined);
  const v1200 = checkLabel(amlRead, profile, at1200);
  assert.equal(v1200.level, "match");
  assert.equal(v1200.takenToday, false);
  assertVerdictBounds(v1200.headline, v1200.speech);
});

test("lastDoseWithin rolling window handles BID 6h cliff, TID 4h cliff, latest timestamp selection, and ignores future timestamps", () => {
  const bidMed: Med = { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"] };
  const metRead = makeRead({ product: f("Metformin"), ingredient: f("metformin"), strength: f("500 mg") });
  const dose0700 = new Date(2026, 10, 15, 7, 0, 0, 0).getTime();
  const bidProfile = makeProfile({ meds: [bidMed], doseLog: [{ medId: "met", ts: dose0700 }] });
  const sixHoursMs = 6 * 3600_000;

  const at1259 = new Date(2026, 10, 15, 12, 59, 0, 0);
  assert.equal(lastDoseWithin(bidProfile, "met", at1259, sixHoursMs), dose0700);
  const vBidEarly = checkLabel(metRead, bidProfile, at1259);
  assert.equal(vBidEarly.level, "warning");
  assert.equal(vBidEarly.takenToday, true);
  assert.equal(vBidEarly.headline, "Metformin 500 mg: taken at 07:00");
  assert.ok(vBidEarly.reasons.includes("dose logged at 07:00, within the dosing interval"));
  assertVerdictBounds(vBidEarly.headline, vBidEarly.speech);

  const at1301 = new Date(2026, 10, 15, 13, 1, 0, 0);
  assert.equal(lastDoseWithin(bidProfile, "met", at1301, sixHoursMs), undefined);
  const vBidReady = checkLabel(metRead, bidProfile, at1301);
  assert.equal(vBidReady.level, "match");
  assert.equal(vBidReady.takenToday, true);
  assert.match(vBidReady.speech, /taken 1 of 2 doses today/);
  assert.ok(vBidReady.reasons.includes("taken today: 1/2"));
  assertVerdictBounds(vBidReady.headline, vBidReady.speech);

  const tidMed: Med = { id: "amo", name: "Amorion", ingredient: "amoxicillin", strength: "500 mg", schedule: ["08:00", "14:00", "20:00"] };
  const amoRead = makeRead({ product: f("Amorion"), ingredient: f("amoxicillin"), strength: f("500 mg") });
  const dose0800 = new Date(2026, 10, 15, 8, 0, 0, 0).getTime();
  const tidProfile = makeProfile({ meds: [tidMed], doseLog: [{ medId: "amo", ts: dose0800 }] });
  const fourHoursMs = 4 * 3600_000;

  const at1159 = new Date(2026, 10, 15, 11, 59, 0, 0);
  assert.equal(lastDoseWithin(tidProfile, "amo", at1159, fourHoursMs), dose0800);
  const vTidEarly = checkLabel(amoRead, tidProfile, at1159);
  assert.equal(vTidEarly.level, "warning");
  assert.equal(vTidEarly.headline, "Amoxicillin 500 mg: taken at 08:00");

  const at1201 = new Date(2026, 10, 15, 12, 1, 0, 0);
  assert.equal(lastDoseWithin(tidProfile, "amo", at1201, fourHoursMs), undefined);
  const vTidReady = checkLabel(amoRead, tidProfile, at1201);
  assert.equal(vTidReady.level, "match");
  assert.match(vTidReady.speech, /taken 1 of 3 doses today/);
  assert.ok(vTidReady.reasons.includes("taken today: 1/3"));

  const dose0805 = new Date(2026, 10, 15, 8, 5, 0, 0).getTime();
  const future2300 = new Date(2026, 10, 15, 23, 0, 0, 0).getTime();
  const multiLog = makeProfile({
    meds: [tidMed],
    doseLog: [
      { medId: "amo", ts: dose0800 },
      { medId: "amo", ts: dose0805 },
      { medId: "amo", ts: future2300 },
      { medId: "other", ts: new Date(2026, 10, 15, 9, 55, 0, 0).getTime() },
    ],
  });
  const at1000 = new Date(2026, 10, 15, 10, 0, 0, 0);
  assert.equal(lastDoseWithin(multiLog, "amo", at1000, fourHoursMs), dose0805);

  const futureOnlyProfile = makeProfile({
    doseLog: [{ medId: "aml", ts: new Date(2026, 10, 15, 21, 30, 0, 0).getTime() }],
  });
  assert.equal(lastDoseWithin(futureOnlyProfile, "aml", EVENING_NOW, 12 * 3600_000), undefined);
  const vFutureIgnored = checkLabel(
    makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg") }),
    futureOnlyProfile,
    EVENING_NOW,
  );
  assert.equal(vFutureIgnored.level, "match");
  assert.equal(vFutureIgnored.takenToday, false);
  assert.match(vFutureIgnored.speech, /You haven't taken it today\./);
});

test("tooEarlyFor exempts small hours before 05:00 and adds morning or midday note for later-day medicines", () => {
  const eveningProfile = makeProfile();
  const amlRead = makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg") });

  const at0459 = checkLabel(amlRead, eveningProfile, new Date(2026, 10, 15, 4, 59, 0, 0));
  assert.equal(at0459.level, "match");
  assert.doesNotMatch(at0459.speech, /only morning now/);
  assert.ok(!at0459.reasons.some((r) => r.includes("scheduled later")));

  const at0500 = checkLabel(amlRead, eveningProfile, new Date(2026, 10, 15, 5, 0, 0, 0));
  assert.equal(at0500.level, "match");
  assert.match(at0500.speech, /your evening pill, but it's only morning now\./);
  assert.ok(at0500.reasons.includes("asked in the morning, scheduled later"));
  assertVerdictBounds(at0500.headline, at0500.speech);

  const nightMed: Med = { id: "zop", name: "Zopinox", ingredient: "zopiclone", strength: "7.5 mg", schedule: ["bedtime"] };
  const nightProfile = makeProfile({ meds: [nightMed] });
  const zopRead = makeRead({ product: f("Zopinox"), ingredient: f("zopiclone"), strength: f("7.5 mg") });

  const nightAt0330 = checkLabel(zopRead, nightProfile, new Date(2026, 10, 15, 3, 30, 0, 0));
  assert.equal(nightAt0330.level, "match");
  assert.doesNotMatch(nightAt0330.speech, /but it's only/);

  const nightAt0900 = checkLabel(zopRead, nightProfile, new Date(2026, 10, 15, 9, 0, 0, 0));
  assert.equal(nightAt0900.level, "match");
  assert.match(nightAt0900.speech, /your bedtime pill, but it's only morning now\./);
  assert.ok(nightAt0900.reasons.includes("asked in the morning, scheduled later"));

  const nightAt1230 = checkLabel(zopRead, nightProfile, new Date(2026, 10, 15, 12, 30, 0, 0));
  assert.equal(nightAt1230.level, "match");
  assert.match(nightAt1230.speech, /your bedtime pill, but it's only midday now\./);
  assert.ok(nightAt1230.reasons.includes("asked in the midday, scheduled later"));
  assertVerdictBounds(nightAt1230.headline, nightAt1230.speech);

  const eveningAt1230 = checkLabel(amlRead, eveningProfile, new Date(2026, 10, 15, 12, 30, 0, 0));
  assert.equal(eveningAt1230.level, "match");
  assert.doesNotMatch(eveningAt1230.speech, /but it's only/);
});

test("applyQuestion and checkLabel convert wrong-slot matches to warnings across EN, FI, and SV slot queries", () => {
  const eveningMed: Med = { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] };
  const morningMed: Med = { id: "ram", name: "Cardace", ingredient: "ramipril", strength: "5 mg", schedule: ["08:00"] };
  const prnMed: Med = { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: [] };
  const profile = makeProfile({ meds: [eveningMed, morningMed, prnMed] });

  const amlRead = makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg") });
  const ramRead = makeRead({ product: f("Cardace"), ingredient: f("ramipril"), strength: f("5 mg") });
  const parRead = makeRead({ product: f("Panadol"), ingredient: f("paracetamol"), strength: f("500 mg") });

  const wrongForEveningMed: Array<[string, string]> = [
    ["Is this my morning pill?", "morning"],
    ["Onko tämä aamupilleri?", "morning"],
    ["Olenko ottamassa aamulla otettavaa lääkettä?", "morning"],
    ["Är det här min morgonmedicin?", "morning"],
    ["Ska jag ta den till frukost?", "morning"],
    ["Otanko tämän lounas-aikaan?", "midday"],
    ["Ska jag ta denna till middag?", "midday"],
    ["Is this for bedtime?", "night"],
    ["Otanko tämän nukkumaan mennessä?", "night"],
    ["Är den här för läggdags?", "night"],
  ];

  for (const [q, asked] of wrongForEveningMed) {
    const v = checkLabel(amlRead, profile, EVENING_NOW, undefined, q);
    assert.equal(v.level, "warning", q);
    assert.equal(v.headline, `Norvasc: not your ${asked} pill`);
    assert.match(v.speech, new RegExp(`your evening medicine, not your ${asked} one`));
    assert.ok(v.reasons.includes(`asked about ${asked}, scheduled evening`));
    assertVerdictBounds(v.headline, v.speech);
  }

  const wrongForMorningMed: Array<[string, string]> = [
    ["Onko tämä iltapilleri?", "evening"],
    ["Är det här min kvällstablett?", "evening"],
    ["Is this my dinner pill?", "evening"],
    ["Är denna för natt?", "night"],
  ];

  for (const [q, asked] of wrongForMorningMed) {
    const v = checkLabel(ramRead, profile, new Date(2026, 10, 15, 8, 0, 0, 0), undefined, q);
    assert.equal(v.level, "warning", q);
    assert.equal(v.headline, `Cardace: not your ${asked} pill`);
    assert.ok(v.reasons.includes(`asked about ${asked}, scheduled morning`));
    assertVerdictBounds(v.headline, v.speech);
  }

  for (const matchingQ of ["Onko tämä iltapilleri?", "Är det här för kväll?", "Is this my evening pill?"]) {
    assert.equal(checkLabel(amlRead, profile, EVENING_NOW, undefined, matchingQ).level, "match", matchingQ);
  }

  assert.equal(checkLabel(parRead, profile, EVENING_NOW, undefined, "Onko tämä aamupilleri?").level, "match");

  const unsureBase = checkLabel(
    makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg", 0.5) }),
    profile,
    EVENING_NOW,
  );
  assert.equal(unsureBase.level, "unsure");
  assert.deepEqual(applyQuestion(unsureBase, profile, "Onko tämä aamupilleri?"), unsureBase);
});

test("low-confidence past expiry cliff separates 0.29 match note, 0.30..0.69 unsure check, and >= 0.70 expired warning", () => {
  const profile = makeProfile();
  const baseFields = { product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("5 mg") };

  const at029 = checkLabel(makeRead({ ...baseFields, expiry: f("2025-05", 0.29) }), profile, EVENING_NOW);
  assert.equal(at029.level, "match");
  assert.ok(at029.reasons.includes("expiry not readable"));
  assert.match(at029.speech, /couldn't read the expiry date\.$/);
  assertVerdictBounds(at029.headline, at029.speech);

  for (const conf of [0.3, 0.5, 0.69]) {
    const v = checkLabel(makeRead({ ...baseFields, expiry: f("2025-05", conf) }), profile, EVENING_NOW);
    assert.equal(v.level, "unsure", `conf=${conf}`);
    assert.equal(v.headline, "Amlodipine 5 mg: check the expiry date");
    assert.match(v.speech, /expiry date may have passed and I can't read it clearly/);
    assert.equal(v.matchedMedId, "aml");
    assert.ok(v.reasons.includes("expiry may have passed (2025-05, low confidence)"));
    assertVerdictBounds(v.headline, v.speech);
  }

  for (const conf of [0.7, 0.95]) {
    const v = checkLabel(makeRead({ ...baseFields, expiry: f("2025-05", conf) }), profile, EVENING_NOW);
    assert.equal(v.level, "warning", `conf=${conf}`);
    assert.equal(v.headline, "Amlodipine 5 mg: expired May 2025");
    assert.match(v.speech, /This box expired in May 2025/);
    assert.ok(v.reasons.includes("expired 2025-05"));
    assertVerdictBounds(v.headline, v.speech);
  }

  const futureLowConf = checkLabel(makeRead({ ...baseFields, expiry: f("2028-05", 0.45) }), profile, EVENING_NOW);
  assert.equal(futureLowConf.level, "match");
  assert.ok(futureLowConf.reasons.includes("expiry not readable"));
});

test("DataMatrix otherPack GTIN mismatch downgrades match to unsure without masking safety warnings", () => {
  const savedGtinA = "06414100000001";
  const unknownGtinB = "06414100099999";
  const profileWithGtin = makeProfile({
    meds: [{ ...baseAml, gtin: savedGtinA }],
  });
  const amlRead = makeRead({
    product: f("Norvasc"),
    ingredient: f("amlodipine"),
    strength: f("5 mg"),
    expiry: f("2028-06"),
  });

  const codeMismatch = parseGs1(`(01)${unknownGtinB}(17)280630(10)BATCH1`)!;
  const vOtherPack = checkLabel(amlRead, profileWithGtin, EVENING_NOW, codeMismatch);
  assert.equal(vOtherPack.level, "unsure");
  assert.equal(vOtherPack.headline, "Amlodipine: not your saved pack");
  assert.equal(
    vOtherPack.speech,
    "The label reads Amlodipine, but this pack's code isn't the one you saved. It may be a different pack size or a different product, so please check with a pharmacist.",
  );
  assert.equal(vOtherPack.matchedMedId, "aml");
  assert.equal(vOtherPack.crossCheck?.agrees, true);
  assert.ok(vOtherPack.crossCheck?.details.includes(`GTIN ${unknownGtinB} is not your saved Norvasc pack (${savedGtinA})`));
  assertVerdictBounds(vOtherPack.headline, vOtherPack.speech);

  const profileWithEan13 = makeProfile({
    meds: [{ ...baseAml, barcode: "6414100000001" }],
  });
  const vBarcodeMismatch = checkLabel(amlRead, profileWithEan13, EVENING_NOW, { raw: unknownGtinB, gtin: unknownGtinB });
  assert.equal(vBarcodeMismatch.level, "unsure");
  assert.equal(vBarcodeMismatch.headline, "Amlodipine: not your saved pack");
  assert.equal(vBarcodeMismatch.crossCheck?.agrees, null);

  const profileWithoutGtin = makeProfile();
  const vUnlinkedPack = checkLabel(amlRead, profileWithoutGtin, EVENING_NOW, codeMismatch);
  assert.equal(vUnlinkedPack.level, "match");
  assert.ok(vUnlinkedPack.crossCheck?.details.includes(`GTIN ${unknownGtinB} not saved in your list`));

  const wrongStrengthWithOtherPack = checkLabel(
    makeRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("10 mg"), expiry: f("2028-06") }),
    profileWithGtin,
    EVENING_NOW,
    codeMismatch,
  );
  assert.equal(wrongStrengthWithOtherPack.level, "warning");
  assert.match(wrongStrengthWithOtherPack.headline, /wrong strength/);
  assert.ok(wrongStrengthWithOtherPack.reasons.some((r) => r.includes("is not your saved Norvasc pack")));
});
