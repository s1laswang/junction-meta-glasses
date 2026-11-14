import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { Med, Profile } from "../types.ts";

export type EmergencyMedCardProps = {
  profile: Profile;
  lang: string;
  onCopyText?: (text: string) => void;
  onPrint?: () => void;
};

type CanonicalSlot = "morning" | "noon" | "evening" | "bedtime" | "as_needed";

type NormalizedWalletMed = {
  id: string;
  name: string;
  ingredient: string;
  strength: string;
  scheduleLabels: string[];
  isScheduled: boolean;
  notes: string;
};

type NormalizedWalletData = {
  locale: UiLocale;
  allergies: string[];
  avoid: string[];
  meds: NormalizedWalletMed[];
  scheduledCount: number;
  asNeededCount: number;
};

type LocaleCopy = {
  walletHeader: string;
  walletSourceLine: string;
  walletAllergiesLine: (count: number, list: string) => string;
  walletAvoidLine: (count: number, list: string) => string;
  walletMedsHeader: (total: number, scheduled: number) => string;
  walletMedItem: (
    idx: number,
    name: string,
    ingredient: string,
    strength: string,
    schedule: string
  ) => string;
  walletNoticePrefix: string;
  noneRecorded: string;
  notListed: string;
  slotLabels: Record<CanonicalSlot, string>;
  eyebrow: string;
  heading: string;
  subtitle: string;
  onDevicePill: string;
  badgesGroupAria: string;
  allergiesBadge: (count: number) => string;
  avoidBadge: (count: number) => string;
  scheduledBadge: (scheduled: number, prn: number) => string;
  overviewDlAria: string;
  dtAllergies: string;
  dtAvoid: string;
  dtSource: string;
  ddSource: string;
  allergiesListAria: string;
  avoidListAria: string;
  medsSectionHeading: string;
  noMedsRecorded: string;
  medScheduledTag: string;
  medAsNeededTag: string;
  fieldIngredient: string;
  fieldStrength: string;
  fieldSchedule: string;
  fieldNotes: string;
  actionsGroupAria: string;
  copyBtnLabel: string;
  copyBtnAria: string;
  printBtnLabel: string;
  printBtnAria: string;
  copiedFeedback: string;
  copyUnavailableFeedback: string;
  printedFeedback: string;
  previewSummaryLabel: string;
  privacyHeading: string;
  privacyBody: string;
};

const AS_NEEDED_RE =
  /^(as[-_ ]?needed|when[-_ ]?needed|if[-_ ]?needed|prn|optional|tarvittaessa|vid behov)$/i;

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    walletHeader: "HoldUp Emergency Medication & Allergy Wallet Summary",
    walletSourceLine:
      "Data source: User-maintained on-device profile (stored locally on this device only, zero cloud upload).",
    walletAllergiesLine: (count, list) => `Drug & Food Allergies (${count}): ${list}`,
    walletAvoidLine: (count, list) => `Avoid Drug Classes & Ingredients (${count}): ${list}`,
    walletMedsHeader: (total, scheduled) =>
      `Active Medications (${total} total, ${scheduled} scheduled):`,
    walletMedItem: (idx, name, ingredient, strength, schedule) =>
      `${idx}. ${name} | Active ingredient: ${ingredient} | Strength: ${strength} | Schedule: ${schedule}`,
    walletNoticePrefix: "Safety & Privacy Notice: User-maintained on-device data only.",
    noneRecorded: "None recorded on this device",
    notListed: "not listed",
    slotLabels: {
      morning: "morning",
      noon: "noon",
      evening: "evening",
      bedtime: "bedtime",
      as_needed: "as needed"
    },
    eyebrow: "Pharmacist, Clinic & Travel Handoff",
    heading: "Emergency Medication & Allergy Wallet Card",
    subtitle:
      "Structured, screen-reader-first wallet summary generated strictly on this device from your saved profile.",
    onDevicePill: "100% On-Device / Zero Cloud",
    badgesGroupAria: "Medication and allergy summary counts",
    allergiesBadge: (count) => `Allergies: ${count}`,
    avoidBadge: (count) => `Avoid Rules: ${count}`,
    scheduledBadge: (scheduled, prn) =>
      prn > 0
        ? `Scheduled Medications: ${scheduled} (+${prn} as needed)`
        : `Scheduled Medications: ${scheduled}`,
    overviewDlAria: "Emergency allergy, avoid-rule, and source summary",
    dtAllergies: "Drug & Food Allergies",
    dtAvoid: "Avoid Rules & Drug Classes",
    dtSource: "Data Source",
    ddSource: "User-maintained on-device profile (local storage only, zero cloud upload)",
    allergiesListAria: "Recorded drug and food allergies",
    avoidListAria: "Recorded drug classes and ingredients to avoid",
    medsSectionHeading: "Active Prescriptions & Medications",
    noMedsRecorded: "No medications recorded on this device.",
    medScheduledTag: "Scheduled",
    medAsNeededTag: "As needed",
    fieldIngredient: "Active ingredient",
    fieldStrength: "Strength",
    fieldSchedule: "Schedule",
    fieldNotes: "Notes",
    actionsGroupAria: "Wallet card copy and print actions",
    copyBtnLabel: "Copy Wallet Text",
    copyBtnAria: "Copy plain-text emergency medication and allergy wallet summary",
    printBtnLabel: "Print Wallet Card",
    printBtnAria: "Print emergency medication and allergy wallet card",
    copiedFeedback: "Copied emergency medication and allergy wallet summary to clipboard.",
    copyUnavailableFeedback:
      "Clipboard unavailable. Open the plain-text wallet preview below to copy manually.",
    printedFeedback: "Opened print view for emergency medication and allergy wallet card.",
    previewSummaryLabel: "Preview Plain-Text Wallet Summary",
    privacyHeading: "Local-Only Privacy & Assistive Boundary",
    privacyBody:
      "Generated strictly on this device from user-maintained local data with zero server or cloud upload."
  },
  fi: {
    walletHeader: "HoldUp Hätä- ja apteekkilääkekortti (lääkkeet ja allergiat)",
    walletSourceLine:
      "Tietolähde: Käyttäjän itse laitteella ylläpitämä profiili (tallennettu vain tälle laitteelle, ei pilvilatausta).",
    walletAllergiesLine: (count, list) => `Lääke- ja ruoka-allergiat (${count}): ${list}`,
    walletAvoidLine: (count, list) => `Vältettävät lääkeluokat ja aineet (${count}): ${list}`,
    walletMedsHeader: (total, scheduled) =>
      `Käytössä olevat lääkkeet (${total} yhteensä, ${scheduled} säännöllistä):`,
    walletMedItem: (idx, name, ingredient, strength, schedule) =>
      `${idx}. ${name} | Vaikuttava aine: ${ingredient} | Vahvuus: ${strength} | Ottoajat: ${schedule}`,
    walletNoticePrefix:
      "Tietosuoja- ja turvahuomautus: Käyttäjän ylläpitämä paikallinen laitetieto.",
    noneRecorded: "Ei tallennettuja tietoja tällä laitteella",
    notListed: "ei ilmoitettu",
    slotLabels: {
      morning: "aamu",
      noon: "päivä",
      evening: "ilta",
      bedtime: "yö",
      as_needed: "tarvittaessa"
    },
    eyebrow: "Apteekki-, klinikka- ja matkakortti",
    heading: "Hätä- ja apteekkilääkekortti",
    subtitle:
      "Ruudunlukijaystävällinen ja tulostettava yhteenveto, joka muodostetaan vain tällä laitteella olevasta profiilistasi.",
    onDevicePill: "100 % laitteella / Ei pilveä",
    badgesGroupAria: "Lääkkeiden ja allergioiden yhteenvetomäärät",
    allergiesBadge: (count) => `Allergiat: ${count}`,
    avoidBadge: (count) => `Estosäännöt: ${count}`,
    scheduledBadge: (scheduled, prn) =>
      prn > 0
        ? `Säännölliset lääkkeet: ${scheduled} (+${prn} tarvittaessa)`
        : `Säännölliset lääkkeet: ${scheduled}`,
    overviewDlAria: "Allergioiden, estosääntöjen ja tietolähteen yhteenveto",
    dtAllergies: "Lääke- ja ruoka-allergiat",
    dtAvoid: "Estosäännöt ja vältettävät lääkeluokat",
    dtSource: "Tietolähde",
    ddSource:
      "Käyttäjän laitteella ylläpitämä profiili (vain paikallinen tallennus, ei pilvilatausta)",
    allergiesListAria: "Tallennetut lääke- ja ruoka-allergiat",
    avoidListAria: "Tallennetut vältettävät lääkeluokat ja aineet",
    medsSectionHeading: "Käytössä olevat lääkkeet",
    noMedsRecorded: "Tälle laitteelle ei ole tallennettu lääkkeitä.",
    medScheduledTag: "Säännöllinen",
    medAsNeededTag: "Tarvittaessa",
    fieldIngredient: "Vaikuttava aine",
    fieldStrength: "Vahvuus",
    fieldSchedule: "Ottoajat",
    fieldNotes: "Lisätiedot",
    actionsGroupAria: "Lääkekortin kopiointi ja tulostus",
    copyBtnLabel: "Kopioi lääkekortin teksti",
    copyBtnAria: "Kopioi lääke- ja allergiakortin tekstiyhteenveto leikepöydälle",
    printBtnLabel: "Tulosta lääkekortti",
    printBtnAria: "Tulosta hätä- ja apteekkilääkekortti",
    copiedFeedback: "Lääke- ja allergiakortin yhteenveto kopioitu leikepöydälle.",
    copyUnavailableFeedback:
      "Leikepöytä ei ole käytettävissä. Avaa alla oleva tekstiesikatselu kopioidaksesi.",
    printedFeedback: "Tulostusnäkymä avattu lääke- ja allergiakortille.",
    previewSummaryLabel: "Näytä lääkekortin tekstiyhteenveto",
    privacyHeading: "Paikallinen tietosuoja ja avustava käyttöraja",
    privacyBody:
      "Muodostetaan vain tällä laitteella käyttäjän ylläpitämistä paikallisista tiedoista ilman pilvilatausta."
  },
  sv: {
    walletHeader: "HoldUp Akut läkemedels- och allergikort",
    walletSourceLine:
      "Datakälla: Användarunderhållen profil på enheten (sparad lokalt endast på den här enheten, ingen molnuppladdning).",
    walletAllergiesLine: (count, list) => `Läkemedels- och matallergier (${count}): ${list}`,
    walletAvoidLine: (count, list) => `Läkemedelsklasser och ämnen att undvika (${count}): ${list}`,
    walletMedsHeader: (total, scheduled) =>
      `Aktiva läkemedel (${total} totalt, ${scheduled} schemalagda):`,
    walletMedItem: (idx, name, ingredient, strength, schedule) =>
      `${idx}. ${name} | Aktiv substans: ${ingredient} | Styrka: ${strength} | Tider: ${schedule}`,
    walletNoticePrefix:
      "Integritets- och säkerhetsnotis: Endast användarunderhållen lokal data på enheten.",
    noneRecorded: "Inga registrerade uppgifter på den här enheten",
    notListed: "ej angiven",
    slotLabels: {
      morning: "morgon",
      noon: "lunch",
      evening: "kväll",
      bedtime: "natt",
      as_needed: "vid behov"
    },
    eyebrow: "Apoteks-, klinik- och resekort",
    heading: "Akut läkemedels- och allergikort",
    subtitle:
      "Skärmläsaranpassad och utskrivbar sammanfattning som skapas lokalt på den här enheten från din sparade profil.",
    onDevicePill: "100 % på enheten / Inget moln",
    badgesGroupAria: "Sammanfattning av läkemedel och allergier",
    allergiesBadge: (count) => `Allergier: ${count}`,
    avoidBadge: (count) => `Undvikanderegler: ${count}`,
    scheduledBadge: (scheduled, prn) =>
      prn > 0
        ? `Schemalagda läkemedel: ${scheduled} (+${prn} vid behov)`
        : `Schemalagda läkemedel: ${scheduled}`,
    overviewDlAria: "Översikt av allergier, undvikanderegler och datakälla",
    dtAllergies: "Läkemedels- och matallergier",
    dtAvoid: "Undvikanderegler och läkemedelsklasser",
    dtSource: "Datakälla",
    ddSource:
      "Användarunderhållen profil på enheten (endast lokal lagring, ingen molnuppladdning)",
    allergiesListAria: "Registrerade läkemedels- och matallergier",
    avoidListAria: "Registrerade läkemedelsklasser och ämnen att undvika",
    medsSectionHeading: "Aktiva läkemedel och recept",
    noMedsRecorded: "Inga läkemedel registrerade på den här enheten.",
    medScheduledTag: "Schemalagd",
    medAsNeededTag: "Vid behov",
    fieldIngredient: "Aktiv substans",
    fieldStrength: "Styrka",
    fieldSchedule: "Tider",
    fieldNotes: "Anteckningar",
    actionsGroupAria: "Kopiera och skriv ut läkemedelskort",
    copyBtnLabel: "Kopiera korttext",
    copyBtnAria: "Kopiera textsammanfattning av läkemedels- och allergikortet",
    printBtnLabel: "Skriv ut läkemedelskort",
    printBtnAria: "Skriv ut akut läkemedels- och allergikort",
    copiedFeedback: "Sammanfattning av läkemedels- och allergikort kopierad till urklipp.",
    copyUnavailableFeedback:
      "Urklipp är inte tillgängligt. Öppna textförhandsgranskningen nedan för att kopiera.",
    printedFeedback: "Öppnade utskriftsvy för läkemedels- och allergikort.",
    previewSummaryLabel: "Förhandsgranska korttext",
    privacyHeading: "Lokal integritet och assisterande gräns",
    privacyBody:
      "Skapas uteslutande på den här enheten från användarunderhållen lokal data utan molnuppladdning."
  }
};

const PRINT_STYLES = [
  "@media print {",
  "  .emergency-med-card, .emergency-med-card * {",
  "    background: #ffffff !important;",
  "    color: #000000 !important;",
  "    border-color: #000000 !important;",
  "    box-shadow: none !important;",
  "  }",
  "  .emergency-med-card { break-inside: avoid; page-break-inside: avoid; }",
  "  .emergency-med-item { break-inside: avoid; page-break-inside: avoid; }",
  "  .emergency-med-actions, .emergency-wallet-preview { display: none !important; }",
  "}"
].join("\n");

function sanitizeInlineValue(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/[\u0000-\u001F\u007F\u2013\u2014]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = sanitizeInlineValue(item);
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

function isAsNeededSlot(rawSlot: string): boolean {
  const trimmed = rawSlot.trim().toLowerCase();
  if (!trimmed || AS_NEEDED_RE.test(trimmed)) {
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

function classifyCanonicalSlot(rawSlot: string): CanonicalSlot | null {
  const lower = rawSlot.trim().toLowerCase();
  if (!lower) {
    return null;
  }
  if (isAsNeededSlot(lower)) {
    return "as_needed";
  }
  if (lower === "morning" || lower === "aamu" || lower === "morgon" || lower === "am") {
    return "morning";
  }
  if (
    lower === "noon" ||
    lower === "midday" ||
    lower === "mid-day" ||
    lower === "lunch" ||
    lower === "päivä" ||
    lower === "paiva"
  ) {
    return "noon";
  }
  if (lower === "evening" || lower === "ilta" || lower === "kväll" || lower === "kvall" || lower === "pm") {
    return "evening";
  }
  if (
    lower === "bedtime" ||
    lower === "night" ||
    lower === "yö" ||
    lower === "yo" ||
    lower === "natt" ||
    lower === "hs"
  ) {
    return "bedtime";
  }
  return null;
}

function localizeSlot(rawSlot: string, copy: LocaleCopy): string {
  const canonical = classifyCanonicalSlot(rawSlot);
  if (canonical !== null) {
    return copy.slotLabels[canonical];
  }
  return sanitizeInlineValue(rawSlot);
}

function extractRawMedSchedule(med: Med): string[] {
  const legacyTimes = (med as Med & { times?: unknown }).times;
  const source =
    Array.isArray(med.schedule) && med.schedule.length > 0
      ? med.schedule
      : Array.isArray(legacyTimes)
        ? legacyTimes
        : [];
  const out: string[] = [];
  for (const slot of source) {
    const cleaned = sanitizeInlineValue(slot);
    if (cleaned) {
      out.push(cleaned);
    }
  }
  return out;
}

function extractRawIngredient(med: Med): string {
  const primary = sanitizeInlineValue(med.ingredient);
  if (primary) {
    return primary;
  }
  const alias = (med as Med & { activeIngredient?: unknown }).activeIngredient;
  return sanitizeInlineValue(alias);
}

function normalizeWalletData(profile: Profile, lang: string): NormalizedWalletData {
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const allergies = sanitizeStringList(profile?.allergies);
  const avoid = sanitizeStringList(profile?.avoid);
  const rawMeds = Array.isArray(profile?.meds) ? profile.meds : [];

  const meds: NormalizedWalletMed[] = [];
  let scheduledCount = 0;
  let asNeededCount = 0;

  for (let i = 0; i < rawMeds.length; i += 1) {
    const med = rawMeds[i];
    if (!med || typeof med !== "object") {
      continue;
    }
    const rawName = sanitizeInlineValue(med.name);
    const rawIngredient = extractRawIngredient(med);
    if (!rawName && !rawIngredient) {
      continue;
    }
    const id = sanitizeInlineValue(med.id) || `med-${i + 1}`;
    const name = rawName || rawIngredient;
    const ingredient = rawIngredient || copy.notListed;
    const strength = sanitizeInlineValue(med.strength) || copy.notListed;
    const rawSlots = extractRawMedSchedule(med);
    const hasScheduledSlot = rawSlots.some((slot) => !isAsNeededSlot(slot));
    const scheduleLabels =
      rawSlots.length > 0
        ? rawSlots.map((slot) => localizeSlot(slot, copy))
        : [copy.slotLabels.as_needed];

    if (hasScheduledSlot) {
      scheduledCount += 1;
    } else {
      asNeededCount += 1;
    }

    meds.push({
      id,
      name,
      ingredient,
      strength,
      scheduleLabels,
      isScheduled: hasScheduledSlot,
      notes: sanitizeInlineValue(med.notes)
    });
  }

  return {
    locale,
    allergies,
    avoid,
    meds,
    scheduledCount,
    asNeededCount
  };
}

export function formatEmergencyWalletText(profile: Profile, lang: string): string {
  const data = normalizeWalletData(profile, lang);
  const copy = COPY_BY_LOCALE[data.locale];
  const disclaimer = t(data.locale, "notMedicalDevice");

  const allergiesSummary =
    data.allergies.length > 0 ? data.allergies.join(", ") : copy.noneRecorded;
  const avoidSummary =
    data.avoid.length > 0 ? data.avoid.join(", ") : copy.noneRecorded;

  const lines: string[] = [
    copy.walletHeader,
    copy.walletSourceLine,
    "",
    copy.walletAllergiesLine(data.allergies.length, allergiesSummary),
    copy.walletAvoidLine(data.avoid.length, avoidSummary),
    "",
    copy.walletMedsHeader(data.meds.length, data.scheduledCount)
  ];

  if (data.meds.length === 0) {
    lines.push(copy.noneRecorded);
  } else {
    data.meds.forEach((med, idx) => {
      lines.push(
        copy.walletMedItem(
          idx + 1,
          med.name,
          med.ingredient,
          med.strength,
          med.scheduleLabels.join(", ")
        )
      );
    });
  }

  lines.push("", `${copy.walletNoticePrefix} ${disclaimer}`);
  return lines.join("\n");
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
  if (typeof document !== "undefined" && document.body && typeof document.createElement === "function") {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      if (typeof area.select === "function") {
        area.select();
      }
      const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
  return false;
}

const SR_ONLY_STYLE: CSSProperties = {
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

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
  boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
};

const ACTION_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 20px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 800,
  flex: "1 1 220px"
};

const ICON_STYLE: CSSProperties = {
  width: "18px",
  height: "18px",
  flexShrink: 0
};

function WalletBadgeIcon({ kind }: { kind: "allergies" | "avoid" | "meds" | "copy" | "print" | "shield" }) {
  if (kind === "allergies") {
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
        style={ICON_STYLE}
      >
        <path d="M12 3L22 20H2L12 3z" />
        <line x1="12" y1="9" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (kind === "avoid") {
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
        style={ICON_STYLE}
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
      </svg>
    );
  }

  if (kind === "meds") {
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
        style={ICON_STYLE}
      >
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 12h6" />
        <path d="M12 9v6" />
      </svg>
    );
  }

  if (kind === "copy") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={ICON_STYLE}
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }

  if (kind === "print") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={ICON_STYLE}
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={ICON_STYLE}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function EmergencyMedCard(props: EmergencyMedCardProps) {
  const { profile, lang, onCopyText, onPrint } = props;
  const uid = useId();
  const [feedback, setFeedback] = useState("");
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const announce = (message: string) => {
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedback(message);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback("");
      feedbackTimerRef.current = null;
    }, 4000);
  };

  const data = normalizeWalletData(profile, lang);
  const copy = COPY_BY_LOCALE[data.locale];
  const disclaimerText = t(data.locale, "notMedicalDevice");
  const walletText = formatEmergencyWalletText(profile, data.locale);

  const headingId = `${uid}-emergency-wallet-heading`;
  const medsHeadingId = `${uid}-emergency-meds-heading`;

  const handleCopy = async () => {
    const hasCallback = typeof onCopyText === "function";
    if (hasCallback) {
      onCopyText(walletText);
    }
    const copiedToClipboard = await copyTextSafe(walletText);
    if (hasCallback || copiedToClipboard) {
      announce(copy.copiedFeedback);
    } else {
      announce(copy.copyUnavailableFeedback);
    }
  };

  const handlePrint = () => {
    if (typeof onPrint === "function") {
      onPrint();
      announce(copy.printedFeedback);
      return;
    }
    if (typeof globalThis.window !== "undefined" && typeof globalThis.window.print === "function") {
      globalThis.window.print();
    }
    announce(copy.printedFeedback);
  };

  const hasAllergies = data.allergies.length > 0;
  const hasAvoid = data.avoid.length > 0;
  const hasScheduled = data.scheduledCount > 0;

  return (
    <section
      className="card emergency-med-card"
      lang={data.locale}
      aria-labelledby={headingId}
      style={CARD_STYLE}
    >
      <style>{PRINT_STYLES}</style>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only emergency-wallet-live-status"
        data-wallet-live-status="true"
        style={SR_ONLY_STYLE}
      >
        {feedback}
      </div>

      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            flex: "1 1 320px"
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--accent, #5cc0ff)"
            }}
          >
            {copy.eyebrow}
          </p>

          <h2
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-xl, 1.5rem)",
              fontWeight: 800,
              lineHeight: 1.25,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.heading}
          </h2>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.subtitle}
          </p>
        </div>

        <span
          className="pill emergency-on-device-pill"
          style={{
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            color: "var(--text-primary, #f8fafc)",
            border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 700
          }}
        >
          {copy.onDevicePill}
        </span>
      </header>

      <div
        role="group"
        aria-label={copy.badgesGroupAria}
        className="emergency-summary-badges"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-2, 8px)"
        }}
      >
        <span
          className="badge emergency-badge-allergies"
          data-wallet-badge="allergies"
          data-count={String(data.allergies.length)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            minHeight: "38px",
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            ...(hasAllergies
              ? {
                  backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
                  color: "var(--verdict-warning-fg, #ffb8ab)",
                  border: "2px double var(--verdict-warning-border, #ff6b52)"
                }
              : {
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  color: "var(--text-primary, #f8fafc)",
                  border: "1.5px solid var(--border-strong, #6980a3)"
                })
          }}
        >
          <WalletBadgeIcon kind="allergies" />
          <span>{copy.allergiesBadge(data.allergies.length)}</span>
        </span>

        <span
          className="badge emergency-badge-avoid"
          data-wallet-badge="avoid"
          data-count={String(data.avoid.length)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            minHeight: "38px",
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            ...(hasAvoid
              ? {
                  backgroundColor: "var(--verdict-unsure-bg, #261b04)",
                  color: "var(--verdict-unsure-fg, #ffe169)",
                  border: "2px solid var(--verdict-unsure-border, #f5b82e)"
                }
              : {
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  color: "var(--text-primary, #f8fafc)",
                  border: "1.5px solid var(--border-strong, #6980a3)"
                })
          }}
        >
          <WalletBadgeIcon kind="avoid" />
          <span>{copy.avoidBadge(data.avoid.length)}</span>
        </span>

        <span
          className="badge emergency-badge-scheduled"
          data-wallet-badge="scheduled-meds"
          data-count={String(data.scheduledCount)}
          data-total-meds={String(data.meds.length)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            minHeight: "38px",
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            ...(hasScheduled
              ? {
                  backgroundColor: "var(--verdict-match-bg, #06261d)",
                  color: "var(--verdict-match-fg, #7ef7c8)",
                  border: "2px solid var(--verdict-match-border, #2dd4a0)"
                }
              : {
                  backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                  color: "var(--verdict-info-fg, #a6d4ff)",
                  border: "1.5px dashed var(--verdict-info-border, #4da3ff)"
                })
          }}
        >
          <WalletBadgeIcon kind="meds" />
          <span>{copy.scheduledBadge(data.scheduledCount, data.asNeededCount)}</span>
        </span>
      </div>

      <dl
        aria-label={copy.overviewDlAria}
        className="emergency-overview-dl"
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          className="emergency-dl-group emergency-dl-allergies"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: hasAllergies
              ? "2px double var(--verdict-warning-border, #ff6b52)"
              : "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <dt
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.dtAllergies}
          </dt>
          <dd style={{ margin: 0 }}>
            {hasAllergies ? (
              <ul
                aria-label={copy.allergiesListAria}
                className="emergency-allergy-list"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px"
                }}
              >
                {data.allergies.map((item) => (
                  <li
                    key={item}
                    className="badge emergency-allergy-chip"
                    style={{
                      backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
                      color: "var(--verdict-warning-fg, #ffb8ab)",
                      border: "1.5px solid var(--verdict-warning-border, #ff6b52)",
                      padding: "4px 10px",
                      fontSize: "var(--text-sm, 1rem)",
                      fontWeight: 800
                    }}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <span
                style={{
                  fontSize: "var(--text-sm, 1rem)",
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {copy.noneRecorded}
              </span>
            )}
          </dd>
        </div>

        <div
          className="emergency-dl-group emergency-dl-avoid"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: hasAvoid
              ? "2px solid var(--verdict-unsure-border, #f5b82e)"
              : "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <dt
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.dtAvoid}
          </dt>
          <dd style={{ margin: 0 }}>
            {hasAvoid ? (
              <ul
                aria-label={copy.avoidListAria}
                className="emergency-avoid-list"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px"
                }}
              >
                {data.avoid.map((item) => (
                  <li
                    key={item}
                    className="badge emergency-avoid-chip"
                    style={{
                      backgroundColor: "var(--verdict-unsure-bg, #261b04)",
                      color: "var(--verdict-unsure-fg, #ffe169)",
                      border: "1.5px solid var(--verdict-unsure-border, #f5b82e)",
                      padding: "4px 10px",
                      fontSize: "var(--text-sm, 1rem)",
                      fontWeight: 800
                    }}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <span
                style={{
                  fontSize: "var(--text-sm, 1rem)",
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {copy.noneRecorded}
              </span>
            )}
          </dd>
        </div>

        <div
          className="emergency-dl-group emergency-dl-source"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            backgroundColor: "var(--bg-elevated, #1a2333)",
            border: "1.5px solid var(--border-subtle, #2c3a52)"
          }}
        >
          <dt
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.dtSource}
          </dt>
          <dd
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.ddSource}
          </dd>
        </div>
      </dl>

      <div
        role="group"
        aria-labelledby={medsHeadingId}
        className="emergency-meds-section"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)"
        }}
      >
        <h3
          id={medsHeadingId}
          style={{
            margin: 0,
            fontSize: "var(--text-lg, 1.25rem)",
            fontWeight: 800,
            lineHeight: 1.3,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.medsSectionHeading}
        </h3>

        {data.meds.length === 0 ? (
          <p
            className="emergency-meds-empty"
            style={{
              margin: 0,
              padding: "var(--space-4, 16px)",
              borderRadius: "var(--radius-md, 12px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              border: "1.5px dashed var(--border-strong, #6980a3)",
              color: "var(--text-secondary, #d8e1ee)",
              fontSize: "var(--text-sm, 1rem)"
            }}
          >
            {copy.noMedsRecorded}
          </p>
        ) : (
          <ul
            aria-labelledby={medsHeadingId}
            className="emergency-med-list"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3, 12px)"
            }}
          >
            {data.meds.map((med) => (
              <li
                key={med.id}
                data-med-id={med.id}
                className="emergency-med-item"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  padding: "var(--space-4, 16px)",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  border: med.isScheduled
                    ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                    : "1.5px dashed var(--border-strong, #6980a3)"
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
                  <strong
                    className="emergency-med-title"
                    style={{
                      fontSize: "var(--text-lg, 1.25rem)",
                      fontWeight: 800,
                      color: "var(--text-primary, #f8fafc)"
                    }}
                  >
                    {`${med.name} ${med.strength}`}
                  </strong>

                  <span
                    className="badge emergency-med-kind-badge"
                    style={{
                      padding: "4px 10px",
                      borderRadius: "var(--radius-pill, 9999px)",
                      fontSize: "var(--text-xs, 0.875rem)",
                      fontWeight: 800,
                      ...(med.isScheduled
                        ? {
                            backgroundColor: "var(--verdict-match-bg, #06261d)",
                            color: "var(--verdict-match-fg, #7ef7c8)",
                            border: "1.5px solid var(--verdict-match-border, #2dd4a0)"
                          }
                        : {
                            backgroundColor: "var(--bg-surface, #121926)",
                            color: "var(--text-primary, #f8fafc)",
                            border: "1.5px dashed var(--border-strong, #6980a3)"
                          })
                    }}
                  >
                    {med.isScheduled ? copy.medScheduledTag : copy.medAsNeededTag}
                  </span>
                </div>

                <dl
                  className="emergency-med-dl"
                  style={{
                    margin: 0,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                    gap: "8px 16px"
                  }}
                >
                  <div>
                    <dt
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {copy.fieldIngredient}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: 700,
                        color: "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {med.ingredient}
                    </dd>
                  </div>

                  <div>
                    <dt
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {copy.fieldStrength}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: 700,
                        color: "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {med.strength}
                    </dd>
                  </div>

                  <div>
                    <dt
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {copy.fieldSchedule}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: 700,
                        color: "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {med.scheduleLabels.join(", ")}
                    </dd>
                  </div>

                  {med.notes ? (
                    <div>
                      <dt
                        style={{
                          fontSize: "var(--text-xs, 0.875rem)",
                          fontWeight: 700,
                          color: "var(--text-secondary, #d8e1ee)"
                        }}
                      >
                        {copy.fieldNotes}
                      </dt>
                      <dd
                        style={{
                          margin: 0,
                          fontSize: "var(--text-sm, 1rem)",
                          color: "var(--text-primary, #f8fafc)"
                        }}
                      >
                        {med.notes}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        role="group"
        aria-label={copy.actionsGroupAria}
        className="emergency-med-actions"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-3, 12px)"
        }}
      >
        <button
          type="button"
          className="btn btn-primary emergency-copy-btn"
          data-action="copy-wallet-text"
          aria-label={copy.copyBtnAria}
          onClick={() => void handleCopy()}
          style={ACTION_BUTTON_STYLE}
        >
          <WalletBadgeIcon kind="copy" />
          <span>{copy.copyBtnLabel}</span>
        </button>

        <button
          type="button"
          className="btn btn-secondary emergency-print-btn"
          data-action="print-wallet-card"
          aria-label={copy.printBtnAria}
          onClick={handlePrint}
          style={ACTION_BUTTON_STYLE}
        >
          <WalletBadgeIcon kind="print" />
          <span>{copy.printBtnLabel}</span>
        </button>
      </div>

      {feedback ? (
        <p
          aria-hidden="true"
          className="emergency-wallet-feedback"
          style={{
            margin: 0,
            fontSize: "var(--text-sm, 1rem)",
            fontWeight: 700,
            color: "var(--verdict-match-fg, #7ef7c8)"
          }}
        >
          {feedback}
        </p>
      ) : null}

      <details
        className="emergency-wallet-preview"
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
            minHeight: "56px",
            display: "flex",
            alignItems: "center"
          }}
        >
          {copy.previewSummaryLabel}
        </summary>
        <pre
          className="emergency-wallet-pre"
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
          {walletText}
        </pre>
      </details>

      <div
        role="note"
        className="emergency-privacy-notice"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "12px",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--verdict-info-bg, #0a1f38)",
          color: "var(--verdict-info-fg, #a6d4ff)",
          border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
        }}
      >
        <WalletBadgeIcon kind="shield" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <strong
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              lineHeight: 1.35
            }}
          >
            {copy.privacyHeading}
          </strong>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.45,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.privacyBody} {disclaimerText}
          </p>
        </div>
      </div>
    </section>
  );
}

export default EmergencyMedCard;
