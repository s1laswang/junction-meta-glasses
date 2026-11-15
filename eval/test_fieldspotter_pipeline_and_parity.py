from __future__ import annotations

import contextlib
import gc
import io
import json
import math
import os
import pathlib
import random
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings
from typing import Any

sys.dont_write_bytecode = True
os.environ["GEMINI_API_KEY"] = ""

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
WORKSPACE_NM_EXISTED_AT_START = (REPO_ROOT / "node_modules").exists()

if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import run_eval

SPLIT_JSON_PATH = REPO_ROOT / "docs" / "evidence" / "fieldspotter" / "split.json"
FIELDSPOTTER_YOLO_PATH = EVAL_DIR / "results" / "fieldspotter.json"
FIELDSPOTTER_GEMMA_PATH = EVAL_DIR / "results" / "fieldspotter_gemma.json"
MAKE_YOLO_PATH = EVAL_DIR / "make_yolo.py"
PG_DATA_PATH = EVAL_DIR / "pg_data.py"
VERIFY_TS_PATH = REPO_ROOT / "server" / "src" / "verify.ts"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
SHARED_NPM_NM = pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules")

CLASSES = ("product", "strength", "expiry", "allergens")
EXPECTED_PG_PREFIX = "detect product ; strength ; expiry ; allergens"
LOC_TOKEN_RE = re.compile(
    r"^<loc(\d{4})><loc(\d{4})><loc(\d{4})><loc(\d{4})> (product|strength|expiry|allergens)$"
)

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)


def wilson95_pct(k: int, n: int, z: float = 1.96) -> list[float]:
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    denom = 1.0 + z * z / n
    center = p + z * z / (2.0 * n)
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n))
    return [round(100.0 * (center - half) / denom, 1), round(100.0 * (center + half) / denom, 1)]


def run_script_in_process(script_path: pathlib.Path, args: list[str]) -> str:
    buf = io.StringIO()
    old_argv = sys.argv[:]
    try:
        sys.argv = [str(script_path), *args]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            with contextlib.redirect_stdout(buf):
                runpy.run_path(str(script_path), run_name="__main__")
            gc.collect()
    finally:
        sys.argv = old_argv
    return buf.getvalue()


def build_edge_payloads() -> list[tuple[str, dict[str, Any]]]:
    long_guidance = "   " + ("Turn the package slowly toward the light so the strength text is sharp. " * 3) + "   "
    return [
        (
            "valid_med_iso_month",
            {
                "kind": "medication",
                "product": {"value": "Norvasc", "confidence": 0.96},
                "ingredient": {"value": "amlodipine", "confidence": 0.94},
                "strength": {"value": "5 mg", "confidence": 0.92},
                "dosing": {"value": "1 tablet once daily", "confidence": 0.88},
                "expiry": {"value": "2027-08", "confidence": 0.95},
                "allergens": {"value": None, "confidence": 0.1},
                "barcode": {"value": "06410012345678", "confidence": 0.91},
                "readability": 0.93,
                "guidance": "  Hold steady  ",
            },
        ),
        (
            "valid_food_iso_full_date_and_allergens",
            {
                "kind": "food",
                "product": {"value": "Oat Choco Bar", "confidence": 0.97},
                "ingredient": {"value": None, "confidence": 0.0},
                "strength": {"value": None, "confidence": 0.0},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": "2027-11-30", "confidence": 0.94},
                "allergens": {"value": ["milk", "peanuts", "gluten"], "confidence": 0.98},
                "barcode": {"value": "6412345678901", "confidence": 0.99},
                "readability": 0.95,
            },
        ),
        ("empty_object", {}),
        (
            "null_values_high_confidence_capped_at_0_3",
            {
                "kind": "other",
                "product": {"value": None, "confidence": 0.99},
                "ingredient": {"value": None, "confidence": 0.85},
                "strength": {"value": None, "confidence": 0.92},
                "dosing": {"value": None, "confidence": 0.45},
                "expiry": {"value": None, "confidence": 0.95},
                "allergens": {"value": None, "confidence": 0.97},
                "barcode": {"value": None, "confidence": 0.15},
                "readability": 0.4,
            },
        ),
        (
            "whitespace_strings_coerced_to_null",
            {
                "kind": "medication",
                "product": {"value": "", "confidence": 0.95},
                "ingredient": {"value": "   ", "confidence": 0.9},
                "strength": {"value": "\t\n ", "confidence": 0.88},
                "dosing": {"value": "  ", "confidence": 0.2},
                "expiry": {"value": "   ", "confidence": 0.91},
                "allergens": {"value": [], "confidence": 0.96},
                "barcode": {"value": "", "confidence": 0.75},
                "readability": 0.5,
                "guidance": "   \t  ",
            },
        ),
        (
            "out_of_bounds_high_confidences_clamped_to_1",
            {
                "kind": "medication",
                "product": {"value": "Burana", "confidence": 1.45},
                "ingredient": {"value": "ibuprofen", "confidence": 99},
                "strength": {"value": "400 mg", "confidence": 1.0001},
                "dosing": {"value": "1 tablet", "confidence": 5.0},
                "expiry": {"value": "2028-01", "confidence": 2.2},
                "allergens": {"value": ["lactose"], "confidence": 3.5},
                "barcode": {"value": "12345", "confidence": 10},
                "readability": 4.2,
            },
        ),
        (
            "out_of_bounds_negative_confidences_clamped_to_0",
            {
                "kind": "medication",
                "product": {"value": "Panadol", "confidence": -0.5},
                "ingredient": {"value": "paracetamol", "confidence": -10},
                "strength": {"value": "500 mg", "confidence": -0.01},
                "dosing": {"value": None, "confidence": -2.0},
                "expiry": {"value": "2028-05", "confidence": -0.3},
                "allergens": {"value": [], "confidence": -1},
                "barcode": {"value": "98765", "confidence": 0},
                "readability": -0.75,
            },
        ),
        (
            "non_numeric_confidences_default_to_0",
            {
                "kind": "medication",
                "product": {"value": "Thyroxin", "confidence": "0.95"},
                "ingredient": {"value": "levothyroxine", "confidence": None},
                "strength": {"value": "100 mcg", "confidence": {}},
                "dosing": {"value": "1 daily", "confidence": []},
                "expiry": {"value": "2027-09", "confidence": "high"},
                "allergens": {"value": ["milk"], "confidence": "0.99"},
                "barcode": {"value": "111", "confidence": None},
                "readability": "0.85",
            },
        ),
        (
            "non_iso_slash_expiry_capped_at_0_5",
            {
                "kind": "medication",
                "product": {"value": "Metforem", "confidence": 0.95},
                "ingredient": {"value": "metformin", "confidence": 0.95},
                "strength": {"value": "500 mg", "confidence": 0.95},
                "dosing": {"value": "1 twice daily", "confidence": 0.8},
                "expiry": {"value": "08/2027", "confidence": 0.96},
                "allergens": {"value": None, "confidence": 0.0},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.9,
            },
        ),
        (
            "non_iso_nordic_dot_expiry_capped_at_0_5",
            {
                "kind": "food",
                "product": {"value": "Rye Bread", "confidence": 0.91},
                "ingredient": {"value": None, "confidence": 0.0},
                "strength": {"value": None, "confidence": 0.0},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": "15.08.2027", "confidence": 0.89},
                "allergens": {"value": ["rye", "gluten"], "confidence": 0.93},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.88,
            },
        ),
        (
            "non_iso_expiry_below_0_5_kept_unchanged",
            {
                "kind": "medication",
                "product": {"value": "Bisoprolol", "confidence": 0.9},
                "ingredient": {"value": "bisoprolol", "confidence": 0.9},
                "strength": {"value": "2.5 mg", "confidence": 0.9},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": "Aug 2027", "confidence": 0.28},
                "allergens": {"value": None, "confidence": 0.0},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.72,
            },
        ),
        (
            "single_digit_month_expiry_capped_at_0_5",
            {
                "kind": "medication",
                "product": {"value": "Marevan", "confidence": 0.93},
                "ingredient": {"value": "warfarin", "confidence": 0.93},
                "strength": {"value": "3 mg", "confidence": 0.91},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": "2027-8", "confidence": 0.92},
                "allergens": {"value": None, "confidence": 0.0},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.84,
            },
        ),
        (
            "over_120_char_guidance_trimmed_and_sliced",
            {
                "kind": "unreadable",
                "product": {"value": None, "confidence": 0.0},
                "ingredient": {"value": None, "confidence": 0.0},
                "strength": {"value": None, "confidence": 0.0},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": None, "confidence": 0.0},
                "allergens": {"value": None, "confidence": 0.0},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.12,
                "guidance": long_guidance,
            },
        ),
        (
            "invalid_kind_string_coerced_to_unreadable",
            {
                "kind": "supplement",
                "product": {"value": "Vitamin D", "confidence": 0.95},
                "ingredient": {"value": "cholecalciferol", "confidence": 0.92},
                "strength": {"value": "20 mcg", "confidence": 0.9},
                "dosing": {"value": "1 daily", "confidence": 0.85},
                "expiry": {"value": "2028-03", "confidence": 0.91},
                "allergens": {"value": [], "confidence": 0.9},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.9,
            },
        ),
        (
            "non_array_allergens_rejected_and_capped",
            {
                "kind": "food",
                "product": {"value": "Hazelnut Spread", "confidence": 0.96},
                "ingredient": {"value": None, "confidence": 0.0},
                "strength": {"value": None, "confidence": 0.0},
                "dosing": {"value": None, "confidence": 0.0},
                "expiry": {"value": "2027-06", "confidence": 0.91},
                "allergens": {"value": "hazelnuts, milk, soy", "confidence": 0.97},
                "barcode": {"value": None, "confidence": 0.0},
                "readability": 0.89,
            },
        ),
        (
            "mixed_array_allergens_and_scalar_fields_rejected",
            {
                "kind": 42,
                "product": "Norvasc",
                "ingredient": ["amlodipine"],
                "strength": {"value": 5, "confidence": 0.95},
                "dosing": {"value": {"txt": "daily"}, "confidence": 0.9},
                "expiry": {"value": " 2027-08 ", "confidence": 0.94},
                "allergens": {"value": ["milk", 123, None], "confidence": 0.96},
                "barcode": 64123,
                "readability": 0.65,
                "guidance": 999,
            },
        ),
    ]


class TestMakeYoloAndPgDataEndToEnd(unittest.TestCase):
    tmpdir_obj: tempfile.TemporaryDirectory[str]
    src_dir: pathlib.Path
    yolo_dir: pathlib.Path
    pg_dir: pathlib.Path
    dataset_rows: list[dict[str, Any]]
    yolo_stdout: str
    pg_stdout: str

    @classmethod
    def setUpClass(cls) -> None:
        from PIL import Image

        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="holdup_fs_test_")
        cls.addClassCleanup(cls.tmpdir_obj.cleanup)
        root = pathlib.Path(cls.tmpdir_obj.name)
        cls.src_dir = root / "synthetic"
        cls.yolo_dir = root / "yolo"
        cls.pg_dir = root / "pg"
        (cls.src_dir / "imgs").mkdir(parents=True, exist_ok=True)

        def write_tiny_jpg(rel_path: str, color: tuple[int, int, int]) -> None:
            im = Image.new("RGB", (24, 16), color)
            im.save(cls.src_dir / rel_path, format="JPEG", quality=80)

        rows: list[dict[str, Any]] = []

        write_tiny_jpg("imgs/src_00_clean.jpg", (220, 230, 240))
        rows.append(
            {
                "img_id": "src_00_clean",
                "src_id": "src_00",
                "file": "imgs/src_00_clean.jpg",
                "gt": {
                    "product": {"status": "visible", "box": [100, 200, 300, 800]},
                    "strength": {"status": "partial", "box": [-20, 400, 480, 1050]},
                    "expiry": {"status": "visible", "box": [700, 150, 760, 450]},
                    "allergens": {"status": "visible", "box": [800, 100, 950, 900]},
                },
            }
        )

        write_tiny_jpg("imgs/src_00_filtered.jpg", (210, 210, 210))
        rows.append(
            {
                "img_id": "src_00_filtered",
                "src_id": "src_00",
                "file": "imgs/src_00_filtered.jpg",
                "gt": {
                    "product": {"status": "hidden", "box": [100, 100, 300, 500]},
                    "strength": {"status": "excluded", "box": [400, 100, 500, 500]},
                    "expiry": {"status": "visible", "box": [500, 600, 500, 800]},
                    "allergens": {"status": "visible", "box": [200, 700, 400, 300]},
                },
            }
        )

        write_tiny_jpg("imgs/src_01_degen.jpg", (200, 190, 180))
        rows.append(
            {
                "img_id": "src_01_degen",
                "src_id": "src_01",
                "file": "imgs/src_01_degen.jpg",
                "gt": {
                    "product": {"status": "visible", "box": [10, 20]},
                    "strength": {"status": "visible", "box": None},
                    "expiry": {"status": "partial", "box": [1010, 200, 1050, 500]},
                    "allergens": {"status": "visible", "box": [300, 500, 200, 600]},
                },
            }
        )

        write_tiny_jpg("imgs/src_01_clean.jpg", (195, 205, 215))
        rows.append(
            {
                "img_id": "src_01_clean",
                "src_id": "src_01",
                "file": "imgs/src_01_clean.jpg",
                "gt": {
                    "product": {"status": "visible", "box": [120, 150, 260, 850]},
                    "strength": {"status": "visible", "box": [320, 300, 420, 700]},
                    "expiry": {"status": "hidden", "box": [700, 200, 760, 500]},
                    "allergens": {"status": "excluded", "box": None},
                },
            }
        )

        for idx in range(2, 10):
            sid = f"src_{idx:02d}"
            for suffix, st_strength in (("clean", "visible"), ("aug", "partial")):
                img_id = f"{sid}_{suffix}"
                rel = f"imgs/{img_id}.jpg"
                write_tiny_jpg(rel, (100 + idx * 10, 140, 180))
                rows.append(
                    {
                        "img_id": img_id,
                        "src_id": sid,
                        "file": rel,
                        "gt": {
                            "product": {"status": "visible", "box": [100, 100, 250, 900]},
                            "strength": {"status": st_strength, "box": [350, 250, 450, 750]},
                            "expiry": {"status": "visible", "box": [650, 200, 730, 600]},
                            "allergens": {
                                "status": "visible" if idx % 2 == 0 else "excluded",
                                "box": [800, 150, 920, 850] if idx % 2 == 0 else None,
                            },
                        },
                    }
                )

        rows.append(
            {
                "img_id": "src_02_missing",
                "src_id": "src_02",
                "file": "imgs/does_not_exist.jpg",
                "gt": {
                    "product": {"status": "visible", "box": [100, 100, 200, 300]},
                },
            }
        )

        cls.dataset_rows = rows
        dataset_jsonl = cls.src_dir / "dataset.jsonl"
        dataset_jsonl.write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n",
            encoding="utf-8",
        )

        cls.yolo_stdout = run_script_in_process(MAKE_YOLO_PATH, [str(cls.src_dir), str(cls.yolo_dir)])
        cls.pg_stdout = run_script_in_process(PG_DATA_PATH, [str(cls.yolo_dir), str(cls.pg_dir)])

    def test_seed42_80_20_src_id_split_and_zero_overlap(self) -> None:
        split_meta = json.loads((self.yolo_dir / "split.json").read_text(encoding="utf-8"))
        stdout_meta = json.loads(self.yolo_stdout.strip())
        self.assertEqual(split_meta["images"], stdout_meta["images"])
        self.assertEqual(split_meta["boxes"], stdout_meta["boxes"])
        self.assertEqual(split_meta["split"], "by src_id, 80/20, seed 42")

        all_srcs = sorted({r["src_id"] for r in self.dataset_rows})
        self.assertEqual(len(all_srcs), 10)
        shuffled = list(all_srcs)
        random.Random(42).shuffle(shuffled)
        val_k = max(1, divmod(len(shuffled), 5)[0])
        expected_val_srcs = sorted(shuffled[:val_k])
        self.assertEqual(len(expected_val_srcs), 2)
        self.assertEqual(split_meta["val_src_ids"], expected_val_srcs)

        img_to_src = {r["img_id"]: r["src_id"] for r in self.dataset_rows}
        train_imgs = {p.stem for p in (self.yolo_dir / "images" / "train").glob("*.jpg")}
        val_imgs = {p.stem for p in (self.yolo_dir / "images" / "val").glob("*.jpg")}
        self.assertEqual(len(train_imgs), 16)
        self.assertEqual(len(val_imgs), 4)
        self.assertEqual(split_meta["images"], {"train": 16, "val": 4})
        self.assertNotIn("src_02_missing", train_imgs | val_imgs)

        train_srcs = {img_to_src[i] for i in train_imgs}
        val_srcs = {img_to_src[i] for i in val_imgs}
        self.assertEqual(len(train_srcs), 8)
        self.assertEqual(len(val_srcs), 2)
        self.assertEqual(train_srcs & val_srcs, set())
        self.assertEqual(sorted(val_srcs), expected_val_srcs)

        data_yaml = (self.yolo_dir / "data.yaml").read_text(encoding="utf-8")
        expected_yaml = (
            f"path: {self.yolo_dir}\n"
            "train: images/train\n"
            "val: images/val\n"
            "names:\n"
            "  0: product\n"
            "  1: strength\n"
            "  2: expiry\n"
            "  3: allergens\n"
        )
        self.assertEqual(data_yaml, expected_yaml)

    def test_yolo_box_normalization_and_filtering_of_hidden_excluded_degenerate(self) -> None:
        def find_label(img_id: str) -> pathlib.Path:
            for sp in ("train", "val"):
                cand = self.yolo_dir / "labels" / sp / f"{img_id}.txt"
                if cand.exists():
                    return cand
            self.fail(f"missing label file for {img_id}")

        ref_lines = find_label("src_00_clean").read_text(encoding="utf-8").splitlines()
        self.assertEqual(
            ref_lines,
            [
                "0 0.50000 0.20000 0.60000 0.20000",
                "1 0.70000 0.24000 0.60000 0.48000",
                "2 0.30000 0.73000 0.30000 0.06000",
                "3 0.50000 0.87500 0.80000 0.15000",
            ],
        )

        self.assertEqual(find_label("src_00_filtered").read_text(encoding="utf-8"), "")
        self.assertEqual(find_label("src_01_degen").read_text(encoding="utf-8"), "")

        split_meta = json.loads((self.yolo_dir / "split.json").read_text(encoding="utf-8"))
        for sp in ("train", "val"):
            tallies = {c: 0 for c in CLASSES}
            for txt_path in (self.yolo_dir / "labels" / sp).glob("*.txt"):
                for line in txt_path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    parts = line.split()
                    self.assertEqual(len(parts), 5)
                    ci = int(parts[0])
                    cx, cy, w, h = (float(x) for x in parts[1:])
                    self.assertIn(ci, (0, 1, 2, 3))
                    self.assertGreater(w, 0.0)
                    self.assertGreater(h, 0.0)
                    self.assertLessEqual(w, 1.0)
                    self.assertLessEqual(h, 1.0)
                    self.assertGreaterEqual(cx, 0.0)
                    self.assertLessEqual(cx, 1.0)
                    self.assertGreaterEqual(cy, 0.0)
                    self.assertLessEqual(cy, 1.0)
                    tallies[CLASSES[ci]] += 1
            self.assertEqual(split_meta["boxes"][sp], tallies)

    def test_pg_data_loc_1023_binning_and_detect_prefix(self) -> None:
        train_rows = [
            json.loads(line)
            for line in (self.pg_dir / "train.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        val_rows = [
            json.loads(line)
            for line in (self.pg_dir / "val.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(train_rows), 16)
        self.assertEqual(len(val_rows), 4)
        self.assertEqual(self.pg_stdout.strip().splitlines(), ["train 16", "val 4"])

        by_stem: dict[str, dict[str, Any]] = {}
        for sp, rows in (("train", train_rows), ("val", val_rows)):
            for row in rows:
                self.assertEqual(set(row.keys()), {"image", "prefix", "suffix"})
                self.assertEqual(row["prefix"], EXPECTED_PG_PREFIX)
                self.assertTrue(row["image"].startswith(f"images/{sp}/"))
                self.assertTrue(row["image"].endswith(".jpg"))
                self.assertTrue((self.yolo_dir / row["image"]).exists())
                stem = pathlib.Path(row["image"]).stem
                by_stem[stem] = row
                if row["suffix"]:
                    for seg in row["suffix"].split(" ; "):
                        m = LOC_TOKEN_RE.match(seg)
                        self.assertIsNotNone(m, f"malformed PaliGemma loc token: {seg}")
                        assert m is not None
                        y0, x0, y1, x1 = (int(m.group(k)) for k in range(1, 5))
                        for coord in (y0, x0, y1, x1):
                            self.assertGreaterEqual(coord, 0)
                            self.assertLessEqual(coord, 1023)
                        self.assertLess(y0, y1)
                        self.assertLess(x0, x1)

        self.assertEqual(
            by_stem["src_00_clean"]["suffix"],
            "<loc0102><loc0205><loc0307><loc0818> product ; "
            "<loc0000><loc0409><loc0491><loc1023> strength ; "
            "<loc0716><loc0153><loc0777><loc0460> expiry ; "
            "<loc0818><loc0102><loc0972><loc0921> allergens",
        )
        self.assertEqual(by_stem["src_00_filtered"]["suffix"], "")
        self.assertEqual(by_stem["src_01_degen"]["suffix"], "")


class TestFieldspotterCrossArtifactParity(unittest.TestCase):
    split_data: dict[str, Any]
    yolo_res: dict[str, Any]
    gemma_res: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        cls.split_data = json.loads(SPLIT_JSON_PATH.read_text(encoding="utf-8"))
        cls.yolo_res = json.loads(FIELDSPOTTER_YOLO_PATH.read_text(encoding="utf-8"))
        cls.gemma_res = json.loads(FIELDSPOTTER_GEMMA_PATH.read_text(encoding="utf-8"))

    def test_split_and_val_image_counts_parity(self) -> None:
        imgs = self.split_data["images"]
        self.assertEqual(imgs["train"], 1392)
        self.assertEqual(imgs["val"], 348)
        self.assertEqual(imgs["train"] + imgs["val"], 1740)
        self.assertEqual(self.split_data["split"], "by src_id, 80/20, seed 42")

        val_srcs = self.split_data["val_src_ids"]
        self.assertEqual(val_srcs, sorted(val_srcs))
        self.assertEqual(len(val_srcs), len(set(val_srcs)))

        self.assertEqual(self.yolo_res["n_val_images"], 348)
        self.assertEqual(self.gemma_res["n_val_images"], 348)
        self.assertEqual(
            self.split_data["boxes"]["val"],
            {"product": 309, "strength": 186, "expiry": 303, "allergens": 98},
        )
        self.assertEqual(self.yolo_res["latency_ms_gpu_shared_h100"]["n"], 348)
        self.assertLessEqual(
            self.yolo_res["latency_ms_gpu_shared_h100"]["p50"],
            self.yolo_res["latency_ms_gpu_shared_h100"]["p95"],
        )
        self.assertEqual(self.yolo_res["latency_ms_onnx_cpu"]["n"], 100)
        self.assertLessEqual(
            self.yolo_res["latency_ms_onnx_cpu"]["p50"],
            self.yolo_res["latency_ms_onnx_cpu"]["p95"],
        )
        self.assertEqual(self.gemma_res["latency_ms_gpu"]["n"], 348)
        self.assertLessEqual(
            self.gemma_res["latency_ms_gpu"]["p50"],
            self.gemma_res["latency_ms_gpu"]["p95"],
        )

    def test_strength_visible_confusion_and_wilson_ci_parity(self) -> None:
        val_strength_boxes = self.split_data["boxes"]["val"]["strength"]
        self.assertEqual(val_strength_boxes, 186)

        for label, artifact in (("yolov8n", self.yolo_res), ("paligemma2", self.gemma_res)):
            with self.subTest(model=label):
                sv = artifact["strength_visible"]
                tp, fp, fn, tn = sv["tp"], sv["fp"], sv["fn"], sv["tn"]
                self.assertEqual(tp + fp + fn + tn, 348)
                self.assertEqual(tp + fn, val_strength_boxes)
                self.assertEqual(fp + tn, 348 - val_strength_boxes)

                expected_prec = round(100.0 * tp / (tp + fp), 1)
                expected_rec = round(100.0 * tp / (tp + fn), 1)
                self.assertEqual(sv["precision"], expected_prec)
                self.assertEqual(sv["recall"], expected_rec)
                self.assertEqual(sv["precision_ci"], wilson95_pct(tp, tp + fp))
                self.assertEqual(sv["recall_ci"], wilson95_pct(tp, tp + fn))

    def test_paligemma_per_class_iou50_and_yolo_map_parity(self) -> None:
        val_boxes = self.split_data["boxes"]["val"]
        pg_classes = self.gemma_res["per_class_iou50"]
        self.assertEqual(set(pg_classes.keys()), set(CLASSES))

        for cls_name in CLASSES:
            entry = pg_classes[cls_name]
            tp, fp, fn = entry["tp"], entry["fp"], entry["fn"]
            self.assertEqual(tp + fn, val_boxes[cls_name])
            self.assertEqual(entry["precision"], round(100.0 * tp / (tp + fp), 1))
            self.assertEqual(entry["recall"], round(100.0 * tp / (tp + fn), 1))

        yolo_classes = self.yolo_res["per_class"]
        self.assertEqual(set(yolo_classes.keys()), set(CLASSES))
        for cls_name in CLASSES:
            ap50 = yolo_classes[cls_name]["mAP50"]
            ap50_95 = yolo_classes[cls_name]["mAP50_95"]
            self.assertGreaterEqual(ap50, ap50_95)
            self.assertGreater(ap50, 0.0)
            self.assertLessEqual(ap50, 1.0)
        mean_map50 = round(sum(yolo_classes[c]["mAP50"] for c in CLASSES) / len(CLASSES), 3)
        mean_map50_95 = round(sum(yolo_classes[c]["mAP50_95"] for c in CLASSES) / len(CLASSES), 3)
        self.assertEqual(self.yolo_res["map50_all"], mean_map50)
        self.assertEqual(self.yolo_res["map50_95_all"], mean_map50_95)


class TestVerifyCoercionAndSchemaParity(unittest.TestCase):
    edge_cases: list[tuple[str, dict[str, Any]]]
    ts_schema: dict[str, Any]
    ts_reads: list[dict[str, Any]]

    @classmethod
    def setUpClass(cls) -> None:
        cls.edge_cases = build_edge_payloads()
        payloads = [p for _, p in cls.edge_cases]

        node_bin = shutil.which("node") or "/usr/local/bin/node"
        nm_candidates = [
            SHARED_NPM_NM,
            REPO_ROOT / "node_modules",
            REPO_ROOT.parent / "node_modules",
        ]
        existing_nms = [str(p) for p in nm_candidates if p.is_dir()]
        if not existing_nms:
            raise RuntimeError("No shared or local node_modules found for tsx")

        tsx_import = "tsx"
        if not ((REPO_ROOT / "node_modules").exists() or (REPO_ROOT.parent / "node_modules").exists()):
            loader_mjs = pathlib.Path(existing_nms[0]) / "tsx" / "dist" / "loader.mjs"
            if loader_mjs.exists():
                tsx_import = str(loader_mjs)

        js_code = (
            'import fs from "node:fs";'
            'import { pathToFileURL } from "node:url";'
            "const mod = await import(pathToFileURL(process.env.HOLDUP_VERIFY_TS).href);"
            'const payloads = JSON.parse(fs.readFileSync(0, "utf8"));'
            "const reads = payloads.map((p) => mod.toLabelRead(p));"
            'process.stdout.write("PARITY_OUT:" + JSON.stringify({ schema: mod.LABEL_SCHEMA, reads }) + "\\n");'
        )

        with tempfile.TemporaryDirectory(prefix="holdup_tsx_ledger_") as td:
            env = dict(os.environ)
            env["GEMINI_API_KEY"] = ""
            env["LEDGER_PATH"] = str(pathlib.Path(td) / "ledger.jsonl")
            prev_np = env.get("NODE_PATH", "")
            joined_nm = ":".join(existing_nms)
            env["NODE_PATH"] = f"{joined_nm}:{prev_np}" if prev_np else joined_nm
            env["HOLDUP_VERIFY_TS"] = str(VERIFY_TS_PATH)

            proc = subprocess.run(
                [node_bin, "--import", tsx_import, "--input-type=module", "-e", js_code],
                input=json.dumps(payloads),
                text=True,
                capture_output=True,
                cwd=str(REPO_ROOT),
                env=env,
                timeout=30,
                check=True,
            )

        tagged = [
            line[len("PARITY_OUT:") :]
            for line in proc.stdout.splitlines()
            if line.startswith("PARITY_OUT:")
        ]
        if not tagged:
            raise AssertionError(f"Missing PARITY_OUT in node stdout: {proc.stdout!r} stderr={proc.stderr!r}")
        parsed = json.loads(tagged[-1])
        cls.ts_schema = parsed["schema"]
        cls.ts_reads = parsed["reads"]

    def test_inline_refs_and_label_schema_exact_parity(self) -> None:
        raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
        py_schema = run_eval.inline_refs(raw_schema)
        self.assertEqual(py_schema, self.ts_schema)

        serialized = json.dumps(py_schema)
        self.assertNotIn("$defs", serialized)
        self.assertNotIn("$comment", serialized)
        self.assertNotIn("$ref", serialized)

        for str_field in ("product", "ingredient", "strength", "dosing", "expiry", "barcode"):
            prop = py_schema["properties"][str_field]
            self.assertEqual(prop["type"], "object")
            self.assertEqual(prop["required"], ["value", "confidence"])

    def test_to_label_read_edge_payloads_exact_parity(self) -> None:
        self.assertGreaterEqual(len(self.edge_cases), 12)
        self.assertEqual(len(self.edge_cases), len(self.ts_reads))

        by_name: dict[str, dict[str, Any]] = {}
        for (name, payload), ts_read in zip(self.edge_cases, self.ts_reads):
            with self.subTest(case=name):
                py_read = run_eval.to_label_read(payload)
                self.assertEqual(py_read, ts_read)
                by_name[name] = py_read

        self.assertEqual(by_name["valid_med_iso_month"]["expiry"], {"value": "2027-08", "confidence": 0.95})
        self.assertEqual(by_name["valid_med_iso_month"]["guidance"], "Hold steady")
        self.assertEqual(
            by_name["valid_food_iso_full_date_and_allergens"]["expiry"],
            {"value": "2027-11-30", "confidence": 0.94},
        )
        self.assertEqual(
            by_name["valid_food_iso_full_date_and_allergens"]["allergens"],
            {"value": ["milk", "peanuts", "gluten"], "confidence": 0.98},
        )
        self.assertNotIn("guidance", by_name["empty_object"])
        self.assertEqual(by_name["empty_object"]["kind"], "unreadable")

        self.assertEqual(
            by_name["null_values_high_confidence_capped_at_0_3"]["product"],
            {"value": None, "confidence": 0.3},
        )
        self.assertEqual(
            by_name["null_values_high_confidence_capped_at_0_3"]["barcode"],
            {"value": None, "confidence": 0.15},
        )

        self.assertEqual(
            by_name["whitespace_strings_coerced_to_null"]["strength"],
            {"value": None, "confidence": 0.3},
        )
        self.assertEqual(
            by_name["whitespace_strings_coerced_to_null"]["allergens"],
            {"value": [], "confidence": 0.96},
        )
        self.assertNotIn("guidance", by_name["whitespace_strings_coerced_to_null"])

        self.assertEqual(by_name["out_of_bounds_high_confidences_clamped_to_1"]["strength"]["confidence"], 1.0)
        self.assertEqual(by_name["out_of_bounds_high_confidences_clamped_to_1"]["readability"], 1.0)
        self.assertEqual(by_name["out_of_bounds_negative_confidences_clamped_to_0"]["strength"]["confidence"], 0.0)
        self.assertEqual(by_name["out_of_bounds_negative_confidences_clamped_to_0"]["readability"], 0.0)
        self.assertEqual(by_name["non_numeric_confidences_default_to_0"]["product"]["confidence"], 0.0)

        self.assertEqual(
            by_name["non_iso_slash_expiry_capped_at_0_5"]["expiry"],
            {"value": "08/2027", "confidence": 0.5},
        )
        self.assertEqual(
            by_name["non_iso_nordic_dot_expiry_capped_at_0_5"]["expiry"],
            {"value": "15.08.2027", "confidence": 0.5},
        )
        self.assertEqual(
            by_name["non_iso_expiry_below_0_5_kept_unchanged"]["expiry"],
            {"value": "Aug 2027", "confidence": 0.28},
        )
        self.assertEqual(
            by_name["single_digit_month_expiry_capped_at_0_5"]["expiry"],
            {"value": "2027-8", "confidence": 0.5},
        )

        trimmed_guidance = by_name["over_120_char_guidance_trimmed_and_sliced"]["guidance"]
        self.assertEqual(len(trimmed_guidance), 120)
        self.assertTrue(trimmed_guidance.startswith("Turn the package slowly"))

        self.assertEqual(by_name["invalid_kind_string_coerced_to_unreadable"]["kind"], "unreadable")
        self.assertEqual(
            by_name["non_array_allergens_rejected_and_capped"]["allergens"],
            {"value": None, "confidence": 0.3},
        )
        self.assertEqual(by_name["mixed_array_allergens_and_scalar_fields_rejected"]["kind"], "unreadable")
        self.assertEqual(
            by_name["mixed_array_allergens_and_scalar_fields_rejected"]["allergens"],
            {"value": None, "confidence": 0.3},
        )
        self.assertEqual(
            by_name["mixed_array_allergens_and_scalar_fields_rejected"]["product"],
            {"value": None, "confidence": 0.0},
        )


class TestFieldspotterSuiteHygiene(unittest.TestCase):
    def test_strict_source_and_workspace_hygiene(self) -> None:
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, src)
        self.assertNotIn(SLASH2, src)
        self.assertNotIn(EM_DASH, src)
        self.assertNotIn(EN_DASH, src)
        self.assertNotIn("Co-Authored" + "-By", src)
        self.assertNotIn("git " + "status", src)
        self.assertNotIn("git " + "diff", src)
        self.assertEqual((REPO_ROOT / "node_modules").exists(), WORKSPACE_NM_EXISTED_AT_START)
        self.assertEqual(os.environ.get("GEMINI_API_KEY", ""), "")


if __name__ == "__main__":
    unittest.main()
