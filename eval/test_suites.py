import importlib.util
import json
import math
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from typing import Any

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
DEFAULT_SUITES_DIR = EVAL_DIR / "suites"
COMPILE_PATH = EVAL_DIR / "compile_suites.py"

MAX_RESULTS_BYTES = 15360
HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
API_KEY_PREFIX = "AI" + "za"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{8,}")
BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")
NODE_BIN_DIRS = ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin")


def load_compile_module() -> Any:
    spec = importlib.util.spec_from_file_location("compile_suites", COMPILE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {COMPILE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["compile_suites"] = module
    spec.loader.exec_module(module)
    return module


COMPILE_MOD = load_compile_module()


def build_check_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    env["TMPDIR"] = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
    path_parts = [p for p in NODE_BIN_DIRS if os.path.isdir(p)]
    if NODE_BIN_DIRS[0] not in path_parts:
        path_parts.insert(0, NODE_BIN_DIRS[0])
    existing_path = env.get("PATH", "")
    env["PATH"] = ":".join(path_parts + ([existing_path] if existing_path else []))
    parent_nm = REPO_ROOT.parent / "node_modules"
    if parent_nm.is_dir():
        existing_np = env.get("NODE_PATH", "")
        env["NODE_PATH"] = f"{parent_nm}:{existing_np}" if existing_np else str(parent_nm)
    return env


def discover_suites(suites_dir: pathlib.Path = DEFAULT_SUITES_DIR) -> list[pathlib.Path]:
    if not suites_dir.is_dir():
        return []
    found: list[pathlib.Path] = []
    for child in sorted(suites_dir.iterdir()):
        if not child.is_dir() or child.name.startswith(".") or child.name == "__pycache__":
            continue
        if (child / "results.json").is_file() and (child / "run.py").is_file() and (child / "README.md").is_file():
            found.append(child)
    return found


def assert_zero_metric(label: str, values: list[Any]) -> None:
    for val in values:
        if val is None:
            continue
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val):
            raise AssertionError(f"{label}: non-numeric metric {val!r}")
        if val != 0:
            raise AssertionError(f"{label}: expected 0, got {val!r}")


def assert_valid_wilson_ci(label: str, ci: Any) -> None:
    if not isinstance(ci, list) or len(ci) != 2:
        raise AssertionError(f"{label}: expected 2-element list, got {ci!r}")
    lo, hi = ci
    if isinstance(lo, bool) or isinstance(hi, bool):
        raise AssertionError(f"{label}: boolean found in CI {ci!r}")
    if not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)):
        raise AssertionError(f"{label}: non-numeric CI {ci!r}")
    if not (math.isfinite(lo) and math.isfinite(hi)):
        raise AssertionError(f"{label}: non-finite CI {ci!r}")
    if not (0.0 <= float(lo) <= float(hi) <= 1.0):
        raise AssertionError(f"{label}: CI {ci!r} violates 0 <= lo <= hi <= 1")


def validate_suite_dir(suite_dir: pathlib.Path, repo_root: pathlib.Path = REPO_ROOT) -> None:
    name = suite_dir.name
    results_path = suite_dir / "results.json"
    readme_path = suite_dir / "README.md"
    run_path = suite_dir / "run.py"

    if not results_path.is_file():
        raise AssertionError(f"{name}: missing results.json")
    if not readme_path.is_file():
        raise AssertionError(f"{name}: missing README.md")
    if not run_path.is_file():
        raise AssertionError(f"{name}: missing run.py")

    raw_bytes = results_path.read_bytes()
    if len(raw_bytes) > 25000:
        raise AssertionError(f"{name}: results.json size {len(raw_bytes)} > 25000")

    try:
        raw_txt = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AssertionError(f"{name}: results.json is not valid UTF-8: {exc}") from exc

    if API_KEY_PREFIX in raw_txt or API_KEY_RE.search(raw_txt):
        raise AssertionError(f"{name}: API key token detected in results.json")
    if (
        "data:image/" in raw_txt
        or "/9j/" in raw_txt
        or "iVBORw0KGgo" in raw_txt
        or BASE64_BLOB_RE.search(raw_txt)
    ):
        raise AssertionError(f"{name}: raw base64 blob detected in results.json")

    try:
        data = json.loads(raw_txt)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{name}: invalid JSON in results.json: {exc}") from exc
    if not isinstance(data, dict):
        raise AssertionError(f"{name}: results.json root must be a dict")
    if not (isinstance(data.get("models"), list) and len(data["models"]) >= 2) and len(raw_bytes) > MAX_RESULTS_BYTES:
        raise AssertionError(f"{name}: results.json size {len(raw_bytes)} > {MAX_RESULTS_BYTES}")

    summary = COMPILE_MOD.resolve_summary_view(data)
    assert_zero_metric(
        f"{name}.errors",
        [
            data.get("errors"),
            summary.get("errors"),
            data.get("api_error_count"),
            summary.get("api_error_count"),
        ],
    )
    assert_zero_metric(
        f"{name}.timeouts",
        [
            data.get("timeouts"),
            summary.get("timeouts"),
            data.get("timeout_count"),
            summary.get("timeout_count"),
        ],
    )

    cw_candidates = [
        summary.get("confident_wrong_count"),
        summary.get("confident_wrong_dose_count"),
        summary.get("strength_confident_wrong"),
        data.get("confident_wrong_count"),
        data.get("confident_wrong_dose_count"),
    ]
    if all(v is None for v in cw_candidates):
        raise AssertionError(f"{name}: missing confident_wrong_count / confident_wrong_dose_count")
    assert_zero_metric(f"{name}.confident_wrong", cw_candidates)

    assert_zero_metric(
        f"{name}.false_match",
        [
            summary.get("false_match_count"),
            summary.get("false_match"),
            data.get("false_match_count"),
            data.get("false_match"),
        ],
    )
    assert_zero_metric(
        f"{name}.unsafe_reassurance",
        [
            summary.get("unsafe_reassurance_count"),
            summary.get("unsafe_reassurance"),
            data.get("unsafe_reassurance_count"),
            data.get("unsafe_reassurance"),
            summary.get("false_safe_allergen_count"),
            data.get("false_safe_allergen_count"),
        ],
    )

    parsed = COMPILE_MOD.parse_suite_results(results_path)
    if parsed["confident_wrong"] != 0:
        raise AssertionError(f"{name}: parsed confident_wrong={parsed['confident_wrong']} != 0")
    if parsed["false_match"] != 0:
        raise AssertionError(f"{name}: parsed false_match={parsed['false_match']} != 0")
    if parsed["unsafe_reassurance"] != 0:
        raise AssertionError(f"{name}: parsed unsafe_reassurance={parsed['unsafe_reassurance']} != 0")

    live_summary = data.get("live_summary") if isinstance(data.get("live_summary"), dict) else {}
    passed_all = live_summary.get("passed_all") if isinstance(live_summary.get("passed_all"), dict) else {}
    ci_fields = [
        ("summary.verdict_accuracy_ci95", summary.get("verdict_accuracy_ci95")),
        ("summary.confident_wrong_ci95", summary.get("confident_wrong_ci95")),
        ("pass_ci95_wilson", data.get("pass_ci95_wilson")),
        ("confident_wrong_dose_ci95_wilson", data.get("confident_wrong_dose_ci95_wilson")),
        ("live_summary.passed_all.wilson_95_ci", passed_all.get("wilson_95_ci")),
    ]
    present_cis = [(field_name, ci_val) for field_name, ci_val in ci_fields if ci_val is not None]
    if not present_cis:
        raise AssertionError(f"{name}: missing Wilson 95% CI field in results.json")
    for field_name, ci_val in present_cis:
        assert_valid_wilson_ci(f"{name}.{field_name}", ci_val)

    try:
        readme_txt = readme_path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AssertionError(f"{name}: README.md is not valid UTF-8: {exc}") from exc
    if not readme_txt.strip():
        raise AssertionError(f"{name}: README.md is empty")
    if API_KEY_PREFIX in readme_txt or API_KEY_RE.search(readme_txt):
        raise AssertionError(f"{name}: API key token detected in README.md")
    if EM_DASH in readme_txt:
        raise AssertionError(f"{name}: em dash detected in README.md")

    env = build_check_env()
    proc = subprocess.run(
        [sys.executable, str(run_path), "--check"],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"{name}: run.py --check exited with {proc.returncode}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )


def write_synthetic_suite(
    suites_root: pathlib.Path,
    suite_name: str,
    payload: dict[str, Any],
    readme_text: str = "Synthetic suite fixture.\n",
    check_exit_code: int = 0,
) -> pathlib.Path:
    sdir = suites_root / suite_name
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "results.json").write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    (sdir / "README.md").write_text(readme_text, encoding="utf-8")
    run_code = (
        "import argparse, json, os, pathlib, sys\n"
        "ap = argparse.ArgumentParser()\n"
        "ap.add_argument('--check', action='store_true')\n"
        "args = ap.parse_args()\n"
        "assert args.check\n"
        "assert '/tmp/fleet-silas/node/bin' in os.environ.get('PATH', '')\n"
        "assert os.environ.get('TMPDIR') in ('/dev/shm', '/tmp')\n"
        "data = json.loads((pathlib.Path(__file__).parent / 'results.json').read_text(encoding='utf-8'))\n"
        "assert isinstance(data, dict)\n"
        f"sys.exit({check_exit_code})\n"
    )
    (sdir / "run.py").write_text(run_code, encoding="utf-8")
    return sdir


class TestRepoSuitesContract(unittest.TestCase):
    def test_contract_scripts_hygiene(self) -> None:
        for script_path in (pathlib.Path(__file__).resolve(), COMPILE_PATH):
            src = script_path.read_text(encoding="utf-8")
            self.assertNotIn(HASH_CHAR, src, f"{script_path.name} contains comment character")
            self.assertNotIn(EM_DASH, src, f"{script_path.name} contains em dash")
            self.assertNotIn(EN_DASH, src, f"{script_path.name} contains en dash")
            self.assertNotIn(API_KEY_PREFIX, src, f"{script_path.name} contains API key prefix")

    def test_discovered_repo_suites(self) -> None:
        suites = discover_suites(DEFAULT_SUITES_DIR)
        if not suites:
            self.assertEqual(suites, [])
            return
        for suite_dir in suites:
            with self.subTest(suite=suite_dir.name):
                validate_suite_dir(suite_dir, repo_root=REPO_ROOT)


class TestCompileSuitesAndSyntheticRunner(unittest.TestCase):
    def test_wilson_ci95_values_and_invariants(self) -> None:
        self.assertEqual(COMPILE_MOD.wilson_ci95(12, 12), [0.7575, 1.0])
        self.assertEqual(COMPILE_MOD.wilson_ci95(0, 12), [0.0, 0.2425])
        self.assertEqual(COMPILE_MOD.wilson_ci95(0, 0), [0.0, 1.0])
        mid = COMPILE_MOD.wilson_ci95(6, 12)
        self.assertTrue(0.0 <= mid[0] <= 0.5 <= mid[1] <= 1.0)
        self.assertAlmostEqual(mid[0] + mid[1], 1.0, places=3)
        self.assertLess(COMPILE_MOD.wilson_ci95(0, 120)[1], COMPILE_MOD.wilson_ci95(0, 12)[1])
        with self.assertRaises(ValueError):
            COMPILE_MOD.wilson_ci95(-1, 10)
        with self.assertRaises(ValueError):
            COMPILE_MOD.wilson_ci95(11, 10)

    def test_rule_of_three_95_bound(self) -> None:
        self.assertEqual(COMPILE_MOD.rule_of_three_95(12, 0), 0.25)
        self.assertEqual(COMPILE_MOD.rule_of_three_95(60, 0), 0.05)
        self.assertEqual(COMPILE_MOD.rule_of_three_95(240, 0), 0.0125)
        self.assertEqual(COMPILE_MOD.rule_of_three_95(2, 0), 1.0)
        self.assertEqual(COMPILE_MOD.rule_of_three_95(0, 0), 1.0)
        self.assertEqual(COMPILE_MOD.rule_of_three_95(12, 1), COMPILE_MOD.wilson_ci95(1, 12)[1])
        with self.assertRaises(ValueError):
            COMPILE_MOD.rule_of_three_95(10, -1)

    def test_synthetic_tempdir_discovery_check_and_compile_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            suites_dir = root / "suites"
            alpha_payload = {
                "suite": "alpha_suite",
                "summary": {
                    "n_cases": 12,
                    "verdict_matches": 12,
                    "verdict_accuracy": 1.0,
                    "verdict_accuracy_ci95": [0.7575, 1.0],
                    "confident_wrong_count": 0,
                    "confident_wrong_ci95": [0.0, 0.2425],
                    "false_match_count": 0,
                    "unsafe_reassurance_count": 0,
                    "latency_p50_ms": 3200.0,
                    "latency_p95_ms": 5100.0,
                },
                "cases": [
                    {
                        "id": f"a_{i:02d}",
                        "expected_level": "match",
                        "predicted_level": "match",
                        "verdict_ok": True,
                        "confident_wrong": False,
                        "false_match": False,
                        "latency_ms": 3200.0,
                    }
                    for i in range(1, 13)
                ],
            }
            beta_payload = {
                "suite": "beta_suite",
                "n": 12,
                "errors": 0,
                "timeouts": 0,
                "pass_count": 12,
                "pass_ci95_wilson": [0.7575, 1.0],
                "confident_wrong_dose_count": 0,
                "confident_wrong_dose_ci95_wilson": [0.0, 0.2425],
                "latency_s": {"p50": 4.0, "p95": 6.5},
                "cases": [
                    {
                        "id": f"b_{i:02d}",
                        "expected_level": "unsure",
                        "actual_level": "unsure",
                        "passed": True,
                        "latency_s": 4.0,
                        "error": None,
                    }
                    for i in range(1, 13)
                ],
            }
            write_synthetic_suite(suites_dir, "alpha_suite", alpha_payload)
            write_synthetic_suite(suites_dir, "beta_suite", beta_payload)
            partial = suites_dir / "partial_ignored"
            partial.mkdir(parents=True)
            (partial / "README.md").write_text("incomplete\n", encoding="utf-8")

            discovered = discover_suites(suites_dir)
            self.assertEqual([d.name for d in discovered], ["alpha_suite", "beta_suite"])
            for sdir in discovered:
                validate_suite_dir(sdir, repo_root=root)

            out_json = root / "compiled.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(COMPILE_PATH),
                    "--suites-dir",
                    str(suites_dir),
                    "--json",
                    str(out_json),
                ],
                cwd=str(REPO_ROOT),
                env=build_check_env(),
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            self.assertIn("| Pooled suites | 2 |", proc.stdout)
            self.assertIn("| Total cases (N) | 24 |", proc.stdout)
            compiled = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertEqual(compiled["suite_count"], 2)
            self.assertEqual(compiled["total_cases"], 24)
            self.assertEqual(compiled["passed_verdicts"], 24)
            self.assertEqual(compiled["pass_ci95"], COMPILE_MOD.wilson_ci95(24, 24))
            self.assertEqual(compiled["confident_wrong_doses"], 0)
            self.assertEqual(compiled["confident_wrong_ci95"], COMPILE_MOD.wilson_ci95(0, 24))
            self.assertEqual(compiled["rule_of_three_upper_95"], 0.125)
            self.assertEqual(compiled["false_matches"], 0)
            self.assertEqual(compiled["unsafe_reassurances"], 0)
            self.assertEqual(compiled["latency_p50_median_ms"], 3600.0)
            self.assertEqual(compiled["latency_p50_max_ms"], 4000.0)
            self.assertEqual(compiled["latency_p95_median_ms"], 5800.0)
            self.assertEqual(compiled["latency_p95_max_ms"], 6500.0)

    def test_contract_validator_catches_bad_artifacts(self) -> None:
        base_payload = {
            "suite": "bad_suite",
            "errors": 0,
            "timeouts": 0,
            "summary": {
                "n_cases": 12,
                "verdict_matches": 12,
                "verdict_accuracy_ci95": [0.7575, 1.0],
                "confident_wrong_count": 0,
                "confident_wrong_ci95": [0.0, 0.2425],
                "false_match_count": 0,
                "unsafe_reassurance_count": 0,
            },
            "cases": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)

            s_cw = write_synthetic_suite(
                root,
                "bad_cw",
                {**base_payload, "summary": {**base_payload["summary"], "confident_wrong_count": 1}},
            )
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_cw, repo_root=root)

            s_key = write_synthetic_suite(
                root,
                "bad_key",
                {**base_payload, "note": API_KEY_PREFIX + "SyFakeSecretKey123456"},
            )
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_key, repo_root=root)

            s_b64 = write_synthetic_suite(
                root,
                "bad_b64",
                {**base_payload, "blob": "A" * 300},
            )
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_b64, repo_root=root)

            s_ci = write_synthetic_suite(
                root,
                "bad_ci",
                {**base_payload, "summary": {**base_payload["summary"], "verdict_accuracy_ci95": [0.9, 0.4]}},
            )
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_ci, repo_root=root)

            s_em = write_synthetic_suite(root, "bad_em", base_payload, readme_text=f"Bad {EM_DASH} dash\n")
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_em, repo_root=root)

            s_oversize = write_synthetic_suite(
                root,
                "bad_size",
                {**base_payload, "pad": ["x" * 80 for _ in range(220)]},
            )
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_oversize, repo_root=root)

            s_exit = write_synthetic_suite(root, "bad_exit", base_payload, check_exit_code=2)
            with self.assertRaises(AssertionError):
                validate_suite_dir(s_exit, repo_root=root)


if __name__ == "__main__":
    unittest.main()
