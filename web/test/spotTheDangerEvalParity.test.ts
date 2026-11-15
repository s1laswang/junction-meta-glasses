import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLERGEN_SAFE_CONF,
  ALLERGEN_SAFE_READABILITY,
  STRENGTH_MIN_CONF,
  checkLabel,
} from "../../server/src/safety.ts";
import {
  SPOT_CARDS,
  evaluateSpotCard,
  spotDemoProfile,
  type JudgeChoice,
} from "../src/lib/spotTheDanger.ts";

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const BACKSLASH = String.fromCharCode(92);
const LINE_CMT = SLASH + SLASH;
const BLOCK_CMT_OPEN = SLASH + ASTERISK;
const BLOCK_CMT_CLOSE = ASTERISK + SLASH;
const HTML_CMT_OPEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const ESC_EM_DASH = BACKSLASH + "u2014";
const ESC_EN_DASH = BACKSLASH + "u2013";

const TEST_FILE = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(TEST_FILE), "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const SPOT_TS_PATH = path.join(WEB_DIR, "src", "lib", "spotTheDanger.ts");

function assertCleanAsciiSource(label: string, src: string): void {
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    assert.equal(code <= 127, true, `${label} contains non-ASCII char code ${code} at index ${i}`);
  }
  assert.equal(src.includes(LINE_CMT), false, `${label} must not contain line comments`);
  assert.equal(src.includes(BLOCK_CMT_OPEN), false, `${label} must not contain block comment start`);
  assert.equal(src.includes(BLOCK_CMT_CLOSE), false, `${label} must not contain block comment end`);
  assert.equal(src.includes(HTML_CMT_OPEN), false, `${label} must not contain HTML comments`);
  assert.equal(src.includes(EM_DASH), false, `${label} must not contain em dashes`);
  assert.equal(src.includes(EN_DASH), false, `${label} must not contain en dashes`);
  assert.equal(src.includes(ESC_EM_DASH), false, `${label} must not contain escaped em dashes`);
  assert.equal(src.includes(ESC_EN_DASH), false, `${label} must not contain escaped en dashes`);
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.length >= 16, true, "JPEG buffer too short");
  assert.equal(buf[0], 0xff, "Missing JPEG SOI 0xff");
  assert.equal(buf[1], 0xd8, "Missing JPEG SOI 0xd8");
  assert.equal(buf[buf.length - 2], 0xff, "Missing JPEG EOI 0xff");
  assert.equal(buf[buf.length - 1], 0xd9, "Missing JPEG EOI 0xd9");
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) {
      i += 1;
    }
    if (i >= buf.length) break;
    const marker = buf[i];
    i += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xda) break;
    if (i + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(i);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      assert.equal(i + 7 <= buf.length, true, "Truncated JPEG SOF segment");
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      return { width, height };
    }
    if (segLen < 2) break;
    i += segLen;
  }
  throw new Error("No JPEG SOF marker found");
}

describe("Spot-the-Danger offline safety rules and eval corpus parity", () => {
  test("enforces pure-ASCII zero-comment zero-dash hygiene and zero network tokens", () => {
    const spotSrc = fs.readFileSync(SPOT_TS_PATH, "utf8");
    const selfSrc = fs.readFileSync(TEST_FILE, "utf8");
    assertCleanAsciiSource("web/src/lib/spotTheDanger.ts", spotSrc);
    assertCleanAsciiSource("web/test/spotTheDangerEvalParity.test.ts", selfSrc);

    for (const forbidden of [
      "WebSocket",
      "BroadcastChannel",
      "sendBeacon",
      "GEMINI_API_KEY",
      "ELEVENLABS_API_KEY",
      "child_process",
    ]) {
      assert.equal(spotSrc.includes(forbidden), false, `spotTheDanger.ts must not reference ${forbidden}`);
    }
    assert.equal(spotSrc.includes("fetch("), false, "spotTheDanger.ts must not call fetch()");
  });

  test("validates all 5 degraded/clean label JPEGs and pre-rendered trilingual audio clips on disk", () => {
    assert.equal(SPOT_CARDS.length, 5);
    let totalBytes = 0;
    for (let idx = 0; idx < SPOT_CARDS.length; idx += 1) {
      const card = SPOT_CARDS[idx];
      assert.equal(card.round, idx + 1);
      assert.equal(card.id, `round${idx + 1}`);
      assert.equal(card.imageUrl, `/blindfold/labels/round${idx + 1}.jpg`);

      const imgPath = path.join(PUBLIC_DIR, card.imageUrl.slice(1));
      assert.equal(fs.existsSync(imgPath), true, `Missing JPEG asset ${imgPath}`);
      const buf = fs.readFileSync(imgPath);
      assert.equal(buf.length >= 5_000, true, `JPEG too small: ${card.imageUrl}`);
      totalBytes += buf.length;

      const dims = parseJpegDimensions(buf);
      assert.equal(dims.width >= 320, true, `Expected width >= 320 for ${card.imageUrl}, got ${dims.width}`);
      assert.equal(dims.height >= 320, true, `Expected height >= 320 for ${card.imageUrl}, got ${dims.height}`);

      for (const lang of ["en", "fi", "sv"] as const) {
        assert.equal(card.title[lang].trim().length > 8, true);
        assert.equal(card.scenarioPrompt[lang].trim().length > 20, true);
        assert.equal(card.dangerSummary[lang].trim().length > 20, true);
        const res = evaluateSpotCard(card, "match", lang);
        const audioPath = path.join(PUBLIC_DIR, res.phraseUrl.slice(1));
        assert.equal(fs.existsSync(audioPath), true, `Missing phrase audio ${audioPath}`);
        assert.equal(fs.statSync(audioPath).size > 1_000, true, `Empty phrase audio ${audioPath}`);
      }
    }
    assert.equal(totalBytes <= 250_000, true, `Expected total JPEG bytes <= 250000, got ${totalBytes}`);
  });

  test("traces every SpotCard evalSourceId back to committed v1 and adversarial suite results", () => {
    const v1PredsPath = path.join(REPO_DIR, "eval", "results", "v1", "preds_synthetic.jsonl");
    const v1Lines = fs.readFileSync(v1PredsPath, "utf8").trim().split("\n");
    const v1ByImgId = new Map<string, Record<string, unknown>>();
    for (const line of v1Lines) {
      const parsed = JSON.parse(line) as { img_id: string; pred: Record<string, unknown> };
      v1ByImgId.set(parsed.img_id, parsed.pred);
    }

    for (const card of SPOT_CARDS) {
      const [sourceNs, caseId] = card.evalSourceId.split(":");
      assert.equal(Boolean(sourceNs && caseId), true, `Invalid evalSourceId ${card.evalSourceId}`);

      if (sourceNs === "v1") {
        const pred = v1ByImgId.get(caseId) as
          | {
              kind: string;
              ingredient: { value: string | null };
              strength: { value: string | null };
            }
          | undefined;
        assert.ok(pred, `Missing v1 prediction for ${caseId}`);
        assert.equal(pred.kind, card.read.kind);
        assert.equal(pred.ingredient.value?.toLowerCase(), card.read.ingredient.value?.toLowerCase());
        assert.equal(pred.strength.value, card.read.strength.value);
      } else {
        const suitePath = path.join(REPO_DIR, "eval", "suites", sourceNs, "results.json");
        assert.equal(fs.existsSync(suitePath), true, `Missing suite results ${suitePath}`);
        const suiteJson = JSON.parse(fs.readFileSync(suitePath, "utf8")) as {
          suite: string;
          cases: Array<{
            id: string;
            expected_level: string;
            actual_level?: string;
            predicted_level?: string;
          }>;
        };
        assert.equal(suiteJson.suite, sourceNs);
        const found = suiteJson.cases.find((c) => c.id === caseId);
        assert.ok(found, `Missing case ${caseId} in suite ${sourceNs}`);
        assert.equal(found.expected_level, card.expectedLevel);
        const measured = found.actual_level ?? found.predicted_level;
        assert.equal(measured, card.expectedLevel);
      }
    }
  });

  test("verifies deterministic checkLabel gates, zero-guess abstention, and trilingual verdicts", () => {
    const baseProfile = spotDemoProfile();
    assert.equal(baseProfile.meds.length, 3);
    assert.deepEqual(baseProfile.allergies, ["tree nuts", "peanut"]);
    assert.deepEqual(baseProfile.avoid, ["NSAIDs"]);
    assert.equal(baseProfile.doseLog.length, 0);

    const fixedEvening = new Date(2026, 10, 15, 19, 0, 0);
    const expectedLevels: ReadonlyArray<JudgeChoice> = [
      "match",
      "warning",
      "warning",
      "warning",
      "unsure",
    ];
    const allChoices: ReadonlyArray<JudgeChoice> = ["match", "warning", "unsure"];

    for (let idx = 0; idx < SPOT_CARDS.length; idx += 1) {
      const card = SPOT_CARDS[idx];
      assert.equal(card.expectedLevel, expectedLevels[idx]);

      const directVerdict = checkLabel(card.read, baseProfile, fixedEvening);
      assert.equal(directVerdict.level, card.expectedLevel);

      for (const lang of ["en", "fi", "sv"] as const) {
        for (const choice of allChoices) {
          const out = evaluateSpotCard(card, choice, lang);
          assert.equal(out.expectedLevel, card.expectedLevel);
          assert.equal(out.holdupVerdict.level, card.expectedLevel);
          assert.equal(out.correct, choice === card.expectedLevel);
          assert.equal(out.holdupVerdict.speech.trim().length > 10, true);
        }
      }
    }

    const r1 = evaluateSpotCard(SPOT_CARDS[0], "match", "en");
    assert.equal(r1.holdupVerdict.matchedMedId, "amlodipine");
    assert.equal(
      r1.holdupVerdict.reasons.some((r) => r.includes("taken today: 0/1")),
      true,
    );

    const r2 = evaluateSpotCard(SPOT_CARDS[1], "warning", "en");
    assert.equal(
      r2.holdupVerdict.reasons.some((r) => r.includes("NSAID")),
      true,
    );

    const r3 = evaluateSpotCard(SPOT_CARDS[2], "warning", "en");
    assert.equal(
      r3.holdupVerdict.reasons.some((r) => r.includes("10 mg") && r.includes("5 mg")),
      true,
    );

    const r4 = evaluateSpotCard(SPOT_CARDS[3], "warning", "en");
    assert.equal(SPOT_CARDS[3].read.allergens.confidence >= ALLERGEN_SAFE_CONF, true);
    assert.equal(SPOT_CARDS[3].read.readability >= ALLERGEN_SAFE_READABILITY, true);
    assert.equal(
      r4.holdupVerdict.reasons.some((r) => r.includes("peanut")),
      true,
    );
    assert.equal(
      r4.holdupVerdict.reasons.some((r) => r.includes("tree nuts")),
      true,
    );

    const r5 = evaluateSpotCard(SPOT_CARDS[4], "unsure", "en");
    assert.equal(SPOT_CARDS[4].read.strength.confidence < STRENGTH_MIN_CONF, true);
    assert.equal(SPOT_CARDS[4].phraseClipId, "not_sure");
    assert.equal(r5.phraseUrl, "/phrases/en/not_sure.mp3");
    assert.equal(
      r5.holdupVerdict.reasons.some((r) => r.includes("strength confidence 0.24 < 0.8")),
      true,
    );
  });

  test("produces identical verdicts across UTC, Europe/Helsinki, America/Los_Angeles, and Pacific/Kiritimati", () => {
    const inlineScript = [
      'import { SPOT_CARDS, evaluateSpotCard } from "./web/src/lib/spotTheDanger.ts";',
      'const levels = SPOT_CARDS.map((c) => evaluateSpotCard(c, "match", "en").holdupVerdict.level);',
      'const reasons = SPOT_CARDS.map((c) => evaluateSpotCard(c, "match", "en").holdupVerdict.reasons);',
      "process.stdout.write(JSON.stringify({ levels, reasons }));",
    ].join("\n");

    const zones = ["UTC", "Europe/Helsinki", "America/Los_Angeles", "Pacific/Kiritimati"];
    let baseline = "";
    for (const tz of zones) {
      const proc = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", inlineScript],
        {
          cwd: REPO_DIR,
          env: { ...process.env, TZ: tz },
          encoding: "utf8",
        },
      );
      assert.equal(proc.status, 0, `Subprocess failed for TZ=${tz}: ${proc.stderr}`);
      if (!baseline) {
        baseline = proc.stdout;
      } else {
        assert.equal(proc.stdout, baseline, `Verdict drift under TZ=${tz}`);
      }
    }
    const parsed = JSON.parse(baseline) as { levels: string[] };
    assert.deepEqual(parsed.levels, ["match", "warning", "warning", "warning", "unsure"]);
  });
});
