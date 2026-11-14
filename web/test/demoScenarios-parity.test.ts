import type { DemoScenarioId, LabelRead, Profile, Verdict, VerdictLevel } from "../src/types.ts";
import { normalizeBarcode, offlineBarcodeVerdict } from "../src/camera/barcode.ts";
import { DEMO_SCENARIOS, getDemoScenario } from "../src/camera/demoScenarios.ts";
import { parseJpegDimensions } from "../src/camera/fixtureLoader.ts";
import {
  DEMO_PROFILE,
  appendDoseLog,
  createMemoryStorage,
  resetToDemoProfile
} from "../src/storage/profileStore.ts";
import { STRENGTH_MIN_CONF, checkLabel } from "../../server/src/safety.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
}

interface NodeFs {
  existsSync(file: string): boolean;
  readdirSync(dir: string): string[];
  readFileSync(file: string): Uint8Array;
}

interface NodePath {
  dirname(p: string): string;
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
  basename(p: string): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

interface EvalFixtureItem {
  id: DemoScenarioId;
  fixture: string;
  fixture_bytes: number;
  width: number;
  height: number;
  question: string;
  expected_level: VerdictLevel;
  predicted_level: VerdictLevel;
  verdict_match: boolean;
  strength_readable: boolean;
  expected_strength: string | null;
  strength_value: string | null;
  strength_confidence: number;
  strength_correct: boolean | null;
  confident_wrong_dose: boolean;
  http_status: number;
  safety_checks: {
    http_200: boolean;
    verdict_matches_expected: boolean;
    never_guess_strength_gate_ok: boolean;
    headline_words_le_8: boolean;
    scenario_reason_ok: boolean;
  };
  verdict: Verdict & { read: LabelRead };
}

interface EvalFixturesReport {
  generated_at: string;
  endpoint: string;
  profile_summary: {
    meds: string[];
    allergies: string[];
    avoid: string[];
  };
  summary: {
    model: string;
    n_fixtures: number;
    n_items: number;
    verdict_matches: number;
    verdict_accuracy: number;
    confident_wrong_dose_count: number;
    clean_field_accuracy: number;
    occluded_abstention_rate: number;
  };
  items: EvalFixtureItem[];
}

const nodeTestSpec = String("node:test");
const nodeAssertSpec = String("node:assert/strict");
const nodeFsSpec = String("node:fs");
const nodePathSpec = String("node:path");
const nodeUrlSpec = String("node:url");

const { test }: { test: TestFn } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const fs: NodeFs = (await import(nodeFsSpec)) as NodeFs;
const path: NodePath = (await import(nodePathSpec)) as NodePath;
const { fileURLToPath }: NodeUrl = (await import(nodeUrlSpec)) as NodeUrl;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(testDir, "../public/fixtures");
const evalResultsPath = path.resolve(testDir, "../../eval/demo_fixtures_results.json");

const EM_DASH = "\u2014";

const EXPECTED_SCENARIO_LEVELS: Record<DemoScenarioId, VerdictLevel> = {
  amlodipine_match: "match",
  ibuprofen_nsaid: "warning",
  blurry_strength: "unsure",
  hazelnut_allergy: "warning",
  oat_milk_safe: "info",
  expired_med: "warning",
  back_of_box: "unsure"
};

function readUtf8File(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  return new TextDecoder("utf-8").decode(raw);
}

function readFixtureBytes(fileName: string): Uint8Array {
  const fullPath = path.join(fixturesDir, fileName);
  assert.equal(fs.existsSync(fullPath), true, `missing fixture file on disk: ${fullPath}`);
  const raw = fs.readFileSync(fullPath);
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  return bytes;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

test("every DEMO_SCENARIOS entry resolves to a real 768x768 JPEG in web/public/fixtures/ with SOI 0xFFD8 and EOI 0xFFD9 markers", () => {
  assert.equal(DEMO_SCENARIOS.length, 7);

  const uniqueIds = new Set(DEMO_SCENARIOS.map((s) => s.id));
  assert.equal(uniqueIds.size, 7);

  const diskJpegs = fs
    .readdirSync(fixturesDir)
    .filter((entry) => entry.endsWith(".jpg"))
    .sort();
  assert.equal(diskJpegs.length, 7);

  const scenarioFileNames = DEMO_SCENARIOS.map((scenario) => {
    assert.ok(
      scenario.fixtureUrl.startsWith("/fixtures/"),
      `expected /fixtures/ prefix for ${scenario.id}, got ${scenario.fixtureUrl}`
    );
    const fileName = scenario.fixtureUrl.slice("/fixtures/".length);
    assert.equal(path.basename(fileName), fileName, `nested fixture path not allowed: ${fileName}`);
    assert.ok(fileName.endsWith(".jpg"), `expected .jpg extension for ${fileName}`);
    assert.deepEqual(getDemoScenario(scenario.id), scenario);

    const bytes = readFixtureBytes(fileName);
    assert.ok(bytes.length >= 4, `JPEG too short for ${fileName}`);
    assert.equal(bytes[0], 0xff, `missing SOI 0xFF byte in ${fileName}`);
    assert.equal(bytes[1], 0xd8, `missing SOI 0xD8 byte in ${fileName}`);
    assert.equal(bytes[bytes.length - 2], 0xff, `missing EOI 0xFF byte in ${fileName}`);
    assert.equal(bytes[bytes.length - 1], 0xd9, `missing EOI 0xD9 byte in ${fileName}`);

    const dims = parseJpegDimensions(bytes);
    assert.deepEqual(dims, { w: 768, h: 768 }, `expected 768x768 dimensions for ${fileName}`);

    return fileName;
  }).sort();

  assert.deepEqual(scenarioFileNames, diskJpegs);
});

test("every DEMO_PROFILE.meds barcode produces a match verdict before dosing today and a warning double-dose verdict once logged today", () => {
  const now = new Date(2026, 10, 14, 20, 0, 0);
  const yesterdayTs = new Date(2026, 10, 13, 20, 0, 0).getTime();
  const storage = createMemoryStorage();
  const freshProfile = resetToDemoProfile(storage);

  assert.equal(DEMO_PROFILE.meds.length, 3);
  assert.deepEqual(
    DEMO_PROFILE.meds.map((m) => ({ id: m.id, name: m.name, strength: m.strength, barcode: m.barcode })),
    [
      { id: "aml", name: "Amlodipin", strength: "5 mg", barcode: "6432100012345" },
      { id: "met", name: "Metformin", strength: "500 mg", barcode: "6432100054321" },
      { id: "par", name: "Panadol", strength: "500 mg", barcode: "6432100098765" }
    ]
  );

  for (const med of DEMO_PROFILE.meds) {
    assert.ok(med.barcode, `missing barcode for ${med.id}`);
    assert.ok(normalizeBarcode(med.barcode).length > 0, `empty normalized barcode for ${med.id}`);

    const initialVerdict = offlineBarcodeVerdict(med.barcode, freshProfile, now);
    assert.equal(initialVerdict.level, "match", `expected match before dosing for ${med.id}`);
    assert.equal(initialVerdict.matchedMedId, med.id);
    assert.equal(initialVerdict.takenToday, false);
    assert.ok(countWords(initialVerdict.headline) <= 8);
    assert.match(initialVerdict.speech, /haven't taken it today/i);

    const withYesterdayDose: Profile = {
      ...freshProfile,
      doseLog: [{ medId: med.id, ts: yesterdayTs }]
    };
    const yesterdayVerdict = offlineBarcodeVerdict(med.barcode, withYesterdayDose, now);
    assert.equal(yesterdayVerdict.level, "match", `yesterday dose must not block today for ${med.id}`);
    assert.equal(yesterdayVerdict.takenToday, false);

    const maxDailyDoses = Math.max(1, med.schedule.length);
    let loggedProfile = resetToDemoProfile(storage);

    for (let doseIndex = 0; doseIndex < maxDailyDoses; doseIndex += 1) {
      const doseTs = new Date(2026, 10, 14, 8 + doseIndex * 6, 15, 0).getTime();
      loggedProfile = appendDoseLog(loggedProfile, med.id, doseTs, storage);

      if (doseIndex + 1 < maxDailyDoses) {
        const partialVerdict = offlineBarcodeVerdict(med.barcode, loggedProfile, now);
        assert.equal(partialVerdict.level, "match", `partial daily schedule for ${med.id} should stay match`);
        assert.equal(partialVerdict.matchedMedId, med.id);
        assert.equal(partialVerdict.takenToday, true);
      }
    }

    const fullDayVerdict = offlineBarcodeVerdict(med.barcode, loggedProfile, now);
    assert.equal(fullDayVerdict.level, "warning", `expected double-dose warning once logged today for ${med.id}`);
    assert.equal(fullDayVerdict.matchedMedId, med.id);
    assert.equal(fullDayVerdict.takenToday, true);
    assert.ok(countWords(fullDayVerdict.headline) <= 8);
    assert.match(fullDayVerdict.speech, /already took/i);
  }

  const savedBarcodes = new Set(DEMO_PROFILE.meds.map((m) => normalizeBarcode(m.barcode)));
  for (const scenario of DEMO_SCENARIOS) {
    assert.ok(scenario.barcode, `missing barcode on scenario ${scenario.id}`);
    const verdict = offlineBarcodeVerdict(scenario.barcode, freshProfile, now);
    if (savedBarcodes.has(normalizeBarcode(scenario.barcode))) {
      assert.equal(verdict.level, "match");
      assert.ok(verdict.matchedMedId);
    } else {
      assert.equal(verdict.level, "unsure");
      assert.equal(verdict.matchedMedId, undefined);
    }
  }
});

test("eval/demo_fixtures_results.json matches all 7 DEMO_SCENARIOS, disk fixtures, and server safety engine verdicts 1-for-1 with zero confident wrong doses", () => {
  const evalReport = JSON.parse(readUtf8File(evalResultsPath)) as EvalFixturesReport;

  assert.equal(evalReport.summary.n_fixtures, 7);
  assert.equal(evalReport.summary.n_items, 7);
  assert.equal(evalReport.summary.verdict_matches, 7);
  assert.equal(evalReport.summary.verdict_accuracy, 1);
  assert.equal(evalReport.summary.confident_wrong_dose_count, 0);
  assert.equal(evalReport.items.length, DEMO_SCENARIOS.length);

  assert.deepEqual(evalReport.profile_summary.allergies, DEMO_PROFILE.allergies);
  assert.deepEqual(evalReport.profile_summary.avoid, DEMO_PROFILE.avoid);
  assert.equal(evalReport.profile_summary.meds.length, DEMO_PROFILE.meds.length);

  const evalNow = new Date(evalReport.generated_at);
  assert.equal(Number.isNaN(evalNow.getTime()), false, "generated_at must parse as valid Date");

  DEMO_SCENARIOS.forEach((scenario, index) => {
    const item = evalReport.items[index];
    assert.ok(item, `missing eval item at index ${index}`);

    const expectedFileName = scenario.fixtureUrl.slice("/fixtures/".length);
    const diskBytes = readFixtureBytes(expectedFileName);

    assert.equal(item.id, scenario.id);
    assert.equal(item.fixture, expectedFileName);
    assert.equal(item.fixture_bytes, diskBytes.byteLength, `byte length mismatch for ${item.fixture}`);
    assert.equal(item.width, 768);
    assert.equal(item.height, 768);
    assert.equal(item.question, scenario.question);

    const expectedLevel = EXPECTED_SCENARIO_LEVELS[scenario.id];
    assert.equal(item.expected_level, expectedLevel, `expected_level mismatch for ${scenario.id}`);
    assert.equal(item.predicted_level, expectedLevel, `predicted_level mismatch for ${scenario.id}`);
    assert.equal(item.verdict.level, expectedLevel, `verdict.level mismatch for ${scenario.id}`);
    assert.equal(item.verdict_match, true);
    assert.equal(item.confident_wrong_dose, false);
    assert.equal(item.http_status, 200);
    assert.equal(item.safety_checks.http_200, true);
    assert.equal(item.safety_checks.verdict_matches_expected, true);
    assert.equal(item.safety_checks.never_guess_strength_gate_ok, true);
    assert.equal(item.safety_checks.headline_words_le_8, true);
    assert.equal(item.safety_checks.scenario_reason_ok, true);

    if (scenario.id === "blurry_strength") {
      assert.ok(
        item.verdict.read.strength.confidence < STRENGTH_MIN_CONF,
        `expected blurry_strength confidence < ${STRENGTH_MIN_CONF}`
      );
    }

    const replayed = checkLabel(item.verdict.read, DEMO_PROFILE, evalNow);
    assert.equal(replayed.level, item.expected_level, `safety.ts level mismatch on ${scenario.id}`);
    assert.equal(replayed.headline, item.verdict.headline, `safety.ts headline mismatch on ${scenario.id}`);
    assert.equal(replayed.speech, item.verdict.speech, `safety.ts speech mismatch on ${scenario.id}`);
    assert.deepEqual(replayed.reasons, item.verdict.reasons, `safety.ts reasons mismatch on ${scenario.id}`);
    assert.equal(replayed.matchedMedId, item.verdict.matchedMedId);
    assert.equal(replayed.takenToday, item.verdict.takenToday);
    assert.ok(countWords(replayed.headline) <= 8);
  });

  const amlItem = evalReport.items.find((item) => item.id === "amlodipine_match");
  assert.ok(amlItem);
  const loggedAmlProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [{ medId: "aml", ts: evalNow.getTime() - 60_000 }]
  };
  const doubleDoseReplay = checkLabel(amlItem.verdict.read, loggedAmlProfile, evalNow);
  assert.equal(doubleDoseReplay.level, "warning");
  assert.equal(doubleDoseReplay.matchedMedId, "aml");
  assert.equal(doubleDoseReplay.takenToday, true);
});

test("DEMO_SCENARIOS titles, subtitles, questions, and derived verdicts contain zero em dashes", () => {
  for (const scenario of DEMO_SCENARIOS) {
    assert.equal(scenario.title.includes(EM_DASH), false, `em dash found in title of ${scenario.id}`);
    assert.equal(scenario.subtitle.includes(EM_DASH), false, `em dash found in subtitle of ${scenario.id}`);
    assert.equal(scenario.question.includes(EM_DASH), false, `em dash found in question of ${scenario.id}`);
  }

  const now = new Date(2026, 10, 14, 20, 0, 0);
  for (const med of DEMO_PROFILE.meds) {
    assert.equal(med.name.includes(EM_DASH), false);
    assert.equal((med.notes ?? "").includes(EM_DASH), false);
    if (med.barcode) {
      const verdict = offlineBarcodeVerdict(med.barcode, DEMO_PROFILE, now);
      assert.equal(verdict.headline.includes(EM_DASH), false);
      assert.equal(verdict.speech.includes(EM_DASH), false);
    }
  }
});
