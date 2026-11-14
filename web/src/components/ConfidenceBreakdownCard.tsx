import { useEffect, useState, type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { Field, LabelRead, Verdict } from "../types.ts";

export const STRENGTH_GATE_THRESHOLD = 0.80;

export type FieldInspectionRow = {
  key: string;
  label: string;
  displayValue: string;
  confidencePct: number;
  gated?: boolean;
  gatePassed?: boolean;
};

export type ConfidenceBreakdownCardProps = {
  verdict: Verdict | null;
  lang: string;
  defaultExpanded?: boolean;
};

type FieldKey =
  | "product"
  | "ingredient"
  | "strength"
  | "dosageInstructions"
  | "allergens"
  | "expiry"
  | "warnings"
  | "barcode";

type InspectorCopy = {
  eyebrow: string;
  subtitle: string;
  expandButton: string;
  collapseButton: string;
  readabilityBadge: (pct: number) => string;
  gateSummaryPassed: (pct: number) => string;
  gateSummaryBlocked: (pct: number, missing: boolean) => string;
  gateSummaryFood: string;
  gateSummaryOther: string;
  rowGatePassedBadge: string;
  rowGateBlockedBadge: string;
  rowGateReferenceBadge: string;
  thresholdTickLabel: string;
  blockedCallout: string;
  passedCallout: string;
  auditHeading: string;
  auditListLabel: string;
  noAuditReasons: string;
  notReadable: string;
  noneDeclared: string;
  nonePrinted: string;
  meterLabel: (label: string, value: string, pct: number) => string;
  fieldLabels: Record<FieldKey, string>;
};

const INSPECTOR_COPY: Record<UiLocale, InspectorCopy> = {
  en: {
    eyebrow: "Schema Confidence & Dose Gate",
    subtitle:
      "Every printed field is scored 0 to 100%. Medication strength requires at least 80% confidence or HoldUp refuses to guess.",
    expandButton: "Show field breakdown",
    collapseButton: "Hide field breakdown",
    readabilityBadge: (pct) => `Readability ${pct}%`,
    gateSummaryPassed: (pct) => `80% Dose Gate: PASSED (${pct}%)`,
    gateSummaryBlocked: (pct, missing) =>
      missing
        ? "80% Dose Gate: BLOCKED (unreadable)"
        : `80% Dose Gate: BLOCKED (${pct}% < 80%)`,
    gateSummaryFood: "Food Label Mode (Allergen & Expiry Check)",
    gateSummaryOther: "General Label Mode",
    rowGatePassedBadge: "PASSED >= 80%",
    rowGateBlockedBadge: "BLOCKED < 80%",
    rowGateReferenceBadge: "80% DOSE GATE",
    thresholdTickLabel: "80% never-guess gate (STRENGTH_MIN_CONF = 0.80)",
    blockedCallout:
      "Blocked by 80% never-guess gate: strength is not confirmed. Show the side panel or confirm with a pharmacist.",
    passedCallout: "Strength meets the 80% deterministic safety gate.",
    auditHeading: "Deterministic Safety Audit Trail",
    auditListLabel: "Safety audit reasons",
    noAuditReasons: "No additional rule flags recorded",
    notReadable: "Not readable",
    noneDeclared: "None declared",
    nonePrinted: "None printed",
    meterLabel: (label, value, pct) => `${label}: ${value} (${pct}% confidence)`,
    fieldLabels: {
      product: "Product",
      ingredient: "Active ingredient",
      strength: "Strength",
      dosageInstructions: "Dosage instructions",
      allergens: "Allergens",
      expiry: "Expiry date",
      warnings: "Warnings",
      barcode: "Barcode"
    }
  },
  fi: {
    eyebrow: "Kenttävarmuus ja 80 % annosraja",
    subtitle:
      "Jokainen painettu kenttä pisteytetään 0..100 %. Lääkkeen vahvuus vaatii vähintään 80 % varmuuden, eikä HoldUp koskaan arvaa annosta.",
    expandButton: "Näytä kenttäerittely",
    collapseButton: "Piilota kenttäerittely",
    readabilityBadge: (pct) => `Luettavuus ${pct} %`,
    gateSummaryPassed: (pct) => `80 % annosraja: LÄPÄISTY (${pct} %)`,
    gateSummaryBlocked: (pct, missing) =>
      missing
        ? "80 % annosraja: ESTETTY (ei luettavissa)"
        : `80 % annosraja: ESTETTY (${pct} % < 80 %)`,
    gateSummaryFood: "Elintarviketila (allergeeni- ja päiväystarkistus)",
    gateSummaryOther: "Yleinen etikettitila",
    rowGatePassedBadge: "LÄPÄISTY >= 80 %",
    rowGateBlockedBadge: "ESTETTY < 80 %",
    rowGateReferenceBadge: "80 % ANNOSRAJA",
    thresholdTickLabel: "80 % ei-arvausta-raja (STRENGTH_MIN_CONF = 0.80)",
    blockedCallout:
      "Estetty 80 % turvarajalla: vahvuutta ei voitu varmistaa. Käännä sivupaneeli esiin tai varmista apteekista.",
    passedCallout: "Vahvuus täyttää 80 % deterministisen turvarajan.",
    auditHeading: "Deterministinen turvallisuustarkastus",
    auditListLabel: "Turvallisuustarkastuksen perustelut",
    noAuditReasons: "Ei lisähuomautuksia säännöistä",
    notReadable: "Ei luettavissa",
    noneDeclared: "Ei ilmoitettuja allergeeneja",
    nonePrinted: "Ei painettuja varoituksia",
    meterLabel: (label, value, pct) => `${label}: ${value} (varmuus ${pct} %)`,
    fieldLabels: {
      product: "Tuote",
      ingredient: "Vaikuttava aine",
      strength: "Vahvuus",
      dosageInstructions: "Annostusohje",
      allergens: "Allergeenit",
      expiry: "Viimeinen käyttöpäivä",
      warnings: "Varoitukset",
      barcode: "Viivakoodi"
    }
  },
  sv: {
    eyebrow: "Fältsäkerhet och 80 % dosgräns",
    subtitle:
      "Varje tryckt fält poängsätts 0 till 100 %. Läkemedelsstyrka kräver minst 80 % säkerhet och HoldUp gissar aldrig en dos.",
    expandButton: "Visa fältuppdelning",
    collapseButton: "Dölj fältuppdelning",
    readabilityBadge: (pct) => `Läsbarhet ${pct} %`,
    gateSummaryPassed: (pct) => `80 % dosgräns: GODKÄND (${pct} %)`,
    gateSummaryBlocked: (pct, missing) =>
      missing
        ? "80 % dosgräns: BLOCKERAD (ej läsbar)"
        : `80 % dosgräns: BLOCKERAD (${pct} % < 80 %)`,
    gateSummaryFood: "Livsmedelsläge (allergen- och datumkontroll)",
    gateSummaryOther: "Allmänt etikettläge",
    rowGatePassedBadge: "GODKÄND >= 80 %",
    rowGateBlockedBadge: "BLOCKERAD < 80 %",
    rowGateReferenceBadge: "80 % DOSGRÄNS",
    thresholdTickLabel: "80 % gissa-aldrig-gräns (STRENGTH_MIN_CONF = 0.80)",
    blockedCallout:
      "Blockerad av 80 % säkerhetsgräns: styrkan är inte bekräftad. Visa sidopanelen eller fråga apotekspersonal.",
    passedCallout: "Styrkan uppfyller den deterministiska 80 % säkerhetsgränsen.",
    auditHeading: "Deterministisk säkerhetsgranskning",
    auditListLabel: "Orsaker från säkerhetsgranskningen",
    noAuditReasons: "Inga ytterligare regelflaggor",
    notReadable: "Ej läsbar",
    noneDeclared: "Inga angivna allergener",
    nonePrinted: "Inga tryckta varningar",
    meterLabel: (label, value, pct) => `${label}: ${value} (${pct} % säkerhet)`,
    fieldLabels: {
      product: "Produkt",
      ingredient: "Aktiv substans",
      strength: "Styrka",
      dosageInstructions: "Doseringsanvisning",
      allergens: "Allergener",
      expiry: "Utgångsdatum",
      warnings: "Varningar",
      barcode: "Streckkod"
    }
  }
};

const SR_ONLY_STYLE: CSSProperties = {
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

type ExtendedLabelRead = LabelRead & {
  dosageInstructions?: Field<string>;
  warnings?: Field<string | string[]>;
};

function clamp01(val: unknown): number {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    return 0;
  }
  if (val < 0) {
    return 0;
  }
  if (val > 1) {
    return 1;
  }
  return val;
}

function toConfidencePct(rawConfidence: unknown, gated = false, gatePassed = true): number {
  const clamped = clamp01(rawConfidence);
  const thresholdPct = Math.round(STRENGTH_GATE_THRESHOLD * 100);
  const rounded = Math.round(clamped * 100);
  if (gated && !gatePassed && clamped < STRENGTH_GATE_THRESHOLD && rounded >= thresholdPct) {
    return thresholdPct - 1;
  }
  return rounded;
}

function formatStringField(
  field: Field<string> | undefined,
  copy: InspectorCopy,
  gated = false,
  gatePassed = true
): { displayValue: string; confidencePct: number } {
  const rawVal = typeof field?.value === "string" ? field.value.trim() : "";
  const confidencePct = toConfidencePct(field?.confidence ?? 0, gated, gatePassed);
  if (!rawVal) {
    return { displayValue: copy.notReadable, confidencePct };
  }
  return { displayValue: rawVal, confidencePct };
}

function formatAllergensField(
  field: Field<string[]> | undefined,
  copy: InspectorCopy
): { displayValue: string; confidencePct: number } {
  const confidencePct = toConfidencePct(field?.confidence ?? 0);
  if (!field || field.value === null || !Array.isArray(field.value)) {
    return { displayValue: copy.notReadable, confidencePct };
  }
  const items = field.value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (items.length === 0) {
    return { displayValue: copy.noneDeclared, confidencePct };
  }
  return { displayValue: items.join(", "), confidencePct };
}

function formatWarningsField(
  read: ExtendedLabelRead,
  copy: InspectorCopy
): { displayValue: string; confidencePct: number } {
  const explicit = read.warnings;
  if (explicit && typeof explicit === "object") {
    const confidencePct = toConfidencePct(explicit.confidence);
    if (Array.isArray(explicit.value)) {
      const items = explicit.value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
      return {
        displayValue: items.length > 0 ? items.join(", ") : copy.nonePrinted,
        confidencePct
      };
    }
    if (typeof explicit.value === "string" && explicit.value.trim().length > 0) {
      return { displayValue: explicit.value.trim(), confidencePct };
    }
    return { displayValue: copy.notReadable, confidencePct };
  }

  const guidance = typeof read.guidance === "string" ? read.guidance.trim() : "";
  if (guidance.length > 0) {
    return {
      displayValue: guidance,
      confidencePct: toConfidencePct(read.readability)
    };
  }

  if (read.kind !== "unreadable" && clamp01(read.readability) > 0) {
    return {
      displayValue: copy.nonePrinted,
      confidencePct: toConfidencePct(read.readability)
    };
  }

  return {
    displayValue: copy.notReadable,
    confidencePct: 0
  };
}

export function buildFieldInspectionRows(
  read: LabelRead,
  lang = "en"
): FieldInspectionRow[] {
  const locale = normalizeLang(lang);
  const copy = INSPECTOR_COPY[locale];
  const extRead = read as ExtendedLabelRead;

  const strengthText =
    typeof read.strength?.value === "string" ? read.strength.value.trim() : "";
  const strengthConfidence = clamp01(read.strength?.confidence ?? 0);
  const strengthGatePassed =
    Boolean(strengthText) && strengthConfidence >= STRENGTH_GATE_THRESHOLD;

  const product = formatStringField(read.product, copy);
  const ingredient = formatStringField(read.ingredient, copy);
  const strength = formatStringField(
    read.strength,
    copy,
    true,
    strengthGatePassed
  );
  const dosage = formatStringField(
    extRead.dosageInstructions ?? read.dosing,
    copy
  );
  const allergens = formatAllergensField(read.allergens, copy);
  const expiry = formatStringField(read.expiry, copy);
  const warnings = formatWarningsField(extRead, copy);
  const barcode = formatStringField(read.barcode, copy);

  return [
    {
      key: "product",
      label: copy.fieldLabels.product,
      displayValue: product.displayValue,
      confidencePct: product.confidencePct
    },
    {
      key: "ingredient",
      label: copy.fieldLabels.ingredient,
      displayValue: ingredient.displayValue,
      confidencePct: ingredient.confidencePct
    },
    {
      key: "strength",
      label: copy.fieldLabels.strength,
      displayValue: strength.displayValue,
      confidencePct: strength.confidencePct,
      gated: true,
      gatePassed: strengthGatePassed
    },
    {
      key: "dosageInstructions",
      label: copy.fieldLabels.dosageInstructions,
      displayValue: dosage.displayValue,
      confidencePct: dosage.confidencePct
    },
    {
      key: "allergens",
      label: copy.fieldLabels.allergens,
      displayValue: allergens.displayValue,
      confidencePct: allergens.confidencePct
    },
    {
      key: "expiry",
      label: copy.fieldLabels.expiry,
      displayValue: expiry.displayValue,
      confidencePct: expiry.confidencePct
    },
    {
      key: "warnings",
      label: copy.fieldLabels.warnings,
      displayValue: warnings.displayValue,
      confidencePct: warnings.confidencePct
    },
    {
      key: "barcode",
      label: copy.fieldLabels.barcode,
      displayValue: barcode.displayValue,
      confidencePct: barcode.confidencePct
    }
  ];
}

function resolveBarFillColor(
  row: FieldInspectionRow,
  isMedication: boolean
): string {
  if (row.gated && isMedication) {
    return row.gatePassed
      ? "var(--verdict-match-border, #2dd4a0)"
      : "var(--verdict-warning-border, #ff6b52)";
  }
  if (row.confidencePct >= 80) {
    return "var(--verdict-match-border, #2dd4a0)";
  }
  if (row.confidencePct >= 60) {
    return "var(--verdict-unsure-border, #f5b82e)";
  }
  return "var(--verdict-warning-border, #ff6b52)";
}

export function ConfidenceBreakdownCard(props: ConfidenceBreakdownCardProps) {
  const { verdict, lang, defaultExpanded = true } = props;
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  if (verdict === null) {
    return null;
  }

  const locale = normalizeLang(lang);
  const copy = INSPECTOR_COPY[locale];
  const titleText = t(locale, "confidenceTitle");
  const disclaimerText = t(locale, "notMedicalDevice");
  const rows = buildFieldInspectionRows(verdict.read, locale);
  const strengthRow = rows.find((row) => row.key === "strength");
  const isMedication = verdict.read.kind === "medication";
  const strengthPassed = Boolean(strengthRow?.gatePassed);
  const strengthMissing =
    typeof verdict.read.strength?.value !== "string" ||
    verdict.read.strength.value.trim().length === 0;
  const readabilityPct = toConfidencePct(verdict.read.readability);
  const thresholdPct = Math.round(STRENGTH_GATE_THRESHOLD * 100);

  const summaryBadgeStyle: CSSProperties = isMedication
    ? strengthPassed
      ? {
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 12px",
          borderRadius: "var(--radius-pill, 9999px)",
          backgroundColor: "var(--verdict-match-bg, #06261d)",
          color: "var(--verdict-match-fg, #7ef7c8)",
          border: "2px solid var(--verdict-match-border, #2dd4a0)",
          fontSize: "var(--text-xs, 0.875rem)",
          fontWeight: 800,
          letterSpacing: "0.02em"
        }
      : {
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 12px",
          borderRadius: "var(--radius-pill, 9999px)",
          backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
          color: "var(--verdict-warning-fg, #ffb8ab)",
          border: "2px dashed var(--verdict-warning-border, #ff6b52)",
          fontSize: "var(--text-xs, 0.875rem)",
          fontWeight: 800,
          letterSpacing: "0.02em"
        }
    : {
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 12px",
        borderRadius: "var(--radius-pill, 9999px)",
        backgroundColor: "var(--verdict-info-bg, #0a1f38)",
        color: "var(--verdict-info-fg, #a6d4ff)",
        border: "1.5px solid var(--verdict-info-border, #4da3ff)",
        fontSize: "var(--text-xs, 0.875rem)",
        fontWeight: 700,
        letterSpacing: "0.02em"
      };

  const summaryBadgeLabel = isMedication
    ? strengthPassed
      ? copy.gateSummaryPassed(strengthRow?.confidencePct ?? 0)
      : copy.gateSummaryBlocked(strengthRow?.confidencePct ?? 0, strengthMissing)
    : verdict.read.kind === "food"
      ? copy.gateSummaryFood
      : copy.gateSummaryOther;

  const summaryGateState = isMedication
    ? strengthPassed
      ? "passed"
      : "blocked"
    : "not-applicable";

  const panelId = "confidence-breakdown-panel";

  return (
    <section
      aria-labelledby="confidence-breakdown-heading"
      lang={locale}
      data-kind={verdict.read.kind}
      data-expanded={expanded ? "true" : "false"}
      data-strength-gate={summaryGateState}
      className="card confidence-breakdown-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border:
          isMedication && !strengthPassed
            ? "2px solid var(--verdict-warning-border, #ff6b52)"
            : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
      }}
    >
      <div
        className="confidence-breakdown-header"
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
            flex: "1 1 280px"
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
            id="confidence-breakdown-heading"
            style={{
              margin: 0,
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.28,
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {titleText}
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

          <div
            className="confidence-summary-badges"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--space-2, 8px)",
              marginTop: "4px"
            }}
          >
            <span
              className={`badge confidence-gate-summary-badge is-gate-${summaryGateState}`}
              data-gate-status={summaryGateState}
              role="status"
              style={summaryBadgeStyle}
            >
              {isMedication ? (
                strengthPassed ? (
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
                    <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
                    <path d="M8.5 12.3l2.4 2.4 4.8-5" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                    style={{ width: "16px", height: "16px", flexShrink: 0 }}
                  >
                    <path d="M12 3L22 20H2L12 3z" />
                    <line x1="12" y1="9" x2="12" y2="14" />
                    <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
                  </svg>
                )
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                  style={{ width: "16px", height: "16px", flexShrink: 0 }}
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5" />
                  <circle cx="12" cy="7.8" r="0.8" fill="currentColor" stroke="none" />
                </svg>
              )}
              <span>{summaryBadgeLabel}</span>
            </span>

            <span
              className="pill confidence-readability-pill"
              style={{
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700
              }}
            >
              {copy.readabilityBadge(readabilityPct)}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary confidence-disclosure-toggle"
          data-action="toggle-confidence-breakdown"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => setExpanded((prev) => !prev)}
          style={{
            minHeight: "56px",
            padding: "12px 18px",
            fontSize: "var(--text-sm, 1rem)",
            fontWeight: 700,
            flexShrink: 0
          }}
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
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)"
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>{expanded ? copy.collapseButton : copy.expandButton}</span>
        </button>
      </div>

      {expanded ? (
        <div
          id={panelId}
          className="confidence-breakdown-panel"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4, 16px)"
          }}
        >
          <div
            className="confidence-inspector-rows"
            role="list"
            aria-label={titleText}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3, 12px)"
            }}
          >
            {rows.map((row) => {
              const isGated = Boolean(row.gated);
              const isBlockedMedStrength =
                isGated && isMedication && !row.gatePassed;
              const isPassedMedStrength =
                isGated && isMedication && Boolean(row.gatePassed);
              const fillColor = resolveBarFillColor(row, isMedication);
              const isFallbackMissing =
                row.displayValue === copy.notReadable;

              return (
                <div
                  key={row.key}
                  role="listitem"
                  data-field-key={row.key}
                  data-gated={isGated ? "true" : "false"}
                  data-gate-passed={
                    isGated ? (row.gatePassed ? "true" : "false") : undefined
                  }
                  className={`field-row confidence-inspector-row confidence-inspector-row-${row.key}${
                    isBlockedMedStrength ? " is-gate-blocked" : ""
                  }${isPassedMedStrength ? " is-gate-passed" : ""}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    gap: "8px",
                    padding: "var(--space-3, 12px)",
                    borderRadius: "var(--radius-md, 12px)",
                    backgroundColor: isBlockedMedStrength
                      ? "var(--verdict-warning-bg, #2d0e0a)"
                      : "var(--bg-elevated, #1a2333)",
                    border: isBlockedMedStrength
                      ? "2px dashed var(--verdict-warning-border, #ff6b52)"
                      : isPassedMedStrength
                        ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                        : "1px solid var(--border-subtle, #2c3a52)"
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
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: "8px"
                      }}
                    >
                      <span
                        className="confidence-inspector-label"
                        style={{
                          fontWeight: 800,
                          fontSize: "var(--text-sm, 1rem)",
                          color: "var(--text-primary, #f8fafc)"
                        }}
                      >
                        {row.label}
                      </span>

                      {isGated ? (
                        <span
                          className="badge confidence-row-gate-badge"
                          style={{
                            padding: "2px 8px",
                            borderRadius: "var(--radius-sm, 8px)",
                            fontSize: "0.75rem",
                            fontWeight: 800,
                            letterSpacing: "0.03em",
                            ...(isMedication
                              ? row.gatePassed
                                ? {
                                    backgroundColor: "var(--verdict-match-bg, #06261d)",
                                    color: "var(--verdict-match-fg, #7ef7c8)",
                                    border: "1.5px solid var(--verdict-match-border, #2dd4a0)"
                                  }
                                : {
                                    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
                                    color: "var(--verdict-warning-fg, #ffb8ab)",
                                    border: "1.5px solid var(--verdict-warning-border, #ff6b52)"
                                  }
                              : {
                                  backgroundColor: "var(--bg-surface, #121926)",
                                  color: "var(--text-secondary, #d8e1ee)",
                                  border: "1px solid var(--border-strong, #6980a3)"
                                })
                          }}
                        >
                          {isMedication
                            ? row.gatePassed
                              ? copy.rowGatePassedBadge
                              : copy.rowGateBlockedBadge
                            : copy.rowGateReferenceBadge}
                        </span>
                      ) : null}
                    </div>

                    <span
                      className="confidence-inspector-pct"
                      style={{
                        fontWeight: 800,
                        fontSize: "var(--text-sm, 1rem)",
                        fontVariantNumeric: "tabular-nums",
                        fontFamily: "var(--font-mono, monospace)",
                        color: isBlockedMedStrength
                          ? "var(--verdict-warning-fg, #ffb8ab)"
                          : "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {row.confidencePct}%
                    </span>
                  </div>

                  <div
                    className="confidence-inspector-value"
                    style={{
                      fontSize: "var(--text-base, 1.125rem)",
                      fontWeight: isFallbackMissing ? 500 : 700,
                      fontStyle: isFallbackMissing ? "italic" : "normal",
                      color: isFallbackMissing
                        ? "var(--text-muted, #b5c2d6)"
                        : "var(--text-primary, #f8fafc)",
                      wordBreak: "break-word"
                    }}
                  >
                    {row.displayValue}
                  </div>

                  <meter
                    className="sr-only confidence-inspector-meter"
                    min={0}
                    max={100}
                    low={60}
                    high={thresholdPct}
                    optimum={95}
                    value={row.confidencePct}
                    aria-label={copy.meterLabel(
                      row.label,
                      row.displayValue,
                      row.confidencePct
                    )}
                    style={SR_ONLY_STYLE}
                  >
                    {row.confidencePct}%
                  </meter>

                  <div
                    className="confidence-bar-wrapper"
                    aria-hidden="true"
                    style={{
                      position: "relative",
                      width: "100%",
                      paddingTop: isGated ? "4px" : "0",
                      paddingBottom: isGated ? "4px" : "0"
                    }}
                  >
                    <div
                      className="confidence-bar"
                      style={{
                        position: "relative",
                        width: "100%",
                        height: "14px",
                        backgroundColor: "var(--bg-app, #0b0f17)",
                        border: "1px solid var(--border-subtle, #2c3a52)",
                        borderRadius: "var(--radius-pill, 9999px)",
                        overflow: "hidden"
                      }}
                    >
                      <div
                        className="confidence-fill"
                        style={{
                          width: `${row.confidencePct}%`,
                          minWidth: row.confidencePct > 0 ? "4px" : "0px",
                          height: "100%",
                          backgroundColor: fillColor
                        }}
                      />
                    </div>

                    {isGated ? (
                      <div
                        className="confidence-threshold-tick"
                        data-threshold-pct={String(thresholdPct)}
                        style={{
                          position: "absolute",
                          top: "0px",
                          bottom: "0px",
                          left: `${thresholdPct}%`,
                          width: "3px",
                          transform: "translateX(-50%)",
                          backgroundColor: "var(--text-primary, #f8fafc)",
                          borderRadius: "2px",
                          boxShadow: "0 0 0 1px var(--bg-app, #0b0f17)"
                        }}
                      />
                    ) : null}
                  </div>

                  {isGated ? (
                    <div
                      className="confidence-threshold-legend"
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "6px",
                        fontSize: "var(--text-xs, 0.875rem)",
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      <span>{copy.thresholdTickLabel}</span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontWeight: 700
                        }}
                      >
                        {thresholdPct}%
                      </span>
                    </div>
                  ) : null}

                  {isBlockedMedStrength ? (
                    <div
                      role="note"
                      className="confidence-gate-callout is-blocked"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "var(--text-sm, 1rem)",
                        fontWeight: 700,
                        color: "var(--verdict-warning-fg, #ffb8ab)"
                      }}
                    >
                      <span>{copy.blockedCallout}</span>
                    </div>
                  ) : null}

                  {isPassedMedStrength ? (
                    <div
                      role="note"
                      className="confidence-gate-callout is-passed"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        color: "var(--verdict-match-fg, #7ef7c8)"
                      }}
                    >
                      <span>{copy.passedCallout}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div
            className="confidence-audit-section"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 8px)",
              padding: "var(--space-4, 16px)",
              borderRadius: "var(--radius-md, 12px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              border: "1px solid var(--border-subtle, #2c3a52)"
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                fontWeight: 800,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {copy.auditHeading}
            </h3>

            {verdict.reasons.length > 0 ? (
              <ul
                aria-label={copy.auditListLabel}
                className="confidence-audit-pills"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2, 8px)"
                }}
              >
                {verdict.reasons.map((reason, index) => (
                  <li
                    key={`${reason}-${index}`}
                    className="pill confidence-audit-pill"
                    style={{
                      backgroundColor: "var(--bg-surface, #121926)",
                      color: "var(--text-primary, #f8fafc)",
                      border: "1.5px solid var(--border-strong, #6980a3)",
                      fontWeight: 700
                    }}
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p
                className="confidence-audit-empty"
                style={{
                  margin: 0,
                  fontSize: "var(--text-sm, 1rem)",
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {copy.noAuditReasons}
              </p>
            )}
          </div>

          <p
            className="confidence-medical-boundary"
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              color: "var(--text-secondary, #d8e1ee)",
              lineHeight: 1.45
            }}
          >
            {disclaimerText}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export default ConfidenceBreakdownCard;
