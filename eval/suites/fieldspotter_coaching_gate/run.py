import argparse
import base64
import datetime
import hashlib
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import numpy as np
import onnxruntime as ort
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BINS = ("/usr/local/bin", "/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = "fieldspotter_coaching_gate"
TMP_IMG_DIR = pathlib.Path("/dev/shm/holdup_fs_gate")
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
ONNX_REL = "web/public/models/fieldspotter.onnx"
ONNX_PATH = REPO / ONNX_REL
FS_EVAL_REL = "eval/results/fieldspotter.json"
V1_EVAL_REL = "eval/results/v1_results.json"
VERIFY_PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_BRIDGE_PATH = REPO / "eval" / "safety_bridge.mts"
SAFETY_TS_PATH = REPO / "server" / "src" / "safety.ts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T18:00:00Z"
ONNX_GATE_CONF = 0.40
STRENGTH_MIN_CONF = 0.80
MAX_RESULTS_BYTES = 15360
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{8,}")
B64_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")
DOSE_TOKEN_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|mikrog|ml|iu|%)\b", re.IGNORECASE)
FONT_BOLD_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CARTON_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {
        "title": "Amlodipine Orion",
        "sub": "amlodipine",
        "str": "5 mg",
        "exp": "EXP 2027-10",
        "accent": (22, 98, 148),
    },
    "aml10": {
        "title": "Amlodipine Orion",
        "sub": "amlodipine",
        "str": "10 mg",
        "exp": "EXP 2027-10",
        "accent": (22, 98, 148),
    },
    "met500": {
        "title": "Metformin Orion",
        "sub": "metformin hydrochloride",
        "str": "500 mg",
        "exp": "EXP 2027-12",
        "accent": (36, 112, 88),
    },
    "ato20": {
        "title": "Atorvastatin Krka",
        "sub": "atorvastatin",
        "str": "20 mg",
        "exp": "EXP 2027-11",
        "accent": (88, 52, 136),
    },
    "ibu400": {
        "title": "Burana Ibuprofen",
        "sub": "ibuprofen / ibuprofeeni",
        "str": "400 mg",
        "exp": "EXP 2027-09",
        "accent": (186, 34, 42),
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "fsg_01",
        "category": "clean_front",
        "mode": "clean",
        "pack": "aml5",
        "degraded": False,
        "world_level": "match",
        "expected_level": "match",
        "expected_str": "5 mg",
        "expected_gate_pass": True,
        "expected_coach_action": "ready_to_verify",
        "question": "Is this my evening pill?",
        "desc": "Clean front glasses-POV carton of Amlodipine Orion 5 mg",
    },
    {
        "id": "fsg_02",
        "category": "clean_front",
        "mode": "clean",
        "pack": "met500",
        "degraded": False,
        "world_level": "match",
        "expected_level": "match",
        "expected_str": "500 mg",
        "expected_gate_pass": True,
        "expected_coach_action": "ready_to_verify",
        "question": "Is this my morning pill?",
        "desc": "Clean front glasses-POV carton of Metformin Orion 500 mg",
    },
    {
        "id": "fsg_03",
        "category": "clean_front",
        "mode": "clean",
        "pack": "ato20",
        "degraded": False,
        "world_level": "match",
        "expected_level": "match",
        "expected_str": "20 mg",
        "expected_gate_pass": True,
        "expected_coach_action": "ready_to_verify",
        "question": "Is this my evening cholesterol pill?",
        "desc": "Clean front glasses-POV carton of Atorvastatin Krka 20 mg",
    },
    {
        "id": "fsg_04",
        "category": "clean_front",
        "mode": "clean",
        "pack": "ibu400",
        "degraded": False,
        "world_level": "warning",
        "expected_level": "warning",
        "expected_str": "400 mg",
        "expected_gate_pass": True,
        "expected_coach_action": "ready_to_verify",
        "question": "Can I take this for a headache?",
        "desc": "Clean front glasses-POV carton of Burana Ibuprofen 400 mg (NSAID avoid)",
    },
    {
        "id": "fsg_05",
        "category": "thumb_occlusion",
        "mode": "thumb",
        "pack": "aml5",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "slide_thumb_off_strength",
        "question": "Is this my evening pill?",
        "desc": "Skin-toned thumb occluding 5 mg strength on Amlodipine Orion while product name stays clear",
    },
    {
        "id": "fsg_06",
        "category": "thumb_occlusion",
        "mode": "thumb",
        "pack": "met500",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "slide_thumb_off_strength",
        "question": "Is this my morning pill?",
        "desc": "Skin-toned thumb occluding 500 mg strength on Metformin Orion while product name stays clear",
    },
    {
        "id": "fsg_07",
        "category": "thumb_occlusion",
        "mode": "thumb",
        "pack": "ato20",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "slide_thumb_off_strength",
        "question": "Is this my evening cholesterol pill?",
        "desc": "Skin-toned thumb occluding 20 mg strength on Atorvastatin Krka while product name stays clear",
    },
    {
        "id": "fsg_08",
        "category": "thumb_occlusion",
        "mode": "thumb",
        "pack": "aml10",
        "degraded": True,
        "world_level": "warning",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "slide_thumb_off_strength",
        "question": "Is this my evening pill?",
        "desc": "Skin-toned thumb occluding 10 mg wrong-strength trap on Amlodipine Orion while name stays clear",
    },
    {
        "id": "fsg_09",
        "category": "crop_or_back",
        "mode": "edge_crop",
        "pack": "aml5",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "center_or_turn_box",
        "question": "Is this my evening pill?",
        "desc": "Bottom-edge off-frame crop cutting off 5 mg strength below frame border",
    },
    {
        "id": "fsg_10",
        "category": "crop_or_back",
        "mode": "barcode_back",
        "pack": "aml5",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "center_or_turn_box",
        "question": "Is this my evening pill?",
        "desc": "Back-of-box EAN-13 barcode-only view with no visible drug name or strength",
    },
    {
        "id": "fsg_11",
        "category": "blur_or_glare",
        "mode": "motion_blur",
        "pack": "met500",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "hold_steady_or_tilt_glare",
        "question": "Is this my morning pill?",
        "desc": "Heavy glasses-POV motion blur smearing Metformin 500 mg digits",
    },
    {
        "id": "fsg_12",
        "category": "blur_or_glare",
        "mode": "glare_hotspot",
        "pack": "ato20",
        "degraded": True,
        "world_level": "match",
        "expected_level": "unsure",
        "expected_str": None,
        "expected_gate_pass": False,
        "expected_coach_action": "hold_steady_or_tilt_glare",
        "question": "Is this my evening cholesterol pill?",
        "desc": "Specular ceiling-lamp glare hotspot saturating 20 mg strength on Atorvastatin Krka",
    },
]


def font_bold(sz: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if os.path.isfile(FONT_BOLD_PATH):
        return ImageFont.truetype(FONT_BOLD_PATH, sz)
    return ImageFont.load_default(size=sz)


def font_reg(sz: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if os.path.isfile(FONT_REG_PATH):
        return ImageFont.truetype(FONT_REG_PATH, sz)
    return ImageFont.load_default(size=sz)


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        cleaned = (
            v.replace(EM_DASH, " - ")
            .replace(EN_DASH, "-")
            .replace(HASH_CHAR, "")
            .replace(SLASH2, "/")
            .replace("\u00b5", "u")
            .replace("\u03bc", "u")
        )
        s = KEY_RE.sub("[REDACTED]", cleaned)
        return s.encode("ascii", "ignore").decode("ascii")
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, dict):
        return {sanitize(str(k)): sanitize(val) for k, val in v.items()}
    return v


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    candidates = [
        pathlib.Path.home() / "momin" / ".env",
        REPO / ".env",
        pathlib.Path("/tmp/fleet-root/.env"),
    ]
    for p in candidates:
        if p.is_file():
            for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, val = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), val.strip().strip('"').strip("'"))


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    defs = (node.get("$defs") or {}) if (defs is None and isinstance(node, dict)) else defs
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str) and defs is not None:
            return inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def load_prompt_and_schema() -> tuple[str, dict[str, Any], str]:
    prompt_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
    schema = inline_refs(json.loads(schema_txt))
    sha12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    return prompt_txt, schema, sha12


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt(max(0.0, (p * (1.0 - p) + 0.25 * z2n) / n))) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def build_held_out_gate_audit() -> dict[str, Any]:
    fs = json.loads((REPO / FS_EVAL_REL).read_text(encoding="utf-8"))
    v1 = json.loads((REPO / V1_EVAL_REL).read_text(encoding="utf-8"))
    sv = fs["strength_visible"]
    cpu_lat = fs["latency_ms_onnx_cpu"]
    v1_s = v1["synthetic"]["per_field"]["strength"]
    v1_lat = v1["synthetic"]["latency_s"]

    n_val = int(fs["n_val_images"])
    tp, fp, fn, tn = int(sv["tp"]), int(sv["fp"]), int(sv["fn"]), int(sv["tn"])
    assert n_val == 348 and tp + fp + fn + tn == n_val
    assert float(sv["conf"]) == 0.4
    assert tp == 122 and fp == 4 and fn == 64 and tn == 158
    assert float(sv["precision"]) == 96.8 and list(sv["precision_ci"]) == [92.1, 98.8]
    assert float(sv["recall"]) == 65.6 and list(sv["recall_ci"]) == [58.5, 72.0]
    assert float(cpu_lat["p50"]) == 34.5 and float(cpu_lat["p95"]) == 35.3

    cw_s = int(v1_s["confident_wrong"])
    conf_n = int(v1_s["k"]["confident"])
    hid_n = int(v1_s["n_hidden"])
    hid_abs_k = int(v1_s["k"]["abstain_hidden"])
    hid_abs_pct = float(v1_s["abstain_hidden"])
    hid_wrong_k = int(v1_s["k"]["wrong_hidden"])
    assert cw_s == 0 and conf_n == 754 and hid_abs_pct == 98.4 and hid_wrong_k == 0

    neg_total = tn + fp
    spec_pct = round(100.0 * tn / neg_total, 1)
    fp_rate = round(fp / neg_total, 4)
    verify_p50_ms = round(float(v1_lat["p50"]) * 1000.0, 1)
    verify_p95_ms = round(float(v1_lat["p95"]) * 1000.0, 1)
    hid_non_abs_rate = (hid_n - hid_abs_k) / hid_n
    r3_tier2 = 3.0 / conf_n

    return {
        "sources": [FS_EVAL_REL, V1_EVAL_REL],
        "tier1_fieldspotter_onnx_cpu": {
            "n_val_images": n_val,
            "conf_threshold": float(sv["conf"]),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "tn": tn,
            "strength_visible_precision_pct": float(sv["precision"]),
            "strength_visible_precision_ci95_pct": [float(x) for x in sv["precision_ci"]],
            "strength_visible_recall_pct": float(sv["recall"]),
            "strength_visible_recall_ci95_pct": [float(x) for x in sv["recall_ci"]],
            "hidden_strength_specificity_pct": spec_pct,
            "hidden_strength_false_pass_rate": fp_rate,
            "latency_onnx_cpu_p50_ms": float(cpu_lat["p50"]),
            "latency_onnx_cpu_p95_ms": float(cpu_lat["p95"]),
            "throughput_onnx_cpu_fps": round(1000.0 / float(cpu_lat["p50"]), 1),
        },
        "tier2_gemini_flash_safety_ts": {
            "conf_threshold": float(v1["conf_threshold"]),
            "strength_confident_reads": conf_n,
            "strength_confident_wrong": cw_s,
            "strength_confident_wrong_rate": 0.0,
            "strength_rule_of_three_95_upper": round(r3_tier2, 4),
            "hidden_strength_n": hid_n,
            "hidden_strength_abstain_k": hid_abs_k,
            "hidden_strength_abstain_pct": hid_abs_pct,
            "hidden_strength_wrong_k": hid_wrong_k,
            "verify_latency_p50_ms": verify_p50_ms,
            "verify_latency_p95_ms": verify_p95_ms,
        },
        "combined_two_tier_gate": {
            "hidden_frames_coached_locally_pct": spec_pct,
            "local_coach_speedup_vs_verify_p50_x": round(verify_p50_ms / float(cpu_lat["p50"]), 1),
            "independent_hidden_non_abstain_rate": round((fp / neg_total) * hid_non_abs_rate, 6),
            "joint_confident_wrong_strength_count": 0,
            "joint_confident_wrong_95_upper": round((fp / neg_total) * r3_tier2, 6),
        },
    }


def make_room_bg(seed: int) -> Image.Image:
    rng = random.Random(seed)
    im = Image.new("RGB", (640, 640), (195, 186, 174))
    d = ImageDraw.Draw(im)
    for y in range(640):
        v = int(214 - 0.11 * y + rng.randint(-2, 2))
        d.line((0, y, 640, y), fill=(v, v - 8, v - 18))
    d.rectangle((40, 30, 260, 220), fill=(224, 230, 235))
    d.rectangle((0, 420, 640, 640), fill=(154, 128, 102))
    return im.filter(ImageFilter.GaussianBlur(6))


def draw_front_carton(im: Image.Image, x0: int, y0: int, spec: dict[str, Any], show_hand: bool = True) -> Image.Image:
    x1, y1 = x0 + 400, y0 + 285
    accent = spec["accent"]
    d = ImageDraw.Draw(im)
    if show_hand:
        d.polygon([(35, 640), (x0 + 10, y1 - 15), (x0 + 125, y1 + 5), (170, 640)], fill=(214, 170, 142))
    d.polygon([(x0, y0), (x0 + 18, y0 - 16), (x1 + 18, y0 - 16), (x1, y0)], fill=(224, 228, 234))
    d.polygon([(x1, y0), (x1 + 18, y0 - 16), (x1 + 18, y1 - 16), (x1, y1)], fill=(198, 204, 212))
    d.rounded_rectangle((x0, y0, x1, y1), radius=6, fill=(238, 240, 244), outline=(162, 168, 176), width=2)
    d.rectangle((x0, y0, x1, y0 + 26), fill=accent)
    d.text((x0 + 28, y0 + 38), spec["title"], fill=(18, 24, 32), font=font_bold(32))
    d.text((x0 + 28, y0 + 80), spec["sub"], fill=(58, 66, 76), font=font_reg(18))
    d.text((x0 + 35, y0 + 136), spec["str"], fill=accent, font=font_bold(28))
    d.text((x0 + 28, y0 + 196), "30 film-coated tablets", fill=(68, 74, 82), font=font_reg(17))
    d.text((x0 + 28, y0 + 232), spec["exp"], fill=(32, 38, 46), font=font_reg(18))
    return im


def render_case_jpeg(case: dict[str, Any], idx: int) -> bytes:
    bg = make_room_bg(100 + idx)
    spec = CARTON_SPECS[case["pack"]]
    mode = case["mode"]
    if mode == "clean":
        im = draw_front_carton(bg, 120, 165, spec)
    elif mode == "thumb":
        im = draw_front_carton(bg, 120, 165, spec)
        d = ImageDraw.Draw(im)
        d.polygon([(40, 355), (138, 294), (288, 296), (288, 344), (135, 352), (40, 405)], fill=(218, 172, 142))
        d.rounded_rectangle((132, 294, 296, 344), radius=24, fill=(218, 172, 142), outline=(176, 132, 104), width=2)
        d.rounded_rectangle((250, 302, 288, 336), radius=12, fill=(238, 206, 186), outline=(190, 150, 126), width=1)
    elif mode == "edge_crop":
        im = bg
        card = Image.new("RGB", (420, 280), (238, 240, 244))
        dc = ImageDraw.Draw(card)
        dc.rectangle((0, 0, 420, 26), fill=spec["accent"])
        dc.text((28, 38), spec["title"], fill=(18, 24, 32), font=font_bold(32))
        dc.text((28, 80), spec["sub"], fill=(58, 66, 76), font=font_reg(18))
        im.paste(card.crop((0, 0, 420, 116)), (110, 524))
    elif mode == "barcode_back":
        im = bg
        db = ImageDraw.Draw(im)
        db.polygon([(35, 640), (130, 425), (245, 445), (170, 640)], fill=(214, 170, 142))
        db.rounded_rectangle((120, 165, 520, 445), radius=6, fill=(238, 240, 244), outline=(162, 168, 176), width=2)
        rng = random.Random(77)
        bx = 200
        while bx < 430:
            bw = rng.choice((2, 3, 5))
            db.rectangle((bx, 225, bx + bw, 335), fill=(16, 18, 22))
            bx += bw + rng.choice((2, 3, 4))
        db.text((215, 344), "6432100084410", fill=(20, 24, 30), font=font_reg(22))
    elif mode == "motion_blur":
        base = draw_front_carton(bg, 120, 165, spec)
        acc: Image.Image | None = None
        for idx_s, dx in enumerate(range(-64, 68, 4)):
            sh = Image.new("RGB", (640, 640), (185, 175, 162))
            sh.paste(base, (dx, (idx_s % 5 - 2) * 6))
            acc = sh if acc is None else Image.blend(acc, sh, 1.0 / (idx_s + 1))
        assert acc is not None
        im = acc.filter(ImageFilter.GaussianBlur(11.0))
    elif mode == "glare_hotspot":
        base = draw_front_carton(bg, 120, 165, spec)
        ov = Image.new("RGBA", (640, 640), (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.ellipse((95, 258, 355, 378), fill=(255, 255, 252, 245))
        ov = ov.filter(ImageFilter.GaussianBlur(15))
        od2 = ImageDraw.Draw(ov)
        od2.ellipse((135, 286, 300, 350), fill=(255, 255, 255, 255))
        im = Image.alpha_composite(base.convert("RGBA"), ov).convert("RGB")
    else:
        raise ValueError(f"unknown mode: {mode}")

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def load_cpu_onnx_session() -> ort.InferenceSession:
    assert ONNX_PATH.is_file(), f"missing ONNX model: {ONNX_PATH}"
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    assert sess.get_providers() == ["CPUExecutionProvider"], f"unexpected providers: {sess.get_providers()}"
    inp = sess.get_inputs()[0]
    out_meta = sess.get_outputs()[0]
    assert inp.name == "images" and list(inp.shape) == [1, 3, 640, 640]
    assert out_meta.name == "output0" and list(out_meta.shape) == [1, 8, 8400]
    warm = sess.run(["output0"], {"images": np.zeros((1, 3, 640, 640), dtype=np.float32)})[0]
    assert list(warm.shape) == [1, 8, 8400]
    return sess


def run_fieldspotter_cpu(sess: ort.InferenceSession, jpeg_bytes: bytes) -> dict[str, Any]:
    im640 = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB").resize((640, 640), Image.Resampling.BILINEAR)
    arr = np.asarray(im640, dtype=np.float32) / 255.0
    inp = np.transpose(arr, (2, 0, 1))[None, ...]
    assert list(inp.shape) == [1, 3, 640, 640] and inp.dtype == np.float32
    t0 = time.perf_counter()
    out = sess.run(["output0"], {"images": inp})[0]
    onnx_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    assert list(out.shape) == [1, 8, 8400]

    pi = int(out[0, 4, :].argmax())
    si = int(out[0, 5, :].argmax())
    pconf = round(float(out[0, 4, pi]), 4)
    sconf = round(float(out[0, 5, si]), 4)
    px, py, pw, ph = [float(x) for x in out[0, 0:4, pi]]

    if sconf >= ONNX_GATE_CONF:
        action = "ready_to_verify"
    else:
        gray = arr.mean(axis=2)
        lap = float(np.var(gray[1:-1, 1:-1] * 4 - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:]))
        glare = float(((arr[:, :, 0] > 0.99) & (arr[:, :, 1] > 0.99) & (arr[:, :, 2] > 0.985)).mean())
        if lap < 0.001 or glare > 0.02:
            action = "hold_steady_or_tilt_glare"
        elif pconf >= ONNX_GATE_CONF and (py + ph * 2.2 > 600.0 or px - pw * 0.5 < 16.0 or px + pw * 0.5 > 624.0):
            action = "center_or_turn_box"
        elif pconf >= ONNX_GATE_CONF:
            y_lo = max(0, min(639, int(py + ph * 1.4)))
            y_hi = max(y_lo + 1, min(640, int(py + ph * 3.8)))
            x_lo = max(0, min(639, int(px - pw * 0.55)))
            x_hi = max(x_lo + 1, min(640, int(px + pw * 0.15)))
            sub = arr[y_lo:y_hi, x_lo:x_hi]
            skin = (
                float(
                    (
                        (sub[:, :, 0] > 0.65)
                        & (sub[:, :, 0] > sub[:, :, 1])
                        & (sub[:, :, 1] > sub[:, :, 2])
                        & ((sub[:, :, 0] - sub[:, :, 2]) > 0.16)
                    ).mean()
                )
                if sub.size
                else 0.0
            )
            action = "slide_thumb_off_strength" if skin > 0.25 else "center_or_turn_box"
        else:
            action = "center_or_turn_box"

    return {
        "onnx_ms": onnx_ms,
        "product_box_conf": pconf,
        "strength_box_conf": sconf,
        "gate_pass": bool(sconf >= ONNX_GATE_CONF),
        "coach_action": action,
    }


def to_label_read(j: Any) -> dict[str, Any]:
    def clamp(x: Any) -> float:
        return max(0.0, min(1.0, float(x))) if isinstance(x, (int, float)) and not isinstance(x, bool) else 0.0

    def is_s(v: Any) -> bool:
        return isinstance(v, str) and v.strip() != ""

    def is_a(v: Any) -> bool:
        return isinstance(v, list) and all(isinstance(s, str) for s in v)

    def fld(x: Any, ok_fn: Any) -> dict[str, Any]:
        val = sanitize(x.get("value")) if isinstance(x, dict) and ok_fn(x.get("value")) else None
        conf = clamp(x.get("confidence") if isinstance(x, dict) else 0.0)
        return {"value": val, "confidence": round(min(conf, 0.3) if val is None else conf, 4)}

    if not isinstance(j, dict):
        j = {}
    kind = j.get("kind") if j.get("kind") in ("medication", "food", "other", "unreadable") else "unreadable"
    rd: dict[str, Any] = {
        "kind": kind,
        "product": fld(j.get("product"), is_s),
        "ingredient": fld(j.get("ingredient"), is_s),
        "strength": fld(j.get("strength"), is_s),
        "dosing": fld(j.get("dosing"), is_s),
        "expiry": fld(j.get("expiry"), is_s),
        "allergens": fld(j.get("allergens"), is_a),
        "barcode": fld(j.get("barcode"), is_s),
        "readability": round(clamp(j.get("readability")), 4),
    }
    if is_s(j.get("guidance")):
        rd["guidance"] = str(sanitize(j["guidance"])).strip()[:100]
    if rd["expiry"]["value"] and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", str(rd["expiry"]["value"])):
        rd["expiry"]["confidence"] = min(rd["expiry"]["confidence"], 0.5)
    return sanitize(rd)


def call_flash_verify(api_key: str, prompt: str, schema: dict[str, Any], frame_b64: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [
        {"inlineData": {"mimeType": "image/jpeg", "data": frame_b64}},
        {"text": f'The person asked: "{question}"'},
    ]
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }
    sess = requests.Session()
    last = "failed"
    timed_out = False
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "read": to_label_read(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": timed_out}


def find_node_and_env() -> tuple[str, dict[str, str], str]:
    node = next((str(pathlib.Path(nb) / "node") for nb in NODE_BINS if (pathlib.Path(nb) / "node").is_file()), None)
    node = node or shutil.which("node") or "node"
    env = dict(os.environ)
    env["HOLDUP_SAFETY_TS"] = str(SAFETY_TS_PATH)
    env["TMPDIR"] = "/dev/shm" if os.path.isdir("/dev/shm") else "/tmp"
    nm_candidates = [
        pathlib.Path("/tmp/fleet-root/wt/node_modules"),
        REPO / "node_modules",
        REPO.parent / "node_modules",
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


def run_safety_bridge(reads: list[dict[str, Any]], profile: dict[str, Any], now_iso: str) -> list[dict[str, Any]]:
    node, env, tsx_arg = find_node_and_env()
    lines_in = "\n".join(json.dumps({"read": r, "profile": profile, "now": now_iso}, separators=(",", ":")) for r in reads) + "\n"
    proc = subprocess.run(
        [node, "--import", tsx_arg, str(SAFETY_BRIDGE_PATH)],
        input=lines_in,
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=env,
        timeout=30,
        check=True,
    )
    out = [sanitize(json.loads(ln)) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(out) == len(reads), f"expected {len(reads)} bridge lines, got {len(out)}"
    return out


def norm_str_token(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower().replace(",", "."))


def evaluate_case(case: dict[str, Any], fs_info: dict[str, Any], read: dict[str, Any], bridge_v: dict[str, Any], latency_ms: float) -> dict[str, Any]:
    pred = str(bridge_v["level"])
    exp = str(case["expected_level"])
    s_val = read["strength"]["value"]
    s_conf = float(read["strength"]["confidence"])
    reasons = [str(x) for x in (bridge_v.get("reasons") or [])][:4]

    if case["degraded"]:
        cw_dose = bool(s_conf >= STRENGTH_MIN_CONF)
    else:
        cw_dose = bool(s_conf >= STRENGTH_MIN_CONF and (s_val is None or norm_str_token(str(s_val)) != norm_str_token(case["expected_str"])))

    low_conf_leak = False
    if s_conf < STRENGTH_MIN_CONF:
        if pred == "match":
            low_conf_leak = True
        for r_txt in reasons:
            if not r_txt.startswith("strength confidence ") and DOSE_TOKEN_RE.search(r_txt):
                low_conf_leak = True

    false_match = bool(pred == "match" and exp != "match")
    unsafe_reassurance = bool(case["world_level"] == "warning" and pred in ("match", "info"))
    cw = bool(cw_dose or false_match or unsafe_reassurance or low_conf_leak)

    gate_ok = bool(fs_info["gate_pass"] == case["expected_gate_pass"])
    coach_ok = bool(fs_info["coach_action"] == case["expected_coach_action"] and gate_ok)
    verdict_ok = bool(pred == exp and not cw and coach_ok)

    return sanitize({
        "id": case["id"],
        "category": case["category"],
        "description": case["desc"],
        "question": case["question"],
        "expected_level": exp,
        "predicted_level": pred,
        "verdict_ok": verdict_ok,
        "confident_wrong": cw,
        "false_match": false_match,
        "unsafe_reassurance": unsafe_reassurance,
        "dose_leak": low_conf_leak,
        "onnx_ms": fs_info["onnx_ms"],
        "product_box_conf": fs_info["product_box_conf"],
        "strength_box_conf": fs_info["strength_box_conf"],
        "expected_coach_action": case["expected_coach_action"],
        "coach_action": fs_info["coach_action"],
        "coach_ok": coach_ok,
        "latency_ms": latency_ms,
        "reasons": reasons,
        "read": read,
    })


def format_compact_results(payload: dict[str, Any]) -> str:
    top_parts: list[str] = ["{"]
    keys = [k for k in payload.keys() if k != "cases"]
    for k in keys:
        top_parts.append(f'"{k}":{json.dumps(payload[k], separators=(",", ":"), ensure_ascii=True)},')
    top_parts.append('"cases":[')
    case_lines = [json.dumps(c, separators=(",", ":"), ensure_ascii=True) for c in payload["cases"]]
    top_parts.append(",\n".join(case_lines))
    top_parts.append("]}")
    return "\n".join(top_parts) + "\n"


def check_existing() -> int:
    t0 = time.perf_counter()
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"

    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= MAX_RESULTS_BYTES, f"results.json size {len(raw_bytes)} > {MAX_RESULTS_BYTES}"
    raw_txt = raw_bytes.decode("utf-8")
    assert HASH_CHAR not in raw_txt and SLASH2 not in raw_txt and EM_DASH not in raw_txt and EN_DASH not in raw_txt
    assert not KEY_RE.search(raw_txt) and not B64_RE.search(raw_txt)
    assert all(ord(ch) < 128 for ch in raw_txt), "non-ASCII in results.json"

    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert HASH_CHAR not in readme_txt and SLASH2 not in readme_txt and EM_DASH not in readme_txt and EN_DASH not in readme_txt
        assert not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"

    data = json.loads(raw_txt)
    _, _, sha12 = load_prompt_and_schema()
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE and data["prompt_sha256_12"] == sha12
    assert data["onnx_model"] == ONNX_REL
    assert data["errors"] == 0 and data["timeouts"] == 0
    assert data["held_out_gate_audit"] == build_held_out_gate_audit()

    sess = load_cpu_onnx_session()
    probe_clean = run_fieldspotter_cpu(sess, render_case_jpeg(CASES[0], 1))
    probe_thumb = run_fieldspotter_cpu(sess, render_case_jpeg(CASES[4], 5))
    assert probe_clean["strength_box_conf"] >= ONNX_GATE_CONF and probe_clean["coach_action"] == "ready_to_verify"
    assert probe_thumb["product_box_conf"] >= ONNX_GATE_CONF and probe_thumb["strength_box_conf"] < ONNX_GATE_CONF
    assert probe_thumb["coach_action"] == "slide_thumb_off_strength"
    assert not TMP_IMG_DIR.exists()

    cases = data["cases"]
    case_defs = {c["id"]: c for c in CASES}
    assert len(cases) == len(CASES) == 12
    re_verdicts = run_safety_bridge([c["read"] for c in cases], data["profile"], data["eval_now_iso"])
    for c, rv in zip(cases, re_verdicts):
        cdef = case_defs[c["id"]]
        fs_saved = {
            "onnx_ms": c["onnx_ms"],
            "product_box_conf": c["product_box_conf"],
            "strength_box_conf": c["strength_box_conf"],
            "gate_pass": bool(c["strength_box_conf"] >= ONNX_GATE_CONF),
            "coach_action": c["coach_action"],
        }
        re_eval = evaluate_case(cdef, fs_saved, c["read"], rv, float(c["latency_ms"]))
        assert re_eval["predicted_level"] == c["predicted_level"] == cdef["expected_level"]
        assert re_eval["reasons"] == c["reasons"]
        assert re_eval["verdict_ok"] is True and c["verdict_ok"] is True
        assert re_eval["coach_ok"] is True and c["coach_ok"] is True
        assert re_eval["confident_wrong"] is False and c["confident_wrong"] is False
        assert re_eval["false_match"] is False and c["false_match"] is False
        assert re_eval["unsafe_reassurance"] is False and c["unsafe_reassurance"] is False
        assert re_eval["dose_leak"] is False and c["dose_leak"] is False

    s = data["summary"]
    assert s["n_cases"] == 12
    assert s["errors"] == 0 and s["timeouts"] == 0
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"]) == 12
    assert s["verdict_accuracy"] == 1.0
    assert s["verdict_accuracy_ci95"] == wilson_ci95(12, 12)
    assert s["confident_wrong_count"] == 0
    assert s["confident_wrong_ci95"] == wilson_ci95(0, 12)
    assert s["false_match_count"] == 0 and s["unsafe_reassurance_count"] == 0 and s["low_conf_dose_leak_count"] == 0
    assert s["fieldspotter_gate_matches"] == 12 and s["coach_cue_matches"] == 12
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure") == 8

    elapsed_s = round(time.perf_counter() - t0, 3)
    assert elapsed_s < 3.0, f"--check exceeded 3s budget: {elapsed_s}s"
    print("OK:", json.dumps({"check_s": elapsed_s, "summary": s}))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()

    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")

    prompt_txt, schema, sha12 = load_prompt_and_schema()
    audit = build_held_out_gate_audit()
    sess = load_cpu_onnx_session()
    workers = max(1, min(4, int(args.workers)))

    TMP_IMG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            raw_jpg = render_case_jpeg(c, idx)
            img_path = TMP_IMG_DIR / f"{c['id']}.jpg"
            img_path.write_bytes(raw_jpg)
            fs_info = run_fieldspotter_cpu(sess, img_path.read_bytes())
            rendered.append({
                "case": c,
                "fs": fs_info,
                "b64": base64.b64encode(raw_jpg).decode("ascii"),
            })

        with ThreadPoolExecutor(max_workers=workers) as ex:
            api_outs = list(
                ex.map(
                    lambda r: call_flash_verify(api_key, prompt_txt, schema, r["b64"], r["case"]["question"]),
                    rendered,
                )
            )
    finally:
        shutil.rmtree(TMP_IMG_DIR, ignore_errors=True)

    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    timeouts = sum(1 for o in api_outs if o.get("timeout"))
    if errors or timeouts:
        errs = [f"{r['case']['id']}:{o.get('err')}" for r, o in zip(rendered, api_outs) if not o.get("ok")]
        raise RuntimeError(f"API errors={errors} timeouts={timeouts} details={errs}")

    reads = [o["read"] for o in api_outs]
    bridge_verdicts = run_safety_bridge(reads, PROFILE, NOW_ISO)

    cases_out: list[dict[str, Any]] = []
    for r, o, bv in zip(rendered, api_outs, bridge_verdicts):
        row = evaluate_case(r["case"], r["fs"], o["read"], bv, float(o["ms"]))
        cases_out.append(row)
        print(
            f"[{row['id']}] p_box={row['product_box_conf']:.3f} s_box={row['strength_box_conf']:.3f} "
            f"coach={row['coach_action']} exp={row['expected_level']} pred={row['predicted_level']} "
            f"ok={row['verdict_ok']} onnx_ms={row['onnx_ms']} api_ms={row['latency_ms']}"
        )

    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["unsafe_reassurance"])
    dl_n = sum(1 for x in cases_out if x["dose_leak"])
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    coach_n = sum(1 for x in cases_out if x["coach_ok"])
    onnx_lats = [float(x["onnx_ms"]) for x in cases_out]
    api_lats = [float(x["latency_ms"]) for x in cases_out]

    summary = {
        "n_cases": n,
        "errors": errors,
        "timeouts": timeouts,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "low_conf_dose_leak_count": dl_n,
        "abstain_or_unsure_count": abs_n,
        "fieldspotter_gate_matches": coach_n,
        "fieldspotter_gate_accuracy": round(coach_n / n, 4),
        "coach_cue_matches": coach_n,
        "onnx_p50_ms": pctile(onnx_lats, 0.50),
        "onnx_p95_ms": pctile(onnx_lats, 0.95),
        "latency_p50_ms": pctile(api_lats, 0.50),
        "latency_p95_ms": pctile(api_lats, 0.95),
    }

    payload = sanitize({
        "suite": SUITE_NAME,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": sha12,
        "onnx_model": ONNX_REL,
        "onnx_provider": "CPUExecutionProvider",
        "onnx_gate_conf": ONNX_GATE_CONF,
        "safety_module": "server/src/safety.ts via eval/safety_bridge.mts",
        "errors": errors,
        "timeouts": timeouts,
        "profile": PROFILE,
        "held_out_gate_audit": audit,
        "summary": summary,
        "cases": cases_out,
    })
    OUT_JSON.write_text(format_compact_results(payload), encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
