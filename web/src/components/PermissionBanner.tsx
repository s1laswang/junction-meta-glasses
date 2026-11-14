import React, { useId, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { CameraSource, PermissionStateSummary } from "../types.ts";

void React;

export type BrowserStepParts = {
  lead: string;
  beforeMenu: string;
  aALabel?: string;
  afterAa?: string;
  menuLabel: string;
  beforeCamera: string;
  cameraLabel: string;
  beforeAllow: string;
  allowLabel: string;
  afterAllow: string;
};

export type PermissionBannerCopy = {
  cameraUnavailableHeading: string;
  cameraDeniedHeading: string;
  cameraUnavailableBadge: string;
  cameraDeniedBadge: string;
  cameraPrivacyBody: string;
  cameraStepsHeading: string;
  chromeStep: BrowserStepParts;
  safariStep: BrowserStepParts;
  useDemoPropsLabel: string;
  retryCameraLabel: string;
  micHeading: string;
  micUnavailableBadge: string;
  micDeniedBadge: string;
  micFallbackBody: string;
  continueWithoutMicLabel: string;
  errorHeading: string;
  errorRecoverableGuidance: string;
  errorUnrecoverableGuidance: string;
  retryErrorLabel: string;
  dismissErrorLabel: string;
};

export type PermissionBannerProps = {
  permissions: PermissionStateSummary;
  currentSource: CameraSource;
  lastError: { code: string; message: string; recoverable: boolean } | null;
  lang?: string;
  onUseSnapshotMode: () => void;
  onUseDemoProps: () => void;
  onRetryPermissions: () => void;
  onDismissError?: () => void;
};

const COPY_BY_LOCALE: Record<UiLocale, PermissionBannerCopy> = {
  en: {
    cameraUnavailableHeading: "Phone camera is unavailable",
    cameraDeniedHeading: "Camera access is turned off",
    cameraUnavailableBadge: "CAMERA UNAVAILABLE",
    cameraDeniedBadge: "CAMERA BLOCKED",
    cameraPrivacyBody:
      "HoldUp needs the camera to read medication and food labels only while you hold them up. Frames stay in memory only, are never saved on a server, and capture stops automatically after 45 seconds.",
    cameraStepsHeading: "How to turn camera access back on:",
    chromeStep: {
      lead: "Chrome (Android or Desktop):",
      beforeMenu: " Tap the tune or lock icon in the address bar, open ",
      menuLabel: "Site settings",
      beforeCamera: ", set ",
      cameraLabel: "Camera",
      beforeAllow: " to ",
      allowLabel: "Allow",
      afterAllow: ", then tap Retry Camera Permission."
    },
    safariStep: {
      lead: "Safari (iPhone, iPad, or Mac):",
      beforeMenu: " Tap the ",
      aALabel: "aA",
      afterAa: " or page settings menu in the address bar, open ",
      menuLabel: "Website Settings",
      beforeCamera: ", set ",
      cameraLabel: "Camera",
      beforeAllow: " to ",
      allowLabel: "Allow",
      afterAllow: ", then reload or retry below."
    },
    useDemoPropsLabel: "Use Demo Label Props",
    retryCameraLabel: "Retry Camera Permission",
    micHeading: "Voice input is paused",
    micUnavailableBadge: "MIC UNAVAILABLE",
    micDeniedBadge: "MIC BLOCKED",
    micFallbackBody:
      "Microphone is off or blocked. You can still check labels using Snapshot Mode and typed or quick-tap questions.",
    continueWithoutMicLabel: "Continue Without Microphone",
    errorHeading: "Connection or device notice",
    errorRecoverableGuidance:
      "Fallback protection is active. You can retry now or dismiss this notice.",
    errorUnrecoverableGuidance:
      "Please check your device settings or network connection and retry.",
    retryErrorLabel: "Retry",
    dismissErrorLabel: "Dismiss"
  },
  fi: {
    cameraUnavailableHeading: "Puhelimen kamera ei ole käytettävissä",
    cameraDeniedHeading: "Kameran käyttöoikeus on pois päältä",
    cameraUnavailableBadge: "KAMERA EI KÄYTETTÄVISSÄ",
    cameraDeniedBadge: "KAMERA ESTETTY",
    cameraPrivacyBody:
      "HoldUp tarvitsee kameraa lääke- ja elintarvikepakkausten lukemiseen vain silloin, kun pidät pakkausta esillä. Kuvat käsitellään vain käyttömuistissa (RAM), niitä ei koskaan tallenneta palvelimelle ja kuvaus pysähtyy automaattisesti 45 sekunnin kuluttua.",
    cameraStepsHeading: "Näin otat kameran käyttöön uudelleen:",
    chromeStep: {
      lead: "Chrome (Android tai tietokone):",
      beforeMenu: " Napauta osoiterivin asetus- tai lukkokuvaketta, avaa ",
      menuLabel: "Sivuston asetukset",
      beforeCamera: ", valitse ",
      cameraLabel: "Kamera",
      beforeAllow: " ja ",
      allowLabel: "Salli",
      afterAllow: ", ja napauta sitten Yritä kameran lupaa uudelleen."
    },
    safariStep: {
      lead: "Safari (iPhone, iPad tai Mac):",
      beforeMenu: " Napauta osoiterivin ",
      aALabel: "aA",
      afterAa: "-painiketta tai sivuasetuksia, avaa ",
      menuLabel: "Verkkosivuston asetukset",
      beforeCamera: ", valitse ",
      cameraLabel: "Kamera",
      beforeAllow: " ja ",
      allowLabel: "Salli",
      afterAllow: ", ja päivitä sivu tai yritä alta uudelleen."
    },
    useDemoPropsLabel: "Käytä esimerkkipakkauksia",
    retryCameraLabel: "Yritä kameran lupaa uudelleen",
    micHeading: "Ääniohjaus on tauolla",
    micUnavailableBadge: "MIKROFONI EI KÄYTETTÄVISSÄ",
    micDeniedBadge: "MIKROFONI ESTETTY",
    micFallbackBody:
      "Mikrofoni on pois päältä tai estetty. Voit silti tarkistaa pakkaukset yksittäiskuvatilassa (Snapshot Mode) kirjoitetuilla kysymyksillä tai pikavalinnoilla.",
    continueWithoutMicLabel: "Jatka ilman mikrofonia",
    errorHeading: "Yhteys- tai laiteilmoitus",
    errorRecoverableGuidance:
      "Varatila on käytössä. Voit yrittää nyt uudelleen tai sulkea tämän ilmoituksen.",
    errorUnrecoverableGuidance:
      "Tarkista laitteen asetukset tai verkkoyhteys ja yritä uudelleen.",
    retryErrorLabel: "Yritä uudelleen",
    dismissErrorLabel: "Sulje"
  },
  sv: {
    cameraUnavailableHeading: "Telefonkameran är inte tillgänglig",
    cameraDeniedHeading: "Kameraåtkomst är avstängd",
    cameraUnavailableBadge: "KAMERA EJ TILLGÄNGLIG",
    cameraDeniedBadge: "KAMERA BLOCKERAD",
    cameraPrivacyBody:
      "HoldUp behöver kameran för att läsa läkemedels- och livsmedelsetiketter endast medan du håller upp förpackningen. Bildrutor hålls enbart i arbetsminnet (RAM), sparas aldrig på en server och stoppas automatiskt efter 45 sekunder.",
    cameraStepsHeading: "Så aktiverar du kameraåtkomst igen:",
    chromeStep: {
      lead: "Chrome (Android eller dator):",
      beforeMenu: " Tryck på reglage- eller låsikonen i adressfältet, öppna ",
      menuLabel: "Webbplatsinställningar",
      beforeCamera: ", ställ in ",
      cameraLabel: "Kamera",
      beforeAllow: " på ",
      allowLabel: "Tillåt",
      afterAllow: " och tryck sedan på Försök kameratillstånd igen."
    },
    safariStep: {
      lead: "Safari (iPhone, iPad eller Mac):",
      beforeMenu: " Tryck på ",
      aALabel: "aA",
      afterAa: " eller sidinställningar i adressfältet, öppna ",
      menuLabel: "Webbplatsinställningar",
      beforeCamera: ", ställ in ",
      cameraLabel: "Kamera",
      beforeAllow: " på ",
      allowLabel: "Tillåt",
      afterAllow: " och ladda om eller försök igen nedan."
    },
    useDemoPropsLabel: "Använd exempelpaket",
    retryCameraLabel: "Försök kameratillstånd igen",
    micHeading: "Röstinmatning är pausad",
    micUnavailableBadge: "MIKROFON EJ TILLGÄNGLIG",
    micDeniedBadge: "MIKROFON BLOCKERAD",
    micFallbackBody:
      "Mikrofonen är avstängd eller blockerad. Du kan ändå kontrollera etiketter i stillbildsläge (Snapshot Mode) med skrivna frågor eller snabbval.",
    continueWithoutMicLabel: "Fortsätt utan mikrofon",
    errorHeading: "Anslutnings- eller enhetsmeddelande",
    errorRecoverableGuidance:
      "Reservskydd är aktivt. Du kan försöka igen nu eller stänga det här meddelandet.",
    errorUnrecoverableGuidance:
      "Kontrollera enhetens inställningar eller nätverksanslutningen och försök igen.",
    retryErrorLabel: "Försök igen",
    dismissErrorLabel: "Stäng"
  }
};

export function getPermissionBannerCopy(lang?: string): PermissionBannerCopy {
  const locale = normalizeLang(lang ?? "en");
  return COPY_BY_LOCALE[locale];
}

function renderBrowserStep(step: BrowserStepParts) {
  return (
    <>
      <strong>{step.lead}</strong>
      {step.beforeMenu}
      {step.aALabel !== undefined && (
        <>
          <strong>{step.aALabel}</strong>
          {step.afterAa}
        </>
      )}
      <strong>{step.menuLabel}</strong>
      {step.beforeCamera}
      <strong>{step.cameraLabel}</strong>
      {step.beforeAllow}
      <strong>{step.allowLabel}</strong>
      {step.afterAllow}
    </>
  );
}

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  width: "100%"
};

const CARD_BASE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)"
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)"
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg, 1.25rem)",
  fontWeight: 800,
  lineHeight: 1.3,
  display: "flex",
  alignItems: "center",
  gap: "10px"
};

const BODY_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base, 1.125rem)",
  lineHeight: 1.5,
  color: "var(--text-primary, #f8fafc)"
};

const STEPS_BOX_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)",
  padding: "var(--space-3, 12px) var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  color: "var(--text-primary, #f8fafc)",
  border: "1px solid var(--border-subtle, #2c3a52)"
};

const STEPS_LIST_STYLE: CSSProperties = {
  margin: 0,
  paddingLeft: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const ACTIONS_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-3, 12px)",
  marginTop: "var(--space-1, 4px)"
};

const ACTION_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  padding: "14px 20px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  flex: "1 1 220px"
};

function CameraRecoveryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ width: "22px", height: "22px", flexShrink: 0 }}
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function MicRecoveryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ width: "22px", height: "22px", flexShrink: 0 }}
    >
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function InfoAlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ width: "22px", height: "22px", flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="12.5" />
      <circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PermissionBanner(props: PermissionBannerProps) {
  const {
    permissions,
    currentSource,
    lastError,
    lang,
    onUseSnapshotMode,
    onUseDemoProps,
    onRetryPermissions,
    onDismissError
  } = props;

  const uid = useId();
  const locale = normalizeLang(lang ?? "en");
  const copy = COPY_BY_LOCALE[locale];

  const showCameraRecovery =
    currentSource === "phone" &&
    (permissions.camera === "denied" || permissions.camera === "unavailable");

  const showMicRecovery =
    permissions.microphone === "denied" || permissions.microphone === "unavailable";

  const showErrorCard = lastError !== null;

  if (!showCameraRecovery && !showMicRecovery && !showErrorCard) {
    return null;
  }

  const cameraHeadingId = `${uid}-camera-recovery-heading`;
  const micHeadingId = `${uid}-mic-recovery-heading`;
  const errorHeadingId = `${uid}-error-alert-heading`;

  return (
    <div className="permission-banner" lang={locale} style={STACK_STYLE}>
      {showCameraRecovery && (
        <section
          className="card verdict-warning permission-card permission-camera-card"
          aria-labelledby={cameraHeadingId}
          style={{
            ...CARD_BASE_STYLE,
            border: "2.5px solid var(--verdict-warning-border, #ff6b52)"
          }}
        >
          <div style={HEADER_ROW_STYLE}>
            <h2 id={cameraHeadingId} style={HEADING_STYLE}>
              <CameraRecoveryIcon />
              <span>
                {permissions.camera === "unavailable"
                  ? copy.cameraUnavailableHeading
                  : copy.cameraDeniedHeading}
              </span>
            </h2>
            <span className="badge" data-permission-camera={permissions.camera}>
              {permissions.camera === "unavailable"
                ? copy.cameraUnavailableBadge
                : copy.cameraDeniedBadge}
            </span>
          </div>

          <p style={BODY_TEXT_STYLE}>{copy.cameraPrivacyBody}</p>

          <div style={STEPS_BOX_STYLE}>
            <strong style={{ fontSize: "var(--text-sm, 1rem)" }}>{copy.cameraStepsHeading}</strong>
            <ol style={STEPS_LIST_STYLE}>
              <li>{renderBrowserStep(copy.chromeStep)}</li>
              <li>{renderBrowserStep(copy.safariStep)}</li>
            </ol>
          </div>

          <div style={ACTIONS_ROW_STYLE}>
            <button
              type="button"
              className="btn btn-primary permission-btn-demo-props"
              data-action="use-demo-props"
              onClick={onUseDemoProps}
              style={ACTION_BUTTON_STYLE}
            >
              {copy.useDemoPropsLabel}
            </button>
            <button
              type="button"
              className="btn btn-secondary permission-btn-retry-camera"
              data-action="retry-camera-permission"
              onClick={onRetryPermissions}
              style={ACTION_BUTTON_STYLE}
            >
              {copy.retryCameraLabel}
            </button>
          </div>
        </section>
      )}

      {showMicRecovery && (
        <section
          className="card verdict-unsure permission-card permission-mic-card"
          aria-labelledby={micHeadingId}
          style={{
            ...CARD_BASE_STYLE,
            border: "2px solid var(--verdict-unsure-border, #f5b82e)"
          }}
        >
          <div style={HEADER_ROW_STYLE}>
            <h2 id={micHeadingId} style={HEADING_STYLE}>
              <MicRecoveryIcon />
              <span>{copy.micHeading}</span>
            </h2>
            <span className="badge" data-permission-microphone={permissions.microphone}>
              {permissions.microphone === "unavailable"
                ? copy.micUnavailableBadge
                : copy.micDeniedBadge}
            </span>
          </div>

          <p style={BODY_TEXT_STYLE}>{copy.micFallbackBody}</p>

          <div style={ACTIONS_ROW_STYLE}>
            <button
              type="button"
              className="btn btn-primary permission-btn-snapshot"
              data-action="continue-without-microphone"
              onClick={onUseSnapshotMode}
              style={ACTION_BUTTON_STYLE}
            >
              {copy.continueWithoutMicLabel}
            </button>
          </div>
        </section>
      )}

      {showErrorCard && lastError && (
        <div
          className={`card ${lastError.recoverable ? "verdict-info" : "verdict-unsure"} permission-card permission-error-card`}
          role="alert"
          aria-atomic="true"
          aria-labelledby={errorHeadingId}
          style={{
            ...CARD_BASE_STYLE,
            border: lastError.recoverable
              ? "2px solid var(--verdict-info-border, #4da3ff)"
              : "2px solid var(--verdict-unsure-border, #f5b82e)"
          }}
        >
          <div style={HEADER_ROW_STYLE}>
            <h2 id={errorHeadingId} style={HEADING_STYLE}>
              <InfoAlertIcon />
              <span>{copy.errorHeading}</span>
            </h2>
            <span className="badge" data-error-code={lastError.code}>
              {lastError.code}
            </span>
          </div>

          <p style={BODY_TEXT_STYLE}>{lastError.message}</p>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              color: "var(--text-secondary, #d8e1ee)",
              lineHeight: 1.45
            }}
          >
            {lastError.recoverable
              ? copy.errorRecoverableGuidance
              : copy.errorUnrecoverableGuidance}
          </p>

          <div style={ACTIONS_ROW_STYLE}>
            <button
              type="button"
              className="btn btn-primary permission-btn-retry-error"
              data-action="retry-after-error"
              onClick={onRetryPermissions}
              style={ACTION_BUTTON_STYLE}
            >
              {copy.retryErrorLabel}
            </button>
            {onDismissError && (
              <button
                type="button"
                className="btn btn-secondary permission-btn-dismiss-error"
                data-action="dismiss-error"
                onClick={onDismissError}
                style={ACTION_BUTTON_STYLE}
              >
                {copy.dismissErrorLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PermissionBanner;
