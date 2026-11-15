// Speculative verify: while a live session is running, read the label in the background whenever a sharper
// frame or a new scene arrives (debounced, max one call in flight). When the Live model calls verify_label we
// answer from this cache instantly if it is fresh, or await the in-flight read instead of starting a new one.
import type { LabelRead } from "../../shared/types.ts";
import { ledger } from "./ledger.ts";
import { type Frame, type FrameRing, readLabel } from "./verify.ts";

export const SPEC = {
  freshMs: 2500,        // cache younger than this (by frame time) is always usable
  stableMs: 10_000,     // ... or up to this old if every frame since looks like the same scene
  debounceMs: 350,
  minGapMs: Number(process.env.SPEC_MIN_GAP_MS ?? 2000), // min time between speculative calls (cost cap on the shared key)
  minSharpness: 0.15,   // don't spend calls on frames with nothing in view
  minReadability: 0.6,
  sceneDelta: 0.06,     // relative JPEG size change that counts as "scene changed" (was 0.12: two similar white boxes stayed under it)
  motionDrop: 0.2,      // a sharpness drop this large means motion (e.g. swapping boxes): also counts as a scene change
};

type Cached = { read: LabelRead; model: string | null; frameTs: number; sharpness: number; bytes: number; at: number };
type Inflight = { promise: Promise<Cached | undefined>; frameTs: number };

export class Speculator {
  private cache?: Cached;
  private inflight?: Inflight;
  private timer?: NodeJS.Timeout;
  private lastStart = 0;
  private sceneChangedAfterCache = false;
  /** frame time of the last detected scene change; reads of frames older than this are never served */
  private lastChangeTs = 0;
  private gen = 0;
  hits = 0; misses = 0;

  /** called whenever a background read lands (readiness sonar) */
  onRead?: () => void;
  constructor(private ring: FrameRing, private isActive: () => boolean, private reader: typeof readLabel = readLabel) {}
  /** Latest speculative read (any age), for the readiness sonar. */
  latest() { return this.cache; }

  clear() { this.gen++; this.cache = undefined; this.inflight = undefined; this.sceneChangedAfterCache = false; this.lastChangeTs = 0; clearTimeout(this.timer); }

  /** Call on every new frame (phone or glasses). */
  onFrame(f: Frame) {
    if (!this.isActive()) return;
    const ref = this.cache;
    // Motion (a blurry frame after a sharp one) or a size change means the item may have been swapped.
    const motion = !!ref && f.sharpness < ref.sharpness - SPEC.motionDrop;
    const changed = !ref || motion || Math.abs(f.bytes - ref.bytes) / Math.max(1, ref.bytes) > SPEC.sceneDelta;
    if (ref && changed) { this.sceneChangedAfterCache = true; this.lastChangeTs = Math.max(this.lastChangeTs, f.ts); }
    if (f.sharpness < SPEC.minSharpness) return;
    const sharper = !ref || f.sharpness > ref.sharpness + 0.05;
    const weak = !!ref && (ref.read.kind === "unreadable" || ref.read.readability < SPEC.minReadability);
    if (!(changed || sharper || weak)) return;
    clearTimeout(this.timer);
    const wait = Math.max(SPEC.debounceMs, this.lastStart + SPEC.minGapMs - Date.now());
    this.timer = setTimeout(() => this.kick(), wait);
  }

  private kick() {
    if (this.inflight || !this.isActive()) return; // one at a time; the next frame will re-arm
    const frames = this.ring.pick(2).filter((x) => x.ts >= this.lastChangeTs);
    if (!frames.length) return;
    this.lastStart = Date.now();
    const frameTs = Math.max(...frames.map((x) => x.ts));
    const best = frames[0];
    const gen = this.gen;
    const promise = this.reader(frames.map((x) => x.data), undefined, "verify_spec")
      .then((r): Cached | undefined => {
        if (gen !== this.gen) return undefined;
        if (!r.model) return undefined; // reader failed: keep the old cache
        const c: Cached = { read: r.read, model: r.model, frameTs, sharpness: best.sharpness, bytes: best.bytes, at: Date.now() };
        // only a read of frames taken after the last scene change may become the cache
        if ((!this.cache || frameTs >= this.cache.frameTs) && frameTs >= this.lastChangeTs) { this.cache = c; this.sceneChangedAfterCache = false; }
        this.onRead?.();
        return c;
      })
      .catch(() => undefined)
      .finally(() => { if (this.inflight?.promise === promise) this.inflight = undefined; });
    this.inflight = { promise, frameTs };
  }

  private usable(c: Cached | undefined, now = Date.now()): c is Cached {
    if (!c || c.read.kind === "unreadable" || c.read.readability < SPEC.minReadability) return false;
    // Box-swap safety: after any scene change the cache is never served, however young it is.
    if (this.sceneChangedAfterCache || c.frameTs < this.lastChangeTs) return false;
    return now - c.frameTs < SPEC.stableMs;
  }

  /**
   * For verify_label: a fresh cached read, else the in-flight read (if its frames are recent), else undefined
   * (caller does a normal read). Never waits longer than maxWaitMs.
   */
  async get(maxWaitMs = 8000): Promise<{ read: LabelRead; model: string | null; source: "cache" | "inflight" } | undefined> {
    const t = Date.now();
    if (this.usable(this.cache)) {
      this.hits++;
      ledger({ feature: "verify_cache", model: this.cache.model ?? "none", latency_s: 0, ok: true, source: "cache", age_s: (t - this.cache.frameTs) / 1000 });
      return { read: this.cache.read, model: this.cache.model, source: "cache" };
    }
    const inf = this.inflight;
    if (inf && t - inf.frameTs < SPEC.stableMs && inf.frameTs >= this.lastChangeTs) {
      const gen = this.gen;
      const c = await Promise.race([inf.promise, new Promise<undefined>((r) => setTimeout(() => r(undefined), maxWaitMs))]);
      if (
        c &&
        gen === this.gen &&
        c.read.kind !== "unreadable" &&
        c.read.readability >= SPEC.minReadability &&
        !this.sceneChangedAfterCache &&
        c.frameTs >= this.lastChangeTs
      ) {
        this.hits++;
        ledger({ feature: "verify_cache", model: c.model ?? "none", latency_s: (Date.now() - t) / 1000, ok: true, source: "inflight" });
        return { read: c.read, model: c.model, source: "inflight" };
      }
    }
    this.misses++;
    ledger({ feature: "verify_cache", model: "none", latency_s: (Date.now() - t) / 1000, ok: false, source: "miss" });
    return undefined;
  }
}
