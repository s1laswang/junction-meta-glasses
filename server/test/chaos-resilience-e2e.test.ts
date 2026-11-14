import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type {
  CoachCue,
  DeviceState,
  LiveState,
  Profile,
  ServerMsg,
  Verdict,
} from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { getHub, startServer } from "../src/index.ts";
import { jpegSharpness } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

const DOUBLE_SLASH = "\x2f\x2f";

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

interface ChaosConfig {
  forceWsDrop: boolean;
  forceOffline: boolean;
  simulateGlassesDoffed: boolean;
  simulateLowBattery: boolean;
}

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
  updateProfile(profile: Profile): void;
  setChaos(chaos: ChaosConfig): void;
  setOnline(online: boolean): void;
  sendFrame(frame: { data: string; w: number; h: number; sharpness: number; ts: number }): void;
  sendQuestion(text: string): Promise<void>;
  verifySnapshot(frames: string[], question?: string): Promise<Verdict | null>;
  applyLocalVerdict(verdict: Verdict): void;
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

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let HoldUpSessionManager!: HoldUpSessionManagerCtor;
let initialHudState!: (opts?: { speechEnabled?: boolean }) => HudState;
let reduceHudServerMsg!: (state: HudState, msg: ServerMsg) => HudState;
let buildHudWsUrl!: (
  sessionParam?: string | null,
  locationLike?: { protocol?: string; host?: string; search?: string }
) => string;
let nextFocusIndex!: (current: number, count: number, key: string) => number;
let offlineBarcodeVerdict!: (barcode: string, profile: Profile, now?: Date) => Verdict;
let appendDoseLog!: (
  profile: Profile,
  medId: string,
  ts?: number,
  storage?: KeyValueStorage
) => Profile;

const CLEAR_CHAOS: ChaosConfig = {
  forceWsDrop: false,
  forceOffline: false,
  simulateGlassesDoffed: false,
  simulateLowBattery: false,
};

const tempLedger = path.join(os.tmpdir(), `holdup-chaos-resilience-e2e-${process.pid}.jsonl`);
const fixturesDir = path.join(REPO_ROOT, "web", "public", "fixtures");
const sharpAmlodipineJpg = fs.readFileSync(path.join(fixturesDir, "amlodipine.jpg"));
const blurryAmlodipineJpg = fs.readFileSync(path.join(fixturesDir, "blurry_amlodipine.jpg"));
const sharpBase64 = sharpAmlodipineJpg.toString("base64");
const blurryBase64 = blurryAmlodipineJpg.toString("base64");

const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);
const origModelsGet = ai.models.get.bind(ai.models);

let prevApiKey = "";
let prevLedger = "";
let server: http.Server | null = null;
let port = 0;
let baseUrl = "";
let wsBase = "";

let trackedSockets: WebSocket[] = [];
let trackedManagers: HoldUpSessionManagerInstance[] = [];
let trackedSessionIds: string[] = [];

let liveConnectCalls = 0;
let generateCalls = 0;
let seenVerifyCalls: Array<{ frames: string[]; prompt: string }> = [];

const baseProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432100012345",
    },
    {
      id: "met",
      name: "Metforem",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["morning", "evening"],
      barcode: "6432100098765",
    },
  ],
  allergies: ["hazelnut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

function createMemoryStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => {
      store.set(key, val);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function cloneProfile(profile: Profile): Profile {
  return {
    meds: profile.meds.map((m) => ({ ...m, schedule: [...m.schedule] })),
    allergies: [...profile.allergies],
    avoid: [...profile.avoid],
    doseLog: profile.doseLog.map((d) => ({ ...d })),
    lang: profile.lang,
  };
}

function hasDoseLoggedToday(profile: Profile, medId: string, now = new Date()): boolean {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return profile.doseLog.some(
    (entry) => entry.medId === medId && entry.ts >= start.getTime() && entry.ts <= end.getTime()
  );
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 2500): Promise<void> {
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

function wrapNodeWs(
  url: string,
  hooks?: {
    onSend?: (payload: string) => void;
    onServerMsg?: (msg: ServerMsg) => void;
  }
): WsLike {
  const raw = new WebSocket(url);
  trackedSockets.push(raw);
  const adapter: WsLike = {
    get readyState() {
      return raw.readyState;
    },
    send(data: string) {
      hooks?.onSend?.(data);
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
    try {
      const parsed = JSON.parse(text) as ServerMsg;
      hooks?.onServerMsg?.(parsed);
    } catch {}
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

async function connectHudClient(sessionId?: string) {
  const hudUrl = buildHudWsUrl(sessionId ?? null, {
    protocol: "ws:",
    host: `127.0.0.1:${port}`,
  });
  const ws = new WebSocket(hudUrl);
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
    url: hudUrl,
    received,
    getState: () => state,
    sendEvent: (name: "log_dose" | "repeat" | "dismiss") => {
      ws.send(JSON.stringify({ type: "event", name }));
    },
  };
}

function createPhoneRig(sessionId: string, initialProfile: Profile = baseProfile) {
  trackedSessionIds.push(sessionId);
  const storage = createMemoryStorage();
  let phoneProfile = cloneProfile(initialProfile);

  const announcements: string[] = [];
  const verdicts: Array<{ verdict: Verdict; mode: TransportMode }> = [];
  const coaches: Array<{ cue: CoachCue; text: string }> = [];
  const checkingTransitions: boolean[] = [];
  const httpRequests: Array<{ url: string; method: string }> = [];
  const wsAttempts: string[] = [];
  const wsSentPayloads: string[] = [];
  const liveWireMessages: ServerMsg[] = [];

  let manager!: HoldUpSessionManagerInstance;

  const fetchImpl: typeof fetch = (input, init) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    const resolved = rawUrl.startsWith("/") ? `${baseUrl}${rawUrl}` : rawUrl;
    httpRequests.push({ url: resolved, method: (init?.method ?? "GET").toUpperCase() });
    return globalThis.fetch(resolved, init);
  };

  manager = new HoldUpSessionManager({
    sessionId,
    initialProfile: phoneProfile,
    wsUrlBuilder: (sid) => `${wsBase}/live?session=${encodeURIComponent(sid)}`,
    createWs: (url) => {
      wsAttempts.push(url);
      return wrapNodeWs(url, {
        onSend: (payload) => wsSentPayloads.push(payload),
        onServerMsg: (msg) => liveWireMessages.push(msg),
      });
    },
    fetchImpl,
    callbacks: {
      onStateAnnouncement: (msg) => announcements.push(msg),
      onCoach: (cue, text) => coaches.push({ cue, text }),
      onCheckingChange: (checking) => checkingTransitions.push(checking),
      onVerdict: (verdict, mode) => {
        verdicts.push({ verdict, mode });
        if (
          verdict.matchedMedId &&
          verdict.takenToday === true &&
          !hasDoseLoggedToday(phoneProfile, verdict.matchedMedId)
        ) {
          phoneProfile = appendDoseLog(phoneProfile, verdict.matchedMedId, Date.now(), storage);
          manager.updateProfile(phoneProfile);
        }
      },
    },
  });

  trackedManagers.push(manager);

  const dropLiveWs = (mode: "chaos" | "socket" = "socket") => {
    if (mode === "chaos") {
      manager.setChaos({ ...CLEAR_CHAOS, forceWsDrop: true });
      return;
    }
    const hub = getHub(sessionId);
    assert.ok(hub, `Expected active hub for ${sessionId}`);
    assert.ok(hub.clients.size > 0, `Expected open /live socket for ${sessionId}`);
    for (const clientWs of [...hub.clients]) {
      clientWs.close();
    }
  };

  const scanOfflineBarcode = (barcode: string, now = new Date()): Verdict => {
    const verdict = offlineBarcodeVerdict(barcode, phoneProfile, now);
    manager.applyLocalVerdict(verdict);
    return verdict;
  };

  return {
    manager,
    storage,
    getProfile: () => cloneProfile(phoneProfile),
    announcements,
    verdicts,
    coaches,
    checkingTransitions,
    httpRequests,
    wsAttempts,
    wsSentPayloads,
    liveWireMessages,
    dropLiveWs,
    scanOfflineBarcode,
  };
}

async function postDatState(
  sessionId: string,
  state: { connected: boolean; worn: boolean; battery: number | null; streaming: boolean }
): Promise<void> {
  const res = await globalThis.fetch(
    `${baseUrl}/ingest/state?session=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
    }
  );
  assert.equal(res.status, 204);
}

async function postDatFrame(sessionId: string, jpg: Buffer): Promise<void> {
  const res = await globalThis.fetch(
    `${baseUrl}/ingest/frame?session=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(jpg),
    }
  );
  assert.equal(res.status, 204);
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;

  const sessionModUrl = new URL("../../web/src/session/sessionManager.ts", import.meta.url).href;
  const hudModUrl = new URL("../../web/src/hud/HudApp.tsx", import.meta.url).href;
  const barcodeModUrl = new URL("../../web/src/camera/barcode.ts", import.meta.url).href;
  const profileStoreModUrl = new URL("../../web/src/storage/profileStore.ts", import.meta.url).href;

  const [sessionMod, hudMod, barcodeMod, profileStoreMod] = await Promise.all([
    import(sessionModUrl) as Promise<{ HoldUpSessionManager: HoldUpSessionManagerCtor }>,
    import(hudModUrl) as Promise<{
      initialHudState: (opts?: { speechEnabled?: boolean }) => HudState;
      reduceHudServerMsg: (state: HudState, msg: ServerMsg) => HudState;
      buildHudWsUrl: (
        sessionParam?: string | null,
        locationLike?: { protocol?: string; host?: string; search?: string }
      ) => string;
      nextFocusIndex: (current: number, count: number, key: string) => number;
    }>,
    import(barcodeModUrl) as Promise<{
      offlineBarcodeVerdict: (barcode: string, profile: Profile, now?: Date) => Verdict;
    }>,
    import(profileStoreModUrl) as Promise<{
      appendDoseLog: (
        profile: Profile,
        medId: string,
        ts?: number,
        storage?: KeyValueStorage
      ) => Profile;
    }>,
  ]);

  HoldUpSessionManager = sessionMod.HoldUpSessionManager;
  initialHudState = hudMod.initialHudState;
  reduceHudServerMsg = hudMod.reduceHudServerMsg;
  buildHudWsUrl = hudMod.buildHudWsUrl;
  nextFocusIndex = hudMod.nextFocusIndex;
  offlineBarcodeVerdict = barcodeMod.offlineBarcodeVerdict;
  appendDoseLog = profileStoreMod.appendDoseLog;
});

beforeEach(async () => {
  resetHubsForTest();
  trackedSockets = [];
  trackedManagers = [];
  trackedSessionIds = [];
  liveConnectCalls = 0;
  generateCalls = 0;
  seenVerifyCalls = [];

  (ai.models as unknown as { get: unknown }).get = async () => {
    throw new Error("real Gemini models.get forbidden in chaos-resilience-e2e");
  };

  (ai.live as unknown as { connect: unknown }).connect = async () => {
    liveConnectCalls += 1;
    return {
      close() {},
      sendRealtimeInput() {},
      sendToolResponse() {},
    };
  };

  (ai.models as unknown as { generateContent: unknown }).generateContent = async (params: {
    contents?: Array<{ parts?: Array<{ inlineData?: { data?: string }; text?: string }> }>;
  }) => {
    generateCalls += 1;
    const parts = params?.contents?.[0]?.parts ?? [];
    const frames = parts
      .filter((p) => typeof p.inlineData?.data === "string")
      .map((p) => String(p.inlineData?.data));
    const prompt = String(parts.find((p) => typeof p.text === "string")?.text ?? "");
    seenVerifyCalls.push({ frames, prompt });

    const topFrameIsSharp = frames[0] === sharpBase64;
    if (!topFrameIsSharp) {
      return {
        text: JSON.stringify({
          kind: "medication",
          product: { value: "Norvasc", confidence: 0.72 },
          ingredient: { value: "amlodipine", confidence: 0.7 },
          strength: { value: null, confidence: 0.25 },
          dosing: { value: null, confidence: 0 },
          expiry: { value: null, confidence: 0 },
          allergens: { value: [], confidence: 0.6 },
          barcode: { value: null, confidence: 0 },
          readability: 0.3,
          guidance: "Hold steady so the strength text sharpens.",
        }),
      };
    }

    return {
      text: JSON.stringify({
        kind: "medication",
        product: { value: "Norvasc", confidence: 0.98 },
        ingredient: { value: "amlodipine", confidence: 0.97 },
        strength: { value: "5 mg", confidence: 0.96 },
        dosing: { value: "1 tablet each evening", confidence: 0.92 },
        expiry: { value: "2027-09", confidence: 0.93 },
        allergens: { value: [], confidence: 0.91 },
        barcode: { value: "6432100012345", confidence: 0.99 },
        readability: 0.96,
      }),
    };
  };

  server = await startServer(0);
  port = (server.address() as AddressInfo).port;
  baseUrl = `http:${DOUBLE_SLASH}127.0.0.1:${port}`;
  wsBase = `ws:${DOUBLE_SLASH}127.0.0.1:${port}`;
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
  (ai.models as unknown as { get: typeof origModelsGet }).get = origModelsGet;
});

after(() => {
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("paired 3-client session handles dropLiveWs snapshot fallback, sharpness-ranked POST /api/verify in any frame order, HUD fan-out, and Neural Band log_dose sync", async () => {
  const sharpScore = jpegSharpness(sharpAmlodipineJpg);
  const blurryScore = jpegSharpness(blurryAmlodipineJpg);
  assert.ok(
    sharpScore > blurryScore,
    `Expected sharp amlodipine.jpg (${sharpScore}) > blurry_amlodipine.jpg (${blurryScore})`
  );

  const sessionId = "chaos-s1-dropws";
  const hud = await connectHudClient(sessionId);
  assert.equal(hud.url, `ws:${DOUBLE_SLASH}127.0.0.1:${port}/hud-ws?session=${sessionId}`);

  const rig = createPhoneRig(sessionId);
  rig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      rig.manager.getSnapshot().hudConnected === true &&
      hud.getState().live === "open",
    "paired /live and /hud-ws?session=... open"
  );

  await postDatState(sessionId, { connected: true, worn: true, battery: 84, streaming: true });
  await postDatFrame(sessionId, blurryAmlodipineJpg);
  await postDatFrame(sessionId, sharpAmlodipineJpg);

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.battery === 84 &&
      rig.manager.getSnapshot().device.source === "glasses" &&
      hud.getState().device?.battery === 84,
    "Android DAT state synced to phone and HUD"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.ring.length, 2);
  const ringPicked = hub.ring.pick(2);
  assert.equal(ringPicked[0].data, sharpBase64);
  assert.equal(ringPicked[1].data, blurryBase64);
  assert.equal(ringPicked[0].source, "glasses");

  rig.dropLiveWs("chaos");
  assert.equal(rig.manager.getSnapshot().mode, "snapshot");
  assert.equal(rig.manager.getSnapshot().liveState, "degraded");
  assert.ok(
    rig.announcements.some((a) => a.toLowerCase().includes("snapshot mode")),
    "Expected state announcement for transition to snapshot mode"
  );
  await waitFor(
    () => hub.clients.size === 0 && hud.getState().live === "closed",
    "server closed /live client on chaos forceWsDrop"
  );

  const verdictOrderA = await rig.manager.verifySnapshot(
    [blurryBase64, sharpBase64],
    "Is this my evening pill?"
  );
  assert.ok(verdictOrderA);
  assert.equal(verdictOrderA.level, "match");
  assert.equal(verdictOrderA.matchedMedId, "aml");
  assert.equal(verdictOrderA.takenToday, false);
  assert.equal(seenVerifyCalls.length, 1);
  assert.deepEqual(seenVerifyCalls[0].frames, [sharpBase64, blurryBase64]);

  await waitFor(
    () => hud.getState().verdict?.matchedMedId === "aml",
    "POST /api/verify verdict fanned out to /hud-ws?session=..."
  );
  assert.equal(hud.getState().verdict?.level, "match");
  assert.equal(hud.getState().verdict?.takenToday, false);

  rig.manager.setChaos(CLEAR_CHAOS);
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open",
    "live session restored before server socket drop test"
  );

  rig.manager.sendFrame({
    data: sharpBase64,
    w: 768,
    h: 768,
    sharpness: sharpScore,
    ts: Date.now(),
  });
  rig.manager.sendFrame({
    data: blurryBase64,
    w: 768,
    h: 768,
    sharpness: blurryScore,
    ts: Date.now() + 10,
  });

  rig.dropLiveWs("socket");
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "snapshot" &&
      rig.manager.getSnapshot().liveState === "reconnecting",
    "socket drop transitions HoldUpSessionManager to snapshot mode"
  );

  await rig.manager.sendQuestion("Confirm evening pill strength");
  assert.equal(seenVerifyCalls.length, 2);
  assert.deepEqual(seenVerifyCalls[1].frames, [sharpBase64, blurryBase64]);
  assert.equal(rig.manager.getSnapshot().verdict?.level, "match");
  assert.equal(rig.manager.getSnapshot().verdict?.matchedMedId, "aml");
  assert.equal(rig.manager.getSnapshot().verdict?.takenToday, false);

  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open",
    "HoldUpSessionManager auto-reconnects to /live after socket drop"
  );

  const focusedIdx = nextFocusIndex(hud.getState().focusIndex, 3, "ArrowLeft");
  assert.equal(focusedIdx, 0);
  hud.sendEvent("log_dose");

  await waitFor(
    () =>
      hud.getState().verdict?.takenToday === true &&
      rig.manager.getSnapshot().verdict?.takenToday === true,
    "Neural Band log_dose over /hud-ws updates takenToday on both HUD and phone"
  );

  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  assert.equal(rig.getProfile().doseLog.length, 1);
  assert.equal(rig.getProfile().doseLog[0].medId, "aml");
  assert.equal(hud.getState().verdict?.takenToday, true);
  assert.equal(rig.manager.getSnapshot().verdict?.takenToday, true);
});

test("forceOffline transitions to offline mode with 0 HTTP/WS requests, catches same-day double-dose warning via offlineBarcodeVerdict, and auto-recovers to live", async () => {
  const sessionId = "chaos-s2-offline";
  const hud = await connectHudClient(sessionId);
  const rig = createPhoneRig(sessionId);

  rig.manager.startSession({ voice: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      hud.getState().live === "open",
    "initial paired live session open"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);

  rig.dropLiveWs("chaos");
  assert.equal(rig.manager.getSnapshot().mode, "snapshot");
  await waitFor(
    () => hub.clients.size === 0 && hud.getState().live === "closed",
    "server closed /live client on chaos forceWsDrop in test 2"
  );
  await rig.manager.verifySnapshot([blurryBase64, sharpBase64], "Is this my evening pill?");
  await waitFor(
    () => hud.getState().verdict?.matchedMedId === "aml",
    "snapshot verdict delivered to HUD"
  );

  rig.manager.setChaos(CLEAR_CHAOS);
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open",
    "live session reconnected before Neural Band log_dose"
  );

  hud.sendEvent("log_dose");
  await waitFor(
    () =>
      hud.getState().verdict?.takenToday === true &&
      rig.manager.getSnapshot().verdict?.takenToday === true,
    "dose logged across HUD and phone"
  );
  assert.equal(rig.getProfile().doseLog.length, 1);

  const httpBeforeOffline = rig.httpRequests.length;
  const wsAttemptsBeforeOffline = rig.wsAttempts.length;
  const wsSentBeforeOffline = rig.wsSentPayloads.length;
  const generateBeforeOffline = generateCalls;
  const liveConnectBeforeOffline = liveConnectCalls;

  rig.manager.setChaos({ ...CLEAR_CHAOS, forceOffline: true });

  assert.equal(rig.manager.getSnapshot().mode, "offline");
  assert.equal(rig.manager.getSnapshot().liveState, "closed");
  assert.equal(rig.manager.getSnapshot().network.online, false);
  assert.ok(
    rig.announcements.some((a) => a.includes("Offline mode active")),
    "Expected offline mode state announcement"
  );

  await waitFor(
    () => hub.clients.size === 0 && hud.getState().live === "closed",
    "server observed /live close on forceOffline"
  );

  await rig.manager.sendQuestion("Can I take another tablet?");
  assert.equal(rig.manager.getSnapshot().lastError?.code, "offline");
  const blockedSnapshot = await rig.manager.verifySnapshot([sharpBase64], "Verify offline");
  assert.equal(blockedSnapshot, null);

  const doubleDoseVerdict = rig.scanOfflineBarcode("6432 1000-12345");
  assert.equal(doubleDoseVerdict.level, "warning");
  assert.equal(doubleDoseVerdict.matchedMedId, "aml");
  assert.equal(doubleDoseVerdict.takenToday, true);
  assert.ok(doubleDoseVerdict.reasons.some((r) => r.includes("taken today: 1/1")));
  assert.match(doubleDoseVerdict.headline, /already taken/i);
  assert.match(doubleDoseVerdict.speech, /already took it today/i);
  assert.equal(rig.manager.getSnapshot().verdict?.level, "warning");
  assert.equal(rig.manager.getSnapshot().verdict?.takenToday, true);

  const unknownOfflineVerdict = rig.scanOfflineBarcode("6412345000999");
  assert.equal(unknownOfflineVerdict.level, "unsure");

  assert.equal(rig.httpRequests.length, httpBeforeOffline);
  assert.equal(rig.wsAttempts.length, wsAttemptsBeforeOffline);
  assert.equal(rig.wsSentPayloads.length, wsSentBeforeOffline);
  assert.equal(generateCalls, generateBeforeOffline);
  assert.equal(liveConnectCalls, liveConnectBeforeOffline);

  rig.manager.setChaos(CLEAR_CHAOS);

  await waitFor(
    () =>
      rig.wsAttempts.length === wsAttemptsBeforeOffline + 1 &&
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      rig.manager.getSnapshot().network.online === true &&
      hud.getState().live === "open",
    "clearing forceOffline automatically recovers session to live"
  );

  assert.ok(rig.announcements.some((a) => a.includes("Live connection restored")));
  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
});

test("mid-check DAT battery drop (80 -> 11) and doff (worn: false) sync telemetry to /live and /hud-ws, hot-swap eye to phone without losing state, and wipe FrameRing on stopSession", async () => {
  const sessionId = "chaos-s3-hardware";
  const hud = await connectHudClient(sessionId);
  const rig = createPhoneRig(sessionId);

  rig.manager.startSession({ voice: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      rig.manager.getSnapshot().hudConnected === true &&
      hud.getState().live === "open",
    "paired live session open"
  );

  await postDatState(sessionId, { connected: true, worn: true, battery: 80, streaming: true });
  await postDatFrame(sessionId, sharpAmlodipineJpg);
  await postDatFrame(sessionId, blurryAmlodipineJpg);

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.battery === 80 &&
      rig.manager.getSnapshot().device.source === "glasses" &&
      hud.getState().device?.battery === 80,
    "healthy DAT battery 80 synced to phone and HUD"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.ring.length, 2);

  await rig.manager.sendQuestion("Is this Amlodipine 5 mg?");
  hub.emit({ type: "checking", phase: "start" });
  hub.emit({ type: "coach", cue: "hold_still", text: "Hold still, reading label" });

  await waitFor(
    () =>
      rig.manager.getSnapshot().checking === true &&
      rig.manager.getSnapshot().coach?.cue === "hold_still" &&
      hud.getState().coach?.cue === "hold_still",
    "mid-check coaching and checking state active across phone and HUD"
  );

  const wsAttemptsBeforeSwap = rig.wsAttempts.length;
  const transcriptsBeforeSwap = rig.manager.getSnapshot().transcripts.length;
  assert.ok(transcriptsBeforeSwap >= 1);

  await postDatState(sessionId, { connected: true, worn: true, battery: 11, streaming: true });

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.battery === 11 &&
      hud.getState().device?.battery === 11,
    "DAT battery drop 80 -> 11 delivered to /live and /hud-ws"
  );

  const liveLowBatMsg = [...rig.liveWireMessages]
    .reverse()
    .find((m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device");
  assert.deepEqual(liveLowBatMsg?.device, {
    connected: true,
    worn: true,
    battery: 11,
    streaming: true,
    source: "glasses",
  });
  assert.deepEqual(hud.getState().device, {
    connected: true,
    worn: true,
    battery: 11,
    streaming: true,
    source: "glasses",
  });

  assert.equal(rig.manager.getSnapshot().device.source, "phone");
  assert.equal(rig.manager.getSnapshot().device.battery, 11);
  assert.equal(rig.manager.getSnapshot().device.worn, true);
  assert.ok(
    rig.announcements.some((a) => a.includes("Glasses battery low, switching to phone camera"))
  );

  assert.equal(rig.manager.getSnapshot().mode, "live");
  assert.equal(rig.manager.getSnapshot().liveState, "open");
  assert.equal(rig.manager.getSnapshot().cameraActive, true);
  assert.equal(rig.manager.getSnapshot().checking, true);
  assert.equal(rig.manager.getSnapshot().coach?.cue, "hold_still");
  assert.equal(rig.manager.getSnapshot().transcripts.length, transcriptsBeforeSwap);
  assert.equal(rig.wsAttempts.length, wsAttemptsBeforeSwap);

  await postDatState(sessionId, { connected: true, worn: true, battery: 80, streaming: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().device.battery === 80 &&
      rig.manager.getSnapshot().device.source === "glasses",
    "glasses battery recovered to 80"
  );

  await postDatState(sessionId, { connected: true, worn: false, battery: 11, streaming: false });

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.worn === false &&
      rig.manager.getSnapshot().device.battery === 11 &&
      hud.getState().device?.worn === false &&
      hud.getState().device?.battery === 11,
    "DAT doff worn: false + battery: 11 synced to /live and /hud-ws"
  );

  assert.deepEqual(hud.getState().device, {
    connected: true,
    worn: false,
    battery: 11,
    streaming: false,
    source: "glasses",
  });
  assert.equal(rig.manager.getSnapshot().device.source, "phone");
  assert.equal(rig.manager.getSnapshot().device.worn, false);
  assert.equal(rig.manager.getSnapshot().device.battery, 11);
  assert.ok(
    rig.announcements.some((a) => a.includes("Glasses taken off, switching to phone camera"))
  );

  assert.equal(rig.manager.getSnapshot().mode, "live");
  assert.equal(rig.manager.getSnapshot().liveState, "open");
  assert.equal(rig.manager.getSnapshot().cameraActive, true);
  assert.equal(rig.manager.getSnapshot().checking, true);
  assert.equal(rig.manager.getSnapshot().coach?.cue, "hold_still");
  assert.equal(rig.manager.getSnapshot().transcripts.length, transcriptsBeforeSwap);
  assert.equal(rig.wsAttempts.length, wsAttemptsBeforeSwap);

  rig.manager.sendFrame({
    data: sharpBase64,
    w: 768,
    h: 768,
    sharpness: jpegSharpness(sharpAmlodipineJpg),
    ts: Date.now(),
  });
  await waitFor(() => hub.ring.length === 3, "phone fallback frame appended to server FrameRing");
  assert.equal(rig.manager.getBufferedFrames().length, 1);

  rig.manager.stopSession();
  assert.equal(rig.manager.getBufferedFrames().length, 0);
  assert.equal(rig.manager.getSnapshot().cameraActive, false);
  assert.equal(rig.manager.getSnapshot().liveState, "closed");

  await waitFor(
    () => hub.clients.size === 0 && hub.ring.length === 0 && hud.getState().live === "closed",
    "stopSession wipes server FrameRing to 0 and closes live proxy"
  );
  assert.equal(hub.ring.length, 0);
  assert.deepEqual(hub.ring.pick(2), []);
});

test("full 4-surface end-to-end chaos gauntlet chains dropLiveWs, sharpness verify, HUD log_dose, forceOffline double-dose catch, live recovery, DAT 80->11 & doff hot-swap, and FrameRing wipe", async () => {
  const sessionId = "chaos-gauntlet-full";
  const hud = await connectHudClient(sessionId);
  const rig = createPhoneRig(sessionId);

  rig.manager.startSession({ voice: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      rig.manager.getSnapshot().hudConnected === true &&
      hud.getState().live === "open",
    "4-surface session live"
  );

  await postDatState(sessionId, { connected: true, worn: true, battery: 80, streaming: true });
  await postDatFrame(sessionId, blurryAmlodipineJpg);
  await postDatFrame(sessionId, sharpAmlodipineJpg);

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.source === "glasses" &&
      rig.manager.getSnapshot().device.battery === 80 &&
      hud.getState().device?.battery === 80,
    "DAT glasses telemetry active at 80%"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.ring.length, 2);
  assert.equal(hub.ring.pick(2)[0].data, sharpBase64);

  rig.dropLiveWs("socket");
  await waitFor(
    () => rig.manager.getSnapshot().mode === "snapshot",
    "dropLiveWs transitions to snapshot mode"
  );

  const v1 = await rig.manager.verifySnapshot(
    [blurryBase64, sharpBase64],
    "Is this my evening pill?"
  );
  const v2 = await rig.manager.verifySnapshot(
    [sharpBase64, blurryBase64],
    "Is this my evening pill?"
  );
  assert.equal(v1?.level, "match");
  assert.equal(v2?.level, "match");
  assert.equal(seenVerifyCalls.length, 2);
  assert.deepEqual(seenVerifyCalls[0].frames, [sharpBase64, blurryBase64]);
  assert.deepEqual(seenVerifyCalls[1].frames, [sharpBase64, blurryBase64]);

  await waitFor(
    () =>
      hud.getState().verdict?.matchedMedId === "aml" &&
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open",
    "HUD received snapshot verdict and /live reconnected"
  );

  hud.sendEvent("log_dose");
  await waitFor(
    () =>
      hud.getState().verdict?.takenToday === true &&
      rig.manager.getSnapshot().verdict?.takenToday === true,
    "Neural Band log_dose synced takenToday true to HUD and phone"
  );

  const httpAtOfflineStart = rig.httpRequests.length;
  const wsAtOfflineStart = rig.wsAttempts.length;
  const wsSentAtOfflineStart = rig.wsSentPayloads.length;

  rig.manager.setChaos({ ...CLEAR_CHAOS, forceOffline: true });
  assert.equal(rig.manager.getSnapshot().mode, "offline");
  assert.equal(rig.manager.getSnapshot().liveState, "closed");

  await waitFor(
    () => hub.clients.size === 0 && hud.getState().live === "closed",
    "gauntlet server observed /live close on forceOffline"
  );

  const offlineDoubleDose = rig.scanOfflineBarcode("6432100012345");
  assert.equal(offlineDoubleDose.level, "warning");
  assert.equal(offlineDoubleDose.matchedMedId, "aml");
  assert.equal(offlineDoubleDose.takenToday, true);
  assert.equal(rig.httpRequests.length, httpAtOfflineStart);
  assert.equal(rig.wsAttempts.length, wsAtOfflineStart);
  assert.equal(rig.wsSentPayloads.length, wsSentAtOfflineStart);

  rig.manager.setChaos(CLEAR_CHAOS);
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      hud.getState().live === "open",
    "auto-recovery from offline to live"
  );

  await postDatState(sessionId, { connected: true, worn: true, battery: 80, streaming: true });
  await postDatFrame(sessionId, sharpAmlodipineJpg);
  await waitFor(
    () => rig.manager.getSnapshot().device.source === "glasses" && hub.ring.length === 1,
    "glasses streaming resumed on recovered live session"
  );

  const wsBeforeDatFaults = rig.wsAttempts.length;
  await postDatState(sessionId, { connected: true, worn: true, battery: 11, streaming: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().device.battery === 11 &&
      hud.getState().device?.battery === 11 &&
      rig.manager.getSnapshot().device.source === "phone",
    "battery 80 -> 11 hot-swapped eye to phone"
  );

  await postDatState(sessionId, { connected: true, worn: false, battery: 11, streaming: false });
  await waitFor(
    () =>
      rig.manager.getSnapshot().device.worn === false &&
      hud.getState().device?.worn === false,
    "doff worn: false synchronized across /live and /hud-ws"
  );
  assert.equal(rig.manager.getSnapshot().device.source, "phone");
  assert.equal(rig.manager.getSnapshot().mode, "live");
  assert.equal(rig.manager.getSnapshot().liveState, "open");
  assert.equal(rig.wsAttempts.length, wsBeforeDatFaults);
  assert.equal(hub.profile.doseLog.length, 1);

  rig.manager.stopSession();
  await waitFor(
    () => hub.clients.size === 0 && hub.ring.length === 0,
    "FrameRing wiped to 0 on stopSession"
  );
  assert.equal(hub.ring.length, 0);
  assert.equal(rig.manager.getBufferedFrames().length, 0);
});

test("upstream Gemini Live exhaustion degrades /live to snapshot mode while keeping /live WS open so HUD log_dose still updates phone and HUD in snapshot mode", async () => {
  (ai.live as unknown as { connect: unknown }).connect = async () => {
    liveConnectCalls += 1;
    throw new Error("503 Service Unavailable");
  };

  const sessionId = "chaos-s5-degraded-live";
  const hud = await connectHudClient(sessionId);
  const rig = createPhoneRig(sessionId);

  rig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "snapshot" &&
      rig.manager.getSnapshot().liveState === "degraded" &&
      hud.getState().live === "degraded",
    "upstream live failure degrades both phone and HUD to snapshot mode"
  );

  assert.equal(liveConnectCalls, env.liveModels.length);
  assert.equal(rig.manager.getSnapshot().lastError?.code, "gemini_unavailable");

  await postDatState(sessionId, { connected: true, worn: true, battery: 82, streaming: true });
  await postDatFrame(sessionId, blurryAmlodipineJpg);
  await postDatFrame(sessionId, sharpAmlodipineJpg);

  await waitFor(
    () =>
      rig.manager.getSnapshot().device.source === "glasses" &&
      hud.getState().device?.battery === 82,
    "DAT state delivered over degraded /live and /hud-ws"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.live?.active, false);
  assert.equal(hub.clients.size, 1);

  const vBlurFirst = await rig.manager.verifySnapshot(
    [blurryBase64, sharpBase64],
    "Is this my evening pill?"
  );
  const vSharpFirst = await rig.manager.verifySnapshot(
    [sharpBase64, blurryBase64],
    "Is this my evening pill?"
  );
  assert.equal(vBlurFirst?.level, "match");
  assert.equal(vSharpFirst?.level, "match");
  assert.deepEqual(seenVerifyCalls[0].frames, [sharpBase64, blurryBase64]);
  assert.deepEqual(seenVerifyCalls[1].frames, [sharpBase64, blurryBase64]);

  await waitFor(
    () => hud.getState().verdict?.matchedMedId === "aml",
    "snapshot verdict fanned out to HUD"
  );
  assert.equal(hud.getState().verdict?.takenToday, false);
  assert.equal(rig.manager.getSnapshot().verdict?.takenToday, false);
  assert.equal(rig.manager.getSnapshot().mode, "snapshot");

  hud.sendEvent("log_dose");

  await waitFor(
    () =>
      hud.getState().verdict?.takenToday === true &&
      rig.manager.getSnapshot().verdict?.takenToday === true,
    "Neural Band log_dose updates takenToday on both HUD and phone even while in snapshot mode"
  );

  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  assert.equal(rig.getProfile().doseLog.length, 1);

  rig.manager.stopSession();
  await waitFor(() => hub.ring.length === 0, "FrameRing wiped on stopSession");
});

test("chaos-resilience-e2e.test.ts contains zero comments, em dashes, trailers, or API keys", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const emDash = String.fromCharCode(0x2014);
  const coAuthored = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const keyPattern = new RegExp("AIza[0-9A-Za-z_-]{20,}");

  assert.equal(src.includes(slash + slash), false);
  assert.equal(src.includes(slash + star), false);
  assert.equal(src.includes(emDash), false);
  assert.equal(coAuthored.test(src), false);
  assert.equal(keyPattern.test(src), false);
});
