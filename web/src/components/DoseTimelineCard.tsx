import { useId, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { Med, Profile } from "../types.ts";

export type DoseTimelineEntry = {
  medId: string;
  medName: string;
  strength: string;
  ts: number;
  timeLabel: string;
  dayBucket: "today" | "yesterday" | "earlier";
  dateLabel: string;
  duplicateWithinDay: boolean;
};

export type DoseTimelineCardProps = {
  profile: Profile;
  lang: string;
  nowMs?: number;
  onUndoLastDose?: () => void;
};

type DayBucket = DoseTimelineEntry["dayBucket"];
type TimelineTone = "logged" | "duplicate" | "empty";

type LocaleCopy = {
  heading: string;
  subtitle: string;
  privacyBadge: string;
  summaryRegionAria: string;
  listAriaLabel: string;
  emptyState: string;
  undoLastDoseBtn: string;
  undoLastDoseAria: string;
  summaryHeadline: (todayCount: number, weekCount: number) => string;
  todayStatLabel: (count: number) => string;
  weekStatLabel: (count: number) => string;
  summaryDetailEmpty: string;
  summaryDetailNormal: string;
  summaryDetailDuplicate: (dupCount: number) => string;
  dayBuckets: Record<DayBucket, string>;
  statusLogged: string;
  statusDuplicate: string;
  removedMedNote: string;
};

const AS_NEEDED_SLOT_RE =
  /^(as[-_ ]?needed|when[-_ ]?needed|if[-_ ]?needed|prn|optional|tarvittaessa|vid behov)$/i;

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    heading: "7-Day Dose Timeline",
    subtitle: "Chronological local record of taken medications",
    privacyBadge: "Stored on device only",
    summaryRegionAria: "7-day medication adherence summary",
    listAriaLabel: "Chronological 7-day dose log",
    emptyState: "No doses logged in the past 7 days on this device.",
    undoLastDoseBtn: "Undo Last Dose",
    undoLastDoseAria: "Undo the most recently logged dose",
    summaryHeadline: (todayCount, weekCount) =>
      `${todayCount} ${todayCount === 1 ? "dose" : "doses"} today, ${weekCount} in past 7 days`,
    todayStatLabel: (count) => `Today: ${count}`,
    weekStatLabel: (count) => `Past 7 days: ${count}`,
    summaryDetailEmpty: "Log a dose after verifying a label to build your local timeline.",
    summaryDetailNormal: "Newest entries appear first. Data never leaves this device.",
    summaryDetailDuplicate: (dupCount) =>
      `${dupCount} extra same-day ${dupCount === 1 ? "dose" : "doses"} flagged above daily schedule.`,
    dayBuckets: {
      today: "Today",
      yesterday: "Yesterday",
      earlier: "Earlier"
    },
    statusLogged: "Logged",
    statusDuplicate: "Duplicate",
    removedMedNote: "Removed from saved medications"
  },
  fi: {
    heading: "7 päivän annoshistoria",
    subtitle: "Aikajärjestyksessä oleva paikallinen loki otetuista lääkkeistä",
    privacyBadge: "Vain tällä laitteella",
    summaryRegionAria: "7 päivän lääkityksen yhteenveto",
    listAriaLabel: "Aikajärjestyksessä oleva 7 päivän annosloki",
    emptyState: "Ei kirjattuja annoksia viimeisen 7 päivän aikana tällä laitteella.",
    undoLastDoseBtn: "Kumoa viimeisin annos",
    undoLastDoseAria: "Kumoa viimeksi kirjattu lääkeannos",
    summaryHeadline: (todayCount, weekCount) =>
      `${todayCount} ${todayCount === 1 ? "annos" : "annosta"} tänään, ${weekCount} viimeisen 7 päivän aikana`,
    todayStatLabel: (count) => `Tänään: ${count}`,
    weekStatLabel: (count) => `7 päivää: ${count}`,
    summaryDetailEmpty:
      "Kirjaa annos etiketin tarkistuksen jälkeen aloittaaksesi paikallisen seurannan.",
    summaryDetailNormal: "Uusimmat kirjaukset näkyvät ensin. Tiedot eivät poistu laitteelta.",
    summaryDetailDuplicate: (dupCount) =>
      dupCount === 1
        ? "1 ylimääräinen saman päivän annos havaittu aikataulun yli."
        : `${dupCount} ylimääräistä saman päivän annosta havaittu aikataulun yli.`,
    dayBuckets: {
      today: "Tänään",
      yesterday: "Eilen",
      earlier: "Aiemmin"
    },
    statusLogged: "Kirjattu",
    statusDuplicate: "Kaksoisannos",
    removedMedNote: "Poistettu tallennetuista lääkkeistä"
  },
  sv: {
    heading: "7-dagars doshistorik",
    subtitle: "Kronologisk lokal logg över tagna mediciner",
    privacyBadge: "Endast på den här enheten",
    summaryRegionAria: "Sammanfattning av 7 dagars medicinering",
    listAriaLabel: "Kronologisk doslogg för de senaste 7 dagarna",
    emptyState: "Inga doser registrerade under de senaste 7 dagarna på den här enheten.",
    undoLastDoseBtn: "Ångra senaste dos",
    undoLastDoseAria: "Ångra den senast registrerade dosen",
    summaryHeadline: (todayCount, weekCount) =>
      `${todayCount} ${todayCount === 1 ? "dos" : "doser"} idag, ${weekCount} senaste 7 dagarna`,
    todayStatLabel: (count) => `Idag: ${count}`,
    weekStatLabel: (count) => `7 dagar: ${count}`,
    summaryDetailEmpty:
      "Registrera en dos efter etikettkontroll för att bygga din lokala tidslinje.",
    summaryDetailNormal: "Senaste registreringar visas först. Data lämnar aldrig enheten.",
    summaryDetailDuplicate: (dupCount) =>
      dupCount === 1
        ? "1 extra dos samma dag flaggad utöver schemat."
        : `${dupCount} extra doser samma dag flaggade utöver schemat.`,
    dayBuckets: {
      today: "Idag",
      yesterday: "Igår",
      earlier: "Tidigare"
    },
    statusLogged: "Registrerad",
    statusDuplicate: "Dubbeldos",
    removedMedNote: "Borttagen från sparade mediciner"
  }
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localDayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function formatTimelineHhMm(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatTimelineDate(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isAsNeededSlot(rawSlot: string): boolean {
  const trimmed = rawSlot.trim().toLowerCase();
  if (!trimmed || AS_NEEDED_SLOT_RE.test(trimmed)) {
    return true;
  }
  return (
    trimmed.includes("as needed") ||
    trimmed.includes("as_needed") ||
    trimmed.includes("prn") ||
    trimmed.includes("tarvittaessa") ||
    trimmed.includes("vid behov")
  );
}

function countDailyScheduledSlots(med: Med): number {
  const legacyTimes = (med as Med & { times?: unknown }).times;
  const rawSlots =
    Array.isArray(med.schedule) && med.schedule.length > 0
      ? med.schedule
      : Array.isArray(legacyTimes)
        ? legacyTimes
        : [];
  let count = 0;
  for (const item of rawSlots) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0 && !isAsNeededSlot(trimmed)) {
      count += 1;
    }
  }
  return count;
}

type RawCandidate = {
  idx: number;
  medId: string;
  medName: string;
  strength: string;
  ts: number;
  timeLabel: string;
  dayBucket: DayBucket;
  dateLabel: string;
  scheduledCount: number;
  duplicateWithinDay: boolean;
};

export function buildDoseTimeline(
  profile: Profile,
  nowMs?: number,
  maxEntries?: number
): DoseTimelineEntry[] {
  const effectiveNowMs =
    typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowDate = new Date(effectiveNowMs);
  const todayDayNum = localDayIndex(nowDate);

  const medById = new Map<string, Med>();
  const scheduledCountById = new Map<string, number>();
  const meds = Array.isArray(profile?.meds) ? profile.meds : [];

  for (const med of meds) {
    if (!med || typeof med.id !== "string") {
      continue;
    }
    const id = med.id.trim();
    if (!id) {
      continue;
    }
    medById.set(id, med);
    scheduledCountById.set(id, countDailyScheduledSlots(med));
  }

  const rawDoseLog = Array.isArray(profile?.doseLog) ? profile.doseLog : [];
  const candidates: RawCandidate[] = [];

  for (let idx = 0; idx < rawDoseLog.length; idx += 1) {
    const item = rawDoseLog[idx];
    if (
      !item ||
      typeof item.medId !== "string" ||
      typeof item.ts !== "number" ||
      !Number.isFinite(item.ts) ||
      item.ts < 0
    ) {
      continue;
    }
    const medId = item.medId.trim();
    if (!medId) {
      continue;
    }

    const entryDate = new Date(item.ts);
    const dayDiff = todayDayNum - localDayIndex(entryDate);
    if (dayDiff < 0 || dayDiff >= 7) {
      continue;
    }

    const dayBucket: DayBucket =
      dayDiff === 0 ? "today" : dayDiff === 1 ? "yesterday" : "earlier";
    const matched = medById.get(medId);
    const medName = matched
      ? (matched.name ?? "").trim() || (matched.ingredient ?? "").trim() || medId
      : medId;
    const strength =
      matched && typeof matched.strength === "string" ? matched.strength.trim() : "";
    const scheduledCount = scheduledCountById.get(medId) ?? 0;

    candidates.push({
      idx,
      medId,
      medName,
      strength,
      ts: item.ts,
      timeLabel: formatTimelineHhMm(item.ts),
      dayBucket,
      dateLabel: formatTimelineDate(item.ts),
      scheduledCount,
      duplicateWithinDay: false
    });
  }

  const byDayAndMed = new Map<string, RawCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.dateLabel}::${candidate.medId}`;
    const group = byDayAndMed.get(key);
    if (group) {
      group.push(candidate);
    } else {
      byDayAndMed.set(key, [candidate]);
    }
  }

  for (const group of byDayAndMed.values()) {
    const scheduledCount = group[0].scheduledCount;
    if (scheduledCount <= 0 || group.length <= scheduledCount) {
      continue;
    }
    const chronological = [...group].sort((a, b) =>
      a.ts !== b.ts ? a.ts - b.ts : a.idx - b.idx
    );
    for (let i = scheduledCount; i < chronological.length; i += 1) {
      chronological[i].duplicateWithinDay = true;
    }
  }

  candidates.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.idx - a.idx));

  const limited =
    typeof maxEntries === "number" && Number.isFinite(maxEntries)
      ? candidates.slice(0, Math.max(0, Math.floor(maxEntries)))
      : candidates;

  return limited.map((entry) => ({
    medId: entry.medId,
    medName: entry.medName,
    strength: entry.strength,
    ts: entry.ts,
    timeLabel: entry.timeLabel,
    dayBucket: entry.dayBucket,
    dateLabel: entry.dateLabel,
    duplicateWithinDay: entry.duplicateWithinDay
  }));
}

type TonePalette = {
  bgVar: string;
  fgVar: string;
  borderVar: string;
  borderStyle: "solid" | "double" | "dashed";
};

const TONE_PALETTE: Record<TimelineTone, TonePalette> = {
  logged: {
    bgVar: "var(--verdict-match-bg, #06261d)",
    fgVar: "var(--verdict-match-fg, #7ef7c8)",
    borderVar: "var(--verdict-match-border, #2dd4a0)",
    borderStyle: "solid"
  },
  duplicate: {
    bgVar: "var(--verdict-warning-bg, #2d0e0a)",
    fgVar: "var(--verdict-warning-fg, #ffb8ab)",
    borderVar: "var(--verdict-warning-border, #ff6b52)",
    borderStyle: "double"
  },
  empty: {
    bgVar: "var(--verdict-info-bg, #0a1f38)",
    fgVar: "var(--verdict-info-fg, #a6d4ff)",
    borderVar: "var(--verdict-info-border, #4da3ff)",
    borderStyle: "dashed"
  }
};

const ICON_SVG_STYLE: CSSProperties = {
  width: "20px",
  height: "20px",
  flexShrink: 0
};

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const UNDO_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 18px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800
};

function TimelineStatusIcon({ tone }: { tone: TimelineTone }) {
  if (tone === "duplicate") {
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
        data-timeline-icon="duplicate"
        style={ICON_SVG_STYLE}
      >
        <path d="M12 3L22 20H2L12 3z" />
        <line x1="12" y1="9" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (tone === "empty") {
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
        data-timeline-icon="empty"
        style={ICON_SVG_STYLE}
      >
        <circle cx="12" cy="12" r="9.5" />
        <polyline points="12 7 12 12 15.5 14" />
      </svg>
    );
  }

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
      data-timeline-icon="logged"
      style={ICON_SVG_STYLE}
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </svg>
  );
}

function UndoIcon() {
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
      data-timeline-icon="undo"
      style={ICON_SVG_STYLE}
    >
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function countValidDoseEvents(profile: Profile): number {
  const raw = Array.isArray(profile?.doseLog) ? profile.doseLog : [];
  let count = 0;
  for (const item of raw) {
    if (
      item &&
      typeof item.medId === "string" &&
      item.medId.trim().length > 0 &&
      typeof item.ts === "number" &&
      Number.isFinite(item.ts) &&
      item.ts >= 0
    ) {
      count += 1;
    }
  }
  return count;
}

export function DoseTimelineCard(props: DoseTimelineCardProps) {
  const { profile, lang, nowMs, onUndoLastDose } = props;
  const uid = useId();
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const entries = buildDoseTimeline(profile, nowMs);

  const knownMedIds = new Set<string>();
  if (Array.isArray(profile?.meds)) {
    for (const med of profile.meds) {
      if (med && typeof med.id === "string" && med.id.trim().length > 0) {
        knownMedIds.add(med.id.trim());
      }
    }
  }

  const todayCount = entries.filter((entry) => entry.dayBucket === "today").length;
  const weekCount = entries.length;
  const duplicateCount = entries.filter((entry) => entry.duplicateWithinDay).length;
  const totalStoredDoses = countValidDoseEvents(profile);
  const canUndo = totalStoredDoses > 0 && typeof onUndoLastDose === "function";

  const summaryTone: TimelineTone =
    duplicateCount > 0 ? "duplicate" : weekCount > 0 ? "logged" : "empty";
  const summaryPalette = TONE_PALETTE[summaryTone];
  const summaryHeadline = copy.summaryHeadline(todayCount, weekCount);
  const summaryDetail =
    duplicateCount > 0
      ? copy.summaryDetailDuplicate(duplicateCount)
      : weekCount === 0
        ? copy.summaryDetailEmpty
        : copy.summaryDetailNormal;

  const headingId = `${uid}-dose-timeline-heading`;

  return (
    <section
      className="card dose-timeline-card"
      lang={locale}
      aria-labelledby={headingId}
      data-today-count={String(todayCount)}
      data-week-count={String(weekCount)}
      style={CARD_STYLE}
    >
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
            gap: "var(--space-2, 8px)"
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
            {copy.heading}
          </h2>

          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--space-2, 8px)"
            }}
          >
            <span
              className="pill dose-timeline-privacy-pill"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 700
              }}
            >
              {copy.privacyBadge}
            </span>

            {canUndo ? (
              <button
                type="button"
                className="btn btn-secondary dose-timeline-undo-btn"
                data-action="undo-last-dose"
                aria-label={copy.undoLastDoseAria}
                onClick={() => onUndoLastDose?.()}
                style={UNDO_BUTTON_STYLE}
              >
                <UndoIcon />
                <span>{copy.undoLastDoseBtn}</span>
              </button>
            ) : null}
          </div>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-secondary, #d8e1ee)",
            lineHeight: 1.4
          }}
        >
          {copy.subtitle}
        </p>
      </header>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={copy.summaryRegionAria}
        className={`dose-timeline-summary dose-timeline-summary-${summaryTone}`}
        data-summary-tone={summaryTone}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: summaryPalette.bgVar,
          color: summaryPalette.fgVar,
          border: `2px ${summaryPalette.borderStyle} ${summaryPalette.borderVar}`
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
              alignItems: "center",
              gap: "8px",
              fontWeight: 800,
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.3
            }}
          >
            <TimelineStatusIcon tone={summaryTone} />
            <span>{summaryHeadline}</span>
          </div>

          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <span
              className="pill dose-timeline-stat-today"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums"
              }}
            >
              {copy.todayStatLabel(todayCount)}
            </span>

            <span
              className="pill dose-timeline-stat-week"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums"
              }}
            >
              {copy.weekStatLabel(weekCount)}
            </span>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-primary, #f8fafc)",
            lineHeight: 1.4
          }}
        >
          {summaryDetail}
        </p>
      </div>

      {entries.length === 0 ? (
        <p
          className="dose-timeline-empty"
          style={{
            margin: 0,
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            color: "var(--text-secondary, #d8e1ee)",
            fontSize: "var(--text-sm, 1rem)"
          }}
        >
          {copy.emptyState}
        </p>
      ) : (
        <ol
          className="dose-timeline-list"
          aria-label={copy.listAriaLabel}
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3, 12px)"
          }}
        >
          {entries.map((entry, idx) => {
            const rowTone: TimelineTone = entry.duplicateWithinDay ? "duplicate" : "logged";
            const palette = TONE_PALETTE[rowTone];
            const statusText = entry.duplicateWithinDay
              ? copy.statusDuplicate
              : copy.statusLogged;
            const medTitle = entry.strength
              ? `${entry.medName} ${entry.strength}`
              : entry.medName;
            const isDeletedMed = !knownMedIds.has(entry.medId);

            return (
              <li
                key={`${entry.medId}-${entry.ts}-${idx}`}
                className={`dose-timeline-row dose-timeline-row-${rowTone}`}
                data-med-id={entry.medId}
                data-day-bucket={entry.dayBucket}
                data-duplicate={String(entry.duplicateWithinDay)}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-3, 12px)",
                  padding: "var(--space-4, 16px)",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  border: `2px ${palette.borderStyle} ${palette.borderVar}`
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    minWidth: "210px",
                    flex: "1 1 240px"
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
                      className={`badge dose-timeline-status-badge dose-timeline-status-${rowTone}`}
                      data-status-icon={rowTone}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        minHeight: "34px",
                        padding: "5px 12px",
                        borderRadius: "var(--radius-pill, 9999px)",
                        backgroundColor: palette.bgVar,
                        color: palette.fgVar,
                        border: `2px ${palette.borderStyle} ${palette.borderVar}`,
                        fontWeight: 800,
                        fontSize: "var(--text-xs, 0.875rem)"
                      }}
                    >
                      <TimelineStatusIcon tone={rowTone} />
                      <span>{statusText}</span>
                    </span>

                    <span
                      className="pill dose-timeline-bucket-pill"
                      data-bucket={entry.dayBucket}
                      style={{
                        fontWeight: 700,
                        fontSize: "var(--text-xs, 0.875rem)"
                      }}
                    >
                      {copy.dayBuckets[entry.dayBucket]}
                    </span>

                    <span
                      className="dose-timeline-date"
                      style={{
                        fontWeight: 700,
                        fontSize: "var(--text-xs, 0.875rem)",
                        color: "var(--text-secondary, #d8e1ee)",
                        fontVariantNumeric: "tabular-nums"
                      }}
                    >
                      {entry.dateLabel}
                    </span>
                  </div>

                  <div
                    className="dose-timeline-med-title"
                    style={{
                      fontWeight: 800,
                      fontSize: "var(--text-lg, 1.25rem)",
                      color: "var(--text-primary, #f8fafc)",
                      lineHeight: 1.25
                    }}
                  >
                    {medTitle}
                  </div>

                  {isDeletedMed ? (
                    <div
                      className="dose-timeline-removed-note"
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {copy.removedMedNote}
                    </div>
                  ) : null}
                </div>

                <time
                  className="dose-timeline-time"
                  dateTime={`${entry.dateLabel}T${entry.timeLabel}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: "40px",
                    padding: "6px 14px",
                    borderRadius: "var(--radius-md, 12px)",
                    backgroundColor: "var(--bg-surface, #121926)",
                    border: "1.5px solid var(--border-subtle, #2c3a52)",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-lg, 1.25rem)",
                    fontWeight: 800,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {entry.timeLabel}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default DoseTimelineCard;
