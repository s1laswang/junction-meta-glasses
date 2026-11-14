type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

type VmModule = {
  runInNewContext(code: string, contextObject: Record<string, unknown>): unknown;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeVmSpec: string = "node:vm";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { existsSync, readFileSync } = (await import(nodeFsSpec)) as FsModule;
const vm = (await import(nodeVmSpec)) as VmModule;

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const CSS_COMMENT_OPEN = SLASH + STAR;
const CSS_COMMENT_CLOSE = STAR + SLASH;
const HTML_COMMENT_OPEN = "\x3c!--";
const HTML_COMMENT_CLOSE = "--\x3e";
const HTTP_SCHEME = "http:" + DOUBLE_SLASH;
const HTTPS_SCHEME = "https:" + DOUBLE_SLASH;
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const posterUrl = new URL("../../docs/architecture-poster.html", import.meta.url);
const selfTestUrl = new URL("./architecturePoster.test.ts", import.meta.url);

type HudLatencyArtifact = {
  summary: {
    ingest_frame_n: number;
    ingest_frame_bytes: number;
    ingest_frame_p50_ms: number;
    ingest_frame_p95_ms: number;
    ring_capacity: number;
    ring_len_after_disconnect: number;
    ingest_state_fanout_p50_ms: number;
    hud_ws_leg_p50_ms: number;
    live_ws_leg_p50_ms: number;
    hud_late_join_replay_p50_ms: number;
    hud_verdict_wire_bytes: number;
    hud_full_replay_wire_bytes: number;
  };
};

type E2eWebsocketLiveArtifact = {
  confident_wrong_dose_count: number;
  summary: {
    e2e_frame_to_hud_verdict_p50_ms: number;
    live_startup_to_ready_ms: number;
    live_turn_first_coach_event_ms: number;
    confident_wrong_dose_count: number;
  };
};

type CombinedSummaryArtifact = {
  safety_invariants: {
    strength_min_conf: number;
  };
  total_label_cases_evaluated: number;
  total_verdict_matches: number;
  overall_verdict_accuracy: number;
  total_confident_wrong_dose_count: number;
  extended_summary: {
    confident_wrong_dose_count: number;
    pii_or_bystander_leak_count: number;
  };
  calibration: {
    ece: number;
    confident_wrong_dose_at_080: number;
  };
  live_probe: {
    primary_first_audio_ms: number;
  };
  unit_economics: {
    video_bandwidth_saved_in_adaptive_mode_pct: number;
    per_check_gemini_cost_eur_standard: number;
    tco_3yr_holdup_rayban_meta_gen2_eur: number;
    tco_3yr_orcam_myeye_midpoint_eur: number;
    tco_savings_vs_orcam_midpoint_pct: number;
  };
};

type BystanderPrivacyArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    pii_or_bystander_leak_count: number;
    confident_wrong_dose_count: number;
  };
};

function readJsonArtifact<T>(relativePath: string): T {
  const raw = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return JSON.parse(raw) as T;
}

function formatDecimal2(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function formatDecimal1(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10) / 10).toFixed(1);
}

test("docs/architecture-poster.html exists as self-contained HTML5 with A4 landscape @page print CSS", () => {
  assert.equal(existsSync(posterUrl), true, "docs/architecture-poster.html must exist");
  const html = readFileSync(posterUrl, "utf8");

  assert.match(html, /^<!DOCTYPE html>\s*<html\b[^>]*lang="en"/i);
  assert.match(html, /@page\s*\{\s*size:\s*A4\s+landscape;\s*margin:\s*8mm;\s*\}/i);
  assert.match(html, /@media\s+print\s*\{/i);
  assert.match(html, /\.no-print\s*\{\s*display:\s*none\s*!important;\s*\}/i);
  assert.ok(html.includes('<main class="poster-sheet"'), "Expected semantic <main class=\"poster-sheet\">");
  assert.ok(html.includes("</html>"), "Expected closing </html>");
});

test("docs/architecture-poster.html and architecturePoster.test.ts have zero external URLs, zero comments, and zero em or en dashes", () => {
  const html = readFileSync(posterUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  assert.equal(html.toLowerCase().includes(HTTP_SCHEME), false, "Must not reference external http URLs");
  assert.equal(html.toLowerCase().includes(HTTPS_SCHEME), false, "Must not reference external https URLs");

  const externalCssUrlPattern = new RegExp(`url\\s*\\(\\s*["']?\\s*(?:https?:)?${DOUBLE_SLASH}`, "i");

  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i, "Must not include external <script src>");
  assert.doesNotMatch(html, /<link\b/i, "Must not include external <link>");
  assert.doesNotMatch(html, /<img\b/i, "Must not include external <img>");
  assert.doesNotMatch(html, /@import\b/i, "Must not include CSS @import");
  assert.doesNotMatch(html, externalCssUrlPattern, "Must not include external CSS url()");

  assert.equal(html.includes(HTML_COMMENT_OPEN), false, "Must contain zero HTML comment openings");
  assert.equal(html.includes(HTML_COMMENT_CLOSE), false, "Must contain zero HTML comment closings");
  assert.equal(html.includes(CSS_COMMENT_OPEN), false, "Must contain zero block comment openings");
  assert.equal(html.includes(CSS_COMMENT_CLOSE), false, "Must contain zero block comment closings");
  assert.equal(html.includes(DOUBLE_SLASH), false, "Must contain zero line comments");

  for (const forbiddenDash of [EM_DASH, EN_DASH, "&mdash;", "&ndash;", "&#8212;", "&#8211;", "&#x2014;", "&#x2013;"]) {
    assert.equal(html.toLowerCase().includes(forbiddenDash.toLowerCase()), false, `Forbidden dash token: ${forbiddenDash}`);
  }

  assert.equal(selfSource.includes(HTML_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(CSS_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(CSS_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(DOUBLE_SLASH), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(selfSource.includes(EN_DASH), false);
});

test("docs/architecture-poster.html renders crisp inline SVG visualizing all 3 thin clients, Node 24 Hub, Gemini models, and privacy boundaries", () => {
  const html = readFileSync(posterUrl, "utf8");

  const svgMatch = /<svg\b[^>]*class="arch-svg"[^>]*viewBox="0 0 1200 404"[^>]*role="img"[^>]*aria-label="[^"]+"[^>]*>([\s\S]*?)<\/svg>/i.exec(
    html
  );
  assert.ok(svgMatch, "Expected accessible inline <svg class=\"arch-svg\"> diagram");
  const svgBody = svgMatch[1];

  const rectCount = (svgBody.match(/<rect\b/gi) ?? []).length;
  const textCount = (svgBody.match(/<text\b/gi) ?? []).length;
  const lineCount = (svgBody.match(/<line\b/gi) ?? []).length;
  assert.ok(rectCount >= 10, "Expected structured SVG architecture boxes");
  assert.ok(textCount >= 30, "Expected labeled SVG architecture nodes and wire edges");
  assert.ok(lineCount >= 8, "Expected SVG protocol connector lines");

  const requiredArchitectureTokens = [
    "android-dat/",
    "Meta Wearables DAT SDK 1.0.1",
    "720x1280",
    "POST /ingest/frame",
    "POST /ingest/state",
    "WCAG 2.2 AAA",
    "React 19",
    "PCM16",
    "BarcodeDetector",
    "localStorage",
    "wipeAllLocalData()",
    "/hud",
    "600x600",
    "#000000",
    "Meta Neural Band",
    "Arrow*",
    "Enter",
    "/hud-ws",
    "NODE 24 TYPESCRIPT HUB",
    "FrameRing(8)",
    "hub.ring.clear()",
    "LiveProxy",
    "gemini-3.8-live",
    "show_cue",
    "verify_label",
    "log_dose",
    "gemini-3.8-flash",
    "shared/label_schema.json",
    "safety.ts",
    "STRENGTH_MIN_CONF = 0.80",
    "EU MDR Art. 2(1)"
  ];

  for (const token of requiredArchitectureTokens) {
    assert.ok(html.includes(token), `Architecture poster missing required component token: ${token}`);
  }
});

test("docs/architecture-poster.html cites exact measured latency, calibration, and safety metrics from committed eval JSON files", () => {
  const html = readFileSync(posterUrl, "utf8");

  const hudBench = readJsonArtifact<HudLatencyArtifact>("../../eval/hud_latency_bandwidth.json");
  const e2eLive = readJsonArtifact<E2eWebsocketLiveArtifact>("../../eval/e2e_websocket_live.json");
  const combined = readJsonArtifact<CombinedSummaryArtifact>("../../eval/combined_summary.json");
  const bystander = readJsonArtifact<BystanderPrivacyArtifact>("../../eval/bystander_privacy_results.json");

  assert.equal(combined.safety_invariants.strength_min_conf, 0.8);
  assert.equal(combined.total_confident_wrong_dose_count, 0);
  assert.equal(combined.extended_summary.confident_wrong_dose_count, 0);
  assert.equal(combined.calibration.confident_wrong_dose_at_080, 0);
  assert.equal(e2eLive.confident_wrong_dose_count, 0);
  assert.equal(bystander.summary.confident_wrong_dose_count, 0);

  assert.equal(combined.extended_summary.pii_or_bystander_leak_count, 0);
  assert.equal(bystander.summary.pii_or_bystander_leak_count, 0);
  assert.equal(bystander.summary.verdict_matches, 8);
  assert.equal(bystander.summary.n_items, 8);

  assert.equal(hudBench.summary.ingest_state_fanout_p50_ms, 1.295);
  const ingestFrameP50 = formatDecimal2(hudBench.summary.ingest_frame_p50_ms);
  const ingestFrameP95 = formatDecimal2(hudBench.summary.ingest_frame_p95_ms);
  const stateFanoutP50 = formatDecimal2(hudBench.summary.ingest_state_fanout_p50_ms);
  const hudLegP50 = formatDecimal2(hudBench.summary.hud_ws_leg_p50_ms);
  const liveLegP50 = formatDecimal2(hudBench.summary.live_ws_leg_p50_ms);
  const lateJoinReplayP50 = formatDecimal2(hudBench.summary.hud_late_join_replay_p50_ms);
  const glassToHudVerdictP50 = formatDecimal1(e2eLive.summary.e2e_frame_to_hud_verdict_p50_ms);
  const liveReadyMs = formatDecimal1(e2eLive.summary.live_startup_to_ready_ms);

  assert.equal(ingestFrameP50, "1.17");
  assert.equal(stateFanoutP50, "1.30");
  assert.equal(lateJoinReplayP50, "1.78");
  assert.equal(glassToHudVerdictP50, "2738.8");
  assert.equal(liveReadyMs, "431.6");
  assert.equal(hudBench.summary.ring_capacity, 8);
  assert.equal(hudBench.summary.ring_len_after_disconnect, 0);

  const expectedMetricSnippets = [
    `${ingestFrameP50} ms`,
    `${ingestFrameP95} ms`,
    `${stateFanoutP50} ms`,
    `${hudLegP50} ms`,
    `${liveLegP50} ms`,
    `${lateJoinReplayP50} ms`,
    `${hudBench.summary.hud_full_replay_wire_bytes} B`,
    `${hudBench.summary.hud_verdict_wire_bytes} B`,
    `${glassToHudVerdictP50} ms`,
    `${liveReadyMs} ms`,
    `${Math.round(combined.live_probe.primary_first_audio_ms)} ms`,
    `ECE = ${combined.calibration.ece.toFixed(4)}`,
    `${combined.total_verdict_matches}/${combined.total_label_cases_evaluated}`,
    `${combined.unit_economics.video_bandwidth_saved_in_adaptive_mode_pct.toFixed(1)}%`,
    `EUR ${combined.unit_economics.tco_3yr_holdup_rayban_meta_gen2_eur.toFixed(2)}`,
    "EUR 4,150.00",
    `${combined.unit_economics.tco_savings_vs_orcam_midpoint_pct.toFixed(1)}%`,
    "0 PII/bystander leaks",
    "0 confident-wrong doses"
  ];

  for (const snippet of expectedMetricSnippets) {
    assert.ok(html.includes(snippet), `Architecture poster missing verified eval metric snippet: ${snippet}`);
  }

  const metricCards = html.match(/class="metric-card"/g) ?? [];
  assert.equal(metricCards.length, 7, "Expected 7 headline benchmark metric cards");
});

test("docs/architecture-poster.html inline toolbar script toggles light/dark preview and triggers window.print()", () => {
  const html = readFileSync(posterUrl, "utf8");
  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html);
  assert.ok(scriptMatch, "Expected inline <script> block");

  const attrs: Record<string, string> = { "data-preview": "dark" };
  const btnHandlers: Record<string, () => void> = {};
  const previewBtnState = { ariaPressed: "false", textContent: "Light Print Preview" };
  let printCount = 0;

  const context: Record<string, unknown> = {
    window: {
      print() {
        printCount += 1;
      }
    },
    document: {
      documentElement: {
        getAttribute(name: string) {
          return attrs[name] ?? null;
        },
        setAttribute(name: string, value: string) {
          attrs[name] = value;
        }
      },
      getElementById(id: string) {
        if (id === "btn-toggle-preview") {
          return {
            textContent: previewBtnState.textContent,
            setAttribute(name: string, value: string) {
              if (name === "aria-pressed") {
                previewBtnState.ariaPressed = value;
              }
            },
            addEventListener(_event: string, fn: () => void) {
              btnHandlers[id] = fn;
              Object.defineProperty(this, "textContent", {
                get() {
                  return previewBtnState.textContent;
                },
                set(val: string) {
                  previewBtnState.textContent = val;
                }
              });
            }
          };
        }
        if (id === "btn-print-poster") {
          return {
            addEventListener(_event: string, fn: () => void) {
              btnHandlers[id] = fn;
            }
          };
        }
        return null;
      }
    }
  };

  vm.runInNewContext(scriptMatch[1], context);

  assert.ok(btnHandlers["btn-toggle-preview"], "Preview toggle listener should register");
  assert.ok(btnHandlers["btn-print-poster"], "Print button listener should register");

  btnHandlers["btn-toggle-preview"]();
  assert.equal(attrs["data-preview"], "light");
  assert.equal(previewBtnState.ariaPressed, "true");
  assert.equal(previewBtnState.textContent, "Dark Booth View");

  btnHandlers["btn-toggle-preview"]();
  assert.equal(attrs["data-preview"], "dark");
  assert.equal(previewBtnState.ariaPressed, "false");
  assert.equal(previewBtnState.textContent, "Light Print Preview");

  btnHandlers["btn-print-poster"]();
  assert.equal(printCount, 1);
});
