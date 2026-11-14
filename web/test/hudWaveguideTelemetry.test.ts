import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  clampHudHeadline,
  initialHudState,
  reduceHudServerMsg,
  sanitizeHudText,
  type HudState
} from "../src/hud/HudApp.tsx";
import {
  WAVEGUIDE_OPTICAL_SPEC,
  auditHudHistoryDepth,
  computeRelativeLuminance,
  computeWaveguideContrast,
  estimateHudLitBudget
} from "../src/hud/waveguideAudit.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import { STRENGTH_MIN_CONF, checkLabel } from "../../server/src/safety.ts";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  LiveState,
  Profile,
  Verdict,
  VerdictLevel
} from "../../shared/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
  throws(block: () => unknown, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = (
  (await import(nodeAssertSpec)) as { default: StrictAssert }
).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const FIXED_NOW = new Date("2026-11-14T20:00:00Z");

const ALL_COACH_CUES: readonly CoachCue[] = [
  "rotate_left",
  "rotate_right",
  "closer",
  "farther",
  "more_light",
  "hold_still",
  "other_side",
  "ok"
];

const ALL_VERDICT_LEVELS: readonly VerdictLevel[] = [
  "match",
  "warning",
  "unsure",
  "info"
];

const ALL_LIVE_STATES: readonly LiveState[] = [
  "connecting",
  "open",
  "reconnecting",
  "degraded",
  "closed"
];

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 88,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipin", confidence: 0.99 },
    ingredient: { value: "amlodipine", confidence: 0.99 },
    strength: { value: "5 mg", confidence: 0.99 },
    dosing: { value: "1 tablet each evening", confidence: 0.95 },
    expiry: { value: "2027-11", confidence: 0.99 },
    allergens: { value: null, confidence: 0.1 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.96,
    guidance: "Hold steady so the front label stays sharp.",
    ...overrides
  };
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.trunc(value)))
    .toString(16)
    .padStart(2, "0");
}

test("WAVEGUIDE_OPTICAL_SPEC exposes frozen 600x600 Ray-Ban Display optical constants", () => {
  assert.equal(Object.isFrozen(WAVEGUIDE_OPTICAL_SPEC), true);
  assert.deepEqual(WAVEGUIDE_OPTICAL_SPEC, {
    viewportPx: 600,
    maxVerdictFillRatio: 0.65,
    maxCoachFillRatio: 0.35,
    maxStandbyFillRatio: 0.08,
    minContrastRatio: 10,
    maxHeadlineWords: 8,
    maxHistoryEntries: 2
  });
});

test("Standby and dismissed HUD states stay within <= 8% waveguide budget with minimal bloom risk and Active Verdict precedence", () => {
  const baseStandby = initialHudState();
  const baseReport = estimateHudLitBudget(baseStandby);

  assert.equal(baseReport.mode, "standby");
  assert.equal(
    baseReport.maxAllowedAreaRatio,
    WAVEGUIDE_OPTICAL_SPEC.maxStandbyFillRatio
  );
  assert.ok(baseReport.cardAreaRatio > 0 && baseReport.cardAreaRatio <= 0.08);
  assert.ok(
    baseReport.activeLitPixelRatio > 0 &&
      baseReport.activeLitPixelRatio <= baseReport.cardAreaRatio
  );
  assert.equal(baseReport.withinFillBudget, true);
  assert.equal(baseReport.bloomRisk, "minimal");
  assert.equal(baseReport.accentHex, "#22ff88");
  assert.ok(baseReport.contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio);
  assert.equal(baseReport.meetsContrastGate, true);
  assert.equal(baseReport.headlineWordCount, 0);
  assert.equal(baseReport.withinWordCap, true);
  assert.equal(baseReport.multimodalChannels, null);

  const matchVerdict = checkLabel(makeLabelRead(), DEMO_PROFILE, FIXED_NOW);
  const dismissedToStandby: HudState = {
    ...initialHudState({ speechEnabled: true }),
    connected: true,
    live: "open",
    device: makeDevice(),
    verdict: matchVerdict,
    dismissed: true,
    coach: null
  };
  const dismissedReport = estimateHudLitBudget(dismissedToStandby);
  assert.equal(dismissedReport.mode, "standby");
  assert.equal(dismissedReport.withinFillBudget, true);
  assert.equal(dismissedReport.bloomRisk, "minimal");
  assert.equal(dismissedReport.multimodalChannels, null);

  const dismissedWithCoach: HudState = {
    ...dismissedToStandby,
    coach: { cue: "closer", text: "Move the box closer" }
  };
  assert.equal(estimateHudLitBudget(dismissedWithCoach).mode, "coach");

  const activeVerdictAndCoach: HudState = {
    ...dismissedWithCoach,
    dismissed: false
  };
  assert.equal(estimateHudLitBudget(activeVerdictAndCoach).mode, "verdict");
});

test("All 8 CoachCue states obey <= 35% fill budget, >= 10:1 waveguide contrast, and bloom escalation on overflow", () => {
  const coachFixtures: ReadonlyArray<{
    cue: CoachCue;
    text: string;
    expectedAccent: string;
  }> = [
    {
      cue: "rotate_left",
      text: "Kaanna pakkausta hieman vasemmalle",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "rotate_right",
      text: "Vrid forpackningen at hoger",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "closer",
      text: "Move the package closer",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "farther",
      text: "Hold the bottle slightly farther",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "more_light",
      text: "Angle label toward room light",
      expectedAccent: "#ffbb22"
    },
    {
      cue: "hold_still",
      text: "Pida pakkaus paikallaan hetki",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "other_side",
      text: "Vand forpackningen till framsidan",
      expectedAccent: "#38d6ff"
    },
    {
      cue: "ok",
      text: "Locked on sharp front label",
      expectedAccent: "#22ff88"
    }
  ];

  assert.equal(coachFixtures.length, ALL_COACH_CUES.length);
  const seenCues = new Set<CoachCue>();

  for (const item of coachFixtures) {
    seenCues.add(item.cue);
    const state = reduceHudServerMsg(
      {
        ...initialHudState(),
        connected: true,
        live: "open",
        device: makeDevice()
      },
      { type: "coach", cue: item.cue, text: item.text }
    );

    const html = renderToStaticMarkup(createElement(HudApp, { initialState: state }));
    assert.ok(html.includes(`data-coach-cue="${item.cue}"`));

    const report = estimateHudLitBudget(state);
    assert.equal(report.mode, "coach");
    assert.equal(
      report.maxAllowedAreaRatio,
      WAVEGUIDE_OPTICAL_SPEC.maxCoachFillRatio
    );
    assert.ok(
      report.cardAreaRatio > 0 && report.cardAreaRatio <= 0.35,
      `${item.cue} cardAreaRatio ${report.cardAreaRatio} exceeded 0.35`
    );
    assert.ok(
      report.activeLitPixelRatio > 0 &&
        report.activeLitPixelRatio <= report.cardAreaRatio
    );
    assert.equal(report.withinFillBudget, true);
    assert.equal(report.bloomRisk, "controlled");
    assert.equal(report.accentHex, item.expectedAccent);
    assert.ok(report.contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio);
    assert.equal(report.meetsContrastGate, true);
    assert.ok(report.headlineWordCount >= 1 && report.headlineWordCount <= 8);
    assert.equal(report.withinWordCap, true);
    assert.equal(report.multimodalChannels, null);
  }

  assert.equal(seenCues.size, 8);

  const overflowingCoachState: HudState = {
    ...initialHudState(),
    connected: true,
    live: "open",
    coach: {
      cue: "closer",
      text: "Please move this medication carton much closer to the camera lens right now so every tiny printed strength digit becomes completely sharp and readable"
    }
  };
  const overflowReport = estimateHudLitBudget(overflowingCoachState);
  assert.equal(overflowReport.mode, "coach");
  assert.equal(overflowReport.withinWordCap, false);
  assert.ok(overflowReport.headlineWordCount > WAVEGUIDE_OPTICAL_SPEC.maxHeadlineWords);
  assert.ok(overflowReport.cardAreaRatio > WAVEGUIDE_OPTICAL_SPEC.maxCoachFillRatio);
  assert.equal(overflowReport.withinFillBudget, false);
  assert.equal(overflowReport.bloomRisk, "elevated");
});

test("All 4 VerdictLevel states satisfy <= 65% fill budget, >= 10:1 contrast, <= 8 word cap, and pairwise-distinct 4-channel multimodal encoding", () => {
  assert.equal(STRENGTH_MIN_CONF, 0.8);

  const matchFresh = checkLabel(makeLabelRead(), DEMO_PROFILE, FIXED_NOW);
  const matchTaken: Verdict = { ...matchFresh, takenToday: true };
  const warningNsaid = checkLabel(
    makeLabelRead({
      product: { value: "Burana", confidence: 0.99 },
      ingredient: { value: "ibuprofen", confidence: 0.99 },
      strength: { value: "400 mg", confidence: 0.99 }
    }),
    DEMO_PROFILE,
    FIXED_NOW
  );
  const warningAllergen = checkLabel(
    makeLabelRead({
      kind: "food",
      product: { value: "Hazelnut Crunch Bar", confidence: 0.99 },
      ingredient: { value: "oats, roasted hazelnut", confidence: 0.97 },
      strength: { value: null, confidence: 0 },
      allergens: { value: ["hazelnut", "oats"], confidence: 0.98 }
    }),
    DEMO_PROFILE,
    FIXED_NOW
  );
  const unsureLowConf = checkLabel(
    makeLabelRead({
      strength: { value: "5 mg", confidence: 0.65 },
      readability: 0.55
    }),
    DEMO_PROFILE,
    FIXED_NOW
  );
  const infoSafeFood = checkLabel(
    makeLabelRead({
      kind: "food",
      product: { value: "Nordic Oat Drink", confidence: 0.99 },
      ingredient: { value: "water, oats, rapeseed oil", confidence: 0.96 },
      strength: { value: null, confidence: 0 },
      allergens: { value: ["oats"], confidence: 0.96 }
    }),
    DEMO_PROFILE,
    FIXED_NOW
  );

  assert.equal(matchFresh.level, "match");
  assert.equal(warningNsaid.level, "warning");
  assert.equal(warningAllergen.level, "warning");
  assert.equal(unsureLowConf.level, "unsure");
  assert.equal(infoSafeFood.level, "info");

  const levelRepresentatives: ReadonlyArray<{
    level: VerdictLevel;
    verdict: Verdict;
    expectedShape: string;
    expectedBadge: string;
    expectedColor: string;
  }> = [
    {
      level: "match",
      verdict: matchFresh,
      expectedShape: "circle",
      expectedBadge: "MATCH",
      expectedColor: "#22ff88"
    },
    {
      level: "warning",
      verdict: warningNsaid,
      expectedShape: "triangle",
      expectedBadge: "WARNING",
      expectedColor: "#ffbb22"
    },
    {
      level: "unsure",
      verdict: unsureLowConf,
      expectedShape: "diamond",
      expectedBadge: "UNSURE",
      expectedColor: "#38d6ff"
    },
    {
      level: "info",
      verdict: infoSafeFood,
      expectedShape: "square",
      expectedBadge: "INFO",
      expectedColor: "#f0f6ff"
    }
  ];

  const channelsByLevel = levelRepresentatives.map((entry) => {
    const hudState = reduceHudServerMsg(
      {
        ...initialHudState(),
        connected: true,
        live: "open",
        device: makeDevice()
      },
      { type: "verdict", verdict: entry.verdict }
    );
    const html = renderToStaticMarkup(
      createElement(HudApp, { initialState: hudState })
    );
    const report = estimateHudLitBudget(hudState);

    assert.equal(report.mode, "verdict");
    assert.equal(
      report.maxAllowedAreaRatio,
      WAVEGUIDE_OPTICAL_SPEC.maxVerdictFillRatio
    );
    assert.ok(report.cardAreaRatio > 0 && report.cardAreaRatio <= 0.65);
    assert.ok(
      report.activeLitPixelRatio > 0 &&
        report.activeLitPixelRatio <= report.cardAreaRatio
    );
    assert.equal(report.withinFillBudget, true);
    assert.equal(report.bloomRisk, "controlled");
    assert.equal(report.accentHex, entry.expectedColor);
    assert.ok(report.contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio);
    assert.equal(report.meetsContrastGate, true);
    assert.ok(report.headlineWordCount >= 1 && report.headlineWordCount <= 8);
    assert.equal(report.withinWordCap, true);

    assert.ok(report.multimodalChannels !== null);
    assert.deepEqual(report.multimodalChannels, {
      shape: entry.expectedShape,
      badge: entry.expectedBadge,
      color: entry.expectedColor,
      hasVectorIcon: true
    });

    assert.ok(html.includes(`data-verdict-shape="${entry.expectedShape}"`));
    assert.ok(html.includes(`>${entry.expectedBadge}<${SLASH}span>`));
    assert.ok(html.includes(`border-color:${entry.expectedColor}`));

    return report.multimodalChannels;
  });

  for (let i = 0; i < channelsByLevel.length; i += 1) {
    for (let j = i + 1; j < channelsByLevel.length; j += 1) {
      const left = channelsByLevel[i];
      const right = channelsByLevel[j];
      assert.notEqual(left.shape, right.shape);
      assert.notEqual(left.badge, right.badge);
      assert.notEqual(left.color, right.color);
      assert.equal(left.hasVectorIcon && right.hasVectorIcon, true);
    }
  }

  for (const extraVerdict of [matchTaken, warningAllergen]) {
    const extraReport = estimateHudLitBudget(
      reduceHudServerMsg(initialHudState(), {
        type: "verdict",
        verdict: extraVerdict
      })
    );
    assert.equal(extraReport.mode, "verdict");
    assert.equal(extraReport.withinFillBudget, true);
    assert.equal(extraReport.withinWordCap, true);
    assert.equal(extraReport.meetsContrastGate, true);
  }
});

test("Long Nordic compound medication names and combination strengths stay within <= 8 words and <= 65% waveguide fill", () => {
  const combo50125 = `50 mg ${SLASH} 12,5 mg`;
  const combo500125 = `500 mg ${SLASH} 12,5 mg`;
  const combo875125 = `875 mg ${SLASH} 125 mg`;
  const combo100050 = `1000 mg ${SLASH} 50 mg`;

  const nordicProfile: Profile = {
    lang: "fi",
    meds: [
      {
        id: "hctz_los",
        name: "Hydroklooritiatsidi-Losartaani",
        ingredient: "Hydroklooritiatsidi-Losartaani",
        strength: combo50125,
        schedule: ["morning"]
      },
      {
        id: "met_emp",
        name: "Metformiini-Empagliflotsiini",
        ingredient: "Metformiini-Empagliflotsiini",
        strength: combo500125,
        schedule: ["morning", "evening"]
      },
      {
        id: "met_sit_sv",
        name: "Metforminhydroklorid-Sitagliptin",
        ingredient: "Metforminhydroklorid-Sitagliptin",
        strength: combo100050,
        schedule: ["08:00", "20:00"]
      },
      {
        id: "asa_dip_fi",
        name: "Asetyylisalisyylihappo-Dipyridamoli",
        ingredient: "Asetyylisalisyylihappo-Dipyridamoli",
        strength: `25 mg ${SLASH} 200 mg`,
        schedule: ["morning", "evening"]
      }
    ],
    allergies: ["penicillin", "hasselpahkina", "jordnotter"],
    avoid: ["tulehduskipulaakkeet", "NSAIDs"],
    doseLog: []
  };

  const nordicReads: ReadonlyArray<{
    label: string;
    read: LabelRead;
    expectedLevel: VerdictLevel;
  }> = [
    {
      label: "fi_hydroklooritiatsidi_losartaani_match",
      read: makeLabelRead({
        product: {
          value: "Hydroklooritiatsidi-Losartaani Orion",
          confidence: 0.99
        },
        ingredient: {
          value: "Hydroklooritiatsidi-Losartaani",
          confidence: 0.99
        },
        strength: { value: combo50125, confidence: 0.99 }
      }),
      expectedLevel: "match"
    },
    {
      label: "fi_metformiini_empagliflotsiini_match",
      read: makeLabelRead({
        product: {
          value: "Metformiini-Empagliflotsiini Ratiopharm",
          confidence: 0.99
        },
        ingredient: {
          value: "Metformiini-Empagliflotsiini",
          confidence: 0.99
        },
        strength: { value: combo500125, confidence: 0.98 }
      }),
      expectedLevel: "match"
    },
    {
      label: "sv_metforminhydroklorid_sitagliptin_wrong_strength",
      read: makeLabelRead({
        product: {
          value: "Metforminhydroklorid-Sitagliptin Actavis",
          confidence: 0.99
        },
        ingredient: {
          value: "Metforminhydroklorid-Sitagliptin",
          confidence: 0.99
        },
        strength: { value: combo500125, confidence: 0.99 }
      }),
      expectedLevel: "warning"
    },
    {
      label: "fi_amoksisilliini_klavulaanihappo_penicillin_warning",
      read: makeLabelRead({
        product: {
          value: "Amoksisilliini-Klavulaanihappo Orion",
          confidence: 0.99
        },
        ingredient: { value: "amoxicillin-clavulanate", confidence: 0.99 },
        strength: { value: combo875125, confidence: 0.99 }
      }),
      expectedLevel: "warning"
    },
    {
      label: "fi_asetyylisalisyylihappo_dipyridamoli_nsaid_avoid_warning",
      read: makeLabelRead({
        product: {
          value: "Asetyylisalisyylihappo-Dipyridamoli",
          confidence: 0.99
        },
        ingredient: {
          value: "Asetyylisalisyylihappo-Dipyridamoli",
          confidence: 0.99
        },
        strength: { value: `25 mg ${SLASH} 200 mg`, confidence: 0.99 }
      }),
      expectedLevel: "warning"
    },
    {
      label: "fi_hydroklooritiatsidi_losartaani_sub080_unsure",
      read: makeLabelRead({
        product: {
          value: "Hydroklooritiatsidi-Losartaani",
          confidence: 0.99
        },
        ingredient: {
          value: "Hydroklooritiatsidi-Losartaani",
          confidence: 0.99
        },
        strength: { value: combo50125, confidence: 0.74 },
        readability: 0.62
      }),
      expectedLevel: "unsure"
    }
  ];

  const shortVerdict = checkLabel(makeLabelRead(), DEMO_PROFILE, FIXED_NOW);
  const shortReport = estimateHudLitBudget(
    reduceHudServerMsg(initialHudState(), {
      type: "verdict",
      verdict: shortVerdict
    })
  );

  for (const item of nordicReads) {
    const verdict = checkLabel(item.read, nordicProfile, FIXED_NOW);
    assert.equal(verdict.level, item.expectedLevel, item.label);

    const state = reduceHudServerMsg(
      {
        ...initialHudState(),
        connected: true,
        live: "open",
        device: makeDevice()
      },
      { type: "verdict", verdict }
    );
    const report = estimateHudLitBudget(state);

    assert.equal(report.mode, "verdict");
    assert.equal(report.withinFillBudget, true, item.label);
    assert.ok(report.cardAreaRatio <= 0.65, item.label);
    assert.ok(report.cardAreaRatio > shortReport.cardAreaRatio, item.label);
    assert.ok(
      report.activeLitPixelRatio > 0 &&
        report.activeLitPixelRatio <= report.cardAreaRatio
    );
    assert.equal(report.withinWordCap, true);
    assert.ok(report.headlineWordCount >= 1 && report.headlineWordCount <= 8);
    assert.equal(report.meetsContrastGate, true);
  }

  const overlongNordicHeadlineVerdict: Verdict = {
    ...shortVerdict,
    headline: `Hydroklooritiatsidi-Losartaani ${EM_DASH} Asetyylisalisyylihappo-Dipyridamoli ${EN_DASH} tarkista annosvahvuus apteekista heti aamulla ennen laakkeen ottamista;`,
    read: makeLabelRead({
      product: {
        value:
          "Hydroklooritiatsidi-Losartaani-Asetyylisalisyylihappo-Monilaakitysvalmiste",
        confidence: 0.99
      },
      strength: {
        value: `500 mg ${SLASH} 125 mg ${SLASH} 25 mg pitkaotteinen depottabletti`,
        confidence: 0.99
      }
    }),
    takenToday: false,
    speech:
      "Tama monilaakityspakkaus vaatii tarkistuksen ennen ottamista. Tarkista vahvuus apteekista."
  };
  const denseReport = estimateHudLitBudget({
    ...initialHudState(),
    connected: true,
    live: "open",
    verdict: overlongNordicHeadlineVerdict,
    dismissed: false
  });
  assert.equal(
    clampHudHeadline(overlongNordicHeadlineVerdict.headline)
      .trim()
      .split(/\s+/).length,
    8
  );
  assert.equal(denseReport.headlineWordCount, 8);
  assert.equal(denseReport.withinWordCap, true);
  assert.equal(denseReport.withinFillBudget, true);
  assert.ok(denseReport.cardAreaRatio > 0.6 && denseReport.cardAreaRatio <= 0.65);
  assert.equal(denseReport.bloomRisk, "elevated");
});

test("computeRelativeLuminance and computeWaveguideContrast satisfy WCAG 2.2 math, shorthand hex, palette gates, and invalid input rejection", () => {
  assert.equal(computeRelativeLuminance("#000000"), 0);
  assert.equal(computeRelativeLuminance("#000"), 0);
  assert.equal(computeRelativeLuminance("000000"), 0);
  assert.equal(computeRelativeLuminance("#ffffff"), 1);
  assert.equal(computeRelativeLuminance(" #FFF "), 1);
  assert.equal(
    computeRelativeLuminance("#22ff88"),
    computeRelativeLuminance("#2f8")
  );

  assert.ok(
    computeRelativeLuminance("#00ff00") > computeRelativeLuminance("#ff0000")
  );
  assert.ok(
    computeRelativeLuminance("#ff0000") > computeRelativeLuminance("#0000ff")
  );
  assert.ok(
    Math.abs(computeRelativeLuminance("#ff0000") - 0.2126) < 1e-12
  );
  assert.ok(
    Math.abs(computeRelativeLuminance("#00ff00") - 0.7152) < 1e-12
  );
  assert.ok(
    Math.abs(computeRelativeLuminance("#0000ff") - 0.0722) < 1e-12
  );

  const linearLow = computeRelativeLuminance("#0a0a0a");
  const gammaAboveKink = computeRelativeLuminance("#0b0b0b");
  assert.ok(linearLow > 0 && gammaAboveKink > linearLow);

  assert.equal(computeWaveguideContrast("#ffffff"), 21);
  assert.equal(computeWaveguideContrast("#ffffff", "#000000"), 21);
  assert.equal(computeWaveguideContrast("#000000", "#000000"), 1);
  assert.equal(computeWaveguideContrast("#22ff88", "#22ff88"), 1);

  for (const hudAccent of [
    "#22ff88",
    "#ffbb22",
    "#38d6ff",
    "#f0f6ff",
    "#ffee00",
    "#ffffff"
  ]) {
    const ratio = computeWaveguideContrast(hudAccent);
    assert.ok(
      ratio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio,
      `Expected ${hudAccent} contrast ${ratio} >= 10`
    );
  }

  assert.ok(computeWaveguideContrast("#ff0000") < 10);
  assert.ok(computeWaveguideContrast("#0000ff") < 10);

  for (const badHex of [
    "",
    "   ",
    "#12",
    "#1234",
    "#12345",
    "#1234567",
    "#gggggg",
    "rgb(255, 255, 255)"
  ]) {
    assert.throws(
      () => computeRelativeLuminance(badHex),
      `Expected invalid hex "${badHex}" to throw`
    );
    assert.throws(
      () => computeWaveguideContrast(badHex),
      `Expected invalid fgHex "${badHex}" to throw`
    );
  }
});

test("Property checks verify contrast symmetry, luminance monotonicity, and deterministic HudState optical invariants across 300 seeded runs", () => {
  const rng = createMulberry32(20261115);

  for (let i = 0; i < 300; i += 1) {
    const r1 = Math.floor(rng() * 256);
    const g1 = Math.floor(rng() * 256);
    const b1 = Math.floor(rng() * 256);
    const r2 = Math.floor(rng() * 256);
    const g2 = Math.floor(rng() * 256);
    const b2 = Math.floor(rng() * 256);

    const hex1 = `#${toHexByte(r1)}${toHexByte(g1)}${toHexByte(b1)}`;
    const hex2 = `#${toHexByte(r2)}${toHexByte(g2)}${toHexByte(b2)}`;

    const lum1 = computeRelativeLuminance(hex1);
    const lum2 = computeRelativeLuminance(hex2);
    assert.ok(Number.isFinite(lum1) && lum1 >= 0 && lum1 <= 1);
    assert.ok(Number.isFinite(lum2) && lum2 >= 0 && lum2 <= 1);

    const brighterHex = `#${toHexByte(Math.min(255, r1 + 1))}${toHexByte(Math.min(255, g1 + 1))}${toHexByte(Math.min(255, b1 + 1))}`;
    assert.ok(computeRelativeLuminance(brighterHex) >= lum1);

    const c12 = computeWaveguideContrast(hex1, hex2);
    const c21 = computeWaveguideContrast(hex2, hex1);
    assert.ok(c12 >= 1 && c12 <= 21);
    assert.ok(Math.abs(c12 - c21) < 1e-12);
  }

  const wordPool = [
    "Amlodipin",
    "Hydroklooritiatsidi-Losartaani",
    "Metformiini-Empagliflotsiini",
    "hasselpahkinaa",
    "jordnotter",
    "tabletti",
    "tarkista",
    "vahvuus",
    "varovasti",
    "lahemmaksi"
  ];

  for (let i = 0; i < 200; i += 1) {
    const modePick = i % 3;
    const live = ALL_LIVE_STATES[Math.floor(rng() * ALL_LIVE_STATES.length)];
    const wordCount = Math.floor(rng() * 14);
    const generatedText = Array.from(
      { length: wordCount },
      () => wordPool[Math.floor(rng() * wordPool.length)]
    ).join(" ");

    let state: HudState = {
      ...initialHudState({ speechEnabled: rng() > 0.5 }),
      connected: rng() > 0.25,
      live,
      device: rng() > 0.2 ? makeDevice({ battery: Math.floor(rng() * 101) }) : null,
      dismissed: rng() > 0.75,
      focusIndex: Math.floor(rng() * 3)
    };

    if (modePick === 1) {
      const cue = ALL_COACH_CUES[Math.floor(rng() * ALL_COACH_CUES.length)];
      state = {
        ...state,
        verdict: null,
        dismissed: false,
        coach: { cue, text: sanitizeHudText(generatedText) }
      };
    } else if (modePick === 2) {
      const level =
        ALL_VERDICT_LEVELS[Math.floor(rng() * ALL_VERDICT_LEVELS.length)];
      state = {
        ...state,
        coach: null,
        dismissed: false,
        verdict: {
          level,
          headline: generatedText,
          speech: generatedText,
          read: makeLabelRead({
            kind: rng() > 0.3 ? "medication" : "food",
            product: { value: generatedText.slice(0, 42), confidence: 0.95 },
            strength: {
              value: rng() > 0.3 ? `50 mg ${SLASH} 12,5 mg` : null,
              confidence: 0.95
            }
          }),
          matchedMedId: level === "match" ? "aml" : undefined,
          reasons: [],
          takenToday: rng() > 0.5
        }
      };
    }

    const rA = estimateHudLitBudget(state);
    const rB = estimateHudLitBudget(state);
    assert.deepEqual(rA, rB);
    assert.ok(Number.isFinite(rA.cardAreaRatio) && rA.cardAreaRatio > 0 && rA.cardAreaRatio <= 1);
    assert.ok(
      Number.isFinite(rA.activeLitPixelRatio) &&
        rA.activeLitPixelRatio > 0 &&
        rA.activeLitPixelRatio <= rA.cardAreaRatio
    );
    assert.equal(
      rA.withinFillBudget,
      rA.cardAreaRatio <= rA.maxAllowedAreaRatio &&
        rA.activeLitPixelRatio <= rA.maxAllowedAreaRatio
    );
    assert.equal(
      rA.meetsContrastGate,
      rA.contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio
    );
    assert.equal(rA.meetsContrastGate, true);
    assert.equal(
      rA.withinWordCap,
      rA.headlineWordCount <= WAVEGUIDE_OPTICAL_SPEC.maxHeadlineWords
    );
    if (rA.mode === "verdict") {
      assert.equal(rA.withinWordCap, true);
      assert.ok(rA.multimodalChannels !== null);
    } else {
      assert.equal(rA.multimodalChannels, null);
    }
  }
});

test("auditHudHistoryDepth enforces 2-entry app cap inside 5-entry Ray-Ban Display hardware stack", () => {
  for (const validDepth of [0, 1, 2]) {
    assert.deepEqual(auditHudHistoryDepth(validDepth), {
      entries: validDepth,
      withinCap: true,
      hardwareLimit: 5,
      appCap: 2
    });
  }

  for (const overCapDepth of [3, 4, 5, 6, 12]) {
    assert.deepEqual(auditHudHistoryDepth(overCapDepth), {
      entries: overCapDepth,
      withinCap: false,
      hardwareLimit: 5,
      appCap: 2
    });
  }

  for (const invalidDepth of [
    -1,
    -10,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ]) {
    const res = auditHudHistoryDepth(invalidDepth);
    assert.equal(res.withinCap, false);
    assert.equal(res.hardwareLimit, 5);
    assert.equal(res.appCap, 2);
  }

  const nanRes = auditHudHistoryDepth(Number.NaN);
  assert.equal(Number.isNaN(nanRes.entries), true);
  assert.equal(nanRes.withinCap, false);
  assert.equal(nanRes.hardwareLimit, 5);
  assert.equal(nanRes.appCap, 2);

  for (let d = -20; d <= 50; d += 1) {
    const report = auditHudHistoryDepth(d);
    assert.equal(report.withinCap, d >= 0 && d <= 2);
  }
});

test("Simulated 25-step HudApp standby, coach, verdict, and popstate session never exceeds auditHudHistoryDepth appCap", () => {
  let state = initialHudState();
  let historyEntries = 1;
  let pushedVerdictEntry = false;

  assert.equal(auditHudHistoryDepth(historyEntries).withinCap, true);

  const sampleMatch = checkLabel(makeLabelRead(), DEMO_PROFILE, FIXED_NOW);
  const sampleWarn = checkLabel(
    makeLabelRead({
      product: { value: "Burana", confidence: 0.99 },
      ingredient: { value: "ibuprofen", confidence: 0.99 },
      strength: { value: "400 mg", confidence: 0.99 }
    }),
    DEMO_PROFILE,
    FIXED_NOW
  );

  for (let step = 0; step < 25; step += 1) {
    if (step % 5 === 0) {
      const cue = ALL_COACH_CUES[step % ALL_COACH_CUES.length];
      state = reduceHudServerMsg(state, {
        type: "coach",
        cue,
        text: "Hold steady in view"
      });
    } else if (step % 5 === 3) {
      state = { ...state, dismissed: true };
      if (pushedVerdictEntry) {
        historyEntries = Math.max(1, historyEntries - 1);
        pushedVerdictEntry = false;
      }
    } else {
      const verdict = step % 2 === 0 ? sampleMatch : sampleWarn;
      state = reduceHudServerMsg(state, { type: "verdict", verdict });
      if (!pushedVerdictEntry) {
        historyEntries += 1;
        pushedVerdictEntry = true;
      }
    }

    const histAudit = auditHudHistoryDepth(historyEntries);
    assert.equal(histAudit.withinCap, true, `Step ${step} exceeded history cap`);
    assert.ok(histAudit.entries >= 1 && histAudit.entries <= histAudit.appCap);

    const opticalAudit = estimateHudLitBudget(state);
    assert.equal(opticalAudit.withinFillBudget, true);
    assert.equal(opticalAudit.meetsContrastGate, true);
  }
});

test("Edge-case empty headlines, dash sanitization, non-medication chip omission, and #060A0F dark-interior contrast hold", () => {
  const emptyHeadlineFoodState: HudState = {
    ...initialHudState(),
    connected: true,
    live: "open",
    verdict: {
      level: "info",
      headline: "   ,;.:   ",
      speech: "",
      read: makeLabelRead({
        kind: "food",
        product: { value: null, confidence: 0 },
        strength: { value: null, confidence: 0 }
      }),
      reasons: []
    },
    dismissed: false
  };

  const foodReport = estimateHudLitBudget(emptyHeadlineFoodState);
  assert.equal(foodReport.mode, "verdict");
  assert.equal(foodReport.withinFillBudget, true);
  assert.equal(foodReport.withinWordCap, true);
  assert.equal(foodReport.headlineWordCount, 0);
  assert.deepEqual(foodReport.multimodalChannels, {
    shape: "square",
    badge: "INFO",
    color: "#f0f6ff",
    hasVectorIcon: true
  });

  const dashHeadlineState: HudState = {
    ...emptyHeadlineFoodState,
    verdict: {
      ...emptyHeadlineFoodState.verdict!,
      headline: `Oat Drink ${EM_DASH} Gluten Free ${EN_DASH} Unsweetened`
    }
  };
  const dashReport = estimateHudLitBudget(dashHeadlineState);
  assert.equal(dashReport.withinWordCap, true);
  assert.ok(dashReport.headlineWordCount >= 4 && dashReport.headlineWordCount <= 8);

  const medWithChipsState: HudState = {
    ...emptyHeadlineFoodState,
    verdict: {
      ...emptyHeadlineFoodState.verdict!,
      level: "match",
      headline: "Matches Amlodipin 5 mg",
      speech: "Matches your evening pill.",
      matchedMedId: "aml",
      takenToday: false,
      read: makeLabelRead()
    }
  };
  const medReport = estimateHudLitBudget(medWithChipsState);
  assert.ok(
    medReport.cardAreaRatio > foodReport.cardAreaRatio,
    "Medication card with metadata chips and caption must occupy larger cardAreaRatio than bare food card"
  );

  for (const hexVariant of ["#22FF88", "#22ff88", "  22Ff88  ", "#2F8"]) {
    assert.ok(
      Math.abs(
        computeWaveguideContrast(hexVariant) - computeWaveguideContrast("#22ff88")
      ) < 1e-12
    );
  }

  for (const hudColor of ["#22ff88", "#ffbb22", "#38d6ff", "#f0f6ff", "#ffffff"]) {
    const darkInteriorContrast = computeWaveguideContrast(hudColor, "#060A0F");
    assert.ok(
      darkInteriorContrast >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio,
      `Expected ${hudColor} on #060A0F contrast ${darkInteriorContrast} >= 10`
    );
  }
});

test("waveguideAudit.ts and hudWaveguideTelemetry.test.ts contain zero comments and zero em or en dashes", () => {
  const implSrc = readFileSync(
    new URL("../src/hud/waveguideAudit.ts", import.meta.url),
    "utf8"
  );
  const selfSrc = readFileSync(
    new URL("./hudWaveguideTelemetry.test.ts", import.meta.url),
    "utf8"
  );

  for (const [name, src] of [
    ["waveguideAudit.ts", implSrc],
    ["hudWaveguideTelemetry.test.ts", selfSrc]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${name}: forbidden line comment`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name}: forbidden block comment`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name}: forbidden block close`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${name}: forbidden HTML comment`);
    assert.equal(src.includes(EM_DASH), false, `${name}: forbidden em dash`);
    assert.equal(src.includes(EN_DASH), false, `${name}: forbidden en dash`);
  }
});
