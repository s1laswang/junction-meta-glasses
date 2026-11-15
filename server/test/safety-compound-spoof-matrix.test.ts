import { test } from "node:test";
import assert from "node:assert/strict";
import type { Gs1Code, LabelRead, Med, Profile } from "../../shared/types.ts";
import { gtin14, parseGs1 } from "../src/gs1.ts";
import { makeGs1, parseGs1 as parseWebGs1 } from "../../web/src/lib/gs1.ts";
import {
  ALLERGEN_SAFE_CONF,
  ALLERGEN_SAFE_READABILITY,
  STRENGTH_MIN_CONF,
  allergenHits,
  avoidHits,
  checkLabel,
  checkLabelText,
  sameStrength,
} from "../src/safety.ts";

const NOW = new Date("2026-11-15T09:00:00+02:00");

const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

const makeRead = (patch: Partial<LabelRead>): LabelRead => ({
  kind: "medication",
  product: f(null, 0),
  ingredient: f(null, 0),
  strength: f(null, 0),
  dosing: f(null, 0),
  expiry: f("2028-06", 0.95),
  allergens: f<string[]>(null, 0),
  barcode: f(null, 0),
  readability: 0.92,
  ...patch,
});

const AML_GTIN = "09501101530003";
const ATO_EAN13 = "6432100098767";
const ATO_GTIN14 = "06432100098767";
const MET_GTIN = "06432100012343";
const UNLISTED_GTIN = "05000000000017";

const DEMO_MEDS: Med[] = [
  { id: "aml", name: "Amlodipin", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
  { id: "ato", name: "Atorvastatin", ingredient: "atorvastatin", strength: "20 mg", schedule: ["evening"], barcode: ATO_EAN13 },
  { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["morning", "evening"], gtin: MET_GTIN },
];

const makeProfile = (overrides: Partial<Profile> = {}): Profile => ({
  meds: DEMO_MEDS,
  allergies: ["peanut", "tree nuts", "milk", "gluten", "egg", "soy", "sesame", "crustacean", "mustard", "celery", "lupin", "sulphite"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "fi",
  ...overrides,
});

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

test("Nordic single and compound allergen synonyms cover Finnish and Swedish terms across all EU regulated bases", () => {
  const cases: { allergy: string; token: string; diacriticToken?: string }[] = [
    { allergy: "peanut", token: "maapahkina", diacriticToken: "maapähkinä" },
    { allergy: "peanut", token: "jordnot", diacriticToken: "jordnöt" },
    { allergy: "tree nuts", token: "hasselpahkina", diacriticToken: "hasselpähkinä" },
    { allergy: "tree nuts", token: "hasselnot", diacriticToken: "hasselnöt" },
    { allergy: "tree nuts", token: "manteli" },
    { allergy: "tree nuts", token: "mandel" },
    { allergy: "gluten", token: "vehna", diacriticToken: "vehnä" },
    { allergy: "gluten", token: "vete" },
    { allergy: "milk", token: "maito" },
    { allergy: "milk", token: "mjolk", diacriticToken: "mjölk" },
    { allergy: "milk", token: "hera" },
    { allergy: "egg", token: "kananmuna" },
    { allergy: "egg", token: "agg", diacriticToken: "ägg" },
    { allergy: "soy", token: "soija" },
    { allergy: "sesame", token: "seesami" },
    { allergy: "crustacean", token: "katkarapu" },
    { allergy: "mustard", token: "sinappi" },
    { allergy: "mustard", token: "senap" },
    { allergy: "celery", token: "selleri" },
    { allergy: "lupin", token: "lupiini" },
    { allergy: "sulphite", token: "rikkidioksidi" },
  ];

  for (const c of cases) {
    const prof = makeProfile({ allergies: [c.allergy] });
    for (const rawTerm of [c.token, ...(c.diacriticToken ? [c.diacriticToken] : [])]) {
      const foodRead = makeRead({
        kind: "food",
        product: f("Pohjola Valipala"),
        allergens: f([`sisaltaa ${rawTerm}`], 0.88),
        readability: 0.86,
      });
      const hits = allergenHits(foodRead, prof.allergies);
      assert.equal(hits.length, 1, `expected hit for ${c.allergy} via ${rawTerm}`);
      assert.equal(hits[0].allergy, c.allergy);
      assert.equal(hits[0].mayContain, false);

      const v = checkLabelText(foodRead, prof, NOW);
      assert.equal(v.level, "warning");
      assert.match(v.headline, /^Warning: contains /);
      assert.ok(wordCount(v.headline) <= 8);
      assert.ok(sentenceCount(v.speech) <= 2);
    }
  }
});

test("Nordic compound food labels with mixed may-contain (voi sisaltaa / kan innehalla) and sure allergens prioritize contains while reporting all matched allergies", () => {
  const prof = makeProfile({
    allergies: ["peanut", "tree nuts", "milk", "gluten", "egg", "soy", "sesame", "crustacean", "mustard", "celery", "lupin", "sulphite"],
  });

  const mixedFiSv = makeRead({
    kind: "food",
    product: f("Saaristolaisleipa / Skargardsbrod"),
    allergens: f(
      [
        "vehna / vete",
        "hera (maito / mjolk)",
        "kananmuna / agg",
        "voi sisaltaa: maapahkina, hasselpahkina, manteli",
        "kan innehalla seesami, soija, lupiini",
      ],
      0.92,
    ),
    readability: 0.88,
  });

  const hits = allergenHits(mixedFiSv, prof.allergies);
  const byAllergy = new Map(hits.map((h) => [h.allergy, h]));
  assert.equal(byAllergy.get("gluten")?.mayContain, false);
  assert.equal(byAllergy.get("milk")?.mayContain, false);
  assert.equal(byAllergy.get("egg")?.mayContain, false);
  assert.equal(byAllergy.get("peanut")?.mayContain, true);
  assert.equal(byAllergy.get("tree nuts")?.mayContain, true);
  assert.equal(byAllergy.get("sesame")?.mayContain, true);
  assert.equal(byAllergy.get("soy")?.mayContain, true);
  assert.equal(byAllergy.get("lupin")?.mayContain, true);

  const mixedVerdict = checkLabelText(mixedFiSv, prof, NOW);
  assert.equal(mixedVerdict.level, "warning");
  assert.match(mixedVerdict.headline, /^Warning: contains /);
  assert.doesNotMatch(mixedVerdict.headline, /may contain/i);
  assert.ok(mixedVerdict.reasons.some((r) => r.startsWith("contains ") && r.includes("allergy: milk")));
  assert.ok(mixedVerdict.reasons.some((r) => r.startsWith("may contain ") && r.includes("allergy: peanut")));
  assert.match(mixedVerdict.speech, /peanut/);
  assert.match(mixedVerdict.speech, /milk/);
  assert.ok(wordCount(mixedVerdict.headline) <= 8);
  assert.ok(sentenceCount(mixedVerdict.speech) <= 2);

  const savoryRead = makeRead({
    kind: "food",
    product: f("Skagenkeitto / Skagensoppa"),
    allergens: f(
      [
        "katkarapu",
        "sinappi / senap",
        "selleri",
        "rikkidioksidi",
        "kan innehålla jordnöt och hasselnöt",
      ],
      0.85,
    ),
    readability: 0.84,
  });
  const savoryHits = allergenHits(savoryRead, prof.allergies);
  assert.equal(savoryHits.filter((h) => !h.mayContain).length, 4);
  assert.equal(savoryHits.filter((h) => h.mayContain).length, 2);
  const savoryVerdict = checkLabel(savoryRead, prof, NOW);
  assert.equal(savoryVerdict.level, "warning");
  assert.match(savoryVerdict.headline, /^Warning: contains katkarapu/);

  const tracesOnly = makeRead({
    kind: "food",
    product: f("Kaurakeksi / Havrekex"),
    allergens: f(["voi sisältää maapähkinä ja manteli", "kan innehålla mandel och jordnöt"], 0.65),
    readability: 0.55,
  });
  const tracesVerdict = checkLabelText(tracesOnly, makeProfile({ allergies: ["pahkina"] }), NOW);
  assert.equal(tracesVerdict.level, "warning");
  assert.match(tracesVerdict.headline, /^Warning: may contain /);
  assert.match(tracesVerdict.speech, /may contain/i);

  const avoidRead = makeRead({
    kind: "medication",
    product: f("Burana 400 mg"),
    ingredient: f("ibuprofeeni"),
    strength: f("400 mg"),
  });
  assert.equal(avoidHits(avoidRead, ["tulehduskipulaakkeet"]).length, 1);
  assert.equal(sameStrength("5/160 mg", "5 mg + 160 mg"), true);
  assert.equal(sameStrength("2,5 mg", "2.5 mg"), true);
  assert.equal(sameStrength("2,5 mg", "25 mg"), false);
  assert.equal(sameStrength("100 mikrog", "0.1 mg"), true);
});

test("exact boundary grid around ALLERGEN_SAFE_CONF (0.94 vs 0.95) x ALLERGEN_SAFE_READABILITY (0.79 vs 0.80) and kind=other low-readability hedge", () => {
  assert.equal(ALLERGEN_SAFE_CONF, 0.95);
  assert.equal(ALLERGEN_SAFE_READABILITY, 0.8);

  const prof = makeProfile({ allergies: ["peanut", "tree nuts", "milk"] });
  const confs = [0.59, 0.6, 0.94, 0.949, 0.95, 0.99];
  const reads = [0.5, 0.79, 0.799, 0.8, 0.95];

  for (const ac of confs) {
    for (const rd of reads) {
      for (const safeList of [["kaura", "ruis"], []] as string[][]) {
        const r = makeRead({
          kind: "food",
          product: f("Kaurajuoma"),
          allergens: f(safeList, ac),
          readability: rd,
          expiry: f("2027-09", 0.9),
        });
        const v = checkLabelText(r, prof, NOW);
        const shouldBeSafeInfo = ac >= 0.95 && rd >= 0.8;
        assert.equal(
          v.level,
          shouldBeSafeInfo ? "info" : "unsure",
          `ac=${ac} rd=${rd} list=${JSON.stringify(safeList)} -> got ${v.level}`,
        );
        if (ac < 0.6) {
          assert.ok(v.reasons.includes("allergen panel not readable"));
        } else if (!shouldBeSafeInfo) {
          assert.ok(v.reasons.includes("allergen panel may be incomplete"));
        } else {
          assert.ok(v.reasons.includes("no listed allergen matches your profile"));
          assert.match(v.headline, /none of your allergens/);
        }
      }
    }
  }

  for (const [ac, rd, expected] of [
    [0.29, 0.95, "unsure"],
    [0.3, 0.55, "warning"],
    [0.6, 0.5, "warning"],
    [0.94, 0.79, "warning"],
  ] as const) {
    const hitRead = makeRead({
      kind: "food",
      product: f("Pahkinapatukka"),
      allergens: f(["hasselpahkina"], ac),
      readability: rd,
    });
    assert.equal(checkLabelText(hitRead, prof, NOW).level, expected);
  }

  const otherLowRead = makeRead({
    kind: "other",
    product: f("Urheilugeeli", 0.92),
    allergens: f<string[]>(null, 0),
    expiry: f(null, 0),
    readability: 0.49,
  });
  const vOtherLow = checkLabelText(otherLowRead, prof, NOW);
  assert.equal(vOtherLow.level, "unsure");
  assert.ok(vOtherLow.reasons.includes("low readability"));

  const otherMidReadNullAllergens = makeRead({
    kind: "other",
    product: f("Urheilugeeli", 0.92),
    allergens: f<string[]>(null, 0),
    expiry: f(null, 0),
    readability: 0.5,
  });
  const vOtherMid = checkLabelText(otherMidReadNullAllergens, prof, NOW);
  assert.equal(vOtherMid.level, "info");
  assert.ok(vOtherMid.reasons.includes("no allergen list seen"));
  assert.match(vOtherMid.speech, /can't see an allergen list/);

  const otherNoAllergyProfile = checkLabelText(otherLowRead, makeProfile({ allergies: [] }), NOW);
  assert.equal(otherNoAllergyProfile.level, "info");
});

test("GS1 DataMatrix spoofing and conflict matrix enforces cross-check invariants and never bypasses zero-guess strength gate", () => {
  assert.equal(STRENGTH_MIN_CONF, 0.8);
  assert.equal(gtin14(ATO_EAN13), ATO_GTIN14);
  assert.equal(gtin14(AML_GTIN), AML_GTIN);

  const builtAmlValid = makeGs1({ gtin: AML_GTIN, expiry: "280630", batch: "LOT8A", serial: "SN9001" });
  const builtAtoSpoof = makeGs1({ gtin: ATO_GTIN14, expiry: "280630", batch: "LOT2B", serial: "SN4410" });
  const builtExpMismatch = makeGs1({ gtin: AML_GTIN, expiry: "280900", batch: "LOT8A", serial: "SN9002" });
  const builtExpired = makeGs1({ gtin: AML_GTIN, expiry: "251000", batch: "LOT1X", serial: "SN1009" });

  for (const raw of [builtAmlValid, builtAtoSpoof, builtExpMismatch, builtExpired]) {
    const s = parseGs1(raw);
    const w = parseWebGs1(raw);
    assert.ok(s && w);
    assert.equal(s.gtin, w.gtin);
    assert.equal(s.expiry, w.expiry);
    assert.equal(s.batch, w.batch);
    assert.equal(s.serial, w.serial);
  }

  const prof = makeProfile();
  const amlClean = makeRead({
    product: f("Amlodipin Orion", 0.97),
    ingredient: f("amlodipine", 0.97),
    strength: f("5 mg", 0.97),
    expiry: f("2028-06", 0.95),
  });

  const sleeveSwap = checkLabel(amlClean, prof, NOW, parseGs1(builtAtoSpoof));
  assert.equal(sleeveSwap.level, "unsure");
  assert.equal(sleeveSwap.crossCheck?.agrees, false);
  assert.equal(sleeveSwap.matchedMedId, "aml");
  assert.match(sleeveSwap.speech, /disagree/i);
  assert.ok(sleeveSwap.crossCheck?.details.some((d) => d.includes("Atorvastatin") && d.includes("Amlodipin")));

  const unlistedWithSavedGtin = checkLabel(
    makeRead({
      product: f("Felodipin 5 mg", 0.95),
      ingredient: f("felodipine", 0.95),
      strength: f("5 mg", 0.95),
      expiry: f("2028-06", 0.95),
    }),
    prof,
    NOW,
    parseGs1(builtAmlValid),
  );
  assert.equal(unlistedWithSavedGtin.level, "unsure");
  assert.equal(unlistedWithSavedGtin.crossCheck?.agrees, false);
  assert.ok(unlistedWithSavedGtin.crossCheck?.details.some((d) => d.includes("not on your list")));

  const expiryMonthMismatch = checkLabel(amlClean, prof, NOW, parseGs1(builtExpMismatch));
  assert.equal(expiryMonthMismatch.level, "unsure");
  assert.equal(expiryMonthMismatch.crossCheck?.agrees, false);
  assert.ok(expiryMonthMismatch.crossCheck?.details.some((d) => d.includes("2028-09 != print 2028-06")));

  const unreadableExpExpiredCode = checkLabel(
    makeRead({
      product: f("Amlodipin", 0.97),
      ingredient: f("amlodipine", 0.97),
      strength: f("5 mg", 0.97),
      expiry: f<string>(null, 0.1),
    }),
    prof,
    NOW,
    parseGs1(builtExpired),
  );
  assert.equal(unreadableExpExpiredCode.level, "warning");
  assert.equal(unreadableExpExpiredCode.matchedMedId, "aml");
  assert.match(unreadableExpExpiredCode.speech, /expired in October 2025/);

  const unreadableExpValidCode = checkLabel(
    makeRead({
      product: f("Amlodipin", 0.97),
      ingredient: f("amlodipine", 0.97),
      strength: f("5 mg", 0.97),
      expiry: f<string>(null, 0.12),
    }),
    prof,
    NOW,
    parseGs1(builtAmlValid),
  );
  assert.equal(unreadableExpValidCode.level, "match");
  assert.equal(unreadableExpValidCode.crossCheck?.agrees, true);
  assert.equal(unreadableExpValidCode.read.expiry.value, null);
  assert.doesNotMatch(unreadableExpValidCode.speech, /couldn't read the expiry/);
  assert.match(unreadableExpValidCode.speech, /double-checked with the pack's code/);
  assert.ok(!unreadableExpValidCode.reasons.includes("expiry not readable"));
  assert.ok(unreadableExpValidCode.reasons.some((r) => r.includes("expiry from code 2028-06-30")));

  const codeOnlyExpiryRescue: Gs1Code = parseGs1(`(01)${UNLISTED_GTIN}(17)280630`)!;
  const rescueWithDifferentGtinOnSavedPack = checkLabel(
    makeRead({
      product: f("Amlodipin", 0.97),
      ingredient: f("amlodipine", 0.97),
      strength: f("5 mg", 0.97),
      expiry: f<string>(null, 0.1),
    }),
    prof,
    NOW,
    codeOnlyExpiryRescue,
  );
  assert.equal(rescueWithDifferentGtinOnSavedPack.level, "unsure");
  assert.equal(rescueWithDifferentGtinOnSavedPack.crossCheck?.agrees, null);
  assert.match(rescueWithDifferentGtinOnSavedPack.speech, /code isn't the one you saved/);

  const profWithoutSavedGtin = makeProfile({
    meds: DEMO_MEDS.map((m) => (m.id === "aml" ? { id: m.id, name: m.name, ingredient: m.ingredient, strength: m.strength, schedule: m.schedule } : m)),
  });
  const rescueWithUnlistedGtin = checkLabel(
    makeRead({
      product: f("Amlodipin", 0.97),
      ingredient: f("amlodipine", 0.97),
      strength: f("5 mg", 0.97),
      expiry: f<string>(null, 0.1),
    }),
    profWithoutSavedGtin,
    NOW,
    codeOnlyExpiryRescue,
  );
  assert.equal(rescueWithUnlistedGtin.level, "match");
  assert.equal(rescueWithUnlistedGtin.crossCheck?.agrees, null);
  assert.doesNotMatch(rescueWithUnlistedGtin.speech, /couldn't read the expiry/);

  for (const weakStrength of [f<string>(null, 0.1), f("5 mg", 0.79), f("5 mg", 0.5)]) {
    const thumbOccluded = checkLabel(
      makeRead({
        product: f("Amlodipin", 0.97),
        ingredient: f("amlodipine", 0.97),
        strength: weakStrength,
        expiry: f("2028-06", 0.95),
      }),
      prof,
      NOW,
      parseGs1(builtAmlValid),
    );
    assert.equal(thumbOccluded.level, "unsure");
    assert.equal(thumbOccluded.matchedMedId, "aml");
    assert.equal(thumbOccluded.speech.includes("5 mg"), false);
    assert.ok(thumbOccluded.crossCheck?.agrees === true || thumbOccluded.crossCheck?.agrees === null);
    assert.ok(wordCount(thumbOccluded.headline) <= 8);
    assert.ok(sentenceCount(thumbOccluded.speech) <= 2);
  }

  for (let i = 0; i < DEMO_MEDS.length; i++) {
    for (let j = 0; j < DEMO_MEDS.length; j++) {
      const mPrint = DEMO_MEDS[i];
      const mCode = DEMO_MEDS[j];
      const codeGtin = gtin14(mCode.gtin ?? mCode.barcode)!;
      const d2Raw = `]d201${codeGtin}1728063010BATCH7\x1d21SER99`;
      const parsed = parseGs1(d2Raw);
      assert.ok(parsed);
      const res = checkLabel(
        makeRead({
          product: f(mPrint.name, 0.96),
          ingredient: f(mPrint.ingredient, 0.96),
          strength: f(mPrint.strength, 0.96),
          expiry: f("2028-06", 0.95),
        }),
        prof,
        NOW,
        parsed,
      );
      if (i === j) {
        assert.equal(res.level, "match");
        assert.equal(res.crossCheck?.agrees, true);
      } else {
        assert.equal(res.level, "unsure");
        assert.equal(res.crossCheck?.agrees, false);
      }
    }
  }

  const unreadablePrintWithSavedCode = checkLabel(
    makeRead({ kind: "unreadable", expiry: f<string>(null, 0), readability: 0.2 }),
    prof,
    NOW,
    parseGs1(builtAmlValid),
  );
  assert.equal(unreadablePrintWithSavedCode.level, "unsure");
  assert.equal(unreadablePrintWithSavedCode.crossCheck?.agrees, null);
  assert.equal(unreadablePrintWithSavedCode.matchedMedId, "aml");

  const wrongDoseWithMatchingGtin = checkLabel(
    makeRead({
      product: f("Amlodipin", 0.97),
      ingredient: f("amlodipine", 0.97),
      strength: f("10 mg", 0.97),
      expiry: f("2028-06", 0.95),
    }),
    prof,
    NOW,
    parseGs1(builtAmlValid),
  );
  assert.equal(wrongDoseWithMatchingGtin.level, "warning");
});
