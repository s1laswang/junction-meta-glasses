import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import WebSocket from "ws";
import type { WebSocket as WsType } from "ws";
import type { DeviceState, LabelRead, ServerMsg, Verdict } from "../../shared/types.ts";
import { authEnabled, keyOk, requireKey, wsKeyOk } from "../src/auth.ts";
import { env } from "../src/env.ts";
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
  safeSend,
  setDevice,
  type LiveLike,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { errSummary, log, redact, shortId } from "../src/log.ts";
import type { Frame } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: ServerMsg[] = [];
  throwOnSend = false;

  send(data: string) {
    if (this.throwOnSend) throw new Error("socket write failed");
    this.sent.push(JSON.parse(data) as ServerMsg);
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }

  asWs(): WsType {
    return this as unknown as WsType;
  }
}

function sampleRead(): LabelRead {
  const nf = { value: null, confidence: 0 };
  return {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.95 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: nf,
    expiry: { value: "2027-08", confidence: 0.9 },
    allergens: { value: null, confidence: 0 },
    barcode: nf,
    readability: 0.92,
  };
}

function sampleVerdict(headline = "Amlodipine 5 mg match"): Verdict {
  return {
    level: "match",
    headline,
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: sampleRead(),
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
  };
}

function makeFrame(idx: number, source: "phone" | "glasses" = "phone", sharpness = 0.8): Frame {
  const data = Buffer.alloc(120, idx + 1).toString("base64");
  return { data, sharpness, ts: Date.now() + idx, bytes: 120, source };
}

function runRequireKey(
  baseUrl: string,
  reqPath: string,
  query: Record<string, unknown> = {},
  headers: Record<string, string | string[] | undefined> = {},
) {
  const req = { baseUrl, path: reqPath, query, headers } as unknown as Request;
  let statusCode = 200;
  let body: unknown = undefined;
  let nextCalled = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  requireKey(req, res, next);
  return { statusCode, body, nextCalled };
}

function mockUpgradeReq(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("hub pre-live state: orphan setDevice preserves worn:null for floating HUDs and transfers on first markLatest", () => {
  assert.equal(latestHub(), undefined);
  assert.equal(hudTarget(), undefined);
  assert.equal(hudTarget(null), undefined);
  assert.equal(hudTarget("nonexistent-session"), undefined);
  assert.equal(hubStats().latest, null);

  const floating = new FakeSocket();
  addHud(floating.asWs());
  assert.equal(hubStats().floatingHuds, 1);

  const orphanState: DeviceState = {
    connected: true,
    worn: null,
    battery: 78,
    streaming: true,
    source: "glasses",
  };
  setDevice(orphanState);
  assert.equal(floating.sent.length, 1);
  assert.deepEqual(floating.sent[0], { type: "device", device: orphanState });
  if (floating.sent[0].type === "device") {
    assert.equal(floating.sent[0].device.worn, null);
  }

  const firstHub = getOrCreateHub("sess-initial-12345678");
  const phoneClient = new FakeSocket();
  firstHub.clients.add(phoneClient.asWs());
  firstHub.emit({ type: "status", live: "open" }, { hud: false });
  floating.sent = [];
  phoneClient.sent = [];

  markLatest(firstHub);

  assert.equal(latestHub(), firstHub);
  assert.equal(hudTarget(), firstHub);
  assert.equal(hubStats().latest, "sess-ini");
  assert.deepEqual(firstHub.device, orphanState);
  assert.equal(firstHub.device?.worn, null);
  assert.deepEqual(floating.sent, [
    { type: "status", live: "open" },
    { type: "device", device: orphanState },
  ]);
  assert.deepEqual(phoneClient.sent, [{ type: "hud", connected: true }]);

  floating.disconnect();
  assert.equal(hubStats().floatingHuds, 0);
  assert.deepEqual(phoneClient.sent.at(-1), { type: "hud", connected: false });
  firstHub.clients.delete(phoneClient.asWs());
});

test("log.ts redact() enforces deny-list, omits undefined, caps string lengths, and masks Gemini keys", () => {
  const fakeKey = ["AIza", "SyntheticUnitTestToken987654321"].join("");
  const deniedKeys = [
    "text",
    "data",
    "transcript",
    "image",
    "frame",
    "frames",
    "audio",
    "profile",
    "speech",
    "headline",
    "question",
    "args",
    "prompt",
    "body",
    "key",
    "apikey",
    "api_key",
    "value",
    "Transcript",
    "API_KEY",
    "Profile",
    "Speech",
  ];
  const input: Record<string, string | number | boolean | null | undefined> = {
    session: "abcd1234",
    n_frames: 2,
    ok: true,
    latest: null,
    skipped: undefined,
  };
  for (const k of deniedKeys) input[k] = "sensitive patient content";

  const out = redact(input);
  for (const k of deniedKeys) {
    assert.equal(out[k], "[redacted]", `expected ${k} to be redacted`);
  }
  assert.equal(out.session, "abcd1234");
  assert.equal(out.n_frames, 2);
  assert.equal(out.ok, true);
  assert.equal(out.latest, null);
  assert.equal("skipped" in out, false);

  const exact48 = "a".repeat(48);
  const over48 = "b".repeat(49);
  const exact160 = "e".repeat(160);
  const over160 = "f".repeat(161);
  const lenOut = redact({
    model: exact48,
    detail: over48,
    err: exact160,
  });
  assert.equal(lenOut.model, exact48);
  assert.equal(lenOut.detail, "[redacted:49ch]");
  assert.equal(lenOut.err, exact160);
  assert.equal(redact({ err: over160 }).err, "[redacted:161ch]");

  const keyOut = redact({
    note: `bad=${fakeKey}`,
    err: `upstream rejected key ${fakeKey} with 403`,
  });
  assert.equal(keyOut.note, "bad=[key]");
  assert.equal(keyOut.err, "upstream rejected key [key] with 403");
});

test("log.ts shortId, errSummary, and log() console redaction + HOLDUP_QUIET", () => {
  const fakeKey = ["AIza", "AnotherFakeTokenForTesting12345"].join("");
  assert.equal(shortId("12345678-90ab-cdef"), "12345678");

  const multiLineErr = new Error(`Request failed\n  token=${fakeKey}\t${"x".repeat(200)}`);
  const summary = errSummary(multiLineErr);
  assert.equal(summary.includes(fakeKey), false);
  assert.ok(summary.includes("Request failed token=[key] "));
  assert.equal(summary.length, 160);
  assert.equal(errSummary(`plain   error\nwith ${fakeKey}`), "plain error with [key]");

  const captured: string[] = [];
  const origLog = console.log;
  const prevQuiet = process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    process.env.HOLDUP_QUIET = "1";
    log("test.quiet", { session: "12345678", transcript: "secret voice" });
    assert.equal(captured.length, 0);

    delete process.env.HOLDUP_QUIET;
    log("test.active", {
      session: "12345678",
      transcript: "my evening amlodipine",
      speech: "Yes, take 5 mg",
      detail: `k=${fakeKey}`,
    });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /test\.active/);
    assert.match(captured[0], /session=12345678/);
    assert.match(captured[0], /transcript=\[redacted\]/);
    assert.match(captured[0], /speech=\[redacted\]/);
    assert.match(captured[0], /detail=k=\[key\]/);
    assert.equal(captured[0].includes("amlodipine"), false);
    assert.equal(captured[0].includes(fakeKey), false);
  } finally {
    console.log = origLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("hub session isolation: profiles, frames, verdicts, clients, and HUDs never leak across sessions", () => {
  const hubA = getOrCreateHub("sess-iso-alpha");
  const hubB = getOrCreateHub("sess-iso-beta");
  assert.notEqual(hubA, hubB);
  assert.equal(getOrCreateHub("sess-iso-alpha"), hubA);
  assert.equal(getHub("sess-iso-alpha"), hubA);
  assert.equal(getHub("sess-iso-missing"), undefined);
  assert.equal(resolveHub("sess-iso-missing"), undefined);

  const clientA = new FakeSocket();
  const clientB = new FakeSocket();
  const hudA = new FakeSocket();
  const hudB = new FakeSocket();
  hubA.clients.add(clientA.asWs());
  hubB.clients.add(clientB.asWs());
  addHud(hudA.asWs(), "sess-iso-alpha");
  addHud(hudB.asWs(), "sess-iso-beta");
  clientA.sent = [];
  clientB.sent = [];
  hudA.sent = [];
  hudB.sent = [];

  hubA.profile = {
    meds: [{ id: "m1", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [{ medId: "m1", ts: 1000 }],
    lang: "fi",
  };
  hubA.source = "glasses";
  hubA.addFrame(makeFrame(1, "glasses", 0.91));

  assert.deepEqual(hubB.profile.meds, []);
  assert.deepEqual(hubB.profile.allergies, []);
  assert.equal(hubB.profile.lang, "en");
  assert.equal(hubB.source, "phone");
  assert.equal(hubB.ring.length, 0);
  assert.equal(hubA.ring.length, 1);

  const verdictA = sampleVerdict("Alpha pill match");
  hubA.emit({ type: "transcript", role: "user", text: "is this my evening pill", final: true });
  hubA.emit({ type: "audio", data: "AAAA" });
  hubA.emit({ type: "coach", cue: "closer", text: "Move it closer." });
  hubA.emit({ type: "verdict", verdict: verdictA });
  hubA.emit({ type: "status", live: "open" }, { clients: false });
  hubA.emit({ type: "coach", cue: "hold_still", text: "Hold still." }, { hud: false });

  assert.deepEqual(
    clientA.sent.map((m) => m.type),
    ["transcript", "audio", "coach", "verdict", "coach"],
  );
  assert.deepEqual(
    hudA.sent.map((m) => m.type),
    ["coach", "verdict", "status"],
  );
  assert.equal(clientB.sent.length, 0);
  assert.equal(hudB.sent.length, 0);
  assert.equal(hubB.lastVerdict, undefined);
  assert.equal(hubB.lastCoach, undefined);
  assert.equal(hubB.lastStatus, undefined);

  const closedSock = new FakeSocket();
  closedSock.readyState = 3;
  const throwingSock = new FakeSocket();
  throwingSock.throwOnSend = true;
  safeSend(closedSock.asWs(), JSON.stringify({ type: "pong", t: 1 }));
  assert.equal(closedSock.sent.length, 0);
  assert.doesNotThrow(() => safeSend(throwingSock.asWs(), JSON.stringify({ type: "pong", t: 1 })));

  hudA.disconnect();
  hudB.disconnect();
  hubA.clients.delete(clientA.asWs());
  hubB.clients.delete(clientB.asWs());
  hubA.dropFrames();
});

test("HUD fan-out, hudTarget(specific vs latest), markLatest handoff, and late-HUD replay", () => {
  const hub1 = getOrCreateHub("sess-fan-one");
  const hub2 = getOrCreateHub("sess-fan-two");

  const phone1 = new FakeSocket();
  const phone2 = new FakeSocket();
  const pinnedHud1 = new FakeSocket();
  const pinnedHud2 = new FakeSocket();
  const floatingHud = new FakeSocket();

  hub1.clients.add(phone1.asWs());
  hub2.clients.add(phone2.asWs());

  markLatest(hub1);
  addHud(pinnedHud1.asWs(), "sess-fan-one");
  addHud(pinnedHud2.asWs(), "sess-fan-two");
  addHud(floatingHud.asWs());

  assert.equal(hudTarget(), hub1);
  assert.equal(hudTarget(null), hub1);
  assert.equal(hudTarget("sess-fan-one"), hub1);
  assert.equal(hudTarget("sess-fan-two"), hub2);
  assert.equal(hudTarget("sess-unknown"), undefined);

  pinnedHud1.sent = [];
  pinnedHud2.sent = [];
  floatingHud.sent = [];

  hub1.emit({ type: "coach", cue: "rotate_left", text: "Turn it slightly left." });
  assert.equal(pinnedHud1.sent.length, 1);
  assert.equal(floatingHud.sent.length, 1);
  assert.equal(pinnedHud2.sent.length, 0);

  const device2: DeviceState = {
    connected: true,
    worn: true,
    battery: 82,
    streaming: true,
    source: "glasses",
  };
  const verdict2 = sampleVerdict("Session two verdict");
  hub2.emit({ type: "status", live: "open" });
  setDevice(device2, "sess-fan-two");
  hub2.emit({ type: "verdict", verdict: verdict2 });
  assert.equal(pinnedHud2.sent.length, 3);
  assert.equal(floatingHud.sent.length, 1);
  assert.equal(pinnedHud1.sent.length, 1);

  floatingHud.sent = [];
  phone2.sent = [];
  markLatest(hub2);

  assert.equal(hudTarget(), hub2);
  assert.equal(hudTarget("sess-fan-one"), hub1);
  assert.equal(hudTarget("sess-fan-two"), hub2);
  assert.deepEqual(
    floatingHud.sent.map((m) => m.type),
    ["status", "device", "verdict"],
  );
  assert.deepEqual(floatingHud.sent[1], { type: "device", device: device2 });
  assert.deepEqual(phone2.sent.at(-1), { type: "hud", connected: true });

  floatingHud.sent = [];
  pinnedHud1.sent = [];
  pinnedHud2.sent = [];
  hub1.emit({ type: "coach", cue: "farther", text: "Move it farther." });
  assert.equal(pinnedHud1.sent.length, 1);
  assert.equal(floatingHud.sent.length, 0);
  assert.equal(pinnedHud2.sent.length, 0);

  const lateHud2 = new FakeSocket();
  addHud(lateHud2.asWs(), "sess-fan-two");
  assert.deepEqual(
    lateHud2.sent.map((m) => m.type),
    ["status", "device", "verdict"],
  );

  floatingHud.disconnect();
  lateHud2.disconnect();
  phone2.sent = [];
  pinnedHud2.disconnect();
  assert.deepEqual(phone2.sent.at(-1), { type: "hud", connected: false });

  pinnedHud1.disconnect();
  hub1.clients.delete(phone1.asWs());
  hub2.clients.delete(phone2.asWs());
});

test("dropFrames() zero-retention cleanup clears ring buffer and speculative cache/timers", async () => {
  const tmpLedger = path.join(os.tmpdir(), `holdup-f4-ledger-${process.pid}-${Date.now()}.jsonl`);
  const prevLedger = env.ledgerPath;
  env.ledgerPath = tmpLedger;
  try {
    const hub = new Hub("sess-drop-unit");
    let stoppedReason = "";
    const fakeLive: LiveLike = {
      active: true,
      handleEvent() {},
      stop(reason: string) {
        stoppedReason = reason;
      },
    };
    hub.live = fakeLive;

    for (let i = 0; i < 10; i++) {
      hub.addFrame(makeFrame(i, "phone", 0.5 + i * 0.04));
    }
    assert.equal(hub.ring.length, 8);
    assert.equal(hub.ring.pick(2).length, 2);
    assert.ok(hub.ring.lastTs > 0);

    (hub.spec as unknown as { cache: unknown }).cache = {
      read: sampleRead(),
      model: "gemini-3.8-flash",
      frameTs: Date.now(),
      sharpness: 0.9,
      bytes: 120,
      at: Date.now(),
    };
    const cachedBefore = await hub.spec.get(50);
    assert.equal(cachedBefore?.source, "cache");

    hub.live.stop("client disconnected");
    hub.dropFrames();

    assert.equal(stoppedReason, "client disconnected");
    assert.equal(hub.ring.length, 0);
    assert.deepEqual(hub.ring.pick(2), []);
    assert.equal(hub.ring.lastTs, 0);
    const cachedAfter = await hub.spec.get(50);
    assert.equal(cachedAfter, undefined);
  } finally {
    env.ledgerPath = prevLedger;
    fs.rmSync(tmpLedger, { force: true });
  }
});

test("setDevice preserves worn: boolean | null across explicit sessions, latest session, and HUD replay", () => {
  const hub = getOrCreateHub("sess-worn-check");
  const client = new FakeSocket();
  const hud = new FakeSocket();
  hub.clients.add(client.asWs());
  addHud(hud.asWs(), "sess-worn-check");
  client.sent = [];
  hud.sent = [];

  const unknownWorn: DeviceState = {
    connected: true,
    worn: null,
    battery: null,
    streaming: true,
    source: "glasses",
  };
  setDevice(unknownWorn, "sess-worn-check");
  assert.equal(hub.device?.worn, null);
  assert.equal(hub.device?.battery, null);
  assert.deepEqual(client.sent.at(-1), { type: "device", device: unknownWorn });
  assert.deepEqual(hud.sent.at(-1), { type: "device", device: unknownWorn });

  const lateHud = new FakeSocket();
  addHud(lateHud.asWs(), "sess-worn-check");
  assert.deepEqual(lateHud.sent, [{ type: "device", device: unknownWorn }]);
  if (lateHud.sent[0]?.type === "device") {
    assert.equal(lateHud.sent[0].device.worn, null);
  }

  const activelyWorn: DeviceState = {
    connected: true,
    worn: true,
    battery: 91,
    streaming: true,
    source: "glasses",
  };
  setDevice(activelyWorn, "sess-worn-check");
  assert.equal(hub.device?.worn, true);
  assert.equal(hub.device?.battery, 91);

  const takenOff: DeviceState = {
    connected: true,
    worn: false,
    battery: 90,
    streaming: false,
    source: "glasses",
  };
  setDevice(takenOff, "sess-worn-check");
  assert.equal(hub.device?.worn, false);

  markLatest(hub);
  setDevice(unknownWorn);
  assert.equal(hub.device?.worn, null);

  const createdViaDevice: DeviceState = {
    connected: false,
    worn: null,
    battery: null,
    streaming: false,
    source: "glasses",
  };
  setDevice(createdViaDevice, "sess-created-by-device");
  assert.equal(getHub("sess-created-by-device")?.device?.worn, null);

  hud.disconnect();
  lateHud.disconnect();
  hub.clients.delete(client.asWs());
});

test("HOLDUP_KEY unit checks: requireKey and wsKeyOk query/header auth with /api/health open", () => {
  const prevKey = process.env.HOLDUP_KEY;
  try {
    delete process.env.HOLDUP_KEY;
    assert.equal(authEnabled(), false);
    assert.equal(keyOk(undefined), true);
    assert.equal(keyOk(null), true);
    assert.equal(keyOk(""), true);
    assert.equal(runRequireKey("/api", "/stats").nextCalled, true);
    assert.equal(runRequireKey("/ingest", "/frame").nextCalled, true);
    assert.equal(wsKeyOk(mockUpgradeReq(), new URL("http://localhost/live")), true);
    assert.equal(wsKeyOk(mockUpgradeReq(), new URL("http://localhost/hud-ws")), true);

    process.env.HOLDUP_KEY = "gate-secret-2026";
    assert.equal(authEnabled(), true);
    assert.equal(keyOk(undefined), false);
    assert.equal(keyOk(null), false);
    assert.equal(keyOk(""), false);
    assert.equal(keyOk("short"), false);
    assert.equal(keyOk("gate-secret-2025"), false);
    assert.equal(keyOk("gate-secret-2026-extra-long"), false);
    assert.equal(keyOk("gate-secret-2026"), true);

    const healthNoKey = runRequireKey("/api", "/health");
    assert.equal(healthNoKey.nextCalled, true);
    assert.equal(healthNoKey.statusCode, 200);

    const healthWrongKey = runRequireKey("/api", "/health", { key: "wrong" }, { "x-holdup-key": "wrong" });
    assert.equal(healthWrongKey.nextCalled, true);

    const statsMissing = runRequireKey("/api", "/stats");
    assert.equal(statsMissing.nextCalled, false);
    assert.equal(statsMissing.statusCode, 401);
    assert.deepEqual(statsMissing.body, {
      type: "error",
      code: "unauthorized",
      message: "access key required",
      recoverable: false,
    });

    const ingestWrong = runRequireKey("/ingest", "/state", { key: "wrong" });
    assert.equal(ingestWrong.nextCalled, false);
    assert.equal(ingestWrong.statusCode, 401);

    const queryAuth = runRequireKey("/api", "/verify", { key: "gate-secret-2026" });
    assert.equal(queryAuth.nextCalled, true);

    const headerAuth = runRequireKey("/ingest", "/frame", {}, { "x-holdup-key": "gate-secret-2026" });
    assert.equal(headerAuth.nextCalled, true);

    const arrayHeaderAuth = runRequireKey("/api", "/stats", {}, { "x-holdup-key": ["gate-secret-2026", "other"] });
    assert.equal(arrayHeaderAuth.nextCalled, true);

    const nonStringQueryWithValidHeader = runRequireKey(
      "/api",
      "/stats",
      { key: ["bad"] },
      { "x-holdup-key": "gate-secret-2026" },
    );
    assert.equal(nonStringQueryWithValidHeader.nextCalled, true);

    const wrongQueryOverridesHeader = runRequireKey(
      "/api",
      "/stats",
      { key: "wrong" },
      { "x-holdup-key": "gate-secret-2026" },
    );
    assert.equal(wrongQueryOverridesHeader.nextCalled, false);
    assert.equal(wrongQueryOverridesHeader.statusCode, 401);

    assert.equal(wsKeyOk(mockUpgradeReq(), new URL("http://localhost/live")), false);
    assert.equal(wsKeyOk(mockUpgradeReq(), new URL("http://localhost/hud-ws?key=wrong")), false);
    assert.equal(wsKeyOk(mockUpgradeReq({ "x-holdup-key": "wrong" }), new URL("http://localhost/live")), false);
    assert.equal(
      wsKeyOk(mockUpgradeReq(), new URL("http://localhost/live?session=abc1&key=gate-secret-2026")),
      true,
    );
    assert.equal(
      wsKeyOk(mockUpgradeReq({ "x-holdup-key": "gate-secret-2026" }), new URL("http://localhost/hud-ws")),
      true,
    );
    assert.equal(
      wsKeyOk(mockUpgradeReq({ "x-holdup-key": ["gate-secret-2026"] }), new URL("http://localhost/live")),
      true,
    );
  } finally {
    if (prevKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevKey;
  }
});

test("HTTP + WebSocket integration: HOLDUP_KEY enforcement, /ingest/state worn:null, and /live disconnect zero-retention", async () => {
  const prevKey = process.env.HOLDUP_KEY;
  const prevApiKey = env.apiKey;
  process.env.HOLDUP_KEY = "live-test-key-99";
  env.apiKey = "";
  const server = await startServer(0);
  const port = (server.address() as AddressInfo).port;
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;

  const waitOpen = (ws: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  const waitClose = (ws: WebSocket) =>
    new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

  try {
    const healthRes = await fetch(`${baseHttp}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthJson.ok, true);

    const unauthStats = await fetch(`${baseHttp}/api/stats`);
    assert.equal(unauthStats.status, 401);

    const queryStats = await fetch(`${baseHttp}/api/stats?key=live-test-key-99`);
    assert.equal(queryStats.status, 200);

    const headerStats = await fetch(`${baseHttp}/api/stats`, {
      headers: { "x-holdup-key": "live-test-key-99" },
    });
    assert.equal(headerStats.status, 200);

    const unauthWs = new WebSocket(`${baseWs}/live?session=sess-unauth`);
    const unauthClose = await waitClose(unauthWs);
    assert.equal(unauthClose.code, 4401);
    assert.equal(unauthClose.reason, "unauthorized");

    const stateMissingWorn = await fetch(`${baseHttp}/ingest/state?session=sess-http-dev&key=live-test-key-99`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, streaming: true }),
    });
    assert.equal(stateMissingWorn.status, 204);
    assert.equal(getHub("sess-http-dev")?.device?.worn, null);
    assert.equal(getHub("sess-http-dev")?.device?.battery, null);

    const stateFalseWorn = await fetch(`${baseHttp}/ingest/state?session=sess-http-dev`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-holdup-key": "live-test-key-99" },
      body: JSON.stringify({ connected: true, worn: false, battery: 45, streaming: false }),
    });
    assert.equal(stateFalseWorn.status, 204);
    assert.equal(getHub("sess-http-dev")?.device?.worn, false);
    assert.equal(getHub("sess-http-dev")?.device?.battery, 45);

    const sessId = "sess-ws-retention";
    const ws1 = new WebSocket(`${baseWs}/live?session=${sessId}&key=live-test-key-99`);
    const ws2 = new WebSocket(`${baseWs}/live?session=${sessId}`, {
      headers: { "x-holdup-key": "live-test-key-99" },
    });
    const hudWs = new WebSocket(`${baseWs}/hud-ws?session=${sessId}`, {
      headers: { "x-holdup-key": "live-test-key-99" },
    });
    await Promise.all([waitOpen(ws1), waitOpen(ws2), waitOpen(hudWs)]);

    const jpegPayload = Buffer.alloc(160, 0xab);
    const ignoredGlassesFrame = await fetch(`${baseHttp}/ingest/frame?session=${sessId}&key=live-test-key-99`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: jpegPayload,
    });
    assert.equal(ignoredGlassesFrame.status, 204);
    assert.equal(getHub(sessId)?.ring.length, 0);

    const pongPromise = new Promise<ServerMsg>((resolve) => {
      ws1.once("message", (raw) => resolve(JSON.parse(raw.toString()) as ServerMsg));
    });
    const b64Frame = jpegPayload.toString("base64");
    ws1.send(JSON.stringify({ type: "frame", data: b64Frame, w: 320, h: 240, sharpness: 0.85, ts: Date.now() }));
    ws1.send(JSON.stringify({ type: "frame", data: b64Frame, w: 320, h: 240, sharpness: 0.9, ts: Date.now() + 1 }));
    ws1.send(JSON.stringify({ type: "ping", t: 42 }));
    const pong = await pongPromise;
    assert.deepEqual(pong, { type: "pong", t: 42 });
    assert.equal(getHub(sessId)?.ring.length, 2);

    const hudEventPromise = new Promise<ServerMsg>((resolve) => {
      ws2.once("message", (raw) => resolve(JSON.parse(raw.toString()) as ServerMsg));
    });
    hudWs.send(JSON.stringify({ type: "event", name: "log_dose" }));
    const forwardedHudEvent = await hudEventPromise;
    assert.deepEqual(forwardedHudEvent, { type: "hud_event", name: "log_dose" });

    const c1 = waitClose(ws1);
    ws1.close();
    await c1;
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(getHub(sessId)?.clients.size, 1);
    assert.equal(getHub(sessId)?.ring.length, 2);

    const c2 = waitClose(ws2);
    ws2.close();
    await c2;
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(getHub(sessId)?.clients.size, 0);
    assert.equal(getHub(sessId)?.ring.length, 0);
    assert.deepEqual(getHub(sessId)?.ring.pick(2), []);

    const verifyAfterDrop = await fetch(`${baseHttp}/api/verify?key=live-test-key-99`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessId }),
    });
    assert.equal(verifyAfterDrop.status, 409);
    const verifyJson = (await verifyAfterDrop.json()) as { code: string };
    assert.equal(verifyJson.code, "no_frames");

    const ch = waitClose(hudWs);
    hudWs.close();
    await ch;
  } finally {
    if (prevKey === undefined) delete process.env.HOLDUP_KEY;
    else process.env.HOLDUP_KEY = prevKey;
    env.apiKey = prevApiKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
