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
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BIN = "/tmp/fleet-silas/node/bin"
if os.path.isdir(NODE_BIN):
    os.environ["PATH"] = f"{NODE_BIN}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = REPO / "eval" / "out" / "pastel_tint_contrast"
OUT_JSON = SUITE_DIR / "results.json"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
        {"id": "paracetamol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["evening"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

LENS_PROFILES: dict[str, dict[str, tuple[float, float, float]]] = {
    "warm_tungsten_2700k": {"illum": (1.06, 0.94, 0.76), "trans": (0.98, 0.97, 0.94), "veil": (0.016, 0.014, 0.010)},
    "yellow_450nm_filter": {"illum": (1.05, 0.95, 0.78), "trans": (0.97, 0.93, 0.34), "veil": (0.022, 0.020, 0.006)},
    "amber_511nm_filter": {"illum": (1.05, 0.94, 0.77), "trans": (0.95, 0.82, 0.42), "veil": (0.022, 0.017, 0.008)},
    "transitions_brown": {"illum": (1.05, 0.94, 0.77), "trans": (0.84, 0.74, 0.58), "veil": (0.020, 0.015, 0.010)},
    "transitions_grey": {"illum": (1.04, 0.95, 0.79), "trans": (0.74, 0.75, 0.73), "veil": (0.018, 0.017, 0.015)},
    "transitions_grey_heavy": {"illum": (1.05, 0.94, 0.76), "trans": (0.46, 0.47, 0.45), "veil": (0.024, 0.022, 0.018)},
}

CASES: list[dict[str, Any]] = [
    {"id": "pt_01", "category": "pastel_moderate", "degraded": False, "lens": "warm_tungsten_2700k", "food": False, "q": "Is this my evening pill?", "expected": "match", "exp_str": "5 mg", "allergen": False, "desc": "Pastel mint Nordic Amlodipin 5 mg carton under 2700K tungsten cast", "bg": (214, 236, 225), "hdr_bg": (146, 186, 169), "hdr_ink": (48, 76, 66), "title_ink": (74, 106, 94), "sub_ink": (96, 126, 114), "box_bg": (223, 240, 231), "box_bd": (166, 198, 184), "box_ink": (104, 132, 121), "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": "5 mg", "pack": "98 tablets  1 tablet in the evening", "exp": "EXP 2027-09", "tilt": -1.4, "noise": 1.4},
    {"id": "pt_02", "category": "pastel_moderate", "degraded": False, "lens": "amber_511nm_filter", "food": False, "q": "Can I take this for pain?", "expected": "warning", "exp_str": "400 mg", "allergen": False, "desc": "Pastel blush Burana 400 mg carton through amber 511nm filter lens", "bg": (243, 222, 226), "hdr_bg": (198, 146, 156), "hdr_ink": (76, 44, 52), "title_ink": (108, 72, 80), "sub_ink": (128, 92, 100), "box_bg": (246, 229, 232), "box_bd": (208, 168, 176), "box_ink": (136, 98, 106), "hdr": "ORION PHARMA  Vnr 06 14 28", "title": "Burana", "sub": "Active ingredient: ibuprofen", "str": "400 mg", "pack": "30 tablets  1 tablet as needed for pain", "exp": "EXP 2027-11", "tilt": 1.5, "noise": 1.5},
    {"id": "pt_03", "category": "pastel_moderate", "degraded": False, "lens": "transitions_brown", "food": False, "q": "Is this my Metformin?", "expected": "warning", "exp_str": "500 mg", "allergen": False, "desc": "Pastel cream Metformin 500 mg expired carton through brown lens tint", "bg": (244, 237, 218), "hdr_bg": (194, 176, 142), "hdr_ink": (68, 56, 38), "title_ink": (102, 86, 64), "sub_ink": (122, 106, 82), "box_bg": (247, 241, 225), "box_bd": (204, 190, 160), "box_ink": (132, 114, 88), "hdr": "SANDOZ  Vnr 14 88 05", "title": "Metformin", "sub": "Active ingredient: metformin", "str": "500 mg", "pack": "100 tablets  1 tablet twice daily", "exp": "EXP 2025-02", "tilt": -1.3, "noise": 1.5},
    {"id": "pt_04", "category": "pastel_moderate", "degraded": False, "lens": "yellow_450nm_filter", "food": False, "q": "Is this my evening pill?", "expected": "warning", "exp_str": "10 mg", "allergen": False, "desc": "Pastel lavender Amlodipin 10 mg wrong-strength box through yellow filter", "bg": (231, 225, 243), "hdr_bg": (172, 160, 198), "hdr_ink": (56, 48, 76), "title_ink": (84, 74, 108), "sub_ink": (104, 94, 128), "box_bg": (236, 231, 246), "box_bd": (188, 178, 210), "box_ink": (114, 104, 138), "hdr": "ORION PHARMA  Vnr 09 22 41", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": "10 mg", "pack": "98 tablets  1 tablet once daily", "exp": "EXP 2027-10", "tilt": 1.6, "noise": 1.5},
    {"id": "pt_05", "category": "pastel_moderate", "degraded": False, "lens": "amber_511nm_filter", "food": True, "q": "Does this contain tree nuts or peanuts?", "expected": "warning", "exp_str": None, "allergen": True, "desc": "Pastel peach Hazelnut and Almond Wafers carton through amber filter lens", "bg": (244, 230, 220), "hdr_bg": (196, 158, 136), "hdr_ink": (72, 50, 38), "title_ink": (104, 78, 62), "sub_ink": (124, 98, 80), "box_bg": (248, 237, 229), "box_bd": (212, 184, 168), "box_ink": (128, 102, 84), "hdr": "NORDIC PASTEL BAKERY  180 g", "title": "Hazelnut & Almond Wafers", "sub": "Crispy Praline Pastry Squares", "ing": ["Ingredients: wheat flour, cane sugar,", "roasted hazelnuts (12%), almonds (8%), milk."], "alg": "Allergens: Contains hazelnuts, almonds (tree nuts), wheat, milk.", "exp": "Best before: 2027-10-20", "tilt": -1.2, "noise": 1.4},
    {"id": "pt_06", "category": "pastel_moderate", "degraded": False, "lens": "transitions_grey", "food": True, "q": "Is this safe with my nut allergies?", "expected": "info", "exp_str": None, "allergen": False, "desc": "Pastel sage Nordic Oat Drink carton through grey photochromic lens", "bg": (225, 237, 227), "hdr_bg": (158, 184, 164), "hdr_ink": (48, 68, 54), "title_ink": (78, 102, 86), "sub_ink": (98, 122, 106), "box_bg": (233, 242, 234), "box_bd": (178, 200, 184), "box_ink": (108, 132, 116), "hdr": "NORDIC OAT MILL  1 L", "title": "Nordic Pastel Oat Drink", "sub": "Plant-Based Oat Beverage", "ing": ["Ingredients: water, wholegrain oats (10%),", "rapeseed oil, calcium carbonate, sea salt."], "alg": "Allergens: Contains oats (gluten).", "exp": "Best before: 2027-12-10", "tilt": 1.3, "noise": 1.4},
    {"id": "pt_07", "category": "grey_on_silver_washout", "degraded": True, "lens": "warm_tungsten_2700k", "washout": "grey_on_silver", "food": False, "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Washed-out grey-on-silver foil strength digits on Amlodipin under 2700K cast", "bg": (244, 244, 240), "hdr_bg": (156, 176, 192), "hdr_ink": (24, 36, 48), "title_ink": (22, 32, 44), "sub_ink": (46, 58, 72), "box_bg": (228, 230, 233), "box_bd": (216, 219, 223), "box_ink": (226, 228, 231), "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": None, "pack": "98 tablets  Take in the evening", "exp": "EXP 2027-09", "tilt": -1.8, "noise": 1.8},
    {"id": "pt_08", "category": "grey_on_silver_washout", "degraded": True, "lens": "transitions_brown", "washout": "grey_on_silver", "food": False, "q": "Is this my Metformin?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Washed-out grey-on-silver metallic strength strip on Metformin generic box", "bg": (242, 241, 237), "hdr_bg": (164, 174, 194), "hdr_ink": (26, 34, 48), "title_ink": (24, 32, 46), "sub_ink": (48, 56, 70), "box_bg": (226, 228, 230), "box_bd": (214, 216, 220), "box_ink": (224, 226, 228), "hdr": "SANDOZ  Vnr 14 88 05", "title": "Metformin", "sub": "Active ingredient: metformin", "str": None, "pack": "100 tablets  Take with meals", "exp": "EXP 2027-11", "tilt": 1.9, "noise": 1.8},
    {"id": "pt_09", "category": "yellow_amber_filter_washout", "degraded": True, "lens": "yellow_450nm_filter", "washout": "yellow_on_cream", "food": False, "q": "Can I take this Panadol?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Pale yellow strength badge on cream Panadol collapsed by yellow 450nm filter", "bg": (248, 244, 228), "hdr_bg": (152, 168, 188), "hdr_ink": (18, 26, 38), "title_ink": (16, 22, 34), "sub_ink": (36, 44, 58), "box_bg": (247, 243, 225), "box_bd": (239, 234, 214), "box_ink": (245, 240, 220), "hdr": "HALEON NORDIC", "title": "Panadol", "sub": "Active ingredient: paracetamol", "str": None, "pack": "30 tablets  For pain or fever", "exp": "EXP 2028-02", "tilt": -2.0, "noise": 2.0},
    {"id": "pt_10", "category": "yellow_amber_filter_washout", "degraded": True, "lens": "amber_511nm_filter", "washout": "amber_on_ivory", "food": False, "q": "Is this my evening cholesterol pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Pale amber strength print on ivory Atorvastatin washed out by amber filter", "bg": (247, 242, 229), "hdr_bg": (168, 152, 188), "hdr_ink": (22, 20, 38), "title_ink": (20, 18, 34), "sub_ink": (42, 40, 58), "box_bg": (246, 240, 226), "box_bd": (237, 230, 214), "box_ink": (244, 238, 223), "hdr": "ORION PHARMA  Vnr 12 30 77", "title": "Atorvastatin", "sub": "Active ingredient: atorvastatin", "str": None, "pack": "98 tablets  1 tablet in the evening", "exp": "EXP 2027-10", "tilt": 1.7, "noise": 2.0},
    {"id": "pt_11", "category": "tungsten_tint_washout", "degraded": True, "lens": "transitions_grey_heavy", "washout": "warm_glare", "food": False, "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Pastel lilac Amlodipin strength washed out under dark grey lens and 2700K glare", "bg": (236, 233, 242), "hdr_bg": (156, 152, 182), "hdr_ink": (18, 20, 34), "title_ink": (16, 18, 32), "sub_ink": (38, 40, 58), "box_bg": (238, 235, 243), "box_bd": (228, 224, 235), "box_ink": (235, 232, 240), "hdr": "ORION PHARMA", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": None, "pack": "30 tablets  Once daily", "exp": "EXP 2027-10", "tilt": 2.0, "noise": 2.1},
    {"id": "pt_12", "category": "grey_on_silver_washout", "degraded": True, "lens": "yellow_450nm_filter", "washout": "grey_on_silver", "food": False, "q": "Is this my Metformin?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Nordic sky-pastel Metformin with grey-on-silver foil digits under yellow filter", "bg": (230, 239, 245), "hdr_bg": (148, 174, 192), "hdr_ink": (20, 32, 44), "title_ink": (18, 28, 40), "sub_ink": (40, 52, 66), "box_bg": (227, 231, 235), "box_bd": (215, 220, 225), "box_ink": (225, 229, 233), "hdr": "RATIOPHARM  Vnr 41 19 02", "title": "Metformin", "sub": "Active ingredient: metformin", "str": None, "pack": "100 film-coated tablets", "exp": "EXP 2027-12", "tilt": -1.6, "noise": 1.9},
]


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)], capture_output=True, check=True, timeout=5)
            for ch in proc.stdout.split(b"\x00"):
                if b"=" in ch:
                    k, v = ch.split(b"=", 1)
                    ks = k.decode("utf-8", "ignore").strip()
                    if ks and ks not in os.environ:
                        os.environ[ks] = v.decode("utf-8", "ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    for p in (home_env, REPO / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        return KEY_RE.sub("[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-"))
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, dict):
        return {sanitize(str(k)): sanitize(val) for k, val in v.items()}
    return v


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    defs = (node.get("$defs") or {}) if (defs is None and isinstance(node, dict)) else defs
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str) and defs is not None:
            return inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def compute_prompt_sha12() -> str:
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    return hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]


def find_node() -> str:
    cand = pathlib.Path(NODE_BIN) / "node"
    if cand.is_file():
        return str(cand)
    return shutil.which("node") or "node"


def srgb_to_lin(arr_u8: np.ndarray) -> np.ndarray:
    c = np.clip(arr_u8.astype(np.float32) / 255.0, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def lin_to_srgb(lin: np.ndarray) -> np.ndarray:
    c = np.clip(lin, 0.0, 1.0)
    srgb = np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)
    return np.clip(np.round(srgb * 255.0), 0.0, 255.0).astype(np.uint8)


def measure_wcag(img: Image.Image, roi_mask: Image.Image) -> float:
    rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)
    mask = np.asarray(roi_mask.convert("L"), dtype=np.uint8) > 200
    lin = srgb_to_lin(rgb)
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2])[mask]
    y_lo, y_hi = float(np.quantile(lum, 0.02)), float(np.quantile(lum, 0.95))
    return round((max(y_hi, y_lo) + 0.05) / (min(y_hi, y_lo) + 0.05), 4)


def apply_optics(img: Image.Image, lens_name: str, noise_sigma: float, seed: int) -> Image.Image:
    spec = LENS_PROFILES[lens_name]
    lin = srgb_to_lin(np.asarray(img.convert("RGB"), dtype=np.uint8))
    h, w, ch = lin.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    falloff = 1.04 - 0.08 * (((xx - 0.36 * w) / w) ** 2 + ((yy - 0.28 * h) / h) ** 2)
    illum = np.array(spec["illum"], dtype=np.float32)[None, None, :]
    trans = np.array(spec["trans"], dtype=np.float32)[None, None, :]
    veil = np.array(spec["veil"], dtype=np.float32)[None, None, :]
    out = lin_to_srgb(lin * illum * trans * falloff[:, :, None] + veil).astype(np.float32)
    rng = np.random.default_rng(seed)
    out = np.clip(np.round(out + rng.normal(0.0, noise_sigma, size=(h, w, ch))), 0.0, 255.0)
    return Image.fromarray(out.astype(np.uint8), mode="RGB")


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size), (226, 216, 198))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    hz = int(size * 0.59)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(238 - 18 * t), int(226 - 18 * t), int(206 - 16 * t)))
    for y in range(hz, size):
        t, j = (y - hz) / max(1, size - hz), rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(198 - 24 * t) + j, int(176 - 22 * t) + j, int(148 - 18 * t) + j))
    d.line((0, hz, size, hz), fill=(154, 134, 110), width=2)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((int(size * 0.10), 18, int(size * 0.48), 210), fill=(255, 242, 214, 62))
    return Image.alpha_composite(im.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(radius=24.0))).convert("RGB")


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 16) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)


def apply_washout_patch(card: Image.Image, mode: str, sx0: int, sy0: int, sx1: int, sy1: int, bg: tuple[int, int, int], bd: tuple[int, int, int], seed: int) -> None:
    ImageDraw.Draw(card).rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=bg, outline=bd, width=2)
    arr = np.asarray(card, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = 0.5 * (sx0 + sx1), 0.5 * (sy0 + sy1)
    targets = {
        "grey_on_silver": (236.0, 238.0, 240.0),
        "yellow_on_cream": (249.0, 245.0, 229.0),
        "amber_on_ivory": (248.0, 242.0, 228.0),
        "warm_glare": (252.0, 244.0, 228.0),
    }
    tgt = np.array(targets.get(mode, (246.0, 244.0, 236.0)), dtype=np.float32)[None, None, :]
    env = np.exp(-(((xx - cx) / 142.0) ** 2 + ((yy - cy) / 54.0) ** 2))
    arr = arr * (1.0 - 0.90 * env[:, :, None]) + tgt * (0.90 * env[:, :, None])
    rng = random.Random(seed + 109)
    for row in range(max(0, sy0 + 8), min(h, sy1 - 8)):
        arr[row, max(0, sx0 + 8):min(w, sx1 - 8), :] += rng.uniform(-1.1, 1.1)
    card.paste(Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB"))


def render_case(case: dict[str, Any], idx: int) -> tuple[Image.Image, Image.Image]:
    seed = 20261146 + idx * 157
    pad, size = 80, 928
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    roi = Image.new("L", (size, size), 0)
    x0, y0, x1, y1 = (pad + 82, pad + 88, pad + 686, pad + 680) if case["food"] else (pad + 68, pad + 104, pad + 700, pad + 664)
    bw, bh = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(32, 26, 20, 82))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card = Image.new("RGB", (bw, bh), case["bg"])
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 62), fill=case["hdr_bg"])
    cd.text((26, 18), case["hdr"], fill=case["hdr_ink"], font=ImageFont.load_default(size=22))
    f_title = fit_font(cd, case["title"], bw - 52, 46 if not case["food"] else 38)
    cd.text((26, 84), case["title"], fill=case["title_ink"], font=f_title, stroke_width=1, stroke_fill=case["title_ink"])
    cd.text((26, 146), case["sub"], fill=case["sub_ink"], font=ImageFont.load_default(size=24))
    if case["food"]:
        px0, py0, px1, py1 = 24, 190, bw - 24, 422
        cd.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=case["box_bg"], outline=case["box_bd"], width=2)
        iy = 212
        for ln in case["ing"]:
            cd.text((38, iy), ln, fill=case["box_ink"], font=fit_font(cd, ln, bw - 76, 24), stroke_width=1, stroke_fill=case["box_ink"])
            iy += 38
        cd.rounded_rectangle((34, iy + 8, bw - 34, iy + 66), radius=8, fill=case["box_bg"], outline=case["box_bd"], width=2)
        cd.text((44, iy + 24), case["alg"], fill=case["box_ink"], font=fit_font(cd, case["alg"], bw - 88, 21), stroke_width=1, stroke_fill=case["box_ink"])
        ImageDraw.Draw(roi).rectangle((x0 + px0 + 14, y0 + py0 + 14, x0 + px1 - 14, y0 + py1 - 14), fill=255)
        cd.rounded_rectangle((24, 456, 386, 518), radius=8, fill=case["box_bg"], outline=case["box_bd"], width=2)
        cd.text((38, 473), case["exp"], fill=case["box_ink"], font=ImageFont.load_default(size=25), stroke_width=1, stroke_fill=case["box_ink"])
    else:
        sx0, sy0, sx1, sy1 = 28, 204, 276, 294
        if case["str"]:
            cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=case["box_bg"], outline=case["box_bd"], width=3)
            cd.text((sx0 + 22, sy0 + 18), case["str"], fill=case["box_ink"], font=ImageFont.load_default(size=46), stroke_width=1, stroke_fill=case["box_ink"])
            cd.text((sx1 + 22, sy0 + 30), "tablets", fill=case["sub_ink"], font=ImageFont.load_default(size=25))
        else:
            cd.text((sx1 + 32, sy0 + 30), "tablets", fill=case["sub_ink"], font=ImageFont.load_default(size=25))
            apply_washout_patch(card, str(case.get("washout", "grey_on_silver")), sx0, sy0, sx1, sy1, case["box_bg"], case["box_bd"], seed)
        ImageDraw.Draw(roi).rectangle((x0 + sx0 + 10, y0 + sy0 + 10, x0 + sx1 - 10, y0 + sy1 - 10), fill=255)
        cd.text((28, 336), case["pack"], fill=case["sub_ink"], font=fit_font(cd, case["pack"], bw - 56, 24))
        cd.rounded_rectangle((bw - 270, 420, bw - 28, 482), radius=8, fill=case["box_bg"], outline=case["box_bd"], width=2)
        e_ink = case["box_ink"] if case["str"] else case["sub_ink"]
        cd.text((bw - 248, 435), case["exp"], fill=e_ink, font=ImageFont.load_default(size=27), stroke_width=1, stroke_fill=e_ink)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(184, 178, 168, 255), width=3)
    comp = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    cropped = comp.crop((pad, pad, pad + 768, pad + 768))
    roi_crop = roi.rotate(case["tilt"], resample=Image.Resampling.BILINEAR).crop((pad, pad, pad + 768, pad + 768))
    return apply_optics(cropped, case["lens"], float(case["noise"]), seed), roi_crop


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64_jpg: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": f'The person asked: "{question}"'}]
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
    sess, last = requests.Session(), "failed"
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
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false, alg_hits: allergenHits(read, inp.allergies).length }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == "pastel_tint_contrast"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.offline:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        im, roi = render_case(c, idx)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        raw = buf.getvalue()
        (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
        wcag = measure_wcag(Image.open(io.BytesIO(raw)), roi)
        rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii"), "wcag": wcag})
    if args.render_only:
        for r in rendered:
            print(f"{r['case']['id']} ({r['case']['category']}, {r['case']['lens']}): wcag={r['wcag']}")
        return 0
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    with ThreadPoolExecutor(max_workers=4) as ex:
        api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    if errors:
        raise RuntimeError(f"API errors: {errors}")
    scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["degraded"]:
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
        elif c["exp_str"] is not None:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        else:
            alg_miss = bool(c["allergen"] and float(rd["allergens"]["confidence"] or 0.0) >= 0.8 and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or alg_miss or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "lens_tint": c["lens"],
            "wcag_contrast": r["wcag"],
            "description": c["desc"],
            "question": c["q"],
            "expected_level": c["expected"],
            "predicted_level": pred,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }))
        print(f"[{c['id']}] wcag={r['wcag']} exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    mod = [x for x in cases_out if x["category"] == "pastel_moderate"]
    deg = [x for x in cases_out if x["category"] != "pastel_moderate"]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "moderate_pastel_accuracy": round(sum(1 for x in mod if x["verdict_ok"]) / len(mod), 4),
        "washout_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
        "mean_moderate_wcag_contrast": round(sum(float(x["wcag_contrast"]) for x in mod) / len(mod), 4),
        "mean_washout_wcag_contrast": round(sum(float(x["wcag_contrast"]) for x in deg) / len(deg), 4),
    }
    payload = sanitize({
        "suite": "pastel_tint_contrast",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) > 15200:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
