import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  clampHudHeadline,
  initialHudState,
  reduceHudServerMsg,
  sanitizeHudText,
  type HudState
} from "../src/hud/HudApp.tsx";
import { STRENGTH_MIN_CONF, checkLabel } from "../../server/src/safety.ts";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  Profile,
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

const SLASH = "\x2f";
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);

const WAVEGUIDE_WIDTH_PX = 600;
const WAVEGUIDE_HEIGHT_PX = 600;
const WAVEGUIDE_AREA_PX = WAVEGUIDE_WIDTH_PX * WAVEGUIDE_HEIGHT_PX;
const MAX_VERDICT_FILL_BUDGET = 0.65;
const MAX_COACH_FILL_BUDGET = 0.35;
const MAX_HEADLINE_WORDS = 8;
const MAX_HEADLINE_CHARS = 72;
const MIN_WAVEGUIDE_CONTRAST = 10;

const FIXED_NOW = new Date("2026-11-14T20:00:00Z");

type CssDecls = Record<string, string>;

type ParsedCssRule = {
  media: string | null;
  selectors: string[];
  declarations: CssDecls;
};

type StressCase = {
  id: string;
  lang: "fi" | "sv" | "en";
  read: LabelRead;
  profile: Profile;
  expectedLevel: VerdictLevel;
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

function srgbToLinear(c8: number): number {
  const s = c8 / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastOnAdditiveBlack(hexColor: string): number {
  const trimmed = hexColor.trim();
  const match = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  assert.ok(match, `Expected 6-digit hex color, got ${hexColor}`);
  const hex = match[1];
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const lum = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  return (lum + 0.05) / 0.05;
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

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
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

function isButtonTagDisabled(buttonTag: string): boolean {
  return /\sdisabled(?:=""|\s|>)/.test(buttonTag);
}

function extractSvgAfter(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `Expected marker ${marker}`);
  const start = html.indexOf("<svg", idx);
  const closeTag = "<" + SLASH + "svg>";
  const end = html.indexOf(closeTag, start);
  assert.ok(start >= 0 && end > start, `Expected <svg> after ${marker}`);
  return html.slice(start, end + closeTag.length);
}

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function makeRead(overrides: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
    ingredient: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
    strength: { value: "50 mg" + " " + SLASH + " " + "12,5 mg", confidence: 0.99 },
    dosing: { value: "1 tabletti aamulla", confidence: 0.94 },
    expiry: { value: "2028-05", confidence: 0.98 },
    allergens: { value: null, confidence: 0.1 },
    barcode: { value: "6432100098765", confidence: 0.99 },
    readability: 0.96,
    guidance: "Kaanna pakkaus hitaasti etupuoli edella.",
    ...overrides
  };
}

const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
const hudTsxSource = readFileSync(new URL("../src/hud/HudApp.tsx", import.meta.url), "utf8");
const hudCssRules = parseCssRules(hudCssSource);

function evaluate600x600Layout(
  html: string,
  mode: "verdict" | "coach" | "standby"
): {
  rootMaxWidthPx: number;
  rootMaxHeightPx: number;
  topbarWidthPx: number;
  actionsWidthPx: number;
  cardWidthPx: number;
  cardHeightPx: number;
  totalUsedHeightPx: number;
  cardBoundingAreaRatio: number;
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

  const rootMaxWidthPx = evalCssLength(rootDecls["max-width"], ctx600);
  const rootMaxHeightPx = evalCssLength(rootDecls["max-height"], ctx600);
  const rootPad = parsePaddingBox(rootDecls["padding"], ctx600);
  const rootGap = evalCssLength(rootDecls["gap"], ctx600);
  const innerViewportWidth = WAVEGUIDE_WIDTH_PX - rootPad.left - rootPad.right;

  const topbarWidthPx = Math.min(
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

  const actionsWidthPx = Math.min(
    innerViewportWidth,
    evalCssLength(actionsDecls["max-width"], ctx600)
  );
  const actionsGap = evalCssLength(actionsDecls["gap"], ctx600);
  const actionBtnHeight = evalCssLength(actionBtnDecls["min-height"], ctx600);
  const actionBtnBorder = parseBorderSpec(actionBtnDecls["border"]).widthPx;
  const actionBtnFontPx = evalCssLength(actionBtnDecls["font-size"], ctx600);
  const singleBtnWidth = (actionsWidthPx - 2 * actionsGap) / 3;

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

  let cardWidthPx = 0;
  let cardHeightPx = 0;
  let stageLitPixels = 0;

  if (mode === "verdict") {
    cardWidthPx = evalCssLength(cardDecls["width"], {
      ...ctx600,
      parentPx: stageWidth
    });
    const cardPad = parsePaddingBox(cardDecls["padding"], ctx600);
    const cardBorderPx = parseBorderSpec(cardDecls["border"]).widthPx;
    const cardGap = evalCssLength(cardDecls["gap"], ctx600);
    const contentWidth = cardWidthPx - cardPad.left - cardPad.right - 2 * cardBorderPx;

    const headerHeight = evalCssLength(shapeFrameDecls["height"], ctx600);
    const headlineRe = new RegExp(`<h1 class="hud-headline">([^<]*)<${SLASH}h1>`);
    const headlineMatch = headlineRe.exec(html);
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

    const chipRe = new RegExp(`<span class="hud-chip[^"]*"[^>]*>([^<]*)<${SLASH}span>`, "g");
    const chipMatches = [...html.matchAll(chipRe)];
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

    const captionRe = new RegExp(`<p class="hud-speech-caption">([^<]*)<${SLASH}p>`);
    const captionMatch = captionRe.exec(html);
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
  } else if (mode === "coach") {
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
    const cueTextRe = new RegExp(`<p class="hud-coach-text">([^<]*)<${SLASH}p>`);
    const cueTextMatch = cueTextRe.exec(html);
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
    const labelRe = new RegExp(`<p class="hud-standby-label">([^<]*)<${SLASH}p>`);
    const labelMatch = labelRe.exec(html);
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
    2 * (topbarWidthPx + topbarHeight) * topbarBorder +
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
    rootMaxWidthPx,
    rootMaxHeightPx,
    topbarWidthPx,
    actionsWidthPx,
    cardWidthPx,
    cardHeightPx,
    totalUsedHeightPx,
    cardBoundingAreaRatio: (cardWidthPx * cardHeightPx) / WAVEGUIDE_AREA_PX,
    litPixelRatio: totalLitPixels / WAVEGUIDE_AREA_PX
  };
}

const COMBO_50_125 = "50 mg" + " " + SLASH + " " + "12,5 mg";
const COMBO_500_125 = "500 mg" + " " + SLASH + " " + "12,5 mg";
const COMBO_1000_50 = "1000 mg" + " " + SLASH + " " + "50 mg";
const COMBO_800_160 = "800 mg" + " " + SLASH + " " + "160 mg";
const COMBO_875_125 = "875 mg" + " " + SLASH + " " + "125 mg";

const NORDIC_BASE_PROFILE: Profile = {
  lang: "fi",
  meds: [
    {
      id: "hctz_los",
      name: "Hydroklooritiatsidi-Losartaani",
      ingredient: "Hydroklooritiatsidi-Losartaani",
      strength: COMBO_50_125,
      schedule: ["morning"]
    },
    {
      id: "met_emp",
      name: "Metformiini-Empagliflotsiini",
      ingredient: "Metformiini-Empagliflotsiini",
      strength: COMBO_500_125,
      schedule: ["morning", "evening"]
    },
    {
      id: "met_sit_sv",
      name: "Metforminhydroklorid-Sitagliptin",
      ingredient: "Metforminhydroklorid-Sitagliptin",
      strength: COMBO_500_125,
      schedule: ["08:00", "20:00"]
    },
    {
      id: "smx_tmp_en",
      name: "Sulfamethoxazole-Trimethoprim",
      ingredient: "Sulfamethoxazole-Trimethoprim",
      strength: COMBO_800_160,
      schedule: ["evening"]
    }
  ],
  allergies: [
    "peanut",
    "tree nut",
    "milk",
    "egg",
    "soy",
    "sesame",
    "penicillin"
  ],
  avoid: ["tulehduskipulaakkeet", "NSAIDs"],
  doseLog: []
};

const PARTIAL_TWICE_DAILY_PROFILE: Profile = {
  ...NORDIC_BASE_PROFILE,
  doseLog: [{ medId: "met_emp", ts: FIXED_NOW.getTime() - 8 * 3600_000 }]
};

const DOUBLE_DOSE_PROFILE: Profile = {
  ...NORDIC_BASE_PROFILE,
  doseLog: [{ medId: "hctz_los", ts: FIXED_NOW.getTime() - 6 * 3600_000 }]
};

const STRESS_CASES: readonly StressCase[] = [
  {
    id: "01_fi_long_compound_match",
    lang: "fi",
    read: makeRead({
      product: { value: "Hydroklooritiatsidi-Losartaani Orion", confidence: 0.99 },
      ingredient: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      strength: { value: COMBO_50_125, confidence: 0.98 }
    }),
    profile: NORDIC_BASE_PROFILE,
    expectedLevel: "match"
  },
  {
    id: "02_fi_combo_500_125_partial_schedule_match",
    lang: "fi",
    read: makeRead({
      product: { value: "Metformiini-Empagliflotsiini", confidence: 0.99 },
      ingredient: { value: "Metformiini-Empagliflotsiini", confidence: 0.99 },
      strength: { value: COMBO_500_125, confidence: 0.99 }
    }),
    profile: PARTIAL_TWICE_DAILY_PROFILE,
    expectedLevel: "match"
  },
  {
    id: "03_fi_six_allergen_trace_list_warning",
    lang: "fi",
    read: makeRead({
      kind: "food",
      product: { value: "Saaristolaisleipa ja Pahkinaleivos", confidence: 0.98 },
      ingredient: { value: "ruisjauho, sokeri, kasvioljy", confidence: 0.95 },
      strength: { value: null, confidence: 0 },
      allergens: {
        value: [
          "saattaa sisaltaa: hasselpahkinaa",
          "voi sisaltaa: maapahkinaa",
          "maitojauhe",
          "kananmunaa",
          "soijalesitiini",
          "seesaminsiemenia"
        ],
        confidence: 0.97
      }
    }),
    profile: NORDIC_BASE_PROFILE,
    expectedLevel: "warning"
  },
  {
    id: "04_sv_six_allergen_trace_list_warning",
    lang: "sv",
    read: makeRead({
      kind: "food",
      product: { value: "Svensk Rostad Frukostmusli", confidence: 0.98 },
      ingredient: { value: "havregryn, solrosolja, honung", confidence: 0.95 },
      strength: { value: null, confidence: 0 },
      allergens: {
        value: [
          "kan innehalla: jordnotter",
          "kan innehalla: hasselnotter",
          "kan innehalla: mandlar",
          "kan innehalla: mjolkpulver",
          "kan innehalla: sojalecitin",
          "kan innehalla: sesamfron"
        ],
        confidence: 0.96
      }
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "sv" },
    expectedLevel: "warning"
  },
  {
    id: "05_fi_expired_compound_pack_warning",
    lang: "fi",
    read: makeRead({
      product: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      ingredient: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      strength: { value: COMBO_50_125, confidence: 0.99 },
      expiry: { value: "2024-11", confidence: 0.98 }
    }),
    profile: NORDIC_BASE_PROFILE,
    expectedLevel: "warning"
  },
  {
    id: "06_sv_wrong_combo_strength_warning",
    lang: "sv",
    read: makeRead({
      product: { value: "Metforminhydroklorid-Sitagliptin", confidence: 0.99 },
      ingredient: { value: "Metforminhydroklorid-Sitagliptin", confidence: 0.99 },
      strength: { value: COMBO_1000_50, confidence: 0.99 }
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "sv" },
    expectedLevel: "warning"
  },
  {
    id: "07_fi_sub_080_strength_refusal_unsure",
    lang: "fi",
    read: makeRead({
      product: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      ingredient: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      strength: { value: COMBO_50_125, confidence: 0.79 },
      readability: 0.68
    }),
    profile: NORDIC_BASE_PROFILE,
    expectedLevel: "unsure"
  },
  {
    id: "08_en_occluded_combo_strength_refusal_unsure",
    lang: "en",
    read: makeRead({
      product: { value: "Sulfamethoxazole-Trimethoprim", confidence: 0.99 },
      ingredient: { value: "Sulfamethoxazole-Trimethoprim", confidence: 0.99 },
      strength: { value: COMBO_800_160, confidence: 0.42 },
      readability: 0.58,
      guidance: "Move your thumb off the combination strength."
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "en" },
    expectedLevel: "unsure"
  },
  {
    id: "09_fi_double_dose_already_taken_warning",
    lang: "fi",
    read: makeRead({
      product: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      ingredient: { value: "Hydroklooritiatsidi-Losartaani", confidence: 0.99 },
      strength: { value: COMBO_50_125, confidence: 0.99 }
    }),
    profile: DOUBLE_DOSE_PROFILE,
    expectedLevel: "warning"
  },
  {
    id: "10_en_penicillin_compound_allergy_warning",
    lang: "en",
    read: makeRead({
      product: { value: "Amoxicillin-Clavulanate Potassium", confidence: 0.99 },
      ingredient: { value: "amoxicillin-clavulanate", confidence: 0.99 },
      strength: { value: COMBO_875_125, confidence: 0.99 }
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "en" },
    expectedLevel: "warning"
  },
  {
    id: "11_sv_safe_oat_drink_info",
    lang: "sv",
    read: makeRead({
      kind: "food",
      product: { value: "Ekologisk Fullkornshavredryck Naturell", confidence: 0.99 },
      ingredient: { value: "vatten, fullkornshavre, rapsolja", confidence: 0.97 },
      strength: { value: null, confidence: 0 },
      expiry: { value: "2027-10-15", confidence: 0.97 },
      allergens: { value: ["havre"], confidence: 0.97 }
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "sv" },
    expectedLevel: "info"
  },
  {
    id: "12_en_safe_six_seed_snack_info",
    lang: "en",
    read: makeRead({
      kind: "food",
      product: { value: "Organic Roasted Chickpea Sunflower Snack", confidence: 0.98 },
      ingredient: {
        value: "chickpea, sunflower seed, quinoa, flaxseed, buckwheat, chia",
        confidence: 0.96
      },
      strength: { value: null, confidence: 0 },
      expiry: { value: "2027-12-20", confidence: 0.98 },
      allergens: {
        value: ["chickpea", "sunflower", "quinoa", "flaxseed", "buckwheat", "chia"],
        confidence: 0.95
      }
    }),
    profile: { ...NORDIC_BASE_PROFILE, lang: "en" },
    expectedLevel: "info"
  }
];

function reduceToHudState(msg: Parameters<typeof reduceHudServerMsg>[1]): HudState {
  const base = {
    ...initialHudState({ speechEnabled: false }),
    connected: true
  };
  const withStatus = reduceHudServerMsg(base, { type: "status", live: "open" });
  const withDevice = reduceHudServerMsg(withStatus, {
    type: "device",
    device: makeDevice()
  });
  return reduceHudServerMsg(withDevice, msg);
}

function assertHorizontalCssRules(): void {
  const ctx600 = { vw: WAVEGUIDE_WIDTH_PX, vh: WAVEGUIDE_HEIGHT_PX };
  const rootDecls = selectorDecls(hudCssRules, ".hud-root");
  const boxSizingDecls = selectorDecls(hudCssRules, ".hud-root *");
  const bodyDecls = selectorDecls(hudCssRules, "body:has(.hud-root)");
  const headlineDecls = selectorDecls(hudCssRules, ".hud-headline");
  const metaRowDecls = selectorDecls(hudCssRules, ".hud-meta-row");
  const captionDecls = selectorDecls(hudCssRules, ".hud-speech-caption");
  const actionsDecls = selectorDecls(hudCssRules, ".hud-actions");

  assert.equal(hudCssSource.includes("600px"), false, "hud.css must use viewport-relative sizing");
  assert.equal(hudCssSource.includes("backdrop-filter"), false, "hud.css forbids waveguide blur scrims");
  assert.equal(boxSizingDecls["box-sizing"], "border-box");
  assert.equal(rootDecls["overflow"], "hidden");
  assert.equal(bodyDecls["overflow"], "hidden");
  assert.equal(evalCssLength(rootDecls["max-width"], ctx600), WAVEGUIDE_WIDTH_PX);
  assert.equal(evalCssLength(rootDecls["max-height"], ctx600), WAVEGUIDE_HEIGHT_PX);

  assert.equal(headlineDecls["overflow-wrap"], "break-word");
  assert.equal(metaRowDecls["flex-wrap"], "wrap");
  assert.equal(captionDecls["white-space"], "nowrap");
  assert.equal(captionDecls["overflow"], "hidden");
  assert.equal(captionDecls["text-overflow"], "ellipsis");
  assert.equal(captionDecls["width"], "100%");
  assert.equal(actionsDecls["display"], "grid");
  assert.equal(actionsDecls["grid-template-columns"], "repeat(3, minmax(0, 1fr))");
}

test("12 Nordic (fi/sv/en) checkLabel stress verdicts fed through reduceHudServerMsg and HudApp SSR obey <= 8 words, <= 72 chars, and 600x600 waveguide bounds", () => {
  assertHorizontalCssRules();
  assert.equal(STRESS_CASES.length, 12);
  assert.equal(STRENGTH_MIN_CONF, 0.8);

  const seenLangs = new Set<string>();
  const seenLevels = new Set<VerdictLevel>();

  for (const item of STRESS_CASES) {
    seenLangs.add(item.lang);
    const verdict = checkLabel(item.read, item.profile, FIXED_NOW);
    assert.equal(
      verdict.level,
      item.expectedLevel,
      `${item.id}: expected checkLabel level ${item.expectedLevel}, got ${verdict.level}`
    );
    seenLevels.add(verdict.level);

    const hudState = reduceToHudState({ type: "verdict", verdict });
    assert.equal(hudState.verdict, verdict);
    assert.equal(hudState.dismissed, false);
    assert.equal(hudState.coach, null);

    const html = renderToStaticMarkup(createElement(HudApp, { initialState: hudState }));
    assert.match(html, /^<main\b[^>]*class="hud-root"/);
    assert.ok(html.includes('data-hud-surface="600x600-additive"'));
    assert.equal(html.includes("undefined"), false, `${item.id}: must not emit undefined`);
    assert.equal(html.includes("NaN"), false, `${item.id}: must not emit NaN`);

    const inlineBgMatches = [...html.matchAll(/background(?:-color)?:\s*([^;"']+)/gi)];
    assert.ok(inlineBgMatches.length >= 2, `${item.id}: expected inline #000000 backgrounds`);
    for (const bg of inlineBgMatches) {
      assert.equal(bg[1].trim().toLowerCase(), "#000000", `${item.id}: waveguide background must be #000000`);
    }

    const headlineRe = new RegExp(`<h1 class="hud-headline">([^<]*)<${SLASH}h1>`);
    const headlineMatch = headlineRe.exec(html);
    assert.ok(headlineMatch, `${item.id}: missing .hud-headline`);
    const renderedHeadline = decodeHtmlEntities(headlineMatch[1]);
    const wordCount = countWords(renderedHeadline);

    assert.ok(
      wordCount >= 1 && wordCount <= MAX_HEADLINE_WORDS,
      `${item.id}: headline "${renderedHeadline}" has ${wordCount} words (expected 1..8)`
    );
    assert.ok(
      renderedHeadline.length >= 1 && renderedHeadline.length <= MAX_HEADLINE_CHARS,
      `${item.id}: headline "${renderedHeadline}" has ${renderedHeadline.length} chars (expected <= 72)`
    );
    assert.doesNotMatch(renderedHeadline, /[,.;:]+$/, `${item.id}: trailing punctuation not stripped`);
    assert.equal(renderedHeadline, clampHudHeadline(verdict.headline));

    const layout = evaluate600x600Layout(html, "verdict");
    assert.equal(layout.rootMaxWidthPx, WAVEGUIDE_WIDTH_PX);
    assert.equal(layout.rootMaxHeightPx, WAVEGUIDE_HEIGHT_PX);
    assert.ok(layout.topbarWidthPx <= WAVEGUIDE_WIDTH_PX, `${item.id}: topbar exceeds 600px`);
    assert.ok(layout.actionsWidthPx <= WAVEGUIDE_WIDTH_PX, `${item.id}: actions exceed 600px`);
    assert.ok(layout.cardWidthPx <= WAVEGUIDE_WIDTH_PX, `${item.id}: card width exceeds 600px`);
    assert.ok(
      layout.totalUsedHeightPx <= WAVEGUIDE_HEIGHT_PX,
      `${item.id}: vertical height ${layout.totalUsedHeightPx.toFixed(2)}px exceeds 600px`
    );
    assert.ok(
      layout.cardBoundingAreaRatio <= MAX_VERDICT_FILL_BUDGET,
      `${item.id}: card bounding ratio ${layout.cardBoundingAreaRatio.toFixed(4)} exceeds 0.65`
    );
    assert.ok(
      layout.litPixelRatio > 0 && layout.litPixelRatio <= MAX_VERDICT_FILL_BUDGET,
      `${item.id}: lit pixel ratio ${layout.litPixelRatio.toFixed(4)} outside (0, 0.65]`
    );

    const logBtn = extractActionBtnTag(html, "log_dose");
    const expectedCanLogDose = Boolean(
      !hudState.dismissed && verdict.matchedMedId && !verdict.takenToday
    );
    assert.equal(
      isButtonTagDisabled(logBtn),
      !expectedCanLogDose,
      `${item.id}: unexpected Log Dose disabled state`
    );
  }

  assert.deepEqual([...seenLangs].sort(), ["en", "fi", "sv"]);
  assert.deepEqual([...seenLevels].sort(), ["info", "match", "unsure", "warning"]);
});

test("All 8 CoachCue states and standby rendered via reduceHudServerMsg stay within <= 35% waveguide budget and <= 600x600 bounds with pairwise-distinct cues", () => {
  const coachCues: ReadonlyArray<{ cue: CoachCue; expectedBadge: string; text: string }> = [
    { cue: "rotate_left", expectedBadge: "ROTATE LEFT", text: "Kaanna pakkausta vasemmalle" },
    { cue: "rotate_right", expectedBadge: "ROTATE RIGHT", text: "Vrid forpackningen at hoger" },
    { cue: "closer", expectedBadge: "MOVE CLOSER", text: "Tuo laakepakkaus lahemmaksi" },
    { cue: "farther", expectedBadge: "MOVE FARTHER", text: "Hall forpackningen lite langre bort" },
    { cue: "more_light", expectedBadge: "MORE LIGHT", text: "Turn toward brighter room light" },
    { cue: "hold_still", expectedBadge: "HOLD STILL", text: "Pida pakkaus paikallaan hetki" },
    { cue: "other_side", expectedBadge: "OTHER SIDE", text: "Vand forpackningen till framsidan" },
    { cue: "ok", expectedBadge: "LOCKED ON", text: "Label sharp, verifying now" }
  ];

  assert.equal(coachCues.length, 8);
  const normalizedCoachSvgs = new Set<string>();
  const coachBadges = new Set<string>();

  for (const entry of coachCues) {
    const hudState = reduceToHudState({
      type: "coach",
      cue: entry.cue,
      text: entry.text
    });
    const html = renderToStaticMarkup(createElement(HudApp, { initialState: hudState }));

    assert.ok(html.includes(`data-coach-cue="${entry.cue}"`));
    assert.ok(html.includes(`>${entry.expectedBadge}<${SLASH}span>`));
    assert.ok(html.includes(`>${sanitizeHudText(entry.text)}<${SLASH}p>`));
    assert.equal(html.includes('class="hud-headline"'), false);

    const svg = extractSvgAfter(html, `data-coach-cue="${entry.cue}"`);
    const colorNeutralSvg = svg
      .replace(/stroke="[^"]+"/g, 'stroke="currentColor"')
      .replace(/fill="[^"]+"/g, 'fill="currentColor"');
    normalizedCoachSvgs.add(colorNeutralSvg);
    coachBadges.add(entry.expectedBadge);

    const layout = evaluate600x600Layout(html, "coach");
    assert.ok(layout.cardWidthPx <= WAVEGUIDE_WIDTH_PX);
    assert.ok(layout.totalUsedHeightPx <= WAVEGUIDE_HEIGHT_PX);
    assert.ok(
      layout.cardBoundingAreaRatio <= MAX_COACH_FILL_BUDGET,
      `Coach ${entry.cue} area ratio ${layout.cardBoundingAreaRatio.toFixed(4)} exceeds 0.35`
    );
    assert.ok(layout.litPixelRatio > 0 && layout.litPixelRatio <= MAX_VERDICT_FILL_BUDGET);

    const logBtn = extractActionBtnTag(html, "log_dose");
    assert.equal(isButtonTagDisabled(logBtn), true);
  }

  assert.equal(normalizedCoachSvgs.size, 8, "All 8 CoachCue states must render distinct SVG geometry");
  assert.equal(coachBadges.size, 8, "All 8 CoachCue states must render distinct uppercase badges");

  const standbyHtml = renderToStaticMarkup(
    createElement(HudApp, { initialState: initialHudState() })
  );
  const standbyLayout = evaluate600x600Layout(standbyHtml, "standby");
  assert.ok(standbyLayout.cardWidthPx <= WAVEGUIDE_WIDTH_PX);
  assert.ok(standbyLayout.totalUsedHeightPx <= WAVEGUIDE_HEIGHT_PX);
  assert.ok(standbyLayout.cardBoundingAreaRatio <= MAX_COACH_FILL_BUDGET);
});

test("Pairwise comparison across match, warning, unsure, and info proves all 4 encoding channels differ simultaneously across all 6 level pairs", () => {
  const representativeVerdicts: Record<VerdictLevel, Verdict> = {
    match: checkLabel(STRESS_CASES[0].read, STRESS_CASES[0].profile, FIXED_NOW),
    warning: checkLabel(STRESS_CASES[2].read, STRESS_CASES[2].profile, FIXED_NOW),
    unsure: checkLabel(STRESS_CASES[6].read, STRESS_CASES[6].profile, FIXED_NOW),
    info: checkLabel(STRESS_CASES[10].read, STRESS_CASES[10].profile, FIXED_NOW)
  };

  const levels: readonly VerdictLevel[] = ["match", "warning", "unsure", "info"];
  const rootCss = selectorDecls(hudCssRules, ".hud-root");

  type ExtractedChannels = {
    level: VerdictLevel;
    svgGeometryMarkup: string;
    shapeToken: string;
    badgeText: string;
    cardBorderSignature: string;
    badgeBorderSignature: string;
    cardBorderToken: string;
    accentColorToken: string;
  };

  const extracted: ExtractedChannels[] = levels.map((level) => {
    const verdict = representativeVerdicts[level];
    assert.equal(verdict.level, level);

    const hudState = reduceToHudState({ type: "verdict", verdict });
    const html = renderToStaticMarkup(createElement(HudApp, { initialState: hudState }));

    const shapeMatch = /data-verdict-shape="([^"]+)"/.exec(html);
    assert.ok(shapeMatch, `Missing data-verdict-shape for ${level}`);
    const shapeToken = shapeMatch[1];

    const rawSvg = extractSvgAfter(html, `data-shape="${shapeToken}"`);
    assert.match(rawSvg, /<(?:path|polygon|circle|rect)\b/);
    const strokeWidths = [...rawSvg.matchAll(/stroke-width="([0-9.]+)"/gi)].map((m) =>
      Number.parseFloat(m[1])
    );
    assert.ok(strokeWidths.length >= 2);
    for (const sw of strokeWidths) {
      assert.ok(sw >= 3.5, `${level} SVG stroke ${sw}px must be >= 3.5px`);
    }

    const svgGeometryMarkup = rawSvg
      .replace(/stroke="[^"]+"/g, 'stroke="currentColor"')
      .replace(/fill="[^"]+"/g, 'fill="currentColor"');

    const badgeRe = new RegExp(
      `<span class="hud-badge hud-badge--${level}" style="color:([^;"]+);border-color:([^"]+)">([^<]+)<${SLASH}span>`
    );
    const badgeMatch = badgeRe.exec(html);
    assert.ok(badgeMatch, `Missing .hud-badge--${level} in SSR HTML`);
    const inlineBadgeColor = badgeMatch[1].trim().toLowerCase();
    const inlineBadgeBorderColor = badgeMatch[2].trim().toLowerCase();
    const badgeText = badgeMatch[3];

    assert.match(badgeText, /^[A-Z]+$/, `${level} badge "${badgeText}" must be strictly uppercase`);
    assert.equal(inlineBadgeColor, inlineBadgeBorderColor);

    const cardCss = selectorDecls(hudCssRules, `.hud-card--${level}`);
    const badgeCss = selectorDecls(hudCssRules, `.hud-badge--${level}`);
    const cardBorder = parseBorderSpec(cardCss["border"]);
    const badgeBorder = parseBorderSpec(badgeCss["border"]);
    const cssCustomToken = rootCss[`--hud-${level}`]?.trim().toLowerCase();

    assert.equal(cardBorder.color.toLowerCase(), inlineBadgeColor);
    assert.equal(badgeBorder.color.toLowerCase(), inlineBadgeColor);
    assert.equal(badgeCss["color"]?.trim().toLowerCase(), inlineBadgeColor);
    assert.equal(cssCustomToken, inlineBadgeColor);
    assert.ok(html.includes(`border-color:${inlineBadgeColor}`));

    const contrast = contrastOnAdditiveBlack(inlineBadgeColor);
    assert.ok(
      contrast >= MIN_WAVEGUIDE_CONTRAST,
      `${level} color ${inlineBadgeColor} contrast ${contrast.toFixed(2)}:1 < 10:1`
    );

    return {
      level,
      svgGeometryMarkup,
      shapeToken,
      badgeText,
      cardBorderSignature: `${cardBorder.style}|${cardCss["border-radius"]}`,
      badgeBorderSignature: `${badgeBorder.style}|${badgeCss["border-radius"]}`,
      cardBorderToken: `${cardCss["border"]}|${cardCss["border-radius"]}`,
      accentColorToken: inlineBadgeColor
    };
  });

  let pairCount = 0;
  for (let i = 0; i < extracted.length; i += 1) {
    for (let j = i + 1; j < extracted.length; j += 1) {
      const a = extracted[i];
      const b = extracted[j];
      const pairLabel = `${a.level} vs ${b.level}`;

      assert.notEqual(
        a.svgGeometryMarkup,
        b.svgGeometryMarkup,
        `${pairLabel}: Channel 1 SVG geometry markup must differ`
      );
      assert.notEqual(
        a.shapeToken,
        b.shapeToken,
        `${pairLabel}: Channel 1 shape silhouette token must differ`
      );
      assert.notEqual(
        a.badgeText,
        b.badgeText,
        `${pairLabel}: Channel 2 uppercase text badge must differ`
      );
      assert.notEqual(
        a.cardBorderSignature,
        b.cardBorderSignature,
        `${pairLabel}: Channel 3 card CSS border style/radius signature must differ`
      );
      assert.notEqual(
        a.badgeBorderSignature,
        b.badgeBorderSignature,
        `${pairLabel}: Channel 3 badge CSS border style/radius signature must differ`
      );
      assert.notEqual(
        a.cardBorderToken,
        b.cardBorderToken,
        `${pairLabel}: Channel 3 CSS border token must differ`
      );
      assert.notEqual(
        a.accentColorToken,
        b.accentColorToken,
        `${pairLabel}: Channel 4 foreground/accent color token must differ`
      );
      pairCount += 1;
    }
  }

  assert.equal(pairCount, 6, "Must verify all 6 unordered VerdictLevel pairs");
});

test("Zero comments and zero em or en dashes exist in hudOpticalOverflowAudit.test.ts, HudApp.tsx, and hud.css", () => {
  const selfSource = readFileSync(
    new URL("./hudOpticalOverflowAudit.test.ts", import.meta.url),
    "utf8"
  );

  for (const [name, src] of [
    ["hudOpticalOverflowAudit.test.ts", selfSource],
    ["HudApp.tsx", hudTsxSource],
    ["hud.css", hudCssSource]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${name} must contain zero line comments`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name} must contain zero block comments`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name} must contain zero block comment closers`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${name} must contain zero HTML comments`);
    assert.equal(src.includes(EM_DASH), false, `${name} must contain zero em dashes`);
    assert.equal(src.includes(EN_DASH), false, `${name} must contain zero en dashes`);
  }
});
