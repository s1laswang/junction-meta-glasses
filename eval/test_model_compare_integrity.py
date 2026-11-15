from __future__ import annotations

import json
import math
import pathlib
import re
import socket
import struct
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

sys.dont_write_bytecode = True

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import common
import compare_models as cm
import run_eval as reval

COMPARE_JSON = EVAL_DIR / "results" / "v2_model_compare.json"
SUITE_COMPARE_JSON = EVAL_DIR / "suites" / "model_comparison" / "results.json"
V1_GT_JSONL = EVAL_DIR / "results" / "v1" / "ground_truth.jsonl"
V1_PREDS_JSONL = EVAL_DIR / "results" / "v1" / "preds_synthetic.jsonl"
GT_OVERRIDES_JSON = EVAL_DIR / "gt_overrides.json"
EVAL_MD = REPO_ROOT / "docs" / "EVAL.md"
GEMINI_MD = REPO_ROOT / "GEMINI.md"
COMPARE_PNG = REPO_ROOT / "docs" / "img" / "eval_model_compare.png"

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
TRIPLE_DQ = chr(34) * 3
TRIPLE_SQ = chr(39) * 3
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
MINUS_SIGN = chr(0x2212)
API_KEY_PREFIX = "AI" + "za"
DOT_GIT_TOKEN = "." + "git"
GIT_CMD_TOKEN = "git" + " "
SUBPROCESS_TOKEN = "sub" + "process"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{8,}")
BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")

EXPECTED_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemma-4-31b-it"]
EXPECTED_PAIRED = ["gemini-3.5-flash", "gemma-4-31b-it"]


def forbid_live_call(*_args: Any, **_kwargs: Any) -> Any:
    raise AssertionError("Keyless integrity test must never invoke network or Gemini client")


def load_committed_v1_rows() -> list[dict[str, Any]]:
    rows = common.read_jsonl(V1_GT_JSONL)
    overrides = json.loads(GT_OVERRIDES_JSON.read_text(encoding="utf-8"))
    for row in rows:
        for field_name, val in (overrides.get(row["spec_id"]) or {}).items():
            if not field_name.startswith("_") and field_name in row["gt"]:
                row["gt"][field_name]["value"] = val
                row["gt"][field_name]["overridden"] = True
    return rows


def extract_eval_v2_2_section(md_text: str) -> str:
    h3_prefix = HASH_CHAR * 3 + " 2. Paired model comparison:"
    next_h2 = "\n" + HASH_CHAR * 2 + " "
    next_h3 = "\n" + HASH_CHAR * 3 + " "
    start = md_text.find(h3_prefix)
    if start < 0:
        raise AssertionError("Missing Section v2.2 heading in docs/EVAL.md")
    search_from = start + len(h3_prefix)
    candidates = [idx for idx in (md_text.find(next_h2, search_from), md_text.find(next_h3, search_from)) if idx >= 0]
    return md_text[start:] if not candidates else md_text[start:min(candidates)]


def parse_markdown_table(section_text: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if all(set(c) <= {"-", ":"} and len(c) >= 3 for c in cells):
            continue
        rows.append(cells)
    return rows


def assert_two_float_bounds(tc: unittest.TestCase, pair: Any, lo_min: float | None = None, hi_max: float | None = None) -> tuple[float, float]:
    tc.assertIsInstance(pair, list)
    tc.assertEqual(len(pair), 2)
    lo, hi = pair
    tc.assertFalse(isinstance(lo, bool) or isinstance(hi, bool))
    tc.assertIsInstance(lo, (int, float))
    tc.assertIsInstance(hi, (int, float))
    lo_f, hi_f = float(lo), float(hi)
    tc.assertTrue(math.isfinite(lo_f) and math.isfinite(hi_f))
    tc.assertLessEqual(lo_f, hi_f)
    if lo_min is not None:
        tc.assertGreaterEqual(lo_f, lo_min)
    if hi_max is not None:
        tc.assertLessEqual(hi_f, hi_max)
    return lo_f, hi_f


class TestModelCompareIntegrity(unittest.TestCase):
    _patchers: list[Any] = []

    @classmethod
    def setUpClass(cls) -> None:
        if common._client is not None:
            raise AssertionError("Gemini client must be None before keyless tests")
        cls._patchers = [
            mock.patch.object(socket.socket, "connect", side_effect=forbid_live_call),
            mock.patch.object(socket, "create_connection", side_effect=forbid_live_call),
            mock.patch.object(common, "client", side_effect=forbid_live_call),
            mock.patch.object(cm, "client", side_effect=forbid_live_call),
            mock.patch.object(reval, "ts_verdicts", side_effect=forbid_live_call),
        ]
        for p in cls._patchers:
            p.start()
        cls.raw_bytes = COMPARE_JSON.read_bytes()
        cls.raw_text = cls.raw_bytes.decode("utf-8")
        cls.data = json.loads(cls.raw_text)
        cls.eval_md_text = EVAL_MD.read_text(encoding="utf-8")
        cls.v2_2_text = extract_eval_v2_2_section(cls.eval_md_text)
        cls.gemini_md_text = GEMINI_MD.read_text(encoding="utf-8")
        cls.suite_compare = json.loads(SUITE_COMPARE_JSON.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        for p in reversed(cls._patchers):
            p.stop()
        if common._client is not None:
            raise AssertionError("Gemini client must remain None after keyless tests")

    def test_artifact_structure_security_and_prompt_hash(self) -> None:
        self.assertTrue(COMPARE_JSON.is_file())
        self.assertLess(len(self.raw_bytes), 25000)
        self.assertNotIn(EM_DASH, self.raw_text)
        self.assertNotIn(EN_DASH, self.raw_text)
        self.assertNotIn(API_KEY_PREFIX, self.raw_text)
        self.assertIsNone(API_KEY_RE.search(self.raw_text))
        self.assertNotIn("data:image", self.raw_text.lower())
        self.assertNotIn("/9j/", self.raw_text)
        self.assertNotIn("iVBORw0KGgo", self.raw_text)
        self.assertIsNone(BASE64_BLOB_RE.search(self.raw_text))

        self.assertTrue(COMPARE_PNG.is_file())
        png_bytes = COMPARE_PNG.read_bytes()
        self.assertEqual(png_bytes[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(png_bytes[12:16], b"IHDR")
        self.assertEqual(struct.unpack(">II", png_bytes[16:24]), (1950, 495))
        self.assertEqual(png_bytes[-12:], b"\x00\x00\x00\x00IEND\xaeB`\x82")
        self.assertGreater(len(png_bytes), 1000)
        self.assertLess(len(png_bytes), 500000)

        _, _, prompt_src, prompt_hash = reval.load_prompt_schema()
        self.assertEqual(self.data["prompt_src"], "shared")
        self.assertEqual(prompt_src, "shared")
        self.assertEqual(self.data["prompt_hash"], "814770315c42")
        self.assertEqual(self.data["prompt_hash"], prompt_hash)
        self.assertEqual(self.data["n_images"], 150)
        self.assertEqual(self.data["subset_seed"], 42)
        self.assertEqual(self.data["reference"], "gemini-3.8-flash")
        self.assertEqual(self.data["subset_by_kind"], {"food": 68, "medication": 82})
        self.assertEqual(sum(self.data["subset_by_kind"].values()), 150)
        expected_deg = {
            "back_of_box": 3,
            "clean": 9,
            "crop": 21,
            "defocus": 23,
            "glare": 24,
            "low_light": 23,
            "motion_blur": 22,
            "rotation": 25,
        }
        self.assertEqual(self.data["subset_by_deg"], expected_deg)
        self.assertEqual(sum(self.data["subset_by_deg"].values()), 150)
        self.assertEqual(list(self.data["models"].keys()), EXPECTED_MODELS)
        self.assertEqual(list(self.data["paired_vs_reference"].keys()), EXPECTED_PAIRED)

    def test_zero_confident_wrong_strength_and_silent_unsafe_counts(self) -> None:
        models = self.data["models"]
        for model_name in EXPECTED_MODELS:
            m = models[model_name]
            self.assertEqual(m["errors_or_unparseable"], 0)
            self.assertEqual(m["errors_examples"], [])
            scw = m["strength_confident_wrong"]
            self.assertEqual(scw["k"], 0)
            self.assertEqual(scw["n"], 82)
            self.assertEqual(scw["pct"], 0.0)
            self.assertEqual(scw["wilson95_pct"], [0.0, 4.48])
            self.assertEqual(scw["rule_of_three_upper_pct"], 3.66)

        for flash_model in ("gemini-3.8-flash", "gemini-3.5-flash"):
            m = models[flash_model]
            self.assertEqual(m["calls_retried_after_error"], 0)
            ur = m["unsafe_reassurance"]
            self.assertEqual(ur["k"], 0)
            self.assertEqual(ur["n"], 377)
            self.assertEqual(ur["pct"], 0.0)
            self.assertEqual(ur["wilson95_pct"], [0.0, 1.01])
            self.assertEqual(ur["rule_of_three_upper_pct"], 0.8)

        gemma = models["gemma-4-31b-it"]
        self.assertEqual(gemma["calls_retried_after_error"], 10)
        gemma_ur = gemma["unsafe_reassurance"]
        self.assertEqual(gemma_ur["k"], 2)
        self.assertEqual(gemma_ur["n"], 377)
        self.assertEqual(gemma_ur["pct"], 0.53)
        self.assertEqual(gemma_ur["wilson95_pct"], [0.15, 1.91])
        self.assertNotIn("rule_of_three_upper_pct", gemma_ur)

    def test_all_rate_metrics_and_wilson_ci_recomputation(self) -> None:
        models = self.data["models"]
        expected_counts = {
            "gemini-3.8-flash": {
                "strength_acc_readable": (46, 59),
                "strength_confident_wrong": (0, 82),
                "fields_confident_wrong": (19, 528),
                "unsafe_reassurance": (0, 377),
                "verdict_correct": (214, 377),
                "unsure": (158, 377),
            },
            "gemini-3.5-flash": {
                "strength_acc_readable": (42, 59),
                "strength_confident_wrong": (0, 82),
                "fields_confident_wrong": (20, 528),
                "unsafe_reassurance": (0, 377),
                "verdict_correct": (207, 377),
                "unsure": (164, 377),
            },
            "gemma-4-31b-it": {
                "strength_acc_readable": (46, 59),
                "strength_confident_wrong": (0, 82),
                "fields_confident_wrong": (38, 528),
                "unsafe_reassurance": (2, 377),
                "verdict_correct": (219, 377),
                "unsure": (147, 377),
            },
        }

        for model_name, counts in expected_counts.items():
            m = models[model_name]
            for metric_name, (exp_k, exp_n) in counts.items():
                got = m[metric_name]
                self.assertEqual((got["k"], got["n"]), (exp_k, exp_n))
                recomputed = json.loads(json.dumps(cm.rate_ci(exp_k, exp_n)))
                self.assertEqual(got, recomputed)
                lo, hi = assert_two_float_bounds(self, got["wilson95_pct"], 0.0, 100.0)
                self.assertLessEqual(lo, got["pct"])
                self.assertLessEqual(got["pct"], hi)
            total_verdicts = m["unsafe_reassurance"]["k"] + m["verdict_correct"]["k"] + m["unsure"]["k"]
            self.assertLessEqual(total_verdicts, 377)

        self.assertGreater(
            models["gemma-4-31b-it"]["fields_confident_wrong"]["k"],
            models["gemini-3.8-flash"]["fields_confident_wrong"]["k"],
        )
        self.assertGreater(
            models["gemma-4-31b-it"]["fields_confident_wrong"]["k"],
            models["gemini-3.5-flash"]["fields_confident_wrong"]["k"],
        )

        v1_run = self.data["test_retest_gemini-3.8-flash"]["v1_run"]
        self.assertEqual(v1_run["errors_or_unparseable"], 0)
        self.assertNotIn("latency", v1_run)
        for metric_name in cm.METRICS:
            got = v1_run[metric_name]
            recomputed = json.loads(json.dumps(cm.rate_ci(got["k"], got["n"])))
            self.assertEqual(got, recomputed)

    def test_latency_p50_p95_ordering_and_paired_ci_bounds(self) -> None:
        models = self.data["models"]
        lat_35 = models["gemini-3.5-flash"]["latency"]
        lat_38 = models["gemini-3.8-flash"]["latency"]
        lat_gm = models["gemma-4-31b-it"]["latency"]

        self.assertEqual(lat_35, {"n": 150, "p50_s": 2.05, "p95_s": 4.51, "p50_ci95_s": [1.89, 2.28]})
        self.assertEqual(lat_38, {"n": 150, "p50_s": 3.18, "p95_s": 6.07, "p50_ci95_s": [3.02, 3.37]})
        self.assertEqual(lat_gm, {"n": 150, "p50_s": 27.82, "p95_s": 48.49, "p50_ci95_s": [26.89, 29.91]})

        for lat in (lat_35, lat_38, lat_gm):
            self.assertEqual(lat["n"], 150)
            lo, hi = assert_two_float_bounds(self, lat["p50_ci95_s"], 0.01)
            self.assertLessEqual(lo, lat["p50_s"])
            self.assertLessEqual(lat["p50_s"], hi)
            self.assertLess(hi, lat["p95_s"])

        self.assertLess(lat_35["p50_s"], lat_38["p50_s"])
        self.assertLess(lat_38["p50_s"], lat_gm["p50_s"])
        self.assertLess(lat_35["p95_s"], lat_38["p95_s"])
        self.assertLess(lat_38["p95_s"], lat_gm["p95_s"])
        self.assertLess(lat_35["p50_ci95_s"][1], lat_38["p50_ci95_s"][0])
        self.assertLess(lat_38["p50_ci95_s"][1], lat_gm["p50_ci95_s"][0])

        paired = self.data["paired_vs_reference"]
        plat_35 = paired["gemini-3.5-flash"]["latency"]
        plat_gm = paired["gemma-4-31b-it"]["latency"]

        self.assertEqual(plat_35, {"n_pairs": 150, "median_diff_s": -1.17, "ci95_s": [-1.34, -0.94], "model_slower_on": 23})
        self.assertEqual(plat_gm, {"n_pairs": 150, "median_diff_s": 24.29, "ci95_s": [23.25, 26.05], "model_slower_on": 150})

        lo_35, hi_35 = assert_two_float_bounds(self, plat_35["ci95_s"])
        self.assertLessEqual(lo_35, plat_35["median_diff_s"])
        self.assertLessEqual(plat_35["median_diff_s"], hi_35)
        self.assertLess(hi_35, 0.0)
        self.assertTrue(0 <= plat_35["model_slower_on"] < 75)

        lo_gm, hi_gm = assert_two_float_bounds(self, plat_gm["ci95_s"])
        self.assertGreater(lo_gm, 0.0)
        self.assertLessEqual(lo_gm, plat_gm["median_diff_s"])
        self.assertLessEqual(plat_gm["median_diff_s"], hi_gm)
        self.assertEqual(plat_gm["model_slower_on"], 150)

        ref = models["gemini-3.8-flash"]
        comparisons = [
            (ref, models["gemini-3.5-flash"], paired["gemini-3.5-flash"]),
            (ref, models["gemma-4-31b-it"], paired["gemma-4-31b-it"]),
            (
                self.data["test_retest_gemini-3.8-flash"]["v1_run"],
                ref,
                self.data["test_retest_gemini-3.8-flash"]["v2_minus_v1"],
            ),
        ]
        for base_m, cand_m, pblock in comparisons:
            for metric_name in cm.METRICS:
                entry = pblock[metric_name]
                exp_diff = round(
                    100.0 * cand_m[metric_name]["k"] / cand_m[metric_name]["n"]
                    - 100.0 * base_m[metric_name]["k"] / base_m[metric_name]["n"],
                    2,
                )
                self.assertEqual(entry["diff_pp"], exp_diff)
                lo, hi = assert_two_float_bounds(self, entry["ci95_pp"], -100.0, 100.0)
                self.assertLessEqual(lo, entry["diff_pp"])
                self.assertLessEqual(entry["diff_pp"], hi)
                if metric_name == "fields_confident_wrong":
                    self.assertNotIn("mcnemar_exact_p", entry)
                else:
                    b = entry["discordant_ref_only"]
                    c = entry["discordant_model_only"]
                    self.assertIsInstance(b, int)
                    self.assertIsInstance(c, int)
                    self.assertGreaterEqual(b, 0)
                    self.assertGreaterEqual(c, 0)
                    self.assertEqual(cand_m[metric_name]["k"] - base_m[metric_name]["k"], c - b)
                    p_val = entry["mcnemar_exact_p"]
                    self.assertTrue(0.0 <= p_val <= 1.0)
                    self.assertEqual(p_val, cm.mcnemar_exact(b, c))

        gemma_fcw_ci = paired["gemma-4-31b-it"]["fields_confident_wrong"]["ci95_pp"]
        self.assertGreater(gemma_fcw_ci[0], 0.0)
        flash35_str_ci = paired["gemini-3.5-flash"]["strength_acc_readable"]["ci95_pp"]
        self.assertTrue(flash35_str_ci[0] < 0.0 <= flash35_str_ci[1])

    def test_stratified_subset_and_v1_retest_recomputation_from_committed_gt(self) -> None:
        v1_rows = load_committed_v1_rows()
        self.assertEqual(len(v1_rows), 1740)
        with mock.patch.object(cm, "synthetic_rows", return_value=v1_rows):
            sub = cm.subset(150)

        self.assertEqual(len(sub), 150)
        ids = [r["img_id"] for r in sub]
        self.assertEqual(len(set(ids)), 150)
        by_kind = {k: sum(r["kind"] == k for r in sub) for k in sorted({r["kind"] for r in sub})}
        by_deg = {d: sum(r["deg"] == d for r in sub) for d in sorted({r["deg"] for r in sub})}
        self.assertEqual(by_kind, self.data["subset_by_kind"])
        self.assertEqual(by_deg, self.data["subset_by_deg"])
        self.assertEqual(sum(len(reval.scenarios(r)) for r in sub), 377)

        preds = cm.load_preds(V1_PREDS_JSONL, self.data["prompt_hash"], set(ids))
        self.assertEqual(len(preds), 150)

        st_vis_n = 0
        st_vis_ok = 0
        st_scored_n = 0
        st_cw_k = 0
        fields_n = 0
        fields_cw_k = 0
        for row in sub:
            rec = preds[row["img_id"]]
            self.assertFalse(rec.get("error"))
            label_read = reval.to_label_read(rec["pred"])
            st_cls = reval.classify(row, label_read, "strength")
            if st_cls is not None:
                st_scored_n += 1
                if st_cls["status"] == "visible":
                    st_vis_n += 1
                    if st_cls["outcome"] == "correct":
                        st_vis_ok += 1
                if st_cls["outcome"] == "wrong" and st_cls["conf"] >= reval.CONF_T:
                    st_cw_k += 1
            for field_name in ("product", "ingredient", "strength", "expiry", "allergens"):
                f_cls = reval.classify(row, label_read, field_name)
                if f_cls is not None:
                    fields_n += 1
                    if f_cls["outcome"] == "wrong" and f_cls["conf"] >= reval.CONF_T:
                        fields_cw_k += 1

        v1_run = self.data["test_retest_gemini-3.8-flash"]["v1_run"]
        self.assertEqual((st_vis_ok, st_vis_n), (v1_run["strength_acc_readable"]["k"], v1_run["strength_acc_readable"]["n"]))
        self.assertEqual((st_cw_k, st_scored_n), (v1_run["strength_confident_wrong"]["k"], v1_run["strength_confident_wrong"]["n"]))
        self.assertEqual((fields_cw_k, fields_n), (v1_run["fields_confident_wrong"]["k"], v1_run["fields_confident_wrong"]["n"]))

    def test_docs_eval_v2_2_markdown_sync(self) -> None:
        sec = self.v2_2_text
        for snippet in (
            "150 images",
            "seed 42; 82 medicines, 68 foods",
            "814770315c42",
            "All 450 calls returned parseable JSON",
            "10 quota 429s",
            "eval/results/v2_model_compare.json",
            "docs/img/eval_model_compare.png",
        ):
            self.assertIn(snippet, sec)

        table = parse_markdown_table(sec)
        self.assertEqual(len(table), 9)
        header = table[0]
        self.assertIn("n = 150 images", header[0])
        self.assertIn("gemini-3.8-flash", header[1])
        self.assertEqual(header[2], "gemini-3.5-flash")
        self.assertEqual(header[3], "gemma-4-31b-it")

        row_map = {r[0]: r[1:] for r in table[1:]}
        models = self.data["models"]

        rate_rows = [
            ("Strength correct, readable (n = 59)", "strength_acc_readable", 59),
            ("Confident-wrong, any field (n = 528)", "fields_confident_wrong", 528),
            ("Verdict equals the true-label verdict", "verdict_correct", 377),
            ('"Not sure"', "unsure", 377),
        ]
        rate_re = re.compile(r"(\d+)\s*=\s*(\d+\.\d+)%\s*\((\d+\.\d+)[^\d]+(\d+\.\d+)%\)")
        for label, metric_key, expected_n in rate_rows:
            matched_cells = next((cells for k, cells in row_map.items() if label in k), None)
            self.assertIsNotNone(matched_cells, f"Missing row {label}")
            assert matched_cells is not None
            for col_idx, model_name in enumerate(EXPECTED_MODELS):
                cell_clean = matched_cells[col_idx].replace("*", "")
                m = rate_re.search(cell_clean)
                self.assertIsNotNone(m, f"Unparseable rate cell {cell_clean}")
                assert m is not None
                k_val = int(m.group(1))
                pct_val = float(m.group(2))
                lo_val = float(m.group(3))
                hi_val = float(m.group(4))
                md = models[model_name][metric_key]
                self.assertEqual(md["n"], expected_n)
                self.assertEqual(k_val, md["k"])
                self.assertLessEqual(abs(pct_val - md["pct"]), 0.06)
                self.assertLessEqual(abs(lo_val - md["wilson95_pct"][0]), 0.06)
                self.assertLessEqual(abs(hi_val - md["wilson95_pct"][1]), 0.06)

        cw_cells = next(cells for k, cells in row_map.items() if "Confident-wrong strength" in k and "n = 82" in k)
        for col_idx, model_name in enumerate(EXPECTED_MODELS):
            cell_clean = cw_cells[col_idx].replace("*", "")
            self.assertTrue(cell_clean.startswith("0 "))
            bound_m = re.search(r"(\d+\.\d+)%", cell_clean)
            self.assertIsNotNone(bound_m)
            assert bound_m is not None
            self.assertLessEqual(
                abs(float(bound_m.group(1)) - models[model_name]["strength_confident_wrong"]["rule_of_three_upper_pct"]),
                0.06,
            )

        allergen_cells = next(cells for k, cells in row_map.items() if "of which allergens" in k)
        for col_idx, model_name in enumerate(EXPECTED_MODELS):
            al_k = int(allergen_cells[col_idx])
            self.assertLessEqual(al_k, models[model_name]["fields_confident_wrong"]["k"])
        self.assertEqual([int(c) for c in allergen_cells], [8, 9, 21])

        unsafe_cells = next(cells for k, cells in row_map.items() if "Silent unsafe reassurance" in k and "n = 377" in k)
        for col_idx, flash_name in enumerate(("gemini-3.8-flash", "gemini-3.5-flash")):
            cell_clean = unsafe_cells[col_idx].replace("*", "")
            self.assertTrue(cell_clean.startswith("0 "))
            self.assertIn("0.8%", cell_clean)
            self.assertEqual(models[flash_name]["unsafe_reassurance"]["rule_of_three_upper_pct"], 0.8)
        gm_unsafe_clean = unsafe_cells[2].replace("*", "")
        gm_m = re.search(r"(\d+)\s*=\s*(\d+\.\d+)%\s*\((\d+\.\d+)[^\d]+(\d+\.\d+)%\)", gm_unsafe_clean)
        self.assertIsNotNone(gm_m)
        assert gm_m is not None
        self.assertEqual(int(gm_m.group(1)), 2)
        self.assertEqual(float(gm_m.group(2)), 0.53)
        self.assertEqual([float(gm_m.group(3)), float(gm_m.group(4))], [0.15, 1.91])

        lat_cells = next(cells for k, cells in row_map.items() if "Verify latency p50 / p95" in k)
        lat_re = re.compile(r"(\d+\.\d+)\s*s\s*\((\d+\.\d+)[^\d]+(\d+\.\d+)\)\s*/\s*(\d+\.\d+)\s*s")
        for col_idx, model_name in enumerate(EXPECTED_MODELS):
            cell_clean = lat_cells[col_idx].replace("*", "")
            lm = lat_re.search(cell_clean)
            self.assertIsNotNone(lm, f"Unparseable latency cell {cell_clean}")
            assert lm is not None
            p50_v, lo_v, hi_v, p95_v = (float(lm.group(i)) for i in range(1, 5))
            ld = models[model_name]["latency"]
            self.assertLessEqual(abs(p50_v - ld["p50_s"]), 0.06)
            self.assertLessEqual(abs(lo_v - ld["p50_ci95_s"][0]), 0.06)
            self.assertLessEqual(abs(hi_v - ld["p50_ci95_s"][1]), 0.06)
            self.assertLessEqual(abs(p95_v - ld["p95_s"]), 0.06)

        norm_sec = sec.replace(MINUS_SIGN, "-").replace(EN_DASH, "-")
        for prose_fact in (
            "-6.8 pp (-15.1 to 0.0; 5 vs 1 discordant, p = 0.22)",
            "-1.17 s, -1.34 to -0.94; slower on only 23/150 images",
            "+3.6 pp (+1.7 to +5.5)",
            "24.3 s slower",
            "(23.3-26.1), slower on 150/150 images",
            "Strength is 46/59 both times (2 vs 2 discordant)",
        ):
            self.assertIn(prose_fact, norm_sec)

    def test_compare_models_offline_helpers(self) -> None:
        self.assertEqual(cm.parse_reply('{"kind": "food", "readability": 0.9}'), {"kind": "food", "readability": 0.9})
        self.assertEqual(
            cm.parse_reply('Here is the JSON:\n```json\n{"kind": "medication", "readability": 0.85}\n```\nDone.'),
            {"kind": "medication", "readability": 0.85},
        )
        self.assertEqual(
            cm.parse_reply('Prefix text {"kind": "unreadable", "readability": 0.1} trailing text'),
            {"kind": "unreadable", "readability": 0.1},
        )
        with self.assertRaises(json.JSONDecodeError):
            cm.parse_reply("not json at all")

        self.assertTrue(
            cm.is_unsafe({
                "world": "warning",
                "pred": "info",
                "pred_reasons": ["none of your allergens"],
                "world_reasons": ["allergy: peanut"],
            })
        )
        self.assertFalse(
            cm.is_unsafe({
                "world": "warning",
                "pred": "match",
                "pred_reasons": ["matched evening med", "expiry not readable"],
                "world_reasons": ["expired 2025-09"],
            })
        )
        self.assertFalse(
            cm.is_unsafe({
                "world": "warning",
                "pred": "unsure",
                "pred_reasons": ["low confidence"],
                "world_reasons": ["allergy: peanut"],
            })
        )

        self.assertEqual(cm.mcnemar_exact(0, 0), 1.0)
        self.assertEqual(cm.mcnemar_exact(5, 1), 0.2188)
        self.assertEqual(cm.mcnemar_exact(1, 5), 0.2188)
        self.assertEqual(cm.mcnemar_exact(0, 2), 0.5)

        imgs = [f"img_{i}" for i in range(10)]
        per_a = {f"img_{i}": {"lat": 3.0 + 0.1 * i} for i in range(10)}
        per_b = {f"img_{i}": {"lat": 2.0 + 0.1 * i} for i in range(10)}
        lat_a = cm.latency(per_a, imgs, B=200, seed=2)
        self.assertEqual(lat_a["n"], 10)
        self.assertLessEqual(lat_a["p50_ci95_s"][0], lat_a["p50_s"])
        self.assertLessEqual(lat_a["p50_s"], lat_a["p50_ci95_s"][1])
        self.assertLessEqual(lat_a["p50_s"], lat_a["p95_s"])

        plat = cm.paired_latency(per_a, per_b, imgs, B=200, seed=3)
        self.assertEqual(plat["n_pairs"], 10)
        self.assertEqual(plat["median_diff_s"], -1.0)
        self.assertEqual(plat["ci95_s"], [-1.0, -1.0])
        self.assertEqual(plat["model_slower_on"], 0)

    def test_gemini_md_and_directional_suite_cross_sync(self) -> None:
        norm_gemini = self.gemini_md_text.replace(MINUS_SIGN, "-").replace(EN_DASH, "-")
        for fact in (
            "150 paired images",
            "docs/EVAL.md",
            "docs/img/eval_model_compare.png",
            "0 confident-wrong strength reads",
            "46/59 = 78.0%",
            "42/59 = 71.2%",
            "38/528 = 7.2%",
            "19/528 = 3.6%",
            "2/377 = 0.53%",
            "27.8 s vs 3.2 s",
            "1.2 s faster",
        ):
            self.assertIn(fact, norm_gemini)

        sc = self.suite_compare
        self.assertEqual(sc["suite"], "model_comparison")
        self.assertEqual(sc["prompt_sha256_12"], self.data["prompt_hash"])
        self.assertEqual(len(sc["cases"]), 12)
        pm = sc["per_model"]
        for m_name in ("gemini-3.8-flash", "gemini-3.5-flash"):
            self.assertEqual(pm[m_name]["n"], 12)
            self.assertEqual(pm[m_name]["verdict_matches"], 12)
            self.assertEqual(pm[m_name]["confident_wrong_count"], 0)
            self.assertEqual(pm[m_name]["false_match_count"], 0)
            self.assertEqual(pm[m_name]["unsafe_reassurance_count"], 0)
        self.assertEqual(pm["gemma-4-31b-it"]["n"], 12)
        self.assertEqual(pm["gemma-4-31b-it"]["verdict_matches"], 11)
        self.assertEqual(pm["gemma-4-31b-it"]["confident_wrong_count"], 1)
        self.assertEqual(pm["gemma-4-31b-it"]["false_match_count"], 1)
        self.assertEqual(pm["gemma-4-31b-it"]["unsafe_reassurance_count"], 0)
        self.assertEqual(round(pm["gemini-3.8-flash"]["latency_p50_ms"] / 1000.0, 1), 3.2)
        self.assertEqual(round(pm["gemma-4-31b-it"]["latency_p50_ms"] / 1000.0, 1), 5.6)

    def test_item_outcomes_summarize_paired_and_error_fallback_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p_jsonl = pathlib.Path(tmp) / "preds.jsonl"
            records = [
                {"img_id": "m1", "error": "429 retry", "prompt_hash": "h1"},
                {"img_id": "m1", "pred": {"kind": "medication"}, "latency_s": 2.1, "prompt_hash": "h1"},
                {"img_id": "m2", "error": "503 fail", "prompt_hash": "h1"},
                {"img_id": "m1", "pred": {"kind": "food"}, "latency_s": 1.0, "prompt_hash": "wrong_hash"},
                {"img_id": "outside", "pred": {"kind": "food"}, "latency_s": 1.0, "prompt_hash": "h1"},
            ]
            common.write_jsonl(p_jsonl, records)
            loaded = cm.load_preds(p_jsonl, "h1", {"m1", "m2", "m3"})
            self.assertEqual(set(loaded.keys()), {"m1", "m2"})
            self.assertFalse(loaded["m1"].get("error"))
            self.assertEqual(loaded["m1"]["pred"]["kind"], "medication")
            self.assertTrue(loaded["m2"].get("error"))

        rows = [
            {
                "img_id": "med_ok",
                "spec_id": "s1",
                "kind": "medication",
                "deg": "clean",
                "sev": 0,
                "gt": {
                    "product": {"value": "Amlodipine", "status": "visible"},
                    "ingredient": {"value": "amlodipine", "status": "visible"},
                    "strength": {"value": "5 mg", "status": "visible"},
                    "dosing": {"value": None, "status": "excluded"},
                    "expiry": {"value": "2027-10", "status": "visible"},
                    "allergens": {"value": None, "status": "excluded"},
                    "barcode": {"value": None, "status": "excluded"},
                },
            },
            {
                "img_id": "med_err",
                "spec_id": "s2",
                "kind": "medication",
                "deg": "glare",
                "sev": 1,
                "gt": {
                    "product": {"value": "Bisoprolol", "status": "visible"},
                    "ingredient": {"value": "bisoprolol", "status": "visible"},
                    "strength": {"value": "2.5 mg", "status": "visible"},
                    "dosing": {"value": None, "status": "excluded"},
                    "expiry": {"value": "2027-08", "status": "visible"},
                    "allergens": {"value": None, "status": "excluded"},
                    "barcode": {"value": None, "status": "excluded"},
                },
            },
            {
                "img_id": "food_miss",
                "spec_id": "s3",
                "kind": "food",
                "deg": "crop",
                "sev": 2,
                "gt": {
                    "product": {"value": "Nut Bar", "status": "visible"},
                    "ingredient": {"value": None, "status": "excluded"},
                    "strength": {"value": None, "status": "excluded"},
                    "dosing": {"value": None, "status": "excluded"},
                    "expiry": {"value": "2027-09", "status": "visible"},
                    "allergens": {"value": ["peanut"], "status": "visible"},
                    "barcode": {"value": None, "status": "excluded"},
                },
            },
        ]
        preds_ref = {
            "med_ok": {
                "img_id": "med_ok",
                "latency_s": 2.0,
                "pred": {
                    "kind": "medication",
                    "product": {"value": "Amlodipine", "confidence": 0.99},
                    "ingredient": {"value": "amlodipine", "confidence": 0.99},
                    "strength": {"value": "5 mg", "confidence": 0.99},
                    "expiry": {"value": "2027-10", "confidence": 0.99},
                    "readability": 0.95,
                },
            },
            "med_err": {
                "img_id": "med_err",
                "latency_s": 2.5,
                "pred": {
                    "kind": "medication",
                    "product": {"value": "Bisoprolol", "confidence": 0.99},
                    "ingredient": {"value": "bisoprolol", "confidence": 0.99},
                    "strength": {"value": "2.5 mg", "confidence": 0.99},
                    "expiry": {"value": "2027-08", "confidence": 0.99},
                    "readability": 0.95,
                },
            },
            "food_miss": {
                "img_id": "food_miss",
                "latency_s": 1.8,
                "pred": {
                    "kind": "food",
                    "product": {"value": "Nut Bar", "confidence": 0.98},
                    "expiry": {"value": "2027-09", "confidence": 0.98},
                    "allergens": {"value": ["peanut"], "confidence": 0.98},
                    "readability": 0.95,
                },
            },
        }
        preds_cand = {
            "med_ok": {
                "img_id": "med_ok",
                "latency_s": 3.0,
                "pred": {
                    "kind": "medication",
                    "product": {"value": "Amlodipine", "confidence": 0.99},
                    "ingredient": {"value": "amlodipine", "confidence": 0.99},
                    "strength": {"value": "10 mg", "confidence": 0.95},
                    "expiry": {"value": "2027-10", "confidence": 0.99},
                    "readability": 0.95,
                },
            },
            "med_err": {"img_id": "med_err", "error": "429 RESOURCE_EXHAUSTED"},
        }
        with mock.patch.object(cm, "run_safety", side_effect=lambda r, f: reval.run_safety(r, f, t=reval.CONF_T)):
            per_ref = cm.item_outcomes(rows, preds_ref)
            per_cand = cm.item_outcomes(rows, preds_cand)

        imgs = ["med_ok", "med_err", "food_miss"]
        sum_ref = cm.summarize(per_ref, imgs)
        sum_cand = cm.summarize(per_cand, imgs)

        self.assertEqual(sum_ref["errors_or_unparseable"], 0)
        self.assertEqual(sum_ref["strength_acc_readable"]["k"], 2)
        self.assertEqual(sum_ref["strength_acc_readable"]["n"], 2)
        self.assertEqual(sum_ref["strength_confident_wrong"]["k"], 0)
        self.assertEqual(sum_ref["unsafe_reassurance"]["k"], 0)
        self.assertEqual(sum_ref["verdict_correct"]["k"], 8)
        self.assertEqual(sum_ref["verdict_correct"]["n"], 8)

        self.assertEqual(sum_cand["errors_or_unparseable"], 2)
        self.assertIsNone(per_cand["med_err"]["lat"])
        self.assertIsNone(per_cand["food_miss"]["lat"])
        self.assertEqual(sum_cand["latency"]["n"], 1)
        self.assertEqual(sum_cand["strength_acc_readable"]["k"], 0)
        self.assertEqual(sum_cand["strength_confident_wrong"]["k"], 1)
        self.assertEqual(sum_cand["unsafe_reassurance"]["k"], 1)
        self.assertEqual(sum_cand["unsure"]["k"], 5)

        self.assertEqual(cm.binary_units(per_ref, "fields_confident_wrong"), {})
        p_str = cm.paired(per_ref, per_cand, imgs, "strength_acc_readable", B=200, seed=1)
        self.assertEqual(p_str["diff_pp"], -100.0)
        self.assertEqual(p_str["discordant_ref_only"], 2)
        self.assertEqual(p_str["discordant_model_only"], 0)
        self.assertEqual(p_str["mcnemar_exact_p"], 0.5)

        p_fcw = cm.paired(per_ref, per_cand, imgs, "fields_confident_wrong", B=200, seed=1)
        self.assertNotIn("mcnemar_exact_p", p_fcw)
        self.assertGreater(p_fcw["diff_pp"], 0.0)

    def test_file_hygiene_zero_comments_and_dashes(self) -> None:
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, src)
        self.assertNotIn(SLASH2, src)
        self.assertNotIn(TRIPLE_DQ, src)
        self.assertNotIn(TRIPLE_SQ, src)
        self.assertNotIn(EM_DASH, src)
        self.assertNotIn(EN_DASH, src)
        self.assertNotIn(API_KEY_PREFIX, src)
        self.assertNotIn(DOT_GIT_TOKEN, src)
        self.assertNotIn(GIT_CMD_TOKEN, src)
        self.assertNotIn(SUBPROCESS_TOKEN, src)
        self.assertIsNone(common._client)


if __name__ == "__main__":
    unittest.main()
