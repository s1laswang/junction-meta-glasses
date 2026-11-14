import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import WebSocket from "ws";
import { env } from "../src/env.ts";
import { authEnabled, keyOk } from "../src/auth.ts";
import { startServer } from "../src/index.ts";

const TEST_KEY = "test-access-key";
const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;

let server: http.Server;
let baseUrl = "";
let wsBaseUrl = "";
const sockets = new Set<WebSocket>();

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function trackSocket(url: string, headers?: Record<string, string>): WebSocket {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  sockets.add(ws);
  ws.once("close", () => sockets.delete(ws));
  return ws;
}

async function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    sockets.delete(ws);
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
  sockets.delete(ws);
}

function assertSecurityHeaders(res: Response) {
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.has("x-powered-by"), false);
  assert.equal(res.headers.get("x-powered-by"), null);
}

async function assertUnauthorizedJson(res: Response) {
  assert.equal(res.status, 401);
  assertSecurityHeaders(res);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "unauthorized");
  assert.equal(body.recoverable, false);
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws close")), 3000);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws open")), 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForJsonMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for ws message"));
    }, 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(parsed);
      }
    };
    ws.on("message", onMessage);
  });
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  restoreHoldupKey();
});

after(async () => {
  restoreHoldupKey();
  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
  env.apiKey = origApiKey;

  for (const ws of [...sockets]) {
    await closeSocket(ws);
  }
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("security headers and absent X-Powered-By across health, stats, verify 400, ingest state 204, and unknown 404", async () => {
  delete process.env.HOLDUP_KEY;

  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assertSecurityHeaders(healthRes);

  const statsRes = await fetch(`${baseUrl}/api/stats`);
  assert.equal(statsRes.status, 200);
  assertSecurityHeaders(statsRes);

  const verifyRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(verifyRes.status, 400);
  assertSecurityHeaders(verifyRes);

  const ingestStateRes = await fetch(`${baseUrl}/ingest/state?session=sec-headers-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: false, worn: null, streaming: false, battery: null }),
  });
  assert.equal(ingestStateRes.status, 204);
  assertSecurityHeaders(ingestStateRes);

  const unknownRes = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(unknownRes.status, 404);
  assertSecurityHeaders(unknownRes);
});

test("authEnabled() and keyOk() unit behaviour for unset, exact match, wrong key, empty/null, and different lengths", () => {
  delete process.env.HOLDUP_KEY;
  assert.equal(authEnabled(), false);
  assert.equal(keyOk(undefined), true);
  assert.equal(keyOk(null), true);
  assert.equal(keyOk(""), true);
  assert.equal(keyOk("any-value"), true);

  process.env.HOLDUP_KEY = "";
  assert.equal(authEnabled(), false);
  assert.equal(keyOk(null), true);
  assert.equal(keyOk(""), true);

  process.env.HOLDUP_KEY = TEST_KEY;
  assert.equal(authEnabled(), true);
  assert.equal(keyOk(TEST_KEY), true);
  assert.equal(keyOk("test-access-kez"), false);
  assert.equal(keyOk("TEST-ACCESS-KEY"), false);
  assert.equal(keyOk(""), false);
  assert.equal(keyOk(null), false);
  assert.equal(keyOk(undefined), false);
  assert.equal(keyOk("t"), false);
  assert.equal(keyOk("test-access"), false);
  assert.equal(keyOk("test-access-key-extra"), false);
  assert.equal(keyOk(` ${TEST_KEY} `), false);
  assert.equal(keyOk("x".repeat(256)), false);
});

test("HTTP HOLDUP_KEY leaves GET /api/health open without key", async () => {
  process.env.HOLDUP_KEY = TEST_KEY;

  const noKey = await fetch(`${baseUrl}/api/health`);
  assert.equal(noKey.status, 200);
  assertSecurityHeaders(noKey);
  const body = await noKey.json() as Record<string, unknown>;
  assert.equal(body.ok, true);

  const wrongKey = await fetch(`${baseUrl}/api/health?key=wrong-key`, {
    headers: { "x-holdup-key": "wrong-key" },
  });
  assert.equal(wrongKey.status, 200);
  assertSecurityHeaders(wrongKey);
});

test("HTTP HOLDUP_KEY enforces 401 on missing/wrong key and accepts ?key= or x-holdup-key across /api and /ingest routes", async () => {
  process.env.HOLDUP_KEY = TEST_KEY;
  const jpegBytes = new Uint8Array(128).fill(0xff);

  const routes: {
    name: string;
    path: string;
    init: RequestInit;
    expectedAuthedStatus: number;
  }[] = [
    {
      name: "GET /api/stats",
      path: "/api/stats",
      init: { method: "GET" },
      expectedAuthedStatus: 200,
    },
    {
      name: "POST /api/verify",
      path: "/api/verify",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      expectedAuthedStatus: 400,
    },
    {
      name: "POST /api/tts",
      path: "/api/tts",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      expectedAuthedStatus: 400,
    },
    {
      name: "POST /ingest/frame",
      path: "/ingest/frame?session=http-auth-test",
      init: { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpegBytes },
      expectedAuthedStatus: 204,
    },
    {
      name: "POST /ingest/state",
      path: "/ingest/state?session=http-auth-test",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      expectedAuthedStatus: 204,
    },
  ];

  for (const route of routes) {
    const sep = route.path.includes("?") ? "&" : "?";
    const baseHeaders = (route.init.headers ?? {}) as Record<string, string>;

    const missingRes = await fetch(`${baseUrl}${route.path}`, route.init);
    await assertUnauthorizedJson(missingRes);

    const wrongQueryRes = await fetch(`${baseUrl}${route.path}${sep}key=wrong-key`, route.init);
    await assertUnauthorizedJson(wrongQueryRes);

    const wrongHeaderRes = await fetch(`${baseUrl}${route.path}`, {
      ...route.init,
      headers: { ...baseHeaders, "x-holdup-key": "wrong-key" },
    });
    await assertUnauthorizedJson(wrongHeaderRes);

    const validQueryRes = await fetch(`${baseUrl}${route.path}${sep}key=${TEST_KEY}`, route.init);
    assert.equal(validQueryRes.status, route.expectedAuthedStatus, `${route.name} via ?key=`);
    assertSecurityHeaders(validQueryRes);

    const validHeaderRes = await fetch(`${baseUrl}${route.path}`, {
      ...route.init,
      headers: { ...baseHeaders, "x-holdup-key": TEST_KEY },
    });
    assert.equal(validHeaderRes.status, route.expectedAuthedStatus, `${route.name} via x-holdup-key`);
    assertSecurityHeaders(validHeaderRes);
  }
});

test("WS /live and /hud-ws reject missing or wrong key with close code 4401 unauthorized", async () => {
  process.env.HOLDUP_KEY = TEST_KEY;

  for (const endpoint of ["/live?session=ws-reject-test", "/hud-ws?session=ws-reject-test"]) {
    const missingWs = trackSocket(`${wsBaseUrl}${endpoint}`);
    const missingClosed = await waitForClose(missingWs);
    assert.equal(missingClosed.code, 4401);
    assert.equal(missingClosed.reason, "unauthorized");

    const wrongQueryWs = trackSocket(`${wsBaseUrl}${endpoint}&key=wrong-key`);
    const wrongQueryClosed = await waitForClose(wrongQueryWs);
    assert.equal(wrongQueryClosed.code, 4401);
    assert.equal(wrongQueryClosed.reason, "unauthorized");

    const wrongHeaderWs = trackSocket(`${wsBaseUrl}${endpoint}`, { "x-holdup-key": "wrong-key" });
    const wrongHeaderClosed = await waitForClose(wrongHeaderWs);
    assert.equal(wrongHeaderClosed.code, 4401);
    assert.equal(wrongHeaderClosed.reason, "unauthorized");
  }
});

test("WS /live connects with valid ?key= or x-holdup-key and answers ping with pong", async () => {
  process.env.HOLDUP_KEY = TEST_KEY;

  const liveByQuery = trackSocket(`${wsBaseUrl}/live?session=ws-live-query&key=${TEST_KEY}`);
  await waitForOpen(liveByQuery);
  const pongByQueryPromise = waitForJsonMessage(liveByQuery, (m) => m.type === "pong");
  liveByQuery.send(JSON.stringify({ type: "ping", t: 101 }));
  const pongByQuery = await pongByQueryPromise;
  assert.deepEqual(pongByQuery, { type: "pong", t: 101 });
  await closeSocket(liveByQuery);

  const liveByHeader = trackSocket(`${wsBaseUrl}/live?session=ws-live-header`, { "x-holdup-key": TEST_KEY });
  await waitForOpen(liveByHeader);
  const pongByHeaderPromise = waitForJsonMessage(liveByHeader, (m) => m.type === "pong");
  liveByHeader.send(JSON.stringify({ type: "ping", t: 202 }));
  const pongByHeader = await pongByHeaderPromise;
  assert.deepEqual(pongByHeader, { type: "pong", t: 202 });
  await closeSocket(liveByHeader);
});

test("WS /hud-ws connects cleanly with valid ?key= or x-holdup-key", async () => {
  process.env.HOLDUP_KEY = TEST_KEY;

  const liveSessionQuery = "ws-hud-query";
  const liveForQuery = trackSocket(`${wsBaseUrl}/live?session=${liveSessionQuery}&key=${TEST_KEY}`);
  await waitForOpen(liveForQuery);
  const pong1 = waitForJsonMessage(liveForQuery, (m) => m.type === "pong");
  liveForQuery.send(JSON.stringify({ type: "ping", t: 1 }));
  await pong1;

  const hudConnectedByQuery = waitForJsonMessage(liveForQuery, (m) => m.type === "hud" && m.connected === true);
  const hudByQuery = trackSocket(`${wsBaseUrl}/hud-ws?session=${liveSessionQuery}&key=${TEST_KEY}`);
  await waitForOpen(hudByQuery);
  await hudConnectedByQuery;
  assert.equal(hudByQuery.readyState, WebSocket.OPEN);
  await closeSocket(hudByQuery);
  await closeSocket(liveForQuery);

  const liveSessionHeader = "ws-hud-header";
  const liveForHeader = trackSocket(`${wsBaseUrl}/live?session=${liveSessionHeader}&key=${TEST_KEY}`);
  await waitForOpen(liveForHeader);
  const pong2 = waitForJsonMessage(liveForHeader, (m) => m.type === "pong");
  liveForHeader.send(JSON.stringify({ type: "ping", t: 2 }));
  await pong2;

  const hudConnectedByHeader = waitForJsonMessage(liveForHeader, (m) => m.type === "hud" && m.connected === true);
  const hudByHeader = trackSocket(`${wsBaseUrl}/hud-ws?session=${liveSessionHeader}`, { "x-holdup-key": TEST_KEY });
  await waitForOpen(hudByHeader);
  await hudConnectedByHeader;
  assert.equal(hudByHeader.readyState, WebSocket.OPEN);
  await closeSocket(hudByHeader);
  await closeSocket(liveForHeader);
});

test("WS /live and /hud-ws allow unauthenticated connections when HOLDUP_KEY is unset", async () => {
  delete process.env.HOLDUP_KEY;

  const liveWs = trackSocket(`${wsBaseUrl}/live?session=ws-open-mode`);
  await waitForOpen(liveWs);
  const pongPromise = waitForJsonMessage(liveWs, (m) => m.type === "pong");
  liveWs.send(JSON.stringify({ type: "ping", t: 303 }));
  const pong = await pongPromise;
  assert.deepEqual(pong, { type: "pong", t: 303 });

  const hudConnected = waitForJsonMessage(liveWs, (m) => m.type === "hud" && m.connected === true);
  const hudWs = trackSocket(`${wsBaseUrl}/hud-ws?session=ws-open-mode`);
  await waitForOpen(hudWs);
  await hudConnected;
  assert.equal(hudWs.readyState, WebSocket.OPEN);

  await closeSocket(hudWs);
  await closeSocket(liveWs);
});
