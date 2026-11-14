import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type RefObject
} from "react";
import type { KeydownHost } from "../a11y/shortcuts.ts";
import { isBarcodeDetectorSupported } from "../camera/barcode.ts";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  mergePharmacyPayload,
  type PharmacyRxPayload
} from "../pairing/pharmacyQr.ts";
import {
  classifyScannedCode,
  detectAndClassifyFromSource,
  type ScannedCodeClassification
} from "../pairing/qrScanner.ts";
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

export type PharmacyCameraScannerSectionProps = {
  scanning: boolean;
  cameraError: string;
  lang: string;
  onToggleScan: () => void;
  videoRef?: RefObject<HTMLVideoElement | null>;
};

export type PharmacyInputGuidance =
  | { kind: "empty" }
  | { kind: "pharmacy_rx"; payload: PharmacyRxPayload }
  | {
      kind: "bridge_pairing";
      title: string;
      body: string;
      serverOrigin: string;
      sessionId: string | null;
    }
  | {
      kind: "product_barcode";
      title: string;
      body: string;
      normalizedDigits: string;
    }
  | {
      kind: "unknown";
      title: string;
      body: string;
    };

export type PharmacyVideoSink = {
  srcObject?: unknown;
  playsInline?: boolean;
  muted?: boolean;
  setAttribute?: (name: string, value: string) => void;
  play?: () => Promise<void> | void;
};

export type MediaTrackLike = {
  stop: () => void;
};

export type MediaStreamLike = {
  getTracks: () => MediaTrackLike[];
};

export type PharmacyDetectorFactory = () =>
  | Promise<{ detect(s: unknown): Promise<Array<{ rawValue?: string }>> } | null>
  | { detect(s: unknown): Promise<Array<{ rawValue?: string }>> }
  | null;

export type PharmacyCameraScanOptions = {
  lang: string;
  getVideoElement: () => PharmacyVideoSink | null;
  onDetected: (classification: ScannedCodeClassification) => void;
  onError: (message: string) => void;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  isDetectorSupported?: () => boolean;
  detectorFactory?: PharmacyDetectorFactory;
  scanIntervalMs?: number;
};

export type PharmacyCameraScanHandle = {
  stop: () => void;
  readonly active: boolean;
  readonly ready: Promise<boolean>;
};

type ModalCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  inputLabel: string;
  inputHint: string;
  inputPlaceholder: string;
  scanCameraButton: string;
  stopCameraButton: string;
  cameraViewHint: string;
  cameraVideoLabel: string;
  cameraStartedStatus: string;
  cameraStoppedStatus: string;
  cameraCapturedStatus: (medCount: number, pharmacy?: string) => string;
  cameraApiUnavailable: string;
  barcodeDetectorUnavailable: string;
  cameraPermissionDenied: string;
  cameraDeviceUnavailable: string;
  sampleButton: string;
  sampleLoadedStatus: string;
  importedStatus: (added: number, updated: number, pharmacy?: string) => string;
  previewHeading: string;
  emptyPreviewNote: string;
  invalidAlertTitle: string;
  invalidAlertBody: string;
  bridgeQrAlertTitle: string;
  bridgeQrAlertBody: (serverOrigin: string, sessionId: string | null) => string;
  productBarcodeAlertTitle: string;
  productBarcodeAlertBody: (normalizedDigits: string) => string;
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
    scanCameraButton: "Scan QR with Camera",
    stopCameraButton: "Stop Camera Scan",
    cameraViewHint:
      "Point the camera at the pharmacy prescription QR code. Camera stops automatically once a prescription QR is captured.",
    cameraVideoLabel: "Live camera viewfinder for pharmacy prescription QR scan",
    cameraStartedStatus:
      "Camera QR scanner active. Hold the pharmacy prescription QR in front of the camera.",
    cameraStoppedStatus: "Camera QR scanner stopped.",
    cameraCapturedStatus: (medCount, pharmacy) =>
      pharmacy
        ? `Captured prescription QR from ${pharmacy} with ${medCount} ${
            medCount === 1 ? "medication" : "medications"
          }. Camera stopped.`
        : `Captured prescription QR with ${medCount} ${
            medCount === 1 ? "medication" : "medications"
          }. Camera stopped.`,
    cameraApiUnavailable:
      "Camera access is unavailable in this browser or requires an HTTPS connection. Paste the prescription QR link above instead.",
    barcodeDetectorUnavailable:
      "Live QR scanning is unavailable in this browser because BarcodeDetector is not supported. Paste the prescription QR link above or open HoldUp in Chrome or Edge.",
    cameraPermissionDenied:
      "Camera permission was denied. Allow camera access in your browser settings or paste the prescription QR link above.",
    cameraDeviceUnavailable:
      "Could not start the camera on this device. Check that no other app is using the camera, or paste the prescription QR link above.",
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
    bridgeQrAlertTitle: "Android Glasses Bridge pairing QR detected",
    bridgeQrAlertBody: (serverOrigin, sessionId) =>
      sessionId
        ? `This holdupbridge://connect QR pairs the Android DAT Glasses Bridge with ${serverOrigin} (session ${sessionId}), not a pharmacy prescription. Scan it in the Android Bridge app or open the Device tab, and scan a holdup://rx prescription QR here.`
        : `This holdupbridge://connect QR pairs the Android DAT Glasses Bridge with ${serverOrigin}, not a pharmacy prescription. Scan it in the Android Bridge app or open the Device tab, and scan a holdup://rx prescription QR here.`,
    productBarcodeAlertTitle: "Retail package barcode detected, not a prescription QR",
    productBarcodeAlertBody: (normalizedDigits) =>
      `Barcode ${normalizedDigits} is a retail EAN/UPC package code without prescription dosing or schedule details. Use the Check view to match saved medication boxes by barcode, or ask the pharmacist for a holdup://rx prescription QR.`,
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
    scanCameraButton: "Lue QR-koodi kameralla",
    stopCameraButton: "Lopeta kameran QR-luku",
    cameraViewHint:
      "Suuntaa kamera apteekin reseptin QR-koodiin. Kamera sammuu automaattisesti, kun reseptikoodi on luettu.",
    cameraVideoLabel: "Kameran etsin apteekin reseptin QR-lukua varten",
    cameraStartedStatus:
      "Kameran QR-lukija käynnissä. Pidä apteekin reseptin QR-koodi kameran edessä.",
    cameraStoppedStatus: "Kameran QR-lukija pysäytetty.",
    cameraCapturedStatus: (medCount, pharmacy) =>
      pharmacy
        ? `Luettiin reseptin QR-koodi (${pharmacy}), ${medCount} ${
            medCount === 1 ? "lääke" : "lääkettä"
          }. Kamera pysäytetty.`
        : `Luettiin reseptin QR-koodi, ${medCount} ${
            medCount === 1 ? "lääke" : "lääkettä"
          }. Kamera pysäytetty.`,
    cameraApiUnavailable:
      "Kamera ei ole käytettävissä tässä selaimessa tai vaatii suojatun HTTPS-yhteyden. Liitä sen sijaan reseptin QR-linkki ylle.",
    barcodeDetectorUnavailable:
      "Kameran QR-luku ei ole käytettävissä tässä selaimessa, koska BarcodeDetector-tukea ei ole. Liitä reseptin QR-linkki ylle tai avaa HoldUp Chromessa tai Edgessä.",
    cameraPermissionDenied:
      "Kameran käyttöoikeus estettiin. Salli kamera selaimen asetuksista tai liitä reseptin QR-linkki ylle.",
    cameraDeviceUnavailable:
      "Kameraa ei voitu käynnistää tällä laitteella. Tarkista, ettei toinen sovellus käytä kameraa, tai liitä reseptin QR-linkki ylle.",
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
    bridgeQrAlertTitle: "Havaittiin Android-lasisillan paritus-QR",
    bridgeQrAlertBody: (serverOrigin, sessionId) =>
      sessionId
        ? `Tämä holdupbridge://connect -koodi yhdistää Android DAT -lasisillan palvelimeen ${serverOrigin} (istunto ${sessionId}), eikä sisällä reseptiä. Lue koodi Android-siltasovelluksessa tai Laite-välilehdellä, ja lue tähän holdup://rx -reseptikoodi.`
        : `Tämä holdupbridge://connect -koodi yhdistää Android DAT -lasisillan palvelimeen ${serverOrigin}, eikä sisällä reseptiä. Lue koodi Android-siltasovelluksessa tai Laite-välilehdellä, ja lue tähän holdup://rx -reseptikoodi.`,
    productBarcodeAlertTitle: "Havaittiin pakkauksen viivakoodi, ei reseptin QR-koodia",
    productBarcodeAlertBody: (normalizedDigits) =>
      `Viivakoodi ${normalizedDigits} on pakkauksen EAN/UPC-tuotekoodi ilman reseptin annostus- tai aikataulutietoja. Käytä Tarkista-näkymää tallennettujen lääkepakkausten viivakooditunnistukseen tai pyydä apteekista holdup://rx -reseptikoodi.`,
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
    scanCameraButton: "Skanna QR med kameran",
    stopCameraButton: "Stoppa kameraskanning",
    cameraViewHint:
      "Rikta kameran mot apotekets recept-QR-kod. Kameran stoppar automatiskt när en recept-QR har lästs.",
    cameraVideoLabel: "Kamerasökare för skanning av apotekets recept-QR",
    cameraStartedStatus:
      "Kamerans QR-skanner är aktiv. Håll apotekets recept-QR framför kameran.",
    cameraStoppedStatus: "Kamerans QR-skanner stoppad.",
    cameraCapturedStatus: (medCount, pharmacy) =>
      pharmacy
        ? `Läste recept-QR från ${pharmacy} med ${medCount} läkemedel. Kameran stoppad.`
        : `Läste recept-QR med ${medCount} läkemedel. Kameran stoppad.`,
    cameraApiUnavailable:
      "Kameran är inte tillgänglig i den här webbläsaren eller kräver en säker HTTPS-anslutning. Klistra in receptets QR-länk ovan istället.",
    barcodeDetectorUnavailable:
      "Direkt QR-skanning är inte tillgänglig i den här webbläsaren eftersom BarcodeDetector inte stöds. Klistra in receptets QR-länk ovan eller öppna HoldUp i Chrome eller Edge.",
    cameraPermissionDenied:
      "Kameraåtkomst nekades. Tillåt kameran i webbläsarens inställningar eller klistra in receptets QR-länk ovan.",
    cameraDeviceUnavailable:
      "Kunde inte starta kameran på den här enheten. Kontrollera att ingen annan app använder kameran, eller klistra in receptets QR-länk ovan.",
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
    bridgeQrAlertTitle: "Android-glasögonbryggans parkopplings-QR identifierades",
    bridgeQrAlertBody: (serverOrigin, sessionId) =>
      sessionId
        ? `Denna holdupbridge://connect -kod parkopplar Android DAT-glasögonbryggan med ${serverOrigin} (session ${sessionId}), inte ett apoteksrecept. Skanna koden i Android-bryggappen eller på fliken Enhet, och skanna en holdup://rx -receptkod här.`
        : `Denna holdupbridge://connect -kod parkopplar Android DAT-glasögonbryggan med ${serverOrigin}, inte ett apoteksrecept. Skanna koden i Android-bryggappen eller på fliken Enhet, och skanna en holdup://rx -receptkod här.`,
    productBarcodeAlertTitle: "Förpackningens streckkod identifierades, inte en recept-QR",
    productBarcodeAlertBody: (normalizedDigits) =>
      `Streckkoden ${normalizedDigits} är en EAN/UPC-förpackningskod utan receptets doserings- eller schematider. Använd vyn Kontrollera för att matcha sparade läkemedelsförpackningar med streckkod, eller be apoteket om en holdup://rx -receptkod.`,
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

export function describePharmacyInput(rawInput: string, lang: string): PharmacyInputGuidance {
  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];
  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!trimmed) {
    return { kind: "empty" };
  }

  const classified = classifyScannedCode(trimmed);
  if (classified.kind === "pharmacy_rx") {
    return { kind: "pharmacy_rx", payload: classified.payload };
  }
  if (classified.kind === "bridge_pairing") {
    return {
      kind: "bridge_pairing",
      title: copy.bridgeQrAlertTitle,
      body: copy.bridgeQrAlertBody(classified.serverOrigin, classified.sessionId),
      serverOrigin: classified.serverOrigin,
      sessionId: classified.sessionId
    };
  }
  if (classified.kind === "product_barcode") {
    return {
      kind: "product_barcode",
      title: copy.productBarcodeAlertTitle,
      body: copy.productBarcodeAlertBody(classified.normalizedDigits),
      normalizedDigits: classified.normalizedDigits
    };
  }
  return {
    kind: "unknown",
    title: copy.invalidAlertTitle,
    body: copy.invalidAlertBody
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
  const classified = classifyScannedCode(rawInput);
  if (classified.kind !== "pharmacy_rx") {
    return null;
  }
  const payload = classified.payload;
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

function stopMediaStreamTracks(stream: unknown): void {
  if (
    !stream ||
    typeof stream !== "object" ||
    !("getTracks" in stream) ||
    typeof (stream as MediaStreamLike).getTracks !== "function"
  ) {
    return;
  }
  for (const track of (stream as MediaStreamLike).getTracks()) {
    try {
      track.stop();
    } catch {
      void 0;
    }
  }
}

function describeCameraError(err: unknown, copy: ModalCopy): string {
  const name =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return copy.cameraPermissionDenied;
  }
  return copy.cameraDeviceUnavailable;
}

export function startPharmacyCameraQrScan(
  options: PharmacyCameraScanOptions
): PharmacyCameraScanHandle {
  const locale = normalizeLang(options.lang);
  const copy = MODAL_COPY[locale];

  const requestUserMedia:
    | ((constraints: MediaStreamConstraints) => Promise<MediaStreamLike>)
    | null =
    options.getUserMedia !== undefined
      ? options.getUserMedia
      : typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getUserMedia === "function"
        ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null;

  if (!requestUserMedia) {
    options.onError(copy.cameraApiUnavailable);
    return {
      stop: () => {},
      get active() {
        return false;
      },
      ready: Promise.resolve(false)
    };
  }

  const detectorSupported =
    options.detectorFactory !== undefined
      ? true
      : options.isDetectorSupported !== undefined
        ? options.isDetectorSupported()
        : isBarcodeDetectorSupported();

  if (!detectorSupported) {
    options.onError(copy.barcodeDetectorUnavailable);
    return {
      stop: () => {},
      get active() {
        return false;
      },
      ready: Promise.resolve(false)
    };
  }

  const intervalMs =
    typeof options.scanIntervalMs === "number" &&
    Number.isFinite(options.scanIntervalMs) &&
    options.scanIntervalMs >= 10
      ? Math.round(options.scanIntervalMs)
      : 250;

  let stopped = false;
  let tickInFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stream: MediaStreamLike | null = null;
  let attachedVideo: PharmacyVideoSink | null = null;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (stream) {
      stopMediaStreamTracks(stream);
      stream = null;
    }
    if (attachedVideo) {
      stopMediaStreamTracks(attachedVideo.srcObject);
      attachedVideo.srcObject = null;
      attachedVideo = null;
    }
  };

  const attachToVideoIfPresent = (): PharmacyVideoSink | null => {
    const videoEl = options.getVideoElement();
    if (!videoEl || !stream) {
      return null;
    }
    if (attachedVideo !== videoEl) {
      attachedVideo = videoEl;
      videoEl.playsInline = true;
      videoEl.muted = true;
      if (typeof videoEl.setAttribute === "function") {
        videoEl.setAttribute("playsinline", "true");
      }
      videoEl.srcObject = stream;
      if (typeof videoEl.play === "function") {
        try {
          const playResult = videoEl.play();
          if (
            playResult &&
            typeof (playResult as Promise<void>).catch === "function"
          ) {
            (playResult as Promise<void>).catch(() => {});
          }
        } catch {
          void 0;
        }
      }
    }
    return videoEl;
  };

  const scheduleNextTick = (): void => {
    if (stopped || timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void runTick();
    }, intervalMs);
  };

  const runTick = async (): Promise<void> => {
    if (stopped || tickInFlight) {
      return;
    }
    const source = attachToVideoIfPresent();
    if (!source) {
      scheduleNextTick();
      return;
    }
    tickInFlight = true;
    let classified: ScannedCodeClassification | null = null;
    try {
      classified = await detectAndClassifyFromSource(source, options.detectorFactory);
    } finally {
      tickInFlight = false;
    }

    if (stopped) {
      return;
    }

    if (classified !== null) {
      if (classified.kind === "pharmacy_rx") {
        stop();
        options.onDetected(classified);
        return;
      }
      options.onDetected(classified);
    }

    scheduleNextTick();
  };

  const ready = (async (): Promise<boolean> => {
    let acquired: MediaStreamLike;
    try {
      acquired = await requestUserMedia({ video: { facingMode: "environment" } });
    } catch (err) {
      if (!stopped) {
        stopped = true;
        options.onError(describeCameraError(err, copy));
      }
      return false;
    }

    if (stopped) {
      stopMediaStreamTracks(acquired);
      return false;
    }

    stream = acquired;
    attachToVideoIfPresent();
    await runTick();
    return true;
  })();

  return {
    stop,
    get active() {
      return !stopped;
    },
    ready
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

const cameraContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)",
  padding: "var(--space-3, 12px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-surface, #121926)",
  border: "2px solid var(--accent, #5cc0ff)"
};

const cameraVideoStyle: CSSProperties = {
  width: "100%",
  maxHeight: "280px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "#000000",
  objectFit: "cover"
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

export function PharmacyCameraScannerSection(props: PharmacyCameraScannerSectionProps) {
  const { scanning, cameraError, lang, onToggleScan, videoRef } = props;
  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];

  return (
    <>
      <button
        type="button"
        data-action="toggle-pharmacy-camera-scan"
        className={scanning ? "btn btn-primary" : "btn btn-secondary"}
        aria-pressed={scanning}
        aria-expanded={scanning}
        onClick={onToggleScan}
        style={fullWidthActionButtonStyle}
      >
        {scanning ? copy.stopCameraButton : copy.scanCameraButton}
      </button>

      {scanning ? (
        <div
          data-camera-scanner="active"
          className="pharmacy-camera-scanner"
          style={cameraContainerStyle}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label={copy.cameraVideoLabel}
            style={cameraVideoStyle}
          />
          <p style={hintStyle}>{copy.cameraViewHint}</p>
        </div>
      ) : null}

      {cameraError ? (
        <div
          id="pharmacy-camera-error"
          role="alert"
          data-camera-error="true"
          className="pharmacy-camera-alert verdict-warning"
          style={alertCardStyle}
        >
          <p style={{ margin: 0, fontSize: "var(--text-sm, 1rem)", lineHeight: 1.5 }}>
            {cameraError}
          </p>
        </div>
      ) : null}
    </>
  );
}

export function PharmacyPreviewSection(props: PharmacyPreviewSectionProps) {
  const { rawInput, profile, lang } = props;
  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];
  const guidance = describePharmacyInput(rawInput, locale);

  if (guidance.kind === "empty") {
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

  if (guidance.kind !== "pharmacy_rx") {
    return (
      <div
        id="pharmacy-qr-error"
        role="alert"
        data-code-kind={guidance.kind}
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
            {guidance.title}
          </strong>
        </div>
        <p style={{ margin: 0, fontSize: "var(--text-sm, 1rem)", lineHeight: 1.5 }}>
          {guidance.body}
        </p>
      </div>
    );
  }

  const { payload } = guidance;
  const merged = mergePharmacyPayload(profile, payload);
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
          {copy.summaryBadge(payload.meds.length, merged.added, merged.updated)}
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanHandleRef = useRef<PharmacyCameraScanHandle | null>(null);
  const lastScannedRawRef = useRef<string>("");
  const [rawInput, setRawInput] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [cameraScanning, setCameraScanning] = useState(false);
  const [cameraError, setCameraError] = useState("");

  const stopCameraScan = useCallback(() => {
    if (scanHandleRef.current) {
      scanHandleRef.current.stop();
      scanHandleRef.current = null;
    }
    if (videoRef.current) {
      stopMediaStreamTracks(videoRef.current.srcObject);
      videoRef.current.srcObject = null;
    }
    lastScannedRawRef.current = "";
    setCameraScanning(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCameraScan();
    };
  }, [stopCameraScan]);

  useEffect(() => {
    if (!open) {
      stopCameraScan();
      setRawInput("");
      setStatusMessage("");
      setCameraError("");
      return;
    }
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => {
      stopCameraScan();
      previous?.focus?.();
    };
  }, [open, stopCameraScan]);

  const handleEscapeClose = useCallback(() => {
    stopCameraScan();
    onClose();
  }, [stopCameraScan, onClose]);

  useEffect(
    () => bindPharmacyEscapeToClose(handleEscapeClose, { enabled: open }),
    [open, handleEscapeClose]
  );

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
      stopCameraScan();
      onClose();
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      stopCameraScan();
      onClose();
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setRawInput(event.target.value);
    if (cameraError) {
      setCameraError("");
    }
    if (statusMessage) {
      setStatusMessage("");
    }
  };

  const handleToggleCameraScan = () => {
    if (cameraScanning || scanHandleRef.current?.active) {
      stopCameraScan();
      setStatusMessage(copy.cameraStoppedStatus);
      return;
    }

    setCameraError("");
    lastScannedRawRef.current = "";
    setCameraScanning(true);
    setStatusMessage(copy.cameraStartedStatus);

    const handle = startPharmacyCameraQrScan({
      lang: locale,
      getVideoElement: () => videoRef.current,
      onDetected: (classified) => {
        if (classified.kind === "pharmacy_rx") {
          scanHandleRef.current = null;
          lastScannedRawRef.current = "";
          setCameraScanning(false);
          setCameraError("");
          setRawInput(classified.raw);
          setStatusMessage(
            copy.cameraCapturedStatus(
              classified.payload.meds.length,
              classified.payload.pharmacy
            )
          );
          return;
        }
        if (lastScannedRawRef.current === classified.raw) {
          return;
        }
        lastScannedRawRef.current = classified.raw;
        if (classified.kind === "bridge_pairing") {
          setRawInput(classified.raw);
          setStatusMessage(
            `${copy.bridgeQrAlertTitle}. ${copy.bridgeQrAlertBody(
              classified.serverOrigin,
              classified.sessionId
            )}`
          );
        } else if (classified.kind === "product_barcode") {
          setRawInput(classified.raw);
          setStatusMessage(
            `${copy.productBarcodeAlertTitle}. ${copy.productBarcodeAlertBody(
              classified.normalizedDigits
            )}`
          );
        }
      },
      onError: (message) => {
        scanHandleRef.current = null;
        lastScannedRawRef.current = "";
        setCameraScanning(false);
        setCameraError(message);
        setStatusMessage(message);
      }
    });

    if (handle.active) {
      scanHandleRef.current = handle;
    } else {
      scanHandleRef.current = null;
      setCameraScanning(false);
    }
  };

  const handleLoadSample = () => {
    stopCameraScan();
    setCameraError("");
    setRawInput(SAMPLE_FINNISH_PHARMACY_QR);
    setStatusMessage(copy.sampleLoadedStatus);
  };

  const handleImport = () => {
    const result = preparePharmacyImport(profile, rawInput);
    if (!result) {
      return;
    }
    stopCameraScan();
    setCameraError("");
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

  const handleCloseClick = () => {
    stopCameraScan();
    onClose();
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
          <PharmacyCameraScannerSection
            scanning={cameraScanning}
            cameraError={cameraError}
            lang={locale}
            onToggleScan={handleToggleCameraScan}
            videoRef={videoRef}
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
            onClick={handleCloseClick}
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
