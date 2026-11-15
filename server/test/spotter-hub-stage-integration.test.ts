import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import WebSocket from "ws";
import type { LabelRead, ServerMsg, Verdict } from "../../shared/types.ts";
import type { LiveLike } from "../src/hub.ts";
import type { FieldBox } from "../src/spotter.ts";
import type { Frame } from "../src/verify.ts";

const origSpotter = process.env.SPOTTER;
const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
process.env.SPOTTER = "1";
process.env.HOLDUP_QUIET = "1";

const { env, REPO_ROOT, SERVER_DIR } = await import("../src/env.ts");
const { SPOT, SpotThrottle, decode, detect, letterbox, spotterAvailable } = await import("../src/spotter.ts");
const { Hub, getHub, markLatest } = await import("../src/hub.ts");
const { startServer } = await import("../src/index.ts");

const origApiKey = env.apiKey;
const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
  env.apiKey = origApiKey;
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  process.env.SPOTTER = "1";
  process.env.HOLDUP_QUIET = "1";
});

after(() => {
  Date.now = realDateNow;
  env.apiKey = origApiKey;
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  if (origSpotter === undefined) delete process.env.SPOTTER;
  else process.env.SPOTTER = origSpotter;
  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

function makeRgba(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

function setAnchor(
  out: Float32Array,
  anchors: number,
  idx: number,
  cx: number,
  cy: number,
  bw: number,
  bh: number,
  cls: number,
  score: number,
) {
  out[idx] = cx;
  out[anchors + idx] = cy;
  out[2 * anchors + idx] = bw;
  out[3 * anchors + idx] = bh;
  out[(4 + cls) * anchors + idx] = score;
}

function sampleRead(readability = 0.96): LabelRead {
  const nf = { value: null, confidence: 0 };
  return {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: nf,
    expiry: { value: "2027-08", confidence: 0.92 },
    allergens: { value: null, confidence: 0 },
    barcode: nf,
    readability,
  };
}

function sampleVerdict(): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg match",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: sampleRead(),
    matchedMedId: "aml-5",
    reasons: [],
    takenToday: false,
  };
}

function fbox(
  label: FieldBox["label"],
  score: number,
  box: [number, number, number, number] = [350, 250, 480, 750],
): FieldBox {
  return { label, box, score };
}

function mkFrame(sharpness = 0.85, ts = Date.now(), data = "c3ludGhldGlj"): Frame {
  return { data, sharpness, ts, bytes: 2048, source: "phone" };
}

test("letterbox() handles landscape and portrait aspect ratios, grey 114/255 padding, RGB planes, and 1px minimum", () => {
  const grey = 114 / 255;

  const land = letterbox(makeRgba(8, 4, 204, 102, 51, 12), 8, 4, 16);
  assert.equal(land.scale, 2);
  assert.equal(land.padX, 0);
  assert.equal(land.padY, 4);
  const area = 16 * 16;
  assert.equal(land.input.length, 3 * area);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const idx = y * 16 + x;
      if (y < 4 || y >= 12) {
        assert.ok(Math.abs(land.input[idx] - grey) < 1e-6);
        assert.ok(Math.abs(land.input[area + idx] - grey) < 1e-6);
        assert.ok(Math.abs(land.input[2 * area + idx] - grey) < 1e-6);
      } else {
        assert.ok(Math.abs(land.input[idx] - 204 / 255) < 1e-6);
        assert.ok(Math.abs(land.input[area + idx] - 102 / 255) < 1e-6);
        assert.ok(Math.abs(land.input[2 * area + idx] - 51 / 255) < 1e-6);
      }
    }
  }

  const port = letterbox(makeRgba(4, 8, 51, 153, 255, 0), 4, 8, 16);
  assert.equal(port.scale, 2);
  assert.equal(port.padX, 4);
  assert.equal(port.padY, 0);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const idx = y * 16 + x;
      if (x < 4 || x >= 12) {
        assert.ok(Math.abs(port.input[idx] - grey) < 1e-6);
        assert.ok(Math.abs(port.input[area + idx] - grey) < 1e-6);
        assert.ok(Math.abs(port.input[2 * area + idx] - grey) < 1e-6);
      } else {
        assert.ok(Math.abs(port.input[idx] - 51 / 255) < 1e-6);
        assert.ok(Math.abs(port.input[area + idx] - 153 / 255) < 1e-6);
        assert.ok(Math.abs(port.input[2 * area + idx] - 1) < 1e-6);
      }
    }
  }

  const skinny = letterbox(makeRgba(1, 200, 255, 0, 0), 1, 200, 16);
  assert.equal(skinny.padX, 7);
  assert.equal(skinny.padY, 0);
  assert.ok(Math.abs(skinny.input[7] - 1) < 1e-6);
  assert.ok(Math.abs(skinny.input[6] - grey) < 1e-6);
});

test("decode() maps portrait vs landscape letterbox geometry and clamps out-of-frame boxes to 0..1000", () => {
  const portOut = new Float32Array(8 * 1);
  setAnchor(portOut, 1, 0, 320, 320, 160, 320, 1, 0.91);
  const portBoxes = decode(portOut, 1, { scale: 1, padX: 160, padY: 0 }, 320, 640);
  assert.deepEqual(portBoxes, [{ label: "strength", box: [250, 250, 750, 750], score: 0.91 }]);

  const landOut = new Float32Array(8 * 1);
  setAnchor(landOut, 1, 0, 320, 320, 320, 160, 0, 0.87);
  const landBoxes = decode(landOut, 1, { scale: 1, padX: 0, padY: 160 }, 640, 320);
  assert.deepEqual(landBoxes, [{ label: "product", box: [250, 250, 750, 750], score: 0.87 }]);

  const clampOut = new Float32Array(8 * 3);
  setAnchor(clampOut, 3, 0, 20, 10, 200, 180, 0, 0.95);
  setAnchor(clampOut, 3, 1, 620, 630, 240, 220, 2, 0.85);
  setAnchor(clampOut, 3, 2, 320, 320, 1800, 1800, 3, 0.75);
  const clamped = decode(clampOut, 3, { scale: 1, padX: 80, padY: 0 }, 480, 640);
  assert.equal(clamped.length, 3);
  assert.equal(clamped[0].box[0], 0);
  assert.equal(clamped[0].box[1], 0);
  assert.equal(clamped[1].box[2], 1000);
  assert.equal(clamped[1].box[3], 1000);
  assert.deepEqual(clamped[2].box, [0, 0, 1000, 1000]);
  for (const b of clamped) {
    for (const coord of b.box) {
      assert.ok(coord >= 0 && coord <= 1000);
    }
  }
});

test("decode() multi-class NMS preserves distinct classes at identical coordinates while suppressing same-class overlaps", () => {
  const anchors = 8;
  const out = new Float32Array(8 * anchors);
  setAnchor(out, anchors, 0, 320, 320, 200, 100, 0, 0.94);
  setAnchor(out, anchors, 1, 321, 320, 200, 100, 0, 0.82);
  setAnchor(out, anchors, 2, 320, 320, 200, 100, 1, 0.89);
  setAnchor(out, anchors, 3, 320, 320, 200, 100, 2, 0.78);
  setAnchor(out, anchors, 4, 320, 320, 200, 100, 3, 0.66);
  setAnchor(out, anchors, 5, 319, 321, 200, 100, 1, 0.71);
  setAnchor(out, anchors, 6, 80, 80, 50, 40, 1, 0.58);
  setAnchor(out, anchors, 7, 560, 560, 50, 40, 2, 0.39);

  const kept = decode(out, anchors, { scale: 1, padX: 0, padY: 0 }, 640, 640);
  assert.deepEqual(
    kept.map((b) => ({ label: b.label, score: b.score })),
    [
      { label: "product", score: 0.94 },
      { label: "strength", score: 0.89 },
      { label: "expiry", score: 0.78 },
      { label: "allergens", score: 0.66 },
      { label: "strength", score: 0.58 },
    ],
  );
  assert.deepEqual(kept[0].box, kept[1].box);
  assert.deepEqual(kept[1].box, kept[2].box);
  assert.deepEqual(kept[2].box, kept[3].box);

  const manyAnchors = 16;
  const manyOut = new Float32Array(8 * manyAnchors);
  for (let i = 0; i < manyAnchors; i += 1) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    setAnchor(manyOut, manyAnchors, i, 60 + col * 160, 60 + row * 160, 40, 40, i % 4, 0.5 + i * 0.02);
  }
  const capped = decode(manyOut, manyAnchors, { scale: 1, padX: 0, padY: 0 }, 640, 640);
  assert.equal(capped.length, 12);
  assert.equal(capped[0].score, 0.8);
});

test("detect() and SpotThrottle reject corrupt or truncated JPEG buffers cleanly and enforce busy, minGapMs, and backoff guards", async () => {
  const fixturePath = path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
  const validJpeg = fs.readFileSync(fixturePath);

  for (const corrupt of [
    Buffer.alloc(0),
    Buffer.from("not-a-valid-jpeg-payload", "utf8"),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    validJpeg.subarray(0, 72),
  ]) {
    await assert.rejects(() => detect(corrupt));
  }

  const corruptThrottle = new SpotThrottle();
  let corruptCalls = 0;
  corruptThrottle.maybe(validJpeg.subarray(0, 48).toString("base64"), () => {
    corruptCalls += 1;
  });
  const deadlineCorrupt = realDateNow() + 3000;
  while ((corruptThrottle as unknown as { offUntil: number }).offUntil === 0 && realDateNow() < deadlineCorrupt) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(corruptCalls, 0);
  assert.equal(corruptThrottle.runs, 0);
  assert.equal((corruptThrottle as unknown as { busy: boolean }).busy, false);
  assert.ok((corruptThrottle as unknown as { offUntil: number }).offUntil >= realDateNow() + 1000);

  let blockedDuringBackoff = 0;
  corruptThrottle.maybe(validJpeg.toString("base64"), () => {
    blockedDuringBackoff += 1;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(blockedDuringBackoff, 0);

  if (spotterAvailable()) {
    const liveThrottle = new SpotThrottle();
    const seen: FieldBox[][] = [];
    const b64 = validJpeg.toString("base64");
    liveThrottle.maybe(b64, (fields) => seen.push(fields));
    assert.equal((liveThrottle as unknown as { busy: boolean }).busy, true);
    liveThrottle.maybe(b64, (fields) => seen.push(fields));

    const waitDone = realDateNow() + 4000;
    while (seen.length < 1 && realDateNow() < waitDone) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(seen.length, 1);
    assert.equal(liveThrottle.runs, 1);
    assert.equal((liveThrottle as unknown as { busy: boolean }).busy, false);

    (liveThrottle as unknown as { lastAt: number }).lastAt = realDateNow();
    liveThrottle.maybe(b64, (fields) => seen.push(fields));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 1);
  }
});

test("Hub FieldSpotter readiness boosts when strength >= 0.5, caps <= 0.55 when product >= 0.5 without dose, and expires at 2500ms", () => {
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;

  const hub = new Hub("sess-spot-readiness");
  hub.features.add("sonar");
  hub.live = { active: true, handleEvent() {}, stop() {} };
  const phoneMsgs: ServerMsg[] = [];
  const phoneWs = {
    readyState: 1,
    send(raw: string) {
      phoneMsgs.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket;
  hub.clients.add(phoneWs);

  const lastReadiness = () => {
    const r = [...phoneMsgs].reverse().find((m) => m.type === "readiness");
    return r?.type === "readiness" ? r.value : undefined;
  };

  hub.lastFields = { fields: [fbox("strength", 0.49)], ts: fakeNow };
  hub.updateReadiness(0.4);
  assert.equal(lastReadiness(), 0.24);

  fakeNow += 300;
  hub.lastFields = { fields: [fbox("strength", 0.5)], ts: fakeNow };
  hub.updateReadiness(0.4);
  assert.equal(lastReadiness(), 0.55);

  fakeNow += 300;
  hub.lastFields = { fields: [fbox("product", 0.9), fbox("strength", 0.9)], ts: fakeNow };
  hub.updateReadiness(0.8);
  assert.equal(lastReadiness(), 0.81);

  fakeNow += 2499;
  hub.updateReadiness(0.5);
  assert.equal(lastReadiness(), 0.68);

  fakeNow += 300;
  hub.updateReadiness(0.5);
  assert.equal(lastReadiness(), 0.3);

  (hub.spec as unknown as { cache: unknown }).cache = {
    read: sampleRead(0.96),
    model: "gemini-3.8-flash",
    frameTs: fakeNow,
    sharpness: 1,
    bytes: 2048,
    at: fakeNow,
  };
  fakeNow += 300;
  hub.lastFields = { fields: [fbox("product", 0.5), fbox("strength", 0.49)], ts: fakeNow };
  hub.updateReadiness(1.0);
  assert.equal(lastReadiness(), 0.55);

  const fieldTs = fakeNow;
  fakeNow = fieldTs + 2499;
  hub.updateReadiness(1.0);
  assert.equal(lastReadiness(), 0.55);

  fakeNow = fieldTs + 2500;
  (hub.spec as unknown as { cache: { frameTs: number; at: number } }).cache.frameTs = fakeNow;
  (hub.spec as unknown as { cache: { frameTs: number; at: number } }).cache.at = fakeNow;
  hub.updateReadiness(1.0);
  assert.equal(lastReadiness(), 0.97);

  fakeNow += 300;
  (hub.spec as unknown as { cache: undefined }).cache = undefined;
  hub.lastFields = { fields: [fbox("product", 0.85)], ts: fakeNow };
  hub.updateReadiness(0.3);
  assert.equal(lastReadiness(), 0.18);
});

test("Hub verdict resets spotCoach and sets quietUntil +6000ms, live.busy extends +2500ms, and dropFrames() clears lastFields and spotCoach", () => {
  let fakeNow = 2_000_000;
  Date.now = () => fakeNow;

  const hub = new Hub("sess-spot-verdict-drop");
  let isBusy = false;
  const liveStub: LiveLike = {
    active: true,
    get busy() {
      return isBusy;
    },
    handleEvent() {},
    stop() {},
  };
  hub.live = liveStub;

  const clientMsgs: ServerMsg[] = [];
  const clientWs = {
    readyState: 1,
    send(raw: string) {
      clientMsgs.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket;
  hub.clients.add(clientWs);

  const runOnFields = (fields: FieldBox[], sharpness = 0.85) => {
    (hub as unknown as { onFields(f: Frame, boxes: FieldBox[]): void }).onFields(
      mkFrame(sharpness, fakeNow),
      fields,
    );
  };

  fakeNow += 400;
  runOnFields([fbox("product", 0.88), fbox("strength", 0.86)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.88), fbox("strength", 0.86)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.88)]);

  const verdictAt = fakeNow;
  hub.emit({ type: "coach", cue: "closer", text: "Move closer." });
  assert.ok(hub.lastCoach);
  hub.emit({ type: "verdict", verdict: sampleVerdict() });

  assert.equal(hub.spotCoach.quietUntil, verdictAt + 6000);
  assert.equal(hub.lastCoach, undefined);

  isBusy = true;
  fakeNow = verdictAt + 500;
  runOnFields([fbox("strength", 0.9, [400, 4, 500, 220])]);
  assert.equal(hub.spotCoach.quietUntil, verdictAt + 6000);
  isBusy = false;

  fakeNow = verdictAt + 5999;
  runOnFields([fbox("strength", 0.9, [400, 4, 500, 220])]);
  assert.equal(
    clientMsgs.some((m) => m.type === "coach" && m.say === true),
    false,
  );

  fakeNow = verdictAt + 6000;
  runOnFields([fbox("strength", 0.9, [400, 4, 500, 220])]);
  assert.equal(clientMsgs.filter((m) => m.type === "coach" && m.say === true).length, 1);

  clientMsgs.length = 0;
  fakeNow += 400;
  runOnFields([fbox("product", 0.88), fbox("strength", 0.86)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.88), fbox("strength", 0.86)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.88)]);
  const secondVerdictAt = fakeNow;
  hub.emit({ type: "verdict", verdict: sampleVerdict() });
  assert.equal(hub.spotCoach.quietUntil, secondVerdictAt + 6000);

  fakeNow = secondVerdictAt + 6100;
  runOnFields([fbox("product", 0.88)]);
  fakeNow = secondVerdictAt + 6500;
  runOnFields([fbox("product", 0.88)]);
  assert.equal(
    clientMsgs.some((m) => m.type === "coach" && m.say === true),
    false,
  );

  fakeNow = secondVerdictAt + 9200;
  runOnFields([fbox("product", 0.88)]);
  const otherSideCue = clientMsgs.find((m) => m.type === "coach" && m.say === true);
  assert.ok(otherSideCue && otherSideCue.type === "coach");
  assert.equal(otherSideCue.cue, "other_side");

  isBusy = true;
  fakeNow = secondVerdictAt + 12_000;
  runOnFields([fbox("product", 0.85)]);
  assert.equal(hub.spotCoach.quietUntil, fakeNow + 2500);
  isBusy = false;

  fakeNow = secondVerdictAt + 20_000;
  (hub.spot as unknown as { offUntil: number }).offUntil = fakeNow + 60_000;
  hub.features.add("sonar");
  hub.addFrame(mkFrame(0.85, fakeNow));
  hub.setCode({ raw: "0109501101530003", gtin: "09501101530003" });
  runOnFields([fbox("product", 0.9), fbox("strength", 0.9)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.9), fbox("strength", 0.9)]);
  fakeNow += 400;
  runOnFields([fbox("product", 0.9)]);
  assert.ok(hub.lastFields);
  assert.ok(hub.ring.length > 0);

  clientMsgs.length = 0;
  hub.dropFrames();
  assert.equal(hub.ring.length, 0);
  assert.equal(hub.lastCode, undefined);
  assert.equal(hub.lastFields, undefined);

  fakeNow += 400;
  hub.updateReadiness(0.5);
  const postDropReadiness = clientMsgs.find((m) => m.type === "readiness");
  assert.deepEqual(postDropReadiness, { type: "readiness", value: 0.3 });

  fakeNow += 400;
  runOnFields([fbox("product", 0.9)]);
  assert.equal(
    clientMsgs.some((m) => m.type === "coach" && m.say === true),
    false,
  );
});

test("WebSocket and ingest integration routes { type: 'fields' } to phone clients only and never leaks frames or fields to /hud-ws or /stage", async () => {
  env.apiKey = "";
  delete process.env.HOLDUP_KEY;
  const server: http.Server = await startServer(0);
  const port = (server.address() as AddressInfo).port;
  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];

  const connectRecorded = (subpath: string) => {
    const ws = new WebSocket(`${wsBase}${subpath}`);
    sockets.push(ws);
    const msgs: Array<Record<string, unknown>> = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, msgs, opened };
  };

  try {
    const sessId = "spot-ws-routing-1";
    const phone = connectRecorded(`/live?session=${sessId}`);
    await phone.opened;
    await new Promise((r) => setTimeout(r, 30));

    const hub = getHub(sessId)!;
    assert.ok(hub);
    hub.live = {
      active: true,
      handleEvent() {},
      stop() {},
      frame() {},
    } as unknown as LiveLike;
    hub.features.add("sonar");
    hub.source = "glasses";
    markLatest(hub);

    const hudPinned = connectRecorded(`/hud-ws?session=${sessId}`);
    const hudFloating = connectRecorded("/hud-ws");
    const stage = connectRecorded(`/hud-ws?role=stage&session=${sessId}`);
    await Promise.all([hudPinned.opened, hudFloating.opened, stage.opened]);
    await new Promise((r) => setTimeout(r, 30));

    phone.msgs.length = 0;
    hudPinned.msgs.length = 0;
    hudFloating.msgs.length = 0;
    stage.msgs.length = 0;

    const openBoxJpeg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
    const ingestRes = await fetch(`${httpBase}/ingest/frame?session=${sessId}&sharpness=0.85`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: openBoxJpeg,
    });
    assert.equal(ingestRes.status, 204);

    if (spotterAvailable()) {
      const waitFields = realDateNow() + 4000;
      while (!phone.msgs.some((m) => m.type === "fields") && realDateNow() < waitFields) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const fieldMsg = phone.msgs.find((m) => m.type === "fields") as { type: string; fields: FieldBox[] } | undefined;
      assert.ok(fieldMsg);
      assert.ok(Array.isArray(fieldMsg.fields) && fieldMsg.fields.length > 0);
      assert.ok(hub.lastFields && hub.lastFields.fields.length > 0);
    } else {
      (hub as unknown as { onFields(f: Frame, boxes: FieldBox[]): void }).onFields(
        mkFrame(0.85, realDateNow()),
        [fbox("product", 0.91), fbox("strength", 0.88)],
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(phone.msgs.some((m) => m.type === "fields"), true);
    }

    hub.emit({
      type: "fields",
      fields: [fbox("product", 0.92), fbox("strength", 0.87)],
    });
    hub.emit({
      type: "coach",
      cue: "hold_still",
      text: "Something is covering the dose. Move your thumb.",
      say: true,
    });
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(phone.msgs.some((m) => m.type === "fields"), true);
    assert.equal(phone.msgs.some((m) => m.type === "readiness"), true);
    assert.equal(phone.msgs.some((m) => m.type === "coach" && m.say === true), true);

    for (const sock of [hudPinned, hudFloating]) {
      assert.equal(sock.msgs.some((m) => m.type === "fields"), false);
      assert.equal(sock.msgs.some((m) => m.type === "frame"), false);
      assert.equal(sock.msgs.some((m) => m.type === "readiness"), false);
      assert.equal(sock.msgs.some((m) => m.type === "audio"), false);
      assert.equal(sock.msgs.some((m) => m.type === "coach" && m.say === true), true);
    }

    assert.equal(stage.msgs.some((m) => m.type === "fields"), false);
    assert.equal(stage.msgs.some((m) => m.type === "frame"), false);
    assert.equal(stage.msgs.some((m) => m.type === "audio"), false);
    assert.equal(stage.msgs.some((m) => m.type === "readiness"), true);
    assert.equal(stage.msgs.some((m) => m.type === "coach" && m.say === true), true);

    const lateHud = connectRecorded(`/hud-ws?session=${sessId}`);
    await lateHud.opened;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lateHud.msgs.some((m) => m.type === "fields"), false);
    assert.equal(lateHud.msgs.some((m) => m.type === "frame"), false);
    assert.equal(lateHud.msgs.some((m) => m.type === "readiness"), false);
    assert.equal(lateHud.msgs.some((m) => m.type === "coach" && m.say === true), true);

    hub.live = undefined;
    hub.dropFrames();
  } finally {
    for (const ws of sockets) {
      ws.terminate();
    }
    await new Promise((r) => setTimeout(r, 25));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
