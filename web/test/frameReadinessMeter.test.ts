import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FrameReadinessMeter,
  MAX_BURST_SLOTS,
  SHARPNESS_READY_PCT,
  SHARPNESS_READY_THRESHOLD,
  summarizeReadinessState,
  type CoachMsg,
  type FrameReadinessMeterProps
} from "../src/components/FrameReadinessMeter.tsx";
import type { CoachCue } from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs/promises";
const nodeUrlSpec: string = "node:url";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFile } = (await import(nodeFsSpec)) as {
  readFile(path: string, encoding: string): Promise<string>;
};
const { fileURLToPath } = (await import(nodeUrlSpec)) as {
  fileURLToPath(url: string | URL): string;
};

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

const ALL_CUES: readonly CoachCue[] = [
  "rotate_left",
  "rotate_right",
  "closer",
  "farther",
  "more_light",
  "hold_still",
  "other_side",
  "ok"
];

function renderMeter(overrides: Partial<FrameReadinessMeterProps> = {}): string {
  const props: FrameReadinessMeterProps = {
    cameraActive: true,
    checking: false,
    sharpness: 0.68,
    bufferedFrames: 2,
    coach: null,
    lang: "en",
    ...overrides
  };
  return renderToStaticMarkup(createElement(FrameReadinessMeter, props));
}

function extractOpeningTagByRole(html: string, roleValue: string): string {
  const escaped = roleValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\brole="${escaped}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with role="${roleValue}"`);
  return match[0];
}

test("summarizeReadinessState resolves all 4 phase transitions and effectiveCue invariants", () => {
  assert.equal(SHARPNESS_READY_THRESHOLD, 0.22);
  assert.equal(SHARPNESS_READY_PCT, 22);
  assert.equal(MAX_BURST_SLOTS, 3);

  const standby = summarizeReadinessState({
    cameraActive: false,
    checking: false,
    sharpness: null,
    bufferedFrames: 0,
    coach: null
  });
  assert.equal(standby.phase, "standby");
  assert.equal(standby.sharpnessPct, 0);
  assert.equal(standby.ringSlotsFilled, 0);
  assert.equal(standby.sharpEnough, false);
  assert.equal(standby.effectiveCue, null);
  assert.equal(standby.burstReady, false);

  const standbyWithStaleFrame = summarizeReadinessState({
    cameraActive: false,
    checking: false,
    sharpness: 0.85,
    bufferedFrames: 2,
    coach: null
  });
  assert.equal(standbyWithStaleFrame.phase, "standby");
  assert.equal(standbyWithStaleFrame.sharpnessPct, 85);
  assert.equal(standbyWithStaleFrame.ringSlotsFilled, 2);

  const coachingBlurry = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 0.14,
    bufferedFrames: 1,
    coach: null
  });
  assert.equal(coachingBlurry.phase, "coaching_adjust");
  assert.equal(coachingBlurry.sharpnessPct, 14);
  assert.equal(coachingBlurry.sharpEnough, false);
  assert.equal(coachingBlurry.effectiveCue, "hold_still");
  assert.equal(coachingBlurry.ringSlotsFilled, 1);

  const coachingExplicitCueOnSharpEdges = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 0.64,
    bufferedFrames: 2,
    coach: { cue: "other_side", text: "Turn it around to the front label" }
  });
  assert.equal(coachingExplicitCueOnSharpEdges.phase, "coaching_adjust");
  assert.equal(coachingExplicitCueOnSharpEdges.sharpEnough, true);
  assert.equal(coachingExplicitCueOnSharpEdges.effectiveCue, "other_side");

  const sharpBoundary = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 0.22,
    bufferedFrames: 1,
    coach: null
  });
  assert.equal(sharpBoundary.phase, "sharp_ready");
  assert.equal(sharpBoundary.sharpnessPct, 22);
  assert.equal(sharpBoundary.sharpEnough, true);
  assert.equal(sharpBoundary.effectiveCue, "ok");
  assert.equal(sharpBoundary.burstReady, true);

  const sharpWithOkCoach = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 0.81,
    bufferedFrames: 3,
    coach: { type: "coach", cue: "ok", text: "Label in view" }
  });
  assert.equal(sharpWithOkCoach.phase, "sharp_ready");
  assert.equal(sharpWithOkCoach.sharpnessPct, 81);
  assert.equal(sharpWithOkCoach.ringSlotsFilled, 3);
  assert.equal(sharpWithOkCoach.effectiveCue, "ok");

  const verifyingLive = summarizeReadinessState({
    cameraActive: true,
    checking: true,
    sharpness: 0.74,
    bufferedFrames: 3,
    coach: { cue: "ok", text: "Hold steady" }
  });
  assert.equal(verifyingLive.phase, "verifying");
  assert.equal(verifyingLive.sharpnessPct, 74);
  assert.equal(verifyingLive.ringSlotsFilled, 3);

  const verifyingSnapshot = summarizeReadinessState({
    cameraActive: false,
    checking: true,
    sharpness: 0.59,
    bufferedFrames: 1,
    coach: null
  });
  assert.equal(verifyingSnapshot.phase, "verifying");
  assert.equal(verifyingSnapshot.sharpnessPct, 59);
  assert.equal(verifyingSnapshot.effectiveCue, "ok");
});

test("summarizeReadinessState clamps NaN, negative, sub-threshold, and overflow sharpness and bufferedFrames", () => {
  const nanCase = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: Number.NaN,
    bufferedFrames: Number.NaN,
    coach: null
  });
  assert.equal(nanCase.sharpnessPct, 0);
  assert.equal(nanCase.sharpness, 0);
  assert.equal(nanCase.ringSlotsFilled, 0);
  assert.equal(nanCase.sharpEnough, false);
  assert.equal(nanCase.phase, "coaching_adjust");

  const negativeCase = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: -0.42,
    bufferedFrames: -5,
    coach: null
  });
  assert.equal(negativeCase.sharpnessPct, 0);
  assert.equal(negativeCase.sharpness, 0);
  assert.equal(negativeCase.ringSlotsFilled, 0);

  const negInfCase = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: Number.NEGATIVE_INFINITY,
    bufferedFrames: Number.NEGATIVE_INFINITY,
    coach: null
  });
  assert.equal(negInfCase.sharpnessPct, 0);
  assert.equal(negInfCase.ringSlotsFilled, 0);

  const justBelowGate = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 0.219,
    bufferedFrames: 2,
    coach: null
  });
  assert.equal(justBelowGate.sharpEnough, false);
  assert.equal(justBelowGate.sharpnessPct, 21);
  assert.equal(justBelowGate.phase, "coaching_adjust");

  const overflowCase = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: 1.85,
    bufferedFrames: 8,
    coach: null
  });
  assert.equal(overflowCase.sharpnessPct, 100);
  assert.equal(overflowCase.sharpness, 1);
  assert.equal(overflowCase.ringSlotsFilled, 3);
  assert.equal(overflowCase.sharpEnough, true);
  assert.equal(overflowCase.phase, "sharp_ready");

  const posInfCase = summarizeReadinessState({
    cameraActive: true,
    checking: false,
    sharpness: Number.POSITIVE_INFINITY,
    bufferedFrames: Number.POSITIVE_INFINITY,
    coach: null
  });
  assert.equal(posInfCase.sharpnessPct, 100);
  assert.equal(posInfCase.ringSlotsFilled, 3);
});

test("FrameReadinessMeter SSR renders accessible section, optical reticle SVG, progressbar ARIA, CoachCue badges, and burst slots", () => {
  const readyHtml = renderMeter({
    cameraActive: true,
    checking: false,
    sharpness: 0.68,
    bufferedFrames: 2,
    coach: null,
    lang: "en"
  });

  assert.match(
    readyHtml,
    /^<section\b[^>]*aria-labelledby="frame-readiness-meter-heading"[^>]*lang="en"/
  );
  assert.match(
    readyHtml,
    /<h2\b[^>]*id="frame-readiness-meter-heading"[^>]*>Optical Sharpness &amp; Hand-Coaching Readiness<\/h2>/
  );
  assert.ok(readyHtml.includes('class="frame-readiness-reticle-icon"'));
  assert.ok(readyHtml.includes('data-readiness-phase="sharp_ready"'));
  assert.ok(readyHtml.includes('data-ring-slots="2"'));
  assert.ok(readyHtml.includes('data-coach-cue="ok"'));
  assert.ok(readyHtml.includes('role="status"'));
  assert.ok(readyHtml.includes('aria-live="polite"'));
  assert.ok(readyHtml.includes("SHARP &amp; READY"));
  assert.ok(readyHtml.includes("LABEL IN VIEW"));
  assert.ok(readyHtml.includes("2/3 burst frames ready"));
  assert.ok(readyHtml.includes('data-burst-slot="1" data-slot-filled="true"'));
  assert.ok(readyHtml.includes('data-burst-slot="2" data-slot-filled="true"'));
  assert.ok(readyHtml.includes('data-burst-slot="3" data-slot-filled="false"'));
  assert.ok(readyHtml.includes('data-threshold-pct="22"'));

  const progressTag = extractOpeningTagByRole(readyHtml, "progressbar");
  assert.ok(progressTag.includes('aria-valuenow="68"'));
  assert.ok(progressTag.includes('aria-valuemin="0"'));
  assert.ok(progressTag.includes('aria-valuemax="100"'));
  assert.ok(progressTag.includes("68% sharpness"));

  const overflowHtml = renderMeter({
    sharpness: 2.4,
    bufferedFrames: 7,
    coach: { cue: "closer", text: "Bring box 5 cm closer" }
  });
  const overflowBar = extractOpeningTagByRole(overflowHtml, "progressbar");
  assert.ok(overflowBar.includes('aria-valuenow="100"'));
  assert.ok(overflowHtml.includes('data-readiness-phase="coaching_adjust"'));
  assert.ok(overflowHtml.includes("MOVE CLOSER"));
  assert.ok(overflowHtml.includes("Bring box 5 cm closer"));
  assert.ok(overflowHtml.includes("3/3 burst frames ready"));

  const nanDefaultBurstHtml = renderToStaticMarkup(
    createElement(FrameReadinessMeter, {
      cameraActive: false,
      checking: false,
      sharpness: Number.NaN,
      coach: null,
      lang: "en"
    })
  );
  const nanBar = extractOpeningTagByRole(nanDefaultBurstHtml, "progressbar");
  assert.ok(nanBar.includes('aria-valuenow="0"'));
  assert.ok(nanDefaultBurstHtml.includes('data-readiness-phase="standby"'));
  assert.ok(nanDefaultBurstHtml.includes("CAMERA STANDBY"));
  assert.ok(nanDefaultBurstHtml.includes("0/3 burst frames ready"));

  const verifyingHtml = renderMeter({
    cameraActive: true,
    checking: true,
    sharpness: 0.77,
    bufferedFrames: 3,
    coach: { cue: "hold_still", text: "" }
  });
  assert.ok(verifyingHtml.includes('data-readiness-phase="verifying"'));
  assert.ok(verifyingHtml.includes('aria-busy="true"'));
  assert.ok(verifyingHtml.includes("VERIFYING BURST"));
  assert.ok(verifyingHtml.includes("HOLD STILL"));
  assert.ok(verifyingHtml.includes("Hold steady for a moment"));
});

test("Localizes FrameReadinessMeter across en, fi, sv with en fallback", () => {
  const coach: CoachMsg = { cue: "rotate_left" };
  const enHtml = renderMeter({ lang: "en", coach, sharpness: 0.16, bufferedFrames: 1 });
  const fiHtml = renderMeter({ lang: "fi-FI", coach, sharpness: 0.16, bufferedFrames: 1 });
  const svHtml = renderMeter({ lang: "sv-SE", coach, sharpness: 0.16, bufferedFrames: 1 });
  const deHtml = renderMeter({ lang: "de", coach, sharpness: 0.16, bufferedFrames: 1 });

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Optinen terävyys ja käsiohjauksen valmius"));
  assert.ok(fiHtml.includes("OHJAA ASENTOA"));
  assert.ok(fiHtml.includes("KÄÄNNÄ VASEMMALLE"));
  assert.ok(fiHtml.includes("Käännä pakkausta vasemmalle"));
  assert.ok(fiHtml.includes("1/3 sarjaruutua valmiina"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Optisk skärpa och handvägledningsberedskap"));
  assert.ok(svHtml.includes("JUSTERAR GREPP"));
  assert.ok(svHtml.includes("VRID VÄNSTER"));
  assert.ok(svHtml.includes("Vrid förpackningen åt vänster"));
  assert.ok(svHtml.includes("1/3 seriebildrutor redo"));

  assert.equal(deHtml, enHtml);
});

test("FrameReadinessMeter and test suite contain zero comments, zero em dashes, and zero en dashes", async () => {
  const locales = ["en", "fi", "sv", "de"];
  const sharpnessValues: Array<number | null> = [null, Number.NaN, 0.15, 0.82, 1.6];
  const burstCounts = [0, 1, 3];
  const coachCases: Array<CoachMsg | null> = [
    null,
    ...ALL_CUES.map((cue) => ({ cue }))
  ];

  for (const lang of locales) {
    for (const cameraActive of [false, true]) {
      for (const checking of [false, true]) {
        for (const sharpness of sharpnessValues) {
          for (const bufferedFrames of burstCounts) {
            for (const coach of coachCases) {
              const html = renderMeter({
                cameraActive,
                checking,
                sharpness,
                bufferedFrames,
                coach,
                lang
              });
              assert.equal(
                html.includes(EM_DASH),
                false,
                `Em dash found for lang=${lang} cue=${coach?.cue ?? "none"}`
              );
              assert.equal(
                html.includes(EN_DASH),
                false,
                `En dash found for lang=${lang} cue=${coach?.cue ?? "none"}`
              );
            }
          }
        }
      }
    }
  }

  const componentPath = fileURLToPath(
    new URL("../src/components/FrameReadinessMeter.tsx", import.meta.url)
  );
  const testPath = fileURLToPath(new URL(import.meta.url));
  const [componentSrc, testSrc] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(testPath, "utf8")
  ]);

  for (const [name, src] of [
    ["FrameReadinessMeter.tsx", componentSrc],
    ["frameReadinessMeter.test.ts", testSrc]
  ] as const) {
    assert.equal(src.includes(EM_DASH), false, `${name} contains an em dash`);
    assert.equal(src.includes(EN_DASH), false, `${name} contains an en dash`);
    assert.equal(src.includes(LINE_COMMENT), false, `${name} contains a line comment`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name} contains a block comment opener`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name} contains a block comment closer`);
  }
});
