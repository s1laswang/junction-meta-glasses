import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getOrCreateHub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { toProfile } from "../src/verify.ts";

const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origLedgerPath = env.ledgerPath;
const origTtsModels = [...env.ttsModels];
const origVerifyModels = [...env.verifyModels];
const origGenerateContent = ai.models.generateContent;

const ledgerTmpDir = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-f4-routes-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");
process.env.HOLDUP_QUIET = "1";

let server: http.Server;
let baseUrl = "";

function stubGenerateContent(fn: (params: any) => Promise<any>) {
  ai.models.generateContent = fn as typeof ai.models.generateContent;
}

function makeBase64JpegOfLength(minChars: number, tag: number): string {
  const byteLen = Math.ceil((minChars * 3) / 4) + 6;
  const buf = Buffer.alloc(byteLen, tag & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf.toString("base64");
}

function assertWavHeaderAndPcm(wavBuf: Buffer, expectedPcm: Buffer, expectedRate: number) {
  assert.equal(wavBuf.length, 44 + expectedPcm.length);
  assert.equal(wavBuf.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wavBuf.readUInt32LE(4), 36 + expectedPcm.length);
  assert.equal(wavBuf.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wavBuf.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wavBuf.readUInt32LE(16), 16);
  assert.equal(wavBuf.readUInt16LE(20), 1);
  assert.equal(wavBuf.readUInt16LE(22), 1);
  assert.equal(wavBuf.readUInt32LE(24), expectedRate);
  assert.equal(wavBuf.readUInt32LE(28), expectedRate * 2);
  assert.equal(wavBuf.readUInt16LE(32), 2);
  assert.equal(wavBuf.readUInt16LE(34), 16);
  assert.equal(wavBuf.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wavBuf.readUInt32LE(40), expectedPcm.length);
  assert.deepEqual(wavBuf.subarray(44), expectedPcm);
}

const savedProfile: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

const amlodipineRead: LabelRead = {
  kind: "medication",
  product: { value: "Norvasc 5 mg", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.95 },
  strength: { value: "5 mg", confidence: 0.94 },
  dosing: { value: "1 tablet once daily", confidence: 0.88 },
  expiry: { value: "2027-08", confidence: 0.92 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: "6432100099991", confidence: 0.9 },
  readability: 0.93,
};

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  baseUrl = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  env.ttsModels = ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"];
  env.verifyModels = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
});

afterEach(() => {
  ai.models.generateContent = origGenerateContent;
  env.ttsModels = [...origTtsModels];
  env.verifyModels = [...origVerifyModels];
});

after(async () => {
  ai.models.generateContent = origGenerateContent;
  env.ttsModels = [...origTtsModels];
  env.verifyModels = [...origVerifyModels];
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;

  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await new Promise((resolve) => setTimeout(resolve, 40));
  env.ledgerPath = origLedgerPath;
  fs.rmSync(ledgerTmpDir, { recursive: true, force: true });

  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("POST /api/tts returns 200 audio/wav with valid 44-byte RIFF/WAVE PCM16 mono header for 24000 Hz and 16000 Hz", async () => {
  const pcm24k = Buffer.from([0x00, 0x80, 0xff, 0x7f, 0x34, 0x12, 0xcd, 0xab, 0x01, 0x00, 0xfe, 0xff]);
  stubGenerateContent(async () => ({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { data: pcm24k.toString("base64"), mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 40 },
  }));

  const res24 = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Yes, Amlodipine 5 mg, your evening pill." }),
  });
  assert.equal(res24.status, 200);
  const ct24 = res24.headers.get("content-type") ?? "";
  assert.ok(ct24.startsWith("audio/wav"));
  const wav24 = Buffer.from(await res24.arrayBuffer());
  assertWavHeaderAndPcm(wav24, pcm24k, 24000);

  const pcm16k = Buffer.from([
    0x10, 0x02, 0xf0, 0xfd, 0x55, 0x15, 0xaa, 0xea,
    0x08, 0x04, 0xf8, 0xfb, 0x00, 0x00, 0x99, 0x29,
  ]);
  stubGenerateContent(async () => ({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" } }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 30 },
  }));

  const res16 = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Turn the box slowly." }),
  });
  assert.equal(res16.status, 200);
  const ct16 = res16.headers.get("content-type") ?? "";
  assert.ok(ct16.startsWith("audio/wav"));
  const wav16 = Buffer.from(await res16.arrayBuffer());
  assertWavHeaderAndPcm(wav16, pcm16k, 16000);

  stubGenerateContent(async () => ({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { data: pcm24k.toString("base64"), mimeType: "audio/pcm" } }],
        },
      },
    ],
  }));
  const resDefaultRate = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Default rate check." }),
  });
  assert.equal(resDefaultRate.status, 200);
  assertWavHeaderAndPcm(Buffer.from(await resDefaultRate.arrayBuffer()), pcm24k, 24000);
});

test("POST /api/tts falls back across env.ttsModels on throw or empty inlineData, and returns 503 when all fail", async () => {
  const pcmFallback = Buffer.from([0x22, 0x01, 0xde, 0xfe, 0x44, 0x03, 0xbc, 0xfc]);

  const modelsOnThrow: string[] = [];
  stubGenerateContent(async (params) => {
    modelsOnThrow.push(params.model);
    if (modelsOnThrow.length === 1) {
      throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
    }
    return {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pcmFallback.toString("base64"), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      ],
    };
  });

  const throwFallbackRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Fallback after throw." }),
  });
  assert.equal(throwFallbackRes.status, 200);
  assert.deepEqual(modelsOnThrow, [env.ttsModels[0], env.ttsModels[1]]);
  assertWavHeaderAndPcm(Buffer.from(await throwFallbackRes.arrayBuffer()), pcmFallback, 24000);

  const modelsOnEmpty: string[] = [];
  stubGenerateContent(async (params) => {
    modelsOnEmpty.push(params.model);
    if (modelsOnEmpty.length === 1) {
      return {
        candidates: [{ content: { parts: [{ inlineData: { data: "", mimeType: "audio/pcm;rate=24000" } }] } }],
      };
    }
    return {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pcmFallback.toString("base64"), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      ],
    };
  });

  const emptyFallbackRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Fallback after empty inlineData." }),
  });
  assert.equal(emptyFallbackRes.status, 200);
  assert.deepEqual(modelsOnEmpty, [env.ttsModels[0], env.ttsModels[1]]);
  assertWavHeaderAndPcm(Buffer.from(await emptyFallbackRes.arrayBuffer()), pcmFallback, 24000);

  const modelsAllFail: string[] = [];
  stubGenerateContent(async (params) => {
    modelsAllFail.push(params.model);
    if (modelsAllFail.length === 1) {
      throw new Error("network reset");
    }
    return { candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
  });

  const failRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "All TTS models down." }),
  });
  assert.equal(failRes.status, 503);
  assert.deepEqual(modelsAllFail, [env.ttsModels[0], env.ttsModels[1]]);
  const failJson = (await failRes.json()) as Record<string, unknown>;
  assert.equal(failJson.type, "error");
  assert.equal(failJson.code, "gemini_unavailable");
  assert.equal(failJson.recoverable, true);
});

test("POST /api/tts truncates text longer than 600 chars in prompt sent to generateContent and rejects empty text", async () => {
  let calls = 0;
  let capturedPrompt = "";
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  stubGenerateContent(async (params) => {
    calls++;
    capturedPrompt = params.contents?.[0]?.parts?.[0]?.text ?? "";
    return {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      ],
    };
  });

  const missingRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(missingRes.status, 400);
  assert.equal(calls, 0);

  const prefix600 = "A".repeat(595) + "12345";
  const overlongText = prefix600 + "SHOULD_NOT_APPEAR_IN_PROMPT_" + "Z".repeat(120);
  assert.equal(prefix600.length, 600);
  assert.ok(overlongText.length > 700);

  const okRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: overlongText }),
  });
  assert.equal(okRes.status, 200);
  assert.equal(calls, 1);
  assert.equal(capturedPrompt, `Say calmly and clearly: ${prefix600}`);
  assert.equal(capturedPrompt.includes("SHOULD_NOT_APPEAR_IN_PROMPT_"), false);
});

test("POST /api/verify picks top 2 largest among last 3 of 4 base64 JPEGs and returns 200 match Verdict", async () => {
  const frame0LargestOverall = makeBase64JpegOfLength(620, 0x11);
  const frame1Medium = makeBase64JpegOfLength(340, 0x22);
  const frame2Smallest = makeBase64JpegOfLength(160, 0x33);
  const frame3LargestInLastThree = makeBase64JpegOfLength(480, 0x44);

  assert.ok(frame0LargestOverall.length > frame3LargestInLastThree.length);
  assert.ok(frame3LargestInLastThree.length > frame1Medium.length);
  assert.ok(frame1Medium.length > frame2Smallest.length);
  assert.ok(frame2Smallest.length > 100);

  let receivedImages: string[] = [];
  let receivedPrompt = "";
  stubGenerateContent(async (params) => {
    const parts = params.contents?.[0]?.parts ?? [];
    receivedImages = parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.data);
    receivedPrompt = parts.find((p: any) => typeof p.text === "string")?.text ?? "";
    return {
      text: JSON.stringify(amlodipineRead),
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 60 },
    };
  });

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [frame0LargestOverall, frame1Medium, frame2Smallest, frame3LargestInLastThree],
      profile: savedProfile,
      question: "Is this my evening pill?",
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(receivedImages, [frame3LargestInLastThree, frame1Medium]);
  assert.match(receivedPrompt, /Is this my evening pill\?/);

  const verdict = (await res.json()) as Verdict;
  assert.equal(verdict.level, "match");
  assert.equal(verdict.matchedMedId, "aml");
  assert.equal(verdict.takenToday, false);
  assert.equal(verdict.read.ingredient.value, "amlodipine");
  assert.equal(verdict.read.strength.value, "5 mg");
});

test("POST /api/verify with active session hub reads 2 sharpest frames from hub.ring and uses hub.profile", async () => {
  const sessionId = "f4-routes-hub-session";
  const hub = getOrCreateHub(sessionId);
  hub.dropFrames();
  hub.profile = toProfile({
    meds: [{ id: "met", name: "Glucophage", ingredient: "metformin", strength: "500 mg", schedule: ["morning"] }],
    allergies: ["tree nuts"],
    avoid: [],
    doseLog: [],
    lang: "en",
  });

  const now = Date.now();
  const blurry = makeBase64JpegOfLength(200, 0x51);
  const sharpest = makeBase64JpegOfLength(220, 0x52);
  const medium = makeBase64JpegOfLength(240, 0x53);
  const secondSharpest = makeBase64JpegOfLength(260, 0x54);

  hub.ring.push({ data: blurry, sharpness: 0.2, ts: now - 400, bytes: 150, source: "glasses" });
  hub.ring.push({ data: sharpest, sharpness: 0.94, ts: now - 300, bytes: 165, source: "glasses" });
  hub.ring.push({ data: medium, sharpness: 0.52, ts: now - 200, bytes: 180, source: "glasses" });
  hub.ring.push({ data: secondSharpest, sharpness: 0.81, ts: now - 100, bytes: 195, source: "glasses" });

  const metforminRead: LabelRead = {
    kind: "medication",
    product: { value: "Glucophage 500 mg", confidence: 0.95 },
    ingredient: { value: "metformin", confidence: 0.94 },
    strength: { value: "500 mg", confidence: 0.93 },
    dosing: { value: "1 tablet", confidence: 0.85 },
    expiry: { value: "2027-11", confidence: 0.9 },
    allergens: { value: null, confidence: 0 },
    barcode: { value: null, confidence: 0 },
    readability: 0.91,
  };

  let receivedImages: string[] = [];
  stubGenerateContent(async (params) => {
    const parts = params.contents?.[0]?.parts ?? [];
    receivedImages = parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.data);
    return {
      text: JSON.stringify(metforminRead),
      usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 55 },
    };
  });

  try {
    const res = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(receivedImages, [sharpest, secondSharpest]);

    const verdict = (await res.json()) as Verdict;
    assert.equal(verdict.level, "match");
    assert.equal(verdict.matchedMedId, "met");
    assert.equal(verdict.read.ingredient.value, "metformin");

    hub.dropFrames();
    const emptyRingRes = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId }),
    });
    assert.equal(emptyRingRes.status, 409);
    const emptyErr = (await emptyRingRes.json()) as Record<string, unknown>;
    assert.equal(emptyErr.code, "no_frames");
  } finally {
    hub.dropFrames();
  }
});

test("POST /api/verify returns 200 degraded unsure Verdict with reader unavailable when all verifyModels fail", async () => {
  const seenModels: string[] = [];
  stubGenerateContent(async (params) => {
    seenModels.push(params.model);
    throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
  });

  const singleFrame = makeBase64JpegOfLength(250, 0x77);
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [singleFrame],
      profile: savedProfile,
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seenModels, [
    env.verifyModels[0],
    env.verifyModels[0],
    env.verifyModels[1],
    env.verifyModels[2],
  ]);

  const verdict = (await res.json()) as Verdict;
  assert.equal(verdict.level, "unsure");
  assert.ok(verdict.reasons.includes("reader unavailable"));
  assert.equal(verdict.read.kind, "unreadable");
});

test("POST /api/verify rejects missing or short frames without active session with 400 bad_input", async () => {
  let called = false;
  stubGenerateContent(async () => {
    called = true;
    return { text: JSON.stringify(amlodipineRead) };
  });

  const noFramesRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: ["short-base64", 42], session: "nonexistent-hub-id" }),
  });
  assert.equal(noFramesRes.status, 400);
  assert.equal(called, false);
  const errBody = (await noFramesRes.json()) as Record<string, unknown>;
  assert.equal(errBody.type, "error");
  assert.equal(errBody.code, "bad_input");
  assert.equal(errBody.recoverable, true);
});
