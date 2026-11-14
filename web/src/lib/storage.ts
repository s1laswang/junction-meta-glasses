// Everything HoldUp keeps lives here, in this browser's localStorage. Nothing is stored server-side.
import type { Med, Profile } from "../../../shared/types.ts";

const PREFIX = "holdup.";
const K = {
  profile: PREFIX + "profile",
  consent: PREFIX + "consent",
  settings: PREFIX + "settings",
} as const;

export const CONSENT_VERSION = 1;

export type Consent = { version: number; ts: number };
export type Settings = {
  source: "phone" | "glasses";
  voice: boolean;
  haptics: boolean;
  earcons: boolean;
  showPanel: boolean;
};

const DEFAULT_SETTINGS: Settings = { source: "phone", voice: true, haptics: true, earcons: true, showPanel: false };

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app still works for this session */
  }
}

export const LANGS = [
  { code: "en", label: "English" },
  { code: "fi", label: "Suomi" },
  { code: "sv", label: "Svenska" },
] as const;

/** en / fi / sv from the browser language, English otherwise. */
export function defaultLang(): string {
  const l = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase().slice(0, 2);
  return LANGS.some((x) => x.code === l) ? l : "en";
}

export function demoProfile(): Profile {
  return {
    lang: defaultLang(),
    meds: [
      { id: "amlodipine", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], barcode: "6416542002149", notes: "Blood pressure" },
      { id: "metformin", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["morning", "evening"], barcode: "6416542003375", notes: "Diabetes, with food" },
      { id: "atorvastatin", name: "Atorvastatin", ingredient: "atorvastatin", strength: "20 mg", schedule: ["evening"], barcode: "6416542004860", notes: "Cholesterol" },
    ],
    allergies: ["tree nuts", "peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
  };
}

export function loadProfile(): Profile {
  return read<Profile>(K.profile) ?? demoProfile();
}
export function saveProfile(p: Profile) {
  write(K.profile, p);
}

export function loadConsent(): Consent | null {
  const c = read<Consent>(K.consent);
  return c && c.version === CONSENT_VERSION ? c : null;
}
export function saveConsent() {
  write(K.consent, { version: CONSENT_VERSION, ts: Date.now() } satisfies Consent);
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...(read<Partial<Settings>>(K.settings) ?? {}) };
}
export function saveSettings(s: Settings) {
  write(K.settings, s);
}

/** Wipe every HoldUp key, the offline cache and the session code. */
export async function deleteAllData() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  try {
    if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* ignore */
  }
}

export function newMedId(name: string) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "med") + "-" + Math.random().toString(36).slice(2, 6);
}

export function emptyMed(): Med {
  return { id: "", name: "", ingredient: "", strength: "", schedule: [] };
}

export function takenToday(p: Profile, medId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return p.doseLog.some((d) => d.medId === medId && d.ts >= start.getTime());
}

export function logDose(p: Profile, medId: string): Profile {
  const next = { ...p, doseLog: [...p.doseLog, { medId, ts: Date.now() }].slice(-200) };
  saveProfile(next);
  return next;
}

/** Short, unambiguous code that pairs the phone with the HUD (no 0/O/1/I). */
export function sessionCode(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("session");
  if (fromUrl) return fromUrl.toUpperCase();
  try {
    const existing = localStorage.getItem(PREFIX + "session");
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => alphabet[b % alphabet.length]).join("");
  try {
    localStorage.setItem(PREFIX + "session", code);
  } catch {
    /* ignore */
  }
  return code;
}
