import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { DeviceState, ServerMsg } from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, getOrCreateHub, markLatest, type Hub } from "../src/hub.ts";
import { createApp, startServer } from "../src/index.ts";

const TUNNEL_KEY = "holdup-tunnel-key-g4_2026";

const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;
const origModelsGet = ai.models.get;
const origGenerateContent = ai.models.generateContent;

const ledgerTmpDir = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-g4-tunnel-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");

let server: http.Server;
let baseUrl = "";
let wsBaseUrl = "";
const trackedHubIds = new Set<string>();
const openSockets = new Set<WebSocket>();

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function normalizeServerMirror(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return s;
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = `https://${s}`;
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

function glassesStateToJsonMirror(state: {
  connected: boolean;
  worn: boolean | null;
  battery: number | null;
  streaming: boolean;
}): string {
  const wornToken = state.worn === null ? "null" : String(state.worn);
  const batteryToken = state.battery === null ? "null" : String(state.battery);
  return `{"connected":${state.connected},"worn":${wornToken},"battery":${batteryToken},"streaming":${state.streaming}}`;
}

function makeValidJpeg(byteLength = 192, seed = 0x42): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf.fill(seed & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

function createTrackedHub(id: string): Hub {
  trackedHubIds.add(id);
  const hub = getOrCreateHub(id);
  hub.dropFrames();
  hub.live = undefined;
  hub.device = undefined;
  hub.source = "phone";
  return hub;
}

function connectHudWs(pathAndQuery: string, headers?: Record<string, string>) {
  const ws = new WebSocket(`${wsBaseUrl}${pathAndQuery}`, headers ? { headers } : undefined);
  openSockets.add(ws);
  ws.once("close", () => openSockets.delete(ws));
  const queue: ServerMsg[] = [];
  const waiters: Array<(msg: ServerMsg) => void> = [];

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });

  const open = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS open timeout: ${pathAndQuery}`)), 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const nextWhere = (pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> => {
    const existingIdx = queue.findIndex(pred);
    if (existingIdx >= 0) {
      const [found] = queue.splice(existingIdx, 1);
      return Promise.resolve(found);
    }
    return new Promise<ServerMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS message timeout: ${pathAndQuery}`)), timeoutMs);
      const check = (msg: ServerMsg) => {
        if (pred(msg)) {
          clearTimeout(timer);
          resolve(msg);
        } else {
          queue.push(msg);
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  };

  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) {
      openSockets.delete(ws);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close();
    });
    openSockets.delete(ws);
  };

  return { ws, open, nextWhere, close };
}

interface HealthResponse {
  ok: boolean;
  glasses: {
    source: "phone" | "glasses" | null;
    device: DeviceState | null;
    framesAccepted: number;
    framesDropped: number;
    lastFrameAgoS: number | null;
  };
}

async function fetchHealth(queryOrHeaders?: { query?: string; headers?: Record<string, string> }): Promise<{
  res: Response;
  body: HealthResponse;
}> {
  const suffix = queryOrHeaders?.query ?? "";
  const res = await fetch(`${baseUrl}/api/health${suffix}`, {
    headers: queryOrHeaders?.headers,
  });
  const body = (await res.json()) as HealthResponse;
  return { res, body };
}

async function assertUnauthorized(res: Response) {
  assert.equal(res.status, 401);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "unauthorized");
  assert.equal(body.recoverable, false);
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected tcp server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  env.apiKey = "";
  ai.models.get = origModelsGet;
  ai.models.generateContent = origGenerateContent;
});

afterEach(async () => {
  restoreHoldupKey();
  env.apiKey = origApiKey;
  ai.models.get = origModelsGet;
  ai.models.generateContent = origGenerateContent;

  for (const ws of [...openSockets]) {
    if (ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close();
      });
    }
    openSockets.delete(ws);
  }

  for (const id of trackedHubIds) {
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
    for (const ws of [...openSockets]) {
      try {
        ws.terminate();
      } catch {}
    }
    openSockets.clear();

    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    restoreHoldupKey();
    env.apiKey = origApiKey;
    env.ledgerPath = origLedgerPath;
    ai.models.get = origModelsGet;
    ai.models.generateContent = origGenerateContent;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    fs.rmSync(ledgerTmpDir, { recursive: true, force: true });
  }
});

test("POST /ingest/frame and POST /ingest/state reject missing or wrong HOLDUP_KEY with 401 unauthorized", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  try {
    const session = "dat-auth-reject-sess";
    const hub = createTrackedHub(session);
    hub.source = "glasses";
    markLatest(hub);

    const { body: beforeHealth } = await fetchHealth();
    const jpeg = makeValidJpeg(180, 0x31);
    const stateBody = glassesStateToJsonMirror({
      connected: true,
      worn: true,
      battery: 75,
      streaming: true,
    });

    await assertUnauthorized(
      await fetch(`${baseUrl}/ingest/frame?session=${session}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      }),
    );
    await assertUnauthorized(
      await fetch(`${baseUrl}/ingest/state?session=${session}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stateBody,
      }),
    );

    await assertUnauthorized(
      await fetch(uploaderEndpointMirror(`${baseUrl}/?key=wrong-key`, "/ingest/frame", session), {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      }),
    );
    await assertUnauthorized(
      await fetch(uploaderEndpointMirror(`${baseUrl}/?key=wrong-key`, "/ingest/state", session), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stateBody,
      }),
    );

    await assertUnauthorized(
      await fetch(`${baseUrl}/ingest/frame?session=${session}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", "x-holdup-key": "wrong-header-key" },
        body: jpeg,
      }),
    );
    await assertUnauthorized(
      await fetch(`${baseUrl}/ingest/state?session=${session}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-holdup-key": "wrong-header-key" },
        body: stateBody,
      }),
    );

    await assertUnauthorized(
      await fetch(`${baseUrl}/ingest/frame?key=&session=${session}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", "x-holdup-key": TUNNEL_KEY },
        body: jpeg,
      }),
    );

    const { body: afterHealth } = await fetchHealth();
    assert.equal(hub.ring.length, 0);
    assert.equal(hub.device, undefined);
    assert.equal(afterHealth.glasses.framesAccepted, beforeHealth.glasses.framesAccepted);
    assert.equal(afterHealth.glasses.framesDropped, beforeHealth.glasses.framesDropped);
  } finally {
    restoreHoldupKey();
  }
});

test("GET /api/health stays 200 open even when HOLDUP_KEY is set", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  try {
    const unauthed = await fetchHealth();
    assert.equal(unauthed.res.status, 200);
    assert.equal(unauthed.body.ok, true);
    assert.equal(typeof unauthed.body.glasses.framesAccepted, "number");
    assert.equal(typeof unauthed.body.glasses.framesDropped, "number");

    const wrongQuery = await fetchHealth({ query: "?key=wrong-probe-key" });
    assert.equal(wrongQuery.res.status, 200);
    assert.equal(wrongQuery.body.ok, true);

    const wrongHeader = await fetchHealth({ headers: { "x-holdup-key": "wrong-probe-key" } });
    assert.equal(wrongHeader.res.status, 200);
    assert.equal(wrongHeader.body.ok, true);

    const validKey = await fetchHealth({ query: `?key=${TUNNEL_KEY}` });
    assert.equal(validKey.res.status, 200);
    assert.equal(validKey.body.ok, true);
  } finally {
    restoreHoldupKey();
  }
});

test("POST /ingest/frame with Uploader.endpoint ?key=&session= and x-holdup-key returns 204, increments framesAccepted for glasses, and drops for phone", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  try {
    const session = "dat-frame-routing-01";
    const cfUrl = uploaderEndpointMirror(
      `https://x.trycloudflare.com/?key=${TUNNEL_KEY}`,
      "/ingest/frame",
      session,
    );
    assert.equal(
      cfUrl,
      `https://x.trycloudflare.com/ingest/frame?key=${TUNNEL_KEY}&session=${session}`,
    );

    const hub = createTrackedHub(session);
    hub.source = "glasses";
    markLatest(hub);

    const { body: h0 } = await fetchHealth();
    const localTunnelFrameUrl = uploaderEndpointMirror(
      `${baseUrl}/?key=${TUNNEL_KEY}`,
      "/ingest/frame",
      session,
    );
    assert.equal(localTunnelFrameUrl, `${baseUrl}/ingest/frame?key=${TUNNEL_KEY}&session=${session}`);

    const frame1 = makeValidJpeg(200, 0x55);
    const resQuery = await fetch(localTunnelFrameUrl, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: frame1,
    });
    assert.equal(resQuery.status, 204);
    assert.equal(hub.ring.length, 1);

    const { body: h1 } = await fetchHealth();
    assert.equal(h1.glasses.source, "glasses");
    assert.equal(h1.glasses.framesAccepted, h0.glasses.framesAccepted + 1);
    assert.equal(h1.glasses.framesDropped, h0.glasses.framesDropped);
    assert.equal(typeof h1.glasses.lastFrameAgoS, "number");
    assert.ok((h1.glasses.lastFrameAgoS ?? -1) >= 0);

    const frame2 = makeValidJpeg(216, 0x66);
    const resHeader = await fetch(`${baseUrl}/ingest/frame?session=${session}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-holdup-key": TUNNEL_KEY },
      body: frame2,
    });
    assert.equal(resHeader.status, 204);
    assert.equal(hub.ring.length, 2);

    const { body: h2 } = await fetchHealth();
    assert.equal(h2.glasses.framesAccepted, h0.glasses.framesAccepted + 2);
    assert.equal(h2.glasses.framesDropped, h0.glasses.framesDropped);

    hub.source = "phone";
    const droppedByQuery = await fetch(localTunnelFrameUrl, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: makeValidJpeg(190, 0x77),
    });
    assert.equal(droppedByQuery.status, 204);
    assert.equal(hub.ring.length, 2);

    const droppedByHeader = await fetch(`${baseUrl}/ingest/frame?session=${session}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-holdup-key": TUNNEL_KEY },
      body: makeValidJpeg(196, 0x88),
    });
    assert.equal(droppedByHeader.status, 204);
    assert.equal(hub.ring.length, 2);

    const { body: h3 } = await fetchHealth();
    assert.equal(h3.glasses.source, "phone");
    assert.equal(h3.glasses.framesAccepted, h0.glasses.framesAccepted + 2);
    assert.equal(h3.glasses.framesDropped, h0.glasses.framesDropped + 2);
  } finally {
    restoreHoldupKey();
  }
});

test("POST /ingest/state preserves nullable worn and battery on /api/health and HUD replay while passing booleans/finite battery and coercing NaN/Infinity to null", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  try {
    const session = "dat-nullable-state-01";
    const hub = createTrackedHub(session);
    hub.source = "glasses";
    markLatest(hub);

    const liveHud = connectHudWs(`/hud-ws?session=${session}&key=${TUNNEL_KEY}`);
    await liveHud.open;

    const stateEndpoint = uploaderEndpointMirror(
      `${baseUrl}/?key=${TUNNEL_KEY}`,
      "/ingest/state",
      session,
    );
    const unknownStatePayload = glassesStateToJsonMirror({
      connected: true,
      worn: null,
      battery: null,
      streaming: true,
    });
    assert.equal(
      unknownStatePayload,
      '{"connected":true,"worn":null,"battery":null,"streaming":true}',
    );

    const resUnknown = await fetch(stateEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: unknownStatePayload,
    });
    assert.equal(resUnknown.status, 204);

    const expectedUnknown: DeviceState = {
      connected: true,
      worn: null,
      battery: null,
      streaming: true,
      source: "glasses",
    };

    const liveUnknownMsg = await liveHud.nextWhere((m) => m.type === "device");
    assert.deepEqual(liveUnknownMsg, { type: "device", device: expectedUnknown });
    assert.equal(hub.device?.worn, null);
    assert.notEqual(hub.device?.worn, false);
    assert.equal(hub.device?.battery, null);

    const { body: healthUnknown } = await fetchHealth();
    assert.deepEqual(healthUnknown.glasses.device, expectedUnknown);
    assert.equal(healthUnknown.glasses.device?.worn, null);
    assert.equal(healthUnknown.glasses.device?.battery, null);

    const lateSessionHud = connectHudWs(`/hud-ws?session=${session}&key=${TUNNEL_KEY}`);
    await lateSessionHud.open;
    const replayedSessionMsg = await lateSessionHud.nextWhere((m) => m.type === "device");
    assert.deepEqual(replayedSessionMsg, { type: "device", device: expectedUnknown });
    await lateSessionHud.close();

    const lateFloatingHud = connectHudWs("/hud-ws", { "x-holdup-key": TUNNEL_KEY });
    await lateFloatingHud.open;
    const replayedFloatingMsg = await lateFloatingHud.nextWhere((m) => m.type === "device");
    assert.deepEqual(replayedFloatingMsg, { type: "device", device: expectedUnknown });
    await lateFloatingHud.close();

    const doffedRes = await fetch(`${baseUrl}/ingest/state?session=${session}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-holdup-key": TUNNEL_KEY },
      body: JSON.stringify({ connected: true, worn: false, battery: 14, streaming: false }),
    });
    assert.equal(doffedRes.status, 204);
    const expectedDoffed: DeviceState = {
      connected: true,
      worn: false,
      battery: 14,
      streaming: false,
      source: "glasses",
    };
    const doffedHudMsg = await liveHud.nextWhere((m) => m.type === "device");
    assert.deepEqual(doffedHudMsg, { type: "device", device: expectedDoffed });
    assert.deepEqual((await fetchHealth()).body.glasses.device, expectedDoffed);

    const donnedRes = await fetch(stateEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: true, battery: 91, streaming: true }),
    });
    assert.equal(donnedRes.status, 204);
    const expectedDonned: DeviceState = {
      connected: true,
      worn: true,
      battery: 91,
      streaming: true,
      source: "glasses",
    };
    const donnedHudMsg = await liveHud.nextWhere((m) => m.type === "device");
    assert.deepEqual(donnedHudMsg, { type: "device", device: expectedDonned });
    assert.deepEqual((await fetchHealth()).body.glasses.device, expectedDonned);

    const nonFiniteRawBodies = [
      '{"connected":true,"worn":true,"battery":1e309,"streaming":true}',
      '{"connected":true,"worn":false,"battery":-1e309,"streaming":false}',
      JSON.stringify({ connected: true, worn: null, battery: Number.NaN, streaming: true }),
      JSON.stringify({ connected: true, worn: null, battery: Number.POSITIVE_INFINITY, streaming: true }),
      JSON.stringify({ connected: true, worn: true, battery: "NaN", streaming: false }),
      JSON.stringify({ connected: true, worn: true, battery: "Infinity", streaming: false }),
    ];

    assert.equal(JSON.parse(nonFiniteRawBodies[0]).battery, Infinity);
    assert.equal(JSON.parse(nonFiniteRawBodies[1]).battery, -Infinity);

    for (const rawJson of nonFiniteRawBodies) {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const expectedWorn = typeof parsed.worn === "boolean" ? parsed.worn : null;
      const expectedStreaming = Boolean(parsed.streaming);

      const res = await fetch(stateEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawJson,
      });
      assert.equal(res.status, 204);

      const expectedCoerced: DeviceState = {
        connected: true,
        worn: expectedWorn,
        battery: null,
        streaming: expectedStreaming,
        source: "glasses",
      };
      const hudMsg = await liveHud.nextWhere((m) => m.type === "device");
      assert.deepEqual(hudMsg, { type: "device", device: expectedCoerced });
      assert.deepEqual((await fetchHealth()).body.glasses.device, expectedCoerced);
    }

    await liveHud.close();
  } finally {
    restoreHoldupKey();
  }
});

test("createApp() standalone HTTP app enforces HOLDUP_KEY on /ingest routes while keeping /api/health open", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  const appServer = http.createServer(createApp());
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = appServer.address();
    if (!addr || typeof addr === "string") throw new Error("expected tcp address");
    const appBase = `http://127.0.0.1:${addr.port}`;
    const session = "create-app-direct-sess";
    const hub = createTrackedHub(session);
    hub.source = "glasses";

    const healthRes = await fetch(`${appBase}/api/health`);
    assert.equal(healthRes.status, 200);

    await assertUnauthorized(
      await fetch(`${appBase}/ingest/frame?session=${session}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: makeValidJpeg(140, 0x22),
      }),
    );

    const frameOk = await fetch(
      uploaderEndpointMirror(`${appBase}/?key=${TUNNEL_KEY}`, "/ingest/frame", session),
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: makeValidJpeg(140, 0x23),
      },
    );
    assert.equal(frameOk.status, 204);
    assert.equal(hub.ring.length, 1);

    const stateOk = await fetch(`${appBase}/ingest/state?session=${session}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-holdup-key": TUNNEL_KEY },
      body: JSON.stringify({ connected: true, worn: null, battery: null, streaming: false }),
    });
    assert.equal(stateOk.status, 204);
    assert.equal(hub.device?.worn, null);
    assert.equal(hub.device?.battery, null);
  } finally {
    restoreHoldupKey();
    appServer.closeAllConnections?.();
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  }
});

test("android-dat Uploader.kt source contract preserves ?key= query params alongside URL-encoded ?session= and nullable GlassesState JSON", () => {
  const uploaderPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/main/java/app/holdup/bridge/Uploader.kt",
  );
  const src = fs.readFileSync(uploaderPath, "utf8");

  assert.match(src, /data class GlassesState\([\s\S]*?val worn:\s*Boolean\?/);
  assert.match(src, /data class GlassesState\([\s\S]*?val battery:\s*Int\?/);
  assert.ok(src.includes('${worn ?: "null"}'));
  assert.ok(src.includes('${battery ?: "null"}'));
  assert.equal(src.includes('${worn ?: false}'), false);
  assert.equal(src.includes('${battery ?: 0}'), false);

  assert.ok(src.includes("val q = raw.indexOf('?')"));
  assert.ok(src.includes("split('&').filter { it.isNotBlank() }"));
  assert.ok(src.includes('URLEncoder.encode(s, "UTF-8")'));
  assert.ok(src.includes("normalizeServer(host) + path"));
  assert.ok(src.includes('params.joinToString("&")'));

  assert.equal(
    uploaderEndpointMirror("https://x.trycloudflare.com/?key=K_123", "/ingest/frame", "ab 12/3"),
    "https://x.trycloudflare.com/ingest/frame?key=K_123&session=ab+12%2F3",
  );
  assert.equal(
    uploaderEndpointMirror("  x.trycloudflare.com/?key=K_123  ", "/ingest/state", ""),
    "https://x.trycloudflare.com/ingest/state?key=K_123",
  );
});

test("android-dat BridgeViewModel.kt source contract enforces adaptive frameIntervalMs backoff, reconnect/stream caps, and normalizeBatteryLevel(0) == null", () => {
  const vmPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt",
  );
  const src = fs.readFileSync(vmPath, "utf8");

  assert.ok(src.includes("FRAME_INTERVAL_MS = 1_000L"));
  assert.ok(src.includes("MAX_BACKOFF_MS = 8_000L"));
  assert.ok(src.includes("min(MAX_BACKOFF_MS, FRAME_INTERVAL_MS shl min(netFailures, 3))"));
  assert.ok(src.includes("min(15_000L, 2_000L shl min(attempt.coerceAtLeast(0), 3))"));
  assert.ok(src.includes("min(10_000L, 1_500L shl min(attempt.coerceAtLeast(0), 3))"));
  assert.ok(src.includes("normalizeBatteryLevel(rawLevel: Int): Int? = rawLevel.takeIf { it > 0 }"));

  assert.match(src, /DonState\.DONNED\s*->\s*true/);
  assert.match(src, /DonState\.DOFFED\s*->\s*false/);
  assert.match(src, /else\s*->\s*null/);
  assert.ok(src.includes("val server = Uploader.normalizeServer(serverUrl)"));

  const frameIntervalMs = (netFailures: number) =>
    netFailures <= 0 ? 1_000 : Math.min(8_000, 1_000 << Math.min(netFailures, 3));
  const reconnectDelayMs = (attempt: number) =>
    Math.min(15_000, 2_000 << Math.min(Math.max(attempt, 0), 3));
  const streamRetryDelayMs = (attempt: number) =>
    Math.min(10_000, 1_500 << Math.min(Math.max(attempt, 0), 3));
  const normalizeBatteryLevel = (rawLevel: number) => (rawLevel > 0 ? rawLevel : null);

  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 10].map(frameIntervalMs),
    [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10].map(reconnectDelayMs),
    [2_000, 4_000, 8_000, 15_000, 15_000, 15_000],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10].map(streamRetryDelayMs),
    [1_500, 3_000, 6_000, 10_000, 10_000, 10_000],
  );
  assert.equal(normalizeBatteryLevel(0), null);
  assert.equal(normalizeBatteryLevel(-5), null);
  assert.equal(normalizeBatteryLevel(1), 1);
  assert.equal(normalizeBatteryLevel(88), 88);
});

test("android-dat EN/FI/SV strings.xml files maintain exact key parity, non-empty translations, and placeholder hygiene", () => {
  const resDir = path.join(REPO_ROOT, "android-dat/app/src/main/res");
  const localeFiles = {
    en: path.join(resDir, "values/strings.xml"),
    fi: path.join(resDir, "values-fi/strings.xml"),
    sv: path.join(resDir, "values-sv/strings.xml"),
  };

  type ParsedString = { name: string; value: string; translatable: boolean };

  const parseStringsXml = (filePath: string): Map<string, ParsedString> => {
    assert.equal(fs.existsSync(filePath), true, `missing ${filePath}`);
    const xml = fs.readFileSync(filePath, "utf8");
    assert.equal(xml.includes("<!--"), false, `unexpected XML comment in ${filePath}`);
    assert.equal(xml.includes("\u2014"), false, `unexpected em dash in ${filePath}`);
    assert.match(xml, /<resources>\s*[\s\S]*<\/resources>/);

    const map = new Map<string, ParsedString>();
    const tagRe = /<string\s+([^>]+)>([\s\S]*?)<\/string>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(xml)) !== null) {
      const attrs = match[1];
      const rawValue = match[2];
      const nameMatch = /\bname="([^"]+)"/.exec(attrs);
      assert.ok(nameMatch, `string tag missing name attribute in ${filePath}`);
      const name = nameMatch[1];
      assert.ok(name.trim().length > 0, `blank string name in ${filePath}`);
      assert.equal(map.has(name), false, `duplicate string key ${name} in ${filePath}`);
      assert.ok(rawValue.trim().length > 0, `empty translation for ${name} in ${filePath}`);
      assert.equal(rawValue, rawValue.trim(), `untrimmed value for ${name} in ${filePath}`);
      assert.equal(
        /\b(TODO|TBD|FIXME|UNTRANSLATED)\b/i.test(rawValue) || /\{\{.*?\}\}/.test(rawValue),
        false,
        `untranslated placeholder marker in ${name} (${filePath})`,
      );
      const translatableMatch = /\btranslatable="([^"]+)"/.exec(attrs);
      const translatable = translatableMatch?.[1]?.toLowerCase() !== "false";
      map.set(name, { name, value: rawValue, translatable });
    }
    assert.ok(map.size >= 4, `expected at least 4 strings in ${filePath}`);
    return map;
  };

  const extractPlaceholders = (text: string): string[] =>
    Array.from(text.matchAll(/%(\d+\$)?[-#+ 0,]*\d*(\.\d+)?[a-zA-Z]/g), (m) => m[0]);

  const en = parseStringsXml(localeFiles.en);
  const fi = parseStringsXml(localeFiles.fi);
  const sv = parseStringsXml(localeFiles.sv);

  const enKeys = [...en.keys()].sort();
  const fiKeys = [...fi.keys()].sort();
  const svKeys = [...sv.keys()].sort();

  assert.deepEqual(fiKeys, enKeys);
  assert.deepEqual(svKeys, enKeys);

  for (const [key, enEntry] of en) {
    const fiEntry = fi.get(key)!;
    const svEntry = sv.get(key)!;
    assert.deepEqual(extractPlaceholders(fiEntry.value), extractPlaceholders(enEntry.value));
    assert.deepEqual(extractPlaceholders(svEntry.value), extractPlaceholders(enEntry.value));

    if (key === "app_name") {
      assert.equal(enEntry.value, "HoldUp Bridge");
      assert.equal(fiEntry.value, "HoldUp Bridge");
      assert.equal(svEntry.value, "HoldUp Bridge");
    } else if (enEntry.translatable) {
      assert.notEqual(fiEntry.value, enEntry.value, `Finnish ${key} matches English`);
      assert.notEqual(svEntry.value, enEntry.value, `Swedish ${key} matches English`);
      assert.notEqual(fiEntry.value, svEntry.value, `Finnish and Swedish ${key} are identical`);
    }
  }

  const mainDir = path.join(REPO_ROOT, "android-dat/app/src/main");
  const referenced = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".xml")) {
        const txt = fs.readFileSync(full, "utf8");
        for (const m of txt.matchAll(/@string\/([A-Za-z0-9_]+)/g)) referenced.add(m[1]);
      } else if (entry.name.endsWith(".kt")) {
        const txt = fs.readFileSync(full, "utf8");
        for (const m of txt.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) referenced.add(m[1]);
      }
    }
  };
  walk(mainDir);
  assert.ok(referenced.size > 0);
  for (const ref of referenced) {
    assert.equal(en.has(ref), true, `missing default string ${ref}`);
    assert.equal(fi.has(ref), true, `missing fi string ${ref}`);
    assert.equal(sv.has(ref), true, `missing sv string ${ref}`);
  }
});
