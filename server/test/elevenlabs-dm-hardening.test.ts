import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { DM, decodeDataMatrix, DmThrottle } from "../src/dm.ts";
import { eleven, elevenStream, scribeToken } from "../src/elevenlabs.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { startServer } from "../src/index.ts";
import type { LedgerLine } from "../src/ledger.ts";

const FAKE_SK = ["sk_", "testHardeningKey9876543210abcdef"].join("");

const origFetch = globalThis.fetch;
const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origTimeoutMs = process.env.ELEVENLABS_TIMEOUT_MS;
const origLedgerPath = env.ledgerPath;
const origEleven = {
  key: eleven.key,
  base: eleven.base,
  model: eleven.model,
  live: eleven.live,
  format: eleven.format,
  voices: { ...eleven.voices },
};

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const tempDirs: string[] = [];

process.env.HOLDUP_QUIET = "1";

let server: http.Server;
let baseUrl = "";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function makeTempLedger(label: string): string {
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-hardening-${label}-`));
  tempDirs.push(dir);
  const ledgerFile = path.join(dir, "ledger.jsonl");
  env.ledgerPath = ledgerFile;
  return ledgerFile;
}

function readLedgerLines(filePath: string): LedgerLine[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerLine);
}

function mockUpstreamFetch(handler: (url: string, init?: FetchInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (baseUrl && url.startsWith(baseUrl)) {
      return origFetch(input, init);
    }
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function resetElevenState() {
  eleven.key = origEleven.key;
  eleven.base = origEleven.base;
  eleven.model = origEleven.model;
  eleven.live = origEleven.live;
  eleven.format = origEleven.format;
  eleven.voices = { ...origEleven.voices };
}

function svgsToBmp(svgs: string[], scale = 6, pad = 6): Buffer {
  const parsed = svgs.map((svg) => {
    const wMatch = /<svg[^>]*width="(\d+)"/.exec(svg);
    const hMatch = /<svg[^>]*height="(\d+)"/.exec(svg);
    assert.ok(wMatch && hMatch, "expected SVG dimensions");
    const w = Number(wMatch[1]);
    const h = Number(hMatch[1]);
    const boxes = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/g)].map((m) => m.slice(1).map(Number));
    return { w, h, boxes };
  });
  const totalW = (parsed.reduce((sum, p) => sum + p.w, 0) + pad * (parsed.length + 1)) * scale;
  const maxH = (Math.max(...parsed.map((p) => p.h)) + pad * 2) * scale;
  const stride = (totalW * 3 + 3) & ~3;
  const pixels = Buffer.alloc(stride * maxH, 255);
  let xOff = pad;
  for (const p of parsed) {
    for (const [bx, by, bw, bh] of p.boxes) {
      for (let y = (pad + by) * scale; y < (pad + by + bh) * scale; y++) {
        const row = (maxH - 1 - y) * stride;
        pixels.fill(0, row + (xOff + bx) * scale * 3, row + (xOff + bx + bw) * scale * 3);
      }
    }
    xOff += p.w + pad;
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(totalW, 18);
  header.writeInt32LE(maxH, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  delete process.env.HOLDUP_KEY;
  makeTempLedger("boot");
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  delete process.env.ELEVENLABS_TIMEOUT_MS;
  resetElevenState();
  eleven.base = "https://api.elevenlabs.io";
  eleven.model = "eleven_flash_v2_5";
  eleven.format = "mp3_44100_64";
  mockUpstreamFetch(() => {
    throw new Error("unexpected external fetch");
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetElevenState();
  if (origTimeoutMs === undefined) delete process.env.ELEVENLABS_TIMEOUT_MS;
  else process.env.ELEVENLABS_TIMEOUT_MS = origTimeoutMs;
});

after(async () => {
  globalThis.fetch = origFetch;
  resetElevenState();
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  if (origTimeoutMs === undefined) delete process.env.ELEVENLABS_TIMEOUT_MS;
  else process.env.ELEVENLABS_TIMEOUT_MS = origTimeoutMs;

  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await new Promise((resolve) => setTimeout(resolve, 25));
  env.ledgerPath = origLedgerPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("decodeDataMatrix short-circuits tiny or non-Buffer inputs before WASM, recovers after transient WASM init failures, and decodes fixtures/dm_amlodipine.jpg", async () => {
  const dmFixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "dm_amlodipine.jpg"));
  const plainFixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const origReadFileSync = fs.readFileSync;
  let wasmReads = 0;
  let shouldFailWasmRead = true;

  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith("zxing_reader.wasm")) {
      wasmReads++;
      if (shouldFailWasmRead) throw new Error("transient ENOENT reading wasm");
    }
    return (origReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;

  try {
    assert.deepEqual(await decodeDataMatrix(Buffer.alloc(0)), { codes: [], ms: 0 });
    assert.deepEqual(await decodeDataMatrix(Buffer.from([0xff, 0xd8, 0xff])), { codes: [], ms: 0 });
    assert.deepEqual(await decodeDataMatrix(null as unknown as Buffer), { codes: [], ms: 0 });
    assert.deepEqual(await decodeDataMatrix(new Uint8Array(16) as unknown as Buffer), { codes: [], ms: 0 });
    assert.equal(wasmReads, 0);

    const failRead = await decodeDataMatrix(dmFixture);
    assert.deepEqual(failRead.codes, []);
    assert.equal(wasmReads, 1);

    shouldFailWasmRead = false;
    const ok = await decodeDataMatrix(dmFixture);
    assert.equal(wasmReads, 2);
    assert.equal(ok.codes.length, 1);
    assert.equal(ok.codes[0].gtin, "09501101530003");
    assert.equal(ok.codes[0].expiry, "2027-08");
    assert.equal(Boolean(ok.codes[0].batch), true);
    assert.equal(Boolean(ok.codes[0].serial), true);

    const cached = await decodeDataMatrix(plainFixture);
    assert.equal(wasmReads, 2);
    assert.deepEqual(cached.codes, []);
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

test("decodeDataMatrix deduplicates identical GS1 symbols by raw payload within a single frame while preserving order for distinct symbols", async () => {
  const full = await import("zxing-wasm/full");
  const reader = await import("zxing-wasm/reader");
  const require = createRequire(import.meta.url);
  const fullWasm = fs.readFileSync(require.resolve("zxing-wasm/full/zxing_full.wasm"));
  await full.prepareZXingModule({
    overrides: { wasmBinary: fullWasm.buffer.slice(fullWasm.byteOffset, fullWasm.byteOffset + fullWasm.byteLength) as ArrayBuffer },
    fireImmediately: true,
  });

  const rawA = "(01)09501101530003(17)270831(10)AB12C(21)SN1";
  const rawB = "(01)04006381333931(17)280500(10)LOT9(21)SN2";
  const symA = await full.writeBarcode(rawA, { format: "DataMatrix", options: "gs1", scale: 1 });
  const symB = await full.writeBarcode(rawB, { format: "DataMatrix", options: "gs1", scale: 1 });

  const dupBmp = svgsToBmp([symA.svg, symA.svg]);
  const rawDupDetected = await reader.readBarcodes(new Uint8Array(dupBmp), {
    formats: ["DataMatrix"],
    tryHarder: false,
    tryRotate: true,
    tryInvert: false,
    maxNumberOfSymbols: 2,
  });
  assert.equal(rawDupDetected.length, 2);

  const deduped = await decodeDataMatrix(dupBmp);
  assert.equal(deduped.codes.length, 1);
  assert.equal(deduped.codes[0].raw, rawA);
  assert.equal(deduped.codes[0].gtin, "09501101530003");

  const abBmp = svgsToBmp([symA.svg, symB.svg]);
  const abDecoded = await decodeDataMatrix(abBmp);
  assert.deepEqual(
    abDecoded.codes.map((c) => c.raw),
    [rawA, rawB],
  );

  const baBmp = svgsToBmp([symB.svg, symA.svg]);
  const baDecoded = await decodeDataMatrix(baBmp);
  assert.deepEqual(
    baDecoded.codes.map((c) => c.raw),
    [rawB, rawA],
  );
});

test("DmThrottle enforces busy guard, minGapMs rate limit, and slowMs backoffMs pause", async () => {
  const dmFixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "dm_amlodipine.jpg"));
  const origDm = { ...DM };
  try {
    DM.minGapMs = 60;
    DM.slowMs = 5000;
    DM.backoffMs = 220;

    const throttle = new DmThrottle();
    const seen: string[] = [];
    await Promise.all([
      throttle.maybe(dmFixture, (c) => seen.push(c.gtin ?? "")),
      throttle.maybe(dmFixture, (c) => seen.push(c.gtin ?? "")),
    ]);
    assert.deepEqual(seen, ["09501101530003"]);

    await throttle.maybe(dmFixture, (c) => seen.push(c.gtin ?? ""));
    assert.deepEqual(seen, ["09501101530003"]);

    await new Promise((resolve) => setTimeout(resolve, 75));
    await throttle.maybe(dmFixture, (c) => seen.push(c.gtin ?? ""));
    assert.deepEqual(seen, ["09501101530003", "09501101530003"]);

    const slowThrottle = new DmThrottle();
    const slowSeen: string[] = [];
    DM.minGapMs = 15;
    DM.slowMs = -1;
    DM.backoffMs = 160;

    await slowThrottle.maybe(dmFixture, (c) => slowSeen.push(c.gtin ?? ""));
    assert.equal(slowSeen.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 35));
    await slowThrottle.maybe(dmFixture, (c) => slowSeen.push(c.gtin ?? ""));
    assert.equal(slowSeen.length, 1);
  } finally {
    DM.minGapMs = origDm.minGapMs;
    DM.slowMs = origDm.slowMs;
    DM.backoffMs = origDm.backoffMs;
  }
});

test("POST /api/tts/eleven URL-encodes voice and output_format and attaches an AbortSignal", async () => {
  const ledgerFile = makeTempLedger("tts-encode");
  eleven.key = FAKE_SK;
  eleven.live = true;
  eleven.voices.en = "voice/custom id?x=1&y=2";
  eleven.format = "mp3_44100_64&extra=1";

  let capturedUrl = "";
  let hasAbortSignal = false;
  const audioChunk = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0xaa, 0xbb]);

  mockUpstreamFetch((url, init) => {
    capturedUrl = url;
    hasAbortSignal = init?.signal instanceof AbortSignal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(audioChunk);
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "audio/mpeg" } },
    );
  });

  const res = await fetch(`${baseUrl}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Yes, Amlodipine 5 mg.", lang: "en" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(audioChunk));
  assert.equal(
    capturedUrl,
    "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fcustom%20id%3Fx%3D1%26y%3D2/stream?output_format=mp3_44100_64%26extra%3D1",
  );
  assert.equal(hasAbortSignal, true);

  const lines = readLedgerLines(ledgerFile);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true);
});

test("POST /api/tts/eleven rejects 0-byte HTTP 200 streams with 503 tts_unavailable, cancels reader, and records ok:false ledger", async () => {
  const ledgerFile = makeTempLedger("tts-empty");
  eleven.key = FAKE_SK;
  eleven.live = true;

  let cancelCount = 0;
  let callNum = 0;

  mockUpstreamFetch(() => {
    const idx = callNum++;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (idx === 0) {
          c.close();
        } else {
          c.enqueue(new Uint8Array(0));
        }
      },
      cancel() {
        cancelCount++;
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  });

  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${baseUrl}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Yes, Amlodipine 5 mg.", lang: "en" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.type, "error");
    assert.equal(body.code, "tts_unavailable");
    assert.equal(body.recoverable, true);
  }

  assert.equal(cancelCount >= 1, true);
  const rows = readLedgerLines(ledgerFile);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.feature, "tts_eleven");
    assert.equal(row.ok, false);
    assert.equal("first_audio_s" in row, false);
  }

  await assert.rejects(() => elevenStream("Check direct call", "en"), /elevenlabs tts empty stream/);
  const rowsAfterDirect = readLedgerLines(ledgerFile);
  assert.equal(rowsAfterDirect.length, 3);
  assert.equal(rowsAfterDirect[2].ok, false);
});

test("POST /api/tts/eleven aborts hung fetch and stalled streams within ELEVENLABS_TIMEOUT_MS and returns 503 tts_unavailable", async () => {
  const ledgerFile = makeTempLedger("tts-timeout");
  eleven.key = FAKE_SK;
  eleven.live = true;
  process.env.ELEVENLABS_TIMEOUT_MS = "25";

  let mode: "hang_headers" | "hang_body" = "hang_headers";
  let streamCancelled = false;

  mockUpstreamFetch((_url, init) => {
    const sig = init?.signal;
    assert.ok(sig instanceof AbortSignal);
    if (mode === "hang_headers") {
      return new Promise<Response>((_resolve, reject) => {
        sig.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")), { once: true });
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          streamCancelled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "audio/mpeg" } },
    );
  });

  const t0 = Date.now();
  const r1 = await fetch(`${baseUrl}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Timeout headers check", lang: "en" }),
  });
  const elapsed1 = Date.now() - t0;
  assert.equal(r1.status, 503);
  assert.equal(elapsed1 >= 90 && elapsed1 < 1500, true, `unexpected elapsed1=${elapsed1}ms`);
  assert.equal(((await r1.json()) as Record<string, unknown>).code, "tts_unavailable");

  mode = "hang_body";
  process.env.ELEVENLABS_TIMEOUT_MS = "110";
  const t1 = Date.now();
  const r2 = await fetch(`${baseUrl}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Timeout stalled body check", lang: "en" }),
  });
  const elapsed2 = Date.now() - t1;
  assert.equal(r2.status, 503);
  assert.equal(elapsed2 >= 95 && elapsed2 < 1500, true, `unexpected elapsed2=${elapsed2}ms`);
  assert.equal(((await r2.json()) as Record<string, unknown>).code, "tts_unavailable");
  assert.equal(streamCancelled, true);

  const rows = readLedgerLines(ledgerFile);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.feature === "tts_eleven" && row.ok === false), true);
});

test("GET /api/stt/token rejects missing, blank, or non-string tokens and hung requests with 503 stt_unavailable, and trims valid tokens", async () => {
  eleven.key = FAKE_SK;

  const badPayloads: unknown[] = [{}, { token: undefined }, { token: null }, { token: "" }, { token: "   \t\n " }, { token: 42 }, null];
  let idx = 0;
  mockUpstreamFetch(() => Response.json(badPayloads[idx++]));

  for (let i = 0; i < badPayloads.length; i++) {
    const res = await fetch(`${baseUrl}/api/stt/token`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.type, "error");
    assert.equal(body.code, "stt_unavailable");
    assert.equal(body.recoverable, true);
  }

  mockUpstreamFetch(() => Response.json({ token: "   " }));
  await assert.rejects(() => scribeToken(), /elevenlabs empty scribe token/);

  process.env.ELEVENLABS_TIMEOUT_MS = "110";
  mockUpstreamFetch((_url, init) => {
    const sig = init?.signal;
    assert.ok(sig instanceof AbortSignal);
    return new Promise<Response>((_resolve, reject) => {
      sig.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")), { once: true });
    });
  });

  const t0 = Date.now();
  const timeoutRes = await fetch(`${baseUrl}/api/stt/token`);
  const elapsed = Date.now() - t0;
  assert.equal(timeoutRes.status, 503);
  assert.equal(elapsed >= 95 && elapsed < 1500, true, `unexpected elapsed=${elapsed}ms`);
  assert.equal(((await timeoutRes.json()) as Record<string, unknown>).code, "stt_unavailable");

  mockUpstreamFetch(() => Response.json({ token: "  sut_trimmed_realtime_token_01  " }));
  const okRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), {
    token: "sut_trimmed_realtime_token_01",
    model: "scribe_v2_realtime",
  });
});
