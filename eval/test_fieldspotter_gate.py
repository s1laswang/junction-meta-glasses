from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import unittest
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.dont_write_bytecode = True

EVAL_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
SUITE_DIR = EVAL_DIR / "suites" / "fieldspotter_coaching_gate"
RUN_PY_PATH = SUITE_DIR / "run.py"
RESULTS_JSON_PATH = SUITE_DIR / "results.json"
README_MD_PATH = SUITE_DIR / "README.md"
ONNX_PATH = REPO_ROOT / "web" / "public" / "models" / "fieldspotter.onnx"
FS_JSON_PATH = EVAL_DIR / "results" / "fieldspotter.json"
V1_JSON_PATH = EVAL_DIR / "results" / "v1_results.json"
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
SAFETY_BRIDGE_PATH = EVAL_DIR / "safety_bridge.mts"
SAFETY_TS_PATH = REPO_ROOT / "server" / "src" / "safety.ts"
TMP_IMG_DIR = pathlib.Path("/dev/shm/holdup_fs_gate")

MAX_RESULTS_BYTES = 15360
ONNX_GATE_CONF = 0.40
STRENGTH_MIN_CONF = 0.80
HASH_CHAR = chr(35)
TRIPLE_DQ = chr(34) * 3
TRIPLE_SQ = chr(39) * 3
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
API_KEY_PREFIX = "AI" + "za"
DOSE_TOKEN_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|mikrog|ml|iu|%)\b", re.IGNORECASE)
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
NODE_BINS = ("/usr/local/bin", "/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin")


def wilson_ci95_unit(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt(max(0.0, (p * (1.0 - p) + 0.25 * z2n) / n))) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def wilson_ci95_pct(k: int, n: int, z: float = 1.96) -> list[float]:
    if n <= 0:
        return [0.0, 0.0]
    p = k / n
    denom = 1.0 + (z * z) / n
    center = p + (z * z) / (2.0 * n)
    half = z * math.sqrt((p * (1.0 - p)) / n + (z * z) / (4.0 * n * n))
    return [round(100.0 * (center - half) / denom, 1), round(100.0 * (center + half) / denom, 1)]


def build_keyless_node_env() -> tuple[str, dict[str, str], str]:
    node = next((str(pathlib.Path(nb) / "node") for nb in NODE_BINS if (pathlib.Path(nb) / "node").is_file()), None)
    node = node or shutil.which("node") or "node"
    env = dict(os.environ)
    env.pop("GEMINI_API_KEY", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["HOLDUP_SAFETY_TS"] = str(SAFETY_TS_PATH)
    env["TMPDIR"] = "/dev/shm" if os.path.isdir("/dev/shm") else "/tmp"
    path_parts = [nb for nb in NODE_BINS if os.path.isdir(nb)]
    if env.get("PATH"):
        path_parts.append(env["PATH"])
    env["PATH"] = ":".join(path_parts)
    nm_candidates = [
        pathlib.Path("/tmp/fleet-root/wt/node_modules"),
        REPO_ROOT / "node_modules",
        REPO_ROOT.parent / "node_modules",
        pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules"),
    ]
    nm_dirs = [str(p) for p in nm_candidates if p.is_dir()]
    if env.get("NODE_PATH"):
        for part in env["NODE_PATH"].split(":"):
            if part and part not in nm_dirs:
                nm_dirs.append(part)
    if nm_dirs:
        env["NODE_PATH"] = ":".join(nm_dirs)
    tsx_arg = "tsx"
    if not any((pathlib.Path(d) / "tsx").exists() for d in nm_dirs):
        shared_loader = pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules/tsx/dist/loader.mjs")
        if shared_loader.is_file():
            tsx_arg = str(shared_loader)
    return node, env, tsx_arg


def run_safety_bridge(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node, env, tsx_arg = build_keyless_node_env()
    payload = "\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n"
    proc = subprocess.run(
        [node, "--import", tsx_arg, str(SAFETY_BRIDGE_PATH)],
        input=payload,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        timeout=30,
        check=True,
    )
    return [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]


def load_suite_module() -> Any:
    spec = importlib.util.spec_from_file_location("fieldspotter_coaching_gate_run", RUN_PY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {RUN_PY_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestFieldSpotterCoachingGate(unittest.TestCase):
    def test_onnx_cpu_session_and_synthetic_640x640_rgb_inference(self) -> None:
        self.assertTrue(ONNX_PATH.is_file(), f"Missing ONNX model at {ONNX_PATH}")
        fs_meta = json.loads(FS_JSON_PATH.read_text(encoding="utf-8"))
        self.assertEqual(ONNX_PATH.stat().st_size, int(fs_meta["onnx"]["bytes"]))

        sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
        self.assertEqual(sess.get_providers(), ["CPUExecutionProvider"])
        inputs = sess.get_inputs()
        outputs = sess.get_outputs()
        self.assertEqual(len(inputs), 1)
        self.assertEqual(len(outputs), 1)
        self.assertEqual(inputs[0].name, "images")
        self.assertEqual(list(inputs[0].shape), [1, 3, 640, 640])
        self.assertEqual(inputs[0].type, "tensor(float)")
        self.assertEqual(outputs[0].name, "output0")
        self.assertEqual(list(outputs[0].shape), [1, 8, 8400])
        self.assertEqual(outputs[0].type, "tensor(float)")

        synth_im = Image.new("RGB", (640, 640), (208, 202, 194))
        draw = ImageDraw.Draw(synth_im)
        draw.rounded_rectangle((120, 165, 520, 450), radius=6, fill=(240, 242, 246), outline=(160, 166, 174), width=2)
        draw.rectangle((120, 165, 520, 192), fill=(22, 98, 148))
        arr = np.asarray(synth_im, dtype=np.float32) / 255.0
        chw = np.transpose(arr, (2, 0, 1))[None, ...]
        self.assertEqual(list(chw.shape), [1, 3, 640, 640])
        self.assertEqual(chw.dtype, np.float32)

        pred = sess.run(["output0"], {"images": chw})[0]
        self.assertEqual(list(pred.shape), [1, 8, 8400])
        self.assertEqual(pred.dtype, np.float32)
        self.assertTrue(bool(np.isfinite(pred).all()))
        cls_scores = pred[0, 4:8, :]
        self.assertGreaterEqual(float(cls_scores.min()), 0.0)
        self.assertLessEqual(float(cls_scores.max()), 1.0)

        suite_mod = load_suite_module()
        clean_out = suite_mod.run_fieldspotter_cpu(sess, suite_mod.render_case_jpeg(suite_mod.CASES[0], 1))
        thumb_out = suite_mod.run_fieldspotter_cpu(sess, suite_mod.render_case_jpeg(suite_mod.CASES[4], 5))
        back_out = suite_mod.run_fieldspotter_cpu(sess, suite_mod.render_case_jpeg(suite_mod.CASES[9], 10))
        glare_out = suite_mod.run_fieldspotter_cpu(sess, suite_mod.render_case_jpeg(suite_mod.CASES[11], 12))
        self.assertTrue(clean_out["gate_pass"])
        self.assertEqual(clean_out["coach_action"], "ready_to_verify")
        self.assertFalse(thumb_out["gate_pass"])
        self.assertEqual(thumb_out["coach_action"], "slide_thumb_off_strength")
        self.assertFalse(back_out["gate_pass"])
        self.assertEqual(back_out["coach_action"], "center_or_turn_box")
        self.assertFalse(glare_out["gate_pass"])
        self.assertEqual(glare_out["coach_action"], "hold_steady_or_tilt_glare")
        self.assertFalse(TMP_IMG_DIR.exists())

    def test_held_out_confusion_counts_and_wilson_ci_consistency(self) -> None:
        fs_bytes_before = FS_JSON_PATH.read_bytes()
        fs_sha_before = hashlib.sha256(fs_bytes_before).hexdigest()
        fs = json.loads(fs_bytes_before.decode("utf-8"))
        v1 = json.loads(V1_JSON_PATH.read_text(encoding="utf-8"))
        suite_res = json.loads(RESULTS_JSON_PATH.read_text(encoding="utf-8"))
        audit = suite_res["held_out_gate_audit"]
        t1 = audit["tier1_fieldspotter_onnx_cpu"]
        t2 = audit["tier2_gemini_flash_safety_ts"]
        comb = audit["combined_two_tier_gate"]

        sv = fs["strength_visible"]
        n_val = int(fs["n_val_images"])
        tp, fp, fn, tn = int(sv["tp"]), int(sv["fp"]), int(sv["fn"]), int(sv["tn"])
        self.assertEqual((tp, fp, fn, tn, n_val), (122, 4, 64, 158, 348))
        self.assertEqual(tp + fp + fn + tn, n_val)
        self.assertEqual(float(sv["conf"]), 0.4)

        pred_pos = tp + fp
        gt_pos = tp + fn
        gt_neg = tn + fp
        self.assertEqual((pred_pos, gt_pos, gt_neg), (126, 186, 162))

        prec_pct = round(100.0 * tp / pred_pos, 1)
        rec_pct = round(100.0 * tp / gt_pos, 1)
        spec_pct = round(100.0 * tn / gt_neg, 1)
        fp_rate = round(fp / gt_neg, 4)
        prec_ci = wilson_ci95_pct(tp, pred_pos, z=1.96)
        rec_ci = wilson_ci95_pct(tp, gt_pos, z=1.96)
        prec_ci_exact = wilson_ci95_pct(tp, pred_pos, z=1.959963984540054)
        rec_ci_exact = wilson_ci95_pct(tp, gt_pos, z=1.959963984540054)

        self.assertEqual(prec_pct, 96.8)
        self.assertEqual(rec_pct, 65.6)
        self.assertEqual(spec_pct, 97.5)
        self.assertEqual(fp_rate, 0.0247)
        self.assertEqual(prec_ci, [92.1, 98.8])
        self.assertEqual(rec_ci, [58.5, 72.0])
        self.assertEqual(prec_ci_exact, prec_ci)
        self.assertEqual(rec_ci_exact, rec_ci)
        self.assertEqual(float(sv["precision"]), prec_pct)
        self.assertEqual(list(sv["precision_ci"]), prec_ci)
        self.assertEqual(float(sv["recall"]), rec_pct)
        self.assertEqual(list(sv["recall_ci"]), rec_ci)

        self.assertEqual(t1["n_val_images"], n_val)
        self.assertEqual(t1["conf_threshold"], 0.4)
        self.assertEqual((t1["tp"], t1["fp"], t1["fn"], t1["tn"]), (tp, fp, fn, tn))
        self.assertEqual(t1["strength_visible_precision_pct"], prec_pct)
        self.assertEqual(t1["strength_visible_precision_ci95_pct"], prec_ci)
        self.assertEqual(t1["strength_visible_recall_pct"], rec_pct)
        self.assertEqual(t1["strength_visible_recall_ci95_pct"], rec_ci)
        self.assertEqual(t1["hidden_strength_specificity_pct"], spec_pct)
        self.assertEqual(t1["hidden_strength_false_pass_rate"], fp_rate)
        self.assertEqual(t1["latency_onnx_cpu_p50_ms"], float(fs["latency_ms_onnx_cpu"]["p50"]))
        self.assertEqual(t1["latency_onnx_cpu_p95_ms"], float(fs["latency_ms_onnx_cpu"]["p95"]))
        self.assertEqual(t1["throughput_onnx_cpu_fps"], round(1000.0 / float(fs["latency_ms_onnx_cpu"]["p50"]), 1))

        v1_s = v1["synthetic"]["per_field"]["strength"]
        self.assertEqual(t2["conf_threshold"], float(v1["conf_threshold"]))
        self.assertEqual(t2["strength_confident_reads"], int(v1_s["k"]["confident"]))
        self.assertEqual(t2["strength_confident_wrong"], int(v1_s["confident_wrong"]))
        self.assertEqual(t2["strength_confident_wrong"], 0)
        self.assertEqual(t2["strength_rule_of_three_95_upper"], round(3.0 / int(v1_s["k"]["confident"]), 4))
        self.assertEqual(t2["hidden_strength_n"], int(v1_s["n_hidden"]))
        self.assertEqual(t2["hidden_strength_abstain_k"], int(v1_s["k"]["abstain_hidden"]))
        self.assertEqual(t2["hidden_strength_abstain_pct"], float(v1_s["abstain_hidden"]))
        self.assertEqual(t2["hidden_strength_wrong_k"], 0)
        self.assertEqual(comb["hidden_frames_coached_locally_pct"], spec_pct)
        self.assertEqual(comb["joint_confident_wrong_strength_count"], 0)

        s = suite_res["summary"]
        self.assertEqual(s["verdict_accuracy_ci95"], wilson_ci95_unit(12, 12))
        self.assertEqual(s["confident_wrong_ci95"], wilson_ci95_unit(0, 12))
        self.assertEqual(s["rule_of_three_95_upper"], 0.25)
        self.assertEqual(hashlib.sha256(FS_JSON_PATH.read_bytes()).hexdigest(), fs_sha_before)

    def test_twelve_cases_safety_bridge_reverification_and_keyless_check(self) -> None:
        raw_bytes = RESULTS_JSON_PATH.read_bytes()
        self.assertLess(len(raw_bytes), MAX_RESULTS_BYTES)
        data = json.loads(raw_bytes.decode("utf-8"))

        prompt_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
        sha12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        self.assertEqual(data["suite"], "fieldspotter_coaching_gate")
        self.assertEqual(data["prompt_sha256_12"], sha12)
        self.assertEqual(data["errors"], 0)
        self.assertEqual(data["timeouts"], 0)

        cases = data["cases"]
        self.assertEqual(len(cases), 12)
        batch = [{"read": c["read"], "profile": data["profile"], "now": data["eval_now_iso"]} for c in cases]
        verdicts = run_safety_bridge(batch)
        self.assertEqual(len(verdicts), 12)

        clean_levels: list[str] = []
        degraded_count = 0
        for c, v in zip(cases, verdicts):
            self.assertEqual(v["level"], c["predicted_level"])
            self.assertEqual(v["level"], c["expected_level"])
            self.assertEqual(v["reasons"][:4], c["reasons"])
            self.assertTrue(c["verdict_ok"])
            self.assertTrue(c["coach_ok"])
            self.assertEqual(c["coach_action"], c["expected_coach_action"])
            self.assertFalse(c["confident_wrong"])
            self.assertFalse(c["false_match"])
            self.assertFalse(c["unsafe_reassurance"])
            self.assertFalse(c["dose_leak"])
            if c["category"] == "clean_front":
                self.assertGreaterEqual(float(c["strength_box_conf"]), ONNX_GATE_CONF)
                self.assertEqual(c["coach_action"], "ready_to_verify")
                clean_levels.append(v["level"])
            else:
                degraded_count += 1
                self.assertLess(float(c["strength_box_conf"]), ONNX_GATE_CONF)
                self.assertEqual(v["level"], "unsure")
                self.assertLess(float(c["read"]["strength"]["confidence"]), STRENGTH_MIN_CONF)
                for reason in v["reasons"]:
                    if not str(reason).startswith("strength confidence "):
                        self.assertIsNone(DOSE_TOKEN_RE.search(str(reason)))

        self.assertEqual(clean_levels, ["match", "match", "match", "warning"])
        self.assertEqual(degraded_count, 8)

        _, env, _ = build_keyless_node_env()
        self.assertNotIn("GEMINI_API_KEY", env)
        proc = subprocess.run(
            [sys.executable, "-B", str(RUN_PY_PATH), "--check"],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")
        self.assertIn("OK:", proc.stdout)
        self.assertFalse(TMP_IMG_DIR.exists())

    def test_self_and_suite_hygiene(self) -> None:
        self_path = pathlib.Path(__file__).resolve()
        for py_path in (self_path, RUN_PY_PATH):
            src = py_path.read_text(encoding="utf-8")
            self.assertNotIn(HASH_CHAR, src, f"comment char found in {py_path.name}")
            self.assertNotIn(TRIPLE_DQ, src, f"triple double-quote docstring found in {py_path.name}")
            self.assertNotIn(TRIPLE_SQ, src, f"triple single-quote docstring found in {py_path.name}")
            self.assertNotIn(SLASH2, src, f"double-slash found in {py_path.name}")
            self.assertNotIn(EM_DASH, src, f"em dash found in {py_path.name}")
            self.assertNotIn(EN_DASH, src, f"en dash found in {py_path.name}")
            self.assertNotIn(API_KEY_PREFIX, src, f"API key prefix found in {py_path.name}")
            self.assertTrue(all(ord(ch) < 128 for ch in src), f"non-ASCII char found in {py_path.name}")

        for doc_path in (RESULTS_JSON_PATH, README_MD_PATH):
            txt = doc_path.read_text(encoding="utf-8")
            self.assertNotIn(HASH_CHAR, txt, f"comment char found in {doc_path.name}")
            self.assertNotIn(EM_DASH, txt, f"em dash found in {doc_path.name}")
            self.assertNotIn(EN_DASH, txt, f"en dash found in {doc_path.name}")
            self.assertNotIn(API_KEY_PREFIX, txt, f"API key prefix found in {doc_path.name}")
            self.assertTrue(all(ord(ch) < 128 for ch in txt), f"non-ASCII char found in {doc_path.name}")

        committed_imgs = [p for p in SUITE_DIR.rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXTS]
        self.assertEqual(committed_imgs, [])


if __name__ == "__main__":
    unittest.main()
