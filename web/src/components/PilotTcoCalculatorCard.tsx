import React, { useId, useState, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";

void React;

export const RAYBAN_META_GEN2_HARDWARE_EUR = 329.0;
export const ORCAM_MYEYE_MIDPOINT_EUR = 4150.0;
export const AIRA_DAILY_PLAN_THREE_YEAR_EUR = 2340.0;
export const BASELINE_THREE_YEAR_CHECKS = 4320;
export const NORMAL_12S_VIDEO_KB = 724.64;
export const ADAPTIVE_12S_VIDEO_KB = 116.02;
export const ADAPTIVE_VIDEO_SAVINGS_PCT = 84.0;

export const COHORT_PRESETS = [1, 24, 100, 500] as const;
export type PilotCohortPreset = (typeof COHORT_PRESETS)[number];

export type PilotPricingTier =
  | "standard_cached"
  | "economy_2_0_live"
  | "uncached_native_audio_ceiling";

export const PRICING_TIERS: readonly PilotPricingTier[] = [
  "standard_cached",
  "economy_2_0_live",
  "uncached_native_audio_ceiling"
];

const TIER_THREE_YEAR_CLOUD_AT_BASELINE_EUR: Record<PilotPricingTier, number> = {
  standard_cached: 12.68,
  economy_2_0_live: 7.44,
  uncached_native_audio_ceiling: 32.36
};

const TIER_ADAPTIVE_THREE_YEAR_CLOUD_AT_BASELINE_EUR: Record<PilotPricingTier, number> = {
  standard_cached: 10.8,
  economy_2_0_live: 6.48,
  uncached_native_audio_ceiling: 26.28
};

const TIER_PER_CHECK_NORMAL_EUR: Record<PilotPricingTier, number> = {
  standard_cached: 0.00294,
  economy_2_0_live: 0.00172,
  uncached_native_audio_ceiling: 0.00749
};

const TIER_PER_CHECK_ADAPTIVE_EUR: Record<PilotPricingTier, number> = {
  standard_cached: 0.00251,
  economy_2_0_live: 0.00151,
  uncached_native_audio_ceiling: 0.00607
};

export type PilotTcoInput = {
  cohortSize: number;
  checksPerDay: number;
  localBarcodeSharePct: number;
  tier: PilotPricingTier;
  adaptiveSlowWifi: boolean;
};

export type PilotTcoReport = {
  cohortSize: number;
  checksPerDay: number;
  localBarcodeSharePct: number;
  tier: PilotPricingTier;
  adaptiveSlowWifi: boolean;
  totalChecksThreeYearsPerUser: number;
  cloudChecksThreeYearsPerUser: number;
  offlineBarcodeChecksThreeYearsPerUser: number;
  perCheckCloudEur: number;
  perUserHardwareEur: number;
  perUserThreeYearCloudEur: number;
  perUserAnnualCloudEur: number;
  perUserThreeYearHoldUpEur: number;
  perUserThreeYearOrcamEur: number;
  perUserThreeYearAiraEur: number;
  cohortThreeYearHoldUpEur: number;
  cohortThreeYearOrcamEur: number;
  cohortThreeYearAiraEur: number;
  cohortSavingsVsOrcamEur: number;
  cohortSavingsVsAiraEur: number;
  savingsVsOrcamPct: number;
  savingsVsAiraPct: number;
  costReductionMultipleVsOrcam: number;
  usersServedOnOrcamBudget: number;
  videoKbPerCheck: number;
  videoBandwidthSavedPct: number;
};

export type PilotTcoCalculatorCardProps = {
  lang: string;
  initialCohortSize?: number;
  initialChecksPerDay?: number;
  initialLocalBarcodeSharePct?: number;
  initialTier?: PilotPricingTier;
  initialAdaptiveSlowWifi?: boolean;
  onCopySummary?: (summaryText: string) => void;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  statusBadge: (savingsPct: number, multiple: number) => string;
  cohortGroupLabel: string;
  cohortButtonLabel: (n: number) => string;
  tierGroupLabel: string;
  tierLabels: Record<PilotPricingTier, string>;
  barcodeToggleLabel: (active: boolean) => string;
  adaptiveToggleLabel: (active: boolean) => string;
  tableCaption: string;
  colMetric: string;
  colHoldUp: string;
  colOrcam: string;
  colAdvantage: string;
  rowPerUser3Yr: string;
  rowCohort3Yr: (n: number) => string;
  rowAnnualCloud: string;
  rowReachOnBudget: (n: number) => string;
  advantageSavings: (eur: string, pct: number) => string;
  advantageCloud: (perCheckEur: string, barcodePct: number) => string;
  advantageReach: (served: number, multiple: number) => string;
  airaNote: (airaCohortEur: string, airaPct: number, videoKb: string) => string;
  regulatoryHeading: string;
  regulatoryBody: string;
  copyButtonLabel: string;
  copiedButtonLabel: string;
  copyStatusCopied: string;
  dossierTitle: string;
  dossierCohortLine: (n: number, checksPerDay: number, barcodePct: number) => string;
  dossierTcoLine: (perUserEur: string, cohortEur: string, orcamCohortEur: string) => string;
  dossierSavingsLine: (savedEur: string, pct: number, mult: number, served: number, n: number) => string;
  dossierPathwayLine: string;
};

const COPY: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Public Rehabilitation & Pilot Economics",
    heading: "3-Year Assistive TCO & Municipal Procurement Calculator",
    subtitle:
      "Deterministic 3-year cost model from eval/unit_economics.json comparing consumer Ray-Ban Meta Gen 2 + HoldUp against dedicated EUR 4,150 OCR cameras and paid visual-interpreter plans.",
    statusBadge: (pct, mult) => `${pct.toFixed(1)}% 3-yr savings (${mult.toFixed(1)}x reach)`,
    cohortGroupLabel: "Select pilot or public procurement cohort size",
    cohortButtonLabel: (n) =>
      n === 1
        ? "1 User"
        : n === 24
          ? "24 Users (Iiris Pilot)"
          : n === 100
            ? "100 Users (HUS Clinic)"
            : `${n} Users (County)`,
    tierGroupLabel: "Select Gemini API billing tier",
    tierLabels: {
      standard_cached: "Standard Cached (EUR 0.00294/check)",
      economy_2_0_live: "Economy Tier (EUR 0.00172/check)",
      uncached_native_audio_ceiling: "Uncached Ceiling (EUR 0.00749/check)"
    },
    barcodeToggleLabel: (active) =>
      active
        ? "30% Offline holdup://rx Barcode Scans: ON"
        : "30% Offline holdup://rx Barcode Scans: OFF",
    adaptiveToggleLabel: (active) =>
      active
        ? "Slow Wi-Fi Adaptive 0.5 fps (-84.0% video): ON"
        : "Slow Wi-Fi Adaptive 0.5 fps (-84.0% video): OFF",
    tableCaption: "Three-year total cost of ownership comparison in euros",
    colMetric: "Cost / Reach Metric",
    colHoldUp: "HoldUp + Ray-Ban Meta",
    colOrcam: "OrCam MyEye Midpoint",
    colAdvantage: "Public Budget Impact",
    rowPerUser3Yr: "3-Year TCO per User",
    rowCohort3Yr: (n) => `3-Year Cohort Total (N = ${n})`,
    rowAnnualCloud: "Annual Gemini Cloud per User",
    rowReachOnBudget: (n) => `Residents Served on ${n}-Unit Legacy Budget`,
    advantageSavings: (eur, pct) => `Saves EUR ${eur} (-${pct.toFixed(1)}%)`,
    advantageCloud: (perCheck, barcodePct) =>
      barcodePct > 0
        ? `EUR ${perCheck}/check (${barcodePct}% at 0 KB offline)`
        : `EUR ${perCheck}/check (EUR 329 hardware)`,
    advantageReach: (served, mult) => `${served} residents (${mult.toFixed(1)}x reach)`,
    airaNote: (airaEur, airaPct, videoKb) =>
      `Paid daily interpreter comparison (Aira EUR 65/mo): EUR ${airaEur} over 3 years (${airaPct.toFixed(1)}% higher than HoldUp). Video payload per 12s check: ${videoKb} KB.`,
    regulatoryHeading: "Finnish Reimbursement & Non-Medical Boundary",
    regulatoryBody:
      "Operates inside the EU MDR Art. 2(1) assistive label-reader boundary with zero server health records, aligning with City of Helsinki / HUS Apuvalinekeskus (Health Care Act 1326/2010 sec. 29), Kela rehabilitation (Act 566/2005), and zero-cloud holdup://rx pharmacy counter QR onboarding.",
    copyButtonLabel: "Copy Procurement Dossier Summary",
    copiedButtonLabel: "Procurement Summary Copied",
    copyStatusCopied: "Copied plain-text procurement TCO summary to clipboard.",
    dossierTitle: "HoldUp 3-Year Assistive TCO & Pilot Procurement Summary",
    dossierCohortLine: (n, cpd, bp) =>
      `Cohort: N = ${n} users | ${cpd} checks/day (4,320 checks/3 yr baseline) | Offline EAN-13 share: ${bp}%`,
    dossierTcoLine: (perUser, cohort, orcam) =>
      `3-Year TCO: EUR ${perUser}/user (Cohort EUR ${cohort} vs OrCam midpoint EUR ${orcam})`,
    dossierSavingsLine: (saved, pct, mult, served, n) =>
      `Public Budget Impact: Saves EUR ${saved} (${pct.toFixed(1)}% reduction, ${mult.toFixed(1)}x cost efficiency; serves ${served} residents on a ${n}-unit legacy budget)`,
    dossierPathwayLine:
      "Pathway: Nakovammaisten liitto (Iiris Center) loaner pilot + Yliopiston Apteekki holdup://rx zero-PII QR + HUS Apuvalinekeskus / Kela assistive reading aid"
  },
  fi: {
    eyebrow: "Julkisen kuntoutuksen ja pilotin kustannusmalli",
    heading: "3 vuoden apuvalineen kokonaiskustannuslaskuri (HUS ja Kela)",
    subtitle:
      "Deterministinen 3 vuoden TCO-laskelma (eval/unit_economics.json): kuluttajahintaiset Ray-Ban Meta Gen 2 -lasit + HoldUp verrattuna 4 150 EUR erikoislukulaitteeseen ja maksulliseen etatulkkaukseen.",
    statusBadge: (pct, mult) => `${pct.toFixed(1)} % saasto (${mult.toFixed(1)}x kattavuus)`,
    cohortGroupLabel: "Valitse pilotin tai apuvalinehankinnan kohorttikoko",
    cohortButtonLabel: (n) =>
      n === 1
        ? "1 kayttaja"
        : n === 24
          ? "24 kayttajaa (Iiris-pilotti)"
          : n === 100
            ? "100 kayttajaa (HUS-klinikka)"
            : `${n} kayttajaa (Hyvinvointialue)`,
    tierGroupLabel: "Valitse Gemini-rajapinnan hinnoittelutaso",
    tierLabels: {
      standard_cached: "Oletus valimuistilla (EUR 0.00294/tarkistus)",
      economy_2_0_live: "Edullinen taso (EUR 0.00172/tarkistus)",
      uncached_native_audio_ceiling: "Kattitaso ilman valimuistia (EUR 0.00749/tarkistus)"
    },
    barcodeToggleLabel: (active) =>
      active
        ? "30 % offline holdup://rx EAN-viivakoodit: PAALLA"
        : "30 % offline holdup://rx EAN-viivakoodit: POIS",
    adaptiveToggleLabel: (active) =>
      active
        ? "Hidas Wi-Fi 0.5 fps (-84.0 % video): PAALLA"
        : "Hidas Wi-Fi 0.5 fps (-84.0 % video): POIS",
    tableCaption: "Kolmen vuoden kokonaiskustannusvertailu euroina",
    colMetric: "Kustannus- ja vaikuttavuusmittari",
    colHoldUp: "HoldUp + Ray-Ban Meta",
    colOrcam: "OrCam MyEye keskihinta",
    colAdvantage: "Julkisen budjetin vaikutus",
    rowPerUser3Yr: "3 v kokonaiskustannus / kayttaja",
    rowCohort3Yr: (n) => `3 v kohortti yhteensa (N = ${n})`,
    rowAnnualCloud: "Vuosittainen pilvikulu / kayttaja",
    rowReachOnBudget: (n) => `Palvellut kuntoutujat ${n} perinteisen laitteen budjetilla`,
    advantageSavings: (eur, pct) => `Saastaa EUR ${eur} (-${pct.toFixed(1)} %)`,
    advantageCloud: (perCheck, barcodePct) =>
      barcodePct > 0
        ? `EUR ${perCheck}/tarkistus (${barcodePct} % offline 0 KB)`
        : `EUR ${perCheck}/tarkistus (EUR 329 lasit)`,
    advantageReach: (served, mult) => `${served} kuntoutujaa (${mult.toFixed(1)}x kattavuus)`,
    airaNote: (airaEur, airaPct, videoKb) =>
      `Maksullinen etakuvatulkkaus (Aira EUR 65/kk): EUR ${airaEur} / 3 v (${airaPct.toFixed(1)} % kalliimpi kuin HoldUp). Videodata / 12 s tarkistus: ${videoKb} KB.`,
    regulatoryHeading: "Suomen korvattavuuspolku ja EU MDR -raja",
    regulatoryBody:
      "Toimii EU MDR Art. 2(1) mukaisena ei-laakinnallisena lukemisapuvalineena ilman palvelimelle tallennettavia potilastietoja. Sopii HUS Apuvalinekeskuksen luovutusperusteisiin (Terveydenhuoltolaki 1326/2010 pykala 29), Kelan ammatilliseen kuntoutukseen (566/2005) ja apteekkien holdup://rx QR-tarraan.",
    copyButtonLabel: "Kopioi hankintayhteenveto",
    copiedButtonLabel: "Hankintayhteenveto kopioitu",
    copyStatusCopied: "Hankinta- ja TCO-yhteenveto kopioitu leikepoydalle.",
    dossierTitle: "HoldUp 3 vuoden TCO- ja apuvalinehankintayhteenveto",
    dossierCohortLine: (n, cpd, bp) =>
      `Kohortti: N = ${n} kayttajaa | ${cpd} tarkistusta/vrk | Paikallinen EAN-13-osuus: ${bp} %`,
    dossierTcoLine: (perUser, cohort, orcam) =>
      `3 v TCO: EUR ${perUser}/kayttaja (Kohortti EUR ${cohort} vs OrCam EUR ${orcam})`,
    dossierSavingsLine: (saved, pct, mult, served, n) =>
      `Budjettivaikutus: Saastaa EUR ${saved} (${pct.toFixed(1)} % vahennys, ${mult.toFixed(1)}x kustannustehokkuus; palvelee ${served} asukasta ${n} laitteen budjetilla)`,
    dossierPathwayLine:
      "Polku: Nakovammaisten liitto (Iiris-keskus) kotikokeilu + Yliopiston Apteekki holdup://rx QR + HUS Apuvalinekeskus / Kela"
  },
  sv: {
    eyebrow: "Offentlig rehabilitering och pilotekonomi",
    heading: "3-ars TCO och upphandlingskalkylator for synhjalpmedel",
    subtitle:
      "Deterministisk 3-arsmodell fran eval/unit_economics.json som jamfor Ray-Ban Meta Gen 2 + HoldUp med specialkameror (EUR 4 150) och betalda syntolkningsabonnemang.",
    statusBadge: (pct, mult) => `${pct.toFixed(1)} % besparing (${mult.toFixed(1)}x rackvidd)`,
    cohortGroupLabel: "Valj gruppstorlek for pilot eller offentlig upphandling",
    cohortButtonLabel: (n) =>
      n === 1
        ? "1 anvandare"
        : n === 24
          ? "24 anvandare (Iiris-pilot)"
          : n === 100
            ? "100 anvandare (HUS-klinik)"
            : `${n} anvandare (Valfardsomrade)`,
    tierGroupLabel: "Valj prisniva for Gemini API",
    tierLabels: {
      standard_cached: "Standard med cache (EUR 0.00294/kontroll)",
      economy_2_0_live: "Ekonominiva (EUR 0.00172/kontroll)",
      uncached_native_audio_ceiling: "Maxtak utan cache (EUR 0.00749/kontroll)"
    },
    barcodeToggleLabel: (active) =>
      active
        ? "30 % offline holdup://rx streckkod: PA"
        : "30 % offline holdup://rx streckkod: AV",
    adaptiveToggleLabel: (active) =>
      active
        ? "Langsamt Wi-Fi 0.5 fps (-84.0 % video): PA"
        : "Langsamt Wi-Fi 0.5 fps (-84.0 % video): AV",
    tableCaption: "Jamforelse av total agandekostnad over tre ar i euro",
    colMetric: "Kostnads- och rackviddsmatt",
    colHoldUp: "HoldUp + Ray-Ban Meta",
    colOrcam: "OrCam MyEye riktvarde",
    colAdvantage: "Offentlig budgeteffekt",
    rowPerUser3Yr: "3-ars TCO per anvandare",
    rowCohort3Yr: (n) => `3-ars total for gruppen (N = ${n})`,
    rowAnnualCloud: "Arlig molnkostnad per anvandare",
    rowReachOnBudget: (n) => `Betjanade invanare pa budgeten for ${n} specialkameror`,
    advantageSavings: (eur, pct) => `Sparar EUR ${eur} (-${pct.toFixed(1)} %)`,
    advantageCloud: (perCheck, barcodePct) =>
      barcodePct > 0
        ? `EUR ${perCheck}/kontroll (${barcodePct} % offline 0 KB)`
        : `EUR ${perCheck}/kontroll (EUR 329 glasogon)`,
    advantageReach: (served, mult) => `${served} invanare (${mult.toFixed(1)}x rackvidd)`,
    airaNote: (airaEur, airaPct, videoKb) =>
      `Betald distanstolk (Aira EUR 65/man): EUR ${airaEur} over 3 ar (${airaPct.toFixed(1)} % dyrare an HoldUp). Videodata per 12 s kontroll: ${videoKb} KB.`,
    regulatoryHeading: "Finlands ersattningsvag och EU MDR-grans",
    regulatoryBody:
      "Fungerar inom EU MDR Art. 2(1) som icke-medicinskt lashjalpmedel utan serverlagrade halsodata, anpassat for HUS Hjalpmedelscentralen (Halsho- och sjukvardslagen 1326/2010 29 kap.), FPA rehabilitering (566/2005) och holdup://rx apoteks-QR.",
    copyButtonLabel: "Kopiera upphandlingssammanfattning",
    copiedButtonLabel: "Sammanfattning kopierad",
    copyStatusCopied: "Upphandlings- och TCO-sammanfattning kopierad till urklipp.",
    dossierTitle: "HoldUp 3-ars TCO och upphandlingssammanfattning",
    dossierCohortLine: (n, cpd, bp) =>
      `Grupp: N = ${n} anvandare | ${cpd} kontroller/dag | Offline EAN-13-andel: ${bp} %`,
    dossierTcoLine: (perUser, cohort, orcam) =>
      `3-ars TCO: EUR ${perUser}/anvandare (Grupp EUR ${cohort} vs OrCam EUR ${orcam})`,
    dossierSavingsLine: (saved, pct, mult, served, n) =>
      `Budgeteffekt: Sparar EUR ${saved} (${pct.toFixed(1)} % minskning, ${mult.toFixed(1)}x effektivitet; betjanar ${served} invanare pa budgeten for ${n} enheter)`,
    dossierPathwayLine:
      "Vag: Synskadades forbund (Iiris-centret) hemlanepilot + Universitetets Apotek holdup://rx QR + HUS / FPA"
  }
};

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function normalizeTier(raw: unknown): PilotPricingTier {
  if (
    raw === "standard_cached" ||
    raw === "economy_2_0_live" ||
    raw === "uncached_native_audio_ceiling"
  ) {
    return raw;
  }
  return "standard_cached";
}

export function formatEuroAmount(amount: number): string {
  const clean = Number.isFinite(amount) ? amount : 0;
  const fixed = clean.toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withCommas}.${decPart}`;
}

export function computePilotTcoModel(input: Partial<PilotTcoInput> = {}): PilotTcoReport {
  const cohortSize = clampInt(input.cohortSize, 1, 10000, 24);
  const checksPerDay = clampInt(input.checksPerDay, 1, 20, 4);
  const localBarcodeSharePct = clampInt(input.localBarcodeSharePct, 0, 80, 0);
  const tier = normalizeTier(input.tier);
  const adaptiveSlowWifi = Boolean(input.adaptiveSlowWifi);

  const totalChecksThreeYearsPerUser = checksPerDay * 30 * 12 * 3;
  const offlineBarcodeChecksThreeYearsPerUser = Math.round(
    totalChecksThreeYearsPerUser * (localBarcodeSharePct / 100)
  );
  const cloudChecksThreeYearsPerUser = Math.max(
    0,
    totalChecksThreeYearsPerUser - offlineBarcodeChecksThreeYearsPerUser
  );

  const baselineThreeYearCloudEur = adaptiveSlowWifi
    ? TIER_ADAPTIVE_THREE_YEAR_CLOUD_AT_BASELINE_EUR[tier]
    : TIER_THREE_YEAR_CLOUD_AT_BASELINE_EUR[tier];

  const perCheckCloudEur = adaptiveSlowWifi
    ? TIER_PER_CHECK_ADAPTIVE_EUR[tier]
    : TIER_PER_CHECK_NORMAL_EUR[tier];

  const perUserThreeYearCloudEur = roundTo(
    baselineThreeYearCloudEur * (cloudChecksThreeYearsPerUser / BASELINE_THREE_YEAR_CHECKS),
    2
  );
  const perUserAnnualCloudEur = roundTo(perUserThreeYearCloudEur / 3, 2);
  const perUserThreeYearHoldUpEur = roundTo(
    RAYBAN_META_GEN2_HARDWARE_EUR + perUserThreeYearCloudEur,
    2
  );

  const cohortThreeYearHoldUpEur = roundTo(perUserThreeYearHoldUpEur * cohortSize, 2);
  const cohortThreeYearOrcamEur = roundTo(ORCAM_MYEYE_MIDPOINT_EUR * cohortSize, 2);
  const cohortThreeYearAiraEur = roundTo(AIRA_DAILY_PLAN_THREE_YEAR_EUR * cohortSize, 2);

  const cohortSavingsVsOrcamEur = roundTo(cohortThreeYearOrcamEur - cohortThreeYearHoldUpEur, 2);
  const cohortSavingsVsAiraEur = roundTo(cohortThreeYearAiraEur - cohortThreeYearHoldUpEur, 2);

  const savingsVsOrcamPct = roundTo(
    (1 - perUserThreeYearHoldUpEur / ORCAM_MYEYE_MIDPOINT_EUR) * 100,
    1
  );
  const savingsVsAiraPct = roundTo(
    (1 - perUserThreeYearHoldUpEur / AIRA_DAILY_PLAN_THREE_YEAR_EUR) * 100,
    1
  );
  const costReductionMultipleVsOrcam = roundTo(
    ORCAM_MYEYE_MIDPOINT_EUR / perUserThreeYearHoldUpEur,
    1
  );
  const usersServedOnOrcamBudget = Math.floor(cohortThreeYearOrcamEur / perUserThreeYearHoldUpEur);

  const videoKbPerCheck = adaptiveSlowWifi ? ADAPTIVE_12S_VIDEO_KB : NORMAL_12S_VIDEO_KB;
  const videoBandwidthSavedPct = adaptiveSlowWifi ? ADAPTIVE_VIDEO_SAVINGS_PCT : 0;

  return {
    cohortSize,
    checksPerDay,
    localBarcodeSharePct,
    tier,
    adaptiveSlowWifi,
    totalChecksThreeYearsPerUser,
    cloudChecksThreeYearsPerUser,
    offlineBarcodeChecksThreeYearsPerUser,
    perCheckCloudEur,
    perUserHardwareEur: RAYBAN_META_GEN2_HARDWARE_EUR,
    perUserThreeYearCloudEur,
    perUserAnnualCloudEur,
    perUserThreeYearHoldUpEur,
    perUserThreeYearOrcamEur: ORCAM_MYEYE_MIDPOINT_EUR,
    perUserThreeYearAiraEur: AIRA_DAILY_PLAN_THREE_YEAR_EUR,
    cohortThreeYearHoldUpEur,
    cohortThreeYearOrcamEur,
    cohortThreeYearAiraEur,
    cohortSavingsVsOrcamEur,
    cohortSavingsVsAiraEur,
    savingsVsOrcamPct,
    savingsVsAiraPct,
    costReductionMultipleVsOrcam,
    usersServedOnOrcamBudget,
    videoKbPerCheck,
    videoBandwidthSavedPct
  };
}

export function formatProcurementDossierSummary(
  input: Partial<PilotTcoInput> = {},
  lang = "en"
): string {
  const locale = normalizeLang(lang);
  const copy = COPY[locale];
  const report = computePilotTcoModel(input);

  return [
    copy.dossierTitle,
    copy.dossierCohortLine(report.cohortSize, report.checksPerDay, report.localBarcodeSharePct),
    copy.dossierTcoLine(
      formatEuroAmount(report.perUserThreeYearHoldUpEur),
      formatEuroAmount(report.cohortThreeYearHoldUpEur),
      formatEuroAmount(report.cohortThreeYearOrcamEur)
    ),
    copy.dossierSavingsLine(
      formatEuroAmount(report.cohortSavingsVsOrcamEur),
      report.savingsVsOrcamPct,
      report.costReductionMultipleVsOrcam,
      report.usersServedOnOrcamBudget,
      report.cohortSize
    ),
    copy.dossierPathwayLine
  ].join("\n");
}

const CARD_STYLE: CSSProperties = {
  backgroundColor: "var(--bg-surface, #121826)",
  color: "var(--text-primary, #f8fafc)",
  border: "2px solid var(--border-subtle, #2c3a52)",
  borderRadius: "16px",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "16px"
};

const CHIP_BUTTON_BASE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 16px",
  borderRadius: "12px",
  fontSize: "var(--text-base, 1rem)",
  fontWeight: 800,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center"
};

function getToggleStyle(active: boolean): CSSProperties {
  return {
    ...CHIP_BUTTON_BASE,
    backgroundColor: active
      ? "var(--verdict-match-bg, #06261d)"
      : "var(--bg-elevated, #1a2336)",
    color: active
      ? "var(--verdict-match-fg, #7ef7c8)"
      : "var(--text-primary, #f8fafc)",
    border: active
      ? "2px solid var(--verdict-match-border, #2dd4a0)"
      : "2px solid var(--border-strong, #4b6387)"
  };
}

const TABLE_CELL_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-subtle, #2c3a52)",
  textAlign: "left",
  verticalAlign: "middle"
};

export function PilotTcoCalculatorCard(props: PilotTcoCalculatorCardProps): React.ReactElement {
  const locale = normalizeLang(props.lang);
  const copy = COPY[locale];
  const headingId = useId();

  const [cohortSize, setCohortSize] = useState<number>(() =>
    clampInt(props.initialCohortSize, 1, 10000, 24)
  );
  const [checksPerDay] = useState<number>(() =>
    clampInt(props.initialChecksPerDay, 1, 20, 4)
  );
  const [localBarcodeSharePct, setLocalBarcodeSharePct] = useState<number>(() =>
    clampInt(props.initialLocalBarcodeSharePct, 0, 80, 0)
  );
  const [tier, setTier] = useState<PilotPricingTier>(() => normalizeTier(props.initialTier));
  const [adaptiveSlowWifi, setAdaptiveSlowWifi] = useState<boolean>(() =>
    Boolean(props.initialAdaptiveSlowWifi)
  );
  const [copied, setCopied] = useState<boolean>(false);

  const report = computePilotTcoModel({
    cohortSize,
    checksPerDay,
    localBarcodeSharePct,
    tier,
    adaptiveSlowWifi
  });

  const handleCopySummary = (): void => {
    const text = formatProcurementDossierSummary(
      {
        cohortSize,
        checksPerDay,
        localBarcodeSharePct,
        tier,
        adaptiveSlowWifi
      },
      locale
    );
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
    if (props.onCopySummary) {
      props.onCopySummary(text);
    }
    setCopied(true);
  };

  const barcodeBlendOn = localBarcodeSharePct >= 30;

  return (
    <section role="region" aria-labelledby={headingId} style={CARD_STYLE}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 320px" }}>
          <span
            style={{
              fontSize: "var(--text-sm, 0.875rem)",
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-secondary, #cbd5e1)"
            }}
          >
            {copy.eyebrow}
          </span>
          <h2
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-xl, 1.25rem)",
              fontWeight: 900,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.heading}
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-base, 1rem)",
              color: "var(--text-secondary, #cbd5e1)",
              lineHeight: 1.45
            }}
          >
            {copy.subtitle}
          </p>
        </div>

        <div
          role="status"
          aria-live="polite"
          style={{
            backgroundColor: "var(--verdict-match-bg, #06261d)",
            color: "var(--verdict-match-fg, #7ef7c8)",
            border: "2px solid var(--verdict-match-border, #2dd4a0)",
            borderRadius: "999px",
            padding: "8px 14px",
            fontWeight: 800,
            fontSize: "var(--text-sm, 0.875rem)"
          }}
        >
          {copy.statusBadge(report.savingsVsOrcamPct, report.costReductionMultipleVsOrcam)}
        </div>
      </div>

      <div
        role="group"
        aria-label={copy.cohortGroupLabel}
        style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
      >
        {COHORT_PRESETS.map((preset) => {
          const selected = report.cohortSize === preset;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setCohortSize(preset);
                setCopied(false);
              }}
              style={getToggleStyle(selected)}
            >
              {copy.cohortButtonLabel(preset)}
            </button>
          );
        })}
      </div>

      <div
        role="group"
        aria-label={copy.tierGroupLabel}
        style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
      >
        {PRICING_TIERS.map((tierOption) => {
          const selected = report.tier === tierOption;
          return (
            <button
              key={tierOption}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setTier(tierOption);
                setCopied(false);
              }}
              style={getToggleStyle(selected)}
            >
              {copy.tierLabels[tierOption]}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <button
          type="button"
          aria-pressed={barcodeBlendOn}
          onClick={() => {
            setLocalBarcodeSharePct(barcodeBlendOn ? 0 : 30);
            setCopied(false);
          }}
          style={getToggleStyle(barcodeBlendOn)}
        >
          {copy.barcodeToggleLabel(barcodeBlendOn)}
        </button>

        <button
          type="button"
          aria-pressed={adaptiveSlowWifi}
          onClick={() => {
            setAdaptiveSlowWifi(!adaptiveSlowWifi);
            setCopied(false);
          }}
          style={getToggleStyle(adaptiveSlowWifi)}
        >
          {copy.adaptiveToggleLabel(adaptiveSlowWifi)}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "var(--text-base, 1rem)"
          }}
        >
          <caption
            style={{
              textAlign: "left",
              fontWeight: 700,
              marginBottom: "8px",
              color: "var(--text-secondary, #cbd5e1)"
            }}
          >
            {copy.tableCaption}
          </caption>
          <thead>
            <tr>
              <th scope="col" style={TABLE_CELL_STYLE}>
                {copy.colMetric}
              </th>
              <th scope="col" style={TABLE_CELL_STYLE}>
                {copy.colHoldUp}
              </th>
              <th scope="col" style={TABLE_CELL_STYLE}>
                {copy.colOrcam}
              </th>
              <th scope="col" style={TABLE_CELL_STYLE}>
                {copy.colAdvantage}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={TABLE_CELL_STYLE}>
                {copy.rowPerUser3Yr}
              </th>
              <td style={TABLE_CELL_STYLE}>
                <strong>EUR {formatEuroAmount(report.perUserThreeYearHoldUpEur)}</strong>
              </td>
              <td style={TABLE_CELL_STYLE}>
                EUR {formatEuroAmount(report.perUserThreeYearOrcamEur)}
              </td>
              <td style={TABLE_CELL_STYLE}>
                {copy.advantageSavings(
                  formatEuroAmount(report.perUserThreeYearOrcamEur - report.perUserThreeYearHoldUpEur),
                  report.savingsVsOrcamPct
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={TABLE_CELL_STYLE}>
                {copy.rowCohort3Yr(report.cohortSize)}
              </th>
              <td style={TABLE_CELL_STYLE}>
                <strong>EUR {formatEuroAmount(report.cohortThreeYearHoldUpEur)}</strong>
              </td>
              <td style={TABLE_CELL_STYLE}>
                EUR {formatEuroAmount(report.cohortThreeYearOrcamEur)}
              </td>
              <td style={TABLE_CELL_STYLE}>
                {copy.advantageSavings(
                  formatEuroAmount(report.cohortSavingsVsOrcamEur),
                  report.savingsVsOrcamPct
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={TABLE_CELL_STYLE}>
                {copy.rowAnnualCloud}
              </th>
              <td style={TABLE_CELL_STYLE}>
                EUR {formatEuroAmount(report.perUserAnnualCloudEur)}/yr
              </td>
              <td style={TABLE_CELL_STYLE}>EUR 0.00/yr</td>
              <td style={TABLE_CELL_STYLE}>
                {copy.advantageCloud(
                  report.perCheckCloudEur.toFixed(5),
                  report.localBarcodeSharePct
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={TABLE_CELL_STYLE}>
                {copy.rowReachOnBudget(report.cohortSize)}
              </th>
              <td style={TABLE_CELL_STYLE}>
                <strong>{report.usersServedOnOrcamBudget}</strong>
              </td>
              <td style={TABLE_CELL_STYLE}>{report.cohortSize}</td>
              <td style={TABLE_CELL_STYLE}>
                {copy.advantageReach(
                  report.usersServedOnOrcamBudget,
                  report.costReductionMultipleVsOrcam
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: "var(--text-sm, 0.875rem)",
          color: "var(--text-secondary, #cbd5e1)",
          lineHeight: 1.45
        }}
      >
        {copy.airaNote(
          formatEuroAmount(report.cohortThreeYearAiraEur),
          report.savingsVsAiraPct,
          report.videoKbPerCheck.toFixed(2)
        )}
      </p>

      <div
        style={{
          backgroundColor: "var(--bg-elevated, #1a2336)",
          border: "1.5px solid var(--border-subtle, #2c3a52)",
          borderRadius: "12px",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: "4px"
        }}
      >
        <strong style={{ fontSize: "var(--text-base, 1rem)" }}>{copy.regulatoryHeading}</strong>
        <span
          style={{
            fontSize: "var(--text-sm, 0.875rem)",
            color: "var(--text-secondary, #cbd5e1)",
            lineHeight: 1.45
          }}
        >
          {copy.regulatoryBody}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px" }}>
        <button
          type="button"
          onClick={handleCopySummary}
          style={{
            ...CHIP_BUTTON_BASE,
            backgroundColor: "var(--accent-primary, #38bdf8)",
            color: "var(--bg-base, #0b0f17)",
            border: "2px solid var(--accent-primary, #38bdf8)"
          }}
        >
          {copied ? copy.copiedButtonLabel : copy.copyButtonLabel}
        </button>
        <span
          role="status"
          aria-live="polite"
          style={{
            fontSize: "var(--text-sm, 0.875rem)",
            color: "var(--text-secondary, #cbd5e1)"
          }}
        >
          {copied ? copy.copyStatusCopied : ""}
        </span>
      </div>
    </section>
  );
}
