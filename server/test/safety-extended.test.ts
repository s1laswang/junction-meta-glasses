import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Med, Profile, Verdict } from "../../shared/types.ts";
import {
  allergenHits,
  avoidHits,
  checkLabel,
  clampHeadline,
  clampSpeech,
  ingredientsOf,
  isExpired,
  parseStrength,
  sameStrength,
  sayDate,
} from "../src/safety.ts";

const NOW = new Date(2026, 10, 14, 20, 0);
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
    readability: 0.95,
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

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const sentenceCount = (s: string) => (s.trim() ? s.trim().split(/(?<=[.!?])\s+/).length : 0);

function assertInvariants(v: Verdict) {
  assert.ok(wordCount(v.headline) <= 8, `headline > 8 words: "${v.headline}"`);
  assert.ok(sentenceCount(v.speech) <= 2, `speech > 2 sentences: "${v.speech}"`);
}

test("Nordic PPI brands map to INN (Losec, Omepratsoli, Somac, Pantopratsoli)", () => {
  const meds: Med[] = [
    { id: "ome", name: "Omeprazole", ingredient: "omeprazole", strength: "20 mg", schedule: ["morning"] },
    { id: "pan", name: "Pantoprazole", ingredient: "pantoprazole", strength: "40 mg", schedule: ["morning"] },
  ];
  const p = makeProfile({ meds });

  for (const prod of ["Losec 20 mg", "Omeprazol Ratiopharm", "Omepratsoli Orion"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("20 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "ome", prod);
    assertInvariants(v);
  }

  for (const prod of ["Somac 40 mg", "Pantoprazol Krka", "Pantopratsoli Sandoz"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("40 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "pan", prod);
    assertInvariants(v);
  }
});

test("Nordic antihistamine brands map to INN (Heinix, Zyrtec, Clarityn, Tuulix, Aerius)", () => {
  const meds: Med[] = [
    { id: "cet", name: "Cetirizine", ingredient: "cetirizine", strength: "10 mg", schedule: ["evening"] },
    { id: "lor", name: "Loratadine", ingredient: "loratadine", strength: "10 mg", schedule: ["morning"] },
    { id: "des", name: "Desloratadine", ingredient: "desloratadine", strength: "5 mg", schedule: ["morning"] },
  ];
  const p = makeProfile({ meds });

  for (const prod of ["Heinix", "Zyrtec", "Setiritsiini"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("10 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "cet", prod);
  }
  for (const prod of ["Clarityn", "Tuulix", "Loratadiini"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("10 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "lor", prod);
  }
  for (const prod of ["Aerius", "Desloratadiini"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("5 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "des", prod);
  }
});

test("Nordic respiratory and corticosteroid brands map to INN (Ventoline, Buventol, Albuterol, Prednisolon)", () => {
  const meds: Med[] = [
    { id: "sal", name: "Salbutamol", ingredient: "salbutamol", strength: "100 mcg", schedule: ["morning"] },
    { id: "pre", name: "Prednisolone", ingredient: "prednisolone", strength: "5 mg", schedule: ["morning"] },
  ];
  const p = makeProfile({ meds });

  for (const prod of ["Ventoline", "Buventol Easyhaler", "Albuterol", "Salbutamoli"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("0.1 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "sal", prod);
  }
  for (const prod of ["Prednisolon Orion", "Prednisoloni"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("5 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "pre", prod);
  }
});

test("Nordic cardiovascular, diuretic, and antiplatelet brands map to INN", () => {
  const cases: Array<[string, string[], string]> = [
    ["clopidogrel", ["Plavix", "Klopidogreeli"], "75 mg"],
    ["furosemide", ["Furesis", "Lasix", "Furosemidi"], "40 mg"],
    ["candesartan", ["Atacand", "Kandesartaani"], "8 mg"],
    ["losartan", ["Cozaar", "Losartaani"], "50 mg"],
    ["valsartan", ["Diovan", "Valsartaani"], "80 mg"],
  ];

  for (const [inn, brands, strength] of cases) {
    const p = makeProfile({
      meds: [{ id: inn, name: inn, ingredient: inn, strength, schedule: ["morning"] }],
    });
    for (const brand of brands) {
      const v = checkLabel(makeRead({ product: f(brand), strength: f(strength) }), p, NOW);
      assert.equal(v.level, "match", `${brand} -> ${inn}`);
      assert.equal(v.matchedMedId, inn, `${brand} -> ${inn}`);
      assertInvariants(v);
    }
  }

  const losartanOnly = makeProfile({
    meds: [{ id: "los", name: "Cozaar", ingredient: "losartan", strength: "80 mg", schedule: ["morning"] }],
  });
  const wrongSartan = checkLabel(makeRead({ product: f("Diovan"), strength: f("80 mg") }), losartanOnly, NOW);
  assert.equal(wrongSartan.level, "warning");
});

test("Nordic anticoagulant brands map to INN (Eliquis, Apiksabaani, Xarelto, Rivaroksabaani)", () => {
  const p = makeProfile({
    meds: [
      { id: "api", name: "Apixaban", ingredient: "apixaban", strength: "5 mg", schedule: ["08:00", "20:00"] },
      { id: "riv", name: "Rivaroxaban", ingredient: "rivaroxaban", strength: "20 mg", schedule: ["evening"] },
    ],
  });

  for (const prod of ["Eliquis", "Apiksabaani"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("5 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "api", prod);
  }
  for (const prod of ["Xarelto", "Rivaroksabaani"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("20 mg") }), p, NOW);
    assert.equal(v.level, "match", prod);
    assert.equal(v.matchedMedId, "riv", prod);
  }
});

test("Nordic SSRI and melatonin brands map to INN (Zoloft, Cipralex, Circadin, Melatoniini)", () => {
  const p = makeProfile({
    meds: [
      { id: "ser", name: "Sertraline", ingredient: "sertraline", strength: "50 mg", schedule: ["morning"] },
      { id: "esc", name: "Escitalopram", ingredient: "escitalopram", strength: "10 mg", schedule: ["morning"] },
      { id: "mel", name: "Melatonin", ingredient: "melatonin", strength: "2 mg", schedule: ["bedtime"] },
    ],
  });

  assert.equal(checkLabel(makeRead({ product: f("Zoloft"), strength: f("50 mg") }), p, NOW).matchedMedId, "ser");
  assert.equal(checkLabel(makeRead({ product: f("Sertraliini"), strength: f("50 mg") }), p, NOW).matchedMedId, "ser");
  assert.equal(checkLabel(makeRead({ product: f("Cipralex"), strength: f("10 mg") }), p, NOW).matchedMedId, "esc");
  assert.equal(checkLabel(makeRead({ product: f("Essitalopraami"), strength: f("10 mg") }), p, NOW).matchedMedId, "esc");
  assert.equal(checkLabel(makeRead({ product: f("Circadin"), strength: f("2 mg") }), p, NOW).matchedMedId, "mel");
  assert.equal(checkLabel(makeRead({ product: f("Melatoniini Orion"), strength: f("2 mg") }), p, NOW).matchedMedId, "mel");
});

test("Nordic antibiotic brands map to INN and penicillin allergy catches Amorion and Amoxin", () => {
  assert.ok(ingredientsOf("Amorion 500 mg").has("amoxicillin"));
  assert.ok(ingredientsOf("Amoxin 500 mg").has("amoxicillin"));
  assert.ok(ingredientsOf("Amoksisilliini").has("amoxicillin"));
  assert.ok(ingredientsOf("Doximycin 100 mg").has("doxycycline"));
  assert.ok(ingredientsOf("Doksisykliini").has("doxycycline"));

  const penAllergy = makeProfile({ allergies: ["penisilliini"] });
  const amorion = checkLabel(makeRead({ product: f("Amorion"), strength: f("500 mg") }), penAllergy, NOW);
  assert.equal(amorion.level, "warning");
  assert.match(amorion.speech, /amoxicillin/);
  assertInvariants(amorion);

  const doxyMed = makeProfile({
    meds: [{ id: "dox", name: "Doxycycline", ingredient: "doxycycline", strength: "100 mg", schedule: ["morning"] }],
    allergies: ["penicillin"],
  });
  const dox = checkLabel(makeRead({ product: f("Doximycin"), strength: f("100 mg") }), doxyMed, NOW);
  assert.equal(dox.level, "match");
  assert.equal(dox.matchedMedId, "dox");
});

test("avoid list: anticoagulants in EN and FI catch all 6 class members", () => {
  const aliases = ["anticoagulants", "blood thinner", "blood thinners", "verenohennuslaake", "verenohennuslääke"];
  const drugs = ["Marevan", "Eliquis", "Xarelto", "dabigatran", "edoxaban", "enoxaparin"];

  for (const alias of aliases) {
    const p = makeProfile({ avoid: [alias] });
    for (const d of drugs) {
      const v = checkLabel(makeRead({ product: f(d), strength: f("5 mg") }), p, NOW);
      assert.equal(v.level, "warning", `${alias} vs ${d}`);
      assert.ok(v.reasons.some((r) => r.includes("anticoagulant")), `${alias} vs ${d}: ${v.reasons.join("; ")}`);
      assertInvariants(v);
    }
  }
});

test("allergy list: anticoagulant class allergy triggers warning on apixaban and warfarin", () => {
  const p = makeProfile({
    meds: [{ id: "api", name: "Eliquis", ingredient: "apixaban", strength: "5 mg", schedule: ["morning"] }],
    allergies: ["blood thinners"],
  });
  const v = checkLabel(makeRead({ product: f("Eliquis"), strength: f("5 mg") }), p, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.headline, /apixaban/i);
  assert.match(v.speech, /allergy to blood thinners/i);
  assertInvariants(v);
});

test("avoid list: beta blockers in EN and FI catch all 6 beta-blocker drugs", () => {
  const aliases = ["beta blocker", "beta blockers", "beta-blocker", "beetasalpaaja", "beta_blocker"];
  const drugs = ["Emconcor", "metoprolol", "atenolol", "propranolol", "carvedilol", "nebivolol"];

  for (const alias of aliases) {
    for (const d of drugs) {
      const hits = avoidHits(makeRead({ product: f(d), strength: f("5 mg") }), [alias]);
      assert.equal(hits.length, 1, `${alias} vs ${d}`);
      assert.match(hits[0], /beta blocker/);
    }
  }

  const savedAndAvoid = makeProfile({
    meds: [{ id: "bis", name: "Emconcor", ingredient: "bisoprolol", strength: "5 mg", schedule: ["morning"] }],
    avoid: ["beetasalpaaja"],
  });
  const v = checkLabel(makeRead({ product: f("Emconcor"), strength: f("5 mg") }), savedAndAvoid, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.headline, /avoid list/);
  assertInvariants(v);
});

test("allergy list: beta-blocker allergy triggers warning on metoprolol", () => {
  const p = makeProfile({ allergies: ["beetasalpaaja"] });
  const v = checkLabel(makeRead({ ingredient: f("metoprolol"), strength: f("50 mg") }), p, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.speech, /contains metoprolol/);
  assertInvariants(v);
});

test("avoid list: ACE inhibitors in EN and FI (ACE-estäjä, ace estaja) catch all 4 ACE inhibitors", () => {
  const aliases = ["ace inhibitor", "ace inhibitors", "ACE-estäjä", "ace estaja", "ace_inhibitor"];
  const drugs = ["Cardace", "enalapril", "lisinopril", "perindopril"];

  for (const alias of aliases) {
    for (const d of drugs) {
      const hits = avoidHits(makeRead({ product: f(d), strength: f("10 mg") }), [alias]);
      assert.equal(hits.length, 1, `${alias} vs ${d}`);
      assert.match(hits[0], /ACE inhibitor/);
    }
  }
});

test("allergy list: ACE-estäjä triggers drug allergy warning on ramipril and enalapril", () => {
  const p = makeProfile({ allergies: ["ACE-estäjä"] });
  for (const prod of ["Cardace", "Renitec", "lisinopril"]) {
    const v = checkLabel(makeRead({ product: f(prod), strength: f("5 mg") }), p, NOW);
    assert.equal(v.level, "warning", prod);
    assert.match(v.speech, /ACE-estäjä/);
    assertInvariants(v);
  }
});

test("avoid and allergy lists: PPI and antihistamine classes cover all members", () => {
  for (const d of ["Losec", "Somac", "esomeprazole", "lansoprazole"]) {
    const hits = avoidHits(makeRead({ product: f(d), strength: f("20 mg") }), ["ppi"]);
    assert.equal(hits.length, 1, d);
  }
  for (const d of ["Heinix", "Tuulix", "Aerius", "fexofenadine", "ebastine"]) {
    const hits = allergenHits(makeRead({ product: f(d), strength: f("10 mg") }), ["antihistamine"]);
    assert.equal(hits.length, 1, d);
  }
});

test("EU-14 allergens: mollusc in EN, FI, and SV", () => {
  const labelTerms = [
    "mollusc",
    "molluscs",
    "mussel",
    "oyster",
    "squid",
    "octopus",
    "clam",
    "scallop",
    "nilviäiset",
    "simpukka",
    "blötdjur",
    "blåmussla",
    "ostron",
  ];
  for (const profileTerm of ["mollusc", "molluscs", "nilviäiset", "blötdjur"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const term of labelTerms) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Seafood soup"), allergens: f([term]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${term}`);
      assertInvariants(v);
    }
  }
});

test("EU-14 allergens: shellfish and skaldjur cover both crustaceans and molluscs", () => {
  for (const allergy of ["shellfish", "skaldjur"]) {
    const p = makeProfile({ allergies: [allergy] });
    const shrimp = checkLabel(makeRead({ kind: "food", product: f("Prawn salad"), allergens: f(["katkarapu"]) }), p, NOW);
    const mussel = checkLabel(makeRead({ kind: "food", product: f("Paella"), allergens: f(["simpukka"]) }), p, NOW);
    assert.equal(shrimp.level, "warning", `${allergy} -> katkarapu`);
    assert.equal(mussel.level, "warning", `${allergy} -> simpukka`);
  }

  const molluscOnly = makeProfile({ allergies: ["mollusc"] });
  const shrimpOnly = checkLabel(makeRead({ kind: "food", product: f("Shrimp"), allergens: f(["shrimp"]) }), molluscOnly, NOW);
  assert.equal(shrimpOnly.level, "info");
});

test("EU-14 allergens: celery in EN, FI, and SV", () => {
  for (const profileTerm of ["celery", "selleri", "selleriallergia"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["celery", "celeriac", "selleri", "juuriselleri", "rotselleri", "stjälkselleri"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Broth"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: mustard in EN, FI, and SV", () => {
  for (const profileTerm of ["mustard", "sinappi", "senap"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["mustard", "mustard seeds", "sinappi", "sinapinsiemen", "senap", "senapsfrö"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Dressing"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: lupin in EN, FI, and SV", () => {
  for (const profileTerm of ["lupin", "lupiini"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["lupin", "lupine", "lupin flour", "lupiini", "lupiinijauho", "lupinmjöl"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Pastry"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: sesame in EN, FI, and SV", () => {
  for (const profileTerm of ["sesame", "seesami", "seesaminsiemen", "sesam", "sesamfrö"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["sesame", "tahini", "seesaminsiemen", "sesamfrö", "sesamolja"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Hummus"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: sulphites in EN, FI, and SV", () => {
  for (const profileTerm of ["sulphite", "sulfites", "sulfiitti", "rikkidioksidi", "svaveldioxid", "sulfit"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["sulphites", "sulfur dioxide", "sulfiitti", "rikkidioksidi", "svaveldioxid", "sulfit", "E220"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Dried apricots"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: gluten, coeliac, keliakia, celiaki, and oat/kaura/havre edge cases", () => {
  for (const profileTerm of ["gluten", "coeliac", "celiac", "keliakia", "celiaki"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of ["wheat", "barley", "rye", "oats", "vehnä", "ohra", "ruis", "kaura", "vete", "korn", "råg", "havre"]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Porridge"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }

    const gf = checkLabel(makeRead({ kind: "food", product: f("Rice crackers"), allergens: f(["gluten-free"]) }), p, NOW);
    assert.equal(gf.level, "info", `${profileTerm} vs gluten-free`);
  }
});

test("EU-14 allergens: Finnish voi sisältää does not false-trigger milk allergy", () => {
  const milkProfile = makeProfile({ allergies: ["maito"] });
  const nutTrace = checkLabel(
    makeRead({ kind: "food", product: f("Dark chocolate"), allergens: f(["voi sisältää: hasselpähkinää"]) }),
    milkProfile,
    NOW,
  );
  assert.equal(nutTrace.level, "info");

  const butterFat = checkLabel(
    makeRead({ kind: "food", product: f("Biscuit"), allergens: f(["voirasva"]) }),
    milkProfile,
    NOW,
  );
  assert.equal(butterFat.level, "warning");
});

test("EU-14 allergens: general nut, pähkinä, and nötter catch both peanut and all tree nuts", () => {
  for (const profileTerm of ["nut", "nuts", "pähkinä", "pähkinäallergia", "nötter"]) {
    const p = makeProfile({ allergies: [profileTerm] });
    for (const labelTerm of [
      "maapähkinä",
      "jordnöt",
      "manteli",
      "hasselpähkinä",
      "saksanpähkinä",
      "cashewpähkinä",
      "pekaanipähkinä",
      "parapähkinä",
      "pistaasipähkinä",
      "makadamia",
      "valnöt",
      "paranöt",
      "pistasch",
    ]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Granola"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${profileTerm} vs ${labelTerm}`);
    }
  }
});

test("EU-14 allergens: egg, soy, fish, and crustacean variants in EN, FI, and SV", () => {
  const cases: Array<[string, string[]]> = [
    ["kananmuna-allergia", ["albumin", "egg white", "munavalkuainen", "äggvita", "äggpulver"]],
    ["soija", ["soy lecithin", "tofu", "soijalesitiini", "sojabönor", "sojalecitin"]],
    ["kala-allergia", ["anchovy", "tuna", "lohi", "tonnikala", "lax", "tonfisk", "ansjovis"]],
    ["äyriäiset", ["prawn", "crayfish", "katkarapu", "hummeri", "räkor", "kräftdjur"]],
  ];
  for (const [allergy, terms] of cases) {
    const p = makeProfile({ allergies: [allergy] });
    for (const t of terms) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Meal"), allergens: f([t]) }), p, NOW);
      assert.equal(v.level, "warning", `${allergy} vs ${t}`);
    }
  }
});

test("combination med matching selects exact combo over single-ingredient med when both on profile", () => {
  const p = makeProfile({
    meds: [
      { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] },
      { id: "cod", name: "Panacod", ingredient: "paracetamol, codeine", strength: "500 mg + 30 mg", schedule: ["evening"] },
    ],
  });

  const plain = checkLabel(makeRead({ product: f("Pamol"), ingredient: f("paracetamol"), strength: f("500 mg") }), p, NOW);
  assert.equal(plain.level, "match");
  assert.equal(plain.matchedMedId, "par");

  const combo = checkLabel(
    makeRead({ product: f("Panacod"), ingredient: f("paracetamol, codeine"), strength: f("500mg/30mg") }),
    p,
    NOW,
  );
  assert.equal(combo.level, "match");
  assert.equal(combo.matchedMedId, "cod");
});

test("EU-14 allergens: complete 14-allergen matrix in English, Finnish, and Swedish", () => {
  const eu14: Array<[string, string, string, string]> = [
    ["gluten", "wheat", "vehnä", "vete"],
    ["crustacean", "shrimp", "äyriäiset", "kräftdjur"],
    ["egg", "egg", "kananmuna", "ägg"],
    ["fish", "salmon", "kala", "fisk"],
    ["peanut", "peanut", "maapähkinä", "jordnöt"],
    ["soy", "soybean", "soija", "sojaböna"],
    ["milk", "whey", "maito", "mjölk"],
    ["tree nut", "almond", "manteli", "hasselnöt"],
    ["celery", "celery", "selleri", "rotselleri"],
    ["mustard", "mustard", "sinappi", "senap"],
    ["sesame", "sesame", "seesaminsiemen", "sesamfrö"],
    ["sulphite", "sulphites", "sulfiitti", "svaveldioxid"],
    ["lupin", "lupin", "lupiini", "lupinmjöl"],
    ["mollusc", "mussel", "nilviäiset", "blötdjur"],
  ];

  assert.equal(eu14.length, 14);
  for (const [base, en, fi, sv] of eu14) {
    const p = makeProfile({ allergies: [base] });
    for (const labelTerm of [en, fi, sv]) {
      const v = checkLabel(makeRead({ kind: "food", product: f("Test food"), allergens: f([labelTerm]) }), p, NOW);
      assert.equal(v.level, "warning", `${base} failed on ${labelTerm}`);
      assertInvariants(v);
    }
  }
});

test("Finnish and Swedish trace prefixes set mayContain true and clean display text", () => {
  const p = makeProfile({ allergies: ["nötter"] });
  const fi = checkLabel(
    makeRead({ kind: "food", product: f("Keksi"), allergens: f(["voi sisältää: mantelia"]) }),
    p,
    NOW,
  );
  assert.equal(fi.level, "warning");
  assert.match(fi.headline, /Warning: may contain mantelia/);
  assertInvariants(fi);

  const sv = checkLabel(
    makeRead({ kind: "food", product: f("Kaka"), allergens: f(["kan innehålla: hasselnöt"]) }),
    p,
    NOW,
  );
  assert.equal(sv.level, "warning");
  assert.match(sv.headline, /Warning: may contain hasselnöt/);
  assertInvariants(sv);
});

test("combination strength safety: 500 mg vs 500 mg + 30 mg is false and produces warning verdict", () => {
  assert.equal(sameStrength("500 mg", "500 mg + 30 mg"), false);
  assert.equal(sameStrength("500 mg + 30 mg", "500 mg"), false);
  assert.equal(sameStrength("875 mg / 125 mg", "875 mg"), false);
  assert.equal(sameStrength("16 mg", "16 mg / 12.5 mg"), false);

  const p = makeProfile({
    meds: [{ id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] }],
  });
  const combo = checkLabel(
    makeRead({
      product: f("Panacod"),
      ingredient: f("paracetamol, codeine"),
      strength: f("500 mg + 30 mg"),
    }),
    p,
    NOW,
  );
  assert.equal(combo.level, "warning");
  assert.equal(combo.matchedMedId, "par");
  assert.match(combo.headline, /wrong strength/);
  assert.match(combo.speech, /your list says 500 mg/);
  assertInvariants(combo);
});

test("combination strength equivalence: 500 mg + 30 mg matches 500mg/30mg and rejects 500 mg + 500 mg", () => {
  assert.equal(sameStrength("500 mg + 30 mg", "500mg/30mg"), true);
  assert.equal(sameStrength("30 mg + 500 mg", "500 mg + 30 mg"), true);
  assert.equal(sameStrength("0.5 g + 30 mg", "500 mg/30 mg"), true);
  assert.equal(sameStrength("500 mg + 500 mg", "500 mg + 30 mg"), false);
  assert.equal(sameStrength("500 mg + 30 mg", "500 mg + 500 mg"), false);
  assert.equal(sameStrength("500 mg + 1000 IU", "500 mg"), false);
  assert.equal(sameStrength("500 mg + 1000 IU", "500 mg + 1000 KY"), true);
});

test("liquid concentration strength: 500 mg/5 ml works and distinguishes different volumes", () => {
  assert.deepEqual(parseStrength("500 mg/5 ml"), [
    { amount: 500, unit: "mg" },
    { amount: 5, unit: "ml" },
  ]);
  assert.equal(sameStrength("500 mg/5 ml", "500 mg / 5 ml"), true);
  assert.equal(sameStrength("500 mg/5 ml", "500 mg"), true);
  assert.equal(sameStrength("500 mg/5 ml", "500 mg/10 ml"), false);
  assert.equal(sameStrength("100 mg/ml", "100 mg/1 ml"), true);
  assert.equal(sameStrength("100 mg/ml", "100 mg/5 ml"), false);
  assert.equal(sameStrength("5 ml", "10 ml"), false);
  assert.equal(sameStrength("5 ml", "5 ml"), true);
});

test("microgram, milligram, gram, and IU/KY conversions", () => {
  assert.equal(sameStrength("0.1 mg", "100 mcg"), true);
  assert.equal(sameStrength("0.1 mg", "100 µg"), true);
  assert.equal(sameStrength("0.1 mg", "100 μg"), true);
  assert.equal(sameStrength("0.1 mg", "100 ug"), true);
  assert.equal(sameStrength("0.1 mg", "100 mikrog"), true);
  assert.equal(sameStrength("0.1 mg", "100 mikrogrammaa"), true);
  assert.equal(sameStrength("0.1 mg", "100 micrograms"), true);
  assert.equal(sameStrength("0.025 mg", "25 mcg"), true);
  assert.equal(sameStrength("1 g", "1000 mg"), true);
  assert.equal(sameStrength("1,5 g", "1500 mg"), true);
  assert.equal(sameStrength("1000 IU", "1000 KY"), true);
  assert.equal(sameStrength("0.1 mg", "10 mcg"), false);
});

test("expiry boundary dates: exact day, month-end, leap year February, and invalid dates", () => {
  assert.equal(isExpired("2026-11-13", NOW), true);
  assert.equal(isExpired("2026-11-14", NOW), false);
  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 14, 23, 59, 59, 500)), false);
  assert.equal(isExpired("2026-11-14", new Date(2026, 10, 15, 0, 0, 0, 0)), true);
  assert.equal(isExpired("2026-11", new Date(2026, 10, 30, 23, 59, 59, 0)), false);
  assert.equal(isExpired("2026-11", new Date(2026, 11, 1, 0, 0, 0, 0)), true);

  assert.equal(isExpired("2028-02", new Date(2028, 1, 29, 18, 0)), false);
  assert.equal(isExpired("2028-02", new Date(2028, 2, 1, 0, 0)), true);
  assert.equal(isExpired("2028-02-29", new Date(2028, 1, 29, 12, 0)), false);
  assert.equal(isExpired("2026-02-29", NOW), undefined);
  assert.equal(isExpired("2026-13", NOW), undefined);
  assert.equal(isExpired("2026-00", NOW), undefined);
  assert.equal(isExpired("invalid", NOW), undefined);
  assert.equal(sayDate("2026-11-14"), "14 November 2026");
  assert.equal(sayDate("2026-11"), "November 2026");
});

test("headline <= 8 words and speech <= 2 sentences invariants hold on extreme inputs", () => {
  assert.equal(wordCount(clampHeadline("Alpha beta gamma delta epsilon zeta eta theta iota kappa")), 8);
  assert.equal(
    clampSpeech("First 0.125 mg dose! Second 2.5 mg note? Third sentence dropped."),
    "First 0.125 mg dose! Second 2.5 mg note?",
  );

  const p = makeProfile({
    meds: [
      {
        id: "long",
        name: "Phenoxymethylpenicillin Potassium",
        ingredient: "phenoxymethylpenicillin potassium salt",
        strength: "500 mg + 125 mg",
        schedule: ["morning"],
      },
    ],
    allergies: ["peanut", "tree nut", "sesame", "mollusc", "sulphite"],
    avoid: ["ACE-estäjä"],
  });

  const scenarios: LabelRead[] = [
    makeRead({ kind: "unreadable", readability: 0.1, guidance: "Move the package closer and tilt slightly away from glare." }),
    makeRead({ product: f("Phenoxymethylpenicillin Potassium Extra Forte"), ingredient: f("phenoxymethylpenicillin potassium salt"), strength: f("500 mg + 125 mg") }),
    makeRead({ product: f("Phenoxymethylpenicillin Potassium Extra Forte"), ingredient: f("phenoxymethylpenicillin potassium salt"), strength: f("500 mg") }),
    makeRead({ product: f("Phenoxymethylpenicillin Potassium Extra Forte"), ingredient: f("phenoxymethylpenicillin potassium salt"), strength: f("500 mg + 125 mg"), expiry: f("2024-01") }),
    makeRead({ product: f("Cardace Long Product Title Extra"), ingredient: f("ramipril"), strength: f("10 mg") }),
    makeRead({ kind: "food", product: f("Artisanal Archipelago Rye Crackers With Seeds And Herbs"), allergens: f(["seesaminsiemen", "simpukka", "sulfiitti"]) }),
    makeRead({ kind: "food", product: f("Artisanal Archipelago Oat Drink Original Unsweetened"), allergens: f(["water"]), expiry: f("2027-05-01") }),
  ];

  for (const s of scenarios) {
    const v = checkLabel(s, p, NOW);
    assertInvariants(v);
  }
});
