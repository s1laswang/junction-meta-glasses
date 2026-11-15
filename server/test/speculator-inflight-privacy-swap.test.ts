import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LabelRead } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { SPEC, Speculator } from "../src/speculate.ts";
import { FrameRing, type Frame, type ReadResult } from "../src/verify.ts";

const tmpRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const origLedgerPath = env.ledgerPath;
const origSpec = { ...SPEC };
const tempDirs: string[] = [];

function useTempLedger(tag: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `holdup-spec-priv-${tag}-`));
  tempDirs.push(dir);
  const file = path.join(dir, "ledger.jsonl");
  env.ledgerPath = file;
  return file;
}

afterEach(() => {
  Object.assign(SPEC, origSpec);
  env.ledgerPath = origLedgerPath;
});

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const field = (value: string | null, confidence = 0.95) => ({ value, confidence });

function makeRead(product: string, readability = 0.92): LabelRead {
  return {
    kind: "medication",
    product: field(product),
    ingredient: field(product.toLowerCase()),
    strength: field("5 mg"),
    dosing: field("Once daily"),
    expiry: field("2027-12"),
    allergens: { value: null, confidence: 0 },
    barcode: field(null, 0),
    readability,
  };
}

function makeFrame(data: string, ts: number, sharpness: number, bytes: number): Frame {
  return { data, ts, sharpness, bytes, source: "phone" };
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

type DeferredCall = {
  frames: string[];
  resolve: (r: ReadResult) => void;
};

function makeDeferredReader() {
  const pending: DeferredCall[] = [];
  const reader = (frames: string[]): Promise<ReadResult> =>
    new Promise((resolve) => {
      pending.push({ frames, resolve });
    });
  return { pending, reader };
}

test("spec.clear() while reader is in flight does not repopulate latest(), fire onRead, or satisfy awaiting get()", async (t) => {
  useTempLedger("clear-inflight");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 50_000 });

  const ring = new FrameRing(8);
  const { pending, reader } = makeDeferredReader();
  const spec = new Speculator(ring, () => true, reader);
  let onReadCount = 0;
  spec.onRead = () => {
    onReadCount++;
  };

  const f1 = makeFrame("PrivateBoxA", Date.now(), 0.85, 42_000);
  ring.push(f1);
  spec.onFrame(f1);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 1);

  const getInflight = spec.get(5000);

  ring.clear();
  spec.clear();

  pending[0].resolve({
    read: makeRead("PrivateBoxA", 0.96),
    model: "fake-flash",
    latencyMs: 15,
    attempts: 1,
  });
  await flushMicrotasks();

  const res = await getInflight;
  assert.equal(res, undefined);
  assert.equal(spec.latest(), undefined);
  assert.equal(onReadCount, 0);
  assert.equal(spec.hits, 0);
  assert.equal(spec.misses, 1);

  t.mock.timers.tick(SPEC.minGapMs);
  const f2 = makeFrame("NextSessionBox", Date.now(), 0.88, 44_000);
  ring.push(f2);
  spec.onFrame(f2);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 2);

  pending[1].resolve({
    read: makeRead("NextSessionBox", 0.94),
    model: "fake-flash",
    latencyMs: 10,
    attempts: 1,
  });
  await flushMicrotasks();

  assert.equal(onReadCount, 1);
  assert.equal(spec.latest()?.read.product.value, "NextSessionBox");
  const nextRes = await spec.get(100);
  assert.equal(nextRes?.read.product.value, "NextSessionBox");
  assert.equal(nextRes?.source, "cache");
});

test("spec.clear() during rapid session restart blocks stale pre-clear reader from overwriting new session or firing onRead", async (t) => {
  useTempLedger("clear-restart");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 80_000 });

  const ring = new FrameRing(8);
  const { pending, reader } = makeDeferredReader();
  const spec = new Speculator(ring, () => true, reader);
  let onReadCount = 0;
  spec.onRead = () => {
    onReadCount++;
  };

  const oldFrame = makeFrame("SessionOneBox", Date.now(), 0.82, 40_000);
  ring.push(oldFrame);
  spec.onFrame(oldFrame);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 1);

  const staleGet = spec.get(5000);
  ring.clear();
  spec.clear();

  t.mock.timers.tick(SPEC.minGapMs);
  const newFrame = makeFrame("SessionTwoBox", Date.now(), 0.9, 46_000);
  ring.push(newFrame);
  spec.onFrame(newFrame);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 2);

  pending[0].resolve({
    read: makeRead("SessionOneBox", 0.97),
    model: "fake-flash",
    latencyMs: 25,
    attempts: 1,
  });
  await flushMicrotasks();

  assert.equal(await staleGet, undefined);
  assert.equal(onReadCount, 0);
  assert.equal(spec.latest(), undefined);

  pending[1].resolve({
    read: makeRead("SessionTwoBox", 0.95),
    model: "fake-flash",
    latencyMs: 12,
    attempts: 1,
  });
  await flushMicrotasks();

  assert.equal(onReadCount, 1);
  assert.equal(spec.latest()?.read.product.value, "SessionTwoBox");
});

test("mid-await box swap via bytes jump (> 6% sceneDelta) invalidates inflight read of Box A and returns undefined", async (t) => {
  useTempLedger("mid-await-bytes");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });

  const ring = new FrameRing(8);
  const { pending, reader } = makeDeferredReader();
  const spec = new Speculator(ring, () => true, reader);
  const pushAndNotify = (f: Frame) => {
    ring.push(f);
    spec.onFrame(f);
  };

  pushAndNotify(makeFrame("BoxA", Date.now(), 0.75, 50_000));
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 1);
  pending[0].resolve({
    read: makeRead("BoxA", 0.93),
    model: "fake-flash",
    latencyMs: 10,
    attempts: 1,
  });
  await flushMicrotasks();
  assert.equal((await spec.get(100))?.read.product.value, "BoxA");

  t.mock.timers.tick(SPEC.stableMs + 100);

  pushAndNotify(makeFrame("BoxA", Date.now(), 0.88, 50_000));
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 2);

  const awaitingGet = spec.get(5000);

  t.mock.timers.tick(50);
  pushAndNotify(makeFrame("BoxB", Date.now(), 0.88, 54_000));

  pending[1].resolve({
    read: makeRead("BoxA", 0.96),
    model: "fake-flash",
    latencyMs: 18,
    attempts: 1,
  });
  await flushMicrotasks();

  const afterSwap = await awaitingGet;
  assert.equal(afterSwap, undefined);
  assert.equal(await spec.get(10), undefined);
});

test("mid-await box swap via motionDrop (> 0.2 sharpness drop) invalidates inflight read of Box A and returns undefined", async (t) => {
  useTempLedger("mid-await-motion");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200_000 });

  const ring = new FrameRing(8);
  const { pending, reader } = makeDeferredReader();
  const spec = new Speculator(ring, () => true, reader);
  const pushAndNotify = (f: Frame) => {
    ring.push(f);
    spec.onFrame(f);
  };

  pushAndNotify(makeFrame("BoxA", Date.now(), 0.78, 50_000));
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 1);
  pending[0].resolve({
    read: makeRead("BoxA", 0.5),
    model: "fake-flash",
    latencyMs: 10,
    attempts: 1,
  });
  await flushMicrotasks();
  assert.equal(spec.latest()?.read.product.value, "BoxA");

  t.mock.timers.tick(SPEC.minGapMs);
  pushAndNotify(makeFrame("BoxA", Date.now(), 0.9, 50_000));
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 2);

  const awaitingGet = spec.get(5000);

  t.mock.timers.tick(40);
  pushAndNotify(makeFrame("BoxBBlur", Date.now(), 0.52, 50_000));

  pending[1].resolve({
    read: makeRead("BoxA", 0.95),
    model: "fake-flash",
    latencyMs: 16,
    attempts: 1,
  });
  await flushMicrotasks();

  const afterMotion = await awaitingGet;
  assert.equal(afterMotion, undefined);
  assert.equal(await spec.get(10), undefined);
});

test("weak readability (0.59 < SPEC.minReadability) on an inflight read misses like usable(), while >= 0.6 and pre-cache bursts hit", async (t) => {
  useTempLedger("weak-inflight");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 300_000 });

  const ring = new FrameRing(8);
  const { pending, reader } = makeDeferredReader();
  const spec = new Speculator(ring, () => true, reader);

  const fWeak = makeFrame("BlurryBox", Date.now(), 0.84, 45_000);
  ring.push(fWeak);
  spec.onFrame(fWeak);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(pending.length, 1);

  const weakPromise = spec.get(5000);
  pending[0].resolve({
    read: makeRead("BlurryBox", 0.59),
    model: "fake-flash",
    latencyMs: 14,
    attempts: 1,
  });
  await flushMicrotasks();

  assert.equal(await weakPromise, undefined);
  assert.equal(spec.hits, 0);
  assert.equal(spec.misses, 1);
  assert.equal(await spec.get(10), undefined);

  const ringBurst = new FrameRing(8);
  const burstDeferred = makeDeferredReader();
  const specBurst = new Speculator(ringBurst, () => true, burstDeferred.reader);

  const b1 = makeFrame("SteadyBox", Date.now(), 0.72, 40_000);
  ringBurst.push(b1);
  specBurst.onFrame(b1);
  t.mock.timers.tick(SPEC.debounceMs);
  await flushMicrotasks();
  assert.equal(burstDeferred.pending.length, 1);

  t.mock.timers.tick(50);
  const b2 = makeFrame("SteadyBox", Date.now(), 0.85, 45_000);
  ringBurst.push(b2);
  specBurst.onFrame(b2);

  const burstPromise = specBurst.get(5000);
  burstDeferred.pending[0].resolve({
    read: makeRead("SteadyBox", 0.6),
    model: "fake-flash",
    latencyMs: 11,
    attempts: 1,
  });
  await flushMicrotasks();

  const burstHit = await burstPromise;
  assert.equal(burstHit?.source, "inflight");
  assert.equal(burstHit?.read.product.value, "SteadyBox");
  assert.equal(specBurst.hits, 1);
  assert.equal(specBurst.misses, 0);
});
