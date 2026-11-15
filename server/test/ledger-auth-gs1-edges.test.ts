import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { authEnabled, keyOk, requireKey, wsKeyOk } from "../src/auth.ts";
import { env } from "../src/env.ts";
import { gs1Date, gtin14, gtinValid, parseGs1 } from "../src/gs1.ts";
import { startServer } from "../src/index.ts";
import { ledger, stats, usage, type LedgerLine } from "../src/ledger.ts";
import { errSummary, log, redact } from "../src/log.ts";

const FIVE_MB = 5 * 1024 * 1024;
const GS = "\x1d";
const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const origLedgerPath = env.ledgerPath;
const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;
process.env.HOLDUP_QUIET = "1";

const shmDirs: string[] = [];

function mkShmDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-edges-${tag}-${process.pid}-`));
  shmDirs.push(dir);
  return dir;
}

function cleanupShmDirs() {
  for (const dir of shmDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function restoreEnv() {
  env.ledgerPath = origLedgerPath;
  env.apiKey = origApiKey;
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  process.env.HOLDUP_QUIET = "1";
}

afterEach(() => {
  restoreEnv();
  cleanupShmDirs();
});

after(() => {
  cleanupShmDirs();
  env.ledgerPath = origLedgerPath;
  env.apiKey = origApiKey;
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

function callRequireKey(
  baseUrl: string,
  reqPath: string,
  query: Record<string, unknown> = {},
  headers: Record<string, string | string[] | undefined> = {},
) {
  const req = { baseUrl, path: reqPath, query, headers } as unknown as Request;
  let statusCode = 200;
  let jsonBody: unknown = undefined;
  let passed = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    passed = true;
  };
  requireKey(req, res, next);
  return { statusCode, jsonBody, passed };
}

function mockWsReq(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("ledger.ts rotates >5 MB file to .1 only on the 200-write check in /dev/shm", () => {
  const dir = mkShmDir("rotate");
  const alignPath = path.join(dir, "align.jsonl");
  fs.writeFileSync(alignPath, "", "utf8");
  fs.truncateSync(alignPath, FIVE_MB + 128);
  env.ledgerPath = alignPath;

  let alignWrites = 0;
  while (!fs.existsSync(`${alignPath}.1`) && alignWrites < 200) {
    alignWrites += 1;
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.1, ok: true });
  }
  assert.equal(fs.existsSync(`${alignPath}.1`), true);
  assert.ok(fs.statSync(`${alignPath}.1`).size >= FIVE_MB + 128);
  assert.ok(fs.statSync(alignPath).size < 512);

  const scratchPath = path.join(dir, "scratch.jsonl");
  env.ledgerPath = scratchPath;
  for (let i = 0; i < 199; i += 1) {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.05, ok: true });
  }

  const targetPath = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(targetPath, "", "utf8");
  fs.truncateSync(targetPath, FIVE_MB);
  env.ledgerPath = targetPath;

  ledger({ ts: 1763160000001, feature: "verify", model: "gemini-3.8-flash", latency_s: 0.2, ok: true });
  assert.equal(fs.existsSync(`${targetPath}.1`), false);
  assert.ok(fs.statSync(targetPath).size > FIVE_MB);

  for (let i = 0; i < 199; i += 1) {
    ledger({ ts: 1763160000010 + i, feature: "verify", model: "gemini-3.8-flash", latency_s: 0.15, ok: true });
  }
  assert.equal(fs.existsSync(`${targetPath}.1`), false);
  const sizeBeforeRotate = fs.statSync(targetPath).size;
  assert.ok(sizeBeforeRotate > FIVE_MB);

  ledger({
    ts: 1763160009999,
    feature: "tts",
    model: "gemini-3.8-flash-tts",
    in: 24,
    out: 96,
    thinking: 4,
    latency_s: 0.32,
    ok: true,
  });

  assert.equal(fs.existsSync(`${targetPath}.1`), true);
  assert.equal(fs.statSync(`${targetPath}.1`).size, sizeBeforeRotate);

  const rotatedFresh = fs.readFileSync(targetPath, "utf8").split("\n").filter(Boolean);
  assert.equal(rotatedFresh.length, 1);
  assert.equal(JSON.parse(rotatedFresh[0]).ts, 1763160009999);

  const snap = stats();
  assert.equal(snap.since, 1763160009999);
  assert.equal(snap.total, 1);
  assert.deepEqual(snap.features.tts, {
    calls: 1,
    ok: 1,
    errors: 0,
    latency_p50_s: 0.32,
    latency_p95_s: 0.32,
    tokens_in: 24,
    tokens_out: 96,
    tokens_thinking: 4,
    models: { "gemini-3.8-flash-tts": 1 },
  });
});

test("ledger.ts usage() resolves candidatesTokenCount vs responseTokenCount, thoughtsTokenCount, and cachedContentTokenCount", () => {
  assert.deepEqual(
    usage({
      promptTokenCount: 320,
      candidatesTokenCount: 64,
      responseTokenCount: 999,
      thoughtsTokenCount: 28,
      cachedContentTokenCount: 128,
    }),
    { in: 320, out: 64, thinking: 28, cached: 128 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 180, candidatesTokenCount: 0, responseTokenCount: 75 }),
    { in: 180, out: 0, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 180, candidatesTokenCount: undefined, responseTokenCount: 75 }),
    { in: 180, out: 75, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 180, candidatesTokenCount: null, responseTokenCount: 75 }),
    { in: 180, out: 75, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({
      promptTokenCount: null,
      candidatesTokenCount: null,
      responseTokenCount: null,
      thoughtsTokenCount: 41,
      cachedContentTokenCount: 90,
    }),
    { in: 0, out: 0, thinking: 41, cached: 90 },
  );

  assert.deepEqual(
    usage({ cachedTokenCount: 55, thoughtsTokenCount: 0, cachedContentTokenCount: 0 }),
    { in: 0, out: 0, thinking: 0, cached: 0 },
  );

  assert.deepEqual(usage(undefined), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage(null), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage({}), { in: 0, out: 0, thinking: 0, cached: 0 });
});

test("ledger.ts stats() aggregates live first_audio_p50_s/p95_s, tool_p50_s/p95_s, and tool_calls on ok sessions", () => {
  const dir = mkShmDir("live-stats");
  const ledgerFile = path.join(dir, "ledger.jsonl");
  env.ledgerPath = ledgerFile;

  const faSamples = [
    2.4564, 0.1, 1.9, 0.2, 1.8, 0.3, 1.7, 0.4, 1.6, 0.5,
    1.5, 0.6, 1.4, 0.7, 1.3, 0.8, 1.2, 0.9, 1.1236, 1.0,
  ];
  const toolChunks: Array<number[] | undefined> = [
    [1.7894, 0.05],
    [0.95],
    [],
    undefined,
    [0.1, 0.9, 0.15],
    [0.85, 0.2],
    [0.8],
    [0.25, 0.75],
    [0.3],
    [0.7, 0.35],
    [0.65],
    [0.4, 0.6],
    [0.45],
    [0.5556],
    [0.5],
    [],
    undefined,
    [],
    [],
    [],
  ];

  const rows: LedgerLine[] = faSamples.map((fa, idx) => {
    const tl = toolChunks[idx];
    const row: LedgerLine = {
      ts: 1763161000000 + idx * 100,
      feature: "live",
      model: idx % 4 === 0 ? "gemini-3.1-flash-live-preview" : "gemini-3.8-live",
      in: 10,
      out: 5,
      thinking: 2,
      latency_s: 5 + idx,
      ok: true,
      first_audio_s: fa,
    };
    if (tl !== undefined) {
      row.tool_latencies_s = tl;
      row.tool_calls = tl.length;
    }
    return row;
  });

  rows.push(
    {
      ts: 1763161005000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 3.5,
      ok: true,
      first_audio_s: null,
      tool_calls: 0,
      tool_latencies_s: [],
    },
    {
      ts: 1763161006000,
      feature: "live",
      model: "gemini-3.8-live",
      in: 50,
      out: 0,
      thinking: 3,
      latency_s: 99.9,
      ok: false,
      first_audio_s: 88.8,
      tool_calls: 40,
      tool_latencies_s: [77.7, 66.6],
    },
    {
      ts: 1763161007000,
      feature: "verify",
      model: "gemini-3.8-flash",
      in: 200,
      out: 40,
      thinking: 12,
      latency_s: 0.84,
      ok: true,
    },
  );

  fs.writeFileSync(ledgerFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const agg = stats();
  assert.equal(agg.since, 1763161000000);
  assert.equal(agg.total, 23);

  const live = agg.features.live as Record<string, unknown>;
  assert.equal(live.calls, 22);
  assert.equal(live.ok, 21);
  assert.equal(live.errors, 1);
  assert.equal(live.tokens_in, 250);
  assert.equal(live.tokens_out, 100);
  assert.equal(live.tokens_thinking, 43);
  assert.equal(live.first_audio_p50_s, 1.124);
  assert.equal(live.first_audio_p95_s, 2.456);
  assert.equal(live.tool_p50_s, 0.556);
  assert.equal(live.tool_p95_s, 1.789);
  assert.equal(live.tool_calls, 20);
  assert.deepEqual(live.models, {
    "gemini-3.1-flash-live-preview": 5,
    "gemini-3.8-live": 17,
  });

  const verifyFeat = agg.features.verify as Record<string, unknown>;
  assert.equal("first_audio_p50_s" in verifyFeat, false);
  assert.equal("tool_p50_s" in verifyFeat, false);
  assert.equal("tool_calls" in verifyFeat, false);

  const emptyLiveFile = path.join(dir, "empty-live.jsonl");
  env.ledgerPath = emptyLiveFile;
  fs.writeFileSync(
    emptyLiveFile,
    JSON.stringify({
      ts: 1763162000000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 2.1,
      ok: true,
      first_audio_s: null,
    }) + "\n",
    "utf8",
  );
  const emptyLive = stats().features.live as Record<string, unknown>;
  assert.equal(emptyLive.first_audio_p50_s, null);
  assert.equal(emptyLive.first_audio_p95_s, null);
  assert.equal(emptyLive.tool_p50_s, null);
  assert.equal(emptyLive.tool_p95_s, null);
  assert.equal(emptyLive.tool_calls, 0);
});

test("auth.ts keyOk() performs constant-time SHA-256 comparison across arbitrary lengths and UTF-8 bytes", () => {
  delete process.env.HOLDUP_KEY;
  assert.equal(authEnabled(), false);
  assert.equal(keyOk(undefined), true);
  assert.equal(keyOk(null), true);
  assert.equal(keyOk(""), true);
  assert.equal(keyOk("arbitrary"), true);

  process.env.HOLDUP_KEY = "";
  assert.equal(authEnabled(), false);
  assert.equal(keyOk(""), true);
  assert.equal(keyOk(null), true);

  process.env.HOLDUP_KEY = "holdup-constant-time-key-2026";
  assert.equal(authEnabled(), true);
  assert.equal(keyOk("holdup-constant-time-key-2026"), true);
  assert.equal(keyOk("holdup-constant-time-key-2027"), false);
  assert.equal(keyOk("Holdup-constant-time-key-2026"), false);
  assert.equal(keyOk("holdup-constant-time-key-2026\0"), false);
  assert.equal(keyOk("h"), false);
  assert.equal(keyOk("x".repeat(8192)), false);
  assert.equal(keyOk(""), false);
  assert.equal(keyOk(null), false);
  assert.equal(keyOk(undefined), false);
  assert.equal(keyOk(42 as unknown as string), false);

  const nfc = "salasana-\u00e4\u00f6\u00e5-2026";
  const nfd = "salasana-a\u0308o\u0308a\u030a-2026";
  process.env.HOLDUP_KEY = nfc;
  assert.equal(keyOk(nfc), true);
  assert.equal(keyOk(nfd), false);
});

test("auth.ts requireKey() and wsKeyOk() enforce ?key= vs array x-holdup-key precedence and /api/health public bypass", async () => {
  const valid = "sprint-secret-key";
  process.env.HOLDUP_KEY = valid;

  assert.equal(callRequireKey("/api", "/stats", {}, { "x-holdup-key": [valid, "wrong-second"] }).passed, true);
  const wrongFirstArr = callRequireKey("/api", "/stats", {}, { "x-holdup-key": ["wrong-first", valid] });
  assert.equal(wrongFirstArr.passed, false);
  assert.equal(wrongFirstArr.statusCode, 401);
  assert.deepEqual(wrongFirstArr.jsonBody, {
    type: "error",
    code: "unauthorized",
    message: "access key required",
    recoverable: false,
  });

  const emptyArr = callRequireKey("/api", "/stats", {}, { "x-holdup-key": [] });
  assert.equal(emptyArr.passed, false);
  assert.equal(emptyArr.statusCode, 401);

  const wrongQueryBeatsValidHeader = callRequireKey(
    "/api",
    "/verify",
    { key: "wrong-query" },
    { "x-holdup-key": [valid, "fallback"] },
  );
  assert.equal(wrongQueryBeatsValidHeader.passed, false);
  assert.equal(wrongQueryBeatsValidHeader.statusCode, 401);

  const emptyQueryBeatsValidHeader = callRequireKey(
    "/api",
    "/verify",
    { key: "" },
    { "x-holdup-key": [valid] },
  );
  assert.equal(emptyQueryBeatsValidHeader.passed, false);
  assert.equal(emptyQueryBeatsValidHeader.statusCode, 401);

  const validQueryBeatsWrongHeader = callRequireKey(
    "/ingest",
    "/frame",
    { key: valid },
    { "x-holdup-key": ["wrong-1", "wrong-2"] },
  );
  assert.equal(validQueryBeatsWrongHeader.passed, true);

  const arrayQueryFallsBackToArrayHeader = callRequireKey(
    "/api",
    "/stats",
    { key: ["wrong-q1", "wrong-q2"] },
    { "x-holdup-key": [valid, "wrong-h2"] },
  );
  assert.equal(arrayQueryFallsBackToArrayHeader.passed, true);

  const arrayQueryWithoutHeader = callRequireKey("/api", "/stats", { key: [valid, valid] }, {});
  assert.equal(arrayQueryWithoutHeader.passed, false);
  assert.equal(arrayQueryWithoutHeader.statusCode, 401);

  assert.equal(callRequireKey("/api", "/health").passed, true);
  assert.equal(callRequireKey("/api", "/health", { key: "wrong" }, { "x-holdup-key": ["wrong"] }).passed, true);
  assert.equal(callRequireKey("", "/api/health", { key: "wrong" }).passed, true);

  for (const [b, p] of [
    ["/api", "/healthz"],
    ["/api", "/health/"],
    ["/api", "/health/deep"],
    ["/api", "/HEALTH"],
    ["/ingest", "/health"],
  ] as const) {
    const res = callRequireKey(b, p);
    assert.equal(res.passed, false, `expected ${b}${p} to require key`);
    assert.equal(res.statusCode, 401);
  }

  assert.equal(wsKeyOk(mockWsReq({ "x-holdup-key": [valid, "wrong"] }), new URL("http://127.0.0.1/live")), true);
  assert.equal(wsKeyOk(mockWsReq({ "x-holdup-key": ["wrong", valid] }), new URL("http://127.0.0.1/live")), false);
  assert.equal(
    wsKeyOk(mockWsReq({ "x-holdup-key": [valid] }), new URL("http://127.0.0.1/live?key=wrong")),
    false,
  );
  assert.equal(
    wsKeyOk(mockWsReq({ "x-holdup-key": ["wrong"] }), new URL(`http://127.0.0.1/hud-ws?key=${valid}`)),
    true,
  );

  env.apiKey = "";
  const server = await startServer(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const pubHealth = await fetch(`${base}/api/health?key=wrong`, {
      headers: { "x-holdup-key": "wrong" },
    });
    assert.equal(pubHealth.status, 200);
    const healthPayload = (await pubHealth.json()) as { ok: boolean };
    assert.equal(healthPayload.ok, true);

    const queryPrecedence401 = await fetch(`${base}/api/stats?key=wrong`, {
      headers: { "x-holdup-key": valid },
    });
    assert.equal(queryPrecedence401.status, 401);

    const queryPrecedence200 = await fetch(`${base}/api/stats?key=${valid}`, {
      headers: { "x-holdup-key": "wrong" },
    });
    assert.equal(queryPrecedence200.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("gs1.ts enforces century boundary 50->2050 vs 51->1951 and strips ]C1 prefix", () => {
  assert.equal(gs1Date("000101"), "2000-01-01");
  assert.equal(gs1Date("500101"), "2050-01-01");
  assert.equal(gs1Date("501231"), "2050-12-31");
  assert.equal(gs1Date("500600"), "2050-06");
  assert.equal(gs1Date("510101"), "1951-01-01");
  assert.equal(gs1Date("511231"), "1951-12-31");
  assert.equal(gs1Date("510600"), "1951-06");
  assert.equal(gs1Date("991231"), "1999-12-31");
  assert.equal(gs1Date("500015"), undefined);
  assert.equal(gs1Date("511315"), undefined);
  assert.equal(gs1Date("50123"), undefined);

  const raw2050 = `]C101095011015300031750123110BATCH2050${GS}21SER2050`;
  assert.deepEqual(parseGs1(raw2050), {
    raw: raw2050,
    gtin: "09501101530003",
    expiry: "2050-12-31",
    batch: "BATCH2050",
    serial: "SER2050",
  });

  const raw1951 = `]C1${GS}01095011015300031751010010BATCH1951${GS}21SER1951`;
  assert.deepEqual(parseGs1(raw1951), {
    raw: raw1951,
    gtin: "09501101530003",
    expiry: "1951-01",
    batch: "BATCH1951",
    serial: "SER1951",
  });

  assert.equal(parseGs1("]c1010950110153000317501231"), undefined);
});

test("gs1.ts handles VAR_MAX truncation for 240, 710-714, 10, and 21 without spoofing adjacent AIs", () => {
  const overlongBatch = "B".repeat(20) + "17990101";
  const overlongSerial = "S".repeat(20) + "10SPOOF";
  const overlong240 = "A".repeat(30) + "01000000000000001751010110FAKE";
  const parsed240 = parseGs1(
    `]C1240${overlong240}${GS}01095011015300031750113010${overlongBatch}${GS}21${overlongSerial}`,
  );
  assert.ok(parsed240);
  assert.equal(parsed240.gtin, "09501101530003");
  assert.equal(parsed240.expiry, "2050-11-30");
  assert.equal(parsed240.batch, "B".repeat(20));
  assert.equal(parsed240.serial, "S".repeat(20));
  assert.equal(parseGs1(`]C1240${overlong240}`), undefined);

  for (const nhrnAi of ["710", "711", "712", "713", "714"] as const) {
    const overlongNhrn = "N".repeat(20) + "01999999999999991751010110BAD";
    const leadRaw = `]C1${nhrnAi}${overlongNhrn}${GS}01095011015300031750090010LOT-${nhrnAi}${GS}21SN-${nhrnAi}`;
    const leadParsed = parseGs1(leadRaw);
    assert.deepEqual(leadParsed, {
      raw: leadRaw,
      gtin: "09501101530003",
      expiry: "2050-09",
      batch: `LOT-${nhrnAi}`,
      serial: `SN-${nhrnAi}`,
    });

    const tailRaw = `010950110153000317510315${nhrnAi}${overlongNhrn}${GS}10${"L".repeat(25)}${GS}21${"Z".repeat(24)}`;
    const tailParsed = parseGs1(tailRaw);
    assert.deepEqual(tailParsed, {
      raw: tailRaw,
      gtin: "09501101530003",
      expiry: "1951-03-15",
      batch: "L".repeat(20),
      serial: "Z".repeat(20),
    });

    assert.equal(parseGs1(`${nhrnAi}${overlongNhrn}`), undefined);
  }
});

test("gs1.ts gtinValid() covers EAN-8, UPC-12, EAN-13, and GTIN-14 while gtin14() rejects all-zero inputs", () => {
  assert.equal(gtinValid("96385074"), true);
  assert.equal(gtinValid("73513537"), true);
  assert.equal(gtinValid("96385075"), false);

  assert.equal(gtinValid("036000291452"), true);
  assert.equal(gtinValid("512345678900"), true);
  assert.equal(gtinValid("036000291453"), false);

  assert.equal(gtinValid("4006381333931"), true);
  assert.equal(gtinValid("6416043012346"), true);
  assert.equal(gtinValid("6416043012347"), false);

  assert.equal(gtinValid("09501101530003"), true);
  assert.equal(gtinValid("06416043012346"), true);
  assert.equal(gtinValid("19501101530000"), true);
  assert.equal(gtinValid("19501101530003"), false);

  for (const invalidShape of ["", "1234567", "123456789", "1234567890", "12345678901", "095011015300030", "036000-291452", "400638133393A"]) {
    assert.equal(gtinValid(invalidShape), false, `expected gtinValid(${invalidShape}) to be false`);
  }

  for (let len = 8; len <= 14; len += 1) {
    assert.equal(gtin14("0".repeat(len)), undefined, `expected ${len} zeros to be rejected`);
  }
  assert.equal(gtin14("0000-0000-0000-00"), undefined);
  assert.equal(gtin14("0000001"), undefined);
  assert.equal(gtin14("123456789012345"), undefined);
  assert.equal(gtin14(""), undefined);
  assert.equal(gtin14(null), undefined);
  assert.equal(gtin14(undefined), undefined);

  assert.equal(gtin14("96385074"), "00000096385074");
  assert.equal(gtin14("036000291452"), "00036000291452");
  assert.equal(gtin14("6416043012346"), "06416043012346");
  assert.equal(gtin14("19501101530000"), "19501101530000");
  assert.equal(gtin14("641-6043-01234-6"), "06416043012346");
});

test("log.ts honors HOLDUP_QUIET=1 silence and enforces 160-char err vs 48-char general redaction", () => {
  const tokA = ["AIza", "SyntheticEdgeTest0123456789"].join("");
  const tokB = ["AQ.", "SyntheticVertexEdge0123456789"].join("");
  const tokC = ["sk_", "SyntheticSecretEdge0123456789"].join("");

  const s48 = "m".repeat(48);
  const s49 = "n".repeat(49);
  const s160 = "p".repeat(160);
  const s161 = "q".repeat(161);

  const r1 = redact({
    ok48: s48,
    over48: s49,
    upperErr: s49,
    ERR: s49,
    err: s49,
  });
  assert.equal(r1.ok48, s48);
  assert.equal(r1.over48, "[redacted:49ch]");
  assert.equal(r1.upperErr, "[redacted:49ch]");
  assert.equal(r1.ERR, "[redacted:49ch]");
  assert.equal(r1.err, s49);

  assert.equal(redact({ err: s160, detail: s160 }).err, s160);
  assert.equal(redact({ err: s160, detail: s160 }).detail, "[redacted:160ch]");
  assert.equal(redact({ err: s161 }).err, "[redacted:161ch]");

  const midErr = `live error a=${tokA} b=${tokB} c=${tokC}`;
  assert.ok(midErr.length > 48 && midErr.length <= 160);
  assert.equal(redact({ err: midErr }).err, "live error a=[key] b=[key] c=[key]");
  assert.equal(redact({ detail: `k=${tokA}` }).detail, "k=[key]");

  const summarized = errSummary(new Error(`502 upstream\n  ${tokB}\t${"z".repeat(220)}`));
  assert.equal(summarized.length, 160);
  assert.equal(summarized.includes(tokB), false);
  assert.equal(redact({ err: summarized }).err, summarized);

  const lines: string[] = [];
  const origConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    process.env.HOLDUP_QUIET = "1";
    log("verify.quiet", { session: "abcd1234", err: s160, detail: s49 });
    log("bare.quiet");
    assert.equal(lines.length, 0);

    delete process.env.HOLDUP_QUIET;
    log("bare.active");
    log("verify.active", {
      session: "abcd1234",
      ok48: s48,
      over48: s49,
      err: s160,
      transcript: "my evening pill",
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\.\d{3} bare\.active$/);
    assert.match(lines[1], /^\d{2}:\d{2}:\d{2}\.\d{3} verify\.active /);
    assert.equal(lines[1].includes(`ok48=${s48}`), true);
    assert.equal(lines[1].includes("over48=[redacted:49ch]"), true);
    assert.equal(lines[1].includes(`err=${s160}`), true);
    assert.equal(lines[1].includes("transcript=[redacted]"), true);
    assert.equal(lines[1].includes("evening pill"), false);
  } finally {
    console.log = origConsoleLog;
    process.env.HOLDUP_QUIET = "1";
  }
});
