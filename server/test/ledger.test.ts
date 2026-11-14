import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/env.ts";
import { ledger, stats, usage } from "../src/ledger.ts";

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-ledger-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("stats returns empty summary when ledger file is missing, empty, or blank", () => {
  withTempDir((dir) => {
    const missing = path.join(dir, "missing", "ledger.jsonl");
    assert.deepEqual(stats(missing), { since: null, total: 0, features: {} });

    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    assert.deepEqual(stats(empty), { since: null, total: 0, features: {} });

    const blank = path.join(dir, "blank.jsonl");
    fs.writeFileSync(blank, "\n   \n\r\n");
    assert.deepEqual(stats(blank), { since: null, total: 0, features: {} });
  });
});

test("usage extracts token counts across generateContent metadata shape variants", () => {
  assert.deepEqual(usage(undefined), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage(null), { in: 0, out: 0, thinking: 0, cached: 0 });
  assert.deepEqual(usage({}), { in: 0, out: 0, thinking: 0, cached: 0 });

  assert.deepEqual(
    usage({
      promptTokenCount: 120,
      candidatesTokenCount: 45,
      thoughtsTokenCount: 30,
      cachedContentTokenCount: 80,
    }),
    { in: 120, out: 45, thinking: 30, cached: 80 },
  );

  assert.deepEqual(
    usage({
      promptTokenCount: 64,
      responseTokenCount: 19,
      thoughtsTokenCount: 7,
      cachedContentTokenCount: 12,
    }),
    { in: 64, out: 19, thinking: 7, cached: 12 },
  );

  assert.deepEqual(
    usage({
      promptTokenCount: 10,
      candidatesTokenCount: 15,
      responseTokenCount: 99,
    }),
    { in: 10, out: 15, thinking: 0, cached: 0 },
  );

  assert.deepEqual(
    usage({
      promptTokenCount: 10,
      candidatesTokenCount: 0,
      responseTokenCount: 99,
    }),
    { in: 10, out: 0, thinking: 0, cached: 0 },
  );
});

test("ledger and stats aggregate verify, tts, and live features accurately", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "nested", "logs", "ledger.jsonl");

    ledger(
      {
        ts: 1700000001000,
        feature: "verify",
        model: "gemini-2.5-flash",
        latency_s: 0.4,
        ok: true,
        in: 500,
        out: 80,
        thinking: 40,
        cached: 100,
      },
      file,
    );
    ledger(
      {
        ts: 1700000002000,
        feature: "verify",
        model: "gemini-2.5-flash",
        latency_s: 0.6,
        ok: true,
        in: 520,
        out: 90,
        thinking: 50,
      },
      file,
    );
    ledger(
      {
        ts: 1700000003000,
        feature: "verify",
        model: "gemini-2.5-flash",
        latency_s: 0.8,
        ok: true,
        in: 480,
        out: 70,
        thinking: 30,
      },
      file,
    );
    ledger(
      {
        ts: 1700000004000,
        feature: "verify",
        model: "gemini-2.5-pro",
        latency_s: 2.1,
        ok: true,
        in: 600,
        out: 110,
        thinking: 120,
      },
      file,
    );
    ledger(
      {
        ts: 1700000005000,
        feature: "verify",
        model: "gemini-2.5-pro",
        latency_s: 5.0,
        ok: false,
        error: "timeout",
      },
      file,
    );

    ledger(
      {
        ts: 1700000006000,
        feature: "tts",
        model: "gemini-2.5-flash-preview-tts",
        latency_s: 0.31,
        ok: true,
        in: 25,
        out: 180,
      },
      file,
    );
    ledger(
      {
        ts: 1700000007000,
        feature: "tts",
        model: "gemini-2.5-flash-preview-tts",
        latency_s: 0.49,
        ok: true,
        in: 30,
        out: 220,
      },
      file,
    );
    ledger(
      {
        ts: 1700000008000,
        feature: "tts",
        model: "gemini-2.5-flash-preview-tts",
        latency_s: 1.2,
        ok: false,
      },
      file,
    );

    ledger(
      {
        ts: 1700000009000,
        feature: "live",
        model: "gemini-live-2.5-flash",
        latency_s: 12.4,
        ok: true,
        in: 300,
        out: 150,
        thinking: 20,
        first_audio_s: 0.42,
        tool_calls: 2,
        tool_latencies_s: [0.55, 0.75],
      },
      file,
    );
    ledger(
      {
        ts: 1700000010000,
        feature: "live",
        model: "gemini-live-2.5-flash",
        latency_s: 18.2,
        ok: true,
        in: 400,
        out: 210,
        thinking: 35,
        first_audio_s: 0.68,
        tool_calls: 1,
        tool_latencies_s: [1.25],
      },
      file,
    );
    ledger(
      {
        ts: 1700000011000,
        feature: "live",
        model: "gemini-live-2.5-flash",
        latency_s: 9.1,
        ok: true,
        in: 150,
        out: 90,
        thinking: 10,
        first_audio_s: null,
        tool_calls: 1,
        tool_latencies_s: [0.35],
      },
      file,
    );
    ledger(
      {
        ts: 1700000012000,
        feature: "live",
        model: "none",
        latency_s: 1.5,
        ok: false,
        first_audio_s: 9.9,
        tool_calls: 9,
        tool_latencies_s: [9.9],
      },
      file,
    );

    assert.deepEqual(stats(file), {
      since: 1700000001000,
      total: 12,
      features: {
        verify: {
          calls: 5,
          ok: 4,
          errors: 1,
          latency_p50_s: 0.8,
          latency_p95_s: 2.1,
          tokens_in: 2100,
          tokens_out: 350,
          tokens_thinking: 240,
          models: {
            "gemini-2.5-flash": 3,
            "gemini-2.5-pro": 2,
          },
        },
        tts: {
          calls: 3,
          ok: 2,
          errors: 1,
          latency_p50_s: 0.49,
          latency_p95_s: 0.49,
          tokens_in: 55,
          tokens_out: 400,
          tokens_thinking: 0,
          models: {
            "gemini-2.5-flash-preview-tts": 3,
          },
        },
        live: {
          calls: 4,
          ok: 3,
          errors: 1,
          latency_p50_s: 12.4,
          latency_p95_s: 18.2,
          tokens_in: 850,
          tokens_out: 450,
          tokens_thinking: 65,
          models: {
            "gemini-live-2.5-flash": 3,
            none: 1,
          },
          first_audio_p50_s: 0.68,
          first_audio_p95_s: 0.68,
          tool_p50_s: 0.75,
          tool_p95_s: 1.25,
          tool_calls: 4,
        },
      },
    });
  });
});

test("stats skips corrupted and partial JSONL lines without discarding valid entries", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "corrupted.jsonl");

    ledger(
      {
        ts: 1700000100000,
        feature: "verify",
        model: "gemini-2.5-flash",
        latency_s: 0.5,
        ok: true,
        in: 200,
        out: 40,
        thinking: 15,
      },
      file,
    );

    fs.appendFileSync(
      file,
      [
        '{"ts":1700000101000,"feature":"verify","model":"gemini-2.5-f',
        "<<<corrupted-write>>>",
        "null",
        "42",
        '{"ts":1700000102000}',
        "",
      ].join("\n"),
    );

    ledger(
      {
        ts: 1700000103000,
        feature: "tts",
        model: "gemini-2.5-flash-preview-tts",
        latency_s: 0.35,
        ok: true,
        in: 20,
        out: 100,
      },
      file,
    );

    ledger(
      {
        ts: 1700000104000,
        feature: "live",
        model: "gemini-live-2.5-flash",
        latency_s: 8.5,
        ok: true,
        in: 120,
        out: 60,
        first_audio_s: 0.51,
        tool_calls: 1,
        tool_latencies_s: [0.44],
      },
      file,
    );

    fs.appendFileSync(file, '{"ts":1700000105000,"feature":"live"');

    assert.deepEqual(stats(file), {
      since: 1700000100000,
      total: 3,
      features: {
        verify: {
          calls: 1,
          ok: 1,
          errors: 0,
          latency_p50_s: 0.5,
          latency_p95_s: 0.5,
          tokens_in: 200,
          tokens_out: 40,
          tokens_thinking: 15,
          models: { "gemini-2.5-flash": 1 },
        },
        tts: {
          calls: 1,
          ok: 1,
          errors: 0,
          latency_p50_s: 0.35,
          latency_p95_s: 0.35,
          tokens_in: 20,
          tokens_out: 100,
          tokens_thinking: 0,
          models: { "gemini-2.5-flash-preview-tts": 1 },
        },
        live: {
          calls: 1,
          ok: 1,
          errors: 0,
          latency_p50_s: 8.5,
          latency_p95_s: 8.5,
          tokens_in: 120,
          tokens_out: 60,
          tokens_thinking: 0,
          models: { "gemini-live-2.5-flash": 1 },
          first_audio_p50_s: 0.51,
          first_audio_p95_s: 0.51,
          tool_p50_s: 0.44,
          tool_p95_s: 0.44,
          tool_calls: 1,
        },
      },
    });
  });
});

test("ledger and stats default to env.ledgerPath and ignore write errors cleanly", () => {
  withTempDir((dir) => {
    const prev = env.ledgerPath;
    const defaultFile = path.join(dir, "default", "ledger.jsonl");
    try {
      env.ledgerPath = defaultFile;
      ledger({
        feature: "verify",
        model: "gemini-2.5-flash",
        latency_s: 0.25,
        ok: true,
        in: 10,
        out: 5,
      });
      const res = stats();
      assert.equal(typeof res.since, "number");
      assert.equal(res.total, 1);
      assert.deepEqual(res.features, {
        verify: {
          calls: 1,
          ok: 1,
          errors: 0,
          latency_p50_s: 0.25,
          latency_p95_s: 0.25,
          tokens_in: 10,
          tokens_out: 5,
          tokens_thinking: 0,
          models: { "gemini-2.5-flash": 1 },
        },
      });
    } finally {
      env.ledgerPath = prev;
    }

    assert.doesNotThrow(() => {
      ledger({ feature: "verify", model: "gemini-2.5-flash", latency_s: 0.1, ok: true }, dir);
    });
  });
});
