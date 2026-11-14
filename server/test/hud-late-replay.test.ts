import os from "node:os";
import path from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { DeviceState, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, getOrCreateHub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

const profile: Profile = {
  meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5mg", schedule: ["evening"] }],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const sampleReadJson = {
  kind: "medication",
  product: { value: "Amlodipin Orion", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.96 },
  strength: { value: "5 mg", confidence: 0.95 },
  dosing: { value: null, confidence: 0 },
  expiry: { value: "2027-08", confidence: 0.95 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: null, confidence: 0 },
  readability: 0.95,
};

function collectWsUntil(url: string, done: (msgs: ServerMsg[]) => boolean, timeoutMs = 2000): Promise<{ ws: WebSocket; msgs: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting on ${url}; got ${JSON.stringify(msgs)}`));
    }, timeoutMs);
    ws.on("message", (raw) => {
      msgs.push(JSON.parse(raw.toString()) as ServerMsg);
      if (done(msgs)) {
        clearTimeout(timer);
        resolve({ ws, msgs });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState >= WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

test("POST /api/verify replays snapshot verdict to late-joining session and floating /hud-ws", async (t) => {
  const prevKey = process.env.HOLDUP_KEY;
  const prevLedger = env.ledgerPath;
  const origGenerate = ai.models.generateContent;
  delete process.env.HOLDUP_KEY;
  env.ledgerPath = path.join(os.tmpdir(), `holdup-hud-replay-${process.pid}-1.jsonl`);
  (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = (async () => ({
    text: JSON.stringify(sampleReadJson),
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
  })) as unknown as typeof origGenerate;

  const server = await startServer(0);
  t.after(async () => {
    (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = origGenerate;
    env.ledgerPath = prevLedger;
    if (prevKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevKey;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const port = (server.address() as AddressInfo).port;
  const sessionId = "snap-late-1";
  const seeded = getOrCreateHub(sessionId);
  seeded.emit({ type: "coach", cue: "closer", text: "A bit closer" });
  assert.equal(seeded.lastCoach?.type, "coach");

  const res = await fetch(`http://127.0.0.1:${port}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: sessionId, frames: ["A".repeat(160)], profile }),
  });
  assert.equal(res.status, 200);
  const verdict = (await res.json()) as Verdict;
  assert.equal(verdict.level, "match");
  assert.equal(verdict.matchedMedId, "aml");
  assert.equal(verdict.takenToday, false);
  assert.equal(seeded.lastCoach, undefined);

  const explicit = await collectWsUntil(
    `ws://127.0.0.1:${port}/hud-ws?session=${sessionId}`,
    (ms) => ms.some((m) => m.type === "verdict"),
  );
  await closeWs(explicit.ws);
  assert.equal(explicit.msgs.some((m) => m.type === "coach"), false);
  const explicitVerdict = explicit.msgs.find((m) => m.type === "verdict");
  assert.ok(explicitVerdict && explicitVerdict.type === "verdict");
  assert.equal(explicitVerdict.verdict.matchedMedId, "aml");
  assert.equal(explicitVerdict.verdict.takenToday, false);

  const floating = await collectWsUntil(
    `ws://127.0.0.1:${port}/hud-ws`,
    (ms) => ms.some((m) => m.type === "verdict"),
  );
  await closeWs(floating.ws);
  assert.equal(floating.msgs.some((m) => m.type === "coach"), false);
  const floatingVerdict = floating.msgs.find((m) => m.type === "verdict");
  assert.ok(floatingVerdict && floatingVerdict.type === "verdict");
  assert.equal(floatingVerdict.verdict.matchedMedId, "aml");
  assert.equal(floatingVerdict.verdict.takenToday, false);
});

test("dose log updates hub.lastVerdict so late-joining /hud-ws receives takenToday: true", async (t) => {
  const prevKey = process.env.HOLDUP_KEY;
  const prevLedger = env.ledgerPath;
  const origGenerate = ai.models.generateContent;
  const origConnect = ai.live.connect;
  delete process.env.HOLDUP_KEY;
  env.ledgerPath = path.join(os.tmpdir(), `holdup-hud-replay-${process.pid}-2.jsonl`);
  (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = (async () => ({
    text: JSON.stringify(sampleReadJson),
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
  })) as unknown as typeof origGenerate;
  (ai.live as unknown as { connect: typeof origConnect }).connect = (async () => ({
    sendRealtimeInput() {},
    sendToolResponse() {},
    close() {},
  })) as unknown as typeof origConnect;

  const server = await startServer(0);
  t.after(async () => {
    (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = origGenerate;
    (ai.live as unknown as { connect: typeof origConnect }).connect = origConnect;
    env.ledgerPath = prevLedger;
    if (prevKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevKey;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const port = (server.address() as AddressInfo).port;
  const sessionId = "live-dose-1";
  const liveMsgs: ServerMsg[] = [];
  const liveWs = new WebSocket(`ws://127.0.0.1:${port}/live?session=${sessionId}`);
  t.after(() => closeWs(liveWs));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for live open status")), 2000);
    liveWs.on("open", () => {
      liveWs.send(JSON.stringify({ type: "start", profile, lang: "en", voice: false, source: "phone" }));
    });
    liveWs.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      liveMsgs.push(m);
      if (m.type === "status" && m.live === "open") {
        clearTimeout(timer);
        resolve();
      }
    });
    liveWs.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: sessionId, frames: ["B".repeat(160)], profile }),
  });
  assert.equal(verifyRes.status, 200);
  assert.equal(getHub(sessionId)?.lastVerdict?.takenToday, false);

  liveWs.send(JSON.stringify({ type: "event", name: "log_dose" }));
  const deadline = Date.now() + 2000;
  while (getHub(sessionId)?.lastVerdict?.takenToday !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(getHub(sessionId)?.lastVerdict?.takenToday, true);

  const lateSessionHud = await collectWsUntil(
    `ws://127.0.0.1:${port}/hud-ws?session=${sessionId}`,
    (ms) => ms.some((m) => m.type === "verdict"),
  );
  await closeWs(lateSessionHud.ws);
  const v1 = lateSessionHud.msgs.find((m) => m.type === "verdict");
  assert.ok(v1 && v1.type === "verdict");
  assert.equal(v1.verdict.matchedMedId, "aml");
  assert.equal(v1.verdict.takenToday, true);

  const lateFloatingHud = await collectWsUntil(
    `ws://127.0.0.1:${port}/hud-ws`,
    (ms) => ms.some((m) => m.type === "verdict"),
  );
  await closeWs(lateFloatingHud.ws);
  const v2 = lateFloatingHud.msgs.find((m) => m.type === "verdict");
  assert.ok(v2 && v2.type === "verdict");
  assert.equal(v2.verdict.matchedMedId, "aml");
  assert.equal(v2.verdict.takenToday, true);

  await closeWs(liveWs);
});

test("mock.ts BroadcastChannel hud_hello replays status, device, and lastHudVerdict", async (t) => {
  type MockModule = {
    MOCK_HUD_CHANNEL: string;
    mockSetGeminiDown: (down: boolean) => void;
    mockSetDevice: (d: Partial<DeviceState>) => void;
    mockFetch: (path: string, body?: unknown) => Promise<unknown>;
  };
  const mockUrl = new URL("../../web/src/lib/mock.ts", import.meta.url).href;
  const mock = (await import(mockUrl)) as MockModule;

  mock.mockSetGeminiDown(false);
  mock.mockSetDevice({ connected: true, worn: true, battery: 84, streaming: true, source: "glasses" });
  const expectedVerdict = (await mock.mockFetch("/api/verify")) as Verdict;

  const ch = new BroadcastChannel(mock.MOCK_HUD_CHANNEL);
  t.after(() => ch.close());

  const replayed = await new Promise<ServerMsg[]>((resolve, reject) => {
    const msgs: ServerMsg[] = [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for hud_hello replay; got ${JSON.stringify(msgs)}`)), 2000);
    ch.onmessage = (ev: unknown) => {
      const m = (ev as { data: ServerMsg }).data;
      msgs.push(m);
      const hasStatus = msgs.some((x) => x.type === "status");
      const hasDevice = msgs.some((x) => x.type === "device");
      const hasVerdict = msgs.some((x) => x.type === "verdict");
      if (hasStatus && hasDevice && hasVerdict) {
        clearTimeout(timer);
        resolve(msgs);
      }
    };
    ch.postMessage({ type: "hud_hello" });
  });

  const statusMsg = replayed.find((m) => m.type === "status");
  const deviceMsg = replayed.find((m) => m.type === "device");
  const verdictMsg = replayed.find((m) => m.type === "verdict");

  assert.ok(statusMsg && statusMsg.type === "status");
  assert.equal(statusMsg.live, "open");
  assert.ok(deviceMsg && deviceMsg.type === "device");
  assert.equal(deviceMsg.device.connected, true);
  assert.equal(deviceMsg.device.battery, 84);
  assert.equal(deviceMsg.device.source, "glasses");
  assert.ok(verdictMsg && verdictMsg.type === "verdict");
  assert.equal(verdictMsg.verdict.headline, expectedVerdict.headline);
  assert.equal(verdictMsg.verdict.matchedMedId, expectedVerdict.matchedMedId);
});
