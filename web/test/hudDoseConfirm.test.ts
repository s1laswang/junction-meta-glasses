import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_UNDO_WINDOW_MS,
  HudDoseConfirmStrip,
  NEURAL_PINCH_DEBOUNCE_MS,
  createInitialDoseConfirmState,
  nextConfirmFocusIndex,
  reduceDoseConfirmAction,
  resolveHudDoseLocale,
  type DoseConfirmState
} from "../src/hud/HudDoseConfirmStrip.tsx";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

test("resolveHudDoseLocale normalizes EN, FI, SV, and regional BCP-47 tags", () => {
  assert.equal(resolveHudDoseLocale(undefined), "en");
  assert.equal(resolveHudDoseLocale(""), "en");
  assert.equal(resolveHudDoseLocale("en-US"), "en");
  assert.equal(resolveHudDoseLocale("de-DE"), "en");
  assert.equal(resolveHudDoseLocale("fi"), "fi");
  assert.equal(resolveHudDoseLocale("  FI-fi "), "fi");
  assert.equal(resolveHudDoseLocale("sv"), "sv");
  assert.equal(resolveHudDoseLocale("sv-SE"), "sv");
});

test("reduceDoseConfirmAction enforces 2-pinch safety arming, safe Cancel default focus, confirm, undo, and timeout expiry", () => {
  const s0: DoseConfirmState = createInitialDoseConfirmState();
  assert.equal(s0.phase, "idle");
  assert.equal(s0.focusIndex, 1);
  assert.equal(NEURAL_PINCH_DEBOUNCE_MS, 150);

  const blankArm = reduceDoseConfirmAction(s0, {
    type: "arm",
    medName: "   ",
    strength: "5 mg",
    nowMs: 1000
  });
  assert.equal(blankArm, s0);

  const armed = reduceDoseConfirmAction(s0, {
    type: "arm",
    medName: `Amlodipine ${EM_DASH} tablet`,
    strength: "5 mg",
    nowMs: 1000
  });
  assert.equal(armed.phase, "confirming");
  assert.equal(armed.medName.includes(EM_DASH), false);
  assert.equal(armed.strength, "5 mg");
  assert.equal(armed.focusIndex, 1, "Initial focus must land safely on Cancel (index 1)");
  assert.equal(armed.armedAtMs, 1000);
  assert.equal(armed.loggedAtMs, null);

  const focusedLeft = reduceDoseConfirmAction(armed, { type: "focus", key: "ArrowLeft" });
  assert.equal(focusedLeft.focusIndex, 0);

  const notYetExpired = reduceDoseConfirmAction(focusedLeft, {
    type: "expire",
    nowMs: 1000 + DEFAULT_CONFIRM_TIMEOUT_MS - 1
  });
  assert.equal(notYetExpired.phase, "confirming");

  const expiredArm = reduceDoseConfirmAction(focusedLeft, {
    type: "expire",
    nowMs: 1000 + DEFAULT_CONFIRM_TIMEOUT_MS
  });
  assert.equal(expiredArm.phase, "idle");

  const logged = reduceDoseConfirmAction(focusedLeft, {
    type: "confirm",
    nowMs: 2500
  });
  assert.equal(logged.phase, "logged");
  assert.equal(logged.focusIndex, 1, "Logged state defaults focus safely to Done (index 1)");
  assert.equal(logged.armedAtMs, null);
  assert.equal(logged.loggedAtMs, 2500);

  const undone = reduceDoseConfirmAction(logged, { type: "undo" });
  assert.equal(undone.phase, "idle");

  const expiredLogged = reduceDoseConfirmAction(logged, {
    type: "expire",
    nowMs: 2500 + DEFAULT_UNDO_WINDOW_MS
  });
  assert.equal(expiredLogged.phase, "idle");
});

test("nextConfirmFocusIndex cycles cleanly across Neural Band ArrowLeft/Right/Up/Down keys", () => {
  assert.equal(nextConfirmFocusIndex(1, 2, "ArrowLeft"), 0);
  assert.equal(nextConfirmFocusIndex(0, 2, "ArrowLeft"), 1);
  assert.equal(nextConfirmFocusIndex(1, 2, "ArrowUp"), 0);
  assert.equal(nextConfirmFocusIndex(0, 2, "ArrowRight"), 1);
  assert.equal(nextConfirmFocusIndex(1, 2, "ArrowDown"), 0);
  assert.equal(nextConfirmFocusIndex(1, 2, "Enter"), 1);
  assert.equal(nextConfirmFocusIndex(0, 0, "ArrowRight"), 0);
});

test("HudDoseConfirmStrip renders transparent standby null when idle and pure #000000 high-contrast cards across EN/FI/SV", () => {
  const idleHtml = renderToStaticMarkup(
    createElement(HudDoseConfirmStrip, {
      medName: "Amlodipine",
      strength: "5 mg"
    })
  );
  assert.equal(idleHtml, "", "Idle phase must emit zero waveguide DOM nodes");

  for (const lang of ["en", "fi", "sv"] as const) {
    const confirmHtml = renderToStaticMarkup(
      createElement(HudDoseConfirmStrip, {
        medName: "Amlodipine",
        strength: "5 mg",
        lang,
        initialState: {
          phase: "confirming",
          medName: "Amlodipine",
          strength: "5 mg",
          focusIndex: 1,
          armedAtMs: 1000
        }
      })
    );

    assert.match(confirmHtml, /data-dose-confirm-phase="confirming"/);
    assert.match(confirmHtml, /data-hud-surface="600x600-additive-strip"/);
    assert.match(confirmHtml, /background-color:#000000/);
    assert.match(confirmHtml, /border:3\.5px solid #ffbb22/);
    assert.match(confirmHtml, /min-height:64px/);
    assert.match(confirmHtml, /data-dose-confirm-action="confirm"[^>]*data-focused="false"/);
    assert.match(confirmHtml, /data-dose-confirm-action="cancel"[^>]*data-focused="true"/);
    assert.equal(confirmHtml.includes(EM_DASH), false);

    const h2Match = /<h2[^>]*>([^<]+)<\/h2>/.exec(confirmHtml);
    assert.ok(h2Match, `Expected headline in ${lang}`);
    assert.ok(
      h2Match[1].trim().split(/\s+/).length <= 8,
      `Headline must obey <= 8 word waveguide cap in ${lang}`
    );

    const loggedHtml = renderToStaticMarkup(
      createElement(HudDoseConfirmStrip, {
        medName: "Metformin",
        strength: "500 mg",
        lang,
        initialState: {
          phase: "logged",
          medName: "Metformin",
          strength: "500 mg",
          focusIndex: 1,
          loggedAtMs: 2000
        }
      })
    );

    assert.match(loggedHtml, /data-dose-confirm-phase="logged"/);
    assert.match(loggedHtml, /background-color:#000000/);
    assert.match(loggedHtml, /border:3\.5px solid #22ff88/);
    assert.match(loggedHtml, /data-dose-confirm-action="undo"[^>]*data-focused="false"/);
    assert.match(loggedHtml, /data-dose-confirm-action="done"[^>]*data-focused="true"/);
    assert.equal(loggedHtml.includes(EM_DASH), false);
  }
});

test("HudDoseConfirmStrip source and test files contain zero comments and zero em or en dashes", () => {
  const componentSrc = readFileSync(
    new URL("../src/hud/HudDoseConfirmStrip.tsx", import.meta.url),
    "utf8"
  );
  const testSrc = readFileSync(new URL("./hudDoseConfirm.test.ts", import.meta.url), "utf8");

  for (const [label, src] of [
    ["HudDoseConfirmStrip.tsx", componentSrc],
    ["hudDoseConfirm.test.ts", testSrc]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${label}: forbidden line comment`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${label}: forbidden block comment`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${label}: forbidden block close`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${label}: forbidden HTML comment`);
    assert.equal(src.includes(EM_DASH), false, `${label}: forbidden em dash`);
    assert.equal(src.includes(EN_DASH), false, `${label}: forbidden en dash`);
  }
});
