import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  VoiceCommandCheatSheetCard,
  getLocalizedVoicePhrases,
  type HudGestureEvent,
  type SampleVoicePhrase,
  type VoiceCommandCheatSheetCardProps
} from "../src/components/VoiceCommandCheatSheetCard.tsx";
import { parseLocalIntent } from "../src/session/localVoiceIntent.ts";

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

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

const noopRunPhrase = (_phrase: string): void => {};
const noopTriggerGesture = (_event: HudGestureEvent): void => {};

function renderCard(props: VoiceCommandCheatSheetCardProps): string {
  return renderToStaticMarkup(createElement(VoiceCommandCheatSheetCard, props));
}

function decodeBasicEntities(html: string): string {
  return html
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
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

test("getLocalizedVoicePhrases returns 6 localized natural utterances in en, fi, and sv aligned with parseLocalIntent", () => {
  const expectedIds = [
    "evening_pill",
    "allergen_check",
    "log_dose",
    "repeat_verdict",
    "scan_barcode",
    "stop_check"
  ];
  const expectedKinds = [
    "question",
    "question",
    "log_dose",
    "repeat",
    "scan_barcode",
    "stop"
  ];

  const enPhrases: SampleVoicePhrase[] = getLocalizedVoicePhrases("en");
  const fiPhrases: SampleVoicePhrase[] = getLocalizedVoicePhrases("fi");
  const svPhrases: SampleVoicePhrase[] = getLocalizedVoicePhrases("sv");

  for (const [locale, list] of [
    ["en", enPhrases],
    ["fi", fiPhrases],
    ["sv", svPhrases]
  ] as const) {
    assert.equal(list.length, 6, `Expected 6 phrases for ${locale}`);
    assert.deepEqual(
      list.map((item) => item.id),
      expectedIds,
      `Unexpected phrase ids for ${locale}`
    );
    assert.deepEqual(
      list.map((item) => item.intentKind),
      expectedKinds,
      `Unexpected intentKinds for ${locale}`
    );

    for (const item of list) {
      assert.ok(item.phrase.trim().length > 0, `Empty phrase for ${locale}:${item.id}`);
      assert.ok(item.description.trim().length > 0, `Empty description for ${locale}:${item.id}`);
      const parsed = parseLocalIntent(item.phrase);
      assert.equal(
        parsed.kind,
        item.intentKind,
        `parseLocalIntent mismatch for ${locale} phrase "${item.phrase}"`
      );
    }
  }

  assert.equal(enPhrases[2].phrase, "I took it");
  assert.equal(fiPhrases[2].phrase, "Otin sen");
  assert.equal(svPhrases[2].phrase, "Jag tog den");

  assert.equal(enPhrases[0].phrase, "Is this my evening pill?");
  assert.equal(fiPhrases[0].phrase, "Onko tämä iltalääkkeeni?");
  assert.equal(svPhrases[0].phrase, "Är det här min kvällsmedicin?");

  assert.deepEqual(getLocalizedVoicePhrases("fi-FI"), fiPhrases);
  assert.deepEqual(getLocalizedVoicePhrases("sv-SE"), svPhrases);
  assert.deepEqual(getLocalizedVoicePhrases("de-DE"), enPhrases);
  assert.deepEqual(getLocalizedVoicePhrases(""), enPhrases);

  enPhrases[0].phrase = "mutated";
  assert.equal(getLocalizedVoicePhrases("en")[0].phrase, "Is this my evening pill?");
});

test("VoiceCommandCheatSheetCard SSR renders accessible section, 56px voice phrase buttons, and Neural Band gesture reference", () => {
  const html = renderCard({
    lang: "en",
    onRunPhrase: noopRunPhrase,
    onTriggerHudGesture: noopTriggerGesture
  });
  const decoded = decodeBasicEntities(html);

  const sectionTags = extractOpeningTagsByClass(html, "voice-command-cheatsheet-card");
  assert.equal(sectionTags.length, 1);
  assert.ok(sectionTags[0].startsWith("<section"));
  assert.ok(sectionTags[0].includes('lang="en"'));
  assert.ok(sectionTags[0].includes('aria-labelledby="voice-command-cheatsheet-heading"'));

  const phraseButtons = extractOpeningTagsByClass(html, "voice-phrase-btn");
  assert.equal(phraseButtons.length, 6);
  for (const btnTag of phraseButtons) {
    assert.ok(btnTag.startsWith("<button"));
    assert.ok(btnTag.includes('type="button"'));
    assert.match(btnTag, /min-height:\s*56px/i);
    assert.match(btnTag, /min-width:\s*56px/i);
    assert.ok(btnTag.includes('aria-label="Simulate voice phrase:'));
  }

  const gestureButtons = extractOpeningTagsByClass(html, "neural-band-sim-btn");
  assert.equal(gestureButtons.length, 3);
  const renderedGestureEvents = gestureButtons.map((tag) => {
    const match = /data-hud-gesture="([^"]+)"/.exec(tag);
    return match ? match[1] : "";
  });
  assert.deepEqual(renderedGestureEvents, ["repeat", "log_dose", "dismiss"]);
  for (const btnTag of gestureButtons) {
    assert.ok(btnTag.startsWith("<button"));
    assert.ok(btnTag.includes('type="button"'));
    assert.match(btnTag, /min-height:\s*56px/i);
    assert.match(btnTag, /min-width:\s*56px/i);
  }

  assert.ok(decoded.includes("Thumb-Index Pinch -> Enter"));
  assert.ok(decoded.includes("Wrist Flick -> ArrowLeft/Right"));
  assert.ok(decoded.includes("Thumb-Middle / Back -> popstate Dismiss"));

  const readOnlyHtml = renderCard({ lang: "en" });
  assert.equal(extractOpeningTagsByClass(readOnlyHtml, "voice-phrase-btn").length, 0);
  assert.equal(extractOpeningTagsByClass(readOnlyHtml, "voice-phrase-chip").length, 6);
  assert.equal(extractOpeningTagsByClass(readOnlyHtml, "neural-band-sim-btn").length, 0);
  assert.ok(decodeBasicEntities(readOnlyHtml).includes("Thumb-Index Pinch -> Enter"));
});

test("VoiceCommandCheatSheetCard localizes across en, fi, and sv with en fallback", () => {
  const makeProps = (lang: string): VoiceCommandCheatSheetCardProps => ({
    lang,
    onRunPhrase: noopRunPhrase,
    onTriggerHudGesture: noopTriggerGesture
  });

  const enHtml = renderCard(makeProps("en"));
  const fiHtml = renderCard(makeProps("fi"));
  const svHtml = renderCard(makeProps("sv"));
  const fiRegionalHtml = renderCard(makeProps("fi-FI"));
  const svRegionalHtml = renderCard(makeProps("sv-SE"));
  const deFallbackHtml = renderCard(makeProps("de"));

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("Hands-Free Voice &amp; Neural Band Try-It Guide"));
  assert.ok(enHtml.includes("&quot;I took it&quot;"));
  assert.ok(enHtml.includes("LOG DOSE"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Kädet vapaana: äänikomennot ja Neural Band -opas"));
  assert.ok(fiHtml.includes("&quot;Otin sen&quot;"));
  assert.ok(fiHtml.includes("KIRJAA ANNOS"));
  assert.ok(fiHtml.includes("Lue viivakoodi ilman verkkoa"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Handsfree: röstkommandon och Neural Band-guide"));
  assert.ok(svHtml.includes("&quot;Jag tog den&quot;"));
  assert.ok(svHtml.includes("LOGGA DOS"));
  assert.ok(svHtml.includes("Skanna streckkod offline"));
});

test("VoiceCommandCheatSheetCard button handlers invoke onRunPhrase and onTriggerHudGesture with exact payloads", () => {
  type ButtonPropsRecord = {
    className?: string;
    onClick?: () => void;
    children?: unknown;
  };

  function collectButtons(node: unknown, acc: ButtonPropsRecord[] = []): ButtonPropsRecord[] {
    if (Array.isArray(node)) {
      for (const child of node) {
        collectButtons(child, acc);
      }
      return acc;
    }
    if (!isValidElement(node)) {
      return acc;
    }
    const props = node.props as ButtonPropsRecord;
    if (node.type === "button") {
      acc.push(props);
    }
    if (props && props.children !== undefined) {
      collectButtons(props.children, acc);
    }
    return acc;
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    const capturedPhrases: string[] = [];
    const capturedGestures: HudGestureEvent[] = [];

    const tree = VoiceCommandCheatSheetCard({
      lang: locale,
      onRunPhrase: (phrase) => capturedPhrases.push(phrase),
      onTriggerHudGesture: (event) => capturedGestures.push(event)
    });

    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 9);

    for (const btn of buttons) {
      assert.equal(typeof btn.onClick, "function");
      btn.onClick?.();
    }

    assert.deepEqual(
      capturedPhrases,
      getLocalizedVoicePhrases(locale).map((item) => item.phrase)
    );
    assert.deepEqual(capturedGestures, ["repeat", "log_dose", "dismiss"]);
  }
});

test("VoiceCommandCheatSheetCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/VoiceCommandCheatSheetCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./voiceCommandCheatSheetCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["VoiceCommandCheatSheetCard.tsx", componentSource],
    ["voiceCommandCheatSheetCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must not contain block comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must not contain block comment closures`
    );
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  for (const locale of ["en", "fi", "sv", "de", "es"]) {
    const interactiveHtml = renderCard({
      lang: locale,
      onRunPhrase: noopRunPhrase,
      onTriggerHudGesture: noopTriggerGesture
    });
    const staticHtml = renderCard({ lang: locale });
    assert.equal(interactiveHtml.includes(EM_DASH), false);
    assert.equal(interactiveHtml.includes(EN_DASH), false);
    assert.equal(staticHtml.includes(EM_DASH), false);
    assert.equal(staticHtml.includes(EN_DASH), false);
  }
});
