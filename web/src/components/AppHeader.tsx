import {
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { SUPPORTED_LANGUAGES, normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { ThemeMode, TransportMode } from "../types.ts";

export type AppTab = "check" | "profile" | "device";

export type AppHeaderProps = {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  muted: boolean;
  onToggleMute: () => void;
  lang: string;
  onChangeLang: (lang: string) => void;
  mode: TransportMode;
  hudConnected: boolean;
  medCount: number;
  onOpenPrivacy: () => void;
  onOpenShortcuts?: () => void;
};

const TAB_ORDER: readonly AppTab[] = ["check", "profile", "device"];

const THEME_ORDER: readonly ThemeMode[] = ["dark", "light", "high-contrast"];

type HeaderCopy = {
  skipToMain: string;
  brandMarkAria: string;
  statusGroupAria: string;
  hudConnectedLabel: string;
  hudConnectedAria: string;
  utilitiesAria: string;
  themeNames: Record<ThemeMode, string>;
  themeButtonLabel: (theme: ThemeMode) => string;
  themeButtonAria: (current: ThemeMode, next: ThemeMode) => string;
  langSelectAria: string;
  muteToggleAria: string;
  audioOnLabel: string;
  audioMutedLabel: string;
  shortcutsLabel: string;
  shortcutsAria: string;
  privacyLabel: string;
  openHudLabel: string;
  openHudAria: string;
  primaryNavAria: string;
  tabCheck: string;
  tabProfile: (count: number) => string;
  tabDevice: string;
};

const HEADER_COPY: Record<UiLocale, HeaderCopy> = {
  en: {
    skipToMain: "Skip to main check",
    brandMarkAria: "HoldUp smart glasses and safety shield mark",
    statusGroupAria: "Connection and display status",
    hudConnectedLabel: "HUD Connected",
    hudConnectedAria: "Ray-Ban Display HUD connected",
    utilitiesAria: "Accessibility, language, audio, and privacy controls",
    themeNames: {
      dark: "Dark",
      light: "Light",
      "high-contrast": "High Contrast"
    },
    themeButtonLabel: (theme) => `Theme: ${HEADER_COPY.en.themeNames[theme]}`,
    themeButtonAria: (current, next) =>
      `Switch visual theme, current ${HEADER_COPY.en.themeNames[current]}, next ${HEADER_COPY.en.themeNames[next]}`,
    langSelectAria: "Select session and interface language",
    muteToggleAria: "Mute audio and earcons",
    audioOnLabel: "Audio On",
    audioMutedLabel: "Muted",
    shortcutsLabel: "Shortcuts",
    shortcutsAria: "Keyboard and Neural Band shortcuts",
    privacyLabel: "Privacy & Consent",
    openHudLabel: "Open /hud Display",
    openHudAria: "Open 600x600 Ray-Ban Display /hud waveguide window in new tab",
    primaryNavAria: "Primary sections",
    tabCheck: "Live Check",
    tabProfile: (count) => `My Meds & Allergies (${count})`,
    tabDevice: "Device & Resilience"
  },
  fi: {
    skipToMain: "Siirry tarkistukseen",
    brandMarkAria: "HoldUp-älylasien ja turvakilven tunnus",
    statusGroupAria: "Yhteyden ja näytön tila",
    hudConnectedLabel: "HUD yhdistetty",
    hudConnectedAria: "Ray-Ban Display HUD yhdistetty",
    utilitiesAria: "Saavutettavuus-, kieli-, ääni- ja tietosuoja-asetukset",
    themeNames: {
      dark: "Tumma",
      light: "Vaalea",
      "high-contrast": "Korkea kontrasti"
    },
    themeButtonLabel: (theme) => `Teema: ${HEADER_COPY.fi.themeNames[theme]}`,
    themeButtonAria: (current, next) =>
      `Vaihda ulkoasuteemaa, nykyinen ${HEADER_COPY.fi.themeNames[current]}, seuraava ${HEADER_COPY.fi.themeNames[next]}`,
    langSelectAria: "Valitse istunnon ja käyttöliittymän kieli",
    muteToggleAria: "Mykistä ääni ja äänimerkit",
    audioOnLabel: "Ääni päällä",
    audioMutedLabel: "Mykistetty",
    shortcutsLabel: "Pikanäppäimet",
    shortcutsAria: "Pikanäppäimet ja Neural Band -ohjaus",
    privacyLabel: "Tietosuoja ja suostumus",
    openHudLabel: "Avaa /hud-näyttö",
    openHudAria: "Avaa 600x600 Ray-Ban Display /hud -näkymä uuteen välilehteen",
    primaryNavAria: "Pääosiot",
    tabCheck: "Reaaliaikainen tarkistus",
    tabProfile: (count) => `Lääkkeet ja allergiat (${count})`,
    tabDevice: "Laite ja toimintavarmuus"
  },
  sv: {
    skipToMain: "Hoppa till kontrollen",
    brandMarkAria: "HoldUp-symbol med smarta glasögon och säkerhetssköld",
    statusGroupAria: "Anslutnings- och skärmstatus",
    hudConnectedLabel: "HUD ansluten",
    hudConnectedAria: "Ray-Ban Display HUD ansluten",
    utilitiesAria: "Tillgänglighets-, språk-, ljud- och integritetskontroller",
    themeNames: {
      dark: "Mörkt",
      light: "Ljust",
      "high-contrast": "Hög kontrast"
    },
    themeButtonLabel: (theme) => `Tema: ${HEADER_COPY.sv.themeNames[theme]}`,
    themeButtonAria: (current, next) =>
      `Byt färgtema, aktuellt ${HEADER_COPY.sv.themeNames[current]}, nästa ${HEADER_COPY.sv.themeNames[next]}`,
    langSelectAria: "Välj språk för session och gränssnitt",
    muteToggleAria: "Stäng av ljud och ljudsignaler",
    audioOnLabel: "Ljud på",
    audioMutedLabel: "Ljud av",
    shortcutsLabel: "Genvägar",
    shortcutsAria: "Kortkommandon och Neural Band-genvägar",
    privacyLabel: "Integritet och samtycke",
    openHudLabel: "Öppna /hud-vy",
    openHudAria: "Öppna 600x600 Ray-Ban Display /hud-fönster i ny flik",
    primaryNavAria: "Huvudavsnitt",
    tabCheck: "Direktkontroll",
    tabProfile: (count) => `Mina läkemedel och allergier (${count})`,
    tabDevice: "Enhet och driftsäkerhet"
  }
};

export function getNextTheme(current: ThemeMode): ThemeMode {
  const index = THEME_ORDER.indexOf(current);
  if (index === -1) {
    return "light";
  }
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

export function resolveSupportedLangCode(lang: string): string {
  const base = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const match = SUPPORTED_LANGUAGES.find((entry) => entry.code === base);
  return match ? match.code : "en";
}

export function resolveNextTabByKey(current: AppTab, key: string): AppTab | null {
  const currentIndex = TAB_ORDER.indexOf(current);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  if (key === "ArrowRight") {
    return TAB_ORDER[(safeIndex + 1) % TAB_ORDER.length];
  }
  if (key === "ArrowLeft") {
    return TAB_ORDER[(safeIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length];
  }
  if (key === "Home") {
    return TAB_ORDER[0];
  }
  if (key === "End") {
    return TAB_ORDER[TAB_ORDER.length - 1];
  }
  return null;
}

function formatModeBadge(mode: TransportMode): "LIVE" | "SNAPSHOT" | "OFFLINE" {
  if (mode === "live") {
    return "LIVE";
  }
  if (mode === "snapshot") {
    return "SNAPSHOT";
  }
  return "OFFLINE";
}

function formatModeDetail(lang: string, mode: TransportMode): string {
  if (mode === "live") {
    return t(lang, "modeLive");
  }
  if (mode === "snapshot") {
    return t(lang, "modeSnapshot");
  }
  return t(lang, "modeOffline");
}

function getModePillStyle(mode: TransportMode): CSSProperties {
  if (mode === "live") {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--space-2, 8px)",
      padding: "6px 12px",
      borderRadius: "var(--radius-pill, 9999px)",
      backgroundColor: "var(--verdict-match-bg, #06261d)",
      color: "var(--verdict-match-fg, #7ef7c8)",
      border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)",
      fontSize: "var(--text-xs, 0.875rem)",
      fontWeight: 800,
      letterSpacing: "0.04em",
      lineHeight: 1.2,
      whiteSpace: "nowrap"
    };
  }
  if (mode === "snapshot") {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--space-2, 8px)",
      padding: "6px 12px",
      borderRadius: "var(--radius-pill, 9999px)",
      backgroundColor: "var(--verdict-unsure-bg, #261b04)",
      color: "var(--verdict-unsure-fg, #ffe169)",
      border: "var(--border-width, 1.5px) solid var(--verdict-unsure-border, #f5b82e)",
      fontSize: "var(--text-xs, 0.875rem)",
      fontWeight: 800,
      letterSpacing: "0.04em",
      lineHeight: 1.2,
      whiteSpace: "nowrap"
    };
  }
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2, 8px)",
    padding: "6px 12px",
    borderRadius: "var(--radius-pill, 9999px)",
    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
    color: "var(--verdict-warning-fg, #ffb8ab)",
    border: "var(--border-width, 1.5px) solid var(--verdict-warning-border, #ff6b52)",
    fontSize: "var(--text-xs, 0.875rem)",
    fontWeight: 800,
    letterSpacing: "0.04em",
    lineHeight: 1.2,
    whiteSpace: "nowrap"
  };
}

const headerInnerStyle: CSSProperties = {
  width: "100%",
  maxWidth: "var(--container-max, 1280px)",
  marginInline: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)"
};

const topRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3, 12px)",
  width: "100%"
};

const brandClusterStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3, 12px)"
};

const brandMarkWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "48px",
  height: "48px",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
  color: "var(--text-primary, #f8fafc)",
  flexShrink: 0
};

const brandTitleGroupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const brandTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xl, 1.5rem)",
  fontWeight: 800,
  lineHeight: 1.15,
  letterSpacing: "-0.01em",
  color: "var(--text-primary, #f8fafc)"
};

const statusClusterStyle: CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const hudPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2, 8px)",
  padding: "6px 12px",
  borderRadius: "var(--radius-pill, 9999px)",
  backgroundColor: "var(--verdict-info-bg, #0a1f38)",
  color: "var(--verdict-info-fg, #a6d4ff)",
  border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)",
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  lineHeight: 1.2,
  whiteSpace: "nowrap"
};

const staticDotStyle: CSSProperties = {
  display: "inline-block",
  width: "10px",
  height: "10px",
  borderRadius: "var(--radius-pill, 9999px)",
  backgroundColor: "currentColor",
  flexShrink: 0
};

const utilitiesGroupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const utilityControlStyle: CSSProperties = {
  minHeight: "var(--tap-min, 56px)",
  minWidth: "var(--tap-min, 56px)",
  padding: "10px 14px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700
};

const langSelectStyle: CSSProperties = {
  width: "auto",
  minHeight: "var(--tap-min, 56px)",
  minWidth: "var(--tap-min, 56px)",
  padding: "10px 14px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700
};

const navStyle: CSSProperties = {
  width: "100%",
  borderTop: "1px solid var(--border-subtle, #2c3a52)",
  paddingTop: "var(--space-2, 8px)"
};

const tablistStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)",
  width: "100%"
};

const baseTabStyle: CSSProperties = {
  minHeight: "var(--tap-min, 56px)",
  minWidth: "var(--tap-min, 56px)",
  padding: "12px 18px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700,
  flex: "1 1 auto"
};

const activeTabStyle: CSSProperties = {
  ...baseTabStyle,
  borderColor: "var(--accent, #5cc0ff)",
  backgroundColor: "var(--accent-subtle, rgba(92, 192, 255, 0.16))",
  color: "var(--text-primary, #f8fafc)"
};

const iconSvgStyle: CSSProperties = {
  width: "20px",
  height: "20px",
  flexShrink: 0
};

function renderThemeIcon(theme: ThemeMode) {
  if (theme === "light") {
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
        style={iconSvgStyle}
      >
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </svg>
    );
  }
  if (theme === "high-contrast") {
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
        style={iconSvgStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" />
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
      style={iconSvgStyle}
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function renderAudioIcon(muted: boolean) {
  if (muted) {
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
        style={iconSvgStyle}
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
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconSvgStyle}
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
    </svg>
  );
}

export function AppHeader(props: AppHeaderProps) {
  const {
    activeTab,
    onSelectTab,
    theme,
    onChangeTheme,
    muted,
    onToggleMute,
    lang,
    onChangeLang,
    mode,
    hudConnected,
    medCount,
    onOpenPrivacy,
    onOpenShortcuts
  } = props;

  const tabRefs = useRef<Record<AppTab, HTMLButtonElement | null>>({
    check: null,
    profile: null,
    device: null
  });

  const locale = normalizeLang(lang);
  const copy = HEADER_COPY[locale];
  const nextTheme = getNextTheme(theme);
  const selectedLangCode = resolveSupportedLangCode(lang);
  const safeMedCount = Number.isFinite(medCount) ? Math.max(0, Math.floor(medCount)) : 0;
  const modeCode = formatModeBadge(mode);
  const modeDetail = formatModeDetail(lang, mode);

  const handleTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nextTab = resolveNextTabByKey(activeTab, event.key);
    if (!nextTab) {
      return;
    }
    event.preventDefault();
    onSelectTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const tabs: readonly { id: AppTab; label: string; icon: ReactNode }[] = [
    {
      id: "check",
      label: copy.tabCheck,
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconSvgStyle}
        >
          <path d="M4 7V5a1 1 0 0 1 1-1h2M20 7V5a1 1 0 0 0-1-1h-2M4 17v2a1 1 0 0 0 1 1h2M20 17v2a1 1 0 0 1-1 1h-2" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      )
    },
    {
      id: "profile",
      label: copy.tabProfile(safeMedCount),
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconSvgStyle}
        >
          <path d="M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z" />
          <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" />
        </svg>
      )
    },
    {
      id: "device",
      label: copy.tabDevice,
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconSvgStyle}
        >
          <rect x="2" y="9" width="8" height="6" rx="2" />
          <rect x="14" y="9" width="8" height="6" rx="2" />
          <path d="M10 11.5c.8-.8 3.2-.8 4 0" />
        </svg>
      )
    }
  ];

  return (
    <>
      <a href="#main-content" className="skip-link">
        {copy.skipToMain}
      </a>
      <header className="app-header" lang={locale}>
        <div style={headerInnerStyle}>
          <div style={topRowStyle}>
            <div className="app-brand" style={brandClusterStyle}>
              <span style={brandMarkWrapStyle}>
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  role="img"
                  aria-label={copy.brandMarkAria}
                  focusable="false"
                  style={{ width: "36px", height: "36px", display: "block" }}
                >
                  <path
                    d="M2 15h3M43 15h3"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  />
                  <rect
                    x="5"
                    y="10"
                    width="15"
                    height="12"
                    rx="4"
                    stroke="currentColor"
                    strokeWidth="2.6"
                  />
                  <rect
                    x="28"
                    y="10"
                    width="15"
                    height="12"
                    rx="4"
                    stroke="currentColor"
                    strokeWidth="2.6"
                  />
                  <path
                    d="M20 15c1.5-2 6.5-2 8 0"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  />
                  <circle cx="39.5" cy="13.5" r="1.6" fill="var(--accent, #5cc0ff)" />
                  <path
                    d="M24 22l10 4v6.2c0 6-4.2 10.3-10 12.3-5.8-2-10-6.3-10-12.3V26l10-4z"
                    fill="var(--bg-surface, #121926)"
                    stroke="var(--accent, #5cc0ff)"
                    strokeWidth="2.4"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M19.8 32.5l2.9 2.9 5.7-5.8"
                    stroke="var(--verdict-match-fg, #7ef7c8)"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>

              <div style={brandTitleGroupStyle}>
                <h1 style={brandTitleStyle}>{t(lang, "appTitle")}</h1>

                <div
                  role="group"
                  aria-label={copy.statusGroupAria}
                  style={statusClusterStyle}
                >
                  <span
                    className="pill app-mode-pill"
                    data-mode={mode}
                    aria-label={`${modeCode}: ${modeDetail}`}
                    style={getModePillStyle(mode)}
                  >
                    <span
                      className={mode === "live" ? "privacy-live-dot" : undefined}
                      aria-hidden="true"
                      style={mode === "live" ? undefined : staticDotStyle}
                    />
                    <span>{modeCode}</span>
                  </span>

                  {hudConnected ? (
                    <span
                      className="pill app-hud-pill"
                      data-hud-connected="true"
                      aria-label={copy.hudConnectedAria}
                      style={hudPillStyle}
                    >
                      <span aria-hidden="true" style={staticDotStyle} />
                      <span>{copy.hudConnectedLabel}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div
              role="group"
              aria-label={copy.utilitiesAria}
              className="app-utilities"
              style={utilitiesGroupStyle}
            >
              <button
                type="button"
                data-action="cycle-theme"
                data-theme={theme}
                className="btn btn-secondary app-theme-btn"
                aria-label={copy.themeButtonAria(theme, nextTheme)}
                onClick={() => onChangeTheme(nextTheme)}
                style={utilityControlStyle}
              >
                {renderThemeIcon(theme)}
                <span>{copy.themeButtonLabel(theme)}</span>
              </button>

              <select
                data-action="select-lang"
                className="input app-lang-select"
                aria-label={copy.langSelectAria}
                value={selectedLangCode}
                onChange={(event) => onChangeLang(event.target.value)}
                style={langSelectStyle}
              >
                {SUPPORTED_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.nativeLabel} ({entry.code.toUpperCase()})
                  </option>
                ))}
              </select>

              <button
                type="button"
                data-action="toggle-mute"
                className="btn btn-secondary app-mute-btn"
                aria-pressed={muted}
                aria-label={copy.muteToggleAria}
                onClick={onToggleMute}
                style={utilityControlStyle}
              >
                {renderAudioIcon(muted)}
                <span>{muted ? copy.audioMutedLabel : copy.audioOnLabel}</span>
              </button>

              <button
                type="button"
                data-action="open-shortcuts"
                className="btn btn-secondary app-shortcuts-btn"
                aria-label={copy.shortcutsAria}
                onClick={() => {
                  onOpenShortcuts?.();
                }}
                style={utilityControlStyle}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                  style={iconSvgStyle}
                >
                  <rect x="2" y="5" width="20" height="14" rx="2.5" />
                  <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 15h6" />
                </svg>
                <span>{copy.shortcutsLabel}</span>
              </button>

              <button
                type="button"
                data-action="open-privacy"
                className="btn btn-secondary app-privacy-btn"
                aria-label={t(lang, "privacyButton")}
                onClick={onOpenPrivacy}
                style={utilityControlStyle}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                  style={iconSvgStyle}
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <span>{copy.privacyLabel}</span>
              </button>

              <a
                href="/hud"
                target="_blank"
                rel="noopener"
                data-action="open-hud"
                className="btn btn-secondary app-hud-link"
                aria-label={copy.openHudAria}
                style={utilityControlStyle}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                  style={iconSvgStyle}
                >
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M9 15l6-6M10 9h5v5" />
                </svg>
                <span>{copy.openHudLabel}</span>
              </a>
            </div>
          </div>

          <nav className="app-nav" aria-label={copy.primaryNavAria} style={navStyle}>
            <div
              role="tablist"
              aria-label={copy.primaryNavAria}
              onKeyDown={handleTablistKeyDown}
              style={tablistStyle}
            >
              {tabs.map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(node) => {
                      tabRefs.current[tab.id] = node;
                    }}
                    id={`tab-${tab.id}`}
                    type="button"
                    role="tab"
                    data-tab={tab.id}
                    aria-selected={selected}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    className="btn btn-secondary app-tab-btn"
                    onClick={() => onSelectTab(tab.id)}
                    style={selected ? activeTabStyle : baseTabStyle}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
      </header>
    </>
  );
}

export default AppHeader;
