import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CrossCheck, Field, Gs1Code, LabelRead, SceneItem, ScenePosition, Verdict, VerdictLevel } from "../../shared/types.ts";
import { POSITION_WORD, VerdictCard, sortedItems, targetIndex } from "../src/components/VerdictCard.tsx";
import { LEVEL_WORD, VerdictGlyph } from "../src/components/Icons.tsx";
import {
  emptyRead,
  matchVerdict,
  mockFoodNuts,
  mockScene,
  mockUnsureStrength,
  mockWarningIbuprofen,
  offlineUnknownCode,
  withCrossCheck,
} from "../src/lib/verdicts.ts";
import { demoProfile } from "../src/lib/storage.ts";

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");

const f = <T,>(value: T | null, confidence = 0.95): Field<T> => ({ value, confidence });

function makeRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    ...emptyRead("medication"),
    product: f("Amlodipine", 0.97),
    ingredient: f("amlodipine", 0.94),
    strength: f("5 mg", 0.96),
    readability: 0.92,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: makeRead(),
    matchedMedId: "amlodipine",
    reasons: ["Name and strength match your list", "Taken today: 0 of 1"],
    takenToday: false,
    ...overrides,
  };
}

function noop(): void {}

function renderCard(verdict: Verdict, via: string | null = "live", withRef = false): string {
  const headingRef = withRef ? createRef<HTMLHeadingElement>() : undefined;
  return renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict,
      via,
      onRepeat: noop,
      onLog: noop,
      onDismiss: noop,
      headingRef,
    }),
  );
}

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function assertAllSvgsDecorative(html: string): void {
  const svgOpenTags = html.match(/<svg\b[^>]*>/g) ?? [];
  assert.ok(svgOpenTags.length >= 1, "expected at least one decorative SVG icon");
  for (const tag of svgOpenTags) {
    assert.match(tag, /\baria-hidden="true"/, `SVG missing aria-hidden="true": ${tag}`);
    assert.match(tag, /\bfocusable="false"/, `SVG missing focusable="false": ${tag}`);
  }
}

test("WCAG landmark, heading focus target, speech output, and decorative SVG hiding", () => {
  const v = makeVerdict();
  const html = renderCard(v, "live", true);
  const text = decodeHtml(html);

  assert.match(html, /^<section class="verdict match" aria-labelledby="verdict-h">/);
  assert.match(html, /<h2 id="verdict-h" class="headline" tabindex="-1">Amlodipine 5 mg<\/h2>/);
  assert.match(html, /<p class="speech">Yes, Amlodipine 5 mg, your evening pill\. You have not taken it today\.<\/p>/);
  assert.ok(text.includes("Name and strength match your list"));
  assert.match(html, /<ul class="reasons" aria-label="Why">/);
  assertAllSvgsDecorative(html);
});

test("match, warning, unsure, and info verdicts render distinct classes, text words, and non-color SVG shapes", () => {
  const levels: VerdictLevel[] = ["match", "warning", "unsure", "info"];
  const expectedWords: Record<VerdictLevel, string> = {
    match: "Match",
    warning: "Warning",
    unsure: "Not sure",
    info: "Info",
  };
  const expectedOuterShapes: Record<VerdictLevel, RegExp> = {
    match: /<circle cx="36" cy="36" r="32" fill="currentColor"><\/circle>/,
    warning: /<path d="M36 5l33 60H3z" fill="currentColor" stroke-linejoin="round"><\/path>/,
    unsure: /<path d="M36 3l33 33-33 33L3 36z" fill="currentColor"><\/path>/,
    info: /<rect x="5" y="5" width="62" height="62" rx="10" fill="currentColor"><\/rect>/,
  };

  const glyphMarkups = new Set<string>();
  const wordsSeen = new Set<string>();

  for (const level of levels) {
    assert.equal(LEVEL_WORD[level], expectedWords[level]);
    const glyphHtml = renderToStaticMarkup(createElement(VerdictGlyph, { level }));
    assert.match(glyphHtml, expectedOuterShapes[level]);
    assert.match(glyphHtml, /\bwidth="72"/);
    assert.match(glyphHtml, /\bheight="72"/);
    assert.match(glyphHtml, /\baria-hidden="true"/);
    assert.match(glyphHtml, /\bfocusable="false"/);
    glyphMarkups.add(glyphHtml);
    wordsSeen.add(LEVEL_WORD[level]);

    const cardHtml = renderCard(
      makeVerdict({
        level,
        headline: `${expectedWords[level]} headline`,
        matchedMedId: level === "match" ? "amlodipine" : undefined,
      }),
    );
    assert.match(cardHtml, new RegExp(`^<section class="verdict ${level}" aria-labelledby="verdict-h">`));
    assert.match(cardHtml, new RegExp(`<p class="kind">${expectedWords[level]}<\\/p>`));
    assert.match(cardHtml, expectedOuterShapes[level]);
    assertAllSvgsDecorative(cardHtml);
  }

  assert.equal(glyphMarkups.size, 4, "all four verdict levels must have distinct outer geometric glyphs");
  assert.equal(wordsSeen.size, 4, "all four verdict levels must have distinct text labels");

  assert.match(STYLES_CSS, /\.verdict\.warning\s*\{[^}]*border-style:\s*double/s);
  assert.match(STYLES_CSS, /\.verdict\.unsure\s*\{[^}]*border-style:\s*dashed/s);
});

test("EU FMD DataMatrix crossCheck badge renders agrees=true confirmation with role=note and shield icon", () => {
  const code: Gs1Code = {
    raw: "01064165420021491727080010BATCH7",
    gtin: "06416542002149",
    expiry: "2027-08",
    batch: "BATCH7",
  };
  const crossCheck: CrossCheck = {
    source: "datamatrix",
    code,
    agrees: true,
    details: ["GTIN 06416542002149 = your Amlodipine", "expiry: code 2027-08 = print 2027-08"],
  };
  const html = renderCard(makeVerdict({ crossCheck }));
  const text = decodeHtml(html);

  assert.match(html, /<div class="xcheck ok" role="note">/);
  assert.match(html, /<strong>Double-checked: printed label = pack code<\/strong>/);
  assert.ok(text.includes("GTIN 06416542002149 = your Amlodipine \u00b7 expiry: code 2027-08 = print 2027-08"));
  assert.match(html, /<path d="M8\.5 12l2\.5 2\.5 4\.5-5"><\/path>/);
  assertAllSvgsDecorative(html);

  const emptyDetailsHtml = renderCard(makeVerdict({ crossCheck: { ...crossCheck, details: [] } }));
  assert.match(emptyDetailsHtml, /<div class="xcheck ok" role="note">.*<strong>Double-checked: printed label = pack code<\/strong><\/div><\/div>/);
});

test("EU FMD DataMatrix crossCheck badge renders agrees=false conflict warning and pharmacist guidance", () => {
  const code: Gs1Code = {
    raw: "010641654200337517250400",
    gtin: "06416542003375",
    expiry: "2025-04",
  };
  const conflictWithDetails: CrossCheck = {
    source: "datamatrix",
    code,
    agrees: false,
    details: ["pack code GTIN 06416542003375 is not Amlodipine", "expiry: code 2025-04 != print 2027-08"],
  };
  const html = renderCard(makeVerdict({ level: "warning", crossCheck: conflictWithDetails }));
  const text = decodeHtml(html);

  assert.match(html, /<div class="xcheck bad" role="note">/);
  assert.match(html, /<strong>The printed label and the pack code disagree<\/strong>/);
  assert.ok(text.includes("pack code GTIN 06416542003375 is not Amlodipine \u00b7 expiry: code 2025-04 != print 2027-08 Don't rely on this answer; ask a pharmacist."));
  assert.match(html, /<path d="M12 3l10 18H2z"><\/path>/);
  assertAllSvgsDecorative(html);
  assert.match(STYLES_CSS, /\.xcheck\.bad\s*\{[^}]*border:\s*4px double var\(--danger\)/s);

  const fallbackConflictHtml = renderCard(
    makeVerdict({
      level: "warning",
      crossCheck: { source: "datamatrix", code, agrees: false, details: [] },
    }),
  );
  const fallbackText = decodeHtml(fallbackConflictHtml);
  assert.ok(fallbackText.includes("What I read on the box doesn't match the code printed on it. Don't rely on this answer; ask a pharmacist."));
});

test("EU FMD DataMatrix crossCheck badge renders agrees=null pack-code-only note and omits badge when undefined", () => {
  const code: Gs1Code = {
    raw: "010641654200214917270800",
    gtin: "06416542002149",
    expiry: "2027-08",
  };
  const packOnly: CrossCheck = {
    source: "datamatrix",
    code,
    agrees: null,
    details: ["GTIN 06416542002149 matches your Amlodipine", "expiry from the pack code: August 2027"],
  };
  const html = renderCard(makeVerdict({ crossCheck: packOnly }), "offline");
  const text = decodeHtml(html);

  assert.match(html, /<div class="xcheck info" role="note">/);
  assert.match(html, /<strong>Read from the pack code<\/strong>/);
  assert.ok(text.includes("GTIN 06416542002149 matches your Amlodipine \u00b7 expiry from the pack code: August 2027"));
  assert.match(html, /offline pack code/);
  assertAllSvgsDecorative(html);

  const noBadgeHtml = renderCard(makeVerdict({ crossCheck: undefined }), "offline");
  assert.doesNotMatch(noBadgeHtml, /class="xcheck\b/);
  assert.match(noBadgeHtml, /offline barcode/);
});

test("via channel indicator distinguishes live, snapshot, offline barcode, and offline pack code", () => {
  const base = makeVerdict();
  const liveHtml = renderCard(base, "live");
  const nullViaHtml = renderCard(base, null);
  const snapshotHtml = renderCard(base, "snapshot");

  assert.doesNotMatch(liveHtml, /snapshot|offline barcode|offline pack code/);
  assert.doesNotMatch(nullViaHtml, /snapshot|offline barcode|offline pack code/);
  assert.match(snapshotHtml, /<span class="muted"> \u00b7 snapshot<\/span>/);
});

test("per-field confidence disclosure renders all readable and nonzero-confidence fields with accessible percent labels", () => {
  const fullRead: LabelRead = {
    kind: "food",
    product: f("Chocolate oat bar", 0.93),
    ingredient: f("rolled oats", 0.7),
    strength: f<string>(null, 0.31),
    dosing: f("1 bar", 0.69),
    expiry: f("2027-03-12", 0.88),
    allergens: f(["hazelnut", "oats", "milk"], 0.92),
    barcode: f<string>(null, 0),
    readability: 0.85,
  };
  const html = renderCard(makeVerdict({ level: "warning", read: fullRead, matchedMedId: undefined }));

  assert.match(html, /<details><summary class="muted" style="[^"]*min-height:48px[^"]*">What I read, and how sure I am<\/summary><dl class="fields">/);
  assert.match(html, /<dt>Product<\/dt><dd>Chocolate oat bar<\/dd><span class="conf " aria-label="confidence 93 percent">93%<\/span>/);
  assert.match(html, /<dt>Ingredient<\/dt><dd>rolled oats<\/dd><span class="conf " aria-label="confidence 70 percent">70%<\/span>/);
  assert.match(html, /<dt>Strength<\/dt><dd>Not readable<\/dd><span class="conf low" aria-label="confidence 31 percent">31%<\/span>/);
  assert.match(html, /<dt>Dosing<\/dt><dd>1 bar<\/dd><span class="conf low" aria-label="confidence 69 percent">69%<\/span>/);
  assert.match(html, /<dt>Expiry<\/dt><dd>2027-03-12<\/dd><span class="conf " aria-label="confidence 88 percent">88%<\/span>/);
  assert.match(html, /<dt>Allergens<\/dt><dd>hazelnut, oats, milk<\/dd><span class="conf " aria-label="confidence 92 percent">92%<\/span>/);
  assert.doesNotMatch(html, /<dt>Barcode<\/dt>/);

  const dts = Array.from(html.matchAll(/<dt>([^<]+)<\/dt>/g), (m) => m[1]);
  assert.deepEqual(dts, ["Product", "Ingredient", "Strength", "Dosing", "Expiry", "Allergens"]);
});

test("per-field confidence disclosure is omitted entirely when all fields have null value and zero confidence", () => {
  const blank = makeVerdict({
    level: "unsure",
    read: emptyRead("unreadable"),
    reasons: [],
    matchedMedId: undefined,
  });
  const html = renderCard(blank);

  assert.doesNotMatch(html, /<details>/);
  assert.doesNotMatch(html, /<dl class="fields">/);
  assert.doesNotMatch(html, /<ul class="reasons"/);
});

test("dose logging button, takenToday status, and on-device privacy sr-only help follow matchedMedId contract", () => {
  const notTakenHtml = renderCard(makeVerdict({ matchedMedId: "amlodipine", takenToday: false }));
  assert.match(notTakenHtml, /<p class="muted">Not logged today\.<\/p>/);
  assert.match(notTakenHtml, /<button class="btn small primary" aria-describedby="log-help">I took it<\/button>/);
  assert.match(notTakenHtml, /<p id="log-help" class="sr-only">Saves the time in the dose log on this phone only\.<\/p>/);
  assert.match(notTakenHtml, /<button class="btn small">Repeat<\/button>/);
  assert.match(notTakenHtml, /<button class="btn small ghost">Dismiss<\/button>/);

  const alreadyTakenHtml = renderCard(makeVerdict({ level: "warning", matchedMedId: "amlodipine", takenToday: true }));
  assert.match(alreadyTakenHtml, /<p class="muted">Already logged today\.<\/p>/);
  assert.match(alreadyTakenHtml, /<button class="btn small primary" aria-describedby="log-help">Log another dose<\/button>/);
  assert.match(alreadyTakenHtml, /id="log-help"/);

  const unknownTakenHtml = renderCard(makeVerdict({ matchedMedId: "amlodipine", takenToday: undefined }));
  assert.doesNotMatch(unknownTakenHtml, /Already logged today|Not logged today/);
  assert.match(unknownTakenHtml, /<button class="btn small primary" aria-describedby="log-help">I took it<\/button>/);

  const unmatchedHtml = renderCard(makeVerdict({ level: "warning", matchedMedId: undefined, takenToday: false }));
  assert.doesNotMatch(unmatchedHtml, /aria-describedby="log-help"/);
  assert.doesNotMatch(unmatchedHtml, /id="log-help"/);
  assert.doesNotMatch(unmatchedHtml, /I took it|Log another dose/);
  assert.doesNotMatch(unmatchedHtml, /Already logged today|Not logged today/);
  assert.match(unmatchedHtml, /<button class="btn small">Repeat<\/button>/);
  assert.match(unmatchedHtml, /<button class="btn small ghost">Dismiss<\/button>/);
});

test("scene helper functions sort five positions left-to-right without mutating input and resolve target index", () => {
  const makeItem = (position: ScenePosition, level: VerdictLevel, headline: string, matchedMedId?: string): SceneItem => ({
    position,
    level,
    headline,
    matchedMedId,
    read: makeRead(),
  });

  assert.deepEqual(POSITION_WORD, {
    far_left: "Far left",
    left: "Left",
    center: "Middle",
    right: "Right",
    far_right: "Far right",
  });

  const unsorted: SceneItem[] = [
    makeItem("far_right", "info", "Vitamin D"),
    makeItem("center", "warning", "Ibuprofen 400 mg"),
    makeItem("far_left", "unsure", "Blurry strip"),
    makeItem("right", "match", "Amlodipine 5 mg", "amlodipine"),
    makeItem("left", "match", "Metformin 500 mg", "metformin"),
  ];
  const snapshot = unsorted.map((i) => i.position);
  const ordered = sortedItems(unsorted);

  assert.deepEqual(unsorted.map((i) => i.position), snapshot, "sortedItems must not mutate input array");
  assert.deepEqual(ordered.map((i) => i.position), ["far_left", "left", "center", "right", "far_right"]);

  assert.equal(targetIndex(ordered, "amlodipine"), 3, "explicit targetId wins even when an earlier item has level=match");
  assert.equal(targetIndex(ordered, "missing-id"), 1, "falls back to first level=match when targetId does not match");
  assert.equal(targetIndex(ordered), 1, "falls back to first level=match when targetId is omitted");
  assert.equal(
    targetIndex([makeItem("left", "unsure", "Unknown"), makeItem("right", "warning", "Avoid")], "amlodipine"),
    -1,
    "returns -1 when no item matches targetId or level=match",
  );
});

test("scene verdict renders ordered package list, target aria-current, sr-only target announcement, and non-color words", () => {
  const profile = demoProfile();
  const scene = mockScene(profile);
  const reversedScene: Verdict = {
    ...scene,
    items: [...(scene.items ?? [])].reverse(),
  };

  const html = renderCard(reversedScene);

  assert.match(html, /<span class="muted"> \u00b7 which one<\/span>/);
  assert.match(html, /<ol class="scene" aria-label="3 packages, left to right" style="grid-template-columns:1fr 1fr 1\.5fr">/);

  const positionsRendered = Array.from(html.matchAll(/<span class="scene-pos">([^<]+)<\/span>/g), (m) => m[1]);
  assert.deepEqual(positionsRendered, ["Left", "Middle", "Right"]);

  const wordsRendered = Array.from(html.matchAll(/<span class="scene-word">([^<]+)<\/span>/g), (m) => m[1]);
  assert.deepEqual(wordsRendered, ["Not sure", "Warning", "Match"]);

  const itemsHtml = Array.from(html.matchAll(/<li class="scene-item\b[^>]*>[\s\S]*?<\/li>/g), (m) => m[0]);
  assert.equal(itemsHtml.length, 3);

  assert.doesNotMatch(itemsHtml[0], /\baria-current=/);
  assert.doesNotMatch(itemsHtml[0], /\btarget\b/);
  assert.doesNotMatch(itemsHtml[0], /This is the one you asked about\./);
  assert.match(itemsHtml[0], /\bwidth="32" height="32"/);

  assert.doesNotMatch(itemsHtml[1], /\baria-current=/);
  assert.doesNotMatch(itemsHtml[1], /\btarget\b/);
  assert.match(itemsHtml[1], /\bwidth="32" height="32"/);

  assert.match(itemsHtml[2], /^<li class="scene-item match target" aria-current="true">/);
  assert.match(itemsHtml[2], /\bwidth="48" height="48"/);
  assert.match(itemsHtml[2], /<span class="sr-only">This is the one you asked about\.<\/span>/);

  assertAllSvgsDecorative(html);
});

test("scene verdict handles info item color variable, no-target scenes, and non-scene mode guards", () => {
  const noTargetScene = makeVerdict({
    mode: "scene",
    level: "unsure",
    matchedMedId: undefined,
    items: [
      { position: "right", level: "info", headline: "Oat milk", read: emptyRead("food") },
      { position: "left", level: "warning", headline: "Ibuprofen", read: makeRead() },
    ],
  });
  const noTargetHtml = renderCard(noTargetScene);
  assert.match(noTargetHtml, /<ol class="scene" aria-label="2 packages, left to right" style="grid-template-columns:1fr 1fr">/);
  assert.doesNotMatch(noTargetHtml, /aria-current="true"/);
  assert.doesNotMatch(noTargetHtml, /This is the one you asked about\./);
  assert.match(noTargetHtml, /<span class="scene-glyph" style="color:var\(--muted\)">/);

  const itemModeWithItems = makeVerdict({
    mode: "item",
    items: noTargetScene.items,
  });
  const itemModeHtml = renderCard(itemModeWithItems);
  assert.doesNotMatch(itemModeHtml, /<ol class="scene"/);
  assert.doesNotMatch(itemModeHtml, /which one/);

  const emptySceneHtml = renderCard(makeVerdict({ mode: "scene", items: [] }));
  assert.match(emptySceneHtml, /which one/);
  assert.doesNotMatch(emptySceneHtml, /<ol class="scene"/);
});

test("verdict builders from web/src/lib/verdicts.ts render valid accessible VerdictCard markup across all flows", () => {
  const profile = demoProfile();
  const amlo = profile.meds[0];
  const gs1: Gs1Code = {
    raw: "01064165420021491727080010LOT1",
    gtin: "06416542002149",
    expiry: "2027-08",
    batch: "LOT1",
  };

  const cases: { name: string; verdict: Verdict; via: string | null }[] = [
    { name: "match label", verdict: matchVerdict(profile, amlo), via: "live" },
    {
      name: "match with DataMatrix crossCheck",
      verdict: withCrossCheck(matchVerdict(profile, amlo), true, ["GTIN matches your Amlodipine"], gs1),
      via: "live",
    },
    { name: "warning ibuprofen", verdict: mockWarningIbuprofen(), via: "live" },
    { name: "unsure strength", verdict: mockUnsureStrength(), via: "snapshot" },
    { name: "warning food nuts", verdict: mockFoodNuts(), via: "live" },
    { name: "offline unknown pack code", verdict: offlineUnknownCode(gs1), via: "offline" },
  ];

  for (const c of cases) {
    const html = renderCard(c.verdict, c.via);
    assert.match(html, /^<section class="verdict (match|warning|unsure|info)" aria-labelledby="verdict-h">/, c.name);
    assert.match(html, /<h2 id="verdict-h" class="headline" tabindex="-1">/, c.name);
    assertAllSvgsDecorative(html);
  }
});

test("five-package scene renders all five spatial positions and selects level=match target when matchedMedId is absent", () => {
  const fiveScene = makeVerdict({
    mode: "scene",
    level: "match",
    matchedMedId: undefined,
    items: [
      { position: "far_right", level: "info", headline: "Melatonin", read: emptyRead("other") },
      { position: "left", level: "warning", headline: "Naproxen", read: makeRead() },
      { position: "center", level: "match", headline: "Evening pill", read: makeRead() },
      { position: "far_left", level: "unsure", headline: "Faded box", read: emptyRead("unreadable") },
      { position: "right", level: "unsure", headline: "Back panel", read: emptyRead("unreadable") },
    ],
  });
  const html = renderCard(fiveScene);

  assert.match(html, /<ol class="scene" aria-label="5 packages, left to right" style="grid-template-columns:1fr 1fr 1\.5fr 1fr 1fr">/);
  const positions = Array.from(html.matchAll(/<span class="scene-pos">([^<]+)<\/span>/g), (m) => m[1]);
  assert.deepEqual(positions, ["Far left", "Left", "Middle", "Right", "Far right"]);

  const itemsHtml = Array.from(html.matchAll(/<li class="scene-item\b[^>]*>[\s\S]*?<\/li>/g), (m) => m[0]);
  assert.equal(itemsHtml.length, 5);
  assert.match(itemsHtml[2], /^<li class="scene-item match target" aria-current="true">/);
  assert.match(itemsHtml[2], /<span class="sr-only">This is the one you asked about\.<\/span>/);
  for (const idx of [0, 1, 3, 4]) {
    assert.doesNotMatch(itemsHtml[idx], /aria-current=/);
    assert.doesNotMatch(itemsHtml[idx], /This is the one you asked about\./);
  }
});

test("WCAG ARIA ID references resolve uniquely, buttons have accessible names, and agrees=null handles empty details", () => {
  const code: Gs1Code = { raw: "0106416542002149" };
  const html = renderCard(
    makeVerdict({
      matchedMedId: "amlodipine",
      takenToday: false,
      crossCheck: { source: "datamatrix", code, agrees: null, details: [] },
    }),
  );

  assert.match(html, /<div class="xcheck info" role="note">.*<strong>Read from the pack code<\/strong><\/div><\/div>/);

  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, "all element IDs inside VerdictCard must be unique");
  const idSet = new Set(ids);

  for (const refAttr of ["aria-labelledby", "aria-describedby"]) {
    const refs = Array.from(html.matchAll(new RegExp(`\\b${refAttr}="([^"]+)"`, "g")), (m) => m[1]);
    for (const refList of refs) {
      for (const id of refList.trim().split(/\s+/)) {
        assert.ok(idSet.has(id), `${refAttr} references missing id="${id}"`);
      }
    }
  }

  const buttons = Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), (m) => m[1].replaceAll(/<[^>]+>/g, "").trim());
  assert.deepEqual(buttons, ["Repeat", "I took it", "Dismiss"]);
  for (const label of buttons) {
    assert.ok(label.length > 0, "every button must expose a non-empty accessible text label");
  }
});

test("untrusted OCR and barcode strings are HTML-escaped across headline, speech, fields, reasons, crossCheck, and scene items", () => {
  const payload = "<script>alert(1)</script>";
  const html = renderCard(
    makeVerdict({
      mode: "scene",
      headline: `Check ${payload}`,
      speech: `Read ${payload}`,
      reasons: [`Reason ${payload}`],
      read: makeRead({ product: f(`Prod ${payload}`, 0.91) }),
      crossCheck: {
        source: "datamatrix",
        code: { raw: payload },
        agrees: false,
        details: [`Detail ${payload}`],
      },
      items: [{ position: "center", level: "warning", headline: `Item ${payload}`, read: makeRead() }],
    }),
  );

  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
