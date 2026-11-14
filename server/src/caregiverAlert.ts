import express from "express";
import type { Med, Profile } from "../../shared/types.ts";
import { log } from "./log.ts";
import { toLabelRead, toProfile } from "./verify.ts";

export type CaregiverAlertLang = "en" | "fi" | "sv";

export type CaregiverAlertStatus =
  | "safety_warning"
  | "missed_dose"
  | "all_taken"
  | "in_progress";

export type CaregiverAlertCounts = {
  scheduled: number;
  taken: number;
  overdue: number;
  dueNow: number;
  upcoming: number;
};

export type CaregiverAlertPreviewInput = {
  profile?: unknown;
  lastVerdict?: unknown;
  contactPhone?: unknown;
  contactEmail?: unknown;
  lang?: unknown;
  nowIso?: unknown;
};

export type CaregiverAlertPreview = {
  ok: true;
  lang: CaregiverAlertLang;
  status: CaregiverAlertStatus;
  counts: CaregiverAlertCounts;
  headline: string;
  body: string;
  smsHref: string;
  mailtoHref: string;
};

type CanonicalWindow = "morning" | "noon" | "afternoon" | "evening" | "night" | "time" | "other";

type SlotSpec =
  | { kind: "as_needed" }
  | { kind: "scheduled"; canonical: CanonicalWindow; startHour: number; endHour: number };

type EvaluatedSlot = {
  med: Med;
  slot: string;
  canonical: CanonicalWindow | "as_needed";
  status: "taken" | "due_now" | "overdue" | "upcoming" | "as_needed";
  takenCountToday: number;
};

type SanitizedWarning = {
  headline: string;
  speech: string;
  reasons: string[];
  takenToday?: boolean;
  read: ReturnType<typeof toLabelRead>;
};

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const BAD_BODY_ERROR = {
  type: "error",
  code: "bad_input",
  message: "JSON object body required",
  recoverable: true,
} as const;

const CANONICAL_SLOT_LABELS: Record<
  CaregiverAlertLang,
  Record<"morning" | "noon" | "afternoon" | "evening" | "night", string>
> = {
  en: {
    morning: "morning",
    noon: "noon",
    afternoon: "afternoon",
    evening: "evening",
    night: "night",
  },
  fi: {
    morning: "aamu",
    noon: "päivä",
    afternoon: "iltapäivä",
    evening: "ilta",
    night: "yö",
  },
  sv: {
    morning: "morgon",
    noon: "middag",
    afternoon: "eftermiddag",
    evening: "kväll",
    night: "natt",
  },
};

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date)
  );
}

function cleanText(raw: string, maxLen = 160): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .split(EM_DASH)
    .join("-")
    .split(EN_DASH)
    .join("-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function foldAscii(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function rfcEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function sanitizeContactPhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  if (!digits) return "";
  return (hasLeadingPlus ? `+${digits}` : digits).slice(0, 24);
}

export function sanitizeContactEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u0020\u007f-\u009f\s]+/g, "").slice(0, 120);
}

export function resolveAlertLang(rawLang: unknown, profileLang: string): CaregiverAlertLang {
  const candidate =
    typeof rawLang === "string" && rawLang.trim().length > 0
      ? rawLang.trim().toLowerCase()
      : profileLang.trim().toLowerCase();
  if (candidate.startsWith("fi")) return "fi";
  if (candidate.startsWith("sv")) return "sv";
  return "en";
}

function resolveNow(nowIso: unknown): Date {
  if (nowIso instanceof Date && Number.isFinite(nowIso.getTime())) {
    return new Date(nowIso.getTime());
  }
  if (typeof nowIso === "string" && nowIso.trim().length > 0) {
    const parsed = new Date(nowIso.trim());
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof nowIso === "number" && Number.isFinite(nowIso)) {
    const parsed = new Date(nowIso);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function parseSlotSpec(rawSlot: string): SlotSpec {
  const folded = foldAscii(rawSlot);
  if (
    !folded ||
    /(?:^|[^a-z])(as[- ]needed|when[- ]needed|if[- ]needed|prn|tarvittaessa|vid behov)(?:[^a-z]|$)/.test(folded)
  ) {
    return { kind: "as_needed" };
  }

  if (
    folded.includes("afternoon") ||
    folded.includes("iltapaiva") ||
    folded.includes("eftermiddag")
  ) {
    return { kind: "scheduled", canonical: "afternoon", startHour: 12, endHour: 16 };
  }

  if (
    folded.includes("morning") ||
    folded.includes("breakfast") ||
    folded.includes("aamu") ||
    folded.includes("morgon")
  ) {
    return { kind: "scheduled", canonical: "morning", startHour: 6, endHour: 11 };
  }

  if (
    folded.includes("noon") ||
    folded.includes("midday") ||
    folded.includes("lunch") ||
    folded.includes("paiva") ||
    folded.includes("middag")
  ) {
    return { kind: "scheduled", canonical: "noon", startHour: 11, endHour: 15 };
  }

  if (
    folded.includes("evening") ||
    folded.includes("dinner") ||
    folded.includes("supper") ||
    folded.includes("ilta") ||
    folded.includes("kvall")
  ) {
    return { kind: "scheduled", canonical: "evening", startHour: 17, endHour: 22 };
  }

  if (/(?:^|[^a-z])(night|bedtime|bed|yo|yolla|natt|natten)(?:[^a-z]|$)/.test(folded)) {
    return { kind: "scheduled", canonical: "night", startHour: 20, endHour: 23 };
  }

  const timeMatch = /(?:^|[^\d])(\d{1,2}):(\d{2})(?:$|[^\d])/.exec(folded);
  if (timeMatch) {
    const hour = Math.min(23, Math.max(0, Number(timeMatch[1])));
    return {
      kind: "scheduled",
      canonical: "time",
      startHour: Math.max(0, hour - 2),
      endHour: Math.min(23, hour + 2),
    };
  }

  return { kind: "scheduled", canonical: "other", startHour: 8, endHour: 21 };
}

function countTodaysDosesByMed(profile: Profile, now: Date): Map<string, number> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const startMs = startOfDay.getTime();
  const endMs = endOfDay.getTime();

  const counts = new Map<string, number>();
  for (const entry of profile.doseLog) {
    if (!Number.isFinite(entry.ts) || entry.ts < startMs || entry.ts > endMs) continue;
    const id = entry.medId.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function evaluateDailySlots(profile: Profile, now: Date): EvaluatedSlot[] {
  const counts = countTodaysDosesByMed(profile, now);
  const currentHour = now.getHours();
  const out: EvaluatedSlot[] = [];

  for (const med of profile.meds) {
    const cleanedSlots = med.schedule.map((s) => cleanText(s, 40)).filter((s) => s.length > 0);
    const effectiveSlots = cleanedSlots.length > 0 ? cleanedSlots : ["as needed"];
    const parsed = effectiveSlots.map((slot, index) => ({
      slot,
      index,
      spec: parseSlotSpec(slot),
    }));

    const scheduledEntries = parsed
      .filter(
        (
          entry,
        ): entry is {
          slot: string;
          index: number;
          spec: { kind: "scheduled"; canonical: CanonicalWindow; startHour: number; endHour: number };
        } => entry.spec.kind === "scheduled",
      )
      .sort((a, b) => a.spec.startHour - b.spec.startHour || a.index - b.index);

    const rankByIndex = new Map<number, number>();
    scheduledEntries.forEach((entry, rank) => {
      rankByIndex.set(entry.index, rank);
    });

    const takenCountToday = counts.get(med.id.trim()) ?? 0;

    for (const entry of parsed) {
      if (entry.spec.kind === "as_needed") {
        out.push({
          med,
          slot: entry.slot,
          canonical: "as_needed",
          status: "as_needed",
          takenCountToday,
        });
        continue;
      }

      const rank = rankByIndex.get(entry.index) ?? 0;
      let status: "taken" | "due_now" | "overdue" | "upcoming";
      if (takenCountToday > rank) {
        status = "taken";
      } else if (currentHour < entry.spec.startHour) {
        status = "upcoming";
      } else if (currentHour <= entry.spec.endHour) {
        status = "due_now";
      } else {
        status = "overdue";
      }

      out.push({
        med,
        slot: entry.slot,
        canonical: entry.spec.canonical,
        status,
        takenCountToday,
      });
    }
  }

  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateIsoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function normalizeStrengthSpacing(strength: string): string {
  return strength.trim().replace(/(\d)\s*(mg|g|mcg|ug|ml|iu|ky)\b/gi, "$1 $2");
}

function formatMedLabel(med: Med, lang: CaregiverAlertLang): string {
  const rawName = cleanText(med.name, 120) || cleanText(med.ingredient, 120);
  const fallback = lang === "fi" ? "Lääke" : lang === "sv" ? "Läkemedel" : "Medication";
  const name = rawName || fallback;
  const strength = normalizeStrengthSpacing(cleanText(med.strength, 40));
  if (!strength) return name;
  const compactName = name.toLowerCase().replace(/\s+/g, "");
  const compactStrength = strength.toLowerCase().replace(/\s+/g, "");
  return compactName.includes(compactStrength) ? name : `${name} ${strength}`;
}

function formatSlotForLang(item: EvaluatedSlot, lang: CaregiverAlertLang): string {
  if (
    item.canonical === "morning" ||
    item.canonical === "noon" ||
    item.canonical === "afternoon" ||
    item.canonical === "evening" ||
    item.canonical === "night"
  ) {
    if (lang === "en") {
      const folded = foldAscii(item.slot);
      const isNordicOnly = /^(aamu|aamulla|morgon|paiva|paivalla|middag|iltapaiva|eftermiddag|ilta|illalla|kvall|yo|yolla|natt|natten)$/.test(
        folded,
      );
      return isNordicOnly ? CANONICAL_SLOT_LABELS.en[item.canonical] : item.slot;
    }
    return CANONICAL_SLOT_LABELS[lang][item.canonical];
  }
  return item.slot;
}

function formatScheduledEntry(item: EvaluatedSlot, lang: CaregiverAlertLang): string {
  return `${formatMedLabel(item.med, lang)} (${formatSlotForLang(item, lang)})`;
}

function parseWarningVerdict(raw: unknown): SanitizedWarning | null {
  if (!isRecordObject(raw) || raw.level !== "warning") return null;
  const headline = typeof raw.headline === "string" ? cleanText(raw.headline, 160) : "";
  const speech = typeof raw.speech === "string" ? cleanText(raw.speech, 300) : "";
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons
        .filter((r): r is string => typeof r === "string")
        .map((r) => cleanText(r, 160))
        .filter((r) => r.length > 0)
        .slice(0, 16)
    : [];
  const takenToday = typeof raw.takenToday === "boolean" ? raw.takenToday : undefined;
  const read = toLabelRead(raw.read);
  return {
    headline,
    speech,
    reasons,
    ...(takenToday !== undefined ? { takenToday } : {}),
    read,
  };
}

function extractWarningItemLabel(warning: SanitizedWarning, lang: CaregiverAlertLang): string {
  const productRaw = warning.read.product.value ? cleanText(warning.read.product.value, 120) : "";
  const ingredientRaw = warning.read.ingredient.value
    ? cleanText(warning.read.ingredient.value, 120)
    : "";
  const strengthRaw = warning.read.strength.value
    ? normalizeStrengthSpacing(cleanText(warning.read.strength.value, 40))
    : "";

  let base = "";
  if (productRaw) {
    base = productRaw;
  } else if (ingredientRaw) {
    base = capitalizeFirst(ingredientRaw.split(",")[0].trim());
  } else if (warning.headline) {
    const stripped = warning.headline.replace(/^(warning|varoitus|varning)\s*:(?:\s*)/i, "").trim();
    const candidate = stripped.split(":")[0].trim();
    if (!/^(may contain|contains)\b/i.test(candidate)) {
      base = candidate;
    }
  }

  if (!base) {
    if (warning.read.kind === "food") {
      base = lang === "fi" ? "Elintarvike" : lang === "sv" ? "Livsmedel" : "Food item";
    } else {
      base = lang === "fi" ? "Lääke" : lang === "sv" ? "Läkemedel" : "Medication";
    }
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

function formatWarningReason(
  warning: SanitizedWarning,
  profile: Profile,
  lang: CaregiverAlertLang,
): string {
  const combined = [...warning.reasons, warning.speech, warning.headline].join(" ");

  for (const r of warning.reasons) {
    const m = /^(may contain|contains)\s+(.+?)\s*\(allergy:\s*([^)]+)\)$/i.exec(r);
    if (m) {
      const may = m[1].toLowerCase() === "may contain";
      const found = cleanText(m[2], 60);
      const allergy = cleanText(m[3], 60);
      if (lang === "fi") {
        return may
          ? `allergeenivaroitus: saattaa sisältää ${found}, allergia ${allergy}`
          : `allergeenivaroitus: sisältää ${found}, allergia ${allergy}`;
      }
      if (lang === "sv") {
        return may
          ? `allergenvarning: kan innehålla ${found}, allergi ${allergy}`
          : `allergenvarning: innehåller ${found}, allergi ${allergy}`;
      }
      return may
        ? `allergen warning: may contain ${found}, allergy ${allergy}`
        : `allergen warning: contains ${found}, allergy ${allergy}`;
    }
  }

  if (/(allergy|allergen|allergic|allergia|allergi)/i.test(combined)) {
    const hMatch = /^(?:warning:\s*)?(may contain|contains)\s+(.+)$/i.exec(warning.headline);
    const found = hMatch ? cleanText(hMatch[2], 60) : profile.allergies[0] ? cleanText(profile.allergies[0], 60) : "";
    if (lang === "fi") return found ? `allergeenivaroitus: ${found}` : "allergeenivaroitus";
    if (lang === "sv") return found ? `allergenvarning: ${found}` : "allergenvarning";
    return found ? `allergen warning: ${found}` : "allergen warning";
  }

  if (/\bnsaid/i.test(combined)) {
    if (lang === "fi") return "vältettävä lääkeryhmä: tulehduskipulääkkeet (NSAID)";
    if (lang === "sv") return "undvik läkemedelsgrupp: NSAID";
    return "avoid NSAIDs";
  }

  for (const r of warning.reasons) {
    const clsMatch = /is (?:an? )?([^,]+),\s*on your avoid list/i.exec(r);
    if (clsMatch) {
      const target = cleanText(clsMatch[1], 60);
      if (lang === "fi") return `vältettävä: ${target}`;
      if (lang === "sv") return `undvik: ${target}`;
      return `avoid ${target}`;
    }
    const directMatch = /^(.+?)\s+is on your avoid list$/i.exec(r);
    if (directMatch) {
      const target = cleanText(directMatch[1], 60);
      if (lang === "fi") return `vältettävä: ${target}`;
      if (lang === "sv") return `undvik: ${target}`;
      return `avoid ${target}`;
    }
    const prefixMatch = /^avoid\s+(.+)$/i.exec(r);
    if (prefixMatch) {
      const target = cleanText(prefixMatch[1], 60);
      if (lang === "fi") return `vältettävä: ${target}`;
      if (lang === "sv") return `undvik: ${target}`;
      return `avoid ${target}`;
    }
  }

  if (/avoid list|on your avoid|says to avoid|vältettäv|undvik/i.test(combined)) {
    const target = profile.avoid[0] ? cleanText(profile.avoid[0], 60) : "";
    if (lang === "fi") return target ? `vältettävä: ${target}` : "vältettävien listalla";
    if (lang === "sv") return target ? `undvik: ${target}` : "på undvik-listan";
    return target ? `avoid ${target}` : "on avoid list";
  }

  for (const r of warning.reasons) {
    const strMatch = /strength\s+(.+?)\s+differs from your\s+(.+)/i.exec(r);
    if (strMatch) {
      const got = normalizeStrengthSpacing(cleanText(strMatch[1], 40));
      const expected = normalizeStrengthSpacing(cleanText(strMatch[2], 40));
      if (lang === "fi") return `väärä vahvuus: pakkauksessa ${got}, lääkelistalla ${expected}`;
      if (lang === "sv") return `fel styrka: förpackning ${got}, ordinerad ${expected}`;
      return `wrong strength: label ${got}, prescribed ${expected}`;
    }
  }

  if (/wrong strength|strength differs|väärä vahvuus|fel styrka/i.test(combined)) {
    if (lang === "fi") return "väärä vahvuus";
    if (lang === "sv") return "fel styrka";
    return "wrong strength";
  }

  for (const r of warning.reasons) {
    const expMatch = /^expired\s+(.+)$/i.exec(r);
    if (expMatch) {
      const exp = cleanText(expMatch[1], 32);
      if (lang === "fi") return `vanhentunut (${exp})`;
      if (lang === "sv") return `utgånget datum (${exp})`;
      return `expired (${exp})`;
    }
  }

  if (/\bexpired\b|past its date|vanhentunut|utgång/i.test(combined)) {
    const exp = warning.read.expiry.value ? cleanText(warning.read.expiry.value, 32) : "";
    if (lang === "fi") return exp ? `vanhentunut (${exp})` : "vanhentunut pakkaus";
    if (lang === "sv") return exp ? `utgånget datum (${exp})` : "utgånget datum";
    return exp ? `expired (${exp})` : "expired";
  }

  const dupRatio = warning.reasons
    .map((r) => /^taken today:\s*(\d+)\/(\d+)$/i.exec(r))
    .find((m) => m !== null && Number(m[1]) > 0 && Number(m[1]) >= Number(m[2]));

  if (
    dupRatio ||
    warning.takenToday === true ||
    /already taken today|already took it today|duplicate dose|kaksoisannos|dubbeldos/i.test(combined)
  ) {
    if (lang === "fi") return "kaksoisannosvaara: otettu jo tänään";
    if (lang === "sv") return "dubbeldosvarning: redan tagen idag";
    return "duplicate dose: already taken today";
  }

  if (
    /not on your (?:medication )?list|not on your list|wrong pill|wrong medication|väärä lääke|fel läkemedel/i.test(
      combined,
    )
  ) {
    if (lang === "fi") return "väärä lääke: ei lääkelistalla";
    if (lang === "sv") return "fel läkemedel: finns inte på medicinlistan";
    return "wrong pill: not on medication list";
  }

  const informative = warning.reasons[0] || warning.headline;
  if (informative) {
    return informative.replace(/\s*\(([^)]+)\)/g, ", $1");
  }
  if (lang === "fi") return "turvallisuusvaroitus";
  if (lang === "sv") return "säkerhetsvarning";
  return "safety warning";
}

function formatSafetyCatchHeadline(
  warning: SanitizedWarning,
  profile: Profile,
  lang: CaregiverAlertLang,
): string {
  const itemLabel = extractWarningItemLabel(warning, lang);
  const reason = formatWarningReason(warning, profile, lang);
  if (lang === "fi") {
    return `HoldUp-turvahuomio: ${itemLabel} pysäytetty (${reason})`;
  }
  if (lang === "sv") {
    return `HoldUp säkerhetsvarning: ${itemLabel} stoppad (${reason})`;
  }
  return `HoldUp Safety Catch: ${itemLabel} flagged (${reason})`;
}

function formatHeadlineAndBody(params: {
  lang: CaregiverAlertLang;
  status: CaregiverAlertStatus;
  counts: CaregiverAlertCounts;
  dateStr: string;
  safetyCatchLine: string | null;
  overdueList: string[];
  dueNowList: string[];
  takenList: string[];
  upcomingList: string[];
}): { headline: string; body: string } {
  const {
    lang,
    status,
    counts,
    dateStr,
    safetyCatchLine,
    overdueList,
    dueNowList,
    takenList,
    upcomingList,
  } = params;

  if (lang === "fi") {
    let headline: string;
    if (status === "safety_warning" && safetyCatchLine) {
      headline = safetyCatchLine;
    } else if (status === "missed_dose") {
      headline = `HoldUp-annoshälytys: ${counts.overdue} ${
        counts.overdue === 1 ? "myöhässä oleva lääkeannos" : "myöhässä olevaa lääkeannosta"
      } tänään`;
    } else if (status === "all_taken") {
      headline = `HoldUp-päiväyhteenveto: Kaikki ${counts.scheduled} ${
        counts.scheduled === 1 ? "aikataulutettu annos" : "aikataulutettua annosta"
      } otettu tänään`;
    } else {
      headline = `HoldUp-päiväyhteenveto: ${counts.taken}/${counts.scheduled} aikataulutettua annosta otettu tänään`;
    }

    const lines: string[] = [];
    if (safetyCatchLine) {
      lines.push(safetyCatchLine);
      lines.push("Toimenpide: Varmista pakkaus käyttäjän tai apteekin kanssa ennen käyttöä.");
    }
    lines.push(
      `HoldUp-lääkeaikataulu (${dateStr}): ${counts.taken}/${counts.scheduled} aikataulutettua annosta otettu.`,
    );
    lines.push(
      overdueList.length > 0 ? `Myöhässä: ${overdueList.join(", ")}.` : "Myöhässä: ei yhtään.",
    );
    if (dueNowList.length > 0) {
      lines.push(`Ajankohtainen nyt: ${dueNowList.join(", ")}.`);
    }
    lines.push(
      takenList.length > 0
        ? `Otettu tänään: ${takenList.join(", ")}.`
        : "Otettu tänään: ei vielä yhtään.",
    );
    if (upcomingList.length > 0) {
      lines.push(`Tulossa myöhemmin: ${upcomingList.join(", ")}.`);
    }
    return { headline, body: lines.join("\n") };
  }

  if (lang === "sv") {
    let headline: string;
    if (status === "safety_warning" && safetyCatchLine) {
      headline = safetyCatchLine;
    } else if (status === "missed_dose") {
      headline = `HoldUp doslarm: ${counts.overdue} ${
        counts.overdue === 1 ? "försenad dos" : "försenade doser"
      } idag`;
    } else if (status === "all_taken") {
      headline = `HoldUp dagsöversikt: Alla ${counts.scheduled} ${
        counts.scheduled === 1 ? "schemalagd dos tagen" : "schemalagda doser tagna"
      } idag`;
    } else {
      headline = `HoldUp dagsöversikt: ${counts.taken} av ${counts.scheduled} schemalagda doser tagna idag`;
    }

    const lines: string[] = [];
    if (safetyCatchLine) {
      lines.push(safetyCatchLine);
      lines.push("Åtgärd: Kontrollera förpackningen med användaren eller apotekspersonal före intag.");
    }
    lines.push(
      `HoldUp medicinschema (${dateStr}): ${counts.taken} av ${counts.scheduled} schemalagda doser tagna.`,
    );
    lines.push(
      overdueList.length > 0 ? `Försenade: ${overdueList.join(", ")}.` : "Försenade: inga.",
    );
    if (dueNowList.length > 0) {
      lines.push(`Att ta nu: ${dueNowList.join(", ")}.`);
    }
    lines.push(
      takenList.length > 0
        ? `Tagna idag: ${takenList.join(", ")}.`
        : "Tagna idag: inga ännu.",
    );
    if (upcomingList.length > 0) {
      lines.push(`Kommande idag: ${upcomingList.join(", ")}.`);
    }
    return { headline, body: lines.join("\n") };
  }

  let headline: string;
  if (status === "safety_warning" && safetyCatchLine) {
    headline = safetyCatchLine;
  } else if (status === "missed_dose") {
    headline = `HoldUp Missed-Dose Alert: ${counts.overdue} overdue ${
      counts.overdue === 1 ? "dose" : "doses"
    } today`;
  } else if (status === "all_taken") {
    headline = `HoldUp Daily Update: All ${counts.scheduled} scheduled ${
      counts.scheduled === 1 ? "dose" : "doses"
    } taken today`;
  } else {
    headline = `HoldUp Daily Update: ${counts.taken} of ${counts.scheduled} scheduled ${
      counts.scheduled === 1 ? "dose" : "doses"
    } taken`;
  }

  const lines: string[] = [];
  if (safetyCatchLine) {
    lines.push(safetyCatchLine);
    lines.push("Action needed: Check with the user or a pharmacist before taking this item.");
  }
  lines.push(
    `HoldUp Schedule (${dateStr}): ${counts.taken} of ${counts.scheduled} scheduled doses taken.`,
  );
  lines.push(overdueList.length > 0 ? `Overdue: ${overdueList.join(", ")}.` : "Overdue: none.");
  if (dueNowList.length > 0) {
    lines.push(`Due now: ${dueNowList.join(", ")}.`);
  }
  lines.push(
    takenList.length > 0
      ? `Taken today: ${takenList.join(", ")}.`
      : "Taken today: none yet.",
  );
  if (upcomingList.length > 0) {
    lines.push(`Upcoming: ${upcomingList.join(", ")}.`);
  }
  return { headline, body: lines.join("\n") };
}

export function buildCaregiverAlertPreview(
  input: CaregiverAlertPreviewInput = {},
): CaregiverAlertPreview {
  const safeInput = isRecordObject(input) ? input : {};
  const profile = toProfile(safeInput.profile);
  const lang = resolveAlertLang(safeInput.lang, profile.lang);
  const now = resolveNow(safeInput.nowIso);
  const cleanPhone = sanitizeContactPhone(safeInput.contactPhone);
  const cleanEmail = sanitizeContactEmail(safeInput.contactEmail);
  const warning = parseWarningVerdict(safeInput.lastVerdict);

  const slots = evaluateDailySlots(profile, now);
  const scheduledItems = slots.filter((s) => s.status !== "as_needed");
  const takenItems = scheduledItems.filter((s) => s.status === "taken");
  const overdueItems = scheduledItems.filter((s) => s.status === "overdue");
  const dueNowItems = scheduledItems.filter((s) => s.status === "due_now");
  const upcomingItems = scheduledItems.filter((s) => s.status === "upcoming");
  const seenAsNeededIds = new Set<string>();
  const asNeededTaken = slots.filter((s) => {
    if (s.status !== "as_needed" || s.takenCountToday <= 0) return false;
    if (seenAsNeededIds.has(s.med.id)) return false;
    seenAsNeededIds.add(s.med.id);
    return true;
  });

  const counts: CaregiverAlertCounts = {
    scheduled: scheduledItems.length,
    taken: takenItems.length,
    overdue: overdueItems.length,
    dueNow: dueNowItems.length,
    upcoming: upcomingItems.length,
  };

  let status: CaregiverAlertStatus;
  if (warning) {
    status = "safety_warning";
  } else if (counts.overdue > 0) {
    status = "missed_dose";
  } else if (counts.scheduled > 0 && counts.taken === counts.scheduled) {
    status = "all_taken";
  } else {
    status = "in_progress";
  }

  const safetyCatchLine = warning ? formatSafetyCatchHeadline(warning, profile, lang) : null;
  const asNeededWord =
    lang === "fi" ? "tarvittaessa" : lang === "sv" ? "vid behov" : "as needed";
  const countSuffix = (n: number) => (lang === "fi" ? `${n} krt` : `${n}x`);

  const takenList = [
    ...takenItems.map((item) => formatScheduledEntry(item, lang)),
    ...asNeededTaken.map(
      (item) => `${formatMedLabel(item.med, lang)} (${asNeededWord}, ${countSuffix(item.takenCountToday)})`,
    ),
  ];

  const { headline, body } = formatHeadlineAndBody({
    lang,
    status,
    counts,
    dateStr: formatDateIsoLocal(now),
    safetyCatchLine,
    overdueList: overdueItems.map((item) => formatScheduledEntry(item, lang)),
    dueNowList: dueNowItems.map((item) => formatScheduledEntry(item, lang)),
    takenList,
    upcomingList: upcomingItems.map((item) => formatScheduledEntry(item, lang)),
  });

  const safeEmailTarget = cleanEmail.replace(/[?#&%]/g, (ch) => rfcEncode(ch));
  const smsHref = `sms:${cleanPhone}?body=${rfcEncode(body)}`;
  const mailtoHref = `mailto:${safeEmailTarget}?subject=${rfcEncode(headline)}&body=${rfcEncode(body)}`;

  return {
    ok: true,
    lang,
    status,
    counts,
    headline,
    body,
    smsHref,
    mailtoHref,
  };
}

export function createCaregiverAlertRouter(): express.Router {
  const router = express.Router();
  const jsonParser = express.json({ limit: "64kb", strict: false });

  router.post(
    "/api/caregiver-alert-preview",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    (req, res, next) => {
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (contentLength === 0) {
        res.status(400).json(BAD_BODY_ERROR);
        return;
      }
      jsonParser(req, res, (err: unknown) => {
        if (err) {
          const errStatus = isRecordObject(err) && typeof err.status === "number" ? err.status : 400;
          if (errStatus === 413) {
            res.status(413).json({
              type: "error",
              code: "payload_too_large",
              message: "JSON body exceeds 64kb limit",
              recoverable: true,
            });
            return;
          }
          res.status(400).json(BAD_BODY_ERROR);
          return;
        }
        next();
      });
    },
    (req, res) => {
      if (!isRecordObject(req.body)) {
        res.status(400).json(BAD_BODY_ERROR);
        return;
      }
      const preview = buildCaregiverAlertPreview(req.body);
      log("api.caregiver_preview", { lang: preview.lang, status: preview.status });
      res.status(200).json(preview);
    },
  );

  return router;
}
