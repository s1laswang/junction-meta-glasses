import React, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CaregiverAlertCard } from "../src/components/CaregiverAlertCard.tsx";
import { ConfidenceBreakdownCard } from "../src/components/ConfidenceBreakdownCard.tsx";
import { DoseTimelineCard } from "../src/components/DoseTimelineCard.tsx";
import { EvalProofCard, type ServerLedgerStats } from "../src/components/EvalProofCard.tsx";
import { HardwareTelemetryCard } from "../src/components/HardwareTelemetryCard.tsx";
import { JudgeDemoTour } from "../src/components/JudgeDemoTour.tsx";
import {
  PharmacyCameraScannerSection,
  PharmacyImportModal,
  PharmacyPreviewSection
} from "../src/components/PharmacyImportModal.tsx";
import { SafetyRuleExplainerCard } from "../src/components/SafetyRuleExplainerCard.tsx";
import { ScheduleChecklistCard } from "../src/components/ScheduleChecklistCard.tsx";
import { ShortcutsModal } from "../src/components/ShortcutsModal.tsx";
import { VoiceActivityPill } from "../src/components/VoiceActivityPill.tsx";
import { VoiceCommandCheatSheetCard } from "../src/components/VoiceCommandCheatSheetCard.tsx";
import { buildBridgeDeepLink } from "../src/pairing/links.ts";
import { SAMPLE_FINNISH_PHARMACY_QR } from "../src/pairing/pharmacyQr.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { DeviceState, LabelRead, Med, Profile, Verdict } from "../src/types.ts";

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
const HTTPS_BRIDGE_ORIGIN = `https:${SLASH}${SLASH}holdup.example`;

const AUDIT_LOCALES = ["en", "fi", "sv", "de"] as const;
type AuditLocale = (typeof AUDIT_LOCALES)[number];

const FIXED_NOW_DATE = new Date(2026, 10, 14, 20, 15, 0);
const FIXED_NOW_MS = FIXED_NOW_DATE.getTime();
const FIXED_MORNING_DOSE_MS = new Date(2026, 10, 14, 8, 20, 0).getTime();
const FIXED_EVENING_DOSE_MS = new Date(2026, 10, 14, 19, 10, 0).getTime();
const FIXED_YESTERDAY_DOSE_MS = new Date(2026, 10, 13, 20, 5, 0).getTime();
const FIXED_EARLIER_DOSE_MS = new Date(2026, 10, 11, 8, 30, 0).getTime();

const noop = (): void => {};
const noopMed = (_med: Med): void => {};
const noopMedId = (_medId: string): void => {};
const noopPhrase = (_phrase: string): void => {};
const noopGesture = (_event: "log_dose" | "repeat" | "dismiss"): void => {};

const ACTIVE_PROFILE: Profile = {
  ...DEMO_PROFILE,
  doseLog: [
    { medId: "met", ts: FIXED_MORNING_DOSE_MS },
    { medId: "aml", ts: FIXED_EVENING_DOSE_MS },
    { medId: "aml", ts: FIXED_EVENING_DOSE_MS + 900_000 },
    { medId: "met", ts: FIXED_YESTERDAY_DOSE_MS },
    { medId: "par", ts: FIXED_EARLIER_DOSE_MS }
  ]
};

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const STREAMING_GLASSES_DEVICE: DeviceState = {
  connected: true,
  worn: true,
  battery: 86,
  streaming: true,
  source: "glasses"
};

const SAMPLE_LEDGER_STATS: ServerLedgerStats = {
  since: Date.UTC(2026, 10, 14, 17, 0, 0),
  total: 6,
  features: {
    verify: {
      calls: 4,
      ok: 4,
      errors: 0,
      tokens_in: 3120,
      tokens_out: 480,
      tokens_thinking: 160,
      models: { "gemini-3.8-flash": 4 },
      latency_p50_s: 3.42,
      latency_p95_s: 5.18
    },
    live: {
      calls: 2,
      ok: 2,
      errors: 0,
      tokens_in: 1840,
      tokens_out: 620,
      models: { "gemini-3.8-live": 2 },
      latency_p50_s: 0.71,
      latency_p95_s: 0.94,
      first_audio_p50_s: 0.582,
      tool_p50_s: 2.74,
      tool_calls: 3
    }
  }
};

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.89 },
    allergens: { value: [], confidence: 0.92 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.94,
    ...overrides
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes, your evening Amlodipine 5 mg",
    speech: "Yes, this is Amlodipine 5 mg, your scheduled evening pill.",
    matchedMedId: "aml",
    takenToday: false,
    reasons: ["Matches saved evening medication", "Strength 5 mg verified"],
    read: makeLabelRead(),
    ...overrides
  };
}

const WARNING_NSAID_VERDICT: Verdict = makeVerdict({
  level: "warning",
  headline: "Stop: Ibuprofen 400 mg is an NSAID on your avoid list",
  speech: "Stop. This is Ibuprofen 400 mg, an anti-inflammatory on your avoid list.",
  matchedMedId: undefined,
  takenToday: undefined,
  reasons: ["Ibuprofen is an NSAID, on your avoid list"],
  read: makeLabelRead({
    product: { value: "Ibuprofen", confidence: 0.97 },
    ingredient: { value: "ibuprofen", confidence: 0.98 },
    strength: { value: "400 mg", confidence: 0.96 }
  })
});

interface OpeningTagMatch {
  tag: string;
  start: number;
  end: number;
  selfClosing: boolean;
}

interface ElementMatch {
  openTag: string;
  innerHtml: string;
  textContent: string;
}

function isTagBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || ch === ">" || ch === SLASH || /\s/.test(ch);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTagsToText(fragment: string): string {
  let out = "";
  let inTag = false;
  let quote: string | null = null;

  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i];
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

function extractOpeningTags(html: string, tagName: string): OpeningTagMatch[] {
  const results: OpeningTagMatch[] = [];
  const lowerHtml = html.toLowerCase();
  const needle = `<${tagName.toLowerCase()}`;
  let cursor = 0;

  while (cursor < lowerHtml.length) {
    const idx = lowerHtml.indexOf(needle, cursor);
    if (idx === -1) {
      break;
    }
    const boundary = lowerHtml[idx + needle.length];
    if (!isTagBoundaryChar(boundary)) {
      cursor = idx + needle.length;
      continue;
    }

    let pos = idx + needle.length;
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

    const rawTag = html.slice(idx, pos + 1);
    const trimmedBeforeClose = rawTag.slice(0, -1).trimEnd();
    const selfClosing = trimmedBeforeClose.endsWith(SLASH);
    results.push({
      tag: rawTag,
      start: idx,
      end: pos + 1,
      selfClosing
    });
    cursor = pos + 1;
  }

  return results;
}

function parseTagAttributes(openingTag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 1;
  while (i < openingTag.length && !/\s|>/.test(openingTag[i])) {
    i += 1;
  }

  const endLimit = openingTag.endsWith("/>")
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
        const rawVal = openingTag.slice(valStart, i);
        attrs.set(rawName, decodeHtmlEntities(rawVal));
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

function collectAllIds(html: string): Set<string> {
  const ids = new Set<string>();
  const idPattern = /\bid="([^"]+)"/gi;
  let match: RegExpExecArray | null = idPattern.exec(html);
  while (match !== null) {
    const idVal = decodeHtmlEntities(match[1]).trim();
    if (idVal.length > 0) {
      ids.add(idVal);
    }
    match = idPattern.exec(html);
  }
  return ids;
}

function parseMinHeightPx(styleAttr: string | null): number | null {
  if (!styleAttr) {
    return null;
  }
  const match = /(?:^|;)\s*min-height\s*:\s*(-?\d+(?:\.\d+)?)px\b/i.exec(styleAttr);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ComponentAuditSpec {
  name: string;
  landmarkKind: "section" | "dialog" | "region";
  expectsHeading: boolean;
  normalizesDeFallback: boolean;
  minButtons: number;
  minSvgs: number;
  render: (lang: string) => ReactElement;
}

const ALL_TWELVE_COMPONENT_SPECS: readonly ComponentAuditSpec[] = [
  {
    name: "ScheduleChecklistCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 6,
    minSvgs: 4,
    render: (lang) =>
      createElement(ScheduleChecklistCard, {
        profile: ACTIVE_PROFILE,
        lang,
        nowMs: FIXED_NOW_MS,
        onVerifyMed: noopMed,
        onLogDose: noopMedId
      })
  },
  {
    name: "SafetyRuleExplainerCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 0,
    minSvgs: 6,
    render: (lang) =>
      createElement(SafetyRuleExplainerCard, {
        profile: ACTIVE_PROFILE,
        lang
      })
  },
  {
    name: "DoseTimelineCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 1,
    minSvgs: 6,
    render: (lang) =>
      createElement(DoseTimelineCard, {
        profile: ACTIVE_PROFILE,
        lang,
        nowMs: FIXED_NOW_MS,
        onUndoLastDose: noop
      })
  },
  {
    name: "HardwareTelemetryCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 0,
    minSvgs: 4,
    render: (lang) =>
      createElement(HardwareTelemetryCard, {
        device: STREAMING_GLASSES_DEVICE,
        hudConnected: true,
        mode: "live",
        rttMs: 84,
        cameraActive: true,
        lang
      })
  },
  {
    name: "VoiceCommandCheatSheetCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 9,
    minSvgs: 6,
    render: (lang) =>
      createElement(VoiceCommandCheatSheetCard, {
        lang,
        onRunPhrase: noopPhrase,
        onTriggerHudGesture: noopGesture
      })
  },
  {
    name: "ConfidenceBreakdownCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 1,
    minSvgs: 2,
    render: (lang) =>
      createElement(ConfidenceBreakdownCard, {
        verdict: makeVerdict(),
        lang,
        defaultExpanded: true
      })
  },
  {
    name: "VoiceActivityPill",
    landmarkKind: "region",
    expectsHeading: false,
    normalizesDeFallback: true,
    minButtons: 1,
    minSvgs: 2,
    render: (lang) =>
      createElement(VoiceActivityPill, {
        cameraActive: true,
        mode: "live",
        live: "open",
        muted: false,
        assistantSpeaking: true,
        micRms: 0.62,
        lang,
        onInterruptSpeech: noop
      })
  },
  {
    name: "CaregiverAlertCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: false,
    minButtons: 6,
    minSvgs: 5,
    render: (lang) =>
      createElement(CaregiverAlertCard, {
        profile: ACTIVE_PROFILE,
        lastVerdict: WARNING_NSAID_VERDICT,
        lang,
        onQuickLogDose: noopMedId,
        now: FIXED_NOW_DATE
      })
  },
  {
    name: "EvalProofCard",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 1,
    minSvgs: 5,
    render: (lang) =>
      createElement(EvalProofCard, {
        initialStats: SAMPLE_LEDGER_STATS,
        lang
      })
  },
  {
    name: "JudgeDemoTour",
    landmarkKind: "section",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 6,
    minSvgs: 1,
    render: (lang) =>
      createElement(JudgeDemoTour, {
        lang,
        activeStep: "blurry_refusal",
        collapsed: false,
        onToggleCollapsed: noop,
        onRunStep: noop
      })
  },
  {
    name: "PharmacyImportModal",
    landmarkKind: "dialog",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 4,
    minSvgs: 0,
    render: (lang) =>
      createElement(PharmacyImportModal, {
        open: true,
        profile: ACTIVE_PROFILE,
        lang,
        onImportProfile: noop,
        onClose: noop
      })
  },
  {
    name: "ShortcutsModal",
    landmarkKind: "dialog",
    expectsHeading: true,
    normalizesDeFallback: true,
    minButtons: 2,
    minSvgs: 1,
    render: (lang) =>
      createElement(ShortcutsModal, {
        open: true,
        lang,
        muted: false,
        onClose: noop
      })
  }
];

interface AuditOptions {
  label: string;
  landmarkKind?: "section" | "dialog" | "region" | "alert";
  expectsHeading: boolean;
  minButtons?: number;
  minSvgs?: number;
}

function assertMarkupContracts(html: string, options: AuditOptions): void {
  const { label, landmarkKind, expectsHeading, minButtons, minSvgs } = options;

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

  const allIds = collectAllIds(html);
  const sectionTags = extractOpeningTags(html, "section").map((m) => m.tag);
  const divTags = extractOpeningTags(html, "div").map((m) => m.tag);
  const dialogDivs = divTags.filter((tag) => getAttr(tag, "role") === "dialog");
  const regionDivs = divTags.filter((tag) => getAttr(tag, "role") === "region");
  const alertDivs = divTags.filter((tag) => getAttr(tag, "role") === "alert");

  const candidateLandmarks = [...sectionTags, ...dialogDivs, ...regionDivs, ...alertDivs];
  assert.ok(
    candidateLandmarks.length > 0,
    `${label}: expected at least one accessible landmark (<section>, role="dialog", role="region", or role="alert")`
  );

  const labeledLandmarks = candidateLandmarks.filter((tag) => {
    const ariaLabel = getAttr(tag, "aria-label");
    const ariaLabelledBy = getAttr(tag, "aria-labelledby");
    const role = getAttr(tag, "role");
    if (role === "alert") {
      return true;
    }
    return (
      (ariaLabel !== null && ariaLabel.trim().length > 0) ||
      (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0)
    );
  });

  assert.ok(
    labeledLandmarks.length > 0,
    `${label}: expected accessible landmark with non-empty aria-label or aria-labelledby`
  );

  if (landmarkKind === "section") {
    const accessibleSections = sectionTags.filter((tag) => {
      const ariaLabel = getAttr(tag, "aria-label");
      const ariaLabelledBy = getAttr(tag, "aria-labelledby");
      return (
        (ariaLabel !== null && ariaLabel.trim().length > 0) ||
        (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0)
      );
    });
    assert.ok(
      accessibleSections.length > 0,
      `${label}: expected <section> landmark with non-empty aria-label or aria-labelledby`
    );
  } else if (landmarkKind === "dialog") {
    assert.ok(dialogDivs.length > 0, `${label}: expected <div role="dialog"> landmark`);
    for (const dialogTag of dialogDivs) {
      assert.equal(
        getAttr(dialogTag, "aria-modal"),
        "true",
        `${label}: dialog must declare aria-modal="true"`
      );
      assert.equal(
        getAttr(dialogTag, "tabindex"),
        "-1",
        `${label}: dialog must declare tabindex="-1"`
      );
      const labelledBy = getAttr(dialogTag, "aria-labelledby") ?? "";
      const ariaLabel = getAttr(dialogTag, "aria-label") ?? "";
      assert.ok(
        labelledBy.trim().length > 0 || ariaLabel.trim().length > 0,
        `${label}: dialog must expose aria-labelledby or aria-label`
      );
    }
  } else if (landmarkKind === "region") {
    assert.ok(regionDivs.length > 0, `${label}: expected <div role="region"> landmark`);
    for (const regionTag of regionDivs) {
      const labelledBy = getAttr(regionTag, "aria-labelledby") ?? "";
      const ariaLabel = getAttr(regionTag, "aria-label") ?? "";
      assert.ok(
        labelledBy.trim().length > 0 || ariaLabel.trim().length > 0,
        `${label}: region must expose non-empty aria-label or aria-labelledby`
      );
    }
  }

  for (const tag of [...sectionTags, ...divTags]) {
    for (const refAttr of ["aria-labelledby", "aria-describedby"]) {
      const rawRefs = getAttr(tag, refAttr);
      if (rawRefs !== null && rawRefs.trim().length > 0) {
        for (const refId of rawRefs.trim().split(/\s+/)) {
          assert.ok(
            allIds.has(refId),
            `${label}: ${refAttr} references missing id="${refId}"`
          );
        }
      }
    }
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

  const svgTags = extractOpeningTags(html, "svg");
  if (minSvgs !== undefined) {
    assert.ok(
      svgTags.length >= minSvgs,
      `${label}: expected >= ${minSvgs} <svg> elements, got ${svgTags.length}`
    );
  }
  for (const svg of svgTags) {
    const ariaHidden = getAttr(svg.tag, "aria-hidden");
    const role = getAttr(svg.tag, "role");
    const ariaLabel = getAttr(svg.tag, "aria-label");
    const validHidden = ariaHidden === "true";
    const validImg = role === "img" && ariaLabel !== null && ariaLabel.trim().length > 0;
    assert.ok(
      validHidden || validImg,
      `${label}: <svg> must declare aria-hidden="true" or role="img" with non-empty aria-label: ${svg.tag}`
    );
  }

  const buttons = extractElements(html, "button");
  if (minButtons !== undefined) {
    assert.ok(
      buttons.length >= minButtons,
      `${label}: expected >= ${minButtons} <button> elements, got ${buttons.length}`
    );
  }
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
    const minHeightPx = parseMinHeightPx(getAttr(btn.openTag, "style"));
    const hasTouchTargetMinHeight =
      minHeightPx !== null && minHeightPx >= 48 && minHeightPx <= 64;

    assert.ok(
      hasBtnClass || hasTouchTargetMinHeight,
      `${label}: <button> must use .btn class or declare min-height 48px..64px: ${btn.openTag}`
    );
    if (minHeightPx !== null) {
      assert.ok(
        minHeightPx >= 48 && minHeightPx <= 64,
        `${label}: <button> inline min-height ${minHeightPx}px outside 48px..64px touch target window`
      );
    }

    const ariaLabel = (getAttr(btn.openTag, "aria-label") ?? "").trim();
    const accessibleName = ariaLabel.length > 0 ? ariaLabel : btn.textContent;
    assert.ok(
      accessibleName.length > 0,
      `${label}: <button> must expose a non-empty accessible name: ${btn.openTag}`
    );
  }
}

test("All 12 HoldUp UI components pass landmark, heading, artifact, SVG, and >= 48px touch-target SSR audit across en, fi, sv, and de fallback", () => {
  assert.equal(ALL_TWELVE_COMPONENT_SPECS.length, 12);

  const renderedByComponentAndLocale = new Map<string, Record<AuditLocale, string>>();

  for (const spec of ALL_TWELVE_COMPONENT_SPECS) {
    const byLocale = {} as Record<AuditLocale, string>;

    for (const locale of AUDIT_LOCALES) {
      const html = renderToStaticMarkup(spec.render(locale));
      byLocale[locale] = html;

      assertMarkupContracts(html, {
        label: `${spec.name}[${locale}]`,
        landmarkKind: spec.landmarkKind,
        expectsHeading: spec.expectsHeading,
        minButtons: spec.minButtons,
        minSvgs: spec.minSvgs
      });
    }

    renderedByComponentAndLocale.set(spec.name, byLocale);

    if (spec.normalizesDeFallback) {
      assert.notEqual(
        byLocale.en,
        byLocale.fi,
        `${spec.name}: expected distinct en and fi SSR markup`
      );
      assert.notEqual(
        byLocale.en,
        byLocale.sv,
        `${spec.name}: expected distinct en and sv SSR markup`
      );
      assert.notEqual(
        byLocale.fi,
        byLocale.sv,
        `${spec.name}: expected distinct fi and sv SSR markup`
      );
      assert.equal(
        byLocale.de,
        byLocale.en,
        `${spec.name}: expected unknown locale "de" to fall back cleanly to "en"`
      );
    } else {
      assert.ok(byLocale.en.includes('lang="en"'));
      assert.ok(byLocale.fi.includes('lang="fi"'));
      assert.ok(byLocale.sv.includes('lang="sv"'));
      assert.ok(byLocale.de.includes('lang="de"'));
    }
  }

  assert.equal(renderedByComponentAndLocale.size, 12);
});

test("Edge, empty, collapsed, blocked-gate, muted, and scanner states across all 12 components uphold every WCAG SSR invariant across en, fi, sv, and de", () => {
  const bridgeUri = buildBridgeDeepLink(HTTPS_BRIDGE_ORIGIN, "hup7f3a2");

  for (const locale of AUDIT_LOCALES) {
    const emptyScheduleHtml = renderToStaticMarkup(
      createElement(ScheduleChecklistCard, {
        profile: EMPTY_PROFILE,
        lang: locale,
        nowMs: FIXED_NOW_MS
      })
    );
    assertMarkupContracts(emptyScheduleHtml, {
      label: `ScheduleChecklistCard-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 1
    });

    const emptySafetyRulesHtml = renderToStaticMarkup(
      createElement(SafetyRuleExplainerCard, {
        profile: EMPTY_PROFILE,
        lang: locale
      })
    );
    assertMarkupContracts(emptySafetyRulesHtml, {
      label: `SafetyRuleExplainerCard-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 6
    });

    const emptyTimelineHtml = renderToStaticMarkup(
      createElement(DoseTimelineCard, {
        profile: EMPTY_PROFILE,
        lang: locale,
        nowMs: FIXED_NOW_MS
      })
    );
    assertMarkupContracts(emptyTimelineHtml, {
      label: `DoseTimelineCard-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 1
    });

    const hardwareStates: ReadonlyArray<{
      tag: string;
      device: DeviceState;
      hudConnected: boolean;
      mode: "live" | "snapshot" | "offline";
      rttMs: number | null;
      cameraActive: boolean;
    }> = [
      {
        tag: "standby",
        device: { connected: true, worn: true, battery: 74, streaming: false, source: "glasses" },
        hudConnected: false,
        mode: "live",
        rttMs: 390,
        cameraActive: false
      },
      {
        tag: "low-battery",
        device: { connected: true, worn: true, battery: 9, streaming: false, source: "phone" },
        hudConnected: false,
        mode: "snapshot",
        rttMs: 820,
        cameraActive: true
      },
      {
        tag: "doffed",
        device: { connected: true, worn: false, battery: 62, streaming: false, source: "phone" },
        hudConnected: true,
        mode: "live",
        rttMs: null,
        cameraActive: true
      },
      {
        tag: "offline",
        device: { connected: false, worn: false, battery: null, streaming: false, source: "phone" },
        hudConnected: false,
        mode: "offline",
        rttMs: null,
        cameraActive: false
      }
    ];

    for (const hw of hardwareStates) {
      const hwHtml = renderToStaticMarkup(
        createElement(HardwareTelemetryCard, {
          device: hw.device,
          hudConnected: hw.hudConnected,
          mode: hw.mode,
          rttMs: hw.rttMs,
          cameraActive: hw.cameraActive,
          lang: locale
        })
      );
      assertMarkupContracts(hwHtml, {
        label: `HardwareTelemetryCard-${hw.tag}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        minButtons: 0,
        minSvgs: 4
      });
    }

    const staticVoiceCheatSheetHtml = renderToStaticMarkup(
      createElement(VoiceCommandCheatSheetCard, {
        lang: locale
      })
    );
    assertMarkupContracts(staticVoiceCheatSheetHtml, {
      label: `VoiceCommandCheatSheetCard-readonly[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 6
    });

    const blockedConfidenceHtml = renderToStaticMarkup(
      createElement(ConfidenceBreakdownCard, {
        verdict: makeVerdict({
          level: "unsure",
          headline: "Strength illegible",
          reasons: [],
          read: makeLabelRead({
            strength: { value: null, confidence: 0.24 },
            allergens: { value: ["peanut", "hazelnut"], confidence: 0.91 },
            readability: 0.52
          })
        }),
        lang: locale,
        defaultExpanded: true
      })
    );
    assertMarkupContracts(blockedConfidenceHtml, {
      label: `ConfidenceBreakdownCard-blocked[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 2
    });

    const collapsedConfidenceHtml = renderToStaticMarkup(
      createElement(ConfidenceBreakdownCard, {
        verdict: makeVerdict({
          level: "info",
          read: makeLabelRead({ kind: "food" })
        }),
        lang: locale,
        defaultExpanded: false
      })
    );
    assertMarkupContracts(collapsedConfidenceHtml, {
      label: `ConfidenceBreakdownCard-collapsed[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 2
    });

    const nullConfidenceHtml = renderToStaticMarkup(
      createElement(ConfidenceBreakdownCard, {
        verdict: null,
        lang: locale
      })
    );
    assert.equal(nullConfidenceHtml, "");

    const voicePillVariants: ReadonlyArray<{
      tag: string;
      cameraActive: boolean;
      mode: "live" | "snapshot" | "offline";
      live: "open" | "degraded" | "closed";
      muted: boolean;
    }> = [
      { tag: "listening", cameraActive: true, mode: "live", live: "open", muted: false },
      { tag: "snapshot", cameraActive: true, mode: "snapshot", live: "degraded", muted: false },
      { tag: "offline", cameraActive: false, mode: "offline", live: "closed", muted: false },
      { tag: "muted", cameraActive: true, mode: "live", live: "open", muted: true },
      { tag: "idle", cameraActive: false, mode: "live", live: "closed", muted: false }
    ];

    for (const pillVar of voicePillVariants) {
      const pillHtml = renderToStaticMarkup(
        createElement(VoiceActivityPill, {
          cameraActive: pillVar.cameraActive,
          mode: pillVar.mode,
          live: pillVar.live,
          muted: pillVar.muted,
          micRms: 0.35,
          lang: locale
        })
      );
      assertMarkupContracts(pillHtml, {
        label: `VoiceActivityPill-${pillVar.tag}[${locale}]`,
        landmarkKind: "region",
        expectsHeading: false,
        minButtons: 0,
        minSvgs: 1
      });
    }

    const caregiverIdleHtml = renderToStaticMarkup(
      createElement(CaregiverAlertCard, {
        profile: EMPTY_PROFILE,
        lastVerdict: null,
        lang: locale,
        onQuickLogDose: noopMedId,
        now: FIXED_NOW_DATE
      })
    );
    assertMarkupContracts(caregiverIdleHtml, {
      label: `CaregiverAlertCard-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 2,
      minSvgs: 1
    });

    const standbyEvalHtml = renderToStaticMarkup(
      createElement(EvalProofCard, {
        initialStats: null,
        lang: locale
      })
    );
    assertMarkupContracts(standbyEvalHtml, {
      label: `EvalProofCard-standby[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 5
    });

    const collapsedTourHtml = renderToStaticMarkup(
      createElement(JudgeDemoTour, {
        lang: locale,
        collapsed: true,
        onRunStep: noop
      })
    );
    assertMarkupContracts(collapsedTourHtml, {
      label: `JudgeDemoTour-collapsed[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 1
    });

    assert.equal(
      renderToStaticMarkup(
        createElement(PharmacyImportModal, {
          open: false,
          profile: DEMO_PROFILE,
          lang: locale,
          onImportProfile: noop,
          onClose: noop
        })
      ),
      ""
    );

    const pharmacySamplePreviewHtml = renderToStaticMarkup(
      createElement(PharmacyPreviewSection, {
        rawInput: SAMPLE_FINNISH_PHARMACY_QR,
        profile: DEMO_PROFILE,
        lang: locale
      })
    );
    assertMarkupContracts(pharmacySamplePreviewHtml, {
      label: `PharmacyPreviewSection-valid[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 0
    });

    for (const [alertKind, rawCode] of [
      ["bridge", bridgeUri],
      ["barcode", "6432100012345"],
      ["invalid", "{broken_payload"]
    ] as const) {
      const previewAlertHtml = renderToStaticMarkup(
        createElement(PharmacyPreviewSection, {
          rawInput: rawCode,
          profile: DEMO_PROFILE,
          lang: locale
        })
      );
      assertMarkupContracts(previewAlertHtml, {
        label: `PharmacyPreviewSection-${alertKind}[${locale}]`,
        landmarkKind: "alert",
        expectsHeading: false,
        minButtons: 0,
        minSvgs: 1
      });
    }

    const activeScannerHtml = renderToStaticMarkup(
      createElement("section", { "aria-label": "Scanner wrapper" },
        createElement(PharmacyCameraScannerSection, {
          scanning: true,
          cameraError: "Camera permission was denied.",
          lang: locale,
          onToggleScan: noop
        })
      )
    );
    assertMarkupContracts(activeScannerHtml, {
      label: `PharmacyCameraScannerSection-scanning[${locale}]`,
      landmarkKind: "section",
      expectsHeading: false,
      minButtons: 1,
      minSvgs: 0
    });
    const videoTags = extractOpeningTags(activeScannerHtml, "video");
    assert.equal(videoTags.length, 1);
    assert.ok((getAttr(videoTags[0].tag, "aria-label") ?? "").trim().length > 0);

    assert.equal(
      renderToStaticMarkup(
        createElement(ShortcutsModal, {
          open: false,
          lang: locale,
          muted: false,
          onClose: noop
        })
      ),
      ""
    );

    const mutedShortcutsHtml = renderToStaticMarkup(
      createElement(ShortcutsModal, {
        open: true,
        lang: locale,
        muted: true,
        onClose: noop
      })
    );
    assertMarkupContracts(mutedShortcutsHtml, {
      label: `ShortcutsModal-muted[${locale}]`,
      landmarkKind: "dialog",
      expectsHeading: true,
      minButtons: 2,
      minSvgs: 1
    });
  }
});

test("Form inputs, meters, live regions, and disabled button states maintain screen-reader parity across audited components", () => {
  for (const locale of AUDIT_LOCALES) {
    const caregiverHtml = renderToStaticMarkup(
      createElement(CaregiverAlertCard, {
        profile: ACTIVE_PROFILE,
        lastVerdict: WARNING_NSAID_VERDICT,
        lang: locale,
        onQuickLogDose: noopMedId,
        now: FIXED_NOW_DATE
      })
    );
    const caregiverLabels = extractOpeningTags(caregiverHtml, "label");
    const caregiverInputs = extractOpeningTags(caregiverHtml, "input");
    assert.equal(caregiverInputs.length, 2);
    const labelForSet = new Set(
      caregiverLabels.map((l) => getAttr(l.tag, "for") ?? "").filter((v) => v.length > 0)
    );
    for (const input of caregiverInputs) {
      const inputId = getAttr(input.tag, "id") ?? "";
      assert.ok(inputId.length > 0 && labelForSet.has(inputId));
      const inputMinHeight = parseMinHeightPx(getAttr(input.tag, "style"));
      assert.ok(inputMinHeight !== null && inputMinHeight >= 48);
    }

    const pharmacyHtml = renderToStaticMarkup(
      createElement(PharmacyImportModal, {
        open: true,
        profile: ACTIVE_PROFILE,
        lang: locale,
        onImportProfile: noop,
        onClose: noop
      })
    );
    const textareas = extractOpeningTags(pharmacyHtml, "textarea");
    assert.equal(textareas.length, 1);
    const textareaId = getAttr(textareas[0].tag, "id") ?? "";
    const pharmacyLabels = extractOpeningTags(pharmacyHtml, "label");
    assert.ok(pharmacyLabels.some((l) => getAttr(l.tag, "for") === textareaId));

    const confidenceHtml = renderToStaticMarkup(
      createElement(ConfidenceBreakdownCard, {
        verdict: makeVerdict(),
        lang: locale,
        defaultExpanded: true
      })
    );
    const meters = extractOpeningTags(confidenceHtml, "meter");
    assert.equal(meters.length, 8);
    for (const meter of meters) {
      assert.ok((getAttr(meter.tag, "aria-label") ?? "").trim().length > 0);
    }

    for (const spec of ALL_TWELVE_COMPONENT_SPECS) {
      const html = renderToStaticMarkup(spec.render(locale));
      for (const btn of extractElements(html, "button")) {
        const hasDisabled = getAttr(btn.openTag, "disabled") !== null;
        if (hasDisabled) {
          assert.equal(
            getAttr(btn.openTag, "aria-disabled"),
            "true",
            `${spec.name}[${locale}]: disabled <button> must declare aria-disabled="true"`
          );
        }
      }
    }
  }
});

test("assertMarkupContracts deterministically catches landmark, heading, artifact, SVG, and touch-target violations while accepting role=img SVGs and 48px..64px buttons", () => {
  const validImgSvgAndInlineButton =
    `<section aria-labelledby="demo-h2">` +
    `<h2 id="demo-h2">Valid Card<${SLASH}h2>` +
    `<svg role="img" aria-label="Calibration chart" viewBox="0 0 16 16"><rect width="16" height="16"${SLASH}><${SLASH}svg>` +
    `<button type="button" style="min-height:48px">Confirm Action<${SLASH}button>` +
    `<${SLASH}section>`;

  assertMarkupContracts(validImgSvgAndInlineButton, {
    label: "synthetic-valid",
    landmarkKind: "section",
    expectsHeading: true,
    minButtons: 1,
    minSvgs: 1
  });

  const invalidCases: ReadonlyArray<[string, string]> = [
    ["missing-landmark", `<div><h2>Heading<${SLASH}h2><${SLASH}div>`],
    ["missing-heading", `<section aria-label="Card"><p>Body only<${SLASH}p><${SLASH}section>`],
    [
      "broken-labelledby",
      `<section aria-labelledby="nonexistent-id"><h2>Heading<${SLASH}h2><${SLASH}section>`
    ],
    [
      "leaked-undefined",
      `<section aria-label="Card"><h2>Value undefined<${SLASH}h2><${SLASH}section>`
    ],
    ["leaked-nan", `<section aria-label="Card"><h2>Score NaN%<${SLASH}h2><${SLASH}section>`],
    [
      "leaked-object",
      `<section aria-label="Card"><h2>[object Object]<${SLASH}h2><${SLASH}section>`
    ],
    [
      "html-comment",
      `<section aria-label="Card">${HTML_COMMENT_OPEN} note --><h2>Heading<${SLASH}h2><${SLASH}section>`
    ],
    [
      "em-dash",
      `<section aria-label="Card"><h2>Heading ${EM_DASH} Sub<${SLASH}h2><${SLASH}section>`
    ],
    [
      "en-dash",
      `<section aria-label="Card"><h2>Heading ${EN_DASH} Sub<${SLASH}h2><${SLASH}section>`
    ],
    [
      "unlabeled-svg",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"${SLASH}><${SLASH}svg><${SLASH}section>`
    ],
    [
      "undersized-button",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" style="min-height:36px">Tiny<${SLASH}button><${SLASH}section>`
    ],
    [
      "btn-class-below-48px",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" class="btn" style="min-height:40px">Overridden<${SLASH}button><${SLASH}section>`
    ]
  ];

  for (const [caseName, badHtml] of invalidCases) {
    assert.throws(
      () =>
        assertMarkupContracts(badHtml, {
          label: caseName,
          landmarkKind: "section",
          expectsHeading: true
        }),
      `Expected assertMarkupContracts to reject ${caseName}`
    );
  }
});

test("allComponentsA11yAudit.test.ts contains zero code comments and zero em or en dashes", () => {
  const selfSource = readFileSync(new URL("./allComponentsA11yAudit.test.ts", import.meta.url), "utf8");
  assert.equal(selfSource.includes(LINE_COMMENT), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(selfSource.includes(EN_DASH), false);
});
