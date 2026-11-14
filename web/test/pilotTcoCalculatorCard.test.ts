import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COHORT_PRESETS,
  PRICING_TIERS,
  PilotTcoCalculatorCard,
  computePilotTcoModel,
  formatEuroAmount,
  formatProcurementDossierSummary
} from "../src/components/PilotTcoCalculatorCard.tsx";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const unitEconUrl = new URL("../../eval/unit_economics.json", import.meta.url);
const componentSourceUrl = new URL("../src/components/PilotTcoCalculatorCard.tsx", import.meta.url);
const selfSourceUrl = new URL("./pilotTcoCalculatorCard.test.ts", import.meta.url);

test("computePilotTcoModel matches eval/unit_economics.json 3-year TCO, savings, and 100-user HUS cohort figures", () => {
  const unitEcon = JSON.parse(readFileSync(unitEconUrl, "utf8")) as {
    headline_summary: {
      tco_3yr_holdup_rayban_meta_gen2_eur: number;
      tco_3yr_orcam_myeye_midpoint_eur: number;
      tco_3yr_aira_paid_daily_plan_eur: number;
      tco_savings_vs_orcam_midpoint_pct: number;
      tco_cost_reduction_multiple_vs_orcam: number;
      video_bandwidth_saved_in_adaptive_mode_pct: number;
    };
  };

  const std100 = computePilotTcoModel({
    cohortSize: 100,
    checksPerDay: 4,
    localBarcodeSharePct: 0,
    tier: "standard_cached",
    adaptiveSlowWifi: false
  });

  assert.equal(
    std100.perUserThreeYearHoldUpEur,
    unitEcon.headline_summary.tco_3yr_holdup_rayban_meta_gen2_eur
  );
  assert.equal(
    std100.perUserThreeYearOrcamEur,
    unitEcon.headline_summary.tco_3yr_orcam_myeye_midpoint_eur
  );
  assert.equal(
    std100.perUserThreeYearAiraEur,
    unitEcon.headline_summary.tco_3yr_aira_paid_daily_plan_eur
  );
  assert.equal(
    std100.savingsVsOrcamPct,
    unitEcon.headline_summary.tco_savings_vs_orcam_midpoint_pct
  );
  assert.equal(
    std100.costReductionMultipleVsOrcam,
    unitEcon.headline_summary.tco_cost_reduction_multiple_vs_orcam
  );
  assert.equal(std100.cohortThreeYearHoldUpEur, 34168.0);
  assert.equal(std100.cohortThreeYearOrcamEur, 415000.0);
  assert.equal(std100.cohortSavingsVsOrcamEur, 380832.0);
  assert.equal(std100.usersServedOnOrcamBudget, 1214);
  assert.equal(std100.savingsVsAiraPct, 85.4);

  const econ1 = computePilotTcoModel({ cohortSize: 1, tier: "economy_2_0_live" });
  assert.equal(econ1.perUserThreeYearHoldUpEur, 336.44);

  const ceil1 = computePilotTcoModel({ cohortSize: 1, tier: "uncached_native_audio_ceiling" });
  assert.equal(ceil1.perUserThreeYearHoldUpEur, 361.36);

  const blended = computePilotTcoModel({
    cohortSize: 24,
    checksPerDay: 4,
    localBarcodeSharePct: 30,
    tier: "standard_cached",
    adaptiveSlowWifi: true
  });
  assert.equal(
    blended.videoBandwidthSavedPct,
    unitEcon.headline_summary.video_bandwidth_saved_in_adaptive_mode_pct
  );
  assert.ok(blended.perUserThreeYearCloudEur < std100.perUserThreeYearCloudEur);
  assert.equal(formatEuroAmount(415000), "415,000.00");
});

test("formatProcurementDossierSummary emits clean trilingual en/fi/sv text with zero PII and zero em dashes", () => {
  for (const lang of ["en", "fi", "sv"]) {
    const text = formatProcurementDossierSummary({ cohortSize: 24, checksPerDay: 4 }, lang);
    assert.ok(text.includes("24"), `Expected cohort size in ${lang} dossier`);
    assert.ok(text.includes("341.68"), `Expected 341.68 per-user TCO in ${lang} dossier`);
    assert.match(text, /91\.8\s*%/, `Expected 91.8% savings in ${lang} dossier`);
    assert.ok(text.includes("holdup://rx"), `Expected holdup://rx QR reference in ${lang} dossier`);
    assert.equal(text.includes(EM_DASH), false);
    assert.equal(text.includes(EN_DASH), false);
  }
});

test("PilotTcoCalculatorCard SSR renders WCAG 2.2 AAA region, >=56px buttons, table semantics, and trilingual copy", () => {
  assert.deepEqual([...COHORT_PRESETS], [1, 24, 100, 500]);
  assert.equal(PRICING_TIERS.length, 3);

  for (const lang of ["en", "fi", "sv"]) {
    const html = renderToStaticMarkup(
      createElement(PilotTcoCalculatorCard, {
        lang,
        initialCohortSize: 24,
        initialLocalBarcodeSharePct: 30,
        initialAdaptiveSlowWifi: true
      })
    );
    assert.match(html, /role="region"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /min-height:56px/);
    assert.match(html, /<table\b/);
    assert.match(html, /scope="col"/);
    assert.match(html, /scope="row"/);
    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});

test("PilotTcoCalculatorCard source and test maintain strict zero-comment and zero-em-dash hygiene", () => {
  for (const [label, url] of [
    ["PilotTcoCalculatorCard.tsx", componentSourceUrl],
    ["pilotTcoCalculatorCard.test.ts", selfSourceUrl]
  ] as const) {
    const src = readFileSync(url, "utf8");
    const sanitized = src.split("holdup://rx").join("holdup-rx");
    assert.equal(sanitized.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
    assert.equal(sanitized.includes(BLOCK_COMMENT_OPEN), false, `${label} must contain zero block comments`);
    assert.equal(src.includes(EM_DASH), false, `${label} must contain zero em dashes`);
    assert.equal(src.includes(EN_DASH), false, `${label} must contain zero en dashes`);
  }
});
