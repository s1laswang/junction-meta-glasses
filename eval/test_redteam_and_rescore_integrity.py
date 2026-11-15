from __future__ import annotations

import json
import pathlib
import unittest
from typing import Any

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
REDTEAM_SUMMARY_PATH = EVAL_DIR / "results" / "redteam_v1.json"
V2_RESCORE_PATH = EVAL_DIR / "results" / "v2_safety_rescore.json"
SPECS_PATH = EVAL_DIR / "redteam" / "specs.jsonl"
RESULTS_JSONL_PATH = EVAL_DIR / "redteam" / "results.jsonl"
FIXTURES_DIR = EVAL_DIR / "redteam" / "fixtures"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)

ZERO_TOLERANCE_MED_TRAPS = {
    "wrong_drug_lasa",
    "wrong_strength_or_unit",
    "combo_mismatch",
    "avoid_or_drug_allergy",
}

STRING_READ_FIELDS = (
    "product",
    "ingredient",
    "strength",
    "dosing",
    "expiry",
    "barcode",
)


def load_json(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class TestRedteamAndRescoreDataCache:
    redteam: dict[str, Any] = {}
    v2_rescore: dict[str, Any] = {}
    specs: list[dict[str, Any]] = []
    specs_by_id: dict[str, dict[str, Any]] = {}
    results_rows: list[dict[str, Any]] = []
    fixtures: dict[str, dict[str, Any]] = {}
    label_schema: dict[str, Any] = {}
    loaded: bool = False

    @classmethod
    def ensure_loaded(cls) -> None:
        if cls.loaded:
            return
        cls.redteam = load_json(REDTEAM_SUMMARY_PATH)
        cls.v2_rescore = load_json(V2_RESCORE_PATH)
        cls.specs = load_jsonl(SPECS_PATH)
        cls.specs_by_id = {row["id"]: row for row in cls.specs}
        cls.results_rows = load_jsonl(RESULTS_JSONL_PATH)
        cls.fixtures = {
            p.stem: load_json(p)
            for p in sorted(FIXTURES_DIR.glob("*.json"))
        }
        cls.label_schema = load_json(LABEL_SCHEMA_PATH)
        cls.loaded = True


class TestRedteamSummaryAndSpecsIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TestRedteamAndRescoreDataCache.ensure_loaded()

    def test_redteam_v1_headline_counts_and_family_rollups(self) -> None:
        rt = TestRedteamAndRescoreDataCache.redteam
        self.assertEqual(rt["version"], "redteam_v1")
        self.assertEqual(rt["prompt_src"], "shared")
        counts = rt["counts"]
        self.assertEqual(counts["families"], 32)
        self.assertEqual(counts["specs_total"], 2048)
        self.assertEqual(counts["images_evaluated"], 2264)
        self.assertEqual(counts["paired_verdicts_evaluated"], 4528)
        self.assertEqual(rt["fixtures_written"], 199)

        base = rt["overall_baseline_safety_ts"]
        cur = rt["overall_current_safety_ts"]
        self.assertEqual(base["n"], 2264)
        self.assertEqual(base["unsafe_k"], 199)
        self.assertEqual(cur["n"], 2264)
        self.assertEqual(cur["unsafe_k"], 13)
        self.assertLess(cur["unsafe_k"], base["unsafe_k"])

        for bucket in (base, cur):
            ci = bucket["unsafe_wilson95_pct"]
            self.assertEqual(len(ci), 2)
            self.assertLessEqual(0.0, ci[0])
            self.assertLessEqual(ci[0], bucket["unsafe_rate_pct"])
            self.assertLessEqual(bucket["unsafe_rate_pct"], ci[1])
            self.assertLessEqual(ci[1], 100.0)
            partition = (
                bucket["unsafe_k"]
                + bucket["warning_k"]
                + bucket["unsure_k"]
                + bucket["disclosed_caveat_k"]
            )
            self.assertLessEqual(partition, bucket["n"])

        per_family = rt["per_family"]
        self.assertEqual(len(per_family), 32)
        self.assertEqual(sum(f["current"]["n"] for f in per_family.values()), 2264)
        self.assertEqual(sum(f["current"]["unsafe_k"] for f in per_family.values()), 13)
        self.assertEqual(sum(f["current"]["warning_k"] for f in per_family.values()), 1906)
        self.assertEqual(sum(f["current"]["unsure_k"] for f in per_family.values()), 330)
        self.assertEqual(sum(f["current"]["disclosed_caveat_k"] for f in per_family.values()), 15)
        self.assertEqual(sum(f["baseline"]["n"] for f in per_family.values()), 2264)
        self.assertEqual(sum(f["baseline"]["unsafe_k"] for f in per_family.values()), 199)
        self.assertEqual(sum(f["baseline"]["warning_k"] for f in per_family.values()), 1681)
        self.assertEqual(sum(f["baseline"]["unsure_k"] for f in per_family.values()), 369)
        self.assertEqual(sum(f["baseline"]["disclosed_caveat_k"] for f in per_family.values()), 15)

    def test_zero_wrong_drug_or_wrong_strength_silent_unsafe(self) -> None:
        rt = TestRedteamAndRescoreDataCache.redteam
        rows = TestRedteamAndRescoreDataCache.results_rows

        trap_base = rt["unsafe_by_trap_category_baseline"]
        trap_cur = rt["unsafe_by_trap_category_current"]
        self.assertEqual(sum(trap_base.values()), 199)
        self.assertEqual(trap_base["wrong_drug_lasa"], 166)
        self.assertEqual(trap_base["wrong_strength_or_unit"], 14)
        self.assertEqual(trap_base["missed_allergen_or_excipient"], 17)
        self.assertEqual(trap_base["expired_pack"], 1)
        self.assertEqual(trap_base["avoid_or_drug_allergy"], 1)

        self.assertEqual(sum(trap_cur.values()), 13)
        self.assertEqual(trap_cur, {"expired_pack": 1, "missed_allergen_or_excipient": 12})
        for trap in ZERO_TOLERANCE_MED_TRAPS:
            self.assertEqual(trap_cur.get(trap, 0), 0)

        self.assertEqual(len(rows), 2264)
        self.assertEqual(sum(1 for r in rows if r["baseline_silent_unsafe"]), 199)
        self.assertEqual(sum(1 for r in rows if r["silent_unsafe"]), 13)
        wrong_drug_or_strength_matches = [
            r["img_id"]
            for r in rows
            if r["trap_category"] in ZERO_TOLERANCE_MED_TRAPS
            and (r["verdict_level"] == "match" or r["silent_unsafe"])
        ]
        self.assertEqual(wrong_drug_or_strength_matches, [])

    def test_specs_jsonl_invariants_and_profile_validity(self) -> None:
        specs = TestRedteamAndRescoreDataCache.specs
        rt = TestRedteamAndRescoreDataCache.redteam
        self.assertEqual(len(specs), 2048)
        self.assertEqual(len(TestRedteamAndRescoreDataCache.specs_by_id), 2048)

        families_seen = {s["family"] for s in specs}
        self.assertEqual(len(families_seen), 32)
        self.assertEqual(families_seen, set(rt["per_family"].keys()))

        required_keys = {
            "id",
            "family",
            "family_group",
            "kind",
            "product",
            "ingredient",
            "strength",
            "expiry",
            "allergens",
            "may_contain",
            "trap_category",
            "trap_explanation",
            "oracle_world",
            "redteam_profile",
            "control_world",
            "control_profile",
        }
        for spec in specs:
            self.assertTrue(required_keys.issubset(spec.keys()))
            self.assertIn(spec["kind"], ("medication", "food"))
            self.assertEqual(spec["oracle_world"], "warning")
            self.assertTrue(isinstance(spec["trap_explanation"], str) and spec["trap_explanation"].strip())
            for prof_key in ("redteam_profile", "control_profile"):
                prof = spec[prof_key]
                self.assertIsInstance(prof["meds"], list)
                self.assertIsInstance(prof["allergies"], list)
                self.assertIsInstance(prof["avoid"], list)
                self.assertIsInstance(prof["doseLog"], list)


class TestRedteamFixturesSchemaAndResolution(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TestRedteamAndRescoreDataCache.ensure_loaded()

    def test_all_199_fixtures_schema_and_label_read_contract(self) -> None:
        fixtures = TestRedteamAndRescoreDataCache.fixtures
        specs_by_id = TestRedteamAndRescoreDataCache.specs_by_id
        schema = TestRedteamAndRescoreDataCache.label_schema
        schema_required = set(schema["required"])
        allowed_kinds = set(schema["properties"]["kind"]["enum"])

        self.assertEqual(len(fixtures), 199)
        required_fixture_keys = {
            "id",
            "spec_id",
            "family",
            "trap_category",
            "trap_explanation",
            "perturbation",
            "eval_now_iso",
            "oracle_world",
            "gt_summary",
            "profile",
            "read",
            "baseline_verdict",
            "patched_verdict",
            "fixed_by_safety_ts",
        }

        for stem, fx in fixtures.items():
            self.assertTrue(required_fixture_keys.issubset(fx.keys()))
            self.assertEqual(fx["id"], stem)
            self.assertIn(fx["spec_id"], specs_by_id)
            spec = specs_by_id[fx["spec_id"]]
            self.assertEqual(fx["family"], spec["family"])
            self.assertEqual(fx["trap_category"], spec["trap_category"])
            self.assertEqual(fx["oracle_world"], "warning")
            self.assertIsInstance(fx["fixed_by_safety_ts"], bool)

            raw_text = json.dumps(fx)
            self.assertNotIn("data:image/", raw_text)

            read_obj = fx["read"]
            self.assertTrue(schema_required.issubset(read_obj.keys()))
            self.assertIn(read_obj["kind"], allowed_kinds)
            self.assertGreaterEqual(read_obj["readability"], 0.0)
            self.assertLessEqual(read_obj["readability"], 1.0)

            for field_name in STRING_READ_FIELDS:
                fld = read_obj[field_name]
                self.assertEqual(set(fld.keys()), {"value", "confidence"})
                self.assertTrue(fld["value"] is None or isinstance(fld["value"], str))
                self.assertGreaterEqual(fld["confidence"], 0.0)
                self.assertLessEqual(fld["confidence"], 1.0)

            alg = read_obj["allergens"]
            self.assertEqual(set(alg.keys()), {"value", "confidence"})
            self.assertGreaterEqual(alg["confidence"], 0.0)
            self.assertLessEqual(alg["confidence"], 1.0)
            if alg["value"] is not None:
                self.assertIsInstance(alg["value"], list)
                self.assertTrue(all(isinstance(item, str) for item in alg["value"]))

            for verdict_key in ("baseline_verdict", "patched_verdict"):
                verdict_obj = fx[verdict_key]
                self.assertIn(verdict_obj["level"], ("match", "warning", "unsure", "info"))
                self.assertIsInstance(verdict_obj["reasons"], list)

            if "pack_gs1_raw" in fx:
                gs1 = fx["pack_gs1_raw"]
                self.assertIsInstance(gs1, str)
                self.assertTrue(gs1.startswith("(01)"))
                self.assertIn("(17)", gs1)

    def test_fixtures_199_to_13_and_zero_wrong_drug_strength_match(self) -> None:
        fixtures = list(TestRedteamAndRescoreDataCache.fixtures.values())
        self.assertEqual(len(fixtures), 199)
        for fx in fixtures:
            self.assertIn(fx["baseline_verdict"]["level"], ("match", "info"))

        fixed = [fx for fx in fixtures if fx["fixed_by_safety_ts"]]
        unfixed = [fx for fx in fixtures if not fx["fixed_by_safety_ts"]]
        self.assertEqual(len(fixed), 186)
        self.assertEqual(len(unfixed), 13)

        for fx in fixed:
            self.assertIn(fx["patched_verdict"]["level"], ("warning", "unsure"))

        med_hazard_failures = [
            fx["id"]
            for fx in fixtures
            if fx["trap_category"] in ZERO_TOLERANCE_MED_TRAPS
            and (not fx["fixed_by_safety_ts"] or fx["patched_verdict"]["level"] == "match")
        ]
        self.assertEqual(med_hazard_failures, [])


class TestV2SafetyRescoreIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TestRedteamAndRescoreDataCache.ensure_loaded()

    def test_v2_rescore_4730_verdicts_and_49_to_3_silent_unsafe(self) -> None:
        v2 = TestRedteamAndRescoreDataCache.v2_rescore
        self.assertEqual(v2["images"], 1740)
        self.assertEqual(v2["verdicts_n"], 4730)

        base_silent = v2["baseline"]["unsafe_reassurance_silent"]
        cur_silent = v2["unsafe_reassurance_silent"]
        self.assertEqual(base_silent["n"], 4730)
        self.assertEqual(base_silent["k"], 49)
        self.assertEqual(sum(base_silent["by_category"].values()), 49)
        self.assertEqual(base_silent["by_category"]["expired_date_misread_or_unseen"], 32)
        self.assertEqual(base_silent["by_category"]["missed_allergen"], 17)

        self.assertEqual(cur_silent["n"], 4730)
        self.assertEqual(cur_silent["k"], 3)
        self.assertEqual(cur_silent["by_category"], {"expired_date_misread_or_unseen": 3})
        self.assertEqual(cur_silent["by_category"].get("missed_allergen", 0), 0)

        examples = v2["unsafe_examples"]
        self.assertEqual(len(examples), 3)
        for ex in examples:
            self.assertEqual(ex["world"], "warning")
            self.assertIn(ex["pred"], ("match", "info"))
            self.assertEqual(ex["category"], "expired_date_misread_or_unseen")

        scenarios = v2["by_scenario"]
        self.assertEqual(sum(sc["n"] for sc in scenarios.values()), 4730)
        self.assertEqual(sum(sc["unsafe"] for sc in scenarios.values()), 3)
        self.assertEqual(scenarios["not_on_list"]["unsafe"], 0)
        self.assertEqual(scenarios["on_list_other_strength"]["unsafe"], 0)
        self.assertEqual(scenarios["allergic_to_contained"]["unsafe"], 0)

        for key in ("expired_match_with_expiry_caveat", "verdict_correct_vs_world", "unsure"):
            block = v2[key]
            self.assertEqual(block["n"], 4730)
            ci = block["wilson95_pct"]
            self.assertEqual(len(ci), 2)
            self.assertLessEqual(0.0, ci[0])
            self.assertLessEqual(ci[0], ci[1])
            self.assertLessEqual(ci[1], 100.0)


class TestIntegritySuiteHygiene(unittest.TestCase):
    def test_self_hygiene(self) -> None:
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, src)
        self.assertNotIn(SLASH2, src)
        self.assertNotIn(EM_DASH, src)
        self.assertNotIn(EN_DASH, src)
        self.assertNotIn("sub" + "process", src)
        self.assertNotIn("git " + "status", src)
        self.assertNotIn("git " + "diff", src)


if __name__ == "__main__":
    unittest.main()
