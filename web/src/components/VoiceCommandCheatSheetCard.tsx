import { type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import { parseLocalIntent } from "../session/localVoiceIntent.ts";

export type SampleVoicePhrase = {
  id: string;
  phrase: string;
  intentKind: string;
  description: string;
};

export type HudGestureEvent = "log_dose" | "repeat" | "dismiss";

export type VoiceCommandCheatSheetCardProps = {
  lang: string;
  onRunPhrase?: (phrase: string) => void;
  onTriggerHudGesture?: (event: "log_dose" | "repeat" | "dismiss") => void;
};

type PhraseSeed = {
  id: string;
  phrase: string;
  expectedKind: "question" | "log_dose" | "repeat" | "scan_barcode" | "stop";
  description: string;
};

type GestureReferenceItem = {
  id: "pinch_enter" | "wrist_flick" | "thumb_middle_back";
  mapping: string;
  title: string;
  detail: string;
};

type HudSimAction = {
  event: HudGestureEvent;
  badge: string;
  label: string;
  ariaLabel: string;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  voicePill: string;
  hudPill: string;
  voiceSectionHeading: string;
  voiceSectionHint: string;
  voiceListAria: string;
  tryPhraseHint: string;
  runPhraseAria: (phrase: string, description: string) => string;
  intentLabels: Record<PhraseSeed["expectedKind"], string>;
  gestureSectionHeading: string;
  gestureSectionHint: string;
  gestureListAria: string;
  gestures: readonly GestureReferenceItem[];
  hudSimGroupAria: string;
  hudSimActions: readonly HudSimAction[];
};

const PHRASE_SEEDS_BY_LOCALE: Record<UiLocale, readonly PhraseSeed[]> = {
  en: [
    {
      id: "evening_pill",
      phrase: "Is this my evening pill?",
      expectedKind: "question",
      description: "Verifies the package in view against your scheduled evening medication."
    },
    {
      id: "allergen_check",
      phrase: "Does this contain my allergens?",
      expectedKind: "question",
      description: "Cross-checks printed ingredients and excipients against your on-device allergy list."
    },
    {
      id: "log_dose",
      phrase: "I took it",
      expectedKind: "log_dose",
      description: "Logs the verified dose locally to prevent repeating a same-day pill."
    },
    {
      id: "repeat_verdict",
      phrase: "Repeat last answer",
      expectedKind: "repeat",
      description: "Replays the latest spoken safety verdict over open-ear speakers."
    },
    {
      id: "scan_barcode",
      phrase: "Scan barcode offline",
      expectedKind: "scan_barcode",
      description: "Matches EAN or QR package codes locally with zero network connection."
    },
    {
      id: "stop_check",
      phrase: "Stop check",
      expectedKind: "stop",
      description: "Stops camera streaming immediately and plays the camera-off earcon."
    }
  ],
  fi: [
    {
      id: "evening_pill",
      phrase: "Onko tämä iltalääkkeeni?",
      expectedKind: "question",
      description: "Tarkistaa näkyvissä olevan pakkauksen suhteessa iltalääkkeeseesi."
    },
    {
      id: "allergen_check",
      phrase: "Sisältääkö tämä allergeenejani?",
      expectedKind: "question",
      description: "Vertaa ainesosat ja apuaineet laitteelle tallennettuun allergialistaasi."
    },
    {
      id: "log_dose",
      phrase: "Otin sen",
      expectedKind: "log_dose",
      description: "Kirjaa varmistetun annoksen paikallisesti saman päivän kaksoisannoksen estämiseksi."
    },
    {
      id: "repeat_verdict",
      phrase: "Toista viimeisin vastaus",
      expectedKind: "repeat",
      description: "Toistaa viimeisimmän puhutun turvallisuusarvion avoimen korvan kaiuttimista."
    },
    {
      id: "scan_barcode",
      phrase: "Lue viivakoodi ilman verkkoa",
      expectedKind: "scan_barcode",
      description: "Tunnistaa pakkauksen viiva- tai QR-koodin paikallisesti täysin ilman verkkoa."
    },
    {
      id: "stop_check",
      phrase: "Lopeta tarkistus",
      expectedKind: "stop",
      description: "Pysäyttää kameran lähetyksen heti ja soittaa lopetusäänen."
    }
  ],
  sv: [
    {
      id: "evening_pill",
      phrase: "Är det här min kvällsmedicin?",
      expectedKind: "question",
      description: "Kontrollerar förpackningen i bild mot din schemalagda kvällsmedicin."
    },
    {
      id: "allergen_check",
      phrase: "Innehåller den här mina allergener?",
      expectedKind: "question",
      description: "Jämför ingredienser och hjälpämnen mot din lokalt sparade allergilista."
    },
    {
      id: "log_dose",
      phrase: "Jag tog den",
      expectedKind: "log_dose",
      description: "Registrerar den verifierade dosen lokalt för att förhindra dubbeldos samma dag."
    },
    {
      id: "repeat_verdict",
      phrase: "Upprepa senaste svaret",
      expectedKind: "repeat",
      description: "Spelar upp den senaste talade säkerhetsbedömningen i glasögonen igen."
    },
    {
      id: "scan_barcode",
      phrase: "Skanna streckkod offline",
      expectedKind: "scan_barcode",
      description: "Matchar förpackningens EAN- eller QR-kod lokalt helt utan nätverk."
    },
    {
      id: "stop_check",
      phrase: "Stoppa kontroll",
      expectedKind: "stop",
      description: "Stoppar kameraströmmen direkt och spelar upp avslutningsljudet."
    }
  ]
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Open-Ear Voice & Wrist sEMG",
    heading: "Hands-Free Voice & Neural Band Try-It Guide",
    subtitle:
      "Speak naturally through the glasses open-ear mic or use subtle Meta Neural Band wrist gestures without touching a phone screen.",
    voicePill: "EN / FI / SV Local Intent",
    hudPill: "Ray-Ban Display /hud",
    voiceSectionHeading: "Open-Ear Voice Commands",
    voiceSectionHint:
      "Parsed deterministically on-device before routing label questions to Gemini Live.",
    voiceListAria: "Sample hands-free voice phrases",
    tryPhraseHint: "Tap to simulate",
    runPhraseAria: (phrase, description) => `Simulate voice phrase: ${phrase}. ${description}`,
    intentLabels: {
      question: "QUESTION",
      log_dose: "LOG DOSE",
      repeat: "REPEAT",
      scan_barcode: "BARCODE",
      stop: "STOP"
    },
    gestureSectionHeading: "Meta Neural Band Wrist Gestures",
    gestureSectionHint:
      "Maps sEMG finger pinches and wrist flicks to standard DOM keyboard and history events on the 600x600 additive waveguide.",
    gestureListAria: "Meta Neural Band hardware gesture mappings",
    gestures: [
      {
        id: "pinch_enter",
        mapping: "Thumb-Index Pinch -> Enter",
        title: "Confirm focused HUD action",
        detail:
          "Activates Repeat (safe initial focus) or Log Dose on verified matches, guarded by a 150 ms debounce."
      },
      {
        id: "wrist_flick",
        mapping: "Wrist Flick -> ArrowLeft/Right",
        title: "Cycle 1D spatial focus strip",
        detail:
          "Moves the 4px high-contrast focus ring across Repeat, Log Dose, and Dismiss buttons."
      },
      {
        id: "thumb_middle_back",
        mapping: "Thumb-Middle / Back -> popstate Dismiss",
        title: "Dismiss card to transparent standby",
        detail:
          "Clears the active verdict back to pure #000000 standby within the <= 2-entry history budget."
      }
    ],
    hudSimGroupAria: "Simulate Meta Neural Band HUD events",
    hudSimActions: [
      {
        event: "repeat",
        badge: "Enter",
        label: "Pinch: Repeat Verdict",
        ariaLabel: "Simulate Neural Band pinch to repeat last verdict"
      },
      {
        event: "log_dose",
        badge: "Enter",
        label: "Pinch: Log Dose",
        ariaLabel: "Simulate Neural Band pinch to log matched dose"
      },
      {
        event: "dismiss",
        badge: "Back",
        label: "Back: Dismiss HUD",
        ariaLabel: "Simulate Neural Band back gesture to dismiss HUD card"
      }
    ]
  },
  fi: {
    eyebrow: "Avoin korvaääni ja ranteen sEMG",
    heading: "Kädet vapaana: äänikomennot ja Neural Band -opas",
    subtitle:
      "Puhu luonnollisesti lasien mikrofoniin tai käytä huomaamattomia Meta Neural Band -ranne-eleitä koskematta puhelimen näyttöön.",
    voicePill: "EN / FI / SV paikallinen tulkinta",
    hudPill: "Ray-Ban Display /hud",
    voiceSectionHeading: "Avoimen korvan äänikomennot",
    voiceSectionHint:
      "Tulkitaan deterministisesti laitteella ennen etikettikysymysten ohjaamista Gemini Liveen.",
    voiceListAria: "Esimerkkejä kädet vapaana -äänikomennoista",
    tryPhraseHint: "Kokeile napauttamalla",
    runPhraseAria: (phrase, description) => `Simuloi äänikomento: ${phrase}. ${description}`,
    intentLabels: {
      question: "KYSYMYS",
      log_dose: "KIRJAA ANNOS",
      repeat: "TOISTA",
      scan_barcode: "VIIVAKOODI",
      stop: "LOPETA"
    },
    gestureSectionHeading: "Meta Neural Band -ranne-eleet",
    gestureSectionHint:
      "Muuntaa sEMG-nipistykset ja ranneliikkeet DOM-näppäin- ja historiatapahtumiksi 600x600-näytöllä.",
    gestureListAria: "Meta Neural Band -eleiden kartoitus",
    gestures: [
      {
        id: "pinch_enter",
        mapping: "Thumb-Index Pinch -> Enter",
        title: "Vahvista kohdistettu HUD-toiminto",
        detail:
          "Suorittaa Toista-toiminnon (turvallinen oletuskohdistus) tai Kirjaa annos -valinnan 150 ms virhesuojalla."
      },
      {
        id: "wrist_flick",
        mapping: "Wrist Flick -> ArrowLeft/Right",
        title: "Siirrä 1D-kohdistusta toimintorivillä",
        detail:
          "Liikuttaa 4px korkeakontrastista kohdistusrengasta Toista-, Kirjaa annos- ja Sulje-painikkeiden välillä."
      },
      {
        id: "thumb_middle_back",
        mapping: "Thumb-Middle / Back -> popstate Dismiss",
        title: "Palauta läpinäkyvä valmiustila",
        detail:
          "Tyhjentää aktiivisen kortin takaisin puhtaaseen #000000-valmiustilaan <= 2 tilan historiarajassa."
      }
    ],
    hudSimGroupAria: "Simuloi Meta Neural Band HUD-tapahtumia",
    hudSimActions: [
      {
        event: "repeat",
        badge: "Enter",
        label: "Nipistys: Toista vastaus",
        ariaLabel: "Simuloi Neural Band -nipistys viimeisimmän vastauksen toistamiseksi"
      },
      {
        event: "log_dose",
        badge: "Enter",
        label: "Nipistys: Kirjaa annos",
        ariaLabel: "Simuloi Neural Band -nipistys annoksen kirjaamiseksi"
      },
      {
        event: "dismiss",
        badge: "Back",
        label: "Paluu: Sulje HUD",
        ariaLabel: "Simuloi Neural Band -paluuele HUD-kortin sulkemiseksi"
      }
    ]
  },
  sv: {
    eyebrow: "Öppet ljud och handleds-sEMG",
    heading: "Handsfree: röstkommandon och Neural Band-guide",
    subtitle:
      "Tala naturligt via glasögonens öppna mikrofon eller styr med diskreta Meta Neural Band-handledsgester utan att röra mobilen.",
    voicePill: "EN / FI / SV lokal tolkning",
    hudPill: "Ray-Ban Display /hud",
    voiceSectionHeading: "Röstkommandon med öppet öra",
    voiceSectionHint:
      "Tolkas deterministiskt på enheten innan etikettfrågor skickas vidare till Gemini Live.",
    voiceListAria: "Exempel på handsfree-röstfraser",
    tryPhraseHint: "Tryck för att simulera",
    runPhraseAria: (phrase, description) => `Simulera röstfras: ${phrase}. ${description}`,
    intentLabels: {
      question: "FRÅGA",
      log_dose: "LOGGA DOS",
      repeat: "UPPREPA",
      scan_barcode: "STRECKKOD",
      stop: "STOPPA"
    },
    gestureSectionHeading: "Meta Neural Band-handledsgester",
    gestureSectionHint:
      "Översätter sEMG-fingernyp och handledssvep till DOM-tangent- och historikhändelser på 600x600-vågledaren.",
    gestureListAria: "Meta Neural Band-gestmappning",
    gestures: [
      {
        id: "pinch_enter",
        mapping: "Thumb-Index Pinch -> Enter",
        title: "Bekräfta fokuserad HUD-åtgärd",
        detail:
          "Aktiverar Upprepa (säkert standardfokus) eller Logga dos vid verifierad träff med 150 ms studsfilter."
      },
      {
        id: "wrist_flick",
        mapping: "Wrist Flick -> ArrowLeft/Right",
        title: "Flytta 1D-fokus i åtgärdsraden",
        detail:
          "Flyttar den 4px skarpa fokusringen mellan knapparna Upprepa, Logga dos och Stäng."
      },
      {
        id: "thumb_middle_back",
        mapping: "Thumb-Middle / Back -> popstate Dismiss",
        title: "Stäng kort till transparent viloläge",
        detail:
          "Rensar aktivt besked tillbaka till ren #000000-bakgrund inom historikgränsen på <= 2 steg."
      }
    ],
    hudSimGroupAria: "Simulera Meta Neural Band HUD-händelser",
    hudSimActions: [
      {
        event: "repeat",
        badge: "Enter",
        label: "Nyp: Upprepa svar",
        ariaLabel: "Simulera Neural Band-nyp för att upprepa senaste svaret"
      },
      {
        event: "log_dose",
        badge: "Enter",
        label: "Nyp: Logga dos",
        ariaLabel: "Simulera Neural Band-nyp för att registrera dos"
      },
      {
        event: "dismiss",
        badge: "Back",
        label: "Bakåt: Stäng HUD",
        ariaLabel: "Simulera Neural Band-bakåtgest för att stänga HUD-kortet"
      }
    ]
  }
};

export function getLocalizedVoicePhrases(lang: string): SampleVoicePhrase[] {
  const locale = normalizeLang(lang);
  return PHRASE_SEEDS_BY_LOCALE[locale].map((seed) => {
    const parsed = parseLocalIntent(seed.phrase);
    return {
      id: seed.id,
      phrase: seed.phrase,
      intentKind: parsed.kind,
      description: seed.description
    };
  });
}

type IntentBadgePalette = {
  bg: string;
  fg: string;
  border: string;
};

const INTENT_PALETTE: Record<PhraseSeed["expectedKind"], IntentBadgePalette> = {
  question: {
    bg: "var(--verdict-info-bg, #0a1f38)",
    fg: "var(--verdict-info-fg, #a6d4ff)",
    border: "var(--verdict-info-border, #4da3ff)"
  },
  log_dose: {
    bg: "var(--verdict-match-bg, #06261d)",
    fg: "var(--verdict-match-fg, #7ef7c8)",
    border: "var(--verdict-match-border, #2dd4a0)"
  },
  repeat: {
    bg: "var(--bg-surface, #121926)",
    fg: "var(--text-primary, #f8fafc)",
    border: "var(--border-strong, #6980a3)"
  },
  scan_barcode: {
    bg: "var(--verdict-unsure-bg, #261b04)",
    fg: "var(--verdict-unsure-fg, #ffe169)",
    border: "var(--verdict-unsure-border, #f5b82e)"
  },
  stop: {
    bg: "var(--verdict-warning-bg, #2d0e0a)",
    fg: "var(--verdict-warning-fg, #ffb8ab)",
    border: "var(--verdict-warning-border, #ff6b52)"
  }
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

const SUBSECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const PHRASE_GRID_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const PHRASE_CHIP_BASE_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 14px",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "8px",
  textAlign: "left"
};

const GESTURE_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const GESTURE_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 16px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800,
  flex: "1 1 200px"
};

function IntentIcon({ kind }: { kind: string }) {
  const iconStyle: CSSProperties = { width: "15px", height: "15px", flexShrink: 0 };

  if (kind === "log_dose") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8.2 12.4l2.5 2.5 5.1-5.2" />
      </svg>
    );
  }

  if (kind === "repeat") {
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
        style={iconStyle}
      >
        <polyline points="17 2 21 6 17 10" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 22 3 18 7 14" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    );
  }

  if (kind === "scan_barcode") {
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
        style={iconStyle}
      >
        <path d="M4 6v12" />
        <path d="M8 6v12" />
        <path d="M12 6v12" />
        <path d="M16 6v12" />
        <path d="M20 6v12" />
      </svg>
    );
  }

  if (kind === "stop") {
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
        style={iconStyle}
      >
        <rect x="5" y="5" width="14" height="14" rx="2" />
      </svg>
    );
  }

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
      style={iconStyle}
    >
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

export function VoiceCommandCheatSheetCard(props: VoiceCommandCheatSheetCardProps) {
  const { lang, onRunPhrase, onTriggerHudGesture } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const phrases = getLocalizedVoicePhrases(locale);

  const headingId = "voice-command-cheatsheet-heading";
  const voiceHeadingId = "voice-phrases-heading";
  const gestureHeadingId = "neural-band-gestures-heading";

  const hasRunPhrase = typeof onRunPhrase === "function";
  const hasTriggerGesture = typeof onTriggerHudGesture === "function";

  return (
    <section
      className="card voice-command-cheatsheet-card"
      lang={locale}
      aria-labelledby={headingId}
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
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-lg, 1.25rem)",
              fontWeight: 800,
              lineHeight: 1.28,
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
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            className="pill voice-cheatsheet-intent-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--verdict-info-bg, #0a1f38)",
              color: "var(--verdict-info-fg, #a6d4ff)",
              border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800
            }}
          >
            {copy.voicePill}
          </span>

          <span
            className="pill voice-cheatsheet-hud-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              color: "var(--text-primary, #f8fafc)",
              border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700
            }}
          >
            {copy.hudPill}
          </span>
        </div>
      </header>

      <div
        role="group"
        aria-labelledby={voiceHeadingId}
        className="voice-phrases-section"
        style={SUBSECTION_STYLE}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h3
            id={voiceHeadingId}
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              lineHeight: 1.3
            }}
          >
            {copy.voiceSectionHeading}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              color: "var(--text-secondary, #d8e1ee)",
              lineHeight: 1.4
            }}
          >
            {copy.voiceSectionHint}
          </p>
        </div>

        <ul
          aria-label={copy.voiceListAria}
          className="voice-phrase-grid"
          style={PHRASE_GRID_STYLE}
        >
          {phrases.map((item) => {
            const paletteKey = (
              item.intentKind in INTENT_PALETTE ? item.intentKind : "question"
            ) as PhraseSeed["expectedKind"];
            const palette = INTENT_PALETTE[paletteKey];
            const badgeText = copy.intentLabels[paletteKey];

            const innerContent = (
              <>
                <span
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    width: "100%"
                  }}
                >
                  <span
                    className="badge voice-phrase-intent-badge"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "4px 9px",
                      borderRadius: "var(--radius-sm, 8px)",
                      backgroundColor: palette.bg,
                      color: palette.fg,
                      border: `1.5px solid ${palette.border}`,
                      fontSize: "0.76rem",
                      fontWeight: 800,
                      letterSpacing: "0.03em"
                    }}
                  >
                    <IntentIcon kind={item.intentKind} />
                    <span>{badgeText}</span>
                  </span>

                  {hasRunPhrase ? (
                    <span
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        color: "var(--accent, #5cc0ff)"
                      }}
                    >
                      {copy.tryPhraseHint}
                    </span>
                  ) : null}
                </span>

                <strong
                  className="voice-phrase-utterance"
                  style={{
                    fontSize: "var(--text-base, 1.125rem)",
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {`"${item.phrase}"`}
                </strong>

                <span
                  className="voice-phrase-description"
                  style={{
                    fontSize: "var(--text-xs, 0.875rem)",
                    fontWeight: 500,
                    lineHeight: 1.4,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {item.description}
                </span>
              </>
            );

            return (
              <li
                key={item.id}
                data-phrase-id={item.id}
                data-intent-kind={item.intentKind}
                className="voice-phrase-item"
                style={{ display: "flex" }}
              >
                {hasRunPhrase ? (
                  <button
                    type="button"
                    className="btn btn-secondary voice-phrase-btn"
                    data-phrase-id={item.id}
                    data-intent-kind={item.intentKind}
                    aria-label={copy.runPhraseAria(item.phrase, item.description)}
                    onClick={() => onRunPhrase?.(item.phrase)}
                    style={PHRASE_CHIP_BASE_STYLE}
                  >
                    {innerContent}
                  </button>
                ) : (
                  <div className="voice-phrase-chip" style={PHRASE_CHIP_BASE_STYLE}>
                    {innerContent}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div
        role="group"
        aria-labelledby={gestureHeadingId}
        className="neural-band-gestures-section"
        style={SUBSECTION_STYLE}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h3
            id={gestureHeadingId}
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              lineHeight: 1.3
            }}
          >
            {copy.gestureSectionHeading}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              color: "var(--text-secondary, #d8e1ee)",
              lineHeight: 1.4
            }}
          >
            {copy.gestureSectionHint}
          </p>
        </div>

        <ul
          aria-label={copy.gestureListAria}
          className="neural-band-gesture-list"
          style={GESTURE_LIST_STYLE}
        >
          {copy.gestures.map((gesture) => (
            <li
              key={gesture.id}
              data-gesture-id={gesture.id}
              className="neural-band-gesture-item"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "12px 14px",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-surface, #121926)",
                border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
              }}
            >
              <code
                className="badge neural-band-mapping-badge"
                style={{
                  alignSelf: "flex-start",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-sm, 8px)",
                  backgroundColor: "var(--accent-subtle, rgba(92, 192, 255, 0.16))",
                  color: "var(--text-primary, #f8fafc)",
                  border: "1.5px solid var(--accent, #5cc0ff)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  whiteSpace: "normal"
                }}
              >
                {gesture.mapping}
              </code>

              <strong
                style={{
                  fontSize: "var(--text-sm, 1rem)",
                  fontWeight: 800,
                  lineHeight: 1.3,
                  color: "var(--text-primary, #f8fafc)"
                }}
              >
                {gesture.title}
              </strong>

              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-xs, 0.875rem)",
                  lineHeight: 1.45,
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {gesture.detail}
              </p>
            </li>
          ))}
        </ul>

        {hasTriggerGesture ? (
          <div
            role="group"
            aria-label={copy.hudSimGroupAria}
            className="neural-band-sim-actions"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--space-2, 8px)"
            }}
          >
            {copy.hudSimActions.map((action) => (
              <button
                key={action.event}
                type="button"
                className={`btn ${action.event === "log_dose" ? "btn-primary" : "btn-secondary"} neural-band-sim-btn`}
                data-hud-gesture={action.event}
                aria-label={action.ariaLabel}
                onClick={() => onTriggerHudGesture?.(action.event)}
                style={GESTURE_BUTTON_STYLE}
              >
                <kbd
                  style={{
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm, 8px)",
                    border: "1.5px solid currentColor",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "0.8rem",
                    fontWeight: 800
                  }}
                >
                  {action.badge}
                </kbd>
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default VoiceCommandCheatSheetCard;
