import type { CoachCue, Field, LabelRead, Profile, Verdict } from "../../../shared/types.ts";
import { checkLabel } from "../../../server/src/safety.ts";
import { parseGs1 } from "./gs1.ts";
import { verdictPhraseId } from "./phrases.ts";
import { demoProfile } from "./storage.ts";
import {
  findByBarcode,
  findByGtin,
  matchVerdict,
  offlineUnknownBarcode,
  offlineUnknownCode,
} from "./verdicts.ts";

export type BlindfoldLang = "en" | "fi" | "sv";

export const ALL_PHRASE_IDS = [
  "offline",
  "back_online",
  "not_sure",
  "unknown_offline",
  "already_taken",
  "glasses_off",
  "camera_off",
  "cue_closer",
  "cue_further",
  "cue_rotate",
  "cue_tilt",
  "cue_more_light",
  "cue_steady",
  "cue_reading",
] as const;

export type PhraseClipId = (typeof ALL_PHRASE_IDS)[number];

export type SimBoxId =
  | "amlodipine"
  | "ibuprofen"
  | "amlodipine_wrong_strength"
  | "nut_allergen"
  | "metformin_unsure"
  | "unknown_pack";

export interface FrameMetrics {
  brightness: number;
  sharpness: number;
  motion: number;
  edgeDensity: number;
  glare: number;
  readiness: number;
}

export interface CoachSelection {
  cue: CoachCue;
  phraseId: PhraseClipId;
  text: Record<BlindfoldLang, string>;
}

export interface SimBoxSpec {
  id: SimBoxId;
  label: Record<BlindfoldLang, string>;
  hint: Record<BlindfoldLang, string>;
  expectedLevel: Verdict["level"];
}

export interface SimBoxResult {
  id: SimBoxId;
  verdict: Verdict;
  phraseId: PhraseClipId | null;
  coachingCues: CoachCue[];
}

export interface OfflineCodeResult {
  verdict: Verdict;
  phraseId: PhraseClipId | null;
  source: "datamatrix" | "barcode" | "unknown";
}

type CuePhraseClipId =
  | "cue_more_light"
  | "cue_steady"
  | "cue_tilt"
  | "cue_closer"
  | "cue_further"
  | "cue_rotate"
  | "cue_reading";

const COACH_COPY: Record<CuePhraseClipId, Record<BlindfoldLang, string>> = {
  cue_more_light: {
    en: "Move into brighter light.",
    fi: "Siirry parempaan valoon.",
    sv: "Hall den i battre ljus.",
  },
  cue_steady: {
    en: "Hold still.",
    fi: "Pida paikallaan.",
    sv: "Hall stilla.",
  },
  cue_tilt: {
    en: "Turn the box to the other side.",
    fi: "Kaanna pakkaus toisin pain.",
    sv: "Vand forpackningen till andra sidan.",
  },
  cue_closer: {
    en: "A bit closer.",
    fi: "Hieman lahemmas.",
    sv: "Lite narmare.",
  },
  cue_further: {
    en: "Move it slightly further back.",
    fi: "Siirra hieman kauemmas.",
    sv: "Flytta den lite langre bort.",
  },
  cue_rotate: {
    en: "Turn the box slowly.",
    fi: "Kaanna pakkausta hitaasti.",
    sv: "Vrid forpackningen langsamt.",
  },
  cue_reading: {
    en: "Got it, reading the label.",
    fi: "Selva, luen etikettia.",
    sv: "Jag ser den, laser etiketten.",
  },
};

export const SIM_BOXES: readonly SimBoxSpec[] = [
  {
    id: "amlodipine",
    label: {
      en: "Amlodipine 5 mg",
      fi: "Amlodipiini 5 mg",
      sv: "Amlodipin 5 mg",
    },
    hint: {
      en: "Evening pill on your list (safe match)",
      fi: "Listasi iltalaake (turvallinen osuma)",
      sv: "Kvallstablett pa din lista (saker traff)",
    },
    expectedLevel: "match",
  },
  {
    id: "ibuprofen",
    label: {
      en: "Ibuprofen 400 mg",
      fi: "Ibuprofeeni 400 mg",
      sv: "Ibuprofen 400 mg",
    },
    hint: {
      en: "Painkiller not on your list (avoid NSAIDs)",
      fi: "Tulehduskipulaake listan ulkopuolella (valta NSAID)",
      sv: "Smartstillande utanfor listan (undvik NSAID)",
    },
    expectedLevel: "warning",
  },
  {
    id: "amlodipine_wrong_strength",
    label: {
      en: "Amlodipine 10 mg",
      fi: "Amlodipiini 10 mg",
      sv: "Amlodipin 10 mg",
    },
    hint: {
      en: "Look-alike double strength (10 mg vs 5 mg)",
      fi: "Samannakoinen tuplavahvuus (10 mg vs 5 mg)",
      sv: "Forvaxlingsbar dubbel styrka (10 mg vs 5 mg)",
    },
    expectedLevel: "warning",
  },
  {
    id: "nut_allergen",
    label: {
      en: "Hazelnut & peanut bar",
      fi: "Pahkina-kaurapatukka",
      sv: "Hasselnots- och jordnotsbar",
    },
    hint: {
      en: "Food allergen trap (tree nuts and peanuts)",
      fi: "Allergeeniansa (pahkina ja maapahkina)",
      sv: "Allergenfalla (hasselnotter och jordnotter)",
    },
    expectedLevel: "warning",
  },
  {
    id: "metformin_unsure",
    label: {
      en: "Metformin (blurred dose)",
      fi: "Metformiini (epaselva vahvuus)",
      sv: "Metformin (otydlig styrka)",
    },
    hint: {
      en: "Low strength confidence (< 80% abstains)",
      fi: "Matala luottamus (< 80% ei arvaa annosta)",
      sv: "Lag konfidens (< 80% gissar aldrig dosen)",
    },
    expectedLevel: "unsure",
  },
  {
    id: "unknown_pack",
    label: {
      en: "Unknown offline pack",
      fi: "Tuntematon pakkaus offline",
      sv: "Okand forpackning offline",
    },
    hint: {
      en: "Pack code not saved on your phone",
      fi: "Pakkauskoodi ei ole tallennetulla listallasi",
      sv: "Forpackningskoden finns inte pa din sparade lista",
    },
    expectedLevel: "unsure",
  },
];

function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function fld<T>(value: T | null, confidence: number): Field<T> {
  return { value, confidence };
}

function toPhraseClipId(raw: string | null): PhraseClipId | null {
  if (!raw) return null;
  return (ALL_PHRASE_IDS as readonly string[]).includes(raw) ? (raw as PhraseClipId) : null;
}

function resolveProfile(profile?: Profile): Profile {
  return profile && profile.meds.length > 0 ? profile : demoProfile();
}

function resolveSimNow(now?: Date): Date {
  if (now) return new Date(now.getTime());
  const d = new Date();
  if (d.getHours() < 18) {
    d.setHours(20, 0, 0, 0);
  }
  return d;
}

export function measureRgbaFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  prevLuma?: Float32Array | null,
): { metrics: FrameMetrics; luma: Float32Array } {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || rgba.length < 4) {
    return {
      metrics: { brightness: 0, sharpness: 0, motion: 0, edgeDensity: 0, glare: 0, readiness: 0 },
      luma: new Float32Array(0),
    };
  }

  const totalPixels = w * h;
  const usablePixels = Math.min(totalPixels, Math.floor(rgba.length / 4));
  const luma = new Float32Array(totalPixels);
  if (usablePixels <= 0) {
    return {
      metrics: { brightness: 0, sharpness: 0, motion: 0, edgeDensity: 0, glare: 0, readiness: 0 },
      luma,
    };
  }

  const hasPrev = !!prevLuma && prevLuma.length === totalPixels;
  let lumaSum = 0;
  let glareCount = 0;
  let motionSum = 0;

  for (let i = 0; i < usablePixels; i++) {
    const p = i * 4;
    const y = clamp01((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255);
    luma[i] = y;
    lumaSum += y;
    if (y > 0.94) glareCount++;
    if (hasPrev) {
      const prev = prevLuma[i];
      if (Number.isFinite(prev)) {
        motionSum += Math.abs(y - prev);
      }
    }
  }

  const brightness = clamp01(lumaSum / usablePixels);
  const glare = clamp01(glareCount / usablePixels);
  const motion = hasPrev ? clamp01(motionSum / usablePixels) : 0;

  let sharpness = 0;
  let edgeDensity = 0;

  if (w >= 3 && h >= 3) {
    const x0 = Math.max(1, Math.floor(w * 0.15));
    const x1 = Math.min(w - 1, Math.ceil(w * 0.85));
    const y0 = Math.max(1, Math.floor(h * 0.15));
    const y1 = Math.min(h - 1, Math.ceil(h * 0.85));
    let lapSum = 0;
    let edgeCount = 0;
    let roiCount = 0;

    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = x0; x < x1; x++) {
        const idx = row + x;
        if (idx + w >= usablePixels) continue;
        const dx = luma[idx + 1] - luma[idx - 1];
        const dy = luma[idx + w] - luma[idx - w];
        const grad = Math.hypot(dx, dy) * Math.SQRT1_2;
        if (grad >= 0.08) edgeCount++;
        const lap = Math.abs(luma[idx - 1] + luma[idx + 1] + luma[idx - w] + luma[idx + w] - 4 * luma[idx]);
        lapSum += lap;
        roiCount++;
      }
    }

    if (roiCount > 0) {
      const meanLap = lapSum / roiCount;
      sharpness = clamp01(meanLap / (meanLap + 0.16));
      edgeDensity = clamp01(edgeCount / roiCount);
    }
  }

  const lightFactor = clamp01((brightness - 0.08) / 0.18);
  const glareFactor = clamp01(1 - glare / 0.4);
  const motionFactor = clamp01(1 - motion / 0.2);
  const edgeFactor = clamp01(edgeDensity / 0.1);
  const sharpFactor = clamp01(sharpness / 0.42);
  const readiness = clamp01(sharpFactor * (0.35 + 0.65 * edgeFactor) * lightFactor * glareFactor * motionFactor);

  return {
    metrics: {
      brightness,
      sharpness,
      motion,
      edgeDensity,
      glare,
      readiness,
    },
    luma,
  };
}

export function selectCoachCue(metrics: FrameMetrics): CoachSelection {
  const b = clamp01(metrics.brightness);
  const s = clamp01(metrics.sharpness);
  const m = clamp01(metrics.motion);
  const e = clamp01(metrics.edgeDensity);
  const g = clamp01(metrics.glare);
  const r = clamp01(metrics.readiness);

  if (b < 0.18) {
    return { cue: "more_light", phraseId: "cue_more_light", text: { ...COACH_COPY.cue_more_light } };
  }
  if (m > 0.12) {
    return { cue: "hold_still", phraseId: "cue_steady", text: { ...COACH_COPY.cue_steady } };
  }
  if (g > 0.22) {
    return { cue: "other_side", phraseId: "cue_tilt", text: { ...COACH_COPY.cue_tilt } };
  }
  if (e < 0.04) {
    return { cue: "closer", phraseId: "cue_closer", text: { ...COACH_COPY.cue_closer } };
  }
  if (e > 0.55 && s < 0.22) {
    return { cue: "farther", phraseId: "cue_further", text: { ...COACH_COPY.cue_further } };
  }
  if (s < 0.28) {
    return { cue: "rotate_left", phraseId: "cue_rotate", text: { ...COACH_COPY.cue_rotate } };
  }
  if (r >= 0.72) {
    return { cue: "ok", phraseId: "cue_reading", text: { ...COACH_COPY.cue_reading } };
  }
  return { cue: "hold_still", phraseId: "cue_steady", text: { ...COACH_COPY.cue_steady } };
}

type SimulatedLabelScenario =
  | { kind: "label"; read: LabelRead; coachingCues: CoachCue[] }
  | { kind: "unknown_offline"; verdict: Verdict; coachingCues: CoachCue[] };

function buildSimulatedScenario(id: SimBoxId): SimulatedLabelScenario {
  switch (id) {
    case "amlodipine":
      return {
        kind: "label",
        read: {
          kind: "medication",
          product: fld("Amlodipine", 0.97),
          ingredient: fld("amlodipine", 0.96),
          strength: fld("5 mg", 0.96),
          dosing: fld("1 tablet in the evening", 0.9),
          expiry: fld("2027-08", 0.92),
          allergens: fld<string[]>(null, 0),
          barcode: fld("06416542005218", 0.99),
          readability: 0.93,
        },
        coachingCues: ["closer", "hold_still", "ok"],
      };
    case "ibuprofen":
      return {
        kind: "label",
        read: {
          kind: "medication",
          product: fld("Ibuprofen", 0.97),
          ingredient: fld("ibuprofen", 0.96),
          strength: fld("400 mg", 0.95),
          dosing: fld("1 tablet up to 3 times daily", 0.86),
          expiry: fld("2027-08", 0.9),
          allergens: fld<string[]>(null, 0),
          barcode: fld("06416542009102", 0.99),
          readability: 0.91,
        },
        coachingCues: ["rotate_left", "hold_still", "ok"],
      };
    case "amlodipine_wrong_strength":
      return {
        kind: "label",
        read: {
          kind: "medication",
          product: fld("Amlodipine", 0.97),
          ingredient: fld("amlodipine", 0.96),
          strength: fld("10 mg", 0.96),
          dosing: fld("1 tablet once daily", 0.88),
          expiry: fld("2027-10", 0.91),
          allergens: fld<string[]>(null, 0),
          barcode: fld("06416542005225", 0.99),
          readability: 0.92,
        },
        coachingCues: ["closer", "hold_still", "ok"],
      };
    case "nut_allergen":
      return {
        kind: "label",
        read: {
          kind: "food",
          product: fld("Chocolate hazelnut granola bar", 0.95),
          ingredient: fld("rolled oats, roasted hazelnuts, peanuts, cocoa", 0.93),
          strength: fld<string>(null, 0),
          dosing: fld<string>(null, 0),
          expiry: fld("2027-05", 0.89),
          allergens: fld(["hazelnuts", "peanuts"], 0.98),
          barcode: fld("06416542008812", 0.98),
          readability: 0.91,
        },
        coachingCues: ["other_side", "hold_still", "ok"],
      };
    case "metformin_unsure":
      return {
        kind: "label",
        read: {
          kind: "medication",
          product: fld("Metformin", 0.92),
          ingredient: fld("metformin hydrochloride", 0.89),
          strength: fld("500 mg", 0.42),
          dosing: fld<string>(null, 0.2),
          expiry: fld("2027-09", 0.84),
          allergens: fld<string[]>(null, 0),
          barcode: fld<string>(null, 0),
          readability: 0.62,
          guidance: "Turn the box so the side panel faces you, or ask a pharmacist.",
        },
        coachingCues: ["more_light", "closer", "rotate_left"],
      };
    case "unknown_pack":
      return {
        kind: "unknown_offline",
        verdict: offlineUnknownCode({
          raw: "(01)09999999999999(17)280300",
          gtin: "09999999999999",
          expiry: "2028-03",
        }),
        coachingCues: ["closer", "hold_still", "ok"],
      };
  }
}

export function runSimulatedBox(id: SimBoxId, profile?: Profile, now?: Date): SimBoxResult {
  const effProfile = resolveProfile(profile);
  const effNow = resolveSimNow(now);
  const scenario = buildSimulatedScenario(id);
  const verdict = scenario.kind === "unknown_offline"
    ? scenario.verdict
    : checkLabel(scenario.read, effProfile, effNow);
  const phraseId = toPhraseClipId(verdictPhraseId(verdict, "offline"));
  return {
    id,
    verdict,
    phraseId,
    coachingCues: scenario.coachingCues,
  };
}

const GS1_PREFIX_RE = /^(\]d2|\]C1|\x1d|\(\d{2,4}\)|01\d{14})/;

export function runOfflineCodeVerdict(raw: string, profile?: Profile, now?: Date): OfflineCodeResult {
  const effProfile = resolveProfile(profile);
  const effNow = now ? new Date(now.getTime()) : new Date();
  const trimmed = raw.trim();

  if (!trimmed) {
    const verdict = offlineUnknownBarcode(trimmed);
    return {
      verdict,
      phraseId: toPhraseClipId(verdictPhraseId(verdict, "offline")),
      source: "unknown",
    };
  }

  const gs1 = GS1_PREFIX_RE.test(trimmed) ? parseGs1(trimmed) : null;
  if (gs1) {
    const med = gs1.gtin ? findByGtin(effProfile, gs1.gtin) : undefined;
    const verdict = med
      ? matchVerdict(effProfile, med, { via: "datamatrix", code: gs1, now: effNow })
      : offlineUnknownCode(gs1);
    return {
      verdict,
      phraseId: toPhraseClipId(verdictPhraseId(verdict, "offline")),
      source: "datamatrix",
    };
  }

  const med = findByBarcode(effProfile, trimmed);
  if (med) {
    const verdict = matchVerdict(effProfile, med, { via: "barcode", now: effNow });
    return {
      verdict,
      phraseId: toPhraseClipId(verdictPhraseId(verdict, "offline")),
      source: "barcode",
    };
  }

  const digits = trimmed.replace(/\D/g, "");
  const verdict = offlineUnknownBarcode(trimmed);
  return {
    verdict,
    phraseId: toPhraseClipId(verdictPhraseId(verdict, "offline")),
    source: digits.length >= 6 ? "barcode" : "unknown",
  };
}
