import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  LiveState,
  Profile,
  ServerMsg,
  Verdict,
} from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { getHub, startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

type TransportMode = "live" | "snapshot" | "offline";

interface SessionCallbacks {
  onAudioChunk?: (b64Pcm24k: string) => void;
  onInterrupted?: () => void;
  onCheckingChange?: (checking: boolean) => void;
  onVerdict?: (verdict: Verdict, mode: TransportMode) => void;
  onCoach?: (cue: CoachCue, text: string) => void;
  onStateAnnouncement?: (message: string) => void;
}

interface SessionSnapshot {
  sessionId: string;
  mode: TransportMode;
  liveState: LiveState;
  activeModel: string | null;
  checking: boolean;
  coach: { cue: CoachCue; text: string } | null;
  verdict: Verdict | null;
  transcripts: Array<{ id: string; role: "user" | "assistant"; text: string; final: boolean; ts: number }>;
  device: DeviceState;
  hudConnected: boolean;
  network: { online: boolean; rttMs: number | null; targetFps: number; jpegQuality: number };
  permissions: { camera: string; microphone: string };
  cameraActive: boolean;
  autoStopRemainingSec: number | null;
  lastError: { code: string; message: string; recoverable: boolean } | null;
}

interface SessionManagerOptions {
  sessionId: string;
  initialProfile: Profile;
  wsUrlBuilder?: (sessionId: string) => string;
  createWs?: (url: string) => WsLike;
  fetchImpl?: typeof fetch;
  callbacks?: SessionCallbacks;
  autoStopMs?: number;
  pingIntervalMs?: number;
}

interface HoldUpSessionManagerInstance {
  subscribe(listener: (snap: SessionSnapshot) => void): () => void;
  getSnapshot(): SessionSnapshot;
  getBufferedFrames(): readonly string[];
  startSession(opts?: { voice?: boolean; preferredSource?: "phone" | "glasses" }): void;
  stopSession(reason?: string): void;
  sendFrame(frame: { data: string; w: number; h: number; sharpness: number; ts: number }): void;
  sendQuestion(text: string): Promise<void>;
  sendEvent(name: "log_dose" | "repeat" | "stop"): void;
}

type HoldUpSessionManagerCtor = new (opts: SessionManagerOptions) => HoldUpSessionManagerInstance;

interface HudState {
  connected: boolean;
  live: LiveState;
  coach: { cue: CoachCue; text: string } | null;
  verdict: Verdict | null;
  device: DeviceState | null;
  dismissed: boolean;
  speechEnabled: boolean;
  focusIndex: number;
}

let HoldUpSessionManager!: HoldUpSessionManagerCtor;
let initialHudState!: (opts?: { speechEnabled?: boolean }) => HudState;
let reduceHudServerMsg!: (state: HudState, msg: ServerMsg) => HudState;

const tempLedger = path.join(os.tmpdir(), `holdup-e2e-client-server-${process.pid}.jsonl`);
const fixtureJpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
const fixtureBase64 = fixtureJpg.toString("base64");

const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);

let prevApiKey = "";
let prevLedger = "";
let server: http.Server | null = null;
let port = 0;
let baseUrl = "";
let wsBase = "";
let trackedSockets: WebSocket[] = [];
let trackedManagers: HoldUpSessionManagerInstance[] = [];
let trackedSessionIds: string[] = [];

const sampleProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipine",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432100012345",
    },
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

function buildMatchVerdict(overrides: Partial<Verdict> = {}): Verdict {
  const emptyField = { value: null, confidence: 0 };
  const read: LabelRead = {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-09", confidence: 0.92 },
    allergens: { value: [], confidence: 0.9 },
    barcode: emptyField,
    readability: 0.95,
  };
  return {
    level: "match",
    headline: "Amlodipine 5 mg: match",
    speech: "Amlodipine 5 mg, your evening pill.",
    read,
    matchedMedId: "aml",
    reasons: ["Matches saved evening medication"],
    takenToday: false,
    ...overrides,
  };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 5);
  });
}

function wrapNodeWs(url: string): WsLike {
  const raw = new WebSocket(url);
  trackedSockets.push(raw);
  const adapter: WsLike = {
    get readyState() {
      return raw.readyState;
    },
    send(data: string) {
      raw.send(data);
    },
    close() {
      raw.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  raw.on("open", () => {
    adapter.onopen?.();
  });
  raw.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    adapter.onmessage?.({ data: text });
  });
  raw.on("close", () => {
    adapter.onclose?.();
  });
  raw.on("error", () => {
    adapter.onerror?.();
  });
  return adapter;
}

function createServerFetch(): typeof fetch {
  return (input, init) => {
    const resolved =
      typeof input === "string" && input.startsWith("/") ? `${baseUrl}${input}` : input;
    return globalThis.fetch(resolved, init);
  };
}

async function connectSessionlessHud() {
  const ws = new WebSocket(`${wsBase}/hud-ws`);
  trackedSockets.push(ws);
  let state = initialHudState();
  const received: ServerMsg[] = [];

  ws.on("open", () => {
    state = { ...state, connected: true };
  });
  ws.on("close", () => {
    state = { ...state, connected: false };
  });
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8")) as ServerMsg;
    received.push(msg);
    state = reduceHudServerMsg(state, msg);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    ws,
    received,
    getState: () => state,
    setState: (updater: (prev: HudState) => HudState) => {
      state = updater(state);
    },
  };
}

function createPhoneManager(
  sessionId: string,
  callbacks: SessionCallbacks = {},
  onWsCreated?: (url: string) => void
): HoldUpSessionManagerInstance {
  trackedSessionIds.push(sessionId);
  const manager = new HoldUpSessionManager({
    sessionId,
    initialProfile: sampleProfile,
    wsUrlBuilder: (sid) => `${wsBase}/live?session=${encodeURIComponent(sid)}`,
    createWs: (url) => {
      onWsCreated?.(url);
      return wrapNodeWs(url);
    },
    fetchImpl: createServerFetch(),
    callbacks,
  });
  trackedManagers.push(manager);
  return manager;
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;

  const sessionModUrl = new URL("../../web/src/session/sessionManager.ts", import.meta.url).href;
  const hudModUrl = new URL("../../web/src/hud/HudApp.tsx", import.meta.url).href;

  const sessionMod = (await import(sessionModUrl)) as {
    HoldUpSessionManager: HoldUpSessionManagerCtor;
  };
  const hudMod = (await import(hudModUrl)) as {
    initialHudState: (opts?: { speechEnabled?: boolean }) => HudState;
    reduceHudServerMsg: (state: HudState, msg: ServerMsg) => HudState;
  };

  HoldUpSessionManager = sessionMod.HoldUpSessionManager;
  initialHudState = hudMod.initialHudState;
  reduceHudServerMsg = hudMod.reduceHudServerMsg;
});

beforeEach(async () => {
  resetHubsForTest();
  trackedSockets = [];
  trackedManagers = [];
  trackedSessionIds = [];

  (ai.live as unknown as { connect: unknown }).connect = async () => ({
    close() {},
    sendRealtimeInput() {},
    sendToolResponse() {},
  });

  (ai.models as unknown as { generateContent: unknown }).generateContent = async () => ({
    text: JSON.stringify({
      kind: "medication",
      product: { value: "Norvasc", confidence: 0.97 },
      ingredient: { value: "amlodipine", confidence: 0.96 },
      strength: { value: "5 mg", confidence: 0.95 },
      dosing: { value: "1 tablet each evening", confidence: 0.91 },
      expiry: { value: "2027-09", confidence: 0.92 },
      allergens: { value: [], confidence: 0.9 },
      barcode: { value: "6432100012345", confidence: 0.98 },
      readability: 0.95,
    }),
  });

  server = await startServer(0);
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const mgr of trackedManagers) {
    mgr.stopSession();
  }
  await Promise.all(
    trackedSockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const killTimer = setTimeout(() => {
            try {
              ws.terminate();
            } catch {}
            resolve();
          }, 250);
          ws.once("close", () => {
            clearTimeout(killTimer);
            resolve();
          });
          try {
            ws.close();
          } catch {
            clearTimeout(killTimer);
            resolve();
          }
        })
    )
  );
  for (const sid of trackedSessionIds) {
    getHub(sid)?.live?.stop("test cleanup");
  }
  resetHubsForTest();
  if (server) {
    const activeServer = server;
    server = null;
    activeServer.closeAllConnections();
    await new Promise<void>((resolve) => activeServer.close(() => resolve()));
  }
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent =
    origGenerateContent;
});

after(() => {
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("zero-code 3-client pairing binds session-less /hud-ws, HoldUpSessionManager /live, and session-less DAT /ingest/state and /ingest/frame", async () => {
  const hud = await connectSessionlessHud();
  const manager = createPhoneManager("e2etest1");

  manager.startSession({ voice: true });

  await waitFor(
    () =>
      manager.getSnapshot().mode === "live" &&
      manager.getSnapshot().liveState === "open" &&
      manager.getSnapshot().hudConnected === true &&
      hud.getState().live === "open",
    "live session open and session-less HUD attached"
  );

  assert.equal(manager.getSnapshot().hudConnected, true);
  assert.equal(hud.getState().connected, true);

  const stateRes = await globalThis.fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 86, streaming: true }),
  });
  assert.equal(stateRes.status, 204);

  const frameRes = await globalThis.fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(fixtureJpg),
  });
  assert.equal(frameRes.status, 204);

  await waitFor(
    () =>
      manager.getSnapshot().device.battery === 86 &&
      hud.getState().device?.battery === 86,
    "DAT device state fan-out to phone manager and HUD"
  );

  const expectedDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 86,
    streaming: true,
    source: "glasses",
  };
  assert.deepEqual(manager.getSnapshot().device, expectedDevice);
  assert.deepEqual(hud.getState().device, expectedDevice);
  assert.equal(manager.getSnapshot().device.source, "glasses");

  const hub = getHub("e2etest1");
  assert.ok(hub);
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].source, "glasses");
  assert.equal(hub.ring.pick(1)[0].data, fixtureBase64);
});

test("automatic hardware state handoff switches source to phone on glasses doff and low battery < 15%", async () => {
  const announcements: string[] = [];
  const hud = await connectSessionlessHud();
  const manager = createPhoneManager("e2etest2", {
    onStateAnnouncement: (msg) => announcements.push(msg),
  });

  manager.startSession({ voice: true });
  await waitFor(
    () => manager.getSnapshot().liveState === "open" && manager.getSnapshot().hudConnected,
    "live session open"
  );

  const initialRes = await globalThis.fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 86, streaming: true }),
  });
  assert.equal(initialRes.status, 204);

  await waitFor(
    () => manager.getSnapshot().device.source === "glasses",
    "initial healthy glasses state"
  );

  const doffRes = await globalThis.fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: false, battery: 85, streaming: false }),
  });
  assert.equal(doffRes.status, 204);

  await waitFor(
    () =>
      manager.getSnapshot().device.battery === 85 &&
      hud.getState().device?.battery === 85,
    "glasses doffed telemetry delivered"
  );

  assert.equal(manager.getSnapshot().device.worn, false);
  assert.equal(manager.getSnapshot().device.source, "phone");
  assert.equal(hud.getState().device?.worn, false);
  assert.ok(
    announcements.some((a) => a.includes("Glasses taken off, switching to phone camera"))
  );

  const redonRes = await globalThis.fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 80, streaming: true }),
  });
  assert.equal(redonRes.status, 204);

  await waitFor(
    () =>
      manager.getSnapshot().device.battery === 80 &&
      manager.getSnapshot().device.source === "glasses",
    "glasses re-donned back to glasses source"
  );
  assert.equal(manager.getSnapshot().device.source, "glasses");

  const lowBatRes = await globalThis.fetch(`${baseUrl}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 9, streaming: true }),
  });
  assert.equal(lowBatRes.status, 204);

  await waitFor(
    () =>
      manager.getSnapshot().device.battery === 9 &&
      hud.getState().device?.battery === 9,
    "low battery telemetry delivered"
  );

  assert.equal(manager.getSnapshot().device.source, "phone");
  assert.equal(manager.getSnapshot().device.worn, true);
  assert.equal(manager.getSnapshot().device.battery, 9);
  assert.ok(
    announcements.some((a) => a.includes("Glasses battery low, switching to phone camera"))
  );
});

test("Neural Band /hud-ws log_dose and repeat round-trip updates server doseLog and syncs takenToday across phone and HUD", async () => {
  const phoneVerdicts: Verdict[] = [];
  const hud = await connectSessionlessHud();
  const manager = createPhoneManager("e2etest3", {
    onVerdict: (verdict) => phoneVerdicts.push(verdict),
  });

  manager.startSession({ voice: true });
  await waitFor(
    () => manager.getSnapshot().liveState === "open" && manager.getSnapshot().hudConnected,
    "live session open with HUD attached"
  );

  const hub = getHub("e2etest3");
  assert.ok(hub);
  assert.equal(hub.profile.doseLog.length, 0);

  const initialVerdict = buildMatchVerdict({ matchedMedId: "aml", takenToday: false });
  hub.emit({ type: "verdict", verdict: initialVerdict });

  await waitFor(
    () =>
      manager.getSnapshot().verdict?.matchedMedId === "aml" &&
      hud.getState().verdict?.matchedMedId === "aml",
    "initial match verdict delivered to phone and HUD"
  );

  assert.equal(manager.getSnapshot().verdict?.takenToday, false);
  assert.equal(hud.getState().verdict?.takenToday, false);
  assert.equal(phoneVerdicts.length, 1);

  hud.setState((prev) => ({ ...prev, dismissed: true }));
  assert.equal(hud.getState().dismissed, true);

  hud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));
  await waitFor(
    () => phoneVerdicts.length === 2 && hud.getState().dismissed === false,
    "repeat event re-emits verdict to phone and HUD"
  );
  assert.equal(manager.getSnapshot().verdict?.takenToday, false);
  assert.equal(hud.getState().verdict?.takenToday, false);

  const beforeDoseTs = Date.now();
  hud.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));

  await waitFor(
    () =>
      manager.getSnapshot().verdict?.takenToday === true &&
      hud.getState().verdict?.takenToday === true,
    "log_dose broadcasts takenToday true verdict to phone and HUD"
  );
  const afterDoseTs = Date.now();

  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  assert.ok(
    hub.profile.doseLog[0].ts >= beforeDoseTs && hub.profile.doseLog[0].ts <= afterDoseTs
  );
  assert.equal(hub.lastVerdict?.takenToday, true);
  assert.equal(manager.getSnapshot().verdict?.takenToday, true);
  assert.equal(hud.getState().verdict?.takenToday, true);
});

test("WebSocket drop degrades HoldUpSessionManager to snapshot mode, reconnects to /live, and wipes FrameRing on stopSession", async () => {
  const announcements: string[] = [];
  const wsAttempts: string[] = [];
  const hud = await connectSessionlessHud();
  const manager = createPhoneManager(
    "e2etest4",
    { onStateAnnouncement: (msg) => announcements.push(msg) },
    (url) => wsAttempts.push(url)
  );

  manager.startSession({ voice: true });
  await waitFor(
    () => manager.getSnapshot().mode === "live" && manager.getSnapshot().liveState === "open",
    "initial live connection open"
  );
  assert.equal(wsAttempts.length, 1);

  manager.sendFrame({
    data: fixtureBase64,
    w: 768,
    h: 768,
    sharpness: 0.91,
    ts: Date.now(),
  });

  const hub = getHub("e2etest4");
  assert.ok(hub);
  await waitFor(() => hub.ring.length === 1, "initial frame stored in server FrameRing");

  const [firstServerClient] = [...hub.clients];
  assert.ok(firstServerClient);
  firstServerClient.close();

  await waitFor(
    () =>
      manager.getSnapshot().mode === "snapshot" &&
      manager.getSnapshot().liveState === "reconnecting",
    "HoldUpSessionManager degrades to snapshot mode on WS drop"
  );
  assert.equal(manager.getSnapshot().mode, "snapshot");
  assert.ok(
    announcements.some((a) => a.includes("Connection interrupted, switched to snapshot mode"))
  );

  await manager.sendQuestion("Is this my evening pill?");
  await waitFor(
    () =>
      manager.getSnapshot().verdict?.matchedMedId === "aml" &&
      hud.getState().verdict?.matchedMedId === "aml",
    "snapshot fallback POST /api/verify delivers verdict to phone and HUD"
  );
  assert.equal(manager.getSnapshot().verdict?.level, "match");

  await waitFor(
    () =>
      wsAttempts.length >= 2 &&
      manager.getSnapshot().mode === "live" &&
      manager.getSnapshot().liveState === "open",
    "HoldUpSessionManager automatically reconnects to /live"
  );
  assert.equal(manager.getSnapshot().mode, "live");
  assert.equal(manager.getSnapshot().liveState, "open");
  assert.ok(announcements.some((a) => a.includes("Live connection restored")));

  const ingestRes = await globalThis.fetch(`${baseUrl}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(fixtureJpg),
  });
  assert.equal(ingestRes.status, 204);
  assert.equal(hub.ring.length, 1);
  assert.equal(manager.getBufferedFrames().length, 1);

  manager.stopSession();
  assert.equal(manager.getBufferedFrames().length, 0);
  assert.equal(manager.getSnapshot().cameraActive, false);
  assert.equal(manager.getSnapshot().liveState, "closed");

  await waitFor(
    () => hub.clients.size === 0 && hub.ring.length === 0,
    "server clears FrameRing when client stops session"
  );
  assert.equal(hub.ring.length, 0);
});
