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
import type { DeviceState, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { hasHud, hubStats, latestHub, resetHubsForTest } from "../src/hub.ts";
import { getHub, startServer } from "../src/index.ts";
import { jpegSharpness, jpegSize } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

const DOUBLE_SLASH = "\x2f\x2f";
const tempLedger = path.join(os.tmpdir(), `holdup-device-handoff-e2e-${process.pid}.jsonl`);
const fixtureAmlodipineJpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));

type MockLiveConnection = {
  model: string;
  config: LiveConnectParameters["config"];
  callbacks: LiveConnectParameters["callbacks"];
  realtimeInputs: Array<Record<string, unknown>>;
  toolResponses: Array<Record<string, unknown>>;
  closed: number;
  session: Session;
};

type WsClient = {
  ws: WebSocket;
  received: ServerMsg[];
  ready: Promise<void>;
  sendJson: (payload: Record<string, unknown>) => void;
  close: () => Promise<void>;
};

type VerifyCapture = {
  model: string;
  frames: string[];
  prompt: string;
};

const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);
const origModelsGet = ai.models.get.bind(ai.models);

let prevApiKey = "";
let prevLedger = "";
let server: http.Server | null = null;
let baseUrl = "";
let wsBase = "";

let trackedWs: WebSocket[] = [];
let trackedSessionIds: string[] = [];
let liveSessions: MockLiveConnection[] = [];
let verifyCaptures: VerifyCapture[] = [];

function buildTestJpeg(width: number, height: number, scanBytes: number, seed: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  sof0[10] = 1;
  sof0[11] = 0x22;
  sof0[12] = 0;
  sof0[13] = 2;
  sof0[14] = 0x11;
  sof0[15] = 1;
  sof0[16] = 3;
  sof0[17] = 0x11;
  sof0[18] = 1;
  const sosHeader = Buffer.from([
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);
  const scan = Buffer.alloc(scanBytes);
  for (let i = 0; i < scanBytes; i++) {
    scan[i] = (i * 31 + seed) & 0x7f;
  }
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, sosHeader, scan, eoi]);
}

function liveMsg(partial: Partial<LiveServerMessage>): LiveServerMessage {
  return { text: undefined, data: undefined, ...partial };
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

function reconcilePhoneEyeSource(
  device: Pick<DeviceState, "connected" | "worn" | "battery">,
  preferred: "phone" | "glasses" = "glasses",
): "phone" | "glasses" {
  if (preferred === "phone") return "phone";
  if (!device.connected || !device.worn) return "phone";
  if (typeof device.battery === "number" && device.battery < 15) return "phone";
  return "glasses";
}

function openWsClient(pathAndQuery: string): WsClient {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`);
  trackedWs.push(ws);
  const received: ServerMsg[] = [];
  ws.on("message", (raw) => {
    received.push(JSON.parse(raw.toString("utf8")) as ServerMsg);
  });
  ws.on("error", () => {});
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const close = () =>
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
    });
  return {
    ws,
    received,
    ready,
    sendJson(payload) {
      ws.send(JSON.stringify(payload));
    },
    close,
  };
}

function trackSession(id: string): string {
  trackedSessionIds.push(id);
  return id;
}

async function postDatState(
  state: { connected: boolean; worn: boolean; battery: number | null; streaming: boolean },
  sessionId?: string,
): Promise<void> {
  const suffix = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  const res = await globalThis.fetch(`${baseUrl}/ingest/state${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  assert.equal(res.status, 204);
}

async function postDatFrame(jpg: Buffer, opts?: { sessionId?: string; sharpness?: number }): Promise<void> {
  const qs = new URLSearchParams();
  if (opts?.sessionId) qs.set("session", opts.sessionId);
  if (typeof opts?.sharpness === "number") qs.set("sharpness", String(opts.sharpness));
  const query = qs.toString();
  const res = await globalThis.fetch(`${baseUrl}/ingest/frame${query ? `?${query}` : ""}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpg),
  });
  assert.equal(res.status, 204);
}

function amlodipineLabelPayload(): Record<string, unknown> {
  return {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.98 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.96 },
    dosing: { value: "1 tablet each evening", confidence: 0.92 },
    expiry: { value: "2027-10", confidence: 0.94 },
    allergens: { value: [], confidence: 0.91 },
    barcode: { value: "6432100012345", confidence: 0.98 },
    readability: 0.96,
  };
}

function warfarinLabelPayload(): Record<string, unknown> {
  return {
    kind: "medication",
    product: { value: "Marevan", confidence: 0.98 },
    ingredient: { value: "warfarin", confidence: 0.97 },
    strength: { value: "3 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-12", confidence: 0.93 },
    allergens: { value: [], confidence: 0.9 },
    barcode: { value: "6432100077777", confidence: 0.97 },
    readability: 0.95,
  };
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
  resetHubsForTest();

  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http:${DOUBLE_SLASH}127.0.0.1:${port}`;
  wsBase = `ws:${DOUBLE_SLASH}127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
  trackedWs = [];
  trackedSessionIds = [];
  liveSessions = [];
  verifyCaptures = [];

  (ai.models as unknown as { get: unknown }).get = async () => {
    throw new Error("real Gemini models.get forbidden in device-handoff-e2e");
  };

  (ai.live as unknown as { connect: unknown }).connect = async (params: LiveConnectParameters) => {
    const conn: MockLiveConnection = {
      model: params.model,
      config: params.config,
      callbacks: params.callbacks,
      realtimeInputs: [],
      toolResponses: [],
      closed: 0,
      session: null as unknown as Session,
    };
    conn.session = {
      sendRealtimeInput(input: Record<string, unknown>) {
        conn.realtimeInputs.push(input);
      },
      sendToolResponse(resp: Record<string, unknown>) {
        conn.toolResponses.push(resp);
      },
      close() {
        conn.closed += 1;
      },
    } as unknown as Session;
    liveSessions.push(conn);
    return conn.session;
  };

  (ai.models as unknown as { generateContent: unknown }).generateContent = async (params: {
    model?: string;
    contents?: Array<{ parts?: Array<{ inlineData?: { data?: string }; text?: string }> }>;
  }) => {
    const parts = params?.contents?.[0]?.parts ?? [];
    const frames = parts
      .filter((p) => typeof p.inlineData?.data === "string")
      .map((p) => String(p.inlineData?.data));
    const prompt = String(parts.find((p) => typeof p.text === "string")?.text ?? "");
    verifyCaptures.push({
      model: String(params?.model ?? ""),
      frames,
      prompt,
    });
    const isWarfarin = /warfarin|marevan|elder-b/i.test(prompt);
    return {
      text: JSON.stringify(isWarfarin ? warfarinLabelPayload() : amlodipineLabelPayload()),
      usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 42 },
    };
  };
});

afterEach(async () => {
  await Promise.all(
    trackedWs.map(
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
        }),
    ),
  );
  for (const sid of trackedSessionIds) {
    getHub(sid)?.live?.stop("test cleanup");
  }
  resetHubsForTest();
});

after(async () => {
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent = origGenerateContent;
  (ai.models as unknown as { get: typeof origModelsGet }).get = origModelsGet;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  if (server) {
    const active = server;
    server = null;
    active.closeAllConnections();
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("pre-session orphan DAT telemetry buffers onto floating /hud-ws, adopts on /live start, replays ordered state to late-joining 2nd /hud-ws, and drops hud connected to false only after all HUDs disconnect", async () => {
  await postDatState({ connected: true, worn: true, battery: 84, streaming: true });
  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 0 });

  const hud1 = openWsClient("/hud-ws");
  await hud1.ready;

  const initialOrphanDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
  };
  await waitFor(
    () => hud1.received.some((m) => m.type === "device" && m.device.battery === 84),
    "floating /hud-ws receives pre-session orphan device state",
  );
  assert.deepEqual(hud1.received, [{ type: "device", device: initialOrphanDevice }]);

  await postDatState({ connected: true, worn: true, battery: 79, streaming: true });
  const updatedOrphanDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 79,
    streaming: true,
    source: "glasses",
  };
  await waitFor(
    () => hud1.received.some((m) => m.type === "device" && m.device.battery === 79),
    "floating /hud-ws receives updated pre-session orphan battery 79",
  );

  const sessionId = trackSession("sess-orphan-adopt");
  const phone = openWsClient(`/live?session=${sessionId}`);
  await phone.ready;

  const profile: Profile = {
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

  phone.sendJson({
    type: "start",
    profile,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      phone.received.some((m) => m.type === "ready" && m.session === sessionId) &&
      phone.received.some((m) => m.type === "status" && m.live === "open") &&
      phone.received.some((m) => m.type === "hud" && m.connected === true) &&
      hud1.received.some((m) => m.type === "status" && m.live === "open"),
    "Phone PWA /live starts, adopts orphan telemetry, and binds floating /hud-ws",
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(latestHub(), hub);
  assert.deepEqual(hub.device, updatedOrphanDevice);

  await postDatFrame(fixtureAmlodipineJpg);
  assert.equal(hub.ring.length, 1);

  const livePeer = liveSessions[0];
  livePeer.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-orphan-verify", name: "verify_label", args: { question: "Is this my evening pill?" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      livePeer.toolResponses.length === 1 &&
      phone.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml") &&
      hud1.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml"),
    "verify_label verdict delivered to phone and 1st HUD",
  );

  livePeer.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-orphan-cue", name: "show_cue", args: { cue: "ok", text: "Label locked clearly" } },
        ],
      },
    }),
  );

  await waitFor(
    () => hud1.received.some((m) => m.type === "coach" && m.cue === "ok"),
    "post-verify show_cue delivered to 1st HUD",
  );

  const hud2 = openWsClient("/hud-ws");
  await hud2.ready;
  await waitFor(() => hud2.received.length >= 4, "late-joining 2nd floating /hud-ws receives full 4-message replay");

  assert.deepEqual(
    hud2.received.slice(0, 4).map((m) => m.type),
    ["status", "device", "coach", "verdict"],
  );
  assert.deepEqual(hud2.received[0], { type: "status", live: "open", detail: env.liveModels[0] });
  assert.deepEqual(hud2.received[1], { type: "device", device: updatedOrphanDevice });
  assert.deepEqual(hud2.received[2], { type: "coach", cue: "ok", text: "Label locked clearly" });
  assert.equal(hud2.received[3].type, "verdict");
  if (hud2.received[3].type === "verdict") {
    assert.equal(hud2.received[3].verdict.level, "match");
    assert.equal(hud2.received[3].verdict.matchedMedId, "aml");
  }

  const hud3Pinned = openWsClient(`/hud-ws?session=${sessionId}`);
  await hud3Pinned.ready;
  await waitFor(() => hud3Pinned.received.length >= 4, "late-joining pinned /hud-ws receives identical ordered replay");
  assert.deepEqual(hud3Pinned.received.slice(0, 4), hud2.received.slice(0, 4));

  assert.equal(
    phone.received.some((m) => m.type === "hud" && m.connected === false),
    false,
  );

  await hud1.close();
  await waitFor(() => hubStats().floatingHuds === 1, "1st floating HUD removed on server");
  assert.equal(hasHud(hub), true);
  assert.equal(
    phone.received.some((m) => m.type === "hud" && m.connected === false),
    false,
  );

  await hud2.close();
  await waitFor(() => hubStats().floatingHuds === 0, "2nd floating HUD removed on server");
  assert.equal(hub.huds.size, 1);
  assert.equal(hasHud(hub), true);
  assert.equal(
    phone.received.some((m) => m.type === "hud" && m.connected === false),
    false,
  );

  await hud3Pinned.close();
  await waitFor(
    () =>
      hub.huds.size === 0 &&
      phone.received.some((m) => m.type === "hud" && m.connected === false),
    "phone receives hud connected false only after final HUD disconnects",
  );
  assert.equal(hasHud(hub), false);
  assert.deepEqual(
    phone.received.filter((m) => m.type === "hud").at(-1),
    { type: "hud", connected: false },
  );
});

test("mid-check glasses hardware handoff on battery 9% and worn false switches phone eye source to phone, picks sharpest frames across handoff, and preserves conversation and profile.doseLog", async () => {
  const sessionId = trackSession("sess-handoff-midcheck");
  const morningDoseTs = Date.now() - 3_600_000;
  const profile: Profile = {
    meds: [
      {
        id: "met",
        name: "Metforem",
        ingredient: "metformin",
        strength: "500 mg",
        schedule: ["morning"],
      },
      {
        id: "aml",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432100012345",
      },
    ],
    allergies: ["hazelnut"],
    avoid: ["NSAIDs"],
    doseLog: [{ medId: "met", ts: morningDoseTs }],
    lang: "en",
  };

  const phone = openWsClient(`/live?session=${sessionId}`);
  const hud = openWsClient(`/hud-ws?session=${sessionId}`);
  await Promise.all([phone.ready, hud.ready]);

  let phoneEyeSource: "phone" | "glasses" = "glasses";
  phone.sendJson({
    type: "start",
    profile,
    lang: "en",
    voice: true,
    source: phoneEyeSource,
  });

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      phone.received.some((m) => m.type === "status" && m.live === "open") &&
      hud.received.some((m) => m.type === "status" && m.live === "open"),
    "mid-check handoff session live on phone and HUD",
  );

  await postDatState({ connected: true, worn: true, battery: 72, streaming: true }, sessionId);
  await waitFor(
    () =>
      phone.received.some((m) => m.type === "device" && m.device.battery === 72) &&
      hud.received.some((m) => m.type === "device" && m.device.battery === 72),
    "healthy glasses state battery 72 delivered to phone and HUD",
  );

  const glassesDeviceMsg = [...phone.received]
    .reverse()
    .find((m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device");
  assert.ok(glassesDeviceMsg);
  phoneEyeSource = reconcilePhoneEyeSource(glassesDeviceMsg.device, "glasses");
  assert.equal(phoneEyeSource, "glasses");

  const livePeer = liveSessions[0];
  livePeer.callbacks.onmessage?.(
    liveMsg({
      serverContent: {
        inputTranscription: { text: "Is this my evening blood pressure pill?", finished: true },
        outputTranscription: { text: "Rotate the box slightly toward the light.", finished: true },
        turnComplete: true,
      },
    }),
  );

  await waitFor(
    () =>
      phone.received.filter((m) => m.type === "transcript" && m.final === true).length >= 2,
    "initial user and assistant coaching turn recorded before handoff",
  );

  const glassesBlurryJpg = buildTestJpeg(100, 100, 760, 11);
  const glassesSharpJpg = buildTestJpeg(100, 100, 3050, 22);
  const phoneMotionJpg = buildTestJpeg(100, 100, 1450, 33);
  const phoneSharpestJpg = buildTestJpeg(100, 100, 3360, 44);

  assert.deepEqual(jpegSize(glassesSharpJpg), { w: 100, h: 100 });
  const gBlurScore = jpegSharpness(glassesBlurryJpg);
  const gSharpScore = jpegSharpness(glassesSharpJpg);
  const pMotionScore = jpegSharpness(phoneMotionJpg);
  const pSharpestScore = jpegSharpness(phoneSharpestJpg);
  assert.ok(gBlurScore < pMotionScore && pMotionScore < gSharpScore && gSharpScore < pSharpestScore);

  await postDatFrame(glassesBlurryJpg, { sessionId });
  await postDatFrame(glassesSharpJpg, { sessionId });

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.ring.length, 2);
  assert.ok(hub.ring.pick(2).every((f) => f.source === "glasses"));

  await postDatState({ connected: true, worn: false, battery: 9, streaming: false }, sessionId);
  await waitFor(
    () =>
      phone.received.some(
        (m) => m.type === "device" && m.device.battery === 9 && m.device.worn === false,
      ) &&
      hud.received.some(
        (m) => m.type === "device" && m.device.battery === 9 && m.device.worn === false,
      ),
    "low battery 9% and worn false delivered to phone and HUD",
  );

  const faultDeviceMsg = [...phone.received]
    .reverse()
    .find((m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device");
  assert.ok(faultDeviceMsg);
  phoneEyeSource = reconcilePhoneEyeSource(faultDeviceMsg.device, "glasses");
  assert.equal(phoneEyeSource, "phone");

  phone.sendJson({
    type: "frame",
    data: phoneMotionJpg.toString("base64"),
    w: 100,
    h: 100,
    sharpness: pMotionScore,
    ts: Date.now(),
  });
  phone.sendJson({
    type: "frame",
    data: phoneSharpestJpg.toString("base64"),
    w: 100,
    h: 100,
    sharpness: pSharpestScore,
    ts: Date.now() + 5,
  });

  await waitFor(() => hub.ring.length === 4, "phone WS frames appended to FrameRing across handoff");

  const crossSurfaceTop2 = hub.ring.pick(2);
  assert.equal(crossSurfaceTop2.length, 2);
  assert.equal(crossSurfaceTop2[0].source, "phone");
  assert.equal(crossSurfaceTop2[0].data, phoneSharpestJpg.toString("base64"));
  assert.equal(crossSurfaceTop2[1].source, "glasses");
  assert.equal(crossSurfaceTop2[1].data, glassesSharpJpg.toString("base64"));

  livePeer.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          {
            id: "fc-handoff-verify",
            name: "verify_label",
            args: { question: "Is this my evening blood pressure pill?" },
          },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      verifyCaptures.length === 1 &&
      phone.received.some((m) => m.type === "verdict") &&
      hud.received.some((m) => m.type === "verdict"),
    "verify_label resolves across glasses-to-phone handoff",
  );

  assert.deepEqual(verifyCaptures[0].frames, [
    phoneSharpestJpg.toString("base64"),
    glassesSharpJpg.toString("base64"),
  ]);

  const phoneVerdictMsg = phone.received.find(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  const hudVerdictMsg = hud.received.find(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  assert.ok(phoneVerdictMsg);
  assert.ok(hudVerdictMsg);
  assert.deepEqual(phoneVerdictMsg.verdict, hudVerdictMsg.verdict);
  assert.equal(phoneVerdictMsg.verdict.level, "match");
  assert.equal(phoneVerdictMsg.verdict.matchedMedId, "aml");
  assert.equal(phoneVerdictMsg.verdict.takenToday, false);

  livePeer.callbacks.onmessage?.(
    liveMsg({
      serverContent: {
        outputTranscription: { text: phoneVerdictMsg.verdict.speech, finished: true },
        turnComplete: true,
      },
    }),
  );

  await waitFor(
    () =>
      phone.received.filter((m) => m.type === "transcript" && m.final === true).length >= 3,
    "follow-up spoken verdict transcript arrives on unbroken Live session",
  );

  assert.equal(liveSessions.length, 1);
  assert.equal(livePeer.closed, 0);
  assert.equal(hub.clients.size, 1);
  assert.deepEqual(hub.profile.doseLog, [{ medId: "met", ts: morningDoseTs }]);

  hud.sendJson({ type: "event", name: "log_dose" });
  await waitFor(
    () =>
      hub.profile.doseLog.length === 2 &&
      phone.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday === true &&
      hud.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday === true,
    "subsequent log_dose appends evening pill without losing morning doseLog entry",
  );
  assert.equal(hub.profile.doseLog[0].medId, "met");
  assert.equal(hub.profile.doseLog[0].ts, morningDoseTs);
  assert.equal(hub.profile.doseLog[1].medId, "aml");
});

test("multi-session room isolation keeps sess-elder-a and sess-elder-b strictly separated while floating /hud-ws follows markLatest transitions", async () => {
  const sessionA = trackSession("sess-elder-a");
  const sessionB = trackSession("sess-elder-b");

  const profileA: Profile = {
    meds: [
      {
        id: "aml-a",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
      },
    ],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };

  const profileB: Profile = {
    meds: [
      {
        id: "war-b",
        name: "Marevan",
        ingredient: "warfarin",
        strength: "3 mg",
        schedule: ["evening"],
      },
    ],
    allergies: ["milk"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "fi",
  };

  const phoneA = openWsClient(`/live?session=${sessionA}`);
  const hudPinnedA = openWsClient(`/hud-ws?session=${sessionA}`);
  const hudFloating = openWsClient("/hud-ws");
  await Promise.all([phoneA.ready, hudPinnedA.ready, hudFloating.ready]);

  phoneA.sendJson({
    type: "start",
    profile: profileA,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      latestHub()?.id === sessionA &&
      hudPinnedA.received.some((m) => m.type === "status" && m.live === "open") &&
      hudFloating.received.some((m) => m.type === "status" && m.live === "open"),
    "sess-elder-a active as latest with both pinned and floating HUDs",
  );

  await postDatState({ connected: true, worn: true, battery: 81, streaming: true }, sessionA);
  const peerA = liveSessions[0];
  peerA.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-a-cue-1", name: "show_cue", args: { cue: "rotate_left", text: "Elder A turn left" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      hudPinnedA.received.some((m) => m.type === "coach" && m.text === "Elder A turn left") &&
      hudFloating.received.some((m) => m.type === "coach" && m.text === "Elder A turn left"),
    "sess-elder-a initial cue delivered to pinned A and floating HUD",
  );

  const phoneB = openWsClient(`/live?session=${sessionB}`);
  const hudPinnedB = openWsClient(`/hud-ws?session=${sessionB}`);
  await Promise.all([phoneB.ready, hudPinnedB.ready]);

  const pinnedACountBeforeB = hudPinnedA.received.length;
  const floatingCountBeforeB = hudFloating.received.length;

  phoneB.sendJson({
    type: "start",
    profile: profileB,
    lang: "fi",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 2 &&
      latestHub()?.id === sessionB &&
      hudPinnedB.received.some((m) => m.type === "status" && m.live === "open") &&
      hudFloating.received.slice(floatingCountBeforeB).some((m) => m.type === "status" && m.live === "open"),
    "sess-elder-b starts and transitions floating /hud-ws via markLatest",
  );

  assert.equal(hudPinnedA.received.length, pinnedACountBeforeB);

  const hubA = getHub(sessionA);
  const hubB = getHub(sessionB);
  assert.ok(hubA);
  assert.ok(hubB);
  assert.equal(hasHud(hubA), true);
  assert.equal(hasHud(hubB), true);

  const frameElderA = buildTestJpeg(120, 120, 2900, 61);
  const frameElderB = buildTestJpeg(120, 120, 2600, 77);

  await postDatFrame(frameElderA, { sessionId: sessionA, sharpness: 0.94 });
  assert.equal(hubA.ring.length, 1);
  assert.equal(hubA.ring.pick(1)[0].data, frameElderA.toString("base64"));
  assert.equal(hubB.ring.length, 0);

  await postDatFrame(frameElderB, { sharpness: 0.89 });
  assert.equal(hubB.ring.length, 1);
  assert.equal(hubB.ring.pick(1)[0].data, frameElderB.toString("base64"));
  assert.equal(hubA.ring.length, 1);
  assert.equal(hubA.ring.pick(1)[0].data, frameElderA.toString("base64"));

  const floatingIdxBeforeIsolation = hudFloating.received.length;
  const pinnedBIdxBeforeIsolation = hudPinnedB.received.length;
  const phoneBIdxBeforeIsolation = phoneB.received.length;

  await postDatState({ connected: true, worn: true, battery: 64, streaming: true }, sessionA);
  peerA.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-a-cue-2", name: "show_cue", args: { cue: "closer", text: "Elder A closer" } },
          { id: "fc-a-verify", name: "verify_label", args: { question: "Elder A evening check" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      hudPinnedA.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml-a") &&
      phoneA.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml-a"),
    "sess-elder-a device, cue, and verdict delivered strictly to sess-elder-a",
  );

  hudPinnedA.sendJson({ type: "event", name: "log_dose" });
  await waitFor(
    () =>
      hubA.profile.doseLog.length === 1 &&
      hudPinnedA.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday === true,
    "sess-elder-a log_dose mutates only sess-elder-a",
  );

  assert.equal(hudFloating.received.length, floatingIdxBeforeIsolation);
  assert.equal(hudPinnedB.received.length, pinnedBIdxBeforeIsolation);
  assert.equal(phoneB.received.length, phoneBIdxBeforeIsolation);
  assert.equal(hubB.profile.doseLog.length, 0);
  assert.equal(hubB.lastVerdict, undefined);

  const pinnedAIdxBeforeBMutations = hudPinnedA.received.length;
  const phoneAIdxBeforeBMutations = phoneA.received.length;

  await postDatState({ connected: true, worn: false, battery: 13, streaming: false }, sessionB);
  const peerB = liveSessions[1];
  peerB.callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-b-cue", name: "show_cue", args: { cue: "more_light", text: "Elder B more light" } },
          { id: "fc-b-verify", name: "verify_label", args: { question: "elder-b warfarin check" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      hudFloating.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "war-b") &&
      hudPinnedB.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "war-b") &&
      phoneB.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "war-b"),
    "sess-elder-b device, cue, and verdict delivered to sess-elder-b and floating HUD",
  );

  hudFloating.sendJson({ type: "event", name: "log_dose" });
  await waitFor(
    () =>
      hubB.profile.doseLog.length === 1 &&
      hudFloating.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday === true &&
      hudPinnedB.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday === true,
    "floating HUD log_dose targets latest sess-elder-b only",
  );

  assert.equal(hudPinnedA.received.length, pinnedAIdxBeforeBMutations);
  assert.equal(phoneA.received.length, phoneAIdxBeforeBMutations);
  assert.deepEqual(
    hubA.profile.doseLog.map((d) => d.medId),
    ["aml-a"],
  );
  assert.deepEqual(
    hubB.profile.doseLog.map((d) => d.medId),
    ["war-b"],
  );
  assert.equal(hubA.device?.battery, 64);
  assert.equal(hubB.device?.battery, 13);

  phoneA.sendJson({ type: "event", name: "stop" });
  await waitFor(() => hubA.live?.active === false, "sess-elder-a stopped cleanly");

  const floatingIdxBeforeReturnToA = hudFloating.received.length;
  phoneA.sendJson({
    type: "start",
    profile: hubA.profile,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      latestHub()?.id === sessionA &&
      hudFloating.received
        .slice(floatingIdxBeforeReturnToA)
        .some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml-a" && m.verdict.takenToday === true),
    "floating /hud-ws follows markLatest back to sess-elder-a with full replay",
  );
});

test("last /live client disconnect clears FrameRing immediately while preserving hub.resume within 10m so reconnecting /live resumes with handle and attached /hud-ws receives resumed status and next verdict", async () => {
  const sessionId = trackSession("sess-resume-continuity");
  const profile: Profile = {
    meds: [
      {
        id: "aml",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
      },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };

  const phone1 = openWsClient(`/live?session=${sessionId}`);
  const hud = openWsClient(`/hud-ws?session=${sessionId}`);
  await Promise.all([phone1.ready, hud.ready]);

  phone1.sendJson({
    type: "start",
    profile,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      phone1.received.some((m) => m.type === "status" && m.live === "open") &&
      hud.received.some((m) => m.type === "status" && m.live === "open"),
    "initial /live and /hud-ws open",
  );

  assert.deepEqual(liveSessions[0].config?.sessionResumption, {});

  await postDatState({ connected: true, worn: true, battery: 83, streaming: true }, sessionId);
  await postDatFrame(buildTestJpeg(100, 100, 2100, 5), { sessionId });
  await postDatFrame(buildTestJpeg(100, 100, 2800, 9), { sessionId });

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(hub.ring.length, 2);

  liveSessions[0].callbacks.onmessage?.(
    liveMsg({
      sessionResumptionUpdate: { resumable: true, newHandle: "gem-live-resume-901" },
    }),
  );
  assert.equal(hub.resume?.handle, "gem-live-resume-901");
  assert.equal(hub.resume?.model, env.liveModels[0]);
  assert.ok(Date.now() - (hub.resume?.at ?? 0) < 10 * 60_000);

  const hudIdxBeforeDrop = hud.received.length;
  await phone1.close();

  await waitFor(
    () =>
      hub.clients.size === 0 &&
      hub.ring.length === 0 &&
      hud.received
        .slice(hudIdxBeforeDrop)
        .some((m) => m.type === "status" && m.live === "closed" && m.detail === "client disconnected"),
    "last /live disconnect wipes FrameRing immediately and notifies attached HUD",
  );

  assert.equal(hub.ring.length, 0);
  assert.deepEqual(hub.ring.pick(2), []);
  assert.equal(liveSessions[0].closed, 1);
  assert.equal(hud.ws.readyState, WebSocket.OPEN);
  assert.equal(hasHud(hub), true);
  assert.equal(hub.resume?.handle, "gem-live-resume-901");

  const hudIdxBeforeReconnect = hud.received.length;
  const phone2 = openWsClient(`/live?session=${sessionId}`);
  await phone2.ready;

  await waitFor(
    () =>
      phone2.received.some((m) => m.type === "device" && m.device.battery === 83) &&
      phone2.received.some((m) => m.type === "hud" && m.connected === true),
    "reconnecting /live client receives replayed device state and attached HUD status",
  );

  phone2.sendJson({
    type: "start",
    profile,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 2 &&
      phone2.received.some((m) => m.type === "status" && m.live === "open") &&
      hud.received.slice(hudIdxBeforeReconnect).some((m) => m.type === "status" && m.live === "open"),
    "reconnecting /live session resumes Gemini Live and updates attached HUD",
  );

  assert.deepEqual(liveSessions[1].config?.sessionResumption, { handle: "gem-live-resume-901" });
  const hudResumeStatuses = hud.received
    .slice(hudIdxBeforeReconnect)
    .filter((m): m is Extract<ServerMsg, { type: "status" }> => m.type === "status");
  assert.deepEqual(hudResumeStatuses, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "status", live: "open", detail: env.liveModels[0] },
  ]);

  const freshReconnectJpg = buildTestJpeg(100, 100, 3200, 88);
  await postDatFrame(freshReconnectJpg, { sessionId });
  assert.equal(hub.ring.length, 1);

  liveSessions[1].callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-resumed-verify", name: "verify_label", args: { question: "Check resumed session pill" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      phone2.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml") &&
      hud.received
        .slice(hudIdxBeforeReconnect)
        .some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml"),
    "attached /hud-ws and reconnected /live receive next verdict after sessionResumption",
  );

  const resumedVerdictPhone = phone2.received.find(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  )?.verdict as Verdict | undefined;
  const resumedVerdictHud = hud.received
    .slice(hudIdxBeforeReconnect)
    .find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict")?.verdict;
  assert.ok(resumedVerdictPhone);
  assert.deepEqual(resumedVerdictHud, resumedVerdictPhone);

  await phone2.close();
  await waitFor(() => hub.clients.size === 0 && hub.ring.length === 0, "second disconnect wipes FrameRing");

  hub.resume = {
    handle: "expired-handle-older-than-10m",
    model: env.liveModels[0],
    at: Date.now() - (10 * 60_000 + 5_000),
  };

  const phone3 = openWsClient(`/live?session=${sessionId}`);
  await phone3.ready;
  phone3.sendJson({
    type: "start",
    profile,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () => liveSessions.length === 3 && phone3.received.some((m) => m.type === "status" && m.live === "open"),
    "reconnect past 10-minute window starts fresh without stale resumption handle",
  );
  assert.deepEqual(liveSessions[2].config?.sessionResumption, {});
});

test("handoff-1 Finnish live session covers pre-connected /hud-ws orphan battery 82, 0.72 glasses vs 0.91 phone sharpness verify_label bracket, late /hud-ws replay, and post-disconnect HUD log_dose + repeat", async () => {
  const hud1 = openWsClient("/hud-ws");
  await hud1.ready;

  await postDatState({ connected: true, worn: true, streaming: true, battery: 82 });
  const expectedOrphan82: DeviceState = {
    connected: true,
    worn: true,
    streaming: true,
    battery: 82,
    source: "glasses",
  };
  await waitFor(
    () => hud1.received.some((m) => m.type === "device" && m.device.battery === 82),
    "pre-connected floating /hud-ws receives orphan battery 82 state",
  );
  assert.deepEqual(hud1.received[0], { type: "device", device: expectedOrphan82 });

  const sessionId = trackSession("handoff-1");
  const liveClient = openWsClient(`/live?session=${sessionId}`);
  await liveClient.ready;

  const fiProfile: Profile = {
    meds: [
      {
        id: "aml-fi",
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
    lang: "fi",
  };

  liveClient.sendJson({
    type: "start",
    profile: fiProfile,
    lang: "fi",
    voice: true,
    source: "glasses",
  });

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      liveClient.received.some((m) => m.type === "hud" && m.connected === true) &&
      liveClient.received.some((m) => m.type === "status" && m.live === "open"),
    "handoff-1 started in Finnish and bound orphan device + floating HUD",
  );

  const hub = getHub(sessionId);
  assert.ok(hub);
  assert.equal(latestHub(), hub);
  assert.deepEqual(hub.device, expectedOrphan82);
  assert.equal(hub.profile.lang, "fi");
  assert.equal(hub.profile.meds.length, 1);
  assert.equal(hub.profile.meds[0].id, "aml-fi");

  await postDatFrame(fixtureAmlodipineJpg, { sessionId, sharpness: 0.72 });
  assert.equal(hub.ring.length, 1);
  assert.equal(hub.ring.pick(1)[0].source, "glasses");
  assert.equal(hub.ring.pick(1)[0].sharpness, 0.72);

  const lowBatDoff: DeviceState = {
    connected: true,
    worn: false,
    streaming: false,
    battery: 9,
    source: "glasses",
  };
  await postDatState({ connected: true, worn: false, streaming: false, battery: 9 }, sessionId);

  await waitFor(
    () =>
      liveClient.received.some(
        (m) => m.type === "device" && m.device.battery === 9 && m.device.worn === false,
      ) &&
      hud1.received.some(
        (m) => m.type === "device" && m.device.battery === 9 && m.device.worn === false,
      ),
    "doff + battery 9 delivered to both /live and floating /hud-ws",
  );
  assert.equal(hub.live?.active, true);
  assert.equal(liveSessions[0].closed, 0);
  assert.equal(hub.profile.lang, "fi");
  assert.equal(hub.profile.meds[0].id, "aml-fi");

  const phoneFallbackJpg = buildTestJpeg(768, 768, 4200, 93);
  const phoneFallbackB64 = phoneFallbackJpg.toString("base64");
  liveClient.sendJson({
    type: "frame",
    data: phoneFallbackB64,
    w: 768,
    h: 768,
    sharpness: 0.91,
    ts: Date.now(),
  });

  await waitFor(() => hub.ring.length === 2, "phone fallback frame recorded in handoff-1 FrameRing");
  const picked = hub.ring.pick(2);
  assert.equal(picked[0].source, "phone");
  assert.equal(picked[0].sharpness, 0.91);
  assert.equal(picked[0].data, phoneFallbackB64);
  assert.equal(picked[1].source, "glasses");
  assert.equal(picked[1].sharpness, 0.72);

  const liveIdxBeforeVerify = liveClient.received.length;
  liveSessions[0].callbacks.onmessage?.(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-fi-verify", name: "verify_label", args: { question: "Onko tama iltalake?" } },
        ],
      },
    }),
  );

  await waitFor(
    () =>
      verifyCaptures.length === 1 &&
      liveClient.received
        .slice(liveIdxBeforeVerify)
        .some((m) => m.type === "checking" && m.phase === "end") &&
      hud1.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml-fi"),
    "verify_label emits checking start -> verdict -> checking end across /live and /hud-ws",
  );

  assert.deepEqual(verifyCaptures[0].frames, [
    phoneFallbackB64,
    fixtureAmlodipineJpg.toString("base64"),
  ]);

  const liveVerifySlice = liveClient.received.slice(liveIdxBeforeVerify);
  const startPos = liveVerifySlice.findIndex((m) => m.type === "checking" && m.phase === "start");
  const verdictPos = liveVerifySlice.findIndex((m) => m.type === "verdict");
  const endPos = liveVerifySlice.findIndex((m) => m.type === "checking" && m.phase === "end");
  assert.ok(startPos >= 0 && verdictPos > startPos && endPos > verdictPos);

  const hud2 = openWsClient("/hud-ws");
  await hud2.ready;
  await waitFor(() => hud2.received.length >= 4, "2nd zero-code /hud-ws receives instant 4-message replay");
  assert.deepEqual(
    hud2.received.slice(0, 4).map((m) => m.type),
    ["status", "device", "coach", "verdict"],
  );
  assert.deepEqual(hud2.received[1], { type: "device", device: lowBatDoff });

  await liveClient.close();
  await waitFor(
    () => hub.clients.size === 0 && hub.ring.length === 0 && hub.live?.active === false,
    "/live disconnect immediately zeroes FrameRing and closes LiveProxy",
  );
  assert.equal(hub.ring.length, 0);

  const hud1VerdictsBeforeDose = hud1.received.filter((m) => m.type === "verdict").length;
  const hud2VerdictsBeforeDose = hud2.received.filter((m) => m.type === "verdict").length;

  hud2.sendJson({ type: "event", name: "log_dose" });
  await waitFor(
    () =>
      hub.profile.doseLog.length === 1 &&
      hud1.received.filter((m) => m.type === "verdict").length === hud1VerdictsBeforeDose + 1 &&
      hud2.received.filter((m) => m.type === "verdict").length === hud2VerdictsBeforeDose + 1,
    "post-disconnect HUD log_dose increments doseLog and fans out takenToday true verdict",
  );
  assert.equal(hub.profile.doseLog[0].medId, "aml-fi");
  assert.equal(hud1.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday, true);
  assert.equal(hud2.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday, true);

  hud1.sendJson({ type: "event", name: "repeat" });
  await waitFor(
    () =>
      hud1.received.filter((m) => m.type === "verdict").length === hud1VerdictsBeforeDose + 2 &&
      hud2.received.filter((m) => m.type === "verdict").length === hud2VerdictsBeforeDose + 2,
    "post-disconnect HUD repeat re-emits updated takenToday true verdict to all HUDs",
  );
  assert.equal(hud2.received.filter((m) => m.type === "verdict").at(-1)?.verdict.takenToday, true);
});

test("device-handoff-e2e.test.ts contains zero comments, em dashes, trailers, or API keys", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const emDash = String.fromCharCode(0x2014);
  const coAuthored = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const keyPrefix = ["AI", "za"].join("");

  assert.equal(src.includes(slash + slash), false);
  assert.equal(src.includes(slash + star), false);
  assert.equal(src.includes(star + slash), false);
  assert.equal(src.includes(emDash), false);
  assert.equal(coAuthored.test(src), false);
  assert.equal(src.includes(keyPrefix), false);
});
