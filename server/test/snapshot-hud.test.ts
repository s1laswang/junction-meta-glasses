import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { LabelRead, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getOrCreateHub, markLatest, resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";
const tempLedger = path.join(os.tmpdir(), `holdup-snapshot-hud-${process.pid}.jsonl`);

let server: http.Server;
let baseUrl = "";
let wsBase = "";
let prevApiKey = "";
let prevLedger = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
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
  env.ledgerPath = prevLedger;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
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

function sampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  const emptyField = { value: null, confidence: 0 };
  const read: LabelRead = {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: emptyField,
    expiry: emptyField,
    allergens: { value: null, confidence: 0 },
    barcode: emptyField,
    readability: 0.95,
  };
  return {
    level: "match",
    headline: "Amlodipine 5 mg: match",
    speech: "Amlodipine 5 mg, your evening pill.",
    read,
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
    ...overrides,
  };
}

const sampleProfile: Profile = {
  meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

test("POST /api/verify fans out verdict to connected /hud-ws without sending duplicate verdict to /live", async () => {
  const origGenerateContent = ai.models.generateContent.bind(ai.models);
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify({
      kind: "medication",
      product: { value: "Norvasc", confidence: 0.96 },
      ingredient: { value: "amlodipine", confidence: 0.95 },
      strength: { value: "5 mg", confidence: 0.94 },
      dosing: { value: "1 tablet daily", confidence: 0.9 },
      expiry: { value: "2027-08", confidence: 0.9 },
      allergens: { value: [], confidence: 0.85 },
      barcode: { value: null, confidence: 0 },
      readability: 0.94,
    }),
  });

  const live = openWs(`${wsBase}/live?session=snap-verify`);
  await live.ready;
  const hub = getOrCreateHub("snap-verify");
  markLatest(hub);
  assert.deepEqual(await live.next(), { type: "hud", connected: false });

  const hudExplicit = openWs(`${wsBase}/hud-ws?session=snap-verify`);
  await hudExplicit.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  const hudFloating = openWs(`${wsBase}/hud-ws`);
  await hudFloating.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  try {
    const resExplicit = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "snap-verify",
        frames: ["a".repeat(200)],
        profile: sampleProfile,
        question: "is this my evening pill?",
      }),
    });
    assert.equal(resExplicit.status, 200);
    const verdictExplicit = (await resExplicit.json()) as Verdict;
    assert.equal(verdictExplicit.level, "match");
    assert.equal(verdictExplicit.matchedMedId, "aml");

    const [msgExplicit1, msgFloating1] = await Promise.all([hudExplicit.next(), hudFloating.next()]);
    assert.deepEqual(msgExplicit1, { type: "verdict", verdict: verdictExplicit });
    assert.deepEqual(msgFloating1, { type: "verdict", verdict: verdictExplicit });
    assert.deepEqual(hub.lastVerdict, verdictExplicit);

    live.ws.send(JSON.stringify({ type: "ping", t: 101 }));
    assert.deepEqual(await live.next(), { type: "pong", t: 101 });

    const resDefault = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frames: ["b".repeat(200)],
        profile: sampleProfile,
      }),
    });
    assert.equal(resDefault.status, 200);
    const verdictDefault = (await resDefault.json()) as Verdict;

    const [msgExplicit2, msgFloating2] = await Promise.all([hudExplicit.next(), hudFloating.next()]);
    assert.deepEqual(msgExplicit2, { type: "verdict", verdict: verdictDefault });
    assert.deepEqual(msgFloating2, { type: "verdict", verdict: verdictDefault });
  } finally {
    (ai.models as any).generateContent = origGenerateContent;
    await Promise.all([live.close(), hudExplicit.close(), hudFloating.close()]);
  }
});

test("/hud-ws log_dose without active LiveProxy updates doseLog and emits takenToday true verdict to /live and /hud-ws", async () => {
  const live = openWs(`${wsBase}/live?session=snap1`);
  await live.ready;
  const hub = getOrCreateHub("snap1");
  markLatest(hub);
  assert.deepEqual(await live.next(), { type: "hud", connected: false });

  const hud = openWs(`${wsBase}/hud-ws`);
  await hud.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  try {
    assert.equal(hub.live, undefined);
    const initial = sampleVerdict({ matchedMedId: "aml", takenToday: false });
    hub.lastVerdict = initial;

    const before = Date.now();
    hud.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));
    const [liveMsg, hudMsg] = await Promise.all([live.next(), hud.next()]);
    const after = Date.now();

    assert.equal(hub.profile.doseLog.length, 1);
    assert.equal(hub.profile.doseLog[0].medId, "aml");
    assert.ok(hub.profile.doseLog[0].ts >= before && hub.profile.doseLog[0].ts <= after);

    const expectedVerdict: Verdict = { ...initial, takenToday: true };
    assert.deepEqual(liveMsg, { type: "verdict", verdict: expectedVerdict });
    assert.deepEqual(hudMsg, { type: "verdict", verdict: expectedVerdict });
    assert.deepEqual(hub.lastVerdict, expectedVerdict);
  } finally {
    await Promise.all([live.close(), hud.close()]);
  }
});

test("/hud-ws repeat re-emits lastVerdict when LiveProxy is inactive and delegates when LiveProxy is active", async () => {
  const live = openWs(`${wsBase}/live?session=snap2`);
  await live.ready;
  const hud = openWs(`${wsBase}/hud-ws?session=snap2`);
  await hud.ready;
  assert.deepEqual(await live.next(), { type: "hud", connected: true });

  try {
    const hub = getOrCreateHub("snap2");
    const delegated: string[] = [];
    hub.live = {
      active: false,
      handleEvent(name: string) {
        delegated.push(name);
      },
      stop() {},
    };
    const initial = sampleVerdict({ matchedMedId: "aml", takenToday: false });
    hub.lastVerdict = initial;

    hud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));
    const [liveRepeat, hudRepeat] = await Promise.all([live.next(), hud.next()]);
    assert.equal(delegated.length, 0);
    assert.deepEqual(liveRepeat, { type: "verdict", verdict: initial });
    assert.deepEqual(hudRepeat, { type: "verdict", verdict: initial });

    hub.live = {
      active: true,
      handleEvent(name: string) {
        delegated.push(name);
        hub.emit({ type: "status", live: "open", detail: name });
      },
      stop() {},
    };

    hud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));
    const [liveActive1, hudActive1] = await Promise.all([live.next(), hud.next()]);
    assert.deepEqual(liveActive1, { type: "status", live: "open", detail: "repeat" });
    assert.deepEqual(hudActive1, { type: "status", live: "open", detail: "repeat" });

    hud.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));
    const [liveActive2, hudActive2] = await Promise.all([live.next(), hud.next()]);
    assert.deepEqual(liveActive2, { type: "status", live: "open", detail: "log_dose" });
    assert.deepEqual(hudActive2, { type: "status", live: "open", detail: "log_dose" });
    assert.deepEqual(delegated, ["repeat", "log_dose"]);
    assert.equal(hub.profile.doseLog.length, 0);
  } finally {
    await Promise.all([live.close(), hud.close()]);
  }
});
