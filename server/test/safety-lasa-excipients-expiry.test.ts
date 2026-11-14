import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import {
  MATCH_MIN_READABILITY,
  MATCH_NAME_MIN_CONF,
  STRENGTH_MIN_CONF,
  allergenHits,
  avoidHits,
  checkLabel,
  dosesToday,
  isExpired,
  matchMed,
  monthYear,
  sayDate,
  spokenIngredient,
} from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function makeRead(p: Partial<LabelRead>): LabelRead {
  return {
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
  };
}

function makeProfile(p: Partial<Profile> = {}): Profile {
  return {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...p,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertVerdictBounds(headline: string, speech: string, ctx: string) {
  assert.ok(wordCount(headline) <= 8, `${ctx}: headline > 8 words: "${headline}"`);
  assert.ok(sentenceCount(speech) <= 2, `${ctx}: speech > 2 sentences: "${speech}"`);
}

test("LASA look-alike drug pairs return warning not on your medication list in both directions", () => {
  const pairs: Array<[string, string, string]> = [
    ["hydralazine", "hydroxyzine", "25 mg"],
    ["lamotrigine", "lamivudine", "100 mg"],
    ["celecoxib", "ceftriaxone", "200 mg"],
    ["metformin", "metronidazole", "500 mg"],
    ["atorvastatin", "rosuvastatin", "10 mg"],
    ["bisoprolol", "metoprolol", "5 mg"],
    ["ramipril", "lisinopril", "5 mg"],
  ];

  for (const [drugA, drugB, strength] of pairs) {
    for (const [saved, held] of [[drugA, drugB], [drugB, drugA]] as const) {
      const med: Med = { id: `med-${saved}`, name: saved, ingredient: saved, strength, schedule: ["evening"] };
      const profile = makeProfile({ meds: [med] });
      const label = makeRead({
        product: f(`${held} ${strength}`),
        ingredient: f(held),
        strength: f(strength),
        expiry: f("2027-09"),
      });

      assert.equal(matchMed(label, [med]), undefined, `${held} must not match saved ${saved}`);
      assert.deepEqual(avoidHits(label, [saved]), [], `${held} must not trigger avoid for ${saved}`);

      const v = checkLabel(label, profile, NOW);
      assert.equal(v.level, "warning", `${held} vs ${saved}`);
      assert.equal(v.matchedMedId, undefined, `${held} vs ${saved}`);
      assert.ok(v.reasons.includes("not on your medication list"), `${held} vs ${saved}`);
      assert.match(v.speech, /isn't on your medication list\./);
      assertVerdictBounds(v.headline, v.speech, `${held} vs ${saved}`);
    }
  }

  const statinAvoidProfile = makeProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    avoid: ["statins"],
  });
  const rosuva = checkLabel(
    makeRead({ product: f("Crestor 10 mg"), ingredient: f("rosuvastatin"), strength: f("10 mg") }),
    statinAvoidProfile,
    NOW,
  );
  assert.equal(rosuva.level, "warning");
  assert.ok(rosuva.reasons.includes("not on your medication list"));
  assert.ok(rosuva.reasons.includes("rosuvastatin is an statin, on your avoid list"));
  assert.match(rosuva.speech, /avoid rosuvastatin\.$/);
  assertVerdictBounds(rosuva.headline, rosuva.speech, "rosuvastatin avoid");
});

test("1-char OCR typos on >=7-char names sharing first 4 chars match when conf >= 0.8 and readability >= 0.5", () => {
  const ocrCases: Array<{ typo: string; canonical: string; strength: string; id: string }> = [
    { typo: "amlodipne", canonical: "amlodipine", strength: "5 mg", id: "aml" },
    { typo: "metformn", canonical: "metformin", strength: "500 mg", id: "met" },
    { typo: "bisoprolo", canonical: "bisoprolol", strength: "5 mg", id: "bis" },
    { typo: "atorvastatn", canonical: "atorvastatin", strength: "10 mg", id: "ato" },
  ];

  for (const c of ocrCases) {
    const med: Med = { id: c.id, name: c.canonical, ingredient: c.canonical, strength: c.strength, schedule: ["evening"] };
    const profile = makeProfile({ meds: [med] });

    const exactThresholdRead = makeRead({
      ingredient: f(c.typo, MATCH_NAME_MIN_CONF),
      strength: f(c.strength, STRENGTH_MIN_CONF),
      expiry: f("2027-08"),
      readability: MATCH_MIN_READABILITY,
    });
    assert.equal(matchMed(exactThresholdRead, [med])?.id, c.id, `${c.typo} -> ${c.canonical}`);

    const matched = checkLabel(exactThresholdRead, profile, NOW);
    assert.equal(matched.level, "match", `${c.typo} at exact min conf and readability`);
    assert.equal(matched.matchedMedId, c.id);
    assert.equal(matched.takenToday, false);
    assertVerdictBounds(matched.headline, matched.speech, c.typo);

    const lowConf = checkLabel(
      makeRead({
        ingredient: f(c.typo, 0.79),
        strength: f(c.strength, 0.95),
        expiry: f("2027-08"),
        readability: 0.9,
      }),
      profile,
      NOW,
    );
    assert.equal(lowConf.level, "unsure", `${c.typo} below MATCH_NAME_MIN_CONF`);
    assert.equal(lowConf.matchedMedId, c.id);
    assert.ok(lowConf.reasons.some((r) => r.startsWith("identity not confident")));

    const lowReadability = checkLabel(
      makeRead({
        ingredient: f(c.typo, 0.92),
        strength: f(c.strength, 0.95),
        expiry: f("2027-08"),
        readability: 0.49,
      }),
      profile,
      NOW,
    );
    assert.equal(lowReadability.level, "unsure", `${c.typo} below MATCH_MIN_READABILITY`);
    assert.equal(lowReadability.matchedMedId, c.id);
    assert.ok(lowReadability.reasons.some((r) => r.startsWith("identity not confident")));
  }
});

test("spokenIngredient strips all salt and hydrate suffixes case-insensitively and when chained", () => {
  const suffixes = [
    "besilate",
    "besylate",
    "maleate",
    "mesilate",
    "mesylate",
    "hydrochloride",
    "hcl",
    "sodium",
    "potassium",
    "calcium",
    "magnesium",
    "tartrate",
    "succinate",
    "fumarate",
    "citrate",
    "sulfate",
    "sulphate",
    "phosphate",
    "acetate",
    "bromide",
    "dihydrate",
    "monohydrate",
    "trihydrate",
  ];
  assert.equal(suffixes.length, 23);

  for (const sfx of suffixes) {
    const titleSfx = sfx.charAt(0).toUpperCase() + sfx.slice(1);
    assert.equal(spokenIngredient(`amlodipine ${sfx}`), "amlodipine", `lower: ${sfx}`);
    assert.equal(spokenIngredient(`AMLODIPINE ${sfx.toUpperCase()}`), "AMLODIPINE", `upper: ${sfx}`);
    assert.equal(spokenIngredient(`Metoprolol ${titleSfx}`), "Metoprolol", `title: ${sfx}`);
  }

  assert.equal(spokenIngredient("amlodipine besilate dihydrate"), "amlodipine");
  assert.equal(spokenIngredient("AMLODIPINE   BESYLATE   MONOHYDRATE"), "AMLODIPINE");
  assert.equal(spokenIngredient("Atorvastatin Calcium Trihydrate"), "Atorvastatin");
  assert.equal(spokenIngredient("sitagliptin phosphate monohydrate"), "sitagliptin");
  assert.equal(spokenIngredient("esomeprazole magnesium dihydrate"), "esomeprazole");
  assert.equal(spokenIngredient("hydrochlorothiazide"), "hydrochlorothiazide");
  assert.equal(spokenIngredient("bromocriptine"), "bromocriptine");
  assert.equal(spokenIngredient("sulfasalazine"), "sulfasalazine");
  assert.equal(spokenIngredient(null), "");
  assert.equal(spokenIngredient(undefined), "");
  assert.equal(spokenIngredient("   "), "");

  const p = makeProfile({
    meds: [{ id: "aml", name: "Amlodipin", ingredient: "amlodipine besilate dihydrate", strength: "5 mg", schedule: ["evening"] }],
  });
  const v = checkLabel(makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }), p, NOW);
  assert.equal(v.level, "match");
  assert.equal(v.speech, "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
});

test("medication excipient allergies warn on lactose, arachis oil, soya oil, wheat starch, and sulphites", () => {
  const savedAml: Med = { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] };

  const excipientCases: Array<{
    allergy: string;
    excipient: string;
    allergenConf?: number;
  }> = [
    { allergy: "milk", excipient: "lactose monohydrate", allergenConf: 0.9 },
    { allergy: "lactose", excipient: "lactose monohydrate", allergenConf: 0.1 },
    { allergy: "peanut", excipient: "arachis oil", allergenConf: 0.85 },
    { allergy: "soy", excipient: "soya oil", allergenConf: 0.85 },
    { allergy: "gluten", excipient: "wheat starch", allergenConf: 0.85 },
    { allergy: "sulphite", excipient: "sulphites", allergenConf: 0.85 },
    { allergy: "sulphite", excipient: "sodium metabisulfite (sulphites)", allergenConf: 0.85 },
    { allergy: "sulfites", excipient: "sulfur dioxide", allergenConf: 0.85 },
    { allergy: "sodium metabisulfite", excipient: "sodium metabisulfite", allergenConf: 0.85 },
  ];

  for (const c of excipientCases) {
    const label = makeRead({
      kind: "medication",
      product: f("Amlodipine 5 mg"),
      ingredient: f("amlodipine"),
      strength: f("5 mg"),
      expiry: f("2027-08"),
      allergens: f([c.excipient], c.allergenConf ?? 0.9),
    });

    const hits = allergenHits(label, [c.allergy]);
    assert.equal(hits.length, 1, `${c.allergy} -> ${c.excipient}`);
    assert.equal(hits[0].allergy, c.allergy);
    assert.equal(hits[0].found, c.excipient);
    assert.equal(hits[0].mayContain, false);

    const v = checkLabel(label, makeProfile({ meds: [savedAml], allergies: [c.allergy] }), NOW);
    assert.equal(v.level, "warning", `checkLabel ${c.allergy} -> ${c.excipient}`);
    assert.equal(v.matchedMedId, "aml");
    assert.ok(v.reasons.includes(`contains ${c.excipient} (allergy: ${c.allergy})`));
    assertVerdictBounds(v.headline, v.speech, `${c.allergy}:${c.excipient}`);
  }
});

test("penicillin class allergy warns on amoxicillin and pivmecillinam even when allergens.confidence is 0", () => {
  const penCases: Array<{ product: string; ingredient: string; expectedFound: string; strength: string; allergyTerm: string }> = [
    { product: "Amoxin 500 mg", ingredient: "amoxicillin trihydrate", expectedFound: "amoxicillin", strength: "500 mg", allergyTerm: "penicillin" },
    { product: "Selexid 200 mg", ingredient: "pivmecillinam hydrochloride", expectedFound: "pivmecillinam", strength: "200 mg", allergyTerm: "penicillin" },
    { product: "Amorion 750 mg", ingredient: "amoxicillin", expectedFound: "amoxicillin", strength: "750 mg", allergyTerm: "penicillins" },
    { product: "Selexid 200 mg", ingredient: "pivmecillinam", expectedFound: "pivmecillinam", strength: "200 mg", allergyTerm: "penisilliini" },
  ];

  for (const c of penCases) {
    const label = makeRead({
      kind: "medication",
      product: f(c.product),
      ingredient: f(c.ingredient),
      strength: f(c.strength),
      expiry: f("2027-10"),
      allergens: f<string[]>(null, 0),
    });

    const hits = allergenHits(label, [c.allergyTerm]);
    assert.deepEqual(hits, [{ allergy: c.allergyTerm, found: c.expectedFound, mayContain: false }]);

    const savedMed: Med = { id: "pen-med", name: c.product, ingredient: c.expectedFound, strength: c.strength, schedule: ["morning"] };
    const v = checkLabel(label, makeProfile({ meds: [savedMed], allergies: [c.allergyTerm] }), NOW);
    assert.equal(v.level, "warning", `${c.expectedFound} with ${c.allergyTerm}`);
    assert.equal(v.matchedMedId, "pen-med");
    assert.ok(v.reasons.includes(`contains ${c.expectedFound} (allergy: ${c.allergyTerm})`));
    assert.match(v.speech, new RegExp(`allergy to ${c.allergyTerm}\\.$`));
    assertVerdictBounds(v.headline, v.speech, `${c.expectedFound}:${c.allergyTerm}`);
  }
});

test("dosesToday enforces local-midnight 00:00:00.000 boundary and excludes future timestamps", () => {
  const now = new Date(2026, 10, 14, 15, 30, 0, 0);
  const midnight = new Date(2026, 10, 14, 0, 0, 0, 0);

  const baseLog = [
    { medId: "tid", ts: midnight.getTime() - 1 },
    { medId: "other", ts: midnight.getTime() + 60_000 },
    { medId: "tid", ts: now.getTime() + 1 },
    { medId: "tid", ts: now.getTime() + 3_600_000 },
  ];
  assert.equal(dosesToday(makeProfile({ doseLog: baseLog }), "tid", now), 0);

  const atMidnight = [...baseLog, { medId: "tid", ts: midnight.getTime() }];
  assert.equal(dosesToday(makeProfile({ doseLog: atMidnight }), "tid", now), 1);

  const atMidnightAndNow = [...atMidnight, { medId: "tid", ts: now.getTime() }];
  assert.equal(dosesToday(makeProfile({ doseLog: atMidnightAndNow }), "tid", now), 2);
});

test("three-dose daily schedule verdicts across 0/3, 1/3, 2/3, and 3/3 doses", () => {
  const tidMed: Med = {
    id: "gab",
    name: "Neurontin",
    ingredient: "gabapentin",
    strength: "300 mg",
    schedule: ["08:00", "14:00", "20:00"],
  };
  const label = makeRead({
    product: f("Gabapentin 300 mg"),
    ingredient: f("gabapentin"),
    strength: f("300 mg"),
    expiry: f("2027-12"),
  });

  const t1 = new Date(2026, 10, 14, 8, 5, 0, 0).getTime();
  const t2 = new Date(2026, 10, 14, 14, 10, 0, 0).getTime();
  const t3 = new Date(2026, 10, 14, 19, 45, 0, 0).getTime();
  const future = NOW.getTime() + 60_000;
  const yesterday = new Date(2026, 10, 13, 23, 59, 59, 999).getTime();

  const v0 = checkLabel(label, makeProfile({ meds: [tidMed], doseLog: [{ medId: "gab", ts: yesterday }, { medId: "gab", ts: future }] }), NOW);
  assert.equal(v0.level, "match");
  assert.equal(v0.takenToday, false);
  assert.ok(v0.reasons.includes("taken today: 0/3"));
  assert.match(v0.speech, /You haven't taken it today\.$/);
  assertVerdictBounds(v0.headline, v0.speech, "0/3");

  const v1 = checkLabel(label, makeProfile({ meds: [tidMed], doseLog: [{ medId: "gab", ts: t1 }] }), NOW);
  assert.equal(v1.level, "match");
  assert.equal(v1.takenToday, true);
  assert.ok(v1.reasons.includes("taken today: 1/3"));
  assert.match(v1.speech, /You've taken 1 of 3 doses today\.$/);
  assertVerdictBounds(v1.headline, v1.speech, "1/3");

  const v2 = checkLabel(label, makeProfile({ meds: [tidMed], doseLog: [{ medId: "gab", ts: t1 }, { medId: "gab", ts: t2 }] }), NOW);
  assert.equal(v2.level, "match");
  assert.equal(v2.takenToday, true);
  assert.ok(v2.reasons.includes("taken today: 2/3"));
  assert.match(v2.speech, /You've taken 2 of 3 doses today\.$/);
  assertVerdictBounds(v2.headline, v2.speech, "2/3");

  const v3 = checkLabel(
    label,
    makeProfile({ meds: [tidMed], doseLog: [{ medId: "gab", ts: t1 }, { medId: "gab", ts: t2 }, { medId: "gab", ts: t3 }] }),
    NOW,
  );
  assert.equal(v3.level, "warning");
  assert.equal(v3.takenToday, true);
  assert.ok(v3.reasons.includes("taken today: 3/3"));
  assert.equal(v3.headline, "Gabapentin 300 mg: already taken today");
  assert.match(v3.speech, /You already took it today, 3 times\.$/);
  assertVerdictBounds(v3.headline, v3.speech, "3/3");
});

test("sayDate, monthYear, and isExpired across all 12 months and boundary dates", () => {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  for (let i = 0; i < months.length; i++) {
    const mm = String(i + 1).padStart(2, "0");
    const name = months[i];
    assert.equal(sayDate(`2027-${mm}`), `${name} 2027`);
    assert.equal(sayDate(`2027-${mm}-05`), `5 ${name} 2027`);
    assert.equal(sayDate(`2027-${mm}-24`), `24 ${name} 2027`);
    assert.equal(monthYear(`2027-${mm}`), `${name} 2027`);
    assert.equal(monthYear(`2027-${mm}-19`), `${name} 2027`);
  }

  assert.equal(sayDate("11/2027"), "11/2027");
  assert.equal(monthYear("not-a-date"), "not-a-date");
  assert.equal(isExpired("not-a-date", NOW), undefined);
  assert.equal(isExpired(null, NOW), undefined);
  assert.equal(isExpired("2026-02", new Date(2026, 1, 28, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-02", new Date(2026, 2, 1, 0, 0, 0, 0)), true);
  assert.equal(isExpired("2028-02", new Date(2028, 1, 29, 20, 0, 0, 0)), false);
  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 14, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 15, 0, 0, 0, 0)), true);
});

test("food kind verdicts with and without allergies, avoid list, and expiry", () => {
  const foodNoAllergyProfile = makeProfile({ allergies: [], avoid: ["grapefruit"] });

  const foodPlain = checkLabel(
    makeRead({ kind: "food", product: f("Rye bread"), allergens: f<string[]>(null, 0), expiry: f("2026-11-25") }),
    foodNoAllergyProfile,
    NOW,
  );
  assert.equal(foodPlain.level, "info");
  assert.equal(foodPlain.headline, "Rye bread");
  assert.equal(foodPlain.speech, "This is Rye bread. Best before 25 November 2026.");
  assertVerdictBounds(foodPlain.headline, foodPlain.speech, "foodPlain");

  const foodAvoid = checkLabel(
    makeRead({ kind: "food", product: f("Grapefruit juice"), allergens: f([], 0.9) }),
    foodNoAllergyProfile,
    NOW,
  );
  assert.equal(foodAvoid.level, "warning");
  assert.equal(foodAvoid.headline, "Grapefruit juice: on your avoid list");
  assert.equal(foodAvoid.speech, "Grapefruit juice is on your avoid list.");

  const foodExpired = checkLabel(
    makeRead({ kind: "food", product: f("Yogurt"), allergens: f(["milk"], 0.9), expiry: f("2026-11-01", 0.9) }),
    foodNoAllergyProfile,
    NOW,
  );
  assert.equal(foodExpired.level, "warning");
  assert.equal(foodExpired.headline, "Yogurt: past its date");
  assert.equal(foodExpired.speech, "Yogurt was best before 1 November 2026.");

  const anonymousFood = checkLabel(
    makeRead({ kind: "food", product: f(null, 0), readability: 0.7 }),
    foodNoAllergyProfile,
    NOW,
  );
  assert.equal(anonymousFood.level, "info");
  assert.equal(anonymousFood.headline, "This food");
  assert.equal(anonymousFood.speech, "This is this food.");

  const allergyProfile = makeProfile({ allergies: ["peanut", "soy"] });

  const foodUnreadableAllergens = checkLabel(
    makeRead({ kind: "food", product: f("Granola"), allergens: f(["oats"], 0.55) }),
    allergyProfile,
    NOW,
  );
  assert.equal(foodUnreadableAllergens.level, "unsure");
  assert.equal(foodUnreadableAllergens.headline, "Can't read the allergens yet");
  assert.ok(foodUnreadableAllergens.reasons.includes("allergen panel not readable"));

  const foodSafeWithAllergies = checkLabel(
    makeRead({ kind: "food", product: f("Oat drink"), allergens: f(["oats"], 0.9), expiry: f("2026-12-10", 0.9) }),
    allergyProfile,
    NOW,
  );
  assert.equal(foodSafeWithAllergies.level, "info");
  assert.equal(foodSafeWithAllergies.headline, "Oat drink: none of your allergens");
  assert.equal(foodSafeWithAllergies.speech, "Oat drink: no peanut and soy listed. Best before 10 December 2026.");
  assert.ok(foodSafeWithAllergies.reasons.includes("no listed allergen matches your profile"));

  const foodMayContain = checkLabel(
    makeRead({ kind: "food", product: f("Dark chocolate"), allergens: f(["may contain: soya"], 0.9) }),
    allergyProfile,
    NOW,
  );
  assert.equal(foodMayContain.level, "warning");
  assert.equal(foodMayContain.headline, "Warning: may contain soya");
  assert.match(foodMayContain.speech, /may contain soya\. Your profile lists an allergy to soy\.$/);

  const foodMixedHits = checkLabel(
    makeRead({ kind: "food", product: f("Protein bar"), allergens: f(["may contain: peanuts", "soya oil"], 0.9) }),
    allergyProfile,
    NOW,
  );
  assert.equal(foodMixedHits.level, "warning");
  assert.equal(foodMixedHits.headline, "Warning: contains soya oil");
  assert.equal(foodMixedHits.speech, "Warning: Protein bar contains soya oil. Your profile lists an allergy to peanut and soy.");
});

test("other kind verdicts with and without allergies, avoid list, and expiry", () => {
  const allergyProfile = makeProfile({ allergies: ["peanut", "soy"], avoid: ["camphor"] });

  const otherUnreadableAllergens = checkLabel(
    makeRead({ kind: "other", product: f("Hand soap"), allergens: f<string[]>(null, 0) }),
    allergyProfile,
    NOW,
  );
  assert.equal(otherUnreadableAllergens.level, "info");
  assert.equal(otherUnreadableAllergens.headline, "Hand soap");
  assert.equal(otherUnreadableAllergens.speech, "This is Hand soap.");

  const otherWithFutureDate = checkLabel(
    makeRead({ kind: "other", product: f("Eye drops"), expiry: f("2027-03-15", 0.9), allergens: f<string[]>(null, 0) }),
    makeProfile(),
    NOW,
  );
  assert.equal(otherWithFutureDate.level, "info");
  assert.equal(otherWithFutureDate.speech, "This is Eye drops. Best before 15 March 2027.");

  const otherAllergenHit = checkLabel(
    makeRead({ kind: "other", product: f("Bath oil"), allergens: f(["arachis oil"], 0.85) }),
    allergyProfile,
    NOW,
  );
  assert.equal(otherAllergenHit.level, "warning");
  assert.equal(otherAllergenHit.headline, "Warning: contains arachis oil");

  const otherAvoid = checkLabel(
    makeRead({ kind: "other", product: f("Camphor balm"), allergens: f<string[]>(null, 0) }),
    allergyProfile,
    NOW,
  );
  assert.equal(otherAvoid.level, "warning");
  assert.equal(otherAvoid.headline, "Camphor balm: on your avoid list");
  assert.equal(otherAvoid.speech, "Camphor balm is on your avoid list.");

  const otherExpired = checkLabel(
    makeRead({ kind: "other", product: f("Saline spray"), expiry: f("2025-04-15", 0.9), allergens: f<string[]>(null, 0) }),
    allergyProfile,
    NOW,
  );
  assert.equal(otherExpired.level, "warning");
  assert.equal(otherExpired.headline, "Saline spray: past its date");
  assert.equal(otherExpired.speech, "Saline spray was best before 15 April 2025.");

  const anonymousOther = checkLabel(
    makeRead({ kind: "other", product: f(null, 0), readability: 0.7 }),
    allergyProfile,
    NOW,
  );
  assert.equal(anonymousOther.level, "info");
  assert.equal(anonymousOther.headline, "This item");
  assert.equal(anonymousOther.speech, "This is this item.");
});
