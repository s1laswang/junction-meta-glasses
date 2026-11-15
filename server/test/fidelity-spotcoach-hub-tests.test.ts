import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type { DeviceState, LabelRead, ServerMsg, Verdict } from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { speechFidelity, strengthsIn, wordsToNumber, type Expected } from "../src/fidelity.ts";
import {
  Hub,
  addHud,
  addStage,
  getOrCreateHub,
  hubStats,
  latestHub,
  markLatest,
  setDevice,
  type LiveLike,
  type StageMetrics,
} from "../src/hub.ts";
import { COACH, SpotCoach } from "../src/spotcoach.ts";
import {
  SPOT,
  SPOT_LABELS,
  SpotThrottle,
  decode,
  letterbox,
  spotterAvailable,
  type FieldBox,
} from "../src/spotter.ts";
import type { Frame, readLabel } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

type WireMsg = ServerMsg | StageMetrics;

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: WireMsg[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data) as WireMsg);
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }

  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function makeRead(readability = 0.92, kind: LabelRead["kind"] = "medication"): LabelRead {
  const nf = { value: null, confidence: 0 };
  return {
    kind,
    product: { value: kind === "unreadable" ? null : "Amlodipin Orion", confidence: kind === "unreadable" ? 0 : 0.95 },
    ingredient: { value: kind === "unreadable" ? null : "amlodipine", confidence: kind === "unreadable" ? 0 : 0.95 },
    strength: { value: kind === "unreadable" ? null : "5 mg", confidence: kind === "unreadable" ? 0 : 0.95 },
    dosing: nf,
    expiry: { value: kind === "unreadable" ? null : "2027-08", confidence: kind === "unreadable" ? 0 : 0.9 },
    allergens: { value: null, confidence: 0 },
    barcode: nf,
    readability,
  };
}

function makeVerdict(headline = "Amlodipine 5 mg match"): Verdict {
  return {
    level: "match",
    headline,
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: makeRead(),
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
  };
}

function makeFrame(ts: number, sharpness = 0.82, bytes = 20480, source: "phone" | "glasses" = "phone"): Frame {
  return {
    data: Buffer.alloc(128, 9).toString("base64"),
    sharpness,
    ts,
    bytes,
    source,
  };
}

function fieldBox(
  label: FieldBox["label"],
  score: number,
  box: [number, number, number, number] = [380, 260, 480, 740],
): FieldBox {
  return { label, box, score };
}

function seedSpecCache(hub: Hub, read: LabelRead, frameTs: number, sharpness = 0.85, bytes = 20480) {
  (hub.spec as unknown as { cache: unknown }).cache = {
    read,
    model: "gemini-3.8-flash",
    frameTs,
    sharpness,
    bytes,
    at: frameTs,
  };
}

function stubSpecReader(hub: Hub, fn: typeof readLabel) {
  (hub.spec as unknown as { reader: typeof readLabel }).reader = fn;
}

function callOnFields(hub: Hub, frame: Frame, fields: FieldBox[]) {
  (hub as unknown as { onFields(f: Frame, boxes: FieldBox[]): void }).onFields(frame, fields);
}

function readinessValues(sock: FakeSocket): number[] {
  return sock.sent.filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness").map((m) => m.value);
}

test("Hub /stage and HUD lifecycle: orphan device fan-out, floatingStages, markLatest, pushMetrics, and hudChanged stage exclusion", () => {
  assert.equal(latestHub(), undefined);
  assert.equal(hubStats().latest, null);
  assert.equal(hubStats().floatingHuds, 0);
  assert.equal(hubStats().floatingStages, 0);

  const floatingHud1 = new FakeSocket();
  const floatingStage1 = new FakeSocket();
  addHud(floatingHud1.asWs());
  addStage(floatingStage1.asWs());
  assert.equal(hubStats().floatingHuds, 1);
  assert.equal(hubStats().floatingStages, 1);

  const orphan: DeviceState = {
    connected: true,
    worn: null,
    battery: 81,
    streaming: true,
    source: "glasses",
  };
  setDevice(orphan);
  assert.deepEqual(floatingHud1.sent, [{ type: "device", device: orphan }]);
  assert.deepEqual(floatingStage1.sent, [{ type: "device", device: orphan }]);

  const floatingHud2 = new FakeSocket();
  const floatingStage2 = new FakeSocket();
  addHud(floatingHud2.asWs());
  addStage(floatingStage2.asWs());
  assert.deepEqual(floatingHud2.sent, [{ type: "device", device: orphan }]);
  assert.deepEqual(floatingStage2.sent, [{ type: "device", device: orphan }]);
  assert.equal(hubStats().floatingHuds, 2);
  assert.equal(hubStats().floatingStages, 2);

  floatingHud1.disconnect();
  floatingHud2.disconnect();
  assert.equal(hubStats().floatingHuds, 0);
  assert.equal(hubStats().floatingStages, 2);

  const hubA = getOrCreateHub("fid-spot-stage-a");
  const phoneA = new FakeSocket();
  const pinnedStageA = new FakeSocket();
  hubA.clients.add(phoneA.asWs());
  addStage(pinnedStageA.asWs(), "fid-spot-stage-a");

  assert.equal(phoneA.sent.length, 0);
  assert.equal(hubA.metrics().hud, false);
  assert.equal(pinnedStageA.sent.length, 1);
  assert.equal(pinnedStageA.sent[0]?.type, "metrics");

  hubA.emit({ type: "status", live: "open" }, { clients: false, hud: false });
  hubA.emit({ type: "verdict", verdict: makeVerdict("Stage A match") }, { clients: false, hud: false });

  floatingStage1.sent = [];
  floatingStage2.sent = [];
  phoneA.sent = [];
  markLatest(hubA);

  assert.equal(latestHub(), hubA);
  assert.deepEqual(hubA.device, orphan);
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: false }]);
  assert.deepEqual(
    floatingStage1.sent.map((m) => m.type),
    ["status", "device", "verdict", "metrics"],
  );
  assert.deepEqual(
    floatingStage2.sent.map((m) => m.type),
    ["status", "device", "verdict", "metrics"],
  );

  phoneA.sent = [];
  const floatingHud3 = new FakeSocket();
  addHud(floatingHud3.asWs());
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: true }]);
  assert.equal(hubA.metrics().hud, true);

  pinnedStageA.sent = [];
  floatingStage1.sent = [];
  floatingStage2.sent = [];
  hubA.spec.hits = 2;
  hubA.pushMetrics();
  hubA.pushMetrics();
  assert.equal(pinnedStageA.sent.length, 1);
  assert.equal(floatingStage1.sent.length, 1);
  assert.equal(floatingStage2.sent.length, 1);

  const lateStageA = new FakeSocket();
  addStage(lateStageA.asWs(), "fid-spot-stage-a");
  assert.equal(lateStageA.sent.some((m) => m.type === "metrics"), true);
  assert.equal(pinnedStageA.sent.length, 1);

  phoneA.sent = [];
  floatingHud3.disconnect();
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: false }]);
  assert.equal(hubStats().floatingStages, 2);

  pinnedStageA.disconnect();
  lateStageA.disconnect();
  floatingStage1.disconnect();
  floatingStage2.disconnect();
  hubA.clients.delete(phoneA.asWs());
  assert.equal(hubStats().floatingStages, 0);
  assert.equal(hubStats().floatingHuds, 0);
});

test("fidelity.ts wordsToNumber and strengthsIn normalize spoken phrases, decimal commas, and canonical units", () => {
  assert.equal(wordsToNumber([]), undefined);
  assert.equal(wordsToNumber(["and"]), undefined);
  assert.equal(wordsToNumber(["two", "point", "five"]), 2.5);
  assert.equal(wordsToNumber(["zero", "point", "zero", "five"]), 0.05);
  assert.equal(wordsToNumber(["five", "hundred"]), 500);
  assert.equal(wordsToNumber(["a", "hundred", "and", "twenty", "five"]), 125);
  assert.equal(wordsToNumber(["one", "thousand"]), 1000);
  assert.equal(wordsToNumber(["two", "thousand", "and", "fifty"]), 2050);
  assert.equal(wordsToNumber(["twenty", "five"]), 25);
  assert.equal(wordsToNumber(["point", "five"]), undefined);
  assert.equal(wordsToNumber(["two", "point"]), undefined);
  assert.equal(wordsToNumber(["two", "point", "ten"]), undefined);
  assert.equal(wordsToNumber(["two", "point", "twenty"]), undefined);
  assert.equal(wordsToNumber(["five", "capsules"]), undefined);

  assert.deepEqual([...strengthsIn("Take 2,5 mg or two point five milligrams")], ["2.5 mg"]);
  assert.deepEqual([...strengthsIn("five hundred milligrammes and twenty-five mg")].sort(), ["25 mg", "500 mg"]);
  assert.deepEqual([...strengthsIn("100 mcg, 100 ug, and one hundred micrograms")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("5 g and five grams")], ["5 g"]);
  assert.deepEqual([...strengthsIn("10 ml, 10 milliliters, and ten millilitres")], ["10 ml"]);
  assert.deepEqual([...strengthsIn("one thousand units and 1000 IU")], ["1000 iu"]);
  assert.deepEqual([...strengthsIn("0,05% cream and one percent gel")].sort(), ["0.05 %", "1 %"]);
  assert.deepEqual([...strengthsIn("5 mgx 10 grand at 08:30")], []);
});

test("fidelity.ts speechFidelity enforces strength, caution, affirmative opener, medicine name, FI/SV lead, silence, and paraphrase rules", () => {
  const match25: Expected = {
    speech: "Yes, Bisoprolol 2,5 mg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["Bisoprolol"],
  };
  assert.deepEqual(
    speechFidelity(match25, "Yes, bisoprolol two point five milligrams, your morning tablet. You have not taken it today."),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(speechFidelity(match25, ""), { ok: false, reasons: ["not_spoken"] });
  assert.deepEqual(speechFidelity(match25, "   \n\t  "), { ok: false, reasons: ["not_spoken"] });

  const missingStrength = speechFidelity(match25, "Yes, Bisoprolol, your morning pill.");
  assert.equal(missingStrength.ok, false);
  assert.deepEqual(missingStrength.reasons, ["strength_missing"]);

  const swappedStrength = speechFidelity(match25, "Yes, Bisoprolol five milligrams, your morning pill.");
  assert.equal(swappedStrength.ok, false);
  assert.deepEqual(swappedStrength.reasons.sort(), ["strength_invented", "strength_missing"]);

  const missingName = speechFidelity(match25, "Yes, two point five milligrams, your morning pill.");
  assert.equal(missingName.ok, false);
  assert.deepEqual(missingName.reasons, ["name_missing"]);

  const unitVariants: Array<[string, string]> = [
    ["Yes, Levothyroxine 100 mcg.", "Yes, levothyroxine one hundred micrograms."],
    ["Yes, Levothyroxine 100 ug.", "Yes, levothyroxine 100 mcg."],
    ["Yes, Metformin 500 mg.", "Yes, metformin five hundred milligrams."],
    ["Yes, Vitamin D 1000 IU.", "Yes, vitamin D one thousand units."],
    ["Yes, Macrogol 10 g.", "Yes, macrogol ten grams."],
    ["Yes, Lactulose 15 ml.", "Yes, lactulose fifteen millilitres."],
    ["Yes, Hydrocortisone 1%.", "Yes, hydrocortisone one percent."],
  ];
  for (const [wantSpeech, saidSpeech] of unitVariants) {
    const res = speechFidelity({ speech: wantSpeech, level: "match" }, saidSpeech);
    assert.equal(res.ok, true, `expected ${saidSpeech} to match ${wantSpeech}`);
  }

  const warnExp: Expected = {
    speech: "Warning: this is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    names: ["Ibuprofen"],
  };
  assert.deepEqual(
    speechFidelity(warnExp, "This is ibuprofen four hundred milligrams, and it is not on your list so avoid taking it."),
    { ok: true, reasons: [] },
  );

  for (const badOpener of [
    "Yes, this is Ibuprofen 400 mg, avoid NSAIDs.",
    "Yeah, Ibuprofen 400 mg is not on your list.",
    "Correct, Ibuprofen 400 mg, avoid NSAIDs.",
    "That's right, Ibuprofen 400 mg is not on your list.",
  ]) {
    const r = speechFidelity(warnExp, badOpener);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("affirmative_on_caution"));
  }

  const droppedCaution = speechFidelity(warnExp, "This is Ibuprofen four hundred milligrams from your cabinet.");
  assert.equal(droppedCaution.ok, false);
  assert.deepEqual(droppedCaution.reasons, ["caution_dropped"]);

  const unsureExp: Expected = {
    speech: "It looks like Amlodipine, but I can't read the strength confidently. Ask a pharmacist.",
    level: "unsure",
    names: ["Amlodipine"],
  };
  const inventedOnUnsure = speechFidelity(unsureExp, "Yep, Amlodipine 5 mg.");
  assert.equal(inventedOnUnsure.ok, false);
  assert.deepEqual(inventedOnUnsure.reasons.sort(), ["affirmative_on_caution", "caution_dropped", "strength_invented"]);

  const fiMatch: Expected = {
    speech: "Oikea pakkaus. Yes, Amlodipine 5 mg, your evening pill.",
    level: "match",
    lead: "Oikea pakkaus.",
    names: ["Amlodipine"],
  };
  assert.deepEqual(
    speechFidelity(fiMatch, "Oikea pakkaus. Amlodipine viisi milligrammaa, iltalaakkeesi.", "fi"),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    speechFidelity(fiMatch, "Amlodipine 5 mg, iltalaakkeesi.", "fi"),
    { ok: false, reasons: ["lead_missing"] },
  );
  assert.deepEqual(
    speechFidelity(fiMatch, "Oikea pakkaus. Amlodipine 10 mg.", "fi"),
    { ok: false, reasons: ["strength_missing", "strength_invented"] },
  );

  const svWarn: Expected = {
    speech: "Varning. Ibuprofen 400 mg.",
    level: "warning",
    lead: "Varning.",
    names: ["Ibuprofen"],
  };
  assert.deepEqual(
    speechFidelity(svWarn, "Ja, Ibuprofen 400 mg.", "sv"),
    { ok: false, reasons: ["affirmative_on_caution", "lead_missing"] },
  );
  const svMatch: Expected = {
    speech: "Ratt forpackning. Amlodipine 5 mg.",
    level: "match",
    lead: "Rätt förpackning.",
    names: ["Amlodipine"],
  };
  assert.deepEqual(
    speechFidelity(svMatch, "Rätt förpackning! Amlodipine 5 mg.", "sv-SE"),
    { ok: true, reasons: [] },
  );
});

test("spotter.ts letterbox preserves aspect ratio and grey 114/255 padding across portrait, landscape, and 1x1 inputs", () => {
  const grey = 114 / 255;

  const landW = 8, landH = 4, size = 8;
  const landRgba = new Uint8Array(landW * landH * 4);
  for (let i = 0; i < landW * landH; i++) {
    landRgba[i * 4] = 255;
    landRgba[i * 4 + 1] = 51;
    landRgba[i * 4 + 2] = 0;
    landRgba[i * 4 + 3] = 12;
  }
  const lbLand = letterbox(landRgba, landW, landH, size);
  assert.equal(lbLand.scale, 1);
  assert.equal(lbLand.padX, 0);
  assert.equal(lbLand.padY, 2);
  assert.equal(lbLand.input.length, 3 * 64);
  for (let x = 0; x < size; x++) {
    assert.ok(Math.abs(lbLand.input[x] - grey) < 1e-6);
    assert.ok(Math.abs(lbLand.input[7 * size + x] - grey) < 1e-6);
  }
  const midIdx = 2 * size + 3;
  assert.equal(lbLand.input[midIdx], 1);
  assert.ok(Math.abs(lbLand.input[64 + midIdx] - 51 / 255) < 1e-6);
  assert.equal(lbLand.input[128 + midIdx], 0);

  const portW = 2, portH = 4;
  const portRgba = new Uint8ClampedArray(portW * portH * 4);
  for (let i = 0; i < portW * portH; i++) {
    portRgba[i * 4] = 0;
    portRgba[i * 4 + 1] = 204;
    portRgba[i * 4 + 2] = 255;
    portRgba[i * 4 + 3] = 255;
  }
  const lbPort = letterbox(portRgba, portW, portH, size);
  assert.equal(lbPort.scale, 2);
  assert.equal(lbPort.padX, 2);
  assert.equal(lbPort.padY, 0);
  for (let y = 0; y < size; y++) {
    assert.ok(Math.abs(lbPort.input[y * size] - grey) < 1e-6);
    assert.ok(Math.abs(lbPort.input[y * size + 1] - grey) < 1e-6);
    assert.ok(Math.abs(lbPort.input[y * size + 6] - grey) < 1e-6);
    assert.ok(Math.abs(lbPort.input[y * size + 7] - grey) < 1e-6);
    const active = y * size + 2;
    assert.equal(lbPort.input[active], 0);
    assert.ok(Math.abs(lbPort.input[64 + active] - 204 / 255) < 1e-6);
    assert.equal(lbPort.input[128 + active], 1);
  }

  const onePx = new Uint8Array([102, 153, 204, 0]);
  const lbOne = letterbox(onePx, 1, 1, 4);
  assert.equal(lbOne.scale, 4);
  assert.equal(lbOne.padX, 0);
  assert.equal(lbOne.padY, 0);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(lbOne.input[i] - 102 / 255) < 1e-6);
    assert.ok(Math.abs(lbOne.input[16 + i] - 153 / 255) < 1e-6);
    assert.ok(Math.abs(lbOne.input[32 + i] - 204 / 255) < 1e-6);
  }
});

test("spotter.ts decode enforces class argmax, 0..1000 clamping, per-class IoU NMS, confidence filtering, and 12-box cap", () => {
  assert.deepEqual(SPOT_LABELS, ["product", "strength", "expiry", "allergens"]);

  const anchors = 6;
  const out = new Float32Array((4 + SPOT_LABELS.length) * anchors);
  const put = (i: number, cx: number, cy: number, bw: number, bh: number, scores: [number, number, number, number]) => {
    out[i] = cx;
    out[anchors + i] = cy;
    out[2 * anchors + i] = bw;
    out[3 * anchors + i] = bh;
    for (let c = 0; c < 4; c++) out[(4 + c) * anchors + i] = scores[c];
  };

  put(0, 320, 320, 120, 60, [0.2, 0.91, 0.1, 0.05]);
  put(1, 322, 321, 120, 60, [0.1, 0.75, 0.1, 0.05]);
  put(2, 320, 320, 120, 60, [0.88, 0.2, 0.1, 0.05]);
  put(3, 5, 10, 80, 90, [0.05, 0.05, 0.62, 0.1]);
  put(4, 638, 635, 90, 80, [0.05, 0.05, 0.1, 0.4]);
  put(5, 100, 100, 50, 50, [0.39, 0.38, 0.2, 0.1]);

  const boxes = decode(out, anchors, { scale: 1, padX: 0, padY: 0 }, 640, 640);
  assert.equal(boxes.length, 4);
  assert.deepEqual(
    boxes.map((b) => [b.label, b.score]),
    [
      ["strength", 0.91],
      ["product", 0.88],
      ["expiry", 0.62],
      ["allergens", 0.4],
    ],
  );
  const clampedTopLeft = boxes.find((b) => b.label === "expiry")!;
  const clampedBottomRight = boxes.find((b) => b.label === "allergens")!;
  assert.equal(clampedTopLeft.box[0], 0);
  assert.equal(clampedTopLeft.box[1], 0);
  assert.equal(clampedBottomRight.box[2], 1000);
  assert.equal(clampedBottomRight.box[3], 1000);

  const manyAnchors = 16;
  const manyOut = new Float32Array(8 * manyAnchors);
  for (let i = 0; i < manyAnchors; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    manyOut[i] = 60 + col * 150;
    manyOut[manyAnchors + i] = 60 + row * 150;
    manyOut[2 * manyAnchors + i] = 40;
    manyOut[3 * manyAnchors + i] = 40;
    manyOut[(4 + (i % 4)) * manyAnchors + i] = 0.5 + i * 0.03;
  }
  const capped = decode(manyOut, manyAnchors, { scale: 1, padX: 0, padY: 0 }, 640, 640);
  assert.equal(capped.length, 12);
  for (let i = 1; i < capped.length; i++) {
    assert.ok(capped[i - 1].score >= capped[i].score);
  }
});

test("spotter.ts spotterAvailable and SpotThrottle minGapMs, single-flight guard, and error backoff", async () => {
  const prevSpotter = process.env.SPOTTER;
  const modelExists = fs.existsSync(path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx"));
  try {
    delete process.env.SPOTTER;
    assert.equal(spotterAvailable(), false);
    process.env.SPOTTER = "0";
    assert.equal(spotterAvailable(), false);
    process.env.SPOTTER = "1";
    assert.equal(spotterAvailable(), modelExists);
  } finally {
    if (prevSpotter === undefined) delete process.env.SPOTTER;
    else process.env.SPOTTER = prevSpotter;
  }

  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    const throttle = new SpotThrottle();
    let callbacks = 0;
    const badB64 = Buffer.from("not-a-valid-jpeg").toString("base64");
    throttle.maybe(badB64, () => {
      callbacks++;
    });
    assert.equal((throttle as unknown as { busy: boolean }).busy, true);

    now += 500;
    throttle.maybe(badB64, () => {
      callbacks++;
    });

    const deadline = realNow() + 2000;
    while ((throttle as unknown as { busy: boolean }).busy && realNow() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal((throttle as unknown as { busy: boolean }).busy, false);
    assert.equal(callbacks, 0);
    assert.equal(throttle.runs, 0);
    assert.ok((throttle as unknown as { offUntil: number }).offUntil >= now + SPOT.backoffMs);

    now += SPOT.backoffMs - 100;
    throttle.maybe(badB64, () => {
      callbacks++;
    });
    assert.equal((throttle as unknown as { busy: boolean }).busy, false);
  } finally {
    Date.now = realNow;
  }
});

test("SpotCoach state machine: covered, other_side, 4-direction edge cues, quietUntil, minGapMs, 8s same-kind cooldown, and reset()", () => {
  const coach = new SpotCoach();
  let t = 20_000;

  assert.equal(coach.push([fieldBox("strength", 0.85, [300, 5, 420, 220])], 0.8, (t += 400)), undefined);
  const leftCut = coach.push([fieldBox("strength", 0.85, [300, 5, 420, 220])], 0.8, (t += 400));
  assert.deepEqual(leftCut, {
    kind: "edge",
    cue: "hold_still",
    text: "Move it a little to the right. The dose is at the edge.",
  });

  coach.push([fieldBox("strength", 0.85, [300, 800, 420, 992])], 0.8, (t += 3500));
  assert.equal(coach.push([fieldBox("strength", 0.85, [300, 800, 420, 992])], 0.8, (t += 400)), undefined);

  coach.push([fieldBox("strength", 0.85, [300, 300, 420, 700])], 0.8, (t += 200));
  t = 20_800 + COACH.sameKindMs;
  assert.equal(coach.push([fieldBox("strength", 0.85, [300, 800, 420, 992])], 0.8, t), undefined);
  const rightCut = coach.push([fieldBox("strength", 0.85, [300, 800, 420, 992])], 0.8, (t += 400));
  assert.deepEqual(rightCut, {
    kind: "edge",
    cue: "hold_still",
    text: "Move it a little to the left. The dose is at the edge.",
  });

  coach.push([fieldBox("strength", 0.85, [300, 300, 420, 700])], 0.8, (t += 200));
  t += COACH.sameKindMs;
  assert.equal(coach.push([fieldBox("strength", 0.85, [10, 250, 120, 650])], 0.8, t), undefined);
  const topCut = coach.push([fieldBox("strength", 0.85, [10, 250, 120, 650])], 0.8, (t += 400));
  assert.deepEqual(topCut, {
    kind: "edge",
    cue: "hold_still",
    text: "Move it a little down. The dose is at the edge.",
  });

  coach.push([fieldBox("strength", 0.85, [300, 300, 420, 700])], 0.8, (t += 200));
  t += COACH.sameKindMs;
  assert.equal(coach.push([fieldBox("strength", 0.85, [860, 250, 995, 650])], 0.8, t), undefined);
  const bottomCut = coach.push([fieldBox("strength", 0.85, [860, 250, 995, 650])], 0.8, (t += 400));
  assert.deepEqual(bottomCut, {
    kind: "edge",
    cue: "hold_still",
    text: "Move it a little up. The dose is at the edge.",
  });

  t += 3500;
  assert.equal(coach.push([fieldBox("product", 0.8), fieldBox("strength", 0.8)], 0.85, t), undefined);
  assert.equal(coach.push([fieldBox("product", 0.8), fieldBox("strength", 0.8)], 0.85, (t += 300)), undefined);
  assert.equal(coach.push([fieldBox("product", 0.8)], 0.82, (t += 300)), undefined);
  const covered = coach.push([fieldBox("product", 0.8)], 0.8, (t += 300));
  assert.deepEqual(covered, {
    kind: "covered",
    cue: "hold_still",
    text: "Something is covering the dose. Move your thumb.",
  });

  t += 4000;
  assert.equal(coach.push([fieldBox("product", 0.75)], 0.8, t), undefined);
  assert.equal(coach.push([fieldBox("product", 0.75)], 0.8, t + 2999), undefined);
  const otherSide = coach.push([fieldBox("product", 0.75)], 0.8, t + 3000);
  assert.deepEqual(otherSide, {
    kind: "other_side",
    cue: "other_side",
    text: "Turn the box. The dose is on another side.",
  });

  const resetCoach = new SpotCoach();
  let rt = 80_000;
  resetCoach.push([fieldBox("product", 0.85), fieldBox("strength", 0.85)], 0.85, rt);
  resetCoach.push([fieldBox("product", 0.85), fieldBox("strength", 0.85)], 0.85, (rt += 300));
  resetCoach.reset();
  assert.equal(resetCoach.push([fieldBox("product", 0.85)], 0.85, (rt += 300)), undefined);
  assert.equal(resetCoach.push([fieldBox("product", 0.85)], 0.85, (rt += 300)), undefined);

  resetCoach.reset();
  resetCoach.quietUntil = rt + 5000;
  resetCoach.push([fieldBox("product", 0.85)], 0.85, rt);
  assert.equal(resetCoach.push([fieldBox("product", 0.85)], 0.85, rt + 3200), undefined);
});

test("Hub integration: lastFields sonar boost and cap, onFields fan-out, verdict +6s quietUntil, and dropFrames cleanup", async () => {
  const tmpLedger = path.join(os.tmpdir(), `holdup-fid-spot-hub-${process.pid}-${Date.now()}.jsonl`);
  const prevLedger = env.ledgerPath;
  const realNow = Date.now;
  let now = 60_000;
  Date.now = () => now;
  env.ledgerPath = tmpLedger;

  try {
    const hub = new Hub("fid-spot-hub-int");
    const phone = new FakeSocket();
    const hud = new FakeSocket();
    const stage = new FakeSocket();
    hub.clients.add(phone.asWs());
    hub.huds.add(hud.asWs());
    hub.stages.add(stage.asWs());
    hub.features = new Set(["sonar", "datamatrix"]);

    let busy = false;
    const fakeLive: LiveLike = {
      active: true,
      get busy() {
        return busy;
      },
      handleEvent() {},
      stop() {},
    };
    hub.live = fakeLive;
    stubSpecReader(hub, async () => ({
      read: makeRead(0.95, "medication"),
      model: "gemini-3.8-flash",
      latencyMs: 5,
      attempts: 1,
    }));

    hub.updateReadiness(0.9);
    assert.deepEqual(readinessValues(phone), [0.54]);
    assert.deepEqual(readinessValues(stage), [0.54]);
    assert.equal(hud.sent.length, 0);

    phone.sent = [];
    stage.sent = [];
    now = 60_400;
    const f1 = makeFrame(now, 0.9, 20480, "phone");
    const seenBoxes = [fieldBox("product", 0.85), fieldBox("strength", 0.9)];
    callOnFields(hub, f1, seenBoxes);

    assert.deepEqual(hub.lastFields, { fields: seenBoxes, ts: now });
    assert.equal(phone.sent.some((m) => m.type === "fields"), true);
    assert.equal(hud.sent.some((m) => m.type === "fields"), false);
    assert.equal(stage.sent.some((m) => m.type === "fields"), false);
    assert.deepEqual(readinessValues(phone), [0.86]);
    assert.deepEqual(readinessValues(stage), [0.86]);

    now = 60_800;
    callOnFields(hub, makeFrame(now, 0.9), seenBoxes);

    phone.sent = [];
    hud.sent = [];
    stage.sent = [];
    seedSpecCache(hub, makeRead(1.0, "medication"), 61_200);
    now = 61_200;
    callOnFields(hub, makeFrame(now, 0.88), [fieldBox("product", 0.85)]);
    assert.deepEqual(readinessValues(phone), [0.55]);

    phone.sent = [];
    hud.sent = [];
    stage.sent = [];
    now = 61_600;
    callOnFields(hub, makeFrame(now, 0.86), [fieldBox("product", 0.85)]);
    const spokenCoach = phone.sent.find((m): m is Extract<ServerMsg, { type: "coach" }> => m.type === "coach");
    assert.deepEqual(spokenCoach, {
      type: "coach",
      cue: "hold_still",
      text: "Something is covering the dose. Move your thumb.",
      say: true,
    });
    assert.equal(hud.sent.some((m) => m.type === "coach"), true);
    assert.equal(stage.sent.some((m) => m.type === "coach"), true);

    phone.sent = [];
    now = 64_099;
    hub.updateReadiness(0.9);
    assert.deepEqual(readinessValues(phone), []);

    now = 64_100;
    hub.updateReadiness(0.9);
    assert.deepEqual(readinessValues(phone), [0.97]);

    busy = true;
    now = 65_000;
    callOnFields(hub, makeFrame(now, 0.85), seenBoxes);
    assert.ok(hub.spotCoach.quietUntil >= 67_500);
    busy = false;

    now = 70_000;
    callOnFields(hub, makeFrame(now, 0.85), seenBoxes);
    now = 70_400;
    callOnFields(hub, makeFrame(now, 0.85), seenBoxes);

    now = 71_000;
    hub.emit({ type: "verdict", verdict: makeVerdict("Confirmed pill") });
    assert.equal(hub.lastCoach, undefined);
    assert.equal(hub.spotCoach.quietUntil, 77_000);

    phone.sent = [];
    now = 78_000;
    callOnFields(hub, makeFrame(now, 0.85), [fieldBox("product", 0.85)]);
    now = 78_400;
    callOnFields(hub, makeFrame(now, 0.85), [fieldBox("product", 0.85)]);
    assert.equal(phone.sent.some((m) => m.type === "coach"), false);

    now = 80_000;
    hub.addFrame(makeFrame(now, 0.85));
    callOnFields(hub, makeFrame(now, 0.85), seenBoxes);
    now = 80_400;
    callOnFields(hub, makeFrame(now, 0.85), seenBoxes);
    hub.setCode({ raw: "01064100123456781728010010LOT9", gtin: "06410012345678", expiry: "2028-01", batch: "LOT9" });
    assert.equal(hub.ring.length, 1);
    assert.ok(hub.lastFields);
    assert.equal(hub.freshCode()?.gtin, "06410012345678");

    hub.dropFrames();
    assert.equal(hub.ring.length, 0);
    assert.deepEqual(hub.ring.pick(2), []);
    assert.equal(hub.spec.latest(), undefined);
    assert.equal(await hub.spec.get(20), undefined);
    assert.equal(hub.lastCode, undefined);
    assert.equal(hub.freshCode(), undefined);
    assert.equal(hub.lastFields, undefined);

    phone.sent = [];
    now = 90_000;
    callOnFields(hub, makeFrame(now, 0.85), [fieldBox("product", 0.85)]);
    now = 90_400;
    callOnFields(hub, makeFrame(now, 0.85), [fieldBox("product", 0.85)]);
    assert.equal(phone.sent.some((m) => m.type === "coach"), false);
  } finally {
    Date.now = realNow;
    env.ledgerPath = prevLedger;
    fs.rmSync(tmpLedger, { force: true });
  }
});
