import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { startServer } from "../src/index.ts";
import { type LedgerLine } from "../src/ledger.ts";
import { SPEC, Speculator } from "../src/speculate.ts";
import { FrameRing, readLabel, type Frame } from "../src/verify.ts";

const tmpRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const origEnv = {
  ledgerPath: env.ledgerPath,
  verifyModels: [...env.verifyModels],
  verifyTimeoutMs: env.verifyTimeoutMs,
};
const origSpec = { ...SPEC };
const origGenerateContent = ai.models.generateContent;
const origQuiet = process.env.HOLDUP_QUIET;
const origKey = process.env.HOLDUP_KEY;
process.env.HOLDUP_QUIET = "1";

const tempDirs: string[] = [];

function useTempLedger(tag: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `holdup-f4-spec-${tag}-`));
  tempDirs.push(dir);
  const file = path.join(dir, "ledger.jsonl");
  env.ledgerPath = file;
  return file;
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    data: "ZmFrZS1qcGVnLWZyYW1l",
    sharpness: 0.5,
    ts: 1000,
    bytes: 1000,
    source: "phone",
    ...overrides,
  };
}

const validLabelPayload = {
  kind: "medication",
  product: { value: "Norvasc", confidence: 0.96 },
  ingredient: { value: "amlodipine", confidence: 0.95 },
  strength: { value: "5 mg", confidence: 0.94 },
  dosing: { value: "Once daily", confidence: 0.88 },
  expiry: { value: "2027-08", confidence: 0.91 },
  allergens: { value: null, confidence: 0 },
  barcode: { value: "6432100012345", confidence: 0.89 },
  readability: 0.92,
};

function modelReply(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({ ...validLabelPayload, ...overrides }),
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 45,
      thoughtsTokenCount: 10,
      cachedContentTokenCount: 0,
    },
  };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

async function waitForLedgerLines(filePath: string, minLines: number, maxTicks = 400): Promise<LedgerLine[]> {
  for (let i = 0; i < maxTicks; i++) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length >= minLines) {
        return lines.map((line) => JSON.parse(line) as LedgerLine);
      }
    } catch {
      void 0;
    }
    await nextTick();
  }
  const finalRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const finalLines = finalRaw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerLine);
  assert.ok(
    finalLines.length >= minLines,
    `Expected at least ${minLines} ledger lines in ${filePath}, found ${finalLines.length}`,
  );
  return finalLines;
}

function getJson(port: number, routePath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: routePath, method: "GET", headers: { connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function restoreGlobals(): void {
  env.ledgerPath = origEnv.ledgerPath;
  env.verifyModels = [...origEnv.verifyModels];
  env.verifyTimeoutMs = origEnv.verifyTimeoutMs;
  Object.assign(SPEC, origSpec);
  ai.models.generateContent = origGenerateContent;
  process.env.HOLDUP_QUIET = "1";
  if (origKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origKey;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  restoreGlobals();
});

after(() => {
  restoreGlobals();
  if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = origQuiet;
});

test("SPEC.sceneDelta (0.12) cliff: <= 0.12 keeps cache usable up to 10,000ms while > 0.12 expires cache at 2500ms", async (t) => {
  useTempLedger("scene-delta");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });

  let product = "Norvasc";
  let calls = 0;
  ai.models.generateContent = (async () => {
    calls++;
    return modelReply({ product: { value: product, confidence: 0.96 } });
  }) as any;

  try {
    const ringStable = new FrameRing(8);
    const specStable = new Speculator(ringStable, () => true);

    const f0 = makeFrame({ ts: 100_000, bytes: 1000, sharpness: 0.5 });
    ringStable.push(f0);
    specStable.onFrame(f0);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 1);

    t.mock.timers.tick(650);
    const fUpExact = makeFrame({ ts: Date.now(), bytes: 1120, sharpness: 0.5 });
    ringStable.push(fUpExact);
    specStable.onFrame(fUpExact);

    t.mock.timers.tick(500);
    const fDownExact = makeFrame({ ts: Date.now(), bytes: 880, sharpness: 0.5 });
    ringStable.push(fDownExact);
    specStable.onFrame(fDownExact);

    t.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal(calls, 1);
    assert.equal(Date.now() - f0.ts, SPEC.freshMs);
    assert.equal((await specStable.get())?.source, "cache");

    t.mock.timers.tick(SPEC.stableMs - SPEC.freshMs - 1);
    assert.equal(Date.now() - f0.ts, SPEC.stableMs - 1);
    assert.equal((await specStable.get())?.source, "cache");

    t.mock.timers.tick(1);
    assert.equal(Date.now() - f0.ts, SPEC.stableMs);
    assert.equal(await specStable.get(), undefined);

    const baseTs = Date.now();
    const ringChanged = new FrameRing(8);
    const specChanged = new Speculator(ringChanged, () => true);

    const c0 = makeFrame({ ts: baseTs, bytes: 1000, sharpness: 0.5 });
    ringChanged.push(c0);
    specChanged.onFrame(c0);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 2);

    t.mock.timers.tick(2050);
    assert.equal(Date.now() - baseTs, 2400);
    product = "Metformin";
    const cOverCliff = makeFrame({ ts: Date.now(), bytes: 1121, sharpness: 0.5 });
    ringChanged.push(cOverCliff);
    specChanged.onFrame(cOverCliff);

    t.mock.timers.tick(99);
    assert.equal(Date.now() - baseTs, SPEC.freshMs - 1);
    const stillFresh = await specChanged.get();
    assert.equal(stillFresh?.source, "cache");
    assert.equal(stillFresh?.read.product.value, "Norvasc");

    t.mock.timers.tick(1);
    assert.equal(Date.now() - baseTs, SPEC.freshMs);
    assert.equal(await specChanged.get(), undefined);

    t.mock.timers.tick(300);
    await flushMicrotasks();
    assert.equal(calls, 3);
    const refreshed = await specChanged.get();
    assert.equal(refreshed?.source, "cache");
    assert.equal(refreshed?.read.product.value, "Metformin");

    const baseShrinkTs = Date.now();
    const ringShrink = new FrameRing(8);
    const specShrink = new Speculator(ringShrink, () => true);
    const s0 = makeFrame({ ts: baseShrinkTs, bytes: 1000, sharpness: 0.5 });
    ringShrink.push(s0);
    specShrink.onFrame(s0);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 4);

    t.mock.timers.tick(2050);
    const sUnderCliff = makeFrame({ ts: Date.now(), bytes: 879, sharpness: 0.5 });
    ringShrink.push(sUnderCliff);
    specShrink.onFrame(sUnderCliff);
    t.mock.timers.tick(100);
    assert.equal(Date.now() - baseShrinkTs, SPEC.freshMs);
    assert.equal(await specShrink.get(), undefined);
  } finally {
    t.mock.timers.reset();
  }
});

test("SPEC.minReadability (0.6), SPEC.minSharpness (0.15), and sharpness +0.05 re-trigger cliffs", async (t) => {
  useTempLedger("readability-sharpness-cliffs");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200_000 });

  let readability = 0.599;
  let product = "WeakBox";
  let calls = 0;
  ai.models.generateContent = (async () => {
    calls++;
    return modelReply({ readability, product: { value: product, confidence: 0.95 } });
  }) as any;

  try {
    const ring = new FrameRing(8);
    const spec = new Speculator(ring, () => true);

    const belowSharp = makeFrame({ ts: Date.now(), sharpness: 0.149, bytes: 1000 });
    ring.push(belowSharp);
    spec.onFrame(belowSharp);
    t.mock.timers.tick(SPEC.debounceMs + 100);
    await flushMicrotasks();
    assert.equal(calls, 0);

    ring.clear();
    const exactMinSharp = makeFrame({ ts: Date.now(), sharpness: 0.15, bytes: 1000 });
    ring.push(exactMinSharp);
    spec.onFrame(exactMinSharp);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 1);

    assert.equal(await spec.get(), undefined);
    assert.equal(spec.hits, 0);
    assert.equal(spec.misses, 1);

    readability = 0.6;
    product = "AcceptedAtCliff";
    const retriggerFromWeak = makeFrame({ ts: Date.now(), sharpness: 0.15, bytes: 1000 });
    ring.push(retriggerFromWeak);
    spec.onFrame(retriggerFromWeak);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 2);

    const accepted = await spec.get();
    assert.equal(accepted?.source, "cache");
    assert.equal(accepted?.read.product.value, "AcceptedAtCliff");
    assert.equal(accepted?.read.readability, 0.6);
    assert.equal(spec.hits, 1);

    const steadyAtCliff = makeFrame({ ts: Date.now(), sharpness: 0.15, bytes: 1000 });
    ring.push(steadyAtCliff);
    spec.onFrame(steadyAtCliff);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 2);

    const ringSharp = new FrameRing(8);
    const specSharp = new Speculator(ringSharp, () => true);
    readability = 0.9;
    product = "BaseSharp";

    const baseFrame = makeFrame({ ts: Date.now(), sharpness: 0.5, bytes: 1000 });
    ringSharp.push(baseFrame);
    specSharp.onFrame(baseFrame);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 3);

    product = "ShouldNotTrigger049";
    const plus049 = makeFrame({ ts: Date.now(), sharpness: 0.549, bytes: 1000 });
    ringSharp.push(plus049);
    specSharp.onFrame(plus049);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 3);
    assert.equal((await specSharp.get())?.read.product.value, "BaseSharp");

    product = "ShouldNotTrigger050";
    const plus050 = makeFrame({ ts: Date.now(), sharpness: 0.5 + 0.05, bytes: 1000 });
    ringSharp.push(plus050);
    specSharp.onFrame(plus050);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 3);

    product = "TriggeredAt051";
    const plus051 = makeFrame({ ts: Date.now(), sharpness: 0.551, bytes: 1000 });
    ringSharp.push(plus051);
    specSharp.onFrame(plus051);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(calls, 4);
    assert.equal((await specSharp.get())?.read.product.value, "TriggeredAt051");
  } finally {
    t.mock.timers.reset();
  }
});

test("Speculator.kick() preserves existing valid cached read when reader fails across all verifyModels (r.model === null)", async (t) => {
  useTempLedger("reader-failure-preserve");
  env.verifyModels = ["model-primary", "model-fallback"];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 300_000 });

  let failAll = false;
  let product = "Norvasc";
  const attemptedModels: string[] = [];

  ai.models.generateContent = (async (req: any) => {
    attemptedModels.push(req.model);
    if (failAll) {
      throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
    }
    return modelReply({ product: { value: product, confidence: 0.97 } });
  }) as any;

  try {
    const ring = new FrameRing(8);
    const spec = new Speculator(ring, () => true);

    const f1 = makeFrame({ ts: Date.now(), sharpness: 0.45, bytes: 1000 });
    ring.push(f1);
    spec.onFrame(f1);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.deepEqual(attemptedModels, ["model-primary"]);

    const initialHit = await spec.get();
    assert.equal(initialHit?.source, "cache");
    assert.equal(initialHit?.model, "model-primary");
    assert.equal(initialHit?.read.product.value, "Norvasc");

    failAll = true;
    t.mock.timers.tick(500);
    const fSharper = makeFrame({ ts: Date.now(), sharpness: 0.75, bytes: 1000 });
    ring.push(fSharper);
    spec.onFrame(fSharper);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks(12);

    assert.deepEqual(attemptedModels, [
      "model-primary",
      "model-primary",
      "model-primary",
      "model-fallback",
    ]);

    const preservedHit = await spec.get();
    assert.equal(preservedHit?.source, "cache");
    assert.equal(preservedHit?.model, "model-primary");
    assert.equal(preservedHit?.read.product.value, "Norvasc");
    assert.equal(preservedHit?.read.kind, "medication");

    failAll = false;
    product = "RecoveredMed";
    const fRecover = makeFrame({ ts: Date.now(), sharpness: 0.9, bytes: 1000 });
    ring.push(fRecover);
    spec.onFrame(fRecover);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();

    const recoveredHit = await spec.get();
    assert.equal(recoveredHit?.source, "cache");
    assert.equal(recoveredHit?.read.product.value, "RecoveredMed");
  } finally {
    t.mock.timers.reset();
  }
});

test("Speculator.kick() out-of-order frameTs guard prevents older reads from overwriting newer cached reads", async (t) => {
  useTempLedger("out-of-order-guard");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 400_000 });

  const resolvers: Array<(val: any) => void> = [];
  ai.models.generateContent = (() =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    })) as any;

  try {
    const ring = new FrameRing(8);
    const spec = new Speculator(ring, () => true);

    const slowOldFrame = makeFrame({ ts: 400_000, sharpness: 0.5, bytes: 1000, data: "old-frame" });
    ring.push(slowOldFrame);
    spec.onFrame(slowOldFrame);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 1);

    spec.clear();
    ring.clear();

    t.mock.timers.tick(2500);
    const fastNewFrame = makeFrame({ ts: Date.now(), sharpness: 0.8, bytes: 1500, data: "new-frame" });
    ring.push(fastNewFrame);
    spec.onFrame(fastNewFrame);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 2);

    resolvers[1](modelReply({ product: { value: "NewerCachedMed", confidence: 0.98 } }));
    await flushMicrotasks();
    assert.equal((await spec.get())?.read.product.value, "NewerCachedMed");

    resolvers[0](modelReply({ product: { value: "OrphanedOlderMed", confidence: 0.98 } }));
    await flushMicrotasks();
    assert.equal((await spec.get())?.read.product.value, "NewerCachedMed");

    ring.clear();
    const delayedOutOfOrderFrame = makeFrame({
      ts: fastNewFrame.ts - 500,
      sharpness: 0.95,
      bytes: 1500,
      data: "delayed-frame",
    });
    ring.push(delayedOutOfOrderFrame);
    spec.onFrame(delayedOutOfOrderFrame);
    t.mock.timers.tick(SPEC.minGapMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 3);

    resolvers[2](modelReply({ product: { value: "DelayedOutOfOrderMed", confidence: 0.98 } }));
    await flushMicrotasks();

    t.mock.timers.tick(3000);
    assert.ok(Date.now() - fastNewFrame.ts > SPEC.freshMs);
    assert.ok(Date.now() - fastNewFrame.ts < SPEC.stableMs);
    const afterDelayed = await spec.get();
    assert.equal(afterDelayed?.source, "cache");
    assert.equal(afterDelayed?.read.product.value, "NewerCachedMed");

    ring.clear();
    const freshSceneBaseTs = Date.now();
    const freshSceneFrame = makeFrame({
      ts: freshSceneBaseTs,
      sharpness: 0.98,
      bytes: 2500,
      data: "fresh-scene-frame",
    });
    ring.push(freshSceneFrame);
    spec.onFrame(freshSceneFrame);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 4);
    resolvers[3](modelReply({ product: { value: "LatestSceneMed", confidence: 0.99 } }));
    await flushMicrotasks();

    ring.clear();
    const outOfOrderChangedScene = makeFrame({
      ts: freshSceneBaseTs - 200,
      sharpness: 0.99,
      bytes: 4000,
      data: "ooo-changed-scene",
    });
    ring.push(outOfOrderChangedScene);
    spec.onFrame(outOfOrderChangedScene);
    t.mock.timers.tick(SPEC.minGapMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 5);
    resolvers[4](modelReply({ product: { value: "StaleChangedMed", confidence: 0.99 } }));
    await flushMicrotasks();

    assert.equal(Date.now() - freshSceneBaseTs, 2350);
    const beforeFreshCliff = await spec.get();
    assert.equal(beforeFreshCliff?.source, "cache");
    assert.equal(beforeFreshCliff?.read.product.value, "LatestSceneMed");

    t.mock.timers.tick(150);
    assert.equal(Date.now() - freshSceneBaseTs, SPEC.freshMs);
    assert.equal(await spec.get(), undefined);
  } finally {
    for (const r of resolvers) r(modelReply());
    t.mock.timers.reset();
  }
});

test("Speculator.get(maxWaitMs) skips stale inflight at >= SPEC.stableMs and records hits/misses plus verify_cache stats", async (t) => {
  const ledgerFile = useTempLedger("inflight-skip-and-stats");
  delete process.env.HOLDUP_KEY;
  env.verifyModels = ["gemini-3.8-flash"];

  const pendingResolvers: Array<(val: any) => void> = [];
  ai.models.generateContent = (() =>
    new Promise((resolve) => {
      pendingResolvers.push(resolve);
    })) as any;

  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 500_000 });
  const ring = new FrameRing(8);
  const spec = new Speculator(ring, () => true);

  try {
    const missEmpty = await spec.get(50);
    assert.equal(missEmpty, undefined);
    assert.equal(spec.hits, 0);
    assert.equal(spec.misses, 1);
    await waitForLedgerLines(ledgerFile, 1);

    const f1 = makeFrame({ ts: 500_000, sharpness: 0.6, bytes: 1000 });
    ring.push(f1);
    spec.onFrame(f1);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(pendingResolvers.length, 1);

    t.mock.timers.tick(SPEC.stableMs - SPEC.debounceMs - 1);
    assert.equal(Date.now() - f1.ts, SPEC.stableMs - 1);

    const inflightPromise = spec.get(500);
    t.mock.timers.tick(40);
    pendingResolvers[0](modelReply({ product: { value: "InflightMed", confidence: 0.95 } }));
    const inflightHit = await inflightPromise;
    assert.equal(inflightHit?.source, "inflight");
    assert.equal(inflightHit?.model, "gemini-3.8-flash");
    assert.equal(inflightHit?.read.product.value, "InflightMed");
    assert.equal(spec.hits, 1);
    assert.equal(spec.misses, 1);
    await waitForLedgerLines(ledgerFile, 3);

    t.mock.timers.tick(3000);
    const f2Ts = Date.now();
    const f2 = makeFrame({ ts: f2Ts, sharpness: 0.8, bytes: 1400 });
    ring.push(f2);
    spec.onFrame(f2);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(pendingResolvers.length, 2);
    pendingResolvers[1](modelReply({ product: { value: "CachedMed", confidence: 0.96 } }));
    await flushMicrotasks();
    await waitForLedgerLines(ledgerFile, 4);

    t.mock.timers.tick(650);
    const cacheHit = await spec.get();
    assert.equal(cacheHit?.source, "cache");
    assert.equal(cacheHit?.model, "gemini-3.8-flash");
    assert.equal(cacheHit?.read.product.value, "CachedMed");
    assert.equal(spec.hits, 2);
    assert.equal(spec.misses, 1);
    await waitForLedgerLines(ledgerFile, 5);

    t.mock.timers.tick(SPEC.stableMs);
    const f3Ts = Date.now();
    const f3 = makeFrame({ ts: f3Ts, sharpness: 0.88, bytes: 2000 });
    ring.push(f3);
    spec.onFrame(f3);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(pendingResolvers.length, 3);

    t.mock.timers.tick(SPEC.stableMs - SPEC.debounceMs);
    assert.equal(Date.now() - f3Ts, SPEC.stableMs);

    const tBeforeSkip = Date.now();
    const skippedAtExactCliff = await spec.get(8000);
    assert.equal(skippedAtExactCliff, undefined);
    assert.equal(Date.now(), tBeforeSkip);
    assert.equal(spec.hits, 2);
    assert.equal(spec.misses, 2);
    await waitForLedgerLines(ledgerFile, 6);

    t.mock.timers.tick(2500);
    assert.ok(Date.now() - f3Ts > SPEC.stableMs);
    const skippedPastCliff = await spec.get(8000);
    assert.equal(skippedPastCliff, undefined);
    assert.equal(spec.hits, 2);
    assert.equal(spec.misses, 3);
    await waitForLedgerLines(ledgerFile, 7);

    pendingResolvers[2](modelReply());
    await flushMicrotasks();
    await waitForLedgerLines(ledgerFile, 8);
  } finally {
    for (const r of pendingResolvers) r(modelReply());
    t.mock.timers.reset();
  }

  const lines = await waitForLedgerLines(ledgerFile, 8);
  const cacheLines = lines.filter((l) => l.feature === "verify_cache");
  assert.equal(cacheLines.length, 5);
  assert.deepEqual(
    cacheLines.map((l) => l.source),
    ["miss", "inflight", "cache", "miss", "miss"],
  );
  assert.deepEqual(
    cacheLines.map((l) => l.ok),
    [false, true, true, false, false],
  );
  assert.equal(cacheLines[1].latency_s, 0.04);
  assert.equal(cacheLines[2].latency_s, 0);
  assert.equal(cacheLines[2].age_s, 1);
  assert.equal(cacheLines[3].latency_s, 0);

  const server = await startServer(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await getJson(port, "/api/stats");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.features.verify_cache, {
      calls: 5,
      ok: 2,
      errors: 3,
      latency_p50_s: 0.04,
      latency_p95_s: 0.04,
      tokens_in: 0,
      tokens_out: 0,
      tokens_thinking: 0,
      models: {
        "gemini-3.8-flash": 2,
        none: 3,
      },
    });
  } finally {
    await closeServer(server);
  }
});

test("readLabel(): SyntaxError classifies as bad_json, retries primary once on mi === 0, and stops at 4-attempt ceiling", async () => {
  const ledgerFile = useTempLedger("bad-json-ceiling");
  env.verifyModels = ["m-primary", "m-fb1", "m-fb2", "m-fb3", "m-fb4"];

  const seenModels: string[] = [];
  const truncatedOutputs = [
    '{"kind":"medication","product":{"value":"Norv',
    "{malformed-primary-retry",
    '{"kind":"medication","strength":',
    "<<<not-json>>>",
    '{"never":"reached"}',
  ];

  ai.models.generateContent = (async (req: any) => {
    const idx = seenModels.length;
    if (idx > 0) await waitForLedgerLines(ledgerFile, idx);
    seenModels.push(req.model);
    return { text: truncatedOutputs[idx], usageMetadata: {} };
  }) as any;

  const exhausted = await readLabel(["frame-b64"], "What pill is this?", "verify");
  assert.equal(exhausted.model, null);
  assert.equal(exhausted.attempts, 4);
  assert.equal(exhausted.read.kind, "unreadable");
  assert.equal(exhausted.read.guidance, "I couldn't reach the reader. Try again in a moment.");
  assert.deepEqual(seenModels, ["m-primary", "m-primary", "m-fb1", "m-fb2"]);

  const lines = await waitForLedgerLines(ledgerFile, 4);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((l) => ({ model: l.model, ok: l.ok, error: l.error })),
    [
      { model: "m-primary", ok: false, error: "bad_json" },
      { model: "m-primary", ok: false, error: "bad_json" },
      { model: "m-fb1", ok: false, error: "bad_json" },
      { model: "m-fb2", ok: false, error: "bad_json" },
    ],
  );

  const recoveryModels: string[] = [];
  ai.models.generateContent = (async (req: any) => {
    recoveryModels.push(req.model);
    if (recoveryModels.length <= 2) {
      return { text: '{"truncated":', usageMetadata: {} };
    }
    return modelReply({ product: { value: "FallbackSuccess", confidence: 0.95 } });
  }) as any;

  const recovered = await readLabel(["frame-b64"], undefined, "verify");
  assert.equal(recovered.model, "m-fb1");
  assert.equal(recovered.attempts, 3);
  assert.equal(recovered.read.product.value, "FallbackSuccess");
  assert.deepEqual(recoveryModels, ["m-primary", "m-primary", "m-fb1"]);

  const nonTransientModels: string[] = [];
  ai.models.generateContent = (async (req: any) => {
    nonTransientModels.push(req.model);
    if (nonTransientModels.length === 1) {
      throw Object.assign(new Error("404 model not found"), { status: 404 });
    }
    return modelReply({ product: { value: "ImmediateFallback", confidence: 0.94 } });
  }) as any;

  const nonTransient = await readLabel(["frame-b64"]);
  assert.equal(nonTransient.model, "m-fb1");
  assert.equal(nonTransient.attempts, 2);
  assert.deepEqual(nonTransientModels, ["m-primary", "m-fb1"]);
});

test("readLabel(): AbortController aborts at env.verifyTimeoutMs and falls back cleanly without hanging", async (t) => {
  const ledgerFile = useTempLedger("abort-timeout");
  env.verifyModels = ["m-hanging-primary", "m-healthy-fallback"];
  env.verifyTimeoutMs = 200;

  const capturedSignals: AbortSignal[] = [];
  const seenModels: string[] = [];

  ai.models.generateContent = ((req: any) => {
    const sig: AbortSignal | undefined = req.config?.abortSignal;
    assert.ok(sig instanceof AbortSignal);
    const idx = seenModels.length;
    capturedSignals.push(sig);
    seenModels.push(req.model);

    if (req.model === "m-hanging-primary") {
      return new Promise((_, reject) => {
        sig.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    }
    return (async () => {
      if (idx > 0) await waitForLedgerLines(ledgerFile, idx);
      return modelReply({ product: { value: "HealthyFallbackMed", confidence: 0.97 } });
    })();
  }) as any;

  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 600_000 });
  try {
    const readPromise = readLabel(["frame-1"], "Check dose", "verify");
    await flushMicrotasks();
    assert.equal(capturedSignals.length, 1);
    assert.equal(capturedSignals[0].aborted, false);

    t.mock.timers.tick(199);
    await flushMicrotasks();
    assert.equal(capturedSignals[0].aborted, false);
    assert.equal(capturedSignals.length, 1);

    t.mock.timers.tick(1);
    await flushMicrotasks();
    await waitForLedgerLines(ledgerFile, 1);
    assert.equal(capturedSignals[0].aborted, true);
    assert.equal(capturedSignals.length, 2);
    assert.equal(seenModels[1], "m-hanging-primary");
    assert.equal(capturedSignals[1].aborted, false);

    t.mock.timers.tick(199);
    await flushMicrotasks();
    assert.equal(capturedSignals[1].aborted, false);

    t.mock.timers.tick(1);
    const res = await readPromise;
    assert.equal(capturedSignals[1].aborted, true);
    assert.equal(capturedSignals.length, 3);
    assert.equal(capturedSignals[2].aborted, false);
    assert.equal(res.model, "m-healthy-fallback");
    assert.equal(res.attempts, 3);
    assert.equal(res.read.product.value, "HealthyFallbackMed");
    assert.deepEqual(seenModels, ["m-hanging-primary", "m-hanging-primary", "m-healthy-fallback"]);

    t.mock.timers.tick(5000);
    assert.equal(capturedSignals[2].aborted, false);
  } finally {
    t.mock.timers.reset();
  }

  const lines = await waitForLedgerLines(ledgerFile, 3);
  assert.deepEqual(
    lines.map((l) => ({ model: l.model, ok: l.ok, error: l.error ?? null })),
    [
      { model: "m-hanging-primary", ok: false, error: "timeout" },
      { model: "m-hanging-primary", ok: false, error: "timeout" },
      { model: "m-healthy-fallback", ok: true, error: null },
    ],
  );

  env.verifyTimeoutMs = 20;
  const realTimerModels: string[] = [];
  ai.models.generateContent = ((req: any) => {
    const sig: AbortSignal = req.config.abortSignal;
    realTimerModels.push(req.model);
    if (req.model === "m-hanging-primary") {
      return new Promise((_, reject) => {
        sig.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return Promise.resolve(modelReply({ product: { value: "RealTimerRecovered", confidence: 0.96 } }));
  }) as any;

  const realRes = await readLabel(["frame-real"]);
  assert.equal(realRes.model, "m-healthy-fallback");
  assert.equal(realRes.attempts, 3);
  assert.equal(realRes.read.product.value, "RealTimerRecovered");
  assert.deepEqual(realTimerModels, ["m-hanging-primary", "m-hanging-primary", "m-healthy-fallback"]);
});

test("Speculator concurrency: single-flight guard coalesces concurrent get() callers and counts unreadable inflight as miss", async (t) => {
  const ledgerFile = useTempLedger("concurrent-get-coalesce");
  env.verifyModels = ["gemini-3.8-flash"];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 700_000 });

  const resolvers: Array<(val: any) => void> = [];
  ai.models.generateContent = (() =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    })) as any;

  try {
    const ring = new FrameRing(8);
    const spec = new Speculator(ring, () => true);

    const f1 = makeFrame({ ts: 700_000, sharpness: 0.55, bytes: 1000 });
    ring.push(f1);
    spec.onFrame(f1);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 1);

    const burstFrame = makeFrame({ ts: Date.now(), sharpness: 0.92, bytes: 3000 });
    ring.push(burstFrame);
    spec.onFrame(burstFrame);
    t.mock.timers.tick(SPEC.minGapMs + SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 1);

    const callerFastTimeout = spec.get(50);
    const callerPatientA = spec.get(2000);
    const callerPatientB = spec.get(2000);

    t.mock.timers.tick(50);
    assert.equal(await callerFastTimeout, undefined);
    assert.equal(spec.hits, 0);
    assert.equal(spec.misses, 1);
    await waitForLedgerLines(ledgerFile, 1);

    t.mock.timers.tick(30);
    resolvers[0](modelReply({ product: { value: "SharedInflightMed", confidence: 0.96 } }));
    const [resA, resB] = await Promise.all([callerPatientA, callerPatientB]);
    assert.equal(resA?.source, "inflight");
    assert.equal(resB?.source, "inflight");
    assert.equal(resA?.read.product.value, "SharedInflightMed");
    assert.equal(resB?.read.product.value, "SharedInflightMed");
    assert.equal(spec.hits, 2);
    assert.equal(spec.misses, 1);
    await waitForLedgerLines(ledgerFile, 4);

    t.mock.timers.tick(SPEC.stableMs);
    const fUnreadable = makeFrame({ ts: Date.now(), sharpness: 0.96, bytes: 4500 });
    ring.push(fUnreadable);
    spec.onFrame(fUnreadable);
    t.mock.timers.tick(SPEC.debounceMs);
    await flushMicrotasks();
    assert.equal(resolvers.length, 2);

    const unreadableWaiter = spec.get(1000);
    t.mock.timers.tick(20);
    resolvers[1](modelReply({ kind: "unreadable", readability: 0.1 }));
    assert.equal(await unreadableWaiter, undefined);
    assert.equal(spec.hits, 2);
    assert.equal(spec.misses, 2);
    await waitForLedgerLines(ledgerFile, 6);
  } finally {
    for (const r of resolvers) r(modelReply());
    t.mock.timers.reset();
  }
});

