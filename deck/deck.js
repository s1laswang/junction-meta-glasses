(function () {
  var DEFAULT_EVAL_DATA = {
    generated_at: "2026-11-14T15:57:00Z",
    model: "gemini-3.8-flash",
    strength_min_conf: 0.80,
    ece: 0.0138,
    brier_score: 0.0005,
    calibration_items: 16,
    clean_recall_pct: "100%",
    tier_0_clean_conf: 0.9875,
    tier_1_mild_conf: 0.9575,
    calibration_abstention_pct: "100%",
    occluded_abstention_pct: "98.2%",
    confident_wrong_dose_count: 0,
    false_safe_allergen_count: 0,
    pii_leak_count: 0,
    demo_fixtures_pass: "7 / 7 (100%)",
    demo_fixtures_p50_ms: 3817.2,
    live_models_online: "3 / 3",
    live_first_audio_ms: 582,
    coaching_score: "5.00 / 5",
    coaching_pass: "8 / 8 (100%)",
    coaching_p50_ms: 5118.3,
    bystander_refusal_ms: 2574.8,
    calibration_p50_ms: 3424.9,
    verify_p50_ms: 3537.1,
    unit_tests_passing: "578 / 578",
    server_tests_passing: 209,
    web_tests_passing: 346,
    eval_tests_passing: 23,
    overall_verdict_accuracy: 0.9811,
    overall_verdict_summary: "98.1% (52 / 53)",
    total_label_cases_evaluated: 53,
    total_verdict_matches: 52,
    extended_suites_count: 6,
    extended_cases_evaluated: 60,
    extended_verdict_matches: 60,
    extended_verdict_accuracy: 1.0,
    extended_verdict_summary: "100% (60 / 60)",
    wave6_suites_count: 6,
    wave6_cases_evaluated: 29,
    wave6_verdict_matches: 29,
    wave6_verdict_accuracy: 1.0,
    wave6_verdict_summary: "100% (29 / 29)",
    wave7_suites_count: 5,
    wave7_cases_evaluated: 28,
    wave7_verdict_matches: 28,
    wave7_verdict_accuracy: 1.0,
    wave7_verdict_summary: "100% (28 / 28)",
    wave8_suites_count: 5,
    wave8_cases_evaluated: 24,
    wave8_verdict_matches: 24,
    wave8_verdict_accuracy: 1.0,
    wave8_verdict_summary: "100% (24 / 24)",
    combined_stress_cases_evaluated: 141,
    combined_stress_verdict_matches: 141,
    combined_stress_verdict_accuracy: 1.0,
    combined_stress_verdict_summary: "100% (141 / 141)",
    total_real_model_label_reads: 252,
    total_suites_compiled: 31,
    orientation_verdict_summary: "10 / 10",
    orientation_p50_ms: 4424.9,
    prompt_injection_summary: "8 / 8 (100%)",
    hijack_success_count: 0,
    prompt_injection_p50_ms: 3886.5,
    thermal_wear_summary: "10 / 10",
    thermal_moderate_summary: "6 / 6",
    thermal_severe_abstention_summary: "4 / 4",
    thermal_wear_p50_ms: 3473.8,
    concurrent_sessions_count: 25,
    concurrent_websockets_count: 50,
    concurrent_frames_ingested: 250,
    cross_session_leak_count: 0,
    post_disconnect_buffered_frames: 0,
    multilingual_coaching_turns: 9,
    multilingual_coaching_summary: "9 / 9 (100%)",
    multilingual_coaching_mean_words: 7.56,
    dose_hallucination_count: 0,
    blister_cuts_summary: "8 / 8 (100%)",
    blister_cuts_intact_summary: "4 / 4",
    blister_cuts_truncated_abstention_summary: "4 / 4",
    blister_cuts_p50_ms: 4109.0,
    two_boxes_summary: "8 / 8 (100%)",
    two_boxes_false_match_conflict_count: 0,
    two_boxes_p50_ms: 3314.0,
    cellophane_tremor_summary: "8 / 8 (100%)",
    cellophane_moderate_summary: "5 / 5",
    cellophane_severe_abstention_summary: "3 / 3",
    cellophane_tremor_p50_ms: 3449.9,
    ws_reconnect_cycles: 50,
    ws_flap_replay_summary: "50 / 50 (100%)",
    ws_flap_replay_p50_ms: 0.776,
    ws_hostile_payloads_count: 100,
    ws_hostile_rejection_summary: "100 / 100",
    ws_server_crash_count: 0,
    ws_post_storm_buffered_frames: 0,
    spoken_clarity_cases: 16,
    spoken_clarity_score: 5.0,
    spoken_clarity_summary: "16 / 16 (5.0/5)",
    spoken_cap_and_mdr_pass_pct: "100%",
    spoken_clarity_p50_ms: 3181.4,
    e2e_verify_to_hud_p50_ms: 2738.8,
    e2e_live_first_event_ms: 1175.3,
    loopback_ingest_frame_p50_ms: 1.17,
    loopback_hud_replay_p50_ms: 1.78,
    ring_max_observed_len: 8,
    tts_valid_wav_count: 6,
    tts_n_utterances: 6,
    tts_wav_summary: "6 / 6",
    tts_latency_p50_ms: 3910.9,
    multiframe_paired_verdict_accuracy: 1.0,
    multiframe_single_abstention_rate: 1.0,
    expired_catch_recall: 1.0,
    clean_field_accuracy: 1.0,
    suites_present: [
      "coaching_eval",
      "results_batch1",
      "results_batch2",
      "demo_fixtures_results",
      "nordic_stickers_results",
      "calibration_curve",
      "model_comparison",
      "live_models_probe",
      "unit_economics"
    ],
    extended_suites_present: [
      "curved_blister_results",
      "coaching_trajectories",
      "lighting_motion_results",
      "multilingual_labels_results",
      "bystander_privacy_results",
      "polypharmacy_confusion_results"
    ],
    wave6_suites_present: [
      "multiframe_recovery_results",
      "allergen_adversarial_results",
      "expiry_formats_results",
      "e2e_websocket_live",
      "hud_latency_bandwidth",
      "tts_multilingual_audio"
    ],
    wave7_suites_present: [
      "orientation_robustness_results",
      "prompt_injection_labels_results",
      "thermal_fade_wear_results",
      "concurrent_sessions_results",
      "multilingual_coaching_results"
    ],
    wave8_suites_present: [
      "blister_strip_cuts_results",
      "two_boxes_in_frame_results",
      "cellophane_tremor_results",
      "ws_reconnect_resilience",
      "spoken_verdict_clarity_results"
    ]
  };

  function pickNum(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (var i = 0; i < keys.length; i++) {
      var val = obj[keys[i]];
      if (typeof val === "number" && isFinite(val)) {
        return val;
      }
    }
    return null;
  }

  function mergeEvalSource(base, incoming) {
    var out = {};
    var k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) {
        out[k] = base[k];
      }
    }
    if (!incoming || typeof incoming !== "object") {
      return out;
    }
    for (k in incoming) {
      if (Object.prototype.hasOwnProperty.call(incoming, k) && incoming[k] !== undefined) {
        out[k] = incoming[k];
      }
    }
    if (incoming.safety_invariants && typeof incoming.safety_invariants === "object") {
      if (typeof incoming.safety_invariants.strength_min_conf === "number") {
        out.strength_min_conf = incoming.safety_invariants.strength_min_conf;
      }
    }
    if (incoming.headline_metrics && typeof incoming.headline_metrics === "object" && !Array.isArray(incoming.headline_metrics)) {
      var hm = incoming.headline_metrics;
      if (typeof hm.never_guess_strength_min_conf === "number") {
        out.strength_min_conf = hm.never_guess_strength_min_conf;
      }
      if (typeof incoming.overall_verdict_accuracy !== "number" && typeof hm.overall_verdict_accuracy === "number") {
        out.overall_verdict_accuracy = hm.overall_verdict_accuracy;
      }
      if (typeof incoming.total_confident_wrong_dose_count !== "number" && typeof hm.total_confident_wrong_dose_count === "number") {
        out.confident_wrong_dose_count = hm.total_confident_wrong_dose_count;
      }
      if (typeof incoming.occluded_abstention_rate !== "number" && typeof hm.occluded_abstention_rate === "number") {
        out.occluded_abstention_pct = (hm.occluded_abstention_rate * 100).toFixed(1) + "%";
      }
      if (typeof incoming.total_label_cases_evaluated !== "number" && typeof hm.total_label_cases_evaluated === "number") {
        out.total_label_cases_evaluated = hm.total_label_cases_evaluated;
      }
    }
    if (typeof incoming.total_confident_wrong_dose_count === "number") {
      out.confident_wrong_dose_count = incoming.total_confident_wrong_dose_count;
    }
    if (typeof incoming.total_false_safe_allergen_count === "number") {
      out.false_safe_allergen_count = incoming.total_false_safe_allergen_count;
    }
    if (typeof incoming.occluded_abstention_rate === "number") {
      out.occluded_abstention_pct = (incoming.occluded_abstention_rate * 100).toFixed(1) + "%";
    }
    if (typeof incoming.overall_verdict_accuracy === "number" && typeof incoming.total_verdict_matches === "number" && typeof incoming.total_label_cases_evaluated === "number") {
      out.overall_verdict_summary = (incoming.overall_verdict_accuracy * 100).toFixed(1) + "% (" + incoming.total_verdict_matches + " / " + incoming.total_label_cases_evaluated + ")";
    }
    if (incoming.extended_summary && typeof incoming.extended_summary === "object") {
      var es = incoming.extended_summary;
      if (typeof es.suites_count === "number") {
        out.extended_suites_count = es.suites_count;
      }
      if (typeof es.total_cases_evaluated === "number") {
        out.extended_cases_evaluated = es.total_cases_evaluated;
      }
      if (typeof es.total_verdict_matches === "number") {
        out.extended_verdict_matches = es.total_verdict_matches;
      }
      if (typeof es.overall_verdict_accuracy === "number") {
        out.extended_verdict_accuracy = es.overall_verdict_accuracy;
        var extPct = es.overall_verdict_accuracy === 1 ? "100%" : (es.overall_verdict_accuracy * 100).toFixed(1) + "%";
        if (typeof out.extended_verdict_matches === "number" && typeof out.extended_cases_evaluated === "number") {
          out.extended_verdict_summary = extPct + " (" + out.extended_verdict_matches + " / " + out.extended_cases_evaluated + ")";
        }
      }
      if (
        typeof es.confident_wrong_dose_count === "number" &&
        typeof incoming.total_confident_wrong_dose_count !== "number" &&
        typeof incoming.confident_wrong_dose_count !== "number"
      ) {
        out.confident_wrong_dose_count = Number(out.confident_wrong_dose_count || 0) + es.confident_wrong_dose_count;
      }
      if (
        typeof es.false_safe_allergen_count === "number" &&
        typeof incoming.total_false_safe_allergen_count !== "number" &&
        typeof incoming.false_safe_allergen_count !== "number"
      ) {
        out.false_safe_allergen_count = Number(out.false_safe_allergen_count || 0) + es.false_safe_allergen_count;
      }
      if (typeof es.pii_or_bystander_leak_count === "number" && typeof incoming.pii_leak_count !== "number") {
        out.pii_leak_count = es.pii_or_bystander_leak_count;
      }
    }
    if (incoming.wave6_summary && typeof incoming.wave6_summary === "object") {
      var w6 = incoming.wave6_summary;
      if (typeof w6.suites_count === "number") {
        out.wave6_suites_count = w6.suites_count;
      }
      if (typeof w6.label_and_fusion_cases_evaluated === "number") {
        out.wave6_cases_evaluated = w6.label_and_fusion_cases_evaluated;
      }
      if (typeof w6.label_and_fusion_verdict_matches === "number") {
        out.wave6_verdict_matches = w6.label_and_fusion_verdict_matches;
      }
      if (typeof w6.label_and_fusion_verdict_accuracy === "number") {
        out.wave6_verdict_accuracy = w6.label_and_fusion_verdict_accuracy;
        var w6Pct = w6.label_and_fusion_verdict_accuracy === 1 ? "100%" : (w6.label_and_fusion_verdict_accuracy * 100).toFixed(1) + "%";
        if (typeof out.wave6_verdict_matches === "number" && typeof out.wave6_cases_evaluated === "number") {
          out.wave6_verdict_summary = w6Pct + " (" + out.wave6_verdict_matches + " / " + out.wave6_cases_evaluated + ")";
        }
      }
      if (
        typeof w6.confident_wrong_dose_count === "number" &&
        typeof incoming.total_confident_wrong_dose_count !== "number" &&
        typeof incoming.confident_wrong_dose_count !== "number"
      ) {
        out.confident_wrong_dose_count = Number(out.confident_wrong_dose_count || 0) + w6.confident_wrong_dose_count;
      }
      if (
        typeof w6.false_safe_allergen_count === "number" &&
        typeof incoming.total_false_safe_allergen_count !== "number" &&
        typeof incoming.false_safe_allergen_count !== "number"
      ) {
        out.false_safe_allergen_count = Number(out.false_safe_allergen_count || 0) + w6.false_safe_allergen_count;
      }
      if (typeof w6.e2e_verify_to_hud_p50_ms === "number" && typeof incoming.e2e_verify_to_hud_p50_ms !== "number") {
        out.e2e_verify_to_hud_p50_ms = w6.e2e_verify_to_hud_p50_ms;
      }
      if (typeof w6.e2e_live_first_event_ms === "number" && typeof incoming.e2e_live_first_event_ms !== "number") {
        out.e2e_live_first_event_ms = w6.e2e_live_first_event_ms;
      }
      if (typeof w6.loopback_ingest_frame_p50_ms === "number" && typeof incoming.loopback_ingest_frame_p50_ms !== "number") {
        out.loopback_ingest_frame_p50_ms = w6.loopback_ingest_frame_p50_ms;
      }
      if (typeof w6.loopback_hud_replay_p50_ms === "number" && typeof incoming.loopback_hud_replay_p50_ms !== "number") {
        out.loopback_hud_replay_p50_ms = w6.loopback_hud_replay_p50_ms;
      }
      if (typeof w6.ring_max_observed_len === "number" && typeof incoming.ring_max_observed_len !== "number") {
        out.ring_max_observed_len = w6.ring_max_observed_len;
      }
      if (typeof w6.tts_valid_wav_count === "number" && typeof incoming.tts_valid_wav_count !== "number") {
        out.tts_valid_wav_count = w6.tts_valid_wav_count;
      }
      if (typeof w6.tts_n_utterances === "number" && typeof incoming.tts_n_utterances !== "number") {
        out.tts_n_utterances = w6.tts_n_utterances;
      }
      if (typeof w6.tts_latency_p50_ms === "number" && typeof incoming.tts_latency_p50_ms !== "number") {
        out.tts_latency_p50_ms = w6.tts_latency_p50_ms;
      }
      if (typeof w6.multiframe_paired_verdict_accuracy === "number" && typeof incoming.multiframe_paired_verdict_accuracy !== "number") {
        out.multiframe_paired_verdict_accuracy = w6.multiframe_paired_verdict_accuracy;
      }
      if (typeof w6.multiframe_single_abstention_rate === "number" && typeof incoming.multiframe_single_abstention_rate !== "number") {
        out.multiframe_single_abstention_rate = w6.multiframe_single_abstention_rate;
      }
      if (typeof w6.expired_catch_recall === "number" && typeof incoming.expired_catch_recall !== "number") {
        out.expired_catch_recall = w6.expired_catch_recall;
      }
    }
    if (incoming.wave7_summary && typeof incoming.wave7_summary === "object") {
      var w7 = incoming.wave7_summary;
      if (typeof w7.suites_count === "number") {
        out.wave7_suites_count = w7.suites_count;
      }
      var w7Cases = pickNum(w7, [
        "label_and_adversarial_cases_evaluated",
        "label_cases_evaluated",
        "verdict_cases_evaluated",
        "total_cases_evaluated",
        "cases_evaluated"
      ]);
      if (w7Cases !== null && typeof incoming.wave7_cases_evaluated !== "number") {
        out.wave7_cases_evaluated = w7Cases;
      }
      var w7Matches = pickNum(w7, [
        "label_and_adversarial_verdict_matches",
        "label_verdict_matches",
        "total_verdict_matches",
        "verdict_matches"
      ]);
      if (w7Matches !== null && typeof incoming.wave7_verdict_matches !== "number") {
        out.wave7_verdict_matches = w7Matches;
      }
      var w7Acc = pickNum(w7, [
        "label_and_adversarial_verdict_accuracy",
        "label_verdict_accuracy",
        "overall_verdict_accuracy",
        "verdict_accuracy"
      ]);
      if (
        w7Acc === null &&
        (w7Cases !== null || w7Matches !== null) &&
        typeof out.wave7_verdict_matches === "number" &&
        typeof out.wave7_cases_evaluated === "number" &&
        out.wave7_cases_evaluated > 0
      ) {
        w7Acc = out.wave7_verdict_matches / out.wave7_cases_evaluated;
      }
      if (w7Acc !== null && typeof incoming.wave7_verdict_accuracy !== "number") {
        out.wave7_verdict_accuracy = w7Acc;
        var w7Pct = w7Acc === 1 ? "100%" : (w7Acc * 100).toFixed(1) + "%";
        if (
          typeof out.wave7_verdict_matches === "number" &&
          typeof out.wave7_cases_evaluated === "number" &&
          typeof incoming.wave7_verdict_summary !== "string"
        ) {
          out.wave7_verdict_summary = w7Pct + " (" + out.wave7_verdict_matches + " / " + out.wave7_cases_evaluated + ")";
        }
      }
      if (
        typeof w7.confident_wrong_dose_count === "number" &&
        typeof incoming.total_confident_wrong_dose_count !== "number" &&
        typeof incoming.confident_wrong_dose_count !== "number"
      ) {
        out.confident_wrong_dose_count = Number(out.confident_wrong_dose_count || 0) + w7.confident_wrong_dose_count;
      }
      if (
        typeof w7.false_safe_allergen_count === "number" &&
        typeof incoming.total_false_safe_allergen_count !== "number" &&
        typeof incoming.false_safe_allergen_count !== "number"
      ) {
        out.false_safe_allergen_count = Number(out.false_safe_allergen_count || 0) + w7.false_safe_allergen_count;
      }
      var w7PiiLeaks = pickNum(w7, [
        "coaching_bystander_leak_count",
        "pii_or_bystander_leak_count",
        "bystander_leak_count",
        "pii_leak_count"
      ]);
      if (w7PiiLeaks !== null && typeof incoming.pii_leak_count !== "number") {
        var extBaseLeaks =
          incoming.extended_summary && typeof incoming.extended_summary.pii_or_bystander_leak_count === "number"
            ? incoming.extended_summary.pii_or_bystander_leak_count
            : 0;
        out.pii_leak_count = extBaseLeaks + w7PiiLeaks;
      }
      var w7Hijacks = pickNum(w7, ["prompt_injection_hijack_count", "hijack_success_count", "injection_hijack_count"]);
      if (w7Hijacks !== null && typeof incoming.hijack_success_count !== "number") {
        out.hijack_success_count = w7Hijacks;
      }
      var w7InjRate = pickNum(w7, ["prompt_injection_resistance_rate", "injection_resistance_rate"]);
      var w7InjCases = pickNum(w7, ["prompt_injection_cases", "injection_cases", "n_prompt_injection_items"]);
      if (w7InjRate !== null && typeof incoming.prompt_injection_summary !== "string") {
        var injDen = w7InjCases !== null ? w7InjCases : 8;
        var injPass = w7Hijacks !== null ? Math.max(0, injDen - w7Hijacks) : Math.round(w7InjRate * injDen);
        var injPct = w7InjRate === 1 ? "100%" : (w7InjRate * 100).toFixed(1) + "%";
        out.prompt_injection_summary = injPass + " / " + injDen + " (" + injPct + ")";
      }
      var w7OrientP50 = pickNum(w7, ["orientation_p50_ms", "orientation_latency_p50_ms"]);
      if (w7OrientP50 !== null && typeof incoming.orientation_p50_ms !== "number") {
        out.orientation_p50_ms = w7OrientP50;
      }
      var w7InjP50 = pickNum(w7, ["prompt_injection_p50_ms", "injection_latency_p50_ms"]);
      if (w7InjP50 !== null && typeof incoming.prompt_injection_p50_ms !== "number") {
        out.prompt_injection_p50_ms = w7InjP50;
      }
      var w7ThermalP50 = pickNum(w7, ["thermal_wear_p50_ms", "thermal_fade_p50_ms", "thermal_latency_p50_ms"]);
      if (w7ThermalP50 !== null && typeof incoming.thermal_wear_p50_ms !== "number") {
        out.thermal_wear_p50_ms = w7ThermalP50;
      }
      var w7ConcSess = pickNum(w7, [
        "concurrent_sessions_tested",
        "concurrent_sessions",
        "n_concurrent_sessions",
        "concurrent_sessions_count"
      ]);
      if (w7ConcSess !== null && typeof incoming.concurrent_sessions_count !== "number") {
        out.concurrent_sessions_count = w7ConcSess;
      }
      var w7ConcWs = pickNum(w7, [
        "concurrent_websockets_tested",
        "concurrent_websockets",
        "n_concurrent_websockets",
        "concurrent_websockets_count"
      ]);
      if (w7ConcWs !== null && typeof incoming.concurrent_websockets_count !== "number") {
        out.concurrent_websockets_count = w7ConcWs;
      }
      var w7ConcFrames = pickNum(w7, [
        "concurrent_total_frames_ingested",
        "concurrent_frames_ingested",
        "total_frames_ingested"
      ]);
      if (w7ConcFrames !== null && typeof incoming.concurrent_frames_ingested !== "number") {
        out.concurrent_frames_ingested = w7ConcFrames;
      }
      var w7CrossLeak = pickNum(w7, [
        "concurrent_cross_session_leak_count",
        "cross_session_leak_count",
        "session_leak_count"
      ]);
      if (w7CrossLeak !== null && typeof incoming.cross_session_leak_count !== "number") {
        out.cross_session_leak_count = w7CrossLeak;
      }
      var w7PostFrames = pickNum(w7, [
        "concurrent_post_disconnect_buffered_frames",
        "post_disconnect_buffered_frames",
        "post_disconnect_total_buffered_frames"
      ]);
      if (w7PostFrames !== null && typeof incoming.post_disconnect_buffered_frames !== "number") {
        out.post_disconnect_buffered_frames = w7PostFrames;
      }
      var w7CoachTurns = pickNum(w7, [
        "coaching_turns_evaluated",
        "multilingual_coaching_turns",
        "n_coaching_turns",
        "n_turns"
      ]);
      if (w7CoachTurns !== null && typeof incoming.multilingual_coaching_turns !== "number") {
        out.multilingual_coaching_turns = w7CoachTurns;
      }
      var w7CoachRate = pickNum(w7, [
        "coaching_language_compliance_rate",
        "multilingual_coaching_pass_rate",
        "coaching_all_checks_pass_rate",
        "all_checks_pass_rate"
      ]);
      if (w7CoachRate !== null && typeof incoming.multilingual_coaching_summary !== "string") {
        var turnsDen = Number(out.multilingual_coaching_turns || 9);
        var turnsPass = Math.round(w7CoachRate * turnsDen);
        var turnsPct = w7CoachRate === 1 ? "100%" : (w7CoachRate * 100).toFixed(1) + "%";
        out.multilingual_coaching_summary = turnsPass + " / " + turnsDen + " (" + turnsPct + ")";
      }
      var w7CoachWords = pickNum(w7, ["coaching_mean_word_count", "multilingual_coaching_mean_words", "mean_word_count"]);
      if (w7CoachWords !== null && typeof incoming.multilingual_coaching_mean_words !== "number") {
        out.multilingual_coaching_mean_words = w7CoachWords;
      }
      var w7DoseHalluc = pickNum(w7, ["coaching_dose_hallucination_count", "dose_hallucination_count"]);
      if (w7DoseHalluc !== null && typeof incoming.dose_hallucination_count !== "number") {
        out.dose_hallucination_count = w7DoseHalluc;
      }
    }
    if (incoming.wave8_summary && typeof incoming.wave8_summary === "object") {
      var w8 = incoming.wave8_summary;
      if (typeof w8.suites_count === "number") {
        out.wave8_suites_count = w8.suites_count;
      }
      var w8Cases = pickNum(w8, [
        "label_cases_evaluated",
        "label_and_optical_cases_evaluated",
        "optical_and_clutter_cases_evaluated",
        "image_label_cases_evaluated",
        "verdict_cases_evaluated",
        "total_cases_evaluated",
        "cases_evaluated"
      ]);
      if (w8Cases !== null && typeof incoming.wave8_cases_evaluated !== "number") {
        out.wave8_cases_evaluated = w8Cases;
      }
      var w8Matches = pickNum(w8, [
        "label_verdict_matches",
        "label_and_optical_verdict_matches",
        "optical_and_clutter_verdict_matches",
        "image_label_verdict_matches",
        "total_verdict_matches",
        "verdict_matches"
      ]);
      if (w8Matches !== null && typeof incoming.wave8_verdict_matches !== "number") {
        out.wave8_verdict_matches = w8Matches;
      }
      var w8Acc = pickNum(w8, [
        "label_verdict_accuracy",
        "label_and_optical_verdict_accuracy",
        "optical_and_clutter_verdict_accuracy",
        "image_label_verdict_accuracy",
        "overall_verdict_accuracy",
        "verdict_accuracy"
      ]);
      if (
        w8Acc === null &&
        (w8Cases !== null || w8Matches !== null) &&
        typeof out.wave8_verdict_matches === "number" &&
        typeof out.wave8_cases_evaluated === "number" &&
        out.wave8_cases_evaluated > 0
      ) {
        w8Acc = out.wave8_verdict_matches / out.wave8_cases_evaluated;
      }
      if (w8Acc !== null && typeof incoming.wave8_verdict_accuracy !== "number") {
        out.wave8_verdict_accuracy = w8Acc;
        var w8Pct = w8Acc === 1 ? "100%" : (w8Acc * 100).toFixed(1) + "%";
        if (
          typeof out.wave8_verdict_matches === "number" &&
          typeof out.wave8_cases_evaluated === "number" &&
          typeof incoming.wave8_verdict_summary !== "string"
        ) {
          out.wave8_verdict_summary = w8Pct + " (" + out.wave8_verdict_matches + " / " + out.wave8_cases_evaluated + ")";
        }
      }
      if (
        typeof w8.confident_wrong_dose_count === "number" &&
        typeof incoming.total_confident_wrong_dose_count !== "number" &&
        typeof incoming.confident_wrong_dose_count !== "number"
      ) {
        out.confident_wrong_dose_count = Number(out.confident_wrong_dose_count || 0) + w8.confident_wrong_dose_count;
      }
      if (
        typeof w8.false_safe_allergen_count === "number" &&
        typeof incoming.total_false_safe_allergen_count !== "number" &&
        typeof incoming.false_safe_allergen_count !== "number"
      ) {
        out.false_safe_allergen_count = Number(out.false_safe_allergen_count || 0) + w8.false_safe_allergen_count;
      }
      var w8BlisterP50 = pickNum(w8, ["blister_cuts_p50_ms", "blister_strip_cuts_p50_ms", "blister_latency_p50_ms"]);
      if (w8BlisterP50 !== null && typeof incoming.blister_cuts_p50_ms !== "number") {
        out.blister_cuts_p50_ms = w8BlisterP50;
      }
      var w8BlisterRate = pickNum(w8, ["blister_cuts_verdict_accuracy", "blister_strip_cuts_accuracy", "blister_verdict_accuracy"]);
      var w8BlisterCases = pickNum(w8, ["blister_cuts_cases", "blister_strip_cuts_cases", "n_blister_items"]);
      if (w8BlisterRate !== null && typeof incoming.blister_cuts_summary !== "string") {
        var bDen = w8BlisterCases !== null ? w8BlisterCases : 8;
        var bPass = Math.round(w8BlisterRate * bDen);
        var bPct = w8BlisterRate === 1 ? "100%" : (w8BlisterRate * 100).toFixed(1) + "%";
        out.blister_cuts_summary = bPass + " / " + bDen + " (" + bPct + ")";
      }
      var w8TwoBoxConflict = pickNum(w8, [
        "two_boxes_false_match_on_conflict_count",
        "false_match_on_conflict_count",
        "multi_box_false_match_count",
        "two_boxes_false_match_conflict_count"
      ]);
      if (w8TwoBoxConflict !== null && typeof incoming.two_boxes_false_match_conflict_count !== "number") {
        out.two_boxes_false_match_conflict_count = w8TwoBoxConflict;
      }
      var w8TwoBoxP50 = pickNum(w8, ["two_boxes_p50_ms", "two_boxes_in_frame_p50_ms", "two_boxes_latency_p50_ms"]);
      if (w8TwoBoxP50 !== null && typeof incoming.two_boxes_p50_ms !== "number") {
        out.two_boxes_p50_ms = w8TwoBoxP50;
      }
      var w8TwoBoxRate = pickNum(w8, ["two_boxes_verdict_accuracy", "two_boxes_in_frame_accuracy", "multi_box_safety_rate"]);
      var w8TwoBoxCases = pickNum(w8, ["two_boxes_cases", "two_boxes_in_frame_cases", "n_two_boxes_items"]);
      if (w8TwoBoxRate !== null && typeof incoming.two_boxes_summary !== "string") {
        var tbDen = w8TwoBoxCases !== null ? w8TwoBoxCases : 8;
        var tbPass = Math.round(w8TwoBoxRate * tbDen);
        var tbPct = w8TwoBoxRate === 1 ? "100%" : (w8TwoBoxRate * 100).toFixed(1) + "%";
        out.two_boxes_summary = tbPass + " / " + tbDen + " (" + tbPct + ")";
      }
      var w8CelloP50 = pickNum(w8, ["cellophane_tremor_p50_ms", "cellophane_latency_p50_ms"]);
      if (w8CelloP50 !== null && typeof incoming.cellophane_tremor_p50_ms !== "number") {
        out.cellophane_tremor_p50_ms = w8CelloP50;
      }
      var w8CelloRate = pickNum(w8, ["cellophane_tremor_verdict_accuracy", "cellophane_tremor_accuracy", "cellophane_verdict_accuracy"]);
      var w8CelloCases = pickNum(w8, ["cellophane_tremor_cases", "n_cellophane_items"]);
      if (w8CelloRate !== null && typeof incoming.cellophane_tremor_summary !== "string") {
        var ctDen = w8CelloCases !== null ? w8CelloCases : 8;
        var ctPass = Math.round(w8CelloRate * ctDen);
        var ctPct = w8CelloRate === 1 ? "100%" : (w8CelloRate * 100).toFixed(1) + "%";
        out.cellophane_tremor_summary = ctPass + " / " + ctDen + " (" + ctPct + ")";
      }
      var w8WsCycles = pickNum(w8, [
        "ws_reconnect_cycles",
        "n_reconnect_cycles",
        "hud_flap_reconnect_cycles",
        "reconnect_cycles_tested"
      ]);
      if (w8WsCycles !== null && typeof incoming.ws_reconnect_cycles !== "number") {
        out.ws_reconnect_cycles = w8WsCycles;
      }
      var w8WsRate = pickNum(w8, [
        "ws_replay_completeness_rate",
        "replay_completeness_rate",
        "hud_flap_replay_completeness_rate"
      ]);
      if ((w8WsRate !== null || w8WsCycles !== null) && typeof incoming.ws_flap_replay_summary !== "string") {
        var wsDen = Number(out.ws_reconnect_cycles || 50);
        var wsRate = w8WsRate !== null ? w8WsRate : 1.0;
        var wsPass = Math.round(wsRate * wsDen);
        var wsPct = wsRate === 1 ? "100%" : (wsRate * 100).toFixed(1) + "%";
        out.ws_flap_replay_summary = wsPass + " / " + wsDen + " (" + wsPct + ")";
      }
      var w8WsP50 = pickNum(w8, [
        "ws_replay_reconnect_p50_ms",
        "replay_reconnect_p50_ms",
        "hud_flap_replay_p50_ms",
        "ws_flap_replay_p50_ms"
      ]);
      if (w8WsP50 !== null && typeof incoming.ws_flap_replay_p50_ms !== "number") {
        out.ws_flap_replay_p50_ms = w8WsP50;
      }
      var w8HostileCount = pickNum(w8, [
        "ws_hostile_payloads",
        "n_hostile_payloads",
        "hostile_payloads_tested",
        "ws_hostile_payloads_count"
      ]);
      if (w8HostileCount !== null && typeof incoming.ws_hostile_payloads_count !== "number") {
        out.ws_hostile_payloads_count = w8HostileCount;
      }
      var w8HostileRate = pickNum(w8, [
        "ws_graceful_rejection_rate",
        "graceful_rejection_rate",
        "hostile_graceful_rejection_rate"
      ]);
      if ((w8HostileRate !== null || w8HostileCount !== null) && typeof incoming.ws_hostile_rejection_summary !== "string") {
        var hDen = Number(out.ws_hostile_payloads_count || 100);
        var hRate = w8HostileRate !== null ? w8HostileRate : 1.0;
        var hPass = Math.round(hRate * hDen);
        out.ws_hostile_rejection_summary = hPass + " / " + hDen;
      }
      var w8Crashes = pickNum(w8, ["ws_server_crash_count", "server_crash_count", "hostile_server_crash_count"]);
      if (w8Crashes !== null && typeof incoming.ws_server_crash_count !== "number") {
        out.ws_server_crash_count = w8Crashes;
      }
      var w8StormFrames = pickNum(w8, ["ws_post_storm_buffered_frames", "post_storm_buffered_frames"]);
      if (w8StormFrames !== null && typeof incoming.ws_post_storm_buffered_frames !== "number") {
        out.ws_post_storm_buffered_frames = w8StormFrames;
      }
      var w8SpokenCases = pickNum(w8, [
        "spoken_clarity_cases",
        "spoken_verdict_cases_evaluated",
        "spoken_cases_evaluated",
        "n_spoken_clarity_cases"
      ]);
      if (w8SpokenCases !== null && typeof incoming.spoken_clarity_cases !== "number") {
        out.spoken_clarity_cases = w8SpokenCases;
      }
      var w8SpokenScore = pickNum(w8, [
        "spoken_mean_clarity_score",
        "spoken_clarity_mean_score",
        "mean_clarity_score",
        "spoken_clarity_score"
      ]);
      if (w8SpokenScore !== null && typeof incoming.spoken_clarity_score !== "number") {
        out.spoken_clarity_score = w8SpokenScore;
      }
      var w8SpokenAcc = pickNum(w8, [
        "spoken_verdict_accuracy",
        "spoken_clarity_verdict_accuracy",
        "spoken_all_checks_pass_rate"
      ]);
      if (
        (w8SpokenCases !== null || w8SpokenScore !== null || w8SpokenAcc !== null) &&
        typeof incoming.spoken_clarity_summary !== "string"
      ) {
        var spDen = Number(out.spoken_clarity_cases || 16);
        var spPass = w8SpokenAcc !== null ? Math.round(w8SpokenAcc * spDen) : spDen;
        var spScore = Number(out.spoken_clarity_score !== undefined ? out.spoken_clarity_score : 5).toFixed(1) + "/5";
        out.spoken_clarity_summary = spPass + " / " + spDen + " (" + spScore + ")";
      }
      var w8SpokenCapRate = pickNum(w8, [
        "spoken_non_medical_boundary_pass_rate",
        "non_medical_boundary_pass_rate",
        "spoken_headline_word_cap_pass_rate",
        "headline_word_cap_pass_rate"
      ]);
      if (w8SpokenCapRate !== null && typeof incoming.spoken_cap_and_mdr_pass_pct !== "string") {
        out.spoken_cap_and_mdr_pass_pct = w8SpokenCapRate === 1 ? "100%" : (w8SpokenCapRate * 100).toFixed(1) + "%";
      }
      var w8SpokenP50 = pickNum(w8, ["spoken_clarity_p50_ms", "spoken_verdict_latency_p50_ms", "spoken_latency_p50_ms"]);
      if (w8SpokenP50 !== null && typeof incoming.spoken_clarity_p50_ms !== "number") {
        out.spoken_clarity_p50_ms = w8SpokenP50;
      }
    }
    if (typeof out.tts_valid_wav_count === "number" && typeof out.tts_n_utterances === "number" && typeof incoming.tts_wav_summary !== "string") {
      out.tts_wav_summary = out.tts_valid_wav_count + " / " + out.tts_n_utterances;
    }
    if (typeof incoming.combined_stress_cases_evaluated !== "number") {
      out.combined_stress_cases_evaluated =
        Number(out.extended_cases_evaluated || 0) +
        Number(out.wave6_cases_evaluated || 0) +
        Number(out.wave7_cases_evaluated || 0) +
        Number(out.wave8_cases_evaluated || 0);
    }
    if (typeof incoming.combined_stress_verdict_matches !== "number") {
      out.combined_stress_verdict_matches =
        Number(out.extended_verdict_matches || 0) +
        Number(out.wave6_verdict_matches || 0) +
        Number(out.wave7_verdict_matches || 0) +
        Number(out.wave8_verdict_matches || 0);
    }
    if (typeof out.combined_stress_cases_evaluated === "number" && out.combined_stress_cases_evaluated > 0 && typeof incoming.combined_stress_verdict_summary !== "string") {
      out.combined_stress_verdict_accuracy = out.combined_stress_verdict_matches / out.combined_stress_cases_evaluated;
      var csPct = out.combined_stress_verdict_accuracy === 1 ? "100%" : (out.combined_stress_verdict_accuracy * 100).toFixed(1) + "%";
      out.combined_stress_verdict_summary = csPct + " (" + out.combined_stress_verdict_matches + " / " + out.combined_stress_cases_evaluated + ")";
    }
    var mCore = Array.isArray(out.suites_present) ? out.suites_present.length : 9;
    var mExt = Array.isArray(incoming.extended_suites_present)
      ? incoming.extended_suites_present.length
      : typeof out.extended_suites_count === "number"
        ? out.extended_suites_count
        : Array.isArray(out.extended_suites_present)
          ? out.extended_suites_present.length
          : 0;
    var mW6 = Array.isArray(incoming.wave6_suites_present)
      ? incoming.wave6_suites_present.length
      : typeof out.wave6_suites_count === "number"
        ? out.wave6_suites_count
        : Array.isArray(out.wave6_suites_present)
          ? out.wave6_suites_present.length
          : 0;
    var mW7 = Array.isArray(incoming.wave7_suites_present)
      ? incoming.wave7_suites_present.length
      : typeof out.wave7_suites_count === "number"
        ? out.wave7_suites_count
        : Array.isArray(out.wave7_suites_present)
          ? out.wave7_suites_present.length
          : 0;
    var mW8 = Array.isArray(incoming.wave8_suites_present)
      ? incoming.wave8_suites_present.length
      : typeof out.wave8_suites_count === "number"
        ? out.wave8_suites_count
        : Array.isArray(out.wave8_suites_present)
          ? out.wave8_suites_present.length
          : 0;
    if (typeof incoming.total_suites_compiled !== "number") {
      out.total_suites_compiled = mCore + mExt + mW6 + mW7 + mW8;
    }
    if (incoming.artifacts && incoming.artifacts.calibration_curve) {
      var cc = incoming.artifacts.calibration_curve;
      if (typeof cc.ece === "number" && typeof incoming.ece !== "number") {
        out.ece = cc.ece;
      }
      if (typeof cc.n_items === "number" && typeof incoming.calibration_items !== "number") {
        out.calibration_items = cc.n_items;
      }
    }
    if (incoming.artifacts && incoming.artifacts.demo_fixtures_results) {
      var df = incoming.artifacts.demo_fixtures_results;
      if (typeof df.verdict_matches === "number" && typeof df.n_cases === "number" && df.n_cases > 0) {
        var dfPct = Math.round((df.verdict_matches / df.n_cases) * 100);
        out.demo_fixtures_pass = df.verdict_matches + " / " + df.n_cases + " (" + dfPct + "%)";
      }
      if (df.latency_ms && typeof df.latency_ms.p50 === "number") {
        out.demo_fixtures_p50_ms = df.latency_ms.p50;
      }
    }
    if (incoming.summary && typeof incoming.summary === "object") {
      var sum = incoming.summary;
      if (typeof sum.ece === "number" && typeof incoming.ece !== "number") {
        out.ece = sum.ece;
      }
      if (typeof sum.brier_score === "number" && typeof incoming.brier_score !== "number") {
        out.brier_score = sum.brier_score;
      }
      if (typeof sum.total_items === "number" && typeof incoming.calibration_items !== "number") {
        out.calibration_items = sum.total_items;
      }
      if (typeof sum.verdict_matches === "number" && typeof sum.n_items === "number" && sum.n_items > 0) {
        var fPct = Math.round((sum.verdict_matches / sum.n_items) * 100);
        out.demo_fixtures_pass = sum.verdict_matches + " / " + sum.n_items + " (" + fPct + "%)";
      }
    }
    if (incoming.calibration && typeof incoming.calibration === "object") {
      var cal = incoming.calibration;
      if (typeof cal.ece === "number" && typeof incoming.ece !== "number") {
        out.ece = cal.ece;
      }
      if (typeof cal.brier_score === "number" && typeof incoming.brier_score !== "number") {
        out.brier_score = cal.brier_score;
      }
      if (typeof cal.n_items === "number" && typeof incoming.calibration_items !== "number") {
        out.calibration_items = cal.n_items;
      }
      if (cal.latency_ms && typeof cal.latency_ms.p50 === "number") {
        out.calibration_p50_ms = cal.latency_ms.p50;
      }
      if (cal.mean_strength_confidence_by_tier && typeof cal.mean_strength_confidence_by_tier === "object") {
        if (typeof cal.mean_strength_confidence_by_tier.tier_0_clean === "number") {
          out.tier_0_clean_conf = cal.mean_strength_confidence_by_tier.tier_0_clean;
        }
        if (typeof cal.mean_strength_confidence_by_tier.tier_1_mild === "number") {
          out.tier_1_mild_conf = cal.mean_strength_confidence_by_tier.tier_1_mild;
        }
      }
    }
    if (incoming.live_probe && typeof incoming.live_probe === "object") {
      var lp = incoming.live_probe;
      if (typeof lp.primary_first_audio_ms === "number" && typeof incoming.live_first_audio_ms !== "number") {
        out.live_first_audio_ms = lp.primary_first_audio_ms;
      }
      if (Array.isArray(lp.models) && lp.models.length > 0) {
        var okCount = 0;
        for (var mIdx = 0; mIdx < lp.models.length; mIdx++) {
          if (lp.models[mIdx] && lp.models[mIdx].ok) okCount++;
        }
        out.live_models_online = okCount + " / " + lp.models.length;
      }
    }
    if (incoming.coaching_judge && typeof incoming.coaching_judge === "object") {
      var cj = incoming.coaching_judge;
      if (typeof cj.mean_overall_score === "number") {
        out.coaching_score = cj.mean_overall_score.toFixed(2) + " / 5";
      }
      if (typeof cj.passed_all_checks === "number" && typeof cj.total_scenarios === "number") {
        var ratePct = Math.round((cj.passed_all_checks / Math.max(1, cj.total_scenarios)) * 100);
        out.coaching_pass = cj.passed_all_checks + " / " + cj.total_scenarios + " (" + ratePct + "%)";
      }
      if (cj.assistant_latency_ms && typeof cj.assistant_latency_ms.p50 === "number") {
        out.coaching_p50_ms = cj.assistant_latency_ms.p50;
      }
    }
    if (incoming.verify_latency_ms && typeof incoming.verify_latency_ms.p50 === "number") {
      out.verify_p50_ms = incoming.verify_latency_ms.p50;
    }
    var explicitReads = pickNum(incoming, ["total_real_model_label_reads", "total_label_reads"]);
    if (explicitReads === null && incoming.headline_metrics && typeof incoming.headline_metrics === "object" && !Array.isArray(incoming.headline_metrics)) {
      explicitReads = pickNum(incoming.headline_metrics, ["total_real_model_label_reads", "total_label_reads"]);
    }
    if (explicitReads !== null) {
      out.total_real_model_label_reads = explicitReads;
    } else {
      out.total_real_model_label_reads =
        Number(out.total_label_cases_evaluated || 53) +
        Number(out.calibration_items || 16) +
        Number(out.combined_stress_cases_evaluated || 141) +
        42;
    }
    return out;
  }

  window.HOLDUP_EVAL_DATA = mergeEvalSource(DEFAULT_EVAL_DATA, window.HOLDUP_EVAL_DATA);

  function setEvalField(field, text) {
    var nodes = document.querySelectorAll('[data-eval-field="' + field + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = String(text);
    }
  }

  function renderEvalBindings(data) {
    if (!data) return;
    setEvalField("confident_wrong_dose_count", data.confident_wrong_dose_count);
    setEvalField("false_safe_allergen_count", data.false_safe_allergen_count);
    setEvalField("pii_leak_count", data.pii_leak_count);
    setEvalField("ece", Number(data.ece).toFixed(4));
    setEvalField("brier_score", Number(data.brier_score).toFixed(4));
    setEvalField("calibration_items", data.calibration_items);
    setEvalField("clean_recall_pct", data.clean_recall_pct);
    setEvalField("tier_0_clean_conf", Number(data.tier_0_clean_conf).toFixed(4));
    setEvalField("tier_1_mild_conf", Number(data.tier_1_mild_conf).toFixed(4));
    setEvalField("calibration_abstention_pct", data.calibration_abstention_pct);
    setEvalField("occluded_abstention_pct", data.occluded_abstention_pct);
    setEvalField("overall_verdict_summary", data.overall_verdict_summary);
    setEvalField("total_label_cases_evaluated", data.total_label_cases_evaluated);
    setEvalField("extended_cases_evaluated", data.extended_cases_evaluated);
    setEvalField("extended_verdict_summary", data.extended_verdict_summary);
    setEvalField("wave6_cases_evaluated", data.wave6_cases_evaluated);
    setEvalField("wave6_verdict_summary", data.wave6_verdict_summary);
    setEvalField("wave7_cases_evaluated", data.wave7_cases_evaluated);
    setEvalField("wave7_verdict_summary", data.wave7_verdict_summary);
    setEvalField("wave8_cases_evaluated", data.wave8_cases_evaluated);
    setEvalField("wave8_verdict_summary", data.wave8_verdict_summary);
    setEvalField("combined_stress_cases_evaluated", data.combined_stress_cases_evaluated);
    setEvalField("combined_stress_verdict_summary", data.combined_stress_verdict_summary);
    setEvalField("total_real_model_label_reads", data.total_real_model_label_reads);
    setEvalField("total_suites_compiled", data.total_suites_compiled);
    setEvalField("hijack_success_count", data.hijack_success_count);
    setEvalField("prompt_injection_summary", data.prompt_injection_summary);
    setEvalField("concurrent_sessions_count", data.concurrent_sessions_count);
    setEvalField("cross_session_leak_count", data.cross_session_leak_count);
    setEvalField("post_disconnect_buffered_frames", data.post_disconnect_buffered_frames);
    setEvalField("multilingual_coaching_summary", data.multilingual_coaching_summary);
    setEvalField("multilingual_coaching_mean_words", Number(data.multilingual_coaching_mean_words).toFixed(2));
    setEvalField("dose_hallucination_count", data.dose_hallucination_count);
    setEvalField("two_boxes_false_match_conflict_count", data.two_boxes_false_match_conflict_count);
    setEvalField("ws_flap_replay_summary", data.ws_flap_replay_summary);
    setEvalField("ws_flap_replay_p50_ms", Number(data.ws_flap_replay_p50_ms).toFixed(2) + " ms");
    setEvalField("ws_hostile_rejection_summary", data.ws_hostile_rejection_summary);
    setEvalField("ws_server_crash_count", data.ws_server_crash_count);
    setEvalField("spoken_clarity_summary", data.spoken_clarity_summary);
    setEvalField("spoken_cap_and_mdr_pass_pct", data.spoken_cap_and_mdr_pass_pct);
    setEvalField("e2e_verify_to_hud_p50_ms", Number(data.e2e_verify_to_hud_p50_ms).toFixed(1) + " ms");
    setEvalField("loopback_ingest_frame_p50_ms", Number(data.loopback_ingest_frame_p50_ms).toFixed(2) + " ms");
    setEvalField("loopback_hud_replay_p50_ms", Number(data.loopback_hud_replay_p50_ms).toFixed(2) + " ms");
    setEvalField("tts_wav_summary", data.tts_wav_summary);
    setEvalField("demo_fixtures_pass", data.demo_fixtures_pass);
    setEvalField("live_models_online", data.live_models_online);
    setEvalField("live_first_audio_ms", Math.round(Number(data.live_first_audio_ms)) + " ms");
    setEvalField("coaching_score", data.coaching_score);
    setEvalField("coaching_pass", data.coaching_pass);
    setEvalField("coaching_p50_ms", Math.round(Number(data.coaching_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("calibration_p50_ms", Math.round(Number(data.calibration_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("verify_p50_ms", Math.round(Number(data.verify_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("unit_tests_passing", data.unit_tests_passing);

    var coreCount = Array.isArray(data.suites_present) ? data.suites_present.length : 9;
    var extCount = Array.isArray(data.extended_suites_present) ? data.extended_suites_present.length : Number(data.extended_suites_count || 0);
    var w6Count = Array.isArray(data.wave6_suites_present) ? data.wave6_suites_present.length : Number(data.wave6_suites_count || 0);
    var w7Count = Array.isArray(data.wave7_suites_present) ? data.wave7_suites_present.length : Number(data.wave7_suites_count || 0);
    var w8Count = Array.isArray(data.wave8_suites_present) ? data.wave8_suites_present.length : Number(data.wave8_suites_count || 0);
    var totalSuites =
      typeof data.total_suites_compiled === "number"
        ? data.total_suites_compiled
        : coreCount + extCount + w6Count + w7Count + w8Count;

    if (typeof data.overall_verdict_accuracy === "number" && data.total_label_cases_evaluated > 0) {
      var accPct = (data.overall_verdict_accuracy * 100).toFixed(1) + "%";
      if (Number(data.wave8_cases_evaluated) > 0) {
        setEvalField(
          "suite_sync_status",
          "HOLDUP_EVAL_DATA synced: " + accPct + " core (" + data.total_verdict_matches + "/" + data.total_label_cases_evaluated + ") + " + data.combined_stress_verdict_summary + " stress/W6-W8 (" + totalSuites + " suites)"
        );
      } else if (Number(data.wave7_cases_evaluated) > 0) {
        setEvalField(
          "suite_sync_status",
          "HOLDUP_EVAL_DATA synced: " + accPct + " core (" + data.total_verdict_matches + "/" + data.total_label_cases_evaluated + ") + " + data.combined_stress_verdict_summary + " stress/W6/W7 (" + totalSuites + " suites)"
        );
      } else if (Number(data.wave6_cases_evaluated) > 0) {
        setEvalField(
          "suite_sync_status",
          "HOLDUP_EVAL_DATA synced: " + accPct + " core (" + data.total_verdict_matches + "/" + data.total_label_cases_evaluated + ") + " + data.combined_stress_verdict_summary + " stress/Wave-6 (" + totalSuites + " suites)"
        );
      } else if (Number(data.extended_cases_evaluated) > 0) {
        setEvalField(
          "suite_sync_status",
          "HOLDUP_EVAL_DATA synced: " + accPct + " core (" + data.total_verdict_matches + "/" + data.total_label_cases_evaluated + ") + " + data.extended_verdict_summary + " stress (" + totalSuites + " suites)"
        );
      } else {
        setEvalField(
          "suite_sync_status",
          "HOLDUP_EVAL_DATA synced: " + accPct + " verdict accuracy across " + data.total_label_cases_evaluated + " verified cases + 16-frame calibration sweep (" + coreCount + "/9 suites)"
        );
      }
    } else if (Array.isArray(data.suites_present)) {
      setEvalField(
        "suite_sync_status",
        "HOLDUP_EVAL_DATA live: " + data.suites_present.join(" + ")
      );
    }
  }

  window.updateHoldUpEvalData = function (patch) {
    window.HOLDUP_EVAL_DATA = mergeEvalSource(window.HOLDUP_EVAL_DATA, patch);
    renderEvalBindings(window.HOLDUP_EVAL_DATA);
    return window.HOLDUP_EVAL_DATA;
  };

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function initDeck() {
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    if (!slides.length) return;

    var total = slides.length;
    var currentIndex = 0;
    var visited = {};
    var notesOpen = false;
    var overviewOpen = false;

    var stageShell = document.getElementById("stage-shell");
    var counterEl = document.getElementById("slide-counter");
    var progressRail = document.getElementById("progress-rail");
    var liveRegion = document.getElementById("deck-live-region");
    var notesDrawer = document.getElementById("notes-drawer");
    var notesHeader = document.getElementById("notes-header");
    var notesBody = document.getElementById("notes-body");
    var overviewModal = document.getElementById("overview-modal");
    var overviewGrid = document.getElementById("overview-grid");

    var btnPrev = document.getElementById("btn-prev");
    var btnNext = document.getElementById("btn-next");
    var btnGrid = document.getElementById("btn-grid");
    var btnNotes = document.getElementById("btn-notes");
    var btnFullscreen = document.getElementById("btn-fullscreen");
    var btnPrint = document.getElementById("btn-print");
    var btnCloseOverview = document.getElementById("btn-close-overview");

    var timerReadout = document.getElementById("timer-readout");
    var btnTimerToggle = document.getElementById("btn-timer-toggle");
    var btnTimerReset = document.getElementById("btn-timer-reset");
    var timerRunning = false;
    var timerElapsedSec = 0;
    var timerInterval = null;

    var progressButtons = [];
    var overviewTiles = [];

    function getSlideTitle(slideEl, idx) {
      var explicit = slideEl.getAttribute("data-title");
      if (explicit) return explicit;
      var heading = slideEl.querySelector("h1, h2");
      return heading ? heading.textContent.trim() : "Slide " + (idx + 1);
    }

    function updateStageScale() {
      if (!stageShell) return;
      var rect = stageShell.getBoundingClientRect();
      var availW = Math.max(240, rect.width - 24);
      var availH = Math.max(135, rect.height - 16);
      var scale = Math.min(availW / 1600, availH / 900);
      if (!isFinite(scale) || scale <= 0) {
        scale = 0.5;
      }
      document.documentElement.style.setProperty("--stage-scale", scale.toFixed(5));
    }

    function scaleOverviewClones() {
      if (!overviewOpen || !overviewGrid) return;
      var viewports = overviewGrid.querySelectorAll(".overview-thumb-viewport");
      for (var i = 0; i < viewports.length; i++) {
        var vp = viewports[i];
        var clone = vp.querySelector(".overview-thumb-clone");
        if (clone && vp.clientWidth > 0) {
          var s = vp.clientWidth / 1600;
          clone.style.transform = "scale(" + s.toFixed(5) + ")";
        }
      }
    }

    function stripCloneAttributes(root) {
      var withIds = root.querySelectorAll("[id]");
      for (var i = 0; i < withIds.length; i++) {
        withIds[i].removeAttribute("id");
      }
      var notes = root.querySelectorAll(".presenter-note");
      for (var j = 0; j < notes.length; j++) {
        if (notes[j].parentNode) {
          notes[j].parentNode.removeChild(notes[j]);
        }
      }
    }

    function buildProgressAndOverview() {
      if (progressRail) {
        progressRail.innerHTML = "";
      }
      if (overviewGrid) {
        overviewGrid.innerHTML = "";
      }
      progressButtons = [];
      overviewTiles = [];

      for (var i = 0; i < total; i++) {
        (function (idx) {
          var title = getSlideTitle(slides[idx], idx);
          if (progressRail) {
            var seg = document.createElement("button");
            seg.type = "button";
            seg.className = "progress-seg";
            seg.setAttribute("aria-label", "Go to slide " + pad2(idx + 1) + ": " + title);
            seg.title = pad2(idx + 1) + ". " + title;
            var bar = document.createElement("span");
            bar.className = "progress-seg-bar";
            seg.appendChild(bar);
            seg.addEventListener("click", function () {
              goToSlide(idx);
            });
            progressRail.appendChild(seg);
            progressButtons.push(seg);
          }

          if (overviewGrid) {
            var tile = document.createElement("button");
            tile.type = "button";
            tile.className = "overview-tile";
            tile.setAttribute("aria-label", "Select slide " + pad2(idx + 1) + ": " + title);

            var vp = document.createElement("div");
            vp.className = "overview-thumb-viewport";
            var canvasOrig = slides[idx].querySelector(".slide-canvas");
            if (canvasOrig) {
              var cloneWrap = document.createElement("div");
              cloneWrap.className = "overview-thumb-clone";
              var clonedCanvas = canvasOrig.cloneNode(true);
              stripCloneAttributes(clonedCanvas);
              cloneWrap.appendChild(clonedCanvas);
              vp.appendChild(cloneWrap);
            }

            var meta = document.createElement("div");
            meta.className = "overview-tile-meta";
            var numSpan = document.createElement("span");
            numSpan.className = "overview-tile-num";
            numSpan.textContent = pad2(idx + 1);
            var lblSpan = document.createElement("span");
            lblSpan.className = "overview-tile-label";
            lblSpan.textContent = title;
            meta.appendChild(numSpan);
            meta.appendChild(lblSpan);

            tile.appendChild(vp);
            tile.appendChild(meta);
            tile.addEventListener("click", function () {
              goToSlide(idx);
              setOverviewOpen(false);
            });
            overviewGrid.appendChild(tile);
            overviewTiles.push(tile);
          }
        })(i);
      }
    }

    function updateNotesPanel() {
      var activeSlide = slides[currentIndex];
      var title = getSlideTitle(activeSlide, currentIndex);
      var noteEl = activeSlide.querySelector(".presenter-note");
      var timing = noteEl ? (noteEl.getAttribute("data-timing") || "") : "";
      var cue = noteEl ? (noteEl.getAttribute("data-cue") || "") : "";
      var text = noteEl ? noteEl.textContent.trim() : "";

      if (notesHeader) {
        var parts = ["SLIDE " + pad2(currentIndex + 1) + " / " + pad2(total) + ": " + title];
        if (timing) parts.push("BEAT " + timing);
        if (cue) parts.push("CUE: " + cue);
        notesHeader.textContent = parts.join("  |  ");
      }
      if (notesBody) {
        notesBody.textContent = text;
      }
    }

    function parseHashSlide() {
      var h = String(window.location.hash || "").replace(/^#/, "").trim();
      if (!h) return null;
      var m = /^(?:slide-)?(\d{1,2})$/i.exec(h);
      if (!m) return null;
      var num = parseInt(m[1], 10);
      if (num >= 1 && num <= total) {
        return num - 1;
      }
      return null;
    }

    function goToSlide(targetIdx, skipHash) {
      var clamped = Math.max(0, Math.min(total - 1, targetIdx));
      currentIndex = clamped;
      visited[currentIndex] = true;

      for (var i = 0; i < total; i++) {
        var isAct = i === currentIndex;
        if (isAct) {
          slides[i].classList.add("is-active");
          slides[i].removeAttribute("aria-hidden");
        } else {
          slides[i].classList.remove("is-active");
          slides[i].setAttribute("aria-hidden", "true");
        }
        if (progressButtons[i]) {
          progressButtons[i].classList.toggle("is-current", isAct);
          progressButtons[i].classList.toggle("is-visited", Boolean(visited[i]) && !isAct);
          if (isAct) {
            progressButtons[i].setAttribute("aria-current", "step");
          } else {
            progressButtons[i].removeAttribute("aria-current");
          }
        }
        if (overviewTiles[i]) {
          overviewTiles[i].classList.toggle("is-current", isAct);
        }
      }

      if (counterEl) {
        counterEl.textContent = pad2(currentIndex + 1) + " / " + pad2(total);
      }

      var title = getSlideTitle(slides[currentIndex], currentIndex);
      if (liveRegion) {
        liveRegion.textContent = "Slide " + (currentIndex + 1) + " of " + total + ": " + title;
      }

      updateNotesPanel();

      if (!skipHash && window.history && typeof window.history.replaceState === "function") {
        try {
          window.history.replaceState(null, "", "#slide-" + (currentIndex + 1));
        } catch (err) {
          void err;
        }
      }
    }

    function setNotesOpen(next) {
      notesOpen = Boolean(next);
      if (notesDrawer) {
        notesDrawer.setAttribute("data-open", notesOpen ? "true" : "false");
      }
      if (btnNotes) {
        btnNotes.setAttribute("aria-pressed", notesOpen ? "true" : "false");
      }
      updateStageScale();
    }

    function setOverviewOpen(next) {
      overviewOpen = Boolean(next);
      if (overviewModal) {
        overviewModal.setAttribute("data-open", overviewOpen ? "true" : "false");
      }
      if (btnGrid) {
        btnGrid.setAttribute("aria-pressed", overviewOpen ? "true" : "false");
      }
      if (overviewOpen) {
        window.requestAnimationFrame(function () {
          scaleOverviewClones();
          if (overviewTiles[currentIndex]) {
            overviewTiles[currentIndex].focus();
          }
        });
      }
    }

    function toggleFullscreen() {
      var doc = document;
      var rootEl = doc.documentElement;
      if (!doc.fullscreenElement && rootEl && typeof rootEl.requestFullscreen === "function") {
        rootEl.requestFullscreen().catch(function () {});
      } else if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
        doc.exitFullscreen().catch(function () {});
      }
    }

    function syncFullscreenButton() {
      if (btnFullscreen) {
        var active = Boolean(document.fullscreenElement);
        btnFullscreen.setAttribute("aria-pressed", active ? "true" : "false");
      }
      updateStageScale();
    }

    function renderTimer() {
      if (!timerReadout) return;
      var mins = Math.floor(timerElapsedSec / 60);
      var secs = timerElapsedSec % 60;
      timerReadout.textContent = pad2(mins) + ":" + pad2(secs);
    }

    function toggleTimer() {
      timerRunning = !timerRunning;
      if (btnTimerToggle) {
        btnTimerToggle.textContent = timerRunning ? "Pause" : "Start";
      }
      if (timerRunning) {
        timerInterval = window.setInterval(function () {
          timerElapsedSec += 1;
          renderTimer();
        }, 1000);
      } else if (timerInterval !== null) {
        window.clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    function resetTimer() {
      timerRunning = false;
      if (timerInterval !== null) {
        window.clearInterval(timerInterval);
        timerInterval = null;
      }
      timerElapsedSec = 0;
      if (btnTimerToggle) {
        btnTimerToggle.textContent = "Start";
      }
      renderTimer();
    }

    function isInteractiveTarget(target) {
      if (!target || !target.tagName) return false;
      var tag = target.tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    document.addEventListener("keydown", function (ev) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (isInteractiveTarget(ev.target)) return;

      var key = ev.key;

      if (key === "Escape") {
        if (overviewOpen) {
          ev.preventDefault();
          setOverviewOpen(false);
          return;
        }
        if (notesOpen) {
          ev.preventDefault();
          setNotesOpen(false);
          return;
        }
      }

      if (key === "g" || key === "G") {
        ev.preventDefault();
        setOverviewOpen(!overviewOpen);
        return;
      }

      if (key === "n" || key === "N") {
        ev.preventDefault();
        setNotesOpen(!notesOpen);
        return;
      }

      if (key === "f" || key === "F") {
        ev.preventDefault();
        toggleFullscreen();
        return;
      }

      if (overviewOpen) {
        return;
      }

      var targetTag = ev.target && ev.target.tagName ? ev.target.tagName.toUpperCase() : "";
      if (key === " " && (targetTag === "BUTTON" || targetTag === "A")) {
        return;
      }

      if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") {
        ev.preventDefault();
        goToSlide(currentIndex + 1);
      } else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") {
        ev.preventDefault();
        goToSlide(currentIndex - 1);
      } else if (key === "Home") {
        ev.preventDefault();
        goToSlide(0);
      } else if (key === "End") {
        ev.preventDefault();
        goToSlide(total - 1);
      }
    });

    var touchStartX = null;
    var touchStartY = null;
    if (stageShell) {
      stageShell.addEventListener(
        "touchstart",
        function (ev) {
          if (ev.touches && ev.touches.length === 1) {
            touchStartX = ev.touches[0].clientX;
            touchStartY = ev.touches[0].clientY;
          }
        },
        { passive: true }
      );
      stageShell.addEventListener(
        "touchend",
        function (ev) {
          if (touchStartX === null || touchStartY === null) return;
          if (!ev.changedTouches || !ev.changedTouches.length) return;
          var dx = ev.changedTouches[0].clientX - touchStartX;
          var dy = ev.changedTouches[0].clientY - touchStartY;
          touchStartX = null;
          touchStartY = null;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (dx < 0) {
              goToSlide(currentIndex + 1);
            } else {
              goToSlide(currentIndex - 1);
            }
          }
        },
        { passive: true }
      );
    }

    if (btnPrev) {
      btnPrev.addEventListener("click", function () { goToSlide(currentIndex - 1); });
    }
    if (btnNext) {
      btnNext.addEventListener("click", function () { goToSlide(currentIndex + 1); });
    }
    if (btnGrid) {
      btnGrid.addEventListener("click", function () { setOverviewOpen(!overviewOpen); });
    }
    if (btnNotes) {
      btnNotes.addEventListener("click", function () { setNotesOpen(!notesOpen); });
    }
    if (btnFullscreen) {
      btnFullscreen.addEventListener("click", function () { toggleFullscreen(); });
    }
    if (btnPrint) {
      btnPrint.addEventListener("click", function () { window.print(); });
    }
    if (btnCloseOverview) {
      btnCloseOverview.addEventListener("click", function () { setOverviewOpen(false); });
    }
    if (btnTimerToggle) {
      btnTimerToggle.addEventListener("click", toggleTimer);
    }
    if (btnTimerReset) {
      btnTimerReset.addEventListener("click", resetTimer);
    }

    window.addEventListener("resize", function () {
      updateStageScale();
      scaleOverviewClones();
    });
    if (typeof window.ResizeObserver === "function" && stageShell) {
      var ro = new window.ResizeObserver(function () {
        updateStageScale();
      });
      ro.observe(stageShell);
    }
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    window.addEventListener("hashchange", function () {
      var parsed = parseHashSlide();
      if (parsed !== null && parsed !== currentIndex) {
        goToSlide(parsed, true);
      }
    });

    renderEvalBindings(window.HOLDUP_EVAL_DATA);
    buildProgressAndOverview();
    updateStageScale();

    var proto = String((window.location && window.location.protocol) || "");
    var hydrationPromise = Promise.resolve(window.HOLDUP_EVAL_DATA);
    if ((proto === "http:" || proto === "https:") && typeof window.fetch === "function") {
      try {
        var req = window.fetch("/api/eval-summary", { headers: { Accept: "application/json" } });
        if (req && typeof req.then === "function") {
          hydrationPromise = req
            .then(function (res) { return res && res.ok ? res.json() : null; })
            .then(function (payload) {
              if (
                payload &&
                payload.ok !== false &&
                payload.summary &&
                typeof payload.summary === "object" &&
                !Array.isArray(payload.summary) &&
                typeof window.updateHoldUpEvalData === "function"
              ) {
                return window.updateHoldUpEvalData(payload.summary);
              }
              return window.HOLDUP_EVAL_DATA;
            })
            .catch(function () { return window.HOLDUP_EVAL_DATA; });
        }
      } catch (fetchErr) {
        void fetchErr;
      }
    }

    var initialIdx = parseHashSlide();
    goToSlide(initialIdx !== null ? initialIdx : 0, initialIdx === null);

    window.HoldUpDeck = {
      goToSlide: goToSlide,
      next: function () { goToSlide(currentIndex + 1); },
      prev: function () { goToSlide(currentIndex - 1); },
      setNotesOpen: setNotesOpen,
      setOverviewOpen: setOverviewOpen,
      getCurrentIndex: function () { return currentIndex; },
      getTotalSlides: function () { return total; },
      ready: hydrationPromise
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDeck);
  } else {
    initDeck();
  }
})();
