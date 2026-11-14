import React, { type CSSProperties } from "react";
import { normalizeBarcode } from "../camera/barcode.ts";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { Profile, TransportMode } from "../types.ts";

void React;

export const MIN_OFFLINE_BARCODE_DIGITS = 8;

export type OfflineMedCoverageItem = {
  id: string;
  name: string;
  strength: string;
  normalizedBarcode: string | null;
  offlineReady: boolean;
};

export type OfflineCoverageSummary = {
  totalMeds: number;
  barcodeReadyCount: number;
  missingBarcodeCount: number;
  coveragePct: number;
  items: OfflineMedCoverageItem[];
};

export type OfflineReadinessCardProps = {
  profile: Profile;
  mode: TransportMode;
  lang: string;
  onScanBarcodeNow?: () => void;
  onOpenPharmacyImport?: () => void;
};

type Tone = "ok" | "warn" | "danger" | "info";

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  localDetectorPill: string;
  modeBadges: Record<TransportMode, string>;
  summaryBadgeAllReady: (ready: number, total: number, pct: number) => string;
  summaryBadgePartial: (ready: number, total: number, pct: number) => string;
  summaryBadgeEmpty: string;
  offlineCalloutTitle: string;
  offlineCalloutAllReady: (count: number) => string;
  offlineCalloutMissing: (ready: number, total: number, missing: number) => string;
  offlineCalloutEmpty: string;
  meterHeading: string;
  meterStats: (ready: number, total: number, missing: number) => string;
  meterAriaLabel: (pct: number, ready: number, total: number) => string;
  medsHeading: string;
  medsListAriaLabel: string;
  emptyMedsNotice: string;
  readyBadge: string;
  missingBadge: string;
  barcodeValueLabel: (code: string) => string;
  missingBarcodeHint: string;
  actionsGroupAria: string;
  scanButtonLabel: string;
  scanButtonAria: string;
  importButtonLabel: string;
  importButtonAria: string;
  safetyBoundaryHeading: string;
  safetyBoundaryBody: string;
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
  danger: {
    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
    color: "var(--verdict-warning-fg, #ffb8ab)",
    border: "2px dashed var(--verdict-warning-border, #ff6b52)"
  },
  info: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "1.5px solid var(--verdict-info-border, #4da3ff)"
  }
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Zero-Network Barcode Resilience",
    heading: "On-Device Offline Barcode Coverage & Pack Readiness",
    subtitle:
      "When Wi-Fi drops, HoldUp switches to zero-cloud BarcodeDetector matching against EAN and GTIN codes saved in your profile on this device.",
    localDetectorPill: "Zero-Network On-Device Match",
    modeBadges: {
      live: "Network: Live",
      snapshot: "Network: Snapshot",
      offline: "Network: Offline"
    },
    summaryBadgeAllReady: (ready, total, pct) => `${ready}/${total} Ready (${pct}%)`,
    summaryBadgePartial: (ready, total, pct) => `${ready}/${total} Ready (${pct}%)`,
    summaryBadgeEmpty: "0 Saved Meds (100%)",
    offlineCalloutTitle: "Offline Mode Active: On-Device Barcode Matching Only",
    offlineCalloutAllReady: (count) =>
      `No network connection. All ${count} saved ${count === 1 ? "prescription has" : "prescriptions have"} a verified EAN/GTIN barcode ready for local scanning. Unsaved labels will not be guessed.`,
    offlineCalloutMissing: (ready, total, missing) =>
      `No network connection. ${ready} of ${total} saved prescriptions can be matched by barcode offline, while ${missing} ${missing === 1 ? "pack lacks" : "packs lack"} a saved barcode and cannot be verified without reconnecting or asking a pharmacist.`,
    offlineCalloutEmpty:
      "No network connection and 0 medications are saved on this device. Unsaved labels cannot be read offline; import a Pharmacy QR sticker or confirm with a pharmacist.",
    meterHeading: "Saved Prescription Barcode Coverage",
    meterStats: (ready, total, missing) =>
      total === 0
        ? "0 prescriptions saved on this device (0 missing barcodes)"
        : `${ready} of ${total} offline-ready, ${missing} missing ${missing === 1 ? "barcode" : "barcodes"}`,
    meterAriaLabel: (pct, ready, total) =>
      `Offline barcode coverage: ${pct}% (${ready} of ${total} saved medications ready)`,
    medsHeading: "Per-Prescription Pack Registration Status",
    medsListAriaLabel: "Saved medications offline barcode readiness",
    emptyMedsNotice:
      "No prescriptions saved yet. Import a dispensing-counter Pharmacy QR sticker or add your medications with EAN/GTIN pack barcodes for 100% offline verification.",
    readyBadge: "OFFLINE READY",
    missingBadge: "MISSING BARCODE",
    barcodeValueLabel: (code) => `EAN/GTIN ${code}`,
    missingBarcodeHint:
      "No valid EAN/GTIN (>= 8 digits) saved. Import a Pharmacy QR or register the carton barcode before going offline.",
    actionsGroupAria: "Offline barcode scan and Pharmacy QR registration actions",
    scanButtonLabel: "Scan Barcode Now",
    scanButtonAria: "Scan a medication package barcode on this device now",
    importButtonLabel: "Import Pharmacy QR",
    importButtonAria: "Open Pharmacy QR import to register prescription barcodes",
    safetyBoundaryHeading: "Honest Offline Abstention & Pharmacist Boundary",
    safetyBoundaryBody:
      "Offline mode matches saved EAN/GTIN barcodes locally with zero network traffic and refuses to guess unknown or unregistered packages."
  },
  fi: {
    eyebrow: "Verkoton viivakoodivalmius",
    heading: "Laitteen offline-viivakoodikattavuus ja pakkausvalmius",
    subtitle:
      "Kun Wi-Fi-yhteys katkeaa, HoldUp täsmää pakkausten EAN- ja GTIN-viivakoodit paikallisesti laitteelle tallennettuihin lääkkeisiin ilman verkkoliikennettä.",
    localDetectorPill: "Paikallinen tarkistus ilman verkkoa",
    modeBadges: {
      live: "Yhteys: Live",
      snapshot: "Yhteys: Kertakuva",
      offline: "Yhteys: Offline"
    },
    summaryBadgeAllReady: (ready, total, pct) => `${ready}/${total} valmiina (${pct} %)`,
    summaryBadgePartial: (ready, total, pct) => `${ready}/${total} valmiina (${pct} %)`,
    summaryBadgeEmpty: "0 tallennettua lääkettä (100 %)",
    offlineCalloutTitle: "Offline-tila käytössä: vain laitteen viivakooditäsmäys",
    offlineCalloutAllReady: (count) =>
      `Ei verkkoyhteyttä. Kaikilla ${count} tallennetulla reseptilääkkeellä on EAN/GTIN-viivakoodi valmiina paikalliseen lukuun. Tuntemattomia pakkauksia ei koskaan arvata.`,
    offlineCalloutMissing: (ready, total, missing) =>
      `Ei verkkoyhteyttä. ${ready}/${total} tallennettua lääkettä voidaan tunnistaa viivakoodista ilman verkkoa, mutta ${missing} pakkaukselta puuttuu viivakoodi eikä niitä voi varmistaa ilman verkkoa tai apteekkia.`,
    offlineCalloutEmpty:
      "Ei verkkoyhteyttä ja laitteella on 0 tallennettua lääkettä. Tallentamattomia etikettejä ei voi lukea offline-tilassa; tuo apteekin QR-tarra tai varmista apteekista.",
    meterHeading: "Tallennettujen reseptilääkkeiden viivakoodikattavuus",
    meterStats: (ready, total, missing) =>
      total === 0
        ? "0 tallennettua reseptilääkettä tällä laitteella (0 puuttuvaa viivakoodia)"
        : `${ready}/${total} offline-valmiina, ${missing} puuttuvaa viivakoodia`,
    meterAriaLabel: (pct, ready, total) =>
      `Offline-viivakoodikattavuus: ${pct} % (${ready}/${total} tallennettua lääkettä valmiina)`,
    medsHeading: "Lääkepakkausten rekisteröintitila",
    medsListAriaLabel: "Tallennettujen lääkkeiden offline-viivakoodivalmius",
    emptyMedsNotice:
      "Reseptilääkkeitä ei ole vielä tallennettu. Tuo apteekin QR-tarra tai lisää lääkkeiden EAN/GTIN-viivakoodit täyttä offline-varmistusta varten.",
    readyBadge: "OFFLINE-VALMIS",
    missingBadge: "VIIVAKOODI PUUTTUU",
    barcodeValueLabel: (code) => `EAN/GTIN ${code}`,
    missingBarcodeHint:
      "Kelvollista EAN/GTIN-koodia (>= 8 numeroa) ei ole tallennettu. Tuo apteekin QR-koodi tai rekisteröi pakkauksen viivakoodi.",
    actionsGroupAria: "Offline-viivakoodin luku ja apteekin QR-tuonti",
    scanButtonLabel: "Lue viivakoodi nyt",
    scanButtonAria: "Lue lääkepakkauksen viivakoodi laitteella nyt",
    importButtonLabel: "Tuo apteekin QR",
    importButtonAria: "Avaa apteekin QR-tuonti reseptilääkkeiden viivakoodien rekisteröimiseksi",
    safetyBoundaryHeading: "Rehellinen offline-kieltäytyminen ja apteekkiraja",
    safetyBoundaryBody:
      "Offline-tila täsmää tallennetut EAN/GTIN-viivakoodit paikallisesti ilman pilveä eikä koskaan arvaa rekisteröimättömiä pakkauksia."
  },
  sv: {
    eyebrow: "Nätverksfri streckkodsberedskap",
    heading: "Lokal offline-streckkodstäckning och förpackningsberedskap",
    subtitle:
      "När Wi-Fi bryts växlar HoldUp till molnfri BarcodeDetector-matchning mot EAN- och GTIN-koder sparade i din profil på den här enheten.",
    localDetectorPill: "Lokal matchning utan nätverk",
    modeBadges: {
      live: "Nätverk: Live",
      snapshot: "Nätverk: Stillbild",
      offline: "Nätverk: Offline"
    },
    summaryBadgeAllReady: (ready, total, pct) => `${ready}/${total} redo (${pct} %)`,
    summaryBadgePartial: (ready, total, pct) => `${ready}/${total} redo (${pct} %)`,
    summaryBadgeEmpty: "0 sparade läkemedel (100 %)",
    offlineCalloutTitle: "Offline-läge aktivt: endast lokal streckkodsmatchning",
    offlineCalloutAllReady: (count) =>
      `Ingen nätverksanslutning. Alla ${count} sparade recept har en verifierad EAN/GTIN-streckkod redo för lokal skanning. Okända etiketter gissas aldrig.`,
    offlineCalloutMissing: (ready, total, missing) =>
      `Ingen nätverksanslutning. ${ready} av ${total} sparade läkemedel kan matchas med streckkod offline, medan ${missing} ${missing === 1 ? "förpackning saknar" : "förpackningar saknar"} sparad streckkod och kräver uppkoppling eller apotekspersonal.`,
    offlineCalloutEmpty:
      "Ingen nätverksanslutning och 0 läkemedel är sparade på enheten. Osparade etiketter kan inte läsas offline; importera en apoteks-QR eller fråga apotekspersonal.",
    meterHeading: "Streckkodstäckning för sparade recept",
    meterStats: (ready, total, missing) =>
      total === 0
        ? "0 sparade recept på den här enheten (0 saknade streckkoder)"
        : `${ready} av ${total} offline-redo, ${missing} saknar streckkod`,
    meterAriaLabel: (pct, ready, total) =>
      `Offline-streckkodstäckning: ${pct} % (${ready} av ${total} sparade läkemedel redo)`,
    medsHeading: "Registreringsstatus per läkemedelsförpackning",
    medsListAriaLabel: "Offline-streckkodsberedskap för sparade läkemedel",
    emptyMedsNotice:
      "Inga recept har sparats ännu. Importera en apoteks-QR-etikett eller lägg till läkemedel med EAN/GTIN-streckkoder för 100 % offline-verifiering.",
    readyBadge: "OFFLINE-REDO",
    missingBadge: "STRECKKOD SAKNAS",
    barcodeValueLabel: (code) => `EAN/GTIN ${code}`,
    missingBarcodeHint:
      "Ingen giltig EAN/GTIN-kod (>= 8 siffror) sparad. Importera apoteks-QR eller registrera kartongens streckkod.",
    actionsGroupAria: "Åtgärder för streckkodsskanning offline och apoteks-QR",
    scanButtonLabel: "Skanna streckkod nu",
    scanButtonAria: "Skanna en läkemedelsförpacknings streckkod lokalt nu",
    importButtonLabel: "Importera apoteks-QR",
    importButtonAria: "Öppna apoteks-QR-import för att registrera receptstreckkoder",
    safetyBoundaryHeading: "Ärlig offline-avgränsning och apoteksgräns",
    safetyBoundaryBody:
      "Offline-läget matchar sparade EAN/GTIN-streckkoder lokalt utan nätverkstrafik och gissar aldrig okända eller oregistrerade förpackningar."
  }
};

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

function sanitizeInlineValue(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/[\u0000-\u001F\u007F\u2013\u2014]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizeOfflineCoverage(profile: Profile): OfflineCoverageSummary {
  const rawMeds = Array.isArray(profile?.meds) ? profile.meds : [];
  const items: OfflineMedCoverageItem[] = [];

  for (let i = 0; i < rawMeds.length; i += 1) {
    const med = rawMeds[i];
    if (!med || typeof med !== "object") {
      continue;
    }
    const id = sanitizeInlineValue(med.id) || `med-${i + 1}`;
    const name =
      sanitizeInlineValue(med.name) ||
      sanitizeInlineValue(med.ingredient) ||
      `Medication ${i + 1}`;
    const strength = sanitizeInlineValue(med.strength);
    const normalized = normalizeBarcode(med.barcode);
    const offlineReady = normalized.length >= MIN_OFFLINE_BARCODE_DIGITS;

    items.push({
      id,
      name,
      strength,
      normalizedBarcode: offlineReady ? normalized : null,
      offlineReady
    });
  }

  const totalMeds = items.length;
  const barcodeReadyCount = items.filter((item) => item.offlineReady).length;
  const missingBarcodeCount = totalMeds - barcodeReadyCount;
  const coveragePct =
    totalMeds === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round((barcodeReadyCount / totalMeds) * 100)));

  return {
    totalMeds,
    barcodeReadyCount,
    missingBarcodeCount,
    coveragePct,
    items
  };
}

function CardIcon({
  kind
}: {
  kind: "ready" | "missing" | "offline" | "barcode" | "qr" | "shield";
}) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (kind === "ready") {
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
        <path d="M8.5 12.3l2.4 2.4 4.8-5" />
      </svg>
    );
  }

  if (kind === "missing") {
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
        <path d="M12 3L22 20H2L12 3z" />
        <line x1="12" y1="9" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (kind === "offline") {
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
        style={{ width: "18px", height: "18px", flexShrink: 0 }}
      >
        <line x1="2" y1="2" x2="22" y2="22" />
        <path d="M16.7 11.1A10.9 10.9 0 0 1 19 12.6" />
        <path d="M5 12.6a10.9 10.9 0 0 1 5.2-2.7" />
        <path d="M10.7 5.1A16 16 0 0 1 22.6 9" />
        <path d="M1.4 9a16 16 0 0 1 4.7-2.9" />
        <path d="M8.5 16.1a6 6 0 0 1 7 0" />
        <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (kind === "barcode") {
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
        style={{ width: "18px", height: "18px", flexShrink: 0 }}
      >
        <path d="M3 5v14" />
        <path d="M7 5v14" />
        <path d="M10 5v14" />
        <path d="M14 5v14" />
        <path d="M17 5v14" />
        <path d="M21 5v14" />
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
        style={{ width: "18px", height: "18px", flexShrink: 0 }}
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 14h3v3h-3z" />
        <path d="M18 18h3v3h-3z" />
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
      style={{ width: "18px", height: "18px", flexShrink: 0 }}
    >
      <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
      <path d="M8.5 12.3l2.4 2.4 4.8-5" />
    </svg>
  );
}

export function OfflineReadinessCard(props: OfflineReadinessCardProps) {
  const { profile, mode, lang, onScanBarcodeNow, onOpenPharmacyImport } = props;
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const disclaimerText = t(locale, "notMedicalDevice");
  const summary = summarizeOfflineCoverage(profile);

  const isOffline = mode === "offline";
  const allReady = summary.missingBarcodeCount === 0;
  const hasScanAction = typeof onScanBarcodeNow === "function";
  const hasImportAction = typeof onOpenPharmacyImport === "function";
  const hasActions = hasScanAction || hasImportAction;

  const summaryTone: Tone =
    summary.totalMeds === 0
      ? "info"
      : allReady
        ? "ok"
        : summary.barcodeReadyCount === 0
          ? "danger"
          : "warn";

  const summaryBadgeLabel =
    summary.totalMeds === 0
      ? copy.summaryBadgeEmpty
      : allReady
        ? copy.summaryBadgeAllReady(
            summary.barcodeReadyCount,
            summary.totalMeds,
            summary.coveragePct
          )
        : copy.summaryBadgePartial(
            summary.barcodeReadyCount,
            summary.totalMeds,
            summary.coveragePct
          );

  const meterFillColor =
    summaryTone === "ok"
      ? "var(--verdict-match-border, #2dd4a0)"
      : summaryTone === "info"
        ? "var(--verdict-info-border, #4da3ff)"
        : summaryTone === "warn"
          ? "var(--verdict-unsure-border, #f5b82e)"
          : "var(--verdict-warning-border, #ff6b52)";

  const offlineCalloutTone: Tone =
    summary.totalMeds === 0 ? "warn" : allReady ? "ok" : "danger";

  const offlineCalloutMessage =
    summary.totalMeds === 0
      ? copy.offlineCalloutEmpty
      : allReady
        ? copy.offlineCalloutAllReady(summary.barcodeReadyCount)
        : copy.offlineCalloutMissing(
            summary.barcodeReadyCount,
            summary.totalMeds,
            summary.missingBarcodeCount
          );

  const headingId = "offline-readiness-card-heading";
  const medsHeadingId = "offline-readiness-meds-heading";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card offline-readiness-card"
      data-mode={mode}
      data-coverage-pct={String(summary.coveragePct)}
      data-ready-count={String(summary.barcodeReadyCount)}
      data-missing-count={String(summary.missingBarcodeCount)}
      data-total-meds={String(summary.totalMeds)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: isOffline
          ? "2px solid var(--verdict-unsure-border, #f5b82e)"
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
            className="badge offline-coverage-summary-badge"
            data-coverage-summary-badge="true"
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
            <CardIcon kind={allReady ? "ready" : "missing"} />
            <span>{summaryBadgeLabel}</span>
          </span>

          <span
            className="pill offline-transport-mode-pill"
            data-transport-mode={mode}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: isOffline
                ? "var(--verdict-unsure-bg, #261b04)"
                : "var(--bg-elevated, #1a2333)",
              color: isOffline
                ? "var(--verdict-unsure-fg, #ffe169)"
                : "var(--text-primary, #f8fafc)",
              border: isOffline
                ? "1.5px solid var(--verdict-unsure-border, #f5b82e)"
                : "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700
            }}
          >
            {copy.modeBadges[mode]}
          </span>

          <span
            className="pill offline-local-detector-pill"
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
            {copy.localDetectorPill}
          </span>
        </div>
      </header>

      {isOffline ? (
        <div
          role="status"
          aria-live="polite"
          className="offline-mode-active-callout"
          data-offline-callout="active"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
            padding: "var(--space-4, 16px)",
            borderRadius: "var(--radius-md, 12px)",
            ...TONE_BADGE_STYLES[offlineCalloutTone]
          }}
        >
          <CardIcon kind="offline" />
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <strong
              style={{
                fontSize: "var(--text-base, 1.125rem)",
                fontWeight: 800,
                lineHeight: 1.3
              }}
            >
              {copy.offlineCalloutTitle}
            </strong>
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                lineHeight: 1.45,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {offlineCalloutMessage}
            </p>
          </div>
        </div>
      ) : null}

      <div
        className="offline-coverage-meter-box"
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
            {copy.meterHeading}
          </span>

          <span
            className="offline-coverage-pct-label"
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-base, 1.125rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {summary.coveragePct}%
          </span>
        </div>

        <meter
          className="sr-only offline-coverage-meter"
          data-coverage-meter="true"
          min={0}
          max={100}
          low={50}
          high={99}
          optimum={100}
          value={summary.coveragePct}
          aria-label={copy.meterAriaLabel(
            summary.coveragePct,
            summary.barcodeReadyCount,
            summary.totalMeds
          )}
          style={SR_ONLY_STYLE}
        >
          {summary.coveragePct}%
        </meter>

        <div
          className="offline-coverage-bar-track"
          aria-hidden="true"
          style={{
            position: "relative",
            width: "100%",
            height: "14px",
            backgroundColor: "var(--bg-app, #0b0f17)",
            border: "1px solid var(--border-subtle, #2c3a52)",
            borderRadius: "var(--radius-pill, 9999px)",
            overflow: "hidden"
          }}
        >
          <div
            className="offline-coverage-bar-fill"
            style={{
              width: `${summary.coveragePct}%`,
              minWidth: summary.coveragePct > 0 ? "4px" : "0px",
              height: "100%",
              backgroundColor: meterFillColor
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
          {copy.meterStats(
            summary.barcodeReadyCount,
            summary.totalMeds,
            summary.missingBarcodeCount
          )}
        </p>
      </div>

      <div
        role="group"
        aria-labelledby={medsHeadingId}
        className="offline-meds-coverage-section"
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
            fontSize: "var(--text-base, 1.125rem)",
            fontWeight: 800,
            lineHeight: 1.3,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.medsHeading}
        </h3>

        {summary.items.length === 0 ? (
          <p
            className="offline-meds-empty-state"
            data-empty-meds="true"
            style={{
              margin: 0,
              padding: "var(--space-4, 16px)",
              borderRadius: "var(--radius-md, 12px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              border: "1.5px dashed var(--border-strong, #6980a3)",
              color: "var(--text-secondary, #d8e1ee)",
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45
            }}
          >
            {copy.emptyMedsNotice}
          </p>
        ) : (
          <ul
            aria-label={copy.medsListAriaLabel}
            className="offline-med-coverage-list"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: "var(--space-3, 12px)"
            }}
          >
            {summary.items.map((item) => {
              const title = item.strength ? `${item.name} ${item.strength}` : item.name;
              const badgeTone: Tone = item.offlineReady ? "ok" : "warn";

              return (
                <li
                  key={item.id}
                  data-med-id={item.id}
                  data-offline-ready={item.offlineReady ? "true" : "false"}
                  className={`offline-med-coverage-item ${
                    item.offlineReady ? "is-offline-ready" : "is-missing-barcode"
                  }`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "10px",
                    padding: "var(--space-4, 16px)",
                    borderRadius: "var(--radius-md, 12px)",
                    backgroundColor: "var(--bg-elevated, #1a2333)",
                    border: item.offlineReady
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
                    <strong
                      className="offline-med-title"
                      style={{
                        fontSize: "var(--text-base, 1.125rem)",
                        fontWeight: 800,
                        color: "var(--text-primary, #f8fafc)"
                      }}
                    >
                      {title}
                    </strong>

                    <span
                      className="badge offline-med-status-badge"
                      data-med-badge={item.offlineReady ? "ready" : "missing"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 10px",
                        borderRadius: "var(--radius-pill, 9999px)",
                        fontSize: "0.78rem",
                        fontWeight: 800,
                        letterSpacing: "0.03em",
                        ...TONE_BADGE_STYLES[badgeTone]
                      }}
                    >
                      <CardIcon kind={item.offlineReady ? "ready" : "missing"} />
                      <span>{item.offlineReady ? copy.readyBadge : copy.missingBadge}</span>
                    </span>
                  </div>

                  {item.offlineReady && item.normalizedBarcode !== null ? (
                    <code
                      className="offline-med-barcode-value"
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--verdict-match-fg, #7ef7c8)"
                      }}
                    >
                      {copy.barcodeValueLabel(item.normalizedBarcode)}
                    </code>
                  ) : (
                    <p
                      className="offline-med-missing-hint"
                      style={{
                        margin: 0,
                        fontSize: "var(--text-xs, 0.875rem)",
                        lineHeight: 1.45,
                        color: "var(--text-secondary, #d8e1ee)"
                      }}
                    >
                      {copy.missingBarcodeHint}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hasActions ? (
        <div
          role="group"
          aria-label={copy.actionsGroupAria}
          className="offline-readiness-actions"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "var(--space-3, 12px)"
          }}
        >
          {hasScanAction ? (
            <button
              type="button"
              className="btn btn-primary offline-scan-barcode-btn"
              data-action="scan-barcode-now"
              aria-label={copy.scanButtonAria}
              onClick={onScanBarcodeNow}
              style={ACTION_BUTTON_STYLE}
            >
              <CardIcon kind="barcode" />
              <span>{copy.scanButtonLabel}</span>
            </button>
          ) : null}

          {hasImportAction ? (
            <button
              type="button"
              className="btn btn-secondary offline-open-pharmacy-btn"
              data-action="open-pharmacy-import"
              aria-label={copy.importButtonAria}
              onClick={onOpenPharmacyImport}
              style={ACTION_BUTTON_STYLE}
            >
              <CardIcon kind="qr" />
              <span>{copy.importButtonLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        role="note"
        className="offline-safety-boundary-note"
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
        <CardIcon kind="shield" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <strong
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              lineHeight: 1.35
            }}
          >
            {copy.safetyBoundaryHeading}
          </strong>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.45,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.safetyBoundaryBody} {disclaimerText}
          </p>
        </div>
      </div>
    </section>
  );
}

export default OfflineReadinessCard;
