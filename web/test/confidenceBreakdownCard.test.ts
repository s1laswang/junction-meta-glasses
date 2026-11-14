import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConfidenceBreakdownCard,
  STRENGTH_GATE_THRESHOLD,
  buildFieldInspectionRows,
  type ConfidenceBreakdownCardProps
} from "../src/components/ConfidenceBreakdownCard.tsx";
import type { LabelRead, Verdict } from "../src/types.ts";

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

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine Orion", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.93 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.92 },
    allergens: { value: ["lactose"], confidence: 0.88 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.94,
    ...overrides
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes: Amlodipine 5 mg, your evening pill",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: makeLabelRead(),
    matchedMedId: "aml",
    reasons: ["matches aml", "taken today: 0/1"],
    takenToday: false,
    ...overrides
  };
}

function renderCard(props: ConfidenceBreakdownCardProps): string {
  return renderToStaticMarkup(createElement(ConfidenceBreakdownCard, props));
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

test("ConfidenceBreakdownCard returns null when verdict is null and exports STRENGTH_GATE_THRESHOLD = 0.80", () => {
  assert.equal(STRENGTH_GATE_THRESHOLD, 0.8);
  assert.equal(renderCard({ verdict: null, lang: "en" }), "");
  assert.equal(renderCard({ verdict: null, lang: "fi", defaultExpanded: false }), "");
  assert.equal(renderCard({ verdict: null, lang: "sv", defaultExpanded: true }), "");
});

test("buildFieldInspectionRows covers all 8 required keys, clamps [0, 100%], and enforces 80% gate on strength", () => {
  const rowsAt80 = buildFieldInspectionRows(
    makeLabelRead({
      strength: { value: "5 mg", confidence: 0.8 },
      dosing: { value: "1 tablet daily", confidence: 0.85 },
      guidance: "Keep front label level."
    }),
    "en"
  );

  assert.deepEqual(
    rowsAt80.map((r) => r.key),
    [
      "product",
      "ingredient",
      "strength",
      "dosageInstructions",
      "allergens",
      "expiry",
      "warnings",
      "barcode"
    ]
  );

  const strength80 = rowsAt80.find((r) => r.key === "strength");
  assert.ok(strength80);
  assert.equal(strength80.gated, true);
  assert.equal(strength80.gatePassed, true);
  assert.equal(strength80.confidencePct, 80);
  assert.equal(strength80.displayValue, "5 mg");

  const dosageRow = rowsAt80.find((r) => r.key === "dosageInstructions");
  assert.ok(dosageRow);
  assert.equal(dosageRow.displayValue, "1 tablet daily");
  assert.equal(dosageRow.confidencePct, 85);

  const warningsRow = rowsAt80.find((r) => r.key === "warnings");
  assert.ok(warningsRow);
  assert.equal(warningsRow.displayValue, "Keep front label level.");
  assert.equal(warningsRow.confidencePct, 94);

  const rowsAt79 = buildFieldInspectionRows(
    makeLabelRead({
      strength: { value: "5 mg", confidence: 0.79 }
    }),
    "en"
  );
  const strength79 = rowsAt79.find((r) => r.key === "strength");
  assert.ok(strength79);
  assert.equal(strength79.gated, true);
  assert.equal(strength79.gatePassed, false);
  assert.equal(strength79.confidencePct, 79);

  const rowsNear80 = buildFieldInspectionRows(
    makeLabelRead({
      strength: { value: "5 mg", confidence: 0.798 }
    }),
    "en"
  );
  const strengthNear80 = rowsNear80.find((r) => r.key === "strength");
  assert.ok(strengthNear80);
  assert.equal(strengthNear80.gatePassed, false);
  assert.equal(strengthNear80.confidencePct, 79);

  const rowsNullStrength = buildFieldInspectionRows(
    makeLabelRead({
      strength: { value: null, confidence: 0.92 },
      product: { value: "   ", confidence: -0.4 },
      barcode: { value: "6432100012345", confidence: 1.4 }
    }),
    "en"
  );
  const strengthNull = rowsNullStrength.find((r) => r.key === "strength");
  assert.ok(strengthNull);
  assert.equal(strengthNull.gated, true);
  assert.equal(strengthNull.gatePassed, false);
  assert.equal(strengthNull.displayValue, "Not readable");

  const clampedLow = rowsNullStrength.find((r) => r.key === "product");
  const clampedHigh = rowsNullStrength.find((r) => r.key === "barcode");
  assert.equal(clampedLow?.confidencePct, 0);
  assert.equal(clampedHigh?.confidencePct, 100);
});

test("SSR flags 79% medication strength as blocked vs 80% as passed, renders meters, 80% threshold tick, and audit pills", () => {
  const blockedHtml = renderCard({
    verdict: makeVerdict({
      level: "unsure",
      headline: "Amlodipine: strength unclear",
      read: makeLabelRead({
        strength: { value: "5 mg", confidence: 0.79 }
      }),
      reasons: ["strength confidence 0.79 < 0.8", "pharmacist handoff advised"]
    }),
    lang: "en"
  });

  assert.match(
    blockedHtml,
    /^<section\b[^>]*aria-labelledby="confidence-breakdown-heading"[^>]*lang="en"/
  );
  const blockedSummaryTag = extractOpeningTagByAttr(blockedHtml, "data-gate-status", "blocked");
  assert.ok(blockedSummaryTag.includes('role="status"'));
  assert.ok(blockedHtml.includes("80% Dose Gate: BLOCKED (79% &lt; 80%)"));

  const blockedStrengthRowTag = extractOpeningTagByAttr(blockedHtml, "data-field-key", "strength");
  assert.ok(blockedStrengthRowTag.includes('data-gated="true"'));
  assert.ok(blockedStrengthRowTag.includes('data-gate-passed="false"'));
  assert.ok(blockedHtml.includes("BLOCKED &lt; 80%"));
  assert.ok(blockedHtml.includes("Blocked by 80% never-guess gate"));

  const tickTag = extractOpeningTagByAttr(blockedHtml, "data-threshold-pct", "80");
  assert.ok(tickTag.includes("left:80%"));

  const meterMatches = blockedHtml.match(/<meter\b[^>]*min="0"[^>]*max="100"/g) ?? [];
  assert.equal(meterMatches.length, 8, "Expected 8 accessible <meter> elements");
  assert.ok(blockedHtml.includes('value="79"'));
  assert.ok(blockedHtml.includes("width:79%"));
  assert.ok(blockedHtml.includes("strength confidence 0.79 &lt; 0.8"));
  assert.ok(blockedHtml.includes("pharmacist handoff advised"));

  const passedHtml = renderCard({
    verdict: makeVerdict({
      level: "match",
      read: makeLabelRead({
        strength: { value: "5 mg", confidence: 0.8 }
      }),
      reasons: ["matches aml", "taken today: 0/1"]
    }),
    lang: "en"
  });

  const passedSummaryTag = extractOpeningTagByAttr(passedHtml, "data-gate-status", "passed");
  assert.ok(passedSummaryTag.includes('role="status"'));
  assert.ok(passedHtml.includes("80% Dose Gate: PASSED (80%)"));

  const passedStrengthRowTag = extractOpeningTagByAttr(passedHtml, "data-field-key", "strength");
  assert.ok(passedStrengthRowTag.includes('data-gated="true"'));
  assert.ok(passedStrengthRowTag.includes('data-gate-passed="true"'));
  assert.ok(passedHtml.includes("PASSED &gt;= 80%"));
  assert.ok(passedHtml.includes("Strength meets the 80% deterministic safety gate."));
  assert.equal(passedHtml.includes("Blocked by 80% never-guess gate"), false);
  assert.ok(passedHtml.includes('value="80"'));
  assert.ok(passedHtml.includes("width:80%"));
});

test("Food allergen row formatting handles populated allergens, empty list, and null panel accurately", () => {
  const withAllergensRead = makeLabelRead({
    kind: "food",
    product: { value: "Nordic Crunch Bar", confidence: 0.97 },
    ingredient: { value: "oat snack bar", confidence: 0.9 },
    strength: { value: null, confidence: 0 },
    dosing: { value: null, confidence: 0 },
    allergens: { value: ["hazelnut", "may contain: milk"], confidence: 0.93 },
    expiry: { value: "2027-02-14", confidence: 0.89 }
  });

  const rowsPopulated = buildFieldInspectionRows(withAllergensRead, "en");
  const allergenPopulated = rowsPopulated.find((r) => r.key === "allergens");
  assert.ok(allergenPopulated);
  assert.equal(allergenPopulated.displayValue, "hazelnut, may contain: milk");
  assert.equal(allergenPopulated.confidencePct, 93);

  const rowsEmpty = buildFieldInspectionRows(
    makeLabelRead({
      kind: "food",
      allergens: { value: [], confidence: 0.91 }
    }),
    "en"
  );
  assert.equal(
    rowsEmpty.find((r) => r.key === "allergens")?.displayValue,
    "None declared"
  );

  const rowsNull = buildFieldInspectionRows(
    makeLabelRead({
      kind: "food",
      allergens: { value: null, confidence: 0.22 }
    }),
    "en"
  );
  const allergenNull = rowsNull.find((r) => r.key === "allergens");
  assert.equal(allergenNull?.displayValue, "Not readable");
  assert.equal(allergenNull?.confidencePct, 22);

  const foodHtml = renderCard({
    verdict: makeVerdict({
      level: "warning",
      headline: "Warning: contains hazelnut",
      speech: "Warning: Nordic Crunch Bar contains hazelnut.",
      read: withAllergensRead,
      matchedMedId: undefined,
      reasons: ["contains hazelnut (allergy: nuts)"]
    }),
    lang: "en"
  });

  const naBadgeTag = extractOpeningTagByAttr(foodHtml, "data-gate-status", "not-applicable");
  assert.ok(naBadgeTag.includes("is-gate-not-applicable"));
  assert.ok(foodHtml.includes("Food Label Mode (Allergen &amp; Expiry Check)"));
  assert.ok(foodHtml.includes("hazelnut, may contain: milk"));
  assert.ok(foodHtml.includes("contains hazelnut (allergy: nuts)"));
});

test("Disclosure toggle satisfies >= 48px target height and respects defaultExpanded true vs false", () => {
  const expandedHtml = renderCard({
    verdict: makeVerdict({ reasons: [] }),
    lang: "en",
    defaultExpanded: true
  });

  const toggleExpanded = extractOpeningTagByAttr(
    expandedHtml,
    "data-action",
    "toggle-confidence-breakdown"
  );
  assert.ok(toggleExpanded.includes('aria-expanded="true"'));
  assert.ok(toggleExpanded.includes('aria-controls="confidence-breakdown-panel"'));
  assert.ok(toggleExpanded.includes("min-height:56px"));
  assert.ok(expandedHtml.includes('id="confidence-breakdown-panel"'));
  assert.ok(expandedHtml.includes("No additional rule flags recorded"));

  const collapsedHtml = renderCard({
    verdict: makeVerdict(),
    lang: "en",
    defaultExpanded: false
  });

  const toggleCollapsed = extractOpeningTagByAttr(
    collapsedHtml,
    "data-action",
    "toggle-confidence-breakdown"
  );
  assert.ok(toggleCollapsed.includes('aria-expanded="false"'));
  assert.equal(toggleCollapsed.includes("aria-controls="), false);
  assert.ok(toggleCollapsed.includes("min-height:56px"));
  assert.equal(collapsedHtml.includes('id="confidence-breakdown-panel"'), false);
  assert.ok(collapsedHtml.includes("80% Dose Gate: PASSED (93%)"));
});

test("Localizes labels, gate statuses, allergen fallbacks, and disclaimers across en, fi, sv with clean fallback", () => {
  const blockedVerdict = makeVerdict({
    level: "unsure",
    read: makeLabelRead({
      strength: { value: "5 mg", confidence: 0.74 },
      allergens: { value: [], confidence: 0.88 }
    }),
    reasons: ["strength confidence 0.74 < 0.8"]
  });

  const enHtml = renderCard({ verdict: blockedVerdict, lang: "en" });
  const fiHtml = renderCard({ verdict: blockedVerdict, lang: "fi-FI" });
  const svHtml = renderCard({ verdict: blockedVerdict, lang: "sv-SE" });
  const deFallbackHtml = renderCard({ verdict: blockedVerdict, lang: "de" });

  assert.ok(enHtml.includes("Read confidence by field"));
  assert.ok(enHtml.includes("Dosage instructions"));
  assert.ok(enHtml.includes("None declared"));
  assert.ok(enHtml.includes("80% Dose Gate: BLOCKED (74% &lt; 80%)"));

  assert.ok(fiHtml.includes("Lukuvarmuus kentittäin"));
  assert.ok(fiHtml.includes("Annostusohje"));
  assert.ok(fiHtml.includes("Ei ilmoitettuja allergeeneja"));
  assert.ok(fiHtml.includes("80 % annosraja: ESTETTY (74 % &lt; 80 %)"));

  assert.ok(svHtml.includes("Avläsningssäkerhet per fält"));
  assert.ok(svHtml.includes("Doseringsanvisning"));
  assert.ok(svHtml.includes("Inga angivna allergener"));
  assert.ok(svHtml.includes("80 % dosgräns: BLOCKERAD (74 % &lt; 80 %)"));

  assert.equal(deFallbackHtml, enHtml);
});

test("ConfidenceBreakdownCard emits zero em dashes, zero en dashes, and zero code comments", async () => {
  const variants: Verdict[] = [
    makeVerdict({
      level: "match",
      read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.85 } })
    }),
    makeVerdict({
      level: "unsure",
      read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.79 } })
    }),
    makeVerdict({
      level: "unsure",
      read: makeLabelRead({ kind: "unreadable", strength: { value: null, confidence: 0 }, readability: 0 })
    }),
    makeVerdict({
      level: "info",
      read: makeLabelRead({
        kind: "food",
        strength: { value: null, confidence: 0 },
        allergens: { value: [], confidence: 0.9 }
      }),
      reasons: []
    })
  ];

  for (const locale of ["en", "fi", "sv", "de"]) {
    for (const expanded of [true, false]) {
      for (const v of variants) {
        const html = renderCard({ verdict: v, lang: locale, defaultExpanded: expanded });
        assert.equal(html.includes(EM_DASH), false, `Em dash found for ${locale}`);
        assert.equal(html.includes(EN_DASH), false, `En dash found for ${locale}`);
      }
    }
  }

  const componentPath = fileURLToPath(
    new URL("../src/components/ConfidenceBreakdownCard.tsx", import.meta.url)
  );
  const testPath = fileURLToPath(new URL(import.meta.url));
  const [componentSrc, testSrc] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(testPath, "utf8")
  ]);

  for (const [name, src] of [
    ["ConfidenceBreakdownCard.tsx", componentSrc],
    ["confidenceBreakdownCard.test.ts", testSrc]
  ] as const) {
    assert.equal(src.includes(EM_DASH), false, `${name} contains an em dash`);
    assert.equal(src.includes(EN_DASH), false, `${name} contains an en dash`);
    assert.doesNotMatch(src, /(?:^|\s)\/\//m, `${name} contains a line comment`);
    assert.equal(src.includes("/" + "*"), false, `${name} contains a block comment`);
  }
});
