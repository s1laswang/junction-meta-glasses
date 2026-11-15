import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Behavior, Modality, Type, type Session } from "@google/genai";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub } from "../src/hub.ts";
import { LiveProxy, TOOLS } from "../src/live.ts";
import { allergenHits, checkLabel, isExpired, monthYear, sayDate } from "../src/safety.ts";

const originalQuiet = process.env.HOLDUP_QUIET;
const originalLedgerPath = env.ledgerPath;
const originalConnect = (ai.live as any).connect;
process.env.HOLDUP_QUIET = "1";

const tempDirs: string[] = [];

function useTempLedger(): void {
  const root = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, "holdup-f4-loc-"));
  tempDirs.push(dir);
  env.ledgerPath = path.join(dir, "ledger.jsonl");
}

afterEach(() => {
  (ai.live as any).connect = originalConnect;
  env.ledgerPath = originalLedgerPath;
});

after(async () => {
  (ai.live as any).connect = originalConnect;
  env.ledgerPath = originalLedgerPath;
  await new Promise((r) => setTimeout(r, 30));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  if (originalQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = originalQuiet;
});

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function makeRead(partial: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f(null, 0),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...partial,
  };
}

function makeProfile(partial: Partial<Profile> = {}): Profile {
  return {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...partial,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;

test("all EU allergen groups match English, Finnish, and Swedish label terms including Nordic diacritics", () => {
  const matrix: Array<{ allergy: string; terms: string[] }> = [
    {
      allergy: "peanut",
      terms: ["peanut", "peanuts", "arachis", "groundnut", "groundnuts", "maapahkina", "maapähkinä", "jordnot", "jordnöt"],
    },
    {
      allergy: "tree nut",
      terms: [
        "tree nut", "tree nuts", "hazelnut", "almond", "cashew", "walnut", "pecan", "pistachio",
        "brazil nut", "macadamia", "manteli", "hasselpahkina", "cashewpahkina", "saksanpahkina",
        "pekaanipahkina", "hasselnot", "hasselnöt", "mandel", "valnot", "pahkina", "pahkinoita",
      ],
    },
    {
      allergy: "milk",
      terms: ["milk", "lactose", "whey", "casein", "caseinate", "butter", "cream", "dairy", "maito", "laktoosi", "hera", "mjolk", "mjölk"],
    },
    {
      allergy: "gluten",
      terms: ["gluten", "wheat", "barley", "rye", "spelt", "wheat starch", "vehna", "vehnä", "ohra", "ruis", "gluteeni", "vete"],
    },
    {
      allergy: "egg",
      terms: ["egg", "eggs", "albumin", "kananmuna", "muna", "agg", "ägg"],
    },
    {
      allergy: "soy",
      terms: ["soy", "soya", "soja", "soybean", "soya oil", "soija", "soijaoljy", "soijaöljy"],
    },
    {
      allergy: "sesame",
      terms: ["sesame", "tahini", "seesami", "sesam"],
    },
    {
      allergy: "fish",
      terms: ["fish", "anchovy", "cod", "salmon", "kala", "fisk"],
    },
    {
      allergy: "crustacean",
      terms: ["crustacean", "crustaceans", "shellfish", "shrimp", "prawn", "crab", "lobster", "katkarapu", "ayriaiset", "äyriäiset"],
    },
    {
      allergy: "mustard",
      terms: ["mustard", "sinappi", "senap"],
    },
    {
      allergy: "celery",
      terms: ["celery", "selleri"],
    },
    {
      allergy: "lupin",
      terms: ["lupin", "lupiini"],
    },
    {
      allergy: "sulphite",
      terms: ["sulphite", "sulphites", "sulfite", "sulfites", "sulphur dioxide", "sulfur dioxide", "rikkidioksidi", "rikkidioksidia", "sulfiitti", "svaveldioxid", "sulfiter"],
    },
    {
      allergy: "molluscs",
      terms: ["molluscs", "nilviaiset", "nilviaisia", "simpukka", "blotdjur", "musslor"],
    },
  ];

  for (const { allergy, terms } of matrix) {
    const prof = makeProfile({ allergies: [allergy] });
    for (const term of terms) {
      const label = makeRead({ kind: "food", product: f("Snack pack"), allergens: f([term], 0.9) });
      const hits = allergenHits(label, [allergy]);
      assert.equal(hits.length, 1, `Expected ${allergy} to match ${term}`);
      assert.equal(hits[0].allergy, allergy);
      assert.equal(hits[0].found, term);
      assert.equal(hits[0].mayContain, false);

      const verdict = checkLabel(label, prof, NOW);
      assert.equal(verdict.level, "warning", `Expected warning for ${allergy} -> ${term}`);
      assert.ok(wordCount(verdict.headline) <= 8);
      assert.ok(sentenceCount(verdict.speech) <= 2);
      assert.ok(verdict.reasons.includes(`contains ${term} (allergy: ${allergy})`));
    }
  }

  assert.equal(allergenHits(makeRead({ kind: "food", allergens: f(["eggplant", "nutmeg", "butternut squash", "coconut"]) }), ["egg", "tree nut", "milk"]).length, 0);

  const crossLangPairs: Array<[string, string]> = [
    ["kananmuna", "ägg"],
    ["senap", "sinappi"],
    ["katkarapu", "shrimp"],
    ["seesami", "tahini"],
    ["rikkidioksidi", "sulfur dioxide"],
  ];
  for (const [profileTerm, labelTerm] of crossLangPairs) {
    const hits = allergenHits(makeRead({ kind: "food", allergens: f([labelTerm]) }), [profileTerm]);
    assert.equal(hits.length, 1, `Expected profile ${profileTerm} to match label ${labelTerm}`);
    assert.equal(hits[0].found, labelTerm);
  }
});

test("Nordic multi-word ingredient phrases and food allergen confidence thresholds (0.29, 0.30, 0.59, 0.60, 0.94, 0.95)", () => {
  const phraseCases: Array<{ phrase: string; allergy: string }> = [
    { phrase: "sisaltaa maapahkina ja hera", allergy: "peanut" },
    { phrase: "voi sisaltaa maapahkinaa ja maitoa", allergy: "milk" },
    { phrase: "saattaa sisaltaa hasselpahkinaa tai mantelia", allergy: "tree nut" },
    { phrase: "innehaller jordnot och mjolk", allergy: "milk" },
    { phrase: "kan innehalla jordnotter, hasselnotter och mandlar", allergy: "tree nut" },
    { phrase: "innehaller kornmalt, ragmjol och vetestarkelse", allergy: "gluten" },
    { phrase: "vehna (gluteeni), ruis", allergy: "gluten" },
    { phrase: "ayriaiset (katkarapu)", allergy: "crustacean" },
    { phrase: "innehaller kraftdjur (rakor) och blotdjur (musslor)", allergy: "molluscs" },
    { phrase: "kananmuna, sinappi ja selleri", allergy: "mustard" },
    { phrase: "kananmunaa, sinappia, selleria ja seesaminsiemenia", allergy: "sesame" },
  ];
  for (const c of phraseCases) {
    const v = checkLabel(
      makeRead({ kind: "food", product: f("Valmisruoka"), allergens: f([c.phrase], 0.85) }),
      makeProfile({ allergies: [c.allergy] }),
      NOW,
    );
    assert.equal(v.level, "warning");
  }

  const prof = makeProfile({ allergies: ["peanut", "sesame"] });
  const at030 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["maapahkina"], 0.3) }), prof, NOW);
  assert.equal(at030.level, "warning");

  const at029 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["maapahkina"], 0.29) }), prof, NOW);
  assert.equal(at029.level, "unsure");
  assert.ok(at029.reasons.includes("allergen panel not readable"));

  const safeAt059 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["oats"], 0.59) }), prof, NOW);
  assert.equal(safeAt059.level, "unsure");
  assert.equal(safeAt059.headline, "Can't read the allergens yet");

  const safeAt060 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["oats"], 0.6) }), prof, NOW);
  assert.equal(safeAt060.level, "unsure");
  assert.equal(safeAt060.headline, "Not sure it's free of your allergens");
  assert.ok(safeAt060.reasons.includes("allergen panel may be incomplete"));

  const safeAt094 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["oats"], 0.94) }), prof, NOW);
  assert.equal(safeAt094.level, "unsure");
  assert.ok(safeAt094.reasons.includes("allergen panel may be incomplete"));

  const safeAt095 = checkLabel(makeRead({ kind: "food", product: f("Bar"), allergens: f(["oats"], 0.95) }), prof, NOW);
  assert.equal(safeAt095.level, "info");
  assert.equal(safeAt095.headline, "Bar: none of your allergens");
  assert.equal(safeAt095.speech, "Bar: no peanut and sesame listed.");
});

test("allergyBases conservative expansions cover nut/pahkina, celiac/coeliac, lactose/dairy, and shellfish", () => {
  for (const nutProfile of ["nut allergy", "nuts", "nut allergic", "nut allergies", "pahkina", "pähkinä", "pahkinat", "pähkinät"]) {
    const prof = makeProfile({ allergies: [nutProfile] });
    for (const peanutTerm of ["maapahkina", "jordnot", "arachis"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Granola"), allergens: f([peanutTerm]) }), prof, NOW);
      assert.equal(v.level, "warning", `Expected ${nutProfile} to match peanut term ${peanutTerm}`);
      assert.match(v.speech, new RegExp(peanutTerm));
    }
    for (const treeNutTerm of ["manteli", "hasselnot", "almond"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Granola"), allergens: f([treeNutTerm]) }), prof, NOW);
      assert.equal(v.level, "warning", `Expected ${nutProfile} to match tree nut term ${treeNutTerm}`);
      assert.match(v.speech, new RegExp(treeNutTerm));
    }
  }

  const peanutOnly = makeProfile({ allergies: ["peanut allergy"] });
  assert.equal(checkLabel(makeRead({ kind: "food", product: f("Paste"), allergens: f(["maapahkina"]) }), peanutOnly, NOW).level, "warning");
  assert.equal(checkLabel(makeRead({ kind: "food", product: f("Paste"), allergens: f(["manteli"]) }), peanutOnly, NOW).level, "info");

  const treeNutOnly = makeProfile({ allergies: ["tree nut allergy"] });
  assert.equal(checkLabel(makeRead({ kind: "food", product: f("Paste"), allergens: f(["hasselnot"]) }), treeNutOnly, NOW).level, "warning");
  assert.equal(checkLabel(makeRead({ kind: "food", product: f("Paste"), allergens: f(["jordnot"]) }), treeNutOnly, NOW).level, "info");

  for (const glutenWording of ["celiac", "coeliac", "celiac allergy", "wheat"]) {
    for (const grain of ["vehna", "ruis", "vete", "ohra", "spelt"]) {
      const hits = allergenHits(makeRead({ kind: "food", allergens: f([grain]) }), [glutenWording]);
      assert.equal(hits.length, 1, `Expected ${glutenWording} -> ${grain}`);
      assert.equal(hits[0].allergy, glutenWording);
    }
  }

  for (const milkWording of ["lactose", "dairy", "dairy allergy", "maito"]) {
    for (const dairyTerm of ["hera", "mjolk", "whey", "casein", "laktoosi"]) {
      const hits = allergenHits(makeRead({ kind: "food", allergens: f([dairyTerm]) }), [milkWording]);
      assert.equal(hits.length, 1, `Expected ${milkWording} -> ${dairyTerm}`);
      assert.equal(hits[0].allergy, milkWording);
    }
  }

  for (const shellfishWording of ["shellfish", "shellfish allergy", "crustaceans"]) {
    for (const crustTerm of ["katkarapu", "ayriaiset", "shrimp", "lobster"]) {
      const hits = allergenHits(makeRead({ kind: "food", allergens: f([crustTerm]) }), [shellfishWording]);
      assert.equal(hits.length, 1, `Expected ${shellfishWording} -> ${crustTerm}`);
      assert.equal(hits[0].allergy, shellfishWording);
    }
  }

  const medExcipientVerdict = checkLabel(
    makeRead({
      kind: "medication",
      ingredient: f("amlodipine", 0.96),
      strength: f("5 mg", 0.95),
      allergens: f(["laktoosi"], 0.15),
    }),
    makeProfile({
      meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
      allergies: ["dairy"],
    }),
    NOW,
  );
  assert.equal(medExcipientVerdict.level, "warning");
  assert.equal(medExcipientVerdict.matchedMedId, "aml");
  assert.match(medExcipientVerdict.speech, /contains laktoosi\. Your profile lists an allergy to dairy\./);
});

test("mayContain detection across en/fi/sv/traces and mixed contains + mayContain ordering with listAnd deduplication", () => {
  const mayVariants: Array<{ raw: string; allergy: string; expectedFound: string }> = [
    { raw: "may contain: maapahkina", allergy: "peanut", expectedFound: "maapahkina" },
    { raw: "May contain seesami", allergy: "sesame", expectedFound: "May contain seesami" },
    { raw: "voi sisaltaa manteli", allergy: "tree nut", expectedFound: "voi sisaltaa manteli" },
    { raw: "Saattaa sisältää maapähkinää", allergy: "peanut", expectedFound: "Saattaa sisältää maapähkinää" },
    { raw: "Voi sisältää pähkinän jäämiä", allergy: "tree nut", expectedFound: "Voi sisältää pähkinän jäämiä" },
    { raw: "Voi sisältää vehnää ja ruis", allergy: "gluten", expectedFound: "Voi sisältää vehnää ja ruis" },
    { raw: "kan innehalla hasselnot", allergy: "tree nut", expectedFound: "kan innehalla hasselnot" },
    { raw: "Kan innehålla spår av jordnötter", allergy: "peanut", expectedFound: "Kan innehålla spår av jordnötter" },
    { raw: "Kan innehålla mjölk", allergy: "milk", expectedFound: "Kan innehålla mjölk" },
    { raw: "traces of lupiini", allergy: "lupin", expectedFound: "traces of lupiini" },
    { raw: "trace of agg", allergy: "egg", expectedFound: "trace of agg" },
  ];

  for (const item of mayVariants) {
    const label = makeRead({ kind: "food", product: f("Biscuit"), allergens: f([item.raw], 0.9) });
    const hits = allergenHits(label, [item.allergy]);
    assert.equal(hits.length, 1, `Expected hit for ${item.raw}`);
    assert.equal(hits[0].mayContain, true);
    assert.equal(hits[0].found, item.expectedFound);

    const verdict = checkLabel(label, makeProfile({ allergies: [item.allergy] }), NOW);
    assert.equal(verdict.level, "warning");
    assert.match(verdict.headline, /^Warning: may contain /);
    assert.match(verdict.speech, /^Warning: Biscuit may contain /);
    assert.ok(wordCount(verdict.headline) <= 8);
    assert.ok(sentenceCount(verdict.speech) <= 2);
  }

  const mixedLabel = makeRead({
    kind: "food",
    product: f("Muesli bar"),
    allergens: f(["may contain: maapahkina", "hera", "sinappi"], 0.95),
  });
  const mixedProfile = makeProfile({ allergies: ["peanut", "milk", "mustard"] });
  const mixedVerdict = checkLabel(mixedLabel, mixedProfile, NOW);
  assert.equal(mixedVerdict.level, "warning");
  assert.equal(mixedVerdict.headline, "Warning: contains hera");
  assert.equal(
    mixedVerdict.speech,
    "Warning: Muesli bar contains hera and sinappi. Your profile lists an allergy to peanut, milk and mustard.",
  );
  assert.deepEqual(mixedVerdict.reasons, [
    "may contain maapahkina (allergy: peanut)",
    "contains hera (allergy: milk)",
    "contains sinappi (allergy: mustard)",
  ]);

  const sharedBaseVerdict = checkLabel(
    makeRead({ kind: "food", product: f("Cream soup"), allergens: f(["mjolk"], 0.95) }),
    makeProfile({ allergies: ["lactose", "dairy"] }),
    NOW,
  );
  assert.equal(sharedBaseVerdict.headline, "Warning: contains mjolk");
  assert.equal(
    sharedBaseVerdict.speech,
    "Warning: Cream soup contains mjolk. Your profile lists an allergy to lactose and dairy.",
  );

  const dupProfileVerdict = checkLabel(
    makeRead({ kind: "food", product: f("Salad dressing"), allergens: f(["senap"], 0.95) }),
    makeProfile({ allergies: ["mustard", "mustard"] }),
    NOW,
  );
  assert.equal(
    dupProfileVerdict.speech,
    "Warning: Salad dressing contains senap. Your profile lists an allergy to mustard.",
  );

  const threeMayVerdict = checkLabel(
    makeRead({
      kind: "food",
      product: f("Seed cracker"),
      allergens: f(["may contain: seesami", "may contain: selleri", "may contain: lupiini"], 0.95),
    }),
    makeProfile({ allergies: ["sesame", "celery", "lupin"] }),
    NOW,
  );
  assert.equal(threeMayVerdict.headline, "Warning: may contain seesami");
  assert.equal(
    threeMayVerdict.speech,
    "Warning: Seed cracker may contain seesami, selleri and lupiini. Your profile lists an allergy to sesame, celery and lupin.",
  );
});

test("scheduleWord clock-time bucket boundaries, noon/bedtime slots, and multi-slot dose counts in checkLabel", () => {
  const clockCases: Array<[string, string]> = [
    ["00:00", "morning"],
    ["8:15", "morning"],
    ["10:59", "morning"],
    ["11:00", "midday"],
    ["14:59", "midday"],
    ["15:00", "evening"],
    ["20:59", "evening"],
    ["21:00", "night"],
    ["23:59", "night"],
    ["noon", "noon"],
    ["bedtime", "bedtime"],
  ];

  const amlRead = makeRead({
    ingredient: f("amlodipine", 0.96),
    strength: f("5 mg", 0.95),
    expiry: f("2027-08", 0.92),
  });

  for (const [slot, expectedBucket] of clockCases) {
    const med: Med = { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: [slot] };
    const verdict = checkLabel(amlRead, makeProfile({ meds: [med] }), NOW);
    assert.equal(verdict.level, "match", `Failed for slot ${slot}`);
    assert.equal(verdict.headline, `Yes: Amlodipine 5 mg, your ${expectedBucket} pill`);
    assert.equal(verdict.speech, `Yes, Amlodipine 5 mg, your ${expectedBucket} pill. You haven't taken it today.`);
    assert.ok(wordCount(verdict.headline) <= 8);
    assert.ok(sentenceCount(verdict.speech) <= 2);
  }

  const multiMed: Med = {
    id: "met",
    name: "Metformin",
    ingredient: "metformin",
    strength: "500 mg",
    schedule: ["08:00", "20:00"],
  };
  const metRead = makeRead({
    ingredient: f("metformin", 0.96),
    strength: f("500 mg", 0.95),
    expiry: f("2027-08", 0.92),
  });

  const zeroTaken = checkLabel(metRead, makeProfile({ meds: [multiMed], doseLog: [] }), NOW);
  assert.equal(zeroTaken.level, "match");
  assert.equal(zeroTaken.takenToday, false);
  assert.equal(zeroTaken.headline, "Yes: Metformin 500 mg");
  assert.equal(zeroTaken.speech, "Yes, Metformin 500 mg, on your list. You haven't taken it today.");
  assert.ok(zeroTaken.reasons.includes("taken today: 0/2"));

  const oneTaken = checkLabel(
    metRead,
    makeProfile({
      meds: [multiMed],
      doseLog: [{ medId: "met", ts: new Date(2026, 10, 14, 8, 10, 0).getTime() }],
    }),
    NOW,
  );
  assert.equal(oneTaken.level, "match");
  assert.equal(oneTaken.takenToday, true);
  assert.equal(oneTaken.headline, "Yes: Metformin 500 mg");
  assert.equal(oneTaken.speech, "Yes, Metformin 500 mg, on your list. You've taken 1 of 2 doses today.");
  assert.ok(oneTaken.reasons.includes("taken today: 1/2"));

  const twoTaken = checkLabel(
    metRead,
    makeProfile({
      meds: [multiMed],
      doseLog: [
        { medId: "met", ts: new Date(2026, 10, 14, 8, 10, 0).getTime() },
        { medId: "met", ts: new Date(2026, 10, 14, 19, 45, 0).getTime() },
      ],
    }),
    NOW,
  );
  assert.equal(twoTaken.level, "warning");
  assert.equal(twoTaken.takenToday, true);
  assert.equal(twoTaken.headline, "Metformin 500 mg: already taken today");
  assert.equal(twoTaken.speech, "This is Metformin 500 mg, on your list. You already took it today, 2 times.");
  assert.ok(twoTaken.reasons.includes("taken today: 2/2"));

  const asNeededMed: Med = { id: "prn", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: [] };
  const prnVerdict = checkLabel(
    makeRead({ ingredient: f("paracetamol", 0.96), strength: f("500 mg", 0.95), expiry: f("2027-08", 0.92) }),
    makeProfile({ meds: [asNeededMed] }),
    NOW,
  );
  assert.equal(prnVerdict.level, "match");
  assert.equal(prnVerdict.headline, "Yes: Paracetamol 500 mg");
  assert.equal(prnVerdict.speech, "Yes, Paracetamol 500 mg, on your list. You haven't taken it today.");
});

test("calendar and leap-year boundaries for isExpired, sayDate, and monthYear", () => {
  const feb28NonLeapEnd = new Date(2026, 1, 28, 23, 59, 59);
  const mar1NonLeapStart = new Date(2026, 2, 1, 0, 0, 0);
  assert.equal(isExpired("2026-02", feb28NonLeapEnd), false);
  assert.equal(isExpired("2026-02-28", feb28NonLeapEnd), false);
  assert.equal(isExpired("2026-02", mar1NonLeapStart), true);
  assert.equal(isExpired("2026-02-28", mar1NonLeapStart), true);

  const feb28LeapEnd = new Date(2028, 1, 28, 23, 59, 59);
  const feb29LeapStart = new Date(2028, 1, 29, 0, 0, 0);
  const feb29LeapEnd = new Date(2028, 1, 29, 23, 59, 59);
  const mar1LeapStart = new Date(2028, 2, 1, 0, 0, 0);
  assert.equal(isExpired("2028-02", feb28LeapEnd), false);
  assert.equal(isExpired("2028-02-28", feb28LeapEnd), false);
  assert.equal(isExpired("2028-02-28", feb29LeapStart), true);
  assert.equal(isExpired("2028-02", feb29LeapStart), false);
  assert.equal(isExpired("2028-02-29", feb29LeapStart), false);
  assert.equal(isExpired("2028-02", feb29LeapEnd), false);
  assert.equal(isExpired("2028-02-29", feb29LeapEnd), false);
  assert.equal(isExpired("2028-02", mar1LeapStart), true);
  assert.equal(isExpired("2028-02-29", mar1LeapStart), true);

  assert.equal(isExpired("2100-02", new Date(2100, 1, 28, 23, 59, 59)), false);
  assert.equal(isExpired("2100-02", new Date(2100, 2, 1, 0, 0, 0)), true);
  assert.equal(isExpired("2000-02", new Date(2000, 1, 29, 23, 59, 59)), false);
  assert.equal(isExpired("2000-02", new Date(2000, 2, 1, 0, 0, 0)), true);

  assert.equal(isExpired("2026-04", new Date(2026, 3, 30, 23, 59, 59)), false);
  assert.equal(isExpired("2026-04", new Date(2026, 4, 1, 0, 0, 0)), true);
  assert.equal(isExpired("2026-05", new Date(2026, 4, 30, 23, 59, 59)), false);
  assert.equal(isExpired("2026-05", new Date(2026, 4, 31, 23, 59, 59)), false);
  assert.equal(isExpired("2026-05", new Date(2026, 5, 1, 0, 0, 0)), true);
  assert.equal(isExpired("2026-12", new Date(2026, 11, 31, 23, 59, 59)), false);
  assert.equal(isExpired("2026-12", new Date(2027, 0, 1, 0, 0, 0)), true);

  assert.equal(isExpired(null, NOW), undefined);
  assert.equal(isExpired(undefined, NOW), undefined);
  assert.equal(isExpired("", NOW), undefined);
  assert.equal(isExpired("02/2026", NOW), undefined);

  assert.equal(sayDate("2026-02-28"), "28 February 2026");
  assert.equal(sayDate("2028-02-29"), "29 February 2028");
  assert.equal(sayDate("2026-05-04"), "4 May 2026");
  assert.equal(sayDate("2026-04"), "April 2026");
  assert.equal(sayDate("EXP 04/26"), "EXP 04/26");

  assert.equal(monthYear("2026-02-28"), "February 2026");
  assert.equal(monthYear("2028-02-29"), "February 2028");
  assert.equal(monthYear("2026-04"), "April 2026");
  assert.equal(monthYear("2026-05-31"), "May 2026");
  assert.equal(monthYear("EXP 05/26"), "EXP 05/26");
});

test("food past its date vs medication expired monthYear and unreadable expiry within 2-sentence cap", () => {
  const med: Med = { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["20:00"] };
  const medProfile = makeProfile({ meds: [med] });

  const expiredFood = checkLabel(
    makeRead({ kind: "food", product: f("Kaurajuoma"), allergens: f(["oats"], 0.95), expiry: f("2026-02-28", 0.9) }),
    makeProfile({ allergies: ["peanut"] }),
    new Date(2026, 2, 1, 0, 0, 0),
  );
  assert.equal(expiredFood.level, "warning");
  assert.equal(expiredFood.headline, "Kaurajuoma: past its date");
  assert.equal(expiredFood.speech, "Kaurajuoma was best before 28 February 2026.");
  assert.ok(expiredFood.reasons.includes("expired 2026-02-28"));

  const validLeapFood = checkLabel(
    makeRead({ kind: "food", product: f("Kaurajuoma"), allergens: f(["oats"], 0.95), expiry: f("2028-02-29", 0.9) }),
    makeProfile({ allergies: ["peanut"] }),
    new Date(2028, 1, 29, 23, 59, 59),
  );
  assert.equal(validLeapFood.level, "info");
  assert.equal(validLeapFood.headline, "Kaurajuoma: none of your allergens");
  assert.equal(validLeapFood.speech, "Kaurajuoma: no peanut listed. Best before 29 February 2028.");

  const expiredMedAt070 = checkLabel(
    makeRead({ ingredient: f("amlodipine", 0.96), strength: f("5 mg", 0.95), expiry: f("2026-04", 0.7) }),
    medProfile,
    new Date(2026, 4, 1, 0, 0, 0),
  );
  assert.equal(expiredMedAt070.level, "warning");
  assert.equal(expiredMedAt070.headline, "Amlodipine 5 mg: expired April 2026");
  assert.equal(
    expiredMedAt070.speech,
    "This is Amlodipine 5 mg, your medicine. This box expired in April 2026, so ask a pharmacist for a new one.",
  );
  assert.ok(wordCount(expiredMedAt070.headline) <= 8);
  assert.ok(sentenceCount(expiredMedAt070.speech) <= 2);

  // a low-confidence date in the past is now "unsure" (judge-panel probe 17), so use a future one here
  for (const unreadableExpiry of [f<string>(null, 0), f("2029-01", 0.69)]) {
    const v0 = checkLabel(
      makeRead({ ingredient: f("amlodipine", 0.96), strength: f("5 mg", 0.95), expiry: unreadableExpiry }),
      medProfile,
      NOW,
    );
    assert.equal(v0.level, "match");
    assert.equal(
      v0.speech,
      "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today, and I couldn't read the expiry date.",
    );
    assert.ok(v0.reasons.includes("expiry not readable"));
    assert.ok(sentenceCount(v0.speech) <= 2);
  }

  const twoSlotMed: Med = { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"] };
  const vPartial = checkLabel(
    makeRead({ ingredient: f("metformin", 0.96), strength: f("500 mg", 0.95), expiry: f(null, 0) }),
    makeProfile({ meds: [twoSlotMed], doseLog: [{ medId: "met", ts: new Date(2026, 10, 14, 8, 0, 0).getTime() }] }),
    NOW,
  );
  assert.equal(vPartial.level, "match");
  assert.equal(
    vPartial.speech,
    "Yes, Metformin 500 mg, on your list. You've taken 1 of 2 doses today, and I couldn't read the expiry date.",
  );
  assert.ok(sentenceCount(vPartial.speech) <= 2);
});

test("TOOLS declarations enforce verify_label, NON_BLOCKING show_cue enum, and log_dose medId contracts", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["verify_label", "show_cue", "log_dose"],
  );

  const verifyTool = TOOLS[0];
  assert.match(verifyTool.description ?? "", /word for word/);
  assert.match(verifyTool.description ?? "", /medicine name, strength, dose, expiry or allergens/);
  assert.equal(verifyTool.parameters?.type, Type.OBJECT);
  assert.equal(verifyTool.parameters?.properties?.question?.type, Type.STRING);
  assert.equal(verifyTool.parameters?.required, undefined);

  const cueTool = TOOLS[1];
  assert.equal(cueTool.behavior, Behavior.NON_BLOCKING);
  assert.deepEqual(cueTool.parameters?.required, ["cue", "text"]);
  assert.deepEqual(cueTool.parameters?.properties?.cue?.enum, [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok",
  ]);
  assert.equal(cueTool.parameters?.properties?.text?.type, Type.STRING);

  const logDoseTool = TOOLS[2];
  assert.deepEqual(logDoseTool.parameters?.required, ["medId"]);
  assert.equal(logDoseTool.parameters?.properties?.medId?.type, Type.STRING);
});

test("LiveProxy systemInstruction localizes all LANGS with unknown-code fallback and never leaks medicine strengths", async () => {
  useTempLedger();

  const capturedConfigs: any[] = [];
  (ai.live as any).connect = async (arg: any) => {
    capturedConfigs.push(arg.config);
    return {
      close() {},
      sendRealtimeInput() {},
      sendToolResponse() {},
    } as unknown as Session;
  };

  const expectedLangs: Array<[string, string]> = [
    ["en", "English"],
    ["fi", "Finnish"],
    ["sv", "Swedish"],
    ["de", "German"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["et", "Estonian"],
    ["ru", "Russian"],
    ["uk", "uk"],
    ["ja", "ja"],
  ];

  for (const [code, label] of expectedLangs) {
    const hub = new Hub(`loc-${code}`);
    hub.profile = {
      meds: [
        {
          id: "aml-1",
          name: "Norvasc",
          ingredient: "amlodipine",
          strength: "5 mg",
          schedule: ["08:00", "20:00"],
          barcode: "6432100099999",
          gtin: "06432100099999",
          notes: "private-cardio-note",
        },
        {
          id: "met-2",
          name: "metformin",
          ingredient: "metformin",
          strength: "850 mg",
          schedule: [],
        },
        {
          id: "levo-3",
          name: "Thyroxin",
          ingredient: "levothyroxine",
          strength: "125 mcg",
          schedule: ["morning"],
        },
      ],
      allergies: ["maapahkina", "mjolk"],
      avoid: ["NSAIDs", "simvastatin"],
      doseLog: [],
      lang: code,
    };

    const proxy = new LiveProxy(hub, { lang: code, voice: true });
    try {
      await proxy.start();
    } finally {
      proxy.stop("test");
      hub.dropFrames();
    }

    const cfg = capturedConfigs.at(-1);
    assert.ok(cfg);
    assert.deepEqual(cfg.responseModalities, [Modality.AUDIO]);
    assert.deepEqual(cfg.tools, [{ functionDeclarations: TOOLS }]);

    const sys = String(cfg.systemInstruction);
    assert.ok(sys.includes(`- Language: ${label}. Speak ${label}.`), `Missing language line for ${code}`);
    assert.ok(sys.includes("never read safety facts from your own vision"));
    assert.ok(sys.includes('- medId "aml-1": Norvasc (amlodipine), taken 08:00, 20:00'));
    assert.ok(sys.includes('- medId "met-2": metformin, taken as needed'));
    assert.ok(!sys.includes("metformin (metformin)"));
    assert.ok(sys.includes('- medId "levo-3": Thyroxin (levothyroxine), taken morning'));
    assert.ok(sys.includes("- Allergies: maapahkina, mjolk"));
    assert.ok(sys.includes("- Avoid: NSAIDs, simvastatin"));

    for (const leaked of ["5 mg", "5mg", "850 mg", "850mg", "850", "125 mcg", "125mcg", "125", "6432100099999", "06432100099999", "private-cardio-note"]) {
      assert.equal(sys.includes(leaked), false, `System instruction leaked ${leaked} for lang=${code}`);
    }
  }

  const emptyHub = new Hub("loc-empty");
  emptyHub.profile = makeProfile({ lang: "fi" });
  const emptyProxy = new LiveProxy(emptyHub, { lang: "fi", voice: false });
  try {
    await emptyProxy.start();
  } finally {
    emptyProxy.stop("test");
    emptyHub.dropFrames();
  }
  const emptySys = String(capturedConfigs.at(-1)?.systemInstruction);
  assert.ok(emptySys.includes("- Language: Finnish. Speak Finnish."));
  assert.ok(emptySys.includes("- none saved"));
  assert.ok(emptySys.includes("- Allergies: none saved"));
  assert.ok(emptySys.includes("- Avoid: nothing saved"));
});
