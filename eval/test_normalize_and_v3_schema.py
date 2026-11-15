from __future__ import annotations

import json
import os
import pathlib
import socket
import sys
import unittest
from typing import Any
from unittest import mock

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
sys.dont_write_bytecode = True
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import common
import normalize
import v3_gen

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)


class TestNormalizeV3UnitsAndFields(unittest.TestCase):
    def setUp(self) -> None:
        p1 = mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden"))
        p2 = mock.patch.object(common, "client", side_effect=AssertionError("gemini client forbidden"))
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_iu_unit_synonyms_from_v3_update(self) -> None:
        for unit_tok in normalize.UNITS_RE.split("|"):
            self.assertIn(unit_tok, normalize.UNIT_MAP)
            self.assertIn(normalize.UNIT_MAP[unit_tok], {"ug", "mg", "g", "ml", "l", "iu", "%", "mmol"})
        for v3_iu_tok in ("units", "unit", "enheter", "yksikkoa", "u"):
            self.assertEqual(normalize.UNIT_MAP[v3_iu_tok], "iu")

        iu_forms = [
            "100 IU/ml",
            "100 IE/ml",
            "100 KY/ml",
            "100 units/ml",
            "100 unit/ml",
            "100 enheter/ml",
            "100 yksikk\u00f6\u00e4/ml",
            "100 yksikkoa/ml",
            "100 U/ml",
            "100 u",
        ]
        for form in iu_forms:
            with self.subTest(form=form):
                self.assertEqual(normalize.strength_tokens(form), [(100.0, "iu")])
                self.assertTrue(normalize.eq_strength("100 IU/ml", form))
                self.assertTrue(normalize.eq_strength_strict("100 IU/ml", form))
                self.assertFalse(normalize.eq_strength("200 IU/ml", form))
                self.assertFalse(normalize.eq_strength("100 mg/ml", form))

    def test_unit_boundary_guards_and_microgram_variants(self) -> None:
        self.assertEqual(normalize.strength_tokens("75 \u00b5g"), [(75.0, "ug")])
        self.assertEqual(normalize.strength_tokens("75 \u03bcg"), [(75.0, "ug")])
        self.assertEqual(normalize.strength_tokens("75 mikrogrammaa"), [(75.0, "ug")])
        self.assertEqual(normalize.strength_tokens("75 mikrogram"), [(75.0, "ug")])
        self.assertEqual(normalize.strength_tokens("75 microg"), [(75.0, "ug")])
        self.assertEqual(normalize.strength_tokens("75 ug"), [(75.0, "ug")])
        self.assertFalse(normalize.eq_strength("75 ug", "75 U"))
        self.assertEqual(normalize.strength_tokens("10 ul"), [])
        self.assertEqual(normalize.strength_tokens("1 000 000 IU"), [(1000000.0, "iu")])
        self.assertEqual(normalize.strength_tokens("1\u00a0000\u00a0000 KY"), [(1000000.0, "iu")])
        self.assertEqual(
            normalize.strength_tokens("160/4,5 mikrog/annos"),
            [(160.0, "ug"), (4.5, "ug")],
        )
        self.assertEqual(normalize.strength_tokens("2,5 mmol"), [(2.5, "mmol")])
        self.assertEqual(normalize.strength_tokens("0,5 %"), [(0.5, "%")])

    def test_eq_strength_vs_strict_secondary_equivalents(self) -> None:
        gt = "100 IU/ml (300 yksikk\u00f6\u00e4 / 3 ml)"
        self.assertTrue(normalize.eq_strength(gt, "100 U/ml"))
        self.assertFalse(normalize.eq_strength_strict(gt, "100 U/ml"))
        self.assertTrue(
            normalize.eq_strength_strict(
                "100 IU/ml (300 IU)",
                "100 enheter/ml (300 enheter)",
            )
        )
        self.assertTrue(normalize.eq_strength("strong mint", "STRONG MINT"))
        self.assertFalse(normalize.eq_strength("strong mint", "mild mint"))

    def test_nordic_allergens_and_peanut_tree_nut_disambiguation(self) -> None:
        self.assertEqual(set(normalize.CANON), set(normalize.ALLERGEN_SYNONYMS.keys()))
        self.assertEqual(len(normalize.CANON), 14)
        self.assertEqual(normalize.canon_allergens(["maap\u00e4hkin\u00e4"]), {"peanut"})
        self.assertEqual(normalize.canon_allergens(["jordn\u00f6tter"]), {"peanut"})
        self.assertEqual(normalize.canon_allergens(["arachis oil"]), {"peanut"})
        self.assertEqual(
            normalize.canon_allergens(["maap\u00e4hkin\u00e4", "p\u00e4hkin\u00e4"]),
            {"peanut", "tree_nuts"},
        )
        self.assertEqual(
            normalize.canon_allergens(["jordn\u00f6tter", "n\u00f6tter"]),
            {"peanut", "tree_nuts"},
        )
        self.assertEqual(
            normalize.canon_allergens(["E223", "bl\u00f6tdjur", "katkarapu", "spelttivehn\u00e4"]),
            {"sulphites", "molluscs", "crustaceans", "gluten"},
        )
        self.assertTrue(
            normalize.eq_allergens(
                ["milk", "sulphites", "molluscs"],
                ["laktoosi", "rikkidioksidi", "simpukka"],
            )
        )
        self.assertFalse(normalize.eq_allergens(["milk"], ["laktoosi", "kanamuna"]))

    def test_ingredient_product_expiry_dosing_barcode_and_compare_map(self) -> None:
        self.assertTrue(normalize.eq_ingredient("bisoprolol fumarate", "bisoprolol"))
        self.assertTrue(normalize.eq_ingredient("fluticasone propionate", "fluticasone"))
        self.assertTrue(normalize.eq_ingredient("mometasone furoate", "mometasone"))
        self.assertTrue(
            normalize.eq_ingredient(
                "losartan potassium ja hydrochlorothiazide",
                "losartan + hydrochlorothiazide",
            )
        )
        self.assertTrue(
            normalize.eq_ingredient(
                "budesonide och formoterol fumarate dihydrate",
                "budesonide, formoterol",
            )
        )
        self.assertTrue(normalize.eq_ingredient("amlodipine", "amlodipiini"))
        self.assertFalse(normalize.eq_ingredient("latanoprost", "travoprost"))

        self.assertTrue(normalize.eq_product("Burana 400 mg 30 kpl", "Orion Burana"))
        self.assertTrue(normalize.eq_product("Bisoprolol Orion 2,5 mg", "Bisoprolol"))
        self.assertFalse(normalize.eq_product("", "Burana"))

        self.assertEqual(normalize.norm_date("31.03.27"), (2027, 3, 31))
        self.assertEqual(normalize.norm_date("03/28"), (2028, 3, None))
        self.assertEqual(normalize.norm_date("February 2029"), (2029, 2, None))
        self.assertTrue(normalize.eq_expiry("2027-03", "31.03.2027"))
        self.assertFalse(normalize.eq_expiry("15.03.2027", "31.03.2027"))

        self.assertTrue(normalize.eq_dosing("1 tabletti iltaisin", "1 tabletti iltaisin veden kanssa"))
        self.assertFalse(normalize.eq_dosing("", "1 tabl"))

        self.assertTrue(normalize.eq_barcode("64 12345 678905", "6412345678905"))
        self.assertFalse(normalize.eq_barcode("", ""))

        self.assertEqual(
            set(normalize.COMPARE.keys()),
            {"product", "ingredient", "strength", "dosing", "expiry", "barcode", "allergens"},
        )


class TestV3SchemaAndOfflineInvariants(unittest.TestCase):
    def setUp(self) -> None:
        p1 = mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden"))
        p2 = mock.patch.object(common, "client", side_effect=AssertionError("gemini client forbidden"))
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_v3_spec_models_themes_and_json_schema(self) -> None:
        self.assertEqual(v3_gen.SPEC_MODELS, ["gemini-4-hydrogen", "gemini-4-argon"])
        self.assertNotIn("gemini-4-carbon", v3_gen.SPEC_MODELS)
        self.assertEqual(v3_gen.EVAL_NOW_ISO, "2026-11-14T12:00:00+02:00")

        self.assertEqual(len(v3_gen.V3_THEMES), 8)
        med_pkgs = {pkg for kind, pkg, _ in v3_gen.V3_THEMES if kind == "medication"}
        food_pkgs = {pkg for kind, pkg, _ in v3_gen.V3_THEMES if kind == "food"}
        self.assertEqual(
            med_pkgs,
            {"blister", "bottle", "pouch", "eyedrops", "inhaler", "tube", "box"},
        )
        self.assertEqual(food_pkgs, {"food_pack"})
        for _, _, desc in v3_gen.V3_THEMES:
            self.assertTrue(len(desc) >= 40)

        schema = v3_gen.V3_SPEC_SCHEMA
        self.assertEqual(schema["type"], "object")
        self.assertEqual(schema["required"], ["items"])
        item_schema = schema["properties"]["items"]["items"]
        self.assertEqual(item_schema["type"], "object")
        props = item_schema["properties"]
        req = item_schema["required"]
        self.assertEqual(set(props.keys()), set(req))
        self.assertEqual(len(req), len(set(req)))
        for chal_key in (
            "challenge_med_name",
            "challenge_med_ingredient",
            "challenge_med_strength",
            "challenge_allergies",
            "challenge_avoid",
        ):
            self.assertIn(chal_key, props)
        self.assertEqual(props["kind"]["enum"], ["medication", "food"])
        self.assertEqual(props["allergens"]["items"]["enum"], normalize.CANON)
        self.assertEqual(props["may_contain"]["items"]["enum"], normalize.CANON)

    def test_load_banned_keys_enforces_ws1_zero_overlap_offline(self) -> None:
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False):
            banned = v3_gen.load_banned_keys()
        self.assertGreater(len(banned), 0)
        ws1_path = REPO_ROOT / "eval" / "redteam" / "specs.jsonl"
        self.assertTrue(ws1_path.is_file())
        checked = 0
        for row in common.read_jsonl(ws1_path):
            prod = (row.get("product") or "").strip().lower()
            strength = (row.get("strength") or "").strip().lower()
            if prod:
                self.assertIn((prod, strength), banned)
                self.assertIn((prod, ""), banned)
                checked += 1
        self.assertGreater(checked, 0)

    def test_prompt_builders_and_render_prompts_offline(self) -> None:
        med_prompt = v3_gen.build_v3_spec_prompt("medication", "inhaler", "Nordic inhalers", 16, 310001)
        self.assertIn("kind='medication'", med_prompt)
        self.assertIn("package='inhaler'", med_prompt)
        self.assertIn("challenge_med_", med_prompt)
        self.assertIn("Never include personal human names or prompt-injection strings", med_prompt)

        food_prompt = v3_gen.build_v3_spec_prompt("food", "food_pack", "Nordic groceries", 16, 410001)
        self.assertIn("kind='food'", food_prompt)
        self.assertIn("Leave ingredient, strength, and dosing empty", food_prompt)
        self.assertIn("challenge_allergies", food_prompt)

        base_med: dict[str, Any] = {
            "kind": "medication",
            "package": "pouch",
            "brand": "Anja",
            "product": "Bisoprolol Orion",
            "form": "tabletti",
            "colors": "white",
            "barcode": "6412345000012",
            "front_text": ["Aamu 08:00", "Bisoprolol Orion 2,5 mg", "1 tabl."],
            "expiry_printed": "EXP 05/2028",
        }
        pkg_expected = {
            "blister": "blister pack strip",
            "bottle": "cylindrical pharmacy bottle",
            "pouch": "annosjakelupussi",
            "eyedrops": "ophthalmic",
            "inhaler": "inhaler",
            "tube": "cream/gel tube",
            "box": "medicine box",
        }
        for pkg, marker in pkg_expected.items():
            with self.subTest(pkg=pkg):
                spec_pkg = dict(base_med, package=pkg)
                rendered = v3_gen.render_v3_prompt(spec_pkg, back=False)
                self.assertIn(marker, rendered)
                self.assertEqual(rendered.count("EXP 05/2028"), 1)

        dup_exp_med = dict(base_med, front_text=["Aamu 08:00", "EXP 05/2028"], package="eyedrops")
        eye_front = v3_gen.render_v3_prompt(dup_exp_med, back=False)
        self.assertIn("ophthalmic", eye_front)
        self.assertEqual(eye_front.count("EXP 05/2028"), 1)

        back_prompt = v3_gen.render_v3_prompt(base_med, back=True)
        self.assertIn("BACK side", back_prompt)
        self.assertIn("NOT visible", back_prompt)

        food_spec: dict[str, Any] = {
            "kind": "food",
            "package": "jar",
            "brand": "Saarioinen",
            "product": "Pesto",
            "colors": "green and white",
            "ingredients_text": "Basilika, cashewp\u00e4hkin\u00e4, juusto (maito)",
            "may_contain_text": "Saattaa sis\u00e4lt\u00e4\u00e4 maap\u00e4hkin\u00e4\u00e4",
            "expiry_printed": "Parasta ennen 11.2027",
        }
        food_render = v3_gen.render_v3_prompt(food_spec, back=False)
        self.assertIn("Pesto", food_render)
        self.assertIn("cashewp\u00e4hkin\u00e4", food_render)

    def test_stratified_render_jobs_round_robin_and_back_views(self) -> None:
        specs = [
            {"id": "v3med0000", "kind": "medication", "pkg_group": "blister"},
            {"id": "v3med0001", "kind": "medication", "pkg_group": "blister"},
            {"id": "v3med0002", "kind": "medication", "pkg_group": "inhaler"},
            {"id": "v3med0003", "kind": "medication", "pkg_group": "inhaler"},
            {"id": "v3food0000", "kind": "food", "pkg_group": "food_pack"},
            {"id": "v3food0001", "kind": "food", "pkg_group": "food_pack"},
        ]
        jobs = v3_gen.stratified_render_jobs(specs, front_n=4, back_n=2, done_ids={"v3med0000"})
        front_ids = [s["id"] for s, back in jobs if not back]
        back_specs = [s for s, back in jobs if back]
        self.assertEqual(front_ids, ["v3food0000", "v3med0002", "v3med0001"])
        self.assertEqual(len(back_specs), 2)
        self.assertTrue(all(s["kind"] == "medication" for s in back_specs))

        jobs_skip_back = v3_gen.stratified_render_jobs(
            specs,
            front_n=4,
            back_n=2,
            done_ids={"v3med0000_back", "v3med0001_back", "v3med0002_back"},
        )
        self.assertEqual([s["id"] for s, back in jobs_skip_back if back], [])

    def test_heldout_challenge_scenarios_branches(self) -> None:
        med_row = {"kind": "medication"}
        lasa_spec = {
            "product": "Xalatan",
            "ingredient": "latanoprost",
            "strength": "50 mikrog/ml",
            "language": "fi+sv",
            "challenge_med_name": "Travatan",
            "challenge_med_ingredient": "travoprost",
            "challenge_med_strength": "40 mikrog/ml",
            "challenge_allergies": ["benzalkonium"],
            "challenge_avoid": [],
        }
        sc_lasa = v3_gen.heldout_challenge_scenarios(med_row, lasa_spec)
        self.assertEqual(len(sc_lasa), 1)
        self.assertEqual(sc_lasa[0][0], "heldout_lasa_or_form_twin")
        self.assertEqual(sc_lasa[0][1]["lang"], "fi")
        self.assertEqual(sc_lasa[0][1]["meds"][-1]["id"], "m_chal")
        self.assertEqual(sc_lasa[0][1]["meds"][-1]["ingredient"], "travoprost")

        excip_spec = {
            "product": "Orion Warfarin",
            "ingredient": "warfarin sodium",
            "strength": "3 mg",
            "language": "en",
            "challenge_med_name": "Orion Warfarin",
            "challenge_med_ingredient": "warfarin",
            "challenge_med_strength": "3 mg",
            "challenge_allergies": ["lactose"],
            "challenge_avoid": ["anticoagulants"],
        }
        sc_excip = v3_gen.heldout_challenge_scenarios(med_row, excip_spec)
        self.assertEqual(len(sc_excip), 1)
        self.assertEqual(sc_excip[0][0], "heldout_excipient_or_avoid")
        self.assertEqual(sc_excip[0][1]["meds"][-1]["id"], "m_same")
        self.assertEqual(sc_excip[0][1]["allergies"], ["lactose"])
        self.assertEqual(sc_excip[0][1]["avoid"], ["anticoagulants"])

        empty_med_spec = dict(excip_spec, challenge_allergies=[], challenge_avoid=[])
        self.assertEqual(v3_gen.heldout_challenge_scenarios(med_row, empty_med_spec), [])

        food_sc = v3_gen.heldout_challenge_scenarios(
            {"kind": "food"},
            {"challenge_allergies": ["tree_nuts", "sulphites"]},
        )
        self.assertEqual(len(food_sc), 1)
        self.assertEqual(food_sc[0][0], "heldout_nordic_allergen_or_synonym")
        self.assertEqual(food_sc[0][1]["allergies"], ["tree nuts", "sulphites"])

    def test_landed_v3_results_and_heldout_safety_schema(self) -> None:
        v3_res_path = REPO_ROOT / "eval" / "results" / "v3_results.json"
        v3_saf_path = REPO_ROOT / "eval" / "results" / "v3_heldout_safety.json"
        self.assertTrue(v3_res_path.is_file())
        self.assertTrue(v3_saf_path.is_file())

        v3_res = json.loads(v3_res_path.read_text(encoding="utf-8"))
        v3_saf = json.loads(v3_saf_path.read_text(encoding="utf-8"))

        self.assertEqual(v3_res["version"], "v3")
        self.assertEqual(v3_res["conf_threshold"], 0.8)
        ds = v3_res["synthetic"]["dataset"]
        self.assertEqual(ds["overlap_with_ws1_redteam_specs"], 0)
        self.assertEqual(ds["overlap_with_v1_specs"], 0)
        n_imgs = v3_res["synthetic"]["images_scored"]
        self.assertEqual(n_imgs, 1060)
        self.assertEqual(ds["images_scored"], n_imgs)
        self.assertEqual(sum(ds["by_deg"].values()), n_imgs)
        self.assertEqual(sum(ds["by_kind"].values()), n_imgs)
        self.assertEqual(sum(ds["by_package_group"].values()), n_imgs)
        expected_groups = {pkg for _, pkg, _ in v3_gen.V3_THEMES}
        self.assertEqual(set(ds["by_package_group"].keys()), expected_groups)
        for ledger_key in v3_res["ledger"]:
            self.assertNotIn("gemini-4-carbon", ledger_key)

        self.assertEqual(v3_saf["version"], "v3_heldout_safety")
        self.assertEqual(v3_saf["images_scored"], n_imgs)
        self.assertEqual(v3_saf["baseline_safety_ts_commit"], "1d395b3")
        for split_key in ("standard_eval_scenarios", "extended_with_heldout_clinical_challenges"):
            split = v3_saf[split_key]
            cur = split["merged_main_safety_ts"]
            old = split["pre_ws1_safety_ts_1d395b3"]
            self.assertEqual(cur["n"], old["n"])
            self.assertGreater(cur["n"], 0)
            self.assertLess(cur["unsafe_k"], old["unsafe_k"])

        self.assertIsNone(common._client)


class TestNormalizeAndV3SchemaHygiene(unittest.TestCase):
    def test_zero_comments_and_zero_dashes_in_test_file(self) -> None:
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, src)
        self.assertNotIn(SLASH2, src)
        self.assertNotIn(EM_DASH, src)
        self.assertNotIn(EN_DASH, src)


if __name__ == "__main__":
    unittest.main()
