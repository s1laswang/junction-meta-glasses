import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./blindfold.css";
import type { CoachCue, Field, LabelRead, Profile, Verdict } from "../../../shared/types.ts";
import { Announcer } from "../components/Announcer.tsx";
import { CueArrow, Icon, LEVEL_WORD, Logo, VerdictGlyph } from "../components/Icons.tsx";
import { PcmPlayer, synthPcmChunks } from "../lib/audio.ts";
import { detectCodes } from "../lib/barcode.ts";
import {
  ALL_PHRASE_IDS,
  SIM_BOXES,
  measureRgbaFrame,
  runOfflineCodeVerdict,
  runSimulatedBox,
  selectCoachCue,
  type BlindfoldLang,
  type PhraseClipId,
  type SimBoxId,
} from "../lib/blindfoldCoach.ts";
import { announce, earcon, earconForVerdict, haptic, primeSpeech, speak, stopSpeaking, unlockFeedback } from "../lib/feedback.ts";
import { classifyError, explain, getCamera, mediaSupported } from "../lib/media.ts";
import { cuePhraseId, playPhrase, sayPhrase, stopPhrase, verdictPhraseId } from "../lib/phrases.ts";
import { mountPixelScene, type PixelSceneController, type ScenePhase } from "../lib/pixelScene.ts";
import { Sonar } from "../lib/sonar.ts";
import { SPOT_CARDS, evaluateSpotCard, spotDemoProfile, type JudgeChoice, type SpotCard } from "../lib/spotTheDanger.ts";
import { LANGS, demoProfile, loadProfile, logDose, saveProfile } from "../lib/storage.ts";

const AUTO_STOP_MS = 45_000;
const COACH_SPEAK_GAP_MS = 2_400;
const ANNOUNCE_GAP_MS = 2_000;

export const HONESTY_BANNER_TEXT = "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)";
export const ASSETS_CREDIT_TEXT = "CC0 1.0 pixel art pharmacy and home world (full provenance in docs/demo/ASSETS.md).";

type CopyBundle = {
  skip: string;
  title: string;
  subtitle: string;
  round1Tab: string;
  round2Tab: string;
  curtainOn: string;
  curtainOff: string;
  srModeLabel: string;
  startBtn: string;
  startingBtn: string;
  stopBtn: string;
  repeatBtn: string;
  cameraOnBadge: string;
  cameraOffHint: string;
  readinessLabel: string;
  simHeading: string;
  simSub: string;
  clipsSummary: string;
  spotHeading: string;
  choiceSafe: string;
  choiceDanger: string;
  choiceUnsure: string;
  nextCard: string;
  restartSpot: string;
  judgeRight: string;
  judgeMissed: string;
  confCaption: string;
  colField: string;
  colValue: string;
  colConf: string;
  notReadable: string;
  footerPrivacy: string;
  openMockApp: string;
  openStage: string;
};

const COPY: Record<BlindfoldLang, CopyBundle> = {
  en: {
    skip: "Skip to challenge",
    title: "Meta Blindfold Challenge",
    subtitle: "Try HoldUp eyes-closed by voice and earcons, then race HoldUp on 5 real-world safety traps.",
    round1Tab: "Round 1: Blindfold Camera",
    round2Tab: "Round 2: Spot the Danger (5 cards)",
    curtainOn: "Blindfold view ON (lift curtain)",
    curtainOff: "Blindfold view OFF (hide preview)",
    srModeLabel: "Screen reader quiet audio",
    startBtn: "Start blindfold camera check (Space)",
    startingBtn: "Starting phone camera...",
    stopBtn: "Stop camera (Space or Esc)",
    repeatBtn: "Repeat last spoken cue (R)",
    cameraOnBadge: "CAMERA ON - LOCAL ONLY",
    cameraOffHint: "Camera off. Press Start or Space, or pick a simulated medicine box below.",
    readinessLabel: "Label readiness",
    simHeading: "No pack on hand or no webcam? 1-click box simulation",
    simSub: "Runs the exact offline deterministic safety rules, earcons, Sonar pitch, and pre-rendered voice clips.",
    clipsSummary: "Audition all 42 offline voice clips (14 phrases x EN / FI / SV)",
    spotHeading: "Round 2: Spot the Danger - Judge vs HoldUp",
    choiceSafe: "Safe (1)",
    choiceDanger: "Danger (2)",
    choiceUnsure: "Not sure - abstain (3)",
    nextCard: "Next card",
    restartSpot: "Play 5-card round again",
    judgeRight: "Judge call matched safety rule",
    judgeMissed: "Judge call missed the safety rule",
    confCaption: "Per-field confidence read (dose stated only at >= 80%, allergen gate >= 95%)",
    colField: "Field",
    colValue: "Read value",
    colConf: "Confidence",
    notReadable: "Not readable",
    footerPrivacy: "Zero network uploads: frames stay in local browser memory only, tracks stop immediately on exit.",
    openMockApp: "Open full HoldUp app (?mock=1)",
    openStage: "Open projector stage (/stage?mock=1)",
  },
  fi: {
    skip: "Siirry haasteeseen",
    title: "Meta Blindfold Challenge",
    subtitle: "Kokeile HoldUpia silmat kiinni aaniohjauksella ja testaa 5 arjen laaketurvallisuusansaa.",
    round1Tab: "Kierros 1: Sokkokamera",
    round2Tab: "Kierros 2: Tunnista vaara (5 korttia)",
    curtainOn: "Sokkonakyma PAALLA (nayta kuva)",
    curtainOff: "Sokkonakyma POIS (peita kuva)",
    srModeLabel: "Ruudunlukijan hiljainen tila",
    startBtn: "Aloita sokkotarkistus (Valilyonti)",
    startingBtn: "Kaynnistetaan puhelimen kameraa...",
    stopBtn: "Sammuta kamera (Valilyonti tai Esc)",
    repeatBtn: "Toista viimeisin ohje (R)",
    cameraOnBadge: "KAMERA PAALLA - VAIN PAIKALLINEN",
    cameraOffHint: "Kamera pois paalta. Paina Aloita tai Valilyonti, tai valitse simuloitu pakkaus alta.",
    readinessLabel: "Etiketin luettavuus",
    simHeading: "Ei pakkausta tai kameraa? 1 klikkauksen pakkaussimulaatio",
    simSub: "Ajaa samat deterministiset turvasaannot, aanimerkit, Sonar-taajuuden ja 42 offline-aaniklipia.",
    clipsSummary: "Kuuntele kaikki 42 offline-aaniklipia (14 lausetta x EN / FI / SV)",
    spotHeading: "Kierros 2: Tunnista vaara - Tuomari vs HoldUp",
    choiceSafe: "Turvallinen (1)",
    choiceDanger: "Vaara (2)",
    choiceUnsure: "Ei varma - pidattaydy (3)",
    nextCard: "Seuraava kortti",
    restartSpot: "Pelaa 5 kortin kierros uudelleen",
    judgeRight: "Tuomarin arvio osui oikeaan",
    judgeMissed: "Tuomarin arvio ohitti turvasaannon",
    confCaption: "Kenttakohtainen luottamus (vahvuus vaatii >= 80%, allergeeni >= 95%)",
    colField: "Kentta",
    colValue: "Luettu arvo",
    colConf: "Luottamus",
    notReadable: "Ei luettavissa",
    footerPrivacy: "Ei verkkolahetyksia: kamerakuva pysyy selaimen muistissa ja sammuu heti lopetettaessa.",
    openMockApp: "Avaa HoldUp-sovellus (?mock=1)",
    openStage: "Avaa lavanakyma (/stage?mock=1)",
  },
  sv: {
    skip: "Hoppa till utmaningen",
    title: "Meta Blindfold Challenge",
    subtitle: "Prova HoldUp med slutna ogon via rost och ljudsignaler och tavla pa 5 verkliga sakerhetsfallor.",
    round1Tab: "Runda 1: Ogonbindel-kamera",
    round2Tab: "Runda 2: Hitta faran (5 kort)",
    curtainOn: "Ogonbindel PA (visa kameravy)",
    curtainOff: "Ogonbindel AV (dolj kameravy)",
    srModeLabel: "Tyst lage for skarmlasare",
    startBtn: "Starta kamerakontroll (Mellanslag)",
    startingBtn: "Startar telefonens kamera...",
    stopBtn: "Stoppa kameran (Mellanslag eller Esc)",
    repeatBtn: "Upprepa senaste rostbesked (R)",
    cameraOnBadge: "KAMERA PA - ENDAST LOKALT",
    cameraOffHint: "Kameran ar av. Tryck Starta eller Mellanslag, eller valj en simulerad forpackning nedan.",
    readinessLabel: "Etikettens lasbarhet",
    simHeading: "Ingen forpackning eller webbkamera? 1-klicks simulering",
    simSub: "Kor exakt samma deterministiska sakerhetsregler, ljudsignaler, Sonar-ton och 42 forinspelade klipp.",
    clipsSummary: "Lyssna pa alla 42 forinspelade rostklipp (14 fraser x EN / FI / SV)",
    spotHeading: "Runda 2: Hitta faran - Domare mot HoldUp",
    choiceSafe: "Saker (1)",
    choiceDanger: "Fara (2)",
    choiceUnsure: "Inte saker - avsta (3)",
    nextCard: "Nasta kort",
    restartSpot: "Spela 5-kortsrundan igen",
    judgeRight: "Domarens val matchade sakerhetsregeln",
    judgeMissed: "Domarens val missade sakerhetsregeln",
    confCaption: "Konfidens per falt (styrka anges endast vid >= 80%, allergen >= 95%)",
    colField: "Falt",
    colValue: "Last varde",
    colConf: "Konfidens",
    notReadable: "Ej lasbar",
    footerPrivacy: "Noll natverksuppladdning: kamerabilder stannar lokalt i webblasaren och stoppas direkt.",
    openMockApp: "Oppna hela HoldUp-appen (?mock=1)",
    openStage: "Oppna projektorvy (/stage?mock=1)",
  },
};

const PHRASE_FALLBACK_EN: Record<PhraseClipId, string> = {
  offline: "You are offline. I can still recognise your saved medicines by barcode, but I cannot read new labels.",
  back_online: "Back online. The live assistant is reconnecting.",
  not_sure: "I am not sure. I will not guess a dose. Turn the box slowly, or ask a pharmacist.",
  unknown_offline: "I do not know this box offline. It is not one of your saved medicines.",
  already_taken: "You already took this today. Do not take another unless your plan says so.",
  glasses_off: "Glasses taken off. Switched to the phone camera.",
  camera_off: "Camera off.",
  cue_closer: "A bit closer.",
  cue_further: "Move it slightly further back.",
  cue_rotate: "Turn the box slowly.",
  cue_tilt: "Turn the box to the other side.",
  cue_more_light: "Move into brighter light.",
  cue_steady: "Hold still.",
  cue_reading: "Got it, reading the label.",
};

const CONF_FIELDS: readonly [keyof LabelRead, string][] = [
  ["product", "Product"],
  ["ingredient", "Ingredient"],
  ["strength", "Strength"],
  ["dosing", "Dosing"],
  ["expiry", "Expiry"],
  ["allergens", "Allergens"],
  ["barcode", "Barcode"],
];

function formatFieldVal(f: Field<string | string[]>, fallback: string): string {
  if (f.value == null) return fallback;
  if (Array.isArray(f.value)) return f.value.length ? f.value.join(", ") : fallback;
  return f.value || fallback;
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("button, a, input, select, textarea, summary, [contenteditable=true], dialog");
}

function normalizeLang(raw?: string | null): BlindfoldLang {
  if (raw === "fi" || raw === "sv" || raw === "en") return raw;
  return "en";
}

function readInitialQuery(): { lang: BlindfoldLang | null; round: "blindfold" | "spot" | null } {
  if (typeof location === "undefined") return { lang: null, round: null };
  const q = new URLSearchParams(location.search);
  const l = q.get("lang");
  const r = q.get("round");
  return {
    lang: l === "en" || l === "fi" || l === "sv" ? l : null,
    round: r === "spot" || r === "2" ? "spot" : r === "blindfold" || r === "1" ? "blindfold" : null,
  };
}

function deriveScenePhase(
  round: "blindfold" | "spot",
  cameraState: "off" | "starting" | "on" | "denied",
  verdict: Verdict | null,
  spotLevel: Verdict["level"] | null,
): ScenePhase {
  if (round === "spot") {
    if (!spotLevel) return "idle";
    if (spotLevel === "match") return "match";
    if (spotLevel === "warning") return "warning";
    return "unsure";
  }
  if (verdict) {
    if (verdict.level === "match") return "match";
    if (verdict.level === "warning") return "warning";
    return "unsure";
  }
  if (cameraState === "starting") return "checking";
  if (cameraState === "on") return "coaching";
  return "idle";
}

export type BlindfoldViewProps = {
  lang: BlindfoldLang;
  round: "blindfold" | "spot";
  blindfoldOn: boolean;
  srMode?: boolean;
  cameraState: "off" | "starting" | "on" | "denied";
  cameraProblem?: string;
  readiness: number;
  cue?: CoachCue | null;
  cueText?: string;
  lastSpoken?: string;
  verdict: Verdict | null;
  spotIndex: number;
  spotGuess: JudgeChoice | null;
  judgeScore: number;
  holdupScore: number;
  answeredCount: number;
  spotCards: readonly SpotCard[];
  activeClipId?: PhraseClipId | null;
  onLangChange?: (lang: BlindfoldLang) => void;
  onRoundChange?: (round: "blindfold" | "spot") => void;
  onToggleBlindfold?: () => void;
  onToggleSrMode?: () => void;
  onPrimaryAction?: () => void;
  onRepeat?: () => void;
  onSimulateBox?: (id: SimBoxId) => void;
  onPlayClip?: (id: PhraseClipId) => void;
  onLogDose?: () => void;
  onDismissVerdict?: () => void;
  onSpotChoice?: (choice: JudgeChoice) => void;
  onSpotNext?: () => void;
  onSpotRestart?: () => void;
  canvasRef?: React.Ref<HTMLCanvasElement>;
  videoRef?: React.Ref<HTMLVideoElement>;
  primaryBtnRef?: React.Ref<HTMLButtonElement>;
  verdictHeadingRef?: React.Ref<HTMLHeadingElement>;
};

export function initialBlindfoldViewProps(overrides: Partial<BlindfoldViewProps> = {}): BlindfoldViewProps {
  return {
    lang: "en",
    round: "blindfold",
    blindfoldOn: true,
    srMode: false,
    cameraState: "off",
    cameraProblem: "",
    readiness: 0,
    cue: null,
    cueText: "",
    lastSpoken: "",
    verdict: null,
    spotIndex: 0,
    spotGuess: null,
    judgeScore: 0,
    holdupScore: 0,
    answeredCount: 0,
    spotCards: SPOT_CARDS,
    activeClipId: null,
    ...overrides,
  };
}

export function BlindfoldView(props: BlindfoldViewProps) {
  const {
    lang,
    round,
    blindfoldOn,
    srMode = false,
    cameraState,
    cameraProblem = "",
    readiness,
    cue = null,
    cueText = "",
    lastSpoken = "",
    verdict,
    spotIndex,
    spotGuess,
    judgeScore,
    holdupScore,
    answeredCount,
    spotCards,
    activeClipId = null,
    onLangChange,
    onRoundChange,
    onToggleBlindfold,
    onToggleSrMode,
    onPrimaryAction,
    onRepeat,
    onSimulateBox,
    onPlayClip,
    onLogDose,
    onDismissVerdict,
    onSpotChoice,
    onSpotNext,
    onSpotRestart,
    canvasRef,
    videoRef,
    primaryBtnRef,
    verdictHeadingRef,
  } = props;

  const c = COPY[lang];
  const safeCards = spotCards.length > 0 ? spotCards : SPOT_CARDS;
  const clampedIdx = Math.max(0, Math.min(safeCards.length - 1, spotIndex));
  const currentCard: SpotCard | undefined = safeCards[clampedIdx];
  const spotEvaluation = useMemo(
    () => (currentCard && spotGuess ? evaluateSpotCard(currentCard, spotGuess, lang) : null),
    [currentCard, spotGuess, lang],
  );

  const phase = deriveScenePhase(round, cameraState, verdict, spotEvaluation?.expectedLevel ?? null);
  const sceneAriaLabel =
    round === "blindfold"
      ? `Pixel art pharmacy and home scene: blindfold mode ${blindfoldOn ? "active" : "lifted"}, phase ${phase}${cueText ? `, cue ${cueText}` : ""}.`
      : `Pixel art pharmacy Spot the Danger scene: card ${clampedIdx + 1} of ${safeCards.length}, phase ${phase}, Judge ${judgeScore} of 5 vs HoldUp 5 of 5.`;

  const readinessPct = Math.round(Math.max(0, Math.min(1, readiness)) * 100);
  const viewfinderAria =
    cameraState === "on"
      ? `Phone camera active (${blindfoldOn ? "blindfold blur curtain enabled" : "preview visible"}). Readiness ${readinessPct} percent.`
      : cameraState === "denied"
        ? `Phone camera unavailable. ${cameraProblem || "Use the 1-click simulated boxes below."}`
        : c.cameraOffHint;

  const primaryLabel = cameraState === "on" ? c.stopBtn : cameraState === "starting" ? c.startingBtn : c.startBtn;

  return (
    <div className="bf-page" data-lang={lang} data-round={round}>
      <a className="skip" href="#blindfold-main">
        {c.skip}
      </a>
      <Announcer />

      <header className="bf-header">
        <div className="bf-honesty-banner" role="region" aria-label="Demo disclosure" data-testid="honesty-banner">
          <div className="bf-honesty-row">
            <span className="bf-honesty-badge">OFFLINE DEMO</span>
            <strong className="bf-honesty-title">{HONESTY_BANNER_TEXT}</strong>
          </div>
          <p className="bf-credit-line">{ASSETS_CREDIT_TEXT}</p>
        </div>

        <div className="bf-topbar">
          <div className="bf-brand">
            <Logo size={34} />
            <div>
              <h1 className="bf-title">{c.title}</h1>
              <p className="bf-subtitle">{c.subtitle}</p>
            </div>
          </div>

          <div className="bf-controls-row">
            <div className="bf-lang-group" role="group" aria-label="Language">
              {LANGS.map((item) => {
                const code = item.code as BlindfoldLang;
                return (
                  <button
                    key={code}
                    type="button"
                    className="bf-lang-btn"
                    data-lang-btn={code}
                    aria-pressed={lang === code}
                    onClick={() => onLangChange?.(code)}
                  >
                    {code.toUpperCase()} - {item.label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="bf-sr-toggle"
              data-testid="blindfold-sr-mode"
              aria-pressed={srMode}
              onClick={() => onToggleSrMode?.()}
            >
              {c.srModeLabel}: {srMode ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        <div className="bf-round-tabs" role="group" aria-label="Demo round">
          <button
            type="button"
            className="bf-round-tab"
            data-testid="tab-round-1"
            aria-pressed={round === "blindfold"}
            onClick={() => onRoundChange?.("blindfold")}
          >
            {c.round1Tab}
          </button>
          <button
            type="button"
            className="bf-round-tab"
            data-testid="tab-round-2"
            aria-pressed={round === "spot"}
            onClick={() => onRoundChange?.("spot")}
          >
            {c.round2Tab}
          </button>
        </div>
      </header>

      <main id="blindfold-main" className="bf-main" tabIndex={-1}>
        <section className="bf-stage-frame" aria-label="Pharmacy and home pixel scene">
          <canvas
            ref={canvasRef}
            className="bf-pixel-canvas"
            width={480}
            height={270}
            role="img"
            aria-label={sceneAriaLabel}
          />
        </section>

        {round === "blindfold" ? (
          <section className="bf-round-section" aria-labelledby="bf-r1-heading">
            <div className="bf-section-head">
              <h2 id="bf-r1-heading">{c.round1Tab}</h2>
              <div className="bf-action-strip">
                <button
                  type="button"
                  className="bf-curtain-toggle"
                  data-testid="blindfold-curtain-btn"
                  aria-pressed={blindfoldOn}
                  onClick={() => onToggleBlindfold?.()}
                >
                  {blindfoldOn ? c.curtainOn : c.curtainOff}
                </button>
                <button
                  type="button"
                  className="bf-repeat-btn"
                  data-testid="blindfold-repeat-btn"
                  onClick={() => onRepeat?.()}
                >
                  {c.repeatBtn}
                </button>
              </div>
            </div>

            <div className="bf-viewfinder-wrap">
              <div className="bf-viewfinder" role="img" aria-label={viewfinderAria}>
                <video
                  ref={videoRef}
                  className={blindfoldOn ? "bf-video blindfolded" : "bf-video"}
                  playsInline
                  muted
                  autoPlay
                  aria-hidden="true"
                />
                {cameraState === "on" ? (
                  <div className="bf-camera-on-badge" data-testid="camera-on-badge">
                    <span className="bf-rec-dot" aria-hidden="true" />
                    <span>{c.cameraOnBadge}</span>
                  </div>
                ) : (
                  <div className="bf-viewfinder-placeholder">
                    <Icon.camera size={36} />
                    <p>{cameraState === "denied" && cameraProblem ? cameraProblem : c.cameraOffHint}</p>
                  </div>
                )}
                {blindfoldOn && cameraState === "on" ? (
                  <div className="bf-curtain-badge" aria-hidden="true">
                    EYES-CLOSED AUDIO MODE
                  </div>
                ) : null}
              </div>

              <div
                className="bf-meter"
                role="meter"
                aria-label={c.readinessLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={readinessPct}
              >
                <div className="bf-meter-label">
                  <span>{c.readinessLabel}</span>
                  <strong>{readinessPct}%</strong>
                </div>
                <div className="bf-meter-track" aria-hidden="true">
                  <div className="bf-meter-fill" style={{ width: `${readinessPct}%` }} />
                </div>
              </div>

              <div className="bf-cue-strip" aria-live="off">
                <CueArrow cue={cue} size={36} />
                <div>
                  <strong>{cueText || (cameraState === "on" ? PHRASE_FALLBACK_EN.cue_steady : c.cameraOffHint)}</strong>
                  {lastSpoken ? <p className="bf-last-spoken">{lastSpoken}</p> : null}
                </div>
              </div>
            </div>

            <button
              ref={primaryBtnRef}
              type="button"
              className={cameraState === "on" ? "bf-big-btn running" : "bf-big-btn"}
              data-testid="blindfold-primary-btn"
              disabled={cameraState === "starting"}
              onClick={() => onPrimaryAction?.()}
            >
              {primaryLabel}
            </button>

            {verdict ? (
              <section className={`bf-verdict-box ${verdict.level}`} data-testid="blindfold-verdict" aria-labelledby="bf-verdict-h">
                <div className="bf-verdict-head">
                  <span className={`bf-verdict-glyph ${verdict.level}`}>
                    <VerdictGlyph level={verdict.level} size={56} />
                  </span>
                  <div>
                    <span className={`bf-level-pill ${verdict.level}`}>{LEVEL_WORD[verdict.level]}</span>
                    <h3 id="bf-verdict-h" tabIndex={-1} ref={verdictHeadingRef}>
                      {verdict.headline}
                    </h3>
                  </div>
                </div>
                <p className="bf-verdict-speech">{verdict.speech}</p>
                {verdict.reasons.length > 0 ? (
                  <ul className="bf-reasons">
                    {verdict.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="bf-verdict-actions">
                  <button type="button" className="bf-action-btn" onClick={() => onRepeat?.()}>
                    Repeat
                  </button>
                  {verdict.matchedMedId ? (
                    <button type="button" className="bf-action-btn primary" onClick={() => onLogDose?.()}>
                      {verdict.takenToday ? "Log another dose" : "I took it"}
                    </button>
                  ) : null}
                  <button type="button" className="bf-action-btn" onClick={() => onDismissVerdict?.()}>
                    Dismiss
                  </button>
                </div>
              </section>
            ) : null}

            <section className="bf-sim-panel" aria-labelledby="bf-sim-h">
              <h3 id="bf-sim-h">{c.simHeading}</h3>
              <p className="bf-sim-sub">{c.simSub}</p>
              <div className="bf-sim-grid">
                {SIM_BOXES.map((box) => (
                  <button
                    key={box.id}
                    type="button"
                    className="bf-sim-btn"
                    data-sim-box={box.id}
                    onClick={() => onSimulateBox?.(box.id)}
                  >
                    <strong>{box.label[lang]}</strong>
                    <span>{box.hint[lang]}</span>
                  </button>
                ))}
              </div>
            </section>
          </section>
        ) : (
          <section className="bf-spot-panel" aria-labelledby="bf-r2-heading">
            <div className="bf-scoreboard" data-testid="spot-scoreboard">
              <h2 id="bf-r2-heading">{c.spotHeading}</h2>
              <p className="bf-score-summary">
                <strong>
                  Judge {judgeScore}/5 vs HoldUp {answeredCount === safeCards.length ? `${holdupScore}/5` : "5/5"}
                </strong>
                <span> ({answeredCount}/{safeCards.length} played)</span>
              </p>
            </div>

            {currentCard ? (
              <article className="bf-spot-card" aria-labelledby="bf-card-title">
                <div className="bf-card-meta">
                  <span className="bf-card-badge">
                    Card {currentCard.round} / {safeCards.length}
                  </span>
                  <span className="bf-card-deg">{currentCard.degradation}</span>
                </div>
                <h3 id="bf-card-title">{currentCard.title[lang]}</h3>
                <p className="bf-card-prompt">{currentCard.scenarioPrompt[lang]}</p>

                <div className="bf-spot-img-wrap">
                  <img
                    className="bf-spot-img"
                    src={currentCard.imageUrl}
                    alt={`${currentCard.title[lang]} (${currentCard.degradation})`}
                  />
                </div>

                <div className="bf-choices" role="group" aria-label="Judge safety choice">
                  <button
                    type="button"
                    className="bf-choice-btn match"
                    data-testid="choice-match"
                    aria-pressed={spotGuess === "match"}
                    onClick={() => onSpotChoice?.("match")}
                  >
                    {c.choiceSafe}
                  </button>
                  <button
                    type="button"
                    className="bf-choice-btn warning"
                    data-testid="choice-warning"
                    aria-pressed={spotGuess === "warning"}
                    onClick={() => onSpotChoice?.("warning")}
                  >
                    {c.choiceDanger}
                  </button>
                  <button
                    type="button"
                    className="bf-choice-btn unsure"
                    data-testid="choice-unsure"
                    aria-pressed={spotGuess === "unsure"}
                    onClick={() => onSpotChoice?.("unsure")}
                  >
                    {c.choiceUnsure}
                  </button>
                </div>

                {spotEvaluation ? (
                  <div className={`bf-reveal ${spotEvaluation.holdupVerdict.level}`} data-testid="spot-reveal">
                    <div className="bf-verdict-head" data-testid="blindfold-verdict">
                      <span className={`bf-verdict-glyph ${spotEvaluation.holdupVerdict.level}`}>
                        <VerdictGlyph level={spotEvaluation.holdupVerdict.level} size={52} />
                      </span>
                      <div>
                        <span className={`bf-level-pill ${spotEvaluation.holdupVerdict.level}`}>
                          {LEVEL_WORD[spotEvaluation.holdupVerdict.level]} - {spotEvaluation.correct ? c.judgeRight : c.judgeMissed}
                        </span>
                        <h4>{spotEvaluation.holdupVerdict.headline}</h4>
                      </div>
                    </div>

                    <p className="bf-verdict-speech">{spotEvaluation.holdupVerdict.speech}</p>
                    <p className="bf-danger-summary">{currentCard.dangerSummary[lang]}</p>

                    {spotEvaluation.holdupVerdict.reasons.length > 0 ? (
                      <ul className="bf-reasons">
                        {spotEvaluation.holdupVerdict.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    ) : null}

                    <table className="bf-conf-table">
                      <caption>{c.confCaption}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{c.colField}</th>
                          <th scope="col">{c.colValue}</th>
                          <th scope="col">{c.colConf}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {CONF_FIELDS.map(([fieldKey, label]) => {
                          const fld = currentCard.read[fieldKey] as Field<string | string[]>;
                          const pct = Math.round(fld.confidence * 100);
                          return (
                            <tr key={fieldKey}>
                              <th scope="row">{label}</th>
                              <td>{formatFieldVal(fld, c.notReadable)}</td>
                              <td>{pct}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div className="bf-spot-nav">
                      {clampedIdx + 1 < safeCards.length ? (
                        <button
                          type="button"
                          className="bf-big-btn"
                          data-testid="spot-next-btn"
                          onClick={() => onSpotNext?.()}
                        >
                          {c.nextCard} ({clampedIdx + 2}/{safeCards.length})
                        </button>
                      ) : (
                        <div className="bf-final-wrap" data-testid="spot-final-summary">
                          <p className="bf-final-score">
                            Final score: Judge {judgeScore}/5 vs HoldUp {holdupScore || 5}/5
                          </p>
                          <button
                            type="button"
                            className="bf-big-btn"
                            data-testid="spot-restart-btn"
                            onClick={() => onSpotRestart?.()}
                          >
                            {c.restartSpot}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </article>
            ) : null}
          </section>
        )}

        <details className="bf-clips-drawer">
          <summary className="bf-clips-summary">{c.clipsSummary}</summary>
          <div className="bf-clips-grid">
            {ALL_PHRASE_IDS.map((clipId) => (
              <button
                key={clipId}
                type="button"
                className={activeClipId === clipId ? "bf-clip-btn active" : "bf-clip-btn"}
                data-clip-id={clipId}
                onClick={() => onPlayClip?.(clipId)}
              >
                <span>{clipId}</span>
                <small>/phrases/{lang}/{clipId}</small>
              </button>
            ))}
          </div>
        </details>
      </main>

      <footer className="bf-footer">
        <p>{c.footerPrivacy}</p>
        <nav className="bf-footer-links" aria-label="Demo routes">
          <a href="/?mock=1">{c.openMockApp}</a>
          <a href="/stage?mock=1">{c.openStage}</a>
        </nav>
      </footer>
    </div>
  );
}

export function Blindfold() {
  const queryInit = useMemo(readInitialQuery, []);
  const [profile, setProfile] = useState<Profile>(() => {
    const loaded = typeof localStorage !== "undefined" ? loadProfile() : demoProfile();
    return loaded.meds.length > 0 ? loaded : spotDemoProfile();
  });
  const [lang, setLang] = useState<BlindfoldLang>(() => queryInit.lang ?? normalizeLang(profile.lang));
  const [round, setRound] = useState<"blindfold" | "spot">(() => queryInit.round ?? "blindfold");
  const [blindfoldOn, setBlindfoldOn] = useState(true);
  const [srMode, setSrMode] = useState(false);
  const [cameraState, setCameraState] = useState<"off" | "starting" | "on" | "denied">("off");
  const [cameraProblem, setCameraProblem] = useState("");
  const [readiness, setReadiness] = useState(0);
  const [cue, setCue] = useState<CoachCue | null>(null);
  const [cueText, setCueText] = useState("");
  const [lastSpoken, setLastSpoken] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [activeClipId, setActiveClipId] = useState<PhraseClipId | null>(null);

  const [spotIndex, setSpotIndex] = useState(0);
  const [spotGuesses, setSpotGuesses] = useState<Record<number, JudgeChoice>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const verdictHeadingRef = useRef<HTMLHeadingElement>(null);
  const sceneCtrlRef = useRef<PixelSceneController | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sonarRef = useRef<Sonar | null>(null);
  const pcmRef = useRef<PcmPlayer | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevLumaRef = useRef<Float32Array | null>(null);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCoachSpokenAtRef = useRef(0);
  const lastAnnounceAtRef = useRef(0);
  const langRef = useRef(lang);
  const srModeRef = useRef(srMode);

  langRef.current = lang;
  srModeRef.current = srMode;

  const { judgeScore, holdupScore, answeredCount } = useMemo(() => {
    let j = 0;
    let h = 0;
    let count = 0;
    for (let i = 0; i < SPOT_CARDS.length; i++) {
      const g = spotGuesses[i];
      if (!g) continue;
      count++;
      const res = evaluateSpotCard(SPOT_CARDS[i], g, lang);
      if (res.correct) j++;
      if (res.holdupVerdict.level === res.expectedLevel) h++;
    }
    return { judgeScore: j, holdupScore: h, answeredCount: count };
  }, [spotGuesses, lang]);

  const currentGuess = spotGuesses[spotIndex] ?? null;

  const announceThrottled = useCallback((msg: string, politeness: "polite" | "assertive" = "polite", force = false) => {
    const now = Date.now();
    if (!force && now - lastAnnounceAtRef.current < ANNOUNCE_GAP_MS) return;
    lastAnnounceAtRef.current = now;
    announce(msg, politeness);
  }, []);

  const playClipOrSpeak = useCallback(
    (clipId: PhraseClipId | null, fallbackSpeech: string, politeness: "polite" | "assertive" = "polite", forceAnnounce = false) => {
      setLastSpoken(fallbackSpeech);
      announceThrottled(fallbackSpeech, politeness, forceAnnounce);
      if (srModeRef.current) return;
      sonarRef.current?.duck(true);
      const releaseDuck = () => {
        setTimeout(() => sonarRef.current?.duck(false), 900);
      };
      if (clipId) {
        setActiveClipId(clipId);
        void sayPhrase(
          clipId,
          langRef.current,
          (txt) => {
            speak(txt, { interrupt: true, lang: "en-GB" });
          },
          fallbackSpeech || PHRASE_FALLBACK_EN[clipId],
        ).finally(releaseDuck);
      } else {
        speak(fallbackSpeech, { interrupt: true, lang: "en-GB" });
        releaseDuck();
      }
    },
    [announceThrottled],
  );

  const unlockAudioEngines = useCallback(() => {
    unlockFeedback();
    primeSpeech();
    if (!sonarRef.current) sonarRef.current = new Sonar();
    sonarRef.current.unlock();
    if (!pcmRef.current) pcmRef.current = new PcmPlayer(24000);
    void pcmRef.current.unlock().then(() => {
      if (!srModeRef.current) {
        const chime = synthPcmChunks([523], 45, 24000);
        if (chime[0]) pcmRef.current?.enqueue(chime[0]);
      }
    });
  }, []);

  const stopCamera = useCallback(
    (playOffAudio: boolean, restoreFocus = false) => {
      if (frameTimerRef.current) {
        clearInterval(frameTimerRef.current);
        frameTimerRef.current = null;
      }
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      prevLumaRef.current = null;
      const hadStream = !!streamRef.current;
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          try {
            track.stop();
          } catch {}
        }
        streamRef.current = null;
      }
      if (videoRef.current) {
        try {
          videoRef.current.pause();
        } catch {}
        videoRef.current.srcObject = null;
      }
      sonarRef.current?.stop();
      setCameraState((prev) => (prev === "denied" && !hadStream ? "denied" : "off"));
      setReadiness(0);
      if (playOffAudio && hadStream) {
        earcon.stop();
        haptic.stop();
        playClipOrSpeak("camera_off", PHRASE_FALLBACK_EN.camera_off, "polite", true);
      }
      if (restoreFocus) {
        primaryBtnRef.current?.focus();
      }
    },
    [playClipOrSpeak],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Meta Blindfold Challenge - HoldUp";
    document.body.classList.add("blindfold-body");
    document.documentElement.lang = lang;
    return () => {
      document.body.classList.remove("blindfold-body");
      stopPhrase();
      stopSpeaking();
      sonarRef.current?.stop();
      void pcmRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : null;
    const ctrl = mountPixelScene(canvas, {
      mode: round,
      phase: "idle",
      blindfoldOn,
      score: 0,
      total: SPOT_CARDS.length,
      lang,
      reducedMotion: !!mq?.matches,
    });
    sceneCtrlRef.current = ctrl;
    const onMotionChange = () => {
      ctrl.update({ reducedMotion: !!mq?.matches });
    };
    mq?.addEventListener?.("change", onMotionChange);
    return () => {
      mq?.removeEventListener?.("change", onMotionChange);
      ctrl.destroy();
      sceneCtrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    const spotEval = SPOT_CARDS[spotIndex] && currentGuess ? evaluateSpotCard(SPOT_CARDS[spotIndex], currentGuess, lang) : null;
    const phase = deriveScenePhase(round, cameraState, verdict, spotEval?.expectedLevel ?? null);
    sceneCtrlRef.current?.update({
      mode: round,
      phase,
      blindfoldOn,
      score: judgeScore,
      total: SPOT_CARDS.length,
      lang,
      cueText: cueText || undefined,
      pharmacistBubble:
        round === "spot" && spotEval
          ? SPOT_CARDS[spotIndex]?.dangerSummary[lang]
          : verdict
            ? verdict.headline
            : undefined,
    });
  }, [round, cameraState, verdict, spotIndex, currentGuess, blindfoldOn, judgeScore, lang, cueText]);

  useEffect(() => {
    const onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        stopCamera(false, false);
      }
    };
    const onPageHide = () => stopCamera(false, false);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
    return () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      stopCamera(false, false);
    };
  }, [stopCamera]);

  const applyVerdict = useCallback(
    (nextVerdict: Verdict, clipId: PhraseClipId | null) => {
      stopCamera(false, false);
      setVerdict(nextVerdict);
      earconForVerdict(nextVerdict.level);
      haptic.verdict(nextVerdict.level);
      const resolvedClip = clipId ?? (verdictPhraseId(nextVerdict, "offline") as PhraseClipId | null);
      playClipOrSpeak(
        resolvedClip,
        nextVerdict.speech,
        nextVerdict.level === "warning" ? "assertive" : "polite",
        true,
      );
      queueMicrotask(() => {
        verdictHeadingRef.current?.focus();
      });
    },
    [playClipOrSpeak, stopCamera],
  );

  const startCamera = useCallback(async () => {
    unlockAudioEngines();
    setVerdict(null);
    setCameraProblem("");
    if (!mediaSupported()) {
      const msg = explain("camera", "unavailable");
      setCameraState("denied");
      setCameraProblem(msg);
      earcon.alert();
      announceThrottled(`${msg} Use the 1-click box simulation buttons below.`, "assertive", true);
      return;
    }
    setCameraState("starting");
    try {
      const stream = await getCamera();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }
      setCameraState("on");
      earcon.start();
      haptic.start();
      playClipOrSpeak("cue_steady", PHRASE_FALLBACK_EN.cue_steady, "polite", true);

      autoStopTimerRef.current = setTimeout(() => {
        stopCamera(true, true);
      }, AUTO_STOP_MS);

      frameTimerRef.current = setInterval(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        if (!scanCanvasRef.current && typeof document !== "undefined") {
          scanCanvasRef.current = document.createElement("canvas");
        }
        const scan = scanCanvasRef.current;
        if (!scan) return;
        const w = 160;
        const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
        scan.width = w;
        scan.height = h;
        const ctx = scan.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const { metrics, luma } = measureRgbaFrame(img.data, w, h, prevLumaRef.current);
        prevLumaRef.current = luma;
        setReadiness(metrics.readiness);
        sonarRef.current?.set(metrics.readiness);

        const nextCoach = selectCoachCue(metrics);
        setCue(nextCoach.cue);
        setCueText(nextCoach.text[langRef.current]);
        const now = Date.now();
        if (now - lastCoachSpokenAtRef.current >= COACH_SPEAK_GAP_MS) {
          lastCoachSpokenAtRef.current = now;
          earcon.coach();
          const mappedClip = (cuePhraseId(nextCoach.cue, nextCoach.text.en) as PhraseClipId | null) ?? nextCoach.phraseId;
          playClipOrSpeak(mappedClip, nextCoach.text[langRef.current], "polite", false);
        }

        void detectCodes(video).then((codes) => {
          if (!codes.length || !streamRef.current) return;
          const raw = codes[0]?.rawValue;
          if (!raw) return;
          const out = runOfflineCodeVerdict(raw, profile);
          applyVerdict(out.verdict, out.phraseId);
        });
      }, 280);
    } catch (err) {
      const state = classifyError(err);
      const msg = explain("camera", state);
      setCameraState("denied");
      setCameraProblem(msg);
      earcon.alert();
      announceThrottled(`${msg} Use the 1-click box simulation buttons below.`, "assertive", true);
    }
  }, [ announceThrottled, applyVerdict, playClipOrSpeak, profile, stopCamera, unlockAudioEngines ]);

  const handlePrimaryAction = useCallback(() => {
    if (cameraState === "on" || cameraState === "starting") {
      stopCamera(true, false);
    } else {
      void startCamera();
    }
  }, [cameraState, startCamera, stopCamera]);

  const handleRepeat = useCallback(() => {
    unlockAudioEngines();
    const textToSay = verdict?.speech || lastSpoken || cueText || COPY[lang].cameraOffHint;
    const clip = verdict ? (verdictPhraseId(verdict, "offline") as PhraseClipId | null) : null;
    playClipOrSpeak(clip, textToSay, "polite", true);
  }, [verdict, lastSpoken, cueText, lang, playClipOrSpeak, unlockAudioEngines]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        if (cameraState === "on" || cameraState === "starting") {
          e.preventDefault();
          stopCamera(true, true);
          return;
        }
        if (verdict) {
          e.preventDefault();
          setVerdict(null);
          primaryBtnRef.current?.focus();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isInteractiveTarget(e.target)) return;
      if (round === "blindfold") {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          handlePrimaryAction();
        } else if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          handleRepeat();
        }
      } else {
        if (e.key === "1") {
          e.preventDefault();
          handleSpotChoice("match");
        } else if (e.key === "2") {
          e.preventDefault();
          handleSpotChoice("warning");
        } else if (e.key === "3") {
          e.preventDefault();
          handleSpotChoice("unsure");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const handleLangChange = useCallback(
    (next: BlindfoldLang) => {
      setLang(next);
      const updated = { ...profile, lang: next };
      setProfile(updated);
      saveProfile(updated);
      announceThrottled(`Language switched to ${ next.toUpperCase() }.`, "polite", true);
    },
    [announceThrottled, profile],
  );

  const handleRoundChange = useCallback(
    (nextRound: "blindfold" | "spot") => {
      if (nextRound !== "blindfold") {
        stopCamera(false, false);
      }
      setRound(nextRound);
      announceThrottled(nextRound === "spot" ? COPY[lang].spotHeading : COPY[lang].round1Tab, "polite", true);
    },
    [announceThrottled, lang, stopCamera],
  );

  const handleSimulateBox = useCallback(
    (id: SimBoxId) => {
      unlockAudioEngines();
      stopCamera(false, false);
      earcon.checking();
      sonarRef.current?.set(0.88);
      setReadiness(0.88);
      const sim = runSimulatedBox(id, profile);
      const lastCue = sim.coachingCues[sim.coachingCues.length - 1] ?? "ok";
      setCue(lastCue);
      setCueText(PHRASE_FALLBACK_EN.cue_reading);
      sonarRef.current?.stop();
      applyVerdict(sim.verdict, sim.phraseId);
    },
    [applyVerdict, profile, stopCamera, unlockAudioEngines],
  );

  const handlePlayClip = useCallback(
    (id: PhraseClipId) => {
      unlockAudioEngines();
      setActiveClipId(id);
      setLastSpoken(PHRASE_FALLBACK_EN[id]);
      announceThrottled(PHRASE_FALLBACK_EN[id], "polite", true);
      if (srModeRef.current) return;
      void playPhrase(id, lang).then((ok) => {
        if (!ok) speak(PHRASE_FALLBACK_EN[id], { interrupt: true, lang: "en-GB" });
      });
    },
    [announceThrottled, lang, unlockAudioEngines],
  );

  const handleSpotChoice = useCallback(
    (choice: JudgeChoice) => {
      const card = SPOT_CARDS[spotIndex];
      if (!card) return;
      unlockAudioEngines();
      setSpotGuesses((prev) => ({ ...prev, [spotIndex]: choice }));
      const res = evaluateSpotCard(card, choice, lang);
      earconForVerdict(res.holdupVerdict.level);
      haptic.verdict(res.holdupVerdict.level);
      const clipId = (ALL_PHRASE_IDS as readonly string[]).includes(card.phraseClipId)
        ? (card.phraseClipId as PhraseClipId)
        : null;
      playClipOrSpeak(
        clipId,
        `${res.holdupVerdict.speech} ${card.dangerSummary[lang]}`,
        res.holdupVerdict.level === "warning" ? "assertive" : "polite",
        true,
      );
    },
    [spotIndex, lang, playClipOrSpeak, unlockAudioEngines],
  );

  return (
    <BlindfoldView
      lang={lang}
      round={round}
      blindfoldOn={blindfoldOn}
      srMode={srMode}
      cameraState={cameraState}
      cameraProblem={cameraProblem}
      readiness={readiness}
      cue={cue}
      cueText={cueText}
      lastSpoken={lastSpoken}
      verdict={verdict}
      spotIndex={spotIndex}
      spotGuess={currentGuess}
      judgeScore={judgeScore}
      holdupScore={holdupScore}
      answeredCount={answeredCount}
      spotCards={SPOT_CARDS}
      activeClipId={activeClipId}
      onLangChange={handleLangChange}
      onRoundChange={handleRoundChange}
      onToggleBlindfold={() => setBlindfoldOn((b) => !b)}
      onToggleSrMode={() => setSrMode((v) => !v)}
      onPrimaryAction={handlePrimaryAction}
      onRepeat={handleRepeat}
      onSimulateBox={handleSimulateBox}
      onPlayClip={handlePlayClip}
      onLogDose={() => {
        if (!verdict?.matchedMedId) return;
        const nextProfile = logDose(profile, verdict.matchedMedId);
        setProfile(nextProfile);
        setVerdict({ ...verdict, takenToday: true });
        earcon.ok();
        announceThrottled("Dose logged on this phone.", "polite", true);
      }}
      onDismissVerdict={() => {
        setVerdict(null);
        primaryBtnRef.current?.focus();
      }}
      onSpotChoice={handleSpotChoice}
      onSpotNext={() => setSpotIndex((i) => Math.min(SPOT_CARDS.length - 1, i + 1))}
      onSpotRestart={() => {
        setSpotGuesses({});
        setSpotIndex(0);
      }}
      canvasRef={canvasRef}
      videoRef={videoRef}
      primaryBtnRef={primaryBtnRef}
      verdictHeadingRef={verdictHeadingRef}
    />
  );
}
