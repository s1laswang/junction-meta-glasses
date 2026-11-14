import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent
} from "react";
import type { KeydownHost } from "../a11y/shortcuts.ts";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  mergePharmacyPayload,
  parsePharmacyQrUri,
  type PharmacyRxPayload
} from "../pairing/pharmacyQr.ts";
import type { Med, Profile } from "../types.ts";

export type PharmacyImportModalProps = {
  open: boolean;
  profile: Profile;
  lang: string;
  onImportProfile: (
    next: Profile,
    summary: { added: number; updated: number; pharmacy?: string }
  ) => void;
  onClose: () => void;
};

export type PharmacyPreviewSectionProps = {
  rawInput: string;
  profile: Profile;
  lang: string;
};

type ModalCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  inputLabel: string;
  inputHint: string;
  inputPlaceholder: string;
  sampleButton: string;
  sampleLoadedStatus: string;
  importedStatus: (added: number, updated: number, pharmacy?: string) => string;
  previewHeading: string;
  emptyPreviewNote: string;
  invalidAlertTitle: string;
  invalidAlertBody: string;
  pharmacyLabel: string;
  summaryBadge: (total: number, added: number, updated: number) => string;
  newMedBadge: string;
  refillUpdateBadge: string;
  nameLabel: string;
  ingredientLabel: string;
  strengthLabel: string;
  scheduleLabel: string;
  barcodeLabel: string;
  notesLabel: string;
  allergiesLabel: string;
  avoidLabel: string;
  noneListed: string;
  asDirected: string;
  importButton: string;
  escapeHint: string;
  closeButton: string;
};

const MODAL_COPY: Record<UiLocale, ModalCopy> = {
  en: {
    eyebrow: "Pharmacy Counter Pairing",
    title: "Import Prescription QR",
    subtitle:
      "Scan or paste a pharmacy prescription QR payload to save medications on this device only. Nothing is uploaded to a server.",
    inputLabel: "Prescription QR URI or JSON payload",
    inputHint:
      "Accepts holdup://rx?v=1&data=... links, https://.../rx?v=1&data=... links, or v1 prescription JSON.",
    inputPlaceholder: "holdup://rx?v=1&data=...",
    sampleButton: "Load Sample Finnish Pharmacy QR (Yliopiston Apteekki)",
    sampleLoadedStatus:
      "Loaded sample prescription from Yliopiston Apteekki Helsinki with 2 medications ready to preview.",
    importedStatus: (added, updated, pharmacy) =>
      pharmacy
        ? `Saved prescription from ${pharmacy}: ${added} added, ${updated} updated on this device.`
        : `Saved prescription: ${added} added, ${updated} updated on this device.`,
    previewHeading: "Prescription Preview",
    emptyPreviewNote:
      "Paste a prescription QR payload above or use Load Sample Finnish Pharmacy QR (Yliopiston Apteekki) to preview incoming medications before saving.",
    invalidAlertTitle: "Invalid prescription QR payload",
    invalidAlertBody:
      "Check the pasted text. Expected a valid holdup://rx?v=1&data=... link, https://.../rx?v=1&data=... link, or v1 JSON object with at least one medication and numeric strength.",
    pharmacyLabel: "Dispensing pharmacy",
    summaryBadge: (total, added, updated) =>
      `${total} ${total === 1 ? "medication" : "medications"} (${added} new, ${updated} refill ${
        updated === 1 ? "update" : "updates"
      })`,
    newMedBadge: "New",
    refillUpdateBadge: "Refill update",
    nameLabel: "Medication name",
    ingredientLabel: "Active ingredient",
    strengthLabel: "Strength",
    scheduleLabel: "Schedule",
    barcodeLabel: "Barcode",
    notesLabel: "Directions",
    allergiesLabel: "Allergies to merge",
    avoidLabel: "Avoid list to merge",
    noneListed: "Not listed",
    asDirected: "As directed",
    importButton: "Add to My On-Device Medications",
    escapeHint: "Press Escape anytime to close without importing.",
    closeButton: "Close"
  },
  fi: {
    eyebrow: "Apteekkiliitos",
    title: "Tuo reseptin QR-koodi",
    subtitle:
      "Lue tai liitä apteekin reseptikoodi tallentaaksesi lääkkeesi vain tälle laitteelle. Tietoja ei lähetetä palvelimelle.",
    inputLabel: "Reseptin QR-osoite tai JSON-tietosisältö",
    inputHint:
      "Tukee muotoja holdup://rx?v=1&data=..., https://.../rx?v=1&data=... sekä v1 JSON-reseptiä.",
    inputPlaceholder: "holdup://rx?v=1&data=...",
    sampleButton: "Lataa suomalainen apteekin QR-esimerkki (Yliopiston Apteekki)",
    sampleLoadedStatus:
      "Ladattiin Yliopiston Apteekki Helsingin esimerkkiresepti, jossa on 2 lääkettä esikatseltavana.",
    importedStatus: (added, updated, pharmacy) =>
      pharmacy
        ? `Tallennettiin resepti (${pharmacy}): ${added} lisätty, ${updated} päivitetty tälle laitteelle.`
        : `Tallennettiin resepti: ${added} lisätty, ${updated} päivitetty tälle laitteelle.`,
    previewHeading: "Reseptin esikatselu",
    emptyPreviewNote:
      "Liitä reseptin QR-tietosisältö ylle tai lataa Yliopiston Apteekin esimerkki esikatsellaksesi lääkkeet ennen tallennusta.",
    invalidAlertTitle: "Virheellinen reseptin QR-tietosisältö",
    invalidAlertBody:
      "Tarkista liitetty teksti. Odotettiin kelvollista holdup://rx?v=1&data=... -osoitetta tai v1 JSON-objektia, jossa on vähintään yksi lääke ja numeerinen vahvuus.",
    pharmacyLabel: "Toimittava apteekki",
    summaryBadge: (total, added, updated) =>
      `${total} ${total === 1 ? "lääke" : "lääkettä"} (${added} uutta, ${updated} ${
        updated === 1 ? "päivitys" : "päivitystä"
      })`,
    newMedBadge: "Uusi",
    refillUpdateBadge: "Päivitys",
    nameLabel: "Lääkkeen nimi",
    ingredientLabel: "Vaikuttava aine",
    strengthLabel: "Vahvuus",
    scheduleLabel: "Aikataulu",
    barcodeLabel: "Viivakoodi",
    notesLabel: "Ohje",
    allergiesLabel: "Yhdistettävät allergiat",
    avoidLabel: "Yhdistettävät vältettävät aineet",
    noneListed: "Ei ilmoitettu",
    asDirected: "Ohjeen mukaan",
    importButton: "Lisää laitteeni lääkelistalle",
    escapeHint: "Sulje tallentamatta painamalla Escape milloin tahansa.",
    closeButton: "Sulje"
  },
  sv: {
    eyebrow: "Apotekskoppling",
    title: "Importera recept-QR",
    subtitle:
      "Skanna eller klistra in en receptkod från apoteket för att spara dina läkemedel endast på den här enheten. Inget laddas upp till en server.",
    inputLabel: "Receptets QR-länk eller JSON-data",
    inputHint:
      "Stöder länkar med holdup://rx?v=1&data=..., https://.../rx?v=1&data=... eller v1 recept-JSON.",
    inputPlaceholder: "holdup://rx?v=1&data=...",
    sampleButton: "Ladda finskt apoteks-QR-exempel (Yliopiston Apteekki)",
    sampleLoadedStatus:
      "Laddade exempelrecept från Yliopiston Apteekki Helsinki med 2 läkemedel redo för förhandsgranskning.",
    importedStatus: (added, updated, pharmacy) =>
      pharmacy
        ? `Sparade recept från ${pharmacy}: ${added} tillagda, ${updated} uppdaterade på enheten.`
        : `Sparade recept: ${added} tillagda, ${updated} uppdaterade på enheten.`,
    previewHeading: "Förhandsgranskning av recept",
    emptyPreviewNote:
      "Klistra in en recept-QR ovan eller ladda exemplet från Yliopiston Apteekki för att granska läkemedlen innan de sparas.",
    invalidAlertTitle: "Ogiltig recept-QR-data",
    invalidAlertBody:
      "Kontrollera den inklistrade texten. Förväntade en giltig holdup://rx?v=1&data=... -länk eller ett v1 JSON-objekt med minst ett läkemedel och numerisk styrka.",
    pharmacyLabel: "Expedierande apotek",
    summaryBadge: (total, added, updated) =>
      `${total} läkemedel (${added} nya, ${updated} ${
        updated === 1 ? "uppdatering" : "uppdateringar"
      })`,
    newMedBadge: "Ny",
    refillUpdateBadge: "Uppdatering",
    nameLabel: "Läkemedelsnamn",
    ingredientLabel: "Aktiv substans",
    strengthLabel: "Styrka",
    scheduleLabel: "Schema",
    barcodeLabel: "Streckkod",
    notesLabel: "Dosering",
    allergiesLabel: "Allergier att lägga till",
    avoidLabel: "Undvik-lista att lägga till",
    noneListed: "Ej angiven",
    asDirected: "Enligt anvisning",
    importButton: "Lägg till i mina läkemedel på enheten",
    escapeHint: "Tryck Escape när som helst för att stänga utan att importera.",
    closeButton: "Stäng"
  }
};

export function bindPharmacyEscapeToClose(
  onClose: () => void,
  options?: { enabled?: boolean; host?: KeydownHost | null }
): () => void {
  if (options?.enabled === false) {
    return () => {};
  }
  const host: KeydownHost | null =
    options?.host !== undefined
      ? options.host
      : typeof window !== "undefined"
        ? window
        : null;
  if (!host) {
    return () => {};
  }

  const listener = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) {
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
  };

  host.addEventListener("keydown", listener);
  return () => {
    host.removeEventListener("keydown", listener);
  };
}

export function preparePharmacyImport(
  profile: Profile,
  rawInput: string
): {
  next: Profile;
  summary: { added: number; updated: number; pharmacy?: string };
  payload: PharmacyRxPayload;
} | null {
  const payload = parsePharmacyQrUri(rawInput);
  if (!payload) {
    return null;
  }
  const merged = mergePharmacyPayload(profile, payload);
  const summary: { added: number; updated: number; pharmacy?: string } = payload.pharmacy
    ? { added: merged.added, updated: merged.updated, pharmacy: payload.pharmacy }
    : { added: merged.added, updated: merged.updated };
  return {
    next: merged.profile,
    summary,
    payload
  };
}

function classifyIncomingMeds(
  profile: Profile,
  meds: readonly Med[]
): Array<{ med: Med; isUpdate: boolean }> {
  let current = profile;
  const rows: Array<{ med: Med; isUpdate: boolean }> = [];
  for (const med of meds) {
    const step = mergePharmacyPayload(current, { v: 1, meds: [med] });
    rows.push({ med, isUpdate: step.updated > 0 });
    current = step.profile;
  }
  return rows;
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1100,
  backgroundColor: "var(--bg-overlay, rgba(6, 9, 15, 0.86))",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "var(--space-4, 16px)",
  overflowY: "auto"
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "780px",
  margin: "auto",
  padding: "var(--space-6, 24px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "2px solid var(--border-strong, #6980a3)",
  boxShadow: "var(--shadow-lg, 0 16px 40px rgba(0, 0, 0, 0.56))",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5, 20px)"
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--accent, #5cc0ff)"
};

const titleStyle: CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: "var(--text-xl, 1.5rem)",
  lineHeight: 1.25,
  fontWeight: 800
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base, 1.125rem)",
  lineHeight: 1.5,
  color: "var(--text-secondary, #d8e1ee)"
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const labelStyle: CSSProperties = {
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700,
  lineHeight: 1.35,
  color: "var(--text-primary, #f8fafc)"
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const textareaStyle: CSSProperties = {
  minHeight: "112px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  wordBreak: "break-all"
};

const fullWidthActionButtonStyle: CSSProperties = {
  minHeight: "56px",
  width: "100%",
  padding: "14px 20px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700
};

const closeButtonStyle: CSSProperties = {
  minHeight: "56px",
  minWidth: "132px",
  padding: "14px 22px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700
};

const previewHeaderRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)"
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg, 1.25rem)",
  lineHeight: 1.3,
  fontWeight: 700
};

const pharmacyBannerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)",
  padding: "10px 14px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--accent-subtle, rgba(92, 192, 255, 0.16))",
  border: "1.5px solid var(--accent, #5cc0ff)",
  color: "var(--text-primary, #f8fafc)"
};

const medListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)"
};

const medItemCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--bg-surface, #121926)",
  border: "1.5px solid var(--border-subtle, #2c3a52)"
};

const medTitleRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)"
};

const medGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: "8px 16px",
  margin: 0
};

const detailTermStyle: CSSProperties = {
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  color: "var(--text-secondary, #d8e1ee)"
};

const detailDescStyle: CSSProperties = {
  margin: "2px 0 0 0",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 600,
  color: "var(--text-primary, #f8fafc)"
};

const alertCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
  color: "var(--verdict-warning-fg, #ffb8ab)",
  border: "3px double var(--verdict-warning-border, #ff6b52)"
};

const footerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3, 12px)"
};

const escapeHintStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  color: "var(--text-secondary, #d8e1ee)"
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

export function PharmacyPreviewSection(props: PharmacyPreviewSectionProps) {
  const { rawInput, profile, lang } = props;
  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];
  const trimmed = rawInput.trim();

  if (!trimmed) {
    return (
      <section
        aria-labelledby="pharmacy-preview-heading"
        className="pharmacy-preview-card pharmacy-preview-empty"
        style={sectionCardStyle}
      >
        <h3 id="pharmacy-preview-heading" style={sectionHeadingStyle}>
          {copy.previewHeading}
        </h3>
        <p style={hintStyle}>{copy.emptyPreviewNote}</p>
      </section>
    );
  }

  const prepared = preparePharmacyImport(profile, rawInput);
  if (!prepared) {
    return (
      <div
        id="pharmacy-qr-error"
        role="alert"
        className="pharmacy-qr-alert verdict-warning"
        style={alertCardStyle}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: "24px", height: "24px", flexShrink: 0 }}
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <strong style={{ fontSize: "var(--text-base, 1.125rem)" }}>
            {copy.invalidAlertTitle}
          </strong>
        </div>
        <p style={{ margin: 0, fontSize: "var(--text-sm, 1rem)", lineHeight: 1.5 }}>
          {copy.invalidAlertBody}
        </p>
      </div>
    );
  }

  const { payload, summary } = prepared;
  const classifiedMeds = classifyIncomingMeds(profile, payload.meds);

  return (
    <section
      aria-labelledby="pharmacy-preview-heading"
      className="pharmacy-preview-card"
      style={sectionCardStyle}
    >
      <div style={previewHeaderRowStyle}>
        <h3 id="pharmacy-preview-heading" style={sectionHeadingStyle}>
          {copy.previewHeading}
        </h3>
        <span className="badge" data-preview-summary="true">
          {copy.summaryBadge(payload.meds.length, summary.added, summary.updated)}
        </span>
      </div>

      {payload.pharmacy ? (
        <div className="pharmacy-preview-source" style={pharmacyBannerStyle}>
          <span style={{ fontSize: "var(--text-sm, 1rem)", fontWeight: 600 }}>
            {copy.pharmacyLabel}:
          </span>
          <strong style={{ fontSize: "var(--text-base, 1.125rem)" }}>{payload.pharmacy}</strong>
        </div>
      ) : null}

      <ul className="pharmacy-preview-med-list" style={medListStyle}>
        {classifiedMeds.map(({ med, isUpdate }) => {
          const title = med.name || med.ingredient;
          const scheduleText =
            med.schedule.length > 0 ? med.schedule.join(", ") : copy.asDirected;
          return (
            <li key={med.id} className="pharmacy-preview-med-item" style={medItemCardStyle}>
              <div style={medTitleRowStyle}>
                <h4 style={{ margin: 0, fontSize: "var(--text-lg, 1.25rem)", fontWeight: 800 }}>
                  {title}
                </h4>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  <span className="badge">{med.strength}</span>
                  <span className="badge">
                    {isUpdate ? copy.refillUpdateBadge : copy.newMedBadge}
                  </span>
                </div>
              </div>

              <dl style={medGridStyle}>
                <div>
                  <dt style={detailTermStyle}>{copy.nameLabel}</dt>
                  <dd style={detailDescStyle}>{med.name || copy.noneListed}</dd>
                </div>
                <div>
                  <dt style={detailTermStyle}>{copy.ingredientLabel}</dt>
                  <dd style={detailDescStyle}>{med.ingredient || copy.noneListed}</dd>
                </div>
                <div>
                  <dt style={detailTermStyle}>{copy.strengthLabel}</dt>
                  <dd style={detailDescStyle}>{med.strength}</dd>
                </div>
                <div>
                  <dt style={detailTermStyle}>{copy.scheduleLabel}</dt>
                  <dd style={detailDescStyle}>{scheduleText}</dd>
                </div>
                <div>
                  <dt style={detailTermStyle}>{copy.barcodeLabel}</dt>
                  <dd style={detailDescStyle}>
                    {med.barcode ? <code>{med.barcode}</code> : copy.noneListed}
                  </dd>
                </div>
                {med.notes ? (
                  <div>
                    <dt style={detailTermStyle}>{copy.notesLabel}</dt>
                    <dd style={detailDescStyle}>{med.notes}</dd>
                  </div>
                ) : null}
              </dl>
            </li>
          );
        })}
      </ul>

      {payload.allergies && payload.allergies.length > 0 ? (
        <p style={hintStyle}>
          <strong>{copy.allergiesLabel}:</strong> {payload.allergies.join(", ")}
        </p>
      ) : null}

      {payload.avoid && payload.avoid.length > 0 ? (
        <p style={hintStyle}>
          <strong>{copy.avoidLabel}:</strong> {payload.avoid.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

export function PharmacyImportModal(props: PharmacyImportModalProps) {
  const { open, profile, lang, onImportProfile, onClose } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [rawInput, setRawInput] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (!open) {
      setRawInput("");
      setStatusMessage("");
      return;
    }
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => bindPharmacyEscapeToClose(onClose, { enabled: open }), [open, onClose]);

  if (!open) {
    return null;
  }

  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];
  const trimmed = rawInput.trim();
  const prepared = trimmed ? preparePharmacyImport(profile, rawInput) : null;
  const isInvalid = trimmed.length > 0 && prepared === null;

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setRawInput(event.target.value);
    if (statusMessage) {
      setStatusMessage("");
    }
  };

  const handleLoadSample = () => {
    setRawInput(SAMPLE_FINNISH_PHARMACY_QR);
    setStatusMessage(copy.sampleLoadedStatus);
  };

  const handleImport = () => {
    const result = preparePharmacyImport(profile, rawInput);
    if (!result) {
      return;
    }
    onImportProfile(result.next, result.summary);
    setStatusMessage(
      copy.importedStatus(
        result.summary.added,
        result.summary.updated,
        result.summary.pharmacy
      )
    );
    setRawInput("");
  };

  return (
    <div className="pharmacy-modal-backdrop" style={backdropStyle} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pharmacy-import-dialog-title"
        aria-describedby="pharmacy-import-dialog-subtitle"
        tabIndex={-1}
        lang={locale}
        className="card pharmacy-import-modal"
        style={dialogStyle}
        onKeyDown={handleDialogKeyDown}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <p style={eyebrowStyle}>{copy.eyebrow}</p>
          <h2 id="pharmacy-import-dialog-title" style={titleStyle}>
            {copy.title}
          </h2>
          <p id="pharmacy-import-dialog-subtitle" style={subtitleStyle}>
            {copy.subtitle}
          </p>
        </header>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          style={srOnlyStyle}
        >
          {statusMessage}
        </div>

        <section className="pharmacy-input-section" style={sectionCardStyle}>
          <label htmlFor="pharmacy-qr-input" style={labelStyle}>
            {copy.inputLabel}
          </label>
          <p id="pharmacy-qr-input-hint" style={hintStyle}>
            {copy.inputHint}
          </p>
          <textarea
            id="pharmacy-qr-input"
            className="input"
            rows={4}
            value={rawInput}
            onChange={handleInputChange}
            placeholder={copy.inputPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={isInvalid ? "true" : "false"}
            aria-describedby={
              isInvalid ? "pharmacy-qr-input-hint pharmacy-qr-error" : "pharmacy-qr-input-hint"
            }
            style={textareaStyle}
          />
          <button
            type="button"
            data-action="load-sample-pharmacy-qr"
            className="btn btn-secondary"
            onClick={handleLoadSample}
            style={fullWidthActionButtonStyle}
          >
            {copy.sampleButton}
          </button>
        </section>

        <PharmacyPreviewSection rawInput={rawInput} profile={profile} lang={locale} />

        <button
          type="button"
          data-action="confirm-pharmacy-import"
          className="btn btn-primary"
          disabled={prepared === null}
          aria-disabled={prepared === null}
          onClick={handleImport}
          style={fullWidthActionButtonStyle}
        >
          {copy.importButton}
        </button>

        <footer style={footerRowStyle}>
          <p style={escapeHintStyle}>{copy.escapeHint}</p>
          <button
            type="button"
            data-action="close-pharmacy-import"
            className="btn btn-secondary"
            onClick={onClose}
            style={closeButtonStyle}
          >
            {copy.closeButton}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default PharmacyImportModal;
