import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Profile } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { LABEL_SCHEMA, readLabel, toLabelRead, verify } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";
const tempLedger = path.join(os.tmpdir(), `holdup-verify-unit-${process.pid}.jsonl`);
env.ledgerPath = tempLedger;

after(() => {
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

const CHAIN = ["model-primary", "model-fallback-2", "model-fallback-3"];

function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.94 },
    dosing: { value: "1 tablet once daily", confidence: 0.9 },
    expiry: { value: "2027-08", confidence: 0.91 },
    allergens: { value: [], confidence: 0.85 },
    barcode: { value: "6432100012345", confidence: 0.88 },
    readability: 0.93,
    ...overrides,
  });
}

function collectKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

function errWithStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

test("LABEL_SCHEMA has zero $ref, $defs, or $comment remaining after inlineRefs", () => {
  const keys = collectKeys(LABEL_SCHEMA);
  assert.equal(keys.has("$ref"), false);
  assert.equal(keys.has("$defs"), false);
  assert.equal(keys.has("$comment"), false);

  const raw = JSON.stringify(LABEL_SCHEMA);
  assert.equal(raw.includes("$ref"), false);
  assert.equal(raw.includes("$defs"), false);
  assert.equal(raw.includes("$comment"), false);

  assert.equal(LABEL_SCHEMA.type, "object");
  assert.equal(LABEL_SCHEMA.properties.strength.type, "object");
  assert.deepEqual(LABEL_SCHEMA.properties.strength.required, ["value", "confidence"]);
  assert.deepEqual(LABEL_SCHEMA.properties.product.properties.value.type, ["string", "null"]);
});

test("toLabelRead normalises comma decimals to dots and trims extra whitespace in strength.value", () => {
  const simple = toLabelRead({
    kind: "medication",
    strength: { value: "2,5 mg", confidence: 0.95 },
  });
  assert.equal(simple.strength.value, "2.5 mg");
  assert.equal(simple.strength.confidence, 0.95);

  const spaced = toLabelRead({
    kind: "medication",
    strength: { value: "  2,5   mg  ", confidence: 0.91 },
  });
  assert.equal(spaced.strength.value, "2.5 mg");

  const combo = toLabelRead({
    kind: "medication",
    strength: { value: "  0,5  mg  +  12,5   mg ", confidence: 0.9 },
  });
  assert.equal(combo.strength.value, "0.5 mg + 12.5 mg");

  const blank = toLabelRead({
    kind: "medication",
    strength: { value: "   ", confidence: 0.95 },
  });
  assert.equal(blank.strength.value, null);
  assert.ok(blank.strength.confidence <= 0.3);
});

test("toLabelRead handles malformed inputs, caps non-ISO expiry confidence, and truncates guidance", () => {
  assert.equal(toLabelRead(null).kind, "unreadable");
  assert.equal(toLabelRead(undefined).kind, "unreadable");
  assert.equal(toLabelRead(42).kind, "unreadable");

  const longGuidance = `  ${"Turn the box slowly ".repeat(10)}  `;
  const r = toLabelRead({
    kind: "medication",
    expiry: { value: "08/2027", confidence: 0.95 },
    guidance: longGuidance,
    readability: 1.5,
  });
  assert.equal(r.expiry.value, "08/2027");
  assert.equal(r.expiry.confidence, 0.5);
  assert.equal(r.readability, 1);
  assert.ok(r.guidance && r.guidance.length <= 120);

  const iso = toLabelRead({
    kind: "medication",
    expiry: { value: "2027-08-15", confidence: 0.95 },
  });
  assert.equal(iso.expiry.confidence, 0.95);
});

test("readLabel with empty frames returns unreadable in 0 attempts without calling generateFn", async () => {
  let calls = 0;
  const res = await readLabel([], "what is this?", "verify_test", {
    chain: CHAIN,
    generateFn: async () => {
      calls++;
      return { text: validJson() };
    },
  });
  assert.equal(calls, 0);
  assert.equal(res.attempts, 0);
  assert.equal(res.model, null);
  assert.equal(res.latencyMs, 0);
  assert.equal(res.read.kind, "unreadable");
});

test("readLabel primary model succeeds on attempt 1 and returns parsed LabelRead", async () => {
  const seen: { model: string; parts: unknown[]; aborted: boolean }[] = [];
  const res = await readLabel(["frameA", "frameB"], "  Is this my pill?  ", "verify_test", {
    chain: CHAIN,
    generateFn: async (model, parts, signal) => {
      seen.push({ model, parts, aborted: signal.aborted });
      return {
        text: validJson({ strength: { value: "2,5 mg", confidence: 0.96 } }),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
      };
    },
  });

  assert.equal(res.attempts, 1);
  assert.equal(res.model, "model-primary");
  assert.equal(res.read.kind, "medication");
  assert.equal(res.read.ingredient.value, "amlodipine");
  assert.equal(res.read.strength.value, "2.5 mg");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "model-primary");
  assert.equal(seen[0].aborted, false);
  assert.deepEqual(seen[0].parts, [
    { inlineData: { mimeType: "image/jpeg", data: "frameA" } },
    { inlineData: { mimeType: "image/jpeg", data: "frameB" } },
    { text: 'The person asked: "Is this my pill?"' },
  ]);
});

test("readLabel retries same primary model once on transient timeout and succeeds on attempt 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) {
        const err = new Error("request timed out");
        err.name = "AbortError";
        throw err;
      }
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-primary");
  assert.deepEqual(models, ["model-primary", "model-primary"]);
  assert.equal(res.read.product.value, "Norvasc");
});

test("readLabel retries same primary model once on transient 503 error and succeeds on attempt 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) throw errWithStatus("503 UNAVAILABLE", 503);
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-primary");
  assert.deepEqual(models, ["model-primary", "model-primary"]);
});

test("readLabel retries same primary model once on SyntaxError bad JSON and succeeds on attempt 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) return { text: "{truncated_json:" };
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-primary");
  assert.deepEqual(models, ["model-primary", "model-primary"]);
});

test("readLabel retries same primary model once on empty reply and succeeds on attempt 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) return { text: "   " };
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-primary");
  assert.deepEqual(models, ["model-primary", "model-primary"]);
});

test("readLabel falls through to fallback model 2 after primary model fails twice", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length <= 2) throw errWithStatus("503 service unavailable", 503);
      return { text: validJson({ product: { value: "Burana", confidence: 0.92 } }) };
    },
  });

  assert.equal(res.attempts, 3);
  assert.equal(res.model, "model-fallback-2");
  assert.deepEqual(models, ["model-primary", "model-primary", "model-fallback-2"]);
  assert.equal(res.read.product.value, "Burana");
});

test("readLabel skips same-model retry on 404 not_found and immediately tries model 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) throw errWithStatus("404 NOT_FOUND: model no longer available", 404);
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-fallback-2");
  assert.deepEqual(models, ["model-primary", "model-fallback-2"]);
});

test("readLabel skips same-model retry on 400 bad_request and immediately tries model 2", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) throw errWithStatus("400 INVALID_ARGUMENT", 400);
      return { text: validJson() };
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-fallback-2");
  assert.deepEqual(models, ["model-primary", "model-fallback-2"]);
});

test("readLabel quota 429 triggers sleepFn backoff and advances immediately to model 2", async () => {
  const models: string[] = [];
  const slept: number[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    sleepFn: async (ms) => {
      slept.push(ms);
    },
    generateFn: async (model) => {
      models.push(model);
      if (models.length === 1) throw errWithStatus("429 RESOURCE_EXHAUSTED: quota exceeded", 429);
      return { text: validJson() };
    },
  });

  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 0 && slept[0] <= 1000);
  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-fallback-2");
  assert.deepEqual(models, ["model-primary", "model-fallback-2"]);
});

test("readLabel aborts hung call via AbortSignal when timeoutMs elapses and succeeds on retry", async () => {
  const models: string[] = [];
  const res = await readLabel(["frame1"], undefined, "verify_test", {
    chain: CHAIN,
    timeoutMs: 15,
    generateFn: (model, _parts, signal) => {
      models.push(model);
      if (models.length === 1) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return Promise.resolve({ text: validJson() });
    },
  });

  assert.equal(res.attempts, 2);
  assert.equal(res.model, "model-primary");
  assert.deepEqual(models, ["model-primary", "model-primary"]);
});

test("verify forces verdict.level unsure and appends reader unavailable when all models fail", async () => {
  const models: string[] = [];
  const profile: Profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };

  const res = await verify(["f1", "f2"], profile, "can I take this?", "verify_test", {
    chain: CHAIN,
    generateFn: async (model) => {
      models.push(model);
      throw errWithStatus("503 UNAVAILABLE", 503);
    },
  });

  assert.deepEqual(models, ["model-primary", "model-primary", "model-fallback-2", "model-fallback-3"]);
  assert.equal(res.model, null);
  assert.equal(res.frames, 2);
  assert.equal(res.verdict.level, "unsure");
  assert.ok(res.verdict.reasons.includes("reader unavailable"));
  assert.equal(res.verdict.reasons.at(-1), "reader unavailable");
  assert.match(res.verdict.speech, /couldn't reach the reader/i);
});

test("verify caps frames at 3 and matches medication with comma-decimal strength normalised to dot", async () => {
  let receivedImageParts = 0;
  const profile: Profile = {
    meds: [{ id: "bis", name: "Emconcor", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["morning"] }],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };

  const res = await verify(["f1", "f2", "f3", "f4", "f5"], profile, "is this my morning pill?", "verify_test", {
    chain: CHAIN,
    generateFn: async (_model, parts) => {
      receivedImageParts = parts.filter((p: any) => p.inlineData).length;
      return {
        text: validJson({
          product: { value: "Emconcor", confidence: 0.95 },
          ingredient: { value: "bisoprolol", confidence: 0.96 },
          strength: { value: "  2,5  mg ", confidence: 0.94 },
        }),
      };
    },
  });

  assert.equal(receivedImageParts, 3);
  assert.equal(res.frames, 3);
  assert.equal(res.model, "model-primary");
  assert.equal(res.verdict.level, "match");
  assert.equal(res.verdict.matchedMedId, "bis");
  assert.equal(res.verdict.read.strength.value, "2.5 mg");
  assert.match(res.verdict.speech, /Bisoprolol 2\.5 mg/);
});
