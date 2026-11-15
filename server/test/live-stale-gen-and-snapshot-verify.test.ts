import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import type { DeviceState, LabelRead, Profile, ServerMsg, Verdict } from "../../shared/types.ts";

type TempEnvMod = typeof import("../src/env.ts");
type TempGeminiMod = typeof import("../src/gemini.ts");
type TempHubMod = typeof import("../src/hub.ts");
type TempLiveMod = typeof import("../src/live.ts");
type TempIndexMod = typeof import("../src/index.ts");

type ConnectCallbacks = {
  onmessage: (m: unknown) => void;
  onerror: (e: unknown) => void;
  onclose: (e: { code: number; reason?: string }) => void;
};

type ConnectArg = {
  model: string;
  config: {
    sessionResumption?: { handle?: string };
  };
  callbacks: ConnectCallbacks;
};

type GeneratePart = {
  inlineData?: { mimeType?: string; data?: string };
  text?: string;
};

type GenerateArg = {
  model: string;
  contents?: Array<{ role?: string; parts?: GeneratePart[] }>;
};

type HealthBody = {
  ok: boolean;
  gemini: "ok" | "down";
  models: { live: string[]; verify: string[]; tts: string[] };
  version: string;
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
};

type ErrorBody = {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
};

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const repoLedgerPath = path.join(SERVER_DIR, "logs", "ledger.jsonl");

const origQuiet = process.env.HOLDUP_QUIET;
const origGeminiKey = process.env.GEMINI_API_KEY;
const origElevenKey = process.env.ELEVENLABS_API_KEY;
const origLedgerPath = process.env.LEDGER_PATH;
const origHoldupKey = process.env.HOLDUP_KEY;
const origSpotter = process.env.SPOTTER;
const origFetch = globalThis.fetch;
const origSetTimeout = globalThis.setTimeout;
const origAppendFileSync = fs.appendFileSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);
const origMkdirSync = fs.mkdirSync.bind(fs);
const origCopyFileSync = fs.copyFileSync.bind(fs);
const origRenameSync = fs.renameSync.bind(fs);

const tmpBase = process.env.TMPDIR
  ? os.tmpdir()
  : fs.existsSync("/dev/shm")
    ? "/dev/shm"
    : os.tmpdir();
fs.mkdirSync(tmpBase, { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(tmpBase, "holdup-live-stale-snap-"));

const CASE_IDS = ["case-a", "case-b", "case-c", "case-d"] as const;
type CaseId = (typeof CASE_IDS)[number];

const symlinkPaths: string[] = [];
const externalFetchCalls: string[] = [];
const repoWriteTargets: string[] = [];
let loopbackFetchCalls = 0;
let unexpectedGeminiCalls = 0;
let cleanedUp = false;

const sampleProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["morning"],
    },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const alternateProfile: Profile = {
  meds: [
    {
      id: "met",
      name: "Glucophage",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["morning"],
    },
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

const sampleRead: LabelRead = {
  kind: "medication",
  product: { value: "Norvasc 5 mg", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.96 },
  strength: { value: "5 mg", confidence: 0.95 },
  dosing: { value: "1 tablet daily", confidence: 0.9 },
  expiry: { value: "2028-08", confidence: 0.95 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: null, confidence: 0 },
  readability: 0.91,
};

function findSharedNodeModules(): string | null {
  let cur = REPO_ROOT;
  for (;;) {
    const candidate = path.join(cur, "node_modules");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const fromEnv = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && fs.existsSync(entry));
  return fromEnv ? fs.realpathSync(fromEnv) : null;
}

function linkDir(targetPath: string, linkPath: string) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, "dir");
  symlinkPaths.push(linkPath);
}

function cleanupTmpRoot() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const linkPath of symlinkPaths) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

process.once("exit", cleanupTmpRoot);

function restoreEnvVar(name: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

function checkNoRepoWrite(target: fs.PathOrFileDescriptor) {
  if (typeof target === "number") return;
  const asPath =
    target instanceof URL
      ? fileURLToPath(target)
      : Buffer.isBuffer(target)
        ? target.toString("utf8")
        : String(target);
  const resolved = path.resolve(asPath);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    repoWriteTargets.push(resolved);
    throw new Error(`blocked repository write: ${resolved}`);
  }
}

function extractFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function httpUrl(port: number, route: string): string {
  return ["http:", "", `127.0.0.1:${port}${route}`].join("/");
}

function wsUrl(port: number, route: string): string {
  return ["ws:", "", `127.0.0.1:${port}${route}`].join("/");
}

function makeMockSession(arg: ConnectArg) {
  let closed = false;
  const session = {
    sendToolResponse: () => {},
    sendRealtimeInput: () => {},
    close: () => {
      closed = true;
    },
  };
  return {
    arg,
    session,
    get closed() {
      return closed;
    },
  };
}

function makeFrameString(prefix: string, exactLen: number): string {
  assert.ok(exactLen > prefix.length);
  const fillerChar = prefix.replace(/[^A-Za-z0-9]/g, "A").charAt(0) || "A";
  const out = prefix + fillerChar.repeat(exactLen - prefix.length);
  assert.equal(out.length, exactLen);
  return out;
}

function makeJpegBytes(byteLen: number, fillByte: number): Buffer {
  const buf = Buffer.alloc(byteLen, fillByte & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

async function flushMicrotasks(turns = 16) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function attachClientCapture(hub: { clients: Set<WebSocket> }) {
  const emitted: ServerMsg[] = [];
  const ws = {
    readyState: 1,
    send(raw: string) {
      emitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket;
  hub.clients.add(ws);
  return { emitted, ws };
}

function connectWs(url: string) {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  ws.on("message", (raw) => {
    msgs.push(JSON.parse(raw.toString()) as ServerMsg);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, msgs, opened };
}

function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState >= WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function closeServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections?.();
  return new Promise((resolve) => srv.close(() => resolve()));
}

async function loadIsolatedCase(
  caseId: CaseId,
  opts: { apiKey?: string; withLive?: boolean; withIndex?: boolean } = {},
) {
  const caseRoot = path.join(tmpRoot, caseId);
  const ledgerFile = path.join(caseRoot, "ledger.jsonl");
  const wantedApiKey = opts.apiKey ?? "";

  process.env.LEDGER_PATH = ledgerFile;
  process.env.GEMINI_API_KEY = wantedApiKey;
  process.env.ELEVENLABS_API_KEY = "";
  process.env.HOLDUP_QUIET = "1";
  process.env.SPOTTER = "0";
  delete process.env.HOLDUP_KEY;

  const envMod = (await import(pathToFileURL(path.join(caseRoot, "server", "src", "env.ts")).href)) as TempEnvMod;
  assert.equal(fs.realpathSync(envMod.REPO_ROOT), fs.realpathSync(caseRoot));
  assert.equal(envMod.env.apiKey, wantedApiKey);
  assert.equal(envMod.env.elevenlabs, false);
  assert.equal(envMod.env.ledgerPath, ledgerFile);

  const geminiMod = (await import(
    pathToFileURL(path.join(caseRoot, "server", "src", "gemini.ts")).href
  )) as TempGeminiMod;
  process.env.GEMINI_API_KEY = "";

  geminiMod.ai.models.get = (async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.models.get call");
  }) as typeof geminiMod.ai.models.get;
  geminiMod.ai.models.generateContent = (async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.models.generateContent call");
  }) as typeof geminiMod.ai.models.generateContent;
  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.live.connect call");
  };

  const hubMod = (await import(pathToFileURL(path.join(caseRoot, "server", "src", "hub.ts")).href)) as TempHubMod;
  const liveMod = opts.withLive
    ? ((await import(pathToFileURL(path.join(caseRoot, "server", "src", "live.ts")).href)) as TempLiveMod)
    : undefined;
  const indexMod = opts.withIndex
    ? ((await import(pathToFileURL(path.join(caseRoot, "server", "src", "index.ts")).href)) as TempIndexMod)
    : undefined;

  return { caseRoot, ledgerFile, envMod, geminiMod, hubMod, liveMod, indexMod };
}

before(() => {
  process.env.HOLDUP_QUIET = "1";
  process.env.GEMINI_API_KEY = "";
  process.env.ELEVENLABS_API_KEY = "";
  process.env.SPOTTER = "0";
  delete process.env.HOLDUP_KEY;

  const rootNodeModules = findSharedNodeModules();
  assert.ok(rootNodeModules, "shared node_modules must be resolvable");
  linkDir(rootNodeModules, path.join(tmpRoot, "node_modules"));

  const serverNodeModules = path.join(SERVER_DIR, "node_modules");
  const realServerNodeModules = fs.existsSync(serverNodeModules) ? fs.realpathSync(serverNodeModules) : null;

  for (const caseId of CASE_IDS) {
    const caseRoot = path.join(tmpRoot, caseId);
    fs.cpSync(path.join(REPO_ROOT, "server", "src"), path.join(caseRoot, "server", "src"), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, "shared"), path.join(caseRoot, "shared"), { recursive: true });
    if (realServerNodeModules) {
      linkDir(realServerNodeModules, path.join(caseRoot, "server", "node_modules"));
    }
  }

  fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
    checkNoRepoWrite(file);
    return origAppendFileSync(file, data, options);
  }) as typeof fs.appendFileSync;
  fs.writeFileSync = ((
    file: fs.PathOrFileDescriptor,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions,
  ) => {
    checkNoRepoWrite(file);
    return origWriteFileSync(file, data, options);
  }) as typeof fs.writeFileSync;
  fs.mkdirSync = ((dirPath: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode | null) => {
    checkNoRepoWrite(dirPath);
    return origMkdirSync(dirPath, options as fs.MakeDirectoryOptions | undefined);
  }) as typeof fs.mkdirSync;
  fs.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
    checkNoRepoWrite(dest);
    return origCopyFileSync(src, dest, mode);
  }) as typeof fs.copyFileSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    checkNoRepoWrite(oldPath);
    checkNoRepoWrite(newPath);
    return origRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawUrl = extractFetchUrl(input);
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "127.0.0.1") {
      externalFetchCalls.push(rawUrl);
      throw new Error(`blocked external fetch: ${rawUrl}`);
    }
    loopbackFetchCalls += 1;
    return origFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  try {
    globalThis.fetch = origFetch;
    fs.appendFileSync = origAppendFileSync;
    fs.writeFileSync = origWriteFileSync;
    fs.mkdirSync = origMkdirSync;
    fs.copyFileSync = origCopyFileSync;
    fs.renameSync = origRenameSync;
    restoreEnvVar("HOLDUP_QUIET", origQuiet);
    restoreEnvVar("GEMINI_API_KEY", origGeminiKey);
    restoreEnvVar("ELEVENLABS_API_KEY", origElevenKey);
    restoreEnvVar("LEDGER_PATH", origLedgerPath);
    restoreEnvVar("HOLDUP_KEY", origHoldupKey);
    restoreEnvVar("SPOTTER", origSpotter);
  } finally {
    cleanupTmpRoot();
  }
});

test("failed ai.live.connect firing onclose before rejection does not trigger onClose reconnect timer race", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  const mockedSetTimeout = globalThis.setTimeout;
  let scheduledTimeouts = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduledTimeouts += 1;
    return mockedSetTimeout(...args);
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = mockedSetTimeout;
    t.mock.timers.reset();
    assert.equal(globalThis.setTimeout, origSetTimeout);
  });

  const { ledgerFile, envMod, geminiMod, hubMod, liveMod } = await loadIsolatedCase("case-a", { withLive: true });
  t.after(() => {
    fs.rmSync(ledgerFile, { force: true });
  });

  const models = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
  envMod.env.liveModels = [...models];

  const attemptedModels: string[] = [];
  const createdSessions: Array<ReturnType<typeof makeMockSession>> = [];
  let failOnModel = models[0];

  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async (
    arg: ConnectArg,
  ) => {
    attemptedModels.push(arg.model);
    if (arg.model === failOnModel) {
      arg.callbacks.onclose({ code: 1006, reason: "handshake failed" });
      await Promise.resolve();
      throw new Error("handshake failed");
    }
    const built = makeMockSession(arg);
    createdSessions.push(built);
    return built.session;
  };

  const hub = new hubMod.Hub("stale-gen-race-01");
  hub.profile = structuredClone(sampleProfile);
  const { emitted } = attachClientCapture(hub);
  const proxy = new liveMod!.LiveProxy(hub, { lang: "en", voice: true });
  hub.live = proxy;
  t.after(() => {
    proxy.stop("cleanup");
    hub.dropFrames();
  });

  scheduledTimeouts = 0;
  await proxy.start();

  assert.deepEqual(attemptedModels, [models[0], models[1]]);
  assert.equal(scheduledTimeouts, 0);
  assert.equal(createdSessions.length, 1);
  assert.equal(proxy.currentModel, models[1]);
  assert.deepEqual(emitted, [
    { type: "status", live: "connecting" },
    { type: "ready", model: models[1], session: hub.id, features: [] },
    { type: "status", live: "open", detail: models[1] },
  ]);

  t.mock.timers.tick(2_000);
  proxy.frame("F".repeat(140));
  t.mock.timers.tick(3_000);
  await flushMicrotasks();
  assert.deepEqual(attemptedModels, [models[0], models[1]]);
  assert.equal(scheduledTimeouts, 0);

  failOnModel = models[1];
  createdSessions[0].arg.callbacks.onclose({ code: 1006, reason: "remote socket drop" });
  assert.equal(scheduledTimeouts, 1);

  t.mock.timers.tick(4_000);
  await flushMicrotasks();

  assert.deepEqual(attemptedModels, [models[0], models[1], models[1], models[2]]);
  assert.equal(scheduledTimeouts, 1);
  assert.equal(proxy.currentModel, models[2]);
  assert.deepEqual(emitted.slice(3), [
    { type: "status", live: "connecting" },
    { type: "ready", model: models[2], session: hub.id, features: [] },
    { type: "status", live: "open", detail: models[2] },
  ]);
});

test("hub.resume honors exact 10-minute TTL boundary and retries stale handle fresh on same modelIdx before advancing", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 5_000_000 });
  t.after(() => {
    t.mock.timers.reset();
  });

  const { ledgerFile, envMod, geminiMod, hubMod, liveMod } = await loadIsolatedCase("case-b", { withLive: true });
  t.after(() => {
    fs.rmSync(ledgerFile, { force: true });
  });

  const models = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
  envMod.env.liveModels = [...models];

  const calls9m: Array<{ model: string; sessionResumption: { handle?: string } | undefined }> = [];
  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async (
    arg: ConnectArg,
  ) => {
    calls9m.push({ model: arg.model, sessionResumption: structuredClone(arg.config.sessionResumption) });
    return makeMockSession(arg).session;
  };

  const hub9m = new hubMod.Hub("resume-ttl-9m");
  hub9m.resume = {
    handle: "resume-handle-9m",
    model: models[1],
    at: Date.now() - 9 * 60_000,
  };
  assert.equal(Date.now() - hub9m.resume.at, 9 * 60_000);
  const raw9m: ServerMsg[] = [];
  const origEmit9m = hub9m.emit.bind(hub9m);
  hub9m.emit = (msg: ServerMsg, opts?: { clients?: boolean; hud?: boolean }) => {
    raw9m.push(msg);
    origEmit9m(msg, opts);
  };
  const { emitted: ws9m } = attachClientCapture(hub9m);
  const proxy9m = new liveMod!.LiveProxy(hub9m, { lang: "en", voice: true });
  hub9m.live = proxy9m;
  await proxy9m.start();

  assert.deepEqual(calls9m, [{ model: models[1], sessionResumption: { handle: "resume-handle-9m" } }]);
  assert.deepEqual(raw9m[0], { type: "status", live: "reconnecting", detail: "resuming" });
  assert.deepEqual(ws9m, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "ready", model: models[1], session: hub9m.id, features: [] },
    { type: "status", live: "open", detail: models[1] },
  ]);
  proxy9m.stop("done 9m");

  const calls10m: Array<{ model: string; sessionResumption: { handle?: string } | undefined }> = [];
  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async (
    arg: ConnectArg,
  ) => {
    calls10m.push({ model: arg.model, sessionResumption: structuredClone(arg.config.sessionResumption) });
    return makeMockSession(arg).session;
  };

  const hub10m = new hubMod.Hub("resume-ttl-10m");
  hub10m.resume = {
    handle: "resume-handle-10m",
    model: models[1],
    at: Date.now() - 10 * 60_000,
  };
  assert.equal(Date.now() - hub10m.resume.at, 10 * 60_000);
  const raw10m: ServerMsg[] = [];
  const origEmit10m = hub10m.emit.bind(hub10m);
  hub10m.emit = (msg: ServerMsg, opts?: { clients?: boolean; hud?: boolean }) => {
    raw10m.push(msg);
    origEmit10m(msg, opts);
  };
  const { emitted: ws10m } = attachClientCapture(hub10m);
  const proxy10m = new liveMod!.LiveProxy(hub10m, { lang: "en", voice: true });
  hub10m.live = proxy10m;
  await proxy10m.start();

  assert.deepEqual(calls10m, [{ model: models[0], sessionResumption: {} }]);
  assert.equal(raw10m[0]?.type, "status");
  if (raw10m[0]?.type === "status") {
    assert.equal(raw10m[0].live, "connecting");
    assert.equal(raw10m[0].detail, undefined);
  }
  assert.deepEqual(ws10m, [
    { type: "status", live: "connecting" },
    { type: "ready", model: models[0], session: hub10m.id, features: [] },
    { type: "status", live: "open", detail: models[0] },
  ]);
  proxy10m.stop("done 10m");

  const staleSameModelCalls: Array<{ model: string; sessionResumption: { handle?: string } | undefined }> = [];
  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async (
    arg: ConnectArg,
  ) => {
    staleSameModelCalls.push({ model: arg.model, sessionResumption: structuredClone(arg.config.sessionResumption) });
    if (arg.config.sessionResumption?.handle) {
      throw new Error("stale resumption handle rejected");
    }
    return makeMockSession(arg).session;
  };

  const hubStaleSame = new hubMod.Hub("resume-stale-same");
  hubStaleSame.resume = {
    handle: "stale-handle-same-idx",
    model: models[1],
    at: Date.now() - 60_000,
  };
  const { emitted: wsStaleSame } = attachClientCapture(hubStaleSame);
  const proxyStaleSame = new liveMod!.LiveProxy(hubStaleSame, { lang: "en", voice: true });
  hubStaleSame.live = proxyStaleSame;
  await proxyStaleSame.start();

  assert.deepEqual(staleSameModelCalls, [
    { model: models[1], sessionResumption: { handle: "stale-handle-same-idx" } },
    { model: models[1], sessionResumption: {} },
  ]);
  assert.deepEqual(wsStaleSame, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "ready", model: models[1], session: hubStaleSame.id, features: [] },
    { type: "status", live: "open", detail: models[1] },
  ]);
  proxyStaleSame.stop("done stale same");

  const staleAdvanceCalls: Array<{ model: string; sessionResumption: { handle?: string } | undefined }> = [];
  (geminiMod.ai.live as unknown as { connect: (arg: ConnectArg) => Promise<unknown> }).connect = async (
    arg: ConnectArg,
  ) => {
    staleAdvanceCalls.push({ model: arg.model, sessionResumption: structuredClone(arg.config.sessionResumption) });
    if (arg.model === models[1]) {
      throw new Error(arg.config.sessionResumption?.handle ? "stale handle" : "model 1 unavailable");
    }
    return makeMockSession(arg).session;
  };

  const hubStaleAdvance = new hubMod.Hub("resume-stale-advance");
  hubStaleAdvance.resume = {
    handle: "stale-handle-then-next",
    model: models[1],
    at: Date.now() - 60_000,
  };
  const { emitted: wsStaleAdvance } = attachClientCapture(hubStaleAdvance);
  const proxyStaleAdvance = new liveMod!.LiveProxy(hubStaleAdvance, { lang: "en", voice: true });
  hubStaleAdvance.live = proxyStaleAdvance;
  await proxyStaleAdvance.start();

  assert.deepEqual(staleAdvanceCalls, [
    { model: models[1], sessionResumption: { handle: "stale-handle-then-next" } },
    { model: models[1], sessionResumption: {} },
    { model: models[2], sessionResumption: {} },
  ]);
  assert.deepEqual(wsStaleAdvance, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "ready", model: models[2], session: hubStaleAdvance.id, features: [] },
    { type: "status", live: "open", detail: models[2] },
  ]);
  proxyStaleAdvance.stop("done stale advance");
});

test("POST /api/verify selects 2 largest frames of last 3, isolates invalid session strings, and returns 409/400 on missing frames", async (t) => {
  const { ledgerFile, geminiMod, hubMod, indexMod } = await loadIsolatedCase("case-c", { withIndex: true });

  const capturedInlineFrames: string[][] = [];
  geminiMod.ai.models.generateContent = (async (params: GenerateArg) => {
    const parts = params.contents?.[0]?.parts ?? [];
    const frames = parts
      .filter((p) => typeof p.inlineData?.data === "string")
      .map((p) => p.inlineData!.data!);
    capturedInlineFrames.push(frames);
    return {
      text: JSON.stringify(sampleRead),
      usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 22 },
    };
  }) as unknown as typeof geminiMod.ai.models.generateContent;

  const server = await indexMod!.startServer(0);
  const openSockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of openSockets) await closeWs(ws);
    await closeServer(server);
    fs.rmSync(ledgerFile, { force: true });
  });

  const port = (server.address() as AddressInfo).port;
  const verifyEndpoint = httpUrl(port, "/api/verify");

  const f0 = makeFrameString("FRAME0_", 2200);
  const f1 = makeFrameString("FRAME1_", 300);
  const f2 = makeFrameString("FRAME2_", 500);
  const f3 = makeFrameString("FRAME3_", 900);
  const f4 = makeFrameString("FRAME4_", 700);

  const pickRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "pick-five-sess",
      frames: [f0, f1, f2, f3, f4],
      profile: sampleProfile,
    }),
  });
  assert.equal(pickRes.status, 200);
  const pickVerdict = (await pickRes.json()) as Verdict;
  assert.equal(pickVerdict.level, "match");
  assert.equal(pickVerdict.matchedMedId, "aml");
  assert.equal(capturedInlineFrames.length, 1);
  assert.deepEqual(capturedInlineFrames[0], [f3, f4]);

  const anchorHub = hubMod.getOrCreateHub("anchor-latest-01");
  anchorHub.profile = structuredClone(alternateProfile);
  anchorHub.live = undefined;
  hubMod.markLatest(anchorHub);

  const floatingHud = connectWs(wsUrl(port, "/hud-ws"));
  openSockets.push(floatingHud.ws);
  await floatingHud.opened;
  floatingHud.msgs.length = 0;

  const sessionsBeforeInvalid = hubMod.hubStats().sessions;
  capturedInlineFrames.length = 0;

  for (const invalidSession of ["../bad", "ab", "x".repeat(65)]) {
    const invalidWithProfileRes = await fetch(verifyEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: invalidSession,
        frames: [f4],
        profile: sampleProfile,
      }),
    });
    assert.equal(invalidWithProfileRes.status, 200);
    const verdict = (await invalidWithProfileRes.json()) as Verdict;
    assert.equal(verdict.level, "match");
    assert.equal(verdict.matchedMedId, "aml");
    assert.equal(hubMod.getHub(invalidSession), undefined);
    assert.equal(hubMod.getHub("snapshot"), undefined);
    assert.equal(hubMod.hubStats().sessions, sessionsBeforeInvalid);
    assert.equal(hubMod.latestHub(), anchorHub);
    assert.equal(hubMod.resolveHub(undefined), anchorHub);
  }

  anchorHub.profile = structuredClone(sampleProfile);
  const invalidNoProfileRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "../bad",
      frames: [f3],
    }),
  });
  assert.equal(invalidNoProfileRes.status, 200);
  const noProfileVerdict = (await invalidNoProfileRes.json()) as Verdict;
  assert.equal(noProfileVerdict.level, "warning");
  assert.equal(noProfileVerdict.matchedMedId, undefined);
  assert.equal(noProfileVerdict.reasons.includes("not on your medication list"), true);
  assert.equal(hubMod.latestHub(), anchorHub);
  assert.equal(capturedInlineFrames.length, 4);

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(floatingHud.msgs.some((m) => m.type === "verdict"), false);

  capturedInlineFrames.length = 0;
  const emptyRingHub = hubMod.getOrCreateHub("empty-ring-sess");
  assert.equal(emptyRingHub.ring.length, 0);

  const emptyFramesValidRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "empty-ring-sess",
      frames: [],
    }),
  });
  assert.equal(emptyFramesValidRes.status, 409);
  const emptyFramesValidErr = (await emptyFramesValidRes.json()) as ErrorBody;
  assert.equal(emptyFramesValidErr.type, "error");
  assert.equal(emptyFramesValidErr.code, "no_frames");

  const shortStringsValidRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "empty-ring-sess",
      frames: ["", "short", "S".repeat(100)],
    }),
  });
  assert.equal(shortStringsValidRes.status, 409);
  const shortStringsValidErr = (await shortStringsValidRes.json()) as ErrorBody;
  assert.equal(shortStringsValidErr.type, "error");
  assert.equal(shortStringsValidErr.code, "no_frames");

  const unknownSessionRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "unknown-session-99",
      frames: ["S".repeat(100)],
    }),
  });
  assert.equal(unknownSessionRes.status, 400);
  const unknownSessionErr = (await unknownSessionRes.json()) as ErrorBody;
  assert.equal(unknownSessionErr.type, "error");
  assert.equal(unknownSessionErr.code, "bad_input");
  assert.equal(hubMod.getHub("unknown-session-99"), undefined);

  const missingSessionRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [],
    }),
  });
  assert.equal(missingSessionRes.status, 400);
  const missingSessionErr = (await missingSessionRes.json()) as ErrorBody;
  assert.equal(missingSessionErr.type, "error");
  assert.equal(missingSessionErr.code, "bad_input");

  const invalidSessionEmptyRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "../bad",
      frames: ["S".repeat(100)],
    }),
  });
  assert.equal(invalidSessionEmptyRes.status, 400);
  const invalidSessionEmptyErr = (await invalidSessionEmptyRes.json()) as ErrorBody;
  assert.equal(invalidSessionEmptyErr.type, "error");
  assert.equal(invalidSessionEmptyErr.code, "bad_input");

  assert.equal(capturedInlineFrames.length, 0);
});

test("GET /api/health caches ai.models.get for 30_000 ms, re-probes at 30_001 ms across ok/down transitions, and rounds glasses.lastFrameAgoS", async (t) => {
  const t0 = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: t0 });

  const { ledgerFile, envMod, geminiMod, hubMod, indexMod } = await loadIsolatedCase("case-d", {
    apiKey: "unit-test-nonempty-health-key",
    withIndex: true,
  });

  const probeCalls: Array<{ model: string; at: number }> = [];
  let geminiHealthy = true;
  geminiMod.ai.models.get = (async (params: { model: string }) => {
    probeCalls.push({ model: params.model, at: Date.now() });
    if (!geminiHealthy) {
      throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
    }
    return { name: `models/${params.model}` };
  }) as unknown as typeof geminiMod.ai.models.get;

  const server = await indexMod!.startServer(0);
  t.after(async () => {
    await closeServer(server);
    t.mock.timers.reset();
    fs.rmSync(ledgerFile, { force: true });
  });

  const port = (server.address() as AddressInfo).port;
  const healthEndpoint = httpUrl(port, "/api/health");
  const ingestFrameEndpoint = httpUrl(port, "/ingest/frame");

  const getHealth = async (): Promise<HealthBody> => {
    const res = await fetch(healthEndpoint);
    assert.equal(res.status, 200);
    return (await res.json()) as HealthBody;
  };

  assert.equal(Date.now(), t0);
  const hAt0 = await getHealth();
  assert.equal(hAt0.ok, true);
  assert.equal(hAt0.gemini, "ok");
  assert.equal(probeCalls.length, 1);
  assert.deepEqual(probeCalls[0], { model: envMod.env.verifyModels[0], at: t0 });
  assert.equal(hAt0.glasses.framesAccepted, 0);
  assert.equal(hAt0.glasses.framesDropped, 0);
  assert.equal(hAt0.glasses.lastFrameAgoS, null);

  geminiHealthy = false;

  t.mock.timers.tick(15_000);
  assert.equal(Date.now(), t0 + 15_000);
  const hAt15s = await getHealth();
  assert.equal(hAt15s.gemini, "ok");
  assert.equal(probeCalls.length, 1);

  t.mock.timers.tick(15_000);
  assert.equal(Date.now(), t0 + 30_000);
  const hAt30s = await getHealth();
  assert.equal(hAt30s.gemini, "ok");
  assert.equal(probeCalls.length, 1);

  t.mock.timers.tick(1);
  assert.equal(Date.now(), t0 + 30_001);
  const hAt30sPlus1 = await getHealth();
  assert.equal(hAt30sPlus1.ok, true);
  assert.equal(hAt30sPlus1.gemini, "down");
  assert.equal(probeCalls.length, 2);
  assert.deepEqual(probeCalls[1], { model: envMod.env.verifyModels[0], at: t0 + 30_001 });

  geminiHealthy = true;

  t.mock.timers.tick(30_000);
  assert.equal(Date.now(), t0 + 60_001);
  const hDownCached = await getHealth();
  assert.equal(hDownCached.gemini, "down");
  assert.equal(probeCalls.length, 2);

  t.mock.timers.tick(1);
  assert.equal(Date.now(), t0 + 60_002);
  const hRecovered = await getHealth();
  assert.equal(hRecovered.gemini, "ok");
  assert.equal(probeCalls.length, 3);
  assert.deepEqual(probeCalls[2], { model: envMod.env.verifyModels[0], at: t0 + 60_002 });

  const droppedIngest = await fetch(ingestFrameEndpoint, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: makeJpegBytes(160, 0x41),
  });
  assert.equal(droppedIngest.status, 204);
  const hAfterDrop = await getHealth();
  assert.equal(hAfterDrop.glasses.framesAccepted, 0);
  assert.equal(hAfterDrop.glasses.framesDropped, 1);
  assert.equal(hAfterDrop.glasses.lastFrameAgoS, null);

  const glassesHub = hubMod.getOrCreateHub("glasses-health-sess");
  glassesHub.source = "glasses";
  hubMod.markLatest(glassesHub);

  const ingestAt = Date.now();
  const acceptedIngest = await fetch(ingestFrameEndpoint, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: makeJpegBytes(180, 0x52),
  });
  assert.equal(acceptedIngest.status, 204);

  const hAgo0 = await getHealth();
  assert.equal(hAgo0.glasses.source, "glasses");
  assert.equal(hAgo0.glasses.framesAccepted, 1);
  assert.equal(hAgo0.glasses.framesDropped, 1);
  assert.equal(hAgo0.glasses.lastFrameAgoS, 0);

  t.mock.timers.tick(49);
  assert.equal(Date.now() - ingestAt, 49);
  assert.equal((await getHealth()).glasses.lastFrameAgoS, 0);

  t.mock.timers.tick(1);
  assert.equal(Date.now() - ingestAt, 50);
  assert.equal((await getHealth()).glasses.lastFrameAgoS, 0.1);

  t.mock.timers.tick(1399);
  assert.equal(Date.now() - ingestAt, 1449);
  assert.equal((await getHealth()).glasses.lastFrameAgoS, 1.4);

  t.mock.timers.tick(1);
  assert.equal(Date.now() - ingestAt, 1450);
  assert.equal((await getHealth()).glasses.lastFrameAgoS, 1.5);

  t.mock.timers.tick(10_890);
  assert.equal(Date.now() - ingestAt, 12_340);
  assert.equal((await getHealth()).glasses.lastFrameAgoS, 12.3);
  assert.equal(probeCalls.length, 3);

  glassesHub.dropFrames();
});

test("zero external network calls, zero unexpected Gemini calls, and workspace ledger untouched", () => {
  assert.equal(unexpectedGeminiCalls, 0);
  assert.deepEqual(externalFetchCalls, []);
  assert.ok(loopbackFetchCalls >= 10);
  for (const caseId of CASE_IDS) {
    assert.equal(fs.existsSync(path.join(tmpRoot, caseId, "server", "logs", "ledger.jsonl")), false);
  }
  assert.equal(repoWriteTargets.includes(repoLedgerPath), false);
  assert.deepEqual(repoWriteTargets, []);
});
