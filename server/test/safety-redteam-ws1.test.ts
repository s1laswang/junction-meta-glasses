import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LabelRead, Med, Profile } from "../../shared/types.ts";
import { parseGs1 } from "../src/gs1.ts";
import { allergenHits, avoidHits, checkLabel, isExpired, matchMed, parseStrength, sameStrength } from "../src/safety.ts";

const NOW = new Date("2026-11-14T12:00:00+02:00");
const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function mkRead(p: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2028-06"),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...p,
  };
}

function mkProfile(meds: Med[], extra: Partial<Profile> = {}): Profile {
  return { meds, allergies: [], avoid: [], doseLog: [], lang: "en", ...extra };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertBounds(headline: string, speech: string, tag: string) {
  assert.ok(wordCount(headline) <= 8, `${tag}: headline > 8 words: "${headline}"`);
  assert.ok(sentenceCount(speech) <= 2, `${tag}: speech > 2 sentences: "${speech}"`);
}

test("WS1 Patch 1 (F03): distinct insulin analogs at 100 IU/ml never cross-match while equivalent brands/units match", () => {
  const analogs: Array<[string, string]> = [
    ["Lantus SoloStar", "insulin glargine"],
    ["Humalog KwikPen", "insulin lispro"],
    ["NovoRapid FlexPen", "insulin aspart"],
    ["Levemir FlexPen", "insulin detemir"],
    ["Tresiba FlexTouch", "insulin degludec"],
    ["Protaphane FlexPen", "insulin isophane"],
    ["Actrapid FlexPen", "human insulin"],
  ];

  for (let i = 0; i < analogs.length; i++) {
    for (let j = 0; j < analogs.length; j++) {
      const [savedBrand, savedIng] = analogs[i];
      const [heldBrand, heldIng] = analogs[j];
      const prof = mkProfile([{ id: "ins", name: savedBrand, ingredient: savedIng, strength: "100 IU/ml", schedule: ["evening"] }]);
      const v = checkLabel(mkRead({ product: f(heldBrand), ingredient: f(heldIng), strength: f("100 KY/ml") }), prof, NOW);
      assertBounds(v.headline, v.speech, `${savedBrand}->${heldBrand}`);
      if (i === j) {
        assert.equal(v.level, "match", `same analog must match: ${heldIng}`);
      } else {
        assert.equal(v.level, "warning", `${heldIng} must NEVER match ${savedIng}`);
        assert.equal(v.matchedMedId, undefined);
      }
    }
  }

  // Bare "glargine" in profile must still match "ABASAGLAR KwikPen" ("insulin glargine")
  const bareGlargine = mkProfile([{ id: "g1", name: "Lantus", ingredient: "glargine", strength: "100 IU/ml", schedule: ["evening"] }]);
  const abasaglar = checkLabel(mkRead({ product: f("ABASAGLAR KwikPen"), ingredient: f("insulin glargine"), strength: f("100 KY/ml") }), bareGlargine, NOW);
  assert.equal(abasaglar.level, "match");
});

test("WS1 Patch 2 (F04): multi-word inorganic salts, nitrates, mycophenolate, and epoetin subtypes never cross-match", () => {
  const distinctPairs: Array<[string, string, string, string, string]> = [
    ["Kaleorid", "potassium chloride", "Natriumklorid", "sodium chloride", "750 mg"],
    ["Lito", "lithium carbonate", "Kalsiumkarbonaatti", "calcium carbonate", "300 mg"],
    ["Ferrous Gluconate", "ferrous gluconate", "Calcium Gluconate", "calcium gluconate", "300 mg"],
    ["Natriumbikarbonaatti", "sodium bicarbonate", "Kaliumbikarbonaatti", "potassium bicarbonate", "500 mg"],
    ["Isosorbide Dinitrate", "isosorbide dinitrate", "Ismo", "isosorbide mononitrate", "20 mg"],
    ["Epoetin Beta", "epoetin beta", "Epoetin Alfa", "epoetin alfa", "2000 IU"],
    ["Myfortic", "mycophenolate sodium", "CellCept", "mycophenolate mofetil", "500 mg"],
    ["Myfortic", "mycophenolic acid", "CellCept", "mycophenolate mofetil", "360 mg"],
    ["Leucovorin", "folinic acid", "Folvite", "folic acid", "5 mg"],
  ];

  for (const [heldProd, heldIng, savedName, savedIng, st] of distinctPairs) {
    const prof = mkProfile([{ id: "m1", name: savedName, ingredient: savedIng, strength: st, schedule: ["morning"] }]);
    const v = checkLabel(mkRead({ product: f(heldProd), ingredient: f(heldIng), strength: f(st) }), prof, NOW);
    assert.equal(v.level, "warning", `${heldIng} vs ${savedIng}`);
    assert.equal(v.matchedMedId, undefined, `${heldIng} vs ${savedIng}`);
    assertBounds(v.headline, v.speech, `${heldIng}:${savedIng}`);
  }
});

test("WS1 Patch 3 (F05): short alphanumeric vitamin subtypes never cross-match while chemical INNs match their vitamin", () => {
  const distinctVitamins: Array<[string, string, string, string, string]> = [
    ["Orion Vitamin A", "vitamin A", "Orion Vitamin D3", "Vitamin D3", "1000 IU"],
    ["B6-vitamiini Ratiopharm", "pyridoxine", "B12-vitamiini Ratiopharm", "Vitamin B12", "1 mg"],
    ["Teva Vitamin B1", "thiamine", "Teva Vitamin C", "Vitamin C", "100 mg"],
    ["K2-vitamiini Orion", "menaquinone", "D3-vitamiini Orion", "Vitamin D3", "100 mikrog"],
    ["Apoteket Vitamin K2", "vitamin K2", "Apoteket Vitamin K1", "Vitamin K1", "75 mikrog"],
    ["Apoteket Vitamin E", "vitamin E", "Apoteket Vitamin C", "Vitamin C", "100 mg"],
  ];

  for (const [heldProd, heldIng, savedName, savedIng, st] of distinctVitamins) {
    const prof = mkProfile([{ id: "v1", name: savedName, ingredient: savedIng, strength: st, schedule: ["morning"] }]);
    const v = checkLabel(mkRead({ product: f(heldProd), ingredient: f(heldIng), strength: f(st) }), prof, NOW);
    assert.equal(v.level, "warning", `${heldProd} (${heldIng}) vs ${savedName} (${savedIng})`);
    assert.equal(v.matchedMedId, undefined);
    assertBounds(v.headline, v.speech, heldProd);
  }

  // Positive control: chemical INN matches its corresponding vitamin code
  const b6Prof = mkProfile([{ id: "b6", name: "Vitamin B6", ingredient: "Vitamin B6", strength: "10 mg", schedule: ["morning"] }]);
  assert.equal(checkLabel(mkRead({ product: f("Pyridoxine Orion"), ingredient: f("pyridoxine"), strength: f("10 mg") }), b6Prof, NOW).level, "match");

  const d3Prof = mkProfile([{ id: "d3", name: "Devisol", ingredient: "Vitamin D3", strength: "50 mikrog", schedule: ["morning"] }]);
  assert.equal(checkLabel(mkRead({ product: f("D3-vitamiini"), ingredient: f("colecalciferol"), strength: f("50 mcg") }), d3Prof, NOW).level, "match");
});

test("WS1 Patch 4 (F11): topical mg/g concentrations reject solid oral mg tablets while matching equivalent mg/g", () => {
  assert.equal(sameStrength("10 mg/g", "10 mg"), false);
  assert.equal(sameStrength("50 mg/g", "50 mg"), false);
  assert.equal(sameStrength("25 mg/g", "25 mg/ml"), false);
  assert.equal(sameStrength("10 mg/g", "10 mg per gram"), true);
  assert.equal(sameStrength("23,2 mg/g", "23.2 mg/gramma"), true);
  assert.ok(parseStrength("10 mg/g").length === 2);

  const oralHydro = mkProfile([{ id: "hc", name: "Hydrocortison", ingredient: "hydrocortisone", strength: "10 mg", schedule: ["morning"] }]);
  const topicalCream = checkLabel(
    mkRead({ product: f("Hydrocortison Orion 10 mg/g emulsiovoide"), ingredient: f("hydrocortisone"), strength: f("10 mg/g") }),
    oralHydro,
    NOW,
  );
  assert.equal(topicalCream.level, "warning");
  assert.match(topicalCream.headline, /wrong strength/);
  assertBounds(topicalCream.headline, topicalCream.speech, "hydrocortisone-topical-vs-oral");
});

test("WS1 Patch 5 (F10 & F18): Nordic pharmacy chains, pen devices, and HCT combo suffixes never cause false matches", () => {
  const esoProf = mkProfile([{ id: "eso", name: "Esomeprazol Apoteket", ingredient: "esomeprazole", strength: "20 mg", schedule: ["morning"] }]);
  const omeRead = mkRead({ product: f("Omeprazol Apoteket"), ingredient: f("omeprazole"), strength: f("20 mg") });
  assert.equal(matchMed(omeRead, esoProf.meds), undefined);
  assert.equal(checkLabel(omeRead, esoProf, NOW).level, "warning");

  const losartanProf = mkProfile([{ id: "los", name: "Losartan Orion", ingredient: "losartan", strength: "50 mg", schedule: ["morning"] }]);
  const hctRead = mkRead({ product: f("Losartan HCT Orion 50 mg"), ingredient: f(null, 0.2), strength: f("50 mg") });
  assert.equal(matchMed(hctRead, losartanProf.meds), undefined);
  assert.equal(checkLabel(hctRead, losartanProf, NOW).level, "warning");
});

test("WS1 Patch 6 & 7 (F24-F27): molluscs, shellfish, confectionery tree-nut terms, gluten oats, E220-E228, and Nordic inflections warn", () => {
  // Molluscs & shellfish
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Panda Brand Oyster Sauce"), allergens: f(["oyster", "wheat"], 0.95) }), mkProfile([], { allergies: ["molluscs"] }), NOW).level,
    "warning",
  );
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("ICA Bläckfiskringar"), allergens: f(["molluscs", "wheat"], 0.95) }), mkProfile([], { allergies: ["shellfish"] }), NOW).level,
    "warning",
  );
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Eldorado Ostronsås"), allergens: f(["mollusc", "soy"], 0.95) }), mkProfile([], { allergies: ["molluscs"] }), NOW).level,
    "warning",
  );

  // Confectionery tree-nut terms in product/ingredient when omitted from allergens array
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Fazerina Praline Truffles"), ingredient: f("praline truffles"), allergens: f(["milk", "soy"], 0.95) }), mkProfile([], { allergies: ["tree nuts"] }), NOW).level,
    "warning",
  );
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Mignon Marzipan Bar"), ingredient: f("marzipan bar"), allergens: f(["soy"], 0.95) }), mkProfile([], { allergies: ["tree nuts"] }), NOW).level,
    "warning",
  );

  // Nordic gluten cereal inflections (vetemjöl, vehnäjauho, semolina, durum) warn while pure oats without gluten stay info
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Knäckebröd"), allergens: f(["vetemjöl"], 0.95) }), mkProfile([], { allergies: ["gluten"] }), NOW).level,
    "warning",
  );
  assert.equal(
    checkLabel(mkRead({ kind: "food", product: f("Gluten Free Pure Oat Drink"), allergens: f(["oats"], 0.95) }), mkProfile([], { allergies: ["gluten"] }), NOW).level,
    "info",
  );

  // Finnish/Swedish inflected forms, saattaa sisaltaa / spar av, and sulphite E-numbers
  const fiMay = allergenHits(mkRead({ kind: "food", allergens: f(["Saattaa sisältää maapähkinää ja mantelia"]) }), ["peanut", "tree nuts"]);
  assert.equal(fiMay.length, 2);
  assert.equal(fiMay[0].mayContain, true);

  const svMay = allergenHits(mkRead({ kind: "food", allergens: f(["Kan innehålla spår av jordnötter och hasselnötter"]) }), ["peanut"]);
  assert.equal(svMay.length, 1);
  assert.equal(svMay[0].mayContain, true);

  const e223 = allergenHits(mkRead({ kind: "food", allergens: f(["potassium metabisulfite (E224)"]) }), ["sulphite"]);
  assert.equal(e223.length, 1);
});

test("WS1 Patch 8 (F29 & calendar): brand-only drug allergies (Amorion/V-Pen/Treo), matched-med class check, and calendar overflow guard", () => {
  const penProf = mkProfile([{ id: "amx", name: "Amorion", ingredient: "amoxicillin", strength: "500 mg", schedule: ["morning"] }], { allergies: ["penicillin"] });
  const occludedInn = mkRead({ product: f("AMORION"), ingredient: f(null, 0.3), strength: f("500 mg") });
  const vAmorion = checkLabel(occludedInn, penProf, NOW);
  assert.equal(vAmorion.level, "warning");
  assert.match(vAmorion.speech, /penicillin/i);
  assertBounds(vAmorion.headline, vAmorion.speech, "amorion-penicillin");

  const treoAvoid = avoidHits(mkRead({ product: f("Treo 500 mg/50 mg"), strength: f("500/50 mg") }), ["NSAIDs"]);
  assert.equal(treoAvoid.length, 1);

  // Invalid calendar month/day never overflows into a future valid date
  assert.equal(isExpired("2025-15-03", NOW), undefined);
  assert.equal(isExpired("2026-00", NOW), undefined);
  assert.equal(isExpired("2026-02-30", NOW), undefined);
});

test("WS1 Red-Team Fixture Suite: every unsafe case from eval/redteam/fixtures/*.json is verified", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixDir = path.resolve(here, "../../eval/redteam/fixtures");
  const files = fs.readdirSync(fixDir).filter((fn) => fn.endsWith(".json")).sort();
  assert.ok(files.length >= 180, `expected >= 180 redteam fixtures, found ${files.length}`);

  let fixedBySafetyCount = 0;
  let defenseInDepthCount = 0;

  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % 25 === 0) await new Promise((r) => setImmediate(r));
    const fn = files[idx];
    const fix = JSON.parse(fs.readFileSync(path.join(fixDir, fn), "utf8"));
    const now = new Date(fix.eval_now_iso || "2026-11-14T12:00:00+02:00");
    const v = checkLabel(fix.read, fix.profile, now);
    assertBounds(v.headline, v.speech, fix.id);

    if (fix.fixed_by_safety_ts !== false) {
      fixedBySafetyCount++;
      assert.ok(
        v.level === "warning" || v.level === "unsure",
        `fixture ${fix.id} (${fix.family}) expected warning/unsure after safety.ts patch, got ${v.level}: ${v.speech}`,
      );
    } else {
      defenseInDepthCount++;
      // Physical-crop or blurred-year OCR boundary case: verify EU FMD DataMatrix cross-check or uncropped excipient detection catches it
      if (fix.family.startsWith("F21") && fix.pack_gs1_raw) {
        const gs1 = parseGs1(fix.pack_gs1_raw);
        assert.ok(gs1, `valid GS1 on ${fix.id}`);
        const vCode = checkLabel(fix.read, fix.profile, now, gs1);
        assert.ok(vCode.level === "warning" || vCode.level === "unsure", `DataMatrix cross-check must block false match on ${fix.id}, got ${vCode.level}`);
      } else if (fix.gt_summary?.allergens?.length) {
        const uncropped: LabelRead = { ...fix.read, allergens: { value: fix.gt_summary.allergens, confidence: 0.9 } };
        const vFull = checkLabel(uncropped, fix.profile, now);
        assert.equal(vFull.level, "warning", `uncropped excipient read must warn on ${fix.id}`);
      }
    }
  }

  assert.ok(fixedBySafetyCount >= 185, `expected >= 185 fixtures fixed directly by safety.ts, got ${fixedBySafetyCount}`);
  assert.equal(fixedBySafetyCount + defenseInDepthCount, files.length);
});
