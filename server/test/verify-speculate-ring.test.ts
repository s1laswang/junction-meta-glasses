import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { SPEC, Speculator } from "../src/speculate.ts";
import {
  emptyProfile,
  FrameRing,
  jpegSharpness,
  jpegSize,
  LABEL_SCHEMA,
  readLabel,
  toLabelRead,
  toProfile,
  unreadable,
  verify,
  VERIFY_PROMPT,
  type Frame,
} from "../src/verify.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-verify-spec-"));
env.ledgerPath = path.join(tmpDir, "ledger.jsonl");
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    data: "ZmFrZS1qcGVn",
    sharpness: 0.5,
    ts: 1000,
    bytes: 10_000,
    source: "phone",
    ...overrides,
  };
}

function makeJpeg(w: number, h: number, marker = 0xc0, prefix: number[] = []): Buffer {
  const sof = Buffer.alloc(13);
  sof[0] = 0xff;
  sof[1] = marker;
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...prefix]), sof]);
}

function modelReply(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10 },
  };
}

const validLabelJson = {
  kind: "medication",
  product: { value: "Norvasc", confidence: 0.95 },
  ingredient: { value: "amlodipine", confidence: 0.93 },
  strength: { value: "5 mg", confidence: 0.92 },
  dosing: { value: "Once daily", confidence: 0.85 },
  expiry: { value: "2027-08", confidence: 0.9 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: "6432100012345", confidence: 0.88 },
  readability: 0.91,
};

test("FrameRing: empty state, FIFO eviction at capacity, and clear", () => {
  const defaultRing = new FrameRing();
  assert.equal(defaultRing.length, 0);
  assert.equal(defaultRing.lastTs, 0);
  assert.deepEqual(defaultRing.pick(), []);

  for (let i = 1; i <= 10; i++) {
    defaultRing.push(makeFrame({ data: `f${i}`, ts: i * 100, sharpness: i === 1 ? 0.99 : 0.4 }));
  }
  assert.equal(defaultRing.length, 8);
  assert.equal(defaultRing.lastTs, 1000);
  const picked = defaultRing.pick(8, 10_000, 1000);
  assert.equal(picked.length, 8);
  assert.ok(picked.every((f) => f.data !== "f1" && f.data !== "f2"));

  const small = new FrameRing(3);
  small.push(makeFrame({ data: "a", ts: 10 }));
  small.push(makeFrame({ data: "b", ts: 20 }));
  small.clear();
  assert.equal(small.length, 0);
  assert.equal(small.lastTs, 0);
  assert.deepEqual(small.pick(), []);
});

test("FrameRing: sharpness windowing, PICK_SAME_ITEM_MS boundary, tie-breaking, and box-swap isolation", () => {
  const ring = new FrameRing(8);
  const now = 20_000;
  ring.push(makeFrame({ data: "too-old-sharp", sharpness: 0.99, ts: now - 2001 }));
  ring.push(makeFrame({ data: "on-boundary", sharpness: 0.8, ts: now - 2000 }));
  ring.push(makeFrame({ data: "tie-older", sharpness: 0.75, ts: now - 1500 }));
  ring.push(makeFrame({ data: "tie-newer", sharpness: 0.75, ts: now - 1000 }));
  ring.push(makeFrame({ data: "recent-blurry", sharpness: 0.2, ts: now - 500 }));

  const top3 = ring.pick(3, 5000, now);
  assert.deepEqual(top3.map((f) => f.data), ["on-boundary", "tie-newer", "tie-older"]);
  assert.equal(ring.lastTs, now - 500);

  const staleNow = 50_000;
  const sameItemTop2 = ring.pick(2, 5000, staleNow);
  assert.deepEqual(sameItemTop2.map((f) => f.data), ["on-boundary", "tie-newer"]);

  const boxSwap = new FrameRing(4);
  boxSwap.push(makeFrame({ data: "old-box-sharp", sharpness: 0.99, ts: 100 }));
  boxSwap.push(makeFrame({ data: "new-box", sharpness: 0.4, ts: 2000 }));
  assert.deepEqual(boxSwap.pick(2, 5000, 2100).map((f) => f.data), ["new-box"]);
});

test("jpegSize: baseline and progressive SOF markers, skipped non-SOF segments, and truncated inputs", () => {
  assert.deepEqual(jpegSize(makeJpeg(640, 480, 0xc0)), { w: 640, h: 480 });
  assert.deepEqual(jpegSize(makeJpeg(1280, 720, 0xc2)), { w: 1280, h: 720 });
  assert.deepEqual(jpegSize(makeJpeg(320, 240, 0xcf)), { w: 320, h: 240 });

  const nonFrameSegments = [
    0x00, 0x42,
    0xff, 0xe0, 0x00, 0x04, 0x11, 0x22,
    0xff, 0xc4, 0x00, 0x04, 0x33, 0x44,
    0xff, 0xc8, 0x00, 0x02,
    0xff, 0xcc, 0x00, 0x02,
  ];
  assert.deepEqual(jpegSize(makeJpeg(800, 600, 0xc0, nonFrameSegments)), { w: 800, h: 600 });

  const fixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const fixtureDim = jpegSize(fixture);
  assert.ok(fixtureDim && fixtureDim.w > 0 && fixtureDim.h > 0);

  assert.equal(jpegSize(Buffer.alloc(0)), undefined);
  assert.equal(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8])), undefined);

  const minimal = Buffer.alloc(12);
  minimal[0] = 0xff;
  minimal[1] = 0xd8;
  minimal[2] = 0xff;
  minimal[3] = 0xc0;
  minimal.writeUInt16BE(11, 4);
  minimal[6] = 8;
  minimal.writeUInt16BE(100, 7);
  minimal.writeUInt16BE(200, 9);
  assert.deepEqual(jpegSize(minimal), { w: 200, h: 100 });
  assert.equal(jpegSize(minimal.subarray(0, 11)), undefined);

  const runawaySegment = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(jpegSize(runawaySegment), undefined);
});

test("jpegSharpness: dimension scaling, 768x768 fallback, and 0..1 clamping", () => {
  assert.equal(jpegSharpness(Buffer.alloc(0)), 0);

  const base = makeJpeg(1000, 500);
  const padded = Buffer.concat([base, Buffer.alloc(35_000 - base.length)]);
  assert.ok(Math.abs(jpegSharpness(padded) - 0.2) < 1e-9);

  const tinyHighDensity = makeJpeg(4, 4);
  assert.equal(jpegSharpness(tinyHighDensity), 1);

  const zeroDimension = makeJpeg(0, 100);
  assert.equal(jpegSharpness(zeroDimension), 1);

  const rawFallback = Buffer.alloc(Math.round(768 * 768 * 0.175));
  assert.ok(Math.abs(jpegSharpness(rawFallback) - 0.5) < 1e-5);
});

test("VERIFY_PROMPT, LABEL_SCHEMA ref inlining, and unreadable helper", () => {
  assert.ok(VERIFY_PROMPT.length > 50);

  const schemaText = JSON.stringify(LABEL_SCHEMA);
  assert.ok(!schemaText.includes('"$ref"'));
  assert.ok(!schemaText.includes('"$defs"'));
  assert.ok(!schemaText.includes('"$comment"'));
  assert.deepEqual(LABEL_SCHEMA.properties.strength.required, ["value", "confidence"]);

  const def = unreadable();
  assert.equal(def.kind, "unreadable");
  assert.equal(def.readability, 0);
  assert.equal(def.product.value, null);
  assert.equal(def.product.confidence, 0);
  assert.equal(def.guidance, "Hold it up in front of you and keep it still.");
  assert.equal(unreadable("Turn the pack over.").guidance, "Turn the pack over.");
});

test("toLabelRead: schema coercion, clamping, null confidence cap, expiry penalty, and guidance bounds", () => {
  for (const bad of [null, undefined, 42, false, "not-json"]) {
    const u = toLabelRead(bad);
    assert.equal(u.kind, "unreadable");
    assert.equal(u.readability, 0);
    assert.equal(u.guidance, "Hold it up in front of you and keep it still.");
  }

  const fromArray = toLabelRead([]);
  assert.equal(fromArray.kind, "unreadable");
  assert.equal(fromArray.product.value, null);
  assert.equal(fromArray.guidance, undefined);

  for (const k of ["medication", "food", "other", "unreadable"] as const) {
    assert.equal(toLabelRead({ kind: k }).kind, k);
  }
  assert.equal(toLabelRead({ kind: "vitamin" }).kind, "unreadable");

  const coerced = toLabelRead({
    kind: "food",
    product: { value: "   ", confidence: 0.95 },
    ingredient: { value: null, confidence: 0.15 },
    strength: { value: "500 mg", confidence: 4.2 },
    dosing: { value: "Take 1", confidence: -0.7 },
    expiry: { value: "08/2027", confidence: 0.92 },
    allergens: { value: ["milk", 99], confidence: 0.88 },
    barcode: { value: "123", confidence: Number.NaN },
    readability: Number.POSITIVE_INFINITY,
    guidance: `  ${"g".repeat(150)}  `,
  });

  assert.equal(coerced.product.value, null);
  assert.equal(coerced.product.confidence, 0.3);
  assert.equal(coerced.ingredient.value, null);
  assert.equal(coerced.ingredient.confidence, 0.15);
  assert.equal(coerced.strength.value, "500 mg");
  assert.equal(coerced.strength.confidence, 1);
  assert.equal(coerced.dosing.confidence, 0);
  assert.equal(coerced.expiry.value, "08/2027");
  assert.equal(coerced.expiry.confidence, 0.5);
  assert.equal(coerced.allergens.value, null);
  assert.equal(coerced.allergens.confidence, 0.3);
  assert.equal(coerced.barcode.confidence, 0);
  assert.equal(coerced.readability, 0);
  assert.equal(coerced.guidance?.length, 120);

  const isoMonth = toLabelRead({ kind: "medication", expiry: { value: "2028-04", confidence: 0.94 } });
  assert.equal(isoMonth.expiry.confidence, 0.94);

  const isoDay = toLabelRead({ kind: "food", expiry: { value: "2028-04-19", confidence: 0.91 }, allergens: { value: [], confidence: 0.87 } });
  assert.equal(isoDay.expiry.confidence, 0.91);
  assert.deepEqual(isoDay.allergens, { value: [], confidence: 0.87 });

  const lowNonIso = toLabelRead({ kind: "medication", expiry: { value: "2028/04", confidence: 0.25 }, guidance: "   " });
  assert.equal(lowNonIso.expiry.confidence, 0.25);
  assert.equal("guidance" in lowNonIso, false);
});

test("emptyProfile and toProfile: defensive bounds, truncation, fallback ids, and doseLog tail retention", () => {
  const p1 = emptyProfile();
  const p2 = emptyProfile();
  p1.allergies.push("peanut");
  assert.deepEqual(p2, { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" });

  assert.deepEqual(toProfile(null), { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" });
  assert.deepEqual(toProfile({ meds: "bad", allergies: 5, avoid: {}, doseLog: "bad", lang: "" }), {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  });

  const medsInput = Array.from({ length: 60 }, (_, i) => ({
    id: i === 0 ? "" : i === 1 ? "x".repeat(90) : `id-${i}`,
    name: "n".repeat(150),
    ingredient: i === 0 ? 123 : "i".repeat(150),
    strength: "s".repeat(60),
    schedule: ["", 42, ...Array.from({ length: 12 }, (_, j) => `slot-${j}-${"t".repeat(50)}`)],
    barcode: i === 0 ? "b".repeat(50) : undefined,
    notes: i === 0 ? "m".repeat(250) : "",
  }));

  const allergiesInput = ["", null, ...Array.from({ length: 40 }, (_, i) => `alg-${i}-${"a".repeat(70)}`)];
  const avoidInput = ["", false, ...Array.from({ length: 35 }, (_, i) => `avd-${i}-${"v".repeat(70)}`)];
  const doseLogInput = [
    { medId: "bad-ts", ts: "100" },
    null,
    ...Array.from({ length: 510 }, (_, i) => ({ medId: i === 509 ? "d".repeat(90) : `m-${i}`, ts: i + 1 })),
  ];

  const clean = toProfile({
    meds: medsInput,
    allergies: allergiesInput,
    avoid: avoidInput,
    doseLog: doseLogInput,
    lang: "fi-FI-extra-long-locale-tag",
  });

  assert.equal(clean.meds.length, 50);
  assert.equal(clean.meds[0].id, "med0");
  assert.equal(clean.meds[0].name.length, 120);
  assert.equal(clean.meds[0].ingredient, "");
  assert.equal(clean.meds[0].strength.length, 40);
  assert.equal(clean.meds[0].schedule.length, 8);
  assert.equal(clean.meds[0].schedule[0].length, 40);
  assert.equal(clean.meds[0].barcode?.length, 32);
  assert.equal(clean.meds[0].notes?.length, 200);
  assert.equal(clean.meds[1].id.length, 64);
  assert.equal("barcode" in clean.meds[1], false);
  assert.equal("notes" in clean.meds[1], false);

  assert.equal(clean.allergies.length, 30);
  assert.equal(clean.allergies[0].length, 60);
  assert.equal(clean.avoid.length, 30);
  assert.equal(clean.avoid[0].length, 60);

  assert.equal(clean.doseLog.length, 500);
  assert.equal(clean.doseLog[0].ts, 11);
  assert.equal(clean.doseLog[499].ts, 510);
  assert.equal(clean.doseLog[499].medId.length, 64);
  assert.equal(clean.lang.length, 16);
});

test("readLabel and verify: empty frames return unsure without calling model", async (t) => {
  const gen = t.mock.method(ai.models, "generateContent", async () => modelReply(validLabelJson));
  const r = await readLabel([]);
  assert.equal(r.model, null);
  assert.equal(r.attempts, 0);
  assert.equal(r.read.kind, "unreadable");

  const v = await verify([], emptyProfile());
  assert.equal(v.model, null);
  assert.equal(v.frames, 0);
  assert.equal(v.verdict.level, "unsure");
  assert.ok(v.verdict.reasons.includes("reader unavailable"));
  assert.equal(gen.mock.callCount(), 0);
});

test("readLabel and verify: transient primary retry, fallback model chain, and 3-frame cap", async (t) => {
  const prevQuiet = process.env.HOLDUP_QUIET;
  process.env.HOLDUP_QUIET = "1";
  t.after(() => {
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  });

  const seenModels: string[] = [];
  let callNum = 0;
  t.mock.method(ai.models, "generateContent", async (req: any) => {
    seenModels.push(req.model);
    callNum++;
    if (callNum === 1) return { text: "{broken-json", usageMetadata: {} } as any;
    if (callNum === 2) throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
    const parts = req.contents[0].parts;
    assert.equal(parts.length, 4);
    return modelReply(validLabelJson) as any;
  });

  const p = toProfile({
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  });
  const res = await verify(["f1", "f2", "f3", "f4", "f5"], p, "  is this my evening pill?  ");
  assert.equal(res.frames, 3);
  assert.equal(res.model, env.verifyModels[1]);
  assert.equal(res.verdict.level, "match");
  assert.deepEqual(seenModels, [env.verifyModels[0], env.verifyModels[0], env.verifyModels[1]]);
});

test("Speculator: ignores frames when session is inactive or sharpness is below threshold", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const gen = t.mock.method(ai.models, "generateContent", async () => modelReply(validLabelJson));
  let active = false;
  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => active);

  const f1 = makeFrame({ sharpness: 0.8, ts: Date.now() });
  ring.push(f1);
  spec.onFrame(f1);
  t.mock.timers.tick(SPEC.debounceMs + 100);
  await nextTick();
  assert.equal(gen.mock.callCount(), 0);

  active = true;
  const blurry = makeFrame({ sharpness: SPEC.minSharpness - 0.01, ts: Date.now() });
  ring.push(blurry);
  spec.onFrame(blurry);
  t.mock.timers.tick(SPEC.debounceMs + 100);
  await nextTick();
  assert.equal(gen.mock.callCount(), 0);

  const sharp = makeFrame({ sharpness: 0.7, ts: Date.now() });
  ring.push(sharp);
  spec.onFrame(sharp);
  active = false;
  t.mock.timers.tick(SPEC.debounceMs + 100);
  await nextTick();
  assert.equal(gen.mock.callCount(), 0);
});

test("Speculator: debounce coalescing, freshMs cache hit, stableMs retention, and TTL expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200_000 });
  const gen = t.mock.method(ai.models, "generateContent", async () => modelReply(validLabelJson));
  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => true);

  const f1 = makeFrame({ data: "frame-a", sharpness: 0.4, bytes: 10_000, ts: Date.now() });
  ring.push(f1);
  spec.onFrame(f1);

  t.mock.timers.tick(150);
  const f2 = makeFrame({ data: "frame-b", sharpness: 0.75, bytes: 10_200, ts: Date.now() });
  ring.push(f2);
  spec.onFrame(f2);

  t.mock.timers.tick(250);
  await nextTick();
  assert.equal(gen.mock.callCount(), 0);

  t.mock.timers.tick(100);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  const hitFresh = await spec.get();
  assert.equal(hitFresh?.source, "cache");
  assert.equal(hitFresh?.read.ingredient.value, "amlodipine");
  assert.equal(spec.hits, 1);
  assert.equal(spec.misses, 0);

  t.mock.timers.tick(4000);
  const steady = makeFrame({ data: "frame-c", sharpness: 0.77, bytes: 10_500, ts: Date.now() });
  ring.push(steady);
  spec.onFrame(steady);
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  const hitStable = await spec.get();
  assert.equal(hitStable?.source, "cache");
  assert.equal(spec.hits, 2);

  t.mock.timers.tick(SPEC.stableMs);
  const expired = await spec.get();
  assert.equal(expired, undefined);
  assert.equal(spec.misses, 1);
});

test("Speculator: scene-change invalidation past freshMs, sharpness refresh, and minGapMs spacing", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 300_000 });
  let product = "Norvasc";
  const gen = t.mock.method(ai.models, "generateContent", async () =>
    modelReply({ ...validLabelJson, product: { value: product, confidence: 0.95 } }),
  );
  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => true);

  const initial = makeFrame({ sharpness: 0.45, bytes: 10_000, ts: Date.now() });
  ring.push(initial);
  spec.onFrame(initial);
  t.mock.timers.tick(SPEC.debounceMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  t.mock.timers.tick(100);
  product = "Burana";
  const sharperSoon = makeFrame({ sharpness: 0.7, bytes: 10_000, ts: Date.now() });
  ring.push(sharperSoon);
  spec.onFrame(sharperSoon);

  t.mock.timers.tick(SPEC.debounceMs + 200);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  t.mock.timers.tick(SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 2);
  assert.equal((await spec.get())?.read.product.value, "Burana");

  t.mock.timers.tick(SPEC.freshMs + 500);
  assert.equal((await spec.get())?.source, "cache");

  const newScene = makeFrame({ sharpness: 0.7, bytes: 14_000, ts: Date.now() });
  ring.push(newScene);
  spec.onFrame(newScene);

  const invalidated = await spec.get();
  assert.equal(invalidated, undefined);

  product = "Metformin";
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 3);
  assert.equal((await spec.get())?.read.product.value, "Metformin");
});

test("Speculator: weak readability cache is rejected and re-triggers on steady frames", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 400_000 });
  let readability = 0.4;
  const gen = t.mock.method(ai.models, "generateContent", async () =>
    modelReply({ ...validLabelJson, readability }),
  );
  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => true);

  const f1 = makeFrame({ sharpness: 0.5, bytes: 9000, ts: Date.now() });
  ring.push(f1);
  spec.onFrame(f1);
  t.mock.timers.tick(SPEC.debounceMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);
  assert.equal(await spec.get(), undefined);
  assert.equal(spec.misses, 1);

  readability = 0.88;
  const f2 = makeFrame({ sharpness: 0.5, bytes: 9000, ts: Date.now() });
  ring.push(f2);
  spec.onFrame(f2);
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 2);
  assert.equal((await spec.get())?.source, "cache");
});

test("Speculator: inflight coalescing, maxWaitMs timeout, reader error resilience, and clear", async (t) => {
  const prevQuiet = process.env.HOLDUP_QUIET;
  process.env.HOLDUP_QUIET = "1";
  t.after(() => {
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  });

  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 500_000 });
  let resolveCall: ((v: any) => void) | undefined;
  let shouldFail = false;

  const gen = t.mock.method(ai.models, "generateContent", () => {
    if (shouldFail) {
      return Promise.reject(Object.assign(new Error("400 INVALID_ARGUMENT"), { status: 400 }));
    }
    return new Promise((r) => {
      resolveCall = r;
    }) as any;
  });

  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => true);

  const f1 = makeFrame({ sharpness: 0.6, bytes: 10_000, ts: Date.now() });
  ring.push(f1);
  spec.onFrame(f1);
  t.mock.timers.tick(SPEC.debounceMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  const fDuringInflight = makeFrame({ sharpness: 0.9, bytes: 15_000, ts: Date.now() });
  ring.push(fDuringInflight);
  spec.onFrame(fDuringInflight);
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), 1);

  const timedOutPromise = spec.get(100);
  t.mock.timers.tick(100);
  assert.equal(await timedOutPromise, undefined);

  const inflightHitPromise = spec.get(5000);
  resolveCall!(modelReply(validLabelJson));
  const inflightHit = await inflightHitPromise;
  assert.equal(inflightHit?.source, "inflight");
  assert.equal(inflightHit?.read.product.value, "Norvasc");

  shouldFail = true;
  const fFail = makeFrame({ sharpness: 0.95, bytes: 10_100, ts: Date.now() });
  ring.push(fFail);
  spec.onFrame(fFail);
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  await nextTick();
  assert.ok(gen.mock.callCount() >= 2);
  assert.equal((await spec.get())?.read.product.value, "Norvasc");

  const fPending = makeFrame({ sharpness: 0.99, bytes: 20_000, ts: Date.now() });
  ring.push(fPending);
  spec.onFrame(fPending);
  const callsBeforeClear = gen.mock.callCount();
  spec.clear();
  t.mock.timers.tick(SPEC.debounceMs + SPEC.minGapMs);
  await nextTick();
  assert.equal(gen.mock.callCount(), callsBeforeClear);
  assert.equal(await spec.get(), undefined);
});
