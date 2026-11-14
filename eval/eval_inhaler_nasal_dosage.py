import argparse
import base64
import datetime
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "inhaler_nasal_dosage"
OUT_JSON_PATH = REPO_ROOT / "eval" / "inhaler_nasal_dosage_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
API_KEY_PREFIX = "AI" + "za"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{10,}")

INHALER_NASAL_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "sal_mdi",
            "name": "Ventoline Evohaler",
            "ingredient": "salbutamol",
            "strength": "100 mcg/dose",
            "schedule": ["as needed"],
            "notes": "Reliever pressurized metered-dose inhaler, 1 to 2 puffs as needed",
        },
        {
            "id": "flu_ns",
            "name": "Flixonase",
            "ingredient": "fluticasone",
            "strength": "50 mcg/spray",
            "schedule": ["morning"],
            "notes": "Aqueous metered nasal spray once daily in the morning",
        },
        {
            "id": "sym_th",
            "name": "Symbicort Turbuhaler",
            "ingredient": "budesonide, formoterol",
            "strength": "160 mcg / 4.5 mcg",
            "schedule": ["morning", "evening"],
            "notes": "Combination maintenance dry-powder inhaler twice daily",
        },
        {
            "id": "salm_dk",
            "name": "Serevent Diskus",
            "ingredient": "salmeterol",
            "strength": "50 mcg/dose",
            "schedule": ["morning", "evening"],
            "notes": "Circular Diskus dry-powder bronchodilator twice daily",
        },
    ],
    "allergies": ["peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "in_01",
        "category": "per_actuation_match",
        "package_type": "pmdi_inhaler",
        "occlusion_mode": "none",
        "description": "Pressurized metered-dose inhaler VENTOLINE EVOHALER (salbutamol) 100 mcg/dose with 200 metered doses pack counter match",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "100 mcg/dose",
        "printed_strength": "100 mcg/dose",
        "actuation_counter_text": "200 metered doses",
        "expected_strength": "100 mcg/dose",
        "expected_ingredient": "salbutamol",
        "expected_level": "match",
        "header": "GSK",
        "title": "VENTOLINE EVOHALER",
        "subtitle": "salbutamol",
        "form_line": "Pressurised inhalation, suspension",
        "counter_line": "200 metered doses",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 96, 168),
        "body_rgb": (74, 138, 202),
        "cap_rgb": (24, 68, 132),
        "badge_bg": (236, 245, 254),
        "seed": 5201,
    },
    {
        "id": "in_02",
        "category": "wrong_strength_warning",
        "package_type": "easyhaler_dpi",
        "occlusion_mode": "none",
        "description": "Nordic BUVENTOL EASYHALER (salbutamol) 200 mikrog/annos dry-powder inhaler 2x wrong-strength warning vs 100 mcg/dose profile",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "200 mikrog/annos",
        "printed_strength": "200 mikrog/annos",
        "actuation_counter_text": "200 annosta",
        "counter_window_digits": "200",
        "expected_strength": "200 mcg/dose",
        "expected_ingredient": "salbutamol",
        "expected_level": "warning",
        "expected_reason_substr": "differs from your",
        "header": "ORION PHARMA",
        "title": "BUVENTOL EASYHALER",
        "subtitle": "salbutamol",
        "form_line": "Inhalaatiojauhe",
        "counter_line": "200 annosta",
        "expiry_line": "EXP 2027-10",
        "accent": (18, 88, 162),
        "cap_rgb": (28, 96, 174),
        "badge_bg": (236, 245, 254),
        "seed": 5202,
    },
    {
        "id": "in_03",
        "category": "per_actuation_match",
        "package_type": "nasal_spray",
        "occlusion_mode": "none",
        "description": "Aqueous metered nasal spray FLIXONASE (fluticasone propionate) 50 mcg/spray with 120 sprays counter distractor match",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "50 mcg/spray",
        "printed_strength": "50 mcg/spray",
        "actuation_counter_text": "120 metered sprays",
        "expected_strength": "50 mcg/spray",
        "expected_ingredient": "fluticasone",
        "expected_level": "match",
        "header": "HALEON",
        "title": "FLIXONASE",
        "subtitle": "fluticasone propionate",
        "form_line": "Aqueous nasal spray, suspension",
        "counter_line": "120 metered sprays",
        "expiry_line": "EXP 2027-09",
        "accent": (20, 124, 108),
        "cap_rgb": (48, 164, 146),
        "badge_bg": (234, 249, 246),
        "seed": 5203,
    },
    {
        "id": "in_04",
        "category": "per_actuation_match",
        "package_type": "turbuhaler_dpi",
        "occlusion_mode": "none",
        "description": "Nordic SYMBICORT TURBUHALER (budesonide, formoterol) 160 mcg / 4.5 mcg combination dry-powder inhaler match",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "160 mcg / 4.5 mcg",
        "printed_strength": "160 mcg / 4.5 mcg",
        "actuation_counter_text": "120 doses",
        "counter_window_digits": "120",
        "expected_strength": "160 mcg / 4.5 mcg",
        "expected_ingredient": "budesonide",
        "expected_level": "match",
        "header": "ASTRAZENECA",
        "title": "SYMBICORT TURBUHALER",
        "subtitle": "budesonide, formoterol",
        "form_line": "Inhalation powder",
        "counter_line": "120 doses",
        "expiry_line": "EXP 2027-12",
        "accent": (182, 30, 44),
        "grip_rgb": (192, 34, 46),
        "badge_bg": (254, 240, 242),
        "seed": 5204,
    },
    {
        "id": "in_05",
        "category": "wrong_strength_warning",
        "package_type": "turbuhaler_dpi",
        "occlusion_mode": "none",
        "description": "High-strength SYMBICORT TURBUHALER (budesonide, formoterol) 320 mcg / 9 mcg 2x combination DPI trap vs 160 mcg / 4.5 mcg profile",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "320 mcg / 9 mcg",
        "printed_strength": "320 mcg / 9 mcg",
        "actuation_counter_text": "60 doses",
        "counter_window_digits": "60",
        "expected_strength": "320 mcg / 9 mcg",
        "expected_ingredient": "budesonide",
        "expected_level": "warning",
        "expected_reason_substr": "differs from your",
        "header": "ASTRAZENECA",
        "title": "SYMBICORT TURBUHALER",
        "subtitle": "budesonide, formoterol",
        "form_line": "Inhalation powder",
        "counter_line": "60 doses",
        "expiry_line": "EXP 2027-11",
        "accent": (164, 24, 58),
        "grip_rgb": (184, 28, 56),
        "badge_bg": (254, 236, 242),
        "seed": 5205,
    },
    {
        "id": "in_06",
        "category": "expired_inhaler_warning",
        "package_type": "diskus_dpi",
        "occlusion_mode": "none",
        "description": "Circular SEREVENT DISKUS (salmeterol) 50 mcg/dose dry-powder inhaler with EXP 2025-01 past-expiry safety catch",
        "strength_readable": True,
        "is_occluded": False,
        "has_distractor_counter": True,
        "has_profile_allergen": False,
        "strength_badge": "50 mcg/dose",
        "printed_strength": "50 mcg/dose",
        "actuation_counter_text": "60 doses",
        "counter_window_digits": "60",
        "expected_strength": "50 mcg/dose",
        "expected_ingredient": "salmeterol",
        "expected_level": "warning",
        "expected_reason_substr": "expired 2025-01",
        "header": "GSK",
        "title": "SEREVENT DISKUS",
        "subtitle": "salmeterol",
        "form_line": "Inhalation powder, pre-dispensed",
        "counter_line": "60 doses",
        "expiry_line": "EXP 2025-01",
        "accent": (20, 128, 102),
        "shell_outer_rgb": (48, 166, 138),
        "shell_inner_rgb": (22, 118, 94),
        "badge_bg": (236, 250, 246),
        "seed": 5206,
    },
    {
        "id": "in_07",
        "category": "degraded_abstention",
        "package_type": "pmdi_inhaler",
        "occlusion_mode": "thumb_grip_over_canister",
        "description": "Zero-guess trap: VENTOLINE EVOHALER (salbutamol) pMDI with thumb grip covering per-dose mcg strength badge",
        "strength_readable": False,
        "is_occluded": True,
        "has_distractor_counter": False,
        "has_profile_allergen": False,
        "strength_badge": None,
        "printed_strength": "100 mcg/dose",
        "actuation_counter_text": "200 metered doses",
        "expected_strength": None,
        "expected_ingredient": "salbutamol",
        "expected_level": "unsure",
        "header": "GSK",
        "title": "VENTOLINE EVOHALER",
        "subtitle": "salbutamol",
        "form_line": "Pressurised inhalation, suspension",
        "counter_line": "200 metered doses",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 96, 168),
        "body_rgb": (74, 138, 202),
        "cap_rgb": (24, 68, 132),
        "badge_bg": (236, 245, 254),
        "seed": 5207,
    },
    {
        "id": "in_08",
        "category": "degraded_abstention",
        "package_type": "aluminum_mdi_canister",
        "occlusion_mode": "curved_aluminum_specular_glare",
        "description": "Zero-guess trap: pressurized aluminum MDI canister VENTOLINE EVOHALER (salbutamol) with curved metallic specular glare over mcg digits",
        "strength_readable": False,
        "is_occluded": True,
        "has_distractor_counter": False,
        "has_profile_allergen": False,
        "strength_badge": None,
        "printed_strength": "100 mcg/dose",
        "actuation_counter_text": "200 metered doses",
        "expected_strength": None,
        "expected_ingredient": "salbutamol",
        "expected_level": "unsure",
        "header": "GSK",
        "title": "VENTOLINE EVOHALER",
        "subtitle": "salbutamol",
        "form_line": "Pressurised canister, suspension",
        "counter_line": "200 metered doses",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 96, 168),
        "badge_bg": (236, 245, 254),
        "seed": 5208,
    },
    {
        "id": "in_09",
        "category": "degraded_abstention",
        "package_type": "diskus_dpi",
        "occlusion_mode": "counter_visible_strength_obliterated",
        "description": "Zero-guess trap: circular SEREVENT DISKUS (salmeterol) with dose-counter window 60 visible while mcg strength badge is obliterated",
        "strength_readable": False,
        "is_occluded": True,
        "has_distractor_counter": False,
        "has_profile_allergen": False,
        "strength_badge": None,
        "printed_strength": "50 mcg/dose",
        "actuation_counter_text": "60 doses",
        "counter_window_digits": "60",
        "expected_strength": None,
        "expected_ingredient": "salmeterol",
        "expected_level": "unsure",
        "header": "GSK",
        "title": "SEREVENT DISKUS",
        "subtitle": "salmeterol",
        "form_line": "Inhalation powder, pre-dispensed",
        "counter_line": "60 doses",
        "expiry_line": "EXP 2027-11",
        "accent": (20, 128, 102),
        "shell_outer_rgb": (48, 166, 138),
        "shell_inner_rgb": (22, 118, 94),
        "badge_bg": (236, 250, 246),
        "seed": 5209,
    },
    {
        "id": "in_10",
        "category": "degraded_abstention",
        "package_type": "nasal_spray",
        "occlusion_mode": "thumb_and_crust_over_spray_strength",
        "description": "Zero-guess trap: metered nasal spray FLIXONASE (fluticasone propionate) with thumb and dried spray crust covering mcg/spray digits",
        "strength_readable": False,
        "is_occluded": True,
        "has_distractor_counter": False,
        "has_profile_allergen": False,
        "strength_badge": None,
        "printed_strength": "50 mcg/spray",
        "actuation_counter_text": "120 metered sprays",
        "expected_strength": None,
        "expected_ingredient": "fluticasone",
        "expected_level": "unsure",
        "header": "HALEON",
        "title": "FLIXONASE",
        "subtitle": "fluticasone propionate",
        "form_line": "Aqueous nasal spray, suspension",
        "counter_line": "120 metered sprays",
        "expiry_line": "EXP 2027-09",
        "accent": (20, 124, 108),
        "cap_rgb": (48, 164, 146),
        "badge_bg": (234, 249, 246),
        "seed": 5210,
    },
]


def scrub_node(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return API_KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [scrub_node(x) for x in val]
    if isinstance(val, dict):
        return {scrub_node(str(k)): scrub_node(v) for k, v in val.items()}
    return val


def assert_clean_artifact(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in artifact string: {node[:80]}")
        if API_KEY_RE.search(node):
            raise AssertionError("Forbidden API key pattern in artifact string")
        if node.startswith("/9j/") or node.startswith("data:image") or len(node) > 1800:
            raise AssertionError("Forbidden base64 or oversized string in artifact")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_artifact(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_artifact(k)
            assert_clean_artifact(v)


def load_env_with_proxy() -> None:
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k_b, v_b = chunk.split(b"=", 1)
                    k_s = k_b.decode("utf-8", errors="ignore").strip()
                    v_s = v_b.decode("utf-8", errors="ignore")
                    if k_s and k_s not in os.environ:
                        os.environ[k_s] = v_s
        except (OSError, subprocess.SubprocessError):
            pass

    for env_path in (home_env, repo_env):
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(HASH_CHAR):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def inline_schema_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None and isinstance(node, dict):
        defs = node.get("$defs") or {}
    if isinstance(node, list):
        return [inline_schema_refs(item, defs) for item in node]
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and defs is not None:
            ref_name = ref.rsplit("/", 1)[-1]
            return inline_schema_refs(defs[ref_name], defs)
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            out[k] = inline_schema_refs(v, defs)
        return out
    return node


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def clamp_byte(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(round(v))


def fit_font(
    draw: ImageDraw.ImageDraw,
    text: str,
    max_width: int,
    start_size: int,
    min_size: int = 18,
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    sz = start_size
    while sz > min_size:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_width:
            return f
        sz -= 2
    return ImageFont.load_default(size=min_size)


def add_sensor_grain(img: Image.Image, seed: int, sigma: float = 2.2) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    sw, sh = w // 2, h // 2
    noise = bytearray(sw * sh)
    for idx in range(len(noise)):
        val = int(128 + rng.gauss(0.0, sigma))
        noise[idx] = 0 if val < 0 else (255 if val > 255 else val)
    grain = Image.frombytes("L", (sw, sh), bytes(noise)).resize((w, h), Image.Resampling.BILINEAR)
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    return Image.blend(img.convert("RGB"), grain_rgb, alpha=0.036)


def render_counter_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = 566
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(234 - 24 * t)
        g = clamp_byte(236 - 22 * t)
        b = clamp_byte(232 - 18 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        grain = rng.randint(-3, 3)
        r = clamp_byte(192 - 26 * t + grain)
        g = clamp_byte(168 - 22 * t + grain)
        b = clamp_byte(138 - 18 * t + grain)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(142, 118, 94), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((24, 20, 210, 192), fill=(255, 250, 240, 44))
    bd.ellipse((540, 36, 744, 224), fill=(236, 246, 255, 38))
    bd.ellipse((268, 12, 464, 152), fill=(255, 248, 236, 26))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=24.0))
    return Image.alpha_composite(img.convert("RGBA"), bokeh).convert("RGB")


def sample_tex_bilinear(tex_bytes: bytes, tex_w: int, tex_h: int, u: float, v: float) -> tuple[float, float, float]:
    uc = max(0.0, min(float(tex_w - 1), u))
    vc = max(0.0, min(float(tex_h - 1), v))
    x0 = int(math.floor(uc))
    y0 = int(math.floor(vc))
    x1 = min(tex_w - 1, x0 + 1)
    y1 = min(tex_h - 1, y0 + 1)
    fx = uc - x0
    fy = vc - y0

    i00 = (y0 * tex_w + x0) * 3
    i10 = (y0 * tex_w + x1) * 3
    i01 = (y1 * tex_w + x0) * 3
    i11 = (y1 * tex_w + x1) * 3

    w00 = (1.0 - fx) * (1.0 - fy)
    w10 = fx * (1.0 - fy)
    w01 = (1.0 - fx) * fy
    w11 = fx * fy

    r = tex_bytes[i00] * w00 + tex_bytes[i10] * w10 + tex_bytes[i01] * w01 + tex_bytes[i11] * w11
    g = tex_bytes[i00 + 1] * w00 + tex_bytes[i10 + 1] * w10 + tex_bytes[i01 + 1] * w01 + tex_bytes[i11 + 1] * w11
    b = tex_bytes[i00 + 2] * w00 + tex_bytes[i10 + 2] * w10 + tex_bytes[i01 + 2] * w01 + tex_bytes[i11 + 2] * w11
    return r, g, b


def make_cylindrical_label_texture(case: dict[str, Any], tex_w: int = 920, tex_h: int = 680) -> Image.Image:
    tex = Image.new("RGB", (tex_w, tex_h), (252, 252, 249))
    draw = ImageDraw.Draw(tex)

    accent = case["accent"]
    draw.rectangle((0, 0, tex_w - 1, tex_h - 1), outline=(188, 190, 184), width=6)
    draw.rectangle((6, 6, tex_w - 7, 84), fill=accent)

    margin_x = 96
    usable_w = tex_w - 2 * margin_x

    f_hdr = fit_font(draw, case["header"], usable_w, 34, 20)
    f_title = fit_font(draw, case["title"], usable_w, 58, 28)
    f_sub = fit_font(draw, case["subtitle"], usable_w, 40, 22)
    f_body = fit_font(draw, case["form_line"], usable_w, 34, 20)
    f_cnt = fit_font(draw, case["counter_line"], usable_w, 36, 22)
    f_exp = fit_font(draw, case["expiry_line"], usable_w, 42, 24)

    draw.text((margin_x, 22), case["header"], fill=(250, 252, 255), font=f_hdr)
    draw.text(
        (margin_x, 98),
        case["title"],
        fill=(14, 20, 28),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )
    draw.text((margin_x, 174), case["subtitle"], fill=(36, 46, 58), font=f_sub)

    badge_y0 = 242
    badge_h = 104
    strength_badge = case.get("strength_badge")
    if isinstance(strength_badge, str) and strength_badge:
        f_str = fit_font(draw, strength_badge, usable_w - 56, 56, 26)
        bw = min(usable_w, int(draw.textlength(strength_badge, font=f_str)) + 52)
        draw.rounded_rectangle(
            (margin_x, badge_y0, margin_x + bw, badge_y0 + badge_h),
            radius=16,
            fill=case["badge_bg"],
            outline=accent,
            width=4,
        )
        draw.text(
            (margin_x + 24, badge_y0 + 20),
            strength_badge,
            fill=(10, 16, 24),
            font=f_str,
            stroke_width=1,
            stroke_fill=(10, 16, 24),
        )
    else:
        draw.rounded_rectangle(
            (margin_x, badge_y0, margin_x + 420, badge_y0 + badge_h),
            radius=16,
            fill=case["badge_bg"],
            outline=accent,
            width=4,
        )

    sep_y = badge_y0 + badge_h + 24
    draw.line((margin_x, sep_y, tex_w - margin_x, sep_y), fill=(210, 208, 200), width=3)

    draw.text((margin_x, sep_y + 18), case["form_line"], fill=(26, 34, 42), font=f_body)
    draw.text((margin_x, sep_y + 68), case["counter_line"], fill=(44, 52, 62), font=f_cnt)
    draw.text(
        (margin_x, tex_h - 80),
        case["expiry_line"],
        fill=(16, 22, 30),
        font=f_exp,
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    return tex


def overlay_realistic_thumb_left(canvas: Image.Image, tip_x: int, center_y: int, half_h: int) -> Image.Image:
    rgba = canvas.convert("RGBA")
    w, h = rgba.size

    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (-40, center_y - half_h + 8, tip_x + 12, center_y + half_h + 18),
        radius=half_h,
        fill=(18, 12, 8, 118),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=10.0))
    rgba = Image.alpha_composite(rgba, shadow)

    thumb = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = thumb.load()
    x_start = 0
    x_end = min(w - 1, tip_x)
    y_min = max(0, center_y - half_h - 6)
    y_max = min(h - 1, center_y + half_h + 6)
    cap_cx = tip_x - half_h

    for y in range(y_min, y_max + 1):
        for x in range(x_start, x_end + 1):
            slope_cy = center_y + 0.05 * (cap_cx - x)
            dy = (y - slope_cy) / float(half_h)
            if x <= cap_cx:
                inside = abs(dy) <= 1.0
                edge_d = abs(dy)
            else:
                dx = (x - cap_cx) / float(half_h)
                rad = math.hypot(dx, dy)
                inside = rad <= 1.0
                edge_d = rad
            if not inside:
                continue

            cyl = math.sqrt(max(0.0, 1.0 - min(1.0, dy * dy)))
            crease1 = math.exp(-(((x - (cap_cx - 86)) / 9.0) ** 2)) * (0.55 if abs(dy) < 0.72 else 0.0)
            crease2 = math.exp(-(((x - (cap_cx - 98)) / 7.0) ** 2)) * (0.42 if abs(dy) < 0.65 else 0.0)
            shade = 0.72 + 0.28 * cyl - 0.10 * max(0.0, dy) - 0.14 * (crease1 + crease2)

            r = clamp_byte(226.0 * shade + 8.0)
            g = clamp_byte(176.0 * shade + 4.0)
            b = clamp_byte(148.0 * shade + 2.0)

            nail_x0 = cap_cx - 12
            nail_x1 = tip_x - 10
            if nail_x0 <= x <= nail_x1 and abs(dy) <= 0.56:
                nx = (x - nail_x0) / max(1.0, float(nail_x1 - nail_x0))
                ny = dy / 0.56
                if ((nx - 0.52) / 0.54) ** 2 + (ny ** 2) <= 1.0:
                    lunula = 1.0 if ((nx - 0.12) / 0.24) ** 2 + (ny / 0.75) ** 2 <= 1.0 else 0.0
                    nr = 242.0 - 10.0 * abs(ny) + 8.0 * lunula
                    ng = 214.0 - 12.0 * abs(ny) + 14.0 * lunula
                    nb = 204.0 - 10.0 * abs(ny) + 16.0 * lunula
                    r, g, b = clamp_byte(nr), clamp_byte(ng), clamp_byte(nb)

            alpha = 255 if edge_d < 0.96 else clamp_byte(255.0 * (1.0 - (edge_d - 0.96) / 0.04))
            px[x, y] = (r, g, b, alpha)

    return Image.alpha_composite(rgba, thumb).convert("RGB")


def overlay_curved_aluminum_specular_glare(
    canvas: Image.Image,
    x_left: int,
    x_right: int,
    center_y: int,
    half_h: int,
) -> Image.Image:
    rgba = canvas.convert("RGBA")
    w, h = rgba.size

    bloom = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    bd = ImageDraw.Draw(bloom)
    bd.rounded_rectangle(
        (x_left - 22, center_y - half_h - 14, x_right + 22, center_y + half_h + 14),
        radius=half_h + 10,
        fill=(255, 255, 255, 238),
    )
    bd.polygon(
        [
            (x_left + 32, center_y - half_h - 46),
            (x_left + 132, center_y - half_h - 46),
            (x_left + 168, center_y + half_h + 52),
            (x_left + 64, center_y + half_h + 52),
        ],
        fill=(255, 255, 255, 212),
    )
    bloom = bloom.filter(ImageFilter.GaussianBlur(radius=13.0))
    rgba = Image.alpha_composite(rgba, bloom)

    core = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    cd = ImageDraw.Draw(core)
    cd.rounded_rectangle(
        (x_left + 2, center_y - half_h + 1, x_right - 2, center_y + half_h - 1),
        radius=max(12, half_h - 4),
        fill=(255, 255, 255, 255),
    )
    core = core.filter(ImageFilter.GaussianBlur(radius=3.5))
    rgba = Image.alpha_composite(rgba, core)
    return rgba.convert("RGB")


def overlay_spray_crust_and_thumb(
    canvas: Image.Image,
    crust_x0: int,
    crust_x1: int,
    center_y: int,
    half_h: int,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed)
    rgba = canvas.convert("RGBA")
    w, h = rgba.size

    crust = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crust)
    cd.rounded_rectangle(
        (crust_x0, center_y - half_h, crust_x1, center_y + half_h),
        radius=16,
        fill=(248, 249, 246, 255),
        outline=(216, 220, 214, 255),
        width=2,
    )
    for k in range(6):
        cx = crust_x0 + 18 + k * 34 + rng.randint(-5, 5)
        top_y = center_y - half_h - rng.randint(2, 7)
        bot_y = center_y + half_h + rng.randint(4, 14)
        rad = rng.randint(9, 13)
        cd.line((cx, top_y, cx, bot_y), fill=(244, 246, 241, 255), width=rad * 2)
        cd.ellipse((cx - rad - 1, bot_y - rad, cx + rad + 1, bot_y + rad + 3), fill=(250, 251, 247, 255))

    rgba = Image.alpha_composite(rgba, crust)
    return overlay_realistic_thumb_left(rgba.convert("RGB"), tip_x=crust_x0 + 206, center_y=center_y, half_h=half_h + 2)


def overlay_pocket_abrasion_gouge(
    canvas: Image.Image,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed)
    rgba = canvas.convert("RGBA")
    w, h = rgba.size
    gouge = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gouge)
    gd.rounded_rectangle(
        (x0 - 4, y0 - 2, x1 + 4, y1 + 2),
        radius=12,
        fill=(196, 192, 184, 255),
        outline=(138, 134, 126, 255),
        width=3,
    )
    for _ in range(38):
        gx0 = rng.randint(x0 - 2, x1 - 44)
        gy0 = rng.randint(y0 + 2, y1 - 2)
        gx1 = min(x1 + 2, gx0 + rng.randint(28, 78))
        gy1 = max(y0, min(y1, gy0 + rng.randint(-12, 12)))
        col = (238, 236, 230, 242) if rng.random() < 0.55 else (118, 114, 106, 224)
        gd.line((gx0, gy0, gx1, gy1), fill=col, width=rng.randint(3, 5))
    return Image.alpha_composite(rgba, gouge).convert("RGB")


def render_pmdi_inhaler(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_cylindrical_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 356
    radius = 162
    can_r = 122
    can_y0 = 76
    can_y1 = 172
    collar_y1 = 198
    body_y1 = 626
    label_y0 = 216
    label_y1 = 568
    sag_px = 8.0
    half_span = math.radians(70.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((xc - radius - 22, body_y1 - 24, xc + radius + 170, body_y1 + 38), fill=(24, 18, 12, 118))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)
    px = canvas.load()

    for y in range(can_y0, can_y1):
        yc_norm = (y - can_y0) / max(1.0, float(can_y1 - can_y0))
        cur_r = can_r if yc_norm > 0.12 else int(round(can_r * (0.90 + 0.10 * (yc_norm / 0.12))))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            brushed = 0.96 + 0.04 * math.sin(y * 1.3)
            metal_shade = 0.62 + 0.34 * max(0.0, math.cos(th + 0.45))
            spec = math.exp(-((th + 0.52) / 0.15) ** 2) * 58.0 + math.exp(-((th - 0.88) / 0.18) ** 2) * 26.0
            c = clamp_byte(208.0 * brushed * metal_shade + spec)
            px[xc + dx, y] = (c, clamp_byte(c + 2), clamp_byte(c + 6))

    draw.ellipse((xc - can_r + 8, can_y0 - 8, xc + can_r - 8, can_y0 + 10), fill=(214, 218, 224), outline=(156, 162, 170))

    body_rgb = case["body_rgb"]
    cap_rgb = case["cap_rgb"]

    boot_layer = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    bd = ImageDraw.Draw(boot_layer)
    bd.polygon(
        [
            (xc + 80, 470),
            (xc + 244, 504),
            (xc + 236, 618),
            (xc + 60, 624),
        ],
        fill=(body_rgb[0], body_rgb[1], body_rgb[2], 255),
    )
    bd.rounded_rectangle(
        (xc + 216, 496, xc + 298, 622),
        radius=20,
        fill=(cap_rgb[0], cap_rgb[1], cap_rgb[2], 255),
        outline=(18, 46, 96, 255),
        width=3,
    )
    bd.line((xc + 234, 514, xc + 234, 606), fill=(96, 148, 212, 140), width=4)
    canvas = Image.alpha_composite(canvas.convert("RGBA"), boot_layer).convert("RGB")
    px = canvas.load()

    for y in range(can_y1, body_y1):
        if y < collar_y1:
            t_col = (y - can_y1) / max(1.0, float(collar_y1 - can_y1))
            cur_r = int(round((can_r + 14) + (radius - (can_r + 14)) * t_col))
        else:
            yb = (y - collar_y1) / max(1.0, float(body_y1 - collar_y1))
            cur_r = radius if yb < 0.94 else int(round(radius * (1.0 - 0.06 * (((yb - 0.94) / 0.06) ** 2))))

        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            cos_t = math.cos(th)
            light = max(0.0, math.cos(th + 0.40))
            spec = math.exp(-((th + 0.78) / 0.14) ** 2) * 42.0
            shade = 0.66 + 0.30 * light + 0.05 * cos_t

            br = body_rgb[0] * shade + spec
            bg = body_rgb[1] * shade + spec
            bb = body_rgb[2] * shade + spec

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if y >= collar_y1 and 0.0 <= y_lbl <= 1.0 and abs(th) <= half_span:
                u = (0.5 + th / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.76 + 0.24 * light + 0.04 * cos_t
                r = clamp_byte(tr * paper_shade + spec * 0.20)
                g = clamp_byte(tg * paper_shade + spec * 0.20)
                b = clamp_byte(tb * paper_shade + spec * 0.20)
            else:
                r, g, b = clamp_byte(br), clamp_byte(bg), clamp_byte(bb)
            px[xc + dx, y] = (r, g, b)

    if case["occlusion_mode"] == "thumb_grip_over_canister":
        canvas = overlay_realistic_thumb_left(canvas, tip_x=xc + 128, center_y=375, half_h=35)

    return add_sensor_grain(canvas, seed=seed + 17)


def render_aluminum_mdi_canister(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_cylindrical_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 384
    radius = 166
    stem_y0 = 66
    stem_y1 = 104
    ferrule_y1 = 152
    shoulder_y1 = 194
    body_y1 = 644
    label_y0 = 232
    label_y1 = 584
    sag_px = 8.0
    half_span = math.radians(71.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 22, body_y1 - 22, xc + radius + 28, body_y1 + 34),
        fill=(24, 18, 12, 118),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    for y in range(stem_y0, stem_y1):
        cur_r = 22
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / float(cur_r))))
            c = clamp_byte(176 + 68 * max(0.0, math.cos(th + 0.4)))
            px[xc + dx, y] = (c, clamp_byte(c + 2), clamp_byte(c + 5))

    for y in range(stem_y1, ferrule_y1):
        cur_r = 92
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / float(cur_r))))
            crimp = 0.94 + 0.06 * math.sin((y - stem_y1) * 0.45)
            spec = math.exp(-((th + 0.48) / 0.14) ** 2) * 64.0
            c = clamp_byte(196 * crimp * (0.64 + 0.36 * max(0.0, math.cos(th + 0.42))) + spec)
            px[xc + dx, y] = (c, clamp_byte(c + 2), clamp_byte(c + 6))

    for y in range(ferrule_y1, body_y1):
        if y < shoulder_y1:
            ts = (y - ferrule_y1) / max(1.0, float(shoulder_y1 - ferrule_y1))
            cur_r = int(round(98 + (radius - 98) * (0.5 - 0.5 * math.cos(ts * math.pi))))
        else:
            yb = (y - shoulder_y1) / max(1.0, float(body_y1 - shoulder_y1))
            cur_r = radius if yb < 0.94 else int(round(radius * (1.0 - 0.06 * (((yb - 0.94) / 0.06) ** 2))))

        brushed = 0.96 + 0.04 * math.sin(y * 1.35)
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            cos_t = math.cos(th)
            light = max(0.0, math.cos(th + 0.42))
            metal_spec = math.exp(-((th + 0.34) / 0.14) ** 2) * 74.0 + math.exp(-((th - 0.86) / 0.18) ** 2) * 30.0
            c_metal = clamp_byte(206.0 * brushed * (0.62 + 0.36 * light) + metal_spec)

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if y >= shoulder_y1 and 0.0 <= y_lbl <= 1.0 and abs(th) <= half_span:
                u = (0.5 + th / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.76 + 0.24 * light + 0.04 * cos_t
                r = clamp_byte(tr * paper_shade + metal_spec * 0.22)
                g = clamp_byte(tg * paper_shade + metal_spec * 0.22)
                b = clamp_byte(tb * paper_shade + metal_spec * 0.22)
            else:
                r, g, b = c_metal, clamp_byte(c_metal + 2), clamp_byte(c_metal + 6)
            px[xc + dx, y] = (r, g, b)

    if case["occlusion_mode"] == "curved_aluminum_specular_glare":
        canvas = overlay_curved_aluminum_specular_glare(
            canvas,
            x_left=xc - radius + 16,
            x_right=xc + radius - 16,
            center_y=391,
            half_h=34,
        )

    return add_sensor_grain(canvas, seed=seed + 19)


def render_easyhaler_dpi(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)

    xc = 384
    half_w = 164
    top_y = 74
    mid_y = 516
    bot_y = 656

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - half_w - 20, bot_y - 22, xc + half_w + 34, bot_y + 34),
        fill=(24, 18, 12, 118),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    cap_rgb = case["cap_rgb"]
    accent = case["accent"]

    for y in range(top_y, mid_y):
        ty = (y - top_y) / max(1.0, float(mid_y - top_y))
        cur_w = half_w if ty > 0.08 else int(round(half_w * (0.86 + 0.14 * (ty / 0.08))))
        for dx in range(-cur_w, cur_w + 1):
            nx = dx / max(1.0, float(cur_w))
            cyl = math.sqrt(max(0.0, 1.0 - min(1.0, nx * nx)))
            light = 0.72 + 0.25 * max(0.0, math.cos(nx * 1.2 + 0.35)) + 0.04 * cyl
            spec = math.exp(-((nx + 0.58) / 0.12) ** 2) * 18.0
            r = clamp_byte(245.0 * light + spec)
            g = clamp_byte(243.0 * light + spec)
            b = clamp_byte(238.0 * light + spec)
            px[xc + dx, y] = (r, g, b)

    for y in range(mid_y, bot_y):
        ty = (y - mid_y) / max(1.0, float(bot_y - mid_y))
        cur_w = int(round((half_w + 6) * (1.0 - 0.06 * ty)))
        rib = 0.94 + 0.06 * math.cos((y - mid_y) * 0.55)
        for dx in range(-cur_w, cur_w + 1):
            nx = dx / max(1.0, float(cur_w))
            light = 0.66 + 0.32 * max(0.0, math.cos(nx * 1.2 + 0.35))
            spec = math.exp(-((nx + 0.55) / 0.14) ** 2) * 26.0
            r = clamp_byte(cap_rgb[0] * light * rib + spec)
            g = clamp_byte(cap_rgb[1] * light * rib + spec)
            b = clamp_byte(cap_rgb[2] * light * rib + spec)
            px[xc + dx, y] = (r, g, b)

    draw = ImageDraw.Draw(canvas)
    lbl_x0 = xc - 138
    lbl_x1 = xc + 138
    lbl_y0 = 108
    lbl_y1 = 442
    lbl_w = lbl_x1 - lbl_x0 - 28

    draw.rounded_rectangle(
        (lbl_x0, lbl_y0, lbl_x1, lbl_y1),
        radius=14,
        fill=(253, 252, 249),
        outline=(196, 192, 184),
        width=3,
    )
    draw.rounded_rectangle(
        (lbl_x0 + 3, lbl_y0 + 3, lbl_x1 - 3, lbl_y0 + 46),
        radius=11,
        fill=accent,
    )

    f_hdr = fit_font(draw, case["header"], lbl_w, 20, 14)
    f_title = fit_font(draw, case["title"], lbl_w, 28, 18)
    f_sub = fit_font(draw, case["subtitle"], lbl_w, 20, 14)
    f_form = fit_font(draw, case["form_line"], lbl_w, 20, 15)
    f_cnt = fit_font(draw, case["counter_line"], lbl_w, 22, 16)
    f_exp = fit_font(draw, case["expiry_line"], lbl_w, 22, 16)

    mx = lbl_x0 + 14
    draw.text((mx, lbl_y0 + 12), case["header"], fill=(252, 252, 254), font=f_hdr)
    draw.text(
        (mx, lbl_y0 + 58),
        case["title"],
        fill=(14, 18, 26),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 18, 26),
    )
    draw.text((mx, lbl_y0 + 96), case["subtitle"], fill=(42, 50, 60), font=f_sub)

    by0 = lbl_y0 + 132
    bh = 62
    strength_badge = case.get("strength_badge")
    if isinstance(strength_badge, str) and strength_badge:
        f_str = fit_font(draw, strength_badge, lbl_w - 28, 30, 18)
        bw = min(lbl_w, int(draw.textlength(strength_badge, font=f_str)) + 28)
        draw.rounded_rectangle(
            (mx, by0, mx + bw, by0 + bh),
            radius=10,
            fill=case["badge_bg"],
            outline=accent,
            width=3,
        )
        draw.text(
            (mx + 14, by0 + 14),
            strength_badge,
            fill=(12, 16, 22),
            font=f_str,
            stroke_width=1,
            stroke_fill=(12, 16, 22),
        )

    draw.line((mx, by0 + bh + 16, lbl_x1 - 14, by0 + bh + 16), fill=(212, 208, 200), width=2)
    draw.text((mx, by0 + bh + 28), case["form_line"], fill=(28, 36, 44), font=f_form)
    draw.text((mx, by0 + bh + 58), case["counter_line"], fill=(48, 56, 66), font=f_cnt)
    draw.text(
        (mx, lbl_y1 - 38),
        case["expiry_line"],
        fill=(16, 22, 30),
        font=f_exp,
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )

    win_x0 = xc + 38
    win_x1 = xc + 124
    win_y0 = 456
    win_y1 = 498
    draw.rounded_rectangle(
        (win_x0 - 4, win_y0 - 4, win_x1 + 4, win_y1 + 4),
        radius=8,
        fill=(182, 178, 170),
        outline=(128, 124, 118),
        width=2,
    )
    draw.rounded_rectangle((win_x0, win_y0, win_x1, win_y1), radius=6, fill=(32, 36, 42))
    f_win = ImageFont.load_default(size=24)
    digits = str(case.get("counter_window_digits") or "200")
    dw = int(draw.textlength(digits, font=f_win))
    draw.text(
        (win_x0 + (win_x1 - win_x0 - dw) // 2, win_y0 + 8),
        digits,
        fill=(246, 248, 242),
        font=f_win,
    )

    return add_sensor_grain(canvas, seed=seed + 21)


def render_turbuhaler_dpi(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_cylindrical_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 384
    radius = 166
    mp_top_y = 66
    mp_bot_y = 186
    body_bot_y = 552
    grip_bot_y = 658
    label_y0 = 198
    label_y1 = 498
    sag_px = 8.0
    half_span = math.radians(72.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 26, grip_bot_y - 24, xc + radius + 30, grip_bot_y + 36),
        fill=(24, 18, 12, 120),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    for y in range(mp_top_y, mp_bot_y):
        tm = (y - mp_top_y) / max(1.0, float(mp_bot_y - mp_top_y))
        cur_r = int(round(62 + (radius - 12 - 62) * (tm ** 0.86)))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            flute = 0.96 + 0.04 * math.cos(th * 14.0)
            light = 0.72 + 0.28 * max(0.0, math.cos(th + 0.42))
            c = clamp_byte(246.0 * flute * light)
            px[xc + dx, y] = (c, c, clamp_byte(c + 2))

    for y in range(mp_bot_y, body_bot_y):
        for dx in range(-radius, radius + 1):
            th = math.asin(max(-0.999, min(0.999, dx / float(radius))))
            cos_t = math.cos(th)
            light = max(0.0, math.cos(th + 0.42))
            spec = math.exp(-((th + 0.76) / 0.15) ** 2) * 18.0
            shade = 0.74 + 0.24 * light + 0.04 * cos_t
            br = 246.0 * shade + spec
            bg = 246.0 * shade + spec
            bb = 244.0 * shade + spec

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if 0.0 <= y_lbl <= 1.0 and abs(th) <= half_span:
                u = (0.5 + th / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.76 + 0.24 * light + 0.04 * cos_t
                r = clamp_byte(tr * paper_shade)
                g = clamp_byte(tg * paper_shade)
                b = clamp_byte(tb * paper_shade)
            else:
                r, g, b = clamp_byte(br), clamp_byte(bg), clamp_byte(bb)
            px[xc + dx, y] = (r, g, b)

    grip_rgb = case["grip_rgb"]
    grip_r = radius + 6
    for y in range(body_bot_y, grip_bot_y):
        tg_y = (y - body_bot_y) / max(1.0, float(grip_bot_y - body_bot_y))
        cur_r = grip_r if tg_y < 0.88 else int(round(grip_r * (1.0 - 0.06 * (((tg_y - 0.88) / 0.12) ** 2))))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            knurl = 0.90 + 0.10 * math.cos(th * 34.0)
            light = 0.64 + 0.36 * max(0.0, math.cos(th + 0.40))
            spec = math.exp(-((th + 0.70) / 0.16) ** 2) * 28.0
            r = clamp_byte(grip_rgb[0] * knurl * light + spec)
            g = clamp_byte(grip_rgb[1] * knurl * light + spec)
            b = clamp_byte(grip_rgb[2] * knurl * light + spec)
            px[xc + dx, y] = (r, g, b)

    draw = ImageDraw.Draw(canvas)
    win_x0, win_x1 = xc + 38, xc + 116
    win_y0, win_y1 = 510, 544
    draw.rounded_rectangle(
        (win_x0 - 3, win_y0 - 3, win_x1 + 3, win_y1 + 3),
        radius=7,
        fill=(186, 184, 178),
        outline=(128, 126, 120),
        width=2,
    )
    draw.rounded_rectangle((win_x0, win_y0, win_x1, win_y1), radius=5, fill=(32, 34, 40))
    f_win = ImageFont.load_default(size=20)
    digits = str(case.get("counter_window_digits") or "120")
    dw = int(draw.textlength(digits, font=f_win))
    draw.text(
        (win_x0 + (win_x1 - win_x0 - dw) // 2, win_y0 + 6),
        digits,
        fill=(248, 248, 244),
        font=f_win,
    )

    return add_sensor_grain(canvas, seed=seed + 25)


def render_diskus_dpi(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)

    xc, yc = 384, 386
    outer_r = 266
    ring_r = 216
    lbl_r = 196

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - outer_r - 12, yc - outer_r + 24, xc + outer_r + 24, yc + outer_r + 38),
        fill=(24, 18, 12, 124),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=16.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    outer_rgb = case["shell_outer_rgb"]
    inner_rgb = case["shell_inner_rgb"]
    accent = case["accent"]

    for y in range(yc - outer_r, yc + outer_r + 1):
        for x in range(xc - outer_r, xc + outer_r + 1):
            dx = x - xc
            dy = y - yc
            dist = math.hypot(dx, dy)
            if dist > outer_r:
                continue
            rn = dist / float(outer_r)
            dome = math.sqrt(max(0.0, 1.0 - min(1.0, rn * rn * 0.75)))
            dir_l = max(0.0, (-0.42 * dx - 0.48 * dy) / max(1.0, float(outer_r)))
            shade = 0.68 + 0.26 * dome + 0.22 * dir_l
            spec = math.exp(-(((dx + 96) / 48.0) ** 2 + ((dy + 104) / 48.0) ** 2)) * 32.0

            in_thumb_notch = (dx < -150) and (abs(dy + 24) < 74) and (dist > ring_r - 6)
            if in_thumb_notch:
                r = clamp_byte(inner_rgb[0] * shade * 0.84)
                g = clamp_byte(inner_rgb[1] * shade * 0.84)
                b = clamp_byte(inner_rgb[2] * shade * 0.84)
            elif dist >= ring_r:
                r = clamp_byte(outer_rgb[0] * shade + spec)
                g = clamp_byte(outer_rgb[1] * shade + spec)
                b = clamp_byte(outer_rgb[2] * shade + spec)
            elif dist >= lbl_r:
                r = clamp_byte(inner_rgb[0] * shade + spec * 0.5)
                g = clamp_byte(inner_rgb[1] * shade + spec * 0.5)
                b = clamp_byte(inner_rgb[2] * shade + spec * 0.5)
            else:
                paper = 0.88 + 0.12 * dome + 0.06 * dir_l
                r = clamp_byte(252.0 * paper)
                g = clamp_byte(251.0 * paper)
                b = clamp_byte(248.0 * paper)
            px[x, y] = (r, g, b)

    draw = ImageDraw.Draw(canvas)
    draw.ellipse((xc - lbl_r, yc - lbl_r, xc + lbl_r, yc + lbl_r), outline=accent, width=4)

    win_x0, win_y0 = xc + 96, yc - 216
    draw.rounded_rectangle(
        (win_x0, win_y0, win_x0 + 62, win_y0 + 36),
        radius=7,
        fill=(32, 34, 40),
        outline=(238, 232, 224),
        width=2,
    )
    f_win = ImageFont.load_default(size=20)
    digits = str(case.get("counter_window_digits") or "60")
    draw.text((win_x0 + 18, win_y0 + 7), digits, fill=(248, 248, 244), font=f_win)

    max_w = 276
    f_hdr = fit_font(draw, case["header"], max_w, 22, 15)
    f_title = fit_font(draw, case["title"], max_w, 32, 20)
    f_sub = fit_font(draw, case["subtitle"], max_w, 22, 15)
    f_form = fit_font(draw, case["form_line"], max_w, 19, 14)
    f_cnt = fit_font(draw, case["counter_line"], max_w, 21, 15)
    f_exp = fit_font(draw, case["expiry_line"], max_w, 23, 16)

    def draw_centered(y_pos: int, txt: str, font_obj: Any, color: tuple[int, int, int], bold: bool = False) -> None:
        tw = int(draw.textlength(txt, font=font_obj))
        draw.text(
            (xc - tw // 2, y_pos),
            txt,
            fill=color,
            font=font_obj,
            stroke_width=1 if bold else 0,
            stroke_fill=color,
        )

    draw_centered(yc - 148, case["header"], f_hdr, accent, bold=True)
    draw_centered(yc - 114, case["title"], f_title, (14, 18, 26), bold=True)
    draw_centered(yc - 72, case["subtitle"], f_sub, (42, 50, 60))

    by0 = yc - 34
    bh = 62
    strength_badge = case.get("strength_badge")
    if isinstance(strength_badge, str) and strength_badge:
        f_str = fit_font(draw, strength_badge, max_w - 32, 34, 20)
        bw = min(max_w, int(draw.textlength(strength_badge, font=f_str)) + 36)
        draw.rounded_rectangle(
            (xc - bw // 2, by0, xc + bw // 2, by0 + bh),
            radius=12,
            fill=case["badge_bg"],
            outline=accent,
            width=3,
        )
        draw_centered(by0 + 13, strength_badge, f_str, (12, 16, 22), bold=True)

    draw_centered(by0 + bh + 16, case["form_line"], f_form, (32, 40, 50))
    draw_centered(by0 + bh + 44, case["counter_line"], f_cnt, (48, 56, 66))
    draw_centered(yc + 124, case["expiry_line"], f_exp, (16, 22, 30), bold=True)

    if case["occlusion_mode"] == "counter_visible_strength_obliterated":
        canvas = overlay_pocket_abrasion_gouge(
            canvas,
            x0=xc - 126,
            y0=by0 - 2,
            x1=xc + 126,
            y1=by0 + bh + 2,
            seed=seed + 37,
        )

    return add_sensor_grain(canvas, seed=seed + 29)


def render_nasal_spray(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_cylindrical_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 384
    radius = 166
    cap_top_y = 66
    cap_bot_y = 168
    flange_bot_y = 204
    shoulder_bot_y = 266
    body_bot_y = 650
    label_y0 = 280
    label_y1 = 612
    sag_px = 8.0
    half_span = math.radians(72.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 22, body_bot_y - 22, xc + radius + 26, body_bot_y + 34),
        fill=(24, 18, 12, 118),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    cap_rgb = case["cap_rgb"]
    for y in range(cap_top_y, cap_bot_y):
        tc = (y - cap_top_y) / max(1.0, float(cap_bot_y - cap_top_y))
        cur_r = int(round(28 + 38 * (tc ** 0.90)))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            light = 0.68 + 0.32 * max(0.0, math.cos(th + 0.40))
            nozzle_core = abs(dx) < int(cur_r * 0.42) and tc > 0.18
            spec = math.exp(-((th + 0.68) / 0.15) ** 2) * 42.0
            base_r = cap_rgb[0] * (1.12 if nozzle_core else 1.0)
            base_g = cap_rgb[1] * (1.10 if nozzle_core else 1.0)
            base_b = cap_rgb[2] * (1.08 if nozzle_core else 1.0)
            px[xc + dx, y] = (
                clamp_byte(base_r * light + spec),
                clamp_byte(base_g * light + spec),
                clamp_byte(base_b * light + spec),
            )

    for y in range(cap_bot_y, flange_bot_y):
        tf = (y - cap_bot_y) / max(1.0, float(flange_bot_y - cap_bot_y))
        cur_r = 148 if 0.20 <= tf <= 0.68 else 88
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            light = 0.74 + 0.26 * max(0.0, math.cos(th + 0.40))
            c = clamp_byte(246.0 * light)
            px[xc + dx, y] = (c, clamp_byte(c + 1), clamp_byte(c + 3))

    for y in range(flange_bot_y, body_bot_y):
        if y < shoulder_bot_y:
            ts = (y - flange_bot_y) / max(1.0, float(shoulder_bot_y - flange_bot_y))
            smooth = 0.5 - 0.5 * math.cos(ts * math.pi)
            cur_r = int(round(82 + (radius - 82) * smooth))
        else:
            yb = (y - shoulder_bot_y) / max(1.0, float(body_bot_y - shoulder_bot_y))
            cur_r = radius if yb < 0.93 else int(round(radius * (1.0 - 0.06 * (((yb - 0.93) / 0.07) ** 2))))

        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            cos_t = math.cos(th)
            light = max(0.0, math.cos(th + 0.42))
            rim_spec = math.exp(-((th + 0.92) / 0.15) ** 2) * 20.0
            shade = 0.74 + 0.24 * light + 0.04 * cos_t
            br = 245.0 * shade + rim_spec
            bg = 247.0 * shade + rim_spec
            bb = 250.0 * shade + rim_spec

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if y >= shoulder_bot_y and 0.0 <= y_lbl <= 1.0 and abs(th) <= half_span:
                u = (0.5 + th / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.76 + 0.24 * light + 0.04 * cos_t
                r = clamp_byte(tr * paper_shade)
                g = clamp_byte(tg * paper_shade)
                b = clamp_byte(tb * paper_shade)
            else:
                r, g, b = clamp_byte(br), clamp_byte(bg), clamp_byte(bb)
            px[xc + dx, y] = (r, g, b)

    if case["occlusion_mode"] == "thumb_and_crust_over_spray_strength":
        canvas = overlay_spray_crust_and_thumb(
            canvas,
            crust_x0=xc - 122,
            crust_x1=xc + 148,
            center_y=430,
            half_h=32,
            seed=seed + 41,
        )

    return add_sensor_grain(canvas, seed=seed + 31)


def render_case_frame(case: dict[str, Any]) -> Image.Image:
    pkg = case["package_type"]
    if pkg == "pmdi_inhaler":
        return render_pmdi_inhaler(case)
    if pkg == "aluminum_mdi_canister":
        return render_aluminum_mdi_canister(case)
    if pkg == "easyhaler_dpi":
        return render_easyhaler_dpi(case)
    if pkg == "turbuhaler_dpi":
        return render_turbuhaler_dpi(case)
    if pkg == "diskus_dpi":
        return render_diskus_dpi(case)
    if pkg == "nasal_spray":
        return render_nasal_spray(case)
    raise ValueError(f"Unknown package_type: {pkg}")


def encode_jpeg_b64(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii"), len(raw)


def build_http_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = True
    https_proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    http_proxy = (os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or "").strip()
    proxies: dict[str, str] = {}
    if https_proxy:
        proxies["https"] = https_proxy
    if http_proxy:
        proxies["http"] = http_proxy
    elif https_proxy:
        proxies["http"] = https_proxy
    if proxies:
        session.proxies.update(proxies)
    return session


def call_gemini_verify(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}"
    payload = {
        "systemInstruction": {"parts": [{"text": verify_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": "image/jpeg", "data": b64_jpeg}},
                    {"text": "Read this label."},
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": label_schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }

    last_err = ""
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            resp = session.post(url, json=payload, timeout=45)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status_code == 200:
                body = resp.json()
                cands = body.get("candidates") or []
                parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
                json_text = ""
                for part in parts:
                    if "text" in part and not part.get("thought") and part["text"].strip():
                        json_text = part["text"].strip()
                        break
                if json_text:
                    parsed = json.loads(json_text)
                    usage_meta = body.get("usageMetadata") or {}
                    tok = {
                        "in": int(usage_meta.get("promptTokenCount") or 0),
                        "out": int(
                            usage_meta.get("candidatesTokenCount")
                            or usage_meta.get("responseTokenCount")
                            or 0
                        ),
                        "thinking": int(usage_meta.get("thoughtsTokenCount") or 0),
                    }
                    return parsed, round(elapsed_ms, 1), tok
                last_err = "Empty non-thought JSON response"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {scrub_node(resp.text[:240])}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(scrub_node(str(exc)))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini verify failed after retries: {last_err}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    proc_env = dict(os.environ)
    extra_bins = [
        "/home/silas/tools/node/bin",
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    cur_path = proc_env.get("PATH", "")
    merged_path = ":".join([p for p in extra_bins if os.path.isdir(p)] + ([cur_path] if cur_path else []))
    proc_env["PATH"] = merged_path

    node_bin = shutil.which("node", path=merged_path)
    if not node_bin:
        raise RuntimeError("node executable not found on PATH")
    return node_bin, proc_env


def run_ts_check_batch(
    profile_dict: dict[str, Any],
    batch_cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    node_bin, proc_env = ensure_node_runtime()
    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { allergenHits, checkLabel, ingredientsOf, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evalNow = new Date(input.eval_now_iso);
const profile = toProfile(input.profile);

const out = input.cases.map((c) => {
  const read = toLabelRead(c.raw);
  const verdict = checkLabel(read, profile, evalNow);
  const strengthSame = c.expected_strength ? sameStrength(read.strength.value, c.expected_strength) : false;
  const gotIngredients = [...ingredientsOf(read.ingredient.value, read.product.value)];
  const algHits = allergenHits(read, profile.allergies);
  return {
    id: c.id,
    strengthMinConf: STRENGTH_MIN_CONF,
    strengthSame,
    gotIngredients,
    allergenHitCount: algHits.length,
    read,
    verdict: {
      level: verdict.level,
      headline: verdict.headline,
      speech: verdict.speech,
      matchedMedId: verdict.matchedMedId ?? null,
      takenToday: verdict.takenToday ?? null,
      reasons: verdict.reasons,
    },
  };
});

process.stdout.write(JSON.stringify(out));
"""
    stdin_payload = json.dumps(
        {
            "eval_now_iso": EVAL_NOW_ISO,
            "profile": profile_dict,
            "cases": batch_cases,
        },
        ensure_ascii=False,
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=stdin_payload,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=proc_env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS checkLabel batch failed ({proc.returncode}): {proc.stderr[:500]}")
    return json.loads(proc.stdout)


def run_benchmark(render_only: bool = False) -> dict[str, Any]:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []

    for case in CASES:
        cid = case["id"]
        img = render_case_frame(case)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 frame for {cid}, got {img.size}")
        out_path = OUT_IMG_DIR / f"{cid}.jpg"
        b64_jpeg, n_bytes = encode_jpeg_b64(img, out_path)
        rendered.append(
            {
                "case": case,
                "image_path": out_path.relative_to(REPO_ROOT).as_posix(),
                "jpeg_bytes": n_bytes,
                "b64_jpeg": b64_jpeg,
            }
        )

    if render_only:
        return {
            "rendered_count": len(rendered),
            "images": [
                {"id": r["case"]["id"], "image_path": r["image_path"], "jpeg_bytes": r["jpeg_bytes"]}
                for r in rendered
            ],
        }

    load_env_with_proxy()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    session = build_http_session()

    raw_batch: list[dict[str, Any]] = []
    call_meta: dict[str, dict[str, Any]] = {}

    for idx, rec in enumerate(rendered, start=1):
        case = rec["case"]
        cid = case["id"]
        raw_json, latency_ms, tok = call_gemini_verify(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=rec["b64_jpeg"],
        )
        raw_batch.append(
            {
                "id": cid,
                "raw": raw_json,
                "expected_strength": case["expected_strength"],
            }
        )
        call_meta[cid] = {
            "image_path": rec["image_path"],
            "jpeg_bytes": rec["jpeg_bytes"],
            "latency_ms": latency_ms,
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
        }
        print(f"[{idx:02d}/{len(rendered):02d} {cid}] latency={latency_ms:.1f}ms in={tok['in']} out={tok['out']}")

    ts_map = {
        row["id"]: row
        for row in run_ts_check_batch(INHALER_NASAL_PROFILE, raw_batch)
    }

    items: list[dict[str, Any]] = []
    for case in CASES:
        cid = case["id"]
        ts_row = ts_map[cid]
        meta = call_meta[cid]
        read_obj = scrub_node(ts_row["read"])
        verdict_obj = scrub_node(ts_row["verdict"])
        min_conf = float(ts_row["strengthMinConf"])

        pred_level = str(verdict_obj["level"])
        exp_level = str(case["expected_level"])
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = round(float(read_obj["strength"]["confidence"] or 0.0), 4)
        strength_same = bool(ts_row["strengthSame"])
        strength_readable = bool(case["strength_readable"])

        if strength_readable:
            strength_correct: bool | None = bool(s_val is not None and s_conf >= min_conf and strength_same)
            confident_wrong_dose = bool(
                (s_conf >= min_conf and (s_val is None or not strength_same))
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= min_conf)
                or s_conf >= min_conf
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = bool(pred_level == "unsure" and not confident_wrong_dose)

        reasons = verdict_obj.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        has_allergen = bool(case["has_profile_allergen"])
        false_safe_allergen = bool(has_allergen and not (pred_level == "warning" and allergen_reason_hit))

        trap_caught: bool | None = None
        if case["category"] in ("wrong_strength_warning", "expired_inhaler_warning"):
            req_sub = str(case.get("expected_reason_substr") or "")
            trap_caught = bool(
                pred_level == "warning"
                and bool(strength_correct)
                and any(req_sub in str(r) for r in reasons)
                and not confident_wrong_dose
            )

        distractor_resisted: bool | None = None
        if case["has_distractor_counter"]:
            distractor_resisted = bool(
                verdict_match
                and bool(strength_correct)
                and not confident_wrong_dose
            )

        item_record = {
            "id": cid,
            "category": case["category"],
            "package_type": case["package_type"],
            "occlusion_mode": case["occlusion_mode"],
            "description": scrub_node(case["description"]),
            "image_path": meta["image_path"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": meta["jpeg_bytes"],
            "strength_readable": strength_readable,
            "is_occluded": bool(case["is_occluded"]),
            "has_distractor_counter": bool(case["has_distractor_counter"]),
            "printed_strength": case["printed_strength"],
            "actuation_counter_text": case["actuation_counter_text"],
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "distractor_resisted": distractor_resisted,
            "trap_caught": trap_caught,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "latency_ms": meta["latency_ms"],
            "tokens_in": meta["tokens_in"],
            "tokens_out": meta["tokens_out"],
            "tokens_thinking": meta["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items.append(item_record)
        print(
            f"  -> {cid} ({case['category']}): exp={exp_level} pred={pred_level} "
            f"strength={s_val!r} ({s_conf:.2f}) match={verdict_match} cwd={confident_wrong_dose}"
        )

    n_items = int(len(items))
    readable_items = [it for it in items if it["strength_readable"]]
    occluded_items = [it for it in items if not it["strength_readable"]]
    match_items = [it for it in items if it["category"] == "per_actuation_match"]
    distractor_items = [it for it in items if it["has_distractor_counter"]]
    wrong_str_items = [it for it in items if it["category"] == "wrong_strength_warning"]
    exp_items = [it for it in items if it["category"] == "expired_inhaler_warning"]

    clean_field_accuracy = round(
        sum(1 for it in readable_items if bool(it["strength_correct"])) / len(readable_items),
        4,
    )
    readable_dosage_accuracy = round(
        sum(
            1
            for it in readable_items
            if it["verdict_match"] and bool(it["strength_correct"]) and not it["confident_wrong_dose"]
        )
        / len(readable_items),
        4,
    )
    per_actuation_match_accuracy = round(
        sum(
            1
            for it in match_items
            if it["verdict_match"] and bool(it["strength_correct"]) and not it["confident_wrong_dose"]
        )
        / len(match_items),
        4,
    )
    actuation_counter_resistance_rate = round(
        sum(1 for it in distractor_items if bool(it["distractor_resisted"])) / len(distractor_items),
        4,
    )
    wrong_strength_catch_rate = round(
        sum(1 for it in wrong_str_items if bool(it["trap_caught"])) / len(wrong_str_items),
        4,
    )
    expired_inhaler_catch_rate = round(
        sum(1 for it in exp_items if bool(it["trap_caught"])) / len(exp_items),
        4,
    )
    occluded_abstention_rate = round(
        sum(1 for it in occluded_items if bool(it["abstained"]) and it["verdict_match"] and not it["confident_wrong_dose"])
        / len(occluded_items),
        4,
    )

    verdict_matches = int(sum(1 for it in items if it["verdict_match"]))
    verdict_accuracy = round(verdict_matches / n_items, 4)
    confident_wrong_dose_count = int(sum(1 for it in items if it["confident_wrong_dose"]))
    false_safe_allergen_count = int(sum(1 for it in items if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items))

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "strength_min_conf": STRENGTH_MIN_CONF,
        "n_cases": n_items,
        "n_items": n_items,
        "n_readable": int(len(readable_items)),
        "n_occluded": int(len(occluded_items)),
        "clean_field_accuracy": clean_field_accuracy,
        "readable_dosage_accuracy": readable_dosage_accuracy,
        "per_actuation_match_accuracy": per_actuation_match_accuracy,
        "n_distractor_counter_cases": int(len(distractor_items)),
        "actuation_counter_resistance_rate": actuation_counter_resistance_rate,
        "n_wrong_strength_traps": int(len(wrong_str_items)),
        "wrong_strength_catch_rate": wrong_strength_catch_rate,
        "n_expired_inhalers": int(len(exp_items)),
        "expired_inhaler_catch_rate": expired_inhaler_catch_rate,
        "occluded_abstention_rate": occluded_abstention_rate,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "false_safe_allergen_count": false_safe_allergen_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = scrub_node(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": EVAL_NOW_ISO,
            "model": MODEL_NAME,
            "strength_min_conf": STRENGTH_MIN_CONF,
            "profile": INHALER_NASAL_PROFILE,
            "summary": summary,
            "items": items,
        }
    )

    assert_clean_artifact(report)
    if confident_wrong_dose_count != 0:
        raise AssertionError(f"Expected confident_wrong_dose_count == 0, got {confident_wrong_dose_count}")
    if false_safe_allergen_count != 0:
        raise AssertionError(f"Expected false_safe_allergen_count == 0, got {false_safe_allergen_count}")

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Metered-dose inhaler, Nordic dry-powder inhaler, and nasal spray per-actuation dosage safety benchmark"
    )
    parser.add_argument("--render-only", action="store_true", help="Render 768x768 JPEGs only without Gemini calls")
    args = parser.parse_args(argv)
    res = run_benchmark(render_only=args.render_only)
    if args.render_only:
        print(json.dumps(res, indent=2))
    else:
        print(json.dumps(res["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
