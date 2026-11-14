import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  STRENGTH_MIN_CONF,
  SafetyRuleExplainerCard,
  summarizeProfileGuardrails,
  type SafetyRuleExplainerCardProps
} from "../src/components/SafetyRuleExplainerCard.tsx";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { Profile } from "../src/types.ts";

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

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

function renderCard(props: SafetyRuleExplainerCardProps): string {
  return renderToStaticMarkup(createElement(SafetyRuleExplainerCard, props));
}

function extractOpeningTagByAttr(html: string, attrName: string, attrValue: string): string {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVal = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\b${escapedAttr}="${escapedVal}"[^>]*>`,
    "i"
  );
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with ${attrName}="${attrValue}"`);
  return match[0];
}

test("summarizeProfileGuardrails personalizes all 6 deterministic layers for DEMO_PROFILE and logged doses", () => {
  assert.equal(STRENGTH_MIN_CONF, 0.8);

  const items = summarizeProfileGuardrails(DEMO_PROFILE);
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((x) => x.id),
    [
      "strength_gate",
      "rx_match",
      "drug_avoid",
      "allergens",
      "expiry_guard",
      "double_dose"
    ]
  );

  assert.deepEqual(
    items.map((x) => x.title),
    [
      "80% Never-Guess Dose Gate",
      "Prescription Ingredient & Strength Match",
      "Drug-Class & Avoid Rules",
      "Allergen & Excipient Synonym Catch",
      "Expiry Month & Date Guard",
      "Same-Day Double-Dose Prevention"
    ]
  );

  assert.deepEqual(
    items.map((x) => x.activeCount),
    [1, 3, 1, 2, 1, 0]
  );

  assert.equal(items[0].badge, "HARD GATE >= 80%");
  assert.ok(items[0].detail.includes("STRENGTH_MIN_CONF = 0.80"));

  assert.equal(items[1].badge, "3 SAVED MEDS");
  assert.ok(items[1].detail.includes("Amlodipin 5 mg, Metformin 500 mg, Panadol 500 mg"));
  assert.ok(items[1].detail.includes("2,5 mg -> 2.5 mg"));

  assert.equal(items[2].badge, "1 ACTIVE RULE");
  assert.ok(items[2].detail.includes("NSAIDs -> ibuprofen / Burana"));

  assert.equal(items[3].badge, "2 ACTIVE ALLERGIES");
  assert.ok(items[3].detail.includes("peanut, tree nuts"));
  assert.ok(items[3].detail.includes("arachis -> peanut"));
  assert.ok(items[3].detail.includes("hasselpahkina -> tree nuts"));

  assert.equal(items[4].badge, "ALWAYS ON");
  assert.ok(items[4].detail.includes("cartons and blister packs"));

  assert.equal(items[5].badge, "0 LOGGED EVENTS");
  assert.ok(items[5].detail.includes("3 daily scheduled slots"));

  const withDoses: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: Date.UTC(2026, 10, 14, 8, 15, 0) },
      { medId: "met", ts: Date.UTC(2026, 10, 14, 18, 30, 0) }
    ]
  };
  const itemsWithDoses = summarizeProfileGuardrails(withDoses, "en");
  assert.equal(itemsWithDoses[5].activeCount, 2);
  assert.equal(itemsWithDoses[5].badge, "2 LOGGED EVENTS");
  assert.ok(itemsWithDoses[5].detail.includes("2 logged events"));
});

test("summarizeProfileGuardrails handles empty profiles, singular counts, and list truncation cleanly", () => {
  const emptyItems = summarizeProfileGuardrails(EMPTY_PROFILE, "en");
  assert.equal(emptyItems.length, 6);
  assert.deepEqual(
    emptyItems.map((x) => x.activeCount),
    [1, 0, 0, 0, 1, 0]
  );

  assert.equal(emptyItems[1].badge, "0 SAVED MEDS");
  assert.ok(emptyItems[1].detail.includes("0 saved meds"));
  assert.ok(emptyItems[1].detail.includes("2,5 mg -> 2.5 mg"));

  assert.equal(emptyItems[2].badge, "0 ACTIVE RULES");
  assert.ok(emptyItems[2].detail.includes("NSAIDs -> ibuprofen / Burana"));

  assert.equal(emptyItems[3].badge, "0 ACTIVE ALLERGIES");
  assert.ok(emptyItems[3].detail.includes("arachis -> peanut"));
  assert.ok(emptyItems[3].detail.includes("hasselpahkina -> tree nuts"));

  assert.equal(emptyItems[5].badge, "0 LOGGED EVENTS");

  const singularAndLongProfile: Profile = {
    meds: [DEMO_PROFILE.meds[0]],
    allergies: ["peanut"],
    avoid: ["penicillins", "statins", "anticoagulants", "opioids"],
    doseLog: [{ medId: "aml", ts: Date.UTC(2026, 10, 14, 20, 0, 0) }],
    lang: "en"
  };

  const singularItems = summarizeProfileGuardrails(singularAndLongProfile, "en");
  assert.equal(singularItems[1].badge, "1 SAVED MED");
  assert.equal(singularItems[2].badge, "4 ACTIVE RULES");
  assert.ok(singularItems[2].detail.includes("penicillins -> amoxicillin / Amorion"));
  assert.ok(singularItems[2].detail.includes("+1 more"));
  assert.equal(singularItems[3].badge, "1 ACTIVE ALLERGY");
  assert.equal(singularItems[5].badge, "1 LOGGED EVENT");
});

test("SafetyRuleExplainerCard SSR renders accessible section, 6 distinct guardrail cards, and EU MDR Art. 2(1) boundary", () => {
  const html = renderCard({
    profile: DEMO_PROFILE,
    lang: "en"
  });

  assert.match(
    html,
    /^<section\b[^>]*aria-labelledby="safety-rule-explainer-heading"[^>]*lang="en"/
  );
  assert.match(
    html,
    /<h2\b[^>]*id="safety-rule-explainer-heading"[^>]*>6 Deterministic Personal Safety Guardrails<\/h2>/
  );
  assert.ok(html.includes("5/6 Active Layers"));
  assert.ok(html.includes("Profile Stored Only On Device"));
  assert.ok(html.includes('aria-label="Active deterministic safety guardrails"'));

  const expectedCounts: Record<string, string> = {
    strength_gate: "1",
    rx_match: "3",
    drug_avoid: "1",
    allergens: "2",
    expiry_guard: "1",
    double_dose: "0"
  };

  const svgs = new Set<string>();
  for (const [id, expectedCount] of Object.entries(expectedCounts)) {
    const liTag = extractOpeningTagByAttr(html, "data-guardrail-id", id);
    assert.ok(
      liTag.includes(`data-active-count="${expectedCount}"`),
      `Expected data-active-count="${expectedCount}" for ${id}`
    );

    const idx = html.indexOf(`data-guardrail-id="${id}"`);
    const svgStart = html.indexOf("<svg", idx);
    const svgEnd = html.indexOf("</svg>", svgStart);
    assert.ok(svgStart >= 0 && svgEnd > svgStart, `Missing SVG icon in ${id}`);
    svgs.add(html.slice(svgStart, svgEnd + 6));
  }
  assert.equal(svgs.size, 6, "Each guardrail layer should render a distinct SVG icon");

  assert.match(html, /class="safety-mdr-boundary-note"[^>]*role="note"|role="note"[^>]*class="safety-mdr-boundary-note"/);
  assert.ok(html.includes("EU MDR Art. 2(1)"));
  assert.ok(html.includes("Not a medical device. Always confirm uncertain labels with a pharmacist."));

  const emptyHtml = renderCard({
    profile: EMPTY_PROFILE,
    lang: "en"
  });
  assert.ok(emptyHtml.includes("2/6 Active Layers"));
});

test("Localizes summarizeProfileGuardrails and SafetyRuleExplainerCard across en, fi, sv with en fallback", () => {
  const enItems = summarizeProfileGuardrails(DEMO_PROFILE, "en");
  const fiItems = summarizeProfileGuardrails(DEMO_PROFILE, "fi-FI");
  const svItems = summarizeProfileGuardrails(DEMO_PROFILE, "sv-SE");
  const deItems = summarizeProfileGuardrails(DEMO_PROFILE, "de");

  assert.equal(fiItems[0].title, "80 % ei-arvausta-annosraja");
  assert.equal(fiItems[1].badge, "3 TALLENNETTUA LÄÄKETTÄ");
  assert.equal(svItems[0].title, "80 % gissa-aldrig-dosgräns");
  assert.equal(svItems[1].badge, "3 SPARADE LÄKEMEDEL");
  assert.deepEqual(deItems, enItems);

  const enHtml = renderCard({ profile: DEMO_PROFILE, lang: "en" });
  const fiHtml = renderCard({ profile: DEMO_PROFILE, lang: "fi-FI" });
  const svHtml = renderCard({ profile: DEMO_PROFILE, lang: "sv-SE" });
  const deHtml = renderCard({ profile: DEMO_PROFILE, lang: "de" });

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("6 determinististä henkilökohtaista turvasääntöä"));
  assert.ok(fiHtml.includes("EU MDR Art. 2(1)"));
  assert.ok(fiHtml.includes("Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("6 deterministiska personliga säkerhetsspärrar"));
  assert.ok(svHtml.includes("EU MDR Art. 2(1)"));
  assert.ok(svHtml.includes("Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."));

  assert.equal(deHtml, enHtml);
});

test("SafetyRuleExplainerCard emits zero em dashes, zero en dashes, and zero code comments", async () => {
  const profiles: Profile[] = [
    DEMO_PROFILE,
    EMPTY_PROFILE,
    {
      ...DEMO_PROFILE,
      doseLog: [{ medId: "aml", ts: Date.UTC(2026, 10, 14, 19, 0, 0) }]
    }
  ];

  for (const locale of ["en", "fi", "sv", "de"]) {
    for (const p of profiles) {
      const html = renderCard({ profile: p, lang: locale });
      assert.equal(html.includes(EM_DASH), false, `Em dash found in HTML for ${locale}`);
      assert.equal(html.includes(EN_DASH), false, `En dash found in HTML for ${locale}`);
    }
  }

  const componentPath = fileURLToPath(
    new URL("../src/components/SafetyRuleExplainerCard.tsx", import.meta.url)
  );
  const testPath = fileURLToPath(new URL(import.meta.url));
  const [componentSrc, testSrc] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(testPath, "utf8")
  ]);

  for (const [name, src] of [
    ["SafetyRuleExplainerCard.tsx", componentSrc],
    ["safetyRuleExplainerCard.test.ts", testSrc]
  ] as const) {
    assert.equal(src.includes(EM_DASH), false, `${name} contains an em dash`);
    assert.equal(src.includes(EN_DASH), false, `${name} contains an en dash`);
    assert.doesNotMatch(src, /(?:^|\s)\/\//m, `${name} contains a line comment`);
    assert.equal(src.includes("/" + "*"), false, `${name} contains a block comment`);
  }
});
