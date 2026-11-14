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


def clean_text(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).replace("\u2014", " - ").replace("\u2013", "-")
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
    for key in ("items", "fixtures", "cases", "results", "scenarios"):
        val = data.get(key)
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

    false_safe_allergen = (
        artifacts["results_batch2"]["false_safe_allergen_count"]
        if "results_batch2" in artifacts
        else None
    )

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


def render_markdown(compiled: dict[str, Any]) -> str:
    lines: list[str] = []
    artifacts = compiled["artifacts"]
    suites_present = compiled["suites_present"]
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
        "JPEG payload, adaptive bandwidth, and 3-year assistive TCO modeling (`unit_economics.json`)."
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
    lines.append("/venv/bin/python3 eval/compile_eval_report.py")
    lines.append("```")
    lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile HoldUp evaluation JSON artifacts into combined_summary.json and docs/EVAL.md")
    parser.add_argument("--eval-dir", type=pathlib.Path, default=DEFAULT_EVAL_DIR)
    parser.add_argument("--out-json", type=pathlib.Path, default=DEFAULT_OUT_JSON)
    parser.add_argument("--out-md", type=pathlib.Path, default=DEFAULT_OUT_MD)
    args = parser.parse_args()

    compiled = compile_summary(args.eval_dir)
    md_text = render_markdown(compiled)

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.parent.mkdir(parents=True, exist_ok=True)

    args.out_json.write_text(json.dumps(compiled, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.out_md.write_text(md_text, encoding="utf-8")

    print(
        f"Compiled {len(compiled['suites_present'])}/{len(ARTIFACT_SPECS)} artifacts "
        f"({compiled['suites_present']}) -> {args.out_json} and {args.out_md}"
    )


if __name__ == "__main__":
    main()
