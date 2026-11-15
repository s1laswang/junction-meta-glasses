// Stage timing for FieldSpotter on this machine: JPEG decode, letterbox, inference at different thread counts.
import fs from "node:fs";
import path from "node:path";
import jpegJs from "jpeg-js";
import { REPO_ROOT } from "../src/env.ts";
import { letterbox } from "../src/spotter.ts";
// @ts-ignore no types
const ort = await import("onnxruntime-node");
const buf = fs.readFileSync(path.join(REPO_ROOT, "server", "fixtures", "amlodipine.jpg"));
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = async (n: number, f: () => unknown) => { const t: number[] = []; for (let i = 0; i < n; i++) { const s = performance.now(); await f(); t.push(performance.now() - s); } return Math.round(med(t)); };
let img = jpegJs.decode(buf, { useTArray: true, formatAsRGBA: true });
console.log("jpeg decode ms", await time(5, () => { img = jpegJs.decode(buf, { useTArray: true, formatAsRGBA: true }); }));
let lb = letterbox(img.data, img.width, img.height);
console.log("letterbox ms", await time(5, () => { lb = letterbox(img.data, img.width, img.height); }));
for (const threads of [1, 2, 4]) {
  const s = await ort.InferenceSession.create(path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx"), { intraOpNumThreads: threads, interOpNumThreads: 1 });
  const tensor = new ort.Tensor("float32", lb.input, [1, 3, 640, 640]);
  await s.run({ images: tensor });
  console.log(`inference ms (threads=${threads})`, await time(8, () => s.run({ images: tensor })));
}
