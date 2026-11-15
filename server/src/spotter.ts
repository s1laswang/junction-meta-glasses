// FieldSpotter: our own label-field detector (YOLOv8n, trained on Verda from the Gemini-generated eval set; see
// docs/evidence/verda-fieldspotter.md). It finds where the product name, strength (dose), expiry and allergen panel
// are in a frame, on the CPU, in tens of milliseconds. It only drives coaching and the readiness tone: Gemini stays
// the reader, and safety.ts stays the judge. Off unless SPOTTER=1.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./env.ts";
import { errSummary, log } from "./log.ts";

export const SPOT_LABELS = ["product", "strength", "expiry", "allergens"] as const;
export type SpotLabel = (typeof SPOT_LABELS)[number];
/** box = [ymin, xmin, ymax, xmax], normalised 0..1000 (same convention as Gemini box_2d and SceneItem.box) */
export type FieldBox = { label: SpotLabel; box: [number, number, number, number]; score: number };

export const SPOT = { size: 640, conf: 0.4, iou: 0.5, minGapMs: 400, slowMs: 2500, backoffMs: 5_000 };
const MODEL_PATH = path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");
export const spotterAvailable = () => process.env.SPOTTER === "1" && fs.existsSync(MODEL_PATH);

type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>; inputNames: readonly string[]; outputNames: readonly string[] };
let ortMod: any;
let sessionP: Promise<Session> | undefined;
function session(): Promise<Session> {
  sessionP ??= (async () => {
    ortMod = await import("onnxruntime-node");
    const s = await ortMod.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 1, interOpNumThreads: 1 });
    log("spotter.loaded", { inputs: s.inputNames.join(","), outputs: s.outputNames.join(",") });
    return s as Session;
  })().catch((e) => { sessionP = undefined; throw e; });
  return sessionP;
}

export type Letterbox = { input: Float32Array; scale: number; padX: number; padY: number };
/** RGBA pixels -> 1x3x640x640 float RGB in 0..1, aspect-preserving, grey (114) padding: the Ultralytics preprocessing. */
export function letterbox(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, size = SPOT.size): Letterbox {
  const scale = Math.min(size / w, size / h);
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const padX = Math.floor((size - nw) / 2), padY = Math.floor((size - nh) / 2);
  const area = size * size;
  const input = new Float32Array(3 * area).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    const row = (y + padY) * size;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 4, di = row + x + padX;
      input[di] = rgba[si] / 255;
      input[area + di] = rgba[si + 1] / 255;
      input[2 * area + di] = rgba[si + 2] / 255;
    }
  }
  return { input, scale, padX, padY };
}

function iou(a: number[], b: number[]): number {
  const y0 = Math.max(a[0], b[0]), x0 = Math.max(a[1], b[1]), y1 = Math.min(a[2], b[2]), x1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, y1 - y0) * Math.max(0, x1 - x0);
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/** YOLOv8 head output (1, 4 + classes, anchors), channel-first -> boxes in 0..1000 image coordinates, after NMS. */
export function decode(out: Float32Array, anchors: number, lb: { scale: number; padX: number; padY: number }, w: number, h: number, conf = SPOT.conf, iouT = SPOT.iou): FieldBox[] {
  const nc = SPOT_LABELS.length;
  const cand: FieldBox[] = [];
  for (let i = 0; i < anchors; i++) {
    let best = 0, cls = -1;
    for (let c = 0; c < nc; c++) { const s = out[(4 + c) * anchors + i]; if (s > best) { best = s; cls = c; } }
    if (best < conf || cls < 0) continue;
    const cx = out[i], cy = out[anchors + i], bw = out[2 * anchors + i], bh = out[3 * anchors + i];
    const x0 = (cx - bw / 2 - lb.padX) / lb.scale, x1 = (cx + bw / 2 - lb.padX) / lb.scale;
    const y0 = (cy - bh / 2 - lb.padY) / lb.scale, y1 = (cy + bh / 2 - lb.padY) / lb.scale;
    const n = (v: number, max: number) => Math.round(Math.max(0, Math.min(1, v / max)) * 1000);
    cand.push({ label: SPOT_LABELS[cls], box: [n(y0, h), n(x0, w), n(y1, h), n(x1, w)], score: Math.round(best * 1000) / 1000 });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep: FieldBox[] = [];
  for (const c of cand) if (!keep.some((k) => k.label === c.label && iou(k.box, c.box) > iouT)) keep.push(c);
  return keep.slice(0, 12);
}

/** Decode a JPEG and run the detector. Throws if the model or runtime is unavailable. */
export async function detect(jpeg: Buffer): Promise<{ fields: FieldBox[]; ms: number; w: number; h: number }> {
  const t = Date.now();
  const s = await session();
  const { default: jpegJs } = await import("jpeg-js");
  const img = jpegJs.decode(jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  const lb = letterbox(img.data, img.width, img.height);
  const tensor = new ortMod.Tensor("float32", lb.input, [1, 3, SPOT.size, SPOT.size]);
  const res = await s.run({ [s.inputNames[0]]: tensor });
  const o = res[s.outputNames[0]];
  const anchors = o.dims[2] ?? 8400;
  return { fields: decode(o.data, anchors, lb, img.width, img.height), ms: Date.now() - t, w: img.width, h: img.height };
}

/** Per-session throttle: one detection in flight, at most ~4/s, backs off when the CPU is too slow. */
export class SpotThrottle {
  private busy = false; private lastAt = 0; private offUntil = 0; private slow = 0;
  runs = 0; totalMs = 0;
  maybe(jpegB64: string, onFields: (fields: FieldBox[], ms: number) => void): void {
    const now = Date.now();
    if (this.busy || now < this.offUntil || now - this.lastAt < SPOT.minGapMs) return;
    this.busy = true; this.lastAt = now;
    detect(Buffer.from(jpegB64, "base64")).then((r) => {
      this.runs++; this.totalMs += r.ms;
      if (r.ms > SPOT.slowMs) { if (++this.slow >= 3) { this.offUntil = Date.now() + SPOT.backoffMs; this.slow = 0; log("spotter.backoff", { ms: r.ms }); } } else this.slow = 0;
      onFields(r.fields, r.ms);
    }).catch((e) => { this.offUntil = Date.now() + SPOT.backoffMs; log("spotter.failed", { err: errSummary(e) }); })
      .finally(() => { this.busy = false; });
  }
}
