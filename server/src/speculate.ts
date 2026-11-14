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
  minGapMs: 1200,       // min time between speculative calls (cost cap on the shared key)
  minSharpness: 0.15,   // don't spend calls on frames with nothing in view
  minReadability: 0.6,
  sceneDelta: 0.12,     // relative JPEG size change that counts as "scene changed"
};

type Cached = { read: LabelRead; model: string | null; frameTs: number; sharpness: number; bytes: number; at: number };
type Inflight = { promise: Promise<Cached | undefined>; frameTs: number };

export class Speculator {
  private cache?: Cached;
  private inflight?: Inflight;
  private timer?: NodeJS.Timeout;
  private lastStart = 0;
  private sceneChangedAfterCache = false;
  hits = 0; misses = 0;

  constructor(private ring: FrameRing, private isActive: () => boolean) {}

  clear() { this.cache = undefined; this.inflight = undefined; clearTimeout(this.timer); }

  /** Call on every new frame (phone or glasses). */
  onFrame(f: Frame) {
    if (!this.isActive() || f.sharpness < SPEC.minSharpness) return;
    const ref = this.cache;
    const changed = !ref || Math.abs(f.bytes - ref.bytes) / Math.max(1, ref.bytes) > SPEC.sceneDelta;
    if (ref && changed) this.sceneChangedAfterCache = true;
    const sharper = !ref || f.sharpness > ref.sharpness + 0.05;
    const weak = !!ref && (ref.read.kind === "unreadable" || ref.read.readability < SPEC.minReadability);
    if (!(changed || sharper || weak)) return;
    clearTimeout(this.timer);
    const wait = Math.max(SPEC.debounceMs, this.lastStart + SPEC.minGapMs - Date.now());
    this.timer = setTimeout(() => this.kick(), wait);
  }

  private kick() {
    if (this.inflight || !this.isActive()) return; // one at a time; the next frame will re-arm
    const frames = this.ring.pick(2);
    if (!frames.length) return;
    this.lastStart = Date.now();
    const frameTs = Math.max(...frames.map((x) => x.ts));
    const best = frames[0];
    const promise = readLabel(frames.map((x) => x.data), undefined, "verify_spec")
      .then((r): Cached | undefined => {
        if (!r.model) return undefined; // reader failed: keep the old cache
        const c: Cached = { read: r.read, model: r.model, frameTs, sharpness: best.sharpness, bytes: best.bytes, at: Date.now() };
        if (!this.cache || frameTs >= this.cache.frameTs) { this.cache = c; this.sceneChangedAfterCache = false; }
        return c;
      })
      .catch(() => undefined)
      .finally(() => { if (this.inflight?.promise === promise) this.inflight = undefined; });
    this.inflight = { promise, frameTs };
  }

  private usable(c: Cached | undefined, now = Date.now()): c is Cached {
    if (!c || c.read.kind === "unreadable" || c.read.readability < SPEC.minReadability) return false;
    const age = now - c.frameTs;
    return age < SPEC.freshMs || (!this.sceneChangedAfterCache && age < SPEC.stableMs);
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
    if (inf && t - inf.frameTs < SPEC.stableMs) {
      const c = await Promise.race([inf.promise, new Promise<undefined>((r) => setTimeout(() => r(undefined), maxWaitMs))]);
      if (c && c.read.kind !== "unreadable") {
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
