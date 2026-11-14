import React, { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { ConsentRecord } from "../types.ts";

export type ConsentOnboardingProps = {
  lang: string;
  consent: ConsentRecord;
  profileMedCount: number;
  isModal?: boolean;
  onAccept: () => void;
  onClose?: () => void;
  onResetDemoProfile: () => void;
  onWipeAllData: () => void;
};

type SupportedLang = "en" | "fi";

type TrustCardCopy = {
  id: string;
  badge: string;
  title: string;
  body: string;
};

type CopyBundle = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  consentAcceptedLabel: (version: string, formattedTime: string | null) => string;
  consentPendingLabel: (version: string) => string;
  cardsListLabel: string;
  cards: (medCount: number) => TrustCardCopy[];
  acceptButton: string;
  loadDemoButton: string;
  deleteInitButton: string;
  confirmPrompt: string;
  confirmDeleteButton: string;
  cancelButton: string;
  closeButton: string;
  announceConfirmNeeded: string;
  announceDeleted: string;
  announceCancelled: string;
  announceDemoLoaded: string;
};

const COPY: Record<SupportedLang, CopyBundle> = {
  en: {
    eyebrow: "HoldUp Privacy & Safety",
    heading: "Consent & On-Device Data Controls",
    subtitle:
      "Review clearly what HoldUp captures, where frames go, what stays on your device, and how to wipe everything in two taps.",
    consentAcceptedLabel: (version, formattedTime) =>
      formattedTime
        ? `Consent active (v${version}, accepted ${formattedTime})`
        : `Consent active (v${version})`,
    consentPendingLabel: (version) => `Consent required before live label checks (v${version})`,
    cardsListLabel: "Five privacy and safety commitments",
    cards: (medCount) => [
      {
        id: "camera-on-demand",
        badge: "01",
        title: "Camera runs only when you ask",
        body: "Starts only on your tap or voice check, shows an active indicator, and auto-stops after 45 seconds."
      },
      {
        id: "zero-server-storage",
        badge: "02",
        title: "Zero server storage",
        body: "Camera frames and voice go to Google Gemini API in memory only to read the label, then are immediately discarded. Transcripts and images are never logged."
      },
      {
        id: "local-profile",
        badge: "03",
        title: "Your medication list stays on this device",
        body: `Medications, allergies, and dose history live in your browser's local storage only (${medCount} ${
          medCount === 1 ? "medicine" : "medicines"
        } currently saved on device).`
      },
      {
        id: "bystander-privacy",
        badge: "04",
        title: "Bystander privacy",
        body: "Glasses capture LED stays active while streaming, and the AI is instructed to ignore people and never describe faces."
      },
      {
        id: "not-medical-device",
        badge: "05",
        title: "Not a medical device",
        body: "HoldUp never guesses an unclear dose (< 80% confidence) and always advises checking with a pharmacist when uncertain."
      }
    ],
    acceptButton: "I Understand, Continue to HoldUp",
    loadDemoButton: "Load Demo Profile (3 Meds + Nut Allergy)",
    deleteInitButton: "Delete All My Local Data",
    confirmPrompt:
      "Are you sure? This permanently deletes your local medication list, allergies, dose log, and consent from this device.",
    confirmDeleteButton: "Confirm Delete Everything",
    cancelButton: "Cancel",
    closeButton: "Close",
    announceConfirmNeeded:
      "Confirmation required. Activate Confirm Delete Everything to erase all local data, or Cancel to keep your data.",
    announceDeleted:
      "All local data deleted from this device, including medications, allergies, dose history, and consent.",
    announceCancelled: "Delete cancelled. Your local data is unchanged.",
    announceDemoLoaded: "Demo profile loaded on this device: 3 medicines and nut allergy."
  },
  fi: {
    eyebrow: "HoldUp tietosuoja ja turvallisuus",
    heading: "Suostumus ja laitteen tietojen hallinta",
    subtitle:
      "Tarkista selkeästi mitä HoldUp kuvaa, minne tiedot kulkevat, mikä pysyy vain laitteellasi ja miten poistat kaiken kahdella painalluksella.",
    consentAcceptedLabel: (version, formattedTime) =>
      formattedTime
        ? `Suostumus voimassa (v${version}, hyväksytty ${formattedTime})`
        : `Suostumus voimassa (v${version})`,
    consentPendingLabel: (version) => `Suostumus tarvitaan ennen etiketin tarkistusta (v${version})`,
    cardsListLabel: "Viisi tietosuoja- ja turvallisuusperiaatetta",
    cards: (medCount) => [
      {
        id: "camera-on-demand",
        badge: "01",
        title: "Kamera käynnistyy vain pyynnöstäsi",
        body: "Käynnistyy vain painalluksesta tai äänikomennosta, näyttää aktiivisen merkkivalon ja pysähtyy automaattisesti 45 sekunnin kuluttua."
      },
      {
        id: "zero-server-storage",
        badge: "02",
        title: "Ei tallennusta palvelimelle",
        body: "Kamerakuvat ja ääni käsitellään Google Gemini APIssa vain käyttömuistissa etiketin lukemista varten ja hävitetään heti. Tekstejä ja kuvia ei koskaan tallenneta lokiin."
      },
      {
        id: "local-profile",
        badge: "03",
        title: "Lääkelistasi pysyy tällä laitteella",
        body: `Lääkkeet, allergiat ja annoshistoria tallennetaan vain selaimesi paikalliseen muistiin (${medCount} ${
          medCount === 1 ? "lääke" : "lääkettä"
        } tallennettuna laitteelle).`
      },
      {
        id: "bystander-privacy",
        badge: "04",
        title: "Sivullisten yksityisyys",
        body: "Lasien kuvausvalo palaa aina suoratoiston aikana, ja tekoäly on ohjeistettu sivuuttamaan ihmiset eikä se koskaan kuvaile kasvoja."
      },
      {
        id: "not-medical-device",
        badge: "05",
        title: "Ei lääkinnällinen laite",
        body: "HoldUp ei koskaan arvaa epäselvää annosta (< 80 % varmuus) ja kehottaa aina varmistamaan asian apteekista epävarmoissa tilanteissa."
      }
    ],
    acceptButton: "Ymmärrän, jatka HoldUpiin",
    loadDemoButton: "Lataa demoprofiili (3 lääkettä + pähkinäallergia)",
    deleteInitButton: "Poista kaikki paikalliset tietoni",
    confirmPrompt:
      "Haluatko varmasti poistaa kaiken? Tämä poistaa pysyvästi lääkelistan, allergiat, annoslokin ja suostumuksen tältä laitteelta.",
    confirmDeleteButton: "Vahvista kaikkien tietojen poisto",
    cancelButton: "Peruuta",
    closeButton: "Sulje",
    announceConfirmNeeded:
      "Vahvistus vaaditaan. Valitse Vahvista kaikkien tietojen poisto tyhjentääksesi laitteen tiedot tai Peruuta säilyttääksesi tiedot.",
    announceDeleted:
      "Kaikki paikalliset tiedot on poistettu tältä laitteelta, mukaan lukien lääkkeet, allergiat, annoshistoria ja suostumus.",
    announceCancelled: "Poisto peruutettu. Paikalliset tietosi säilyivät ennallaan.",
    announceDemoLoaded: "Demoprofiili ladattu laitteelle: 3 lääkettä ja pähkinäallergia."
  }
};

function resolveLang(lang: string): SupportedLang {
  return lang.trim().toLowerCase().startsWith("fi") ? "fi" : "en";
}

function formatAcceptedAt(acceptedAt: number | null, lang: SupportedLang): string | null {
  if (acceptedAt === null || !Number.isFinite(acceptedAt)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat(lang === "fi" ? "fi-FI" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(acceptedAt));
  } catch {
    return null;
  }
}

const modalBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  backgroundColor: "rgba(5, 8, 15, 0.86)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "16px",
  overflowY: "auto"
};

const containerStyle: CSSProperties = {
  width: "100%",
  maxWidth: "760px",
  margin: "0 auto",
  padding: "24px",
  borderRadius: "18px",
  backgroundColor: "var(--surface, var(--card-bg, #0f172a))",
  color: "var(--text, var(--fg, #f8fafc))",
  border: "2px solid var(--border, #334155)",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: "20px"
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px"
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.875rem",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--accent, #38bdf8)"
};

const headingStyle: CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: "1.65rem",
  lineHeight: 1.25,
  fontWeight: 800
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  lineHeight: 1.5,
  color: "var(--muted, #cbd5e1)"
};

const statusPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  padding: "6px 12px",
  borderRadius: "999px",
  fontSize: "0.9rem",
  fontWeight: 600,
  backgroundColor: "var(--surface-elevated, #1e293b)",
  color: "var(--text, #f8fafc)",
  border: "1px solid var(--border, #475569)"
};

const cardsListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: "14px"
};

const trustCardStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "14px",
  backgroundColor: "var(--surface-elevated, #162033)",
  border: "1px solid var(--border, #334155)",
  display: "flex",
  flexDirection: "column",
  gap: "8px"
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px"
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "34px",
  height: "34px",
  borderRadius: "8px",
  backgroundColor: "var(--accent-soft, #0c4a6e)",
  color: "var(--accent-text, #e0f2fe)",
  fontWeight: 800,
  fontSize: "0.9rem",
  flexShrink: 0
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.08rem",
  lineHeight: 1.3,
  fontWeight: 700
};

const cardBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.98rem",
  lineHeight: 1.5,
  color: "var(--muted, #cbd5e1)"
};

const baseButtonStyle: CSSProperties = {
  minHeight: "56px",
  padding: "14px 20px",
  borderRadius: "12px",
  fontSize: "1.05rem",
  lineHeight: 1.3,
  fontWeight: 700,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  boxSizing: "border-box",
  width: "100%"
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "var(--accent, #38bdf8)",
  color: "var(--accent-contrast, #041321)",
  border: "2px solid transparent"
};

const secondaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "var(--surface-elevated, #1e293b)",
  color: "var(--text, #f8fafc)",
  border: "2px solid var(--border-strong, #64748b)"
};

const dangerInitButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "var(--danger-soft, #35131b)",
  color: "var(--danger-text, #fecaca)",
  border: "2px solid var(--danger, #f87171)"
};

const dangerConfirmButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "var(--danger-solid, #b91c1c)",
  color: "#ffffff",
  border: "2px solid #fca5a5"
};

const closeButtonStyle: CSSProperties = {
  minHeight: "56px",
  minWidth: "96px",
  padding: "12px 18px",
  borderRadius: "12px",
  fontSize: "1rem",
  fontWeight: 700,
  cursor: "pointer",
  backgroundColor: "var(--surface-elevated, #1e293b)",
  color: "var(--text, #f8fafc)",
  border: "2px solid var(--border-strong, #64748b)"
};

const actionsStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px"
};

const confirmBoxStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "14px",
  backgroundColor: "var(--danger-soft, #2c1017)",
  border: "2px solid var(--danger, #f87171)",
  display: "flex",
  flexDirection: "column",
  gap: "12px"
};

const confirmButtonsRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px"
};

const announcementStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "10px",
  backgroundColor: "var(--surface-elevated, #1e293b)",
  border: "1px solid var(--accent, #38bdf8)",
  color: "var(--text, #f8fafc)",
  fontSize: "0.98rem",
  fontWeight: 600
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

export function ConsentOnboarding(props: ConsentOnboardingProps) {
  const {
    lang,
    consent,
    profileMedCount,
    isModal = false,
    onAccept,
    onClose,
    onResetDemoProfile,
    onWipeAllData
  } = props;

  const resolvedLang = resolveLang(lang);
  const copy = COPY[resolvedLang];
  const safeMedCount = Number.isFinite(profileMedCount) && profileMedCount > 0 ? Math.floor(profileMedCount) : 0;
  const cards = copy.cards(safeMedCount);
  const formattedTime = formatAcceptedAt(consent.acceptedAt, resolvedLang);

  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelWipeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isModal) {
      return;
    }
    dialogRef.current?.focus();
  }, [isModal]);

  useEffect(() => {
    if (!isModal || !onClose) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isModal, onClose]);

  const handleRequestWipe = () => {
    setConfirmingWipe(true);
    setStatusMessage(copy.announceConfirmNeeded);
    queueMicrotask(() => {
      cancelWipeRef.current?.focus();
    });
  };

  const handleCancelWipe = () => {
    setConfirmingWipe(false);
    setStatusMessage(copy.announceCancelled);
    queueMicrotask(() => {
      deleteTriggerRef.current?.focus();
    });
  };

  const handleConfirmWipe = () => {
    onWipeAllData();
    setConfirmingWipe(false);
    setStatusMessage(copy.announceDeleted);
    queueMicrotask(() => {
      deleteTriggerRef.current?.focus();
    });
  };

  const handleResetDemo = () => {
    setConfirmingWipe(false);
    onResetDemoProfile();
    setStatusMessage(copy.announceDemoLoaded);
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && onClose) {
      onClose();
    }
  };

  const innerContent = (
    <>
      <div style={headerRowStyle}>
        <div>
          <p style={eyebrowStyle}>{copy.eyebrow}</p>
          <h2 id="consent-heading" style={headingStyle}>
            {copy.heading}
          </h2>
        </div>
        {isModal && onClose ? (
          <button
            type="button"
            className="btn btn-secondary"
            style={closeButtonStyle}
            onClick={onClose}
          >
            {copy.closeButton}
          </button>
        ) : null}
      </div>

      <p id="consent-subtitle" style={subtitleStyle}>
        {copy.subtitle}
      </p>

      <div style={statusPillStyle}>
        {consent.accepted
          ? copy.consentAcceptedLabel(consent.version, formattedTime)
          : copy.consentPendingLabel(consent.version)}
      </div>

      <ol aria-label={copy.cardsListLabel} style={cardsListStyle}>
        {cards.map((card) => (
          <li key={card.id} className="card" style={trustCardStyle}>
            <div style={cardHeaderStyle}>
              <span aria-hidden="true" style={badgeStyle}>
                {card.badge}
              </span>
              <h3 style={cardTitleStyle}>{card.title}</h3>
            </div>
            <p style={cardBodyStyle}>{card.body}</p>
          </li>
        ))}
      </ol>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={statusMessage ? announcementStyle : srOnlyStyle}
      >
        {statusMessage}
      </div>

      <div style={actionsStackStyle}>
        <button
          type="button"
          className="btn btn-primary"
          style={primaryButtonStyle}
          onClick={onAccept}
        >
          {copy.acceptButton}
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          style={secondaryButtonStyle}
          onClick={handleResetDemo}
        >
          {copy.loadDemoButton}
        </button>

        {!confirmingWipe ? (
          <button
            ref={deleteTriggerRef}
            type="button"
            className="btn btn-danger"
            style={dangerInitButtonStyle}
            onClick={handleRequestWipe}
          >
            {copy.deleteInitButton}
          </button>
        ) : (
          <div
            role="group"
            aria-labelledby="consent-wipe-prompt"
            className="card"
            style={confirmBoxStyle}
          >
            <p id="consent-wipe-prompt" style={{ margin: 0, fontWeight: 700, fontSize: "1rem" }}>
              {copy.confirmPrompt}
            </p>
            <div style={confirmButtonsRowStyle}>
              <button
                type="button"
                className="btn btn-danger"
                style={dangerConfirmButtonStyle}
                onClick={handleConfirmWipe}
              >
                {copy.confirmDeleteButton}
              </button>
              <button
                ref={cancelWipeRef}
                type="button"
                className="btn btn-secondary"
                style={secondaryButtonStyle}
                onClick={handleCancelWipe}
              >
                {copy.cancelButton}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );

  if (isModal) {
    return (
      <div style={modalBackdropStyle} onClick={handleBackdropClick}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-heading"
          aria-describedby="consent-subtitle"
          tabIndex={-1}
          className="card consent-onboarding"
          style={containerStyle}
        >
          {innerContent}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="consent-heading"
      aria-describedby="consent-subtitle"
      className="card consent-onboarding"
      style={containerStyle}
    >
      {innerContent}
    </section>
  );
}

export default ConsentOnboarding;
