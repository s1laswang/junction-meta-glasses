import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { Profile } from "../../shared/types.ts";
import { eleven } from "../src/elevenlabs.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origLedgerPath = env.ledgerPath;
const origGenerateContent = ai.models.generateContent;
const origLiveConnect = ai.live.connect;
const origFetch = globalThis.fetch;

process.env.HOLDUP_QUIET = "1";
delete process.env.HOLDUP_KEY;

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const tempDir = fs.mkdtempSync(path.join(shmRoot, "holdup-ws-tts-harden-"));
env.ledgerPath = path.join(tempDir, "ledger.jsonl");

type Msg = Record<string, unknown>;

let server: http.Server;
let httpBase = "";
let wsBase = "";
const sockets: WebSocket[] = [];

function connectWs(pathAndQuery: string) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`);
  sockets.push(ws);
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
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
  const next = (timeoutMs = 3000): Promise<Msg> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise<Msg>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`WS timeout on ${pathAndQuery}`)), timeoutMs);
          waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        });
  const nextMatching = async (pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rem = Math.max(20, deadline - Date.now());
      const m = await next(rem);
      if (pred(m)) return m;
    }
    throw new Error(`WS matching timeout on ${pathAndQuery}`);
  };
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { ws, open, next, nextMatching, close, queue };
}

function makeJpegBuffer(len = 160): Buffer {
  const buf = Buffer.alloc(len, 0x42);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[len - 2] = 0xff;
  buf[len - 1] = 0xd9;
  return buf;
}

const baseProfile: Profile = {
  meds: [{ id: "m1", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const updatedProfile: Profile = {
  meds: [{ id: "m2", name: "Glucophage", ingredient: "metformin", strength: "500 mg", schedule: ["morning"] }],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

before(async () => {
  server = await startServer(0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  httpBase = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {}
    }
    server?.closeAllConnections?.();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    ai.models.generateContent = origGenerateContent;
    ai.live.connect = origLiveConnect;
    globalThis.fetch = origFetch;
    env.ledgerPath = origLedgerPath;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = origHoldupKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/tts and POST /api/tts/eleven reject whitespace-only text with 400 bad_input and zero upstream calls", async () => {
  let geminiCalls = 0;
  let elevenUpstreamCalls = 0;
  const savedElevenKey = eleven.key;
  const savedElevenLive = eleven.live;

  ai.models.generateContent = (async () => {
    geminiCalls++;
    throw new Error("should not call Gemini TTS");
  }) as typeof ai.models.generateContent;

  eleven.key = "test-eleven-key-whitespace";
  eleven.live = true;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(httpBase)) return origFetch(input, init);
    elevenUpstreamCalls++;
    throw new Error("should not call ElevenLabs upstream");
  }) as typeof globalThis.fetch;

  try {
    const ttsRes = await origFetch(`${httpBase}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   \t\n  " }),
    });
    assert.equal(ttsRes.status, 400);
    const ttsBody = (await ttsRes.json()) as Msg;
    assert.equal(ttsBody.type, "error");
    assert.equal(ttsBody.code, "bad_input");
    assert.equal(ttsBody.recoverable, true);
    assert.equal(geminiCalls, 0);

    const elevenRes = await origFetch(`${httpBase}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   \t\n  ", lang: "en" }),
    });
    assert.equal(elevenRes.status, 400);
    const elevenBody = (await elevenRes.json()) as Msg;
    assert.equal(elevenBody.type, "error");
    assert.equal(elevenBody.code, "bad_input");
    assert.equal(elevenBody.recoverable, true);
    assert.equal(elevenUpstreamCalls, 0);
  } finally {
    eleven.key = savedElevenKey;
    eleven.live = savedElevenLive;
    globalThis.fetch = origFetch;
    ai.models.generateContent = origGenerateContent;
  }
});

test("POST /api/tts clamps out-of-bounds rate=0 and rate=9999999999 to 24000 Hz while preserving valid rates", async () => {
  const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
  let currentMimeType = "audio/L16;codec=pcm;rate=24000";
  let calls = 0;

  ai.models.generateContent = (async () => {
    calls++;
    return {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pcm.toString("base64"), mimeType: currentMimeType } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 16 },
    };
  }) as unknown as typeof ai.models.generateContent;

  try {
    const cases: Array<{ mimeType: string; expectedRate: number }> = [
      { mimeType: "audio/L16;codec=pcm;rate=0", expectedRate: 24000 },
      { mimeType: "audio/L16;codec=pcm;rate=9999999999", expectedRate: 24000 },
      { mimeType: "audio/L16;codec=pcm;rate=16000", expectedRate: 16000 },
      { mimeType: "audio/L16;codec=pcm;rate=44100", expectedRate: 44100 },
      { mimeType: "audio/L16;codec=pcm;rate=8000", expectedRate: 8000 },
      { mimeType: "audio/L16;codec=pcm;rate=96000", expectedRate: 96000 },
    ];

    for (const c of cases) {
      currentMimeType = c.mimeType;
      const beforeCalls = calls;
      const res = await origFetch(`${httpBase}/api/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Amlodipine five milligrams" }),
      });
      assert.equal(res.status, 200, `Expected 200 for ${c.mimeType}`);
      assert.equal(calls - beforeCalls, 1, `Expected single model call without RangeError fallback for ${c.mimeType}`);
      const wavBuf = Buffer.from(await res.arrayBuffer());
      assert.equal(wavBuf.length, 44 + pcm.length);
      assert.equal(wavBuf.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(wavBuf.subarray(8, 12).toString("ascii"), "WAVE");
      assert.equal(wavBuf.readUInt32LE(24), c.expectedRate);
      assert.equal(wavBuf.readUInt32LE(28), c.expectedRate * 2);
      assert.equal(wavBuf.readUInt32LE(40), pcm.length);
      assert.deepEqual(wavBuf.subarray(44), pcm);
    }
  } finally {
    ai.models.generateContent = origGenerateContent;
  }
});

test("WS /live mid-session source message emits device to /hud-ws even when hub.device was unset without echoing to phone", async () => {
  const sessionId = "ws-source-unset-1";
  const live = connectWs(`/live?session=${sessionId}`);
  let hud: ReturnType<typeof connectWs> | undefined;

  try {
    await live.open;
    assert.equal(getHub(sessionId)?.device, undefined);

    hud = connectWs(`/hud-ws?session=${sessionId}`);
    await hud.open;
    assert.deepEqual(await live.next(), { type: "hud", connected: true });

    live.ws.send(JSON.stringify({ type: "source", source: "glasses" }));
    live.ws.send(JSON.stringify({ type: "ping", t: 301 }));

    assert.deepEqual(await live.next(), { type: "pong", t: 301 });
    assert.equal(live.queue.length, 0);

    assert.deepEqual(await hud.next(), {
      type: "device",
      device: {
        connected: true,
        worn: true,
        battery: null,
        streaming: false,
        source: "glasses",
      },
    });
    assert.equal(getHub(sessionId)?.source, "glasses");
  } finally {
    await hud?.close();
    await live.close();
  }

  const phoneSessionId = "ws-source-unset-phone-1";
  const phoneLive = connectWs(`/live?session=${phoneSessionId}`);
  let phoneHud: ReturnType<typeof connectWs> | undefined;
  try {
    await phoneLive.open;
    assert.equal(getHub(phoneSessionId)?.device, undefined);
    phoneHud = connectWs(`/hud-ws?session=${phoneSessionId}`);
    await phoneHud.open;
    assert.deepEqual(await phoneLive.next(), { type: "hud", connected: true });

    phoneLive.ws.send(JSON.stringify({ type: "source", source: "phone" }));
    phoneLive.ws.send(JSON.stringify({ type: "ping", t: 302 }));

    assert.deepEqual(await phoneLive.next(), { type: "pong", t: 302 });
    assert.equal(phoneLive.queue.length, 0);
    assert.deepEqual(await phoneHud.next(), {
      type: "device",
      device: {
        connected: false,
        worn: null,
        battery: null,
        streaming: false,
        source: "phone",
      },
    });
    assert.equal(getHub(phoneSessionId)?.source, "phone");
  } finally {
    await phoneHud?.close();
    await phoneLive.close();
  }
});

test("WS /live mid-session start while live.active updates hub.source, notifies /hud-ws, and enables /ingest/frame", async () => {
  let connectCalls = 0;
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = (async () => {
    connectCalls++;
    return {
      sendRealtimeInput() {},
      sendToolResponse() {},
      close() {},
    };
  }) as unknown as typeof origLiveConnect;

  const sessionId = "ws-midstart-source-1";
  const live = connectWs(`/live?session=${sessionId}`);
  let hud: ReturnType<typeof connectWs> | undefined;

  try {
    await live.open;
    hud = connectWs(`/hud-ws?session=${sessionId}`);
    await hud.open;
    assert.deepEqual(await live.next(), { type: "hud", connected: true });

    live.ws.send(JSON.stringify({ type: "start", profile: baseProfile, lang: "en", voice: false }));
    const openMsg = await live.nextMatching((m) => m.type === "status" && m.live === "open");
    assert.equal(openMsg.live, "open");
    await hud.nextMatching((m) => m.type === "status" && m.live === "open");
    assert.equal(connectCalls, 1);
    assert.equal(getHub(sessionId)?.live?.active, true);
    assert.equal(getHub(sessionId)?.device, undefined);

    const droppedRes = await origFetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: makeJpegBuffer(),
    });
    assert.equal(droppedRes.status, 204);
    assert.equal(getHub(sessionId)?.ring.length, 0);

    live.ws.send(JSON.stringify({ type: "start", profile: updatedProfile, lang: "en", voice: false, source: "glasses" }));
    live.ws.send(JSON.stringify({ type: "ping", t: 402 }));

    assert.deepEqual(await live.next(), { type: "pong", t: 402 });
    assert.equal(live.queue.length, 0);
    assert.equal(connectCalls, 1);

    assert.deepEqual(await hud.next(), {
      type: "device",
      device: {
        connected: true,
        worn: true,
        battery: null,
        streaming: false,
        source: "glasses",
      },
    });

    assert.equal(getHub(sessionId)?.source, "glasses");
    assert.equal(getHub(sessionId)?.profile.meds[0]?.name, "Glucophage");

    const acceptedRes = await origFetch(`${httpBase}/ingest/frame?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: makeJpegBuffer(),
    });
    assert.equal(acceptedRes.status, 204);
    assert.equal(getHub(sessionId)?.ring.length, 1);
  } finally {
    await hud?.close();
    await live.close();
    ai.live.connect = origLiveConnect;
  }
});
