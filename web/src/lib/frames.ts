// Frame capture: downscale to 768 px long side, JPEG, plus a cheap sharpness score
// (variance of the Laplacian on a 160 px grey downsample), normalised to 0..1.

export type CapturedFrame = { data: string; w: number; h: number; sharpness: number; ts: number; raw: number };

const SHARP_W = 160;
const sharpCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
const outCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;

/** Variance of the 4-neighbour Laplacian of a greyscale downsample. */
export function laplacianVariance(src: CanvasImageSource, sw: number, sh: number): number {
  if (!sharpCanvas || !sw || !sh) return 0;
  const w = SHARP_W;
  const h = Math.max(1, Math.round((sh / sw) * w));
  sharpCanvas.width = w;
  sharpCanvas.height = h;
  const ctx = sharpCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(src, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Map raw Laplacian variance to 0..1 (≈0.5 at variance 150, a typical "just readable" phone frame). */
export function normaliseSharpness(v: number) {
  return v / (v + 150);
}

export function captureFrame(video: HTMLVideoElement, longSide = 768, quality = 0.7): CapturedFrame | null {
  if (!outCanvas || video.readyState < 2 || !video.videoWidth) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, longSide / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  const raw = laplacianVariance(video, vw, vh);
  outCanvas.width = w;
  outCanvas.height = h;
  const ctx = outCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const url = outCanvas.toDataURL("image/jpeg", quality);
  return { data: url.slice(url.indexOf(",") + 1), w, h, sharpness: normaliseSharpness(raw), raw, ts: Date.now() };
}

/** Decode an image file (from <input type=file capture>) into a frame for snapshot mode. */
export async function frameFromFile(file: File, longSide = 1024, quality = 0.8): Promise<CapturedFrame> {
  const bmp = await createImageBitmap(file);
  if (!outCanvas) throw new Error("no canvas");
  const scale = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const raw = laplacianVariance(bmp, bmp.width, bmp.height);
  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  const url = outCanvas.toDataURL("image/jpeg", quality);
  bmp.close();
  return { data: url.slice(url.indexOf(",") + 1), w, h, sharpness: normaliseSharpness(raw), raw, ts: Date.now() };
}

/** Rolling buffer of recent frames; snapshot mode sends the sharpest ones. */
export class FrameRing {
  private frames: CapturedFrame[] = [];
  constructor(private size = 8) {}
  push(f: CapturedFrame) {
    this.frames.push(f);
    if (this.frames.length > this.size) this.frames.shift();
  }
  sharpest(n = 1, maxAgeMs = 8000): CapturedFrame[] {
    const now = Date.now();
    return [...this.frames].filter((f) => now - f.ts < maxAgeMs).sort((a, b) => b.sharpness - a.sharpness).slice(0, n);
  }
  clear() {
    this.frames = [];
  }
}

export type FramePolicy = { fps: number; quality: number; longSide: number; tier: "normal" | "slow" | "very-slow" };

/** Adaptive frame policy from the measured WebSocket RTT. */
export function policyForRtt(rtt: number | null): FramePolicy {
  if (rtt == null || rtt < 700) return { fps: 1, quality: 0.7, longSide: 768, tier: "normal" };
  if (rtt < 1500) return { fps: 0.5, quality: 0.6, longSide: 768, tier: "slow" };
  return { fps: 0.33, quality: 0.5, longSide: 640, tier: "very-slow" };
}

/** Skip a frame that is much blurrier than the last one sent, but never starve the model for long. */
export function shouldSend(f: CapturedFrame, lastSent: CapturedFrame | null, maxGapMs = 3000) {
  if (!lastSent) return true;
  if (f.ts - lastSent.ts > maxGapMs) return true;
  return f.sharpness >= lastSent.sharpness * 0.6;
}
