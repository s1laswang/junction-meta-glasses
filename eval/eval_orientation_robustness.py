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
import tempfile
import time
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "orientation_robustness"
OUT_JSON_PATH = REPO_ROOT / "eval" / "orientation_robustness_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T12:00:00Z"
STRENGTH_MIN_CONF = 0.80

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)

EAN_L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
]
EAN_G = [
    "0100111",
    "0110011",
    "0011011",
    "0100001",
    "0011101",
    "0111001",
    "0000101",
    "0010001",
    "0001001",
    "0010111",
]
EAN_R = [
    "1110010",
    "1100110",
    "1101100",
    "1000010",
    "1011100",
    "1001110",
    "1010000",
    "1000100",
    "1001000",
    "1110100",
]
EAN_PARITY = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
]

CASE_SPECS: list[dict[str, Any]] = [
    {
        "id": "or_01",
        "orientation_group": "upside_down_180",
        "rotation_deg": 180,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Amlodipin 5 mg rotated 180 deg (upside-down) -> match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "accent": (20, 108, 142),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "Amlodipin",
        "sub_line": "Active substance: amlodipine (amlodipiini)",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "1 tablet every evening    30 tablets",
        "expiry_line": "EXP 2027-10",
        "expiry_alert": False,
        "occlude_upside_down_thumb": False,
        "seed": 301,
    },
    {
        "id": "or_02",
        "orientation_group": "sideways_90_cw",
        "rotation_deg": 90,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Amlodipin 5 mg rotated 90 deg clockwise -> match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "accent": (20, 108, 142),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "Amlodipin",
        "sub_line": "Active substance: amlodipine (amlodipiini)",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "1 tablet every evening    30 tablets",
        "expiry_line": "EXP 2027-10",
        "expiry_alert": False,
        "occlude_upside_down_thumb": False,
        "seed": 302,
    },
    {
        "id": "or_03",
        "orientation_group": "sideways_270_cw",
        "rotation_deg": 270,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Amlodipin 5 mg rotated 270 deg clockwise -> match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "accent": (20, 108, 142),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "Amlodipin",
        "sub_line": "Active substance: amlodipine (amlodipiini)",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "1 tablet every evening    30 tablets",
        "expiry_line": "EXP 2027-10",
        "expiry_alert": False,
        "occlude_upside_down_thumb": False,
        "seed": 303,
    },
    {
        "id": "or_04",
        "orientation_group": "upside_down_180",
        "rotation_deg": 180,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Burana 400 mg (ibuprofeeni) rotated 180 deg -> warning (NSAID avoid)",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "warning",
        "expected_strength": "400 mg",
        "accent": (188, 34, 44),
        "header": "ORION PHARMA    Vnr 01 66 40",
        "title": "Burana",
        "sub_line": "Vaikuttava aine: ibuprofeeni (ibuprofen)",
        "strength_badge": "400 mg",
        "form_line": "tabletti",
        "pack_line": "Pain and fever relief    30 tablettia",
        "expiry_line": "EXP 2027-11",
        "expiry_alert": False,
        "occlude_upside_down_thumb": False,
        "seed": 304,
    },
    {
        "id": "or_05",
        "orientation_group": "sideways_90_cw",
        "rotation_deg": 90,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Metformin 500 mg EXP 2025-03 rotated 90 deg -> warning (expired)",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "warning",
        "expected_strength": "500 mg",
        "accent": (34, 86, 162),
        "header": "SANDOZ    Vnr 41 19 05",
        "title": "Metformin",
        "sub_line": "Active substance: metformin hydrochloride",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "Oral use    100 tablets",
        "expiry_line": "EXP 2025-03",
        "expiry_alert": True,
        "occlude_upside_down_thumb": False,
        "seed": 305,
    },
    {
        "id": "or_06",
        "orientation_group": "upside_down_180",
        "rotation_deg": 180,
        "perspective_tilt": False,
        "kind": "food",
        "render_style": "food_carton",
        "description": "Hazelnut Crunch Bar (contains hazelnuts, peanuts) rotated 180 deg -> warning (allergen)",
        "strength_readable": False,
        "is_occluded": False,
        "has_profile_allergen": True,
        "expected_level": "warning",
        "expected_strength": None,
        "accent": (122, 62, 30),
        "pack_fill": (248, 240, 226),
        "header": "NORDIC SNACK KITCHEN",
        "title": "Hazelnut Crunch Bar",
        "sub_title": "Roasted Nut & Oat Snack Bar    55 g",
        "ingredients_lines": [
            "Ingredients: rolled oats, roasted",
            "hazelnuts (18%), peanuts (12%),",
            "honey, cocoa butter.",
        ],
        "allergen_lines": [
            "Allergens: contains hazelnuts,",
            "peanuts, oats.",
        ],
        "expiry_line": "Best before: 2027-09",
        "weight_line": "55 g",
        "seed": 306,
    },
    {
        "id": "or_07",
        "orientation_group": "sideways_270_cw",
        "rotation_deg": 270,
        "perspective_tilt": False,
        "kind": "food",
        "render_style": "food_carton",
        "description": "Nordic Oat Drink (water, oats, rapeseed oil, salt) rotated 270 deg -> info",
        "strength_readable": False,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "info",
        "expected_strength": None,
        "accent": (36, 106, 124),
        "pack_fill": (243, 248, 249),
        "header": "NORDIC PLANT DAIRY",
        "title": "Nordic Oat Drink",
        "sub_title": "Plant-Based Oat Drink    1 L",
        "ingredients_lines": [
            "Ingredients: water, oats (10%),",
            "rapeseed oil, salt.",
        ],
        "allergen_lines": [
            "Allergens: contains oats.",
        ],
        "expiry_line": "Best before: 2027-11",
        "weight_line": "1 L",
        "seed": 307,
    },
    {
        "id": "or_08",
        "orientation_group": "tilted_32_perspective",
        "rotation_deg": 32,
        "perspective_tilt": True,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Amlodipin 10 mg wrong strength tilted 32 deg off-axis -> warning (10 mg vs 5 mg)",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_level": "warning",
        "expected_strength": "10 mg",
        "accent": (42, 74, 152),
        "header": "NORDIC GENERICS    Vnr 52 10 88",
        "title": "Amlodipin",
        "sub_line": "Active substance: amlodipine",
        "strength_badge": "10 mg",
        "form_line": "tablets",
        "pack_line": "Oral use    30 tablets",
        "expiry_line": "EXP 2027-10",
        "expiry_alert": False,
        "occlude_upside_down_thumb": False,
        "seed": 308,
    },
    {
        "id": "or_09",
        "orientation_group": "upside_down_180",
        "rotation_deg": 180,
        "perspective_tilt": False,
        "kind": "medication",
        "render_style": "med_box",
        "description": "Amlodipin upside-down (180 deg) with thumb occluding strength digits -> unsure",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "accent": (20, 108, 142),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "Amlodipin",
        "sub_line": "Active substance: amlodipine (amlodipiini)",
        "strength_badge": None,
        "form_line": "tabletti",
        "pack_line": "Oral use    30 tablettia",
        "expiry_line": "EXP 2027-10",
        "expiry_alert": False,
        "occlude_upside_down_thumb": True,
        "seed": 309,
    },
    {
        "id": "or_10",
        "orientation_group": "upside_down_180",
        "rotation_deg": 180,
        "perspective_tilt": False,
        "kind": "unreadable",
        "render_style": "rear_barcode",
        "description": "Upside-down (180 deg) blank rear carton with barcode 6432100099111 only -> unsure",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "barcode_digits": "6432100099111",
        "seed": 310,
    },
]


def scrub_node(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED]", cleaned)
    if isinstance(val, list):
        return [scrub_node(item) for item in val]
    if isinstance(val, dict):
        return {str(k): scrub_node(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in output JSON")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


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
            if not line or line.startswith(COMMENT_CHAR):
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
            ref_key = ref.rsplit("/", 1)[-1]
            return inline_schema_refs(defs[ref_key], defs)
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            out[k] = inline_schema_refs(v, defs)
        return out
    return node


def clamp_byte(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(round(v))


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 16) -> Any:
    size = start_size
    while size > min_size:
        font = ImageFont.load_default(size=size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 1
    return ImageFont.load_default(size=min_size)


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    gw = max(1, w // 2)
    gh = max(1, h // 2)
    noise = Image.new("L", (gw, gh))
    px = [128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range(gw * gh)]
    noise.putdata(px)
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    alpha = 0.05
    return Image.merge(
        "RGB",
        (
            Image.blend(r, noise, alpha),
            Image.blend(g, noise, alpha),
            Image.blend(b, noise, alpha),
        ),
    )


def render_counter_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = 548
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(235 - 26 * t)
        g = clamp_byte(230 - 25 * t)
        b = clamp_byte(221 - 22 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        streak = rng.randint(-3, 3)
        r = clamp_byte(182 - 28 * t + streak)
        g = clamp_byte(152 - 24 * t + streak)
        b = clamp_byte(118 - 18 * t + streak)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(134, 104, 76), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((28, 24, 214, 198), fill=(255, 250, 236, 42))
    bd.ellipse((542, 42, 740, 228), fill=(238, 246, 255, 34))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=24.0))
    return Image.alpha_composite(img.convert("RGBA"), bokeh).convert("RGB")


def compute_perspective_coeffs(
    src_pts: list[tuple[float, float]],
    dst_pts: list[tuple[float, float]],
) -> list[float]:
    mat = []
    rhs = []
    for (u, v), (x, y) in zip(src_pts, dst_pts):
        mat.append([x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u])
        mat.append([0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v])
        rhs.append(u)
        rhs.append(v)
    a_mat = np.array(mat, dtype=np.float64)
    b_vec = np.array(rhs, dtype=np.float64)
    sol = np.linalg.solve(a_mat, b_vec)
    return [float(c) for c in sol]


def apply_package_orientation(
    card_rgb: Image.Image,
    corner_radius: int,
    border_rgba: tuple[int, int, int, int],
    rotation_cw_deg: int,
    perspective_tilt: bool,
) -> Image.Image:
    w, h = card_rgb.size
    rgba = card_rgb.convert("RGBA")
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=corner_radius, fill=255)
    rgba.putalpha(mask)
    ImageDraw.Draw(rgba).rounded_rectangle(
        (0, 0, w - 1, h - 1),
        radius=corner_radius,
        outline=border_rgba,
        width=3,
    )

    if perspective_tilt:
        src_pts = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
        dst_pts = [
            (18.0, 10.0),
            (float(w - 20), 34.0),
            (float(w - 34), float(h - 32)),
            (10.0, float(h - 12)),
        ]
        coeffs = compute_perspective_coeffs(src_pts, dst_pts)
        rgba = rgba.transform(
            (w, h),
            Image.Transform.PERSPECTIVE,
            coeffs,
            resample=Image.Resampling.BICUBIC,
        )

    if rotation_cw_deg == 180 and not perspective_tilt:
        return rgba.transpose(Image.Transpose.ROTATE_180)
    if rotation_cw_deg == 90 and not perspective_tilt:
        return rgba.transpose(Image.Transpose.ROTATE_270)
    if rotation_cw_deg == 270 and not perspective_tilt:
        return rgba.transpose(Image.Transpose.ROTATE_90)
    return rgba.rotate(-float(rotation_cw_deg), resample=Image.Resampling.BICUBIC, expand=True)


def mount_oriented_package(
    oriented_rgba: Image.Image,
    seed: int,
    occlude_upside_down_thumb: bool = False,
) -> Image.Image:
    bg = render_counter_backdrop(seed, 768).convert("RGBA")
    rw, rh = oriented_rgba.size
    ox = (768 - rw) // 2
    oy = (768 - rh) // 2

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    alpha_ch = oriented_rgba.getchannel("A")
    shadow_patch = Image.new("RGBA", (rw, rh), (22, 18, 14, 112))
    shadow_patch.putalpha(alpha_ch)
    shadow.paste(shadow_patch, (ox + 12, oy + 16), shadow_patch)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))

    comp = Image.alpha_composite(bg, shadow)
    comp.paste(oriented_rgba, (ox, oy), oriented_rgba)

    sheen = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse((40, 20, 420, 320), fill=(255, 253, 246, 18))
    sheen = sheen.filter(ImageFilter.GaussianBlur(radius=28.0))
    comp = Image.alpha_composite(comp, sheen)

    if occlude_upside_down_thumb:
        cast_shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        csd = ImageDraw.Draw(cast_shadow)
        csd.rounded_rectangle((388, 304, 816, 416), radius=54, fill=(24, 18, 14, 168))
        csd.ellipse((376, 308, 504, 418), fill=(24, 18, 14, 148))
        cast_shadow = cast_shadow.filter(ImageFilter.GaussianBlur(radius=11.0))
        comp = Image.alpha_composite(comp, cast_shadow)

        thumb = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle(
            (392, 310, 824, 408),
            radius=50,
            fill=(208, 162, 136, 255),
            outline=(168, 122, 98, 255),
            width=3,
        )
        td.rounded_rectangle((406, 316, 810, 360), radius=26, fill=(218, 174, 148, 255))
        td.rounded_rectangle(
            (408, 326, 476, 392),
            radius=20,
            fill=(236, 206, 192, 255),
            outline=(188, 146, 126, 255),
            width=2,
        )
        td.arc((544, 324, 570, 394), start=290, end=70, fill=(166, 118, 94, 210), width=3)
        td.arc((560, 328, 584, 390), start=295, end=65, fill=(174, 126, 102, 185), width=2)
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=0.7))
        comp = Image.alpha_composite(comp, thumb)

    return comp.convert("RGB")


def build_med_box_card(spec: dict[str, Any]) -> Image.Image:
    bw, bh = 540, 390
    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=int(spec["seed"]), amplitude=4)
    cd = ImageDraw.Draw(card)

    accent = spec["accent"]
    cd.rectangle((0, 0, bw, 58), fill=accent)
    f_hdr = fit_font(cd, spec["header"], bw - 56, 21)
    cd.text((28, 17), spec["header"], fill=(246, 249, 252), font=f_hdr)

    title_col = (14, 20, 28)
    f_title = fit_font(cd, spec["title"], bw - 56, 46)
    cd.text(
        (28, 76),
        spec["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )

    f_sub = fit_font(cd, spec["sub_line"], bw - 56, 23)
    cd.text((28, 136), spec["sub_line"], fill=(48, 56, 68), font=f_sub)

    sx0, sy0, sx1, sy1 = 28, 182, 246, 258
    cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=accent, width=3)
    if spec["strength_badge"] is not None:
        f_str = fit_font(cd, spec["strength_badge"], (sx1 - sx0) - 32, 44)
        cd.text(
            (sx0 + 18, sy0 + 14),
            spec["strength_badge"],
            fill=(12, 18, 26),
            font=f_str,
            stroke_width=1,
            stroke_fill=(12, 18, 26),
        )

    f_form = fit_font(cd, spec["form_line"], bw - sx1 - 44, 25)
    cd.text((sx1 + 20, sy0 + 24), spec["form_line"], fill=(34, 42, 52), font=f_form)

    if spec["pack_line"]:
        f_pack = fit_font(cd, spec["pack_line"], bw - 56, 22)
        cd.text((28, 282), spec["pack_line"], fill=(50, 58, 68), font=f_pack)

    if spec["expiry_line"]:
        f_exp = fit_font(cd, spec["expiry_line"], 260, 25)
        exp_w = int(cd.textlength(spec["expiry_line"], font=f_exp)) + 36
        ex0 = max(28, bw - exp_w - 28)
        exp_fill = (254, 240, 240) if spec["expiry_alert"] else (242, 245, 248)
        exp_outline = (182, 42, 42) if spec["expiry_alert"] else (160, 168, 178)
        exp_text_col = (156, 20, 20) if spec["expiry_alert"] else (18, 24, 30)
        cd.rounded_rectangle((ex0, 322, bw - 28, 372), radius=8, fill=exp_fill, outline=exp_outline, width=2)
        cd.text(
            (ex0 + 18, 334),
            spec["expiry_line"],
            fill=exp_text_col,
            font=f_exp,
            stroke_width=1 if spec["expiry_alert"] else 0,
            stroke_fill=exp_text_col,
        )

    return card


def build_food_carton_card(spec: dict[str, Any]) -> Image.Image:
    cw, ch = 470, 540
    carton = Image.new("RGB", (cw, ch), spec["pack_fill"])
    carton = add_paper_grain(carton, seed=int(spec["seed"]), amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 64), fill=spec["accent"])
    f_hdr = fit_font(cd, spec["header"], cw - 52, 21)
    cd.text((26, 20), spec["header"], fill=(248, 250, 248), font=f_hdr)

    title_col = (20, 30, 26)
    f_title = fit_font(cd, spec["title"], cw - 52, 38)
    cd.text(
        (26, 82),
        spec["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )

    f_sub = fit_font(cd, spec["sub_title"], cw - 52, 22)
    cd.text((26, 134), spec["sub_title"], fill=(56, 66, 62), font=f_sub)

    n_ing = len(spec["ingredients_lines"])
    n_alg = len(spec["allergen_lines"])
    alg_box_h = 20 + n_alg * 30
    panel_bottom = 180 + 24 + n_ing * 32 + 16 + alg_box_h + 18

    cd.rounded_rectangle(
        (24, 180, cw - 24, panel_bottom),
        radius=12,
        fill=(253, 252, 249),
        outline=(182, 176, 164),
        width=2,
    )
    iy = 198
    for ln in spec["ingredients_lines"]:
        f_ing = fit_font(cd, ln, cw - 80, 22)
        cd.text((38, iy), ln, fill=(22, 26, 26), font=f_ing)
        iy += 32

    iy += 12
    alg_fill = (255, 242, 230) if spec["has_profile_allergen"] else (238, 247, 244)
    alg_outline = (196, 112, 54) if spec["has_profile_allergen"] else (92, 148, 132)
    alg_ink = (112, 34, 16) if spec["has_profile_allergen"] else (22, 62, 52)
    cd.rounded_rectangle(
        (36, iy, cw - 36, iy + alg_box_h),
        radius=8,
        fill=alg_fill,
        outline=alg_outline,
        width=2,
    )
    ay = iy + 10
    for ln in spec["allergen_lines"]:
        f_alg = fit_font(cd, ln, cw - 96, 22)
        cd.text((48, ay), ln, fill=alg_ink, font=f_alg, stroke_width=1, stroke_fill=alg_ink)
        ay += 30

    exp_y = panel_bottom + 18
    cd.rounded_rectangle(
        (24, exp_y, cw - 24, exp_y + 54),
        radius=8,
        fill=(255, 255, 255),
        outline=(190, 186, 176),
        width=2,
    )
    f_exp = fit_font(cd, spec["expiry_line"], cw - 80, 24)
    cd.text((38, exp_y + 14), spec["expiry_line"], fill=(18, 24, 26), font=f_exp)

    cd.text((28, ch - 46), spec["weight_line"], fill=(54, 66, 60), font=ImageFont.load_default(size=24))
    return carton


def encode_ean13_bits(digits: str) -> str:
    if len(digits) != 13 or not digits.isdigit():
        raise ValueError(f"Expected 13-digit EAN barcode, got {digits}")
    first = int(digits[0])
    parity = EAN_PARITY[first]
    bits = ["101"]
    for idx in range(6):
        d = int(digits[idx + 1])
        bits.append(EAN_L[d] if parity[idx] == "L" else EAN_G[d])
    bits.append("01010")
    for idx in range(6):
        d = int(digits[idx + 7])
        bits.append(EAN_R[d])
    bits.append("101")
    return "".join(bits)


def build_rear_barcode_card(spec: dict[str, Any]) -> Image.Image:
    bw, bh = 540, 390
    card = Image.new("RGB", (bw, bh), (244, 243, 238))
    card = add_paper_grain(card, seed=int(spec["seed"]), amplitude=5)
    cd = ImageDraw.Draw(card)

    cd.line((0, 48, bw, 48), fill=(216, 214, 206), width=2)
    cd.line((0, bh - 48, bw, bh - 48), fill=(216, 214, 206), width=2)
    cd.line((86, 48, 86, bh - 48), fill=(224, 222, 214), width=2)

    digits = str(spec["barcode_digits"])
    bits = encode_ean13_bits(digits)
    mod_w = 3
    bars_w = len(bits) * mod_w

    patch_w = 348
    patch_h = 186
    px0 = (bw - patch_w) // 2
    py0 = (bh - patch_h) // 2
    cd.rounded_rectangle(
        (px0, py0, px0 + patch_w, py0 + patch_h),
        radius=8,
        fill=(255, 255, 255),
        outline=(206, 204, 198),
        width=2,
    )

    bx0 = px0 + (patch_w - bars_w) // 2
    by0 = py0 + 22
    bar_h = 104
    guard_indices = set(range(0, 3)) | set(range(45, 50)) | set(range(92, 95))

    for m_idx, bit in enumerate(bits):
        if bit == "1":
            extra = 10 if m_idx in guard_indices else 0
            x_left = bx0 + m_idx * mod_w
            cd.rectangle((x_left, by0, x_left + mod_w - 1, by0 + bar_h + extra), fill=(12, 14, 18))

    f_num = ImageFont.load_default(size=30)
    tw = cd.textlength(digits, font=f_num)
    tx = int(px0 + (patch_w - tw) / 2)
    ty = by0 + bar_h + 16
    cd.text((tx, ty), digits, fill=(12, 14, 18), font=f_num, stroke_width=1, stroke_fill=(12, 14, 18))
    return card


def render_case(spec: dict[str, Any]) -> Image.Image:
    style = spec["render_style"]
    if style == "med_box":
        card = build_med_box_card(spec)
        border = (170, 176, 184, 255)
    elif style == "food_carton":
        card = build_food_carton_card(spec)
        border = (168, 162, 150, 255)
    elif style == "rear_barcode":
        card = build_rear_barcode_card(spec)
        border = (178, 176, 168, 255)
    else:
        raise ValueError(f"Unknown render_style: {style}")

    oriented = apply_package_orientation(
        card_rgb=card,
        corner_radius=16,
        border_rgba=border,
        rotation_cw_deg=int(spec["rotation_deg"]),
        perspective_tilt=bool(spec["perspective_tilt"]),
    )
    return mount_oriented_package(
        oriented_rgba=oriented,
        seed=int(spec["seed"]),
        occlude_upside_down_thumb=bool(spec.get("occlude_upside_down_thumb", False)),
    )


def save_jpeg_and_b64(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    if img.size != (768, 768):
        raise RuntimeError(f"Expected 768x768 image for {out_path.name}, got {img.size}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii"), len(raw)


def call_gemini_flash(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }
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
            resp = session.post(url, headers=headers, json=payload, timeout=45)
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
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
                    usage = body.get("usageMetadata") or {}
                    tok = {
                        "tokens_in": int(usage.get("promptTokenCount") or 0),
                        "tokens_out": int(
                            usage.get("candidatesTokenCount")
                            or usage.get("responseTokenCount")
                            or 0
                        ),
                        "tokens_thinking": int(usage.get("thoughtsTokenCount") or 0),
                    }
                    return scrub_node(parsed), latency_ms, tok
                last_err = "Empty structured response"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(scrub_node(last_err))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini API call failed after retries: {scrub_node(last_err)}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

    sub_env = dict(os.environ)
    extra_bins = ["/tmp/fleet-silas/node/bin", str(pathlib.Path.home() / ".local" / "bin")]
    cur_path = sub_env.get("PATH", "")
    sub_env["PATH"] = ":".join([p for p in extra_bins if os.path.isdir(p)] + ([cur_path] if cur_path else []))

    node_bin = shutil.which("node", path=sub_env["PATH"])
    if not node_bin:
        raise RuntimeError("node binary not found on PATH")
    return node_bin, sub_env


def evaluate_with_typescript(entries: list[dict[str, Any]]) -> dict[str, Any]:
    node_bin, sub_env = ensure_node_runtime()
    with tempfile.TemporaryDirectory() as tmp_dir:
        sub_env["LEDGER_PATH"] = str(pathlib.Path(tmp_dir) / "ledger.jsonl")
        sub_env["HOLDUP_QUIET"] = "1"
        ts_script = (
            'import fs from "node:fs";'
            'import { toLabelRead, verify } from "./server/src/verify.ts";'
            'import { checkLabel, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
            'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
            'const payload = JSON.parse(fs.readFileSync(0, "utf8"));'
            "const now = new Date(payload.eval_now_iso);"
            "const items = [];"
            "for (const entry of payload.items) {"
            "  const rawText = JSON.stringify(entry.raw);"
            '  const vRes = await verify(["frame"], DEMO_PROFILE, undefined, "orientation_robustness", {'
            '    chain: ["gemini-3.8-flash"],'
            "    generateFn: async () => ({ text: rawText }),"
            "  });"
            "  const read = toLabelRead(entry.raw);"
            "  const verdict = checkLabel(read, DEMO_PROFILE, now);"
            "  const strengthMatches = entry.expected_strength"
            "    ? sameStrength(read.strength.value, entry.expected_strength)"
            "    : null;"
            "  items.push({"
            "    read: vRes.verdict.read,"
            "    verdict,"
            "    verifyLevel: vRes.verdict.level,"
            "    strengthMatches,"
            "    strengthMinConf: STRENGTH_MIN_CONF"
            "  });"
            "}"
            "process.stdout.write(JSON.stringify({ profile: DEMO_PROFILE, items }));"
        )
        proc = subprocess.run(
            [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_script],
            cwd=str(REPO_ROOT),
            env=sub_env,
            input=json.dumps({"eval_now_iso": EVAL_NOW_ISO, "items": entries}),
            text=True,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"TypeScript verify/checkLabel failed ({proc.returncode}): {proc.stderr[:400]}")
        return json.loads(proc.stdout)


def percentile(vals: list[float], q: float) -> float:
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


def run_benchmark(render_only: bool = False) -> dict[str, Any]:
    load_env_files()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    rendered_records: list[dict[str, Any]] = []
    for spec in CASE_SPECS:
        img = render_case(spec)
        img_path = OUT_IMG_DIR / f'{spec["id"]}.jpg'
        b64_jpeg, jpeg_bytes = save_jpeg_and_b64(img, img_path)
        rendered_records.append(
            {
                "spec": spec,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "jpeg_bytes": jpeg_bytes,
                "b64_jpeg": b64_jpeg,
            }
        )

    if render_only:
        return {"rendered": len(rendered_records), "out_dir": str(OUT_IMG_DIR.relative_to(REPO_ROOT))}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    session = requests.Session()
    session.trust_env = True

    api_records: list[dict[str, Any]] = []
    for rec in rendered_records:
        spec = rec["spec"]
        raw_pred, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=rec["b64_jpeg"],
        )
        api_records.append(
            {
                "spec": spec,
                "image_path": rec["image_path"],
                "jpeg_bytes": rec["jpeg_bytes"],
                "raw": raw_pred,
                "latency_ms": latency_ms,
                "tokens": tok,
            }
        )

    ts_bundle = evaluate_with_typescript(
        [
            {"raw": r["raw"], "expected_strength": r["spec"]["expected_strength"]}
            for r in api_records
        ]
    )
    demo_profile = scrub_node(ts_bundle["profile"])
    ts_items = ts_bundle["items"]

    items_out: list[dict[str, Any]] = []
    for rec, ts_res in zip(api_records, ts_items):
        spec = rec["spec"]
        read_obj = scrub_node(ts_res["read"])
        verdict_full = scrub_node(ts_res["verdict"])
        min_conf = float(ts_res["strengthMinConf"])

        pred_level = str(verdict_full["level"])
        exp_level = str(spec["expected_level"])
        verdict_match = pred_level == exp_level

        s_field = read_obj.get("strength") or {}
        s_val = s_field.get("value")
        s_conf = round(float(s_field.get("confidence") or 0.0), 4)
        strength_readable = bool(spec["strength_readable"])

        if strength_readable:
            strength_correct: bool | None = bool(
                s_val is not None
                and s_conf >= min_conf
                and bool(ts_res["strengthMatches"])
            )
            confident_wrong_dose = bool(
                (s_conf >= min_conf and (s_val is None or not bool(ts_res["strengthMatches"])))
                or (exp_level != "match" and pred_level == "match")
            )
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= min_conf)
                or (exp_level != "match" and pred_level == "match")
            )

        reasons = verdict_full.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)
        false_safe_allergen = bool(
            spec["kind"] == "food"
            and spec["has_profile_allergen"]
            and not allergen_detected
        )

        abstained: bool | None = None
        if spec["is_occluded"]:
            abstained = bool(pred_level == "unsure" and not confident_wrong_dose)

        verdict_compact: dict[str, Any] = {
            "level": pred_level,
            "headline": verdict_full["headline"],
            "speech": verdict_full["speech"],
            "reasons": reasons,
        }
        if "matchedMedId" in verdict_full:
            verdict_compact["matchedMedId"] = verdict_full["matchedMedId"]
        if "takenToday" in verdict_full:
            verdict_compact["takenToday"] = verdict_full["takenToday"]

        item_row = {
            "id": spec["id"],
            "orientation_group": spec["orientation_group"],
            "rotation_deg": int(spec["rotation_deg"]),
            "perspective_tilt": bool(spec["perspective_tilt"]),
            "kind": spec["kind"],
            "description": spec["description"],
            "image_path": rec["image_path"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": rec["jpeg_bytes"],
            "strength_readable": strength_readable,
            "is_occluded": bool(spec["is_occluded"]),
            "has_profile_allergen": bool(spec["has_profile_allergen"]),
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "expected_strength": spec["expected_strength"],
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "allergen_detected": allergen_detected,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "latency_ms": rec["latency_ms"],
            "tokens_in": rec["tokens"]["tokens_in"],
            "tokens_out": rec["tokens"]["tokens_out"],
            "tokens_thinking": rec["tokens"]["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_compact,
        }
        items_out.append(item_row)
        print(
            f'[{spec["id"]}] rot={spec["rotation_deg"]}deg exp={exp_level} pred={pred_level} '
            f"match={verdict_match} strength={s_val} (conf={s_conf:.2f}) "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={rec['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    upside_down_items = [it for it in items_out if it["rotation_deg"] == 180]
    sideways_items = [it for it in items_out if it["rotation_deg"] in (90, 270)]
    tilted_items = [it for it in items_out if it["perspective_tilt"]]
    readable_items = [it for it in items_out if it["strength_readable"]]
    occluded_items = [it for it in items_out if it["is_occluded"]]

    upside_down_acc = (
        round(sum(1 for it in upside_down_items if it["verdict_match"]) / len(upside_down_items), 4)
        if upside_down_items
        else 0.0
    )
    sideways_acc = (
        round(sum(1 for it in sideways_items if it["verdict_match"]) / len(sideways_items), 4)
        if sideways_items
        else 0.0
    )
    tilted_acc = (
        round(sum(1 for it in tilted_items if it["verdict_match"]) / len(tilted_items), 4)
        if tilted_items
        else 0.0
    )
    readable_recall = (
        round(sum(1 for it in readable_items if it["strength_correct"]) / len(readable_items), 4)
        if readable_items
        else 0.0
    )
    occluded_abstention_rate = (
        round(sum(1 for it in occluded_items if it["abstained"]) / len(occluded_items), 4)
        if occluded_items
        else 0.0
    )

    cwd_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    fsa_count = sum(1 for it in items_out if it["false_safe_allergen"])

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4) if n_items else 0.0,
        "upside_down_180_accuracy": upside_down_acc,
        "sideways_90_270_accuracy": sideways_acc,
        "tilted_off_axis_accuracy": tilted_acc,
        "readable_recall": readable_recall,
        "clean_field_accuracy": readable_recall,
        "occluded_abstention_rate": occluded_abstention_rate,
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1) if latencies else 0.0,
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = scrub_node(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": EVAL_NOW_ISO,
            "model": MODEL_NAME,
            "profile_summary": {
                "meds": [
                    f"{m['name']} {m['strength']} ({'/'.join(m['schedule'])})"
                    for m in demo_profile.get("meds", [])
                ],
                "allergies": list(demo_profile.get("allergies", [])),
                "avoid": list(demo_profile.get("avoid", [])),
            },
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_output(report)
    OUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upside-down, sideways, and tilted blind-hold orientation live benchmark"
    )
    parser.add_argument("--render-only", action="store_true", help="Render 768x768 JPEGs without API calls")
    args = parser.parse_args(argv)

    res = run_benchmark(render_only=args.render_only)
    if args.render_only:
        print(json.dumps(res, indent=2))
    else:
        print(json.dumps(res["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
