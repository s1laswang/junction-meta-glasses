import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  Behavior,
  FunctionResponseScheduling,
  Modality,
  type LiveConnectParameters,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import WebSocket from "ws";
import type { CoachCue, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import {
  Hub,
  addHud,
  getHub,
  getOrCreateHub,
  markLatest,
  resetHubsForTest,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { stats } from "../src/ledger.ts";
import { LiveProxy, TOOLS } from "../src/live.ts";
import { unreadable, type VerifyResult } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

const SEP = `:${String.fromCharCode(47, 47)}`;
const tempLedger = path.join(os.tmpdir(), `holdup-live-coaching-${process.pid}.jsonl`);

type MockLiveSession = {
  model: string;
  config: LiveConnectParameters["config"];
  callbacks: LiveConnectParameters["callbacks"];
  realtimeInputs: Array<Record<string, unknown>>;
  toolResponses: Array<Record<string, unknown>>;
  closed: number;
  session: Session;
};

type MockHubSocket = {
  ws: WebSocket;
  sent: ServerMsg[];
  close: () => void;
};

const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);

let prevApiKey = "";
let prevLedger = "";
let server: http.Server;
let wsBase = "";

let connectImpl: ((params: LiveConnectParameters) => Promise<Session>) | null = null;
let generateImpl: ((params: Record<string, unknown>) => Promise<{ text?: string; usageMetadata?: unknown }>) | null = null;
let liveSessions: MockLiveSession[] = [];
let trackedProxies: LiveProxy[] = [];
let trackedWs: WebSocket[] = [];

function createMockLiveSession(params: LiveConnectParameters): MockLiveSession {
  const entry: MockLiveSession = {
    model: params.model,
    config: params.config,
    callbacks: params.callbacks,
    realtimeInputs: [],
    toolResponses: [],
    closed: 0,
    session: null as unknown as Session,
  };
  entry.session = {
    sendRealtimeInput(input: Record<string, unknown>) {
      entry.realtimeInputs.push(input);
    },
    sendToolResponse(resp: Record<string, unknown>) {
      entry.toolResponses.push(resp);
    },
    close() {
      entry.closed++;
    },
  } as unknown as Session;
  liveSessions.push(entry);
  return entry;
}

function createMockHubSocket(readyState = 1): MockHubSocket {
  const sent: ServerMsg[] = [];
  const closeListeners: Array<() => void> = [];
  const raw = {
    readyState,
    send(payload: string) {
      sent.push(JSON.parse(payload) as ServerMsg);
    },
    on(event: string, cb: () => void) {
      if (event === "close") closeListeners.push(cb);
      return raw;
    },
  };
  return {
    ws: raw as unknown as WebSocket,
    sent,
    close() {
      raw.readyState = 3;
      for (const cb of closeListeners) cb();
    },
  };
}

function trackProxy(proxy: LiveProxy): LiveProxy {
  trackedProxies.push(proxy);
  return proxy;
}

function liveMsg(partial: Partial<LiveServerMessage>): LiveServerMessage {
  return { text: undefined, data: undefined, ...partial };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 1500): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 4);
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openRealWs(url: string) {
  const ws = new WebSocket(url);
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
      ws.once("close", () => resolve());
      ws.close();
    });
  return { ws, received, ready, close };
}

function buildProfile(): Profile {
  return {
    meds: [
      { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
      { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: [] },
    ],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };
}

function validLabelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-11", confidence: 0.93 },
    allergens: { value: [], confidence: 0.9 },
    barcode: { value: "6432100012345", confidence: 0.92 },
    readability: 0.95,
    ...overrides,
  });
}

function sampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg: match",
    speech: "Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: unreadable(),
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
    ...overrides,
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
  wsBase = `ws${SEP}127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
  liveSessions = [];
  trackedProxies = [];
  trackedWs = [];
  connectImpl = async (params) => createMockLiveSession(params).session;
  generateImpl = null;

  (ai.live as unknown as { connect: (p: LiveConnectParameters) => Promise<Session> }).connect = (params) => {
    if (!connectImpl) throw new Error("unexpected ai.live.connect call");
    return connectImpl(params);
  };
  (ai.models as unknown as { generateContent: (p: Record<string, unknown>) => Promise<unknown> }).generateContent = (
    params,
  ) => {
    if (!generateImpl) throw new Error("unexpected ai.models.generateContent call");
    return generateImpl(params);
  };
});

afterEach(async () => {
  for (const p of trackedProxies) {
    p.stop("test cleanup");
  }
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
          }, 200);
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
  resetHubsForTest();
  connectImpl = null;
  generateImpl = null;
});

after(async () => {
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent = origGenerateContent;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("LiveProxy.start configures Gemini Live tools and systemInstruction without strength leaks and throttles video to <= 1 fps", async () => {
  const hub = new Hub("sess-config");
  hub.profile = buildProfile();
  const phone = createMockHubSocket();
  const hud = createMockHubSocket();
  hub.clients.add(phone.ws);
  hub.huds.add(hud.ws);

  const proxy = trackProxy(new LiveProxy(hub, { lang: "fi", voice: true }));
  await proxy.start();

  assert.equal(liveSessions.length, 1);
  const live = liveSessions[0];
  assert.equal(live.model, env.liveModels[0]);
  assert.deepEqual(live.config?.responseModalities, [Modality.AUDIO]);
  assert.deepEqual(live.config?.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(live.config?.sessionResumption, {});

  const toolDecls = (live.config?.tools?.[0] as { functionDeclarations?: typeof TOOLS } | undefined)
    ?.functionDeclarations;
  assert.deepEqual(toolDecls, TOOLS);
  const showCueDecl = TOOLS.find((t) => t.name === "show_cue");
  assert.equal(showCueDecl?.behavior, Behavior.NON_BLOCKING);
  const expectedCues: CoachCue[] = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok",
  ];
  assert.deepEqual(
    (showCueDecl?.parameters?.properties as Record<string, { enum?: string[] }>).cue.enum,
    expectedCues,
  );

  const sys = String(live.config?.systemInstruction ?? "");
  assert.match(sys, /Language: Finnish\. Speak Finnish\./);
  assert.match(sys, /medId "aml": Norvasc \(amlodipine\), taken evening/);
  assert.match(sys, /medId "par": Panadol \(paracetamol\), taken as needed/);
  assert.match(sys, /Allergies: peanut/);
  assert.match(sys, /Avoid: NSAIDs/);
  assert.equal(sys.includes("5 mg"), false);
  assert.equal(sys.includes("500 mg"), false);

  assert.deepEqual(phone.sent, [
    { type: "status", live: "connecting" },
    { type: "ready", model: env.liveModels[0], session: "sess-config" },
    { type: "status", live: "open", detail: env.liveModels[0] },
  ]);
  assert.deepEqual(hud.sent, [
    { type: "status", live: "connecting" },
    { type: "status", live: "open", detail: env.liveModels[0] },
  ]);

  proxy.audio("cGNtMTZhdWRpbw==");
  assert.deepEqual(live.realtimeInputs[0], {
    audio: { data: "cGNtMTZhdWRpbw==", mimeType: "audio/pcm;rate=16000" },
  });

  const origNow = Date.now;
  let fakeNow = 50_000;
  Date.now = () => fakeNow;
  try {
    proxy.frame("frame-at-50000");
    fakeNow = 50_899;
    proxy.frame("frame-throttled-899");
    fakeNow = 50_900;
    proxy.frame("frame-at-50900");
  } finally {
    Date.now = origNow;
  }

  assert.equal(live.realtimeInputs.length, 3);
  assert.deepEqual(live.realtimeInputs[1], {
    video: { data: "frame-at-50000", mimeType: "image/jpeg" },
  });
  assert.deepEqual(live.realtimeInputs[2], {
    video: { data: "frame-at-50900", mimeType: "image/jpeg" },
  });

  proxy.text("Q".repeat(1250));
  assert.deepEqual(live.realtimeInputs[3], { text: "Q".repeat(1000) });

  proxy.stop("done");
  assert.equal(proxy.active, false);
  assert.equal(live.closed, 1);
});

test("show_cue tool call fans out coaching cues to phone, explicit HUD, and floating HUD with SILENT tool response", async () => {
  const hub = getOrCreateHub("sess-cue");
  const phone = createMockHubSocket();
  const explicitHud = createMockHubSocket();
  const floatingHud = createMockHubSocket();
  hub.clients.add(phone.ws);
  addHud(explicitHud.ws, "sess-cue");
  addHud(floatingHud.ws);
  markLatest(hub);

  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
  await proxy.start();
  const live = liveSessions[0];

  phone.sent.length = 0;
  explicitHud.sent.length = 0;
  floatingHud.sent.length = 0;

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "fc-cue-1", name: "show_cue", args: { cue: "rotate_left", text: "Turn it slightly left" } }],
      },
    }),
  );

  const expectedCoach: ServerMsg = { type: "coach", cue: "rotate_left", text: "Turn it slightly left" };
  assert.deepEqual(phone.sent, [expectedCoach]);
  assert.deepEqual(explicitHud.sent, [expectedCoach]);
  assert.deepEqual(floatingHud.sent, [expectedCoach]);
  assert.deepEqual(hub.lastCoach, expectedCoach);
  assert.deepEqual(live.toolResponses, [
    {
      functionResponses: [
        {
          id: "fc-cue-1",
          name: "show_cue",
          response: { output: { shown: true } },
          scheduling: FunctionResponseScheduling.SILENT,
        },
      ],
    },
  ]);

  phone.sent.length = 0;
  explicitHud.sent.length = 0;
  floatingHud.sent.length = 0;
  live.toolResponses.length = 0;

  const overlongText = "Move closer to the light source right now please ".repeat(2);
  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "fc-cue-2", name: "show_cue", args: { cue: "bogus_cue", text: overlongText } }],
      },
    }),
  );

  const sanitizedCoach: ServerMsg = {
    type: "coach",
    cue: "hold_still",
    text: overlongText.slice(0, 60),
  };
  assert.equal(sanitizedCoach.text.length, 60);
  assert.deepEqual(phone.sent, [sanitizedCoach]);
  assert.deepEqual(explicitHud.sent, [sanitizedCoach]);
  assert.deepEqual(floatingHud.sent, [sanitizedCoach]);
  assert.equal(live.toolResponses.length, 1);
  assert.equal(
    (live.toolResponses[0].functionResponses as Array<{ scheduling?: unknown }>)[0].scheduling,
    FunctionResponseScheduling.SILENT,
  );
});

test("verify_label tool call picks top-2 sharpest frames, fans out coach and verdict to HUDs without checking noise, and returns structured tool output", async () => {
  const hub = getOrCreateHub("sess-verify");
  hub.profile = buildProfile();
  const phone = createMockHubSocket();
  const explicitHud = createMockHubSocket();
  const floatingHud = createMockHubSocket();
  hub.clients.add(phone.ws);
  addHud(explicitHud.ws, "sess-verify");
  addHud(floatingHud.ws);
  markLatest(hub);

  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
  await proxy.start();
  const live = liveSessions[0];

  phone.sent.length = 0;
  explicitHud.sent.length = 0;
  floatingHud.sent.length = 0;

  live.callbacks.onmessage(
    liveMsg({
      toolCall: { functionCalls: [{ id: "fc-ver-empty", name: "verify_label", args: { question: "what is this?" } }] },
    }),
  );

  assert.equal(phone.sent.length, 0);
  assert.equal(explicitHud.sent.length, 0);
  assert.equal(live.toolResponses.length, 1);
  const emptyResp = (live.toolResponses[0].functionResponses as Array<Record<string, any>>)[0];
  assert.equal(emptyResp.id, "fc-ver-empty");
  assert.equal(emptyResp.scheduling, undefined);
  assert.deepEqual(emptyResp.response.output, {
    level: "unsure",
    speech: "I can't see anything yet. Hold the item up in front of your face.",
  });

  live.toolResponses.length = 0;
  const now = Date.now();
  hub.ring.push({ data: "blurry-031", sharpness: 0.31, ts: now - 400, bytes: 200, source: "glasses" });
  hub.ring.push({ data: "sharp-094", sharpness: 0.94, ts: now - 300, bytes: 500, source: "glasses" });
  hub.ring.push({ data: "mid-052", sharpness: 0.52, ts: now - 200, bytes: 320, source: "phone" });
  hub.ring.push({ data: "sharp-088", sharpness: 0.88, ts: now - 100, bytes: 460, source: "glasses" });

  let capturedParts: Array<Record<string, any>> = [];
  generateImpl = async (params) => {
    const contents = params.contents as Array<{ parts: Array<Record<string, any>> }>;
    capturedParts = contents[0].parts;
    return { text: validLabelJson(), usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 35 } };
  };

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "fc-ver-match", name: "verify_label", args: { question: "Is this my evening pill?" } }],
      },
    }),
  );

  await waitFor(() => live.toolResponses.length === 1, "verify_label tool response");

  assert.deepEqual(capturedParts, [
    { inlineData: { mimeType: "image/jpeg", data: "sharp-094" } },
    { inlineData: { mimeType: "image/jpeg", data: "sharp-088" } },
    { text: 'The person asked: "Is this my evening pill?"' },
  ]);

  assert.equal(phone.sent.length, 4);
  assert.deepEqual(phone.sent[0], { type: "checking", phase: "start" });
  assert.deepEqual(phone.sent[1], { type: "coach", cue: "hold_still", text: "Hold still, reading\u2026" });
  assert.equal(phone.sent[2].type, "verdict");
  assert.deepEqual(phone.sent[3], { type: "checking", phase: "end" });

  const emittedVerdict = (phone.sent[2] as Extract<ServerMsg, { type: "verdict" }>).verdict;
  assert.equal(emittedVerdict.level, "match");
  assert.equal(emittedVerdict.matchedMedId, "aml");
  assert.equal(emittedVerdict.takenToday, false);
  assert.deepEqual(hub.lastVerdict, emittedVerdict);

  const expectedHudMsgs: ServerMsg[] = [
    { type: "coach", cue: "hold_still", text: "Hold still, reading\u2026" },
    { type: "verdict", verdict: emittedVerdict },
  ];
  assert.deepEqual(explicitHud.sent, expectedHudMsgs);
  assert.deepEqual(floatingHud.sent, expectedHudMsgs);

  const lateHud = createMockHubSocket();
  addHud(lateHud.ws);
  assert.deepEqual(lateHud.sent, [
    { type: "status", live: "open", detail: env.liveModels[0] },
    { type: "coach", cue: "hold_still", text: "Hold still, reading\u2026" },
    { type: "verdict", verdict: emittedVerdict },
  ]);

  const verResp = (live.toolResponses[0].functionResponses as Array<Record<string, any>>)[0];
  assert.equal(verResp.id, "fc-ver-match");
  assert.equal(verResp.name, "verify_label");
  assert.equal(verResp.scheduling, undefined);
  assert.deepEqual(verResp.response.output, {
    level: "match",
    speech: emittedVerdict.speech,
    headline: emittedVerdict.headline,
    matchedMedId: "aml",
    guidance: null,
    takenToday: false,
    instruction: "Say `speech` word for word (translate faithfully if needed), then stop. No disclaimer, add nothing.",
  });

  const errHub = new Hub("sess-verify-err");
  errHub.ring.push({ data: "sharp-err", sharpness: 0.9, ts: Date.now(), bytes: 400, source: "phone" });
  const errProxy = trackProxy(
    new LiveProxy(errHub, {
      lang: "en",
      voice: true,
      verifyFn: async () => {
        throw new Error("reader crash");
      },
    }),
  );
  await errProxy.start();
  const errLive = liveSessions[1];
  await errProxy.onTool({ id: "fc-ver-err", name: "verify_label", args: {} });
  assert.equal(errLive.toolResponses.length, 1);
  assert.deepEqual((errLive.toolResponses[0].functionResponses as Array<Record<string, any>>)[0].response.output, {
    level: "unsure",
    speech: "Sorry, I couldn't check that. Please try again.",
  });
});

test("log_dose and unknown tool calls dispatch cleanly and active handleEvent syncs HUDs plus sendRealtimeInput prompts", async () => {
  const hub = getOrCreateHub("sess-dose-tools");
  hub.profile = buildProfile();
  const phone = createMockHubSocket();
  const hud = createMockHubSocket();
  hub.clients.add(phone.ws);
  addHud(hud.ws, "sess-dose-tools");

  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
  await proxy.start();
  const live = liveSessions[0];

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-dose-bad", name: "log_dose", args: { medId: "nonexistent" } },
          { id: "fc-dose-ok", name: "log_dose", args: { medId: "aml" } },
          { id: "fc-unknown", name: "erase_everything", args: {} },
        ],
      },
    }),
  );

  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  assert.equal(live.toolResponses.length, 3);
  assert.deepEqual((live.toolResponses[0].functionResponses as Array<Record<string, any>>)[0].response.output, {
    ok: false,
    error: "unknown medId",
  });
  assert.deepEqual((live.toolResponses[1].functionResponses as Array<Record<string, any>>)[0].response.output, {
    ok: true,
    med: "Norvasc",
  });
  assert.deepEqual((live.toolResponses[2].functionResponses as Array<Record<string, any>>)[0].response.output, {
    error: "unknown tool erase_everything",
  });

  const verdict = sampleVerdict({ matchedMedId: "aml", takenToday: false });
  hub.emit({ type: "verdict", verdict });
  phone.sent.length = 0;
  hud.sent.length = 0;
  live.realtimeInputs.length = 0;

  proxy.handleEvent("repeat");
  assert.deepEqual(phone.sent, [{ type: "verdict", verdict }]);
  assert.deepEqual(hud.sent, [{ type: "verdict", verdict }]);
  assert.deepEqual(live.realtimeInputs, [
    { text: "(The user pressed Repeat. Repeat your last answer briefly, word for word.)" },
  ]);

  phone.sent.length = 0;
  hud.sent.length = 0;
  live.realtimeInputs.length = 0;

  proxy.handleEvent("log_dose");
  assert.equal(hub.profile.doseLog.length, 2);
  const takenVerdict = { ...verdict, takenToday: true };
  assert.deepEqual(phone.sent, [{ type: "verdict", verdict: takenVerdict }]);
  assert.deepEqual(hud.sent, [{ type: "verdict", verdict: takenVerdict }]);
  assert.deepEqual(live.realtimeInputs, [
    { text: "(The user just logged a dose of Norvasc. Confirm in three or four words.)" },
  ]);
});

test("barge-in interrupted flushes transcripts, respects voice flag, keeps audio off HUD, and cancels in-flight tool responses", async () => {
  const hub = getOrCreateHub("sess-barge");
  const phone = createMockHubSocket();
  const hud = createMockHubSocket();
  hub.clients.add(phone.ws);
  addHud(hud.ws, "sess-barge");

  const gate = deferred<VerifyResult>();
  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true, verifyFn: () => gate.promise }));
  await proxy.start();
  const live = liveSessions[0];

  phone.sent.length = 0;
  hud.sent.length = 0;

  live.callbacks.onmessage(
    liveMsg({
      serverContent: {
        inputTranscription: { text: "Is this my ", finished: false },
      },
    }),
  );
  live.callbacks.onmessage(
    liveMsg({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "cGNtMjRr" } }] },
        outputTranscription: { text: "Turn the box slowly " },
      },
    }),
  );
  live.callbacks.onmessage(
    liveMsg({
      serverContent: {
        inputTranscription: { text: "Wait hold on", finished: false },
        interrupted: true,
      },
    }),
  );

  assert.deepEqual(phone.sent, [
    { type: "transcript", role: "user", text: "Is this my", final: false },
    { type: "audio", data: "cGNtMjRr" },
    { type: "transcript", role: "user", text: "Is this my", final: true },
    { type: "transcript", role: "assistant", text: "Turn the box slowly", final: false },
    { type: "transcript", role: "user", text: "Wait hold on", final: false },
    { type: "interrupted" },
    { type: "status", live: "open", detail: "interrupted" },
    { type: "transcript", role: "assistant", text: "Turn the box slowly", final: true },
    { type: "transcript", role: "user", text: "Wait hold on", final: true },
  ]);
  assert.deepEqual(hud.sent, [{ type: "status", live: "open", detail: "interrupted" }]);

  phone.sent.length = 0;
  hud.sent.length = 0;

  hub.ring.push({ data: "barge-frame", sharpness: 0.92, ts: Date.now(), bytes: 420, source: "glasses" });
  const pendingVerify = proxy.onTool({ id: "fc-cancel-verify", name: "verify_label", args: {} });

  live.callbacks.onmessage(liveMsg({ toolCallCancellation: { ids: ["fc-cancel-verify", "fc-cancel-cue"] } }));

  await proxy.onTool({ id: "fc-cancel-cue", name: "show_cue", args: { cue: "closer", text: "Closer" } });
  gate.resolve({ verdict: sampleVerdict(), model: "mock-flash", latencyMs: 9, frames: 1 });
  await pendingVerify;

  assert.equal(live.toolResponses.length, 0);
  assert.equal(phone.sent.some((m) => m.type === "verdict"), false);
  assert.equal(hud.sent.some((m) => m.type === "verdict"), false);
  assert.deepEqual(phone.sent.at(0), { type: "checking", phase: "start" });
  assert.deepEqual(phone.sent.at(-1), { type: "checking", phase: "end" });

  const silentHub = new Hub("sess-muted");
  const silentPhone = createMockHubSocket();
  silentHub.clients.add(silentPhone.ws);
  const silentProxy = trackProxy(new LiveProxy(silentHub, { lang: "en", voice: false }));
  await silentProxy.start();
  silentPhone.sent.length = 0;

  liveSessions[1].callbacks.onmessage(
    liveMsg({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "cGNtMjRr" } }] },
        outputTranscription: { text: "Text only answer" },
        turnComplete: true,
      },
    }),
  );
  assert.equal(silentPhone.sent.some((m) => m.type === "audio"), false);
  assert.deepEqual(silentPhone.sent, [
    { type: "transcript", role: "assistant", text: "Text only answer", final: false },
    { type: "transcript", role: "assistant", text: "Text only answer", final: true },
  ]);
});

test("sessionResumptionUpdate, goAway reconnect, remote close quota fallback, degraded exhaustion, and 45s idle auto-stop clean up deterministically", async () => {
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    const hub = getOrCreateHub("sess-lifecycle");
    const phone = createMockHubSocket();
    const hud = createMockHubSocket();
    hub.clients.add(phone.ws);
    addHud(hud.ws, "sess-lifecycle");

    const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
    await proxy.start();
    assert.equal(liveSessions.length, 1);
    const first = liveSessions[0];

    first.callbacks.onmessage(
      liveMsg({
        sessionResumptionUpdate: { resumable: true, newHandle: "resume-handle-42" },
      }),
    );
    assert.equal(hub.resume?.handle, "resume-handle-42");
    assert.equal(hub.resume?.model, env.liveModels[0]);

    first.callbacks.onmessage(liveMsg({ goAway: { timeLeft: "4s" } }));
    await waitFor(() => liveSessions.length === 2, "goAway session resumption reconnect");

    assert.equal(first.closed, 1);
    const second = liveSessions[1];
    assert.deepEqual(second.config?.sessionResumption, { handle: "resume-handle-42" });

    const countBeforeStale = phone.sent.length;
    first.callbacks.onmessage(liveMsg({ serverContent: { interrupted: true } }));
    first.callbacks.onclose?.({ code: 1006, reason: "stale" } as CloseEvent);
    assert.equal(phone.sent.length, countBeforeStale);

    second.callbacks.onclose?.({ code: 1008, reason: "rejected audio frame" } as CloseEvent);
    await waitFor(() => liveSessions.length === 3, "remote 1008 bad_input reconnect on same model");
    assert.equal(liveSessions[2].model, env.liveModels[0]);
    assert.deepEqual(liveSessions[2].config?.sessionResumption, {});
    assert.equal(phone.sent.some((m) => m.type === "error" && m.code === "bad_input"), true);

    liveSessions[2].callbacks.onclose?.({ code: 1011, reason: "429 RESOURCE_EXHAUSTED" } as CloseEvent);
    await waitFor(() => liveSessions.length === 4, "remote quota close fallback reconnect");
    assert.equal(liveSessions[3].model, env.liveModels[1]);
    assert.equal(phone.sent.some((m) => m.type === "error" && m.code === "quota"), true);
    proxy.stop("lifecycle test done");

    let resumeConnectAttempts = 0;
    connectImpl = async (params) => {
      resumeConnectAttempts++;
      if (resumeConnectAttempts === 1) throw new Error("invalid resumption handle");
      return createMockLiveSession(params).session;
    };
    const freshResumeHub = new Hub("sess-fresh-resume");
    freshResumeHub.resume = { handle: "stale-server-handle", model: env.liveModels[1], at: Date.now() - 30_000 };
    const retryResumeProxy = trackProxy(new LiveProxy(freshResumeHub, { lang: "en", voice: true }));
    await retryResumeProxy.start();
    assert.equal(resumeConnectAttempts, 2);
    assert.equal(liveSessions[4].model, env.liveModels[1]);
    assert.deepEqual(liveSessions[4].config?.sessionResumption, {});
    retryResumeProxy.stop("done");

    connectImpl = async (params) => createMockLiveSession(params).session;
    const expiredHub = new Hub("sess-expired-resume");
    expiredHub.resume = { handle: "old-handle", model: env.liveModels[1], at: Date.now() - 11 * 60_000 };
    const freshProxy = trackProxy(new LiveProxy(expiredHub, { lang: "en", voice: true }));
    await freshProxy.start();
    assert.equal(liveSessions[5].model, env.liveModels[0]);
    assert.deepEqual(liveSessions[5].config?.sessionResumption, {});
    freshProxy.stop("done");

    const triedModels: string[] = [];
    connectImpl = async (params) => {
      triedModels.push(params.model);
      throw new Error(triedModels.length === 1 ? "429 quota exceeded" : "503 unavailable");
    };
    const degHub = getOrCreateHub("sess-degraded");
    const degPhone = createMockHubSocket();
    const degHud = createMockHubSocket();
    degHub.clients.add(degPhone.ws);
    addHud(degHud.ws, "sess-degraded");
    const degProxy = trackProxy(new LiveProxy(degHub, { lang: "en", voice: true }));
    await degProxy.start();

    assert.deepEqual(triedModels, env.liveModels);
    assert.equal(degProxy.active, false);
    assert.deepEqual(degHud.sent.at(-1), {
      type: "status",
      live: "degraded",
      detail: "Gemini Live unavailable, use snapshot mode",
    });
    assert.equal(
      degPhone.sent.some((m) => m.type === "error" && m.code === "gemini_unavailable" && m.recoverable),
      true,
    );

    const raceGate = deferred<Session>();
    let lateSessionClosed = 0;
    connectImpl = () => raceGate.promise;
    const raceHub = new Hub("sess-race");
    const raceProxy = trackProxy(new LiveProxy(raceHub, { lang: "en", voice: true }));
    const startPromise = raceProxy.start();
    raceProxy.stop("cancelled while connecting");
    raceGate.resolve({
      sendRealtimeInput() {},
      sendToolResponse() {},
      close() {
        lateSessionClosed++;
      },
    } as unknown as Session);
    await startPromise;
    assert.equal(lateSessionClosed, 1);
    assert.equal(raceProxy.active, false);
  } finally {
    Math.random = origRandom;
  }

  connectImpl = async (params) => createMockLiveSession(params).session;
  const origSetInterval = globalThis.setInterval;
  const origNow = Date.now;
  let capturedIdleTick: (() => void) | undefined;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  globalThis.setInterval = ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 2000) capturedIdleTick = () => cb();
    return origSetInterval(cb, ms, ...rest);
  }) as typeof setInterval;

  try {
    const idleHub = getOrCreateHub("sess-idle");
    const idlePhone = createMockHubSocket();
    const idleHud = createMockHubSocket();
    idleHub.clients.add(idlePhone.ws);
    addHud(idleHud.ws, "sess-idle");

    const idleProxy = trackProxy(new LiveProxy(idleHub, { lang: "en", voice: true }));
    await idleProxy.start();
    const idleLive = liveSessions.at(-1)!;
    assert.ok(capturedIdleTick);

    idlePhone.sent.length = 0;
    idleHud.sent.length = 0;

    fakeNow = 1_000_000 + env.idleStopMs;
    capturedIdleTick();
    assert.equal(idleProxy.active, true);

    fakeNow = 1_000_000 + env.idleStopMs + 1;
    capturedIdleTick();

    assert.equal(idleProxy.active, false);
    assert.equal(idleLive.closed, 1);
    const expectedStopMsgs: ServerMsg[] = [
      { type: "coach", cue: "ok", text: "Camera stopped" },
      { type: "status", live: "closed", detail: "auto-stopped: no camera frames for 45 s" },
    ];
    assert.deepEqual(idlePhone.sent, expectedStopMsgs);
    assert.deepEqual(idleHud.sent, expectedStopMsgs);

    idleProxy.stop("idempotent second stop");
    assert.equal(idleLive.closed, 1);
  } finally {
    globalThis.setInterval = origSetInterval;
    Date.now = origNow;
  }
});

test("end-to-end /live and /hud-ws WebSocket session executes tool calls, barge-in, and multi-client disconnect FrameRing cleanup", async () => {
  generateImpl = async () => ({ text: validLabelJson() });

  const phone1 = openRealWs(`${wsBase}/live?session=ws-live-e2e`);
  const phone2 = openRealWs(`${wsBase}/live?session=ws-live-e2e`);
  const explicitHud = openRealWs(`${wsBase}/hud-ws?session=ws-live-e2e`);
  const floatingHud = openRealWs(`${wsBase}/hud-ws`);
  await Promise.all([phone1.ready, phone2.ready, explicitHud.ready, floatingHud.ready]);

  phone1.ws.send(
    JSON.stringify({
      type: "start",
      profile: buildProfile(),
      lang: "en",
      voice: true,
      source: "glasses",
    }),
  );

  await waitFor(
    () =>
      liveSessions.length === 1 &&
      phone1.received.some((m) => m.type === "ready") &&
      floatingHud.received.some((m) => m.type === "status" && m.live === "open"),
    "WebSocket live session open on phones and HUDs",
  );

  const live = liveSessions[0];
  const validFrame = "J".repeat(160);
  phone1.ws.send(
    JSON.stringify({
      type: "frame",
      data: validFrame,
      w: 720,
      h: 1280,
      sharpness: 0.91,
      ts: Date.now(),
    }),
  );
  phone1.ws.send(JSON.stringify({ type: "audio", data: "cGNtMTY=" }));

  await waitFor(
    () => getHub("ws-live-e2e")?.ring.length === 1 && live.realtimeInputs.length >= 2,
    "frame and audio delivered to LiveProxy",
  );

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "ws-cue", name: "show_cue", args: { cue: "closer", text: "Move closer" } }],
      },
    }),
  );

  await waitFor(
    () =>
      phone2.received.some((m) => m.type === "coach" && m.cue === "closer") &&
      explicitHud.received.some((m) => m.type === "coach" && m.cue === "closer") &&
      floatingHud.received.some((m) => m.type === "coach" && m.cue === "closer"),
    "show_cue fanned out to all phones and HUDs",
  );

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "ws-ver", name: "verify_label", args: { question: "Is this my evening pill?" } }],
      },
    }),
  );

  await waitFor(
    () =>
      live.toolResponses.length === 2 &&
      phone1.received.some((m) => m.type === "checking" && m.phase === "end") &&
      explicitHud.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml") &&
      floatingHud.received.some((m) => m.type === "verdict" && m.verdict.matchedMedId === "aml"),
    "verify_label verdict fanned out across /live and /hud-ws",
  );

  live.callbacks.onmessage(
    liveMsg({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "b3V0LWF1ZGlv" } }] },
        outputTranscription: { text: "Amlodipine 5 mg" },
      },
    }),
  );
  live.callbacks.onmessage(liveMsg({ serverContent: { interrupted: true } }));

  await waitFor(
    () =>
      phone1.received.some((m) => m.type === "interrupted") &&
      phone2.received.some((m) => m.type === "interrupted") &&
      explicitHud.received.some((m) => m.type === "status" && m.detail === "interrupted"),
    "barge-in interrupted propagated",
  );

  live.callbacks.onmessage(
    liveMsg({
      toolCall: {
        functionCalls: [{ id: "ws-dose", name: "log_dose", args: { medId: "aml" } }],
      },
    }),
  );
  await waitFor(() => live.toolResponses.length === 3, "log_dose tool response sent");
  assert.equal(getHub("ws-live-e2e")?.profile.doseLog.length, 1);

  for (const hudClient of [explicitHud, floatingHud]) {
    assert.equal(
      hudClient.received.some(
        (m) => m.type === "audio" || m.type === "transcript" || m.type === "checking" || m.type === "interrupted",
      ),
      false,
    );
  }

  await phone1.close();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(getHub("ws-live-e2e")?.live?.active, true);
  assert.equal(getHub("ws-live-e2e")?.ring.length, 1);
  assert.equal(live.closed, 0);

  await phone2.close();
  await waitFor(
    () =>
      getHub("ws-live-e2e")?.clients.size === 0 &&
      getHub("ws-live-e2e")?.ring.length === 0 &&
      explicitHud.received.some((m) => m.type === "status" && m.live === "closed" && m.detail === "client disconnected"),
    "final client disconnect stops LiveProxy and wipes FrameRing",
  );

  assert.equal(getHub("ws-live-e2e")?.live?.active, false);
  assert.equal(getHub("ws-live-e2e")?.ring.length, 0);
  assert.equal(live.closed, 1);

  const ledgerSummary = stats(tempLedger);
  const liveFeature = ledgerSummary.features.live as Record<string, unknown> | undefined;
  const verifyLiveFeature = ledgerSummary.features.verify_live as Record<string, unknown> | undefined;
  assert.ok(liveFeature);
  assert.ok(verifyLiveFeature);
  assert.ok(Number(liveFeature.tool_calls) >= 3);
  assert.equal(typeof liveFeature.tool_p50_s, "number");

  await Promise.all([explicitHud.close(), floatingHud.close()]);
});

test("live-coaching-toolcall.test.ts contains zero comments, em dashes, trailers, or API keys", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const emDash = String.fromCharCode(0x2014);
  const coAuthored = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const keyPattern = new RegExp(`AIza[0-9A-Za-z_-]{20,}`);

  assert.equal(src.includes(slash + slash), false);
  assert.equal(src.includes(slash + star), false);
  assert.equal(src.includes(emDash), false);
  assert.equal(coAuthored.test(src), false);
  assert.equal(keyPattern.test(src), false);
});
