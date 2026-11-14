import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { allergenHits, allergyBases, avoidHits, checkLabel } from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

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
    readability: 0.95,
    ...partial,
  };
}

function makeProfile(partial: Partial<Profile> = {}): Profile {
  return {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "fi",
    ...partial,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertBounds(headline: string, speech: string, ctx: string): void {
  assert.ok(wordCount(headline) <= 8, `${ctx}: headline > 8 words: "${headline}"`);
  assert.ok(sentenceCount(speech) <= 2, `${ctx}: speech > 2 sentences: "${speech}"`);
}

test("allergyBases resolves Finnish and Swedish compound, hyphenated, and spaced profile allergies", () => {
  for (const w of [
    "maitoallergia",
    "maito-allergia",
    "maito allergia",
    "maitoallerginen",
    "maitoyliherkkyys",
    "laktoosi-intoleranssi",
    "laktoosiintoleranssi",
    "mjölkallergi",
    "mjölkallergisk",
    "laktos",
    "laktosintolerans",
  ]) {
    assert.deepEqual(allergyBases(w), ["milk"], w);
    const v = checkLabel(
      makeRead({ kind: "food", product: f("Suklaalevy"), allergens: f(["maitoa"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(v.level, "warning", w);
    assertBounds(v.headline, v.speech, w);
  }

  for (const w of [
    "pähkinäallergia",
    "pähkinä-allergia",
    "pähkinäallerginen",
    "nötallergi",
    "nötallergisk",
    "nöt",
    "nötter",
    "not",
    "notter",
  ]) {
    assert.deepEqual(allergyBases(w), ["peanut", "tree nut"], w);
    for (const labelTerm of ["maapähkinää", "jordnötter", "hasselpähkinää", "mandlar"]) {
      const v = checkLabel(
        makeRead({ kind: "food", product: f("Mysli"), allergens: f([labelTerm]) }),
        makeProfile({ allergies: [w] }),
        NOW,
      );
      assert.equal(v.level, "warning", `${w} -> ${labelTerm}`);
      assertBounds(v.headline, v.speech, `${w} -> ${labelTerm}`);
    }
  }

  for (const w of ["maapähkinäallergia", "jordnötsallergi", "jordnötsallergisk"]) {
    assert.deepEqual(allergyBases(w), ["peanut"], w);
    const hitPeanut = checkLabel(
      makeRead({ kind: "food", product: f("Keksi"), allergens: f(["jordnötter"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(hitPeanut.level, "warning", w);
    const safeTreeNut = checkLabel(
      makeRead({ kind: "food", product: f("Keksi"), allergens: f(["mandlar"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(safeTreeNut.level, "info", w);
  }

  for (const w of ["hasselpähkinäallergia", "manteliallergia", "hasselnötsallergi", "valnötsallergi", "trädnötsallergi"]) {
    assert.deepEqual(allergyBases(w), ["tree nut"], w);
    const hitTree = checkLabel(
      makeRead({ kind: "food", product: f("Keksi"), allergens: f(["hasselnötter"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(hitTree.level, "warning", w);
    const safePeanut = checkLabel(
      makeRead({ kind: "food", product: f("Keksi"), allergens: f(["maapähkinää"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(safePeanut.level, "info", w);
  }

  for (const w of ["keliakia", "celiaki", "gluteeniallergia", "vehnäallergia", "glutenintolerans", "veteallergi"]) {
    assert.deepEqual(allergyBases(w), ["gluten"], w);
    const v = checkLabel(
      makeRead({ kind: "food", product: f("Leipä"), allergens: f(["vehnäjauho", "ohraa"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(v.level, "warning", w);
  }

  for (const w of ["äyriäisallergia", "äyriäisyliherkkyys", "skaldjur", "skaldjursallergi", "skaldjursallergisk", "kräftdjursallergi"]) {
    assert.deepEqual(allergyBases(w), ["crustacean"], w);
    const v = checkLabel(
      makeRead({ kind: "food", product: f("Salaatti"), allergens: f(["katkarapuja"]) }),
      makeProfile({ allergies: [w] }),
      NOW,
    );
    assert.equal(v.level, "warning", w);
  }

  const otherCompoundPairs: Array<[string, string]> = [
    ["kananmuna-allergia", "egg"],
    ["äggallergi", "egg"],
    ["soija-allergia", "soy"],
    ["sojaallergi", "soy"],
    ["kala-allergia", "fish"],
    ["fiskallergi", "fish"],
    ["seesamiallergia", "sesame"],
    ["sesamallergi", "sesame"],
    ["selleriallergia", "celery"],
    ["sinappiallergia", "mustard"],
    ["senapsallergi", "mustard"],
    ["lupiiniallergia", "lupin"],
    ["sulfiittiyliherkkyys", "sulphite"],
    ["sulfitallergi", "sulphite"],
  ];
  for (const [profileTerm, expectedBase] of otherCompoundPairs) {
    assert.deepEqual(allergyBases(profileTerm), [expectedBase], profileTerm);
  }
});

test("Finnish partitive and plural food allergens and Swedish label terms trigger warnings across all EU groups", () => {
  const matrix: Array<{ allergy: string; terms: string[] }> = [
    {
      allergy: "milk",
      terms: [
        "maitoa",
        "maitojauhe",
        "laktoosia",
        "herajauhe",
        "kaseiini",
        "laktos",
        "vassle",
        "kasein",
        "mjölkpulver",
        "mjolkpulver",
      ],
    },
    {
      allergy: "gluten",
      terms: [
        "vehnää",
        "vehnaa",
        "vehnäjauho",
        "vehnajauho",
        "ohraa",
        "ruista",
        "speltti",
        "gluteenia",
        "korn",
        "råg",
        "rag",
        "dinkel",
        "vetemjöl",
        "vetemjol",
      ],
    },
    {
      allergy: "egg",
      terms: ["kananmunaa", "munaa", "äggvita", "aggvita"],
    },
    {
      allergy: "soy",
      terms: ["soijaa", "soijalesitiini", "sojalecitin"],
    },
    {
      allergy: "peanut",
      terms: ["maapähkinää", "maapahkinaa", "maapähkinät", "maapahkinat", "jordnötter", "jordnotter"],
    },
    {
      allergy: "tree nut",
      terms: [
        "pähkinät",
        "pahkinat",
        "pähkinää",
        "pahkinaa",
        "hasselpähkinää",
        "hasselpahkinaa",
        "hasselpähkinät",
        "hasselpahkinat",
        "mantelia",
        "mantelit",
        "cashewpähkinää",
        "cashewpahkinaa",
        "saksanpähkinää",
        "saksanpahkinaa",
        "pistaasi",
        "nötter",
        "notter",
        "hasselnötter",
        "hasselnotter",
        "valnötter",
        "valnotter",
        "cashewnöt",
        "cashewnot",
        "cashewnötter",
        "cashewnotter",
        "pekannöt",
        "pekannot",
        "pekannötter",
        "pekannotter",
        "pistagenöt",
        "pistagenot",
        "pistagenötter",
        "pistagenotter",
        "paranöt",
        "paranot",
        "paranötter",
        "paranotter",
        "mandlar",
      ],
    },
    {
      allergy: "sesame",
      terms: ["seesaminsiemen", "seesaminsiemeniä", "seesaminsiemenia", "sesamfrö", "sesamfro", "sesamfrön", "sesamfron"],
    },
    {
      allergy: "fish",
      terms: ["kalaa", "lohta", "lax", "torsk"],
    },
    {
      allergy: "crustacean",
      terms: ["katkarapua", "katkarapuja", "äyriäisiä", "ayriaisia", "kräftdjur", "kraftdjur", "skaldjur", "räka", "raka", "räkor", "rakor", "krabba"],
    },
    {
      allergy: "celery",
      terms: ["selleriä", "selleria"],
    },
    {
      allergy: "mustard",
      terms: ["sinappia"],
    },
    {
      allergy: "lupin",
      terms: ["lupiinia"],
    },
    {
      allergy: "sulphite",
      terms: ["rikkidioksidia", "sulfiitti", "sulfiitit", "sulfiitteja", "svaveldioxid", "sulfit", "sulfiter"],
    },
  ];

  for (const { allergy, terms } of matrix) {
    const profile = makeProfile({ allergies: [allergy] });
    for (const term of terms) {
      const label = makeRead({ kind: "food", product: f("Elintarvike"), allergens: f([term], 0.9) });
      const hits = allergenHits(label, [allergy]);
      assert.equal(hits.length, 1, `Expected ${allergy} -> ${term}`);
      assert.equal(hits[0].allergy, allergy);
      assert.equal(hits[0].found, term);
      assert.equal(hits[0].mayContain, false);

      const v = checkLabel(label, profile, NOW);
      assert.equal(v.level, "warning", `Expected warning for ${allergy} -> ${term}`);
      assertBounds(v.headline, v.speech, `${allergy}:${term}`);
    }
  }

  const fiSentence = makeRead({
    kind: "food",
    product: f("Välipalakeksi"),
    allergens: f(["Ainesosat: kaurahiutale, vehnäjauho, rasvaton maitojauhe, soijalesitiini"], 0.92),
  });
  assert.equal(checkLabel(fiSentence, makeProfile({ allergies: ["keliakia"] }), NOW).level, "warning");
  assert.equal(checkLabel(fiSentence, makeProfile({ allergies: ["maitoallergia"] }), NOW).level, "warning");
  assert.equal(checkLabel(fiSentence, makeProfile({ allergies: ["soija-allergia"] }), NOW).level, "warning");

  const svSentence = makeRead({
    kind: "food",
    product: f("Knäckebröd"),
    allergens: f(["Ingredienser: råg, sesamfrön, vassle"], 0.92),
  });
  assert.equal(checkLabel(svSentence, makeProfile({ allergies: ["celiaki"] }), NOW).level, "warning");
  assert.equal(checkLabel(svSentence, makeProfile({ allergies: ["sesamallergi"] }), NOW).level, "warning");
  assert.equal(checkLabel(svSentence, makeProfile({ allergies: ["mjölkallergi"] }), NOW).level, "warning");
});

test("Finnish and Swedish pharmaceutical excipient declarations on medication cartons trigger allergy warnings", () => {
  const savedMed: Med = { id: "aml", name: "Amlodipiini Orion", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] };
  const cases: Array<{ excipient: string; profileAllergy: string; conf: number }> = [
    { excipient: "Sisältää laktoosia", profileAllergy: "laktoosi-intoleranssi", conf: 0.2 },
    { excipient: "laktoosimonohydraattia", profileAllergy: "maitoallergia", conf: 0.85 },
    { excipient: "Innehåller laktosmonohydrat", profileAllergy: "mjölkallergi", conf: 0.85 },
    { excipient: "maapähkinäöljyä", profileAllergy: "jordnötsallergi", conf: 0.85 },
    { excipient: "jordnötsolja", profileAllergy: "nötallergi", conf: 0.85 },
    { excipient: "vehnätärkkelystä", profileAllergy: "keliakia", conf: 0.85 },
    { excipient: "vetestärkelse", profileAllergy: "celiaki", conf: 0.85 },
    { excipient: "soijalesitiiniä", profileAllergy: "soija-allergia", conf: 0.85 },
    { excipient: "natriummetabisulfiittia (sulfiitteja)", profileAllergy: "sulfiittiyliherkkyys", conf: 0.85 },
  ];

  for (const c of cases) {
    const label = makeRead({
      kind: "medication",
      product: f("Amlodipiini Orion 5 mg"),
      ingredient: f("amlodipine"),
      strength: f("5 mg"),
      expiry: f("2027-09"),
      allergens: f([c.excipient], c.conf),
    });
    const hits = allergenHits(label, [c.profileAllergy]);
    assert.equal(hits.length, 1, `${c.profileAllergy} -> ${c.excipient}`);
    assert.equal(hits[0].mayContain, false);

    const v = checkLabel(label, makeProfile({ meds: [savedMed], allergies: [c.profileAllergy] }), NOW);
    assert.equal(v.level, "warning", `${c.profileAllergy} -> ${c.excipient}`);
    assert.equal(v.matchedMedId, "aml");
    assertBounds(v.headline, v.speech, `${c.profileAllergy}:${c.excipient}`);
  }
});

test("Saattaa sisaltaa, jaamia, and spar av precautionary phrases set mayContain while preserving found formatting", () => {
  const mayCases: Array<{ raw: string; allergy: string; expectedFound: string }> = [
    { raw: "Saattaa sisältää pähkinää", allergy: "pähkinäallergia", expectedFound: "Saattaa sisältää pähkinää" },
    { raw: "saattaa sisaltaa maapahkinaa ja mantelia", allergy: "jordnötsallergi", expectedFound: "saattaa sisaltaa maapahkinaa ja mantelia" },
    { raw: "Saattaa sisältää pieniä jäämiä maitoa", allergy: "maitoallergia", expectedFound: "Saattaa sisältää pieniä jäämiä maitoa" },
    { raw: "Jäämiä hasselpähkinästä", allergy: "tree nut", expectedFound: "Jäämiä hasselpähkinästä" },
    { raw: "Jäämiä seesaminsiemenistä", allergy: "sesame", expectedFound: "Jäämiä seesaminsiemenistä" },
    { raw: "Kan innehålla spår av jordnötter", allergy: "jordnötsallergi", expectedFound: "Kan innehålla spår av jordnötter" },
    { raw: "Spår av nötter och mandlar", allergy: "nötallergi", expectedFound: "Spår av nötter och mandlar" },
    { raw: "spår av skaldjur", allergy: "äyriäisallergia", expectedFound: "spår av skaldjur" },
    { raw: "may contain: maapähkinää", allergy: "peanut", expectedFound: "maapähkinää" },
  ];

  for (const item of mayCases) {
    const label = makeRead({ kind: "food", product: f("Myslipatukka"), allergens: f([item.raw], 0.9) });
    const hits = allergenHits(label, [item.allergy]);
    assert.equal(hits.length, 1, item.raw);
    assert.equal(hits[0].mayContain, true, item.raw);
    assert.equal(hits[0].found, item.expectedFound, item.raw);

    const v = checkLabel(label, makeProfile({ allergies: [item.allergy] }), NOW);
    assert.equal(v.level, "warning", item.raw);
    assert.match(v.headline, /^Warning: may contain /);
    assert.match(v.speech, /^Warning: Myslipatukka may contain /);
    assertBounds(v.headline, v.speech, item.raw);
  }

  const mixed = checkLabel(
    makeRead({
      kind: "food",
      product: f("Suklaakeksi"),
      allergens: f(["Saattaa sisältää maapähkinää", "vehnää"], 0.95),
    }),
    makeProfile({ allergies: ["jordnötsallergi", "keliakia"] }),
    NOW,
  );
  assert.equal(mixed.level, "warning");
  assert.equal(mixed.headline, "Warning: contains vehnää");
  assert.match(mixed.speech, /^Warning: Suklaakeksi contains vehnää\./);
  assertBounds(mixed.headline, mixed.speech, "mixed");
});

test("Finnish and Swedish CLASS_ALIASES trigger both avoidHits and medication allergyHits", () => {
  const aliasCases: Array<{
    aliases: string[];
    expectedClassLabel: string;
    ingredient: string;
    product: string;
    safeIngredient: string;
  }> = [
    {
      aliases: ["antiinflammatorisk", "antiinflammatoriska", "inflammationshämmande", "inflammationshammande"],
      expectedClassLabel: "NSAID",
      ingredient: "naproxen",
      product: "Pronaxen 250 mg",
      safeIngredient: "paracetamol",
    },
    {
      aliases: ["penisilliinit", "penicilliner"],
      expectedClassLabel: "penicillin",
      ingredient: "amoxicillin",
      product: "Amoxin 500 mg",
      safeIngredient: "doxycycline",
    },
    {
      aliases: ["bentsodiatsepiini", "bentsodiatsepiinit", "bensodiazepin", "bensodiazepiner"],
      expectedClassLabel: "benzodiazepine",
      ingredient: "oxazepam",
      product: "Opamox 15 mg",
      safeIngredient: "zopiclone",
    },
    {
      aliases: ["opioidi", "opioidit", "opioider"],
      expectedClassLabel: "opioid",
      ingredient: "oxycodone",
      product: "OxyContin 10 mg",
      safeIngredient: "ibuprofen",
    },
    {
      aliases: ["statiini", "statiinit", "statiner"],
      expectedClassLabel: "statin",
      ingredient: "atorvastatin",
      product: "Lipitor 20 mg",
      safeIngredient: "amlodipine",
    },
  ];

  for (const group of aliasCases) {
    const posRead = makeRead({
      product: f(group.product),
      ingredient: f(group.ingredient),
      strength: f("10 mg"),
      expiry: f("2027-10"),
      allergens: f<string[]>(null, 0),
    });
    const negRead = makeRead({
      product: f(group.safeIngredient),
      ingredient: f(group.safeIngredient),
      strength: f("10 mg"),
      expiry: f("2027-10"),
      allergens: f<string[]>(null, 0),
    });

    for (const alias of group.aliases) {
      const avHits = avoidHits(posRead, [alias]);
      assert.equal(avHits.length, 1, `avoid ${alias}`);
      assert.equal(avHits[0], `${group.ingredient} is an ${group.expectedClassLabel}, on your avoid list`);
      assert.deepEqual(avoidHits(negRead, [alias]), [], `avoid negative ${alias}`);

      const vAvoid = checkLabel(posRead, makeProfile({ avoid: [alias] }), NOW);
      assert.equal(vAvoid.level, "warning", `checkLabel avoid ${alias}`);
      assertBounds(vAvoid.headline, vAvoid.speech, `avoid:${alias}`);

      const alHits = allergenHits(posRead, [alias]);
      assert.deepEqual(alHits, [{ allergy: alias, found: group.ingredient, mayContain: false }], `allergy ${alias}`);
      assert.deepEqual(allergenHits(negRead, [alias]), [], `allergy negative ${alias}`);

      const savedMed: Med = { id: "m1", name: group.product, ingredient: group.ingredient, strength: "10 mg", schedule: ["evening"] };
      const vAllergy = checkLabel(posRead, makeProfile({ meds: [savedMed], allergies: [alias] }), NOW);
      assert.equal(vAllergy.level, "warning", `checkLabel allergy ${alias}`);
      assert.equal(vAllergy.matchedMedId, "m1");
      assertBounds(vAllergy.headline, vAllergy.speech, `allergy:${alias}`);
    }
  }

  for (const compoundDrugAllergy of ["penisilliiniallergia", "penicillinallergi"]) {
    const amoxRead = makeRead({ product: f("Amorion 500 mg"), ingredient: f("amoxicillin"), strength: f("500 mg") });
    const hits = allergenHits(amoxRead, [compoundDrugAllergy]);
    assert.deepEqual(hits, [{ allergy: compoundDrugAllergy, found: "amoxicillin", mayContain: false }]);
  }
});

test("negative false-positive guards keep English not, oats, kaura, coconut, nutmeg, eggplant, and -ton/-fri safe", () => {
  const broadAllergies = [
    "peanut",
    "tree nut",
    "milk",
    "gluten",
    "egg",
    "soy",
    "sesame",
    "nötallergi",
    "nöt",
    "not",
    "pähkinäallergia",
    "maitoallergia",
    "mjölkallergi",
    "keliakia",
    "celiaki",
    "skaldjursallergi",
  ];
  const safeDeclarations = [
    "not from concentrate",
    "do not freeze",
    "oats",
    "rolled oats",
    "kaura",
    "kauraa",
    "kaurahiutale",
    "havre",
    "coconut",
    "kookosmaito",
    "kokosmjölk",
    "kokosnöt",
    "nutmeg",
    "muskotnöt",
    "butternut squash",
    "eggplant",
    "munakoiso",
    "laktoositon",
    "maidoton",
    "gluteeniton",
    "pähkinätön",
    "laktosfri",
    "mjölkfri",
    "glutenfri",
    "nötfri",
    "sparris",
  ];

  for (const term of safeDeclarations) {
    const label = makeRead({
      kind: "food",
      product: f("Kaurajuoma"),
      allergens: f([term], 0.96),
      readability: 0.95,
    });
    assert.deepEqual(allergenHits(label, broadAllergies), [], `False positive on "${term}"`);

    const v = checkLabel(label, makeProfile({ allergies: ["nötallergi", "keliakia", "mjölkallergi"] }), NOW);
    assert.equal(v.level, "info", `Expected info for "${term}", got ${v.level}: ${v.reasons.join("; ")}`);
    assert.equal(v.headline, "Kaurajuoma: none of your allergens");
    assertBounds(v.headline, v.speech, term);
  }
});
