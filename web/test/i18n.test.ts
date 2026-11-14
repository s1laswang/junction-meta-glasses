import type { CoachCue, VerdictLevel } from "../src/types.ts";
import {
  SUPPORTED_LANGUAGES,
  cueLabel,
  t,
  verdictLevelLabel,
  type UiKey
} from "../src/i18n/translations.ts";

type TestFn = (name: string, fn: () => void) => void;
type AssertStrict = {
  ok: (value: unknown, message?: string) => void;
  equal: <T>(actual: T, expected: T, message?: string) => void;
  notEqual: <T>(actual: T, expected: T, message?: string) => void;
  deepEqual: <T>(actual: T, expected: T, message?: string) => void;
};

const getBuiltin = (
  globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  }
).process?.getBuiltinModule;

const nodeTestMod = getBuiltin?.("node:test") as { test?: TestFn } | undefined;
const nodeAssertMod = getBuiltin?.("node:assert/strict") as AssertStrict | undefined;

const assert: AssertStrict = nodeAssertMod ?? {
  ok(value: unknown, message?: string) {
    if (!value) throw new Error(message ?? "Assertion failed");
  },
  equal<T>(actual: T, expected: T, message?: string) {
    if (!Object.is(actual, expected)) {
      throw new Error(message ?? `Expected ${String(actual)} to equal ${String(expected)}`);
    }
  },
  notEqual<T>(actual: T, expected: T, message?: string) {
    if (Object.is(actual, expected)) {
      throw new Error(message ?? `Expected values to differ: ${String(actual)}`);
    }
  },
  deepEqual<T>(actual: T, expected: T, message?: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message ?? "Deep equality assertion failed");
    }
  }
};

const test: TestFn =
  nodeTestMod?.test ??
  ((name, fn) => {
    try {
      fn();
    } catch (err) {
      throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

const EM_DASH = "\u2014";

const UI_KEY_MAP: Record<UiKey, true> = {
  appTitle: true,
  tagline: true,
  startCheck: true,
  stopCheck: true,
  snapshotCheck: true,
  scanBarcodeOffline: true,
  logDose: true,
  doseLogged: true,
  repeatAnswer: true,
  checkingLabel: true,
  cameraOn: true,
  cameraOff: true,
  glassesStreaming: true,
  autoStopIn: true,
  tabCheck: true,
  tabProfile: true,
  tabDevice: true,
  privacyButton: true,
  consentTitle: true,
  consentAccept: true,
  deleteAllData: true,
  verdictMatch: true,
  verdictWarning: true,
  verdictUnsure: true,
  verdictInfo: true,
  confidenceTitle: true,
  typeQuestionPlaceholder: true,
  askButton: true,
  quickEveningPill: true,
  quickAllergens: true,
  quickExpiry: true,
  quickStrength: true,
  modeLive: true,
  modeSnapshot: true,
  modeOffline: true,
  notMedicalDevice: true
};

const ALL_UI_KEYS = Object.keys(UI_KEY_MAP) as UiKey[];

const CUE_MAP: Record<CoachCue, true> = {
  rotate_left: true,
  rotate_right: true,
  closer: true,
  farther: true,
  more_light: true,
  hold_still: true,
  other_side: true,
  ok: true
};

const ALL_CUES = Object.keys(CUE_MAP) as CoachCue[];

const VERDICT_MAP: Record<VerdictLevel, true> = {
  match: true,
  warning: true,
  unsure: true,
  info: true
};

const ALL_VERDICTS = Object.keys(VERDICT_MAP) as VerdictLevel[];

test("SUPPORTED_LANGUAGES covers all 8 voice session languages with zero em dashes", () => {
  const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
  assert.deepEqual(codes, ["en", "fi", "sv", "de", "es", "fr", "et", "ru"]);
  for (const entry of SUPPORTED_LANGUAGES) {
    assert.ok(entry.code.trim().length > 0);
    assert.ok(entry.label.trim().length > 0);
    assert.ok(entry.nativeLabel.trim().length > 0);
    assert.ok(!entry.label.includes(EM_DASH));
    assert.ok(!entry.nativeLabel.includes(EM_DASH));
  }
});

test("every UiKey returns localized non-empty strings in en, fi, sv with zero em dashes", () => {
  assert.equal(ALL_UI_KEYS.length, 36);
  for (const lang of ["en", "fi", "sv"] as const) {
    for (const key of ALL_UI_KEYS) {
      const val = t(lang, key);
      assert.equal(typeof val, "string");
      assert.ok(val.trim().length > 0, `${lang}.${key} was empty`);
      assert.ok(!val.includes(EM_DASH), `${lang}.${key} contained an em dash`);
    }
  }
  for (const key of ALL_UI_KEYS) {
    if (key === "appTitle") {
      assert.equal(t("en", key), "HoldUp");
      assert.equal(t("fi", key), "HoldUp");
      assert.equal(t("sv", key), "HoldUp");
      continue;
    }
    assert.notEqual(t("fi", key), t("en", key), `fi.${key} was not localized`);
    assert.notEqual(t("sv", key), t("en", key), `sv.${key} was not localized`);
    assert.notEqual(t("fi", key), t("sv", key), `fi.${key} matched sv.${key}`);
  }
});

test("every CoachCue returns distinct localized coaching text in en, fi, sv with zero em dashes", () => {
  assert.equal(ALL_CUES.length, 8);
  for (const lang of ["en", "fi", "sv"] as const) {
    const seen = new Set<string>();
    for (const cue of ALL_CUES) {
      const val = cueLabel(lang, cue);
      assert.ok(val.trim().length > 0, `${lang}.${cue} was empty`);
      assert.ok(!val.includes(EM_DASH), `${lang}.${cue} contained an em dash`);
      seen.add(val);
    }
    assert.equal(seen.size, ALL_CUES.length, `${lang} had duplicate cue labels`);
  }
  for (const cue of ALL_CUES) {
    assert.notEqual(cueLabel("fi", cue), cueLabel("en", cue));
    assert.notEqual(cueLabel("sv", cue), cueLabel("en", cue));
    assert.notEqual(cueLabel("fi", cue), cueLabel("sv", cue));
  }
});

test("every VerdictLevel returns distinct localized labels in en, fi, sv with zero em dashes", () => {
  assert.equal(ALL_VERDICTS.length, 4);
  for (const lang of ["en", "fi", "sv"] as const) {
    const seen = new Set<string>();
    for (const level of ALL_VERDICTS) {
      const val = verdictLevelLabel(lang, level);
      assert.ok(val.trim().length > 0, `${lang}.${level} was empty`);
      assert.ok(!val.includes(EM_DASH), `${lang}.${level} contained an em dash`);
      seen.add(val);
    }
    assert.equal(seen.size, ALL_VERDICTS.length, `${lang} had duplicate verdict labels`);
  }
  for (const level of ALL_VERDICTS) {
    assert.notEqual(verdictLevelLabel("fi", level), verdictLevelLabel("en", level));
    assert.notEqual(verdictLevelLabel("sv", level), verdictLevelLabel("en", level));
    assert.notEqual(verdictLevelLabel("fi", level), verdictLevelLabel("sv", level));
  }
});

test("regional locale tags normalize cleanly and voice-only or unknown locales fall back to English", () => {
  for (const key of ALL_UI_KEYS) {
    assert.equal(t("fi-FI", key), t("fi", key));
    assert.equal(t("FI_FI", key), t("fi", key));
    assert.equal(t("sv-FI", key), t("sv", key));
    assert.equal(t("sv-SE", key), t("sv", key));
    assert.equal(t("en-GB", key), t("en", key));
    for (const fallback of ["de", "de-DE", "es", "fr", "et", "ru", "ja-JP", "unknown", ""]) {
      const val = t(fallback, key);
      assert.equal(val, t("en", key));
      assert.ok(!val.includes(EM_DASH));
    }
  }
  for (const cue of ALL_CUES) {
    assert.equal(cueLabel("fi-FI", cue), cueLabel("fi", cue));
    assert.equal(cueLabel("sv-FI", cue), cueLabel("sv", cue));
    for (const fallback of ["de", "es", "fr", "et", "ru", "unknown", ""]) {
      const val = cueLabel(fallback, cue);
      assert.equal(val, cueLabel("en", cue));
      assert.ok(!val.includes(EM_DASH));
    }
  }
  for (const level of ALL_VERDICTS) {
    assert.equal(verdictLevelLabel("fi-FI", level), verdictLevelLabel("fi", level));
    assert.equal(verdictLevelLabel("sv-SE", level), verdictLevelLabel("sv", level));
    for (const fallback of ["de", "es", "fr", "et", "ru", "unknown", ""]) {
      const val = verdictLevelLabel(fallback, level);
      assert.equal(val, verdictLevelLabel("en", level));
      assert.ok(!val.includes(EM_DASH));
    }
  }
});
