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

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

SHM_DIR = pathlib.Path("/dev/shm")
if SHM_DIR.is_dir():
    os.environ["TMPDIR"] = str(SHM_DIR)

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = (SHM_DIR / "holdup_glasses_outdoor_sunglass_glare") if SHM_DIR.is_dir() else (REPO / "eval" / "out" / "glasses_outdoor_sunglass_glare")
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
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
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

BOX_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {"accent": (20, 102, 148), "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "AMLODIPINE", "sub": "Active ingredient: amlodipine", "str": "5 mg", "dose": "1 tablet once daily in the evening", "exp": "EXP 2027-10"},
    "aml10": {"accent": (20, 102, 148), "hdr": "ORION PHARMA  Vnr 09 22 41", "title": "AMLODIPINE", "sub": "Active ingredient: amlodipine", "str": "10 mg", "dose": "1 tablet once daily", "exp": "EXP 2027-10"},
    "ibu400": {"accent": (188, 34, 44), "hdr": "ORION PHARMA  Vnr 06 14 28", "title": "BURANA", "sub": "Active ingredient: ibuprofen", "str": "400 mg", "dose": "1 tablet as needed for pain", "exp": "EXP 2027-11"},
    "met500": {"accent": (24, 112, 108), "hdr": "ORION PHARMA  Vnr 14 88 05", "title": "METFORMIN", "sub": "Active ingredient: metformin", "str": "500 mg", "dose": "1 tablet morning and evening", "exp": "EXP 2027-12"},
    "ato20": {"accent": (92, 52, 132), "hdr": "ORION PHARMA  Vnr 12 30 77", "title": "ATORVASTATIN", "sub": "Active ingredient: atorvastatin", "str": "20 mg", "dose": "1 tablet once daily in the evening", "exp": "EXP 2027-10"},
    "peanut_bar": {"food": True, "accent": (146, 78, 28), "hdr": "NORDIC BAKERY  60 g", "title": "Peanut & Hazelnut Bar", "ing": "Ingredients: oats, roasted peanuts (26%), hazelnuts (10%).", "alg": "Allergens: contains peanuts, hazelnuts (tree nuts), oats.", "exp": "Best before: 2027-09-18"},
    "oat_drink": {"food": True, "accent": (42, 114, 84), "hdr": "NORDIC PLANT DAIRY  1 L", "title": "Nordic Oat Drink", "ing": "Ingredients: water, wholegrain oats (10%), rapeseed oil, salt.", "alg": "Allergens: contains oats (gluten).", "exp": "Best before: 2027-11-24"},
    "trail_crisp": {"food": True, "accent": (118, 76, 36), "hdr": "NORDIC BAKEHOUSE  60 g", "title": "Nordic Trail Crisp", "ing": "Ingredients: wholegrain oats, honey, rapeseed oil.", "alg": "Allergens: contains oats (gluten).", "exp": "Best before: 2027-09-18"},
}

CASES: list[dict[str, Any]] = [
    {"id": "sg_01", "category": "readable_glare_and_shadow", "lighting_mode": "off_strength_sun_glint", "degraded": False, "fg": "aml5", "q": "Is this my evening pill?", "expected": "match", "exp_str": "5 mg", "allergen": False, "desc": "Outdoor pharmacy pickup Amlodipine 5 mg with off-strength specular sun glint on upper-right laminate"},
    {"id": "sg_02", "category": "readable_glare_and_shadow", "lighting_mode": "diagonal_wearer_shadow", "degraded": False, "fg": "ibu400", "q": "Can I take this for pain?", "expected": "warning", "exp_str": "400 mg", "allergen": False, "desc": "Outdoor sunlit Burana ibuprofen 400 mg split by sharp diagonal wearer-head shadow"},
    {"id": "sg_03", "category": "readable_glare_and_shadow", "lighting_mode": "dim_tungsten_grain", "degraded": False, "fg": "aml10", "q": "Is this my evening pill?", "expected": "warning", "exp_str": "10 mg", "allergen": False, "desc": "Dim evening kitchen tungsten light and CMOS sensor grain on wrong-strength Amlodipine 10 mg"},
    {"id": "sg_04", "category": "readable_glare_and_shadow", "lighting_mode": "window_mullion_shadow_glint", "degraded": False, "fg": "met500", "q": "Is this my Metformin?", "expected": "match", "exp_str": "500 mg", "allergen": False, "desc": "Window-mullion diagonal shadow and off-strength laminate glint on Metformin 500 mg carton"},
    {"id": "sg_05", "category": "readable_glare_and_shadow", "lighting_mode": "outdoor_glint_and_shadow", "degraded": False, "fg": "peanut_bar", "q": "Does this contain peanuts or tree nuts?", "expected": "warning", "exp_str": None, "allergen": True, "desc": "Outdoor bench sun glint and diagonal wearer shadow on Peanut and Hazelnut Bar with legible allergens"},
    {"id": "sg_06", "category": "readable_glare_and_shadow", "lighting_mode": "evening_tungsten_grain", "degraded": False, "fg": "oat_drink", "q": "Is this safe with my nut allergies?", "expected": "info", "exp_str": None, "allergen": False, "desc": "Dim evening tungsten light and sensor grain on safe Nordic Oat Drink carton"},
    {"id": "sg_07", "category": "blown_highlight_occlusion", "lighting_mode": "window_sun_over_strength", "degraded": True, "fg": "aml5", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Saturated white window-sun reflection directly over Amlodipine strength badge obliterating 5 mg"},
    {"id": "sg_08", "category": "blown_highlight_occlusion", "lighting_mode": "silhouetted_backlit_window", "degraded": True, "fg": "aml5", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Silhouetted backlit medicine carton held against dazzling bright window with unreadable front text"},
    {"id": "sg_09", "category": "blown_highlight_occlusion", "lighting_mode": "lens_flare_ing_strength", "degraded": True, "fg": "met500", "q": "Is this my Metformin?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Ray-Ban outer-lens solar flare streak and aperture ghost obliterating Metformin ingredient and strength"},
    {"id": "sg_10", "category": "blown_highlight_occlusion", "lighting_mode": "uv_varnish_sheet_glare", "degraded": True, "fg": "ato20", "q": "Is this my evening cholesterol pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Broad midday sun reflection off glossy UV-coated Atorvastatin carton obliterating 20 mg strength"},
    {"id": "sg_11", "category": "blown_highlight_occlusion", "lighting_mode": "outdoor_glare_allergen_panel", "degraded": True, "fg": "trail_crisp", "q": "Is this safe with my nut allergies?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Saturated outdoor sun reflection across glossy snack wrapper obliterating ingredients and allergens"},
    {"id": "sg_12", "category": "blown_highlight_occlusion", "lighting_mode": "two_frame_glare_sweep", "degraded": True, "fg": "aml5", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Two-frame outdoor head-turn glare sweep where shifting sun reflection obliterates Amlodipine strength in both frames"},
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
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_DIR.is_dir():
        ev["TMPDIR"] = str(SHM_DIR)
    return ev


def render_scene_backdrop(seed: int, style: str) -> Image.Image:
    size = 768
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / (size - 1.0), yy / (size - 1.0)
    rng = np.random.default_rng(seed)
    if style == "outdoor_daylight":
        r = np.where(ny < 0.36, 206.0 + 34.0 * (1.0 - ny / 0.36), 192.0 - 28.0 * ((ny - 0.36) / 0.64))
        g = np.where(ny < 0.36, 222.0 + 26.0 * (1.0 - ny / 0.36), 186.0 - 26.0 * ((ny - 0.36) / 0.64))
        b = np.where(ny < 0.36, 242.0 + 12.0 * (1.0 - ny / 0.36), 176.0 - 24.0 * ((ny - 0.36) / 0.64))
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 2.0, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        d.rectangle((42, 74, 244, 268), fill=(182, 198, 210), outline=(136, 150, 162), width=3)
        d.rectangle((56, 86, 230, 118), fill=(26, 128, 92))
        d.text((74, 94), "APTEEKKI", fill=(246, 252, 248), font=ImageFont.load_default(size=20))
        d.line((0, int(size * 0.36), size, int(size * 0.36)), fill=(142, 138, 132), width=3)
        return im.filter(ImageFilter.GaussianBlur(radius=3.2))
    if style == "tungsten_evening":
        bulb = np.exp(-(((nx - 0.72) / 0.48) ** 2 + ((ny - 0.12) / 0.42) ** 2))
        r = 78.0 + 82.0 * bulb - 18.0 * ny
        g = 56.0 + 62.0 * bulb - 14.0 * ny
        b = 34.0 + 36.0 * bulb - 10.0 * ny
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 3.0, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        ImageDraw.Draw(im).line((0, 340, size, 340), fill=(62, 44, 28), width=3)
        return im.filter(ImageFilter.GaussianBlur(radius=2.2))
    if style == "bright_window":
        arr = np.full((size, size, 3), 252.0, dtype=np.float32)
        border = (nx < 0.07) | (nx > 0.93) | (ny < 0.06) | (ny > 0.88)
        arr[border] = [196.0, 198.0, 202.0]
        mullion = (np.abs(nx - 0.50) < 0.014) | (np.abs(ny - 0.38) < 0.014)
        arr[mullion] = [226.0, 230.0, 236.0]
        return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB").filter(ImageFilter.GaussianBlur(radius=2.5))
    r = 224.0 - 24.0 * ny + 12.0 * (1.0 - nx)
    g = 222.0 - 24.0 * ny + 10.0 * (1.0 - nx)
    b = 216.0 - 20.0 * ny + 8.0 * (1.0 - nx)
    arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 1.8, (size, size, 3))
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    ImageDraw.Draw(im).line((0, 320, size, 320), fill=(138, 118, 96), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=2.0))


def render_box(
    spec: dict[str, Any],
    w: int = 560,
    h: int = 420,
    hide_sub: bool = False,
    hide_str: bool = False,
    hide_dose: bool = False,
    hide_food_panel: bool = False,
) -> Image.Image:
    im = Image.new("RGB", (w, h), (250, 251, 253) if not spec.get("food") else (248, 243, 234))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w, 52), fill=spec["accent"])
    d.text((20, 15), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=20))
    d.text((20, 70), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=38))
    if spec.get("food"):
        d.rounded_rectangle((18, 128, w - 18, 296), radius=8, fill=(254, 253, 249), outline=(182, 176, 164), width=2)
        if not hide_food_panel:
            d.text((28, 146), spec["ing"], fill=(20, 24, 22), font=ImageFont.load_default(size=19))
            d.rounded_rectangle((28, 206, w - 28, 274), radius=6, fill=(255, 244, 232), outline=(196, 124, 66), width=2)
            d.text((38, 228), spec["alg"], fill=(98, 36, 18), font=ImageFont.load_default(size=19))
        d.text((22, h - 54), spec["exp"], fill=(20, 24, 28), font=ImageFont.load_default(size=22))
        return im
    if not hide_sub:
        d.text((20, 122), spec["sub"], fill=(42, 50, 60), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((20, 168, 232, 240), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    if not hide_str:
        d.text((36, 182), spec["str"], fill=(12, 18, 26), font=ImageFont.load_default(size=38))
    if not hide_dose:
        d.text((20, 268), spec["dose"], fill=(34, 42, 52), font=ImageFont.load_default(size=20))
    d.text((20, h - 52), f"30 tablets    {spec['exp']}", fill=(22, 28, 36), font=ImageFont.load_default(size=22))
    return im


def apply_specular_patch(
    im: Image.Image,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    angle_deg: float = 0.0,
    strength: float = 1.0,
    hard_clip: bool = False,
) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = math.radians(angle_deg)
    ct, st = math.cos(th), math.sin(th)
    dx = (xx - cx) * ct + (yy - cy) * st
    dy = -(xx - cx) * st + (yy - cy) * ct
    r2 = (dx / max(1.0, rx)) ** 2 + (dy / max(1.0, ry)) ** 2
    if hard_clip:
        core = np.clip(1.45 - 0.85 * r2, 0.0, 1.0)
        halo = np.exp(-0.55 * r2) * strength
        w_tot = np.clip(core + 0.65 * halo, 0.0, 1.0)[..., None]
        target = np.array([255.0, 255.0, 253.0], dtype=np.float32)
        arr = arr * (1.0 - w_tot) + target * w_tot
        arr[r2 <= 0.88] = 255.0
    else:
        glint = np.exp(-1.15 * r2) * strength
        w_tot = np.clip(glint, 0.0, 0.92)[..., None]
        target = np.array([255.0, 253.0, 246.0], dtype=np.float32)
        arr = arr * (1.0 - w_tot) + target * w_tot
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def apply_diagonal_shadow(im: Image.Image, nx_w: float, ny_w: float, thresh: float, factor: float, bands: bool = False) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    proj = (xx / w) * nx_w + (yy / h) * ny_w
    if bands:
        mask = 0.5 + 0.5 * np.tanh((np.sin(proj * 15.0) - 0.15) * 7.0)
    else:
        mask = 1.0 / (1.0 + np.exp((proj - thresh) * 55.0))
    scale = np.stack([
        1.0 - mask * (1.0 - factor * 0.95),
        1.0 - mask * (1.0 - factor * 1.00),
        1.0 - mask * (1.0 - factor * 1.07),
    ], axis=-1)
    return Image.fromarray(np.clip(arr * scale, 0, 255).astype(np.uint8), mode="RGB")


def apply_tungsten_and_grain(im: Image.Image, seed: int, sigma: float = 9.0) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32).copy()
    rng = np.random.default_rng(seed)
    gains = np.array([0.82, 0.69, 0.52], dtype=np.float32)
    arr = arr * gains
    luma_noise = rng.normal(0.0, sigma, (arr.shape[0], arr.shape[1], 1)).astype(np.float32)
    chroma_noise = rng.normal(0.0, sigma * 0.45, arr.shape).astype(np.float32)
    arr = arr + luma_noise + chroma_noise
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def apply_glasses_vignette(im: Image.Image, strength: float = 0.14) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w * 0.5) / (w * 0.5)) ** 2 + ((yy - h * 0.5) / (h * 0.5)) ** 2
    vig = np.clip(1.0 - strength * (r2 ** 1.1), 0.72, 1.0)[..., None]
    return Image.fromarray(np.clip(arr * vig, 0, 255).astype(np.uint8), mode="RGB")


def paste_held_angle(bg: Image.Image, card: Image.Image, x: int, y: int, tilt_deg: float = 0.0, dark_hand: bool = False) -> Image.Image:
    sc = bg.convert("RGBA")
    w, h = card.size
    cx = x + w * 0.5
    hand_fill = (32, 28, 26, 255) if dark_hand else (212, 172, 144, 255)
    hand_out = (20, 18, 18, 255) if dark_hand else (174, 134, 106, 255)
    sh = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x + 8, y + 10, x + w + 8, y + h + 10), radius=10, fill=(36, 30, 24, 92))
    sc = Image.alpha_composite(sc, sh.filter(ImageFilter.GaussianBlur(radius=8.0)))
    card_rgba = card.convert("RGBA")
    ImageDraw.Draw(card_rgba).rectangle((0, 0, w - 1, h - 1), outline=(160, 166, 174, 255) if not dark_hand else (60, 64, 70, 255), width=2)
    if abs(tilt_deg) > 0.05:
        rot = card_rgba.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
        rx = int(round(x - (rot.width - w) * 0.5))
        ry = int(round(y - (rot.height - h) * 0.5))
        sc.alpha_composite(rot, dest=(rx, ry))
    else:
        sc.alpha_composite(card_rgba, dest=(x, y))
    hd = ImageDraw.Draw(sc)
    hd.rounded_rectangle((int(cx - 112), y + h - 14, int(cx - 28), y + h + 74), radius=28, fill=hand_fill, outline=hand_out, width=2)
    hd.rounded_rectangle((int(cx + 28), y + h - 14, int(cx + 112), y + h + 74), radius=28, fill=hand_fill, outline=hand_out, width=2)
    return sc.convert("RGB")


def apply_solar_lens_flare(im: Image.Image, sun_x: float, sun_y: float, streak_y: float) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sr2 = ((xx - sun_x) / 115.0) ** 2 + ((yy - sun_y) / 115.0) ** 2
    sun_glow = np.exp(-0.55 * sr2)[..., None] * np.array([255.0, 248.0, 228.0], dtype=np.float32)
    dy = yy - (streak_y + 0.14 * (xx - 360.0))
    band = np.exp(-((np.abs(dy) / 56.0) ** 2.6)) * np.exp(-((np.abs(xx - 340.0) / 340.0) ** 2.4))
    veil = np.exp(-((dy / 96.0) ** 2)) * np.exp(-(((xx - 340.0) / 390.0) ** 2))
    ghost1 = np.exp(-(((xx - 486.0) / 76.0) ** 2 + ((yy - (streak_y + 22.0)) / 50.0) ** 2))
    arr = arr + sun_glow * 0.85 + ghost1[..., None] * np.array([110.0, 178.0, 218.0], dtype=np.float32) + veil[..., None] * np.array([150.0, 146.0, 132.0], dtype=np.float32)
    w_band = np.clip(band * 1.65, 0.0, 1.0)[..., None]
    arr = arr * (1.0 - w_band) + 255.0 * w_band
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def render_case_frames(case: dict[str, Any], idx: int) -> list[Image.Image]:
    seed = 202655 + idx * 41
    mode = case["lighting_mode"]
    spec = BOX_SPECS[case["fg"]]
    if mode == "off_strength_sun_glint":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        card = apply_specular_patch(render_box(spec), cx=476.0, cy=154.0, rx=64.0, ry=46.0, angle_deg=-18.0, strength=0.95, hard_clip=False)
        return [apply_glasses_vignette(paste_held_angle(bg, card, 104, 236, tilt_deg=-1.6))]
    if mode == "diagonal_wearer_shadow":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        card = render_box(spec)
        sc = paste_held_angle(bg, card, 104, 238, tilt_deg=1.4)
        sc = apply_diagonal_shadow(sc, nx_w=0.68, ny_w=0.32, thresh=0.52, factor=0.60, bands=False)
        return [apply_glasses_vignette(sc)]
    if mode == "dim_tungsten_grain":
        bg = render_scene_backdrop(seed, "tungsten_evening")
        sc = paste_held_angle(bg, render_box(spec), 104, 240, tilt_deg=-1.2)
        return [apply_glasses_vignette(apply_tungsten_and_grain(sc, seed, sigma=8.8), strength=0.18)]
    if mode == "window_mullion_shadow_glint":
        bg = render_scene_backdrop(seed, "window_counter")
        card = apply_specular_patch(render_box(spec), cx=472.0, cy=196.0, rx=58.0, ry=40.0, angle_deg=14.0, strength=0.88, hard_clip=False)
        sc = paste_held_angle(bg, card, 104, 238, tilt_deg=1.1)
        sc = apply_diagonal_shadow(sc, nx_w=0.75, ny_w=0.25, thresh=0.48, factor=0.66, bands=True)
        return [apply_glasses_vignette(sc)]
    if mode == "outdoor_glint_and_shadow":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        card = apply_specular_patch(render_box(spec), cx=500.0, cy=52.0, rx=52.0, ry=32.0, angle_deg=-12.0, strength=0.90, hard_clip=False)
        sc = paste_held_angle(bg, card, 104, 236, tilt_deg=-1.3)
        sc = apply_diagonal_shadow(sc, nx_w=0.72, ny_w=0.28, thresh=0.44, factor=0.63, bands=False)
        return [apply_glasses_vignette(sc)]
    if mode == "evening_tungsten_grain":
        bg = render_scene_backdrop(seed, "tungsten_evening")
        card = apply_specular_patch(render_box(spec), cx=496.0, cy=88.0, rx=44.0, ry=26.0, angle_deg=10.0, strength=0.72, hard_clip=False)
        sc = paste_held_angle(bg, card, 104, 240, tilt_deg=1.2)
        return [apply_glasses_vignette(apply_tungsten_and_grain(sc, seed, sigma=8.2), strength=0.18)]
    if mode == "window_sun_over_strength":
        bg = render_scene_backdrop(seed, "window_counter")
        sc = paste_held_angle(bg, render_box(spec, hide_str=True), 104, 238, tilt_deg=-1.5)
        sc = apply_specular_patch(sc, cx=228.0, cy=442.0, rx=156.0, ry=58.0, angle_deg=-8.0, strength=1.0, hard_clip=True)
        return [apply_glasses_vignette(sc)]
    if mode == "silhouetted_backlit_window":
        bg = render_scene_backdrop(seed, "bright_window")
        rng = np.random.default_rng(seed + 17)
        sil_arr = np.full((420, 560, 3), [16.0, 19.0, 24.0], dtype=np.float32) + rng.normal(0.0, 2.4, (420, 560, 3)).astype(np.float32)
        yy, xx = np.mgrid[0:420, 0:560].astype(np.float32)
        edge_d = np.minimum(np.minimum(xx, 559.0 - xx), np.minimum(yy, 419.0 - yy))
        wrap = np.exp(-edge_d / 9.0)[..., None] * 175.0
        sil_card = Image.fromarray(np.clip(sil_arr + wrap, 0, 255).astype(np.uint8), mode="RGB")
        sc = paste_held_angle(bg, sil_card, 104, 224, tilt_deg=-1.8, dark_hand=True)
        return [apply_glasses_vignette(sc, strength=0.06)]
    if mode == "lens_flare_ing_strength":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        card = render_box(spec, hide_sub=True, hide_str=True, hide_dose=True)
        sc = paste_held_angle(bg, card, 104, 238, tilt_deg=1.6)
        sc = apply_solar_lens_flare(sc, sun_x=86.0, sun_y=64.0, streak_y=432.0)
        return [apply_glasses_vignette(sc)]
    if mode == "uv_varnish_sheet_glare":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        sc = paste_held_angle(bg, render_box(spec, hide_str=True, hide_dose=True), 104, 238, tilt_deg=-1.4)
        sc = apply_specular_patch(sc, cx=312.0, cy=468.0, rx=244.0, ry=80.0, angle_deg=-6.0, strength=1.0, hard_clip=True)
        return [apply_glasses_vignette(sc)]
    if mode == "outdoor_glare_allergen_panel":
        bg = render_scene_backdrop(seed, "outdoor_daylight")
        sc = paste_held_angle(bg, render_box(spec, hide_food_panel=True), 104, 238, tilt_deg=1.5)
        sc = apply_specular_patch(sc, cx=382.0, cy=452.0, rx=272.0, ry=94.0, angle_deg=4.0, strength=1.0, hard_clip=True)
        return [apply_glasses_vignette(sc)]
    bg1 = render_scene_backdrop(seed, "outdoor_daylight")
    f1 = paste_held_angle(bg1, render_box(spec, hide_str=True), 98, 240, tilt_deg=-2.4)
    f1 = apply_glasses_vignette(apply_specular_patch(f1, cx=220.0, cy=444.0, rx=148.0, ry=56.0, angle_deg=-10.0, strength=1.0, hard_clip=True))
    bg2 = render_scene_backdrop(seed + 9, "outdoor_daylight")
    f2 = paste_held_angle(bg2, render_box(spec, hide_str=True), 112, 236, tilt_deg=2.1)
    f2 = apply_glasses_vignette(apply_specular_patch(f2, cx=262.0, cy=442.0, rx=160.0, ry=58.0, angle_deg=9.0, strength=1.0, hard_clip=True))
    return [f1, f2]


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b}} for b in frames_b64] + [{"text": f'The person asked: "{question}"'}]
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
    ev = sub_env()
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
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
    data = json.loads(raw_txt)
    assert data["suite"] == "glasses_outdoor_sunglass_glare"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env(), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / s["n_cases"], 4)
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        imgs = render_case_frames(c, idx)
        b64s: list[str] = []
        for fi, im in enumerate(imgs, 1):
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (OUT_IMG_DIR / (f"{c['id']}.jpg" if len(imgs) == 1 else f"{c['id']}_f{fi}.jpg")).write_bytes(raw)
            b64s.append(base64.b64encode(raw).decode("ascii"))
        rendered.append({"case": c, "b64s": b64s})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
        return 0
    try:
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        with ThreadPoolExecutor(max_workers=4) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64s"], r["case"]["q"]), rendered))
        errors = sum(0 if o.get("ok") else 1 for o in api_outs)
        if errors:
            raise RuntimeError(f"API errors: {errors}")
        scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    finally:
        shutil.rmtree(OUT_IMG_DIR, ignore_errors=True)
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
            "lighting_mode": c["lighting_mode"],
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
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} str={s_val}@{s_conf} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    leg = [x for x in cases_out if x["category"] == "readable_glare_and_shadow"]
    deg = [x for x in cases_out if x["category"] == "blown_highlight_occlusion"]
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
        "readable_glare_and_shadow_accuracy": round(sum(1 for x in leg if x["verdict_ok"]) / len(leg), 4),
        "blown_highlight_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": "glasses_outdoor_sunglass_glare",
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
    OUT_JSON.write_text(json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=True) + "\n", encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
