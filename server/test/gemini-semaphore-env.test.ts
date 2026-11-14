import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT, SERVER_DIR, env } from "../src/env.ts";
import { Semaphore, backoffMs, classify, sleep, unaryGate, type ErrKind } from "../src/gemini.ts";

type EnvModule = typeof import("../src/env.ts");

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

let envImportSeq = 0;
async function importFreshEnv(overrides: Record<string, string | undefined>): Promise<EnvModule> {
  const keys = Object.keys(overrides);
  const saved = new Map<string, string | undefined>();
  for (const k of keys) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envImportSeq++;
    const spec = new URL(`../src/env.ts?fresh=${envImportSeq}`, import.meta.url).href;
    return (await import(spec)) as EnvModule;
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("Semaphore enforces concurrency cap and forwards task return values", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const gates = Array.from({ length: 6 }, () => deferred<void>());
  const entered = Array.from({ length: 6 }, () => deferred<void>());

  const tasks = gates.map((g, idx) =>
    sem.run(async () => {
      active++;
      if (active > maxActive) maxActive = active;
      entered[idx].resolve();
      await g.promise;
      active--;
      return `result-${idx}`;
    }),
  );

  await Promise.all([entered[0].promise, entered[1].promise]);
  await flushMicrotasks();
  assert.equal(active, 2);
  assert.equal(maxActive, 2);

  gates[0].resolve();
  await entered[2].promise;
  assert.equal(active, 2);

  gates[1].resolve();
  await entered[3].promise;
  assert.equal(active, 2);

  gates[2].resolve();
  gates[3].resolve();
  await Promise.all([entered[4].promise, entered[5].promise]);
  assert.equal(active, 2);

  gates[4].resolve();
  gates[5].resolve();

  const results = await Promise.all(tasks);
  assert.equal(active, 0);
  assert.equal(maxActive, 2);
  assert.deepEqual(results, ["result-0", "result-1", "result-2", "result-3", "result-4", "result-5"]);

  const afterBatch = await Promise.all([sem.run(async () => 10), sem.run(async () => 20)]);
  assert.deepEqual(afterBatch, [10, 20]);
});

test("Semaphore wakes queued waiters strictly in FIFO order", async () => {
  const mutex = new Semaphore(1);
  const startOrder: number[] = [];
  const finishOrder: number[] = [];
  const holdFirst = deferred<void>();
  const firstStarted = deferred<void>();

  const p0 = mutex.run(async () => {
    startOrder.push(0);
    firstStarted.resolve();
    await holdFirst.promise;
    finishOrder.push(0);
  });

  await firstStarted.promise;

  const waiters = [1, 2, 3, 4].map((id) =>
    mutex.run(async () => {
      startOrder.push(id);
      await flushMicrotasks(2);
      finishOrder.push(id);
      return id;
    }),
  );

  await flushMicrotasks();
  assert.deepEqual(startOrder, [0]);

  holdFirst.resolve();
  const waiterValues = await Promise.all([p0, ...waiters]);
  assert.deepEqual(waiterValues.slice(1), [1, 2, 3, 4]);
  assert.deepEqual(startOrder, [0, 1, 2, 3, 4]);
  assert.deepEqual(finishOrder, [0, 1, 2, 3, 4]);

  const dual = new Semaphore(2);
  const dualWake: string[] = [];
  const gA = deferred<void>();
  const gB = deferred<void>();
  const gC = deferred<void>();
  const rA = deferred<void>();
  const rB = deferred<void>();
  const rC = deferred<void>();

  const tA = dual.run(async () => {
    dualWake.push("A");
    rA.resolve();
    await gA.promise;
  });
  const tB = dual.run(async () => {
    dualWake.push("B");
    rB.resolve();
    await gB.promise;
  });
  await Promise.all([rA.promise, rB.promise]);

  const tC = dual.run(async () => {
    dualWake.push("C");
    rC.resolve();
    await gC.promise;
  });
  const tD = dual.run(async () => {
    dualWake.push("D");
  });
  const tE = dual.run(async () => {
    dualWake.push("E");
  });

  await flushMicrotasks();
  assert.deepEqual(dualWake, ["A", "B"]);

  gB.resolve();
  await rC.promise;
  assert.deepEqual(dualWake, ["A", "B", "C"]);

  gA.resolve();
  gC.resolve();
  await Promise.all([tA, tB, tC, tD, tE]);
  assert.deepEqual(dualWake, ["A", "B", "C", "D", "E"]);
});

test("Semaphore releases slot in finally on both synchronous throws and async rejections", async () => {
  const sem = new Semaphore(1);
  const hold = deferred<void>();
  const started = deferred<void>();
  const wokeAfterThrow = deferred<string>();

  const failing = sem.run(async () => {
    started.resolve();
    await hold.promise;
    throw new Error("boom-with-waiter");
  });

  await started.promise;

  const queued = sem.run(async () => {
    wokeAfterThrow.resolve("woke");
    return "recovered";
  });

  hold.resolve();
  await assert.rejects(failing, { message: "boom-with-waiter" });
  assert.equal(await wokeAfterThrow.promise, "woke");
  assert.equal(await queued, "recovered");

  await assert.rejects(
    sem.run(() => {
      throw new Error("sync-boom-no-waiter");
    }),
    { message: "sync-boom-no-waiter" },
  );

  await assert.rejects(
    sem.run(() => Promise.reject(new Error("rejected-promise-no-waiter"))),
    { message: "rejected-promise-no-waiter" },
  );

  const afterErrors = await sem.run(async () => "slot-still-free");
  assert.equal(afterErrors, "slot-still-free");
});

test("unaryGate is a working Semaphore instance honoring GEMINI_MAX_CONCURRENCY", async () => {
  assert.ok(unaryGate instanceof Semaphore);
  const cap = Number(process.env.GEMINI_MAX_CONCURRENCY ?? 4);
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: cap + 3 }, (_, i) =>
    unaryGate.run(async () => {
      active++;
      if (active > peak) peak = active;
      await sleep(5);
      active--;
      return i;
    }),
  );
  const out = await Promise.all(jobs);
  assert.equal(peak, cap);
  assert.equal(out.length, cap + 3);
});

test("classify maps timeout errors via AbortError name and timeout messages", () => {
  const abortObj = { name: "AbortError", message: "The operation was aborted" };
  const abortNameOnly = { name: "AbortError", message: "opaque failure" };
  const domAbort = new DOMException("signal aborted", "AbortError");
  const timedOutErr = new Error("Request timed out after 8000ms");
  const timeoutWordErr = new Error("Upstream timeout waiting for headers");
  const abortMsgStr = "fetch aborted by caller";
  const abortBeats500 = { name: "AbortError", status: 500, message: "INTERNAL" };

  for (const sample of [abortObj, abortNameOnly, domAbort, timedOutErr, timeoutWordErr, abortMsgStr, abortBeats500]) {
    assert.equal(classify(sample), "timeout" satisfies ErrKind);
  }
});

test("classify maps quota, not_found, empty, bad_request, server, and network fallback", () => {
  const quotaCases: unknown[] = [
    { status: 429, message: "Too Many Requests" },
    { code: 429, message: "rate limit hit" },
    new Error("HTTP 429 from upstream"),
    new Error("RESOURCE_EXHAUSTED: token per minute quota exceeded"),
    new Error("Daily quota reached for project"),
  ];
  for (const c of quotaCases) assert.equal(classify(c), "quota");

  const notFoundCases: unknown[] = [
    { status: 404, message: "missing endpoint" },
    { code: 404, message: "missing model" },
    new Error("got 404 from v1beta models"),
    new Error("NOT_FOUND: models/gemini-legacy"),
    new Error("Model gemini-old is no longer available"),
  ];
  for (const c of notFoundCases) assert.equal(classify(c), "not_found");

  const emptyCases: unknown[] = [
    new Error("empty reply"),
    new Error("Candidate returned EMPTY REPLY payload"),
    "empty reply from model",
  ];
  for (const c of emptyCases) assert.equal(classify(c), "empty");

  const badRequestCases: unknown[] = [
    { status: 400, message: "malformed json" },
    { code: 400, message: "invalid field" },
    new Error("status 400 Bad Request"),
    new Error("INVALID_ARGUMENT: inlineData mimeType is invalid"),
  ];
  for (const c of badRequestCases) assert.equal(classify(c), "bad_request");

  const serverCases: unknown[] = [
    { status: 500, message: "crash" },
    { status: 502, message: "bad gateway" },
    { status: 503, message: "overloaded" },
    { code: 504, message: "gateway upstream failure" },
    new Error("upstream 503 backend busy"),
    new Error("UNAVAILABLE: model server temporarily overloaded"),
    new Error("INTERNAL: unexpected inference failure"),
  ];
  for (const c of serverCases) assert.equal(classify(c), "server");

  const networkCases: unknown[] = [
    new TypeError("fetch failed"),
    new Error("ECONNRESET socket hang up"),
    new Error("error code 14049 and 14005 on socket"),
    { status: 401, message: "UNAUTHENTICATED" },
    { status: 403, message: "PERMISSION_DENIED" },
    null,
    undefined,
    12345,
    {},
  ];
  for (const c of networkCases) assert.equal(classify(c), "network");
});

test("backoffMs respects [0, min(cap, base * 2^attempt)] bounds and clamps at cap", () => {
  const origRandom = Math.random;
  try {
    Math.random = () => 0;
    for (const attempt of [0, 1, 2, 4, 8]) {
      assert.equal(backoffMs(attempt), 0);
      assert.equal(backoffMs(attempt, 250, 1000), 0);
    }

    Math.random = () => 1;
    assert.equal(backoffMs(0), 500);
    assert.equal(backoffMs(1), 1000);
    assert.equal(backoffMs(2), 2000);
    assert.equal(backoffMs(3), 4000);
    assert.equal(backoffMs(4), 8000);
    assert.equal(backoffMs(5), 8000);
    assert.equal(backoffMs(12), 8000);
    assert.equal(backoffMs(3, 100, 500), 500);
    assert.equal(backoffMs(0, 1000, 300), 300);

    Math.random = () => 0.5;
    assert.equal(backoffMs(0), 250);
    assert.equal(backoffMs(1), 500);
    assert.equal(backoffMs(5), 4000);
    assert.equal(backoffMs(0, 101, 8000), 51);
  } finally {
    Math.random = origRandom;
  }

  for (let attempt = 0; attempt <= 8; attempt++) {
    const upper = Math.min(8000, 500 * 2 ** attempt);
    for (let i = 0; i < 30; i++) {
      const ms = backoffMs(attempt);
      assert.equal(Number.isInteger(ms), true);
      assert.ok(ms >= 0 && ms <= upper, `attempt=${attempt} ms=${ms} upper=${upper}`);
    }
  }
});

test("sleep resolves asynchronously after the requested delay", async () => {
  await sleep(0);
  const start = performance.now();
  await sleep(25);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 15, `expected >=15ms elapsed, got ${elapsed}`);
});

test("env exports valid SERVER_DIR, REPO_ROOT, default model chains, and numeric defaults", async () => {
  assert.equal(path.isAbsolute(SERVER_DIR), true);
  assert.equal(path.basename(SERVER_DIR), "server");
  assert.equal(fs.existsSync(path.join(SERVER_DIR, "package.json")), true);
  assert.equal(fs.existsSync(path.join(SERVER_DIR, "src", "env.ts")), true);

  assert.equal(path.isAbsolute(REPO_ROOT), true);
  assert.equal(REPO_ROOT, path.resolve(SERVER_DIR, ".."));
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "package.json")), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "shared", "types.ts")), true);

  assert.equal(Array.isArray(env.liveModels), true);
  assert.equal(Array.isArray(env.verifyModels), true);
  assert.equal(Array.isArray(env.ttsModels), true);
  assert.equal(Number.isFinite(env.verifyTimeoutMs), true);
  assert.equal(Number.isFinite(env.idleStopMs), true);

  const defaults = await importFreshEnv({
    LIVE_MODEL: "",
    LIVE_MODELS: "",
    VERIFY_MODEL: "",
    VERIFY_MODELS: "",
    TTS_MODEL: "",
    VERIFY_TIMEOUT_MS: undefined,
    IDLE_STOP_MS: undefined,
    PORT: undefined,
    LEDGER_PATH: undefined,
  });

  assert.equal(defaults.SERVER_DIR, SERVER_DIR);
  assert.equal(defaults.REPO_ROOT, REPO_ROOT);
  assert.deepEqual(defaults.env.liveModels, [
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-latest",
  ]);
  assert.deepEqual(defaults.env.verifyModels, [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(defaults.env.ttsModels, [
    "gemini-3.8-flash-tts",
    "gemini-2.5-flash-preview-tts",
  ]);
  assert.equal(defaults.env.verifyTimeoutMs, 8000);
  assert.equal(defaults.env.idleStopMs, 45000);
  assert.equal(defaults.env.port, 8787);
  assert.equal(defaults.env.ledgerPath, path.join(SERVER_DIR, "logs", "ledger.jsonl"));

  const promoted = await importFreshEnv({
    LIVE_MODEL: "gemini-2.5-flash-native-audio-latest",
    LIVE_MODELS: "",
    VERIFY_MODEL: "gemini-custom-verify",
    VERIFY_MODELS: " , ",
    TTS_MODEL: "gemini-2.5-flash-preview-tts",
    VERIFY_TIMEOUT_MS: "12000",
    IDLE_STOP_MS: "60000",
    PORT: "9091",
    LEDGER_PATH: "/tmp/holdup-test-ledger.jsonl",
  });

  assert.deepEqual(promoted.env.liveModels, [
    "gemini-2.5-flash-native-audio-latest",
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
  ]);
  assert.deepEqual(promoted.env.verifyModels, [
    "gemini-custom-verify",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(promoted.env.ttsModels, [
    "gemini-2.5-flash-preview-tts",
    "gemini-3.8-flash-tts",
  ]);
  assert.equal(promoted.env.verifyTimeoutMs, 12000);
  assert.equal(promoted.env.idleStopMs, 60000);
  assert.equal(promoted.env.port, 9091);
  assert.equal(promoted.env.ledgerPath, "/tmp/holdup-test-ledger.jsonl");

  const chainOverride = await importFreshEnv({
    LIVE_MODEL: "ignored-live",
    LIVE_MODELS: " live-a , , live-b ",
    VERIFY_MODEL: "ignored-verify",
    VERIFY_MODELS: "verify-only",
  });
  assert.deepEqual(chainOverride.env.liveModels, ["live-a", "live-b"]);
  assert.deepEqual(chainOverride.env.verifyModels, ["verify-only"]);
});
