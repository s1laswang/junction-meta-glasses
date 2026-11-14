import copy
import json
import math
import pathlib
import re
import statistics
import unittest
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_EVAL_DIR = REPO_ROOT / "eval"
SAFETY_TS_PATH = REPO_ROOT / "server" / "src" / "safety.ts"
CALIBRATION_JSON_PATH = DEFAULT_EVAL_DIR / "calibration_curve.json"
UNIT_ECONOMICS_JSON_PATH = DEFAULT_EVAL_DIR / "unit_economics.json"
COMBINED_SUMMARY_JSON_PATH = DEFAULT_EVAL_DIR / "combined_summary.json"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
TYPES_TS_PATH = REPO_ROOT / "shared" / "types.ts"

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
STRING_FIELD_REF = f"{HASH_CHAR}/$defs/stringField"
IGNORED_EVAL_SUBDIRS = frozenset({"__pycache__", "out", "synthetic"})

EXPECTED_STRENGTH_MIN_CONF = 0.80
MAX_CALIBRATION_ECE = 0.05
MAX_CALIBRATION_BRIER = 0.02
VERDICT_ACCURACY_TOLERANCE = 0.002
MIN_SAVINGS_VS_ORCAM_PCT = 85.0
MIN_JPEG_BANDWIDTH_SAVINGS_PCT = 75.0

EXPECTED_LABEL_READ_REQUIRED_FIELDS = (
    "kind",
    "product",
    "ingredient",
    "strength",
    "dosing",
    "expiry",
    "allergens",
    "barcode",
    "readability",
)
EXPECTED_LABEL_READ_OPTIONAL_FIELDS = ("guidance",)
EXPECTED_LABEL_READ_ALL_FIELDS = (
    *EXPECTED_LABEL_READ_REQUIRED_FIELDS,
    *EXPECTED_LABEL_READ_OPTIONAL_FIELDS,
)
EXPECTED_LABEL_KINDS = ("medication", "food", "other", "unreadable")
EXPECTED_STRING_CONFIDENCE_FIELDS = (
    "product",
    "ingredient",
    "strength",
    "dosing",
    "expiry",
    "barcode",
)


def _is_exact_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def _is_finite_number(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val))


def _collect_eval_json_files(eval_dir: pathlib.Path, pattern: str = "*.json") -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for path in sorted(eval_dir.glob(pattern)):
        rel_parts = path.relative_to(eval_dir).parts
        if any(part in IGNORED_EVAL_SUBDIRS or part.startswith(".") for part in rel_parts[:-1]):
            continue
        if path.name.startswith("."):
            continue
        if path.is_file():
            found.append(path)
    return found


def extract_ts_numeric_const(ts_text: str, const_name: str) -> float | None:
    pattern = re.compile(
        rf"\b(?:export\s+)?const\s+{re.escape(const_name)}\s*(?::\s*number\s*)?=\s*([0-9]+(?:\.[0-9]+)?)\s*;"
    )
    match = pattern.search(ts_text)
    if not match:
        return None
    return float(match.group(1))


def extract_ts_label_read_fields(types_ts_text: str) -> tuple[list[str], list[str]] | None:
    block_match = re.search(r"export\s+type\s+LabelRead\s*=\s*\{([^}]*)\}", types_ts_text, re.DOTALL)
    if not block_match:
        return None
    body = block_match.group(1)
    required_fields: list[str] = []
    optional_fields: list[str] = []
    for prop_match in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:", body):
        field_name = prop_match.group(1)
        is_optional = prop_match.group(2) == "?"
        if is_optional:
            optional_fields.append(field_name)
        else:
            required_fields.append(field_name)
    return required_fields, optional_fields


def audit_calibration_consistency(
    safety_ts_text: str,
    calibration_data: dict[str, Any],
) -> list[str]:
    errors: list[str] = []

    safety_conf = extract_ts_numeric_const(safety_ts_text, "STRENGTH_MIN_CONF")
    if safety_conf is None:
        errors.append("STRENGTH_MIN_CONF constant not found in server/src/safety.ts")
        return errors
    if abs(safety_conf - EXPECTED_STRENGTH_MIN_CONF) >= 1e-9:
        errors.append(
            f"server/src/safety.ts STRENGTH_MIN_CONF expected {EXPECTED_STRENGTH_MIN_CONF:.2f}, got {safety_conf}"
        )

    summary = calibration_data.get("summary")
    if not isinstance(summary, dict):
        errors.append("calibration_curve.json missing summary object")
        return errors

    prod_conf = summary.get("production_strength_min_conf")
    if not _is_finite_number(prod_conf):
        errors.append(f"calibration_curve.json production_strength_min_conf invalid: {prod_conf!r}")
    elif abs(float(prod_conf) - safety_conf) >= 1e-9:
        errors.append(
            f"production_strength_min_conf ({prod_conf}) != STRENGTH_MIN_CONF ({safety_conf})"
        )

    at_080 = summary.get("at_production_threshold_0_80")
    if not isinstance(at_080, dict):
        errors.append("calibration_curve.json missing summary.at_production_threshold_0_80 object")
    else:
        thr = at_080.get("threshold")
        if not _is_finite_number(thr) or abs(float(thr) - safety_conf) >= 1e-9:
            errors.append(
                f"at_production_threshold_0_80.threshold ({thr!r}) != STRENGTH_MIN_CONF ({safety_conf})"
            )
        wrong_doses = at_080.get("confident_wrong_dose_count")
        if not _is_exact_int(wrong_doses) or wrong_doses != 0:
            errors.append(
                f"at_production_threshold_0_80.confident_wrong_dose_count expected 0, got {wrong_doses!r}"
            )
        sel_risk = at_080.get("selective_risk")
        if _is_finite_number(sel_risk) and float(sel_risk) != 0.0:
            errors.append(
                f"at_production_threshold_0_80.selective_risk expected 0.0, got {sel_risk!r}"
            )

    for curve_key, container in (
        ("summary.threshold_sweep", summary.get("threshold_sweep")),
        ("threshold_curve", calibration_data.get("threshold_curve")),
    ):
        if container is None:
            continue
        if not isinstance(container, list) or not container:
            errors.append(f"calibration_curve.json {curve_key} must be a non-empty list")
            continue
        matched_rows = [
            row
            for row in container
            if isinstance(row, dict)
            and _is_finite_number(row.get("threshold"))
            and abs(float(row["threshold"]) - safety_conf) < 1e-9
        ]
        if not matched_rows:
            errors.append(f"calibration_curve.json {curve_key} missing threshold {safety_conf:.2f}")
        elif isinstance(at_080, dict) and matched_rows[0] != at_080:
            errors.append(f"calibration_curve.json {curve_key} row at {safety_conf:.2f} != at_production_threshold_0_80")

    ece = summary.get("ece")
    if not _is_finite_number(ece):
        errors.append(f"calibration_curve.json summary.ece must be a finite number, got {ece!r}")
    elif not (0.0 <= float(ece) < MAX_CALIBRATION_ECE):
        errors.append(
            f"calibration_curve.json summary.ece expected in [0.0, {MAX_CALIBRATION_ECE}), got {ece}"
        )

    brier_raw = summary.get("brier_score") if "brier_score" in summary else summary.get("brier")
    if not _is_finite_number(brier_raw):
        errors.append(
            f"calibration_curve.json summary brier_score/brier must be a finite number, got {brier_raw!r}"
        )
    elif not (0.0 <= float(brier_raw) < MAX_CALIBRATION_BRIER):
        errors.append(
            f"calibration_curve.json summary brier expected in [0.0, {MAX_CALIBRATION_BRIER}), got {brier_raw}"
        )

    items = calibration_data.get("items")
    total_items = summary.get("total_items")
    if isinstance(items, list) and _is_exact_int(total_items) and total_items > 0:
        if len(items) != total_items:
            errors.append(f"calibration_curve.json len(items)={len(items)} != total_items={total_items}")
        readable_n = summary.get("readable_items")
        unreadable_n = summary.get("unreadable_items")
        if _is_exact_int(readable_n) and _is_exact_int(unreadable_n):
            if readable_n + unreadable_n != total_items:
                errors.append(
                    f"calibration_curve.json readable_items ({readable_n}) + unreadable_items ({unreadable_n}) != {total_items}"
                )
        if _is_finite_number(brier_raw) and all(
            isinstance(it, dict)
            and _is_finite_number(it.get("strength_confidence"))
            and isinstance(it.get("strength_match"), bool)
            for it in items
        ):
            recomputed_brier = statistics.mean(
                (float(it["strength_confidence"]) - (1.0 if it["strength_match"] else 0.0)) ** 2
                for it in items
            )
            if abs(float(brier_raw) - recomputed_brier) >= 0.001:
                errors.append(
                    f"calibration_curve.json brier ({brier_raw}) != recomputed ({recomputed_brier:.6f})"
                )

    cal_bins = calibration_data.get("calibration_bins")
    if isinstance(cal_bins, list) and _is_exact_int(total_items) and total_items > 0 and _is_finite_number(ece):
        bin_count_sum = sum(int(b["count"]) for b in cal_bins if isinstance(b, dict) and _is_exact_int(b.get("count")))
        if bin_count_sum != total_items:
            errors.append(f"calibration_curve.json calibration_bins count sum {bin_count_sum} != {total_items}")
        elif all(
            isinstance(b, dict)
            and _is_finite_number(b.get("mean_confidence"))
            and _is_finite_number(b.get("empirical_accuracy"))
            for b in cal_bins
        ):
            recomputed_ece = sum(
                (int(b["count"]) / total_items)
                * abs(float(b["empirical_accuracy"]) - float(b["mean_confidence"]))
                for b in cal_bins
            )
            if abs(float(ece) - recomputed_ece) >= 0.001:
                errors.append(
                    f"calibration_curve.json ece ({ece}) != recomputed ({recomputed_ece:.6f})"
                )

    return errors


def _audit_summary_rate_fields(
    node: Any,
    filename: str,
    json_path: str,
    errors: list[str],
) -> int:
    checked = 0
    if isinstance(node, dict):
        for key, val in node.items():
            sub_path = f"{json_path}.{key}"
            if key.endswith("_rate") or key.endswith("_accuracy"):
                checked += 1
                if not _is_finite_number(val):
                    errors.append(
                        f"{filename}:{sub_path} must be a finite number in [0.0, 1.0], got {val!r}"
                    )
                elif not (0.0 <= float(val) <= 1.0):
                    errors.append(
                        f"{filename}:{sub_path} expected rate in [0.0, 1.0], got {val}"
                    )
            else:
                checked += _audit_summary_rate_fields(val, filename, sub_path, errors)
    elif isinstance(node, list):
        for idx, item in enumerate(node):
            checked += _audit_summary_rate_fields(item, filename, f"{json_path}[{idx}]", errors)
    return checked


def audit_results_summary_invariants(data: dict[str, Any], filename: str) -> dict[str, Any]:
    errors: list[str] = []
    checked_verdict_accuracy = False
    checked_latency_pair = False
    extra_quantile_pairs = 0
    checked_rate_fields = 0

    summary = data.get("summary")
    if not isinstance(summary, dict):
        return {
            "filename": filename,
            "errors": errors,
            "checked_verdict_accuracy": False,
            "checked_latency_pair": False,
            "extra_quantile_pairs": 0,
            "checked_rate_fields": 0,
        }

    checked_rate_fields = _audit_summary_rate_fields(summary, filename, "$.summary", errors)

    has_n_items = "n_items" in summary
    has_n_cases = "n_cases" in summary
    if "verdict_matches" in summary and (has_n_items or has_n_cases):
        checked_verdict_accuracy = True
        denom_key = "n_items" if has_n_items else "n_cases"
        denom = summary.get(denom_key)
        vm = summary.get("verdict_matches")
        va = summary.get("verdict_accuracy")

        if has_n_items and has_n_cases:
            ni_both = summary.get("n_items")
            nc_both = summary.get("n_cases")
            if not _is_exact_int(ni_both) or not _is_exact_int(nc_both) or ni_both != nc_both:
                errors.append(
                    f"{filename}: summary.n_items ({ni_both!r}) != summary.n_cases ({nc_both!r})"
                )

        if not _is_exact_int(denom) or denom <= 0:
            errors.append(f"{filename}: summary.{denom_key} must be a positive integer, got {denom!r}")
        elif not _is_exact_int(vm):
            errors.append(f"{filename}: summary.verdict_matches must be an integer, got {vm!r}")
        else:
            if not (0 <= vm <= denom):
                errors.append(
                    f"{filename}: expected 0 <= verdict_matches <= {denom_key}, got verdict_matches={vm}, {denom_key}={denom}"
                )
            if not _is_finite_number(va):
                errors.append(
                    f"{filename}: summary.verdict_accuracy must be a finite number, got {va!r}"
                )
            else:
                expected_acc = vm / denom
                if not (0.0 <= float(va) <= 1.0):
                    errors.append(
                        f"{filename}: summary.verdict_accuracy out of [0, 1]: {va}"
                    )
                if abs(float(va) - expected_acc) >= VERDICT_ACCURACY_TOLERANCE:
                    errors.append(
                        f"{filename}: abs(verdict_accuracy ({va}) - verdict_matches/{denom_key} ({expected_acc:.6f})) >= {VERDICT_ACCURACY_TOLERANCE}"
                    )

            items = data.get("items")
            if isinstance(items, list):
                if len(items) != denom:
                    errors.append(
                        f"{filename}: len(items)={len(items)} != summary.{denom_key}={denom}"
                    )
                elif items and all(isinstance(it, dict) and isinstance(it.get("verdict_match"), bool) for it in items):
                    item_matches = sum(1 for it in items if it["verdict_match"] is True)
                    if item_matches != vm:
                        errors.append(
                            f"{filename}: sum(items.verdict_match)={item_matches} != summary.verdict_matches={vm}"
                        )

    if "latency_p50_ms" in summary and "latency_p95_ms" in summary:
        p50 = summary.get("latency_p50_ms")
        p95 = summary.get("latency_p95_ms")
        if p50 is not None or p95 is not None:
            checked_latency_pair = True
            if not _is_finite_number(p50) or not _is_finite_number(p95):
                errors.append(
                    f"{filename}: latency_p50_ms ({p50!r}) and latency_p95_ms ({p95!r}) must be finite numbers"
                )
            elif not (0.0 < float(p50) <= float(p95)):
                errors.append(
                    f"{filename}: expected 0 < latency_p50_ms <= latency_p95_ms, got p50={p50}, p95={p95}"
                )

    for key, val_p50 in summary.items():
        if not key.endswith("p50_ms") or key == "latency_p50_ms":
            continue
        key_p95 = key[:-6] + "p95_ms"
        if key_p95 not in summary:
            continue
        val_p95 = summary.get(key_p95)
        if val_p50 is None and val_p95 is None:
            continue
        extra_quantile_pairs += 1
        if not _is_finite_number(val_p50) or not _is_finite_number(val_p95):
            errors.append(f"{filename}: {key} ({val_p50!r}) and {key_p95} ({val_p95!r}) must be finite numbers")
        elif not (0.0 < float(val_p50) <= float(val_p95)):
            errors.append(
                f"{filename}: expected 0 < {key} <= {key_p95}, got {val_p50} vs {val_p95}"
            )
        key_p99 = key[:-6] + "p99_ms"
        if key_p99 in summary and summary.get(key_p99) is not None and _is_finite_number(val_p95):
            val_p99 = summary.get(key_p99)
            if not _is_finite_number(val_p99) or not (float(val_p95) <= float(val_p99)):
                errors.append(
                    f"{filename}: expected {key_p95} <= {key_p99}, got {val_p95} vs {val_p99!r}"
                )

    return {
        "filename": filename,
        "errors": errors,
        "checked_verdict_accuracy": checked_verdict_accuracy,
        "checked_latency_pair": checked_latency_pair,
        "extra_quantile_pairs": extra_quantile_pairs,
        "checked_rate_fields": checked_rate_fields,
    }


def audit_unit_economics_tco(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    hs = data.get("headline_summary") if isinstance(data.get("headline_summary"), dict) else {}
    tco_cmp = data.get("three_year_tco_comparison") if isinstance(data.get("three_year_tco_comparison"), dict) else {}
    opts = tco_cmp.get("options") if isinstance(tco_cmp.get("options"), dict) else {}
    holdup_opt = (
        opts.get("holdup_consumer_rayban_meta_gen2")
        if isinstance(opts.get("holdup_consumer_rayban_meta_gen2"), dict)
        else {}
    )
    holdup_3yr_map = (
        holdup_opt.get("three_year_tco_eur")
        if isinstance(holdup_opt.get("three_year_tco_eur"), dict)
        else {}
    )
    orcam_opt = (
        opts.get("dedicated_assistive_camera_orcam_class")
        if isinstance(opts.get("dedicated_assistive_camera_orcam_class"), dict)
        else {}
    )
    bw = data.get("bandwidth_per_12s_check") if isinstance(data.get("bandwidth_per_12s_check"), dict) else {}
    normal_bw = bw.get("normal_mode") if isinstance(bw.get("normal_mode"), dict) else {}
    slow_bw = (
        bw.get("slow_network_adaptive_mode")
        if isinstance(bw.get("slow_network_adaptive_mode"), dict)
        else {}
    )

    holdup_3yr = (
        hs.get("tco_3yr_holdup_rayban_meta_gen2_eur")
        if "tco_3yr_holdup_rayban_meta_gen2_eur" in hs
        else data.get("holdup_3yr_eur", holdup_3yr_map.get("standard_cached_100pct_cloud"))
    )
    orcam_mid_3yr = (
        hs.get("tco_3yr_orcam_myeye_midpoint_eur")
        if "tco_3yr_orcam_myeye_midpoint_eur" in hs
        else data.get("orcam_midpoint_3yr_eur", orcam_opt.get("three_year_tco_eur_midpoint"))
    )
    savings_pct = (
        hs.get("tco_savings_vs_orcam_midpoint_pct")
        if "tco_savings_vs_orcam_midpoint_pct" in hs
        else data.get("savings_vs_orcam_pct", orcam_opt.get("holdup_savings_vs_midpoint_pct"))
    )

    if not _is_finite_number(holdup_3yr):
        errors.append(f"unit_economics.json missing finite holdup_3yr_eur, got {holdup_3yr!r}")
        return errors
    if not _is_finite_number(orcam_mid_3yr):
        errors.append(f"unit_economics.json missing finite orcam_midpoint_3yr_eur, got {orcam_mid_3yr!r}")
        return errors
    if not _is_finite_number(savings_pct):
        errors.append(f"unit_economics.json missing finite savings_vs_orcam_pct, got {savings_pct!r}")
        return errors

    holdup_val = float(holdup_3yr)
    orcam_val = float(orcam_mid_3yr)
    savings_val = float(savings_pct)

    if holdup_val <= 0.0:
        errors.append(f"holdup_3yr_eur must be > 0, got {holdup_val}")
    if not (holdup_val < orcam_val):
        errors.append(
            f"expected holdup_3yr_eur < orcam_midpoint_3yr_eur, got {holdup_val} >= {orcam_val}"
        )
    if not (savings_val > MIN_SAVINGS_VS_ORCAM_PCT):
        errors.append(
            f"expected savings_vs_orcam_pct > {MIN_SAVINGS_VS_ORCAM_PCT}, got {savings_val}"
        )
    if savings_val >= 100.0:
        errors.append(f"savings_vs_orcam_pct must be < 100.0, got {savings_val}")

    if orcam_val > 0.0:
        recomputed_pct = (1.0 - (holdup_val / orcam_val)) * 100.0
        if abs(savings_val - recomputed_pct) >= 0.2:
            errors.append(
                f"savings_vs_orcam_pct ({savings_val}) != recomputed ({recomputed_pct:.4f})"
            )

    if holdup_3yr_map:
        std_val = holdup_3yr_map.get("standard_cached_100pct_cloud")
        if not _is_finite_number(std_val) or abs(float(std_val) - holdup_val) >= 0.01:
            errors.append(
                f"three_year_tco_eur.standard_cached_100pct_cloud ({std_val!r}) != headline ({holdup_val})"
            )
        for tier_name, tier_val in holdup_3yr_map.items():
            if not _is_finite_number(tier_val) or not (0.0 < float(tier_val) < orcam_val):
                errors.append(
                    f"HoldUp 3-year TCO tier {tier_name} ({tier_val!r}) not in (0, {orcam_val})"
                )

    if orcam_opt:
        opt_mid = orcam_opt.get("three_year_tco_eur_midpoint")
        if not _is_finite_number(opt_mid) or abs(float(opt_mid) - orcam_val) >= 0.01:
            errors.append(
                f"orcam three_year_tco_eur_midpoint ({opt_mid!r}) != headline ({orcam_val})"
            )
        opt_pct = orcam_opt.get("holdup_savings_vs_midpoint_pct")
        if not _is_finite_number(opt_pct) or abs(float(opt_pct) - savings_val) >= 0.01:
            errors.append(
                f"orcam holdup_savings_vs_midpoint_pct ({opt_pct!r}) != headline ({savings_val})"
            )
        opt_sav_eur = orcam_opt.get("holdup_savings_vs_midpoint_eur")
        if not _is_finite_number(opt_sav_eur) or abs(float(opt_sav_eur) - (orcam_val - holdup_val)) >= 0.02:
            errors.append(
                f"orcam holdup_savings_vs_midpoint_eur ({opt_sav_eur!r}) != {orcam_val - holdup_val:.2f}"
            )

    multiple = hs.get("tco_cost_reduction_multiple_vs_orcam")
    if _is_finite_number(multiple) and holdup_val > 0.0:
        recomputed_mult = orcam_val / holdup_val
        if abs(float(multiple) - recomputed_mult) >= 0.15:
            errors.append(
                f"tco_cost_reduction_multiple_vs_orcam ({multiple}) != recomputed ({recomputed_mult:.3f})"
            )

    jpeg_savings_pct = (
        hs.get("video_bandwidth_saved_in_adaptive_mode_pct")
        if "video_bandwidth_saved_in_adaptive_mode_pct" in hs
        else data.get(
            "video_bandwidth_saved_in_adaptive_mode_pct",
            slow_bw.get("video_bandwidth_reduction_vs_normal_pct"),
        )
    )
    if not _is_finite_number(jpeg_savings_pct):
        errors.append(
            f"unit_economics.json missing finite video_bandwidth_saved_in_adaptive_mode_pct, got {jpeg_savings_pct!r}"
        )
    else:
        jpeg_sav_val = float(jpeg_savings_pct)
        if not (jpeg_sav_val > MIN_JPEG_BANDWIDTH_SAVINGS_PCT):
            errors.append(
                f"expected slow-network JPEG bandwidth savings > {MIN_JPEG_BANDWIDTH_SAVINGS_PCT}, got {jpeg_sav_val}"
            )
        if jpeg_sav_val >= 100.0:
            errors.append(
                f"slow-network JPEG bandwidth savings must be < 100.0, got {jpeg_sav_val}"
            )

        if normal_bw or slow_bw:
            norm_jpeg_kb = normal_bw.get("jpeg_frames_kb")
            slow_jpeg_kb = slow_bw.get("jpeg_frames_kb")
            if not _is_finite_number(norm_jpeg_kb) or not _is_finite_number(slow_jpeg_kb):
                errors.append(
                    f"unit_economics.json jpeg_frames_kb invalid: normal={norm_jpeg_kb!r}, slow={slow_jpeg_kb!r}"
                )
            else:
                norm_kb_f = float(norm_jpeg_kb)
                slow_kb_f = float(slow_jpeg_kb)
                if not (0.0 < slow_kb_f < norm_kb_f):
                    errors.append(
                        f"expected 0 < slow jpeg_frames_kb < normal jpeg_frames_kb, got {slow_kb_f} vs {norm_kb_f}"
                    )
                else:
                    recomputed_jpeg_pct = (1.0 - (slow_kb_f / norm_kb_f)) * 100.0
                    if not (recomputed_jpeg_pct > MIN_JPEG_BANDWIDTH_SAVINGS_PCT):
                        errors.append(
                            f"recomputed JPEG bandwidth savings ({recomputed_jpeg_pct:.2f}%) <= {MIN_JPEG_BANDWIDTH_SAVINGS_PCT}%"
                        )
                    if abs(jpeg_sav_val - recomputed_jpeg_pct) >= 0.2:
                        errors.append(
                            f"video_bandwidth_saved_in_adaptive_mode_pct ({jpeg_sav_val}) != recomputed ({recomputed_jpeg_pct:.4f})"
                        )

            slow_red_pct = slow_bw.get("video_bandwidth_reduction_vs_normal_pct")
            if slow_red_pct is not None and (
                not _is_finite_number(slow_red_pct) or abs(float(slow_red_pct) - jpeg_sav_val) >= 0.01
            ):
                errors.append(
                    f"video_bandwidth_reduction_vs_normal_pct ({slow_red_pct!r}) != headline ({jpeg_sav_val})"
                )

    return errors


def audit_label_schema(
    schema_data: dict[str, Any],
    types_ts_text: str | None = None,
) -> list[str]:
    errors: list[str] = []

    if schema_data.get("type") != "object":
        errors.append(f"shared/label_schema.json root type expected 'object', got {schema_data.get('type')!r}")

    props = schema_data.get("properties")
    if not isinstance(props, dict):
        errors.append("shared/label_schema.json missing properties object")
        return errors

    for expected_field in EXPECTED_LABEL_READ_ALL_FIELDS:
        if expected_field not in props:
            errors.append(f"shared/label_schema.json missing expected LabelRead property {expected_field!r}")

    extra_props = sorted(set(props.keys()) - set(EXPECTED_LABEL_READ_ALL_FIELDS))
    if extra_props:
        errors.append(f"shared/label_schema.json has unexpected properties: {extra_props}")

    required_list = schema_data.get("required")
    if not isinstance(required_list, list):
        errors.append("shared/label_schema.json missing required list")
    else:
        missing_req = [f for f in EXPECTED_LABEL_READ_REQUIRED_FIELDS if f not in required_list]
        if missing_req:
            errors.append(f"shared/label_schema.json required list missing: {missing_req}")
        if "guidance" in required_list:
            errors.append("shared/label_schema.json guidance should be optional, not required")

    kind_prop = props.get("kind")
    if not isinstance(kind_prop, dict) or kind_prop.get("enum") != list(EXPECTED_LABEL_KINDS):
        errors.append(
            f"shared/label_schema.json kind.enum expected {list(EXPECTED_LABEL_KINDS)}, got {kind_prop!r}"
        )

    defs = schema_data.get("$defs")
    str_def = defs.get("stringField") if isinstance(defs, dict) else None
    if not isinstance(str_def, dict):
        errors.append("shared/label_schema.json missing $defs.stringField definition")
    else:
        str_props = str_def.get("properties") if isinstance(str_def.get("properties"), dict) else {}
        conf_prop = str_props.get("confidence") if isinstance(str_props.get("confidence"), dict) else {}
        if conf_prop.get("minimum") != 0 or conf_prop.get("maximum") != 1:
            errors.append(f"$defs.stringField confidence bounds expected [0, 1], got {conf_prop!r}")
        if set(str_def.get("required") or []) != {"value", "confidence"}:
            errors.append(f"$defs.stringField required expected value+confidence, got {str_def.get('required')!r}")

    for field_name in EXPECTED_STRING_CONFIDENCE_FIELDS:
        f_schema = props.get(field_name)
        if not isinstance(f_schema, dict) or f_schema.get("$ref") != STRING_FIELD_REF:
            errors.append(
                f"shared/label_schema.json {field_name} expected $ref {STRING_FIELD_REF!r}, got {f_schema!r}"
            )

    allergens_prop = props.get("allergens")
    if not isinstance(allergens_prop, dict):
        errors.append("shared/label_schema.json allergens must be an object schema")
    else:
        a_props = allergens_prop.get("properties") if isinstance(allergens_prop.get("properties"), dict) else {}
        a_conf = a_props.get("confidence") if isinstance(a_props.get("confidence"), dict) else {}
        if a_conf.get("minimum") != 0 or a_conf.get("maximum") != 1:
            errors.append(f"allergens.confidence bounds expected [0, 1], got {a_conf!r}")
        if set(allergens_prop.get("required") or []) != {"value", "confidence"}:
            errors.append(f"allergens.required expected value+confidence, got {allergens_prop.get('required')!r}")

    readability_prop = props.get("readability")
    if not isinstance(readability_prop, dict) or readability_prop.get("minimum") != 0 or readability_prop.get("maximum") != 1:
        errors.append(f"readability bounds expected [0, 1], got {readability_prop!r}")

    guidance_prop = props.get("guidance")
    if not isinstance(guidance_prop, dict) or guidance_prop.get("type") != "string":
        errors.append(f"guidance expected string type, got {guidance_prop!r}")

    if types_ts_text is not None:
        parsed_ts = extract_ts_label_read_fields(types_ts_text)
        if parsed_ts is None:
            errors.append("Could not parse export type LabelRead from shared/types.ts")
        else:
            ts_req, ts_opt = parsed_ts
            if set(ts_req) != set(EXPECTED_LABEL_READ_REQUIRED_FIELDS):
                errors.append(f"shared/types.ts required LabelRead fields {ts_req} != schema required")
            if set(ts_opt) != set(EXPECTED_LABEL_READ_OPTIONAL_FIELDS):
                errors.append(f"shared/types.ts optional LabelRead fields {ts_opt} != schema optional")

    return errors


def _validate_embedded_label_reads(
    node: Any,
    filename: str,
    json_path: str,
    errors: list[str],
) -> int:
    count = 0
    if isinstance(node, dict):
        read_obj = node.get("read")
        if isinstance(read_obj, dict):
            count += 1
            missing = [f for f in EXPECTED_LABEL_READ_REQUIRED_FIELDS if f not in read_obj]
            if missing:
                errors.append(f"{filename}:{json_path}.read missing required fields {missing}")
            else:
                unknown = sorted(set(read_obj.keys()) - set(EXPECTED_LABEL_READ_ALL_FIELDS))
                if unknown:
                    errors.append(f"{filename}:{json_path}.read has unknown fields {unknown}")
                if read_obj.get("kind") not in EXPECTED_LABEL_KINDS:
                    errors.append(f"{filename}:{json_path}.read invalid kind {read_obj.get('kind')!r}")
                readability = read_obj.get("readability")
                if not _is_finite_number(readability) or not (0.0 <= float(readability) <= 1.0):
                    errors.append(f"{filename}:{json_path}.read invalid readability {readability!r}")
                for cf in (*EXPECTED_STRING_CONFIDENCE_FIELDS, "allergens"):
                    f_obj = read_obj.get(cf)
                    conf = f_obj.get("confidence") if isinstance(f_obj, dict) else None
                    if not _is_finite_number(conf) or not (0.0 <= float(conf) <= 1.0):
                        errors.append(
                            f"{filename}:{json_path}.read.{cf}.confidence out of [0, 1]: {conf!r}"
                        )
        for k, v in node.items():
            if k != "read":
                count += _validate_embedded_label_reads(v, filename, f"{json_path}.{k}", errors)
    elif isinstance(node, list):
        for idx, item in enumerate(node):
            count += _validate_embedded_label_reads(item, filename, f"{json_path}[{idx}]", errors)
    return count


class MetricsConsistencyTest(unittest.TestCase):
    eval_json_payloads: dict[str, dict[str, Any]] = {}

    @classmethod
    def setUpClass(cls) -> None:
        cls.eval_json_payloads = {
            path.name: json.loads(path.read_text(encoding="utf-8"))
            for path in _collect_eval_json_files(DEFAULT_EVAL_DIR, "*.json")
        }

    def test_strength_min_conf_matches_calibration_curve_and_combined_summary(self) -> None:
        safety_text = SAFETY_TS_PATH.read_text(encoding="utf-8")
        cal_data = self.eval_json_payloads["calibration_curve.json"]

        errors = audit_calibration_consistency(safety_text, cal_data)
        self.assertEqual(errors, [])

        strength_conf = extract_ts_numeric_const(safety_text, "STRENGTH_MIN_CONF")
        name_conf = extract_ts_numeric_const(safety_text, "NAME_MIN_CONF")
        allergen_conf = extract_ts_numeric_const(safety_text, "ALLERGEN_MIN_CONF")
        self.assertEqual(strength_conf, 0.80)
        self.assertEqual(name_conf, 0.60)
        self.assertEqual(allergen_conf, 0.60)

        cal_summary = cal_data["summary"]
        self.assertLess(cal_summary["ece"], MAX_CALIBRATION_ECE)
        self.assertLess(cal_summary["brier_score"], MAX_CALIBRATION_BRIER)

        combined = self.eval_json_payloads["combined_summary.json"]
        inv = combined["safety_invariants"]
        self.assertEqual(inv["strength_min_conf"], strength_conf)
        self.assertEqual(inv["name_min_conf"], name_conf)
        self.assertEqual(inv["allergen_min_conf"], allergen_conf)

        for filename, payload in sorted(self.eval_json_payloads.items()):
            if "strength_min_conf" in payload and payload["strength_min_conf"] is not None:
                self.assertEqual(float(payload["strength_min_conf"]), strength_conf, filename)
            s_obj = payload.get("summary")
            if isinstance(s_obj, dict) and "strength_min_conf" in s_obj and s_obj["strength_min_conf"] is not None:
                self.assertEqual(float(s_obj["strength_min_conf"]), strength_conf, filename)

    def test_all_results_json_verdict_accuracy_and_latency_quantile_invariants(self) -> None:
        results_files = _collect_eval_json_files(DEFAULT_EVAL_DIR, "*_results.json")
        self.assertGreaterEqual(len(results_files), 19)

        verdict_checked_suites: list[str] = []
        latency_checked_suites: list[str] = []
        rate_checked_suites: list[str] = []
        total_rate_fields = 0

        for path in results_files:
            payload = self.eval_json_payloads[path.name]
            rep = audit_results_summary_invariants(payload, path.name)
            self.assertEqual(rep["errors"], [], path.name)
            if rep["checked_verdict_accuracy"]:
                verdict_checked_suites.append(path.name)
            if rep["checked_latency_pair"]:
                latency_checked_suites.append(path.name)
            if rep["checked_rate_fields"] > 0:
                rate_checked_suites.append(path.name)
                total_rate_fields += rep["checked_rate_fields"]

        self.assertGreaterEqual(len(verdict_checked_suites), 16)
        self.assertIn("spoken_verdict_clarity_results.json", verdict_checked_suites)
        self.assertGreaterEqual(len(latency_checked_suites), 17)
        self.assertEqual(len(rate_checked_suites), len(results_files))
        self.assertGreaterEqual(total_rate_fields, 45)

        for filename, payload in sorted(self.eval_json_payloads.items()):
            if filename.endswith("_results.json"):
                continue
            rep = audit_results_summary_invariants(payload, filename)
            self.assertEqual(rep["errors"], [], filename)

        combined = self.eval_json_payloads["combined_summary.json"]
        total_cases = combined["total_label_cases_evaluated"]
        total_matches = combined["total_verdict_matches"]
        overall_acc = combined["overall_verdict_accuracy"]
        self.assertGreater(total_cases, 0)
        self.assertTrue(0 <= total_matches <= total_cases)
        self.assertLess(abs(overall_acc - (total_matches / total_cases)), VERDICT_ACCURACY_TOLERANCE)

        for section_key, n_key, m_key, acc_key in (
            ("extended_summary", "total_cases_evaluated", "total_verdict_matches", "overall_verdict_accuracy"),
            (
                "wave6_summary",
                "label_and_fusion_cases_evaluated",
                "label_and_fusion_verdict_matches",
                "label_and_fusion_verdict_accuracy",
            ),
            ("wave7_summary", "label_cases_evaluated", "label_verdict_matches", "label_verdict_accuracy"),
            ("wave8_summary", "label_cases_evaluated", "label_verdict_matches", "label_verdict_accuracy"),
        ):
            sec = combined.get(section_key)
            if not isinstance(sec, dict) or n_key not in sec:
                continue
            n_val = sec[n_key]
            m_val = sec[m_key]
            acc_val = sec[acc_key]
            self.assertTrue(0 <= m_val <= n_val, section_key)
            if n_val > 0:
                self.assertLess(abs(acc_val - (m_val / n_val)), VERDICT_ACCURACY_TOLERANCE, section_key)

    def test_unit_economics_three_year_tco_and_savings_invariants(self) -> None:
        econ_data = self.eval_json_payloads["unit_economics.json"]
        errors = audit_unit_economics_tco(econ_data)
        self.assertEqual(errors, [])

        hs = econ_data["headline_summary"]
        self.assertLess(
            hs["tco_3yr_holdup_rayban_meta_gen2_eur"],
            hs["tco_3yr_orcam_myeye_midpoint_eur"],
        )
        self.assertGreater(
            hs["tco_savings_vs_orcam_midpoint_pct"],
            MIN_SAVINGS_VS_ORCAM_PCT,
        )
        self.assertGreater(
            hs["video_bandwidth_saved_in_adaptive_mode_pct"],
            MIN_JPEG_BANDWIDTH_SAVINGS_PCT,
        )
        self.assertLess(
            hs["slow_network_adaptive_0_5fps_check_bandwidth_kb"],
            hs["normal_1fps_check_bandwidth_kb"],
        )
        bw = econ_data["bandwidth_per_12s_check"]
        norm_jpeg_kb = bw["normal_mode"]["jpeg_frames_kb"]
        slow_jpeg_kb = bw["slow_network_adaptive_mode"]["jpeg_frames_kb"]
        self.assertLess(slow_jpeg_kb, norm_jpeg_kb)
        self.assertGreater((1.0 - (slow_jpeg_kb / norm_jpeg_kb)) * 100.0, MIN_JPEG_BANDWIDTH_SAVINGS_PCT)

    def test_label_schema_defines_all_label_read_fields_and_conforms_across_eval(self) -> None:
        schema_data = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
        types_text = TYPES_TS_PATH.read_text(encoding="utf-8")

        schema_errors = audit_label_schema(schema_data, types_text)
        self.assertEqual(schema_errors, [])

        read_errors: list[str] = []
        total_reads = 0
        for filename, payload in sorted(self.eval_json_payloads.items()):
            total_reads += _validate_embedded_label_reads(payload, filename, "$", read_errors)
        self.assertEqual(read_errors, [])
        self.assertGreaterEqual(total_reads, 200)

    def test_negative_detectors_catch_threshold_accuracy_latency_tco_and_schema_regressions(self) -> None:
        safety_text = SAFETY_TS_PATH.read_text(encoding="utf-8")
        cal_base = self.eval_json_payloads["calibration_curve.json"]

        drifted_safety = safety_text.replace("STRENGTH_MIN_CONF = 0.8;", "STRENGTH_MIN_CONF = 0.75;")
        self.assertTrue(audit_calibration_consistency(drifted_safety, cal_base))

        bad_ece = copy.deepcopy(cal_base)
        bad_ece["summary"]["ece"] = 0.051
        self.assertTrue(any("ece" in e for e in audit_calibration_consistency(safety_text, bad_ece)))

        bad_brier = copy.deepcopy(cal_base)
        bad_brier["summary"]["brier_score"] = 0.025
        self.assertTrue(any("brier" in e for e in audit_calibration_consistency(safety_text, bad_brier)))

        bad_bounds = {
            "summary": {
                "n_items": 10,
                "verdict_matches": 11,
                "verdict_accuracy": 1.0,
                "latency_p50_ms": 3200.0,
                "latency_p95_ms": 4100.0,
            }
        }
        r_bounds = audit_results_summary_invariants(bad_bounds, "synthetic_bounds_results.json")
        self.assertTrue(any("verdict_matches <= n_items" in e for e in r_bounds["errors"]))

        bad_cases_bounds = {
            "summary": {
                "n_cases": 16,
                "verdict_matches": 17,
                "verdict_accuracy": 1.0,
                "latency_p50_ms": 3100.0,
                "latency_p95_ms": 4200.0,
            }
        }
        r_cases_bounds = audit_results_summary_invariants(bad_cases_bounds, "synthetic_cases_results.json")
        self.assertTrue(any("verdict_matches <= n_cases" in e for e in r_cases_bounds["errors"]))

        bad_cases_acc = {
            "summary": {
                "n_cases": 16,
                "verdict_matches": 15,
                "verdict_accuracy": 0.95,
            }
        }
        r_cases_acc = audit_results_summary_invariants(bad_cases_acc, "synthetic_cases_acc_results.json")
        self.assertTrue(any("verdict_matches/n_cases" in e for e in r_cases_acc["errors"]))

        bad_neg = {
            "summary": {
                "n_items": 10,
                "verdict_matches": -1,
                "verdict_accuracy": 0.0,
            }
        }
        r_neg = audit_results_summary_invariants(bad_neg, "synthetic_neg_results.json")
        self.assertTrue(any("0 <= verdict_matches" in e for e in r_neg["errors"]))

        bad_acc = {
            "summary": {
                "n_items": 10,
                "verdict_matches": 9,
                "verdict_accuracy": 0.905,
                "latency_p50_ms": 3200.0,
                "latency_p95_ms": 4100.0,
            }
        }
        r_acc = audit_results_summary_invariants(bad_acc, "synthetic_acc_results.json")
        self.assertTrue(any("verdict_accuracy" in e for e in r_acc["errors"]))

        bad_rate_high = {"summary": {"occluded_abstention_rate": 1.05}}
        r_rate_high = audit_results_summary_invariants(bad_rate_high, "synthetic_rate_high_results.json")
        self.assertTrue(any("expected rate in [0.0, 1.0]" in e for e in r_rate_high["errors"]))

        bad_rate_low = {"summary": {"clean_field_accuracy": -0.01}}
        r_rate_low = audit_results_summary_invariants(bad_rate_low, "synthetic_rate_low_results.json")
        self.assertTrue(any("expected rate in [0.0, 1.0]" in e for e in r_rate_low["errors"]))

        bad_rate_bool = {"summary": {"privacy_pass_rate": True}}
        r_rate_bool = audit_results_summary_invariants(bad_rate_bool, "synthetic_rate_bool_results.json")
        self.assertTrue(any("must be a finite number" in e for e in r_rate_bool["errors"]))

        bad_lat_order = {
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "latency_p50_ms": 4900.0,
                "latency_p95_ms": 4100.0,
            }
        }
        r_lat = audit_results_summary_invariants(bad_lat_order, "synthetic_lat_results.json")
        self.assertTrue(any("latency_p50_ms <= latency_p95_ms" in e for e in r_lat["errors"]))

        bad_lat_zero = {
            "summary": {
                "latency_p50_ms": 0.0,
                "latency_p95_ms": 100.0,
            }
        }
        r_zero = audit_results_summary_invariants(bad_lat_zero, "synthetic_zero_results.json")
        self.assertTrue(any("0 < latency_p50_ms" in e for e in r_zero["errors"]))

        bad_tco_order = {
            "holdup_3yr_eur": 4200.0,
            "orcam_midpoint_3yr_eur": 4150.0,
            "savings_vs_orcam_pct": 91.8,
            "video_bandwidth_saved_in_adaptive_mode_pct": 84.0,
        }
        self.assertTrue(any("holdup_3yr_eur < orcam_midpoint_3yr_eur" in e for e in audit_unit_economics_tco(bad_tco_order)))

        bad_tco_pct = {
            "holdup_3yr_eur": 700.0,
            "orcam_midpoint_3yr_eur": 4150.0,
            "savings_vs_orcam_pct": 83.1,
            "video_bandwidth_saved_in_adaptive_mode_pct": 84.0,
        }
        self.assertTrue(any("savings_vs_orcam_pct > 85.0" in e for e in audit_unit_economics_tco(bad_tco_pct)))

        bad_jpeg_pct = {
            "holdup_3yr_eur": 341.68,
            "orcam_midpoint_3yr_eur": 4150.0,
            "savings_vs_orcam_pct": 91.8,
            "video_bandwidth_saved_in_adaptive_mode_pct": 72.5,
        }
        self.assertTrue(
            any("slow-network JPEG bandwidth savings > 75.0" in e for e in audit_unit_economics_tco(bad_jpeg_pct))
        )

        econ_bad_kb = copy.deepcopy(self.eval_json_payloads["unit_economics.json"])
        econ_bad_kb["bandwidth_per_12s_check"]["slow_network_adaptive_mode"]["jpeg_frames_kb"] = 220.0
        self.assertTrue(any("JPEG" in e or "video_bandwidth" in e for e in audit_unit_economics_tco(econ_bad_kb)))

        schema_base = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
        missing_guidance = copy.deepcopy(schema_base)
        missing_guidance["properties"].pop("guidance")
        self.assertTrue(any("guidance" in e for e in audit_label_schema(missing_guidance)))

        missing_strength = copy.deepcopy(schema_base)
        missing_strength["properties"].pop("strength")
        self.assertTrue(any("strength" in e for e in audit_label_schema(missing_strength)))

        bad_conf_bounds = copy.deepcopy(schema_base)
        bad_conf_bounds["$defs"]["stringField"]["properties"]["confidence"]["maximum"] = 1.5
        self.assertTrue(any("[0, 1]" in e for e in audit_label_schema(bad_conf_bounds)))

    def test_self_hygiene_zero_hash_comments_and_zero_em_dashes(self) -> None:
        self_text = pathlib.Path(__file__).resolve().read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_text)
        self.assertNotIn(EM_DASH, self_text)


if __name__ == "__main__":
    unittest.main()
