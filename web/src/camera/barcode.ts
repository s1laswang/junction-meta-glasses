import type { LabelRead, Med, Profile, Verdict } from "../types.ts";

const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"];

const DRUG_CLASSES: Record<string, string[]> = {
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "aspirin", "ketoprofen", "etoricoxib", "celecoxib", "meloxicam", "dexketoprofen"],
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "phenoxymethylpenicillin", "flucloxacillin", "dicloxacillin", "pivmecillinam"],
  benzodiazepine: ["diazepam", "oxazepam", "temazepam", "alprazolam", "lorazepam"],
  opioid: ["codeine", "tramadol", "oxycodone", "morphine", "buprenorphine", "fentanyl"],
  statin: ["simvastatin", "atorvastatin", "rosuvastatin"]
};

const CLASS_ALIASES: Record<string, string> = {
  nsaid: "nsaid",
  nsaids: "nsaid",
  "anti-inflammatory": "nsaid",
  "anti-inflammatories": "nsaid",
  "anti inflammatories": "nsaid",
  penicillin: "penicillin",
  penicillins: "penicillin",
  benzodiazepine: "benzodiazepine",
  benzodiazepines: "benzodiazepine",
  opioid: "opioid",
  opioids: "opioid",
  statin: "statin",
  statins: "statin"
};

export function normalizeBarcode(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 12) {
    return `0${digits}`;
  }
  return digits;
}

export function isBarcodeDetectorSupported(): boolean {
  return typeof (globalThis as any).BarcodeDetector === "function";
}

export async function detectBarcodeFromElement(
  el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<string | null> {
  if (!el || !isBarcodeDetectorSupported()) {
    return null;
  }
  try {
    const Detector = (globalThis as any).BarcodeDetector;
    const detector = new Detector({ formats: BARCODE_FORMATS });
    const results = await detector.detect(el);
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }
    for (const item of results) {
      const raw = typeof item?.rawValue === "string" ? item.rawValue.trim() : "";
      if (!raw) continue;
      const normalized = normalizeBarcode(raw);
      return normalized || raw;
    }
    return null;
  } catch {
    return null;
  }
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function formatStrength(raw: string): string {
  return raw.trim().replace(/(\d)\s*(mg|g|mcg|ug|ml|iu)\b/gi, "$1 $2");
}

function clampHeadline(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 8) return words.join(" ");
  return words.slice(0, 8).join(" ").replace(/[,.;:]$/, "");
}

function clampSpeech(text: string): string {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ")
    .trim();
}

function schedulePhrase(med: Med): string {
  const entries = med.schedule.map((item) => item.toLowerCase());
  for (const slot of ["morning", "noon", "midday", "afternoon", "evening", "night", "bedtime"]) {
    if (entries.some((item) => item.includes(slot))) {
      return `, your ${slot} pill`;
    }
  }
  if (entries.length === 1) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(entries[0].trim());
    if (match) {
      const hour = Number(match[1]);
      const slot = hour < 11 ? "morning" : hour < 15 ? "midday" : hour < 21 ? "evening" : "night";
      return `, your ${slot} pill`;
    }
  }
  return "";
}

function findAvoidMatches(med: Med, avoidList: string[]): string[] {
  const nameLower = med.name.trim().toLowerCase();
  const ingLower = med.ingredient.trim().toLowerCase();
  const combined = `${nameLower} ${ingLower}`.trim();
  const matches: string[] = [];

  for (const rawEntry of avoidList) {
    const entry = rawEntry.trim();
    const lower = entry.toLowerCase();
    if (!lower) continue;

    const classKey = CLASS_ALIASES[lower];
    if (classKey && DRUG_CLASSES[classKey].some((drug) => combined.includes(drug))) {
      matches.push(`${entry} is on your avoid list`);
      continue;
    }

    const byName = Boolean(nameLower) && (nameLower.includes(lower) || (nameLower.length >= 3 && lower.includes(nameLower)));
    const byIngredient = Boolean(ingLower) && (ingLower.includes(lower) || (ingLower.length >= 3 && lower.includes(ingLower)));
    if (byName || byIngredient) {
      matches.push(`${entry} is on your avoid list`);
    }
  }

  return matches;
}

function countDosesSinceMidnight(profile: Profile, medId: string, now: Date): number {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const doseLog = Array.isArray(profile.doseLog) ? profile.doseLog : [];
  return doseLog.filter(
    (entry) => entry.medId === medId && entry.ts >= startOfDay.getTime() && entry.ts <= endOfDay.getTime()
  ).length;
}

function buildUnknownOfflineRead(normalized: string): LabelRead {
  const empty = { value: null, confidence: 0 };
  return {
    kind: "unreadable",
    product: empty,
    ingredient: empty,
    strength: empty,
    dosing: empty,
    expiry: empty,
    allergens: empty,
    barcode: normalized ? { value: normalized, confidence: 0.99 } : empty,
    readability: 0,
    guidance: "Reconnect to read new labels, or ask a pharmacist."
  };
}

function buildMatchedOfflineRead(med: Med, normalized: string): LabelRead {
  const empty = { value: null, confidence: 0 };
  const productVal = med.name.trim() || med.ingredient.trim();
  const ingredientVal = med.ingredient.trim();
  const strengthVal = formatStrength(med.strength);
  return {
    kind: "medication",
    product: productVal ? { value: productVal, confidence: 0.95 } : empty,
    ingredient: ingredientVal ? { value: ingredientVal, confidence: 0.95 } : empty,
    strength: strengthVal ? { value: strengthVal, confidence: 0.95 } : empty,
    dosing: empty,
    expiry: empty,
    allergens: empty,
    barcode: { value: normalized, confidence: 0.99 },
    readability: 0.95
  };
}

export function offlineBarcodeVerdict(barcode: string, profile: Profile, now = new Date()): Verdict {
  const normalized = normalizeBarcode(barcode);
  const meds = Array.isArray(profile.meds) ? profile.meds : [];
  const med = normalized
    ? meds.find((candidate) => Boolean(candidate.barcode) && normalizeBarcode(candidate.barcode) === normalized)
    : undefined;

  if (!med) {
    return {
      level: "unsure",
      headline: "Offline: unknown barcode",
      speech:
        "You are offline and this barcode is not in your saved medications. Reconnect to read new labels, or ask a pharmacist.",
      read: buildUnknownOfflineRead(normalized),
      reasons: [normalized ? "offline mode: unknown barcode" : "offline mode: no barcode"]
    };
  }

  const read = buildMatchedOfflineRead(med, normalized);
  const avoidList = Array.isArray(profile.avoid) ? profile.avoid : [];
  const avoidHits = findAvoidMatches(med, avoidList);
  const dosesTodayCount = countDosesSinceMidnight(profile, med.id, now);
  const maxDailyDoses = Math.max(1, med.schedule.length);
  const takenToday = dosesTodayCount > 0;

  const primaryName = capitalize((med.ingredient || med.name || "Medication").trim());
  const strengthText = formatStrength(med.strength);
  const shortLabel = strengthText ? `${primaryName} ${strengthText}` : primaryName;
  const brandSuffix =
    med.name.trim() && med.ingredient.trim() && med.name.trim().toLowerCase() !== med.ingredient.trim().toLowerCase()
      ? ` (${med.name.trim()})`
      : "";
  const fullLabel = `${shortLabel}${brandSuffix}`;
  const slotText = schedulePhrase(med);

  if (avoidHits.length > 0) {
    const doseSummary =
      dosesTodayCount === 0
        ? "not taken today"
        : dosesTodayCount === 1
          ? "taken once today"
          : `taken ${dosesTodayCount} times today`;
    return {
      level: "warning",
      headline: clampHeadline(`Offline warning: avoid ${primaryName}`),
      speech: clampSpeech(
        `Offline barcode match for ${fullLabel}, which is on your avoid list. Do not take it (${doseSummary}).`
      ),
      read,
      matchedMedId: med.id,
      takenToday,
      reasons: [`offline barcode match: ${med.id}`, ...avoidHits, `taken today: ${dosesTodayCount}/${maxDailyDoses}`]
    };
  }

  if (dosesTodayCount >= maxDailyDoses) {
    const doseSentence =
      dosesTodayCount === 1
        ? "You already took it today."
        : `You already took all ${dosesTodayCount} doses today.`;
    return {
      level: "warning",
      headline: clampHeadline(`Offline: ${shortLabel} already taken`),
      speech: clampSpeech(`Offline barcode match: ${fullLabel}${slotText}. ${doseSentence}`),
      read,
      matchedMedId: med.id,
      takenToday: true,
      reasons: [`offline barcode match: ${med.id}`, `taken today: ${dosesTodayCount}/${maxDailyDoses}`]
    };
  }

  const remainingSentence =
    dosesTodayCount === 0
      ? "You haven't taken it today."
      : `You have taken ${dosesTodayCount} of ${maxDailyDoses} doses today.`;

  return {
    level: "match",
    headline: clampHeadline(`Offline match: ${shortLabel}`),
    speech: clampSpeech(`Offline barcode match: ${fullLabel}${slotText}. ${remainingSentence}`),
    read,
    matchedMedId: med.id,
    takenToday,
    reasons: [`offline barcode match: ${med.id}`, `taken today: ${dosesTodayCount}/${maxDailyDoses}`]
  };
}
