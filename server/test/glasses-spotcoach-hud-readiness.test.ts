import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import jpegJs from "jpeg-js";
import { WebSocket } from "ws";
import type { ServerMsg, Verdict } from "../../shared/types.ts";
import { REPO_ROOT } from "../src/env.ts";
import { COACH, SpotCoach } from "../src/spotcoach.ts";
import { SPOT, SpotThrottle, detect, spotterAvailable, type FieldBox } from "../src/spotter.ts";
import { toLabelRead, unreadable, type Frame } from "../src/verify.ts";

const prevSpotter = process.env.SPOTTER;
process.env.SPOTTER = "1";

const { Hub, getHub, markLatest } = await import("../src/hub.ts");
const { startServer } = await import("../src/index.ts");

type HubInstance = InstanceType<typeof Hub>;

const box = (
  label: FieldBox["label"],
  score: number,
  coords: [number, number, number, number] = [380, 260, 520, 740],
): FieldBox => ({ label, box: coords, score });

const mkFrame = (sharpness: number, ts = Date.now(), source: "phone" | "glasses" = "glasses"): Frame => ({
  data: "A".repeat(160),
  sharpness,
  ts,
  bytes: 120,
  source,
});

const feedFields = (hub: HubInstance, frame: Frame, fields: FieldBox[]) => {
  (hub as unknown as { onFields(f: Frame, boxes: FieldBox[]): void }).onFields(frame, fields);
};

const mockSocket = () => {
  const sent: ServerMsg[] = [];
  const ws = {
    readyState: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket;
  return { ws, sent };
};

const sampleVerdict = (): Verdict => ({
  level: "match",
  headline: "Amlodipine 5 mg: evening pill",
  speech: "Yes, Amlodipine 5 mg, your evening pill.",
  read: unreadable(),
  matchedMedId: "aml",
  reasons: ["Matches schedule"],
  takenToday: false,
});

let server: http.Server | undefined;
let httpBase = "";
let wsBase = "";
const sockets: WebSocket[] = [];
const prevHoldupKey = process.env.HOLDUP_KEY;

async function ensureServer() {
  if (server) return;
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const port = (server.address() as AddressInfo).port;
  httpBase = ["http:", "", `127.0.0.1:${port}`].join("/");
  wsBase = ["ws:", "", `127.0.0.1:${port}`].join("/");
}

function connectWs(route: string) {
  const ws = new WebSocket(wsBase + route);
  sockets.push(ws);
  const msgs: ServerMsg[] = [];
  ws.on("message", (raw) => {
    msgs.push(JSON.parse(raw.toString()) as ServerMsg);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, msgs, opened };
}

const wait = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await wait(25);
  }
  assert.ok(pred(), "timed out waiting for expected condition");
}

after(async () => {
  for (const s of sockets) s.terminate();
  if (prevHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = prevHoldupKey;
  if (prevSpotter === undefined) delete process.env.SPOTTER;
  else process.env.SPOTTER = prevSpotter;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("SpotCoach covered cue requires 2 seen frames (>=0.6) then 2 steady-sharp lost frames with product (>=0.5)", () => {
  assert.equal(COACH.strong, 0.6);
  assert.equal(COACH.product, 0.5);
  assert.equal(COACH.seenFrames, 2);
  assert.equal(COACH.lostFrames, 2);

  const singleSeen = new SpotCoach();
  let t = 10_000;
  assert.equal(singleSeen.push([box("product", 0.8), box("strength", 0.59)], 0.8, (t += 300)), undefined);
  assert.equal(singleSeen.push([box("product", 0.8), box("strength", 0.6)], 0.8, (t += 300)), undefined);
  assert.equal(singleSeen.push([box("product", 0.5)], 0.8, (t += 300)), undefined);
  assert.equal(singleSeen.push([box("product", 0.5)], 0.8, (t += 300)), undefined);

  const coach = new SpotCoach();
  t = 10_000;
  assert.equal(coach.push([box("product", 0.5), box("strength", 0.6)], 0.8, (t += 300)), undefined);
  assert.equal(coach.push([box("product", 0.7), box("strength", 0.75)], 0.8, (t += 300)), undefined);
  assert.equal(coach.push([box("product", 0.5), box("strength", 0.59)], 0.75, (t += 300)), undefined);
  const cue = coach.push([box("product", 0.5)], 0.65, (t += 300));
  assert.deepEqual(cue, {
    kind: "covered",
    cue: "hold_still",
    text: "Something is covering the dose. Move your thumb.",
  });

  t += 9_000;
  assert.equal(coach.push([box("product", 0.8)], 0.8, (t += 300)), undefined);
  assert.equal(coach.push([box("product", 0.8)], 0.8, (t += 300)), undefined);

  const boxLeftView = new SpotCoach();
  t = 10_000;
  boxLeftView.push([box("product", 0.8), box("strength", 0.8)], 0.8, (t += 300));
  boxLeftView.push([box("product", 0.8), box("strength", 0.8)], 0.8, (t += 300));
  assert.equal(boxLeftView.push([box("product", 0.49)], 0.8, (t += 300)), undefined);
  assert.equal(boxLeftView.push([box("product", 0.8)], 0.8, (t += 300)), undefined);
  assert.equal(boxLeftView.push([box("product", 0.8)], 0.8, (t += 300)), undefined);
});

test("SpotCoach motion-blur guard suppresses covered when sharpness drops by >= 0.2", () => {
  assert.equal(COACH.sharpDrop, 0.2);

  const blurred = new SpotCoach();
  let t = 10_000;
  blurred.push([box("product", 0.85), box("strength", 0.85)], 0.8, (t += 300));
  blurred.push([box("product", 0.85), box("strength", 0.85)], 0.8, (t += 300));
  assert.equal(blurred.push([box("product", 0.85)], 0.6, (t += 300)), undefined);
  assert.equal(blurred.push([box("product", 0.85)], 0.58, (t += 300)), undefined);
  assert.equal(blurred.push([box("product", 0.85)], 0.55, (t += 300)), undefined);

  const interruptedLostStreak = new SpotCoach();
  t = 10_000;
  interruptedLostStreak.push([box("product", 0.85), box("strength", 0.85)], 0.85, (t += 300));
  interruptedLostStreak.push([box("product", 0.85), box("strength", 0.85)], 0.85, (t += 300));
  assert.equal(interruptedLostStreak.push([box("product", 0.85)], 0.82, (t += 300)), undefined);
  assert.equal(interruptedLostStreak.push([box("product", 0.85)], 0.64, (t += 300)), undefined);
  assert.equal(interruptedLostStreak.push([box("product", 0.85)], 0.83, (t += 300)), undefined);
  const recoveredThenCovered = interruptedLostStreak.push([box("product", 0.85)], 0.83, (t += 300));
  assert.equal(recoveredThenCovered?.kind, "covered");
});

test("SpotCoach other_side cue fires at >= 3000ms of product-only (>=0.5) without strength (>=0.6)", () => {
  assert.equal(COACH.otherSideMs, 3000);

  const coach = new SpotCoach();
  const t0 = 10_000;
  assert.equal(coach.push([box("product", 0.5), box("strength", 0.59)], 0.75, t0), undefined);
  assert.equal(coach.push([box("product", 0.6)], 0.75, t0 + 1500), undefined);
  assert.equal(coach.push([box("product", 0.6)], 0.75, t0 + 2999), undefined);
  const cue = coach.push([box("product", 0.5)], 0.75, t0 + 3000);
  assert.deepEqual(cue, {
    kind: "other_side",
    cue: "other_side",
    text: "Turn the box. The dose is on another side.",
  });

  const resetByDose = new SpotCoach();
  assert.equal(resetByDose.push([box("product", 0.7)], 0.75, t0), undefined);
  assert.equal(resetByDose.push([box("product", 0.7)], 0.75, t0 + 2500), undefined);
  assert.equal(resetByDose.push([box("product", 0.7), box("strength", 0.6)], 0.75, t0 + 2800), undefined);
  assert.equal(resetByDose.push([box("product", 0.7)], 0.75, t0 + 3500), undefined);
  assert.equal(resetByDose.push([box("product", 0.7)], 0.75, t0 + 5799), undefined);

  const resetByProductDrop = new SpotCoach();
  assert.equal(resetByProductDrop.push([box("product", 0.7)], 0.75, t0), undefined);
  assert.equal(resetByProductDrop.push([box("product", 0.49)], 0.75, t0 + 2500), undefined);
  assert.equal(resetByProductDrop.push([box("product", 0.7)], 0.75, t0 + 2700), undefined);
  assert.equal(resetByProductDrop.push([box("product", 0.7)], 0.75, t0 + 5699), undefined);
  assert.equal(resetByProductDrop.push([box("product", 0.7)], 0.75, t0 + 5700)?.kind, "other_side");
});

test("SpotCoach edge cue fires on 2 consecutive frames for all 4 edges and respects 15 / 985 boundaries", () => {
  assert.equal(COACH.edge, 15);

  const safeBoundary = new SpotCoach();
  let t = 10_000;
  const insideBox: [number, number, number, number] = [15, 15, 985, 985];
  assert.equal(safeBoundary.push([box("strength", 0.85, insideBox)], 0.8, (t += 300)), undefined);
  assert.equal(safeBoundary.push([box("strength", 0.85, insideBox)], 0.8, (t += 300)), undefined);
  assert.equal(safeBoundary.push([box("strength", 0.85, insideBox)], 0.8, (t += 300)), undefined);

  const nonConsecutive = new SpotCoach();
  t = 10_000;
  assert.equal(nonConsecutive.push([box("strength", 0.85, [400, 14, 500, 200])], 0.8, (t += 300)), undefined);
  assert.equal(nonConsecutive.push([box("strength", 0.85, [400, 200, 500, 500])], 0.8, (t += 300)), undefined);
  assert.equal(nonConsecutive.push([box("strength", 0.85, [400, 14, 500, 200])], 0.8, (t += 300)), undefined);

  const weakAtEdge = new SpotCoach();
  t = 10_000;
  assert.equal(weakAtEdge.push([box("strength", 0.59, [400, 5, 500, 200])], 0.8, (t += 300)), undefined);
  assert.equal(weakAtEdge.push([box("strength", 0.59, [400, 5, 500, 200])], 0.8, (t += 300)), undefined);

  const cases: Array<{ coords: [number, number, number, number]; expectedDir: string }> = [
    { coords: [400, 14, 500, 220], expectedDir: "to the right" },
    { coords: [400, 780, 500, 986], expectedDir: "to the left" },
    { coords: [14, 300, 140, 600], expectedDir: "down" },
    { coords: [860, 300, 986, 600], expectedDir: "up" },
  ];

  for (const { coords, expectedDir } of cases) {
    const c = new SpotCoach();
    let ts = 10_000;
    assert.equal(c.push([box("strength", 0.8, coords)], 0.8, (ts += 250)), undefined);
    const cue = c.push([box("strength", 0.8, coords)], 0.8, (ts += 250));
    assert.deepEqual(cue, {
      kind: "edge",
      cue: "hold_still",
      text: `Move it a little ${expectedDir}. The dose is at the edge.`,
    });
  }
});

test("SpotCoach enforces quietUntil, minGapMs (3000ms), sameKindMs (8000ms), and reset()", () => {
  assert.equal(COACH.minGapMs, 3000);
  assert.equal(COACH.sameKindMs, 8000);

  const quietCoach = new SpotCoach();
  quietCoach.quietUntil = 15_000;
  assert.equal(quietCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 14_500), undefined);
  assert.equal(quietCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 14_999), undefined);
  assert.equal(quietCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 15_000)?.kind, "edge");

  const rateCoach = new SpotCoach();
  assert.equal(rateCoach.push([box("product", 0.8), box("strength", 0.85, [400, 5, 500, 200])], 0.8, 9_800), undefined);
  assert.equal(rateCoach.push([box("product", 0.8), box("strength", 0.85, [400, 5, 500, 200])], 0.8, 10_000)?.kind, "edge");

  assert.equal(rateCoach.push([box("product", 0.8)], 0.8, 12_500), undefined);
  assert.equal(rateCoach.push([box("product", 0.8)], 0.8, 12_999), undefined);

  assert.equal(rateCoach.push([box("product", 0.8), box("strength", 0.85)], 0.8, 12_999), undefined);
  assert.equal(rateCoach.push([box("product", 0.8), box("strength", 0.85)], 0.8, 12_999), undefined);
  assert.equal(rateCoach.push([box("product", 0.8)], 0.8, 12_999), undefined);
  assert.equal(rateCoach.push([box("product", 0.8)], 0.8, 13_000)?.kind, "covered");

  assert.equal(rateCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 17_800), undefined);
  assert.equal(rateCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 17_999), undefined);
  assert.equal(rateCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 18_000)?.kind, "edge");

  const resetCoach = new SpotCoach();
  resetCoach.push([box("product", 0.8), box("strength", 0.85, [400, 5, 500, 200])], 0.8, 10_000);
  resetCoach.push([box("product", 0.8), box("strength", 0.85)], 0.8, 10_300);
  resetCoach.push([box("product", 0.8)], 0.8, 10_600);
  resetCoach.reset();
  assert.equal(resetCoach.push([box("product", 0.8)], 0.8, 10_900), undefined);
  assert.equal(resetCoach.push([box("strength", 0.85, [400, 5, 500, 200])], 0.8, 11_200), undefined);

  resetCoach.push([box("product", 0.8)], 0.8, 12_000);
  resetCoach.reset();
  assert.equal(resetCoach.push([box("product", 0.8)], 0.8, 15_100), undefined);
});

test("Hub.updateReadiness boosts on fresh strength >= 0.5 and caps <= 0.55 on product-only >= 0.5", () => {
  const inactiveHub = new Hub("readiness-inactive");
  const inactivePhone = mockSocket();
  inactiveHub.clients.add(inactivePhone.ws);
  inactiveHub.lastFields = { fields: [box("strength", 0.9)], ts: Date.now() };
  inactiveHub.updateReadiness(0.8);
  assert.equal(inactivePhone.sent.length, 0);

  const boostHub = new Hub("readiness-boost");
  const boostPhone = mockSocket();
  const boostStage = mockSocket();
  const boostHud = mockSocket();
  boostHub.clients.add(boostPhone.ws);
  boostHub.stages.add(boostStage.ws);
  boostHub.huds.add(boostHud.ws);
  boostHub.features.add("sonar");
  boostHub.live = { active: true, handleEvent() {}, stop() {} };
  boostHub.lastFields = {
    fields: [box("strength", 0.55), box("strength", 0.9), box("product", 0.8)],
    ts: Date.now(),
  };
  boostHub.updateReadiness(0.8);

  assert.deepEqual(boostPhone.sent, [{ type: "readiness", value: 0.81 }]);
  assert.deepEqual(boostStage.sent, [{ type: "readiness", value: 0.81 }]);
  assert.equal(boostHud.sent.length, 0);

  const thresholdHub = new Hub("readiness-threshold");
  const thresholdPhone = mockSocket();
  thresholdHub.clients.add(thresholdPhone.ws);
  thresholdHub.features.add("sonar");
  thresholdHub.live = { active: true, handleEvent() {}, stop() {} };
  thresholdHub.lastFields = { fields: [box("strength", 0.5)], ts: Date.now() };
  thresholdHub.updateReadiness(0.8);
  assert.deepEqual(thresholdPhone.sent, [{ type: "readiness", value: 0.65 }]);

  const staleHub = new Hub("readiness-stale");
  const stalePhone = mockSocket();
  staleHub.clients.add(stalePhone.ws);
  staleHub.features.add("sonar");
  staleHub.live = { active: true, handleEvent() {}, stop() {} };
  staleHub.lastFields = { fields: [box("strength", 0.95)], ts: Date.now() - 2600 };
  staleHub.updateReadiness(0.8);
  assert.deepEqual(stalePhone.sent, [{ type: "readiness", value: 0.48 }]);

  const capHub = new Hub("readiness-cap");
  const capPhone = mockSocket();
  capHub.clients.add(capPhone.ws);
  capHub.features.add("sonar");
  capHub.live = { active: true, handleEvent() {}, stop() {} };
  const cachedRead = toLabelRead({
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.96 },
    readability: 0.95,
  });
  capHub.spec.latest = () => ({
    read: cachedRead,
    model: "mock-verify",
    frameTs: Date.now(),
    sharpness: 1,
    bytes: 1000,
    at: Date.now(),
  });
  capHub.lastFields = { fields: [box("product", 0.5), box("strength", 0.49)], ts: Date.now() };
  capHub.updateReadiness(1.0);
  assert.deepEqual(capPhone.sent, [{ type: "readiness", value: 0.55 }]);

  const lowSharpCapHub = new Hub("readiness-cap-low");
  const lowSharpPhone = mockSocket();
  lowSharpCapHub.clients.add(lowSharpPhone.ws);
  lowSharpCapHub.features.add("sonar");
  lowSharpCapHub.live = { active: true, handleEvent() {}, stop() {} };
  lowSharpCapHub.lastFields = { fields: [box("product", 0.85)], ts: Date.now() };
  lowSharpCapHub.updateReadiness(0.3);
  assert.deepEqual(lowSharpPhone.sent, [{ type: "readiness", value: 0.18 }]);
});

test("Hub suppresses FieldSpotter coach cues while live.busy and within 6000ms after a verdict", () => {
  const busyHub = new Hub("hub-busy-guard");
  const phone = mockSocket();
  const hud = mockSocket();
  busyHub.clients.add(phone.ws);
  busyHub.huds.add(hud.ws);
  busyHub.live = { active: true, busy: true, handleEvent() {}, stop() {} };

  const beforeBusy = Date.now();
  feedFields(busyHub, mkFrame(0.85), [box("strength", 0.9, [400, 4, 500, 200])]);
  feedFields(busyHub, mkFrame(0.85), [box("strength", 0.9, [400, 4, 500, 200])]);
  assert.ok(busyHub.spotCoach.quietUntil >= beforeBusy + 2400);
  assert.equal(phone.sent.filter((m) => m.type === "fields").length, 2);
  assert.equal(phone.sent.filter((m) => m.type === "coach").length, 0);
  assert.equal(hud.sent.length, 0);

  const verdictHub = new Hub("hub-verdict-quiet");
  const vPhone = mockSocket();
  const vHud = mockSocket();
  verdictHub.clients.add(vPhone.ws);
  verdictHub.huds.add(vHud.ws);
  verdictHub.live = { active: true, busy: false, handleEvent() {}, stop() {} };

  feedFields(verdictHub, mkFrame(0.85), [box("product", 0.85), box("strength", 0.9)]);
  feedFields(verdictHub, mkFrame(0.85), [box("product", 0.85), box("strength", 0.9)]);
  feedFields(verdictHub, mkFrame(0.85), [box("product", 0.85)]);

  const beforeVerdict = Date.now();
  verdictHub.emit({ type: "verdict", verdict: sampleVerdict() });
  const afterVerdict = Date.now();

  assert.ok(verdictHub.spotCoach.quietUntil >= beforeVerdict + 5900);
  assert.ok(verdictHub.spotCoach.quietUntil <= afterVerdict + 6100);
  assert.equal(verdictHub.lastCoach, undefined);

  vPhone.sent.length = 0;
  vHud.sent.length = 0;
  feedFields(verdictHub, mkFrame(0.85), [box("product", 0.85)]);
  feedFields(verdictHub, mkFrame(0.85), [box("strength", 0.9, [400, 4, 500, 200])]);
  feedFields(verdictHub, mkFrame(0.85), [box("strength", 0.9, [400, 4, 500, 200])]);
  assert.equal(vPhone.sent.filter((m) => m.type === "coach").length, 0);
  assert.equal(vHud.sent.filter((m) => m.type === "coach").length, 0);
});

test("FieldSpotter fields go to phone clients ONLY while detector coach (say: true) fans out to phone, /hud-ws, and /hud-ws?role=stage", async () => {
  await ensureServer();
  const sessionId = "spot-fanout-1";
  const phone = connectWs(`/live?session=${sessionId}`);
  await phone.opened;
  await wait();

  const hub = getHub(sessionId)!;
  assert.ok(hub);
  hub.spec.onFrame = () => {};
  hub.spot.maybe = () => {};
  hub.features.add("sonar");
  hub.live = { active: true, busy: false, handleEvent() {}, stop() {} };
  markLatest(hub);
  hub.addFrame(mkFrame(0.8, Date.now(), "glasses"));

  const hudExplicit = connectWs(`/hud-ws?session=${sessionId}`);
  const hudFloating = connectWs("/hud-ws");
  const stageExplicit = connectWs(`/hud-ws?role=stage&session=${sessionId}`);
  const stageFloating = connectWs("/hud-ws?role=stage");
  await Promise.all([hudExplicit.opened, hudFloating.opened, stageExplicit.opened, stageFloating.opened]);
  await wait(270);

  phone.msgs.length = 0;
  hudExplicit.msgs.length = 0;
  hudFloating.msgs.length = 0;
  stageExplicit.msgs.length = 0;
  stageFloating.msgs.length = 0;

  const firstBoxes: FieldBox[] = [
    box("product", 0.88, [200, 150, 340, 820]),
    box("strength", 0.9, [420, 6, 520, 210]),
  ];
  const secondBoxes: FieldBox[] = [
    box("product", 0.9, [200, 150, 340, 820]),
    box("strength", 0.92, [420, 4, 520, 205]),
  ];

  feedFields(hub, mkFrame(0.8, Date.now(), "glasses"), firstBoxes);
  feedFields(hub, mkFrame(0.8, Date.now(), "glasses"), secondBoxes);
  await wait();

  const phoneFields = phone.msgs.filter((m) => m.type === "fields");
  assert.equal(phoneFields.length, 2);
  assert.deepEqual(phoneFields[0], { type: "fields", fields: firstBoxes });
  assert.deepEqual(phoneFields[1], { type: "fields", fields: secondBoxes });

  assert.equal(hudExplicit.msgs.some((m) => m.type === "fields"), false);
  assert.equal(hudFloating.msgs.some((m) => m.type === "fields"), false);
  assert.equal(stageExplicit.msgs.some((m) => m.type === "fields"), false);
  assert.equal(stageFloating.msgs.some((m) => m.type === "fields"), false);

  assert.equal(hudExplicit.msgs.some((m) => m.type === "readiness"), false);
  assert.equal(hudFloating.msgs.some((m) => m.type === "readiness"), false);
  assert.deepEqual(phone.msgs.filter((m) => m.type === "readiness"), [{ type: "readiness", value: 0.81 }]);
  assert.deepEqual(stageExplicit.msgs.filter((m) => m.type === "readiness"), [{ type: "readiness", value: 0.81 }]);
  assert.deepEqual(stageFloating.msgs.filter((m) => m.type === "readiness"), [{ type: "readiness", value: 0.81 }]);

  const expectedCoach: ServerMsg = {
    type: "coach",
    cue: "hold_still",
    text: "Move it a little to the right. The dose is at the edge.",
    say: true,
  };
  assert.deepEqual(phone.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
  assert.deepEqual(hudExplicit.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
  assert.deepEqual(hudFloating.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
  assert.deepEqual(stageExplicit.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
  assert.deepEqual(stageFloating.msgs.filter((m) => m.type === "coach"), [expectedCoach]);

  const lateHud = connectWs(`/hud-ws?session=${sessionId}`);
  await lateHud.opened;
  await wait();
  assert.deepEqual(lateHud.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
  assert.equal(lateHud.msgs.some((m) => m.type === "fields"), false);

  hub.live = undefined;
});

test("Hub.dropFrames clears ring, lastCode, lastFields, and resets spotCoach state", () => {
  const hub = new Hub("drop-frames-spotter");
  const phone = mockSocket();
  hub.clients.add(phone.ws);
  hub.features.add("sonar");
  hub.features.add("datamatrix");
  hub.live = { active: true, busy: false, handleEvent() {}, stop() {} };

  hub.ring.push(mkFrame(0.85, Date.now(), "glasses"));
  hub.setCode({ raw: "01064100000000121727080010ABC", gtin: "06410000000012", expiry: "2027-08" });
  feedFields(hub, mkFrame(0.85), [box("product", 0.85), box("strength", 0.9, [400, 4, 500, 200])]);
  assert.equal(hub.ring.length, 1);
  assert.ok(hub.freshCode());
  assert.ok(hub.lastFields);

  hub.dropFrames();
  assert.equal(hub.ring.length, 0);
  assert.equal(hub.freshCode(), undefined);
  assert.equal(hub.lastFields, undefined);

  phone.sent.length = 0;
  const singleEdgeCue = hub.spotCoach.push([box("strength", 0.9, [400, 4, 500, 200])], 0.85, Date.now() + 20_000);
  assert.equal(singleEdgeCue, undefined);

  const verifyClearedReadiness = new Hub("drop-frames-readiness");
  const rPhone = mockSocket();
  verifyClearedReadiness.clients.add(rPhone.ws);
  verifyClearedReadiness.features.add("sonar");
  verifyClearedReadiness.live = { active: true, handleEvent() {}, stop() {} };
  verifyClearedReadiness.lastFields = { fields: [box("strength", 0.95)], ts: Date.now() };
  verifyClearedReadiness.dropFrames();
  verifyClearedReadiness.updateReadiness(0.8);
  assert.deepEqual(rPhone.sent, [{ type: "readiness", value: 0.48 }]);
});

test("POST /ingest/frame glasses loop drives SpotThrottle and real ONNX detect() on synthetic and covered-dose JPEGs", async (t) => {
  const modelPath = path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");
  const openFixture = path.join(REPO_ROOT, "server", "fixtures", "amlodipine.jpg");
  const coveredFixture = path.join(REPO_ROOT, "server", "fixtures", "amlodipine_covered.jpg");
  if (![modelPath, openFixture, coveredFixture].every((p) => fs.existsSync(p))) {
    return t.skip("fieldspotter.onnx or fixtures missing");
  }

  assert.equal(spotterAvailable(), true);
  process.env.SPOTTER = "0";
  assert.equal(spotterAvailable(), false);
  process.env.SPOTTER = "1";

  const width = 96;
  const height = 64;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const shade = (i * 17) % 255;
    rgba[i * 4] = shade;
    rgba[i * 4 + 1] = 240 - (shade >> 1);
    rgba[i * 4 + 2] = shade >> 2;
    rgba[i * 4 + 3] = 255;
  }
  const synthJpeg = Buffer.from(jpegJs.encode({ data: rgba, width, height }, 85).data);

  let synthDet;
  try {
    synthDet = await detect(synthJpeg);
  } catch (e) {
    return t.skip(`onnxruntime unavailable: ${(e as Error).message.slice(0, 80)}`);
  }
  assert.equal(synthDet.w, width);
  assert.equal(synthDet.h, height);
  assert.ok(Array.isArray(synthDet.fields));
  for (const f of synthDet.fields) {
    assert.ok(f.score >= SPOT.conf && f.score <= 1);
    assert.ok(f.box.every((coord) => coord >= 0 && coord <= 1000));
  }

  const throttle = new SpotThrottle();
  let callbacks = 0;
  const synthB64 = synthJpeg.toString("base64");
  throttle.maybe(synthB64, () => {
    callbacks++;
  });
  throttle.maybe(synthB64, () => {
    callbacks++;
  });
  await waitFor(() => callbacks === 1 && !(throttle as unknown as { busy: boolean }).busy);
  assert.equal(throttle.runs, 1);
  (throttle as unknown as { lastAt: number }).lastAt = Date.now();
  throttle.maybe(synthB64, () => {
    callbacks++;
  });
  assert.equal((throttle as unknown as { busy: boolean }).busy, false);
  assert.equal(throttle.runs, 1);
  assert.equal(callbacks, 1);

  await ensureServer();
  const sessionId = "spot-ingest-e2e";
  const phone = connectWs(`/live?session=${sessionId}`);
  const hud = connectWs(`/hud-ws?session=${sessionId}`);
  await Promise.all([phone.opened, hud.opened]);
  await wait();

  const hub = getHub(sessionId)!;
  assert.ok(hub);
  hub.spec.onFrame = () => {};
  hub.features.add("sonar");
  const forwardedToLive: string[] = [];
  hub.live = {
    active: true,
    busy: false,
    handleEvent() {},
    stop() {},
    frame(b64: string) {
      forwardedToLive.push(b64);
    },
  } as unknown as typeof hub.live;
  markLatest(hub);

  const postIngest = (jpeg: Buffer, sharp: number) =>
    fetch(`${httpBase}/ingest/frame?session=${sessionId}&sharpness=${sharp}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(jpeg),
    });

  const droppedRes = await postIngest(synthJpeg, 0.8);
  assert.equal(droppedRes.status, 204);
  assert.equal(hub.ring.length, 0);
  assert.equal(forwardedToLive.length, 0);

  hub.source = "glasses";
  phone.msgs.length = 0;
  hud.msgs.length = 0;

  const openJpeg = fs.readFileSync(openFixture);
  const coveredJpeg = fs.readFileSync(coveredFixture);

  const sendStep = async (jpeg: Buffer, sharp: number, expectedFieldsCount: number) => {
    const res = await postIngest(jpeg, sharp);
    assert.equal(res.status, 204);
    await waitFor(() => phone.msgs.filter((m) => m.type === "fields").length === expectedFieldsCount);
  };

  await sendStep(openJpeg, 0.84, 1);
  await wait(SPOT.minGapMs + 30);
  await sendStep(openJpeg, 0.84, 2);
  await wait(SPOT.minGapMs + 30);
  await sendStep(coveredJpeg, 0.82, 3);
  await wait(SPOT.minGapMs + 30);
  await sendStep(coveredJpeg, 0.8, 4);
  await wait();

  assert.equal(hub.ring.length, 4);
  assert.equal(forwardedToLive.length, 4);
  assert.equal(hub.spot.runs, 4);

  const expectedCoveredCoach: ServerMsg = {
    type: "coach",
    cue: "hold_still",
    text: "Something is covering the dose. Move your thumb.",
    say: true,
  };
  assert.deepEqual(phone.msgs.filter((m) => m.type === "coach"), [expectedCoveredCoach]);
  assert.deepEqual(hud.msgs.filter((m) => m.type === "coach"), [expectedCoveredCoach]);
  assert.equal(hud.msgs.some((m) => m.type === "fields"), false);

  const readinessValues = phone.msgs
    .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
    .map((m) => m.value);
  assert.ok(readinessValues.some((v) => v >= 0.7), `expected boosted readiness >= 0.7, got ${readinessValues.join(",")}`);
  assert.ok(readinessValues[readinessValues.length - 1] <= 0.55, `expected capped readiness <= 0.55 on covered dose, got ${readinessValues.join(",")}`);

  hub.live = undefined;
});
