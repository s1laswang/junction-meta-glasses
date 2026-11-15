import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";
import { decode, detect, letterbox, type FieldBox } from "../src/spotter.ts";
import { SpotCoach } from "../src/spotcoach.ts";

const fb = (label: FieldBox["label"], score: number, box: [number, number, number, number] = [400, 300, 500, 700]): FieldBox => ({ label, box, score });

test("letterbox keeps aspect ratio, pads with grey and writes RGB planes", () => {
  const w = 4, h = 2, rgba = new Uint8Array(w * h * 4).fill(255);
  const lb = letterbox(rgba, w, h, 8);
  assert.equal(lb.scale, 2);
  assert.equal(lb.padX, 0);
  assert.equal(lb.padY, 2);
  assert.equal(lb.input.length, 3 * 64);
  assert.ok(Math.abs(lb.input[0] - 114 / 255) < 1e-6);   // top padding row
  assert.equal(lb.input[2 * 8], 1);                      // first image row
});

test("decode maps a YOLOv8 head tensor to 0..1000 boxes and applies NMS per class", () => {
  const anchors = 3, out = new Float32Array(8 * anchors);
  // anchor 0 and 1: the same strength box (duplicate, lower score); anchor 2: a product box
  const set = (i: number, cx: number, cy: number, w: number, h: number, cls: number, score: number) => {
    out[i] = cx; out[anchors + i] = cy; out[2 * anchors + i] = w; out[3 * anchors + i] = h; out[(4 + cls) * anchors + i] = score;
  };
  set(0, 320, 320, 100, 40, 1, 0.9);
  set(1, 322, 321, 100, 40, 1, 0.7);
  set(2, 320, 200, 300, 60, 0, 0.8);
  const boxes = decode(out, anchors, { scale: 1, padX: 0, padY: 0 }, 640, 640);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { label: "strength", box: [469, 422, 531, 578], score: 0.9 });
  assert.equal(boxes[1].label, "product");
  assert.deepEqual(decode(out, anchors, { scale: 1, padX: 0, padY: 0 }, 640, 640, 0.95), []);
});

test("coach: dose seen, then gone while the product stays and the frame stays sharp -> 'covering the dose'", () => {
  const c = new SpotCoach();
  let t = 10_000;
  assert.equal(c.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300)), undefined);
  assert.equal(c.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300)), undefined);
  assert.equal(c.push([fb("product", 0.8)], 0.8, (t += 300)), undefined);
  const cue = c.push([fb("product", 0.8)], 0.78, (t += 300));
  assert.equal(cue?.kind, "covered");
  assert.match(cue!.text, /covering the dose/);
});

test("coach: a blurred frame, or the whole item leaving, is not 'covered'", () => {
  const blur = new SpotCoach(); let t = 10_000;
  blur.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300));
  blur.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300));
  assert.equal(blur.push([fb("product", 0.8)], 0.4, (t += 300)), undefined);
  assert.equal(blur.push([fb("product", 0.8)], 0.4, (t += 300)), undefined);
  const gone = new SpotCoach(); t = 10_000;
  gone.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300));
  gone.push([fb("product", 0.8), fb("strength", 0.8)], 0.8, (t += 300));
  assert.equal(gone.push([], 0.8, (t += 300)), undefined);
  assert.equal(gone.push([], 0.8, (t += 300)), undefined);
});

test("coach: product visible with no dose for 3 s -> 'turn the box'; rate limits and quiet time hold", () => {
  const c = new SpotCoach(); let t = 10_000;
  assert.equal(c.push([fb("product", 0.8)], 0.8, t), undefined);
  assert.equal(c.push([fb("product", 0.8)], 0.8, (t += 1500)), undefined);
  assert.equal(c.push([fb("product", 0.8)], 0.8, (t += 1600))?.kind, "other_side");
  assert.equal(c.push([fb("product", 0.8)], 0.8, (t += 3100)), undefined); // same kind within 8 s
  const q = new SpotCoach(); t = 10_000; q.quietUntil = t + 60_000;
  q.push([fb("product", 0.8)], 0.8, t);
  assert.equal(q.push([fb("product", 0.8)], 0.8, t + 3500), undefined);
});

test("coach: dose box cut off at the frame edge -> move it back into view", () => {
  const c = new SpotCoach(); let t = 10_000;
  const edge: [number, number, number, number] = [400, 0, 500, 200];
  assert.equal(c.push([fb("strength", 0.8, edge)], 0.8, (t += 300)), undefined);
  const cue = c.push([fb("strength", 0.8, edge)], 0.8, (t += 300));
  assert.equal(cue?.kind, "edge");
  assert.match(cue!.text, /to the right/);
});

test("the real model loads and runs on a fixture image (skipped if the model or runtime is missing)", async (t) => {
  const model = path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");
  const fixture = path.join(REPO_ROOT, "server", "fixtures", "amlodipine.jpg");
  if (!fs.existsSync(model) || !fs.existsSync(fixture)) return t.skip("model or fixture missing");
  let r;
  try { r = await detect(fs.readFileSync(fixture)); } catch (e) { return t.skip(`runtime unavailable: ${(e as Error).message.slice(0, 80)}`); }
  assert.ok(Array.isArray(r.fields));
  assert.ok(r.w > 0 && r.h > 0);
  for (const f of r.fields) { assert.ok(f.score >= 0.4 && f.score <= 1); assert.ok(f.box.every((v) => v >= 0 && v <= 1000)); }
});
