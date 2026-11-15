import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOUBLE_SLASH = "/".repeat(2);
const HTTPS_PREFIX = `https:${DOUBLE_SLASH}`;
const BRIDGE_CONNECT_BASE = `holdupbridge:${DOUBLE_SLASH}connect`;
const GLASSES_DEEP_LINK_BASE = `fb-viewapp:${DOUBLE_SLASH}web_app_deep_link`;

export interface PairingLinksInput {
  base: string;
  key?: string;
  session?: string;
}

export interface PairingUrlSet {
  pwaUrl: string;
  hudUrl: string;
  bridgeDeepLink: string;
  glassesDeepLink: string;
}

export interface PairingLinks extends PairingUrlSet {
  redacted: PairingUrlSet;
}

export interface PreflightCheck {
  name: "health" | "manifest" | "stats";
  path: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  base: string;
  checks: PreflightCheck[];
}

interface VersionSpec {
  ecPerBlock: number;
  dataBlocks: readonly number[];
  alignmentCenters: readonly number[];
}

const VERSION_SPECS: Record<number, VersionSpec> = {
  1: { ecPerBlock: 7, dataBlocks: [19], alignmentCenters: [] },
  2: { ecPerBlock: 10, dataBlocks: [34], alignmentCenters: [6, 18] },
  3: { ecPerBlock: 15, dataBlocks: [55], alignmentCenters: [6, 22] },
  4: { ecPerBlock: 20, dataBlocks: [80], alignmentCenters: [6, 26] },
  5: { ecPerBlock: 26, dataBlocks: [108], alignmentCenters: [6, 30] },
  6: { ecPerBlock: 18, dataBlocks: [68, 68], alignmentCenters: [6, 34] },
  7: { ecPerBlock: 20, dataBlocks: [78, 78], alignmentCenters: [6, 22, 38] },
  8: { ecPerBlock: 24, dataBlocks: [97, 97], alignmentCenters: [6, 24, 42] },
  9: { ecPerBlock: 30, dataBlocks: [116, 116], alignmentCenters: [6, 26, 46] },
  10: { ecPerBlock: 18, dataBlocks: [68, 68, 69, 69], alignmentCenters: [6, 28, 50] },
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function rsGeneratorPoly(degree: number): Uint8Array {
  if (!Number.isInteger(degree) || degree < 1 || degree > 255) {
    throw new RangeError(`Invalid Reed-Solomon degree: ${degree}`);
  }
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function strictUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function redactSecret(text: string, key?: string): string {
  if (!key || key.length === 0) return text;
  const enc1 = encodeURIComponent(key);
  const enc2 = encodeURIComponent(enc1);
  const strict1 = strictUriEncode(key);
  const strict2 = strictUriEncode(strict1);
  const form1 = enc1.replace(/%20/g, "+");
  const form2 = encodeURIComponent(form1);
  const variants = Array.from(
    new Set([enc2, strict2, form2, enc1, strict1, form1, key].filter((v) => v.length > 0)),
  ).sort((a, b) => b.length - a.length);
  if (variants.length === 0) return text;
  const pattern = new RegExp(variants.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, "[key]");
}

function normalizeBaseInput(rawBase: string, explicitKey?: string): { originBase: string; effectiveKey?: string } {
  let trimmed = (rawBase ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || /^https?:$/i.test(trimmed)) {
    throw new Error("Base tunnel URL is required");
  }
  const anyScheme = new RegExp(`^[a-zA-Z][a-zA-Z0-9+.-]*:${DOUBLE_SLASH}`).test(trimmed);
  if (!anyScheme) {
    trimmed = `${HTTPS_PREFIX}${trimmed}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid base tunnel URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const originBase = `${parsed.protocol}${DOUBLE_SLASH}${parsed.host}${cleanPath}`;
  const queryKey = parsed.searchParams.get("key") ?? undefined;
  const effectiveKey =
    explicitKey !== undefined
      ? explicitKey.length > 0
        ? explicitKey
        : undefined
      : queryKey && queryKey.length > 0
        ? queryKey
        : undefined;
  return { originBase, effectiveKey };
}

export function buildPairingLinks(opts: PairingLinksInput): PairingLinks {
  const { originBase, effectiveKey } = normalizeBaseInput(opts.base, opts.key);
  const session = opts.session?.trim() ? opts.session.trim() : undefined;

  const queryParts: string[] = [];
  if (effectiveKey) queryParts.push(`key=${encodeURIComponent(effectiveKey)}`);
  if (session) queryParts.push(`session=${encodeURIComponent(session)}`);
  const querySuffix = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

  const pwaUrl = `${originBase}/${querySuffix}`;
  const hudUrl = `${originBase}/hud/${querySuffix}`;
  const serverWithKey = effectiveKey
    ? `${originBase}/?key=${encodeURIComponent(effectiveKey)}`
    : originBase;
  const bridgeDeepLink =
    `${BRIDGE_CONNECT_BASE}?server=${encodeURIComponent(serverWithKey)}` +
    (session ? `&session=${encodeURIComponent(session)}` : "");
  const glassesDeepLink = `${GLASSES_DEEP_LINK_BASE}?appName=HoldUp&appUrl=${encodeURIComponent(hudUrl)}`;

  const redactedQueryParts: string[] = [];
  if (effectiveKey) redactedQueryParts.push("key=[key]");
  if (session) redactedQueryParts.push(`session=${encodeURIComponent(session)}`);
  const redactedQuerySuffix = redactedQueryParts.length > 0 ? `?${redactedQueryParts.join("&")}` : "";

  const rawRedactedPwa = `${originBase}/${redactedQuerySuffix}`;
  const rawRedactedHud = `${originBase}/hud/${redactedQuerySuffix}`;
  const rawRedactedBridge = effectiveKey
    ? `${BRIDGE_CONNECT_BASE}?server=${encodeURIComponent(`${originBase}/?key=`)}[key]` +
      (session ? `&session=${encodeURIComponent(session)}` : "")
    : bridgeDeepLink;
  const rawRedactedGlasses = effectiveKey
    ? `${GLASSES_DEEP_LINK_BASE}?appName=HoldUp&appUrl=${encodeURIComponent(`${originBase}/hud/?key=`)}[key]` +
      (session ? encodeURIComponent(`&session=${encodeURIComponent(session)}`) : "")
    : glassesDeepLink;

  return {
    pwaUrl,
    hudUrl,
    bridgeDeepLink,
    glassesDeepLink,
    redacted: {
      pwaUrl: redactSecret(rawRedactedPwa, effectiveKey),
      hudUrl: redactSecret(rawRedactedHud, effectiveKey),
      bridgeDeepLink: redactSecret(rawRedactedBridge, effectiveKey),
      glassesDeepLink: redactSecret(rawRedactedGlasses, effectiveKey),
    },
  };
}

function appendBits(target: number[], value: number, bitLength: number): void {
  for (let i = bitLength - 1; i >= 0; i--) {
    target.push((value >>> i) & 1);
  }
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const spec = VERSION_SPECS[v];
    const totalDataCodewords = spec.dataBlocks.reduce((sum, n) => sum + n, 0);
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= totalDataCodewords * 8) {
      return v;
    }
  }
  throw new RangeError(`QR payload too long: ${byteLength} bytes (max 271 bytes for Version 10 ECC-L)`);
}

function buildDataAndEcBits(payload: Uint8Array, version: number): boolean[] {
  const spec = VERSION_SPECS[version];
  const totalDataCodewords = spec.dataBlocks.reduce((sum, n) => sum + n, 0);
  const capacityBits = totalDataCodewords * 8;
  const countBits = version <= 9 ? 8 : 16;

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, payload.length, countBits);
  for (let i = 0; i < payload.length; i++) {
    appendBits(bits, payload[i], 8);
  }

  const terminatorLen = Math.min(4, capacityBits - bits.length);
  appendBits(bits, 0, terminatorLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataCodewords = new Uint8Array(totalDataCodewords);
  const filledBytes = bits.length / 8;
  for (let i = 0; i < filledBytes; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    dataCodewords[i] = b;
  }
  for (let i = filledBytes; i < totalDataCodewords; i++) {
    dataCodewords[i] = (i - filledBytes) % 2 === 0 ? 0xec : 0x11;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const blockLen of spec.dataBlocks) {
    const block = dataCodewords.subarray(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(...spec.dataBlocks);
  for (let col = 0; col < maxDataLen; col++) {
    for (const block of dataBlocks) {
      if (col < block.length) {
        interleaved.push(block[col]);
      }
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col++) {
    for (const ec of ecBlocks) {
      interleaved.push(ec[col]);
    }
  }

  const outBits: boolean[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i--) {
      outBits.push(((byte >>> i) & 1) === 1);
    }
  }
  return outBits;
}

function computeFormatBits(mask: number): number {
  const data5 = (0b01 << 3) | (mask & 0b111);
  let rem = data5 << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data5 << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function writeFormatBits(matrix: boolean[][], mask: number): void {
  const size = matrix.length;
  const bits = computeFormatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) matrix[i][8] = bit(i);
  matrix[7][8] = bit(6);
  matrix[8][8] = bit(7);
  matrix[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) matrix[8][14 - i] = bit(i);

  for (let i = 0; i <= 7; i++) matrix[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) matrix[size - 15 + i][8] = bit(i);
  matrix[size - 8][8] = true;
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function lineRunAndFinderPenalty(line: boolean[]): number {
  let score = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === runColor) {
      runLen++;
    } else {
      if (runLen >= 5) score += runLen - 2;
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) score += runLen - 2;

  const padded = [false, false, false, false, ...line, false, false, false, false];
  for (let i = 0; i <= padded.length - 11; i++) {
    let windowBits = 0;
    for (let j = 0; j < 11; j++) {
      windowBits = (windowBits << 1) | (padded[i + j] ? 1 : 0);
    }
    if (windowBits === 0b00001011101 || windowBits === 0b10111010000) {
      score += 40;
    }
  }
  return score;
}

function computePenalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let penalty = 0;

  for (let r = 0; r < size; r++) {
    penalty += lineRunAndFinderPenalty(matrix[r]);
  }
  for (let c = 0; c < size; c++) {
    const col: boolean[] = new Array(size);
    for (let r = 0; r < size; r++) col[r] = matrix[r][c];
    penalty += lineRunAndFinderPenalty(col);
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) darkCount++;
    }
  }
  const total = size * size;
  const k = Math.max(0, Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1);
  penalty += k * 10;

  return penalty;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const payload = Buffer.from(text, "utf8");
  const version = chooseVersion(payload.length);
  const size = 17 + 4 * version;
  const spec = VERSION_SPECS[version];

  const matrix: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunction = (r: number, c: number, dark: boolean) => {
    matrix[r][c] = dark;
    isFunction[r][c] = true;
  };

  for (let i = 8; i <= size - 9; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  const finderOrigins: Array<[number, number]> = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [topR, leftC] of finderOrigins) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r >= 0 && r < size && c >= 0 && c < size) {
          const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          setFunction(r, c, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  const centers = spec.alignmentCenters;
  for (const cr of centers) {
    for (const cc of centers) {
      const overlapsFinder =
        (cr === 6 && cc === 6) ||
        (cr === 6 && cc === size - 7) ||
        (cr === size - 7 && cc === 6);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunction(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunction(8, size - 1 - i, false);
    setFunction(size - 1 - i, 8, false);
  }
  setFunction(size - 8, 8, true);

  if (version >= 7) {
    const versionBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((versionBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  const dataBits = buildDataAndEcBits(payload, version);
  let bitIdx = 0;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const col = rightCol - dc;
        if (!isFunction[row][col]) {
          matrix[row][col] = bitIdx < dataBits.length ? dataBits[bitIdx] : false;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestMatrix: boolean[][] = matrix;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = matrix.map((row, r) =>
      row.map((val, c) => (!isFunction[r][c] && maskCondition(mask, r, c) ? !val : val)),
    );
    writeFormatBits(candidate, mask);
    const penalty = computePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  writeFormatBits(bestMatrix, bestMask);
  return bestMatrix;
}

export function renderQrUnicode(matrix: boolean[][]): string {
  const n = matrix.length;
  if (n === 0 || matrix.some((row) => row.length !== n)) {
    throw new Error("QR matrix must be a non-empty square boolean[][]");
  }
  const quiet = 2;
  const total = n + quiet * 2;
  const cell = (r: number, c: number): boolean => {
    const mr = r - quiet;
    const mc = c - quiet;
    if (mr < 0 || mr >= n || mc < 0 || mc >= n) return false;
    return Boolean(matrix[mr][mc]);
  };

  const lines: string[] = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const top = cell(r, c);
      const bottom = r + 1 < total ? cell(r + 1, c) : false;
      if (top && bottom) line += "\u2588";
      else if (top && !bottom) line += "\u2580";
      else if (!top && bottom) line += "\u2584";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function sanitizeErrorText(raw: string, key?: string): string {
  const noQuery = raw.replace(/\?[^\s"')]+/g, "");
  return redactSecret(noQuery, key);
}

async function fetchJsonCheck(
  url: string,
  displayPath: string,
  name: PreflightCheck["name"],
  validate: (body: Record<string, unknown>) => { ok: boolean; detail: string },
  key?: string,
): Promise<PreflightCheck> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (res.status !== 200) {
      return {
        name,
        path: displayPath,
        ok: false,
        status: res.status,
        detail: `HTTP ${res.status}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        name,
        path: displayPath,
        ok: false,
        status: res.status,
        detail: "HTTP 200 but invalid JSON body",
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        name,
        path: displayPath,
        ok: false,
        status: res.status,
        detail: "HTTP 200 but expected JSON object",
      };
    }
    const check = validate(parsed as Record<string, unknown>);
    return {
      name,
      path: displayPath,
      ok: check.ok,
      status: res.status,
      detail: redactSecret(check.detail, key),
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      name,
      path: displayPath,
      ok: false,
      status: null,
      detail: `network error: ${sanitizeErrorText(rawMsg, key)}`,
    };
  }
}

export async function runPreflight(base: string, key?: string): Promise<PreflightResult> {
  const { originBase, effectiveKey } = normalizeBaseInput(base, key);

  const healthCheck = await fetchJsonCheck(
    `${originBase}/api/health`,
    "/api/health",
    "health",
    (body) => {
      if (body.ok === false) {
        return { ok: false, detail: "health reported ok=false" };
      }
      const gemini = typeof body.gemini === "string" ? body.gemini : "unknown";
      return { ok: true, detail: `HTTP 200 (gemini=${gemini})` };
    },
    effectiveKey,
  );

  const manifestPath = "/hud/.well-known/meta-wearables-manifest.json";
  const manifestCheck = await fetchJsonCheck(
    `${originBase}${manifestPath}`,
    manifestPath,
    "manifest",
    (body) => {
      if (body.name !== "HoldUp") {
        return {
          ok: false,
          detail: `expected manifest name "HoldUp", got ${JSON.stringify(body.name ?? null)}`,
        };
      }
      return { ok: true, detail: 'HTTP 200 (name="HoldUp")' };
    },
    effectiveKey,
  );

  const statsUrl = effectiveKey
    ? `${originBase}/api/stats?key=${encodeURIComponent(effectiveKey)}`
    : `${originBase}/api/stats`;
  const statsDisplayPath = effectiveKey ? "/api/stats?key=[key]" : "/api/stats";
  const statsCheck = await fetchJsonCheck(
    statsUrl,
    statsDisplayPath,
    "stats",
    (body) => {
      const total = typeof body.total === "number" ? body.total : 0;
      return { ok: true, detail: `HTTP 200 (total=${total})` };
    },
    effectiveKey,
  );

  const checks = [healthCheck, manifestCheck, statsCheck];
  return {
    ok: checks.every((c) => c.ok),
    base: redactSecret(originBase, effectiveKey),
    checks,
  };
}

interface CliOptions {
  base: string;
  session?: string;
  check: boolean;
  noQr: boolean;
  showKey: boolean;
  help: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  let base = process.env.TUNNEL ?? "";
  let session: string | undefined;
  let check = false;
  let noQr = false;
  let showKey = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      help = true;
    } else if (tok === "--check") {
      check = true;
    } else if (tok === "--no-qr") {
      noQr = true;
    } else if (tok === "--show-key") {
      showKey = true;
    } else if (tok === "--base") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--base requires a URL value");
      }
      base = next;
      i++;
    } else if (tok.startsWith("--base=")) {
      base = tok.slice("--base=".length);
    } else if (tok === "--session") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--session requires a session code value");
      }
      session = next;
      i++;
    } else if (tok.startsWith("--session=")) {
      session = tok.slice("--session=".length);
    } else {
      throw new Error(`Unknown flag: ${tok}`);
    }
  }

  return { base, session, check, noQr, showKey, help };
}

function usageText(): string {
  return [
    "Usage: npx tsx server/scripts/pair-qr.ts --base <tunnel-url> [--session <code>] [--check] [--no-qr] [--show-key]",
    "Reads HOLDUP_KEY from the environment and redacts it in text output unless --show-key is passed.",
  ].join("\n");
}

async function runCli(argv: string[]): Promise<number> {
  const key = process.env.HOLDUP_KEY || undefined;
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(redactSecret(msg, key));
    console.error(usageText());
    return 2;
  }

  if (opts.help) {
    console.log(usageText());
    return 0;
  }

  if (!opts.base.trim()) {
    console.error("Missing --base <tunnel-url> (or TUNNEL env var)");
    console.error(usageText());
    return 2;
  }

  let links: PairingLinks;
  try {
    links = buildPairingLinks({ base: opts.base, key, session: opts.session });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(sanitizeErrorText(msg, key));
    return 2;
  }

  const shown = opts.showKey ? links : links.redacted;
  console.log(`Phone PWA:       ${shown.pwaUrl}`);
  console.log(`HUD Web App:     ${shown.hudUrl}`);
  console.log(`HoldUp Bridge:   ${shown.bridgeDeepLink}`);
  console.log(`Glasses Display: ${shown.glassesDeepLink}`);

  if (!opts.noQr) {
    const qrTargets: Array<[string, string]> = [
      ["Phone PWA QR", links.pwaUrl],
      ["HoldUp Bridge QR (holdupbridge)", links.bridgeDeepLink],
      ["Ray-Ban Display QR (fb-viewapp)", links.glassesDeepLink],
    ];
    for (const [title, targetUrl] of qrTargets) {
      console.log(`\n[${title}]`);
      console.log(renderQrUnicode(encodeQrMatrix(targetUrl)));
    }
  }

  if (opts.check) {
    const preflight = await runPreflight(opts.base, key);
    console.log("\nPreflight checks:");
    for (const item of preflight.checks) {
      const tag = item.ok ? "PASS" : "FAIL";
      console.log(`  [${tag}] ${item.name} (${item.path}): ${item.detail}`);
    }
    if (!preflight.ok) {
      console.error("Preflight failed: one or more endpoints did not pass.");
      return 1;
    }
  }

  return 0;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const invoked = fs.realpathSync.native(path.resolve(process.argv[1]));
    const current = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return invoked === current;
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const key = process.env.HOLDUP_KEY || undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(sanitizeErrorText(msg, key));
      process.exitCode = 1;
    });
}
