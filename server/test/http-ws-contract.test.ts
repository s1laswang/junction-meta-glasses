import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import WebSocket from "ws";
import { startServer } from "../src/index.ts";
import { getHub, getOrCreateHub } from "../src/hub.ts";

process.env.HOLDUP_QUIET = "1";
const savedKey = process.env.HOLDUP_KEY;
delete process.env.HOLDUP_KEY;

type Msg = Record<string, unknown>;
let server: http.Server, httpBase = "", wsBase = "";
const sockets: WebSocket[] = [];

async function postJson(path: string, body: unknown) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${httpBase}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  return { status: res.status, body: (await res.json()) as Msg };
}

function assertError(body: Msg, code: string, recoverable?: boolean) {
  assert.equal(body.type, "error");
  assert.equal(body.code, code);
  if (recoverable !== undefined) assert.equal(body.recoverable, recoverable);
}

function connectWs(pathAndQuery: string) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`);
  sockets.push(ws);
  const queue: Msg[] = [], waiters: ((m: Msg) => void)[] = [];
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as Msg;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  const open = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const next = (timeoutMs = 3000): Promise<Msg> => queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<Msg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS timeout on ${pathAndQuery}`)), timeoutMs);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { ws, open, next, close, queue };
}

before(async () => {
  server = await startServer(0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  httpBase = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    server?.closeAllConnections?.();
  } finally {
    if (savedKey !== undefined) process.env.HOLDUP_KEY = savedKey;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP POST /api/verify with empty object returns 400 bad_input", async () => {
  const { status, body } = await postJson("/api/verify", {});
  assert.equal(status, 400);
  assertError(body, "bad_input", true);
});

test("HTTP POST /api/verify with existing 0-frame session returns 409 no_frames", async () => {
  const hub = getOrCreateHub("sess-empty-1");
  hub.dropFrames();
  assert.equal(hub.ring.length, 0);
  const { status, body } = await postJson("/api/verify", { session: "sess-empty-1" });
  assert.equal(status, 409);
  assertError(body, "no_frames", true);
});

test("HTTP POST /api/tts with empty text returns 400 bad_input", async () => {
  const { status, body } = await postJson("/api/tts", { text: "" });
  assert.equal(status, 400);
  assertError(body, "bad_input", true);
});

test("HTTP POST /ingest/frame with 10-byte body returns 400 bad_input", async () => {
  const res = await fetch(`${httpBase}/ingest/frame`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: Buffer.alloc(10, 0xff) });
  assert.equal(res.status, 400);
  assertError((await res.json()) as Msg, "bad_input", true);
});

test("HTTP malformed JSON body returns 400 bad_input", async () => {
  const { status, body } = await postJson("/api/verify", "{bad");
  assert.equal(status, 400);
  assertError(body, "bad_input");
});

test("HTTP unknown route GET /api/does-not-exist returns 404 not_found", async () => {
  const res = await fetch(`${httpBase}/api/does-not-exist`);
  assert.equal(res.status, 404);
  assertError((await res.json()) as Msg, "not_found", false);
});

test("WS /live protocol errors and ping/pong without starting Gemini", async () => {
  const live = connectWs("/live?session=ws-test-1");
  try {
    await live.open;
    live.ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    assertError(await live.next(), "bad_input");

    live.ws.send("{invalid-json", { binary: false });
    assertError(await live.next(), "bad_input");

    live.ws.send(JSON.stringify({ type: "text", text: "hello" }));
    const textErr = await live.next();
    assertError(textErr, "bad_input");
    assert.equal(textErr.message, "send start first");

    live.ws.send(JSON.stringify({ type: "bogus" }));
    assertError(await live.next(), "bad_input");

    live.ws.send(JSON.stringify({ type: "ping", t: 12345 }));
    assert.deepEqual(await live.next(), { type: "pong", t: 12345 });
  } finally {
    await live.close();
  }
});

test("WS /hud-ws attachment and allowed event forwarding to /live", async () => {
  const live = connectWs("/live?session=ws-test-1");
  let hud: ReturnType<typeof connectWs> | undefined;
  try {
    await live.open;
    hud = connectWs("/hud-ws?session=ws-test-1");
    await hud.open;
    assert.deepEqual(await live.next(), { type: "hud", connected: true });

    hud.ws.send(JSON.stringify({ type: "event", name: "hack" }));
    for (const name of ["log_dose", "repeat", "dismiss"] as const) {
      hud.ws.send(JSON.stringify({ type: "event", name }));
      assert.deepEqual(await live.next(), { type: "hud_event", name });
    }
    hud.ws.send(JSON.stringify({ type: "event", name: "hack" }));
    await hud.close();
    assert.deepEqual(await live.next(), { type: "hud", connected: false });
    assert.equal(live.queue.length, 0);
  } finally {
    await hud?.close();
    await live.close();
  }
});

test("WS /live glasses source ingest and zero-retention frame drop on close", async () => {
  const live = connectWs("/live?session=ws-test-1");
  try {
    await live.open;
    live.ws.send(JSON.stringify({ type: "source", source: "glasses" }));
    live.ws.send(JSON.stringify({ type: "ping", t: 77 }));
    assert.deepEqual(await live.next(), { type: "pong", t: 77 });

    const jpeg = Buffer.alloc(128, 0);
    jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[126] = 0xff; jpeg[127] = 0xd9;
    const res = await fetch(`${httpBase}/ingest/frame?session=ws-test-1`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg });
    assert.equal(res.status, 204);
    assert.equal(getHub("ws-test-1")!.ring.length, 1);

    await live.close();
    assert.equal(getHub("ws-test-1")!.ring.length, 0);
  } finally {
    await live.close();
  }
});

test("WS upgrade to unknown path /bad-ws destroys socket cleanly", async () => {
  const ws = new WebSocket(`${wsBase}/bad-ws`);
  sockets.push(ws);
  let opened = false;
  let errored = false;
  ws.on("open", () => { opened = true; });
  ws.on("error", () => { errored = true; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout on /bad-ws")), 3000);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(opened, false);
  assert.equal(errored, true);
  assert.equal(ws.readyState, WebSocket.CLOSED);
});
