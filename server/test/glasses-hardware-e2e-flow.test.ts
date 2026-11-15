import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import WebSocket from "ws";
import type { DeviceState, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub } from "../src/hub.ts";
import { createApp, startServer } from "../src/index.ts";
import { SPEC } from "../src/speculate.ts";

const TUNNEL_KEY = "holdup-glasses-e2e-key-2026";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

const ledgerTmpDir = fs.mkdtempSync("/dev/shm/holdup-glasses-hw-e2e-");
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

const amlodipineJpeg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));

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

let server: http.Server;
let httpBase = "";
let wsBase = "";
let liveSessions: StubLiveSession[] = [];
const trackedSessionIds = new Set<string>();
const openClients: Array<{ close: () => Promise<void>; terminate: () => void }> = [];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

type DecodedPng = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
  chunkTypes: string[];
  rgba: Buffer;
};

function decodeAndVerifyPng(buf: Buffer): DecodedPng {
  assert.ok(buf.length > 8, "PNG buffer too short");
  assert.equal(Buffer.compare(buf.subarray(0, 8), PNG_SIGNATURE), 0, "invalid PNG signature");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filter = 0;
  let interlace = 0;
  const chunkTypes: string[] = [];
  const idatChunks: Buffer[] = [];

  while (offset < buf.length) {
    assert.ok(offset + 12 <= buf.length, "truncated PNG chunk header");
    const length = buf.readUInt32BE(offset);
    const typeBytes = buf.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `truncated PNG chunk ${type}`);
    const data = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `CRC32 mismatch in PNG chunk ${type}`);

    chunkTypes.push(type);
    if (type === "IHDR") {
      assert.equal(chunkTypes.length, 1, "IHDR must be first chunk");
      assert.equal(length, 13, "IHDR length must be 13");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filter = data[11];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      assert.equal(length, 0, "IEND length must be 0");
      assert.equal(dataEnd + 4, buf.length, "IEND must be final chunk");
    }

    offset = dataEnd + 4;
  }

  assert.equal(chunkTypes[0], "IHDR");
  assert.equal(chunkTypes.at(-1), "IEND");
  assert.ok(idatChunks.length >= 1, "missing IDAT chunks");
  assert.ok(width > 0 && height > 0, "invalid PNG dimensions");
  assert.equal(bitDepth, 8, "expected 8-bit PNG");
  assert.equal(colorType, 6, "expected RGBA colorType 6");
  assert.equal(compression, 0, "expected deflate compression 0");
  assert.equal(filter, 0, "expected standard filter method 0");
  assert.equal(interlace, 0, "expected non-interlaced PNG");

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  assert.equal(inflated.length, height * (1 + stride), "unexpected inflated IDAT byte length");

  const rgba = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (1 + stride)];
    const scanIn = inflated.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride));
    const scanOut = rgba.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? scanOut[i - bpp] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= bpp ? rgba[(y - 1) * stride + i - bpp] : 0;
      if (filterType === 0) scanOut[i] = scanIn[i];
      else if (filterType === 1) scanOut[i] = (scanIn[i] + left) & 0xff;
      else if (filterType === 2) scanOut[i] = (scanIn[i] + up) & 0xff;
      else if (filterType === 3) scanOut[i] = (scanIn[i] + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) scanOut[i] = (scanIn[i] + paethPredictor(left, up, upLeft)) & 0xff;
      else assert.fail(`unsupported PNG scanline filter type ${filterType}`);
    }
  }

  return { width, height, bitDepth, colorType, compression, filter, interlace, chunkTypes, rgba };
}

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function connectWsClient(pathAndQuery: string, headers?: Record<string, string>) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`, headers ? { headers } : undefined);
  const queue: ServerMsg[] = [];
  const waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];

  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMsg;
    const idx = waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const [matched] = waiters.splice(idx, 1);
      matched.resolve(msg);
    } else {
      queue.push(msg);
    }
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

  function nextWhere<T extends ServerMsg>(
    pred: (m: ServerMsg) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  function nextWhere(pred: (m: ServerMsg) => boolean, timeoutMs?: number): Promise<ServerMsg>;
  function nextWhere(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const existingIdx = queue.findIndex(pred);
    if (existingIdx >= 0) {
      const [found] = queue.splice(existingIdx, 1);
      return Promise.resolve(found);
    }
    return new Promise<ServerMsg>((resolve, reject) => {
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
    open,
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

async function expectWsUnauthorizedClose(pathAndQuery: string) {
  const ws = new WebSocket(`${wsBase}${pathAndQuery}`);
  ws.on("error", () => {});
  const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`expected 4401 close on ${pathAndQuery}`)), 3000);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
  assert.equal(closed.code, 4401);
  assert.equal(closed.reason, "unauthorized");
}

interface HealthBody {
  ok: boolean;
  gemini: string;
  sessions: number;
  latest: string | null;
  floatingHuds: number;
  glasses: {
    source: "phone" | "glasses" | null;
    device: DeviceState | null;
    framesAccepted: number;
    framesDropped: number;
    lastFrameAgoS: number | null;
  };
}

async function getHealth(): Promise<HealthBody> {
  const res = await fetch(`${httpBase}/api/health`);
  assert.equal(res.status, 200);
  return (await res.json()) as HealthBody;
}

function buildPublicAndApiApp() {
  const publicDir = path.join(REPO_ROOT, "web", "public");
  const hudHtmlPath = path.join(REPO_ROOT, "web", "hud", "index.html");
  const gateway = express();
  gateway.disable("x-powered-by");
  gateway.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  gateway.use(
    express.static(publicDir, {
      dotfiles: "allow",
      maxAge: "1h",
      setHeaders: (res, file) => {
        if (/\.(html|json)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  gateway.use((req, res, next) => {
    if ((req.method === "GET" || req.method === "HEAD") && (req.path === "/hud" || req.path === "/hud/")) {
      if (req.path === "/hud") {
        res.redirect(301, "/hud/");
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(hudHtmlPath, { dotfiles: "allow" });
      return;
    }
    next();
  });
  gateway.use(createApp());
  return gateway;
}

before(async () => {
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  server.removeAllListeners("request");
  server.on("request", buildPublicAndApiApp());

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP server address");
  httpBase = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
  wsBase = ["ws:", "", `127.0.0.1:${addr.port}`].join("/");
});

beforeEach(() => {
  liveSessions = [];
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  env.apiKey = "test-glasses-e2e-gemini-key";
  env.liveModels = ["gemini-3.8-live"];
  env.verifyModels = ["gemini-3.8-flash"];
  SPEC.debounceMs = 25;
  SPEC.minGapMs = 0;

  ai.models.get = (async ({ model }: { model: string }) => ({
    name: `models/${model}`,
  })) as unknown as typeof ai.models.get;

  ai.models.generateContent = (async () => ({
    text: JSON.stringify(AMLODIPINE_LABEL_READ),
    usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 24 },
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

test("1. Display Web App pairing preflight serves manifest, HUD head tags, monochrome mask icon-mono.png, and 96x96 icon-96.png over HTTP", async () => {
  const redirectRes = await fetch(`${httpBase}/hud`, { redirect: "manual" });
  assert.equal(redirectRes.status, 301);
  assert.equal(redirectRes.headers.get("location"), "/hud/");

  const hudPageRes = await fetch(`${httpBase}/hud/`);
  assert.equal(hudPageRes.status, 200);
  assert.equal(hudPageRes.headers.get("cache-control"), "no-cache");
  assert.equal(hudPageRes.headers.get("x-content-type-options"), "nosniff");
  assert.match(hudPageRes.headers.get("content-type") ?? "", /text\/html/i);
  const hudHtml = await hudPageRes.text();
  assert.match(hudHtml, /<meta\s+name="mrbd-web-app-capable"\s+content="yes"/i);
  assert.match(hudHtml, /<meta\s+name="application-name"\s+content="HoldUp"/i);
  assert.match(hudHtml, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"/i);
  assert.equal(/user-scalable\s*=\s*no/i.test(hudHtml), false);
  assert.match(hudHtml, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="96x96"\s+href="\/hud\/icon-96\.png"/i);

  const manifestUrl = `${httpBase}/hud/.well-known/meta-wearables-manifest.json`;
  const manifestRes = await fetch(manifestUrl);
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get("cache-control"), "no-cache");
  assert.equal(manifestRes.headers.get("x-content-type-options"), "nosniff");
  assert.match(manifestRes.headers.get("content-type") ?? "", /application\/json/i);

  const manifestBytes = Buffer.from(await manifestRes.arrayBuffer());
  assert.ok(manifestBytes.length > 0 && manifestBytes.length <= 64 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    version: number;
    name: string;
    description: string;
    appearance: { theme_color: string; icon: { src: string; type: string } };
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.name, "HoldUp");
  assert.ok(typeof manifest.description === "string" && manifest.description.length > 0);
  assert.equal(manifest.appearance.theme_color, "#2E7D32");
  assert.equal(manifest.appearance.icon.type, "monochrome");
  assert.equal(manifest.appearance.icon.src, "../icon-mono.png");

  const resolvedMonoUrl = new URL(manifest.appearance.icon.src, manifestUrl);
  assert.equal(resolvedMonoUrl.pathname, "/hud/icon-mono.png");

  const monoRes = await fetch(resolvedMonoUrl);
  assert.equal(monoRes.status, 200);
  assert.match(monoRes.headers.get("content-type") ?? "", /image\/png/i);
  const monoBytes = Buffer.from(await monoRes.arrayBuffer());
  assert.ok(monoBytes.length > 0 && monoBytes.length <= 2 * 1024 * 1024);

  const monoPng = decodeAndVerifyPng(monoBytes);
  assert.ok(monoPng.width >= 64 && monoPng.height >= 64);
  assert.equal(monoPng.width, monoPng.height);

  let borderMaxAlpha = 0;
  let interiorOpaquePixels = 0;
  const opaqueRgbSet = new Set<string>();
  for (let y = 0; y < monoPng.height; y++) {
    for (let x = 0; x < monoPng.width; x++) {
      const idx = (y * monoPng.width + x) * 4;
      const r = monoPng.rgba[idx];
      const g = monoPng.rgba[idx + 1];
      const b = monoPng.rgba[idx + 2];
      const a = monoPng.rgba[idx + 3];
      const isOuterBorder = x === 0 || y === 0 || x === monoPng.width - 1 || y === monoPng.height - 1;
      if (isOuterBorder) {
        if (a > borderMaxAlpha) borderMaxAlpha = a;
      } else if (a > 0) {
        interiorOpaquePixels++;
      }
      if (a > 0) opaqueRgbSet.add(`${r},${g},${b}`);
    }
  }
  assert.equal(borderMaxAlpha, 0);
  assert.ok(interiorOpaquePixels > 0);
  assert.equal(opaqueRgbSet.size, 1);

  const icon96Res = await fetch(`${httpBase}/hud/icon-96.png`);
  assert.equal(icon96Res.status, 200);
  assert.match(icon96Res.headers.get("content-type") ?? "", /image\/png/i);
  const icon96Bytes = Buffer.from(await icon96Res.arrayBuffer());
  assert.ok(icon96Bytes.length > 0 && icon96Bytes.length <= 2 * 1024 * 1024);

  const icon96Png = decodeAndVerifyPng(icon96Bytes);
  assert.equal(icon96Png.width, 96);
  assert.equal(icon96Png.height, 96);
  assert.ok(icon96Png.width > 52 && icon96Png.height > 52);
  let icon96OpaquePixels = 0;
  for (let i = 3; i < icon96Png.rgba.length; i += 4) {
    if (icon96Png.rgba[i] > 0) icon96OpaquePixels++;
  }
  assert.ok(icon96OpaquePixels > 0);
});

test("2. H2 + H3 DAT bridge state and JPEG frames over HOLDUP_KEY tunnel route to latest session and explicit ?session=", async () => {
  await expectWsUnauthorizedClose("/live");
  await expectWsUnauthorizedClose("/live?key=wrong-key");

  const unauthState = await fetch(`${httpBase}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 84, streaming: true }),
  });
  assert.equal(unauthState.status, 401);

  const unauthFrame = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(unauthFrame.status, 401);

  const explicitPhone = connectWsClient(`/live?session=h2-explicit-sess&key=${TUNNEL_KEY}`);
  trackedSessionIds.add("h2-explicit-sess");
  await explicitPhone.open;
  explicitPhone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  await explicitPhone.nextWhere((m) => m.type === "ready" && m.session === "h2-explicit-sess");
  await explicitPhone.nextWhere((m) => m.type === "status" && m.live === "open");

  const latestPhone = connectWsClient(`/live?key=${TUNNEL_KEY}`);
  await latestPhone.open;
  latestPhone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  const readyMsg = await latestPhone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready",
  );
  const latestSessionId = readyMsg.session;
  trackedSessionIds.add(latestSessionId);
  await latestPhone.nextWhere((m) => m.type === "status" && m.live === "open");

  const baselineHealth = await getHealth();

  const stateRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 84, streaming: true }),
  });
  assert.equal(stateRes.status, 204);

  const expectedDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
  };

  const phoneDeviceMsg = await latestPhone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(phoneDeviceMsg, { type: "device", device: expectedDevice });

  const sessionlessFrameRes = await fetch(`${httpBase}/ingest/frame?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(sessionlessFrameRes.status, 204);

  const latestHub = getHub(latestSessionId);
  const explicitHub = getHub("h2-explicit-sess");
  assert.ok(latestHub);
  assert.ok(explicitHub);
  assert.equal(latestHub.ring.length, 1);
  assert.equal(latestHub.ring.pick(1)[0].source, "glasses");
  assert.equal(latestHub.ring.pick(1)[0].data, amlodipineJpeg.toString("base64"));
  assert.equal(explicitHub.ring.length, 0);

  const latestGeminiSession = liveSessions[1];
  assert.ok(latestGeminiSession);
  assert.equal(latestGeminiSession.realtimeInputs.length, 1);
  assert.deepEqual(latestGeminiSession.realtimeInputs[0], {
    video: { data: amlodipineJpeg.toString("base64"), mimeType: "image/jpeg" },
  });

  const healthAfterSessionless = await getHealth();
  assert.equal(healthAfterSessionless.glasses.source, "glasses");
  assert.equal(healthAfterSessionless.glasses.framesAccepted, baselineHealth.glasses.framesAccepted + 1);
  assert.deepEqual(healthAfterSessionless.glasses.device, expectedDevice);
  assert.equal(typeof healthAfterSessionless.glasses.lastFrameAgoS, "number");
  assert.ok((healthAfterSessionless.glasses.lastFrameAgoS ?? -1) >= 0);

  const explicitStateRes = await fetch(
    `${httpBase}/ingest/state?key=${TUNNEL_KEY}&session=h2-explicit-sess`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: true, battery: 84, streaming: true }),
    },
  );
  assert.equal(explicitStateRes.status, 204);
  const explicitDeviceMsg = await explicitPhone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(explicitDeviceMsg, { type: "device", device: expectedDevice });

  const explicitFrameRes = await fetch(
    `${httpBase}/ingest/frame?key=${TUNNEL_KEY}&session=h2-explicit-sess`,
    {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(amlodipineJpeg),
    },
  );
  assert.equal(explicitFrameRes.status, 204);
  assert.equal(explicitHub.ring.length, 1);
  assert.equal(latestHub.ring.length, 1);

  const latestExplicitFrameRes = await fetch(
    `${httpBase}/ingest/frame?session=${latestSessionId}`,
    {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-holdup-key": TUNNEL_KEY },
      body: new Uint8Array(amlodipineJpeg),
    },
  );
  assert.equal(latestExplicitFrameRes.status, 204);
  assert.equal(latestHub.ring.length, 2);

  const healthAfterExplicit = await getHealth();
  assert.equal(healthAfterExplicit.glasses.source, "glasses");
  assert.equal(healthAfterExplicit.glasses.framesAccepted, baselineHealth.glasses.framesAccepted + 3);
  assert.deepEqual(healthAfterExplicit.glasses.device, expectedDevice);
});

test("3. H7 Ray-Ban Display /hud-ws attaches to latest hub, receives coach + verdict, replays to late joiners, forwards Neural Band events, and reports disconnect", async () => {
  await expectWsUnauthorizedClose("/hud-ws");
  await expectWsUnauthorizedClose("/hud-ws?key=wrong-key");

  const phone = connectWsClient(`/live?key=${TUNNEL_KEY}`);
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  const ready = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready",
  );
  trackedSessionIds.add(ready.session);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === false);
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const expectedDevice: DeviceState = {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
  };
  const stateRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 84, streaming: true }),
  });
  assert.equal(stateRes.status, 204);
  await phone.nextWhere((m) => m.type === "device");

  const frameRes = await fetch(`${httpBase}/ingest/frame?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(frameRes.status, 204);

  const hud1 = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hud1.open;

  const hudConnectedMsg = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "hud" }> => m.type === "hud",
  );
  assert.deepEqual(hudConnectedMsg, { type: "hud", connected: true });

  const hud1InitialDevice = await hud1.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(hud1InitialDevice, { type: "device", device: expectedDevice });

  const geminiCb = liveSessions[0].arg.callbacks;
  geminiCb.onmessage({
    toolCall: {
      functionCalls: [{ id: "cue-h7", name: "show_cue", args: { cue: "closer", text: "Move closer" } }],
    },
  });

  const hud1Coach = await hud1.nextWhere(
    (m): m is Extract<ServerMsg, { type: "coach" }> => m.type === "coach",
  );
  assert.deepEqual(hud1Coach, { type: "coach", cue: "closer", text: "Move closer" });

  geminiCb.onmessage({
    toolCall: {
      functionCalls: [
        { id: "ver-h7", name: "verify_label", args: { question: "is this my evening pill?" } },
      ],
    },
  });

  const hud1VerdictMsg = await hud1.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  const broadcastVerdict: Verdict = hud1VerdictMsg.verdict;
  assert.equal(broadcastVerdict.level, "match");
  assert.equal(broadcastVerdict.matchedMedId, "aml");
  assert.equal(broadcastVerdict.takenToday, false);

  await phone.nextWhere((m) => m.type === "verdict");

  const hud2Late = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hud2Late.open;

  const phoneHudStillTrueOnJoin = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "hud" }> => m.type === "hud",
  );
  assert.deepEqual(phoneHudStillTrueOnJoin, { type: "hud", connected: true });

  const lateReplayedDevice = await hud2Late.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  const lateReplayedVerdict = await hud2Late.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  assert.deepEqual(lateReplayedDevice, { type: "device", device: expectedDevice });
  assert.deepEqual(lateReplayedVerdict, { type: "verdict", verdict: broadcastVerdict });
  assert.equal(hud2Late.queue.some((m) => m.type === "coach"), false);

  await hud2Late.close();
  const phoneHudStillTrueAfterHud2Close = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "hud" }> => m.type === "hud",
  );
  assert.deepEqual(phoneHudStillTrueAfterHud2Close, { type: "hud", connected: true });

  hud1.sendJson({ type: "event", name: "unsupported_gesture" });
  for (const name of ["log_dose", "repeat", "dismiss"] as const) {
    hud1.sendJson({ type: "event", name });
    const forwarded = await phone.nextWhere(
      (m): m is Extract<ServerMsg, { type: "hud_event" }> => m.type === "hud_event",
    );
    assert.deepEqual(forwarded, { type: "hud_event", name });
  }

  await hud1.close();
  const hudDisconnectedMsg = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "hud" }> => m.type === "hud",
  );
  assert.deepEqual(hudDisconnectedMsg, { type: "hud", connected: false });
});

test("4. H8 nullable wear state vs doffed fallback preserves worn:null/battery:null and switches camera source to phone", async () => {
  const phone = connectWsClient(`/live?key=${TUNNEL_KEY}`);
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  const ready = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready",
  );
  trackedSessionIds.add(ready.session);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === false);
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const hud = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hud.open;
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);
  await hud.nextWhere((m) => m.type === "device");

  const unknownStateRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
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

  const phoneUnknown = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  const hudUnknown = await hud.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(phoneUnknown, { type: "device", device: expectedUnknown });
  assert.deepEqual(hudUnknown, { type: "device", device: expectedUnknown });
  assert.strictEqual(phoneUnknown.device.worn, null);
  assert.strictEqual(phoneUnknown.device.battery, null);
  assert.strictEqual(hudUnknown.device.worn, null);
  assert.strictEqual(hudUnknown.device.battery, null);

  const healthUnknown = await getHealth();
  assert.equal(healthUnknown.glasses.source, "glasses");
  assert.deepEqual(healthUnknown.glasses.device, expectedUnknown);
  assert.strictEqual(healthUnknown.glasses.device?.worn, null);
  assert.strictEqual(healthUnknown.glasses.device?.battery, null);

  const doffedStateRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: false, battery: 80, streaming: false }),
  });
  assert.equal(doffedStateRes.status, 204);

  const expectedDoffed: DeviceState = {
    connected: true,
    worn: false,
    battery: 80,
    streaming: false,
    source: "glasses",
  };

  const phoneDoffed = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  const hudDoffed = await hud.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(phoneDoffed, { type: "device", device: expectedDoffed });
  assert.deepEqual(hudDoffed, { type: "device", device: expectedDoffed });

  const beforeSwitchHealth = await getHealth();
  assert.equal(beforeSwitchHealth.glasses.source, "glasses");

  phone.sendJson({ type: "source", source: "phone" });

  const hudFlippedToPhone = await hud.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.deepEqual(hudFlippedToPhone, {
    type: "device",
    device: { connected: true, worn: false, battery: 80, streaming: false, source: "phone" },
  });

  const afterSwitchHealth = await getHealth();
  assert.equal(afterSwitchHealth.glasses.source, "phone");
  assert.equal(afterSwitchHealth.glasses.device?.source, "phone");

  const droppedFrameRes = await fetch(`${httpBase}/ingest/frame?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(droppedFrameRes.status, 204);

  const afterDropHealth = await getHealth();
  assert.equal(afterDropHealth.glasses.source, "phone");
  assert.equal(afterDropHealth.glasses.framesAccepted, afterSwitchHealth.glasses.framesAccepted);
  assert.equal(afterDropHealth.glasses.framesDropped, afterSwitchHealth.glasses.framesDropped + 1);
  assert.equal(getHub(ready.session)?.ring.length, 0);
});

test("5. Full unbroken multi-actor hardware rehearsal loop (Pairing Preflight -> DAT Bridge -> Live WS -> HUD Replay & Neural Band -> Doff Fallback -> Zero-Retention Close)", async () => {
  const manifestRes = await fetch(`${httpBase}/hud/.well-known/meta-wearables-manifest.json`);
  assert.equal(manifestRes.status, 200);
  const manifest = (await manifestRes.json()) as {
    version: number;
    name: string;
    appearance: { icon: { src: string } };
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.name, "HoldUp");
  const monoIconRes = await fetch(
    new URL(manifest.appearance.icon.src, `${httpBase}/hud/.well-known/meta-wearables-manifest.json`),
  );
  assert.equal(monoIconRes.status, 200);
  const monoPng = decodeAndVerifyPng(Buffer.from(await monoIconRes.arrayBuffer()));
  assert.ok(monoPng.width >= 64);

  const phone = connectWsClient(`/live?key=${TUNNEL_KEY}`);
  await phone.open;
  phone.sendJson({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "glasses",
  });
  const ready = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready",
  );
  const sessionId = ready.session;
  trackedSessionIds.add(sessionId);
  await phone.nextWhere((m) => m.type === "hud" && m.connected === false);
  await phone.nextWhere((m) => m.type === "status" && m.live === "open");

  const health0 = await getHealth();

  const bootUnknownRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: null, battery: null, streaming: true }),
  });
  assert.equal(bootUnknownRes.status, 204);
  const bootDevice = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  assert.strictEqual(bootDevice.device.worn, null);
  assert.strictEqual(bootDevice.device.battery, null);

  const donnedRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 84, streaming: true }),
  });
  assert.equal(donnedRes.status, 204);
  const donnedDeviceMsg = await phone.nextWhere(
    (m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device",
  );
  const expectedDonned: DeviceState = {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
  };
  assert.deepEqual(donnedDeviceMsg, { type: "device", device: expectedDonned });

  const f1 = await fetch(`${httpBase}/ingest/frame?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(f1.status, 204);
  const f2 = await fetch(`${httpBase}/ingest/frame?key=${TUNNEL_KEY}&session=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(amlodipineJpeg),
  });
  assert.equal(f2.status, 204);

  const healthStreaming = await getHealth();
  assert.equal(healthStreaming.glasses.source, "glasses");
  assert.equal(healthStreaming.glasses.framesAccepted, health0.glasses.framesAccepted + 2);
  assert.deepEqual(healthStreaming.glasses.device, expectedDonned);

  const hudPrimary = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hudPrimary.open;
  assert.deepEqual(await phone.nextWhere((m) => m.type === "hud"), { type: "hud", connected: true });
  assert.deepEqual(await hudPrimary.nextWhere((m) => m.type === "device"), {
    type: "device",
    device: expectedDonned,
  });

  const geminiCb = liveSessions[0].arg.callbacks;
  geminiCb.onmessage({
    toolCall: {
      functionCalls: [{ id: "cue-e2e", name: "show_cue", args: { cue: "rotate_left", text: "Turn it left" } }],
    },
  });
  assert.deepEqual(await hudPrimary.nextWhere((m) => m.type === "coach"), {
    type: "coach",
    cue: "rotate_left",
    text: "Turn it left",
  });

  geminiCb.onmessage({
    toolCall: {
      functionCalls: [{ id: "ver-e2e", name: "verify_label", args: { question: "evening pill?" } }],
    },
  });
  const hudVerdict = await hudPrimary.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  assert.equal(hudVerdict.verdict.level, "match");
  assert.equal(hudVerdict.verdict.matchedMedId, "aml");
  assert.equal(hudVerdict.verdict.takenToday, false);
  await phone.nextWhere((m) => m.type === "verdict");

  const hudLate = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hudLate.open;
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);
  assert.deepEqual(await hudLate.nextWhere((m) => m.type === "device"), {
    type: "device",
    device: expectedDonned,
  });
  const replayedVerdict = await hudLate.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  assert.equal(replayedVerdict.verdict.matchedMedId, "aml");
  await hudLate.close();
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);

  hudPrimary.sendJson({ type: "event", name: "log_dose" });
  assert.deepEqual(await phone.nextWhere((m) => m.type === "hud_event"), {
    type: "hud_event",
    name: "log_dose",
  });
  phone.sendJson({ type: "event", name: "log_dose" });
  const updatedTakenVerdict = await hudPrimary.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> =>
      m.type === "verdict" && m.verdict.takenToday === true,
  );
  assert.equal(updatedTakenVerdict.verdict.takenToday, true);

  hudPrimary.sendJson({ type: "event", name: "repeat" });
  assert.deepEqual(await phone.nextWhere((m) => m.type === "hud_event"), {
    type: "hud_event",
    name: "repeat",
  });
  hudPrimary.sendJson({ type: "event", name: "dismiss" });
  assert.deepEqual(await phone.nextWhere((m) => m.type === "hud_event"), {
    type: "hud_event",
    name: "dismiss",
  });

  await hudPrimary.close();
  assert.deepEqual(await phone.nextWhere((m) => m.type === "hud"), { type: "hud", connected: false });

  const hudRejoined = connectWsClient(`/hud-ws?key=${TUNNEL_KEY}`);
  await hudRejoined.open;
  await phone.nextWhere((m) => m.type === "hud" && m.connected === true);
  await hudRejoined.nextWhere((m) => m.type === "device");
  const replayedTaken = await hudRejoined.nextWhere(
    (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
  );
  assert.equal(replayedTaken.verdict.takenToday, true);

  const doffRes = await fetch(`${httpBase}/ingest/state?key=${TUNNEL_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: false, battery: 80, streaming: false }),
  });
  assert.equal(doffRes.status, 204);
  const expectedDoffed: DeviceState = {
    connected: true,
    worn: false,
    battery: 80,
    streaming: false,
    source: "glasses",
  };
  assert.deepEqual(await phone.nextWhere((m) => m.type === "device"), {
    type: "device",
    device: expectedDoffed,
  });
  assert.deepEqual(await hudRejoined.nextWhere((m) => m.type === "device"), {
    type: "device",
    device: expectedDoffed,
  });

  phone.sendJson({ type: "source", source: "phone" });
  assert.deepEqual(await hudRejoined.nextWhere((m) => m.type === "device"), {
    type: "device",
    device: { ...expectedDoffed, source: "phone" },
  });

  const healthFallback = await getHealth();
  assert.equal(healthFallback.glasses.source, "phone");

  await hudRejoined.close();
  await phone.close();
  assert.equal(getHub(sessionId)?.ring.length, 0);
});
