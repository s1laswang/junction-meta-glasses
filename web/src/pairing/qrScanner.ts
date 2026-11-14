import { normalizeBarcode } from "../camera/barcode.ts";
import { normalizeServerOrigin } from "./links.ts";
import { parsePharmacyQrUri, type PharmacyRxPayload } from "./pharmacyQr.ts";

export type ScannedCodeClassification =
  | { kind: "pharmacy_rx"; raw: string; payload: PharmacyRxPayload }
  | { kind: "bridge_pairing"; raw: string; serverOrigin: string; sessionId: string | null }
  | { kind: "product_barcode"; raw: string; normalizedDigits: string }
  | { kind: "unknown"; raw: string };

type RawDetectedBarcode = {
  rawValue?: string;
};

type RawBarcodeDetector = {
  detect(s: unknown): Promise<Array<RawDetectedBarcode>>;
};

type GlobalBarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): RawBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

const SCANNER_FORMATS = [
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128"
];

const BRIDGE_URI_RE = /^holdupbridge:\/\/connect\/?\?([^\s#]+)$/i;
const BRIDGE_SESSION_RE = /^[\w-]{4,64}$/;
const HTTP_ORIGIN_PREFIX_RE = /^https?:\/\//i;
const RETAIL_BARCODE_RAW_RE = /^[\d\s-]+$/;
const NORMALIZED_RETAIL_DIGITS_RE = /^\d{8,14}$/;

const CLASSIFICATION_PRIORITY: Record<ScannedCodeClassification["kind"], number> = {
  pharmacy_rx: 4,
  bridge_pairing: 3,
  product_barcode: 2,
  unknown: 1
};

function parseBridgePairingUri(
  trimmed: string
): { serverOrigin: string; sessionId: string | null } | null {
  const match = BRIDGE_URI_RE.exec(trimmed);
  if (!match) {
    return null;
  }

  const params = new URLSearchParams(match[1]);
  const allServers = params.getAll("server");
  if (allServers.length !== 1) {
    return null;
  }

  const candidateOrigin = normalizeServerOrigin(allServers[0]);
  if (!HTTP_ORIGIN_PREFIX_RE.test(candidateOrigin)) {
    return null;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(candidateOrigin);
  } catch {
    return null;
  }

  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    !parsedOrigin.hostname ||
    parsedOrigin.username !== "" ||
    parsedOrigin.password !== "" ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search !== "" ||
    parsedOrigin.hash !== ""
  ) {
    return null;
  }

  const allSessions = params.getAll("session");
  if (allSessions.length > 1) {
    return null;
  }

  let sessionId: string | null = null;
  if (allSessions.length === 1) {
    const candidateSession = allSessions[0].trim();
    if (!BRIDGE_SESSION_RE.test(candidateSession)) {
      return null;
    }
    sessionId = candidateSession;
  }

  return {
    serverOrigin: normalizeServerOrigin(parsedOrigin.origin),
    sessionId
  };
}

export function classifyScannedCode(rawInput: string): ScannedCodeClassification {
  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!trimmed) {
    return { kind: "unknown", raw: "" };
  }

  const bridge = parseBridgePairingUri(trimmed);
  if (bridge !== null) {
    return {
      kind: "bridge_pairing",
      raw: trimmed,
      serverOrigin: bridge.serverOrigin,
      sessionId: bridge.sessionId
    };
  }

  const pharmacyPayload = parsePharmacyQrUri(trimmed);
  if (pharmacyPayload !== null) {
    return {
      kind: "pharmacy_rx",
      raw: trimmed,
      payload: pharmacyPayload
    };
  }

  if (RETAIL_BARCODE_RAW_RE.test(trimmed)) {
    const normalizedDigits = normalizeBarcode(trimmed);
    if (NORMALIZED_RETAIL_DIGITS_RE.test(normalizedDigits)) {
      return {
        kind: "product_barcode",
        raw: trimmed,
        normalizedDigits
      };
    }
  }

  return {
    kind: "unknown",
    raw: trimmed
  };
}

async function createGlobalBarcodeDetector(): Promise<RawBarcodeDetector | null> {
  const maybeCtor = (globalThis as Record<string, unknown>).BarcodeDetector;
  if (typeof maybeCtor !== "function") {
    return null;
  }
  const DetectorCtor = maybeCtor as GlobalBarcodeDetectorCtor;
  try {
    return new DetectorCtor({ formats: [...SCANNER_FORMATS] });
  } catch {
    if (typeof DetectorCtor.getSupportedFormats !== "function") {
      return null;
    }
    try {
      const supported = await DetectorCtor.getSupportedFormats();
      const filtered = SCANNER_FORMATS.filter((fmt) => supported.includes(fmt));
      if (filtered.length === 0) {
        return null;
      }
      return new DetectorCtor({ formats: filtered });
    } catch {
      return null;
    }
  }
}

export async function detectAndClassifyFromSource(
  source: unknown,
  detectorFactory?: () => Promise<RawBarcodeDetector | null> | RawBarcodeDetector | null
): Promise<ScannedCodeClassification | null> {
  if (source === null || source === undefined) {
    return null;
  }

  let detector: RawBarcodeDetector | null;
  try {
    detector =
      detectorFactory !== undefined
        ? await detectorFactory()
        : await createGlobalBarcodeDetector();
  } catch {
    return null;
  }

  if (!detector || typeof detector.detect !== "function") {
    return null;
  }

  let detections: Array<RawDetectedBarcode>;
  try {
    detections = await detector.detect(source);
  } catch {
    return null;
  }

  if (!Array.isArray(detections) || detections.length === 0) {
    return null;
  }

  let bestHit: ScannedCodeClassification | null = null;
  let bestPriority = 0;

  for (const item of detections) {
    const rawValue = typeof item?.rawValue === "string" ? item.rawValue.trim() : "";
    if (!rawValue) {
      continue;
    }
    const classified = classifyScannedCode(rawValue);
    const priority = CLASSIFICATION_PRIORITY[classified.kind];
    if (priority > bestPriority) {
      bestPriority = priority;
      bestHit = classified;
      if (bestPriority === CLASSIFICATION_PRIORITY.pharmacy_rx) {
        break;
      }
    }
  }

  return bestHit;
}
