import { useId, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { Med, Profile, Verdict } from "../types.ts";

export const ROUTINE_STRENGTH_MIN_CONF = 0.8;

export type RoutineStepNumber = 1 | 2 | 3;

export type RoutineScheduleSlot = "morning" | "noon" | "evening" | "bedtime";

export type RoutineOutcomeKind =
  | "empty_profile"
  | "due_pill"
  | "all_taken"
  | "camera_coaching"
  | "verified_match"
  | "double_dose_blocked"
  | "safety_warning"
  | "unsure_reaim"
  | "info_read";

export type RoutinePrimaryAction = "start_check" | "log_dose" | "repeat_verdict";

export type RoutineTone = "match" | "warning" | "unsure" | "info";

export type RoutineStepDerivation = {
  activeStep: RoutineStepNumber;
  scheduledTaken: number;
  scheduledRemaining: number;
  scheduledTotal: number;
  allScheduledTaken: boolean;
  nextScheduledMed: Med | null;
  nextScheduledSlot: RoutineScheduleSlot | null;
  outcome: RoutineOutcomeKind;
  primaryAction: RoutinePrimaryAction;
  tone: RoutineTone;
  canLogDose: boolean;
  doubleDoseBlocked: boolean;
  belowStrengthThreshold: boolean;
  requiresPharmacistCheck: boolean;
  matchedMedId: string | null;
};

export type CognitiveRoutineCardProps = {
  profile: Profile;
  cameraActive: boolean;
  lastVerdict: Verdict | null;
  lang?: string;
  now?: Date;
  onStartCheck?: () => void;
  onLogDose?: (medId?: string) => void;
  onRepeatVerdict?: () => void;
};

const SLOT_ORDER: Record<RoutineScheduleSlot, number> = {
  morning: 0,
  noon: 1,
  evening: 2,
  bedtime: 3
};

const AS_NEEDED_EXACT_RE =
  /^(as[-_ ]?needed|when[-_ ]?needed|if[-_ ]?needed|prn|optional|tarvittaessa|vid behov)$/i;

const HH_MM_RE = /^(\d{1,2}):(\d{2})$/;

const ALREADY_TAKEN_TEXT_RE = /already\s+(?:taken|logged)\s+today/i;

export function isAsNeededRoutineSlot(rawSlot: string): boolean {
  const trimmed = (rawSlot ?? "").trim().toLowerCase();
  if (!trimmed || AS_NEEDED_EXACT_RE.test(trimmed)) {
    return true;
  }
  return (
    trimmed.includes("as needed") ||
    trimmed.includes("as_needed") ||
    trimmed.includes("when needed") ||
    trimmed.includes("if needed") ||
    trimmed.includes("prn") ||
    trimmed.includes("tarvittaessa") ||
    trimmed.includes("vid behov")
  );
}

export function resolveRoutineSlotForHour(hour: number): RoutineScheduleSlot {
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

function classifyScheduledSlot(rawSlot: string): RoutineScheduleSlot | null {
  if (isAsNeededRoutineSlot(rawSlot)) {
    return null;
  }
  const lower = rawSlot.trim().toLowerCase();
  if (
    lower.includes("morning") ||
    lower.includes("breakfast") ||
    lower === "am" ||
    lower.includes("aamu") ||
    lower.includes("morgon")
  ) {
    return "morning";
  }
  if (
    lower.includes("noon") ||
    lower.includes("midday") ||
    lower.includes("mid-day") ||
    lower.includes("lunch") ||
    lower.includes("afternoon") ||
    lower.includes("päivä") ||
    lower.includes("paiva") ||
    lower.includes("middag") ||
    lower.includes("eftermiddag")
  ) {
    return "noon";
  }
  if (
    lower.includes("evening") ||
    lower.includes("dinner") ||
    lower.includes("supper") ||
    lower === "pm" ||
    lower.includes("ilta") ||
    lower.includes("kväll") ||
    lower.includes("kvall")
  ) {
    return "evening";
  }
  if (
    lower.includes("bedtime") ||
    lower.includes("bed") ||
    lower.includes("night") ||
    lower.includes("tonight") ||
    lower === "hs" ||
    lower.includes("yö") ||
    lower === "yo" ||
    lower.includes("natt")
  ) {
    return "bedtime";
  }
  const timeMatch = HH_MM_RE.exec(lower);
  if (timeMatch) {
    const parsedHour = Math.min(23, Math.max(0, Number.parseInt(timeMatch[1], 10)));
    return resolveRoutineSlotForHour(parsedHour);
  }
  return "morning";
}

function extractMedScheduledSlots(med: Med): RoutineScheduleSlot[] {
  const legacyTimes = (med as Med & { times?: unknown }).times;
  const rawList =
    Array.isArray(med?.schedule) && med.schedule.length > 0
      ? med.schedule
      : Array.isArray(legacyTimes)
        ? legacyTimes
        : [];
  const slots: RoutineScheduleSlot[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string") {
      continue;
    }
    const parsed = classifyScheduledSlot(entry);
    if (parsed !== null) {
      slots.push(parsed);
    }
  }
  slots.sort((a, b) => SLOT_ORDER[a] - SLOT_ORDER[b]);
  return slots;
}

function countTodayDosesByMed(profile: Profile, nowDate: Date): Map<string, number> {
  const startOfDay = new Date(nowDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(nowDate);
  endOfDay.setHours(23, 59, 59, 999);
  const startMs = startOfDay.getTime();
  const endMs = endOfDay.getTime();

  const counts = new Map<string, number>();
  const rawLog = Array.isArray(profile?.doseLog) ? profile.doseLog : [];
  for (const item of rawLog) {
    if (
      !item ||
      typeof item.medId !== "string" ||
      typeof item.ts !== "number" ||
      !Number.isFinite(item.ts)
    ) {
      continue;
    }
    if (item.ts < startMs || item.ts > endMs) {
      continue;
    }
    const medId = item.medId.trim();
    if (!medId) {
      continue;
    }
    counts.set(medId, (counts.get(medId) ?? 0) + 1);
  }
  return counts;
}

type PendingCandidate = {
  med: Med;
  slot: RoutineScheduleSlot;
  priority: number;
  medIndex: number;
};

function isStrengthBelowThreshold(verdict: Verdict): boolean {
  const kind = verdict.read?.kind;
  if (kind !== "medication" && kind !== "unreadable") {
    return false;
  }
  const rawVal = verdict.read?.strength?.value;
  const trimmed = typeof rawVal === "string" ? rawVal.trim() : "";
  const rawConf = verdict.read?.strength?.confidence;
  const conf = typeof rawConf === "number" && Number.isFinite(rawConf) ? rawConf : 0;
  return !trimmed || conf < ROUTINE_STRENGTH_MIN_CONF;
}

function sanitizeDisplayText(raw: string | undefined | null): string {
  return (raw ?? "")
    .replace(/\u2014|\u2013/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMedTitle(med: Med): string {
  const name = sanitizeDisplayText(med.name) || sanitizeDisplayText(med.ingredient) || med.id;
  const strength = sanitizeDisplayText(med.strength);
  return strength ? `${name} ${strength}` : name;
}

function resolveVerdictMedLabel(verdict: Verdict, profile: Profile): string {
  const matchedId =
    typeof verdict.matchedMedId === "string" ? verdict.matchedMedId.trim() : "";
  if (matchedId && Array.isArray(profile?.meds)) {
    const matched = profile.meds.find((m) => m && m.id.trim() === matchedId);
    if (matched) {
      return formatMedTitle(matched);
    }
  }
  const product = sanitizeDisplayText(verdict.read?.product?.value);
  const strength = sanitizeDisplayText(verdict.read?.strength?.value);
  if (product && strength && !product.toLowerCase().includes(strength.toLowerCase())) {
    return `${product} ${strength}`;
  }
  if (product) {
    return product;
  }
  const headline = sanitizeDisplayText(verdict.headline);
  return headline || "Label";
}

export function deriveRoutineStep(
  profile: Profile,
  cameraActive: boolean,
  lastVerdict: Verdict | null,
  now?: Date
): RoutineStepDerivation {
  const effectiveNow =
    now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const currentSlot = resolveRoutineSlotForHour(effectiveNow.getHours());
  const todayCounts = countTodayDosesByMed(profile, effectiveNow);
  const meds = Array.isArray(profile?.meds) ? profile.meds : [];

  let scheduledTotal = 0;
  let scheduledTaken = 0;
  const scheduledSlotsByMedId = new Map<string, number>();
  const pendingCandidates: PendingCandidate[] = [];

  for (let idx = 0; idx < meds.length; idx += 1) {
    const med = meds[idx];
    if (!med || typeof med.id !== "string") {
      continue;
    }
    const medId = med.id.trim();
    if (!medId) {
      continue;
    }
    const slots = extractMedScheduledSlots(med);
    scheduledSlotsByMedId.set(medId, slots.length);
    if (slots.length === 0) {
      continue;
    }

    const rawTaken = todayCounts.get(medId) ?? 0;
    const cappedTaken = Math.min(rawTaken, slots.length);
    scheduledTotal += slots.length;
    scheduledTaken += cappedTaken;

    if (rawTaken < slots.length) {
      const remainingSlots = slots.slice(rawTaken);
      let chosenSlot: RoutineScheduleSlot = remainingSlots[0];
      let priority = 2;

      if (remainingSlots.includes(currentSlot)) {
        chosenSlot = currentSlot;
        priority = 0;
      } else {
        const overdueSlots = remainingSlots.filter(
          (slot) => SLOT_ORDER[slot] < SLOT_ORDER[currentSlot]
        );
        if (overdueSlots.length > 0) {
          chosenSlot = overdueSlots[0];
          priority = 1;
        }
      }

      pendingCandidates.push({
        med,
        slot: chosenSlot,
        priority,
        medIndex: idx
      });
    }
  }

  pendingCandidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] ||
      a.medIndex - b.medIndex
  );

  const scheduledRemaining = Math.max(0, scheduledTotal - scheduledTaken);
  const allScheduledTaken = scheduledTotal > 0 && scheduledRemaining === 0;
  const nextCandidate = pendingCandidates[0] ?? null;
  const nextScheduledMed = nextCandidate ? nextCandidate.med : null;
  const nextScheduledSlot = nextCandidate ? nextCandidate.slot : null;

  if (lastVerdict !== null) {
    const matchedMedId =
      typeof lastVerdict.matchedMedId === "string" && lastVerdict.matchedMedId.trim().length > 0
        ? lastVerdict.matchedMedId.trim()
        : null;
    const belowStrengthThreshold = isStrengthBelowThreshold(lastVerdict);
    const matchedRequired =
      matchedMedId !== null && scheduledSlotsByMedId.has(matchedMedId)
        ? (scheduledSlotsByMedId.get(matchedMedId) ?? 0)
        : null;
    const matchedTakenToday = matchedMedId !== null ? (todayCounts.get(matchedMedId) ?? 0) : 0;
    const combinedText = [
      lastVerdict.headline ?? "",
      lastVerdict.speech ?? "",
      ...(Array.isArray(lastVerdict.reasons) ? lastVerdict.reasons : [])
    ].join(" ");

    const warningAlreadyTaken =
      lastVerdict.level === "warning" &&
      (lastVerdict.takenToday === true || ALREADY_TAKEN_TEXT_RE.test(combinedText));
    const quotaAlreadyMet =
      matchedMedId !== null &&
      matchedRequired !== null &&
      matchedRequired > 0 &&
      matchedTakenToday >= matchedRequired;
    const singleSlotOptimisticTaken =
      lastVerdict.level === "match" &&
      lastVerdict.takenToday === true &&
      (matchedRequired === null || matchedRequired <= 1);

    const doubleDoseBlocked =
      warningAlreadyTaken || quotaAlreadyMet || singleSlotOptimisticTaken;

    if (doubleDoseBlocked) {
      return {
        activeStep: 3,
        scheduledTaken,
        scheduledRemaining,
        scheduledTotal,
        allScheduledTaken,
        nextScheduledMed,
        nextScheduledSlot,
        outcome: "double_dose_blocked",
        primaryAction: "repeat_verdict",
        tone: "warning",
        canLogDose: false,
        doubleDoseBlocked: true,
        belowStrengthThreshold,
        requiresPharmacistCheck: true,
        matchedMedId
      };
    }

    if (lastVerdict.level === "warning") {
      return {
        activeStep: 3,
        scheduledTaken,
        scheduledRemaining,
        scheduledTotal,
        allScheduledTaken,
        nextScheduledMed,
        nextScheduledSlot,
        outcome: "safety_warning",
        primaryAction: "repeat_verdict",
        tone: "warning",
        canLogDose: false,
        doubleDoseBlocked: false,
        belowStrengthThreshold,
        requiresPharmacistCheck: true,
        matchedMedId
      };
    }

    if (lastVerdict.level === "unsure" || (lastVerdict.level === "match" && belowStrengthThreshold)) {
      return {
        activeStep: 3,
        scheduledTaken,
        scheduledRemaining,
        scheduledTotal,
        allScheduledTaken,
        nextScheduledMed,
        nextScheduledSlot,
        outcome: "unsure_reaim",
        primaryAction: "start_check",
        tone: "unsure",
        canLogDose: false,
        doubleDoseBlocked: false,
        belowStrengthThreshold: true,
        requiresPharmacistCheck: true,
        matchedMedId
      };
    }

    if (lastVerdict.level === "match") {
      return {
        activeStep: 3,
        scheduledTaken,
        scheduledRemaining,
        scheduledTotal,
        allScheduledTaken,
        nextScheduledMed,
        nextScheduledSlot,
        outcome: "verified_match",
        primaryAction: "log_dose",
        tone: "match",
        canLogDose: true,
        doubleDoseBlocked: false,
        belowStrengthThreshold: false,
        requiresPharmacistCheck: false,
        matchedMedId
      };
    }

    return {
      activeStep: 3,
      scheduledTaken,
      scheduledRemaining,
      scheduledTotal,
      allScheduledTaken,
      nextScheduledMed,
      nextScheduledSlot,
      outcome: "info_read",
      primaryAction: "repeat_verdict",
      tone: "info",
      canLogDose: false,
      doubleDoseBlocked: false,
      belowStrengthThreshold: false,
      requiresPharmacistCheck: false,
      matchedMedId
    };
  }

  if (cameraActive) {
    return {
      activeStep: 2,
      scheduledTaken,
      scheduledRemaining,
      scheduledTotal,
      allScheduledTaken,
      nextScheduledMed,
      nextScheduledSlot,
      outcome: "camera_coaching",
      primaryAction: "start_check",
      tone: "info",
      canLogDose: false,
      doubleDoseBlocked: false,
      belowStrengthThreshold: false,
      requiresPharmacistCheck: false,
      matchedMedId: null
    };
  }

  if (scheduledTotal === 0) {
    return {
      activeStep: 1,
      scheduledTaken: 0,
      scheduledRemaining: 0,
      scheduledTotal: 0,
      allScheduledTaken: false,
      nextScheduledMed: null,
      nextScheduledSlot: null,
      outcome: "empty_profile",
      primaryAction: "start_check",
      tone: "info",
      canLogDose: false,
      doubleDoseBlocked: false,
      belowStrengthThreshold: false,
      requiresPharmacistCheck: false,
      matchedMedId: null
    };
  }

  if (allScheduledTaken) {
    return {
      activeStep: 1,
      scheduledTaken,
      scheduledRemaining: 0,
      scheduledTotal,
      allScheduledTaken: true,
      nextScheduledMed: null,
      nextScheduledSlot: null,
      outcome: "all_taken",
      primaryAction: "start_check",
      tone: "match",
      canLogDose: false,
      doubleDoseBlocked: false,
      belowStrengthThreshold: false,
      requiresPharmacistCheck: false,
      matchedMedId: null
    };
  }

  return {
    activeStep: 1,
    scheduledTaken,
    scheduledRemaining,
    scheduledTotal,
    allScheduledTaken: false,
    nextScheduledMed,
    nextScheduledSlot,
    outcome: "due_pill",
    primaryAction: "start_check",
    tone: "info",
    canLogDose: false,
    doubleDoseBlocked: false,
    belowStrengthThreshold: false,
    requiresPharmacistCheck: false,
    matchedMedId: null
  };
}

type StepVisualState = "completed" | "current" | "upcoming";

type LocaleRoutineCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  onDevicePill: string;
  stepsListAria: string;
  calloutAria: string;
  progressBadge: (taken: number, remaining: number, total: number) => string;
  slotNames: Record<RoutineScheduleSlot, string>;
  stepTitles: Record<RoutineStepNumber, string>;
  stepStateLabels: Record<StepVisualState, string>;
  emptyHeadline: string;
  emptyBody: string;
  dueHeadline: (medTitle: string, slotLabel: string) => string;
  dueBody: (medTitle: string) => string;
  allTakenHeadline: (total: number) => string;
  allTakenBody: string;
  cameraHeadline: (medTitle: string | null) => string;
  cameraBody: string;
  matchHeadline: (medTitle: string) => string;
  matchBody: string;
  doubleDoseHeadline: (medTitle: string) => string;
  doubleDoseBody: string;
  doubleDoseBlockedPill: string;
  warningHeadline: string;
  warningBody: (detail: string) => string;
  unsureHeadline: (below80: boolean) => string;
  unsureBody: string;
  infoHeadline: (title: string) => string;
  infoBody: string;
  btnStartDue: (medTitle: string) => string;
  btnStartGeneral: string;
  btnStartExtra: string;
  btnRecheckSteady: string;
  btnLogVerified: (medTitle: string) => string;
  btnRepeatVerdict: string;
  btnReaimCheck: string;
  btnCheckDifferentBox: string;
  mdrNote: string;
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleRoutineCopy> = {
  en: {
    eyebrow: "One Calm Step at a Time",
    heading: "Guided 3-Step Pill Routine",
    subtitle: "Low-cognitive-load assistant for checking and logging scheduled daily medications",
    onDevicePill: "Stored on device only",
    stepsListAria: "Three-step medication check routine",
    calloutAria: "Next safe routine action",
    progressBadge: (taken, remaining, total) =>
      total === 0
        ? "0 scheduled doses today"
        : remaining === 0
          ? `All ${total} scheduled taken today`
          : `${taken} taken, ${remaining} left today`,
    slotNames: {
      morning: "Morning",
      noon: "Noon",
      evening: "Evening",
      bedtime: "Bedtime"
    },
    stepTitles: {
      1: "1. Pick due pill",
      2: "2. Hold steady at chest",
      3: "3. Act on verified read"
    },
    stepStateLabels: {
      completed: "Done",
      current: "Active step",
      upcoming: "Up next"
    },
    emptyHeadline: "No daily scheduled pills saved yet",
    emptyBody:
      "Add your daily schedule in My Profile, or press Start Pill Check to read any medicine package aloud.",
    dueHeadline: (medTitle, slotLabel) => `Next scheduled pill: ${medTitle} (${slotLabel})`,
    dueBody: (medTitle) =>
      `Pick up one box for ${medTitle} and press the button below to read and compare the printed label against your saved checklist.`,
    allTakenHeadline: (total) =>
      `All ${total} scheduled ${total === 1 ? "dose" : "doses"} taken for today`,
    allTakenBody:
      "Every scheduled pill on your daily checklist is already logged today. You can rest easy or check another package if needed.",
    cameraHeadline: (medTitle) =>
      medTitle
        ? `Hold ${medTitle} steady at chest height`
        : "Hold the medicine box steady at chest height",
    cameraBody:
      "Rest your elbows lightly against your sides, hold the box 25 to 30 cm from your chest with thumbs off the printed text, and wait for the verified read.",
    matchHeadline: (medTitle) => `Verified checklist match: ${medTitle}`,
    matchBody:
      "Printed label matches your saved checklist entry. After taking your pill, press Log Dose Taken to record it on this device.",
    doubleDoseHeadline: (medTitle) => `Stop: ${medTitle} is already logged today`,
    doubleDoseBody:
      "Double-dose guard blocked logging because today's scheduled dose is already recorded on this device. Set the box down and check your dose log or ask a pharmacist before taking another tablet.",
    doubleDoseBlockedPill: "Dose logging blocked: already logged today",
    warningHeadline: "Stop and check with a pharmacist before use",
    warningBody: (detail) =>
      `Safety warning (${detail}). Set this package aside and confirm the printed label with a pharmacist or caregiver before use.`,
    unsureHeadline: (below80) =>
      below80
        ? "Strength below 80% certainty: dose never guessed"
        : "Label text is not clear enough to confirm",
    unsureBody:
      "HoldUp never guesses an unclear medication dose. Turn the box toward steady light and re-aim the camera, or ask a pharmacist to read the package.",
    infoHeadline: (title) => `Label read complete: ${title}`,
    infoBody:
      "This item is not a scheduled daily dose to log. Press Repeat Verdict Aloud to hear the summary again, or start a new check.",
    btnStartDue: (medTitle) => `Start Check for ${medTitle}`,
    btnStartGeneral: "Start Pill Check",
    btnStartExtra: "Check Another Package",
    btnRecheckSteady: "Camera Active: Re-run Check",
    btnLogVerified: (medTitle) => `Log Dose Taken (${medTitle})`,
    btnRepeatVerdict: "Repeat Verdict Aloud",
    btnReaimCheck: "Re-aim Camera and Check Again",
    btnCheckDifferentBox: "Check a Different Box",
    mdrNote:
      "EU MDR Art. 2(1) non-medical assistive label reader. Always confirm uncertain, mismatched, or warning packages with a pharmacist."
  },
  fi: {
    eyebrow: "Yksi rauhallinen vaihe kerrallaan",
    heading: "Ohjattu 3 vaiheen lääkerutiini",
    subtitle: "Selkeä yhden toiminnon opastus säännöllisten päivälääkkeiden tarkistukseen ja kirjaukseen",
    onDevicePill: "Vain tällä laitteella",
    stepsListAria: "Kolmivaiheinen lääkkeen tarkistusrutiini",
    calloutAria: "Seuraava turvallinen toimenpide",
    progressBadge: (taken, remaining, total) =>
      total === 0
        ? "0 säännöllistä annosta tänään"
        : remaining === 0
          ? `Kaikki ${total} säännöllistä otettu tänään`
          : `${taken} otettu, ${remaining} jäljellä tänään`,
    slotNames: {
      morning: "Aamu",
      noon: "Päivä",
      evening: "Ilta",
      bedtime: "Yö"
    },
    stepTitles: {
      1: "1. Valitse vuorossa oleva lääke",
      2: "2. Pidä vakaasti rinnan korkeudella",
      3: "3. Toimi tarkistuksen mukaan"
    },
    stepStateLabels: {
      completed: "Valmis",
      current: "Nykyinen vaihe",
      upcoming: "Seuraavana"
    },
    emptyHeadline: "Ei tallennettuja säännöllisiä päivälääkkeitä",
    emptyBody:
      "Lisää päivän lääkelista Omat tiedot -välilehdellä tai paina Aloita lääketarkistus lukeaksesi minkä tahansa pakkauksen ääneen.",
    dueHeadline: (medTitle, slotLabel) => `Seuraava säännöllinen lääke: ${medTitle} (${slotLabel})`,
    dueBody: (medTitle) =>
      `Ota esiin yksi ${medTitle} -pakkaus ja paina alla olevaa painiketta verrataksesi painettua etikettiä tallennettuun muistilistaasi.`,
    allTakenHeadline: (total) =>
      `Kaikki päivän ${total} säännöllistä ${total === 1 ? "annos" : "annosta"} on kirjattu`,
    allTakenBody:
      "Päivän säännölliset lääkkeet on jo kirjattu otetuiksi. Voit olla rauhallisin mielin tai tarkistaa tarvittaessa toisen pakkauksen.",
    cameraHeadline: (medTitle) =>
      medTitle
        ? `Pidä ${medTitle} vakaasti rinnan korkeudella`
        : "Pidä lääkepakkaus vakaasti rinnan korkeudella",
    cameraBody:
      "Tue kyynärpäät kevyesti kylkiin, pidä pakkaus 25-30 cm etäisyydellä rinnasta peukalot poissa tekstin päältä ja odota vahvistettua lukutulosta.",
    matchHeadline: (medTitle) => `Vahvistettu muistilistaosuma: ${medTitle}`,
    matchBody:
      "Painettu etiketti vastaa tallennettua muistilistaasi. Kun olet ottanut lääkkeen, paina Kirjaa otettu annos tallentaaksesi sen tälle laitteelle.",
    doubleDoseHeadline: (medTitle) => `Seis: ${medTitle} on jo kirjattu tälle päivälle`,
    doubleDoseBody:
      "Kaksoisannosesto esti kirjauksen, koska päivän säännöllinen annos on jo merkitty tälle laitteelle. Laske pakkaus alas ja tarkista annosloki tai kysy apteekista ennen uuden tabletin ottamista.",
    doubleDoseBlockedPill: "Annoskirjaus estetty: jo kirjattu tänään",
    warningHeadline: "Pysähdy ja varmista pakkaus apteekista ennen käyttöä",
    warningBody: (detail) =>
      `Turvallisuusvaroitus (${detail}). Siirrä pakkaus sivuun ja varmista painettu etiketti apteekista tai läheiseltä ennen käyttöä.`,
    unsureHeadline: (below80) =>
      below80
        ? "Vahvuus alle 80 % varmuuden: annosta ei koskaan arvata"
        : "Etiketin teksti ei näy vielä riittävän selvästi",
    unsureBody:
      "HoldUp ei koskaan arvaa epäselvää lääkeannosta. Käännä pakkaus tasaisempaan valoon ja suuntaa kamera uudelleen tai pyydä apteekkia tarkistamaan pakkaus.",
    infoHeadline: (title) => `Etiketin luku valmis: ${title}`,
    infoBody:
      "Tämä pakkaus ei ole kirjattava säännöllinen päiväannos. Paina Toista tulos ääneen kuullaksesi yhteenvedon uudelleen tai aloita uusi tarkistus.",
    btnStartDue: (medTitle) => `Aloita tarkistus: ${medTitle}`,
    btnStartGeneral: "Aloita lääketarkistus",
    btnStartExtra: "Tarkista toinen pakkaus",
    btnRecheckSteady: "Kamera päällä: tarkista uudelleen",
    btnLogVerified: (medTitle) => `Kirjaa otettu annos (${medTitle})`,
    btnRepeatVerdict: "Toista tulos ääneen",
    btnReaimCheck: "Suuntaa kamera ja tarkista uudelleen",
    btnCheckDifferentBox: "Tarkista eri pakkaus",
    mdrNote:
      "EU MDR Art. 2(1) -rajauksen mukainen ei-lääkinnällinen avustava etiketinlukija. Varmista epävarmat, poikkeavat tai varoittavat pakkaukset aina apteekista."
  },
  sv: {
    eyebrow: "Ett lugnt steg i taget",
    heading: "Guidad 3-stegs medicinrutin",
    subtitle: "Lugn steg-för-steg-hjälp med låg kognitiv belastning för schemalagda dagliga mediciner",
    onDevicePill: "Endast på den här enheten",
    stepsListAria: "Medicinrutin i tre steg",
    calloutAria: "Nästa säkra åtgärd",
    progressBadge: (taken, remaining, total) =>
      total === 0
        ? "0 schemalagda doser idag"
        : remaining === 0
          ? `Alla ${total} schemalagda tagna idag`
          : `${taken} tagna, ${remaining} kvar idag`,
    slotNames: {
      morning: "Morgon",
      noon: "Lunch",
      evening: "Kväll",
      bedtime: "Natt"
    },
    stepTitles: {
      1: "1. Välj aktuell medicin",
      2: "2. Håll stilla i brösthöjd",
      3: "3. Följ verifierat besked"
    },
    stepStateLabels: {
      completed: "Klar",
      current: "Aktivt steg",
      upcoming: "Nästa"
    },
    emptyHeadline: "Inga schemalagda dagliga mediciner sparade ännu",
    emptyBody:
      "Lägg till ditt dagliga schema under Min profil, eller tryck på Starta medicinkontroll för att läsa upp valfri förpackning.",
    dueHeadline: (medTitle, slotLabel) => `Nästa schemalagda medicin: ${medTitle} (${slotLabel})`,
    dueBody: (medTitle) =>
      `Ta fram en förpackning med ${medTitle} och tryck på knappen nedan för att läsa och jämföra den tryckta etiketten mot din sparade checklista.`,
    allTakenHeadline: (total) =>
      `Alla ${total} schemalagda ${total === 1 ? "dos" : "doser"} är tagna för idag`,
    allTakenBody:
      "Alla schemalagda mediciner på dagens lista är redan registrerade. Du kan känna dig trygg eller kontrollera en annan förpackning vid behov.",
    cameraHeadline: (medTitle) =>
      medTitle
        ? `Håll ${medTitle} stilla i brösthöjd`
        : "Håll medicinförpackningen stilla i brösthöjd",
    cameraBody:
      "Stöd armbågarna lätt mot sidorna, håll förpackningen 25-30 cm från bröstet med tummarna borta från texten och vänta på verifierad avläsning.",
    matchHeadline: (medTitle) => `Verifierad träff på din lista: ${medTitle}`,
    matchBody:
      "Den tryckta etiketten stämmer med din sparade checklista. När du har tagit tabletten trycker du på Registrera tagen dos för att spara lokalt.",
    doubleDoseHeadline: (medTitle) => `Stopp: ${medTitle} är redan registrerad idag`,
    doubleDoseBody:
      "Dubbeldosspärren blockerade registrering eftersom dagens schemalagda dos redan är loggad på den här enheten. Lägg ner förpackningen och kontrollera dosloggen eller fråga apotekspersonal.",
    doubleDoseBlockedPill: "Dosregistrering blockerad: redan registrerad idag",
    warningHeadline: "Stanna upp och kontrollera med apotekspersonal före användning",
    warningBody: (detail) =>
      `Säkerhetsvarning (${detail}). Lägg förpackningen åt sidan och kontrollera etiketten med apotekspersonal eller närstående före användning.`,
    unsureHeadline: (below80) =>
      below80
        ? "Styrka under 80 % säkerhet: dosen gissas aldrig"
        : "Etikettexten är inte tillräckligt tydlig ännu",
    unsureBody:
      "HoldUp gissar aldrig en otydlig läkemedelsdos. Vänd förpackningen mot jämnt ljus och rikta om kameran, eller be apotekspersonal bekräfta etiketten.",
    infoHeadline: (title) => `Etikettavläsning klar: ${title}`,
    infoBody:
      "Den här förpackningen är inte en schemalagd daglig dos att registrera. Tryck på Upprepa besked högt för att höra sammanfattningen igen eller starta en ny kontroll.",
    btnStartDue: (medTitle) => `Starta kontroll för ${medTitle}`,
    btnStartGeneral: "Starta medicinkontroll",
    btnStartExtra: "Kontrollera en annan förpackning",
    btnRecheckSteady: "Kamera aktiv: kontrollera igen",
    btnLogVerified: (medTitle) => `Registrera tagen dos (${medTitle})`,
    btnRepeatVerdict: "Upprepa besked högt",
    btnReaimCheck: "Rikta om kameran och kontrollera igen",
    btnCheckDifferentBox: "Kontrollera en annan ask",
    mdrNote:
      "Icke-medicinteknisk assisterande etikettläsare enligt EU MDR Art. 2(1). Kontrollera alltid osäkra, avvikande eller varningsflaggade förpackningar med apotekspersonal."
  }
};

type TonePalette = {
  bgVar: string;
  fgVar: string;
  borderVar: string;
  borderStyle: "solid" | "double" | "dashed";
};

const TONE_PALETTE: Record<RoutineTone, TonePalette> = {
  match: {
    bgVar: "var(--verdict-match-bg, #06261d)",
    fgVar: "var(--verdict-match-fg, #7ef7c8)",
    borderVar: "var(--verdict-match-border, #2dd4a0)",
    borderStyle: "solid"
  },
  warning: {
    bgVar: "var(--verdict-warning-bg, #2d0e0a)",
    fgVar: "var(--verdict-warning-fg, #ffb8ab)",
    borderVar: "var(--verdict-warning-border, #ff6b52)",
    borderStyle: "double"
  },
  unsure: {
    bgVar: "var(--verdict-unsure-bg, #261b04)",
    fgVar: "var(--verdict-unsure-fg, #ffe169)",
    borderVar: "var(--verdict-unsure-border, #f5b82e)",
    borderStyle: "dashed"
  },
  info: {
    bgVar: "var(--verdict-info-bg, #0a1f38)",
    fgVar: "var(--verdict-info-fg, #a6d4ff)",
    borderVar: "var(--verdict-info-border, #4da3ff)",
    borderStyle: "solid"
  }
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

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  minHeight: "60px",
  minWidth: "60px",
  width: "100%",
  padding: "14px 22px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "10px",
  fontSize: "var(--text-lg, 1.25rem)",
  fontWeight: 800,
  lineHeight: 1.25
};

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  minHeight: "60px",
  minWidth: "60px",
  padding: "12px 20px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700,
  lineHeight: 1.25
};

const ICON_STYLE: CSSProperties = {
  width: "22px",
  height: "22px",
  flexShrink: 0
};

function StepMarkerIcon({ state }: { state: StepVisualState }) {
  if (state === "completed") {
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
        data-step-icon="completed"
        style={ICON_STYLE}
      >
        <circle cx="12" cy="12" r="9.5" />
        <path d="M8 12.4l2.7 2.8L16.4 9.5" />
      </svg>
    );
  }

  if (state === "current") {
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
        data-step-icon="current"
        style={ICON_STYLE}
      >
        <circle cx="12" cy="12" r="9.5" />
        <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
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
      data-step-icon="upcoming"
      style={ICON_STYLE}
    >
      <circle cx="12" cy="12" r="9.5" strokeDasharray="3 3" />
    </svg>
  );
}

function CalloutOutcomeIcon({ tone }: { tone: RoutineTone }) {
  if (tone === "match") {
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
        data-routine-icon="match"
        style={ICON_STYLE}
      >
        <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
        <path d="M8.4 12.3l2.4 2.5 4.9-5.1" />
      </svg>
    );
  }

  if (tone === "warning") {
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
        data-routine-icon="warning"
        style={ICON_STYLE}
      >
        <path d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2L8.2 2z" />
        <line x1="12" y1="7.5" x2="12" y2="13" />
        <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (tone === "unsure") {
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
        data-routine-icon="unsure"
        style={ICON_STYLE}
      >
        <polygon points="12 2 22 12 12 22 2 12 12 2" />
        <line x1="12" y1="8" x2="12" y2="13" />
        <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
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
      data-routine-icon="info"
      style={ICON_STYLE}
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function CognitiveRoutineCard(props: CognitiveRoutineCardProps) {
  const {
    profile,
    cameraActive,
    lastVerdict,
    lang,
    now,
    onStartCheck,
    onLogDose,
    onRepeatVerdict
  } = props;

  const uid = useId();
  const locale = normalizeLang(lang ?? profile?.lang ?? "en");
  const copy = COPY_BY_LOCALE[locale];
  const routine = deriveRoutineStep(profile, cameraActive, lastVerdict, now);
  const palette = TONE_PALETTE[routine.tone];

  const headingId = `${uid}-cognitive-routine-heading`;
  const nextMedTitle = routine.nextScheduledMed
    ? formatMedTitle(routine.nextScheduledMed)
    : null;
  const nextSlotLabel = routine.nextScheduledSlot
    ? copy.slotNames[routine.nextScheduledSlot]
    : "";
  const verdictMedTitle = lastVerdict ? resolveVerdictMedLabel(lastVerdict, profile) : "";
  const verdictHeadlineClean = lastVerdict
    ? sanitizeDisplayText(lastVerdict.headline) || verdictMedTitle
    : "";

  let calloutHeadline = "";
  let calloutBody = "";
  let primaryButtonLabel = copy.btnStartGeneral;

  switch (routine.outcome) {
    case "empty_profile":
      calloutHeadline = copy.emptyHeadline;
      calloutBody = copy.emptyBody;
      primaryButtonLabel = copy.btnStartGeneral;
      break;
    case "due_pill":
      calloutHeadline = copy.dueHeadline(nextMedTitle ?? "", nextSlotLabel);
      calloutBody = copy.dueBody(nextMedTitle ?? "");
      primaryButtonLabel = nextMedTitle ? copy.btnStartDue(nextMedTitle) : copy.btnStartGeneral;
      break;
    case "all_taken":
      calloutHeadline = copy.allTakenHeadline(routine.scheduledTotal);
      calloutBody = copy.allTakenBody;
      primaryButtonLabel = copy.btnStartExtra;
      break;
    case "camera_coaching":
      calloutHeadline = copy.cameraHeadline(nextMedTitle);
      calloutBody = copy.cameraBody;
      primaryButtonLabel = copy.btnRecheckSteady;
      break;
    case "verified_match":
      calloutHeadline = copy.matchHeadline(verdictMedTitle);
      calloutBody = copy.matchBody;
      primaryButtonLabel = copy.btnLogVerified(verdictMedTitle);
      break;
    case "double_dose_blocked":
      calloutHeadline = copy.doubleDoseHeadline(verdictMedTitle);
      calloutBody = copy.doubleDoseBody;
      primaryButtonLabel = copy.btnRepeatVerdict;
      break;
    case "safety_warning":
      calloutHeadline = copy.warningHeadline;
      calloutBody = copy.warningBody(verdictHeadlineClean);
      primaryButtonLabel = copy.btnRepeatVerdict;
      break;
    case "unsure_reaim":
      calloutHeadline = copy.unsureHeadline(routine.belowStrengthThreshold);
      calloutBody = copy.unsureBody;
      primaryButtonLabel = copy.btnReaimCheck;
      break;
    case "info_read":
      calloutHeadline = copy.infoHeadline(verdictHeadlineClean);
      calloutBody = copy.infoBody;
      primaryButtonLabel = copy.btnRepeatVerdict;
      break;
  }

  const handlePrimaryClick = (): void => {
    if (routine.primaryAction === "log_dose") {
      if (routine.canLogDose) {
        onLogDose?.(routine.matchedMedId ?? undefined);
      }
      return;
    }
    if (routine.primaryAction === "repeat_verdict") {
      onRepeatVerdict?.();
      return;
    }
    onStartCheck?.();
  };

  const showSecondaryRepeat =
    routine.activeStep === 3 &&
    routine.primaryAction !== "repeat_verdict" &&
    typeof onRepeatVerdict === "function";

  const showSecondaryStart =
    routine.activeStep === 3 &&
    routine.primaryAction === "repeat_verdict" &&
    typeof onStartCheck === "function";

  const stepNumbers: readonly RoutineStepNumber[] = [1, 2, 3];

  return (
    <section
      className="card cognitive-routine-card"
      lang={locale}
      aria-labelledby={headingId}
      data-active-step={String(routine.activeStep)}
      data-routine-outcome={routine.outcome}
      data-double-dose-blocked={String(routine.doubleDoseBlocked)}
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
          <span
            className="cognitive-routine-eyebrow"
            style={{
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.eyebrow}
          </span>

          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--space-2, 8px)"
            }}
          >
            <span
              className="badge cognitive-routine-progress-badge"
              data-scheduled-taken={String(routine.scheduledTaken)}
              data-scheduled-remaining={String(routine.scheduledRemaining)}
              style={{
                minHeight: "34px",
                padding: "6px 12px",
                borderRadius: "var(--radius-pill, 9999px)",
                backgroundColor:
                  routine.allScheduledTaken
                    ? "var(--verdict-match-bg, #06261d)"
                    : "var(--bg-elevated, #1a2333)",
                color:
                  routine.allScheduledTaken
                    ? "var(--verdict-match-fg, #7ef7c8)"
                    : "var(--text-primary, #f8fafc)",
                border:
                  routine.allScheduledTaken
                    ? "2px solid var(--verdict-match-border, #2dd4a0)"
                    : "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums"
              }}
            >
              {copy.progressBadge(
                routine.scheduledTaken,
                routine.scheduledRemaining,
                routine.scheduledTotal
              )}
            </span>

            <span
              className="pill cognitive-routine-privacy-pill"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 700
              }}
            >
              {copy.onDevicePill}
            </span>
          </div>
        </div>

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

        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-secondary, #d8e1ee)",
            lineHeight: 1.45
          }}
        >
          {copy.subtitle}
        </p>
      </header>

      <ol
        className="cognitive-routine-steps"
        aria-label={copy.stepsListAria}
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        {stepNumbers.map((stepNum) => {
          const isCurrent = stepNum === routine.activeStep;
          const isCompleted = stepNum < routine.activeStep;
          const visualState: StepVisualState = isCurrent
            ? "current"
            : isCompleted
              ? "completed"
              : "upcoming";

          const stepBg = isCurrent
            ? palette.bgVar
            : isCompleted
              ? "var(--verdict-match-bg, #06261d)"
              : "var(--bg-elevated, #1a2333)";
          const stepFg = isCurrent
            ? palette.fgVar
            : isCompleted
              ? "var(--verdict-match-fg, #7ef7c8)"
              : "var(--text-secondary, #d8e1ee)";
          const stepBorder = isCurrent
            ? `2.5px ${palette.borderStyle} ${palette.borderVar}`
            : isCompleted
              ? "2px solid var(--verdict-match-border, #2dd4a0)"
              : "1.5px dashed var(--border-subtle, #2c3a52)";

          return (
            <li
              key={stepNum}
              className={`cognitive-routine-step cognitive-routine-step-${visualState}`}
              data-step={String(stepNum)}
              data-step-state={visualState}
              aria-current={isCurrent ? "step" : undefined}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "var(--space-3, 12px) var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: stepBg,
                color: stepFg,
                border: stepBorder
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <StepMarkerIcon state={visualState} />
                <span
                  className="cognitive-routine-step-badge"
                  style={{
                    fontSize: "var(--text-xs, 0.875rem)",
                    fontWeight: 800
                  }}
                >
                  {copy.stepStateLabels[visualState]}
                </span>
              </div>

              <span
                className="cognitive-routine-step-title"
                style={{
                  fontSize: "var(--text-base, 1.125rem)",
                  fontWeight: isCurrent ? 800 : 700,
                  lineHeight: 1.3,
                  color: "var(--text-primary, #f8fafc)"
                }}
              >
                {copy.stepTitles[stepNum]}
              </span>
            </li>
          );
        })}
      </ol>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={copy.calloutAria}
        className={`cognitive-routine-callout cognitive-routine-callout-${routine.tone}`}
        data-callout-tone={routine.tone}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: palette.bgVar,
          color: palette.fgVar,
          border: `2.5px ${palette.borderStyle} ${palette.borderVar}`
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px"
          }}
        >
          <CalloutOutcomeIcon tone={routine.tone} />
          <h3
            className="cognitive-routine-callout-headline"
            style={{
              margin: 0,
              fontSize: "var(--text-xl, 1.5rem)",
              fontWeight: 800,
              lineHeight: 1.3,
              color: palette.fgVar
            }}
          >
            {calloutHeadline}
          </h3>
        </div>

        <p
          className="cognitive-routine-callout-body"
          style={{
            margin: 0,
            fontSize: "var(--text-lg, 1.25rem)",
            fontWeight: 600,
            lineHeight: 1.5,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {calloutBody}
        </p>

        {routine.doubleDoseBlocked ? (
          <div
            className="pill cognitive-routine-double-dose-pill"
            data-dose-log-blocked="true"
            style={{
              alignSelf: "flex-start",
              backgroundColor: "var(--bg-surface, #121926)",
              color: palette.fgVar,
              border: `2px solid ${palette.borderVar}`,
              fontWeight: 800,
              fontSize: "var(--text-sm, 1rem)"
            }}
          >
            <span>{copy.doubleDoseBlockedPill}</span>
          </div>
        ) : null}
      </div>

      <div
        className="cognitive-routine-actions"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)"
        }}
      >
        <button
          type="button"
          className="btn btn-primary btn-lg cognitive-routine-primary-btn"
          data-primary-action={routine.primaryAction}
          aria-label={primaryButtonLabel}
          onClick={handlePrimaryClick}
          style={PRIMARY_BUTTON_STYLE}
        >
          <span>{primaryButtonLabel}</span>
        </button>

        {showSecondaryRepeat ? (
          <button
            type="button"
            className="btn btn-secondary cognitive-routine-secondary-btn"
            data-secondary-action="repeat_verdict"
            aria-label={copy.btnRepeatVerdict}
            onClick={() => onRepeatVerdict?.()}
            style={SECONDARY_BUTTON_STYLE}
          >
            <span>{copy.btnRepeatVerdict}</span>
          </button>
        ) : null}

        {showSecondaryStart ? (
          <button
            type="button"
            className="btn btn-secondary cognitive-routine-secondary-btn"
            data-secondary-action="start_check"
            aria-label={copy.btnCheckDifferentBox}
            onClick={() => onStartCheck?.()}
            style={SECONDARY_BUTTON_STYLE}
          >
            <span>{copy.btnCheckDifferentBox}</span>
          </button>
        ) : null}
      </div>

      <p
        className="cognitive-routine-mdr-note"
        style={{
          margin: 0,
          fontSize: "var(--text-xs, 0.875rem)",
          lineHeight: 1.45,
          color: "var(--text-secondary, #d8e1ee)"
        }}
      >
        {copy.mdrNote}
      </p>
    </section>
  );
}

export default CognitiveRoutineCard;
