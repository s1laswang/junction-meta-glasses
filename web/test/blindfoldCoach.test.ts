import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile, Verdict } from "../../shared/types.ts";
import {
  ALL_PHRASE_IDS,
  SIM_BOXES,
  measureRgbaFrame,
  runOfflineCodeVerdict,
  runSimulatedBox,
  selectCoachCue,
  type BlindfoldLang,
  type FrameMetrics,
  type SimBoxId,
} from "../src/lib/blindfoldCoach.ts";
import { makeGs1 } from "../src/lib/gs1.ts";
import { cuePhraseId } from "../src/lib/phrases.ts";
import { demoProfile, logDose } from "../src/lib/storage.ts";

const store = new Map<string, string>();
const localStorageShim = {
  get length(): number {
    return store.size;
  },
  key(index: number): string | null {
    return Array.from(store.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return store.has(key) ? store.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    store.set(key, String(value));
  },
  removeItem(key: string): void {
    store.delete(key);
  },
  clear(): void {
    store.clear();
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  configurable: true,
  writable: true,
});

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const WEB_DIR = path.resolve(TEST_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const MANIFEST_PATH = path.join(PUBLIC_DIR, "phrases", "manifest.json");
const COACH_SRC_PATH = path.join(WEB_DIR, "src", "lib", "blindfoldCoach.ts");

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const LINE_CMT = SLASH + SLASH;
const BLOCK_CMT = SLASH + ASTERISK;
const BLOCK_CMT_END = ASTERISK + SLASH;
const HTML_CMT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ESC_EM_DASH = ["\\", "u2014"].join("");
const ESC_EN_DASH = ["\\", "u2013"].join("");
const CHILD_PROCESS_TOK = ["child", "_process"].join("");
const EXEC_SYNC_TOK = ["exec", "Sync"].join("");
const SPAWN_SYNC_TOK = ["spawn", "Sync"].join("");

const LANGS: readonly BlindfoldLang[] = ["en", "fi", "sv"];
const MORNING_EET = new Date("2026-11-15T08:30:00+02:00");
const EVENING_EET = new Date("2026-11-15T20:00:00+02:00");

type PhraseManifest = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, { file: string; text: string }>>;
};

function assertMetricBounds(metrics: FrameMetrics): void {
  const entries: readonly [string, number][] = [
    ["brightness", metrics.brightness],
    ["sharpness", metrics.sharpness],
    ["motion", metrics.motion],
    ["edgeDensity", metrics.edgeDensity],
    ["glare", metrics.glare],
    ["readiness", metrics.readiness],
  ];
  for (const [name, value] of entries) {
    assert.equal(Number.isFinite(value), true, `Expected finite ${name}, got ${value}`);
    assert.ok(value >= 0 && value <= 1, `Expected ${name} in [0, 1], got ${value}`);
  }
}

function makeSolidRgba(width: number, height: number, gray: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = gray;
    buf[i + 1] = gray;
    buf[i + 2] = gray;
    buf[i + 3] = 255;
  }
  return buf;
}

function makeCrispLabelRgba(width: number, height: number, shiftX = 0): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - shiftX;
      const inCard = sx >= Math.floor(width * 0.16) && sx < Math.ceil(width * 0.84) && y >= Math.floor(height * 0.16) && y < Math.ceil(height * 0.84);
      let v = 72;
      if (inCard) {
        v = 224;
        const inHeader = sx >= Math.floor(width * 0.2) && sx < Math.ceil(width * 0.8) && y >= Math.floor(height * 0.2) && y < Math.floor(height * 0.3);
        const inTextBand = sx >= Math.floor(width * 0.22) && sx < Math.ceil(width * 0.78) && y >= Math.floor(height * 0.34) && y < Math.ceil(height * 0.78);
        if (inHeader || (inTextBand && y % 7 < 3 && sx % 9 !== 0)) {
          v = 22;
        }
      }
      const p = (y * width + x) * 4;
      buf[p] = v;
      buf[p + 1] = v;
      buf[p + 2] = v;
      buf[p + 3] = 255;
    }
  }
  return buf;
}

function boxBlurRgba(src: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          sum += src[(ny * width + nx) * 4];
          count++;
        }
      }
      const avg = Math.round(sum / count);
      const p = (y * width + x) * 4;
      out[p] = avg;
      out[p + 1] = avg;
      out[p + 2] = avg;
      out[p + 3] = 255;
    }
  }
  return out;
}

function assertAsciiOnly(text: string, label: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    assert.ok(code <= 127, `${label} must be pure ASCII (<= 127), got charCode ${code} at index ${i}`);
  }
}

function assertCleanSource(src: string, label: string): void {
  assert.equal(src.includes(LINE_CMT), false, `${label} must have zero line comments`);
  assert.equal(src.includes(BLOCK_CMT), false, `${label} must have zero block comments`);
  assert.equal(src.includes(BLOCK_CMT_END), false, `${label} must have zero block comment closers`);
  assert.equal(src.includes(HTML_CMT), false, `${label} must have zero HTML comments`);
  assert.equal(src.includes(EM_DASH), false, `${label} must have zero em dashes`);
  assert.equal(src.includes(EN_DASH), false, `${label} must have zero en dashes`);
  assert.equal(src.includes(ESC_EM_DASH), false, `${label} must have zero escaped em dashes`);
  assert.equal(src.includes(ESC_EN_DASH), false, `${label} must have zero escaped en dashes`);
  assertAsciiOnly(src, label);
}

describe("blindfoldCoach frame analysis, coach priority, simulated traps, and morning/evening offline determinism", () => {
  test("ALL_PHRASE_IDS covers all 14 phrase IDs across EN/FI/SV (42 clips) in manifest.json and on disk", () => {
    assert.equal(ALL_PHRASE_IDS.length, 14);
    assert.equal(new Set(ALL_PHRASE_IDS).size, 14);

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as PhraseManifest;
    assert.deepEqual(Object.keys(manifest.phrases).sort(), [...LANGS]);

    let clipCount = 0;
    for (const lang of LANGS) {
      const bucket = manifest.phrases[lang];
      assert.ok(bucket, `Missing phrase bucket for ${lang}`);
      assert.deepEqual(Object.keys(bucket).sort(), [...ALL_PHRASE_IDS].sort());
      for (const id of ALL_PHRASE_IDS) {
        const entry = bucket[id];
        assert.ok(entry, `Missing ${lang}.${id} in manifest`);
        assert.equal(entry.text.includes(EM_DASH), false);
        assert.equal(entry.text.includes(EN_DASH), false);
        const rel = entry.file.startsWith(SLASH) ? entry.file.slice(1) : entry.file;
        const diskPath = path.join(PUBLIC_DIR, rel);
        assert.equal(fs.existsSync(diskPath), true, `Expected audio clip on disk: ${entry.file}`);
        assert.ok(fs.statSync(diskPath).size > 500, `Expected non-empty audio clip: ${entry.file}`);
        clipCount++;
      }
    }
    assert.equal(clipCount, 42);
  });

  test("measureRgbaFrame handles zero/empty inputs safely and distinguishes dark, glare, blank, blurry, sharp, and moving frames", () => {
    const emptyZero = measureRgbaFrame(new Uint8ClampedArray(0), 0, 0);
    assertMetricBounds(emptyZero.metrics);
    assert.equal(emptyZero.luma.length, 0);
    assert.equal(emptyZero.metrics.readiness, 0);

    const negDims = measureRgbaFrame(new Uint8Array(16), -4, 4);
    assertMetricBounds(negDims.metrics);
    assert.equal(negDims.metrics.readiness, 0);

    const w = 64;
    const h = 64;

    const dark = measureRgbaFrame(makeSolidRgba(w, h, 14), w, h);
    assertMetricBounds(dark.metrics);
    assert.ok(dark.metrics.brightness < 0.18);
    assert.ok(dark.metrics.readiness < 0.2);
    assert.equal(selectCoachCue(dark.metrics).cue, "more_light");
    assert.equal(selectCoachCue(dark.metrics).phraseId, "cue_more_light");

    const glareBuf = makeSolidRgba(w, h, 140);
    for (let i = 0; i < w * h * 4 * 0.4; i += 4) {
      glareBuf[i] = 252;
      glareBuf[i + 1] = 252;
      glareBuf[i + 2] = 252;
    }
    const glare = measureRgbaFrame(glareBuf, w, h);
    assertMetricBounds(glare.metrics);
    assert.ok(glare.metrics.glare > 0.22);
    assert.ok(glare.metrics.readiness < 0.5);
    assert.equal(selectCoachCue(glare.metrics).cue, "other_side");
    assert.equal(selectCoachCue(glare.metrics).phraseId, "cue_tilt");

    const distantBlank = measureRgbaFrame(makeSolidRgba(w, h, 135), w, h);
    assertMetricBounds(distantBlank.metrics);
    assert.ok(distantBlank.metrics.brightness >= 0.18);
    assert.equal(distantBlank.metrics.edgeDensity, 0);
    assert.equal(distantBlank.metrics.sharpness, 0);
    assert.equal(distantBlank.metrics.readiness, 0);
    assert.equal(selectCoachCue(distantBlank.metrics).cue, "closer");
    assert.equal(selectCoachCue(distantBlank.metrics).phraseId, "cue_closer");

    const crispPixels = makeCrispLabelRgba(w, h, 0);
    const blurryPixels = boxBlurRgba(crispPixels, w, h, 3);
    const blurry = measureRgbaFrame(blurryPixels, w, h);
    assertMetricBounds(blurry.metrics);
    assert.ok(blurry.metrics.edgeDensity >= 0.04);
    assert.ok(blurry.metrics.sharpness < 0.28);
    assert.equal(selectCoachCue(blurry.metrics).cue, "rotate_left");
    assert.equal(selectCoachCue(blurry.metrics).phraseId, "cue_rotate");

    const crisp = measureRgbaFrame(crispPixels, w, h);
    assertMetricBounds(crisp.metrics);
    assert.ok(crisp.metrics.sharpness > blurry.metrics.sharpness);
    assert.ok(crisp.metrics.readiness >= 0.75, `Expected crisp readiness >= 0.75, got ${crisp.metrics.readiness}`);
    assert.equal(crisp.metrics.motion, 0);
    assert.equal(selectCoachCue(crisp.metrics).cue, "ok");
    assert.equal(selectCoachCue(crisp.metrics).phraseId, "cue_reading");

    const invertedPixels = makeSolidRgba(w, h, 30);
    const moving = measureRgbaFrame(invertedPixels, w, h, crisp.luma);
    assertMetricBounds(moving.metrics);
    assert.ok(moving.metrics.motion > 0.12);
    assert.ok(moving.metrics.brightness >= 0.1 && moving.metrics.readiness < 0.2);

    const movedBright = measureRgbaFrame(makeSolidRgba(w, h, 220), w, h, dark.luma);
    assertMetricBounds(movedBright.metrics);
    assert.ok(movedBright.metrics.motion > 0.12);
    assert.equal(selectCoachCue(movedBright.metrics).cue, "hold_still");
    assert.equal(selectCoachCue(movedBright.metrics).phraseId, "cue_steady");

    const mismatchedPrev = measureRgbaFrame(crispPixels, w, h, new Float32Array(5));
    assert.equal(mismatchedPrev.metrics.motion, 0);
  });

  test("selectCoachCue enforces all 8 deterministic priority branches and localized EN/FI/SV ASCII copy parity", () => {
    const base: FrameMetrics = {
      brightness: 0.55,
      sharpness: 0.55,
      motion: 0.01,
      edgeDensity: 0.22,
      glare: 0.02,
      readiness: 0.85,
    };

    const cases: Array<{ patch: Partial<FrameMetrics>; cue: string; phraseId: string }> = [
      { patch: { brightness: 0.1, motion: 0.5, glare: 0.5 }, cue: "more_light", phraseId: "cue_more_light" },
      { patch: { brightness: 0.5, motion: 0.2, glare: 0.5 }, cue: "hold_still", phraseId: "cue_steady" },
      { patch: { brightness: 0.5, motion: 0.02, glare: 0.3 }, cue: "other_side", phraseId: "cue_tilt" },
      { patch: { edgeDensity: 0.01, sharpness: 0.1, readiness: 0.1 }, cue: "closer", phraseId: "cue_closer" },
      { patch: { edgeDensity: 0.65, sharpness: 0.18, readiness: 0.2 }, cue: "farther", phraseId: "cue_further" },
      { patch: { edgeDensity: 0.25, sharpness: 0.2, readiness: 0.3 }, cue: "rotate_left", phraseId: "cue_rotate" },
      { patch: { edgeDensity: 0.25, sharpness: 0.5, readiness: 0.78 }, cue: "ok", phraseId: "cue_reading" },
      { patch: { edgeDensity: 0.25, sharpness: 0.35, readiness: 0.6 }, cue: "hold_still", phraseId: "cue_steady" },
    ];

    for (const item of cases) {
      const sel = selectCoachCue({ ...base, ...item.patch });
      assert.equal(sel.cue, item.cue);
      assert.equal(sel.phraseId, item.phraseId);
      assert.equal(cuePhraseId(sel.cue, sel.text.en), sel.phraseId);
      for (const lang of LANGS) {
        const line = sel.text[lang];
        assert.ok(line.trim().length > 0, `Expected non-empty ${lang} copy for ${sel.phraseId}`);
        assertAsciiOnly(line, `selectCoachCue ${sel.phraseId}.${lang}`);
      }
      assert.notEqual(sel.text.en, sel.text.fi);
      assert.notEqual(sel.text.en, sel.text.sv);
    }
  });

  test("SIM_BOXES (6 items starting with amlodipine) and runSimulatedBox produce identical expected Verdict levels at 08:30 EET and 20:00 EET", (t: TestContext) => {
    localStorageShim.clear();
    const profile = demoProfile();

    const expectedByBox: Record<SimBoxId, { level: Verdict["level"]; phraseId: string | null }> = {
      amlodipine: { level: "match", phraseId: null },
      ibuprofen: { level: "warning", phraseId: null },
      amlodipine_wrong_strength: { level: "warning", phraseId: null },
      nut_allergen: { level: "warning", phraseId: null },
      metformin_unsure: { level: "unsure", phraseId: "not_sure" },
      unknown_pack: { level: "unsure", phraseId: "unknown_offline" },
    };

    assert.equal(SIM_BOXES.length, 6);
    assert.equal(SIM_BOXES[0]?.id, "amlodipine");
    for (const spec of SIM_BOXES) {
      for (const lang of LANGS) {
        assert.ok(spec.label[lang].trim().length > 0);
        assert.ok(spec.hint[lang].trim().length > 0);
        assertAsciiOnly(spec.label[lang], `SIM_BOXES ${spec.id}.label.${lang}`);
        assertAsciiOnly(spec.hint[lang], `SIM_BOXES ${spec.id}.hint.${lang}`);
      }

      const morningRes = runSimulatedBox(spec.id, profile, MORNING_EET);
      const eveningRes = runSimulatedBox(spec.id, profile, EVENING_EET);
      const exp = expectedByBox[spec.id];

      assert.equal(spec.expectedLevel, exp.level);
      assert.equal(morningRes.id, spec.id);
      assert.equal(eveningRes.id, spec.id);
      assert.equal(morningRes.verdict.level, exp.level, `Expected ${spec.id} at 08:30 EET to be ${exp.level}`);
      assert.equal(eveningRes.verdict.level, exp.level, `Expected ${spec.id} at 20:00 EET to be ${exp.level}`);
      assert.equal(morningRes.verdict.level, eveningRes.verdict.level);
      assert.equal(morningRes.phraseId, exp.phraseId);
      assert.equal(eveningRes.phraseId, exp.phraseId);
      assert.ok(morningRes.coachingCues.length > 0);
    }

    const nsaid = runSimulatedBox("ibuprofen", profile, MORNING_EET);
    assert.match(nsaid.verdict.speech, /avoid NSAIDs/i);
    assert.ok(nsaid.verdict.reasons.some((r) => /NSAID/i.test(r)));

    const wrongStrength = runSimulatedBox("amlodipine_wrong_strength", profile, MORNING_EET);
    assert.equal(wrongStrength.verdict.matchedMedId, "amlodipine");
    assert.match(wrongStrength.verdict.headline, /wrong strength/i);
    assert.match(wrongStrength.verdict.speech, /10 mg/);
    assert.match(wrongStrength.verdict.speech, /5 mg/);

    const allergen = runSimulatedBox("nut_allergen", profile, MORNING_EET);
    assert.equal(allergen.verdict.read.kind, "food");
    assert.match(allergen.verdict.speech, /hazelnuts/i);

    const unsure = runSimulatedBox("metformin_unsure", profile, MORNING_EET);
    assert.ok(unsure.verdict.read.strength.confidence < 0.8);
    assert.equal(unsure.phraseId, "not_sure");

    const unknownPack = runSimulatedBox("unknown_pack", profile, MORNING_EET);
    assert.equal(unknownPack.verdict.level, "unsure");
    assert.equal(unknownPack.phraseId, "unknown_offline");

    const emptyProfile: Profile = { lang: "en", meds: [], allergies: [], avoid: [], doseLog: [] };
    assert.equal(runSimulatedBox("amlodipine", emptyProfile, EVENING_EET).verdict.level, "match");

    t.mock.timers.enable({ apis: ["Date"], now: MORNING_EET.getTime() });
    try {
      const defaultMorning = runSimulatedBox("amlodipine", profile);
      assert.equal(defaultMorning.verdict.level, "match");
      assert.equal(defaultMorning.verdict.takenToday, false);
      assert.equal(defaultMorning.phraseId, null);

      const loggedProfile = logDose(profile, "amlodipine");
      const afterDose = runSimulatedBox("amlodipine", loggedProfile);
      assert.equal(afterDose.verdict.level, "warning");
      assert.equal(afterDose.verdict.takenToday, true);
      assert.equal(afterDose.phraseId, "already_taken");
    } finally {
      t.mock.timers.reset();
    }
  });

  test("runOfflineCodeVerdict is deterministic at 08:30 EET and 20:00 EET across saved, expired, already-taken, and unknown GS1/EAN codes", (t: TestContext) => {
    localStorageShim.clear();
    const profile = demoProfile();

    const savedGs1 = makeGs1({ gtin: "06416542002149", expiry: "270800", batch: "LOT42", serial: "SN1001" });
    const expiredGs1 = makeGs1({ gtin: "06416542002149", expiry: "250800", batch: "OLD01", serial: "SN0002" });
    const unknownGs1 = makeGs1({ gtin: "09999999999999", expiry: "280300", batch: "UNK01" });
    const savedEan = "6416542002149";
    const unknownEan = "6416542999998";

    const codeCases: Array<{
      raw: string;
      expectedLevel: Verdict["level"];
      expectedPhrase: string | null;
      expectedSource: "datamatrix" | "barcode" | "unknown";
    }> = [
      { raw: savedGs1, expectedLevel: "match", expectedPhrase: null, expectedSource: "datamatrix" },
      { raw: expiredGs1, expectedLevel: "warning", expectedPhrase: null, expectedSource: "datamatrix" },
      { raw: unknownGs1, expectedLevel: "unsure", expectedPhrase: "unknown_offline", expectedSource: "datamatrix" },
      { raw: savedEan, expectedLevel: "match", expectedPhrase: null, expectedSource: "barcode" },
      { raw: unknownEan, expectedLevel: "unsure", expectedPhrase: "unknown_offline", expectedSource: "barcode" },
      { raw: "   ", expectedLevel: "unsure", expectedPhrase: "unknown_offline", expectedSource: "unknown" },
    ];

    for (const c of codeCases) {
      const mRes = runOfflineCodeVerdict(c.raw, profile, MORNING_EET);
      const eRes = runOfflineCodeVerdict(c.raw, profile, EVENING_EET);
      assert.equal(mRes.verdict.level, c.expectedLevel, `Expected ${c.raw} at 08:30 EET to be ${c.expectedLevel}`);
      assert.equal(eRes.verdict.level, c.expectedLevel, `Expected ${c.raw} at 20:00 EET to be ${c.expectedLevel}`);
      assert.equal(mRes.verdict.level, eRes.verdict.level);
      assert.equal(mRes.phraseId, c.expectedPhrase);
      assert.equal(eRes.phraseId, c.expectedPhrase);
      assert.equal(mRes.source, c.expectedSource);
      assert.equal(eRes.source, c.expectedSource);
    }

    t.mock.timers.enable({ apis: ["Date"], now: MORNING_EET.getTime() });
    try {
      const loggedProfile = logDose(profile, "amlodipine");
      const takenGs1 = runOfflineCodeVerdict(savedGs1, loggedProfile);
      assert.equal(takenGs1.verdict.level, "warning");
      assert.equal(takenGs1.verdict.takenToday, true);
      assert.equal(takenGs1.phraseId, "already_taken");
      assert.equal(takenGs1.source, "datamatrix");

      const takenEan = runOfflineCodeVerdict(savedEan, loggedProfile);
      assert.equal(takenEan.verdict.level, "warning");
      assert.equal(takenEan.verdict.takenToday, true);
      assert.equal(takenEan.phraseId, "already_taken");
      assert.equal(takenEan.source, "barcode");
    } finally {
      t.mock.timers.reset();
    }
  });

  test("source hygiene check enforces pure ASCII <= 127, zero comments, zero em/en dashes, and zero subprocess imports", () => {
    const coachSrc = fs.readFileSync(COACH_SRC_PATH, "utf8");
    const testSrc = fs.readFileSync(TEST_FILE, "utf8");
    assertCleanSource(coachSrc, "blindfoldCoach.ts");
    assertCleanSource(testSrc, "blindfoldCoach.test.ts");
    assert.equal(coachSrc.includes(CHILD_PROCESS_TOK), false);
    assert.equal(testSrc.includes(CHILD_PROCESS_TOK), false);
    assert.equal(testSrc.includes(EXEC_SYNC_TOK), false);
    assert.equal(testSrc.includes(SPAWN_SYNC_TOK), false);
  });
});
