import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { DeviceState, Profile, ServerMsg } from "../../shared/types.ts";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, type StageMetrics } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { SPEC } from "../src/speculate.ts";

type WireMsg = ServerMsg | StageMetrics;

const EM_DASH = "\u2014";
const SLASH = "/";
const STAR = "*";
const STAGE_TUNNEL_KEY = "holdup-stage-parity-key-2026";
const JPEG_CANARY_TEXT = "HOLDUP_GLASSES_STAGE_HUD_CANARY_BYTES_2026";
const JPEG_CANARY_BASE64 = Buffer.from(JPEG_CANARY_TEXT, "utf8").toString("base64");

const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;
const origLiveModels = [...env.liveModels];
const origVerifyModels = [...env.verifyModels];
const origModelsGet = ai.models.get;
const origGenerateContent = ai.models.generateContent;
const origLiveConnect = ai.live.connect;
const origSpecDebounce = SPEC.debounceMs;
const origSpecMinGap = SPEC.minGapMs;

const ledgerTmpDir = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-glasses-stage-parity-"));
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");
process.env.HOLDUP_QUIET = "1";

const DEMO_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
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

const AMLODIPINE_LABEL_READ = {
  kind: "medication",
  product: { value: "Norvasc", confidence: 0.97 },
  ingredient: { value: "amlodipine", confidence: 0.97 },
  strength: { value: "5 mg", confidence: 0.96 },
  dosing: { value: "1 tablet once daily", confidence: 0.91 },
  expiry: { value: "2027-08", confidence: 0.94 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: null, confidence: 0 },
  readability: 0.95,
};

function buildCanaryJpeg(): Buffer {
  const fixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  assert.equal(fixture[0], 0xff);
  assert.equal(fixture[1], 0xd8);
  assert.equal(fixture[fixture.length - 2], 0xff);
  assert.equal(fixture[fixture.length - 1], 0xd9);

  const commentBytes = Buffer.from(JPEG_CANARY_TEXT, "utf8");
  const segLen = commentBytes.length + 2;
  const comSegment = Buffer.alloc(4 + commentBytes.length);
  comSegment[0] = 0xff;
  comSegment[1] = 0xfe;
  comSegment.writeUInt16BE(segLen, 2);
  commentBytes.copy(comSegment, 4);

  return Buffer.concat([
    fixture.subarray(0, fixture.length - 2),
    comSegment,
    fixture.subarray(fixture.length - 2),
  ]);
}

const canaryJpeg = buildCanaryJpeg();
const canaryJpegBase64 = canaryJpeg.toString("base64");

type LiveConnectArg = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onmessage: (msg: Record<string, unknown>) => void;
    onerror: (err: unknown) => void;
    onclose: (ev: { code: number; reason?: string }) => void;
  };
};

type StubLiveSession = {
  arg: LiveConnectArg;
  realtimeInputs: Array<Record<string, unknown>>;
  toolResponses: Array<Record<string, unknown>>;
  closed: boolean;
};

interface RawFrameRecord {
  text: string;
  isBinary: boolean;
}

interface HealthBody {
  ok: boolean;
  sessions: number;
  latest: string | null;
  floatingHuds: number;
  floatingStages: number;
  glasses: {
    source: "phone" | "glasses" | null;
    device: DeviceState | null;
    framesAccepted: number;
    framesDropped: number;
    lastFrameAgoS: number | null;
  };
}

let server: http.Server;
let httpBase = "";
let wsBase = "";
let liveSessions: StubLiveSession[] = [];
const trackedSessionIds = new Set<string>();
const openClients: Array<{ close: () => Promise<void>; terminate: () => void }> = [];

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function connectWs(pathAndQuery: string, headers?: Record<string, string>) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`, headers ? { headers } : undefined);
  const queue: WireMsg[] = [];
  const allMessages: WireMsg[] = [];
  const rawFrames: RawFrameRecord[] = [];
  const waiters: Array<{ pred: (m: WireMsg) => boolean; resolve: (m: WireMsg) => void }> = [];
  let closeCode: number | undefined;
  let closeReason = "";

  ws.on("error", () => {});
  ws.on("message", (raw, isBinary) => {
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.from(raw).toString("utf8");
    rawFrames.push({ text, isBinary });
    const msg = JSON.parse(text) as WireMsg;
    allMessages.push(msg);
    const idx = waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const [matched] = waiters.splice(idx, 1);
      matched.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
      resolve({ code, reason: closeReason });
    });
  });

  const open = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS open timeout on ${pathAndQuery}`)), 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  function nextWhere<T extends WireMsg>(
    pred: (m: WireMsg) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  function nextWhere(pred: (m: WireMsg) => boolean, timeoutMs?: number): Promise<WireMsg>;
  function nextWhere(pred: (m: WireMsg) => boolean, timeoutMs = 3000): Promise<WireMsg> {
    const existingIdx = queue.findIndex(pred);
    if (existingIdx >= 0) {
      const [found] = queue.splice(existingIdx, 1);
      return Promise.resolve(found);
    }
    return new Promise<WireMsg>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WS timeout on ${pathAndQuery}; queued=${JSON.stringify(queue)}`)),
        timeoutMs,
      );
      waiters.push({
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  const sendJson = (payload: unknown) => {
    ws.send(JSON.stringify(payload));
  };

  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const client = {
    ws,
    queue,
    allMessages,
    rawFrames,
    open,
    closed,
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    nextWhere,
    sendJson,
    close,
    terminate: () => {
      try {
        ws.terminate();
      } catch {}
    },
  };
  openClients.push(client);
  return client;
}

async function fetchHealth(): Promise<{ rawText: string; body: HealthBody }> {
  const res = await fetch(`${httpBase}/api/health`);
  assert.equal(res.status, 200);
  const rawText = await res.text();
  return { rawText, body: JSON.parse(rawText) as HealthBody };
}

function assertZeroImageOrAudioLeak(label: string, frames: RawFrameRecord[]) {
  const base64Head = canaryJpegBase64.slice(0, 32);
  const base64Mid = canaryJpegBase64.slice(64, 128);
  for (const frame of frames) {
    assert.equal(frame.isBinary, false, `${label} must never receive binary WebSocket frames`);
    assert.equal(frame.text.includes(JPEG_CANARY_TEXT), false, `${label} leaked raw JPEG canary`);
    assert.equal(frame.text.includes(JPEG_CANARY_BASE64), false, `${label} leaked base64 JPEG canary`);
    assert.equal(frame.text.includes(base64Head), false, `${label} leaked JPEG base64 header slice`);
    assert.equal(frame.text.includes(base64Mid), false, `${label} leaked JPEG base64 body slice`);
    assert.equal(frame.text.includes("/9j/"), false, `${label} leaked JPEG SOI base64 prefix`);
    assert.equal(frame.text.includes("image/jpeg"), false, `${label} leaked image/jpeg mime payload`);
    assert.equal(frame.text.includes("inlineData"), false, `${label} leaked Gemini inlineData`);
    const parsed = JSON.parse(frame.text) as { type?: string };
    assert.notEqual(parsed.type, "frame", `${label} must never receive frame messages`);
    assert.notEqual(parsed.type, "audio", `${label} must never receive audio messages`);
  }
}

function scanSourceStructure(name: string, source: string): { commentCount: number } {
  const stack: string[] = [];
  let commentCount = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    const next2 = i + 2 < source.length ? source[i + 2] : "";

    if (ch === SLASH && next === SLASH) {
      commentCount += 1;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === SLASH && next === STAR) {
      commentCount += 1;
      i += 2;
      while (i + 1 < source.length && !(source[i] === STAR && source[i + 1] === SLASH)) i += 1;
      assert.ok(i + 1 < source.length, `Unclosed block comment in ${name}`);
      i += 2;
      continue;
    }
    if (ch === '"' && next === '"' && next2 === '"') {
      i += 3;
      while (
        i + 2 < source.length &&
        !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')
      ) {
        i += 1;
      }
      assert.ok(i + 2 < source.length, `Unclosed triple-quoted string in ${name}`);
      i += 3;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        i += source[i] === "\\" ? 2 : 1;
      }
      assert.ok(i < source.length, `Unclosed double-quoted string in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < source.length && source[i] !== "'") {
        i += source[i] === "\\" ? 2 : 1;
      }
      assert.ok(i < source.length, `Unclosed single-quoted literal in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== "`") {
        i += source[i] === "\\" ? 2 : 1;
      }
      assert.ok(i < source.length, `Unclosed template string in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === ")" || ch === "]") {
      assert.ok(stack.length > 0, `Unmatched closing '${ch}' in ${name}`);
      const openCh = stack.pop()!;
      const expected = openCh === "{" ? "}" : openCh === "(" ? ")" : "]";
      assert.equal(ch, expected, `Mismatched delimiter in ${name}`);
    }
    i += 1;
  }
  assert.equal(stack.length, 0, `Unclosed delimiters in ${name}`);
  return { commentCount };
}

before(async () => {
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === "string") throw new Error("expected TCP server address");
  httpBase = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
  wsBase = ["ws:", "", `127.0.0.1:${addr.port}`].join("/");
});

beforeEach(() => {
  liveSessions = [];
  delete process.env.HOLDUP_KEY;
  env.apiKey = "test-glasses-stage-hud-key";
  env.liveModels = ["gemini-3.8-live"];
  env.verifyModels = ["gemini-3.8-flash"];
  SPEC.debounceMs = 25;
  SPEC.minGapMs = 0;

  ai.models.get = (async ({ model }: { model: string }) => ({
    name: `models/${model}`,
  })) as unknown as typeof ai.models.get;

  ai.models.generateContent = (async () => ({
    text: JSON.stringify(AMLODIPINE_LABEL_READ),
    usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 22 },
  })) as unknown as typeof ai.models.generateContent;

  ai.live.connect = (async (arg: LiveConnectArg) => {
    const entry: StubLiveSession = {
      arg,
      realtimeInputs: [],
      toolResponses: [],
      closed: false,
    };
    liveSessions.push(entry);
    return {
      sendRealtimeInput(input: Record<string, unknown>) {
        entry.realtimeInputs.push(input);
      },
      sendToolResponse(resp: Record<string, unknown>) {
        entry.toolResponses.push(resp);
      },
      close() {
        entry.closed = true;
      },
    };
  }) as unknown as typeof ai.live.connect;
});

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop()!;
    await client.close();
  }
  for (const id of trackedSessionIds) {
    const hub = getHub(id);
    if (hub) {
      hub.live?.stop("test cleanup");
      hub.live = undefined;
      hub.dropFrames();
      hub.device = undefined;
      hub.source = "phone";
    }
  }
  restoreHoldupKey();
  env.apiKey = origApiKey;
  env.liveModels = [...origLiveModels];
  env.verifyModels = [...origVerifyModels];
  SPEC.debounceMs = origSpecDebounce;
  SPEC.minGapMs = origSpecMinGap;
  ai.models.get = origModelsGet;
  ai.models.generateContent = origGenerateContent;
  ai.live.connect = origLiveConnect;
});

after(async () => {
  try {
    for (const client of openClients.splice(0)) client.terminate();
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    restoreHoldupKey();
    env.apiKey = origApiKey;
    env.ledgerPath = origLedgerPath;
    env.liveModels = [...origLiveModels];
    env.verifyModels = [...origVerifyModels];
    SPEC.debounceMs = origSpecDebounce;
    SPEC.minGapMs = origSpecMinGap;
    ai.models.get = origModelsGet;
    ai.models.generateContent = origGenerateContent;
    ai.live.connect = origLiveConnect;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    fs.rmSync(ledgerTmpDir, { recursive: true, force: true });
  }
});

test("1. floatingStages (/hud-ws?role=stage alone) never sets hud:true on phone /live or StageMetrics, whereas connecting /hud-ws flips hud:true on both", async () => {
  const phone = connectWs("/live");
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  const ready = await phone.nextWhere(
    (m): m is Extract<WireMsg, { type: "ready" }> => m.type === "ready",
  );
  trackedSessionIds.add(ready.session);
  const initialHudState = await phone.nextWhere(
    (m): m is Extract<WireMsg, { type: "hud" }> => m.type === "hud",
  );
  assert.deepEqual(initialHudState, { type: "hud", connected: false });
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const stage = connectWs("/hud-ws?role=stage");
  await stage.open;

  const initialStageMetrics = await stage.nextWhere(
    (m): m is StageMetrics => m.type === "metrics",
  );
  assert.equal(initialStageMetrics.phone, true);
  assert.equal(initialStageMetrics.hud, false);
  assert.equal(initialStageMetrics.source, "glasses");

  const healthStageOnly = await fetchHealth();
  assert.equal(healthStageOnly.body.floatingStages, 1);
  assert.equal(healthStageOnly.body.floatingHuds, 0);

  phone.sendJson({ type: "ping", t: 101 });
  await phone.nextWhere((m) => m.type === "pong" && m.t === 101);
  await sleep(80);
  assert.equal(
    phone.allMessages.some((m) => m.type === "hud" && m.connected === true),
    false,
    "Projector stage alone must never report HUD connected on phone /live",
  );

  const hud = connectWs("/hud-ws");
  await hud.open;

  const hudFlippedTrueOnPhone = await phone.nextWhere(
    (m): m is Extract<WireMsg, { type: "hud" }> => m.type === "hud" && m.connected === true,
  );
  assert.deepEqual(hudFlippedTrueOnPhone, { type: "hud", connected: true });

  const stageMetricsWithHud = await stage.nextWhere(
    (m): m is StageMetrics => m.type === "metrics" && m.hud === true,
    2500,
  );
  assert.equal(stageMetricsWithHud.hud, true);
  assert.equal(stageMetricsWithHud.phone, true);
  assert.equal(stageMetricsWithHud.source, "glasses");

  const healthBoth = await fetchHealth();
  assert.equal(healthBoth.body.floatingStages, 1);
  assert.equal(healthBoth.body.floatingHuds, 1);
  assert.equal(
    hud.allMessages.some((m) => m.type === "metrics"),
    false,
    "Display /hud-ws must not receive StageMetrics",
  );

  await hud.close();
  const hudFlippedFalseOnPhone = await phone.nextWhere(
    (m): m is Extract<WireMsg, { type: "hud" }> => m.type === "hud" && m.connected === false,
  );
  assert.deepEqual(hudFlippedFalseOnPhone, { type: "hud", connected: false });

  const stageMetricsAfterHudClose = await stage.nextWhere(
    (m): m is StageMetrics => m.type === "metrics" && m.hud === false,
    2500,
  );
  assert.equal(stageMetricsAfterHudClose.hud, false);
  assert.equal(stageMetricsAfterHudClose.phone, true);
});

test("2. POST /ingest/state (worn:null vs worn:false) and POST /ingest/frame update StageMetrics and /api/health glasses block with zero image or audio leak to /hud-ws or /hud-ws?role=stage", async () => {
  const phone = connectWs("/live");
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });

  const ready = await phone.nextWhere(
    (m): m is Extract<WireMsg, { type: "ready" }> => m.type === "ready",
  );
  trackedSessionIds.add(ready.session);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === false);
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const stage = connectWs("/hud-ws?role=stage");
  const hud = connectWs("/hud-ws");
  await Promise.all([stage.open, hud.open]);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);
  await stage.nextWhere((m) => m.type === "metrics");
  await hud.nextWhere((m) => m.type === "device");
  await stage.nextWhere((m) => m.type === "device");

  const baselineHealth = await fetchHealth();

  const unknownStateRes = await fetch(`${httpBase}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: null, battery: null, streaming: true }),
  });
  assert.equal(unknownStateRes.status, 204);

  const expectedUnknown: DeviceState = {
    connected: true,
    worn: null,
    battery: null,
    streaming: true,
    source: "glasses",
  };

  const [phoneUnknown, hudUnknown, stageUnknown] = await Promise.all([
    phone.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === null),
    hud.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === null),
    stage.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === null),
  ]);
  assert.deepEqual(phoneUnknown.device, expectedUnknown);
  assert.deepEqual(hudUnknown.device, expectedUnknown);
  assert.deepEqual(stageUnknown.device, expectedUnknown);
  assert.strictEqual(stageUnknown.device.worn, null);
  assert.strictEqual(stageUnknown.device.battery, null);

  const healthUnknown = await fetchHealth();
  assert.equal(healthUnknown.body.glasses.source, "glasses");
  assert.deepEqual(healthUnknown.body.glasses.device, expectedUnknown);
  assert.strictEqual(healthUnknown.body.glasses.device?.worn, null);

  for (let i = 0; i < 2; i += 1) {
    const frameRes = await fetch(`${httpBase}/ingest/frame`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(canaryJpeg),
    });
    assert.equal(frameRes.status, 204);
  }

  const stageFrameMetrics = await stage.nextWhere(
    (m): m is StageMetrics => m.type === "metrics" && m.fps > 0 && m.frameKb !== null,
    2500,
  );
  assert.equal(stageFrameMetrics.source, "glasses");
  assert.ok(stageFrameMetrics.fps > 0);
  assert.notEqual(stageFrameMetrics.frameKb, null);
  assert.ok((stageFrameMetrics.frameKb ?? 0) > 0);
  assert.equal(stageFrameMetrics.hud, true);
  assert.equal(stageFrameMetrics.phone, true);

  const healthAfterFrames = await fetchHealth();
  assert.equal(healthAfterFrames.body.glasses.source, "glasses");
  assert.equal(
    healthAfterFrames.body.glasses.framesAccepted,
    baselineHealth.body.glasses.framesAccepted + 2,
  );
  assert.notEqual(healthAfterFrames.body.glasses.lastFrameAgoS, null);
  assert.ok((healthAfterFrames.body.glasses.lastFrameAgoS ?? -1) >= 0);
  assert.equal(healthAfterFrames.rawText.includes(JPEG_CANARY_TEXT), false);
  assert.equal(healthAfterFrames.rawText.includes(JPEG_CANARY_BASE64), false);
  assert.equal(healthAfterFrames.rawText.includes("/9j/"), false);

  const geminiCb = liveSessions[0].arg.callbacks;
  geminiCb.onmessage({
    toolCall: {
      functionCalls: [{ id: "cue-parity", name: "show_cue", args: { cue: "closer", text: "Move closer" } }],
    },
  });
  geminiCb.onmessage({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.alloc(320, 0x2a).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
  });
  geminiCb.onmessage({
    toolCall: {
      functionCalls: [{ id: "ver-parity", name: "verify_label", args: { question: "evening pill?" } }],
    },
  });

  await Promise.all([
    hud.nextWhere((m) => m.type === "coach"),
    stage.nextWhere((m) => m.type === "coach"),
    hud.nextWhere((m) => m.type === "verdict"),
    stage.nextWhere((m) => m.type === "verdict"),
    phone.nextWhere((m) => m.type === "audio"),
  ]);

  const doffedStateRes = await fetch(`${httpBase}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: false, battery: 76, streaming: false }),
  });
  assert.equal(doffedStateRes.status, 204);

  const expectedDoffed: DeviceState = {
    connected: true,
    worn: false,
    battery: 76,
    streaming: false,
    source: "glasses",
  };

  const [phoneDoffed, hudDoffed, stageDoffed] = await Promise.all([
    phone.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === false),
    hud.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === false),
    stage.nextWhere((m): m is Extract<WireMsg, { type: "device" }> => m.type === "device" && m.device.worn === false),
  ]);
  assert.deepEqual(phoneDoffed.device, expectedDoffed);
  assert.deepEqual(hudDoffed.device, expectedDoffed);
  assert.deepEqual(stageDoffed.device, expectedDoffed);
  assert.strictEqual(stageDoffed.device.worn, false);

  const healthDoffed = await fetchHealth();
  assert.deepEqual(healthDoffed.body.glasses.device, expectedDoffed);

  await sleep(60);
  assertZeroImageOrAudioLeak("/hud-ws", hud.rawFrames);
  assertZeroImageOrAudioLeak("/hud-ws?role=stage", stage.rawFrames);
});

test("3. HUD sending {\"type\":\"event\",\"name\":\"dismiss\"} on /hud-ws forwards {\"type\":\"hud_event\",\"name\":\"dismiss\"} to both phone /live and /hud-ws?role=stage (toStages)", async () => {
  const phone = connectWs("/live?session=parity-dismiss-sess");
  trackedSessionIds.add("parity-dismiss-sess");
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  await phone.nextWhere((m) => m.type === "ready" && m.session === "parity-dismiss-sess");
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const floatingStage = connectWs("/hud-ws?role=stage");
  const sessionStage = connectWs("/hud-ws?role=stage&session=parity-dismiss-sess");
  const hud = connectWs("/hud-ws");
  await Promise.all([floatingStage.open, sessionStage.open, hud.open]);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);

  floatingStage.sendJson({ type: "event", name: "dismiss" });
  sessionStage.sendJson({ type: "event", name: "dismiss" });
  hud.sendJson({ type: "event", name: "unsupported_action" });
  phone.sendJson({ type: "ping", t: 303 });
  await phone.nextWhere((m) => m.type === "pong" && m.t === 303);
  await sleep(60);
  assert.equal(phone.allMessages.some((m) => m.type === "hud_event"), false);
  assert.equal(floatingStage.allMessages.some((m) => m.type === "hud_event"), false);
  assert.equal(sessionStage.allMessages.some((m) => m.type === "hud_event"), false);

  hud.sendJson({ type: "event", name: "dismiss" });
  const [phoneDismiss, floatingStageDismiss, sessionStageDismiss] = await Promise.all([
    phone.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
    floatingStage.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
    sessionStage.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
  ]);
  assert.deepEqual(phoneDismiss, { type: "hud_event", name: "dismiss" });
  assert.deepEqual(floatingStageDismiss, { type: "hud_event", name: "dismiss" });
  assert.deepEqual(sessionStageDismiss, { type: "hud_event", name: "dismiss" });

  for (const name of ["repeat", "log_dose"] as const) {
    hud.sendJson({ type: "event", name });
    const [pEvt, fsEvt, ssEvt] = await Promise.all([
      phone.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
      floatingStage.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
      sessionStage.nextWhere((m): m is Extract<WireMsg, { type: "hud_event" }> => m.type === "hud_event"),
    ]);
    assert.deepEqual(pEvt, { type: "hud_event", name });
    assert.deepEqual(fsEvt, { type: "hud_event", name });
    assert.deepEqual(ssEvt, { type: "hud_event", name });
  }
});

test("4. HOLDUP_KEY auth closes /hud-ws?role=stage with code 4401 when key is missing or wrong and accepts ?key=", async () => {
  process.env.HOLDUP_KEY = STAGE_TUNNEL_KEY;

  const missingKeyStage = connectWs("/hud-ws?role=stage");
  const missingClosed = await missingKeyStage.closed;
  assert.equal(missingClosed.code, 4401);
  assert.equal(missingClosed.reason, "unauthorized");
  assert.equal(missingKeyStage.rawFrames.length, 0);

  const wrongKeyStage = connectWs("/hud-ws?role=stage&key=wrong-access-key");
  const wrongClosed = await wrongKeyStage.closed;
  assert.equal(wrongClosed.code, 4401);
  assert.equal(wrongClosed.reason, "unauthorized");
  assert.equal(wrongKeyStage.rawFrames.length, 0);

  const wrongSessionStage = connectWs("/hud-ws?role=stage&session=parity-auth-sess&key=bad");
  const wrongSessionClosed = await wrongSessionStage.closed;
  assert.equal(wrongSessionClosed.code, 4401);
  assert.equal(wrongSessionClosed.reason, "unauthorized");
  assert.equal(wrongSessionStage.rawFrames.length, 0);

  const phone = connectWs(`/live?session=parity-auth-sess&key=${STAGE_TUNNEL_KEY}`);
  trackedSessionIds.add("parity-auth-sess");
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  await phone.nextWhere((m) => m.type === "ready" && m.session === "parity-auth-sess");
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const validStage = connectWs(`/hud-ws?role=stage&key=${STAGE_TUNNEL_KEY}`);
  await validStage.open;
  const stageJoinMetrics = await validStage.nextWhere(
    (m): m is StageMetrics => m.type === "metrics",
  );
  assert.equal(validStage.closeCode, undefined);
  assert.equal(stageJoinMetrics.phone, true);
  assert.equal(stageJoinMetrics.hud, false);
  assert.equal(stageJoinMetrics.source, "glasses");
});

test("5. YuvJpeg.kt and YuvSemiPlanarSliceHeightTest.kt implement two-pass semi-planar padded-Y / unpadded-UV stride inference with zero code comments in new/edited blocks", () => {
  const yuvMainPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/main/java/app/holdup/bridge/YuvJpeg.kt",
  );
  const yuvTestPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/test/java/app/holdup/bridge/YuvSemiPlanarSliceHeightTest.kt",
  );
  const selfPath = path.join(REPO_ROOT, "server/test/glasses-stage-hud-parity.test.ts");

  const yuvMainSrc = fs.readFileSync(yuvMainPath, "utf8");
  const yuvTestSrc = fs.readFileSync(yuvTestPath, "utf8");
  const selfSrc = fs.readFileSync(selfPath, "utf8");

  assert.equal(yuvMainSrc.includes(EM_DASH), false);
  assert.equal(yuvTestSrc.includes(EM_DASH), false);
  assert.equal(selfSrc.includes(EM_DASH), false);

  scanSourceStructure("YuvJpeg.kt", yuvMainSrc);
  assert.equal(scanSourceStructure("YuvSemiPlanarSliceHeightTest.kt", yuvTestSrc).commentCount, 0);
  assert.equal(scanSourceStructure("glasses-stage-hud-parity.test.ts", selfSrc).commentCount, 0);

  const anchor = "internal fun inferStride(size: Int, w: Int, h: Int): Pair<Int, Int>?";
  const fnStart = yuvMainSrc.indexOf(anchor);
  assert.ok(fnStart >= 0);
  const firstBrace = yuvMainSrc.indexOf("{", fnStart);
  let depth = 0;
  let idx = firstBrace;
  let inferStrideBlock = "";
  while (idx < yuvMainSrc.length) {
    if (yuvMainSrc[idx] === "{") depth += 1;
    else if (yuvMainSrc[idx] === "}") {
      depth -= 1;
      if (depth === 0) {
        inferStrideBlock = yuvMainSrc.slice(fnStart, idx + 1);
        break;
      }
    }
    idx += 1;
  }
  assert.ok(inferStrideBlock.length > 0);
  assert.equal(scanSourceStructure("inferStride", inferStrideBlock).commentCount, 0);

  const pass1Idx = inferStrideBlock.indexOf("if (s * sh * 3 / 2 == size) return Pair(s, sh)");
  const pass2Idx = inferStrideBlock.indexOf(
    "if (sh > h && s * sh + s * (h / 2) == size) return Pair(s, sh)",
  );
  assert.ok(pass1Idx > 0, "Pass 1 full-padded 4:2:0 check must exist");
  assert.ok(pass2Idx > pass1Idx, "Pass 2 semi-planar padded-Y / unpadded-UV check must follow Pass 1");

  const align = (v: number, a: number) => Math.floor((v + a - 1) / a) * a;
  const distinct = (arr: number[]) => [...new Set(arr)];
  const inferStrideMirror = (size: number, w: number, h: number): [number, number] | null => {
    const strides = distinct([w, align(w, 16), align(w, 32), align(w, 64), align(w, 128), align(w, 256)]);
    const heights = distinct([h, align(h, 16), align(h, 32), align(h, 64)]);
    for (const s of strides) {
      for (const sh of heights) {
        if (Math.floor((s * sh * 3) / 2) === size) return [s, sh];
      }
    }
    for (const s of strides) {
      for (const sh of heights) {
        if (sh > h && s * sh + s * Math.floor(h / 2) === size) return [s, sh];
      }
    }
    const guardHeights = distinct([align(h + 1, 16), align(h + 1, 32), align(h + 1, 64)]);
    for (const s of strides) {
      for (const sh of guardHeights) {
        if (sh > h && s * sh + s * Math.floor(h / 2) === size) return [s, sh];
      }
    }
    return null;
  };

  assert.deepEqual(inferStrideMirror(1920 * 1088 + 1920 * 540, 1920, 1080), [1920, 1088]);
  assert.deepEqual(inferStrideMirror(768 * 1312 + 768 * 640, 720, 1280), [768, 1312]);
  assert.deepEqual(inferStrideMirror(800 * 1312 + 800 * 641, 770, 1282), [800, 1312]);
  assert.deepEqual(inferStrideMirror((1920 * 1088 * 3) / 2, 1920, 1080), [1920, 1088]);
  assert.deepEqual(inferStrideMirror((720 * 1280 * 3) / 2, 720, 1280), [720, 1280]);
  assert.equal(inferStrideMirror(1920 * 1088 + 1920 * 540 - 1, 1920, 1080), null);
  assert.equal(inferStrideMirror(768 * 1312 + 768 * 640 + 1, 720, 1280), null);
  assert.equal(inferStrideMirror(800 * 1312, 770, 1282), null);
});
