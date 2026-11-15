from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import os
import pathlib
import random
import socket
import sys
import tempfile
import unittest
import warnings
from typing import Any
from unittest import mock

from PIL import Image, ImageDraw

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
sys.dont_write_bytecode = True
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import common
import degrade
import gen_images
import run_eval

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
TRIPLE_DQ = chr(34) * 3
TRIPLE_SQ = chr(39) * 3
BACKTICK3 = chr(96) * 3
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
STATUS_RANK = {"visible": 0, "partial": 1, "hidden": 2}


def collect_schema_keys(node: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(node, dict):
        for k, v in node.items():
            found.add(str(k))
            found.update(collect_schema_keys(v))
    elif isinstance(node, list):
        for item in node:
            found.update(collect_schema_keys(item))
    return found


class OfflineAuditBase(unittest.TestCase):
    def setUp(self) -> None:
        p_env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False)
        p_conn = mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden"))
        p_sock = mock.patch.object(socket, "socket", side_effect=AssertionError("socket forbidden"))
        p_cli = mock.patch.object(common, "client", side_effect=AssertionError("gemini client forbidden"))
        for patcher in (p_env, p_conn, p_sock, p_cli):
            patcher.start()
            self.addCleanup(patcher.stop)


class TestRunEvalOfflineInvariants(OfflineAuditBase):
    def test_load_prompt_schema_and_inline_refs(self) -> None:
        raw_schema = json.loads((REPO_ROOT / "shared" / "label_schema.json").read_text(encoding="utf-8"))
        raw_keys = collect_schema_keys(raw_schema)
        self.assertIn("$ref", raw_keys)
        self.assertIn("$defs", raw_keys)
        self.assertIn("$comment", raw_keys)

        with mock.patch.object(run_eval, "SNAPSHOT", None):
            prompt, schema, src, prompt_hash = run_eval.load_prompt_schema()

        self.assertEqual(src, "shared")
        self.assertEqual(prompt_hash, "814770315c42")
        self.assertEqual(prompt, (REPO_ROOT / "shared" / "verify_prompt.md").read_text(encoding="utf-8"))

        inlined_keys = collect_schema_keys(schema)
        self.assertNotIn("$ref", inlined_keys)
        self.assertNotIn("$defs", inlined_keys)
        self.assertNotIn("$comment", inlined_keys)

        for field_name in ("product", "ingredient", "strength", "dosing", "expiry", "barcode"):
            f_schema = schema["properties"][field_name]
            self.assertEqual(f_schema["type"], "object")
            self.assertEqual(f_schema["required"], ["value", "confidence"])
            self.assertEqual(f_schema["properties"]["value"]["type"], ["string", "null"])

        custom_schema = {
            "$comment": "top note",
            "type": "object",
            "properties": {
                "single": {"$ref": f"{HASH_CHAR}/$defs/leaf"},
                "items": {"type": "array", "items": [{"$ref": f"{HASH_CHAR}/$defs/leaf"}]},
            },
            "$defs": {
                "leaf": {
                    "$comment": "inner note",
                    "type": "string",
                }
            },
        }
        resolved = run_eval.inline_refs(custom_schema)
        self.assertEqual(
            resolved,
            {
                "type": "object",
                "properties": {
                    "single": {"type": "string"},
                    "items": {"type": "array", "items": [{"type": "string"}]},
                },
            },
        )

        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = pathlib.Path(tmp)
            snap = tmp_root / "snap"
            (snap / "shared").mkdir(parents=True)
            (snap / "SHA").write_text("abcdef1234567890\n", encoding="utf-8")
            (snap / "shared" / "verify_prompt.md").write_text("Snap prompt", encoding="utf-8")
            (snap / "shared" / "label_schema.json").write_text(
                json.dumps({"$comment": "drop", "type": "object", "properties": {}}),
                encoding="utf-8",
            )
            with (
                mock.patch.object(run_eval, "SHARED", tmp_root / "missing_shared"),
                mock.patch.object(run_eval, "SNAPSHOT", snap),
            ):
                s_prompt, s_schema, s_src, s_hash = run_eval.load_prompt_schema()
            self.assertEqual(s_prompt, "Snap prompt")
            self.assertEqual(s_schema, {"type": "object", "properties": {}})
            self.assertEqual(s_src, "feat/server@abcdef12")
            self.assertEqual(len(s_hash), 12)

            (snap / "SHA").unlink()
            with (
                mock.patch.object(run_eval, "SHARED", tmp_root / "missing_shared"),
                mock.patch.object(run_eval, "SNAPSHOT", snap),
            ):
                _, _, snap_no_sha_src, _ = run_eval.load_prompt_schema()
            self.assertEqual(snap_no_sha_src, "snapshot")

            with (
                mock.patch.object(run_eval, "SHARED", tmp_root / "missing_shared"),
                mock.patch.object(run_eval, "SNAPSHOT", None),
            ):
                d_prompt, d_schema, d_src, d_hash = run_eval.load_prompt_schema()
            self.assertEqual(d_src, "eval/draft")
            self.assertTrue(len(d_prompt) > 20)
            self.assertIn("properties", d_schema)
            self.assertEqual(len(d_hash), 12)

    def test_to_label_read_coercion(self) -> None:
        long_guidance = "  " + ("Move the package slightly closer to read the dose. " * 4) + "  "
        coerced = run_eval.to_label_read(
            {
                "kind": "medication",
                "product": {"value": "Norvasc", "confidence": 1.6},
                "ingredient": {"value": "amlodipine", "confidence": -0.4},
                "strength": {"value": None, "confidence": 0.95},
                "dosing": {"value": "   ", "confidence": 0.88},
                "expiry": {"value": "08/2027", "confidence": 0.92},
                "allergens": {"value": [123], "confidence": 0.85},
                "barcode": {"value": "6412345", "confidence": "not_a_number"},
                "readability": 1.4,
                "guidance": long_guidance,
            }
        )
        self.assertEqual(coerced["kind"], "medication")
        self.assertEqual(coerced["product"], {"value": "Norvasc", "confidence": 1.0})
        self.assertEqual(coerced["ingredient"], {"value": "amlodipine", "confidence": 0.0})
        self.assertEqual(coerced["strength"], {"value": None, "confidence": 0.3})
        self.assertEqual(coerced["dosing"], {"value": None, "confidence": 0.3})
        self.assertEqual(coerced["expiry"], {"value": "08/2027", "confidence": 0.5})
        self.assertEqual(coerced["allergens"], {"value": None, "confidence": 0.3})
        self.assertEqual(coerced["barcode"], {"value": "6412345", "confidence": 0.0})
        self.assertEqual(coerced["readability"], 1.0)
        self.assertEqual(len(coerced["guidance"]), 120)
        self.assertEqual(coerced["guidance"], long_guidance.strip()[:120])

        iso_month = run_eval.to_label_read(
            {
                "kind": "food",
                "expiry": {"value": "2027-08", "confidence": 0.96},
                "allergens": {"value": [], "confidence": 0.91},
                "strength": {"value": None, "confidence": 0.12},
                "readability": -0.5,
                "guidance": "   ",
            }
        )
        self.assertEqual(iso_month["kind"], "food")
        self.assertEqual(iso_month["expiry"], {"value": "2027-08", "confidence": 0.96})
        self.assertEqual(iso_month["allergens"], {"value": [], "confidence": 0.91})
        self.assertEqual(iso_month["strength"], {"value": None, "confidence": 0.12})
        self.assertEqual(iso_month["readability"], 0.0)
        self.assertNotIn("guidance", iso_month)

        iso_day = run_eval.to_label_read({"kind": "other", "expiry": {"value": "2027-08-31", "confidence": 0.94}})
        self.assertEqual(iso_day["kind"], "other")
        self.assertEqual(iso_day["expiry"], {"value": "2027-08-31", "confidence": 0.94})

        non_iso_low = run_eval.to_label_read({"kind": "invalid_kind", "expiry": {"value": "AUG 27", "confidence": 0.25}})
        self.assertEqual(non_iso_low["kind"], "unreadable")
        self.assertEqual(non_iso_low["expiry"], {"value": "AUG 27", "confidence": 0.25})

        non_dict = run_eval.to_label_read(["not", "a", "dict"])
        self.assertEqual(non_dict["kind"], "unreadable")
        self.assertEqual(non_dict["readability"], 0.0)

    def test_real_rows_csv_loader_in_temp_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            real_dir = pathlib.Path(tmp)
            with mock.patch.object(run_eval, "REAL", real_dir):
                self.assertEqual(run_eval.real_rows(), [])

                for fn in (
                    "example.jpg",
                    "med1.jpg",
                    "food_nordic.jpg",
                    "food_none.jpg",
                    "food_dash.jpg",
                    "food_brackets.jpg",
                    "food_empty.jpg",
                    "other1.jpg",
                ):
                    (real_dir / fn).write_bytes(b"jpg")

                fieldnames = ["file", "kind", "product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode", "notes"]
                csv_rows = [
                    {"file": "example.jpg", "kind": "medication", "product": "SkipExample", "strength": "5 mg"},
                    {"file": "   ", "kind": "medication", "product": "SkipBlank"},
                    {"file": "missing.jpg", "kind": "medication", "product": "SkipMissing"},
                    {
                        "file": "med1.jpg",
                        "kind": "medication",
                        "product": "Burana",
                        "ingredient": "ibuprofen",
                        "strength": "400 mg",
                        "dosing": "",
                        "expiry": "2027-11",
                        "allergens": "laktoosi",
                        "barcode": "6412345678905",
                        "notes": "front box",
                    },
                    {
                        "file": "food_nordic.jpg",
                        "kind": "food",
                        "product": "Saaristolaisleipa",
                        "expiry": "2026-12-24",
                        "allergens": "ruis; maap\u00e4hkin\u00e4, laktoosi; hasselp\u00e4hkin\u00e4",
                    },
                    {"file": "food_none.jpg", "kind": "food", "product": "Water", "allergens": "None"},
                    {"file": "food_dash.jpg", "kind": "food", "product": "Salt", "allergens": "-"},
                    {"file": "food_brackets.jpg", "kind": "food", "product": "Tea", "allergens": "[]"},
                    {"file": "food_empty.jpg", "kind": "food", "product": "Mystery", "allergens": ""},
                    {"file": "other1.jpg", "kind": "", "product": "Soap", "allergens": "milk"},
                ]
                with (real_dir / "labels.csv").open("w", encoding="utf-8", newline="") as fh:
                    writer = csv.DictWriter(fh, fieldnames=fieldnames)
                    writer.writeheader()
                    for r in csv_rows:
                        writer.writerow(r)

                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", ResourceWarning)
                    loaded = run_eval.real_rows()

            by_spec = {r["spec_id"]: r for r in loaded}
            self.assertEqual(
                list(by_spec.keys()),
                [
                    "med1.jpg",
                    "food_nordic.jpg",
                    "food_none.jpg",
                    "food_dash.jpg",
                    "food_brackets.jpg",
                    "food_empty.jpg",
                    "other1.jpg",
                ],
            )

            med = by_spec["med1.jpg"]
            self.assertEqual(med["img_id"], "real/med1.jpg")
            self.assertEqual(med["deg"], "real")
            self.assertEqual(med["sev"], 0)
            self.assertEqual(med["kind"], "medication")
            self.assertEqual(med["notes"], "front box")
            self.assertEqual(med["gt"]["product"], {"value": "Burana", "status": "visible"})
            self.assertEqual(med["gt"]["strength"], {"value": "400 mg", "status": "visible"})
            self.assertEqual(med["gt"]["dosing"], {"value": None, "status": "excluded"})
            self.assertEqual(med["gt"]["allergens"], {"value": None, "status": "excluded"})

            nordic = by_spec["food_nordic.jpg"]
            self.assertEqual(
                nordic["gt"]["allergens"],
                {"value": ["gluten", "milk", "peanut", "tree_nuts"], "status": "visible"},
            )
            self.assertEqual(nordic["gt"]["strength"], {"value": None, "status": "excluded"})

            for empty_fn in ("food_none.jpg", "food_dash.jpg", "food_brackets.jpg"):
                self.assertEqual(by_spec[empty_fn]["gt"]["allergens"], {"value": [], "status": "visible"})

            self.assertEqual(by_spec["food_empty.jpg"]["gt"]["allergens"], {"value": None, "status": "excluded"})
            self.assertEqual(by_spec["other1.jpg"]["kind"], "other")
            self.assertEqual(by_spec["other1.jpg"]["gt"]["allergens"], {"value": None, "status": "excluded"})

    def test_gt_value_and_pred_field(self) -> None:
        food_partial_may = {
            "kind": "food",
            "gt": {
                "allergens": {"value": ["milk"], "status": "visible"},
                "may_contain": {"value": ["peanut", "tree_nuts"], "status": "partial"},
            },
        }
        self.assertEqual(run_eval.gt_value(food_partial_may, "allergens"), (["milk", "peanut", "tree_nuts"], "partial"))

        food_hidden_may = {
            "kind": "food",
            "gt": {
                "allergens": {"value": ["gluten"], "status": "visible"},
                "may_contain": {"value": ["sesame"], "status": "hidden"},
            },
        }
        self.assertEqual(run_eval.gt_value(food_hidden_may, "allergens"), (["gluten", "sesame"], "partial"))

        food_vis_may = {
            "kind": "food",
            "gt": {
                "allergens": {"value": ["gluten"], "status": "visible"},
                "may_contain": {"value": ["sesame"], "status": "visible"},
            },
        }
        self.assertEqual(run_eval.gt_value(food_vis_may, "allergens"), (["gluten", "sesame"], "visible"))

        food_empty_may = {
            "kind": "food",
            "gt": {
                "allergens": {"value": ["egg"], "status": "visible"},
                "may_contain": {"value": [], "status": "hidden"},
            },
        }
        self.assertEqual(run_eval.gt_value(food_empty_may, "allergens"), (["egg"], "visible"))

        med_with_may = {
            "kind": "medication",
            "gt": {
                "allergens": {"value": ["milk"], "status": "visible"},
                "may_contain": {"value": ["peanut"], "status": "visible"},
            },
        }
        self.assertEqual(run_eval.gt_value(med_with_may, "allergens"), (None, "excluded"))
        self.assertEqual(run_eval.gt_value({"kind": "medication", "gt": {}}, "dosing"), (None, "excluded"))

        for tok in ("null", " NULL ", "none", "None", "unknown", "UNKNOWN", "n/a", " N/A ", ""):
            with self.subTest(tok=tok):
                self.assertEqual(run_eval.pred_field({"strength": {"value": tok, "confidence": 0.75}}, "strength"), (None, 0.75))

        self.assertEqual(run_eval.pred_field(None, "strength"), (None, 0.0))
        self.assertEqual(run_eval.pred_field({"strength": "bad"}, "strength"), (None, 0.0))
        self.assertEqual(run_eval.pred_field({"strength": {"value": "5 mg", "confidence": 0.9}}, "strength"), ("5 mg", 0.9))

    def test_classify_and_agg_invariants(self) -> None:
        food_row = {
            "kind": "food",
            "gt": {
                "product": {"value": "Oat Bar", "status": "visible"},
                "ingredient": {"value": "oats", "status": "visible"},
                "strength": {"value": "10 g", "status": "visible"},
                "dosing": {"value": "1 bar", "status": "visible"},
                "allergens": {"value": [], "status": "visible"},
                "barcode": {"value": "123", "status": "excluded"},
            },
        }
        food_pred = {
            "product": {"value": "Oat Bar", "confidence": 0.95},
            "ingredient": {"value": "oats", "confidence": 0.95},
            "strength": {"value": "10 g", "confidence": 0.95},
            "dosing": {"value": "1 bar", "confidence": 0.95},
            "allergens": {"value": [], "confidence": 0.92},
            "barcode": {"value": "123", "confidence": 0.99},
        }
        for skipped in ("ingredient", "strength", "dosing", "barcode"):
            self.assertIsNone(run_eval.classify(food_row, food_pred, skipped))
        self.assertEqual(
            run_eval.classify(food_row, food_pred, "allergens"),
            {"status": "visible", "outcome": "correct", "conf": 0.92},
        )

        med_row = {
            "kind": "medication",
            "gt": {
                "strength": {"value": "2,5 mg", "status": "visible"},
                "dosing": {"value": "", "status": "visible"},
                "allergens": {"value": ["milk"], "status": "visible"},
            },
        }
        self.assertIsNone(run_eval.classify(med_row, {"allergens": {"value": ["milk"], "confidence": 0.9}}, "allergens"))
        self.assertEqual(
            run_eval.classify(med_row, {"strength": {"value": "2.5 mg", "confidence": 0.91}}, "strength"),
            {"status": "visible", "outcome": "correct", "conf": 0.91},
        )
        self.assertEqual(
            run_eval.classify(med_row, {"strength": {"value": "25 mg", "confidence": 0.85}}, "strength"),
            {"status": "visible", "outcome": "wrong", "conf": 0.85},
        )
        self.assertEqual(
            run_eval.classify(med_row, {"strength": {"value": "unknown", "confidence": 0.2}}, "strength"),
            {"status": "visible", "outcome": "abstain", "conf": 0.2},
        )
        self.assertEqual(
            run_eval.classify(med_row, {"dosing": {"value": None, "confidence": 0.1}}, "dosing"),
            {"status": "hidden", "outcome": "abstain", "conf": 0.1},
        )
        self.assertEqual(
            run_eval.classify(med_row, {"dosing": {"value": "1 daily", "confidence": 0.88}}, "dosing"),
            {"status": "hidden", "outcome": "wrong", "conf": 0.88},
        )

        items = [
            {"status": "visible", "outcome": "correct", "conf": 0.95},
            {"status": "visible", "outcome": "correct", "conf": 0.70},
            {"status": "visible", "outcome": "abstain", "conf": 0.20},
            {"status": "visible", "outcome": "wrong", "conf": 0.85},
            {"status": "partial", "outcome": "correct", "conf": 0.82},
            {"status": "partial", "outcome": "abstain", "conf": 0.10},
            {"status": "partial", "outcome": "wrong", "conf": 0.60},
            {"status": "hidden", "outcome": "abstain", "conf": 0.0},
            {"status": "hidden", "outcome": "abstain", "conf": 0.25},
            {"status": "hidden", "outcome": "wrong", "conf": 0.90},
        ]
        summary = run_eval.agg(items)
        self.assertEqual(summary["n"], 10)
        self.assertEqual(summary["n_visible"], 4)
        self.assertEqual(summary["n_partial"], 3)
        self.assertEqual(summary["n_hidden"], 3)
        self.assertEqual(summary["acc_visible"], 50.0)
        self.assertEqual(summary["abstain_visible"], 25.0)
        self.assertEqual(summary["wrong_visible"], 25.0)
        self.assertEqual(summary["acc_partial"], 33.3)
        self.assertEqual(summary["abstain_partial"], 33.3)
        self.assertEqual(summary["wrong_partial"], 33.3)
        self.assertEqual(summary["abstain_hidden"], 66.7)
        self.assertEqual(summary["guess_hidden"], 33.3)
        self.assertEqual(summary["wrong_hidden"], 33.3)
        self.assertEqual(summary["precision_answered"], 50.0)
        self.assertEqual(summary["confident_wrong"], 2)
        self.assertEqual(summary["confident_wrong_rate"], 20.0)
        self.assertEqual(summary["confident_wrong_of_confident"], 50.0)
        self.assertEqual(
            summary["k"],
            {
                "correct_visible": 2,
                "abstain_visible": 1,
                "wrong_visible": 1,
                "abstain_hidden": 2,
                "wrong_hidden": 1,
                "answered": 6,
                "correct_answered": 3,
                "confident": 4,
                "wrong_any": 3,
            },
        )

        empty_agg = run_eval.agg([])
        self.assertEqual(empty_agg["n"], 0)
        self.assertIsNone(empty_agg["acc_visible"])
        self.assertIsNone(empty_agg["precision_answered"])

    def test_wilson_calibration_threshold_sweep_and_other_strength(self) -> None:
        self.assertIsNone(run_eval.wilson(0, 0))
        self.assertEqual(run_eval.wilson(0, 754), (0.0, 0.51))
        self.assertEqual(run_eval.wilson(754, 754), (99.49, 100.0))
        lo, hi = run_eval.wilson(50, 100)
        self.assertLess(lo, 50.0)
        self.assertGreater(hi, 50.0)

        cal_empty = run_eval.calibration([{"status": "hidden", "outcome": "abstain", "conf": 0.2}])
        self.assertEqual(cal_empty["n_answered"], 0)
        self.assertIsNone(cal_empty["ece"])
        self.assertIsNone(cal_empty["ece_ci"])
        self.assertEqual(len(cal_empty["bins"]), 7)
        self.assertEqual(cal_empty["bins"][0]["bin"], "[0.00,0.50)")
        self.assertEqual(cal_empty["bins"][-1]["bin"], "[0.95,1.00]")

        overconf = [{"status": "visible", "outcome": "wrong", "conf": 0.90} for _ in range(10)]
        cal_over = run_eval.calibration(overconf)
        self.assertEqual(cal_over["n_answered"], 10)
        self.assertEqual(cal_over["ece"], 0.9)
        self.assertEqual(cal_over["ece_ci"], (0.9, 0.9))

        well_cal = (
            [{"status": "visible", "outcome": "correct", "conf": 0.80} for _ in range(8)]
            + [{"status": "visible", "outcome": "wrong", "conf": 0.80} for _ in range(2)]
        )
        cal_good = run_eval.calibration(well_cal)
        self.assertEqual(cal_good["n_answered"], 10)
        self.assertEqual(cal_good["ece"], 0.0)
        bin_080 = [b for b in cal_good["bins"] if b["bin"] == "[0.80,0.90)"][0]
        self.assertEqual(bin_080["n"], 10)
        self.assertEqual(bin_080["k"], 8)
        self.assertEqual(bin_080["accuracy"], 80.0)

        sweep_items = [
            {"status": "visible", "outcome": "correct", "conf": 0.96},
            {"status": "visible", "outcome": "correct", "conf": 0.82},
            {"status": "visible", "outcome": "wrong", "conf": 0.75},
            {"status": "visible", "outcome": "abstain", "conf": 0.20},
            {"status": "hidden", "outcome": "wrong", "conf": 0.91},
        ]
        sweep = run_eval.threshold_sweep(sweep_items)
        self.assertEqual([row["t"] for row in sweep], [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95])
        at_070 = [row for row in sweep if row["t"] == 0.7][0]
        at_080 = [row for row in sweep if row["t"] == 0.8][0]
        at_095 = [row for row in sweep if row["t"] == 0.95][0]
        self.assertEqual(at_070["trusted"], 4)
        self.assertEqual(at_070["trusted_wrong"], 2)
        self.assertEqual(at_070["coverage_visible"], 50.0)
        self.assertEqual(at_080["trusted"], 3)
        self.assertEqual(at_080["trusted_wrong"], 1)
        self.assertEqual(at_080["coverage_visible"], 50.0)
        self.assertEqual(at_095["trusted"], 1)
        self.assertEqual(at_095["trusted_wrong"], 0)
        self.assertEqual(at_095["coverage_visible"], 25.0)
        for prev_row, next_row in zip(sweep, sweep[1:]):
            self.assertGreaterEqual(prev_row["trusted"], next_row["trusted"])
            self.assertGreaterEqual(prev_row["trusted_wrong"], next_row["trusted_wrong"])
            self.assertGreaterEqual(prev_row["coverage_visible"], next_row["coverage_visible"])

        self.assertEqual(run_eval.other_strength("5 mg"), "10 mg")
        self.assertEqual(run_eval.other_strength("2,5 mg"), "5 mg")
        self.assertEqual(run_eval.other_strength("1.25 mg/ml"), "2.5 mg/ml")
        self.assertEqual(run_eval.other_strength("399 mg"), "798 mg")
        self.assertEqual(run_eval.other_strength("400 mg"), "200 mg")
        self.assertEqual(run_eval.other_strength("500 mikrog"), "250 mikrog")
        self.assertEqual(run_eval.other_strength("425 mg"), "212.5 mg")
        self.assertEqual(run_eval.other_strength(""), "999 mg")
        self.assertEqual(run_eval.other_strength("unreadable"), "999 mg")
        self.assertIsNone(run_eval.quantile([], 0.5))
        self.assertEqual(run_eval.quantile([2.0], 0.95), 2.0)
        self.assertEqual(run_eval.quantile([1.0, 2.0, 3.0, 4.0], 0.5), 2.5)

    def test_scenarios_gt_read_and_safety_summary_categories(self) -> None:
        med_furo_row = {
            "kind": "medication",
            "gt": {
                "product": {"value": "Furesis", "status": "visible"},
                "ingredient": {"value": "furosemide", "status": "visible"},
                "strength": {"value": "40 mg", "status": "partial"},
                "dosing": {"value": "1 tabl", "status": "hidden"},
                "expiry": {"value": "2027-08", "status": "visible"},
                "allergens": {"value": None, "status": "excluded"},
                "barcode": {"value": "64100", "status": "visible"},
            },
        }
        med_scens = dict(run_eval.scenarios(med_furo_row))
        self.assertEqual(
            list(med_scens.keys()),
            ["on_list_same_strength", "on_list_other_strength", "not_on_list"],
        )
        self.assertTrue(all(m["ingredient"] != "furosemide" for m in med_scens["not_on_list"]["meds"]))
        self.assertEqual(med_scens["on_list_other_strength"]["meds"][-1]["strength"], "80 mg")

        missing_st_row = {
            "kind": "medication",
            "gt": {
                "product": {"value": "Burana", "status": "visible"},
                "ingredient": {"value": "ibuprofen", "status": "visible"},
                "strength": {"value": None, "status": "hidden"},
            },
        }
        self.assertEqual(run_eval.scenarios(missing_st_row), [])

        world_med = run_eval.gt_read(med_furo_row, False)
        vis_med = run_eval.gt_read(med_furo_row, True)
        self.assertEqual(world_med["strength"], {"value": "40 mg", "confidence": 1.0})
        self.assertEqual(vis_med["strength"], {"value": None, "confidence": 0.0})
        self.assertEqual(world_med["dosing"], {"value": "1 tabl", "confidence": 1.0})
        self.assertEqual(vis_med["dosing"], {"value": None, "confidence": 0.0})
        self.assertEqual(world_med["allergens"], {"value": None, "confidence": 0.0})

        food_row = {
            "kind": "food",
            "gt": {
                "product": {"value": "Granola", "status": "visible"},
                "ingredient": {"value": None, "status": "excluded"},
                "strength": {"value": None, "status": "excluded"},
                "dosing": {"value": None, "status": "excluded"},
                "expiry": {"value": "2027-06", "status": "visible"},
                "allergens": {"value": ["tree_nuts"], "status": "visible"},
                "may_contain": {"value": ["peanut", "tree_nuts"], "status": "visible"},
                "barcode": {"value": None, "status": "excluded"},
            },
        }
        food_scens = dict(run_eval.scenarios(food_row))
        self.assertEqual(list(food_scens.keys()), ["allergic_to_contained", "allergic_to_absent"])
        self.assertEqual(food_scens["allergic_to_contained"]["allergies"], ["peanut"])
        self.assertEqual(food_scens["allergic_to_absent"]["allergies"], ["sesame"])

        world_food = run_eval.gt_read(food_row, False)
        self.assertEqual(
            world_food["allergens"],
            {"value": ["tree nuts", "may contain: peanut"], "confidence": 1.0},
        )

        recs = [
            {
                "img_id": "i1",
                "scenario": "on_list_same_strength",
                "world": "warning",
                "visible": "match",
                "pred": "match",
                "pred_reasons": ["matched med", "expiry not readable on side"],
                "world_reasons": ["expired 2025-01"],
            },
            {
                "img_id": "i2",
                "scenario": "allergic_to_contained",
                "world": "warning",
                "visible": "warning",
                "pred": "info",
                "pred_reasons": ["no listed allergens found"],
                "world_reasons": ["allergy: peanut"],
            },
            {
                "img_id": "i3",
                "scenario": "on_list_other_strength",
                "world": "warning",
                "visible": "warning",
                "pred": "match",
                "pred_reasons": ["matched"],
                "world_reasons": ["strength differs"],
            },
            {
                "img_id": "i4",
                "scenario": "not_on_list",
                "world": "warning",
                "visible": "warning",
                "pred": "match",
                "pred_reasons": ["matched"],
                "world_reasons": ["not on your list"],
            },
            {
                "img_id": "i5",
                "scenario": "not_on_list",
                "world": "warning",
                "visible": "warning",
                "pred": "info",
                "pred_reasons": ["info"],
                "world_reasons": ["on avoid list: NSAIDs"],
            },
            {
                "img_id": "i6",
                "scenario": "on_list_same_strength",
                "world": "warning",
                "visible": "warning",
                "pred": "match",
                "pred_reasons": ["matched"],
                "world_reasons": ["expired 2025-05"],
            },
            {
                "img_id": "i7",
                "scenario": "not_on_list",
                "world": "warning",
                "visible": "unsure",
                "pred": "info",
                "pred_reasons": ["info"],
                "world_reasons": ["custom hazard"],
            },
            {
                "img_id": "i8",
                "scenario": "on_list_same_strength",
                "world": "match",
                "visible": "unsure",
                "pred": "unsure",
                "pred_reasons": ["strength not read confidently"],
                "world_reasons": ["on list, strength matches"],
            },
        ]
        s_sum = run_eval.safety_summary(recs)
        self.assertEqual(s_sum["n"], 8)
        self.assertEqual(s_sum["expired_match_with_caveat"], 1)
        self.assertEqual(s_sum["unsafe_reassurance"], 6)
        self.assertEqual(
            s_sum["unsafe_by_category"],
            {
                "missed_allergen": 1,
                "wrong_strength_matched": 1,
                "not_on_list_matched": 1,
                "avoid_list_missed": 1,
                "expired_date_misread_or_unseen": 1,
                "other": 1,
            },
        )
        self.assertEqual(s_sum["false_match"], 4)
        self.assertEqual(s_sum["unsure_k"], 1)
        self.assertEqual(s_sum["correct_k"], 0)
        self.assertEqual(s_sum["agree_with_ideal_reader"], 25.0)

    def test_score_set_and_cmd_score_end_to_end_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            data_dir = tmp_path / "data"
            out_dir = tmp_path / "out"
            real_dir = tmp_path / "real"
            data_dir.mkdir()
            out_dir.mkdir()
            real_dir.mkdir()

            dataset_rows = [
                {
                    "img_id": "m1__clean_0",
                    "spec_id": "m1",
                    "kind": "medication",
                    "deg": "clean",
                    "sev": 0,
                    "gt": {
                        "product": {"value": "Thyroxin", "status": "visible"},
                        "ingredient": {"value": "levothyroxine", "status": "visible"},
                        "strength": {"value": "75 \u00b5g (3000 IU)", "status": "visible"},
                        "dosing": {"value": "1 tabl", "status": "visible"},
                        "expiry": {"value": "2027-08", "status": "visible"},
                        "allergens": {"value": None, "status": "excluded"},
                        "barcode": {"value": "64111", "status": "visible"},
                    },
                },
                {
                    "img_id": "f1__glare_2",
                    "spec_id": "f1",
                    "kind": "food",
                    "deg": "glare",
                    "sev": 2,
                    "gt": {
                        "product": {"value": "Pesto", "status": "visible"},
                        "ingredient": {"value": None, "status": "excluded"},
                        "strength": {"value": None, "status": "excluded"},
                        "dosing": {"value": None, "status": "excluded"},
                        "expiry": {"value": "2025-05", "status": "visible"},
                        "allergens": {"value": ["milk", "tree_nuts"], "status": "visible"},
                        "barcode": {"value": None, "status": "excluded"},
                    },
                },
                {
                    "img_id": "m2__err_0",
                    "spec_id": "m2",
                    "kind": "medication",
                    "deg": "clean",
                    "sev": 0,
                    "gt": {
                        "product": {"value": "Norvasc", "status": "visible"},
                        "ingredient": {"value": "amlodipine", "status": "visible"},
                        "strength": {"value": "5 mg", "status": "visible"},
                        "dosing": {"value": None, "status": "excluded"},
                        "expiry": {"value": "2027-10", "status": "visible"},
                        "allergens": {"value": None, "status": "excluded"},
                        "barcode": {"value": None, "status": "excluded"},
                    },
                },
            ]
            common.write_jsonl(data_dir / "dataset.jsonl", dataset_rows)
            common.write_jsonl(data_dir / "renders.jsonl", [{"id": "m1"}, {"id": "f1"}])
            common.write_jsonl(data_dir / "renders_dropped.jsonl", [{"id": "m_drop"}])

            p_hash = "test_hash_01"
            preds_rows = [
                {
                    "img_id": "m1__clean_0",
                    "prompt_hash": p_hash,
                    "latency_s": 1.2,
                    "pred": {
                        "kind": "medication",
                        "product": {"value": "Thyroxin", "confidence": 0.96},
                        "ingredient": {"value": "levothyroxine", "confidence": 0.95},
                        "strength": {"value": "75 \u00b5g", "confidence": 0.93},
                        "dosing": {"value": "1 tabl", "confidence": 0.90},
                        "expiry": {"value": "2027-08", "confidence": 0.92},
                        "allergens": {"value": None, "confidence": 0.0},
                        "barcode": {"value": "64111", "confidence": 0.98},
                        "readability": 0.94,
                    },
                },
                {
                    "img_id": "f1__glare_2",
                    "prompt_hash": p_hash,
                    "latency_s": 1.8,
                    "pred": {
                        "kind": "food",
                        "product": {"value": "Pesto", "confidence": 0.91},
                        "ingredient": {"value": None, "confidence": 0.0},
                        "strength": {"value": None, "confidence": 0.0},
                        "dosing": {"value": None, "confidence": 0.0},
                        "expiry": {"value": "2025-05", "confidence": 0.85},
                        "allergens": {"value": ["milk"], "confidence": 0.86},
                        "barcode": {"value": None, "confidence": 0.0},
                        "readability": 0.62,
                        "guidance": "Glare on allergen line",
                    },
                },
                {
                    "img_id": "m2__err_0",
                    "prompt_hash": p_hash,
                    "error": "simulated timeout",
                },
            ]
            common.write_jsonl(out_dir / "preds_synthetic.jsonl", preds_rows)
            common.write_jsonl(
                out_dir / "ledger.jsonl",
                [
                    {"feature": "eval.verify_label", "model": "gemini-3.8-flash", "ok": True, "in": 500, "out": 80, "thinking": 40},
                    {"feature": "eval.verify_label", "model": "gemini-3.8-flash", "ok": False, "in": None, "out": None, "thinking": None},
                ],
            )

            def fake_ts_bridge(cases: list[dict[str, Any]], ts_path: Any) -> list[dict[str, Any]]:
                return [run_eval.py_verdict(c["read"], c["profile"]) for c in cases]

            with (
                mock.patch.object(run_eval, "DATA", data_dir),
                mock.patch.object(run_eval, "OUT", out_dir),
                mock.patch.object(run_eval, "REAL", real_dir),
                mock.patch.dict(run_eval.SAFETY_IMPL, {"impl": None}),
                mock.patch.object(run_eval, "ts_verdicts", side_effect=fake_ts_bridge),
                mock.patch.object(run_eval, "log"),
            ):
                run_eval.cmd_score(argparse.Namespace(hash=p_hash))
                written = json.loads((out_dir / "results.json").read_text(encoding="utf-8"))

                mock_preds_map = {p["img_id"]: p for p in preds_rows}
                with mock.patch.object(run_eval, "ts_verdicts", return_value=None):
                    run_eval.SAFETY_IMPL["impl"] = None
                    fallback_recs = run_eval.run_safety(dataset_rows, mock_preds_map, None)
                    self.assertEqual(run_eval.SAFETY_IMPL["impl"], "python port (eval/safety.py)")
                    self.assertEqual(len(fallback_recs), 5)

            syn = written["synthetic"]
            self.assertEqual(syn["images_scored"], 2)
            self.assertEqual(syn["errors"], 1)
            self.assertEqual(syn["strength_incomplete"]["n"], 1)
            self.assertEqual(syn["allergen_recall"]["n_answered_visible"], 1)
            self.assertEqual(syn["allergen_recall"]["missed_any"], 1)
            self.assertEqual(syn["allergen_recall"]["missed_any_confident"], 1)
            self.assertEqual(syn["dataset"]["renders_kept"], 2)
            self.assertEqual(syn["dataset"]["renders_dropped"], 1)
            self.assertIn("server", syn["safety"])
            self.assertIn("variant A_food_partial_panel_unsure", syn["safety"])
            self.assertIn("variant B_expiry_trust_0.9", syn["safety"])
            self.assertIn("variant A+B", syn["safety"])
            self.assertEqual(
                written["ledger"]["eval.verify_label|gemini-3.8-flash"],
                {"calls": 2, "ok": 1, "in": 500, "out": 80, "thinking": 40},
            )


class TestCommittedV1Recomputability(OfflineAuditBase):
    def test_v1_paired_rows_med113_override_and_field_metrics(self) -> None:
        gt_path = EVAL_DIR / "results" / "v1" / "ground_truth.jsonl"
        preds_path = EVAL_DIR / "results" / "v1" / "preds_synthetic.jsonl"
        ov_path = EVAL_DIR / "gt_overrides.json"
        v1_res_path = EVAL_DIR / "results" / "v1_results.json"

        for p in (gt_path, preds_path, ov_path, v1_res_path):
            self.assertTrue(p.is_file(), str(p))

        raw_gt = common.read_jsonl(gt_path)
        raw_preds = common.read_jsonl(preds_path)
        overrides = json.loads(ov_path.read_text(encoding="utf-8"))
        v1_res = json.loads(v1_res_path.read_text(encoding="utf-8"))

        self.assertEqual(len(raw_gt), 1740)
        self.assertEqual(len(raw_preds), 1740)
        self.assertEqual(v1_res["prompt_src"], "shared")
        self.assertEqual(v1_res["prompt_hash"], "814770315c42")
        self.assertEqual(v1_res["conf_threshold"], 0.8)
        self.assertEqual(v1_res["synthetic"]["images_scored"], 1740)
        self.assertEqual(overrides["med113"]["strength"], "30 mg + 70 mg")

        med113_raw = [r for r in raw_gt if r["spec_id"] == "med113"]
        self.assertGreater(len(med113_raw), 0)
        self.assertEqual({r["gt"]["strength"]["value"] for r in med113_raw}, {"30 mg"})

        with tempfile.TemporaryDirectory() as tmp:
            tmp_data = pathlib.Path(tmp)
            os.symlink(gt_path, tmp_data / "dataset.jsonl")
            with mock.patch.object(run_eval, "DATA", tmp_data):
                rows = run_eval.synthetic_rows()

        self.assertEqual(len(rows), 1740)
        med113_overridden = [r for r in rows if r["spec_id"] == "med113"]
        self.assertEqual(len(med113_overridden), len(med113_raw))
        for r in med113_overridden:
            self.assertEqual(r["gt"]["strength"]["value"], "30 mg + 70 mg")
            self.assertTrue(r["gt"]["strength"].get("overridden"))

        preds_by_id: dict[str, dict[str, Any]] = {}
        for p in raw_preds:
            self.assertEqual(p.get("prompt_hash"), v1_res["prompt_hash"])
            self.assertFalse(p.get("error"))
            preds_by_id[p["img_id"]] = p

        self.assertEqual(len(preds_by_id), 1740)
        self.assertEqual({r["img_id"] for r in rows}, set(preds_by_id.keys()))

        med113_raw_cw = [
            c
            for r in med113_raw
            if (c := run_eval.classify(r, run_eval.to_label_read(preds_by_id[r["img_id"]]["pred"]), "strength"))
            and c["outcome"] == "wrong"
            and c["conf"] >= run_eval.CONF_T
        ]
        self.assertEqual(len(med113_raw_cw), 4)

        per_field: dict[str, list[dict[str, Any]]] = {f: [] for f in run_eval.FIELDS}
        for r in rows:
            pr = run_eval.to_label_read(preds_by_id[r["img_id"]]["pred"])
            for f in run_eval.FIELDS:
                c = run_eval.classify(r, pr, f)
                if c is not None:
                    per_field[f].append(c)

        all_items = [c for f in run_eval.FIELDS for c in per_field[f]]
        self.assertEqual(run_eval.agg(all_items), v1_res["synthetic"]["overall"])
        for f in run_eval.FIELDS:
            with self.subTest(field=f):
                self.assertEqual(run_eval.agg(per_field[f]), v1_res["synthetic"]["per_field"][f])

        strength_agg = run_eval.agg(per_field["strength"])
        self.assertEqual(strength_agg["confident_wrong"], 0)
        self.assertEqual(strength_agg["k"]["confident"], 754)
        self.assertEqual(strength_agg["confident_wrong_of_confident"], 0.0)
        self.assertEqual(strength_agg["precision_answered"], 100.0)
        self.assertEqual(
            run_eval.threshold_sweep(per_field["strength"]),
            v1_res["synthetic"]["threshold_sweep_strength"],
        )
        self.assertEqual(
            run_eval.threshold_sweep(all_items),
            v1_res["synthetic"]["threshold_sweep_all"],
        )


class TestDegradeOfflineInvariants(OfflineAuditBase):
    def test_downgrade_monotonicity_and_excluded_untouched(self) -> None:
        for start in ("visible", "partial", "hidden"):
            for target in ("visible", "partial", "hidden"):
                entry = {"status": start}
                degrade.downgrade(entry, target)
                self.assertEqual(STATUS_RANK[entry["status"]], max(STATUS_RANK[start], STATUS_RANK[target]))

        for target in ("visible", "partial", "hidden"):
            excl = {"status": "excluded"}
            degrade.downgrade(excl, target)
            self.assertEqual(excl["status"], "excluded")

        custom = {"status": "unknown_state"}
        degrade.downgrade(custom, "hidden")
        self.assertEqual(custom["status"], "unknown_state")

    def test_all_six_degs_across_severities_1_2_3_and_determinism(self) -> None:
        self.assertEqual(
            degrade.DEGS,
            ["motion_blur", "defocus", "rotation", "crop", "glare", "low_light"],
        )

        im = Image.new("RGB", (160, 160), (226, 230, 236))
        draw = ImageDraw.Draw(im)
        draw.rectangle((16, 16, 144, 144), fill=(252, 252, 254), outline=(35, 45, 55), width=2)
        draw.rectangle((40, 36, 120, 56), fill=(25, 70, 130))
        draw.rectangle((56, 68, 104, 80), fill=(180, 40, 40))

        base_gt: dict[str, dict[str, Any]] = {
            "product": {"value": "Norvasc", "status": "visible", "box": [120, 150, 320, 850], "lines": 1},
            "ingredient": {"value": "amlodipine", "status": "visible", "box": [350, 200, 420, 800], "lines": 1},
            "strength": {"value": "5 mg", "status": "visible", "box": [460, 350, 505, 650], "lines": 1},
            "dosing": {"value": "1 tabl daily", "status": "visible", "box": [560, 200, 595, 800], "lines": 2},
            "expiry": {"value": "2027-08", "status": "partial", "box": [680, 200, 725, 550], "lines": 1},
            "allergens": {"value": None, "status": "hidden", "box": None, "lines": 0},
            "barcode": {"value": "6412345", "status": "excluded", "box": [780, 200, 900, 800], "lines": 1},
        }
        snapshot_gt = copy.deepcopy(base_gt)

        for deg in degrade.DEGS:
            sev_gts: dict[int, dict[str, dict[str, Any]]] = {}
            sev_ims: dict[int, Image.Image] = {}
            for sev in (1, 2, 3):
                with self.subTest(deg=deg, sev=sev):
                    im1, gt1, meta1 = degrade.apply(im, base_gt, deg, sev, random.Random(2026))
                    im2, gt2, meta2 = degrade.apply(im, base_gt, deg, sev, random.Random(2026))
                    self.assertEqual(base_gt, snapshot_gt)
                    self.assertEqual(im1.mode, "RGB")
                    self.assertEqual(im1.size, im2.size)
                    self.assertEqual(im1.tobytes(), im2.tobytes())
                    self.assertEqual(gt1, gt2)
                    self.assertEqual(meta1, meta2)
                    self.assertTrue(len(meta1) >= 1)
                    self.assertEqual(gt1["barcode"]["status"], "excluded")
                    self.assertEqual(gt1["allergens"]["status"], "hidden")
                    if deg == "crop":
                        self.assertLess(im1.width * im1.height, im.width * im.height)
                    else:
                        self.assertEqual(im1.size, im.size)
                    sev_gts[sev] = gt1
                    sev_ims[sev] = im1

            for field_key in ("product", "ingredient", "strength", "dosing", "expiry"):
                r1 = STATUS_RANK[sev_gts[1][field_key]["status"]]
                r2 = STATUS_RANK[sev_gts[2][field_key]["status"]]
                r3 = STATUS_RANK[sev_gts[3][field_key]["status"]]
                self.assertLessEqual(r1, r2, f"{deg} {field_key}: sev1={r1} > sev2={r2}")
                self.assertLessEqual(r2, r3, f"{deg} {field_key}: sev2={r2} > sev3={r3}")

            if deg == "crop":
                a1 = sev_ims[1].width * sev_ims[1].height
                a2 = sev_ims[2].width * sev_ims[2].height
                a3 = sev_ims[3].width * sev_ims[3].height
                self.assertGreater(a1, a2)
                self.assertGreater(a2, a3)

        im_seed_a, _, _ = degrade.apply(im, base_gt, "low_light", 2, random.Random(11))
        im_seed_b, _, _ = degrade.apply(im, base_gt, "low_light", 2, random.Random(22))
        self.assertNotEqual(im_seed_a.tobytes(), im_seed_b.tobytes())

    def test_crop_overlap_thresholds_exact(self) -> None:
        im = Image.new("RGB", (1000, 20), (240, 240, 240))
        gt = {
            "anchor": {"value": "span", "status": "visible", "box": [0, 0, 1000, 1000], "lines": 1},
            "below_035": {"value": "hid", "status": "visible", "box": [0, 169, 1000, 669], "lines": 1},
            "above_035": {"value": "par_lo", "status": "visible", "box": [0, 180, 1000, 680], "lines": 1},
            "below_092": {"value": "par_hi", "status": "visible", "box": [0, 455, 1000, 955], "lines": 1},
            "above_092": {"value": "vis", "status": "visible", "box": [0, 465, 1000, 965], "lines": 1},
            "excl": {"value": "skip", "status": "excluded", "box": [0, 0, 1000, 200], "lines": 1},
        }
        left_seed = None
        for cand in range(50):
            if random.Random(cand).choice(["left", "right", "top", "bottom"]) == "left":
                left_seed = cand
                break
        self.assertIsNotNone(left_seed)

        out_im, out_gt, meta = degrade.apply(im, gt, "crop", 2, random.Random(left_seed))
        self.assertEqual(meta, {"window": [500, 0, 1000, 20], "side": "left", "cut": 0.5})
        self.assertEqual(out_im.size, (500, 20))
        self.assertEqual(out_gt["below_035"]["status"], "hidden")
        self.assertEqual(out_gt["above_035"]["status"], "partial")
        self.assertEqual(out_gt["below_092"]["status"], "partial")
        self.assertEqual(out_gt["above_092"]["status"], "visible")
        self.assertEqual(out_gt["excl"]["status"], "excluded")

    def test_glare_targets_visible_strength_and_allergens(self) -> None:
        im = Image.new("RGB", (160, 160), (210, 215, 220))
        med_gt = {
            "product": {"value": "Norvasc", "status": "visible", "box": [50, 50, 120, 250], "lines": 1},
            "strength": {"value": "5 mg", "status": "visible", "box": [700, 700, 780, 860], "lines": 1},
            "expiry": {"value": "2027-08", "status": "visible", "box": [50, 700, 120, 900], "lines": 1},
            "allergens": {"value": None, "status": "hidden", "box": None, "lines": 0},
        }
        _, med_s1, meta_s1 = degrade.apply(im, med_gt, "glare", 1, random.Random(0))
        _, med_s2, meta_s2 = degrade.apply(im, med_gt, "glare", 2, random.Random(0))
        _, med_s3, meta_s3 = degrade.apply(im, med_gt, "glare", 3, random.Random(0))
        self.assertEqual(meta_s1["target"], "strength")
        self.assertEqual(meta_s2["target"], "strength")
        self.assertEqual(meta_s3["target"], "strength")
        self.assertEqual(med_s1["strength"]["status"], "visible")
        self.assertEqual(med_s2["strength"]["status"], "partial")
        self.assertEqual(med_s3["strength"]["status"], "hidden")
        self.assertEqual(med_s3["product"]["status"], "visible")

        food_gt = {
            "product": {"value": "Pesto", "status": "visible", "box": [40, 40, 110, 240], "lines": 1},
            "strength": {"value": None, "status": "hidden", "box": [300, 300, 360, 450], "lines": 1},
            "expiry": {"value": "2027-11", "status": "visible", "box": [40, 700, 110, 900], "lines": 1},
            "allergens": {"value": ["tree_nuts"], "status": "visible", "box": [720, 680, 810, 900], "lines": 2},
        }
        _, food_s2, f_meta2 = degrade.apply(im, food_gt, "glare", 2, random.Random(0))
        _, food_s3, f_meta3 = degrade.apply(im, food_gt, "glare", 3, random.Random(0))
        self.assertEqual(f_meta2["target"], "allergens")
        self.assertEqual(f_meta3["target"], "allergens")
        self.assertEqual(food_s2["allergens"]["status"], "partial")
        self.assertEqual(food_s3["allergens"]["status"], "hidden")
        self.assertEqual(food_s3["product"]["status"], "visible")

        none_vis_gt = {
            "product": {"value": "X", "status": "hidden", "box": None, "lines": 0},
            "strength": {"value": None, "status": "hidden", "box": None, "lines": 0},
            "expiry": {"value": None, "status": "hidden", "box": None, "lines": 0},
            "allergens": {"value": None, "status": "hidden", "box": None, "lines": 0},
        }
        _, _, none_meta = degrade.apply(im, none_vis_gt, "glare", 3, random.Random(0))
        self.assertIsNone(none_meta["target"])

    def test_do_one_front_and_back_and_blur_line_height_boundaries(self) -> None:
        self.assertIsNone(degrade.box_px(None, 200, 100))
        self.assertEqual(degrade.box_px([100, 250, 500, 750], 200, 100), (50.0, 10.0, 150.0, 50.0))
        self.assertIsNone(degrade.line_height({"box": None}, 1000))
        self.assertEqual(degrade.line_height({"box": [100, 0, 140, 500], "lines": 2}, 1000), 20.0)

        blur_gt = {
            "small": {"status": "visible", "box": [0, 0, 10, 500], "lines": 1},
            "medium": {"status": "visible", "box": [0, 0, 18, 500], "lines": 1},
            "large": {"status": "visible", "box": [0, 0, 30, 500], "lines": 1},
            "excl": {"status": "excluded", "box": [0, 0, 8, 500], "lines": 1},
        }
        degrade.blur_status(blur_gt, size_px=10.0, h=1000)
        self.assertEqual(blur_gt["small"]["status"], "hidden")
        self.assertEqual(blur_gt["medium"]["status"], "partial")
        self.assertEqual(blur_gt["large"]["status"], "visible")
        self.assertEqual(blur_gt["excl"]["status"], "excluded")

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = pathlib.Path(tmp)
            (data_dir / "clean").mkdir()
            src_im = Image.new("RGB", (140, 140), (235, 238, 242))
            src_im.save(data_dir / "clean" / "med1.jpg", "JPEG", quality=90)
            src_im.save(data_dir / "clean" / "med1_back.jpg", "JPEG", quality=90)

            sample_gt = {
                "product": {"value": "Norvasc", "status": "visible", "box": [150, 150, 320, 850], "lines": 1},
                "strength": {"value": "5 mg", "status": "visible", "box": [450, 350, 510, 650], "lines": 1},
                "expiry": {"value": "2027-08", "status": "visible", "box": [700, 200, 750, 550], "lines": 1},
                "allergens": {"value": None, "status": "hidden", "box": None, "lines": 0},
            }
            front_rec = {
                "id": "med1",
                "spec_id": "med1",
                "kind": "medication",
                "view": "front",
                "file": "clean/med1.jpg",
                "gt": sample_gt,
            }
            back_rec = {
                "id": "med1_back",
                "spec_id": "med1",
                "kind": "medication",
                "view": "back",
                "file": "clean/med1_back.jpg",
                "gt": {k: dict(v, status="hidden") for k, v in sample_gt.items()},
            }
            with mock.patch.object(degrade, "DATA", data_dir):
                front_rows = degrade.do_one((front_rec, 2, 96, 1001))
                back_rows = degrade.do_one((back_rec, 3, 96, 1002))

            self.assertEqual(len(front_rows), 7)
            self.assertEqual(front_rows[0]["deg"], "clean")
            self.assertEqual(front_rows[0]["sev"], 0)
            for row in front_rows:
                p = data_dir / row["file"]
                self.assertTrue(p.is_file())
                with Image.open(p) as saved_im:
                    if row["deg"] == "crop":
                        self.assertLess(saved_im.width * saved_im.height, 96 * 96)
                    else:
                        self.assertEqual(saved_im.size, (96, 96))

            self.assertEqual(len(back_rows), 1)
            self.assertEqual(back_rows[0]["deg"], "back_of_box")
            self.assertEqual(back_rows[0]["sev"], 0)
            self.assertTrue((data_dir / back_rows[0]["file"]).is_file())


class TestGenImagesAndCommonOfflineHelpers(OfflineAuditBase):
    def test_gt_from_check_excludes_mismatched_legible_and_keep_rules(self) -> None:
        med_spec = {
            "id": "med99",
            "kind": "medication",
            "brand": "Orion",
            "product": "Burana",
            "ingredient": "ibuprofen",
            "strength": "400 mg",
            "dosing": "1 tabl",
            "expiry": "2027-11",
            "barcode": "641099",
        }
        chk_mismatch = {
            "photo_ok": True,
            "garbled_text": True,
            "fields": [
                {"field": "product", "legible": True, "printed_text": "Burana", "matches_spec": True, "box_2d": [100, 100, 220, 800], "line_count": 1},
                {"field": "strength", "legible": True, "printed_text": "40 mg", "matches_spec": False, "box_2d": [300, 200, 380, 600], "line_count": 1},
                {"field": "dosing", "legible": False, "printed_text": "", "matches_spec": False, "box_2d": [1, 2], "line_count": 0},
            ],
        }
        gt_mis = gen_images.gt_from_check(med_spec, chk_mismatch)
        self.assertEqual(gt_mis["product"]["status"], "visible")
        self.assertEqual(gt_mis["product"]["box"], [100, 100, 220, 800])
        self.assertEqual(gt_mis["strength"]["status"], "excluded")
        self.assertEqual(gt_mis["dosing"]["status"], "hidden")
        self.assertEqual(gt_mis["dosing"]["box"], [])
        self.assertEqual(gt_mis["ingredient"]["status"], "hidden")
        self.assertIsNone(gt_mis["allergens"]["value"])
        self.assertFalse(gen_images.keep(med_spec, gt_mis, chk_mismatch))

        chk_good = {
            "photo_ok": True,
            "garbled_text": False,
            "fields": [
                {"field": "product", "legible": True, "printed_text": "Burana", "matches_spec": True, "box_2d": [100, 100, 220, 800], "line_count": 1},
                {"field": "strength", "legible": True, "printed_text": "400 mg", "matches_spec": True, "box_2d": [300, 200, 380, 600], "line_count": 1},
            ],
        }
        gt_good = gen_images.gt_from_check(med_spec, chk_good)
        self.assertTrue(gen_images.keep(med_spec, gt_good, chk_good))
        self.assertFalse(gen_images.keep(med_spec, gt_good, {"photo_ok": False}))

        food_spec = {
            "id": "food99",
            "kind": "food",
            "brand": "Fazer",
            "product": "Kaurakeksi",
            "allergens": ["gluten", "milk", "gluten"],
            "may_contain": ["peanut"],
            "expiry": "2027-04",
        }
        food_chk = {
            "photo_ok": True,
            "fields": [
                {"field": "product", "legible": True, "printed_text": "Kaurakeksi", "matches_spec": True, "box_2d": [50, 50, 150, 700], "line_count": 1},
                {"field": "allergens", "legible": True, "printed_text": "kaura, maito", "matches_spec": True, "box_2d": [200, 50, 400, 800], "line_count": 3},
            ],
        }
        food_gt = gen_images.gt_from_check(food_spec, food_chk)
        self.assertEqual(food_gt["allergens"]["value"], ["gluten", "milk"])
        self.assertEqual(food_gt["may_contain"]["value"], ["peanut"])
        self.assertTrue(gen_images.keep(food_spec, food_gt, food_chk))

        raw_buf = io.BytesIO()
        Image.new("RGBA", (300, 200), (100, 120, 140, 255)).save(raw_buf, "PNG")
        jpg_bytes = gen_images.to_jpeg(raw_buf.getvalue(), size=128)
        with Image.open(io.BytesIO(jpg_bytes)) as dec_im:
            self.assertEqual(dec_im.format, "JPEG")
            self.assertEqual(dec_im.mode, "RGB")
            self.assertLessEqual(max(dec_im.size), 128)

    def test_common_redact_parse_json_and_retryable_classification(self) -> None:
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "SYNTH_TOKEN_FOR_REDACT_CHECK"}, clear=False):
            redacted = common._redact("failed with SYNTH_TOKEN_FOR_REDACT_CHECK and ?key=AbCd_123-xyz&v=1")
        self.assertNotIn("SYNTH_TOKEN_FOR_REDACT_CHECK", redacted)
        self.assertNotIn("AbCd_123-xyz", redacted)
        self.assertIn("***", redacted)
        self.assertIn("key=***", redacted)

        fenced = f"{BACKTICK3}json\n" + '{"ok": true, "count": 3}' + f"\n{BACKTICK3}"
        self.assertEqual(common.parse_json(fenced), {"ok": True, "count": 3})
        self.assertEqual(common.parse_json('  {"plain": 1}  '), {"plain": 1})

        err_429 = Exception("quota hit")
        setattr(err_429, "status_code", 429)
        self.assertTrue(common.is_retryable(err_429))
        self.assertTrue(common.is_retryable(RuntimeError("Unterminated string starting at line 1")))
        self.assertFalse(common.is_retryable(ValueError("invalid argument schema")))


class TestRunEvalAndDegradeAuditHygiene(unittest.TestCase):
    def test_strict_file_and_runtime_hygiene(self) -> None:
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, src)
        self.assertNotIn(SLASH2, src)
        self.assertNotIn(TRIPLE_DQ, src)
        self.assertNotIn(TRIPLE_SQ, src)
        self.assertNotIn(EM_DASH, src)
        self.assertNotIn(EN_DASH, src)
        self.assertNotIn("Co-Authored" + "-By", src)
        self.assertNotIn("git " + "status", src)
        self.assertNotIn("git " + "diff", src)
        self.assertNotIn("sub" + "process", src)
        self.assertIsNone(common._client)


if __name__ == "__main__":
    unittest.main()
