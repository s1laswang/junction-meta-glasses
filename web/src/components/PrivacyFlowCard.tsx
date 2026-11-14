import React, { type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { ConsentRecord, DeviceState, Profile } from "../types.ts";

void React;

export const MAX_RING_FRAMES = 8;
export const IDLE_AUTO_STOP_SEC = 45;
export const BYSTANDER_RED_TEAM_SCENES = 8;

export type PrivacyZoneId =
  | "onDeviceStorage"
  | "ephemeralHubRam"
  | "blindModelReader"
  | "loanerGlassesHud";

export type PrivacyBoundaryInput = {
  profile: Profile;
  consent: ConsentRecord | null;
  cameraActive: boolean;
  autoStopRemainingSec: number | null;
  device: DeviceState;
};

export type OnDeviceStorageSummary = {
  medCount: number;
  allergyCount: number;
  avoidCount: number;
  doseLogCount: number;
  consentAccepted: boolean;
  consentVersion: string | null;
  cloudDbRows: 0;
};

export type EphemeralHubRamSummary = {
  maxRingFrames: 8;
  idleAutoStopSec: 45;
  cameraActive: boolean;
  activeCountdownSec: number | null;
  clearedOnDisconnect: true;
  serverDiskFiles: 0;
};

export type BlindModelReaderSummary = {
  profileFieldsSentToReadLabel: 0;
  bystanderFaceIgnoreEnforced: true;
  bystanderPiiLeaks: 0;
  bystanderRedTeamScenes: 8;
  maxFramesPerVerify: 3;
};

export type LoanerGlassesHudSummary = {
  hudPersistentBytes: 0;
  captureLedActive: boolean;
  glassesConnected: boolean;
  glassesStreaming: boolean;
};

export type PrivacyBoundarySummary = {
  onDeviceStorage: OnDeviceStorageSummary;
  ephemeralHubRam: EphemeralHubRamSummary;
  blindModelReader: BlindModelReaderSummary;
  loanerGlassesHud: LoanerGlassesHudSummary;
};

export type PrivacyFlowCardProps = {
  profile: Profile;
  consent: ConsentRecord | null;
  cameraActive: boolean;
  autoStopRemainingSec: number | null;
  device: DeviceState;
  lang: string;
  onOpenPrivacyModal?: () => void;
  onWipeAll?: () => void;
};

type Tone = "ok" | "warn" | "info" | "neutral";

type ZoneTileSpec = {
  id: PrivacyZoneId;
  state: string;
  tone: Tone;
  badge: string;
  title: string;
  value: string;
  detail: string;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  consentPillAccepted: (version: string | null) => string;
  consentPillPending: string;
  cameraPillActive: (countdownSec: number | null) => string;
  cameraPillIdle: string;
  zonesAriaLabel: string;
  storageTitle: string;
  storageBadgeAccepted: string;
  storageBadgePending: string;
  storageValue: (counts: OnDeviceStorageSummary) => string;
  storageDetailAccepted: string;
  storageDetailPending: string;
  ramTitle: string;
  ramBadgeActive: (countdownSec: number | null) => string;
  ramBadgeIdle: string;
  ramValueActive: (countdownSec: number | null, maxFrames: number, autoStopSec: number) => string;
  ramValueIdle: (maxFrames: number, autoStopSec: number) => string;
  ramDetail: string;
  readerTitle: string;
  readerBadge: string;
  readerValue: (piiLeaks: number, scenes: number) => string;
  readerDetail: string;
  hudTitle: string;
  hudBadgeLedOn: string;
  hudBadgeLedIdle: string;
  hudValueLedOn: string;
  hudValueLedIdle: string;
  hudDetailLedOn: string;
  hudDetailLedIdle: string;
  actionsAriaLabel: string;
  openModalAriaLabel: string;
  wipeAllAriaLabel: string;
};

const TONE_BADGE_STYLES: Record<Tone, CSSProperties> = {
  ok: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)"
  },
  warn: {
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "var(--border-width, 1.5px) solid var(--verdict-unsure-border, #f5b82e)"
  },
  info: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
  },
  neutral: {
    backgroundColor: "var(--bg-surface, #121926)",
    color: "var(--text-primary, #f8fafc)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)"
  }
};

const TONE_BORDER_COLORS: Record<Tone, string> = {
  ok: "var(--verdict-match-border, #2dd4a0)",
  warn: "var(--verdict-unsure-border, #f5b82e)",
  info: "var(--verdict-info-border, #4da3ff)",
  neutral: "var(--border-strong, #6980a3)"
};

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
  boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
};

const ACTION_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 18px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800,
  flex: "1 1 220px"
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Consent & Ephemeral Data Audit",
    heading: "4 Strict Privacy & Consent Boundaries",
    subtitle:
      "Code-enforced isolation across phone localStorage, ephemeral Hub RAM, profile-blind label extraction, and zero-storage Ray-Ban Display glasses.",
    consentPillAccepted: (version) =>
      version ? `Consent Active (v${version})` : "Consent Active",
    consentPillPending: "Consent Pending",
    cameraPillActive: (countdownSec) =>
      countdownSec !== null
        ? `Camera Active (${countdownSec}s auto-stop)`
        : "Camera Active (45s auto-stop)",
    cameraPillIdle: "Camera Off (RAM Ring Empty)",
    zonesAriaLabel: "HoldUp four privacy and data-isolation boundaries",
    storageTitle: "1. Phone On-Device Storage (localStorage)",
    storageBadgeAccepted: "LOCAL ONLY / CONSENT ON",
    storageBadgePending: "CONSENT REQUIRED",
    storageValue: (c) =>
      `${c.medCount} meds, ${c.allergyCount} allergies, ${c.avoidCount} avoid rules, ${c.doseLogCount} doses, ${c.cloudDbRows} cloud DB rows`,
    storageDetailAccepted:
      "Medications, allergies, dose history, and ConsentRecord persist only in browser localStorage (holdup.*) and erase in 1 tap via wipeAllLocalData().",
    storageDetailPending:
      "No live camera or microphone check starts until explicit consent is accepted; local records stay strictly on this phone with 0 cloud database rows.",
    ramTitle: "2. Ephemeral Hub RAM (FrameRing(8))",
    ramBadgeActive: (countdownSec) =>
      countdownSec !== null ? `STREAMING / ${countdownSec}S CAP` : "STREAMING / 45S CAP",
    ramBadgeIdle: "IDLE / 0 RAM FRAMES",
    ramValueActive: (countdownSec, maxFrames, autoStopSec) =>
      countdownSec !== null
        ? `<= 1 fps active check, auto-stops in ${countdownSec}s (max ${maxFrames} RAM frames, 0 disk files)`
        : `<= 1 fps active check, ${autoStopSec}s idle auto-stop (max ${maxFrames} RAM frames, 0 disk files)`,
    ramValueIdle: (maxFrames, autoStopSec) =>
      `Camera off: 0 frames buffered (max ${maxFrames}-slot RAM ring, ${autoStopSec}s idle auto-stop)`,
    ramDetail:
      "Cleared immediately on WebSocket close via hub.ring.clear() and 10-min GC; server/src/log.ts scrubs DENY keys, >48-char strings, and AIza secrets.",
    readerTitle: "3. Profile-Blind Label Reader & Bystander Guard",
    readerBadge: "0 PROFILE FIELDS SENT",
    readerValue: (piiLeaks, scenes) =>
      `0 profile fields sent to readLabel(), ${piiLeaks}/${scenes} bystander PII leaks`,
    readerDetail:
      "readLabel() receives only 1 to 3 sharpest label JPEGs with zero health profile fields; prompts and JSON schema forbid describing faces, hands, or bystanders.",
    hudTitle: "4. Loaner Glasses /hud & Hardware Capture LED",
    hudBadgeLedOn: "0 B HUD / LED LOCKED ON",
    hudBadgeLedIdle: "0 B HUD / LED OFF",
    hudValueLedOn: "0 B persistent on /hud, Hardware Capture LED ON (DAT 1.0.1)",
    hudValueLedIdle: "0 B persistent on /hud, Capture LED off (glasses camera idle)",
    hudDetailLedOn:
      "Ray-Ban Display /hud writes 0 bytes to localStorage, sessionStorage, or IndexedDB, while firmware V128+ locks the front Capture LED ON during streaming.",
    hudDetailLedIdle:
      "Safe on shared booth or loaner glasses: /hud stores 0 persistent bytes and receives only compact verdict/coach/status/device events.",
    actionsAriaLabel: "Consent review and one-tap local data erasure controls",
    openModalAriaLabel: "Open full privacy and consent details modal",
    wipeAllAriaLabel: "Delete all local medications, allergies, dose history, and consent from this device"
  },
  fi: {
    eyebrow: "Suostumus ja katoavan datan tarkistus",
    heading: "4 tiukkaa tietosuoja- ja suostumusrajaa",
    subtitle:
      "Kooditasolla pakotettu eristys puhelimen localStorage-muistin, katoavan Hub-keskusmuistin, profiilittoman tekstintunnistuksen ja nollatallenteisen /hud-näytön välillä.",
    consentPillAccepted: (version) =>
      version ? `Suostumus voimassa (v${version})` : "Suostumus voimassa",
    consentPillPending: "Suostumus odottaa",
    cameraPillActive: (countdownSec) =>
      countdownSec !== null
        ? `Kamera päällä (${countdownSec} s automaattipysäytys)`
        : "Kamera päällä (45 s automaattipysäytys)",
    cameraPillIdle: "Kamera pois (RAM-puskuri tyhjä)",
    zonesAriaLabel: "HoldUpin neljä tietosuoja- ja tietojen eristysrajaa",
    storageTitle: "1. Puhelimen paikallinen muisti (localStorage)",
    storageBadgeAccepted: "VAIN LAITTEELLA / SUOSTUMUS OK",
    storageBadgePending: "SUOSTUMUS VAADITAAN",
    storageValue: (c) =>
      `${c.medCount} lääkettä, ${c.allergyCount} allergiaa, ${c.avoidCount} välttösääntöä, ${c.doseLogCount} annosta, ${c.cloudDbRows} pilviriviä`,
    storageDetailAccepted:
      "Lääkkeet, allergiat, annoslokit ja ConsentRecord tallentuvat vain selaimen localStorage-muistiin (holdup.*) ja poistuvat yhdellä painalluksella (wipeAllLocalData()).",
    storageDetailPending:
      "Kamera tai mikrofoni ei käynnisty ennen nimenomaista suostumusta; terveystiedot pysyvät vain puhelimessa (0 pilvitietokantariviä).",
    ramTitle: "2. Katoava Hub-keskusmuisti (FrameRing(8))",
    ramBadgeActive: (countdownSec) =>
      countdownSec !== null ? `KUVAA / ${countdownSec} S RAJA` : "KUVAA / 45 S RAJA",
    ramBadgeIdle: "LEPOTILA / 0 KEHYSTÄ",
    ramValueActive: (countdownSec, maxFrames, autoStopSec) =>
      countdownSec !== null
        ? `<= 1 fps tarkistus, pysähtyy ${countdownSec} s kuluttua (enintään ${maxFrames} RAM-kehystä, 0 levytiedostoa)`
        : `<= 1 fps tarkistus, ${autoStopSec} s automaattipysäytys (enintään ${maxFrames} RAM-kehystä, 0 levytiedostoa)`,
    ramValueIdle: (maxFrames, autoStopSec) =>
      `Kamera pois: 0 kehystä muistissa (enintään ${maxFrames} paikan RAM-rengas, ${autoStopSec} s automaattipysäytys)`,
    ramDetail:
      "Tyhjennetään heti yhteyden katketessa (hub.ring.clear()) ja 10 min siivouksessa; server/src/log.ts suodattaa DENY-avaimet, >48 merkin tekstit ja AIza-avaimet.",
    readerTitle: "3. Profiiliton lukija ja sivullisten suoja",
    readerBadge: "0 PROFIILIKENTTÄÄ LÄHETETTY",
    readerValue: (piiLeaks, scenes) =>
      `0 profiilikenttää readLabel()-kutsussa, ${piiLeaks}/${scenes} sivullisten tietovuotoa`,
    readerDetail:
      "readLabel() vastaanottaa vain 1 - 3 terävintä etikettikuvaa ilman profiilitietoja; kehotteet ja JSON-skeema estävät kasvojen, käsien ja sivullisten kuvailun.",
    hudTitle: "4. Lainalasien /hud ja laitteiston kuvaus-LED",
    hudBadgeLedOn: "0 B HUD / LED LUKITTU PÄÄLLE",
    hudBadgeLedIdle: "0 B HUD / LED POIS",
    hudValueLedOn: "0 B tallennettu /hud-näkymään, kuvaus-LED PÄÄLLÄ (DAT 1.0.1)",
    hudValueLedIdle: "0 B tallennettu /hud-näkymään, kuvaus-LED pois (lasikamera lepotilassa)",
    hudDetailLedOn:
      "Ray-Ban Display /hud kirjoittaa 0 tavua localStorage-, sessionStorage- tai IndexedDB-muistiin, ja V128+ pitää etupuolen kuvaus-LEDin päällä kuvattaessa.",
    hudDetailLedIdle:
      "Turvallinen yhteiskäyttö- ja lainalaseissa: /hud tallentaa 0 pysyvää tavua ja vastaanottaa vain tiiviit tulos- ja ohjekortit.",
    actionsAriaLabel: "Suostumuksen tarkastelu ja paikallisten tietojen pikapoisto",
    openModalAriaLabel: "Avaa koko tietosuoja- ja suostumusikkuna",
    wipeAllAriaLabel: "Poista kaikki lääkkeet, allergiat, annoshistoria ja suostumus tältä laitteelta"
  },
  sv: {
    eyebrow: "Samtycke och granskning av flyktig data",
    heading: "4 strikta integritets- och samtyckesgränser",
    subtitle:
      "Kodtvingad isolering mellan mobilens localStorage, flyktigt Hub-RAM, profilblind etikettläsning och noll-lagrande Ray-Ban Display-glasögon.",
    consentPillAccepted: (version) =>
      version ? `Samtycke aktivt (v${version})` : "Samtycke aktivt",
    consentPillPending: "Samtycke väntar",
    cameraPillActive: (countdownSec) =>
      countdownSec !== null
        ? `Kamera aktiv (${countdownSec} s autostopp)`
        : "Kamera aktiv (45 s autostopp)",
    cameraPillIdle: "Kamera av (RAM-ring tom)",
    zonesAriaLabel: "HoldUps fyra gränser för integritet och dataisolering",
    storageTitle: "1. Lokal lagring på mobilen (localStorage)",
    storageBadgeAccepted: "ENDAST LOKALT / SAMTYCKE PÅ",
    storageBadgePending: "SAMTYCKE KRÄVS",
    storageValue: (c) =>
      `${c.medCount} läkemedel, ${c.allergyCount} allergier, ${c.avoidCount} undvik-regler, ${c.doseLogCount} doser, ${c.cloudDbRows} molnrader`,
    storageDetailAccepted:
      "Läkemedel, allergier, doshistorik och ConsentRecord sparas enbart i webbläsarens localStorage (holdup.*) och raderas med ett tryck via wipeAllLocalData().",
    storageDetailPending:
      "Ingen kamera- eller mikrofonkontroll startar före uttryckligt samtycke; hälsodata stannar på den här enheten med 0 rader i molndatabaser.",
    ramTitle: "2. Flyktigt Hub-RAM (FrameRing(8))",
    ramBadgeActive: (countdownSec) =>
      countdownSec !== null ? `STRÖMMAR / ${countdownSec} S GRÄNS` : "STRÖMMAR / 45 S GRÄNS",
    ramBadgeIdle: "VÄNTELÄGE / 0 RAM-BILDER",
    ramValueActive: (countdownSec, maxFrames, autoStopSec) =>
      countdownSec !== null
        ? `<= 1 fps aktiv kontroll, autostopp om ${countdownSec} s (max ${maxFrames} RAM-bilder, 0 diskfiler)`
        : `<= 1 fps aktiv kontroll, ${autoStopSec} s autostopp (max ${maxFrames} RAM-bilder, 0 diskfiler)`,
    ramValueIdle: (maxFrames, autoStopSec) =>
      `Kamera av: 0 buffrade bilder (max ${maxFrames}-platsers RAM-ring, ${autoStopSec} s autostopp)`,
    ramDetail:
      "Rensas direkt vid WebSocket-nedkoppling via hub.ring.clear() och 10 min GC; server/src/log.ts maskerar DENY-nycklar, >48 tecken och AIza-hemligheter.",
    readerTitle: "3. Profilblind etikettläsare och omgivningsskydd",
    readerBadge: "0 PROFILFÄLT SKICKADE",
    readerValue: (piiLeaks, scenes) =>
      `0 profilfält skickas till readLabel(), ${piiLeaks}/${scenes} PII-läckor för förbipasserande`,
    readerDetail:
      "readLabel() tar endast emot 1 till 3 skarpaste etikettbilder utan hälsoprofil; instruktioner och JSON-schema förbjuder beskrivning av ansikten, händer och personer.",
    hudTitle: "4. Låneglasögon /hud och hårdvaru-LED",
    hudBadgeLedOn: "0 B HUD / LED LÅST PÅ",
    hudBadgeLedIdle: "0 B HUD / LED AV",
    hudValueLedOn: "0 B lagrat på /hud, inspelnings-LED PÅ (DAT 1.0.1)",
    hudValueLedIdle: "0 B lagrat på /hud, inspelnings-LED släckt (glasögonkamera i vila)",
    hudDetailLedOn:
      "Ray-Ban Display /hud skriver 0 byte till localStorage, sessionStorage eller IndexedDB medan firmware V128+ låser främre inspelnings-LED PÅ vid strömning.",
    hudDetailLedIdle:
      "Säkert på delade monter- och låneglasögon: /hud lagrar 0 beständiga byte och tar bara emot kompakta besked- och vägledningskort.",
    actionsAriaLabel: "Kontroller för samtyckesöversikt och lokal dataradering med ett tryck",
    openModalAriaLabel: "Öppna fullständig dialog för integritet och samtycke",
    wipeAllAriaLabel: "Radera alla lokala läkemedel, allergier, doshistorik och samtycke från den här enheten"
  }
};

export function summarizePrivacyBoundaries(input: PrivacyBoundaryInput): PrivacyBoundarySummary {
  const { profile, consent, cameraActive, autoStopRemainingSec, device } = input;

  const medCount = Array.isArray(profile.meds) ? profile.meds.length : 0;
  const allergyCount = Array.isArray(profile.allergies) ? profile.allergies.length : 0;
  const avoidCount = Array.isArray(profile.avoid) ? profile.avoid.length : 0;
  const doseLogCount = Array.isArray(profile.doseLog) ? profile.doseLog.length : 0;

  const consentAccepted = Boolean(consent?.accepted);
  const consentVersion =
    consent && typeof consent.version === "string" && consent.version.trim().length > 0
      ? consent.version.trim()
      : null;

  const isCameraActive = Boolean(cameraActive);
  const hasFiniteCountdown =
    isCameraActive &&
    typeof autoStopRemainingSec === "number" &&
    Number.isFinite(autoStopRemainingSec);

  const activeCountdownSec = hasFiniteCountdown
    ? Math.max(0, Math.min(IDLE_AUTO_STOP_SEC, Math.round(autoStopRemainingSec)))
    : null;

  const glassesConnected = Boolean(device.connected);
  const glassesStreaming = Boolean(device.streaming);
  const captureLedActive = Boolean(device.connected && device.streaming && isCameraActive);

  return {
    onDeviceStorage: {
      medCount,
      allergyCount,
      avoidCount,
      doseLogCount,
      consentAccepted,
      consentVersion,
      cloudDbRows: 0
    },
    ephemeralHubRam: {
      maxRingFrames: MAX_RING_FRAMES,
      idleAutoStopSec: IDLE_AUTO_STOP_SEC,
      cameraActive: isCameraActive,
      activeCountdownSec,
      clearedOnDisconnect: true,
      serverDiskFiles: 0
    },
    blindModelReader: {
      profileFieldsSentToReadLabel: 0,
      bystanderFaceIgnoreEnforced: true,
      bystanderPiiLeaks: 0,
      bystanderRedTeamScenes: BYSTANDER_RED_TEAM_SCENES,
      maxFramesPerVerify: 3
    },
    loanerGlassesHud: {
      hudPersistentBytes: 0,
      captureLedActive,
      glassesConnected,
      glassesStreaming
    }
  };
}

function ZoneIcon({ id }: { id: PrivacyZoneId }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (id === "onDeviceStorage") {
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
        style={iconStyle}
      >
        <rect x="6" y="2" width="12" height="20" rx="2.5" />
        <path d="M10 18h4" />
        <path d="M9.5 9.5l1.8 1.8 3.4-3.6" />
      </svg>
    );
  }

  if (id === "ephemeralHubRam") {
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
        style={iconStyle}
      >
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.6 1.6" />
        <path d="M9 2h6" />
      </svg>
    );
  }

  if (id === "blindModelReader") {
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
        style={iconStyle}
      >
        <path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-4z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    );
  }

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
      style={iconStyle}
    >
      <rect x="2" y="8" width="8" height="7" rx="2.5" />
      <rect x="14" y="8" width="8" height="7" rx="2.5" />
      <path d="M10 11h4" />
      <circle cx="19.5" cy="5" r="2" />
    </svg>
  );
}

export function PrivacyFlowCard(props: PrivacyFlowCardProps) {
  const {
    profile,
    consent,
    cameraActive,
    autoStopRemainingSec,
    device,
    lang,
    onOpenPrivacyModal,
    onWipeAll
  } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const summary = summarizePrivacyBoundaries({
    profile,
    consent,
    cameraActive,
    autoStopRemainingSec,
    device
  });

  const { onDeviceStorage, ephemeralHubRam, blindModelReader, loanerGlassesHud } = summary;
  const hasOpenModal = typeof onOpenPrivacyModal === "function";
  const hasWipeAll = typeof onWipeAll === "function";
  const hasActions = hasOpenModal || hasWipeAll;

  const consentTone: Tone = onDeviceStorage.consentAccepted ? "ok" : "warn";
  const cameraTone: Tone = ephemeralHubRam.cameraActive ? "info" : "neutral";

  const zones: readonly ZoneTileSpec[] = [
    {
      id: "onDeviceStorage",
      state: onDeviceStorage.consentAccepted ? "accepted" : "pending",
      tone: consentTone,
      badge: onDeviceStorage.consentAccepted
        ? copy.storageBadgeAccepted
        : copy.storageBadgePending,
      title: copy.storageTitle,
      value: copy.storageValue(onDeviceStorage),
      detail: onDeviceStorage.consentAccepted
        ? copy.storageDetailAccepted
        : copy.storageDetailPending
    },
    {
      id: "ephemeralHubRam",
      state: ephemeralHubRam.cameraActive ? "active" : "idle",
      tone: ephemeralHubRam.cameraActive ? "warn" : "ok",
      badge: ephemeralHubRam.cameraActive
        ? copy.ramBadgeActive(ephemeralHubRam.activeCountdownSec)
        : copy.ramBadgeIdle,
      title: copy.ramTitle,
      value: ephemeralHubRam.cameraActive
        ? copy.ramValueActive(
            ephemeralHubRam.activeCountdownSec,
            ephemeralHubRam.maxRingFrames,
            ephemeralHubRam.idleAutoStopSec
          )
        : copy.ramValueIdle(ephemeralHubRam.maxRingFrames, ephemeralHubRam.idleAutoStopSec),
      detail: copy.ramDetail
    },
    {
      id: "blindModelReader",
      state: "isolated",
      tone: "ok",
      badge: copy.readerBadge,
      title: copy.readerTitle,
      value: copy.readerValue(
        blindModelReader.bystanderPiiLeaks,
        blindModelReader.bystanderRedTeamScenes
      ),
      detail: copy.readerDetail
    },
    {
      id: "loanerGlassesHud",
      state: loanerGlassesHud.captureLedActive ? "led_active" : "led_idle",
      tone: loanerGlassesHud.captureLedActive ? "ok" : "info",
      badge: loanerGlassesHud.captureLedActive ? copy.hudBadgeLedOn : copy.hudBadgeLedIdle,
      title: copy.hudTitle,
      value: loanerGlassesHud.captureLedActive ? copy.hudValueLedOn : copy.hudValueLedIdle,
      detail: loanerGlassesHud.captureLedActive ? copy.hudDetailLedOn : copy.hudDetailLedIdle
    }
  ];

  return (
    <section
      aria-labelledby="privacy-flow-card-heading"
      lang={locale}
      className="card privacy-flow-card"
      data-consent-state={onDeviceStorage.consentAccepted ? "accepted" : "pending"}
      data-camera-state={ephemeralHubRam.cameraActive ? "active" : "idle"}
      data-capture-led={loanerGlassesHud.captureLedActive ? "active" : "inactive"}
      style={CARD_STYLE}
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
            flexDirection: "column",
            gap: "6px",
            flex: "1 1 320px"
          }}
        >
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
            id="privacy-flow-card-heading"
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

        <div
          role="status"
          aria-live="polite"
          className="privacy-flow-status-pills"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            className="badge privacy-consent-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              ...TONE_BADGE_STYLES[consentTone]
            }}
          >
            {onDeviceStorage.consentAccepted
              ? copy.consentPillAccepted(onDeviceStorage.consentVersion)
              : copy.consentPillPending}
          </span>

          <span
            className="badge privacy-camera-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              ...TONE_BADGE_STYLES[cameraTone]
            }}
          >
            {ephemeralHubRam.cameraActive
              ? copy.cameraPillActive(ephemeralHubRam.activeCountdownSec)
              : copy.cameraPillIdle}
          </span>
        </div>
      </header>

      <dl
        aria-label={copy.zonesAriaLabel}
        className="privacy-flow-grid"
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        {zones.map((zone) => {
          const isSolid = zone.tone === "ok";
          return (
            <div
              key={zone.id}
              data-zone-id={zone.id}
              data-zone-state={zone.state}
              className={`privacy-zone-tile privacy-zone-${zone.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "8px",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: `var(--border-width, 1.5px) ${isSolid ? "solid" : "dashed"} ${TONE_BORDER_COLORS[zone.tone]}`
              }}
            >
              <dt
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  margin: 0
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
                    className="badge privacy-zone-badge"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "4px 10px",
                      borderRadius: "var(--radius-sm, 8px)",
                      fontSize: "0.78rem",
                      fontWeight: 800,
                      letterSpacing: "0.03em",
                      fontVariantNumeric: "tabular-nums",
                      ...TONE_BADGE_STYLES[zone.tone]
                    }}
                  >
                    <ZoneIcon id={zone.id} />
                    <span>{zone.badge}</span>
                  </span>
                </div>

                <span
                  style={{
                    fontSize: "var(--text-base, 1.125rem)",
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {zone.title}
                </span>
              </dt>

              <dd
                style={{
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px"
                }}
              >
                <div
                  style={{
                    fontSize: "var(--text-sm, 1rem)",
                    fontWeight: 700,
                    lineHeight: 1.35,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {zone.value}
                </div>

                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-xs, 0.875rem)",
                    lineHeight: 1.45,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {zone.detail}
                </p>
              </dd>
            </div>
          );
        })}
      </dl>

      <p
        className="privacy-mdr-boundary-note"
        style={{
          margin: 0,
          fontSize: "var(--text-xs, 0.875rem)",
          lineHeight: 1.4,
          color: "var(--text-secondary, #d8e1ee)"
        }}
      >
        {t(locale, "notMedicalDevice")}
      </p>

      {hasActions ? (
        <div
          role="group"
          aria-label={copy.actionsAriaLabel}
          className="privacy-flow-actions"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "var(--space-3, 12px)"
          }}
        >
          {hasOpenModal ? (
            <button
              type="button"
              className="btn btn-secondary privacy-open-modal-btn"
              data-privacy-action="open-modal"
              aria-label={copy.openModalAriaLabel}
              onClick={() => onOpenPrivacyModal?.()}
              style={ACTION_BUTTON_STYLE}
            >
              <span>{t(locale, "privacyButton")}</span>
            </button>
          ) : null}

          {hasWipeAll ? (
            <button
              type="button"
              className="btn btn-danger privacy-wipe-all-btn"
              data-privacy-action="wipe-all"
              aria-label={copy.wipeAllAriaLabel}
              onClick={() => onWipeAll?.()}
              style={ACTION_BUTTON_STYLE}
            >
              <span>{t(locale, "deleteAllData")}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default PrivacyFlowCard;
