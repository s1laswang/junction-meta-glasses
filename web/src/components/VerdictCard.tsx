import React, { useState, type CSSProperties } from "react";
import type { Field, LabelRead, TransportMode, Verdict, VerdictLevel } from "../types.ts";

export type VerdictCardProps = {
  verdict: Verdict | null;
  checking: boolean;
  mode: TransportMode;
  lang: string;
  onLogDose: (medId?: string) => void;
  onRepeat: () => void;
};

type LevelMeta = {
  label: "MATCH" | "WARNING" | "UNSURE" | "INFO";
  summary: string;
  bgVar: string;
  fgVar: string;
  borderVar: string;
  borderStyle: "solid" | "double" | "dashed";
  borderWidth: string;
};

const LEVEL_META: Record<VerdictLevel, LevelMeta> = {
  match: {
    label: "MATCH",
    summary: "Verified safe match",
    bgVar: "var(--verdict-match-bg, #06261d)",
    fgVar: "var(--verdict-match-fg, #7ef7c8)",
    borderVar: "var(--verdict-match-border, #2dd4a0)",
    borderStyle: "solid",
    borderWidth: "2.5px",
  },
  warning: {
    label: "WARNING",
    summary: "Safety warning",
    bgVar: "var(--verdict-warning-bg, #2d0e0a)",
    fgVar: "var(--verdict-warning-fg, #ffb8ab)",
    borderVar: "var(--verdict-warning-border, #ff6b52)",
    borderStyle: "double",
    borderWidth: "4px",
  },
  unsure: {
    label: "UNSURE",
    summary: "Cannot confirm safely",
    bgVar: "var(--verdict-unsure-bg, #261b04)",
    fgVar: "var(--verdict-unsure-fg, #ffe169)",
    borderVar: "var(--verdict-unsure-border, #f5b82e)",
    borderStyle: "dashed",
    borderWidth: "2.5px",
  },
  info: {
    label: "INFO",
    summary: "Label information",
    bgVar: "var(--verdict-info-bg, #0a1f38)",
    fgVar: "var(--verdict-info-fg, #a6d4ff)",
    borderVar: "var(--verdict-info-border, #4da3ff)",
    borderStyle: "solid",
    borderWidth: "2px",
  },
};

const MODE_LABELS: Record<TransportMode, string> = {
  live: "Live mode",
  snapshot: "Snapshot mode",
  offline: "Offline barcode mode",
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
  border: 0,
};

const STRENGTH_SAFETY_THRESHOLD = 0.8;

type ConfidenceRow = {
  key: "product" | "ingredient" | "strength" | "dosing" | "expiry" | "allergens" | "barcode" | "readability";
  label: string;
  valueText: string;
  isMissing: boolean;
  confidence: number;
  flaggedBelowSafetyThreshold: boolean;
};

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  if (val < 0) return 0;
  if (val > 1) return 1;
  return val;
}

function formatStringField(field: Field<string>): { valueText: string; isMissing: boolean; confidence: number } {
  const confidence = clamp01(field.confidence);
  const trimmed = field.value !== null ? field.value.trim() : "";
  if (!trimmed) {
    return { valueText: "Not readable", isMissing: true, confidence };
  }
  return { valueText: trimmed, isMissing: false, confidence };
}

function formatListField(field: Field<string[]>): { valueText: string; isMissing: boolean; confidence: number } {
  const confidence = clamp01(field.confidence);
  if (field.value === null) {
    return { valueText: "Not readable", isMissing: true, confidence };
  }
  const items = field.value.map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    return { valueText: "None declared", isMissing: false, confidence };
  }
  return { valueText: items.join(", "), isMissing: false, confidence };
}

function formatReadability(read: LabelRead): { valueText: string; isMissing: boolean; confidence: number } {
  const confidence = clamp01(read.readability);
  if (read.kind === "unreadable" || confidence <= 0) {
    return { valueText: "Not readable", isMissing: true, confidence };
  }
  const quality = confidence >= 0.8 ? "Clear" : confidence >= 0.5 ? "Partial" : "Low";
  return { valueText: `${quality} (${read.kind})`, isMissing: false, confidence };
}

function buildConfidenceRows(read: LabelRead): ConfidenceRow[] {
  const product = formatStringField(read.product);
  const ingredient = formatStringField(read.ingredient);
  const strength = formatStringField(read.strength);
  const dosing = formatStringField(read.dosing);
  const expiry = formatStringField(read.expiry);
  const allergens = formatListField(read.allergens);
  const barcode = formatStringField(read.barcode);
  const readability = formatReadability(read);

  return [
    {
      key: "product",
      label: "Product",
      ...product,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "ingredient",
      label: "Ingredient",
      ...ingredient,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "strength",
      label: "Strength",
      ...strength,
      flaggedBelowSafetyThreshold: strength.confidence < STRENGTH_SAFETY_THRESHOLD,
    },
    {
      key: "dosing",
      label: "Dosing",
      ...dosing,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "expiry",
      label: "Expiry",
      ...expiry,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "allergens",
      label: "Allergens",
      ...allergens,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "barcode",
      label: "Barcode",
      ...barcode,
      flaggedBelowSafetyThreshold: false,
    },
    {
      key: "readability",
      label: "Overall readability",
      ...readability,
      flaggedBelowSafetyThreshold: false,
    },
  ];
}

function LevelBadgeIcon({ level }: { level: VerdictLevel }) {
  const iconStyle: CSSProperties = {
    width: "24px",
    height: "24px",
    flexShrink: 0,
  };

  if (level === "match") {
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
        <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
        <path d="M8.4 12.3l2.4 2.5 4.9-5.1" />
      </svg>
    );
  }

  if (level === "warning") {
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
        style={iconStyle}
      >
        <path d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2L8.2 2z" />
        <path d="M12 6.3L17.6 16.4H6.4L12 6.3z" />
        <path d="M12 10.2v3.1" />
        <circle cx="12" cy="15" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (level === "unsure") {
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
        <path d="M12 2l10 10-10 10L2 12 12 2z" />
        <path d="M9.9 9.5a2.2 2.2 0 1 1 3.1 2c-.7.3-1 .7-1 1.5v.4" />
        <circle cx="12" cy="16.4" r="0.7" fill="currentColor" stroke="none" />
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
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5.2" />
      <circle cx="12" cy="7.8" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function barFillColor(confidence: number, flaggedBelowSafetyThreshold: boolean): string {
  if (flaggedBelowSafetyThreshold) return "var(--verdict-warning-border, #ff6b52)";
  if (confidence >= 0.8) return "var(--verdict-match-border, #2dd4a0)";
  if (confidence >= 0.6) return "var(--verdict-unsure-border, #f5b82e)";
  return "var(--verdict-warning-border, #ff6b52)";
}

export function VerdictCard(props: VerdictCardProps) {
  const { verdict, checking, mode, lang, onLogDose, onRepeat } = props;
  const [breakdownOpen, setBreakdownOpen] = useState<boolean>(true);

  const meta = verdict ? LEVEL_META[verdict.level] : null;
  const liveAnnouncement =
    verdict && meta ? `${meta.label}: ${verdict.headline}. ${verdict.speech}` : "";

  const containerClassName = verdict
    ? `card verdict-card verdict-${verdict.level}`
    : checking
      ? "card verdict-card verdict-checking"
      : "card verdict-card verdict-ready";

  const containerStyle: CSSProperties = verdict && meta
    ? {
        position: "relative",
        borderRadius: "var(--radius-lg, 18px)",
        padding: "var(--space-5, 20px)",
        backgroundColor: meta.bgVar,
        color: "var(--text-primary, #f8fafc)",
        borderColor: meta.borderVar,
        borderStyle: meta.borderStyle,
        borderWidth: meta.borderWidth,
        borderLeftWidth: "8px",
        boxShadow: "var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.44))",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
      }
    : {
        position: "relative",
        borderRadius: "var(--radius-lg, 18px)",
        padding: "var(--space-5, 20px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: checking
          ? "2.5px solid var(--verdict-unsure-border, #f5b82e)"
          : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
      };

  const modeLabel = MODE_LABELS[mode];
  const confidenceRows = verdict ? buildConfidenceRows(verdict.read) : [];
  const isAlreadyLoggedWarning = Boolean(
    verdict && verdict.level === "warning" && verdict.takenToday
  );
  const canLogDose = Boolean(verdict && verdict.matchedMedId && !isAlreadyLoggedWarning);
  const logButtonLabel = isAlreadyLoggedWarning
    ? "Already Logged Today"
    : "I Took It (Log Dose)";

  return (
    <section
      className={containerClassName}
      style={containerStyle}
      lang={lang || "en"}
      aria-label="Label safety verdict"
      aria-busy={checking}
    >
      <div
        className="sr-only verdict-live-region"
        aria-live="assertive"
        aria-atomic="true"
        style={SR_ONLY_STYLE}
      >
        {liveAnnouncement}
      </div>

      {checking && (
        <div
          className="verdict-checking-banner"
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3, 12px)",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--verdict-unsure-bg, #261b04)",
            color: "var(--verdict-unsure-fg, #ffe169)",
            border: "2px solid var(--verdict-unsure-border, #f5b82e)",
            fontWeight: 700,
            fontSize: "var(--text-base, 1.125rem)",
            lineHeight: 1.4,
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
            style={{ width: "26px", height: "26px", flexShrink: 0 }}
          >
            <path d="M4 7V5a1 1 0 0 1 1-1h2" />
            <path d="M17 4h2a1 1 0 0 1 1 1v2" />
            <path d="M20 17v2a1 1 0 0 1-1 1h-2" />
            <path d="M7 20H5a1 1 0 0 1-1-1v-2" />
            <line x1="7" y1="12" x2="17" y2="12" />
          </svg>
          <span>Hold still, verifying label with schema checker...</span>
        </div>
      )}

      {!verdict && !checking && (
        <div
          className="verdict-ready-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3, 12px)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "var(--space-2, 8px)",
            }}
          >
            <span
              className="badge verdict-ready-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "var(--radius-pill, 9999px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                color: "var(--text-primary, #f8fafc)",
                border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
                fontWeight: 700,
                fontSize: "var(--text-xs, 0.875rem)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
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
                style={{ width: "18px", height: "18px", flexShrink: 0 }}
              >
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>Ready to check</span>
            </span>

            <span className="pill verdict-mode-pill">{modeLabel}</span>
          </div>

          <h2
            className="verdict-ready-title"
            style={{
              margin: 0,
              fontSize: "var(--text-xl, 1.5rem)",
              lineHeight: 1.3,
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)",
            }}
          >
            Hold up a medicine box or food package, or choose a demo prop
          </h2>

          <p
            className="verdict-ready-hint"
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1.125rem)",
              lineHeight: 1.5,
              color: "var(--text-secondary, #d8e1ee)",
            }}
          >
            HoldUp coaches camera framing, verifies every field against your on-device profile, and never guesses a medication dose.
          </p>
        </div>
      )}

      {verdict && meta && (
        <>
          <div
            className="verdict-header"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "var(--space-2, 8px)",
            }}
          >
            <div
              className={`badge verdict-badge verdict-badge-${verdict.level}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                borderRadius: "var(--radius-pill, 9999px)",
                backgroundColor: "var(--bg-surface, #121926)",
                color: meta.fgVar,
                border: `2px solid ${meta.borderVar}`,
                fontWeight: 800,
                fontSize: "var(--text-sm, 1rem)",
                letterSpacing: "0.05em",
              }}
            >
              <LevelBadgeIcon level={verdict.level} />
              <span>{meta.label}</span>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: "var(--text-xs, 0.875rem)",
                  letterSpacing: "0.01em",
                  color: "var(--text-secondary, #d8e1ee)",
                }}
              >
                · {meta.summary}
              </span>
            </div>

            <span
              className="pill verdict-mode-pill"
              style={{
                backgroundColor: "var(--bg-surface, #121926)",
                color: "var(--text-primary, #f8fafc)",
                borderColor: meta.borderVar,
              }}
            >
              {modeLabel}
            </span>
          </div>

          <div
            className="verdict-copy"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 8px)",
            }}
          >
            <h2
              className="verdict-headline"
              style={{
                margin: 0,
                fontSize: "var(--text-2xl, 1.875rem)",
                lineHeight: 1.2,
                fontWeight: 800,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              {verdict.headline}
            </h2>

            <p
              className="verdict-speech"
              style={{
                margin: 0,
                fontSize: "var(--text-lg, 1.25rem)",
                lineHeight: 1.5,
                fontWeight: 500,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              {verdict.speech}
            </p>
          </div>

          {(verdict.takenToday !== undefined || verdict.reasons.length > 0) && (
            <ul
              className="verdict-pills"
              aria-label="Safety reasons and dose status"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2, 8px)",
              }}
            >
              {verdict.takenToday !== undefined && (
                <li
                  className={`pill verdict-pill verdict-taken-pill ${
                    verdict.takenToday ? "is-taken" : "is-not-taken"
                  }`}
                  style={{
                    backgroundColor: "var(--bg-surface, #121926)",
                    color: meta.fgVar,
                    border: `2px solid ${meta.borderVar}`,
                    fontWeight: 800,
                  }}
                >
                  <span aria-hidden="true">{verdict.takenToday ? "●" : "○"}</span>
                  <span>{verdict.takenToday ? "Taken today" : "Not taken today"}</span>
                </li>
              )}

              {verdict.reasons.map((reason, index) => (
                <li
                  key={`${reason}-${index}`}
                  className="pill verdict-pill verdict-reason-pill"
                  style={{
                    backgroundColor: "var(--bg-surface, #121926)",
                    color: "var(--text-primary, #f8fafc)",
                    borderColor: meta.borderVar,
                    fontWeight: 600,
                  }}
                >
                  {reason}
                </li>
              ))}
            </ul>
          )}

          <div
            className="verdict-actions"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: "var(--space-3, 12px)",
              paddingTop: "4px",
            }}
          >
            <button
              type="button"
              className="btn btn-primary btn-lg verdict-btn verdict-btn-log"
              disabled={!canLogDose}
              aria-disabled={!canLogDose}
              onClick={() => {
                if (canLogDose) {
                  onLogDose(verdict.matchedMedId);
                }
              }}
              style={{
                minHeight: "60px",
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
                style={{ width: "22px", height: "22px", flexShrink: 0 }}
              >
                {isAlreadyLoggedWarning ? (
                  <>
                    <circle cx="12" cy="12" r="9" />
                    <line x1="8" y1="8" x2="16" y2="16" />
                  </>
                ) : (
                  <path d="M20 6L9 17l-5-5" />
                )}
              </svg>
              <span>{logButtonLabel}</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-lg verdict-btn verdict-btn-repeat"
              onClick={() => onRepeat()}
              style={{
                minHeight: "60px",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
                style={{ width: "22px", height: "22px", flexShrink: 0 }}
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
              </svg>
              <span>Repeat Answer</span>
            </button>
          </div>

          {isAlreadyLoggedWarning && (
            <p
              className="verdict-double-dose-guard"
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                lineHeight: 1.45,
                fontWeight: 600,
                color: "var(--text-secondary, #d8e1ee)",
              }}
            >
              Double-dose protection active: open your profile if you need to edit today&apos;s dose log.
            </p>
          )}

          <details
            className="verdict-confidence-details"
            open={breakdownOpen}
            onToggle={(event) => setBreakdownOpen(event.currentTarget.open)}
            style={{
              borderRadius: "var(--radius-md, 12px)",
              backgroundColor: "var(--bg-surface, #121926)",
              color: "var(--text-primary, #f8fafc)",
              border: `var(--border-width, 1.5px) solid ${meta.borderVar}`,
              padding: "var(--space-4, 16px)",
            }}
          >
            <summary
              className="verdict-confidence-summary"
              style={{
                cursor: "pointer",
                fontWeight: 800,
                fontSize: "var(--text-base, 1.125rem)",
                color: "var(--text-primary, #f8fafc)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "var(--space-3, 12px)",
                minHeight: "44px",
              }}
            >
              <span>Per-Field Confidence Breakdown</span>
              <span
                style={{
                  fontSize: "var(--text-sm, 1rem)",
                  fontWeight: 700,
                  color: "var(--text-secondary, #d8e1ee)",
                }}
              >
                {Math.round(clamp01(verdict.read.readability) * 100)}% overall readability
              </span>
            </summary>

            <div
              className="verdict-confidence-list"
              style={{
                marginTop: "var(--space-3, 12px)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3, 12px)",
              }}
            >
              {confidenceRows.map((row) => {
                const pct = Math.round(row.confidence * 100);
                const fillColor = barFillColor(row.confidence, row.flaggedBelowSafetyThreshold);

                return (
                  <div
                    key={row.key}
                    className={`field-row confidence-row confidence-row-${row.key}${
                      row.flaggedBelowSafetyThreshold ? " confidence-row-flagged" : ""
                    }`}
                    data-field={row.key}
                    style={{
                      padding: "var(--space-3, 12px)",
                      borderRadius: "var(--radius-sm, 8px)",
                      backgroundColor: row.flaggedBelowSafetyThreshold
                        ? "var(--verdict-warning-bg, #2d0e0a)"
                        : "var(--bg-elevated, #1a2333)",
                      border: row.flaggedBelowSafetyThreshold
                        ? "2px dashed var(--verdict-warning-border, #ff6b52)"
                        : "1px solid var(--border-subtle, #2c3a52)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "stretch",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <span
                        className="confidence-field-label"
                        style={{
                          fontWeight: 800,
                          fontSize: "var(--text-sm, 1rem)",
                          color: "var(--text-primary, #f8fafc)",
                        }}
                      >
                        {row.label}
                      </span>

                      <span
                        className="confidence-field-pct"
                        style={{
                          fontWeight: 800,
                          fontSize: "var(--text-sm, 1rem)",
                          fontVariantNumeric: "tabular-nums",
                          color: row.flaggedBelowSafetyThreshold
                            ? "var(--verdict-warning-fg, #ffb8ab)"
                            : "var(--text-secondary, #d8e1ee)",
                        }}
                      >
                        {pct}%
                      </span>
                    </div>

                    <div
                      className="confidence-field-value"
                      style={{
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: row.isMissing ? 500 : 700,
                        fontStyle: row.isMissing ? "italic" : "normal",
                        color: row.isMissing
                          ? "var(--text-muted, #b5c2d6)"
                          : "var(--text-primary, #f8fafc)",
                        wordBreak: "break-word",
                      }}
                    >
                      {row.valueText}
                    </div>

                    <meter
                      className="sr-only"
                      min={0}
                      max={100}
                      low={60}
                      high={80}
                      optimum={95}
                      value={pct}
                      aria-label={`${row.label} confidence ${pct}%`}
                      style={SR_ONLY_STYLE}
                    >
                      {pct}%
                    </meter>

                    <div className="confidence-bar" aria-hidden="true">
                      <div
                        className="confidence-fill confidence-bar-fill"
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          backgroundColor: fillColor,
                        }}
                      />
                    </div>

                    {row.flaggedBelowSafetyThreshold && (
                      <div
                        className="confidence-threshold-warning"
                        role="note"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          marginTop: "2px",
                          fontSize: "var(--text-sm, 1rem)",
                          fontWeight: 800,
                          color: "var(--verdict-warning-fg, #ffb8ab)",
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
                          style={{ width: "18px", height: "18px", flexShrink: 0 }}
                        >
                          <path d="M12 3L22 20H2L12 3z" />
                          <line x1="12" y1="9" x2="12" y2="14" />
                          <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
                        </svg>
                        <span>Below 80% safety threshold: dose never guessed</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export default VerdictCard;
