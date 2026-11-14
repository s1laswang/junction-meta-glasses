import { useState, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { ChaosConfig, DemoScenarioId } from "../types.ts";

export type TourStepId =
  | "evening_match"
  | "nsaid_warning"
  | "blurry_refusal"
  | "hazelnut_allergy"
  | "offline_resilience";

export type TourModeAction = "snapshot" | "offline_barcode";

export type TourStepAction = {
  id: TourStepId;
  scenarioId: DemoScenarioId;
  modeAction: TourModeAction;
  chaosPatch?: Partial<ChaosConfig>;
};

export type JudgeDemoTourProps = {
  lang: string;
  activeStep?: TourStepId | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onRunStep: (step: {
    id: TourStepId;
    scenarioId: DemoScenarioId;
    modeAction: "snapshot" | "offline_barcode";
    chaosPatch?: Partial<ChaosConfig>;
  }) => void;
};

export type TourStepTone = "match" | "warning" | "unsure" | "offline";

export type TourStepSpec = TourStepAction & {
  stepNumber: 1 | 2 | 3 | 4 | 5;
  tone: TourStepTone;
  labels: Record<UiLocale, string>;
  details: Record<UiLocale, string>;
  badges: Record<UiLocale, string>;
};

type TourBannerCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  collapseButton: string;
  expandButton: string;
  stepsListLabel: string;
  activeStepPrefix: string;
  runningAnnouncement: (stepLabel: string) => string;
};

export const TOUR_STEPS: readonly TourStepSpec[] = [
  {
    stepNumber: 1,
    id: "evening_match",
    scenarioId: "amlodipine_match",
    modeAction: "snapshot",
    tone: "match",
    labels: {
      en: "1. Right Evening Pill",
      fi: "1. Oikea iltalääke",
      sv: "1. Rätt kvällsmedicin"
    },
    details: {
      en: "Verifies Amlodipine 5 mg against your saved evening schedule",
      fi: "Varmistaa Amlodipine 5 mg -pakkauksen iltalääkkeeksesi",
      sv: "Bekräftar Amlodipine 5 mg mot ditt sparade kvällsschema"
    },
    badges: {
      en: "MATCH",
      fi: "OSUMA",
      sv: "TRÄFF"
    }
  },
  {
    stepNumber: 2,
    id: "nsaid_warning",
    scenarioId: "ibuprofen_nsaid",
    modeAction: "snapshot",
    tone: "warning",
    labels: {
      en: "2. NSAID Safety Catch",
      fi: "2. Tulehduskipulääkevaroitus",
      sv: "2. NSAID-säkerhetsvarning"
    },
    details: {
      en: "Flags unlisted Ibuprofen 400 mg against avoid-NSAID rule",
      fi: "Estää listan ulkopuolisen Ibuprofen 400 mg -kipulääkkeen",
      sv: "Varnar för Ibuprofen 400 mg enligt regeln undvik NSAID"
    },
    badges: {
      en: "WARNING",
      fi: "VAROITUS",
      sv: "VARNING"
    }
  },
  {
    stepNumber: 3,
    id: "blurry_refusal",
    scenarioId: "blurry_strength",
    modeAction: "snapshot",
    tone: "unsure",
    labels: {
      en: "3. Covered Dose (Zero Guess)",
      fi: "3. Peittynyt vahvuus (ei arvausta)",
      sv: "3. Skymd styrka (ingen gissning)"
    },
    details: {
      en: "Refuses to guess illegible mg strength below 80% confidence",
      fi: "Ei koskaan arvaa epäselvää vahvuutta alle 80 % varmuudella",
      sv: "Vägrar gissa oläslig mg-styrka under 80 % säkerhet"
    },
    badges: {
      en: "UNSURE",
      fi: "EPÄVARMA",
      sv: "OSÄKER"
    }
  },
  {
    stepNumber: 4,
    id: "hazelnut_allergy",
    scenarioId: "hazelnut_allergy",
    modeAction: "snapshot",
    tone: "warning",
    labels: {
      en: "4. Hidden Nut Allergen",
      fi: "4. Piilevä pähkinäallergeeni",
      sv: "4. Dold nötallergen"
    },
    details: {
      en: "Catches hazelnuts on snack bar against saved nut allergy",
      fi: "Havaitsee välipalapatukan hasselpähkinän pähkinäallergiasta",
      sv: "Hittar hasselnötter i mellanmålsbar mot sparad nötallergi"
    },
    badges: {
      en: "ALLERGY",
      fi: "ALLERGIA",
      sv: "ALLERGI"
    }
  },
  {
    stepNumber: 5,
    id: "offline_resilience",
    scenarioId: "amlodipine_match",
    modeAction: "offline_barcode",
    chaosPatch: { forceOffline: true },
    tone: "offline",
    labels: {
      en: "5. Wi-Fi Off Barcode Fallback",
      fi: "5. Viivakoodi ilman verkkoa",
      sv: "5. Streckkod utan Wi-Fi"
    },
    details: {
      en: "Simulates network loss and matches saved barcode on-device",
      fi: "Simuloi verkkokatkosta ja tunnistaa viivakoodin laitteella",
      sv: "Simulerar nätverksavbrott och matchar sparad streckkod lokalt"
    },
    badges: {
      en: "OFFLINE",
      fi: "OFFLINE",
      sv: "OFFLINE"
    }
  }
];

const BANNER_COPY: Record<UiLocale, TourBannerCopy> = {
  en: {
    eyebrow: "Laptop Judge Demo",
    heading: "60-Second Interactive Judge Walkthrough",
    subtitle:
      "No glasses or physical pill boxes needed. Run all 5 core safety and resilience beats in one click each.",
    collapseButton: "Collapse walkthrough",
    expandButton: "Expand 5 demo steps",
    stepsListLabel: "Five interactive demo steps",
    activeStepPrefix: "Active:",
    runningAnnouncement: (stepLabel) => `Running demo step ${stepLabel}`
  },
  fi: {
    eyebrow: "Tuomarin pikademo",
    heading: "60 sekunnin vuorovaikutteinen tuomaridemo",
    subtitle:
      "Et tarvitse laseja tai fyysisiä lääkepakkauksia. Kokeile kaikki 5 keskeistä turvallisuus- ja vikasietotilannetta yhdellä painalluksella.",
    collapseButton: "Piilota kierros",
    expandButton: "Näytä 5 demovaihetta",
    stepsListLabel: "Viisi vuorovaikutteista demovaihetta",
    activeStepPrefix: "Valittu:",
    runningAnnouncement: (stepLabel) => `Suoritetaan demovaihe ${stepLabel}`
  },
  sv: {
    eyebrow: "Domardemo på dator",
    heading: "60 sekunders interaktiv domargenomgång",
    subtitle:
      "Inga glasögon eller fysiska medicinaskar behövs. Kör alla 5 centrala säkerhets- och reservlägen med ett klick var.",
    collapseButton: "Dölj genomgång",
    expandButton: "Visa 5 demosteg",
    stepsListLabel: "Fem interaktiva demosteg",
    activeStepPrefix: "Aktivt:",
    runningAnnouncement: (stepLabel) => `Kör demosteg ${stepLabel}`
  }
};

const TONE_BADGE_STYLES: Record<TourStepTone, CSSProperties> = {
  match: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "1.5px solid var(--verdict-match-border, #2dd4a0)"
  },
  warning: {
    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
    color: "var(--verdict-warning-fg, #ffb8ab)",
    border: "1.5px solid var(--verdict-warning-border, #ff6b52)"
  },
  unsure: {
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "1.5px dashed var(--verdict-unsure-border, #f5b82e)"
  },
  offline: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "1.5px solid var(--verdict-info-border, #4da3ff)"
  }
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
  boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3, 12px)"
};

const headerTextGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  flex: "1 1 320px"
};

const eyebrowRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--accent, #5cc0ff)"
};

const activePillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 10px",
  borderRadius: "var(--radius-pill, 9999px)",
  backgroundColor: "var(--accent-subtle, rgba(92, 192, 255, 0.16))",
  border: "1.5px solid var(--accent, #5cc0ff)",
  color: "var(--text-primary, #f8fafc)",
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  lineHeight: 1.3
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg, 1.25rem)",
  lineHeight: 1.28,
  fontWeight: 800
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const toggleButtonStyle: CSSProperties = {
  minHeight: "56px",
  padding: "12px 18px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700,
  flexShrink: 0
};

const stepsGridStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const stepItemStyle: CSSProperties = {
  display: "flex",
  margin: 0,
  padding: 0
};

const stepTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)",
  width: "100%"
};

const stepLabelStyle: CSSProperties = {
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 800,
  lineHeight: 1.28,
  textAlign: "left"
};

const stepDetailStyle: CSSProperties = {
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 500,
  lineHeight: 1.4,
  textAlign: "left",
  color: "var(--text-secondary, #d8e1ee)",
  width: "100%"
};

const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0
};

function getStepButtonStyle(isActive: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: "8px",
    width: "100%",
    minHeight: "56px",
    padding: "12px 14px",
    borderRadius: "var(--radius-md, 12px)",
    textAlign: "left",
    backgroundColor: isActive
      ? "var(--accent-subtle, rgba(92, 192, 255, 0.16))"
      : "var(--bg-elevated, #1a2333)",
    color: "var(--text-primary, #f8fafc)",
    border: isActive
      ? "2.5px solid var(--accent, #5cc0ff)"
      : "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)"
  };
}

export function toTourStepAction(step: TourStepSpec): TourStepAction {
  if (step.chaosPatch) {
    return {
      id: step.id,
      scenarioId: step.scenarioId,
      modeAction: step.modeAction,
      chaosPatch: { ...step.chaosPatch }
    };
  }
  return {
    id: step.id,
    scenarioId: step.scenarioId,
    modeAction: step.modeAction
  };
}

export function JudgeDemoTour(props: JudgeDemoTourProps) {
  const { lang, activeStep = null, collapsed, onToggleCollapsed, onRunStep } = props;
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const locale = normalizeLang(lang);
  const copy = BANNER_COPY[locale];
  const isCollapsed = collapsed ?? internalCollapsed;
  const currentSpec = activeStep
    ? TOUR_STEPS.find((step) => step.id === activeStep) ?? null
    : null;

  const handleToggle = () => {
    if (collapsed === undefined) {
      setInternalCollapsed((prev) => !prev);
    }
    onToggleCollapsed?.();
  };

  const handleStepClick = (step: TourStepSpec) => {
    setAnnouncement(copy.runningAnnouncement(step.labels[locale]));
    onRunStep(toTourStepAction(step));
  };

  return (
    <section
      aria-label="Interactive judge demo walkthrough"
      lang={locale}
      data-collapsed={isCollapsed ? "true" : "false"}
      className="card judge-demo-tour"
      style={sectionStyle}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={srOnlyStyle}
      >
        {announcement}
      </div>

      <div style={headerRowStyle}>
        <div style={headerTextGroupStyle}>
          <div style={eyebrowRowStyle}>
            <p style={eyebrowStyle}>{copy.eyebrow}</p>
            {currentSpec ? (
              <span className="judge-tour-active-pill" style={activePillStyle}>
                {copy.activeStepPrefix} {currentSpec.labels[locale]}
              </span>
            ) : null}
          </div>
          <h2 id="judge-demo-tour-heading" style={headingStyle}>
            {copy.heading}
          </h2>
          <p style={subtitleStyle}>{copy.subtitle}</p>
        </div>

        <button
          type="button"
          data-action="toggle-judge-tour"
          aria-expanded={!isCollapsed}
          aria-controls={!isCollapsed ? "judge-demo-tour-steps" : undefined}
          onClick={handleToggle}
          className="btn btn-secondary judge-tour-toggle"
          style={toggleButtonStyle}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{
              width: "20px",
              height: "20px",
              flexShrink: 0,
              transform: isCollapsed ? "rotate(0deg)" : "rotate(180deg)"
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>{isCollapsed ? copy.expandButton : copy.collapseButton}</span>
        </button>
      </div>

      {!isCollapsed ? (
        <ol
          id="judge-demo-tour-steps"
          aria-label={copy.stepsListLabel}
          className="judge-tour-steps"
          style={stepsGridStyle}
        >
          {TOUR_STEPS.map((step) => {
            const isActive = activeStep === step.id;
            return (
              <li key={step.id} style={stepItemStyle}>
                <button
                  type="button"
                  data-step-id={step.id}
                  data-scenario-id={step.scenarioId}
                  data-mode-action={step.modeAction}
                  aria-current={isActive ? "step" : undefined}
                  onClick={() => handleStepClick(step)}
                  className="btn judge-tour-step-btn"
                  style={getStepButtonStyle(isActive)}
                >
                  <span style={stepTopRowStyle}>
                    <span className="judge-tour-step-label" style={stepLabelStyle}>
                      {step.labels[locale]}
                    </span>
                    <span
                      className="badge"
                      style={{
                        ...TONE_BADGE_STYLES[step.tone],
                        padding: "2px 8px",
                        borderRadius: "var(--radius-sm, 8px)",
                        fontSize: "0.75rem",
                        fontWeight: 800,
                        letterSpacing: "0.03em",
                        flexShrink: 0
                      }}
                    >
                      {step.badges[locale]}
                    </span>
                  </span>
                  <span className="judge-tour-step-detail" style={stepDetailStyle}>
                    {step.details[locale]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

export default JudgeDemoTour;
