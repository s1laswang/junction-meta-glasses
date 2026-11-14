import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { Gs1Code, Verdict } from "../../shared/types.ts";
import {
  expiryEnd as webExpiryEnd,
  isExpired as webIsExpired,
  makeGs1,
  parseGs1 as webParseGs1,
  sameGtin,
} from "../../web/src/lib/gs1.ts";
import { DM, DmThrottle, decodeDataMatrix } from "../src/dm.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { gs1Date, gtin14, gtinValid, parseGs1 as serverParseGs1 } from "../src/gs1.ts";
import { Hub, getHub, getOrCreateHub, type LiveLike } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { isExpired as serverIsExpired } from "../src/safety.ts";

const GS = "\x1d";
const FIXTURES_DIR = path.join(SERVER_DIR, "fixtures");
const DM_AMLODIPINE_JPG = fs.readFileSync(path.join(FIXTURES_DIR, "dm_amlodipine.jpg"));
const AMLODIPINE_JPG = fs.readFileSync(path.join(FIXTURES_DIR, "amlodipine.jpg"));
const THREE_BOXES_JPG = fs.readFileSync(path.join(FIXTURES_DIR, "three_boxes.jpg"));

let zxingFullReady: Promise<typeof import("zxing-wasm/full")> | undefined;
function getZxingWriter() {
  zxingFullReady ??= (async () => {
    const full = await import("zxing-wasm/full");
    const req = createRequire(import.meta.url);
    const wasm = fs.readFileSync(req.resolve("zxing-wasm/full/zxing_full.wasm"));
    const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
    full.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
    return full;
  })();
  return zxingFullReady;
}

function svgToGrid(svg: string): Uint8Array[] {
  const dims = /width="(\d+)"\s+height="(\d+)"/.exec(svg);
  if (!dims) throw new Error("missing svg dimensions");
  const w = Number(dims[1]);
  const h = Number(dims[2]);
  const grid = Array.from({ length: h }, () => new Uint8Array(w).fill(255));
  for (const m of svg.matchAll(/M(\d+)\s+(\d+)h(\d+)v(\d+)/g)) {
    const x0 = Number(m[1]);
    const y0 = Number(m[2]);
    const bw = Number(m[3]);
    const bh = Number(m[4]);
    for (let y = y0; y < y0 + bh; y++) {
      for (let x = x0; x < x0 + bw; x++) {
        grid[y][x] = 0;
      }
    }
  }
  return grid;
}

function rotateGrid90(grid: Uint8Array[]): Uint8Array[] {
  const h = grid.length;
  const w = grid[0].length;
  return Array.from({ length: w }, (_, r) =>
    Uint8Array.from({ length: h }, (_, c) => grid[h - 1 - c][r]),
  );
}

function gridToPgm(grid: Uint8Array[], scale = 6): Buffer {
  const h = grid.length * scale;
  const w = grid[0].length * scale;
  const pixels = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    const srcRow = grid[Math.floor(y / scale)];
    for (let x = 0; x < w; x++) {
      pixels[y * w + x] = srcRow[Math.floor(x / scale)];
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, "ascii"), pixels]);
}

function normalizeGs1(code: Gs1Code | null | undefined) {
  if (!code) return null;
  return {
    raw: code.raw,
    gtin: code.gtin ?? null,
    expiry: code.expiry ?? null,
    batch: code.batch ?? null,
    serial: code.serial ?? null,
  };
}

test("decodeDataMatrix() decodes offline dm_amlodipine.jpg fixture and sliced Buffer views without leaking GS1 data to logs", async () => {
  const capturedLogs: string[] = [];
  const origConsoleLog = console.log;
  const prevQuiet = process.env.HOLDUP_QUIET;
  delete process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  try {
    const res = await decodeDataMatrix(DM_AMLODIPINE_JPG);
    assert.ok(res.ms >= 0);
    assert.equal(res.codes.length, 1);
    assert.deepEqual(res.codes[0], {
      raw: "(01)09501101530003(17)270800(10)AB12C(21)SN1",
      gtin: "09501101530003",
      expiry: "2027-08",
      batch: "AB12C",
      serial: "SN1",
    });

    const padded = Buffer.concat([
      Buffer.alloc(37, 0x7f),
      DM_AMLODIPINE_JPG,
      Buffer.alloc(19, 0x55),
    ]);
    const slicedView = padded.subarray(37, 37 + DM_AMLODIPINE_JPG.length);
    assert.equal(slicedView.byteOffset, 37);
    const slicedRes = await decodeDataMatrix(slicedView);
    assert.deepEqual(slicedRes.codes, res.codes);

    for (const line of capturedLogs) {
      assert.equal(line.includes("09501101530003"), false);
      assert.equal(line.includes("AB12C"), false);
      assert.equal(line.includes("SN1"), false);
      assert.equal(line.includes("270800"), false);
    }
  } finally {
    console.log = origConsoleLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("decodeDataMatrix() returns empty codes without throwing on non-barcode fixtures, empty buffers, and corrupt bytes", async () => {
  const prevQuiet = process.env.HOLDUP_QUIET;
  process.env.HOLDUP_QUIET = "1";
  try {
    for (const sample of [
      AMLODIPINE_JPG,
      THREE_BOXES_JPG,
      Buffer.alloc(0),
      Buffer.from("not-a-valid-image-stream", "utf8"),
      Buffer.alloc(256, 0xff),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]),
    ]) {
      const out = await decodeDataMatrix(sample);
      assert.deepEqual(out.codes, []);
      assert.ok(out.ms >= 0);
    }
  } finally {
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("decodeDataMatrix() offline zxing-wasm round-trip handles rotated DataMatrix, caps at 2 symbols, and ignores non-GS1 or QR codes", async () => {
  const writer = await getZxingWriter();

  const nordicPack = await writer.writeBarcode(
    "(01)06416542002149(17)270800(10)FINLOT7(21)SN9988",
    { format: "DataMatrix", options: "gs1", scale: 8 } as any,
  );
  assert.ok(nordicPack.image);
  const nordicDecoded = await decodeDataMatrix(Buffer.from(await nordicPack.image.arrayBuffer()));
  assert.deepEqual(nordicDecoded.codes, [
    {
      raw: "(01)06416542002149(17)270800(10)FINLOT7(21)SN9988",
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "FINLOT7",
      serial: "SN9988",
    },
  ]);

  const s1 = await writer.writeBarcode(
    "(01)09501101530003(17)280229(10)ROT-B1(21)ROT-S1",
    { format: "DataMatrix", options: "gs1", scale: 1 } as any,
  );
  const s2 = await writer.writeBarcode(
    "(01)06416542002149(17)280515(10)LOT-B2(21)SER-S2",
    { format: "DataMatrix", options: "gs1", scale: 1 } as any,
  );
  const s3 = await writer.writeBarcode(
    "(01)04006381333931(17)290100(10)LOT-B3(21)SER-S3",
    { format: "DataMatrix", options: "gs1", scale: 1 } as any,
  );
  const g1 = svgToGrid(s1.svg);
  const g2 = svgToGrid(s2.svg);
  const g3 = svgToGrid(s3.svg);

  const rotatedDecoded = await decodeDataMatrix(gridToPgm(rotateGrid90(g1)));
  assert.equal(rotatedDecoded.codes.length, 1);
  assert.equal(rotatedDecoded.codes[0].gtin, "09501101530003");
  assert.equal(rotatedDecoded.codes[0].expiry, "2028-02-29");
  assert.equal(rotatedDecoded.codes[0].batch, "ROT-B1");
  assert.equal(rotatedDecoded.codes[0].serial, "ROT-S1");

  const canvasH = Math.max(g1.length, g2.length, g3.length) + 8;
  const canvasW = g1[0].length + g2[0].length + g3[0].length + 24;
  const threeSideBySide = Array.from({ length: canvasH }, () => new Uint8Array(canvasW).fill(255));
  const blit = (src: Uint8Array[], ox: number, oy: number) => {
    for (let y = 0; y < src.length; y++) {
      for (let x = 0; x < src[y].length; x++) {
        threeSideBySide[oy + y][ox + x] = src[y][x];
      }
    }
  };
  blit(g1, 4, 4);
  blit(g2, g1[0].length + 10, 4);
  blit(g3, g1[0].length + g2[0].length + 16, 4);

  const multiDecoded = await decodeDataMatrix(gridToPgm(threeSideBySide));
  assert.equal(multiDecoded.codes.length, 2);

  const nonGs1Dm = await writer.writeBarcode(
    ["https:", "", "example.invalid", "patient-leaflet"].join("/"),
    { format: "DataMatrix", scale: 8 } as any,
  );
  assert.ok(nonGs1Dm.image);
  const nonGs1Decoded = await decodeDataMatrix(Buffer.from(await nonGs1Dm.image.arrayBuffer()));
  assert.deepEqual(nonGs1Decoded.codes, []);

  const qrWithGs1 = await writer.writeBarcode(
    "(01)09501101530003(17)270831(10)QR1(21)SN1",
    { format: "QRCode", scale: 8 } as any,
  );
  assert.ok(qrWithGs1.image);
  const qrDecoded = await decodeDataMatrix(Buffer.from(await qrWithGs1.image.arrayBuffer()));
  assert.deepEqual(qrDecoded.codes, []);
});

test("DmThrottle enforces minGapMs, drops concurrent busy calls, backs off for backoffMs when ms > slowMs, and redacts logs", async () => {
  assert.deepEqual(DM, { minGapMs: 1500, slowMs: 150, backoffMs: 10_000 });
  await decodeDataMatrix(DM_AMLODIPINE_JPG);

  const origNow = Date.now;
  const origConsoleLog = console.log;
  const prevQuiet = process.env.HOLDUP_QUIET;
  const capturedLogs: string[] = [];
  let clock = 1_000_000;
  let deltas: number[] = [];

  Date.now = () => {
    const step = deltas.shift() ?? 0;
    clock += step;
    return clock;
  };
  delete process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  try {
    const busyThrottle = new DmThrottle();
    const busyCodes: Gs1Code[] = [];
    await Promise.all([
      busyThrottle.maybe(DM_AMLODIPINE_JPG, (c) => busyCodes.push(c)),
      busyThrottle.maybe(DM_AMLODIPINE_JPG, (c) => busyCodes.push(c)),
    ]);
    assert.equal(busyCodes.length, 1);
    assert.equal(busyCodes[0].gtin, "09501101530003");

    assert.equal(capturedLogs.length, 1);
    assert.match(capturedLogs[0], /dm_decoded/);
    assert.match(capturedLogs[0], /\bn=1\b/);
    assert.match(capturedLogs[0], /\bsrc=glasses\b/);
    assert.match(capturedLogs[0], /\bms=\d+\b/);
    assert.equal(capturedLogs[0].includes("09501101530003"), false);
    assert.equal(capturedLogs[0].includes("AB12C"), false);
    assert.equal(capturedLogs[0].includes("SN1"), false);
    assert.equal(capturedLogs[0].includes("2027-08"), false);
    assert.equal(capturedLogs[0].includes("270800"), false);

    const throttle = new DmThrottle();
    const seen: Gs1Code[] = [];

    clock = 2_000_000;
    deltas = [0, 0, DM.slowMs, 0];
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 1);
    const exactMinGapTarget = 2_000_000 + DM.slowMs + DM.minGapMs;

    clock = exactMinGapTarget - 1;
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 1);

    clock = exactMinGapTarget;
    deltas = [0, 0, DM.slowMs + 1, 0];
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 2);
    const backoffTarget = exactMinGapTarget + (DM.slowMs + 1) + DM.backoffMs;

    clock = exactMinGapTarget + DM.minGapMs + 500;
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 2);

    clock = backoffTarget - 1;
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 2);

    clock = backoffTarget;
    const logsBeforeEmpty = capturedLogs.length;
    deltas = [0, 0, 12, 0];
    await throttle.maybe(AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 2);
    assert.equal(capturedLogs.length, logsBeforeEmpty);

    clock = backoffTarget + 12 + DM.minGapMs - 1;
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 2);

    clock = backoffTarget + 12 + DM.minGapMs;
    deltas = [0, 0, 5, 0];
    await throttle.maybe(DM_AMLODIPINE_JPG, (c) => seen.push(c));
    assert.equal(seen.length, 3);
  } finally {
    Date.now = origNow;
    console.log = origConsoleLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("Hub.freshCode enforces datamatrix feature gate, 10s TTL cliff, and dropFrames cleanup", () => {
  const origNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    const hub = new Hub("dm-hub-ttl-unit");
    const parsed = serverParseGs1("(01)09501101530003(17)270800(10)AB12C(21)SN1");
    assert.ok(parsed);

    hub.setCode(parsed);
    assert.equal(hub.freshCode(), undefined);

    hub.features.add("datamatrix");
    assert.deepEqual(hub.freshCode(), parsed);

    now += 9_999;
    assert.deepEqual(hub.freshCode(), parsed);
    assert.equal(hub.freshCode(5_000), undefined);

    now += 1;
    assert.equal(hub.freshCode(), undefined);

    hub.setCode(parsed);
    assert.deepEqual(hub.freshCode(), parsed);
    hub.dropFrames();
    assert.equal(hub.freshCode(), undefined);
  } finally {
    Date.now = origNow;
  }
});

test("HTTP POST /ingest/frame with dm_amlodipine.jpg on a glasses session populates hub.freshCode() and POST /api/verify returns crossCheck.agrees === true", async () => {
  const prevQuiet = process.env.HOLDUP_QUIET;
  const prevHoldupKey = process.env.HOLDUP_KEY;
  const prevApiKey = env.apiKey;
  const prevLedgerPath = env.ledgerPath;
  const origGenerateContent = ai.models.generateContent;
  const origConsoleLog = console.log;

  const tmpLedgerDir = fs.mkdtempSync("/dev/shm/holdup-dm-parity-");
  env.ledgerPath = path.join(tmpLedgerDir, "ledger.jsonl");
  env.apiKey = "test-dm-parity-key";
  delete process.env.HOLDUP_KEY;
  delete process.env.HOLDUP_QUIET;

  const capturedLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  ai.models.generateContent = (async () => ({
    text: JSON.stringify({
      kind: "medication",
      product: { value: "Amlodipine", confidence: 0.96 },
      ingredient: { value: "amlodipine", confidence: 0.97 },
      strength: { value: "5 mg", confidence: 0.95 },
      dosing: { value: "1 tablet in the evening", confidence: 0.9 },
      expiry: { value: "2027-08", confidence: 0.93 },
      allergens: { value: [], confidence: 0.9 },
      barcode: { value: null, confidence: 0 },
      readability: 0.94,
    }),
    usageMetadata: { promptTokenCount: 210, candidatesTokenCount: 75 },
  })) as unknown as typeof ai.models.generateContent;

  const sessionId = "dm-glasses-e2e-session";
  const wsSessionId = "dm-ws-phone-session";
  const hub = getOrCreateHub(sessionId);
  hub.dropFrames();
  hub.profile = {
    meds: [
      {
        id: "aml",
        name: "Amlodipine",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        gtin: "09501101530003",
      },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };

  let server: http.Server | undefined;
  try {
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing server port");
    const httpBase = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
    const wsBase = ["ws:", "", `127.0.0.1:${addr.port}`].join("/");

    hub.source = "glasses";
    hub.features = new Set();
    const inactiveLive: LiveLike & { frame(data: string): void } = {
      active: false,
      handleEvent() {},
      stop() {},
      frame() {},
    };
    hub.live = inactiveLive;

    const noFlagRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(DM_AMLODIPINE_JPG),
    });
    assert.equal(noFlagRes.status, 204);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(hub.lastCode, undefined);

    hub.dropFrames();
    hub.features = new Set(["datamatrix"]);
    const activeLive: LiveLike & { frame(data: string): void } = {
      active: true,
      handleEvent() {},
      stop() {},
      frame() {},
    };
    hub.live = activeLive;

    const ingestRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(DM_AMLODIPINE_JPG),
    });
    assert.equal(ingestRes.status, 204);

    for (let i = 0; i < 100 && !hub.freshCode(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const fresh = hub.freshCode();
    assert.ok(fresh);
    assert.equal(fresh.gtin, "09501101530003");
    assert.equal(fresh.expiry, "2027-08");
    assert.equal(fresh.batch, "AB12C");
    assert.equal(fresh.serial, "SN1");

    const verifyRes = await fetch(`${httpBase}/api/verify?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId, question: "Is this my evening pill?" }),
    });
    assert.equal(verifyRes.status, 200);
    const verdict = (await verifyRes.json()) as Verdict;
    assert.equal(verdict.level, "match");
    assert.equal(verdict.matchedMedId, "aml");
    assert.equal(verdict.crossCheck?.agrees, true);
    assert.match(verdict.speech, /double-checked with the pack's code/);

    const wsHub = getOrCreateHub(wsSessionId);
    wsHub.dropFrames();
    wsHub.features = new Set(["datamatrix"]);
    const ws = new WebSocket(`${wsBase}/live?session=${wsSessionId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "datamatrix",
        raw: `]d201095011015300031727080010AB12C${GS}21SN1`,
      }),
    );
    ws.send(JSON.stringify({ type: "ping", t: 77 }));
    await new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
    });
    assert.equal(wsHub.freshCode()?.gtin, "09501101530003");
    assert.equal(wsHub.freshCode()?.expiry, "2027-08");

    const wsClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await wsClosed;
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(getHub(wsSessionId)?.freshCode(), undefined);

    for (const line of capturedLogs) {
      assert.equal(line.includes("09501101530003"), false);
      assert.equal(line.includes("AB12C"), false);
      assert.equal(line.includes("SN1"), false);
      assert.equal(line.includes("270800"), false);
    }
  } finally {
    console.log = origConsoleLog;
    ai.models.generateContent = origGenerateContent;
    hub.live = undefined;
    hub.source = "phone";
    hub.features.clear();
    hub.dropFrames();
    const wsHubCleanup = getHub(wsSessionId);
    if (wsHubCleanup) {
      wsHubCleanup.features.clear();
      wsHubCleanup.dropFrames();
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    env.ledgerPath = prevLedgerPath;
    env.apiKey = prevApiKey;
    fs.rmSync(tmpLedgerDir, { recursive: true, force: true });
    if (prevHoldupKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevHoldupKey;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("Cross-runtime GS1 parity: server/src/gs1.ts and web/src/lib/gs1.ts agree across 50 EU FMD, HRI, prefix, NHRN, century, and malformed vectors", () => {
  const vectors: string[] = [
    `]d201095011015300031727083110AB12C${GS}2112345ABCDE`,
    `]d201064165420021491727080010LOT1${GS}21SN1`,
    `]C101064165420033751727113010LOT2${GS}21SN2`,
    `${GS}01064165420048601729010010BATCH9${GS}21SERIAL9`,
    `${GS}${GS}${GS}01064100001234561727081521ONLYSER`,
    `]d2${GS}01064165420021491727080010LOTX`,
    `]Q3010641654200214917270800`,
    "(01)06416542002149(17)270800(10)BATCH42(21)SN9001",
    "  (01) 06410000123456 (17) 270815 (10) LOT-7A (21) SER-88B  ",
    "(21)SER55(710)PZN12345(10)LOT9(17)280229(240)EXTRA99(01)06416542003375",
    `010641654200214921SER-FIRST${GS}10BATCH-SECOND${GS}17270800`,
    `10FIRSTLOT${GS}${GS}21SECOND-SN${GS}010641000012345617270815${GS}`,
    `010641654200214910ABCDEFGHIJKLMNOPQRSTUVWX${GS}2112345678901234567890999${GS}17270800`,
    `]d20106416542002149240ADD-ITEM-ID-9988${GS}10LOT-FI${GS}1727080021SN-FI`,
    `]d20106416542002149241CUST-PART-44${GS}1727081510LOT-SE${GS}21SN-SE`,
    `]d20106416542002149710NHRN-DE-123${GS}1727081510LOT-710${GS}21SN-710`,
    `]d20106416542002149711NHRN-FR-123${GS}1727081510LOT-711${GS}21SN-711`,
    `]d20106416542002149712NHRN-ES-123${GS}1727081510LOT-712${GS}21SN-712`,
    `]d20106416542002149713NHRN-BR-123${GS}1727081510LOT-713${GS}21SN-713`,
    `]d20106416542002149714NHRN-PT-123${GS}1727081510LOT-714${GS}21SN-714`,
    `01064100001234561727080010BATCH1${GS}714TRAILING-NHRN`,
    `010641654200214911260115200422CPV1${GS}241CUST1${GS}91COMPANY-INTERNAL${GS}1727080010B77${GS}21S88`,
    "00123456789012345678",
    "02064165420021491527063017270800",
    "010641654200214917500815",
    "010641654200214917500800",
    "010641654200214917510815",
    "010641654200214917510800",
    "010641654200214917000105",
    "010641654200214917991231",
    "01064165420021491727001510LOT1",
    "01064165420021491727130010LOT2",
    "17271301",
    "010641654200214917270231",
    "(01)6416542002149(17)270800(10)LOT42",
    "(01)064165420021499(17)270815(21)SN7",
    "010641654200214X1727080010LOT5",
    `010641654200214917270800${GS.repeat(25)}10IGNORED`,
    `01064165420021491727080010B77${GS}ZZNOISE`,
    "(01)09501101530004(17)270831",
    "",
    "   ",
    "NOT_A_BARCODE",
    ["https:", "", "example.com", "x"].join("/"),
    "()",
    "(01)(17)",
    makeGs1({ gtin: "06416542002149", expiry: "270800" }),
    makeGs1({ gtin: "06416542002149", expiry: "270815", batch: "FIN-LOT-1" }),
    makeGs1({ gtin: "06410000123456", expiry: "280200", serial: "SER-ONLY-9" }),
    makeGs1({ gtin: "06410000123456", expiry: "271231", batch: "BATCH-EU-4", serial: "SN-EU-8899" }),
  ];

  assert.ok(vectors.length >= 25);

  for (const v of vectors) {
    const s = serverParseGs1(v);
    const w = webParseGs1(v);
    assert.deepEqual(normalizeGs1(s), normalizeGs1(w), `GS1 mismatch on vector: ${JSON.stringify(v)}`);
    assert.deepEqual(
      s ? JSON.parse(JSON.stringify(s)) : null,
      w ? JSON.parse(JSON.stringify(w)) : null,
      `JSON serialised mismatch on vector: ${JSON.stringify(v)}`,
    );
  }

  const exact400 = `(01)09501101530003(17)270800(240)${"A".repeat(30)}(91)${"B".repeat(333)}`;
  assert.equal(exact400.length, 400);
  assert.equal(serverParseGs1(exact400)?.gtin, "09501101530003");
  assert.equal(serverParseGs1(exact400 + "X"), undefined);
});

test("Cross-runtime gs1Date, expiry boundary, and GTIN normalisation parity between server and web", () => {
  const dateVectors = [
    "270831",
    "270800",
    "241100",
    "260200",
    "280200",
    "280229",
    "500101",
    "501200",
    "510101",
    "511200",
    "000105",
    "991231",
    "270015",
    "271301",
    "2708",
    "2708310",
    "27AB01",
    "",
  ];

  for (const d of dateVectors) {
    const serverIso = gs1Date(d);
    const webIso = webParseGs1(`(01)09501101530003(17)${d}`)?.expiry;
    assert.equal(serverIso, webIso, `gs1Date mismatch for ${d}`);
  }

  const expiryChecks: Array<[string, Date]> = [
    ["2026-02", new Date(2026, 1, 28, 23, 59, 59)],
    ["2026-02", new Date(2026, 2, 1, 0, 0, 0)],
    ["2028-02", new Date(2028, 1, 29, 23, 59, 59)],
    ["2028-02", new Date(2028, 2, 1, 0, 0, 0)],
    ["2027-08", new Date(2027, 7, 31, 23, 59, 59)],
    ["2027-08", new Date(2027, 8, 1, 0, 0, 0)],
    ["2027-08-15", new Date(2027, 7, 15, 23, 59, 59)],
    ["2027-08-15", new Date(2027, 7, 16, 0, 0, 0)],
  ];
  for (const [iso, refNow] of expiryChecks) {
    assert.equal(webExpiryEnd(iso).getHours(), 23);
    assert.equal(serverIsExpired(iso, refNow), webIsExpired(iso, refNow), `isExpired mismatch for ${iso}`);
  }

  const gtinPairs: Array<[string | null | undefined, string | null | undefined]> = [
    ["6410000123456", "06410000123456"],
    ["09501101530003", "9501101530003"],
    ["4006381333931", "04006381333931"],
    ["012345678905", "00012345678905"],
    ["12345670", "00000012345670"],
    ["6410-0001-2345-6", "0641 0000 1234 56"],
    ["00000000000000", "0000000000000"],
    ["00000000", "00000000"],
    ["6416542002149", "6416542003375"],
    ["", "06410000123456"],
    [null, "06410000123456"],
    ["06410000123456", undefined],
    [null, undefined],
  ];
  for (const [a, b] of gtinPairs) {
    const serverSame = Boolean(gtin14(a) && gtin14(a) === gtin14(b));
    assert.equal(serverSame, sameGtin(a, b), `GTIN comparison mismatch for ${a} vs ${b}`);
  }

  assert.equal(gtinValid("09501101530003"), true);
  assert.equal(gtinValid("4006381333931"), true);
  assert.equal(gtinValid("09501101530004"), false);
  assert.equal(gtinValid("1234567890"), false);
});
