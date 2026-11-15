import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { DeviceState } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, getOrCreateHub, markLatest, type Hub, type LiveLike } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { jpegSharpness } from "../src/verify.ts";

const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;
const origLiveModels = [...env.liveModels];
const origVerifyModels = [...env.verifyModels];
const origTtsModels = [...env.ttsModels];
const origVersion = env.version;
const origModelsGet = ai.models.get;
const origGenerateContent = ai.models.generateContent;
const origDateNow = Date.now;

const ledgerTmpDir = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-f4-ingest-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");
process.env.HOLDUP_QUIET = "1";

type Msg = Record<string, unknown>;

let server: http.Server;
let httpBase = "";
let wsBase = "";
const openHelpers: Array<{ close: () => Promise<void>; terminate: () => void }> = [];
const touchedHubIds = new Set<string>();

function stubModelsGet(fn: (params: any) => Promise<any>) {
  ai.models.get = fn as typeof ai.models.get;
}

function stubGenerateContent(fn: (params: any) => Promise<any>) {
  ai.models.generateContent = fn as typeof ai.models.generateContent;
}

function createTrackedHub(id: string): Hub {
  touchedHubIds.add(id);
  const hub = getOrCreateHub(id);
  hub.dropFrames();
  hub.live = undefined;
  hub.source = "phone";
  return hub;
}

function makeJpegBytes(byteLen: number, fillByte: number): Buffer {
  const buf = Buffer.alloc(byteLen, fillByte & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

function connectWs(pathAndQuery: string) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`);
  const queue: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as Msg;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (timeoutMs = 3000): Promise<Msg> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS timeout on ${pathAndQuery}`)), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const helper = {
    ws,
    open,
    next,
    close,
    queue,
    terminate: () => {
      try {
        ws.terminate();
      } catch {}
    },
  };
  openHelpers.push(helper);
  return helper;
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  httpBase = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
  wsBase = ["ws:", "", `127.0.0.1:${addr.port}`].join("/");
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  env.apiKey = "test-gemini-health-key";
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
  env.verifyModels = ["gemini-3.8-flash", "gemini-3.5-flash"];
  env.ttsModels = ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"];
  env.version = "0.1.0";
  stubGenerateContent(async () => {
    throw new Error("unexpected generateContent call in ingest/health test");
  });
});

afterEach(async () => {
  Date.now = origDateNow;
  ai.models.get = origModelsGet;
  ai.models.generateContent = origGenerateContent;
  env.apiKey = origApiKey;
  env.liveModels = [...origLiveModels];
  env.verifyModels = [...origVerifyModels];
  env.ttsModels = [...origTtsModels];
  env.version = origVersion;

  while (openHelpers.length > 0) {
    const h = openHelpers.pop()!;
    await h.close();
  }

  for (const id of touchedHubIds) {
    const hub = getHub(id);
    if (hub) {
      hub.live = undefined;
      hub.source = "phone";
      hub.dropFrames();
    }
  }
});

after(async () => {
  Date.now = origDateNow;
  ai.models.get = origModelsGet;
  ai.models.generateContent = origGenerateContent;
  env.apiKey = origApiKey;
  env.liveModels = [...origLiveModels];
  env.verifyModels = [...origVerifyModels];
  env.ttsModels = [...origTtsModels];
  env.version = origVersion;

  for (const h of openHelpers.splice(0)) h.terminate();

  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;

  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  env.ledgerPath = origLedgerPath;
  fs.rmSync(ledgerTmpDir, { recursive: true, force: true });

  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("GET /api/health returns models, version, sessions, floatingHuds and caches ai.models.get for 30s", async () => {
  let fakeNow = origDateNow() - 120_000;
  Date.now = () => fakeNow;

  const modelCalls: string[] = [];
  let rejectGet = false;
  stubModelsGet(async (params) => {
    modelCalls.push(params.model);
    if (rejectGet) throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
    return { name: `models/${params.model}` };
  });

  const res1 = await fetch(`${httpBase}/api/health`);
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as Record<string, any>;
  assert.equal(body1.ok, true);
  assert.equal(body1.gemini, "ok");
  assert.deepEqual(body1.models, {
    live: env.liveModels,
    verify: env.verifyModels,
    tts: env.ttsModels,
  });
  assert.equal(body1.version, env.version);
  assert.equal(body1.sessions, 0);
  assert.equal(body1.latest, null);
  assert.equal(body1.floatingHuds, 0);
  assert.deepEqual(modelCalls, [env.verifyModels[0]]);

  rejectGet = true;
  fakeNow += 15_000;
  const floatingHud = connectWs("/hud-ws");
  await floatingHud.open;
  createTrackedHub("health-session-count");

  const res2 = await fetch(`${httpBase}/api/health`);
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as Record<string, any>;
  assert.equal(modelCalls.length, 1);
  assert.equal(body2.ok, true);
  assert.equal(body2.gemini, "ok");
  assert.equal(body2.sessions, 1);
  assert.equal(body2.floatingHuds, 1);

  await floatingHud.close();

  fakeNow += 15_001;
  const res3 = await fetch(`${httpBase}/api/health`);
  assert.equal(res3.status, 200);
  const body3 = (await res3.json()) as Record<string, any>;
  assert.equal(modelCalls.length, 2);
  assert.equal(body3.ok, true);
  assert.equal(body3.gemini, "down");
  assert.equal(body3.floatingHuds, 0);

  rejectGet = false;
  fakeNow += 10_000;
  const res4 = await fetch(`${httpBase}/api/health`);
  assert.equal(res4.status, 200);
  const body4 = (await res4.json()) as Record<string, any>;
  assert.equal(modelCalls.length, 2);
  assert.equal(body4.gemini, "down");

  fakeNow += 20_001;
  const res5 = await fetch(`${httpBase}/api/health`);
  assert.equal(res5.status, 200);
  const body5 = (await res5.json()) as Record<string, any>;
  assert.equal(modelCalls.length, 3);
  assert.equal(body5.gemini, "ok");
});

test("POST /ingest/state delivers orphan device state to session-less /hud-ws floating HUDs and adopts it on markLatest", async () => {
  const earlyFloatingHud = connectWs("/hud-ws");
  await earlyFloatingHud.open;
  assert.equal(earlyFloatingHud.queue.length, 0);

  const orphanRes = await fetch(`${httpBase}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 82, streaming: true }),
  });
  assert.equal(orphanRes.status, 204);

  const expectedOrphanDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 82,
    streaming: true,
    source: "glasses",
  };

  const earlyMsg = await earlyFloatingHud.next();
  assert.deepEqual(earlyMsg, { type: "device", device: expectedOrphanDevice });

  const lateFloatingHud = connectWs("/hud-ws");
  await lateFloatingHud.open;
  const lateReplayMsg = await lateFloatingHud.next();
  assert.deepEqual(lateReplayMsg, { type: "device", device: expectedOrphanDevice });

  const adoptedHub = createTrackedHub("adopt-orphan-session");
  assert.equal(adoptedHub.device, undefined);

  markLatest(adoptedHub);
  assert.deepEqual(adoptedHub.device, expectedOrphanDevice);

  const replayedToEarly = await earlyFloatingHud.next();
  const replayedToLate = await lateFloatingHud.next();
  assert.deepEqual(replayedToEarly, { type: "device", device: expectedOrphanDevice });
  assert.deepEqual(replayedToLate, { type: "device", device: expectedOrphanDevice });
});

test("POST /ingest/state coerces worn and battery strictly without triggering false glasses-removed fallback", async () => {
  const sessionId = "state-coercion-session";
  const hub = createTrackedHub(sessionId);
  const hud = connectWs(`/hud-ws?session=${sessionId}`);
  await hud.open;

  const cases: Array<{ payload: Record<string, unknown>; expected: DeviceState }> = [
    {
      payload: { connected: true, worn: true, battery: 82, streaming: true },
      expected: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" },
    },
    {
      payload: { connected: true, worn: false, battery: 0, streaming: false },
      expected: { connected: true, worn: false, battery: 0, streaming: false, source: "glasses" },
    },
    {
      payload: { connected: true, streaming: true },
      expected: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" },
    },
    {
      payload: { connected: true, worn: null, battery: null, streaming: false },
      expected: { connected: true, worn: null, battery: null, streaming: false, source: "glasses" },
    },
    {
      payload: { connected: 1, worn: "yes", battery: "bad", streaming: 0 },
      expected: { connected: true, worn: null, battery: null, streaming: false, source: "glasses" },
    },
  ];

  for (const c of cases) {
    const res = await fetch(`${httpBase}/ingest/state?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.payload),
    });
    assert.equal(res.status, 204);
    assert.deepEqual(hub.device, c.expected);
    const wsMsg = await hud.next();
    assert.deepEqual(wsMsg, { type: "device", device: c.expected });
  }

  assert.equal(hub.device?.worn, null);
  assert.notEqual(hub.device?.worn, false);
});

test("POST /ingest/state with >16kb JSON returns 413 too_large with recoverable: true", async () => {
  const sessionId = "state-too-large-session";
  const hub = createTrackedHub(sessionId);
  const oversizedBody = JSON.stringify({
    connected: true,
    worn: true,
    battery: 82,
    padding: "x".repeat(20_000),
  });
  assert.ok(Buffer.byteLength(oversizedBody, "utf8") > 16 * 1024);

  const res = await fetch(`${httpBase}/ingest/state?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBody,
  });
  assert.equal(res.status, 413);
  const errBody = (await res.json()) as Msg;
  assert.equal(errBody.type, "error");
  assert.equal(errBody.code, "too_large");
  assert.equal(errBody.recoverable, true);
  assert.equal(hub.device, undefined);
});

test("POST /ingest/frame accepts raw image/jpeg and application/octet-stream >= 100 bytes with 204", async () => {
  const sessionId = "frame-content-types-session";
  const hub = createTrackedHub(sessionId);
  hub.source = "glasses";

  const jpeg100 = makeJpegBytes(100, 0x21);
  const jpegRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpeg100),
  });
  assert.equal(jpegRes.status, 204);
  assert.equal(await jpegRes.text(), "");
  assert.equal(hub.ring.length, 1);

  const octet128 = makeJpegBytes(128, 0x34);
  const octetRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(octet128),
  });
  assert.equal(octetRes.status, 204);
  assert.equal(await octetRes.text(), "");
  assert.equal(hub.ring.length, 2);

  const short99 = makeJpegBytes(99, 0x45);
  const shortRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(short99),
  });
  assert.equal(shortRes.status, 400);
  const shortErr = (await shortRes.json()) as Msg;
  assert.equal(shortErr.code, "bad_input");
  assert.equal(shortErr.recoverable, true);
  assert.equal(hub.ring.length, 2);
});

test("POST /ingest/frame routes to explicit ?session=<id> or defaults to markLatest(hub) when ?session is omitted", async () => {
  const explicitHub = createTrackedHub("frame-explicit-target");
  const latestTargetHub = createTrackedHub("frame-latest-target");
  explicitHub.source = "glasses";
  latestTargetHub.source = "glasses";
  markLatest(latestTargetHub);

  const explicitBuf = makeJpegBytes(140, 0x51);
  const explicitRes = await fetch(`${httpBase}/ingest/frame?session=${explicitHub.id}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(explicitBuf),
  });
  assert.equal(explicitRes.status, 204);
  assert.equal(explicitHub.ring.length, 1);
  assert.equal(explicitHub.ring.pick(1)[0].data, explicitBuf.toString("base64"));
  assert.equal(latestTargetHub.ring.length, 0);

  const latestBuf = makeJpegBytes(160, 0x62);
  const latestRes = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(latestBuf),
  });
  assert.equal(latestRes.status, 204);
  assert.equal(latestTargetHub.ring.length, 1);
  assert.equal(latestTargetHub.ring.pick(1)[0].data, latestBuf.toString("base64"));
  assert.equal(explicitHub.ring.length, 1);

  const unknownBuf = makeJpegBytes(150, 0x73);
  const unknownRes = await fetch(`${httpBase}/ingest/frame?session=unknown-missing-hub`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(unknownBuf),
  });
  assert.equal(unknownRes.status, 204);
  assert.equal(getHub("unknown-missing-hub"), undefined);
  assert.equal(latestTargetHub.ring.length, 1);
});

test("POST /ingest/frame drops frames when hub.source is phone and stores + forwards base64 to hub.live.frame() when glasses", async () => {
  const sessionId = "frame-source-forwarding";
  const hub = createTrackedHub(sessionId);
  const forwardedBase64: string[] = [];
  let liveActive = true;

  const mockLive: LiveLike & { frame(data: string): void } = {
    get active() {
      return liveActive;
    },
    handleEvent() {},
    stop() {
      liveActive = false;
    },
    frame(data: string) {
      forwardedBase64.push(data);
    },
  };
  hub.live = mockLive;

  assert.equal(hub.source, "phone");
  const phoneBuf = makeJpegBytes(160, 0x19);
  const droppedRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(phoneBuf),
  });
  assert.equal(droppedRes.status, 204);
  assert.equal(hub.ring.length, 0);
  assert.equal(forwardedBase64.length, 0);

  hub.source = "glasses";
  const glassesBuf = makeJpegBytes(184, 0x2a);
  const storedRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(glassesBuf),
  });
  assert.equal(storedRes.status, 204);
  assert.equal(hub.ring.length, 1);
  const storedFrame = hub.ring.pick(1)[0];
  assert.equal(storedFrame.data, glassesBuf.toString("base64"));
  assert.equal(storedFrame.bytes, glassesBuf.length);
  assert.equal(storedFrame.source, "glasses");
  assert.deepEqual(forwardedBase64, [glassesBuf.toString("base64")]);

  hub.source = "phone";
  const droppedAgainRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(makeJpegBytes(172, 0x3b)),
  });
  assert.equal(droppedAgainRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(forwardedBase64.length, 1);

  liveActive = false;
  hub.dropFrames();
});

test("POST /ingest/frame respects ?sharpness=0.85 query override vs jpegSharpness(buf) fallback on amlodipine.jpg", async () => {
  const fixturePath = path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
  const fixtureBuf = fs.readFileSync(fixturePath);
  assert.ok(fixtureBuf.length >= 100);

  const fallbackSharpness = jpegSharpness(fixtureBuf);
  assert.ok(fallbackSharpness > 0 && fallbackSharpness <= 1);
  assert.notEqual(fallbackSharpness, 0.85);

  const sessionId = "frame-sharpness-session";
  const hub = createTrackedHub(sessionId);
  hub.source = "glasses";

  const overrideRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}&sharpness=0.85`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(fixtureBuf),
  });
  assert.equal(overrideRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].sharpness, 0.85);
  assert.equal(hub.ring.pick(1)[0].bytes, fixtureBuf.length);

  hub.dropFrames();
  const fallbackRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(fixtureBuf),
  });
  assert.equal(fallbackRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].sharpness, fallbackSharpness);

  hub.dropFrames();
  const zeroFallbackRes = await fetch(`${httpBase}/ingest/frame?session=${sessionId}&sharpness=0`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(fixtureBuf),
  });
  assert.equal(zeroFallbackRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].sharpness, fallbackSharpness);
});
