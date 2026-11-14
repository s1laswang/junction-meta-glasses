import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  clampHudHeadline,
  initialHudState,
  nextFocusIndex,
  reduceHudServerMsg,
  sanitizeHudText,
  type HudAppProps,
  type HudState
} from "../src/hud/HudApp.tsx";
import { HudPreviewFrame } from "../src/hud/HudPreviewFrame.tsx";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import { STRENGTH_MIN_CONF, checkLabel } from "../../server/src/safety.ts";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  Profile,
  ServerMsg,
  Verdict,
  VerdictLevel
} from "../../shared/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";
const HTML_COMMENT_OPEN = "<" + "!--";

const WAVEGUIDE_WIDTH_PX = 600;
const WAVEGUIDE_HEIGHT_PX = 600;
const WAVEGUIDE_AREA_PX = WAVEGUIDE_WIDTH_PX * WAVEGUIDE_HEIGHT_PX;
const MAX_VERDICT_FILL_BUDGET = 0.65;
const MAX_COACH_FILL_BUDGET = 0.35;
const MAX_HEADLINE_WORDS = 8;
const MAX_ACTIONS_PER_CARD = 3;
const MIN_WAVEGUIDE_CONTRAST = 10;

const FIXED_NOW = new Date("2026-11-14T20:00:00Z");

type CssDecls = Record<string, string>;

type ParsedCssRule = {
  media: string | null;
  selectors: string[];
  declarations: CssDecls;
};

type Rgb = { r: number; g: number; b: number };

type HudMatrixCase = {
  id: string;
  kind: "idle" | "coaching" | "checking" | "verdict";
  state: Partial<HudState>;
  expectedMaxAreaRatio: number;
  expectedLogDoseEnabled: boolean;
};

function parseDeclarations(body: string): CssDecls {
  const out: CssDecls = {};
  for (const raw of body.split(";")) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const prop = raw.slice(0, colon).trim();
    const val = raw.slice(colon + 1).trim();
    if (prop.length > 0 && val.length > 0) {
      out[prop] = val;
    }
  }
  return out;
}

function parseCssRules(cssSource: string, media: string | null = null): ParsedCssRule[] {
  const rules: ParsedCssRule[] = [];
  let cursor = 0;
  const len = cssSource.length;

  while (cursor < len) {
    const openBrace = cssSource.indexOf("{", cursor);
    if (openBrace === -1) break;
    const prelude = cssSource.slice(cursor, openBrace).trim();
    let depth = 1;
    let scan = openBrace + 1;
    while (scan < len && depth > 0) {
      const ch = cssSource[scan];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      scan += 1;
    }
    const inner = cssSource.slice(openBrace + 1, scan - 1);
    if (prelude.startsWith("@media")) {
      rules.push(...parseCssRules(inner, prelude));
    } else if (prelude.length > 0) {
      const selectors = prelude
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      rules.push({
        media,
        selectors,
        declarations: parseDeclarations(inner)
      });
    }
    cursor = scan;
  }

  return rules;
}

function selectorDecls(rules: ParsedCssRule[], selector: string): CssDecls {
  const merged: CssDecls = {};
  for (const rule of rules) {
    if (rule.media === null && rule.selectors.includes(selector)) {
      Object.assign(merged, rule.declarations);
    }
  }
  return merged;
}

function splitTopLevelArgs(expr: string, delimiter: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === delimiter) {
      const token = expr.slice(start, i).trim();
      if (token.length > 0) parts.push(token);
      start = i + 1;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function evalCssLength(
  rawExpr: string,
  ctx: { vw: number; vh: number; parentPx?: number }
): number {
  const expr = rawExpr.trim();
  if (expr === "0") return 0;

  if (expr.startsWith("clamp(") && expr.endsWith(")")) {
    const args = splitTopLevelArgs(expr.slice(6, -1), ",");
    assert.equal(args.length, 3, `Expected 3 clamp() args in ${expr}`);
    const minVal = evalCssLength(args[0], ctx);
    const prefVal = evalCssLength(args[1], ctx);
    const maxVal = evalCssLength(args[2], ctx);
    return Math.max(minVal, Math.min(prefVal, maxVal));
  }

  if (expr.startsWith("min(") && expr.endsWith(")")) {
    const args = splitTopLevelArgs(expr.slice(4, -1), ",");
    assert.ok(args.length >= 2, `Expected >=2 min() args in ${expr}`);
    return Math.min(...args.map((a) => evalCssLength(a, ctx)));
  }

  if (expr.startsWith("max(") && expr.endsWith(")")) {
    const args = splitTopLevelArgs(expr.slice(4, -1), ",");
    assert.ok(args.length >= 2, `Expected >=2 max() args in ${expr}`);
    return Math.max(...args.map((a) => evalCssLength(a, ctx)));
  }

  const unitMatch = /^(-?\d+(?:\.\d+)?)(px|vw|vh|dvh|vmin|%)$/i.exec(expr);
  if (!unitMatch) {
    throw new Error(`Unsupported CSS length expression: ${expr}`);
  }
  const value = Number.parseFloat(unitMatch[1]);
  const unit = unitMatch[2].toLowerCase();
  if (unit === "px") return value;
  if (unit === "vw") return (value / 100) * ctx.vw;
  if (unit === "vh" || unit === "dvh") return (value / 100) * ctx.vh;
  if (unit === "vmin") return (value / 100) * Math.min(ctx.vw, ctx.vh);
  if (unit === "%") {
    assert.ok(typeof ctx.parentPx === "number", `Percentage requires parentPx in ${expr}`);
    return (value / 100) * (ctx.parentPx as number);
  }
  throw new Error(`Unhandled CSS unit in ${expr}`);
}

function parsePaddingBox(
  rawPadding: string,
  ctx: { vw: number; vh: number; parentPx?: number }
): { top: number; right: number; bottom: number; left: number } {
  const parts = splitTopLevelArgs(rawPadding, " ").map((p) => evalCssLength(p, ctx));
  if (parts.length === 1) {
    return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  }
  if (parts.length === 2) {
    return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  }
  if (parts.length === 4) {
    return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
  }
  throw new Error(`Unsupported padding shorthand: ${rawPadding}`);
}

function parseBorderSpec(rawBorder: string): { widthPx: number; style: string; color: string } {
  const tokens = splitTopLevelArgs(rawBorder, " ");
  assert.ok(tokens.length >= 3, `Expected border shorthand in ${rawBorder}`);
  const widthPx = evalCssLength(tokens[0], { vw: WAVEGUIDE_WIDTH_PX, vh: WAVEGUIDE_HEIGHT_PX });
  const style = tokens[1].toLowerCase();
  const color = tokens.slice(2).join(" ");
  return { widthPx, style, color };
}

function parseHexColor(color: string): Rgb {
  const trimmed = color.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Expected hex color, got ${color}`);
  }
  const hex = match[1];
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0] + hex[0], 16),
      g: Number.parseInt(hex[1] + hex[1], 16),
      b: Number.parseInt(hex[2] + hex[2], 16)
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function srgbToLinear(c8: number): number {
  const s = c8 / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanceRgb(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  );
}

function contrastOnAdditiveBlack(hexColor: string): number {
  const lum = relativeLuminanceRgb(parseHexColor(hexColor));
  return (lum + 0.05) / 0.05;
}

function simulateLinearCvdLuminance(
  hexColor: string,
  mode: "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia"
): number {
  const { r, g, b } = parseHexColor(hexColor);
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  if (mode === "achromatopsia") {
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }
  if (mode === "protanopia") {
    const rp = 0.152286 * R + 1.052583 * G - 0.204868 * B;
    const gp = 0.114503 * R + 0.786281 * G + 0.099216 * B;
    const bp = -0.003882 * R - 0.048116 * G + 1.051998 * B;
    return (
      0.2126 * Math.max(0, Math.min(1, rp)) +
      0.7152 * Math.max(0, Math.min(1, gp)) +
      0.0722 * Math.max(0, Math.min(1, bp))
    );
  }
  if (mode === "deuteranopia") {
    const rd = 0.367322 * R + 0.860646 * G - 0.227968 * B;
    const gd = 0.280085 * R + 0.672501 * G + 0.047413 * B;
    const bd = -0.01182 * R + 0.04294 * G + 0.968881 * B;
    return (
      0.2126 * Math.max(0, Math.min(1, rd)) +
      0.7152 * Math.max(0, Math.min(1, gd)) +
      0.0722 * Math.max(0, Math.min(1, bd))
    );
  }
  const rt = 1.255528 * R - 0.076749 * G - 0.178779 * B;
  const gt = -0.078411 * R + 0.930809 * G + 0.147602 * B;
  const bt = 0.004733 * R + 0.691367 * G + 0.3039 * B;
  return (
    0.2126 * Math.max(0, Math.min(1, rt)) +
    0.7152 * Math.max(0, Math.min(1, gt)) +
    0.0722 * Math.max(0, Math.min(1, bt))
  );
}

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 86,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipin", confidence: 0.99 },
    ingredient: { value: "amlodipine", confidence: 0.99 },
    strength: { value: "5 mg", confidence: 0.99 },
    dosing: { value: "1 tablet each evening", confidence: 0.92 },
    expiry: { value: "2027-08", confidence: 0.99 },
    allergens: { value: null, confidence: 0.1 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.95,
    guidance: "Turn the box around to see dosing instructions.",
    ...overrides
  };
}

function renderHud(props?: HudAppProps): string {
  return renderToStaticMarkup(createElement(HudApp, props));
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function decodeHtmlEntities(htmlText: string): string {
  return htmlText
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractSvgAfter(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `Expected marker ${marker}`);
  const start = html.indexOf("<svg", idx);
  const closeTag = "<" + "\x2fsvg>";
  const end = html.indexOf(closeTag, start);
  assert.ok(start >= 0 && end > start, `Expected <svg> after ${marker}`);
  return html.slice(start, end + closeTag.length);
}

function extractActionBtnTag(
  html: string,
  action: "log_dose" | "repeat" | "dismiss"
): string {
  const pattern = new RegExp(`<button\\b[^>]*data-hud-action="${action}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected action button ${action}`);
  return match[0];
}

const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
const hudTsxSource = readFileSync(new URL("../src/hud/HudApp.tsx", import.meta.url), "utf8");
const hudCssRules = parseCssRules(hudCssSource);

const amlodipineMatchVerdict = checkLabel(makeLabelRead(), DEMO_PROFILE, FIXED_NOW);

const amlodipineTakenMatchVerdict: Verdict = {
  ...amlodipineMatchVerdict,
  takenToday: true
};

const metforminPartialScheduleProfile: Profile = {
  ...DEMO_PROFILE,
  doseLog: [{ medId: "met", ts: FIXED_NOW.getTime() - 6 * 3600_000 }]
};

const metforminTakenMatchVerdict = checkLabel(
  makeLabelRead({
    product: { value: "Metformin", confidence: 0.99 },
    ingredient: { value: "metformin", confidence: 0.99 },
    strength: { value: "500 mg", confidence: 0.99 },
    barcode: { value: "6432100054321", confidence: 0.99 }
  }),
  metforminPartialScheduleProfile,
  FIXED_NOW
);

const nsaidAvoidVerdict = checkLabel(
  makeLabelRead({
    product: { value: "Burana", confidence: 0.99 },
    ingredient: { value: "ibuprofen", confidence: 0.99 },
    strength: { value: "400 mg", confidence: 0.99 },
    dosing: { value: null, confidence: 0 },
    expiry: { value: "2028-03", confidence: 0.98 }
  }),
  DEMO_PROFILE,
  FIXED_NOW
);

const hazelnutAllergenVerdict = checkLabel(
  makeLabelRead({
    kind: "food",
    product: { value: "Granola Hazelnut Bar", confidence: 0.99 },
    ingredient: { value: "oat hazelnut bar", confidence: 0.96 },
    strength: { value: null, confidence: 0 },
    dosing: { value: null, confidence: 0 },
    expiry: { value: "2027-09-14", confidence: 0.99 },
    allergens: { value: ["hazelnut", "oats"], confidence: 0.98 }
  }),
  DEMO_PROFILE,
  FIXED_NOW
);

const occludedDoseVerdict = checkLabel(
  makeLabelRead({
    strength: { value: "5 mg", confidence: 0.62 },
    readability: 0.54,
    guidance: "Move your thumb away to uncover the strength."
  }),
  DEMO_PROFILE,
  FIXED_NOW
);

const safeOatMilkVerdict = checkLabel(
  makeLabelRead({
    kind: "food",
    product: { value: "Oat Drink", confidence: 0.98 },
    ingredient: { value: "water, oats, rapeseed oil", confidence: 0.95 },
    strength: { value: null, confidence: 0 },
    dosing: { value: null, confidence: 0 },
    expiry: { value: "2027-12-03", confidence: 0.95 },
    allergens: { value: ["oat"], confidence: 0.95 }
  }),
  DEMO_PROFILE,
  FIXED_NOW
);

const checkingState = reduceHudServerMsg(
  reduceHudServerMsg(
    {
      ...initialHudState(),
      connected: true,
      live: "open",
      device: makeDevice()
    },
    { type: "checking", phase: "start" }
  ),
  { type: "coach", cue: "hold_still", text: "Hold still, reading..." }
);

const HUD_MATRIX_CASES: readonly HudMatrixCase[] = [
  {
    id: "idle",
    kind: "idle",
    state: {},
    expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "coaching:move_closer",
    kind: "coaching",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      coach: { cue: "closer", text: "Move the box closer" }
    },
    expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "coaching:flip_over",
    kind: "coaching",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      coach: { cue: "other_side", text: "Flip the box over" }
    },
    expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "coaching:hold_still",
    kind: "coaching",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      coach: { cue: "hold_still", text: "Hold still right there" }
    },
    expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "checking",
    kind: "checking",
    state: checkingState,
    expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "match:takenToday=false",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: amlodipineMatchVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: true
  },
  {
    id: "match:takenToday=true(live-log)",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: amlodipineTakenMatchVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "match:takenToday=true(twice-daily-checkLabel)",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: metforminTakenMatchVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "warning:nsaid_avoid",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: nsaidAvoidVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "warning:hazelnut_allergen",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: hazelnutAllergenVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: false
  },
  {
    id: "unsure:occluded_dose_lt_0.80",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: occludedDoseVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: true
  },
  {
    id: "info:safe_oat_milk",
    kind: "verdict",
    state: {
      connected: true,
      live: "open",
      device: makeDevice(),
      verdict: safeOatMilkVerdict,
      dismissed: false
    },
    expectedMaxAreaRatio: MAX_VERDICT_FILL_BUDGET,
    expectedLogDoseEnabled: false
  }
];

function computeWaveguideGeometryAndLitBudget(
  html: string,
  kind: HudMatrixCase["kind"]
): {
  cardWidthPx: number;
  cardHeightPx: number;
  cardBoundingAreaRatio: number;
  maxStageCardAreaRatio: number;
  totalUsedHeightPx: number;
  litPixelRatio: number;
} {
  const ctx600 = { vw: WAVEGUIDE_WIDTH_PX, vh: WAVEGUIDE_HEIGHT_PX };
  const rootDecls = selectorDecls(hudCssRules, ".hud-root");
  const topbarDecls = selectorDecls(hudCssRules, ".hud-topbar");
  const devicePillDecls = selectorDecls(hudCssRules, ".hud-device-pill");
  const stageDecls = selectorDecls(hudCssRules, ".hud-stage");
  const cardDecls = selectorDecls(hudCssRules, ".hud-card");
  const shapeFrameDecls = selectorDecls(hudCssRules, ".hud-shape-frame");
  const headlineDecls = selectorDecls(hudCssRules, ".hud-headline");
  const chipDecls = selectorDecls(hudCssRules, ".hud-chip");
  const captionDecls = selectorDecls(hudCssRules, ".hud-speech-caption");
  const coachCardDecls = selectorDecls(hudCssRules, ".hud-coach-card");
  const coachBadgeDecls = selectorDecls(hudCssRules, ".hud-coach-cue-badge");
  const coachTextDecls = selectorDecls(hudCssRules, ".hud-coach-text");
  const standbyDecls = selectorDecls(hudCssRules, ".hud-standby");
  const standbyLabelDecls = selectorDecls(hudCssRules, ".hud-standby-label");
  const actionsDecls = selectorDecls(hudCssRules, ".hud-actions");
  const actionBtnDecls = selectorDecls(hudCssRules, ".hud-action-btn");

  const rootPad = parsePaddingBox(rootDecls["padding"], ctx600);
  const rootGap = evalCssLength(rootDecls["gap"], ctx600);
  const innerViewportWidth = WAVEGUIDE_WIDTH_PX - rootPad.left - rootPad.right;

  const topbarWidth = Math.min(
    innerViewportWidth,
    evalCssLength(topbarDecls["max-width"], ctx600)
  );
  const topbarPad = parsePaddingBox(topbarDecls["padding"], ctx600);
  const topbarBorder = parseBorderSpec(topbarDecls["border"]).widthPx;
  const topbarFontPx = evalCssLength(topbarDecls["font-size"], ctx600);
  const topbarLineHeight = Number.parseFloat(topbarDecls["line-height"]);
  const pillPad = parsePaddingBox(devicePillDecls["padding"], ctx600);
  const pillBorder = parseBorderSpec(devicePillDecls["border"]).widthPx;
  const topbarInnerHeight =
    topbarFontPx * topbarLineHeight + pillPad.top + pillPad.bottom + 2 * pillBorder;
  const topbarHeight = topbarInnerHeight + topbarPad.top + topbarPad.bottom + 2 * topbarBorder;

  const actionsWidth = Math.min(
    innerViewportWidth,
    evalCssLength(actionsDecls["max-width"], ctx600)
  );
  const actionsGap = evalCssLength(actionsDecls["gap"], ctx600);
  const actionBtnHeight = evalCssLength(actionBtnDecls["min-height"], ctx600);
  const actionBtnBorder = parseBorderSpec(actionBtnDecls["border"]).widthPx;
  const actionBtnFontPx = evalCssLength(actionBtnDecls["font-size"], ctx600);
  const singleBtnWidth = (actionsWidth - 2 * actionsGap) / 3;

  const stageWidth = Math.min(
    innerViewportWidth,
    evalCssLength(stageDecls["max-width"], ctx600)
  );
  const stageMaxHeight =
    WAVEGUIDE_HEIGHT_PX -
    rootPad.top -
    rootPad.bottom -
    topbarHeight -
    actionBtnHeight -
    2 * rootGap;

  const maxVerdictCardWidth = evalCssLength(cardDecls["width"], {
    ...ctx600,
    parentPx: stageWidth
  });
  const maxStageCardAreaRatio = (maxVerdictCardWidth * stageMaxHeight) / WAVEGUIDE_AREA_PX;

  let cardWidthPx = 0;
  let cardHeightPx = 0;
  let stageLitPixels = 0;

  if (kind === "verdict") {
    cardWidthPx = maxVerdictCardWidth;
    const cardPad = parsePaddingBox(cardDecls["padding"], ctx600);
    const cardBorderPx = parseBorderSpec(cardDecls["border"]).widthPx;
    const cardGap = evalCssLength(cardDecls["gap"], ctx600);
    const contentWidth = cardWidthPx - cardPad.left - cardPad.right - 2 * cardBorderPx;

    const headerHeight = evalCssLength(shapeFrameDecls["height"], ctx600);
    const headlineMatch = /<h1 class="hud-headline">([^<]*)<\/h1>/.exec(html);
    const headlineText = decodeHtmlEntities(headlineMatch ? headlineMatch[1] : "");
    const headlineFontPx = evalCssLength(headlineDecls["font-size"], ctx600);
    const headlineLineH = Number.parseFloat(headlineDecls["line-height"]);
    const estHeadlineLines = Math.max(
      1,
      Math.ceil((headlineText.length * headlineFontPx * 0.56) / contentWidth)
    );
    const headlineHeight = estHeadlineLines * headlineFontPx * headlineLineH;

    let childrenCount = 2;
    let childrenHeightSum = headerHeight + headlineHeight;

    const chipMatches = [...html.matchAll(/<span class="hud-chip[^"]*"[^>]*>([^<]*)<\/span>/g)];
    if (chipMatches.length > 0) {
      childrenCount += 1;
      const chipFontPx = evalCssLength(chipDecls["font-size"], ctx600);
      const chipLineH = Number.parseFloat(chipDecls["line-height"]);
      const chipPad = parsePaddingBox(chipDecls["padding"], ctx600);
      const chipBorder = parseBorderSpec(chipDecls["border"]).widthPx;
      const singleChipRowH =
        chipFontPx * chipLineH + chipPad.top + chipPad.bottom + 2 * chipBorder;
      const totalChipWidth = chipMatches.reduce(
        (acc, m) =>
          acc +
          decodeHtmlEntities(m[1]).length * chipFontPx * 0.58 +
          chipPad.left +
          chipPad.right +
          2 * chipBorder +
          8,
        0
      );
      const chipRows = Math.max(1, Math.ceil(totalChipWidth / contentWidth));
      childrenHeightSum += chipRows * singleChipRowH + (chipRows - 1) * 8;
    }

    const captionMatch = /<p class="hud-speech-caption">([^<]*)<\/p>/.exec(html);
    if (captionMatch) {
      childrenCount += 1;
      const captionFontPx = evalCssLength(captionDecls["font-size"], ctx600);
      const captionLineH = Number.parseFloat(captionDecls["line-height"]);
      childrenHeightSum += captionFontPx * captionLineH;
    }

    const rawCardHeight =
      2 * cardBorderPx +
      cardPad.top +
      cardPad.bottom +
      childrenHeightSum +
      (childrenCount - 1) * cardGap;
    cardHeightPx = Math.min(stageMaxHeight, rawCardHeight);

    const cardPerimeterLit = 2 * (cardWidthPx + cardHeightPx) * cardBorderPx;
    const svgIconLit = 40 * 40 * 0.24;
    const badgeBorderAndInk = 140 * 34 * 0.36;
    const headlineInk = headlineText.length * headlineFontPx * headlineFontPx * 0.28;
    const chipsInk = chipMatches.length * 120 * 32 * 0.3;
    const captionVisibleChars = captionMatch
      ? Math.min(46, decodeHtmlEntities(captionMatch[1]).length)
      : 0;
    const captionInk = captionVisibleChars * 18 * 18 * 0.26;
    stageLitPixels =
      cardPerimeterLit + svgIconLit + badgeBorderAndInk + headlineInk + chipsInk + captionInk;
  } else if (kind === "coaching" || kind === "checking") {
    cardWidthPx = evalCssLength(coachCardDecls["width"], {
      ...ctx600,
      parentPx: stageWidth
    });
    const coachPad = parsePaddingBox(coachCardDecls["padding"], ctx600);
    const coachBorderPx = parseBorderSpec(coachCardDecls["border"]).widthPx;
    const coachGap = evalCssLength(coachCardDecls["gap"], ctx600);
    const coachContentW = cardWidthPx - coachPad.left - coachPad.right - 2 * coachBorderPx;

    const badgeFontPx = evalCssLength(coachBadgeDecls["font-size"], ctx600);
    const cueFontPx = evalCssLength(coachTextDecls["font-size"], ctx600);
    const cueLineH = Number.parseFloat(coachTextDecls["line-height"]);
    const cueTextMatch = /<p class="hud-coach-text">([^<]*)<\/p>/.exec(html);
    const cueText = decodeHtmlEntities(cueTextMatch ? cueTextMatch[1] : "");
    const cueLines = Math.max(1, Math.ceil((cueText.length * cueFontPx * 0.56) / coachContentW));

    cardHeightPx =
      2 * coachBorderPx +
      coachPad.top +
      coachPad.bottom +
      76 +
      badgeFontPx * 1.2 +
      cueLines * cueFontPx * cueLineH +
      2 * coachGap;

    const coachBorderLit = 2 * (cardWidthPx + cardHeightPx) * coachBorderPx;
    const arrowSvgLit = 76 * 76 * 0.2;
    const cueTextLit = (14 + cueText.length) * cueFontPx * cueFontPx * 0.26;
    stageLitPixels = coachBorderLit + arrowSvgLit + cueTextLit;
  } else {
    const standbyPad = parsePaddingBox(standbyDecls["padding"], ctx600);
    const standbyGap = evalCssLength(standbyDecls["gap"], ctx600);
    const labelFontPx = evalCssLength(standbyLabelDecls["font-size"], ctx600);
    const labelLineH = Number.parseFloat(standbyLabelDecls["line-height"]);
    const labelMatch = /<p class="hud-standby-label">([^<]*)<\/p>/.exec(html);
    const labelText = decodeHtmlEntities(labelMatch ? labelMatch[1] : "");

    cardWidthPx = Math.min(
      stageWidth,
      Math.max(96, labelText.length * labelFontPx * 0.54) + standbyPad.left + standbyPad.right
    );
    cardHeightPx =
      standbyPad.top + standbyPad.bottom + 96 + standbyGap + labelFontPx * labelLineH;

    stageLitPixels =
      96 * 96 * 0.14 + labelText.length * labelFontPx * labelFontPx * 0.26;
  }

  const topbarLitPixels =
    2 * (topbarWidth + topbarHeight) * topbarBorder +
    10 * 10 +
    36 * topbarFontPx * topbarFontPx * 0.26;

  const actionsBorderLit =
    3 * 2 * (singleBtnWidth + actionBtnHeight) * actionBtnBorder +
    2 * (singleBtnWidth + 6 + actionBtnHeight + 6) * 4;
  const focusedButtonTintLit = singleBtnWidth * actionBtnHeight;
  const actionLabelsLit = 21 * actionBtnFontPx * actionBtnFontPx * 0.28;
  const totalLitPixels =
    topbarLitPixels +
    stageLitPixels +
    actionsBorderLit +
    focusedButtonTintLit +
    actionLabelsLit;

  const totalUsedHeightPx =
    rootPad.top +
    rootPad.bottom +
    topbarHeight +
    cardHeightPx +
    actionBtnHeight +
    2 * rootGap;

  return {
    cardWidthPx,
    cardHeightPx,
    cardBoundingAreaRatio: (cardWidthPx * cardHeightPx) / WAVEGUIDE_AREA_PX,
    maxStageCardAreaRatio,
    totalUsedHeightPx,
    litPixelRatio: totalLitPixels / WAVEGUIDE_AREA_PX
  };
}

test("600x600 additive waveguide enforces pure #000000 transparent canvas and <= 65% fill budget across idle, coaching, checking, match, warning, unsure, and info", () => {
  assert.equal(amlodipineMatchVerdict.level, "match");
  assert.equal(amlodipineMatchVerdict.takenToday, false);
  assert.equal(amlodipineTakenMatchVerdict.level, "match");
  assert.equal(amlodipineTakenMatchVerdict.takenToday, true);
  assert.equal(metforminTakenMatchVerdict.level, "match");
  assert.equal(metforminTakenMatchVerdict.takenToday, true);
  assert.equal(nsaidAvoidVerdict.level, "warning");
  assert.equal(hazelnutAllergenVerdict.level, "warning");
  assert.equal(occludedDoseVerdict.level, "unsure");
  assert.ok(occludedDoseVerdict.read.strength.confidence < STRENGTH_MIN_CONF);
  assert.equal(safeOatMilkVerdict.level, "info");

  assert.equal(hudCssSource.includes("600px"), false, "HUD CSS must use responsive viewport units");
  assert.equal(hudCssSource.includes("backdrop-filter"), false, "Waveguide forbids blur scrims");

  for (const selector of [
    ":root:has(.hud-root)",
    "body:has(.hud-root)",
    "#root:has(.hud-root)",
    ".hud-root",
    ".hud-topbar",
    ".hud-device-pill",
    ".hud-stage",
    ".hud-card",
    ".hud-shape-frame",
    ".hud-badge",
    ".hud-chip",
    ".hud-coach-card",
    ".hud-standby",
    ".hud-action-btn"
  ]) {
    const decls = selectorDecls(hudCssRules, selector);
    const bg = decls["background-color"] ?? decls["background"];
    assert.equal(bg, "#000000", `${selector} must enforce pure #000000 transparent background`);
  }

  assert.equal(selectorDecls(hudCssRules, ".hud-root")["overflow"], "hidden");
  assert.equal(selectorDecls(hudCssRules, "body:has(.hud-root)")["overflow"], "hidden");

  for (const entry of HUD_MATRIX_CASES) {
    const html = renderHud({ initialState: entry.state });
    assert.match(html, /^<main\b[^>]*class="hud-root"/);
    assert.ok(html.includes('data-hud-surface="600x600-additive"'));

    const inlineBgMatches = [...html.matchAll(/background(?:-color)?:\s*([^;"']+)/gi)];
    assert.ok(inlineBgMatches.length >= 2, `${entry.id} must emit inline #000000 waveguide backgrounds`);
    for (const bgMatch of inlineBgMatches) {
      assert.equal(
        bgMatch[1].trim().toLowerCase(),
        "#000000",
        `${entry.id} inline background must stay pure #000000`
      );
    }

    const metrics = computeWaveguideGeometryAndLitBudget(html, entry.kind);
    assert.ok(
      metrics.maxStageCardAreaRatio <= MAX_VERDICT_FILL_BUDGET,
      `${entry.id} max stage card ratio ${metrics.maxStageCardAreaRatio.toFixed(4)} exceeds 0.65`
    );
    assert.ok(
      metrics.cardBoundingAreaRatio <= entry.expectedMaxAreaRatio,
      `${entry.id} bounding area ratio ${metrics.cardBoundingAreaRatio.toFixed(4)} exceeds ${entry.expectedMaxAreaRatio}`
    );
    assert.ok(
      metrics.cardBoundingAreaRatio <= MAX_VERDICT_FILL_BUDGET,
      `${entry.id} bounding area ratio ${metrics.cardBoundingAreaRatio.toFixed(4)} exceeds 65% waveguide budget`
    );
    assert.ok(
      metrics.litPixelRatio > 0 && metrics.litPixelRatio <= MAX_VERDICT_FILL_BUDGET,
      `${entry.id} additive lit pixel ratio ${metrics.litPixelRatio.toFixed(4)} out of (0, 0.65]`
    );
    assert.ok(
      metrics.totalUsedHeightPx <= WAVEGUIDE_HEIGHT_PX,
      `${entry.id} vertical height ${metrics.totalUsedHeightPx.toFixed(2)}px overflows 600px waveguide`
    );
  }

  const previewCheckingHtml = renderToStaticMarkup(
    createElement(HudPreviewFrame, {
      verdict: null,
      coach: null,
      checking: true,
      device: makeDevice(),
      hudSocketConnected: true,
      onTriggerHudEvent: () => {}
    })
  );
  assert.ok(previewCheckingHtml.includes('data-waveguide-viewport="600x600"'));
  assert.ok(previewCheckingHtml.includes("background-color:#000000"));
  assert.ok(previewCheckingHtml.includes("CHECKING LABEL..."));
});

test("4-channel redundant encoding differentiates match, warning, unsure, and info via SVG geometry, uppercase badge, border treatment, and >= 10:1 luminous color", () => {
  const verdictCases: ReadonlyArray<{
    level: VerdictLevel;
    verdict: Verdict;
    expectedBadge: string;
    expectedShape: string;
    expectedColor: string;
    expectedPrimitivePattern: RegExp;
  }> = [
    {
      level: "match",
      verdict: amlodipineMatchVerdict,
      expectedBadge: "MATCH",
      expectedShape: "circle",
      expectedColor: "#22ff88",
      expectedPrimitivePattern: /<circle cx="20" cy="20" r="16"/
    },
    {
      level: "warning",
      verdict: nsaidAvoidVerdict,
      expectedBadge: "WARNING",
      expectedShape: "triangle",
      expectedColor: "#ffbb22",
      expectedPrimitivePattern: /M20 4\.5L36\.5 34H3\.5L20 4\.5Z/
    },
    {
      level: "unsure",
      verdict: occludedDoseVerdict,
      expectedBadge: "UNSURE",
      expectedShape: "diamond",
      expectedColor: "#38d6ff",
      expectedPrimitivePattern: /M20 3L37 20L20 37L3 20L20 3Z/
    },
    {
      level: "info",
      verdict: safeOatMilkVerdict,
      expectedBadge: "INFO",
      expectedShape: "square",
      expectedColor: "#f0f6ff",
      expectedPrimitivePattern: /<rect x="5" y="5" width="30" height="30"/
    }
  ];

  const colorNeutralSvgSet = new Set<string>();
  const shapeTokenSet = new Set<string>();
  const badgeTextSet = new Set<string>();
  const cardBorderSignatureSet = new Set<string>();
  const badgeBorderSignatureSet = new Set<string>();
  const accentColorSet = new Set<string>();

  for (const item of verdictCases) {
    const html = renderHud({
      initialState: {
        connected: true,
        live: "open",
        device: makeDevice(),
        verdict: item.verdict,
        dismissed: false
      }
    });

    assert.ok(html.includes(`data-verdict-level="${item.level}"`));
    assert.ok(html.includes(`data-verdict-shape="${item.expectedShape}"`));
    assert.ok(html.includes(`data-shape="${item.expectedShape}"`));
    shapeTokenSet.add(item.expectedShape);

    const svg = extractSvgAfter(html, `data-shape="${item.expectedShape}"`);
    assert.match(svg, item.expectedPrimitivePattern);
    assert.ok(svg.includes(item.expectedColor));

    const strokeWidths = [...svg.matchAll(/stroke-width="([0-9.]+)"/gi)].map((m) =>
      Number.parseFloat(m[1])
    );
    assert.ok(strokeWidths.length >= 2, `${item.level} SVG must render vector strokes`);
    for (const sw of strokeWidths) {
      assert.ok(sw >= 3.5, `${item.level} SVG stroke-width ${sw} must be >= 3.5px for waveguide`);
    }

    const colorNeutralSvg = svg
      .replace(/stroke="[^"]+"/g, 'stroke="currentColor"')
      .replace(/fill="[^"]+"/g, 'fill="currentColor"');
    colorNeutralSvgSet.add(colorNeutralSvg);

    assert.equal(item.expectedBadge, item.expectedBadge.toUpperCase());
    assert.ok(html.includes(`>${item.expectedBadge}</span>`));
    assert.ok(html.includes(`aria-label="${item.expectedBadge} verdict card"`));
    badgeTextSet.add(item.expectedBadge);

    const cardCss = selectorDecls(hudCssRules, `.hud-card--${item.level}`);
    const cardBorder = parseBorderSpec(cardCss["border"]);
    assert.equal(cardBorder.widthPx, 4);
    assert.equal(cardBorder.color.toLowerCase(), item.expectedColor);
    const cardRadius = cardCss["border-radius"];
    assert.ok(cardRadius, `Missing border-radius on .hud-card--${item.level}`);
    cardBorderSignatureSet.add(`${cardBorder.style}|${cardRadius}`);

    const badgeCss = selectorDecls(hudCssRules, `.hud-badge--${item.level}`);
    const badgeBorder = parseBorderSpec(badgeCss["border"]);
    assert.equal(badgeBorder.widthPx, 2.5);
    assert.equal(badgeBorder.color.toLowerCase(), item.expectedColor);
    const badgeRadius = badgeCss["border-radius"];
    assert.ok(badgeRadius !== undefined);
    badgeBorderSignatureSet.add(`${badgeBorder.style}|${badgeRadius}`);

    assert.ok(html.includes(`border-color:${item.expectedColor}`));
    accentColorSet.add(item.expectedColor);

    const contrast = contrastOnAdditiveBlack(item.expectedColor);
    assert.ok(
      contrast >= MIN_WAVEGUIDE_CONTRAST,
      `${item.level} accent ${item.expectedColor} contrast ${contrast.toFixed(2)}:1 < 10:1`
    );

    for (const cvdMode of [
      "protanopia",
      "deuteranopia",
      "tritanopia",
      "achromatopsia"
    ] as const) {
      const cvdLum = simulateLinearCvdLuminance(item.expectedColor, cvdMode);
      const cvdContrast = (cvdLum + 0.05) / 0.05;
      assert.ok(
        cvdContrast >= 8,
        `${item.level} under ${cvdMode} contrast ${cvdContrast.toFixed(2)}:1 < 8:1`
      );
    }
  }

  assert.equal(shapeTokenSet.size, 4, "4 distinct shape tokens required");
  assert.equal(colorNeutralSvgSet.size, 4, "4 distinct color-neutral SVG geometries required");
  assert.equal(badgeTextSet.size, 4, "4 distinct uppercase text badges required");
  assert.equal(cardBorderSignatureSet.size, 4, "4 distinct card border style+radius treatments required");
  assert.equal(badgeBorderSignatureSet.size, 4, "4 distinct badge border style+radius treatments required");
  assert.equal(accentColorSet.size, 4, "4 distinct high-luminance colors required");

  assert.ok(contrastOnAdditiveBlack("#ffffff") >= 21 - 1e-9);
  assert.ok(contrastOnAdditiveBlack("#ffee00") >= 15);
  assert.ok(contrastOnAdditiveBlack("#ff0000") < MIN_WAVEGUIDE_CONTRAST);
  assert.ok(contrastOnAdditiveBlack("#0000ff") < MIN_WAVEGUIDE_CONTRAST);
  assert.equal(hudCssSource.toLowerCase().includes("#ff0000"), false);
  assert.equal(hudCssSource.toLowerCase().includes("#0000ff"), false);

  const hazelnutHtml = renderHud({
    initialState: {
      connected: true,
      live: "open",
      verdict: hazelnutAllergenVerdict
    }
  });
  assert.ok(hazelnutHtml.includes('data-verdict-level="warning"'));
  assert.ok(hazelnutHtml.includes('data-verdict-shape="triangle"'));
  assert.ok(hazelnutHtml.includes(">WARNING</span>"));

  const coachingTriplet: ReadonlyArray<[CoachCue, string]> = [
    ["closer", "MOVE CLOSER"],
    ["other_side", "OTHER SIDE"],
    ["hold_still", "HOLD STILL"]
  ];
  const coachGeometries = new Set<string>();
  for (const [cue, expectedCueBadge] of coachingTriplet) {
    const coachHtml = renderHud({
      initialState: {
        connected: true,
        live: "open",
        coach: { cue, text: `Cue ${cue}` }
      }
    });
    assert.ok(coachHtml.includes(`data-coach-cue="${cue}"`));
    assert.ok(coachHtml.includes(`>${expectedCueBadge}</span>`));
    const cueSvg = extractSvgAfter(coachHtml, `data-coach-cue="${cue}"`);
    coachGeometries.add(
      cueSvg.replace(/stroke="[^"]+"/g, "").replace(/fill="[^"]+"/g, "")
    );
  }
  assert.equal(coachGeometries.size, 3, "move_closer, flip_over, and hold_still must have distinct SVGs");
});

test("Compact <= 8 word headlines hold across all standard checkLabel verdicts and secondary sublines enforce truncation bounds", () => {
  const alreadyLoggedAmlProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [{ medId: "aml", ts: FIXED_NOW.getTime() - 1800_000 }]
  };
  const medAllergyProfile: Profile = {
    ...DEMO_PROFILE,
    allergies: ["penicillin", "peanut", "tree nuts"]
  };
  const medOnAvoidProfile: Profile = {
    ...DEMO_PROFILE,
    meds: [
      ...DEMO_PROFILE.meds,
      {
        id: "ibu",
        name: "Burana",
        ingredient: "ibuprofen",
        strength: "400 mg",
        schedule: ["as needed"]
      }
    ],
    avoid: ["NSAIDs", "grapefruit"]
  };

  const standardVerdicts: ReadonlyArray<[string, Verdict]> = [
    ["match:amlodipine_not_taken", amlodipineMatchVerdict],
    ["match:amlodipine_taken_live", amlodipineTakenMatchVerdict],
    ["match:metformin_partial_taken", metforminTakenMatchVerdict],
    [
      "match:as_needed_panadol",
      checkLabel(
        makeLabelRead({
          product: { value: "Panadol", confidence: 0.99 },
          ingredient: { value: "paracetamol", confidence: 0.99 },
          strength: { value: "500 mg", confidence: 0.99 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    ["warning:nsaid_unlisted", nsaidAvoidVerdict],
    [
      "warning:nsaid_on_list_avoid",
      checkLabel(
        makeLabelRead({
          product: { value: "Burana", confidence: 0.99 },
          ingredient: { value: "ibuprofen", confidence: 0.99 },
          strength: { value: "400 mg", confidence: 0.99 }
        }),
        medOnAvoidProfile,
        FIXED_NOW
      )
    ],
    ["warning:hazelnut_allergen", hazelnutAllergenVerdict],
    [
      "warning:hazelnut_may_contain",
      checkLabel(
        makeLabelRead({
          kind: "food",
          product: { value: "Dark Chocolate", confidence: 0.98 },
          ingredient: { value: "cocoa mass, sugar", confidence: 0.95 },
          strength: { value: null, confidence: 0 },
          allergens: { value: ["may contain: hazelnut"], confidence: 0.92 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "warning:medication_penicillin_allergy",
      checkLabel(
        makeLabelRead({
          product: { value: "Amorion", confidence: 0.99 },
          ingredient: { value: "amoxicillin", confidence: 0.99 },
          strength: { value: "500 mg", confidence: 0.99 }
        }),
        medAllergyProfile,
        FIXED_NOW
      )
    ],
    [
      "warning:wrong_strength",
      checkLabel(
        makeLabelRead({
          product: { value: "Amlodipin", confidence: 0.99 },
          ingredient: { value: "amlodipine", confidence: 0.99 },
          strength: { value: "10 mg", confidence: 0.99 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "warning:expired_medication",
      checkLabel(
        makeLabelRead({
          product: { value: "Metformin", confidence: 0.99 },
          ingredient: { value: "metformin", confidence: 0.99 },
          strength: { value: "500 mg", confidence: 0.99 },
          expiry: { value: "2025-04", confidence: 0.98 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "warning:already_taken_today",
      checkLabel(makeLabelRead(), alreadyLoggedAmlProfile, FIXED_NOW)
    ],
    [
      "warning:expired_food",
      checkLabel(
        makeLabelRead({
          kind: "food",
          product: { value: "Oat Drink", confidence: 0.98 },
          ingredient: { value: "oats", confidence: 0.95 },
          strength: { value: null, confidence: 0 },
          expiry: { value: "2025-01-10", confidence: 0.96 },
          allergens: { value: ["oat"], confidence: 0.95 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    ["unsure:occluded_dose_0.62", occludedDoseVerdict],
    [
      "unsure:boundary_dose_0.79",
      checkLabel(
        makeLabelRead({
          strength: { value: "5 mg", confidence: 0.79 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "unsure:unreadable_label",
      checkLabel(
        makeLabelRead({
          kind: "unreadable",
          product: { value: null, confidence: 0 },
          ingredient: { value: null, confidence: 0 },
          strength: { value: null, confidence: 0 },
          readability: 0.2
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "unsure:low_name_confidence",
      checkLabel(
        makeLabelRead({
          product: { value: "Amlodipin", confidence: 0.45 },
          ingredient: { value: null, confidence: 0.2 },
          readability: 0.72
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    [
      "unsure:food_allergens_unreadable",
      checkLabel(
        makeLabelRead({
          kind: "food",
          product: { value: "Cereal Pack", confidence: 0.92 },
          ingredient: { value: "oats", confidence: 0.88 },
          strength: { value: null, confidence: 0 },
          allergens: { value: null, confidence: 0.25 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ],
    ["info:safe_oat_milk", safeOatMilkVerdict],
    [
      "info:general_item",
      checkLabel(
        makeLabelRead({
          kind: "other",
          product: { value: "Saline Eye Drops", confidence: 0.94 },
          ingredient: { value: "sodium chloride", confidence: 0.9 },
          strength: { value: null, confidence: 0 },
          allergens: { value: [], confidence: 0.9 }
        }),
        DEMO_PROFILE,
        FIXED_NOW
      )
    ]
  ];

  for (const [label, verdict] of standardVerdicts) {
    const rawWords = countWords(verdict.headline);
    assert.ok(
      rawWords >= 1 && rawWords <= MAX_HEADLINE_WORDS,
      `${label} checkLabel headline "${verdict.headline}" has ${rawWords} words (expected 1..8)`
    );

    const sentences = verdict.speech.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(
      sentences.length >= 1 && sentences.length <= 2,
      `${label} speech "${verdict.speech}" must stay <= 2 sentences`
    );

    const html = renderHud({
      initialState: {
        connected: true,
        live: "open",
        verdict,
        dismissed: false
      }
    });

    const renderedHeadlineMatch = /<h1 class="hud-headline">([^<]*)<\/h1>/.exec(html);
    assert.ok(renderedHeadlineMatch, `${label} must render <h1 class="hud-headline">`);
    const renderedHeadline = decodeHtmlEntities(renderedHeadlineMatch[1]);
    const renderedWords = countWords(renderedHeadline);
    assert.ok(
      renderedWords >= 1 && renderedWords <= MAX_HEADLINE_WORDS,
      `${label} rendered HUD headline "${renderedHeadline}" exceeds 8 words`
    );
    assert.doesNotMatch(renderedHeadline, /[,.;:]+$/);

    const captionMatch = /<p class="hud-speech-caption">([^<]*)<\/p>/.exec(html);
    assert.ok(captionMatch, `${label} must render secondary .hud-speech-caption subline`);
    const renderedCaption = decodeHtmlEntities(captionMatch[1]);
    assert.equal(renderedCaption, sanitizeHudText(verdict.speech));

    const chipCount = (html.match(/<span class="hud-chip/g) ?? []).length;
    if (verdict.read.kind === "food" || verdict.read.kind === "other") {
      assert.equal(chipCount, 0, `${label} non-medication card must omit medication chips`);
    } else {
      assert.ok(chipCount <= 3, `${label} medication card must cap metadata chips at <= 3`);
    }
  }

  const captionCss = selectorDecls(hudCssRules, ".hud-speech-caption");
  assert.equal(captionCss["white-space"], "nowrap");
  assert.equal(captionCss["overflow"], "hidden");
  assert.equal(captionCss["text-overflow"], "ellipsis");
  assert.equal(captionCss["width"], "100%");

  for (const pillSelector of [".hud-status-cluster", ".hud-device-pill", ".hud-session-pill"]) {
    assert.equal(selectorDecls(hudCssRules, pillSelector)["white-space"], "nowrap");
  }

  const overlongHtml = renderHud({
    sessionParam: "session1234567890abcdef",
    initialState: {
      connected: true,
      live: "open",
      device: makeDevice({ battery: 135 }),
      verdict: {
        ...amlodipineMatchVerdict,
        headline: `One two three four five six seven eight nine ten eleven;`,
        speech: `First sentence ${EM_DASH} second clause ${EN_DASH} third detail with extra words for single line ellipsis.`
      }
    }
  });
  assert.ok(
    overlongHtml.includes('<h1 class="hud-headline">One two three four five six seven eight</h1>')
  );
  assert.ok(overlongHtml.includes("SESSION session1"));
  assert.equal(overlongHtml.includes("session123"), false);
  assert.ok(overlongHtml.includes("WORN 100%"));
  assert.equal(
    clampHudHeadline("Alpha beta gamma delta epsilon zeta eta theta iota:"),
    "Alpha beta gamma delta epsilon zeta eta theta"
  );

  const notTakenHtml = renderHud({ initialState: { verdict: amlodipineMatchVerdict } });
  assert.ok(notTakenHtml.includes('data-taken-today="false"'));
  assert.ok(notTakenHtml.includes(">NOT TAKEN TODAY</span>"));

  const takenHtml = renderHud({ initialState: { verdict: amlodipineTakenMatchVerdict } });
  assert.ok(takenHtml.includes('data-taken-today="true"'));
  assert.ok(takenHtml.includes(">TAKEN TODAY</span>"));
});

test("Neural Band spatial focus bar enforces <= 3 action buttons per screen, safe default Repeat focus, and Log Dose gating", () => {
  const actionsCss = selectorDecls(hudCssRules, ".hud-actions");
  assert.equal(actionsCss["display"], "grid");
  assert.equal(actionsCss["grid-template-columns"], "repeat(3, minmax(0, 1fr))");

  const focusCss = selectorDecls(hudCssRules, '.hud-action-btn[data-focused="true"]');
  assert.equal(focusCss["outline"], "4px solid #ffee00");

  const minBtnHeight600 = evalCssLength(
    selectorDecls(hudCssRules, ".hud-action-btn")["min-height"],
    { vw: WAVEGUIDE_WIDTH_PX, vh: WAVEGUIDE_HEIGHT_PX }
  );
  assert.ok(minBtnHeight600 >= 56, `Action button height ${minBtnHeight600}px must be >= 56px`);

  const allCasesWithDismissed: readonly HudMatrixCase[] = [
    ...HUD_MATRIX_CASES,
    {
      id: "dismissed:after_match",
      kind: "idle",
      state: {
        connected: true,
        live: "open",
        verdict: amlodipineMatchVerdict,
        dismissed: true
      },
      expectedMaxAreaRatio: MAX_COACH_FILL_BUDGET,
      expectedLogDoseEnabled: false
    }
  ];

  for (const entry of allCasesWithDismissed) {
    const html = renderHud({ initialState: entry.state });

    const allButtonTags = html.match(/<button\b[^>]*>/gi) ?? [];
    assert.ok(
      allButtonTags.length <= MAX_ACTIONS_PER_CARD,
      `${entry.id} rendered ${allButtonTags.length} buttons, violating <= 3 waveguide cap`
    );
    assert.equal(allButtonTags.length, 3, `${entry.id} must render Log Dose, Repeat, and Dismiss`);

    assert.doesNotMatch(
      html,
      /<(a|input|select|textarea|dialog|menu|ul|ol)\b/i,
      `${entry.id} must not render cluttered links, inputs, or nested lists on waveguide`
    );

    const actionOrder = [...html.matchAll(/data-hud-action="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(actionOrder, ["log_dose", "repeat", "dismiss"]);
    assert.ok(html.includes(">Log Dose</button>"));
    assert.ok(html.includes(">Repeat</button>"));
    assert.ok(html.includes(">Dismiss</button>"));

    const focusedCount = (html.match(/data-focused="true"/g) ?? []).length;
    const ariaCurrentCount = (html.match(/aria-current="true"/g) ?? []).length;
    assert.equal(focusedCount, 1, `${entry.id} must have exactly 1 focused action`);
    assert.equal(ariaCurrentCount, 1, `${entry.id} must mark exactly 1 action aria-current`);

    const repeatBtn = extractActionBtnTag(html, "repeat");
    assert.ok(repeatBtn.includes('data-focused="true"'), `${entry.id} default focus must be Repeat`);
    assert.doesNotMatch(repeatBtn, /\sdisabled(?:=""|\s|>)/);

    const dismissBtn = extractActionBtnTag(html, "dismiss");
    assert.doesNotMatch(dismissBtn, /\sdisabled(?:=""|\s|>)/);

    const logBtn = extractActionBtnTag(html, "log_dose");
    if (entry.expectedLogDoseEnabled) {
      assert.doesNotMatch(logBtn, /\sdisabled(?:=""|\s|>)/, `${entry.id} should enable Log Dose`);
      assert.ok(logBtn.includes('aria-disabled="false"'));
    } else {
      assert.match(logBtn, /\sdisabled(?:=""|\s|>)/, `${entry.id} must disable Log Dose`);
      assert.ok(logBtn.includes('aria-disabled="true"'));
    }
  }

  for (let startIdx = 0; startIdx < MAX_ACTIONS_PER_CARD; startIdx += 1) {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"]) {
      const next = nextFocusIndex(startIdx, MAX_ACTIONS_PER_CARD, key);
      assert.ok(next >= 0 && next < MAX_ACTIONS_PER_CARD);
    }
  }
});

test("Zero localStorage or sessionStorage reads or writes occur during HudApp SSR and across all reduceHudServerMsg transitions", () => {
  assert.equal(hudTsxSource.includes("localStorage"), false);
  assert.equal(hudTsxSource.includes("sessionStorage"), false);
  assert.equal(hudTsxSource.includes("indexedDB"), false);

  const g = globalThis as Record<string, unknown>;
  const prevLocal = Object.getOwnPropertyDescriptor(g, "localStorage");
  const prevSession = Object.getOwnPropertyDescriptor(g, "sessionStorage");

  const localReads: string[] = [];
  const localWrites: string[] = [];
  const sessionReads: string[] = [];
  const sessionWrites: string[] = [];

  const createSpyStorage = (reads: string[], writes: string[]) => {
    const base = {
      length: 0,
      getItem(k: string): string | null {
        reads.push(`getItem:${k}`);
        return null;
      },
      setItem(k: string, v: string): void {
        writes.push(`setItem:${k}=${v}`);
      },
      removeItem(k: string): void {
        writes.push(`removeItem:${k}`);
      },
      clear(): void {
        writes.push("clear");
      },
      key(index: number): string | null {
        reads.push(`key:${index}`);
        return null;
      }
    };
    return new Proxy(base, {
      set(_target, prop, value) {
        writes.push(`set:${String(prop)}=${String(value)}`);
        return true;
      },
      deleteProperty(_target, prop) {
        writes.push(`delete:${String(prop)}`);
        return true;
      }
    });
  };

  Object.defineProperty(g, "localStorage", {
    configurable: true,
    enumerable: true,
    value: createSpyStorage(localReads, localWrites)
  });
  Object.defineProperty(g, "sessionStorage", {
    configurable: true,
    enumerable: true,
    value: createSpyStorage(sessionReads, sessionWrites)
  });

  try {
    for (const entry of HUD_MATRIX_CASES) {
      const html = renderHud({
        sessionParam: "hup-7f3a",
        speak: true,
        initialState: entry.state
      });
      assert.ok(html.length > 100);
    }

    const wireSequence: readonly ServerMsg[] = [
      { type: "status", live: "connecting" },
      { type: "ready", model: "gemini-3.8-live", session: "hup-7f3a" },
      { type: "status", live: "open", detail: "gemini-3.8-live" },
      { type: "device", device: makeDevice({ battery: 78, worn: true }) },
      { type: "coach", cue: "closer", text: "Move the box closer" },
      { type: "coach", cue: "other_side", text: "Flip the box over" },
      { type: "coach", cue: "hold_still", text: "Hold still right there" },
      { type: "checking", phase: "start" },
      { type: "coach", cue: "hold_still", text: "Hold still, reading..." },
      { type: "verdict", verdict: amlodipineMatchVerdict },
      { type: "checking", phase: "end" },
      { type: "verdict", verdict: amlodipineTakenMatchVerdict },
      { type: "verdict", verdict: nsaidAvoidVerdict },
      { type: "verdict", verdict: hazelnutAllergenVerdict },
      { type: "verdict", verdict: occludedDoseVerdict },
      { type: "verdict", verdict: safeOatMilkVerdict },
      { type: "audio", data: "AAAA" },
      { type: "transcript", role: "assistant", text: "Confirmed", final: true },
      { type: "interrupted" },
      { type: "pong", t: 12345 },
      { type: "hud", connected: true },
      { type: "error", code: "quota", message: "Busy", recoverable: true },
      { type: "status", live: "closed" }
    ];

    let state = initialHudState({ speechEnabled: true });
    for (const msg of wireSequence) {
      state = reduceHudServerMsg(state, msg);
      const stepHtml = renderHud({ initialState: state });
      assert.ok(stepHtml.includes('class="hud-root"'));
    }

    assert.equal(localWrites.length, 0, `Unexpected localStorage writes: ${localWrites.join(", ")}`);
    assert.equal(sessionWrites.length, 0, `Unexpected sessionStorage writes: ${sessionWrites.join(", ")}`);
    assert.equal(localReads.length, 0, `Unexpected localStorage reads: ${localReads.join(", ")}`);
    assert.equal(sessionReads.length, 0, `Unexpected sessionStorage reads: ${sessionReads.join(", ")}`);
  } finally {
    if (prevLocal) {
      Object.defineProperty(g, "localStorage", prevLocal);
    } else {
      delete g.localStorage;
    }
    if (prevSession) {
      Object.defineProperty(g, "sessionStorage", prevSession);
    } else {
      delete g.sessionStorage;
    }
  }
});

test("Zero comments and zero em or en dashes exist across HudApp.tsx, hud.css, hudWaveguideBudget.test.ts, and all rendered states", () => {
  const selfSource = readFileSync(new URL("./hudWaveguideBudget.test.ts", import.meta.url), "utf8");

  for (const [name, src] of [
    ["HudApp.tsx", hudTsxSource],
    ["hud.css", hudCssSource],
    ["hudWaveguideBudget.test.ts", selfSource]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${name} must contain zero line comments`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name} must contain zero block comments`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name} must contain zero block comment closures`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${name} must contain zero HTML comments`);
    assert.equal(src.includes(EM_DASH), false, `${name} must contain zero em dashes`);
    assert.equal(src.includes(EN_DASH), false, `${name} must contain zero en dashes`);
  }

  for (const entry of HUD_MATRIX_CASES) {
    const html = renderHud({ initialState: entry.state });
    assert.equal(html.includes(HTML_COMMENT_OPEN), false, `${entry.id} HTML must contain zero comments`);
    assert.equal(html.includes(EM_DASH), false, `${entry.id} HTML must contain zero em dashes`);
    assert.equal(html.includes(EN_DASH), false, `${entry.id} HTML must contain zero en dashes`);

    const visibleText = stripTags(html);
    assert.equal(visibleText.includes(EM_DASH), false);
    assert.equal(visibleText.includes(EN_DASH), false);
  }
});
