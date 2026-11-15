import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_FEATURES, REPO_ROOT, SERVER_DIR, env, type Feature } from "../src/env.ts";
import { ledger, stats, usage, type LedgerLine } from "../src/ledger.ts";

type EnvModule = typeof import("../src/env.ts");

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const dotenvPath = path.join(REPO_ROOT, ".env");
const originalLedgerPath = env.ledgerPath;
const tempDirs: string[] = [];

let freshSeq = 0;

async function loadIsolatedEnv(overrides: Record<string, string | undefined>): Promise<EnvModule> {
  const trackedKeys = new Set<string>([
    "FEATURES",
    "PORT",
    "GEMINI_API_KEY",
    "LIVE_MODEL",
    "LIVE_MODELS",
    "VERIFY_MODEL",
    "VERIFY_MODELS",
    "TTS_MODEL",
    "TTS_MODELS",
    "VERIFY_TIMEOUT_MS",
    "IDLE_STOP_MS",
    "npm_package_version",
    "LEDGER_PATH",
    "ELEVENLABS_API_KEY",
    ...Object.keys(overrides),
  ]);
  const saved = new Map<string, string | undefined>();
  for (const key of trackedKeys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  const origReadFileSync = fs.readFileSync;
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof target === "string" && path.resolve(target) === dotenvPath) {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw enoent;
    }
    return (origReadFileSync as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync;

  try {
    freshSeq += 1;
    const moduleUrl = new URL(`../src/env.ts?edge=${freshSeq}`, import.meta.url).href;
    return (await import(moduleUrl)) as EnvModule;
  } finally {
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
    for (const [key, val] of saved.entries()) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

function makeTempLedger(tag: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-env-ledger-edge-${tag}-`));
  tempDirs.push(dir);
  const file = path.join(dir, "ledger.jsonl");
  env.ledgerPath = file;
  return { dir, file };
}

function writeLedgerRows(file: string, rows: Array<LedgerLine | string>): void {
  const content = rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n";
  fs.writeFileSync(file, content, "utf8");
}

function intersectSessionFeatures(serverFeatures: readonly Feature[], clientFeatures?: string[] | null): Feature[] {
  const want = Array.isArray(clientFeatures) ? new Set<string>(clientFeatures) : null;
  return serverFeatures.filter((f) => !want || want.has(f));
}

afterEach(() => {
  env.ledgerPath = originalLedgerPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  env.ledgerPath = originalLedgerPath;
});

test("env.ts FEATURES parsing handles default all, empty disable, unknown filtering, whitespace, and session intersection", async () => {
  const defMod = await loadIsolatedEnv({});
  assert.deepEqual(defMod.ALL_FEATURES, ["scene", "datamatrix", "addmed", "sonar"]);
  assert.deepEqual(defMod.env.features, ["scene", "datamatrix", "addmed", "sonar"]);

  const emptyMod = await loadIsolatedEnv({ FEATURES: "" });
  assert.deepEqual(emptyMod.env.features, []);

  const unknownOnlyMod = await loadIsolatedEnv({ FEATURES: "none, unknown, SCENE, DataMatrix, AddMed, ," });
  assert.deepEqual(unknownOnlyMod.env.features, []);

  const subsetMod = await loadIsolatedEnv({ FEATURES: "  sonar , bogus , scene , , addmed  " });
  assert.deepEqual(subsetMod.env.features, ["sonar", "scene", "addmed"]);

  const singleMod = await loadIsolatedEnv({ FEATURES: "datamatrix" });
  assert.deepEqual(singleMod.env.features, ["datamatrix"]);

  const duplicateMod = await loadIsolatedEnv({ FEATURES: "scene, sonar, scene" });
  assert.deepEqual(duplicateMod.env.features, ["scene", "sonar", "scene"]);
  assert.deepEqual([...new Set(duplicateMod.env.features)], ["scene", "sonar"]);

  assert.deepEqual(intersectSessionFeatures(subsetMod.env.features, undefined), ["sonar", "scene", "addmed"]);
  assert.deepEqual(intersectSessionFeatures(subsetMod.env.features, ["scene", "datamatrix"]), ["scene"]);
  assert.deepEqual(intersectSessionFeatures(subsetMod.env.features, []), []);
  assert.deepEqual(intersectSessionFeatures(emptyMod.env.features, ["scene", "sonar"]), []);
});

test("env.ts model fallback list parsing covers defaults, single-model promotion without duplicates, chain replacement, and TTS_MODELS ignore", async () => {
  const defMod = await loadIsolatedEnv({});
  assert.deepEqual(defMod.env.liveModels, [
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-latest",
  ]);
  assert.deepEqual(defMod.env.verifyModels, [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(defMod.env.ttsModels, [
    "gemini-3.8-flash-tts",
    "gemini-2.5-flash-preview-tts",
  ]);

  const promoteExisting = await loadIsolatedEnv({
    LIVE_MODEL: "gemini-3.1-flash-live-preview",
    LIVE_MODELS: " , , ",
    VERIFY_MODEL: "gemini-3-flash-preview",
    VERIFY_MODELS: "",
    TTS_MODEL: "gemini-2.5-flash-preview-tts",
    TTS_MODELS: "ignored-tts-chain-a,ignored-tts-chain-b",
  });
  assert.deepEqual(promoteExisting.env.liveModels, [
    "gemini-3.1-flash-live-preview",
    "gemini-3.8-live",
    "gemini-2.5-flash-native-audio-latest",
  ]);
  assert.deepEqual(promoteExisting.env.verifyModels, [
    "gemini-3-flash-preview",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
  ]);
  assert.deepEqual(promoteExisting.env.ttsModels, [
    "gemini-2.5-flash-preview-tts",
    "gemini-3.8-flash-tts",
  ]);

  const promoteHeadNoOp = await loadIsolatedEnv({
    LIVE_MODEL: "gemini-3.8-live",
    VERIFY_MODEL: "gemini-3.8-flash",
    TTS_MODEL: "gemini-3.8-flash-tts",
  });
  assert.deepEqual(promoteHeadNoOp.env.liveModels, defMod.env.liveModels);
  assert.deepEqual(promoteHeadNoOp.env.verifyModels, defMod.env.verifyModels);
  assert.deepEqual(promoteHeadNoOp.env.ttsModels, defMod.env.ttsModels);

  const prependCustom = await loadIsolatedEnv({
    LIVE_MODEL: "custom-live-exp",
    VERIFY_MODEL: "custom-verify-exp",
    TTS_MODEL: "custom-tts-exp",
  });
  assert.deepEqual(prependCustom.env.liveModels, [
    "custom-live-exp",
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-latest",
  ]);
  assert.deepEqual(prependCustom.env.verifyModels, [
    "custom-verify-exp",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(prependCustom.env.ttsModels, [
    "custom-tts-exp",
    "gemini-3.8-flash-tts",
    "gemini-2.5-flash-preview-tts",
  ]);

  const replaceChain = await loadIsolatedEnv({
    LIVE_MODEL: "superseded-live",
    LIVE_MODELS: "none-live",
    VERIFY_MODEL: "superseded-verify",
    VERIFY_MODELS: "  verify-primary , , verify-secondary ,  ",
  });
  assert.deepEqual(replaceChain.env.liveModels, ["none-live"]);
  assert.deepEqual(replaceChain.env.verifyModels, ["verify-primary", "verify-secondary"]);
});

test("env.ts port bounds, numeric timeouts, ledgerPath, version, and boolean flag coercion behave deterministically", async () => {
  const isValidTcpPort = (port: number): boolean => Number.isInteger(port) && port >= 0 && port <= 65535;

  const defMod = await loadIsolatedEnv({});
  assert.equal(defMod.env.port, 8787);
  assert.equal(isValidTcpPort(defMod.env.port), true);
  assert.equal(defMod.env.verifyTimeoutMs, 8000);
  assert.equal(defMod.env.idleStopMs, 45000);
  assert.equal(defMod.env.apiKey, "");
  assert.equal(defMod.env.version, "0.1.0");
  assert.equal(defMod.env.elevenlabs, false);
  assert.equal(defMod.env.ledgerPath, path.join(SERVER_DIR, "logs", "ledger.jsonl"));

  const ephemeralMod = await loadIsolatedEnv({ PORT: "0" });
  assert.equal(ephemeralMod.env.port, 0);
  assert.equal(isValidTcpPort(ephemeralMod.env.port), true);

  const minStandardMod = await loadIsolatedEnv({ PORT: "1" });
  assert.equal(minStandardMod.env.port, 1);
  assert.equal(isValidTcpPort(minStandardMod.env.port), true);

  const maxStandardMod = await loadIsolatedEnv({ PORT: "65535" });
  assert.equal(maxStandardMod.env.port, 65535);
  assert.equal(isValidTcpPort(maxStandardMod.env.port), true);

  const trimmedPortMod = await loadIsolatedEnv({ PORT: " 8088 " });
  assert.equal(trimmedPortMod.env.port, 8088);
  assert.equal(isValidTcpPort(trimmedPortMod.env.port), true);

  const emptyPortMod = await loadIsolatedEnv({ PORT: "" });
  assert.equal(emptyPortMod.env.port, 0);

  const negativePortMod = await loadIsolatedEnv({ PORT: "-1" });
  assert.equal(negativePortMod.env.port, -1);
  assert.equal(isValidTcpPort(negativePortMod.env.port), false);

  const overflowPortMod = await loadIsolatedEnv({ PORT: "65536" });
  assert.equal(overflowPortMod.env.port, 65536);
  assert.equal(isValidTcpPort(overflowPortMod.env.port), false);

  const nonNumericPortMod = await loadIsolatedEnv({ PORT: "not-a-port" });
  assert.equal(Number.isNaN(nonNumericPortMod.env.port), true);
  assert.equal(isValidTcpPort(nonNumericPortMod.env.port), false);

  const customRuntimeMod = await loadIsolatedEnv({
    VERIFY_TIMEOUT_MS: "4500",
    IDLE_STOP_MS: "30000",
    npm_package_version: "1.2.3",
    LEDGER_PATH: "/dev/shm/custom-holdup-ledger.jsonl",
    ELEVENLABS_API_KEY: "present-test-token",
    GEMINI_API_KEY: "present-gemini-token",
  });
  assert.equal(customRuntimeMod.env.verifyTimeoutMs, 4500);
  assert.equal(customRuntimeMod.env.idleStopMs, 30000);
  assert.equal(customRuntimeMod.env.version, "1.2.3");
  assert.equal(customRuntimeMod.env.ledgerPath, "/dev/shm/custom-holdup-ledger.jsonl");
  assert.equal(customRuntimeMod.env.elevenlabs, true);
  assert.equal(customRuntimeMod.env.apiKey, "present-gemini-token");
});

test("ledger.ts stats() p50 and p95 return null on empty files and all-failed feature buckets", () => {
  makeTempLedger("missing-file");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const { file: zeroFile } = makeTempLedger("zero-byte");
  fs.writeFileSync(zeroFile, "", "utf8");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const { file: newlineFile } = makeTempLedger("newlines-only");
  fs.writeFileSync(newlineFile, "\n\n\n\n", "utf8");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const { file: allFailedFile } = makeTempLedger("all-failed");
  writeLedgerRows(allFailedFile, [
    { ts: 1763200000100, feature: "verify", model: "gemini-3.8-flash", in: 120, out: 0, thinking: 4, latency_s: 8.002, ok: false },
    { ts: 1763200000200, feature: "verify", model: "gemini-3.5-flash", in: 110, out: 0, thinking: 0, latency_s: 3.125, ok: false },
    { ts: 1763200000300, feature: "live_fidelity", model: "gemini-3.8-live", latency_s: 0, ok: false, reasons: "strength_mismatch", level: "match" },
  ]);

  const failedStats = stats();
  assert.equal(failedStats.since, 1763200000100);
  assert.equal(failedStats.total, 3);
  assert.deepEqual(failedStats.features.verify, {
    calls: 2,
    ok: 0,
    errors: 2,
    latency_p50_s: null,
    latency_p95_s: null,
    tokens_in: 230,
    tokens_out: 0,
    tokens_thinking: 4,
    models: { "gemini-3.8-flash": 1, "gemini-3.5-flash": 1 },
  });
  assert.deepEqual(failedStats.features.live_fidelity, {
    calls: 1,
    ok: 0,
    errors: 1,
    latency_p50_s: null,
    latency_p95_s: null,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: { "gemini-3.8-live": 1 },
  });
});

test("ledger.ts stats() p50 and p95 match single-item rounding and live sub-metric edge cases", () => {
  const { file: singleVerifyFile } = makeTempLedger("single-verify");
  writeLedgerRows(singleVerifyFile, [
    {
      ts: 1763200100000,
      feature: "verify",
      model: "gemini-3.8-flash",
      in: 256,
      out: 48,
      thinking: 16,
      latency_s: 0.3456,
      ok: true,
    },
  ]);

  const singleVerify = stats();
  assert.equal(singleVerify.since, 1763200100000);
  assert.equal(singleVerify.total, 1);
  assert.deepEqual(singleVerify.features.verify, {
    calls: 1,
    ok: 1,
    errors: 0,
    latency_p50_s: 0.346,
    latency_p95_s: 0.346,
    tokens_in: 256,
    tokens_out: 48,
    tokens_thinking: 16,
    models: { "gemini-3.8-flash": 1 },
  });

  const { file: singleLiveFile } = makeTempLedger("single-live");
  writeLedgerRows(singleLiveFile, [
    {
      ts: 1763200200000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 9.8765,
      ok: true,
      first_audio_s: 1.2344,
      tool_calls: 1,
      tool_latencies_s: [0.6789],
    },
  ]);

  const singleLive = stats();
  assert.deepEqual(singleLive.features.live, {
    calls: 1,
    ok: 1,
    errors: 0,
    latency_p50_s: 9.877,
    latency_p95_s: 9.877,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: { "gemini-3.8-live": 1 },
    first_audio_p50_s: 1.234,
    first_audio_p95_s: 1.234,
    tool_p50_s: 0.679,
    tool_p95_s: 0.679,
    tool_calls: 1,
  });

  const { file: liveNoAudioFile } = makeTempLedger("single-live-no-audio");
  writeLedgerRows(liveNoAudioFile, [
    {
      ts: 1763200250000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 2.5,
      ok: true,
      first_audio_s: "invalid",
    },
  ]);
  const liveNoAudio = stats().features.live as Record<string, unknown>;
  assert.equal(liveNoAudio.first_audio_p50_s, null);
  assert.equal(liveNoAudio.first_audio_p95_s, null);
  assert.equal(liveNoAudio.tool_p50_s, null);
  assert.equal(liveNoAudio.tool_p95_s, null);
  assert.equal(liveNoAudio.tool_calls, 0);
});

test("ledger.ts stats() computes exact p50 and p95 percentiles across mixed ok, fail, live, and live_fidelity entries", () => {
  const { file } = makeTempLedger("mixed-ok-fail-fidelity");
  const rows: LedgerLine[] = [
    { ts: 1763201000000, feature: "verify", model: "gemini-3.8-flash", in: 200, out: 40, thinking: 10, latency_s: 0.9, ok: true },
    { ts: 1763201000100, feature: "verify", model: "gemini-3.8-flash", in: 200, out: 40, thinking: 10, latency_s: 0.1, ok: true },
    { ts: 1763201000200, feature: "verify", model: "gemini-3.8-flash", in: 200, out: 40, thinking: 10, latency_s: 0.5, ok: true },
    { ts: 1763201000300, feature: "verify", model: "gemini-3.5-flash", in: 180, out: 35, thinking: 8, latency_s: 0.3, ok: true },
    { ts: 1763201000400, feature: "verify", model: "gemini-3.5-flash", in: 180, out: 35, thinking: 8, latency_s: 0.7, ok: true },
    { ts: 1763201000500, feature: "verify", model: "gemini-3.8-flash", in: 90, out: 0, thinking: 0, latency_s: 999.999, ok: false, error: "timeout" },
    { ts: 1763201000600, feature: "verify", model: "gemini-3-flash-preview", in: 70, out: 0, thinking: 0, latency_s: 0.001, ok: false, error: "quota" },

    { ts: 1763201001000, feature: "live_fidelity", model: "gemini-3.8-live", latency_s: 0, ok: true, level: "match" },
    { ts: 1763201001100, feature: "live_fidelity", model: "gemini-3.8-live", latency_s: 0, ok: false, reasons: "strength_mismatch", level: "match" },
    { ts: 1763201001200, feature: "live_fidelity", model: "gemini-3.8-live", latency_s: 0, ok: true, level: "warning" },
    { ts: 1763201001300, feature: "live_fidelity", model: "gemini-3.1-flash-live-preview", latency_s: 0, ok: false, reasons: "false_reassurance,missing_lead", level: "stop" },

    { ts: 1763201002000, feature: "live", model: "gemini-3.8-live", latency_s: 14.2, ok: true, first_audio_s: 1.8, tool_calls: 2, tool_latencies_s: [0.9, 0.4] },
    { ts: 1763201002100, feature: "live", model: "gemini-3.8-live", latency_s: 8.6, ok: true, first_audio_s: 0.7, tool_calls: 1, tool_latencies_s: [0.6] },
    { ts: 1763201002200, feature: "live", model: "none-live", latency_s: 0.2, ok: false, first_audio_s: 88.8, tool_calls: 5, tool_latencies_s: [77.7] },
  ];

  for (let i = 1; i <= 100; i += 1) {
    const scrambled = ((i * 37) % 100) + 1;
    rows.push({
      ts: 1763201010000 + i,
      feature: "tts",
      model: "gemini-3.8-flash-tts",
      in: 10,
      out: 50,
      latency_s: scrambled / 100,
      ok: true,
    });
  }
  rows.push({
    ts: 1763201099999,
    feature: "tts",
    model: "gemini-2.5-flash-preview-tts",
    in: 10,
    out: 0,
    latency_s: 120.0,
    ok: false,
  });

  writeLedgerRows(file, rows);

  const agg = stats();
  assert.equal(agg.since, 1763201000000);
  assert.equal(agg.total, 115);

  assert.deepEqual(agg.features.verify, {
    calls: 7,
    ok: 5,
    errors: 2,
    latency_p50_s: 0.5,
    latency_p95_s: 0.9,
    tokens_in: 1120,
    tokens_out: 190,
    tokens_thinking: 46,
    models: {
      "gemini-3.8-flash": 4,
      "gemini-3.5-flash": 2,
      "gemini-3-flash-preview": 1,
    },
  });

  assert.deepEqual(agg.features.live_fidelity, {
    calls: 4,
    ok: 2,
    errors: 2,
    latency_p50_s: 0,
    latency_p95_s: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: {
      "gemini-3.8-live": 3,
      "gemini-3.1-flash-live-preview": 1,
    },
  });
  assert.equal("first_audio_p50_s" in (agg.features.live_fidelity as object), false);

  assert.deepEqual(agg.features.live, {
    calls: 3,
    ok: 2,
    errors: 1,
    latency_p50_s: 14.2,
    latency_p95_s: 14.2,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: {
      "gemini-3.8-live": 2,
      "none-live": 1,
    },
    first_audio_p50_s: 1.8,
    first_audio_p95_s: 1.8,
    tool_p50_s: 0.6,
    tool_p95_s: 0.9,
    tool_calls: 3,
  });

  assert.deepEqual(agg.features.tts, {
    calls: 101,
    ok: 100,
    errors: 1,
    latency_p50_s: 0.51,
    latency_p95_s: 0.96,
    tokens_in: 1010,
    tokens_out: 5000,
    tokens_thinking: 0,
    models: {
      "gemini-3.8-flash-tts": 100,
      "gemini-2.5-flash-preview-tts": 1,
    },
  });
});

test("ledger.ts stats(), ledger(), and usage() stay resilient against corrupt JSONL lines, sparse blanks, and malformed paths", () => {
  const validA = JSON.stringify({
    ts: 1763202000000,
    feature: "verify",
    model: "gemini-3.8-flash",
    in: 100,
    out: 25,
    latency_s: 0.42,
    ok: true,
  });
  const validB = JSON.stringify({
    ts: 1763202001000,
    feature: "live_fidelity",
    model: "gemini-3.8-live",
    latency_s: 0,
    ok: true,
    level: "match",
  });

  const corruptPayloads = [
    `${validA}\n{"ts":1763202000500,"feature":"verify"\n${validB}\n`,
    `not-json-at-all\n${validA}\n`,
    `${validA}\n   \n${validB}\n`,
    `${validA}\n\u0000\u0001corrupt-tail`,
    `{"unterminated": [1, 2,`,
  ];

  for (let idx = 0; idx < corruptPayloads.length; idx += 1) {
    const { file } = makeTempLedger(`corrupt-${idx}`);
    fs.writeFileSync(file, corruptPayloads[idx], "utf8");
    assert.doesNotThrow(() => stats());
    assert.deepEqual(stats(), { since: null, total: 0, features: {} });
  }

  const { dir: dirAsFile } = makeTempLedger("dir-as-ledger");
  env.ledgerPath = dirAsFile;
  assert.doesNotThrow(() => stats());
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const { file: sparseValidFile } = makeTempLedger("sparse-valid");
  fs.writeFileSync(sparseValidFile, `\n\n${validA}\n\n\n${validB}\n\n`, "utf8");
  const sparseStats = stats();
  assert.equal(sparseStats.since, 1763202000000);
  assert.equal(sparseStats.total, 2);
  assert.equal((sparseStats.features.verify as Record<string, unknown>).latency_p50_s, 0.42);
  assert.equal((sparseStats.features.live_fidelity as Record<string, unknown>).calls, 1);

  const { dir: nestedParent } = makeTempLedger("nested-write");
  const nestedLedger = path.join(nestedParent, "a", "b", "ledger.jsonl");
  env.ledgerPath = nestedLedger;
  ledger({
    ts: 1763203000000,
    feature: "live_fidelity",
    model: "gemini-3.8-live",
    latency_s: 0,
    ok: false,
    reasons: "missing_disclaimer",
    level: "uncertain",
  });
  const writtenStats = stats();
  assert.equal(writtenStats.total, 1);
  assert.equal(writtenStats.since, 1763203000000);
  assert.equal((writtenStats.features.live_fidelity as Record<string, unknown>).errors, 1);

  assert.deepEqual(usage({ promptTokenCount: 12, candidatesTokenCount: 0, responseTokenCount: 88 }), {
    in: 12,
    out: 0,
    thinking: 0,
    cached: 0,
  });
  assert.deepEqual(usage({ promptTokenCount: 12, candidatesTokenCount: undefined, responseTokenCount: 88, thoughtsTokenCount: 5, cachedContentTokenCount: 9 }), {
    in: 12,
    out: 88,
    thinking: 5,
    cached: 9,
  });
  assert.deepEqual(usage(null), { in: 0, out: 0, thinking: 0, cached: 0 });
});
