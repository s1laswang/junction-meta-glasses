import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, getOrCreateHub, hubStats, latestHub, markLatest, resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { FrameRing } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";
const tempLedger = path.join(os.tmpdir(), `holdup-verify-fanout-${process.pid}.jsonl`);

let server: http.Server;
let baseUrl = "";
let wsBase = "";
let prevApiKey = "";
let prevLedger = "";
let origGenerateContent: typeof ai.models.generateContent;
let mockGenerateImpl: ((params: any) => Promise<any>) | null = null;
let generateCalls = 0;

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
  origGenerateContent = ai.models.generateContent.bind(ai.models);
  (ai.models as any).generateContent = async (params: any) => {
    generateCalls++;
    if (!mockGenerateImpl) {
      throw new Error("unexpected generateContent invocation without mock");
    }
    return mockGenerateImpl(params);
  };
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
  mockGenerateImpl = null;
  generateCalls = 0;
});

afterEach(() => {
  mockGenerateImpl = null;
  resetHubsForTest();
});

after(async () => {
  resetHubsForTest();
  (ai.models as any).generateContent = origGenerateContent;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

function openWs(url: string) {
  const ws = new WebSocket(url);
  const queue: ServerMsg[] = [];
  const waiters: ((msg: ServerMsg) => void)[] = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    const w = waiters.shift();
    if (w) w(parsed);
    else queue.push(parsed);
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (timeoutMs = 2000): Promise<ServerMsg> => {
    const item = queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  return { ws, queue, ready, next, close };
}

async function closeHttpServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function labelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.94 },
    dosing: { value: "1 tablet daily", confidence: 0.9 },
    expiry: { value: "2027-08", confidence: 0.92 },
    allergens: { value: [], confidence: 0.85 },
    barcode: { value: null, confidence: 0 },
    readability: 0.94,
    ...overrides,
  });
}

const twoMedProfile: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "met", name: "Metforem", ingredient: "metformin", strength: "500 mg", schedule: ["morning"] },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

test("POST /api/verify rejects missing, non-array, non-string, and <=100-char frames with 400 bad_input and 0 model calls", async () => {
  const invalidPayloads = [
    {},
    { frames: null },
    { frames: "a".repeat(250) },
    { frames: [null, 42, true, { data: "a".repeat(200) }, "", "a".repeat(100)] },
  ];

  for (const payload of invalidPayloads) {
    const res = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      type: "error",
      code: "bad_input",
      message: "frames[] (base64 JPEG) required",
      recoverable: true,
    });
  }
  assert.equal(generateCalls, 0);

  let capturedParts: any[] = [];
  mockGenerateImpl = async (params) => {
    capturedParts = params.contents[0].parts;
    return { text: labelJson() };
  };

  const boundary101 = "x".repeat(101);
  const okRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [boundary101], profile: twoMedProfile, question: 999 }),
  });
  assert.equal(okRes.status, 200);
  const verdict = (await okRes.json()) as Verdict;
  assert.equal(verdict.level, "match");
  assert.equal(verdict.matchedMedId, "aml");
  assert.equal(generateCalls, 1);
  assert.deepEqual(capturedParts, [
    { inlineData: { mimeType: "image/jpeg", data: boundary101 } },
    { text: "Read this label." },
  ]);
});

test("POST /api/verify filters junk entries, slices last 3 valid frames, and picks top-2 largest in descending order", async () => {
  const seenCalls: { frames: string[]; prompt: string }[] = [];
  mockGenerateImpl = async (params) => {
    const parts = params.contents[0].parts as any[];
    const frames = parts.filter((p) => p.inlineData).map((p) => String(p.inlineData.data));
    const prompt = String(parts.find((p) => typeof p.text === "string")?.text ?? "");
    seenCalls.push({ frames, prompt });
    return { text: labelJson() };
  };

  const staleHuge1 = `1${"A".repeat(949)}`;
  const staleHuge2 = `2${"B".repeat(849)}`;
  const recentMid = `3${"C".repeat(319)}`;
  const recentSmall = `4${"D".repeat(179)}`;
  const recentLargest = `5${"E".repeat(609)}`;
  const overlongQuestion = `  ${"Q".repeat(340)}  `;

  const resFive = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [staleHuge1, "too-short", staleHuge2, recentMid, null, recentSmall, 123, recentLargest, "z".repeat(100)],
      profile: twoMedProfile,
      question: overlongQuestion,
    }),
  });
  assert.equal(resFive.status, 200);
  assert.equal(seenCalls.length, 1);
  assert.deepEqual(seenCalls[0].frames, [recentLargest, recentMid]);
  assert.equal(seenCalls[0].prompt, `The person asked: "${"Q".repeat(300)}"`);

  const twoSmall = `S${"a".repeat(149)}`;
  const twoLarge = `L${"b".repeat(419)}`;
  const resTwo = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [twoSmall, twoLarge], profile: twoMedProfile }),
  });
  assert.equal(resTwo.status, 200);
  assert.deepEqual(seenCalls[1].frames, [twoLarge, twoSmall]);

  const tieFirst = `F${"m".repeat(399)}`;
  const tieTiny = `T${"n".repeat(149)}`;
  const tieSecond = `G${"p".repeat(399)}`;
  const resTie = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [staleHuge1, tieFirst, tieTiny, tieSecond], profile: twoMedProfile }),
  });
  assert.equal(resTie.status, 200);
  assert.deepEqual(seenCalls[2].frames, [tieFirst, tieSecond]);
});

test("FrameRing.pick selects top-2 sharpest within windowMs, breaks ties by newest ts, and falls back to slice(-3)", () => {
  const ring = new FrameRing(8);
  assert.deepEqual(ring.pick(2, 5000, 10_000), []);

  for (let i = 1; i <= 10; i++) {
    ring.push({
      data: `frame-${i}`,
      sharpness: i === 3 ? 0.99 : 0.1 * (i % 5),
      ts: i * 1000,
      bytes: 1000 + i,
      source: "glasses",
    });
  }
  assert.equal(ring.length, 8);
  assert.equal(ring.lastTs, 10_000);

  const windowRing = new FrameRing(8);
  windowRing.push({ data: "stale-ultra-sharp", sharpness: 0.99, ts: 1000, bytes: 900, source: "glasses" });
  windowRing.push({ data: "recent-tie-older", sharpness: 0.82, ts: 6000, bytes: 700, source: "glasses" });
  windowRing.push({ data: "recent-low", sharpness: 0.35, ts: 7000, bytes: 400, source: "phone" });
  windowRing.push({ data: "recent-tie-newer", sharpness: 0.82, ts: 8000, bytes: 710, source: "phone" });
  windowRing.push({ data: "recent-best", sharpness: 0.91, ts: 9000, bytes: 820, source: "glasses" });

  const pickedRecent = windowRing.pick(2, 5000, 10_000);
  assert.deepEqual(
    pickedRecent.map((f) => f.data),
    ["recent-best", "recent-tie-newer"],
  );

  const tiePicked = windowRing.pick(3, 5000, 10_000);
  assert.deepEqual(
    tiePicked.map((f) => f.data),
    ["recent-best", "recent-tie-newer", "recent-tie-older"],
  );

  const fallbackPicked = windowRing.pick(2, 1500, 10_000);
  assert.deepEqual(
    fallbackPicked.map((f) => f.data),
    ["recent-best", "recent-tie-newer"],
  );
});

test("POST /api/verify with explicit non-latest session fans out only to that session's /hud-ws without leaking to markLatest or floating /hud-ws", async () => {
  let activeIngredient = "amlodipine";
  let activeStrength = "5 mg";
  let activeProduct = "Norvasc";
  mockGenerateImpl = async () => ({
    text: labelJson({
      product: { value: activeProduct, confidence: 0.96 },
      ingredient: { value: activeIngredient, confidence: 0.95 },
      strength: { value: activeStrength, confidence: 0.94 },
    }),
  });

  const liveAlpha = openWs(`${wsBase}/live?session=session-alpha`);
  const liveBeta = openWs(`${wsBase}/live?session=session-beta`);
  await Promise.all([liveAlpha.ready, liveBeta.ready]);

  const hubAlpha = getOrCreateHub("session-alpha");
  const hubBeta = getOrCreateHub("session-beta");
  markLatest(hubBeta);
  assert.deepEqual(await liveBeta.next(), { type: "hud", connected: false });

  const hudAlpha = openWs(`${wsBase}/hud-ws?session=session-alpha`);
  await hudAlpha.ready;
  assert.deepEqual(await liveAlpha.next(), { type: "hud", connected: true });

  const hudBeta = openWs(`${wsBase}/hud-ws?session=session-beta`);
  await hudBeta.ready;
  assert.deepEqual(await liveBeta.next(), { type: "hud", connected: true });

  const hudFloating = openWs(`${wsBase}/hud-ws`);
  await hudFloating.ready;
  assert.deepEqual(await liveBeta.next(), { type: "hud", connected: true });

  try {
    const resAlpha = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "session-alpha",
        frames: ["A".repeat(220)],
        profile: twoMedProfile,
      }),
    });
    assert.equal(resAlpha.status, 200);
    const alphaVerdict = (await resAlpha.json()) as Verdict;
    assert.equal(alphaVerdict.matchedMedId, "aml");

    const alphaHudMsg = await hudAlpha.next();
    assert.deepEqual(alphaHudMsg, { type: "verdict", verdict: alphaVerdict });
    assert.deepEqual(hubAlpha.lastVerdict, alphaVerdict);
    assert.equal(hubBeta.lastVerdict, undefined);

    activeProduct = "Metforem";
    activeIngredient = "metformin";
    activeStrength = "500 mg";
    const resBeta = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frames: ["B".repeat(220)],
        profile: twoMedProfile,
      }),
    });
    assert.equal(resBeta.status, 200);
    const betaVerdict = (await resBeta.json()) as Verdict;
    assert.equal(betaVerdict.matchedMedId, "met");

    const [betaHudMsg, floatingHudMsg] = await Promise.all([hudBeta.next(), hudFloating.next()]);
    assert.deepEqual(betaHudMsg, { type: "verdict", verdict: betaVerdict });
    assert.deepEqual(floatingHudMsg, { type: "verdict", verdict: betaVerdict });
    assert.equal(hudAlpha.queue.length, 0);

    liveAlpha.ws.send(JSON.stringify({ type: "ping", t: 11 }));
    liveBeta.ws.send(JSON.stringify({ type: "ping", t: 22 }));
    assert.deepEqual(await liveAlpha.next(), { type: "pong", t: 11 });
    assert.deepEqual(await liveBeta.next(), { type: "pong", t: 22 });
  } finally {
    await Promise.all([liveAlpha.close(), liveBeta.close(), hudAlpha.close(), hudBeta.close(), hudFloating.close()]);
  }
});

test("POST /api/verify with non-string session and dynamic markLatest switch routes and replays accurately across HUDs", async () => {
  let callIndex = 0;
  mockGenerateImpl = async () => {
    callIndex++;
    if (callIndex === 1) {
      return {
        text: labelJson({
          product: { value: "Norvasc", confidence: 0.96 },
          ingredient: { value: "amlodipine", confidence: 0.95 },
          strength: { value: "5 mg", confidence: 0.94 },
        }),
      };
    }
    return {
      text: labelJson({
        product: { value: "Metforem", confidence: 0.96 },
        ingredient: { value: "metformin", confidence: 0.95 },
        strength: { value: "500 mg", confidence: 0.94 },
      }),
    };
  };

  const hubA = getOrCreateHub("switch-a");
  const hubB = getOrCreateHub("switch-b");
  markLatest(hubA);

  const hudA = openWs(`${wsBase}/hud-ws?session=switch-a`);
  const hudB = openWs(`${wsBase}/hud-ws?session=switch-b`);
  const hudFloating = openWs(`${wsBase}/hud-ws`);
  await Promise.all([hudA.ready, hudB.ready, hudFloating.ready]);

  try {
    const resNonStringSession = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: 12345,
        frames: ["C".repeat(210)],
        profile: twoMedProfile,
      }),
    });
    assert.equal(resNonStringSession.status, 200);
    const verdict1 = (await resNonStringSession.json()) as Verdict;
    assert.equal(verdict1.matchedMedId, "aml");

    const [msgA1, msgFloat1] = await Promise.all([hudA.next(), hudFloating.next()]);
    assert.deepEqual(msgA1, { type: "verdict", verdict: verdict1 });
    assert.deepEqual(msgFloat1, { type: "verdict", verdict: verdict1 });
    assert.equal(hudB.queue.length, 0);

    const resExplicitB = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "switch-b",
        frames: ["D".repeat(210)],
        profile: twoMedProfile,
      }),
    });
    assert.equal(resExplicitB.status, 200);
    const verdict2 = (await resExplicitB.json()) as Verdict;
    assert.equal(verdict2.matchedMedId, "met");

    assert.deepEqual(await hudB.next(), { type: "verdict", verdict: verdict2 });
    assert.equal(hudFloating.queue.length, 0);

    markLatest(hubB);
    assert.deepEqual(await hudFloating.next(), { type: "verdict", verdict: verdict2 });
  } finally {
    await Promise.all([hudA.close(), hudB.close(), hudFloating.close()]);
  }
});

test("POST /api/verify with unknown session or zero active hubs returns 200 Verdict without creating ghost hubs or leaking to floating /hud-ws", async () => {
  mockGenerateImpl = async () => ({ text: labelJson() });

  const hudOrphanFloating = openWs(`${wsBase}/hud-ws`);
  await hudOrphanFloating.ready;

  try {
    assert.equal(latestHub(), undefined);
    assert.equal(hubStats().sessions, 0);

    const noHubRes = await fetch(`${baseUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: ["E".repeat(180)], profile: twoMedProfile }),
    });
    assert.equal(noHubRes.status, 200);
    const noHubVerdict = (await noHubRes.json()) as Verdict;
    assert.equal(noHubVerdict.matchedMedId, "aml");
    assert.equal(hubStats().sessions, 0);
    assert.equal(hudOrphanFloating.queue.length, 0);

    const activeHub = getOrCreateHub("known-session");
    markLatest(activeHub);
    const hudKnown = openWs(`${wsBase}/hud-ws?session=known-session`);
    await hudKnown.ready;

    try {
      const ghostRes = await fetch(`${baseUrl}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: "ghost-nonexistent",
          frames: ["F".repeat(180)],
          profile: twoMedProfile,
        }),
      });
      assert.equal(ghostRes.status, 200);
      const ghostVerdict = (await ghostRes.json()) as Verdict;
      assert.equal(ghostVerdict.matchedMedId, "aml");
      assert.equal(getHub("ghost-nonexistent"), undefined);
      assert.equal(hubStats().sessions, 1);
      assert.equal(activeHub.lastVerdict, undefined);
      assert.equal(hudKnown.queue.length, 0);
      assert.equal(hudOrphanFloating.queue.length, 0);
    } finally {
      await hudKnown.close();
    }
  } finally {
    await hudOrphanFloating.close();
  }
});

test("late-joining session-specific vs session-less /hud-ws replay and log_dose events stay isolated per hub", async () => {
  let n = 0;
  mockGenerateImpl = async () => {
    n++;
    if (n === 1) {
      return {
        text: labelJson({
          product: { value: "Norvasc", confidence: 0.96 },
          ingredient: { value: "amlodipine", confidence: 0.95 },
          strength: { value: "5 mg", confidence: 0.94 },
        }),
      };
    }
    return {
      text: labelJson({
        product: { value: "Metforem", confidence: 0.96 },
        ingredient: { value: "metformin", confidence: 0.95 },
        strength: { value: "500 mg", confidence: 0.94 },
      }),
    };
  };

  const liveAlpha = openWs(`${wsBase}/live?session=iso-alpha`);
  const liveBeta = openWs(`${wsBase}/live?session=iso-beta`);
  await Promise.all([liveAlpha.ready, liveBeta.ready]);

  const hubAlpha = getOrCreateHub("iso-alpha");
  const hubBeta = getOrCreateHub("iso-beta");
  markLatest(hubBeta);
  assert.deepEqual(await liveBeta.next(), { type: "hud", connected: false });

  const resAlpha = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "iso-alpha", frames: ["G".repeat(200)], profile: twoMedProfile }),
  });
  const alphaVerdict = (await resAlpha.json()) as Verdict;
  assert.equal(alphaVerdict.matchedMedId, "aml");

  const resBeta = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: ["H".repeat(200)], profile: twoMedProfile }),
  });
  const betaVerdict = (await resBeta.json()) as Verdict;
  assert.equal(betaVerdict.matchedMedId, "met");

  const hudAlphaLate = openWs(`${wsBase}/hud-ws?session=iso-alpha`);
  const hudFloatingLate = openWs(`${wsBase}/hud-ws`);
  await Promise.all([hudAlphaLate.ready, hudFloatingLate.ready]);

  try {
    assert.deepEqual(await liveAlpha.next(), { type: "hud", connected: true });
    assert.deepEqual(await liveBeta.next(), { type: "hud", connected: true });
    assert.deepEqual(await hudAlphaLate.next(), { type: "verdict", verdict: alphaVerdict });
    assert.deepEqual(await hudFloatingLate.next(), { type: "verdict", verdict: betaVerdict });

    hudAlphaLate.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));
    const [alphaPhoneDose, alphaHudDose] = await Promise.all([liveAlpha.next(), hudAlphaLate.next()]);
    assert.deepEqual(alphaPhoneDose, { type: "verdict", verdict: { ...alphaVerdict, takenToday: true } });
    assert.deepEqual(alphaHudDose, { type: "verdict", verdict: { ...alphaVerdict, takenToday: true } });
    assert.equal(hubAlpha.profile.doseLog.length, 1);
    assert.equal(hubAlpha.profile.doseLog[0].medId, "aml");
    assert.equal(hubBeta.profile.doseLog.length, 0);
    assert.equal(hudFloatingLate.queue.length, 0);

    hudFloatingLate.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));
    const [betaPhoneDose, betaHudDose] = await Promise.all([liveBeta.next(), hudFloatingLate.next()]);
    assert.deepEqual(betaPhoneDose, { type: "verdict", verdict: { ...betaVerdict, takenToday: true } });
    assert.deepEqual(betaHudDose, { type: "verdict", verdict: { ...betaVerdict, takenToday: true } });
    assert.equal(hubBeta.profile.doseLog.length, 1);
    assert.equal(hubBeta.profile.doseLog[0].medId, "met");
    assert.equal(hubAlpha.profile.doseLog.length, 1);
    assert.equal(hudAlphaLate.queue.length, 0);
  } finally {
    await Promise.all([liveAlpha.close(), liveBeta.close(), hudAlphaLate.close(), hudFloatingLate.close()]);
  }
});

test("GET /api/eval-summary enforces response schema invariants, exact 10s cache TTL boundary, negative non-caching, and headline_metrics normalization", async () => {
  const realRes = await fetch(`${baseUrl}/api/eval-summary`);
  assert.equal(realRes.status, 200);
  const realBody = (await realRes.json()) as Record<string, any>;
  assert.equal(realBody.ok, true);
  assert.equal(typeof realBody.summary, "object");
  assert.notEqual(realBody.summary, null);
  assert.equal(typeof realBody.summary.generated_at, "string");
  assert.equal(realBody.summary.safety_invariants?.strength_min_conf, 0.8);
  assert.equal(realBody.summary.headline_metrics?.never_guess_strength_min_conf, 0.8);
  assert.equal(realBody.summary.headline_metrics?.total_confident_wrong_dose_count, 0);
  assert.equal(realBody.summary.headline_metrics?.overall_verdict_accuracy, realBody.summary.overall_verdict_accuracy);
  assert.equal(realBody.summary.headline_metrics?.occluded_abstention_rate, realBody.summary.occluded_abstention_rate);
  assert.equal(realBody.summary.headline_metrics?.total_label_cases_evaluated, realBody.summary.total_label_cases_evaluated);
  assert.ok(Array.isArray(realBody.summary.suites_present));
  assert.equal(typeof realBody.summary.deck_cards, "object");
  assert.equal(generateCalls, 0);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-eval-cache-"));
  fs.mkdirSync(path.join(tmpDir, "eval"), { recursive: true });
  const evalPath = path.join(tmpDir, "eval", "combined_summary.json");

  const tempServer = await startServer(0, { repoRoot: tmpDir });
  const { port } = tempServer.address() as AddressInfo;
  const tempBase = `http://127.0.0.1:${port}`;

  const origNow = Date.now;
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;

  try {
    const missingRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.deepEqual(await missingRes.json(), { ok: false, summary: null });

    for (const nonObjectJson of ["[1, 2, 3]", '"plain-string"', "null", "42", "{truncated"]) {
      fs.writeFileSync(evalPath, nonObjectJson, "utf8");
      const badRes = await fetch(`${tempBase}/api/eval-summary`);
      assert.equal(badRes.status, 200);
      assert.deepEqual(await badRes.json(), { ok: false, summary: null });
    }

    fs.writeFileSync(evalPath, JSON.stringify({ generated_at: "t0" }), "utf8");
    const minimalRes = await fetch(`${tempBase}/api/eval-summary`);
    const minimalBody = (await minimalRes.json()) as Record<string, any>;
    assert.equal(minimalBody.ok, true);
    assert.deepEqual(minimalBody.summary.headline_metrics, {
      overall_verdict_accuracy: null,
      total_confident_wrong_dose_count: null,
      occluded_abstention_rate: null,
      total_label_cases_evaluated: 0,
    });
    assert.equal("never_guess_strength_min_conf" in minimalBody.summary.headline_metrics, false);

    fs.writeFileSync(
      evalPath,
      JSON.stringify({
        generated_at: "t1",
        safety_invariants: { strength_min_conf: 0.8 },
        overall_verdict_accuracy: 0.96,
        total_confident_wrong_dose_count: 0,
        occluded_abstention_rate: 0.95,
        total_label_cases_evaluated: 53,
        headline_metrics: { overall_verdict_accuracy: 0.9811, extra_badge: "verified" },
      }),
      "utf8",
    );

    fakeNow = 1_700_000_010_000;
    const hitBoundaryRes = await fetch(`${tempBase}/api/eval-summary`);
    const hitBoundaryBody = (await hitBoundaryRes.json()) as Record<string, any>;
    assert.equal(hitBoundaryBody.ok, true);
    assert.equal(hitBoundaryBody.summary.generated_at, "t0");
    assert.equal(hitBoundaryBody.summary.headline_metrics.total_label_cases_evaluated, 0);

    fakeNow = 1_700_000_010_001;
    const refreshedRes = await fetch(`${tempBase}/api/eval-summary`);
    const refreshedBody = (await refreshedRes.json()) as Record<string, any>;
    assert.equal(refreshedBody.ok, true);
    assert.equal(refreshedBody.summary.generated_at, "t1");
    assert.deepEqual(refreshedBody.summary.headline_metrics, {
      never_guess_strength_min_conf: 0.8,
      overall_verdict_accuracy: 0.9811,
      total_confident_wrong_dose_count: 0,
      occluded_abstention_rate: 0.95,
      total_label_cases_evaluated: 53,
      extra_badge: "verified",
    });

    fs.writeFileSync(
      evalPath,
      JSON.stringify({
        generated_at: "t2",
        safety_invariants: { strength_min_conf: "not-a-number" },
        headline_metrics: ["unexpected-array"],
      }),
      "utf8",
    );
    fakeNow = 1_700_000_020_002;
    const arrayHmRes = await fetch(`${tempBase}/api/eval-summary`);
    const arrayHmBody = (await arrayHmRes.json()) as Record<string, any>;
    assert.equal(arrayHmBody.ok, true);
    assert.equal(Array.isArray(arrayHmBody.summary.headline_metrics), false);
    assert.equal("never_guess_strength_min_conf" in arrayHmBody.summary.headline_metrics, false);
    assert.equal(arrayHmBody.summary.headline_metrics.total_label_cases_evaluated, 0);

    fs.writeFileSync(evalPath, "[]", "utf8");
    fakeNow = 1_700_000_030_003;
    const invalidatedRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.deepEqual(await invalidatedRes.json(), { ok: false, summary: null });
    assert.equal(generateCalls, 0);
  } finally {
    Date.now = origNow;
    await closeHttpServer(tempServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
