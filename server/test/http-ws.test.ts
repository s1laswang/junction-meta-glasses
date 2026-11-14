import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { ServerMsg } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { getHub, startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

let server: http.Server;
let baseUrl = "";
let wsBase = "";
let prevApiKey = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
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
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
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

test("GET /api/health returns 200 JSON with ok, models, and version", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.ok(body.version.length > 0);
  assert.ok(Array.isArray(body.models?.live));
  assert.ok(Array.isArray(body.models?.verify));
  assert.ok(Array.isArray(body.models?.tts));
});

test("GET /api/stats returns 200 JSON with total and features", async () => {
  const res = await fetch(`${baseUrl}/api/stats`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(typeof body.total, "number");
  assert.equal(typeof body.features, "object");
  assert.notEqual(body.features, null);
});

test("POST /api/verify with empty frames returns 400 bad_input", async () => {
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "bad_input");
  assert.equal(body.recoverable, true);
});

test("POST /api/tts with empty text returns 400 bad_input", async () => {
  const res = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "bad_input");
  assert.equal(body.recoverable, true);
});

test("POST /ingest/frame rejects small invalid body with 400 and accepts valid JPEG with 204", async () => {
  const bad = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array([0xff, 0xd8, 0xff]),
  });
  assert.equal(bad.status, 400);
  const badBody = (await bad.json()) as Record<string, any>;
  assert.equal(badBody.code, "bad_input");

  const jpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const ok = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpg),
  });
  assert.equal(ok.status, 204);
});

test("WebSocket /live and /hud-ws protocol, errors, and /ingest/state fan-out", async () => {
  const live = openWs(`${wsBase}/live?session=test1`);
  const hud = openWs(`${wsBase}/hud-ws?session=test1`);
  try {
    await Promise.all([live.ready, hud.ready]);

    live.ws.send(JSON.stringify({ type: "ping", t: 98765 }));
    const pong = await live.next();
    assert.deepEqual(pong, { type: "pong", t: 98765 });

    live.ws.send(Buffer.from([0x01, 0x02, 0x03, 0x04]), { binary: true });
    const binErr = await live.next();
    assert.equal(binErr.type, "error");
    if (binErr.type === "error") {
      assert.equal(binErr.code, "bad_input");
      assert.equal(binErr.recoverable, true);
    }

    live.ws.send("{malformed-json", { binary: false });
    const jsonErr = await live.next();
    assert.equal(jsonErr.type, "error");
    if (jsonErr.type === "error") {
      assert.equal(jsonErr.code, "bad_input");
      assert.equal(jsonErr.recoverable, true);
    }

    live.ws.send(JSON.stringify({ type: "text", text: "Is this my evening pill?" }));
    const startErr = await live.next();
    assert.equal(startErr.type, "error");
    if (startErr.type === "error") {
      assert.equal(startErr.code, "bad_input");
      assert.equal(startErr.recoverable, true);
      assert.match(startErr.message, /send start first/);
    }

    const jpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
    const frameRes = await fetch(`${baseUrl}/ingest/frame?session=test1`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(jpg),
    });
    assert.equal(frameRes.status, 204);
    assert.equal(getHub("test1")?.ring.length, 1);

    const stateRes = await fetch(`${baseUrl}/ingest/state?session=test1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: true, streaming: true, battery: 76 }),
    });
    assert.equal(stateRes.status, 204);

    const [liveDev, hudDev] = await Promise.all([live.next(), hud.next()]);
    const expected = {
      type: "device",
      device: { connected: true, worn: true, streaming: true, battery: 76, source: "glasses" },
    };
    assert.deepEqual(liveDev, expected);
    assert.deepEqual(hudDev, expected);
  } finally {
    await Promise.all([live.close(), hud.close()]);
  }
  for (let i = 0; i < 20 && (getHub("test1")?.clients.size ?? 0) > 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(getHub("test1")?.ring.length, 0);
});

test("unknown WebSocket upgrade path /bogus destroys socket cleanly", async () => {
  const ws = new WebSocket(`${wsBase}/bogus`);
  let opened = false;
  let sawError = false;
  ws.on("open", () => { opened = true; });
  ws.on("error", () => { sawError = true; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for /bogus close")), 2000);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(opened, false);
  assert.equal(sawError, true);
});
