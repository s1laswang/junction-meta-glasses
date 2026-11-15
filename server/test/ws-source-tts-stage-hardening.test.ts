import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { DeviceState, Profile } from "../../shared/types.ts";
import { eleven } from "../src/elevenlabs.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, markLatest, type LiveLike } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

const FAKE_SK = ["sk_", "elevenWsSourceTtsHardeningTest1234"].join("");

const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;
const origTtsModels = [...env.ttsModels];
const origGenerateContent = ai.models.generateContent;
const origModelsGet = ai.models.get;
const origFetch = globalThis.fetch;
const origEleven = {
  key: eleven.key,
  base: eleven.base,
  model: eleven.model,
  live: eleven.live,
  format: eleven.format,
  voices: { ...eleven.voices },
};

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const ledgerTmpDir = fs.mkdtempSync(path.join(shmRoot, "holdup-ws-source-tts-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");
process.env.HOLDUP_QUIET = "1";

type Msg = Record<string, any>;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

let server: http.Server;
let httpBase = "";
let wsBase = "";
const openClients: Array<{ close: () => Promise<void>; terminate: () => void }> = [];
const touchedSessions = new Set<string>();

function stubGenerateContent(fn: (params: any) => Promise<any>) {
  ai.models.generateContent = fn as typeof ai.models.generateContent;
}

function stubModelsGet(fn: (params: any) => Promise<any>) {
  ai.models.get = fn as typeof ai.models.get;
}

function mockUpstreamFetch(handler: (url: string, init?: FetchInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (httpBase && url.startsWith(httpBase)) {
      return origFetch(input, init);
    }
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function makeAudioStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) controller.enqueue(chunks[idx++]);
      else controller.close();
    },
  });
}

function makeJpegBytes(byteLen: number, fill: number): Buffer {
  const buf = Buffer.alloc(byteLen, fill & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
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

function connectWs(pathAndQuery: string, headers?: Record<string, string>) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`, headers ? { headers } : undefined);
  const msgs: Msg[] = [];
  let closeCode: number | undefined;
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    msgs.push(JSON.parse(raw.toString()) as Msg);
  });
  const closed = new Promise<number>((resolve) => {
    ws.once("close", (code) => {
      closeCode = code;
      resolve(code);
    });
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const waitFor = async (pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting on ${pathAndQuery}; msgs=${JSON.stringify(msgs)}`);
  };
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    ws.close();
    await closed;
    await new Promise<void>((r) => setImmediate(r));
  };
  const client = {
    ws,
    msgs,
    opened,
    closed,
    waitFor,
    close,
    get closeCode() {
      return closeCode;
    },
    terminate: () => {
      try {
        ws.terminate();
      } catch {}
    },
  };
  openClients.push(client);
  return client;
}

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

function resetEleven() {
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
  server = await startServer(0);
  const port = (server.address() as AddressInfo).port;
  httpBase = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  env.apiKey = "";
  env.ttsModels = ["gemini-3.8-flash-tts"];
  resetEleven();
  stubModelsGet(async () => ({ name: "models/gemini-3.8-flash" }));
  stubGenerateContent(async () => {
    throw new Error("unexpected generateContent call");
  });
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  ai.models.generateContent = origGenerateContent;
  ai.models.get = origModelsGet;
  env.apiKey = origApiKey;
  env.ttsModels = [...origTtsModels];
  resetEleven();
  delete process.env.HOLDUP_KEY;

  while (openClients.length > 0) {
    const c = openClients.pop()!;
    await c.close();
  }

  for (const id of touchedSessions) {
    const hub = getHub(id);
    if (hub) {
      hub.live = undefined;
      hub.source = "phone";
      hub.device = undefined;
      hub.dropFrames();
    }
  }
  touchedSessions.clear();
});

after(async () => {
  globalThis.fetch = origFetch;
  ai.models.generateContent = origGenerateContent;
  ai.models.get = origModelsGet;
  env.apiKey = origApiKey;
  env.ttsModels = [...origTtsModels];
  resetEleven();
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;

  for (const c of openClients.splice(0)) c.terminate();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }

  await tick(30);
  env.ledgerPath = origLedgerPath;
  fs.rmSync(ledgerTmpDir, { recursive: true, force: true });

  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("POST /api/tts and POST /api/tts/eleven reject whitespace-only text with 400 bad_input and zero upstream calls, and trim valid text", async () => {
  let geminiCalls = 0;
  let capturedGeminiPrompt = "";
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  stubGenerateContent(async (params) => {
    geminiCalls++;
    capturedGeminiPrompt = params.contents?.[0]?.parts?.[0]?.text ?? "";
    return {
      candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } }],
    };
  });

  eleven.key = FAKE_SK;
  eleven.live = true;
  let elevenCalls = 0;
  let capturedElevenText = "";
  mockUpstreamFetch((_url, init) => {
    elevenCalls++;
    capturedElevenText = JSON.parse(String(init?.body ?? "{}")).text ?? "";
    return new Response(makeAudioStream([new Uint8Array([0xff, 0xfb, 0x90, 0x64])]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  });

  for (const blank of ["   \n\t  ", "   ", "\r\n\t "]) {
    const gemRes = await fetch(`${httpBase}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: blank }),
    });
    assert.equal(gemRes.status, 400);
    const gemErr = (await gemRes.json()) as Msg;
    assert.equal(gemErr.type, "error");
    assert.equal(gemErr.code, "bad_input");
    assert.equal(gemErr.recoverable, true);

    const elRes = await fetch(`${httpBase}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: blank, lang: "en" }),
    });
    assert.equal(elRes.status, 400);
    const elErr = (await elRes.json()) as Msg;
    assert.equal(elErr.type, "error");
    assert.equal(elErr.code, "bad_input");
    assert.equal(elErr.recoverable, true);
  }

  assert.equal(geminiCalls, 0);
  assert.equal(elevenCalls, 0);

  const paddedOk = "  \n\t Yes, Amlodipine 5 mg. \t\n ";
  const okGem = await fetch(`${httpBase}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: paddedOk }),
  });
  assert.equal(okGem.status, 200);
  assert.equal(geminiCalls, 1);
  assert.equal(capturedGeminiPrompt, "Say calmly and clearly: Yes, Amlodipine 5 mg.");

  const okEl = await fetch(`${httpBase}/api/tts/eleven`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: paddedOk, lang: "en" }),
  });
  assert.equal(okEl.status, 200);
  await okEl.arrayBuffer();
  assert.equal(elevenCalls, 1);
  assert.equal(capturedElevenText, "Yes, Amlodipine 5 mg.");
});

test("POST /api/tts clamps out-of-range or missing MIME sample rates to 24000 Hz while preserving valid 8000..96000 Hz rates", async () => {
  const pcm = Buffer.from([0x10, 0x00, 0xf0, 0xff, 0x34, 0x12, 0xcd, 0xab]);

  const cases: Array<{ mimeType: string | undefined; expectedRate: number }> = [
    { mimeType: "audio/pcm;rate=0", expectedRate: 24000 },
    { mimeType: "audio/pcm;rate=500000", expectedRate: 24000 },
    { mimeType: "audio/pcm", expectedRate: 24000 },
    { mimeType: undefined, expectedRate: 24000 },
    { mimeType: "audio/pcm;rate=7999", expectedRate: 24000 },
    { mimeType: "audio/pcm;rate=96001", expectedRate: 24000 },
    { mimeType: "audio/pcm;rate=8000", expectedRate: 8000 },
    { mimeType: "audio/pcm;rate=16000", expectedRate: 16000 },
    { mimeType: "audio/pcm;rate=44100", expectedRate: 44100 },
    { mimeType: "audio/pcm;rate=96000", expectedRate: 96000 },
  ];

  for (const c of cases) {
    stubGenerateContent(async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: c.mimeType === undefined
                  ? { data: pcm.toString("base64") }
                  : { data: pcm.toString("base64"), mimeType: c.mimeType },
              },
            ],
          },
        },
      ],
    }));

    const res = await fetch(`${httpBase}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Check rate header." }),
    });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").startsWith("audio/wav"));
    const wavBuf = Buffer.from(await res.arrayBuffer());
    assertWavHeaderAndPcm(wavBuf, pcm, c.expectedRate);
  }
});

test("WS /live source message before /ingest/state updates hub.source, emits synthesized device to /hud-ws and /hud-ws?role=stage without phone echo, and enables /ingest/frame", async () => {
  const sessionId = "hardening-source-pre-state";
  touchedSessions.add(sessionId);

  const phone = connectWs(`/live?session=${sessionId}`);
  await phone.opened;
  await tick();

  const hub = getHub(sessionId)!;
  assert.ok(hub);
  hub.device = undefined;
  hub.source = "phone";
  markLatest(hub);

  const hud = connectWs("/hud-ws");
  const stage = connectWs("/hud-ws?role=stage");
  await Promise.all([hud.opened, stage.opened]);
  await tick();

  phone.msgs.length = 0;
  hud.msgs.length = 0;
  stage.msgs.length = 0;

  const droppedJpeg = makeJpegBytes(140, 0x31);
  const dropRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(droppedJpeg),
  });
  assert.equal(dropRes.status, 204);
  assert.equal(hub.ring.length, 0);

  phone.ws.send(JSON.stringify({ type: "source", source: "glasses" }));
  phone.ws.send(JSON.stringify({ type: "ping", t: 101 }));
  await phone.waitFor((m) => m.type === "pong" && m.t === 101);

  const expectedGlassesDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: null,
    streaming: false,
    source: "glasses",
  };

  assert.equal(hub.source, "glasses");
  assert.deepEqual(hub.device, expectedGlassesDevice);
  assert.equal(phone.msgs.some((m) => m.type === "device"), false);

  const hudDev = await hud.waitFor((m) => m.type === "device");
  const stageDev = await stage.waitFor((m) => m.type === "device");
  assert.deepEqual(hudDev, { type: "device", device: expectedGlassesDevice });
  assert.deepEqual(stageDev, { type: "device", device: expectedGlassesDevice });

  const acceptedJpeg = makeJpegBytes(160, 0x42);
  const acceptRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(acceptedJpeg),
  });
  assert.equal(acceptRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].data, acceptedJpeg.toString("base64"));

  const phoneInitSession = "hardening-source-phone-init";
  touchedSessions.add(phoneInitSession);
  const phone2 = connectWs(`/live?session=${phoneInitSession}`);
  const hud2 = connectWs(`/hud-ws?session=${phoneInitSession}`);
  const stage2 = connectWs(`/hud-ws?role=stage&session=${phoneInitSession}`);
  await Promise.all([phone2.opened, hud2.opened, stage2.opened]);
  await tick();

  const hub2 = getHub(phoneInitSession)!;
  hub2.device = undefined;
  phone2.msgs.length = 0;
  hud2.msgs.length = 0;
  stage2.msgs.length = 0;

  phone2.ws.send(JSON.stringify({ type: "source", source: "phone" }));
  const expectedPhoneDevice: DeviceState = {
    connected: false,
    worn: null,
    battery: null,
    streaming: false,
    source: "phone",
  };
  assert.deepEqual(await hud2.waitFor((m) => m.type === "device"), { type: "device", device: expectedPhoneDevice });
  assert.deepEqual(await stage2.waitFor((m) => m.type === "device"), { type: "device", device: expectedPhoneDevice });
  assert.equal(phone2.msgs.some((m) => m.type === "device"), false);
});

test("WS /live mid-session start while live.active updates hub.profile and hub.source, notifies /hud-ws and /hud-ws?role=stage, and enables /ingest/frame", async () => {
  const sessionId = "hardening-mid-start";
  touchedSessions.add(sessionId);

  const phone = connectWs(`/live?session=${sessionId}`);
  await phone.opened;
  await tick();

  const hub = getHub(sessionId)!;
  assert.ok(hub);
  hub.device = undefined;
  hub.source = "phone";

  const forwardedFrames: string[] = [];
  const fakeLive: LiveLike & { frame(d: string): void } = {
    active: true,
    handleEvent() {},
    stop() {},
    frame(d: string) {
      forwardedFrames.push(d);
    },
  };
  hub.live = fakeLive;
  markLatest(hub);

  const hud = connectWs("/hud-ws");
  const stage = connectWs("/hud-ws?role=stage");
  await Promise.all([hud.opened, stage.opened]);
  await tick();

  phone.msgs.length = 0;
  hud.msgs.length = 0;
  stage.msgs.length = 0;

  const profile: Profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };

  phone.ws.send(JSON.stringify({ type: "start", profile, lang: "fi", voice: true, source: "glasses" }));
  phone.ws.send(JSON.stringify({ type: "ping", t: 202 }));
  await phone.waitFor((m) => m.type === "pong" && m.t === 202);

  assert.equal(hub.live, fakeLive);
  assert.equal(hub.profile.lang, "fi");
  assert.equal(hub.profile.meds.length, 1);
  assert.equal(hub.source, "glasses");
  assert.equal(phone.msgs.some((m) => m.type === "device"), false);

  const expectedInitialGlasses: DeviceState = {
    connected: true,
    worn: true,
    battery: null,
    streaming: false,
    source: "glasses",
  };
  assert.deepEqual(await hud.waitFor((m) => m.type === "device"), { type: "device", device: expectedInitialGlasses });
  assert.deepEqual(await stage.waitFor((m) => m.type === "device"), { type: "device", device: expectedInitialGlasses });

  const frameBuf = makeJpegBytes(176, 0x55);
  const frameRes = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(frameBuf),
  });
  assert.equal(frameRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.deepEqual(forwardedFrames, [frameBuf.toString("base64")]);

  const stateRes = await fetch(`${httpBase}/ingest/state?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 78, streaming: true }),
  });
  assert.equal(stateRes.status, 204);
  await hud.waitFor((m) => m.type === "device" && m.device.battery === 78);
  await stage.waitFor((m) => m.type === "device" && m.device.battery === 78);

  hud.msgs.length = 0;
  stage.msgs.length = 0;
  phone.msgs.length = 0;

  phone.ws.send(JSON.stringify({ type: "start", profile, lang: "sv", voice: true, source: "phone" }));
  phone.ws.send(JSON.stringify({ type: "ping", t: 203 }));
  await phone.waitFor((m) => m.type === "pong" && m.t === 203);

  const expectedPreservedPhone: DeviceState = {
    connected: true,
    worn: true,
    battery: 78,
    streaming: true,
    source: "phone",
  };
  assert.equal(hub.source, "phone");
  assert.equal(hub.profile.lang, "sv");
  assert.deepEqual(await hud.waitFor((m) => m.type === "device"), { type: "device", device: expectedPreservedPhone });
  assert.deepEqual(await stage.waitFor((m) => m.type === "device"), { type: "device", device: expectedPreservedPhone });
  assert.equal(phone.msgs.some((m) => m.type === "device"), false);

  const droppedAfterSwitch = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(makeJpegBytes(152, 0x66)),
  });
  assert.equal(droppedAfterSwitch.status, 204);
  assert.equal(hub.ring.length, 1);
});

test("/hud-ws?role=stage enforces HOLDUP_KEY (4401), fans out typed text captions without phone echo, and /api/health reports glasses telemetry", async () => {
  process.env.HOLDUP_KEY = "stage-hardening-secret";
  try {
    const noKeyStage = connectWs("/hud-ws?role=stage");
    assert.equal(await noKeyStage.closed, 4401);
    assert.equal(noKeyStage.msgs.length, 0);

    const wrongKeyStage = connectWs("/hud-ws?role=stage&key=wrong-secret");
    assert.equal(await wrongKeyStage.closed, 4401);
    assert.equal(wrongKeyStage.msgs.length, 0);

    const queryKeyStage = connectWs("/hud-ws?role=stage&key=stage-hardening-secret");
    await queryKeyStage.opened;
    const headerKeyStage = connectWs("/hud-ws?role=stage", { "x-holdup-key": "stage-hardening-secret" });
    await headerKeyStage.opened;
    await tick();
    assert.equal(queryKeyStage.closeCode, undefined);
    assert.equal(headerKeyStage.closeCode, undefined);
    await queryKeyStage.close();
    await headerKeyStage.close();
  } finally {
    delete process.env.HOLDUP_KEY;
  }

  const sessionId = "hardening-stage-health";
  touchedSessions.add(sessionId);
  const phone = connectWs(`/live?session=${sessionId}`);
  await phone.opened;
  await tick();

  const hub = getHub(sessionId)!;
  const typedToLive: string[] = [];
  const forwardedGlassesFrames: string[] = [];
  hub.live = {
    active: true,
    text(t: string) {
      typedToLive.push(t);
    },
    frame(d: string) {
      forwardedGlassesFrames.push(d);
    },
    handleEvent() {},
    stop() {},
  } as unknown as LiveLike;
  hub.device = undefined;
  hub.source = "phone";
  markLatest(hub);

  const stage = connectWs("/hud-ws?role=stage");
  const hud = connectWs("/hud-ws");
  await Promise.all([stage.opened, hud.opened]);
  await tick();

  phone.msgs.length = 0;
  stage.msgs.length = 0;
  hud.msgs.length = 0;

  phone.ws.send(JSON.stringify({ type: "text", text: "   Does this contain peanuts?   " }));
  const stageCaption = await stage.waitFor((m) => m.type === "transcript");
  assert.deepEqual(stageCaption, {
    type: "transcript",
    role: "user",
    text: "Does this contain peanuts?",
    final: true,
  });
  assert.deepEqual(typedToLive, ["   Does this contain peanuts?   "]);
  assert.equal(phone.msgs.some((m) => m.type === "transcript"), false);
  assert.equal(hud.msgs.some((m) => m.type === "transcript"), false);

  const h0Res = await fetch(`${httpBase}/api/health`);
  assert.equal(h0Res.status, 200);
  const h0 = (await h0Res.json()) as Msg;
  const baseAccepted = h0.glasses.framesAccepted as number;
  const baseDropped = h0.glasses.framesDropped as number;
  assert.equal(typeof baseAccepted, "number");
  assert.equal(typeof baseDropped, "number");

  const dropRes = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(makeJpegBytes(144, 0x71)),
  });
  assert.equal(dropRes.status, 204);

  const h1 = (await (await fetch(`${httpBase}/api/health`)).json()) as Msg;
  assert.equal(h1.glasses.framesAccepted, baseAccepted);
  assert.equal(h1.glasses.framesDropped, baseDropped + 1);
  assert.equal(h1.glasses.source, "phone");

  phone.ws.send(JSON.stringify({ type: "source", source: "glasses" }));
  await stage.waitFor((m) => m.type === "device" && m.device.source === "glasses");

  for (const tag of [0x72, 0x73]) {
    const okRes = await fetch(`${httpBase}/ingest/frame`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(makeJpegBytes(168, tag)),
    });
    assert.equal(okRes.status, 204);
  }

  const h2 = (await (await fetch(`${httpBase}/api/health`)).json()) as Msg;
  assert.equal(forwardedGlassesFrames.length, 2);
  assert.equal(h2.glasses.framesAccepted, baseAccepted + 2);
  assert.equal(h2.glasses.framesDropped, baseDropped + 1);
  assert.equal(typeof h2.glasses.lastFrameAgoS, "number");
  assert.ok(h2.glasses.lastFrameAgoS >= 0 && h2.glasses.lastFrameAgoS < 5);
  assert.equal(h2.glasses.source, "glasses");
  assert.deepEqual(h2.glasses.device, {
    connected: true,
    worn: true,
    battery: null,
    streaming: false,
    source: "glasses",
  });
});
