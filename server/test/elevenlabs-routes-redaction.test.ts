import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { eleven, elevenEnabled } from "../src/elevenlabs.ts";
import { env } from "../src/env.ts";
import { startServer } from "../src/index.ts";
import { stats, type LedgerLine } from "../src/ledger.ts";
import { errSummary, log, redact } from "../src/log.ts";

const FAKE_AIZA = ["AIza", "SyTestGeminiKey1234567890"].join("");
const FAKE_AQ = ["AQ.", "Ab8RN6LVertexExpressKey12345._-xyz"].join("");
const FAKE_SK = ["sk_", "elevenlabsSecretKey1234567890abcdef"].join("");

const origFetch = globalThis.fetch;
const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origSttModel = process.env.ELEVENLABS_STT_MODEL;
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
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-eleven-${label}-`));
  tempDirs.push(dir);
  const ledgerFile = path.join(dir, "ledger.jsonl");
  env.ledgerPath = ledgerFile;
  return ledgerFile;
}

async function waitForLines(filePath: string, expectedCount: number, timeoutMs = 3000): Promise<LedgerLine[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      if (lines.length >= expectedCount) {
        return lines.map((l) => JSON.parse(l) as LedgerLine);
      }
    } catch {
      void 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const finalLines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean) : [];
  assert.equal(finalLines.length, expectedCount, `Expected ${expectedCount} ledger lines in ${filePath}`);
  return finalLines.map((l) => JSON.parse(l) as LedgerLine);
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

function makeAudioStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx++]);
      } else {
        controller.close();
      }
    },
  });
}

function resetElevenState() {
  eleven.key = origEleven.key;
  eleven.base = origEleven.base;
  eleven.model = origEleven.model;
  eleven.live = origEleven.live;
  eleven.format = origEleven.format;
  eleven.voices = { ...origEleven.voices };
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
  delete process.env.ELEVENLABS_STT_MODEL;
  resetElevenState();
  eleven.base = "https://api.elevenlabs.io";
  eleven.model = "eleven_flash_v2_5";
  eleven.format = "mp3_44100_64";
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetElevenState();
  if (origSttModel === undefined) delete process.env.ELEVENLABS_STT_MODEL;
  else process.env.ELEVENLABS_STT_MODEL = origSttModel;
});

after(async () => {
  globalThis.fetch = origFetch;
  resetElevenState();
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  if (origSttModel === undefined) delete process.env.ELEVENLABS_STT_MODEL;
  else process.env.ELEVENLABS_STT_MODEL = origSttModel;

  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  env.ledgerPath = origLedgerPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("POST /api/tts/eleven and GET /api/stt/token return 404 disabled when ELEVENLABS_API_KEY is empty", async () => {
  eleven.key = "";
  eleven.live = true;
  assert.equal(elevenEnabled(), false);

  let upstreamCalls = 0;
  mockUpstreamFetch(() => {
    upstreamCalls++;
    return new Response("unexpected", { status: 500 });
  });

  const ttsRes = await fetch(`${baseUrl}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Yes, Amlodipine 5 mg, your evening pill.", lang: "en" }),
  });
  assert.equal(ttsRes.status, 404);
  const ttsJson = (await ttsRes.json()) as Record<string, unknown>;
  assert.equal(ttsJson.type, "error");
  assert.equal(ttsJson.code, "disabled");
  assert.equal(ttsJson.recoverable, true);

  const sttRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(sttRes.status, 404);
  const sttJson = (await sttRes.json()) as Record<string, unknown>;
  assert.equal(sttJson.type, "error");
  assert.equal(sttJson.code, "disabled");
  assert.equal(sttJson.recoverable, true);

  assert.equal(upstreamCalls, 0);
});

test("POST /api/tts/eleven returns 404 disabled when ELEVENLABS_API_KEY is set but ELEVENLABS_LIVE is false", async () => {
  eleven.key = FAKE_SK;
  eleven.live = false;
  assert.equal(elevenEnabled(), true);

  let upstreamCalls = 0;
  mockUpstreamFetch(() => {
    upstreamCalls++;
    return new Response("unexpected", { status: 500 });
  });

  const res = await fetch(`${baseUrl}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Yes, Amlodipine 5 mg.", lang: "en" }),
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "disabled");
  assert.equal(body.recoverable, true);
  assert.equal(upstreamCalls, 0);
});

test("POST /api/tts/eleven returns 400 bad_input on missing or empty text when enabled", async () => {
  eleven.key = FAKE_SK;
  eleven.live = true;

  let upstreamCalls = 0;
  mockUpstreamFetch(() => {
    upstreamCalls++;
    return new Response("unexpected", { status: 500 });
  });

  for (const payload of [{}, { text: "" }, { text: 123 }]) {
    const res = await fetch(`${baseUrl}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.type, "error");
    assert.equal(body.code, "bad_input");
    assert.equal(body.message, "text required");
    assert.equal(body.recoverable, true);
  }

  assert.equal(upstreamCalls, 0);
});

test("POST /api/tts/eleven streams audio/mpeg, sets X-First-Byte-S, passes EN/FI/SV voice IDs and apply_text_normalization, and records tts_eleven ok:true in ledger", async () => {
  const ledgerFile = makeTempLedger("tts-ok");
  eleven.key = FAKE_SK;
  eleven.live = true;
  eleven.voices = {
    en: "EXAVITQu4vr4xnSDxMaL",
    fi: "XB0fDUnXU5powFXDhCwa",
    sv: "voice_sv_distinct_test",
  };

  const chunk1 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02]);
  const chunk2 = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
  const expectedMp3 = Buffer.concat([Buffer.from(chunk1), Buffer.from(chunk2)]);

  const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  mockUpstreamFetch((url, init) => {
    const hdrs = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: hdrs,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(makeAudioStream([chunk1, chunk2]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  });

  const cases: Array<{ reqLang?: string; expectedLang: string; expectedVoice: string; text: string }> = [
    { reqLang: "en", expectedLang: "en", expectedVoice: "EXAVITQu4vr4xnSDxMaL", text: "Yes, Amlodipine 5 mg." },
    { reqLang: "fi", expectedLang: "fi", expectedVoice: "XB0fDUnXU5powFXDhCwa", text: "Kylla, Amlodipine 5 mg." },
    { reqLang: "sv", expectedLang: "sv", expectedVoice: "voice_sv_distinct_test", text: "Ja, Amlodipine 5 mg." },
    { reqLang: "de", expectedLang: "en", expectedVoice: "EXAVITQu4vr4xnSDxMaL", text: "Fallback language check." },
  ];

  for (const c of cases) {
    const res = await fetch(`${baseUrl}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: c.text, lang: c.reqLang }),
    });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").startsWith("audio/mpeg"));

    const ttfb = res.headers.get("x-first-byte-s");
    assert.ok(ttfb !== null && /^\d+\.\d{3}$/.test(ttfb));
    assert.ok(Number(ttfb) >= 0);

    for (const [hk, hv] of res.headers.entries()) {
      assert.equal(hk.toLowerCase().includes("xi-api-key"), false);
      assert.equal(hv.includes(FAKE_SK), false);
    }

    const audioBytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(audioBytes, expectedMp3);
  }

  assert.equal(captured.length, 4);
  for (let i = 0; i < cases.length; i++) {
    const req = captured[i];
    const exp = cases[i];
    assert.equal(req.method, "POST");
    assert.equal(req.url, `https://api.elevenlabs.io/v1/text-to-speech/${exp.expectedVoice}/stream?output_format=mp3_44100_64`);
    assert.equal(req.headers["xi-api-key"], FAKE_SK);
    assert.equal(req.headers.Accept, "audio/mpeg");
    assert.equal(req.body.text, exp.text);
    assert.equal(req.body.model_id, "eleven_flash_v2_5");
    assert.equal(req.body.language_code, exp.expectedLang);
    assert.equal(req.body.apply_text_normalization, "on");
  }

  const rows = await waitForLines(ledgerFile, 4);
  const rawLedger = fs.readFileSync(ledgerFile, "utf8");
  assert.equal(rawLedger.includes(FAKE_SK), false);
  assert.equal(rawLedger.includes("Amlodipine"), false);

  for (const row of rows) {
    assert.equal(row.feature, "tts_eleven");
    assert.equal(row.model, "eleven_flash_v2_5");
    assert.equal(row.ok, true);
    assert.equal(typeof row.latency_s, "number");
    assert.equal(typeof row.first_audio_s, "number");
  }

  const agg = stats().features.tts_eleven as Record<string, unknown>;
  assert.equal(agg.calls, 4);
  assert.equal(agg.ok, 4);
  assert.equal(agg.errors, 0);
});

test("POST /api/tts/eleven returns 503 tts_unavailable with recoverable:true on upstream HTTP 500 and 429", async () => {
  const ledgerFile = makeTempLedger("tts-err");
  eleven.key = FAKE_SK;
  eleven.live = true;

  const statuses = [500, 429];
  let callIdx = 0;
  mockUpstreamFetch(() => {
    const status = statuses[callIdx++] ?? 500;
    return new Response("upstream failure", { status });
  });

  for (const expectedUpstream of statuses) {
    const res = await fetch(`${baseUrl}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Test upstream ${expectedUpstream}`, lang: "en" }),
    });
    assert.equal(res.status, 503);
    const errJson = (await res.json()) as Record<string, unknown>;
    assert.equal(errJson.type, "error");
    assert.equal(errJson.code, "tts_unavailable");
    assert.equal(errJson.recoverable, true);
    assert.equal(JSON.stringify(errJson).includes(FAKE_SK), false);
  }

  assert.equal(callIdx, 2);
  const rows = await waitForLines(ledgerFile, 2);
  for (const row of rows) {
    assert.equal(row.feature, "tts_eleven");
    assert.equal(row.ok, false);
  }
});

test("GET /api/stt/token returns token and model via mocked fetch without leaking xi-api-key and returns 503 stt_unavailable on upstream error", async () => {
  eleven.key = FAKE_SK;
  eleven.live = false;

  let seenUrl = "";
  let seenMethod = "";
  let seenHeaders: Record<string, string> = {};
  mockUpstreamFetch((url, init) => {
    seenUrl = url;
    seenMethod = init?.method ?? "GET";
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return Response.json({ token: "sut_ephemeral_scribe_token_99" });
  });

  const okRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(okRes.status, 200);
  const rawText = await okRes.text();
  assert.equal(rawText.includes(FAKE_SK), false);
  assert.equal(rawText.toLowerCase().includes("xi-api-key"), false);
  for (const [hk, hv] of okRes.headers.entries()) {
    assert.equal(hk.toLowerCase().includes("xi-api-key"), false);
    assert.equal(hv.includes(FAKE_SK), false);
  }

  const okJson = JSON.parse(rawText) as { token: string; model: string };
  assert.deepEqual(okJson, { token: "sut_ephemeral_scribe_token_99", model: "scribe_v2_realtime" });
  assert.equal(seenUrl, "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
  assert.equal(seenMethod, "POST");
  assert.equal(seenHeaders["xi-api-key"], FAKE_SK);

  process.env.ELEVENLABS_STT_MODEL = "scribe_v2_custom";
  const customModelRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(customModelRes.status, 200);
  assert.deepEqual(await customModelRes.json(), {
    token: "sut_ephemeral_scribe_token_99",
    model: "scribe_v2_custom",
  });

  mockUpstreamFetch(() => new Response("rate limited", { status: 429 }));
  const errRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(errRes.status, 503);
  const errBody = (await errRes.json()) as Record<string, unknown>;
  assert.equal(errBody.type, "error");
  assert.equal(errBody.code, "stt_unavailable");
  assert.equal(errBody.recoverable, true);
  assert.equal(JSON.stringify(errBody).includes(FAKE_SK), false);

  mockUpstreamFetch(() => {
    throw new Error(`network failure for xi-api-key=${FAKE_SK}`);
  });
  const throwRes = await fetch(`${baseUrl}/api/stt/token`);
  assert.equal(throwRes.status, 503);
  const throwBody = (await throwRes.json()) as Record<string, unknown>;
  assert.equal(throwBody.code, "stt_unavailable");
  assert.equal(JSON.stringify(throwBody).includes(FAKE_SK), false);
});

test("redact() and errSummary() mask AIza, AQ., and sk_ secrets to [key] while preserving existing field redaction rules", () => {
  const deniedKeys = [
    "text", "data", "transcript", "image", "frame", "frames", "audio",
    "profile", "speech", "headline", "question", "args", "prompt",
    "body", "key", "apikey", "api_key", "value", "API_KEY", "Speech",
  ];

  const input: Record<string, string | number | boolean | null | undefined> = {
    session: "ab12cd34",
    ms: 85,
    ok: true,
    device: null,
    omitted: undefined,
    gTok: `k=${FAKE_AIZA}`,
    vTok: `k=${FAKE_AQ}`,
    eTok: `k=${FAKE_SK}`,
    bareSk: FAKE_SK,
    safeIdentifier: "task_1234567890abcdef",
    exact48: "x".repeat(48),
    over48: "y".repeat(49),
    err: `failed keys ${FAKE_AIZA} and ${FAKE_AQ} and ${FAKE_SK}`,
  };
  for (const k of deniedKeys) input[k] = "sensitive medication content";

  const out = redact(input);
  for (const k of deniedKeys) {
    assert.equal(out[k], "[redacted]", `expected ${k} to be [redacted]`);
  }
  assert.equal(out.session, "ab12cd34");
  assert.equal(out.ms, 85);
  assert.equal(out.ok, true);
  assert.equal(out.device, null);
  assert.equal("omitted" in out, false);
  assert.equal(out.gTok, "k=[key]");
  assert.equal(out.vTok, "k=[key]");
  assert.equal(out.eTok, "k=[key]");
  assert.equal(out.bareSk, "[key]");
  assert.equal(out.safeIdentifier, "task_1234567890abcdef");
  assert.equal(out.exact48, "x".repeat(48));
  assert.equal(out.over48, "[redacted:49ch]");
  assert.equal(out.err, "failed keys [key] and [key] and [key]");
  assert.equal(redact({ err: "z".repeat(161) }).err, "[redacted:161ch]");

  const multiSecretErr = new Error(
    `Auth failed:\n  gemini=${FAKE_AIZA}\tvertex=${FAKE_AQ}\n  eleven=${FAKE_SK} on task_1234567890abcdef`,
  );
  const summary = errSummary(multiSecretErr);
  assert.equal(summary, "Auth failed: gemini=[key] vertex=[key] eleven=[key] on task_1234567890abcdef");
  assert.equal(summary.includes(FAKE_AIZA), false);
  assert.equal(summary.includes(FAKE_AQ), false);
  assert.equal(summary.includes(FAKE_SK), false);

  const rawLong = errSummary(`raw ${FAKE_AQ} ${FAKE_SK} ${"w".repeat(200)}`);
  assert.ok(rawLong.startsWith("raw [key] [key] "));
  assert.equal(rawLong.length, 160);

  const capturedLogs: string[] = [];
  const origConsoleLog = console.log;
  const prevQuiet = process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };
  try {
    delete process.env.HOLDUP_QUIET;
    log("eleven.redaction_check", {
      err: errSummary(new Error(`bad ${FAKE_AIZA} ${FAKE_AQ} ${FAKE_SK}`)),
      speech: "Take Amlodipine 5 mg",
    });
    assert.equal(capturedLogs.length, 1);
    assert.match(capturedLogs[0], /err=bad \[key\] \[key\] \[key\]/);
    assert.match(capturedLogs[0], /speech=\[redacted\]/);
    assert.equal(capturedLogs[0].includes(FAKE_AIZA), false);
    assert.equal(capturedLogs[0].includes(FAKE_AQ), false);
    assert.equal(capturedLogs[0].includes(FAKE_SK), false);
    assert.equal(capturedLogs[0].includes("Amlodipine"), false);
  } finally {
    console.log = origConsoleLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});
