import React, { type CSSProperties } from "react";
import { normalizeBarcode } from "../camera/barcode.ts";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { DeviceState, Profile } from "../types.ts";

void React;

export const TOTAL_PILOT_STEPS = 4;
export const GLASSES_MIN_BATTERY_PCT = 15;
export const MIN_OFFLINE_BARCODE_DIGITS = 8;

export type PilotStepId =
  | "consent_accepted"
  | "eye_ready"
  | "profile_configured"
  | "offline_barcodes_saved";

export type PilotReadinessInput = {
  consentAccepted: boolean;
  device: DeviceState;
  cameraPerm: string;
  profile: Profile;
};

export type PilotReadinessStep = {
  id: PilotStepId;
  done: boolean;
  detailCode: string;
};

export type PilotReadinessSummary = {
  readySteps: number;
  totalSteps: 4;
  allReady: boolean;
  steps: [PilotReadinessStep, PilotReadinessStep, PilotReadinessStep, PilotReadinessStep];
};

export type PilotOnboardingCardProps = {
  consentAccepted: boolean;
  device: DeviceState;
  cameraPerm: string;
  profile: Profile;
  lang: string;
  onOpenConsent?: () => void;
  onOpenPharmacyQr?: () => void;
  onStartDemoTour?: () => void;
};

type Tone = "ok" | "warn" | "info";

type ProfileInspection = {
  medCount: number;
  barcodeReadyCount: number;
  missingBarcodeCount: number;
  allergyCount: number;
  avoidCount: number;
  batteryPercent: number | null;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  statusAllReady: (ready: number, total: number) => string;
  statusInProgress: (ready: number, total: number) => string;
  statusZeroReady: (ready: number, total: number) => string;
  rolePill: string;
  progressHeading: string;
  progressAriaLabel: string;
  progressValueText: (ready: number, total: number, allReady: boolean) => string;
  progressSummary: (ready: number, total: number, pct: number) => string;
  checklistHeading: string;
  checklistAriaLabel: string;
  stepReadyBadge: string;
  stepPendingBadge: string;
  stepWindows: Record<PilotStepId, string>;
  stepTitles: Record<PilotStepId, string>;
  stepDetails: (
    step: PilotReadinessStep,
    stats: ProfileInspection
  ) => string;
  actionsGroupAria: string;
  openConsentLabel: string;
  openConsentAria: string;
  openPharmacyQrLabel: string;
  openPharmacyQrAria: string;
  startDemoTourLabel: string;
  startDemoTourAria: string;
  pilotBoundaryHeading: string;
  pilotBoundaryBody: string;
};

const TONE_BADGE_STYLES: Record<Tone, CSSProperties> = {
  ok: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "2px solid var(--verdict-match-border, #2dd4a0)"
  },
  warn: {
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "2px dashed var(--verdict-unsure-border, #f5b82e)"
  },
  info: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "1.5px solid var(--verdict-info-border, #4da3ff)"
  }
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
  flex: "1 1 210px"
};

function sanitizeInlineValue(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/[\u0000-\u001F\u007F\u2013\u2014]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countNonEmptyStrings(items: unknown): number {
  if (!Array.isArray(items)) {
    return 0;
  }
  let count = 0;
  for (const entry of items) {
    if (sanitizeInlineValue(entry).length > 0) {
      count += 1;
    }
  }
  return count;
}

function inspectProfileAndDevice(profile: Profile, device: DeviceState): ProfileInspection {
  const rawMeds = Array.isArray(profile?.meds) ? profile.meds : [];
  let medCount = 0;
  let barcodeReadyCount = 0;

  for (const med of rawMeds) {
    if (!med || typeof med !== "object") {
      continue;
    }
    const id = sanitizeInlineValue(med.id);
    const name = sanitizeInlineValue(med.name);
    const ingredient = sanitizeInlineValue(med.ingredient);
    if (!id && !name && !ingredient) {
      continue;
    }
    medCount += 1;
    const normalized = normalizeBarcode(med.barcode);
    if (normalized.length >= MIN_OFFLINE_BARCODE_DIGITS) {
      barcodeReadyCount += 1;
    }
  }

  const rawBattery = device?.battery;
  const hasFiniteBattery = typeof rawBattery === "number" && Number.isFinite(rawBattery);
  const batteryPercent = hasFiniteBattery
    ? Math.max(0, Math.min(100, Math.round(rawBattery)))
    : null;

  return {
    medCount,
    barcodeReadyCount,
    missingBarcodeCount: medCount - barcodeReadyCount,
    allergyCount: countNonEmptyStrings(profile?.allergies),
    avoidCount: countNonEmptyStrings(profile?.avoid),
    batteryPercent
  };
}

export function evaluatePilotReadiness(input: PilotReadinessInput): PilotReadinessSummary {
  const consentDone = Boolean(input?.consentAccepted);
  const consentStep: PilotReadinessStep = {
    id: "consent_accepted",
    done: consentDone,
    detailCode: consentDone ? "consent_accepted" : "consent_pending"
  };

  const device = input?.device;
  const connected = Boolean(device?.connected);
  const worn = Boolean(device?.worn);
  const streaming = Boolean(device?.streaming);
  const rawBattery = device?.battery;
  const hasFiniteBattery = typeof rawBattery === "number" && Number.isFinite(rawBattery);
  const lowBattery = hasFiniteBattery && rawBattery < GLASSES_MIN_BATTERY_PCT;
  const glassesReady = connected && worn && !lowBattery;

  const normalizedPerm =
    typeof input?.cameraPerm === "string" ? input.cameraPerm.trim().toLowerCase() : "";
  const phoneGranted = normalizedPerm === "granted";

  let eyeDone = false;
  let eyeDetailCode = "camera_permission_prompt";

  if (glassesReady) {
    eyeDone = true;
    eyeDetailCode = streaming ? "glasses_streaming" : "glasses_ready";
  } else if (phoneGranted) {
    eyeDone = true;
    if (connected && lowBattery) {
      eyeDetailCode = "phone_fallback_low_battery";
    } else if (connected && !worn) {
      eyeDetailCode = "phone_fallback_doffed";
    } else {
      eyeDetailCode = "phone_camera_ready";
    }
  } else if (connected && lowBattery) {
    eyeDone = false;
    eyeDetailCode = "glasses_low_battery";
  } else if (connected && !worn) {
    eyeDone = false;
    eyeDetailCode = "glasses_not_worn";
  } else if (normalizedPerm === "denied") {
    eyeDone = false;
    eyeDetailCode = "camera_permission_denied";
  } else if (normalizedPerm === "unavailable") {
    eyeDone = false;
    eyeDetailCode = "camera_unavailable";
  } else {
    eyeDone = false;
    eyeDetailCode = "camera_permission_prompt";
  }

  const eyeStep: PilotReadinessStep = {
    id: "eye_ready",
    done: eyeDone,
    detailCode: eyeDetailCode
  };

  const stats = inspectProfileAndDevice(input?.profile, device);

  let profileDone = false;
  let profileDetailCode = "profile_empty";
  if (stats.medCount > 0) {
    profileDone = true;
    profileDetailCode = "meds_configured";
  } else if (stats.allergyCount > 0 || stats.avoidCount > 0) {
    profileDone = true;
    profileDetailCode = "guardrails_only";
  }

  const profileStep: PilotReadinessStep = {
    id: "profile_configured",
    done: profileDone,
    detailCode: profileDetailCode
  };

  let barcodesDone = false;
  let barcodesDetailCode = "no_meds_saved";
  if (stats.medCount === 0) {
    barcodesDone = false;
    barcodesDetailCode = "no_meds_saved";
  } else if (stats.missingBarcodeCount === 0) {
    barcodesDone = true;
    barcodesDetailCode = "all_barcodes_saved";
  } else if (stats.barcodeReadyCount > 0) {
    barcodesDone = false;
    barcodesDetailCode = "barcodes_partial";
  } else {
    barcodesDone = false;
    barcodesDetailCode = "barcodes_missing";
  }

  const barcodesStep: PilotReadinessStep = {
    id: "offline_barcodes_saved",
    done: barcodesDone,
    detailCode: barcodesDetailCode
  };

  const steps: [PilotReadinessStep, PilotReadinessStep, PilotReadinessStep, PilotReadinessStep] = [
    consentStep,
    eyeStep,
    profileStep,
    barcodesStep
  ];

  let readySteps = 0;
  for (const step of steps) {
    if (step.done) {
      readySteps += 1;
    }
  }

  return {
    readySteps,
    totalSteps: TOTAL_PILOT_STEPS,
    allReady: readySteps === TOTAL_PILOT_STEPS,
    steps
  };
}

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Nakovammaisten liitto & Pharmacy Counter Pilot",
    heading: "3-Minute Community Pilot & Counter Onboarding",
    subtitle:
      "Live 4-step readiness checklist for peer assistive-tech instructors, community pharmacists, and family caregivers before starting daily shadow checks.",
    statusAllReady: (ready, total) => `${ready}/${total} Pilot Ready`,
    statusInProgress: (ready, total) => `${ready}/${total} Steps Ready`,
    statusZeroReady: (ready, total) => `${ready}/${total} Setup Pending`,
    rolePill: "180s Loaner & Counter Flow",
    progressHeading: "4-Step Onboarding Readiness Score",
    progressAriaLabel: "Pilot onboarding readiness progress",
    progressValueText: (ready, total, allReady) =>
      allReady
        ? `${ready} of ${total} onboarding steps complete, ready for active checks`
        : `${ready} of ${total} onboarding steps complete`,
    progressSummary: (ready, total, pct) =>
      `${ready} of ${total} steps verified (${pct}% ready)`,
    checklistHeading: "Timed 3-Minute Setup Sequence (00:00 to 03:00)",
    checklistAriaLabel: "Four-step community pilot onboarding checklist",
    stepReadyBadge: "READY",
    stepPendingBadge: "PENDING",
    stepWindows: {
      consent_accepted: "01 | 00:00 - 00:45",
      eye_ready: "02 | 00:45 - 01:30",
      profile_configured: "03 | 01:30 - 02:15",
      offline_barcodes_saved: "04 | 02:15 - 03:00"
    },
    stepTitles: {
      consent_accepted: "Accessible Consent & Bystander Capture LED Brief",
      eye_ready: "First-Person DAT Glasses or Phone Camera Eye",
      profile_configured: "On-Device Prescription & Allergy Regimen",
      offline_barcodes_saved: "Offline EAN/GTIN Pack Coverage & Safety Drill"
    },
    stepDetails: (step, stats) => {
      switch (step.detailCode) {
        case "consent_accepted":
          return "Consent accepted on this device; active-only capture (45s auto-stop) and bystander Capture LED commitment confirmed.";
        case "consent_pending":
          return "Walk through the 5 plain-language privacy commitments and accept on-device consent before opening camera or mic.";
        case "glasses_streaming":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 worn and streaming (${stats.batteryPercent}% battery) with front Capture LED active.`
            : "Ray-Ban Meta DAT 1.0.1 worn and streaming with front Capture LED active.";
        case "glasses_ready":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 connected and worn (${stats.batteryPercent}% battery); ready for hands-free HFP checks.`
            : "Ray-Ban Meta DAT 1.0.1 connected and worn; ready for hands-free HFP checks.";
        case "phone_fallback_low_battery":
          return stats.batteryPercent !== null
            ? `Glasses battery low (${stats.batteryPercent}% < 15%); phone camera backup granted and ready.`
            : "Glasses battery below 15%; phone camera backup granted and ready.";
        case "phone_fallback_doffed":
          return "Glasses connected but not worn; phone camera backup granted and ready until temples are unfolded.";
        case "phone_camera_ready":
          return "Phone camera permission granted as active eye; pair DAT 1.0.1 bridge anytime for hands-free glasses framing.";
        case "glasses_low_battery":
          return stats.batteryPercent !== null
            ? `Glasses battery is ${stats.batteryPercent}% (< 15% threshold); charge frames or grant phone camera permission.`
            : "Glasses battery is below 15%; charge frames or grant phone camera permission.";
        case "glasses_not_worn":
          return "Glasses are paired but doffed; put on the frames or grant phone camera permission.";
        case "camera_permission_denied":
          return "Browser camera permission denied and no DAT glasses worn; connect glasses or re-enable camera access.";
        case "camera_unavailable":
          return "Phone camera unavailable; connect Ray-Ban Meta DAT bridge or run Demo Prop Mode for training.";
        case "camera_permission_prompt":
          return "Pair and wear Ray-Ban Meta glasses via DAT 1.0.1 bridge, or grant phone camera permission.";
        case "meds_configured":
          return `${stats.medCount} ${stats.medCount === 1 ? "medication" : "medications"}, ${stats.allergyCount} ${stats.allergyCount === 1 ? "allergy" : "allergies"}, and ${stats.avoidCount} avoid ${stats.avoidCount === 1 ? "rule" : "rules"} stored strictly in localStorage (0 cloud rows).`;
        case "guardrails_only":
          return `${stats.allergyCount} ${stats.allergyCount === 1 ? "allergy" : "allergies"} and ${stats.avoidCount} avoid ${stats.avoidCount === 1 ? "rule" : "rules"} saved on device; import Pharmacy QR to add scheduled prescriptions.`;
        case "profile_empty":
          return "0 medications or allergies saved on device; scan a dispensing-counter Pharmacy QR sticker or add regimen items.";
        case "all_barcodes_saved":
          return `All ${stats.barcodeReadyCount}/${stats.medCount} saved prescriptions include verified EAN/GTIN barcodes for zero-network offline matching.`;
        case "barcodes_partial":
          return `${stats.barcodeReadyCount}/${stats.medCount} prescriptions have EAN/GTIN barcodes (${stats.missingBarcodeCount} missing); import Pharmacy QR for 100% offline coverage.`;
        case "barcodes_missing":
          return `0/${stats.medCount} saved prescriptions have an EAN/GTIN barcode (>= 8 digits); import Pharmacy QR so airplane-mode checks work.`;
        case "no_meds_saved":
        default:
          return "Save at least 1 prescription with an EAN/GTIN pack barcode via Pharmacy QR to unlock offline carton matching.";
      }
    },
    actionsGroupAria: "One-tap pilot onboarding actions",
    openConsentLabel: "Review Consent",
    openConsentAria: "Open accessible privacy and consent commitments",
    openPharmacyQrLabel: "Import Pharmacy QR",
    openPharmacyQrAria: "Open Pharmacy QR scanner to import prescriptions into device storage",
    startDemoTourLabel: "Run Safety Drill",
    startDemoTourAria: "Start guided safety drill and demo tour including occluded strength refusal",
    pilotBoundaryHeading: "Parallel Shadow-Check & 1-Tap Loaner Wipe",
    pilotBoundaryBody:
      "Pilot participants keep their primary dosetti or caregiver routine active and wipe all local data in 1 tap upon loaner return."
  },
  fi: {
    eyebrow: "Näkövammaisten liitto ja apteekkipilotti",
    heading: "3 minuutin pilotti- ja apteekkiperehdytys",
    subtitle:
      "Reaaliaikainen 4 vaiheen valmiuslista apuvälineneuvojille, apteekin farmaseuteille ja läheisille ennen päivittäistä rinnakkaistarkistusta.",
    statusAllReady: (ready, total) => `${ready}/${total} pilottivalmis`,
    statusInProgress: (ready, total) => `${ready}/${total} vaihetta valmiina`,
    statusZeroReady: (ready, total) => `${ready}/${total} odottaa aloitusta`,
    rolePill: "180 s lainalasi- ja apteekkipolku",
    progressHeading: "4 vaiheen käyttöönoton valmiuspisteet",
    progressAriaLabel: "Pilottikäyttöönoton valmiuden eteneminen",
    progressValueText: (ready, total, allReady) =>
      allReady
        ? `${ready}/${total} käyttöönottovaihetta valmiina, valmis tarkistuksiin`
        : `${ready}/${total} käyttöönottovaihetta valmiina`,
    progressSummary: (ready, total, pct) =>
      `${ready}/${total} vaihetta vahvistettu (${pct} % valmiina)`,
    checklistHeading: "Vaiheistettu 3 minuutin käyttöönotto (00:00 - 03:00)",
    checklistAriaLabel: "Neliportainen pilottikäyttöönoton tarkistuslista",
    stepReadyBadge: "VALMIS",
    stepPendingBadge: "ODOTTAA",
    stepWindows: {
      consent_accepted: "01 | 00:00 - 00:45",
      eye_ready: "02 | 00:45 - 01:30",
      profile_configured: "03 | 01:30 - 02:15",
      offline_barcodes_saved: "04 | 02:15 - 03:00"
    },
    stepTitles: {
      consent_accepted: "Saavutettava suostumus ja kuvaus-LED-opastus",
      eye_ready: "Ensimmäisen persoonan DAT-lasit tai puhelinkamera",
      profile_configured: "Laitteelle tallennettu lääke- ja allergialista",
      offline_barcodes_saved: "Offline-viivakoodikattavuus ja turvaharjoitus"
    },
    stepDetails: (step, stats) => {
      switch (step.detailCode) {
        case "consent_accepted":
          return "Suostumus tallennettu tälle laitteelle; pyynnöstä käynnistyvä kuvaus (45 s aikaraja) ja sivullisten kuvaus-LED vahvistettu.";
        case "consent_pending":
          return "Käy läpi 5 selkokielistä tietosuojalupausta ja hyväksy suostumus laitteella ennen kameran tai mikrofonin avaamista.";
        case "glasses_streaming":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 päässä ja lähettää kuvaa (akku ${stats.batteryPercent} %), etupuolen kuvaus-LED päällä.`
            : "Ray-Ban Meta DAT 1.0.1 päässä ja lähettää kuvaa, etupuolen kuvaus-LED päällä.";
        case "glasses_ready":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 yhdistetty ja päässä (akku ${stats.batteryPercent} %); valmis kädet vapaana HFP-tarkistukseen.`
            : "Ray-Ban Meta DAT 1.0.1 yhdistetty ja päässä; valmis kädet vapaana HFP-tarkistukseen.";
        case "phone_fallback_low_battery":
          return stats.batteryPercent !== null
            ? `Lasien akku matala (${stats.batteryPercent} % < 15 %); puhelinkameran varasilmä sallittu ja valmiina.`
            : "Lasien akku alle 15 %; puhelinkameran varasilmä sallittu ja valmiina.";
        case "phone_fallback_doffed":
          return "Lasit yhdistetty mutta eivät päässä; puhelinkamera on valmiina varalla kunnes sangat avataan.";
        case "phone_camera_ready":
          return "Puhelinkameran lupa myönnetty; yhdistä DAT 1.0.1 -silta milloin tahansa kädet vapaana -lasikuvausta varten.";
        case "glasses_low_battery":
          return stats.batteryPercent !== null
            ? `Lasien akku on ${stats.batteryPercent} % (< 15 % raja); lataa kehykset tai salli puhelinkamera.`
            : "Lasien akku on alle 15 %; lataa kehykset tai salli puhelinkamera.";
        case "glasses_not_worn":
          return "Lasit on yhdistetty mutta eivät päässä; aseta lasit päähän tai salli puhelinkamera.";
        case "camera_permission_denied":
          return "Selaimen kameralupa on estetty eikä DAT-laseja ole päässä; yhdistä lasit tai salli kamera selaimen asetuksista.";
        case "camera_unavailable":
          return "Puhelinkamera ei ole käytettävissä; yhdistä Ray-Ban Meta DAT -silta tai käytä harjoitustilaa.";
        case "camera_permission_prompt":
          return "Yhdistä ja pue Ray-Ban Meta -lasit DAT 1.0.1 -sillalla tai myönnä puhelinkameran käyttölupa.";
        case "meds_configured":
          return `${stats.medCount} lääkettä, ${stats.allergyCount} allergiaa ja ${stats.avoidCount} välttösääntöä tallennettu vain laitteen localStorage-muistiin (0 pilviriviä).`;
        case "guardrails_only":
          return `${stats.allergyCount} allergiaa ja ${stats.avoidCount} välttösääntöä tallennettu; tuo apteekin QR-tarra lisätäksesi reseptilääkkeet.`;
        case "profile_empty":
          return "0 lääkettä tai allergiaa tallennettu laitteelle; lue apteekin QR-tarra tai lisää omat tiedot.";
        case "all_barcodes_saved":
          return `Kaikilla ${stats.barcodeReadyCount}/${stats.medCount} tallennetulla reseptilääkkeellä on EAN/GTIN-viivakoodi verkottomaan tarkistukseen.`;
        case "barcodes_partial":
          return `${stats.barcodeReadyCount}/${stats.medCount} lääkkeellä on EAN/GTIN-viivakoodi (${stats.missingBarcodeCount} puuttuu); tuo apteekin QR täyttä offline-tukea varten.`;
        case "barcodes_missing":
          return `0/${stats.medCount} tallennetulla lääkkeellä on EAN/GTIN-viivakoodi (>= 8 numeroa); tuo apteekin QR lentotilatarkistusta varten.`;
        case "no_meds_saved":
        default:
          return "Tallenna vähintään 1 reseptilääke ja EAN/GTIN-viivakoodi apteekin QR-tarralla offline-tunnistusta varten.";
      }
    },
    actionsGroupAria: "Pilottikäyttöönoton pikatoiminnot",
    openConsentLabel: "Tarkista suostumus",
    openConsentAria: "Avaa saavutettava tietosuoja- ja suostumusnäkymä",
    openPharmacyQrLabel: "Tuo apteekin QR",
    openPharmacyQrAria: "Avaa apteekin QR-lukija reseptilääkkeiden tuomiseksi laitteen muistiin",
    startDemoTourLabel: "Aja turvaharjoitus",
    startDemoTourAria: "Käynnistä ohjattu turvaharjoitus ja esittelykierros peitetyn vahvuuden estolla",
    pilotBoundaryHeading: "Rinnakkaistarkistus ja lainalasien pikatyhjennys",
    pilotBoundaryBody:
      "Pilottiosallistujat jatkavat ensisijaista dosetti- tai läheistarkistusta, ja paikalliset tiedot tyhjennetään yhdellä painalluksella palautuksessa."
  },
  sv: {
    eyebrow: "Synskadades förbund och apotekspilot",
    heading: "3-minuters pilot- och apoteksintroduktion",
    subtitle:
      "Direkt checklista i 4 steg för syninstruktörer, apotekspersonal och närstående före dagliga parallella kontroller.",
    statusAllReady: (ready, total) => `${ready}/${total} pilotredo`,
    statusInProgress: (ready, total) => `${ready}/${total} steg klara`,
    statusZeroReady: (ready, total) => `${ready}/${total} väntar på start`,
    rolePill: "180 s låne- och apoteksflöde",
    progressHeading: "Beredskapspoäng i 4 steg",
    progressAriaLabel: "Framsteg för pilotintroduktion",
    progressValueText: (ready, total, allReady) =>
      allReady
        ? `${ready} av ${total} introduktionssteg klara, redo för aktiva kontroller`
        : `${ready} av ${total} introduktionssteg klara`,
    progressSummary: (ready, total, pct) =>
      `${ready} av ${total} steg verifierade (${pct} % redo)`,
    checklistHeading: "Tidsatt 3-minuterssekvens (00:00 till 03:00)",
    checklistAriaLabel: "Checklista i fyra steg för pilotintroduktion",
    stepReadyBadge: "KLAR",
    stepPendingBadge: "VÄNTAR",
    stepWindows: {
      consent_accepted: "01 | 00:00 - 00:45",
      eye_ready: "02 | 00:45 - 01:30",
      profile_configured: "03 | 01:30 - 02:15",
      offline_barcodes_saved: "04 | 02:15 - 03:00"
    },
    stepTitles: {
      consent_accepted: "Tillgängligt samtycke och genomgång av inspelnings-LED",
      eye_ready: "Förstapersons DAT-glasögon eller mobilkamera",
      profile_configured: "Lokal läkemedels- och allergiprofil på enheten",
      offline_barcodes_saved: "Offline EAN/GTIN-täckning och säkerhetsövning"
    },
    stepDetails: (step, stats) => {
      switch (step.detailCode) {
        case "consent_accepted":
          return "Samtycke sparat på enheten; aktiv kontroll på begäran (45 s autostopp) och främre inspelnings-LED bekräftade.";
        case "consent_pending":
          return "Gå igenom de 5 tydliga integritetslöftena och godkänn samtycke på enheten innan kamera eller mikrofon öppnas.";
        case "glasses_streaming":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 bärs och strömmar (${stats.batteryPercent} % batteri) med främre inspelnings-LED aktiv.`
            : "Ray-Ban Meta DAT 1.0.1 bärs och strömmar med främre inspelnings-LED aktiv.";
        case "glasses_ready":
          return stats.batteryPercent !== null
            ? `Ray-Ban Meta DAT 1.0.1 ansluten och bärs (${stats.batteryPercent} % batteri); redo för handsfree HFP-kontroll.`
            : "Ray-Ban Meta DAT 1.0.1 ansluten och bärs; redo för handsfree HFP-kontroll.";
        case "phone_fallback_low_battery":
          return stats.batteryPercent !== null
            ? `Glasögonbatteri lågt (${stats.batteryPercent} % < 15 %); mobilkamerans reservläge godkänt och redo.`
            : "Glasögonbatteri under 15 %; mobilkamerans reservläge godkänt och redo.";
        case "phone_fallback_doffed":
          return "Glasögonen är anslutna men avtagna; mobilkameran är godkänd och redo tills bågarna fälls upp.";
        case "phone_camera_ready":
          return "Mobilkamerans behörighet beviljad; parkoppla DAT 1.0.1-bryggan när som helst för handsfree-glasögonvy.";
        case "glasses_low_battery":
          return stats.batteryPercent !== null
            ? `Glasögonbatteriet är ${stats.batteryPercent} % (< 15 % gräns); ladda bågarna eller tillåt mobilkameran.`
            : "Glasögonbatteriet är under 15 %; ladda bågarna eller tillåt mobilkameran.";
        case "glasses_not_worn":
          return "Glasögonen är parkopplade men bärs inte; ta på bågarna eller tillåt mobilkameran.";
        case "camera_permission_denied":
          return "Kamerabehörighet nekad i webbläsaren och inga DAT-glasögon bärs; anslut glasögon eller aktivera kameran.";
        case "camera_unavailable":
          return "Mobilkamera ej tillgänglig; anslut Ray-Ban Meta DAT-bryggan eller kör demoläge för träning.";
        case "camera_permission_prompt":
          return "Parkoppla och bär Ray-Ban Meta-glasögon via DAT 1.0.1-bryggan eller godkänn mobilkameran.";
        case "meds_configured":
          return `${stats.medCount} läkemedel, ${stats.allergyCount} allergier och ${stats.avoidCount} undvik-regler sparade lokalt i localStorage (0 molnrader).`;
        case "guardrails_only":
          return `${stats.allergyCount} allergier och ${stats.avoidCount} undvik-regler sparade på enheten; importera apoteks-QR för recept.`;
        case "profile_empty":
          return "0 läkemedel eller allergier sparade på enheten; skanna en apoteks-QR vid disken eller lägg till profil.";
        case "all_barcodes_saved":
          return `Alla ${stats.barcodeReadyCount}/${stats.medCount} sparade recept har verifierade EAN/GTIN-streckkoder för nätverksfri matchning.`;
        case "barcodes_partial":
          return `${stats.barcodeReadyCount}/${stats.medCount} recept har EAN/GTIN-streckkod (${stats.missingBarcodeCount} saknas); importera apoteks-QR för full offline-täckning.`;
        case "barcodes_missing":
          return `0/${stats.medCount} sparade recept har EAN/GTIN-streckkod (>= 8 siffror); importera apoteks-QR för flygplansläge.`;
        case "no_meds_saved":
        default:
          return "Spara minst 1 recept med EAN/GTIN-streckkod via apoteks-QR för att aktivera offline-matchning.";
      }
    },
    actionsGroupAria: "Snabbåtgärder för pilotintroduktion",
    openConsentLabel: "Granska samtycke",
    openConsentAria: "Öppna tillgänglig vy för integritet och samtycke",
    openPharmacyQrLabel: "Importera apoteks-QR",
    openPharmacyQrAria: "Öppna apoteks-QR-skanner för att spara recept lokalt på enheten",
    startDemoTourLabel: "Kör säkerhetsövning",
    startDemoTourAria: "Starta guidad säkerhetsövning och demotur med avvisning vid skymd styrka",
    pilotBoundaryHeading: "Parallell kontroll och radering med ett tryck",
    pilotBoundaryBody:
      "Pilotdeltagare behåller sin ordinarie dosett- eller anhörigkontroll och raderar all lokal data med ett tryck vid återlämning."
  }
};

function StepGlyph({
  kind
}: {
  kind: "done" | "pending" | "consent" | "qr" | "tour" | "shield";
}) {
  const iconStyle: CSSProperties = { width: "18px", height: "18px", flexShrink: 0 };

  if (kind === "done") {
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
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8.4 12.3l2.4 2.4 4.9-5.1" />
      </svg>
    );
  }

  if (kind === "pending") {
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
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" strokeDasharray="3.5 2.5" />
        <path d="M12 7.5v5l3 1.8" />
      </svg>
    );
  }

  if (kind === "consent") {
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
        style={iconStyle}
      >
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 9h6" />
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </svg>
    );
  }

  if (kind === "qr") {
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
        style={iconStyle}
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 14h3v3h-3z" />
        <path d="M18 18h3v3h-3z" />
      </svg>
    );
  }

  if (kind === "tour") {
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
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <polygon points="10,8.5 16.5,12 10,15.5" fill="currentColor" stroke="none" />
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
      style={iconStyle}
    >
      <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
      <path d="M8.5 12.3l2.4 2.4 4.8-5" />
    </svg>
  );
}

export function PilotOnboardingCard(props: PilotOnboardingCardProps) {
  const {
    consentAccepted,
    device,
    cameraPerm,
    profile,
    lang,
    onOpenConsent,
    onOpenPharmacyQr,
    onStartDemoTour
  } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const disclaimerText = t(locale, "notMedicalDevice");

  const readiness = evaluatePilotReadiness({
    consentAccepted,
    device,
    cameraPerm,
    profile
  });
  const stats = inspectProfileAndDevice(profile, device);

  const readinessPct = Math.round((readiness.readySteps / readiness.totalSteps) * 100);
  const summaryTone: Tone = readiness.allReady
    ? "ok"
    : readiness.readySteps === 0
      ? "info"
      : "warn";

  const statusBadgeText = readiness.allReady
    ? copy.statusAllReady(readiness.readySteps, readiness.totalSteps)
    : readiness.readySteps === 0
      ? copy.statusZeroReady(readiness.readySteps, readiness.totalSteps)
      : copy.statusInProgress(readiness.readySteps, readiness.totalSteps);

  const progressFillColor =
    summaryTone === "ok"
      ? "var(--verdict-match-border, #2dd4a0)"
      : summaryTone === "warn"
        ? "var(--verdict-unsure-border, #f5b82e)"
        : "var(--verdict-info-border, #4da3ff)";

  const hasConsentBtn = typeof onOpenConsent === "function";
  const hasPharmacyQrBtn = typeof onOpenPharmacyQr === "function";
  const hasDemoTourBtn = typeof onStartDemoTour === "function";
  const hasActions = hasConsentBtn || hasPharmacyQrBtn || hasDemoTourBtn;

  const headingId = "pilot-onboarding-card-heading";
  const checklistHeadingId = "pilot-onboarding-checklist-heading";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card pilot-onboarding-card"
      data-ready-steps={String(readiness.readySteps)}
      data-total-steps={String(readiness.totalSteps)}
      data-all-ready={readiness.allReady ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: readiness.allReady
          ? "2px solid var(--verdict-match-border, #2dd4a0)"
          : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
      }}
    >
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
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.28,
              fontWeight: 800,
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

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            role="status"
            aria-live="polite"
            className="badge pilot-readiness-summary-badge"
            data-pilot-status-badge="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              ...TONE_BADGE_STYLES[summaryTone]
            }}
          >
            <StepGlyph kind={readiness.allReady ? "done" : "pending"} />
            <span>{statusBadgeText}</span>
          </span>

          <span
            className="pill pilot-flow-duration-pill"
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
            {copy.rolePill}
          </span>
        </div>
      </header>

      <div
        className="pilot-readiness-meter-box"
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
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px"
          }}
        >
          <span
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.progressHeading}
          </span>

          <span
            className="pilot-readiness-score-label"
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {readiness.readySteps}/{readiness.totalSteps} ({readinessPct}%)
          </span>
        </div>

        <div
          role="progressbar"
          aria-label={copy.progressAriaLabel}
          aria-valuemin={0}
          aria-valuemax={readiness.totalSteps}
          aria-valuenow={readiness.readySteps}
          aria-valuetext={copy.progressValueText(
            readiness.readySteps,
            readiness.totalSteps,
            readiness.allReady
          )}
          data-pilot-progressbar="true"
          className="pilot-onboarding-progressbar"
          style={{
            position: "relative",
            width: "100%",
            height: "14px",
            backgroundColor: "var(--bg-app, #0b0f17)",
            border: "1.5px solid var(--border-strong, #6980a3)",
            borderRadius: "var(--radius-pill, 9999px)",
            overflow: "hidden"
          }}
        >
          <div
            aria-hidden="true"
            className="pilot-onboarding-progressbar-fill"
            style={{
              width: `${readinessPct}%`,
              minWidth: readinessPct > 0 ? "4px" : "0px",
              height: "100%",
              backgroundColor: progressFillColor
            }}
          />
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs, 0.875rem)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--text-secondary, #d8e1ee)"
          }}
        >
          {copy.progressSummary(readiness.readySteps, readiness.totalSteps, readinessPct)}
        </p>
      </div>

      <div
        role="group"
        aria-labelledby={checklistHeadingId}
        className="pilot-checklist-section"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)"
        }}
      >
        <h3
          id={checklistHeadingId}
          style={{
            margin: 0,
            fontSize: "var(--text-base, 1.125rem)",
            fontWeight: 800,
            lineHeight: 1.3,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.checklistHeading}
        </h3>

        <ol
          aria-label={copy.checklistAriaLabel}
          className="pilot-onboarding-step-list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "var(--space-3, 12px)"
          }}
        >
          {readiness.steps.map((step) => {
            const rowTone: Tone = step.done ? "ok" : "warn";
            return (
              <li
                key={step.id}
                data-step-id={step.id}
                data-step-done={step.done ? "true" : "false"}
                data-detail-code={step.detailCode}
                className={`pilot-onboarding-step-row ${
                  step.done ? "is-step-ready" : "is-step-pending"
                }`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "var(--space-4, 16px)",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  border: step.done
                    ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                    : "2px dashed var(--verdict-unsure-border, #f5b82e)"
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
                  <span
                    style={{
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "var(--text-xs, 0.875rem)",
                      fontWeight: 800,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--accent, #5cc0ff)"
                    }}
                  >
                    {copy.stepWindows[step.id]}
                  </span>

                  <span
                    className="badge pilot-step-status-badge"
                    data-step-badge={step.done ? "ready" : "pending"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "4px 10px",
                      borderRadius: "var(--radius-pill, 9999px)",
                      fontSize: "0.78rem",
                      fontWeight: 800,
                      letterSpacing: "0.03em",
                      ...TONE_BADGE_STYLES[rowTone]
                    }}
                  >
                    <StepGlyph kind={step.done ? "done" : "pending"} />
                    <span>{step.done ? copy.stepReadyBadge : copy.stepPendingBadge}</span>
                  </span>
                </div>

                <strong
                  className="pilot-step-title"
                  style={{
                    fontSize: "var(--text-base, 1.125rem)",
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {copy.stepTitles[step.id]}
                </strong>

                <p
                  className="pilot-step-detail"
                  style={{
                    margin: 0,
                    fontSize: "var(--text-xs, 0.875rem)",
                    lineHeight: 1.45,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {copy.stepDetails(step, stats)}
                </p>
              </li>
            );
          })}
        </ol>
      </div>

      {hasActions ? (
        <div
          role="group"
          aria-label={copy.actionsGroupAria}
          className="pilot-onboarding-actions"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "var(--space-3, 12px)"
          }}
        >
          {hasConsentBtn ? (
            <button
              type="button"
              className="btn btn-secondary pilot-open-consent-btn"
              data-action="open-consent"
              aria-label={copy.openConsentAria}
              onClick={onOpenConsent}
              style={ACTION_BUTTON_STYLE}
            >
              <StepGlyph kind="consent" />
              <span>{copy.openConsentLabel}</span>
            </button>
          ) : null}

          {hasPharmacyQrBtn ? (
            <button
              type="button"
              className="btn btn-secondary pilot-open-pharmacy-qr-btn"
              data-action="open-pharmacy-qr"
              aria-label={copy.openPharmacyQrAria}
              onClick={onOpenPharmacyQr}
              style={ACTION_BUTTON_STYLE}
            >
              <StepGlyph kind="qr" />
              <span>{copy.openPharmacyQrLabel}</span>
            </button>
          ) : null}

          {hasDemoTourBtn ? (
            <button
              type="button"
              className="btn btn-primary pilot-start-demo-tour-btn"
              data-action="start-demo-tour"
              aria-label={copy.startDemoTourAria}
              onClick={onStartDemoTour}
              style={ACTION_BUTTON_STYLE}
            >
              <StepGlyph kind="tour" />
              <span>{copy.startDemoTourLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        role="note"
        className="pilot-safety-boundary-note"
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
        <StepGlyph kind="shield" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <strong
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              lineHeight: 1.35
            }}
          >
            {copy.pilotBoundaryHeading}
          </strong>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.45,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.pilotBoundaryBody} {disclaimerText}
          </p>
        </div>
      </div>
    </section>
  );
}

export default PilotOnboardingCard;
