import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { LabelRead, Profile, Verdict } from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import {
  assignPositions,
  buildSceneVerdict,
  FIND_PROMPT,
  findItems,
  SCENE_SCHEMA,
  toRawItems,
  type RawItem,
} from "../src/find.ts";
import { ai } from "../src/gemini.ts";
import { stats } from "../src/ledger.ts";
import { LABEL_SCHEMA, VERIFY_PROMPT } from "../src/verify.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const origGenerateContent = ai.models.generateContent;
const origLedgerPath = env.ledgerPath;
const origQuiet = process.env.HOLDUP_QUIET;
process.env.HOLDUP_QUIET = "1";

const tempDirs: string[] = [];

function useTempLedger(): string {
  const root = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, "holdup-find-edges-"));
  tempDirs.push(dir);
  const ledgerFile = path.join(dir, "ledger.jsonl");
  env.ledgerPath = ledgerFile;
  return ledgerFile;
}

async function waitForLines(filePath: string, expectedCount: number, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      if (lines.length >= expectedCount) return lines;
    } catch {
      void 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const finalLines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean) : [];
  assert.equal(finalLines.length, expectedCount);
  return finalLines;
}

afterEach(() => {
  ai.models.generateContent = origGenerateContent;
  env.ledgerPath = origLedgerPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  ai.models.generateContent = origGenerateContent;
  env.ledgerPath = origLedgerPath;
  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

function collectKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function mkRead(partial: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2027-08", 0.95),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...partial,
  };
}

const baseProfile: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine besilate", strength: "5 mg", schedule: ["evening"] },
    { id: "met", name: "Glucophage", ingredient: "metformin hydrochloride", strength: "500 mg", schedule: ["morning"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["noon"] },
  ],
  allergies: ["peanut", "tree nuts"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertVerdictBounds(v: Verdict) {
  assert.equal(v.mode, "scene");
  assert.ok(wordCount(v.headline) <= 8, `top headline exceeds 8 words: "${v.headline}"`);
  assert.ok(sentenceCount(v.speech) <= 2, `speech exceeds 2 sentences: "${v.speech}"`);
  assert.ok(Array.isArray(v.items));
  for (const item of v.items) {
    assert.ok(wordCount(item.headline) <= 6, `item headline exceeds 6 words: "${item.headline}"`);
  }
}

test("SCENE_SCHEMA strips $ref, $defs, and $comment recursively and matches inlined LABEL_SCHEMA", () => {
  const rawScene = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "shared", "scene_schema.json"), "utf8"));
  assert.equal(typeof rawScene.$comment, "string");
  assert.equal(rawScene.properties.items.items.properties.read.$ref, "label_schema.json");

  const keys = collectKeys(SCENE_SCHEMA);
  assert.equal(keys.has("$ref"), false);
  assert.equal(keys.has("$comment"), false);
  assert.equal(keys.has("$defs"), false);

  const serialized = JSON.stringify(SCENE_SCHEMA);
  assert.equal(serialized.includes('"$ref"'), false);
  assert.equal(serialized.includes('"$comment"'), false);
  assert.equal(serialized.includes('"$defs"'), false);

  assert.equal(SCENE_SCHEMA.type, "object");
  assert.deepEqual(SCENE_SCHEMA.required, ["items"]);
  assert.equal(SCENE_SCHEMA.properties.items.type, "array");
  assert.equal(SCENE_SCHEMA.properties.items.maxItems, 6);
  assert.deepEqual(SCENE_SCHEMA.properties.items.items.required, ["box_2d", "read"]);
  assert.deepEqual(SCENE_SCHEMA.properties.items.items.properties.box_2d, {
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 1000 },
    minItems: 4,
    maxItems: 4,
  });
  assert.deepEqual(SCENE_SCHEMA.properties.items.items.properties.answers_target, { type: "boolean" });
  assert.equal(SCENE_SCHEMA.properties.items.items.properties.read, LABEL_SCHEMA);
  assert.deepEqual(SCENE_SCHEMA.properties.items.items.properties.read, LABEL_SCHEMA);

  const rawFindPrompt = fs.readFileSync(path.join(REPO_ROOT, "shared", "find_prompt.md"), "utf8");
  assert.equal(FIND_PROMPT, `${rawFindPrompt}\n\n${VERIFY_PROMPT}`);
});

test("toRawItems clamps and rounds box_2d coordinates into [0..1000] and drops malformed box_2d arrays", () => {
  const res = toRawItems({
    items: [
      { box_2d: [-250, -0.4, 1000.4, 1850.9], read: { kind: "medication" }, answers_target: true },
      { box_2d: [12.2, 199.5, 500.6, 999.49], read: { kind: "food" }, answers_target: false },
      { box_2d: [Number.NEGATIVE_INFINITY, 0, 1000, Number.POSITIVE_INFINITY], read: { kind: "other" }, answers_target: true },
      { box_2d: [10, 20, 30], read: { kind: "medication" }, answers_target: false },
      { box_2d: [10, 20, 30, 40, 50], read: { kind: "medication" }, answers_target: false },
      { box_2d: ["10", 20, 30, 40], read: { kind: "medication" }, answers_target: false },
    ],
  });

  assert.equal(res.length, 6);
  assert.deepEqual(res[0].box, [0, 0, 1000, 1000]);
  assert.deepEqual(res[1].box, [12, 200, 501, 999]);
  assert.deepEqual(res[2].box, [0, 0, 1000, 1000]);
  assert.equal(res[3].box, undefined);
  assert.equal(res[4].box, undefined);
  assert.equal(res[5].box, undefined);

  const moreMalformed = toRawItems({
    items: [
      { box_2d: [] },
      { box_2d: [10, null, 30, 40] },
      { box_2d: [10, undefined, 30, 40] },
      { box_2d: "0,0,100,100" },
      { box_2d: { ymin: 0, xmin: 0, ymax: 100, xmax: 100 } },
      { box_2d: null },
    ],
  });
  assert.equal(moreMalformed.length, 6);
  for (const item of moreMalformed) {
    assert.equal(item.box, undefined);
  }
});

test("toRawItems caps items at 6, handles null/primitive/missing inputs safely, and coerces answers_target strictly to boolean", () => {
  for (const invalidRoot of [null, undefined, 0, 42, false, "bad", {}, { items: null }, { items: "none" }, { items: 7 }, { items: {} }]) {
    assert.deepEqual(toRawItems(invalidRoot), []);
  }

  const primitiveElements = toRawItems({ items: [null, undefined, 0, "pkg", false, {}] });
  assert.equal(primitiveElements.length, 6);
  for (const it of primitiveElements) {
    assert.equal(it.box, undefined);
    assert.equal(it.read.kind, "unreadable");
    assert.equal(it.read.readability, 0);
    assert.equal(it.answers, false);
  }

  const nineItems = Array.from({ length: 9 }, (_, idx) => ({
    box_2d: [100, idx * 100, 300, idx * 100 + 80],
    read: { kind: "medication", product: { value: `Med-${idx}`, confidence: 0.9 }, readability: 0.8 },
    answers_target: idx === 0,
  }));
  const capped = toRawItems({ items: nineItems });
  assert.equal(capped.length, 6);
  assert.deepEqual(
    capped.map((c) => c.read.product.value),
    ["Med-0", "Med-1", "Med-2", "Med-3", "Med-4", "Med-5"],
  );

  const truthyVariants = [true, false, "true", 1, {}, [], null, undefined, 0];
  const boolChecked = [
    ...toRawItems({ items: truthyVariants.slice(0, 6).map((v) => ({ answers_target: v })) }),
    ...toRawItems({ items: truthyVariants.slice(6).map((v) => ({ answers_target: v })) }),
  ];
  assert.deepEqual(
    boolChecked.map((x) => x.answers),
    [true, false, false, false, false, false, false, false, false],
  );
  for (const x of boolChecked) {
    assert.equal(typeof x.answers, "boolean");
  }
});

test("assignPositions across 0, 1, 2, 3, 4, 5, and 6 packages sorts left-to-right without mutating input", () => {
  assert.deepEqual(assignPositions([]), []);

  assert.deepEqual(assignPositions([{ id: "a", box: [0, 20, 100, 140] as [number, number, number, number] }]).map((i) => i.position), ["far_left"]);
  assert.deepEqual(assignPositions([{ id: "b", box: [0, 210, 100, 350] as [number, number, number, number] }]).map((i) => i.position), ["left"]);
  assert.deepEqual(assignPositions([{ id: "c", box: [0, 420, 100, 560] as [number, number, number, number] }]).map((i) => i.position), ["center"]);
  assert.deepEqual(assignPositions([{ id: "d", box: undefined }]).map((i) => i.position), ["center"]);
  assert.deepEqual(assignPositions([{}]).map((i) => i.position), ["center"]);
  assert.deepEqual(assignPositions([{ id: "e", box: [0, 620, 100, 760] as [number, number, number, number] }]).map((i) => i.position), ["right"]);
  assert.deepEqual(assignPositions([{ id: "f", box: [0, 820, 100, 980] as [number, number, number, number] }]).map((i) => i.position), ["far_right"]);
  assert.deepEqual(assignPositions([{ id: "g", box: [0, 1000, 100, 1000] as [number, number, number, number] }]).map((i) => i.position), ["far_right"]);

  const two = [
    { id: "r", box: [0, 800, 100, 920] as [number, number, number, number] },
    { id: "l", box: [0, 620, 100, 700] as [number, number, number, number] },
  ];
  const twoSnapshot = two.map((x) => x.id);
  const twoPlaced = assignPositions(two);
  assert.deepEqual(two.map((x) => x.id), twoSnapshot);
  assert.deepEqual(twoPlaced.map((x) => [x.id, x.position]), [["l", "left"], ["r", "right"]]);

  const three = [
    { id: "3", box: [0, 700, 100, 900] as [number, number, number, number] },
    { id: "1", box: [0, 50, 100, 150] as [number, number, number, number] },
    { id: "2", box: [0, 350, 100, 450] as [number, number, number, number] },
  ];
  assert.deepEqual(assignPositions(three).map((x) => [x.id, x.position]), [
    ["1", "left"],
    ["2", "center"],
    ["3", "right"],
  ]);

  const four = [
    { id: "4", box: [0, 820, 100, 940] as [number, number, number, number] },
    { id: "2", box: [0, 260, 100, 360] as [number, number, number, number] },
    { id: "1", box: [0, 40, 100, 120] as [number, number, number, number] },
    { id: "3", box: [0, 560, 100, 660] as [number, number, number, number] },
  ];
  assert.deepEqual(assignPositions(four).map((x) => [x.id, x.position]), [
    ["1", "far_left"],
    ["2", "left"],
    ["3", "right"],
    ["4", "far_right"],
  ]);

  const five = [
    { id: "5", box: [0, 860, 100, 960] as [number, number, number, number] },
    { id: "3", box: [0, 440, 100, 540] as [number, number, number, number] },
    { id: "1", box: [0, 20, 100, 100] as [number, number, number, number] },
    { id: "4", box: [0, 660, 100, 760] as [number, number, number, number] },
    { id: "2", box: [0, 220, 100, 320] as [number, number, number, number] },
  ];
  assert.deepEqual(assignPositions(five).map((x) => [x.id, x.position]), [
    ["1", "far_left"],
    ["2", "left"],
    ["3", "center"],
    ["4", "right"],
    ["5", "far_right"],
  ]);

  const six = [
    { id: "6", box: [0, 900, 100, 980] as [number, number, number, number] },
    { id: "2", box: [0, 120, 100, 180] as [number, number, number, number] },
    { id: "5", box: [0, 650, 100, 750] as [number, number, number, number] },
    { id: "1", box: [0, 10, 100, 90] as [number, number, number, number] },
    { id: "4", box: [0, 450, 100, 550] as [number, number, number, number] },
    { id: "3", box: [0, 250, 100, 350] as [number, number, number, number] },
  ];
  assert.deepEqual(assignPositions(six).map((x) => [x.id, x.position]), [
    ["1", "far_left"],
    ["2", "far_left"],
    ["3", "left"],
    ["4", "center"],
    ["5", "right"],
    ["6", "far_right"],
  ]);
});

test("buildSceneVerdict across 0, 1, 2, 3, 4, 5, and 6 packages maintains positions, mode, and bounds", () => {
  const v0 = buildSceneVerdict([], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(v0);
  assert.equal(v0.level, "unsure");
  assert.equal(v0.headline, "Can't see any packages");
  assert.equal(v0.speech, "I can't make out any packages yet. Step back a little so they're all in view.");
  assert.deepEqual(v0.items, []);
  assert.deepEqual(v0.reasons, []);
  assert.equal(v0.read.kind, "unreadable");

  const pkgAml: RawItem = { box: [100, 20, 400, 140], read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }), answers: true };
  const pkgMet: RawItem = { box: [100, 220, 400, 340], read: mkRead({ ingredient: f("metformin"), strength: f("500 mg") }), answers: false };
  const pkgPar: RawItem = { box: [100, 440, 400, 560], read: mkRead({ ingredient: f("paracetamol"), strength: f("500 mg") }), answers: false };
  const pkgIbu: RawItem = { box: [100, 640, 400, 760], read: mkRead({ ingredient: f("ibuprofen"), strength: f("400 mg") }), answers: false };
  const pkgOat: RawItem = {
    box: [100, 840, 400, 960],
    read: mkRead({ kind: "food", product: f("Oat crackers"), allergens: f(["oats"], 0.97), readability: 0.9 }),
    answers: false,
  };
  const pkgExtraLeft: RawItem = {
    box: [100, 130, 400, 190],
    read: mkRead({ kind: "other", product: f("Hand cream"), allergens: f([], 0.96), readability: 0.9 }),
    answers: false,
  };

  const v1 = buildSceneVerdict([{ ...pkgAml, box: undefined }], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(v1);
  assert.equal(v1.level, "match");
  assert.equal(v1.matchedMedId, "aml");
  assert.equal(v1.items!.length, 1);
  assert.equal(v1.items![0].position, "center");
  assert.equal("box" in v1.items![0], false);
  assert.match(v1.speech, /in the middle/);

  const v2 = buildSceneVerdict([pkgMet, pkgAml], baseProfile, "which one is my morning pill?", NOW);
  assertVerdictBounds(v2);
  assert.equal(v2.level, "match");
  assert.equal(v2.matchedMedId, "met");
  assert.deepEqual(v2.items!.map((i) => i.position), ["left", "right"]);
  assert.match(v2.speech, /Your morning pill is the box on the right\./);

  const v3 = buildSceneVerdict([pkgPar, pkgAml, pkgMet], baseProfile, "which one is my noon pill?", NOW);
  assertVerdictBounds(v3);
  assert.equal(v3.level, "match");
  assert.equal(v3.matchedMedId, "par");
  assert.deepEqual(v3.items!.map((i) => i.position), ["left", "center", "right"]);
  assert.match(v3.speech, /on the right/);

  const v4 = buildSceneVerdict([pkgOat, pkgPar, pkgMet, pkgAml], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(v4);
  assert.equal(v4.level, "match");
  assert.equal(v4.matchedMedId, "aml");
  assert.deepEqual(v4.items!.map((i) => i.position), ["far_left", "left", "right", "far_right"]);
  assert.match(v4.speech, /Your evening pill is the box on the far left\./);

  const v5 = buildSceneVerdict([pkgOat, pkgIbu, pkgPar, pkgMet, pkgAml], baseProfile, "which one is my noon pill?", NOW);
  assertVerdictBounds(v5);
  assert.equal(v5.level, "match");
  assert.equal(v5.matchedMedId, "par");
  assert.deepEqual(v5.items!.map((i) => i.position), ["far_left", "left", "center", "right", "far_right"]);
  assert.match(v5.speech, /in the middle/);
  assert.match(v5.speech, /The right one is Ibuprofen 400 mg, not on your list\./);

  const v6Desc = buildSceneVerdict([pkgOat, pkgIbu, pkgPar, pkgMet, pkgExtraLeft, pkgAml], baseProfile, undefined, NOW);
  assertVerdictBounds(v6Desc);
  assert.equal(v6Desc.level, "info");
  assert.equal(v6Desc.headline, "6 packages seen");
  assert.equal(v6Desc.items!.length, 6);
  assert.deepEqual(v6Desc.items!.map((i) => i.position), ["far_left", "far_left", "left", "center", "right", "far_right"]);

  const v6Target = buildSceneVerdict([pkgOat, pkgIbu, pkgPar, pkgMet, pkgExtraLeft, pkgAml], baseProfile, "my evening pill", NOW);
  assertVerdictBounds(v6Target);
  assert.equal(v6Target.level, "match");
  assert.equal(v6Target.matchedMedId, "aml");
  assert.equal(v6Target.items!.length, 6);
});

test("buildSceneVerdict safety invariants: hazardous matched medicine returns warning with pick-up prompt and never match", () => {
  const otherBox: RawItem = {
    box: [100, 100, 400, 260],
    read: mkRead({ ingredient: f("paracetamol"), strength: f("500 mg") }),
    answers: false,
  };

  const expiredAml: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2025-04", 0.95) }),
    answers: true,
  };
  const vExpired = buildSceneVerdict([otherBox, expiredAml], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(vExpired);
  assert.equal(vExpired.level, "warning");
  assert.notEqual(vExpired.level, "match");
  assert.equal(vExpired.matchedMedId, undefined);
  assert.equal(vExpired.items![1].matchedMedId, undefined);
  assert.match(vExpired.speech, /expired/);
  assert.match(vExpired.speech, /Pick it up so I can check it\.$/);

  const wrongStrengthAml: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("10 mg") }),
    answers: true,
  };
  const vWrongStrength = buildSceneVerdict([otherBox, wrongStrengthAml], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(vWrongStrength);
  assert.equal(vWrongStrength.level, "warning");
  assert.notEqual(vWrongStrength.level, "match");
  assert.equal(vWrongStrength.matchedMedId, undefined);
  assert.match(vWrongStrength.speech, /wrong strength/);
  assert.match(vWrongStrength.speech, /Pick it up so I can check it\.$/);

  const takenProfile: Profile = {
    ...baseProfile,
    doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 18, 30, 0).getTime() }],
  };
  const validAml: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }),
    answers: true,
  };
  const vTaken = buildSceneVerdict([otherBox, validAml], takenProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(vTaken);
  assert.equal(vTaken.level, "warning");
  assert.notEqual(vTaken.level, "match");
  assert.equal(vTaken.matchedMedId, undefined);
  assert.match(vTaken.speech, /already taken today/);
  assert.match(vTaken.speech, /Pick it up so I can check it\.$/);

  const avoidProfile: Profile = {
    ...baseProfile,
    meds: [...baseProfile.meds, { id: "ibu", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["bedtime"] }],
    avoid: ["NSAIDs"],
  };
  const savedAvoidBox: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("ibuprofen"), strength: f("400 mg") }),
    answers: true,
  };
  const vAvoid = buildSceneVerdict([otherBox, savedAvoidBox], avoidProfile, "which one is my bedtime pill?", NOW);
  assertVerdictBounds(vAvoid);
  assert.equal(vAvoid.level, "warning");
  assert.notEqual(vAvoid.level, "match");
  assert.equal(vAvoid.matchedMedId, undefined);
  assert.match(vAvoid.speech, /on your avoid list/);
  assert.match(vAvoid.speech, /Pick it up so I can check it\.$/);

  const lactoseProfile: Profile = {
    ...baseProfile,
    allergies: ["lactose"],
  };
  const allergenMedBox: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), allergens: f(["lactose"], 0.95) }),
    answers: true,
  };
  const vAllergenMed = buildSceneVerdict([otherBox, allergenMedBox], lactoseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(vAllergenMed);
  assert.equal(vAllergenMed.level, "warning");
  assert.notEqual(vAllergenMed.level, "match");
  assert.equal(vAllergenMed.matchedMedId, undefined);
  assert.match(vAllergenMed.speech, /has an allergen for you/);
  assert.match(vAllergenMed.speech, /Pick it up so I can check it\.$/);

  const unlistedWarnHinted: RawItem = {
    box: [100, 700, 400, 860],
    read: mkRead({ ingredient: f("ibuprofen"), strength: f("400 mg") }),
    answers: true,
  };
  const vUnlistedHint = buildSceneVerdict([otherBox, unlistedWarnHinted], baseProfile, "which one is my evening pill?", NOW);
  assertVerdictBounds(vUnlistedHint);
  assert.equal(vUnlistedHint.level, "warning");
  assert.notEqual(vUnlistedHint.level, "match");
  assert.match(vUnlistedHint.speech, /^I can't see your evening pill here\./);
});

test("buildSceneVerdict food safety invariants: multiple safe foods vs zero safe foods and strict headline/speech limits", () => {
  const safeLeft: RawItem = {
    box: [100, 80, 400, 220],
    read: mkRead({ kind: "food", product: f("Oat biscuits"), allergens: f(["oats", "wheat"], 0.97), readability: 0.91 }),
    answers: true,
  };
  const safeMid: RawItem = {
    box: [100, 420, 400, 580],
    read: mkRead({ kind: "food", product: f("Rice cakes"), allergens: f([], 0.98), readability: 0.93 }),
    answers: true,
  };
  const peanutRight: RawItem = {
    box: [100, 760, 400, 920],
    read: mkRead({ kind: "food", product: f("Crunchy granola bar"), allergens: f(["peanut"], 0.96), readability: 0.92 }),
    answers: false,
  };

  const vMultiSafe = buildSceneVerdict([safeLeft, safeMid, peanutRight], baseProfile, "which one has no nuts?", NOW);
  assertVerdictBounds(vMultiSafe);
  assert.equal(vMultiSafe.level, "info");
  assert.equal(vMultiSafe.headline, "Several look free of your allergens");
  assert.equal(
    vMultiSafe.speech,
    "The left and the middle ones list none of your allergens. The right one is Crunchy granola bar, has an allergen for you.",
  );

  const almondLeft: RawItem = {
    box: [100, 100, 400, 280],
    read: mkRead({ kind: "food", product: f("Dark chocolate"), allergens: f(["may contain: almond"], 0.94), readability: 0.9 }),
    answers: false,
  };
  const vZeroSafeWarn = buildSceneVerdict([almondLeft, peanutRight], baseProfile, "which pack is safe for me?", NOW);
  assertVerdictBounds(vZeroSafeWarn);
  assert.equal(vZeroSafeWarn.level, "warning");
  assert.equal(vZeroSafeWarn.headline, "None clearly free of your allergens");
  assert.match(vZeroSafeWarn.speech, /^I can't find one that's clearly free of peanut and tree nuts\./);
  assert.match(vZeroSafeWarn.speech, /may contain almond/);

  const unclearFoodA: RawItem = {
    box: [100, 100, 400, 280],
    read: mkRead({ kind: "food", product: f("Berry muesli"), allergens: f(["oats"], 0.85), readability: 0.9 }),
    answers: true,
  };
  const unclearFoodB: RawItem = {
    box: [100, 700, 400, 880],
    read: mkRead({ kind: "food", product: f("Corn snacks"), allergens: f<string[]>(null, 0.2), readability: 0.88 }),
    answers: false,
  };
  const vZeroSafeUnsure = buildSceneVerdict([unclearFoodA, unclearFoodB], baseProfile, "which one is nut-free?", NOW);
  assertVerdictBounds(vZeroSafeUnsure);
  assert.equal(vZeroSafeUnsure.level, "unsure");
  assert.equal(vZeroSafeUnsure.headline, "None clearly free of your allergens");
  assert.equal(
    vZeroSafeUnsure.speech,
    "I can't find one that's clearly free of peanut and tree nuts. Pick one up so I can read its ingredients.",
  );

  const verboseProfile: Profile = {
    meds: [
      {
        id: "combo",
        name: "Extra Long Brand Medication Name Forte Tablets",
        ingredient: "amoxicillin trihydrate, clavulanic acid, extra descriptive words",
        strength: "875 mg + 125 mg",
        schedule: ["morning"],
      },
    ],
    allergies: ["peanut", "tree nuts", "milk", "gluten"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };
  const verboseItems: RawItem[] = Array.from({ length: 6 }, (_, idx) => ({
    box: [100, idx * 160 + 20, 400, idx * 160 + 120] as [number, number, number, number],
    read: mkRead({
      kind: idx % 2 === 0 ? "medication" : "food",
      product: f(`Very Long Product Label Title Number ${idx} Extra Words Here`),
      ingredient: idx === 0 ? f("amoxicillin, clavulanic acid") : f("phenoxymethylpenicillin potassium extra words"),
      strength: f("875 mg + 125 mg"),
      allergens: idx % 2 === 1 ? f(["peanut", "milk"], 0.96) : f<string[]>(null, 0),
    }),
    answers: idx === 0,
  }));
  for (const q of [undefined, "which one is my morning pill?", "which one is amoxicillin?", "which one has no nuts?"]) {
    const v = buildSceneVerdict(verboseItems, verboseProfile, q, NOW);
    assertVerdictBounds(v);
  }
});

test("findItems slices frames to max 2, passes target or default prompt, and records ledger under feature find", async () => {
  const ledgerFile = useTempLedger();
  const captured: any[] = [];

  (ai.models as any).generateContent = async (req: any) => {
    captured.push(req);
    return {
      text: JSON.stringify({
        items: [
          {
            box_2d: [200, 650, 700, 900],
            read: {
              kind: "medication",
              product: { value: "Norvasc", confidence: 0.96 },
              ingredient: { value: "amlodipine", confidence: 0.97 },
              strength: { value: "5 mg", confidence: 0.95 },
              dosing: { value: "1 daily", confidence: 0.9 },
              expiry: { value: "2027-08", confidence: 0.94 },
              allergens: { value: null, confidence: 0 },
              barcode: { value: "6432100012345", confidence: 0.9 },
              readability: 0.93,
            },
            answers_target: true,
          },
          {
            box_2d: [200, 100, 700, 350],
            read: {
              kind: "medication",
              product: { value: "Glucophage", confidence: 0.96 },
              ingredient: { value: "metformin", confidence: 0.97 },
              strength: { value: "500 mg", confidence: 0.95 },
              dosing: { value: "1 daily", confidence: 0.9 },
              expiry: { value: "2027-08", confidence: 0.94 },
              allergens: { value: null, confidence: 0 },
              barcode: { value: "6432100099999", confidence: 0.9 },
              readability: 0.93,
            },
            answers_target: false,
          },
        ],
      }),
      usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 110, thoughtsTokenCount: 16 },
    };
  };

  const rTargeted = await findItems(["f1", "f2", "f3", "f4"], baseProfile, "  which one is my evening pill?  ");
  assert.equal(captured.length, 1);
  const req1 = captured[0];
  assert.equal(req1.config.systemInstruction, FIND_PROMPT);
  assert.equal(req1.config.responseMimeType, "application/json");
  assert.equal(req1.config.responseJsonSchema, SCENE_SCHEMA);

  const parts1 = req1.contents[0].parts as any[];
  assert.equal(parts1.length, 3);
  assert.deepEqual(parts1[0], { inlineData: { mimeType: "image/jpeg", data: "f1" } });
  assert.deepEqual(parts1[1], { inlineData: { mimeType: "image/jpeg", data: "f2" } });
  assert.deepEqual(parts1[2], { text: 'The person asked: "which one is my evening pill?"' });

  assert.equal(rTargeted.model, env.verifyModels[0]);
  assertVerdictBounds(rTargeted.verdict);
  assert.equal(rTargeted.verdict.level, "match");
  assert.equal(rTargeted.verdict.matchedMedId, "aml");
  await waitForLines(ledgerFile, 1);

  const rDefaultUndef = await findItems(["single-frame"], baseProfile);
  assert.equal(captured.length, 2);
  const parts2 = captured[1].contents[0].parts as any[];
  assert.equal(parts2.length, 2);
  assert.deepEqual(parts2[0], { inlineData: { mimeType: "image/jpeg", data: "single-frame" } });
  assert.deepEqual(parts2[1], { text: "Describe which package is which." });
  assert.equal(rDefaultUndef.verdict.level, "info");
  await waitForLines(ledgerFile, 2);

  const rDefaultBlank = await findItems(["blank-frame"], baseProfile, "   ");
  assert.equal(captured.length, 3);
  assert.deepEqual(captured[2].contents[0].parts[1], { text: "Describe which package is which." });
  assert.equal(rDefaultBlank.verdict.level, "info");
  await waitForLines(ledgerFile, 3);

  const longQuestion = "q".repeat(260);
  await findItems(["fA", "fB", "fC"], baseProfile, longQuestion);
  assert.equal(captured.length, 4);
  const parts4 = captured[3].contents[0].parts as any[];
  assert.equal(parts4.length, 3);
  assert.deepEqual(parts4[2], { text: `The person asked: "${"q".repeat(200)}"` });

  const lines = await waitForLines(ledgerFile, 4);
  const rows = lines.map((l) => JSON.parse(l));
  assert.equal(rows[0].feature, "find");
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].n_frames, 2);
  assert.equal(rows[0].in, 420);
  assert.equal(rows[0].out, 110);
  assert.equal(rows[0].thinking, 16);
  assert.equal(rows[1].feature, "find");
  assert.equal(rows[1].n_frames, 1);
  assert.equal(rows[2].feature, "find");
  assert.equal(rows[2].n_frames, 1);
  assert.equal(rows[3].feature, "find");
  assert.equal(rows[3].n_frames, 2);

  const s = stats();
  assert.equal((s.features.find as any).calls, 4);
  assert.equal((s.features.find as any).ok, 4);
});

test("findItems returns fallback unsure verdict with reader unavailable on model failure or invalid JSON", async () => {
  assert.equal(ai.models.generateContent, origGenerateContent);

  const failLedger = useTempLedger();
  let failCalls = 0;
  (ai.models as any).generateContent = async () => {
    failCalls++;
    throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
  };

  const failed = await findItems(["f1", "f2", "f3"], baseProfile, "which one is my evening pill?");
  assert.ok(failCalls >= 1);
  assert.equal(failed.model, null);
  assertVerdictBounds(failed.verdict);
  assert.equal(failed.verdict.level, "unsure");
  assert.equal(failed.verdict.headline, "Can't see any packages");
  assert.equal(failed.verdict.speech, "I couldn't check the table just now. Pick one up and I'll read it.");
  assert.ok(failed.verdict.reasons.includes("reader unavailable"));
  assert.deepEqual(failed.verdict.items, []);

  const failRows = (await waitForLines(failLedger, failCalls)).map((l) => JSON.parse(l));
  for (const row of failRows) {
    assert.equal(row.feature, "find");
    assert.equal(row.ok, false);
    assert.equal(row.error, "server");
  }

  const badJsonLedger = useTempLedger();
  let badJsonCalls = 0;
  (ai.models as any).generateContent = async () => {
    badJsonCalls++;
    return { text: "{broken-scene-json", usageMetadata: {} };
  };

  const badJsonRes = await findItems(["f1"], baseProfile);
  assert.ok(badJsonCalls >= 1);
  assert.equal(badJsonRes.model, null);
  assertVerdictBounds(badJsonRes.verdict);
  assert.equal(badJsonRes.verdict.level, "unsure");
  assert.equal(badJsonRes.verdict.speech, "I couldn't check the table just now. Pick one up and I'll read it.");
  assert.ok(badJsonRes.verdict.reasons.includes("reader unavailable"));
  assert.deepEqual(badJsonRes.verdict.items, []);

  const badJsonRows = (await waitForLines(badJsonLedger, badJsonCalls)).map((l) => JSON.parse(l));
  for (const row of badJsonRows) {
    assert.equal(row.feature, "find");
    assert.equal(row.ok, false);
    assert.equal(row.error, "bad_json");
  }
});

test("afterEach restores ai.models.generateContent to original implementation", () => {
  assert.equal(ai.models.generateContent, origGenerateContent);
});
