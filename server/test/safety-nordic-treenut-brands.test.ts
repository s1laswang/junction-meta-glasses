import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { buildSceneVerdict, type RawItem } from "../src/find.ts";
import {
  allergenHits,
  allergyLabel,
  avoidHits,
  checkLabel,
  ingredientsOf,
  matchMed,
  productIngredientClash,
  spokenIngredient,
  unmappedAllergies,
} from "../src/safety.ts";

const NOW = new Date(2026, 10, 15, 20, 0, 0);
const MORNING = new Date(2026, 10, 15, 8, 30, 0);
const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function makeRead(partial: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2028-06", 0.95),
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

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertBounds(headline: string, speech: string, ctx: string): void {
  assert.ok(wordCount(headline) <= 8, `${ctx}: headline > 8 words: "${headline}"`);
  assert.ok(sentenceCount(speech) <= 2, `${ctx}: speech > 2 sentences: "${speech}"`);
}

test("English tree-nut profile warns on Finnish and Swedish literal tree-nut compounds and may-contain phrases", () => {
  const labelTerms = [
    "puupähkinä",
    "puupähkinät",
    "puupähkinöitä",
    "puupähkinää",
    "puupähkinän",
    "puupähkinöiden",
    "trädnöt",
    "trädnötter",
    "trädnötterna",
    "puupahkina",
    "puupahkinat",
    "puupahkinoita",
    "puupahkinaa",
    "puupahkinan",
    "tradnot",
    "tradnotter",
  ];

  for (const profileAllergy of ["tree nuts", "tree nut", "tree-nuts"]) {
    const prof = makeProfile({ allergies: [profileAllergy] });
    for (const term of labelTerms) {
      const read = makeRead({
        kind: "food",
        product: f("Myslipatukka"),
        allergens: f([term], 0.96),
      });
      const hits = allergenHits(read, prof.allergies);
      assert.equal(hits.length, 1, `${profileAllergy} x ${term}`);
      assert.equal(hits[0].allergy, profileAllergy);
      assert.equal(hits[0].found, term);
      assert.equal(hits[0].mayContain, false);

      const v = checkLabel(read, prof, NOW);
      assert.equal(v.level, "warning", `${profileAllergy} x ${term}`);
      assertBounds(v.headline, v.speech, `${profileAllergy}:${term}`);
    }

    const mayPhrases = [
      "Saattaa sisältää puupähkinöitä",
      "Voi sisältää puupähkinää",
      "Kan innehålla spår av trädnötter",
      "Kan innehalla tradnot",
    ];
    for (const phrase of mayPhrases) {
      const read = makeRead({
        kind: "food",
        product: f("Kaurakeksi"),
        allergens: f([phrase], 0.72),
      });
      const hits = allergenHits(read, prof.allergies);
      assert.equal(hits.length, 1, `${profileAllergy} x ${phrase}`);
      assert.equal(hits[0].mayContain, true, `${profileAllergy} x ${phrase}`);

      const v = checkLabel(read, prof, NOW);
      assert.equal(v.level, "warning", `${profileAllergy} x ${phrase}`);
      assert.match(v.headline, /^Warning: may contain /);
      assertBounds(v.headline, v.speech, `${profileAllergy}:${phrase}`);
    }
  }
});

test("Finnish and Swedish tree-nut profile entries map cleanly without unmapped-allergy abstention", () => {
  const nordicProfiles = [
    "puupähkinä",
    "puupähkinät",
    "puupähkinöitä",
    "puupähkinää",
    "puupahkina",
    "puupahkinat",
    "puupahkinoita",
    "puupahkinaa",
    "trädnöt",
    "trädnötter",
    "tradnot",
    "tradnotter",
    "puupähkinäallergia",
    "trädnötsallergi",
    "allergi mot trädnötter",
  ];

  assert.deepEqual(unmappedAllergies(nordicProfiles), []);
  assert.equal(allergyLabel("puupähkinät"), "puupähkinät");
  assert.equal(allergyLabel("trädnötter"), "trädnötter");

  for (const profTerm of nordicProfiles) {
    const prof = makeProfile({ allergies: [profTerm] });

    for (const nutLabel of ["hazelnut", "almond", "manteli", "hasselnöt", "puupähkinöitä", "trädnötter"]) {
      const v = checkLabel(
        makeRead({ kind: "food", product: f("Suklalevy"), allergens: f([nutLabel], 0.96) }),
        prof,
        NOW,
      );
      assert.equal(v.level, "warning", `${profTerm} -> ${nutLabel}`);
      assertBounds(v.headline, v.speech, `${profTerm}->${nutLabel}`);
    }

    const culinary = checkLabel(
      makeRead({
        kind: "food",
        product: f("Marsipaanipatukka"),
        ingredient: f("marsipaani, sokeri"),
        allergens: f(["soija"], 0.96),
      }),
      prof,
      NOW,
    );
    assert.equal(culinary.level, "warning", `${profTerm} -> culinary marsipaani`);
    assertBounds(culinary.headline, culinary.speech, `${profTerm}->marsipaani`);

    const safeOats = checkLabel(
      makeRead({ kind: "food", product: f("Kaurajuoma"), allergens: f(["kaura"], 0.97), readability: 0.94 }),
      prof,
      NOW,
    );
    assert.equal(safeOats.level, "info", `${profTerm} on safe oats should reassure as info`);
    assertBounds(safeOats.headline, safeOats.speech, `${profTerm}->oats`);
  }
});

test("peanut and literal Nordic tree-nut terms stay clinically distinct while generic nut allergies catch both", () => {
  const peanutOnly = makeProfile({ allergies: ["peanut"] });
  for (const treeNutOnlyLabel of ["puupähkinöitä", "puupähkinät", "trädnötter", "trädnöt"]) {
    const v = checkLabel(
      makeRead({ kind: "food", product: f("Murot"), allergens: f([treeNutOnlyLabel], 0.97), readability: 0.93 }),
      peanutOnly,
      NOW,
    );
    assert.equal(v.level, "info", `peanut-only profile must not warn on ${treeNutOnlyLabel}`);
  }

  for (const treeNutProfile of ["puupähkinät", "trädnötter"]) {
    const prof = makeProfile({ allergies: [treeNutProfile] });
    for (const peanutLabel of ["maapähkinä", "jordnötter", "peanuts"]) {
      const v = checkLabel(
        makeRead({ kind: "food", product: f("Keksi"), allergens: f([peanutLabel], 0.97), readability: 0.93 }),
        prof,
        NOW,
      );
      assert.equal(v.level, "info", `${treeNutProfile} must not warn on legume ${peanutLabel}`);
    }
  }

  for (const genericNut of ["pähkinä", "nötter"]) {
    const prof = makeProfile({ allergies: [genericNut] });
    for (const label of ["maapähkinä", "jordnötter", "puupähkinöitä", "trädnötter"]) {
      const v = checkLabel(
        makeRead({ kind: "food", product: f("Granola"), allergens: f([label], 0.96) }),
        prof,
        NOW,
      );
      assert.equal(v.level, "warning", `generic ${genericNut} must warn on ${label}`);
    }
  }
});

test("Swedish OTC brand Ipren resolves to ibuprofen across NSAID avoid, drug allergy, matchMed, and clash guards", () => {
  assert.equal(ingredientsOf("Ipren 400 mg filmdragerade tabletter").has("ibuprofen"), true);

  const occludedIpren = makeRead({
    product: f("Ipren 400 mg filmdragerade tabletter", 0.96),
    ingredient: f(null, 0.2),
    strength: f("400 mg", 0.96),
  });

  for (const avoidEntry of ["NSAIDs", "inflammationshämmande", "tulehduskipulääkkeet", "ibuprofen", "Ipren"]) {
    const hits = avoidHits(occludedIpren, [avoidEntry]);
    assert.equal(hits.length, 1, `avoidHits Ipren x ${avoidEntry}`);

    const v = checkLabel(
      occludedIpren,
      makeProfile({
        meds: [{ id: "aml", name: "Amlodipin", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
        avoid: [avoidEntry],
      }),
      NOW,
    );
    assert.equal(v.level, "warning", `checkLabel Ipren x ${avoidEntry}`);
    assert.match(v.speech, /avoid/i);
    assertBounds(v.headline, v.speech, `ipren:${avoidEntry}`);
  }

  const savedIbuProf = makeProfile({
    meds: [{ id: "ibu", name: "Ibuprofen", ingredient: "ibuprofen", strength: "400 mg", schedule: ["evening"] }],
    allergies: ["NSAIDs"],
  });
  const allergyVerdict = checkLabel(occludedIpren, savedIbuProf, NOW);
  assert.equal(allergyVerdict.level, "warning");
  assert.match(allergyVerdict.speech, /allergy/i);
  assertBounds(allergyVerdict.headline, allergyVerdict.speech, "ipren:allergy");

  const matchProf = makeProfile({
    meds: [{ id: "ibu", name: "Ibuprofen", ingredient: "ibuprofen", strength: "400 mg", schedule: ["evening"] }],
  });
  assert.equal(matchMed(occludedIpren, matchProf.meds)?.id, "ibu");
  assert.equal(checkLabel(occludedIpren, matchProf, NOW).level, "match");

  const wrongStrengthIpren = makeRead({
    product: f("Ipren 200 mg", 0.96),
    ingredient: f(null, 0.2),
    strength: f("200 mg", 0.96),
  });
  assert.equal(checkLabel(wrongStrengthIpren, matchProf, NOW).level, "warning");

  assert.equal(
    productIngredientClash(
      makeRead({ product: f("Ipren 400 mg", 0.95), ingredient: f("ibuprofen", 0.95), strength: f("400 mg") }),
      matchProf,
    ),
    undefined,
  );
  const clashRead = makeRead({
    product: f("Ipren 400 mg", 0.95),
    ingredient: f("amlodipine", 0.95),
    strength: f("5 mg", 0.95),
  });
  const amlProf = makeProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  });
  assert.deepEqual(productIngredientClash(clashRead, amlProf), { product: "ibuprofen", ingredient: "amlodipine" });
  assert.equal(checkLabel(clashRead, amlProf, NOW).level, "unsure");
});

test("unspaced Nordic salt compounds strip cleanly, match base INNs without clash, and preserve LASA isolation", () => {
  const saltPairs: Array<[string, string, string]> = [
    ["bisoprololifumaraatti", "bisoprololi", "bisoprolol"],
    ["bisoprololfumarat", "bisoprolol", "bisoprolol"],
    ["metoprololsuccinat", "metoprolol", "metoprolol"],
    ["metoprololitartraatti", "metoprololi", "metoprolol"],
    ["metoprololisuksinaatti", "metoprololi", "metoprolol"],
    ["metoprololtartrat", "metoprolol", "metoprolol"],
    ["amlodipiinibesilaatti", "amlodipiini", "amlodipine"],
    ["amlodipinbesilat", "amlodipin", "amlodipine"],
  ];

  for (const [compound, expectedSpoken, expectedInn] of saltPairs) {
    assert.equal(spokenIngredient(compound), expectedSpoken, `lower: ${compound}`);
    assert.equal(spokenIngredient(compound.toUpperCase()), expectedSpoken.toUpperCase(), `upper: ${compound}`);
    const capCompound = compound[0].toUpperCase() + compound.slice(1);
    const capSpoken = expectedSpoken[0].toUpperCase() + expectedSpoken.slice(1);
    assert.equal(spokenIngredient(capCompound), capSpoken, `title: ${compound}`);
    assert.equal(ingredientsOf(compound).has(expectedInn), true, `ingredientsOf(${compound}) -> ${expectedInn}`);
  }

  assert.equal(spokenIngredient("hydrochlorothiazide"), "hydrochlorothiazide");
  assert.equal(spokenIngredient("bromocriptine"), "bromocriptine");
  assert.equal(spokenIngredient("sulfasalazine"), "sulfasalazine");
  assert.equal(spokenIngredient("ferrofumaraatti"), "ferrofumaraatti");

  const bisMed: Med = { id: "bis", name: "Emconcor", ingredient: "bisoprolol", strength: "5 mg", schedule: ["morning"] };
  const metoMed: Med = { id: "meto", name: "Seloken ZOC", ingredient: "metoprolol", strength: "50 mg", schedule: ["morning"] };
  const bisProf = makeProfile({ meds: [bisMed] });
  const metoProf = makeProfile({ meds: [metoMed] });

  for (const [prod, ing] of [
    ["Emconcor 5 mg tabletti", "bisoprololifumaraatti"],
    ["Bisoprolol Krka 5 mg filmdragerade tabletter", "bisoprololfumarat"],
  ] as const) {
    const r = makeRead({ product: f(prod, 0.96), ingredient: f(ing, 0.96), strength: f("5 mg", 0.96) });
    assert.equal(productIngredientClash(r, bisProf), undefined, `no clash on ${prod} + ${ing}`);
    const vMatch = checkLabel(r, bisProf, MORNING);
    assert.equal(vMatch.level, "match", `${prod} (${ing}) should match saved bisoprolol`);
    assert.equal(vMatch.matchedMedId, "bis");
    assertBounds(vMatch.headline, vMatch.speech, `${prod}:match`);

    const vLasa = checkLabel(makeRead({ product: f(prod), ingredient: f(ing), strength: f("50 mg") }), metoProf, MORNING);
    assert.equal(vLasa.level, "warning", `${ing} must never match saved metoprolol`);
    assert.equal(vLasa.matchedMedId, undefined);
    assertBounds(vLasa.headline, vLasa.speech, `${ing}:vs:metoprolol`);
  }

  for (const [prod, ing] of [
    ["Seloken ZOC 50 mg depottabletter", "metoprololsuccinat"],
    ["Metoprolol Orion 50 mg tabletti", "metoprololitartraatti"],
    ["Metoprolol Ratiopharm 50 mg depottabletti", "metoprololisuksinaatti"],
  ] as const) {
    const r = makeRead({ product: f(prod, 0.96), ingredient: f(ing, 0.96), strength: f("50 mg", 0.96) });
    assert.equal(productIngredientClash(r, metoProf), undefined, `no clash on ${prod} + ${ing}`);
    const vMatch = checkLabel(r, metoProf, MORNING);
    assert.equal(vMatch.level, "match", `${prod} (${ing}) should match saved metoprolol`);
    assert.equal(vMatch.matchedMedId, "meto");
    assertBounds(vMatch.headline, vMatch.speech, `${prod}:match`);

    const vLasa = checkLabel(makeRead({ product: f(prod), ingredient: f(ing), strength: f("5 mg") }), bisProf, MORNING);
    assert.equal(vLasa.level, "warning", `${ing} must never match saved bisoprolol`);
    assert.equal(vLasa.matchedMedId, undefined);
    assertBounds(vLasa.headline, vLasa.speech, `${ing}:vs:bisoprolol`);
  }

  const fiSavedBis = makeProfile({
    meds: [{ id: "bis-fi", name: "Bisoprolol Orion", ingredient: "bisoprololifumaraatti", strength: "5 mg", schedule: ["morning"] }],
  });
  const enHeldBis = makeRead({ product: f("Bisoprolol Teva 5 mg"), ingredient: f("bisoprolol fumarate"), strength: f("5 mg") });
  const revMatch = checkLabel(enHeldBis, fiSavedBis, MORNING);
  assert.equal(revMatch.level, "match");
  assert.doesNotMatch(revMatch.speech, /fumaraatti/i);
  assertBounds(revMatch.headline, revMatch.speech, "reverse-fi-saved-bisoprolol");

  const crossBetaClash = makeRead({
    product: f("Emconcor 5 mg", 0.95),
    ingredient: f("metoprololisuksinaatti", 0.95),
    strength: f("5 mg", 0.95),
  });
  assert.deepEqual(productIngredientClash(crossBetaClash, bisProf), {
    product: "bisoprolol",
    ingredient: "metoprolol",
  });
  assert.equal(checkLabel(crossBetaClash, bisProf, MORNING).level, "unsure");

  const sceneItems: RawItem[] = [
    {
      box: [100, 100, 400, 350],
      read: makeRead({ product: f("Seloken ZOC 50 mg"), ingredient: f("metoprololsuccinat"), strength: f("50 mg") }),
      answers: false,
    },
    {
      box: [100, 600, 400, 850],
      read: makeRead({ product: f("Emconcor 5 mg"), ingredient: f("bisoprololifumaraatti"), strength: f("5 mg") }),
      answers: true,
    },
  ];
  const sceneVerdict = buildSceneVerdict(sceneItems, bisProf, undefined, MORNING);
  assert.doesNotMatch(sceneVerdict.speech, /succinat|fumaraatti/i);
  assertBounds(sceneVerdict.headline, sceneVerdict.speech, "scene-nordic-salts");
});
