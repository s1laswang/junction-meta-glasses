import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LanguageVoiceSupportCard,
  buildLanguageCapabilityRows,
  type LanguageCapabilityRow,
  type LanguageVoiceSupportCardProps
} from "../src/components/LanguageVoiceSupportCard.tsx";
import { SUPPORTED_LANGUAGES } from "../src/i18n/translations.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
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
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const noopSelectLang = (_code: string): void => {};
const noopSpeakSample = (_text: string, _code: string): void => {};

function renderCard(props: LanguageVoiceSupportCardProps): string {
  return renderToStaticMarkup(createElement(LanguageVoiceSupportCard, props));
}

function extractOpeningTagsByClass(html: string, classToken: string): string[] {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function parseMinDimPx(tag: string, prop: "min-height" | "min-width"): number {
  const pattern = new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i");
  const match = pattern.exec(tag);
  assert.ok(match, `Expected inline ${prop} in tag: ${tag}`);
  return Number.parseFloat(match[1]);
}

test("buildLanguageCapabilityRows returns all 8 SUPPORTED_LANGUAGES with accurate capability flags and active selection", () => {
  const expectedCodes = ["en", "fi", "sv", "de", "es", "fr", "et", "ru"];
  const rows: LanguageCapabilityRow[] = buildLanguageCapabilityRows("fi-FI");

  assert.equal(rows.length, 8);
  assert.equal(SUPPORTED_LANGUAGES.length, 8);
  assert.deepEqual(
    rows.map((r) => r.code),
    expectedCodes
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    SUPPORTED_LANGUAGES.map((entry) => entry.label)
  );
  assert.deepEqual(
    rows.map((r) => r.nativeLabel),
    SUPPORTED_LANGUAGES.map((entry) => entry.nativeLabel)
  );

  const greetings = new Set<string>();
  for (const row of rows) {
    assert.equal(row.liveVoiceSupported, true, `Expected liveVoiceSupported=true for ${row.code}`);
    assert.equal(
      row.fullUiAndNordicSafety,
      row.code === "en" || row.code === "fi" || row.code === "sv",
      `Unexpected fullUiAndNordicSafety for ${row.code}`
    );
    assert.equal(row.active, row.code === "fi", `Unexpected active state for ${row.code}`);
    assert.ok(row.sampleGreeting.trim().length >= 20, `Sample greeting too short for ${row.code}`);
    assert.ok(row.bcp47Tag.includes("-"), `Expected regional BCP-47 tag for ${row.code}`);
    assert.equal(row.sampleGreeting.includes(EM_DASH), false);
    assert.equal(row.sampleGreeting.includes(EN_DASH), false);
    greetings.add(row.sampleGreeting);
  }
  assert.equal(greetings.size, 8, "Each language must expose a distinct sample greeting");

  for (const code of expectedCodes) {
    const byCode = buildLanguageCapabilityRows(code);
    const activeCodes = byCode.filter((r) => r.active).map((r) => r.code);
    assert.deepEqual(activeCodes, [code], `Expected only ${code} to be active`);
  }

  assert.deepEqual(
    buildLanguageCapabilityRows("SV_SE").filter((r) => r.active).map((r) => r.code),
    ["sv"]
  );
  assert.deepEqual(
    buildLanguageCapabilityRows("de-DE").filter((r) => r.active).map((r) => r.code),
    ["de"]
  );
  assert.deepEqual(
    buildLanguageCapabilityRows("unknown").filter((r) => r.active).map((r) => r.code),
    ["en"]
  );
  assert.deepEqual(
    buildLanguageCapabilityRows("").filter((r) => r.active).map((r) => r.code),
    ["en"]
  );

  rows[0].sampleGreeting = "mutated";
  assert.notEqual(buildLanguageCapabilityRows("en")[0].sampleGreeting, "mutated");
});

test("LanguageVoiceSupportCard SSR renders accessible section, active badge, capability badges, and >= 56px buttons for all 8 languages", () => {
  const html = renderCard({
    activeLang: "sv",
    muted: false,
    onSelectLang: noopSelectLang,
    onSpeakSample: noopSpeakSample
  });

  assert.equal(html.includes("undefined"), false);
  assert.equal(html.includes("NaN"), false);
  assert.equal(html.includes("[object"), false);
  assert.equal(html.includes(HTML_COMMENT_OPEN), false);

  const sections = extractOpeningTagsByClass(html, "language-voice-support-card");
  assert.equal(sections.length, 1);
  assert.ok(sections[0].startsWith("<section"));
  assert.ok(sections[0].includes('aria-labelledby="language-voice-support-heading"'));
  assert.ok(sections[0].includes('lang="sv"'));
  assert.ok(sections[0].includes('data-active-lang="sv"'));
  assert.ok(sections[0].includes('data-muted="false"'));
  assert.ok(html.includes('id="language-voice-support-heading"'));

  const activeBadges = extractOpeningTagsByClass(html, "language-active-badge");
  assert.equal(activeBadges.length, 1);
  assert.ok(activeBadges[0].includes('role="status"'));
  assert.ok(activeBadges[0].includes('data-active-code="sv"'));
  assert.ok(html.includes("Aktivt: Svenska (SV)"));

  const rowTags = extractOpeningTagsByClass(html, "language-capability-row");
  assert.equal(rowTags.length, 8);

  const activeRowTags = extractOpeningTagsByClass(html, "language-capability-row-active");
  assert.equal(activeRowTags.length, 1);
  assert.ok(activeRowTags[0].includes('data-lang-code="sv"'));

  const voiceBadges = extractOpeningTagsByClass(html, "language-row-voice-badge");
  const tierBadges = extractOpeningTagsByClass(html, "language-row-tier-badge");
  assert.equal(voiceBadges.length, 8);
  assert.equal(tierBadges.length, 8);

  const selectButtons = extractOpeningTagsByClass(html, "language-select-btn");
  const sampleButtons = extractOpeningTagsByClass(html, "language-sample-btn");
  assert.equal(selectButtons.length, 8);
  assert.equal(sampleButtons.length, 8);

  let pressedTrueCount = 0;
  for (const btn of selectButtons) {
    assert.ok(btn.startsWith("<button"));
    assert.ok(btn.includes('type="button"'));
    assert.ok(parseMinDimPx(btn, "min-height") >= 56);
    assert.ok(parseMinDimPx(btn, "min-width") >= 56);
    assert.ok(/aria-label="[^"]+"/.test(btn));
    if (btn.includes('aria-pressed="true"')) {
      pressedTrueCount += 1;
      assert.ok(btn.includes('data-lang-code="sv"'));
    } else {
      assert.ok(btn.includes('aria-pressed="false"'));
    }
  }
  assert.equal(pressedTrueCount, 1);

  for (const btn of sampleButtons) {
    assert.ok(btn.startsWith("<button"));
    assert.ok(btn.includes('type="button"'));
    assert.ok(parseMinDimPx(btn, "min-height") >= 56);
    assert.ok(parseMinDimPx(btn, "min-width") >= 56);
    assert.ok(/aria-label="[^"]+"/.test(btn));
    assert.equal(btn.includes("disabled"), false);
  }

  const svgPattern = /<svg\b[^>]*>/gi;
  let svgMatch: RegExpExecArray | null = svgPattern.exec(html);
  let svgCount = 0;
  while (svgMatch !== null) {
    svgCount += 1;
    assert.ok(svgMatch[0].includes('aria-hidden="true"'));
    svgMatch = svgPattern.exec(html);
  }
  assert.ok(svgCount >= 12);
});

test("LanguageVoiceSupportCard localizes UI copy across en, fi, and sv with en fallback", () => {
  const enHtml = renderCard({ activeLang: "en" });
  const fiHtml = renderCard({ activeLang: "fi" });
  const svHtml = renderCard({ activeLang: "sv" });
  const fiRegionalHtml = renderCard({ activeLang: "fi-FI" });
  const svRegionalHtml = renderCard({ activeLang: "sv-SE" });
  const deVoiceOnlyHtml = renderCard({ activeLang: "de" });
  const unknownFallbackHtml = renderCard({ activeLang: "nl" });

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(unknownFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("Language, Voice &amp; Nordic Safety Matrix"));
  assert.ok(enHtml.includes("Active: English (EN)"));
  assert.ok(enHtml.includes("FULL UI + NORDIC RX &amp; EU-14"));
  assert.ok(enHtml.includes("VOICE SESSION + EN UI"));
  assert.ok(enHtml.includes("Burana -&gt; ibuprofen"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Kieli-, puhe- ja pohjoismainen turvamatriisi"));
  assert.ok(fiHtml.includes("Aktiivinen: Suomi (FI)"));
  assert.ok(fiHtml.includes("TÄYSI UI + POHJOISMAINEN TURVA"));
  assert.ok(fiHtml.includes("Ääninäyte"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Språk-, röst- och nordisk säkerhetsmatris"));
  assert.ok(svHtml.includes("Aktivt: Svenska (SV)"));
  assert.ok(svHtml.includes("FULL UI + NORDISK SÄKERHET"));
  assert.ok(svHtml.includes("Röstprov"));

  assert.ok(deVoiceOnlyHtml.includes('lang="en"'));
  assert.ok(deVoiceOnlyHtml.includes('data-active-lang="de"'));
  assert.ok(deVoiceOnlyHtml.includes("Language, Voice &amp; Nordic Safety Matrix"));
  assert.ok(deVoiceOnlyHtml.includes("Active: Deutsch (DE)"));
});

test("LanguageVoiceSupportCard invokes onSelectLang and onSpeakSample callbacks and respects muted state", () => {
  type ButtonElementProps = {
    "data-action"?: string;
    "data-lang-code"?: string;
    disabled?: boolean;
    "aria-disabled"?: string;
    onClick?: () => void;
    children?: unknown;
  };

  function collectButtons(node: unknown, acc: ButtonElementProps[] = []): ButtonElementProps[] {
    if (Array.isArray(node)) {
      for (const item of node) {
        collectButtons(item, acc);
      }
      return acc;
    }
    if (!isValidElement(node)) {
      return acc;
    }
    const props = node.props as ButtonElementProps;
    if (node.type === "button") {
      acc.push(props);
    }
    if (props && props.children !== undefined) {
      collectButtons(props.children, acc);
    }
    return acc;
  }

  const selectedCodes: string[] = [];
  const spokenSamples: Array<{ text: string; code: string }> = [];

  const interactiveTree = LanguageVoiceSupportCard({
    activeLang: "fi",
    muted: false,
    onSelectLang: (code) => selectedCodes.push(code),
    onSpeakSample: (text, code) => spokenSamples.push({ text, code })
  });

  const buttons = collectButtons(interactiveTree);
  assert.equal(buttons.length, 16);

  const selectBtns = buttons.filter((b) => b["data-action"] === "select-lang");
  const sampleBtns = buttons.filter((b) => b["data-action"] === "speak-sample");
  assert.equal(selectBtns.length, 8);
  assert.equal(sampleBtns.length, 8);

  for (const btn of selectBtns) {
    btn.onClick?.();
  }
  for (const btn of sampleBtns) {
    btn.onClick?.();
  }

  const expectedRows = buildLanguageCapabilityRows("fi");
  assert.deepEqual(
    selectedCodes,
    expectedRows.map((r) => r.code)
  );
  assert.deepEqual(
    spokenSamples,
    expectedRows.map((r) => ({ text: r.sampleGreeting, code: r.code }))
  );

  const mutedSelectedCodes: string[] = [];
  const mutedSpokenSamples: Array<{ text: string; code: string }> = [];

  const mutedHtml = renderCard({
    activeLang: "en",
    muted: true,
    onSelectLang: noopSelectLang,
    onSpeakSample: noopSpeakSample
  });
  assert.ok(mutedHtml.includes('data-muted="true"'));
  assert.equal(extractOpeningTagsByClass(mutedHtml, "language-muted-pill").length, 1);

  const mutedSampleBtnTags = extractOpeningTagsByClass(mutedHtml, "language-sample-btn");
  assert.equal(mutedSampleBtnTags.length, 8);
  for (const tag of mutedSampleBtnTags) {
    assert.ok(tag.includes("disabled"));
    assert.ok(tag.includes('aria-disabled="true"'));
  }

  const mutedTree = LanguageVoiceSupportCard({
    activeLang: "en",
    muted: true,
    onSelectLang: (code) => mutedSelectedCodes.push(code),
    onSpeakSample: (text, code) => mutedSpokenSamples.push({ text, code })
  });

  for (const btn of collectButtons(mutedTree)) {
    btn.onClick?.();
  }
  assert.equal(mutedSelectedCodes.length, 8);
  assert.equal(mutedSpokenSamples.length, 0);
});

test("LanguageVoiceSupportCard and test file contain zero comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/LanguageVoiceSupportCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./languageVoiceSupportCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [name, source] of [
    ["LanguageVoiceSupportCard.tsx", componentSource],
    ["languageVoiceSupportCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${name} must not contain line comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${name} must not contain block comment openings`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${name} must not contain block comment closures`
    );
    assert.equal(source.includes(EM_DASH), false, `${name} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${name} must not contain en dashes`);
  }

  for (const entry of SUPPORTED_LANGUAGES) {
    for (const muted of [false, true]) {
      const html = renderCard({
        activeLang: entry.code,
        muted,
        onSelectLang: noopSelectLang,
        onSpeakSample: noopSpeakSample
      });
      assert.equal(html.includes(EM_DASH), false, `Em dash in rendered HTML for ${entry.code}`);
      assert.equal(html.includes(EN_DASH), false, `En dash in rendered HTML for ${entry.code}`);
    }
  }
});
