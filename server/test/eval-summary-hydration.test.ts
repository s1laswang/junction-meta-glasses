import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { createApp, startServer } from "../src/index.ts";
import { ledger } from "../src/ledger.ts";

process.env.HOLDUP_QUIET = "1";

const TEST_FILE = fileURLToPath(import.meta.url);
const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function loopbackOrigin(port: number): string {
  return `http:${SLASH}${SLASH}127.0.0.1:${port}`;
}

interface ServerFeatureStatsShape {
  calls: number;
  ok: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  tokens_thinking?: number;
  tokens_think?: number;
  models: Record<string, number>;
  latency_p50_s: number | null;
  latency_p95_s: number | null;
  first_audio_p50_s?: number | null;
  tool_p50_s?: number | null;
  tool_calls?: number;
}

interface ServerLedgerStatsShape {
  since: number | string | null;
  total: number;
  features: Record<string, ServerFeatureStatsShape>;
}

interface EvalProofCardPropsShape {
  initialStats?: ServerLedgerStatsShape | null;
  fetchImpl?: typeof fetch;
  lang: string;
}

type EvalProofCardComponent = (props: EvalProofCardPropsShape) => unknown;

interface EvalSummaryPayload {
  ok: boolean;
  summary: Record<string, any> | null;
}

interface HealthPayload {
  ok: boolean;
  gemini: string;
  models: {
    live: string[];
    verify: string[];
    tts: string[];
  };
  version: string;
  sessions: number;
  latest: string | null;
  floatingHuds: number;
}

let createElementFn!: (type: EvalProofCardComponent, props: EvalProofCardPropsShape) => unknown;
let renderToStaticMarkupFn!: (element: unknown) => string;
let EvalProofCard!: EvalProofCardComponent;
let fetchServerLedgerStats!: (fetchImpl?: typeof fetch) => Promise<ServerLedgerStatsShape | null>;
let parseServerLedgerStats!: (raw: unknown) => ServerLedgerStatsShape | null;

const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-eval-hydration-"));
const tempLedgerPath = path.join(tempWorkDir, "ledger.jsonl");

let server: http.Server | null = null;
let baseUrl = "";
let prevApiKey = "";
let prevProcessGeminiKey: string | undefined;
let prevLedgerPath = "";
let hadGlobalReact = false;
let prevGlobalReact: unknown;
let origModelsGet: typeof ai.models.get;
let origGenerateContent: typeof ai.models.generateContent;
let origLiveConnect: typeof ai.live.connect;
let modelCallCount = 0;

async function closeServer(srv: http.Server | null | undefined): Promise<void> {
  if (!srv || !srv.listening) return;
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function createSingleOriginFetch(origin: string): typeof fetch {
  return (input, init) => {
    const resolved =
      typeof input === "string" && input.startsWith(SLASH) ? `${origin}${input}` : input;
    return globalThis.fetch(resolved, init);
  };
}

function assertApiSecurityHeaders(res: Response, routeLabel: string): void {
  assert.equal(res.headers.get("cache-control"), "no-store", `${routeLabel} must set Cache-Control: no-store`);
  assert.equal(
    res.headers.get("x-content-type-options"),
    "nosniff",
    `${routeLabel} must set X-Content-Type-Options: nosniff`,
  );
  assert.equal(
    res.headers.get("referrer-policy"),
    "no-referrer",
    `${routeLabel} must set Referrer-Policy: no-referrer`,
  );
  assert.equal(
    res.headers.get("x-frame-options"),
    "SAMEORIGIN",
    `${routeLabel} must set X-Frame-Options: SAMEORIGIN`,
  );
  assert.equal(res.headers.get("x-powered-by"), null, `${routeLabel} must omit X-Powered-By`);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  assert.equal(
    contentType.includes("application/json"),
    true,
    `${routeLabel} must return application/json content-type`,
  );
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevProcessGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedgerPath = env.ledgerPath;
  env.ledgerPath = tempLedgerPath;

  origModelsGet = ai.models.get.bind(ai.models);
  origGenerateContent = ai.models.generateContent.bind(ai.models);
  origLiveConnect = ai.live.connect.bind(ai.live);

  (ai.models as unknown as { get: () => Promise<never> }).get = async () => {
    modelCallCount++;
    throw new Error("unexpected ai.models.get call in 0-model-call suite");
  };
  (ai.models as unknown as { generateContent: () => Promise<never> }).generateContent = async () => {
    modelCallCount++;
    throw new Error("unexpected ai.models.generateContent call in 0-model-call suite");
  };
  (ai.live as unknown as { connect: () => Promise<never> }).connect = async () => {
    modelCallCount++;
    throw new Error("unexpected ai.live.connect call in 0-model-call suite");
  };

  const reactSpec = "react";
  const reactDomServerSpec = ["react-dom", "server"].join(SLASH);
  const evalCardUrl = new URL("..".concat(SLASH, "..", SLASH, "web/src/components/EvalProofCard.tsx"), import.meta.url).href;

  const reactMod = (await import(reactSpec)) as {
    default?: unknown;
    createElement: (type: EvalProofCardComponent, props: EvalProofCardPropsShape) => unknown;
  };
  hadGlobalReact = Object.prototype.hasOwnProperty.call(globalThis, "React");
  prevGlobalReact = (globalThis as Record<string, unknown>).React;
  (globalThis as Record<string, unknown>).React = reactMod.default ?? reactMod;

  const reactDomServerMod = (await import(reactDomServerSpec)) as {
    renderToStaticMarkup: (element: unknown) => string;
  };
  const evalCardMod = (await import(evalCardUrl)) as {
    EvalProofCard: EvalProofCardComponent;
    fetchServerLedgerStats: (fetchImpl?: typeof fetch) => Promise<ServerLedgerStatsShape | null>;
    parseServerLedgerStats: (raw: unknown) => ServerLedgerStatsShape | null;
  };

  createElementFn = reactMod.createElement;
  renderToStaticMarkupFn = reactDomServerMod.renderToStaticMarkup;
  EvalProofCard = evalCardMod.EvalProofCard;
  fetchServerLedgerStats = evalCardMod.fetchServerLedgerStats;
  parseServerLedgerStats = evalCardMod.parseServerLedgerStats;

  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  assert.ok(port > 0, `Expected ephemeral port > 0, got ${port}`);
  baseUrl = loopbackOrigin(port);
});

beforeEach(() => {
  resetHubsForTest();
  fs.rmSync(tempLedgerPath, { force: true });
});

after(async () => {
  resetHubsForTest();
  await closeServer(server);
  server = null;

  (ai.models as unknown as { get: typeof origModelsGet }).get = origModelsGet;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent = origGenerateContent;
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;

  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedgerPath;
  if (prevProcessGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = prevProcessGeminiKey;
  }

  if (hadGlobalReact) {
    (globalThis as Record<string, unknown>).React = prevGlobalReact;
  } else {
    delete (globalThis as Record<string, unknown>).React;
  }

  fs.rmSync(tempWorkDir, { recursive: true, force: true });
});

test("live startServer(0) GET /api/eval-summary, /api/stats, and /api/health preserve eval/combined_summary.json contract and 10s cache hit parity", async () => {
  const diskSummaryPath = path.join(REPO_ROOT, "eval", "combined_summary.json");
  const diskSummary = JSON.parse(fs.readFileSync(diskSummaryPath, "utf8")) as Record<string, any>;

  const origReadFileSync = fs.readFileSync;
  let combinedSummaryReads = 0;
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: any[]) => {
    if (typeof target === "string" && path.resolve(target) === diskSummaryPath) {
      combinedSummaryReads++;
    }
    return (origReadFileSync as (...args: any[]) => any)(target, ...rest);
  }) as typeof fs.readFileSync;

  let firstEvalBody: EvalSummaryPayload;
  let secondEvalBody: EvalSummaryPayload;
  let thirdEvalBody: EvalSummaryPayload;
  try {
    const firstEvalRes = await fetch(`${baseUrl}/api/eval-summary`);
    assert.equal(firstEvalRes.status, 200);
    assertApiSecurityHeaders(firstEvalRes, "GET /api/eval-summary (cold)");
    firstEvalBody = (await firstEvalRes.json()) as EvalSummaryPayload;

    const secondEvalRes = await fetch(`${baseUrl}/api/eval-summary`);
    assert.equal(secondEvalRes.status, 200);
    assertApiSecurityHeaders(secondEvalRes, "GET /api/eval-summary (cached #1)");
    secondEvalBody = (await secondEvalRes.json()) as EvalSummaryPayload;

    const thirdEvalRes = await fetch(`${baseUrl}/api/eval-summary`);
    assert.equal(thirdEvalRes.status, 200);
    assertApiSecurityHeaders(thirdEvalRes, "GET /api/eval-summary (cached #2)");
    thirdEvalBody = (await thirdEvalRes.json()) as EvalSummaryPayload;
  } finally {
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
  }

  assert.equal(combinedSummaryReads, 1, "Expected 10s evalCache to serve consecutive fetches without re-reading disk");
  assert.deepEqual(secondEvalBody, firstEvalBody);
  assert.deepEqual(thirdEvalBody, firstEvalBody);

  assert.equal(firstEvalBody.ok, true);
  assert.notEqual(firstEvalBody.summary, null);
  const summary = firstEvalBody.summary as Record<string, any>;

  assert.equal(summary.headline_metrics?.never_guess_strength_min_conf, 0.8);
  assert.equal(summary.headline_metrics?.total_confident_wrong_dose_count, 0);
  assert.equal(summary.headline_metrics?.overall_verdict_accuracy, diskSummary.overall_verdict_accuracy);
  assert.equal(summary.headline_metrics?.occluded_abstention_rate, diskSummary.occluded_abstention_rate);
  assert.equal(summary.headline_metrics?.total_label_cases_evaluated, diskSummary.total_label_cases_evaluated);

  for (const suiteKey of [
    "suites_present",
    "extended_suites_present",
    "wave6_suites_present",
    "wave7_suites_present",
    "wave8_suites_present",
  ] as const) {
    assert.equal(Array.isArray(diskSummary[suiteKey]), true, `Expected array in diskSummary.${suiteKey}`);
    assert.ok(diskSummary[suiteKey].length > 0, `Expected non-empty diskSummary.${suiteKey}`);
    assert.deepEqual(summary[suiteKey], diskSummary[suiteKey], `Expected /api/eval-summary to preserve ${suiteKey}`);
  }

  for (const [key, expectedVal] of Object.entries(diskSummary)) {
    if (key === "headline_metrics") continue;
    assert.deepEqual(summary[key], expectedVal, `Expected /api/eval-summary to preserve top-level key "${key}"`);
  }

  const statsRes = await fetch(`${baseUrl}/api/stats`);
  assert.equal(statsRes.status, 200);
  assertApiSecurityHeaders(statsRes, "GET /api/stats");
  const statsBody = (await statsRes.json()) as ServerLedgerStatsShape;
  assert.deepEqual(statsBody, { since: null, total: 0, features: {} });

  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assertApiSecurityHeaders(healthRes, "GET /api/health");
  const healthBody = (await healthRes.json()) as HealthPayload;
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.gemini, "down");
  assert.equal(typeof healthBody.version, "string");
  assert.ok(healthBody.version.length > 0);
  assert.deepEqual(healthBody.models, {
    live: env.liveModels,
    verify: env.verifyModels,
    tts: env.ttsModels,
  });
  assert.equal(healthBody.models.live[0], diskSummary.live_probe.primary_model);
  assert.deepEqual(
    healthBody.models.live,
    (diskSummary.live_probe.models as Array<{ model: string }>).map((m) => m.model),
  );
  assert.equal(healthBody.models.verify[0], diskSummary.calibration.model);
  assert.deepEqual(
    healthBody.models.verify,
    (diskSummary.artifacts.model_comparison.models as Array<{ model: string }>).map((m) => m.model),
  );
  assert.equal(healthBody.sessions, 0);
  assert.equal(healthBody.latest, null);
  assert.equal(healthBody.floatingHuds, 0);

  assert.equal(modelCallCount, 0);
});

test("single-origin hydration flows from live GET /api/stats, /api/eval-summary, and /api/health into SSR EvalProofCard", async () => {
  const singleOriginFetch = createSingleOriginFetch(baseUrl);

  const [evalRes, healthRes, emptyHydrated] = await Promise.all([
    singleOriginFetch("/api/eval-summary"),
    singleOriginFetch("/api/health"),
    fetchServerLedgerStats(singleOriginFetch),
  ]);

  assert.equal(evalRes.status, 200);
  assertApiSecurityHeaders(evalRes, "single-origin GET /api/eval-summary");
  const evalPayload = (await evalRes.json()) as EvalSummaryPayload;
  assert.equal(evalPayload.ok, true);
  const summary = evalPayload.summary as Record<string, any>;

  assert.equal(healthRes.status, 200);
  assertApiSecurityHeaders(healthRes, "single-origin GET /api/health");
  const healthPayload = (await healthRes.json()) as HealthPayload;
  assert.equal(healthPayload.ok, true);

  assert.deepEqual(emptyHydrated, { since: null, total: 0, features: {} });

  const minConfPct = Math.round(Number(summary.headline_metrics.never_guess_strength_min_conf) * 100);
  const eceStr = Number(summary.calibration.ece).toFixed(4);
  const coachingPassRatio = `${summary.coaching_judge.passed_all_checks}/${summary.coaching_judge.total_scenarios}`;
  const coachingScoreStr = `${Number(summary.coaching_judge.mean_overall_score).toFixed(1)}/5`;
  const defaultModelsHint = `Default: ${healthPayload.models.live[0]} + ${healthPayload.models.verify[0]}`;

  for (const locale of ["en", "fi", "sv"] as const) {
    const standbyHtml = renderToStaticMarkupFn(
      createElementFn(EvalProofCard, { initialStats: emptyHydrated, lang: locale }),
    );
    assert.equal(standbyHtml.includes(`lang="${locale}"`), true);
    assert.equal(standbyHtml.includes("Runtime Gemini Telemetry (/api/stats)"), true);
    assert.equal(standbyHtml.includes("Session Standby"), true);
    assert.equal(standbyHtml.includes("No live calls recorded in this session yet"), true);
    assert.equal(standbyHtml.includes("0 ok / 0 errors in current ledger"), true);
    assert.equal(standbyHtml.includes("0 tokens"), true);
    assert.equal(standbyHtml.includes(defaultModelsHint), true);
    assert.equal(
      standbyHtml.includes(`&gt;= ${minConfPct}% Strength Confidence Gate (ECE ${eceStr})`),
      true,
    );
    assert.equal(
      standbyHtml.includes(`${summary.headline_metrics.total_confident_wrong_dose_count} confident wrong doses`),
      true,
    );
    assert.equal(
      standbyHtml.includes(`${coachingPassRatio} Gemini Coaching &amp; Privacy Judge Pass`),
      true,
    );
    assert.equal(standbyHtml.includes(`${coachingScoreStr} mean judge score`), true);
    assert.equal(standbyHtml.includes(EM_DASH), false, `Forbidden em dash in standby SSR (${locale})`);
    assert.equal(standbyHtml.includes(EN_DASH), false, `Forbidden en dash in standby SSR (${locale})`);
  }

  const sinceTs = Date.UTC(2026, 10, 14, 14, 8, 37);
  ledger(
    {
      ts: sinceTs,
      feature: "verify",
      model: healthPayload.models.verify[0],
      latency_s: 3.537,
      ok: true,
      in: 2400,
      out: 150,
      thinking: 20,
    },
    tempLedgerPath,
  );
  ledger(
    {
      ts: sinceTs + 1000,
      feature: "verify",
      model: healthPayload.models.verify[0],
      latency_s: 5.638,
      ok: true,
      in: 2400,
      out: 160,
      thinking: 30,
    },
    tempLedgerPath,
  );
  ledger(
    {
      ts: sinceTs + 2000,
      feature: "verify",
      model: healthPayload.models.verify[1],
      latency_s: 1.946,
      ok: true,
      in: 2400,
      out: 140,
      thinking: 40,
    },
    tempLedgerPath,
  );
  ledger(
    {
      ts: sinceTs + 3000,
      feature: "live",
      model: healthPayload.models.live[0],
      latency_s: 12.0,
      ok: true,
      in: 1800,
      out: 300,
      thinking: 60,
      first_audio_s: 0.582,
      tool_latencies_s: [2.739],
      tool_calls: 2,
    },
    tempLedgerPath,
  );
  ledger(
    {
      ts: sinceTs + 4000,
      feature: "tts",
      model: healthPayload.models.tts[0],
      latency_s: 3.911,
      ok: true,
      in: 50,
      out: 200,
      thinking: 0,
    },
    tempLedgerPath,
  );

  const liveStatsRes = await singleOriginFetch("/api/stats");
  assert.equal(liveStatsRes.status, 200);
  assertApiSecurityHeaders(liveStatsRes, "single-origin GET /api/stats (populated)");
  const rawStatsJson: unknown = await liveStatsRes.json();
  const parsedDirect = parseServerLedgerStats(rawStatsJson);
  const hydratedPopulated = await fetchServerLedgerStats(singleOriginFetch);

  assert.notEqual(hydratedPopulated, null);
  assert.deepEqual(hydratedPopulated, parsedDirect);
  assert.equal(hydratedPopulated?.total, 5);
  assert.equal(hydratedPopulated?.since, sinceTs);

  for (const locale of ["en", "fi", "sv"] as const) {
    const populatedHtml = renderToStaticMarkupFn(
      createElementFn(EvalProofCard, { initialStats: hydratedPopulated, lang: locale }),
    );
    assert.equal(populatedHtml.includes(`lang="${locale}"`), true);
    assert.equal(populatedHtml.includes("No live calls recorded in this session yet"), false);
    assert.equal(populatedHtml.includes("Ledger Since 14:08:37 UTC"), true);
    assert.equal(populatedHtml.includes(">5</div>"), true);
    assert.equal(populatedHtml.includes("5 ok / 0 errors (verify: 3, live: 1, tts: 1)"), true);
    assert.equal(populatedHtml.includes("3.537s / 5.638s"), true);
    assert.equal(populatedHtml.includes("Across 3 verified reads (3 total)"), true);
    assert.equal(populatedHtml.includes(">0.582s</div>"), true);
    assert.equal(populatedHtml.includes("Tool p50: 2.739s (2 tool calls)"), true);
    assert.equal(populatedHtml.includes(`data-model="${healthPayload.models.verify[0]}"`), true);
    assert.equal(populatedHtml.includes(`${healthPayload.models.verify[0]} (2)`), true);
    assert.equal(populatedHtml.includes(`data-model="${healthPayload.models.verify[1]}"`), true);
    assert.equal(populatedHtml.includes(`data-model="${healthPayload.models.live[0]}"`), true);
    assert.equal(populatedHtml.includes(`data-model="${healthPayload.models.tts[0]}"`), true);
    assert.equal(populatedHtml.includes("10150 total (2030 avg/call)"), true);
    assert.equal(populatedHtml.includes("In: 9050 / Out: 950 / Thinking: 150"), true);
    assert.equal(populatedHtml.includes("Deterministic Safety Gates"), true);
    assert.equal(populatedHtml.includes(EM_DASH), false, `Forbidden em dash in populated SSR (${locale})`);
    assert.equal(populatedHtml.includes(EN_DASH), false, `Forbidden en dash in populated SSR (${locale})`);
  }

  assert.equal(modelCallCount, 0);
});

test("createApp({ repoRoot }) handles missing eval/combined_summary.json, malformed JSON, non-object JSON, and 10s cache TTL cleanly", async () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-eval-edge-"));
  const evalDir = path.join(isolatedRoot, "eval");
  const evalFile = path.join(evalDir, "combined_summary.json");

  const app = createApp({ repoRoot: isolatedRoot });
  const isolatedServer = http.createServer(app);
  await new Promise<void>((resolve) => isolatedServer.listen(0, "127.0.0.1", () => resolve()));
  const { port } = isolatedServer.address() as AddressInfo;
  const isoOrigin = loopbackOrigin(port);

  const origDateNow = Date.now;
  let simulatedOffsetMs = 0;

  try {
    const missingRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(missingRes.status, 200);
    assertApiSecurityHeaders(missingRes, "isolated GET /api/eval-summary (missing file)");
    assert.deepEqual(await missingRes.json(), { ok: false, summary: null });

    fs.mkdirSync(evalDir, { recursive: true });
    const missingInDirRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(missingInDirRes.status, 200);
    assertApiSecurityHeaders(missingInDirRes, "isolated GET /api/eval-summary (empty eval dir)");
    assert.deepEqual(await missingInDirRes.json(), { ok: false, summary: null });

    fs.writeFileSync(evalFile, "{malformed_json: [unclosed", "utf8");
    const malformedRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(malformedRes.status, 200);
    assertApiSecurityHeaders(malformedRes, "isolated GET /api/eval-summary (malformed JSON)");
    assert.deepEqual(await malformedRes.json(), { ok: false, summary: null });

    fs.writeFileSync(evalFile, "[\"array-root-not-allowed\"]", "utf8");
    const arrayRootRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(arrayRootRes.status, 200);
    assertApiSecurityHeaders(arrayRootRes, "isolated GET /api/eval-summary (array JSON)");
    assert.deepEqual(await arrayRootRes.json(), { ok: false, summary: null });

    const healthAfterErrors = await fetch(`${isoOrigin}/api/health`);
    assert.equal(healthAfterErrors.status, 200);
    assertApiSecurityHeaders(healthAfterErrors, "isolated GET /api/health after edge cases");
    const healthJson = (await healthAfterErrors.json()) as HealthPayload;
    assert.equal(healthJson.ok, true);

    Date.now = () => origDateNow() + simulatedOffsetMs;

    const v1Summary = {
      safety_invariants: { strength_min_conf: 0.8 },
      overall_verdict_accuracy: 0.9811,
      total_confident_wrong_dose_count: 0,
      occluded_abstention_rate: 0.9815,
      total_label_cases_evaluated: 53,
      suites_present: ["coaching_eval", "results_batch1"],
      extended_suites_present: ["curved_blister_results"],
      wave6_suites_present: ["multiframe_recovery_results"],
      wave7_suites_present: ["orientation_robustness_results"],
      wave8_suites_present: ["blister_strip_cuts_results"],
    };
    fs.writeFileSync(evalFile, JSON.stringify(v1Summary), "utf8");

    const recoveredRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(recoveredRes.status, 200);
    assertApiSecurityHeaders(recoveredRes, "isolated GET /api/eval-summary (v1 recovery)");
    const recoveredBody = (await recoveredRes.json()) as EvalSummaryPayload;
    assert.equal(recoveredBody.ok, true);
    assert.equal(recoveredBody.summary?.headline_metrics?.never_guess_strength_min_conf, 0.8);
    assert.equal(recoveredBody.summary?.headline_metrics?.total_confident_wrong_dose_count, 0);
    assert.equal(recoveredBody.summary?.headline_metrics?.total_label_cases_evaluated, 53);
    assert.deepEqual(recoveredBody.summary?.wave8_suites_present, ["blister_strip_cuts_results"]);

    const v2Summary = {
      ...v1Summary,
      total_label_cases_evaluated: 88,
      wave8_suites_present: ["blister_strip_cuts_results", "spoken_verdict_clarity_results"],
    };
    fs.writeFileSync(evalFile, JSON.stringify(v2Summary), "utf8");

    simulatedOffsetMs = 5_000;
    const cachedWithinWindowRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(cachedWithinWindowRes.status, 200);
    const cachedWithinWindowBody = (await cachedWithinWindowRes.json()) as EvalSummaryPayload;
    assert.deepEqual(cachedWithinWindowBody, recoveredBody);

    simulatedOffsetMs = 10_001;
    const refreshedAfterWindowRes = await fetch(`${isoOrigin}/api/eval-summary`);
    assert.equal(refreshedAfterWindowRes.status, 200);
    const refreshedAfterWindowBody = (await refreshedAfterWindowRes.json()) as EvalSummaryPayload;
    assert.equal(refreshedAfterWindowBody.ok, true);
    assert.equal(refreshedAfterWindowBody.summary?.headline_metrics?.total_label_cases_evaluated, 88);
    assert.deepEqual(refreshedAfterWindowBody.summary?.wave8_suites_present, [
      "blister_strip_cuts_results",
      "spoken_verdict_clarity_results",
    ]);
  } finally {
    Date.now = origDateNow;
    await closeServer(isolatedServer);
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }

  assert.equal(modelCallCount, 0);
});

test("server/test/eval-summary-hydration.test.ts contains zero comments, zero em dashes, zero trailers, and zero keys", () => {
  const doubleSlash = SLASH + SLASH;
  const blockOpen = SLASH + STAR;
  const blockClose = STAR + SLASH;
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  const selfText = fs.readFileSync(TEST_FILE, "utf8");
  assert.equal(selfText.includes(doubleSlash), false, "Forbidden double-slash comment token");
  assert.equal(selfText.includes(blockOpen), false, "Forbidden block comment open token");
  assert.equal(selfText.includes(blockClose), false, "Forbidden block comment close token");
  assert.equal(selfText.includes(EM_DASH), false, "Forbidden em dash character");
  assert.equal(coAuthoredRe.test(selfText), false, "Forbidden co-authored trailer");
  assert.equal(apiKeyRe.test(selfText), false, "Forbidden API key pattern");
});
