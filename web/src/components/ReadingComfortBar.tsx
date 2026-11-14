import React, { useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_READING_COMFORT,
  TEXT_SCALES,
  isCognitiveDensity,
  isTextScale,
  loadReadingComfort,
  saveReadingComfort,
  shouldShowSecondarySurface,
  textScaleCssPercent,
  type CognitiveDensity,
  type KeyValueStorage,
  type ReadingComfortPrefs,
  type TextScale
} from "../a11y/readingComfort.ts";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";

void React;

export type ReadingComfortBarProps = {
  prefs?: ReadingComfortPrefs;
  textScale?: TextScale;
  density?: CognitiveDensity;
  lang?: string;
  storage?: KeyValueStorage;
  onChange?: (next: ReadingComfortPrefs) => void;
  onChangeTextScale?: (nextScale: TextScale) => void;
  onChangeDensity?: (nextDensity: CognitiveDensity) => void;
  onAnnounce?: (message: string) => void;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  onDevicePill: string;
  scaleGroupHeading: string;
  scaleGroupHint: string;
  scaleNames: Record<TextScale, string>;
  scaleAria: (scale: TextScale, active: boolean) => string;
  densityGroupHeading: string;
  densityGroupHint: string;
  densityNames: Record<CognitiveDensity, string>;
  densityBadges: Record<CognitiveDensity, string>;
  densityAria: (density: CognitiveDensity, active: boolean) => string;
  statusMessage: (scale: TextScale, density: CognitiveDensity) => string;
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "WCAG 2.2 AAA Low-Vision & Cognitive Comfort",
    heading: "Reading Size & Calm Focus Toolbar",
    subtitle:
      "Enlarge interface text up to 150% for low vision or switch to Calm Essential View to hide secondary diagnostics and keep only label verification and medication actions.",
    onDevicePill: "Saved on This Device Only",
    scaleGroupHeading: "Text Size Scale",
    scaleGroupHint: "Choose 100%, 125%, or 150% typography scale across the screen.",
    scaleNames: {
      "100": "100% Standard",
      "125": "125% Large",
      "150": "150% Extra Large"
    },
    scaleAria: (scale, active) => {
      const label = COPY_BY_LOCALE.en.scaleNames[scale];
      return active ? `${label} text size active` : `Set text size to ${label}`;
    },
    densityGroupHeading: "Cognitive Load Mode",
    densityGroupHint:
      "Calm Essential View hides secondary reference cards so you can focus on checking your package.",
    densityNames: {
      calm: "Calm Essential View",
      full: "Full Detail View"
    },
    densityBadges: {
      calm: "ESSENTIAL ONLY",
      full: "ALL CARDS"
    },
    densityAria: (density, active) => {
      if (density === "calm") {
        return active
          ? "Calm Essential View active, secondary cards hidden"
          : "Switch to Calm Essential View to hide secondary cards";
      }
      return active
        ? "Full Detail View active, all detail cards visible"
        : "Switch to Full Detail View to show all detail cards";
    },
    statusMessage: (scale, density) =>
      density === "calm"
        ? `Active reading comfort: ${scale}% text size, Calm Essential View (secondary cards hidden).`
        : `Active reading comfort: ${scale}% text size, Full Detail View (all detail cards visible).`
  },
  fi: {
    eyebrow: "WCAG 2.2 AAA heikkonäköisyys ja selkeä näkymä",
    heading: "Tekstikoko ja rauhallinen tarkistusnäkymä",
    subtitle:
      "Suurenna käyttöliittymän teksti jopa 150% kokoon tai valitse Rauhallinen perustila, joka piilottaa lisäkortit ja jättää näkyviin vain etiketin tarkistuksen ja lääketoiminnot.",
    onDevicePill: "Tallennettu vain tälle laitteelle",
    scaleGroupHeading: "Tekstin kokoskaala",
    scaleGroupHint: "Valitse näytön tekstikooksi 100%, 125% tai 150%.",
    scaleNames: {
      "100": "100% Normaali",
      "125": "125% Suuri",
      "150": "150% Erittäin suuri"
    },
    scaleAria: (scale, active) => {
      const label = COPY_BY_LOCALE.fi.scaleNames[scale];
      return active
        ? `${label} tekstikoko käytössä`
        : `Aseta tekstikooksi ${label}`;
    },
    densityGroupHeading: "Kognitiivisen kuorman tila",
    densityGroupHint:
      "Rauhallinen perustila piilottaa tekniset lisäkortit, jotta voit keskittyä pakkauksen tarkistukseen.",
    densityNames: {
      calm: "Rauhallinen perustila",
      full: "Täysi tietonäkymä"
    },
    densityBadges: {
      calm: "VAIN OLENNAINEN",
      full: "KAIKKI KORTIT"
    },
    densityAria: (density, active) => {
      if (density === "calm") {
        return active
          ? "Rauhallinen perustila käytössä, lisäkortit piilotettu"
          : "Vaihda tilaan Rauhallinen perustila ja piilota lisäkortit";
      }
      return active
        ? "Täysi tietonäkymä käytössä, kaikki kortit näkyvissä"
        : "Vaihda tilaan Täysi tietonäkymä ja näytä kaikki kortit";
    },
    statusMessage: (scale, density) =>
      density === "calm"
        ? `Lukumukavuus käytössä: ${scale}% tekstikoko, Rauhallinen perustila (lisäkortit piilotettu).`
        : `Lukumukavuus käytössä: ${scale}% tekstikoko, Täysi tietonäkymä (kaikki kortit näkyvissä).`
  },
  sv: {
    eyebrow: "WCAG 2.2 AAA svagsynthet och lugnt fokus",
    heading: "Textstorlek och lugnt fokusläge",
    subtitle:
      "Förstora texten upp till 150% för nedsatt syn eller välj Lugnt basläge för att dölja sekundära kort och bara visa etikettkontroll och läkemedelsval.",
    onDevicePill: "Sparat endast på den här enheten",
    scaleGroupHeading: "Skala för textstorlek",
    scaleGroupHint: "Välj 100%, 125% eller 150% textstorlek på skärmen.",
    scaleNames: {
      "100": "100% Normal",
      "125": "125% Stor",
      "150": "150% Extra stor"
    },
    scaleAria: (scale, active) => {
      const label = COPY_BY_LOCALE.sv.scaleNames[scale];
      return active
        ? `${label} textstorlek aktiv`
        : `Ställ in textstorlek till ${label}`;
    },
    densityGroupHeading: "Läge för kognitiv belastning",
    densityGroupHint:
      "Lugnt basläge döljer tekniska extrakort så att du kan fokusera helt på att kontrollera förpackningen.",
    densityNames: {
      calm: "Lugnt basläge",
      full: "Full detaljvy"
    },
    densityBadges: {
      calm: "ENDAST VIKTIGT",
      full: "ALLA KORT"
    },
    densityAria: (density, active) => {
      if (density === "calm") {
        return active
          ? "Lugnt basläge aktivt, sekundära kort dolda"
          : "Byt till Lugnt basläge för att dölja sekundära kort";
      }
      return active
        ? "Full detaljvy aktiv, alla kort visas"
        : "Byt till Full detaljvy för att visa alla kort";
    },
    statusMessage: (scale, density) =>
      density === "calm"
        ? `Aktiv läskomfort: ${scale}% textstorlek, Lugnt basläge (sekundära kort dolda).`
        : `Aktiv läskomfort: ${scale}% textstorlek, Full detaljvy (alla kort visas).`
  }
};

const DENSITY_OPTIONS: readonly CognitiveDensity[] = ["calm", "full"];

export function formatReadingComfortStatus(
  lang: string,
  prefs: ReadingComfortPrefs
): string {
  const locale = normalizeLang(lang);
  const safeScale: TextScale = isTextScale(prefs?.textScale)
    ? prefs.textScale
    : DEFAULT_READING_COMFORT.textScale;
  const safeDensity: CognitiveDensity = isCognitiveDensity(prefs?.density)
    ? prefs.density
    : DEFAULT_READING_COMFORT.density;
  return COPY_BY_LOCALE[locale].statusMessage(safeScale, safeDensity);
}

const SECTION_STYLE: CSSProperties = {
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

const CONTROL_GROUP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const TOGGLE_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 16px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "10px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 800,
  flex: "1 1 160px"
};

function ScaleGlyphIcon({ scale }: { scale: TextScale }) {
  const dimension = scale === "150" ? "22px" : scale === "125" ? "20px" : "18px";
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
      style={{ width: dimension, height: dimension, flexShrink: 0 }}
    >
      <path d="M4 19L9.5 5h1L16 19" />
      <line x1="6.2" y1="14" x2="13.8" y2="14" />
      <path d="M17.5 11.5h3.5M19.25 9.75v3.5" />
    </svg>
  );
}

function DensityModeIcon({ density }: { density: CognitiveDensity }) {
  const iconStyle: CSSProperties = { width: "20px", height: "20px", flexShrink: 0 };

  if (density === "calm") {
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
        <path d="M12 3L4 7v5.5c0 5 3.4 9.5 8 10.5 4.6-1 8-5.5 8-10.5V7l-8-4z" />
        <polyline points="8.8 12.2 11.1 14.5 15.6 9.8" />
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
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function StatusCheckIcon() {
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
      style={{ width: "18px", height: "18px", flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="8.5 12.3 11 14.8 15.8 9.8" />
    </svg>
  );
}

export function ReadingComfortBar(props: ReadingComfortBarProps) {
  const {
    prefs,
    textScale,
    density,
    lang = "en",
    storage,
    onChange,
    onChangeTextScale,
    onChangeDensity,
    onAnnounce
  } = props;

  const [internalPrefs, setInternalPrefs] = useState<ReadingComfortPrefs>(() =>
    loadReadingComfort(storage)
  );

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];

  const rawScale = prefs?.textScale ?? textScale ?? internalPrefs.textScale;
  const activeScale: TextScale = isTextScale(rawScale)
    ? rawScale
    : DEFAULT_READING_COMFORT.textScale;

  const rawDensity = prefs?.density ?? density ?? internalPrefs.density;
  const activeDensity: CognitiveDensity = isCognitiveDensity(rawDensity)
    ? rawDensity
    : DEFAULT_READING_COMFORT.density;

  const secondaryVisible = shouldShowSecondarySurface(activeDensity);
  const statusText = copy.statusMessage(activeScale, activeDensity);

  const latestPrefsRef = useRef<ReadingComfortPrefs>({
    textScale: activeScale,
    density: activeDensity
  });
  latestPrefsRef.current = {
    textScale: activeScale,
    density: activeDensity
  };

  const shouldPersistDirectly =
    storage !== undefined ||
    (!onChange && !onChangeTextScale && !onChangeDensity);

  const selectTextScale = (nextScale: TextScale) => {
    const controlledDensity = prefs?.density ?? density;
    const baseDensity = isCognitiveDensity(controlledDensity)
      ? controlledDensity
      : latestPrefsRef.current.density;
    const nextPrefs: ReadingComfortPrefs = {
      textScale: nextScale,
      density: baseDensity
    };
    latestPrefsRef.current = nextPrefs;
    setInternalPrefs(nextPrefs);
    if (shouldPersistDirectly) {
      saveReadingComfort(nextPrefs, storage);
    }
    onChange?.(nextPrefs);
    onChangeTextScale?.(nextScale);
    onAnnounce?.(copy.statusMessage(nextPrefs.textScale, nextPrefs.density));
  };

  const selectCognitiveDensity = (nextDensity: CognitiveDensity) => {
    const controlledScale = prefs?.textScale ?? textScale;
    const baseScale = isTextScale(controlledScale)
      ? controlledScale
      : latestPrefsRef.current.textScale;
    const nextPrefs: ReadingComfortPrefs = {
      textScale: baseScale,
      density: nextDensity
    };
    latestPrefsRef.current = nextPrefs;
    setInternalPrefs(nextPrefs);
    if (shouldPersistDirectly) {
      saveReadingComfort(nextPrefs, storage);
    }
    onChange?.(nextPrefs);
    onChangeDensity?.(nextDensity);
    onAnnounce?.(copy.statusMessage(nextPrefs.textScale, nextPrefs.density));
  };

  const headingId = "reading-comfort-heading";
  const scaleHeadingId = "reading-comfort-scale-heading";
  const densityHeadingId = "reading-comfort-density-heading";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card reading-comfort-bar"
      data-text-scale={activeScale}
      data-cognitive-density={activeDensity}
      data-secondary-surface={secondaryVisible ? "visible" : "hidden"}
      style={SECTION_STYLE}
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

        <span
          className="pill reading-comfort-device-pill"
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
          {copy.onDevicePill}
        </span>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          role="group"
          aria-labelledby={scaleHeadingId}
          className="reading-comfort-scale-group"
          style={CONTROL_GROUP_STYLE}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <h3
              id={scaleHeadingId}
              style={{
                margin: 0,
                fontSize: "var(--text-base, 1.125rem)",
                fontWeight: 800,
                lineHeight: 1.3,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {copy.scaleGroupHeading}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-xs, 0.875rem)",
                lineHeight: 1.4,
                color: "var(--text-secondary, #d8e1ee)"
              }}
            >
              {copy.scaleGroupHint}
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
            {TEXT_SCALES.map((scale) => {
              const isPressed = activeScale === scale;
              return (
                <button
                  key={scale}
                  type="button"
                  data-action="set-text-scale"
                  data-scale-option={scale}
                  data-scale-percent={textScaleCssPercent(scale)}
                  aria-pressed={isPressed}
                  aria-label={copy.scaleAria(scale, isPressed)}
                  className={`btn ${isPressed ? "btn-primary" : "btn-secondary"} reading-scale-btn`}
                  onClick={() => selectTextScale(scale)}
                  style={TOGGLE_BUTTON_STYLE}
                >
                  <ScaleGlyphIcon scale={scale} />
                  <span>{copy.scaleNames[scale]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="group"
          aria-labelledby={densityHeadingId}
          className="reading-comfort-density-group"
          style={CONTROL_GROUP_STYLE}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <h3
              id={densityHeadingId}
              style={{
                margin: 0,
                fontSize: "var(--text-base, 1.125rem)",
                fontWeight: 800,
                lineHeight: 1.3,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {copy.densityGroupHeading}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-xs, 0.875rem)",
                lineHeight: 1.4,
                color: "var(--text-secondary, #d8e1ee)"
              }}
            >
              {copy.densityGroupHint}
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
            {DENSITY_OPTIONS.map((mode) => {
              const isPressed = activeDensity === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  data-action="set-cognitive-density"
                  data-density-option={mode}
                  aria-pressed={isPressed}
                  aria-label={copy.densityAria(mode, isPressed)}
                  className={`btn ${isPressed ? "btn-primary" : "btn-secondary"} reading-density-btn`}
                  onClick={() => selectCognitiveDensity(mode)}
                  style={TOGGLE_BUTTON_STYLE}
                >
                  <DensityModeIcon density={mode} />
                  <span>{copy.densityNames[mode]}</span>
                  <span
                    className="badge reading-density-badge"
                    style={{
                      padding: "2px 8px",
                      borderRadius: "var(--radius-sm, 8px)",
                      backgroundColor: "var(--bg-surface, #121926)",
                      color: "var(--text-primary, #f8fafc)",
                      border: "1px solid var(--border-strong, #6980a3)",
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      letterSpacing: "0.03em"
                    }}
                  >
                    {copy.densityBadges[mode]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="reading-comfort-status"
        data-text-scale={activeScale}
        data-cognitive-density={activeDensity}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "12px 16px",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor:
            activeDensity === "calm"
              ? "var(--verdict-match-bg, #06261d)"
              : "var(--verdict-info-bg, #0a1f38)",
          color:
            activeDensity === "calm"
              ? "var(--verdict-match-fg, #7ef7c8)"
              : "var(--verdict-info-fg, #a6d4ff)",
          border:
            activeDensity === "calm"
              ? "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)"
              : "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)",
          fontSize: "var(--text-sm, 1rem)",
          fontWeight: 700,
          lineHeight: 1.4
        }}
      >
        <StatusCheckIcon />
        <span>{statusText}</span>
      </div>
    </section>
  );
}

export default ReadingComfortBar;
