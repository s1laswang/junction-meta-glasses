import contextlib
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eval.compile_eval_report import (
    ARTIFACT_SPECS,
    DEFAULT_EVAL_DIR,
    EXTENDED_ARTIFACT_SPECS,
    EXTENDED_SUITE_IDS,
    compile_summary,
    main,
    render_markdown,
)

H3 = chr(35) * 3
EM_DASH = chr(0x2014)


def _copy_core_suites(dst_dir: pathlib.Path) -> None:
    for spec in ARTIFACT_SPECS:
        src = DEFAULT_EVAL_DIR / spec["filename"]
        shutil.copyfile(src, dst_dir / spec["filename"])


def _synthetic_extended_payloads() -> dict[str, dict[str, Any]]:
    return {
        "curved_blister_results.json": {
            "generated_at": "2026-11-14T15:00:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "readable_recall": 1.0,
                "occluded_abstention_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3380.4,
                "latency_p95_ms": 4512.0,
                "tokens_in": 24850,
                "tokens_out": 1240,
            },
            "items": [
                {
                    "id": f"cb_{idx:02d}",
                    "expected_level": "unsure" if idx in (2, 8, 9) else ("match" if idx in (1, 6, 7) else "warning"),
                    "predicted_level": "unsure" if idx in (2, 8, 9) else ("match" if idx in (1, 6, 7) else "warning"),
                    "verdict_match": True,
                    "strength_readable": idx not in (2, 8, 9, 10),
                    "strength_value": None if idx in (2, 8, 9, 10) else "5 mg",
                    "strength_confidence": 0.0 if idx in (2, 8, 9, 10) else 0.98,
                    "confident_wrong_dose": False,
                    "latency_ms": 3300.0 + idx * 18.0,
                }
                for idx in range(1, 11)
            ],
        },
        "coaching_trajectories.json": {
            "generated_at": "2026-11-14T15:02:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_trajectories": 4,
                "total_verify_calls": 8,
                "pre_coaching_abstention_rate": 1.0,
                "post_coaching_verdict_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3420.5,
                "latency_p95_ms": 4610.2,
            },
            "trajectories": [
                {
                    "id": "traj_1_flip_box",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 14.2, "latency_ms": 3310.0},
                    "stage_b": {"expected_level": "match", "level": "match", "verdict_match": True, "sharpness": 92.6, "latency_ms": 3480.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_2_move_thumb",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 18.5, "latency_ms": 3290.0},
                    "stage_b": {"expected_level": "match", "level": "match", "verdict_match": True, "sharpness": 91.4, "latency_ms": 3520.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_3_nsaid_catch",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 13.8, "latency_ms": 3360.0},
                    "stage_b": {"expected_level": "warning", "level": "warning", "verdict_match": True, "sharpness": 89.1, "latency_ms": 3460.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_4_allergen_catch",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 15.1, "latency_ms": 3390.0},
                    "stage_b": {"expected_level": "warning", "level": "warning", "verdict_match": True, "sharpness": 90.3, "latency_ms": 4650.0},
                    "confident_wrong_dose": False,
                },
            ],
        },
        "lighting_motion_results.json": {
            "generated_at": "2026-11-14T15:04:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 12,
                "verdict_matches": 12,
                "verdict_accuracy": 1.0,
                "moderate_degradation_recall": 1.0,
                "severe_degradation_abstention_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3495.0,
                "latency_p95_ms": 4720.5,
                "tokens_in": 29820,
                "tokens_out": 1490,
            },
            "items": [
                {
                    "id": f"lm_{idx:02d}",
                    "expected_level": "unsure" if idx in (5, 6, 10, 11) else ("info" if idx == 12 else ("warning" if idx in (3, 4, 9) else "match")),
                    "predicted_level": "unsure" if idx in (5, 6, 10, 11) else ("info" if idx == 12 else ("warning" if idx in (3, 4, 9) else "match")),
                    "verdict_match": True,
                    "strength_value": None if idx in (4, 5, 6, 10, 11, 12) else "5 mg",
                    "strength_confidence": 0.0 if idx in (4, 5, 6, 10, 11, 12) else 0.97,
                    "confident_wrong_dose": False,
                    "latency_ms": 3400.0 + idx * 20.0,
                }
                for idx in range(1, 13)
            ],
        },
        "multilingual_labels_results.json": {
            "generated_at": "2026-11-14T15:06:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 12,
                "verdict_matches": 12,
                "verdict_accuracy": 1.0,
                "languages_tested": ["fi", "sv", "de", "fr", "es", "en"],
                "confident_wrong_dose_count": 0,
                "false_safe_allergen_count": 0,
                "latency_p50_ms": 3510.2,
                "latency_p95_ms": 4688.0,
                "tokens_in": 29820,
                "tokens_out": 1520,
            },
            "items": [
                {
                    "id": f"ml_{idx:02d}",
                    "expected_level": "unsure" if idx in (11, 12) else ("info" if idx in (9, 10) else ("warning" if idx in (3, 5, 7, 8) else "match")),
                    "predicted_level": "unsure" if idx in (11, 12) else ("info" if idx in (9, 10) else ("warning" if idx in (3, 5, 7, 8) else "match")),
                    "verdict_match": True,
                    "strength_value": "5 mg" if idx in (1, 4) else None,
                    "strength_confidence": 0.99 if idx in (1, 4) else 0.0,
                    "confident_wrong_dose": False,
                    "latency_ms": 3420.0 + idx * 15.0,
                }
                for idx in range(1, 13)
            ],
        },
        "bystander_privacy_results.json": {
            "generated_at": "2026-11-14T15:08:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 8,
                "verdict_matches": 8,
                "verdict_accuracy": 1.0,
                "pii_or_bystander_leak_count": 0,
                "privacy_pass_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3395.0,
                "latency_p95_ms": 4380.0,
            },
            "items": [
                {
                    "id": f"bp_{idx:02d}",
                    "expected_level": "unsure" if idx in (5, 8) else ("info" if idx == 4 else ("match" if idx in (1, 6) else "warning")),
                    "predicted_level": "unsure" if idx in (5, 8) else ("info" if idx == 4 else ("match" if idx in (1, 6) else "warning")),
                    "verdict_match": True,
                    "pii_or_bystander_leak": False,
                    "confident_wrong_dose": False,
                    "latency_ms": 3320.0 + idx * 19.0,
                }
                for idx in range(1, 9)
            ],
        },
        "polypharmacy_confusion_results.json": {
            "generated_at": "2026-11-14T15:10:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "double_dose_catches": 2,
                "lasa_strength_catches": 3,
                "drug_class_catches": 2,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3442.0,
                "latency_p95_ms": 4590.0,
            },
            "items": [
                {
                    "id": f"pc_{idx:02d}",
                    "expected_level": "match" if idx in (1, 3, 7) else "warning",
                    "predicted_level": "match" if idx in (1, 3, 7) else "warning",
                    "verdict_match": True,
                    "strength_value": "2.5 mg" if idx == 7 else "5 mg",
                    "strength_confidence": 0.99,
                    "confident_wrong_dose": False,
                    "latency_ms": 3360.0 + idx * 16.0,
                }
                for idx in range(1, 11)
            ],
        },
    }


class CompileEvalReportTest(unittest.TestCase):
    def test_current_repo_data_compiles_cleanly(self) -> None:
        compiled = compile_summary(DEFAULT_EVAL_DIR)
        md = render_markdown(compiled)

        self.assertEqual(len(ARTIFACT_SPECS), 9)
        self.assertEqual(len(EXTENDED_ARTIFACT_SPECS), 6)
        self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
        self.assertEqual(compiled["suites_missing"], [])
        self.assertEqual(compiled["total_label_cases_evaluated"], 53)
        self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
        self.assertEqual(compiled["total_false_safe_allergen_count"], 0)
        self.assertIsInstance(compiled["extended_suites_present"], list)
        self.assertTrue(set(compiled["extended_suites_present"]).issubset(set(EXTENDED_SUITE_IDS)))
        self.assertNotIn("Pending merge", md)
        self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
        self.assertNotIn(EM_DASH, md)

    def test_core_only_temp_dir_omits_extended_table_and_missing_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], [])
            self.assertEqual(compiled["extended_summary"]["suites_count"], 0)
            self.assertEqual(compiled["extended_summary"]["total_cases_evaluated"], 0)
            self.assertEqual(compiled["extended_summary"]["confident_wrong_dose_count"], 0)
            self.assertNotIn("Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("0 (pending)", md)
            self.assertNotIn("missing", md.lower())

    def test_all_six_extended_suites_discovered_and_rendered_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            eval_dir = tmp_dir / "eval"
            eval_dir.mkdir(parents=True, exist_ok=True)
            _copy_core_suites(eval_dir)

            payloads = _synthetic_extended_payloads()
            self.assertEqual(len(payloads), 6)
            for fname, payload in payloads.items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")

            out_json = tmp_dir / "out" / "combined_summary.json"
            out_md = tmp_dir / "out" / "EVAL.md"
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                rc = main(["--eval-dir", str(eval_dir), "--out-json", str(out_json), "--out-md", str(out_md)])
            self.assertEqual(rc, 0)
            self.assertIn("+ 6 extended", stdout_buf.getvalue())

            compiled = json.loads(out_json.read_text(encoding="utf-8"))
            md = out_md.read_text(encoding="utf-8")

            self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], EXTENDED_SUITE_IDS)

            ext_sum = compiled["extended_summary"]
            self.assertEqual(ext_sum["suites_count"], 6)
            self.assertEqual(ext_sum["total_cases_evaluated"], 60)
            self.assertEqual(ext_sum["total_verdict_matches"], 60)
            self.assertEqual(ext_sum["overall_verdict_accuracy"], 1.0)
            self.assertEqual(ext_sum["confident_wrong_dose_count"], 0)
            self.assertEqual(ext_sum["pii_or_bystander_leak_count"], 0)
            self.assertEqual(ext_sum["false_safe_allergen_count"], 0)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 0)

            arts = compiled["artifacts"]
            self.assertEqual(arts["curved_blister_results"]["readable_recall"], 1.0)
            self.assertEqual(arts["coaching_trajectories"]["n_trajectories"], 4)
            self.assertEqual(arts["coaching_trajectories"]["total_verify_calls"], 8)
            self.assertEqual(arts["coaching_trajectories"]["pre_coaching_abstention_rate"], 1.0)
            self.assertEqual(arts["coaching_trajectories"]["post_coaching_verdict_accuracy"], 1.0)
            self.assertEqual(arts["lighting_motion_results"]["moderate_degradation_recall"], 1.0)
            self.assertEqual(arts["lighting_motion_results"]["severe_degradation_abstention_rate"], 1.0)
            self.assertEqual(arts["multilingual_labels_results"]["languages_tested"], ["fi", "sv", "de", "fr", "es", "en"])
            self.assertEqual(arts["bystander_privacy_results"]["pii_or_bystander_leak_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["privacy_pass_rate"], 1.0)
            self.assertEqual(arts["polypharmacy_confusion_results"]["double_dose_catches"], 2)
            self.assertEqual(arts["polypharmacy_confusion_results"]["lasa_strength_catches"], 3)
            self.assertEqual(arts["polypharmacy_confusion_results"]["drug_class_catches"], 2)

            self.assertIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            for spec in EXTENDED_ARTIFACT_SPECS:
                self.assertIn(f"`eval/{spec['filename']}`", md)
                self.assertIn(spec["repro_cmd"], md)
            self.assertIn("Languages: fi, sv, de, fr, es, en", md)
            self.assertIn("0 PII/bystander leaks", md)
            self.assertIn("Pre-coaching abstention 100.0%", md)
            self.assertIn("Double-dose catches 2", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn(EM_DASH, out_json.read_text(encoding="utf-8"))
            self.assertNotIn(EM_DASH, md)

    def test_partial_extended_suites_scrubs_em_dash_and_rolls_up_safety_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            payloads = _synthetic_extended_payloads()
            ml = payloads["multilingual_labels_results.json"]
            ml["model"] = f"gemini-3.8-flash{EM_DASH}eu"
            ml["summary"]["confident_wrong_dose_count"] = 1
            ml["summary"]["false_safe_allergen_count"] = 2
            bp = payloads["bystander_privacy_results.json"]

            (tmp_dir / "multilingual_labels_results.json").write_text(json.dumps(ml), encoding="utf-8")
            (tmp_dir / "bystander_privacy_results.json").write_text(json.dumps(bp), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(
                compiled["extended_suites_present"],
                ["multilingual_labels_results", "bystander_privacy_results"],
            )
            self.assertEqual(compiled["extended_summary"]["suites_count"], 2)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 1)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 2)

            self.assertIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertIn("`eval/multilingual_labels_results.json`", md)
            self.assertIn("`eval/bystander_privacy_results.json`", md)
            self.assertNotIn("`eval/curved_blister_results.json`", md)
            self.assertNotIn("`eval/coaching_trajectories.json`", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("missing", md.lower())
            self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
            self.assertNotIn(EM_DASH, md)

    def test_item_level_fallback_derivations_for_trajectories_privacy_and_languages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            traj_minimal = {
                "summary": {"n_items": 2},
                "items": [
                    {
                        "id": "t1",
                        "pre_coaching": {"level": "unsure", "sharpness_scores": [11.2, 16.4], "latency_ms": 3100.0},
                        "post_coaching": {"expected_level": "match", "level": "match", "sharpness_scores": [16.4, 88.9], "latency_ms": 3500.0},
                    },
                    {
                        "id": "t2",
                        "pre_coaching": {"level": "unsure", "sharpness_scores": [12.0], "latency_ms": 3200.0},
                        "post_coaching": {"expected_level": "warning", "level": "warning", "sharpness_scores": [90.1], "latency_ms": 3600.0},
                    },
                ],
            }
            ml_minimal = {
                "summary": {},
                "items": [
                    {"id": "m1", "lang": "fi", "expected_level": "match", "predicted_level": "match", "false_safe_allergen": False, "latency_ms": 3250.0},
                    {"id": "m2", "lang": "de", "expected_level": "warning", "predicted_level": "warning", "false_safe_allergen": False, "latency_ms": 3350.0},
                ],
            }
            bp_minimal = {
                "summary": {},
                "items": [
                    {"id": "b1", "expected_level": "match", "predicted_level": "match", "privacy_pass": True, "latency_ms": 3180.0},
                    {"id": "b2", "expected_level": "unsure", "predicted_level": "unsure", "privacy_pass": True, "latency_ms": 3280.0},
                ],
            }
            (tmp_dir / "coaching_trajectories.json").write_text(json.dumps(traj_minimal), encoding="utf-8")
            (tmp_dir / "multilingual_labels_results.json").write_text(json.dumps(ml_minimal), encoding="utf-8")
            (tmp_dir / "bystander_privacy_results.json").write_text(json.dumps(bp_minimal), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            arts = compiled["artifacts"]

            ct = arts["coaching_trajectories"]
            self.assertEqual(ct["n_trajectories"], 2)
            self.assertEqual(ct["total_verify_calls"], 4)
            self.assertEqual(ct["pre_coaching_abstention_rate"], 1.0)
            self.assertEqual(ct["post_coaching_verdict_accuracy"], 1.0)
            self.assertEqual(ct["verdict_matches"], 4)
            self.assertEqual(ct["trajectories"][0]["stage_a_sharpness"], 16.4)
            self.assertEqual(ct["trajectories"][0]["stage_b_sharpness"], 88.9)
            self.assertIsNotNone(ct["latency_ms"]["p50"])

            self.assertEqual(arts["multilingual_labels_results"]["languages_tested"], ["fi", "de"])
            self.assertEqual(arts["multilingual_labels_results"]["false_safe_allergen_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["pii_or_bystander_leak_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["privacy_pass_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
