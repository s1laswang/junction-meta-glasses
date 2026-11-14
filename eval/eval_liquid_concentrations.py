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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "liquid_concentrations"
OUT_JSON_PATH = REPO_ROOT / "eval" / "liquid_concentrations_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
API_KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

LIQUID_MED_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "par_susp",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "120 mg/5 ml",
            "schedule": ["as needed"],
            "notes": "Pediatric oral suspension, shake bottle before measuring",
        },
        {
            "id": "tim_drop",
            "name": "Oftan Timolol",
            "ingredient": "timolol",
            "strength": "5 mg/ml",
            "schedule": ["morning", "evening"],
            "notes": "Glaucoma eye drops, 1 drop morning and evening",
        },
        {
            "id": "gla_pen",
            "name": "Lantus SoloStar",
            "ingredient": "insulin glargine",
            "strength": "100 IU/ml",
            "schedule": ["bedtime"],
            "notes": "Basal insulin prefilled pen once daily at bedtime",
        },
        {
            "id": "amx_susp",
            "name": "Amoxin",
            "ingredient": "amoxicillin",
            "strength": "125 mg/5 ml",
            "schedule": ["morning", "evening"],
            "notes": "Pediatric antibiotic suspension",
        },
        {
            "id": "lis_pen",
            "name": "Humalog KwikPen",
            "ingredient": "insulin lispro",
            "strength": "100 IU/ml",
            "schedule": ["morning", "noon", "evening"],
            "notes": "Mealtime rapid-acting insulin prefilled pen",
        },
    ],
    "allergies": ["peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "lc_01",
        "category": "concentration_match",
        "package_type": "oral_suspension_bottle",
        "occlusion_mode": "none",
        "description": "Amber pediatric oral suspension bottle PANADOL (paracetamol) 120 mg/5 ml exact liquid concentration match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "120 mg/5 ml",
        "expected_strength": "120 mg/5 ml",
        "expected_ingredient": "paracetamol",
        "expected_level": "match",
        "header": "HALEON",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "Oral suspension",
        "detail_line": "Shake well before use",
        "expiry_line": "EXP 2027-11",
        "accent": (24, 106, 158),
        "badge_bg": (236, 245, 253),
        "seed": 4101,
    },
    {
        "id": "lc_02",
        "category": "concentration_match",
        "package_type": "eye_drop_bottle",
        "occlusion_mode": "none",
        "description": "Sterile ophthalmic dropper bottle OFTAN TIMOLOL (timolol) 5 mg/ml glaucoma eye drops exact match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "5 mg/ml",
        "expected_strength": "5 mg/ml",
        "expected_ingredient": "timolol",
        "expected_level": "match",
        "header": "SANTEN",
        "title": "OFTAN TIMOLOL",
        "subtitle": "timolol",
        "form_line": "Eye drops, solution",
        "detail_line": "Sterile ophthalmic use",
        "expiry_line": "EXP 2027-10",
        "accent": (18, 118, 132),
        "badge_bg": (235, 248, 250),
        "seed": 4102,
    },
    {
        "id": "lc_03",
        "category": "concentration_match",
        "package_type": "prefilled_pen",
        "occlusion_mode": "none",
        "description": "Prefilled disposable injection pen LANTUS SoloStar (insulin glargine) 100 IU/ml exact concentration match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "100 IU/ml",
        "expected_strength": "100 IU/ml",
        "expected_ingredient": "glargine",
        "expected_level": "match",
        "header": "SANOFI",
        "title": "LANTUS SoloStar",
        "subtitle": "insulin glargine",
        "form_line": "Pre-filled injection pen",
        "detail_line": "Subcutaneous use",
        "expiry_line": "EXP 2027-12",
        "accent": (92, 54, 138),
        "badge_bg": (244, 238, 252),
        "pen_body_rgb": (222, 224, 232),
        "pen_button_rgb": (104, 58, 152),
        "tilt_deg": -3.0,
        "seed": 4103,
    },
    {
        "id": "lc_04",
        "category": "wrong_concentration_warning",
        "package_type": "oral_suspension_bottle",
        "occlusion_mode": "none",
        "description": "Pediatric AMOXIN (amoxicillin) 250 mg/5 ml oral suspension 2x wrong-concentration warning vs 125 mg/5 ml profile",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "250 mg/5 ml",
        "expected_strength": "250 mg/5 ml",
        "expected_ingredient": "amoxicillin",
        "expected_level": "warning",
        "expected_reason_substr": "differs from your",
        "header": "RATIOPHARM",
        "title": "AMOXIN",
        "subtitle": "amoxicillin",
        "form_line": "Oral suspension",
        "detail_line": "Shake bottle before each dose",
        "expiry_line": "EXP 2027-09",
        "accent": (28, 92, 148),
        "badge_bg": (254, 243, 228),
        "seed": 4104,
    },
    {
        "id": "lc_05",
        "category": "wrong_concentration_warning",
        "package_type": "prefilled_pen",
        "occlusion_mode": "none",
        "description": "High-strength HUMALOG KwikPen (insulin lispro) 200 IU/ml prefilled pen 2x concentration trap vs 100 IU/ml profile",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "200 IU/ml",
        "expected_strength": "200 IU/ml",
        "expected_ingredient": "lispro",
        "expected_level": "warning",
        "expected_reason_substr": "differs from your",
        "header": "LILLY",
        "title": "HUMALOG KwikPen",
        "subtitle": "insulin lispro",
        "form_line": "Pre-filled injection pen",
        "detail_line": "Subcutaneous use",
        "expiry_line": "EXP 2027-11",
        "accent": (146, 32, 56),
        "badge_bg": (255, 240, 214),
        "pen_body_rgb": (214, 212, 218),
        "pen_button_rgb": (152, 34, 60),
        "tilt_deg": 2.8,
        "seed": 4105,
    },
    {
        "id": "lc_06",
        "category": "wrong_concentration_warning",
        "package_type": "oral_suspension_bottle",
        "occlusion_mode": "none",
        "description": "Amber pediatric oral suspension bottle BURANA (ibuprofen) 100 mg/5 ml NSAID avoid warning",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "printed_strength": "100 mg/5 ml",
        "expected_strength": "100 mg/5 ml",
        "expected_ingredient": "ibuprofen",
        "expected_level": "warning",
        "expected_reason_substr": "avoid list",
        "header": "ORION PHARMA",
        "title": "BURANA",
        "subtitle": "ibuprofen",
        "form_line": "Oral suspension",
        "detail_line": "Sugar-free orange suspension",
        "expiry_line": "EXP 2027-10",
        "accent": (184, 34, 44),
        "badge_bg": (253, 238, 240),
        "seed": 4106,
    },
    {
        "id": "lc_07",
        "category": "occluded_abstention",
        "package_type": "oral_suspension_bottle",
        "occlusion_mode": "thumb_over_concentration",
        "description": "Amber oral suspension bottle PANADOL (paracetamol) with thumb obscuring strength digits and /5 ml denominator",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "printed_strength": "120 mg/5 ml",
        "expected_strength": None,
        "expected_ingredient": "paracetamol",
        "expected_level": "unsure",
        "header": "HALEON",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "Oral suspension",
        "detail_line": "Shake well before use",
        "expiry_line": "EXP 2027-11",
        "accent": (24, 106, 158),
        "badge_bg": (236, 245, 253),
        "seed": 4107,
    },
    {
        "id": "lc_08",
        "category": "occluded_abstention",
        "package_type": "eye_drop_bottle",
        "occlusion_mode": "drip_and_finger_over_concentration",
        "description": "Ophthalmic dropper bottle OFTAN TIMOLOL (timolol) with dried suspension drip and finger obscuring mg/ml ratio",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "printed_strength": "5 mg/ml",
        "expected_strength": None,
        "expected_ingredient": "timolol",
        "expected_level": "unsure",
        "header": "SANTEN",
        "title": "OFTAN TIMOLOL",
        "subtitle": "timolol",
        "form_line": "Eye drops, solution",
        "detail_line": "Sterile ophthalmic use",
        "expiry_line": "EXP 2027-10",
        "accent": (18, 118, 132),
        "badge_bg": (235, 248, 250),
        "seed": 4108,
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


def load_env_files() -> None:
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"
    if home_env.is_file() and (not os.environ.get("GEMINI_API_KEY") or not os.environ.get("HTTPS_PROXY")):
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
                    k_s = k_b.decode("utf-8", errors="ignore")
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


def add_sensor_grain(img: Image.Image, seed: int, sigma: float = 2.3) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    sw, sh = w // 2, h // 2
    noise = bytearray(sw * sh)
    for idx in range(len(noise)):
        val = int(128 + rng.gauss(0.0, sigma))
        noise[idx] = 0 if val < 0 else (255 if val > 255 else val)
    grain = Image.frombytes("L", (sw, sh), bytes(noise)).resize((w, h), Image.Resampling.BILINEAR)
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    return Image.blend(img.convert("RGB"), grain_rgb, alpha=0.038)


def render_counter_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = 562
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(236 - 26 * t)
        g = clamp_byte(232 - 24 * t)
        b = clamp_byte(224 - 20 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        grain = rng.randint(-3, 3)
        r = clamp_byte(184 - 26 * t + grain)
        g = clamp_byte(156 - 22 * t + grain)
        b = clamp_byte(124 - 18 * t + grain)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(136, 108, 82), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((28, 22, 214, 198), fill=(255, 250, 238, 46))
    bd.ellipse((542, 40, 742, 226), fill=(236, 246, 255, 38))
    bd.ellipse((274, 14, 468, 158), fill=(255, 246, 232, 28))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=25.0))
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


def make_bottle_label_texture(case: dict[str, Any], tex_w: int = 960, tex_h: int = 680) -> Image.Image:
    tex = Image.new("RGB", (tex_w, tex_h), (252, 251, 248))
    draw = ImageDraw.Draw(tex)

    accent = case["accent"]
    draw.rectangle((0, 0, tex_w - 1, tex_h - 1), outline=(192, 188, 178), width=6)
    draw.rectangle((6, 6, tex_w - 7, 88), fill=accent)

    margin_x = 112
    f_hdr = ImageFont.load_default(size=34)
    title = case["title"]
    f_title = ImageFont.load_default(size=72 if len(title) <= 10 else 58)
    f_sub = ImageFont.load_default(size=46)
    f_str = ImageFont.load_default(size=68)
    f_body = ImageFont.load_default(size=40)
    f_exp = ImageFont.load_default(size=44)

    draw.text((margin_x, 24), case["header"], fill=(250, 252, 254), font=f_hdr)
    draw.text(
        (margin_x, 102),
        title,
        fill=(14, 20, 28),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )
    draw.text((margin_x, 184), case["subtitle"], fill=(38, 48, 58), font=f_sub)

    badge_y0 = 256
    badge_h = 106
    strength_txt = case["printed_strength"]
    bw = int(draw.textlength(strength_txt, font=f_str)) + 56
    draw.rounded_rectangle(
        (margin_x, badge_y0, margin_x + bw, badge_y0 + badge_h),
        radius=16,
        fill=case["badge_bg"],
        outline=accent,
        width=4,
    )

    if not case["is_occluded"]:
        draw.text(
            (margin_x + 28, badge_y0 + 16),
            strength_txt,
            fill=(10, 16, 24),
            font=f_str,
            stroke_width=1,
            stroke_fill=(10, 16, 24),
        )
    else:
        tail_w = int(draw.textlength("ml", font=f_str))
        draw.text(
            (margin_x + bw - 28 - tail_w, badge_y0 + 16),
            "ml",
            fill=(10, 16, 24),
            font=f_str,
        )

    sep_y = badge_y0 + badge_h + 26
    draw.line((margin_x, sep_y, tex_w - margin_x, sep_y), fill=(210, 206, 198), width=3)

    draw.text((margin_x, sep_y + 20), case["form_line"], fill=(22, 28, 36), font=f_body)
    draw.text((margin_x, sep_y + 72), case["detail_line"], fill=(56, 64, 74), font=f_body)
    draw.text(
        (margin_x, tex_h - 84),
        case["expiry_line"],
        fill=(18, 24, 32),
        font=f_exp,
        stroke_width=1,
        stroke_fill=(18, 24, 32),
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
            slope_cy = center_y + 0.06 * (cap_cx - x)
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


def overlay_drip_and_finger_right(
    canvas: Image.Image,
    drip_x0: int,
    drip_x1: int,
    badge_y0: int,
    badge_y1: int,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed)
    rgba = canvas.convert("RGBA")
    w, h = rgba.size

    drip_shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dsd = ImageDraw.Draw(drip_shadow)
    drip_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dd = ImageDraw.Draw(drip_layer)

    dsd.rounded_rectangle(
        (drip_x0 + 3, badge_y0 - 8, drip_x1 + 6, badge_y1 + 10),
        radius=18,
        fill=(24, 28, 34, 86),
    )
    dd.rounded_rectangle(
        (drip_x0, badge_y0 - 10, drip_x1, badge_y1 + 6),
        radius=18,
        fill=(247, 248, 245, 255),
        outline=(218, 222, 218, 255),
        width=2,
    )
    for k in range(5):
        cx = drip_x0 + 18 + k * 28 + rng.randint(-4, 4)
        top_y = badge_y0 - rng.randint(2, 9)
        bot_y = badge_y1 + rng.randint(4, 14)
        rad = rng.randint(10, 14)
        dd.line((cx, top_y, cx, bot_y), fill=(244, 246, 240, 255), width=rad * 2)
        dd.ellipse((cx - rad - 2, bot_y - rad, cx + rad + 2, bot_y + rad + 4), fill=(248, 249, 244, 255))

    drip_shadow = drip_shadow.filter(ImageFilter.GaussianBlur(radius=5.0))
    rgba = Image.alpha_composite(rgba, drip_shadow)
    rgba = Image.alpha_composite(rgba, drip_layer)

    f_shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fsd = ImageDraw.Draw(f_shadow)
    cy = (badge_y0 + badge_y1) // 2 + 2
    hh = 42
    tip_left = drip_x0 + 34
    fsd.rounded_rectangle(
        (tip_left - 8, cy - hh + 8, w + 30, cy + hh + 16),
        radius=hh,
        fill=(18, 12, 8, 114),
    )
    f_shadow = f_shadow.filter(ImageFilter.GaussianBlur(radius=9.0))
    rgba = Image.alpha_composite(rgba, f_shadow)

    finger = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fpx = finger.load()
    cap_cx = tip_left + hh
    for y in range(max(0, cy - hh - 4), min(h, cy + hh + 5)):
        for x in range(max(0, tip_left), w):
            slope_cy = cy + 0.05 * (x - cap_cx)
            dy = (y - slope_cy) / float(hh)
            if x >= cap_cx:
                inside = abs(dy) <= 1.0
                edge_d = abs(dy)
            else:
                dx = (cap_cx - x) / float(hh)
                rad = math.hypot(dx, dy)
                inside = rad <= 1.0
                edge_d = rad
            if not inside:
                continue
            cyl = math.sqrt(max(0.0, 1.0 - min(1.0, dy * dy)))
            shade = 0.73 + 0.27 * cyl - 0.09 * max(0.0, dy)
            r = clamp_byte(222.0 * shade + 8.0)
            g = clamp_byte(172.0 * shade + 4.0)
            b = clamp_byte(144.0 * shade + 2.0)
            alpha = 255 if edge_d < 0.96 else clamp_byte(255.0 * (1.0 - (edge_d - 0.96) / 0.04))
            fpx[x, y] = (r, g, b, alpha)

    return Image.alpha_composite(rgba, finger).convert("RGB")


def render_oral_suspension_bottle(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_bottle_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 384
    radius = 188
    cap_r = 136
    cap_y0 = 84
    cap_y1 = 166
    neck_y1 = 210
    body_y0 = neck_y1
    body_y1 = 652
    label_y0 = 248
    label_y1 = 604
    sag_px = 10.0
    half_span = math.radians(71.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 24, body_y1 - 24, xc + radius + 28, body_y1 + 36),
        fill=(24, 18, 12, 120),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    for dx in range(-cap_r, cap_r + 1):
        sc = max(-0.999, min(0.999, dx / float(cap_r)))
        th = math.asin(sc)
        rib = 0.94 + 0.06 * math.cos(th * 30.0)
        light = 0.68 + 0.32 * max(0.0, math.cos(th + 0.42))
        c = clamp_byte(246.0 * rib * light)
        draw.line((xc + dx, cap_y0, xc + dx, cap_y1), fill=(c, c, clamp_byte(c + 3)))
    draw.ellipse((xc - cap_r, cap_y0 - 11, xc + cap_r, cap_y0 + 11), fill=(246, 247, 250), outline=(188, 192, 200))
    draw.line((xc - cap_r, cap_y1 - 8, xc + cap_r, cap_y1 - 8), fill=(196, 200, 208), width=3)

    neck_r = int(radius * 0.64)
    for y in range(cap_y1, neck_y1):
        t_sh = (y - cap_y1) / max(1, neck_y1 - cap_y1)
        cur_r = int(round(neck_r + (radius - neck_r) * (t_sh ** 1.5)))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            cos_t = math.cos(th)
            light = max(0.0, math.cos(th + 0.42))
            spec = math.exp(-((th + 1.05) / 0.14) ** 2) * 0.62
            r = clamp_byte(62.0 + 142.0 * (cos_t ** 1.4) + 30.0 * light + 110.0 * spec)
            g = clamp_byte(22.0 + 68.0 * (cos_t ** 1.4) + 16.0 * light + 88.0 * spec)
            b = clamp_byte(5.0 + 14.0 * (cos_t ** 1.4) + 5.0 * light + 62.0 * spec)
            canvas.putpixel((xc + dx, y), (r, g, b))

    px = canvas.load()
    for y in range(body_y0, body_y1):
        y_norm = (y - body_y0) / max(1.0, float(body_y1 - body_y0))
        cur_r = radius
        if y_norm > 0.94:
            t_bot = (y_norm - 0.94) / 0.06
            cur_r = int(round(radius * (1.0 - 0.06 * (t_bot ** 2))))
        for dx in range(-cur_r, cur_r + 1):
            s_val = max(-0.999, min(0.999, dx / max(1.0, float(cur_r))))
            theta = math.asin(s_val)
            cos_t = math.cos(theta)
            light = max(0.0, math.cos(theta + 0.42))
            rim_spec = math.exp(-((theta + 1.08) / 0.14) ** 2) * 0.65 + math.exp(-((theta - 1.22) / 0.11) ** 2) * 0.28

            meniscus_dark = 0.78 if y_norm > 0.09 else 1.02
            trans = (cos_t ** 1.45) * (0.68 + 0.32 * math.sin(y_norm * math.pi))
            br = (58.0 + 148.0 * trans + 34.0 * light) * meniscus_dark + 112.0 * rim_spec
            bg = (20.0 + 72.0 * trans + 18.0 * light) * meniscus_dark + 88.0 * rim_spec
            bb = (4.0 + 14.0 * trans + 6.0 * light) * meniscus_dark + 60.0 * rim_spec

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if 0.0 <= y_lbl <= 1.0 and abs(theta) <= half_span:
                u = (0.5 + theta / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.74 + 0.26 * light + 0.05 * cos_t
                spec_lbl = math.exp(-((theta + 0.60) / 0.20) ** 2) * 14.0
                r = clamp_byte(tr * paper_shade + spec_lbl)
                g = clamp_byte(tg * paper_shade + spec_lbl)
                b = clamp_byte(tb * paper_shade + spec_lbl)
            else:
                r, g, b = clamp_byte(br), clamp_byte(bg), clamp_byte(bb)
            px[xc + dx, y] = (r, g, b)

    if case["occlusion_mode"] == "thumb_over_concentration":
        canvas = overlay_realistic_thumb_left(canvas, tip_x=462, center_y=422, half_h=50)

    return add_sensor_grain(canvas, seed=seed + 19)


def render_eye_dropper_bottle(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    canvas = render_counter_backdrop(seed, 768)
    label_tex = make_bottle_label_texture(case)
    tex_w, tex_h = label_tex.size
    tex_bytes = label_tex.tobytes()

    xc = 384
    radius = 166
    cap_top_y = 88
    cap_bot_y = 196
    ring_bot_y = 220
    shoulder_bot_y = 290
    body_bot_y = 648
    label_y0 = 302
    label_y1 = 614
    sag_px = 8.5
    half_span = math.radians(72.0)

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 22, body_bot_y - 22, xc + radius + 26, body_bot_y + 34),
        fill=(24, 18, 12, 116),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    px = canvas.load()

    accent = case["accent"]
    for y in range(cap_top_y, cap_bot_y):
        t_c = (y - cap_top_y) / max(1.0, float(cap_bot_y - cap_top_y))
        cur_r = int(round(36 + 38 * (t_c ** 0.88)))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            rib = 0.92 + 0.08 * math.cos(th * 24.0)
            light = 0.64 + 0.36 * max(0.0, math.cos(th + 0.40))
            spec = math.exp(-((th + 0.72) / 0.16) ** 2) * 38.0
            r = clamp_byte(accent[0] * rib * light + spec)
            g = clamp_byte(accent[1] * rib * light + spec)
            b = clamp_byte(accent[2] * rib * light + spec)
            px[xc + dx, y] = (r, g, b)

    for y in range(cap_bot_y, ring_bot_y):
        cur_r = 80
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / float(cur_r))))
            light = 0.66 + 0.34 * max(0.0, math.cos(th + 0.40))
            r = clamp_byte((accent[0] * 0.85 + 24) * light)
            g = clamp_byte((accent[1] * 0.85 + 24) * light)
            b = clamp_byte((accent[2] * 0.85 + 24) * light)
            px[xc + dx, y] = (r, g, b)

    for y in range(ring_bot_y, body_bot_y):
        if y < shoulder_bot_y:
            ts = (y - ring_bot_y) / max(1.0, float(shoulder_bot_y - ring_bot_y))
            smooth = 0.5 - 0.5 * math.cos(ts * math.pi)
            cur_r = int(round(78 + (radius - 78) * smooth))
        else:
            yb = (y - shoulder_bot_y) / max(1.0, float(body_bot_y - shoulder_bot_y))
            cur_r = radius if yb <= 0.93 else int(round(radius * (1.0 - 0.06 * (((yb - 0.93) / 0.07) ** 2))))

        for dx in range(-cur_r, cur_r + 1):
            s_val = max(-0.999, min(0.999, dx / max(1.0, float(cur_r))))
            theta = math.asin(s_val)
            cos_t = math.cos(theta)
            light = max(0.0, math.cos(theta + 0.42))
            rim_spec = math.exp(-((theta + 0.95) / 0.15) ** 2) * 0.55

            shade = 0.72 + 0.26 * light + 0.05 * cos_t
            br = 244.0 * shade + 24.0 * rim_spec
            bg = 247.0 * shade + 24.0 * rim_spec
            bb = 250.0 * shade + 24.0 * rim_spec

            sag = sag_px * (cos_t - 0.35)
            y_lbl = (y - sag - label_y0) / float(label_y1 - label_y0)
            if y >= shoulder_bot_y and 0.0 <= y_lbl <= 1.0 and abs(theta) <= half_span:
                u = (0.5 + theta / (2.0 * half_span)) * (tex_w - 1)
                v = y_lbl * (tex_h - 1)
                tr, tg, tb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u, v)
                paper_shade = 0.75 + 0.25 * light + 0.04 * cos_t
                r = clamp_byte(tr * paper_shade)
                g = clamp_byte(tg * paper_shade)
                b = clamp_byte(tb * paper_shade)
            else:
                r, g, b = clamp_byte(br), clamp_byte(bg), clamp_byte(bb)
            px[xc + dx, y] = (r, g, b)

    if case["occlusion_mode"] == "drip_and_finger_over_concentration":
        canvas = overlay_drip_and_finger_right(
            canvas,
            drip_x0=252,
            drip_x1=438,
            badge_y0=428,
            badge_y1=486,
            seed=seed + 31,
        )

    return add_sensor_grain(canvas, seed=seed + 23)


def render_prefilled_insulin_pen(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    pad = 84
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    pen_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    yc = size // 2 - 6
    pen_r = 126
    y0 = yc - pen_r
    y1 = yc + pen_r

    hub_x0 = pad + 26
    cart_x0 = pad + 62
    body_x0 = pad + 178
    body_x1 = pad + 610
    collar_x1 = pad + 694
    btn_x1 = pad + 742

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (cart_x0 + 8, y0 + 22, btn_x1 + 14, y1 + 28),
        radius=48,
        fill=(22, 16, 12, 112),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    pen_layer = Image.alpha_composite(pen_layer, shadow)

    label_w = body_x1 - body_x0 - 28
    label_h = int(pen_r * 1.74)
    lbl = Image.new("RGB", (label_w, label_h), (252, 252, 250))
    ld = ImageDraw.Draw(lbl)
    accent = case["accent"]
    ld.rectangle((0, 0, label_w - 1, label_h - 1), outline=(182, 186, 194), width=3)
    ld.rectangle((0, 0, label_w - 1, 36), fill=accent)

    f_hdr = ImageFont.load_default(size=20)
    f_title = ImageFont.load_default(size=34)
    f_sub = ImageFont.load_default(size=23)
    f_str = ImageFont.load_default(size=36)
    f_form = ImageFont.load_default(size=18)
    f_exp = ImageFont.load_default(size=22)

    ld.text((18, 8), case["header"], fill=(250, 252, 255), font=f_hdr)
    ld.text(
        (18, 44),
        case["title"],
        fill=(14, 18, 26),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 18, 26),
    )
    ld.text((18, 84), case["subtitle"], fill=(42, 50, 60), font=f_sub)

    st_txt = case["printed_strength"]
    sbw = int(ld.textlength(st_txt, font=f_str)) + 36
    sbh = 54
    sby = 114
    ld.rounded_rectangle(
        (18, sby, 18 + sbw, sby + sbh),
        radius=10,
        fill=case["badge_bg"],
        outline=accent,
        width=3,
    )
    ld.text(
        (36, sby + 8),
        st_txt,
        fill=(12, 16, 22),
        font=f_str,
        stroke_width=1,
        stroke_fill=(12, 16, 22),
    )

    ld.text((18 + sbw + 16, sby + 18), case["detail_line"], fill=(48, 56, 66), font=f_form)
    ld.text((18, sby + sbh + 10), case["form_line"], fill=(34, 42, 52), font=f_form)
    ld.text(
        (label_w - 156, sby + sbh + 8),
        case["expiry_line"],
        fill=(16, 22, 30),
        font=f_exp,
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    lbl_bytes = lbl.tobytes()

    ppx = pen_layer.load()
    body_rgb = case["pen_body_rgb"]
    btn_rgb = case["pen_button_rgb"]

    for x in range(hub_x0, btn_x1):
        if x < cart_x0:
            cur_r = int(pen_r * 0.42)
        elif x < body_x0:
            cur_r = int(pen_r * 0.78)
        elif x < body_x1:
            cur_r = pen_r
        elif x < collar_x1:
            cur_r = int(pen_r * 0.94)
        else:
            cur_r = int(pen_r * 0.72)

        for dy in range(-cur_r, cur_r + 1):
            sv = max(-0.999, min(0.999, dy / max(1.0, float(cur_r))))
            phi = math.asin(sv)
            cos_p = math.cos(phi)
            light = max(0.0, math.cos(phi + 0.48))
            spec = math.exp(-((phi + 0.62) / 0.14) ** 2) * 34.0
            shade = 0.66 + 0.30 * light + 0.06 * cos_p

            if x < cart_x0:
                r = clamp_byte(210 * shade + spec * 0.5)
                g = clamp_byte(214 * shade + spec * 0.5)
                b = clamp_byte(220 * shade + spec * 0.5)
            elif x < body_x0:
                in_window = (cart_x0 + 16 <= x <= body_x0 - 14) and (abs(dy) <= int(cur_r * 0.62))
                if in_window:
                    plunger = cart_x0 + 34 <= x <= cart_x0 + 58
                    if plunger:
                        r = clamp_byte(176 * shade)
                        g = clamp_byte(88 * shade)
                        b = clamp_byte(68 * shade)
                    else:
                        glass_glint = math.exp(-((phi + 0.45) / 0.16) ** 2) * 44.0
                        r = clamp_byte(226 * shade + glass_glint)
                        g = clamp_byte(238 * shade + glass_glint)
                        b = clamp_byte(244 * shade + glass_glint)
                else:
                    r = clamp_byte(accent[0] * shade + spec * 0.4)
                    g = clamp_byte(accent[1] * shade + spec * 0.4)
                    b = clamp_byte(accent[2] * shade + spec * 0.4)
            elif x < body_x1:
                lx = x - (body_x0 + 14)
                ly_norm = 0.5 + phi / (2.0 * math.radians(66.0))
                if 0 <= lx < label_w and 0.0 <= ly_norm <= 1.0:
                    tr, tg, tb = sample_tex_bilinear(
                        lbl_bytes,
                        label_w,
                        label_h,
                        float(lx),
                        ly_norm * (label_h - 1),
                    )
                    lbl_shade = 0.78 + 0.22 * light + 0.04 * cos_p
                    r = clamp_byte(tr * lbl_shade + spec * 0.25)
                    g = clamp_byte(tg * lbl_shade + spec * 0.25)
                    b = clamp_byte(tb * lbl_shade + spec * 0.25)
                else:
                    r = clamp_byte(body_rgb[0] * shade + spec)
                    g = clamp_byte(body_rgb[1] * shade + spec)
                    b = clamp_byte(body_rgb[2] * shade + spec)
            elif x < collar_x1:
                rib = 0.93 + 0.07 * math.cos((x - body_x1) * 0.65)
                in_bezel = (body_x1 + 16 <= x <= collar_x1 - 20) and (abs(dy) <= 30)
                if in_bezel:
                    r, g, b = clamp_byte(44 * shade), clamp_byte(48 * shade), clamp_byte(54 * shade)
                else:
                    r = clamp_byte(body_rgb[0] * shade * rib + spec * 0.5)
                    g = clamp_byte(body_rgb[1] * shade * rib + spec * 0.5)
                    b = clamp_byte(body_rgb[2] * shade * rib + spec * 0.5)
            else:
                rib = 0.94 + 0.06 * math.cos(phi * 22.0)
                r = clamp_byte(btn_rgb[0] * shade * rib + spec * 0.4)
                g = clamp_byte(btn_rgb[1] * shade * rib + spec * 0.4)
                b = clamp_byte(btn_rgb[2] * shade * rib + spec * 0.4)

            ppx[x, yc + dy] = (r, g, b, 255)

    rotated = pen_layer.rotate(float(case["tilt_deg"]), resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))
    return add_sensor_grain(cropped, seed=seed + 29)


def render_case_frame(case: dict[str, Any]) -> Image.Image:
    pkg = case["package_type"]
    if pkg == "oral_suspension_bottle":
        return render_oral_suspension_bottle(case)
    if pkg == "eye_drop_bottle":
        return render_eye_dropper_bottle(case)
    if pkg == "prefilled_pen":
        return render_prefilled_insulin_pen(case)
    raise ValueError(f"Unknown package_type: {pkg}")


def encode_jpeg_b64(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii"), len(raw)


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
            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini verify failed after retries: {last_err}")


def ensure_node_and_deps() -> str:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    extra_paths = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
        os.environ.get("PATH", ""),
    ]
    merged_path = ":".join(p for p in extra_paths if p)
    os.environ["PATH"] = merged_path
    node_bin = shutil.which("node", path=merged_path)
    if not node_bin:
        raise RuntimeError("node executable not found on PATH")
    return node_bin


def run_ts_check_batch(
    node_bin: str,
    profile_dict: dict[str, Any],
    batch_cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
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
        env=os.environ.copy(),
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

    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    node_bin = ensure_node_and_deps()
    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

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
        for row in run_ts_check_batch(node_bin, LIQUID_MED_PROFILE, raw_batch)
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
            abstained: bool | None = False
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
        if case["category"] == "wrong_concentration_warning":
            req_sub = str(case.get("expected_reason_substr") or "")
            trap_caught = bool(
                pred_level == "warning"
                and bool(strength_correct)
                and any(req_sub in str(r) for r in reasons)
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
            "printed_strength": case["printed_strength"],
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
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

    n_items = len(items)
    match_items = [it for it in items if it["category"] == "concentration_match"]
    warn_items = [it for it in items if it["category"] == "wrong_concentration_warning"]
    occ_items = [it for it in items if it["category"] == "occluded_abstention"]

    concentration_match_accuracy = round(
        sum(
            1
            for it in match_items
            if it["verdict_match"] and bool(it["strength_correct"]) and not it["confident_wrong_dose"]
        )
        / len(match_items),
        4,
    )
    wrong_concentration_catch_rate = round(
        sum(1 for it in warn_items if bool(it["trap_caught"])) / len(warn_items),
        4,
    )
    occluded_denominator_abstention_rate = round(
        sum(1 for it in occ_items if bool(it["abstained"]) and it["verdict_match"]) / len(occ_items),
        4,
    )

    verdict_matches = sum(1 for it in items if it["verdict_match"])
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
        "n_items": n_items,
        "n_concentration_matches": len(match_items),
        "concentration_match_accuracy": concentration_match_accuracy,
        "n_warning_traps": len(warn_items),
        "wrong_concentration_catch_rate": wrong_concentration_catch_rate,
        "n_occluded_items": len(occ_items),
        "occluded_denominator_abstention_rate": occluded_denominator_abstention_rate,
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
            "profile": LIQUID_MED_PROFILE,
            "summary": summary,
            "items": items,
        }
    )

    assert_clean_artifact(report)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Oral liquid suspension, ophthalmic eye-drop, and prefilled pen concentration safety benchmark"
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
