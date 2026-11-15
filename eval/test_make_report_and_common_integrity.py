from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import math
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import warnings
from typing import Any
from unittest import mock

from PIL import Image

sys.dont_write_bytecode = True

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import common
import make_report
import run_eval

V1_RESULTS_PATH = EVAL_DIR / "results" / "v1_results.json"
EVAL_DOC_PATH = REPO_ROOT / "docs" / "EVAL.md"
DOCS_IMG_DIR = REPO_ROOT / "docs" / "img"
PIPELINE_SH = EVAL_DIR / "pipeline.sh"
LOCAL_SH = EVAL_DIR / "local.sh"

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
GE_SIGN = chr(0x2265)
LE_SIGN = chr(0x2264)
BACKTICK3 = chr(96) * 3
TRIPLE_DQ = chr(34) * 3
TRIPLE_SQ = chr(39) * 3
CO_AUTHORED = "Co-Authored" + "-By"
API_KEY_PREFIX = "AI" + "za"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{8,}")

PRE_EVAL_MD_SHA256 = hashlib.sha256(EVAL_DOC_PATH.read_bytes()).hexdigest()
PRE_DOCS_IMG_EXISTS = DOCS_IMG_DIR.exists()
PRE_DOCS_IMG_NAMES = sorted(p.name for p in DOCS_IMG_DIR.iterdir()) if PRE_DOCS_IMG_EXISTS else []
PRE_NODE_MODULES = (REPO_ROOT / "node_modules").exists()
PRE_DOT_VENV = (REPO_ROOT / ".venv").exists()
PRE_VENV = (REPO_ROOT / "venv").exists()
PRE_EVAL_OUT = (EVAL_DIR / "out").exists()
PRE_EVAL_DATA = (EVAL_DIR / "data").exists()
PRE_EVAL_SYNTH = (EVAL_DIR / "synthetic").exists()


def ref_wilson_pct(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    if not n:
        return None
    p = k / n
    denom = 1.0 + (z * z) / n
    center = (p + (z * z) / (2.0 * n)) / denom
    half = z * math.sqrt((p * (1.0 - p)) / n + (z * z) / (4.0 * n * n)) / denom
    lo = round(100.0 * max(0.0, center - half), 2)
    hi = round(100.0 * min(1.0, center + half), 2)
    return (lo, hi)


def make_http_error(msg: str, code: int | None = None, status_code: int | None = None) -> Exception:
    err = Exception(msg)
    if code is not None:
        setattr(err, "code", code)
    if status_code is not None:
        setattr(err, "status_code", status_code)
    return err


def write_confined_mkdir(bin_dir: pathlib.Path, allowed_root: pathlib.Path) -> None:
    real_mkdir = shutil.which("mkdir") or "/bin/mkdir"
    bin_dir.mkdir(parents=True, exist_ok=True)
    guard_path = bin_dir / "mkdir"
    guard_lines = [
        f"{HASH_CHAR}!{sys.executable}",
        "import os, pathlib, sys",
        "sys.dont_write_bytecode = True",
        f"REAL_MKDIR = {real_mkdir!r}",
        f"ALLOWED = pathlib.Path({str(allowed_root.resolve())!r})",
        "for arg in sys.argv[1:]:",
        "    if arg.startswith('-'):",
        "        continue",
        "    cand = pathlib.Path(arg)",
        "    resolved = (pathlib.Path.cwd() / cand).resolve() if not cand.is_absolute() else cand.resolve()",
        "    if not resolved.is_relative_to(ALLOWED):",
        "        sys.exit(1)",
        "os.execv(REAL_MKDIR, [REAL_MKDIR, *sys.argv[1:]])",
        "",
    ]
    guard_path.write_text("\n".join(guard_lines), encoding="utf-8")
    guard_path.chmod(guard_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestMakeReportIntegrity(unittest.TestCase):
    v1_raw: str
    v1: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        cls.v1_raw = V1_RESULTS_PATH.read_text(encoding="utf-8")
        cls.v1 = json.loads(cls.v1_raw)

    def test_1_ci_cis_rng_and_f_wilson_bounds(self) -> None:
        self.assertIsNone(run_eval.wilson(0, 0))
        self.assertEqual(make_report.ci(0, 0), EN_DASH)
        self.assertEqual(make_report.cis(0, 0), EN_DASH)

        for k, n in ((0, 1280), (0, 754), (0, 461), (0, 120), (49, 4730), (770, 926), (788, 788), (1, 536)):
            self.assertEqual(run_eval.wilson(k, n), ref_wilson_pct(k, n))

        self.assertEqual(
            make_report.ci(0, 1280, 2),
            f"0/1280 = 0.00% (95% CI 0.00{EN_DASH}0.30%)",
        )
        self.assertEqual(
            make_report.ci(0, 754, 2),
            f"0/754 = 0.00% (95% CI 0.00{EN_DASH}0.51%)",
        )
        self.assertEqual(
            make_report.ci(770, 926),
            f"770/926 = 83.2% (95% CI 80.6{EN_DASH}85.4%)",
        )
        self.assertEqual(
            make_report.ci(49, 4730, 2),
            f"49/4730 = 1.04% (95% CI 0.78{EN_DASH}1.37%)",
        )

        self.assertEqual(make_report.cis(0, 1280), f"0.0% [0.0{EN_DASH}0.3]")
        self.assertEqual(make_report.cis(788, 788), f"100.0% [99.5{EN_DASH}100.0]")
        self.assertEqual(make_report.cis(49, 4730), f"1.0% [0.8{EN_DASH}1.4]")

        self.assertEqual(make_report.rng(None), "")
        self.assertEqual(make_report.rng([]), "")
        self.assertEqual(make_report.rng([0.052, 0.064]), f"[0.052{EN_DASH}0.064]")
        self.assertEqual(make_report.rng([3.41, 3.46], " s"), f"[3.41{EN_DASH}3.46 s]")

        self.assertEqual(make_report.f(None), EN_DASH)
        self.assertEqual(make_report.f(80.0), "80.0%")
        self.assertEqual(make_report.f(3.43, " s"), "3.43 s")

    def test_2_field_deg_calib_and_sweep_tables(self) -> None:
        syn = self.v1["synthetic"]

        ft = make_report.field_table(syn)
        ft_lines = ft.splitlines()
        self.assertEqual(len(ft_lines), 11)
        self.assertIn(f"Confident-wrong {GE_SIGN}0.8, all reads", ft_lines[2])
        rendered_fields = [line.split("|")[1].strip() for line in ft_lines[4:]]
        self.assertEqual(rendered_fields, make_report.FIELDS)
        self.assertIn(
            f"| strength | 1280 (126) | 83.2% [80.6{EN_DASH}85.4] (n=926) | "
            f"16.8% [14.6{EN_DASH}19.4] | 98.4% [95.5{EN_DASH}99.5] (n=190) | "
            f"**0/1280** 0.0% [0.0{EN_DASH}0.3] |",
            ft,
        )
        self.assertIn(f"**42/1738** 2.4% [1.8{EN_DASH}3.2]", ft)
        self.assertIn(f"**66/460** 14.3% [11.4{EN_DASH}17.9]", ft)

        partial_res = {"per_field": {"strength": syn["per_field"]["strength"]}}
        ft_partial = make_report.field_table(partial_res)
        self.assertIn("| strength | 1280 (?) |", ft_partial)
        self.assertNotIn("| barcode |", ft_partial)

        dt = make_report.deg_table(syn, "strength")
        dt_lines = dt.splitlines()
        self.assertGreater(len(dt_lines), 15)
        self.assertEqual(
            dt_lines[2],
            f"| clean | 0 | 124 | 100.0% [97.0{EN_DASH}100.0] (n=124) | {EN_DASH} (n=0) | 0/124 | 0/124 |",
        )
        seen_order: list[tuple[int, int]] = []
        for row in dt_lines[2:]:
            parts = [c.strip() for c in row.split("|")[1:-1]]
            cond, sev_str = parts[0], parts[1]
            idx = make_report.DEG_ORDER.index(cond) if cond in make_report.DEG_ORDER else 99
            seen_order.append((idx, int(sev_str)))
            self.assertTrue(parts[6].startswith("0/"))
        self.assertEqual(seen_order, sorted(seen_order))

        custom_deg_res = {
            "per_field_deg_sev": {
                "strength|custom_fog|2": {
                    "n": 10,
                    "n_visible": 6,
                    "n_partial": 2,
                    "n_hidden": 2,
                    "abstain_partial": 50.0,
                    "confident_wrong": 0,
                    "k": {"correct_visible": 5, "abstain_hidden": 2, "wrong_any": 1},
                },
                "strength|clean|0": syn["per_field_deg_sev"]["strength|clean|0"],
            }
        }
        custom_dt_lines = make_report.deg_table(custom_deg_res, "strength").splitlines()
        self.assertTrue(custom_dt_lines[2].startswith("| clean | 0 |"))
        self.assertTrue(custom_dt_lines[3].startswith("| custom_fog | 2 | 10 |"))
        self.assertIn("(n=4) | 1/10 | 0/10 |", custom_dt_lines[3])

        ct = make_report.calib_table(syn["calibration_strength"])
        self.assertIn(f"| [0.95,1.00] | 662 | 0.97 | 100.0% [99.4{EN_DASH}100.0] |", ct)
        self.assertIn(
            f"ECE over 788 answered reads: **0.058** (bootstrap 95% CI [0.052{EN_DASH}0.064])",
            ct,
        )
        cal_with_empty = {
            "bins": [
                {"bin": "[0.00,0.50)", "n": 0, "k": 0, "mean_conf": None},
                {"bin": "[0.80,0.90)", "n": 10, "k": 9, "mean_conf": 0.85},
            ],
            "n_answered": 10,
            "ece": 0.05,
            "ece_ci": [0.01, 0.12],
        }
        ct_sparse = make_report.calib_table(cal_with_empty)
        self.assertNotIn("[0.00,0.50)", ct_sparse)
        self.assertIn("[0.80,0.90)", ct_sparse)

        swt = make_report.sweep_table(syn["threshold_sweep_strength"], syn["per_field"]["strength"]["n_visible"])
        self.assertIn("(coverage, n=926)", swt)
        self.assertIn(f"| 0.8 | 80.0% | 754 | 0/754 0.0% [0.0{EN_DASH}0.5] |", swt)
        self.assertIn(f"| 0.95 | 70.2% | 662 | 0/662 0.0% [0.0{EN_DASH}0.6] |", swt)
        swt_empty = make_report.sweep_table(
            [{"t": 0.99, "coverage_visible": None, "trusted": 0, "trusted_wrong": 0}],
            0,
        )
        self.assertIn(f"| 0.99 | {EN_DASH} | 0 | 0/0 {EN_DASH} |", swt_empty)

    def test_3_safety_tables_unsafe_scen_and_ledger_tables(self) -> None:
        syn = self.v1["synthetic"]
        srv = syn["safety"]["server"]

        st = make_report.safety_table(syn)
        self.assertIn(
            f"| **server safety.ts (as shipped)** | 4730 | 61.0% [59.6{EN_DASH}62.4] | "
            f"36.7% [35.4{EN_DASH}38.1] | **49/4730** 1.0% [0.8{EN_DASH}1.4] | 47 |",
            st,
        )
        self.assertIn("| counterfactual A_food_partial_panel_unsure | 4730 |", st)
        self.assertIn("| counterfactual B_expiry_trust_0.9 | 4730 |", st)
        self.assertIn("| counterfactual A+B | 4730 |", st)
        self.assertNotIn("| variant ", st)

        sdt = make_report.safety_deg_table(srv)
        sdt_lines = sdt.splitlines()
        sdt_conds = [line.split("|")[1].strip() for line in sdt_lines[2:]]
        expected_conds = [d for d in make_report.DEG_ORDER if d in srv["by_deg"]]
        self.assertEqual(sdt_conds, expected_conds)
        self.assertIn(
            f"| clean | 461 | 99.8% [98.8{EN_DASH}100.0] | 0.0% [0.0{EN_DASH}0.8] | 0/461 0.0% [0.0{EN_DASH}0.8] |",
            sdt,
        )
        self.assertIn(
            f"| back_of_box | 120 | 2.5% [0.8{EN_DASH}7.1] | 97.5% [92.9{EN_DASH}99.2] | 0/120 0.0% [0.0{EN_DASH}3.1] |",
            sdt,
        )
        self.assertIn(f"| crop | 744 | 42.5% [39.0{EN_DASH}46.0] | 50.0% [46.4{EN_DASH}53.6] | 33/744 4.4% [3.2{EN_DASH}6.2] |", sdt)

        self.assertEqual(make_report.unsafe_table({}), "_None._")
        self.assertEqual(make_report.unsafe_table({"unsafe_examples": []}), "_None._")
        ut = make_report.unsafe_table(srv)
        ut_lines = ut.splitlines()
        self.assertEqual(len(ut_lines), 2 + len(srv["unsafe_examples"]))
        self.assertIn(
            "| `med012__motion_blur_1.jpg` | expired_date_misread_or_unseen | on_list_same_strength | "
            "warning (expired 2025-09) | match | matches m1; taken today: 0/1 |",
            ut,
        )

        sct = make_report.scen_table(srv)
        self.assertIn(f"| not_on_list | 1280 |", sct)
        self.assertIn(f"0/1280 0.0% [0.0{EN_DASH}0.3] |", sct)
        self.assertIn(f"| on_list_other_strength | 1280 |", sct)

        led_md, tot = make_report.ledger_table(self.v1["ledger"])
        self.assertEqual(tot, {"calls": 2300, "in": 4868332, "out": 774290, "thinking": 825374})
        self.assertIn("| **total** | | **2,300** | **4,868,332** | **774,290** | **825,374** |", led_md)

    def test_4_full_report_rendering_v1_notes_examples_and_real_branch(self) -> None:
        eval_md_before = EVAL_DOC_PATH.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            tmp_repo = base / "repo"
            tmp_out = base / "out"
            tmp_data = base / "data"
            (tmp_repo / "docs").mkdir(parents=True, exist_ok=True)
            tmp_out.mkdir(parents=True, exist_ok=True)
            (tmp_data / "images").mkdir(parents=True, exist_ok=True)

            (tmp_out / "results.json").write_text(self.v1_raw, encoding="utf-8")

            Image.new("RGB", (640, 400), (210, 225, 240)).save(
                tmp_data / "images" / "med003__glare_3.jpg",
                "JPEG",
            )
            Image.new("RGBA", (300, 500), (240, 210, 190, 255)).save(
                tmp_data / "images" / "food001__clean_0.jpg",
                "PNG",
            )

            notes_file = base / "notes.md"
            notes_marker = "Hand-audited note: zero wrong-strength matches across all 1,280 medicine reads."
            notes_file.write_text(notes_marker + "\n", encoding="utf-8")

            argv = [
                "eval/make_report.py",
                "--version",
                "v1-test",
                "--notes",
                str(notes_file),
                "--examples",
                "med003__glare_3,food001__clean_0,nonexistent__clean_9",
                "--captions",
                "Specular glare over strength|Clean front food label",
            ]
            stdout_buf = io.StringIO()
            with (
                warnings.catch_warnings(),
                mock.patch.object(make_report, "REPO", tmp_repo),
                mock.patch.object(make_report, "OUT", tmp_out),
                mock.patch.object(make_report, "DATA", tmp_data),
                mock.patch.object(sys, "argv", argv),
                contextlib.redirect_stdout(stdout_buf),
            ):
                warnings.simplefilter("ignore", ResourceWarning)
                make_report.main()

            self.assertIn("wrote docs/EVAL.md", stdout_buf.getvalue())
            rendered_path = tmp_repo / "docs" / "EVAL.md"
            self.assertTrue(rendered_path.is_file())
            md = rendered_path.read_text(encoding="utf-8")

            self.assertTrue(md.startswith(f"{HASH_CHAR} HoldUp eval (v1-test)\n"))
            self.assertIn("Model under test: `gemini-3.8-flash` (thinking `low`)", md)
            self.assertIn("hash `814770315c42`", md)
            self.assertIn(f"Confident = confidence {GE_SIGN} 0.8.", md)
            self.assertIn("1740 images from 172 Gemini-generated label specs (1280 medicine images, 460 food images)", md)
            self.assertIn(
                f"**Strength confident-wrong: 0/1280 reads** (95% CI 0{EN_DASH}0.30%; across 126 medicine specs, "
                f"the zero-event bound per spec is {LE_SIGN}2.4%). Of all 788 strengths the model reported, "
                f"**788/788 were right** (100.0% [99.5{EN_DASH}100.0]).",
                md,
            )
            self.assertIn(
                f"Unsafe reassurance, end-to-end with the shipped `safety.ts`:** "
                f"49/4730 = 1.04% (95% CI 0.78{EN_DASH}1.37%).",
                md,
            )
            self.assertIn("47 matches on expired boxes", md)
            self.assertIn("2,300 calls in total, 4,868,332 input, 774,290 output and 825,374 thinking tokens", md)

            idx_head = md.index("Headline (synthetic set, v1)")
            idx_note = md.index(notes_marker)
            idx_details = md.index("Details")
            self.assertLess(idx_head, idx_note)
            self.assertLess(idx_note, idx_details)

            self.assertIn("_Pending: photos land in `eval/real/` with `labels.csv` (v2)._", md)
            self.assertIn("![med003__glare_3](img/eval_med003__glare_3.jpg)", md)
            self.assertIn("_Specular glare over strength_", md)
            self.assertIn("![food001__clean_0](img/eval_food001__clean_0.jpg)", md)
            self.assertIn("_Clean front food label_", md)
            self.assertNotIn("nonexistent__clean_9", md)

            thumb_1 = tmp_repo / "docs" / "img" / "eval_med003__glare_3.jpg"
            thumb_2 = tmp_repo / "docs" / "img" / "eval_food001__clean_0.jpg"
            self.assertTrue(thumb_1.is_file())
            self.assertTrue(thumb_2.is_file())
            with Image.open(thumb_1) as im1:
                self.assertEqual(im1.format, "JPEG")
                self.assertEqual(im1.size, (480, 300))
            with Image.open(thumb_2) as im2:
                self.assertEqual(im2.format, "JPEG")
                self.assertEqual(im2.mode, "RGB")
                self.assertEqual(im2.size, (288, 480))

            v1_with_real = copy.deepcopy(self.v1)
            v1_with_real["real"] = {
                "images_scored": 6,
                "latency_s": {"p50": 2.95},
                "per_field": {"strength": self.v1["synthetic"]["per_field"]["strength"]},
                "safety": {"server": self.v1["synthetic"]["safety"]["server"]},
            }
            (tmp_out / "results.json").write_text(json.dumps(v1_with_real), encoding="utf-8")
            with (
                mock.patch.object(make_report, "REPO", tmp_repo),
                mock.patch.object(make_report, "OUT", tmp_out),
                mock.patch.object(make_report, "DATA", tmp_data),
                mock.patch.object(sys, "argv", ["eval/make_report.py", "--examples", "med003__glare_3"]),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                make_report.main()
            md_real = rendered_path.read_text(encoding="utf-8")
            self.assertIn("6 photos. Latency p50 2.95 s.", md_real)
            self.assertNotIn("_Pending: photos land in `eval/real/`", md_real)
            self.assertIn("_med003__glare_3_", md_real)

        self.assertEqual(EVAL_DOC_PATH.read_bytes(), eval_md_before)


class TestCommonIntegrity(unittest.TestCase):
    def test_1_redact_strips_env_key_and_query_params(self) -> None:
        url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models?key=AbCdEf_123-xyz&alt=sse"
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "SYNTH_ENV_SECRET_TOKEN_99"}, clear=False):
            raw = f"POST {url} header=SYNTH_ENV_SECRET_TOKEN_99&key=Second_Key-42"
            red = common._redact(raw)
        self.assertNotIn("SYNTH_ENV_SECRET_TOKEN_99", red)
        self.assertNotIn("AbCdEf_123-xyz", red)
        self.assertNotIn("Second_Key-42", red)
        self.assertIn("header=***", red)
        self.assertEqual(red.count("key=***"), 2)
        self.assertIn("&alt=sse", red)

        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False):
            red_empty = common._redact("plain message with ?key=QuerySecret_01&ok=1")
        self.assertEqual(red_empty, "plain message with ?key=***&ok=1")

    def test_2_is_retryable_transient_and_truncated_json_vs_4xx(self) -> None:
        for status in (408, 429, 500, 502, 503, 504):
            self.assertTrue(common.is_retryable(make_http_error("http failure", code=status)))
            self.assertTrue(common.is_retryable(make_http_error("http failure", status_code=status)))

        for transient_msg in (
            "429 RESOURCE_EXHAUSTED: quota exceeded",
            "500 INTERNAL error from upstream",
            "503 UNAVAILABLE model overloaded",
            "DEADLINE_EXCEEDED timed out waiting for headers",
            "Connection reset by peer",
            "empty response",
        ):
            self.assertTrue(common.is_retryable(RuntimeError(transient_msg)), transient_msg)

        for bad_json in ('{"product": "Burana', "", '{"a": 1}{"b": 2}'):
            with self.assertRaises(json.JSONDecodeError) as ctx:
                json.loads(bad_json)
            self.assertTrue(common.is_retryable(ctx.exception))

        for non_retry_code in (400, 401, 403, 404):
            self.assertFalse(common.is_retryable(make_http_error("client error", code=non_retry_code)))
            self.assertFalse(common.is_retryable(make_http_error("client error", status_code=non_retry_code)))
        self.assertFalse(common.is_retryable(Exception("400 Bad Request: invalid schema")))
        self.assertFalse(common.is_retryable(Exception("401 Unauthorized: API key invalid")))
        self.assertFalse(common.is_retryable(ValueError("unsupported mime type")))

    def test_3_with_retries_mocked_sleep_and_redacted_runtime_error(self) -> None:
        calls = {"n": 0}

        def flaky_then_ok() -> dict[str, Any]:
            calls["n"] += 1
            if calls["n"] == 1:
                raise make_http_error("quota", status_code=429)
            if calls["n"] == 2:
                raise RuntimeError("Unterminated string at char 14")
            return {"status": "ok", "attempt": calls["n"]}

        sleeps: list[float] = []
        with (
            mock.patch.object(common.time, "sleep", side_effect=sleeps.append),
            mock.patch.object(common, "log"),
        ):
            res = common.with_retries(flaky_then_ok, tries=4, base=2.0, label="verify")

        self.assertEqual(res, {"status": "ok", "attempt": 3})
        self.assertEqual(calls["n"], 3)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(all(0.0 < s <= 60.0 for s in sleeps))

        sleeps_exhaust: list[float] = []
        with (
            mock.patch.dict(os.environ, {"GEMINI_API_KEY": "TOP_SECRET_KEY_VALUE"}, clear=False),
            mock.patch.object(common.time, "sleep", side_effect=sleeps_exhaust.append),
            mock.patch.object(common, "log") as mock_log,
        ):
            def always_503() -> None:
                raise RuntimeError("503 UNAVAILABLE key=QueryLeak_77 token=TOP_SECRET_KEY_VALUE")

            with self.assertRaises(RuntimeError) as err_ctx:
                common.with_retries(always_503, tries=3, base=50.0, label="sweep")

        err_txt = str(err_ctx.exception)
        self.assertTrue(err_txt.startswith("sweep: "))
        self.assertNotIn("TOP_SECRET_KEY_VALUE", err_txt)
        self.assertNotIn("QueryLeak_77", err_txt)
        self.assertIn("token=***", err_txt)
        self.assertIn("key=***", err_txt)
        self.assertEqual(len(sleeps_exhaust), 2)
        self.assertTrue(all(s <= 60.0 for s in sleeps_exhaust))
        for log_call in mock_log.call_args_list:
            logged = " ".join(str(x) for x in log_call.args)
            self.assertNotIn("TOP_SECRET_KEY_VALUE", logged)
            self.assertNotIn("QueryLeak_77", logged)

        sleeps_401: list[float] = []
        calls_401 = {"n": 0}
        with (
            mock.patch.dict(os.environ, {"GEMINI_API_KEY": "AUTH_SECRET_88"}, clear=False),
            mock.patch.object(common.time, "sleep", side_effect=sleeps_401.append),
            mock.patch.object(common, "log"),
        ):
            def fail_401() -> None:
                calls_401["n"] += 1
                raise make_http_error("401 Unauthorized AUTH_SECRET_88 ?key=UrlKey_99", code=401)

            with self.assertRaises(RuntimeError) as ctx_401:
                common.with_retries(fail_401, tries=5, base=1.0, label="auth")

        self.assertEqual(calls_401["n"], 1)
        self.assertEqual(sleeps_401, [])
        self.assertNotIn("AUTH_SECRET_88", str(ctx_401.exception))
        self.assertNotIn("UrlKey_99", str(ctx_401.exception))

    def test_4_parse_json_strips_markdown_fences(self) -> None:
        self.assertEqual(common.parse_json('  {"strength": "5 mg", "conf": 0.95}\n'), {"strength": "5 mg", "conf": 0.95})
        fenced_json = f"{BACKTICK3}json\n" + '{"kind": "medication", "ok": true}' + f"\n{BACKTICK3}"
        self.assertEqual(common.parse_json(fenced_json), {"kind": "medication", "ok": True})
        fenced_upper = f"  {BACKTICK3}JSON\n[1, 2, 3]\n{BACKTICK3}  "
        self.assertEqual(common.parse_json(fenced_upper), [1, 2, 3])
        fenced_plain = f"{BACKTICK3}\n" + '{"allergens": ["maap\u00e4hkin\u00e4"]}' + f"\n{BACKTICK3}"
        self.assertEqual(common.parse_json(fenced_plain), {"allergens": ["maap\u00e4hkin\u00e4"]})
        with self.assertRaises(json.JSONDecodeError):
            common.parse_json("")

    def test_5_jsonl_roundtrip_and_thread_safe_append(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            missing = base / "nope.jsonl"
            self.assertEqual(common.read_jsonl(missing), [])

            rows = [
                {"id": "med001", "product": "Thyroxin 100 \u00b5g", "ok": True},
                {"id": "food002", "allergens": ["maap\u00e4hkin\u00e4", "hasselp\u00e4hkin\u00e4"], "ok": False},
            ]
            rt_path = base / "sub" / "roundtrip.jsonl"
            common.write_jsonl(rt_path, rows)
            raw_txt = rt_path.read_text(encoding="utf-8")
            self.assertIn("maap\u00e4hkin\u00e4", raw_txt)
            rt_path.write_text(raw_txt + "\n   \n", encoding="utf-8")
            self.assertEqual(common.read_jsonl(rt_path), rows)

            conc_path = base / "concurrent" / "events.jsonl"
            n_threads = 8
            per_thread = 25
            errors: list[Exception] = []

            def worker(tid: int) -> None:
                try:
                    for seq in range(per_thread):
                        common.append_jsonl(
                            conc_path,
                            {"tid": tid, "seq": seq, "payload": f"item_{tid}_{seq}_" + ("x" * 40)},
                        )
                except Exception as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
            for th in threads:
                th.start()
            for th in threads:
                th.join()

            self.assertEqual(errors, [])
            loaded = common.read_jsonl(conc_path)
            self.assertEqual(len(loaded), n_threads * per_thread)
            pairs = {(r["tid"], r["seq"]) for r in loaded}
            expected_pairs = {(t, s) for t in range(n_threads) for s in range(per_thread)}
            self.assertEqual(pairs, expected_pairs)

        with (
            mock.patch.dict(os.environ, {"GEMINI_API_KEY": "PMAP_SECRET_11"}, clear=False),
            mock.patch.object(common, "log"),
        ):
            def item_fn(x: int) -> dict[str, Any]:
                if x == 2:
                    raise RuntimeError("failed PMAP_SECRET_11 ?key=PmapUrlKey_22")
                return {"v": x * 10}

            pmap_out = common.pmap(item_fn, [0, 1, 2, 3], workers=3, desc="batch")
        self.assertEqual(pmap_out[0], {"v": 0})
        self.assertEqual(pmap_out[1], {"v": 10})
        self.assertEqual(pmap_out[3], {"v": 30})
        self.assertNotIn("PMAP_SECRET_11", pmap_out[2]["error"])
        self.assertNotIn("PmapUrlKey_22", pmap_out[2]["error"])
        self.assertIn("key=***", pmap_out[2]["error"])

    def test_6_ledger_writes_metadata_only_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger_file = pathlib.Path(tmp) / "out" / "ledger.jsonl"
            fake_resp = types.SimpleNamespace(
                text="PRIVATE_LABEL_CONTENT Amlodipine 5 mg Patient Name",
                usage_metadata=types.SimpleNamespace(
                    prompt_token_count=512,
                    candidates_token_count=94,
                    thoughts_token_count=48,
                    cached_content_token_count=128,
                ),
            )
            with mock.patch.object(common, "LEDGER", ledger_file):
                common.ledger("eval.verify_label", "gemini-3.8-flash", fake_resp, 1.23456, True, "low")
                common.ledger("eval.verify_label", "gemini-3.8-flash", None, 0.4321, False, None)

            raw_ledger = ledger_file.read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE_LABEL_CONTENT", raw_ledger)
            self.assertNotIn("Amlodipine", raw_ledger)
            self.assertNotIn("Patient Name", raw_ledger)

            entries = common.read_jsonl(ledger_file)
            self.assertEqual(len(entries), 2)
            expected_keys = {
                "ts",
                "feature",
                "model",
                "in",
                "out",
                "thinking",
                "thinking_level",
                "cached",
                "latency_s",
                "ok",
            }
            self.assertEqual(set(entries[0].keys()), expected_keys)
            self.assertEqual(entries[0]["feature"], "eval.verify_label")
            self.assertEqual(entries[0]["model"], "gemini-3.8-flash")
            self.assertEqual(entries[0]["in"], 512)
            self.assertEqual(entries[0]["out"], 94)
            self.assertEqual(entries[0]["thinking"], 48)
            self.assertEqual(entries[0]["cached"], 128)
            self.assertEqual(entries[0]["thinking_level"], "low")
            self.assertEqual(entries[0]["latency_s"], 1.235)
            self.assertIs(entries[0]["ok"], True)

            self.assertEqual(set(entries[1].keys()), expected_keys)
            self.assertIsNone(entries[1]["in"])
            self.assertIsNone(entries[1]["out"])
            self.assertIsNone(entries[1]["thinking"])
            self.assertIsNone(entries[1]["cached"])
            self.assertIsNone(entries[1]["thinking_level"])
            self.assertEqual(entries[1]["latency_s"], 0.432)
            self.assertIs(entries[1]["ok"], False)

    def test_7_load_env_missing_key_system_exit_and_env_file_parse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            isolated_repo = base / "repo_without_env"
            isolated_home = base / "home_without_env"
            isolated_repo.mkdir()
            isolated_home.mkdir()

            empty_env_file = base / "empty.env"
            empty_env_file.write_text("", encoding="utf-8")

            with (
                mock.patch.object(common, "REPO", isolated_repo),
                mock.patch.dict(
                    os.environ,
                    {
                        "GEMINI_API_KEY": "",
                        "ELEVENLABS_API_KEY": "",
                        "HOLDUP_ENV_FILE": "",
                        "HOME": str(isolated_home),
                    },
                    clear=False,
                ),
            ):
                with self.assertRaises(SystemExit) as ctx_unset:
                    common.load_env()
                self.assertIn("GEMINI_API_KEY not set", str(ctx_unset.exception))

            with (
                mock.patch.object(common, "REPO", isolated_repo),
                mock.patch.dict(
                    os.environ,
                    {
                        "GEMINI_API_KEY": "",
                        "ELEVENLABS_API_KEY": "",
                        "HOLDUP_ENV_FILE": str(empty_env_file),
                        "HOME": str(isolated_home),
                    },
                    clear=False,
                ),
            ):
                with self.assertRaises(SystemExit) as ctx_empty_file:
                    common.load_env()
                self.assertIn("GEMINI_API_KEY not set", str(ctx_empty_file.exception))

            comment_only_env = base / "comments_only.env"
            comment_only_env.write_text(f"{HASH_CHAR} comment line\nOTHER_VAR=1\n", encoding="utf-8")
            with (
                mock.patch.object(common, "REPO", isolated_repo),
                mock.patch.dict(
                    os.environ,
                    {
                        "GEMINI_API_KEY": "",
                        "HOLDUP_ENV_FILE": str(comment_only_env),
                        "HOME": str(isolated_home),
                    },
                    clear=False,
                ),
            ):
                with self.assertRaises(SystemExit) as ctx_no_key:
                    common.load_env()
                self.assertIn("GEMINI_API_KEY not set", str(ctx_no_key.exception))

            valid_env = base / "valid.env"
            valid_env.write_text(
                f"{HASH_CHAR} synthetic test env\nGEMINI_API_KEY=\"SYNTH_LOADED_FROM_FILE\"\n",
                encoding="utf-8",
            )
            env_copy = dict(os.environ)
            env_copy.pop("GEMINI_API_KEY", None)
            env_copy["HOLDUP_ENV_FILE"] = str(valid_env)
            env_copy["HOME"] = str(isolated_home)
            with (
                mock.patch.object(common, "REPO", isolated_repo),
                mock.patch.dict(os.environ, env_copy, clear=True),
            ):
                common.load_env()
                self.assertEqual(os.environ.get("GEMINI_API_KEY"), "SYNTH_LOADED_FROM_FILE")


class TestShellScriptsUsageIntegrity(unittest.TestCase):
    def test_pipeline_and_local_sh_invalid_arg_exits_nonzero_keylessly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp).resolve()
            tmp_repo = base / "repo"
            tmp_eval = tmp_repo / "eval"
            tmp_eval.mkdir(parents=True, exist_ok=True)
            tmp_home = base / "home"
            tmp_home.mkdir(parents=True, exist_ok=True)
            tmp_bin = base / "bin"
            write_confined_mkdir(tmp_bin, base)

            shutil.copy2(PIPELINE_SH, tmp_eval / "pipeline.sh")
            shutil.copy2(LOCAL_SH, tmp_eval / "local.sh")

            closed_proxy = f"http:{SLASH2}127.0.0.1:1"
            env = dict(os.environ)
            env["GEMINI_API_KEY"] = ""
            env["ELEVENLABS_API_KEY"] = ""
            env["HOME"] = str(tmp_home)
            env["DATA_ROOT"] = str(base / "data_root")
            env["HOLDUP_DATA"] = str(base / "holdup_data")
            env["HOLDUP_OUT"] = str(base / "holdup_out")
            env["HOLDUP_SNAPSHOT"] = str(base / "holdup_snap")
            env["VENV"] = str(base / "venv_unused")
            env["HTTP_PROXY"] = closed_proxy
            env["HTTPS_PROXY"] = closed_proxy
            env["PATH"] = f"{tmp_bin}:{env.get('PATH', '/usr/bin:/bin')}"

            for script_name, args, expected_snippet in (
                ("pipeline.sh", ["invalid_step_name"], "Usage"),
                ("pipeline.sh", [], "Usage"),
                ("local.sh", ["invalid_step_name"], "Usage: bash eval/local.sh"),
                ("local.sh", [""], "Usage: bash eval/local.sh"),
            ):
                with self.subTest(script=script_name, args=args):
                    proc = subprocess.run(
                        ["bash", str(tmp_eval / script_name), *args],
                        cwd=str(tmp_repo),
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertEqual(proc.returncode, 1)
                    self.assertIn(expected_snippet, proc.stdout)

            self.assertFalse((tmp_repo / "node_modules").exists())
            self.assertFalse((tmp_repo / ".venv").exists())
            self.assertFalse((tmp_repo / "venv").exists())
            self.assertFalse((base / "venv_unused").exists())
            self.assertFalse(pathlib.Path("/data/silas/junction-meta-glasses").exists())


class TestSourceAndWorkspaceHygiene(unittest.TestCase):
    def test_z_strict_source_and_workspace_hygiene(self) -> None:
        self_src = pathlib.Path(__file__).resolve().read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_src)
        self.assertNotIn(SLASH2, self_src)
        self.assertNotIn(TRIPLE_DQ, self_src)
        self.assertNotIn(TRIPLE_SQ, self_src)
        self.assertNotIn(EM_DASH, self_src)
        self.assertNotIn(EN_DASH, self_src)
        self.assertNotIn(CO_AUTHORED, self_src)
        self.assertNotIn(CO_AUTHORED.lower(), self_src.lower())
        self.assertNotIn(API_KEY_PREFIX, self_src)

        for target in (
            EVAL_DIR / "make_report.py",
            EVAL_DIR / "common.py",
            PIPELINE_SH,
            LOCAL_SH,
            V1_RESULTS_PATH,
        ):
            raw = target.read_text(encoding="utf-8")
            self.assertNotIn(CO_AUTHORED.lower(), raw.lower(), str(target))
            self.assertIsNone(API_KEY_RE.search(raw), str(target))

        self.assertIsNone(common._client)

        post_eval_md_sha256 = hashlib.sha256(EVAL_DOC_PATH.read_bytes()).hexdigest()
        self.assertEqual(post_eval_md_sha256, PRE_EVAL_MD_SHA256)
        self.assertEqual(DOCS_IMG_DIR.exists(), PRE_DOCS_IMG_EXISTS)
        if PRE_DOCS_IMG_EXISTS:
            self.assertEqual(sorted(p.name for p in DOCS_IMG_DIR.iterdir()), PRE_DOCS_IMG_NAMES)

        self.assertEqual((REPO_ROOT / "node_modules").exists(), PRE_NODE_MODULES)
        self.assertEqual((REPO_ROOT / ".venv").exists(), PRE_DOT_VENV)
        self.assertEqual((REPO_ROOT / "venv").exists(), PRE_VENV)
        self.assertFalse((EVAL_DIR / "node_modules").exists())
        self.assertFalse((EVAL_DIR / ".venv").exists())
        self.assertFalse((EVAL_DIR / "venv").exists())
        self.assertEqual((EVAL_DIR / "out").exists(), PRE_EVAL_OUT)
        self.assertEqual((EVAL_DIR / "data").exists(), PRE_EVAL_DATA)
        self.assertEqual((EVAL_DIR / "synthetic").exists(), PRE_EVAL_SYNTH)


if __name__ == "__main__":
    unittest.main()
