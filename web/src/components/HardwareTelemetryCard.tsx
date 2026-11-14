import React, { type CSSProperties } from "react";
import { computeAdaptiveParams, type AdaptiveProfile } from "../camera/adaptive.ts";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { DeviceState, TransportMode } from "../types.ts";

void React;

export const LOW_BATTERY_THRESHOLD_PCT = 15;

export type SessionMode = TransportMode;
export type AdaptiveParams = AdaptiveProfile;

export type GlassesLinkState =
  | "streaming_glasses"
  | "standby_glasses"
  | "low_battery_fallback"
  | "doffed_fallback"
  | "phone_only";

export type AdaptiveTier = "high_768p" | "medium_640p" | "low_512p" | "offline";

export type HardwareLinkInput = {
  device: DeviceState;
  hudConnected: boolean;
  mode: SessionMode;
  rttMs: number | null;
  cameraActive: boolean;
};

export type HardwareLinkSummary = {
  glassesLink: GlassesLinkState;
  captureLedActive: boolean;
  adaptiveTier: AdaptiveTier;
  adaptiveParams: AdaptiveParams;
  hudConnected: boolean;
  activeEye: "glasses" | "phone";
  bluetoothAudioReady: boolean;
  batteryPercent: number | null;
  rttMs: number | null;
  mode: SessionMode;
};

export type HardwareTelemetryCardProps = {
  device: DeviceState;
  hudConnected: boolean;
  mode: SessionMode;
  rttMs: number | null;
  cameraActive: boolean;
  lang: string;
};

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

type TileId = "dat-camera" | "capture-led" | "hud-waveguide" | "adaptive-bandwidth";

type TelemetryTileSpec = {
  id: TileId;
  state: string;
  tone: Tone;
  title: string;
  badge: string;
  value: string;
  detail: string;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  gridAriaLabel: string;
  overallStatus: Record<GlassesLinkState, string>;
  modeLabels: Record<SessionMode, string>;
  batteryNotReported: string;
  rttMeasuring: string;
  datTitle: string;
  datBadges: Record<GlassesLinkState, string>;
  datValue: (state: GlassesLinkState, batteryText: string) => string;
  datDetail: Record<GlassesLinkState, string>;
  ledTitle: string;
  ledBadgeActive: string;
  ledBadgeIdle: string;
  ledValueActive: string;
  ledValueIdle: string;
  ledDetailActive: string;
  ledDetailIdle: string;
  hudTitle: string;
  hudBadgeConnected: string;
  hudBadgeStandby: string;
  hudValueConnected: string;
  hudValueStandby: string;
  hudDetailConnected: string;
  hudDetailStandby: string;
  adaptiveTitle: string;
  adaptiveBadges: Record<AdaptiveTier, string>;
  adaptiveValue: (
    tier: AdaptiveTier,
    params: AdaptiveParams,
    rttText: string,
    modeText: string
  ) => string;
  adaptiveDetail: Record<AdaptiveTier, string>;
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
  danger: {
    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
    color: "var(--verdict-warning-fg, #ffb8ab)",
    border: "var(--border-width, 1.5px) solid var(--verdict-warning-border, #ff6b52)"
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
  danger: "var(--verdict-warning-border, #ff6b52)",
  info: "var(--verdict-info-border, #4da3ff)",
  neutral: "var(--border-strong, #6980a3)"
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Meta Wearables Live Surface",
    heading: "Meta AI Glasses, Capture LED & Adaptive Link Telemetry",
    subtitle:
      "At-a-glance status across Ray-Ban Meta Gen 2 DAT 1.0.1 camera + Bluetooth HFP audio, Ray-Ban Display 600x600 /hud-ws waveguide, and RTT-adaptive streaming.",
    gridAriaLabel: "Meta wearables hardware telemetry tiles",
    overallStatus: {
      streaming_glasses: "Glasses DAT Active",
      standby_glasses: "Glasses Paired (Standby)",
      low_battery_fallback: "Low Battery -> Phone Eye",
      doffed_fallback: "Glasses Doffed -> Phone Eye",
      phone_only: "Phone Camera Fallback"
    },
    modeLabels: {
      live: "LIVE",
      snapshot: "SNAPSHOT",
      offline: "OFFLINE"
    },
    batteryNotReported: "N/A",
    rttMeasuring: "RTT probing",
    datTitle: "Ray-Ban Gen 2 DAT Camera",
    datBadges: {
      streaming_glasses: "DAT 1.0.1 STREAMING",
      standby_glasses: "BT HFP READY",
      low_battery_fallback: "LOW BATTERY <15%",
      doffed_fallback: "DOFFED FALLBACK",
      phone_only: "PHONE EYE ACTIVE"
    },
    datValue: (state, batteryText) => {
      if (state === "streaming_glasses") {
        return `First-person DAT 1.0.1 + BT HFP (${batteryText})`;
      }
      if (state === "standby_glasses") {
        return `Paired & worn, DAT camera idle (${batteryText})`;
      }
      if (state === "low_battery_fallback") {
        return `Battery ${batteryText} (<15%) -> Phone Camera`;
      }
      if (state === "doffed_fallback") {
        return `Glasses taken off (${batteryText}) -> Phone Camera`;
      }
      return "Phone Camera / Demo Prop eye (DAT standby)";
    },
    datDetail: {
      streaming_glasses:
        "720x1280 first-person frames throttled to <= 1 fps over Android DAT 1.0.1 with open-ear Bluetooth HFP audio.",
      standby_glasses:
        "Bluetooth HFP open-ear mic and speaker ready; DAT camera stays off until an explicit label check starts.",
      low_battery_fallback:
        "Hot-swapped active eye from glasses to phone camera below 15% battery without dropping session or profile state.",
      doffed_fallback:
        "Wear-detection sensor reported worn: false; paused glasses capture and routed frames to phone camera.",
      phone_only:
        "Full coaching and deterministic safety checks run via phone camera while awaiting DAT 1.0.1 bridge link."
    },
    ledTitle: "Firmware Capture LED Bystander Indicator",
    ledBadgeActive: "LED LOCKED ON",
    ledBadgeIdle: "LED OFF (IDLE)",
    ledValueActive: "Front Capture LED illuminated (DAT 1.0.1 + V128+)",
    ledValueIdle: "Capture LED off; zero glasses frames streaming",
    ledDetailActive:
      "Hardware-locked bystander indicator while streaming; prompts and JSON schema forbid describing faces or people.",
    ledDetailIdle:
      "Explicit active checks only with 45s idle auto-stop and an 8-slot RAM-only frame ring cleared on disconnect.",
    hudTitle: "Ray-Ban Display /hud-ws Waveguide",
    hudBadgeConnected: "SYNCED /hud-ws",
    hudBadgeStandby: "WAITING /hud-ws",
    hudValueConnected: "600x600 additive waveguide HUD synced",
    hudValueStandby: "Awaiting /hud Display Web App attach",
    hudDetailConnected:
      "Pure #000000 canvas (<= 65% lit pixels, <= 8 word headline) with Meta Neural Band Arrow* and Enter focus.",
    hudDetailStandby:
      "Zero-code /hud-ws attach replays the latest verdict card on-lens or side-by-side; open-ear voice stays active.",
    adaptiveTitle: "RTT-Adaptive Bandwidth Tier",
    adaptiveBadges: {
      high_768p: "HIGH 768P",
      medium_640p: "MEDIUM 640P",
      low_512p: "LOW 512P SAVER",
      offline: "OFFLINE LOCAL"
    },
    adaptiveValue: (tier, params, rttText, modeText) => {
      if (tier === "offline") {
        return `0 fps network stream (${modeText} BarcodeDetector)`;
      }
      const jpegPct = Math.round(params.jpegQuality * 100);
      return `${params.maxDim} px @ ${params.targetFps} fps, ${jpegPct}% JPEG (${rttText}, ${modeText})`;
    },
    adaptiveDetail: {
      high_768p:
        "Full 768 px crispness (< 250 ms RTT) for micro-printed mg strengths and allergen tables.",
      medium_640p:
        "Balanced 640 px @ 0.75 fps step-down (250 to 650 ms RTT) keeping label text sharp on shared Wi-Fi.",
      low_512p:
        "Saves ~84% video bandwidth above 650 ms RTT; falls back to HTTP /api/verify snapshot if socket drops.",
      offline:
        "Zero cloud traffic; matches EAN/GTIN barcodes locally against on-device meds[] and refuses unsaved labels."
    }
  },
  fi: {
    eyebrow: "Meta-älylasien tilanäkymä",
    heading: "Meta AI -lasit, kuvaus-LED ja mukautuva yhteystelemetria",
    subtitle:
      "Reaaliaikainen tila Ray-Ban Meta Gen 2 DAT 1.0.1 -kameralle + Bluetooth HFP -äänelle, Ray-Ban Display 600x600 /hud-ws -näytölle ja RTT-mukautuvalle kuvavirralle.",
    gridAriaLabel: "Meta-älylasien laitteistotelemetrian ruudut",
    overallStatus: {
      streaming_glasses: "Lasien DAT-kamera aktiivinen",
      standby_glasses: "Lasit yhdistetty (valmiustila)",
      low_battery_fallback: "Akku vähissä -> puhelinkamera",
      doffed_fallback: "Lasit riisuttu -> puhelinkamera",
      phone_only: "Puhelinkameran varatila"
    },
    modeLabels: {
      live: "LIVE",
      snapshot: "KERTAKUVA",
      offline: "OFFLINE"
    },
    batteryNotReported: "Ei tietoa",
    rttMeasuring: "RTT mitataan",
    datTitle: "Ray-Ban Gen 2 DAT -kamera",
    datBadges: {
      streaming_glasses: "DAT 1.0.1 KUVAA",
      standby_glasses: "BT HFP VALMIS",
      low_battery_fallback: "AKKU ALLE 15 %",
      doffed_fallback: "RIISUTTU VARATILA",
      phone_only: "PUHELINLINSSI"
    },
    datValue: (state, batteryText) => {
      if (state === "streaming_glasses") {
        return `Ensimmäisen persoonan DAT 1.0.1 + BT HFP (${batteryText})`;
      }
      if (state === "standby_glasses") {
        return `Yhdistetty ja päässä, DAT valmiustilassa (${batteryText})`;
      }
      if (state === "low_battery_fallback") {
        return `Akku ${batteryText} (<15 %) -> puhelinkamera`;
      }
      if (state === "doffed_fallback") {
        return `Lasit otettu pois päästä (${batteryText}) -> puhelinkamera`;
      }
      return "Puhelinkamera / demokuva käytössä (DAT valmiustilassa)";
    },
    datDetail: {
      streaming_glasses:
        "720x1280-kuvavirta rajoitettu <= 1 fps Android DAT 1.0.1 -sillan kautta sekä avoin Bluetooth HFP -ääni.",
      standby_glasses:
        "Bluetooth HFP -mikrofoni ja -kaiutin valmiina; DAT-kamera pysyy pois päältä kunnes tarkistus käynnistetään.",
      low_battery_fallback:
        "Kuvaus vaihdettu automaattisesti puhelinkameraan alle 15 % varaustasolla ilman istunnon katkeamista.",
      doffed_fallback:
        "Tunnistin ilmoitti worn: false; lasien kuvaus keskeytettiin ja siirrettiin puhelinkameraan.",
      phone_only:
        "Ohjaus ja deterministiset turvatarkistukset toimivat puhelinkameralla odottaessa DAT 1.0.1 -yhteyttä."
    },
    ledTitle: "Laiteohjelmiston kuvaus-LED sivullisille",
    ledBadgeActive: "LED LUKITTU PÄÄLLE",
    ledBadgeIdle: "LED POIS (LEPO)",
    ledValueActive: "Etupuolen kuvaus-LED palaa (DAT 1.0.1 + V128+)",
    ledValueIdle: "Kuvaus-LED sammutettu; ei kuvavirtaa laseista",
    ledDetailActive:
      "Laitteistolukittu merkkivalo kuvauksen aikana; kehotteet ja JSON-skeema estävät kasvojen ja henkilöiden kuvailun.",
    ledDetailIdle:
      "Vain käyttäjän käynnistämät tarkistukset, 45 s automaattipysäytys ja 8 kehyksen RAM-puskuri ilman tallennusta.",
    hudTitle: "Ray-Ban Display /hud-ws -valojohdenäyttö",
    hudBadgeConnected: "SYNKRONOITU /hud-ws",
    hudBadgeStandby: "ODOTTAA /hud-ws",
    hudValueConnected: "600x600 additiivinen HUD-kortti synkronoitu",
    hudValueStandby: "Odottaa /hud-näyttösovelluksen liittymistä",
    hudDetailConnected:
      "Puhdas #000000-tausta (<= 65 % valaistuja pikseleitä, <= 8 sanan otsikko) ja Meta Neural Band Arrow* / Enter -ohjaus.",
    hudDetailStandby:
      "Kooditon /hud-ws-liitos toistaa viimeisimmän tuloksen linssille tai rinnakkaisikkunaan; ääni pysyy aktiivisena.",
    adaptiveTitle: "RTT-mukautuva kaistanleveystaso",
    adaptiveBadges: {
      high_768p: "KORKEA 768P",
      medium_640p: "KESKITASO 640P",
      low_512p: "MATALA 512P SÄÄSTÖ",
      offline: "OFFLINE PAIKALLINEN"
    },
    adaptiveValue: (tier, params, rttText, modeText) => {
      if (tier === "offline") {
        return `0 fps verkkovirta (${modeText} BarcodeDetector)`;
      }
      const jpegPct = Math.round(params.jpegQuality * 100);
      return `${params.maxDim} px @ ${params.targetFps} fps, ${jpegPct} % JPEG (${rttText}, ${modeText})`;
    },
    adaptiveDetail: {
      high_768p:
        "Täysi 768 px tarkkuus (< 250 ms RTT) pienille mg-vahvuuksille ja allergeeniluetteloille.",
      medium_640p:
        "Tasapainotettu 640 px @ 0.75 fps porrastus (250 - 650 ms RTT) pitää etiketin terävänä ruuhkaisessa Wi-Fi-verkossa.",
      low_512p:
        "Säästää ~84 % videokaistaa yli 650 ms viiveellä; siirtyy HTTP /api/verify -kertakuvaan yhteyden katketessa.",
      offline:
        "Ei verkkoliikennettä; täsmää EAN/GTIN-viivakoodit paikallisesti tallennettuihin lääkkeisiin eikä arvaa tuntemattomia."
    }
  },
  sv: {
    eyebrow: "Meta Wearables liveöversikt",
    heading: "Meta AI-glasögon, inspelnings-LED och adaptiv länktelemetri",
    subtitle:
      "Överblick i realtid för Ray-Ban Meta Gen 2 DAT 1.0.1-kamera + Bluetooth HFP-ljud, Ray-Ban Display 600x600 /hud-ws-vågledare och RTT-adaptiv strömning.",
    gridAriaLabel: "Hårdvarutelemetri för Meta-glasögon",
    overallStatus: {
      streaming_glasses: "Glasögonens DAT aktiv",
      standby_glasses: "Glasögon parkopplade (vänteläge)",
      low_battery_fallback: "Lågt batteri -> mobilkamera",
      doffed_fallback: "Glasögon avtagna -> mobilkamera",
      phone_only: "Mobilkamera som reserv"
    },
    modeLabels: {
      live: "LIVE",
      snapshot: "STILLBILD",
      offline: "OFFLINE"
    },
    batteryNotReported: "Saknas",
    rttMeasuring: "Mäter RTT",
    datTitle: "Ray-Ban Gen 2 DAT-kamera",
    datBadges: {
      streaming_glasses: "DAT 1.0.1 STRÖMMAR",
      standby_glasses: "BT HFP REDO",
      low_battery_fallback: "BATTERI <15 %",
      doffed_fallback: "AVTAGNA RESERV",
      phone_only: "MOBILKAMERA AKTIV"
    },
    datValue: (state, batteryText) => {
      if (state === "streaming_glasses") {
        return `Förstapersons DAT 1.0.1 + BT HFP (${batteryText})`;
      }
      if (state === "standby_glasses") {
        return `Parkopplade och burna, DAT i vänteläge (${batteryText})`;
      }
      if (state === "low_battery_fallback") {
        return `Batteri ${batteryText} (<15 %) -> mobilkamera`;
      }
      if (state === "doffed_fallback") {
        return `Glasögon avtagna (${batteryText}) -> mobilkamera`;
      }
      return "Mobilkamera / demorekvisita aktiv (DAT i vänteläge)";
    },
    datDetail: {
      streaming_glasses:
        "720x1280-bildrutor strypta till <= 1 fps via Android DAT 1.0.1 med öppet Bluetooth HFP-ljud.",
      standby_glasses:
        "Bluetooth HFP-mikrofon och -högtalare redo; DAT-kameran förblir avstängd tills en aktiv kontroll startas.",
      low_battery_fallback:
        "Växlade automatiskt aktiv kamera till mobilen under 15 % batteri utan att tappa session eller profil.",
      doffed_fallback:
        "Bärsensorn rapporterade worn: false; pausade glasögonkameran och växlade till mobilkameran.",
      phone_only:
        "Full vägledning och deterministiska säkerhetskontroller körs via mobilkameran i väntan på DAT 1.0.1-länk."
    },
    ledTitle: "Firmware inspelnings-LED för omgivningen",
    ledBadgeActive: "LED LÅST PÅ",
    ledBadgeIdle: "LED AV (VÄNTELÄGE)",
    ledValueActive: "Främre inspelnings-LED tänd (DAT 1.0.1 + V128+)",
    ledValueIdle: "Inspelnings-LED släckt; ingen bildström från glasögon",
    ledDetailActive:
      "Hårdvarulåst indikator vid strömning; instruktioner och JSON-schema förbjuder beskrivning av ansikten och personer.",
    ledDetailIdle:
      "Endast uttryckliga kontroller med 45 s automatiskt stopp och 8-platsers RAM-buffert som rensas vid nedkoppling.",
    hudTitle: "Ray-Ban Display /hud-ws vågledare",
    hudBadgeConnected: "SYNKAD /hud-ws",
    hudBadgeStandby: "VÄNTAR /hud-ws",
    hudValueConnected: "600x600 additivt vågledarkort synkroniserat",
    hudValueStandby: "Väntar på /hud Display Web App-anslutning",
    hudDetailConnected:
      "Ren #000000-bakgrund (<= 65 % tända pixlar, <= 8 ord i rubriken) med Meta Neural Band Arrow* och Enter-fokus.",
    hudDetailStandby:
      "Kodfri /hud-ws-anslutning spelar upp senaste beskedet i linsen eller sida vid sida; röstsvaret förblir aktivt.",
    adaptiveTitle: "RTT-adaptiv bandbreddsnivå",
    adaptiveBadges: {
      high_768p: "HÖG 768P",
      medium_640p: "MEDEL 640P",
      low_512p: "LÅG 512P SPARLÄGE",
      offline: "OFFLINE LOKAL"
    },
    adaptiveValue: (tier, params, rttText, modeText) => {
      if (tier === "offline") {
        return `0 fps nätverksström (${modeText} BarcodeDetector)`;
      }
      const jpegPct = Math.round(params.jpegQuality * 100);
      return `${params.maxDim} px @ ${params.targetFps} fps, ${jpegPct} % JPEG (${rttText}, ${modeText})`;
    },
    adaptiveDetail: {
      high_768p:
        "Full 768 px-skärpa (< 250 ms RTT) för finstilt mg-styrka och allergentabeller.",
      medium_640p:
        "Balanserad nedtrappning till 640 px @ 0.75 fps (250 till 650 ms RTT) som bevarar etikettskärpan över delat Wi-Fi.",
      low_512p:
        "Sparar ~84 % videobandbredd över 650 ms RTT; växlar till HTTP /api/verify-stillbild om anslutningen bryts.",
      offline:
        "Ingen molntrafik; matchar EAN/GTIN-streckkoder lokalt mot sparade läkemedel och avvisar okända förpackningar."
    }
  }
};

export function summarizeHardwareLink(input: HardwareLinkInput): HardwareLinkSummary {
  const { device, hudConnected, mode, rttMs, cameraActive } = input;
  const rawBattery = device.battery;
  const hasFiniteBattery = typeof rawBattery === "number" && Number.isFinite(rawBattery);
  const batteryPercent = hasFiniteBattery
    ? Math.max(0, Math.min(100, Math.round(rawBattery)))
    : null;

  let glassesLink: GlassesLinkState;
  if (hasFiniteBattery && rawBattery < LOW_BATTERY_THRESHOLD_PCT) {
    glassesLink = "low_battery_fallback";
  } else if (!device.connected) {
    glassesLink = "phone_only";
  } else if (!device.worn) {
    glassesLink = "doffed_fallback";
  } else if (device.streaming && cameraActive) {
    glassesLink = "streaming_glasses";
  } else {
    glassesLink = "standby_glasses";
  }

  const captureLedActive = Boolean(device.connected && device.streaming && cameraActive);

  const online = mode !== "offline";
  const adaptiveParams = computeAdaptiveParams(rttMs, online);

  let adaptiveTier: AdaptiveTier;
  if (!online || adaptiveParams.targetFps <= 0) {
    adaptiveTier = "offline";
  } else if (adaptiveParams.maxDim >= 768) {
    adaptiveTier = "high_768p";
  } else if (adaptiveParams.maxDim >= 640) {
    adaptiveTier = "medium_640p";
  } else {
    adaptiveTier = "low_512p";
  }

  const normalizedRttMs =
    typeof rttMs === "number" && Number.isFinite(rttMs) && rttMs >= 0
      ? Math.round(rttMs)
      : null;

  return {
    glassesLink,
    captureLedActive,
    adaptiveTier,
    adaptiveParams,
    hudConnected: Boolean(hudConnected),
    activeEye: glassesLink === "streaming_glasses" ? "glasses" : "phone",
    bluetoothAudioReady: Boolean(device.connected),
    batteryPercent,
    rttMs: normalizedRttMs,
    mode
  };
}

function getGlassesLinkTone(state: GlassesLinkState): Tone {
  if (state === "streaming_glasses") return "ok";
  if (state === "standby_glasses") return "info";
  if (state === "low_battery_fallback") return "danger";
  if (state === "doffed_fallback") return "warn";
  return "neutral";
}

function getAdaptiveTierTone(tier: AdaptiveTier): Tone {
  if (tier === "high_768p") return "ok";
  if (tier === "medium_640p") return "info";
  if (tier === "low_512p") return "warn";
  return "danger";
}

function TileIcon({ id }: { id: TileId }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (id === "dat-camera") {
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
        <path d="M2 10.5L1 9" />
        <path d="M22 10.5L23 9" />
      </svg>
    );
  }

  if (id === "capture-led") {
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
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v3" />
        <path d="M12 19v3" />
        <path d="M2 12h3" />
        <path d="M19 12h3" />
        <path d="M4.9 4.9l2.2 2.2" />
        <path d="M16.9 16.9l2.2 2.2" />
      </svg>
    );
  }

  if (id === "hud-waveguide") {
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
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M7 9h10" />
        <path d="M7 13h6" />
        <path d="M7 17h4" />
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
      <path d="M4 19v-4" />
      <path d="M9 19v-7" />
      <path d="M14 19V9" />
      <path d="M19 19V5" />
    </svg>
  );
}

export function HardwareTelemetryCard(props: HardwareTelemetryCardProps) {
  const { device, hudConnected, mode, rttMs, cameraActive, lang } = props;
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const summary = summarizeHardwareLink({
    device,
    hudConnected,
    mode,
    rttMs,
    cameraActive
  });

  const batteryText =
    summary.batteryPercent !== null ? `${summary.batteryPercent}%` : copy.batteryNotReported;
  const rttText = summary.rttMs !== null ? `${summary.rttMs} ms` : copy.rttMeasuring;
  const modeText = copy.modeLabels[summary.mode];
  const headerTone = getGlassesLinkTone(summary.glassesLink);

  const tiles: readonly TelemetryTileSpec[] = [
    {
      id: "dat-camera",
      state: summary.glassesLink,
      tone: headerTone,
      title: copy.datTitle,
      badge: copy.datBadges[summary.glassesLink],
      value: copy.datValue(summary.glassesLink, batteryText),
      detail: copy.datDetail[summary.glassesLink]
    },
    {
      id: "capture-led",
      state: summary.captureLedActive ? "active" : "inactive",
      tone: summary.captureLedActive ? "ok" : "neutral",
      title: copy.ledTitle,
      badge: summary.captureLedActive ? copy.ledBadgeActive : copy.ledBadgeIdle,
      value: summary.captureLedActive ? copy.ledValueActive : copy.ledValueIdle,
      detail: summary.captureLedActive ? copy.ledDetailActive : copy.ledDetailIdle
    },
    {
      id: "hud-waveguide",
      state: summary.hudConnected ? "connected" : "standby",
      tone: summary.hudConnected ? "ok" : "warn",
      title: copy.hudTitle,
      badge: summary.hudConnected ? copy.hudBadgeConnected : copy.hudBadgeStandby,
      value: summary.hudConnected ? copy.hudValueConnected : copy.hudValueStandby,
      detail: summary.hudConnected ? copy.hudDetailConnected : copy.hudDetailStandby
    },
    {
      id: "adaptive-bandwidth",
      state: summary.adaptiveTier,
      tone: getAdaptiveTierTone(summary.adaptiveTier),
      title: copy.adaptiveTitle,
      badge: copy.adaptiveBadges[summary.adaptiveTier],
      value: copy.adaptiveValue(summary.adaptiveTier, summary.adaptiveParams, rttText, modeText),
      detail: copy.adaptiveDetail[summary.adaptiveTier]
    }
  ];

  return (
    <section
      aria-labelledby="hardware-telemetry-card-heading"
      lang={locale}
      className="card hardware-telemetry-card"
      data-glasses-link={summary.glassesLink}
      data-capture-led={summary.captureLedActive ? "active" : "inactive"}
      data-hud-link={summary.hudConnected ? "connected" : "standby"}
      data-adaptive-tier={summary.adaptiveTier}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
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
            id="hardware-telemetry-card-heading"
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
          className="badge hardware-telemetry-summary-pill"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            ...TONE_BADGE_STYLES[headerTone]
          }}
        >
          <span>{copy.overallStatus[summary.glassesLink]}</span>
        </div>
      </header>

      <dl
        aria-label={copy.gridAriaLabel}
        className="hardware-telemetry-grid"
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        {tiles.map((tile) => {
          const isSolid = tile.tone === "ok" || tile.tone === "danger";
          return (
            <div
              key={tile.id}
              data-tile-id={tile.id}
              data-tile-state={tile.state}
              className={`hardware-telemetry-tile hardware-tile-${tile.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "8px",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: `var(--border-width, 1.5px) ${isSolid ? "solid" : "dashed"} ${TONE_BORDER_COLORS[tile.tone]}`
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
                    className="badge hardware-tile-badge"
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
                      ...TONE_BADGE_STYLES[tile.tone]
                    }}
                  >
                    <TileIcon id={tile.id} />
                    <span>{tile.badge}</span>
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
                  {tile.title}
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
                  {tile.value}
                </div>

                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-xs, 0.875rem)",
                    lineHeight: 1.45,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {tile.detail}
                </p>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export default HardwareTelemetryCard;
