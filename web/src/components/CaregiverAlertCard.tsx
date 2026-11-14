import React, { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { Profile, Verdict } from "../types.ts";
import {
  buildFamilyAlertLinks,
  computeDailySchedule,
  loadCaregiverContact,
  saveCaregiverContact,
  type CaregiverContact,
  type DoseWindowStatus,
  type MedScheduleItem
} from "../storage/caregiverSchedule.ts";

export type CaregiverAlertCardProps = {
  profile: Profile;
  lastVerdict?: Verdict | null;
  lang: string;
  onQuickLogDose: (medId: string) => void;
  now?: Date;
};

type StatusVisual = {
  badgeLabel: string;
  bgVar: string;
  fgVar: string;
  borderVar: string;
  borderStyle: "solid" | "double" | "dashed";
};

const STATUS_VISUALS: Record<DoseWindowStatus, StatusVisual> = {
  taken: {
    badgeLabel: "Taken",
    bgVar: "var(--verdict-match-bg, #06261d)",
    fgVar: "var(--verdict-match-fg, #7ef7c8)",
    borderVar: "var(--verdict-match-border, #2dd4a0)",
    borderStyle: "solid"
  },
  due_now: {
    badgeLabel: "Due Now",
    bgVar: "var(--verdict-unsure-bg, #261b04)",
    fgVar: "var(--verdict-unsure-fg, #ffe169)",
    borderVar: "var(--verdict-unsure-border, #f5b82e)",
    borderStyle: "solid"
  },
  overdue: {
    badgeLabel: "Overdue",
    bgVar: "var(--verdict-warning-bg, #2d0e0a)",
    fgVar: "var(--verdict-warning-fg, #ffb8ab)",
    borderVar: "var(--verdict-warning-border, #ff6b52)",
    borderStyle: "double"
  },
  upcoming: {
    badgeLabel: "Upcoming",
    bgVar: "var(--verdict-info-bg, #0a1f38)",
    fgVar: "var(--verdict-info-fg, #a6d4ff)",
    borderVar: "var(--verdict-info-border, #4da3ff)",
    borderStyle: "solid"
  },
  as_needed: {
    badgeLabel: "As Needed",
    bgVar: "var(--bg-elevated, #1a2333)",
    fgVar: "var(--text-secondary, #d8e1ee)",
    borderVar: "var(--border-strong, #6980a3)",
    borderStyle: "dashed"
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

function formatSlotDisplay(slot: string): string {
  const trimmed = slot.trim();
  if (!trimmed) return "Scheduled";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatMedDisplay(item: MedScheduleItem): string {
  const strength = item.med.strength.trim();
  return strength ? `${item.med.name} ${strength}` : item.med.name;
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      void 0;
    }
  }
  if (typeof document !== "undefined" && document.body) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }
  return false;
}

function StatusBadgeIcon({ status }: { status: DoseWindowStatus }) {
  const style: CSSProperties = { width: "18px", height: "18px", flexShrink: 0 };

  if (status === "taken") {
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
        style={style}
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }

  if (status === "overdue") {
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
        style={style}
      >
        <path d="M12 3L22 20H2L12 3z" />
        <line x1="12" y1="9" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (status === "due_now") {
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
        style={style}
      >
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15.5 14" />
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
      style={style}
    >
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="12" x2="15" y2="12" />
    </svg>
  );
}

function summarizeCheckAnswer(items: MedScheduleItem[]): {
  tone: DoseWindowStatus;
  title: string;
  detail: string;
} {
  const scheduled = items.filter((item) => item.status !== "as_needed");
  if (scheduled.length === 0) {
    return {
      tone: "as_needed",
      title: "No fixed daily schedule configured",
      detail: "Only as-needed medications are saved on this device."
    };
  }

  const overdueCount = scheduled.filter((item) => item.status === "overdue").length;
  const dueNowCount = scheduled.filter((item) => item.status === "due_now").length;
  const takenCount = scheduled.filter((item) => item.status === "taken").length;

  if (overdueCount > 0) {
    return {
      tone: "overdue",
      title: `${overdueCount} scheduled ${overdueCount === 1 ? "dose is" : "doses are"} overdue`,
      detail: `${takenCount} of ${scheduled.length} scheduled doses logged today. Check the overdue items below before taking or skipping.`
    };
  }

  if (dueNowCount > 0) {
    return {
      tone: "due_now",
      title: `${dueNowCount} scheduled ${dueNowCount === 1 ? "dose is" : "doses are"} due now`,
      detail: `${takenCount} of ${scheduled.length} scheduled doses logged so far today.`
    };
  }

  if (takenCount === scheduled.length) {
    return {
      tone: "taken",
      title: "All scheduled pills taken for today",
      detail: `Completed all ${scheduled.length} of ${scheduled.length} scheduled doses today.`
    };
  }

  return {
    tone: "upcoming",
    title: "Caught up for this time of day",
    detail: `${takenCount} of ${scheduled.length} scheduled doses logged today. Remaining doses are upcoming later today.`
  };
}

export function CaregiverAlertCard(props: CaregiverAlertCardProps) {
  const { profile, lastVerdict = null, lang, onQuickLogDose, now } = props;
  const uid = useId();
  const [contact, setContact] = useState<CaregiverContact>(() => loadCaregiverContact());
  const [feedback, setFeedback] = useState<string>("");
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const announce = (message: string) => {
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedback(message);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback("");
      feedbackTimerRef.current = null;
    }, 3500);
  };

  const effectiveNow = now ?? new Date();
  const scheduleItems = computeDailySchedule(profile, effectiveNow);
  const checkSummary = summarizeCheckAnswer(scheduleItems);
  const summaryVisual = STATUS_VISUALS[checkSummary.tone];

  const links = buildFamilyAlertLinks(profile, {
    contactPhone: contact.phone,
    contactEmail: contact.email,
    lastVerdict,
    now: effectiveNow
  });

  const isWarningVerdict = lastVerdict?.level === "warning";

  const updateContact = (patch: Partial<CaregiverContact>) => {
    const next: CaregiverContact = {
      phone: patch.phone !== undefined ? patch.phone : contact.phone,
      email: patch.email !== undefined ? patch.email : contact.email
    };
    setContact(next);
    saveCaregiverContact(next);
  };

  const handleShareUpdate = async () => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: links.headline,
          text: links.body
        });
        announce("Shared update with family or caregiver.");
        return;
      } catch (err) {
        const isAbort =
          typeof err === "object" &&
          err !== null &&
          "name" in err &&
          (err as { name?: string }).name === "AbortError";
        if (isAbort) {
          announce("Share cancelled.");
          return;
        }
      }
    }

    const copied = await copyTextWithFallback(links.body);
    if (copied) {
      announce("Copied caregiver summary to clipboard.");
    } else {
      announce("Unable to share automatically. Use Send SMS Alert or copy from preview.");
    }
  };

  const handleCopySummary = async () => {
    const copied = await copyTextWithFallback(links.body);
    if (copied) {
      announce("Copied caregiver summary to clipboard.");
    } else {
      announce("Clipboard unavailable in this browser.");
    }
  };

  const headingId = `${uid}-schedule-heading`;
  const phoneInputId = `${uid}-caregiver-phone`;
  const emailInputId = `${uid}-caregiver-email`;

  const actionButtonStyle: CSSProperties = {
    minHeight: "56px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    textDecoration: "none"
  };

  return (
    <section
      className="card caregiver-alert-card"
      lang={lang || "en"}
      aria-labelledby={headingId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
      }}
    >
      <div
        className="sr-only caregiver-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={SR_ONLY_STYLE}
      >
        {feedback}
      </div>

      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2, 8px)"
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
          <h2
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-xl, 1.5rem)",
              fontWeight: 800,
              lineHeight: 1.25
            }}
          >
            Did I Take My Pills? Schedule &amp; Family Share
          </h2>
          <span
            className="pill"
            style={{
              fontWeight: 700,
              fontSize: "var(--text-xs, 0.875rem)"
            }}
          >
            100% On-Device Until Shared
          </span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-secondary, #d8e1ee)",
            lineHeight: 1.45
          }}
        >
          Check your daily medication windows at a glance and optionally send a 1-tap update or safety warning to family or a caregiver.
        </p>
      </header>

      <div
        className={`caregiver-status-banner caregiver-status-${checkSummary.tone}`}
        role="region"
        aria-label="Current time-of-day dose check"
        style={{
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: summaryVisual.bgVar,
          color: summaryVisual.fgVar,
          border: `2px ${summaryVisual.borderStyle} ${summaryVisual.borderVar}`,
          display: "flex",
          flexDirection: "column",
          gap: "4px"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontWeight: 800,
            fontSize: "var(--text-lg, 1.25rem)"
          }}
        >
          <StatusBadgeIcon status={checkSummary.tone} />
          <span>{checkSummary.title}</span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-primary, #f8fafc)",
            lineHeight: 1.4
          }}
        >
          {checkSummary.detail}
        </p>
      </div>

      {isWarningVerdict && (
        <div
          className="caregiver-safety-catch-banner"
          role="alert"
          style={{
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
            color: "var(--verdict-warning-fg, #ffb8ab)",
            border: "3px double var(--verdict-warning-border, #ff6b52)",
            display: "flex",
            flexDirection: "column",
            gap: "6px"
          }}
        >
          <strong style={{ fontSize: "var(--text-base, 1.125rem)", lineHeight: 1.35 }}>
            {links.headline}
          </strong>
          <span style={{ fontSize: "var(--text-sm, 1rem)", color: "var(--text-primary, #f8fafc)" }}>
            Included automatically if you tap Share Update or Send SMS Alert below.
          </span>
        </div>
      )}

      <ul
        className="caregiver-schedule-list"
        aria-label="Today's medication schedule checklist"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)"
        }}
      >
        {scheduleItems.map((item, idx) => {
          const visual = STATUS_VISUALS[item.status];
          const medTitle = formatMedDisplay(item);
          const slotTitle = formatSlotDisplay(item.slot);
          const isTaken = item.status === "taken";
          const countLabel =
            item.status === "as_needed"
              ? `As needed: ${item.takenCountToday} taken today`
              : `${Math.min(item.takenCountToday, item.requiredCountToday)} of ${item.requiredCountToday} taken today`;

          return (
            <li
              key={`${item.med.id}-${item.slot}-${idx}`}
              className={`caregiver-schedule-item status-${item.status}`}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-3, 12px)",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: `1.5px solid ${visual.borderVar}`
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  minWidth: "200px",
                  flex: "1 1 auto"
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
                    className={`badge schedule-badge schedule-badge-${item.status}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 12px",
                      borderRadius: "var(--radius-pill, 9999px)",
                      backgroundColor: visual.bgVar,
                      color: visual.fgVar,
                      border: `2px ${visual.borderStyle} ${visual.borderVar}`,
                      fontWeight: 800,
                      fontSize: "var(--text-xs, 0.875rem)"
                    }}
                  >
                    <StatusBadgeIcon status={item.status} />
                    <span>{visual.badgeLabel}</span>
                  </span>

                  <span
                    className="pill schedule-slot-pill"
                    style={{
                      fontWeight: 700,
                      fontSize: "var(--text-xs, 0.875rem)"
                    }}
                  >
                    {slotTitle}
                  </span>
                </div>

                <div
                  style={{
                    fontWeight: 800,
                    fontSize: "var(--text-lg, 1.25rem)",
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {medTitle}
                </div>

                <div
                  style={{
                    fontSize: "var(--text-sm, 1rem)",
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {countLabel}
                </div>
              </div>

              <button
                type="button"
                className={`btn ${isTaken ? "btn-ghost" : "btn-secondary"} caregiver-quick-log-btn`}
                disabled={isTaken}
                aria-disabled={isTaken}
                aria-label={
                  isTaken
                    ? `${medTitle} (${slotTitle}) already logged today`
                    : `Log dose for ${medTitle} (${slotTitle})`
                }
                onClick={() => {
                  if (!isTaken) {
                    onQuickLogDose(item.med.id);
                    announce(`Logged dose for ${medTitle}.`);
                  }
                }}
                style={{
                  minHeight: "56px",
                  paddingInline: "18px"
                }}
              >
                {isTaken ? "Logged" : "Log Dose"}
              </button>
            </li>
          );
        })}
      </ul>

      <div
        role="group"
        aria-label="Optional local caregiver contact"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "var(--space-3, 12px)",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--bg-elevated, #1a2333)",
          border: "1px solid var(--border-subtle, #2c3a52)"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label
            htmlFor={phoneInputId}
            style={{
              fontWeight: 700,
              fontSize: "var(--text-sm, 1rem)",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            Caregiver Phone (optional, saved on device)
          </label>
          <input
            id={phoneInputId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="input"
            placeholder="+358 40 123 4567"
            value={contact.phone}
            onChange={(event) => updateContact({ phone: event.target.value })}
            style={{ minHeight: "56px" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label
            htmlFor={emailInputId}
            style={{
              fontWeight: 700,
              fontSize: "var(--text-sm, 1rem)",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            Caregiver Email (optional, saved on device)
          </label>
          <input
            id={emailInputId}
            type="email"
            inputMode="email"
            autoComplete="email"
            className="input"
            placeholder="family@example.com"
            value={contact.email}
            onChange={(event) => updateContact({ email: event.target.value })}
            style={{ minHeight: "56px" }}
          />
        </div>
      </div>

      <div
        className="caregiver-share-actions"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        <button
          type="button"
          className="btn btn-primary caregiver-btn-share"
          onClick={() => void handleShareUpdate()}
          style={actionButtonStyle}
        >
          <span>Share Update</span>
        </button>

        <a
          href={links.smsHref}
          className="btn btn-secondary caregiver-btn-sms"
          style={actionButtonStyle}
        >
          <span>Send SMS Alert</span>
        </a>

        <a
          href={links.mailtoHref}
          className="btn btn-secondary caregiver-btn-email"
          style={actionButtonStyle}
        >
          <span>Send Email Alert</span>
        </a>

        <button
          type="button"
          className="btn btn-secondary caregiver-btn-copy"
          onClick={() => void handleCopySummary()}
          style={actionButtonStyle}
        >
          <span>Copy Summary</span>
        </button>
      </div>

      {feedback && (
        <p
          className="caregiver-feedback-banner"
          aria-hidden="true"
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            fontWeight: 700,
            color: "var(--verdict-match-fg, #7ef7c8)"
          }}
        >
          {feedback}
        </p>
      )}

      <details
        className="caregiver-message-preview"
        style={{
          padding: "var(--space-3, 12px) var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--bg-elevated, #1a2333)",
          border: "1px solid var(--border-subtle, #2c3a52)"
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontWeight: 700,
            fontSize: "var(--text-sm, 1rem)",
            minHeight: "44px",
            display: "flex",
            alignItems: "center"
          }}
        >
          Preview Outgoing Family Message
        </summary>
        <pre
          style={{
            marginTop: "var(--space-3, 12px)",
            marginBottom: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "var(--text-xs, 0.875rem)",
            color: "var(--text-secondary, #d8e1ee)",
            lineHeight: 1.45
          }}
        >
          {links.body}
        </pre>
      </details>
    </section>
  );
}

export default CaregiverAlertCard;
