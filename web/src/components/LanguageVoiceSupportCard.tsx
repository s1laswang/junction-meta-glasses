import React, { type CSSProperties } from "react";
import { resolveLangTag, speakFallback } from "../audio/tts.ts";
import { SUPPORTED_LANGUAGES, normalizeLang, type UiLocale } from "../i18n/translations.ts";

void React;

export type LanguageCapabilityRow = {
  code: string;
  label: string;
  nativeLabel: string;
  bcp47Tag: string;
  active: boolean;
  fullUiAndNordicSafety: boolean;
  liveVoiceSupported: true;
  sampleGreeting: string;
};

export type LanguageVoiceSupportCardProps = {
  activeLang: string;
  muted?: boolean;
  onSelectLang?: (code: string) => void;
  onSpeakSample?: (text: string, code: string) => void;
};

type PillarId = "nordic_rx" | "allergen_a11y" | "tts_fallback";

type PillarSpec = {
  id: PillarId;
  badge: string;
  title: string;
  detail: string;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  activeBadge: (nativeLabel: string, code: string) => string;
  liveVoiceSummaryPill: string;
  nordicSafetySummaryPill: string;
  mutedStatusPill: string;
  pillarsGroupAria: string;
  pillars: readonly PillarSpec[];
  matrixHeading: string;
  matrixHint: string;
  listAriaLabel: string;
  rowActiveBadge: string;
  rowLiveVoiceBadge: string;
  rowNordicTierBadge: string;
  rowVoiceOnlyTierBadge: string;
  selectButtonActiveLabel: string;
  selectButtonIdleLabel: string;
  selectButtonAria: (
    nativeLabel: string,
    label: string,
    code: string,
    active: boolean
  ) => string;
  sampleButtonLabel: string;
  sampleButtonMutedLabel: string;
  sampleButtonAria: (
    nativeLabel: string,
    label: string,
    code: string,
    muted: boolean
  ) => string;
};

const NORDIC_FULL_UI_CODES = new Set<string>(["en", "fi", "sv"]);

const SAMPLE_GREETINGS_BY_CODE: Readonly<Record<string, string>> = {
  en: "HoldUp ready. Hold a medicine box or food package steady, and ask if it matches your schedule.",
  fi: "HoldUp on valmiina. Nosta lääkepakkaus tai ruokapakkaus esiin ja kysy, sopiiko se sinulle.",
  sv: "HoldUp är redo. Håll upp en medicinförpackning eller matvara och fråga om den stämmer.",
  de: "HoldUp ist bereit. Halten Sie eine Medikamentenpackung ruhig vor die Brille zur Prüfung.",
  es: "HoldUp está listo. Sostenga el envase frente a las gafas para verificar la etiqueta.",
  fr: "HoldUp est prêt. Tenez la boîte devant vos lunettes pour vérifier l'étiquette.",
  et: "HoldUp on valmis. Hoidke ravimikarpi prillide ees, et kontrollida etiketti.",
  ru: "HoldUp готов. Поднесите упаковку лекарства к очкам для проверки этикетки."
};

const EXTRA_BCP47_FALLBACKS: Readonly<Record<string, string>> = {
  ru: "ru-RU"
};

function resolveActiveSupportedCode(activeLang: string): string {
  const base = (activeLang ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const matched = SUPPORTED_LANGUAGES.find((entry) => entry.code === base);
  return matched ? matched.code : "en";
}

function resolveVoiceBcp47Tag(code: string): string {
  const mapped = EXTRA_BCP47_FALLBACKS[code];
  return resolveLangTag(mapped ?? code);
}

export function buildLanguageCapabilityRows(activeLang: string): LanguageCapabilityRow[] {
  const resolvedActiveCode = resolveActiveSupportedCode(activeLang);

  return SUPPORTED_LANGUAGES.map((entry) => ({
    code: entry.code,
    label: entry.label,
    nativeLabel: entry.nativeLabel,
    bcp47Tag: resolveVoiceBcp47Tag(entry.code),
    active: entry.code === resolvedActiveCode,
    fullUiAndNordicSafety: NORDIC_FULL_UI_CODES.has(entry.code),
    liveVoiceSupported: true,
    sampleGreeting:
      SAMPLE_GREETINGS_BY_CODE[entry.code] ?? SAMPLE_GREETINGS_BY_CODE.en
  }));
}

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Multilingual Voice & Nordic Safety",
    heading: "Language, Voice & Nordic Safety Matrix",
    subtitle:
      "Switch session language in one tap or play a sample greeting. All 8 languages support Gemini Live open-ear coaching and TTS fallback, while English, Finnish, and Swedish include full localized UI and Nordic pharmacy dictionaries.",
    activeBadge: (nativeLabel, code) => `Active: ${nativeLabel} (${code.toUpperCase()})`,
    liveVoiceSummaryPill: "8 Gemini Live Voice Languages",
    nordicSafetySummaryPill: "EN / FI / SV UI + Nordic Safety",
    mutedStatusPill: "Audio Muted",
    pillarsGroupAria: "Multilingual voice and deterministic safety capabilities",
    pillars: [
      {
        id: "nordic_rx",
        badge: "BRAND -> INN + 10 CLASSES",
        title: "Nordic Brand & Strength Normalization",
        detail:
          "Maps Nordic and international brands to active ingredients (Burana -> ibuprofen, Panadol -> paracetamol, Marevan -> warfarin) and normalizes 2,5 mg comma decimals."
      },
      {
        id: "allergen_a11y",
        badge: "EU-14 + TALKBACK / VOICEOVER",
        title: "EU-14 Allergen & Screen-Reader Parity",
        detail:
          "Catches 14 EU allergen groups and scientific excipients across EN, FI, and SV (arachis, maapahkina, jordnot, hasselpahkina) with TalkBack and VoiceOver announcements."
      },
      {
        id: "tts_fallback",
        badge: "LIVE + /API/TTS + WEB SPEECH",
        title: "Resilient Open-Ear Speech Output",
        detail:
          "Streams Gemini Live audio over Bluetooth HFP and falls back automatically to 24 kHz server /api/tts WAV synthesis or on-device BCP-47 speechSynthesis."
      }
    ],
    matrixHeading: "Supported Voice & Interface Languages (8)",
    matrixHint: "Tap Select to switch active language or Play Sample to test spoken output.",
    listAriaLabel: "Supported languages and capability matrix",
    rowActiveBadge: "ACTIVE",
    rowLiveVoiceBadge: "LIVE VOICE + TTS",
    rowNordicTierBadge: "FULL UI + NORDIC RX & EU-14",
    rowVoiceOnlyTierBadge: "VOICE SESSION + EN UI",
    selectButtonActiveLabel: "Selected",
    selectButtonIdleLabel: "Select",
    selectButtonAria: (nativeLabel, label, code, active) =>
      active
        ? `${nativeLabel} (${label}, ${code.toUpperCase()}) is the active language`
        : `Switch active language to ${nativeLabel} (${label}, ${code.toUpperCase()})`,
    sampleButtonLabel: "Play Sample",
    sampleButtonMutedLabel: "Sample Muted",
    sampleButtonAria: (nativeLabel, label, code, muted) =>
      muted
        ? `Sample voice output muted for ${nativeLabel} (${label}, ${code.toUpperCase()})`
        : `Play sample voice greeting in ${nativeLabel} (${label}, ${code.toUpperCase()})`
  },
  fi: {
    eyebrow: "Monikielinen ääni ja pohjoismainen turva",
    heading: "Kieli-, puhe- ja pohjoismainen turvamatriisi",
    subtitle:
      "Vaihda istunnon kieli yhdellä napautuksella tai kuuntele ääninäyte. Kaikki 8 kieltä tukevat Gemini Live -puheohjausta ja TTS-varapuhetta, ja suomi, ruotsi sekä englanti sisältävät täyden käyttöliittymän ja pohjoismaisen lääkesanaston.",
    activeBadge: (nativeLabel, code) => `Aktiivinen: ${nativeLabel} (${code.toUpperCase()})`,
    liveVoiceSummaryPill: "8 Gemini Live -puhekieltä",
    nordicSafetySummaryPill: "EN / FI / SV käyttöliittymä + turvasanasto",
    mutedStatusPill: "Ääni mykistetty",
    pillarsGroupAria: "Monikielisen puheen ja deterministisen turvan ominaisuudet",
    pillars: [
      {
        id: "nordic_rx",
        badge: "KAUPPANIMI -> INN + 10 LUOKKAA",
        title: "Pohjoismainen kauppanimi- ja vahvuustulkinta",
        detail:
          "Yhdistää pohjoismaiset kauppanimet vaikuttaviin aineisiin (Burana -> ibuprofen, Panadol -> paracetamol, Marevan -> warfarin) ja muuntaa 2,5 mg pilkkudesimaalit."
      },
      {
        id: "allergen_a11y",
        badge: "EU-14 + TALKBACK / VOICEOVER",
        title: "EU-14-allergeenit ja ruudunlukijatuki",
        detail:
          "Tunnistaa 14 EU-allergeeniryhmää ja apuaineet (arachis, maapahkina, jordnot, hasselpahkina) sekä tukee Android TalkBack- ja VoiceOver-ilmoituksia."
      },
      {
        id: "tts_fallback",
        badge: "LIVE + /API/TTS + PUHESYNTEESI",
        title: "Vikasietoinen avoimen korvan puheääni",
        detail:
          "Toistaa Gemini Live -äänen Bluetooth HFP -yhteydellä ja siirtyy tarvittaessa 24 kHz /api/tts WAV-ääneen tai selaimen BCP-47 speechSynthesis -puheeseen."
      }
    ],
    matrixHeading: "Tuetut puhe- ja käyttöliittymäkielet (8)",
    matrixHint: "Vaihda kieli valitsemalla Valitse tai testaa ääni painamalla Ääninäyte.",
    listAriaLabel: "Tuetut kielet ja ominaisuusmatriisi",
    rowActiveBadge: "VALITTU",
    rowLiveVoiceBadge: "LIVE-ÄÄNI + TTS",
    rowNordicTierBadge: "TÄYSI UI + POHJOISMAINEN TURVA",
    rowVoiceOnlyTierBadge: "PUHEISTUNTO + EN-KÄYTTÖLIITTYMÄ",
    selectButtonActiveLabel: "Valittu",
    selectButtonIdleLabel: "Valitse",
    selectButtonAria: (nativeLabel, label, code, active) =>
      active
        ? `${nativeLabel} (${label}, ${code.toUpperCase()}) on valittu kieli`
        : `Vaihda aktiiviseksi kieleksi ${nativeLabel} (${label}, ${code.toUpperCase()})`,
    sampleButtonLabel: "Ääninäyte",
    sampleButtonMutedLabel: "Mykistetty",
    sampleButtonAria: (nativeLabel, label, code, muted) =>
      muted
        ? `Ääninäyte mykistetty kielelle ${nativeLabel} (${label}, ${code.toUpperCase()})`
        : `Toista ääninäyte kielellä ${nativeLabel} (${label}, ${code.toUpperCase()})`
  },
  sv: {
    eyebrow: "Flerspråkig röst och nordisk säkerhet",
    heading: "Språk-, röst- och nordisk säkerhetsmatris",
    subtitle:
      "Byt sessionsspråk med ett tryck eller spela upp ett röstprov. Alla 8 språk stöder Gemini Live-röstguidning och TTS-reserv, medan svenska, finska och engelska har fullt gränssnitt och nordiskt apotekslexikon.",
    activeBadge: (nativeLabel, code) => `Aktivt: ${nativeLabel} (${code.toUpperCase()})`,
    liveVoiceSummaryPill: "8 Gemini Live-röstspråk",
    nordicSafetySummaryPill: "EN / FI / SV gränssnitt + säkerhetslexikon",
    mutedStatusPill: "Ljud avstängt",
    pillarsGroupAria: "Egenskaper för flerspråkig röst och deterministisk säkerhet",
    pillars: [
      {
        id: "nordic_rx",
        badge: "HANDELSNAMN -> INN + 10 KLASSER",
        title: "Nordisk handelsnamns- och styrketolkning",
        detail:
          "Kopplar nordiska handelsnamn till aktiva substanser (Burana -> ibuprofen, Panadol -> paracetamol, Marevan -> warfarin) och tolkar kommadecimaler som 2,5 mg."
      },
      {
        id: "allergen_a11y",
        badge: "EU-14 + TALKBACK / VOICEOVER",
        title: "EU-14-allergener och skärmläsarstöd",
        detail:
          "Fångar 14 EU-allergengrupper och hjälpämnen på EN, FI och SV (arachis, maapahkina, jordnot, hasselpahkina) med TalkBack- och VoiceOver-stöd."
      },
      {
        id: "tts_fallback",
        badge: "LIVE + /API/TTS + TALSYNTES",
        title: "Driftsäker röstuppläsning med öppet öra",
        detail:
          "Strömmar Gemini Live-ljud via Bluetooth HFP och växlar automatiskt till 24 kHz /api/tts WAV-ljud eller lokal BCP-47 speechSynthesis."
      }
    ],
    matrixHeading: "Röst- och gränssnittsspråk som stöds (8)",
    matrixHint: "Tryck på Välj för att byta aktivt språk eller Röstprov för att testa uppläsning.",
    listAriaLabel: "Språk som stöds och kapabilitetsmatris",
    rowActiveBadge: "AKTIV",
    rowLiveVoiceBadge: "LIVERÖST + TTS",
    rowNordicTierBadge: "FULL UI + NORDISK SÄKERHET",
    rowVoiceOnlyTierBadge: "RÖSTSESSION + EN-GRÄNSSNITT",
    selectButtonActiveLabel: "Valt",
    selectButtonIdleLabel: "Välj",
    selectButtonAria: (nativeLabel, label, code, active) =>
      active
        ? `${nativeLabel} (${label}, ${code.toUpperCase()}) är aktivt språk`
        : `Byt aktivt språk till ${nativeLabel} (${label}, ${code.toUpperCase()})`,
    sampleButtonLabel: "Röstprov",
    sampleButtonMutedLabel: "Ljud av",
    sampleButtonAria: (nativeLabel, label, code, muted) =>
      muted
        ? `Röstprov avstängt för ${nativeLabel} (${label}, ${code.toUpperCase()})`
        : `Spela röstprov på ${nativeLabel} (${label}, ${code.toUpperCase()})`
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

const PILLARS_GRID_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const MATRIX_SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const LANGUAGE_GRID_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const ACTION_BUTTON_BASE_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 14px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800,
  flex: "1 1 116px"
};

function PillarIcon({ id }: { id: PillarId }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (id === "nordic_rx") {
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
        <path d="M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z" />
        <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" />
      </svg>
    );
  }

  if (id === "allergen_a11y") {
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
        <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
        <path d="M8.6 12.3l2.3 2.3 4.7-4.9" />
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
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
    </svg>
  );
}

function GlobeBadgeIcon() {
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
      style={{ width: "16px", height: "16px", flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z" />
    </svg>
  );
}

function CheckMarkIcon() {
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
      style={{ width: "16px", height: "16px", flexShrink: 0 }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SpeakerSampleIcon({ muted }: { muted: boolean }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (muted) {
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
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <line x1="22" y1="9" x2="16" y2="15" />
        <line x1="16" y1="9" x2="22" y2="15" />
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
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

export function LanguageVoiceSupportCard(props: LanguageVoiceSupportCardProps) {
  const { activeLang, muted = false, onSelectLang, onSpeakSample } = props;
  const isMuted = Boolean(muted);
  const locale = normalizeLang(activeLang);
  const copy = COPY_BY_LOCALE[locale];
  const rows = buildLanguageCapabilityRows(activeLang);
  const activeRow = rows.find((row) => row.active) ?? rows[0];

  const headingId = "language-voice-support-heading";
  const matrixHeadingId = "language-capability-matrix-heading";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card language-voice-support-card"
      data-active-lang={activeRow.code}
      data-muted={isMuted ? "true" : "false"}
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
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            role="status"
            data-active-code={activeRow.code}
            className="badge language-active-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--verdict-match-bg, #06261d)",
              color: "var(--verdict-match-fg, #7ef7c8)",
              border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800
            }}
          >
            <GlobeBadgeIcon />
            <span>{copy.activeBadge(activeRow.nativeLabel, activeRow.code)}</span>
          </span>

          <span
            className="pill language-live-voice-pill"
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
            {copy.liveVoiceSummaryPill}
          </span>

          <span
            className="pill language-nordic-safety-pill"
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
            {copy.nordicSafetySummaryPill}
          </span>

          {isMuted ? (
            <span
              role="status"
              className="badge language-muted-pill"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "var(--radius-pill, 9999px)",
                backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
                color: "var(--verdict-warning-fg, #ffb8ab)",
                border: "var(--border-width, 1.5px) solid var(--verdict-warning-border, #ff6b52)",
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800
              }}
            >
              <SpeakerSampleIcon muted={true} />
              <span>{copy.mutedStatusPill}</span>
            </span>
          ) : null}
        </div>
      </header>

      <ul
        aria-label={copy.pillarsGroupAria}
        className="language-safety-pillars-grid"
        style={PILLARS_GRID_STYLE}
      >
        {copy.pillars.map((pillar) => (
          <li
            key={pillar.id}
            data-pillar-id={pillar.id}
            className={`language-safety-pillar language-pillar-${pillar.id}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "var(--space-4, 16px)",
              borderRadius: "var(--radius-md, 12px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
            }}
          >
            <span
              className="badge language-pillar-badge"
              style={{
                alignSelf: "flex-start",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "var(--radius-sm, 8px)",
                backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                color: "var(--verdict-info-fg, #a6d4ff)",
                border: "1.5px solid var(--verdict-info-border, #4da3ff)",
                fontSize: "0.76rem",
                fontWeight: 800,
                letterSpacing: "0.03em"
              }}
            >
              <PillarIcon id={pillar.id} />
              <span>{pillar.badge}</span>
            </span>

            <h3
              style={{
                margin: 0,
                fontSize: "var(--text-base, 1.125rem)",
                fontWeight: 800,
                lineHeight: 1.3,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {pillar.title}
            </h3>

            <p
              style={{
                margin: 0,
                fontSize: "var(--text-xs, 0.875rem)",
                lineHeight: 1.45,
                color: "var(--text-secondary, #d8e1ee)"
              }}
            >
              {pillar.detail}
            </p>
          </li>
        ))}
      </ul>

      <div
        role="group"
        aria-labelledby={matrixHeadingId}
        className="language-capability-matrix-section"
        style={MATRIX_SECTION_STYLE}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h3
            id={matrixHeadingId}
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              lineHeight: 1.3,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.matrixHeading}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.4,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.matrixHint}
          </p>
        </div>

        <ul
          aria-label={copy.listAriaLabel}
          className="language-capability-grid"
          style={LANGUAGE_GRID_STYLE}
        >
          {rows.map((row) => {
            const displayTitle =
              row.nativeLabel === row.label
                ? `${row.label} (${row.code.toUpperCase()})`
                : `${row.nativeLabel} / ${row.label} (${row.code.toUpperCase()})`;

            return (
              <li
                key={row.code}
                data-lang-code={row.code}
                data-active={row.active ? "true" : "false"}
                data-nordic-safety={row.fullUiAndNordicSafety ? "true" : "false"}
                className={`language-capability-row${row.active ? " language-capability-row-active" : ""}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "14px",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: row.active
                    ? "var(--accent-subtle, rgba(92, 192, 255, 0.16))"
                    : "var(--bg-surface, #121926)",
                  border: row.active
                    ? "2px solid var(--accent, #5cc0ff)"
                    : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "6px"
                    }}
                  >
                    <strong
                      className="language-row-title"
                      style={{
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: 800,
                        lineHeight: 1.3,
                        color: "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {displayTitle}
                    </strong>

                    <code
                      className="language-row-bcp47"
                      style={{
                        padding: "2px 8px",
                        borderRadius: "var(--radius-sm, 8px)",
                        backgroundColor: "var(--bg-elevated, #1a2333)",
                        color: "var(--text-secondary, #d8e1ee)",
                        border: "1px solid var(--border-subtle, #2c3a52)",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "0.78rem",
                        fontWeight: 700
                      }}
                    >
                      {row.bcp47Tag}
                    </code>
                  </div>

                  <div
                    className="language-row-badges"
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "6px"
                    }}
                  >
                    {row.active ? (
                      <span
                        className="badge language-row-active-badge"
                        style={{
                          padding: "3px 8px",
                          borderRadius: "var(--radius-sm, 8px)",
                          backgroundColor: "var(--verdict-match-bg, #06261d)",
                          color: "var(--verdict-match-fg, #7ef7c8)",
                          border: "1.5px solid var(--verdict-match-border, #2dd4a0)",
                          fontSize: "0.74rem",
                          fontWeight: 800,
                          letterSpacing: "0.03em"
                        }}
                      >
                        {copy.rowActiveBadge}
                      </span>
                    ) : null}

                    {row.liveVoiceSupported ? (
                      <span
                        className="badge language-row-voice-badge"
                        style={{
                          padding: "3px 8px",
                          borderRadius: "var(--radius-sm, 8px)",
                          backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                          color: "var(--verdict-info-fg, #a6d4ff)",
                          border: "1.5px solid var(--verdict-info-border, #4da3ff)",
                          fontSize: "0.74rem",
                          fontWeight: 800,
                          letterSpacing: "0.03em"
                        }}
                      >
                        {copy.rowLiveVoiceBadge}
                      </span>
                    ) : null}

                    <span
                      className="badge language-row-tier-badge"
                      style={{
                        padding: "3px 8px",
                        borderRadius: "var(--radius-sm, 8px)",
                        fontSize: "0.74rem",
                        fontWeight: 800,
                        letterSpacing: "0.03em",
                        ...(row.fullUiAndNordicSafety
                          ? {
                              backgroundColor: "var(--verdict-match-bg, #06261d)",
                              color: "var(--verdict-match-fg, #7ef7c8)",
                              border: "1.5px solid var(--verdict-match-border, #2dd4a0)"
                            }
                          : {
                              backgroundColor: "var(--bg-elevated, #1a2333)",
                              color: "var(--text-primary, #f8fafc)",
                              border: "1.5px solid var(--border-strong, #6980a3)"
                            })
                      }}
                    >
                      {row.fullUiAndNordicSafety
                        ? copy.rowNordicTierBadge
                        : copy.rowVoiceOnlyTierBadge}
                    </span>
                  </div>

                  <p
                    lang={row.code}
                    className="language-row-sample-text"
                    style={{
                      margin: 0,
                      fontSize: "var(--text-xs, 0.875rem)",
                      lineHeight: 1.45,
                      color: "var(--text-secondary, #d8e1ee)"
                    }}
                  >
                    {`"${row.sampleGreeting}"`}
                  </p>
                </div>

                <div
                  className="language-row-actions"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "8px"
                  }}
                >
                  <button
                    type="button"
                    data-action="select-lang"
                    data-lang-code={row.code}
                    aria-pressed={row.active}
                    aria-label={copy.selectButtonAria(
                      row.nativeLabel,
                      row.label,
                      row.code,
                      row.active
                    )}
                    className={`btn ${row.active ? "btn-primary" : "btn-secondary"} language-select-btn`}
                    onClick={() => {
                      onSelectLang?.(row.code);
                    }}
                    style={ACTION_BUTTON_BASE_STYLE}
                  >
                    {row.active ? <CheckMarkIcon /> : null}
                    <span>
                      {row.active ? copy.selectButtonActiveLabel : copy.selectButtonIdleLabel}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-action="speak-sample"
                    data-lang-code={row.code}
                    disabled={isMuted}
                    aria-disabled={isMuted ? "true" : undefined}
                    aria-label={copy.sampleButtonAria(
                      row.nativeLabel,
                      row.label,
                      row.code,
                      isMuted
                    )}
                    className="btn btn-secondary language-sample-btn"
                    onClick={() => {
                      if (isMuted) {
                        return;
                      }
                      if (onSpeakSample) {
                        onSpeakSample(row.sampleGreeting, row.code);
                        return;
                      }
                      void speakFallback(row.sampleGreeting, {
                        lang: row.code,
                        preferServerTts: row.fullUiAndNordicSafety
                      });
                    }}
                    style={ACTION_BUTTON_BASE_STYLE}
                  >
                    <SpeakerSampleIcon muted={isMuted} />
                    <span>
                      {isMuted ? copy.sampleButtonMutedLabel : copy.sampleButtonLabel}
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export default LanguageVoiceSupportCard;
