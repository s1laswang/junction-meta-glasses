import argparse
import datetime
import json
import math
import pathlib
import statistics
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_EVAL_DIR = REPO_ROOT / "eval"
DEFAULT_OUT_JSON = DEFAULT_EVAL_DIR / "combined_summary.json"
DEFAULT_OUT_MD = REPO_ROOT / "docs" / "EVAL.md"

H1 = chr(35)
H2 = chr(35) * 2
H3 = chr(35) * 3

STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60
ALLERGEN_MIN_CONF = 0.60
EXPIRY_MIN_CONF = 0.70

ARTIFACT_SPECS = [
    {
        "id": "coaching_eval",
        "filename": "coaching_eval.json",
        "title": "Conversational Coaching & Bystander Privacy Judge",
        "category": "coaching_judge",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/judge_coaching.py",
    },
    {
        "id": "results_batch1",
        "filename": "results_batch1.json",
        "title": "Synthetic Medication Dataset Batch 1 (Clean & Occluded Dose Traps)",
        "category": "label_verification",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/generate_batch1.py",
    },
    {
        "id": "results_batch2",
        "filename": "results_batch2.json",
        "title": "Synthetic Food Allergen & Household Dataset Batch 2",
        "category": "label_verification",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/generate_batch2.py",
    },
    {
        "id": "demo_fixtures_results",
        "filename": "demo_fixtures_results.json",
        "title": "End-to-End HTTP /api/verify Demo Fixtures Benchmark",
        "category": "label_verification",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_demo_fixtures.py",
    },
    {
        "id": "nordic_stickers_results",
        "filename": "nordic_stickers_results.json",
        "title": "Finnish & Swedish Pharmacy Dosing Sticker Evaluation",
        "category": "label_verification",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_nordic_stickers.py",
    },
    {
        "id": "calibration_curve",
        "filename": "calibration_curve.json",
        "title": "Strength Confidence Calibration & STRENGTH_MIN_CONF Threshold Sweep",
        "category": "calibration",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/calibration_analysis.py",
    },
    {
        "id": "model_comparison",
        "filename": "model_comparison.json",
        "title": "Multi-Model Verify Fallback Chain Benchmark",
        "category": "model_comparison",
        "primary_model": "gemini-3.8-flash / gemini-3.5-flash / gemini-3-flash-preview",
        "repro_cmd": "/venv/bin/python3 eval/benchmark_models.py",
    },
    {
        "id": "live_models_probe",
        "filename": "live_models_probe.json",
        "title": "Gemini Live Multi-Model WebSocket & First-Audio Timing Probe",
        "category": "live_probe",
        "primary_model": "gemini-3.8-live / fallback chain",
        "repro_cmd": "npx tsx server/scripts/probe-live.ts --out eval/live_models_probe.json",
    },
    {
        "id": "unit_economics",
        "filename": "unit_economics.json",
        "title": "Bandwidth & Pilot Unit Economics",
        "category": "unit_economics",
        "primary_model": "gemini-3.8-live + gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/unit_economics.py",
    },
]

LABEL_SUITE_IDS = [
    "results_batch1",
    "results_batch2",
    "demo_fixtures_results",
    "nordic_stickers_results",
]

EXTENDED_ARTIFACT_SPECS = [
    {
        "id": "curved_blister_results",
        "filename": "curved_blister_results.json",
        "title": "Cylindrical Pill Bottle & Blister-Foil Glare Stress Suite",
        "dimension": "Cylindrical Pill Bottle & Blister-Foil Glare",
        "category": "optical_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_curved_blister.py",
    },
    {
        "id": "coaching_trajectories",
        "filename": "coaching_trajectories.json",
        "title": "Multi-Step Physical Hand-Coaching Trajectory Benchmark",
        "dimension": "Multi-Step Physical Hand-Coaching Trajectories",
        "category": "trajectory_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_coaching_trajectories.py",
    },
    {
        "id": "lighting_motion_results",
        "filename": "lighting_motion_results.json",
        "title": "Low-Light Sensor Noise & Motion-Blur Envelope Benchmark",
        "dimension": "Low-Light Sensor Noise & Motion-Blur Envelope",
        "category": "optical_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_lighting_motion.py",
    },
    {
        "id": "multilingual_labels_results",
        "filename": "multilingual_labels_results.json",
        "title": "Multilingual European Pharmacy & Allergen Label Benchmark",
        "dimension": "Multilingual European Pharmacy & Allergen Labels",
        "category": "multilingual_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_multilingual_labels.py",
    },
    {
        "id": "bystander_privacy_results",
        "filename": "bystander_privacy_results.json",
        "title": "Bystander Face & Background PII Non-Leakage Red-Team Benchmark",
        "dimension": "Bystander Face & Background PII Red-Team",
        "category": "privacy_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_bystander_privacy.py",
    },
    {
        "id": "polypharmacy_confusion_results",
        "filename": "polypharmacy_confusion_results.json",
        "title": "LASA & Double-Dose Polypharmacy Confusion Benchmark",
        "dimension": "LASA & Double-Dose Polypharmacy Confusion",
        "category": "clinical_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_polypharmacy_confusion.py",
    },
]

EXTENDED_SUITE_IDS = [spec["id"] for spec in EXTENDED_ARTIFACT_SPECS]

WAVE6_ARTIFACT_SPECS = [
    {
        "id": "multiframe_recovery_results",
        "filename": "multiframe_recovery_results.json",
        "title": "Multi-Frame Complementary Partial-View Fusion Benchmark",
        "dimension": "Multi-Frame Complementary Partial-View Fusion",
        "category": "multiframe_fusion",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_multiframe_recovery.py",
    },
    {
        "id": "allergen_adversarial_results",
        "filename": "allergen_adversarial_results.json",
        "title": "Scientific, Excipient & Nordic Hidden Allergen Red-Team Benchmark",
        "dimension": "Scientific, Excipient & Nordic Hidden Allergens",
        "category": "allergen_redteam",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_allergen_adversarial.py",
    },
    {
        "id": "expiry_formats_results",
        "filename": "expiry_formats_results.json",
        "title": "International, Nordic & Embossed Expiry Date Benchmark",
        "dimension": "International, Nordic & Embossed Expiry Dates",
        "category": "expiry_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_expiry_formats.py",
    },
    {
        "id": "e2e_websocket_live",
        "filename": "e2e_websocket_live.json",
        "title": "End-to-End Live WebSocket, DAT Ingest & /hud-ws Latency Benchmark",
        "dimension": "End-to-End /ingest + /api/verify + /hud-ws + /live",
        "category": "e2e_systems",
        "primary_model": "gemini-3.8-live + gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_e2e_websocket_live.py",
    },
    {
        "id": "hud_latency_bandwidth",
        "filename": "hud_latency_bandwidth.json",
        "title": "Loopback Hub Ingest, /hud-ws Fan-Out & FrameRing Systems Benchmark",
        "dimension": "Loopback Hub Ingest, /hud-ws Replay & FrameRing(8)",
        "category": "loopback_systems",
        "primary_model": "node-24-loopback",
        "repro_cmd": "/venv/bin/python3 eval/eval_hud_latency_bandwidth.py",
    },
    {
        "id": "tts_multilingual_audio",
        "filename": "tts_multilingual_audio.json",
        "title": "Multilingual Spoken Safety Verdict /api/tts WAV Synthesis Benchmark",
        "dimension": "Multilingual /api/tts WAV Audio Synthesis",
        "category": "tts_audio",
        "primary_model": "gemini-tts (/api/tts)",
        "repro_cmd": "/venv/bin/python3 eval/eval_tts_multilingual_audio.py",
    },
]

WAVE6_SUITE_IDS = [spec["id"] for spec in WAVE6_ARTIFACT_SPECS]

WAVE7_ARTIFACT_SPECS = [
    {
        "id": "orientation_robustness_results",
        "filename": "orientation_robustness_results.json",
        "title": "Blind-Hold Orientation Robustness (180, 90/270 & Off-Axis Tilt) Benchmark",
        "dimension": "Blind-Hold 180 / 90 / 270 & Off-Axis Orientation",
        "category": "orientation_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_orientation_robustness.py",
    },
    {
        "id": "prompt_injection_labels_results",
        "filename": "prompt_injection_labels_results.json",
        "title": "Visual Prompt-Injection Sticker & Adversarial Hijack Red-Team Benchmark",
        "dimension": "Visual Prompt-Injection & Hijack Red-Team",
        "category": "injection_redteam",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_prompt_injection_labels.py",
    },
    {
        "id": "thermal_fade_wear_results",
        "filename": "thermal_fade_wear_results.json",
        "title": "Thermal Fade, Wet-Hand Smudge & Worn Carton Benchmark",
        "dimension": "Thermal Fade, Wet-Hand Smudge & Worn Cartons",
        "category": "wear_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_thermal_fade_wear.py",
    },
    {
        "id": "concurrent_sessions_results",
        "filename": "concurrent_sessions_results.json",
        "title": "25-Session Concurrent Multi-User Isolation, FrameRing & Disconnect Wipe Benchmark",
        "dimension": "25-Session Concurrent Isolation & Disconnect Wipe",
        "category": "concurrency_systems",
        "primary_model": "node-24-loopback",
        "repro_cmd": "/venv/bin/python3 eval/eval_concurrent_sessions.py",
    },
    {
        "id": "multilingual_coaching_results",
        "filename": "multilingual_coaching_results.json",
        "title": "Multilingual Physical Hand-Coaching Brevity, No-Dose-Guess & Privacy Benchmark",
        "dimension": "Multilingual Hand-Coaching (en, fi, sv) Safety & Brevity",
        "category": "multilingual_coaching",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_multilingual_coaching.py",
    },
]

WAVE7_SUITE_IDS = [spec["id"] for spec in WAVE7_ARTIFACT_SPECS]

WAVE8_ARTIFACT_SPECS = [
    {
        "id": "blister_strip_cuts_results",
        "filename": "blister_strip_cuts_results.json",
        "title": "Scissor-Trimmed & Popped Blister Strip Foil Cut Benchmark",
        "dimension": "Scissor-Trimmed & Popped Blister Strip Cuts",
        "category": "blister_cut_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_blister_strip_cuts.py",
    },
    {
        "id": "two_boxes_in_frame_results",
        "filename": "two_boxes_in_frame_results.json",
        "title": "Two Boxes in Frame & Countertop Multi-Package Clutter Benchmark",
        "dimension": "Two Boxes in Frame & Multi-Package Clutter",
        "category": "multi_box_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_two_boxes_in_frame.py",
    },
    {
        "id": "cellophane_tremor_results",
        "filename": "cellophane_tremor_results.json",
        "title": "Glossy Cellophane Overwrap Glare & Hand-Tremor Compound Benchmark",
        "dimension": "Cellophane Overwrap Glare & Hand-Tremor Compound",
        "category": "compound_optical_stress",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_cellophane_tremor.py",
    },
    {
        "id": "ws_reconnect_resilience",
        "filename": "ws_reconnect_resilience.json",
        "title": "WebSocket /hud-ws Flap Replay & Hostile Payload Storm Resilience Benchmark",
        "dimension": "WebSocket Flap Replay & Hostile Payload Storm",
        "category": "resilience_systems",
        "primary_model": "node-24-loopback",
        "repro_cmd": "/venv/bin/python3 eval/eval_ws_reconnect_resilience.py",
    },
    {
        "id": "spoken_verdict_clarity_results",
        "filename": "spoken_verdict_clarity_results.json",
        "title": "Spoken Safety Verdict Clarity, Brevity & EU MDR Boundary Judge Benchmark",
        "dimension": "Spoken Verdict Clarity, Caps & EU MDR Boundary",
        "category": "spoken_clarity_judge",
        "primary_model": "gemini-3.8-flash",
        "repro_cmd": "/venv/bin/python3 eval/eval_spoken_verdict_clarity.py",
    },
]

WAVE8_SUITE_IDS = [spec["id"] for spec in WAVE8_ARTIFACT_SPECS]
OPTIONAL_SUITE_IDS = [*EXTENDED_SUITE_IDS, *WAVE6_SUITE_IDS, *WAVE7_SUITE_IDS, *WAVE8_SUITE_IDS]


def clean_text(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).replace(chr(0x2014), " - ").replace(chr(0x2013), "-")
    return " ".join(s.split())


def md_cell(val: Any) -> str:
    return clean_text(val).replace("|", "\\|")


def to_num(val: Any) -> float | None:
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)) and math.isfinite(val):
        return float(val)
    return None


def to_int(val: Any) -> int | None:
    n = to_num(val)
    return int(round(n)) if n is not None else None


def to_rate(val: Any) -> float | None:
    n = to_num(val)
    if n is None:
        return None
    if 1.0 < n <= 100.0:
        return round(n / 100.0, 4)
    return round(max(0.0, min(1.0, n)), 4)


def first_val(mapping: dict[str, Any], keys: list[str]) -> Any:
    for k in keys:
        if k in mapping and mapping[k] is not None:
            return mapping[k]
    return None


def percentile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def extract_items(data: dict[str, Any]) -> list[dict[str, Any]]:
    for key in (
        "items",
        "pairs",
        "turns",
        "utterances",
        "sessions",
        "ingest_frame_verify_hud_trials",
        "verify_trials",
        "fixtures",
        "cases",
        "results",
        "scenarios",
        "trajectories",
        "verify_checks",
        "verify_results",
        "checks",
    ):
        val = data.get(key)
        if isinstance(val, list) and all(isinstance(x, dict) for x in val):
            return val
    summary = data.get("summary")
    if isinstance(summary, dict):
        for key in (
            "items",
            "pairs",
            "turns",
            "utterances",
            "sessions",
            "ingest_frame_verify_hud_trials",
            "verify_trials",
            "fixtures",
            "verify_checks",
            "verify_results",
            "checks",
        ):
            val = summary.get(key)
            if isinstance(val, list) and all(isinstance(x, dict) for x in val):
                return val
    return []


def extract_latency(summary: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, float | None]:
    nested = summary.get("latency_ms") if isinstance(summary.get("latency_ms"), dict) else {}
    p50 = to_num(first_val(summary, ["latency_p50_ms", "p50_latency_ms", "p50_ms"]))
    if p50 is None:
        p50 = to_num(first_val(nested, ["p50", "median"]))
    p95 = to_num(first_val(summary, ["latency_p95_ms", "p95_latency_ms", "p95_ms"]))
    if p95 is None:
        p95 = to_num(first_val(nested, ["p95", "max"]))
    mean = to_num(first_val(summary, ["latency_mean_ms", "mean_latency_ms", "mean_ms"]))
    if mean is None:
        mean = to_num(first_val(nested, ["mean", "avg"]))

    item_lats: list[float] = []
    for it in items:
        v = to_num(first_val(it, ["latency_ms", "latencyMs", "ms", "elapsed_ms", "assistant_latency_ms"]))
        if v is not None:
            item_lats.append(v)

    if p50 is None and item_lats:
        p50 = percentile(item_lats, 0.50)
    if p95 is None and item_lats:
        p95 = percentile(item_lats, 0.95)
    if mean is None and item_lats:
        mean = round(statistics.mean(item_lats), 1)

    return {
        "p50": round(p50, 1) if p50 is not None else None,
        "p95": round(p95, 1) if p95 is not None else None,
        "mean": round(mean, 1) if mean is not None else None,
    }


def item_verdict_level(item: dict[str, Any]) -> str | None:
    v = item.get("verdict")
    if isinstance(v, dict) and isinstance(v.get("level"), str):
        return v["level"]
    for key in ("predicted_level", "actual_level", "verdict_level", "level"):
        if isinstance(item.get(key), str):
            return item[key]
    return None


def item_expected_level(item: dict[str, Any]) -> str | None:
    for key in ("expected_level", "expected_verdict", "target_level"):
        if isinstance(item.get(key), str):
            return item[key]
    gt = item.get("ground_truth")
    if isinstance(gt, dict):
        for key in ("expected_level", "expected_verdict", "level"):
            if isinstance(gt.get(key), str):
                return gt[key]
    return None


def item_is_verdict_match(item: dict[str, Any]) -> bool | None:
    for key in ("verdict_match", "verdict_correct", "match_expected", "correct", "passed"):
        if isinstance(item.get(key), bool):
            return item[key]
    pred = item_verdict_level(item)
    acc = item.get("accepted_levels")
    if pred and isinstance(acc, list) and acc and all(isinstance(x, str) for x in acc):
        return pred in acc
    exp = item_expected_level(item)
    if pred and exp:
        return pred == exp
    return None


def normalize_label_suite(suite_id: str, data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    n_cases = to_int(first_val(summary, ["n_items", "n_fixtures", "n_cases", "total_items", "total_cases", "total", "count"]))
    if n_cases is None:
        n_cases = len(items)

    verdict_acc = to_rate(first_val(summary, ["verdict_accuracy", "accuracy", "overall_accuracy"]))
    verdict_matches = to_int(first_val(summary, ["verdict_matches", "verdict_correct", "correct_verdicts", "matches", "passed_count"]))

    item_matches = [m for it in items if (m := item_is_verdict_match(it)) is not None]
    if verdict_matches is None and item_matches and len(item_matches) == n_cases:
        verdict_matches = sum(1 for m in item_matches if m)
    if verdict_acc is None and verdict_matches is not None and n_cases > 0:
        verdict_acc = round(verdict_matches / n_cases, 4)
    if verdict_matches is None and verdict_acc is not None and n_cases > 0:
        verdict_matches = int(round(verdict_acc * n_cases))

    cwd = to_int(first_val(summary, ["confident_wrong_dose_count", "confident_wrong_doses", "wrong_confident_dose_count"]))
    if cwd is None:
        item_cwd = [bool(it.get("confident_wrong_dose")) for it in items if "confident_wrong_dose" in it]
        cwd = sum(1 for x in item_cwd if x) if item_cwd else 0

    clean_field_acc = to_rate(first_val(summary, ["clean_field_accuracy", "clean_strength_accuracy", "strength_accuracy", "field_accuracy"]))
    occluded_abst = to_rate(first_val(summary, ["occluded_abstention_rate", "degraded_abstention_rate", "unreadable_abstention_rate", "abstention_rate"]))

    if clean_field_acc is None or occluded_abst is None:
        clean_ok: list[bool] = []
        occ_ok: list[bool] = []
        for it in items:
            gt = it.get("ground_truth") if isinstance(it.get("ground_truth"), dict) else it
            sr = gt.get("strength_readable") if "strength_readable" in gt else it.get("strength_readable")
            if isinstance(sr, bool):
                if sr:
                    m = it.get("strength_correct")
                    if not isinstance(m, bool):
                        m = item_is_verdict_match(it)
                    if isinstance(m, bool):
                        clean_ok.append(m)
                else:
                    lvl = item_verdict_level(it)
                    abstained = it.get("abstained") if isinstance(it.get("abstained"), bool) else (lvl == "unsure" if lvl else None)
                    if isinstance(abstained, bool):
                        occ_ok.append(abstained)
        if clean_field_acc is None and clean_ok:
            clean_field_acc = round(sum(1 for x in clean_ok if x) / len(clean_ok), 4)
        if occluded_abst is None and occ_ok:
            occluded_abst = round(sum(1 for x in occ_ok if x) / len(occ_ok), 4)

    allergen_recall = to_rate(first_val(summary, ["allergen_recall", "allergen_sensitivity"]))
    false_safe_allergen = to_int(first_val(summary, ["false_safe_allergen_count", "false_negative_allergen_count"]))
    comma_matched = first_val(summary, ["comma_decimal_matched", "comma_decimal_ok"])
    if isinstance(comma_matched, (int, float)) and not isinstance(comma_matched, bool):
        comma_matched = bool(comma_matched > 0)

    lat = extract_latency(summary, items)
    tokens_in = to_num(first_val(summary, ["tokens_in", "mean_tokens_in", "total_tokens_in", "input_tokens"]))
    tokens_out = to_num(first_val(summary, ["tokens_out", "mean_tokens_out", "total_tokens_out", "output_tokens"]))
    model = clean_text(first_val(summary, ["model", "verify_model"]) or data.get("model") or "gemini-3.8-flash")

    rows: list[dict[str, Any]] = []
    for idx, it in enumerate(items, start=1):
        item_id = clean_text(first_val(it, ["id", "case_id", "fixture", "file", "name"]) or f"{suite_id}_{idx:02d}")
        read_obj = it.get("read") if isinstance(it.get("read"), dict) else (
            it.get("verdict", {}).get("read") if isinstance(it.get("verdict"), dict) and isinstance(it["verdict"].get("read"), dict) else {}
        )
        strength_field = read_obj.get("strength") if isinstance(read_obj.get("strength"), dict) else {}
        s_val = strength_field.get("value") if "value" in strength_field else first_val(it, ["predicted_strength", "strength_value", "strength"])
        s_conf = to_num(strength_field.get("confidence") if "confidence" in strength_field else first_val(it, ["strength_confidence", "strength_conf"]))
        item_lat = to_num(first_val(it, ["latency_ms", "latencyMs", "ms", "elapsed_ms"]))
        rows.append(
            {
                "id": item_id,
                "expected_level": item_expected_level(it),
                "predicted_level": item_verdict_level(it),
                "verdict_match": item_is_verdict_match(it),
                "strength_value": clean_text(s_val) if s_val is not None else None,
                "strength_confidence": round(s_conf, 3) if s_conf is not None else None,
                "confident_wrong_dose": bool(it.get("confident_wrong_dose", False)),
                "latency_ms": round(item_lat, 1) if item_lat is not None else None,
            }
        )

    return {
        "suite_id": suite_id,
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_cases": n_cases,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_acc,
        "confident_wrong_dose_count": cwd,
        "clean_field_accuracy": clean_field_acc,
        "occluded_abstention_rate": occluded_abst,
        "allergen_recall": allergen_recall,
        "false_safe_allergen_count": false_safe_allergen,
        "comma_decimal_matched": comma_matched if isinstance(comma_matched, bool) else None,
        "latency_ms": lat,
        "tokens_in": round(tokens_in, 1) if tokens_in is not None else None,
        "tokens_out": round(tokens_out, 1) if tokens_out is not None else None,
        "rows": rows,
    }


def normalize_coaching(data: dict[str, Any]) -> dict[str, Any]:
    s = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    scenarios = data.get("scenarios") if isinstance(data.get("scenarios"), list) else []
    total = to_int(first_val(s, ["total_scenarios", "n_scenarios"])) or len(scenarios)
    passed = to_int(first_val(s, ["passed_all_checks", "passed"]))
    if passed is None and scenarios:
        passed = sum(1 for sc in scenarios if sc.get("passed_all"))
    pass_rate = to_rate(first_val(s, ["all_checks_pass_rate", "pass_rate"]))
    if pass_rate is None and passed is not None and total > 0:
        pass_rate = round(passed / total, 4)

    dims_raw = s.get("dimension_pass_rates") if isinstance(s.get("dimension_pass_rates"), dict) else {}
    dims = {k: to_rate(v) for k, v in dims_raw.items()}

    asst_lat = s.get("assistant_latency_ms") if isinstance(s.get("assistant_latency_ms"), dict) else {}
    judge_lat = s.get("judge_latency_ms") if isinstance(s.get("judge_latency_ms"), dict) else {}

    rows: list[dict[str, Any]] = []
    for sc in scenarios:
        if not isinstance(sc, dict):
            continue
        judge_obj = sc.get("judge") if isinstance(sc.get("judge"), dict) else {}
        tcs = sc.get("tool_calls") if isinstance(sc.get("tool_calls"), list) else []
        tool_names = [clean_text(tc.get("name", "")) for tc in tcs if isinstance(tc, dict) and tc.get("name")]
        rows.append(
            {
                "id": clean_text(sc.get("id", "")),
                "user_prompt": clean_text(sc.get("user_prompt", "")),
                "tools": tool_names,
                "final_speech": clean_text(sc.get("final_speech", "")),
                "assistant_latency_ms": to_num(sc.get("assistant_latency_ms")),
                "judge_latency_ms": to_num(sc.get("judge_latency_ms")),
                "score": to_int(judge_obj.get("overall_score_1_to_5")),
                "passed_all": bool(sc.get("passed_all", False)),
                "rationale": clean_text(judge_obj.get("rationale", "")),
            }
        )

    return {
        "generated_at": clean_text(data.get("generated_at", "")),
        "model": clean_text(s.get("model", "gemini-3.8-flash")),
        "judge_model": clean_text(s.get("judge_model", "gemini-3.8-flash")),
        "total_scenarios": total,
        "passed_all_checks": passed if passed is not None else 0,
        "all_checks_pass_rate": pass_rate,
        "mean_overall_score": to_num(s.get("mean_overall_score")),
        "min_overall_score": to_int(s.get("min_overall_score")),
        "max_overall_score": to_int(s.get("max_overall_score")),
        "dimension_pass_rates": dims,
        "assistant_latency_ms": {
            "p50": to_num(asst_lat.get("p50")),
            "mean": to_num(asst_lat.get("mean")),
            "max": to_num(asst_lat.get("max")),
        },
        "judge_latency_ms": {
            "p50": to_num(judge_lat.get("p50")),
            "mean": to_num(judge_lat.get("mean")),
            "max": to_num(judge_lat.get("max")),
        },
        "scenarios": rows,
    }


def normalize_calibration(data: dict[str, Any]) -> dict[str, Any]:
    s = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)
    n_items = to_int(first_val(s, ["total_items", "n_items", "total", "count"]))
    if n_items is None:
        n_items = len(items)
    readable_items = to_int(first_val(s, ["readable_items", "n_readable"]))
    unreadable_items = to_int(first_val(s, ["unreadable_items", "n_unreadable"]))

    ece = to_num(first_val(s, ["ece", "expected_calibration_error"]))
    if ece is None:
        ece = to_num(data.get("ece"))
    brier_score = to_num(first_val(s, ["brier_score", "brier"]))
    if brier_score is None:
        brier_score = to_num(first_val(data, ["brier_score", "brier"]))

    tier_container = s
    for cand in (
        s.get("mean_strength_confidence_by_tier"),
        s.get("tier_mean_confidence"),
        s.get("tiers"),
        data.get("mean_strength_confidence_by_tier"),
        data.get("tier_mean_confidence"),
        data.get("tiers"),
    ):
        if isinstance(cand, dict):
            tier_container = cand
            break

    tiers: dict[str, float | None] = {
        "tier_0_clean": to_num(first_val(tier_container, ["tier_0_clean", "clean", "tier_0", "0"])),
        "tier_1_mild": to_num(first_val(tier_container, ["tier_1_mild", "mild_blur", "tier_1", "1"])),
        "tier_2_heavy": to_num(first_val(tier_container, ["tier_2_heavy", "heavy_blur_glare", "tier_2", "2"])),
        "tier_3_occluded": to_num(first_val(tier_container, ["tier_3_occluded", "severe_occlusion", "tier_3", "3"])),
    }

    if items and any(v is None for v in tiers.values()):
        for t_idx, t_key in enumerate(("tier_0_clean", "tier_1_mild", "tier_2_heavy", "tier_3_occluded")):
            if tiers[t_key] is None:
                t_confs = [
                    c
                    for it in items
                    if (it.get("tier") == t_key or it.get("tier_index") == t_idx)
                    and (c := to_num(first_val(it, ["strength_confidence", "raw_strength_confidence"]))) is not None
                ]
                if t_confs:
                    tiers[t_key] = round(statistics.mean(t_confs), 4)

    lat_raw = (
        s.get("latency_ms")
        if isinstance(s.get("latency_ms"), dict)
        else (data.get("latency_ms") if isinstance(data.get("latency_ms"), dict) else {})
    )
    item_lats = [
        v
        for it in items
        if (v := to_num(first_val(it, ["latency_ms", "latencyMs", "ms", "elapsed_ms"]))) is not None
    ]
    lat_p50 = to_num(first_val(lat_raw, ["p50", "median"]))
    if lat_p50 is None:
        lat_p50 = to_num(first_val(s, ["latency_p50_ms", "p50_latency_ms", "p50_ms"]))
    if lat_p50 is None and item_lats:
        lat_p50 = percentile(item_lats, 0.50)

    lat_mean = to_num(first_val(lat_raw, ["mean", "avg"]))
    if lat_mean is None:
        lat_mean = to_num(first_val(s, ["latency_mean_ms", "mean_latency_ms", "mean_ms"]))
    if lat_mean is None and item_lats:
        lat_mean = round(statistics.mean(item_lats), 1)

    lat_max = to_num(first_val(lat_raw, ["max"]))
    if lat_max is None:
        lat_max = to_num(first_val(s, ["latency_max_ms", "max_latency_ms", "max_ms"]))
    if lat_max is None and item_lats:
        lat_max = round(max(item_lats), 1)

    latency_ms = {
        "p50": round(lat_p50, 1) if lat_p50 is not None else None,
        "mean": round(lat_mean, 1) if lat_mean is not None else None,
        "max": round(lat_max, 1) if lat_max is not None else None,
    }

    raw_curve = first_val(data, ["threshold_curve", "threshold_sweep", "thresholds", "curve", "sweep", "risk_coverage"])
    if raw_curve is None:
        raw_curve = first_val(s, ["threshold_curve", "threshold_sweep", "thresholds", "curve", "sweep", "risk_coverage"])
    curve_rows: list[dict[str, Any]] = []
    if isinstance(raw_curve, list):
        for entry in raw_curve:
            if not isinstance(entry, dict):
                continue
            th = to_num(first_val(entry, ["threshold", "min_conf", "gate"]))
            if th is None:
                continue
            curve_rows.append(
                {
                    "threshold": round(th, 2),
                    "clean_recall": to_rate(first_val(entry, ["clean_recall", "readable_recall", "recall"])),
                    "unreadable_abstention_rate": to_rate(first_val(entry, ["unreadable_abstention_rate", "occluded_abstention_rate", "abstention_rate"])),
                    "confident_wrong_dose_count": to_int(first_val(entry, ["confident_wrong_dose_count", "confident_wrong_doses"])),
                    "accepted_count": to_int(entry.get("accepted_count")),
                    "coverage": to_rate(entry.get("coverage")),
                    "selective_risk": to_rate(entry.get("selective_risk")),
                }
            )
    elif isinstance(raw_curve, dict):
        for k, entry in raw_curve.items():
            if not isinstance(entry, dict):
                continue
            try:
                th = float(k)
            except ValueError:
                th = to_num(entry.get("threshold"))
            if th is None:
                continue
            curve_rows.append(
                {
                    "threshold": round(th, 2),
                    "clean_recall": to_rate(first_val(entry, ["clean_recall", "readable_recall", "recall"])),
                    "unreadable_abstention_rate": to_rate(first_val(entry, ["unreadable_abstention_rate", "occluded_abstention_rate", "abstention_rate"])),
                    "confident_wrong_dose_count": to_int(first_val(entry, ["confident_wrong_dose_count", "confident_wrong_doses"])),
                    "accepted_count": to_int(entry.get("accepted_count")),
                    "coverage": to_rate(entry.get("coverage")),
                    "selective_risk": to_rate(entry.get("selective_risk")),
                }
            )
    curve_rows.sort(key=lambda r: r["threshold"])

    gate_row = next((r for r in curve_rows if abs(r["threshold"] - STRENGTH_MIN_CONF) < 1e-6), None)
    at_080_obj = s.get("at_production_threshold_0_80") if isinstance(s.get("at_production_threshold_0_80"), dict) else {}
    cwd_at_080 = (
        gate_row["confident_wrong_dose_count"]
        if gate_row and gate_row["confident_wrong_dose_count"] is not None
        else to_int(first_val(at_080_obj, ["confident_wrong_dose_count"]))
    )
    if cwd_at_080 is None:
        cwd_at_080 = to_int(first_val(s, ["confident_wrong_dose_count", "confident_wrong_dose_at_080"]))

    normalized_tiers = {k: round(v, 4) if v is not None else None for k, v in tiers.items()}
    thinking_lvl = clean_text(s.get("thinking_level", ""))

    return {
        "generated_at": clean_text(data.get("generated_at", "")),
        "model": clean_text(first_val(s, ["model"]) or data.get("model") or "gemini-3.8-flash"),
        "thinking_level": thinking_lvl if thinking_lvl else None,
        "n_items": n_items,
        "readable_items": readable_items,
        "unreadable_items": unreadable_items,
        "ece": round(ece, 4) if ece is not None else None,
        "brier_score": round(brier_score, 4) if brier_score is not None else None,
        "latency_ms": latency_ms,
        "mean_strength_confidence_by_tier": normalized_tiers,
        "tier_mean_confidence": dict(normalized_tiers),
        "confident_wrong_dose_at_080": cwd_at_080,
        "threshold_curve": curve_rows,
    }


def normalize_model_comparison(data: dict[str, Any]) -> dict[str, Any]:
    raw_models = data.get("models")
    rows: list[dict[str, Any]] = []
    n_cards = to_int(first_val(data, ["n_cards", "n_items", "n_probes"]))
    if n_cards is None and isinstance(data.get("cards"), list):
        n_cards = len(data["cards"])

    entries: list[tuple[str, dict[str, Any]]] = []
    if isinstance(raw_models, dict):
        for m_name, stats in raw_models.items():
            if isinstance(stats, dict):
                entries.append((str(m_name), stats))
    elif isinstance(raw_models, list):
        for item in raw_models:
            if isinstance(item, dict) and item.get("model"):
                entries.append((str(item["model"]), item))

    for m_name, stats in entries:
        lat = extract_latency(stats, [])
        mc = to_int(first_val(stats, ["n_cards", "n_items", "total"])) or n_cards or 12
        rows.append(
            {
                "model": clean_text(m_name),
                "n_cards": mc,
                "verdict_accuracy": to_rate(first_val(stats, ["verdict_accuracy", "accuracy"])),
                "clean_field_accuracy": to_rate(first_val(stats, ["clean_field_accuracy", "field_accuracy", "strength_accuracy"])),
                "occluded_abstention_rate": to_rate(first_val(stats, ["occluded_abstention_rate", "unreadable_abstention_rate", "abstention_rate"])),
                "confident_wrong_dose_count": to_int(first_val(stats, ["confident_wrong_dose_count", "confident_wrong_doses"])),
                "latency_p50_ms": lat["p50"],
                "latency_p95_ms": lat["p95"],
                "mean_tokens_in": to_num(first_val(stats, ["mean_tokens_in", "tokens_in_mean", "tokens_in"])),
                "mean_tokens_out": to_num(first_val(stats, ["mean_tokens_out", "tokens_out_mean", "tokens_out"])),
                "mean_tokens_thinking": to_num(first_val(stats, ["mean_tokens_thinking", "tokens_thinking_mean", "tokens_thinking"])),
            }
        )

    return {
        "generated_at": clean_text(data.get("generated_at", "")),
        "n_cards": n_cards or (rows[0]["n_cards"] if rows else 0),
        "models": rows,
    }


def normalize_live_probe(data: dict[str, Any]) -> dict[str, Any]:
    raw_list = first_val(data, ["results", "models", "probes"])
    rows: list[dict[str, Any]] = []
    if isinstance(raw_list, list):
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            kinds_raw = item.get("kinds")
            kinds = [clean_text(x) for x in kinds_raw] if isinstance(kinds_raw, list) else []
            conn = to_num(first_val(item, ["connectMs", "connect_ms"]))
            first_aud = to_num(first_val(item, ["firstAudioMs", "first_audio_ms"]))
            rows.append(
                {
                    "model": clean_text(item.get("model", "")),
                    "ok": bool(item.get("ok", False)),
                    "connect_ms": round(conn, 1) if conn is not None else None,
                    "first_audio_ms": round(first_aud, 1) if first_aud is not None else None,
                    "kinds": kinds,
                    "error": clean_text(item.get("error", "")) if item.get("error") else None,
                }
            )
    primary_ok = next((r for r in rows if r["ok"]), rows[0] if rows else None)
    return {
        "tested_at": clean_text(first_val(data, ["testedAt", "tested_at", "generated_at"]) or ""),
        "primary_model": primary_ok["model"] if primary_ok else None,
        "primary_connect_ms": primary_ok["connect_ms"] if primary_ok else None,
        "primary_first_audio_ms": primary_ok["first_audio_ms"] if primary_ok else None,
        "models": rows,
    }


def normalize_unit_economics(data: dict[str, Any]) -> dict[str, Any]:
    hs = data.get("headline_summary") if isinstance(data.get("headline_summary"), dict) else {}
    bw = data.get("bandwidth_per_12s_check") if isinstance(data.get("bandwidth_per_12s_check"), dict) else {}
    norm_bw = bw.get("normal_mode") if isinstance(bw.get("normal_mode"), dict) else {}
    adap_bw = bw.get("slow_network_adaptive_mode") if isinstance(bw.get("slow_network_adaptive_mode"), dict) else {}
    deg_bw = bw.get("degraded_fallbacks") if isinstance(bw.get("degraded_fallbacks"), dict) else {}
    snap_bw = deg_bw.get("snapshot_http_verify_2_adaptive_frames") if isinstance(deg_bw.get("snapshot_http_verify_2_adaptive_frames"), dict) else {}
    off_bw = deg_bw.get("offline_barcode_detector") if isinstance(deg_bw.get("offline_barcode_detector"), dict) else {}

    tcm = data.get("token_and_cost_model") if isinstance(data.get("token_and_cost_model"), dict) else {}
    cadence = tcm.get("usage_cadence") if isinstance(tcm.get("usage_cadence"), dict) else {}
    pct = tcm.get("per_check_tokens") if isinstance(tcm.get("per_check_tokens"), dict) else {}
    tiers_raw = tcm.get("published_pricing_tiers") if isinstance(tcm.get("published_pricing_tiers"), dict) else {}

    def extract_pricing_tier(t_obj: Any) -> dict[str, float | None]:
        d = t_obj if isinstance(t_obj, dict) else {}
        pce = d.get("per_check_eur") if isinstance(d.get("per_check_eur"), dict) else {}
        pcu = d.get("per_check_breakdown_usd") if isinstance(d.get("per_check_breakdown_usd"), dict) else {}
        m120 = d.get("monthly_120_checks") if isinstance(d.get("monthly_120_checks"), dict) else {}
        a1440 = d.get("annual_1440_checks") if isinstance(d.get("annual_1440_checks"), dict) else {}
        y3 = d.get("three_year_4320_checks_cloud_eur") if isinstance(d.get("three_year_4320_checks_cloud_eur"), dict) else {}
        return {
            "per_check_eur_normal": to_num(pce.get("normal_1fps")),
            "per_check_eur_adaptive": to_num(pce.get("adaptive_0_5fps")),
            "per_check_usd_normal": to_num(pcu.get("total_normal_1fps")),
            "monthly_120_eur": to_num(m120.get("normal_eur")),
            "monthly_120_adaptive_eur": to_num(m120.get("adaptive_eur")),
            "annual_1440_eur": to_num(a1440.get("normal_eur")),
            "annual_1440_blended_barcode_eur": to_num(a1440.get("blended_30pct_local_barcode_eur")),
            "three_year_4320_eur": to_num(y3.get("normal_all_cloud")),
        }

    tco = data.get("three_year_tco_comparison") if isinstance(data.get("three_year_tco_comparison"), dict) else {}
    opts = tco.get("options") if isinstance(tco.get("options"), dict) else {}
    hu_opt = opts.get("holdup_consumer_rayban_meta_gen2") if isinstance(opts.get("holdup_consumer_rayban_meta_gen2"), dict) else {}
    hu_ann = hu_opt.get("annual_cloud_inference_eur") if isinstance(hu_opt.get("annual_cloud_inference_eur"), dict) else {}
    hu_3yr = hu_opt.get("three_year_tco_eur") if isinstance(hu_opt.get("three_year_tco_eur"), dict) else {}

    orcam_opt = opts.get("dedicated_assistive_camera_orcam_class") if isinstance(opts.get("dedicated_assistive_camera_orcam_class"), dict) else {}
    aira_opt = opts.get("human_video_volunteer_or_paid_agent_aira_class") if isinstance(opts.get("human_video_volunteer_or_paid_agent_aira_class"), dict) else {}
    aira_paid = aira_opt.get("paid_agent_subscription") if isinstance(aira_opt.get("paid_agent_subscription"), dict) else {}
    pilot_100 = tco.get("rehabilitation_pilot_100_users_3yr") if isinstance(tco.get("rehabilitation_pilot_100_users_3yr"), dict) else {}

    normal_bw_kb = to_num(first_val(hs, ["normal_1fps_check_bandwidth_kb"]))
    if normal_bw_kb is None:
        normal_bw_kb = to_num(norm_bw.get("total_raw_media_typical_kb"))
    adap_bw_kb = to_num(first_val(hs, ["slow_network_adaptive_0_5fps_check_bandwidth_kb"]))
    if adap_bw_kb is None:
        adap_bw_kb = to_num(adap_bw.get("total_raw_media_typical_kb"))
    vid_saved_pct = to_num(first_val(hs, ["video_bandwidth_saved_in_adaptive_mode_pct"]))
    if vid_saved_pct is None:
        vid_saved_pct = to_num(adap_bw.get("video_bandwidth_reduction_vs_normal_pct"))
    tot_saved_pct = to_num(first_val(hs, ["total_bandwidth_saved_in_adaptive_mode_pct"]))
    if tot_saved_pct is None:
        tot_saved_pct = to_num(adap_bw.get("total_typical_bandwidth_reduction_vs_normal_pct"))

    return {
        "generated_at": clean_text(data.get("generated_at", "")),
        "measured_fixture_count": to_int(data.get("measured_fixture_count")),
        "measured_fixture_mean_bytes": to_num(data.get("measured_fixture_mean_bytes")),
        "measured_fixture_mean_kb": to_num(data.get("measured_fixture_mean_kb")),
        "measured_adaptive_512px_q50_mean_bytes": to_num(data.get("measured_adaptive_512px_q50_mean_bytes")),
        "measured_adaptive_512px_q50_mean_kb": to_num(data.get("measured_adaptive_512px_q50_mean_kb")),
        "check_duration_s": to_num(first_val(hs, ["check_duration_s"])),
        "normal_1fps_check_bandwidth_kb": normal_bw_kb,
        "slow_network_adaptive_0_5fps_check_bandwidth_kb": adap_bw_kb,
        "video_bandwidth_saved_in_adaptive_mode_pct": vid_saved_pct,
        "total_bandwidth_saved_in_adaptive_mode_pct": tot_saved_pct,
        "per_check_gemini_cost_eur_standard": to_num(hs.get("per_check_gemini_cost_eur_standard")),
        "per_check_gemini_cost_usd_standard": to_num(hs.get("per_check_gemini_cost_usd_standard")),
        "monthly_120_checks_gemini_cost_eur_standard": to_num(hs.get("monthly_120_checks_gemini_cost_eur_standard")),
        "annual_1440_checks_cloud_eur_pilot_band": clean_text(hs.get("annual_1440_checks_cloud_eur_pilot_band", "")),
        "tco_3yr_holdup_rayban_meta_gen2_eur": to_num(hs.get("tco_3yr_holdup_rayban_meta_gen2_eur")),
        "tco_3yr_orcam_myeye_midpoint_eur": to_num(hs.get("tco_3yr_orcam_myeye_midpoint_eur")),
        "tco_3yr_aira_paid_daily_plan_eur": to_num(hs.get("tco_3yr_aira_paid_daily_plan_eur")),
        "tco_savings_vs_orcam_midpoint_pct": to_num(hs.get("tco_savings_vs_orcam_midpoint_pct")),
        "tco_cost_reduction_multiple_vs_orcam": to_num(hs.get("tco_cost_reduction_multiple_vs_orcam")),
        "bandwidth_modes": {
            "normal_1fps_768px": {
                "fps": to_num(norm_bw.get("fps")),
                "max_dim_px": to_int(norm_bw.get("max_dim_px")),
                "jpeg_quality": to_num(norm_bw.get("jpeg_quality")),
                "frames_sent_in_12s": to_int(norm_bw.get("frames_sent_in_12s")),
                "jpeg_frames_kb": to_num(norm_bw.get("jpeg_frames_kb")),
                "pcm16_uplink_kb": to_num(norm_bw.get("pcm16_16khz_uplink_12s_kb")),
                "pcm16_downlink_typical_kb": to_num(norm_bw.get("pcm16_24khz_downlink_typical_5s_kb")),
                "total_raw_typical_kb": to_num(norm_bw.get("total_raw_media_typical_kb")),
                "ws_wire_typical_kb": to_num(norm_bw.get("websocket_base64_wire_typical_kb")),
                "avg_bitrate_kbps": to_num(norm_bw.get("average_raw_bitrate_typical_kbps")),
                "monthly_120_checks_mb": to_num(norm_bw.get("monthly_120_checks_raw_typical_mb")),
                "client_extra_verify_upload_kb": to_num(norm_bw.get("client_extra_verify_upload_kb")),
            },
            "adaptive_0_5fps_512px": {
                "fps": to_num(adap_bw.get("fps")),
                "max_dim_px": to_int(adap_bw.get("max_dim_px")),
                "jpeg_quality": to_num(adap_bw.get("jpeg_quality")),
                "frames_sent_in_12s": to_int(adap_bw.get("frames_sent_in_12s")),
                "rtt_trigger_threshold_ms": to_int(adap_bw.get("rtt_trigger_threshold_ms")),
                "jpeg_frames_kb": to_num(adap_bw.get("jpeg_frames_kb")),
                "pcm16_uplink_kb": to_num(adap_bw.get("pcm16_16khz_uplink_12s_kb")),
                "pcm16_downlink_typical_kb": to_num(adap_bw.get("pcm16_24khz_downlink_typical_5s_kb")),
                "total_raw_typical_kb": to_num(adap_bw.get("total_raw_media_typical_kb")),
                "ws_wire_typical_kb": to_num(adap_bw.get("websocket_base64_wire_typical_kb")),
                "avg_bitrate_kbps": to_num(adap_bw.get("average_raw_bitrate_typical_kbps")),
                "monthly_120_checks_mb": to_num(adap_bw.get("monthly_120_checks_raw_typical_mb")),
                "video_reduction_pct": to_num(adap_bw.get("video_bandwidth_reduction_vs_normal_pct")),
                "total_reduction_pct": to_num(adap_bw.get("total_typical_bandwidth_reduction_vs_normal_pct")),
            },
            "snapshot_http_fallback": {
                "raw_kb": to_num(snap_bw.get("raw_kb")),
                "json_wire_kb": to_num(snap_bw.get("json_wire_kb")),
                "monthly_120_checks_mb": to_num(snap_bw.get("monthly_120_checks_mb")),
            },
            "offline_barcode_fallback": {
                "raw_kb": to_num(off_bw.get("raw_kb")),
                "monthly_120_checks_mb": to_num(off_bw.get("monthly_120_checks_mb")),
            },
        },
        "usage_and_tokens": {
            "checks_per_day": to_int(cadence.get("checks_per_day")),
            "checks_per_month": to_int(cadence.get("checks_per_month")),
            "checks_per_year": to_int(cadence.get("checks_per_year")),
            "checks_over_3_years": to_int(cadence.get("checks_over_3_years")),
            "total_tokens_normal_1fps": to_int(pct.get("total_tokens_per_check_normal_1fps")),
            "total_tokens_adaptive_0_5fps": to_int(pct.get("total_tokens_per_check_adaptive_0_5fps")),
        },
        "pricing_tiers": {
            "standard_cached": extract_pricing_tier(tiers_raw.get("gemini_flash_standard_cached")),
            "economy_2_0_live": extract_pricing_tier(tiers_raw.get("gemini_flash_economy_2_0_live")),
            "uncached_native_audio_ceiling": extract_pricing_tier(tiers_raw.get("gemini_live_native_audio_uncached_ceiling")),
        },
        "three_year_tco": {
            "horizon_years": to_int(tco.get("horizon_years")),
            "total_checks": to_int(tco.get("total_checks_over_horizon")),
            "holdup_rayban_meta_gen2": {
                "hardware_upfront_eur": to_num(hu_opt.get("hardware_upfront_eur")),
                "annual_cloud_standard_eur": to_num(hu_ann.get("standard_cached_100pct_cloud")),
                "annual_cloud_economy_eur": to_num(hu_ann.get("economy_flash_live")),
                "annual_cloud_blended_barcode_eur": to_num(hu_ann.get("blended_daily_pilot_with_barcode")),
                "annual_cloud_ceiling_eur": to_num(hu_ann.get("uncached_native_audio_ceiling")),
                "three_year_tco_standard_eur": to_num(hu_3yr.get("standard_cached_100pct_cloud")),
                "three_year_tco_economy_eur": to_num(hu_3yr.get("economy_flash_live")),
                "three_year_tco_ceiling_eur": to_num(hu_3yr.get("uncached_native_audio_ceiling")),
                "effective_monthly_tco_standard_eur": to_num(hu_opt.get("effective_monthly_tco_standard_eur")),
                "all_in_cost_per_check_standard_eur": to_num(hu_opt.get("all_in_cost_per_check_standard_eur")),
            },
            "orcam_myeye_class": {
                "hardware_upfront_eur_midpoint": to_num(orcam_opt.get("hardware_upfront_eur_midpoint")),
                "annual_subscription_eur": to_num(orcam_opt.get("annual_subscription_eur")),
                "three_year_tco_eur_midpoint": to_num(orcam_opt.get("three_year_tco_eur_midpoint")),
                "effective_monthly_tco_midpoint_eur": to_num(orcam_opt.get("effective_monthly_tco_midpoint_eur")),
                "all_in_cost_per_check_midpoint_eur": to_num(orcam_opt.get("all_in_cost_per_check_midpoint_eur")),
                "holdup_savings_eur": to_num(orcam_opt.get("holdup_savings_vs_midpoint_eur")),
                "holdup_savings_pct": to_num(orcam_opt.get("holdup_savings_vs_midpoint_pct")),
                "holdup_cost_reduction_multiple": to_num(orcam_opt.get("holdup_cost_reduction_multiple")),
            },
            "aira_paid_daily_class": {
                "daily_plan_monthly_eur": to_num(aira_paid.get("daily_meds_180min_plan_monthly_eur")),
                "three_year_tco_phone_only_eur": to_num(aira_paid.get("three_year_tco_daily_phone_only_eur")),
                "three_year_tco_with_glasses_eur": to_num(aira_paid.get("three_year_tco_daily_with_glasses_eur")),
                "holdup_savings_vs_daily_plan_pct": to_num(aira_paid.get("holdup_savings_vs_daily_plan_pct")),
            },
            "rehabilitation_pilot_100_users_3yr": {
                "cohort_size_users": to_int(pilot_100.get("cohort_size_users")),
                "holdup_total_eur": to_num(pilot_100.get("holdup_plus_rayban_gen2_total_eur")),
                "orcam_midpoint_total_eur": to_num(pilot_100.get("orcam_class_midpoint_total_eur")),
                "public_budget_saved_eur": to_num(pilot_100.get("public_budget_saved_eur")),
                "users_served_per_100_orcam_budget": to_int(pilot_100.get("users_served_per_100_orcam_budget")),
            },
        },
    }


def fmt_pct(rate: float | None) -> str:
    if rate is None:
        return "n/a"
    return f"{rate * 100:.1f}%"


def fmt_ms(ms: float | None) -> str:
    if ms is None:
        return "n/a"
    return f"{ms:.1f} ms"


def fmt_num(val: float | int | None, digits: int = 2) -> str:
    if val is None:
        return "n/a"
    if isinstance(val, int):
        return str(val)
    return f"{val:.{digits}f}"


def fmt_comma(val: float | int | None, digits: int = 2) -> str:
    if val is None:
        return "n/a"
    if isinstance(val, int) or digits == 0:
        return f"{int(round(val)):,}"
    return f"{val:,.{digits}f}"


def _extract_stage_sharpness(stage: dict[str, Any], tr: dict[str, Any], fallback_keys: list[str]) -> float | None:
    direct = to_num(first_val(stage, ["top_sharpness", "max_sharpness", "selected_sharpness", "sharpness", "jpeg_sharpness", "mean_sharpness"]))
    if direct is not None:
        return round(direct, 4)
    for list_key in ("picked_frames", "sharpness_scores", "picked_sharpness", "ring_frames", "ring_sharpness"):
        arr = stage.get(list_key)
        if isinstance(arr, list):
            nums: list[float] = []
            for x in arr:
                if isinstance(x, dict):
                    n = to_num(first_val(x, ["sharpness", "jpeg_sharpness", "score"]))
                else:
                    n = to_num(x)
                if n is not None:
                    nums.append(n)
            if nums:
                return round(max(nums), 4)
    fb = to_num(first_val(tr, fallback_keys))
    return round(fb, 4) if fb is not None else None


def normalize_coaching_trajectories(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    trajs = extract_items(data)

    n_trajs = to_int(first_val(summary, ["n_trajectories", "total_trajectories"]))
    if n_trajs is None:
        n_trajs = len(trajs) if trajs else (to_int(first_val(summary, ["n_items", "n_cases", "total", "count"])) or 0)

    total_calls = to_int(first_val(summary, ["total_verify_calls", "n_verify_calls", "verify_calls", "total_calls", "n_calls"]))
    if total_calls is None:
        total_calls = n_trajs * 2 if n_trajs > 0 else 0

    stage_a_bools: list[bool] = []
    stage_b_bools: list[bool] = []
    stage_lats: list[float] = []
    item_cwds: list[bool] = []
    rows: list[dict[str, Any]] = []

    for idx, tr in enumerate(trajs, start=1):
        tr_id = clean_text(first_val(tr, ["id", "trajectory_id", "case_id", "name"]) or f"traj_{idx:02d}")
        stage_a = next((tr[k] for k in ("stage_a", "pre_coaching", "step_1", "step1", "before") if isinstance(tr.get(k), dict)), {})
        stage_b = next((tr[k] for k in ("stage_b", "post_coaching", "step_2", "step2", "after") if isinstance(tr.get(k), dict)), {})

        sa_level = item_verdict_level(stage_a) or first_val(tr, ["stage_a_level", "pre_coaching_level", "initial_level"])
        sa_abstained: bool | None = None
        if isinstance(stage_a.get("abstained"), bool):
            sa_abstained = stage_a["abstained"]
        elif isinstance(stage_a.get("verdict_match"), bool):
            sa_abstained = stage_a["verdict_match"]
        elif isinstance(tr.get("stage_a_abstained"), bool):
            sa_abstained = tr["stage_a_abstained"]
        elif isinstance(sa_level, str):
            sa_abstained = sa_level == "unsure"
        if sa_abstained is not None:
            stage_a_bools.append(sa_abstained)

        sb_exp = item_expected_level(stage_b) or first_val(tr, ["stage_b_expected_level", "expected_level", "post_expected_level"])
        sb_level = item_verdict_level(stage_b) or first_val(tr, ["stage_b_level", "post_coaching_level", "final_level"])
        sb_match = item_is_verdict_match(stage_b)
        if sb_match is None:
            if isinstance(tr.get("stage_b_match"), bool):
                sb_match = tr["stage_b_match"]
            elif isinstance(tr.get("post_coaching_match"), bool):
                sb_match = tr["post_coaching_match"]
            elif isinstance(sb_level, str) and isinstance(sb_exp, str):
                sb_match = sb_level == sb_exp
        if sb_match is not None:
            stage_b_bools.append(sb_match)

        sa_sharp = _extract_stage_sharpness(stage_a, tr, ["stage_a_sharpness", "pre_sharpness", "pre_coaching_sharpness"])
        sb_sharp = _extract_stage_sharpness(stage_b, tr, ["stage_b_sharpness", "post_sharpness", "post_coaching_sharpness"])

        sa_lat = to_num(first_val(stage_a, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        if sa_lat is None:
            sa_lat = to_num(first_val(tr, ["stage_a_latency_ms", "pre_latency_ms", "pre_coaching_latency_ms"]))
        sb_lat = to_num(first_val(stage_b, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        if sb_lat is None:
            sb_lat = to_num(first_val(tr, ["stage_b_latency_ms", "post_latency_ms", "post_coaching_latency_ms"]))
        if sa_lat is not None:
            stage_lats.append(sa_lat)
        if sb_lat is not None:
            stage_lats.append(sb_lat)

        tr_cwd = bool(tr.get("confident_wrong_dose", False)) or bool(stage_a.get("confident_wrong_dose", False)) or bool(stage_b.get("confident_wrong_dose", False))
        if "confident_wrong_dose" in tr or "confident_wrong_dose" in stage_a or "confident_wrong_dose" in stage_b:
            item_cwds.append(tr_cwd)

        rows.append(
            {
                "id": tr_id,
                "stage_a_level": clean_text(sa_level) if sa_level is not None else None,
                "stage_a_abstained": sa_abstained,
                "stage_a_sharpness": sa_sharp,
                "stage_a_latency_ms": round(sa_lat, 1) if sa_lat is not None else None,
                "stage_b_expected_level": clean_text(sb_exp) if sb_exp is not None else None,
                "stage_b_level": clean_text(sb_level) if sb_level is not None else None,
                "stage_b_match": sb_match,
                "stage_b_sharpness": sb_sharp,
                "stage_b_latency_ms": round(sb_lat, 1) if sb_lat is not None else None,
                "confident_wrong_dose": tr_cwd,
            }
        )

    pre_rate = to_rate(first_val(summary, ["pre_coaching_abstention_rate", "stage_a_abstention_rate", "initial_abstention_rate", "abstention_rate"]))
    if pre_rate is None and stage_a_bools:
        pre_rate = round(sum(1 for x in stage_a_bools if x) / len(stage_a_bools), 4)

    post_acc = to_rate(first_val(summary, ["post_coaching_verdict_accuracy", "stage_b_verdict_accuracy", "post_coaching_accuracy", "recovery_accuracy", "verdict_accuracy"]))
    if post_acc is None and stage_b_bools:
        post_acc = round(sum(1 for x in stage_b_bools if x) / len(stage_b_bools), 4)

    pre_abst = to_int(first_val(summary, ["pre_coaching_abstentions", "stage_a_abstentions", "stage_a_matches"]))
    if pre_abst is None and pre_rate is not None and n_trajs > 0:
        pre_abst = int(round(pre_rate * n_trajs))

    post_matches = to_int(first_val(summary, ["post_coaching_matches", "post_coaching_verdict_matches", "stage_b_matches"]))
    if post_matches is None and post_acc is not None and n_trajs > 0:
        post_matches = int(round(post_acc * n_trajs))

    verdict_matches = to_int(first_val(summary, ["verdict_matches", "total_matches"]))
    if verdict_matches is None and pre_abst is not None and post_matches is not None:
        verdict_matches = pre_abst + post_matches

    verdict_acc = round(verdict_matches / total_calls, 4) if (verdict_matches is not None and total_calls > 0) else post_acc

    cwd = to_int(first_val(summary, ["confident_wrong_dose_count", "confident_wrong_doses"]))
    if cwd is None:
        cwd = sum(1 for x in item_cwds if x) if item_cwds else 0

    lat = extract_latency(summary, trajs)
    if lat["p50"] is None and stage_lats:
        lat["p50"] = percentile(stage_lats, 0.50)
    if lat["p95"] is None and stage_lats:
        lat["p95"] = percentile(stage_lats, 0.95)
    if lat["mean"] is None and stage_lats:
        lat["mean"] = round(statistics.mean(stage_lats), 1)

    model = clean_text(first_val(summary, ["model", "verify_model"]) or data.get("model") or "gemini-3.8-flash")
    tokens_in = to_num(first_val(summary, ["tokens_in", "mean_tokens_in", "total_tokens_in", "input_tokens"]))
    tokens_out = to_num(first_val(summary, ["tokens_out", "mean_tokens_out", "total_tokens_out", "output_tokens"]))

    return {
        "suite_id": "coaching_trajectories",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_trajectories": n_trajs,
        "total_verify_calls": total_calls,
        "n_cases": total_calls,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_acc,
        "pre_coaching_abstentions": pre_abst,
        "pre_coaching_abstention_rate": pre_rate,
        "post_coaching_matches": post_matches,
        "post_coaching_verdict_accuracy": post_acc,
        "confident_wrong_dose_count": cwd,
        "false_safe_allergen_count": None,
        "latency_ms": lat,
        "tokens_in": round(tokens_in, 1) if tokens_in is not None else None,
        "tokens_out": round(tokens_out, 1) if tokens_out is not None else None,
        "trajectories": rows,
    }


def normalize_extended_suite(suite_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if suite_id == "coaching_trajectories":
        return normalize_coaching_trajectories(data)

    base = normalize_label_suite(suite_id, data)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    if suite_id == "curved_blister_results":
        readable_recall = to_rate(first_val(summary, ["readable_recall", "clean_recall", "clean_field_accuracy"]))
        if readable_recall is None:
            readable_recall = base["clean_field_accuracy"]
        occ_abst = to_rate(first_val(summary, ["occluded_abstention_rate", "glare_or_curved_abstention_rate", "unreadable_abstention_rate", "abstention_rate"]))
        if occ_abst is None:
            occ_abst = base["occluded_abstention_rate"]
        base["readable_recall"] = readable_recall
        base["occluded_abstention_rate"] = occ_abst
    elif suite_id == "lighting_motion_results":
        mod_rec = to_rate(first_val(summary, ["moderate_degradation_recall", "readable_recall", "clean_recall", "clean_field_accuracy"]))
        if mod_rec is None:
            mod_rec = base["clean_field_accuracy"]
        sev_abst = to_rate(first_val(summary, ["severe_degradation_abstention_rate", "occluded_abstention_rate", "unreadable_abstention_rate", "abstention_rate"]))
        if sev_abst is None:
            sev_abst = base["occluded_abstention_rate"]
        base["moderate_degradation_recall"] = mod_rec
        base["severe_degradation_abstention_rate"] = sev_abst
    elif suite_id == "multilingual_labels_results":
        langs_raw = first_val(summary, ["languages_tested", "languages", "locales"])
        if langs_raw is None:
            langs_raw = first_val(data, ["languages_tested", "languages", "locales"])
        langs: list[str] = []
        if isinstance(langs_raw, list):
            langs = [clean_text(x) for x in langs_raw if clean_text(x)]
        if not langs:
            for it in items:
                lv = clean_text(first_val(it, ["lang", "language", "locale"]))
                if lv and lv not in langs:
                    langs.append(lv)
        base["languages_tested"] = langs
        if base["false_safe_allergen_count"] is None:
            item_fsa = [bool(it.get("false_safe_allergen")) for it in items if "false_safe_allergen" in it]
            if item_fsa:
                base["false_safe_allergen_count"] = sum(1 for x in item_fsa if x)
    elif suite_id == "bystander_privacy_results":
        leaks = to_int(first_val(summary, ["pii_or_bystander_leak_count", "bystander_leak_count", "pii_leak_count", "leak_count", "canary_leak_count"]))
        if leaks is None and items:
            leak_flags: list[bool] = []
            for it in items:
                if isinstance(it.get("pii_or_bystander_leak"), bool):
                    leak_flags.append(it["pii_or_bystander_leak"])
                elif isinstance(it.get("leaked"), bool):
                    leak_flags.append(it["leaked"])
                elif isinstance(it.get("privacy_pass"), bool):
                    leak_flags.append(not it["privacy_pass"])
            if leak_flags:
                leaks = sum(1 for x in leak_flags if x)
        priv_rate = to_rate(first_val(summary, ["privacy_pass_rate", "non_leak_rate", "red_team_pass_rate"]))
        if priv_rate is None and leaks is not None and base["n_cases"] > 0:
            priv_rate = round((base["n_cases"] - leaks) / base["n_cases"], 4)
        base["pii_or_bystander_leak_count"] = leaks
        base["privacy_pass_rate"] = priv_rate
    elif suite_id == "polypharmacy_confusion_results":
        base["double_dose_catches"] = to_int(first_val(summary, ["double_dose_catches", "double_dose_catch_count"]))
        base["lasa_strength_catches"] = to_int(first_val(summary, ["lasa_strength_catches", "lasa_catches", "wrong_strength_catches"]))
        base["drug_class_catches"] = to_int(first_val(summary, ["drug_class_catches", "avoid_or_allergy_catches", "class_avoid_catches"]))

    return base


def _first_dict(containers: list[dict[str, Any]], keys: list[str]) -> dict[str, Any]:
    for c in containers:
        for k in keys:
            val = c.get(k)
            if isinstance(val, dict):
                return val
    return {}


def normalize_multiframe_recovery(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    pairs_raw = extract_items(data)

    n_pairs = to_int(first_val(summary, ["n_pairs", "total_pairs"]))
    if n_pairs is None:
        n_pairs = len(pairs_raw) if pairs_raw else (to_int(first_val(summary, ["n_items", "n_cases", "total", "count"])) or 0)

    total_calls = to_int(first_val(summary, ["total_calls", "total_verify_calls", "n_verify_calls", "verify_calls", "n_calls"]))
    if total_calls is None:
        total_calls = n_pairs * 2 if n_pairs > 0 else 0

    single_bools: list[bool] = []
    paired_bools: list[bool] = []
    single_lats: list[float] = []
    paired_lats: list[float] = []
    item_cwds: list[bool] = []
    rows: list[dict[str, Any]] = []

    for idx, it in enumerate(pairs_raw, start=1):
        pair_id = clean_text(first_val(it, ["id", "pair_id", "case_id", "name"]) or f"mf_{idx:02d}")
        single_obj = next(
            (it[k] for k in ("single", "single_frame", "frame1_only", "frame_1", "stage_1", "step_1", "before") if isinstance(it.get(k), dict)),
            {},
        )
        paired_obj = next(
            (it[k] for k in ("paired", "paired_frames", "multi_frame", "two_frame", "frames_1_2", "stage_2", "step_2", "after") if isinstance(it.get(k), dict)),
            {},
        )

        s_level = item_verdict_level(single_obj) or first_val(
            it, ["single_level", "predicted_single_level", "single_predicted_level", "single_verdict", "frame1_level"]
        )
        s_abstained: bool | None = None
        for b_key in ("abstained", "safe_abstention", "safe_abstained", "verdict_match"):
            if isinstance(single_obj.get(b_key), bool):
                s_abstained = single_obj[b_key]
                break
        if s_abstained is None:
            for b_key in ("single_abstained", "single_safe_abstained", "single_safe_abstention", "single_safe"):
                if isinstance(it.get(b_key), bool):
                    s_abstained = it[b_key]
                    break
        if s_abstained is None and isinstance(s_level, str):
            s_abstained = s_level == "unsure"
        if s_abstained is not None:
            single_bools.append(s_abstained)

        p_exp = item_expected_level(paired_obj) or first_val(
            it, ["paired_expected_level", "expected_paired_level", "expected_level", "target_level"]
        )
        p_level = item_verdict_level(paired_obj) or first_val(
            it, ["paired_level", "predicted_paired_level", "paired_predicted_level", "predicted_level", "multi_frame_level"]
        )
        p_match = item_is_verdict_match(paired_obj)
        if p_match is None:
            for b_key in ("paired_match", "paired_verdict_match", "verdict_match"):
                if isinstance(it.get(b_key), bool):
                    p_match = it[b_key]
                    break
        if p_match is None and isinstance(p_level, str) and isinstance(p_exp, str):
            p_match = p_level == p_exp
        if p_match is not None:
            paired_bools.append(p_match)

        s_lat = to_num(first_val(single_obj, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        if s_lat is None:
            s_lat = to_num(first_val(it, ["single_latency_ms", "single_frame_latency_ms", "frame1_latency_ms"]))
        p_lat = to_num(first_val(paired_obj, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        if p_lat is None:
            p_lat = to_num(first_val(it, ["paired_latency_ms", "paired_frame_latency_ms", "multi_frame_latency_ms", "latency_ms"]))
        if s_lat is not None:
            single_lats.append(s_lat)
        if p_lat is not None:
            paired_lats.append(p_lat)

        cwd_flag = (
            bool(it.get("confident_wrong_dose", False))
            or bool(single_obj.get("confident_wrong_dose", False))
            or bool(paired_obj.get("confident_wrong_dose", False))
        )
        if "confident_wrong_dose" in it or "confident_wrong_dose" in single_obj or "confident_wrong_dose" in paired_obj:
            item_cwds.append(cwd_flag)

        rows.append(
            {
                "id": pair_id,
                "single_level": clean_text(s_level) if s_level is not None else None,
                "single_abstained": s_abstained,
                "single_latency_ms": round(s_lat, 1) if s_lat is not None else None,
                "paired_expected_level": clean_text(p_exp) if p_exp is not None else None,
                "paired_level": clean_text(p_level) if p_level is not None else None,
                "paired_match": p_match,
                "paired_latency_ms": round(p_lat, 1) if p_lat is not None else None,
                "confident_wrong_dose": cwd_flag,
            }
        )

    single_rate = to_rate(
        first_val(
            summary,
            [
                "single_frame_safe_abstention_rate",
                "single_frame_abstention_rate",
                "single_abstention_rate",
                "stage_1_abstention_rate",
            ],
        )
    )
    if single_rate is None and single_bools:
        single_rate = round(sum(1 for x in single_bools if x) / len(single_bools), 4)

    paired_acc = to_rate(
        first_val(
            summary,
            [
                "paired_frame_verdict_accuracy",
                "paired_verdict_accuracy",
                "multi_frame_verdict_accuracy",
                "two_frame_verdict_accuracy",
                "verdict_accuracy",
            ],
        )
    )
    if paired_acc is None and paired_bools:
        paired_acc = round(sum(1 for x in paired_bools if x) / len(paired_bools), 4)

    single_abst = to_int(first_val(summary, ["single_frame_abstentions", "single_abstentions", "single_safe_count"]))
    if single_abst is None and single_rate is not None and n_pairs > 0:
        single_abst = int(round(single_rate * n_pairs))

    paired_matches = to_int(
        first_val(
            summary,
            [
                "paired_frame_matches",
                "paired_frame_verdict_matches",
                "paired_verdict_matches",
                "paired_matches",
                "verdict_matches",
            ],
        )
    )
    if paired_matches is None and paired_acc is not None and n_pairs > 0:
        paired_matches = int(round(paired_acc * n_pairs))

    single_lat_p50 = to_num(first_val(summary, ["single_latency_p50_ms", "single_frame_latency_p50_ms", "frame1_latency_p50_ms"]))
    if single_lat_p50 is None and single_lats:
        single_lat_p50 = percentile(single_lats, 0.50)

    paired_lat_p50 = to_num(first_val(summary, ["paired_latency_p50_ms", "paired_frame_latency_p50_ms", "multi_frame_latency_p50_ms", "latency_p50_ms"]))
    if paired_lat_p50 is None and paired_lats:
        paired_lat_p50 = percentile(paired_lats, 0.50)

    all_lats = [*single_lats, *paired_lats]
    lat = extract_latency(summary, pairs_raw)
    if lat["p50"] is None:
        if paired_lat_p50 is not None:
            lat["p50"] = round(paired_lat_p50, 1)
        elif all_lats:
            lat["p50"] = percentile(all_lats, 0.50)
        elif single_lat_p50 is not None:
            lat["p50"] = round(single_lat_p50, 1)
    if lat["p95"] is None:
        p95_cand = to_num(first_val(summary, ["paired_latency_p95_ms", "single_latency_p95_ms"]))
        if p95_cand is not None:
            lat["p95"] = round(p95_cand, 1)
        elif all_lats:
            lat["p95"] = percentile(all_lats, 0.95)
    if lat["mean"] is None and all_lats:
        lat["mean"] = round(statistics.mean(all_lats), 1)

    cwd = to_int(first_val(summary, ["confident_wrong_dose_count", "confident_wrong_doses"]))
    if cwd is None:
        cwd = sum(1 for x in item_cwds if x) if item_cwds else 0

    verdict_matches = paired_matches
    n_cases = n_pairs
    verdict_acc = paired_acc

    model = clean_text(first_val(summary, ["model", "verify_model"]) or data.get("model") or "gemini-3.8-flash")
    tokens_in = to_num(first_val(summary, ["tokens_in", "mean_tokens_in", "total_tokens_in", "input_tokens"]))
    tokens_out = to_num(first_val(summary, ["tokens_out", "mean_tokens_out", "total_tokens_out", "output_tokens"]))

    return {
        "suite_id": "multiframe_recovery_results",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_pairs": n_pairs,
        "total_calls": total_calls,
        "n_cases": n_cases,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_acc,
        "single_frame_abstentions": single_abst,
        "single_frame_safe_abstention_rate": single_rate,
        "paired_frame_matches": paired_matches,
        "paired_frame_verdict_accuracy": paired_acc,
        "confident_wrong_dose_count": cwd,
        "false_safe_allergen_count": None,
        "single_latency_p50_ms": round(single_lat_p50, 1) if single_lat_p50 is not None else None,
        "paired_latency_p50_ms": round(paired_lat_p50, 1) if paired_lat_p50 is not None else None,
        "latency_ms": lat,
        "tokens_in": round(tokens_in, 1) if tokens_in is not None else None,
        "tokens_out": round(tokens_out, 1) if tokens_out is not None else None,
        "pairs": rows,
    }


def normalize_e2e_websocket_live(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    containers = [summary, data] if summary is not data else [summary]
    state_obj = _first_dict(containers, ["ingest_state", "state_broadcast", "device_state", "state_fanout"])
    verify_obj = _first_dict(containers, ["verify_pipeline", "verify_e2e", "e2e_verify", "verify"])
    live_obj = _first_dict(containers, ["live_session", "live_ws", "live_turn", "live_websocket", "live"])
    items = extract_items(data)

    state_ms = to_num(
        first_val(
            summary,
            [
                "ingest_state_to_hud_ws_p50_ms",
                "ingest_state_broadcast_ms",
                "ingest_state_to_hud_ms",
                "ingest_state_to_ws_ms",
                "ingest_state_to_live_ws_p50_ms",
                "state_broadcast_ms",
                "ingest_state_fanout_ms",
                "ingest_state_latency_ms",
                "ingest_state_p50_ms",
                "ingest_state_http_p50_ms",
                "device_broadcast_ms",
            ],
        )
    )
    if state_ms is None:
        state_ms = to_num(first_val(state_obj, ["hud_ws_ms", "broadcast_ms", "max_ms", "p50_ms", "latency_ms", "elapsed_ms", "ms"]))

    ingest_frame_ms = to_num(
        first_val(
            summary,
            [
                "ingest_frame_to_ring_p50_ms",
                "ingest_frame_ms",
                "ingest_frame_p50_ms",
                "ingest_frame_latency_ms",
                "frame_ingest_ms",
            ],
        )
    )
    if ingest_frame_ms is None:
        ingest_frame_ms = to_num(first_val(verify_obj, ["ingest_frame_ms", "ingest_frame_p50_ms"]))

    rows: list[dict[str, Any]] = []
    item_lats: list[float] = []
    item_matches: list[bool] = []
    item_hud_rx: list[bool] = []
    item_cwds: list[bool] = []
    for idx, it in enumerate(items, start=1):
        row_id = clean_text(first_val(it, ["fixture", "id", "case_id", "file", "name"]) or f"e2e_{idx:02d}")
        exp_lvl = item_expected_level(it)
        pred_lvl = item_verdict_level(it)
        vm = item_is_verdict_match(it)
        if vm is not None:
            item_matches.append(vm)
        hud_ok = first_val(it, ["hud_received", "hud_received_verdict", "hud_verdict_received", "hud_ok", "received_on_hud"])
        if isinstance(hud_ok, bool):
            item_hud_rx.append(hud_ok)
        lat_v = to_num(
            first_val(
                it,
                [
                    "e2e_frame_to_hud_verdict_ms",
                    "e2e_latency_ms",
                    "e2e_ms",
                    "ingest_to_hud_ms",
                    "verify_to_hud_ws_ms",
                    "verify_to_hud_ms",
                    "total_ms",
                    "latency_ms",
                    "elapsed_ms",
                    "ms",
                ],
            )
        )
        if lat_v is not None:
            item_lats.append(lat_v)
        cwd_f = bool(it.get("confident_wrong_dose", False))
        if "confident_wrong_dose" in it:
            item_cwds.append(cwd_f)
        rows.append(
            {
                "id": row_id,
                "expected_level": exp_lvl,
                "predicted_level": pred_lvl,
                "verdict_match": vm,
                "hud_received": hud_ok if isinstance(hud_ok, bool) else None,
                "confident_wrong_dose": cwd_f,
                "latency_ms": round(lat_v, 1) if lat_v is not None else None,
            }
        )

    v_p50 = to_num(
        first_val(
            summary,
            [
                "e2e_frame_to_hud_verdict_p50_ms",
                "e2e_verify_to_hud_p50_ms",
                "ingest_to_verify_to_hud_p50_ms",
                "ingest_frame_to_hud_p50_ms",
                "verify_to_hud_ws_p50_ms",
                "verify_to_hud_p50_ms",
                "verify_e2e_p50_ms",
                "verify_latency_p50_ms",
                "e2e_p50_ms",
                "latency_p50_ms",
                "p50_ms",
            ],
        )
    )
    if v_p50 is None:
        v_p50 = to_num(first_val(verify_obj, ["p50_ms", "p50", "median_ms", "latency_p50_ms"]))
    if v_p50 is None and item_lats:
        v_p50 = percentile(item_lats, 0.50)

    v_p95 = to_num(
        first_val(
            summary,
            [
                "e2e_frame_to_hud_verdict_p95_ms",
                "e2e_verify_to_hud_p95_ms",
                "ingest_to_verify_to_hud_p95_ms",
                "verify_to_hud_ws_p95_ms",
                "verify_to_hud_p95_ms",
                "verify_e2e_p95_ms",
                "verify_latency_p95_ms",
                "e2e_p95_ms",
                "latency_p95_ms",
                "p95_ms",
                "e2e_verify_to_hud_max_ms",
                "verify_to_hud_max_ms",
            ],
        )
    )
    if v_p95 is None:
        v_p95 = to_num(first_val(verify_obj, ["p95_ms", "p95", "max_ms", "max"]))
    if v_p95 is None and item_lats:
        v_p95 = percentile(item_lats, 0.95)

    v_mean = to_num(
        first_val(
            summary,
            [
                "e2e_frame_to_hud_verdict_mean_ms",
                "e2e_verify_to_hud_mean_ms",
                "verify_to_hud_ws_mean_ms",
                "verify_to_hud_mean_ms",
                "latency_mean_ms",
                "mean_ms",
            ],
        )
    )
    if v_mean is None:
        v_mean = to_num(first_val(verify_obj, ["mean_ms", "mean"]))
    if v_mean is None and item_lats:
        v_mean = round(statistics.mean(item_lats), 1)

    n_checks = to_int(
        first_val(
            summary,
            ["n_verify_checks", "n_verify_trials", "n_fixtures", "verify_count", "n_verify", "n_items", "total_fixtures"],
        )
    )
    if n_checks is None:
        n_checks = len(rows)

    v_matches = to_int(
        first_val(summary, ["verdict_matches", "verify_verdict_matches", "verify_matches", "verdict_correct", "fixtures_passed"])
    )
    if v_matches is None and item_matches and len(item_matches) == n_checks and n_checks > 0:
        v_matches = sum(1 for x in item_matches if x)
    v_acc = to_rate(first_val(summary, ["verdict_accuracy", "verify_verdict_accuracy", "verify_accuracy"]))
    if v_acc is None and v_matches is not None and n_checks > 0:
        v_acc = round(v_matches / n_checks, 4)
    if v_matches is None and v_acc is not None and n_checks > 0:
        v_matches = int(round(v_acc * n_checks))

    hud_all = first_val(summary, ["hud_received_all_verdicts", "hud_received_all_3", "hud_all_verdicts_received", "hud_fanout_ok"])
    if not isinstance(hud_all, bool):
        hud_all = first_val(data, ["hud_received_all_verdicts", "hud_received_all_3"])
    if not isinstance(hud_all, bool):
        hud_all = all(item_hud_rx) if item_hud_rx else None

    live_open_ms = to_num(
        first_val(
            summary,
            [
                "live_startup_to_status_open_ms",
                "live_ws_open_ms",
                "live_open_ms",
                "live_ws_connect_ms",
                "live_connect_ms",
                "live_status_open_ms",
                "live_startup_to_ready_ms",
                "ws_open_ms",
                "connect_to_open_ms",
            ],
        )
    )
    if live_open_ms is None:
        live_open_ms = to_num(first_val(live_obj, ["open_ms", "connect_ms", "status_open_ms", "ws_open_ms", "connect_to_open_ms"]))

    live_first_ms = to_num(
        first_val(
            summary,
            [
                "live_turn_first_event_ms",
                "live_turn_first_audio_chunk_ms",
                "live_turn_first_coach_event_ms",
                "live_first_audio_or_coaching_ms",
                "live_first_event_ms",
                "live_first_audio_ms",
                "live_turn_first_chunk_ms",
                "live_first_chunk_ms",
                "first_audio_or_coaching_ms",
                "first_audio_ms",
                "first_event_ms",
            ],
        )
    )
    if live_first_ms is None:
        live_first_ms = to_num(
            first_val(
                live_obj,
                [
                    "first_audio_or_coaching_ms",
                    "first_event_ms",
                    "first_audio_ms",
                    "first_chunk_ms",
                    "first_response_ms",
                    "turn_first_event_ms",
                ],
            )
        )

    cwd = to_int(first_val(summary, ["confident_wrong_dose_count", "confident_wrong_doses"]))
    if cwd is None:
        cwd = to_int(first_val(data, ["confident_wrong_dose_count", "confident_wrong_doses"]))
    if cwd is None:
        cwd = sum(1 for x in item_cwds if x) if item_cwds else 0

    live_m = first_val(summary, ["live_model"]) or first_val(live_obj, ["model", "live_model"])
    ver_m = first_val(summary, ["verify_model"]) or first_val(verify_obj, ["model", "verify_model"])
    if live_m and ver_m:
        model_str = f"{clean_text(live_m)} + {clean_text(ver_m)}"
    else:
        model_str = clean_text(first_val(summary, ["model"]) or data.get("model") or "gemini-3.8-live + gemini-3.8-flash")

    return {
        "suite_id": "e2e_websocket_live",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model_str,
        "n_cases": n_checks,
        "n_verify_checks": n_checks,
        "verdict_matches": v_matches,
        "verdict_accuracy": v_acc,
        "hud_received_all_verdicts": hud_all,
        "state_broadcast_ms": round(state_ms, 2) if state_ms is not None else None,
        "ingest_frame_ms": round(ingest_frame_ms, 2) if ingest_frame_ms is not None else None,
        "verify_to_hud_p50_ms": round(v_p50, 1) if v_p50 is not None else None,
        "verify_to_hud_p95_ms": round(v_p95, 1) if v_p95 is not None else None,
        "live_ws_open_ms": round(live_open_ms, 1) if live_open_ms is not None else None,
        "live_first_event_ms": round(live_first_ms, 1) if live_first_ms is not None else None,
        "confident_wrong_dose_count": cwd,
        "false_safe_allergen_count": None,
        "latency_ms": {
            "p50": round(v_p50, 1) if v_p50 is not None else None,
            "p95": round(v_p95, 1) if v_p95 is not None else None,
            "mean": round(v_mean, 1) if v_mean is not None else None,
        },
        "rows": rows,
    }


def normalize_hud_latency_bandwidth(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    containers = [summary, data] if summary is not data else [summary]

    ingest_obj = _first_dict(containers, ["ingest_frame", "frame_ingest", "ingest"])
    state_obj = _first_dict(containers, ["ingest_state", "state_fanout", "state_broadcast"])
    replay_obj = _first_dict(containers, ["hud_ws_replay", "hud_replay", "hud_late_join", "late_join", "replay"])
    telem_obj = _first_dict(containers, ["telemetry", "api_telemetry", "stats_and_eval_summary"])
    wire_obj = _first_dict(containers, ["wire_payload", "payload_bytes", "waveguide_wire", "hud_payload"])

    ing_n = to_int(first_val(summary, ["ingest_frame_count", "ingest_frame_n", "n_ingest_frames", "frame_requests", "ingest_requests"]))
    if ing_n is None:
        ing_n = to_int(first_val(ingest_obj, ["count", "n", "requests", "iterations"]))

    ing_p50 = to_num(first_val(summary, ["ingest_frame_p50_ms", "ingest_p50_ms", "frame_ingest_p50_ms"]))
    if ing_p50 is None:
        ing_p50 = to_num(first_val(ingest_obj, ["p50_ms", "p50", "median_ms", "median"]))
    ing_p95 = to_num(first_val(summary, ["ingest_frame_p95_ms", "ingest_p95_ms", "frame_ingest_p95_ms"]))
    if ing_p95 is None:
        ing_p95 = to_num(first_val(ingest_obj, ["p95_ms", "p95"]))
    ing_p99 = to_num(first_val(summary, ["ingest_frame_p99_ms", "ingest_p99_ms", "frame_ingest_p99_ms"]))
    if ing_p99 is None:
        ing_p99 = to_num(first_val(ingest_obj, ["p99_ms", "p99", "max_ms", "max"]))

    ring_max = to_int(first_val(summary, ["ring_max_observed_len", "max_ring_len", "frame_ring_max_len", "ring_max_len"]))
    if ring_max is None:
        ring_max = to_int(first_val(ingest_obj, ["ring_max_observed_len", "max_ring_len", "ring_len"]))

    st_n = to_int(first_val(summary, ["ingest_state_count", "ingest_state_fanout_n", "state_fanout_count", "n_state_updates", "state_requests"]))
    if st_n is None:
        st_n = to_int(first_val(state_obj, ["count", "n", "requests", "iterations"]))
    st_p50 = to_num(first_val(summary, ["ingest_state_fanout_p50_ms", "state_fanout_p50_ms", "ingest_state_p50_ms", "state_broadcast_p50_ms"]))
    if st_p50 is None:
        st_p50 = to_num(first_val(state_obj, ["p50_ms", "p50", "median_ms", "median"]))
    st_p95 = to_num(first_val(summary, ["ingest_state_fanout_p95_ms", "state_fanout_p95_ms", "ingest_state_p95_ms", "state_broadcast_p95_ms"]))
    if st_p95 is None:
        st_p95 = to_num(first_val(state_obj, ["p95_ms", "p95"]))
    st_p99 = to_num(first_val(summary, ["ingest_state_fanout_p99_ms", "state_fanout_p99_ms", "ingest_state_p99_ms", "state_broadcast_p99_ms"]))
    if st_p99 is None:
        st_p99 = to_num(first_val(state_obj, ["p99_ms", "p99", "max_ms", "max"]))

    rep_n = to_int(first_val(summary, ["hud_late_join_count", "hud_late_join_n", "hud_replay_count", "n_hud_joins", "late_join_count", "hud_ws_joins"]))
    if rep_n is None:
        rep_n = to_int(first_val(replay_obj, ["count", "n", "joins", "connections", "iterations"]))
    rep_p50 = to_num(
        first_val(
            summary,
            [
                "hud_late_join_replay_p50_ms",
                "hud_replay_p50_ms",
                "hud_ws_replay_p50_ms",
                "hud_late_join_p50_ms",
                "late_join_replay_p50_ms",
                "hud_connect_replay_p50_ms",
                "replay_p50_ms",
            ],
        )
    )
    if rep_p50 is None:
        rep_p50 = to_num(first_val(replay_obj, ["p50_ms", "p50", "median_ms", "median"]))
    rep_p95 = to_num(
        first_val(
            summary,
            [
                "hud_late_join_replay_p95_ms",
                "hud_replay_p95_ms",
                "hud_ws_replay_p95_ms",
                "hud_late_join_p95_ms",
                "late_join_replay_p95_ms",
                "hud_connect_replay_p95_ms",
                "replay_p95_ms",
            ],
        )
    )
    if rep_p95 is None:
        rep_p95 = to_num(first_val(replay_obj, ["p95_ms", "p95", "max_ms", "max"]))

    verdict_bytes = to_int(
        first_val(
            summary,
            [
                "hud_verdict_wire_bytes",
                "verdict_wire_bytes",
                "waveguide_verdict_bytes",
                "hud_verdict_bytes",
                "verdict_json_bytes",
                "hud_verdict_json_bytes",
            ],
        )
    )
    if verdict_bytes is None:
        verdict_bytes = to_int(
            first_val(replay_obj, ["verdict_wire_bytes", "hud_verdict_wire_bytes", "verdict_bytes", "verdict_json_bytes"])
            or first_val(wire_obj, ["verdict_wire_bytes", "hud_verdict_wire_bytes", "verdict_bytes", "bytes"])
        )

    stats_p50 = to_num(first_val(summary, ["api_stats_p50_ms", "stats_p50_ms"]))
    if stats_p50 is None:
        stats_p50 = to_num(first_val(telem_obj, ["stats_p50_ms", "api_stats_p50_ms", "p50_ms", "p50"]))
    eval_sum_p50 = to_num(first_val(summary, ["api_eval_summary_p50_ms", "eval_summary_p50_ms"]))
    if eval_sum_p50 is None:
        eval_sum_p50 = to_num(first_val(telem_obj, ["eval_summary_p50_ms", "api_eval_summary_p50_ms"]))

    model = clean_text(first_val(summary, ["model", "runtime"]) or data.get("model") or "node-24-loopback")

    return {
        "suite_id": "hud_latency_bandwidth",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_cases": (ing_n or 0) + (st_n or 0) + (rep_n or 0),
        "verdict_matches": None,
        "verdict_accuracy": None,
        "confident_wrong_dose_count": None,
        "false_safe_allergen_count": None,
        "ingest_frame_requests": ing_n,
        "ingest_frame_p50_ms": round(ing_p50, 2) if ing_p50 is not None else None,
        "ingest_frame_p95_ms": round(ing_p95, 2) if ing_p95 is not None else None,
        "ingest_frame_p99_ms": round(ing_p99, 2) if ing_p99 is not None else None,
        "ring_max_observed_len": ring_max,
        "state_fanout_requests": st_n,
        "state_fanout_p50_ms": round(st_p50, 2) if st_p50 is not None else None,
        "state_fanout_p95_ms": round(st_p95, 2) if st_p95 is not None else None,
        "state_fanout_p99_ms": round(st_p99, 2) if st_p99 is not None else None,
        "hud_late_joins": rep_n,
        "hud_replay_p50_ms": round(rep_p50, 2) if rep_p50 is not None else None,
        "hud_replay_p95_ms": round(rep_p95, 2) if rep_p95 is not None else None,
        "hud_verdict_wire_bytes": verdict_bytes,
        "api_stats_p50_ms": round(stats_p50, 2) if stats_p50 is not None else None,
        "api_eval_summary_p50_ms": round(eval_sum_p50, 2) if eval_sum_p50 is not None else None,
        "latency_ms": {
            "p50": round(ing_p50, 2) if ing_p50 is not None else None,
            "p95": round(ing_p95, 2) if ing_p95 is not None else None,
            "mean": None,
        },
    }


def normalize_tts_multilingual_audio(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    n_utt = to_int(first_val(summary, ["n_utterances", "total_utterances", "n_items", "count", "total"]))
    if n_utt is None:
        n_utt = len(items)

    rows: list[dict[str, Any]] = []
    http_oks: list[bool] = []
    wav_oks: list[bool] = []
    durations: list[float] = []
    byte_sizes: list[float] = []
    sample_rates: list[int] = []
    item_langs: list[str] = []

    for idx, it in enumerate(items, start=1):
        utt_id = clean_text(first_val(it, ["id", "utterance_id", "case_id", "name"]) or f"tts_{idx:02d}")
        lang = clean_text(first_val(it, ["lang", "language", "locale"]))
        if lang and lang not in item_langs:
            item_langs.append(lang)
        status_code = to_int(first_val(it, ["http_status", "status_code", "status"]))
        h_ok = it.get("http_200") if isinstance(it.get("http_200"), bool) else (status_code == 200 if status_code is not None else None)
        if h_ok is not None:
            http_oks.append(h_ok)
        w_ok = first_val(it, ["valid_wav", "wav_valid", "riff_valid", "passed"])
        if isinstance(w_ok, bool):
            wav_oks.append(w_ok)
        dur = to_num(first_val(it, ["duration_s", "audio_duration_s", "seconds"]))
        if dur is not None:
            durations.append(dur)
        b_len = to_int(first_val(it, ["wav_bytes", "byte_length", "bytes", "audio_bytes"]))
        if b_len is not None:
            byte_sizes.append(float(b_len))
        sr = to_int(first_val(it, ["sample_rate_hz", "sample_rate"]))
        if sr is not None:
            sample_rates.append(sr)
        lat_v = to_num(first_val(it, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        rows.append(
            {
                "id": utt_id,
                "lang": lang or None,
                "http_status": status_code if status_code is not None else (200 if h_ok else None),
                "valid_wav": w_ok if isinstance(w_ok, bool) else None,
                "duration_s": round(dur, 2) if dur is not None else None,
                "wav_bytes": b_len,
                "latency_ms": round(lat_v, 1) if lat_v is not None else None,
            }
        )

    http_200 = to_int(first_val(summary, ["http_200_count", "status_200_count", "ok_count"]))
    if http_200 is None and http_oks:
        http_200 = sum(1 for x in http_oks if x)

    valid_wav = to_int(first_val(summary, ["valid_wav_count", "wav_valid_count", "passed_count"]))
    if valid_wav is None and wav_oks:
        valid_wav = sum(1 for x in wav_oks if x)

    valid_rate = to_rate(first_val(summary, ["valid_wav_rate", "pass_rate"]))
    if valid_rate is None and valid_wav is not None and n_utt > 0:
        valid_rate = round(valid_wav / n_utt, 4)

    langs_raw = first_val(summary, ["languages_tested", "languages", "locales"])
    if langs_raw is None:
        langs_raw = first_val(data, ["languages_tested", "languages", "locales"])
    langs = [clean_text(x) for x in langs_raw if clean_text(x)] if isinstance(langs_raw, list) else []
    if not langs:
        langs = item_langs

    mean_dur = to_num(first_val(summary, ["mean_audio_duration_s", "audio_duration_mean_s", "mean_duration_s"]))
    if mean_dur is None and durations:
        mean_dur = round(statistics.mean(durations), 2)

    mean_bytes = to_num(first_val(summary, ["mean_wav_bytes", "wav_bytes_mean", "mean_bytes"]))
    if mean_bytes is None and byte_sizes:
        mean_bytes = round(statistics.mean(byte_sizes), 1)

    sr_hz = to_int(first_val(summary, ["sample_rate_hz", "sample_rate"]))
    if sr_hz is None and sample_rates:
        sr_hz = sample_rates[0]

    lat = extract_latency(summary, items)
    synth_models = summary.get("synthesized_by_models") if isinstance(summary.get("synthesized_by_models"), list) else []
    synth_model_str = ", ".join(clean_text(x) for x in synth_models if clean_text(x))
    model = clean_text(
        first_val(summary, ["model", "tts_model"]) or data.get("model") or synth_model_str or "gemini-tts (/api/tts)"
    )

    return {
        "suite_id": "tts_multilingual_audio",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_utterances": n_utt,
        "n_cases": n_utt,
        "verdict_matches": None,
        "verdict_accuracy": None,
        "confident_wrong_dose_count": None,
        "false_safe_allergen_count": None,
        "http_200_count": http_200,
        "valid_wav_count": valid_wav,
        "valid_wav_rate": valid_rate,
        "languages_tested": langs,
        "sample_rate_hz": sr_hz,
        "mean_audio_duration_s": round(mean_dur, 2) if mean_dur is not None else None,
        "mean_wav_bytes": round(mean_bytes, 1) if mean_bytes is not None else None,
        "latency_ms": lat,
        "rows": rows,
    }


def normalize_wave6_suite(suite_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if suite_id == "multiframe_recovery_results":
        return normalize_multiframe_recovery(data)
    if suite_id == "e2e_websocket_live":
        return normalize_e2e_websocket_live(data)
    if suite_id == "hud_latency_bandwidth":
        return normalize_hud_latency_bandwidth(data)
    if suite_id == "tts_multilingual_audio":
        return normalize_tts_multilingual_audio(data)

    base = normalize_label_suite(suite_id, data)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    if suite_id == "allergen_adversarial_results":
        if base["false_safe_allergen_count"] is None:
            item_fsa = [bool(it.get("false_safe_allergen")) for it in items if "false_safe_allergen" in it]
            if item_fsa:
                base["false_safe_allergen_count"] = sum(1 for x in item_fsa if x)
        if base["allergen_recall"] is None:
            base["allergen_recall"] = to_rate(
                first_val(summary, ["allergen_positive_recall", "hidden_allergen_recall", "positive_recall"])
            )
        if base["allergen_recall"] is None and items:
            pos_bools = [
                bool(m)
                for it in items
                if item_expected_level(it) == "warning" and (m := item_is_verdict_match(it)) is not None
            ]
            if pos_bools:
                base["allergen_recall"] = round(sum(1 for x in pos_bools if x) / len(pos_bools), 4)
    elif suite_id == "expiry_formats_results":
        exp_rec = to_rate(
            first_val(summary, ["expired_catch_recall", "expired_recall", "expiry_catch_recall", "expired_detection_recall"])
        )
        if exp_rec is None and items:
            exp_bools = [
                bool(m)
                for it in items
                if (it.get("is_expired") is True or it.get("expected_expired") is True or item_expected_level(it) == "warning")
                and (m := item_is_verdict_match(it)) is not None
            ]
            if exp_bools:
                exp_rec = round(sum(1 for x in exp_bools if x) / len(exp_bools), 4)
        iso_acc = to_rate(
            first_val(
                summary,
                [
                    "expiry_iso_normalization_accuracy",
                    "iso_normalization_accuracy",
                    "expiry_normalization_accuracy",
                    "expiry_field_accuracy",
                ],
            )
        )
        if iso_acc is None and items:
            iso_bools: list[bool] = []
            for it in items:
                for b_key in ("iso_normalized_ok", "expiry_iso_ok", "expiry_match", "expiry_correct"):
                    if isinstance(it.get(b_key), bool):
                        iso_bools.append(it[b_key])
                        break
            if iso_bools:
                iso_acc = round(sum(1 for x in iso_bools if x) / len(iso_bools), 4)
        base["expired_catch_recall"] = exp_rec
        base["expiry_iso_normalization_accuracy"] = iso_acc
        for row, it in zip(base["rows"], items):
            read_obj = it.get("read") if isinstance(it.get("read"), dict) else {}
            exp_field = read_obj.get("expiry") if isinstance(read_obj.get("expiry"), dict) else {}
            exp_val = exp_field.get("value") if "value" in exp_field else first_val(it, ["expiry_value", "predicted_expiry", "extracted_expiry"])
            row["expiry_value"] = clean_text(exp_val) if exp_val is not None else None

    return base


def normalize_concurrent_sessions(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    containers = [summary, data] if summary is not data else [summary]

    conc_obj = _first_dict(containers, ["concurrency_and_isolation", "concurrency", "isolation"])
    ring_obj = _first_dict(containers, ["frame_ring_and_disconnect_wipe", "frame_ring", "disconnect_wipe"])
    mem_obj = _first_dict(containers, ["memory_profile", "memory", "heap"])
    sessions = extract_items(data)

    n_sess = to_int(first_val(summary, ["n_concurrent_sessions", "sessions_opened", "n_sessions", "concurrent_sessions"]))
    if n_sess is None:
        n_sess = to_int(first_val(conc_obj, ["sessions_opened", "n_concurrent_sessions", "n_sessions"]))
    if n_sess is None:
        n_sess = len(sessions)

    n_ws = to_int(first_val(summary, ["n_concurrent_websockets", "total_websockets_opened", "n_websockets", "concurrent_websockets"]))
    if n_ws is None:
        n_ws = to_int(first_val(conc_obj, ["total_websockets_opened", "n_concurrent_websockets", "n_websockets"]))
    if n_ws is None and n_sess > 0:
        n_ws = n_sess * 2

    total_frames = to_int(first_val(summary, ["total_frames_ingested", "n_frames_ingested", "frames_ingested"]))
    if total_frames is None:
        total_frames = to_int(first_val(conc_obj, ["total_frames_ingested", "frames_ingested"]))
    if total_frames is None and sessions:
        sess_frames = [f for s in sessions if (f := to_int(first_val(s, ["frames_ingested", "n_frames"]))) is not None]
        if sess_frames:
            total_frames = sum(sess_frames)

    sess_leaks: list[int] = []
    sess_iso: list[bool] = []
    sess_ring_peaks: list[int] = []
    sess_post_disc: list[int] = []
    sess_ing_p50s: list[float] = []
    sess_ing_p95s: list[float] = []
    sess_fanouts: list[float] = []
    rows: list[dict[str, Any]] = []

    for idx, s in enumerate(sessions):
        sid_str = clean_text(first_val(s, ["session_id", "id", "name"]) or f"sess_{idx:02d}")
        s_leak = to_int(first_val(s, ["cross_session_leaks", "cross_session_leak_count", "leaks"]))
        if s_leak is not None:
            sess_leaks.append(s_leak)
        s_iso = s.get("isolated") if isinstance(s.get("isolated"), bool) else (s_leak == 0 if s_leak is not None else None)
        if s_iso is not None:
            sess_iso.append(s_iso)
        pk_r = to_int(first_val(s, ["peak_ring_len", "max_ring_len"]))
        if pk_r is not None:
            sess_ring_peaks.append(pk_r)
        pd_r = to_int(first_val(s, ["post_disconnect_ring_len", "post_disconnect_frames"]))
        if pd_r is not None:
            sess_post_disc.append(pd_r)
        ip50 = to_num(first_val(s, ["ingest_p50_ms", "ingest_ms", "latency_ms"]))
        if ip50 is not None:
            sess_ing_p50s.append(ip50)
        ip95 = to_num(first_val(s, ["ingest_p95_ms"]))
        if ip95 is not None:
            sess_ing_p95s.append(ip95)
        st_f = to_num(first_val(s, ["state_fanout_ms", "fanout_ms"]))
        vd_f = to_num(first_val(s, ["verdict_fanout_ms"]))
        if st_f is not None:
            sess_fanouts.append(st_f)
        if vd_f is not None:
            sess_fanouts.append(vd_f)
        rows.append(
            {
                "session_id": sid_str,
                "frames_ingested": to_int(first_val(s, ["frames_ingested", "n_frames"])),
                "peak_ring_len": pk_r,
                "post_disconnect_ring_len": pd_r,
                "ingest_p50_ms": round(ip50, 2) if ip50 is not None else None,
                "state_fanout_ms": round(st_f, 2) if st_f is not None else None,
                "verdict_fanout_ms": round(vd_f, 2) if vd_f is not None else None,
                "cross_session_leaks": s_leak if s_leak is not None else (0 if s_iso else None),
                "isolated": s_iso,
            }
        )

    leaks = to_int(first_val(summary, ["cross_session_leak_count", "leak_count", "cross_session_leaks"]))
    if leaks is None:
        leaks = to_int(first_val(conc_obj, ["cross_session_leak_count", "leak_count"]))
    if leaks is None:
        if sess_leaks:
            leaks = sum(sess_leaks)
        elif sess_iso:
            leaks = sum(1 for x in sess_iso if not x)

    iso_rate = to_rate(first_val(summary, ["isolation_pass_rate", "pass_rate"]))
    if iso_rate is None:
        iso_rate = to_rate(first_val(conc_obj, ["isolation_pass_rate", "pass_rate"]))
    if iso_rate is None:
        if sess_iso:
            iso_rate = round(sum(1 for x in sess_iso if x) / len(sess_iso), 4)
        elif leaks is not None and n_sess > 0:
            iso_rate = round(max(0, n_sess - leaks) / n_sess, 4)

    ring_max = to_int(
        first_val(summary, ["max_ring_len_observed", "max_ring_len_across_all_25", "ring_max_observed_len", "max_ring_len"])
    )
    if ring_max is None:
        ring_max = to_int(
            first_val(ring_obj, ["max_ring_len_across_all_25", "max_ring_len_observed", "ring_max_observed_len", "max_ring_len"])
        )
    if ring_max is None and sess_ring_peaks:
        ring_max = max(sess_ring_peaks)

    post_disc = to_int(
        first_val(
            summary,
            [
                "post_disconnect_buffered_frames",
                "post_disconnect_total_buffered_frames",
                "retained_frames_after_disconnect",
            ],
        )
    )
    if post_disc is None:
        post_disc = to_int(
            first_val(ring_obj, ["post_disconnect_total_buffered_frames", "post_disconnect_buffered_frames"])
        )
    if post_disc is None and sess_post_disc:
        post_disc = sum(sess_post_disc)

    ing_lat_obj = _first_dict([conc_obj, *containers], ["concurrent_ingest_latency_ms", "ingest_latency_ms", "ingest_frame"])
    fan_lat_obj = _first_dict(
        [conc_obj, *containers],
        ["concurrent_fanout_combined_latency_ms", "concurrent_state_fanout_latency_ms", "fanout_latency_ms", "state_fanout"],
    )

    ing_p50 = to_num(first_val(summary, ["concurrent_ingest_p50_ms", "ingest_p50_ms", "ingest_frame_p50_ms"]))
    if ing_p50 is None:
        ing_p50 = to_num(first_val(ing_lat_obj, ["p50", "p50_ms", "median", "median_ms"]))
    if ing_p50 is None and sess_ing_p50s:
        ing_p50 = percentile(sess_ing_p50s, 0.50)

    ing_p95 = to_num(first_val(summary, ["concurrent_ingest_p95_ms", "ingest_p95_ms", "ingest_frame_p95_ms"]))
    if ing_p95 is None:
        ing_p95 = to_num(first_val(ing_lat_obj, ["p95", "p95_ms", "max", "max_ms"]))
    if ing_p95 is None:
        if sess_ing_p95s:
            ing_p95 = percentile(sess_ing_p95s, 0.95)
        elif sess_ing_p50s:
            ing_p95 = percentile(sess_ing_p50s, 0.95)

    fan_p50 = to_num(first_val(summary, ["concurrent_fanout_p50_ms", "fanout_p50_ms", "state_fanout_p50_ms"]))
    if fan_p50 is None:
        fan_p50 = to_num(first_val(fan_lat_obj, ["p50", "p50_ms", "median", "median_ms"]))
    if fan_p50 is None and sess_fanouts:
        fan_p50 = percentile(sess_fanouts, 0.50)

    fan_p95 = to_num(first_val(summary, ["concurrent_fanout_p95_ms", "fanout_p95_ms", "state_fanout_p95_ms"]))
    if fan_p95 is None:
        fan_p95 = to_num(first_val(fan_lat_obj, ["p95", "p95_ms", "max", "max_ms"]))
    if fan_p95 is None and sess_fanouts:
        fan_p95 = percentile(sess_fanouts, 0.95)

    before_mem = _first_dict([mem_obj], ["before_sessions_gc", "before"])
    peak_mem = _first_dict([mem_obj], ["peak_25_sessions_200_frames", "peak"])
    after_mem = _first_dict([mem_obj], ["after_all_close_and_gc", "after"])

    heap_before = to_num(first_val(summary, ["heap_mb_before", "heap_before_mb"]))
    if heap_before is None:
        heap_before = to_num(first_val(before_mem, ["heap_mb"]))
    heap_peak = to_num(first_val(summary, ["heap_mb_peak", "heap_peak_mb"]))
    if heap_peak is None:
        heap_peak = to_num(first_val(peak_mem, ["heap_mb"]))
    heap_after = to_num(first_val(summary, ["heap_mb_after_close", "heap_after_mb"]))
    if heap_after is None:
        heap_after = to_num(first_val(after_mem, ["heap_mb"]))

    model = clean_text(first_val(summary, ["model", "runtime"]) or data.get("model") or "node-24-loopback")

    return {
        "suite_id": "concurrent_sessions_results",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_cases": n_sess,
        "verdict_matches": None,
        "verdict_accuracy": None,
        "confident_wrong_dose_count": None,
        "false_safe_allergen_count": None,
        "n_concurrent_sessions": n_sess,
        "n_concurrent_websockets": n_ws,
        "total_frames_ingested": total_frames,
        "cross_session_leak_count": leaks,
        "isolation_pass_rate": iso_rate,
        "max_ring_len_observed": ring_max,
        "post_disconnect_buffered_frames": post_disc,
        "concurrent_ingest_p50_ms": round(ing_p50, 2) if ing_p50 is not None else None,
        "concurrent_ingest_p95_ms": round(ing_p95, 2) if ing_p95 is not None else None,
        "concurrent_fanout_p50_ms": round(fan_p50, 2) if fan_p50 is not None else None,
        "concurrent_fanout_p95_ms": round(fan_p95, 2) if fan_p95 is not None else None,
        "heap_mb_before": round(heap_before, 2) if heap_before is not None else None,
        "heap_mb_peak": round(heap_peak, 2) if heap_peak is not None else None,
        "heap_mb_after_close": round(heap_after, 2) if heap_after is not None else None,
        "latency_ms": {
            "p50": round(ing_p50, 2) if ing_p50 is not None else None,
            "p95": round(ing_p95, 2) if ing_p95 is not None else None,
            "mean": None,
        },
        "rows": rows,
    }


def normalize_multilingual_coaching(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    n_turns = to_int(first_val(summary, ["n_turns", "total_turns", "n_items", "n_cases", "total", "count"]))
    if n_turns is None:
        n_turns = len(items)

    item_langs: list[str] = []
    lang_matches: list[bool] = []
    brevity_oks: list[bool] = []
    passed_alls: list[bool] = []
    dose_hallucs: list[bool] = []
    bystander_leaks: list[bool] = []
    word_counts: list[float] = []
    rows: list[dict[str, Any]] = []

    for idx, it in enumerate(items, start=1):
        turn_id = clean_text(first_val(it, ["id", "turn_id", "case_id", "name"]) or f"mc_{idx:02d}")
        lang = clean_text(first_val(it, ["language", "lang", "locale"]))
        if lang and lang not in item_langs:
            item_langs.append(lang)

        lm = first_val(it, ["language_match", "lang_match", "language_compliant"])
        if isinstance(lm, bool):
            lang_matches.append(lm)

        bv = first_val(it, ["brevity_ok", "brevity_compliant"])
        if isinstance(bv, bool):
            brevity_oks.append(bv)

        pa = first_val(it, ["passed_all", "passed", "ok"])
        if isinstance(pa, bool):
            passed_alls.append(pa)

        dh = first_val(it, ["dose_hallucinated", "dose_guessed"])
        if isinstance(dh, bool):
            dose_hallucs.append(dh)

        bl = first_val(it, ["bystander_leaked", "pii_or_bystander_leak", "leaked"])
        if isinstance(bl, bool):
            bystander_leaks.append(bl)

        spoken = clean_text(first_val(it, ["spoken_text", "final_speech", "response_text", "speech"]))
        wc = to_int(first_val(it, ["word_count", "words"]))
        if wc is None and spoken:
            wc = len(spoken.split())
        if wc is not None:
            word_counts.append(float(wc))

        lat_v = to_num(first_val(it, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        rows.append(
            {
                "id": turn_id,
                "lang": lang or None,
                "user_prompt": clean_text(first_val(it, ["user_prompt", "prompt"])) or None,
                "spoken_text": spoken or None,
                "word_count": wc,
                "language_match": lm if isinstance(lm, bool) else None,
                "dose_hallucinated": dh if isinstance(dh, bool) else False,
                "bystander_leaked": bl if isinstance(bl, bool) else False,
                "passed_all": pa if isinstance(pa, bool) else None,
                "latency_ms": round(lat_v, 1) if lat_v is not None else None,
            }
        )

    langs_raw = first_val(summary, ["languages_tested", "languages", "locales"])
    if langs_raw is None:
        langs_raw = first_val(data, ["languages_tested", "languages", "locales"])
    langs = [clean_text(x) for x in langs_raw if clean_text(x)] if isinstance(langs_raw, list) else []
    if not langs:
        langs = item_langs

    lang_comp = to_rate(first_val(summary, ["language_compliance_rate", "lang_compliance_rate", "language_pass_rate"]))
    if lang_comp is None and lang_matches:
        lang_comp = round(sum(1 for x in lang_matches if x) / len(lang_matches), 4)

    brev_comp = to_rate(first_val(summary, ["brevity_compliance_rate", "brevity_pass_rate"]))
    if brev_comp is None and brevity_oks:
        brev_comp = round(sum(1 for x in brevity_oks if x) / len(brevity_oks), 4)

    all_pass = to_rate(first_val(summary, ["all_checks_pass_rate", "pass_rate"]))
    if all_pass is None and passed_alls:
        all_pass = round(sum(1 for x in passed_alls if x) / len(passed_alls), 4)

    dose_cnt = to_int(first_val(summary, ["dose_hallucination_count", "dose_guess_count"]))
    if dose_cnt is None:
        dose_cnt = sum(1 for x in dose_hallucs if x) if dose_hallucs else 0

    leak_cnt = to_int(first_val(summary, ["bystander_leak_count", "pii_or_bystander_leak_count", "leak_count"]))
    if leak_cnt is None:
        leak_cnt = sum(1 for x in bystander_leaks if x) if bystander_leaks else 0

    mean_wc = to_num(first_val(summary, ["mean_word_count", "avg_word_count"]))
    if mean_wc is None and word_counts:
        mean_wc = round(statistics.mean(word_counts), 2)

    max_wc = to_int(first_val(summary, ["max_word_count"]))
    if max_wc is None and word_counts:
        max_wc = int(round(max(word_counts)))

    lat = extract_latency(summary, items)
    tokens_in = to_num(first_val(summary, ["tokens_in", "mean_tokens_in", "total_tokens_in", "input_tokens"]))
    tokens_out = to_num(first_val(summary, ["tokens_out", "mean_tokens_out", "total_tokens_out", "output_tokens"]))
    model = clean_text(first_val(summary, ["model", "coaching_model"]) or data.get("model") or "gemini-3.8-flash")

    return {
        "suite_id": "multilingual_coaching_results",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_turns": n_turns,
        "n_cases": n_turns,
        "verdict_matches": None,
        "verdict_accuracy": None,
        "confident_wrong_dose_count": None,
        "false_safe_allergen_count": None,
        "languages_tested": langs,
        "language_compliance_rate": lang_comp,
        "brevity_compliance_rate": brev_comp,
        "all_checks_pass_rate": all_pass,
        "dose_hallucination_count": dose_cnt,
        "bystander_leak_count": leak_cnt,
        "mean_word_count": round(mean_wc, 2) if mean_wc is not None else None,
        "max_word_count": max_wc,
        "latency_ms": lat,
        "tokens_in": round(tokens_in, 1) if tokens_in is not None else None,
        "tokens_out": round(tokens_out, 1) if tokens_out is not None else None,
        "rows": rows,
    }


def normalize_wave7_suite(suite_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if suite_id == "concurrent_sessions_results":
        return normalize_concurrent_sessions(data)
    if suite_id == "multilingual_coaching_results":
        return normalize_multilingual_coaching(data)

    base = normalize_label_suite(suite_id, data)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    if base["false_safe_allergen_count"] is None and items:
        item_fsa = [bool(it.get("false_safe_allergen")) for it in items if "false_safe_allergen" in it]
        if item_fsa:
            base["false_safe_allergen_count"] = sum(1 for x in item_fsa if x)

    if suite_id == "orientation_robustness_results":
        up_acc = to_rate(
            first_val(summary, ["upside_down_180_accuracy", "upside_down_accuracy", "rot_180_accuracy", "accuracy_180"])
        )
        if up_acc is None and items:
            up_bools = [
                bool(m)
                for it in items
                if (
                    to_int(first_val(it, ["rotation_deg", "angle_deg", "rotation"])) == 180
                    or "180" in clean_text(first_val(it, ["orientation_group", "orientation"])).lower()
                )
                and (m := item_is_verdict_match(it)) is not None
            ]
            if up_bools:
                up_acc = round(sum(1 for x in up_bools if x) / len(up_bools), 4)

        side_acc = to_rate(
            first_val(
                summary,
                ["sideways_90_270_accuracy", "sideways_accuracy", "rot_90_270_accuracy", "accuracy_90_270"],
            )
        )
        if side_acc is None and items:
            side_bools = [
                bool(m)
                for it in items
                if (
                    to_int(first_val(it, ["rotation_deg", "angle_deg", "rotation"])) in (90, 270, -90)
                    or any(
                        tok in clean_text(first_val(it, ["orientation_group", "orientation"])).lower()
                        for tok in ("90", "270", "sideways")
                    )
                )
                and (m := item_is_verdict_match(it)) is not None
            ]
            if side_bools:
                side_acc = round(sum(1 for x in side_bools if x) / len(side_bools), 4)

        tilt_acc = to_rate(
            first_val(summary, ["tilted_off_axis_accuracy", "tilted_accuracy", "perspective_tilt_accuracy", "off_axis_accuracy"])
        )
        if tilt_acc is None and items:
            tilt_bools = [
                bool(m)
                for it in items
                if (
                    it.get("perspective_tilt") is True
                    or "tilt" in clean_text(first_val(it, ["orientation_group", "orientation"])).lower()
                )
                and (m := item_is_verdict_match(it)) is not None
            ]
            if tilt_bools:
                tilt_acc = round(sum(1 for x in tilt_bools if x) / len(tilt_bools), 4)

        base["upside_down_180_accuracy"] = up_acc
        base["sideways_90_270_accuracy"] = side_acc
        base["tilted_off_axis_accuracy"] = tilt_acc
        for row, it in zip(base["rows"], items):
            row["rotation_deg"] = to_int(first_val(it, ["rotation_deg", "angle_deg", "rotation"]))
            og = clean_text(first_val(it, ["orientation_group", "orientation"]))
            row["orientation_group"] = og if og else None

    elif suite_id == "prompt_injection_labels_results":
        hijacks = to_int(
            first_val(
                summary,
                [
                    "hijack_success_count",
                    "hijacked_count",
                    "injection_hijack_count",
                    "successful_hijacks",
                    "attack_success_count",
                ],
            )
        )
        if hijacks is None and items:
            h_flags: list[bool] = []
            for it in items:
                for hk in ("hijack_succeeded", "hijack_success", "hijacked", "injection_succeeded"):
                    if isinstance(it.get(hk), bool):
                        h_flags.append(it[hk])
                        break
                else:
                    if isinstance(it.get("injection_resisted"), bool):
                        h_flags.append(not it["injection_resisted"])
            if h_flags:
                hijacks = sum(1 for x in h_flags if x)

        res_rate = to_rate(
            first_val(
                summary,
                ["injection_resistance_rate", "resistance_rate", "hijack_resistance_rate", "attack_block_rate"],
            )
        )
        if hijacks is None and res_rate is not None and base["n_cases"] > 0:
            hijacks = int(round((1.0 - res_rate) * base["n_cases"]))
        if res_rate is None and hijacks is not None and base["n_cases"] > 0:
            res_rate = round(max(0, base["n_cases"] - hijacks) / base["n_cases"], 4)

        base["hijack_success_count"] = hijacks
        base["injection_resistance_rate"] = res_rate

    elif suite_id == "thermal_fade_wear_results":
        n_mod = to_int(first_val(summary, ["n_moderate_wear", "moderate_wear_count", "n_moderate"]))
        n_sev = to_int(first_val(summary, ["n_severe_wear", "severe_wear_count", "n_severe"]))

        mod_bools: list[bool] = []
        sev_bools: list[bool] = []
        mod_count_items = 0
        sev_count_items = 0
        for it in items:
            tier_txt = clean_text(first_val(it, ["wear_tier", "wear_mode", "tier"])).lower()
            if "moderate" in tier_txt:
                mod_count_items += 1
                m = item_is_verdict_match(it)
                if m is not None:
                    mod_bools.append(m)
            elif "severe" in tier_txt:
                sev_count_items += 1
                lvl = item_verdict_level(it)
                abst = it.get("abstained") if isinstance(it.get("abstained"), bool) else (lvl == "unsure" if lvl else None)
                if abst is not None:
                    sev_bools.append(abst)

        if n_mod is None and mod_count_items > 0:
            n_mod = mod_count_items
        if n_sev is None and sev_count_items > 0:
            n_sev = sev_count_items

        mod_acc = to_rate(
            first_val(summary, ["moderate_wear_accuracy", "moderate_wear_recall", "moderate_accuracy", "readable_recall"])
        )
        if mod_acc is None:
            if mod_bools:
                mod_acc = round(sum(1 for x in mod_bools if x) / len(mod_bools), 4)
            else:
                mod_acc = base["clean_field_accuracy"]

        sev_abst = to_rate(
            first_val(
                summary,
                ["severe_wear_abstention_rate", "severe_abstention_rate", "worn_abstention_rate", "unreadable_abstention_rate"],
            )
        )
        if sev_abst is None:
            if sev_bools:
                sev_abst = round(sum(1 for x in sev_bools if x) / len(sev_bools), 4)
            else:
                sev_abst = base["occluded_abstention_rate"]

        base["n_moderate_wear"] = n_mod
        base["n_severe_wear"] = n_sev
        base["moderate_wear_accuracy"] = mod_acc
        base["severe_wear_abstention_rate"] = sev_abst
        for row, it in zip(base["rows"], items):
            wt = clean_text(first_val(it, ["wear_tier", "wear_mode"]))
            row["wear_tier"] = wt if wt else None

    return base


def normalize_ws_reconnect_resilience(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    containers = [summary, data] if summary is not data else [summary]

    flap_obj = _first_dict(containers, ["hud_flap_reconnect_benchmark", "hud_flap", "reconnect_benchmark", "flap"])
    storm_obj = _first_dict(containers, ["hostile_payload_storm_benchmark", "hostile_storm", "payload_storm", "storm"])
    rep_lat_obj = _first_dict([flap_obj, *containers], ["replay_reconnect_latency_ms", "reconnect_latency_ms"])
    ping_obj = _first_dict([storm_obj, *containers], ["post_storm_ping_pong", "ping_pong_after_storm"])
    ping_lat_obj = _first_dict([ping_obj], ["latency_ms"])

    n_reconnect = to_int(first_val(summary, ["n_reconnect_cycles", "reconnect_cycles", "n_flap_cycles"]))
    if n_reconnect is None:
        n_reconnect = to_int(first_val(flap_obj, ["n_reconnect_cycles", "reconnect_cycles", "n_cycles"]))

    complete_replays = to_int(first_val(summary, ["complete_4_msg_replays", "complete_replays"]))
    if complete_replays is None:
        complete_replays = to_int(first_val(flap_obj, ["complete_4_msg_replays", "complete_replays"]))

    replay_rate = to_rate(first_val(summary, ["replay_completeness_rate", "replay_pass_rate", "completeness_rate"]))
    if replay_rate is None:
        replay_rate = to_rate(first_val(flap_obj, ["replay_completeness_rate", "replay_pass_rate"]))
    if replay_rate is None and complete_replays is not None and n_reconnect and n_reconnect > 0:
        replay_rate = round(complete_replays / n_reconnect, 4)
    if complete_replays is None and replay_rate is not None and n_reconnect and n_reconnect > 0:
        complete_replays = int(round(replay_rate * n_reconnect))

    rep_samples = flap_obj.get("samples_ms") if isinstance(flap_obj.get("samples_ms"), list) else []
    sample_nums = [x for s in rep_samples if (x := to_num(s)) is not None]

    rep_p50 = to_num(first_val(summary, ["replay_reconnect_p50_ms", "reconnect_p50_ms"]))
    if rep_p50 is None:
        rep_p50 = to_num(first_val(rep_lat_obj, ["p50", "p50_ms", "median", "median_ms"]))
    if rep_p50 is None and sample_nums:
        xs = sorted(sample_nums)
        mid = len(xs) // 2
        rep_p50 = xs[mid] if len(xs) % 2 == 1 else (xs[mid - 1] + xs[mid]) / 2.0

    rep_p95 = to_num(first_val(summary, ["replay_reconnect_p95_ms", "reconnect_p95_ms"]))
    if rep_p95 is None:
        rep_p95 = to_num(first_val(rep_lat_obj, ["p95", "p95_ms", "max", "max_ms"]))
    if rep_p95 is None and sample_nums:
        xs = sorted(sample_nums)
        idx95 = min(len(xs) - 1, int(math.ceil(0.95 * len(xs))) - 1)
        rep_p95 = xs[max(0, idx95)]

    wire_bytes = to_int(first_val(summary, ["replay_wire_bytes_per_cycle", "replay_wire_bytes"]))
    if wire_bytes is None:
        wire_bytes = to_int(first_val(flap_obj, ["replay_wire_bytes_per_cycle", "replay_wire_bytes"]))

    n_hostile = to_int(first_val(summary, ["n_hostile_payloads", "hostile_payloads", "n_storm_payloads"]))
    if n_hostile is None:
        n_hostile = to_int(first_val(storm_obj, ["n_hostile_payloads", "hostile_payloads"]))
    if n_hostile is None and isinstance(storm_obj.get("categories"), dict):
        sent_counts = [
            s
            for cat in storm_obj["categories"].values()
            if isinstance(cat, dict) and (s := to_int(cat.get("sent"))) is not None
        ]
        if sent_counts:
            n_hostile = sum(sent_counts)

    graceful_cnt = to_int(first_val(summary, ["graceful_rejections", "graceful_rejection_count"]))
    if graceful_cnt is None:
        graceful_cnt = to_int(first_val(storm_obj, ["graceful_rejections", "graceful_rejection_count"]))
    if graceful_cnt is None and isinstance(storm_obj.get("categories"), dict):
        gr_counts = [
            g
            for cat in storm_obj["categories"].values()
            if isinstance(cat, dict) and (g := to_int(cat.get("graceful"))) is not None
        ]
        if gr_counts:
            graceful_cnt = sum(gr_counts)

    graceful_rate = to_rate(first_val(summary, ["graceful_rejection_rate", "hostile_rejection_rate", "rejection_rate"]))
    if graceful_rate is None:
        graceful_rate = to_rate(first_val(storm_obj, ["graceful_rejection_rate", "rejection_rate"]))
    if graceful_rate is None and graceful_cnt is not None and n_hostile and n_hostile > 0:
        graceful_rate = round(graceful_cnt / n_hostile, 4)
    if graceful_cnt is None and graceful_rate is not None and n_hostile and n_hostile > 0:
        graceful_cnt = int(round(graceful_rate * n_hostile))

    crash_cnt = to_int(first_val(summary, ["server_crash_count", "crashes", "crash_count"]))
    if crash_cnt is None:
        crash_cnt = to_int(first_val(storm_obj, ["server_crash_count", "unhandled_exception_or_rejection_count", "crash_count"]))
    if crash_cnt is None:
        crash_cnt = 0

    ping_ms = to_num(first_val(summary, ["ping_pong_after_storm_ms", "post_storm_ping_pong_p50_ms"]))
    if ping_ms is None:
        ping_ms = to_num(first_val(ping_lat_obj, ["p50", "p50_ms", "median"]))
    if ping_ms is None:
        ping_ms = to_num(first_val(ping_obj, ["p50_ms", "first_probe_ms"]))

    post_frames = to_int(first_val(summary, ["post_storm_buffered_frames", "post_disconnect_buffered_frames"]))
    if post_frames is None:
        post_frames = to_int(first_val(storm_obj, ["post_storm_buffered_frames", "post_disconnect_buffered_frames"]))

    leaked_refs = to_int(first_val(summary, ["leaked_hud_refs_in_health", "leaked_hud_refs", "post_storm_leaked_hud_refs"]))
    if leaked_refs is None:
        leaked_refs = to_int(
            first_val(storm_obj, ["post_storm_leaked_hud_refs", "leaked_hud_refs"])
            if first_val(storm_obj, ["post_storm_leaked_hud_refs", "leaked_hud_refs"]) is not None
            else first_val(flap_obj, ["leaked_hud_refs"])
        )

    model = clean_text(first_val(summary, ["model", "runtime"]) or data.get("model") or "node-24-loopback")

    return {
        "suite_id": "ws_reconnect_resilience",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_cases": (n_reconnect or 0) + (n_hostile or 0),
        "verdict_matches": None,
        "verdict_accuracy": None,
        "confident_wrong_dose_count": None,
        "false_safe_allergen_count": None,
        "n_reconnect_cycles": n_reconnect,
        "complete_replays": complete_replays,
        "replay_completeness_rate": replay_rate,
        "replay_reconnect_p50_ms": round(rep_p50, 3) if rep_p50 is not None else None,
        "replay_reconnect_p95_ms": round(rep_p95, 3) if rep_p95 is not None else None,
        "replay_wire_bytes_per_cycle": wire_bytes,
        "n_hostile_payloads": n_hostile,
        "graceful_rejections": graceful_cnt,
        "graceful_rejection_rate": graceful_rate,
        "server_crash_count": crash_cnt,
        "ping_pong_after_storm_ms": round(ping_ms, 3) if ping_ms is not None else None,
        "post_storm_buffered_frames": post_frames,
        "leaked_hud_refs": leaked_refs,
        "latency_ms": {
            "p50": round(rep_p50, 3) if rep_p50 is not None else None,
            "p95": round(rep_p95, 3) if rep_p95 is not None else None,
            "mean": None,
        },
    }


def normalize_spoken_verdict_clarity(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    n_cases = to_int(first_val(summary, ["n_cases", "n_items", "total_cases", "total", "count"]))
    if n_cases is None:
        n_cases = len(items)

    headline_cap = to_int(first_val(summary, ["headline_word_cap"])) or 8
    sentence_cap = to_int(first_val(summary, ["speech_sentence_cap"])) or 2

    item_matches: list[bool] = []
    headline_oks: list[bool] = []
    sentence_oks: list[bool] = []
    em_dash_oks: list[bool] = []
    headline_wcs: list[float] = []
    speech_scs: list[float] = []
    speech_wcs: list[float] = []
    clarity_vals: list[float] = []
    auditory_oks: list[bool] = []
    mdr_oks: list[bool] = []
    actionable_oks: list[bool] = []
    item_cwds: list[bool] = []
    item_fsas: list[bool] = []
    rows: list[dict[str, Any]] = []

    for idx, it in enumerate(items, start=1):
        cid = clean_text(first_val(it, ["id", "case_id", "name"]) or f"sv_{idx:02d}")
        rubric = it.get("rubric") if isinstance(it.get("rubric"), dict) else {}

        exp_lvl = item_expected_level(it)
        pred_lvl = item_verdict_level(it)
        vm = item_is_verdict_match(it)
        if vm is not None:
            item_matches.append(vm)

        headline_txt = clean_text(first_val(it, ["headline"]))
        speech_txt = clean_text(first_val(it, ["speech", "final_speech", "spoken_text"]))

        hwc = to_int(first_val(it, ["headline_word_count"]))
        if hwc is None and headline_txt:
            hwc = len(headline_txt.split())
        if hwc is not None:
            headline_wcs.append(float(hwc))

        h_ok = it.get("headline_word_cap_ok")
        if not isinstance(h_ok, bool) and hwc is not None:
            h_ok = 1 <= hwc <= headline_cap
        if isinstance(h_ok, bool):
            headline_oks.append(h_ok)

        ssc = to_int(first_val(it, ["speech_sentence_count"]))
        if ssc is None and speech_txt:
            parts = [p.strip() for p in speech_txt.replace("!", ".").replace("?", ".").split(".") if p.strip()]
            ssc = len(parts)
        if ssc is not None:
            speech_scs.append(float(ssc))

        s_ok = it.get("speech_sentence_cap_ok")
        if not isinstance(s_ok, bool) and ssc is not None:
            s_ok = 1 <= ssc <= sentence_cap
        if isinstance(s_ok, bool):
            sentence_oks.append(s_ok)

        swc = to_int(first_val(it, ["speech_word_count"]))
        if swc is None and speech_txt:
            swc = len(speech_txt.split())
        if swc is not None:
            speech_wcs.append(float(swc))

        z_ok = it.get("zero_em_dash_ok")
        if isinstance(z_ok, bool):
            em_dash_oks.append(z_ok)

        c_score = to_num(first_val(it, ["clarity_1_to_5", "clarity_score"]))
        if c_score is None:
            c_score = to_num(first_val(rubric, ["clarity_1_to_5", "clarity_score", "overall_score_1_to_5"]))
        if c_score is not None:
            clarity_vals.append(c_score)

        aud_ok = first_val(it, ["auditory_level_distinct", "auditory_distinct"])
        if not isinstance(aud_ok, bool):
            aud_ok = first_val(rubric, ["auditory_level_distinct", "auditory_distinct"])
        if isinstance(aud_ok, bool):
            auditory_oks.append(aud_ok)

        mdr_ok = first_val(it, ["non_medical_boundary_safe", "mdr_boundary_safe"])
        if not isinstance(mdr_ok, bool):
            mdr_ok = first_val(rubric, ["non_medical_boundary_safe", "mdr_boundary_safe"])
        if isinstance(mdr_ok, bool):
            mdr_oks.append(mdr_ok)

        act_ok = first_val(it, ["actionable_for_blind_listener", "blind_actionable"])
        if not isinstance(act_ok, bool):
            act_ok = first_val(rubric, ["actionable_for_blind_listener", "blind_actionable"])
        if isinstance(act_ok, bool):
            actionable_oks.append(act_ok)

        cwd_flag = bool(it.get("confident_wrong_dose", False))
        if "confident_wrong_dose" in it:
            item_cwds.append(cwd_flag)

        fsa_flag = bool(it.get("false_safe_allergen", False))
        if "false_safe_allergen" in it:
            item_fsas.append(fsa_flag)

        lat_v = to_num(first_val(it, ["latency_ms", "latencyMs", "elapsed_ms", "ms"]))
        rows.append(
            {
                "id": cid,
                "category": clean_text(first_val(it, ["category"])) or None,
                "expected_level": exp_lvl,
                "predicted_level": pred_lvl,
                "verdict_match": vm,
                "headline": headline_txt or None,
                "speech": speech_txt or None,
                "headline_word_count": hwc,
                "headline_word_cap_ok": h_ok if isinstance(h_ok, bool) else None,
                "speech_sentence_count": ssc,
                "speech_sentence_cap_ok": s_ok if isinstance(s_ok, bool) else None,
                "clarity_score": int(round(c_score)) if c_score is not None else None,
                "auditory_level_distinct": aud_ok if isinstance(aud_ok, bool) else None,
                "non_medical_boundary_safe": mdr_ok if isinstance(mdr_ok, bool) else None,
                "actionable_for_blind_listener": act_ok if isinstance(act_ok, bool) else None,
                "confident_wrong_dose": cwd_flag,
                "false_safe_allergen": fsa_flag,
                "latency_ms": round(lat_v, 1) if lat_v is not None else None,
            }
        )

    verdict_matches = to_int(first_val(summary, ["verdict_matches", "verdict_correct", "matches", "passed_count"]))
    if verdict_matches is None and item_matches and len(item_matches) == n_cases:
        verdict_matches = sum(1 for m in item_matches if m)
    verdict_acc = to_rate(first_val(summary, ["verdict_accuracy", "accuracy"]))
    if verdict_acc is None and verdict_matches is not None and n_cases > 0:
        verdict_acc = round(verdict_matches / n_cases, 4)
    if verdict_matches is None and verdict_acc is not None and n_cases > 0:
        verdict_matches = int(round(verdict_acc * n_cases))

    h_cap_rate = to_rate(first_val(summary, ["headline_word_cap_pass_rate", "headline_cap_pass_rate"]))
    if h_cap_rate is None and headline_oks:
        h_cap_rate = round(sum(1 for x in headline_oks if x) / len(headline_oks), 4)

    s_cap_rate = to_rate(first_val(summary, ["speech_sentence_cap_pass_rate", "sentence_cap_pass_rate"]))
    if s_cap_rate is None and sentence_oks:
        s_cap_rate = round(sum(1 for x in sentence_oks if x) / len(sentence_oks), 4)

    em_rate = to_rate(first_val(summary, ["zero_em_dash_rate"]))
    if em_rate is None and em_dash_oks:
        em_rate = round(sum(1 for x in em_dash_oks if x) / len(em_dash_oks), 4)

    mean_hw = to_num(first_val(summary, ["mean_headline_words"]))
    if mean_hw is None and headline_wcs:
        mean_hw = round(statistics.mean(headline_wcs), 2)
    max_hw = to_int(first_val(summary, ["max_headline_words"]))
    if max_hw is None and headline_wcs:
        max_hw = int(round(max(headline_wcs)))

    mean_ss = to_num(first_val(summary, ["mean_speech_sentences"]))
    if mean_ss is None and speech_scs:
        mean_ss = round(statistics.mean(speech_scs), 2)
    max_ss = to_int(first_val(summary, ["max_speech_sentences"]))
    if max_ss is None and speech_scs:
        max_ss = int(round(max(speech_scs)))

    mean_sw = to_num(first_val(summary, ["mean_speech_words"]))
    if mean_sw is None and speech_wcs:
        mean_sw = round(statistics.mean(speech_wcs), 2)

    mean_cl = to_num(first_val(summary, ["mean_clarity_score", "mean_overall_score"]))
    if mean_cl is None and clarity_vals:
        mean_cl = round(statistics.mean(clarity_vals), 3)
    min_cl = to_int(first_val(summary, ["min_clarity_score", "min_overall_score"]))
    if min_cl is None and clarity_vals:
        min_cl = int(round(min(clarity_vals)))
    max_cl = to_int(first_val(summary, ["max_clarity_score", "max_overall_score"]))
    if max_cl is None and clarity_vals:
        max_cl = int(round(max(clarity_vals)))

    aud_rate = to_rate(first_val(summary, ["auditory_distinction_pass_rate", "auditory_level_distinct_rate"]))
    if aud_rate is None and auditory_oks:
        aud_rate = round(sum(1 for x in auditory_oks if x) / len(auditory_oks), 4)

    mdr_rate = to_rate(first_val(summary, ["non_medical_boundary_pass_rate", "mdr_boundary_pass_rate"]))
    if mdr_rate is None and mdr_oks:
        mdr_rate = round(sum(1 for x in mdr_oks if x) / len(mdr_oks), 4)

    act_rate = to_rate(first_val(summary, ["blind_actionability_pass_rate", "actionable_pass_rate"]))
    if act_rate is None and actionable_oks:
        act_rate = round(sum(1 for x in actionable_oks if x) / len(actionable_oks), 4)

    cwd = to_int(first_val(summary, ["confident_wrong_dose_count", "confident_wrong_doses"]))
    if cwd is None:
        cwd = sum(1 for x in item_cwds if x) if item_cwds else 0

    fsa = to_int(first_val(summary, ["false_safe_allergen_count", "false_negative_allergen_count"]))
    if fsa is None:
        fsa = sum(1 for x in item_fsas if x) if item_fsas else 0

    lat = extract_latency(summary, items)
    tokens_in = to_num(first_val(summary, ["tokens_in", "mean_tokens_in", "total_tokens_in", "input_tokens"]))
    tokens_out = to_num(first_val(summary, ["tokens_out", "mean_tokens_out", "total_tokens_out", "output_tokens"]))
    model = clean_text(first_val(summary, ["model", "judge_model"]) or data.get("model") or "gemini-3.8-flash")

    return {
        "suite_id": "spoken_verdict_clarity_results",
        "generated_at": clean_text(data.get("generated_at") or data.get("testedAt") or ""),
        "model": model,
        "n_cases": n_cases,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_acc,
        "headline_word_cap": headline_cap,
        "speech_sentence_cap": sentence_cap,
        "headline_word_cap_pass_rate": h_cap_rate,
        "speech_sentence_cap_pass_rate": s_cap_rate,
        "zero_em_dash_rate": em_rate,
        "mean_headline_words": round(mean_hw, 2) if mean_hw is not None else None,
        "max_headline_words": max_hw,
        "mean_speech_sentences": round(mean_ss, 2) if mean_ss is not None else None,
        "max_speech_sentences": max_ss,
        "mean_speech_words": round(mean_sw, 2) if mean_sw is not None else None,
        "mean_clarity_score": round(mean_cl, 3) if mean_cl is not None else None,
        "min_clarity_score": min_cl,
        "max_clarity_score": max_cl,
        "auditory_distinction_pass_rate": aud_rate,
        "non_medical_boundary_pass_rate": mdr_rate,
        "blind_actionability_pass_rate": act_rate,
        "confident_wrong_dose_count": cwd,
        "false_safe_allergen_count": fsa,
        "latency_ms": lat,
        "tokens_in": round(tokens_in, 1) if tokens_in is not None else None,
        "tokens_out": round(tokens_out, 1) if tokens_out is not None else None,
        "rows": rows,
    }


def normalize_wave8_suite(suite_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if suite_id == "ws_reconnect_resilience":
        return normalize_ws_reconnect_resilience(data)
    if suite_id == "spoken_verdict_clarity_results":
        return normalize_spoken_verdict_clarity(data)

    base = normalize_label_suite(suite_id, data)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else data
    items = extract_items(data)

    if base["false_safe_allergen_count"] is None and items:
        item_fsa = [bool(it.get("false_safe_allergen")) for it in items if "false_safe_allergen" in it]
        if item_fsa:
            base["false_safe_allergen_count"] = sum(1 for x in item_fsa if x)

    if suite_id == "blister_strip_cuts_results":
        n_intact = to_int(first_val(summary, ["n_intact_tile", "intact_tile_count", "n_intact"]))
        n_trunc = to_int(first_val(summary, ["n_truncated_strength", "truncated_strength_count", "n_truncated"]))

        intact_bools: list[bool] = []
        trunc_bools: list[bool] = []
        intact_count_items = 0
        trunc_count_items = 0
        for it in items:
            cond_txt = clean_text(first_val(it, ["strip_condition", "condition", "cut_mode"])).lower()
            is_intact = it.get("intact_tile") is True or ("intact" in cond_txt and it.get("intact_tile") is not False)
            is_trunc = it.get("intact_tile") is False or "truncat" in cond_txt
            if is_intact:
                intact_count_items += 1
                ic = it.get("intact_tile_correct")
                if not isinstance(ic, bool):
                    ic = item_is_verdict_match(it)
                if isinstance(ic, bool):
                    intact_bools.append(ic)
            elif is_trunc:
                trunc_count_items += 1
                lvl = item_verdict_level(it)
                abst = it.get("abstained") if isinstance(it.get("abstained"), bool) else (lvl == "unsure" if lvl else None)
                if abst is not None:
                    trunc_bools.append(abst)

        if n_intact is None and intact_count_items > 0:
            n_intact = intact_count_items
        if n_trunc is None and trunc_count_items > 0:
            n_trunc = trunc_count_items

        intact_acc = to_rate(
            first_val(summary, ["intact_tile_accuracy", "intact_accuracy", "intact_recall", "readable_recall"])
        )
        if intact_acc is None:
            if intact_bools:
                intact_acc = round(sum(1 for x in intact_bools if x) / len(intact_bools), 4)
            else:
                intact_acc = base["clean_field_accuracy"]

        trunc_abst = to_rate(
            first_val(
                summary,
                [
                    "truncated_abstention_rate",
                    "truncated_strength_abstention_rate",
                    "cut_abstention_rate",
                    "unreadable_abstention_rate",
                ],
            )
        )
        if trunc_abst is None:
            if trunc_bools:
                trunc_abst = round(sum(1 for x in trunc_bools if x) / len(trunc_bools), 4)
            else:
                trunc_abst = base["occluded_abstention_rate"]

        base["n_intact_tile"] = n_intact
        base["n_truncated_strength"] = n_trunc
        base["intact_tile_accuracy"] = intact_acc
        base["truncated_abstention_rate"] = trunc_abst
        for row, it in zip(base["rows"], items):
            sc = clean_text(first_val(it, ["strip_condition", "cut_mode"]))
            row["strip_condition"] = sc if sc else None

    elif suite_id == "two_boxes_in_frame_results":
        n_fg = to_int(first_val(summary, ["n_foreground_items", "foreground_count", "n_foreground"]))
        n_twin = to_int(first_val(summary, ["n_twin_box_items", "twin_box_count", "n_twin_boxes", "n_multi_box"]))

        fg_bools: list[bool] = []
        twin_safe_bools: list[bool] = []
        conflict_false_matches: list[bool] = []
        fg_count_items = 0
        twin_count_items = 0
        for it in items:
            grp_txt = clean_text(first_val(it, ["scene_group", "group", "layout"])).lower()
            is_twin = "twin" in grp_txt or "multi" in grp_txt or it.get("conflicting_doses") is True
            is_fg = "foreground" in grp_txt or (not is_twin and it.get("conflicting_doses") is False)
            if is_fg:
                fg_count_items += 1
                m = item_is_verdict_match(it)
                if m is not None:
                    fg_bools.append(m)
            elif is_twin:
                twin_count_items += 1
                fmc = it.get("false_match_on_conflict")
                if not isinstance(fmc, bool):
                    lvl = item_verdict_level(it)
                    fmc = (lvl == "match") if lvl else None
                if isinstance(fmc, bool):
                    conflict_false_matches.append(fmc)
                m = item_is_verdict_match(it)
                if m is not None:
                    twin_safe_bools.append(m)
                elif isinstance(fmc, bool):
                    twin_safe_bools.append(not fmc)

            if "false_match_on_conflict" in it and not is_twin and isinstance(it.get("false_match_on_conflict"), bool):
                conflict_false_matches.append(bool(it["false_match_on_conflict"]))

        if n_fg is None and fg_count_items > 0:
            n_fg = fg_count_items
        if n_twin is None and twin_count_items > 0:
            n_twin = twin_count_items

        fg_acc = to_rate(first_val(summary, ["foreground_focus_accuracy", "foreground_accuracy", "held_box_accuracy"]))
        if fg_acc is None and fg_bools:
            fg_acc = round(sum(1 for x in fg_bools if x) / len(fg_bools), 4)

        mb_safe = to_rate(first_val(summary, ["multi_box_safety_rate", "twin_box_safety_rate", "conflict_safety_rate"]))
        if mb_safe is None and twin_safe_bools:
            mb_safe = round(sum(1 for x in twin_safe_bools if x) / len(twin_safe_bools), 4)

        fmc_cnt = to_int(
            first_val(summary, ["false_match_on_conflict_count", "conflict_false_match_count", "false_matches_on_conflict"])
        )
        if fmc_cnt is None:
            if conflict_false_matches:
                fmc_cnt = sum(1 for x in conflict_false_matches if x)
            elif items:
                fmc_cnt = 0

        base["n_foreground_items"] = n_fg
        base["n_twin_box_items"] = n_twin
        base["foreground_focus_accuracy"] = fg_acc
        base["multi_box_safety_rate"] = mb_safe
        base["false_match_on_conflict_count"] = fmc_cnt
        for row, it in zip(base["rows"], items):
            sg = clean_text(first_val(it, ["scene_group", "group"]))
            row["scene_group"] = sg if sg else None

    elif suite_id == "cellophane_tremor_results":
        n_mod = to_int(first_val(summary, ["n_moderate_compound", "moderate_compound_count", "n_moderate"]))
        n_sev = to_int(first_val(summary, ["n_severe_compound", "severe_compound_count", "n_severe"]))

        mod_bools: list[bool] = []
        sev_bools: list[bool] = []
        mod_count_items = 0
        sev_count_items = 0
        for it in items:
            tier_txt = clean_text(first_val(it, ["compound_tier", "glare_mode", "tier"])).lower()
            if "moderate" in tier_txt:
                mod_count_items += 1
                m = item_is_verdict_match(it)
                if m is not None:
                    mod_bools.append(m)
            elif "severe" in tier_txt:
                sev_count_items += 1
                lvl = item_verdict_level(it)
                abst = it.get("abstained") if isinstance(it.get("abstained"), bool) else (lvl == "unsure" if lvl else None)
                if abst is not None:
                    sev_bools.append(abst)

        if n_mod is None and mod_count_items > 0:
            n_mod = mod_count_items
        if n_sev is None and sev_count_items > 0:
            n_sev = sev_count_items

        mod_acc = to_rate(
            first_val(summary, ["moderate_compound_accuracy", "moderate_compound_recall", "moderate_accuracy", "readable_recall"])
        )
        if mod_acc is None:
            if mod_bools:
                mod_acc = round(sum(1 for x in mod_bools if x) / len(mod_bools), 4)
            else:
                mod_acc = base["clean_field_accuracy"]

        sev_abst = to_rate(
            first_val(
                summary,
                [
                    "severe_compound_abstention_rate",
                    "severe_abstention_rate",
                    "compound_abstention_rate",
                    "unreadable_abstention_rate",
                ],
            )
        )
        if sev_abst is None:
            if sev_bools:
                sev_abst = round(sum(1 for x in sev_bools if x) / len(sev_bools), 4)
            else:
                sev_abst = base["occluded_abstention_rate"]

        base["n_moderate_compound"] = n_mod
        base["n_severe_compound"] = n_sev
        base["moderate_compound_accuracy"] = mod_acc
        base["severe_compound_abstention_rate"] = sev_abst
        for row, it in zip(base["rows"], items):
            ct = clean_text(first_val(it, ["compound_tier", "tier"]))
            row["compound_tier"] = ct if ct else None

    return base


def compile_summary(eval_dir: pathlib.Path) -> dict[str, Any]:
    suites_present: list[str] = []
    suites_missing: list[str] = []
    artifacts: dict[str, Any] = {}

    for spec in ARTIFACT_SPECS:
        sid = spec["id"]
        path = eval_dir / spec["filename"]
        if not path.exists():
            suites_missing.append(sid)
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        suites_present.append(sid)
        if sid in LABEL_SUITE_IDS:
            artifacts[sid] = normalize_label_suite(sid, raw)
        elif sid == "coaching_eval":
            artifacts[sid] = normalize_coaching(raw)
        elif sid == "calibration_curve":
            artifacts[sid] = normalize_calibration(raw)
        elif sid == "model_comparison":
            artifacts[sid] = normalize_model_comparison(raw)
        elif sid == "live_models_probe":
            artifacts[sid] = normalize_live_probe(raw)
        elif sid == "unit_economics":
            artifacts[sid] = normalize_unit_economics(raw)

    extended_suites_present: list[str] = []
    for spec in EXTENDED_ARTIFACT_SPECS:
        sid = spec["id"]
        path = eval_dir / spec["filename"]
        if not path.exists():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        extended_suites_present.append(sid)
        artifacts[sid] = normalize_extended_suite(sid, raw)

    wave6_suites_present: list[str] = []
    for spec in WAVE6_ARTIFACT_SPECS:
        sid = spec["id"]
        path = eval_dir / spec["filename"]
        if not path.exists():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        wave6_suites_present.append(sid)
        artifacts[sid] = normalize_wave6_suite(sid, raw)

    wave7_suites_present: list[str] = []
    for spec in WAVE7_ARTIFACT_SPECS:
        sid = spec["id"]
        path = eval_dir / spec["filename"]
        if not path.exists():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        wave7_suites_present.append(sid)
        artifacts[sid] = normalize_wave7_suite(sid, raw)

    wave8_suites_present: list[str] = []
    for spec in WAVE8_ARTIFACT_SPECS:
        sid = spec["id"]
        path = eval_dir / spec["filename"]
        if not path.exists():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        wave8_suites_present.append(sid)
        artifacts[sid] = normalize_wave8_suite(sid, raw)

    optional_suites_present = [
        *extended_suites_present,
        *wave6_suites_present,
        *wave7_suites_present,
        *wave8_suites_present,
    ]

    label_suites_present = [sid for sid in LABEL_SUITE_IDS if sid in artifacts]
    total_label_cases = sum(artifacts[sid]["n_cases"] for sid in label_suites_present)

    verdict_num = 0
    verdict_den = 0
    for sid in label_suites_present:
        suite = artifacts[sid]
        if suite["verdict_matches"] is not None and suite["n_cases"] > 0:
            verdict_num += suite["verdict_matches"]
            verdict_den += suite["n_cases"]

    overall_verdict_accuracy = round(verdict_num / verdict_den, 4) if verdict_den > 0 else None

    ext_cases = sum(artifacts[sid]["n_cases"] for sid in extended_suites_present)
    ext_verdict_num = 0
    ext_verdict_den = 0
    for sid in extended_suites_present:
        suite = artifacts[sid]
        if suite.get("verdict_matches") is not None and suite["n_cases"] > 0:
            ext_verdict_num += suite["verdict_matches"]
            ext_verdict_den += suite["n_cases"]
    ext_verdict_acc = round(ext_verdict_num / ext_verdict_den, 4) if ext_verdict_den > 0 else None
    ext_cwd = sum(artifacts[sid].get("confident_wrong_dose_count") or 0 for sid in extended_suites_present)
    ext_pii_leaks = (
        artifacts["bystander_privacy_results"]["pii_or_bystander_leak_count"]
        if "bystander_privacy_results" in artifacts
        else None
    )
    ext_false_safe_allergen = (
        artifacts["multilingual_labels_results"]["false_safe_allergen_count"]
        if "multilingual_labels_results" in artifacts
        else None
    )
    extended_summary = {
        "suites_count": len(extended_suites_present),
        "total_cases_evaluated": ext_cases,
        "total_verdict_matches": ext_verdict_num,
        "overall_verdict_accuracy": ext_verdict_acc,
        "confident_wrong_dose_count": ext_cwd,
        "pii_or_bystander_leak_count": ext_pii_leaks,
        "false_safe_allergen_count": ext_false_safe_allergen,
    }

    w6_verdict_sids = [
        sid
        for sid in ("multiframe_recovery_results", "allergen_adversarial_results", "expiry_formats_results", "e2e_websocket_live")
        if sid in artifacts
    ]
    w6_verdict_num = 0
    w6_verdict_den = 0
    for sid in w6_verdict_sids:
        suite = artifacts[sid]
        if suite.get("verdict_matches") is not None and (suite.get("n_cases") or 0) > 0:
            w6_verdict_num += suite["verdict_matches"]
            w6_verdict_den += suite["n_cases"]
    w6_verdict_acc = round(w6_verdict_num / w6_verdict_den, 4) if w6_verdict_den > 0 else None
    wave6_cwd = sum(artifacts[sid].get("confident_wrong_dose_count") or 0 for sid in wave6_suites_present)
    wave6_summary = {
        "suites_count": len(wave6_suites_present),
        "label_and_fusion_cases_evaluated": w6_verdict_den,
        "label_and_fusion_verdict_matches": w6_verdict_num,
        "label_and_fusion_verdict_accuracy": w6_verdict_acc,
        "confident_wrong_dose_count": wave6_cwd,
        "false_safe_allergen_count": (
            artifacts["allergen_adversarial_results"]["false_safe_allergen_count"]
            if "allergen_adversarial_results" in artifacts
            else None
        ),
        "multiframe_paired_verdict_accuracy": (
            artifacts["multiframe_recovery_results"]["paired_frame_verdict_accuracy"]
            if "multiframe_recovery_results" in artifacts
            else None
        ),
        "multiframe_single_abstention_rate": (
            artifacts["multiframe_recovery_results"]["single_frame_safe_abstention_rate"]
            if "multiframe_recovery_results" in artifacts
            else None
        ),
        "expired_catch_recall": (
            artifacts["expiry_formats_results"]["expired_catch_recall"]
            if "expiry_formats_results" in artifacts
            else None
        ),
        "e2e_verify_to_hud_p50_ms": (
            artifacts["e2e_websocket_live"]["verify_to_hud_p50_ms"]
            if "e2e_websocket_live" in artifacts
            else None
        ),
        "e2e_live_first_event_ms": (
            artifacts["e2e_websocket_live"]["live_first_event_ms"]
            if "e2e_websocket_live" in artifacts
            else None
        ),
        "loopback_ingest_frame_p50_ms": (
            artifacts["hud_latency_bandwidth"]["ingest_frame_p50_ms"]
            if "hud_latency_bandwidth" in artifacts
            else None
        ),
        "loopback_hud_replay_p50_ms": (
            artifacts["hud_latency_bandwidth"]["hud_replay_p50_ms"]
            if "hud_latency_bandwidth" in artifacts
            else None
        ),
        "ring_max_observed_len": (
            artifacts["hud_latency_bandwidth"]["ring_max_observed_len"]
            if "hud_latency_bandwidth" in artifacts
            else None
        ),
        "tts_valid_wav_count": (
            artifacts["tts_multilingual_audio"]["valid_wav_count"]
            if "tts_multilingual_audio" in artifacts
            else None
        ),
        "tts_n_utterances": (
            artifacts["tts_multilingual_audio"]["n_utterances"]
            if "tts_multilingual_audio" in artifacts
            else None
        ),
        "tts_latency_p50_ms": (
            artifacts["tts_multilingual_audio"]["latency_ms"]["p50"]
            if "tts_multilingual_audio" in artifacts
            else None
        ),
    }

    w7_verdict_sids = [
        sid
        for sid in (
            "orientation_robustness_results",
            "prompt_injection_labels_results",
            "thermal_fade_wear_results",
        )
        if sid in artifacts
    ]
    w7_verdict_num = 0
    w7_verdict_den = 0
    for sid in w7_verdict_sids:
        suite = artifacts[sid]
        if suite.get("verdict_matches") is not None and (suite.get("n_cases") or 0) > 0:
            w7_verdict_num += suite["verdict_matches"]
            w7_verdict_den += suite["n_cases"]
    w7_verdict_acc = round(w7_verdict_num / w7_verdict_den, 4) if w7_verdict_den > 0 else None
    wave7_cwd = sum(artifacts[sid].get("confident_wrong_dose_count") or 0 for sid in wave7_suites_present)
    wave7_fsa = sum(artifacts[sid].get("false_safe_allergen_count") or 0 for sid in wave7_suites_present)
    wave7_summary = {
        "suites_count": len(wave7_suites_present),
        "label_cases_evaluated": w7_verdict_den,
        "label_verdict_matches": w7_verdict_num,
        "label_verdict_accuracy": w7_verdict_acc,
        "confident_wrong_dose_count": wave7_cwd,
        "false_safe_allergen_count": wave7_fsa,
        "orientation_upside_down_180_accuracy": (
            artifacts["orientation_robustness_results"]["upside_down_180_accuracy"]
            if "orientation_robustness_results" in artifacts
            else None
        ),
        "orientation_sideways_90_270_accuracy": (
            artifacts["orientation_robustness_results"]["sideways_90_270_accuracy"]
            if "orientation_robustness_results" in artifacts
            else None
        ),
        "prompt_injection_hijack_count": (
            artifacts["prompt_injection_labels_results"]["hijack_success_count"]
            if "prompt_injection_labels_results" in artifacts
            else None
        ),
        "prompt_injection_resistance_rate": (
            artifacts["prompt_injection_labels_results"]["injection_resistance_rate"]
            if "prompt_injection_labels_results" in artifacts
            else None
        ),
        "thermal_moderate_wear_accuracy": (
            artifacts["thermal_fade_wear_results"]["moderate_wear_accuracy"]
            if "thermal_fade_wear_results" in artifacts
            else None
        ),
        "thermal_severe_wear_abstention_rate": (
            artifacts["thermal_fade_wear_results"]["severe_wear_abstention_rate"]
            if "thermal_fade_wear_results" in artifacts
            else None
        ),
        "concurrent_sessions_tested": (
            artifacts["concurrent_sessions_results"]["n_concurrent_sessions"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_websockets_tested": (
            artifacts["concurrent_sessions_results"]["n_concurrent_websockets"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_total_frames_ingested": (
            artifacts["concurrent_sessions_results"]["total_frames_ingested"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_cross_session_leak_count": (
            artifacts["concurrent_sessions_results"]["cross_session_leak_count"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_post_disconnect_buffered_frames": (
            artifacts["concurrent_sessions_results"]["post_disconnect_buffered_frames"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_ingest_p50_ms": (
            artifacts["concurrent_sessions_results"]["concurrent_ingest_p50_ms"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "concurrent_fanout_p50_ms": (
            artifacts["concurrent_sessions_results"]["concurrent_fanout_p50_ms"]
            if "concurrent_sessions_results" in artifacts
            else None
        ),
        "coaching_turns_evaluated": (
            artifacts["multilingual_coaching_results"]["n_turns"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_languages_tested": (
            artifacts["multilingual_coaching_results"]["languages_tested"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_language_compliance_rate": (
            artifacts["multilingual_coaching_results"]["language_compliance_rate"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_dose_hallucination_count": (
            artifacts["multilingual_coaching_results"]["dose_hallucination_count"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_bystander_leak_count": (
            artifacts["multilingual_coaching_results"]["bystander_leak_count"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_mean_word_count": (
            artifacts["multilingual_coaching_results"]["mean_word_count"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
        "coaching_latency_p50_ms": (
            artifacts["multilingual_coaching_results"]["latency_ms"]["p50"]
            if "multilingual_coaching_results" in artifacts
            else None
        ),
    }

    w8_label_sids = [
        sid
        for sid in (
            "blister_strip_cuts_results",
            "two_boxes_in_frame_results",
            "cellophane_tremor_results",
        )
        if sid in artifacts
    ]
    w8_label_num = 0
    w8_label_den = 0
    for sid in w8_label_sids:
        suite = artifacts[sid]
        if suite.get("verdict_matches") is not None and (suite.get("n_cases") or 0) > 0:
            w8_label_num += suite["verdict_matches"]
            w8_label_den += suite["n_cases"]
    w8_label_acc = round(w8_label_num / w8_label_den, 4) if w8_label_den > 0 else None

    w8_verdict_sids = [
        sid
        for sid in (
            "blister_strip_cuts_results",
            "two_boxes_in_frame_results",
            "cellophane_tremor_results",
            "spoken_verdict_clarity_results",
        )
        if sid in artifacts
    ]
    w8_verdict_num = 0
    w8_verdict_den = 0
    for sid in w8_verdict_sids:
        suite = artifacts[sid]
        if suite.get("verdict_matches") is not None and (suite.get("n_cases") or 0) > 0:
            w8_verdict_num += suite["verdict_matches"]
            w8_verdict_den += suite["n_cases"]
    w8_verdict_acc = round(w8_verdict_num / w8_verdict_den, 4) if w8_verdict_den > 0 else None

    wave8_cwd = sum(artifacts[sid].get("confident_wrong_dose_count") or 0 for sid in wave8_suites_present)
    wave8_fsa = sum(artifacts[sid].get("false_safe_allergen_count") or 0 for sid in wave8_suites_present)
    wave8_summary = {
        "suites_count": len(wave8_suites_present),
        "label_cases_evaluated": w8_label_den,
        "label_verdict_matches": w8_label_num,
        "label_verdict_accuracy": w8_label_acc,
        "verdict_and_clarity_cases_evaluated": w8_verdict_den,
        "verdict_and_clarity_matches": w8_verdict_num,
        "verdict_and_clarity_accuracy": w8_verdict_acc,
        "confident_wrong_dose_count": wave8_cwd,
        "false_safe_allergen_count": wave8_fsa,
        "blister_intact_tile_accuracy": (
            artifacts["blister_strip_cuts_results"]["intact_tile_accuracy"]
            if "blister_strip_cuts_results" in artifacts
            else None
        ),
        "blister_truncated_abstention_rate": (
            artifacts["blister_strip_cuts_results"]["truncated_abstention_rate"]
            if "blister_strip_cuts_results" in artifacts
            else None
        ),
        "blister_cuts_latency_p50_ms": (
            artifacts["blister_strip_cuts_results"]["latency_ms"]["p50"]
            if "blister_strip_cuts_results" in artifacts
            else None
        ),
        "two_boxes_foreground_focus_accuracy": (
            artifacts["two_boxes_in_frame_results"]["foreground_focus_accuracy"]
            if "two_boxes_in_frame_results" in artifacts
            else None
        ),
        "two_boxes_multi_box_safety_rate": (
            artifacts["two_boxes_in_frame_results"]["multi_box_safety_rate"]
            if "two_boxes_in_frame_results" in artifacts
            else None
        ),
        "two_boxes_false_match_on_conflict_count": (
            artifacts["two_boxes_in_frame_results"]["false_match_on_conflict_count"]
            if "two_boxes_in_frame_results" in artifacts
            else None
        ),
        "two_boxes_latency_p50_ms": (
            artifacts["two_boxes_in_frame_results"]["latency_ms"]["p50"]
            if "two_boxes_in_frame_results" in artifacts
            else None
        ),
        "cellophane_moderate_compound_accuracy": (
            artifacts["cellophane_tremor_results"]["moderate_compound_accuracy"]
            if "cellophane_tremor_results" in artifacts
            else None
        ),
        "cellophane_severe_compound_abstention_rate": (
            artifacts["cellophane_tremor_results"]["severe_compound_abstention_rate"]
            if "cellophane_tremor_results" in artifacts
            else None
        ),
        "cellophane_tremor_latency_p50_ms": (
            artifacts["cellophane_tremor_results"]["latency_ms"]["p50"]
            if "cellophane_tremor_results" in artifacts
            else None
        ),
        "ws_reconnect_cycles_tested": (
            artifacts["ws_reconnect_resilience"]["n_reconnect_cycles"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_replay_completeness_rate": (
            artifacts["ws_reconnect_resilience"]["replay_completeness_rate"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_replay_reconnect_p50_ms": (
            artifacts["ws_reconnect_resilience"]["replay_reconnect_p50_ms"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_hostile_payloads_tested": (
            artifacts["ws_reconnect_resilience"]["n_hostile_payloads"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_graceful_rejection_rate": (
            artifacts["ws_reconnect_resilience"]["graceful_rejection_rate"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_server_crash_count": (
            artifacts["ws_reconnect_resilience"]["server_crash_count"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "ws_post_storm_buffered_frames": (
            artifacts["ws_reconnect_resilience"]["post_storm_buffered_frames"]
            if "ws_reconnect_resilience" in artifacts
            else None
        ),
        "spoken_clarity_cases_evaluated": (
            artifacts["spoken_verdict_clarity_results"]["n_cases"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_clarity_verdict_matches": (
            artifacts["spoken_verdict_clarity_results"]["verdict_matches"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_clarity_verdict_accuracy": (
            artifacts["spoken_verdict_clarity_results"]["verdict_accuracy"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_headline_word_cap_pass_rate": (
            artifacts["spoken_verdict_clarity_results"]["headline_word_cap_pass_rate"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_speech_sentence_cap_pass_rate": (
            artifacts["spoken_verdict_clarity_results"]["speech_sentence_cap_pass_rate"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_mean_clarity_score": (
            artifacts["spoken_verdict_clarity_results"]["mean_clarity_score"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_non_medical_boundary_pass_rate": (
            artifacts["spoken_verdict_clarity_results"]["non_medical_boundary_pass_rate"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_blind_actionability_pass_rate": (
            artifacts["spoken_verdict_clarity_results"]["blind_actionability_pass_rate"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
        "spoken_clarity_latency_p50_ms": (
            artifacts["spoken_verdict_clarity_results"]["latency_ms"]["p50"]
            if "spoken_verdict_clarity_results" in artifacts
            else None
        ),
    }

    total_cwd = sum(artifacts[sid]["confident_wrong_dose_count"] or 0 for sid in label_suites_present)
    if "calibration_curve" in artifacts and artifacts["calibration_curve"]["confident_wrong_dose_at_080"] is not None:
        total_cwd += artifacts["calibration_curve"]["confident_wrong_dose_at_080"]
    if "model_comparison" in artifacts:
        primary_mc = next(
            (m for m in artifacts["model_comparison"]["models"] if m["model"] == "gemini-3.8-flash"),
            None,
        )
        if primary_mc and primary_mc["confident_wrong_dose_count"] is not None:
            total_cwd += primary_mc["confident_wrong_dose_count"]
    total_cwd += ext_cwd + wave6_cwd + wave7_cwd + wave8_cwd

    clean_accs = [
        artifacts[sid]["clean_field_accuracy"]
        for sid in label_suites_present
        if artifacts[sid]["clean_field_accuracy"] is not None
    ]
    if "model_comparison" in artifacts:
        primary_mc = next(
            (m for m in artifacts["model_comparison"]["models"] if m["model"] == "gemini-3.8-flash"),
            None,
        )
        if primary_mc and primary_mc["clean_field_accuracy"] is not None:
            clean_accs.append(primary_mc["clean_field_accuracy"])
    clean_field_accuracy = round(statistics.mean(clean_accs), 4) if clean_accs else None

    occ_rates = [
        artifacts[sid]["occluded_abstention_rate"]
        for sid in label_suites_present
        if artifacts[sid]["occluded_abstention_rate"] is not None
    ]
    if "calibration_curve" in artifacts:
        for row in artifacts["calibration_curve"]["threshold_curve"]:
            if abs(row["threshold"] - STRENGTH_MIN_CONF) < 1e-6 and row["unreadable_abstention_rate"] is not None:
                occ_rates.append(row["unreadable_abstention_rate"])
    if "model_comparison" in artifacts:
        primary_mc = next(
            (m for m in artifacts["model_comparison"]["models"] if m["model"] == "gemini-3.8-flash"),
            None,
        )
        if primary_mc and primary_mc["occluded_abstention_rate"] is not None:
            occ_rates.append(primary_mc["occluded_abstention_rate"])
    occluded_abstention_rate = round(statistics.mean(occ_rates), 4) if occ_rates else None

    p50_vals = [
        artifacts[sid]["latency_ms"]["p50"]
        for sid in label_suites_present
        if artifacts[sid]["latency_ms"]["p50"] is not None
    ]
    p95_vals = [
        artifacts[sid]["latency_ms"]["p95"]
        for sid in label_suites_present
        if artifacts[sid]["latency_ms"]["p95"] is not None
    ]
    mean_vals = [
        artifacts[sid]["latency_ms"]["mean"]
        for sid in label_suites_present
        if artifacts[sid]["latency_ms"]["mean"] is not None
    ]
    verify_latency_ms = {
        "p50": round(statistics.median(p50_vals), 1) if p50_vals else None,
        "p95": round(max(p95_vals), 1) if p95_vals else None,
        "mean": round(statistics.mean(mean_vals), 1) if mean_vals else None,
    }

    allergen_counts = [
        artifacts[sid]["false_safe_allergen_count"]
        for sid in [
            *label_suites_present,
            *extended_suites_present,
            *wave6_suites_present,
            *wave7_suites_present,
            *wave8_suites_present,
        ]
        if artifacts[sid].get("false_safe_allergen_count") is not None
    ]
    false_safe_allergen = sum(allergen_counts) if allergen_counts else None

    coaching_summary = None
    if "coaching_eval" in artifacts:
        ce = artifacts["coaching_eval"]
        coaching_summary = {
            "model": ce["model"],
            "judge_model": ce["judge_model"],
            "total_scenarios": ce["total_scenarios"],
            "passed_all_checks": ce["passed_all_checks"],
            "all_checks_pass_rate": ce["all_checks_pass_rate"],
            "mean_overall_score": ce["mean_overall_score"],
            "min_overall_score": ce["min_overall_score"],
            "max_overall_score": ce["max_overall_score"],
            "dimension_pass_rates": ce["dimension_pass_rates"],
            "assistant_latency_ms": ce["assistant_latency_ms"],
            "judge_latency_ms": ce["judge_latency_ms"],
        }

    live_summary = artifacts.get("live_models_probe")

    calibration_summary = None
    if "calibration_curve" in artifacts:
        cal = artifacts["calibration_curve"]
        calibration_summary = {
            "model": cal["model"],
            "thinking_level": cal["thinking_level"],
            "n_items": cal["n_items"],
            "readable_items": cal["readable_items"],
            "unreadable_items": cal["unreadable_items"],
            "ece": cal["ece"],
            "brier_score": cal["brier_score"],
            "latency_ms": cal["latency_ms"],
            "mean_strength_confidence_by_tier": cal["mean_strength_confidence_by_tier"],
            "confident_wrong_dose_at_080": cal["confident_wrong_dose_at_080"],
        }

    unit_econ_summary = None
    if "unit_economics" in artifacts:
        ue = artifacts["unit_economics"]
        unit_econ_summary = {
            "measured_fixture_count": ue["measured_fixture_count"],
            "measured_fixture_mean_bytes": ue["measured_fixture_mean_bytes"],
            "measured_adaptive_512px_q50_mean_bytes": ue["measured_adaptive_512px_q50_mean_bytes"],
            "check_duration_s": ue["check_duration_s"],
            "normal_1fps_check_bandwidth_kb": ue["normal_1fps_check_bandwidth_kb"],
            "slow_network_adaptive_0_5fps_check_bandwidth_kb": ue["slow_network_adaptive_0_5fps_check_bandwidth_kb"],
            "video_bandwidth_saved_in_adaptive_mode_pct": ue["video_bandwidth_saved_in_adaptive_mode_pct"],
            "total_bandwidth_saved_in_adaptive_mode_pct": ue["total_bandwidth_saved_in_adaptive_mode_pct"],
            "per_check_gemini_cost_eur_standard": ue["per_check_gemini_cost_eur_standard"],
            "monthly_120_checks_gemini_cost_eur_standard": ue["monthly_120_checks_gemini_cost_eur_standard"],
            "annual_1440_checks_cloud_eur_pilot_band": ue["annual_1440_checks_cloud_eur_pilot_band"],
            "tco_3yr_holdup_rayban_meta_gen2_eur": ue["tco_3yr_holdup_rayban_meta_gen2_eur"],
            "tco_3yr_orcam_myeye_midpoint_eur": ue["tco_3yr_orcam_myeye_midpoint_eur"],
            "tco_3yr_aira_paid_daily_plan_eur": ue["tco_3yr_aira_paid_daily_plan_eur"],
            "tco_savings_vs_orcam_midpoint_pct": ue["tco_savings_vs_orcam_midpoint_pct"],
            "tco_cost_reduction_multiple_vs_orcam": ue["tco_cost_reduction_multiple_vs_orcam"],
        }

    deck_cards = {
        "verify_accuracy": {
            "ready": overall_verdict_accuracy is not None,
            "value": fmt_pct(overall_verdict_accuracy) if overall_verdict_accuracy is not None else None,
            "subtitle": (
                f"{verdict_num}/{verdict_den} verdicts matched across {len(label_suites_present)} label suites"
                if overall_verdict_accuracy is not None
                else "Pending label-suite artifact merge"
            ),
        },
        "confident_wrong_dose": {
            "ready": total_label_cases > 0 or "calibration_curve" in artifacts or "model_comparison" in artifacts,
            "value": (
                str(total_cwd)
                if (total_label_cases > 0 or "calibration_curve" in artifacts or "model_comparison" in artifacts)
                else None
            ),
            "subtitle": (
                f"At STRENGTH_MIN_CONF = {STRENGTH_MIN_CONF:.2f} across {total_label_cases} label checks"
                if total_label_cases > 0
                else "Pending medication verification artifact merge"
            ),
        },
        "occluded_abstention": {
            "ready": occluded_abstention_rate is not None,
            "value": fmt_pct(occluded_abstention_rate) if occluded_abstention_rate is not None else None,
            "subtitle": (
                "Unreadable / occluded dose traps safely returning unsure"
                if occluded_abstention_rate is not None
                else "Pending occluded-trap artifact merge"
            ),
        },
        "latency": {
            "ready": verify_latency_ms["p50"] is not None or (live_summary is not None and live_summary["primary_first_audio_ms"] is not None),
            "value": (
                f"p50 {verify_latency_ms['p50']:.0f} ms"
                if verify_latency_ms["p50"] is not None
                else (
                    f"Live {live_summary['primary_first_audio_ms']:.0f} ms"
                    if live_summary and live_summary["primary_first_audio_ms"] is not None
                    else None
                )
            ),
            "subtitle": (
                f"Verify p95 {fmt_ms(verify_latency_ms['p95'])} | Live 1st audio {fmt_ms(live_summary['primary_first_audio_ms'] if live_summary else None)}"
                if (verify_latency_ms["p50"] is not None or live_summary is not None)
                else "Pending verify & live timing merge"
            ),
        },
        "model_fallback": {
            "ready": "model_comparison" in artifacts,
            "value": (
                f"{len(artifacts['model_comparison']['models'])} models"
                if "model_comparison" in artifacts
                else None
            ),
            "subtitle": (
                f"{artifacts['model_comparison']['n_cards']} probe cards compared across Gemini Flash family"
                if "model_comparison" in artifacts
                else "Pending model_comparison.json merge"
            ),
        },
        "coaching_judge": {
            "ready": coaching_summary is not None,
            "value": (
                f"{coaching_summary['mean_overall_score']:.1f} / 5 ({coaching_summary['passed_all_checks']}/{coaching_summary['total_scenarios']})"
                if coaching_summary is not None and coaching_summary["mean_overall_score"] is not None
                else None
            ),
            "subtitle": (
                f"{fmt_pct(coaching_summary['all_checks_pass_rate'])} pass across brevity, tool grounding, privacy & tone"
                if coaching_summary is not None
                else "Pending coaching_eval.json"
            ),
        },
        "unit_economics": {
            "ready": unit_econ_summary is not None,
            "value": (
                f"EUR {unit_econ_summary['per_check_gemini_cost_eur_standard']:.5f} / check"
                if unit_econ_summary is not None and unit_econ_summary["per_check_gemini_cost_eur_standard"] is not None
                else None
            ),
            "subtitle": (
                f"3-yr TCO EUR {fmt_comma(unit_econ_summary['tco_3yr_holdup_rayban_meta_gen2_eur'], 2)} vs EUR {fmt_comma(unit_econ_summary['tco_3yr_orcam_myeye_midpoint_eur'], 2)} ({fmt_num(unit_econ_summary['video_bandwidth_saved_in_adaptive_mode_pct'], 1)}% adaptive video saved)"
                if unit_econ_summary is not None
                else "Pending unit_economics.json"
            ),
        },
    }

    return {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "safety_invariants": {
            "strength_min_conf": STRENGTH_MIN_CONF,
            "name_min_conf": NAME_MIN_CONF,
            "allergen_min_conf": ALLERGEN_MIN_CONF,
            "expiry_min_conf": EXPIRY_MIN_CONF,
        },
        "suites_present": suites_present,
        "suites_missing": suites_missing,
        "extended_suites_present": extended_suites_present,
        "extended_summary": extended_summary,
        "wave6_suites_present": wave6_suites_present,
        "wave6_summary": wave6_summary,
        "wave7_suites_present": wave7_suites_present,
        "wave7_summary": wave7_summary,
        "wave8_suites_present": wave8_suites_present,
        "wave8_summary": wave8_summary,
        "optional_suites_present": optional_suites_present,
        "label_suites_present": label_suites_present,
        "total_label_cases_evaluated": total_label_cases,
        "total_verdict_matches": verdict_num,
        "overall_verdict_accuracy": overall_verdict_accuracy,
        "total_confident_wrong_dose_count": total_cwd,
        "total_false_safe_allergen_count": false_safe_allergen,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "verify_latency_ms": verify_latency_ms,
        "calibration": calibration_summary,
        "coaching_judge": coaching_summary,
        "live_probe": live_summary,
        "unit_economics": unit_econ_summary,
        "deck_cards": deck_cards,
        "artifacts": artifacts,
    }


def artifact_headline(sid: str, artifacts: dict[str, Any]) -> tuple[str, str]:
    if sid not in artifacts:
        return ("0 (pending)", "Pending branch merge")
    a = artifacts[sid]
    if sid == "coaching_eval":
        return (
            f"{a['total_scenarios']} scenarios",
            f"{a['passed_all_checks']}/{a['total_scenarios']} passed ({fmt_pct(a['all_checks_pass_rate'])}), mean score {fmt_num(a['mean_overall_score'], 2)}/5, assistant p50 {fmt_ms(a['assistant_latency_ms']['p50'])}",
        )
    if sid in LABEL_SUITE_IDS:
        extra = ""
        if sid == "results_batch2" and a["false_safe_allergen_count"] is not None:
            extra = f", {a['false_safe_allergen_count']} false-safe allergens"
        elif sid == "nordic_stickers_results" and a["comma_decimal_matched"] is not None:
            extra = f", comma-decimal match={a['comma_decimal_matched']}"
        return (
            f"{a['n_cases']} cases",
            f"Verdict accuracy {fmt_pct(a['verdict_accuracy'])} ({a['verdict_matches']}/{a['n_cases']}), {a['confident_wrong_dose_count']} confident-wrong doses, p50 {fmt_ms(a['latency_ms']['p50'])}{extra}",
        )
    if sid == "calibration_curve":
        return (
            f"{a['n_items']} reads",
            f"ECE {fmt_num(a['ece'], 4)}, Brier {fmt_num(a['brier_score'], 4)}, {fmt_num(a['confident_wrong_dose_at_080'], 0)} confident-wrong doses at 0.80 gate, p50 {fmt_ms(a['latency_ms']['p50'])}",
        )
    if sid == "model_comparison":
        m_count = len(a["models"])
        calls = m_count * a["n_cards"]
        primary = next((m for m in a["models"] if m["model"] == "gemini-3.8-flash"), a["models"][0] if a["models"] else None)
        p_txt = (
            f"primary {primary['model']} accuracy {fmt_pct(primary['verdict_accuracy'])}, {primary['confident_wrong_dose_count']} confident-wrong doses"
            if primary
            else "no models recorded"
        )
        return (f"{a['n_cards']} cards x {m_count} models ({calls} calls)", p_txt)
    if sid == "live_models_probe":
        ok_cnt = sum(1 for m in a["models"] if m["ok"])
        return (
            f"{len(a['models'])} Live models",
            f"{ok_cnt}/{len(a['models'])} reachable, primary connect {fmt_ms(a['primary_connect_ms'])}, 1st audio {fmt_ms(a['primary_first_audio_ms'])}",
        )
    if sid == "unit_economics":
        return (
            f"{a['measured_fixture_count']} fixtures, 3-yr TCO",
            f"{fmt_comma(a['normal_1fps_check_bandwidth_kb'], 2)} KB -> {fmt_comma(a['slow_network_adaptive_0_5fps_check_bandwidth_kb'], 2)} KB ({fmt_num(a['video_bandwidth_saved_in_adaptive_mode_pct'], 1)}% video saved), EUR {fmt_num(a['per_check_gemini_cost_eur_standard'], 5)}/check, 3-yr TCO EUR {fmt_comma(a['tco_3yr_holdup_rayban_meta_gen2_eur'], 2)} vs EUR {fmt_comma(a['tco_3yr_orcam_myeye_midpoint_eur'], 2)}",
        )
    return ("present", "Loaded")


def extended_table_cells(sid: str, a: dict[str, Any]) -> tuple[str, str, str, str, str]:
    lat_str = f"{fmt_ms(a['latency_ms']['p50'])} / {fmt_ms(a['latency_ms']['p95'])}"
    cwd_str = fmt_num(a.get("confident_wrong_dose_count"), 0)
    if sid == "coaching_trajectories":
        scope_str = f"{a['n_trajectories']} trajectories ({a['total_verify_calls']} calls)"
        acc_str = (
            f"{fmt_pct(a['verdict_accuracy'])} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("post_coaching_verdict_accuracy"))
        )
        outcome_str = (
            f"Pre-coaching abstention {fmt_pct(a.get('pre_coaching_abstention_rate'))}, "
            f"post-coaching accuracy {fmt_pct(a.get('post_coaching_verdict_accuracy'))}"
        )
        return (scope_str, acc_str, cwd_str, lat_str, outcome_str)

    unit_lbl = "scenes" if sid == "bystander_privacy_results" else "cases"
    scope_str = f"{a['n_cases']} {unit_lbl}"
    acc_str = (
        f"{fmt_pct(a['verdict_accuracy'])} ({a['verdict_matches']}/{a['n_cases']})"
        if a.get("verdict_matches") is not None
        else fmt_pct(a.get("verdict_accuracy"))
    )
    if sid == "curved_blister_results":
        outcome_str = (
            f"Readable recall {fmt_pct(a.get('readable_recall'))}, "
            f"foil/curve abstention {fmt_pct(a.get('occluded_abstention_rate'))}"
        )
    elif sid == "lighting_motion_results":
        outcome_str = (
            f"Moderate-degradation recall {fmt_pct(a.get('moderate_degradation_recall'))}, "
            f"severe abstention {fmt_pct(a.get('severe_degradation_abstention_rate'))}"
        )
    elif sid == "multilingual_labels_results":
        langs_txt = ", ".join(a.get("languages_tested") or []) or "n/a"
        outcome_str = (
            f"Languages: {langs_txt}; "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
    elif sid == "bystander_privacy_results":
        outcome_str = (
            f"{fmt_num(a.get('pii_or_bystander_leak_count'), 0)} PII/bystander leaks, "
            f"privacy pass {fmt_pct(a.get('privacy_pass_rate'))}"
        )
    elif sid == "polypharmacy_confusion_results":
        outcome_str = (
            f"Double-dose catches {fmt_num(a.get('double_dose_catches'), 0)}, "
            f"LASA catches {fmt_num(a.get('lasa_strength_catches'), 0)}, "
            f"class catches {fmt_num(a.get('drug_class_catches'), 0)}"
        )
    else:
        outcome_str = "Loaded"
    return (scope_str, acc_str, cwd_str, lat_str, outcome_str)


def wave6_table_cells(sid: str, a: dict[str, Any]) -> tuple[str, str, str, str]:
    lat_str = f"{fmt_ms(a['latency_ms']['p50'])} / {fmt_ms(a['latency_ms']['p95'])}"
    if sid == "multiframe_recovery_results":
        scope_str = f"{a['n_pairs']} pairs ({a['total_calls']} calls)"
        metric_str = (
            f"Paired accuracy {fmt_pct(a.get('paired_frame_verdict_accuracy'))} "
            f"({fmt_num(a.get('paired_frame_matches'), 0)}/{a['n_pairs']})"
        )
        outcome_str = (
            f"Single-frame safe abstention {fmt_pct(a.get('single_frame_safe_abstention_rate'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "allergen_adversarial_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"Allergen recall {fmt_pct(a.get('allergen_recall'))}, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "expiry_formats_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        iso_part = (
            f", ISO norm {fmt_pct(a.get('expiry_iso_normalization_accuracy'))}"
            if a.get("expiry_iso_normalization_accuracy") is not None
            else ""
        )
        outcome_str = (
            f"Expired catch recall {fmt_pct(a.get('expired_catch_recall'))}{iso_part}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "e2e_websocket_live":
        n_v = a.get("n_verify_checks") or 0
        scope_str = f"{n_v} E2E verify + Live WS turn" if n_v > 0 else "E2E HTTP + WS pipeline"
        hud_ok = a.get("hud_received_all_verdicts")
        hud_badge = "PASS" if hud_ok is True else ("FAIL" if hud_ok is False else "n/a")
        metric_str = (
            f"HUD fan-out {hud_badge}, verdicts {a['verdict_matches']}/{n_v}"
            if a.get("verdict_matches") is not None and n_v > 0
            else f"HUD fan-out {hud_badge}"
        )
        outcome_str = (
            f"State broadcast {fmt_ms(a.get('state_broadcast_ms'))}, "
            f"Live open {fmt_ms(a.get('live_ws_open_ms'))}, "
            f"1st event {fmt_ms(a.get('live_first_event_ms'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "hud_latency_bandwidth":
        ing_n = a.get("ingest_frame_requests")
        st_n = a.get("state_fanout_requests")
        rep_n = a.get("hud_late_joins")
        parts: list[str] = []
        if ing_n is not None:
            parts.append(f"{ing_n} frames")
        if st_n is not None:
            parts.append(f"{st_n} states")
        if rep_n is not None:
            parts.append(f"{rep_n} HUD joins")
        scope_str = ", ".join(parts) if parts else "Loopback sockets"
        metric_str = (
            f"Ingest p50 {fmt_ms(a.get('ingest_frame_p50_ms'))}, "
            f"HUD replay p50 {fmt_ms(a.get('hud_replay_p50_ms'))}"
        )
        wire_part = (
            f", verdict wire {fmt_comma(a.get('hud_verdict_wire_bytes'), 0)} B"
            if a.get("hud_verdict_wire_bytes") is not None
            else ""
        )
        outcome_str = (
            f"FrameRing max len {fmt_num(a.get('ring_max_observed_len'), 0)}, "
            f"state fan-out p50 {fmt_ms(a.get('state_fanout_p50_ms'))}{wire_part}"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "tts_multilingual_audio":
        langs_txt = ", ".join(a.get("languages_tested") or []) or "n/a"
        scope_str = f"{a['n_utterances']} utterances ({langs_txt})"
        metric_str = (
            f"{fmt_num(a.get('valid_wav_count'), 0)}/{a['n_utterances']} valid WAV "
            f"({fmt_pct(a.get('valid_wav_rate'))})"
        )
        dur_part = f", mean {fmt_num(a.get('mean_audio_duration_s'), 2)} s" if a.get("mean_audio_duration_s") is not None else ""
        bytes_part = f", {fmt_comma(a.get('mean_wav_bytes'), 0)} B" if a.get("mean_wav_bytes") is not None else ""
        outcome_str = f"HTTP 200: {fmt_num(a.get('http_200_count'), 0)}/{a['n_utterances']}{dur_part}{bytes_part}"
        return (scope_str, metric_str, lat_str, outcome_str)
    return ("present", "Loaded", lat_str, "Loaded")


def wave7_table_cells(sid: str, a: dict[str, Any]) -> tuple[str, str, str, str]:
    lat_str = f"{fmt_ms(a['latency_ms']['p50'])} / {fmt_ms(a['latency_ms']['p95'])}"
    if sid == "orientation_robustness_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"180 deg {fmt_pct(a.get('upside_down_180_accuracy'))}, "
            f"90/270 deg {fmt_pct(a.get('sideways_90_270_accuracy'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "prompt_injection_labels_results":
        scope_str = f"{a['n_cases']} cases"
        verdict_part = (
            f", verdicts {a['verdict_matches']}/{a['n_cases']}"
            if a.get("verdict_matches") is not None
            else f", verdict accuracy {fmt_pct(a.get('verdict_accuracy'))}"
        )
        metric_str = f"Injection resistance {fmt_pct(a.get('injection_resistance_rate'))}{verdict_part}"
        outcome_str = (
            f"{fmt_num(a.get('hijack_success_count'), 0)} hijacks, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "thermal_fade_wear_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"Moderate wear {fmt_pct(a.get('moderate_wear_accuracy'))}, "
            f"severe abstention {fmt_pct(a.get('severe_wear_abstention_rate'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "concurrent_sessions_results":
        parts: list[str] = []
        if a.get("n_concurrent_sessions") is not None:
            parts.append(f"{a['n_concurrent_sessions']} sessions")
        if a.get("n_concurrent_websockets") is not None:
            parts.append(f"{a['n_concurrent_websockets']} sockets")
        if a.get("total_frames_ingested") is not None:
            parts.append(f"{a['total_frames_ingested']} frames")
        scope_str = ", ".join(parts) if parts else "Concurrent sessions"
        iso_part = f" ({fmt_pct(a.get('isolation_pass_rate'))})" if a.get("isolation_pass_rate") is not None else ""
        metric_str = f"{fmt_num(a.get('cross_session_leak_count'), 0)} cross-session leaks{iso_part}"
        conc_lat_str = (
            f"Ingest {fmt_ms(a.get('concurrent_ingest_p50_ms'))} / "
            f"Fan-out {fmt_ms(a.get('concurrent_fanout_p50_ms'))}"
        )
        ring_part = (
            f", FrameRing max len {fmt_num(a.get('max_ring_len_observed'), 0)}"
            if a.get("max_ring_len_observed") is not None
            else ""
        )
        outcome_str = (
            f"Post-disconnect frames {fmt_num(a.get('post_disconnect_buffered_frames'), 0)}{ring_part}"
        )
        return (scope_str, metric_str, conc_lat_str, outcome_str)
    if sid == "multilingual_coaching_results":
        langs_txt = ", ".join(a.get("languages_tested") or []) or "n/a"
        scope_str = f"{a['n_turns']} turns ({langs_txt})"
        metric_str = f"Language compliance {fmt_pct(a.get('language_compliance_rate'))}"
        wc_part = (
            f", mean {fmt_num(a.get('mean_word_count'), 2)} words"
            if a.get("mean_word_count") is not None
            else ""
        )
        outcome_str = (
            f"{fmt_num(a.get('dose_hallucination_count'), 0)} dose hallucinations, "
            f"{fmt_num(a.get('bystander_leak_count'), 0)} bystander leaks{wc_part}"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    return ("present", "Loaded", lat_str, "Loaded")


def wave8_table_cells(sid: str, a: dict[str, Any]) -> tuple[str, str, str, str]:
    lat_str = f"{fmt_ms(a['latency_ms']['p50'])} / {fmt_ms(a['latency_ms']['p95'])}"
    if sid == "blister_strip_cuts_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"Intact tiles {fmt_pct(a.get('intact_tile_accuracy'))}, "
            f"truncated abstention {fmt_pct(a.get('truncated_abstention_rate'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "two_boxes_in_frame_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"Foreground focus {fmt_pct(a.get('foreground_focus_accuracy'))}, "
            f"multi-box safety {fmt_pct(a.get('multi_box_safety_rate'))}, "
            f"{fmt_num(a.get('false_match_on_conflict_count'), 0)} conflict false matches, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "cellophane_tremor_results":
        scope_str = f"{a['n_cases']} cases"
        metric_str = (
            f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))} ({a['verdict_matches']}/{a['n_cases']})"
            if a.get("verdict_matches") is not None
            else fmt_pct(a.get("verdict_accuracy"))
        )
        outcome_str = (
            f"Moderate compound {fmt_pct(a.get('moderate_compound_accuracy'))}, "
            f"severe abstention {fmt_pct(a.get('severe_compound_abstention_rate'))}, "
            f"{fmt_num(a.get('confident_wrong_dose_count'), 0)} confident-wrong doses, "
            f"{fmt_num(a.get('false_safe_allergen_count'), 0)} false-safe allergens"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    if sid == "ws_reconnect_resilience":
        parts: list[str] = []
        if a.get("n_reconnect_cycles") is not None:
            parts.append(f"{a['n_reconnect_cycles']} reconnects")
        if a.get("n_hostile_payloads") is not None:
            parts.append(f"{a['n_hostile_payloads']} hostile payloads")
        scope_str = ", ".join(parts) if parts else "WebSocket reconnects"
        metric_str = (
            f"Replay {fmt_pct(a.get('replay_completeness_rate'))}, "
            f"hostile rejection {fmt_pct(a.get('graceful_rejection_rate'))}"
        )
        rp50 = f"{fmt_num(a.get('replay_reconnect_p50_ms'), 3)} ms" if a.get("replay_reconnect_p50_ms") is not None else "n/a"
        rp95 = f"{fmt_num(a.get('replay_reconnect_p95_ms'), 3)} ms" if a.get("replay_reconnect_p95_ms") is not None else "n/a"
        ws_lat_str = f"Replay {rp50} / {rp95}"
        leak_part = (
            f", leaked HUD refs {fmt_num(a.get('leaked_hud_refs'), 0)}"
            if a.get("leaked_hud_refs") is not None
            else ""
        )
        outcome_str = (
            f"{fmt_num(a.get('server_crash_count'), 0)} crashes, "
            f"post-storm frames {fmt_num(a.get('post_storm_buffered_frames'), 0)}{leak_part}"
        )
        return (scope_str, metric_str, ws_lat_str, outcome_str)
    if sid == "spoken_verdict_clarity_results":
        scope_str = f"{a['n_cases']} cases"
        verdict_part = (
            f"Verdicts {a['verdict_matches']}/{a['n_cases']} ({fmt_pct(a.get('verdict_accuracy'))})"
            if a.get("verdict_matches") is not None
            else f"Verdict accuracy {fmt_pct(a.get('verdict_accuracy'))}"
        )
        clarity_part = (
            f", clarity {fmt_num(a.get('mean_clarity_score'), 2)}/5"
            if a.get("mean_clarity_score") is not None
            else ""
        )
        metric_str = f"{verdict_part}{clarity_part}"
        outcome_str = (
            f"Headline cap {fmt_pct(a.get('headline_word_cap_pass_rate'))}, "
            f"sentence cap {fmt_pct(a.get('speech_sentence_cap_pass_rate'))}, "
            f"MDR boundary {fmt_pct(a.get('non_medical_boundary_pass_rate'))}, "
            f"blind actionable {fmt_pct(a.get('blind_actionability_pass_rate'))}"
        )
        return (scope_str, metric_str, lat_str, outcome_str)
    return ("present", "Loaded", lat_str, "Loaded")


def render_markdown(compiled: dict[str, Any]) -> str:
    lines: list[str] = []
    artifacts = compiled["artifacts"]
    suites_present = compiled["suites_present"]
    extended_suites_present = compiled.get("extended_suites_present", [])
    extended_summary = compiled.get("extended_summary")
    wave6_suites_present = compiled.get("wave6_suites_present", [])
    wave6_summary = compiled.get("wave6_summary")
    wave7_suites_present = compiled.get("wave7_suites_present", [])
    wave7_summary = compiled.get("wave7_summary")
    wave8_suites_present = compiled.get("wave8_suites_present", [])
    wave8_summary = compiled.get("wave8_summary")
    label_suites = compiled["label_suites_present"]
    total_cases = compiled["total_label_cases_evaluated"]
    verdict_acc = compiled["overall_verdict_accuracy"]

    lines.append(f"{H1} HoldUp Evaluation, Calibration & Safety Benchmark Report")
    lines.append("")
    lines.append(
        "HoldUp evaluates both halves of its smart-glasses assistive pipeline with real Gemini API calls "
        "and deterministic safety assertions: (1) schema-constrained multi-frame label extraction (`gemini-3.8-flash` "
        "with `shared/verify_prompt.md` and `shared/label_schema.json`) paired with deterministic profile verification "
        "(`checkLabel()` in `server/src/safety.ts`), and (2) live voice coaching, tool-call grounding, language switching, "
        "and bystander privacy (`server/src/prompts/live.md` and `server/src/live.ts`)."
    )
    lines.append("")
    lines.append(
        "Every metric and table in this document is compiled deterministically by `eval/compile_eval_report.py` "
        "from committed JSON measurement artifacts in `eval/*.json` (and exported to `eval/combined_summary.json` "
        "for `window.HOLDUP_EVAL_DATA` in the presentation deck). Suites not yet present in `eval/` are marked "
        "explicitly as pending merge with zero estimated or fabricated numbers."
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append(f"{H2} 1. Methodology & Two-Tier Verification Architecture")
    lines.append("")
    lines.append(
        "1. **Separation of Perceptual Reading and Clinical Rule Matching**:\n"
        "   - **Perceptual Extraction (`server/src/verify.ts`)**: Sends 1 to 3 sharpest recent JPEG frames to "
        "`gemini-3.8-flash` (`thinkingLevel = LOW`, `responseMimeType = application/json`, `responseJsonSchema = LABEL_SCHEMA`) "
        "with zero user profile fields attached. Each field (`product`, `ingredient`, `strength`, `dosing`, `expiry`, "
        "`allergens`, `barcode`) returns `{ value, confidence }` in `[0.0, 1.0]`.\n"
        "   - **Deterministic Safety Engine (`server/src/safety.ts`)**: `checkLabel(read, profile)` compares the "
        "structured `LabelRead` against the user's on-device medication schedule, INN brand synonyms (English, Finnish, "
        "Swedish), drug-class avoid lists (`NSAIDs`, penicillins, statins, etc.), allergen synonyms (`arachis oil` -> "
        "`peanut`, `hasselpahkina` -> `hazelnut`, `jordnotter` -> `peanut`), ISO expiry dates, and same-day `doseLog`.\n"
        "2. **Conversational Grounding & Privacy (`server/src/prompts/live.md`)**:\n"
        "   - The Live voice assistant coaches physical hand positioning in body-relative terms (`<= 2` short sentences, "
        "calling non-blocking `show_cue`), never states drug names, strengths, expiries, or allergens from raw video "
        "before calling `verify_label`, relays `verify_label.speech` verbatim without softening warnings, refuses "
        "clinical dosing changes with a pharmacist handoff, and ignores people and faces completely.\n"
        "3. **Multi-Suite Ground-Truth Coverage**:\n"
        "   - Synthetic medication photography (`results_batch1.json`), multilingual food allergen and household "
        "packs (`results_batch2.json`), end-to-end Express `POST /api/verify` fixture checks (`demo_fixtures_results.json`), "
        "Finnish/Swedish pharmacy dosing stickers with comma decimals (`nordic_stickers_results.json`), controlled "
        "4-tier optical blur/glare/occlusion sweeps (`calibration_curve.json`), 3-model Gemini Flash fallback comparisons "
        "(`model_comparison.json`), Gemini Live WebSocket connect and first-audio probes (`live_models_probe.json`), "
        "structured LLM-as-a-Judge coaching and bystander privacy transcripts (`coaching_eval.json`), and measured "
        "JPEG payload, adaptive bandwidth, and 3-year assistive TCO modeling (`unit_economics.json`). Optional "
        "stress suites covering curved pill bottles and foil glare, multi-step FrameRing coaching trajectories, "
        "low-light sensor noise and motion blur, European multilingual labels, bystander PII red-teaming, "
        "LASA/double-dose polypharmacy confusion, multi-frame partial-view fusion, adversarial hidden allergens, "
        "international expiry formats, end-to-end Live WebSocket + HUD wire latency, loopback FrameRing throughput, "
        "multilingual `/api/tts` WAV synthesis, blind-hold orientation robustness, visual prompt-injection red-teaming, "
        "thermal-fade and worn-carton legibility, 25-session concurrent isolation, multilingual hand-coaching safety, "
        "scissor-cut blister strips, multi-box countertop clutter, cellophane glare with hand tremor, "
        "WebSocket reconnect/storm resilience, and spoken verdict clarity judging "
        "are automatically discovered and compiled whenever present on disk."
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append(f"{H2} 2. Deterministic Safety Invariants")
    lines.append("")
    lines.append(
        "HoldUp's core safety guarantee is **no silent guessing on medication doses or hidden allergens**. "
        "The following constants and invariants are enforced in `server/src/safety.ts` and `server/src/verify.ts`:"
    )
    lines.append("")
    lines.append("| Invariant / Gate | Code Value | Enforcement Location | Safety Behaviour |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| `STRENGTH_MIN_CONF` | `{STRENGTH_MIN_CONF:.2f}` | `server/src/safety.ts` | "
        "Medication `strength.value` must be non-null with `strength.confidence >= 0.80` before `checkLabel()` can emit `match`. "
        "Lower confidence forces `level = unsure` with body-relative coaching or pharmacist handoff. |"
    )
    lines.append(
        f"| `NAME_MIN_CONF` | `{NAME_MIN_CONF:.2f}` | `server/src/safety.ts` | "
        "Active ingredient or product name requires `confidence >= 0.60`; ambiguous packs return `unsure`. |"
    )
    lines.append(
        f"| `ALLERGEN_MIN_CONF` | `{ALLERGEN_MIN_CONF:.2f}` | `server/src/safety.ts` | "
        "For users with saved allergies, food packages with `allergens.value === null` (front of box) or `confidence < 0.60` "
        "return `unsure` (`Can't read the allergens yet`), never a false `info` safe card. |"
    )
    lines.append(
        f"| `EXPIRY_MIN_CONF` | `{EXPIRY_MIN_CONF:.2f}` | `server/src/safety.ts` & `verify.ts` | "
        "Expiry dates require ISO `YYYY-MM` or `YYYY-MM-DD` format (malformed strings clamped to `<= 0.50` in `toLabelRead()`) "
        "and `confidence >= 0.70` to evaluate `isExpired()`. |"
    )
    lines.append(
        "| Null-field confidence cap & comma decimal normalisation | `<= 0.30` / `2,5 -> 2.5` | `server/src/verify.ts` | "
        "`toLabelRead()` clamps confidence to `<= 0.30` whenever `value === null` and normalises Nordic comma decimals "
        "(`2,5 mg` -> `2.5 mg`) prior to `sameStrength()` comparison. |"
    )
    lines.append(
        "| `confident_wrong_dose_count` | Target `0` | Evaluation invariant | "
        "Count of evaluated medication cases where ground-truth strength is unreadable/occluded yet predicted with "
        "`confidence >= 0.80` (or `match`), OR where a readable strength is misread at `confidence >= 0.80` (or false `match`). |"
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append(f"{H2} 3. Cross-Suite Aggregate Summary & Artifact Inventory")
    lines.append("")
    lines.append("| Metric | Measured Value |")
    lines.append("|---|---|")
    suites_joined = ", ".join(suites_present) if suites_present else "none"
    label_joined = ", ".join(f"`{s}`" for s in label_suites) if label_suites else "pending branch merges"
    cases_note = " (awaiting merge of label-verification JSON suites)" if total_cases == 0 else ""
    verdict_display = (
        f"`{fmt_pct(verdict_acc)}` (`{compiled['total_verdict_matches']} / {total_cases}`)"
        if verdict_acc is not None
        else "Pending merge of label-verification JSON suites"
    )
    cwd_note = (
        " (0 label suites merged on this branch yet)"
        if total_cases == 0 and "calibration_curve" not in artifacts and "model_comparison" not in artifacts
        else f" across {total_cases} label checks"
    )
    clean_display = f"`{fmt_pct(compiled['clean_field_accuracy'])}`" if compiled["clean_field_accuracy"] is not None else "Pending merge"
    occ_display = f"`{fmt_pct(compiled['occluded_abstention_rate'])}`" if compiled["occluded_abstention_rate"] is not None else "Pending merge"
    lat_display = (
        f"`{fmt_ms(compiled['verify_latency_ms']['p50'])} / {fmt_ms(compiled['verify_latency_ms']['p95'])}`"
        if compiled["verify_latency_ms"]["p50"] is not None
        else "Pending merge"
    )

    lines.append(f"| Evaluation artifacts present in `eval/` | `{len(suites_present)} / {len(ARTIFACT_SPECS)}` (`{suites_joined}`) |")
    lines.append(f"| Label-verification suites merged | `{len(label_suites)} / {len(LABEL_SUITE_IDS)}` ({label_joined}) |")
    lines.append(f"| Total label-verification cases evaluated (`total_label_cases_evaluated`) | `{total_cases}`{cases_note} |")
    lines.append(f"| Overall label verdict accuracy (`overall_verdict_accuracy`) | {verdict_display} |")
    lines.append(f"| Total confident-wrong dose count (`STRENGTH_MIN_CONF = {STRENGTH_MIN_CONF:.2f}`) | `{compiled['total_confident_wrong_dose_count']}`{cwd_note} |")
    lines.append(f"| Clean field extraction accuracy | {clean_display} |")
    lines.append(f"| Occluded / unreadable dose abstention rate | {occ_display} |")
    lines.append(f"| Verify latency (median p50 / tail p95) | {lat_display} |")
    if compiled["coaching_judge"] is not None:
        cj = compiled["coaching_judge"]
        lines.append(
            f"| Coaching & bystander privacy judge (`coaching_eval.json`) | "
            f"`{cj['passed_all_checks']} / {cj['total_scenarios']}` passed (`{fmt_pct(cj['all_checks_pass_rate'])}`), "
            f"mean score `{fmt_num(cj['mean_overall_score'], 2)} / 5`, assistant p50 `{fmt_ms(cj['assistant_latency_ms']['p50'])}` |"
        )
    else:
        lines.append("| Coaching & bystander privacy judge (`coaching_eval.json`) | Pending merge |")
    if compiled["calibration"] is not None:
        cal_s = compiled["calibration"]
        lines.append(
            f"| Strength confidence calibration (`calibration_curve.json`) | "
            f"`{cal_s['n_items']}` reads, `ECE = {fmt_num(cal_s['ece'], 4)}`, `Brier = {fmt_num(cal_s['brier_score'], 4)}`, "
            f"latency p50 `{fmt_ms(cal_s['latency_ms']['p50'])}` / mean `{fmt_ms(cal_s['latency_ms']['mean'])}` / max `{fmt_ms(cal_s['latency_ms']['max'])}` |"
        )
    if compiled["unit_economics"] is not None:
        ue_s = compiled["unit_economics"]
        lines.append(
            f"| Bandwidth & pilot unit economics (`unit_economics.json`) | "
            f"`{fmt_comma(ue_s['normal_1fps_check_bandwidth_kb'], 2)} KB -> {fmt_comma(ue_s['slow_network_adaptive_0_5fps_check_bandwidth_kb'], 2)} KB` "
            f"(`{fmt_num(ue_s['video_bandwidth_saved_in_adaptive_mode_pct'], 1)}%` adaptive video reduction), "
            f"`EUR {fmt_num(ue_s['per_check_gemini_cost_eur_standard'], 5)}` / check, "
            f"3-yr TCO `EUR {fmt_comma(ue_s['tco_3yr_holdup_rayban_meta_gen2_eur'], 2)}` vs `EUR {fmt_comma(ue_s['tco_3yr_orcam_myeye_midpoint_eur'], 2)}` |"
        )
    if extended_suites_present and extended_summary is not None:
        ext_joined = ", ".join(extended_suites_present)
        ext_acc_txt = (
            f"`{fmt_pct(extended_summary['overall_verdict_accuracy'])}` (`{extended_summary['total_verdict_matches']} / {extended_summary['total_cases_evaluated']}`)"
            if extended_summary["overall_verdict_accuracy"] is not None
            else f"`{extended_summary['total_cases_evaluated']}` checks"
        )
        lines.append(
            f"| Extended stress suites present in `eval/` | "
            f"`{len(extended_suites_present)}` (`{ext_joined}`), {ext_acc_txt}, "
            f"`{extended_summary['confident_wrong_dose_count']}` confident-wrong doses |"
        )
    if wave6_suites_present and wave6_summary is not None:
        w6_joined = ", ".join(wave6_suites_present)
        w6_acc_part = (
            f", `{fmt_pct(wave6_summary['label_and_fusion_verdict_accuracy'])}` "
            f"(`{wave6_summary['label_and_fusion_verdict_matches']} / {wave6_summary['label_and_fusion_cases_evaluated']}`)"
            if wave6_summary["label_and_fusion_verdict_accuracy"] is not None
            else ""
        )
        lines.append(
            f"| Wave-6 multi-frame, adversarial, systems & TTS benchmarks present in `eval/` | "
            f"`{len(wave6_suites_present)}` (`{w6_joined}`){w6_acc_part}, "
            f"`{wave6_summary['confident_wrong_dose_count']}` confident-wrong doses |"
        )
    if wave7_suites_present and wave7_summary is not None:
        w7_joined = ", ".join(wave7_suites_present)
        w7_acc_part = (
            f", `{fmt_pct(wave7_summary['label_verdict_accuracy'])}` "
            f"(`{wave7_summary['label_verdict_matches']} / {wave7_summary['label_cases_evaluated']}`)"
            if wave7_summary["label_verdict_accuracy"] is not None
            else ""
        )
        lines.append(
            f"| Wave-7 orientation, prompt-injection, wear, concurrency & coaching benchmarks present in `eval/` | "
            f"`{len(wave7_suites_present)}` (`{w7_joined}`){w7_acc_part}, "
            f"`{wave7_summary['confident_wrong_dose_count']}` confident-wrong doses |"
        )
    if wave8_suites_present and wave8_summary is not None:
        w8_joined = ", ".join(wave8_suites_present)
        w8_acc_part = (
            f", `{fmt_pct(wave8_summary['verdict_and_clarity_accuracy'])}` "
            f"(`{wave8_summary['verdict_and_clarity_matches']} / {wave8_summary['verdict_and_clarity_cases_evaluated']}`)"
            if wave8_summary["verdict_and_clarity_accuracy"] is not None
            else (
                f", `{fmt_pct(wave8_summary['label_verdict_accuracy'])}` "
                f"(`{wave8_summary['label_verdict_matches']} / {wave8_summary['label_cases_evaluated']}`)"
                if wave8_summary["label_verdict_accuracy"] is not None
                else ""
            )
        )
        lines.append(
            f"| Wave-8 blister-cut, multi-box, compound-glare, WS resilience & spoken-clarity benchmarks present in `eval/` | "
            f"`{len(wave8_suites_present)}` (`{w8_joined}`){w8_acc_part}, "
            f"`{wave8_summary['confident_wrong_dose_count']}` confident-wrong doses |"
        )
    lines.append("")

    lines.append(f"{H3} Artifact Status Matrix")
    lines.append("")
    lines.append("| Artifact File | Status | Model(s) | Scope | Headline Measured Summary |")
    lines.append("|---|---|---|---|---|")
    for spec in ARTIFACT_SPECS:
        sid = spec["id"]
        present = sid in artifacts
        scope_str, headline_str = artifact_headline(sid, artifacts)
        status_str = "Present" if present else "Pending merge"
        lines.append(
            f"| `eval/{spec['filename']}` | **{status_str}** | `{spec['primary_model']}` | "
            f"{md_cell(scope_str)} | {md_cell(headline_str)} |"
        )
    lines.append("")

    if extended_suites_present:
        lines.append(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites")
        lines.append("")
        lines.append(
            "| Stress Suite Artifact | Stress Dimension | Model | Scope | Verdict / Stage Accuracy | Confident-Wrong Doses | Latency (p50 / p95) | Key Stress Outcome |"
        )
        lines.append("|---|---|---|---|---|---|---|---|")
        for spec in EXTENDED_ARTIFACT_SPECS:
            sid = spec["id"]
            if sid not in artifacts:
                continue
            scope_str, acc_str, cwd_str, lat_str, outcome_str = extended_table_cells(sid, artifacts[sid])
            lines.append(
                f"| `eval/{spec['filename']}` | {md_cell(spec['dimension'])} | `{md_cell(artifacts[sid]['model'])}` | "
                f"{md_cell(scope_str)} | {md_cell(acc_str)} | `{md_cell(cwd_str)}` | `{md_cell(lat_str)}` | {md_cell(outcome_str)} |"
            )
        lines.append("")

    if wave6_suites_present:
        lines.append(f"{H3} Wave-6 Multi-Frame Fusion, Adversarial Safety, Systems & TTS Benchmarks")
        lines.append("")
        lines.append(
            "| Benchmark Artifact | Evaluation Dimension | Engine / Model | Scope | Primary Metric | Latency (p50 / p95) | Safety & Systems Outcome |"
        )
        lines.append("|---|---|---|---|---|---|---|")
        for spec in WAVE6_ARTIFACT_SPECS:
            sid = spec["id"]
            if sid not in artifacts:
                continue
            scope_str, metric_str, lat_str, outcome_str = wave6_table_cells(sid, artifacts[sid])
            lines.append(
                f"| `eval/{spec['filename']}` | {md_cell(spec['dimension'])} | `{md_cell(artifacts[sid]['model'])}` | "
                f"{md_cell(scope_str)} | {md_cell(metric_str)} | `{md_cell(lat_str)}` | {md_cell(outcome_str)} |"
            )
        lines.append("")

    if wave7_suites_present:
        lines.append(f"{H3} Wave-7 Orientation, Prompt-Injection, Wear, Concurrency & Coaching Benchmarks")
        lines.append("")
        lines.append(
            "| Benchmark Artifact | Evaluation Dimension | Engine / Model | Scope | Primary Metric | Latency (p50 / p95) | Safety & Systems Outcome |"
        )
        lines.append("|---|---|---|---|---|---|---|")
        for spec in WAVE7_ARTIFACT_SPECS:
            sid = spec["id"]
            if sid not in artifacts:
                continue
            scope_str, metric_str, lat_str, outcome_str = wave7_table_cells(sid, artifacts[sid])
            lines.append(
                f"| `eval/{spec['filename']}` | {md_cell(spec['dimension'])} | `{md_cell(artifacts[sid]['model'])}` | "
                f"{md_cell(scope_str)} | {md_cell(metric_str)} | `{md_cell(lat_str)}` | {md_cell(outcome_str)} |"
            )
        lines.append("")

    if wave8_suites_present:
        lines.append(
            f"{H3} Wave-8 Blister-Cut, Multi-Box, Compound-Glare, Reconnect & Spoken-Clarity Benchmarks"
        )
        lines.append("")
        lines.append(
            "| Benchmark Artifact | Evaluation Dimension | Engine / Model | Scope | Primary Metric | Latency (p50 / p95) | Safety & Systems Outcome |"
        )
        lines.append("|---|---|---|---|---|---|---|")
        for spec in WAVE8_ARTIFACT_SPECS:
            sid = spec["id"]
            if sid not in artifacts:
                continue
            scope_str, metric_str, lat_str, outcome_str = wave8_table_cells(sid, artifacts[sid])
            lines.append(
                f"| `eval/{spec['filename']}` | {md_cell(spec['dimension'])} | `{md_cell(artifacts[sid]['model'])}` | "
                f"{md_cell(scope_str)} | {md_cell(metric_str)} | `{md_cell(lat_str)}` | {md_cell(outcome_str)} |"
            )
        lines.append("")

    lines.append("---")
    lines.append("")

    lines.append(f"{H2} 4. Detailed Results for Present Evaluation Artifacts")
    lines.append("")

    section_num = 0

    if "coaching_eval" in artifacts:
        section_num += 1
        ce = artifacts["coaching_eval"]
        dims = ce["dimension_pass_rates"]
        lines.append(f"{H3} 4.{section_num} Conversational Coaching & Bystander Privacy Judge (`eval/coaching_eval.json`)")
        lines.append("")
        lines.append(
            f"Evaluates `{ce['model']}` loaded with the production `server/src/prompts/live.md` system instruction, "
            f"user medication and allergy profile appendix (`server/src/live.ts`), and the 3 Live function declarations "
            f"(`verify_label`, `show_cue`, `log_dose`) across `{ce['total_scenarios']}` visual + spoken scenarios, "
            f"scored by a schema-constrained `{ce['judge_model']}` accessibility and clinical-safety judge."
        )
        lines.append("")
        lines.append("| Coaching Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Assistant model / Judge model | `{ce['model']}` / `{ce['judge_model']}` |")
        lines.append(f"| Scenarios passing all 5 checks (`score >= 4`) | `{ce['passed_all_checks']} / {ce['total_scenarios']}` (`{fmt_pct(ce['all_checks_pass_rate'])}`) |")
        lines.append(f"| Mean / Min / Max overall score (1 to 5) | `{fmt_num(ce['mean_overall_score'], 2)}` / `{fmt_num(ce['min_overall_score'], 0)}` / `{fmt_num(ce['max_overall_score'], 0)}` |")
        lines.append(f"| Brevity (`<= 2` short sentences, `<= 6` words dose log, zero filler) | `{fmt_pct(dims.get('brevity_ok'))}` |")
        lines.append(f"| Zero raw-vision safety hallucination (`verify_label` required first) | `{fmt_pct(dims.get('no_raw_vision_hallucination'))}` |")
        lines.append(f"| Tool-call correctness (`verify_label`, `show_cue`, `log_dose`) | `{fmt_pct(dims.get('tool_use_correct'))}` |")
        lines.append(f"| Bystander & face privacy refusal (`privacy_safe`) | `{fmt_pct(dims.get('privacy_safe'))}` |")
        lines.append(f"| Calm body-relative tone & Finnish language switch (`calm_accessible_tone`) | `{fmt_pct(dims.get('calm_accessible_tone'))}` |")
        lines.append(
            f"| Assistant end-to-end turn latency (p50 / mean / max) | "
            f"`{fmt_ms(ce['assistant_latency_ms']['p50'])}` / `{fmt_ms(ce['assistant_latency_ms']['mean'])}` / `{fmt_ms(ce['assistant_latency_ms']['max'])}` |"
        )
        lines.append(
            f"| Judge scoring latency (p50 / mean / max) | "
            f"`{fmt_ms(ce['judge_latency_ms']['p50'])}` / `{fmt_ms(ce['judge_latency_ms']['mean'])}` / `{fmt_ms(ce['judge_latency_ms']['max'])}` |"
        )
        lines.append("")
        lines.append("| Scenario ID | User Utterance | Tools Invoked | Final Assistant Speech | Latency | Judge Score | Pass |")
        lines.append("|---|---|---|---|---|---|---|")
        for sc in ce["scenarios"]:
            tools_txt = ", ".join(f"`{t}`" for t in sc["tools"]) if sc["tools"] else "`(none)`"
            lines.append(
                f"| `{md_cell(sc['id'])}` | {md_cell(sc['user_prompt'])} | {tools_txt} | "
                f"{md_cell(sc['final_speech'])} | `{fmt_ms(sc['assistant_latency_ms'])}` | "
                f"`{fmt_num(sc['score'], 0)}/5` | `{'PASS' if sc['passed_all'] else 'FAIL'}` |"
            )
        lines.append("")

    for sid in LABEL_SUITE_IDS:
        if sid not in artifacts:
            continue
        section_num += 1
        spec = next(s for s in ARTIFACT_SPECS if s["id"] == sid)
        suite = artifacts[sid]
        lines.append(f"{H3} 4.{section_num} {spec['title']} (`eval/{spec['filename']}`)")
        lines.append("")
        lines.append("| Suite Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Model | `{suite['model']}` |")
        lines.append(f"| Evaluated cases (`n_cases`) | `{suite['n_cases']}` |")
        lines.append(f"| Verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` (`{suite['verdict_matches']} / {suite['n_cases']}`) |")
        lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
        if suite["clean_field_accuracy"] is not None:
            lines.append(f"| Clean field accuracy | `{fmt_pct(suite['clean_field_accuracy'])}` |")
        if suite["occluded_abstention_rate"] is not None:
            lines.append(f"| Occluded / unreadable abstention rate | `{fmt_pct(suite['occluded_abstention_rate'])}` |")
        if suite["allergen_recall"] is not None:
            lines.append(f"| Allergen recall | `{fmt_pct(suite['allergen_recall'])}` |")
        if suite["false_safe_allergen_count"] is not None:
            lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
        if suite["comma_decimal_matched"] is not None:
            lines.append(f"| Nordic comma-decimal (`2,5 mg` -> `2.5 mg`) matched | `{suite['comma_decimal_matched']}` |")
        lines.append(
            f"| Latency (p50 / p95 / mean) | "
            f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
        )
        if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
            lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
        lines.append("")

        if suite["rows"]:
            lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Strength | Strength Conf | Confident-Wrong Dose | Latency |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for r in suite["rows"]:
                lines.append(
                    f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                    f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                    f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                    f"{md_cell(r['strength_value'] or 'null')} | "
                    f"`{fmt_num(r['strength_confidence'], 2)}` | "
                    f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                )
            lines.append("")

    if "calibration_curve" in artifacts:
        section_num += 1
        cal = artifacts["calibration_curve"]
        tiers = cal["mean_strength_confidence_by_tier"]
        cal_lat = cal["latency_ms"]
        think_note = f" (`thinking_level = {cal['thinking_level']}`)" if cal["thinking_level"] else ""
        split_note = (
            f" (`{cal['readable_items']}` readable, `{cal['unreadable_items']}` unreadable)"
            if cal["readable_items"] is not None and cal["unreadable_items"] is not None
            else ""
        )
        lines.append(f"{H3} 4.{section_num} Strength Confidence Calibration & Threshold Sweep (`eval/calibration_curve.json`)")
        lines.append("")
        lines.append(
            f"Evaluates `{cal['model']}`{think_note} across `{cal['n_items']}` progressive optical degradation frames"
            f"{split_note}, measuring Expected Calibration Error `ECE = {fmt_num(cal['ece'], 4)}`, "
            f"Brier score `{fmt_num(cal['brier_score'], 4)}`, and extraction latency "
            f"`p50 = {fmt_ms(cal_lat['p50'])}` (`mean = {fmt_ms(cal_lat['mean'])}`, `max = {fmt_ms(cal_lat['max'])}`)."
        )
        lines.append("")
        lines.append("| Calibration Metric | Measured Value |")
        lines.append("|---|---|")
        model_display = f"`{cal['model']}` (`{cal['thinking_level']}`)" if cal["thinking_level"] else f"`{cal['model']}`"
        items_display = (
            f"`{cal['n_items']}` (`{cal['readable_items']}` readable / `{cal['unreadable_items']}` unreadable)"
            if cal["readable_items"] is not None and cal["unreadable_items"] is not None
            else f"`{cal['n_items']}`"
        )
        lines.append(f"| Model (thinking level) | {model_display} |")
        lines.append(f"| Evaluated frames (`total_items`) | {items_display} |")
        lines.append(f"| Expected Calibration Error (`ece`) | `{fmt_num(cal['ece'], 4)}` |")
        lines.append(f"| Brier score (`brier_score`) | `{fmt_num(cal['brier_score'], 4)}` |")
        lines.append(f"| Confident-wrong dose count at `STRENGTH_MIN_CONF = 0.80` | `{fmt_num(cal['confident_wrong_dose_at_080'], 0)}` |")
        lines.append(
            f"| Extraction latency (`p50` / `mean` / `max`) | "
            f"`{fmt_ms(cal_lat['p50'])}` / `{fmt_ms(cal_lat['mean'])}` / `{fmt_ms(cal_lat['max'])}` |"
        )
        lines.append("")
        lines.append("| Degradation Tier | Ground-Truth Strength Legibility | Mean Reported `strength.confidence` |")
        lines.append("|---|---|---|")
        lines.append(f"| Tier 0 (`tier_0_clean` / `clean`) | Readable (`True`) | `{fmt_num(tiers['tier_0_clean'], 4)}` |")
        lines.append(f"| Tier 1 (`tier_1_mild` / `mild_blur`) | Readable (`True`) | `{fmt_num(tiers['tier_1_mild'], 4)}` |")
        lines.append(f"| Tier 2 (`tier_2_heavy` / `heavy_blur_glare`) | Unreadable (`False`) | `{fmt_num(tiers['tier_2_heavy'], 4)}` |")
        lines.append(f"| Tier 3 (`tier_3_occluded` / `severe_occlusion`) | Unreadable (`False`) | `{fmt_num(tiers['tier_3_occluded'], 4)}` |")
        lines.append("")
        if cal["threshold_curve"]:
            has_cov = all(r.get("coverage") is not None and r.get("selective_risk") is not None for r in cal["threshold_curve"])
            if has_cov:
                lines.append("| Confidence Gate Threshold | Clean Readable Recall | Unreadable Abstention Rate | Selective Coverage | Selective Risk | Confident-Wrong Dose Count |")
                lines.append("|---|---|---|---|---|---|")
                for row in cal["threshold_curve"]:
                    marker = " **(production gate)**" if abs(row["threshold"] - STRENGTH_MIN_CONF) < 1e-6 else ""
                    lines.append(
                        f"| `{row['threshold']:.2f}`{marker} | `{fmt_pct(row['clean_recall'])}` | "
                        f"`{fmt_pct(row['unreadable_abstention_rate'])}` | `{fmt_pct(row['coverage'])}` | "
                        f"`{fmt_pct(row['selective_risk'])}` | `{fmt_num(row['confident_wrong_dose_count'], 0)}` |"
                    )
            else:
                lines.append("| Confidence Gate Threshold | Clean Readable Recall | Unreadable Abstention Rate | Confident-Wrong Dose Count |")
                lines.append("|---|---|---|---|")
                for row in cal["threshold_curve"]:
                    marker = " **(production gate)**" if abs(row["threshold"] - STRENGTH_MIN_CONF) < 1e-6 else ""
                    lines.append(
                        f"| `{row['threshold']:.2f}`{marker} | `{fmt_pct(row['clean_recall'])}` | "
                        f"`{fmt_pct(row['unreadable_abstention_rate'])}` | `{fmt_num(row['confident_wrong_dose_count'], 0)}` |"
                    )
            lines.append("")

    if "model_comparison" in artifacts:
        section_num += 1
        mc = artifacts["model_comparison"]
        lines.append(f"{H3} 4.{section_num} Multi-Model Fallback Chain Benchmark (`eval/model_comparison.json`)")
        lines.append("")
        lines.append(
            f"Compares accuracy, dose-safety abstention, token usage, and latency across `{mc['n_cards']}` "
            "deterministic clean and degraded label probe cards."
        )
        lines.append("")
        lines.append("| Model | Probe Cards | Verdict Accuracy | Clean Field Accuracy | Occluded Abstention | Confident-Wrong Doses | Latency p50 | Latency p95 | Mean Tokens (In / Out / Think) |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for m in mc["models"]:
            lines.append(
                f"| `{md_cell(m['model'])}` | `{m['n_cards']}` | `{fmt_pct(m['verdict_accuracy'])}` | "
                f"`{fmt_pct(m['clean_field_accuracy'])}` | `{fmt_pct(m['occluded_abstention_rate'])}` | "
                f"`{fmt_num(m['confident_wrong_dose_count'], 0)}` | `{fmt_ms(m['latency_p50_ms'])}` | "
                f"`{fmt_ms(m['latency_p95_ms'])}` | "
                f"`{fmt_num(m['mean_tokens_in'], 0)}` / `{fmt_num(m['mean_tokens_out'], 0)}` / `{fmt_num(m['mean_tokens_thinking'], 0)}` |"
            )
        lines.append("")

    if "live_models_probe" in artifacts:
        section_num += 1
        lp = artifacts["live_models_probe"]
        lines.append(f"{H3} 4.{section_num} Gemini Live Fallback Chain Timing Probe (`eval/live_models_probe.json`)")
        lines.append("")
        lines.append("| Live Model | Reachable (`ok`) | WebSocket Connect (`connectMs`) | First Audio (`firstAudioMs`) | Stream Kinds | Error |")
        lines.append("|---|---|---|---|---|---|")
        for m in lp["models"]:
            kinds_str = ", ".join(m["kinds"]) if m["kinds"] else "none"
            lines.append(
                f"| `{md_cell(m['model'])}` | `{m['ok']}` | `{fmt_ms(m['connect_ms'])}` | "
                f"`{fmt_ms(m['first_audio_ms'])}` | {md_cell(kinds_str)} | {md_cell(m['error'] or 'none')} |"
            )
        lines.append("")

    if "unit_economics" in artifacts:
        section_num += 1
        ue = artifacts["unit_economics"]
        bw_norm = ue["bandwidth_modes"]["normal_1fps_768px"]
        bw_adap = ue["bandwidth_modes"]["adaptive_0_5fps_512px"]
        bw_snap = ue["bandwidth_modes"]["snapshot_http_fallback"]
        bw_off = ue["bandwidth_modes"]["offline_barcode_fallback"]
        utok = ue["usage_and_tokens"]
        pt_std = ue["pricing_tiers"]["standard_cached"]
        pt_eco = ue["pricing_tiers"]["economy_2_0_live"]
        pt_ceil = ue["pricing_tiers"]["uncached_native_audio_ceiling"]
        tco = ue["three_year_tco"]
        hu_tco = tco["holdup_rayban_meta_gen2"]
        orc_tco = tco["orcam_myeye_class"]
        aira_tco = tco["aira_paid_daily_class"]
        pilot_100 = tco["rehabilitation_pilot_100_users_3yr"]

        lines.append(f"{H3} 4.{section_num} Bandwidth & Pilot Unit Economics (`eval/unit_economics.json`)")
        lines.append("")
        lines.append(
            f"Measures exact JPEG frame byte sizes across all `{ue['measured_fixture_count']}` production demo fixtures "
            f"(`{fmt_comma(ue['measured_fixture_mean_bytes'], 2)} B` / `{fmt_num(ue['measured_fixture_mean_kb'], 2)} KB` at normal "
            f"`{bw_norm['max_dim_px']}x{bw_norm['max_dim_px']}` vs `{fmt_comma(ue['measured_adaptive_512px_q50_mean_bytes'], 2)} B` / "
            f"`{fmt_num(ue['measured_adaptive_512px_q50_mean_kb'], 2)} KB` at RTT-adaptive `{bw_adap['max_dim_px']}x{bw_adap['max_dim_px']}` "
            f"`q={fmt_num(bw_adap['jpeg_quality'], 2)}`), per-check (`{fmt_num(ue['check_duration_s'], 1)} s`) media bandwidth "
            f"(with `{fmt_num(bw_norm['client_extra_verify_upload_kb'], 1)} KB` extra client upload on `verify_label` via server-RAM `Hub.ring`), "
            f"published Gemini token pricing (`{utok['checks_per_day']}` checks/day = `{fmt_comma(utok['checks_per_month'], 0)}` checks/month = "
            f"`{fmt_comma(utok['checks_per_year'], 0)}` checks/year), and `{tco['horizon_years']}`-year assistive TCO (`{fmt_comma(tco['total_checks'], 0)}` checks)."
        )
        lines.append("")
        lines.append("| Capture / Transport Mode | Resolution & Rate | Mean Frame Size | Video (`12.0 s`) | Total Media / Check | WebSocket / HTTP Wire | Monthly (`120` checks) |")
        lines.append("|---|---|---|---|---|---|---|")
        lines.append(
            f"| Normal Live (`normal_1fps_768px`) | `{bw_norm['max_dim_px']} px @ {fmt_num(bw_norm['fps'], 1)} fps` (`{bw_norm['frames_sent_in_12s']}` frames) | "
            f"`{fmt_comma(ue['measured_fixture_mean_bytes'], 2)} B` (`{fmt_num(ue['measured_fixture_mean_kb'], 2)} KB`) | "
            f"`{fmt_comma(bw_norm['jpeg_frames_kb'], 2)} KB` | "
            f"`{fmt_comma(ue['normal_1fps_check_bandwidth_kb'], 2)} KB` (`{fmt_num(bw_norm['avg_bitrate_kbps'], 1)} kbps`) | "
            f"`{fmt_comma(bw_norm['ws_wire_typical_kb'], 2)} KB` | `{fmt_num(bw_norm['monthly_120_checks_mb'], 2)} MB` |"
        )
        lines.append(
            f"| Slow-Network Adaptive (`RTT > {bw_adap['rtt_trigger_threshold_ms']} ms`) | `{bw_adap['max_dim_px']} px @ {fmt_num(bw_adap['fps'], 1)} fps` (`{bw_adap['frames_sent_in_12s']}` frames) | "
            f"`{fmt_comma(ue['measured_adaptive_512px_q50_mean_bytes'], 2)} B` (`{fmt_num(ue['measured_adaptive_512px_q50_mean_kb'], 2)} KB`) | "
            f"`{fmt_comma(bw_adap['jpeg_frames_kb'], 2)} KB` (**`-{fmt_num(ue['video_bandwidth_saved_in_adaptive_mode_pct'], 1)}%`**) | "
            f"`{fmt_comma(ue['slow_network_adaptive_0_5fps_check_bandwidth_kb'], 2)} KB` (**`-{fmt_num(ue['total_bandwidth_saved_in_adaptive_mode_pct'], 1)}%`**, `{fmt_num(bw_adap['avg_bitrate_kbps'], 1)} kbps`) | "
            f"`{fmt_comma(bw_adap['ws_wire_typical_kb'], 2)} KB` | `{fmt_num(bw_adap['monthly_120_checks_mb'], 2)} MB` |"
        )
        lines.append(
            f"| Degraded HTTP Snapshot (`POST /api/verify`) | `2` adaptive `{bw_adap['max_dim_px']} px` frames | "
            f"`{fmt_comma(ue['measured_adaptive_512px_q50_mean_bytes'], 2)} B` (`{fmt_num(ue['measured_adaptive_512px_q50_mean_kb'], 2)} KB`) | "
            f"`{fmt_num(bw_snap['raw_kb'], 2)} KB` | `{fmt_num(bw_snap['raw_kb'], 2)} KB` (local TTS) | "
            f"`{fmt_num(bw_snap['json_wire_kb'], 2)} KB` | `{fmt_num(bw_snap['monthly_120_checks_mb'], 2)} MB` |"
        )
        lines.append(
            f"| Complete Offline (`BarcodeDetector`) | Local EAN/UPC/QR lookup | `0 B` | `0.00 KB` | "
            f"`{fmt_num(bw_off['raw_kb'], 2)} KB` (local TTS) | `0.00 KB` | `{fmt_num(bw_off['monthly_120_checks_mb'], 2)} MB` |"
        )
        lines.append("")
        lines.append(
            f"| Gemini Cloud Pricing Tier (`{fmt_comma(utok['total_tokens_normal_1fps'], 0)}` normal / `{fmt_comma(utok['total_tokens_adaptive_0_5fps'], 0)}` adaptive tokens/check) | "
            "Per-Check (`1.0 fps` Normal) | Per-Check (`0.5 fps` Adaptive) | Monthly (`120` checks) | Annual (`1,440` checks) | 3-Year Cloud (`4,320` checks) |"
        )
        lines.append("|---|---|---|---|---|---|")
        lines.append(
            f"| Standard Gemini 2.5 Flash Paid (`75%` implicit prompt cache) | "
            f"`EUR {fmt_num(pt_std['per_check_eur_normal'], 5)}` (`${fmt_num(pt_std['per_check_usd_normal'], 5)}`) | "
            f"`EUR {fmt_num(pt_std['per_check_eur_adaptive'], 5)}` | `EUR {fmt_num(pt_std['monthly_120_eur'], 2)}` | "
            f"`EUR {fmt_num(pt_std['annual_1440_eur'], 2)}` | `EUR {fmt_num(pt_std['three_year_4320_eur'], 2)}` |"
        )
        lines.append(
            f"| Economy Gemini 2.0 Flash Live Paid | "
            f"`EUR {fmt_num(pt_eco['per_check_eur_normal'], 5)}` (`${fmt_num(pt_eco['per_check_usd_normal'], 5)}`) | "
            f"`EUR {fmt_num(pt_eco['per_check_eur_adaptive'], 5)}` | `EUR {fmt_num(pt_eco['monthly_120_eur'], 2)}` | "
            f"`EUR {fmt_num(pt_eco['annual_1440_eur'], 2)}` | `EUR {fmt_num(pt_eco['three_year_4320_eur'], 2)}` |"
        )
        lines.append(
            f"| Conservative Uncached Native-Audio Ceiling | "
            f"`EUR {fmt_num(pt_ceil['per_check_eur_normal'], 5)}` (`${fmt_num(pt_ceil['per_check_usd_normal'], 5)}`) | "
            f"`EUR {fmt_num(pt_ceil['per_check_eur_adaptive'], 5)}` | `EUR {fmt_num(pt_ceil['monthly_120_eur'], 2)}` | "
            f"`EUR {fmt_num(pt_ceil['annual_1440_eur'], 2)}` | `EUR {fmt_num(pt_ceil['three_year_4320_eur'], 2)}` |"
        )
        lines.append("")
        lines.append("| 3-Year Assistive TCO Option (`4,320` checks) | Upfront Hardware | Annual Cloud / Subscription | 3-Year Total TCO | Effective Monthly TCO | All-In Cost / Check | HoldUp Relative Savings |")
        lines.append("|---|---|---|---|---|---|---|")
        lines.append(
            f"| **HoldUp + Consumer Ray-Ban Meta Gen 2** (standard cached) | `EUR {fmt_comma(hu_tco['hardware_upfront_eur'], 2)}` | "
            f"`EUR {fmt_num(hu_tco['annual_cloud_standard_eur'], 2)} / yr` (pilot band `{ue['annual_1440_checks_cloud_eur_pilot_band']}`) | "
            f"**`EUR {fmt_comma(hu_tco['three_year_tco_standard_eur'], 2)}`** | `EUR {fmt_num(hu_tco['effective_monthly_tco_standard_eur'], 2)} / mo` | "
            f"`EUR {fmt_num(hu_tco['all_in_cost_per_check_standard_eur'], 4)}` | "
            f"Baseline (`{pilot_100['cohort_size_users']}`-user 3-yr pilot: `EUR {fmt_comma(pilot_100['holdup_total_eur'], 2)}`, `{fmt_comma(pilot_100['users_served_per_100_orcam_budget'], 0)}` users per 100-OrCam budget) |"
        )
        lines.append(
            f"| **Dedicated Assistive Camera (OrCam MyEye class midpoint)** | `EUR {fmt_comma(orc_tco['hardware_upfront_eur_midpoint'], 2)}` | "
            f"`EUR {fmt_num(orc_tco['annual_subscription_eur'], 2)} / yr` | `EUR {fmt_comma(orc_tco['three_year_tco_eur_midpoint'], 2)}` | "
            f"`EUR {fmt_num(orc_tco['effective_monthly_tco_midpoint_eur'], 2)} / mo` | `EUR {fmt_num(orc_tco['all_in_cost_per_check_midpoint_eur'], 4)}` | "
            f"**`{fmt_num(orc_tco['holdup_savings_pct'], 1)}%` lower (`{fmt_num(orc_tco['holdup_cost_reduction_multiple'], 1)}x` cost reduction, saves `EUR {fmt_comma(orc_tco['holdup_savings_eur'], 2)}` / user)** |"
        )
        aira_ann = round(aira_tco["daily_plan_monthly_eur"] * 12.0, 2) if aira_tco["daily_plan_monthly_eur"] is not None else None
        aira_per_chk = (
            round(aira_tco["three_year_tco_phone_only_eur"] / tco["total_checks"], 4)
            if aira_tco["three_year_tco_phone_only_eur"] is not None and tco["total_checks"]
            else None
        )
        lines.append(
            f"| **Paid Visual Interpreter (Aira daily meds plan, phone / with glasses)** | `EUR 0.00` / `EUR {fmt_comma(hu_tco['hardware_upfront_eur'], 2)}` | "
            f"`EUR {fmt_comma(aira_ann, 2)} / yr` (`EUR {fmt_num(aira_tco['daily_plan_monthly_eur'], 2)} / mo`) | "
            f"`EUR {fmt_comma(aira_tco['three_year_tco_phone_only_eur'], 2)}` / `EUR {fmt_comma(aira_tco['three_year_tco_with_glasses_eur'], 2)}` | "
            f"`EUR {fmt_num(aira_tco['daily_plan_monthly_eur'], 2)} / mo` | `EUR {fmt_num(aira_per_chk, 4)}` | "
            f"**`{fmt_num(aira_tco['holdup_savings_vs_daily_plan_pct'], 1)}%` lower** + zero stranger prescription exposure |"
        )
        lines.append("")

    for spec in EXTENDED_ARTIFACT_SPECS:
        sid = spec["id"]
        if sid not in artifacts:
            continue
        section_num += 1
        suite = artifacts[sid]
        lines.append(f"{H3} 4.{section_num} {spec['title']} (`eval/{spec['filename']}`)")
        lines.append("")
        lines.append("| Stress Suite Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Model | `{suite['model']}` |")
        if sid == "coaching_trajectories":
            lines.append(f"| Trajectories / total `verify()` calls | `{suite['n_trajectories']}` / `{suite['total_verify_calls']}` |")
            lines.append(
                f"| Stage A pre-coaching abstention rate | `{fmt_pct(suite['pre_coaching_abstention_rate'])}` "
                f"(`{fmt_num(suite['pre_coaching_abstentions'], 0)} / {suite['n_trajectories']}`) |"
            )
            lines.append(
                f"| Stage B post-coaching verdict accuracy | `{fmt_pct(suite['post_coaching_verdict_accuracy'])}` "
                f"(`{fmt_num(suite['post_coaching_matches'], 0)} / {suite['n_trajectories']}`) |"
            )
            lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
            lines.append(
                f"| Latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            lines.append("")
            if suite["trajectories"]:
                lines.append("| Trajectory ID | Stage A Verdict | Stage A Abstained | Stage A Sharpness | Stage B Expected | Stage B Verdict | Stage B Match | Stage B Sharpness |")
                lines.append("|---|---|---|---|---|---|---|---|")
                for tr in suite["trajectories"]:
                    lines.append(
                        f"| `{md_cell(tr['id'])}` | `{md_cell(tr['stage_a_level'] or 'n/a')}` | "
                        f"`{'PASS' if tr['stage_a_abstained'] else ('FAIL' if tr['stage_a_abstained'] is False else 'n/a')}` | "
                        f"`{fmt_num(tr['stage_a_sharpness'], 4)}` | `{md_cell(tr['stage_b_expected_level'] or 'n/a')}` | "
                        f"`{md_cell(tr['stage_b_level'] or 'n/a')}` | "
                        f"`{'PASS' if tr['stage_b_match'] else ('FAIL' if tr['stage_b_match'] is False else 'n/a')}` | "
                        f"`{fmt_num(tr['stage_b_sharpness'], 4)}` |"
                    )
                lines.append("")
            continue

        lines.append(f"| Evaluated cases (`n_cases`) | `{suite['n_cases']}` |")
        lines.append(f"| Verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` (`{suite['verdict_matches']} / {suite['n_cases']}`) |")
        lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
        if sid == "curved_blister_results":
            if suite.get("readable_recall") is not None:
                lines.append(f"| Readable curved / blister recall | `{fmt_pct(suite['readable_recall'])}` |")
            if suite.get("occluded_abstention_rate") is not None:
                lines.append(f"| Foil-glare / rotated-edge abstention rate | `{fmt_pct(suite['occluded_abstention_rate'])}` |")
        elif sid == "lighting_motion_results":
            if suite.get("moderate_degradation_recall") is not None:
                lines.append(f"| Moderate low-light / mild-tremor recall | `{fmt_pct(suite['moderate_degradation_recall'])}` |")
            if suite.get("severe_degradation_abstention_rate") is not None:
                lines.append(f"| Severe blur / near-dark abstention rate | `{fmt_pct(suite['severe_degradation_abstention_rate'])}` |")
        elif sid == "multilingual_labels_results":
            if suite.get("languages_tested"):
                lines.append(f"| Languages tested | `{', '.join(suite['languages_tested'])}` |")
            if suite.get("false_safe_allergen_count") is not None:
                lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
        elif sid == "bystander_privacy_results":
            if suite.get("pii_or_bystander_leak_count") is not None:
                lines.append(f"| PII or bystander leak count | `{suite['pii_or_bystander_leak_count']}` |")
            if suite.get("privacy_pass_rate") is not None:
                lines.append(f"| Red-team privacy pass rate | `{fmt_pct(suite['privacy_pass_rate'])}` |")
        elif sid == "polypharmacy_confusion_results":
            if suite.get("double_dose_catches") is not None:
                lines.append(f"| Double-dose catches | `{suite['double_dose_catches']}` |")
            if suite.get("lasa_strength_catches") is not None:
                lines.append(f"| LASA wrong-strength catches | `{suite['lasa_strength_catches']}` |")
            if suite.get("drug_class_catches") is not None:
                lines.append(f"| Drug-class / allergy avoid catches | `{suite['drug_class_catches']}` |")
        lines.append(
            f"| Latency (p50 / p95 / mean) | "
            f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
        )
        if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
            lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
        lines.append("")
        if suite["rows"]:
            lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Strength | Strength Conf | Confident-Wrong Dose | Latency |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for r in suite["rows"]:
                lines.append(
                    f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                    f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                    f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                    f"{md_cell(r['strength_value'] or 'null')} | "
                    f"`{fmt_num(r['strength_confidence'], 2)}` | "
                    f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                )
            lines.append("")

    for spec in WAVE6_ARTIFACT_SPECS:
        sid = spec["id"]
        if sid not in artifacts:
            continue
        section_num += 1
        suite = artifacts[sid]
        lines.append(f"{H3} 4.{section_num} {spec['title']} (`eval/{spec['filename']}`)")
        lines.append("")
        lines.append("| Benchmark Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Engine / Model | `{suite['model']}` |")
        if sid == "multiframe_recovery_results":
            lines.append(f"| Complementary 2-frame pairs / total `verify()` calls | `{suite['n_pairs']}` / `{suite['total_calls']}` |")
            lines.append(
                f"| Single-frame `[f1]` safe abstention rate | `{fmt_pct(suite['single_frame_safe_abstention_rate'])}` "
                f"(`{fmt_num(suite['single_frame_abstentions'], 0)} / {suite['n_pairs']}`) |"
            )
            lines.append(
                f"| Paired-frame `[f1, f2]` verdict accuracy | `{fmt_pct(suite['paired_frame_verdict_accuracy'])}` "
                f"(`{fmt_num(suite['paired_frame_matches'], 0)} / {suite['n_pairs']}`) |"
            )
            lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
            if suite.get("single_latency_p50_ms") is not None or suite.get("paired_latency_p50_ms") is not None:
                lines.append(
                    f"| Single-frame p50 / Paired-frame p50 latency | "
                    f"`{fmt_ms(suite.get('single_latency_p50_ms'))}` / `{fmt_ms(suite.get('paired_latency_p50_ms'))}` |"
                )
            lines.append(
                f"| Overall latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
                lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
            lines.append("")
            if suite["pairs"]:
                lines.append("| Pair ID | Single-Frame Verdict | Safe Abstention | Paired Expected | Paired Verdict | Paired Match | Single / Paired Latency |")
                lines.append("|---|---|---|---|---|---|---|")
                for pr in suite["pairs"]:
                    lines.append(
                        f"| `{md_cell(pr['id'])}` | `{md_cell(pr['single_level'] or 'n/a')}` | "
                        f"`{'PASS' if pr['single_abstained'] else ('FAIL' if pr['single_abstained'] is False else 'n/a')}` | "
                        f"`{md_cell(pr['paired_expected_level'] or 'n/a')}` | `{md_cell(pr['paired_level'] or 'n/a')}` | "
                        f"`{'PASS' if pr['paired_match'] else ('FAIL' if pr['paired_match'] is False else 'n/a')}` | "
                        f"`{fmt_ms(pr['single_latency_ms'])}` / `{fmt_ms(pr['paired_latency_ms'])}` |"
                    )
                lines.append("")
            continue

        if sid == "e2e_websocket_live":
            if suite.get("state_broadcast_ms") is not None:
                lines.append(f"| `POST /ingest/state` -> `/hud-ws` & `/live` broadcast latency | `{fmt_ms(suite['state_broadcast_ms'])}` |")
            if suite.get("ingest_frame_ms") is not None:
                lines.append(f"| `POST /ingest/frame` -> `FrameRing(8)` ingest latency | `{fmt_ms(suite['ingest_frame_ms'])}` |")
            lines.append(
                f"| End-to-end `/ingest/frame -> /api/verify -> /hud-ws` latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            if suite.get("verdict_matches") is not None and (suite.get("n_verify_checks") or 0) > 0:
                lines.append(
                    f"| End-to-end fixture verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` "
                    f"(`{suite['verdict_matches']} / {suite['n_verify_checks']}`) |"
                )
            if suite.get("hud_received_all_verdicts") is not None:
                lines.append(f"| Session-less `/hud-ws` received all waveguide verdicts | `{suite['hud_received_all_verdicts']}` |")
            if suite.get("live_ws_open_ms") is not None:
                lines.append(f"| Live `/live` WebSocket connect-to-open latency | `{fmt_ms(suite['live_ws_open_ms'])}` |")
            if suite.get("live_first_event_ms") is not None:
                lines.append(f"| Live `/live` turn first audio / coaching event latency | `{fmt_ms(suite['live_first_event_ms'])}` |")
            lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
            lines.append("")
            if suite["rows"]:
                lines.append("| Fixture / Case | Expected Verdict | Predicted Verdict | Match | HUD Received | Confident-Wrong Dose | E2E Latency |")
                lines.append("|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                        f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                        f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                        f"`{r['hud_received'] if r['hud_received'] is not None else 'n/a'}` | "
                        f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                    )
                lines.append("")
            continue

        if sid == "hud_latency_bandwidth":
            lines.append(
                f"| `POST /ingest/frame` + `jpegSharpness` latency (p50 / p95 / p99) | "
                f"`{fmt_ms(suite['ingest_frame_p50_ms'])}` / `{fmt_ms(suite['ingest_frame_p95_ms'])}` / `{fmt_ms(suite['ingest_frame_p99_ms'])}` "
                f"(n = `{fmt_num(suite['ingest_frame_requests'], 0)}`) |"
            )
            lines.append(f"| `FrameRing(8)` max observed length (`ring_max_observed_len`) | `{fmt_num(suite['ring_max_observed_len'], 0)}` |")
            if suite.get("state_fanout_p50_ms") is not None:
                lines.append(
                    f"| `POST /ingest/state` -> `/hud-ws` & `/live` fan-out (p50 / p95 / p99) | "
                    f"`{fmt_ms(suite['state_fanout_p50_ms'])}` / `{fmt_ms(suite['state_fanout_p95_ms'])}` / `{fmt_ms(suite['state_fanout_p99_ms'])}` "
                    f"(n = `{fmt_num(suite['state_fanout_requests'], 0)}`) |"
                )
            lines.append(
                f"| Session-less `/hud-ws` late-join replay latency (p50 / p95) | "
                f"`{fmt_ms(suite['hud_replay_p50_ms'])}` / `{fmt_ms(suite['hud_replay_p95_ms'])}` "
                f"(n = `{fmt_num(suite['hud_late_joins'], 0)}`) |"
            )
            if suite.get("hud_verdict_wire_bytes") is not None:
                lines.append(f"| Waveguide verdict JSON wire payload | `{fmt_comma(suite['hud_verdict_wire_bytes'], 0)} B` |")
            if suite.get("api_stats_p50_ms") is not None or suite.get("api_eval_summary_p50_ms") is not None:
                lines.append(
                    f"| Telemetry `GET /api/stats` / `GET /api/eval-summary` p50 | "
                    f"`{fmt_ms(suite.get('api_stats_p50_ms'))}` / `{fmt_ms(suite.get('api_eval_summary_p50_ms'))}` |"
                )
            lines.append("")
            continue

        if sid == "tts_multilingual_audio":
            lines.append(f"| Synthesized utterances (`n_utterances`) | `{suite['n_utterances']}` |")
            lines.append(f"| HTTP `200` responses | `{fmt_num(suite['http_200_count'], 0)} / {suite['n_utterances']}` |")
            lines.append(
                f"| Valid PCM16 `RIFF/WAVE` utterances | `{fmt_num(suite['valid_wav_count'], 0)} / {suite['n_utterances']}` "
                f"(`{fmt_pct(suite['valid_wav_rate'])}`) |"
            )
            if suite.get("languages_tested"):
                lines.append(f"| Languages tested | `{', '.join(suite['languages_tested'])}` |")
            if suite.get("sample_rate_hz") is not None:
                lines.append(f"| Audio sample rate | `{fmt_comma(suite['sample_rate_hz'], 0)} Hz` |")
            lines.append(
                f"| Synthesis latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            if suite.get("mean_audio_duration_s") is not None:
                lines.append(f"| Mean synthesized audio duration | `{fmt_num(suite['mean_audio_duration_s'], 2)} s` |")
            if suite.get("mean_wav_bytes") is not None:
                lines.append(f"| Mean WAV payload size | `{fmt_comma(suite['mean_wav_bytes'], 0)} B` |")
            lines.append("")
            if suite["rows"]:
                lines.append("| Utterance ID | Language | HTTP Status | Valid WAV | Duration | WAV Bytes | Latency |")
                lines.append("|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    dur_s = f"{fmt_num(r['duration_s'], 2)} s" if r["duration_s"] is not None else "n/a"
                    wb_s = f"{fmt_comma(r['wav_bytes'], 0)} B" if r["wav_bytes"] is not None else "n/a"
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['lang'] or 'n/a')}` | "
                        f"`{fmt_num(r['http_status'], 0)}` | "
                        f"`{'PASS' if r['valid_wav'] else ('FAIL' if r['valid_wav'] is False else 'n/a')}` | "
                        f"`{dur_s}` | `{wb_s}` | `{fmt_ms(r['latency_ms'])}` |"
                    )
                lines.append("")
            continue

        lines.append(f"| Evaluated cases (`n_cases`) | `{suite['n_cases']}` |")
        lines.append(f"| Verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` (`{suite['verdict_matches']} / {suite['n_cases']}`) |")
        lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
        if sid == "allergen_adversarial_results":
            if suite.get("allergen_recall") is not None:
                lines.append(f"| Hidden / scientific allergen recall | `{fmt_pct(suite['allergen_recall'])}` |")
            if suite.get("false_safe_allergen_count") is not None:
                lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
        elif sid == "expiry_formats_results":
            if suite.get("expired_catch_recall") is not None:
                lines.append(f"| Expired-pack catch recall | `{fmt_pct(suite['expired_catch_recall'])}` |")
            if suite.get("expiry_iso_normalization_accuracy") is not None:
                lines.append(f"| ISO `YYYY-MM` / `YYYY-MM-DD` normalization accuracy | `{fmt_pct(suite['expiry_iso_normalization_accuracy'])}` |")
        lines.append(
            f"| Latency (p50 / p95 / mean) | "
            f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
        )
        if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
            lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
        lines.append("")
        if suite["rows"]:
            if sid == "expiry_formats_results":
                lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Expiry | Extracted Strength | Confident-Wrong Dose | Latency |")
                lines.append("|---|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                        f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                        f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                        f"`{md_cell(r.get('expiry_value') or 'null')}` | "
                        f"{md_cell(r['strength_value'] or 'null')} | "
                        f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                    )
            else:
                lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Strength | Strength Conf | Confident-Wrong Dose | Latency |")
                lines.append("|---|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                        f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                        f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                        f"{md_cell(r['strength_value'] or 'null')} | "
                        f"`{fmt_num(r['strength_confidence'], 2)}` | "
                        f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                    )
            lines.append("")

    for spec in WAVE7_ARTIFACT_SPECS:
        sid = spec["id"]
        if sid not in artifacts:
            continue
        section_num += 1
        suite = artifacts[sid]
        lines.append(f"{H3} 4.{section_num} {spec['title']} (`eval/{spec['filename']}`)")
        lines.append("")
        lines.append("| Benchmark Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Engine / Model | `{suite['model']}` |")
        if sid == "concurrent_sessions_results":
            lines.append(f"| Concurrent isolated sessions (`n_concurrent_sessions`) | `{fmt_num(suite.get('n_concurrent_sessions'), 0)}` |")
            lines.append(f"| Concurrent WebSockets (`n_concurrent_websockets`) | `{fmt_num(suite.get('n_concurrent_websockets'), 0)}` |")
            lines.append(f"| Total frames ingested (`total_frames_ingested`) | `{fmt_num(suite.get('total_frames_ingested'), 0)}` |")
            lines.append(f"| Cross-session leak count (`cross_session_leak_count`) | `{fmt_num(suite.get('cross_session_leak_count'), 0)}` |")
            if suite.get("isolation_pass_rate") is not None:
                lines.append(f"| Session isolation pass rate | `{fmt_pct(suite['isolation_pass_rate'])}` |")
            if suite.get("max_ring_len_observed") is not None:
                lines.append(f"| `FrameRing(8)` max observed length | `{fmt_num(suite['max_ring_len_observed'], 0)}` |")
            lines.append(
                f"| Post-disconnect buffered frames (`post_disconnect_buffered_frames`) | "
                f"`{fmt_num(suite.get('post_disconnect_buffered_frames'), 0)}` |"
            )
            lines.append(
                f"| Concurrent frame ingest latency (p50 / p95) | "
                f"`{fmt_ms(suite.get('concurrent_ingest_p50_ms'))}` / `{fmt_ms(suite.get('concurrent_ingest_p95_ms'))}` |"
            )
            lines.append(
                f"| Concurrent HUD/state fan-out latency (p50 / p95) | "
                f"`{fmt_ms(suite.get('concurrent_fanout_p50_ms'))}` / `{fmt_ms(suite.get('concurrent_fanout_p95_ms'))}` |"
            )
            if (
                suite.get("heap_mb_before") is not None
                or suite.get("heap_mb_peak") is not None
                or suite.get("heap_mb_after_close") is not None
            ):
                lines.append(
                    f"| Node heap memory (before / peak / after close) | "
                    f"`{fmt_num(suite.get('heap_mb_before'), 2)} MB` / "
                    f"`{fmt_num(suite.get('heap_mb_peak'), 2)} MB` / "
                    f"`{fmt_num(suite.get('heap_mb_after_close'), 2)} MB` |"
                )
            lines.append("")
            continue

        if sid == "multilingual_coaching_results":
            lines.append(f"| Coaching turns evaluated (`n_turns`) | `{suite['n_turns']}` |")
            if suite.get("languages_tested"):
                lines.append(f"| Languages tested | `{', '.join(suite['languages_tested'])}` |")
            lines.append(f"| Language compliance rate | `{fmt_pct(suite.get('language_compliance_rate'))}` |")
            if suite.get("brevity_compliance_rate") is not None:
                lines.append(f"| Brevity compliance rate | `{fmt_pct(suite['brevity_compliance_rate'])}` |")
            lines.append(f"| Dose hallucination count (`dose_hallucination_count`) | `{fmt_num(suite.get('dose_hallucination_count'), 0)}` |")
            lines.append(f"| Bystander leak count (`bystander_leak_count`) | `{fmt_num(suite.get('bystander_leak_count'), 0)}` |")
            if suite.get("mean_word_count") is not None:
                max_wc_part = f" (max `{suite['max_word_count']}`)" if suite.get("max_word_count") is not None else ""
                lines.append(f"| Mean spoken word count | `{fmt_num(suite['mean_word_count'], 2)}`{max_wc_part} |")
            lines.append(
                f"| Turn latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            if suite.get("tokens_in") is not None or suite.get("tokens_out") is not None:
                lines.append(f"| Tokens (in / out) | `{fmt_num(suite.get('tokens_in'), 1)}` / `{fmt_num(suite.get('tokens_out'), 1)}` |")
            lines.append("")
            if suite["rows"]:
                lines.append("| Turn ID | Lang | Spoken Coaching Cue | Words | Lang Match | Dose Hallucinated | Bystander Leak | Latency |")
                lines.append("|---|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['lang'] or 'n/a')}` | "
                        f"{md_cell(r['spoken_text'] or 'n/a')} | "
                        f"`{fmt_num(r['word_count'], 0)}` | "
                        f"`{'PASS' if r['language_match'] else ('FAIL' if r['language_match'] is False else 'n/a')}` | "
                        f"`{r['dose_hallucinated']}` | `{r['bystander_leaked']}` | `{fmt_ms(r['latency_ms'])}` |"
                    )
                lines.append("")
            continue

        lines.append(f"| Evaluated cases (`n_cases`) | `{suite['n_cases']}` |")
        lines.append(f"| Verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` (`{suite['verdict_matches']} / {suite['n_cases']}`) |")
        lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
        if suite.get("false_safe_allergen_count") is not None:
            lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
        if sid == "orientation_robustness_results":
            if suite.get("upside_down_180_accuracy") is not None:
                lines.append(f"| Upside-down (`180 deg`) verdict accuracy | `{fmt_pct(suite['upside_down_180_accuracy'])}` |")
            if suite.get("sideways_90_270_accuracy") is not None:
                lines.append(f"| Sideways (`90 / 270 deg`) verdict accuracy | `{fmt_pct(suite['sideways_90_270_accuracy'])}` |")
            if suite.get("tilted_off_axis_accuracy") is not None:
                lines.append(f"| Off-axis perspective tilt accuracy | `{fmt_pct(suite['tilted_off_axis_accuracy'])}` |")
        elif sid == "prompt_injection_labels_results":
            if suite.get("hijack_success_count") is not None:
                lines.append(f"| Adversarial hijack success count (`hijack_success_count`) | `{suite['hijack_success_count']}` |")
            if suite.get("injection_resistance_rate") is not None:
                lines.append(f"| Visual prompt-injection resistance rate | `{fmt_pct(suite['injection_resistance_rate'])}` |")
        elif sid == "thermal_fade_wear_results":
            if suite.get("moderate_wear_accuracy") is not None:
                lines.append(f"| Moderate thermal-fade / wear accuracy | `{fmt_pct(suite['moderate_wear_accuracy'])}` |")
            if suite.get("severe_wear_abstention_rate") is not None:
                lines.append(f"| Severe wear / bleached-label abstention rate | `{fmt_pct(suite['severe_wear_abstention_rate'])}` |")
        lines.append(
            f"| Latency (p50 / p95 / mean) | "
            f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
        )
        if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
            lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
        lines.append("")
        if suite["rows"]:
            lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Strength | Strength Conf | Confident-Wrong Dose | Latency |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for r in suite["rows"]:
                lines.append(
                    f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                    f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                    f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                    f"{md_cell(r['strength_value'] or 'null')} | "
                    f"`{fmt_num(r['strength_confidence'], 2)}` | "
                    f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                )
            lines.append("")

    for spec in WAVE8_ARTIFACT_SPECS:
        sid = spec["id"]
        if sid not in artifacts:
            continue
        section_num += 1
        suite = artifacts[sid]
        lines.append(f"{H3} 4.{section_num} {spec['title']} (`eval/{spec['filename']}`)")
        lines.append("")
        lines.append("| Benchmark Metric | Measured Value |")
        lines.append("|---|---|")
        lines.append(f"| Engine / Model | `{suite['model']}` |")
        if sid == "ws_reconnect_resilience":
            lines.append(f"| `/hud-ws` flap reconnect cycles (`n_reconnect_cycles`) | `{fmt_num(suite.get('n_reconnect_cycles'), 0)}` |")
            lines.append(
                f"| 4-message state replay completeness (`replay_completeness_rate`) | "
                f"`{fmt_pct(suite.get('replay_completeness_rate'))}` "
                f"(`{fmt_num(suite.get('complete_replays'), 0)} / {fmt_num(suite.get('n_reconnect_cycles'), 0)}`) |"
            )
            rp50 = f"{fmt_num(suite.get('replay_reconnect_p50_ms'), 3)} ms" if suite.get("replay_reconnect_p50_ms") is not None else "n/a"
            rp95 = f"{fmt_num(suite.get('replay_reconnect_p95_ms'), 3)} ms" if suite.get("replay_reconnect_p95_ms") is not None else "n/a"
            lines.append(f"| Reconnect + 4-message replay latency (p50 / p95) | `{rp50}` / `{rp95}` |")
            if suite.get("replay_wire_bytes_per_cycle") is not None:
                lines.append(f"| Replay wire payload per cycle | `{fmt_comma(suite['replay_wire_bytes_per_cycle'], 0)} B` |")
            lines.append(f"| Hostile / malformed payload storm (`n_hostile_payloads`) | `{fmt_num(suite.get('n_hostile_payloads'), 0)}` |")
            lines.append(
                f"| Graceful payload rejection rate (`graceful_rejection_rate`) | "
                f"`{fmt_pct(suite.get('graceful_rejection_rate'))}` "
                f"(`{fmt_num(suite.get('graceful_rejections'), 0)} / {fmt_num(suite.get('n_hostile_payloads'), 0)}`) |"
            )
            lines.append(f"| Server crash count (`server_crash_count`) | `{fmt_num(suite.get('server_crash_count'), 0)}` |")
            if suite.get("ping_pong_after_storm_ms") is not None:
                lines.append(f"| Post-storm `/live` ping-pong latency | `{fmt_num(suite['ping_pong_after_storm_ms'], 3)} ms` |")
            lines.append(
                f"| Post-storm buffered `FrameRing` frames (`post_storm_buffered_frames`) | "
                f"`{fmt_num(suite.get('post_storm_buffered_frames'), 0)}` |"
            )
            if suite.get("leaked_hud_refs") is not None:
                lines.append(f"| Leaked HUD WebSocket references | `{fmt_num(suite['leaked_hud_refs'], 0)}` |")
            lines.append("")
            continue

        if sid == "spoken_verdict_clarity_results":
            lines.append(f"| Evaluated spoken-verdict cases (`n_cases`) | `{suite['n_cases']}` |")
            lines.append(
                f"| Verdict accuracy | `{fmt_pct(suite.get('verdict_accuracy'))}` "
                f"(`{fmt_num(suite.get('verdict_matches'), 0)} / {suite['n_cases']}`) |"
            )
            lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
            lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
            hw_detail = (
                f" (mean `{fmt_num(suite['mean_headline_words'], 2)}`, max `{suite['max_headline_words']}`)"
                if suite.get("mean_headline_words") is not None and suite.get("max_headline_words") is not None
                else ""
            )
            lines.append(
                f"| Waveguide headline word-cap (`<= {suite['headline_word_cap']}` words) pass rate | "
                f"`{fmt_pct(suite.get('headline_word_cap_pass_rate'))}`{hw_detail} |"
            )
            ss_detail = (
                f" (mean `{fmt_num(suite['mean_speech_sentences'], 2)}`, max `{suite['max_speech_sentences']}`)"
                if suite.get("mean_speech_sentences") is not None and suite.get("max_speech_sentences") is not None
                else ""
            )
            lines.append(
                f"| Spoken verdict sentence-cap (`<= {suite['speech_sentence_cap']}` sentences) pass rate | "
                f"`{fmt_pct(suite.get('speech_sentence_cap_pass_rate'))}`{ss_detail} |"
            )
            lines.append(
                f"| Mean / Min / Max clarity score (1 to 5) | "
                f"`{fmt_num(suite.get('mean_clarity_score'), 2)}` / "
                f"`{fmt_num(suite.get('min_clarity_score'), 0)}` / "
                f"`{fmt_num(suite.get('max_clarity_score'), 0)}` |"
            )
            if suite.get("auditory_distinction_pass_rate") is not None:
                lines.append(f"| Auditory verdict distinction pass rate | `{fmt_pct(suite['auditory_distinction_pass_rate'])}` |")
            lines.append(f"| Non-medical EU MDR boundary pass rate | `{fmt_pct(suite.get('non_medical_boundary_pass_rate'))}` |")
            lines.append(f"| Blind listener actionability pass rate | `{fmt_pct(suite.get('blind_actionability_pass_rate'))}` |")
            lines.append(
                f"| Judge latency (p50 / p95 / mean) | "
                f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
            )
            if suite.get("tokens_in") is not None or suite.get("tokens_out") is not None:
                lines.append(f"| Tokens (in / out) | `{fmt_num(suite.get('tokens_in'), 1)}` / `{fmt_num(suite.get('tokens_out'), 1)}` |")
            lines.append("")
            if suite["rows"]:
                lines.append(
                    "| Case ID | Expected | Predicted | Match | Headline Words | Speech Sentences | Clarity | MDR Safe | Blind Actionable | Latency |"
                )
                lines.append("|---|---|---|---|---|---|---|---|---|---|")
                for r in suite["rows"]:
                    cl_txt = f"{r['clarity_score']}/5" if r.get("clarity_score") is not None else "n/a"
                    lines.append(
                        f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                        f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                        f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                        f"`{fmt_num(r['headline_word_count'], 0)}` | "
                        f"`{fmt_num(r['speech_sentence_count'], 0)}` | "
                        f"`{cl_txt}` | "
                        f"`{'PASS' if r['non_medical_boundary_safe'] else ('FAIL' if r['non_medical_boundary_safe'] is False else 'n/a')}` | "
                        f"`{'PASS' if r['actionable_for_blind_listener'] else ('FAIL' if r['actionable_for_blind_listener'] is False else 'n/a')}` | "
                        f"`{fmt_ms(r['latency_ms'])}` |"
                    )
                lines.append("")
            continue

        lines.append(f"| Evaluated cases (`n_cases`) | `{suite['n_cases']}` |")
        lines.append(f"| Verdict accuracy | `{fmt_pct(suite['verdict_accuracy'])}` (`{suite['verdict_matches']} / {suite['n_cases']}`) |")
        lines.append(f"| Confident-wrong dose count (`STRENGTH_MIN_CONF = 0.80`) | `{suite['confident_wrong_dose_count']}` |")
        if suite.get("false_safe_allergen_count") is not None:
            lines.append(f"| False-safe allergen count | `{suite['false_safe_allergen_count']}` |")
        if sid == "blister_strip_cuts_results":
            if suite.get("intact_tile_accuracy") is not None:
                lines.append(f"| Intact blister-tile accuracy (`intact_tile_accuracy`) | `{fmt_pct(suite['intact_tile_accuracy'])}` |")
            if suite.get("truncated_abstention_rate") is not None:
                lines.append(f"| Scissor-cut / popped-digit abstention rate (`truncated_abstention_rate`) | `{fmt_pct(suite['truncated_abstention_rate'])}` |")
        elif sid == "two_boxes_in_frame_results":
            if suite.get("foreground_focus_accuracy") is not None:
                lines.append(f"| Held foreground-box focus accuracy (`foreground_focus_accuracy`) | `{fmt_pct(suite['foreground_focus_accuracy'])}` |")
            if suite.get("multi_box_safety_rate") is not None:
                lines.append(f"| Multi-box conflict safety rate (`multi_box_safety_rate`) | `{fmt_pct(suite['multi_box_safety_rate'])}` |")
            if suite.get("false_match_on_conflict_count") is not None:
                lines.append(f"| False `match` on conflicting boxes (`false_match_on_conflict_count`) | `{suite['false_match_on_conflict_count']}` |")
        elif sid == "cellophane_tremor_results":
            if suite.get("moderate_compound_accuracy") is not None:
                lines.append(f"| Moderate compound glare + tremor accuracy (`moderate_compound_accuracy`) | `{fmt_pct(suite['moderate_compound_accuracy'])}` |")
            if suite.get("severe_compound_abstention_rate") is not None:
                lines.append(f"| Severe compound glare + tremor abstention rate (`severe_compound_abstention_rate`) | `{fmt_pct(suite['severe_compound_abstention_rate'])}` |")
        lines.append(
            f"| Latency (p50 / p95 / mean) | "
            f"`{fmt_ms(suite['latency_ms']['p50'])}` / `{fmt_ms(suite['latency_ms']['p95'])}` / `{fmt_ms(suite['latency_ms']['mean'])}` |"
        )
        if suite["tokens_in"] is not None or suite["tokens_out"] is not None:
            lines.append(f"| Tokens (in / out) | `{fmt_num(suite['tokens_in'], 1)}` / `{fmt_num(suite['tokens_out'], 1)}` |")
        lines.append("")
        if suite["rows"]:
            lines.append("| Case ID | Expected Verdict | Predicted Verdict | Match | Extracted Strength | Strength Conf | Confident-Wrong Dose | Latency |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for r in suite["rows"]:
                lines.append(
                    f"| `{md_cell(r['id'])}` | `{md_cell(r['expected_level'] or 'n/a')}` | "
                    f"`{md_cell(r['predicted_level'] or 'n/a')}` | "
                    f"`{'PASS' if r['verdict_match'] else ('FAIL' if r['verdict_match'] is False else 'n/a')}` | "
                    f"{md_cell(r['strength_value'] or 'null')} | "
                    f"`{fmt_num(r['strength_confidence'], 2)}` | "
                    f"`{r['confident_wrong_dose']}` | `{fmt_ms(r['latency_ms'])}` |"
                )
            lines.append("")

    if section_num == 0:
        lines.append("No JSON artifacts are currently present in `eval/`. Run the reproduction commands below to populate.")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"{H2} 5. Reproduction Commands")
    lines.append("")
    lines.append(
        "Re-compiling `eval/combined_summary.json` and `docs/EVAL.md` from all currently present `eval/*.json` "
        "files makes zero network calls and completes in under 0.1 seconds:"
    )
    lines.append("")
    lines.append("```bash")
    lines.append("/venv/bin/python3 eval/compile_eval_report.py")
    lines.append("```")
    lines.append("")
    lines.append("To regenerate individual live Gemini measurement artifacts before compiling:")
    lines.append("")
    lines.append("```bash")
    lines.append("set -a; . $HOME/momin/.env; set +a")
    lines.append("export PATH=\"/tmp/fleet-silas/node/bin:$HOME/.local/bin:$PATH\"")
    for spec in ARTIFACT_SPECS:
        lines.append(spec["repro_cmd"])
    for spec in EXTENDED_ARTIFACT_SPECS:
        if spec["id"] in artifacts:
            lines.append(spec["repro_cmd"])
    for spec in WAVE6_ARTIFACT_SPECS:
        if spec["id"] in artifacts:
            lines.append(spec["repro_cmd"])
    for spec in WAVE7_ARTIFACT_SPECS:
        if spec["id"] in artifacts:
            lines.append(spec["repro_cmd"])
    for spec in WAVE8_ARTIFACT_SPECS:
        if spec["id"] in artifacts:
            lines.append(spec["repro_cmd"])
    lines.append("/venv/bin/python3 eval/compile_eval_report.py")
    lines.append("```")
    lines.append("")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile HoldUp evaluation JSON artifacts into combined_summary.json and docs/EVAL.md")
    parser.add_argument("--eval-dir", type=pathlib.Path, default=DEFAULT_EVAL_DIR)
    parser.add_argument("--out-json", type=pathlib.Path, default=DEFAULT_OUT_JSON)
    parser.add_argument("--out-md", type=pathlib.Path, default=DEFAULT_OUT_MD)
    args = parser.parse_args(argv)

    compiled = compile_summary(args.eval_dir)
    md_text = render_markdown(compiled)

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.parent.mkdir(parents=True, exist_ok=True)

    args.out_json.write_text(json.dumps(compiled, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.out_md.write_text(md_text, encoding="utf-8")

    ext_note = (
        f" + {len(compiled['extended_suites_present'])} extended ({compiled['extended_suites_present']})"
        if compiled["extended_suites_present"]
        else ""
    )
    w6_note = (
        f" + {len(compiled['wave6_suites_present'])} wave6 ({compiled['wave6_suites_present']})"
        if compiled["wave6_suites_present"]
        else ""
    )
    w7_note = (
        f" + {len(compiled['wave7_suites_present'])} wave7 ({compiled['wave7_suites_present']})"
        if compiled["wave7_suites_present"]
        else ""
    )
    w8_note = (
        f" + {len(compiled['wave8_suites_present'])} wave8 ({compiled['wave8_suites_present']})"
        if compiled["wave8_suites_present"]
        else ""
    )
    print(
        f"Compiled {len(compiled['suites_present'])}/{len(ARTIFACT_SPECS)} artifacts "
        f"({compiled['suites_present']}){ext_note}{w6_note}{w7_note}{w8_note} -> {args.out_json} and {args.out_md}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
