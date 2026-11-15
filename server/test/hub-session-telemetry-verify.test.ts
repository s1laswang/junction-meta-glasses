import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { DeviceState, LabelRead, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { SPEC } from "../src/speculate.ts";
import {
  Hub,
  addHud,
  getHub,
  getOrCreateHub,
  hubStats,
  hudTarget,
  latestHub,
  markLatest,
  resolveHub,
  setDevice,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: ServerMsg[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw) as ServerMsg);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }
}

const sampleProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5mg",
      schedule: ["evening"],
      gtin: "06410001234567",
    },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const sampleRead: LabelRead = {
  kind: "medication",
  product: { value: "Amlodipin Orion", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.96 },
  strength: { value: "5 mg", confidence: 0.95 },
  dosing: { value: null, confidence: 0 },
  expiry: { value: "2028-08", confidence: 0.95 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: null, confidence: 0 },
  readability: 0.8,
};

const sampleVerdict: Verdict = {
  level: "match",
  headline: "Amlodipine 5 mg: on your list",
  speech: "This is Amlodipine 5 mg, on your list for evening.",
  read: sampleRead,
  matchedMedId: "aml",
  reasons: ["matches Norvasc"],
  takenToday: false,
};

function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState >= WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

test("orphanDevice adoption, floatingHuds, explicit addHud, markLatest, hudChanged, and hubStats lifecycle", (t) => {
  const float1 = new FakeSocket();
  const float2 = new FakeSocket();
  const explicitHud = new FakeSocket();
  t.after(() => {
    if (float1.readyState === 1) float1.disconnect();
    if (float2.readyState === 1) float2.disconnect();
    if (explicitHud.readyState === 1) explicitHud.disconnect();
  });

  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 0, floatingStages: 0 });
  assert.equal(latestHub(), undefined);
  assert.equal(resolveHub(undefined), undefined);
  assert.equal(hudTarget(undefined), undefined);

  addHud(float1.asWs());
  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 1, floatingStages: 0 });
  assert.equal(float1.sent.length, 0);

  const orphanDev: DeviceState = {
    connected: true,
    worn: true,
    battery: 77,
    streaming: true,
    source: "glasses",
  };
  setDevice(orphanDev);
  assert.equal(float1.sent.length, 1);
  assert.deepEqual(float1.sent[0], { type: "device", device: orphanDev });

  addHud(float2.asWs());
  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 2, floatingStages: 0 });
  assert.equal(float2.sent.length, 1);
  assert.deepEqual(float2.sent[0], { type: "device", device: orphanDev });

  const h1 = getOrCreateHub("alpha-session-01");
  const phone1 = new FakeSocket();
  h1.clients.add(phone1.asWs());
  t.after(() => h1.clients.delete(phone1.asWs()));
  h1.lastStatus = { type: "status", live: "open" };
  h1.lastCoach = { type: "coach", cue: "closer", text: "Hold a little closer" };
  assert.equal(h1.device, undefined);
  assert.deepEqual(hubStats(), { sessions: 1, latest: null, floatingHuds: 2, floatingStages: 0 });

  float1.sent = [];
  float2.sent = [];
  markLatest(h1);
  assert.deepEqual(h1.device, orphanDev);
  assert.equal(latestHub(), h1);
  assert.equal(resolveHub(undefined), h1);
  assert.equal(hudTarget(undefined), h1);
  assert.deepEqual(hubStats(), { sessions: 1, latest: "alpha-se", floatingHuds: 2, floatingStages: 0 });
  assert.deepEqual(phone1.sent, [{ type: "hud", connected: true }]);
  for (const fl of [float1, float2]) {
    assert.deepEqual(fl.sent, [
      { type: "status", live: "open" },
      { type: "device", device: orphanDev },
      { type: "coach", cue: "closer", text: "Hold a little closer" },
    ]);
  }

  const customDev: DeviceState = {
    connected: true,
    worn: false,
    battery: 42,
    streaming: false,
    source: "phone",
  };
  const h2 = getOrCreateHub("bravo-session-02");
  const phone2 = new FakeSocket();
  h2.clients.add(phone2.asWs());
  t.after(() => h2.clients.delete(phone2.asWs()));
  h2.device = customDev;
  h2.lastVerdict = sampleVerdict;

  float1.sent = [];
  float2.sent = [];
  markLatest(h2);
  assert.deepEqual(h2.device, customDev);
  assert.deepEqual(hubStats(), { sessions: 2, latest: "bravo-se", floatingHuds: 2, floatingStages: 0 });
  assert.deepEqual(phone2.sent, [{ type: "hud", connected: true }]);
  for (const fl of [float1, float2]) {
    assert.deepEqual(fl.sent, [
      { type: "device", device: customDev },
      { type: "verdict", verdict: sampleVerdict },
    ]);
  }

  phone1.sent = [];
  addHud(explicitHud.asWs(), "alpha-session-01");
  assert.equal(hudTarget("alpha-session-01"), h1);
  assert.deepEqual(hubStats(), { sessions: 2, latest: "bravo-se", floatingHuds: 2, floatingStages: 0 });
  assert.deepEqual(phone1.sent, [{ type: "hud", connected: true }]);
  assert.deepEqual(explicitHud.sent, [
    { type: "status", live: "open" },
    { type: "device", device: orphanDev },
    { type: "coach", cue: "closer", text: "Hold a little closer" },
  ]);

  explicitHud.sent = [];
  float1.sent = [];
  float2.sent = [];
  h2.emit({ type: "coach", cue: "hold_still", text: "Hold still" });
  assert.equal(explicitHud.sent.length, 0);
  assert.equal(float1.sent.length, 1);
  assert.equal(float2.sent.length, 1);

  float1.sent = [];
  float2.sent = [];
  h1.emit({ type: "coach", cue: "more_light", text: "Need more light" });
  assert.deepEqual(explicitHud.sent, [{ type: "coach", cue: "more_light", text: "Need more light" }]);
  assert.equal(float1.sent.length, 0);
  assert.equal(float2.sent.length, 0);

  phone1.sent = [];
  explicitHud.disconnect();
  assert.equal(h1.huds.size, 0);
  assert.deepEqual(phone1.sent, [{ type: "hud", connected: false }]);

  phone2.sent = [];
  float1.disconnect();
  assert.deepEqual(hubStats(), { sessions: 2, latest: "bravo-se", floatingHuds: 1, floatingStages: 0 });
  assert.deepEqual(phone2.sent, [{ type: "hud", connected: true }]);

  phone2.sent = [];
  float2.disconnect();
  assert.deepEqual(hubStats(), { sessions: 2, latest: "bravo-se", floatingHuds: 0, floatingStages: 0 });
  assert.deepEqual(phone2.sent, [{ type: "hud", connected: false }]);
});

test("Hub.dropFrames() resets ring, spec, lastCode, and readiness so subsequent checks neither blend stale sharpness nor suppress initial sonar", async (t) => {
  const prevLedger = env.ledgerPath;
  const ledgerFile = path.join(os.tmpdir(), `holdup-hub-drop-${process.pid}.jsonl`);
  const origGenerate = ai.models.generateContent;
  const origDebounce = SPEC.debounceMs;
  const origMinGap = SPEC.minGapMs;
  const origNow = Date.now;

  env.ledgerPath = ledgerFile;
  SPEC.debounceMs = 10;
  SPEC.minGapMs = 10;
  let now = 500_000;
  Date.now = () => now;

  (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = (async () => ({
    text: JSON.stringify(sampleRead),
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
  })) as unknown as typeof origGenerate;

  t.after(() => {
    Date.now = origNow;
    SPEC.debounceMs = origDebounce;
    SPEC.minGapMs = origMinGap;
    (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = origGenerate;
    env.ledgerPath = prevLedger;
    fs.rmSync(ledgerFile, { force: true });
  });

  const hub = new Hub("drop-reset-unit");
  const phone = new FakeSocket();
  hub.clients.add(phone.asWs());
  hub.features = new Set(["sonar", "datamatrix"]);
  hub.live = { active: true, handleEvent() {}, stop() {} };

  hub.setCode({ raw: "010641000123456717280800", gtin: "06410001234567", expiry: "2028-08" });
  assert.ok(hub.lastCode);
  assert.equal(hub.freshCode()?.gtin, "06410001234567");

  hub.addFrame({ data: "S1_" + "A".repeat(180), sharpness: 1.0, ts: now, bytes: 200, source: "phone" });
  assert.equal(hub.ring.length, 1);
  assert.deepEqual(phone.sent, [{ type: "readiness", value: 0.6 }]);

  now += 300;
  const deadline1 = origNow() + 1000;
  while (!hub.spec.latest() && origNow() < deadline1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(hub.spec.latest());
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.87 });

  hub.dropFrames();
  assert.equal(hub.ring.length, 0);
  assert.equal(hub.spec.latest(), undefined);
  assert.equal(hub.lastCode, undefined);
  assert.equal(hub.freshCode(), undefined);

  phone.sent = [];
  const f2 = { data: "S2_" + "B".repeat(240), sharpness: 0.25, ts: now, bytes: 250, source: "phone" as const };
  hub.ring.push(f2);
  hub.spec.onFrame(f2);

  const deadline2 = origNow() + 1000;
  while (!hub.spec.latest() && origNow() < deadline2) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(hub.spec.latest());
  assert.deepEqual(phone.sent, [{ type: "readiness", value: 0.52 }]);

  hub.dropFrames();
  phone.sent = [];
  hub.updateReadiness(0.52 / 0.6);
  assert.deepEqual(phone.sent, [{ type: "readiness", value: 0.52 }]);
});

test("Hub.updateReadiness() formula, decay window, unreadable read, clamping, rate-limiting, delta suppression, and client-only routing", (t) => {
  const origNow = Date.now;
  let now = 100_000;
  Date.now = () => now;

  const hub = getOrCreateHub("sonar-formula-01");
  const phone = new FakeSocket();
  const explicitHud = new FakeSocket();
  const floatingHud = new FakeSocket();
  hub.clients.add(phone.asWs());
  addHud(explicitHud.asWs(), hub.id);
  markLatest(hub);
  addHud(floatingHud.asWs());

  t.after(() => {
    Date.now = origNow;
    hub.clients.delete(phone.asWs());
    explicitHud.disconnect();
    floatingHud.disconnect();
  });

  phone.sent = [];
  explicitHud.sent = [];
  floatingHud.sent = [];

  hub.features = new Set();
  hub.live = { active: true, handleEvent() {}, stop() {} };
  hub.updateReadiness(0.8);
  assert.equal(phone.sent.length, 0);

  hub.features = new Set(["sonar"]);
  hub.live = undefined;
  hub.updateReadiness(0.8);
  assert.equal(phone.sent.length, 0);

  hub.live = { active: false, handleEvent() {}, stop() {} };
  hub.updateReadiness(0.8);
  assert.equal(phone.sent.length, 0);

  hub.live = { active: true, handleEvent() {}, stop() {} };
  hub.updateReadiness(-0.4);
  assert.deepEqual(phone.sent, [{ type: "readiness", value: 0 }]);

  now += 300;
  hub.updateReadiness(1.75);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.6 });

  const beforeRateLimitCount = phone.sent.length;
  now += 100;
  hub.updateReadiness(0);
  now += 149;
  hub.updateReadiness(0);
  assert.equal(phone.sent.length, beforeRateLimitCount);

  now += 1;
  hub.updateReadiness(0);
  assert.equal(phone.sent.length, beforeRateLimitCount + 1);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0 });

  now += 300;
  hub.updateReadiness(1 / 3);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.2 });

  const beforeDeltaCount = phone.sent.length;
  now += 300;
  hub.updateReadiness(0.25 / 0.6);
  now += 300;
  hub.updateReadiness(0.16 / 0.6);
  assert.equal(phone.sent.length, beforeDeltaCount);

  now += 300;
  hub.updateReadiness(0.26 / 0.6);
  assert.equal(phone.sent.length, beforeDeltaCount + 1);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.26 });

  let mockedLatest: ReturnType<typeof hub.spec.latest> = {
    read: { ...sampleRead, readability: 0.8 },
    model: "test-verify-model",
    frameTs: 200_000,
    sharpness: 0.5,
    bytes: 200,
    at: 200_000,
  };
  hub.spec.latest = () => mockedLatest;

  now = 200_000;
  hub.updateReadiness(0.4);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.66 });

  now = 203_000;
  hub.updateReadiness(0.2);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.59 });

  now = 205_500;
  hub.updateReadiness(0.2);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.33 });

  now = 208_000;
  hub.updateReadiness(0.4);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.24 });

  now = 212_000;
  hub.updateReadiness(0.8);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.48 });

  mockedLatest = {
    read: { ...sampleRead, kind: "unreadable", readability: 0.95 },
    model: "test-verify-model",
    frameTs: 300_000,
    sharpness: 0.5,
    bytes: 200,
    at: 300_000,
  };
  now = 300_000;
  hub.updateReadiness(0);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0 });

  now = 300_300;
  hub.updateReadiness(0.5);
  assert.deepEqual(phone.sent.at(-1), { type: "readiness", value: 0.3 });

  assert.equal(phone.sent.every((m) => m.type === "readiness"), true);
  assert.equal(explicitHud.sent.some((m) => m.type === "readiness"), false);
  assert.equal(floatingHud.sent.some((m) => m.type === "readiness"), false);
});

test("POST /api/verify snapshot route handles ring-buffer fallback, 409 no_frames, 400 bad_input, and freshCode DataMatrix cross-check", async (t) => {
  const prevKey = process.env.HOLDUP_KEY;
  const prevLedger = env.ledgerPath;
  const ledgerFile = path.join(os.tmpdir(), `holdup-hub-verify-${process.pid}.jsonl`);
  const origGenerate = ai.models.generateContent;

  delete process.env.HOLDUP_KEY;
  env.ledgerPath = ledgerFile;

  const capturedInlineFrames: string[][] = [];
  (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = (async (req: unknown) => {
    const parts = (req as { contents?: Array<{ parts?: Array<{ inlineData?: { data?: string } }> }> })?.contents?.[0]?.parts ?? [];
    const imgs = parts.map((p) => p.inlineData?.data).filter((d): d is string => typeof d === "string");
    capturedInlineFrames.push(imgs);
    return {
      text: JSON.stringify(sampleRead),
      usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 20 },
    };
  }) as unknown as typeof origGenerate;

  const server = await startServer(0);
  t.after(async () => {
    (ai.models as unknown as { generateContent: typeof origGenerate }).generateContent = origGenerate;
    env.ledgerPath = prevLedger;
    if (prevKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevKey;
    fs.rmSync(ledgerFile, { force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  for (const payload of [
    { session: "bad!id", frames: [] },
    { session: "ab", frames: [] },
    { session: "missing-session-99", frames: [] },
    { frames: [] },
  ]) {
    const r = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as ServerMsg;
    assert.equal(body.type, "error");
    assert.equal(body.code, "bad_input");
    assert.equal(body.recoverable, true);
  }

  getOrCreateHub("empty-ring-sess");
  const emptyRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "empty-ring-sess", frames: [] }),
  });
  assert.equal(emptyRes.status, 409);
  const emptyErr = (await emptyRes.json()) as ServerMsg;
  assert.equal(emptyErr.type, "error");
  assert.equal(emptyErr.code, "no_frames");
  assert.equal(emptyErr.recoverable, true);

  const ringHub = getOrCreateHub("active-ring-sess");
  ringHub.profile = sampleProfile;
  const ringPhone = new FakeSocket();
  ringHub.clients.add(ringPhone.asWs());
  t.after(() => ringHub.clients.delete(ringPhone.asWs()));

  const hudMsgs: ServerMsg[] = [];
  const hudWs = new WebSocket(`ws://127.0.0.1:${port}/hud-ws?session=active-ring-sess`);
  t.after(() => closeWs(hudWs));
  await new Promise<void>((resolve, reject) => {
    hudWs.once("open", () => resolve());
    hudWs.once("error", reject);
  });
  hudWs.on("message", (raw) => hudMsgs.push(JSON.parse(raw.toString()) as ServerMsg));
  ringPhone.sent = [];

  const tsNow = Date.now();
  const lowData = "LOW_" + "A".repeat(140);
  const sharp1Data = "SHARP1_" + "B".repeat(160);
  const sharp2Data = "SHARP2_" + "C".repeat(150);
  ringHub.ring.push({ data: lowData, sharpness: 0.2, ts: tsNow - 200, bytes: lowData.length, source: "glasses" });
  ringHub.ring.push({ data: sharp1Data, sharpness: 0.92, ts: tsNow - 100, bytes: sharp1Data.length, source: "glasses" });
  ringHub.ring.push({ data: sharp2Data, sharpness: 0.78, ts: tsNow, bytes: sharp2Data.length, source: "glasses" });

  capturedInlineFrames.length = 0;
  const ringRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "active-ring-sess", frames: [] }),
  });
  assert.equal(ringRes.status, 200);
  const ringVerdict = (await ringRes.json()) as Verdict;
  assert.equal(ringVerdict.level, "match");
  assert.equal(ringVerdict.matchedMedId, "aml");
  assert.equal(capturedInlineFrames.length, 1);
  assert.deepEqual(new Set(capturedInlineFrames[0]), new Set([sharp1Data, sharp2Data]));
  assert.equal(ringPhone.sent.some((m) => m.type === "verdict"), false);

  const hudDeadline = Date.now() + 1500;
  while (!hudMsgs.some((m) => m.type === "verdict") && Date.now() < hudDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(hudMsgs.some((m) => m.type === "verdict"), true);
  await closeWs(hudWs);

  const dmHub = getOrCreateHub("dm-snap-sess");
  dmHub.features = new Set(["datamatrix"]);
  dmHub.setCode({ raw: "010641000123456717280800", gtin: "06410001234567", expiry: "2028-08" });

  const dmAgreeRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "dm-snap-sess", frames: ["F".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(dmAgreeRes.status, 200);
  const dmAgreeVerdict = (await dmAgreeRes.json()) as Verdict;
  assert.equal(dmAgreeVerdict.level, "match");
  assert.equal(dmAgreeVerdict.crossCheck?.source, "datamatrix");
  assert.equal(dmAgreeVerdict.crossCheck?.agrees, true);
  assert.equal(dmAgreeVerdict.crossCheck?.code.gtin, "06410001234567");

  dmHub.setCode({ raw: "010641000999999917280100", gtin: "06410009999999", expiry: "2028-01" });
  const dmConflictRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "dm-snap-sess", frames: ["G".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(dmConflictRes.status, 200);
  const dmConflictVerdict = (await dmConflictRes.json()) as Verdict;
  assert.equal(dmConflictVerdict.level, "unsure");
  assert.equal(dmConflictVerdict.crossCheck?.source, "datamatrix");
  assert.equal(dmConflictVerdict.crossCheck?.agrees, false);

  dmHub.lastCode = {
    code: { raw: "010641000123456717280800", gtin: "06410001234567", expiry: "2028-08" },
    ts: Date.now() - 10_001,
  };
  assert.equal(dmHub.freshCode(), undefined);
  const dmStaleRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "dm-snap-sess", frames: ["H".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(dmStaleRes.status, 200);
  const dmStaleVerdict = (await dmStaleRes.json()) as Verdict;
  assert.equal(dmStaleVerdict.crossCheck, undefined);

  dmHub.features = new Set();
  dmHub.setCode({ raw: "010641000123456717280800", gtin: "06410001234567", expiry: "2028-08" });
  assert.equal(dmHub.freshCode(), undefined);
  const dmFlagOffRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "dm-snap-sess", frames: ["I".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(dmFlagOffRes.status, 200);
  const dmFlagOffVerdict = (await dmFlagOffRes.json()) as Verdict;
  assert.equal(dmFlagOffVerdict.crossCheck, undefined);

  const badSessionWithFramesRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "bad!id", frames: ["J".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(badSessionWithFramesRes.status, 200);
  assert.equal(getHub("bad!id"), undefined);
});
