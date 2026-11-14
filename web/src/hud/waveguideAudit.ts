import type { CoachCue, VerdictLevel } from "../../../shared/types.ts";
import { clampHudHeadline, sanitizeHudText, type HudState } from "./HudApp.tsx";

export const WAVEGUIDE_OPTICAL_SPEC = Object.freeze({
  viewportPx: 600,
  maxVerdictFillRatio: 0.65,
  maxCoachFillRatio: 0.35,
  maxStandbyFillRatio: 0.08,
  minContrastRatio: 10,
  maxHeadlineWords: 8,
  maxHistoryEntries: 2
} as const);

export type HudDisplayMode = "standby" | "coach" | "verdict";

export type WaveguideBloomRisk = "minimal" | "controlled" | "elevated";

export type HudMultimodalChannels = {
  shape: string;
  badge: string;
  color: string;
  hasVectorIcon: boolean;
};

export type HudLitBudgetReport = {
  mode: HudDisplayMode;
  cardAreaRatio: number;
  activeLitPixelRatio: number;
  maxAllowedAreaRatio: number;
  withinFillBudget: boolean;
  bloomRisk: WaveguideBloomRisk;
  accentHex: string;
  contrastRatio: number;
  meetsContrastGate: boolean;
  headlineWordCount: number;
  withinWordCap: boolean;
  multimodalChannels: HudMultimodalChannels | null;
};

export type HudHistoryAuditReport = {
  entries: number;
  withinCap: boolean;
  hardwareLimit: 5;
  appCap: 2;
};

type Rgb8 = {
  r: number;
  g: number;
  b: number;
};

const HARDWARE_HISTORY_LIMIT = 5 as const;
const APP_HISTORY_CAP = 2 as const;
const DEFAULT_WAVEGUIDE_BG_HEX = "#000000";
const STANDBY_ACCENT_HEX = "#22ff88";

const VIEWPORT_AREA_PX =
  WAVEGUIDE_OPTICAL_SPEC.viewportPx * WAVEGUIDE_OPTICAL_SPEC.viewportPx;
const ROOT_PAD_PX = 16.8;
const ROOT_GAP_PX = 12;
const TOPBAR_WIDTH_PX = 560;
const TOPBAR_HEIGHT_PX = 40.28;
const TOPBAR_BORDER_PX = 2;
const TOPBAR_FONT_PX = 14.4;
const ACTION_BAR_WIDTH_PX = 560;
const ACTION_BAR_GAP_PX = 12;
const ACTION_BTN_HEIGHT_PX = 68;
const ACTION_BTN_BORDER_PX = 2.5;
const ACTION_BTN_FONT_PX = 20.4;
const SINGLE_ACTION_BTN_WIDTH_PX =
  (ACTION_BAR_WIDTH_PX - 2 * ACTION_BAR_GAP_PX) / 3;
const STAGE_MAX_HEIGHT_PX =
  WAVEGUIDE_OPTICAL_SPEC.viewportPx -
  2 * ROOT_PAD_PX -
  TOPBAR_HEIGHT_PX -
  ACTION_BTN_HEIGHT_PX -
  2 * ROOT_GAP_PX;

const VERDICT_CARD_WIDTH_PX = 515.2;
const VERDICT_CARD_PAD_PX = 20.4;
const VERDICT_CARD_BORDER_PX = 4;
const VERDICT_CARD_GAP_PX = 13.2;
const VERDICT_CONTENT_WIDTH_PX =
  VERDICT_CARD_WIDTH_PX - 2 * VERDICT_CARD_PAD_PX - 2 * VERDICT_CARD_BORDER_PX;
const VERDICT_HEADER_HEIGHT_PX = 45.6;
const VERDICT_HEADLINE_FONT_PX = 33;
const VERDICT_HEADLINE_LINE_H = 1.15;
const VERDICT_CHIP_FONT_PX = 17.4;
const VERDICT_CHIP_ROW_H = 32.88;
const VERDICT_CAPTION_FONT_PX = 18;
const VERDICT_CAPTION_HEIGHT_PX = 23.04;

const COACH_CARD_WIDTH_PX = 440;
const COACH_CARD_PAD_PX = 22.8;
const COACH_CARD_BORDER_PX = 3.5;
const COACH_CARD_GAP_PX = 13.2;
const COACH_CONTENT_WIDTH_PX =
  COACH_CARD_WIDTH_PX - 2 * COACH_CARD_PAD_PX - 2 * COACH_CARD_BORDER_PX;
const COACH_SVG_SIZE_PX = 76;
const COACH_BADGE_FONT_PX = 15.6;
const COACH_BADGE_HEIGHT_PX = 18.72;
const COACH_TEXT_FONT_PX = 27.6;
const COACH_TEXT_LINE_H = 1.2;

const STANDBY_RETICLE_PX = 96;
const STANDBY_LABEL_TEXT = "HoldUp Ready: Hold item in view";
const STANDBY_LABEL_FONT_PX = 22.8;

const ELEVATED_VERDICT_AREA_THRESHOLD = 0.6;
const ELEVATED_LIT_PIXEL_THRESHOLD = 0.2;

const VERDICT_CHANNEL_TABLE: Readonly<
  Record<VerdictLevel, Readonly<HudMultimodalChannels>>
> = Object.freeze({
  match: Object.freeze({
    shape: "circle",
    badge: "MATCH",
    color: "#22ff88",
    hasVectorIcon: true
  }),
  warning: Object.freeze({
    shape: "triangle",
    badge: "WARNING",
    color: "#ffbb22",
    hasVectorIcon: true
  }),
  unsure: Object.freeze({
    shape: "diamond",
    badge: "UNSURE",
    color: "#38d6ff",
    hasVectorIcon: true
  }),
  info: Object.freeze({
    shape: "square",
    badge: "INFO",
    color: "#f0f6ff",
    hasVectorIcon: true
  })
});

const COACH_BADGE_TABLE: Readonly<Record<CoachCue, string>> = Object.freeze({
  rotate_left: "ROTATE LEFT",
  rotate_right: "ROTATE RIGHT",
  closer: "MOVE CLOSER",
  farther: "MOVE FARTHER",
  more_light: "MORE LIGHT",
  hold_still: "HOLD STILL",
  other_side: "OTHER SIDE",
  ok: "LOCKED ON"
});

function parseHexRgb(rawHex: string): Rgb8 {
  if (typeof rawHex !== "string") {
    throw new Error("Expected hex color string");
  }
  const trimmed = rawHex.trim();
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid hex color: ${rawHex}`);
  }
  const digits = match[1];
  if (digits.length === 3) {
    return {
      r: Number.parseInt(digits[0] + digits[0], 16),
      g: Number.parseInt(digits[1] + digits[1], 16),
      b: Number.parseInt(digits[2] + digits[2], 16)
    };
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16)
  };
}

function srgbChannelToLinear(channel8Bit: number): number {
  const normalized = channel8Bit / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function computeRelativeLuminance(hex: string): number {
  const { r, g, b } = parseHexRgb(hex);
  const linearR = srgbChannelToLinear(r);
  const linearG = srgbChannelToLinear(g);
  const linearB = srgbChannelToLinear(b);
  const luminance = 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
  return Math.min(1, Math.max(0, luminance));
}

export function computeWaveguideContrast(
  fgHex: string,
  bgHex: string = DEFAULT_WAVEGUIDE_BG_HEX
): number {
  const lumFg = computeRelativeLuminance(fgHex);
  const lumBg = computeRelativeLuminance(bgHex);
  const lighter = Math.max(lumFg, lumBg);
  const darker = Math.min(lumFg, lumBg);
  return (lighter + 0.05) / (darker + 0.05);
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function resolveCoachAccentHex(cue: CoachCue): string {
  if (cue === "ok") {
    return "#22ff88";
  }
  if (cue === "more_light") {
    return "#ffbb22";
  }
  return "#38d6ff";
}

function estimateChromeLitPixels(state: HudState): number {
  const connChars = state.connected
    ? state.live === "open"
      ? 8
      : state.live === "reconnecting" || state.live === "degraded"
        ? 4 + state.live.length
        : 8
    : 12;
  const sessionChars = state.speechEnabled ? 20 : 12;
  const deviceChars = state.device ? 9 : 15;
  const topbarTextChars = connChars + sessionChars + deviceChars;

  const topbarBorderLit =
    2 * (TOPBAR_WIDTH_PX + TOPBAR_HEIGHT_PX) * TOPBAR_BORDER_PX * 0.28;
  const topbarDotLit = Math.PI * 25;
  const topbarInkLit = topbarTextChars * TOPBAR_FONT_PX * TOPBAR_FONT_PX * 0.24;

  const buttonBordersLit =
    3 *
    2 *
    (SINGLE_ACTION_BTN_WIDTH_PX + ACTION_BTN_HEIGHT_PX) *
    ACTION_BTN_BORDER_PX *
    0.56;
  const focusOutlineLit =
    2 * (SINGLE_ACTION_BTN_WIDTH_PX + 6 + ACTION_BTN_HEIGHT_PX + 6) * 4;
  const focusTintLit = SINGLE_ACTION_BTN_WIDTH_PX * ACTION_BTN_HEIGHT_PX * 0.14;
  const buttonLabelsLit = 21 * ACTION_BTN_FONT_PX * ACTION_BTN_FONT_PX * 0.26;

  return (
    topbarBorderLit +
    topbarDotLit +
    topbarInkLit +
    buttonBordersLit +
    focusOutlineLit +
    focusTintLit +
    buttonLabelsLit
  );
}

function classifyBloomRisk(
  mode: HudDisplayMode,
  cardAreaRatio: number,
  activeLitPixelRatio: number,
  withinFillBudget: boolean
): WaveguideBloomRisk {
  if (
    !withinFillBudget ||
    cardAreaRatio > ELEVATED_VERDICT_AREA_THRESHOLD ||
    activeLitPixelRatio > ELEVATED_LIT_PIXEL_THRESHOLD
  ) {
    return "elevated";
  }
  if (
    mode === "standby" &&
    cardAreaRatio <= WAVEGUIDE_OPTICAL_SPEC.maxStandbyFillRatio &&
    activeLitPixelRatio <= WAVEGUIDE_OPTICAL_SPEC.maxStandbyFillRatio
  ) {
    return "minimal";
  }
  return "controlled";
}

export function estimateHudLitBudget(state: HudState): HudLitBudgetReport {
  const chromeLitPixels = estimateChromeLitPixels(state);
  const activeVerdict = state.verdict && !state.dismissed ? state.verdict : null;

  if (activeVerdict) {
    const channelSpec = VERDICT_CHANNEL_TABLE[activeVerdict.level];
    const clampedHeadline = clampHudHeadline(activeVerdict.headline);
    const headlineWordCount = countWords(clampedHeadline);
    const withinWordCap =
      headlineWordCount <= WAVEGUIDE_OPTICAL_SPEC.maxHeadlineWords;

    const headlineLines = Math.max(
      1,
      Math.ceil(
        (clampedHeadline.length * VERDICT_HEADLINE_FONT_PX * 0.56) /
          VERDICT_CONTENT_WIDTH_PX
      )
    );
    const headlineHeightPx =
      headlineLines * VERDICT_HEADLINE_FONT_PX * VERDICT_HEADLINE_LINE_H;

    let childrenCount = 2;
    let childrenHeightSum = VERDICT_HEADER_HEIGHT_PX + headlineHeightPx;

    const read = activeVerdict.read;
    const isMedication =
      read?.kind === "medication" ||
      Boolean(activeVerdict.matchedMedId) ||
      typeof activeVerdict.takenToday === "boolean";
    const productText = sanitizeHudText(read?.product?.value ?? "");
    const strengthText = sanitizeHudText(read?.strength?.value ?? "");
    const chips: string[] = [];
    if (isMedication) {
      if (productText) {
        chips.push(productText);
      }
      if (strengthText) {
        chips.push(strengthText);
      }
      if (typeof activeVerdict.takenToday === "boolean") {
        chips.push(
          activeVerdict.takenToday ? "TAKEN TODAY" : "NOT TAKEN TODAY"
        );
      }
    }

    if (chips.length > 0) {
      childrenCount += 1;
      const totalChipWidthPx = chips.reduce(
        (sum, text) =>
          sum +
          Math.min(
            VERDICT_CONTENT_WIDTH_PX,
            text.length * VERDICT_CHIP_FONT_PX * 0.58 + 24
          ) +
          8,
        0
      );
      const chipRows = Math.max(
        1,
        Math.ceil(totalChipWidthPx / VERDICT_CONTENT_WIDTH_PX)
      );
      childrenHeightSum +=
        chipRows * VERDICT_CHIP_ROW_H + (chipRows - 1) * 8;
    }

    const speechCaption = sanitizeHudText(activeVerdict.speech ?? "");
    if (speechCaption.length > 0) {
      childrenCount += 1;
      childrenHeightSum += VERDICT_CAPTION_HEIGHT_PX;
    }

    const rawCardHeightPx =
      2 * VERDICT_CARD_BORDER_PX +
      2 * VERDICT_CARD_PAD_PX +
      childrenHeightSum +
      (childrenCount - 1) * VERDICT_CARD_GAP_PX;
    const cardHeightPx = Math.min(STAGE_MAX_HEIGHT_PX, rawCardHeightPx);
    const cardAreaRatio =
      (VERDICT_CARD_WIDTH_PX * cardHeightPx) / VIEWPORT_AREA_PX;

    const cardPerimeterLit =
      2 * (VERDICT_CARD_WIDTH_PX + cardHeightPx) * VERDICT_CARD_BORDER_PX;
    const iconAndBadgeLit = 40 * 40 * 0.24 + 140 * 34 * 0.36;
    const headlineInkLit =
      clampedHeadline.length *
      VERDICT_HEADLINE_FONT_PX *
      VERDICT_HEADLINE_FONT_PX *
      0.28;
    const chipsChars = chips.reduce(
      (sum, chip) => sum + Math.min(36, chip.length),
      0
    );
    const chipsLit =
      chipsChars * VERDICT_CHIP_FONT_PX * VERDICT_CHIP_FONT_PX * 0.26 +
      chips.length * 240;
    const visibleCaptionChars = Math.min(46, speechCaption.length);
    const captionInkLit =
      visibleCaptionChars *
      VERDICT_CAPTION_FONT_PX *
      VERDICT_CAPTION_FONT_PX *
      0.26;
    const stageLitPixels =
      cardPerimeterLit +
      iconAndBadgeLit +
      headlineInkLit +
      chipsLit +
      captionInkLit;

    const activeLitPixelRatio = Math.min(
      cardAreaRatio,
      (chromeLitPixels + stageLitPixels) / VIEWPORT_AREA_PX
    );
    const maxAllowedAreaRatio = WAVEGUIDE_OPTICAL_SPEC.maxVerdictFillRatio;
    const withinFillBudget =
      cardAreaRatio <= maxAllowedAreaRatio &&
      activeLitPixelRatio <= maxAllowedAreaRatio;
    const accentHex = channelSpec.color;
    const contrastRatio = computeWaveguideContrast(accentHex);
    const meetsContrastGate =
      contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio;

    return {
      mode: "verdict",
      cardAreaRatio,
      activeLitPixelRatio,
      maxAllowedAreaRatio,
      withinFillBudget,
      bloomRisk: classifyBloomRisk(
        "verdict",
        cardAreaRatio,
        activeLitPixelRatio,
        withinFillBudget
      ),
      accentHex,
      contrastRatio,
      meetsContrastGate,
      headlineWordCount,
      withinWordCap,
      multimodalChannels: {
        shape: channelSpec.shape,
        badge: channelSpec.badge,
        color: channelSpec.color,
        hasVectorIcon: channelSpec.hasVectorIcon
      }
    };
  }

  if (state.coach) {
    const cue = state.coach.cue;
    const cueText = sanitizeHudText(state.coach.text);
    const headlineWordCount = countWords(cueText);
    const withinWordCap =
      headlineWordCount <= WAVEGUIDE_OPTICAL_SPEC.maxHeadlineWords;

    const cueLines = Math.max(
      1,
      Math.ceil(
        (cueText.length * COACH_TEXT_FONT_PX * 0.56) / COACH_CONTENT_WIDTH_PX
      )
    );
    const rawCoachHeightPx =
      2 * COACH_CARD_BORDER_PX +
      2 * COACH_CARD_PAD_PX +
      COACH_SVG_SIZE_PX +
      COACH_BADGE_HEIGHT_PX +
      cueLines * COACH_TEXT_FONT_PX * COACH_TEXT_LINE_H +
      2 * COACH_CARD_GAP_PX;
    const cardHeightPx = Math.min(STAGE_MAX_HEIGHT_PX, rawCoachHeightPx);
    const cardAreaRatio =
      (COACH_CARD_WIDTH_PX * cardHeightPx) / VIEWPORT_AREA_PX;

    const coachBorderLit =
      2 * (COACH_CARD_WIDTH_PX + cardHeightPx) * COACH_CARD_BORDER_PX;
    const coachSvgLit = COACH_SVG_SIZE_PX * COACH_SVG_SIZE_PX * 0.2;
    const badgeLabel = COACH_BADGE_TABLE[cue] ?? "COACH";
    const badgeInkLit =
      badgeLabel.length * COACH_BADGE_FONT_PX * COACH_BADGE_FONT_PX * 0.26;
    const visibleCueChars = Math.min(cueText.length, cueLines * 26);
    const cueInkLit =
      visibleCueChars * COACH_TEXT_FONT_PX * COACH_TEXT_FONT_PX * 0.24;
    const stageLitPixels =
      coachBorderLit + coachSvgLit + badgeInkLit + cueInkLit;

    const activeLitPixelRatio = Math.min(
      cardAreaRatio,
      (chromeLitPixels + stageLitPixels) / VIEWPORT_AREA_PX
    );
    const maxAllowedAreaRatio = WAVEGUIDE_OPTICAL_SPEC.maxCoachFillRatio;
    const withinFillBudget =
      cardAreaRatio <= maxAllowedAreaRatio &&
      activeLitPixelRatio <= maxAllowedAreaRatio;
    const accentHex = resolveCoachAccentHex(cue);
    const contrastRatio = computeWaveguideContrast(accentHex);
    const meetsContrastGate =
      contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio;

    return {
      mode: "coach",
      cardAreaRatio,
      activeLitPixelRatio,
      maxAllowedAreaRatio,
      withinFillBudget,
      bloomRisk: classifyBloomRisk(
        "coach",
        cardAreaRatio,
        activeLitPixelRatio,
        withinFillBudget
      ),
      accentHex,
      contrastRatio,
      meetsContrastGate,
      headlineWordCount,
      withinWordCap,
      multimodalChannels: null
    };
  }

  const reticleBoxAreaPx = STANDBY_RETICLE_PX * STANDBY_RETICLE_PX;
  const standbyLabelStripAreaPx =
    STANDBY_LABEL_TEXT.length *
    STANDBY_LABEL_FONT_PX *
    0.52 *
    STANDBY_LABEL_FONT_PX;
  const cardAreaRatio =
    (reticleBoxAreaPx + standbyLabelStripAreaPx) / VIEWPORT_AREA_PX;

  const reticleStrokeLit = reticleBoxAreaPx * 0.14;
  const standbyLabelInkLit =
    STANDBY_LABEL_TEXT.length *
    STANDBY_LABEL_FONT_PX *
    STANDBY_LABEL_FONT_PX *
    0.24;
  const activeLitPixelRatio = Math.min(
    cardAreaRatio,
    (chromeLitPixels + reticleStrokeLit + standbyLabelInkLit) / VIEWPORT_AREA_PX
  );
  const maxAllowedAreaRatio = WAVEGUIDE_OPTICAL_SPEC.maxStandbyFillRatio;
  const withinFillBudget =
    cardAreaRatio <= maxAllowedAreaRatio &&
    activeLitPixelRatio <= maxAllowedAreaRatio;
  const accentHex = STANDBY_ACCENT_HEX;
  const contrastRatio = computeWaveguideContrast(accentHex);
  const meetsContrastGate =
    contrastRatio >= WAVEGUIDE_OPTICAL_SPEC.minContrastRatio;

  return {
    mode: "standby",
    cardAreaRatio,
    activeLitPixelRatio,
    maxAllowedAreaRatio,
    withinFillBudget,
    bloomRisk: classifyBloomRisk(
      "standby",
      cardAreaRatio,
      activeLitPixelRatio,
      withinFillBudget
    ),
    accentHex,
    contrastRatio,
    meetsContrastGate,
    headlineWordCount: 0,
    withinWordCap: true,
    multimodalChannels: null
  };
}

export function auditHudHistoryDepth(entries: number): HudHistoryAuditReport {
  const withinCap =
    Number.isInteger(entries) &&
    entries >= 0 &&
    entries <= WAVEGUIDE_OPTICAL_SPEC.maxHistoryEntries;
  return {
    entries,
    withinCap,
    hardwareLimit: HARDWARE_HISTORY_LIMIT,
    appCap: APP_HISTORY_CAP
  };
}
