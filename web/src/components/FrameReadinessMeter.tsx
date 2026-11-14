import React, { type CSSProperties } from "react";
import { assessFrameReadiness, type CandidateFrame } from "../camera/multiFrameConsensus.ts";
import { cueLabel, normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { CoachCue } from "../types.ts";

void React;

export const SHARPNESS_READY_THRESHOLD = 0.22;
export const SHARPNESS_READY_PCT = 22;
export const MAX_BURST_SLOTS = 3;

export type CoachMsg = {
  cue: CoachCue;
  text?: string;
  type?: "coach";
};

export type ReadinessPhase = "standby" | "coaching_adjust" | "sharp_ready" | "verifying";

export type ReadinessStateInput = {
  cameraActive: boolean;
  checking: boolean;
  sharpness: number | null;
  bufferedFrames: number;
  coach: CoachMsg | null;
};

export type ReadinessStateSummary = {
  phase: ReadinessPhase;
  sharpness: number;
  sharpnessPct: number;
  sharpEnough: boolean;
  ringSlotsFilled: number;
  effectiveCue: CoachCue | null;
  burstReady: boolean;
};

export type FrameReadinessMeterProps = {
  cameraActive: boolean;
  checking: boolean;
  sharpness: number | null;
  bufferedFrames?: number;
  coach: CoachMsg | null;
  lang: string;
};

type Tone = "ok" | "info" | "warn" | "neutral";

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  progressAriaLabel: string;
  progressValueText: (pct: number, phaseText: string, sharpEnough: boolean) => string;
  sharpnessLabel: string;
  thresholdLegend: string;
  phaseBadges: Record<ReadinessPhase, string>;
  phaseDetails: Record<ReadinessPhase, string>;
  cueSectionLabel: string;
  standbyCueBadge: string;
  standbyCueDetail: string;
  cueBadges: Record<CoachCue, string>;
  burstHeading: string;
  burstStatus: (filled: number, total: number) => string;
  burstDetail: (filled: number, phase: ReadinessPhase) => string;
};

const TONE_BADGE_STYLES: Record<Tone, CSSProperties> = {
  ok: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "2px solid var(--verdict-match-border, #2dd4a0)"
  },
  info: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "2px solid var(--verdict-info-border, #4da3ff)"
  },
  warn: {
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "2px dashed var(--verdict-unsure-border, #f5b82e)"
  },
  neutral: {
    backgroundColor: "var(--bg-elevated, #1a2333)",
    color: "var(--text-primary, #f8fafc)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)"
  }
};

const TONE_FILL_COLORS: Record<Tone, string> = {
  ok: "var(--verdict-match-border, #2dd4a0)",
  info: "var(--verdict-info-border, #4da3ff)",
  warn: "var(--verdict-unsure-border, #f5b82e)",
  neutral: "var(--border-strong, #6980a3)"
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "First-Person Optical Framing",
    heading: "Optical Sharpness & Hand-Coaching Readiness",
    subtitle:
      "Tracks live frame sharpness, body-relative coaching cues, and top-3 FrameRing burst readiness before verify_label runs.",
    progressAriaLabel: "First-person frame optical sharpness",
    progressValueText: (pct, phaseText, sharpEnough) =>
      `${pct}% sharpness, ${phaseText}, ${sharpEnough ? "meets 22% lock threshold" : "below 22% lock threshold"}`,
    sharpnessLabel: "Frame sharpness",
    thresholdLegend: "22% optical lock gate (assessFrameReadiness >= 0.22)",
    phaseBadges: {
      standby: "CAMERA STANDBY",
      coaching_adjust: "COACHING ADJUST",
      sharp_ready: "SHARP & READY",
      verifying: "VERIFYING BURST"
    },
    phaseDetails: {
      standby: "Camera idle; zero frames captured until an active check starts.",
      coaching_adjust: "Guiding hand angle, distance, and steadiness toward sharp text.",
      sharp_ready: "Optical lock achieved; ready for multi-frame verify_label extraction.",
      verifying: "Running schema-locked verify_label across sharpest buffered frames."
    },
    cueSectionLabel: "Active hand-coaching cue",
    standbyCueBadge: "STANDBY",
    standbyCueDetail: "Start a label check to hear live body-relative hand coaching.",
    cueBadges: {
      rotate_left: "ROTATE LEFT",
      rotate_right: "ROTATE RIGHT",
      closer: "MOVE CLOSER",
      farther: "MOVE FARTHER",
      more_light: "MORE LIGHT",
      hold_still: "HOLD STILL",
      other_side: "OTHER SIDE",
      ok: "LABEL IN VIEW"
    },
    burstHeading: "Multi-Frame Burst Buffer",
    burstStatus: (filled, total) => `${filled}/${total} burst frames ready`,
    burstDetail: (filled, phase) => {
      if (phase === "verifying") {
        return `Inspecting ${Math.max(1, filled)} sharpest frame(s) from RAM-only FrameRing(8).`;
      }
      if (filled >= 3) {
        return "Full 3-frame temporal burst buffered in RAM for occluded or curved-label fusion.";
      }
      if (filled > 0) {
        return `${filled} candidate frame(s) buffered in RAM; collecting up to 3 sharpest views.`;
      }
      return "0 frames buffered; RAM-only FrameRing(8) fills automatically during active capture.";
    }
  },
  fi: {
    eyebrow: "Ensimmäisen persoonan optinen rajaus",
    heading: "Optinen terävyys ja käsiohjauksen valmius",
    subtitle:
      "Seuraa kuvan terävyyttä, kehosuhteellisia käsiohjeita ja 3 ruudun FrameRing-puskuria ennen verify_label-lukua.",
    progressAriaLabel: "Ensimmäisen persoonan kuvan optinen terävyys",
    progressValueText: (pct, phaseText, sharpEnough) =>
      `Terävyys ${pct} %, ${phaseText}, ${sharpEnough ? "ylittää 22 % lukitusrajan" : "alle 22 % lukitusrajan"}`,
    sharpnessLabel: "Kuvan terävyys",
    thresholdLegend: "22 % optinen lukitusraja (assessFrameReadiness >= 0.22)",
    phaseBadges: {
      standby: "KAMERA LEPOTILASSA",
      coaching_adjust: "OHJAA ASENTOA",
      sharp_ready: "TERÄVÄ JA VALMIS",
      verifying: "TARKISTAA SARJAA"
    },
    phaseDetails: {
      standby: "Kamera lepotilassa; ruutuja ei tallenneta ennen tarkistuksen aloitusta.",
      coaching_adjust: "Ohjataan käden kulmaa, etäisyyttä ja vakautta kohti terävää tekstiä.",
      sharp_ready: "Optinen lukitus saavutettu; valmis moniruutuiseen verify_label-tarkistukseen.",
      verifying: "Suoritetaan skeemalukittu verify_label terävimmistä puskuriruuduista."
    },
    cueSectionLabel: "Aktiivinen käsiohjausvihje",
    standbyCueBadge: "VALMIUSTILA",
    standbyCueDetail: "Aloita etiketin tarkistus kuullaksesi reaaliaikaisen käsiohjauksen.",
    cueBadges: {
      rotate_left: "KÄÄNNÄ VASEMMALLE",
      rotate_right: "KÄÄNNÄ OIKEALLE",
      closer: "TUO LÄHEMMÄS",
      farther: "VIE KAUEMMAS",
      more_light: "LISÄÄ VALOA",
      hold_still: "PIDÄ PAIKALLAAN",
      other_side: "TOINEN PUOLI",
      ok: "ETIKETTI NÄKYVISSÄ"
    },
    burstHeading: "Moniruutuinen sarjapuskuri",
    burstStatus: (filled, total) => `${filled}/${total} sarjaruutua valmiina`,
    burstDetail: (filled, phase) => {
      if (phase === "verifying") {
        return `Tarkistetaan ${Math.max(1, filled)} terävintä ruutua RAM-muistin FrameRing(8)-puskurista.`;
      }
      if (filled >= 3) {
        return "Täysi 3 ruudun sarja puskuroitu RAM-muistiin kaarevien pakkausten yhdistämiseen.";
      }
      if (filled > 0) {
        return `${filled} ehdokasruutu(a) RAM-puskurissa; kerätään enintään 3 terävintä näkymää.`;
      }
      return "0 ruutua puskurissa; vain RAM-muistissa oleva FrameRing(8) täyttyy kuvauksen aikana.";
    }
  },
  sv: {
    eyebrow: "Förstapersons optisk inramning",
    heading: "Optisk skärpa och handvägledningsberedskap",
    subtitle:
      "Följer bildskärpa i realtid, kroppsrelaterad handvägledning och topp-3 FrameRing-buffert före verify_label.",
    progressAriaLabel: "Optisk bildskärpa i förstapersonsvy",
    progressValueText: (pct, phaseText, sharpEnough) =>
      `Skärpa ${pct} %, ${phaseText}, ${sharpEnough ? "uppfyller 22 % låsgräns" : "under 22 % låsgräns"}`,
    sharpnessLabel: "Bildskärpa",
    thresholdLegend: "22 % optisk låsgräns (assessFrameReadiness >= 0.22)",
    phaseBadges: {
      standby: "KAMERA VÄNTELÄGE",
      coaching_adjust: "JUSTERAR GREPP",
      sharp_ready: "SKARP OCH REDO",
      verifying: "VERIFIERAR SERIE"
    },
    phaseDetails: {
      standby: "Kameran vilar; inga bildrutor fångas förrän en kontroll startas.",
      coaching_adjust: "Vägleder handvinkel, avstånd och stadga mot skarp etiketttext.",
      sharp_ready: "Optiskt lås uppnått; redo för flerbilds verify_label-avläsning.",
      verifying: "Kör schemalåst verify_label på de skarpaste buffrade bildrutorna."
    },
    cueSectionLabel: "Aktiv handvägledningssignal",
    standbyCueBadge: "VÄNTELÄGE",
    standbyCueDetail: "Starta en etikettkontroll för att höra kroppsrelaterad handvägledning.",
    cueBadges: {
      rotate_left: "VRID VÄNSTER",
      rotate_right: "VRID HÖGER",
      closer: "FÖR NÄRMARE",
      farther: "HÅLL LÄNGRE BORT",
      more_light: "MER LJUS",
      hold_still: "HÅLL STILLA",
      other_side: "ANDRA SIDAN",
      ok: "ETIKETT SYNLIG"
    },
    burstHeading: "Flerbilds seriebuffert",
    burstStatus: (filled, total) => `${filled}/${total} seriebildrutor redo`,
    burstDetail: (filled, phase) => {
      if (phase === "verifying") {
        return `Granskar ${Math.max(1, filled)} skarpaste bildruta/-or från RAM-bufferten FrameRing(8).`;
      }
      if (filled >= 3) {
        return "Full 3-bilds tidsserie buffrad i RAM för böjda eller delvis skymda förpackningar.";
      }
      if (filled > 0) {
        return `${filled} kandidatbildruta/-or i RAM; samlar upp till 3 skarpaste vyer.`;
      }
      return "0 bildrutor buffrade; RAM-baserad FrameRing(8) fylls automatiskt vid aktiv kontroll.";
    }
  }
};

function clampSharpnessUnit(raw: number | null): { value: number; hasSample: boolean } {
  if (raw === null || typeof raw !== "number" || Number.isNaN(raw)) {
    return { value: 0, hasSample: false };
  }
  if (raw === Number.POSITIVE_INFINITY || raw > 1) {
    return { value: 1, hasSample: true };
  }
  if (raw === Number.NEGATIVE_INFINITY || raw < 0) {
    return { value: 0, hasSample: true };
  }
  return { value: raw, hasSample: true };
}

function clampRingSlots(raw: number): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return 0;
  }
  if (raw === Number.POSITIVE_INFINITY) {
    return MAX_BURST_SLOTS;
  }
  if (raw === Number.NEGATIVE_INFINITY || raw <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_BURST_SLOTS, Math.floor(raw)));
}

export function summarizeReadinessState(input: ReadinessStateInput): ReadinessStateSummary {
  const { cameraActive, checking, sharpness, bufferedFrames, coach } = input;
  const clamped = clampSharpnessUnit(sharpness);
  const candidateFrames: CandidateFrame[] = clamped.hasSample
    ? [{ data: "", sharpness: clamped.value, ts: 0 }]
    : [];
  const readiness = assessFrameReadiness(candidateFrames, SHARPNESS_READY_THRESHOLD);

  const rawRoundedPct = Math.round(clamped.value * 100);
  const adjustedPct =
    !readiness.ready &&
    clamped.value < SHARPNESS_READY_THRESHOLD &&
    rawRoundedPct >= SHARPNESS_READY_PCT
      ? SHARPNESS_READY_PCT - 1
      : rawRoundedPct;
  const sharpnessPct = Math.max(0, Math.min(100, adjustedPct));
  const ringSlotsFilled = clampRingSlots(bufferedFrames);

  const hasAdjustmentCue = coach !== null && coach.cue !== "ok";
  let phase: ReadinessPhase;
  if (checking) {
    phase = "verifying";
  } else if (!cameraActive) {
    phase = "standby";
  } else if (readiness.ready && !hasAdjustmentCue) {
    phase = "sharp_ready";
  } else {
    phase = "coaching_adjust";
  }

  const effectiveCue: CoachCue | null =
    coach !== null
      ? coach.cue
      : cameraActive || checking
        ? readiness.suggestedCue
        : null;

  return {
    phase,
    sharpness: clamped.value,
    sharpnessPct,
    sharpEnough: readiness.ready,
    ringSlotsFilled,
    effectiveCue,
    burstReady: readiness.ready && ringSlotsFilled >= 1
  };
}

function getPhaseTone(phase: ReadinessPhase): Tone {
  if (phase === "sharp_ready") return "ok";
  if (phase === "verifying") return "info";
  if (phase === "coaching_adjust") return "warn";
  return "neutral";
}

function getCueTone(cue: CoachCue | null): Tone {
  if (cue === null) return "neutral";
  if (cue === "ok") return "ok";
  if (cue === "more_light" || cue === "other_side") return "warn";
  return "info";
}

function OpticalReticleIcon({ phase }: { phase: ReadinessPhase }) {
  const locked = phase === "sharp_ready" || phase === "verifying";
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="frame-readiness-reticle-icon"
      style={{ width: "28px", height: "28px", flexShrink: 0 }}
    >
      <path d="M5 11V5h6" />
      <path d="M27 11V5h-6" />
      <path d="M5 21v6h6" />
      <path d="M27 21v6h-6" />
      <circle
        cx="16"
        cy="16"
        r="5.5"
        strokeDasharray={phase === "standby" ? "3 2.5" : undefined}
      />
      {locked ? (
        <circle cx="16" cy="16" r="2.2" fill="currentColor" stroke="none" />
      ) : (
        <>
          <line x1="16" y1="8" x2="16" y2="10.5" />
          <line x1="16" y1="21.5" x2="16" y2="24" />
          <line x1="8" y1="16" x2="10.5" y2="16" />
          <line x1="21.5" y1="16" x2="24" y2="16" />
        </>
      )}
    </svg>
  );
}

function CueBadgeGlyph({ cue }: { cue: CoachCue | null }) {
  const style: CSSProperties = { width: "18px", height: "18px", flexShrink: 0 };
  if (cue === null) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <circle cx="12" cy="12" r="8" />
        <line x1="10" y1="9" x2="10" y2="15" />
        <line x1="14" y1="9" x2="14" y2="15" />
      </svg>
    );
  }
  if (cue === "ok") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8.2 12.3l2.5 2.5 5.3-5.4" />
      </svg>
    );
  }
  if (cue === "rotate_left") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path d="M18 16a7 7 0 1 0-10-8" />
        <path d="M7 4v4.5h4.5" />
      </svg>
    );
  }
  if (cue === "rotate_right") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path d="M6 16a7 7 0 1 1 10-8" />
        <path d="M17 4v4.5h-4.5" />
      </svg>
    );
  }
  if (cue === "closer") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path d="M12 19V6" />
        <path d="M7.5 10.5L12 6l4.5 4.5" />
      </svg>
    );
  }
  if (cue === "farther") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path d="M12 5v13" />
        <path d="M7.5 13.5L12 18l4.5-4.5" />
      </svg>
    );
  }
  if (cue === "more_light") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
      </svg>
    );
  }
  if (cue === "other_side") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path d="M4 9h15l-3.5-3.5" />
        <path d="M20 15H5l3.5 3.5" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FrameReadinessMeter(props: FrameReadinessMeterProps) {
  const {
    cameraActive,
    checking,
    sharpness,
    bufferedFrames = 0,
    coach,
    lang
  } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const summary = summarizeReadinessState({
    cameraActive,
    checking,
    sharpness,
    bufferedFrames,
    coach
  });

  const phaseTone = getPhaseTone(summary.phase);
  const cueTone = getCueTone(summary.effectiveCue);
  const barFillTone: Tone = summary.sharpEnough
    ? "ok"
    : summary.phase === "standby"
      ? "neutral"
      : "warn";

  const activeCueBadgeText =
    summary.effectiveCue !== null
      ? copy.cueBadges[summary.effectiveCue]
      : copy.standbyCueBadge;

  const customCoachText = typeof coach?.text === "string" ? coach.text.trim() : "";
  const activeCueGuidance =
    customCoachText.length > 0
      ? customCoachText
      : summary.effectiveCue !== null
        ? cueLabel(locale, summary.effectiveCue)
        : copy.standbyCueDetail;

  const phaseBadgeText = copy.phaseBadges[summary.phase];
  const progressValueText = copy.progressValueText(
    summary.sharpnessPct,
    phaseBadgeText,
    summary.sharpEnough
  );

  return (
    <section
      aria-labelledby="frame-readiness-meter-heading"
      aria-busy={summary.phase === "verifying"}
      lang={locale}
      className={`card frame-readiness-meter is-phase-${summary.phase}`}
      data-readiness-phase={summary.phase}
      data-sharp-enough={summary.sharpEnough ? "true" : "false"}
      data-ring-slots={summary.ringSlotsFilled}
      data-coach-cue={summary.effectiveCue ?? "none"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border:
          summary.phase === "sharp_ready"
            ? "2px solid var(--verdict-match-border, #2dd4a0)"
            : summary.phase === "verifying"
              ? "2px solid var(--verdict-info-border, #4da3ff)"
              : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-3, 12px)",
            flex: "1 1 280px"
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "48px",
              height: "48px",
              borderRadius: "var(--radius-md, 12px)",
              flexShrink: 0,
              ...TONE_BADGE_STYLES[phaseTone]
            }}
          >
            <OpticalReticleIcon phase={summary.phase} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--accent, #5cc0ff)"
              }}
            >
              {copy.eyebrow}
            </p>

            <h2
              id="frame-readiness-meter-heading"
              style={{
                margin: 0,
                fontSize: "var(--text-lg, 1.25rem)",
                lineHeight: 1.28,
                fontWeight: 800,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {copy.heading}
            </h2>

            <p
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                lineHeight: 1.45,
                color: "var(--text-secondary, #d8e1ee)"
              }}
            >
              {copy.subtitle}
            </p>
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="badge frame-readiness-phase-pill"
          data-phase-badge={summary.phase}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            minHeight: "38px",
            padding: "6px 14px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 800,
            letterSpacing: "0.04em",
            fontVariantNumeric: "tabular-nums",
            ...TONE_BADGE_STYLES[phaseTone]
          }}
        >
          <span>{phaseBadgeText}</span>
        </div>
      </header>

      <div
        className="frame-readiness-progress-block"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--bg-elevated, #1a2333)",
          border: "1px solid var(--border-subtle, #2c3a52)"
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px"
          }}
        >
          <span
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.sharpnessLabel}
          </span>

          <span
            className="frame-readiness-pct"
            style={{
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              fontFamily: "var(--font-mono, monospace)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {summary.sharpnessPct}%
          </span>
        </div>

        <div
          role="progressbar"
          aria-label={copy.progressAriaLabel}
          aria-valuenow={summary.sharpnessPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={progressValueText}
          className="frame-readiness-progressbar"
          style={{
            position: "relative",
            width: "100%",
            paddingTop: "4px",
            paddingBottom: "4px"
          }}
        >
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "16px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--bg-app, #0b0f17)",
              border: "1.5px solid var(--border-strong, #6980a3)",
              overflow: "hidden"
            }}
          >
            <div
              className="frame-readiness-progressbar-fill"
              style={{
                width: `${summary.sharpnessPct}%`,
                minWidth: summary.sharpnessPct > 0 ? "4px" : "0px",
                height: "100%",
                backgroundColor: TONE_FILL_COLORS[barFillTone]
              }}
            />
          </div>

          <div
            aria-hidden="true"
            className="frame-readiness-threshold-tick"
            data-threshold-pct={String(SHARPNESS_READY_PCT)}
            style={{
              position: "absolute",
              top: "0px",
              bottom: "0px",
              left: `${SHARPNESS_READY_PCT}%`,
              width: "3px",
              transform: "translateX(-50%)",
              backgroundColor: "var(--text-primary, #f8fafc)",
              borderRadius: "2px",
              boxShadow: "0 0 0 1px var(--bg-app, #0b0f17)"
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            fontSize: "var(--text-xs, 0.875rem)",
            color: "var(--text-secondary, #d8e1ee)"
          }}
        >
          <span>{copy.thresholdLegend}</span>
          <span>{copy.phaseDetails[summary.phase]}</span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          aria-label={copy.cueSectionLabel}
          className="frame-readiness-cue-tile"
          data-active-cue={summary.effectiveCue ?? "none"}
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            gap: "8px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              className="badge frame-readiness-cue-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "var(--radius-sm, 8px)",
                fontSize: "0.78rem",
                fontWeight: 800,
                letterSpacing: "0.04em",
                ...TONE_BADGE_STYLES[cueTone]
              }}
            >
              <CueBadgeGlyph cue={summary.effectiveCue} />
              <span>{activeCueBadgeText}</span>
            </span>
          </div>

          <p
            className="frame-readiness-cue-guidance"
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 700,
              lineHeight: 1.35,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {activeCueGuidance}
          </p>
        </div>

        <div
          className="frame-readiness-burst-tile"
          data-burst-filled={summary.ringSlotsFilled}
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            gap: "8px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px"
            }}
          >
            <span
              style={{
                fontSize: "var(--text-sm, 1rem)",
                fontWeight: 800,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {copy.burstHeading}
            </span>

            <span
              className="frame-readiness-burst-count"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums",
                fontFamily: "var(--font-mono, monospace)",
                color:
                  summary.ringSlotsFilled > 0
                    ? "var(--verdict-match-fg, #7ef7c8)"
                    : "var(--text-secondary, #d8e1ee)"
              }}
            >
              {copy.burstStatus(summary.ringSlotsFilled, MAX_BURST_SLOTS)}
            </span>
          </div>

          <div
            aria-hidden="true"
            className="frame-readiness-burst-slots"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "8px"
            }}
          >
            {[1, 2, 3].map((slotNumber) => {
              const filled = slotNumber <= summary.ringSlotsFilled;
              return (
                <span
                  key={slotNumber}
                  data-burst-slot={slotNumber}
                  data-slot-filled={filled ? "true" : "false"}
                  style={{
                    display: "block",
                    height: "12px",
                    borderRadius: "var(--radius-pill, 9999px)",
                    backgroundColor: filled
                      ? "var(--verdict-match-border, #2dd4a0)"
                      : "var(--bg-app, #0b0f17)",
                    border: filled
                      ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                      : "1.5px dashed var(--border-strong, #6980a3)"
                  }}
                />
              );
            })}
          </div>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.4,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.burstDetail(summary.ringSlotsFilled, summary.phase)}
          </p>
        </div>
      </div>
    </section>
  );
}

export default FrameReadinessMeter;
