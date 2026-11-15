from __future__ import annotations

import copy
import hashlib
import json
import math
import pathlib
import re
import sys
import unittest
from typing import Any

sys.dont_write_bytecode = True

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
V3_RESULTS_PATH = EVAL_DIR / "results" / "v3_results.json"
V3_HELDOUT_PATH = EVAL_DIR / "results" / "v3_heldout_safety.json"
EVAL_DOC_PATH = REPO_ROOT / "docs" / "EVAL.md"
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(8212)
EN_DASH = chr(8211)
API_KEY_PREFIX = "AI" + "za"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{8,}")
BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")


def wilson_pct(k: int, n: int, z: float = 1.96) -> list[float]:
    if n <= 0 or k < 0 or k > n:
        raise ValueError(f"invalid wilson inputs k={k}, n={n}")
    p = k / n
    denom = 1.0 + (z * z) / n
    center = (p + (z * z) / (2.0 * n)) / denom
    half = z * math.sqrt((p * (1.0 - p)) / n + (z * z) / (4.0 * n * n)) / denom
    lo = round(100.0 * max(0.0, center - half), 2)
    hi = round(100.0 * min(1.0, center + half), 2)
    return [lo, hi]


def assert_valid_wilson_pct_ci(label: str, ci: Any, k: int, n: int) -> None:
    if not isinstance(ci, list) or len(ci) != 2:
        raise AssertionError(f"{label}: expected 2-element list, got {ci!r}")
    lo, hi = ci
    if isinstance(lo, bool) or isinstance(hi, bool):
        raise AssertionError(f"{label}: boolean in CI {ci!r}")
    if not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)):
        raise AssertionError(f"{label}: non-numeric CI {ci!r}")
    if not (math.isfinite(lo) and math.isfinite(hi)):
        raise AssertionError(f"{label}: non-finite CI {ci!r}")
    lo_f = float(lo)
    hi_f = float(hi)
    if not (0.0 <= lo_f <= hi_f <= 100.0):
        raise AssertionError(f"{label}: bounds out of [0, 100]: {ci!r}")
    pt = 100.0 * k / n
    if not (lo_f - 0.02 <= pt <= hi_f + 0.02):
        raise AssertionError(f"{label}: point estimate {pt:.4f} outside CI {ci!r}")
    expected = wilson_pct(k, n)
    if [round(lo_f, 2), round(hi_f, 2)] != expected:
        raise AssertionError(f"{label}: CI {ci!r} != expected Wilson CI {expected!r} for {k}/{n}")


def check_raw_json_hygiene(name: str, raw_txt: str) -> None:
    if API_KEY_PREFIX in raw_txt or API_KEY_RE.search(raw_txt):
        raise AssertionError(f"{name}: API key token detected")
    if "data:image/" in raw_txt or "/9j/" in raw_txt or "iVBORw0KGgo" in raw_txt or BASE64_BLOB_RE.search(raw_txt):
        raise AssertionError(f"{name}: base64 image blob detected")


def verify_core_v3_invariants(v3_res: dict[str, Any], v3_ho: dict[str, Any]) -> None:
    syn = v3_res.get("synthetic")
    if not isinstance(syn, dict):
        raise AssertionError("missing synthetic object")
    if syn.get("errors") != 0:
        raise AssertionError(f"expected 0 API errors, got {syn.get('errors')!r}")
    if syn.get("images_scored") != 1060 or v3_ho.get("images_scored") != 1060:
        raise AssertionError("expected 1060 images_scored in both v3 artifacts")

    strength = syn["per_field"]["strength"]
    if strength.get("confident_wrong") != 1 or strength["k"].get("confident") != 536:
        raise AssertionError("expected 1/536 confident-wrong strength reads")

    cw_strength = [e for e in syn.get("confident_wrong_examples", []) if e.get("field") == "strength"]
    if len(cw_strength) != 1:
        raise AssertionError(f"expected 1 strength confident_wrong_example, got {len(cw_strength)}")
    only_cw = cw_strength[0]
    if only_cw.get("img_id") != "v3med0045__motion_blur_1":
        raise AssertionError(f"unexpected strength confident-wrong img_id: {only_cw.get('img_id')!r}")
    if float(only_cw.get("conf", 0.0)) < float(v3_res.get("conf_threshold", 0.8)):
        raise AssertionError("confident-wrong strength example below conf_threshold")

    std_main = v3_ho["standard_eval_scenarios"]["merged_main_safety_ts"]
    if std_main.get("unsafe_k") != 4 or std_main.get("n") != 3033:
        raise AssertionError("expected 4/3033 standard silent unsafe")
    assert_valid_wilson_pct_ci("std_main.unsafe_wilson95_pct", std_main.get("unsafe_wilson95_pct"), 4, 3033)

    ext_main = v3_ho["extended_with_heldout_clinical_challenges"]["merged_main_safety_ts"]
    if ext_main.get("unsafe_k") != 14 or ext_main.get("n") != 4041:
        raise AssertionError("expected 14/4041 extended silent unsafe")
    assert_valid_wilson_pct_ci("ext_main.unsafe_wilson95_pct", ext_main.get("unsafe_wilson95_pct"), 14, 4041)


class TestV3HeldoutIntegrity(unittest.TestCase):
    v3_raw: str
    ho_raw: str
    v3: dict[str, Any]
    ho: dict[str, Any]
    eval_doc: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.v3_raw = V3_RESULTS_PATH.read_bytes().decode("utf-8")
        cls.ho_raw = V3_HELDOUT_PATH.read_bytes().decode("utf-8")
        cls.v3 = json.loads(cls.v3_raw)
        cls.ho = json.loads(cls.ho_raw)
        cls.eval_doc = EVAL_DOC_PATH.read_bytes().decode("utf-8")

    def test_script_and_artifact_hygiene(self) -> None:
        self_src = pathlib.Path(__file__).resolve().read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_src)
        self.assertNotIn(SLASH2, self_src)
        self.assertNotIn(EM_DASH, self_src)
        self.assertNotIn(EN_DASH, self_src)
        self.assertNotIn(API_KEY_PREFIX, self_src)
        self.assertNotIn("google" + ".genai", self_src)
        self.assertNotIn("sub" + "process", self_src)

        self.assertTrue(V3_RESULTS_PATH.is_file())
        self.assertTrue(V3_HELDOUT_PATH.is_file())
        check_raw_json_hygiene("v3_results.json", self.v3_raw)
        check_raw_json_hygiene("v3_heldout_safety.json", self.ho_raw)
        self.assertIsInstance(self.v3, dict)
        self.assertIsInstance(self.ho, dict)

    def test_metadata_prompt_hash_and_zero_api_errors(self) -> None:
        self.assertEqual(self.v3["version"], "v3")
        self.assertEqual(self.v3["evaluation_split"], "held-out (not used for tuning)")
        self.assertEqual(self.v3["git_head"], "52b5567")
        self.assertEqual(self.v3["model"], "gemini-3.8-flash")
        self.assertEqual(self.v3["prompt_src"], "shared")
        self.assertEqual(self.v3["prompt_hash"], "814770315c42")
        self.assertEqual(self.v3["conf_threshold"], 0.8)
        self.assertEqual(self.v3["thinking"], "low")
        self.assertIn("server/src/safety.ts", self.v3["safety_impl"])

        prompt_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
        computed_hash = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        self.assertEqual(computed_hash, self.v3["prompt_hash"])

        self.assertEqual(self.ho["version"], "v3_heldout_safety")
        self.assertEqual(self.ho["evaluation_split"], "held-out (not used for tuning)")
        self.assertEqual(self.ho["main_safety_ts_commit"], self.v3["git_head"])
        self.assertEqual(self.ho["baseline_safety_ts_commit"], "1d395b3")

        syn = self.v3["synthetic"]
        self.assertEqual(syn["label"], "v3_synthetic_heldout")
        self.assertEqual(syn["images_scored"], 1060)
        self.assertEqual(self.ho["images_scored"], 1060)
        self.assertEqual(syn["errors"], 0)

        lat = syn["latency_s"]
        self.assertEqual(lat["n"], 1060)
        self.assertEqual(lat["p50"], 3.1)
        self.assertEqual(lat["p50_ci"], [3.07, 3.13])
        self.assertLessEqual(lat["p50_ci"][0], lat["p50"])
        self.assertLessEqual(lat["p50"], lat["p50_ci"][1])
        self.assertEqual(lat["p95"], 5.33)
        self.assertEqual(lat["p95_ci"], [5.08, 5.65])
        self.assertLessEqual(lat["p95_ci"][0], lat["p95"])
        self.assertLessEqual(lat["p95"], lat["p95_ci"][1])

        ledger = self.v3["ledger"]
        self.assertEqual(ledger["eval.verify_label|gemini-3.8-flash"]["ok"], 1060)
        self.assertGreater(ledger["v3.gen_images.check|gemini-4-argon"]["ok"], 0)
        self.assertGreater(ledger["v3.gen_specs|gemini-4-hydrogen"]["ok"], 0)
        self.assertGreater(ledger["v3.gen_specs|gemini-4-argon"]["ok"], 0)

    def test_dataset_scale_zero_overlap_and_splits(self) -> None:
        ds = self.v3["synthetic"]["dataset"]
        self.assertEqual(ds["evaluation_split"], "held-out (not used for tuning)")
        self.assertEqual(ds["overlap_with_ws1_redteam_specs"], 0)
        self.assertEqual(ds["overlap_with_v1_specs"], 0)
        self.assertEqual(ds["specs_generated_total"], 1459)
        self.assertEqual(ds["specs_rendered_and_scored"], 148)
        self.assertEqual(ds["renders_kept"], 172)
        self.assertEqual(ds["renders_dropped"], 2)
        self.assertEqual(ds["images_scored"], 1060)

        by_deg = ds["by_deg"]
        self.assertEqual(
            set(by_deg.keys()),
            {"back_of_box", "clean", "crop", "defocus", "glare", "low_light", "motion_blur", "rotation"},
        )
        self.assertEqual(by_deg["clean"], 148)
        self.assertEqual(by_deg["back_of_box"], 24)
        self.assertEqual(by_deg["clean"] + by_deg["back_of_box"], ds["renders_kept"])
        self.assertEqual(sum(by_deg.values()), 1060)

        by_kind = ds["by_kind"]
        self.assertEqual(by_kind, {"food": 126, "medication": 934})
        self.assertEqual(sum(by_kind.values()), 1060)

        by_pkg = ds["by_package_group"]
        self.assertEqual(
            by_pkg,
            {
                "blister": 137,
                "bottle": 128,
                "box": 137,
                "eyedrops": 137,
                "food_pack": 126,
                "inhaler": 139,
                "pouch": 128,
                "tube": 128,
            },
        )
        self.assertEqual(sum(by_pkg.values()), 1060)
        self.assertEqual(by_pkg["food_pack"], by_kind["food"])
        self.assertEqual(sum(v for k, v in by_pkg.items() if k != "food_pack"), by_kind["medication"])

    def test_strength_confident_wrong_and_v3med0045_invariant(self) -> None:
        syn = self.v3["synthetic"]
        st = syn["per_field"]["strength"]
        self.assertEqual(st["n"], 934)
        self.assertEqual(st["n_visible"], 652)
        self.assertEqual(st["n_partial"], 154)
        self.assertEqual(st["n_hidden"], 128)
        self.assertEqual(st["n_visible"] + st["n_partial"] + st["n_hidden"], st["n"])

        k = st["k"]
        self.assertEqual(k["correct_visible"], 516)
        self.assertEqual(k["abstain_visible"], 135)
        self.assertEqual(k["wrong_visible"], 1)
        self.assertEqual(k["correct_visible"] + k["abstain_visible"] + k["wrong_visible"], st["n_visible"])
        self.assertEqual(st["acc_visible"], 79.1)
        self.assertEqual(st["abstain_visible"], 20.7)
        self.assertEqual(st["wrong_visible"], 0.2)
        self.assertEqual(wilson_pct(516, 652), [75.86, 82.08])

        self.assertEqual(k["abstain_hidden"], 112)
        self.assertEqual(k["wrong_hidden"], 0)
        self.assertEqual(st["abstain_hidden"], 87.5)

        self.assertEqual(st["confident_wrong"], 1)
        self.assertEqual(k["confident"], 536)
        self.assertEqual(k["answered"], 562)
        self.assertEqual(k["correct_answered"], 561)
        self.assertEqual(k["wrong_any"], 1)
        self.assertEqual(round(100.0 * st["confident_wrong"] / k["confident"], 2), 0.19)
        self.assertEqual(wilson_pct(1, 536), [0.03, 1.05])

        expected_pkg_strength = {
            "blister": (0, 82),
            "bottle": (0, 69),
            "box": (0, 80),
            "eyedrops": (1, 85),
            "inhaler": (0, 64),
            "pouch": (0, 82),
            "tube": (0, 74),
        }
        pkg_st = syn["by_package_strength"]
        self.assertEqual(set(pkg_st.keys()), set(expected_pkg_strength.keys()))
        for pkg, (exp_cw, exp_conf) in expected_pkg_strength.items():
            self.assertEqual(pkg_st[pkg]["confident_wrong"], exp_cw)
            self.assertEqual(pkg_st[pkg]["k"]["confident"], exp_conf)
        self.assertEqual(sum(v["confident_wrong"] for v in pkg_st.values()), 1)
        self.assertEqual(sum(v["k"]["confident"] for v in pkg_st.values()), 536)
        self.assertEqual(sum(v["n"] for v in pkg_st.values()), 934)

        sweep = syn["threshold_sweep_strength"]
        by_t = {row["t"]: row for row in sweep}
        self.assertEqual(by_t[0.8]["trusted"], 536)
        self.assertEqual(by_t[0.8]["trusted_wrong"], 1)
        self.assertEqual(by_t[0.9]["trusted_wrong"], 0)
        self.assertEqual(by_t[0.95]["trusted_wrong"], 0)
        for prev, curr in zip(sweep, sweep[1:]):
            self.assertLess(prev["t"], curr["t"])
            self.assertGreaterEqual(prev["trusted"], curr["trusted"])
            self.assertGreaterEqual(prev["trusted_wrong"], curr["trusted_wrong"])

        cw_examples = syn["confident_wrong_examples"]
        self.assertEqual(len(cw_examples), syn["overall"]["confident_wrong"])
        for ex in cw_examples:
            self.assertGreaterEqual(ex["conf"], self.v3["conf_threshold"])
        strength_cw = [ex for ex in cw_examples if ex["field"] == "strength"]
        self.assertEqual(len(strength_cw), 1)
        self.assertEqual(
            strength_cw[0],
            {
                "img_id": "v3med0045__motion_blur_1",
                "field": "strength",
                "status": "visible",
                "gt": "5 mg/ml",
                "pred": "1 mg/ml",
                "conf": 0.85,
                "deg": "motion_blur",
                "sev": 1,
            },
        )

    def test_per_field_totals_and_calibration_invariants(self) -> None:
        syn = self.v3["synthetic"]
        pf = syn["per_field"]
        ov = syn["overall"]
        fields = {"product", "ingredient", "strength", "dosing", "expiry", "barcode", "allergens"}
        self.assertEqual(set(pf.keys()), fields)

        self.assertEqual(sum(pf[f]["n"] for f in fields), ov["n"])
        self.assertEqual(ov["n"], 5791)
        self.assertEqual(sum(pf[f]["n_visible"] for f in fields), ov["n_visible"])
        self.assertEqual(sum(pf[f]["n_partial"] for f in fields), ov["n_partial"])
        self.assertEqual(sum(pf[f]["n_hidden"] for f in fields), ov["n_hidden"])
        self.assertEqual(sum(pf[f]["confident_wrong"] for f in fields), ov["confident_wrong"])
        self.assertEqual(ov["confident_wrong"], 251)
        self.assertEqual(sum(pf[f]["k"]["confident"] for f in fields), ov["k"]["confident"])
        self.assertEqual(ov["k"]["confident"], 2407)
        self.assertEqual(sum(pf[f]["k"]["answered"] for f in fields), ov["k"]["answered"])
        self.assertEqual(ov["k"]["answered"], 2559)
        self.assertEqual(sum(pf[f]["k"]["correct_answered"] for f in fields), ov["k"]["correct_answered"])
        self.assertEqual(ov["k"]["correct_answered"], 2256)

        for fname, fval in pf.items():
            self.assertEqual(fval["n_visible"] + fval["n_partial"] + fval["n_hidden"], fval["n"], fname)
            fk = fval["k"]
            self.assertEqual(
                fk["correct_visible"] + fk["abstain_visible"] + fk["wrong_visible"],
                fval["n_visible"],
                fname,
            )
            self.assertLessEqual(fk["confident"], fk["answered"], fname)
            self.assertLessEqual(fval["confident_wrong"], fk["confident"], fname)

        self.assertEqual((pf["product"]["k"]["correct_visible"], pf["product"]["n_visible"]), (626, 798))
        self.assertEqual((pf["product"]["confident_wrong"], pf["product"]["k"]["confident"]), (26, 666))
        self.assertEqual(wilson_pct(26, 666), [2.68, 5.66])
        self.assertEqual((pf["expiry"]["k"]["correct_visible"], pf["expiry"]["n_visible"]), (569, 726))
        self.assertEqual((pf["expiry"]["confident_wrong"], pf["expiry"]["k"]["confident"]), (19, 605))
        self.assertEqual(wilson_pct(19, 605), [2.02, 4.85])
        self.assertEqual((pf["ingredient"]["k"]["correct_visible"], pf["ingredient"]["n_visible"]), (249, 446))
        self.assertEqual((pf["ingredient"]["confident_wrong"], pf["ingredient"]["k"]["confident"]), (153, 410))
        self.assertEqual((pf["allergens"]["k"]["correct_visible"], pf["allergens"]["n_visible"]), (51, 82))
        self.assertEqual((pf["allergens"]["confident_wrong"], pf["allergens"]["k"]["confident"]), (26, 79))
        self.assertEqual((pf["dosing"]["k"]["correct_visible"], pf["dosing"]["n_visible"]), (60, 91))
        self.assertEqual((pf["dosing"]["confident_wrong"], pf["dosing"]["k"]["confident"]), (26, 90))
        self.assertEqual((pf["barcode"]["k"]["correct_visible"], pf["barcode"]["n_visible"]), (21, 22))
        self.assertEqual((pf["barcode"]["confident_wrong"], pf["barcode"]["k"]["confident"]), (0, 21))

        for cal_key, exp_n, exp_k, exp_ece, exp_ci in (
            ("calibration_all", 2559, 2256, 0.05, [0.038, 0.061]),
            ("calibration_strength", 562, 561, 0.069, [0.063, 0.075]),
        ):
            cal = syn[cal_key]
            self.assertEqual(cal["n_answered"], exp_n)
            self.assertEqual(cal["ece"], exp_ece)
            self.assertEqual(cal["ece_ci"], exp_ci)
            self.assertLessEqual(cal["ece_ci"][0], cal["ece"])
            self.assertLessEqual(cal["ece"], cal["ece_ci"][1])
            bins = cal["bins"]
            self.assertEqual(sum(b["n"] for b in bins), exp_n)
            self.assertEqual(sum(b["k"] for b in bins), exp_k)
            ece_recomp = sum(
                (b["n"] / exp_n) * abs((b["k"] / b["n"]) - b["mean_conf"])
                for b in bins
                if b["n"] > 0
            )
            self.assertAlmostEqual(ece_recomp, exp_ece, delta=0.002)

    def test_standard_silent_unsafe_4_of_3033_and_cross_file_parity(self) -> None:
        srv = self.v3["synthetic"]["safety"]["server"]
        std_main = self.ho["standard_eval_scenarios"]["merged_main_safety_ts"]
        std_old = self.ho["standard_eval_scenarios"]["pre_ws1_safety_ts_1d395b3"]

        self.assertEqual(std_main["n"], 3033)
        self.assertEqual(std_main["unsafe_k"], 4)
        self.assertEqual(std_main["unsafe_rate_pct"], 0.13)
        self.assertEqual(std_main["unsafe_wilson95_pct"], [0.05, 0.34])
        self.assertEqual(
            std_main["unsafe_by_category"],
            {"missed_allergen": 3, "expired_date_misread_or_unseen": 1},
        )
        self.assertEqual(sum(std_main["unsafe_by_category"].values()), 4)
        self.assertEqual(len(std_main["unsafe_examples"]), 4)
        self.assertEqual(std_main["verdict_correct"], {"k": 1702, "n": 3033, "wilson95_pct": [54.34, 57.87]})
        self.assertEqual(std_main["unsure"], {"k": 1214, "n": 3033, "wilson95_pct": [38.3, 41.78]})
        self.assertEqual(std_main["expired_match_with_caveat"], {"k": 6, "n": 3033, "wilson95_pct": [0.09, 0.43]})
        self.assertEqual(std_main["false_match"], 7)

        scens = std_main["by_scenario"]
        self.assertEqual(sum(s["n"] for s in scens.values()), 3033)
        self.assertEqual(sum(s["unsafe"] for s in scens.values()), 4)
        self.assertEqual(scens["not_on_list"]["n"] + scens["on_list_other_strength"]["n"], 1868)
        self.assertEqual(scens["not_on_list"]["unsafe"] + scens["on_list_other_strength"]["unsafe"], 0)

        self.assertEqual(srv["n"], std_main["n"])
        self.assertEqual(srv["unsafe_reassurance"], std_main["unsafe_k"])
        self.assertEqual(srv["unsafe_ci"], std_main["unsafe_wilson95_pct"])
        self.assertEqual(srv["correct_k"], std_main["verdict_correct"]["k"])
        self.assertEqual(srv["correct_ci"], std_main["verdict_correct"]["wilson95_pct"])
        self.assertEqual(srv["unsure_k"], std_main["unsure"]["k"])
        self.assertEqual(srv["unsure_ci"], std_main["unsure"]["wilson95_pct"])
        self.assertEqual(srv["expired_match_with_caveat"], std_main["expired_match_with_caveat"]["k"])
        self.assertEqual(srv["false_match"], std_main["false_match"])
        self.assertEqual(srv["unsafe_by_category"], std_main["unsafe_by_category"])
        self.assertEqual(srv["by_scenario"], std_main["by_scenario"])
        self.assertEqual(srv["unsafe_examples"], std_main["unsafe_examples"])

        by_deg = srv["by_deg"]
        self.assertEqual(sum(d["n"] for d in by_deg.values()), 3033)
        self.assertEqual(sum(d["unsafe_reassurance"] for d in by_deg.values()), 4)
        self.assertEqual(sum(d["correct_k"] for d in by_deg.values()), 1702)
        self.assertEqual(sum(d["unsure_k"] for d in by_deg.values()), 1214)

        self.assertEqual(std_old["n"], 3033)
        self.assertEqual(std_old["unsafe_k"], 6)
        self.assertEqual(std_old["unsafe_rate_pct"], 0.2)
        self.assertEqual(std_old["unsafe_wilson95_pct"], [0.09, 0.43])
        self.assertLessEqual(std_main["unsafe_k"], std_old["unsafe_k"])

    def test_extended_silent_unsafe_14_of_4041_and_out_of_sample_reduction(self) -> None:
        ext_main = self.ho["extended_with_heldout_clinical_challenges"]["merged_main_safety_ts"]
        ext_old = self.ho["extended_with_heldout_clinical_challenges"]["pre_ws1_safety_ts_1d395b3"]

        self.assertEqual(ext_main["n"], 4041)
        self.assertEqual(ext_main["unsafe_k"], 14)
        self.assertEqual(ext_main["unsafe_rate_pct"], 0.35)
        self.assertEqual(ext_main["unsafe_wilson95_pct"], [0.21, 0.58])
        self.assertEqual(
            ext_main["unsafe_by_category"],
            {
                "missed_allergen": 4,
                "expired_date_misread_or_unseen": 1,
                "not_on_list_matched": 5,
                "wrong_strength_matched": 4,
            },
        )
        self.assertEqual(sum(ext_main["unsafe_by_category"].values()), 14)
        self.assertEqual(len(ext_main["unsafe_examples"]), 14)
        self.assertEqual(sum(s["n"] for s in ext_main["by_scenario"].values()), 4041)
        self.assertEqual(sum(s["unsafe"] for s in ext_main["by_scenario"].values()), 14)
        self.assertEqual(ext_main["by_scenario"]["heldout_lasa_or_form_twin"]["n"], 875)
        self.assertEqual(ext_main["by_scenario"]["heldout_lasa_or_form_twin"]["unsafe"], 9)
        self.assertEqual(round(100.0 * 9 / 875, 2), 1.03)

        self.assertEqual(ext_old["n"], 4041)
        self.assertEqual(ext_old["unsafe_k"], 46)
        self.assertEqual(ext_old["unsafe_rate_pct"], 1.14)
        self.assertEqual(ext_old["unsafe_wilson95_pct"], [0.85, 1.51])
        self.assertEqual(sum(ext_old["unsafe_by_category"].values()), 46)
        self.assertEqual(sum(s["n"] for s in ext_old["by_scenario"].values()), 4041)
        self.assertEqual(sum(s["unsafe"] for s in ext_old["by_scenario"].values()), 46)
        self.assertEqual(ext_old["by_scenario"]["heldout_lasa_or_form_twin"]["n"], 875)
        self.assertEqual(ext_old["by_scenario"]["heldout_lasa_or_form_twin"]["unsafe"], 37)
        self.assertEqual(round(100.0 * 37 / 875, 2), 4.23)

        rel_reduction_pct = round(100.0 * (ext_old["unsafe_k"] - ext_main["unsafe_k"]) / ext_old["unsafe_k"], 1)
        self.assertEqual(rel_reduction_pct, 69.6)

    def test_all_wilson_cis_valid_and_recomputable(self) -> None:
        syn = self.v3["synthetic"]
        checked = 0

        for cal_key in ("calibration_all", "calibration_strength"):
            for b in syn[cal_key]["bins"]:
                if b["n"] > 0:
                    assert_valid_wilson_pct_ci(f"{cal_key}.{b['bin']}", b["acc_ci"], b["k"], b["n"])
                    checked += 1

        ar = syn["allergen_recall"]
        n_ar = ar["n_answered_visible"]
        assert_valid_wilson_pct_ci("allergen_recall.all_found_ci", ar["all_found_ci"], n_ar - ar["missed_any"], n_ar)
        assert_valid_wilson_pct_ci(
            "allergen_recall.missed_confident_ci",
            ar["missed_confident_ci"],
            ar["missed_any_confident"],
            n_ar,
        )
        checked += 2

        for policy_name, sblock in syn["safety"].items():
            assert_valid_wilson_pct_ci(f"{policy_name}.unsafe_ci", sblock["unsafe_ci"], sblock["unsafe_reassurance"], sblock["n"])
            assert_valid_wilson_pct_ci(f"{policy_name}.correct_ci", sblock["correct_ci"], sblock["correct_k"], sblock["n"])
            assert_valid_wilson_pct_ci(f"{policy_name}.unsure_ci", sblock["unsure_ci"], sblock["unsure_k"], sblock["n"])
            checked += 3
            for deg_name, dblock in sblock.get("by_deg", {}).items():
                assert_valid_wilson_pct_ci(
                    f"{policy_name}.{deg_name}.unsafe_ci",
                    dblock["unsafe_ci"],
                    dblock["unsafe_reassurance"],
                    dblock["n"],
                )
                assert_valid_wilson_pct_ci(
                    f"{policy_name}.{deg_name}.correct_ci",
                    dblock["correct_ci"],
                    dblock["correct_k"],
                    dblock["n"],
                )
                assert_valid_wilson_pct_ci(
                    f"{policy_name}.{deg_name}.unsure_ci",
                    dblock["unsure_ci"],
                    dblock["unsure_k"],
                    dblock["n"],
                )
                checked += 3

        for group_key in ("standard_eval_scenarios", "extended_with_heldout_clinical_challenges"):
            for variant_key, block in self.ho[group_key].items():
                prefix = f"{group_key}.{variant_key}"
                assert_valid_wilson_pct_ci(f"{prefix}.unsafe", block["unsafe_wilson95_pct"], block["unsafe_k"], block["n"])
                assert_valid_wilson_pct_ci(
                    f"{prefix}.caveat",
                    block["expired_match_with_caveat"]["wilson95_pct"],
                    block["expired_match_with_caveat"]["k"],
                    block["expired_match_with_caveat"]["n"],
                )
                assert_valid_wilson_pct_ci(
                    f"{prefix}.correct",
                    block["verdict_correct"]["wilson95_pct"],
                    block["verdict_correct"]["k"],
                    block["verdict_correct"]["n"],
                )
                assert_valid_wilson_pct_ci(
                    f"{prefix}.unsure",
                    block["unsure"]["wilson95_pct"],
                    block["unsure"]["k"],
                    block["unsure"]["n"],
                )
                frc = block["food_reassurance_coverage"]
                assert_valid_wilson_pct_ci(
                    f"{prefix}.food_reassurance",
                    frc["ci"],
                    frc["said_none_of_your_allergens"],
                    frc["n_truly_safe"],
                )
                checked += 5

        self.assertGreaterEqual(checked, 70)

    def test_docs_eval_md_v3_section_parity(self) -> None:
        start_idx = self.eval_doc.find("EVAL v3: held-out Finnish pharmacy scale-up")
        end_idx = self.eval_doc.find("Gemini as the workforce", start_idx)
        self.assertGreaterEqual(start_idx, 0)
        self.assertGreater(end_idx, start_idx)
        sec = self.eval_doc[start_idx:end_idx]

        syn = self.v3["synthetic"]
        ds = syn["dataset"]
        st = syn["per_field"]["strength"]
        cw_ex = [e for e in syn["confident_wrong_examples"] if e["field"] == "strength"][0]
        std_main = self.ho["standard_eval_scenarios"]["merged_main_safety_ts"]
        std_old = self.ho["standard_eval_scenarios"]["pre_ws1_safety_ts_1d395b3"]
        ext_main = self.ho["extended_with_heldout_clinical_challenges"]["merged_main_safety_ts"]
        ext_old = self.ho["extended_with_heldout_clinical_challenges"]["pre_ws1_safety_ts_1d395b3"]
        cw_ci = wilson_pct(st["confident_wrong"], st["k"]["confident"])

        expected_snippets = [
            "eval/results/v3_results.json",
            "eval/results/v3_heldout_safety.json",
            self.v3["evaluation_split"],
            self.v3["git_head"],
            self.ho["baseline_safety_ts_commit"],
            self.v3["model"],
            self.v3["prompt_hash"],
            f"{ds['specs_generated_total']:,} fresh Nordic specs",
            f"{ds['renders_kept']} kept photos",
            f"{ds['by_deg']['clean']} fronts, {ds['by_deg']['back_of_box']} back-of-box; {ds['renders_dropped']} garbled renders dropped",
            "gemini-4-argon",
            f"{syn['images_scored']:,} held-out test images",
            f"{syn['errors']} API errors",
            f"{syn['latency_s']['p50']:.2f} s",
            f"{syn['latency_s']['p95']:.2f} s",
            f"conf >= {self.v3['conf_threshold']}, n = {st['k']['confident']} confident",
            f"{st['confident_wrong']} / {st['k']['confident']} = 0.19%",
            f"{cw_ci[0]:.2f}-{cw_ci[1]:.2f}%",
            "0/82** blister",
            "0/69** bottle",
            "0/80** box",
            "0/64** inhaler",
            "0/82** dose pouch",
            "0/74** tube",
            "1/85** eye drops",
            cw_ex["img_id"],
            cw_ex["gt"],
            cw_ex["pred"],
            str(cw_ex["conf"]),
            f"n = {st['n_visible']}) / hidden (n = {st['n_hidden']})",
            f"{st['acc_visible']}%** correct (75.86-82.08%), {st['abstain_visible']}% abstained; hidden abstains **{st['abstain_hidden']}%** ({st['k']['abstain_hidden']}/{st['n_hidden']})",
            "Product **78.4%** (626/798), CW 26/666 (**3.9%**, 2.68-5.66%)",
            "Expiry **78.4%** (569/726), CW 19/605 (**3.1%**, 2.02-4.85%)",
            "Ingredient **55.8%** (249/446",
            "CW 153/410",
            "Allergens **62.2%** (51/82), CW 26/79",
            "Dosing **65.9%** (60/91), CW 26/90",
            "Barcode **95.5%** (21/22), CW **0/21**",
            f"(n = {syn['calibration_all']['n_answered']:,}): **{syn['calibration_all']['ece']:.3f}**",
            f"Strength (n = {syn['calibration_strength']['n_answered']}): **{syn['calibration_strength']['ece']:.3f}**",
            f"{std_old['unsafe_k']} / {std_old['n']:,} = {std_old['unsafe_rate_pct']:.2f}%",
            f"{std_main['unsafe_k']} / {std_main['n']:,} = {std_main['unsafe_rate_pct']:.2f}%",
            f"{std_main['unsafe_wilson95_pct'][0]:.2f}-{std_main['unsafe_wilson95_pct'][1]:.2f}%",
            "0 / 1,868",
            f"{ext_old['unsafe_k']} / {ext_old['n']:,} = {ext_old['unsafe_rate_pct']:.2f}%",
            f"{ext_main['unsafe_k']} / {ext_main['n']:,} = {ext_main['unsafe_rate_pct']:.2f}%",
            f"{ext_main['unsafe_wilson95_pct'][0]:.2f}-{ext_main['unsafe_wilson95_pct'][1]:.2f}%",
            "-69.6% out-of-sample reduction",
            "37/875 = 4.23%",
            "9/875 = 1.03%",
        ]
        for snippet in expected_snippets:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, sec)

    def test_validator_rejects_tampered_invariants(self) -> None:
        verify_core_v3_invariants(self.v3, self.ho)

        bad_err = copy.deepcopy(self.v3)
        bad_err["synthetic"]["errors"] = 1
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(bad_err, self.ho)

        bad_imgs = copy.deepcopy(self.v3)
        bad_imgs["synthetic"]["images_scored"] = 1059
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(bad_imgs, self.ho)

        bad_cw = copy.deepcopy(self.v3)
        bad_cw["synthetic"]["confident_wrong_examples"][0]["img_id"] = "v3med9999__clean_0"
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(bad_cw, self.ho)

        bad_std = copy.deepcopy(self.ho)
        bad_std["standard_eval_scenarios"]["merged_main_safety_ts"]["unsafe_k"] = 5
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(self.v3, bad_std)

        bad_ext = copy.deepcopy(self.ho)
        bad_ext["extended_with_heldout_clinical_challenges"]["merged_main_safety_ts"]["unsafe_k"] = 15
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(self.v3, bad_ext)

        bad_ci = copy.deepcopy(self.ho)
        bad_ci["standard_eval_scenarios"]["merged_main_safety_ts"]["unsafe_wilson95_pct"] = [0.5, 0.1]
        with self.assertRaises(AssertionError):
            verify_core_v3_invariants(self.v3, bad_ci)

        with self.assertRaises(AssertionError):
            check_raw_json_hygiene("fake_key.json", '{"k": "' + API_KEY_PREFIX + 'SyFakeSecret12345"}')
        with self.assertRaises(AssertionError):
            check_raw_json_hygiene("fake_b64.json", '{"img": "' + ("A" * 300) + '"}')


if __name__ == "__main__":
    unittest.main()
