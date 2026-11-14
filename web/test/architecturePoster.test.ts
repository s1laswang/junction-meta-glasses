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
  readdirSync(path: URL | string): string[];
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
const { existsSync, readFileSync, readdirSync } = (await import(nodeFsSpec)) as FsModule;
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
    n_verify_trials: number;
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
    total_cases_evaluated: number;
    confident_wrong_dose_count: number;
    pii_or_bystander_leak_count: number;
  };
  calibration: {
    n_items: number;
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

type ModelComparisonArtifact = {
  total_benchmark_calls: number;
};

type MultiframeRecoveryArtifact = {
  summary: {
    total_calls: number;
    confident_wrong_dose_count: number;
  };
};

type CountOnlyLabelArtifact = {
  summary: {
    n_items: number;
    confident_wrong_dose_count: number;
  };
};

type OrientationRobustnessArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    verdict_accuracy: number;
    upside_down_180_accuracy: number;
    sideways_90_270_accuracy: number;
    tilted_off_axis_accuracy: number;
    occluded_abstention_rate: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
  };
};

type PromptInjectionArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    hijack_success_count: number;
    injection_resistance_rate: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
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
    latency_p50_ms: number;
  };
};

type BlisterStripCutsArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    n_intact_tile: number;
    intact_tile_matches: number;
    n_truncated_strength: number;
    truncated_abstained_count: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
  };
};

type TwoBoxesInFrameArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    n_foreground_items: number;
    foreground_focus_matches: number;
    n_twin_box_items: number;
    multi_box_safe_count: number;
    false_match_on_conflict_count: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
  };
};

type CellophaneTremorArtifact = {
  summary: {
    n_items: number;
    verdict_matches: number;
    n_moderate_compound: number;
    n_severe_compound: number;
    moderate_compound_accuracy: number;
    severe_compound_abstention_rate: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
  };
};

type ConcurrentSessionsArtifact = {
  summary: {
    n_concurrent_sessions: number;
    n_concurrent_websockets: number;
    total_frames_ingested: number;
    cross_session_leak_count: number;
    post_disconnect_buffered_frames: number;
    concurrent_ingest_p50_ms: number;
  };
};

type WsReconnectResilienceArtifact = {
  summary: {
    n_reconnect_cycles: number;
    replay_completeness_rate: number;
    replay_reconnect_p50_ms: number;
    replay_reconnect_p95_ms: number;
    n_hostile_payloads: number;
    graceful_rejection_rate: number;
    server_crash_count: number;
  };
  hud_flap_reconnect_benchmark: {
    complete_4_msg_replays: number;
  };
  hostile_payload_storm_benchmark: {
    graceful_rejections: number;
  };
};

type SpokenVerdictClarityArtifact = {
  summary: {
    n_cases: number;
    verdict_matches: number;
    headline_word_cap: number;
    speech_sentence_cap: number;
    headline_word_cap_pass_rate: number;
    speech_sentence_cap_pass_rate: number;
    mean_headline_words: number;
    mean_clarity_score: number;
    non_medical_boundary_pass_rate: number;
    confident_wrong_dose_count: number;
    latency_p50_ms: number;
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

test("docs/architecture-poster.html cites exact measured Wave-1 through Wave-8 latency, calibration, optical, red-team, concurrency, reconnect, and spoken clarity metrics from committed eval JSON files", () => {
  const html = readFileSync(posterUrl, "utf8");

  const evalJsonFiles = readdirSync(new URL("../../eval", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const evalSuiteFiles = evalJsonFiles.filter((name) => name !== "combined_summary.json");
  assert.equal(evalJsonFiles.length, 32, "Expected 32 committed eval JSON artifacts");
  assert.equal(evalSuiteFiles.length, 31, "Expected 31 committed evaluation suites");

  const hudBench = readJsonArtifact<HudLatencyArtifact>("../../eval/hud_latency_bandwidth.json");
  const e2eLive = readJsonArtifact<E2eWebsocketLiveArtifact>("../../eval/e2e_websocket_live.json");
  const combined = readJsonArtifact<CombinedSummaryArtifact>("../../eval/combined_summary.json");
  const bystander = readJsonArtifact<BystanderPrivacyArtifact>("../../eval/bystander_privacy_results.json");
  const modelComp = readJsonArtifact<ModelComparisonArtifact>("../../eval/model_comparison.json");
  const multiframe = readJsonArtifact<MultiframeRecoveryArtifact>("../../eval/multiframe_recovery_results.json");
  const allergenAdv = readJsonArtifact<CountOnlyLabelArtifact>("../../eval/allergen_adversarial_results.json");
  const expiryFmt = readJsonArtifact<CountOnlyLabelArtifact>("../../eval/expiry_formats_results.json");

  const orientation = readJsonArtifact<OrientationRobustnessArtifact>("../../eval/orientation_robustness_results.json");
  const promptInj = readJsonArtifact<PromptInjectionArtifact>("../../eval/prompt_injection_labels_results.json");
  const thermalWear = readJsonArtifact<ThermalFadeWearArtifact>("../../eval/thermal_fade_wear_results.json");
  const blisterCuts = readJsonArtifact<BlisterStripCutsArtifact>("../../eval/blister_strip_cuts_results.json");
  const twoBoxes = readJsonArtifact<TwoBoxesInFrameArtifact>("../../eval/two_boxes_in_frame_results.json");
  const cellophaneTremor = readJsonArtifact<CellophaneTremorArtifact>("../../eval/cellophane_tremor_results.json");
  const concurrent = readJsonArtifact<ConcurrentSessionsArtifact>("../../eval/concurrent_sessions_results.json");
  const wsReconnect = readJsonArtifact<WsReconnectResilienceArtifact>("../../eval/ws_reconnect_resilience.json");
  const spokenClarity = readJsonArtifact<SpokenVerdictClarityArtifact>("../../eval/spoken_verdict_clarity_results.json");

  assert.equal(combined.safety_invariants.strength_min_conf, 0.8);
  assert.equal(combined.total_confident_wrong_dose_count, 0);
  assert.equal(combined.extended_summary.confident_wrong_dose_count, 0);
  assert.equal(combined.calibration.confident_wrong_dose_at_080, 0);
  assert.equal(e2eLive.confident_wrong_dose_count, 0);
  assert.equal(bystander.summary.confident_wrong_dose_count, 0);
  assert.equal(multiframe.summary.confident_wrong_dose_count, 0);
  assert.equal(allergenAdv.summary.confident_wrong_dose_count, 0);
  assert.equal(expiryFmt.summary.confident_wrong_dose_count, 0);
  assert.equal(orientation.summary.confident_wrong_dose_count, 0);
  assert.equal(promptInj.summary.confident_wrong_dose_count, 0);
  assert.equal(thermalWear.summary.confident_wrong_dose_count, 0);
  assert.equal(blisterCuts.summary.confident_wrong_dose_count, 0);
  assert.equal(twoBoxes.summary.confident_wrong_dose_count, 0);
  assert.equal(cellophaneTremor.summary.confident_wrong_dose_count, 0);
  assert.equal(spokenClarity.summary.confident_wrong_dose_count, 0);

  const totalRealModelLabelReads =
    combined.total_label_cases_evaluated +
    combined.calibration.n_items +
    modelComp.total_benchmark_calls +
    combined.extended_summary.total_cases_evaluated +
    multiframe.summary.total_calls +
    allergenAdv.summary.n_items +
    expiryFmt.summary.n_items +
    e2eLive.summary.n_verify_trials +
    orientation.summary.n_items +
    promptInj.summary.n_items +
    thermalWear.summary.n_items +
    blisterCuts.summary.n_items +
    twoBoxes.summary.n_items +
    cellophaneTremor.summary.n_items;
  assert.equal(totalRealModelLabelReads, 252, "Expected 252 total real-model label reads across all label suites");

  assert.equal(combined.extended_summary.pii_or_bystander_leak_count, 0);
  assert.equal(bystander.summary.pii_or_bystander_leak_count, 0);
  assert.equal(bystander.summary.verdict_matches, 8);
  assert.equal(bystander.summary.n_items, 8);

  assert.equal(orientation.summary.verdict_matches, 10);
  assert.equal(orientation.summary.n_items, 10);
  assert.equal(orientation.summary.upside_down_180_accuracy, 1);
  assert.equal(orientation.summary.sideways_90_270_accuracy, 1);
  assert.equal(orientation.summary.tilted_off_axis_accuracy, 1);

  assert.equal(promptInj.summary.verdict_matches, 8);
  assert.equal(promptInj.summary.n_items, 8);
  assert.equal(promptInj.summary.hijack_success_count, 0);
  assert.equal(promptInj.summary.injection_resistance_rate, 1);

  assert.equal(thermalWear.summary.verdict_matches, 10);
  assert.equal(thermalWear.summary.n_items, 10);
  assert.equal(thermalWear.summary.n_moderate_wear, 6);
  assert.equal(thermalWear.summary.n_severe_wear, 4);
  assert.equal(thermalWear.summary.moderate_wear_accuracy, 1);
  assert.equal(thermalWear.summary.severe_wear_abstention_rate, 1);

  assert.equal(blisterCuts.summary.verdict_matches, 8);
  assert.equal(blisterCuts.summary.n_items, 8);
  assert.equal(blisterCuts.summary.intact_tile_matches, 4);
  assert.equal(blisterCuts.summary.n_intact_tile, 4);
  assert.equal(blisterCuts.summary.truncated_abstained_count, 4);
  assert.equal(blisterCuts.summary.n_truncated_strength, 4);

  assert.equal(twoBoxes.summary.verdict_matches, 8);
  assert.equal(twoBoxes.summary.n_items, 8);
  assert.equal(twoBoxes.summary.foreground_focus_matches, 4);
  assert.equal(twoBoxes.summary.n_foreground_items, 4);
  assert.equal(twoBoxes.summary.multi_box_safe_count, 4);
  assert.equal(twoBoxes.summary.n_twin_box_items, 4);
  assert.equal(twoBoxes.summary.false_match_on_conflict_count, 0);

  assert.equal(cellophaneTremor.summary.verdict_matches, 8);
  assert.equal(cellophaneTremor.summary.n_items, 8);
  assert.equal(cellophaneTremor.summary.n_moderate_compound, 5);
  assert.equal(cellophaneTremor.summary.n_severe_compound, 3);
  assert.equal(cellophaneTremor.summary.moderate_compound_accuracy, 1);
  assert.equal(cellophaneTremor.summary.severe_compound_abstention_rate, 1);

  assert.equal(concurrent.summary.n_concurrent_sessions, 25);
  assert.equal(concurrent.summary.n_concurrent_websockets, 50);
  assert.equal(concurrent.summary.total_frames_ingested, 250);
  assert.equal(concurrent.summary.cross_session_leak_count, 0);
  assert.equal(concurrent.summary.post_disconnect_buffered_frames, 0);

  assert.equal(wsReconnect.hud_flap_reconnect_benchmark.complete_4_msg_replays, 50);
  assert.equal(wsReconnect.summary.n_reconnect_cycles, 50);
  assert.equal(wsReconnect.summary.replay_completeness_rate, 1);
  assert.equal(wsReconnect.hostile_payload_storm_benchmark.graceful_rejections, 100);
  assert.equal(wsReconnect.summary.n_hostile_payloads, 100);
  assert.equal(wsReconnect.summary.graceful_rejection_rate, 1);
  assert.equal(wsReconnect.summary.server_crash_count, 0);

  assert.equal(spokenClarity.summary.verdict_matches, 16);
  assert.equal(spokenClarity.summary.n_cases, 16);
  assert.equal(spokenClarity.summary.mean_clarity_score, 5);
  assert.equal(spokenClarity.summary.headline_word_cap, 8);
  assert.equal(spokenClarity.summary.speech_sentence_cap, 2);
  assert.equal(spokenClarity.summary.headline_word_cap_pass_rate, 1);
  assert.equal(spokenClarity.summary.speech_sentence_cap_pass_rate, 1);
  assert.equal(spokenClarity.summary.non_medical_boundary_pass_rate, 1);

  assert.equal(hudBench.summary.ingest_state_fanout_p50_ms, 1.295);
  const ingestFrameP50 = formatDecimal2(hudBench.summary.ingest_frame_p50_ms);
  const ingestFrameP95 = formatDecimal2(hudBench.summary.ingest_frame_p95_ms);
  const stateFanoutP50 = formatDecimal2(hudBench.summary.ingest_state_fanout_p50_ms);
  const hudLegP50 = formatDecimal2(hudBench.summary.hud_ws_leg_p50_ms);
  const liveLegP50 = formatDecimal2(hudBench.summary.live_ws_leg_p50_ms);
  const lateJoinReplayP50 = formatDecimal2(hudBench.summary.hud_late_join_replay_p50_ms);
  const flapReplayP50 = formatDecimal2(wsReconnect.summary.replay_reconnect_p50_ms);
  const flapReplayP95 = formatDecimal2(wsReconnect.summary.replay_reconnect_p95_ms);
  const concurrentIngestP50 = formatDecimal2(concurrent.summary.concurrent_ingest_p50_ms);
  const glassToHudVerdictP50 = formatDecimal1(e2eLive.summary.e2e_frame_to_hud_verdict_p50_ms);
  const liveReadyMs = formatDecimal1(e2eLive.summary.live_startup_to_ready_ms);

  assert.equal(ingestFrameP50, "1.17");
  assert.equal(stateFanoutP50, "1.30");
  assert.equal(lateJoinReplayP50, "1.78");
  assert.equal(flapReplayP50, "0.78");
  assert.equal(flapReplayP95, "1.01");
  assert.equal(concurrentIngestP50, "14.97");
  assert.equal(glassToHudVerdictP50, "2738.8");
  assert.equal(liveReadyMs, "431.6");
  assert.equal(hudBench.summary.ring_capacity, 8);
  assert.equal(hudBench.summary.ring_len_after_disconnect, 0);

  const expectedMetricSnippets = [
    String(evalSuiteFiles.length),
    String(evalJsonFiles.length),
    String(totalRealModelLabelReads),
    "578",
    "209",
    "346",
    "23",
    `${ingestFrameP50} ms`,
    `${ingestFrameP95} ms`,
    `${stateFanoutP50} ms`,
    `${hudLegP50} ms`,
    `${liveLegP50} ms`,
    `${lateJoinReplayP50} ms`,
    `${flapReplayP50} ms`,
    `${flapReplayP95} ms`,
    `${concurrentIngestP50} ms`,
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
    "orientation_robustness_results.json",
    `${orientation.summary.verdict_matches}/${orientation.summary.n_items}`,
    "90/180/270 deg",
    `${formatDecimal1(orientation.summary.latency_p50_ms)} ms`,
    "prompt_injection_labels_results.json",
    `${promptInj.summary.verdict_matches}/${promptInj.summary.n_items}`,
    `${formatDecimal1(promptInj.summary.latency_p50_ms)} ms`,
    "thermal_fade_wear_results.json",
    `${thermalWear.summary.n_moderate_wear}/${thermalWear.summary.n_moderate_wear}`,
    `${thermalWear.summary.n_severe_wear}/${thermalWear.summary.n_severe_wear}`,
    `${formatDecimal1(thermalWear.summary.latency_p50_ms)} ms`,
    "blister_strip_cuts_results.json",
    `${blisterCuts.summary.intact_tile_matches}/${blisterCuts.summary.n_intact_tile}`,
    `${formatDecimal1(blisterCuts.summary.latency_p50_ms)} ms`,
    "two_boxes_in_frame_results.json",
    `${formatDecimal1(twoBoxes.summary.latency_p50_ms)} ms`,
    "cellophane_tremor_results.json",
    `${cellophaneTremor.summary.n_moderate_compound}/${cellophaneTremor.summary.n_moderate_compound}`,
    `${cellophaneTremor.summary.n_severe_compound}/${cellophaneTremor.summary.n_severe_compound}`,
    `${formatDecimal1(cellophaneTremor.summary.latency_p50_ms)} ms`,
    "concurrent_sessions_results.json",
    `${concurrent.summary.n_concurrent_sessions}`,
    `${concurrent.summary.n_concurrent_websockets}`,
    "ws_reconnect_resilience.json",
    `${wsReconnect.hud_flap_reconnect_benchmark.complete_4_msg_replays}/${wsReconnect.summary.n_reconnect_cycles}`,
    `${wsReconnect.hostile_payload_storm_benchmark.graceful_rejections}/${wsReconnect.summary.n_hostile_payloads}`,
    "spoken_verdict_clarity_results.json",
    `${spokenClarity.summary.verdict_matches}/${spokenClarity.summary.n_cases}`,
    `${spokenClarity.summary.mean_clarity_score.toFixed(1)}/5`,
    `${formatDecimal1(spokenClarity.summary.latency_p50_ms)} ms`,
    "0 PII/bystander leaks",
    "0 confident-wrong doses"
  ];

  for (const snippet of expectedMetricSnippets) {
    assert.ok(html.includes(snippet), `Architecture poster missing verified eval metric snippet: ${snippet}`);
  }

  const metricCards = html.match(/class="metric-card"/g) ?? [];
  assert.equal(metricCards.length, 7, "Expected 7 headline benchmark metric cards");

  const waveCards = html.match(/class="wave-card"/g) ?? [];
  assert.equal(waveCards.length, 9, "Expected 9 Wave-7 and Wave-8 benchmark cards");
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
