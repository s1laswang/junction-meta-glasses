import type { ConsentRecord, Med, Profile, ThemeMode } from "../types.ts";

export interface KeyValueStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const CONSENT_VERSION = "2026-11-14";

export const STORAGE_KEYS = {
  profile: "holdup.profile",
  consent: "holdup.consent",
  theme: "holdup.theme",
  sessionId: "holdup.sessionId"
} as const;

const KEY_PREFIX = "holdup.";
const SESSION_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const VALID_THEMES: readonly ThemeMode[] = ["dark", "light", "high-contrast"];

export const DEMO_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipin",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432100012345",
      notes: "Blood pressure, 1 tablet in the evening"
    },
    {
      id: "met",
      name: "Metformin",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["morning", "evening"],
      barcode: "6432100054321",
      notes: "With meals twice daily"
    },
    {
      id: "par",
      name: "Panadol",
      ingredient: "paracetamol",
      strength: "500 mg",
      schedule: ["as needed"],
      barcode: "6432100098765",
      notes: "Pain or fever"
    }
  ],
  allergies: ["peanut", "tree nuts"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

const defaultMemoryMap = new Map<string, string>();
const fallbackMaps = new WeakMap<KeyValueStorage, Map<string, string>>();
const trackedKeys = new WeakMap<KeyValueStorage, Set<string>>();

export function createMemoryStorage(): KeyValueStorage & { readonly length: number; key(index: number): string | null } {
  const map = new Map<string, string>();
  return {
    getItem(k: string): string | null {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string): void {
      map.set(k, String(v));
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      if (index < 0 || index >= map.size) return null;
      let i = 0;
      for (const k of map.keys()) {
        if (i === index) return k;
        i += 1;
      }
      return null;
    }
  };
}

function getDefaultTarget(): KeyValueStorage | null {
  try {
    const ls = globalThis.localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function" &&
      typeof ls.removeItem === "function"
    ) {
      return ls;
    }
  } catch {
    return null;
  }
  return null;
}

function getFallbackMap(target: KeyValueStorage): Map<string, string> {
  let map = fallbackMaps.get(target);
  if (!map) {
    map = new Map<string, string>();
    fallbackMaps.set(target, map);
  }
  return map;
}

function getTrackedSet(target: KeyValueStorage): Set<string> {
  let set = trackedKeys.get(target);
  if (!set) {
    set = new Set<string>();
    trackedKeys.set(target, set);
  }
  return set;
}

function readKey(k: string, storage?: KeyValueStorage): string | null {
  const target = storage ?? getDefaultTarget();
  if (!target) {
    return defaultMemoryMap.get(k) ?? null;
  }
  const fb = fallbackMaps.get(target);
  if (fb && fb.has(k)) {
    return fb.get(k) ?? null;
  }
  try {
    return target.getItem(k);
  } catch {
    if (!storage && defaultMemoryMap.has(k)) {
      return defaultMemoryMap.get(k) ?? null;
    }
    return fb?.get(k) ?? null;
  }
}

function writeKey(k: string, v: string, storage?: KeyValueStorage): void {
  const target = storage ?? getDefaultTarget();
  if (!target) {
    defaultMemoryMap.set(k, v);
    return;
  }
  getTrackedSet(target).add(k);
  try {
    target.setItem(k, v);
    fallbackMaps.get(target)?.delete(k);
    if (!storage) {
      defaultMemoryMap.delete(k);
    }
  } catch {
    getFallbackMap(target).set(k, v);
    if (!storage) {
      defaultMemoryMap.set(k, v);
    }
  }
}

function deleteKey(k: string, storage?: KeyValueStorage): void {
  const target = storage ?? getDefaultTarget();
  if (!storage) {
    defaultMemoryMap.delete(k);
  }
  if (!target) {
    return;
  }
  fallbackMaps.get(target)?.delete(k);
  trackedKeys.get(target)?.delete(k);
  try {
    target.removeItem(k);
  } catch {
    return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneMed(med: Med): Med {
  const copy: Med = {
    id: med.id,
    name: med.name,
    ingredient: med.ingredient,
    strength: med.strength,
    schedule: [...med.schedule]
  };
  if (med.barcode !== undefined) {
    copy.barcode = med.barcode;
  }
  if (med.notes !== undefined) {
    copy.notes = med.notes;
  }
  return copy;
}

function cloneProfile(profile: Profile): Profile {
  return {
    meds: profile.meds.map(cloneMed),
    allergies: [...profile.allergies],
    avoid: [...profile.avoid],
    doseLog: profile.doseLog.map((entry) => ({ medId: entry.medId, ts: entry.ts })),
    lang: profile.lang
  };
}

function sanitizeMed(raw: unknown): Med | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.ingredient !== "string" ||
    typeof raw.strength !== "string" ||
    !Array.isArray(raw.schedule)
  ) {
    return null;
  }
  const id = raw.id.trim();
  const name = raw.name.trim();
  const ingredient = raw.ingredient.trim();
  const strength = raw.strength.trim();
  if (!id || (!name && !ingredient)) {
    return null;
  }
  const schedule = raw.schedule
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const med: Med = { id, name, ingredient, strength, schedule };
  if (typeof raw.barcode === "string" && raw.barcode.trim().length > 0) {
    med.barcode = raw.barcode.trim();
  }
  if (typeof raw.notes === "string" && raw.notes.trim().length > 0) {
    med.notes = raw.notes.trim();
  }
  return med;
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sanitizeDoseLog(raw: unknown): { medId: string; ts: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { medId: string; ts: number }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.medId !== "string" || typeof item.ts !== "number" || !Number.isFinite(item.ts) || item.ts < 0) {
      continue;
    }
    const medId = item.medId.trim();
    if (!medId) continue;
    out.push({ medId, ts: item.ts });
  }
  return out;
}

function parseStoredProfile(rawJson: string): Profile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.meds)) {
    return null;
  }
  const meds = parsed.meds
    .map((item) => sanitizeMed(item))
    .filter((item): item is Med => item !== null);
  if (parsed.meds.length > 0 && meds.length === 0) {
    return null;
  }
  return {
    meds,
    allergies: sanitizeStringArray(parsed.allergies),
    avoid: sanitizeStringArray(parsed.avoid),
    doseLog: sanitizeDoseLog(parsed.doseLog),
    lang: typeof parsed.lang === "string" && parsed.lang.trim().length > 0 ? parsed.lang.trim() : "en"
  };
}

export function loadProfile(storage?: KeyValueStorage): Profile {
  const raw = readKey(STORAGE_KEYS.profile, storage);
  if (raw !== null) {
    const parsed = parseStoredProfile(raw);
    if (parsed) {
      return parsed;
    }
  }
  const seeded = cloneProfile(DEMO_PROFILE);
  writeKey(STORAGE_KEYS.profile, JSON.stringify(seeded), storage);
  return seeded;
}

export function saveProfile(profile: Profile, storage?: KeyValueStorage): Profile {
  const normalized: Profile = isRecord(profile)
    ? {
        meds: Array.isArray(profile.meds)
          ? profile.meds.map((item) => sanitizeMed(item)).filter((item): item is Med => item !== null)
          : [],
        allergies: sanitizeStringArray(profile.allergies),
        avoid: sanitizeStringArray(profile.avoid),
        doseLog: sanitizeDoseLog(profile.doseLog),
        lang: typeof profile.lang === "string" && profile.lang.trim().length > 0 ? profile.lang.trim() : "en"
      }
    : cloneProfile(DEMO_PROFILE);
  writeKey(STORAGE_KEYS.profile, JSON.stringify(normalized), storage);
  return cloneProfile(normalized);
}

export function resetToDemoProfile(storage?: KeyValueStorage): Profile {
  const demo = cloneProfile(DEMO_PROFILE);
  writeKey(STORAGE_KEYS.profile, JSON.stringify(demo), storage);
  return demo;
}

export function appendDoseLog(
  profile: Profile,
  medId: string,
  ts?: number,
  storage?: KeyValueStorage
): Profile {
  const trimmedId = typeof medId === "string" ? medId.trim() : "";
  if (!trimmedId) {
    return saveProfile(profile, storage);
  }
  const timestamp = typeof ts === "number" && Number.isFinite(ts) && ts >= 0 ? ts : Date.now();
  const nextProfile: Profile = {
    ...profile,
    doseLog: [...(Array.isArray(profile.doseLog) ? profile.doseLog : []), { medId: trimmedId, ts: timestamp }]
  };
  return saveProfile(nextProfile, storage);
}

export function undoLastDose(profile: Profile, storage?: KeyValueStorage): Profile {
  const currentLog = Array.isArray(profile.doseLog) ? profile.doseLog : [];
  const nextProfile: Profile = {
    ...profile,
    doseLog: currentLog.length > 0 ? currentLog.slice(0, -1) : []
  };
  return saveProfile(nextProfile, storage);
}

export function loadConsent(storage?: KeyValueStorage): ConsentRecord {
  const defaultConsent: ConsentRecord = {
    accepted: false,
    acceptedAt: null,
    version: CONSENT_VERSION
  };
  const raw = readKey(STORAGE_KEYS.consent, storage);
  if (raw === null) {
    return defaultConsent;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== CONSENT_VERSION || typeof parsed.accepted !== "boolean") {
      return defaultConsent;
    }
    if (!parsed.accepted) {
      return defaultConsent;
    }
    if (typeof parsed.acceptedAt !== "number" || !Number.isFinite(parsed.acceptedAt) || parsed.acceptedAt <= 0) {
      return defaultConsent;
    }
    return {
      accepted: true,
      acceptedAt: parsed.acceptedAt,
      version: CONSENT_VERSION
    };
  } catch {
    return defaultConsent;
  }
}

export function saveConsent(accepted: boolean, storage?: KeyValueStorage): ConsentRecord {
  const isAccepted = Boolean(accepted);
  const record: ConsentRecord = {
    accepted: isAccepted,
    acceptedAt: isAccepted ? Date.now() : null,
    version: CONSENT_VERSION
  };
  writeKey(STORAGE_KEYS.consent, JSON.stringify(record), storage);
  return { ...record };
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (VALID_THEMES as readonly string[]).includes(value);
}

export function loadTheme(storage?: KeyValueStorage): ThemeMode {
  const raw = readKey(STORAGE_KEYS.theme, storage);
  return isThemeMode(raw) ? raw : "dark";
}

export function saveTheme(theme: ThemeMode, storage?: KeyValueStorage): void {
  const valid: ThemeMode = isThemeMode(theme) ? theme : "dark";
  writeKey(STORAGE_KEYS.theme, valid, storage);
}

function randomSessionSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += SESSION_ALPHABET[bytes[i] % SESSION_ALPHABET.length];
  }
  return out;
}

function isValidSessionId(value: string | null): value is string {
  return typeof value === "string" && /^(?:hup-[a-z0-9]{4}|[a-z0-9]{8})$/.test(value);
}

export function loadOrCreateSessionId(storage?: KeyValueStorage): string {
  const existing = readKey(STORAGE_KEYS.sessionId, storage);
  if (isValidSessionId(existing)) {
    return existing;
  }
  const created = `hup-${randomSessionSuffix(4)}`;
  writeKey(STORAGE_KEYS.sessionId, created, storage);
  return created;
}

export function wipeAllLocalData(storage?: KeyValueStorage): void {
  const keysToDelete = new Set<string>(Object.values(STORAGE_KEYS));
  if (!storage) {
    for (const k of defaultMemoryMap.keys()) {
      if (k.startsWith(KEY_PREFIX)) {
        keysToDelete.add(k);
      }
    }
  }
  const target = storage ?? getDefaultTarget();
  if (target) {
    const fb = fallbackMaps.get(target);
    if (fb) {
      for (const k of fb.keys()) {
        if (k.startsWith(KEY_PREFIX)) {
          keysToDelete.add(k);
        }
      }
    }
    const tracked = trackedKeys.get(target);
    if (tracked) {
      for (const k of tracked) {
        if (k.startsWith(KEY_PREFIX)) {
          keysToDelete.add(k);
        }
      }
    }
    try {
      if (
        "length" in target &&
        typeof target.length === "number" &&
        "key" in target &&
        typeof target.key === "function"
      ) {
        for (let i = 0; i < target.length; i += 1) {
          const k = target.key(i);
          if (typeof k === "string" && k.startsWith(KEY_PREFIX)) {
            keysToDelete.add(k);
          }
        }
      }
    } catch {
      void 0;
    }
    try {
      for (const k of Object.keys(target)) {
        if (k.startsWith(KEY_PREFIX)) {
          keysToDelete.add(k);
        }
      }
    } catch {
      void 0;
    }
  }
  for (const k of keysToDelete) {
    deleteKey(k, storage);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTimeLocal(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isAsNeededSlot(slot: string): boolean {
  return /^(as needed|when needed|if needed|prn|tarvittaessa)$/i.test(slot.trim());
}

function formatMedTitle(med: Med): string {
  return med.strength.trim() ? `${med.name} ${med.strength}` : med.name;
}

export function exportCaregiverSummary(profile: Profile, now: Date = new Date()): string {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const todaysDoses = (Array.isArray(profile.doseLog) ? profile.doseLog : [])
    .filter((entry) => entry.ts >= startOfDay.getTime() && entry.ts <= endOfDay.getTime())
    .sort((a, b) => a.ts - b.ts);

  const dosesByMed = new Map<string, number[]>();
  for (const entry of todaysDoses) {
    const list = dosesByMed.get(entry.medId) ?? [];
    list.push(entry.ts);
    dosesByMed.set(entry.medId, list);
  }

  let totalScheduled = 0;
  let totalScheduledTaken = 0;
  const takenLines: string[] = [];
  const pendingLines: string[] = [];
  const asNeededLines: string[] = [];
  const knownMedIds = new Set<string>();

  for (const med of profile.meds) {
    knownMedIds.add(med.id);
    const scheduledSlots = med.schedule
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isAsNeededSlot(s));
    const takenTimestamps = dosesByMed.get(med.id) ?? [];
    const takenCount = takenTimestamps.length;
    const title = formatMedTitle(med);

    if (scheduledSlots.length === 0) {
      if (takenCount > 0) {
        const times = takenTimestamps.map(formatTimeLocal).join(", ");
        takenLines.push(`- ${title} (as needed): ${takenCount} taken (${times})`);
        asNeededLines.push(`- ${title}: ${takenCount} taken today (${times})`);
      } else {
        asNeededLines.push(`- ${title}: not taken today`);
      }
      continue;
    }

    const slotCount = scheduledSlots.length;
    const cappedTaken = Math.min(takenCount, slotCount);
    const remainingCount = Math.max(0, slotCount - takenCount);
    totalScheduled += slotCount;
    totalScheduledTaken += cappedTaken;

    if (takenCount > 0) {
      const times = takenTimestamps.map(formatTimeLocal).join(", ");
      takenLines.push(`- ${title}: ${takenCount} of ${slotCount} taken (${times})`);
    }
    if (remainingCount > 0) {
      const remainingSlots = scheduledSlots.slice(takenCount).join(", ");
      pendingLines.push(`- ${title}: ${remainingCount} remaining (${remainingSlots})`);
    }
  }

  for (const [medId, timestamps] of dosesByMed.entries()) {
    if (knownMedIds.has(medId)) continue;
    const times = timestamps.map(formatTimeLocal).join(", ");
    takenLines.push(`- ${medId}: ${timestamps.length} taken (${times})`);
  }

  const totalRemaining = totalScheduled - totalScheduledTaken;
  const lines: string[] = [
    `HoldUp Caregiver Summary (${formatDateLocal(now)})`,
    `Scheduled doses: ${totalScheduledTaken} of ${totalScheduled} taken, ${totalRemaining} remaining`,
    ""
  ];

  if (takenLines.length === 0) {
    lines.push("Taken today: none");
  } else {
    lines.push("Taken today:", ...takenLines);
  }

  lines.push("");
  if (pendingLines.length === 0) {
    lines.push("Pending scheduled doses: none");
  } else {
    lines.push("Pending scheduled doses:", ...pendingLines);
  }

  if (asNeededLines.length > 0) {
    lines.push("", "As-needed medications:", ...asNeededLines);
  }

  return lines.join("\n");
}
