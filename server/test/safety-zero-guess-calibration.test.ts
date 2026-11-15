import { test } from "node:test";
import assert from "node:assert/strict";
import type { Gs1Code, LabelRead, Med, Profile, Verdict, VerdictLevel } from "../../shared/types.ts";
import { buildSceneVerdict, type RawItem } from "../src/find.ts";
import { parseGs1 } from "../src/gs1.ts";
import {
  ALLERGEN_SAFE_CONF,
  ALLERGEN_SAFE_READABILITY,
  MATCH_MIN_READABILITY,
  MATCH_NAME_MIN_CONF,
  STRENGTH_MIN_CONF,
  checkLabel,
} from "../src/safety.ts";

export const RULES_NOW = new Date(2026, 10, 15, 9, 0);
const WILSON_Z_95 = 1.959963984540054;

export function wilsonCi95(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2n = (WILSON_Z_95 * WILSON_Z_95) / n;
  const denom = 1 + z2n;
  const center = (p + 0.5 * z2n) / denom;
  const radicand = Math.max(0, (p * (1 - p) + 0.25 * z2n) / n);
  const half = (WILSON_Z_95 * Math.sqrt(radicand)) / denom;
  return [+Math.max(0, center - half).toFixed(4), +Math.min(1, center + half).toFixed(4)];
}

export function ruleOfThree95Upper(n: number, k = 0): number {
  if (n <= 0) return 1;
  if (k === 0) return +Math.min(1, 3 / n).toFixed(4);
  return wilsonCi95(k, n)[1];
}

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const base = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication",
  product: f(null, 0),
  ingredient: f(null, 0),
  strength: f(null, 0),
  dosing: f(null, 0),
  expiry: f("2028-06", 0.9),
  allergens: f<string[]>(null, 0),
  barcode: f(null, 0),
  readability: 0.9,
  ...p,
});

const AML_GTIN = "09501101530003";
const MET_GTIN = "06432100012343";
const ATO_BARCODE = "6432100098767";
const ATO_GTIN14 = "06432100098767";
const UNKNOWN_GTIN = "05000000000017";

const demoProfile = (taken: string[] = [], extraMeds?: Med[]): Profile => ({
  meds: extraMeds ?? [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
    { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"], gtin: MET_GTIN },
    { id: "ato", name: "Atorvastatin", ingredient: "atorvastatin", strength: "20 mg", schedule: ["evening"], barcode: ATO_BARCODE },
  ],
  allergies: ["tree nuts", "peanut"],
  avoid: ["NSAIDs"],
  doseLog: taken.map((medId) => ({ medId, ts: RULES_NOW.getTime() - 3600_000 })),
  lang: "en",
});

type CrossCheckExpectation = boolean | null | "non_conflict";

export type RuleCase = {
  family: string;
  prof: Profile;
  read?: LabelRead;
  code?: Gs1Code;
  scene?: { items: RawItem[]; target?: string };
  safeConfidentMatch: boolean;
  safeInfoAllowed?: boolean;
  requireAllergenHedge?: boolean;
  expectedLevel: VerdictLevel | VerdictLevel[];
  expectCrossCheckAgrees?: CrossCheckExpectation;
  confTag: number;
};

export function buildRuleCases(): RuleCase[] {
  const cases: RuleCase[] = [];
  const confs = [0.3, 0.5, 0.59, 0.6, 0.7, 0.79, 0.8, 0.85, 0.9, 0.95, 0.99];
  const meds = [
    ["amlodipine", "5 mg", ["2.5 mg", "10 mg"], "aml", "Norvasc", AML_GTIN, "which one is my evening pill?"],
    ["metformin", "500 mg", ["850 mg", "1000 mg"], "met", "Glucophage", MET_GTIN, "which one is my Metformin?"],
    ["atorvastatin", "20 mg", ["10 mg", "40 mg"], "ato", "Lipitor", ATO_GTIN14, "which one is my Atorvastatin?"],
  ] as const;

  for (const [ing, good, wrong, id] of meds) {
    for (const c of confs) {
      const ok = c >= STRENGTH_MIN_CONF;
      cases.push({
        family: "correct_box",
        read: base({ ingredient: f(ing), strength: f(good, c) }),
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: c,
      });
      for (const w of wrong) {
        cases.push({
          family: "wrong_strength",
          read: base({ ingredient: f(ing), strength: f(w, c) }),
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: ok ? "warning" : "unsure",
          confTag: c,
        });
      }
      cases.push({
        family: "strength_missing",
        read: base({ ingredient: f(ing), strength: f<string>(null, +(c * 0.2).toFixed(4)) }),
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: "unsure",
        confTag: +(c * 0.2).toFixed(4),
      });
      cases.push({
        family: "expired",
        read: base({ ingredient: f(ing), strength: f(good, c), expiry: f("2024-11", 0.9) }),
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: ok ? "warning" : "unsure",
        confTag: c,
      });
      cases.push({
        family: "already_taken",
        read: base({ ingredient: f(ing), strength: f(good, c) }),
        prof: demoProfile(id === "met" ? ["met", "met"] : [id]),
        safeConfidentMatch: false,
        expectedLevel: ok ? "warning" : "unsure",
        confTag: c,
      });
    }
  }

  const nameConfs = [0.3, 0.59, 0.6, 0.7, 0.79, 0.8, 0.85, 0.95];
  for (const [ing, good, , , brand] of meds) {
    for (const nc of nameConfs) {
      const ok = nc >= MATCH_NAME_MIN_CONF;
      cases.push({
        family: "name_conf_gate",
        read: base({ ingredient: f(ing, nc), strength: f(good, 0.95) }),
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: nc,
      });
      cases.push({
        family: "name_conf_gate",
        read: base({ product: f(brand, nc), strength: f(good, 0.95) }),
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: nc,
      });
    }
  }

  for (const nc of [0.3, 0.59, 0.6, 0.79, 0.8, 0.95]) {
    const hasName = nc >= 0.6;
    for (const [prod, ing, str] of [
      ["Panadol", "paracetamol", "500 mg"],
      ["Cardace", "ramipril", "5 mg"],
    ] as const) {
      cases.push({
        family: "not_on_list",
        read: base({ product: f(prod, nc), ingredient: f(ing, nc), strength: f(str, 0.95) }),
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: hasName ? "warning" : "unsure",
        confTag: nc,
      });
    }
    for (const [prod, ing, str] of [
      ["Burana", "ibuprofen", "400 mg"],
      ["Aspirin", "acetylsalicylic acid", "500 mg"],
      ["Pronaxen", "naproxen", "250 mg"],
    ] as const) {
      cases.push({
        family: "nsaid_avoid",
        read: base({ product: f(prod, nc), ingredient: f(ing, nc), strength: f(str, 0.95) }),
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: hasName ? "warning" : "unsure",
        confTag: nc,
      });
    }
  }

  for (const [ing, good] of meds) {
    for (const rd of [0.1, 0.3, 0.49, 0.5, 0.65, 0.8, 0.95]) {
      const ok = rd >= MATCH_MIN_READABILITY;
      cases.push({
        family: "readability_gate",
        read: base({ ingredient: f(ing, 0.95), strength: f(good, 0.95), readability: rd }),
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: rd,
      });
    }
    for (const nc of [0.79, 0.8]) {
      for (const rd of [0.49, 0.5]) {
        for (const sc of [0.79, 0.8]) {
          const ok = nc >= MATCH_NAME_MIN_CONF && rd >= MATCH_MIN_READABILITY && sc >= STRENGTH_MIN_CONF;
          cases.push({
            family: "zero_guess_cube",
            read: base({ ingredient: f(ing, nc), strength: f(good, sc), readability: rd }),
            prof: demoProfile(),
            safeConfidentMatch: ok,
            expectedLevel: ok ? "match" : "unsure",
            confTag: Math.min(nc, rd, sc),
          });
        }
      }
    }
  }

  for (const rd of [0.05, 0.1, 0.25, 0.49]) {
    cases.push({
      family: "unreadable",
      read: base({ kind: "unreadable", readability: rd }),
      prof: demoProfile(),
      safeConfidentMatch: false,
      expectedLevel: "unsure",
      confTag: rd,
    });
    cases.push({
      family: "unreadable",
      read: base({ ingredient: f("amlodipine", 0.59), strength: f("5 mg", 0.95), readability: rd }),
      prof: demoProfile(),
      safeConfidentMatch: false,
      expectedLevel: "unsure",
      confTag: rd,
    });
  }

  const safeFoods: [string, string[]][] = [
    ["Oat drink", ["oats"]],
    ["Rye crispbread", ["rye", "wheat"]],
  ];
  for (const [prod, list] of safeFoods) {
    for (const ac of [0.0, 0.59, 0.6, 0.8, 0.94, 0.95, 0.99]) {
      for (const rd of [0.49, 0.79, 0.8, 0.95]) {
        const safeInfo = ac >= ALLERGEN_SAFE_CONF && rd >= ALLERGEN_SAFE_READABILITY;
        cases.push({
          family: "food_allergen_gate",
          read: base({
            kind: "food",
            product: f(prod, 0.95),
            allergens: ac === 0 ? f<string[]>(null, 0.1) : f(list, ac),
            readability: rd,
          }),
          prof: demoProfile(),
          safeConfidentMatch: false,
          safeInfoAllowed: safeInfo,
          expectedLevel: safeInfo ? "info" : "unsure",
          confTag: ac,
        });
      }
    }
  }

  for (const [ac, rd] of [
    [0.59, 0.95],
    [0.6, 0.95],
    [0.85, 0.95],
    [0.94, 0.95],
    [0.95, 0.49],
    [0.95, 0.65],
    [0.95, 0.79],
    [0.99, 0.79],
  ] as const) {
    for (const prod of ["Cropped granola", "Rotated muesli"]) {
      cases.push({
        family: "food_cropped_panel",
        read: base({ kind: "food", product: f(prod, 0.95), allergens: f(["oats"], ac), readability: rd }),
        prof: demoProfile(),
        safeConfidentMatch: false,
        safeInfoAllowed: false,
        expectedLevel: "unsure",
        confTag: ac,
      });
    }
  }

  const allergenFoods: [string, string[]][] = [
    ["Hazelnut bar", ["hazelnut"]],
    ["Peanut spread", ["arachis oil"]],
    ["Oat flapjack", ["oats", "may contain: hazelnut"]],
    ["Sukka suklaa", ["hasselpahkina"]],
    ["Keksi", ["maapahkina"]],
    ["Muesli", ["kan innehalla jordnot"]],
  ];
  for (const [prod, list] of allergenFoods) {
    for (const ac of [0.6, 0.79, 0.94, 0.95]) {
      for (const rd of [0.5, 0.79, 0.92]) {
        cases.push({
          family: "food_allergen",
          read: base({ kind: "food", product: f(prod, 0.95), allergens: f(list, ac), readability: rd }),
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: "warning",
          confTag: ac,
        });
      }
    }
    cases.push({
      family: "food_allergen",
      read: base({ kind: "food", product: f(prod, 0.95), allergens: f(list, 0.29), readability: 0.9 }),
      prof: demoProfile(),
      safeConfidentMatch: false,
      expectedLevel: "unsure",
      confTag: 0.29,
    });
    cases.push({
      family: "food_expired",
      read: base({ kind: "food", product: f(prod, 0.95), allergens: f(["oats"], 0.99), expiry: f("2025-05", 0.9), readability: 0.95 }),
      prof: demoProfile(),
      safeConfidentMatch: false,
      expectedLevel: "warning",
      confTag: 0.99,
    });
  }

  for (const prod of ["Recovery Gel", "Hand Lotion", "Protein Drink", "Dish Soap"]) {
    for (const pc of [0.65, 0.95]) {
      for (const rd of [0.15, 0.35, 0.49, 0.5, 0.85]) {
        const clearOther = rd >= 0.5;
        cases.push({
          family: "other_allergen_hedge",
          read: base({ kind: "other", product: f(prod, pc), allergens: f<string[]>(null, 0), expiry: f(null, 0), readability: rd }),
          prof: demoProfile(),
          safeConfidentMatch: false,
          safeInfoAllowed: clearOther,
          requireAllergenHedge: clearOther,
          expectedLevel: clearOther ? "info" : "unsure",
          confTag: rd,
        });
      }
    }
  }

  for (const [ing, good, wrong, , , gtin] of meds) {
    const cParen = parseGs1(`(01)${gtin}(17)280600(10)B1(21)S1`)!;
    const cRaw = parseGs1(`]d201${gtin}1728063010B1\x1d21S1`)!;
    for (const code of [cParen, cRaw]) {
      for (const sc of [0.5, 0.79, 0.8, 0.95]) {
        const ok = sc >= STRENGTH_MIN_CONF;
        cases.push({
          family: "dm_agree",
          read: base({ ingredient: f(ing, 0.95), strength: f(good, sc), expiry: f("2028-06", 0.9) }),
          code,
          prof: demoProfile(),
          safeConfidentMatch: ok,
          expectedLevel: ok ? "match" : "unsure",
          expectCrossCheckAgrees: ok ? true : "non_conflict",
          confTag: sc,
        });
      }
    }
    for (const sc of [0.79, 0.95]) {
      const ok = sc >= STRENGTH_MIN_CONF;
      cases.push({
        family: "dm_agree",
        read: base({ ingredient: f(ing, 0.95), strength: f(good, sc), expiry: f("2028-06", 0.9) }),
        code: parseGs1(`(01)${UNKNOWN_GTIN}(17)280600`)!,
        prof: demoProfile(),
        // the pack code is not the GTIN saved for this med: never a plain yes (judge-panel probe 8, Sun 15 Nov)
        safeConfidentMatch: false,
        expectedLevel: "unsure",
        expectCrossCheckAgrees: ok ? true : "non_conflict",
        confTag: sc,
      });
      cases.push({
        family: "dm_agree",
        read: base({ ingredient: f(ing, 0.95), strength: f(good, sc), expiry: f<string>(null, 0.1) }),
        code: parseGs1("(17)280630")!,
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        expectCrossCheckAgrees: null,
        confTag: sc,
      });
    }

    for (const w of wrong) {
      for (const sc of [0.79, 0.95]) {
        const ok = sc >= STRENGTH_MIN_CONF;
        cases.push({
          family: "dm_strength_mismatch",
          read: base({ ingredient: f(ing, 0.95), strength: f(w, sc), expiry: f("2028-06", 0.9) }),
          code: cParen,
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: ok ? ["warning", "unsure"] : "unsure",
          expectCrossCheckAgrees: ok ? undefined : "non_conflict",
          confTag: sc,
        });
      }
    }

    for (const [printExp, printConf, codeExp] of [
      ["2028-06", 0.7, "280300"],
      ["2027-12", 0.9, "280131"],
      ["2028-09", 0.85, "241100"],
    ] as const) {
      for (const sc of [0.79, 0.95]) {
        cases.push({
          family: "dm_expiry_conflict",
          read: base({ ingredient: f(ing, 0.95), strength: f(good, sc), expiry: f(printExp, printConf) }),
          code: parseGs1(`(01)${gtin}(17)${codeExp}`)!,
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: "unsure",
          expectCrossCheckAgrees: false,
          confTag: sc,
        });
      }
    }

    for (const [codeExp, agreePastIso] of [
      ["241100", "2024-11"],
      ["250831", "2025-08"],
      ["261015", "2026-10"],
    ] as const) {
      const expCode = parseGs1(`(01)${gtin}(17)${codeExp}`)!;
      for (const expiryField of [
        f<string>(null, 0.1),
        f("2028-09", 0.5),
        f("2028-09", 0.69),
        f(agreePastIso, 0.9),
      ]) {
        cases.push({
          family: "dm_expired_rescue",
          read: base({ ingredient: f(ing, 0.95), strength: f(good, 0.95), expiry: expiryField }),
          code: expCode,
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: "warning",
          expectCrossCheckAgrees: "non_conflict",
          confTag: expiryField.confidence,
        });
      }
    }

    const validCode = parseGs1(`(01)${gtin}(17)280600`)!;
    for (const [unread, expAgree] of [
      [base({ kind: "unreadable", readability: 0.2, expiry: f<string>(null, 0) }), null],
      [base({ readability: 0.3, expiry: f<string>(null, 0) }), null],
      [base({ ingredient: f(ing, 0.59), strength: f(good, 0.95), expiry: f<string>(null, 0.2), readability: 0.45 }), null],
      [base({ ingredient: f(ing, 0.59), strength: f(good, 0.95), expiry: f("2028-06", 0.9), readability: 0.6 }), "non_conflict"],
    ] as const) {
      cases.push({
        family: "dm_unreadable_print",
        read: unread,
        code: validCode,
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: "unsure",
        expectCrossCheckAgrees: expAgree,
        confTag: unread.readability,
      });
    }
  }

  for (let i = 0; i < meds.length; i++) {
    for (let j = 0; j < meds.length; j++) {
      if (i === j) continue;
      const [ingA, goodA] = meds[i];
      const gtinB = meds[j][5];
      for (const sc of [0.79, 0.95]) {
        cases.push({
          family: "dm_gtin_conflict",
          read: base({ ingredient: f(ingA, 0.95), strength: f(goodA, sc), expiry: f("2028-06", 0.9) }),
          code: parseGs1(`(01)${gtinB}(17)280600`)!,
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: "unsure",
          expectCrossCheckAgrees: false,
          confTag: sc,
        });
      }
    }
  }
  for (const [unlistedIng, unlistedStr] of [
    ["paracetamol", "500 mg"],
    ["ibuprofen", "400 mg"],
    ["felodipine", "5 mg"],
  ] as const) {
    for (const gtin of [AML_GTIN, MET_GTIN]) {
      for (const nc of [0.6, 0.95]) {
        cases.push({
          family: "dm_gtin_conflict",
          read: base({ ingredient: f(unlistedIng, nc), strength: f(unlistedStr, 0.95), expiry: f("2028-06", 0.9) }),
          code: parseGs1(`(01)${gtin}(17)280600`)!,
          prof: demoProfile(),
          safeConfidentMatch: false,
          expectedLevel: "unsure",
          expectCrossCheckAgrees: false,
          confTag: nc,
        });
      }
    }
  }

  const unitProfile = demoProfile([], [
    { id: "aml25", name: "Norvasc", ingredient: "amlodipine", strength: "2.5 mg", schedule: ["evening"] },
    { id: "lor05", name: "Temesta", ingredient: "lorazepam", strength: "0.5 mg", schedule: ["evening"] },
    { id: "thy100", name: "Thyroxin", ingredient: "levothyroxine", strength: "100 mikrog", schedule: ["morning"] },
    { id: "mor20", name: "Oramorph", ingredient: "morphine", strength: "20 mg/ml", schedule: ["morning"] },
    { id: "fen25", name: "Matrifen", ingredient: "fentanyl", strength: "25 mcg/h", schedule: ["morning"] },
  ]);
  const unitSpecs: { ing: string; eq: string[]; bad: string[] }[] = [
    { ing: "amlodipine", eq: ["2.5 mg", "2,5 mg", "2.5mg"], bad: ["25 mg", "0.25 mg", "0,25 mg", "5 mg"] },
    { ing: "lorazepam", eq: ["0.5 mg", "0,5 mg", "500 mcg", "500 mikrog"], bad: ["5 mg", "5,0 mg", "0.05 mg", "50 mg"] },
    {
      ing: "levothyroxine",
      eq: ["100 mikrog", "100 mcg", "100 \u00b5g", "100 \u03bcg", "0.1 mg", "0,1 mg"],
      bad: ["100 mg", "10 mg", "1 mg", "25 mikrog", "50 mcg"],
    },
    { ing: "morphine", eq: ["20 mg/ml", "20 mg / ml", "100 mg/5 ml", "100 mg / 5 ml"], bad: ["20 mg/5 ml", "100 mg/ml", "5 mg/ml", "5 mg/5 ml"] },
    {
      ing: "fentanyl",
      eq: ["25 mcg/h", "25 \u00b5g/h", "25 mikrog/tunti", "25 mikrog/tim"],
      bad: ["25 mcg", "25 mg/h", "50 mcg/h", "25 mcg/24 h", "12 mcg/h"],
    },
  ];
  for (const spec of unitSpecs) {
    for (const sc of [0.79, 0.8, 0.95]) {
      const ok = sc >= STRENGTH_MIN_CONF;
      for (const eqStr of spec.eq) {
        cases.push({
          family: "decimal_unit_strength",
          read: base({ ingredient: f(spec.ing, 0.95), strength: f(eqStr, sc) }),
          prof: unitProfile,
          safeConfidentMatch: ok,
          expectedLevel: ok ? "match" : "unsure",
          confTag: sc,
        });
      }
      for (const badStr of spec.bad) {
        cases.push({
          family: "decimal_unit_strength",
          read: base({ ingredient: f(spec.ing, 0.95), strength: f(badStr, sc) }),
          prof: unitProfile,
          safeConfidentMatch: false,
          expectedLevel: ok ? "warning" : "unsure",
          confTag: sc,
        });
      }
    }
  }

  const lasaPairs: [string, string, string][] = [
    ["amlodipine", "felodipine", "5 mg"],
    ["bisoprolol", "metoprolol", "5 mg"],
    ["nifedipine", "nimodipine", "30 mg"],
    ["omeprazole", "esomeprazole", "20 mg"],
    ["oxazepam", "lorazepam", "10 mg"],
    ["citalopram", "escitalopram", "10 mg"],
    ["zopiclone", "eszopiclone", "5 mg"],
    ["prednisone", "prednisolone", "5 mg"],
    ["dexamethasone", "betamethasone", "4 mg"],
    ["aciclovir", "ganciclovir", "250 mg"],
    ["ofloxacin", "norfloxacin", "400 mg"],
    ["sufentanil", "alfentanil", "50 mcg"],
  ];
  for (const [medA, medB, str] of lasaPairs) {
    for (const [saved, held] of [
      [medA, medB],
      [medB, medA],
    ] as const) {
      const prof = demoProfile([], [{ id: "m1", name: saved, ingredient: saved, strength: str, schedule: ["evening"] }]);
      for (const c of [0.8, 0.95]) {
        cases.push({
          family: "lasa_stem_guard",
          read: base({ product: f(`${held} ${str}`, c), ingredient: f(held, c), strength: f(str, c) }),
          prof,
          safeConfidentMatch: false,
          expectedLevel: "warning",
          confTag: c,
        });
      }
    }
  }

  const singleProfile = demoProfile([], [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["morning"] },
    { id: "ram", name: "Cardace", ingredient: "ramipril", strength: "5 mg", schedule: ["morning"] },
    { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["morning", "evening"] },
    { id: "amx", name: "Amoxin", ingredient: "amoxicillin", strength: "875 mg", schedule: ["morning", "evening"] },
  ]);
  const comboVsSingle: Partial<LabelRead>[] = [
    { product: f("Exforge 5/160 mg"), strength: f("5/160 mg") },
    { product: f("Exforge 5/160 mg"), strength: f("5 mg") },
    { product: f("Amlodipine/Valsartan"), ingredient: f("amlodipine, valsartan"), strength: f("5 mg") },
    { product: f("Panacod 500/30 mg"), strength: f("500/30 mg") },
    { product: f("Panacod 500/30 mg"), strength: f("500 mg") },
    { product: f("Panacod"), ingredient: f("paracetamol + codeine phosphate"), strength: f("500 mg + 30 mg") },
    { product: f("Cardace Comp 5/25 mg"), strength: f("5 mg") },
    { product: f("Janumet 50/500 mg"), strength: f("500 mg") },
    { product: f("Synjardy 12.5/500 mg"), strength: f("500 mg") },
    { product: f("Augmentin 875/125 mg"), ingredient: f("amoxicillin, clavulanic acid"), strength: f("875 mg") },
  ];
  for (const partial of comboVsSingle) {
    for (const c of [0.8, 0.95]) {
      cases.push({
        family: "combo_drug_guard",
        read: base({
          ...partial,
          product: partial.product ? f(partial.product.value, c) : f(null, 0),
          ingredient: partial.ingredient ? f(partial.ingredient.value, c) : f(null, 0),
          strength: partial.strength ? f(partial.strength.value, c) : f(null, 0),
        }),
        prof: singleProfile,
        safeConfidentMatch: false,
        expectedLevel: "warning",
        confTag: c,
      });
    }
  }

  const savedComboProfile = demoProfile([], [
    { id: "exf", name: "Exforge", ingredient: "amlodipine, valsartan", strength: "5/160 mg", schedule: ["morning"] },
    { id: "pcd", name: "Panacod", ingredient: "paracetamol, codeine", strength: "500/30 mg", schedule: ["evening"] },
    { id: "sta", name: "Stalevo", ingredient: "levodopa, carbidopa, entacapone", strength: "100/25/200 mg", schedule: ["morning"] },
  ]);
  for (const [prod, ing, str] of [
    ["Amlodipine 5 mg", "amlodipine", "5 mg"],
    ["Valsartan 160 mg", "valsartan", "160 mg"],
    ["Panadol 500 mg", "paracetamol", "500 mg"],
    ["Sinemet 100/25 mg", "levodopa, carbidopa", "100/25 mg"],
  ] as const) {
    for (const c of [0.8, 0.95]) {
      cases.push({
        family: "combo_drug_guard",
        read: base({ product: f(prod, c), ingredient: f(ing, c), strength: f(str, c) }),
        prof: savedComboProfile,
        safeConfidentMatch: false,
        expectedLevel: "warning",
        confTag: c,
      });
    }
  }
  for (const [prod, ing, str] of [
    ["Exforge", "amlodipine, valsartan", "5 mg + 160 mg"],
    ["Amlodipine/Valsartan", "valsartan, amlodipine besilate", "5/160 mg"],
    ["Panacod", "paracetamol, codeine phosphate", "500/30 mg"],
    ["Stalevo", "levodopa, carbidopa, entacapone", "100/25/200 mg"],
  ] as const) {
    for (const sc of [0.79, 0.8, 0.95]) {
      const ok = sc >= STRENGTH_MIN_CONF;
      cases.push({
        family: "combo_drug_guard",
        read: base({ product: f(prod, 0.95), ingredient: f(ing, 0.95), strength: f(str, sc) }),
        prof: savedComboProfile,
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: sc,
      });
    }
  }

  const leftDecoy: RawItem = {
    box: [300, 100, 700, 300],
    read: base({ product: f("Panadol 500 mg"), ingredient: f("paracetamol"), strength: f("500 mg") }),
    answers: false,
  };
  const centerDecoy: RawItem = {
    box: [300, 400, 700, 600],
    read: base({ product: f("Burana 400 mg"), ingredient: f("ibuprofen"), strength: f("400 mg") }),
    answers: false,
  };
  const rightBox = (r: LabelRead, answers = true): RawItem => ({ box: [300, 700, 700, 900], read: r, answers });

  for (const [ing, good, wrong, id, , , query] of meds) {
    for (const sc of [0.5, 0.79, 0.8, 0.95]) {
      const ok = sc >= STRENGTH_MIN_CONF;
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing), strength: f(good, sc) })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: sc,
      });
    }
    for (const nc of [0.59, 0.79, 0.8, 0.95]) {
      const ok = nc >= MATCH_NAME_MIN_CONF;
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing, nc), strength: f(good, 0.95) })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: nc,
      });
    }
    for (const rd of [0.49, 0.5, 0.9]) {
      const ok = rd >= MATCH_MIN_READABILITY;
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing, 0.95), strength: f(good, 0.95), readability: rd })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(),
        safeConfidentMatch: ok,
        expectedLevel: ok ? "match" : "unsure",
        confTag: rd,
      });
    }
    for (const sc of [0.79, 0.95]) {
      const ok = sc >= STRENGTH_MIN_CONF;
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing), strength: f(wrong[0], sc) })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: ok ? "warning" : "unsure",
        confTag: sc,
      });
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing), strength: f(good, sc), expiry: f("2024-11", 0.9) })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: ok ? "warning" : "unsure",
        confTag: sc,
      });
      cases.push({
        family: "scene_zero_guess",
        scene: { items: [rightBox(base({ ingredient: f(ing), strength: f(good, sc) })), leftDecoy, centerDecoy], target: query },
        prof: demoProfile(id === "met" ? ["met", "met"] : [id]),
        safeConfidentMatch: false,
        expectedLevel: ok ? "warning" : "unsure",
        confTag: sc,
      });
    }
  }

  for (const [decoyProd, decoyIng, decoyStr] of [
    ["Felodipine 5 mg", "felodipine", "5 mg"],
    ["Exforge 5/160 mg", "amlodipine, valsartan", "5/160 mg"],
  ] as const) {
    for (const ans of [true, false]) {
      cases.push({
        family: "scene_zero_guess",
        scene: {
          items: [rightBox(base({ product: f(decoyProd), ingredient: f(decoyIng), strength: f(decoyStr) }), ans), leftDecoy, centerDecoy],
          target: "which one is my evening pill?",
        },
        prof: demoProfile(),
        safeConfidentMatch: false,
        expectedLevel: "warning",
        confTag: 0.95,
      });
    }
  }

  const badFoodItem: RawItem = {
    box: [0, 50, 500, 250],
    read: base({ kind: "food", product: f("Hazelnut bar"), allergens: f(["hazelnut", "milk"], 0.95), readability: 0.92 }),
    answers: false,
  };
  for (const [ac, rd] of [
    [0.94, 0.95],
    [0.95, 0.79],
    [0.95, 0.8],
    [0.99, 0.95],
  ] as const) {
    const safeInfo = ac >= ALLERGEN_SAFE_CONF && rd >= ALLERGEN_SAFE_READABILITY;
    const candidateFood: RawItem = {
      box: [0, 650, 500, 950],
      read: base({ kind: "food", product: f("Oat biscuits"), allergens: f(["oats", "wheat"], ac), readability: rd }),
      answers: true,
    };
    cases.push({
      family: "scene_food_gate",
      scene: { items: [badFoodItem, candidateFood], target: "which one has no nuts?" },
      prof: demoProfile(),
      safeConfidentMatch: false,
      safeInfoAllowed: safeInfo,
      expectedLevel: safeInfo ? "info" : "warning",
      confTag: ac,
    });
    cases.push({
      family: "scene_food_gate",
      scene: { items: [candidateFood], target: "which one has no nuts?" },
      prof: demoProfile(),
      safeConfidentMatch: false,
      safeInfoAllowed: safeInfo,
      expectedLevel: safeInfo ? "info" : "unsure",
      confTag: ac,
    });
  }

  return cases;
}

export type FamilyStats = { n: number; match: number; info: number; warning: number; unsure: number; unsafe: number };

export type RulesEvalOutput = {
  n: number;
  unsafe_reassurance: number;
  unsafe_reassurance_rate: number;
  unsafe_reassurance_ci95_wilson: [number, number];
  rule_of_three_95_upper: number;
  match_recall_on_safe_confident: number | null;
  match_recall_ci95_wilson: [number, number] | null;
  safe_confident_eligible: number;
  safe_confident_matched: number;
  food_safe_reassurance_recall: number | null;
  verdict_mismatch_count: number;
  by_family: Record<string, FamilyStats>;
  unsafe_examples: unknown[];
  strength_min_conf: number;
  match_name_min_conf: number;
  match_min_readability: number;
  allergen_safe_conf: number;
  allergen_safe_readability: number;
  impl: string;
  now: string;
};

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function crossCheckMatches(actual: boolean | null | undefined, expected: CrossCheckExpectation | undefined): boolean {
  if (expected === undefined) return true;
  const val = actual ?? null;
  if (expected === "non_conflict") return val === null || val === true;
  return val === expected;
}

export function runRulesEval(): RulesEvalOutput {
  const cases = buildRuleCases();
  const by: Record<string, FamilyStats> = {};
  const unsafeEx: unknown[] = [];
  let unsafe = 0;
  let correctMatch = 0;
  let correctEligible = 0;
  let foodSafeEligible = 0;
  let foodSafeReassured = 0;
  let verdictMismatch = 0;

  for (const k of cases) {
    const v: Verdict = k.scene
      ? buildSceneVerdict(k.scene.items, k.prof, k.scene.target, RULES_NOW)
      : checkLabel(k.read!, k.prof, RULES_NOW, k.code);

    const b = (by[k.family] ??= { n: 0, match: 0, info: 0, warning: 0, unsure: 0, unsafe: 0 });
    b.n++;
    if (v.level === "match") b.match++;
    if (v.level === "info") b.info++;
    if (v.level === "warning") b.warning++;
    if (v.level === "unsure") b.unsure++;

    const levelOk = Array.isArray(k.expectedLevel) ? k.expectedLevel.includes(v.level) : v.level === k.expectedLevel;
    if (!levelOk) verdictMismatch++;
    if (!crossCheckMatches(v.crossCheck?.agrees, k.expectCrossCheckAgrees)) verdictMismatch++;
    if (wordCount(v.headline) > 8 || sentenceCount(v.speech) > 2) verdictMismatch++;
    if ((v.items ?? []).some((it) => wordCount(it.headline) > 6)) verdictMismatch++;

    const badMatch = v.level === "match" && !k.safeConfidentMatch;
    const badInfo = v.level === "info" && !k.safeInfoAllowed;
    const missingHedge = v.level === "info" && !!k.requireAllergenHedge && !v.speech.includes("can't see an allergen list");
    const isUnsafe = badMatch || badInfo || missingHedge;

    if (isUnsafe) {
      unsafe++;
      b.unsafe++;
      if (unsafeEx.length < 10) unsafeEx.push({ family: k.family, conf: k.confTag, level: v.level, speech: v.speech });
    }
    if (k.safeConfidentMatch) {
      correctEligible++;
      if (v.level === "match") correctMatch++;
    }
    if (k.safeInfoAllowed && !k.requireAllergenHedge) {
      foodSafeEligible++;
      if (v.level === "info") foodSafeReassured++;
    }
  }

  return {
    n: cases.length,
    unsafe_reassurance: unsafe,
    unsafe_reassurance_rate: unsafe / cases.length,
    unsafe_reassurance_ci95_wilson: wilsonCi95(unsafe, cases.length),
    rule_of_three_95_upper: ruleOfThree95Upper(cases.length, unsafe),
    match_recall_on_safe_confident: correctEligible ? correctMatch / correctEligible : null,
    match_recall_ci95_wilson: correctEligible ? wilsonCi95(correctMatch, correctEligible) : null,
    safe_confident_eligible: correctEligible,
    safe_confident_matched: correctMatch,
    food_safe_reassurance_recall: foodSafeEligible ? foodSafeReassured / foodSafeEligible : null,
    verdict_mismatch_count: verdictMismatch,
    by_family: by,
    unsafe_examples: unsafeEx,
    strength_min_conf: STRENGTH_MIN_CONF,
    match_name_min_conf: MATCH_NAME_MIN_CONF,
    match_min_readability: MATCH_MIN_READABILITY,
    allergen_safe_conf: ALLERGEN_SAFE_CONF,
    allergen_safe_readability: ALLERGEN_SAFE_READABILITY,
    impl: "server/src/safety.ts checkLabel + server/src/find.ts buildSceneVerdict",
    now: RULES_NOW.toISOString(),
  };
}

test("zero-guess medication thresholds enforce exact 0.80, 0.60, and 0.50 boundaries", () => {
  assert.equal(STRENGTH_MIN_CONF, 0.8);
  assert.equal(MATCH_NAME_MIN_CONF, 0.8);
  assert.equal(MATCH_MIN_READABILITY, 0.5);

  const prof = demoProfile();

  const strLow = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.79) }), prof, RULES_NOW);
  assert.equal(strLow.level, "unsure");
  assert.equal(strLow.matchedMedId, "aml");
  assert.equal(strLow.speech.includes("5 mg"), false);

  const strHigh = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.8) }), prof, RULES_NOW);
  assert.equal(strHigh.level, "match");
  assert.equal(strHigh.matchedMedId, "aml");
  assert.equal(strHigh.speech.includes("5 mg"), true);

  const wrongStrLow = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("10 mg", 0.79) }), prof, RULES_NOW);
  assert.equal(wrongStrLow.level, "unsure");
  assert.equal(wrongStrLow.speech.includes("10 mg"), false);

  const wrongStrHigh = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("10 mg", 0.8) }), prof, RULES_NOW);
  assert.equal(wrongStrHigh.level, "warning");
  assert.equal(wrongStrHigh.speech.includes("10 mg"), true);

  const matchNameLow = checkLabel(base({ ingredient: f("amlodipine", 0.79), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(matchNameLow.level, "unsure");
  assert.equal(matchNameLow.matchedMedId, "aml");

  const matchNameHigh = checkLabel(base({ ingredient: f("amlodipine", 0.8), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(matchNameHigh.level, "match");
  assert.equal(matchNameHigh.matchedMedId, "aml");

  const brandNameLow = checkLabel(base({ product: f("Norvasc", 0.79), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(brandNameLow.level, "unsure");
  const brandNameHigh = checkLabel(base({ product: f("Norvasc", 0.8), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(brandNameHigh.level, "match");

  const unlistedNameLow = checkLabel(base({ product: f("Panadol", 0.59), ingredient: f("paracetamol", 0.59), strength: f("500 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(unlistedNameLow.level, "unsure");
  const unlistedNameHigh = checkLabel(base({ product: f("Panadol", 0.6), ingredient: f("paracetamol", 0.6), strength: f("500 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(unlistedNameHigh.level, "warning");

  const savedBelowNameMin = checkLabel(base({ ingredient: f("amlodipine", 0.59), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(savedBelowNameMin.level, "unsure");
  assert.equal(savedBelowNameMin.matchedMedId, undefined);
  const savedAtNameMin = checkLabel(base({ ingredient: f("amlodipine", 0.6), strength: f("5 mg", 0.95) }), prof, RULES_NOW);
  assert.equal(savedAtNameMin.level, "unsure");
  assert.equal(savedAtNameMin.matchedMedId, "aml");

  const readLow = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), readability: 0.49 }), prof, RULES_NOW);
  assert.equal(readLow.level, "unsure");
  const readHigh = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), readability: 0.5 }), prof, RULES_NOW);
  assert.equal(readHigh.level, "match");

  for (const v of [strLow, strHigh, wrongStrLow, wrongStrHigh, matchNameLow, matchNameHigh, unlistedNameLow, unlistedNameHigh, readLow, readHigh]) {
    assert.ok(wordCount(v.headline) <= 8);
    assert.ok(sentenceCount(v.speech) <= 2);
  }
});

test("food allergen reassurance gate requires 0.95 conf and 0.80 readability while warnings fire at >= 0.60 and blurry other hedges", () => {
  assert.equal(ALLERGEN_SAFE_CONF, 0.95);
  assert.equal(ALLERGEN_SAFE_READABILITY, 0.8);

  const prof = demoProfile();

  const conf094 = checkLabel(base({ kind: "food", product: f("Oat drink"), allergens: f(["oats"], 0.94), readability: 0.95 }), prof, RULES_NOW);
  assert.equal(conf094.level, "unsure");

  const read079 = checkLabel(base({ kind: "food", product: f("Oat drink"), allergens: f(["oats"], 0.95), readability: 0.79 }), prof, RULES_NOW);
  assert.equal(read079.level, "unsure");

  const safe095And080 = checkLabel(base({ kind: "food", product: f("Oat drink"), allergens: f(["oats"], 0.95), readability: 0.8 }), prof, RULES_NOW);
  assert.equal(safe095And080.level, "info");
  assert.match(safe095And080.speech, /no tree nuts and peanut listed/i);

  const empty094 = checkLabel(base({ kind: "food", product: f("Water"), allergens: f([], 0.94), readability: 0.95 }), prof, RULES_NOW);
  assert.equal(empty094.level, "unsure");
  const empty095 = checkLabel(base({ kind: "food", product: f("Water"), allergens: f([], 0.95), readability: 0.8 }), prof, RULES_NOW);
  assert.equal(empty095.level, "info");

  const warnAt060 = checkLabel(base({ kind: "food", product: f("Granola"), allergens: f(["oats", "hazelnut"], 0.6), readability: 0.5 }), prof, RULES_NOW);
  assert.equal(warnAt060.level, "warning");
  assert.match(warnAt060.speech, /hazelnut/i);

  const mayContainAt060 = checkLabel(base({ kind: "food", product: f("Snack bar"), allergens: f(["may contain: peanut"], 0.6), readability: 0.55 }), prof, RULES_NOW);
  assert.equal(mayContainAt060.level, "warning");
  assert.match(mayContainAt060.headline, /may contain peanut/i);

  const blurryOther = checkLabel(base({ kind: "other", product: f("Recovery Gel", 0.95), allergens: f<string[]>(null, 0), expiry: f(null, 0), readability: 0.49 }), prof, RULES_NOW);
  assert.equal(blurryOther.level, "unsure");

  const clearOther = checkLabel(base({ kind: "other", product: f("Recovery Gel", 0.95), allergens: f<string[]>(null, 0), expiry: f(null, 0), readability: 0.5 }), prof, RULES_NOW);
  assert.equal(clearOther.level, "info");
  assert.match(clearOther.speech, /can't see an allergen list/);
});

test("EU FMD GS1 DataMatrix cross-check enforces agreement, expiry and GTIN conflicts, and expired rescue", () => {
  const prof = demoProfile();

  const parenCode = parseGs1(`(01)${AML_GTIN}(17)280600(10)B1(21)S1`);
  const rawCode = parseGs1(`]d201${AML_GTIN}1728063010B1\x1d21S1`);
  assert.ok(parenCode);
  assert.ok(rawCode);
  assert.equal(parenCode.gtin, AML_GTIN);
  assert.equal(parenCode.expiry, "2028-06");
  assert.equal(rawCode.expiry, "2028-06-30");

  for (const code of [parenCode, rawCode]) {
    const okMatch = checkLabel(base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), expiry: f("2028-06", 0.9) }), prof, RULES_NOW, code);
    assert.equal(okMatch.level, "match");
    assert.equal(okMatch.crossCheck?.agrees, true);
    assert.match(okMatch.speech, /double-checked with the pack's code/);
    assert.ok(sentenceCount(okMatch.speech) <= 2);
  }

  const ean13Match = checkLabel(
    base({ ingredient: f("atorvastatin", 0.95), strength: f("20 mg", 0.95), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parseGs1(`(01)${ATO_GTIN14}(17)280600`)!,
  );
  assert.equal(ean13Match.level, "match");
  assert.equal(ean13Match.crossCheck?.agrees, true);

  const unsureNonConflictName = checkLabel(
    base({ ingredient: f("amlodipine", 0.59), strength: f("5 mg", 0.95), expiry: f("2028-06", 0.9), readability: 0.6 }),
    prof,
    RULES_NOW,
    parenCode,
  );
  assert.equal(unsureNonConflictName.level, "unsure");
  assert.ok(unsureNonConflictName.crossCheck?.agrees === null || unsureNonConflictName.crossCheck?.agrees === true);

  const unsureNonConflictStrength = checkLabel(
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.79), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parenCode,
  );
  assert.equal(unsureNonConflictStrength.level, "unsure");
  assert.ok(unsureNonConflictStrength.crossCheck?.agrees === null || unsureNonConflictStrength.crossCheck?.agrees === true);

  const expiryConflict = checkLabel(
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parseGs1(`(01)${AML_GTIN}(17)280300`)!,
  );
  assert.equal(expiryConflict.level, "unsure");
  assert.equal(expiryConflict.crossCheck?.agrees, false);
  assert.match(expiryConflict.speech, /disagree/i);

  const gtinConflictSaved = checkLabel(
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parseGs1(`(01)${MET_GTIN}(17)280600`)!,
  );
  assert.equal(gtinConflictSaved.level, "unsure");
  assert.equal(gtinConflictSaved.crossCheck?.agrees, false);

  const gtinConflictUnlisted = checkLabel(
    base({ ingredient: f("paracetamol", 0.95), strength: f("500 mg", 0.95), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parenCode,
  );
  assert.equal(gtinConflictUnlisted.level, "unsure");
  assert.equal(gtinConflictUnlisted.crossCheck?.agrees, false);

  const expiredRescue = checkLabel(
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), expiry: f("2028-09", 0.65) }),
    prof,
    RULES_NOW,
    parseGs1(`(01)${AML_GTIN}(17)241100`)!,
  );
  assert.equal(expiredRescue.level, "warning");
  assert.match(expiredRescue.speech, /expired in November 2024/);

  const gtinWrongStrength = checkLabel(
    base({ ingredient: f("amlodipine", 0.95), strength: f("10 mg", 0.95), expiry: f("2028-06", 0.9) }),
    prof,
    RULES_NOW,
    parenCode,
  );
  assert.ok(gtinWrongStrength.level === "warning" || gtinWrongStrength.level === "unsure");
  assert.notEqual(gtinWrongStrength.level, "match");
  assert.ok(gtinWrongStrength.crossCheck !== undefined);
});

test("buildSceneVerdict enforces multi-box zero-guess, blocks < 0.8 strength dose leaks, and propagates avoid warnings", () => {
  const prof = demoProfile();
  const leftPanadol: RawItem = {
    box: [300, 100, 700, 300],
    read: base({ product: f("Panadol 500 mg"), ingredient: f("paracetamol", 0.95), strength: f("500 mg", 0.95) }),
    answers: false,
  };
  const midBurana: RawItem = {
    box: [300, 400, 700, 600],
    read: base({ product: f("Burana 400 mg"), ingredient: f("ibuprofen", 0.95), strength: f("400 mg", 0.95) }),
    answers: false,
  };

  const sceneMatch = buildSceneVerdict(
    [
      { box: [300, 700, 700, 900], read: base({ ingredient: f("amlodipine", 0.8), strength: f("5 mg", 0.8), readability: 0.5 }), answers: true },
      leftPanadol,
      midBurana,
    ],
    prof,
    "which one is my evening pill?",
    RULES_NOW,
  );
  assert.equal(sceneMatch.mode, "scene");
  assert.equal(sceneMatch.level, "match");
  assert.equal(sceneMatch.matchedMedId, "aml");
  assert.equal(sceneMatch.items?.find((i) => i.position === "center")?.level, "warning");

  for (const weakRead of [
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.79), readability: 0.9 }),
    base({ ingredient: f("amlodipine", 0.79), strength: f("5 mg", 0.95), readability: 0.9 }),
    base({ ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.95), readability: 0.49 }),
  ]) {
    const v = buildSceneVerdict(
      [{ box: [300, 700, 700, 900], read: weakRead, answers: true }, leftPanadol, midBurana],
      prof,
      "which one is my evening pill?",
      RULES_NOW,
    );
    assert.equal(v.level, "unsure");
    assert.equal(v.matchedMedId, undefined);
    assert.equal(v.items?.find((i) => i.position === "right")?.level, "unsure");
    assert.equal(v.items?.find((i) => i.position === "right")?.matchedMedId, undefined);
  }

  const lowStrengthItems: RawItem[] = [
    {
      box: [300, 150, 700, 350],
      read: base({ product: f("Panadol 500 mg", 0.95), ingredient: f(null, 0), strength: f("500 mg", 0.79) }),
      answers: false,
    },
    {
      box: [300, 650, 700, 850],
      read: base({ product: f("Norvasc 5 mg", 0.95), ingredient: f("amlodipine", 0.95), strength: f("5 mg", 0.79) }),
      answers: true,
    },
  ];
  const untargetedLow = buildSceneVerdict(lowStrengthItems, prof, undefined, RULES_NOW);
  const targetedLow = buildSceneVerdict(lowStrengthItems, prof, "which one is my evening pill?", RULES_NOW);
  for (const v of [untargetedLow, targetedLow]) {
    assert.equal(v.headline.includes("5 mg"), false);
    assert.equal(v.speech.includes("5 mg"), false);
    assert.equal(v.headline.includes("500 mg"), false);
    assert.equal(v.speech.includes("500 mg"), false);
    for (const item of v.items ?? []) {
      assert.equal(item.headline.includes("5 mg"), false);
      assert.equal(item.headline.includes("500 mg"), false);
      assert.ok(wordCount(item.headline) <= 6);
    }
  }

  const savedAvoidProfile = demoProfile([], [
    { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["evening"] },
  ]);
  const savedAvoidScene = buildSceneVerdict(
    [
      leftPanadol,
      { box: [300, 700, 700, 900], read: base({ product: f("Burana 400 mg"), ingredient: f("ibuprofen", 0.95), strength: f("400 mg", 0.95) }), answers: true },
    ],
    savedAvoidProfile,
    "which one is my evening pill?",
    RULES_NOW,
  );
  assert.equal(savedAvoidScene.level, "warning");
  assert.equal(savedAvoidScene.matchedMedId, undefined);
  assert.match(savedAvoidScene.speech, /on your avoid list/);
  assert.match(savedAvoidScene.items?.find((i) => i.position === "right")?.headline ?? "", /avoid/);

  const absentWithAvoid = buildSceneVerdict(
    [
      { box: [300, 150, 700, 350], read: base({ kind: "food", product: f("Oat drink"), allergens: f(["oats"], 0.98), readability: 0.95 }), answers: false },
      midBurana,
    ],
    prof,
    "which one is my evening pill?",
    RULES_NOW,
  );
  assert.equal(absentWithAvoid.level, "warning");
});

test("runRulesEval matrix covers >= 800 deterministic cases with zero unsafe reassurances and calibrated bounds", () => {
  assert.deepEqual(wilsonCi95(0, 0), [0, 1]);
  assert.equal(ruleOfThree95Upper(0), 1);
  assert.equal(ruleOfThree95Upper(1000, 0), 0.003);
  assert.equal(ruleOfThree95Upper(500, 2), wilsonCi95(2, 500)[1]);

  const cases = buildRuleCases();
  assert.ok(cases.length >= 800);

  const out = runRulesEval();
  assert.equal(out.n, cases.length);
  assert.ok(out.n >= 800);
  assert.equal(out.unsafe_reassurance, 0);
  assert.equal(out.unsafe_reassurance_rate, 0);
  assert.equal(out.verdict_mismatch_count, 0);
  assert.equal(out.match_recall_on_safe_confident, 1);
  assert.equal(out.food_safe_reassurance_recall, 1);
  assert.deepEqual(out.unsafe_examples, []);

  const [ciLow, ciHigh] = out.unsafe_reassurance_ci95_wilson;
  assert.equal(ciLow, 0);
  assert.ok(ciHigh > 0 && ciHigh <= 0.005);
  assert.equal(out.rule_of_three_95_upper, +(3 / out.n).toFixed(4));
  assert.ok(out.rule_of_three_95_upper > 0 && out.rule_of_three_95_upper <= 0.0038);

  assert.ok(out.match_recall_ci95_wilson !== null);
  assert.equal(out.match_recall_ci95_wilson[1], 1);
  assert.ok(out.match_recall_ci95_wilson[0] > 0.95);

  const familyTotal = Object.values(out.by_family).reduce((sum, b) => sum + b.n, 0);
  assert.equal(familyTotal, out.n);
  for (const [family, b] of Object.entries(out.by_family)) {
    assert.ok(b.n > 0, family);
    assert.equal(b.unsafe, 0, family);
  }

  assert.deepEqual(runRulesEval(), out);
});
