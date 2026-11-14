// Box-swap safety (independent judge, Sat 23:02): after swapping look-alike boxes, HoldUp must never answer
// about the previous box from a cached read or from mixed frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead } from "../../shared/types.ts";
import { FrameRing, type Frame } from "../src/verify.ts";
import { Speculator, SPEC } from "../src/speculate.ts";

const f = (value: string | null, confidence = 0.95) => ({ value, confidence });
const readOf = (product: string): LabelRead => ({
  kind: "medication", product: f(product), ingredient: f(product.toLowerCase()), strength: f("5 mg"), dosing: f(null, 0),
  expiry: f(null, 0), allergens: { value: null, confidence: 0 }, barcode: f(null, 0), readability: 0.9,
});
const frame = (data: string, ts: number, sharpness: number, bytes: number): Frame => ({ data, ts, sharpness, bytes, source: "phone" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fake reader: the "label" is the frame data (A or B); no Gemini calls
const fakeReader = async (frames: string[]) => ({ read: readOf(frames[0]), model: "fake", latencyMs: 1, attempts: 1 });

test("pick() never mixes a sharp old frame of box A into a read of box B", () => {
  const ring = new FrameRing(8);
  ring.push(frame("A", 1000, 0.95, 50_000)); // sharp still of A
  ring.push(frame("A", 1500, 0.9, 50_000));
  ring.push(frame("B", 3200, 0.3, 48_000));  // just swapped, still blurry
  const picked = ring.pick(2, 5000, 3300);
  assert.ok(picked.length >= 1);
  assert.ok(picked.every((p) => p.data === "B"), `picked ${picked.map((p) => p.data)}`);
});

test("a cached read of A is not served after a swap to a look-alike box B (motion, similar size)", async () => {
  const saved = { ...SPEC };
  Object.assign(SPEC, { debounceMs: 1, minGapMs: 0 });
  try {
    const ring = new FrameRing(8);
    const spec = new Speculator(ring, () => true, fakeReader as any);
    const add = (fr: Frame) => { ring.push(fr); spec.onFrame(fr); };
    const now = Date.now();
    add(frame("A", now, 0.9, 50_000));
    await sleep(30);
    const first = await spec.get(50);
    assert.equal(first?.read.product.value, "A"); // cache works for the same box
    // swap: a motion-blurred frame, then box B whose JPEG size is within 2% of A's
    add(frame("B", now + 400, 0.4, 49_500));
    add(frame("B", now + 900, 0.88, 49_200));
    const after = await spec.get(1); // ask immediately, before the new read lands
    assert.notEqual(after?.read.product.value, "A", "must never answer A after a swap");
    await sleep(30); // let the speculative read of B land
    const later = await spec.get(50);
    assert.equal(later?.read.product.value, "B");
  } finally { Object.assign(SPEC, saved); }
});

test("a byte-size change above the scene threshold also invalidates the cache", async () => {
  const saved = { ...SPEC };
  Object.assign(SPEC, { debounceMs: 1, minGapMs: 0 });
  try {
    const ring = new FrameRing(8);
    let calls = 0;
    const slowReader = async (frames: string[]) => { calls++; if (calls > 1) await sleep(200); return fakeReader(frames); };
    const spec = new Speculator(ring, () => true, slowReader as any);
    const add = (fr: Frame) => { ring.push(fr); spec.onFrame(fr); };
    const now = Date.now();
    add(frame("A", now, 0.9, 50_000));
    await sleep(30);
    assert.equal((await spec.get(50))?.read.product.value, "A");
    add(frame("B", now + 500, 0.9, 54_000)); // 8% bigger, same sharpness
    const r = await spec.get(1);
    assert.notEqual(r?.read.product.value, "A");
  } finally { Object.assign(SPEC, saved); }
});
