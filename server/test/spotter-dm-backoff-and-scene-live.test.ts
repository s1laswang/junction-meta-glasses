import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpegJs from "jpeg-js";
import type WebSocket from "ws";
import type { Gs1Code, LabelRead, Profile, ServerMsg } from "../../shared/types.ts";
import type { StageMetrics } from "../src/hub.ts";
import type { FieldBox } from "../src/spotter.ts";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const REPO_LEDGER_PATH = path.join(SERVER_DIR, "logs", "ledger.jsonl");
const DM_FIXTURE_PATH = path.join(SERVER_DIR, "fixtures", "dm_amlodipine.jpg");
const MODEL_PATH = path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");

const origEnv = {
  HOLDUP_QUIET: process.env.HOLDUP_QUIET,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  LEDGER_PATH: process.env.LEDGER_PATH,
  HOLDUP_KEY: process.env.HOLDUP_KEY,
  SPOTTER: process.env.SPOTTER,
};

function snapshotFile(p: string): { exists: boolean; sha256: string; size: number } {
  if (!fs.existsSync(p)) return { exists: false, sha256: "", size: 0 };
  const buf = fs.readFileSync(p);
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
  };
}

const repoLedgerBefore = snapshotFile(REPO_LEDGER_PATH);

const tmpRoot = fs.mkdtempSync(
  path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-s-w3c-"),
);
const isolatedLedgerPath = path.join(tmpRoot, "ledger.jsonl");

let cleanedTmp = false;
function cleanupTmp() {
  if (cleanedTmp) return;
  cleanedTmp = true;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}
process.once("exit", cleanupTmp);

function restoreEnv(key: keyof typeof origEnv) {
  const val = origEnv[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

process.env.HOLDUP_QUIET = "1";
process.env.GEMINI_API_KEY = "";
process.env.ELEVENLABS_API_KEY = "";
process.env.LEDGER_PATH = isolatedLedgerPath;
delete process.env.HOLDUP_KEY;

const origFetch = globalThis.fetch;
let externalFetchCalls = 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  externalFetchCalls += 1;
  throw new Error(`unexpected network fetch: ${String(input)}`);
}) as typeof fetch;

const envMod = await import("../src/env.ts");
const geminiMod = await import("../src/gemini.ts");
const spotterMod = await import("../src/spotter.ts");
const dmMod = await import("../src/dm.ts");
const findMod = await import("../src/find.ts");
const hubMod = await import("../src/hub.ts");
const liveMod = await import("../src/live.ts");
const speculateMod = await import("../src/speculate.ts");

const savedRuntime = {
  connect: (geminiMod.ai.live as any).connect,
  generateContent: (geminiMod.ai.models as any).generateContent,
  modelsGet: (geminiMod.ai.models as any).get,
  liveModels: [...envMod.env.liveModels],
  verifyModels: [...envMod.env.verifyModels],
  features: [...envMod.env.features],
  ledgerPath: envMod.env.ledgerPath,
  apiKey: envMod.env.apiKey,
  specDebounce: speculateMod.SPEC.debounceMs,
  specMinGap: speculateMod.SPEC.minGapMs,
};

const TINY_JPEG_BUF = Buffer.from(
  jpegJs.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 80).data,
);
const TINY_JPEG_B64 = TINY_JPEG_BUF.toString("base64");
const CORRUPT_JPEG_B64 = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]).toString("base64");
const DM_AMLODIPINE_JPG = fs.readFileSync(DM_FIXTURE_PATH);

type ConnectArg = {
  model: string;
  config: {
    tools?: { functionDeclarations?: { name?: string }[] }[];
    systemInstruction?: string;
  };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

type GenArg = {
  model: string;
  contents: any[];
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
  };
};

type AnyOutMsg = ServerMsg | StageMetrics;

function makeFakeSession(arg: ConnectArg) {
  const toolResponses: any[] = [];
  const realtimeInputs: any[] = [];
  let closed = false;
  return {
    arg,
    toolResponses,
    realtimeInputs,
    get closed() {
      return closed;
    },
    session: {
      sendToolResponse(r: any) {
        toolResponses.push(r);
      },
      sendRealtimeInput(r: any) {
        realtimeInputs.push(r);
      },
      close() {
        closed = true;
      },
    },
  };
}

let sessions: ReturnType<typeof makeFakeSession>[] = [];
let genCalls: GenArg[] = [];
let unexpectedGeminiCalls = 0;

const fld = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function makeMedRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: fld("Norvasc"),
    ingredient: fld("amlodipine", 0.97),
    strength: fld("5 mg", 0.96),
    dosing: fld("1 tablet daily", 0.9),
    expiry: fld("2028-08", 0.95),
    allergens: fld<string[]>(null, 0),
    barcode: fld(null, 0),
    readability: 0.94,
    ...overrides,
  };
}

const DEMO_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      gtin: "09501101530003",
    },
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

function makeSocket<T extends object = ServerMsg>() {
  const msgs: T[] = [];
  const waiters: { pred: (m: T) => boolean; resolve: (m: T) => void }[] = [];
  const closeListeners: (() => void)[] = [];
  const raw = {
    readyState: 1,
    send(payload: string) {
      const parsed = JSON.parse(payload) as T;
      msgs.push(parsed);
      const idx = waiters.findIndex((w) => w.pred(parsed));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed);
    },
    on(ev: string, fn: () => void) {
      if (ev === "close") closeListeners.push(fn);
    },
    close() {
      raw.readyState = 3;
      for (const fn of closeListeners) fn();
    },
  };
  const waitFor = (pred: (m: T) => boolean, from = 0): Promise<T> => {
    const hit = msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for message; seen=${JSON.stringify(msgs.slice(from))}`));
      }, 2000);
      timer.unref?.();
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return {
    ws: raw as unknown as WebSocket,
    msgs,
    waitFor,
    close: () => raw.close(),
  };
}

function makeSceneRig(
  id: string,
  opts: { lang?: string; features?: ("scene" | "datamatrix" | "addmed" | "sonar")[] } = {},
) {
  const lang = opts.lang ?? "en";
  const hub = hubMod.getOrCreateHub(id);
  hub.profile = structuredClone(DEMO_PROFILE);
  hub.profile.lang = lang;
  if (opts.features) hub.features = new Set(opts.features);
  hubMod.markLatest(hub);

  const phone = makeSocket<ServerMsg>();
  const hud = makeSocket<ServerMsg>();
  const stage = makeSocket<AnyOutMsg>();
  hub.clients.add(phone.ws);
  hubMod.addHud(hud.ws, id);
  hubMod.addStage(stage.ws, id);

  const proxy = new liveMod.LiveProxy(hub, { lang, voice: true });
  hub.live = proxy;

  phone.msgs.length = 0;
  hud.msgs.length = 0;
  stage.msgs.length = 0;

  return {
    hub,
    proxy,
    phone,
    hud,
    stage,
    cleanup() {
      proxy.stop("cleanup");
      hud.close();
      stage.close();
      hub.clients.delete(phone.ws);
      hub.dropFrames();
    },
  };
}

before(() => {
  assert.equal(envMod.env.apiKey, "");
  assert.equal(envMod.env.elevenlabs, false);
  assert.equal(envMod.env.ledgerPath, isolatedLedgerPath);
});

beforeEach(() => {
  sessions = [];
  genCalls = [];
  envMod.env.ledgerPath = isolatedLedgerPath;
  envMod.env.apiKey = "";
  envMod.env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
  envMod.env.verifyModels = ["gemini-3.8-flash"];
  envMod.env.features = [...envMod.ALL_FEATURES];
  speculateMod.SPEC.debounceMs = 60_000;
  speculateMod.SPEC.minGapMs = 60_000;

  (geminiMod.ai.models as any).get = async () => {
    unexpectedGeminiCalls += 1;
    throw new Error("unexpected ai.models.get call");
  };
  (geminiMod.ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeFakeSession(arg);
    sessions.push(s);
    return s.session;
  };
  (geminiMod.ai.models as any).generateContent = async (arg: GenArg) => {
    genCalls.push(arg);
    return {
      text: JSON.stringify({ items: [] }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    };
  };
});

afterEach(() => {
  (geminiMod.ai.live as any).connect = savedRuntime.connect;
  (geminiMod.ai.models as any).generateContent = savedRuntime.generateContent;
  (geminiMod.ai.models as any).get = savedRuntime.modelsGet;
  envMod.env.liveModels = [...savedRuntime.liveModels];
  envMod.env.verifyModels = [...savedRuntime.verifyModels];
  envMod.env.features = [...savedRuntime.features];
  envMod.env.ledgerPath = savedRuntime.ledgerPath;
  envMod.env.apiKey = savedRuntime.apiKey;
  speculateMod.SPEC.debounceMs = savedRuntime.specDebounce;
  speculateMod.SPEC.minGapMs = savedRuntime.specMinGap;
});

after(() => {
  globalThis.fetch = origFetch;
  restoreEnv("HOLDUP_QUIET");
  restoreEnv("GEMINI_API_KEY");
  restoreEnv("ELEVENLABS_API_KEY");
  restoreEnv("LEDGER_PATH");
  restoreEnv("HOLDUP_KEY");
  restoreEnv("SPOTTER");
  cleanupTmp();
});

test("SpotThrottle enforces minGapMs and busy guard, resets slow streak on fast run, engages 3-strike 5s backoff, and recovers from rejected detect()", async () => {
  assert.equal(fs.existsSync(MODEL_PATH), true);
  assert.deepEqual(spotterMod.SPOT, {
    size: 640,
    conf: 0.4,
    iou: 0.5,
    minGapMs: 400,
    slowMs: 2500,
    backoffMs: 5000,
  });

  await spotterMod.detect(TINY_JPEG_BUF);

  const realNow = Date.now;
  const origConsoleLog = console.log;
  const prevQuiet = process.env.HOLDUP_QUIET;
  const capturedLogs: string[] = [];
  let clock = 10_000;

  Date.now = () => clock;
  delete process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  async function waitBusyClear(st: InstanceType<typeof spotterMod.SpotThrottle>) {
    for (let i = 0; i < 400 && (st as unknown as { busy: boolean }).busy; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal((st as unknown as { busy: boolean }).busy, false, "SpotThrottle busy must reset to false");
  }

  async function runValid(
    st: InstanceType<typeof spotterMod.SpotThrottle>,
    startAt: number,
    durationMs: number,
    onBusy?: () => void,
  ): Promise<{ fields: FieldBox[]; ms: number }> {
    clock = startAt;
    let out: { fields: FieldBox[]; ms: number } | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    st.maybe(TINY_JPEG_B64, (fields, ms) => {
      out = { fields, ms };
      resolveDone();
    });
    assert.equal((st as unknown as { busy: boolean }).busy, true);
    onBusy?.();
    clock = startAt + durationMs;
    await done;
    await waitBusyClear(st);
    assert.ok(out);
    assert.equal(out.ms, durationMs);
    return out;
  }

  try {
    const stGuard = new spotterMod.SpotThrottle();
    let droppedHits = 0;
    await runValid(stGuard, 10_000, 60, () => {
      stGuard.maybe(TINY_JPEG_B64, () => {
        droppedHits += 1;
      });
      clock = 10_900;
      stGuard.maybe(TINY_JPEG_B64, () => {
        droppedHits += 1;
      });
    });
    assert.equal(droppedHits, 0);
    assert.equal(stGuard.runs, 1);
    assert.equal(stGuard.totalMs, 60);

    clock = 10_399;
    stGuard.maybe(TINY_JPEG_B64, () => {
      droppedHits += 1;
    });
    assert.equal((stGuard as unknown as { busy: boolean }).busy, false);
    assert.equal(droppedHits, 0);
    assert.equal(stGuard.runs, 1);

    await runValid(stGuard, 10_400, 40);
    assert.equal(stGuard.runs, 2);
    assert.equal(stGuard.totalMs, 100);

    const stStreakReset = new spotterMod.SpotThrottle();
    capturedLogs.length = 0;
    await runValid(stStreakReset, 20_000, 2501);
    await runValid(stStreakReset, 23_000, 2650);
    await runValid(stStreakReset, 26_000, 2500);
    await runValid(stStreakReset, 29_000, 2700);
    assert.equal(capturedLogs.some((l) => l.includes("spotter.backoff")), false);
    await runValid(stStreakReset, 32_200, 120);
    assert.equal(stStreakReset.runs, 5);
    assert.equal(stStreakReset.totalMs, 2501 + 2650 + 2500 + 2700 + 120);
    assert.equal(capturedLogs.some((l) => l.includes("spotter.backoff")), false);

    const stBackoff = new spotterMod.SpotThrottle();
    capturedLogs.length = 0;
    await runValid(stBackoff, 50_000, 2600);
    await runValid(stBackoff, 53_000, 2600);
    assert.equal(capturedLogs.some((l) => l.includes("spotter.backoff")), false);

    const strike3Start = 56_000;
    const strike3Ms = 2600;
    const strike3End = strike3Start + strike3Ms;
    await runValid(stBackoff, strike3Start, strike3Ms);
    assert.equal(stBackoff.runs, 3);
    assert.equal(capturedLogs.some((l) => l.includes("spotter.backoff") && l.includes("ms=2600")), true);

    let suppressedDuringBackoff = 0;
    for (const probeTs of [strike3End + 450, strike3End + 2500, strike3End + 4999]) {
      clock = probeTs;
      stBackoff.maybe(TINY_JPEG_B64, () => {
        suppressedDuringBackoff += 1;
      });
      assert.equal((stBackoff as unknown as { busy: boolean }).busy, false);
    }
    assert.equal(suppressedDuringBackoff, 0);
    assert.equal(stBackoff.runs, 3);

    await runValid(stBackoff, strike3End + 5001, 2600);
    assert.equal(stBackoff.runs, 4);
    await runValid(stBackoff, strike3End + 8100, 90);
    assert.equal(stBackoff.runs, 5);

    const stErr = new spotterMod.SpotThrottle();
    capturedLogs.length = 0;
    const errStart = 100_000;
    const errSettled = 100_025;
    clock = errStart;
    let corruptCbCount = 0;
    stErr.maybe(CORRUPT_JPEG_B64, () => {
      corruptCbCount += 1;
    });
    assert.equal((stErr as unknown as { busy: boolean }).busy, true);
    clock = errSettled;
    await waitBusyClear(stErr);

    assert.equal(corruptCbCount, 0);
    assert.equal(stErr.runs, 0);
    assert.equal(stErr.totalMs, 0);
    assert.equal(capturedLogs.some((l) => l.includes("spotter.failed")), true);

    for (const probeTs of [errSettled + 500, errSettled + 4999]) {
      clock = probeTs;
      stErr.maybe(TINY_JPEG_B64, () => {
        corruptCbCount += 1;
      });
      assert.equal((stErr as unknown as { busy: boolean }).busy, false);
    }
    assert.equal(corruptCbCount, 0);
    assert.equal(stErr.runs, 0);

    await runValid(stErr, errSettled + 5001, 75);
    assert.equal(stErr.runs, 1);
    assert.equal(stErr.totalMs, 75);
  } finally {
    Date.now = realNow;
    console.log = origConsoleLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});

test("decodeDataMatrix guards empty and <4-byte buffers immediately, and DmThrottle enforces minGapMs vs slow backoffMs while resetting busy in finally", async () => {
  assert.deepEqual(dmMod.DM, { minGapMs: 1500, slowMs: 150, backoffMs: 10_000 });

  await dmMod.decodeDataMatrix(DM_AMLODIPINE_JPG);

  const realNow = Date.now;
  let clock = 200_000;
  Date.now = () => clock;

  try {
    for (const shortOrInvalid of [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xd8, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]) as unknown as Buffer,
      null as unknown as Buffer,
    ]) {
      const res = await dmMod.decodeDataMatrix(shortOrInvalid);
      assert.deepEqual(res, { codes: [], ms: 0 });
    }

    const dm = new dmMod.DmThrottle();
    const decoded: Gs1Code[] = [];
    let concurrentHits = 0;

    clock = 300_000;
    const pFast = dm.maybe(DM_AMLODIPINE_JPG, (c) => decoded.push(c));
    assert.equal((dm as unknown as { busy: boolean }).busy, true);
    await dm.maybe(DM_AMLODIPINE_JPG, () => {
      concurrentHits += 1;
    });
    assert.equal(concurrentHits, 0);
    clock = 300_000 + dmMod.DM.slowMs;
    await pFast;
    assert.equal((dm as unknown as { busy: boolean }).busy, false);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].gtin, "09501101530003");

    const afterFastNextAt = 300_000 + dmMod.DM.slowMs + dmMod.DM.minGapMs;
    clock = afterFastNextAt - 1;
    await dm.maybe(DM_AMLODIPINE_JPG, (c) => decoded.push(c));
    assert.equal(decoded.length, 1);
    assert.equal((dm as unknown as { busy: boolean }).busy, false);

    clock = afterFastNextAt;
    const pSlow = dm.maybe(DM_AMLODIPINE_JPG, (c) => decoded.push(c));
    assert.equal((dm as unknown as { busy: boolean }).busy, true);
    const slowFinish = afterFastNextAt + dmMod.DM.slowMs + 1;
    clock = slowFinish;
    await pSlow;
    assert.equal((dm as unknown as { busy: boolean }).busy, false);
    assert.equal(decoded.length, 2);

    const afterSlowBackoffAt = slowFinish + dmMod.DM.backoffMs;
    for (const probeTs of [slowFinish + dmMod.DM.minGapMs, slowFinish + 5000, afterSlowBackoffAt - 1]) {
      clock = probeTs;
      await dm.maybe(DM_AMLODIPINE_JPG, (c) => decoded.push(c));
      assert.equal(decoded.length, 2);
      assert.equal((dm as unknown as { busy: boolean }).busy, false);
    }

    clock = afterSlowBackoffAt;
    const pThrow = dm.maybe(DM_AMLODIPINE_JPG, () => {
      throw new Error("listener boom");
    });
    assert.equal((dm as unknown as { busy: boolean }).busy, true);
    const throwFinish = afterSlowBackoffAt + 30;
    clock = throwFinish;
    await assert.rejects(pThrow, /listener boom/);
    assert.equal((dm as unknown as { busy: boolean }).busy, false);

    clock = throwFinish + dmMod.DM.minGapMs;
    const pResume = dm.maybe(DM_AMLODIPINE_JPG, (c) => decoded.push(c));
    clock = throwFinish + dmMod.DM.minGapMs + 25;
    await pResume;
    assert.equal((dm as unknown as { busy: boolean }).busy, false);
    assert.equal(decoded.length, 3);
  } finally {
    Date.now = realNow;
  }
});

test("LiveProxy find_item enforces scene feature gate and empty-ring fast path with zero Gemini or checking events", async () => {
  assert.equal(
    liveMod.toolsFor(new Set()).some((t) => t.name === "find_item"),
    false,
  );
  assert.equal(
    liveMod.toolsFor(new Set(["datamatrix", "addmed", "sonar"])).some((t) => t.name === "find_item"),
    false,
  );
  assert.equal(
    liveMod.toolsFor(new Set(["scene"])).some((t) => t.name === "find_item"),
    true,
  );

  const disabledRig = makeSceneRig("scene-gate-off", { features: ["datamatrix", "sonar"] });
  try {
    await disabledRig.proxy.start();
    const s = sessions[0];
    assert.deepEqual(
      s.arg.config.tools?.[0]?.functionDeclarations?.map((t) => t.name),
      ["verify_label", "show_cue", "log_dose"],
    );
    disabledRig.hub.ring.push({
      data: TINY_JPEG_B64,
      sharpness: 0.9,
      ts: Date.now(),
      bytes: TINY_JPEG_BUF.length,
      source: "phone",
    });
    const pIdx = disabledRig.phone.msgs.length;
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "no-scene-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await Promise.resolve();
    assert.deepEqual(s.toolResponses[0].functionResponses[0].response.output, {
      error: "unknown tool find_item",
    });
    assert.equal(genCalls.length, 0);
    assert.deepEqual(disabledRig.phone.msgs.slice(pIdx), []);
    assert.equal(disabledRig.proxy.stats().verify, null);
  } finally {
    disabledRig.cleanup();
  }

  const emptyRingRig = makeSceneRig("scene-empty-ring", { features: ["scene"] });
  try {
    await emptyRingRig.proxy.start();
    const s = sessions.at(-1)!;
    assert.deepEqual(
      s.arg.config.tools?.[0]?.functionDeclarations?.map((t) => t.name),
      ["verify_label", "show_cue", "log_dose", "find_item"],
    );
    const pIdx = emptyRingRig.phone.msgs.length;
    const hIdx = emptyRingRig.hud.msgs.length;
    const stIdx = emptyRingRig.stage.msgs.length;

    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "empty-ring-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await Promise.resolve();

    assert.equal(genCalls.length, 0);
    assert.deepEqual(emptyRingRig.phone.msgs.slice(pIdx), []);
    assert.deepEqual(emptyRingRig.hud.msgs.slice(hIdx), []);
    assert.deepEqual(emptyRingRig.stage.msgs.slice(stIdx), []);
    assert.deepEqual(s.toolResponses[0].functionResponses[0].response.output, {
      level: "unsure",
      speech: "I can't see the table yet. Point your head at the items.",
    });
    assert.equal(emptyRingRig.proxy.stats().verify, null);
  } finally {
    emptyRingRig.cleanup();
  }
});

test("LiveProxy find_item full scene lifecycle fans out verdict and metrics, localizes EN/FI/SV leads, arms expectSpoken corrections, and always emits checking:end on cancel or stop", async () => {
  const matchScenePayload = {
    items: [
      {
        box_2d: [220, 100, 720, 360],
        read: makeMedRead({ product: fld("Burana"), ingredient: fld("ibuprofen", 0.97), strength: fld("400 mg", 0.96) }),
        answers_target: false,
      },
      {
        box_2d: [220, 640, 720, 900],
        read: makeMedRead(),
        answers_target: true,
      },
    ],
  };

  const warnScenePayload = {
    items: [
      {
        box_2d: [220, 100, 720, 360],
        read: makeMedRead({ product: fld("Burana"), ingredient: fld("ibuprofen", 0.97), strength: fld("400 mg", 0.96) }),
        answers_target: false,
      },
      {
        box_2d: [220, 640, 720, 900],
        read: makeMedRead({ expiry: fld("2024-01", 0.95) }),
        answers_target: true,
      },
    ],
  };

  assert.deepEqual(liveMod.leadFor("en", "match"), {});
  assert.deepEqual(liveMod.leadFor("en", "warning"), {});
  assert.deepEqual(liveMod.leadFor("fi", "match"), { lead: "Oikea pakkaus." });
  assert.deepEqual(liveMod.leadFor("fi", "warning"), { lead: "Varoitus." });
  assert.deepEqual(liveMod.leadFor("sv", "match"), { lead: "R\u00e4tt f\u00f6rpackning." });
  assert.deepEqual(liveMod.leadFor("sv", "warning"), { lead: "Varning." });

  let currentPayload: unknown = matchScenePayload;
  const enRig = makeSceneRig("scene-en-full", { lang: "en", features: ["scene"] });
  try {
    let sawCheckingStartBeforeGen = false;
    let sawStageCheckingStartBeforeGen = false;
    (geminiMod.ai.models as any).generateContent = async (arg: GenArg) => {
      genCalls.push(arg);
      sawCheckingStartBeforeGen = enRig.phone.msgs.some((m) => m.type === "checking" && m.phase === "start");
      sawStageCheckingStartBeforeGen = enRig.stage.msgs.some((m) => m.type === "checking" && m.phase === "start");
      assert.equal(enRig.proxy.busy, true);
      return {
        text: JSON.stringify(currentPayload),
        usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 48 },
      };
    };

    await enRig.proxy.start();
    const s = sessions.at(-1)!;
    enRig.hub.ring.push({
      data: TINY_JPEG_B64,
      sharpness: 0.85,
      ts: Date.now(),
      bytes: TINY_JPEG_BUF.length,
      source: "phone",
    });
    enRig.hub.ring.push({
      data: TINY_JPEG_B64,
      sharpness: 0.92,
      ts: Date.now(),
      bytes: TINY_JPEG_BUF.length,
      source: "phone",
    });

    enRig.phone.msgs.length = 0;
    enRig.hud.msgs.length = 0;
    enRig.stage.msgs.length = 0;

    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "en-match-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await enRig.phone.waitFor((m) => m.type === "checking" && m.phase === "end");

    assert.equal(sawCheckingStartBeforeGen, true);
    assert.equal(sawStageCheckingStartBeforeGen, true);
    assert.equal(genCalls.length, 1);
    assert.equal(genCalls[0].config?.responseMimeType, "application/json");
    assert.deepEqual(genCalls[0].config?.responseJsonSchema, findMod.SCENE_SCHEMA);

    assert.deepEqual(enRig.phone.msgs.map((m) => m.type), ["checking", "verdict", "checking"]);
    assert.deepEqual(enRig.phone.msgs[0], { type: "checking", phase: "start" });
    assert.deepEqual(enRig.phone.msgs[2], { type: "checking", phase: "end" });

    const phoneVerdictMsg = enRig.phone.msgs[1];
    assert.equal(phoneVerdictMsg.type, "verdict");
    if (phoneVerdictMsg.type !== "verdict") throw new Error("expected verdict");
    assert.equal(phoneVerdictMsg.verdict.mode, "scene");
    assert.equal(phoneVerdictMsg.verdict.level, "match");

    assert.equal(enRig.hud.msgs.length, 1);
    assert.equal(enRig.hud.msgs[0].type, "verdict");
    assert.equal(enRig.hud.msgs.some((m) => m.type === "checking"), false);

    assert.equal(enRig.stage.msgs.some((m) => m.type === "checking" && m.phase === "start"), true);
    assert.equal(enRig.stage.msgs.some((m) => m.type === "verdict" && m.verdict.mode === "scene"), true);
    assert.equal(enRig.stage.msgs.some((m) => m.type === "checking" && m.phase === "end"), true);
    const stageMetricMatch = enRig.stage.msgs.find(
      (m): m is StageMetrics => m.type === "metrics" && m.verify?.source === "scene",
    );
    assert.ok(stageMetricMatch);
    assert.equal(stageMetricMatch.verify?.level, "match");
    assert.equal(enRig.proxy.stats().verify?.source, "scene");
    assert.equal(enRig.proxy.stats().verify?.level, "match");

    const enMatchOut = s.toolResponses[0].functionResponses[0].response.output;
    assert.equal(enMatchOut.mode, "scene");
    assert.equal(enMatchOut.level, "match");
    assert.equal(enMatchOut.speech, phoneVerdictMsg.verdict.speech);
    assert.equal("lead" in enMatchOut, false);
    assert.equal(enMatchOut.instruction, liveMod.speakInstruction("en", "If they pick one up, call verify_label."));
    assert.deepEqual(
      enMatchOut.items,
      (phoneVerdictMsg.verdict.items ?? []).map((i) => ({
        position: i.position,
        level: i.level,
        headline: i.headline,
      })),
    );

    s.arg.callbacks.onmessage({
      serverContent: { outputTranscription: { text: phoneVerdictMsg.verdict.speech }, turnComplete: true },
    });
    assert.equal(enRig.phone.msgs.some((m) => m.type === "correction"), false);

    currentPayload = warnScenePayload;
    const pWarnFrom = enRig.phone.msgs.length;
    const stWarnFrom = enRig.stage.msgs.length;
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "en-warn-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await enRig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", pWarnFrom);

    const warnVerdictMsg = enRig.phone.msgs
      .slice(pWarnFrom)
      .find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict");
    assert.ok(warnVerdictMsg);
    assert.equal(warnVerdictMsg.verdict.mode, "scene");
    assert.equal(warnVerdictMsg.verdict.level, "warning");
    assert.equal(enRig.proxy.stats().verify?.source, "scene");
    assert.equal(enRig.proxy.stats().verify?.level, "warning");
    const stageMetricWarn = enRig.stage.msgs
      .slice(stWarnFrom)
      .find((m): m is StageMetrics => m.type === "metrics" && m.verify?.level === "warning");
    assert.ok(stageMetricWarn);
    assert.equal(stageMetricWarn.verify?.source, "scene");

    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Your evening pill is the box on the right. Pick it up." },
        turnComplete: true,
      },
    });
    const enCorr = enRig.phone.msgs.filter((m): m is Extract<ServerMsg, { type: "correction" }> => m.type === "correction");
    assert.equal(enCorr.length, 1);
    assert.deepEqual(enCorr[0], {
      type: "correction",
      speech: warnVerdictMsg.verdict.speech,
      reasons: ["caution_dropped"],
    });
    assert.equal(enRig.hud.msgs.some((m) => m.type === "correction"), false);

    let markEnteredCancel!: () => void;
    let releaseCancel!: () => void;
    const enteredCancel = new Promise<void>((resolve) => {
      markEnteredCancel = resolve;
    });
    const gateCancel = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    (geminiMod.ai.models as any).generateContent = async (arg: GenArg) => {
      genCalls.push(arg);
      markEnteredCancel();
      await gateCancel;
      return { text: JSON.stringify(matchScenePayload), usageMetadata: {} };
    };

    const pCancelFrom = enRig.phone.msgs.length;
    const stCancelFrom = enRig.stage.msgs.length;
    const toolResBeforeCancel = s.toolResponses.length;
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "en-cancel-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await enteredCancel;
    assert.deepEqual(enRig.phone.msgs.slice(pCancelFrom), [{ type: "checking", phase: "start" }]);
    s.arg.callbacks.onmessage({ toolCallCancellation: { ids: ["en-cancel-1"] } });
    releaseCancel();
    await enRig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", pCancelFrom);

    assert.deepEqual(enRig.phone.msgs.slice(pCancelFrom), [
      { type: "checking", phase: "start" },
      { type: "checking", phase: "end" },
    ]);
    assert.equal(
      enRig.stage.msgs.slice(stCancelFrom).some((m) => m.type === "checking" && m.phase === "end"),
      true,
    );
    assert.equal(enRig.stage.msgs.slice(stCancelFrom).some((m) => m.type === "verdict"), false);
    assert.equal(s.toolResponses.length, toolResBeforeCancel);

    let markEnteredStop!: () => void;
    let releaseStop!: () => void;
    const enteredStop = new Promise<void>((resolve) => {
      markEnteredStop = resolve;
    });
    const gateStop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    (geminiMod.ai.models as any).generateContent = async (arg: GenArg) => {
      genCalls.push(arg);
      markEnteredStop();
      await gateStop;
      return { text: JSON.stringify(matchScenePayload), usageMetadata: {} };
    };

    const pStopFrom = enRig.phone.msgs.length;
    const stStopFrom = enRig.stage.msgs.length;
    const toolResBeforeStop = s.toolResponses.length;
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "en-stop-1", name: "find_item", args: { target: "my evening pill" } }] },
    });
    await enteredStop;
    assert.deepEqual(enRig.phone.msgs.slice(pStopFrom), [{ type: "checking", phase: "start" }]);
    enRig.proxy.stop("stopped during scene check");
    releaseStop();
    await enRig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", pStopFrom);

    assert.equal(enRig.phone.msgs.slice(pStopFrom).some((m) => m.type === "verdict"), false);
    assert.equal(
      enRig.stage.msgs.slice(stStopFrom).some((m) => m.type === "checking" && m.phase === "end"),
      true,
    );
    assert.equal(s.toolResponses.length, toolResBeforeStop);
  } finally {
    enRig.cleanup();
  }

  for (const cfg of [
    {
      lang: "fi" as const,
      matchLead: "Oikea pakkaus.",
      warnLead: "Varoitus.",
      missingMatchSaid: "Iltal\u00e4\u00e4kkeesi on oikeanpuoleinen laatikko.",
      missingWarnSaid: "Iltal\u00e4\u00e4kkeesi on oikeanpuoleinen laatikko, poimi se.",
      validWarnSaid: "Varoitus. Iltal\u00e4\u00e4kkeesi on oikeanpuoleinen laatikko, mutta se on vanhentunut.",
    },
    {
      lang: "sv" as const,
      matchLead: "R\u00e4tt f\u00f6rpackning.",
      warnLead: "Varning.",
      missingMatchSaid: "Din kv\u00e4llsmedicin \u00e4r asken till h\u00f6ger.",
      missingWarnSaid: "Din kv\u00e4llsmedicin \u00e4r asken till h\u00f6ger, ta upp den.",
      validWarnSaid: "Varning. Din kv\u00e4llsmedicin \u00e4r asken till h\u00f6ger, men utg\u00e5ngen.",
    },
  ]) {
    const rig = makeSceneRig(`scene-${cfg.lang}`, { lang: cfg.lang, features: ["scene"] });
    try {
      (geminiMod.ai.models as any).generateContent = async (arg: GenArg) => {
        genCalls.push(arg);
        return { text: JSON.stringify(currentPayload), usageMetadata: {} };
      };
      await rig.proxy.start();
      const s = sessions.at(-1)!;
      rig.hub.ring.push({
        data: TINY_JPEG_B64,
        sharpness: 0.91,
        ts: Date.now(),
        bytes: TINY_JPEG_BUF.length,
        source: "phone",
      });

      currentPayload = matchScenePayload;
      let from = rig.phone.msgs.length;
      s.arg.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: `${cfg.lang}-m1`, name: "find_item", args: { target: "my evening pill" } }] },
      });
      await rig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", from);
      const vMatch = rig.phone.msgs
        .slice(from)
        .find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict")!.verdict;
      const outMatch = s.toolResponses.at(-1)!.functionResponses[0].response.output;
      assert.equal(outMatch.mode, "scene");
      assert.equal(outMatch.level, "match");
      assert.equal(outMatch.lead, cfg.matchLead);

      s.arg.callbacks.onmessage({
        serverContent: { outputTranscription: { text: cfg.missingMatchSaid }, turnComplete: true },
      });
      const corrAfterMatch = rig.phone.msgs.filter(
        (m): m is Extract<ServerMsg, { type: "correction" }> => m.type === "correction",
      );
      assert.equal(corrAfterMatch.length, 1);
      assert.deepEqual(corrAfterMatch[0], {
        type: "correction",
        speech: vMatch.speech,
        reasons: ["lead_missing"],
      });

      currentPayload = warnScenePayload;
      from = rig.phone.msgs.length;
      s.arg.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: `${cfg.lang}-w1`, name: "find_item", args: { target: "my evening pill" } }] },
      });
      await rig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", from);
      const vWarn = rig.phone.msgs
        .slice(from)
        .find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict")!.verdict;
      const outWarn = s.toolResponses.at(-1)!.functionResponses[0].response.output;
      assert.equal(outWarn.mode, "scene");
      assert.equal(outWarn.level, "warning");
      assert.equal(outWarn.lead, cfg.warnLead);

      s.arg.callbacks.onmessage({
        serverContent: { outputTranscription: { text: cfg.missingWarnSaid }, turnComplete: true },
      });
      const corrAfterWarn = rig.phone.msgs.filter(
        (m): m is Extract<ServerMsg, { type: "correction" }> => m.type === "correction",
      );
      assert.equal(corrAfterWarn.length, 2);
      assert.deepEqual(corrAfterWarn[1], {
        type: "correction",
        speech: vWarn.speech,
        reasons: ["lead_missing"],
      });

      from = rig.phone.msgs.length;
      s.arg.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: `${cfg.lang}-w2`, name: "find_item", args: { target: "my evening pill" } }] },
      });
      await rig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", from);
      s.arg.callbacks.onmessage({
        serverContent: { outputTranscription: { text: cfg.validWarnSaid }, turnComplete: true },
      });
      assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 2);
      assert.equal(rig.proxy.stats().verify?.source, "scene");
      assert.equal(rig.proxy.stats().verify?.level, "warning");
    } finally {
      rig.cleanup();
    }
  }
});

test("hygiene invariants: zero external fetches, zero unexpected Gemini calls, no workspace node_modules, and repo ledger untouched", () => {
  assert.equal(externalFetchCalls, 0);
  assert.equal(unexpectedGeminiCalls, 0);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(SERVER_DIR, "node_modules")), false);
  assert.deepEqual(snapshotFile(REPO_LEDGER_PATH), repoLedgerBefore);
});
