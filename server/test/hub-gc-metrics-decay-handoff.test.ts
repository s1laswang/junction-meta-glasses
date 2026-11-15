import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import type { LabelRead, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import type { StageMetrics } from "../src/hub.ts";

type TempEnvMod = typeof import("../src/env.ts");
type TempGeminiMod = typeof import("../src/gemini.ts");
type TempHubMod = typeof import("../src/hub.ts");
type TempIndexMod = typeof import("../src/index.ts");

type AnyStageMsg = ServerMsg | StageMetrics;

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
const origAppendFileSync = fs.appendFileSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);
const origMkdirSync = fs.mkdirSync.bind(fs);
const origCopyFileSync = fs.copyFileSync.bind(fs);
const origRenameSync = fs.renameSync.bind(fs);

const tmpRoot = fs.mkdtempSync(
  path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-hub-gc-decay-"),
);

const CASE_IDS = ["case-a", "case-b", "case-c"] as const;
type CaseId = (typeof CASE_IDS)[number];

const symlinkPaths: string[] = [];
const externalFetchCalls: string[] = [];
const repoWriteTargets: string[] = [];
let loopbackFetchCalls = 0;
let unexpectedGeminiCalls = 0;
let cleanedUp = false;

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: AnyStageMsg[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw) as AnyStageMsg);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }
}

const sampleProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5mg",
      schedule: ["evening"],
      gtin: "06410001234567",
    },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const sampleRead: LabelRead = {
  kind: "medication",
  product: { value: "Amlodipin Orion", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.96 },
  strength: { value: "5 mg", confidence: 0.95 },
  dosing: { value: null, confidence: 0 },
  expiry: { value: "2028-08", confidence: 0.95 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: null, confidence: 0 },
  readability: 0.85,
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

async function loadIsolatedCase(caseId: CaseId, opts: { withIndex?: boolean } = {}) {
  const caseRoot = path.join(tmpRoot, caseId);
  const ledgerFile = path.join(caseRoot, "ledger.jsonl");
  process.env.LEDGER_PATH = ledgerFile;
  process.env.GEMINI_API_KEY = "";
  process.env.ELEVENLABS_API_KEY = "";
  process.env.HOLDUP_QUIET = "1";
  process.env.SPOTTER = "0";
  delete process.env.HOLDUP_KEY;

  const envMod = (await import(pathToFileURL(path.join(caseRoot, "server", "src", "env.ts")).href)) as TempEnvMod;
  assert.equal(fs.realpathSync(envMod.REPO_ROOT), fs.realpathSync(caseRoot));
  assert.equal(envMod.env.apiKey, "");
  assert.equal(envMod.env.elevenlabs, false);
  assert.equal(envMod.env.ledgerPath, ledgerFile);

  const geminiMod = (await import(
    pathToFileURL(path.join(caseRoot, "server", "src", "gemini.ts")).href
  )) as TempGeminiMod;
  geminiMod.ai.models.get = (async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.models.get call");
  }) as typeof geminiMod.ai.models.get;
  geminiMod.ai.models.generateContent = (async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.models.generateContent call");
  }) as typeof geminiMod.ai.models.generateContent;

  const hubMod = (await import(pathToFileURL(path.join(caseRoot, "server", "src", "hub.ts")).href)) as TempHubMod;
  const indexMod = opts.withIndex
    ? ((await import(pathToFileURL(path.join(caseRoot, "server", "src", "index.ts")).href)) as TempIndexMod)
    : undefined;

  return { caseRoot, ledgerFile, envMod, geminiMod, hubMod, indexMod };
}

function connectWs(url: string) {
  const ws = new WebSocket(url);
  const msgs: AnyStageMsg[] = [];
  ws.on("message", (raw) => {
    msgs.push(JSON.parse(raw.toString()) as AnyStageMsg);
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

const waitRealMs = (ms = 35) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForMsg(
  msgs: AnyStageMsg[],
  pred: (m: AnyStageMsg) => boolean,
  timeoutMs = 1500,
): Promise<AnyStageMsg> {
  const started = process.hrtime.bigint();
  for (;;) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (elapsedMs > timeoutMs) {
      throw new Error(`timed out waiting for ws message; saw=${JSON.stringify(msgs)}`);
    }
    await waitRealMs(10);
  }
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

test("10-minute idle hub GC evicts expired idle hubs, runs dropFrames, clears latestId, and preserves active/client/recent hubs", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  t.after(() => {
    t.mock.timers.reset();
  });

  const { hubMod } = await loadIsolatedCase("case-a");

  const expiredLatest = hubMod.getOrCreateHub("expired-latest-01");
  expiredLatest.live = { active: false, handleEvent() {}, stop() {} };
  expiredLatest.features = new Set(["datamatrix"]);
  expiredLatest.setCode({ raw: "010641000123456717280800", gtin: "06410001234567", expiry: "2028-08" });
  expiredLatest.lastFields = {
    fields: [{ label: "strength", box: [100, 100, 220, 320], score: 0.91 }],
    ts: Date.now(),
  };
  expiredLatest.addFrame({
    data: "EXP_LATEST_" + "A".repeat(160),
    sharpness: 0.08,
    ts: Date.now(),
    bytes: 180,
    source: "phone",
  });
  let expiredLatestDropCalls = 0;
  const origDropLatest = expiredLatest.dropFrames.bind(expiredLatest);
  expiredLatest.dropFrames = () => {
    expiredLatestDropCalls += 1;
    origDropLatest();
  };
  hubMod.markLatest(expiredLatest);

  const expiredSecondary = hubMod.getOrCreateHub("expired-second-02");
  expiredSecondary.addFrame({
    data: "EXP_SECOND_" + "B".repeat(160),
    sharpness: 0.08,
    ts: Date.now(),
    bytes: 180,
    source: "phone",
  });
  let expiredSecondaryDropCalls = 0;
  const origDropSecondary = expiredSecondary.dropFrames.bind(expiredSecondary);
  expiredSecondary.dropFrames = () => {
    expiredSecondaryDropCalls += 1;
    origDropSecondary();
  };

  const withClient = hubMod.getOrCreateHub("keep-client-03");
  const activePhone = new FakeSocket();
  withClient.clients.add(activePhone.asWs());
  withClient.addFrame({
    data: "KEEP_CLIENT_" + "C".repeat(160),
    sharpness: 0.08,
    ts: Date.now(),
    bytes: 180,
    source: "phone",
  });
  let withClientDropCalls = 0;
  const origDropClient = withClient.dropFrames.bind(withClient);
  withClient.dropFrames = () => {
    withClientDropCalls += 1;
    origDropClient();
  };

  const withActiveLive = hubMod.getOrCreateHub("keep-live-04");
  withActiveLive.live = { active: true, handleEvent() {}, stop() {} };
  withActiveLive.addFrame({
    data: "KEEP_LIVE_" + "D".repeat(160),
    sharpness: 0.08,
    ts: Date.now(),
    bytes: 180,
    source: "phone",
  });
  let withActiveLiveDropCalls = 0;
  const origDropLive = withActiveLive.dropFrames.bind(withActiveLive);
  withActiveLive.dropFrames = () => {
    withActiveLiveDropCalls += 1;
    origDropLive();
  };

  const recentlyTouched = hubMod.getOrCreateHub("keep-recent-05");
  recentlyTouched.addFrame({
    data: "KEEP_RECENT_" + "E".repeat(160),
    sharpness: 0.08,
    ts: Date.now(),
    bytes: 180,
    source: "phone",
  });
  let recentlyTouchedDropCalls = 0;
  const origDropRecent = recentlyTouched.dropFrames.bind(recentlyTouched);
  recentlyTouched.dropFrames = () => {
    recentlyTouchedDropCalls += 1;
    origDropRecent();
  };

  assert.deepEqual(hubMod.hubStats(), {
    sessions: 5,
    latest: "expired-",
    floatingHuds: 0,
    floatingStages: 0,
  });
  assert.equal(hubMod.latestHub(), expiredLatest);
  assert.equal(expiredLatest.ring.length, 1);
  assert.ok(expiredLatest.lastCode);
  assert.ok(expiredLatest.lastFields);

  t.mock.timers.tick(60_000);
  assert.equal(Date.now(), 1_060_000);
  hubMod.getOrCreateHub("keep-recent-05");
  assert.equal(recentlyTouched.touchedAt, 1_060_000);

  t.mock.timers.tick(9 * 60_000);
  assert.equal(Date.now(), 1_600_000);
  assert.equal(Date.now() - expiredLatest.touchedAt, 10 * 60_000);
  assert.equal(expiredLatestDropCalls, 0);
  assert.equal(expiredSecondaryDropCalls, 0);
  assert.deepEqual(hubMod.hubStats(), {
    sessions: 5,
    latest: "expired-",
    floatingHuds: 0,
    floatingStages: 0,
  });
  assert.equal(hubMod.latestHub(), expiredLatest);

  t.mock.timers.tick(60_000);
  assert.equal(Date.now(), 1_660_000);
  assert.equal(expiredLatestDropCalls, 1);
  assert.equal(expiredLatest.ring.length, 0);
  assert.equal(expiredLatest.lastCode, undefined);
  assert.equal(expiredLatest.lastFields, undefined);
  assert.equal(expiredSecondaryDropCalls, 1);
  assert.equal(expiredSecondary.ring.length, 0);
  assert.equal(hubMod.getHub("expired-latest-01"), undefined);
  assert.equal(hubMod.getHub("expired-second-02"), undefined);
  assert.equal(hubMod.latestHub(), undefined);
  assert.equal(hubMod.resolveHub(undefined), undefined);
  assert.deepEqual(hubMod.hubStats(), {
    sessions: 3,
    latest: null,
    floatingHuds: 0,
    floatingStages: 0,
  });

  assert.equal(Date.now() - recentlyTouched.touchedAt, 10 * 60_000);
  assert.equal(hubMod.getHub("keep-client-03"), withClient);
  assert.equal(hubMod.getHub("keep-live-04"), withActiveLive);
  assert.equal(hubMod.getHub("keep-recent-05"), recentlyTouched);
  assert.equal(withClientDropCalls, 0);
  assert.equal(withActiveLiveDropCalls, 0);
  assert.equal(recentlyTouchedDropCalls, 0);
  assert.equal(withClient.ring.length, 1);
  assert.equal(withActiveLive.ring.length, 1);
  assert.equal(recentlyTouched.ring.length, 1);

  hubMod.markLatest(withActiveLive);
  assert.equal(hubMod.hubStats().latest, "keep-liv");

  t.mock.timers.tick(60_000);
  assert.equal(Date.now(), 1_720_000);
  assert.equal(recentlyTouchedDropCalls, 1);
  assert.equal(recentlyTouched.ring.length, 0);
  assert.equal(hubMod.getHub("keep-recent-05"), undefined);
  assert.equal(hubMod.latestHub(), withActiveLive);
  assert.deepEqual(hubMod.hubStats(), {
    sessions: 2,
    latest: "keep-liv",
    floatingHuds: 0,
    floatingStages: 0,
  });

  withClient.clients.delete(activePhone.asWs());
  withActiveLive.live = { active: false, handleEvent() {}, stop() {} };
  t.mock.timers.tick(11 * 60_000);
  assert.equal(withClientDropCalls, 1);
  assert.equal(withActiveLiveDropCalls, 1);
  assert.equal(withClient.ring.length, 0);
  assert.equal(withActiveLive.ring.length, 0);
  assert.equal(hubMod.latestHub(), undefined);
  assert.deepEqual(hubMod.hubStats(), {
    sessions: 0,
    latest: null,
    floatingHuds: 0,
    floatingStages: 0,
  });
});

test("1-second stage metrics interval decays fps and frameKb past FPS_WINDOW_MS and deduplicates unchanged ticks", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 2_000_000 });

  const { hubMod, indexMod } = await loadIsolatedCase("case-b", { withIndex: true });
  const server = await indexMod!.startServer(0);
  const openSockets: WebSocket[] = [];

  t.after(async () => {
    for (const ws of openSockets) await closeWs(ws);
    await closeServer(server);
    t.mock.timers.reset();
  });

  const port = (server.address() as AddressInfo).port;
  const hub = hubMod.getOrCreateHub("stage-fps-decay-01");
  const phone = new FakeSocket();
  hub.clients.add(phone.asWs());
  t.after(() => {
    hub.clients.delete(phone.asWs());
  });
  hubMod.markLatest(hub);

  const explicitStage = connectWs(wsUrl(port, "/hud-ws?role=stage&session=stage-fps-decay-01"));
  const floatingStage = connectWs(wsUrl(port, "/hud-ws?role=stage"));
  const explicitHud = connectWs(wsUrl(port, "/hud-ws?session=stage-fps-decay-01"));
  openSockets.push(explicitStage.ws, floatingStage.ws, explicitHud.ws);
  await Promise.all([explicitStage.opened, floatingStage.opened, explicitHud.opened]);

  const initialExplicit = (await waitForMsg(explicitStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  const initialFloating = (await waitForMsg(floatingStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  assert.equal(initialExplicit.fps, 0);
  assert.equal(initialExplicit.frameKb, null);
  assert.equal(initialFloating.fps, 0);
  assert.equal(initialFloating.frameKb, null);

  await waitRealMs(25);
  explicitStage.msgs.length = 0;
  floatingStage.msgs.length = 0;
  explicitHud.msgs.length = 0;

  for (let i = 0; i < 5; i++) {
    hub.addFrame({
      data: `BURST1_${i}_` + "F".repeat(160),
      sharpness: 0.1,
      ts: Date.now(),
      bytes: 20_480,
      source: "phone",
    });
  }

  const snapshotAfterAdd = hub.metrics();
  assert.equal(snapshotAfterAdd.fps, 1);
  assert.equal(snapshotAfterAdd.frameKb, 20);

  t.mock.timers.tick(1000);
  assert.equal(Date.now(), 2_001_000);
  const activeExplicit = (await waitForMsg(explicitStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  const activeFloating = (await waitForMsg(floatingStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  await waitRealMs(25);

  assert.equal(explicitStage.msgs.length, 1);
  assert.equal(floatingStage.msgs.length, 1);
  assert.equal(activeExplicit.fps, 1);
  assert.equal(activeExplicit.frameKb, 20);
  assert.equal(activeFloating.fps, 1);
  assert.equal(activeFloating.frameKb, 20);
  assert.equal(explicitHud.msgs.some((m) => m.type === "metrics"), false);

  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000);
  }
  assert.equal(Date.now(), 2_004_000);
  await waitRealMs(30);
  assert.equal(explicitStage.msgs.length, 1);
  assert.equal(floatingStage.msgs.length, 1);

  explicitStage.msgs.length = 0;
  floatingStage.msgs.length = 0;

  t.mock.timers.tick(1000);
  assert.equal(Date.now(), 2_005_000);
  const decayedExplicit = (await waitForMsg(explicitStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  const decayedFloating = (await waitForMsg(floatingStage.msgs, (m) => m.type === "metrics")) as StageMetrics;
  await waitRealMs(25);

  assert.equal(explicitStage.msgs.length, 1);
  assert.equal(floatingStage.msgs.length, 1);
  assert.equal(decayedExplicit.type, "metrics");
  assert.equal(decayedExplicit.fps, 0);
  assert.equal(decayedExplicit.frameKb, null);
  assert.equal(decayedFloating.type, "metrics");
  assert.equal(decayedFloating.fps, 0);
  assert.equal(decayedFloating.frameKb, null);

  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(1000);
  }
  assert.equal(Date.now(), 2_011_000);
  await waitRealMs(35);
  assert.equal(explicitStage.msgs.length, 1);
  assert.equal(floatingStage.msgs.length, 1);
  assert.equal(explicitHud.msgs.some((m) => m.type === "metrics"), false);
});

test("POST /api/verify preserves active Live latestHub and promotes snapshot session once Live becomes inactive", async (t) => {
  const { ledgerFile, geminiMod, hubMod, indexMod } = await loadIsolatedCase("case-c", { withIndex: true });

  let verifyCalls = 0;
  geminiMod.ai.models.generateContent = (async () => {
    verifyCalls += 1;
    return {
      text: JSON.stringify(sampleRead),
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
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

  const hubA = hubMod.getOrCreateHub("live-sess-alpha");
  const phoneA = new FakeSocket();
  hubA.clients.add(phoneA.asWs());
  hubA.live = { active: true, handleEvent() {}, stop() {} };
  hubMod.markLatest(hubA);

  const hubB = hubMod.getOrCreateHub("snap-sess-bravo");
  const phoneB = new FakeSocket();
  hubB.clients.add(phoneB.asWs());

  t.after(() => {
    hubA.clients.delete(phoneA.asWs());
    hubB.clients.delete(phoneB.asWs());
  });

  const floatingHud = connectWs(wsUrl(port, "/hud-ws"));
  const floatingStage = connectWs(wsUrl(port, "/hud-ws?role=stage"));
  const explicitHudA = connectWs(wsUrl(port, "/hud-ws?session=live-sess-alpha"));
  const explicitHudB = connectWs(wsUrl(port, "/hud-ws?session=snap-sess-bravo"));
  openSockets.push(floatingHud.ws, floatingStage.ws, explicitHudA.ws, explicitHudB.ws);
  await Promise.all([floatingHud.opened, floatingStage.opened, explicitHudA.opened, explicitHudB.opened]);
  await waitForMsg(floatingStage.msgs, (m) => m.type === "metrics");
  await waitRealMs(25);

  floatingHud.msgs.length = 0;
  floatingStage.msgs.length = 0;
  explicitHudA.msgs.length = 0;
  explicitHudB.msgs.length = 0;
  phoneA.sent.length = 0;
  phoneB.sent.length = 0;

  const snapWhileLiveRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "snap-sess-bravo",
      frames: ["SNAP_ACTIVE_GUARD_" + "A".repeat(160)],
      profile: sampleProfile,
    }),
  });
  assert.equal(snapWhileLiveRes.status, 200);
  const verdictWhileLive = (await snapWhileLiveRes.json()) as Verdict;
  assert.equal(verdictWhileLive.level, "match");
  assert.equal(verdictWhileLive.matchedMedId, "aml");
  assert.equal(verifyCalls, 1);

  assert.equal(hubMod.latestHub(), hubA);
  assert.equal(hubMod.resolveHub(undefined), hubA);
  assert.equal(hubMod.hubStats().latest, "live-ses");

  const bExplicitVerdict1 = await waitForMsg(explicitHudB.msgs, (m) => m.type === "verdict");
  assert.equal(bExplicitVerdict1.type, "verdict");
  await waitRealMs(30);
  assert.equal(floatingHud.msgs.some((m) => m.type === "verdict"), false);
  assert.equal(floatingStage.msgs.some((m) => m.type === "verdict"), false);
  assert.equal(explicitHudA.msgs.some((m) => m.type === "verdict"), false);
  assert.equal(phoneB.sent.some((m) => m.type === "hud"), false);

  hubA.emit({ type: "coach", cue: "closer", text: "Move closer" });
  await waitForMsg(floatingHud.msgs, (m) => m.type === "coach");
  await waitForMsg(floatingStage.msgs, (m) => m.type === "coach");
  await waitForMsg(explicitHudA.msgs, (m) => m.type === "coach");
  assert.equal(explicitHudB.msgs.some((m) => m.type === "coach"), false);

  floatingHud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));
  await waitForMsg(phoneA.sent, (m) => m.type === "hud_event" && m.name === "repeat");
  assert.equal(phoneB.sent.some((m) => m.type === "hud_event"), false);

  hubA.live = { active: false, handleEvent() {}, stop() {} };
  floatingHud.msgs.length = 0;
  floatingStage.msgs.length = 0;
  explicitHudA.msgs.length = 0;
  explicitHudB.msgs.length = 0;
  phoneA.sent.length = 0;
  phoneB.sent.length = 0;

  const snapAfterStopRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "snap-sess-bravo",
      frames: ["SNAP_PROMOTE_BRAVO_" + "B".repeat(160)],
      profile: sampleProfile,
    }),
  });
  assert.equal(snapAfterStopRes.status, 200);
  const verdictAfterStop = (await snapAfterStopRes.json()) as Verdict;
  assert.equal(verdictAfterStop.level, "match");
  assert.equal(verdictAfterStop.matchedMedId, "aml");
  assert.equal(verifyCalls, 2);

  assert.equal(hubMod.latestHub(), hubB);
  assert.equal(hubMod.resolveHub(undefined), hubB);
  assert.equal(hubMod.hubStats().latest, "snap-ses");

  const promotedFloatHud = await waitForMsg(floatingHud.msgs, (m) => m.type === "verdict");
  const promotedFloatStage = await waitForMsg(floatingStage.msgs, (m) => m.type === "verdict");
  const promotedStageMetrics = (await waitForMsg(
    floatingStage.msgs,
    (m) => m.type === "metrics",
  )) as StageMetrics;
  await waitForMsg(explicitHudB.msgs, (m) => m.type === "verdict");
  await waitRealMs(30);

  assert.equal(promotedFloatHud.type, "verdict");
  assert.equal(promotedFloatHud.verdict.matchedMedId, "aml");
  assert.equal(promotedFloatStage.type, "verdict");
  assert.equal(promotedFloatStage.verdict.matchedMedId, "aml");
  assert.equal(promotedStageMetrics.phone, true);
  assert.equal(promotedStageMetrics.hud, true);
  assert.equal(floatingHud.msgs.filter((m) => m.type === "verdict").length, 1);
  assert.equal(floatingStage.msgs.filter((m) => m.type === "verdict").length, 1);
  assert.equal(explicitHudA.msgs.length, 0);
  assert.deepEqual(
    phoneB.sent.filter((m) => m.type === "hud"),
    [{ type: "hud", connected: true }],
  );

  floatingHud.msgs.length = 0;
  floatingStage.msgs.length = 0;
  phoneB.sent.length = 0;

  const snapAlreadyLatestRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: "snap-sess-bravo",
      frames: ["SNAP_ALREADY_LATEST_" + "C".repeat(160)],
      profile: sampleProfile,
    }),
  });
  assert.equal(snapAlreadyLatestRes.status, 200);
  assert.equal(verifyCalls, 3);
  await waitForMsg(floatingHud.msgs, (m) => m.type === "verdict");
  await waitForMsg(floatingStage.msgs, (m) => m.type === "verdict");
  await waitRealMs(30);

  assert.equal(floatingHud.msgs.filter((m) => m.type === "verdict").length, 1);
  assert.equal(floatingStage.msgs.filter((m) => m.type === "verdict").length, 1);
  assert.equal(phoneB.sent.filter((m) => m.type === "hud").length, 0);
});

test("zero external network calls, zero unexpected Gemini calls, and workspace ledger untouched", () => {
  assert.equal(unexpectedGeminiCalls, 0);
  assert.deepEqual(externalFetchCalls, []);
  assert.ok(loopbackFetchCalls >= 3);
  for (const caseId of CASE_IDS) {
    assert.equal(fs.existsSync(path.join(tmpRoot, caseId, "server", "logs", "ledger.jsonl")), false);
  }
  assert.equal(repoWriteTargets.includes(repoLedgerPath), false);
  assert.deepEqual(repoWriteTargets, []);
});
