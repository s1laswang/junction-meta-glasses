import React, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHORTCUT_LEGEND } from "../src/a11y/shortcuts.ts";
import {
  JudgeDemoTour,
  TOUR_STEPS,
  type TourStepId
} from "../src/components/JudgeDemoTour.tsx";
import {
  LanguageVoiceSupportCard,
  buildLanguageCapabilityRows
} from "../src/components/LanguageVoiceSupportCard.tsx";
import {
  OfflineReadinessCard,
  summarizeOfflineCoverage
} from "../src/components/OfflineReadinessCard.tsx";
import { ShortcutsModal } from "../src/components/ShortcutsModal.tsx";
import {
  TactileHandlingGuideCard,
  getTactileHoldTechniques
} from "../src/components/TactileHandlingGuideCard.tsx";
import { HudPreviewFrame, type HudPreviewFrameProps } from "../src/hud/HudPreviewFrame.tsx";
import { SUPPORTED_LANGUAGES, cueLabel, normalizeLang, t } from "../src/i18n/translations.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  Profile,
  TransportMode,
  Verdict,
  VerdictLevel
} from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
  throws(fn: () => void, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert" + String.fromCharCode(47) + "strict";
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

const AUDIT_LOCALES = ["en", "fi", "sv", "de"] as const;
type AuditLocale = (typeof AUDIT_LOCALES)[number];

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

const ALL_TRANSPORT_MODES: readonly TransportMode[] = ["live", "snapshot", "offline"];
const ALL_VERDICT_LEVELS: readonly VerdictLevel[] = ["match", "warning", "unsure", "info"];

const noop = (): void => {};
const noopSpeakTip = (_tip: string): void => {};
const noopSelectLang = (_code: string): void => {};
const noopSpeakSample = (_text: string, _code: string): void => {};
const noopHudEvent = (_name: "log_dose" | "repeat" | "dismiss"): void => {};

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const ZERO_COVERAGE_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipin",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"]
    },
    {
      id: "met",
      name: "Metformin",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["morning", "evening"],
      barcode: "1234567"
    },
    {
      id: "vitd",
      name: "Vitamin D",
      ingredient: "colecalciferol",
      strength: "20 mcg",
      schedule: ["morning"],
      barcode: "   "
    }
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

const SIXTY_SEVEN_COVERAGE_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipin",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432 1000-12345"
    },
    {
      id: "vitd",
      name: "Vitamin D",
      ingredient: "colecalciferol",
      strength: "20 mcg",
      schedule: ["morning"]
    },
    {
      id: "asa",
      name: "Aspirin Cardio",
      ingredient: "aspirin",
      strength: "100 mg",
      schedule: ["morning"],
      barcode: "036000-291452"
    }
  ],
  allergies: ["tree nuts"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

const GLASSES_WORN_DEVICE: DeviceState = {
  connected: true,
  worn: true,
  battery: 84,
  streaming: true,
  source: "glasses"
};

const GLASSES_DOFFED_DEVICE: DeviceState = {
  connected: true,
  worn: false,
  battery: 14,
  streaming: false,
  source: "glasses"
};

const GLASSES_DISCONNECTED_DEVICE: DeviceState = {
  connected: false,
  worn: false,
  battery: null,
  streaming: false,
  source: "glasses"
};

const PHONE_EYE_DEVICE: DeviceState = {
  connected: false,
  worn: false,
  battery: Number.NaN,
  streaming: false,
  source: "phone"
};

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.9 },
    allergens: { value: [], confidence: 0.93 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.94,
    ...overrides
  };
}

function makeLocalizedVerdict(level: VerdictLevel, lang: string, takenToday?: boolean): Verdict {
  const uiLocale = normalizeLang(lang);
  if (level === "match") {
    return {
      level: "match",
      headline: `${t(uiLocale, "verdictMatch")}: Amlodipine 5 mg`,
      speech: `${t(uiLocale, "verdictMatch")}. Amlodipine 5 mg.`,
      matchedMedId: "aml",
      takenToday: takenToday ?? false,
      reasons: [`${t(uiLocale, "verdictMatch")} (Amlodipine 5 mg)`],
      read: makeLabelRead()
    };
  }
  if (level === "warning") {
    return {
      level: "warning",
      headline: `${t(uiLocale, "verdictWarning")}: Ibuprofen 400 mg`,
      speech: `${t(uiLocale, "verdictWarning")}. Ibuprofen 400 mg NSAID.`,
      matchedMedId: takenToday ? "aml" : undefined,
      takenToday,
      reasons: [`${t(uiLocale, "verdictWarning")}: NSAID`],
      read: makeLabelRead({
        product: { value: "Ibuprofen", confidence: 0.97 },
        ingredient: { value: "ibuprofen", confidence: 0.98 },
        strength: { value: "400 mg", confidence: 0.96 }
      })
    };
  }
  if (level === "unsure") {
    return {
      level: "unsure",
      headline: t(uiLocale, "verdictUnsure"),
      speech: `${t(uiLocale, "verdictUnsure")}. ${t(uiLocale, "notMedicalDevice")}`,
      matchedMedId: undefined,
      takenToday: undefined,
      reasons: [t(uiLocale, "notMedicalDevice")],
      read: makeLabelRead({
        kind: "unreadable",
        product: { value: null, confidence: 0.32 },
        ingredient: { value: null, confidence: 0.21 },
        strength: { value: null, confidence: 0.28 },
        readability: 0.24
      })
    };
  }
  return {
    level: "info",
    headline: `${t(uiLocale, "verdictInfo")}: Barista Oat`,
    speech: `${t(uiLocale, "verdictInfo")}. Oats, gluten.`,
    matchedMedId: undefined,
    takenToday: undefined,
    reasons: [`${t(uiLocale, "verdictInfo")}: 0 nut allergens`],
    read: makeLabelRead({
      kind: "food",
      product: { value: "Barista Oat", confidence: 0.95 },
      ingredient: { value: "oat base", confidence: 0.92 },
      strength: { value: null, confidence: 0.9 },
      dosing: { value: null, confidence: 0.9 },
      allergens: { value: ["oats", "gluten"], confidence: 0.94 }
    })
  };
}

interface OpeningTagMatch {
  tagName: string;
  tag: string;
  start: number;
  end: number;
  selfClosing: boolean;
  ancestorAriaHidden: boolean;
}

interface ElementMatch {
  openTag: string;
  innerHtml: string;
  textContent: string;
}

const HTML_VOID_TAGS = new Set<string>([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function isTagBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || ch === ">" || ch === SLASH || /\s/.test(ch);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&larr;/g, "<-")
    .replace(/&rarr;/g, "->")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripStyleAndScriptBlocks(fragment: string): string {
  let cleaned = fragment;
  for (const blockTag of ["style", "script"]) {
    const openNeedle = `<${blockTag}`;
    const closeNeedle = `<${SLASH}${blockTag}`;
    let scan = 0;
    let out = "";
    while (scan < cleaned.length) {
      const lower = cleaned.toLowerCase();
      const openIdx = lower.indexOf(openNeedle, scan);
      if (openIdx === -1 || !isTagBoundaryChar(lower[openIdx + openNeedle.length])) {
        if (openIdx === -1) {
          out += cleaned.slice(scan);
          break;
        }
        out += cleaned.slice(scan, openIdx + openNeedle.length);
        scan = openIdx + openNeedle.length;
        continue;
      }
      out += cleaned.slice(scan, openIdx);
      const closeIdx = lower.indexOf(closeNeedle, openIdx + openNeedle.length);
      if (closeIdx === -1) {
        break;
      }
      const closeEnd = cleaned.indexOf(">", closeIdx + closeNeedle.length);
      scan = closeEnd === -1 ? cleaned.length : closeEnd + 1;
    }
    cleaned = out;
  }
  return cleaned;
}

function stripTagsToText(fragment: string): string {
  const withoutBlocks = stripStyleAndScriptBlocks(fragment);
  let out = "";
  let inTag = false;
  let quote: string | null = null;

  for (let i = 0; i < withoutBlocks.length; i += 1) {
    const ch = withoutBlocks[i];
    if (!inTag) {
      if (ch === "<") {
        inTag = true;
        quote = null;
      } else {
        out += ch;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      inTag = false;
    }
  }

  return decodeHtmlEntities(out).replace(/\s+/g, " ").trim();
}

function parseTagAttributes(openingTag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 1;
  while (i < openingTag.length && !/\s|>/.test(openingTag[i])) {
    i += 1;
  }

  const endLimit = openingTag.endsWith(`${SLASH}>`)
    ? openingTag.length - 2
    : openingTag.endsWith(">")
      ? openingTag.length - 1
      : openingTag.length;

  while (i < endLimit) {
    while (i < endLimit && /\s/.test(openingTag[i])) {
      i += 1;
    }
    if (i >= endLimit || openingTag[i] === SLASH) {
      break;
    }

    const nameStart = i;
    while (i < endLimit && !/[\s=>]/.test(openingTag[i])) {
      i += 1;
    }
    const rawName = openingTag.slice(nameStart, i).toLowerCase();
    if (!rawName) {
      i += 1;
      continue;
    }

    while (i < endLimit && /\s/.test(openingTag[i])) {
      i += 1;
    }

    if (i < endLimit && openingTag[i] === "=") {
      i += 1;
      while (i < endLimit && /\s/.test(openingTag[i])) {
        i += 1;
      }
      if (i < endLimit && (openingTag[i] === '"' || openingTag[i] === "'")) {
        const quoteChar = openingTag[i];
        i += 1;
        const valStart = i;
        while (i < endLimit && openingTag[i] !== quoteChar) {
          i += 1;
        }
        attrs.set(rawName, decodeHtmlEntities(openingTag.slice(valStart, i)));
        if (i < endLimit && openingTag[i] === quoteChar) {
          i += 1;
        }
      } else {
        const valStart = i;
        while (i < endLimit && !/\s/.test(openingTag[i])) {
          i += 1;
        }
        attrs.set(rawName, decodeHtmlEntities(openingTag.slice(valStart, i)));
      }
    } else {
      attrs.set(rawName, "");
    }
  }

  return attrs;
}

function getAttr(openingTag: string, attrName: string): string | null {
  const attrs = parseTagAttributes(openingTag);
  const key = attrName.toLowerCase();
  return attrs.has(key) ? (attrs.get(key) ?? "") : null;
}

function extractAllOpeningTags(html: string): OpeningTagMatch[] {
  const results: OpeningTagMatch[] = [];
  const stack: Array<{ tagName: string; ariaHidden: boolean }> = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt + 1 >= html.length) {
      break;
    }

    const nextCh = html[lt + 1];
    if (nextCh === "!" || nextCh === "?") {
      let skipPos = lt + 2;
      while (skipPos < html.length && html[skipPos] !== ">") {
        skipPos += 1;
      }
      i = skipPos + 1;
      continue;
    }

    if (nextCh === SLASH) {
      let closeNameEnd = lt + 2;
      while (closeNameEnd < html.length && /[a-zA-Z0-9:-]/.test(html[closeNameEnd])) {
        closeNameEnd += 1;
      }
      const closingTagName = html.slice(lt + 2, closeNameEnd).toLowerCase();
      let closeAngle = closeNameEnd;
      while (closeAngle < html.length && html[closeAngle] !== ">") {
        closeAngle += 1;
      }
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].tagName === closingTagName) {
          stack.length = s;
          break;
        }
      }
      i = closeAngle + 1;
      continue;
    }

    if (!/[a-zA-Z]/.test(nextCh)) {
      i = lt + 1;
      continue;
    }

    let nameEnd = lt + 1;
    while (nameEnd < html.length && /[a-zA-Z0-9:-]/.test(html[nameEnd])) {
      nameEnd += 1;
    }
    const parsedTagName = html.slice(lt + 1, nameEnd).toLowerCase();

    let pos = nameEnd;
    let quote: string | null = null;
    while (pos < html.length) {
      const ch = html[pos];
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      pos += 1;
    }

    if (pos >= html.length) {
      break;
    }

    const rawTag = html.slice(lt, pos + 1);
    const selfClosing =
      rawTag.slice(0, -1).trimEnd().endsWith(SLASH) || HTML_VOID_TAGS.has(parsedTagName);
    const ancestorAriaHidden = stack.some((frame) => frame.ariaHidden);

    results.push({
      tagName: parsedTagName,
      tag: rawTag,
      start: lt,
      end: pos + 1,
      selfClosing,
      ancestorAriaHidden
    });

    if (parsedTagName === "style" || parsedTagName === "script") {
      const closeNeedle = `<${SLASH}${parsedTagName}`;
      const closeIdx = html.toLowerCase().indexOf(closeNeedle, pos + 1);
      if (closeIdx === -1) {
        break;
      }
      const closeEnd = html.indexOf(">", closeIdx + closeNeedle.length);
      i = closeEnd === -1 ? html.length : closeEnd + 1;
    } else {
      if (!selfClosing) {
        const ownAriaHidden = getAttr(rawTag, "aria-hidden") === "true";
        stack.push({
          tagName: parsedTagName,
          ariaHidden: ancestorAriaHidden || ownAriaHidden
        });
      }
      i = pos + 1;
    }
  }

  return results;
}

function extractOpeningTags(html: string, tagName: string): OpeningTagMatch[] {
  const lowerTarget = tagName.toLowerCase();
  return extractAllOpeningTags(html).filter((entry) => entry.tagName === lowerTarget);
}

function extractElements(html: string, tagName: string): ElementMatch[] {
  const openings = extractOpeningTags(html, tagName);
  const lowerHtml = html.toLowerCase();
  const lowerName = tagName.toLowerCase();
  const openToken = `<${lowerName}`;
  const closeToken = `<${SLASH}${lowerName}`;
  const elements: ElementMatch[] = [];

  for (const open of openings) {
    if (open.selfClosing) {
      elements.push({ openTag: open.tag, innerHtml: "", textContent: "" });
      continue;
    }

    let depth = 1;
    let scanPos = open.end;
    let closeStart = -1;

    while (scanPos < lowerHtml.length && depth > 0) {
      const nextOpen = lowerHtml.indexOf(openToken, scanPos);
      const nextClose = lowerHtml.indexOf(closeToken, scanPos);
      if (nextClose === -1) {
        break;
      }

      if (
        nextOpen !== -1 &&
        nextOpen < nextClose &&
        isTagBoundaryChar(lowerHtml[nextOpen + openToken.length])
      ) {
        let endOfNestedOpen = nextOpen + openToken.length;
        let quote: string | null = null;
        while (endOfNestedOpen < html.length) {
          const ch = html[endOfNestedOpen];
          if (quote !== null) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === ">") {
            break;
          }
          endOfNestedOpen += 1;
        }
        const nestedRaw = html.slice(nextOpen, endOfNestedOpen + 1);
        const isNestedSelfClosing = nestedRaw.slice(0, -1).trimEnd().endsWith(SLASH);
        if (!isNestedSelfClosing) {
          depth += 1;
        }
        scanPos = endOfNestedOpen + 1;
        continue;
      }

      if (isTagBoundaryChar(lowerHtml[nextClose + closeToken.length])) {
        depth -= 1;
        const closeAngle = lowerHtml.indexOf(">", nextClose + closeToken.length);
        if (depth === 0) {
          closeStart = nextClose;
          break;
        }
        scanPos = closeAngle === -1 ? nextClose + closeToken.length : closeAngle + 1;
      } else {
        scanPos = nextClose + closeToken.length;
      }
    }

    const innerHtml = closeStart >= open.end ? html.slice(open.end, closeStart) : "";
    elements.push({
      openTag: open.tag,
      innerHtml,
      textContent: stripTagsToText(innerHtml)
    });
  }

  return elements;
}

function collectAllIds(html: string, label: string): Map<string, OpeningTagMatch> {
  const ids = new Map<string, OpeningTagMatch>();
  for (const entry of extractAllOpeningTags(html)) {
    const rawId = getAttr(entry.tag, "id");
    if (rawId !== null) {
      const trimmed = rawId.trim();
      assert.ok(trimmed.length > 0, `${label}: empty id attribute on ${entry.tag}`);
      assert.equal(ids.has(trimmed), false, `${label}: duplicate id="${trimmed}" in SSR HTML`);
      ids.set(trimmed, entry);
    }
  }
  return ids;
}

function parseCssPxValue(rawVal: string): number | null {
  const trimmed = rawVal.replace(/!important/gi, "").trim();
  const directMatch = /^(-?\d+(?:\.\d+)?)px$/i.exec(trimmed);
  if (directMatch) {
    const num = Number.parseFloat(directMatch[1]);
    return Number.isFinite(num) ? num : null;
  }
  const varFallbackMatch = /^var\(\s*--[a-z0-9-_]+\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)$/i.exec(trimmed);
  if (varFallbackMatch) {
    const num = Number.parseFloat(varFallbackMatch[1]);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseMinHeightPx(styleAttr: string | null): number | null {
  if (!styleAttr) {
    return null;
  }
  for (const decl of styleAttr.split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (prop === "min-height") {
      return parseCssPxValue(decl.slice(colon + 1));
    }
  }
  return null;
}

function extractScopedClassMinHeights(html: string): Map<string, number> {
  const map = new Map<string, number>();
  const lowerHtml = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const openStyle = lowerHtml.indexOf("<style", cursor);
    if (openStyle === -1) break;
    const openEnd = html.indexOf(">", openStyle);
    if (openEnd === -1) break;
    const closeStyle = lowerHtml.indexOf(`<${SLASH}style`, openEnd + 1);
    if (closeStyle === -1) break;

    const cssText = html.slice(openEnd + 1, closeStyle);
    let pos = 0;
    while (pos < cssText.length) {
      const openBrace = cssText.indexOf("{", pos);
      if (openBrace === -1) break;
      const selectorGroup = cssText.slice(pos, openBrace).trim();
      let depth = 1;
      let scan = openBrace + 1;
      while (scan < cssText.length && depth > 0) {
        if (cssText[scan] === "{") depth += 1;
        else if (cssText[scan] === "}") depth -= 1;
        scan += 1;
      }
      const body = cssText.slice(openBrace + 1, scan - 1);
      if (!selectorGroup.startsWith("@")) {
        const minHeightPx = parseMinHeightPx(body);
        if (minHeightPx !== null) {
          for (const rawSel of selectorGroup.split(",")) {
            const sel = rawSel.trim();
            const classMatch = /^\.([a-zA-Z0-9_-]+)$/.exec(sel);
            if (classMatch) {
              map.set(classMatch[1], minHeightPx);
            }
          }
        }
      }
      pos = scan;
    }

    const closeEnd = html.indexOf(">", closeStyle);
    cursor = closeEnd === -1 ? html.length : closeEnd + 1;
  }

  return map;
}

function parseFiniteNumericAttr(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

interface AuditOptions {
  label: string;
  landmarkKind?: "section" | "dialog" | "region";
  expectsHeading: boolean;
  expectsMeter?: boolean;
  expectsProgressbar?: boolean;
  minButtons?: number;
  minSvgs?: number;
}

function assertMarkupContracts(html: string, options: AuditOptions): void {
  const {
    label,
    landmarkKind,
    expectsHeading,
    expectsMeter = false,
    expectsProgressbar = false,
    minButtons,
    minSvgs
  } = options;

  assert.ok(html.trim().length > 0, `${label}: expected non-empty SSR HTML`);

  assert.equal(html.includes("undefined"), false, `${label}: leaked "undefined" in SSR HTML`);
  assert.equal(html.includes("NaN"), false, `${label}: leaked "NaN" in SSR HTML`);
  assert.equal(
    html.includes("[object Object]"),
    false,
    `${label}: leaked "[object Object]" in SSR HTML`
  );
  assert.equal(html.includes("[object "), false, `${label}: leaked "[object ...]" in SSR HTML`);
  assert.equal(
    html.includes(HTML_COMMENT_OPEN),
    false,
    `${label}: unexpected HTML comment in SSR markup`
  );
  assert.equal(html.includes(EM_DASH), false, `${label}: unexpected em dash in SSR markup`);
  assert.equal(html.includes(EN_DASH), false, `${label}: unexpected en dash in SSR markup`);

  const allOpeningTags = extractAllOpeningTags(html);
  const allIds = collectAllIds(html, label);
  const scopedClassMinHeights = extractScopedClassMinHeights(html);

  const sectionTags = allOpeningTags.filter((m) => m.tagName === "section").map((m) => m.tag);
  const dialogTags = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "dialog")
    .map((m) => m.tag);
  const regionTags = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "region")
    .map((m) => m.tag);

  const candidateLandmarks = [...sectionTags, ...dialogTags, ...regionTags];
  assert.ok(
    candidateLandmarks.length > 0,
    `${label}: expected at least one semantic landmark (<section>, role="dialog", or role="region")`
  );

  for (const sectionTag of sectionTags) {
    const ariaLabel = (getAttr(sectionTag, "aria-label") ?? "").trim();
    const ariaLabelledBy = (getAttr(sectionTag, "aria-labelledby") ?? "").trim();
    assert.ok(
      ariaLabel.length > 0 || ariaLabelledBy.length > 0,
      `${label}: <section> landmark must expose non-empty aria-label or aria-labelledby`
    );
  }

  for (const dialogTag of dialogTags) {
    assert.equal(
      getAttr(dialogTag, "aria-modal"),
      "true",
      `${label}: role="dialog" must declare aria-modal="true"`
    );
    assert.equal(
      getAttr(dialogTag, "tabindex"),
      "-1",
      `${label}: role="dialog" must declare tabindex="-1"`
    );
    const labelledBy = (getAttr(dialogTag, "aria-labelledby") ?? "").trim();
    const ariaLabel = (getAttr(dialogTag, "aria-label") ?? "").trim();
    assert.ok(
      labelledBy.length > 0 || ariaLabel.length > 0,
      `${label}: role="dialog" must expose aria-labelledby or aria-label`
    );
  }

  for (const regionTag of regionTags) {
    const labelledBy = (getAttr(regionTag, "aria-labelledby") ?? "").trim();
    const ariaLabel = (getAttr(regionTag, "aria-label") ?? "").trim();
    assert.ok(
      labelledBy.length > 0 || ariaLabel.length > 0,
      `${label}: role="region" must expose non-empty aria-label or aria-labelledby`
    );
  }

  if (landmarkKind === "section") {
    assert.ok(sectionTags.length > 0, `${label}: expected <section> landmark`);
  } else if (landmarkKind === "dialog") {
    assert.ok(dialogTags.length > 0, `${label}: expected role="dialog" landmark`);
  } else if (landmarkKind === "region") {
    assert.ok(regionTags.length > 0, `${label}: expected role="region" landmark`);
  }

  for (const entry of allOpeningTags) {
    for (const refAttr of ["aria-labelledby", "aria-describedby", "aria-controls"]) {
      const rawRefs = getAttr(entry.tag, refAttr);
      if (rawRefs !== null && rawRefs.trim().length > 0) {
        for (const refId of rawRefs.trim().split(/\s+/)) {
          assert.ok(
            allIds.has(refId),
            `${label}: ${refAttr} on <${entry.tagName}> references missing id="${refId}"`
          );
          if (refAttr === "aria-labelledby" || refAttr === "aria-describedby") {
            const targetTag = allIds.get(refId)!;
            const targetElements = extractElements(html, targetTag.tagName).filter(
              (el) => getAttr(el.openTag, "id") === refId
            );
            assert.ok(
              targetElements.length === 1 && targetElements[0].textContent.length > 0,
              `${label}: ${refAttr} target id="${refId}" must have non-empty text`
            );
          }
        }
      }
    }
  }

  const meterElements = extractElements(html, "meter");
  if (expectsMeter) {
    assert.ok(meterElements.length > 0, `${label}: expected <meter> element`);
  }
  for (const meter of meterElements) {
    const meterLabel = (getAttr(meter.openTag, "aria-label") ?? "").trim();
    const meterLabelledBy = (getAttr(meter.openTag, "aria-labelledby") ?? "").trim();
    assert.ok(
      meterLabel.length > 0 || meterLabelledBy.length > 0,
      `${label}: <meter> must expose non-empty aria-label or aria-labelledby`
    );
    const minVal = parseFiniteNumericAttr(getAttr(meter.openTag, "min"));
    const maxVal = parseFiniteNumericAttr(getAttr(meter.openTag, "max"));
    const nowVal = parseFiniteNumericAttr(getAttr(meter.openTag, "value"));
    assert.ok(minVal !== null, `${label}: <meter> missing numeric min`);
    assert.ok(maxVal !== null, `${label}: <meter> missing numeric max`);
    assert.ok(nowVal !== null, `${label}: <meter> missing numeric value`);
    assert.ok(minVal < maxVal, `${label}: <meter> min (${minVal}) must be < max (${maxVal})`);
    assert.ok(
      nowVal >= minVal && nowVal <= maxVal,
      `${label}: <meter> value (${nowVal}) outside [${minVal}, ${maxVal}]`
    );
    for (const optBound of ["low", "high", "optimum"]) {
      const boundRaw = getAttr(meter.openTag, optBound);
      if (boundRaw !== null) {
        const boundNum = parseFiniteNumericAttr(boundRaw);
        assert.ok(
          boundNum !== null && boundNum >= minVal && boundNum <= maxVal,
          `${label}: <meter> ${optBound}="${boundRaw}" outside [${minVal}, ${maxVal}]`
        );
      }
    }
    assert.ok(
      meter.textContent.length > 0,
      `${label}: <meter> must provide non-empty fallback text`
    );
  }

  const progressbars = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "progressbar")
    .map((m) => m.tag);
  if (expectsProgressbar) {
    assert.ok(progressbars.length > 0, `${label}: expected role="progressbar" element`);
  }
  for (const barTag of progressbars) {
    const barLabel = (getAttr(barTag, "aria-label") ?? "").trim();
    const barLabelledBy = (getAttr(barTag, "aria-labelledby") ?? "").trim();
    assert.ok(
      barLabel.length > 0 || barLabelledBy.length > 0,
      `${label}: role="progressbar" must expose aria-label or aria-labelledby`
    );
    const minVal = parseFiniteNumericAttr(getAttr(barTag, "aria-valuemin"));
    const maxVal = parseFiniteNumericAttr(getAttr(barTag, "aria-valuemax"));
    const nowVal = parseFiniteNumericAttr(getAttr(barTag, "aria-valuenow"));
    assert.ok(minVal !== null, `${label}: role="progressbar" missing numeric aria-valuemin`);
    assert.ok(maxVal !== null, `${label}: role="progressbar" missing numeric aria-valuemax`);
    assert.ok(nowVal !== null, `${label}: role="progressbar" missing numeric aria-valuenow`);
    assert.ok(
      minVal < maxVal,
      `${label}: role="progressbar" aria-valuemin (${minVal}) must be < aria-valuemax (${maxVal})`
    );
    assert.ok(
      nowVal >= minVal && nowVal <= maxVal,
      `${label}: role="progressbar" aria-valuenow (${nowVal}) outside [${minVal}, ${maxVal}]`
    );
  }

  const h2Elements = extractElements(html, "h2");
  const h3Elements = extractElements(html, "h3");
  const semanticHeadings = [...h2Elements, ...h3Elements];

  if (expectsHeading) {
    assert.ok(
      semanticHeadings.length > 0,
      `${label}: expected at least one semantic <h2> or <h3> heading`
    );
  }
  for (const heading of semanticHeadings) {
    assert.ok(
      heading.textContent.length > 0,
      `${label}: semantic heading must have non-empty visible text`
    );
  }

  const svgEntries = allOpeningTags.filter((m) => m.tagName === "svg");
  if (minSvgs !== undefined) {
    assert.ok(
      svgEntries.length >= minSvgs,
      `${label}: expected >= ${minSvgs} <svg> elements, got ${svgEntries.length}`
    );
  }
  for (const svgEntry of svgEntries) {
    const ariaHidden = getAttr(svgEntry.tag, "aria-hidden");
    const role = getAttr(svgEntry.tag, "role");
    const ariaLabel = getAttr(svgEntry.tag, "aria-label");
    const validHidden = ariaHidden === "true" || svgEntry.ancestorAriaHidden;
    const validImg =
      !svgEntry.ancestorAriaHidden &&
      role === "img" &&
      ariaLabel !== null &&
      ariaLabel.trim().length > 0;
    assert.ok(
      validHidden || validImg,
      `${label}: <svg> must declare aria-hidden="true" or role="img" + non-empty aria-label: ${svgEntry.tag}`
    );
  }

  const buttons = extractElements(html, "button");
  if (minButtons !== undefined) {
    assert.ok(
      buttons.length >= minButtons,
      `${label}: expected >= ${minButtons} <button> elements, got ${buttons.length}`
    );
  }

  const hasWaveguideViewport = html.includes('data-waveguide-viewport="600x600"');
  let pwaGestureTouchButtons = 0;
  let inLensWaveguideButtons = 0;

  for (const btn of buttons) {
    const btnType = getAttr(btn.openTag, "type");
    assert.ok(
      btnType === "button" || btnType === "submit" || btnType === "reset",
      `${label}: <button> must declare explicit type attribute: ${btn.openTag}`
    );

    const classTokens = (getAttr(btn.openTag, "class") ?? "")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const hasBtnClass = classTokens.includes("btn");
    const inlineMinHeightPx = parseMinHeightPx(getAttr(btn.openTag, "style"));
    let scopedMinHeightPx: number | null = null;
    for (const token of classTokens) {
      const candidate = scopedClassMinHeights.get(token);
      if (candidate !== undefined) {
        scopedMinHeightPx =
          scopedMinHeightPx === null ? candidate : Math.max(scopedMinHeightPx, candidate);
      }
    }
    const effectiveMinHeightPx = inlineMinHeightPx ?? scopedMinHeightPx;
    const hudActionAttr = getAttr(btn.openTag, "data-hud-action");
    const isSimulatedLensAction = hasWaveguideViewport && hudActionAttr !== null;

    if (isSimulatedLensAction) {
      inLensWaveguideButtons += 1;
      assert.ok(
        effectiveMinHeightPx !== null && effectiveMinHeightPx >= 44,
        `${label}: simulated waveguide HUD button must maintain >= 44px height: ${btn.openTag}`
      );
    } else {
      const hasTouchTargetMinHeight = effectiveMinHeightPx !== null && effectiveMinHeightPx >= 48;
      assert.ok(
        hasBtnClass || hasTouchTargetMinHeight,
        `${label}: <button> must use .btn class or min-height >= 48px: ${btn.openTag}`
      );
      if (inlineMinHeightPx !== null) {
        assert.ok(
          inlineMinHeightPx >= 48,
          `${label}: <button> inline min-height ${inlineMinHeightPx}px is below 48px touch target minimum`
        );
      }
      if (scopedMinHeightPx !== null) {
        assert.ok(
          scopedMinHeightPx >= 48,
          `${label}: <button> scoped min-height ${scopedMinHeightPx}px is below 48px touch target minimum`
        );
      }
      if (classTokens.includes("hpf-gesture-btn") && hasTouchTargetMinHeight) {
        pwaGestureTouchButtons += 1;
      }
    }

    const ariaLabel = (getAttr(btn.openTag, "aria-label") ?? "").trim();
    const accessibleName = ariaLabel.length > 0 ? ariaLabel : btn.textContent;
    assert.ok(
      accessibleName.length > 0,
      `${label}: <button> must expose a non-empty accessible name: ${btn.openTag}`
    );

    if (getAttr(btn.openTag, "disabled") !== null) {
      assert.equal(
        getAttr(btn.openTag, "aria-disabled"),
        "true",
        `${label}: disabled <button> must declare aria-disabled="true"`
      );
    }
  }

  if (inLensWaveguideButtons > 0) {
    assert.ok(
      pwaGestureTouchButtons >= 3,
      `${label}: simulated in-lens HUD buttons must pair with >= 3 (>= 48px) Neural Band gesture buttons`
    );
  }

  for (const anchor of extractElements(html, "a")) {
    const href = (getAttr(anchor.openTag, "href") ?? "").trim();
    assert.ok(href.length > 0, `${label}: <a> must expose non-empty href`);
    const ariaLabel = (getAttr(anchor.openTag, "aria-label") ?? "").trim();
    const accessibleName = ariaLabel.length > 0 ? ariaLabel : anchor.textContent;
    assert.ok(accessibleName.length > 0, `${label}: <a> must expose non-empty accessible name`);
    if (getAttr(anchor.openTag, "target") === "_blank") {
      const relTokens = (getAttr(anchor.openTag, "rel") ?? "").split(/\s+/);
      assert.ok(
        relTokens.includes("noopener") && relTokens.includes("noreferrer"),
        `${label}: target="_blank" link must include rel="noopener noreferrer"`
      );
    }
    const anchorClasses = (getAttr(anchor.openTag, "class") ?? "")
      .trim()
      .split(/\s+/)
      .filter((tok) => tok.length > 0);
    const anchorInlineMin = parseMinHeightPx(getAttr(anchor.openTag, "style"));
    let anchorScopedMin: number | null = null;
    for (const tok of anchorClasses) {
      const c = scopedClassMinHeights.get(tok);
      if (c !== undefined) {
        anchorScopedMin = anchorScopedMin === null ? c : Math.max(anchorScopedMin, c);
      }
    }
    const anchorMinHeight = anchorInlineMin ?? anchorScopedMin;
    if (anchorMinHeight !== null || anchorClasses.includes("btn")) {
      assert.ok(
        anchorClasses.includes("btn") || (anchorMinHeight !== null && anchorMinHeight >= 48),
        `${label}: action link must meet >= 48px touch target height`
      );
    }
  }
}

type Wave9LocaleBehavior = "ui-en-fi-sv-fallback" | "language-matrix" | "hud-verdict-payload";

interface Wave9SurfaceSpec {
  name: string;
  landmarkKind: "section" | "dialog" | "region";
  expectsHeading: boolean;
  expectsMeter?: boolean;
  localeBehavior: Wave9LocaleBehavior;
  minButtons: number;
  minSvgs: number;
  render: (lang: AuditLocale) => ReactElement;
}

const ALL_SIX_WAVE9_AND_MODAL_SPECS: readonly Wave9SurfaceSpec[] = [
  {
    name: "TactileHandlingGuideCard",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv-fallback",
    minButtons: 4,
    minSvgs: 4,
    render: (lang) =>
      createElement(TactileHandlingGuideCard, {
        lang,
        activeCue: "hold_still",
        onSpeakTip: noopSpeakTip
      })
  },
  {
    name: "OfflineReadinessCard",
    landmarkKind: "section",
    expectsHeading: true,
    expectsMeter: true,
    localeBehavior: "ui-en-fi-sv-fallback",
    minButtons: 2,
    minSvgs: 7,
    render: (lang) =>
      createElement(OfflineReadinessCard, {
        profile: DEMO_PROFILE,
        mode: "live",
        lang,
        onScanBarcodeNow: noop,
        onOpenPharmacyImport: noop
      })
  },
  {
    name: "LanguageVoiceSupportCard",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "language-matrix",
    minButtons: 16,
    minSvgs: 13,
    render: (lang) =>
      createElement(LanguageVoiceSupportCard, {
        activeLang: lang,
        muted: false,
        onSelectLang: noopSelectLang,
        onSpeakSample: noopSpeakSample
      })
  },
  {
    name: "JudgeDemoTour",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv-fallback",
    minButtons: 6,
    minSvgs: 1,
    render: (lang) =>
      createElement(JudgeDemoTour, {
        lang,
        activeStep: "evening_match",
        collapsed: false,
        onToggleCollapsed: noop,
        onRunStep: noop
      })
  },
  {
    name: "ShortcutsModal",
    landmarkKind: "dialog",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv-fallback",
    minButtons: 2,
    minSvgs: 1,
    render: (lang) =>
      createElement(ShortcutsModal, {
        open: true,
        lang,
        muted: false,
        onClose: noop
      })
  },
  {
    name: "HudPreviewFrame",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "hud-verdict-payload",
    minButtons: 6,
    minSvgs: 2,
    render: (lang) =>
      createElement(HudPreviewFrame, {
        verdict: makeLocalizedVerdict("match", lang, false),
        coach: null,
        checking: false,
        device: GLASSES_WORN_DEVICE,
        hudSocketConnected: true,
        onTriggerHudEvent: noopHudEvent
      })
  }
];

test("All 6 Wave-9, tour, modal, and HUD-preview surfaces pass landmark, unique-ID, ARIA reference, meter, SVG, artifact, and >= 48px touch-target SSR audit across en, fi, sv, and de", () => {
  assert.equal(ALL_SIX_WAVE9_AND_MODAL_SPECS.length, 6);

  const renderedBySurface = new Map<string, Record<AuditLocale, string>>();

  for (const spec of ALL_SIX_WAVE9_AND_MODAL_SPECS) {
    const byLocale = {} as Record<AuditLocale, string>;

    for (const locale of AUDIT_LOCALES) {
      const html = renderToStaticMarkup(spec.render(locale));
      byLocale[locale] = html;

      assertMarkupContracts(html, {
        label: `${spec.name}[${locale}]`,
        landmarkKind: spec.landmarkKind,
        expectsHeading: spec.expectsHeading,
        expectsMeter: spec.expectsMeter,
        minButtons: spec.minButtons,
        minSvgs: spec.minSvgs
      });
    }

    renderedBySurface.set(spec.name, byLocale);

    assert.notEqual(byLocale.en, byLocale.fi, `${spec.name}: expected distinct en and fi SSR markup`);
    assert.notEqual(byLocale.en, byLocale.sv, `${spec.name}: expected distinct en and sv SSR markup`);
    assert.notEqual(byLocale.fi, byLocale.sv, `${spec.name}: expected distinct fi and sv SSR markup`);

    if (spec.localeBehavior === "ui-en-fi-sv-fallback" || spec.localeBehavior === "hud-verdict-payload") {
      assert.equal(
        byLocale.de,
        byLocale.en,
        `${spec.name}: expected fallback locale "de" to normalize cleanly to "en"`
      );
    } else {
      assert.ok(byLocale.en.includes('lang="en"') && byLocale.en.includes('data-active-lang="en"'));
      assert.ok(byLocale.fi.includes('lang="fi"') && byLocale.fi.includes('data-active-lang="fi"'));
      assert.ok(byLocale.sv.includes('lang="sv"') && byLocale.sv.includes('data-active-lang="sv"'));
      assert.ok(
        byLocale.de.includes('lang="en"') && byLocale.de.includes('data-active-lang="de"'),
        "LanguageVoiceSupportCard[de]: expected English fallback UI lang with Deutsch active row"
      );
      const unlistedFallbackHtml = renderToStaticMarkup(
        createElement(LanguageVoiceSupportCard, {
          activeLang: "nl",
          muted: false,
          onSelectLang: noopSelectLang,
          onSpeakSample: noopSpeakSample
        })
      );
      assert.equal(unlistedFallbackHtml, byLocale.en);
    }
  }

  assert.equal(renderedBySurface.size, 6);
});

test("TactileHandlingGuideCard activeCue highlights, unmatched cues, null/undefined cues, and read-only vs interactive modes uphold all WCAG SSR contracts across en, fi, sv, and de", () => {
  const cueVariants: ReadonlyArray<CoachCue | null | undefined> = [
    undefined,
    null,
    ...ALL_COACH_CUES
  ];

  for (const locale of AUDIT_LOCALES) {
    const expectedTechniques = getTactileHoldTechniques(locale);
    assert.equal(expectedTechniques.length, 4);

    for (const activeCue of cueVariants) {
      for (const interactive of [true, false]) {
        const html = renderToStaticMarkup(
          createElement(TactileHandlingGuideCard, {
            lang: locale,
            activeCue,
            onSpeakTip: interactive ? noopSpeakTip : undefined
          })
        );

        assertMarkupContracts(html, {
          label: `TactileHandlingGuideCard[lang=${locale},cue=${String(activeCue)},btn=${String(interactive)}]`,
          landmarkKind: "section",
          expectsHeading: true,
          minButtons: interactive ? 4 : 0,
          minSvgs: 4
        });

        const statusSpans = extractOpeningTags(html, "span").filter(
          (s) => getAttr(s.tag, "role") === "status" && getAttr(s.tag, "aria-live") === "polite"
        );
        assert.equal(statusSpans.length, 1);

        const listItems = extractOpeningTags(html, "li");
        assert.equal(listItems.length, 4);

        const matchedTechnique =
          activeCue !== undefined && activeCue !== null
            ? (expectedTechniques.find((item) => item.relatedCue === activeCue) ?? null)
            : null;

        const rootSection = extractOpeningTags(html, "section")[0];
        assert.equal(
          getAttr(rootSection.tag, "data-highlighted-technique"),
          matchedTechnique ? matchedTechnique.id : "none"
        );
        assert.equal(getAttr(rootSection.tag, "lang"), normalizeLang(locale));

        const currentStepItems = listItems.filter((li) => getAttr(li.tag, "aria-current") === "step");
        if (matchedTechnique) {
          assert.equal(currentStepItems.length, 1);
          assert.equal(getAttr(currentStepItems[0].tag, "data-technique-id"), matchedTechnique.id);
          assert.equal(getAttr(currentStepItems[0].tag, "data-highlighted"), "true");
        } else {
          assert.equal(currentStepItems.length, 0);
        }

        const buttons = extractElements(html, "button");
        assert.equal(buttons.length, interactive ? 4 : 0);
      }
    }
  }
});

test("OfflineReadinessCard 0%, 67%, and 100% barcode coverage, empty profile, dash sanitization, and live/snapshot/offline modes uphold <meter>, live-region, and touch-target contracts across en, fi, sv, and de", () => {
  assert.equal(summarizeOfflineCoverage(ZERO_COVERAGE_PROFILE).coveragePct, 0);
  assert.equal(summarizeOfflineCoverage(SIXTY_SEVEN_COVERAGE_PROFILE).coveragePct, 67);
  assert.equal(summarizeOfflineCoverage(DEMO_PROFILE).coveragePct, 100);
  assert.equal(summarizeOfflineCoverage(EMPTY_PROFILE).coveragePct, 100);

  const dashSanitizedProfile: Profile = {
    meds: [
      {
        id: `med${EM_DASH}aml`,
        name: `Amlodipin ${EM_DASH} Evening`,
        ingredient: `amlodipine${EN_DASH}besilate`,
        strength: `5${EN_DASH}10 mg`,
        schedule: ["evening"],
        barcode: "6432100012345"
      }
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en"
  };

  const coverageCases: ReadonlyArray<{
    tag: string;
    profile: Profile;
    expectedPct: number;
    expectedReady: number;
    expectedTotal: number;
    minSvgsLive: number;
  }> = [
    {
      tag: "0pct",
      profile: ZERO_COVERAGE_PROFILE,
      expectedPct: 0,
      expectedReady: 0,
      expectedTotal: 3,
      minSvgsLive: 5
    },
    {
      tag: "67pct",
      profile: SIXTY_SEVEN_COVERAGE_PROFILE,
      expectedPct: 67,
      expectedReady: 2,
      expectedTotal: 3,
      minSvgsLive: 5
    },
    {
      tag: "100pct-demo",
      profile: DEMO_PROFILE,
      expectedPct: 100,
      expectedReady: 3,
      expectedTotal: 3,
      minSvgsLive: 5
    },
    {
      tag: "100pct-empty",
      profile: EMPTY_PROFILE,
      expectedPct: 100,
      expectedReady: 0,
      expectedTotal: 0,
      minSvgsLive: 2
    },
    {
      tag: "100pct-dash-sanitized",
      profile: dashSanitizedProfile,
      expectedPct: 100,
      expectedReady: 1,
      expectedTotal: 1,
      minSvgsLive: 3
    }
  ];

  const actionCombinations: ReadonlyArray<{
    tag: string;
    scan?: () => void;
    imp?: () => void;
    expectedButtons: number;
  }> = [
    { tag: "both-actions", scan: noop, imp: noop, expectedButtons: 2 },
    { tag: "scan-only", scan: noop, expectedButtons: 1 },
    { tag: "import-only", imp: noop, expectedButtons: 1 },
    { tag: "no-actions", expectedButtons: 0 }
  ];

  for (const locale of AUDIT_LOCALES) {
    for (const cov of coverageCases) {
      for (const mode of ALL_TRANSPORT_MODES) {
        const html = renderToStaticMarkup(
          createElement(OfflineReadinessCard, {
            profile: cov.profile,
            mode,
            lang: locale,
            onScanBarcodeNow: noop,
            onOpenPharmacyImport: noop
          })
        );

        assertMarkupContracts(html, {
          label: `OfflineReadinessCard[${cov.tag},${mode},${locale}]`,
          landmarkKind: "section",
          expectsHeading: true,
          expectsMeter: true,
          minButtons: 2,
          minSvgs: cov.minSvgsLive + 2 + (mode === "offline" ? 1 : 0)
        });

        const rootSection = extractOpeningTags(html, "section")[0];
        assert.equal(getAttr(rootSection.tag, "data-mode"), mode);
        assert.equal(getAttr(rootSection.tag, "data-coverage-pct"), String(cov.expectedPct));
        assert.equal(getAttr(rootSection.tag, "data-ready-count"), String(cov.expectedReady));
        assert.equal(getAttr(rootSection.tag, "data-total-meds"), String(cov.expectedTotal));

        const meters = extractElements(html, "meter");
        assert.equal(meters.length, 1);
        assert.equal(getAttr(meters[0].openTag, "value"), String(cov.expectedPct));
        assert.equal(getAttr(meters[0].openTag, "min"), "0");
        assert.equal(getAttr(meters[0].openTag, "max"), "100");
        assert.equal(getAttr(meters[0].openTag, "low"), "50");
        assert.equal(getAttr(meters[0].openTag, "high"), "99");
        assert.equal(getAttr(meters[0].openTag, "optimum"), "100");
        assert.equal(meters[0].textContent, `${cov.expectedPct}%`);

        const offlineCallouts = extractOpeningTags(html, "div").filter(
          (d) => getAttr(d.tag, "data-offline-callout") === "active"
        );
        if (mode === "offline") {
          assert.equal(offlineCallouts.length, 1);
          assert.equal(getAttr(offlineCallouts[0].tag, "role"), "status");
          assert.equal(getAttr(offlineCallouts[0].tag, "aria-live"), "polite");
        } else {
          assert.equal(offlineCallouts.length, 0);
        }

        const noteDivs = extractOpeningTags(html, "div").filter(
          (d) => getAttr(d.tag, "role") === "note"
        );
        assert.equal(noteDivs.length, 1);
      }
    }

    for (const actCombo of actionCombinations) {
      const actionHtml = renderToStaticMarkup(
        createElement(OfflineReadinessCard, {
          profile: SIXTY_SEVEN_COVERAGE_PROFILE,
          mode: "offline",
          lang: locale,
          onScanBarcodeNow: actCombo.scan,
          onOpenPharmacyImport: actCombo.imp
        })
      );
      assertMarkupContracts(actionHtml, {
        label: `OfflineReadinessCard-actions[${actCombo.tag},${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        expectsMeter: true,
        minButtons: actCombo.expectedButtons
      });
      assert.equal(extractElements(actionHtml, "button").length, actCombo.expectedButtons);
    }

    const deOfflineHtml = renderToStaticMarkup(
      createElement(OfflineReadinessCard, {
        profile: SIXTY_SEVEN_COVERAGE_PROFILE,
        mode: "offline",
        lang: "de",
        onScanBarcodeNow: noop,
        onOpenPharmacyImport: noop
      })
    );
    const enOfflineHtml = renderToStaticMarkup(
      createElement(OfflineReadinessCard, {
        profile: SIXTY_SEVEN_COVERAGE_PROFILE,
        mode: "offline",
        lang: "en",
        onScanBarcodeNow: noop,
        onOpenPharmacyImport: noop
      })
    );
    assert.equal(deOfflineHtml, enOfflineHtml);
  }
});

test("LanguageVoiceSupportCard across all 8 active languages, regional/unknown fallbacks, and muted vs unmuted states upholds aria-pressed, disabled/aria-disabled, lang-tag, and >= 56px touch-target contracts", () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 8);

  const allLanguageInputs: ReadonlyArray<{
    input: string;
    expectedActiveCode: string;
    expectedUiLocale: string;
  }> = [
    ...SUPPORTED_LANGUAGES.map((entry) => ({
      input: entry.code,
      expectedActiveCode: entry.code,
      expectedUiLocale:
        entry.code === "en" || entry.code === "fi" || entry.code === "sv" ? entry.code : "en"
    })),
    { input: "en-US", expectedActiveCode: "en", expectedUiLocale: "en" },
    { input: "fi-FI", expectedActiveCode: "fi", expectedUiLocale: "fi" },
    { input: "sv-SE", expectedActiveCode: "sv", expectedUiLocale: "sv" },
    { input: "de-DE", expectedActiveCode: "de", expectedUiLocale: "en" },
    { input: "nl", expectedActiveCode: "en", expectedUiLocale: "en" },
    { input: "", expectedActiveCode: "en", expectedUiLocale: "en" }
  ];

  for (const spec of allLanguageInputs) {
    for (const muted of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(LanguageVoiceSupportCard, {
          activeLang: spec.input,
          muted,
          onSelectLang: noopSelectLang,
          onSpeakSample: noopSpeakSample
        })
      );

      assertMarkupContracts(html, {
        label: `LanguageVoiceSupportCard[lang=${spec.input || "empty"},muted=${String(muted)}]`,
        landmarkKind: "section",
        expectsHeading: true,
        minButtons: 16,
        minSvgs: muted ? 14 : 13
      });

      const rootSection = extractOpeningTags(html, "section")[0];
      assert.equal(getAttr(rootSection.tag, "lang"), spec.expectedUiLocale);
      assert.equal(getAttr(rootSection.tag, "data-active-lang"), spec.expectedActiveCode);
      assert.equal(getAttr(rootSection.tag, "data-muted"), muted ? "true" : "false");

      const statusBadges = extractOpeningTags(html, "span").filter(
        (s) => getAttr(s.tag, "role") === "status"
      );
      assert.equal(statusBadges.length, muted ? 2 : 1);

      const rows = buildLanguageCapabilityRows(spec.input);
      assert.equal(rows.length, 8);

      const sampleParagraphs = extractOpeningTags(html, "p").filter((p) =>
        (getAttr(p.tag, "class") ?? "").includes("language-row-sample-text")
      );
      assert.equal(sampleParagraphs.length, 8);
      assert.deepEqual(
        sampleParagraphs.map((p) => getAttr(p.tag, "lang")),
        SUPPORTED_LANGUAGES.map((entry) => entry.code)
      );

      const buttons = extractElements(html, "button");
      assert.equal(buttons.length, 16);

      const selectButtons = buttons.filter(
        (b) => getAttr(b.openTag, "data-action") === "select-lang"
      );
      const sampleButtons = buttons.filter(
        (b) => getAttr(b.openTag, "data-action") === "speak-sample"
      );
      assert.equal(selectButtons.length, 8);
      assert.equal(sampleButtons.length, 8);

      const pressedButtons = selectButtons.filter(
        (b) => getAttr(b.openTag, "aria-pressed") === "true"
      );
      const unpressedButtons = selectButtons.filter(
        (b) => getAttr(b.openTag, "aria-pressed") === "false"
      );
      assert.equal(pressedButtons.length, 1);
      assert.equal(unpressedButtons.length, 7);
      assert.equal(getAttr(pressedButtons[0].openTag, "data-lang-code"), spec.expectedActiveCode);

      for (const sampleBtn of sampleButtons) {
        if (muted) {
          assert.notEqual(getAttr(sampleBtn.openTag, "disabled"), null);
          assert.equal(getAttr(sampleBtn.openTag, "aria-disabled"), "true");
        } else {
          assert.equal(getAttr(sampleBtn.openTag, "disabled"), null);
          assert.equal(getAttr(sampleBtn.openTag, "aria-disabled"), null);
        }
      }
    }
  }
});

test("JudgeDemoTour collapsed/expanded across all 5 tour steps and ShortcutsModal open/closed/muted uphold aria-expanded, aria-controls, aria-current, and modal dialog contracts across en, fi, sv, and de", () => {
  assert.equal(TOUR_STEPS.length, 5);
  const stepVariants: ReadonlyArray<TourStepId | null | undefined> = [
    undefined,
    null,
    ...TOUR_STEPS.map((s) => s.id)
  ];

  for (const locale of AUDIT_LOCALES) {
    for (const collapsed of [false, true]) {
      for (const activeStep of stepVariants) {
        const tourHtml = renderToStaticMarkup(
          createElement(JudgeDemoTour, {
            lang: locale,
            activeStep,
            collapsed,
            onToggleCollapsed: noop,
            onRunStep: noop
          })
        );

        assertMarkupContracts(tourHtml, {
          label: `JudgeDemoTour[lang=${locale},collapsed=${String(collapsed)},step=${String(activeStep)}]`,
          landmarkKind: "section",
          expectsHeading: true,
          minButtons: collapsed ? 1 : 6,
          minSvgs: 1
        });

        const rootSection = extractOpeningTags(tourHtml, "section")[0];
        assert.equal(getAttr(rootSection.tag, "data-collapsed"), collapsed ? "true" : "false");
        assert.equal(getAttr(rootSection.tag, "lang"), normalizeLang(locale));

        const buttons = extractElements(tourHtml, "button");
        assert.equal(buttons.length, collapsed ? 1 : 6);

        const toggleBtn = buttons[0];
        assert.equal(getAttr(toggleBtn.openTag, "data-action"), "toggle-judge-tour");
        assert.equal(getAttr(toggleBtn.openTag, "aria-expanded"), collapsed ? "false" : "true");

        if (collapsed) {
          assert.equal(getAttr(toggleBtn.openTag, "aria-controls"), null);
          assert.equal(extractOpeningTags(tourHtml, "ol").length, 0);
        } else {
          assert.equal(getAttr(toggleBtn.openTag, "aria-controls"), "judge-demo-tour-steps");
          const orderedLists = extractOpeningTags(tourHtml, "ol");
          assert.equal(orderedLists.length, 1);
          assert.equal(getAttr(orderedLists[0].tag, "id"), "judge-demo-tour-steps");
          assert.ok((getAttr(orderedLists[0].tag, "aria-label") ?? "").trim().length > 0);

          const stepButtons = buttons.slice(1);
          assert.equal(stepButtons.length, 5);
          const currentButtons = stepButtons.filter(
            (b) => getAttr(b.openTag, "aria-current") === "step"
          );
          if (activeStep) {
            assert.equal(currentButtons.length, 1);
            assert.equal(getAttr(currentButtons[0].openTag, "data-step-id"), activeStep);
          } else {
            assert.equal(currentButtons.length, 0);
          }
        }
      }
    }

    for (const muted of [false, true]) {
      const closedModalHtml = renderToStaticMarkup(
        createElement(ShortcutsModal, {
          open: false,
          lang: locale,
          muted,
          onClose: noop
        })
      );
      assert.equal(closedModalHtml, "");

      const openModalHtml = renderToStaticMarkup(
        createElement(ShortcutsModal, {
          open: true,
          lang: locale,
          muted,
          onClose: noop
        })
      );

      assertMarkupContracts(openModalHtml, {
        label: `ShortcutsModal[lang=${locale},open=true,muted=${String(muted)}]`,
        landmarkKind: "dialog",
        expectsHeading: true,
        minButtons: 2,
        minSvgs: 1
      });

      const dialogTag = extractOpeningTags(openModalHtml, "div").find(
        (d) => getAttr(d.tag, "role") === "dialog"
      );
      assert.ok(dialogTag !== undefined);
      assert.equal(getAttr(dialogTag.tag, "aria-modal"), "true");
      assert.equal(getAttr(dialogTag.tag, "tabindex"), "-1");
      assert.equal(getAttr(dialogTag.tag, "aria-labelledby"), "shortcuts-dialog-title");
      assert.equal(getAttr(dialogTag.tag, "aria-describedby"), "shortcuts-dialog-subtitle");
      assert.equal(getAttr(dialogTag.tag, "lang"), normalizeLang(locale));

      const nestedSections = extractOpeningTags(openModalHtml, "section");
      assert.equal(nestedSections.length, 3);

      const kbds = extractElements(openModalHtml, "kbd");
      assert.equal(kbds.length, SHORTCUT_LEGEND.length);

      const modalButtons = extractElements(openModalHtml, "button");
      assert.equal(modalButtons.length, 2);
      const playBtn = modalButtons.find(
        (b) => getAttr(b.openTag, "data-action") === "play-orientation"
      );
      assert.ok(playBtn !== undefined);
      if (muted) {
        assert.notEqual(getAttr(playBtn.openTag, "disabled"), null);
        assert.equal(getAttr(playBtn.openTag, "aria-disabled"), "true");
        const mutedNotes = extractOpeningTags(openModalHtml, "p").filter(
          (p) => getAttr(p.tag, "role") === "note"
        );
        assert.equal(mutedNotes.length, 1);
      } else {
        assert.equal(getAttr(playBtn.openTag, "disabled"), null);
        assert.equal(getAttr(playBtn.openTag, "aria-disabled"), "false");
      }
    }
  }
});

test("HudPreviewFrame across standby, all 8 coach cues, match, warning, unsure, info, and checking states upholds waveguide landmarks, SVGs, Neural Band focus, and >= 48px touch-target contracts across en, fi, sv, and de", () => {
  const standbyDeviceCases: ReadonlyArray<{
    tag: string;
    device: DeviceState;
    hudSocketConnected: boolean;
  }> = [
    { tag: "glasses-worn-sync", device: GLASSES_WORN_DEVICE, hudSocketConnected: true },
    { tag: "glasses-doffed-sync", device: GLASSES_DOFFED_DEVICE, hudSocketConnected: true },
    {
      tag: "glasses-disconnected-sim",
      device: GLASSES_DISCONNECTED_DEVICE,
      hudSocketConnected: false
    },
    { tag: "phone-eye-nan-battery", device: PHONE_EYE_DEVICE, hudSocketConnected: false },
    {
      tag: "battery-clamped-low",
      device: { ...GLASSES_WORN_DEVICE, battery: -12 },
      hudSocketConnected: true
    },
    {
      tag: "battery-clamped-high",
      device: { ...GLASSES_WORN_DEVICE, battery: 145 },
      hudSocketConnected: false
    }
  ];

  function renderHud(props: Partial<HudPreviewFrameProps>): string {
    return renderToStaticMarkup(
      createElement(HudPreviewFrame, {
        verdict: null,
        coach: null,
        checking: false,
        device: GLASSES_WORN_DEVICE,
        hudSocketConnected: true,
        onTriggerHudEvent: noopHudEvent,
        ...props
      })
    );
  }

  for (const stdCase of standbyDeviceCases) {
    const standbyHtml = renderHud({
      device: stdCase.device,
      hudSocketConnected: stdCase.hudSocketConnected
    });
    assertMarkupContracts(standbyHtml, {
      label: `HudPreviewFrame-standby[${stdCase.tag}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 6,
      minSvgs: 2
    });
    assert.ok(standbyHtml.includes('data-idle-reticle="true"'));
    assert.ok(standbyHtml.includes('data-waveguide-viewport="600x600"'));
    assert.ok(standbyHtml.includes("background-color:#000000"));
  }

  const checkingHtml = renderHud({
    checking: true,
    verdict: makeLocalizedVerdict("match", "en", false),
    coach: { cue: "hold_still", text: "Hold still" }
  });
  assertMarkupContracts(checkingHtml, {
    label: "HudPreviewFrame-checking",
    landmarkKind: "section",
    expectsHeading: true,
    minButtons: 6,
    minSvgs: 2
  });
  const checkingStatus = extractOpeningTags(checkingHtml, "div").filter(
    (d) =>
      (getAttr(d.tag, "class") ?? "").includes("hpf-checking-box") &&
      getAttr(d.tag, "role") === "status" &&
      getAttr(d.tag, "aria-live") === "polite"
  );
  assert.equal(checkingStatus.length, 1);

  for (const locale of AUDIT_LOCALES) {
    const normalized = normalizeLang(locale);

    for (const cue of ALL_COACH_CUES) {
      const coachHtml = renderHud({
        verdict: null,
        checking: false,
        coach: { cue, text: cueLabel(normalized, cue) }
      });

      assertMarkupContracts(coachHtml, {
        label: `HudPreviewFrame-coach[${cue},${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        minButtons: 6,
        minSvgs: 2
      });

      const coachStatus = extractOpeningTags(coachHtml, "div").filter(
        (d) =>
          getAttr(d.tag, "data-coach-cue") === cue &&
          getAttr(d.tag, "role") === "status" &&
          getAttr(d.tag, "aria-live") === "polite"
      );
      assert.equal(coachStatus.length, 1);
    }

    for (const level of ALL_VERDICT_LEVELS) {
      const takenVariants: ReadonlyArray<boolean | undefined> =
        level === "match"
          ? [false, true]
          : level === "warning"
            ? [undefined, true]
            : [undefined];

      for (const takenToday of takenVariants) {
        const verdictHtml = renderHud({
          verdict: makeLocalizedVerdict(level, locale, takenToday),
          coach: null,
          checking: false,
          hudSocketConnected: level === "match" || level === "warning"
        });

        assertMarkupContracts(verdictHtml, {
          label: `HudPreviewFrame-verdict[${level},taken=${String(takenToday)},${locale}]`,
          landmarkKind: "section",
          expectsHeading: true,
          minButtons: 6,
          minSvgs: 2
        });

        const verdictRegion = extractOpeningTags(verdictHtml, "div").filter(
          (d) =>
            getAttr(d.tag, "data-verdict-level") === level &&
            getAttr(d.tag, "role") === "region" &&
            (getAttr(d.tag, "aria-label") ?? "") === `${level.toUpperCase()} verdict card`
        );
        assert.equal(verdictRegion.length, 1);

        const groupDivs = extractOpeningTags(verdictHtml, "div").filter(
          (d) => getAttr(d.tag, "role") === "group"
        );
        assert.equal(groupDivs.length, 3);
        for (const grp of groupDivs) {
          assert.ok((getAttr(grp.tag, "aria-label") ?? "").trim().length > 0);
        }

        const hudButtons = extractElements(verdictHtml, "button").filter(
          (b) => getAttr(b.openTag, "data-hud-action") !== null
        );
        assert.equal(hudButtons.length, 3);
        const focusedHudButtons = hudButtons.filter(
          (b) =>
            getAttr(b.openTag, "data-focused") === "true" &&
            getAttr(b.openTag, "aria-current") === "true"
        );
        assert.equal(focusedHudButtons.length, 1);
      }
    }
  }
});

test("assertMarkupContracts deterministically rejects landmark, dialog, region, duplicate-ID, ARIA reference, meter, progressbar, leaked-token, comment, dash, SVG, and touch-target violations", () => {
  const syntheticValidHtml =
    `<section aria-labelledby="syn-h2" aria-describedby="syn-desc">` +
    `<style>.syn-touch-btn { min-height: var(--tap-min, 56px); }<${SLASH}style>` +
    `<h2 id="syn-h2">Wave 9 Surface<${SLASH}h2>` +
    `<p id="syn-desc">Verified SSR accessibility checks.<${SLASH}p>` +
    `<meter min="0" max="100" low="50" high="99" optimum="100" value="67" aria-label="Offline coverage 67%">67%<${SLASH}meter>` +
    `<div role="progressbar" aria-label="Readiness" aria-valuenow="82" aria-valuemin="0" aria-valuemax="100"><${SLASH}div>` +
    `<svg role="img" aria-label="Barcode preview" viewBox="0 0 16 16"><rect width="16" height="16"${SLASH}><${SLASH}svg>` +
    `<button type="button" class="syn-touch-btn" aria-controls="syn-list">Toggle Steps<${SLASH}button>` +
    `<ol id="syn-list"><li>Step 1<${SLASH}li><${SLASH}ol>` +
    `<${SLASH}section>`;

  assertMarkupContracts(syntheticValidHtml, {
    label: "synthetic-valid",
    landmarkKind: "section",
    expectsHeading: true,
    expectsMeter: true,
    expectsProgressbar: true,
    minButtons: 1,
    minSvgs: 1
  });

  const invalidCases: ReadonlyArray<{
    name: string;
    html: string;
    expectsMeter?: boolean;
    expectsProgressbar?: boolean;
  }> = [
    { name: "missing-landmark", html: `<div><h2>Heading<${SLASH}h2><${SLASH}div>` },
    { name: "unlabeled-section", html: `<section><h2>Heading<${SLASH}h2><${SLASH}section>` },
    {
      name: "dialog-missing-aria-modal",
      html: `<div role="dialog" tabindex="-1" aria-label="Dialog"><h2>Modal<${SLASH}h2><${SLASH}div>`
    },
    {
      name: "region-missing-label",
      html: `<div role="region"><h2>Verdict<${SLASH}h2><${SLASH}div>`
    },
    {
      name: "duplicate-id",
      html: `<section aria-labelledby="dup"><h2 id="dup">A<${SLASH}h2><p id="dup">B<${SLASH}p><${SLASH}section>`
    },
    {
      name: "broken-labelledby",
      html: `<section aria-labelledby="missing-id"><h2>Heading<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "broken-describedby",
      html: `<section aria-label="Card" aria-describedby="missing-desc"><h2>Heading<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "broken-aria-controls",
      html: `<section aria-label="Tour"><h2>Tour<${SLASH}h2><button type="button" class="btn" aria-controls="missing-steps">Expand<${SLASH}button><${SLASH}section>`
    },
    {
      name: "meter-missing-aria-label",
      html: `<section aria-label="Offline"><h2>Offline<${SLASH}h2><meter min="0" max="100" value="67">67%<${SLASH}meter><${SLASH}section>`,
      expectsMeter: true
    },
    {
      name: "meter-value-out-of-range",
      html: `<section aria-label="Offline"><h2>Offline<${SLASH}h2><meter min="0" max="100" value="125" aria-label="Coverage">125%<${SLASH}meter><${SLASH}section>`,
      expectsMeter: true
    },
    {
      name: "progressbar-out-of-range",
      html: `<section aria-label="Meter"><h2>Meter<${SLASH}h2><div role="progressbar" aria-label="Sharpness" aria-valuenow="120" aria-valuemin="0" aria-valuemax="100"><${SLASH}div><${SLASH}section>`,
      expectsProgressbar: true
    },
    {
      name: "leaked-undefined",
      html: `<section aria-label="Card"><h2>Status undefined<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "leaked-nan",
      html: `<section aria-label="Card"><h2>Coverage NaN%<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "leaked-object",
      html: `<section aria-label="Card"><h2>[object Object]<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "html-comment",
      html: `<section aria-label="Card">${HTML_COMMENT_OPEN} secret --><h2>Heading<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "em-dash",
      html: `<section aria-label="Card"><h2>HoldUp ${EM_DASH} Card<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "en-dash",
      html: `<section aria-label="Card"><h2>25${EN_DASH}30 cm<${SLASH}h2><${SLASH}section>`
    },
    {
      name: "unlabeled-svg",
      html: `<section aria-label="Card"><h2>Heading<${SLASH}h2><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"${SLASH}><${SLASH}svg><${SLASH}section>`
    },
    {
      name: "undersized-inline-button",
      html: `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" style="min-height:40px">Tap<${SLASH}button><${SLASH}section>`
    },
    {
      name: "btn-overridden-below-48px",
      html: `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" class="btn" style="min-height:44px">Tap<${SLASH}button><${SLASH}section>`
    },
    {
      name: "undersized-scoped-css-button",
      html: `<section aria-label="Card"><style>.tiny-btn { min-height: 40px; }<${SLASH}style><h2>Heading<${SLASH}h2><button type="button" class="tiny-btn">Tap<${SLASH}button><${SLASH}section>`
    },
    {
      name: "disabled-button-missing-aria-disabled",
      html: `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" class="btn" disabled="">Muted<${SLASH}button><${SLASH}section>`
    }
  ];

  for (const item of invalidCases) {
    assert.throws(
      () =>
        assertMarkupContracts(item.html, {
          label: item.name,
          expectsHeading: true,
          expectsMeter: item.expectsMeter,
          expectsProgressbar: item.expectsProgressbar
        }),
      `Expected assertMarkupContracts to reject ${item.name}`
    );
  }
});

test("wave9ComponentsA11yAudit.test.ts contains zero code comments and zero em or en dashes", () => {
  const selfSource = readFileSync(
    new URL("./wave9ComponentsA11yAudit.test.ts", import.meta.url),
    "utf8"
  );
  assert.equal(selfSource.includes(LINE_COMMENT), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(HTML_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(selfSource.includes(EN_DASH), false);
});
