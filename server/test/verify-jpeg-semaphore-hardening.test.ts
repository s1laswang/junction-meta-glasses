import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai, classify, Semaphore, type ErrKind } from "../src/gemini.ts";
import { jpegSharpness, jpegSize, readLabel } from "../src/verify.ts";

type GeminiModule = typeof import("../src/gemini.ts");

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const tmpDir = fs.mkdtempSync(path.join(shmRoot, "holdup-jpeg-sem-harden-"));
const origLedgerPath = env.ledgerPath;
env.ledgerPath = path.join(tmpDir, "ledger.jsonl");

after(() => {
  env.ledgerPath = origLedgerPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function buildSofSegment(w: number, h: number, marker = 0xc0, fillCount = 1): Buffer {
  const fill = Buffer.alloc(fillCount, 0xff);
  const body = Buffer.alloc(12);
  body[0] = marker;
  body.writeUInt16BE(11, 1);
  body[3] = 8;
  body.writeUInt16BE(h, 4);
  body.writeUInt16BE(w, 6);
  body[8] = 1;
  return Buffer.concat([fill, body]);
}

let geminiImportSeq = 0;
async function importFreshGemini(maxConc: string | undefined): Promise<GeminiModule> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "GEMINI_MAX_CONCURRENCY");
  const prev = process.env.GEMINI_MAX_CONCURRENCY;
  try {
    if (maxConc === undefined) delete process.env.GEMINI_MAX_CONCURRENCY;
    else process.env.GEMINI_MAX_CONCURRENCY = maxConc;
    geminiImportSeq++;
    const spec = new URL(`../src/gemini.ts?fresh=${geminiImportSeq}`, import.meta.url).href;
    return (await import(spec)) as GeminiModule;
  } finally {
    if (!had || prev === undefined) delete process.env.GEMINI_MAX_CONCURRENCY;
    else process.env.GEMINI_MAX_CONCURRENCY = prev;
  }
}

async function measureGateCap(sem: Semaphore, probeCount = 10): Promise<number> {
  const release = deferred<void>();
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: probeCount }, () =>
    sem.run(async () => {
      active++;
      if (active > peak) peak = active;
      await release.promise;
      active--;
    }),
  );
  await flushMicrotasks(8);
  const observed = active;
  release.resolve();
  await Promise.all(jobs);
  assert.equal(active, 0);
  assert.equal(peak, observed);
  return observed;
}

test("jpegSize returns exact dimensions for all server/fixtures JPEGs and handles repeated 0xff fill bytes", () => {
  const expected: Record<string, { w: number; h: number }> = {
    "amlodipine.jpg": { w: 768, h: 768 },
    "amlodipine_covered.jpg": { w: 768, h: 768 },
    "dm_amlodipine.jpg": { w: 660, h: 100 },
    "three_boxes.jpg": { w: 768, h: 768 },
  };
  const files = fs.readdirSync(path.join(SERVER_DIR, "fixtures")).filter((f) => f.endsWith(".jpg")).sort();
  assert.deepEqual(files, Object.keys(expected).sort());

  for (const file of files) {
    const buf = fs.readFileSync(path.join(SERVER_DIR, "fixtures", file));
    assert.deepEqual(jpegSize(buf), expected[file], file);
    const sharp = jpegSharpness(buf);
    assert.ok(sharp > 0 && sharp <= 1, `unexpected sharpness ${sharp} for ${file}`);
  }

  const app0WithFill = Buffer.from([0xff, 0xff, 0xff, 0xe0, 0x00, 0x04, 0xaa, 0xbb]);
  const sofWithLongFill = buildSofSegment(1024, 576, 0xc2, 20);
  const padded = Buffer.concat([Buffer.from([0xff, 0xd8]), app0WithFill, sofWithLongFill]);
  assert.deepEqual(jpegSize(padded), { w: 1024, h: 576 });

  const trailingFillEof = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(jpegSize(trailingFillEof), undefined);
});

test("jpegSize skips standalone markers without length fields and stops immediately at EOI (0xd9) or SOS (0xda)", () => {
  const standalonePrefix = Buffer.from([
    0xff, 0xd8,
    0xff, 0x00,
    0xff, 0x01,
    0xff, 0xd0,
    0xff, 0xd1,
    0xff, 0xd2,
    0xff, 0xd3,
    0xff, 0xd4,
    0xff, 0xd5,
    0xff, 0xd6,
    0xff, 0xd7,
    0xff, 0xd8,
    0xff, 0xff, 0x01,
  ]);
  const withStandalones = Buffer.concat([standalonePrefix, buildSofSegment(640, 360, 0xc0)]);
  assert.deepEqual(jpegSize(withStandalones), { w: 640, h: 360 });

  const eoiBeforeFakeSof = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    buildSofSegment(999, 888, 0xc0),
  ]);
  assert.equal(jpegSize(eoiBeforeFakeSof), undefined);

  const sosBeforeEntropyFakeSof = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    buildSofSegment(777, 555, 0xc0),
  ]);
  assert.equal(jpegSize(sosBeforeEntropyFakeSof), undefined);
});

test("jpegSize rejects malformed len < 2 segments without looping and enforces strict bounds on all SOF markers", () => {
  const zeroLenSegment = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
    buildSofSegment(400, 300, 0xc0),
  ]);
  assert.equal(jpegSize(zeroLenSegment), undefined);

  const oneLenSegment = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]),
    buildSofSegment(400, 300, 0xc0),
  ]);
  assert.equal(jpegSize(oneLenSegment), undefined);

  for (const shortLen of [0, 1, 2, 3]) {
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0].slice(0, shortLen))), undefined);
  }
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), undefined);

  for (const badSofLen of [2, 3, 4, 5, 6, 7]) {
    const badSof = Buffer.alloc(14);
    badSof[0] = 0xff;
    badSof[1] = 0xd8;
    badSof[2] = 0xff;
    badSof[3] = 0xc0;
    badSof.writeUInt16BE(badSofLen, 4);
    badSof[6] = 8;
    badSof.writeUInt16BE(240, 7);
    badSof.writeUInt16BE(320, 9);
    assert.equal(jpegSize(badSof), undefined);
  }

  for (const sofMarker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    const nonSofPrefix = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x03, 0x00,
      0xff, 0xc8, 0x00, 0x02,
      0xff, 0xcc, 0x00, 0x03, 0x00,
    ]);
    const valid = Buffer.concat([nonSofPrefix, buildSofSegment(512, 384, sofMarker)]);
    assert.deepEqual(jpegSize(valid), { w: 512, h: 384 }, `marker 0x${sofMarker.toString(16)}`);
  }
});

test("Semaphore clamps non-positive, non-finite, and fractional capacities without deadlocking or leaking extra slots", async () => {
  const invalidCaps = [0, -1, -100, 0.4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const bad of invalidCaps) {
    const sem = new Semaphore(bad);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const g0 = deferred<void>();
    const started0 = deferred<void>();

    const p0 = sem.run(async () => {
      active++;
      if (active > peak) peak = active;
      order.push(0);
      started0.resolve();
      await g0.promise;
      active--;
      return "first";
    });

    await started0.promise;
    const p1 = sem.run(async () => {
      active++;
      if (active > peak) peak = active;
      order.push(1);
      await flushMicrotasks(2);
      active--;
      return "second";
    });

    await flushMicrotasks();
    assert.deepEqual(order, [0], `cap=${String(bad)}`);
    g0.resolve();

    const out = await Promise.all([p0, p1]);
    assert.deepEqual(out, ["first", "second"]);
    assert.deepEqual(order, [0, 1]);
    assert.equal(peak, 1);
  }

  const fractional = new Semaphore(2.9);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const entered = [deferred<void>(), deferred<void>(), deferred<void>()];
  let fracActive = 0;
  let fracPeak = 0;
  const tasks = gates.map((g, idx) =>
    fractional.run(async () => {
      fracActive++;
      if (fracActive > fracPeak) fracPeak = fracActive;
      entered[idx].resolve();
      await g.promise;
      fracActive--;
      return idx;
    }),
  );

  await Promise.all([entered[0].promise, entered[1].promise]);
  await flushMicrotasks();
  assert.equal(fracActive, 2);
  assert.equal(fracPeak, 2);
  gates[0].resolve();
  await entered[2].promise;
  assert.equal(fracActive, 2);
  assert.equal(fracPeak, 2);
  gates[1].resolve();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2]);
});

test("unaryGate defaults GEMINI_MAX_CONCURRENCY to 4 on empty or invalid env values and honors valid positive integers", async () => {
  for (const fallbackVal of [undefined, "", "   ", "0", "-4", "NaN", "Infinity", "invalid", "0.5"]) {
    const mod = await importFreshGemini(fallbackVal);
    const peak = await measureGateCap(mod.unaryGate, 7);
    assert.equal(peak, 4, `expected cap 4 for GEMINI_MAX_CONCURRENCY=${JSON.stringify(fallbackVal)}`);
  }

  const mod1 = await importFreshGemini("1");
  assert.equal(await measureGateCap(mod1.unaryGate, 4), 1);

  const mod3 = await importFreshGemini(" 3 ");
  assert.equal(await measureGateCap(mod3.unaryGate, 6), 3);

  const mod5 = await importFreshGemini("5.8");
  assert.equal(await measureGateCap(mod5.unaryGate, 8), 5);
});

test("classify maps HTTP 408 and ETIMEDOUT / ECONNABORTED / UND_ERR_CONNECT_TIMEOUT causes to timeout and retries primary in readLabel", async () => {
  const timeoutSamples: unknown[] = [
    { status: 408, message: "idle gateway closed request" },
    { code: 408, message: "upstream 408" },
    new Error("HTTP 408 from proxy"),
    { code: "ETIMEDOUT", message: "socket stall on read" },
    { code: "ECONNABORTED", message: "connection closed mid-stream" },
    { code: "UND_ERR_CONNECT_TIMEOUT", message: "connect failed" },
    { code: "UND_ERR_HEADERS_TIMEOUT", message: "headers delayed" },
    { code: "UND_ERR_BODY_TIMEOUT", message: "body delayed" },
    new Error("connect ETIMEDOUT 142.250.74.10:443"),
    new Error("UND_ERR_CONNECT_TIMEOUT dialing v1beta"),
    new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Failure" } }),
    new TypeError("fetch failed", { cause: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }),
    new TypeError("fetch failed", { cause: { code: "ECONNABORTED", message: "aborted" } }),
    new TypeError("fetch failed", { cause: { name: "AbortError", message: "signal canceled" } }),
  ];

  for (const sample of timeoutSamples) {
    assert.equal(classify(sample), "timeout" satisfies ErrKind);
  }

  assert.equal(classify(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), "network");
  assert.equal(classify({ status: 401, message: "UNAUTHENTICATED" }), "network");
  assert.equal(classify({ status: 403, message: "PERMISSION_DENIED" }), "network");

  const prevQuiet = process.env.HOLDUP_QUIET;
  const origGen = ai.models.generateContent;
  process.env.HOLDUP_QUIET = "1";
  try {
    const modelsCalled: string[] = [];
    let callIdx = 0;
    ai.models.generateContent = (async (req: { model: string }) => {
      modelsCalled.push(req.model);
      callIdx++;
      if (callIdx === 1) {
        throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Failure" } });
      }
      return {
        text: JSON.stringify({
          kind: "medication",
          product: { value: "Norvasc", confidence: 0.95 },
          ingredient: { value: "amlodipine", confidence: 0.94 },
          strength: { value: "5 mg", confidence: 0.93 },
          dosing: { value: null, confidence: 0 },
          expiry: { value: "2027-08", confidence: 0.9 },
          allergens: { value: null, confidence: 0 },
          barcode: { value: null, confidence: 0 },
          readability: 0.91,
        }),
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 },
      };
    }) as unknown as typeof ai.models.generateContent;

    const r = await readLabel(["ZmFrZS1qcGVn"]);
    assert.equal(r.attempts, 2);
    assert.equal(r.model, env.verifyModels[0]);
    assert.deepEqual(modelsCalled, [env.verifyModels[0], env.verifyModels[0]]);
    assert.equal(r.read.ingredient.value, "amlodipine");
  } finally {
    ai.models.generateContent = origGen;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }
});
