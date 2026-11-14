import type { Med, Profile } from "../types.ts";

export type PharmacyRxPayload = {
  v: 1;
  pharmacy?: string;
  meds: Med[];
  allergies?: string[];
  avoid?: string[];
};

const MAX_RAW_URI_LENGTH = 16384;
const MAX_PHARMACY_LENGTH = 120;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_INGREDIENT_LENGTH = 120;
const MAX_STRENGTH_LENGTH = 64;
const MAX_BARCODE_LENGTH = 32;
const MAX_NOTES_LENGTH = 240;
const MAX_SCHEDULE_ITEMS = 12;
const MAX_SCHEDULE_ITEM_LENGTH = 48;
const MAX_MEDS = 50;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_LENGTH = 80;

const INN_ALIASES: Record<string, string> = {
  amlodipin: "amlodipine",
  amlodipiini: "amlodipine",
  atorvastatiini: "atorvastatin",
  bisoprololi: "bisoprolol",
  ibuprofeeni: "ibuprofen",
  levotyroksiini: "levothyroxine",
  metformiini: "metformin",
  naprokseeni: "naproxen",
  parasetamoli: "paracetamol",
  acetaminophen: "paracetamol",
  ramipriili: "ramipril",
  simvastatiini: "simvastatin",
  varfariini: "warfarin"
};

const UNIT_SCALE: Record<string, { unit: string; factor: number }> = {
  mg: { unit: "mg", factor: 1 },
  g: { unit: "mg", factor: 1000 },
  mcg: { unit: "mg", factor: 0.001 },
  ug: { unit: "mg", factor: 0.001 },
  mikrog: { unit: "mg", factor: 0.001 },
  microgram: { unit: "mg", factor: 0.001 },
  ml: { unit: "ml", factor: 1 },
  iu: { unit: "iu", factor: 1 },
  ky: { unit: "iu", factor: 1 },
  "%": { unit: "%", factor: 1 }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(raw: string, maxLen: number): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .trim();
}

function normalizeStrength(raw: string): string {
  const cleaned = cleanText(raw, MAX_STRENGTH_LENGTH)
    .replace(/(?<=\d),(?=\d)/g, ".")
    .replace(/(\d)\s*(mg|g|mcg|ug|µg|mikrog|microgram|ml|iu|ky)\b/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_STRENGTH_LENGTH).trim();
}

function sanitizeBarcode(raw: string): string {
  return raw.replace(/\D+/g, "").slice(0, MAX_BARCODE_LENGTH);
}

function canonicalBarcode(raw: string | undefined): string {
  if (!raw) return "";
  const digits = sanitizeBarcode(raw);
  if (!digits) return "";
  return digits.length === 12 ? `0${digits}` : digits;
}

function deriveMedId(name: string, ingredient: string, strength: string, index: number): string {
  const base = `${ingredient || name}-${strength}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `rx-${index + 1}`;
}

function sanitizeRxMed(raw: unknown, index: number): Med | null {
  if (!isRecord(raw)) return null;
  if (raw.id !== undefined && raw.id !== null && typeof raw.id !== "string") return null;
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") return null;
  if (raw.ingredient !== undefined && raw.ingredient !== null && typeof raw.ingredient !== "string") return null;
  if (typeof raw.strength !== "string") return null;
  if (raw.schedule !== undefined && raw.schedule !== null && !Array.isArray(raw.schedule)) return null;
  if (raw.barcode !== undefined && raw.barcode !== null && typeof raw.barcode !== "string") return null;
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== "string") return null;

  const name = typeof raw.name === "string" ? cleanText(raw.name, MAX_NAME_LENGTH) : "";
  const ingredient = typeof raw.ingredient === "string" ? cleanText(raw.ingredient, MAX_INGREDIENT_LENGTH) : "";
  const strength = normalizeStrength(raw.strength);

  if ((!name && !ingredient) || !strength || !/\d/.test(strength)) {
    return null;
  }

  const explicitId = typeof raw.id === "string" ? cleanText(raw.id, MAX_ID_LENGTH) : "";
  const id = explicitId || deriveMedId(name, ingredient, strength, index);

  const schedule: string[] = [];
  if (Array.isArray(raw.schedule)) {
    if (raw.schedule.length > MAX_SCHEDULE_ITEMS * 4) return null;
    for (const entry of raw.schedule) {
      if (typeof entry !== "string") return null;
      const item = cleanText(entry, MAX_SCHEDULE_ITEM_LENGTH);
      if (item && schedule.length < MAX_SCHEDULE_ITEMS) {
        schedule.push(item);
      }
    }
  }

  const med: Med = { id, name, ingredient, strength, schedule };

  if (typeof raw.barcode === "string") {
    const digits = sanitizeBarcode(raw.barcode);
    if (digits) {
      med.barcode = digits;
    }
  }

  if (typeof raw.notes === "string") {
    const notes = cleanText(raw.notes, MAX_NOTES_LENGTH);
    if (notes) {
      med.notes = notes;
    }
  }

  return med;
}

function sanitizeOptionalList(raw: unknown): string[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_LIST_ITEMS * 4) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const cleaned = cleanText(item, MAX_LIST_ITEM_LENGTH);
    if (cleaned && out.length < MAX_LIST_ITEMS) {
      out.push(cleaned);
    }
  }
  return out;
}

function validatePayloadObject(raw: unknown): PharmacyRxPayload | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== 1) return null;
  if (raw.pharmacy !== undefined && raw.pharmacy !== null && typeof raw.pharmacy !== "string") {
    return null;
  }
  if (!Array.isArray(raw.meds) || raw.meds.length === 0 || raw.meds.length > MAX_MEDS) {
    return null;
  }

  const meds: Med[] = [];
  for (let i = 0; i < raw.meds.length; i += 1) {
    const med = sanitizeRxMed(raw.meds[i], i);
    if (!med) return null;
    meds.push(med);
  }

  const allergies = sanitizeOptionalList(raw.allergies);
  if (allergies === null) return null;

  const avoid = sanitizeOptionalList(raw.avoid);
  if (avoid === null) return null;

  const result: PharmacyRxPayload = { v: 1, meds };

  if (typeof raw.pharmacy === "string") {
    const pharmacy = cleanText(raw.pharmacy, MAX_PHARMACY_LENGTH);
    if (pharmacy) {
      result.pharmacy = pharmacy;
    }
  }

  if (allergies !== undefined) {
    result.allergies = allergies;
  }

  if (avoid !== undefined) {
    result.avoid = avoid;
  }

  return result;
}

function encodeBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlUtf8(encoded: string): string | null {
  const trimmed = encoded.trim();
  if (!trimmed || trimmed.length > MAX_RAW_URI_LENGTH) return null;
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(standard) || standard.length % 4 === 1) {
    return null;
  }
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function extractDataQueryParam(params: URLSearchParams): string | null {
  if (params.has("v") && params.get("v") !== "1") {
    return null;
  }
  const allData = params.getAll("data");
  if (allData.length !== 1 || !allData[0]) {
    return null;
  }
  return allData[0];
}

function extractJsonFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RAW_URI_LENGTH) {
    return null;
  }

  if (trimmed.startsWith("{")) {
    return trimmed.endsWith("}") ? trimmed : null;
  }

  const holdupMatch = /^holdup:\/\/rx\/?\?([^\s#]+)(?:#.*)?$/i.exec(trimmed);
  if (holdupMatch) {
    const params = new URLSearchParams(holdupMatch[1]);
    const dataParam = extractDataQueryParam(params);
    return dataParam ? decodeBase64UrlUtf8(dataParam) : null;
  }

  if (/^https:\/\//i.test(trimmed)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return null;
    }
    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password ||
      !/(?:^|\/)rx\/?$/i.test(parsedUrl.pathname)
    ) {
      return null;
    }
    const dataParam = extractDataQueryParam(parsedUrl.searchParams);
    return dataParam ? decodeBase64UrlUtf8(dataParam) : null;
  }

  return null;
}

export function encodePharmacyQrUri(payload: PharmacyRxPayload): string {
  const validated = validatePayloadObject(payload);
  const compact: PharmacyRxPayload = validated ?? {
    v: 1,
    ...(typeof payload?.pharmacy === "string" && cleanText(payload.pharmacy, MAX_PHARMACY_LENGTH)
      ? { pharmacy: cleanText(payload.pharmacy, MAX_PHARMACY_LENGTH) }
      : {}),
    meds: Array.isArray(payload?.meds)
      ? payload.meds
          .map((med, idx) => sanitizeRxMed(med, idx))
          .filter((med): med is Med => med !== null)
      : [],
    ...(Array.isArray(payload?.allergies) ? { allergies: sanitizeOptionalList(payload.allergies) ?? [] } : {}),
    ...(Array.isArray(payload?.avoid) ? { avoid: sanitizeOptionalList(payload.avoid) ?? [] } : {})
  };
  const encoded = encodeBase64UrlUtf8(JSON.stringify(compact));
  return `holdup://rx?v=1&data=${encoded}`;
}

export function parsePharmacyQrUri(raw: string): PharmacyRxPayload | null {
  if (typeof raw !== "string") return null;
  try {
    const jsonText = extractJsonFromInput(raw);
    if (!jsonText) return null;
    const parsed: unknown = JSON.parse(jsonText);
    return validatePayloadObject(parsed);
  } catch {
    return null;
  }
}

function canonicalIngredientKey(med: Med): string {
  const source = (med.ingredient.trim() || med.name.trim())
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!source) return "";
  return INN_ALIASES[source] ?? source;
}

function canonicalStrengthKey(rawStrength: string): string {
  const normalized = rawStrength
    .toLowerCase()
    .replace(/(?<=\d),(?=\d)/g, ".")
    .replace(/µ/g, "u")
    .trim();
  if (!normalized) return "";

  const tokens: string[] = [];
  const regex = /(\d+(?:\.\d+)?)\s*(mg|mcg|ug|g|ml|iu|ky|mikrog|microgram)s?\b|(\d+(?:\.\d+)?)\s*(%)/g;
  for (const match of normalized.matchAll(regex)) {
    const num = Number(match[1] ?? match[3]);
    const unitKey = match[2] ?? match[4];
    const scale = UNIT_SCALE[unitKey];
    if (!scale || !Number.isFinite(num)) continue;
    const scaled = Number((num * scale.factor).toFixed(6));
    tokens.push(`${scaled}:${scale.unit}`);
  }
  if (tokens.length > 0) {
    return tokens.join("|");
  }
  return normalized.replace(/\s+/g, "");
}

function cloneMed(med: Med): Med {
  const copy: Med = {
    id: med.id,
    name: med.name,
    ingredient: med.ingredient,
    strength: med.strength,
    schedule: [...med.schedule]
  };
  if (med.barcode !== undefined && med.barcode.trim().length > 0) {
    copy.barcode = med.barcode.trim();
  }
  if (med.notes !== undefined && med.notes.trim().length > 0) {
    copy.notes = med.notes.trim();
  }
  return copy;
}

function isSameMedication(existing: Med, incoming: Med): boolean {
  const exBarcode = canonicalBarcode(existing.barcode);
  const inBarcode = canonicalBarcode(incoming.barcode);
  if (exBarcode && inBarcode && exBarcode === inBarcode) {
    return true;
  }
  const exIng = canonicalIngredientKey(existing);
  const inIng = canonicalIngredientKey(incoming);
  const exStr = canonicalStrengthKey(existing.strength);
  const inStr = canonicalStrengthKey(incoming.strength);
  return Boolean(exIng && inIng && exStr && inStr && exIng === inIng && exStr === inStr);
}

function ensureUniqueId(desiredId: string, takenIds: Set<string>): string {
  const base = desiredId || "rx";
  if (!takenIds.has(base)) {
    takenIds.add(base);
    return base;
  }
  let suffix = 2;
  while (takenIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${base}-${suffix}`.slice(0, MAX_ID_LENGTH);
  takenIds.add(unique);
  return unique;
}

function unionCaseInsensitive(existing: string[], incoming: string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of existing) {
    if (typeof raw !== "string") continue;
    const item = cleanText(raw, MAX_LIST_ITEM_LENGTH);
    if (!item) continue;
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  if (Array.isArray(incoming)) {
    for (const raw of incoming) {
      if (typeof raw !== "string") continue;
      const item = cleanText(raw, MAX_LIST_ITEM_LENGTH);
      if (!item) continue;
      const key = item.toLowerCase();
      if (!seen.has(key) && result.length < MAX_LIST_ITEMS) {
        seen.add(key);
        result.push(item);
      }
    }
  }

  return result;
}

export function mergePharmacyPayload(
  profile: Profile,
  payload: PharmacyRxPayload
): { profile: Profile; added: number; updated: number } {
  const nextMeds = Array.isArray(profile.meds) ? profile.meds.map(cloneMed) : [];
  const takenIds = new Set<string>(nextMeds.map((m) => m.id));
  let added = 0;
  let updated = 0;

  const incomingMeds = Array.isArray(payload?.meds) ? payload.meds : [];
  for (let i = 0; i < incomingMeds.length; i += 1) {
    const incoming = sanitizeRxMed(incomingMeds[i], i);
    if (!incoming) continue;

    const matchIndex = nextMeds.findIndex((existing) => isSameMedication(existing, incoming));
    if (matchIndex >= 0) {
      const prev = nextMeds[matchIndex];
      const merged: Med = {
        id: prev.id || ensureUniqueId(incoming.id, takenIds),
        name: incoming.name || prev.name,
        ingredient: incoming.ingredient || prev.ingredient,
        strength: incoming.strength || prev.strength,
        schedule: incoming.schedule.length > 0 ? [...incoming.schedule] : [...prev.schedule]
      };
      const nextBarcode = incoming.barcode ?? prev.barcode;
      if (nextBarcode) {
        merged.barcode = nextBarcode;
      }
      const nextNotes = incoming.notes ?? prev.notes;
      if (nextNotes) {
        merged.notes = nextNotes;
      }
      nextMeds[matchIndex] = merged;
      updated += 1;
    } else {
      const id = ensureUniqueId(incoming.id, takenIds);
      const created: Med = {
        id,
        name: incoming.name,
        ingredient: incoming.ingredient,
        strength: incoming.strength,
        schedule: [...incoming.schedule]
      };
      if (incoming.barcode) {
        created.barcode = incoming.barcode;
      }
      if (incoming.notes) {
        created.notes = incoming.notes;
      }
      nextMeds.push(created);
      added += 1;
    }
  }

  const nextProfile: Profile = {
    meds: nextMeds,
    allergies: unionCaseInsensitive(Array.isArray(profile.allergies) ? profile.allergies : [], payload?.allergies),
    avoid: unionCaseInsensitive(Array.isArray(profile.avoid) ? profile.avoid : [], payload?.avoid),
    doseLog: Array.isArray(profile.doseLog)
      ? profile.doseLog.map((entry) => ({ medId: entry.medId, ts: entry.ts }))
      : [],
    lang: typeof profile.lang === "string" && profile.lang.trim() ? profile.lang.trim() : "en"
  };

  return { profile: nextProfile, added, updated };
}

export const SAMPLE_FINNISH_PHARMACY_QR: string = encodePharmacyQrUri({
  v: 1,
  pharmacy: "Yliopiston Apteekki Helsinki",
  meds: [
    {
      id: "bis",
      name: "Bisoprolol",
      ingredient: "bisoprolol",
      strength: "2.5 mg",
      schedule: ["morning"],
      barcode: "6432100024680",
      notes: "1 tablet in the morning"
    },
    {
      id: "ato",
      name: "Atorvastatin",
      ingredient: "atorvastatin",
      strength: "20 mg",
      schedule: ["evening"],
      barcode: "6432100086420",
      notes: "1 tablet in the evening"
    }
  ]
});
