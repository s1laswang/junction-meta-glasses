import argparse
import json
import math
import pathlib
import statistics
import sys
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_SUITES_DIR = REPO_ROOT / "eval" / "suites"
WILSON_Z_95 = 1.959963984540054


def wilson_ci95(k: int, n: int) -> list[float]:
    if n < 0:
        raise ValueError("n must be non-negative")
    if n == 0:
        if k != 0:
            raise ValueError("k must be 0 when n is 0")
        return [0.0, 1.0]
    if k < 0 or k > n:
        raise ValueError(f"k={k} outside [0, {n}]")
    p = k / n
    z2n = (WILSON_Z_95 * WILSON_Z_95) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    radicand = max(0.0, (p * (1.0 - p) + 0.25 * z2n) / n)
    half = (WILSON_Z_95 * math.sqrt(radicand)) / denom
    lo = round(max(0.0, center - half), 4)
    hi = round(min(1.0, center + half), 4)
    return [lo, hi]


def rule_of_three_95(n: int, k: int = 0) -> float:
    if n < 0 or k < 0 or (n > 0 and k > n) or (n == 0 and k != 0):
        raise ValueError(f"invalid (k={k}, n={n})")
    if n == 0:
        return 1.0
    if k == 0:
        return round(min(1.0, 3.0 / n), 4)
    return wilson_ci95(k, n)[1]


def pctile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo), 1)


def first_int(*candidates: Any) -> int | None:
    for val in candidates:
        if isinstance(val, bool):
            continue
        if isinstance(val, (int, float)) and math.isfinite(val):
            return int(val)
    return None


def first_float(*candidates: Any) -> float | None:
    for val in candidates:
        if isinstance(val, bool):
            continue
        if isinstance(val, (int, float)) and math.isfinite(val):
            return float(val)
    return None


def resolve_summary_view(data: dict[str, Any]) -> dict[str, Any]:
    raw_summary = data.get("summary")
    if isinstance(raw_summary, dict) and raw_summary:
        return raw_summary
    per_model = data.get("per_model")
    if isinstance(per_model, dict) and per_model:
        preferred = per_model.get("gemini-3.8-flash")
        if isinstance(preferred, dict):
            return preferred
        first_val = next(iter(per_model.values()))
        if isinstance(first_val, dict):
            return first_val
    return raw_summary if isinstance(raw_summary, dict) else {}


def extract_case_counts(cases: list[Any]) -> tuple[int, int, int, int]:
    passed = 0
    cw = 0
    false_match = 0
    unsafe_reassurance = 0
    for item in cases:
        if not isinstance(item, dict):
            continue
        if item.get("verdict_ok") is True or item.get("passed") is True:
            passed += 1
        if (
            item.get("confident_wrong") is True
            or item.get("confident_wrong_dose") is True
            or item.get("strength_confident_wrong") is True
        ):
            cw += 1
        exp = item.get("expected_level")
        pred = item.get("predicted_level") or item.get("actual_level")
        if item.get("false_match") is True or (exp is not None and pred == "match" and exp != "match"):
            false_match += 1
        if (
            item.get("unsafe_reassurance") is True
            or item.get("false_safe_allergen") is True
            or (exp == "warning" and pred in ("match", "info"))
        ):
            unsafe_reassurance += 1
    return passed, cw, false_match, unsafe_reassurance


def extract_latencies_ms(data: dict[str, Any], summary: dict[str, Any], cases: list[Any]) -> tuple[float | None, float | None]:
    p50_ms = first_float(summary.get("latency_p50_ms"), data.get("latency_p50_ms"))
    p95_ms = first_float(summary.get("latency_p95_ms"), data.get("latency_p95_ms"))
    if p50_ms is not None and p95_ms is not None:
        return round(p50_ms, 1), round(p95_ms, 1)
    lat_s = summary.get("latency_s") if isinstance(summary.get("latency_s"), dict) else data.get("latency_s")
    if isinstance(lat_s, dict):
        s50 = first_float(lat_s.get("p50"))
        s95 = first_float(lat_s.get("p95"))
        if s50 is not None and s95 is not None:
            return round(s50 * 1000.0, 1), round(s95 * 1000.0, 1)
    ms_list = [
        float(c["latency_ms"])
        for c in cases
        if isinstance(c, dict) and first_float(c.get("latency_ms")) is not None
    ]
    if ms_list:
        return pctile(ms_list, 0.50), pctile(ms_list, 0.95)
    sec_list = [
        float(c["latency_s"]) * 1000.0
        for c in cases
        if isinstance(c, dict) and first_float(c.get("latency_s")) is not None
    ]
    if sec_list:
        return pctile(sec_list, 0.50), pctile(sec_list, 0.95)
    return None, None


def parse_suite_results(results_path: pathlib.Path) -> dict[str, Any]:
    data = json.loads(results_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{results_path}: root must be a JSON object")
    summary = resolve_summary_view(data)
    live_summary = data.get("live_summary") if isinstance(data.get("live_summary"), dict) else {}
    passed_all = live_summary.get("passed_all") if isinstance(live_summary.get("passed_all"), dict) else {}
    cases = data.get("cases") if isinstance(data.get("cases"), list) else []
    c_passed, c_cw, c_fm, c_ur = extract_case_counts(cases)

    n_cases = first_int(
        summary.get("n_cases"),
        summary.get("n"),
        data.get("n_cases"),
        data.get("n"),
        live_summary.get("n"),
        len(cases) if cases else None,
    )
    if n_cases is None:
        n_cases = 0

    passed = first_int(
        summary.get("verdict_matches"),
        summary.get("passed"),
        summary.get("pass_count"),
        data.get("pass_count"),
        data.get("verdict_matches"),
        passed_all.get("k"),
        c_passed if cases else None,
    )
    if passed is None:
        passed = 0

    confident_wrong = first_int(
        summary.get("confident_wrong_count"),
        summary.get("confident_wrong_dose_count"),
        summary.get("strength_confident_wrong"),
        data.get("confident_wrong_dose_count"),
        data.get("confident_wrong_count"),
        c_cw if cases else None,
    )
    if confident_wrong is None:
        confident_wrong = 0

    explicit_fm = first_int(
        summary.get("false_match_count"),
        summary.get("false_match"),
        data.get("false_match_count"),
        data.get("false_match"),
    )
    false_match = max(explicit_fm if explicit_fm is not None else 0, c_fm)

    explicit_ur = first_int(
        summary.get("unsafe_reassurance_count"),
        summary.get("unsafe_reassurance"),
        data.get("unsafe_reassurance_count"),
        data.get("unsafe_reassurance"),
        summary.get("false_safe_allergen_count"),
        data.get("false_safe_allergen_count"),
    )
    unsafe_reassurance = max(explicit_ur if explicit_ur is not None else 0, c_ur)

    p50_ms, p95_ms = extract_latencies_ms(data, summary, cases)
    suite_name = str(data.get("suite") or results_path.parent.name)
    return {
        "suite": suite_name,
        "path": str(results_path),
        "n_cases": n_cases,
        "passed": passed,
        "pass_rate": round(passed / n_cases, 4) if n_cases > 0 else 0.0,
        "pass_ci95": wilson_ci95(passed, n_cases) if n_cases > 0 else [0.0, 1.0],
        "confident_wrong": confident_wrong,
        "confident_wrong_ci95": wilson_ci95(confident_wrong, n_cases) if n_cases > 0 else [0.0, 1.0],
        "false_match": false_match,
        "unsafe_reassurance": unsafe_reassurance,
        "latency_p50_ms": p50_ms,
        "latency_p95_ms": p95_ms,
    }


def compile_suites(suites_dir: pathlib.Path = DEFAULT_SUITES_DIR) -> dict[str, Any]:
    paths = sorted(suites_dir.glob("*/results.json")) if suites_dir.is_dir() else []
    rows = [parse_suite_results(p) for p in paths]
    total_cases = sum(int(r["n_cases"]) for r in rows)
    total_passed = sum(int(r["passed"]) for r in rows)
    total_cw = sum(int(r["confident_wrong"]) for r in rows)
    total_fm = sum(int(r["false_match"]) for r in rows)
    total_ur = sum(int(r["unsafe_reassurance"]) for r in rows)
    p50s = [float(r["latency_p50_ms"]) for r in rows if r["latency_p50_ms"] is not None]
    p95s = [float(r["latency_p95_ms"]) for r in rows if r["latency_p95_ms"] is not None]

    return {
        "suite_count": len(rows),
        "total_cases": total_cases,
        "passed_verdicts": total_passed,
        "pass_rate": round(total_passed / total_cases, 4) if total_cases > 0 else 0.0,
        "pass_ci95": wilson_ci95(total_passed, total_cases),
        "confident_wrong_doses": total_cw,
        "confident_wrong_rate": round(total_cw / total_cases, 4) if total_cases > 0 else 0.0,
        "confident_wrong_ci95": wilson_ci95(total_cw, total_cases),
        "rule_of_three_upper_95": rule_of_three_95(total_cases, total_cw),
        "false_matches": total_fm,
        "unsafe_reassurances": total_ur,
        "latency_p50_median_ms": round(float(statistics.median(p50s)), 1) if p50s else 0.0,
        "latency_p50_max_ms": round(max(p50s), 1) if p50s else 0.0,
        "latency_p95_median_ms": round(float(statistics.median(p95s)), 1) if p95s else 0.0,
        "latency_p95_max_ms": round(max(p95s), 1) if p95s else 0.0,
        "suites": rows,
    }


def render_markdown_summary(compiled: dict[str, Any]) -> str:
    n = int(compiled["total_cases"])
    passed = int(compiled["passed_verdicts"])
    cw = int(compiled["confident_wrong_doses"])
    p_ci = compiled["pass_ci95"]
    cw_ci = compiled["confident_wrong_ci95"]
    r3 = float(compiled["rule_of_three_upper_95"])
    pass_pct = (100.0 * passed / n) if n > 0 else 0.0
    cw_pct = (100.0 * cw / n) if n > 0 else 0.0

    lines = [
        "| Metric | Value |",
        "| --- | --- |",
        f"| Pooled suites | {compiled['suite_count']} |",
        f"| Total cases (N) | {n} |",
        f"| Passed verdicts | {passed} / {n} ({pass_pct:.2f}%, Wilson 95% CI [{p_ci[0]:.4f}, {p_ci[1]:.4f}]) |",
        f"| Confident-wrong doses | {cw} / {n} ({cw_pct:.2f}%, Wilson 95% CI [{cw_ci[0]:.4f}, {cw_ci[1]:.4f}], 3/N bound {r3:.4f}) |",
        f"| False matches | {compiled['false_matches']} |",
        f"| Unsafe reassurances | {compiled['unsafe_reassurances']} |",
        f"| Suite p50 latency (median / max) | {compiled['latency_p50_median_ms']:.1f} ms / {compiled['latency_p50_max_ms']:.1f} ms |",
        f"| Suite p95 latency (median / max) | {compiled['latency_p95_median_ms']:.1f} ms / {compiled['latency_p95_max_ms']:.1f} ms |",
    ]
    suites = compiled.get("suites") or []
    if suites:
        lines.extend(
            [
                "",
                "| Suite | Cases | Passed | Confident-Wrong | False Match | Unsafe Reassurance | p50 (ms) | p95 (ms) |",
                "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for row in suites:
            p50_txt = f"{row['latency_p50_ms']:.1f}" if row["latency_p50_ms"] is not None else "n/a"
            p95_txt = f"{row['latency_p95_ms']:.1f}" if row["latency_p95_ms"] is not None else "n/a"
            lines.append(
                f"| {row['suite']} | {row['n_cases']} | {row['passed']}/{row['n_cases']} "
                f"| {row['confident_wrong']} | {row['false_match']} | {row['unsafe_reassurance']} "
                f"| {p50_txt} | {p95_txt} |"
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile pooled HoldUp safety evaluation suites.")
    parser.add_argument("--suites-dir", type=pathlib.Path, default=DEFAULT_SUITES_DIR)
    parser.add_argument("--json", dest="json_out", type=pathlib.Path, default=None)
    args = parser.parse_args(argv)

    compiled = compile_suites(args.suites_dir)
    md = render_markdown_summary(compiled)
    sys.stdout.write(md + "\n")
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(compiled, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
