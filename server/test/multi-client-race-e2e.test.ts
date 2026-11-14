import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { LiveConnectParameters, LiveServerMessage, Session } from "@google/genai";
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
import { hubStats, latestHub, resetHubsForTest } from "../src/hub.ts";
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
  sendFrame(frame: { data: string; w: number; h: number; sharpness: number; ts: number }): void;
  sendQuestion(text: string): Promise<void>;
  verifySnapshot(frames: string[], question?: string): Promise<Verdict | null>;
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

interface MockLivePeer {
  model: string;
  systemText: string;
  callbacks: LiveConnectParameters["callbacks"];
  realtimeInputs: Array<Record<string, unknown>>;
  toolResponses: Array<Record<string, unknown>>;
  closedCount: number;
  session: Session;
}

let HoldUpSessionManager!: HoldUpSessionManagerCtor;
let initialHudState!: (opts?: { speechEnabled?: boolean }) => HudState;
let reduceHudServerMsg!: (state: HudState, msg: ServerMsg) => HudState;
let buildHudWsUrl!: (
  sessionParam?: string | null,
  locationLike?: { protocol?: string; host?: string; search?: string }
) => string;
let appendDoseLog!: (
  profile: Profile,
  medId: string,
  ts?: number,
  storage?: KeyValueStorage
) => Profile;

const tempLedger = path.join(os.tmpdir(), `holdup-multi-client-race-${process.pid}.jsonl`);
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
let mockLivePeers: MockLivePeer[] = [];

type GenerateHandler = (ctx: {
  model: string;
  frames: string[];
  prompt: string;
  signal?: AbortSignal;
}) => Promise<Record<string, unknown>>;

let customGenerateHandler: GenerateHandler | null = null;

const alphaProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
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

const betaProfile: Profile = {
  meds: [
    {
      id: "met",
      name: "Metforem",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["morning"],
      barcode: "6432100098765",
    },
  ],
  allergies: ["hazelnut"],
  avoid: ["anticoagulants"],
  doseLog: [],
  lang: "en",
};

function amlodipineReadJson(): Record<string, unknown> {
  return {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.98 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.96 },
    dosing: { value: "1 tablet each evening", confidence: 0.92 },
    expiry: { value: "2027-09", confidence: 0.93 },
    allergens: { value: [], confidence: 0.91 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.96,
  };
}

function metforminReadJson(): Record<string, unknown> {
  return {
    kind: "medication",
    product: { value: "Metforem", confidence: 0.98 },
    ingredient: { value: "metformin", confidence: 0.97 },
    strength: { value: "500 mg", confidence: 0.96 },
    dosing: { value: "1 tablet each morning", confidence: 0.92 },
    expiry: { value: "2027-11", confidence: 0.93 },
    allergens: { value: [], confidence: 0.91 },
    barcode: { value: "6432100098765", confidence: 0.99 },
    readability: 0.96,
  };
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    }, 4);
  });
}

function liveMsg(partial: Partial<LiveServerMessage>): LiveServerMessage {
  return { text: undefined, data: undefined, ...partial };
}

function wrapNodeWs(
  url: string,
  hooks?: {
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

async function connectHudClient(sessionId?: string | null) {
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

  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });

  return {
    ws,
    url: hudUrl,
    received,
    getState: () => state,
    canLogDose: () =>
      Boolean(!state.dismissed && state.verdict?.matchedMedId && !state.verdict?.takenToday),
    sendEvent: (name: "log_dose" | "repeat" | "dismiss") => {
      ws.send(JSON.stringify({ type: "event", name }));
    },
    close,
  };
}

function createPhoneRig(sessionId: string, initialProfile: Profile) {
  trackedSessionIds.push(sessionId);
  const storage = createMemoryStorage();
  let phoneProfile = cloneProfile(initialProfile);

  const audioChunks: string[] = [];
  const checkingStates: boolean[] = [];
  const verdicts: Array<{ verdict: Verdict; mode: TransportMode }> = [];
  const coaches: Array<{ cue: CoachCue; text: string }> = [];
  const liveWireMessages: ServerMsg[] = [];
  let interruptedCount = 0;

  let manager!: HoldUpSessionManagerInstance;

  const fetchImpl: typeof fetch = (input, init) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    const resolved = rawUrl.startsWith("/") ? `${baseUrl}${rawUrl}` : rawUrl;
    return globalThis.fetch(resolved, init);
  };

  manager = new HoldUpSessionManager({
    sessionId,
    initialProfile: phoneProfile,
    wsUrlBuilder: (sid) => `${wsBase}/live?session=${encodeURIComponent(sid)}`,
    createWs: (url) =>
      wrapNodeWs(url, {
        onServerMsg: (msg) => liveWireMessages.push(msg),
      }),
    fetchImpl,
    callbacks: {
      onAudioChunk: (chunk) => audioChunks.push(chunk),
      onInterrupted: () => {
        interruptedCount += 1;
      },
      onCheckingChange: (checking) => checkingStates.push(checking),
      onCoach: (cue, text) => coaches.push({ cue, text }),
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

  return {
    manager,
    getProfile: () => cloneProfile(phoneProfile),
    audioChunks,
    checkingStates,
    verdicts,
    coaches,
    liveWireMessages,
    getInterruptedCount: () => interruptedCount,
  };
}

async function postIngestFrame(
  sessionId: string,
  jpg: Buffer,
  sharpness?: number
): Promise<number> {
  const qs = new URLSearchParams({ session: sessionId });
  if (typeof sharpness === "number") {
    qs.set("sharpness", String(sharpness));
  }
  const res = await globalThis.fetch(`${baseUrl}/ingest/frame?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpg),
  });
  return res.status;
}

async function postApiVerify(body: {
  session?: string;
  frames: string[];
  profile: Profile;
  question?: string;
}): Promise<Verdict> {
  const res = await globalThis.fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Verdict;
}

async function fetchHealthJson(): Promise<{
  ok: boolean;
  gemini: string;
  sessions: number;
  latest: string | null;
  floatingHuds: number;
  activeSessions?: number;
}> {
  const res = await globalThis.fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    ok: boolean;
    gemini: string;
    sessions: number;
    latest: string | null;
    floatingHuds: number;
    activeSessions?: number;
  };
}

async function closeSocketCleanly(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
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
  });
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;

  const sessionModUrl = new URL("../../web/src/session/sessionManager.ts", import.meta.url).href;
  const hudModUrl = new URL("../../web/src/hud/HudApp.tsx", import.meta.url).href;
  const profileStoreModUrl = new URL("../../web/src/storage/profileStore.ts", import.meta.url).href;

  const [sessionMod, hudMod, profileStoreMod] = await Promise.all([
    import(sessionModUrl) as Promise<{ HoldUpSessionManager: HoldUpSessionManagerCtor }>,
    import(hudModUrl) as Promise<{
      initialHudState: (opts?: { speechEnabled?: boolean }) => HudState;
      reduceHudServerMsg: (state: HudState, msg: ServerMsg) => HudState;
      buildHudWsUrl: (
        sessionParam?: string | null,
        locationLike?: { protocol?: string; host?: string; search?: string }
      ) => string;
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
  appendDoseLog = profileStoreMod.appendDoseLog;
});

beforeEach(async () => {
  resetHubsForTest();
  trackedSockets = [];
  trackedManagers = [];
  trackedSessionIds = [];
  mockLivePeers = [];
  customGenerateHandler = null;

  (ai.models as unknown as { get: unknown }).get = async () => {
    throw new Error("real Gemini models.get forbidden in multi-client-race-e2e");
  };

  (ai.live as unknown as { connect: unknown }).connect = async (params: LiveConnectParameters) => {
    const sysInstruction = String(params.config?.systemInstruction ?? "");
    const peer: MockLivePeer = {
      model: params.model,
      systemText: sysInstruction,
      callbacks: params.callbacks,
      realtimeInputs: [],
      toolResponses: [],
      closedCount: 0,
      session: null as unknown as Session,
    };
    peer.session = {
      sendRealtimeInput(input: Record<string, unknown>) {
        peer.realtimeInputs.push(input);
      },
      sendToolResponse(resp: Record<string, unknown>) {
        peer.toolResponses.push(resp);
      },
      close() {
        peer.closedCount += 1;
      },
    } as unknown as Session;
    mockLivePeers.push(peer);
    return peer.session;
  };

  (ai.models as unknown as { generateContent: unknown }).generateContent = async (params: {
    model?: string;
    contents?: Array<{ parts?: Array<{ inlineData?: { data?: string }; text?: string }> }>;
    config?: { abortSignal?: AbortSignal };
  }) => {
    const parts = params?.contents?.[0]?.parts ?? [];
    const frames = parts
      .filter((p) => typeof p.inlineData?.data === "string")
      .map((p) => String(p.inlineData?.data));
    const prompt = String(parts.find((p) => typeof p.text === "string")?.text ?? "");
    if (customGenerateHandler) {
      const payload = await customGenerateHandler({
        model: String(params?.model ?? ""),
        frames,
        prompt,
        signal: params?.config?.abortSignal,
      });
      return { text: JSON.stringify(payload) };
    }
    const wantsMetformin = /metformin|metforem|morning/i.test(prompt);
    return {
      text: JSON.stringify(wantsMetformin ? metforminReadJson() : amlodipineReadJson()),
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
  await Promise.all(trackedSockets.map((ws) => closeSocketCleanly(ws)));
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

test("two simultaneous sessions sess_alpha and sess_beta switch floating /hud-ws via markLatest while bound /hud-ws?session=sess_alpha stays strictly isolated", async () => {
  const alphaRig = createPhoneRig("sess_alpha", alphaProfile);
  alphaRig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      alphaRig.manager.getSnapshot().mode === "live" &&
      alphaRig.manager.getSnapshot().liveState === "open",
    "sess_alpha live open"
  );
  assert.equal(latestHub()?.id, "sess_alpha");

  const hudFloating = await connectHudClient(null);
  assert.equal(hudFloating.url, `ws:${DOUBLE_SLASH}127.0.0.1:${port}/hud-ws`);

  await waitFor(
    () =>
      alphaRig.manager.getSnapshot().hudConnected === true &&
      hudFloating.getState().live === "open",
    "floating /hud-ws bound to sess_alpha"
  );

  const healthAlphaLatest = await fetchHealthJson();
  assert.equal(healthAlphaLatest.sessions, 1);
  assert.equal(healthAlphaLatest.latest, "sess_alp");
  assert.equal(healthAlphaLatest.floatingHuds, 1);

  const alphaPeer = mockLivePeers.find((p) => p.systemText.includes('medId "aml"'));
  assert.ok(alphaPeer);
  alphaPeer.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "cue_alpha_1", name: "show_cue", args: { cue: "rotate_left", text: "Turn box left" } },
        ],
      },
    })
  );

  await waitFor(
    () => hudFloating.getState().coach?.cue === "rotate_left",
    "floating /hud-ws receives sess_alpha coaching cue"
  );

  const hudAlphaExplicit = await connectHudClient("sess_alpha");
  assert.equal(
    hudAlphaExplicit.url,
    `ws:${DOUBLE_SLASH}127.0.0.1:${port}/hud-ws?session=sess_alpha`
  );
  await waitFor(
    () =>
      hudAlphaExplicit.getState().live === "open" &&
      hudAlphaExplicit.getState().coach?.cue === "rotate_left",
    "explicit /hud-ws?session=sess_alpha replays sess_alpha state"
  );

  const alphaMsgsBeforeBeta = alphaRig.liveWireMessages.length;
  const hudAlphaExplicitCountBeforeBeta = hudAlphaExplicit.received.length;

  const betaRig = createPhoneRig("sess_beta", betaProfile);
  betaRig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      betaRig.manager.getSnapshot().mode === "live" &&
      betaRig.manager.getSnapshot().liveState === "open" &&
      betaRig.manager.getSnapshot().hudConnected === true &&
      latestHub()?.id === "sess_beta",
    "sess_beta starts and updates markLatest"
  );

  const healthBetaLatest = await fetchHealthJson();
  assert.equal(healthBetaLatest.sessions, 2);
  assert.equal(healthBetaLatest.latest, "sess_bet");
  assert.equal(healthBetaLatest.floatingHuds, 1);
  assert.equal(alphaRig.manager.getSnapshot().hudConnected, true);

  const hudBetaExplicit = await connectHudClient("sess_beta");

  const betaVerdict = await postApiVerify({
    frames: [sharpBase64],
    profile: betaProfile,
    question: "Is this my morning metformin?",
  });
  assert.equal(betaVerdict.level, "match");
  assert.equal(betaVerdict.matchedMedId, "met");
  assert.equal(betaVerdict.takenToday, false);

  await waitFor(
    () =>
      hudFloating.getState().verdict?.matchedMedId === "met" &&
      hudBetaExplicit.getState().verdict?.matchedMedId === "met",
    "sess_beta verdict fans out to floating HUD and explicit sess_beta HUD"
  );

  hudFloating.sendEvent("log_dose");

  await waitFor(
    () =>
      betaRig.manager.getSnapshot().verdict?.matchedMedId === "met" &&
      betaRig.manager.getSnapshot().verdict?.takenToday === true &&
      hudFloating.getState().verdict?.takenToday === true &&
      hudBetaExplicit.getState().verdict?.takenToday === true,
    "sess_beta log_dose updates sess_beta phone, floating HUD, and explicit sess_beta HUD"
  );

  const hubAlpha = getHub("sess_alpha");
  const hubBeta = getHub("sess_beta");
  assert.ok(hubAlpha);
  assert.ok(hubBeta);

  assert.ok(hubBeta.profile.doseLog.length >= 1);
  assert.ok(hubBeta.profile.doseLog.every((d) => d.medId === "met"));
  assert.equal(betaRig.getProfile().doseLog.length, 1);
  assert.equal(betaRig.getProfile().doseLog[0].medId, "met");

  assert.equal(hubAlpha.profile.doseLog.length, 0);
  assert.equal(hubAlpha.lastVerdict, undefined);
  assert.equal(alphaRig.manager.getSnapshot().verdict, null);
  assert.equal(hudAlphaExplicit.getState().verdict, null);
  assert.equal(hudAlphaExplicit.received.length, hudAlphaExplicitCountBeforeBeta);
  const alphaLeakedVerdicts = alphaRig.liveWireMessages
    .slice(alphaMsgsBeforeBeta)
    .filter((m) => m.type === "verdict");
  assert.equal(alphaLeakedVerdicts.length, 0);

  const betaVerdictsBeforeAlpha = hudBetaExplicit.received.filter((m) => m.type === "verdict").length;
  const floatingVerdictsBeforeAlpha = hudFloating.received.filter((m) => m.type === "verdict").length;

  const alphaVerdict = await postApiVerify({
    session: "sess_alpha",
    frames: [sharpBase64],
    profile: alphaProfile,
    question: "Is this my evening amlodipine?",
  });
  assert.equal(alphaVerdict.level, "match");
  assert.equal(alphaVerdict.matchedMedId, "aml");
  assert.equal(alphaVerdict.takenToday, false);

  await waitFor(
    () => hudAlphaExplicit.getState().verdict?.matchedMedId === "aml",
    "explicit /hud-ws?session=sess_alpha receives sess_alpha verdict"
  );
  assert.equal(hudAlphaExplicit.getState().verdict?.takenToday, false);

  hudAlphaExplicit.sendEvent("log_dose");

  await waitFor(
    () =>
      alphaRig.manager.getSnapshot().verdict?.matchedMedId === "aml" &&
      alphaRig.manager.getSnapshot().verdict?.takenToday === true &&
      hudAlphaExplicit.getState().verdict?.takenToday === true,
    "explicit sess_alpha HUD log_dose mutates only sess_alpha"
  );

  assert.equal(alphaRig.getProfile().doseLog.length, 1);
  assert.equal(alphaRig.getProfile().doseLog[0].medId, "aml");
  assert.ok(hubAlpha.profile.doseLog.every((d) => d.medId === "aml"));
  assert.ok(hubBeta.profile.doseLog.every((d) => d.medId === "met"));
  assert.equal(hudFloating.getState().verdict?.matchedMedId, "met");
  assert.equal(hudBetaExplicit.getState().verdict?.matchedMedId, "met");
  assert.equal(
    hudBetaExplicit.received.filter((m) => m.type === "verdict").length,
    betaVerdictsBeforeAlpha
  );
  assert.equal(
    hudFloating.received.filter((m) => m.type === "verdict").length,
    floatingVerdictsBeforeAlpha
  );

  await hudAlphaExplicit.close();
  await waitFor(
    () => alphaRig.manager.getSnapshot().hudConnected === false,
    "closing explicit sess_alpha HUD sets sess_alpha hudConnected false while floating HUD stays on sess_beta"
  );
  assert.equal(betaRig.manager.getSnapshot().hudConnected, true);
});

test("12-frame concurrent /ingest/frame burst respects FrameRing(8) cap and rapid dual /hud-ws log_dose + repeat propagates accurate takenToday across phone and HUD", async () => {
  const sessionId = "sess_burst";
  const rig = createPhoneRig(sessionId, alphaProfile);
  const hudExplicit = await connectHudClient(sessionId);
  const hudFloating = await connectHudClient(null);

  rig.manager.startSession({ voice: true });
  await waitFor(
    () =>
      rig.manager.getSnapshot().mode === "live" &&
      rig.manager.getSnapshot().liveState === "open" &&
      hudExplicit.getState().live === "open" &&
      hudFloating.getState().live === "open",
    "sess_burst paired live and HUDs open"
  );

  const hub = getHub(sessionId);
  assert.ok(hub);

  const burstSpecs = Array.from({ length: 12 }, (_, idx) => ({
    jpg: idx === 9 || idx === 11 ? sharpAmlodipineJpg : blurryAmlodipineJpg,
    sharpness: idx === 11 ? 0.97 : idx === 9 ? 0.91 : Number((0.2 + idx * 0.03).toFixed(2)),
  }));

  const statuses = await Promise.all(
    burstSpecs.map((spec) => postIngestFrame(sessionId, spec.jpg, spec.sharpness))
  );
  assert.deepEqual(statuses, new Array(12).fill(204));
  assert.ok(hub.ring.length <= 8);
  assert.equal(hub.ring.length, 8);

  const topTwo = hub.ring.pick(2);
  assert.equal(topTwo.length, 2);
  assert.equal(topTwo[0].sharpness, 0.97);
  assert.equal(topTwo[1].sharpness, 0.91);
  assert.equal(topTwo[0].data, sharpBase64);
  assert.equal(topTwo[1].data, sharpBase64);
  assert.equal(topTwo[0].source, "glasses");

  const livePeer = mockLivePeers[0];
  assert.ok(livePeer);
  const forwardedVideoFrames = livePeer.realtimeInputs.filter((inp) => "video" in inp);
  assert.equal(forwardedVideoFrames.length, 1);

  const verifyVerdict = await postApiVerify({
    session: sessionId,
    frames: [blurryBase64, sharpBase64],
    profile: alphaProfile,
    question: "Is this my evening pill?",
  });
  assert.equal(verifyVerdict.level, "match");
  assert.equal(verifyVerdict.matchedMedId, "aml");
  assert.equal(verifyVerdict.takenToday, false);

  await waitFor(
    () =>
      hudExplicit.getState().verdict?.matchedMedId === "aml" &&
      hudFloating.getState().verdict?.matchedMedId === "aml",
    "initial match verdict delivered to HUDs"
  );
  assert.equal(hudExplicit.canLogDose(), true);

  hudExplicit.sendEvent("log_dose");
  hudExplicit.sendEvent("log_dose");
  hudFloating.sendEvent("repeat");

  await waitFor(
    () =>
      rig.verdicts.length >= 3 &&
      rig.manager.getSnapshot().verdict?.takenToday === true &&
      hudExplicit.getState().verdict?.takenToday === true &&
      hudFloating.getState().verdict?.takenToday === true,
    "dual log_dose and repeat propagate takenToday true to phone and HUDs"
  );

  assert.equal(hudExplicit.canLogDose(), false);
  assert.equal(rig.manager.getSnapshot().verdict?.matchedMedId, "aml");
  assert.equal(rig.manager.getSnapshot().verdict?.takenToday, true);
  assert.equal(hudExplicit.getState().verdict?.takenToday, true);
  assert.equal(hudFloating.getState().verdict?.takenToday, true);
  assert.equal(hub.lastVerdict?.takenToday, true);

  for (const entry of rig.verdicts) {
    assert.equal(entry.verdict.matchedMedId, "aml");
    assert.equal(entry.verdict.takenToday, true);
  }

  assert.equal(rig.getProfile().doseLog.length, 1);
  assert.equal(rig.getProfile().doseLog[0].medId, "aml");
  assert.ok(hub.profile.doseLog.length >= 1);
  assert.ok(hub.profile.doseLog.every((d) => d.medId === "aml"));
});

test("live barge-in cancels in-flight verify_label without stale HUD verdict and concurrent snapshot POST /api/verify across two sessions resolves without cross-talk", async () => {
  const alphaRig = createPhoneRig("sess_alpha", alphaProfile);
  const hudAlpha = await connectHudClient("sess_alpha");
  alphaRig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      alphaRig.manager.getSnapshot().liveState === "open" &&
      hudAlpha.getState().live === "open",
    "sess_alpha live and HUD open"
  );

  await postIngestFrame("sess_alpha", sharpAmlodipineJpg, jpegSharpness(sharpAmlodipineJpg));
  const alphaPeer = mockLivePeers[0];
  assert.ok(alphaPeer);

  const staleVerifyGate = deferred<Record<string, unknown>>();
  const staleVerifyEntered = deferred<void>();
  let verifyCallCount = 0;

  customGenerateHandler = async ({ prompt }) => {
    verifyCallCount += 1;
    if (prompt.includes("stale-barge-check")) {
      staleVerifyEntered.resolve();
      return staleVerifyGate.promise;
    }
    if (prompt.includes("morning metformin")) {
      return metforminReadJson();
    }
    return amlodipineReadJson();
  };

  const pcmChunk = Buffer.alloc(320, 7).toString("base64");
  alphaPeer.callbacks.onmessage?.(
    liveMsg({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: pcmChunk, mimeType: "audio/pcm;rate=24000" } }] },
        outputTranscription: { text: "Hold steady while I check the box" },
      },
    })
  );

  alphaPeer.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "vc_stale_1", name: "verify_label", args: { question: "stale-barge-check" } },
        ],
      },
    })
  );

  await staleVerifyEntered.promise;
  await waitFor(
    () =>
      alphaRig.manager.getSnapshot().checking === true &&
      hudAlpha.getState().coach?.cue === "hold_still",
    "in-flight verify_label sets phone checking true and HUD hold_still cue"
  );
  assert.equal(alphaRig.audioChunks.length, 1);
  assert.equal(hudAlpha.received.some((m) => m.type === "audio" || m.type === "checking"), false);

  alphaPeer.callbacks.onmessage?.(
    liveMsg({
      toolCallCancellation: { ids: ["vc_stale_1"] },
      serverContent: { interrupted: true },
    })
  );

  await waitFor(
    () =>
      alphaRig.getInterruptedCount() === 1 &&
      alphaRig.manager.getSnapshot().transcripts.some(
        (t) => t.role === "assistant" && t.final === true
      ),
    "barge-in interrupted flushes transcript and notifies phone"
  );

  staleVerifyGate.resolve(amlodipineReadJson());

  await waitFor(
    () => alphaRig.manager.getSnapshot().checking === false,
    "cancelled verify_label cleans up checking state"
  );
  assert.equal(alphaRig.manager.getSnapshot().verdict, null);
  assert.equal(hudAlpha.getState().verdict, null);
  assert.equal(alphaPeer.toolResponses.length, 0);

  const betaRig = createPhoneRig("sess_beta", betaProfile);
  const hudBeta = await connectHudClient("sess_beta");
  const hudFloating = await connectHudClient(null);
  betaRig.manager.startSession({ voice: true });

  await waitFor(
    () =>
      betaRig.manager.getSnapshot().liveState === "open" &&
      hudBeta.getState().live === "open" &&
      hudFloating.getState().live === "open",
    "sess_beta and HUDs ready for concurrent verify race"
  );

  const slowAlphaGate = deferred<Record<string, unknown>>();
  customGenerateHandler = async ({ prompt }) => {
    if (prompt.includes("slow-alpha-snapshot")) {
      return slowAlphaGate.promise;
    }
    return metforminReadJson();
  };

  const alphaVerifyPromise = postApiVerify({
    session: "sess_alpha",
    frames: [blurryBase64, sharpBase64],
    profile: alphaProfile,
    question: "slow-alpha-snapshot",
  });
  const betaVerifyPromise = postApiVerify({
    session: "sess_beta",
    frames: [sharpBase64],
    profile: betaProfile,
    question: "fast-beta-snapshot morning metformin",
  });

  const betaRes = await betaVerifyPromise;
  assert.equal(betaRes.matchedMedId, "met");
  await waitFor(
    () =>
      hudBeta.getState().verdict?.matchedMedId === "met" &&
      hudFloating.getState().verdict?.matchedMedId === "met",
    "fast sess_beta snapshot verdict fans out while sess_alpha is still in flight"
  );
  assert.equal(hudAlpha.getState().verdict, null);

  slowAlphaGate.resolve(amlodipineReadJson());
  const alphaRes = await alphaVerifyPromise;
  assert.equal(alphaRes.matchedMedId, "aml");

  await waitFor(
    () => hudAlpha.getState().verdict?.matchedMedId === "aml",
    "slow sess_alpha snapshot verdict lands strictly on sess_alpha HUD"
  );
  assert.equal(hudBeta.getState().verdict?.matchedMedId, "met");
  assert.equal(hudFloating.getState().verdict?.matchedMedId, "met");
  assert.ok(verifyCallCount >= 1);
});

test("graceful teardown of all /live and /hud-ws sockets clears FrameRings, floatingHuds, and active sessions on GET /api/health with zero leaks", async () => {
  const alphaRig = createPhoneRig("sess_alpha", alphaProfile);
  const betaRig = createPhoneRig("sess_beta", betaProfile);
  const hudFloating = await connectHudClient(null);
  const hudAlpha = await connectHudClient("sess_alpha");
  const hudBeta = await connectHudClient("sess_beta");

  alphaRig.manager.startSession({ voice: true });
  await waitFor(() => alphaRig.manager.getSnapshot().liveState === "open", "sess_alpha open");

  const extraAlphaLiveWs = new WebSocket(`${wsBase}/live?session=sess_alpha`);
  trackedSockets.push(extraAlphaLiveWs);
  await new Promise<void>((resolve, reject) => {
    extraAlphaLiveWs.once("open", () => resolve());
    extraAlphaLiveWs.once("error", reject);
  });

  betaRig.manager.startSession({ voice: true });
  await waitFor(() => betaRig.manager.getSnapshot().liveState === "open", "sess_beta open");

  await Promise.all([
    postIngestFrame("sess_alpha", sharpAmlodipineJpg),
    postIngestFrame("sess_alpha", blurryAmlodipineJpg),
    postIngestFrame("sess_beta", sharpAmlodipineJpg),
  ]);

  const hubAlpha = getHub("sess_alpha");
  const hubBeta = getHub("sess_beta");
  assert.ok(hubAlpha);
  assert.ok(hubBeta);
  assert.equal(hubAlpha.clients.size, 2);
  assert.equal(hubAlpha.ring.length, 2);
  assert.equal(hubBeta.clients.size, 1);
  assert.equal(hubBeta.ring.length, 1);

  const healthDuringRun = await fetchHealthJson();
  assert.equal(healthDuringRun.ok, true);
  assert.equal(healthDuringRun.gemini, "down");
  assert.equal(healthDuringRun.sessions, 2);
  assert.equal(healthDuringRun.floatingHuds, 1);

  alphaRig.manager.stopSession();
  await waitFor(
    () => hubAlpha.clients.size === 1,
    "first sess_alpha /live client closed while secondary stays open"
  );
  assert.equal(hubAlpha.ring.length, 2);

  await closeSocketCleanly(extraAlphaLiveWs);
  betaRig.manager.stopSession();
  await Promise.all([hudFloating.close(), hudAlpha.close(), hudBeta.close()]);

  await waitFor(
    () =>
      hubAlpha.clients.size === 0 &&
      hubBeta.clients.size === 0 &&
      hubAlpha.huds.size === 0 &&
      hubBeta.huds.size === 0 &&
      hubAlpha.ring.length === 0 &&
      hubBeta.ring.length === 0 &&
      hubStats().floatingHuds === 0,
    "all /live and /hud-ws sockets torn down and FrameRings wiped"
  );

  assert.equal(hubAlpha.ring.length, 0);
  assert.equal(hubBeta.ring.length, 0);
  assert.equal(hubAlpha.live?.active, false);
  assert.equal(hubBeta.live?.active, false);
  assert.equal(alphaRig.manager.getBufferedFrames().length, 0);
  assert.equal(betaRig.manager.getBufferedFrames().length, 0);

  const healthAfterClose = await fetchHealthJson();
  assert.equal(healthAfterClose.ok, true);
  assert.equal(healthAfterClose.floatingHuds, 0);
  assert.equal(healthAfterClose.activeSessions ?? 0, 0);

  for (const sock of trackedSockets) {
    assert.equal(sock.readyState, WebSocket.CLOSED);
  }

  resetHubsForTest();
  const healthAfterReset = await fetchHealthJson();
  assert.equal(healthAfterReset.sessions, 0);
  assert.equal(healthAfterReset.latest, null);
  assert.equal(healthAfterReset.floatingHuds, 0);
});

test("multi-client-race-e2e.test.ts contains zero comments, em dashes, trailers, or API keys", () => {
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
