import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { startServer } from "../src/index.ts";
import { ledger, stats, usage, type LedgerLine } from "../src/ledger.ts";
import { Speculator } from "../src/speculate.ts";
import { FrameRing, verify } from "../src/verify.ts";

const FIVE_MB = 5 * 1024 * 1024;
const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const originalLedgerPath = env.ledgerPath;
const originalQuiet = process.env.HOLDUP_QUIET;
const originalKey = process.env.HOLDUP_KEY;
process.env.HOLDUP_QUIET = "1";

const activeDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-ledger-${label}-`));
  activeDirs.push(dir);
  return dir;
}

function useTempLedger(label: string): string {
  const dir = makeTempDir(label);
  const filePath = path.join(dir, "ledger.jsonl");
  env.ledgerPath = filePath;
  return filePath;
}

function writeJsonl(filePath: string, rows: Array<LedgerLine | string>): void {
  const text = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
  fs.writeFileSync(filePath, text, "utf8");
}

async function waitForLines(filePath: string, expectedCount: number, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length >= expectedCount) return lines;
    } catch {
      void 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const fallback = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean) : [];
  assert.equal(fallback.length, expectedCount, `Timed out waiting for ${expectedCount} ledger lines in ${filePath}`);
  return fallback;
}

async function waitForMinSize(filePath: string, minBytes: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const size = fs.statSync(filePath).size;
      if (size >= minBytes) return size;
    } catch {
      void 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const finalSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : -1;
  assert.ok(finalSize >= minBytes, `Timed out waiting for ${filePath} size >= ${minBytes}, got ${finalSize}`);
  return finalSize;
}

function httpJson(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: () => any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), "utf8") : undefined;
    const headers: Record<string, string> = { connection: "close", ...(opts.headers ?? {}) };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
            json: () => JSON.parse(buf.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  env.ledgerPath = originalLedgerPath;
  if (originalKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = originalKey;
  for (const dir of activeDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  env.ledgerPath = originalLedgerPath;
  if (originalQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = originalQuiet;
  if (originalKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = originalKey;
});

test("ledger() handles invalid paths without throwing and creates missing parent directories automatically", async () => {
  const dir = makeTempDir("mkdir-and-invalid");
  const blockerFile = path.join(dir, "blocker-file");
  fs.writeFileSync(blockerFile, "not-a-directory", "utf8");

  env.ledgerPath = path.join(blockerFile, "child", "ledger.jsonl");
  assert.doesNotThrow(() => {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.25, ok: true });
  });

  const nestedPath = path.join(dir, "nested", "sub", "logs", "ledger.jsonl");
  assert.equal(fs.existsSync(path.dirname(nestedPath)), false);
  env.ledgerPath = nestedPath;
  ledger({
    ts: 1763149000000,
    feature: "verify",
    model: "gemini-3.8-flash",
    in: 140,
    out: 35,
    thinking: 8,
    latency_s: 0.51,
    ok: true,
  });
  assert.equal(fs.existsSync(path.dirname(nestedPath)), true);
  const createdLines = await waitForLines(nestedPath, 1);
  assert.equal(JSON.parse(createdLines[0]).ts, 1763149000000);

  env.ledgerPath = dir;
  assert.doesNotThrow(() => {
    ledger({ feature: "tts", model: "gemini-3.8-flash-tts", latency_s: 0.12, ok: false });
  });

  env.ledgerPath = path.join(blockerFile, "direct.jsonl");
  assert.doesNotThrow(() => {
    ledger({ feature: "live", model: "gemini-3.8-live", latency_s: 1.0, ok: false });
  });

  env.ledgerPath = null as unknown as string;
  assert.doesNotThrow(() => {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.1, ok: false });
  });

  env.ledgerPath = nestedPath;
  assert.doesNotThrow(() => {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.1, ok: false, unserializable: BigInt(7) });
  });

  await new Promise((r) => setTimeout(r, 30));
});

test("ledger() rotates files exceeding 5 MB to .1 on the 200-write check", async () => {
  const dir = makeTempDir("rotation");
  const syncPath = path.join(dir, "sync.jsonl");
  fs.writeFileSync(syncPath, "", "utf8");
  fs.truncateSync(syncPath, FIVE_MB + 32);
  env.ledgerPath = syncPath;

  let syncWrites = 0;
  while (!fs.existsSync(`${syncPath}.1`) && syncWrites < 200) {
    syncWrites += 1;
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.1, ok: true });
  }
  assert.equal(fs.existsSync(`${syncPath}.1`), true);
  await waitForLines(syncPath, 1);
  await new Promise((r) => setTimeout(r, 25));

  const scratchA = path.join(dir, "scratch-a.jsonl");
  env.ledgerPath = scratchA;
  for (let i = 0; i < 199; i += 1) {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.05, ok: true });
  }
  await waitForLines(scratchA, 199);

  const targetPath = path.join(dir, "target.jsonl");
  fs.writeFileSync(targetPath, "", "utf8");
  fs.truncateSync(targetPath, FIVE_MB);
  env.ledgerPath = targetPath;

  ledger({ ts: 1763149500001, feature: "verify", model: "gemini-3.8-flash", latency_s: 0.2, ok: true });
  assert.equal(fs.existsSync(`${targetPath}.1`), false);
  const afterBoundaryAppend = await waitForMinSize(targetPath, FIVE_MB + 20);

  ledger({ ts: 1763149500002, feature: "verify", model: "gemini-3.8-flash", latency_s: 0.21, ok: true });
  assert.equal(fs.existsSync(`${targetPath}.1`), false);
  const preRotateSize = await waitForMinSize(targetPath, afterBoundaryAppend + 20);

  const scratchB = path.join(dir, "scratch-b.jsonl");
  env.ledgerPath = scratchB;
  for (let i = 0; i < 198; i += 1) {
    ledger({ feature: "verify", model: "gemini-3.8-flash", latency_s: 0.05, ok: true });
  }
  await waitForLines(scratchB, 198);
  assert.equal(fs.existsSync(`${targetPath}.1`), false);

  env.ledgerPath = targetPath;
  ledger({
    ts: 1763149500999,
    feature: "tts",
    model: "gemini-3.8-flash-tts",
    in: 18,
    out: 94,
    latency_s: 0.34,
    ok: true,
  });

  assert.equal(fs.existsSync(`${targetPath}.1`), true);
  assert.equal(fs.statSync(`${targetPath}.1`).size, preRotateSize);

  const freshLines = await waitForLines(targetPath, 1);
  assert.equal(freshLines.length, 1);
  assert.ok(fs.statSync(targetPath).size < 1024);

  const postStats = stats();
  assert.equal(postStats.since, 1763149500999);
  assert.equal(postStats.total, 1);
  assert.equal((postStats.features.tts as any).tokens_in, 18);
  assert.equal((postStats.features.tts as any).tokens_out, 94);
});

test("usage() tolerates full, fallback, partial, cached variants, and null/undefined inputs", () => {
  assert.deepEqual(
    usage({
      promptTokenCount: 240,
      candidatesTokenCount: 85,
      thoughtsTokenCount: 32,
      cachedContentTokenCount: 16,
    }),
    { in: 240, out: 85, thinking: 32, cached: 16 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 100, responseTokenCount: 54 }),
    { in: 100, out: 54, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 100, candidatesTokenCount: undefined, responseTokenCount: 54 }),
    { in: 100, out: 54, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 100, candidatesTokenCount: null, responseTokenCount: 54 }),
    { in: 100, out: 54, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 50, candidatesTokenCount: 40, responseTokenCount: 99 }),
    { in: 50, out: 40, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ promptTokenCount: 50, candidatesTokenCount: 0, responseTokenCount: 99 }),
    { in: 50, out: 0, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ thoughtsTokenCount: 73 }),
    { in: 0, out: 0, thinking: 73, cached: 0 },
  );

  assert.deepEqual(
    usage({ cachedContentTokenCount: 48 }),
    { in: 0, out: 0, thinking: 0, cached: 48 },
  );

  assert.deepEqual(
    usage({ cachedTokenCount: 48 }),
    { in: 0, out: 0, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({ cachedTokenCount: 12, cachedContentTokenCount: 64 }),
    { in: 0, out: 0, thinking: 0, cached: 64 },
  );

  assert.deepEqual(usage(undefined), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage(null), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage({}), { in: 0, out: 0, thinking: 0, cached: 0 });
});

test("stats() returns empty baseline for missing, zero-byte, and newline-only files", () => {
  useTempLedger("missing");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const emptyFile = useTempLedger("empty");
  fs.writeFileSync(emptyFile, "", "utf8");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });

  const blankLines = useTempLedger("newlines");
  fs.writeFileSync(blankLines, "\n\n\n", "utf8");
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });
});

test("stats() computes p50 and p95 latencies over ok entries only with 3-decimal rounding", () => {
  const p = useTempLedger("percentiles");
  const unsortedTwenty = [
    2.0, 0.1, 1.9, 0.2, 1.8, 0.3, 1.7, 0.4, 1.6, 0.5,
    1.5, 0.6, 1.4, 0.7, 1.3, 0.8, 1.2, 0.9, 1.1, 1.0,
  ];
  const rows: LedgerLine[] = unsortedTwenty.map((lat, i) => ({
    ts: 1763150000000 + i * 100,
    feature: "verify",
    model: "gemini-3.8-flash",
    in: 100,
    out: 25,
    thinking: 10,
    latency_s: lat,
    ok: true,
  }));
  rows.push(
    { ts: 1763150005000, feature: "verify", model: "gemini-3.8-flash", in: 50, out: 0, latency_s: 99.999, ok: false },
    { ts: 1763150006000, feature: "verify", model: "gemini-3.5-flash", in: 50, out: 0, latency_s: 0.001, ok: false },
    { ts: 1763150007000, feature: "tts", model: "gemini-3.8-flash-tts", in: 12, out: 80, latency_s: 0.456789, ok: true },
    { ts: 1763150008000, feature: "live_connect", model: "gemini-3.8-live", latency_s: 4.2, ok: false },
    { ts: 1763150009000, feature: "live_connect", model: "gemini-3.1-flash-live-preview", latency_s: 3.8, ok: false },
  );
  writeJsonl(p, rows);

  const s = stats();
  assert.equal(s.since, 1763150000000);
  assert.equal(s.total, 25);

  const v = s.features.verify as any;
  assert.equal(v.calls, 22);
  assert.equal(v.ok, 20);
  assert.equal(v.errors, 2);
  assert.equal(v.latency_p50_s, 1.1);
  assert.equal(v.latency_p95_s, 2.0);
  assert.equal(v.tokens_in, 2100);
  assert.equal(v.tokens_out, 500);
  assert.equal(v.tokens_thinking, 200);
  assert.deepEqual(v.models, { "gemini-3.8-flash": 21, "gemini-3.5-flash": 1 });

  const t = s.features.tts as any;
  assert.equal(t.calls, 1);
  assert.equal(t.ok, 1);
  assert.equal(t.errors, 0);
  assert.equal(t.latency_p50_s, 0.457);
  assert.equal(t.latency_p95_s, 0.457);

  const lc = s.features.live_connect as any;
  assert.equal(lc.calls, 2);
  assert.equal(lc.ok, 0);
  assert.equal(lc.errors, 2);
  assert.equal(lc.latency_p50_s, null);
  assert.equal(lc.latency_p95_s, null);
});

test("stats() aggregates multi-feature counts, models histogram, tokens, and live audio/tool percentiles", () => {
  const p = useTempLedger("multifeature-live");
  const rows: LedgerLine[] = [
    {
      ts: 1763151000000,
      feature: "verify",
      model: "gemini-3.8-flash",
      in: 310,
      out: 64,
      thinking: 22,
      cached: 100,
      latency_s: 0.92,
      ok: true,
      n_frames: 2,
    },
    {
      ts: 1763151001000,
      feature: "verify",
      model: "gemini-3.8-flash",
      latency_s: 8.01,
      ok: false,
      error: "timeout",
    },
    {
      ts: 1763151002000,
      feature: "verify",
      model: "gemini-3.5-flash",
      in: 295,
      out: 58,
      thinking: 18,
      latency_s: 0.74,
      ok: true,
      n_frames: 2,
    },
    {
      ts: 1763151003000,
      feature: "tts",
      model: "gemini-3.8-flash-tts",
      in: 19,
      out: 112,
      latency_s: 0.38,
      ok: true,
    },
    {
      ts: 1763151004000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 18.4,
      ok: true,
      first_audio_s: 1.4,
      tool_calls: 2,
      tool_latencies_s: [1.25, 0.45],
    },
    {
      ts: 1763151005000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 24.2,
      ok: true,
      first_audio_s: 0.8,
      tool_calls: 3,
      tool_latencies_s: [0.85, 2.35, 0.65],
    },
    {
      ts: 1763151006000,
      feature: "live",
      model: "gemini-3.1-flash-live-preview",
      latency_s: 12.0,
      ok: true,
      first_audio_s: 2.1,
      tool_calls: 0,
      tool_latencies_s: [],
    },
    {
      ts: 1763151007000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 9.5,
      ok: true,
      first_audio_s: 1.1,
    },
    {
      ts: 1763151008000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 6.1,
      ok: true,
      first_audio_s: 0.9,
      tool_calls: 0,
      tool_latencies_s: [],
    },
    {
      ts: 1763151009000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 3.0,
      ok: true,
      first_audio_s: null,
      tool_calls: 0,
      tool_latencies_s: [],
    },
    {
      ts: 1763151010000,
      feature: "live",
      model: "none",
      latency_s: 1.5,
      ok: false,
      first_audio_s: 99.0,
      tool_calls: 9,
      tool_latencies_s: [50.0],
    },
  ];
  writeJsonl(p, rows);

  const s = stats();
  assert.equal(s.since, 1763151000000);
  assert.equal(s.total, 11);

  assert.deepEqual(s.features.verify, {
    calls: 3,
    ok: 2,
    errors: 1,
    latency_p50_s: 0.92,
    latency_p95_s: 0.92,
    tokens_in: 605,
    tokens_out: 122,
    tokens_thinking: 40,
    models: { "gemini-3.8-flash": 2, "gemini-3.5-flash": 1 },
  });

  assert.deepEqual(s.features.tts, {
    calls: 1,
    ok: 1,
    errors: 0,
    latency_p50_s: 0.38,
    latency_p95_s: 0.38,
    tokens_in: 19,
    tokens_out: 112,
    tokens_thinking: 0,
    models: { "gemini-3.8-flash-tts": 1 },
  });

  assert.deepEqual(s.features.live, {
    calls: 7,
    ok: 6,
    errors: 1,
    latency_p50_s: 12.0,
    latency_p95_s: 24.2,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: { "gemini-3.8-live": 5, "gemini-3.1-flash-live-preview": 1, none: 1 },
    first_audio_p50_s: 1.1,
    first_audio_p95_s: 2.1,
    tool_p50_s: 0.85,
    tool_p95_s: 2.35,
    tool_calls: 5,
  });

  assert.equal("first_audio_p50_s" in (s.features.verify as object), false);
  assert.equal("tool_calls" in (s.features.tts as object), false);
});

test("stats() handles live sessions with zero audio turns and zero tool calls cleanly", () => {
  const p = useTempLedger("live-null-percentiles");
  writeJsonl(p, [
    {
      ts: 1763152000000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 4.5,
      ok: true,
      first_audio_s: null,
      tool_calls: 0,
      tool_latencies_s: [],
    },
  ]);

  const s = stats();
  assert.deepEqual(s.features.live, {
    calls: 1,
    ok: 1,
    errors: 0,
    latency_p50_s: 4.5,
    latency_p95_s: 4.5,
    tokens_in: 0,
    tokens_out: 0,
    tokens_thinking: 0,
    models: { "gemini-3.8-live": 1 },
    first_audio_p50_s: null,
    first_audio_p95_s: null,
    tool_p50_s: null,
    tool_p95_s: null,
    tool_calls: 0,
  });
});

test("stats() skips blank lines and never throws on corrupt or truncated JSONL lines", () => {
  const sparse = useTempLedger("sparse-lines");
  const rowA = JSON.stringify({ ts: 1763153000000, feature: "verify", model: "gemini-3.8-flash", in: 80, out: 20, latency_s: 0.6, ok: true });
  const rowB = JSON.stringify({ ts: 1763153001000, feature: "verify", model: "gemini-3.8-flash", in: 90, out: 22, latency_s: 0.8, ok: true });
  fs.writeFileSync(sparse, `\n\n${rowA}\n\n\n${rowB}\n\n`, "utf8");

  const sparseStats = stats();
  assert.equal(sparseStats.since, 1763153000000);
  assert.equal(sparseStats.total, 2);
  assert.equal((sparseStats.features.verify as any).tokens_in, 170);

  const corrupt = useTempLedger("corrupt-line");
  fs.writeFileSync(corrupt, `${rowA}\n{"ts":1763153002000,"feature":"verify"\n${rowB}\n`, "utf8");
  assert.doesNotThrow(() => stats());
  assert.deepEqual(stats(), { since: null, total: 0, features: {} });
});

test("ledger() appends JSONL rows asynchronously with default and explicit timestamps", async () => {
  const p = useTempLedger("append");
  const before = Date.now();
  ledger({
    feature: "verify",
    model: "gemini-3.8-flash",
    in: 215,
    out: 44,
    thinking: 12,
    cached: 0,
    latency_s: 0.785,
    ok: true,
    n_frames: 2,
  });
  ledger({
    ts: 1763154000123,
    feature: "tts",
    model: "gemini-3.8-flash-tts",
    in: 15,
    out: 96,
    latency_s: 0.312,
    ok: true,
  });

  const rawLines = await waitForLines(p, 2);
  const afterTs = Date.now();
  const rawFile = fs.readFileSync(p, "utf8");
  assert.ok(rawFile.endsWith("\n"));

  const parsed = rawLines.map((l) => JSON.parse(l));
  assert.equal(parsed.length, 2);
  assert.ok(typeof parsed[0].ts === "number" && parsed[0].ts >= before && parsed[0].ts <= afterTs);
  assert.equal(parsed[0].feature, "verify");
  assert.equal(parsed[0].n_frames, 2);
  assert.equal(parsed[1].ts, 1763154000123);
  assert.equal(parsed[1].feature, "tts");

  const s = stats();
  assert.equal(s.total, 2);
  assert.equal(s.since, parsed[0].ts);
  assert.equal((s.features.verify as any).tokens_in, 215);
  assert.equal((s.features.tts as any).tokens_out, 96);
});

test("ledger rows written by verify(), Speculator, and POST /api/tts contain zero PII or content fields", async () => {
  const p = useTempLedger("zero-pii");
  const origGenerate = ai.models.generateContent;
  const server = await startServer(0);
  const port = (server.address() as AddressInfo).port;

  const forbiddenSubstrings = [
    "Anna",
    "Korhonen",
    "Norvasc",
    "amlodipine",
    "Amlodipine",
    "penicillin",
    "peanut",
    "NSAID",
    "SENSITIVE_JPEG_PAYLOAD",
    "06412345678906",
    "hypertension",
  ];
  const forbiddenKeys = new Set([
    "text", "data", "transcript", "image", "frame", "frames", "audio",
    "profile", "speech", "headline", "question", "args", "prompt", "body",
    "key", "apikey", "api_key", "value", "meds", "allergies", "avoid",
    "doseLog", "notes", "product", "ingredient", "strength", "guidance",
  ]);
  const allowedKeys = new Set([
    "ts", "feature", "model", "latency_s", "ok",
    "in", "out", "thinking", "cached",
    "n_frames", "error", "source", "age_s",
  ]);

  try {
    (ai.models as any).generateContent = async (req: any) => {
      if (String(req?.model ?? "").includes("tts")) {
        return {
          candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(64).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } }],
          usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 108 },
        };
      }
      return {
        text: JSON.stringify({
          kind: "medication",
          product: { value: "Norvasc", confidence: 0.96 },
          ingredient: { value: "amlodipine", confidence: 0.98 },
          strength: { value: "5 mg", confidence: 0.97 },
          dosing: { value: "1 tablet in the evening", confidence: 0.91 },
          expiry: { value: "2027-08", confidence: 0.93 },
          allergens: { value: null, confidence: 0.1 },
          barcode: { value: "06412345678906", confidence: 0.95 },
          readability: 0.94,
          guidance: "Hold steady for Anna Korhonen",
        }),
        usageMetadata: { promptTokenCount: 340, candidatesTokenCount: 72, thoughtsTokenCount: 19, cachedContentTokenCount: 0 },
      };
    };

    const sensitiveFrame = Buffer.from("SENSITIVE_JPEG_PAYLOAD_".repeat(12), "utf8").toString("base64");
    const vr = await verify(
      [sensitiveFrame],
      {
        meds: [{ id: "aml-1", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], notes: "Anna Korhonen hypertension" }],
        allergies: ["penicillin", "peanut"],
        avoid: ["NSAIDs"],
        doseLog: [{ medId: "aml-1", ts: 1763100000000 }],
        lang: "fi",
      },
      "Is this Anna Korhonen evening amlodipine pill for hypertension?",
    );
    assert.equal(vr.verdict.level, "match");

    const ring = new FrameRing(4);
    const spec = new Speculator(ring, () => false);
    const miss = await spec.get(15);
    assert.equal(miss, undefined);

    const ttsRes = await httpJson({
      port,
      path: "/api/tts",
      method: "POST",
      body: { text: "Yes, Amlodipine 5 mg for Anna Korhonen." },
    });
    assert.equal(ttsRes.status, 200);

    const lines = await waitForLines(p, 3);
    const raw = fs.readFileSync(p, "utf8");
    for (const secret of forbiddenSubstrings) {
      assert.equal(raw.includes(secret), false, `Ledger leaked sensitive substring: ${secret}`);
    }
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        assert.equal(forbiddenKeys.has(k), false, `Forbidden key in ledger row: ${k}`);
        assert.equal(allowedKeys.has(k), true, `Unexpected key in ledger row: ${k}`);
      }
    }
  } finally {
    ai.models.generateContent = origGenerate;
    await closeServer(server);
  }
});

test("GET /api/stats serves live ledger aggregation and respects HOLDUP_KEY", async () => {
  const p = useTempLedger("http-stats");
  delete process.env.HOLDUP_KEY;
  const server = await startServer(0);
  const port = (server.address() as AddressInfo).port;

  try {
    const initial = await httpJson({ port, path: "/api/stats" });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json(), { since: null, total: 0, features: {} });

    ledger({
      ts: 1763155000000,
      feature: "verify",
      model: "gemini-3.8-flash",
      in: 280,
      out: 60,
      thinking: 15,
      latency_s: 0.88,
      ok: true,
      n_frames: 2,
    });
    ledger({
      ts: 1763155001000,
      feature: "tts",
      model: "gemini-3.8-flash-tts",
      in: 16,
      out: 92,
      latency_s: 0.35,
      ok: true,
    });
    ledger({
      ts: 1763155002000,
      feature: "live",
      model: "gemini-3.8-live",
      latency_s: 15.2,
      ok: true,
      first_audio_s: 1.05,
      tool_calls: 2,
      tool_latencies_s: [0.62, 0.94],
    });
    await waitForLines(p, 3);

    const populated = await httpJson({ port, path: "/api/stats" });
    assert.equal(populated.status, 200);
    assert.match(String(populated.headers["content-type"] ?? ""), /application\/json/);
    const expected = stats();
    assert.deepEqual(populated.json(), expected);
    assert.equal(expected.total, 3);
    assert.equal((expected.features.live as any).first_audio_p50_s, 1.05);
    assert.equal((expected.features.live as any).tool_calls, 2);

    process.env.HOLDUP_KEY = "gate-secret-42";
    const unauth = await httpJson({ port, path: "/api/stats" });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.json().code, "unauthorized");

    const authedHeader = await httpJson({
      port,
      path: "/api/stats",
      headers: { "x-holdup-key": "gate-secret-42" },
    });
    assert.equal(authedHeader.status, 200);
    assert.deepEqual(authedHeader.json(), expected);

    const authedQuery = await httpJson({
      port,
      path: "/api/stats?key=gate-secret-42",
    });
    assert.equal(authedQuery.status, 200);
    assert.deepEqual(authedQuery.json(), expected);

    delete process.env.HOLDUP_KEY;
    const corruptHttp = useTempLedger("http-corrupt");
    fs.writeFileSync(corruptHttp, "{\"ts\":1,\"feature\":\n", "utf8");
    const degraded = await httpJson({ port, path: "/api/stats" });
    assert.equal(degraded.status, 200);
    assert.deepEqual(degraded.json(), { since: null, total: 0, features: {} });
  } finally {
    await closeServer(server);
  }
});
