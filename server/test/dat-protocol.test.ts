import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { DeviceState, ServerMsg } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import {
  getHub,
  getOrCreateHub,
  hubStats,
  latestHub,
  markLatest,
  resetHubsForTest,
  type LiveLike,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { jpegSharpness, jpegSize } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

const SESSION_ID_RE = /^[\w-]{4,64}$/;

export function i420ToNv21(i420: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0 || width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`I420 dimensions must be positive even integers, got ${width}x${height}`);
  }
  const ySize = width * height;
  const uvSize = ySize / 4;
  const expectedBytes = ySize + uvSize * 2;
  if (i420.byteLength !== expectedBytes) {
    throw new RangeError(`I420 byteLength mismatch: expected ${expectedBytes}, got ${i420.byteLength}`);
  }
  const nv21 = new Uint8Array(expectedBytes);
  nv21.set(i420.subarray(0, ySize), 0);
  const uOffset = ySize;
  const vOffset = ySize + uvSize;
  for (let i = 0; i < uvSize; i++) {
    nv21[ySize + i * 2] = i420[vOffset + i];
    nv21[ySize + i * 2 + 1] = i420[uOffset + i];
  }
  return nv21;
}

export function nv21ToI420(nv21: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0 || width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`NV21 dimensions must be positive even integers, got ${width}x${height}`);
  }
  const ySize = width * height;
  const uvSize = ySize / 4;
  const expectedBytes = ySize + uvSize * 2;
  if (nv21.byteLength !== expectedBytes) {
    throw new RangeError(`NV21 byteLength mismatch: expected ${expectedBytes}, got ${nv21.byteLength}`);
  }
  const i420 = new Uint8Array(expectedBytes);
  i420.set(nv21.subarray(0, ySize), 0);
  const uOffset = ySize;
  const vOffset = ySize + uvSize;
  for (let i = 0; i < uvSize; i++) {
    i420[vOffset + i] = nv21[ySize + i * 2];
    i420[uOffset + i] = nv21[ySize + i * 2 + 1];
  }
  return i420;
}

export type BridgeDeepLink = {
  server: string;
  session: string | null;
  frameIngestUrl: string;
  stateIngestUrl: string;
};

export function buildBridgeDeepLink(serverOrigin: string, session?: string | null): string {
  const normalizedServer = serverOrigin.trim().replace(/\/+$/, "");
  const parsedServer = new URL(normalizedServer);
  if (parsedServer.protocol !== "https:" && parsedServer.protocol !== "http:") {
    throw new TypeError(`Unsupported bridge server protocol: ${parsedServer.protocol}`);
  }
  if (session !== undefined && session !== null) {
    if (!SESSION_ID_RE.test(session)) {
      throw new TypeError(`Invalid bridge session id: ${session}`);
    }
    return `holdupbridge://connect?server=${encodeURIComponent(normalizedServer)}&session=${encodeURIComponent(session)}`;
  }
  return `holdupbridge://connect?server=${encodeURIComponent(normalizedServer)}`;
}

export function parseBridgeDeepLink(rawUrl: string): BridgeDeepLink {
  const url = new URL(rawUrl);
  if (url.protocol !== "holdupbridge:" || url.hostname !== "connect" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError(`Invalid HoldUp Bridge deep link: ${rawUrl}`);
  }
  const rawServer = url.searchParams.get("server");
  if (!rawServer) {
    throw new TypeError("HoldUp Bridge deep link requires server parameter");
  }
  const normalizedServer = rawServer.trim().replace(/\/+$/, "");
  const parsedServer = new URL(normalizedServer);
  if (parsedServer.protocol !== "https:" && parsedServer.protocol !== "http:") {
    throw new TypeError(`Unsupported server scheme in bridge link: ${parsedServer.protocol}`);
  }
  const rawSession = url.searchParams.get("session");
  if (rawSession !== null && !SESSION_ID_RE.test(rawSession)) {
    throw new TypeError(`Invalid session parameter in bridge link: ${rawSession}`);
  }
  const suffix = rawSession ? `?session=${encodeURIComponent(rawSession)}` : "";
  return {
    server: normalizedServer,
    session: rawSession,
    frameIngestUrl: `${normalizedServer}/ingest/frame${suffix}`,
    stateIngestUrl: `${normalizedServer}/ingest/state${suffix}`,
  };
}

export type ViewOnGlassesDeepLink = {
  appName: string;
  appUrl: string;
  session: string | null;
};

export function buildViewOnGlassesDeepLink(appName: string, appUrl: string): string {
  const trimmedName = appName.trim();
  if (!trimmedName || trimmedName.length > 12) {
    throw new TypeError(`Display Web App name must be 1..12 chars, got "${trimmedName}"`);
  }
  const parsedAppUrl = new URL(appUrl.trim());
  if (parsedAppUrl.protocol !== "https:") {
    throw new TypeError(`Display Web App URL must use https:, got ${parsedAppUrl.protocol}`);
  }
  return `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent(trimmedName)}&appUrl=${encodeURIComponent(appUrl.trim())}`;
}

export function parseViewOnGlassesDeepLink(rawUrl: string): ViewOnGlassesDeepLink {
  const url = new URL(rawUrl);
  if (url.protocol !== "fb-viewapp:" || url.hostname !== "web_app_deep_link" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError(`Invalid View on Glasses deep link: ${rawUrl}`);
  }
  const appName = url.searchParams.get("appName")?.trim() ?? "";
  if (!appName || appName.length > 12) {
    throw new TypeError(`Invalid appName in View on Glasses deep link: "${appName}"`);
  }
  const appUrl = url.searchParams.get("appUrl")?.trim() ?? "";
  if (!appUrl) {
    throw new TypeError("Missing appUrl in View on Glasses deep link");
  }
  const parsedAppUrl = new URL(appUrl);
  if (parsedAppUrl.protocol !== "https:") {
    throw new TypeError(`Ray-Ban Display Web App requires https: appUrl, got ${parsedAppUrl.protocol}`);
  }
  const session = parsedAppUrl.searchParams.get("session");
  if (session !== null && !SESSION_ID_RE.test(session)) {
    throw new TypeError(`Invalid session inside appUrl: ${session}`);
  }
  return { appName, appUrl: parsedAppUrl.toString(), session };
}

function buildSof0Jpeg(width: number, height: number, scanBytes = 256): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  sof0[10] = 1; sof0[11] = 0x22; sof0[12] = 0;
  sof0[13] = 2; sof0[14] = 0x11; sof0[15] = 1;
  sof0[16] = 3; sof0[17] = 0x11; sof0[18] = 1;
  const sosHeader = Buffer.from([
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);
  const scan = Buffer.alloc(scanBytes);
  for (let i = 0; i < scanBytes; i++) {
    scan[i] = (i * 37 + 13) & 0x7f;
  }
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, sosHeader, scan, eoi]);
}

function makeStubLive(): LiveLike & { frame(data: string): void; frames: string[] } {
  const frames: string[] = [];
  return {
    active: true,
    frames,
    frame(data: string) {
      frames.push(data);
    },
    handleEvent() {},
    stop() {},
  };
}

let server: http.Server;
let baseUrl = "";
let wsBase = "";
let prevApiKey = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
});

after(async () => {
  resetHubsForTest();
  env.apiKey = prevApiKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function openWs(url: string) {
  const ws = new WebSocket(url);
  const queue: ServerMsg[] = [];
  const waiters: ((msg: ServerMsg) => void)[] = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    const w = waiters.shift();
    if (w) w(parsed);
    else queue.push(parsed);
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (timeoutMs = 2000): Promise<ServerMsg> => {
    const item = queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ws message on ${url}`)), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  return { ws, ready, next, close };
}

test("DAT VideoFrame I420 to NV21 preserves luma plane and interleaves Cr before Cb across 4x4 and 720x1280 frames", () => {
  const w4 = 4;
  const h4 = 4;
  const i420Small = Uint8Array.from([
    10, 11, 12, 13,
    14, 15, 16, 17,
    18, 19, 20, 21,
    22, 23, 24, 25,
    101, 102, 103, 104,
    201, 202, 203, 204,
  ]);
  const nv21Small = i420ToNv21(i420Small, w4, h4);
  assert.equal(nv21Small.byteLength, 24);
  assert.deepEqual(Array.from(nv21Small.subarray(0, 16)), Array.from(i420Small.subarray(0, 16)));
  assert.deepEqual(Array.from(nv21Small.subarray(16)), [201, 101, 202, 102, 203, 103, 204, 104]);
  assert.deepEqual(nv21ToI420(nv21Small, w4, h4), i420Small);

  const datW = 720;
  const datH = 1280;
  const ySize = datW * datH;
  const uvSize = ySize / 4;
  const totalBytes = ySize + uvSize * 2;
  assert.equal(ySize, 921_600);
  assert.equal(uvSize, 230_400);
  assert.equal(totalBytes, 1_382_400);

  const i420High = new Uint8Array(totalBytes);
  for (let i = 0; i < ySize; i++) i420High[i] = i & 0xff;
  for (let i = 0; i < uvSize; i++) {
    i420High[ySize + i] = (0x40 + (i % 61)) & 0xff;
    i420High[ySize + uvSize + i] = (0xb0 + (i % 59)) & 0xff;
  }

  const nv21High = i420ToNv21(i420High, datW, datH);
  assert.equal(nv21High.byteLength, totalBytes);
  assert.equal(nv21High[0], i420High[0]);
  assert.equal(nv21High[ySize - 1], i420High[ySize - 1]);
  assert.equal(nv21High[ySize], i420High[ySize + uvSize]);
  assert.equal(nv21High[ySize + 1], i420High[ySize]);
  assert.equal(nv21High[totalBytes - 2], i420High[totalBytes - 1]);
  assert.equal(nv21High[totalBytes - 1], i420High[ySize + uvSize - 1]);

  const roundtrip = nv21ToI420(nv21High, datW, datH);
  assert.equal(Buffer.compare(Buffer.from(roundtrip), Buffer.from(i420High)), 0);

  assert.throws(() => i420ToNv21(i420Small, 3, 4), RangeError);
  assert.throws(() => i420ToNv21(i420Small, 4, 5), RangeError);
  assert.throws(() => i420ToNv21(i420Small, 0, 4), RangeError);
  assert.throws(() => i420ToNv21(i420Small.subarray(0, 23), 4, 4), RangeError);
  assert.throws(() => nv21ToI420(nv21Small.subarray(0, 20), 4, 4), RangeError);
});

test("720x1280 SOF0 JPEG frame dimensions, server sharpness heuristic, and /ingest/frame size guard invariants", async () => {
  const datJpeg = buildSof0Jpeg(720, 1280, 400);
  assert.deepEqual(jpegSize(datJpeg), { w: 720, h: 1280 });
  const expectedSharpness = Math.max(0, Math.min(1, datJpeg.length / (720 * 1280) / 0.35));
  assert.equal(jpegSharpness(datJpeg), expectedSharpness);

  for (const contentType of ["image/jpeg", "application/octet-stream"]) {
    const tooSmall = await fetch(`${baseUrl}/ingest/frame`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(99).fill(0xff),
    });
    assert.equal(tooSmall.status, 400);
    const errBody = (await tooSmall.json()) as Record<string, unknown>;
    assert.equal(errBody.type, "error");
    assert.equal(errBody.code, "bad_input");
    assert.equal(errBody.recoverable, true);
  }

  const droppedWhenNoSession = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(datJpeg),
  });
  assert.equal(droppedWhenNoSession.status, 204);
  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 0 });
});

test("session-less /ingest/frame accepts image/jpeg and application/octet-stream, attaches to markLatest hub with source glasses, and honors ?sharpness=0.82", async () => {
  const hub = getOrCreateHub("hup-latest");
  const stubLive = makeStubLive();
  hub.live = stubLive;
  markLatest(hub);
  assert.equal(latestHub(), hub);

  const fixtureJpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const expectedDefaultSharpness = jpegSharpness(fixtureJpg);
  assert.notEqual(expectedDefaultSharpness, 0.82);

  const resJpeg = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(fixtureJpg),
  });
  assert.equal(resJpeg.status, 204);
  assert.equal(hub.ring.length, 1);

  const firstPicked = hub.ring.pick(1)[0];
  assert.equal(firstPicked.source, "glasses");
  assert.equal(firstPicked.bytes, fixtureJpg.length);
  assert.equal(firstPicked.data, fixtureJpg.toString("base64"));
  assert.equal(firstPicked.sharpness, expectedDefaultSharpness);
  assert.deepEqual(stubLive.frames, [fixtureJpg.toString("base64")]);

  const datOctetFrame = buildSof0Jpeg(720, 1280, 512);
  assert.notEqual(jpegSharpness(datOctetFrame), 0.82);

  const resOctet = await fetch(`${baseUrl}/ingest/frame?sharpness=0.82`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(datOctetFrame),
  });
  assert.equal(resOctet.status, 204);
  assert.equal(hub.ring.length, 2);
  assert.equal(stubLive.frames.length, 2);
  assert.equal(stubLive.frames[1], datOctetFrame.toString("base64"));

  const picked = hub.ring.pick(2);
  const overrideFrame = picked.find((f) => f.bytes === datOctetFrame.length);
  assert.ok(overrideFrame);
  assert.equal(overrideFrame.source, "glasses");
  assert.equal(overrideFrame.sharpness, 0.82);
  assert.equal(overrideFrame.data, datOctetFrame.toString("base64"));
});

test("session-specific /ingest/frame?session=hup-test routes strictly to hup-test even when another session is marked latest", async () => {
  const hubLatest = getOrCreateHub("hup-other-latest");
  const latestLive = makeStubLive();
  hubLatest.live = latestLive;

  const hubTest = getOrCreateHub("hup-test");
  const testLive = makeStubLive();
  hubTest.live = testLive;

  markLatest(hubLatest);
  assert.equal(latestHub(), hubLatest);

  const frameA = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const frameB = buildSof0Jpeg(720, 1280, 600);

  const resA = await fetch(`${baseUrl}/ingest/frame?session=hup-test&sharpness=0.82`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(frameA),
  });
  assert.equal(resA.status, 204);

  const resB = await fetch(`${baseUrl}/ingest/frame?session=hup-test`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(frameB),
  });
  assert.equal(resB.status, 204);

  assert.equal(hubLatest.ring.length, 0);
  assert.deepEqual(latestLive.frames, []);

  assert.equal(hubTest.ring.length, 2);
  assert.deepEqual(testLive.frames, [frameA.toString("base64"), frameB.toString("base64")]);
  const stored = hubTest.ring.pick(2);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].source, "glasses");
  assert.equal(stored[0].sharpness, 0.82);
  assert.equal(stored[1].source, "glasses");
  assert.equal(stored[1].sharpness, jpegSharpness(frameB));

  const resUnknown = await fetch(`${baseUrl}/ingest/frame?session=hup-unopened`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(frameA),
  });
  assert.equal(resUnknown.status, 204);
  assert.equal(getHub("hup-unopened"), undefined);
  assert.equal(hubLatest.ring.length, 0);
  assert.equal(hubTest.ring.length, 2);
});

test("session-less /ingest/state nominal, doff, and low-battery transitions fan out identically to /live and /hud-ws with source glasses", async () => {
  const live = openWs(`${wsBase}/live?session=hup-state`);
  await live.ready;

  const hub = getHub("hup-state");
  assert.ok(hub);
  markLatest(hub);
  assert.deepEqual(await live.next(), { type: "hud", connected: false });

  const floatingHud = openWs(`${wsBase}/hud-ws`);
  await floatingHud.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  const explicitHud = openWs(`${wsBase}/hud-ws?session=hup-state`);
  await explicitHud.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  try {
    const transitions: Array<{ payload: Record<string, unknown>; expected: DeviceState }> = [
      {
        payload: { connected: true, worn: true, battery: 72, streaming: true },
        expected: { connected: true, worn: true, battery: 72, streaming: true, source: "glasses" },
      },
      {
        payload: { connected: true, worn: false, battery: 72, streaming: false },
        expected: { connected: true, worn: false, battery: 72, streaming: false, source: "glasses" },
      },
      {
        payload: { worn: false },
        expected: { connected: false, worn: false, battery: null, streaming: false, source: "glasses" },
      },
      {
        payload: { connected: true, worn: true, battery: 8, streaming: true },
        expected: { connected: true, worn: true, battery: 8, streaming: true, source: "glasses" },
      },
      {
        payload: { battery: 8, source: "phone" },
        expected: { connected: false, worn: false, battery: 8, streaming: false, source: "glasses" },
      },
    ];

    for (const step of transitions) {
      const res = await fetch(`${baseUrl}/ingest/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(step.payload),
      });
      assert.equal(res.status, 204);

      const [liveMsg, floatingMsg, explicitMsg] = await Promise.all([
        live.next(),
        floatingHud.next(),
        explicitHud.next(),
      ]);
      const expectedMsg: ServerMsg = { type: "device", device: step.expected };
      assert.deepEqual(liveMsg, expectedMsg);
      assert.deepEqual(floatingMsg, expectedMsg);
      assert.deepEqual(explicitMsg, expectedMsg);
      assert.deepEqual(hub.device, step.expected);
    }
  } finally {
    await Promise.all([live.close(), floatingHud.close(), explicitHud.close()]);
  }
});

test("orphan session-less /ingest/state buffers device state for /hud-ws before live session starts and adopts on markLatest", async () => {
  const floatingHud = openWs(`${wsBase}/hud-ws`);
  await floatingHud.ready;

  const preSessionRes = await fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 72, streaming: true }),
  });
  assert.equal(preSessionRes.status, 204);

  const expectedDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 72,
    streaming: true,
    source: "glasses",
  };
  assert.deepEqual(await floatingHud.next(), { type: "device", device: expectedDevice });

  const live = openWs(`${wsBase}/live?session=hup-orphan`);
  await live.ready;
  const hub = getHub("hup-orphan");
  assert.ok(hub);

  markLatest(hub);
  assert.deepEqual(await floatingHud.next(), { type: "device", device: expectedDevice });
  assert.deepEqual(await live.next(), { type: "hud", connected: true });
  assert.deepEqual(hub.device, expectedDevice);

  const lateLive = openWs(`${wsBase}/live?session=hup-orphan`);
  try {
    await lateLive.ready;
    assert.deepEqual(await lateLive.next(), { type: "device", device: expectedDevice });
    assert.deepEqual(await lateLive.next(), { type: "hud", connected: true });
  } finally {
    await Promise.all([lateLive.close(), live.close(), floatingHud.close()]);
  }
});

test("holdupbridge://connect and fb-viewapp://web_app_deep_link URL roundtrip and validation invariants", () => {
  const canonicalBridge = "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m";
  const parsedBridge = parseBridgeDeepLink(canonicalBridge);
  assert.deepEqual(parsedBridge, {
    server: "https://demo.trycloudflare.com",
    session: "hup-4k9m",
    frameIngestUrl: "https://demo.trycloudflare.com/ingest/frame?session=hup-4k9m",
    stateIngestUrl: "https://demo.trycloudflare.com/ingest/state?session=hup-4k9m",
  });
  assert.equal(buildBridgeDeepLink(parsedBridge.server, parsedBridge.session), canonicalBridge);
  assert.equal(buildBridgeDeepLink("  https://demo.trycloudflare.com///  ", "hup-4k9m"), canonicalBridge);

  const sessionlessBridge = "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com";
  const parsedSessionless = parseBridgeDeepLink(sessionlessBridge);
  assert.deepEqual(parsedSessionless, {
    server: "https://demo.trycloudflare.com",
    session: null,
    frameIngestUrl: "https://demo.trycloudflare.com/ingest/frame",
    stateIngestUrl: "https://demo.trycloudflare.com/ingest/state",
  });
  assert.equal(buildBridgeDeepLink(parsedSessionless.server), sessionlessBridge);

  assert.throws(() => parseBridgeDeepLink("https://demo.trycloudflare.com?session=hup-4k9m"), TypeError);
  assert.throws(() => parseBridgeDeepLink("holdupbridge://wronghost?server=https%3A%2F%2Fdemo.trycloudflare.com"), TypeError);
  assert.throws(() => parseBridgeDeepLink("holdupbridge://connect?session=hup-4k9m"), TypeError);
  assert.throws(() => parseBridgeDeepLink("holdupbridge://connect?server=ftp%3A%2F%2Fdemo.trycloudflare.com"), TypeError);
  assert.throws(() => parseBridgeDeepLink("holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=bad%20id"), TypeError);

  const hudUrlPlain = "https://demo.trycloudflare.com/hud";
  const canonicalGlasses = "fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2Fdemo.trycloudflare.com%2Fhud";
  assert.equal(buildViewOnGlassesDeepLink("HoldUp", hudUrlPlain), canonicalGlasses);
  const parsedGlasses = parseViewOnGlassesDeepLink(canonicalGlasses);
  assert.deepEqual(parsedGlasses, {
    appName: "HoldUp",
    appUrl: hudUrlPlain,
    session: null,
  });
  assert.equal(buildViewOnGlassesDeepLink(parsedGlasses.appName, parsedGlasses.appUrl), canonicalGlasses);

  const hudUrlWithSession = "https://demo.trycloudflare.com/hud?session=hup-4k9m";
  const sessionGlassesLink = buildViewOnGlassesDeepLink("HoldUp", hudUrlWithSession);
  assert.equal(
    sessionGlassesLink,
    "fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2Fdemo.trycloudflare.com%2Fhud%3Fsession%3Dhup-4k9m",
  );
  const outerUrl = new URL(sessionGlassesLink);
  assert.deepEqual(Array.from(outerUrl.searchParams.keys()), ["appName", "appUrl"]);
  assert.equal(outerUrl.searchParams.get("session"), null);

  const parsedSessionGlasses = parseViewOnGlassesDeepLink(sessionGlassesLink);
  assert.deepEqual(parsedSessionGlasses, {
    appName: "HoldUp",
    appUrl: hudUrlWithSession,
    session: "hup-4k9m",
  });
  assert.equal(buildViewOnGlassesDeepLink(parsedSessionGlasses.appName, parsedSessionGlasses.appUrl), sessionGlassesLink);

  assert.throws(() => parseViewOnGlassesDeepLink("https://demo.trycloudflare.com/hud"), TypeError);
  assert.throws(() => parseViewOnGlassesDeepLink("fb-viewapp://other_action?appName=HoldUp&appUrl=https%3A%2F%2Fdemo.trycloudflare.com%2Fhud"), TypeError);
  assert.throws(() => buildViewOnGlassesDeepLink("HoldUp", "http://demo.trycloudflare.com/hud"), TypeError);
  assert.throws(() => buildViewOnGlassesDeepLink("HoldUpTooLongName", hudUrlPlain), TypeError);
  assert.throws(() => buildViewOnGlassesDeepLink("", hudUrlPlain), TypeError);
});

test("end-to-end paired deep-link session binds Android DAT Bridge ingest, Phone PWA /live, and Ray-Ban /hud-ws with disconnect frame wipe", async () => {
  const bridgeUri = buildBridgeDeepLink(baseUrl, "hup-4k9m");
  const glassesUri = buildViewOnGlassesDeepLink("HoldUp", "https://demo.trycloudflare.com/hud?session=hup-4k9m");

  const bridge = parseBridgeDeepLink(bridgeUri);
  const glasses = parseViewOnGlassesDeepLink(glassesUri);
  assert.equal(bridge.session, "hup-4k9m");
  assert.equal(glasses.session, bridge.session);

  const live = openWs(`${wsBase}/live?session=${bridge.session}`);
  await live.ready;
  const hud = openWs(`${wsBase}/hud-ws?session=${glasses.session}`);
  await hud.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  try {
    const i420 = new Uint8Array(8 * 8 * 1.5);
    for (let i = 0; i < i420.length; i++) i420[i] = (i * 19) & 0xff;
    const nv21 = i420ToNv21(i420, 8, 8);
    assert.equal(nv21.byteLength, 96);

    const encodedJpeg = buildSof0Jpeg(720, 1280, nv21.byteLength + 128);
    const frameRes = await fetch(`${bridge.frameIngestUrl}&sharpness=0.82`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(encodedJpeg),
    });
    assert.equal(frameRes.status, 204);

    const hub = getHub("hup-4k9m");
    assert.ok(hub);
    assert.equal(hub.ring.length, 1);
    assert.equal(hub.ring.pick(1)[0].source, "glasses");
    assert.equal(hub.ring.pick(1)[0].sharpness, 0.82);

    const stateRes = await fetch(bridge.stateIngestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: true, battery: 72, streaming: true }),
    });
    assert.equal(stateRes.status, 204);

    const [liveDev, hudDev] = await Promise.all([live.next(), hud.next()]);
    const expectedDev: ServerMsg = {
      type: "device",
      device: { connected: true, worn: true, battery: 72, streaming: true, source: "glasses" },
    };
    assert.deepEqual(liveDev, expectedDev);
    assert.deepEqual(hudDev, expectedDev);
  } finally {
    await Promise.all([live.close(), hud.close()]);
  }

  for (let i = 0; i < 30 && (getHub("hup-4k9m")?.clients.size ?? 0) > 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(getHub("hup-4k9m")?.ring.length, 0);
});
