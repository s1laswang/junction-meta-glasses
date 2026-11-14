import type { WebSocket } from "ws";
import type { DeviceState, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { FrameRing, emptyProfile } from "./verify.ts";
import { log, shortId } from "./log.ts";

export const MAX_HUBS = 256;

export interface LiveLike {
  handleEvent(name: string): void;
  stop(reason: string): void;
  readonly active: boolean;
}

export interface HubRetentionSnapshot {
  sessions: number;
  activeClients: number;
  activeHuds: number;
  floatingHuds: number;
  bufferedFramesTotal: number;
  bufferedFrameBytes: number;
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
  replay(ws: WebSocket) {
    if (this.lastStatus) safeSend(ws, JSON.stringify(this.lastStatus));
    if (this.device) safeSend(ws, JSON.stringify({ type: "device", device: this.device }));
    if (this.lastCoach) safeSend(ws, JSON.stringify(this.lastCoach));
    if (this.lastVerdict) safeSend(ws, JSON.stringify({ type: "verdict", verdict: this.lastVerdict }));
  }

  replayClient(ws: WebSocket) {
    if (this.device) safeSend(ws, JSON.stringify({ type: "device", device: this.device }));
    safeSend(ws, JSON.stringify({ type: "hud", connected: hasHud(this) }));
  }
}

export function safeSend(ws: WebSocket, data: string) {
  try {
    if (
      ws.readyState === 1 &&
      (typeof (ws as any).bufferedAmount !== "number" || (ws as any).bufferedAmount <= 2 * 1024 * 1024)
    ) {
      ws.send(data);
    }
  } catch {}
}

const hubs = new Map<string, Hub>();
let latestId: string | undefined;
const floatingHuds = new Set<WebSocket>();
let orphanDevice: DeviceState | undefined;

function isIdleHub(h: Hub): boolean {
  return h.clients.size === 0 && h.huds.size === 0 && !h.live?.active;
}

function evictOldestIdleHub(): boolean {
  let oldestId: string | undefined;
  let oldestHub: Hub | undefined;
  for (const [id, h] of hubs) {
    if (!isIdleHub(h)) continue;
    if (!oldestHub || h.touchedAt < oldestHub.touchedAt) {
      oldestId = id;
      oldestHub = h;
    }
  }
  if (!oldestId || !oldestHub) return false;
  oldestHub.ring.clear();
  hubs.delete(oldestId);
  if (latestId === oldestId) latestId = undefined;
  return true;
}

function ringFrameBytes(ring: FrameRing): number {
  const internal = (ring as unknown as { frames?: ReadonlyArray<{ bytes?: number; data?: string }> }).frames;
  const frames = Array.isArray(internal)
    ? internal
    : ring.pick(ring.length, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER / 2);
  let bytes = 0;
  for (const f of frames) {
    if (typeof f.bytes === "number" && Number.isFinite(f.bytes) && f.bytes >= 0) {
      bytes += f.bytes;
    } else if (typeof f.data === "string") {
      bytes += Buffer.byteLength(f.data, "base64");
    }
  }
  return bytes;
}

function hudsFor(h: Hub): WebSocket[] {
  return h.id === latestId ? [...h.huds, ...floatingHuds] : [...h.huds];
}

export function hasHud(h: Hub): boolean {
  return h.huds.size > 0 || (h.id === latestId && floatingHuds.size > 0);
}

export function notifyHudState(h: Hub) {
  h.emit({ type: "hud", connected: hasHud(h) }, { hud: false });
}

export const getHub = (id: string) => hubs.get(id);
export function getOrCreateHub(id: string): Hub {
  let h = hubs.get(id);
  if (!h) {
    while (hubs.size >= MAX_HUBS) {
      if (!evictOldestIdleHub()) break;
    }
    h = new Hub(id);
    hubs.set(id, h);
  }
  h.touchedAt = Date.now();
  return h;
}
export const latestHub = () => (latestId ? hubs.get(latestId) : undefined);
export function resolveHub(id?: string | null): Hub | undefined {
  return id ? hubs.get(id) : latestHub();
}

export function markLatest(h: Hub) {
  const prev = latestHub();
  if (!hubs.has(h.id)) hubs.set(h.id, h);
  latestId = h.id;
  if (orphanDevice && !h.device) h.device = orphanDevice;
  for (const ws of floatingHuds) h.replay(ws);
  if (prev && prev !== h && floatingHuds.size > 0) notifyHudState(prev);
  notifyHudState(h);
}

export function addHud(ws: WebSocket, id?: string | null) {
  if (id) {
    const h = getOrCreateHub(id);
    h.huds.add(ws);
    h.replay(ws);
    notifyHudState(h);
    ws.on("close", () => {
      if (h.huds.delete(ws)) notifyHudState(h);
    });
    return;
  }
  floatingHuds.add(ws);
  const h = latestHub();
  if (h) {
    h.replay(ws);
    notifyHudState(h);
  } else if (orphanDevice) {
    safeSend(ws, JSON.stringify({ type: "device", device: orphanDevice }));
  }
  ws.on("close", () => {
    if (!floatingHuds.delete(ws)) return;
    const cur = latestHub();
    if (cur) notifyHudState(cur);
  });
}
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

export function sweepIdleHubs(now = Date.now(), maxIdleMs = 10 * 60_000): number {
  let evicted = 0;
  for (const [id, h] of hubs) {
    if (isIdleHub(h) && now - h.touchedAt > maxIdleMs) {
      h.ring.clear();
      hubs.delete(id);
      if (latestId === id) latestId = undefined;
      evicted++;
      log("hub.gc", { session: shortId(id) });
    }
  }
  return evicted;
}

setInterval(() => {
  sweepIdleHubs();
}, 60_000).unref();

export function hubStats() {
  return { sessions: hubs.size, latest: latestId ? shortId(latestId) : null, floatingHuds: floatingHuds.size };
}

export function hubRetentionSnapshot(): HubRetentionSnapshot {
  let activeClients = 0;
  let activeHuds = 0;
  let bufferedFramesTotal = 0;
  let bufferedFrameBytes = 0;
  for (const h of hubs.values()) {
    activeClients += h.clients.size;
    activeHuds += h.huds.size;
    bufferedFramesTotal += h.ring.length;
    bufferedFrameBytes += ringFrameBytes(h.ring);
  }
  return {
    sessions: hubs.size,
    activeClients,
    activeHuds,
    floatingHuds: floatingHuds.size,
    bufferedFramesTotal,
    bufferedFrameBytes,
  };
}

export function resetHubsForTest() {
  for (const h of hubs.values()) {
    h.clients.clear();
    h.huds.clear();
    h.ring.clear();
  }
  hubs.clear();
  floatingHuds.clear();
  latestId = undefined;
  orphanDevice = undefined;
}
