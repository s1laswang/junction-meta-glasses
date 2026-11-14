import React, { createElement, type ReactElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_SCENARIOS } from "../src/camera/demoScenarios.ts";
import { ConsentOnboarding } from "../src/components/ConsentOnboarding.tsx";
import { ConversationBar } from "../src/components/ConversationBar.tsx";
import { DeviceResiliencePanel } from "../src/components/DeviceResiliencePanel.tsx";
import { EmergencyMedCard } from "../src/components/EmergencyMedCard.tsx";
import { FrameReadinessMeter } from "../src/components/FrameReadinessMeter.tsx";
import { PermissionBanner } from "../src/components/PermissionBanner.tsx";
import { PrivacyFlowCard } from "../src/components/PrivacyFlowCard.tsx";
import { ProfileManager } from "../src/components/ProfileManager.tsx";
import { VerdictCard } from "../src/components/VerdictCard.tsx";
import { ViewfinderStage } from "../src/components/ViewfinderStage.tsx";
import { buildBridgeDeepLink, buildHudUrl } from "../src/pairing/links.ts";
import { encodeQrSvg } from "../src/pairing/qrSvg.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type {
  CameraSource,
  ChaosConfig,
  CoachCue,
  ConsentRecord,
  DemoScenarioId,
  DeviceState,
  LabelRead,
  PermissionStateSummary,
  Profile,
  SessionSnapshot,
  TranscriptEntry,
  TransportMode,
  Verdict
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
const HTTPS_ORIGIN = `https:${SLASH}${SLASH}holdup.example`;

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

const FIXED_ACCEPTED_MS = new Date(2026, 10, 14, 18, 45, 0).getTime();
const TODAY_DOSE_MS = (() => {
  const d = new Date();
  d.setHours(8, 15, 0, 0);
  return d.getTime();
})();

const noop = (): void => {};
const noopText = (_text: string): void => {};
const noopProfile = (_next: Profile): void => {};
const noopChaos = (_next: ChaosConfig): void => {};
const noopSource = (_src: CameraSource): void => {};
const noopScenario = (_id: DemoScenarioId): void => {};
const noopOptionalMedId = (_medId?: string): void => {};

const nullVideoRef: RefObject<HTMLVideoElement | null> = { current: null };
const nullImgRef: RefObject<HTMLImageElement | null> = { current: null };

const ACTIVE_PROFILE: Profile = {
  ...DEMO_PROFILE,
  meds: [
    ...DEMO_PROFILE.meds.map((med, idx) =>
      idx === 0 ? { ...med, notes: "Take with a full glass of water" } : { ...med }
    )
  ],
  doseLog: [
    { medId: "met", ts: TODAY_DOSE_MS },
    { medId: "aml", ts: FIXED_ACCEPTED_MS - 86_400_000 }
  ]
};

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const ACCEPTED_CONSENT: ConsentRecord = {
  accepted: true,
  acceptedAt: FIXED_ACCEPTED_MS,
  version: "1.0"
};

const PENDING_CONSENT: ConsentRecord = {
  accepted: false,
  acceptedAt: null,
  version: "1.0"
};

const STREAMING_GLASSES_DEVICE: DeviceState = {
  connected: true,
  worn: true,
  battery: 84,
  streaming: true,
  source: "glasses"
};

const IDLE_PHONE_DEVICE: DeviceState = {
  connected: false,
  worn: false,
  battery: null,
  streaming: false,
  source: "phone"
};

const DOFFED_LOW_BATTERY_DEVICE: DeviceState = {
  connected: true,
  worn: false,
  battery: 7,
  streaming: false,
  source: "phone"
};

const NO_CHAOS: ChaosConfig = {
  forceWsDrop: false,
  forceOffline: false,
  simulateGlassesDoffed: false,
  simulateLowBattery: false
};

const ALL_CHAOS: ChaosConfig = {
  forceWsDrop: true,
  forceOffline: true,
  simulateGlassesDoffed: true,
  simulateLowBattery: true
};

const GRANTED_PERMISSIONS: PermissionStateSummary = {
  camera: "granted",
  microphone: "granted"
};

const DENIED_PERMISSIONS: PermissionStateSummary = {
  camera: "denied",
  microphone: "denied"
};

const UNAVAILABLE_PERMISSIONS: PermissionStateSummary = {
  camera: "unavailable",
  microphone: "unavailable"
};

const ACTIVE_TRANSCRIPTS: readonly TranscriptEntry[] = [
  {
    id: "tr-1",
    role: "user",
    text: "Is this my evening pill?",
    final: true,
    ts: FIXED_ACCEPTED_MS - 4000
  },
  {
    id: "tr-2",
    role: "assistant",
    text: "Hold steady for a moment while I check Amlodipine 5 mg.",
    final: false,
    ts: FIXED_ACCEPTED_MS - 2000
  }
];

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.89 },
    allergens: { value: [], confidence: 0.93 },
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

const MATCH_VERDICT: Verdict = makeVerdict();

const WARNING_NSAID_VERDICT: Verdict = makeVerdict({
  level: "warning",
  headline: "Stop: Ibuprofen 400 mg is an NSAID on your avoid list",
  speech: "Stop. Ibuprofen 400 mg conflicts with your NSAID avoid rule.",
  matchedMedId: undefined,
  takenToday: undefined,
  reasons: ["Ibuprofen is in the NSAID class on your avoid list"],
  read: makeLabelRead({
    product: { value: "Ibuprofen", confidence: 0.97 },
    ingredient: { value: "ibuprofen", confidence: 0.98 },
    strength: { value: "400 mg", confidence: 0.96 }
  })
});

const DOUBLE_DOSE_WARNING_VERDICT: Verdict = makeVerdict({
  level: "warning",
  headline: "Warning: Amlodipine 5 mg already logged today",
  speech: "Hold on. You already logged Amlodipine 5 mg today.",
  matchedMedId: "aml",
  takenToday: true,
  reasons: ["Dose already logged earlier today"]
});

const BLOCKED_UNSURE_VERDICT: Verdict = makeVerdict({
  level: "unsure",
  headline: "Cannot verify dose safely",
  speech: "Strength text is blurry. Please hold closer in brighter light or ask a pharmacist.",
  matchedMedId: undefined,
  takenToday: undefined,
  reasons: ["Strength confidence below 80% never-guess threshold"],
  read: makeLabelRead({
    kind: "unreadable",
    product: { value: "", confidence: 0.35 },
    ingredient: { value: null, confidence: 0.2 },
    strength: { value: null, confidence: 0.28 },
    dosing: { value: null, confidence: 0.15 },
    expiry: { value: null, confidence: 0.18 },
    allergens: { value: null, confidence: 0.12 },
    barcode: { value: null, confidence: 0 },
    readability: 0
  })
});

const INFO_FOOD_VERDICT: Verdict = makeVerdict({
  level: "info",
  headline: "Oat drink: no listed nut allergens",
  speech: "Oat drink. Declared allergens: gluten, oats. Best before August 2027.",
  matchedMedId: undefined,
  takenToday: undefined,
  reasons: ["No peanut or tree-nut allergen declared"],
  read: makeLabelRead({
    kind: "food",
    product: { value: "Nordic Oat Drink", confidence: 0.95 },
    ingredient: { value: "oat base", confidence: 0.92 },
    strength: { value: null, confidence: 0.9 },
    dosing: { value: null, confidence: 0.9 },
    allergens: { value: ["oats", "gluten"], confidence: 0.94 }
  })
});

const NOMINAL_SNAPSHOT: SessionSnapshot = {
  sessionId: "hup88a12",
  mode: "live",
  liveState: "open",
  activeModel: "gemini-3.8-live",
  checking: false,
  coach: { cue: "ok", text: "Label in view" },
  verdict: MATCH_VERDICT,
  transcripts: [...ACTIVE_TRANSCRIPTS],
  device: STREAMING_GLASSES_DEVICE,
  hudConnected: true,
  network: {
    online: true,
    rttMs: 78,
    targetFps: 1,
    jpegQuality: 0.8
  },
  permissions: GRANTED_PERMISSIONS,
  cameraActive: true,
  autoStopRemainingSec: 39,
  lastError: null
};

const FAULTED_SNAPSHOT: SessionSnapshot = {
  sessionId: "hup88a12",
  mode: "offline",
  liveState: "degraded",
  activeModel: null,
  checking: true,
  coach: null,
  verdict: BLOCKED_UNSURE_VERDICT,
  transcripts: [],
  device: DOFFED_LOW_BATTERY_DEVICE,
  hudConnected: false,
  network: {
    online: false,
    rttMs: null,
    targetFps: 0.25,
    jpegQuality: 45
  },
  permissions: DENIED_PERMISSIONS,
  cameraActive: false,
  autoStopRemainingSec: null,
  lastError: {
    code: "WS_OFFLINE_FALLBACK",
    message: "Live WebSocket unreachable; switched to local barcode mode.",
    recoverable: true
  }
};

interface OpeningTagMatch {
  tagName: string;
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
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&apos;/g, "'")
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

function extractAllOpeningTags(html: string): OpeningTagMatch[] {
  const results: OpeningTagMatch[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt + 1 >= html.length) {
      break;
    }

    const nextCh = html[lt + 1];
    if (nextCh === SLASH || nextCh === "!" || nextCh === "?") {
      let skipPos = lt + 2;
      while (skipPos < html.length && html[skipPos] !== ">") {
        skipPos += 1;
      }
      i = skipPos + 1;
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
    const selfClosing = rawTag.slice(0, -1).trimEnd().endsWith(SLASH);
    results.push({
      tagName: parsedTagName,
      tag: rawTag,
      start: lt,
      end: pos + 1,
      selfClosing
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
      i = pos + 1;
    }
  }

  return results;
}

function extractOpeningTags(html: string, tagName: string): OpeningTagMatch[] {
  const lowerTarget = tagName.toLowerCase();
  return extractAllOpeningTags(html).filter((entry) => entry.tagName === lowerTarget);
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

function collectAllIds(html: string, label: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of extractAllOpeningTags(html)) {
    const rawId = getAttr(entry.tag, "id");
    if (rawId !== null) {
      const trimmed = rawId.trim();
      assert.ok(trimmed.length > 0, `${label}: empty id attribute on ${entry.tag}`);
      assert.equal(ids.has(trimmed), false, `${label}: duplicate id="${trimmed}" in SSR HTML`);
      ids.add(trimmed);
    }
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
  landmarkKind?: "section" | "dialog" | "region" | "alert";
  expectsHeading: boolean;
  expectsProgressbar?: boolean;
  minButtons?: number;
  minSvgs?: number;
}

function assertMarkupContracts(html: string, options: AuditOptions): void {
  const {
    label,
    landmarkKind,
    expectsHeading,
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

  const sectionTags = allOpeningTags.filter((m) => m.tagName === "section").map((m) => m.tag);
  const dialogTags = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "dialog")
    .map((m) => m.tag);
  const regionTags = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "region")
    .map((m) => m.tag);
  const alertTags = allOpeningTags
    .filter((m) => getAttr(m.tag, "role") === "alert")
    .map((m) => m.tag);

  const candidateLandmarks = [...sectionTags, ...dialogTags, ...regionTags, ...alertTags];
  assert.ok(
    candidateLandmarks.length > 0,
    `${label}: expected at least one semantic landmark (<section>, role="dialog", role="region", or role="alert")`
  );

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

  const labeledLandmarks = candidateLandmarks.filter((tag) => {
    if (getAttr(tag, "role") === "alert") {
      return true;
    }
    const ariaLabel = (getAttr(tag, "aria-label") ?? "").trim();
    const ariaLabelledBy = (getAttr(tag, "aria-labelledby") ?? "").trim();
    return ariaLabel.length > 0 || ariaLabelledBy.length > 0;
  });

  assert.ok(
    labeledLandmarks.length > 0,
    `${label}: expected semantic landmark with accessible name or alert role`
  );

  if (landmarkKind === "section") {
    const accessibleSections = sectionTags.filter((tag) => {
      const ariaLabel = (getAttr(tag, "aria-label") ?? "").trim();
      const ariaLabelledBy = (getAttr(tag, "aria-labelledby") ?? "").trim();
      return ariaLabel.length > 0 || ariaLabelledBy.length > 0;
    });
    assert.ok(
      accessibleSections.length > 0,
      `${label}: expected <section> landmark with non-empty aria-label or aria-labelledby`
    );
  } else if (landmarkKind === "dialog") {
    assert.ok(dialogTags.length > 0, `${label}: expected role="dialog" landmark`);
  } else if (landmarkKind === "region") {
    assert.ok(regionTags.length > 0, `${label}: expected role="region" landmark`);
  } else if (landmarkKind === "alert") {
    assert.ok(alertTags.length > 0, `${label}: expected role="alert" landmark`);
  }

  for (const entry of allOpeningTags) {
    for (const refAttr of ["aria-labelledby", "aria-describedby"]) {
      const rawRefs = getAttr(entry.tag, refAttr);
      if (rawRefs !== null && rawRefs.trim().length > 0) {
        for (const refId of rawRefs.trim().split(/\s+/)) {
          assert.ok(
            allIds.has(refId),
            `${label}: ${refAttr} on <${entry.tagName}> references missing id="${refId}"`
          );
        }
      }
    }
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

    if (expectsProgressbar) {
      const valueText = (getAttr(barTag, "aria-valuetext") ?? "").trim();
      assert.ok(
        valueText.length > 0,
        `${label}: FrameReadinessMeter role="progressbar" must expose non-empty aria-valuetext`
      );
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

  const svgTags = allOpeningTags.filter((m) => m.tagName === "svg").map((m) => m.tag);
  if (minSvgs !== undefined) {
    assert.ok(
      svgTags.length >= minSvgs,
      `${label}: expected >= ${minSvgs} <svg> elements, got ${svgTags.length}`
    );
  }
  for (const svgTag of svgTags) {
    const ariaHidden = getAttr(svgTag, "aria-hidden");
    const role = getAttr(svgTag, "role");
    const ariaLabel = getAttr(svgTag, "aria-label");
    const validHidden = ariaHidden === "true";
    const validImg = role === "img" && ariaLabel !== null && ariaLabel.trim().length > 0;
    assert.ok(
      validHidden || validImg,
      `${label}: <svg> must declare aria-hidden="true" or role="img" + non-empty aria-label: ${svgTag}`
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
    const hasTouchTargetMinHeight = minHeightPx !== null && minHeightPx >= 48;

    assert.ok(
      hasBtnClass || hasTouchTargetMinHeight,
      `${label}: <button> must use .btn class or min-height >= 48px: ${btn.openTag}`
    );
    if (minHeightPx !== null) {
      assert.ok(
        minHeightPx >= 48,
        `${label}: <button> inline min-height ${minHeightPx}px is below 48px touch target minimum`
      );
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
}

type LocaleBehavior = "ui-en-fi-sv" | "consent-en-fi" | "lang-attr" | "profile-select" | "lang-independent";

interface CoreWave8Spec {
  name: string;
  landmarkKind: "section" | "dialog" | "region" | "alert";
  expectsHeading: boolean;
  expectsProgressbar?: boolean;
  localeBehavior: LocaleBehavior;
  minButtons: number;
  minSvgs: number;
  render: (lang: AuditLocale) => ReactElement;
}

const hudPairingUrl = buildHudUrl(HTTPS_ORIGIN, NOMINAL_SNAPSHOT.sessionId);
const bridgePairingLink = buildBridgeDeepLink(HTTPS_ORIGIN, NOMINAL_SNAPSHOT.sessionId);
const sampleHudQrSvg = encodeQrSvg(hudPairingUrl, { title: "Ray-Ban Display HUD QR" });
const sampleBridgeQrSvg = encodeQrSvg(bridgePairingLink, { title: "Android DAT Bridge QR" });

const ALL_TEN_CORE_AND_WAVE8_SPECS: readonly CoreWave8Spec[] = [
  {
    name: "EmergencyMedCard",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv",
    minButtons: 2,
    minSvgs: 6,
    render: (lang) =>
      createElement(EmergencyMedCard, {
        profile: ACTIVE_PROFILE,
        lang,
        onCopyText: noopText,
        onPrint: noop
      })
  },
  {
    name: "FrameReadinessMeter",
    landmarkKind: "section",
    expectsHeading: true,
    expectsProgressbar: true,
    localeBehavior: "ui-en-fi-sv",
    minButtons: 0,
    minSvgs: 2,
    render: (lang) =>
      createElement(FrameReadinessMeter, {
        cameraActive: true,
        checking: false,
        sharpness: 0.88,
        bufferedFrames: 3,
        coach: { cue: "ok" },
        lang
      })
  },
  {
    name: "PrivacyFlowCard",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv",
    minButtons: 2,
    minSvgs: 4,
    render: (lang) =>
      createElement(PrivacyFlowCard, {
        profile: ACTIVE_PROFILE,
        consent: ACCEPTED_CONSENT,
        cameraActive: true,
        autoStopRemainingSec: 38,
        device: STREAMING_GLASSES_DEVICE,
        lang,
        onOpenPrivacyModal: noop,
        onWipeAll: noop
      })
  },
  {
    name: "ConsentOnboarding",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "consent-en-fi",
    minButtons: 3,
    minSvgs: 0,
    render: (lang) =>
      createElement(ConsentOnboarding, {
        lang,
        consent: PENDING_CONSENT,
        profileMedCount: 3,
        isModal: false,
        onAccept: noop,
        onResetDemoProfile: noop,
        onWipeAllData: noop
      })
  },
  {
    name: "VerdictCard",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "lang-attr",
    minButtons: 2,
    minSvgs: 3,
    render: (lang) =>
      createElement(VerdictCard, {
        verdict: MATCH_VERDICT,
        checking: false,
        mode: "live",
        lang,
        onLogDose: noopOptionalMedId,
        onRepeat: noop
      })
  },
  {
    name: "ProfileManager",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "profile-select",
    minButtons: 30,
    minSvgs: 1,
    render: (lang) =>
      createElement(ProfileManager, {
        profile: { ...ACTIVE_PROFILE, lang },
        onChange: noopProfile,
        onResetDemo: noop,
        onUndoLastDose: noop,
        caregiverSummaryText: "HoldUp caregiver adherence summary: Metformin 500 mg logged at 08:15.",
        onOpenPharmacyImport: noop
      })
  },
  {
    name: "ViewfinderStage",
    landmarkKind: "section",
    expectsHeading: false,
    localeBehavior: "lang-attr",
    minButtons: 13,
    minSvgs: 8,
    render: (lang) =>
      createElement(ViewfinderStage, {
        cameraActive: true,
        source: "demo",
        onChangeSource: noopSource,
        mode: "live",
        coach: { cue: "rotate_left", text: "" },
        checking: false,
        autoStopRemainingSec: 41,
        glassesConnected: true,
        glassesWorn: true,
        videoRef: nullVideoRef,
        demoImgRef: nullImgRef,
        scenarios: DEMO_SCENARIOS,
        activeScenarioId: "amlodipine_match",
        onSelectScenario: noopScenario,
        onStart: noop,
        onStop: noop,
        onSnapshotVerify: noop,
        onOfflineBarcodeScan: noop,
        lang
      })
  },
  {
    name: "DeviceResiliencePanel",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "lang-independent",
    minButtons: 7,
    minSvgs: 0,
    render: (_lang) =>
      createElement(DeviceResiliencePanel, {
        snapshot: NOMINAL_SNAPSHOT,
        chaos: NO_CHAOS,
        onChangeChaos: noopChaos,
        serverOrigin: HTTPS_ORIGIN,
        hudUrl: hudPairingUrl,
        bridgeLink: bridgePairingLink,
        hudQrSvg: sampleHudQrSvg,
        bridgeQrSvg: sampleBridgeQrSvg
      })
  },
  {
    name: "PermissionBanner",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "lang-independent",
    minButtons: 5,
    minSvgs: 3,
    render: (_lang) =>
      createElement(PermissionBanner, {
        permissions: DENIED_PERMISSIONS,
        currentSource: "phone",
        lastError: {
          code: "WS_RETRYING",
          message: "Live coaching connection dropped; Snapshot fallback active.",
          recoverable: true
        },
        onUseSnapshotMode: noop,
        onUseDemoProps: noop,
        onRetryPermissions: noop,
        onDismissError: noop
      })
  },
  {
    name: "ConversationBar",
    landmarkKind: "section",
    expectsHeading: true,
    localeBehavior: "ui-en-fi-sv",
    minButtons: 5,
    minSvgs: 0,
    render: (lang) =>
      createElement(ConversationBar, {
        transcripts: ACTIVE_TRANSCRIPTS,
        mode: "live",
        disabled: false,
        lang,
        onSubmitQuestion: noopText
      })
  }
];

test("All 10 core and Wave-8 HoldUp components pass landmark, ARIA target ID, progressbar, artifact, SVG, and >= 48px touch-target SSR audit across en, fi, sv, and de", () => {
  assert.equal(ALL_TEN_CORE_AND_WAVE8_SPECS.length, 10);

  const renderedByComponent = new Map<string, Record<AuditLocale, string>>();

  for (const spec of ALL_TEN_CORE_AND_WAVE8_SPECS) {
    const byLocale = {} as Record<AuditLocale, string>;

    for (const locale of AUDIT_LOCALES) {
      const html = renderToStaticMarkup(spec.render(locale));
      byLocale[locale] = html;

      assertMarkupContracts(html, {
        label: `${spec.name}[${locale}]`,
        landmarkKind: spec.landmarkKind,
        expectsHeading: spec.expectsHeading,
        expectsProgressbar: spec.expectsProgressbar,
        minButtons: spec.minButtons,
        minSvgs: spec.minSvgs
      });
    }

    renderedByComponent.set(spec.name, byLocale);

    if (spec.localeBehavior === "ui-en-fi-sv") {
      assert.notEqual(byLocale.en, byLocale.fi, `${spec.name}: expected distinct en and fi SSR markup`);
      assert.notEqual(byLocale.en, byLocale.sv, `${spec.name}: expected distinct en and sv SSR markup`);
      assert.notEqual(byLocale.fi, byLocale.sv, `${spec.name}: expected distinct fi and sv SSR markup`);
      assert.equal(
        byLocale.de,
        byLocale.en,
        `${spec.name}: expected fallback locale "de" to normalize cleanly to "en"`
      );
    } else if (spec.localeBehavior === "consent-en-fi") {
      assert.notEqual(byLocale.en, byLocale.fi, `${spec.name}: expected distinct en and fi SSR markup`);
      assert.equal(byLocale.sv, byLocale.en, `${spec.name}: expected sv to resolve to en bundle`);
      assert.equal(byLocale.de, byLocale.en, `${spec.name}: expected de to resolve to en bundle`);
    } else if (spec.localeBehavior === "lang-attr") {
      assert.ok(byLocale.en.includes('lang="en"'), `${spec.name}: expected lang="en"`);
      assert.ok(byLocale.fi.includes('lang="fi"'), `${spec.name}: expected lang="fi"`);
      assert.ok(byLocale.sv.includes('lang="sv"'), `${spec.name}: expected lang="sv"`);
      assert.ok(byLocale.de.includes('lang="de"'), `${spec.name}: expected lang="de"`);
      if (spec.name === "ViewfinderStage") {
        assert.notEqual(
          stripTagsToText(byLocale.en),
          stripTagsToText(byLocale.fi),
          "ViewfinderStage: expected localized coaching cue text between en and fi"
        );
        assert.notEqual(
          stripTagsToText(byLocale.en),
          stripTagsToText(byLocale.sv),
          "ViewfinderStage: expected localized coaching cue text between en and sv"
        );
        assert.equal(
          stripTagsToText(byLocale.de),
          stripTagsToText(byLocale.en),
          "ViewfinderStage: expected fallback de coaching cue text to match en"
        );
      }
    } else if (spec.localeBehavior === "profile-select") {
      for (const locale of AUDIT_LOCALES) {
        const optionTags = extractOpeningTags(byLocale[locale], "option");
        const selectedOption = optionTags.find((opt) => getAttr(opt.tag, "selected") !== null);
        assert.ok(selectedOption !== undefined, `ProfileManager[${locale}]: expected selected <option>`);
        assert.equal(getAttr(selectedOption.tag, "value"), locale);
      }
    }
  }

  assert.equal(renderedByComponent.size, 10);
});

test("Edge, null, empty, active, warning, blocked, modal, and denied states across all 10 components uphold every WCAG SSR invariant across en, fi, sv, and de", () => {
  const tenTranscripts: TranscriptEntry[] = Array.from({ length: 10 }, (_, idx) => ({
    id: `roll-${idx + 1}`,
    role: idx % 2 === 0 ? "user" : "assistant",
    text: `Turn ${idx + 1} verified transcript line`,
    final: idx < 9,
    ts: FIXED_ACCEPTED_MS + idx * 1000
  }));

  for (const locale of AUDIT_LOCALES) {
    const emptyWalletHtml = renderToStaticMarkup(
      createElement(EmergencyMedCard, {
        profile: EMPTY_PROFILE,
        lang: locale
      })
    );
    assertMarkupContracts(emptyWalletHtml, {
      label: `EmergencyMedCard-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 2,
      minSvgs: 6
    });

    const dashSanitizedProfile: Profile = {
      meds: [
        {
          id: "prn-paracetamol",
          name: `Panadol${EM_DASH}Zapp`,
          ingredient: `paracetamol${EN_DASH}hemihydrate`,
          strength: "500 mg",
          schedule: ["as needed"],
          notes: `Max 3 tablets${EM_DASH}per day${EN_DASH}with water`
        }
      ],
      allergies: [`peanut${EM_DASH}trace`],
      avoid: [`NSAIDs${EN_DASH}oral`],
      doseLog: [],
      lang: locale
    };
    const sanitizedWalletHtml = renderToStaticMarkup(
      createElement(EmergencyMedCard, {
        profile: dashSanitizedProfile,
        lang: locale
      })
    );
    assertMarkupContracts(sanitizedWalletHtml, {
      label: `EmergencyMedCard-sanitized-prn[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 2,
      minSvgs: 6
    });

    const readinessVariants: ReadonlyArray<{
      tag: string;
      cameraActive: boolean;
      checking: boolean;
      sharpness: number | null;
      bufferedFrames: number;
      coach: { cue: CoachCue; text?: string } | null;
      expectedValueNow: number;
    }> = [
      {
        tag: "standby-null",
        cameraActive: false,
        checking: false,
        sharpness: null,
        bufferedFrames: 0,
        coach: null,
        expectedValueNow: 0
      },
      {
        tag: "coaching-below-threshold",
        cameraActive: true,
        checking: false,
        sharpness: 0.219,
        bufferedFrames: 1,
        coach: { cue: "more_light" },
        expectedValueNow: 21
      },
      {
        tag: "verifying-burst",
        cameraActive: true,
        checking: true,
        sharpness: 0.93,
        bufferedFrames: 2,
        coach: { cue: "hold_still" },
        expectedValueNow: 93
      },
      {
        tag: "nan-clamped",
        cameraActive: true,
        checking: false,
        sharpness: Number.NaN,
        bufferedFrames: Number.NaN,
        coach: null,
        expectedValueNow: 0
      },
      {
        tag: "infinity-clamped",
        cameraActive: true,
        checking: false,
        sharpness: Number.POSITIVE_INFINITY,
        bufferedFrames: Number.POSITIVE_INFINITY,
        coach: { cue: "ok" },
        expectedValueNow: 100
      }
    ];

    for (const rv of readinessVariants) {
      const meterHtml = renderToStaticMarkup(
        createElement(FrameReadinessMeter, {
          cameraActive: rv.cameraActive,
          checking: rv.checking,
          sharpness: rv.sharpness,
          bufferedFrames: rv.bufferedFrames,
          coach: rv.coach,
          lang: locale
        })
      );
      assertMarkupContracts(meterHtml, {
        label: `FrameReadinessMeter-${rv.tag}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        expectsProgressbar: true,
        minButtons: 0,
        minSvgs: 2
      });
      const bar = extractAllOpeningTags(meterHtml).find(
        (m) => getAttr(m.tag, "role") === "progressbar"
      );
      assert.ok(bar !== undefined);
      assert.equal(getAttr(bar.tag, "aria-valuenow"), String(rv.expectedValueNow));
      assert.equal(getAttr(bar.tag, "aria-valuemin"), "0");
      assert.equal(getAttr(bar.tag, "aria-valuemax"), "100");
    }

    for (const cue of ALL_COACH_CUES) {
      const cueMeterHtml = renderToStaticMarkup(
        createElement(FrameReadinessMeter, {
          cameraActive: true,
          checking: false,
          sharpness: 0.34,
          bufferedFrames: 2,
          coach: { cue },
          lang: locale
        })
      );
      assertMarkupContracts(cueMeterHtml, {
        label: `FrameReadinessMeter-cue-${cue}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        expectsProgressbar: true,
        minButtons: 0,
        minSvgs: 2
      });
    }

    const pendingPrivacyHtml = renderToStaticMarkup(
      createElement(PrivacyFlowCard, {
        profile: EMPTY_PROFILE,
        consent: null,
        cameraActive: false,
        autoStopRemainingSec: null,
        device: IDLE_PHONE_DEVICE,
        lang: locale
      })
    );
    assertMarkupContracts(pendingPrivacyHtml, {
      label: `PrivacyFlowCard-pending-idle[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 0,
      minSvgs: 4
    });

    const nanCountdownPrivacyHtml = renderToStaticMarkup(
      createElement(PrivacyFlowCard, {
        profile: ACTIVE_PROFILE,
        consent: PENDING_CONSENT,
        cameraActive: true,
        autoStopRemainingSec: Number.NaN,
        device: DOFFED_LOW_BATTERY_DEVICE,
        lang: locale,
        onOpenPrivacyModal: noop
      })
    );
    assertMarkupContracts(nanCountdownPrivacyHtml, {
      label: `PrivacyFlowCard-nan-countdown[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 4
    });

    const modalConsentHtml = renderToStaticMarkup(
      createElement(ConsentOnboarding, {
        lang: locale,
        consent: ACCEPTED_CONSENT,
        profileMedCount: 1,
        isModal: true,
        onAccept: noop,
        onClose: noop,
        onResetDemoProfile: noop,
        onWipeAllData: noop
      })
    );
    assertMarkupContracts(modalConsentHtml, {
      label: `ConsentOnboarding-modal[${locale}]`,
      landmarkKind: "dialog",
      expectsHeading: true,
      minButtons: 4,
      minSvgs: 0
    });

    const zeroMedModalConsentHtml = renderToStaticMarkup(
      createElement(ConsentOnboarding, {
        lang: locale,
        consent: { accepted: true, acceptedAt: Number.NaN, version: "1.0" },
        profileMedCount: Number.NaN,
        isModal: true,
        onAccept: noop,
        onResetDemoProfile: noop,
        onWipeAllData: noop
      })
    );
    assertMarkupContracts(zeroMedModalConsentHtml, {
      label: `ConsentOnboarding-modal-nan[${locale}]`,
      landmarkKind: "dialog",
      expectsHeading: true,
      minButtons: 3,
      minSvgs: 0
    });

    for (const mode of ["live", "snapshot", "offline"] as readonly TransportMode[]) {
      const readyVerdictHtml = renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict: null,
          checking: false,
          mode,
          lang: locale,
          onLogDose: noopOptionalMedId,
          onRepeat: noop
        })
      );
      assertMarkupContracts(readyVerdictHtml, {
        label: `VerdictCard-null-ready-${mode}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        minButtons: 0,
        minSvgs: 1
      });
    }

    const checkingNullVerdictHtml = renderToStaticMarkup(
      createElement(VerdictCard, {
        verdict: null,
        checking: true,
        mode: "live",
        lang: locale,
        onLogDose: noopOptionalMedId,
        onRepeat: noop
      })
    );
    assertMarkupContracts(checkingNullVerdictHtml, {
      label: `VerdictCard-null-checking[${locale}]`,
      landmarkKind: "section",
      expectsHeading: false,
      minButtons: 0,
      minSvgs: 1
    });

    const verdictCases: ReadonlyArray<{
      tag: string;
      verdict: Verdict;
      checking: boolean;
      mode: TransportMode;
      minSvgs: number;
      expectDisabledLog: boolean;
    }> = [
      {
        tag: "warning-nsaid",
        verdict: WARNING_NSAID_VERDICT,
        checking: false,
        mode: "live",
        minSvgs: 3,
        expectDisabledLog: true
      },
      {
        tag: "warning-double-dose",
        verdict: DOUBLE_DOSE_WARNING_VERDICT,
        checking: false,
        mode: "snapshot",
        minSvgs: 3,
        expectDisabledLog: true
      },
      {
        tag: "blocked-unsure-below-80",
        verdict: BLOCKED_UNSURE_VERDICT,
        checking: true,
        mode: "snapshot",
        minSvgs: 5,
        expectDisabledLog: true
      },
      {
        tag: "info-food",
        verdict: INFO_FOOD_VERDICT,
        checking: false,
        mode: "offline",
        minSvgs: 3,
        expectDisabledLog: true
      }
    ];

    for (const vc of verdictCases) {
      const vHtml = renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict: vc.verdict,
          checking: vc.checking,
          mode: vc.mode,
          lang: locale,
          onLogDose: noopOptionalMedId,
          onRepeat: noop
        })
      );
      assertMarkupContracts(vHtml, {
        label: `VerdictCard-${vc.tag}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: true,
        minButtons: 2,
        minSvgs: vc.minSvgs
      });
      const meters = extractOpeningTags(vHtml, "meter");
      assert.equal(meters.length, 8);
      for (const meter of meters) {
        assert.ok((getAttr(meter.tag, "aria-label") ?? "").trim().length > 0);
      }
      if (vc.expectDisabledLog) {
        const logBtn = extractElements(vHtml, "button")[0];
        assert.notEqual(getAttr(logBtn.openTag, "disabled"), null);
        assert.equal(getAttr(logBtn.openTag, "aria-disabled"), "true");
      }
    }

    const emptyProfileManagerHtml = renderToStaticMarkup(
      createElement(ProfileManager, {
        profile: { ...EMPTY_PROFILE, lang: locale === "de" ? "xx" : locale },
        onChange: noopProfile,
        onResetDemo: noop,
        onUndoLastDose: noop,
        caregiverSummaryText: ""
      })
    );
    assertMarkupContracts(emptyProfileManagerHtml, {
      label: `ProfileManager-empty[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 21,
      minSvgs: 1
    });
    assert.ok(
      extractOpeningTags(emptyProfileManagerHtml, "div").some(
        (d) => getAttr(d.tag, "role") === "region" && (getAttr(d.tag, "aria-label") ?? "").length > 0
      ),
      `ProfileManager-empty[${locale}]: expected privacy banner role="region"`
    );
    if (locale === "de") {
      const selectedOpt = extractOpeningTags(emptyProfileManagerHtml, "option").find(
        (o) => getAttr(o.tag, "selected") !== null
      );
      assert.equal(getAttr(selectedOpt?.tag ?? "", "value"), "en");
    }

    const phoneStandbyViewfinderHtml = renderToStaticMarkup(
      createElement(ViewfinderStage, {
        cameraActive: false,
        source: "phone",
        onChangeSource: noopSource,
        mode: "snapshot",
        coach: null,
        checking: false,
        autoStopRemainingSec: null,
        glassesConnected: false,
        glassesWorn: false,
        videoRef: nullVideoRef,
        demoImgRef: nullImgRef,
        scenarios: [],
        activeScenarioId: "amlodipine_match",
        onSelectScenario: noopScenario,
        onStart: noop,
        onStop: noop,
        onSnapshotVerify: noop,
        onOfflineBarcodeScan: noop,
        lang: locale
      })
    );
    assertMarkupContracts(phoneStandbyViewfinderHtml, {
      label: `ViewfinderStage-phone-standby[${locale}]`,
      landmarkKind: "section",
      expectsHeading: false,
      minButtons: 6,
      minSvgs: 9
    });
    const phoneVideo = extractOpeningTags(phoneStandbyViewfinderHtml, "video")[0];
    assert.ok((getAttr(phoneVideo.tag, "aria-label") ?? "").trim().length > 0);

    for (const cue of ALL_COACH_CUES) {
      const glassesViewfinderHtml = renderToStaticMarkup(
        createElement(ViewfinderStage, {
          cameraActive: cue === "ok",
          source: "glasses",
          onChangeSource: noopSource,
          mode: cue === "other_side" ? "offline" : "live",
          coach: { cue, text: "" },
          checking: cue === "hold_still",
          autoStopRemainingSec: cue === "ok" ? 27 : null,
          glassesConnected: cue !== "more_light",
          glassesWorn: cue === "ok" || cue === "hold_still",
          videoRef: nullVideoRef,
          demoImgRef: nullImgRef,
          scenarios: DEMO_SCENARIOS,
          activeScenarioId: "back_of_box",
          onSelectScenario: noopScenario,
          onStart: noop,
          onStop: noop,
          onSnapshotVerify: noop,
          onOfflineBarcodeScan: noop,
          lang: locale
        })
      );
      assertMarkupContracts(glassesViewfinderHtml, {
        label: `ViewfinderStage-glasses-${cue}[${locale}]`,
        landmarkKind: "section",
        expectsHeading: false,
        minButtons: 6,
        minSvgs: 9
      });
    }

    const faultedResilienceHtml = renderToStaticMarkup(
      createElement(DeviceResiliencePanel, {
        snapshot: FAULTED_SNAPSHOT,
        chaos: ALL_CHAOS,
        onChangeChaos: noopChaos,
        serverOrigin: ""
      })
    );
    assertMarkupContracts(faultedResilienceHtml, {
      label: `DeviceResiliencePanel-faulted[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 8,
      minSvgs: 0
    });
    assert.ok(
      extractOpeningTags(faultedResilienceHtml, "div").some(
        (d) => getAttr(d.tag, "role") === "alert"
      ),
      `DeviceResiliencePanel-faulted[${locale}]: expected role="alert" banner for lastError`
    );

    const nonRecoverableResilienceHtml = renderToStaticMarkup(
      createElement(DeviceResiliencePanel, {
        snapshot: {
          ...FAULTED_SNAPSHOT,
          lastError: {
            code: "CAMERA_NOT_FOUND",
            message: "No camera hardware detected.",
            recoverable: false
          }
        },
        chaos: { ...NO_CHAOS, forceWsDrop: true },
        onChangeChaos: noopChaos,
        serverOrigin: HTTPS_ORIGIN
      })
    );
    assertMarkupContracts(nonRecoverableResilienceHtml, {
      label: `DeviceResiliencePanel-nonrecoverable[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 8,
      minSvgs: 0
    });

    assert.equal(
      renderToStaticMarkup(
        createElement(PermissionBanner, {
          permissions: GRANTED_PERMISSIONS,
          currentSource: "phone",
          lastError: null,
          onUseSnapshotMode: noop,
          onUseDemoProps: noop,
          onRetryPermissions: noop
        })
      ),
      ""
    );

    assert.equal(
      renderToStaticMarkup(
        createElement(PermissionBanner, {
          permissions: { camera: "denied", microphone: "prompt" },
          currentSource: "demo",
          lastError: null,
          onUseSnapshotMode: noop,
          onUseDemoProps: noop,
          onRetryPermissions: noop
        })
      ),
      ""
    );

    const unavailablePermissionHtml = renderToStaticMarkup(
      createElement(PermissionBanner, {
        permissions: UNAVAILABLE_PERMISSIONS,
        currentSource: "phone",
        lastError: {
          code: "NET_TIMEOUT",
          message: "Verification request timed out.",
          recoverable: false
        },
        onUseSnapshotMode: noop,
        onUseDemoProps: noop,
        onRetryPermissions: noop
      })
    );
    assertMarkupContracts(unavailablePermissionHtml, {
      label: `PermissionBanner-unavailable[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 4,
      minSvgs: 3
    });

    const errorOnlyPermissionHtml = renderToStaticMarkup(
      createElement(PermissionBanner, {
        permissions: GRANTED_PERMISSIONS,
        currentSource: "glasses",
        lastError: {
          code: "HUD_RECONNECT",
          message: "HUD socket reconnecting.",
          recoverable: true
        },
        onUseSnapshotMode: noop,
        onUseDemoProps: noop,
        onRetryPermissions: noop
      })
    );
    assertMarkupContracts(errorOnlyPermissionHtml, {
      label: `PermissionBanner-error-only[${locale}]`,
      landmarkKind: "alert",
      expectsHeading: true,
      minButtons: 1,
      minSvgs: 1
    });

    const emptyConversationHtml = renderToStaticMarkup(
      createElement(ConversationBar, {
        transcripts: [],
        mode: "snapshot",
        disabled: false,
        lang: locale,
        onSubmitQuestion: noopText
      })
    );
    assertMarkupContracts(emptyConversationHtml, {
      label: `ConversationBar-empty-snapshot[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 5,
      minSvgs: 0
    });

    const disabledConversationHtml = renderToStaticMarkup(
      createElement(ConversationBar, {
        transcripts: tenTranscripts,
        mode: "offline",
        disabled: true,
        lang: locale,
        onSubmitQuestion: noopText
      })
    );
    assertMarkupContracts(disabledConversationHtml, {
      label: `ConversationBar-disabled-offline[${locale}]`,
      landmarkKind: "section",
      expectsHeading: true,
      minButtons: 5,
      minSvgs: 0
    });
    assert.equal(extractElements(disabledConversationHtml, "li").length, 8);
  }
});

test("Form controls, radiogroups, QR images, and live regions across core and Wave-8 surfaces maintain strict screen-reader parity", () => {
  for (const locale of AUDIT_LOCALES) {
    const profileHtml = renderToStaticMarkup(
      createElement(ProfileManager, {
        profile: { ...ACTIVE_PROFILE, lang: locale },
        onChange: noopProfile,
        onResetDemo: noop,
        onUndoLastDose: noop,
        caregiverSummaryText: "Summary ready",
        onOpenPharmacyImport: noop
      })
    );
    const labelForIds = new Set(
      extractOpeningTags(profileHtml, "label")
        .map((l) => getAttr(l.tag, "for") ?? "")
        .filter((v) => v.length > 0)
    );
    const selectTag = extractOpeningTags(profileHtml, "select")[0];
    assert.ok(labelForIds.has(getAttr(selectTag.tag, "id") ?? ""));
    assert.ok((parseMinHeightPx(getAttr(selectTag.tag, "style")) ?? 0) >= 48);

    const textInputs = extractOpeningTags(profileHtml, "input").filter(
      (inp) => getAttr(inp.tag, "type") === "text"
    );
    assert.equal(textInputs.length, 6);
    for (const inp of textInputs) {
      assert.ok(labelForIds.has(getAttr(inp.tag, "id") ?? ""));
      assert.ok((parseMinHeightPx(getAttr(inp.tag, "style")) ?? 0) >= 48);
    }

    const conversationHtml = renderToStaticMarkup(
      createElement(ConversationBar, {
        transcripts: ACTIVE_TRANSCRIPTS,
        mode: "live",
        disabled: false,
        lang: locale,
        onSubmitQuestion: noopText
      })
    );
    const convInput = extractOpeningTags(conversationHtml, "input")[0];
    const convLabels = extractOpeningTags(conversationHtml, "label");
    assert.ok(convLabels.some((l) => getAttr(l.tag, "for") === getAttr(convInput.tag, "id")));
    assert.ok((parseMinHeightPx(getAttr(convInput.tag, "style")) ?? 0) >= 48);
    assert.ok(
      extractOpeningTags(conversationHtml, "div").some(
        (d) =>
          getAttr(d.tag, "role") === "log" &&
          getAttr(d.tag, "aria-live") === "polite" &&
          (getAttr(d.tag, "aria-label") ?? "").trim().length > 0
      )
    );

    const viewfinderDemoHtml = renderToStaticMarkup(
      ALL_TEN_CORE_AND_WAVE8_SPECS.find((s) => s.name === "ViewfinderStage")!.render(locale)
    );
    const radioButtons = extractElements(viewfinderDemoHtml, "button").filter(
      (b) => getAttr(b.openTag, "role") === "radio"
    );
    assert.equal(radioButtons.length, 3);
    const checkedRadios = radioButtons.filter(
      (b) => getAttr(b.openTag, "aria-checked") === "true"
    );
    assert.equal(checkedRadios.length, 1);
    assert.equal(getAttr(checkedRadios[0].openTag, "tabindex"), "0");
    for (const img of extractOpeningTags(viewfinderDemoHtml, "img")) {
      assert.ok((getAttr(img.tag, "alt") ?? "").trim().length > 0);
    }

    const resilienceHtml = renderToStaticMarkup(
      ALL_TEN_CORE_AND_WAVE8_SPECS.find((s) => s.name === "DeviceResiliencePanel")!.render(locale)
    );
    const qrImgs = extractOpeningTags(resilienceHtml, "img");
    assert.equal(qrImgs.length, 2);
    for (const img of qrImgs) {
      assert.ok((getAttr(img.tag, "alt") ?? "").trim().length > 0);
    }
  }
});

test("assertMarkupContracts deterministically rejects landmark, dialog, ARIA ID, progressbar, artifact, SVG, and touch-target violations", () => {
  const validProgressAndImgSvg =
    `<section aria-labelledby="valid-h2" aria-describedby="valid-desc">` +
    `<h2 id="valid-h2">Sharpness Panel<${SLASH}h2>` +
    `<p id="valid-desc">Ready for multi-frame read.<${SLASH}p>` +
    `<div role="progressbar" aria-label="Sharpness" aria-valuenow="84" aria-valuemin="0" aria-valuemax="100" aria-valuetext="84 percent"><${SLASH}div>` +
    `<svg role="img" aria-label="Reticle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"${SLASH}><${SLASH}svg>` +
    `<button type="button" style="min-height:48px">Check Now<${SLASH}button>` +
    `<${SLASH}section>`;

  assertMarkupContracts(validProgressAndImgSvg, {
    label: "synthetic-valid",
    landmarkKind: "section",
    expectsHeading: true,
    expectsProgressbar: true,
    minButtons: 1,
    minSvgs: 1
  });

  const invalidCases: ReadonlyArray<[string, string, boolean]> = [
    ["missing-landmark", `<div><h2>Heading<${SLASH}h2><${SLASH}div>`, false],
    [
      "dialog-without-aria-modal",
      `<div role="dialog" tabindex="-1" aria-label="Modal"><h2>Modal<${SLASH}h2><${SLASH}div>`,
      false
    ],
    [
      "broken-labelledby",
      `<section aria-labelledby="missing-h2"><h2>Heading<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "broken-input-describedby",
      `<section aria-label="Form"><h2>Form<${SLASH}h2><input aria-describedby="missing-hint"${SLASH}><${SLASH}section>`,
      false
    ],
    [
      "duplicate-id",
      `<section aria-labelledby="dup"><h2 id="dup">One<${SLASH}h2><p id="dup">Two<${SLASH}p><${SLASH}section>`,
      false
    ],
    [
      "progressbar-missing-valuenow",
      `<section aria-label="Meter"><h2>Meter<${SLASH}h2><div role="progressbar" aria-label="Sharpness" aria-valuemin="0" aria-valuemax="100" aria-valuetext="0%"><${SLASH}div><${SLASH}section>`,
      true
    ],
    [
      "progressbar-out-of-range",
      `<section aria-label="Meter"><h2>Meter<${SLASH}h2><div role="progressbar" aria-label="Sharpness" aria-valuenow="140" aria-valuemin="0" aria-valuemax="100" aria-valuetext="140%"><${SLASH}div><${SLASH}section>`,
      true
    ],
    [
      "leaked-undefined",
      `<section aria-label="Card"><h2>Value undefined<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "leaked-nan",
      `<section aria-label="Card"><h2>Sharpness NaN%<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "leaked-object",
      `<section aria-label="Card"><h2>[object Object]<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "html-comment",
      `<section aria-label="Card">${HTML_COMMENT_OPEN} hidden --><h2>Heading<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "em-dash",
      `<section aria-label="Card"><h2>Title ${EM_DASH} Sub<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "en-dash",
      `<section aria-label="Card"><h2>Title ${EN_DASH} Sub<${SLASH}h2><${SLASH}section>`,
      false
    ],
    [
      "unlabeled-svg",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><svg viewBox="0 0 10 10"><path d="M0 0h10"${SLASH}><${SLASH}svg><${SLASH}section>`,
      false
    ],
    [
      "undersized-button",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" style="min-height:40px">Tap<${SLASH}button><${SLASH}section>`,
      false
    ],
    [
      "btn-overridden-below-48px",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" class="btn" style="min-height:44px">Tap<${SLASH}button><${SLASH}section>`,
      false
    ],
    [
      "disabled-without-aria-disabled",
      `<section aria-label="Card"><h2>Heading<${SLASH}h2><button type="button" class="btn" disabled="">Blocked<${SLASH}button><${SLASH}section>`,
      false
    ]
  ];

  for (const [caseName, badHtml, expectsProgressbar] of invalidCases) {
    assert.throws(
      () =>
        assertMarkupContracts(badHtml, {
          label: caseName,
          expectsHeading: true,
          expectsProgressbar
        }),
      `Expected assertMarkupContracts to reject ${caseName}`
    );
  }
});

test("coreAndWave8A11yAudit.test.ts contains zero code comments and zero em or en dashes", () => {
  const selfSource = readFileSync(
    new URL(`./coreAndWave8A11yAudit.test.ts`, import.meta.url),
    "utf8"
  );
  assert.equal(selfSource.includes(LINE_COMMENT), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(selfSource.includes(EN_DASH), false);
});
