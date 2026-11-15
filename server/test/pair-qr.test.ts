import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import express from "express";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { getHub, getOrCreateHub, markLatest } from "../src/hub.ts";
import { createApp } from "../src/index.ts";
import {
  buildPairingLinks,
  encodeQrMatrix,
  redactSecret,
  renderQrUnicode,
  rsEncode,
  rsGeneratorPoly,
  runPreflight,
} from "../scripts/pair-qr.ts";

const DOUBLE_SLASH = "/".repeat(2);
const HTTP_PREFIX = `http:${DOUBLE_SLASH}`;
const HTTPS_PREFIX = `https:${DOUBLE_SLASH}`;
const BRIDGE_SCHEME_PREFIX = `holdupbridge:${DOUBLE_SLASH}connect`;
const GLASSES_SCHEME_PREFIX = `fb-viewapp:${DOUBLE_SLASH}web_app_deep_link`;
const PAIR_QR_SCRIPT = path.join(SERVER_DIR, "scripts", "pair-qr.ts");

const LIVE_HOLDUP_KEY = "hup0630_S3cr3t+Key/Slash&Amp=Eq#Hash%Pct!(2026)";
const WRONG_HOLDUP_KEY = "wrong0630_Attacker+Key/99&bad=1";

const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;

const ledgerTmpDir = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-pair-qr-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");

let liveServer: http.Server;
let liveBaseUrl = "";
const trackedHubs = new Set<string>();

let zxingReady: Promise<typeof import("zxing-wasm/reader")> | undefined;
function getZxingReader() {
  zxingReady ??= (async () => {
    const mod = await import("zxing-wasm/reader");
    const require = createRequire(import.meta.url);
    const wasm = fs.readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    mod.prepareZXingModule({
      overrides: {
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
      },
      fireImmediately: true,
    });
    return mod;
  })();
  return zxingReady;
}

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function normalizeServerMirror(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return s;
  if (!s.startsWith(HTTP_PREFIX) && !s.startsWith(HTTPS_PREFIX)) {
    s = `${HTTPS_PREFIX}${s}`;
  }
  return s;
}

function kotlinJavaUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function uploaderEndpointMirror(serverInput: string, routePath: string, session: string): string {
  const raw = serverInput.trim();
  const q = raw.indexOf("?");
  const host = q >= 0 ? raw.slice(0, q) : raw;
  const params: string[] = [];
  if (q >= 0) {
    for (const part of raw.slice(q + 1).split("&")) {
      if (part.trim().length > 0) params.push(part);
    }
  }
  const s = session.trim();
  if (s.length > 0) params.push(`session=${kotlinJavaUrlEncode(s)}`);
  const base = normalizeServerMirror(host) + routePath;
  return params.length === 0 ? base : `${base}?${params.join("&")}`;
}

function assertZeroKeyLeak(haystack: string, secret: string, label: string) {
  const enc1 = encodeURIComponent(secret);
  const enc2 = encodeURIComponent(enc1);
  const form1 = enc1.replace(/%20/g, "+");
  const form2 = encodeURIComponent(form1);
  const strict1 = enc1.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const strict2 = strict1.replace(/%/g, "%25");
  const candidates = new Set([secret, enc1, enc2, form1, form2, strict1, strict2]);
  if (secret.includes("_")) {
    const prefix = secret.split("_")[0];
    if (prefix.length >= 5) candidates.add(prefix);
  }
  for (const needle of candidates) {
    assert.equal(
      haystack.includes(needle),
      false,
      `leaked secret form "${needle}" inside ${label}`,
    );
  }
}

function unpackUnicodeQr(rendered: string): { padded: boolean[][]; inner: boolean[][] } {
  const lines = rendered.split("\n");
  assert.ok(lines.length >= 13, `unexpected QR line count ${lines.length}`);
  const width = lines[0].length;
  assert.ok(width >= 25 && width % 2 === 1, `expected odd padded width >= 25, got ${width}`);
  for (const line of lines) {
    assert.equal(line.length, width, "all rendered QR lines must have identical width");
    for (const ch of line) {
      assert.ok(
        ch === " " || ch === "\u2580" || ch === "\u2584" || ch === "\u2588",
        `unexpected character U+${ch.charCodeAt(0).toString(16)}`,
      );
    }
  }

  const expectedLineCount = Math.ceil(width / 2);
  assert.equal(lines.length, expectedLineCount);

  const rows: boolean[][] = [];
  for (const line of lines) {
    const topRow: boolean[] = [];
    const bottomRow: boolean[] = [];
    for (const ch of line) {
      topRow.push(ch === "\u2580" || ch === "\u2588");
      bottomRow.push(ch === "\u2584" || ch === "\u2588");
    }
    rows.push(topRow);
    if (rows.length < width) rows.push(bottomRow);
  }

  assert.equal(rows.length, width);
  for (let r = 0; r < width; r++) {
    for (let c = 0; c < width; c++) {
      if (r < 2 || r >= width - 2 || c < 2 || c >= width - 2) {
        assert.equal(rows[r][c], false, `quiet zone must be light at (${r},${c})`);
      }
    }
  }

  const innerSize = width - 4;
  const inner = Array.from({ length: innerSize }, (_, r) =>
    Array.from({ length: innerSize }, (__, c) => rows[r + 2][c + 2]),
  );
  return { padded: rows, inner };
}

async function decodeQrWithZxing(matrix: boolean[][]): Promise<{ text: string; ecLevel: string }> {
  const { readBarcodes } = await getZxingReader();
  const quiet = 4;
  const scale = 6;
  const modules = matrix.length + quiet * 2;
  const dim = modules * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4);
  rgba.fill(255);

  for (let mr = 0; mr < matrix.length; mr++) {
    for (let mc = 0; mc < matrix.length; mc++) {
      if (!matrix[mr][mc]) continue;
      const y0 = (mr + quiet) * scale;
      const x0 = (mc + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((y0 + dy) * dim + (x0 + dx)) * 4;
          rgba[idx] = 0;
          rgba[idx + 1] = 0;
          rgba[idx + 2] = 0;
          rgba[idx + 3] = 255;
        }
      }
    }
  }

  const results = await readBarcodes(
    { data: rgba, width: dim, height: dim },
    { formats: ["QRCode"], tryHarder: true, tryRotate: false, tryInvert: false, maxNumberOfSymbols: 1 },
  );
  assert.equal(results.length, 1, `expected ZXing to decode 1 QR symbol, got ${results.length}`);
  assert.equal(results[0].isValid, true);
  return { text: results[0].text, ecLevel: results[0].ecLevel };
}

function runPairQrCli(
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, HOLDUP_KEY: "", TUNNEL: "", ...envOverrides };
    execFile(
      process.execPath,
      ["--import", "tsx", PAIR_QR_SCRIPT, ...args],
      {
        cwd: REPO_ROOT,
        env: mergedEnv,
        timeout: 15_000,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const rawCode = (err as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  process.env.HOLDUP_KEY = LIVE_HOLDUP_KEY;

  const hostApp = express();
  hostApp.use(express.static(path.join(REPO_ROOT, "web", "public"), { dotfiles: "allow" }));
  hostApp.use(createApp());
  liveServer = http.createServer(hostApp);
  await new Promise<void>((resolve) => liveServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = liveServer.address() as AddressInfo;
  liveBaseUrl = `${HTTP_PREFIX}127.0.0.1:${addr.port}`;
});

afterEach(() => {
  process.env.HOLDUP_KEY = LIVE_HOLDUP_KEY;
  for (const id of trackedHubs) {
    const hub = getHub(id);
    if (hub) {
      hub.dropFrames();
      hub.live = undefined;
      hub.device = undefined;
      hub.source = "phone";
    }
  }
});

after(async () => {
  try {
    if (liveServer) {
      liveServer.closeAllConnections?.();
      await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    }
  } finally {
    restoreHoldupKey();
    env.apiKey = origApiKey;
    env.ledgerPath = origLedgerPath;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    fs.rmSync(ledgerTmpDir, { recursive: true, force: true });
  }
});

test("buildPairingLinks normalizes base URLs, preserves /hud/ trailing slash, encodes special chars, and matches HARDWARE_NOTES Display format", () => {
  const keyless = buildPairingLinks({ base: `  momin-0630.trycloudflare.com${"/".repeat(3)}  ` });
  assert.equal(keyless.pwaUrl, `${HTTPS_PREFIX}momin-0630.trycloudflare.com/`);
  assert.equal(keyless.hudUrl, `${HTTPS_PREFIX}momin-0630.trycloudflare.com/hud/`);
  assert.equal(
    keyless.bridgeDeepLink,
    `${BRIDGE_SCHEME_PREFIX}?server=${encodeURIComponent(`${HTTPS_PREFIX}momin-0630.trycloudflare.com`)}`,
  );
  assert.equal(
    keyless.glassesDeepLink,
    `${GLASSES_SCHEME_PREFIX}?appName=HoldUp&appUrl=${encodeURIComponent(`${HTTPS_PREFIX}momin-0630.trycloudflare.com/hud/`)}`,
  );
  assert.deepEqual(keyless.redacted, {
    pwaUrl: keyless.pwaUrl,
    hudUrl: keyless.hudUrl,
    bridgeDeepLink: keyless.bridgeDeepLink,
    glassesDeepLink: keyless.glassesDeepLink,
  });

  const sessionOnly = buildPairingLinks({
    base: `${HTTPS_PREFIX}momin-0630.trycloudflare.com/`,
    session: "  iltalaake äöå/5  ",
  });
  assert.equal(
    sessionOnly.pwaUrl,
    `${HTTPS_PREFIX}momin-0630.trycloudflare.com/?session=${encodeURIComponent("iltalaake äöå/5")}`,
  );
  assert.equal(
    sessionOnly.hudUrl,
    `${HTTPS_PREFIX}momin-0630.trycloudflare.com/hud/?session=${encodeURIComponent("iltalaake äöå/5")}`,
  );
  assert.ok(new URL(sessionOnly.hudUrl).pathname.endsWith("/hud/"));

  const full = buildPairingLinks({
    base: "momin-0630.trycloudflare.com/",
    key: LIVE_HOLDUP_KEY,
    session: "H4-match",
  });
  const pwaParsed = new URL(full.pwaUrl);
  assert.equal(pwaParsed.pathname, "/");
  assert.equal(pwaParsed.searchParams.get("key"), LIVE_HOLDUP_KEY);
  assert.equal(pwaParsed.searchParams.get("session"), "H4-match");

  const hudParsed = new URL(full.hudUrl);
  assert.equal(hudParsed.pathname, "/hud/");
  assert.equal(hudParsed.searchParams.get("key"), LIVE_HOLDUP_KEY);
  assert.equal(hudParsed.searchParams.get("session"), "H4-match");

  const glassesParsed = new URL(full.glassesDeepLink);
  assert.equal(`${glassesParsed.protocol}${DOUBLE_SLASH}${glassesParsed.host}${glassesParsed.pathname}`, GLASSES_SCHEME_PREFIX);
  assert.equal(glassesParsed.searchParams.get("appName"), "HoldUp");
  assert.equal(glassesParsed.searchParams.get("appUrl"), full.hudUrl);
  assert.ok((glassesParsed.searchParams.get("appUrl") ?? "").includes("/hud/?key="));

  assert.throws(() => buildPairingLinks({ base: "   " }), /Base tunnel URL is required/);
  assert.throws(() => buildPairingLinks({ base: `ftp:${DOUBLE_SLASH}bad.example` }), /Unsupported protocol|Invalid/);
});

test("buildPairingLinks achieves 100% zero-leak redaction across raw, single-encoded, and double-encoded HOLDUP_KEY strings", () => {
  const trickyKeys = [
    LIVE_HOLDUP_KEY,
    "secr3t key+plus/slash&amp=eq#hash%pct",
    "nordic_avain_äöå_!*'()~_2026",
    "plainAlphaNumericSecretKey987654321",
  ];

  for (const secret of trickyKeys) {
    const links = buildPairingLinks({
      base: "demo-shoot.trycloudflare.com/",
      key: secret,
      session: "SESS-0630",
    });

    assert.ok(links.pwaUrl.includes(encodeURIComponent(secret)));
    assert.ok(links.hudUrl.includes(encodeURIComponent(secret)));
    assert.ok(links.bridgeDeepLink.includes(encodeURIComponent(encodeURIComponent(secret))));
    assert.ok(links.glassesDeepLink.includes(encodeURIComponent(encodeURIComponent(secret))));

    for (const [field, val] of Object.entries(links.redacted)) {
      assert.ok(val.includes("[key]"), `expected [key] placeholder in redacted.${field}`);
      assertZeroKeyLeak(val, secret, `redacted.${field}`);
    }

    assert.equal(
      links.redacted.pwaUrl,
      `${HTTPS_PREFIX}demo-shoot.trycloudflare.com/?key=[key]&session=SESS-0630`,
    );
    assert.equal(
      links.redacted.hudUrl,
      `${HTTPS_PREFIX}demo-shoot.trycloudflare.com/hud/?key=[key]&session=SESS-0630`,
    );

    const composite = `${links.pwaUrl} | ${links.bridgeDeepLink} | ${links.glassesDeepLink}`;
    assertZeroKeyLeak(redactSecret(composite, secret), secret, "redactSecret composite");
  }
});

test("bridgeDeepLink round-trips cleanly through android-dat BridgeViewModel + Uploader.endpoint and authenticates ingest routes", async () => {
  const sessionCode = "dat-pair-0630";
  const hub = getOrCreateHub(sessionCode);
  trackedHubs.add(sessionCode);
  hub.source = "glasses";
  markLatest(hub);

  const links = buildPairingLinks({
    base: `${liveBaseUrl}/`,
    key: LIVE_HOLDUP_KEY,
    session: sessionCode,
  });

  assert.ok(links.bridgeDeepLink.startsWith(`${BRIDGE_SCHEME_PREFIX}?`));
  const deepUri = new URL(links.bridgeDeepLink);
  const extractedServer = deepUri.searchParams.get("server") ?? "";
  const extractedSession = deepUri.searchParams.get("session") ?? "";

  assert.equal(extractedSession, sessionCode);
  assert.equal(extractedServer, `${liveBaseUrl}/?key=${encodeURIComponent(LIVE_HOLDUP_KEY)}`);

  const resolvedServer = normalizeServerMirror(extractedServer);
  const stateEndpoint = uploaderEndpointMirror(resolvedServer, "/ingest/state", extractedSession);
  const frameEndpoint = uploaderEndpointMirror(resolvedServer, "/ingest/frame", extractedSession);

  const parsedStateUrl = new URL(stateEndpoint);
  assert.equal(parsedStateUrl.pathname, "/ingest/state");
  assert.equal(parsedStateUrl.searchParams.get("key"), LIVE_HOLDUP_KEY);
  assert.equal(parsedStateUrl.searchParams.get("session"), sessionCode);

  const stateRes = await fetch(stateEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 88, streaming: true }),
  });
  assert.equal(stateRes.status, 204);
  assert.equal(hub.device?.battery, 88);
  assert.equal(hub.device?.worn, true);

  const jpeg = new Uint8Array(180).fill(0x42);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;

  const frameRes = await fetch(frameEndpoint, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: jpeg,
  });
  assert.equal(frameRes.status, 204);
  assert.equal(hub.ring.length, 1);
});

test("GF(256) Reed-Solomon generator polynomial roots and syndrome parity hold across all QR V1..V10 ECC-L degrees", () => {
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

  const evalPoly = (coeffs: Uint8Array, root: number): number => {
    let acc = 0;
    for (const c of coeffs) {
      acc = mul(acc, root) ^ c;
    }
    return acc;
  };

  const degrees = [7, 10, 15, 18, 20, 24, 26, 30];
  for (const deg of degrees) {
    const gen = rsGeneratorPoly(deg);
    assert.equal(gen.length, deg + 1);
    assert.equal(gen[0], 1);
    for (let r = 0; r < deg; r++) {
      assert.equal(evalPoly(gen, gfExp[r]), 0, `generator poly degree ${deg} must vanish at alpha^${r}`);
    }
    assert.notEqual(evalPoly(gen, gfExp[deg]), 0, `generator poly degree ${deg} must not vanish at alpha^${deg}`);

    const sampleData = Uint8Array.from({ length: 40 }, (_, idx) => (idx * 37 + deg * 13 + 7) & 0xff);
    const ec = rsEncode(sampleData, deg);
    assert.equal(ec.length, deg);
    const codeword = new Uint8Array(sampleData.length + ec.length);
    codeword.set(sampleData, 0);
    codeword.set(ec, sampleData.length);

    for (let r = 0; r < deg; r++) {
      assert.equal(evalPoly(codeword, gfExp[r]), 0, `RS codeword syndrome must be 0 at alpha^${r} (deg=${deg})`);
    }

    const corrupted = new Uint8Array(codeword);
    corrupted[5] ^= 0x5a;
    let nonZeroSyndromes = 0;
    for (let r = 0; r < deg; r++) {
      if (evalPoly(corrupted, gfExp[r]) !== 0) nonZeroSyndromes++;
    }
    assert.ok(nonZeroSyndromes > 0, "single-byte corruption must produce non-zero RS syndrome");
  }
});

test("encodeQrMatrix + renderQrUnicode satisfy ISO/IEC 18004 structure and ZXing decode across all versions 1..10", async () => {
  const versionMaxBytes: Array<{ version: number; length: number }> = [
    { version: 1, length: 17 },
    { version: 2, length: 32 },
    { version: 3, length: 53 },
    { version: 4, length: 78 },
    { version: 5, length: 106 },
    { version: 6, length: 134 },
    { version: 7, length: 154 },
    { version: 8, length: 192 },
    { version: 9, length: 230 },
    { version: 10, length: 271 },
  ];

  const assertFinderAndSeparators = (matrix: boolean[][], topR: number, leftC: number) => {
    const n = matrix.length;
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        const expectedDark = dist !== 2 && dist !== 4;
        assert.equal(
          matrix[r][c],
          expectedDark,
          `finder/separator mismatch at (${r},${c}) for origin (${topR},${leftC})`,
        );
      }
    }
  };

  for (const { version, length } of versionMaxBytes) {
    const payload = Array.from({ length }, (_, i) => String.fromCharCode(48 + (i % 42))).join("");
    const matrix = encodeQrMatrix(payload);
    const expectedSize = 17 + 4 * version;

    assert.equal(matrix.length, expectedSize, `V${version} row count`);
    for (const row of matrix) {
      assert.equal(row.length, expectedSize, `V${version} col count`);
    }

    assertFinderAndSeparators(matrix, 0, 0);
    assertFinderAndSeparators(matrix, 0, expectedSize - 7);
    assertFinderAndSeparators(matrix, expectedSize - 7, 0);

    for (let i = 8; i <= expectedSize - 9; i++) {
      assert.equal(matrix[6][i], i % 2 === 0, `V${version} horizontal timing at (6,${i})`);
      assert.equal(matrix[i][6], i % 2 === 0, `V${version} vertical timing at (${i},6)`);
    }

    assert.equal(matrix[4 * version + 9][8], true, `V${version} dark module at (${4 * version + 9}, 8)`);

    const alignCenters =
      version === 1
        ? []
        : version <= 6
          ? [6, 10 + 4 * version]
          : [6, 8 + 2 * version, 10 + 4 * version];
    for (const cr of alignCenters) {
      for (const cc of alignCenters) {
        const overlapsFinder =
          (cr === 6 && cc === 6) ||
          (cr === 6 && cc === expectedSize - 7) ||
          (cr === expectedSize - 7 && cc === 6);
        if (overlapsFinder) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            assert.equal(
              matrix[cr + dr][cc + dc],
              dist !== 1,
              `V${version} alignment pattern mismatch at (${cr + dr},${cc + dc})`,
            );
          }
        }
      }
    }

    let fmtCopy1 = 0;
    for (let i = 0; i <= 5; i++) if (matrix[i][8]) fmtCopy1 |= 1 << i;
    if (matrix[7][8]) fmtCopy1 |= 1 << 6;
    if (matrix[8][8]) fmtCopy1 |= 1 << 7;
    if (matrix[8][7]) fmtCopy1 |= 1 << 8;
    for (let i = 9; i <= 14; i++) if (matrix[8][14 - i]) fmtCopy1 |= 1 << i;

    let fmtCopy2 = 0;
    for (let i = 0; i <= 7; i++) if (matrix[8][expectedSize - 1 - i]) fmtCopy2 |= 1 << i;
    for (let i = 8; i <= 14; i++) if (matrix[expectedSize - 15 + i][8]) fmtCopy2 |= 1 << i;

    assert.equal(fmtCopy1, fmtCopy2, `V${version} format copies must match`);
    const unmaskedFmt = fmtCopy1 ^ 0x5412;
    assert.equal((unmaskedFmt >>> 13) & 0b11, 0b01, `V${version} format ECC indicator must be L (01)`);

    if (version >= 7) {
      let verBL = 0;
      let verTR = 0;
      for (let i = 0; i < 18; i++) {
        const a = expectedSize - 11 + (i % 3);
        const b = Math.floor(i / 3);
        if (matrix[a][b]) verBL |= 1 << i;
        if (matrix[b][a]) verTR |= 1 << i;
      }
      assert.equal(verBL, verTR, `V${version} version info blocks must be transpose-identical`);
      assert.equal(verBL >>> 12, version, `V${version} version info top 6 bits must equal ${version}`);
    }

    const rendered = renderQrUnicode(matrix);
    const { inner } = unpackUnicodeQr(rendered);
    assert.deepEqual(inner, matrix, `V${version} Unicode half-block rendering must round-trip losslessly`);

    const decoded = await decodeQrWithZxing(inner);
    assert.equal(decoded.text, payload, `ZXing must decode exact V${version} payload`);
    assert.equal(decoded.ecLevel, "L", `ZXing must report ECC-L for V${version}`);
  }

  assert.throws(() => encodeQrMatrix("x".repeat(272)), RangeError);
});

test("encodeQrMatrix + renderQrUnicode are deterministic and ZXing-scannable for real HoldUp Bridge and Ray-Ban Display deep links", async () => {
  const links = buildPairingLinks({
    base: "helsinki-shoot-0630.trycloudflare.com/",
    key: LIVE_HOLDUP_KEY,
    session: "H4-match",
  });

  for (const [name, targetUrl] of [
    ["pwaUrl", links.pwaUrl],
    ["bridgeDeepLink", links.bridgeDeepLink],
    ["glassesDeepLink", links.glassesDeepLink],
  ] as const) {
    const m1 = encodeQrMatrix(targetUrl);
    const m2 = encodeQrMatrix(targetUrl);
    assert.deepEqual(m1, m2, `${name} matrix must be deterministic`);

    const u1 = renderQrUnicode(m1);
    const u2 = renderQrUnicode(m2);
    assert.equal(u1, u2, `${name} Unicode QR must be deterministic`);
    assertZeroKeyLeak(u1, LIVE_HOLDUP_KEY, `${name} rendered Unicode QR`);

    const { inner } = unpackUnicodeQr(u1);
    const decoded = await decodeQrWithZxing(inner);
    assert.equal(decoded.text, targetUrl, `ZXing decode mismatch on ${name}`);
    assert.equal(decoded.ecLevel, "L");
  }
});

test("runPreflight validates health, HoldUp wearables manifest, and stats on live HoldUp server without leaking HOLDUP_KEY", async () => {
  const okResult = await runPreflight(`${liveBaseUrl}/`, LIVE_HOLDUP_KEY);
  assert.equal(okResult.ok, true);
  assert.deepEqual(
    okResult.checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status })),
    [
      { name: "health", ok: true, status: 200 },
      { name: "manifest", ok: true, status: 200 },
      { name: "stats", ok: true, status: 200 },
    ],
  );
  assertZeroKeyLeak(JSON.stringify(okResult), LIVE_HOLDUP_KEY, "runPreflight okResult JSON");

  const wrongKeyResult = await runPreflight(liveBaseUrl, WRONG_HOLDUP_KEY);
  assert.equal(wrongKeyResult.ok, false);
  assert.deepEqual(
    wrongKeyResult.checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status })),
    [
      { name: "health", ok: true, status: 200 },
      { name: "manifest", ok: true, status: 200 },
      { name: "stats", ok: false, status: 401 },
    ],
  );
  assertZeroKeyLeak(JSON.stringify(wrongKeyResult), WRONG_HOLDUP_KEY, "runPreflight wrongKeyResult JSON");
  assertZeroKeyLeak(JSON.stringify(wrongKeyResult), LIVE_HOLDUP_KEY, "runPreflight wrongKeyResult server key");

  const missingKeyResult = await runPreflight(liveBaseUrl);
  assert.equal(missingKeyResult.ok, false);
  assert.equal(missingKeyResult.checks.find((c) => c.name === "stats")?.status, 401);

  const badManifestServer = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, gemini: "ok" }));
    } else if (req.url?.startsWith("/hud/.well-known/meta-wearables-manifest.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 1, name: "WrongApp" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ total: 0 }));
    }
  });
  await new Promise<void>((resolve) => badManifestServer.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = badManifestServer.address() as AddressInfo;
    const badRes = await runPreflight(`${HTTP_PREFIX}127.0.0.1:${addr.port}`, LIVE_HOLDUP_KEY);
    assert.equal(badRes.ok, false);
    const mCheck = badRes.checks.find((c) => c.name === "manifest");
    assert.equal(mCheck?.ok, false);
    assert.match(mCheck?.detail ?? "", /HoldUp/);
    assertZeroKeyLeak(JSON.stringify(badRes), LIVE_HOLDUP_KEY, "badManifest preflight JSON");
  } finally {
    badManifestServer.closeAllConnections?.();
    await new Promise<void>((resolve) => badManifestServer.close(() => resolve()));
  }
});

test("pair-qr CLI subprocess exits 0 on valid HOLDUP_KEY, non-zero on wrong key, and leaks zero key substrings in stdout/stderr", async () => {
  const validRun = await runPairQrCli(
    ["--base", `${liveBaseUrl}/`, "--session", "H4-match", "--check"],
    { HOLDUP_KEY: LIVE_HOLDUP_KEY },
  );
  assert.equal(validRun.code, 0, `expected exit 0, stderr=${validRun.stderr}`);
  assert.equal(validRun.stderr, "");
  assert.ok(validRun.stdout.includes("[PASS] health"));
  assert.ok(validRun.stdout.includes("[PASS] manifest"));
  assert.ok(validRun.stdout.includes("[PASS] stats"));
  assert.ok(validRun.stdout.includes("?key=[key]&session=H4-match"));
  assert.ok(validRun.stdout.includes("/hud/?key=[key]&session=H4-match"));
  assert.ok(validRun.stdout.includes("\u2588"));
  assertZeroKeyLeak(validRun.stdout, LIVE_HOLDUP_KEY, "CLI validRun stdout");
  assertZeroKeyLeak(validRun.stderr, LIVE_HOLDUP_KEY, "CLI validRun stderr");

  const noQrValidRun = await runPairQrCli(
    ["--base", liveBaseUrl, "--check", "--no-qr"],
    { HOLDUP_KEY: LIVE_HOLDUP_KEY },
  );
  assert.equal(noQrValidRun.code, 0);
  assert.equal(noQrValidRun.stdout.includes("\u2588"), false);
  assertZeroKeyLeak(noQrValidRun.stdout, LIVE_HOLDUP_KEY, "CLI noQrValidRun stdout");
  assertZeroKeyLeak(noQrValidRun.stderr, LIVE_HOLDUP_KEY, "CLI noQrValidRun stderr");

  const wrongKeyRun = await runPairQrCli(
    ["--base", liveBaseUrl, "--check", "--no-qr"],
    { HOLDUP_KEY: WRONG_HOLDUP_KEY },
  );
  assert.notEqual(wrongKeyRun.code, 0, "wrong HOLDUP_KEY must exit non-zero under --check");
  assert.ok(wrongKeyRun.stdout.includes("[FAIL] stats"));
  assert.ok(wrongKeyRun.stderr.includes("Preflight failed"));
  assertZeroKeyLeak(wrongKeyRun.stdout, WRONG_HOLDUP_KEY, "CLI wrongKeyRun stdout");
  assertZeroKeyLeak(wrongKeyRun.stderr, WRONG_HOLDUP_KEY, "CLI wrongKeyRun stderr");
  assertZeroKeyLeak(wrongKeyRun.stdout, LIVE_HOLDUP_KEY, "CLI wrongKeyRun server key stdout");
  assertZeroKeyLeak(wrongKeyRun.stderr, LIVE_HOLDUP_KEY, "CLI wrongKeyRun server key stderr");

  const missingKeyRun = await runPairQrCli(
    ["--base", liveBaseUrl, "--check", "--no-qr"],
    { HOLDUP_KEY: "" },
  );
  assert.notEqual(missingKeyRun.code, 0, "missing HOLDUP_KEY against locked server must exit non-zero");
  assert.ok(missingKeyRun.stdout.includes("[FAIL] stats"));

  const badArgRun = await runPairQrCli(
    ["--unknown-flag"],
    { HOLDUP_KEY: LIVE_HOLDUP_KEY },
  );
  assert.notEqual(badArgRun.code, 0);
  assertZeroKeyLeak(badArgRun.stdout, LIVE_HOLDUP_KEY, "CLI badArgRun stdout");
  assertZeroKeyLeak(badArgRun.stderr, LIVE_HOLDUP_KEY, "CLI badArgRun stderr");

  const showKeyRun = await runPairQrCli(
    ["--base", liveBaseUrl, "--no-qr", "--show-key"],
    { HOLDUP_KEY: LIVE_HOLDUP_KEY },
  );
  assert.equal(showKeyRun.code, 0);
  assert.ok(showKeyRun.stdout.includes(encodeURIComponent(LIVE_HOLDUP_KEY)));
});

test("multi-byte Nordic UTF-8 QR round-trip, network-error preflight redaction, and source hygiene", async () => {
  const nordicPayload = "Äänekoski iltalääke 5 mg - öljy & ångström";
  assert.ok(Buffer.byteLength(nordicPayload, "utf8") > nordicPayload.length);
  const nordicRendered = renderQrUnicode(encodeQrMatrix(nordicPayload));
  const { inner } = unpackUnicodeQr(nordicRendered);
  const decoded = await decodeQrWithZxing(inner);
  assert.equal(decoded.text, nordicPayload);

  const closedServer = http.createServer();
  await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", () => resolve()));
  const closedPort = (closedServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closedServer.close(() => resolve()));

  const netErrResult = await runPreflight(`${HTTP_PREFIX}127.0.0.1:${closedPort}`, LIVE_HOLDUP_KEY);
  assert.equal(netErrResult.ok, false);
  for (const c of netErrResult.checks) {
    assert.equal(c.ok, false);
    assert.equal(c.status, null);
  }
  assertZeroKeyLeak(JSON.stringify(netErrResult), LIVE_HOLDUP_KEY, "network error preflight JSON");

  const thisTestFile = path.join(SERVER_DIR, "test", "pair-qr.test.ts");
  const slashStar = "/" + "*";
  for (const targetFile of [PAIR_QR_SCRIPT, thisTestFile]) {
    const src = fs.readFileSync(targetFile, "utf8");
    assert.equal(src.includes(DOUBLE_SLASH), false, `unexpected line comment marker in ${targetFile}`);
    assert.equal(src.includes(slashStar), false, `unexpected block comment marker in ${targetFile}`);
    assert.equal(src.includes("\u2014"), false, `unexpected em dash in ${targetFile}`);
  }
});
