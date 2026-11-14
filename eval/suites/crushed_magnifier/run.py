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
import tempfile
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
SUITE_NAME = "crushed_magnifier"
OUT_IMG_DIR = REPO / "eval" / "out" / SUITE_NAME
OUT_JSON = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
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
        {"id": "ramipril", "name": "Cardace", "ingredient": "ramipril", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "bisoprolol", "name": "Emconcor", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "cm_01",
        "category": "readable_distorted",
        "distortion_mode": "moderate_barrel_magnifier",
        "degraded": False,
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "match",
        "exp_str": "5 mg",
        "allergen": False,
        "desc": "Handheld 2x reading magnifier with moderate barrel distortion over Amlodipin 5 mg evening carton",
        "accent": (22, 98, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "AMLODIPIN",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "pack": "98 tablets  1 tablet in the evening",
        "exp": "EXP 2027-10",
        "corners": [],
        "creases": 0,
        "oblit": None,
        "mag": {"cx": 292, "cy": 310, "r": 278, "bw": 16, "zoom": 1.11, "k": 0.14, "bf": 0.84, "sig": 3.8, "vs": 0.87, "vd": 0.50, "ang": 132.0},
        "tilt": -1.4,
    },
    {
        "id": "cm_02",
        "category": "readable_distorted",
        "distortion_mode": "crushed_corner_decimal_intact",
        "degraded": False,
        "food": False,
        "q": "Is this my morning Cardace?",
        "expected": "match",
        "exp_str": "2.5 mg",
        "allergen": False,
        "desc": "Pocket-crushed Cardace (ramipril) 2.5 mg carton with crumpled corners and margin creases away from 2.5 mg",
        "accent": (26, 114, 102),
        "bg": (248, 250, 248),
        "hdr": "SANOFI NORDIC",
        "title": "CARDACE",
        "sub": "Active ingredient: ramipril",
        "str": "2.5 mg",
        "pack": "98 tablets  1 tablet in the morning",
        "exp": "EXP 2027-11",
        "corners": ["top_right", "bottom_left"],
        "creases": 3,
        "oblit": None,
        "mag": None,
        "tilt": 1.8,
    },
    {
        "id": "cm_03",
        "category": "readable_distorted",
        "distortion_mode": "crushed_carton_wrong_strength",
        "degraded": False,
        "food": False,
        "q": "Is this my Metformin?",
        "expected": "warning",
        "exp_str": "1000 mg",
        "allergen": False,
        "desc": "Pocket-crushed Metformin 1000 mg carton with crumpled corners catching 2x wrong-strength warning vs 500 mg",
        "accent": (36, 86, 158),
        "bg": (248, 249, 252),
        "hdr": "SANDOZ NORDIC",
        "title": "METFORMIN",
        "sub": "Active ingredient: metformin",
        "str": "1000 mg",
        "pack": "100 film-coated tablets",
        "exp": "EXP 2027-08",
        "corners": ["top_right", "bottom_right"],
        "creases": 3,
        "oblit": None,
        "mag": None,
        "tilt": -1.9,
    },
    {
        "id": "cm_04",
        "category": "readable_distorted",
        "distortion_mode": "crushed_magnified_nsaid_avoid",
        "degraded": False,
        "food": False,
        "q": "Can I take this for pain?",
        "expected": "warning",
        "exp_str": "400 mg",
        "allergen": False,
        "desc": "Pocket-dented Burana (ibuprofen) 400 mg carton under barrel reading magnifier catching NSAID avoid warning",
        "accent": (182, 34, 46),
        "bg": (250, 247, 247),
        "hdr": "ORION PHARMA",
        "title": "BURANA",
        "sub": "Active ingredient: ibuprofen",
        "str": "400 mg",
        "pack": "30 film-coated tablets",
        "exp": "EXP 2027-11",
        "corners": ["top_right"],
        "creases": 2,
        "oblit": None,
        "mag": {"cx": 292, "cy": 310, "r": 278, "bw": 16, "zoom": 1.11, "k": 0.14, "bf": 0.84, "sig": 3.8, "vs": 0.87, "vd": 0.50, "ang": 130.0},
        "tilt": 1.4,
    },
    {
        "id": "cm_05",
        "category": "readable_distorted",
        "distortion_mode": "barrel_magnified_tree_nut_allergen",
        "degraded": False,
        "food": True,
        "q": "Does this contain any tree nuts or peanuts?",
        "expected": "warning",
        "exp_str": None,
        "allergen": True,
        "desc": "Handheld reading magnifier with barrel curvature over Hazelnut Dark Bar tree-nut allergen warning",
        "accent": (106, 56, 34),
        "bg": (246, 241, 234),
        "hdr": "FAZER FINLAND",
        "title": "Hazelnut Dark Bar",
        "sub": "Dark Chocolate Bar  180 g",
        "ing": ["Ingredients: cocoa mass, cane sugar,", "hazelnuts (22%), cocoa butter, vanilla."],
        "alg": "Allergens: Contains hazelnuts (tree nuts).",
        "exp": "Best before: 2027-09-18",
        "corners": [],
        "creases": 0,
        "oblit": None,
        "mag": {"cx": 384, "cy": 344, "r": 308, "bw": 16, "zoom": 1.08, "k": 0.13, "bf": 0.86, "sig": 3.5, "vs": 0.88, "vd": 0.52, "ang": 42.0},
        "tilt": -1.2,
    },
    {
        "id": "cm_06",
        "category": "readable_distorted",
        "distortion_mode": "crushed_magnified_nut_free_food",
        "degraded": False,
        "food": True,
        "q": "Is this safe with my nut allergies?",
        "expected": "info",
        "exp_str": None,
        "allergen": False,
        "desc": "Pocket-creased Nordic Oat Crisps carton under reading magnifier with readable nut-free allergen box",
        "accent": (46, 102, 74),
        "bg": (245, 248, 242),
        "hdr": "NORDIC OAT BAKERY",
        "title": "Nordic Oat Crisps",
        "sub": "Oven-Baked Crisps  200 g",
        "ing": ["Ingredients: wholegrain oats (68%),", "rapeseed oil, wheat sourdough, sea salt."],
        "alg": "Allergens: Contains oats, wheat (gluten).",
        "exp": "Best before: 2027-09-20",
        "corners": ["top_right"],
        "creases": 2,
        "oblit": None,
        "mag": {"cx": 384, "cy": 344, "r": 308, "bw": 16, "zoom": 1.08, "k": 0.13, "bf": 0.86, "sig": 3.5, "vs": 0.88, "vd": 0.52, "ang": 44.0},
        "tilt": 1.2,
    },
    {
        "id": "cm_07",
        "category": "crease_fold_decimal_obliteration",
        "distortion_mode": "deep_white_crease_2_5mg",
        "degraded": True,
        "food": False,
        "q": "Is this my morning Emconcor?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Pocket-crushed Emconcor (bisoprolol) carton with deep white paper-fiber crease fold obliterating 2.5 mg digits",
        "accent": (28, 96, 138),
        "bg": (248, 250, 252),
        "hdr": "MERCK NORDIC",
        "title": "EMCONCOR",
        "sub": "Active ingredient: bisoprolol",
        "str": None,
        "pack": "100 film-coated tablets",
        "exp": "EXP 2027-10",
        "corners": ["top_left", "bottom_left"],
        "creases": 2,
        "oblit": "decimal_fold",
        "mag": None,
        "tilt": -1.7,
    },
    {
        "id": "cm_08",
        "category": "crease_fold_decimal_obliteration",
        "distortion_mode": "compound_horizontal_crush_fold",
        "degraded": True,
        "food": False,
        "q": "Is this my Metformin?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Pocket-crushed Metformin carton with deep horizontal cardboard fold obliterating strength digits before mg",
        "accent": (36, 86, 158),
        "bg": (248, 249, 252),
        "hdr": "SANDOZ NORDIC",
        "title": "METFORMIN",
        "sub": "Active ingredient: metformin",
        "str": None,
        "pack": "100 film-coated tablets",
        "exp": "EXP 2027-11",
        "corners": ["top_right", "bottom_left"],
        "creases": 2,
        "oblit": "horizontal_fold",
        "mag": None,
        "tilt": 1.6,
    },
    {
        "id": "cm_09",
        "category": "magnifier_bezel_occlusion",
        "distortion_mode": "dark_bezel_rim_over_strength",
        "degraded": True,
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Off-center handheld reading magnifier whose thick dark bezel rim covers Amlodipin strength digits",
        "accent": (22, 98, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "AMLODIPIN",
        "sub": "Active ingredient: amlodipine",
        "str": None,
        "pack": "98 tablets  Take in the evening",
        "exp": "EXP 2027-09",
        "corners": [],
        "creases": 0,
        "oblit": "rim_clip",
        "mag": {"cx": 242, "cy": 172, "r": 192, "bw": 30, "zoom": 1.16, "k": 0.16, "bf": 0.74, "sig": 6.0, "vs": 0.78, "vd": 0.28, "ang": 32.0},
        "tilt": 1.2,
    },
    {
        "id": "cm_10",
        "category": "magnifier_bezel_occlusion",
        "distortion_mode": "handle_and_rim_over_strength",
        "degraded": True,
        "food": False,
        "q": "Is this my morning Cardace?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Handheld reading magnifier handle and dark outer rim crossing directly over Cardace strength badge",
        "accent": (26, 114, 102),
        "bg": (248, 250, 248),
        "hdr": "SANOFI NORDIC",
        "title": "CARDACE",
        "sub": "Active ingredient: ramipril",
        "str": None,
        "pack": "98 tablets  Once daily",
        "exp": "EXP 2027-10",
        "corners": ["top_right"],
        "creases": 1,
        "oblit": "rim_clip",
        "mag": {"cx": 506, "cy": 362, "r": 146, "bw": 30, "zoom": 1.15, "k": 0.15, "bf": 0.76, "sig": 5.5, "vs": 0.80, "vd": 0.30, "ang": 180.0},
        "tilt": -1.3,
    },
    {
        "id": "cm_11",
        "category": "peripheral_spherical_aberration",
        "distortion_mode": "peripheral_lens_blur_strength",
        "degraded": True,
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "High-power magnifier centered on Amlodipin header while severe peripheral lens aberration blurs strength",
        "accent": (22, 98, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "AMLODIPIN",
        "sub": "Active ingredient: amlodipine",
        "str": None,
        "pack": "98 tablets",
        "exp": "EXP 2027-10",
        "corners": ["bottom_left"],
        "creases": 2,
        "oblit": "blur_smudge_med",
        "mag": {"cx": 356, "cy": 182, "r": 316, "bw": 24, "zoom": 1.16, "k": 0.20, "bf": 0.42, "sig": 18.5, "vs": 0.72, "vd": 0.34, "ang": 40.0},
        "tilt": 1.5,
    },
    {
        "id": "cm_12",
        "category": "peripheral_spherical_aberration",
        "distortion_mode": "peripheral_lens_blur_allergens",
        "degraded": True,
        "food": True,
        "q": "Is this safe with my nut allergies?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "High-power magnifier centered on Morning Crunch Clusters title while peripheral lens blur obscures allergens",
        "accent": (118, 78, 38),
        "bg": (246, 241, 232),
        "hdr": "NORDIC KITCHEN PANTRY",
        "title": "Morning Crunch Clusters",
        "sub": "Baked Breakfast Pack  350 g",
        "ing": [],
        "alg": "",
        "exp": "Best before: 2027-11-15",
        "corners": ["bottom_right"],
        "creases": 2,
        "oblit": "blur_smudge_food",
        "mag": {"cx": 356, "cy": 176, "r": 324, "bw": 24, "zoom": 1.16, "k": 0.20, "bf": 0.44, "sig": 18.5, "vs": 0.74, "vd": 0.36, "ang": 42.0},
        "tilt": -1.5,
    },
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


def run_tsx(args: list[str], stdin_txt: str) -> str:
    shm_dir = "/dev/shm" if os.path.isdir("/dev/shm") else None
    with tempfile.TemporaryDirectory(prefix="holdup-tsx-", dir=shm_dir) as tmpd:
        ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL, TMPDIR=tmpd)
        proc = subprocess.run([find_node(), "--import", "tsx", *args], input=stdin_txt, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
        return proc.stdout


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 14) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)


def bilinear_rgb(arr: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    h, w, _ = arr.shape
    sx_c = np.clip(sx, 0.0, float(w - 1))
    sy_c = np.clip(sy, 0.0, float(h - 1))
    x0 = np.floor(sx_c).astype(np.int32)
    y0 = np.floor(sy_c).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    wx = (sx_c - x0)[:, :, None]
    wy = (sy_c - y0)[:, :, None]
    top = arr[y0, x0] * (1.0 - wx) + arr[y0, x1] * wx
    bot = arr[y1, x0] * (1.0 - wx) + arr[y1, x1] * wx
    return top * (1.0 - wy) + bot * wy


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size))
    d, rng = ImageDraw.Draw(im), random.Random(seed + 17)
    hz = int(size * 0.59)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(230 - 22 * t), int(226 - 20 * t), int(218 - 18 * t)))
    for y in range(hz, size):
        t, j = (y - hz) / max(1, size - hz), rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(182 - 26 * t) + j, int(156 - 22 * t) + j, int(128 - 18 * t) + j))
    d.line((0, hz, size, hz), fill=(134, 112, 88), width=3)
    bk = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(bk).ellipse((32, 24, 224, 196), fill=(255, 250, 238, 44))
    return Image.alpha_composite(im.convert("RGBA"), bk.filter(ImageFilter.GaussianBlur(radius=22.0))).convert("RGB")


def apply_corners_and_creases(card: Image.Image, mask: Image.Image, corners: list[str], creases: int, seed: int) -> tuple[Image.Image, Image.Image]:
    rng = random.Random(seed + 41)
    cw, ch = card.size
    rgba = card.convert("RGBA")
    ov = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    md = ImageDraw.Draw(mask)
    for corner in corners:
        kw, kh = rng.randint(44, 60), rng.randint(40, 54)
        if corner == "top_right":
            md.polygon([(cw - kw, 0), (cw, 0), (cw, kh)], fill=0)
            od.polygon([(cw - kw, 0), (cw, kh), (cw - kw - 15, kh + 17)], fill=(214, 208, 198, 245))
            od.line([(cw - kw, 0), (cw - kw - 15, kh + 17), (cw, kh)], fill=(252, 250, 246, 235), width=3)
        elif corner == "bottom_right":
            md.polygon([(cw - kw, ch), (cw, ch), (cw, ch - kh)], fill=0)
            od.polygon([(cw - kw, ch), (cw, ch - kh), (cw - kw - 14, ch - kh - 15)], fill=(210, 204, 194, 245))
            od.line([(cw - kw, ch), (cw - kw - 14, ch - kh - 15), (cw, ch - kh)], fill=(252, 250, 246, 235), width=3)
        elif corner == "top_left":
            md.polygon([(0, 0), (kw, 0), (0, kh)], fill=0)
            od.polygon([(kw, 0), (0, kh), (kw + 15, kh + 16)], fill=(212, 206, 196, 245))
            od.line([(kw, 0), (kw + 15, kh + 16), (0, kh)], fill=(252, 250, 246, 235), width=3)
        elif corner == "bottom_left":
            md.polygon([(0, ch - kh), (0, ch), (kw, ch)], fill=0)
            od.polygon([(0, ch - kh), (kw, ch), (kw + 14, ch - kh - 15)], fill=(210, 204, 194, 245))
            od.line([(0, ch - kh), (kw + 14, ch - kh - 15), (kw, ch)], fill=(252, 250, 246, 235), width=3)
    for idx in range(creases):
        xa = rng.randint(int(cw * 0.66), cw - 18)
        ya = rng.randint(74 + idx * 88, min(ch - 118, 146 + idx * 102))
        xb = min(cw - 8, xa + rng.randint(68, 128))
        yb = max(70, min(ch - 96, ya + rng.randint(-44, 50)))
        od.line([(xa, ya), (xb, yb)], fill=(84, 78, 72, 128), width=2)
        od.line([(xa, ya + 3), (xb, yb + 3)], fill=(254, 253, 250, 210), width=3)
    return Image.alpha_composite(rgba, ov.filter(ImageFilter.GaussianBlur(radius=0.55))).convert("RGB"), mask


def apply_obliteration(card: Image.Image, mode: str, seed: int) -> Image.Image:
    rng = random.Random(seed + 109)
    cw, ch = card.size
    if mode == "decimal_fold":
        arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
        yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
        bcy = 251.0
        dist_f = xx - (128.0 - 0.34 * (yy - bcy))
        below = np.clip((yy - 190.0) / 16.0, 0.0, 1.0)
        iby = np.exp(-0.5 * (((yy - bcy) / 52.0) ** 2))
        trough = np.exp(-0.5 * (((dist_f + 8.0) / (10.0 + 48.0 * iby)) ** 2)) * below
        ridge = np.exp(-0.5 * (((dist_f - 4.0) / (5.5 + 32.0 * iby)) ** 2)) * below
        arr = arr * (1.0 - 0.34 * trough)[:, :, None]
        delam = np.clip(1.25 * np.exp(-0.5 * ((dist_f / 64.0) ** 2)) * np.exp(-0.5 * (((yy - bcy) / 46.0) ** 2)), 0.0, 1.0)
        paper = np.array([252.0, 251.0, 246.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - delam[:, :, None]) + paper * delam[:, :, None] + (42.0 * ridge * (1.0 - 0.65 * delam))[:, :, None]
        rgba = Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB").convert("RGBA")
        cl = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        cd = ImageDraw.Draw(cl)
        for k in range(3):
            rx = 70 + k * 42
            cd.line([(rx + 14, 192), (rx - 14, 312)], fill=(112, 118, 126, 165), width=3)
            cd.line([(rx + 18, 192), (rx - 10, 312)], fill=(255, 255, 255, 240), width=5)
        for _ in range(36):
            fx, fy = rng.randint(48, 196), rng.randint(208, 294)
            cd.line((fx, fy, fx + rng.randint(8, 22), fy + rng.randint(-5, 5)), fill=(238, 236, 230, 225), width=3)
        return Image.alpha_composite(rgba, cl.filter(ImageFilter.GaussianBlur(radius=0.8))).convert("RGB")
    if mode == "horizontal_fold":
        arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
        yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
        rel = yy - (251.0 + 0.03 * (xx - 0.5 * float(cw)))
        band = np.exp(-0.5 * ((rel / 34.0) ** 2))
        paper = np.array([244.0, 242.0, 236.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.95 * band[:, :, None]) + paper * (0.95 * band[:, :, None])
        canyon = 1.0 - 0.62 * np.exp(-0.5 * ((rel / 16.0) ** 2))
        ridges = 72.0 * np.exp(-0.5 * (((rel + 20.0) / 5.5) ** 2)) + 64.0 * np.exp(-0.5 * (((rel - 22.0) / 6.0) ** 2))
        arr = arr * canyon[:, :, None] + ridges[:, :, None]
        return Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")
    if mode == "blur_smudge_med":
        sm = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sm)
        for bx in (56, 98, 146):
            sd.ellipse((bx, 226, bx + 36, 276), fill=(92, 102, 116, 175))
        return Image.alpha_composite(card.convert("RGBA"), sm.filter(ImageFilter.GaussianBlur(radius=14.0))).convert("RGB")
    if mode == "blur_smudge_food":
        sm = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sm)
        sd.rounded_rectangle((28, 188, cw - 28, 408), radius=10, fill=(248, 244, 236, 240))
        for ry in (212, 252, 292, 344):
            for seg in range(4):
                sx = 46 + seg * 120 + rng.randint(-6, 8)
                sd.rounded_rectangle((sx, ry, sx + rng.randint(68, 96), ry + 16), radius=6, fill=(104, 96, 88, 165))
        return Image.alpha_composite(card.convert("RGBA"), sm.filter(ImageFilter.GaussianBlur(radius=13.0))).convert("RGB")
    return card


def apply_magnifier(frame: Image.Image, mag: dict[str, Any]) -> Image.Image:
    w, h = frame.size
    cx, cy, lr, bw = float(mag["cx"]), float(mag["cy"]), float(mag["r"]), float(mag["bw"])
    base_arr = np.asarray(frame.convert("RGB"), dtype=np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    dist = np.hypot(dx, dy)
    rn = dist / max(1.0, lr)
    r2 = np.minimum(1.25, rn * rn)
    inv = (1.0 / float(mag["zoom"])) * (1.0 - float(mag["k"]) * r2)
    warped = bilinear_rgb(base_arr, cx + dx * inv, cy + dy * inv)
    w_im = Image.fromarray(np.clip(np.round(warped), 0.0, 255.0).astype(np.uint8), mode="RGB")
    sig = float(mag["sig"])
    mid_arr = np.asarray(w_im.filter(ImageFilter.GaussianBlur(radius=max(1.2, sig * 0.35))), dtype=np.float32)
    hvy_arr = np.asarray(w_im.filter(ImageFilter.GaussianBlur(radius=sig)), dtype=np.float32)
    bf = float(mag["bf"])
    tb = np.clip((rn - bf) / max(0.06, 1.0 - bf), 0.0, 1.0)
    wm = np.clip(tb * 2.0, 0.0, 1.0) * (1.0 - np.clip((tb - 0.45) / 0.55, 0.0, 1.0))
    wh = np.clip((tb - 0.30) / 0.70, 0.0, 1.0) ** 1.25
    ws = np.maximum(0.0, 1.0 - wm - wh)
    ns = ws + wm + wh
    lens = warped * (ws / ns)[:, :, None] + mid_arr * (wm / ns)[:, :, None] + hvy_arr * (wh / ns)[:, :, None]
    glint = 20.0 * np.exp(-0.5 * (((rn - 0.80) / 0.045) ** 2)) * np.clip((-dx - dy) / max(1.0, lr), 0.0, 1.0)
    vt = np.clip((rn - float(mag["vs"])) / max(0.05, 1.0 - float(mag["vs"])), 0.0, 1.0)
    lens = (lens + glint[:, :, None]) * (1.0 - (1.0 - float(mag["vd"])) * (vt ** 1.6))[:, :, None]
    in_r, out_r = lr - bw, lr + bw
    out_arr = base_arr.copy()
    sh_d = np.hypot(xx - (cx + 10.0), yy - (cy + 14.0))
    ring_sh = np.exp(-0.5 * (((sh_d - lr) / (bw * 0.9 + 8.0)) ** 2))
    out_mask = dist > in_r
    out_arr[out_mask] *= (1.0 - 0.45 * ring_sh[out_mask])[:, None]
    in_mask = dist <= in_r
    out_arr[in_mask] = np.clip(lens[in_mask], 0.0, 255.0)
    comp = Image.fromarray(np.clip(np.round(out_arr), 0.0, 255.0).astype(np.uint8), mode="RGB").convert("RGBA")
    ang = math.radians(float(mag["ang"]))
    ux, uy = math.cos(ang), math.sin(ang)
    px_n, py_n = -uy, ux
    hs, he, ht = out_r - 6.0, out_r + 250.0, max(22.0, bw * 0.92)
    hw = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(hw).polygon([
        (cx + ux * hs + px_n * ht, cy + uy * hs + py_n * ht),
        (cx + ux * hs - px_n * ht, cy + uy * hs - py_n * ht),
        (cx + ux * he - px_n * (ht + 6), cy + uy * he - py_n * (ht + 6)),
        (cx + ux * he + px_n * (ht + 6), cy + uy * he + py_n * (ht + 6)),
    ], fill=(24, 26, 32, 255))
    comp = Image.alpha_composite(comp, hw)
    bz = np.zeros((h, w, 4), dtype=np.uint8)
    rp = np.clip((dist - in_r) / max(1.0, out_r - in_r), 0.0, 1.0)
    bv = 20.0 + 24.0 * np.sin(rp * math.pi)
    bz[:, :, 0] = np.clip(bv, 0.0, 255.0).astype(np.uint8)
    bz[:, :, 1] = np.clip(bv + 2.0, 0.0, 255.0).astype(np.uint8)
    bz[:, :, 2] = np.clip(bv + 5.0, 0.0, 255.0).astype(np.uint8)
    aa = np.clip((dist - (in_r - 1.2)) / 1.4, 0.0, 1.0) * np.clip(((out_r + 1.2) - dist) / 1.4, 0.0, 1.0)
    bz[:, :, 3] = (255.0 * aa * ((dist >= in_r - 1.5) & (dist <= out_r + 1.5))).astype(np.uint8)
    return Image.alpha_composite(comp, Image.fromarray(bz, mode="RGBA")).convert("RGB")


def render_case(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 5100 + idx * 29
    pad, size = 84, 936
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 74, pad + 112, pad + 694, pad + 656
    bw, bh = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=16, fill=(24, 20, 16, 98))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card = Image.new("RGB", (bw, bh), case["bg"])
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 60), fill=case["accent"])
    cd.text((30, 18), case["hdr"], fill=(250, 252, 255), font=fit_font(cd, case["hdr"], bw - 60, 23))
    if case["food"]:
        fx = 104 if not case["degraded"] else 30
        cd.text((fx, 82), case["title"], fill=(12, 16, 24), font=fit_font(cd, case["title"], bw - fx - 56, 36))
        cd.text((fx, 138), case["sub"], fill=(32, 40, 52), font=fit_font(cd, case["sub"], bw - fx - 56, 23))
        if case["ing"]:
            cd.rounded_rectangle((84, 184, bw - 52, 412), radius=10, fill=(254, 252, 248), outline=(182, 174, 162), width=2)
            iy = 204
            for ln in case["ing"]:
                cd.text((98, iy), ln, fill=(22, 26, 30), font=fit_font(cd, ln, bw - 168, 20))
                iy += 36
            cd.rounded_rectangle((96, iy + 14, bw - 64, iy + 76), radius=8, fill=(255, 244, 232), outline=(196, 126, 68), width=2)
            cd.text((108, iy + 32), case["alg"], fill=(96, 34, 16), font=fit_font(cd, case["alg"], bw - 188, 19))
        if case["exp"]:
            cd.text((32, bh - 62), case["exp"], fill=(18, 24, 32), font=ImageFont.load_default(size=24))
    else:
        cd.text((42, 78), case["title"], fill=(12, 16, 24), font=fit_font(cd, case["title"], bw - 84, 46))
        cd.text((42, 138), case["sub"], fill=(32, 40, 52), font=fit_font(cd, case["sub"], bw - 84, 24))
        sx0, sy0, sx1, sy1 = 32, 204, 304, 298
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=(238, 245, 252), outline=case["accent"], width=4)
        f_str = ImageFont.load_default(size=46)
        if case["str"]:
            cd.text((sx0 + 24, sy0 + 20), case["str"], fill=(10, 14, 22), font=f_str)
        elif case["oblit"] in ("decimal_fold", "horizontal_fold", "rim_clip"):
            mg_w = int(cd.textlength("mg", font=f_str))
            cd.text((sx1 - 22 - mg_w, sy0 + 20), "mg", fill=(10, 14, 22), font=f_str)
        cd.text((sx1 + 20, sy0 + 32), "tablets", fill=(32, 40, 50), font=ImageFont.load_default(size=25))
        if case["pack"]:
            cd.text((32, sy1 + 40), case["pack"], fill=(34, 42, 54), font=fit_font(cd, case["pack"], bw - 64, 24))
        if case["exp"]:
            cd.rounded_rectangle((bw - 266, bh - 94, bw - 30, bh - 36), radius=8, fill=(244, 246, 250), outline=(146, 154, 166), width=2)
            cd.text((bw - 246, bh - 79), case["exp"], fill=(14, 20, 28), font=ImageFont.load_default(size=26))
    if case["oblit"]:
        card = apply_obliteration(card, case["oblit"], seed)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    card, mask = apply_corners_and_creases(card, mask, list(case["corners"]), int(case["creases"]), seed)
    layer.paste(card, (x0, y0), mask)
    cropped = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(float(case["tilt"]), resample=Image.Resampling.BICUBIC)).convert("RGB").crop((pad, pad, pad + 768, pad + 768))
    if case["mag"] is not None:
        return apply_magnifier(cropped, case["mag"])
    return cropped


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
    s1 = run_tsx(["--input-type=module", "-e", norm_js], json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}))
    normed = [sanitize(x) for x in json.loads(s1)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    s2 = run_tsx([BRIDGE_REL], bridge_in)
    verdicts = [sanitize(json.loads(ln)) for ln in s2.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py and not KEY_RE.search(src_py)
    if README_PATH.is_file():
        rd_txt = README_PATH.read_text(encoding="utf-8")
        assert EM_DASH not in rd_txt and EN_DASH not in rd_txt and not KEY_RE.search(rd_txt)
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    s_out = run_tsx([BRIDGE_REL], bridge_in)
    re_verdicts = [json.loads(ln) for ln in s_out.splitlines() if ln.strip()]
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
    ap.add_argument("--verify-cached", dest="verify_cached", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.verify_cached or args.offline:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        im = render_case(c, idx)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        raw = buf.getvalue()
        (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
        rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
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
            alg_miss = bool(c["allergen"] and float(rd["allergens"]["confidence"] or 0.8) >= 0.8 and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or alg_miss or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "distortion_mode": c["distortion_mode"],
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
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    clean = [x for x in cases_out if x["category"] == "readable_distorted"]
    deg = [x for x in cases_out if x["category"] != "readable_distorted"]
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
        "readable_distorted_accuracy": round(sum(1 for x in clean if x["verdict_ok"]) / len(clean), 4),
        "severe_distortion_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": SUITE_NAME,
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
