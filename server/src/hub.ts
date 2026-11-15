// Session hubs: one per ?session= id. Holds the phone socket(s), HUD sockets, frame ring, profile (memory only)
// and the last verdict/coach/device for late HUDs. `session` is optional on /hud-ws and /ingest/*: those then
// follow the most recently started live session.
import type { WebSocket } from "ws";
import type { DeviceState, FeatureFlag, Gs1Code, Profile, ServerMsg, Verdict, VerdictLevel } from "../../shared/types.ts";
import { FrameRing, emptyProfile, type Frame } from "./verify.ts";
import { Speculator } from "./speculate.ts";
import { DmThrottle } from "./dm.ts";
import type { Feature } from "./env.ts";
import { log, shortId } from "./log.ts";

export interface LiveLike {
  handleEvent(name: string): void;
  stop(reason: string): void;
  readonly active: boolean;
  /** Numbers for the /stage projector (no content). Optional so test doubles needn't implement it. */
  stats?(): LiveStats;
}

export type VerifySource = "cache" | "inflight" | "fresh" | "scene";
export type LiveStats = {
  model: string | null;
  firstAudioS: number | null;
  firstAudioP50S: number | null;
  turns: number;
  verify: { ms: number; source: VerifySource; level: VerdictLevel; at: number } | null;
};

/**
 * Stage-only message (`/hud-ws?role=stage`). Not part of shared/types.ts yet (contract proposal in the
 * feat/stage report); web/src/screens/Stage.tsx mirrors it. Numbers and flags only: never content or images.
 */
export type StageMetrics = {
  type: "metrics";
  model: string | null;
  /** last question → first assistant audio, seconds */
  firstAudioS: number | null;
  firstAudioP50S: number | null;
  turns: number;
  /** last verify_label / find_item: latency and where the read came from */
  verify: { ms: number; source: VerifySource; level: VerdictLevel } | null;
  cache: { hits: number; misses: number };
  features: FeatureFlag[];
  phone: boolean;
  hud: boolean;
  source: "phone" | "glasses";
  /** camera frames/s reaching the server over the last 5 s, and their mean size */
  fps: number;
  frameKb: number | null;
};

const HUD_TYPES = new Set(["verdict", "coach", "status", "device"]);
/** The projector view also gets captions, the checking spinner and readiness. Never audio or frames. */
const STAGE_TYPES = new Set([...HUD_TYPES, "transcript", "checking", "readiness", "ready", "interrupted"]);
const FPS_WINDOW_MS = 5000;

export class Hub {
  clients = new Set<WebSocket>();
  huds = new Set<WebSocket>();
  /** /hud-ws?role=stage sockets: read-only, not counted as a HUD for the phone's "HUD connected". */
  stages = new Set<WebSocket>();
  ring = new FrameRing(8);
  spec = new Speculator(this.ring, () => !!this.live?.active);
  profile: Profile = emptyProfile();
  live?: LiveLike;
  lastVerdict?: Verdict;
  lastCoach?: ServerMsg;
  lastStatus?: ServerMsg;
  device?: DeviceState;
  /** Which camera the phone chose. Glasses frames from /ingest are only used while this is "glasses". */
  source: "phone" | "glasses" = "phone";
  resume?: { handle: string; model: string; at: number };
  touchedAt = Date.now();
  /** Feature flags for this session: server FEATURES intersected with start.features. Empty until start. */
  features = new Set<Feature>();
  /** Last GS1 DataMatrix seen for the current item (phone-decoded or server-decoded glasses frame). Never logged. */
  lastCode?: { code: Gs1Code; ts: number };
  dm = new DmThrottle();
  private readiness = { value: -1, sentAt: 0, sharp: 0 };
  private frameLog: { ts: number; bytes: number }[] = [];
  private lastMetrics = "";
  constructor(readonly id: string) {
    this.spec.onRead = () => this.updateReadiness();
  }

  has(f: Feature) { return this.features.has(f); }
  setCode(code: Gs1Code) { this.lastCode = { code, ts: Date.now() }; }
  /** A code is attributed to the current item only while it is fresh (10 s). */
  freshCode(maxAgeMs = 10_000): Gs1Code | undefined {
    return this.has("datamatrix") && this.lastCode && Date.now() - this.lastCode.ts < maxAgeMs ? this.lastCode.code : undefined;
  }

  /**
   * Readiness sonar (flag `sonar`): blend of the latest frame sharpness and the latest speculative read's
   * readability (decayed after 3 s). Sent at most 4/s and only on a change > 0.05. No Gemini calls.
   */
  updateReadiness(sharp?: number) {
    if (!this.has("sonar") || !this.live?.active) return;
    if (typeof sharp === "number") this.readiness.sharp = Math.max(0, Math.min(1, sharp));
    const s = this.readiness.sharp;
    const lr = this.spec.latest();
    let v = 0.6 * s; // sharpness alone can't say "ready": that needs a read
    if (lr) {
      const age = Date.now() - lr.frameTs;
      const decay = age <= 3000 ? 1 : Math.max(0, 1 - (age - 3000) / 5000);
      const r = lr.read.kind === "unreadable" ? 0 : lr.read.readability;
      v = Math.max(v, 0.35 * s + 0.65 * r * decay);
    }
    v = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
    const now = Date.now();
    if (Math.abs(v - this.readiness.value) <= 0.05 || now - this.readiness.sentAt < 250) return;
    this.readiness.value = v; this.readiness.sentAt = now;
    this.emit({ type: "readiness", value: v }, { hud: false });
  }

  /** Send to the phone client(s) and, for HUD-relevant types, to HUDs (own + floating ones if this is the latest). */
  emit(msg: ServerMsg, opts: { clients?: boolean; hud?: boolean } = {}) {
    this.touchedAt = Date.now();
    if (msg.type === "verdict") {
      this.lastVerdict = msg.verdict;
      this.lastCoach = undefined;
    }
    if (msg.type === "coach") this.lastCoach = msg;
    if (msg.type === "status") this.lastStatus = msg;
    if (msg.type === "device") this.device = msg.device;
    const s = JSON.stringify(msg);
    if (opts.clients !== false) for (const c of this.clients) safeSend(c, s);
    if (opts.hud !== false && HUD_TYPES.has(msg.type)) for (const h of hudsFor(this)) safeSend(h, s);
    // the stage gets its types even when the HUD is skipped (readiness is phone + stage only)
    if (STAGE_TYPES.has(msg.type)) for (const st of stagesFor(this)) safeSend(st, s);
  }
  /** Raw send to this session's stage sockets (e.g. the HUD's own button events, so the replica mirrors Dismiss). */
  toStages(s: string) { for (const st of stagesFor(this)) safeSend(st, s); }
  /** Projector numbers for this session (no content). */
  metrics(now = Date.now()): StageMetrics {
    const st = this.live?.stats?.();
    this.frameLog = this.frameLog.filter((f) => now - f.ts < FPS_WINDOW_MS);
    const n = this.frameLog.length;
    return {
      type: "metrics",
      model: st?.model || null,
      firstAudioS: st?.firstAudioS ?? null,
      firstAudioP50S: st?.firstAudioP50S ?? null,
      turns: st?.turns ?? 0,
      verify: st?.verify ? { ms: st.verify.ms, source: st.verify.source, level: st.verify.level } : null,
      cache: { hits: this.spec.hits, misses: this.spec.misses },
      features: [...this.features],
      phone: this.clients.size > 0,
      hud: hudsFor(this).length > 0,
      source: this.source,
      fps: Math.round((n / (FPS_WINDOW_MS / 1000)) * 10) / 10,
      frameKb: n ? Math.round(this.frameLog.reduce((a, f) => a + f.bytes, 0) / n / 102.4) / 10 : null,
    };
  }
  /** Send metrics to stage sockets if anything changed (or always, to one late joiner). */
  pushMetrics(to?: WebSocket) {
    const list = to ? [to] : stagesFor(this);
    if (!list.length) return;
    const s = JSON.stringify(this.metrics());
    if (!to && s === this.lastMetrics) return;
    if (!to) this.lastMetrics = s;
    for (const w of list) safeSend(w, s);
  }
  /** Every frame (phone or glasses) goes through here: ring buffer + speculative verify. */
  addFrame(f: Frame) {
    this.ring.push(f);
    this.frameLog.push({ ts: f.ts, bytes: f.bytes });
    if (this.frameLog.length > 64) this.frameLog.shift();
    this.spec.onFrame(f);
    this.updateReadiness(f.sharpness);
  }
  /** Privacy: drop frames and cached reads. */
  dropFrames() { this.ring.clear(); this.spec.clear(); this.lastCode = undefined; }
  /** Tell the phone(s) whether a HUD is attached to this session. */
  hudChanged() {
    const s = JSON.stringify({ type: "hud", connected: hudsFor(this).length > 0 });
    for (const c of this.clients) safeSend(c, s);
  }
  /** Replay buffered state to a HUD that connects late. */
  replay(ws: WebSocket) {
    if (this.lastStatus) safeSend(ws, JSON.stringify(this.lastStatus));
    if (this.device) safeSend(ws, JSON.stringify({ type: "device", device: this.device }));
    if (this.lastCoach) safeSend(ws, JSON.stringify(this.lastCoach));
    if (this.lastVerdict) safeSend(ws, JSON.stringify({ type: "verdict", verdict: this.lastVerdict }));
    if (this.stages.has(ws) || floatingStages.has(ws)) this.pushMetrics(ws);
  }
}

export function safeSend(ws: WebSocket, data: string) {
  try { if (ws.readyState === 1) ws.send(data); } catch { /* socket gone */ }
}

const hubs = new Map<string, Hub>();
let latestId: string | undefined;
/** HUDs connected without ?session=: they follow the latest live session. */
const floatingHuds = new Set<WebSocket>();
/** Stage sockets connected without ?session=: they follow the latest live session too. */
const floatingStages = new Set<WebSocket>();
/** Device state that arrived while no session existed. */
let orphanDevice: DeviceState | undefined;

function hudsFor(h: Hub): WebSocket[] {
  return h.id === latestId ? [...h.huds, ...floatingHuds] : [...h.huds];
}
function stagesFor(h: Hub): WebSocket[] {
  return h.id === latestId ? [...h.stages, ...floatingStages] : [...h.stages];
}

export const getHub = (id: string) => hubs.get(id);
export function getOrCreateHub(id: string): Hub {
  let h = hubs.get(id);
  if (!h) { h = new Hub(id); hubs.set(id, h); }
  h.touchedAt = Date.now();
  return h;
}
export const latestHub = () => (latestId ? hubs.get(latestId) : undefined);
/** Resolve an optional session param: explicit id (existing hub only) or the latest live session. */
export function resolveHub(id?: string | null): Hub | undefined {
  return id ? hubs.get(id) : latestHub();
}

/** Called when a live session starts: this hub becomes the target for session-less HUDs and ingest. */
export function markLatest(h: Hub) {
  latestId = h.id;
  if (orphanDevice && !h.device) h.device = orphanDevice;
  for (const ws of floatingHuds) h.replay(ws);
  for (const ws of floatingStages) h.replay(ws);
  h.hudChanged();
}

/**
 * `/hud-ws?role=stage` (projector view): same replay and fan-out as a HUD plus transcripts, checking,
 * readiness and metrics. Kept apart from HUDs so the phone's "HUD connected" only counts real HUDs.
 */
export function addStage(ws: WebSocket, id?: string | null) {
  if (id) {
    const h = getOrCreateHub(id);
    h.stages.add(ws);
    h.replay(ws);
    ws.on("close", () => { h.stages.delete(ws); });
    return;
  }
  floatingStages.add(ws);
  const h = latestHub();
  if (h) h.replay(ws);
  else if (orphanDevice) safeSend(ws, JSON.stringify({ type: "device", device: orphanDevice }));
  ws.on("close", () => { floatingStages.delete(ws); });
}

export function addHud(ws: WebSocket, id?: string | null) {
  if (id) {
    const h = getOrCreateHub(id);
    h.huds.add(ws);
    h.replay(ws);
    h.hudChanged();
    ws.on("close", () => { h.huds.delete(ws); h.hudChanged(); });
    return;
  }
  floatingHuds.add(ws);
  const h = latestHub();
  if (h) { h.replay(ws); h.hudChanged(); }
  else if (orphanDevice) safeSend(ws, JSON.stringify({ type: "device", device: orphanDevice }));
  ws.on("close", () => { floatingHuds.delete(ws); latestHub()?.hudChanged(); });
}
/** The hub a HUD event should go to. */
export function hudTarget(id?: string | null) { return resolveHub(id); }

export function setDevice(device: DeviceState, id?: string | null) {
  const h = resolveHub(id) ?? (id ? getOrCreateHub(id) : undefined);
  if (!h) {
    orphanDevice = device;
    const s = JSON.stringify({ type: "device", device });
    for (const ws of floatingHuds) safeSend(ws, s);
    for (const ws of floatingStages) safeSend(ws, s);
    return;
  }
  h.emit({ type: "device", device });
}

// Drop idle hubs (and their frames/profile) after 10 minutes without clients or activity.
setInterval(() => {
  const now = Date.now();
  for (const [id, h] of hubs) {
    if (h.clients.size === 0 && !h.live?.active && now - h.touchedAt > 10 * 60_000) {
      h.dropFrames();
      hubs.delete(id);
      if (latestId === id) latestId = undefined;
      log("hub.gc", { session: shortId(id) });
    }
  }
}, 60_000).unref();

// Stage metrics: fps decays and counters move without a message, so re-check once a second (sent only on change).
setInterval(() => {
  for (const h of hubs.values()) h.pushMetrics();
}, 1000).unref();

export function hubStats() {
  return { sessions: hubs.size, latest: latestId ? shortId(latestId) : null, floatingHuds: floatingHuds.size, floatingStages: floatingStages.size };
}
