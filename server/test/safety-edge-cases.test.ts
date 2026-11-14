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
  clampHeadline,
  clampSpeech,
  ingredientsOf,
  isExpired,
  matchMed,
  norm,
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
    lang: "fi",
    ...p,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertOutputInvariants(headline: string, speech: string, label = "output") {
  assert.ok(headline.trim().length > 0, label);
  assert.ok(speech.trim().length > 0, label);
  assert.ok(wordCount(headline) <= 8, `${label}: "${headline}" has ${wordCount(headline)} words`);
  assert.ok(sentenceCount(speech) <= 2, `${label}: "${speech}" has ${sentenceCount(speech)} sentences`);
}

test("Finnish and Swedish brand to INN mappings resolve in ingredientsOf and matchMed", () => {
  const cases: Array<{
    brandPack: string;
    expectedInn: string;
    savedMed: Med;
    packStrength: string;
  }> = [
    {
      brandPack: "Burana® 400 mg kalvopäällysteinen tabletti Orion",
      expectedInn: "ibuprofen",
      savedMed: { id: "ibu", name: "Ibuprofeeni", ingredient: "ibuprofen", strength: "400 mg", schedule: ["morning"] },
      packStrength: "400 mg",
    },
    {
      brandPack: "Panadol Forte 1 g filmdragerade tabletter",
      expectedInn: "paracetamol",
      savedMed: { id: "par", name: "Parasetamoli", ingredient: "paracetamol", strength: "1000 mg", schedule: ["morning"] },
      packStrength: "1 g",
    },
    {
      brandPack: "Primaspan 100 mg enterotabletti",
      expectedInn: "aspirin",
      savedMed: { id: "asa", name: "Disperin", ingredient: "acetylsalicylic acid", strength: "100 mg", schedule: ["morning"] },
      packStrength: "100 mg",
    },
    {
      brandPack: "Marevan 3 mg tabletti Orion",
      expectedInn: "warfarin",
      savedMed: { id: "war", name: "Varfariini", ingredient: "warfarin", strength: "3 mg", schedule: ["evening"] },
      packStrength: "3 mg",
    },
    {
      brandPack: "Zopinox 7,5 mg kalvopäällysteinen tabletti",
      expectedInn: "zopiclone",
      savedMed: { id: "zop", name: "Imovane", ingredient: "tsopikloni", strength: "7.5 mg", schedule: ["bedtime"] },
      packStrength: "7,5 mg",
    },
    {
      brandPack: "Thyroxin 50 mikrog tabletti",
      expectedInn: "levothyroxine",
      savedMed: { id: "thy", name: "Levotyroksiini", ingredient: "levothyroxine", strength: "50 mcg", schedule: ["morning"] },
      packStrength: "50 mikrog",
    },
    {
      brandPack: "Cardace 5 mg tabletti",
      expectedInn: "ramipril",
      savedMed: { id: "ram", name: "Ramipriili", ingredient: "ramipril", strength: "5 mg", schedule: ["morning"] },
      packStrength: "5 mg",
    },
    {
      brandPack: "Emconcor 2,5 mg filmdragerade tabletter",
      expectedInn: "bisoprolol",
      savedMed: { id: "bis", name: "Bisoprololi", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["morning"] },
      packStrength: "2,5 mg",
    },
  ];

  for (const c of cases) {
    const ingr = ingredientsOf(c.brandPack);
    assert.ok(ingr.has(c.expectedInn), `${c.brandPack} -> ${c.expectedInn}`);
    const r = makeRead({ product: f(c.brandPack), strength: f(c.packStrength), expiry: f("2027-06") });
    const matched = matchMed(r, [c.savedMed]);
    assert.equal(matched?.id, c.savedMed.id, c.brandPack);
    const verdict = checkLabel(r, makeProfile({ meds: [c.savedMed] }), NOW);
    assert.equal(verdict.level, "match", c.brandPack);
    assert.equal(verdict.matchedMedId, c.savedMed.id, c.brandPack);
    assertOutputInvariants(verdict.headline, verdict.speech, c.brandPack);
  }
});

test("Nordic generic names and manufacturer stop-words do not cross-match unrelated medicines", () => {
  const profile = makeProfile({
    meds: [
      { id: "aml", name: "Amlodipiini Orion", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    ],
  });
  const swedishPack = makeRead({ product: f("Amlodipinbesilat Sandoz 5 mg filmdragerade"), strength: f("5 mg"), expiry: f("2027-09") });
  assert.equal(checkLabel(swedishPack, profile, NOW).level, "match");

  const otherOrionPack = makeRead({ product: f("Metformiini Orion 500 mg kalvopäällysteinen tabletti"), strength: f("500 mg") });
  assert.equal(matchMed(otherOrionPack, profile.meds), undefined);
  const v = checkLabel(otherOrionPack, profile, NOW);
  assert.equal(v.level, "warning");
  assert.ok(v.reasons.includes("not on your medication list"));
});

test("drug class avoid lists cover NSAID, penicillin, benzodiazepine, opioid, and statin including Finnish aliases", () => {
  const classMatrix: Array<{
    avoidTerm: string;
    expectedClassLabel: string;
    positiveReads: Array<{ product?: string; ingredient?: string }>;
    negativeRead: { product?: string; ingredient?: string };
  }> = [
    {
      avoidTerm: "tulehduskipulääke",
      expectedClassLabel: "NSAID",
      positiveReads: [
        { product: "Burana 400 mg" },
        { product: "Pronaxen 500 mg" },
        { product: "Voltaren 50 mg" },
        { product: "Primaspan 100 mg" },
        { ingredient: "etoricoxib" },
        { ingredient: "ketoprofen" },
      ],
      negativeRead: { product: "Panadol 500 mg" },
    },
    {
      avoidTerm: "tulehduskipulaakkeet",
      expectedClassLabel: "NSAID",
      positiveReads: [
        { ingredient: "celecoxib" },
        { ingredient: "meloxicam" },
        { ingredient: "dexketoprofen" },
      ],
      negativeRead: { product: "Thyroxin 50 mikrog" },
    },
    {
      avoidTerm: "penisilliini",
      expectedClassLabel: "penicillin",
      positiveReads: [
        { ingredient: "amoxicillin" },
        { ingredient: "phenoxymethylpenicillin" },
        { ingredient: "flucloxacillin" },
        { ingredient: "pivmecillinam" },
      ],
      negativeRead: { ingredient: "doxycycline" },
    },
    {
      avoidTerm: "benzodiazepines",
      expectedClassLabel: "benzodiazepine",
      positiveReads: [
        { ingredient: "diazepam" },
        { ingredient: "oxazepam" },
        { ingredient: "temazepam" },
        { ingredient: "alprazolam" },
        { ingredient: "lorazepam" },
      ],
      negativeRead: { product: "Zopinox 7,5 mg" },
    },
    {
      avoidTerm: "opioids",
      expectedClassLabel: "opioid",
      positiveReads: [
        { ingredient: "paracetamol, codeine" },
        { ingredient: "tramadol" },
        { ingredient: "oxycodone" },
        { ingredient: "buprenorphine" },
        { ingredient: "fentanyl" },
      ],
      negativeRead: { product: "Burana 400 mg" },
    },
    {
      avoidTerm: "statins",
      expectedClassLabel: "statin",
      positiveReads: [
        { product: "Zocor 20 mg" },
        { product: "Lipitor 10 mg" },
        { ingredient: "rosuvastatin" },
        { ingredient: "simvastatiini" },
      ],
      negativeRead: { product: "Cardace 5 mg" },
    },
  ];

  for (const group of classMatrix) {
    const profile = makeProfile({ avoid: [group.avoidTerm] });
    for (const pos of group.positiveReads) {
      const label = pos.product ?? pos.ingredient ?? group.avoidTerm;
      const r = makeRead({
        product: pos.product ? f(pos.product) : f(null, 0),
        ingredient: pos.ingredient ? f(pos.ingredient) : f(null, 0),
        strength: f("10 mg"),
      });
      const hits = avoidHits(r, [group.avoidTerm]);
      assert.equal(hits.length, 1, `${group.avoidTerm}: ${label}`);
      assert.ok(hits[0].endsWith(` is an ${group.expectedClassLabel}, on your avoid list`), hits[0]);
      const verdict = checkLabel(r, profile, NOW);
      assert.equal(verdict.level, "warning");
      assertOutputInvariants(verdict.headline, verdict.speech, `${group.avoidTerm}:${label}`);
    }
    const neg = makeRead({
      product: group.negativeRead.product ? f(group.negativeRead.product) : f(null, 0),
      ingredient: group.negativeRead.ingredient ? f(group.negativeRead.ingredient) : f(null, 0),
      strength: f("10 mg"),
    });
    assert.deepEqual(avoidHits(neg, [group.avoidTerm]), []);
  }
});

test("Finnish drug class allergy penisilliini and tulehduskipulaake trigger medication allergy warnings", () => {
  const penProfile = makeProfile({ allergies: ["penisilliini"] });
  const amox = makeRead({ ingredient: f("amoxicillin"), strength: f("500 mg") });
  const vPen = checkLabel(amox, penProfile, NOW);
  assert.equal(vPen.level, "warning");
  assert.match(vPen.speech, /contains amoxicillin/);
  assert.match(vPen.speech, /penisilliini/);
  assertOutputInvariants(vPen.headline, vPen.speech);

  const nsaidProfile = makeProfile({ allergies: ["tulehduskipulääke"] });
  const burana = makeRead({ product: f("Burana 400 mg"), strength: f("400 mg") });
  const vNsaid = checkLabel(burana, nsaidProfile, NOW);
  assert.equal(vNsaid.level, "warning");
  assert.match(vNsaid.speech, /contains ibuprofen/);
  assertOutputInvariants(vNsaid.headline, vNsaid.speech);
});

test("saved medicine that is also on the avoid list produces a warning instead of match", () => {
  const med: Med = { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["morning"] };
  const profile = makeProfile({ meds: [med], avoid: ["tulehduskipulaake"] });
  const v = checkLabel(makeRead({ product: f("Burana 400 mg"), strength: f("400 mg"), expiry: f("2027-05") }), profile, NOW);
  assert.equal(v.level, "warning");
  assert.equal(v.matchedMedId, "ibu");
  assert.match(v.headline, /on your avoid list/);
  assertOutputInvariants(v.headline, v.speech);
});

test("Finnish allergen synonyms and mayContain phrases across food and medication excipients", () => {
  const synonymCases: Array<{
    profileAllergy: string;
    labelTerm: string;
    mayPhrase: string;
  }> = [
    { profileAllergy: "peanut", labelTerm: "maapähkinä", mayPhrase: "Voi sisältää: maapähkinä" },
    { profileAllergy: "tree nuts", labelTerm: "hasselpähkinä", mayPhrase: "Voi sisältää hasselpähkinä" },
    { profileAllergy: "milk", labelTerm: "laktoosi", mayPhrase: "may contain: laktoosi" },
    { profileAllergy: "gluten", labelTerm: "gluteeni", mayPhrase: "kan innehålla gluteeni" },
    { profileAllergy: "sesame", labelTerm: "seesami", mayPhrase: "traces of seesami" },
    { profileAllergy: "sulphites", labelTerm: "rikkidioksidi", mayPhrase: "voi sisaltaa rikkidioksidi" },
  ];

  for (const c of synonymCases) {
    const profile = makeProfile({ allergies: [c.profileAllergy] });

    const directRead = makeRead({ kind: "food", product: f("Välipala"), allergens: f([c.labelTerm]) });
    const directHits = allergenHits(directRead, profile.allergies);
    assert.equal(directHits.length, 1, c.labelTerm);
    assert.equal(directHits[0].mayContain, false, c.labelTerm);
    const directVerdict = checkLabel(directRead, profile, NOW);
    assert.equal(directVerdict.level, "warning", c.labelTerm);
    assert.match(directVerdict.headline, /^Warning: contains /);
    assertOutputInvariants(directVerdict.headline, directVerdict.speech, c.labelTerm);

    const mayRead = makeRead({ kind: "food", product: f("Välipala"), allergens: f([c.mayPhrase]) });
    const mayHits = allergenHits(mayRead, profile.allergies);
    assert.equal(mayHits.length, 1, c.mayPhrase);
    assert.equal(mayHits[0].mayContain, true, c.mayPhrase);
    const mayVerdict = checkLabel(mayRead, profile, NOW);
    assert.equal(mayVerdict.level, "warning", c.mayPhrase);
    assert.match(mayVerdict.headline, /^Warning: may contain /);
    assertOutputInvariants(mayVerdict.headline, mayVerdict.speech, c.mayPhrase);
  }
});

test("Finnish profile allergies map bidirectionally and definite hits take precedence over mayContain", () => {
  const finnishProfile = makeProfile({
    allergies: ["pähkinä", "laktoosi", "gluteeni", "seesami", "rikkidioksidi"],
  });

  const peanutPack = makeRead({ kind: "food", product: f("Granola"), allergens: f(["voi sisältää: hasselpähkinä", "seesami"]) });
  const v = checkLabel(peanutPack, finnishProfile, NOW);
  assert.equal(v.level, "warning");
  assert.equal(v.headline, "Warning: contains seesami");
  assert.match(v.speech, /contains seesami/);
  assertOutputInvariants(v.headline, v.speech);

  const nutBoth = allergenHits(
    makeRead({ kind: "food", product: f("Suklaa"), allergens: f(["arachis", "almond"]) }),
    ["pähkinä"],
  );
  assert.equal(nutBoth.length, 1);
  assert.equal(nutBoth[0].mayContain, false);

  const medWithLactose = makeRead({
    kind: "medication",
    ingredient: f("amlodipine"),
    strength: f("5 mg"),
    allergens: f(["laktoosi"], 0.9),
  });
  const medProfile = makeProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["milk"],
  });
  const medVerdict = checkLabel(medWithLactose, medProfile, NOW);
  assert.equal(medVerdict.level, "warning");
  assert.equal(medVerdict.matchedMedId, "aml");
  assert.match(medVerdict.speech, /contains laktoosi/);
  assertOutputInvariants(medVerdict.headline, medVerdict.speech);
});

test("isExpired respects exact month-end 23:59:59 boundaries including leap years and day precision", () => {
  assert.equal(isExpired("2026-11", new Date(2026, 10, 30, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-11", new Date(2026, 10, 30, 23, 59, 59, 1)), true);
  assert.equal(isExpired("2026-11", new Date(2026, 11, 1, 0, 0, 0, 0)), true);

  assert.equal(isExpired("2026-02", new Date(2026, 1, 28, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-02", new Date(2026, 2, 1, 0, 0, 0, 0)), true);

  assert.equal(isExpired("2028-02", new Date(2028, 1, 28, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2028-02", new Date(2028, 1, 29, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2028-02", new Date(2028, 2, 1, 0, 0, 0, 0)), true);

  assert.equal(isExpired("2026-12", new Date(2026, 11, 31, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-12", new Date(2027, 0, 1, 0, 0, 0, 0)), true);

  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 14, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 15, 0, 0, 0, 0)), true);

  assert.equal(isExpired(null, NOW), undefined);
  assert.equal(isExpired(undefined, NOW), undefined);
  assert.equal(isExpired("", NOW), undefined);
  assert.equal(isExpired("11/2026", NOW), undefined);
});

test("scheduleWord maps HH:MM time buckets and named slots in checkLabel", () => {
  const bucketCases: Array<{ schedule: string[]; expectedPhrase: string; expectedHeadlineSuffix: string }> = [
    { schedule: ["00:00"], expectedPhrase: "your morning pill", expectedHeadlineSuffix: ", your morning pill" },
    { schedule: ["7:30"], expectedPhrase: "your morning pill", expectedHeadlineSuffix: ", your morning pill" },
    { schedule: ["10:59"], expectedPhrase: "your morning pill", expectedHeadlineSuffix: ", your morning pill" },
    { schedule: ["11:00"], expectedPhrase: "your midday pill", expectedHeadlineSuffix: ", your midday pill" },
    { schedule: ["14:59"], expectedPhrase: "your midday pill", expectedHeadlineSuffix: ", your midday pill" },
    { schedule: ["15:00"], expectedPhrase: "your evening pill", expectedHeadlineSuffix: ", your evening pill" },
    { schedule: ["20:59"], expectedPhrase: "your evening pill", expectedHeadlineSuffix: ", your evening pill" },
    { schedule: ["21:00"], expectedPhrase: "your night pill", expectedHeadlineSuffix: ", your night pill" },
    { schedule: ["23:59"], expectedPhrase: "your night pill", expectedHeadlineSuffix: ", your night pill" },
    { schedule: ["Morning with breakfast"], expectedPhrase: "your morning pill", expectedHeadlineSuffix: ", your morning pill" },
    { schedule: ["noon"], expectedPhrase: "your noon pill", expectedHeadlineSuffix: ", your noon pill" },
    { schedule: ["evening"], expectedPhrase: "your evening pill", expectedHeadlineSuffix: ", your evening pill" },
    { schedule: ["night"], expectedPhrase: "your night pill", expectedHeadlineSuffix: ", your night pill" },
    { schedule: ["at bedtime"], expectedPhrase: "your bedtime pill", expectedHeadlineSuffix: ", your bedtime pill" },
    { schedule: ["08:00", "20:00"], expectedPhrase: "on your list", expectedHeadlineSuffix: "" },
    { schedule: [], expectedPhrase: "on your list", expectedHeadlineSuffix: "" },
  ];

  for (const c of bucketCases) {
    const profile = makeProfile({
      meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: c.schedule }],
    });
    const r = makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") });
    const v = checkLabel(r, profile, NOW);
    assert.equal(v.level, "match", JSON.stringify(c.schedule));
    assert.equal(v.headline, `Yes: Amlodipine 5 mg${c.expectedHeadlineSuffix}`, JSON.stringify(c.schedule));
    assert.ok(v.speech.includes(`Yes, Amlodipine 5 mg, ${c.expectedPhrase}.`), v.speech);
    assertOutputInvariants(v.headline, v.speech, JSON.stringify(c.schedule));
  }
});

test("MATCH_NAME_MIN_CONF, MATCH_MIN_READABILITY, and STRENGTH_MIN_CONF exact boundaries", () => {
  assert.equal(MATCH_NAME_MIN_CONF, 0.8);
  assert.equal(STRENGTH_MIN_CONF, 0.8);
  assert.equal(MATCH_MIN_READABILITY, 0.5);

  const profile = makeProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  });

  const nameBelow = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.79), product: f(null, 0.99), strength: f("5 mg", 0.95), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(nameBelow.level, "unsure");
  assert.equal(nameBelow.matchedMedId, "aml");
  assert.ok(nameBelow.reasons.some((r) => r.includes("identity not confident")));

  const nameAt = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.8), strength: f("5 mg", 0.95), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(nameAt.level, "match");

  const readBelow = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), readability: 0.49, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(readBelow.level, "unsure");
  assert.equal(readBelow.matchedMedId, "aml");

  const readAt = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), readability: 0.5, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(readAt.level, "match");

  const strengthBelow = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.9), strength: f("5 mg", 0.79), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(strengthBelow.level, "unsure");
  assert.equal(strengthBelow.matchedMedId, "aml");
  assert.ok(strengthBelow.reasons.some((r) => r.includes("strength confidence 0.79 < 0.8")));

  const wrongStrengthBelow = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.9), strength: f("10 mg", 0.79), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(wrongStrengthBelow.level, "unsure");

  const strengthAt = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.9), strength: f("5 mg", 0.8), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(strengthAt.level, "match");

  const wrongStrengthAt = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.9), strength: f("10 mg", 0.8), readability: 0.9, expiry: f("2027-08") }),
    profile,
    NOW,
  );
  assert.equal(wrongStrengthAt.level, "warning");
});

test("Nordic microgram units mikrog, ug, µg, and mcg normalise consistently", () => {
  assert.ok(sameStrength("50 mikrog", "50 mcg"));
  assert.ok(sameStrength("50 µg", "0.05 mg"));
  assert.ok(sameStrength("100 ug", "100 microgram"));
  assert.ok(!sameStrength("50 mikrog", "50 mg"));
  assert.deepEqual(parseStrength("50 mikrog"), [{ amount: 0.05, unit: "mg" }]);
  assert.equal(norm("Burana® 400 mg kalvopäällysteinen"), "burana 400 mg kalvopaallysteinen");
});

test("headline <= 8 words and speech <= 2 sentences invariants hold across clamp helpers and all verdict paths", () => {
  assert.equal(clampHeadline("  one two three four five six seven eight  "), "one two three four five six seven eight");
  assert.equal(
    clampHeadline("Warning: one, two, three, four, five, six, seven, eight, nine"),
    "Warning: one, two, three, four, five, six, seven",
  );
  assert.equal(
    clampSpeech("This is 2.5 mg! Hold it closer? Ignore this third sentence. And fourth."),
    "This is 2.5 mg! Hold it closer?",
  );

  const verboseGuidance = "Move the package closer to the camera. Tilt it slightly toward the light. Ask a pharmacist if unsure.";
  const richProfile = makeProfile({
    meds: [
      {
        id: "combo",
        name: "Very Long Brand Name Extra Forte",
        ingredient: "amoxicillin trihydrate",
        strength: "875 mg",
        schedule: ["morning", "evening"],
      },
    ],
    allergies: ["maapähkinä", "hasselpähkinä", "laktoosi", "gluteeni", "seesami", "rikkidioksidi"],
    avoid: ["tulehduskipulääke"],
    doseLog: [
      { medId: "combo", ts: new Date(2026, 10, 14, 8, 0).getTime() },
      { medId: "combo", ts: new Date(2026, 10, 14, 19, 0).getTime() },
    ],
  });

  const scenarios: LabelRead[] = [
    makeRead({ kind: "unreadable", readability: 0.1, guidance: verboseGuidance }),
    makeRead({ product: f("Unknown Medicine Extra Long Title", 0.55), readability: 0.6, guidance: verboseGuidance }),
    makeRead({ product: f("Burana® Extra Strong Capsule Pack 400 mg"), strength: f("400 mg"), guidance: verboseGuidance }),
    makeRead({ ingredient: f("amoxicillin", 0.75), strength: f("875 mg", 0.95), readability: 0.45, guidance: verboseGuidance }),
    makeRead({ ingredient: f("amoxicillin", 0.95), strength: f("875 mg", 0.65), guidance: verboseGuidance }),
    makeRead({ ingredient: f("amoxicillin", 0.95), strength: f("500 mg", 0.95), guidance: verboseGuidance }),
    makeRead({ ingredient: f("amoxicillin", 0.95), strength: f("875 mg", 0.95), expiry: f("2024-03", 0.95) }),
    makeRead({ ingredient: f("amoxicillin", 0.95), strength: f("875 mg", 0.95), expiry: f(null, 0.1) }),
    makeRead({
      kind: "food",
      product: f("Artisanal Multi Grain Oat Hazelnut Sesame Crunch Biscuits"),
      allergens: f(["maapähkinä", "hasselpähkinä", "seesami", "gluteeni"]),
    }),
    makeRead({
      kind: "food",
      product: f("Artisanal Multi Grain Oat Hazelnut Sesame Crunch Biscuits"),
      allergens: f(["voi sisältää: maapähkinä", "voi sisältää: hasselpähkinä"]),
    }),
    makeRead({
      kind: "food",
      product: f("Artisanal Multi Grain Oat Biscuits With Unreadable Back Label"),
      allergens: f<string[]>(null, 0.2),
      guidance: verboseGuidance,
    }),
    makeRead({
      kind: "food",
      product: f("Artisanal Gluten Free Pure Oat Drink In One Litre Carton"),
      allergens: f(["kaura"], 0.95),
      expiry: f("2025-01-15", 0.95),
    }),
    makeRead({
      kind: "food",
      product: f("Artisanal Gluten Free Pure Oat Drink In One Litre Carton"),
      allergens: f(["kaura"], 0.95),
      expiry: f("2027-01-15", 0.95),
    }),
    makeRead({
      kind: "other",
      product: f("Moisturising Hand Cream With Extra Long Product Description"),
      expiry: f("2027-12", 0.9),
    }),
  ];

  for (const [idx, s] of scenarios.entries()) {
    const v = checkLabel(s, richProfile, NOW);
    assertOutputInvariants(v.headline, v.speech, `scenario-${idx}`);
  }
});
