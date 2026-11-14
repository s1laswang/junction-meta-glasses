import React, { useId, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { Med, Profile } from "../types.ts";

export type ScheduleSlot = "morning" | "noon" | "evening" | "bedtime" | "as_needed";

export type MedAdherenceItem = {
  med: Med;
  slot: ScheduleSlot;
  requiredToday: number;
  takenToday: number;
  lastTakenTs: number | null;
  status: "complete" | "due" | "optional";
};

export type DailyScheduleChecklist = {
  currentSlot: ScheduleSlot;
  items: MedAdherenceItem[];
  completedRequired: number;
  totalRequired: number;
};

export type ScheduleChecklistCardProps = {
  profile: Profile;
  lang: string;
  nowMs?: number;
  onVerifyMed?: (med: Med) => void;
  onLogDose?: (medId: string) => void;
};

type AdherenceStatus = MedAdherenceItem["status"];
type IconKind = "check" | "clock" | "optional";

type LocaleCopy = {
  heading: string;
  subtitle: string;
  privacyBadge: string;
  summaryRegionAria: string;
  listAriaLabel: string;
  emptyState: string;
  checkLabelBtn: string;
  checkLabelAria: (medTitle: string) => string;
  logTakenBtn: string;
  logTakenAria: (medTitle: string) => string;
  loggedDoneBtn: string;
  loggedDoneAria: (medTitle: string) => string;
  summaryText: (completed: number, total: number) => string;
  summaryDetailAllDone: string;
  summaryDetailDue: (remaining: number) => string;
  summaryDetailNoScheduled: string;
  windowBadges: Record<ScheduleSlot, string>;
  slotLabels: Record<ScheduleSlot, string>;
  statusBadges: Record<AdherenceStatus, string>;
  doseProgressScheduled: (taken: number, required: number) => string;
  doseProgressOptional: (taken: number) => string;
  lastTakenAt: (hhmm: string) => string;
  notLoggedToday: string;
};

const SLOT_ORDER: Record<ScheduleSlot, number> = {
  morning: 0,
  noon: 1,
  evening: 2,
  bedtime: 3,
  as_needed: 4
};

const AS_NEEDED_RE = /^(as[-_ ]?needed|when[-_ ]?needed|if[-_ ]?needed|prn|optional|tarvittaessa|vid behov)$/i;
const HH_MM_RE = /^(\d{1,2}):(\d{2})$/;

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    heading: "Did I Take My Pills?",
    subtitle: "Daily medication checklist and current dose window",
    privacyBadge: "Stored on device only",
    summaryRegionAria: "Daily medication adherence summary",
    listAriaLabel: "Daily medication adherence checklist",
    emptyState: "No medications saved on this device yet.",
    checkLabelBtn: "Check Label",
    checkLabelAria: (medTitle) => `Check Label for ${medTitle}`,
    logTakenBtn: "Log Taken",
    logTakenAria: (medTitle) => `Log Taken for ${medTitle}`,
    loggedDoneBtn: "Dose Logged",
    loggedDoneAria: (medTitle) => `${medTitle} already logged for today`,
    summaryText: (completed, total) => `${completed} of ${total} scheduled doses logged today`,
    summaryDetailAllDone: "All scheduled pills complete for today.",
    summaryDetailDue: (remaining) =>
      `${remaining} scheduled ${remaining === 1 ? "dose" : "doses"} still due today.`,
    summaryDetailNoScheduled: "No fixed daily doses scheduled.",
    windowBadges: {
      morning: "Morning window",
      noon: "Noon window",
      evening: "Evening window",
      bedtime: "Bedtime window",
      as_needed: "As-needed window"
    },
    slotLabels: {
      morning: "Morning",
      noon: "Noon",
      evening: "Evening",
      bedtime: "Bedtime",
      as_needed: "As needed"
    },
    statusBadges: {
      complete: "Complete",
      due: "Due",
      optional: "Optional"
    },
    doseProgressScheduled: (taken, required) => `${taken}/${required} doses today`,
    doseProgressOptional: (taken) => `PRN: ${taken} logged today`,
    lastTakenAt: (hhmm) => `Last taken ${hhmm}`,
    notLoggedToday: "Not taken today"
  },
  fi: {
    heading: "Otinko lääkkeeni tänään?",
    subtitle: "Päivän lääkelista ja nykyinen ottoaika",
    privacyBadge: "Vain tällä laitteella",
    summaryRegionAria: "Päivän lääkityksen yhteenveto",
    listAriaLabel: "Päivittäinen lääkkeiden tarkistuslista",
    emptyState: "Tälle laitteelle ei ole vielä tallennettu lääkkeitä.",
    checkLabelBtn: "Tarkista etiketti",
    checkLabelAria: (medTitle) => `Tarkista etiketti: ${medTitle}`,
    logTakenBtn: "Kirjaa otetuksi",
    logTakenAria: (medTitle) => `Kirjaa otetuksi: ${medTitle}`,
    loggedDoneBtn: "Annos kirjattu",
    loggedDoneAria: (medTitle) => `${medTitle} on jo kirjattu tälle päivälle`,
    summaryText: (completed, total) => `${completed} / ${total} säännöllistä annosta kirjattu tänään`,
    summaryDetailAllDone: "Kaikki päivän säännölliset lääkkeet on otettu.",
    summaryDetailDue: (remaining) =>
      remaining === 1
        ? "1 säännöllinen annos vielä ottamatta tänään."
        : `${remaining} säännöllistä annosta vielä ottamatta tänään.`,
    summaryDetailNoScheduled: "Ei kiinteitä päivittäisiä annoksia.",
    windowBadges: {
      morning: "Aamuikkuna",
      noon: "Päiväikkuna",
      evening: "Iltaikkuna",
      bedtime: "Yöikkuna",
      as_needed: "Tarvittaessa"
    },
    slotLabels: {
      morning: "Aamu",
      noon: "Päivä",
      evening: "Ilta",
      bedtime: "Yö",
      as_needed: "Tarvittaessa"
    },
    statusBadges: {
      complete: "Otettu",
      due: "Ottamatta",
      optional: "Tarvittaessa"
    },
    doseProgressScheduled: (taken, required) => `${taken}/${required} annosta tänään`,
    doseProgressOptional: (taken) => `Tarvittaessa: ${taken} kirjattu tänään`,
    lastTakenAt: (hhmm) => `Viimeksi otettu ${hhmm}`,
    notLoggedToday: "Ei otettu tänään"
  },
  sv: {
    heading: "Tog jag mina mediciner idag?",
    subtitle: "Daglig medicinlista och aktuellt tidsfönster",
    privacyBadge: "Endast på den här enheten",
    summaryRegionAria: "Sammanfattning av dagens medicinering",
    listAriaLabel: "Daglig checklista för medicinering",
    emptyState: "Inga mediciner sparade på den här enheten ännu.",
    checkLabelBtn: "Kontrollera etikett",
    checkLabelAria: (medTitle) => `Kontrollera etikett för ${medTitle}`,
    logTakenBtn: "Registrera tagen",
    logTakenAria: (medTitle) => `Registrera tagen dos för ${medTitle}`,
    loggedDoneBtn: "Dos registrerad",
    loggedDoneAria: (medTitle) => `${medTitle} är redan registrerad idag`,
    summaryText: (completed, total) => `${completed} av ${total} schemalagda doser registrerade idag`,
    summaryDetailAllDone: "Alla schemalagda mediciner är tagna för idag.",
    summaryDetailDue: (remaining) =>
      remaining === 1
        ? "1 schemalagd dos kvar idag."
        : `${remaining} schemalagda doser kvar idag.`,
    summaryDetailNoScheduled: "Inga fasta dagliga doser schemalagda.",
    windowBadges: {
      morning: "Morgonfönster",
      noon: "Lunchfönster",
      evening: "Kvällsfönster",
      bedtime: "Nattfönster",
      as_needed: "Vid behov"
    },
    slotLabels: {
      morning: "Morgon",
      noon: "Lunch",
      evening: "Kväll",
      bedtime: "Natt",
      as_needed: "Vid behov"
    },
    statusBadges: {
      complete: "Klar",
      due: "Att ta",
      optional: "Valfri"
    },
    doseProgressScheduled: (taken, required) => `${taken}/${required} doser idag`,
    doseProgressOptional: (taken) => `Vid behov: ${taken} registrerade idag`,
    lastTakenAt: (hhmm) => `Senast tagen ${hhmm}`,
    notLoggedToday: "Inte tagen idag"
  }
};

export function resolveSlotForLocalHour(hour: number): ScheduleSlot {
  const normalized = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 0;
  if (normalized >= 5 && normalized <= 10) {
    return "morning";
  }
  if (normalized >= 11 && normalized <= 15) {
    return "noon";
  }
  if (normalized >= 16 && normalized <= 21) {
    return "evening";
  }
  return "bedtime";
}

export function normalizeScheduleSlot(raw: string): ScheduleSlot {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || AS_NEEDED_RE.test(trimmed)) {
    return "as_needed";
  }
  if (
    trimmed.includes("as needed") ||
    trimmed.includes("as_needed") ||
    trimmed.includes("prn") ||
    trimmed.includes("tarvittaessa") ||
    trimmed.includes("vid behov")
  ) {
    return "as_needed";
  }
  if (
    trimmed.includes("morning") ||
    trimmed.includes("breakfast") ||
    trimmed === "am" ||
    trimmed.includes("aamu") ||
    trimmed.includes("morgon")
  ) {
    return "morning";
  }
  if (
    trimmed.includes("noon") ||
    trimmed.includes("midday") ||
    trimmed.includes("mid-day") ||
    trimmed.includes("lunch") ||
    trimmed.includes("afternoon") ||
    trimmed.includes("päivä") ||
    trimmed.includes("paiva") ||
    trimmed.includes("middag") ||
    trimmed.includes("eftermiddag")
  ) {
    return "noon";
  }
  if (
    trimmed.includes("evening") ||
    trimmed.includes("dinner") ||
    trimmed.includes("supper") ||
    trimmed === "pm" ||
    trimmed.includes("ilta") ||
    trimmed.includes("kväll") ||
    trimmed.includes("kvall")
  ) {
    return "evening";
  }
  if (
    trimmed.includes("bedtime") ||
    trimmed.includes("bed") ||
    trimmed.includes("night") ||
    trimmed.includes("tonight") ||
    trimmed === "hs" ||
    trimmed.includes("yö") ||
    trimmed === "yo" ||
    trimmed.includes("natt")
  ) {
    return "bedtime";
  }
  const timeMatch = HH_MM_RE.exec(trimmed);
  if (timeMatch) {
    const parsedHour = Math.min(23, Math.max(0, Number.parseInt(timeMatch[1], 10)));
    return resolveSlotForLocalHour(parsedHour);
  }
  return "morning";
}

export function formatLocalHhMm(ts: number): string {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function extractRawMedSlots(med: Med): string[] {
  const legacyTimes = (med as Med & { times?: unknown }).times;
  const sourceList =
    Array.isArray(med.schedule) && med.schedule.length > 0
      ? med.schedule
      : Array.isArray(legacyTimes)
        ? legacyTimes
        : [];
  return sourceList
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractMedDisplaySlots(med: Med): ScheduleSlot[] {
  const rawSlots = extractRawMedSlots(med);
  if (rawSlots.length === 0) {
    return ["as_needed"];
  }
  const mapped = rawSlots.map(normalizeScheduleSlot);
  const scheduled = mapped
    .filter((slot): slot is Exclude<ScheduleSlot, "as_needed"> => slot !== "as_needed")
    .sort((a, b) => SLOT_ORDER[a] - SLOT_ORDER[b]);
  if (scheduled.length === 0) {
    return ["as_needed"];
  }
  const unique: ScheduleSlot[] = [];
  for (const slot of scheduled) {
    if (!unique.includes(slot)) {
      unique.push(slot);
    }
  }
  return unique;
}

export function buildDailyScheduleChecklist(
  profile: Profile,
  nowMs?: number
): DailyScheduleChecklist {
  const effectiveNowMs =
    typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowDate = new Date(effectiveNowMs);
  const currentSlot = resolveSlotForLocalHour(nowDate.getHours());

  const startOfDay = new Date(nowDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(nowDate);
  endOfDay.setHours(23, 59, 59, 999);
  const startMs = startOfDay.getTime();
  const endMs = endOfDay.getTime();

  const statsByMed = new Map<string, { count: number; lastTs: number | null }>();
  const rawDoseLog = Array.isArray(profile?.doseLog) ? profile.doseLog : [];

  for (const entry of rawDoseLog) {
    if (
      !entry ||
      typeof entry.medId !== "string" ||
      typeof entry.ts !== "number" ||
      !Number.isFinite(entry.ts)
    ) {
      continue;
    }
    if (entry.ts < startMs || entry.ts > endMs) {
      continue;
    }
    const medId = entry.medId.trim();
    if (!medId) {
      continue;
    }
    const prev = statsByMed.get(medId);
    if (!prev) {
      statsByMed.set(medId, { count: 1, lastTs: entry.ts });
    } else {
      statsByMed.set(medId, {
        count: prev.count + 1,
        lastTs: prev.lastTs === null || entry.ts > prev.lastTs ? entry.ts : prev.lastTs
      });
    }
  }

  const meds = Array.isArray(profile?.meds) ? profile.meds : [];
  const items: MedAdherenceItem[] = [];
  let completedRequired = 0;
  let totalRequired = 0;

  for (const med of meds) {
    const rawSlots = extractRawMedSlots(med);
    const mappedSlots = rawSlots.length > 0 ? rawSlots.map(normalizeScheduleSlot) : ["as_needed" as const];
    const scheduledSlots = mappedSlots
      .filter((slot): slot is Exclude<ScheduleSlot, "as_needed"> => slot !== "as_needed")
      .sort((a, b) => SLOT_ORDER[a] - SLOT_ORDER[b]);

    const medStats = statsByMed.get(med.id.trim()) ?? { count: 0, lastTs: null };
    const takenToday = medStats.count;
    const lastTakenTs = medStats.lastTs;

    if (scheduledSlots.length === 0) {
      items.push({
        med,
        slot: "as_needed",
        requiredToday: 0,
        takenToday,
        lastTakenTs,
        status: takenToday > 0 ? "complete" : "optional"
      });
      continue;
    }

    const requiredToday = scheduledSlots.length;
    const status: AdherenceStatus = takenToday >= requiredToday ? "complete" : "due";
    let slot: ScheduleSlot;

    if (takenToday < requiredToday) {
      const remainingSlots = scheduledSlots.slice(takenToday);
      slot = remainingSlots.includes(currentSlot as Exclude<ScheduleSlot, "as_needed">)
        ? currentSlot
        : remainingSlots[0];
    } else {
      slot = scheduledSlots.includes(currentSlot as Exclude<ScheduleSlot, "as_needed">)
        ? currentSlot
        : scheduledSlots[scheduledSlots.length - 1];
    }

    totalRequired += requiredToday;
    completedRequired += Math.min(takenToday, requiredToday);

    items.push({
      med,
      slot,
      requiredToday,
      takenToday,
      lastTakenTs,
      status
    });
  }

  return {
    currentSlot,
    items,
    completedRequired,
    totalRequired
  };
}

function formatMedTitle(med: Med): string {
  const strength = med.strength.trim();
  return strength ? `${med.name} ${strength}` : med.name;
}

function statusToIconKind(status: AdherenceStatus): IconKind {
  if (status === "complete") {
    return "check";
  }
  if (status === "due") {
    return "clock";
  }
  return "optional";
}

type StatusPalette = {
  bgVar: string;
  fgVar: string;
  borderVar: string;
  borderStyle: "solid" | "dashed";
};

const STATUS_PALETTE: Record<AdherenceStatus, StatusPalette> = {
  complete: {
    bgVar: "var(--verdict-match-bg, #06261d)",
    fgVar: "var(--verdict-match-fg, #7ef7c8)",
    borderVar: "var(--verdict-match-border, #2dd4a0)",
    borderStyle: "solid"
  },
  due: {
    bgVar: "var(--verdict-unsure-bg, #261b04)",
    fgVar: "var(--verdict-unsure-fg, #ffe169)",
    borderVar: "var(--verdict-unsure-border, #f5b82e)",
    borderStyle: "solid"
  },
  optional: {
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

const ACTION_BUTTON_STYLE: CSSProperties = {
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

function AdherenceGeometricIcon({ status }: { status: AdherenceStatus }) {
  const iconKind = statusToIconKind(status);

  if (iconKind === "check") {
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
        data-schedule-icon="check"
        style={ICON_SVG_STYLE}
      >
        <circle cx="12" cy="12" r="9.5" />
        <path d="M8 12.5l2.8 2.8L16.5 9.5" />
      </svg>
    );
  }

  if (iconKind === "clock") {
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
        data-schedule-icon="clock"
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
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-schedule-icon="optional"
      style={ICON_SVG_STYLE}
    >
      <polygon points="12 2.5 21.5 12 12 21.5 2.5 12 12 2.5" />
      <line x1="12" y1="8.5" x2="12" y2="15.5" />
      <line x1="8.5" y1="12" x2="15.5" y2="12" />
    </svg>
  );
}

export function ScheduleChecklistCard(props: ScheduleChecklistCardProps) {
  const { profile, lang, nowMs, onVerifyMed, onLogDose } = props;
  const uid = useId();
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const checklist = buildDailyScheduleChecklist(profile, nowMs);

  const headingId = `${uid}-schedule-checklist-heading`;
  const summaryTone: AdherenceStatus =
    checklist.totalRequired === 0
      ? "optional"
      : checklist.completedRequired >= checklist.totalRequired
        ? "complete"
        : "due";
  const summaryPalette = STATUS_PALETTE[summaryTone];
  const remainingScheduled = Math.max(0, checklist.totalRequired - checklist.completedRequired);
  const summaryHeadline = copy.summaryText(checklist.completedRequired, checklist.totalRequired);
  const summaryDetail =
    checklist.totalRequired === 0
      ? copy.summaryDetailNoScheduled
      : remainingScheduled === 0
        ? copy.summaryDetailAllDone
        : copy.summaryDetailDue(remainingScheduled);

  const hasVerifyHandler = typeof onVerifyMed === "function";
  const hasLogHandler = typeof onLogDose === "function";

  return (
    <section
      className="card schedule-checklist-card"
      lang={locale}
      aria-labelledby={headingId}
      data-current-slot={checklist.currentSlot}
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
              className="badge schedule-window-badge"
              data-window-slot={checklist.currentSlot}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                minHeight: "34px",
                padding: "6px 12px",
                borderRadius: "var(--radius-pill, 9999px)",
                backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                color: "var(--verdict-info-fg, #a6d4ff)",
                border: "2px solid var(--verdict-info-border, #4da3ff)",
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800
              }}
            >
              {copy.windowBadges[checklist.currentSlot]}
            </span>

            <span
              className="pill schedule-privacy-pill"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 700
              }}
            >
              {copy.privacyBadge}
            </span>
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
        className={`schedule-adherence-summary schedule-summary-${summaryTone}`}
        data-summary-status={summaryTone}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
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
            alignItems: "center",
            gap: "8px",
            fontWeight: 800,
            fontSize: "var(--text-lg, 1.25rem)",
            lineHeight: 1.3
          }}
        >
          <AdherenceGeometricIcon status={summaryTone} />
          <span>{summaryHeadline}</span>
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

      {checklist.items.length === 0 ? (
        <p
          className="schedule-checklist-empty"
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
        <ul
          className="schedule-checklist-list"
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
          {checklist.items.map((item) => {
            const palette = STATUS_PALETTE[item.status];
            const iconKind = statusToIconKind(item.status);
            const medTitle = formatMedTitle(item.med);
            const displaySlots = extractMedDisplaySlots(item.med);
            const slotSummary = displaySlots.map((slot) => copy.slotLabels[slot]).join(", ");
            const progressLabel =
              item.requiredToday > 0
                ? copy.doseProgressScheduled(item.takenToday, item.requiredToday)
                : copy.doseProgressOptional(item.takenToday);
            const formattedLastTaken =
              item.lastTakenTs !== null ? formatLocalHhMm(item.lastTakenTs) : null;
            const isScheduledComplete =
              item.requiredToday > 0 && item.takenToday >= item.requiredToday;

            return (
              <li
                key={item.med.id}
                className={`schedule-checklist-row schedule-row-${item.status}`}
                data-med-id={item.med.id}
                data-adherence-status={item.status}
                data-adherence-slot={item.slot}
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
                      className={`badge schedule-status-badge schedule-status-${item.status}`}
                      data-status-icon={iconKind}
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
                      <AdherenceGeometricIcon status={item.status} />
                      <span>{copy.statusBadges[item.status]}</span>
                    </span>

                    <span
                      className="pill schedule-med-slot"
                      style={{
                        fontWeight: 700,
                        fontSize: "var(--text-xs, 0.875rem)"
                      }}
                    >
                      {slotSummary}
                    </span>

                    <span
                      className="schedule-dose-progress"
                      style={{
                        fontWeight: 700,
                        fontSize: "var(--text-xs, 0.875rem)",
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {progressLabel}
                    </span>
                  </div>

                  <div
                    className="schedule-med-title"
                    style={{
                      fontWeight: 800,
                      fontSize: "var(--text-lg, 1.25rem)",
                      color: "var(--text-primary, #f8fafc)",
                      lineHeight: 1.25
                    }}
                  >
                    {medTitle}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "10px",
                      fontSize: "var(--text-sm, 1rem)",
                      color: "var(--text-secondary, #d8e1ee)"
                    }}
                  >
                    {formattedLastTaken !== null ? (
                      <span className="schedule-last-taken" data-last-taken={formattedLastTaken}>
                        <time dateTime={formattedLastTaken}>
                          {copy.lastTakenAt(formattedLastTaken)}
                        </time>
                      </span>
                    ) : (
                      <span className="schedule-last-taken">{copy.notLoggedToday}</span>
                    )}

                    {item.med.notes ? (
                      <span className="schedule-med-notes">{item.med.notes}</span>
                    ) : null}
                  </div>
                </div>

                {hasVerifyHandler || hasLogHandler ? (
                  <div
                    className="schedule-row-actions"
                    style={{
                      display: "inline-flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "var(--space-2, 8px)"
                    }}
                  >
                    {hasVerifyHandler ? (
                      <button
                        type="button"
                        className="btn btn-secondary schedule-verify-btn"
                        data-action="verify-med"
                        data-med-id={item.med.id}
                        aria-label={copy.checkLabelAria(medTitle)}
                        onClick={() => onVerifyMed?.(item.med)}
                        style={ACTION_BUTTON_STYLE}
                      >
                        <span>{copy.checkLabelBtn}</span>
                      </button>
                    ) : null}

                    {hasLogHandler ? (
                      <button
                        type="button"
                        className={`btn ${isScheduledComplete ? "btn-ghost" : "btn-primary"} schedule-log-btn`}
                        data-action="log-dose"
                        data-med-id={item.med.id}
                        disabled={isScheduledComplete}
                        aria-disabled={isScheduledComplete}
                        aria-label={
                          isScheduledComplete
                            ? copy.loggedDoneAria(medTitle)
                            : copy.logTakenAria(medTitle)
                        }
                        onClick={() => {
                          if (!isScheduledComplete) {
                            onLogDose?.(item.med.id);
                          }
                        }}
                        style={ACTION_BUTTON_STYLE}
                      >
                        <span>{isScheduledComplete ? copy.loggedDoneBtn : copy.logTakenBtn}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default ScheduleChecklistCard;
