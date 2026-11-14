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

const handoutUrl = new URL("../../docs/judge-handout.html", import.meta.url);
const selfTestUrl = new URL("./judgeHandout.test.ts", import.meta.url);

type CalibrationArtifact = {
  summary: {
    ece: number;
    total_items: number;
    at_production_threshold_0_80: {
      threshold: number;
      unreadable_abstention_rate: number;
      confident_wrong_dose_count: number;
    };
  };
};

type ModelComparisonArtifact = {
  total_benchmark_calls: number;
  models: Record<
    string,
    {
      verdict_accuracy: number;
      confident_wrong_dose_count: number;
    }
  >;
};

type DemoFixturesArtifact = {
  summary: {
    n_items: number;
    confident_wrong_dose_count: number;
  };
};

type Batch2Artifact = {
  summary: {
    n_items: number;
    confident_wrong_dose_count: number;
    false_safe_allergen_count: number;
  };
};

type LiveProbeArtifact = {
  results: Array<{
    model: string;
    ok: boolean;
    connectMs: number;
    firstAudioMs: number;
  }>;
};

type CoachingEvalArtifact = {
  summary: {
    total_scenarios: number;
    passed_all_checks: number;
    mean_overall_score: number;
  };
};

type UnitEconomicsArtifact = {
  headline_summary: {
    video_bandwidth_saved_in_adaptive_mode_pct: number;
    tco_3yr_holdup_rayban_meta_gen2_eur: number;
    tco_3yr_orcam_myeye_midpoint_eur: number;
    tco_savings_vs_orcam_midpoint_pct: number;
    tco_cost_reduction_multiple_vs_orcam: number;
  };
};

type E2eWebsocketLiveArtifact = {
  confident_wrong_dose_count: number;
  summary: {
    live_startup_to_ready_ms: number;
    e2e_frame_to_hud_verdict_p50_ms: number;
    confident_wrong_dose_count: number;
  };
};

type HudLatencyBandwidthArtifact = {
  summary: {
    ingest_frame_p50_ms: number;
    hud_late_join_replay_p50_ms: number;
    hud_verdict_wire_bytes: number;
    ring_capacity: number;
    ring_len_after_disconnect: number;
  };
};

type OrientationRobustnessArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    verdict_accuracy: number;
    upside_down_180_accuracy: number;
    sideways_90_270_accuracy: number;
    confident_wrong_dose_count: number;
  };
};

type PromptInjectionArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    hijack_success_count: number;
    injection_resistance_rate: number;
    confident_wrong_dose_count: number;
  };
};

type ThermalFadeWearArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    n_moderate_wear: number;
    n_severe_wear: number;
    moderate_wear_accuracy: number;
    severe_wear_abstention_rate: number;
    confident_wrong_dose_count: number;
  };
};

type ConcurrentSessionsArtifact = {
  summary: {
    n_concurrent_sessions: number;
    n_concurrent_websockets: number;
    cross_session_leak_count: number;
    isolation_pass_rate: number;
    max_ring_len_observed: number;
    post_disconnect_buffered_frames: number;
  };
};

type MultilingualCoachingArtifact = {
  summary: {
    n_turns: number;
    languages_tested: string[];
    language_compliance_rate: number;
    all_checks_pass_rate: number;
    dose_hallucination_count: number;
    bystander_leak_count: number;
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

function formatDecimal1(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10) / 10).toFixed(1);
}

function formatDecimal2(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function readJsonArtifact<T>(relativePath: string): T {
  const raw = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return JSON.parse(raw) as T;
}

function extractTagTexts(html: string, tagName: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

test("docs/judge-handout.html exists as self-contained A4 portrait HTML5 with print rules", () => {
  assert.equal(existsSync(handoutUrl), true, "docs/judge-handout.html must exist");
  const html = readFileSync(handoutUrl, "utf8");

  assert.match(html, /^<!DOCTYPE html>\s*<html\b[^>]*lang="en"/i);
  assert.match(html, /@page\s*\{\s*size:\s*A4\s+portrait;\s*margin:\s*10mm;\s*\}/i);
  assert.match(html, /@media\s+print\s*\{/i);
  assert.ok(html.includes("<main"), "Expected semantic <main> landmark");
  assert.ok(html.includes("</html>"), "Expected closing </html>");
});

test("docs/judge-handout.html has zero external http/https dependencies, zero comments, and zero em/en dashes", () => {
  const html = readFileSync(handoutUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  assert.equal(html.toLowerCase().includes(HTTP_SCHEME), false, "Must not reference external http URLs");
  assert.equal(html.toLowerCase().includes(HTTPS_SCHEME), false, "Must not reference external https URLs");

  const externalImgPattern = new RegExp(`<img\\b[^>]*\\bsrc\\s*=\\s*["']?\\s*(?:https?:)?${DOUBLE_SLASH}`, "i");
  const externalCssUrlPattern = new RegExp(`url\\s*\\(\\s*["']?\\s*(?:https?:)?${DOUBLE_SLASH}`, "i");

  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i, "Must not include external <script src>");
  assert.doesNotMatch(html, /<link\b/i, "Must not include external <link> stylesheets or fonts");
  assert.doesNotMatch(html, externalImgPattern, "Must not include external <img>");
  assert.doesNotMatch(html, /@import\b/i, "Must not include CSS @import");
  assert.doesNotMatch(html, externalCssUrlPattern, "Must not include external CSS url()");

  assert.equal(html.includes(HTML_COMMENT_OPEN), false, "Must contain zero HTML comment openings");
  assert.equal(html.includes(HTML_COMMENT_CLOSE), false, "Must contain zero HTML comment closings");
  assert.equal(html.includes(CSS_COMMENT_OPEN), false, "Must contain zero CSS/JS block comment openings");
  assert.equal(html.includes(CSS_COMMENT_CLOSE), false, "Must contain zero CSS/JS block comment closings");
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

test("docs/judge-handout.html links and mentions /deck, /printable-props.html, and /architecture-poster.html", () => {
  const html = readFileSync(handoutUrl, "utf8");

  for (const companionRoute of ["/deck", "/printable-props.html", "/architecture-poster.html"]) {
    assert.ok(
      html.includes(`href="${companionRoute}"`),
      `Expected companion link href="${companionRoute}" in docs/judge-handout.html`
    );
    assert.ok(
      html.includes(`<code>${companionRoute}</code>`),
      `Expected printed route mention <code>${companionRoute}</code> in docs/judge-handout.html`
    );
  }
  assert.ok(html.includes("docs/architecture-poster.html"));
});

test("docs/judge-handout.html renders header, inline SVG glasses + 600x600 waveguide, 30s walkthrough, controls table, and 6-tier resilience checklist", () => {
  const html = readFileSync(handoutUrl, "utf8");

  assert.ok(html.includes("HoldUp: Hold it up. Know it is the right one."));
  assert.ok(html.includes('Meta "AI Glasses for Everyone, Everyday"'));

  assert.match(html, /<svg\b[^>]*role="img"[^>]*aria-label="[^"]*Ray-Ban[^"]*600x600[^"]*"/i);
  assert.ok(html.includes("600x600 WAVEGUIDE (#000000)"));

  assert.ok(html.includes("Try It in 30 Seconds"));
  assert.ok(html.includes("<code>/</code>"));
  assert.ok(html.includes("<code>/hud</code>"));
  assert.ok(html.includes("Start Check"));
  assert.ok(html.includes("5-Step Judge Demo Tour"));

  for (const beatPhrase of [
    "Amlodipine 5 mg",
    "Burana 400 mg",
    "Covered Dose",
    "&lt; 0.80",
    "Hazelnut",
    "Complete Offline",
    "EAN-13",
    "6432100012345"
  ]) {
    assert.ok(html.includes(beatPhrase), `Missing walkthrough phrase: ${beatPhrase}`);
  }

  assert.match(html, /<table\b[^>]*class="controls-table"/i);
  const kbdValues = extractTagTexts(html, "kbd");
  for (const requiredKey of ["Space", "S", "B", "L", "R", "T", "M", "Arrow*", "Enter", "Back"]) {
    assert.ok(kbdValues.includes(requiredKey), `Controls table missing <kbd>${requiredKey}</kbd>`);
  }

  assert.ok(html.includes("6-Tier Resilience Checklist"));
  assert.ok(html.includes("Device &amp; Resilience"));
  for (const faultToggle of ["WS Drop", "Force Offline", "Glasses Doffed", "Low Battery &lt;10%"]) {
    assert.ok(html.includes(faultToggle), `Missing resilience toggle: ${faultToggle}`);
  }
  const checkCards = html.match(/class="check-card"/g) ?? [];
  assert.equal(checkCards.length, 6, "Expected exactly 6 resilience checklist cards");
});

test("docs/judge-handout.html benchmark figures match measured Wave-1 through Wave-7 eval JSON artifacts", () => {
  const html = readFileSync(handoutUrl, "utf8");

  const calibration = readJsonArtifact<CalibrationArtifact>("../../eval/calibration_curve.json");
  const modelComp = readJsonArtifact<ModelComparisonArtifact>("../../eval/model_comparison.json");
  const demoFixtures = readJsonArtifact<DemoFixturesArtifact>("../../eval/demo_fixtures_results.json");
  const batch2 = readJsonArtifact<Batch2Artifact>("../../eval/results_batch2.json");
  const liveProbe = readJsonArtifact<LiveProbeArtifact>("../../eval/live_models_probe.json");
  const coaching = readJsonArtifact<CoachingEvalArtifact>("../../eval/coaching_eval.json");
  const unitEcon = readJsonArtifact<UnitEconomicsArtifact>("../../eval/unit_economics.json");
  const e2eLive = readJsonArtifact<E2eWebsocketLiveArtifact>("../../eval/e2e_websocket_live.json");
  const hudBench = readJsonArtifact<HudLatencyBandwidthArtifact>("../../eval/hud_latency_bandwidth.json");
  const orientation = readJsonArtifact<OrientationRobustnessArtifact>("../../eval/orientation_robustness_results.json");
  const promptInj = readJsonArtifact<PromptInjectionArtifact>("../../eval/prompt_injection_labels_results.json");
  const thermalWear = readJsonArtifact<ThermalFadeWearArtifact>("../../eval/thermal_fade_wear_results.json");
  const concurrent = readJsonArtifact<ConcurrentSessionsArtifact>("../../eval/concurrent_sessions_results.json");
  const multiCoaching = readJsonArtifact<MultilingualCoachingArtifact>("../../eval/multilingual_coaching_results.json");
  const bystander = readJsonArtifact<BystanderPrivacyArtifact>("../../eval/bystander_privacy_results.json");

  assert.equal(calibration.summary.ece, 0.0138);
  assert.equal(calibration.summary.total_items, 16);
  assert.equal(calibration.summary.at_production_threshold_0_80.confident_wrong_dose_count, 0);
  assert.equal(calibration.summary.at_production_threshold_0_80.unreadable_abstention_rate, 1.0);

  assert.equal(modelComp.total_benchmark_calls, 36);
  for (const stats of Object.values(modelComp.models)) {
    assert.equal(stats.confident_wrong_dose_count, 0);
    assert.equal(stats.verdict_accuracy, 1.0);
  }

  assert.equal(demoFixtures.summary.n_items, 7);
  assert.equal(demoFixtures.summary.confident_wrong_dose_count, 0);

  assert.equal(batch2.summary.n_items, 18);
  assert.equal(batch2.summary.confident_wrong_dose_count, 0);
  assert.equal(batch2.summary.false_safe_allergen_count, 0);

  const livePrimary = liveProbe.results.find((entry) => entry.model === "gemini-3.8-live");
  assert.ok(livePrimary, "Expected gemini-3.8-live in live_models_probe.json");
  assert.equal(livePrimary.firstAudioMs, 582);
  assert.equal(livePrimary.connectMs, 706);

  assert.equal(coaching.summary.passed_all_checks, 8);
  assert.equal(coaching.summary.total_scenarios, 8);
  assert.equal(bystander.summary.pii_or_bystander_leak_count, 0);
  assert.equal(bystander.summary.verdict_matches, 8);

  assert.equal(unitEcon.headline_summary.video_bandwidth_saved_in_adaptive_mode_pct, 84.0);
  assert.equal(unitEcon.headline_summary.tco_3yr_holdup_rayban_meta_gen2_eur, 341.68);
  assert.equal(unitEcon.headline_summary.tco_3yr_orcam_myeye_midpoint_eur, 4150.0);
  assert.equal(unitEcon.headline_summary.tco_savings_vs_orcam_midpoint_pct, 91.8);

  const liveReadyMs = formatDecimal1(e2eLive.summary.live_startup_to_ready_ms);
  const glassToHudP50Ms = formatDecimal1(e2eLive.summary.e2e_frame_to_hud_verdict_p50_ms);
  assert.equal(liveReadyMs, "431.6");
  assert.equal(glassToHudP50Ms, "2738.8");
  assert.equal(e2eLive.confident_wrong_dose_count, 0);

  const ingestFrameP50Ms = formatDecimal2(hudBench.summary.ingest_frame_p50_ms);
  const hudReplayP50Ms = formatDecimal2(hudBench.summary.hud_late_join_replay_p50_ms);
  assert.equal(ingestFrameP50Ms, "1.17");
  assert.equal(hudReplayP50Ms, "1.78");
  assert.equal(hudBench.summary.hud_verdict_wire_bytes, 674);
  assert.equal(hudBench.summary.ring_capacity, 8);
  assert.equal(hudBench.summary.ring_len_after_disconnect, 0);

  assert.equal(orientation.summary.verdict_matches, 10);
  assert.equal(orientation.summary.n_items, 10);
  assert.equal(orientation.summary.verdict_accuracy, 1.0);
  assert.equal(orientation.summary.upside_down_180_accuracy, 1.0);
  assert.equal(orientation.summary.sideways_90_270_accuracy, 1.0);
  assert.equal(orientation.summary.confident_wrong_dose_count, 0);

  assert.equal(promptInj.summary.verdict_matches, 8);
  assert.equal(promptInj.summary.n_items, 8);
  assert.equal(promptInj.summary.injection_resistance_rate, 1.0);
  assert.equal(promptInj.summary.hijack_success_count, 0);
  assert.equal(promptInj.summary.confident_wrong_dose_count, 0);

  assert.equal(thermalWear.summary.verdict_matches, 10);
  assert.equal(thermalWear.summary.n_items, 10);
  assert.equal(thermalWear.summary.n_moderate_wear, 6);
  assert.equal(thermalWear.summary.n_severe_wear, 4);
  assert.equal(thermalWear.summary.moderate_wear_accuracy, 1.0);
  assert.equal(thermalWear.summary.severe_wear_abstention_rate, 1.0);
  assert.equal(thermalWear.summary.confident_wrong_dose_count, 0);

  assert.equal(concurrent.summary.n_concurrent_sessions, 25);
  assert.equal(concurrent.summary.n_concurrent_websockets, 50);
  assert.equal(concurrent.summary.cross_session_leak_count, 0);
  assert.equal(concurrent.summary.isolation_pass_rate, 1.0);
  assert.equal(concurrent.summary.max_ring_len_observed, 8);
  assert.equal(concurrent.summary.post_disconnect_buffered_frames, 0);

  assert.equal(multiCoaching.summary.n_turns, 9);
  assert.deepEqual(multiCoaching.summary.languages_tested, ["en", "fi", "sv"]);
  assert.equal(multiCoaching.summary.all_checks_pass_rate, 1.0);
  assert.equal(multiCoaching.summary.dose_hallucination_count, 0);
  assert.equal(multiCoaching.summary.bystander_leak_count, 0);

  const expectedSnippets = [
    `ECE = ${calibration.summary.ece.toFixed(4)}`,
    `<code>${calibration.summary.total_items}</code>`,
    `<code>${modelComp.total_benchmark_calls}</code>`,
    `<code>${demoFixtures.summary.n_items}</code>`,
    `<code>${batch2.summary.n_items}</code>`,
    "0</code> confident-wrong dose reads",
    "gemini-3.8-live",
    `${livePrimary.firstAudioMs} ms`,
    `${liveReadyMs} ms`,
    `${glassToHudP50Ms} ms`,
    `${ingestFrameP50Ms} ms`,
    `${hudReplayP50Ms} ms`,
    `${hudBench.summary.hud_verdict_wire_bytes} B`,
    `${orientation.summary.verdict_matches}/${orientation.summary.n_items}`,
    "90/180/270 deg",
    `${promptInj.summary.verdict_matches}/${promptInj.summary.n_items}`,
    `<code>${promptInj.summary.hijack_success_count}</code> hijacks`,
    `${thermalWear.summary.verdict_matches}/${thermalWear.summary.n_items}`,
    "faded thermal sticker &amp; wet-hand smudge",
    `<code>${concurrent.summary.n_concurrent_sessions}</code>`,
    `<code>${concurrent.summary.n_concurrent_websockets}</code>`,
    `<code>${concurrent.summary.cross_session_leak_count}</code> cross-session leaks`,
    `<code>${concurrent.summary.post_disconnect_buffered_frames}</code> post-disconnect buffered frames`,
    `${multiCoaching.summary.n_turns}/${multiCoaching.summary.n_turns}`,
    `<code>${multiCoaching.summary.dose_hallucination_count}</code> dose hallucinations`,
    `<code>${multiCoaching.summary.bystander_leak_count}</code> bystander leaks`,
    `${unitEcon.headline_summary.video_bandwidth_saved_in_adaptive_mode_pct.toFixed(1)}%`,
    `EUR ${unitEcon.headline_summary.tco_3yr_holdup_rayban_meta_gen2_eur.toFixed(2)}`,
    "EUR 4,150.00",
    `${unitEcon.headline_summary.tco_savings_vs_orcam_midpoint_pct.toFixed(1)}%`
  ];

  for (const snippet of expectedSnippets) {
    assert.ok(html.includes(snippet), `Handout missing verified benchmark snippet: ${snippet}`);
  }

  const metricTiles = html.match(/class="metric-tile"/g) ?? [];
  assert.equal(metricTiles.length, 12, "Expected 12 Wave-1 through Wave-7 metric tiles in 2x6 grid");
});

test("docs/judge-handout.html inline toolbar script toggles light/dark preview and triggers window.print()", () => {
  const html = readFileSync(handoutUrl, "utf8");
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
        if (id === "btn-print-page") {
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
  assert.ok(btnHandlers["btn-print-page"], "Print button listener should register");

  btnHandlers["btn-toggle-preview"]();
  assert.equal(attrs["data-preview"], "light");
  assert.equal(previewBtnState.ariaPressed, "true");
  assert.equal(previewBtnState.textContent, "Dark Booth View");

  btnHandlers["btn-toggle-preview"]();
  assert.equal(attrs["data-preview"], "dark");
  assert.equal(previewBtnState.ariaPressed, "false");
  assert.equal(previewBtnState.textContent, "Light Print Preview");

  btnHandlers["btn-print-page"]();
  assert.equal(printCount, 1);
});
