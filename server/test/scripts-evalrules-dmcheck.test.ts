import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { LabelRead, Profile, Verdict } from "../../shared/types.ts";
import { REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { buildSceneVerdict, type RawItem } from "../src/find.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const EVAL_RULES_SCRIPT = path.join(SERVER_DIR, "scripts", "eval-rules.ts");
const DM_CHECK_SCRIPT = path.join(SERVER_DIR, "scripts", "dm-check.ts");
const DM_FIXTURE_JPG = path.join(SERVER_DIR, "fixtures", "dm_amlodipine.jpg");

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

const profile: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine besilate", strength: "5 mg", schedule: ["evening"] },
  ],
  allergies: ["peanut", "tree nuts"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

const EM_DASH = String.fromCharCode(0x2014);

function assertSceneBounds(v: Verdict) {
  assert.equal(v.mode, "scene");
  assert.ok(wordCount(v.headline) <= 8, `verdict headline exceeds 8 words: "${v.headline}"`);
  assert.ok(sentenceCount(v.speech) <= 2, `verdict speech exceeds 2 sentences: "${v.speech}"`);
  assert.equal(v.headline.includes(EM_DASH), false);
  assert.equal(v.speech.includes(EM_DASH), false);
  assert.ok(Array.isArray(v.items));
  for (const item of v.items) {
    assert.ok(wordCount(item.headline) <= 6, `item headline exceeds 6 words: "${item.headline}"`);
    assert.equal(item.headline.includes(EM_DASH), false);
  }
}

function runTsxScript(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("buildSceneVerdict strips Nordic and combo strength tails from product names without duplicating strength", () => {
  const nordicAndComboCases: Array<{
    product: string;
    strength: string;
    expectedLabel: string;
    duplicatePattern: RegExp;
  }> = [
    {
      product: "Thyroxin 100 mikrog",
      strength: "100 mikrog",
      expectedLabel: "Thyroxin 100 mikrog",
      duplicatePattern: /100\s*mikrog\b.*100\s*mikrog/i,
    },
    {
      product: "Thyroxin 100 mikrogrammaa tabletti",
      strength: "100 mikrog",
      expectedLabel: "Thyroxin 100 mikrog",
      duplicatePattern: /100\s*mikrog(?:rammaa)?\b.*100\s*mikrog/i,
    },
    {
      product: "Levaxin 50 ug",
      strength: "50 ug",
      expectedLabel: "Levaxin 50 ug",
      duplicatePattern: /50\s*ug\b.*50\s*ug/i,
    },
    {
      product: "Levaxin 50 \u00b5g tabletti",
      strength: "50 \u00b5g",
      expectedLabel: "Levaxin 50 \u00b5g",
      duplicatePattern: /50\s*[\u00b5\u03bc]g\b.*50\s*[\u00b5\u03bc]g/i,
    },
    {
      product: "Devisol 1000 KY",
      strength: "1000 KY",
      expectedLabel: "Devisol 1000 KY",
      duplicatePattern: /1000\s*KY\b.*1000\s*KY/i,
    },
    {
      product: "Hydrocortison 1 %",
      strength: "1 %",
      expectedLabel: "Hydrocortison 1 %",
      duplicatePattern: /1\s*%.*1\s*%/i,
    },
    {
      product: "Hydrocortison 1 % emulsiovoide",
      strength: "1 %",
      expectedLabel: "Hydrocortison 1 %",
      duplicatePattern: /1\s*%.*1\s*%/i,
    },
    {
      product: "Exforge 5 mg / 160 mg",
      strength: "5 mg / 160 mg",
      expectedLabel: "Exforge 5 mg / 160 mg",
      duplicatePattern: /5\s*mg\s*\/\s*160\s*mg.*5\s*mg\s*\/\s*160\s*mg/i,
    },
    {
      product: "Exforge 5/160 mg kalvopaallysteinen tabletti",
      strength: "5 mg / 160 mg",
      expectedLabel: "Exforge 5 mg / 160 mg",
      duplicatePattern: /5\s*(?:mg\s*)?\/\s*160\s*mg.*5\s*mg\s*\/\s*160\s*mg/i,
    },
  ];

  const eveningAml: RawItem = {
    box: [100, 700, 400, 900],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }),
    answers: true,
  };

  for (const c of nordicAndComboCases) {
    const unlistedItem: RawItem = {
      box: [100, 100, 400, 300],
      read: mkRead({ product: f(c.product), ingredient: f(null, 0), strength: f(c.strength) }),
      answers: false,
    };

    const untargeted = buildSceneVerdict([unlistedItem, eveningAml], profile, undefined, NOW);
    assertSceneBounds(untargeted);
    assert.ok(
      untargeted.speech.includes(`${c.expectedLabel} on the left`),
      `expected "${c.expectedLabel} on the left" in "${untargeted.speech}"`,
    );
    assert.doesNotMatch(untargeted.speech, c.duplicatePattern);
    assert.doesNotMatch(untargeted.items![0].headline, c.duplicatePattern);

    const targeted = buildSceneVerdict([unlistedItem, eveningAml], profile, "which one is my evening pill?", NOW);
    assertSceneBounds(targeted);
    assert.equal(targeted.level, "match");
    assert.equal(targeted.matchedMedId, "aml");
    assert.ok(
      targeted.speech.includes(`The left one is ${c.expectedLabel}, not on your list.`),
      `expected clean warning label "${c.expectedLabel}" in "${targeted.speech}"`,
    );
    assert.doesNotMatch(targeted.speech, c.duplicatePattern);
    assert.doesNotMatch(targeted.items![0].headline, c.duplicatePattern);
  }

  const strengthOnlyFood: RawItem = {
    box: [100, 200, 400, 500],
    read: mkRead({ kind: "food", product: f("500 g"), allergens: f([], 0.98), readability: 0.92 }),
    answers: true,
  };
  const fallbackVerdict = buildSceneVerdict([strengthOnlyFood], profile, "which pack has no nuts?", NOW);
  assertSceneBounds(fallbackVerdict);
  assert.ok(fallbackVerdict.speech.includes("500 g"));
  assert.equal(fallbackVerdict.items![0].headline, "500 g");
});

test("buildSceneVerdict strips salt suffixes on unlisted ingredients including ibuprofen lysine and metoprolol succinate", () => {
  const saltCases: Array<{
    product: string;
    ingredient: string;
    strength: string;
    expectedLabel: string;
    forbiddenSalt: RegExp;
  }> = [
    {
      product: "Burana Caps 400 mg",
      ingredient: "ibuprofen lysine",
      strength: "400 mg",
      expectedLabel: "Ibuprofen 400 mg",
      forbiddenSalt: /\blysine\b/i,
    },
    {
      product: "Seloken ZOC 50 mg",
      ingredient: "metoprolol succinate",
      strength: "50 mg",
      expectedLabel: "Metoprolol 50 mg",
      forbiddenSalt: /\bsuccinate\b/i,
    },
    {
      product: "Amlodipin Orion 10 mg",
      ingredient: "amlodipine besilate",
      strength: "10 mg",
      expectedLabel: "Amlodipine 10 mg",
      forbiddenSalt: /\bbesilate\b/i,
    },
    {
      product: "Keral 25 mg",
      ingredient: "dexketoprofen trometamol",
      strength: "25 mg",
      expectedLabel: "Dexketoprofen 25 mg",
      forbiddenSalt: /\btrometamol\b/i,
    },
    {
      product: "Losatrix Comp 50 mg / 12,5 mg",
      ingredient: "losartan potassium + hydrochlorothiazide",
      strength: "50 mg / 12,5 mg",
      expectedLabel: "Losartan 50 mg / 12,5 mg",
      forbiddenSalt: /\bpotassium\b/i,
    },
    {
      product: "Bioclavid 875 mg / 125 mg",
      ingredient: "amoxicillin trihydrate / clavulanate potassium",
      strength: "875 mg / 125 mg",
      expectedLabel: "Amoxicillin 875 mg / 125 mg",
      forbiddenSalt: /\b(trihydrate|potassium)\b/i,
    },
  ];

  const eveningAml: RawItem = {
    box: [100, 700, 400, 900],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }),
    answers: true,
  };

  for (const c of saltCases) {
    const item: RawItem = {
      box: [100, 100, 400, 300],
      read: mkRead({ product: f(c.product), ingredient: f(c.ingredient), strength: f(c.strength) }),
      answers: false,
    };

    const vDesc = buildSceneVerdict([item, eveningAml], profile, undefined, NOW);
    assertSceneBounds(vDesc);
    assert.ok(vDesc.speech.includes(c.expectedLabel), `expected "${c.expectedLabel}" in "${vDesc.speech}"`);
    assert.doesNotMatch(vDesc.speech, c.forbiddenSalt);
    assert.doesNotMatch(vDesc.items![0].headline, c.forbiddenSalt);

    const vTarget = buildSceneVerdict([item, eveningAml], profile, "which one is my evening pill?", NOW);
    assertSceneBounds(vTarget);
    assert.ok(vTarget.speech.includes(c.expectedLabel), `expected "${c.expectedLabel}" in "${vTarget.speech}"`);
    assert.doesNotMatch(vTarget.speech, c.forbiddenSalt);
    assert.doesNotMatch(vTarget.items![0].headline, c.forbiddenSalt);
  }

  const multiSaltScene: RawItem[] = [
    {
      box: [100, 50, 400, 200],
      read: mkRead({ product: f("Thyroxin 100 mikrog"), ingredient: f(null, 0), strength: f("100 mikrog") }),
      answers: false,
    },
    {
      box: [100, 350, 400, 550],
      read: mkRead({ product: f("Burana Caps 400 mg"), ingredient: f("ibuprofen lysine"), strength: f("400 mg") }),
      answers: false,
    },
    {
      box: [100, 700, 400, 900],
      read: mkRead({ product: f("Seloken ZOC 50 mg"), ingredient: f("metoprolol succinate"), strength: f("50 mg") }),
      answers: false,
    },
  ];
  const vMulti = buildSceneVerdict(multiSaltScene, profile, undefined, NOW);
  assertSceneBounds(vMulti);
  assert.match(
    vMulti.speech,
    /^I see 3 packages: Thyroxin 100 mikrog on the left, Ibuprofen 400 mg in the middle and Metoprolol 50 mg on the right\./,
  );
  assert.doesNotMatch(vMulti.speech, /lysine|succinate|100 mikrog 100 mikrog/i);

  const salineItem: RawItem = {
    box: [100, 100, 400, 300],
    read: mkRead({ product: f("Natriumklorid 9 mg/ml"), ingredient: f("sodium chloride"), strength: f("9 mg/ml") }),
    answers: false,
  };
  const vSaline = buildSceneVerdict([salineItem, eveningAml], profile, undefined, NOW);
  assertSceneBounds(vSaline);
  assert.ok(vSaline.speech.includes("Sodium chloride 9 mg/ml on the left"));

  const listedSaltProfile: Profile = {
    meds: [
      { id: "thy", name: "Thyroxin", ingredient: "levothyroxine sodium", strength: "100 mcg", schedule: ["morning"] },
      { id: "ibu", name: "Burana Caps", ingredient: "ibuprofen lysine", strength: "400 mg", schedule: ["noon"] },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };
  const listedScene: RawItem[] = [
    {
      box: [100, 100, 400, 300],
      read: mkRead({ product: f("Thyroxin 100 mikrog"), ingredient: f(null, 0), strength: f("100 mikrog") }),
      answers: true,
    },
    {
      box: [100, 700, 400, 900],
      read: mkRead({ product: f("Burana Caps 400 mg"), ingredient: f("ibuprofen lysine"), strength: f("400 mg") }),
      answers: false,
    },
  ];
  const vListed = buildSceneVerdict(listedScene, listedSaltProfile, undefined, NOW);
  assertSceneBounds(vListed);
  assert.match(
    vListed.speech,
    /^I see 2 packages: Levothyroxine 100 mikrog on the left and Ibuprofen 400 mg on the right\./,
  );
  assert.doesNotMatch(vListed.speech, /sodium|lysine|100 mikrog 100 mikrog/i);
});

test("eval-rules.ts CLI exits 0 and writes deterministic zero-unsafe JSON summary across all 9 families", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-eval-rules-"));
  try {
    const outFile = path.join(tmpDir, "eval-rules-out.json");
    const res = runTsxScript(EVAL_RULES_SCRIPT, ["--json", outFile]);
    assert.equal(res.status, 0, `eval-rules.ts failed with stderr: ${res.stderr}`);
    assert.match(res.stdout, /rules eval: \d+ cases, unsafe reassurances 0 \(0\.0%\)/);

    assert.equal(fs.existsSync(outFile), true);
    const report = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
      n: number;
      unsafe_reassurance: number;
      unsafe_reassurance_rate: number;
      match_recall_on_safe_confident: number;
      by_family: Record<string, { n: number; match: number; unsafe: number; unsure: number; warning: number }>;
      unsafe_examples: unknown[];
      strength_min_conf: number;
    };

    assert.ok(report.n > 0);
    assert.equal(report.unsafe_reassurance, 0);
    assert.equal(report.unsafe_reassurance_rate, 0);
    assert.equal(report.match_recall_on_safe_confident, 1);
    assert.deepEqual(report.unsafe_examples, []);
    assert.equal(report.strength_min_conf, 0.8);

    const expectedFamilies = [
      "correct_box",
      "wrong_strength",
      "strength_missing",
      "expired",
      "already_taken",
      "nsaid_avoid",
      "not_on_list",
      "food_allergen",
      "unreadable",
    ];
    for (const fam of expectedFamilies) {
      assert.ok(fam in report.by_family, `missing family "${fam}" in eval-rules report`);
      assert.ok(report.by_family[fam].n > 0, `family "${fam}" has 0 cases`);
      assert.equal(report.by_family[fam].unsafe, 0, `family "${fam}" had unsafe reassurances`);
      if (fam !== "correct_box") {
        assert.equal(report.by_family[fam].match, 0, `non-safe family "${fam}" must have 0 matches`);
      }
    }
    assert.ok(report.by_family.correct_box.match > 0);
    const sumCases = Object.values(report.by_family).reduce((acc, b) => acc + b.n, 0);
    assert.equal(sumCases, report.n);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(tmpDir), false);
});

test("dm-check.ts CLI reads dm_amlodipine.jpg across 3 runs and writes/reads GS1 DataMatrix PNGs in temp dir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-dm-check-"));
  try {
    const readFixture = runTsxScript(DM_CHECK_SCRIPT, ["read", DM_FIXTURE_JPG]);
    assert.equal(readFixture.status, 0, `dm-check.ts read failed with stderr: ${readFixture.stderr}`);

    const fixtureLines = readFixture.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(fixtureLines.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.match(fixtureLines[i], new RegExp(`^dm_amlodipine\\.jpg run${i} \\d+ ms `));
      const jsonStart = fixtureLines[i].indexOf("[");
      assert.ok(jsonStart > 0);
      const codes = JSON.parse(fixtureLines[i].slice(jsonStart)) as Array<{
        gtin: string;
        expiry: string;
        batch: boolean;
        serial: boolean;
      }>;
      assert.deepEqual(codes, [
        {
          gtin: "09501101530003",
          expiry: "2027-08",
          batch: true,
          serial: true,
        },
      ]);
    }

    const tmpPng = path.join(tmpDir, "nordic-pack.png");
    const writeRes = runTsxScript(DM_CHECK_SCRIPT, [
      "write",
      tmpPng,
      "(01)06416542002149(17)281200(10)B9(21)S1",
    ]);
    assert.equal(writeRes.status, 0, `dm-check.ts write failed with stderr: ${writeRes.stderr}`);
    assert.match(writeRes.stdout.trim(), /^wrote /);
    assert.equal(fs.existsSync(tmpPng), true);

    const pngBytes = fs.readFileSync(tmpPng);
    assert.ok(pngBytes.length > 64);
    assert.deepEqual(
      [...pngBytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );

    const readWritten = runTsxScript(DM_CHECK_SCRIPT, ["read", tmpPng]);
    assert.equal(readWritten.status, 0, `dm-check.ts round-trip read failed: ${readWritten.stderr}`);
    const writtenLines = readWritten.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(writtenLines.length, 3);
    for (let i = 0; i < 3; i++) {
      const codes = JSON.parse(writtenLines[i].slice(writtenLines[i].indexOf("[")));
      assert.deepEqual(codes, [
        {
          gtin: "06416542002149",
          expiry: "2028-12",
          batch: true,
          serial: true,
        },
      ]);
    }

    const tmpDayPng = path.join(tmpDir, "day-expiry-pack.png");
    const writeDayRes = runTsxScript(DM_CHECK_SCRIPT, [
      "write",
      tmpDayPng,
      "(01)09501101530003(17)270831(10)AB12C(21)SN1",
    ]);
    assert.equal(writeDayRes.status, 0, `dm-check.ts day-expiry write failed: ${writeDayRes.stderr}`);
    const readDayRes = runTsxScript(DM_CHECK_SCRIPT, ["read", tmpDayPng]);
    assert.equal(readDayRes.status, 0);
    const dayLines = readDayRes.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(dayLines.length, 3);
    for (let i = 0; i < 3; i++) {
      const codes = JSON.parse(dayLines[i].slice(dayLines[i].indexOf("[")));
      assert.deepEqual(codes, [
        {
          gtin: "09501101530003",
          expiry: "2027-08-31",
          batch: true,
          serial: true,
        },
      ]);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(tmpDir), false);
});
