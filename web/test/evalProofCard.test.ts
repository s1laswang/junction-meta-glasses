import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EvalProofCard,
  fetchServerLedgerStats,
  parseServerLedgerStats,
  type EvalProofCardProps,
  type ServerFeatureStats,
  type ServerLedgerStats
} from "../src/components/EvalProofCard.tsx";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const EMPTY_STATS: ServerLedgerStats = {
  since: null,
  total: 0,
  features: {}
};

function makePopulatedStats(): ServerLedgerStats {
  const verify: ServerFeatureStats = {
    calls: 5,
    ok: 5,
    errors: 0,
    tokens_in: 1420,
    tokens_out: 210,
    tokens_thinking: 185,
    models: {
      "gemini-3.8-flash": 4,
      "gemini-3.5-flash": 1
    },
    latency_p50_s: 1.18,
    latency_p95_s: 2.04
  };

  const live: ServerFeatureStats = {
    calls: 3,
    ok: 3,
    errors: 0,
    tokens_in: 980,
    tokens_out: 340,
    tokens_thinking: 65,
    models: {
      "gemini-3.8-live": 3
    },
    latency_p50_s: 14.5,
    latency_p95_s: 26.2,
    first_audio_p50_s: 0.64,
    tool_p50_s: 1.32,
    tool_calls: 4
  };

  return {
    since: Date.UTC(2026, 10, 14, 13, 52, 3),
    total: 8,
    features: { verify, live }
  };
}

function extractOpeningTagByClass(html: string, classToken: string): string {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with class "${classToken}"`);
  return match[0];
}

test("EvalProofCard SSR with empty stats (total: 0) renders standby message, >= 48px refresh button, 5 metric tiles, and all 4 safety gates", () => {
  const html = renderToStaticMarkup(
    createElement(EvalProofCard, {
      initialStats: EMPTY_STATS,
      lang: "en"
    })
  );

  assert.ok(html.includes("Runtime Gemini Telemetry (/api/stats)"));
  assert.ok(html.includes("Refresh Live Telemetry"));
  assert.ok(html.includes("No live calls recorded in this session yet"));

  const refreshBtnTag = extractOpeningTagByClass(html, "eval-refresh-btn");
  assert.ok(refreshBtnTag.includes('type="button"'));
  const minHeightMatch = /min-height:(\d+)px/.exec(refreshBtnTag);
  assert.ok(minHeightMatch, "Refresh button must declare explicit min-height in px");
  assert.ok(
    Number.parseInt(minHeightMatch[1], 10) >= 48,
    `Expected refresh button min-height >= 48px, got ${minHeightMatch[1]}px`
  );

  for (const metricHeading of [
    "Total Gemini Calls",
    "Verify p50 / p95 Latency",
    "Live First-Audio p50",
    "Active Models Used",
    "Token Efficiency"
  ]) {
    assert.ok(html.includes(metricHeading), `Missing metric tile heading: ${metricHeading}`);
  }

  assert.ok(html.includes("Deterministic Safety Gates"));
  assert.ok(html.includes("&gt;= 80% Strength Confidence Gate (ECE 0.0138)"));
  assert.ok(html.includes("Dual-Tier Live + Schema Reader"));
  assert.ok(html.includes("Zero Server Image Retention"));
  assert.ok(html.includes("8/8 Gemini Coaching &amp; Privacy Judge Pass"));

  const nullStatsHtml = renderToStaticMarkup(
    createElement(EvalProofCard, {
      initialStats: null,
      lang: "en"
    })
  );
  assert.ok(nullStatsHtml.includes("No live calls recorded in this session yet"));
});

test("EvalProofCard SSR with populated verify + live stats renders latencies, first-audio p50, thinking tokens, and model badges", () => {
  const populated = makePopulatedStats();
  const props: EvalProofCardProps = {
    initialStats: populated,
    lang: "en"
  };

  const html = renderToStaticMarkup(createElement(EvalProofCard, props));

  assert.equal(html.includes("No live calls recorded in this session yet"), false);
  assert.ok(html.includes("Ledger Since 13:52:03 UTC"));

  assert.ok(html.includes(">8</div>"));
  assert.ok(html.includes("8 ok / 0 errors (verify: 5, live: 3)"));

  assert.ok(html.includes("1.18s / 2.04s"));
  assert.ok(html.includes("Across 5 verified reads (5 total)"));

  assert.ok(html.includes(">0.64s</div>"));
  assert.ok(html.includes("Tool p50: 1.32s (4 tool calls)"));

  const badgeMatches = html.match(/class="badge eval-model-badge"/g) ?? [];
  assert.equal(badgeMatches.length, 3, "Expected 3 active model badges");
  assert.ok(html.includes('data-model="gemini-3.8-flash"'));
  assert.ok(html.includes("gemini-3.8-flash (4)"));
  assert.ok(html.includes('data-model="gemini-3.8-live"'));
  assert.ok(html.includes("gemini-3.8-live (3)"));
  assert.ok(html.includes('data-model="gemini-3.5-flash"'));
  assert.ok(html.includes("gemini-3.5-flash (1)"));

  assert.ok(html.includes("3200 total (400 avg/call)"));
  assert.ok(html.includes("In: 2400 / Out: 550 / Thinking: 250"));

  const thinkAliasStats: ServerLedgerStats = {
    since: "2026-11-14T15:10:00Z",
    total: 1,
    features: {
      verify: {
        calls: 1,
        ok: 1,
        errors: 0,
        tokens_in: 300,
        tokens_out: 60,
        tokens_think: 40,
        models: { "gemini-3.8-flash": 1 },
        latency_p50_s: 0.95,
        latency_p95_s: 0.95
      }
    }
  };
  const thinkAliasHtml = renderToStaticMarkup(
    createElement(EvalProofCard, { initialStats: thinkAliasStats, lang: "en" })
  );
  assert.ok(thinkAliasHtml.includes("400 total (400 avg/call)"));
  assert.ok(thinkAliasHtml.includes("In: 300 / Out: 60 / Thinking: 40"));
  assert.ok(thinkAliasHtml.includes("Ledger Since 15:10:00 UTC"));
});

test("EvalProofCard exposes accessible landmark regions, heading hierarchy, and polite live status", () => {
  const html = renderToStaticMarkup(
    createElement(EvalProofCard, {
      initialStats: makePopulatedStats(),
      lang: "en"
    })
  );

  assert.match(html, /^<section\b[^>]*aria-labelledby="eval-proof-card-title"[^>]*lang="en"/);
  assert.match(html, /<h2\b[^>]*id="eval-proof-card-title"[^>]*>Live Ledger Telemetry &amp; Safety Proof<\/h2>/);

  const telemetryRegionTag = extractOpeningTagByClass(html, "eval-telemetry-region");
  assert.ok(telemetryRegionTag.includes('role="region"'));
  assert.ok(telemetryRegionTag.includes('aria-labelledby="eval-runtime-telemetry-heading"'));
  assert.match(
    html,
    /<h3\b[^>]*id="eval-runtime-telemetry-heading"[^>]*>Runtime Gemini Telemetry \(\/api\/stats\)<\/h3>/
  );

  const safetyRegionTag = extractOpeningTagByClass(html, "eval-safety-gates-region");
  assert.ok(safetyRegionTag.includes('role="region"'));
  assert.ok(safetyRegionTag.includes('aria-labelledby="eval-safety-gates-heading"'));
  assert.match(
    html,
    /<h3\b[^>]*id="eval-safety-gates-heading"[^>]*>Deterministic Safety Gates<\/h3>/
  );

  const liveStatusTag = extractOpeningTagByClass(html, "eval-proof-live-status");
  assert.ok(liveStatusTag.includes('role="status"'));
  assert.ok(liveStatusTag.includes('aria-live="polite"'));
  assert.ok(liveStatusTag.includes('aria-atomic="true"'));
});

test("fetchServerLedgerStats calls GET /api/stats and handles valid payloads, HTTP errors, and offline errors gracefully", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const sample = makePopulatedStats();

  const okFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify(sample), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const fetched = await fetchServerLedgerStats(okFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/stats");
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(fetched, sample);

  const badStatusFetch: typeof fetch = async () =>
    new Response("unavailable", { status: 503 });
  assert.equal(await fetchServerLedgerStats(badStatusFetch), null);

  const offlineFetch: typeof fetch = async () => {
    throw new TypeError("NetworkError when attempting to fetch resource");
  };
  assert.equal(await fetchServerLedgerStats(offlineFetch), null);

  assert.equal(parseServerLedgerStats(null), null);
  assert.equal(parseServerLedgerStats("invalid"), null);
  assert.equal(parseServerLedgerStats({ total: -1, features: {} }), null);
});

test("EvalProofCard emits zero em dashes and zero en dashes across all locales and states", () => {
  const states: Array<ServerLedgerStats | null | undefined> = [
    undefined,
    null,
    EMPTY_STATS,
    makePopulatedStats()
  ];

  for (const locale of ["en", "fi", "sv", "de"] as const) {
    for (const initialStats of states) {
      const html = renderToStaticMarkup(
        createElement(EvalProofCard, {
          initialStats,
          lang: locale
        })
      );
      assert.equal(html.includes(EM_DASH), false, `Em dash found for locale=${locale}`);
      assert.equal(html.includes(EN_DASH), false, `En dash found for locale=${locale}`);
    }
  }
});
