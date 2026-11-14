import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDemoScenario } from "../src/camera/demoScenarios.ts";
import {
  JudgeDemoTour,
  TOUR_STEPS,
  toTourStepAction,
  type JudgeDemoTourProps,
  type TourStepAction,
  type TourStepId
} from "../src/components/JudgeDemoTour.tsx";

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

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const noopRunStep: JudgeDemoTourProps["onRunStep"] = () => {};

function extractButtonTagByStepId(html: string, stepId: TourStepId): string {
  const pattern = new RegExp(`<button\\b[^>]*data-step-id="${stepId}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected step button for ${stepId}`);
  return match[0];
}

test("TOUR_STEPS maps all 5 core demo beats to valid scenarios, actions, chaos patches, and numbered localized labels", () => {
  assert.equal(TOUR_STEPS.length, 5);

  const expectedActions: TourStepAction[] = [
    {
      id: "evening_match",
      scenarioId: "amlodipine_match",
      modeAction: "snapshot"
    },
    {
      id: "nsaid_warning",
      scenarioId: "ibuprofen_nsaid",
      modeAction: "snapshot"
    },
    {
      id: "blurry_refusal",
      scenarioId: "blurry_strength",
      modeAction: "snapshot"
    },
    {
      id: "hazelnut_allergy",
      scenarioId: "hazelnut_allergy",
      modeAction: "snapshot"
    },
    {
      id: "offline_resilience",
      scenarioId: "amlodipine_match",
      modeAction: "offline_barcode",
      chaosPatch: { forceOffline: true }
    }
  ];

  assert.deepEqual(
    TOUR_STEPS.map((step) => toTourStepAction(step)),
    expectedActions
  );

  assert.deepEqual(
    TOUR_STEPS.map((step) => step.labels.en),
    [
      "1. Right Evening Pill",
      "2. NSAID Safety Catch",
      "3. Covered Dose (Zero Guess)",
      "4. Hidden Nut Allergen",
      "5. Wi-Fi Off Barcode Fallback"
    ]
  );

  TOUR_STEPS.forEach((step, idx) => {
    const numPrefix = `${idx + 1}. `;
    assert.equal(step.stepNumber, idx + 1);
    const scenario = getDemoScenario(step.scenarioId);
    assert.equal(scenario.id, step.scenarioId);

    assert.ok(step.labels.en.startsWith(numPrefix), `en label missing ${numPrefix}`);
    assert.ok(step.labels.fi.startsWith(numPrefix), `fi label missing ${numPrefix}`);
    assert.ok(step.labels.sv.startsWith(numPrefix), `sv label missing ${numPrefix}`);

    assert.notEqual(step.labels.en, step.labels.fi);
    assert.notEqual(step.labels.en, step.labels.sv);
    assert.notEqual(step.labels.fi, step.labels.sv);
  });

  const offlinePayload = toTourStepAction(TOUR_STEPS[4]);
  assert.ok(offlinePayload.chaosPatch);
  offlinePayload.chaosPatch.forceOffline = false;
  assert.deepEqual(TOUR_STEPS[4].chaosPatch, { forceOffline: true });
});

test("JudgeDemoTour renders accessible section, >= 56px buttons, and expanded vs collapsed states in en, fi, sv", () => {
  for (const locale of ["en", "fi", "sv"] as const) {
    const expandedHtml = renderToStaticMarkup(
      createElement(JudgeDemoTour, {
        lang: locale,
        onRunStep: noopRunStep
      })
    );

    assert.match(
      expandedHtml,
      /^<section\b[^>]*aria-label="Interactive judge demo walkthrough"[^>]*lang="(en|fi|sv)"/
    );
    assert.ok(expandedHtml.includes('data-collapsed="false"'));
    assert.ok(expandedHtml.includes('aria-expanded="true"'));
    assert.ok(expandedHtml.includes('aria-controls="judge-demo-tour-steps"'));
    assert.ok(expandedHtml.includes('id="judge-demo-tour-steps"'));

    const minHeightMatches = expandedHtml.match(/min-height:56px/g) ?? [];
    assert.equal(
      minHeightMatches.length,
      6,
      `Expected 1 toggle + 5 step buttons >= 56px in ${locale}`
    );

    for (const step of TOUR_STEPS) {
      assert.ok(
        expandedHtml.includes(step.labels[locale]),
        `Missing ${locale} label ${step.labels[locale]}`
      );
      assert.ok(
        expandedHtml.includes(step.details[locale]),
        `Missing ${locale} detail ${step.details[locale]}`
      );
    }

    const collapsedHtml = renderToStaticMarkup(
      createElement(JudgeDemoTour, {
        lang: locale,
        collapsed: true,
        activeStep: "offline_resilience",
        onRunStep: noopRunStep
      })
    );

    assert.match(
      collapsedHtml,
      /^<section\b[^>]*aria-label="Interactive judge demo walkthrough"/
    );
    assert.ok(collapsedHtml.includes('data-collapsed="true"'));
    assert.ok(collapsedHtml.includes('aria-expanded="false"'));
    assert.equal(collapsedHtml.includes('aria-controls="judge-demo-tour-steps"'), false);
    assert.equal(collapsedHtml.includes('id="judge-demo-tour-steps"'), false);
    assert.equal(collapsedHtml.includes("data-step-id="), false);
    assert.equal((collapsedHtml.match(/min-height:56px/g) ?? []).length, 1);
    assert.ok(collapsedHtml.includes(TOUR_STEPS[4].labels[locale]));
  }

  const enDefault = renderToStaticMarkup(
    createElement(JudgeDemoTour, { lang: "en", onRunStep: noopRunStep })
  );
  const fiRegional = renderToStaticMarkup(
    createElement(JudgeDemoTour, { lang: "fi-FI", onRunStep: noopRunStep })
  );
  const svRegional = renderToStaticMarkup(
    createElement(JudgeDemoTour, { lang: "sv-SE", onRunStep: noopRunStep })
  );
  const deFallback = renderToStaticMarkup(
    createElement(JudgeDemoTour, { lang: "de", onRunStep: noopRunStep })
  );

  assert.ok(enDefault.includes("60-Second Interactive Judge Walkthrough"));
  assert.ok(fiRegional.includes("60 sekunnin vuorovaikutteinen tuomaridemo"));
  assert.ok(svRegional.includes("60 sekunders interaktiv domargenomgång"));
  assert.equal(deFallback, enDefault);
});

test("JudgeDemoTour marks only the active step button with aria-current=step", () => {
  const idleHtml = renderToStaticMarkup(
    createElement(JudgeDemoTour, {
      lang: "en",
      activeStep: null,
      onRunStep: noopRunStep
    })
  );
  assert.equal(idleHtml.includes("aria-current="), false);

  for (const step of TOUR_STEPS) {
    const activeHtml = renderToStaticMarkup(
      createElement(JudgeDemoTour, {
        lang: "en",
        activeStep: step.id,
        onRunStep: noopRunStep
      })
    );

    const currentMatches = activeHtml.match(/aria-current="step"/g) ?? [];
    assert.equal(currentMatches.length, 1, `Expected exactly one aria-current for ${step.id}`);

    const activeBtnTag = extractButtonTagByStepId(activeHtml, step.id);
    assert.ok(activeBtnTag.includes('aria-current="step"'));

    for (const other of TOUR_STEPS) {
      if (other.id === step.id) continue;
      const otherBtnTag = extractButtonTagByStepId(activeHtml, other.id);
      assert.equal(otherBtnTag.includes("aria-current"), false);
    }
  }
});

test("JudgeDemoTour emits zero em dashes and zero en dashes across all locales and states", () => {
  for (const step of TOUR_STEPS) {
    for (const locale of ["en", "fi", "sv"] as const) {
      for (const value of [step.labels[locale], step.details[locale], step.badges[locale]]) {
        assert.equal(value.includes(EM_DASH), false, `Em dash in ${step.id} (${locale})`);
        assert.equal(value.includes(EN_DASH), false, `En dash in ${step.id} (${locale})`);
      }
    }
  }

  for (const locale of ["en", "fi", "sv", "de"] as const) {
    for (const collapsed of [false, true]) {
      for (const activeStep of [null, ...TOUR_STEPS.map((s) => s.id)] as const) {
        const html = renderToStaticMarkup(
          createElement(JudgeDemoTour, {
            lang: locale,
            collapsed,
            activeStep,
            onRunStep: noopRunStep
          })
        );
        assert.equal(html.includes(EM_DASH), false, `Em dash in ${locale} collapsed=${collapsed}`);
        assert.equal(html.includes(EN_DASH), false, `En dash in ${locale} collapsed=${collapsed}`);
      }
    }
  }
});
