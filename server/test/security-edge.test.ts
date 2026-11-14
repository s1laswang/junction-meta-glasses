import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { ServerMsg } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { getOrCreateHub, hubStats, latestHub, resetHubsForTest } from "../src/hub.ts";
import { getHub, startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_FRAME_B64 = Buffer.alloc(120, 0x61).toString("base64");

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
  const waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    const idx = waiters.findIndex((w) => w.pred(parsed));
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      w.resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const nextWhere = (pred: (m: ServerMsg) => boolean, timeoutMs = 2000): Promise<ServerMsg> => {
    const qIdx = queue.findIndex(pred);
    if (qIdx !== -1) {
      const [item] = queue.splice(qIdx, 1);
      return Promise.resolve(item);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m: ServerMsg) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error("timed out waiting for ws message"));
      }, timeoutMs);
      waiters.push(entry);
    });
  };

  const next = (timeoutMs = 2000): Promise<ServerMsg> => nextWhere(() => true, timeoutMs);

  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });

  return { ws, ready, next, nextWhere, close };
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("path-traversal and hostile characters in /live?session= are rejected in favor of a safe UUID", async () => {
  const origRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const generated: string[] = [];
  globalThis.crypto.randomUUID = (() => {
    const id = origRandomUUID();
    generated.push(id);
    return id;
  }) as typeof globalThis.crypto.randomUUID;

  const hostileRaw = ["../../etc/passwd", "../secret/key", "bad$id<script>"];
  const clients = hostileRaw.map((s) => openWs(`${wsBase}/live?session=${encodeURIComponent(s)}`));
  const unencoded = openWs(`${wsBase}/live?session=../../etc/passwd`);
  const allClients = [...clients, unencoded];

  try {
    await Promise.all(allClients.map((c) => c.ready));
    for (let i = 0; i < allClients.length; i++) {
      allClients[i].ws.send(JSON.stringify({ type: "ping", t: i + 1 }));
      const pong = await allClients[i].next();
      assert.deepEqual(pong, { type: "pong", t: i + 1 });
    }

    for (const s of hostileRaw) {
      assert.equal(getHub(s), undefined);
    }
    assert.equal(generated.length, 4);
    assert.equal(hubStats().sessions, 4);
    for (const uuid of generated) {
      assert.match(uuid, UUID_V4_RE);
      const hub = getHub(uuid);
      assert.notEqual(hub, undefined);
      assert.equal(hub?.clients.size, 1);
    }
  } finally {
    globalThis.crypto.randomUUID = origRandomUUID;
    await Promise.all(allClients.map((c) => c.close()));
  }
});

test("short (< 4 chars) and overlong (> 64 chars) /live?session= values get safe UUIDs while 4..64 bounds succeed", async () => {
  const origRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const generated: string[] = [];
  globalThis.crypto.randomUUID = (() => {
    const id = origRandomUUID();
    generated.push(id);
    return id;
  }) as typeof globalThis.crypto.randomUUID;

  const tooLong = "z".repeat(65);
  const exactMin = "abcd";
  const exactMax = "w".repeat(64);

  const cShort1 = openWs(`${wsBase}/live?session=a`);
  const cShort3 = openWs(`${wsBase}/live?session=abc`);
  const cLong = openWs(`${wsBase}/live?session=${tooLong}`);
  const cMin = openWs(`${wsBase}/live?session=${exactMin}`);
  const cMax = openWs(`${wsBase}/live?session=${exactMax}`);
  const all = [cShort1, cShort3, cLong, cMin, cMax];

  try {
    await Promise.all(all.map((c) => c.ready));
    for (let i = 0; i < all.length; i++) {
      all[i].ws.send(JSON.stringify({ type: "ping", t: 100 + i }));
      const pong = await all[i].next();
      assert.deepEqual(pong, { type: "pong", t: 100 + i });
    }

    assert.equal(getHub("a"), undefined);
    assert.equal(getHub("abc"), undefined);
    assert.equal(getHub(tooLong), undefined);
    assert.equal(generated.length, 3);
    for (const uuid of generated) {
      assert.match(uuid, UUID_V4_RE);
      assert.notEqual(getHub(uuid), undefined);
    }

    assert.notEqual(getHub(exactMin), undefined);
    assert.notEqual(getHub(exactMax), undefined);
    assert.equal(hubStats().sessions, 5);
  } finally {
    globalThis.crypto.randomUUID = origRandomUUID;
    await Promise.all(all.map((c) => c.close()));
  }
});

test("frame WS message with < 100 char data or non-string data returns recoverable bad_input without closing socket", async () => {
  const live = openWs(`${wsBase}/live?session=sec-frame`);
  await live.ready;
  try {
    const badPayloads = [
      { type: "frame", data: "" },
      { type: "frame", data: "x".repeat(99) },
      { type: "frame", data: 12345 },
      { type: "frame", data: null },
      { type: "frame", data: ["not-a-string"] },
      { type: "frame", data: { nested: "obj" } },
      { type: "frame" },
    ];

    for (const payload of badPayloads) {
      live.ws.send(JSON.stringify(payload));
      const msg = await live.next();
      assert.equal(msg.type, "error");
      if (msg.type === "error") {
        assert.equal(msg.code, "bad_input");
        assert.equal(msg.recoverable, true);
      }
      assert.equal(live.ws.readyState, WebSocket.OPEN);
    }

    assert.equal(getHub("sec-frame")?.ring.length, 0);

    live.ws.send(JSON.stringify({ type: "frame", data: VALID_FRAME_B64, sharpness: 99, w: 640, h: 480, ts: Date.now() }));
    live.ws.send(JSON.stringify({ type: "ping", t: 55 }));
    const pong = await live.next();
    assert.deepEqual(pong, { type: "pong", t: 55 });
    assert.equal(getHub("sec-frame")?.ring.length, 1);
    assert.equal(getHub("sec-frame")?.ring.pick(1)[0]?.sharpness, 1);
  } finally {
    await live.close();
  }
});

test("unknown WS message { type: exploit } and hostile JSON shapes return bad_input and keep /live open for ping/pong", async () => {
  const live = openWs(`${wsBase}/live?session=sec-exploit`);
  await live.ready;
  try {
    const hostileMessages = [
      JSON.stringify({ type: "exploit" }),
      JSON.stringify({ type: "__proto__", polluted: "yes" }),
      JSON.stringify(null),
      JSON.stringify(42),
      JSON.stringify(["exploit"]),
      "{unterminated-json",
    ];

    for (const raw of hostileMessages) {
      live.ws.send(raw);
      const errMsg = await live.next();
      assert.equal(errMsg.type, "error");
      if (errMsg.type === "error") {
        assert.equal(errMsg.code, "bad_input");
        assert.equal(errMsg.recoverable, true);
      }
      assert.equal(live.ws.readyState, WebSocket.OPEN);
    }

    assert.equal(({} as Record<string, unknown>).polluted, undefined);

    live.ws.send(JSON.stringify({ type: "ping", t: 2026 }));
    const pong = await live.next();
    assert.deepEqual(pong, { type: "pong", t: 2026 });
  } finally {
    await live.close();
  }
});

test("POST /ingest/state with hostile non-boolean and non-number fields coerces safely and returns 204", async () => {
  const live = openWs(`${wsBase}/live?session=sec-state`);
  await live.ready;
  const hud = openWs(`${wsBase}/hud-ws?session=sec-state`);
  await hud.ready;

  try {
    const initialHud = await live.nextWhere((m) => m.type === "hud");
    assert.deepEqual(initialHud, { type: "hud", connected: true });

    const res = await fetch(`${baseUrl}/ingest/state?session=sec-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connected: "yes",
        battery: "high",
        worn: 123,
        streaming: "",
        source: "spoofed",
        injected: { admin: true },
      }),
    });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");

    const [liveDev, hudDev] = await Promise.all([
      live.nextWhere((m) => m.type === "device"),
      hud.nextWhere((m) => m.type === "device"),
    ]);

    const expected = {
      type: "device",
      device: {
        connected: true,
        worn: true,
        streaming: false,
        battery: null,
        source: "glasses",
      },
    };
    assert.deepEqual(liveDev, expected);
    assert.deepEqual(hudDev, expected);
    assert.deepEqual(Object.keys(getHub("sec-state")?.device ?? {}).sort(), [
      "battery",
      "connected",
      "source",
      "streaming",
      "worn",
    ]);
  } finally {
    await Promise.all([live.close(), hud.close()]);
  }
});

test("POST /ingest/frame with no active session drops the frame in memory and returns 204 with 0 hubs", async () => {
  const jpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));

  const resNoSession = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpg),
  });
  assert.equal(resNoSession.status, 204);
  assert.equal(await resNoSession.text(), "");
  assert.equal(hubStats().sessions, 0);
  assert.equal(hubStats().latest, null);
  assert.equal(latestHub(), undefined);

  const resUnknownSession = await fetch(`${baseUrl}/ingest/frame?session=ghost-session`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(jpg),
  });
  assert.equal(resUnknownSession.status, 204);
  assert.equal(getHub("ghost-session"), undefined);
  assert.equal(hubStats().sessions, 0);

  const resWrongType = await fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-a-jpeg-buffer".repeat(20),
  });
  assert.equal(resWrongType.status, 400);
  const errBody = (await resWrongType.json()) as Record<string, unknown>;
  assert.equal(errBody.code, "bad_input");
  assert.equal(hubStats().sessions, 0);
});

test("POST /api/verify and POST /api/tts reject hostile non-string and undersized payloads with 400 bad_input", async () => {
  const verifyRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [null, 12345, { data: "evil" }, "short", "a".repeat(100)],
      question: 9999,
    }),
  });
  assert.equal(verifyRes.status, 400);
  assert.equal(verifyRes.headers.get("x-powered-by"), null);
  const verifyBody = (await verifyRes.json()) as Record<string, unknown>;
  assert.equal(verifyBody.type, "error");
  assert.equal(verifyBody.code, "bad_input");
  assert.equal(verifyBody.recoverable, true);

  const ttsRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: { nested: "attack" } }),
  });
  assert.equal(ttsRes.status, 400);
  assert.equal(ttsRes.headers.get("x-powered-by"), null);
  const ttsBody = (await ttsRes.json()) as Record<string, unknown>;
  assert.equal(ttsBody.type, "error");
  assert.equal(ttsBody.code, "bad_input");
  assert.equal(ttsBody.recoverable, true);
});

test("/live start profile update truncates and sanitizes hostile profile fields without network calls", async () => {
  const hub = getOrCreateHub("sec-profile");
  hub.live = {
    active: true,
    handleEvent() {},
    stop() {},
  };

  const live = openWs(`${wsBase}/live?session=sec-profile`);
  await live.ready;
  try {
    const oversizedMeds = Array.from({ length: 75 }, (_, i) => ({
      id: `id-${i}-${"x".repeat(80)}`,
      name: "N".repeat(200),
      ingredient: "I".repeat(200),
      strength: "S".repeat(80),
      schedule: Array.from({ length: 15 }, () => "M".repeat(60)),
    }));

    live.ws.send(
      JSON.stringify({
        type: "start",
        lang: "en-US-very-long-hostile-language-code",
        voice: "truthy",
        profile: {
          meds: oversizedMeds,
          allergies: "not-an-array",
          avoid: [null, 42, "grapefruit".repeat(10)],
          doseLog: [
            { medId: "bad-ts", ts: "yesterday" },
            { medId: "ok-med", ts: 1700000000000 },
          ],
          lang: "fi",
        },
      }),
    );

    live.ws.send(JSON.stringify({ type: "ping", t: 321 }));
    const pong = await live.nextWhere((m) => m.type === "pong");
    assert.deepEqual(pong, { type: "pong", t: 321 });

    assert.equal(hub.profile.meds.length, 50);
    assert.equal(hub.profile.meds[0].id.length, 64);
    assert.equal(hub.profile.meds[0].name.length, 120);
    assert.equal(hub.profile.meds[0].strength.length, 40);
    assert.equal(hub.profile.meds[0].schedule.length, 8);
    assert.equal(hub.profile.meds[0].schedule[0].length, 40);
    assert.deepEqual(hub.profile.allergies, []);
    assert.equal(hub.profile.avoid.length, 1);
    assert.equal(hub.profile.avoid[0].length, 60);
    assert.deepEqual(hub.profile.doseLog, [{ medId: "ok-med", ts: 1700000000000 }]);
    assert.equal(hub.profile.lang, "en-US-very-long-");
  } finally {
    await live.close();
  }
});

test("/hud-ws ignores malformed JSON and unauthorized event names while staying open for device updates", async () => {
  const hud = openWs(`${wsBase}/hud-ws?session=sec-hud`);
  await hud.ready;
  try {
    hud.ws.send("{invalid-json");
    hud.ws.send(JSON.stringify({ type: "exploit" }));
    hud.ws.send(JSON.stringify({ type: "event", name: "delete_all" }));
    hud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));

    const res = await fetch(`${baseUrl}/ingest/state?session=sec-hud`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: false, streaming: true, battery: 50 }),
    });
    assert.equal(res.status, 204);

    const dev = await hud.nextWhere((m) => m.type === "device");
    assert.deepEqual(dev, {
      type: "device",
      device: { connected: true, worn: false, streaming: true, battery: 50, source: "glasses" },
    });
    assert.equal(hud.ws.readyState, WebSocket.OPEN);
  } finally {
    await hud.close();
  }
});

test("rapid connect/disconnect stress: 15 concurrent /live + /hud-ws clients leave 0 leaked sockets and empty FrameRings", async () => {
  const count = 15;
  const sessionIds = Array.from({ length: count }, (_, i) => `stress-sess-${String(i).padStart(2, "0")}`);
  const lives = sessionIds.map((id) => openWs(`${wsBase}/live?session=${id}`));
  const huds = sessionIds.map((id, i) =>
    openWs(i % 3 === 0 ? `${wsBase}/hud-ws` : `${wsBase}/hud-ws?session=${id}`),
  );

  try {
    await Promise.all([...lives.map((c) => c.ready), ...huds.map((c) => c.ready)]);

    await Promise.all(
      lives.map(async (live, i) => {
        live.ws.send(
          JSON.stringify({
            type: "frame",
            data: VALID_FRAME_B64,
            sharpness: 0.75,
            w: 640,
            h: 480,
            ts: Date.now(),
          }),
        );
        live.ws.send(JSON.stringify({ type: "ping", t: 5000 + i }));
        const pong = await live.nextWhere((m) => m.type === "pong");
        assert.deepEqual(pong, { type: "pong", t: 5000 + i });
      }),
    );

    for (const id of sessionIds) {
      const hub = getHub(id);
      assert.notEqual(hub, undefined);
      assert.equal(hub?.clients.size, 1);
      assert.equal(hub?.ring.length, 1);
    }
  } finally {
    await Promise.all([...lives.map((c) => c.close()), ...huds.map((c) => c.close())]);
  }

  await waitUntil(
    () =>
      hubStats().floatingHuds === 0 &&
      sessionIds.every((id) => {
        const h = getHub(id);
        return (h?.clients.size ?? 0) === 0 && (h?.huds.size ?? 0) === 0 && (h?.ring.length ?? 0) === 0;
      }),
  );

  assert.equal(hubStats().floatingHuds, 0);
  for (const id of sessionIds) {
    const hub = getHub(id);
    assert.equal(hub?.clients.size, 0);
    assert.equal(hub?.huds.size, 0);
    assert.equal(hub?.ring.length, 0);
    assert.deepEqual(hub?.ring.pick(), []);
  }
});

test("shared-session multi-client churn: 15 concurrent /live + /hud-ws pairs clean up only after final client closes", async () => {
  const count = 15;
  const sessionId = "shared-churn-01";
  const lives = Array.from({ length: count }, () => openWs(`${wsBase}/live?session=${sessionId}`));
  const huds = Array.from({ length: count }, () => openWs(`${wsBase}/hud-ws?session=${sessionId}`));

  try {
    await Promise.all([...lives.map((c) => c.ready), ...huds.map((c) => c.ready)]);

    await Promise.all(
      lives.map(async (live, i) => {
        live.ws.send(JSON.stringify({ type: "frame", data: VALID_FRAME_B64, sharpness: 0.5, w: 320, h: 240, ts: Date.now() }));
        live.ws.send(JSON.stringify({ type: "ping", t: 8000 + i }));
        const pong = await live.nextWhere((m) => m.type === "pong");
        assert.deepEqual(pong, { type: "pong", t: 8000 + i });
      }),
    );

    const hub = getHub(sessionId);
    assert.equal(hub?.clients.size, count);
    assert.equal(hub?.huds.size, count);
    assert.equal(hub?.ring.length, 8);

    await Promise.all([...lives.slice(0, 10).map((c) => c.close()), ...huds.slice(0, 10).map((c) => c.close())]);
    await waitUntil(() => (getHub(sessionId)?.clients.size ?? 0) === 5 && (getHub(sessionId)?.huds.size ?? 0) === 5);

    assert.equal(getHub(sessionId)?.ring.length, 8);
    lives[10].ws.send(JSON.stringify({ type: "ping", t: 9999 }));
    const survivorPong = await lives[10].nextWhere((m) => m.type === "pong");
    assert.deepEqual(survivorPong, { type: "pong", t: 9999 });
  } finally {
    await Promise.all([...lives.map((c) => c.close()), ...huds.map((c) => c.close())]);
  }

  await waitUntil(() => {
    const h = getHub(sessionId);
    return (h?.clients.size ?? 0) === 0 && (h?.huds.size ?? 0) === 0 && (h?.ring.length ?? 0) === 0;
  });

  assert.equal(getHub(sessionId)?.clients.size, 0);
  assert.equal(getHub(sessionId)?.huds.size, 0);
  assert.equal(getHub(sessionId)?.ring.length, 0);
});

test("HTTP 404 on unknown routes returns not_found JSON with x-powered-by absent and zero stack traces", async () => {
  const probes: Array<{ method: string; route: string }> = [
    { method: "GET", route: "/api/unknown-route" },
    { method: "POST", route: "/api/admin/exploit" },
    { method: "GET", route: "/ingest/unknown" },
    { method: "DELETE", route: "/secret-config" },
  ];

  for (const p of probes) {
    const res = await fetch(`${baseUrl}${p.route}`, { method: p.method });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const raw = await res.text();
    assert.doesNotMatch(raw, /\bat\s+\S+\s*\(|node_modules|server\/src|\.ts:\d+/i);

    const body = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(body.type, "error");
    assert.equal(body.code, "not_found");
    assert.equal(body.recoverable, false);
    assert.equal("stack" in body, false);
  }

  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("x-powered-by"), null);
  const healthRaw = await healthRes.text();
  assert.doesNotMatch(healthRaw, /AIza|apiKey|api_key/i);
});
