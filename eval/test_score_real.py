from __future__ import annotations

import csv
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from typing import Any

from PIL import Image, ImageDraw

sys.dont_write_bytecode = True

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
SCORE_SCRIPT = EVAL_DIR / "score_real.sh"

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)


def current_prompt_hash() -> str:
    p_txt = (REPO_ROOT / "shared" / "verify_prompt.md").read_text(encoding="utf-8")
    s_txt = (REPO_ROOT / "shared" / "label_schema.json").read_text(encoding="utf-8")
    return hashlib.sha256((p_txt + s_txt).encode("utf-8")).hexdigest()[:12]


def find_node_modules() -> pathlib.Path:
    cands = [
        REPO_ROOT / "node_modules",
        REPO_ROOT.parent / "node_modules",
        pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules"),
    ]
    for cand in cands:
        if cand.is_dir() and (cand / ".bin" / "tsx").exists():
            return cand
    raise RuntimeError("Could not locate shared node_modules with .bin/tsx")


def make_field(val: Any, conf: float) -> dict[str, Any]:
    return {"value": val, "confidence": conf}


def make_pred_read(
    kind: str,
    product: tuple[str | None, float],
    ingredient: tuple[str | None, float],
    strength: tuple[str | None, float],
    expiry: tuple[str | None, float],
    allergens: tuple[list[str] | None, float] = (None, 0.0),
    readability: float = 0.94,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "product": make_field(product[0], product[1]),
        "ingredient": make_field(ingredient[0], ingredient[1]),
        "strength": make_field(strength[0], strength[1]),
        "dosing": make_field(None, 0.0),
        "expiry": make_field(expiry[0], expiry[1]),
        "allergens": make_field(allergens[0], allergens[1]),
        "barcode": make_field(None, 0.0),
        "readability": readability,
    }


def save_mock_photo(path: pathlib.Path, color: tuple[int, int, int], fmt: str) -> None:
    im = Image.new("RGB", (96, 64), color)
    draw = ImageDraw.Draw(im)
    draw.rectangle((8, 8, 88, 56), fill=(252, 252, 252), outline=(30, 40, 50), width=2)
    im.save(path, format=fmt)


def build_clean_env(py_exec: str, work_dir: pathlib.Path | None = None, nm_dir: pathlib.Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("GEMINI_API_KEY", None)
    env["PY"] = py_exec
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    extra_bins = ["/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin", "/usr/local/bin"]
    path_parts = [p for p in extra_bins if os.path.isdir(p)]
    if env.get("PATH"):
        path_parts.append(env["PATH"])
    env["PATH"] = ":".join(path_parts)
    if work_dir is not None:
        env["HOLDUP_REAL_OUT"] = str(work_dir)
    if nm_dir is not None:
        existing_np = env.get("NODE_PATH", "")
        env["NODE_PATH"] = f"{nm_dir}:{existing_np}" if existing_np else str(nm_dir)
    return env


def setup_isolated_repo(base_dir: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    tmp_repo = base_dir / "repo"
    tmp_eval = tmp_repo / "eval"
    tmp_real = tmp_eval / "real"
    tmp_real.mkdir(parents=True, exist_ok=True)

    shutil.copy2(SCORE_SCRIPT, tmp_eval / "score_real.sh")
    for name in ("run_eval.py", "common.py", "normalize.py", "safety.py", "safety_bridge.mts", "gt_overrides.json"):
        src = EVAL_DIR / name
        if src.exists():
            os.symlink(src, tmp_eval / name)

    os.symlink(REPO_ROOT / "shared", tmp_repo / "shared")
    os.symlink(REPO_ROOT / "server", tmp_repo / "server")
    nm_dir = find_node_modules()
    os.symlink(nm_dir, tmp_repo / "node_modules")
    return tmp_repo, nm_dir


def write_mock_py_wrapper(wrapper_path: pathlib.Path, mock_preds_src: pathlib.Path, call_log_path: pathlib.Path) -> None:
    wrapper_code = "\n".join(
        [
            f"{HASH_CHAR}!{sys.executable}",
            "import json, os, pathlib, shutil, sys",
            "sys.dont_write_bytecode = True",
            f"REAL_PY = {sys.executable!r}",
            f"MOCK_PREDS = pathlib.Path({str(mock_preds_src)!r})",
            f"CALL_LOG = pathlib.Path({str(call_log_path)!r})",
            "with CALL_LOG.open('a', encoding='utf-8') as fh:",
            "    fh.write(json.dumps(sys.argv[1:]) + '\\n')",
            "if len(sys.argv) >= 3 and sys.argv[1] == 'eval/run_eval.py' and sys.argv[2] == 'predict':",
            "    out_dir = pathlib.Path(os.environ['HOLDUP_OUT'])",
            "    out_dir.mkdir(parents=True, exist_ok=True)",
            "    if MOCK_PREDS.is_file():",
            "        shutil.copy2(MOCK_PREDS, out_dir / 'preds_real.jsonl')",
            "    sys.exit(0)",
            "if len(sys.argv) >= 3 and sys.argv[1] == 'eval/run_eval.py' and sys.argv[2] == 'score':",
            "    cwd = pathlib.Path.cwd().resolve()",
            "    sys.path.insert(0, str(cwd / 'eval'))",
            "    import common, run_eval",
            "    common.REPO = cwd",
            "    common.EVAL_DIR = cwd / 'eval'",
            "    common.SHARED = cwd / 'shared'",
            "    run_eval.REPO = cwd",
            "    run_eval.EVAL_DIR = cwd / 'eval'",
            "    run_eval.SHARED = cwd / 'shared'",
            "    run_eval.REAL = cwd / 'eval' / 'real'",
            "    sys.argv = ['eval/run_eval.py', 'score']",
            "    run_eval.main()",
            "    sys.exit(0)",
            "os.execv(REAL_PY, [REAL_PY, *sys.argv[1:]])",
            "",
        ]
    )
    wrapper_path.write_text(wrapper_code, encoding="utf-8")
    wrapper_path.chmod(wrapper_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestScoreRealKeyless(unittest.TestCase):
    def test_1_empty_real_dir_exits_cleanly_with_guard(self) -> None:
        results_dir = EVAL_DIR / "results"
        before_files = sorted(p.name for p in results_dir.iterdir()) if results_dir.is_dir() else []

        with tempfile.TemporaryDirectory() as tmp:
            work_dir = pathlib.Path(tmp) / "work"
            t0 = time.monotonic()
            proc = subprocess.run(
                ["bash", str(SCORE_SCRIPT)],
                cwd=str(REPO_ROOT),
                env=build_clean_env(sys.executable, work_dir=work_dir),
                capture_output=True,
                text=True,
                timeout=15,
            )
            elapsed = time.monotonic() - t0

            self.assertLess(elapsed, 15.0)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("labels.csv rows: 1, photos found: 0", proc.stdout)
            self.assertIn("No photos in eval/real/ yet.", proc.stdout)
            self.assertFalse(work_dir.exists())

        after_files = sorted(p.name for p in results_dir.iterdir()) if results_dir.is_dir() else []
        self.assertEqual(before_files, after_files)
        self.assertFalse((results_dir / "real_results.json").exists())

    def test_2_isolated_repo_scores_real_packs_and_prints_tables(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            tmp_repo, nm_dir = setup_isolated_repo(base)
            real_dir = tmp_repo / "eval" / "real"
            work_dir = base / "work_out"

            save_mock_photo(real_dir / "amlodipin_5mg.jpg", (220, 235, 250), "JPEG")
            save_mock_photo(real_dir / "burana_400mg.jpeg", (245, 225, 220), "JPEG")
            save_mock_photo(real_dir / "metforem_500mg.jpg", (225, 245, 225), "JPEG")
            save_mock_photo(real_dir / "thyroxin_100mikrog.png", (240, 240, 220), "PNG")
            save_mock_photo(real_dir / "fazer_sininen.jpg", (215, 225, 245), "JPEG")
            save_mock_photo(real_dir / "marli_omenamehu.png", (235, 245, 215), "PNG")

            csv_fields = ["file", "kind", "product", "ingredient", "strength", "expiry", "allergens", "notes"]
            csv_rows = [
                {
                    "file": "example.jpg",
                    "kind": "medication",
                    "product": "Amlodipin Orion",
                    "ingredient": "amlodipine",
                    "strength": "5 mg",
                    "expiry": "2027-03",
                    "allergens": "",
                    "notes": "template row skipped by run_eval",
                },
                {
                    "file": "amlodipin_5mg.jpg",
                    "kind": "medication",
                    "product": "Amlodipin Orion",
                    "ingredient": "amlodipine",
                    "strength": "5 mg",
                    "expiry": "2027-08",
                    "allergens": "",
                    "notes": "front of box",
                },
                {
                    "file": "burana_400mg.jpeg",
                    "kind": "medication",
                    "product": "Burana",
                    "ingredient": "ibuprofen",
                    "strength": "400 mg",
                    "expiry": "2027-06",
                    "allergens": "",
                    "notes": "low-confidence wrong strength read",
                },
                {
                    "file": "metforem_500mg.jpg",
                    "kind": "medication",
                    "product": "Metforem",
                    "ingredient": "metformin",
                    "strength": "500 mg",
                    "expiry": "2027-09",
                    "allergens": "",
                    "notes": "confident-wrong strength read",
                },
                {
                    "file": "thyroxin_100mikrog.png",
                    "kind": "medication",
                    "product": "Thyroxin",
                    "ingredient": "levothyroxine",
                    "strength": "100 mikrog",
                    "expiry": "2025-09",
                    "allergens": "",
                    "notes": "expired box with unreadable expiry",
                },
                {
                    "file": "fazer_sininen.jpg",
                    "kind": "food",
                    "product": "Fazer Maitosuklaa",
                    "ingredient": "milk chocolate",
                    "strength": "",
                    "expiry": "2027-04",
                    "allergens": "maito, hasselpähkinä",
                    "notes": "ingredients side",
                },
                {
                    "file": "marli_omenamehu.png",
                    "kind": "food",
                    "product": "Marli Omenatäysmehu",
                    "ingredient": "apple juice",
                    "strength": "",
                    "expiry": "2027-05",
                    "allergens": "none",
                    "notes": "clear allergen-free panel",
                },
            ]
            with (real_dir / "labels.csv").open("w", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=csv_fields)
                writer.writeheader()
                writer.writerows(csv_rows)

            phash = current_prompt_hash()
            mock_preds = [
                {
                    "img_id": "real/amlodipin_5mg.jpg",
                    "pred": make_pred_read(
                        "medication",
                        ("Amlodipin Orion", 0.97),
                        ("amlodipine", 0.96),
                        ("5 mg", 0.95),
                        ("2027-08", 0.92),
                        (None, 0.0),
                        0.95,
                    ),
                    "latency_s": 2.1,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
                {
                    "img_id": "real/burana_400mg.jpeg",
                    "pred": make_pred_read(
                        "medication",
                        ("Burana", 0.94),
                        ("ibuprofen", 0.93),
                        ("200 mg", 0.55),
                        ("2027-06", 0.90),
                        (None, 0.0),
                        0.84,
                    ),
                    "latency_s": 2.6,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
                {
                    "img_id": "real/metforem_500mg.jpg",
                    "pred": make_pred_read(
                        "medication",
                        ("Metforem", 0.95),
                        ("metformin", 0.94),
                        ("250 mg", 0.91),
                        ("2027-09", 0.89),
                        (None, 0.0),
                        0.88,
                    ),
                    "latency_s": 3.1,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
                {
                    "img_id": "real/thyroxin_100mikrog.png",
                    "pred": make_pred_read(
                        "medication",
                        ("Thyroxin", 0.96),
                        ("levothyroxine", 0.95),
                        ("100 mcg", 0.94),
                        (None, 0.12),
                        (None, 0.0),
                        0.90,
                    ),
                    "latency_s": 3.4,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
                {
                    "img_id": "real/fazer_sininen.jpg",
                    "pred": make_pred_read(
                        "food",
                        ("Fazer Maitosuklaa", 0.96),
                        ("milk chocolate", 0.90),
                        (None, 0.0),
                        ("2027-04", 0.91),
                        (["milk", "hazelnut"], 0.97),
                        0.93,
                    ),
                    "latency_s": 3.8,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
                {
                    "img_id": "real/marli_omenamehu.png",
                    "pred": make_pred_read(
                        "food",
                        ("Marli Omenatäysmehu", 0.95),
                        ("apple juice", 0.92),
                        (None, 0.0),
                        ("2027-05", 0.93),
                        ([], 0.98),
                        0.95,
                    ),
                    "latency_s": 4.4,
                    "prompt_hash": phash,
                    "model": "gemini-3.8-flash",
                },
            ]
            mock_preds_path = base / "mock_preds.jsonl"
            mock_preds_path.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in mock_preds) + "\n",
                encoding="utf-8",
            )
            call_log_path = base / "py_calls.jsonl"
            mock_py = base / "mock_py.py"
            write_mock_py_wrapper(mock_py, mock_preds_path, call_log_path)

            proc = subprocess.run(
                ["bash", str(tmp_repo / "eval" / "score_real.sh")],
                cwd=str(tmp_repo),
                env=build_clean_env(str(mock_py), work_dir=work_dir, nm_dir=nm_dir),
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")

            calls = [json.loads(line) for line in call_log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(calls[0], ["eval/run_eval.py", "predict", "--set", "real", "--workers", "12"])
            self.assertEqual(calls[1], ["eval/run_eval.py", "score"])
            self.assertEqual(calls[2][0], "-")

            self.assertIn("labels.csv rows: 7, photos found: 6", proc.stdout)
            self.assertIn("Real photos scored: 6", proc.stdout)
            self.assertIn("confident-wrong", proc.stdout)
            for field_name in ("product", "ingredient", "strength", "expiry", "allergens"):
                self.assertIn(field_name, proc.stdout)
            self.assertIn("End-to-end verdicts: 15  silent unsafe reassurances: 1  not sure: 2", proc.stdout)
            self.assertIn("Saved eval/results/real_results.json.", proc.stdout)

            out_json = tmp_repo / "eval" / "results" / "real_results.json"
            self.assertTrue(out_json.is_file())
            payload = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertEqual(payload["model"], "gemini-3.8-flash")
            self.assertEqual(payload["prompt_hash"], phash)

            real = payload["real"]
            self.assertEqual(real["images_scored"], 6)
            self.assertEqual(real["errors"], 0)
            self.assertEqual(real["latency_s"]["n"], 6)

            pf = real["per_field"]
            self.assertEqual(pf["product"]["n_visible"], 6)
            self.assertEqual(pf["product"]["acc_visible"], 100.0)
            self.assertEqual(pf["product"]["confident_wrong"], 0)

            self.assertEqual(pf["strength"]["n_visible"], 4)
            self.assertEqual(pf["strength"]["acc_visible"], 50.0)
            self.assertEqual(pf["strength"]["confident_wrong"], 1)

            self.assertEqual(pf["expiry"]["n_visible"], 6)
            self.assertEqual(pf["expiry"]["abstain_visible"], 16.7)
            self.assertEqual(pf["expiry"]["confident_wrong"], 0)

            self.assertEqual(pf["allergens"]["n_visible"], 2)
            self.assertEqual(pf["allergens"]["acc_visible"], 100.0)
            self.assertEqual(pf["allergens"]["confident_wrong"], 0)

            srv = real["safety"]["server"]
            self.assertIn("safety.ts", srv["impl"])
            self.assertEqual(srv["n"], 15)
            self.assertEqual(srv["unsafe_reassurance"], 1)
            self.assertEqual(srv["expired_match_with_caveat"], 1)
            self.assertEqual(srv["unsure_k"], 2)
            self.assertEqual(srv["correct_k"], 10)
            self.assertEqual(srv["unsafe_by_category"], {"wrong_strength_matched": 1})
            self.assertEqual(srv["by_scenario"]["allergic_to_absent"]["n"], 2)
            self.assertEqual(srv["by_scenario"]["allergic_to_absent"]["correct"], 100.0)

    def test_3_unlisted_photo_without_matching_csv_row_exits_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            tmp_repo, nm_dir = setup_isolated_repo(base)
            real_dir = tmp_repo / "eval" / "real"
            work_dir = base / "work_unlisted"

            save_mock_photo(real_dir / "unlisted_only.jpg", (210, 210, 210), "JPEG")
            (real_dir / "labels.csv").write_text(
                "file,kind,product,ingredient,strength,expiry,allergens,notes\n"
                "example.jpg,medication,Amlodipin Orion,amlodipine,5 mg,2027-03,,front\n",
                encoding="utf-8",
            )
            mock_preds_path = base / "empty_preds.jsonl"
            call_log_path = base / "py_calls_empty.jsonl"
            mock_py = base / "mock_py_empty.py"
            write_mock_py_wrapper(mock_py, mock_preds_path, call_log_path)

            proc = subprocess.run(
                ["bash", str(tmp_repo / "eval" / "score_real.sh")],
                cwd=str(tmp_repo),
                env=build_clean_env(str(mock_py), work_dir=work_dir, nm_dir=nm_dir),
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertIn("labels.csv rows: 1, photos found: 1", proc.stdout)
            self.assertIn("No real results in", proc.stdout)
            self.assertFalse((tmp_repo / "eval" / "results" / "real_results.json").exists())

    def test_4_hygiene_and_untouched_score_script(self) -> None:
        self.assertTrue(os.access(SCORE_SCRIPT, os.X_OK))
        self_txt = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_txt)
        self.assertNotIn(EM_DASH, self_txt)
        self.assertNotIn(EN_DASH, self_txt)


if __name__ == "__main__":
    unittest.main()
