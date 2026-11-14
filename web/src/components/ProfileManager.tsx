import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent
} from "react";
import { SUPPORTED_LANGUAGES } from "../i18n/translations.ts";
import type { Med, Profile } from "../types.ts";

export type ProfileManagerProps = {
  profile: Profile;
  onChange: (next: Profile) => void;
  onResetDemo: () => void;
  onUndoLastDose: () => void;
  caregiverSummaryText: string;
  onOpenPharmacyImport?: () => void;
};

export type PresetChipDef = {
  label: string;
  value: string;
  aliases: readonly string[];
};

export type ResolvedDoseEntry = {
  medId: string;
  medName: string;
  strength: string;
  ts: number;
  timeText: string;
  index: number;
};

export type NewMedicationDraft = {
  name: string;
  ingredient: string;
  strength: string;
  schedule: string[];
  barcode?: string;
  notes?: string;
};

export const SCHEDULE_SLOTS = [
  "morning",
  "noon",
  "evening",
  "bedtime",
  "as needed"
] as const;

export const ALLERGY_PRESET_CHIPS: readonly PresetChipDef[] = [
  { label: "Peanut", value: "peanut", aliases: ["peanut", "peanuts"] },
  { label: "Tree nuts", value: "tree nuts", aliases: ["tree nuts", "tree nut"] },
  {
    label: "Milk / Lactose",
    value: "milk",
    aliases: ["milk", "lactose", "dairy", "milk / lactose"]
  },
  {
    label: "Gluten / Wheat",
    value: "gluten",
    aliases: ["gluten", "wheat", "gluten / wheat"]
  },
  { label: "Egg", value: "egg", aliases: ["egg", "eggs"] },
  { label: "Soy", value: "soy", aliases: ["soy", "soya"] },
  { label: "Sesame", value: "sesame", aliases: ["sesame"] },
  { label: "Shellfish", value: "shellfish", aliases: ["shellfish", "crustaceans"] },
  { label: "Penicillin", value: "penicillin", aliases: ["penicillin", "penicillins"] }
];

export const AVOID_PRESET_CHIPS: readonly PresetChipDef[] = [
  { label: "NSAIDs", value: "NSAIDs", aliases: ["nsaids", "nsaid"] },
  { label: "Aspirin", value: "Aspirin", aliases: ["aspirin"] },
  {
    label: "Anticoagulants",
    value: "Anticoagulants",
    aliases: ["anticoagulants", "anticoagulant", "blood thinners"]
  },
  {
    label: "Beta blockers",
    value: "Beta blockers",
    aliases: ["beta blockers", "beta blocker", "beta-blockers"]
  },
  {
    label: "ACE inhibitors",
    value: "ACE inhibitors",
    aliases: ["ace inhibitors", "ace inhibitor", "ace-inhibitors"]
  },
  { label: "Statins", value: "Statins", aliases: ["statins", "statin"] }
];

function cleanText(raw: string, maxLen = 120): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .trim();
}

function normalizeCompareKey(raw: string): string {
  return cleanText(raw, 120).toLowerCase();
}

function cloneMedItem(med: Med): Med {
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

function cloneProfileState(profile: Profile): Profile {
  return {
    meds: Array.isArray(profile.meds) ? profile.meds.map(cloneMedItem) : [],
    allergies: Array.isArray(profile.allergies) ? [...profile.allergies] : [],
    avoid: Array.isArray(profile.avoid) ? [...profile.avoid] : [],
    doseLog: Array.isArray(profile.doseLog)
      ? profile.doseLog.map((entry) => ({ medId: entry.medId, ts: entry.ts }))
      : [],
    lang: typeof profile.lang === "string" && profile.lang.trim() ? profile.lang.trim() : "en"
  };
}

export function resolveSupportedLangCode(lang: string): string {
  const base = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  const matched = SUPPORTED_LANGUAGES.find((entry) => entry.code === base);
  return matched ? matched.code : "en";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDoseTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts < 0) {
    return "00:00";
  }
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function dayBounds(now: Date): { startMs: number; endMs: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export function countTodaysDosesForMed(
  profile: Profile,
  medId: string,
  now: Date = new Date()
): number {
  const target = medId.trim();
  if (!target || !Array.isArray(profile.doseLog)) {
    return 0;
  }
  const { startMs, endMs } = dayBounds(now);
  let count = 0;
  for (const entry of profile.doseLog) {
    if (entry.medId === target && entry.ts >= startMs && entry.ts <= endMs) {
      count += 1;
    }
  }
  return count;
}

export function getTodaysDoseEntries(
  profile: Profile,
  now: Date = new Date()
): ResolvedDoseEntry[] {
  if (!Array.isArray(profile.doseLog) || profile.doseLog.length === 0) {
    return [];
  }
  const { startMs, endMs } = dayBounds(now);
  const medById = new Map<string, Med>();
  if (Array.isArray(profile.meds)) {
    for (const med of profile.meds) {
      medById.set(med.id, med);
    }
  }

  const resolved: ResolvedDoseEntry[] = [];
  for (let i = 0; i < profile.doseLog.length; i += 1) {
    const entry = profile.doseLog[i];
    if (!entry || typeof entry.medId !== "string" || !Number.isFinite(entry.ts)) {
      continue;
    }
    if (entry.ts < startMs || entry.ts > endMs) {
      continue;
    }
    const matched = medById.get(entry.medId);
    const medName = matched
      ? matched.name.trim() || matched.ingredient.trim() || entry.medId
      : entry.medId;
    const strength = matched ? matched.strength.trim() : "";
    resolved.push({
      medId: entry.medId,
      medName,
      strength,
      ts: entry.ts,
      timeText: formatDoseTimestamp(entry.ts),
      index: i
    });
  }

  resolved.sort((a, b) => {
    if (b.ts !== a.ts) {
      return b.ts - a.ts;
    }
    return b.index - a.index;
  });

  return resolved;
}

function buildUniqueMedId(
  name: string,
  ingredient: string,
  strength: string,
  existingMeds: readonly Med[]
): string {
  const taken = new Set(existingMeds.map((m) => m.id));
  const slugBase = `${ingredient || name}-${strength}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = slugBase || "med";
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function addMedicationToProfile(
  profile: Profile,
  draft: NewMedicationDraft
): Profile | null {
  const name = cleanText(draft.name, 120);
  const ingredient = cleanText(draft.ingredient, 120);
  const strength = cleanText(draft.strength, 64);

  if ((!name && !ingredient) || !strength) {
    return null;
  }

  const cleanedSchedule = Array.isArray(draft.schedule)
    ? draft.schedule.map((slot) => cleanText(slot, 48)).filter((slot) => slot.length > 0)
    : [];
  const schedule = cleanedSchedule.length > 0 ? Array.from(new Set(cleanedSchedule)) : ["as needed"];

  const next = cloneProfileState(profile);
  const id = buildUniqueMedId(name, ingredient, strength, next.meds);
  const created: Med = {
    id,
    name: name || ingredient,
    ingredient: ingredient || name.toLowerCase(),
    strength,
    schedule
  };

  if (typeof draft.barcode === "string") {
    const barcodeDigits = draft.barcode.replace(/\D+/g, "").slice(0, 32);
    if (barcodeDigits) {
      created.barcode = barcodeDigits;
    }
  }

  if (typeof draft.notes === "string") {
    const notes = cleanText(draft.notes, 240);
    if (notes) {
      created.notes = notes;
    }
  }

  next.meds.push(created);
  return next;
}

export function removeMedicationFromProfile(profile: Profile, medId: string): Profile {
  const next = cloneProfileState(profile);
  next.meds = next.meds.filter((med) => med.id !== medId);
  return next;
}

export function logDoseNowInProfile(
  profile: Profile,
  medId: string,
  ts: number = Date.now()
): Profile {
  const trimmed = medId.trim();
  const next = cloneProfileState(profile);
  if (!trimmed) {
    return next;
  }
  const safeTs = Number.isFinite(ts) && ts >= 0 ? ts : Date.now();
  next.doseLog.push({ medId: trimmed, ts: safeTs });
  return next;
}

export function isPresetActive(list: readonly string[], preset: PresetChipDef): boolean {
  const matchKeys = new Set<string>([
    normalizeCompareKey(preset.value),
    normalizeCompareKey(preset.label),
    ...preset.aliases.map(normalizeCompareKey)
  ]);
  return list.some((entry) => matchKeys.has(normalizeCompareKey(entry)));
}

export function togglePresetItem(
  list: readonly string[],
  preset: PresetChipDef
): { next: string[]; added: boolean } {
  const matchKeys = new Set<string>([
    normalizeCompareKey(preset.value),
    normalizeCompareKey(preset.label),
    ...preset.aliases.map(normalizeCompareKey)
  ]);
  const exists = list.some((entry) => matchKeys.has(normalizeCompareKey(entry)));
  if (exists) {
    return {
      next: list.filter((entry) => !matchKeys.has(normalizeCompareKey(entry))),
      added: false
    };
  }
  return {
    next: [...list, preset.value],
    added: true
  };
}

export function addCustomListItem(
  list: readonly string[],
  raw: string
): { next: string[]; added: boolean } {
  const cleaned = cleanText(raw, 80);
  if (!cleaned) {
    return { next: [...list], added: false };
  }
  const targetKey = normalizeCompareKey(cleaned);
  if (list.some((entry) => normalizeCompareKey(entry) === targetKey)) {
    return { next: [...list], added: false };
  }
  return {
    next: [...list, cleaned],
    added: true
  };
}

export function removeListItem(list: readonly string[], target: string): string[] {
  const targetKey = normalizeCompareKey(target);
  return list.filter((entry) => normalizeCompareKey(entry) !== targetKey);
}

async function copyTextSafe(text: string): Promise<boolean> {
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
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  }
  return false;
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5, 20px)"
};

const bannerCardStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-4, 16px) var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--verdict-match-bg, #06261d)",
  color: "var(--verdict-match-fg, #7ef7c8)",
  border: "2px solid var(--verdict-match-border, #2dd4a0)"
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const sectionHeaderRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)"
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xl, 1.5rem)",
  lineHeight: 1.25,
  fontWeight: 800
};

const subHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg, 1.25rem)",
  lineHeight: 1.3,
  fontWeight: 700
};

const hintTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const fieldGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px"
};

const labelStyle: CSSProperties = {
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700,
  lineHeight: 1.35,
  color: "var(--text-primary, #f8fafc)"
};

const inputMinStyle: CSSProperties = {
  minHeight: "56px"
};

const actionButtonStyle: CSSProperties = {
  minHeight: "56px",
  padding: "12px 20px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700
};

const chipButtonStyle: CSSProperties = {
  minHeight: "56px",
  padding: "10px 16px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700
};

const medListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)"
};

const medCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "1.5px solid var(--border-subtle, #2c3a52)"
};

const formGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const inlineFormRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "var(--space-3, 12px)"
};

const tagWrapStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2, 8px)"
};

const chipWrapStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2, 8px)"
};

const alertBoxStyle: CSSProperties = {
  padding: "var(--space-3, 12px) var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
  color: "var(--verdict-warning-fg, #ffb8ab)",
  border: "2px solid var(--verdict-warning-border, #ff6b52)",
  fontWeight: 700,
  fontSize: "var(--text-sm, 1rem)"
};

const srOnlyStyle: CSSProperties = {
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

export function ProfileManager(props: ProfileManagerProps) {
  const {
    profile,
    onChange,
    onResetDemo,
    onUndoLastDose,
    caregiverSummaryText,
    onOpenPharmacyImport
  } = props;

  const uid = useId();
  const [medName, setMedName] = useState("");
  const [medIngredient, setMedIngredient] = useState("");
  const [medStrength, setMedStrength] = useState("");
  const [medSchedule, setMedSchedule] = useState<string[]>(["morning"]);
  const [medBarcode, setMedBarcode] = useState("");
  const [medFormError, setMedFormError] = useState("");

  const [customAllergy, setCustomAllergy] = useState("");
  const [customAvoid, setCustomAvoid] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  const announceStatus = (msg: string) => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
    }
    setStatusMessage(msg);
    statusTimerRef.current = setTimeout(() => {
      setStatusMessage("");
      statusTimerRef.current = null;
    }, 4000);
  };

  const selectedLang = resolveSupportedLangCode(profile.lang);
  const now = new Date();
  const todaysDoseEntries = getTodaysDoseEntries(profile, now);
  const totalDoseLogCount = Array.isArray(profile.doseLog) ? profile.doseLog.length : 0;

  const langHeadingId = `${uid}-lang-heading`;
  const langSelectId = `${uid}-lang-select`;
  const medsHeadingId = `${uid}-meds-heading`;
  const addMedHeadingId = `${uid}-add-med-heading`;
  const medNameId = `${uid}-med-name`;
  const medIngredientId = `${uid}-med-ingredient`;
  const medStrengthId = `${uid}-med-strength`;
  const medBarcodeId = `${uid}-med-barcode`;
  const allergiesHeadingId = `${uid}-allergies-heading`;
  const customAllergyId = `${uid}-custom-allergy`;
  const avoidHeadingId = `${uid}-avoid-heading`;
  const customAvoidId = `${uid}-custom-avoid`;
  const doseLogHeadingId = `${uid}-doselog-heading`;

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLang = resolveSupportedLangCode(event.target.value);
    const next = cloneProfileState(profile);
    next.lang = nextLang;
    onChange(next);
    const entry = SUPPORTED_LANGUAGES.find((item) => item.code === nextLang);
    announceStatus(`Language set to ${entry ? entry.label : nextLang}.`);
  };

  const handleScheduleToggle = (slot: string) => {
    setMedSchedule((prev) =>
      prev.includes(slot) ? prev.filter((item) => item !== slot) : [...prev, slot]
    );
  };

  const handleAddMedication = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const updated = addMedicationToProfile(profile, {
      name: medName,
      ingredient: medIngredient,
      strength: medStrength,
      schedule: medSchedule,
      barcode: medBarcode
    });
    if (!updated) {
      setMedFormError(
        "Enter a medication name or active ingredient and a strength such as 5 mg."
      );
      return;
    }
    setMedFormError("");
    const addedMed = updated.meds[updated.meds.length - 1];
    onChange(updated);
    setMedName("");
    setMedIngredient("");
    setMedStrength("");
    setMedSchedule(["morning"]);
    setMedBarcode("");
    announceStatus(`Added ${addedMed.name} ${addedMed.strength} to on-device medications.`);
  };

  const handleLogDoseNow = (med: Med) => {
    const updated = logDoseNowInProfile(profile, med.id);
    onChange(updated);
    announceStatus(`Logged dose now for ${med.name || med.ingredient} ${med.strength}.`);
  };

  const handleRemoveMedication = (med: Med) => {
    const updated = removeMedicationFromProfile(profile, med.id);
    onChange(updated);
    announceStatus(`Removed ${med.name || med.ingredient} from medications.`);
  };

  const handleAddCustomAllergy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { next: nextAllergies, added } = addCustomListItem(profile.allergies, customAllergy);
    setCustomAllergy("");
    if (!added) {
      return;
    }
    const next = cloneProfileState(profile);
    next.allergies = nextAllergies;
    onChange(next);
    announceStatus(`Added allergy ${nextAllergies[nextAllergies.length - 1]}.`);
  };

  const handleToggleAllergyPreset = (preset: PresetChipDef) => {
    const { next: nextAllergies, added } = togglePresetItem(profile.allergies, preset);
    const next = cloneProfileState(profile);
    next.allergies = nextAllergies;
    onChange(next);
    announceStatus(
      added ? `Added ${preset.label} allergy.` : `Removed ${preset.label} allergy.`
    );
  };

  const handleRemoveAllergy = (item: string) => {
    const next = cloneProfileState(profile);
    next.allergies = removeListItem(profile.allergies, item);
    onChange(next);
    announceStatus(`Removed allergy ${item}.`);
  };

  const handleAddCustomAvoid = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { next: nextAvoid, added } = addCustomListItem(profile.avoid, customAvoid);
    setCustomAvoid("");
    if (!added) {
      return;
    }
    const next = cloneProfileState(profile);
    next.avoid = nextAvoid;
    onChange(next);
    announceStatus(`Added ${nextAvoid[nextAvoid.length - 1]} to avoid list.`);
  };

  const handleToggleAvoidPreset = (preset: PresetChipDef) => {
    const { next: nextAvoid, added } = togglePresetItem(profile.avoid, preset);
    const next = cloneProfileState(profile);
    next.avoid = nextAvoid;
    onChange(next);
    announceStatus(
      added ? `Added ${preset.label} to avoid list.` : `Removed ${preset.label} from avoid list.`
    );
  };

  const handleRemoveAvoid = (item: string) => {
    const next = cloneProfileState(profile);
    next.avoid = removeListItem(profile.avoid, item);
    onChange(next);
    announceStatus(`Removed ${item} from avoid list.`);
  };

  const handleCopySummary = async () => {
    const copied = await copyTextSafe(caregiverSummaryText);
    if (copied) {
      announceStatus("Copied caregiver summary to clipboard.");
    } else {
      announceStatus("Clipboard unavailable. Expand the caregiver summary preview below to copy.");
    }
  };

  const handleUndoDose = () => {
    onUndoLastDose();
    announceStatus("Undid last logged dose.");
  };

  const handleResetDemo = () => {
    onResetDemo();
    announceStatus("Reset profile to demo medications and allergies.");
  };

  return (
    <div className="profile-manager" style={wrapperStyle}>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={srOnlyStyle}
      >
        {statusMessage}
      </div>

      <div
        role="region"
        aria-label="On-device privacy guarantee"
        className="profile-privacy-banner"
        style={bannerCardStyle}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: "1 1 280px" }}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: "26px", height: "26px", flexShrink: 0 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <p style={{ margin: 0, fontSize: "var(--text-base, 1.125rem)", fontWeight: 800 }}>
            Stored on this device only. Never saved on any server.
          </p>
        </div>

        {typeof onOpenPharmacyImport === "function" ? (
          <button
            type="button"
            data-action="open-pharmacy-import"
            className="btn btn-primary"
            onClick={onOpenPharmacyImport}
            style={actionButtonStyle}
          >
            Import Pharmacy QR
          </button>
        ) : null}
      </div>

      <section
        aria-labelledby={langHeadingId}
        className="card profile-language-section"
        style={sectionCardStyle}
      >
        <h2 id={langHeadingId} style={sectionHeadingStyle}>
          Language Preference
        </h2>
        <div style={fieldGroupStyle}>
          <label htmlFor={langSelectId} style={labelStyle}>
            Spoken &amp; Display Language
          </label>
          <select
            id={langSelectId}
            className="input"
            value={selectedLang}
            onChange={handleLanguageChange}
            style={inputMinStyle}
          >
            {SUPPORTED_LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.nativeLabel === item.label
                  ? `${item.label} (${item.code})`
                  : `${item.nativeLabel} / ${item.label} (${item.code})`}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section
        aria-labelledby={medsHeadingId}
        className="card profile-medications-section"
        style={sectionCardStyle}
      >
        <div style={sectionHeaderRowStyle}>
          <h2 id={medsHeadingId} style={sectionHeadingStyle}>
            My Medications
          </h2>
          <span className="badge">
            {profile.meds.length} {profile.meds.length === 1 ? "medication" : "medications"}
          </span>
        </div>

        {profile.meds.length === 0 ? (
          <p style={hintTextStyle}>
            No medications saved yet. Add a medication below or import a pharmacy QR code.
          </p>
        ) : (
          <ul className="profile-med-list" style={medListStyle}>
            {profile.meds.map((med) => {
              const medTitle = med.name || med.ingredient;
              const fullTitle = med.strength ? `${medTitle} ${med.strength}` : medTitle;
              const todayCount = countTodaysDosesForMed(profile, med.id, now);
              const scheduleSlots =
                med.schedule.length > 0 ? med.schedule : ["as needed"];

              return (
                <li key={med.id} className="profile-med-card" style={medCardStyle}>
                  <div style={sectionHeaderRowStyle}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: "var(--text-lg, 1.25rem)", fontWeight: 800 }}>
                        {medTitle}
                      </h3>
                      <p style={hintTextStyle}>
                        Active ingredient: <strong>{med.ingredient || "Not listed"}</strong>
                      </p>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      <span className="badge">{med.strength}</span>
                      {scheduleSlots.map((slot) => (
                        <span key={`${med.id}-${slot}`} className="badge">
                          {slot}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "12px 20px",
                      fontSize: "var(--text-sm, 1rem)",
                      color: "var(--text-secondary, #d8e1ee)"
                    }}
                  >
                    <span>
                      Logged today: <strong>{todayCount}</strong>
                    </span>
                    {med.barcode ? (
                      <span>
                        Barcode: <code>{med.barcode}</code>
                      </span>
                    ) : null}
                    {med.notes ? <span>Notes: {med.notes}</span> : null}
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
                    <button
                      type="button"
                      data-action="log-dose-now"
                      data-med-id={med.id}
                      className="btn btn-secondary"
                      aria-label={`Log Dose Now for ${fullTitle}`}
                      onClick={() => handleLogDoseNow(med)}
                      style={actionButtonStyle}
                    >
                      Log Dose Now
                    </button>
                    <button
                      type="button"
                      data-action="remove-medication"
                      data-med-id={med.id}
                      className="btn btn-danger"
                      aria-label={`Remove ${fullTitle}`}
                      onClick={() => handleRemoveMedication(med)}
                      style={actionButtonStyle}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <form
          onSubmit={handleAddMedication}
          noValidate
          aria-labelledby={addMedHeadingId}
          className="profile-add-med-form"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3, 12px)",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <h3 id={addMedHeadingId} style={subHeadingStyle}>
            Add Medication
          </h3>

          {medFormError ? (
            <div role="alert" style={alertBoxStyle}>
              {medFormError}
            </div>
          ) : null}

          <div style={formGridStyle}>
            <div style={fieldGroupStyle}>
              <label htmlFor={medNameId} style={labelStyle}>
                Medication name
              </label>
              <input
                id={medNameId}
                type="text"
                className="input"
                placeholder="Amlodipin"
                value={medName}
                onChange={(ev) => setMedName(ev.target.value)}
                style={inputMinStyle}
              />
            </div>

            <div style={fieldGroupStyle}>
              <label htmlFor={medIngredientId} style={labelStyle}>
                Active ingredient
              </label>
              <input
                id={medIngredientId}
                type="text"
                className="input"
                placeholder="amlodipine"
                value={medIngredient}
                onChange={(ev) => setMedIngredient(ev.target.value)}
                style={inputMinStyle}
              />
            </div>

            <div style={fieldGroupStyle}>
              <label htmlFor={medStrengthId} style={labelStyle}>
                Strength
              </label>
              <input
                id={medStrengthId}
                type="text"
                className="input"
                placeholder="5 mg"
                value={medStrength}
                onChange={(ev) => setMedStrength(ev.target.value)}
                style={inputMinStyle}
              />
            </div>

            <div style={fieldGroupStyle}>
              <label htmlFor={medBarcodeId} style={labelStyle}>
                Barcode digits (optional)
              </label>
              <input
                id={medBarcodeId}
                type="text"
                inputMode="numeric"
                className="input"
                placeholder="6432100012345"
                value={medBarcode}
                onChange={(ev) => setMedBarcode(ev.target.value)}
                style={inputMinStyle}
              />
            </div>
          </div>

          <fieldset
            style={{
              margin: 0,
              padding: "var(--space-3, 12px)",
              borderRadius: "var(--radius-sm, 8px)",
              border: "1.5px solid var(--border-subtle, #2c3a52)"
            }}
          >
            <legend style={{ padding: "0 6px", fontWeight: 700, fontSize: "var(--text-sm, 1rem)" }}>
              Schedule
            </legend>
            <div style={chipWrapStyle}>
              {SCHEDULE_SLOTS.map((slot) => {
                const checked = medSchedule.includes(slot);
                return (
                  <label
                    key={slot}
                    className="chip"
                    style={{
                      minHeight: "56px",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      borderColor: checked ? "var(--accent, #5cc0ff)" : undefined,
                      backgroundColor: checked
                        ? "var(--accent-subtle, rgba(92, 192, 255, 0.16))"
                        : undefined
                    }}
                  >
                    <input
                      type="checkbox"
                      name="schedule"
                      value={slot}
                      checked={checked}
                      onChange={() => handleScheduleToggle(slot)}
                      style={{ width: "20px", height: "20px" }}
                    />
                    <span>{slot}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <button
              type="submit"
              data-action="submit-add-medication"
              className="btn btn-primary"
              style={actionButtonStyle}
            >
              Add Medication
            </button>
          </div>
        </form>
      </section>

      <section
        aria-labelledby={allergiesHeadingId}
        className="card profile-allergies-section"
        style={sectionCardStyle}
      >
        <div style={sectionHeaderRowStyle}>
          <h2 id={allergiesHeadingId} style={sectionHeadingStyle}>
            Allergies
          </h2>
          <span className="badge">{profile.allergies.length} active</span>
        </div>

        {profile.allergies.length === 0 ? (
          <p style={hintTextStyle}>No allergies listed on this device.</p>
        ) : (
          <ul aria-label="Saved allergies" style={tagWrapStyle}>
            {profile.allergies.map((allergy) => (
              <li key={allergy}>
                <button
                  type="button"
                  data-action="remove-allergy"
                  className="chip"
                  aria-label={`Remove allergy ${allergy}`}
                  onClick={() => handleRemoveAllergy(allergy)}
                  style={chipButtonStyle}
                >
                  <span>{allergy}</span>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleAddCustomAllergy} style={inlineFormRowStyle}>
          <div style={{ ...fieldGroupStyle, flex: "1 1 220px" }}>
            <label htmlFor={customAllergyId} style={labelStyle}>
              Add custom allergy
            </label>
            <input
              id={customAllergyId}
              type="text"
              className="input"
              placeholder="Hazelnut, sulfites, amoxicillin"
              value={customAllergy}
              onChange={(ev) => setCustomAllergy(ev.target.value)}
              style={inputMinStyle}
            />
          </div>
          <button
            type="submit"
            data-action="add-custom-allergy"
            className="btn btn-secondary"
            style={actionButtonStyle}
          >
            Add Allergy
          </button>
        </form>

        <div style={fieldGroupStyle}>
          <span style={labelStyle}>Quick-add allergy presets</span>
          <div role="group" aria-label="Quick-add allergy presets" style={chipWrapStyle}>
            {ALLERGY_PRESET_CHIPS.map((preset) => {
              const active = isPresetActive(profile.allergies, preset);
              return (
                <button
                  key={preset.label}
                  type="button"
                  data-preset-allergy={preset.label}
                  className="chip"
                  aria-pressed={active}
                  onClick={() => handleToggleAllergyPreset(preset)}
                  style={chipButtonStyle}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section
        aria-labelledby={avoidHeadingId}
        className="card profile-avoid-section"
        style={sectionCardStyle}
      >
        <div style={sectionHeaderRowStyle}>
          <h2 id={avoidHeadingId} style={sectionHeadingStyle}>
            Avoid List
          </h2>
          <span className="badge">{profile.avoid.length} active</span>
        </div>

        {profile.avoid.length === 0 ? (
          <p style={hintTextStyle}>No drug classes or ingredients on your avoid list.</p>
        ) : (
          <ul aria-label="Saved avoid list" style={tagWrapStyle}>
            {profile.avoid.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  data-action="remove-avoid"
                  className="chip"
                  aria-label={`Remove avoid rule ${item}`}
                  onClick={() => handleRemoveAvoid(item)}
                  style={chipButtonStyle}
                >
                  <span>{item}</span>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleAddCustomAvoid} style={inlineFormRowStyle}>
          <div style={{ ...fieldGroupStyle, flex: "1 1 220px" }}>
            <label htmlFor={customAvoidId} style={labelStyle}>
              Add drug class or ingredient to avoid
            </label>
            <input
              id={customAvoidId}
              type="text"
              className="input"
              placeholder="NSAIDs, grapefruit, codeine"
              value={customAvoid}
              onChange={(ev) => setCustomAvoid(ev.target.value)}
              style={inputMinStyle}
            />
          </div>
          <button
            type="submit"
            data-action="add-custom-avoid"
            className="btn btn-secondary"
            style={actionButtonStyle}
          >
            Add Avoid Rule
          </button>
        </form>

        <div style={fieldGroupStyle}>
          <span style={labelStyle}>Quick-add avoid presets</span>
          <div role="group" aria-label="Quick-add avoid presets" style={chipWrapStyle}>
            {AVOID_PRESET_CHIPS.map((preset) => {
              const active = isPresetActive(profile.avoid, preset);
              return (
                <button
                  key={preset.label}
                  type="button"
                  data-preset-avoid={preset.label}
                  className="chip"
                  aria-pressed={active}
                  onClick={() => handleToggleAvoidPreset(preset)}
                  style={chipButtonStyle}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section
        aria-labelledby={doseLogHeadingId}
        className="card profile-dose-log-section"
        style={sectionCardStyle}
      >
        <div style={sectionHeaderRowStyle}>
          <h2 id={doseLogHeadingId} style={sectionHeadingStyle}>
            Today&apos;s Dose Log
          </h2>
          <span className="badge">
            {todaysDoseEntries.length} {todaysDoseEntries.length === 1 ? "dose" : "doses"} today
          </span>
        </div>

        {todaysDoseEntries.length === 0 ? (
          <p style={hintTextStyle}>No doses logged yet today.</p>
        ) : (
          <ol
            aria-label="Today's logged doses, newest first"
            className="profile-dose-log-list"
            style={medListStyle}
          >
            {todaysDoseEntries.map((entry) => (
              <li
                key={`${entry.medId}-${entry.ts}-${entry.index}`}
                className="profile-dose-log-item"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px 16px",
                  padding: "12px 16px",
                  borderRadius: "var(--radius-sm, 8px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  border: "1.5px solid var(--border-subtle, #2c3a52)"
                }}
              >
                <strong style={{ fontSize: "var(--text-base, 1.125rem)" }}>
                  {entry.strength ? `${entry.medName} ${entry.strength}` : entry.medName}
                </strong>
                <time className="badge" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                  {entry.timeText}
                </time>
              </li>
            ))}
          </ol>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          <button
            type="button"
            data-action="undo-last-dose"
            className="btn btn-secondary"
            disabled={totalDoseLogCount === 0}
            aria-disabled={totalDoseLogCount === 0}
            onClick={handleUndoDose}
            style={actionButtonStyle}
          >
            Undo Last Dose
          </button>

          <button
            type="button"
            data-action="copy-caregiver-summary"
            className="btn btn-primary"
            onClick={() => void handleCopySummary()}
            style={actionButtonStyle}
          >
            Copy Caregiver Summary
          </button>

          <button
            type="button"
            data-action="reset-demo-profile"
            className="btn btn-secondary"
            onClick={handleResetDemo}
            style={actionButtonStyle}
          >
            Reset to Demo Profile
          </button>
        </div>

        {statusMessage ? (
          <p
            aria-hidden="true"
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 700,
              color: "var(--verdict-match-fg, #7ef7c8)"
            }}
          >
            {statusMessage}
          </p>
        ) : null}

        {caregiverSummaryText.trim().length > 0 ? (
          <details
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
              Preview Caregiver Summary Text
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
              {caregiverSummaryText}
            </pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}

export default ProfileManager;
