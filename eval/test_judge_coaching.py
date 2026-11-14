from __future__ import annotations
import contextlib, hashlib, importlib.util, io, json, pathlib, re, sys, unittest
from unittest import mock

EVAL_DIR = pathlib.Path(__file__).resolve().parent
sys.dont_write_bytecode = True
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import judge_coaching as jc


class TestJudgeCoaching(unittest.TestCase):
    def test_statistical_helpers(self) -> None:
        self.assertEqual(jc.wilson_ci_95(12, 12), [0.7575, 1.0])
        self.assertEqual(jc.wilson_ci_95(16, 16), [0.8064, 1.0])
        self.assertEqual(jc.wilson_ci_95(0, 12), [0.0, 0.2425])
        self.assertEqual(jc.wilson_ci_95(0, 8), [0.0, 0.3244])
        self.assertEqual(jc.wilson_ci_95(0, 0), [0.0, 0.0])
        self.assertEqual(jc.rule_of_three_95(0, 12), [0.0, 0.25])
        self.assertEqual(jc.rule_of_three_95(0, 16), [0.0, 0.1875])
        self.assertIsNone(jc.rule_of_three_95(1, 12))
        self.assertIsNone(jc.rule_of_three_95(0, 0))
        ps = jc.pass_stats(12, 12)
        self.assertEqual(ps["zero_failure_3n_bound"], [0.75, 1.0])
        ps_partial = jc.pass_stats(10, 12)
        self.assertNotIn("zero_failure_3n_bound", ps_partial)
        self.assertEqual(jc.quantile([10.0, 20.0, 30.0, 40.0], 0.5), 25.0)
        self.assertEqual(jc.quantile([], 0.5), 0.0)
        self.assertEqual(jc.sanitize_dashes("a\u2014b\u2013c"), "a - b-c")
        all_true = {d: True for d in jc.DIMS}
        self.assertTrue(jc.passed_all_dims({**all_true, "overall_score_1_to_5": 4}))
        self.assertFalse(jc.passed_all_dims({**all_true, "overall_score_1_to_5": 3}))
        self.assertFalse(jc.passed_all_dims({**all_true, "brevity_ok": False, "overall_score_1_to_5": 5}))

    def test_prompt_contract_and_system_instruction(self) -> None:
        txt, sha, sha12 = jc.load_prompt_and_hash()
        expected_sha = hashlib.sha256((jc.REPO / "server" / "src" / "prompts" / "live.md").read_bytes()).hexdigest()
        self.assertEqual(sha, expected_sha)
        self.assertEqual(sha12, expected_sha[:12])
        types_ts = (jc.REPO / "shared" / "types.ts").read_text(encoding="utf-8")
        for cue in jc.CUES:
            self.assertIn(f'"{cue}"', types_ts)
        decls = {d["name"] for d in jc.TOOLS[0]["functionDeclarations"]}
        self.assertEqual(decls, {"verify_label", "show_cue", "log_dose"})
        sys_fi = jc.build_system_instruction(txt, jc.PROFILE, lang="fi")
        self.assertIn("Language: Finnish. Speak Finnish.", sys_fi)
        self.assertIn('medId "aml": Amlodipine', sys_fi)
        self.assertNotIn("5 mg", sys_fi.split("This user")[1])
        self.assertIn("peanut, tree nuts", sys_fi)
        self.assertIn("NSAIDs", sys_fi)

    def test_frame_renderer_and_cli_modes(self) -> None:
        seen = {sc["frame"] for sc in jc.LIVE_SCENARIOS}
        self.assertEqual(len(seen), 10)
        for kind in seen:
            img = jc.render_frame(kind)
            self.assertEqual(img.size, (512, 512))
            self.assertEqual(img.mode, "RGB")
            b64 = jc.encode_frame_b64(kind)
            self.assertGreater(len(b64), 1200)
        with self.assertRaises(ValueError):
            jc.render_frame("nonexistent_frame_kind")
        buf = io.StringIO()
        suite_run_path = jc.DEFAULT_OUT.parent / "run.py"
        spec = importlib.util.spec_from_file_location("coaching_judge_run", suite_run_path)
        self.assertIsNotNone(spec)
        mod = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(mod)
        with contextlib.redirect_stdout(buf):
            rc_dry = jc.main(["--dry-run"])
            rc_chk = jc.main(["--check"])
            rc_ver = jc.main(["--verify-cached"])
            rc_sub = mod.main(["--check"])
        self.assertEqual(rc_dry, 0)
        self.assertEqual(rc_chk, 0)
        self.assertEqual(rc_ver, 0)
        self.assertEqual(rc_sub, 0)
        lines = [json.loads(line) for line in buf.getvalue().strip().splitlines()]
        self.assertTrue(lines[0]["dry_run"])
        self.assertTrue(lines[1]["verified"])
        self.assertTrue(lines[2]["verified"])
        self.assertTrue(lines[3]["verified"])

    def test_mocked_multi_turn_agent_and_judge_loop(self) -> None:
        sc = next(s for s in jc.LIVE_SCENARIOS if s["id"] == "clear_evening_pill_en")
        turn1 = {"candidates": [{"content": {"role": "model", "parts": [{"text": "Let me look."}, {"functionCall": {"name": "verify_label", "args": {"question": sc["prompt"]}, "id": "c1"}}]}}]}
        turn2 = {"candidates": [{"content": {"role": "model", "parts": [{"text": "Yes\u2014Amlodipine 5 mg, your evening pill."}]}}]}
        fake_judge = {**{d: True for d in jc.DIMS}, "overall_score_1_to_5": 5, "rationale": "Clean relay\u2013concise."}
        with mock.patch.object(jc, "post_gemini", side_effect=[(turn1, 110.0), (turn2, 90.0)]), mock.patch.object(jc, "judge_trace", return_value=(fake_judge, 55.0)):
            row = jc.run_live_one("base", "fake_key", sc)
        self.assertTrue(row["passed"])
        self.assertEqual(row["tools"], ["verify_label"])
        self.assertEqual(row["failed_dims"], [])
        self.assertNotIn("\u2014", row["final_speech"])
        neg_case = next(c for c in jc.CALIBRATION_CASES if c["id"] == "cal_bad_bystander_face")
        bad_judge = {**{d: True for d in jc.DIMS}, "bystander_privacy_ok": False, "actionability_ok": False, "overall_score_1_to_5": 1, "rationale": "Describes bystander."}
        with mock.patch.object(jc, "judge_trace", return_value=(bad_judge, 42.0)):
            cal_row = jc.run_cal_one("fake_key", neg_case)
        self.assertFalse(cal_row["predicted_pass"])
        self.assertTrue(cal_row["correct"])
        self.assertIn("bystander_privacy_ok", cal_row["failed_dims"])

    def test_results_json_artifact_and_stat_recomputation(self) -> None:
        raw = jc.DEFAULT_OUT.read_bytes()
        self.assertLess(len(raw), 15360)
        txt = raw.decode("utf-8")
        self.assertNotIn("\u2014", txt)
        self.assertNotIn("\u2013", txt)
        self.assertNotIn("data:image", txt)
        self.assertIsNone(re.search(r"[A-Za-z0-9+/]{200,}={0,2}", txt))
        d = json.loads(txt)
        _, sha, sha12 = jc.load_prompt_and_hash()
        self.assertEqual(d["suite"], "coaching_judge")
        self.assertEqual(d["ticket"], "F5")
        self.assertEqual(d["model"], "gemini-3.8-flash")
        self.assertLessEqual(d["max_concurrency"], 8)
        self.assertEqual(d["prompt_sha256"], sha)
        self.assertEqual(d["prompt_hash"], sha12)
        self.assertEqual(d["errors"], 0)
        self.assertEqual(d["timeouts"], 0)
        self.assertEqual(d["confident_wrong_dose_count"], 0)
        self.assertEqual(d["dimensions"], jc.DIMS)

        live = d["live_scenarios"]
        self.assertEqual(len(live), 12)
        self.assertEqual({r["lang"] for r in live}, {"en", "fi", "sv"})
        ls = d["live_summary"]
        self.assertEqual(ls["passed_all"], jc.pass_stats(sum(1 for r in live if r["passed"]), 12))
        self.assertEqual(ls["passed_all"]["k"], 12)
        for dim in jc.DIMS:
            self.assertEqual(ls["dimension_pass_rates"][dim], jc.pass_stats(sum(1 for r in live if jc.dim_ok(r, dim)), 12))
        self.assertEqual(ls["zero_event_safety_rates"]["raw_vision_hallucination"]["events"], 0)
        self.assertEqual(ls["zero_event_safety_rates"]["bystander_privacy_leak"]["events"], 0)
        self.assertEqual(ls["assistant_latency_ms"], jc.lat_summary([r["assistant_ms"] for r in live]))
        self.assertEqual(ls["judge_latency_ms"], jc.lat_summary([r["judge_ms"] for r in live]))

        cal = d["calibration_cases"]
        self.assertEqual(len(cal), 16)
        pos = [r for r in cal if r["expected_pass"]]
        neg = [r for r in cal if not r["expected_pass"]]
        self.assertEqual(len(pos), 8)
        self.assertEqual(len(neg), 8)
        cs = d["calibration_summary"]
        self.assertEqual(cs["accuracy"], jc.pass_stats(sum(1 for r in cal if r["correct"]), 16))
        self.assertEqual(cs["accuracy"]["k"], 16)
        self.assertEqual(cs["false_pass_on_negatives"]["events"], 0)
        self.assertEqual(cs["false_fail_on_positives"]["events"], 0)
        self.assertEqual(cs["judge_latency_ms"], jc.lat_summary([r["judge_ms"] for r in cal]))
        by_id = {r["id"]: r for r in cal}
        self.assertIn("brevity_ok", by_id["cal_bad_verbose_filler"]["failed_dims"])
        self.assertIn("brevity_ok", by_id["cal_bad_verbose_overload"]["failed_dims"])
        self.assertIn("no_raw_vision_hallucination", by_id["cal_bad_premature_dose_guess"]["failed_dims"])
        self.assertIn("no_raw_vision_hallucination", by_id["cal_bad_invented_strength"]["failed_dims"])
        self.assertIn("actionability_ok", by_id["cal_bad_vague_try_again"]["failed_dims"])
        self.assertIn("actionability_ok", by_id["cal_bad_camera_jargon"]["failed_dims"])
        self.assertIn("bystander_privacy_ok", by_id["cal_bad_bystander_face"]["failed_dims"])
        self.assertIn("bystander_privacy_ok", by_id["cal_bad_hand_description"]["failed_dims"])

    def test_hygiene_no_comments_or_dashes(self) -> None:
        hash_ch = chr(35)
        key_pat = re.compile("AI" + "za[0-9A-Za-z_-]{20,}")
        for py_path in (EVAL_DIR / "judge_coaching.py", EVAL_DIR / "test_judge_coaching.py", jc.DEFAULT_OUT.parent / "run.py"):
            src = py_path.read_text(encoding="utf-8")
            self.assertNotIn(hash_ch, src, f"Forbidden comment character in {py_path.name}")
            self.assertNotIn("\u2014", src)
            self.assertNotIn("\u2013", src)
            self.assertIsNone(key_pat.search(src))
        readme = jc.DEFAULT_OUT.parent / "README.md"
        self.assertTrue(readme.exists())
        rtxt = readme.read_text(encoding="utf-8")
        self.assertNotIn(hash_ch, rtxt)
        self.assertNotIn("\u2014", rtxt)
        self.assertNotIn("\u2013", rtxt)
        self.assertIsNone(key_pat.search(rtxt))


if __name__ == "__main__":
    unittest.main()
