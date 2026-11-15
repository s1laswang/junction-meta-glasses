from __future__ import annotations

import json
import os
import pathlib
import random
import shutil
import subprocess
import sys
import unittest
from typing import Any

from PIL import Image, ImageDraw

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
sys.dont_write_bytecode = True
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import degrade
import normalize
import safety

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)


def make_field(val: Any, conf: float = 0.95) -> dict[str, Any]:
    return {"value": val, "confidence": conf}


def make_read(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "medication",
        "product": make_field(None, 0.0),
        "ingredient": make_field(None, 0.0),
        "strength": make_field(None, 0.0),
        "dosing": make_field(None, 0.0),
        "expiry": make_field("2027-08", 0.95),
        "allergens": make_field(None, 0.0),
        "barcode": make_field(None, 0.0),
        "readability": 0.92,
    }
    base.update(overrides)
    return base


class TestNormalizeOffline(unittest.TestCase):
    def test_eq_strength_units_and_decimals(self) -> None:
        self.assertTrue(normalize.eq_strength("2,5 mg", "2.5 mg"))
        self.assertTrue(normalize.eq_strength("500 mcg", "500 mikrog"))
        self.assertTrue(normalize.eq_strength("500 mcg", "500 \u00b5g"))
        self.assertTrue(normalize.eq_strength("500 mcg (0.5 mg)", "0.5 mg"))
        self.assertFalse(normalize.eq_strength("500 mcg", "0.5 mg"))
        self.assertFalse(normalize.eq_strength("2.5 mg", "25 mg"))
        self.assertFalse(normalize.eq_strength("75 \u00b5g", "75 mg"))
        self.assertTrue(normalize.eq_strength("160/4.5 mikrog", "160 mcg / 4.5 mcg"))
        self.assertTrue(normalize.eq_strength("75 \u00b5g (3000 IU)", "75 \u00b5g"))
        self.assertFalse(normalize.eq_strength_strict("75 \u00b5g (3000 IU)", "75 \u00b5g"))

    def test_eq_ingredient_and_product(self) -> None:
        self.assertTrue(normalize.eq_ingredient("levothyroxine sodium", "levothyroxine"))
        self.assertTrue(normalize.eq_ingredient("amlodipine besilate", "amlodipine"))
        self.assertTrue(normalize.eq_ingredient("amoxicillin + clavulanic acid", "amoxicillin, clavulanic acid"))
        self.assertFalse(normalize.eq_ingredient("amlodipine", "metformin"))
        self.assertTrue(normalize.eq_product("Norvasc 5 mg 30 tabl", "Norvasc"))
        self.assertTrue(normalize.eq_product("Thyroxin 100 mikrog", "Thyroxin"))
        self.assertFalse(normalize.eq_product("Burana 400 mg", "Panadol 500 mg"))

    def test_canon_allergens_and_peanut_disambiguation(self) -> None:
        self.assertEqual(
            normalize.canon_allergens(["maap\u00e4hkin\u00e4", "kaura", "hera"]),
            {"peanut", "gluten", "milk"},
        )
        self.assertEqual(normalize.canon_allergens(["peanuts"]), {"peanut"})
        self.assertEqual(
            normalize.canon_allergens(["peanuts", "hasselp\u00e4hkin\u00e4"]),
            {"peanut", "tree_nuts"},
        )

    def test_norm_date_and_eq_expiry(self) -> None:
        self.assertEqual(normalize.norm_date("2027-08"), (2027, 8, None))
        self.assertEqual(normalize.norm_date("2027-08-15"), (2027, 8, 15))
        self.assertEqual(normalize.norm_date("15.08.2027"), (2027, 8, 15))
        self.assertEqual(normalize.norm_date("08/2027"), (2027, 8, None))
        self.assertEqual(normalize.norm_date("Nov 2027"), (2027, 11, None))
        self.assertIsNone(normalize.norm_date(""))
        self.assertTrue(normalize.eq_expiry("2027-08", "2027-08-31"))
        self.assertFalse(normalize.eq_expiry("2027-08", "2027-09"))


class TestSafetyPortAndBridgeOffline(unittest.TestCase):
    def setUp(self) -> None:
        self.profile: dict[str, Any] = {
            "meds": [
                {"id": "aml", "name": "Norvasc", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
                {"id": "levo", "name": "Thyroxin", "ingredient": "levothyroxine", "strength": "500 mcg", "schedule": ["morning"]},
            ],
            "allergies": ["peanut", "tree_nuts"],
            "avoid": ["NSAIDs"],
            "doseLog": [],
            "lang": "en",
        }

    def test_confidence_gate_and_verdict_levels(self) -> None:
        low_conf = make_read(ingredient=make_field("amlodipine", 0.95), strength=make_field("5 mg", 0.79))
        v_low = safety.verdict(low_conf, self.profile, today=(2026, 11, 14))
        self.assertEqual(v_low["level"], "unsure")

        ok_conf = make_read(ingredient=make_field("amlodipine", 0.95), strength=make_field("5 mg", 0.80))
        v_ok = safety.verdict(ok_conf, self.profile, today=(2026, 11, 14))
        self.assertEqual(v_ok["level"], "match")
        self.assertEqual(v_ok["matchedMedId"], "aml")

        avoid_read = make_read(ingredient=make_field("ibuprofen", 0.95), strength=make_field("400 mg", 0.95))
        v_avoid = safety.verdict(avoid_read, self.profile, today=(2026, 11, 14))
        self.assertEqual(v_avoid["level"], "warning")

        expired_read = make_read(
            ingredient=make_field("amlodipine", 0.95),
            strength=make_field("5 mg", 0.95),
            expiry=make_field("2026-10", 0.95),
        )
        v_exp = safety.verdict(expired_read, self.profile, today=(2026, 11, 14))
        self.assertEqual(v_exp["level"], "warning")
        self.assertIn("expired", v_exp["reasons"])

        food_warn = make_read(
            kind="food",
            product=make_field("Snack bar", 0.95),
            allergens=make_field(["maap\u00e4hkin\u00e4"], 0.95),
        )
        v_food = safety.verdict(food_warn, self.profile, today=(2026, 11, 14))
        self.assertEqual(v_food["level"], "warning")

        unreadable = make_read(kind="unreadable", readability=0.1)
        self.assertEqual(safety.verdict(unreadable, self.profile)["level"], "unsure")

    def test_ts_bridge_cross_unit_500mcg_equals_0_5mg(self) -> None:
        node_bin = shutil.which("node") or "/usr/local/bin/node"
        env = dict(os.environ, HOLDUP_SAFETY_TS=str(REPO_ROOT / "server" / "src" / "safety.ts"))
        parent_nm = REPO_ROOT.parent / "node_modules"
        if parent_nm.is_dir():
            existing_np = env.get("NODE_PATH", "")
            env["NODE_PATH"] = f"{parent_nm}:{existing_np}" if existing_np else str(parent_nm)
        payload = {
            "read": make_read(ingredient=make_field("levothyroxine", 0.96), strength=make_field("0.5 mg", 0.95)),
            "profile": self.profile,
            "now": "2026-11-14T08:00:00+02:00",
        }
        proc = subprocess.run(
            [node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")],
            input=json.dumps(payload) + "\n",
            text=True,
            capture_output=True,
            cwd=str(REPO_ROOT),
            env=env,
            timeout=30,
            check=True,
        )
        out = json.loads(proc.stdout.strip())
        self.assertEqual(out["level"], "match")
        self.assertEqual(out["matchedMedId"], "levo")
        self.assertNotIn("crossCheck", out)


class TestDegradeOffline(unittest.TestCase):
    def test_apply_all_six_degradations_in_memory(self) -> None:
        self.assertEqual(
            set(degrade.DEGS),
            {"motion_blur", "defocus", "rotation", "crop", "glare", "low_light"},
        )
        im = Image.new("RGB", (128, 128), (225, 228, 234))
        draw = ImageDraw.Draw(im)
        draw.rectangle((18, 18, 110, 110), fill=(250, 250, 252), outline=(40, 50, 60), width=2)
        draw.rectangle((48, 50, 80, 60), fill=(20, 80, 140))

        base_gt: dict[str, dict[str, Any]] = {
            "product": {"value": "Norvasc", "status": "visible", "box": [150, 150, 350, 850], "lines": 1},
            "strength": {"value": "5 mg", "status": "visible", "box": [400, 400, 460, 600], "lines": 1},
            "dosing": {"value": "1 tablet daily", "status": "visible", "box": [600, 200, 640, 800], "lines": 2},
            "expiry": {"value": "2027-08", "status": "visible", "box": [700, 200, 740, 500], "lines": 1},
            "allergens": {"value": None, "status": "hidden", "box": None, "lines": 0},
            "barcode": {"value": "64321", "status": "excluded", "box": [800, 200, 900, 800], "lines": 1},
        }

        for deg in degrade.DEGS:
            with self.subTest(deg=deg):
                out_im, out_gt, meta = degrade.apply(im, base_gt, deg, 3, random.Random(42))
                self.assertIsInstance(out_im, Image.Image)
                self.assertEqual(out_im.mode, "RGB")
                self.assertIsInstance(meta, dict)
                self.assertTrue(len(meta) >= 1)
                self.assertEqual(base_gt["strength"]["status"], "visible")
                self.assertEqual(base_gt["dosing"]["status"], "visible")
                self.assertEqual(out_gt["barcode"]["status"], "excluded")
                downgraded = [
                    k for k in ("product", "strength", "dosing") if out_gt[k]["status"] in ("partial", "hidden")
                ]
                self.assertTrue(len(downgraded) >= 1, f"{deg} did not downgrade any visible field: {out_gt}")
                if deg == "crop":
                    self.assertTrue(out_im.width < im.width or out_im.height < im.height)
                else:
                    self.assertEqual(out_im.size, im.size)
                if deg == "glare":
                    self.assertEqual(out_gt["strength"]["status"], "hidden")
                    self.assertEqual(meta.get("target"), "strength")


class TestOfflineScriptHygiene(unittest.TestCase):
    def test_self_and_bridge_hygiene(self) -> None:
        self_src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_src)
        self.assertNotIn(SLASH2, self_src)
        self.assertNotIn(EM_DASH, self_src)
        self.assertNotIn(EN_DASH, self_src)
        bridge_src = (EVAL_DIR / "safety_bridge.mts").read_text(encoding="utf-8")
        self.assertNotIn(SLASH2, bridge_src)
        self.assertNotIn(EM_DASH, bridge_src)
        self.assertNotIn(EN_DASH, bridge_src)


if __name__ == "__main__":
    unittest.main()
