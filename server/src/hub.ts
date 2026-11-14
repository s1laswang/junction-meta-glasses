// Session hubs: one per ?session= id. Holds the phone socket(s), HUD sockets, frame ring, profile (memory only)
// and the last verdict/coach/device for late HUDs. `session` is optional on /hud-ws and /ingest/*: those then
// follow the most recently started live session.
import type { WebSocket } from "ws";
import type { DeviceState, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { FrameRing, emptyProfile } from "./verify.ts";
import { log, shortId } from "./log.ts";

export interface LiveLike {
  handleEvent(name: string): void;
  stop(reason: string): void;
  readonly active: boolean;
}

const HUD_TYPES = new Set(["verdict", "coach", "status", "device"]);

export class Hub {
  clients = new Set<WebSocket>();
  huds = new Set<WebSocket>();
  ring = new FrameRing(8);
  profile: Profile = emptyProfile();
  live?: LiveLike;
  lastVerdict?: Verdict;
  lastCoach?: ServerMsg;
  lastStatus?: ServerMsg;
  device?: DeviceState;
  resume?: { handle: string; model: string; at: number };
  touchedAt = Date.now();
  constructor(readonly id: string) {}

  /** Send to the phone client(s) and, for HUD-relevant types, to HUDs (own + floating ones if this is the latest). */
  emit(msg: ServerMsg, opts: { clients?: boolean; hud?: boolean } = {}) {
    this.touchedAt = Date.now();
    if (msg.type === "verdict") this.lastVerdict = msg.verdict;
    if (msg.type === "coach") this.lastCoach = msg;
    if (msg.type === "status") this.lastStatus = msg;
    if (msg.type === "device") this.device = msg.device;
    const s = JSON.stringify(msg);
    if (opts.clients !== false) for (const c of this.clients) safeSend(c, s);
    if (opts.hud !== false && HUD_TYPES.has(msg.type)) for (const h of hudsFor(this)) safeSend(h, s);
  }
  /** Replay buffered state to a HUD that connects late. */
  replay(ws: WebSocket) {
    if (this.lastStatus) safeSend(ws, JSON.stringify(this.lastStatus));
    if (this.device) safeSend(ws, JSON.stringify({ type: "device", device: this.device }));
    if (this.lastCoach) safeSend(ws, JSON.stringify(this.lastCoach));
    if (this.lastVerdict) safeSend(ws, JSON.stringify({ type: "verdict", verdict: this.lastVerdict }));
  }
}

export function safeSend(ws: WebSocket, data: string) {
  try { if (ws.readyState === 1) ws.send(data); } catch { /* socket gone */ }
}

const hubs = new Map<string, Hub>();
let latestId: string | undefined;
/** HUDs connected without ?session=: they follow the latest live session. */
const floatingHuds = new Set<WebSocket>();
/** Device state that arrived while no session existed. */
let orphanDevice: DeviceState | undefined;

function hudsFor(h: Hub): WebSocket[] {
  return h.id === latestId ? [...h.huds, ...floatingHuds] : [...h.huds];
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
}

export function addHud(ws: WebSocket, id?: string | null) {
  if (id) {
    const h = getOrCreateHub(id);
    h.huds.add(ws);
    h.replay(ws);
    ws.on("close", () => h.huds.delete(ws));
    return;
  }
  floatingHuds.add(ws);
  const h = latestHub();
  if (h) h.replay(ws);
  else if (orphanDevice) safeSend(ws, JSON.stringify({ type: "device", device: orphanDevice }));
  ws.on("close", () => floatingHuds.delete(ws));
}
/** The hub a HUD event should go to. */
export function hudTarget(id?: string | null) { return resolveHub(id); }

export function setDevice(device: DeviceState, id?: string | null) {
  const h = resolveHub(id) ?? (id ? getOrCreateHub(id) : undefined);
  if (!h) {
    orphanDevice = device;
    const s = JSON.stringify({ type: "device", device });
    for (const ws of floatingHuds) safeSend(ws, s);
    return;
  }
  h.emit({ type: "device", device });
}

// Drop idle hubs (and their frames/profile) after 10 minutes without clients or activity.
setInterval(() => {
  const now = Date.now();
  for (const [id, h] of hubs) {
    if (h.clients.size === 0 && !h.live?.active && now - h.touchedAt > 10 * 60_000) {
      h.ring.clear();
      hubs.delete(id);
      if (latestId === id) latestId = undefined;
      log("hub.gc", { session: shortId(id) });
    }
  }
}, 60_000).unref();

export function hubStats() {
  return { sessions: hubs.size, latest: latestId ? shortId(latestId) : null, floatingHuds: floatingHuds.size };
}
