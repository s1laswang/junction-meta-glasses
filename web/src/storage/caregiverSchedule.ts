import type { Med, Profile, Verdict } from "../types.ts";

export type DoseWindowStatus = "taken" | "due_now" | "overdue" | "upcoming" | "as_needed";

export type MedScheduleItem = {
  med: Med;
  slot: string;
  status: DoseWindowStatus;
  takenCountToday: number;
  requiredCountToday: number;
};

export type FamilyAlertOptions = {
  contactPhone?: string;
  contactEmail?: string;
  lastVerdict?: Verdict | null;
  now?: Date;
};

export type FamilyAlertLinks = {
  headline: string;
  body: string;
  smsHref: string;
  mailtoHref: string;
};

export type CaregiverContact = {
  phone: string;
  email: string;
};

export const CAREGIVER_CONTACT_KEY = "holdup.caregiver";

type SlotSpec =
  | { kind: "as_needed" }
  | { kind: "scheduled"; startHour: number; endHour: number };

const AS_NEEDED_RE = /^(as[- ]needed|when[- ]needed|if[- ]needed|prn|tarvittaessa|vid behov)$/i;
const HH_MM_RE = /^(\d{1,2}):(\d{2})$/;

function parseSlotSpec(rawSlot: string): SlotSpec {
  const trimmed = rawSlot.trim();
  if (!trimmed || AS_NEEDED_RE.test(trimmed)) {
    return { kind: "as_needed" };
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("morning") ||
    lower.includes("breakfast") ||
    lower.includes("aamu") ||
    lower.includes("morgon")
  ) {
    return { kind: "scheduled", startHour: 6, endHour: 11 };
  }

  if (
    lower.includes("noon") ||
    lower.includes("midday") ||
    lower.includes("lunch") ||
    lower.includes("päivä") ||
    lower.includes("paiva") ||
    lower.includes("middag")
  ) {
    return { kind: "scheduled", startHour: 11, endHour: 15 };
  }

  if (
    lower.includes("evening") ||
    lower.includes("dinner") ||
    lower.includes("supper") ||
    lower.includes("ilta") ||
    lower.includes("kväll") ||
    lower.includes("kvall")
  ) {
    return { kind: "scheduled", startHour: 17, endHour: 22 };
  }

  if (
    lower.includes("bedtime") ||
    lower.includes("bed") ||
    lower.includes("night") ||
    lower.includes("yö") ||
    lower.includes("yo") ||
    lower.includes("natt")
  ) {
    return { kind: "scheduled", startHour: 20, endHour: 23 };
  }

  if (lower.includes("afternoon") || lower.includes("iltapäivä") || lower.includes("eftermiddag")) {
    return { kind: "scheduled", startHour: 12, endHour: 16 };
  }

  const timeMatch = HH_MM_RE.exec(lower);
  if (timeMatch) {
    const hour = Math.min(23, Math.max(0, Number(timeMatch[1])));
    return {
      kind: "scheduled",
      startHour: Math.max(0, hour - 2),
      endHour: Math.min(23, hour + 2)
    };
  }

  return { kind: "scheduled", startHour: 8, endHour: 21 };
}

function countTodaysDosesByMed(profile: Profile, now: Date): Map<string, number> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const startMs = startOfDay.getTime();
  const endMs = endOfDay.getTime();

  const counts = new Map<string, number>();
  const log = Array.isArray(profile.doseLog) ? profile.doseLog : [];
  for (const entry of log) {
    if (!entry || typeof entry.medId !== "string" || typeof entry.ts !== "number") {
      continue;
    }
    if (!Number.isFinite(entry.ts) || entry.ts < startMs || entry.ts > endMs) {
      continue;
    }
    const id = entry.medId.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function computeDailySchedule(profile: Profile, now: Date = new Date()): MedScheduleItem[] {
  const counts = countTodaysDosesByMed(profile, now);
  const currentHour = now.getHours();
  const meds = Array.isArray(profile.meds) ? profile.meds : [];
  const items: MedScheduleItem[] = [];

  for (const med of meds) {
    const cleanedSlots = (Array.isArray(med.schedule) ? med.schedule : [])
      .map((slot) => slot.trim())
      .filter((slot) => slot.length > 0);
    const effectiveSlots = cleanedSlots.length > 0 ? cleanedSlots : ["as needed"];

    const parsed = effectiveSlots.map((slot, index) => ({
      slot,
      index,
      spec: parseSlotSpec(slot)
    }));

    const scheduledEntries = parsed
      .filter((entry): entry is { slot: string; index: number; spec: { kind: "scheduled"; startHour: number; endHour: number } } =>
        entry.spec.kind === "scheduled"
      )
      .sort((a, b) => a.spec.startHour - b.spec.startHour || a.index - b.index);

    const rankByIndex = new Map<number, number>();
    scheduledEntries.forEach((entry, rank) => {
      rankByIndex.set(entry.index, rank);
    });

    const requiredCountToday = scheduledEntries.length;
    const takenCountToday = counts.get(med.id) ?? 0;

    for (const entry of parsed) {
      if (entry.spec.kind === "as_needed") {
        items.push({
          med,
          slot: entry.slot,
          status: "as_needed",
          takenCountToday,
          requiredCountToday
        });
        continue;
      }

      const rank = rankByIndex.get(entry.index) ?? 0;
      let status: DoseWindowStatus;
      if (takenCountToday > rank) {
        status = "taken";
      } else if (currentHour < entry.spec.startHour) {
        status = "upcoming";
      } else if (currentHour <= entry.spec.endHour) {
        status = "due_now";
      } else {
        status = "overdue";
      }

      items.push({
        med,
        slot: entry.slot,
        status,
        takenCountToday,
        requiredCountToday
      });
    }
  }

  return items;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateIsoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function capitalizeFirst(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function normalizeStrengthSpacing(strength: string): string {
  return strength.trim().replace(/(\d)\s*(mg|g|mcg|ug|ml|iu|%)\b/gi, "$1 $2");
}

function formatMedLabel(med: Med): string {
  const strength = med.strength.trim();
  return strength ? `${med.name} ${strength}` : med.name;
}

function formatItemEntry(item: MedScheduleItem): string {
  return `${formatMedLabel(item.med)} (${item.slot})`;
}

function extractWarningItemLabel(verdict: Verdict): string {
  const productRaw = verdict.read?.product?.value?.trim() ?? "";
  const ingredientRaw = verdict.read?.ingredient?.value?.trim() ?? "";
  const strengthRaw = verdict.read?.strength?.value ? normalizeStrengthSpacing(verdict.read.strength.value) : "";

  let base = "";
  if (productRaw) {
    base = productRaw;
  } else if (ingredientRaw) {
    base = capitalizeFirst(ingredientRaw.split(",")[0].trim());
  } else {
    base = verdict.headline.replace(/^warning:\s*/i, "").split(":")[0].trim();
  }

  if (!base) {
    base = "Medication";
  }

  if (strengthRaw) {
    const compactBase = base.toLowerCase().replace(/\s+/g, "");
    const compactStrength = strengthRaw.toLowerCase().replace(/\s+/g, "");
    if (!compactBase.includes(compactStrength)) {
      return `${base} ${strengthRaw}`;
    }
  }

  return base;
}

function extractWarningReason(verdict: Verdict, profile: Profile): string {
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
  const combinedText = [...reasons, verdict.speech ?? "", verdict.headline ?? ""].join(" ");

  if (/nsaid/i.test(combinedText)) {
    return "avoid NSAIDs";
  }

  for (const reason of reasons) {
    const classAvoid = /is (?:an? )?([^,]+),\s*on your avoid list/i.exec(reason);
    if (classAvoid) {
      return `avoid ${classAvoid[1].trim()}`;
    }
    const directAvoid = /^(.+?)\s+is on your avoid list$/i.exec(reason);
    if (directAvoid) {
      return `avoid ${directAvoid[1].trim()}`;
    }
    if (/^avoid\s+/i.test(reason.trim())) {
      return reason.trim();
    }
  }

  if (/avoid list/i.test(combinedText) && profile.avoid.length > 0) {
    return `avoid ${profile.avoid[0]}`;
  }

  const informativeReason =
    reasons.find((r) => !/^not on your medication list$/i.test(r.trim())) ?? reasons[0] ?? "";
  if (informativeReason.trim()) {
    return informativeReason
      .trim()
      .replace(/\s*\(([^)]+)\)/g, ", $1")
      .replace(/\u2014|\u2013/g, "-");
  }

  const fallback = (verdict.headline || "safety warning").trim().replace(/\u2014|\u2013/g, "-");
  return fallback;
}

export function formatSafetyCatchHeadline(verdict: Verdict, profile: Profile): string {
  const itemLabel = extractWarningItemLabel(verdict);
  const reason = extractWarningReason(verdict, profile);
  return `HoldUp Safety Catch: ${itemLabel} flagged (${reason})`;
}

export function buildFamilyAlertLinks(profile: Profile, opts?: FamilyAlertOptions): FamilyAlertLinks {
  const now = opts?.now ?? new Date();
  const lastVerdict = opts?.lastVerdict ?? null;
  const schedule = computeDailySchedule(profile, now);

  const scheduledItems = schedule.filter((item) => item.status !== "as_needed");
  const takenItems = scheduledItems.filter((item) => item.status === "taken");
  const overdueItems = scheduledItems.filter((item) => item.status === "overdue");
  const dueNowItems = scheduledItems.filter((item) => item.status === "due_now");
  const upcomingItems = scheduledItems.filter((item) => item.status === "upcoming");
  const asNeededTaken = schedule.filter(
    (item) => item.status === "as_needed" && item.takenCountToday > 0
  );

  const hasWarning = lastVerdict?.level === "warning";
  const safetyCatchLine =
    hasWarning && lastVerdict ? formatSafetyCatchHeadline(lastVerdict, profile) : null;

  let headline: string;
  if (safetyCatchLine) {
    headline = safetyCatchLine;
  } else if (overdueItems.length > 0) {
    headline = `HoldUp Missed-Dose Alert: ${overdueItems.length} overdue ${
      overdueItems.length === 1 ? "dose" : "doses"
    } today`;
  } else if (scheduledItems.length > 0 && takenItems.length === scheduledItems.length) {
    headline = `HoldUp Daily Update: All ${scheduledItems.length} scheduled ${
      scheduledItems.length === 1 ? "dose" : "doses"
    } taken today`;
  } else {
    headline = `HoldUp Daily Update: ${takenItems.length} of ${scheduledItems.length} scheduled doses taken`;
  }

  const dateStr = formatDateIsoLocal(now);
  const bodyLines: string[] = [];

  if (safetyCatchLine) {
    bodyLines.push(safetyCatchLine);
  }

  bodyLines.push(
    `HoldUp Schedule (${dateStr}): ${takenItems.length} of ${scheduledItems.length} scheduled doses taken.`
  );

  if (overdueItems.length > 0) {
    bodyLines.push(`Overdue: ${overdueItems.map(formatItemEntry).join(", ")}.`);
  } else {
    bodyLines.push("Overdue: none.");
  }

  if (dueNowItems.length > 0) {
    bodyLines.push(`Due now: ${dueNowItems.map(formatItemEntry).join(", ")}.`);
  }

  const takenSummaries = [
    ...takenItems.map(formatItemEntry),
    ...asNeededTaken.map(
      (item) => `${formatMedLabel(item.med)} (as needed, ${item.takenCountToday}x)`
    )
  ];

  if (takenSummaries.length > 0) {
    bodyLines.push(`Taken today: ${takenSummaries.join(", ")}.`);
  } else {
    bodyLines.push("Taken today: none yet.");
  }

  if (upcomingItems.length > 0) {
    bodyLines.push(`Upcoming: ${upcomingItems.map(formatItemEntry).join(", ")}.`);
  }

  const body = bodyLines.join("\n");
  const cleanPhone = (opts?.contactPhone ?? "").trim().replace(/[^\d+]/g, "");
  const cleanEmail = (opts?.contactEmail ?? "").trim().replace(/\s+/g, "");

  const smsHref = `sms:${cleanPhone}?body=${encodeURIComponent(body)}`;
  const mailtoHref = `mailto:${cleanEmail}?subject=${encodeURIComponent(headline)}&body=${encodeURIComponent(body)}`;

  return {
    headline,
    body,
    smsHref,
    mailtoHref
  };
}

export function loadCaregiverContact(): CaregiverContact {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== "function") {
      return { phone: "", email: "" };
    }
    const raw = ls.getItem(CAREGIVER_CONTACT_KEY);
    if (!raw) {
      return { phone: "", email: "" };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { phone: "", email: "" };
    }
    const rec = parsed as Record<string, unknown>;
    return {
      phone: typeof rec.phone === "string" ? rec.phone : "",
      email: typeof rec.email === "string" ? rec.email : ""
    };
  } catch {
    return { phone: "", email: "" };
  }
}

export function saveCaregiverContact(contact: CaregiverContact): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.setItem !== "function") {
      return;
    }
    ls.setItem(
      CAREGIVER_CONTACT_KEY,
      JSON.stringify({
        phone: contact.phone,
        email: contact.email
      })
    );
  } catch {
    return;
  }
}
