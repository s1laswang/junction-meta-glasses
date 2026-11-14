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
import time
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "cellophane_tremor"
OUT_JSON_PATH = REPO_ROOT / "eval" / "cellophane_tremor_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
ALLERGEN_MIN_CONF = 0.60
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)

DEMO_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "barcode": "6432100012345",
            "notes": "Blood pressure, 1 tablet in the evening",
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "barcode": "6432100054321",
            "notes": "With meals twice daily",
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
            "barcode": "6432100098765",
            "notes": "Pain or fever",
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ct_01",
        "compound_tier": "moderate",
        "glare_mode": "angled_off_digits",
        "scene_type": "med_box",
        "description": "Moderate compound (2.5 px hand tremor + angled glossy cellophane streak off-digits): Amlodipin 5 mg evening dose match",
        "tremor_px": 2.5,
        "tremor_angle_deg": 14.0,
        "glare_angle_deg": -28.0,
        "iso_noise_sigma": 2.0,
        "shot_gain": 0.12,
        "strength_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -1.4,
    },
    {
        "id": "ct_02",
        "compound_tier": "moderate",
        "glare_mode": "angled_off_digits",
        "scene_type": "med_box",
        "description": "Moderate compound (2.5 px hand tremor + angled glossy cellophane streak off-digits): Burana 400 mg NSAID avoid warning",
        "tremor_px": 2.5,
        "tremor_angle_deg": -15.5,
        "glare_angle_deg": -26.0,
        "iso_noise_sigma": 2.0,
        "shot_gain": 0.12,
        "strength_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "accent": (186, 34, 44),
        "header": "ORION PHARMA",
        "title": "Burana",
        "subtitle": "Active ingredient: ibuprofen",
        "strength_badge": "400 mg",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.6,
    },
    {
        "id": "ct_03",
        "compound_tier": "moderate",
        "glare_mode": "angled_off_digits",
        "scene_type": "med_box",
        "description": "Moderate compound (2.5 px hand tremor + angled glossy cellophane streak off-digits): Metformin 500 mg EXP 2024-10 expired warning",
        "tremor_px": 2.5,
        "tremor_angle_deg": 13.0,
        "glare_angle_deg": -30.0,
        "iso_noise_sigma": 2.0,
        "shot_gain": 0.12,
        "strength_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "500 mg",
        "expected_level": "warning",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2024-10",
        "tilt_deg": -1.3,
    },
    {
        "id": "ct_04",
        "compound_tier": "moderate",
        "glare_mode": "angled_off_digits",
        "scene_type": "food_pack",
        "description": "Moderate compound (2.5 px hand tremor + angled glossy cellophane streak off-panel): Roasted Peanut Granola allergen warning",
        "tremor_px": 2.5,
        "tremor_angle_deg": -14.5,
        "glare_angle_deg": -25.0,
        "iso_noise_sigma": 2.0,
        "shot_gain": 0.12,
        "strength_readable": False,
        "has_profile_allergen": True,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (142, 76, 32),
        "header": "NORDIC HARVEST",
        "title": "Roasted Peanut Granola",
        "subtitle": "Crunchy Oat & Peanut Cereal  450 g",
        "ingredients_lines": [
            "Ingredients: wholegrain oats,",
            "roasted peanuts (18%), honey, rapeseed oil.",
        ],
        "allergen_line": "Allergens: Contains peanuts, oats (gluten).",
        "expiry_line": "Best before: 2027-10-18",
        "tilt_deg": 1.4,
    },
    {
        "id": "ct_05",
        "compound_tier": "moderate",
        "glare_mode": "angled_off_digits",
        "scene_type": "food_pack",
        "description": "Moderate compound (2.5 px hand tremor + angled glossy cellophane streak off-panel): Nordic Oat Drink safe info verdict",
        "tremor_px": 2.5,
        "tremor_angle_deg": 15.0,
        "glare_angle_deg": -27.0,
        "iso_noise_sigma": 2.0,
        "shot_gain": 0.12,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "info",
        "accent": (36, 108, 92),
        "header": "NORDIC DAIRY FREE",
        "title": "Nordic Oat Drink",
        "subtitle": "Plant-Based Oat Beverage  1 L",
        "ingredients_lines": [
            "Ingredients: water, oats (10%),",
            "rapeseed oil, sea salt.",
        ],
        "allergen_line": "Allergens: Contains oats (gluten).",
        "expiry_line": "Best before: 2027-12-08",
        "tilt_deg": -1.2,
    },
    {
        "id": "ct_06",
        "compound_tier": "severe",
        "glare_mode": "saturated_bar_on_digits",
        "scene_type": "med_box",
        "description": "Severe compound (saturated white cellophane specular bar + 14 px hand tremor obliterating dosage digits): Amlodipin safe abstention",
        "tremor_px": 14.0,
        "tremor_angle_deg": 11.0,
        "glare_angle_deg": -4.5,
        "iso_noise_sigma": 3.2,
        "shot_gain": 0.18,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "AMLODIPIN",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -2.2,
    },
    {
        "id": "ct_07",
        "compound_tier": "severe",
        "glare_mode": "saturated_bar_on_digits",
        "scene_type": "med_box",
        "description": "Severe compound (saturated white cellophane specular bar + 14 px hand tremor obliterating dosage digits): Metformin safe abstention",
        "tremor_px": 14.0,
        "tremor_angle_deg": -12.0,
        "glare_angle_deg": 4.0,
        "iso_noise_sigma": 3.2,
        "shot_gain": 0.18,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 2.4,
    },
    {
        "id": "ct_08",
        "compound_tier": "severe",
        "glare_mode": "saturated_bar_on_digits",
        "scene_type": "med_box",
        "description": "Severe compound (saturated white cellophane specular bar + 14 px hand tremor obliterating dosage digits): Panadol safe abstention",
        "tremor_px": 14.0,
        "tremor_angle_deg": 10.5,
        "glare_angle_deg": -5.0,
        "iso_noise_sigma": 3.2,
        "shot_gain": 0.18,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC",
        "title": "PANADOL",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2028-02",
        "tilt_deg": -2.1,
    },
]


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
                    k_bytes, v_bytes = chunk.split(b"=", 1)
                    k_str = k_bytes.decode("utf-8", errors="ignore").strip()
                    v_str = v_bytes.decode("utf-8", errors="ignore")
                    if k_str and k_str not in os.environ:
                        os.environ[k_str] = v_str
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
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED_KEY]", cleaned)
    if isinstance(val, list):
        return [sanitize_obj(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in val.items()}
    return val


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


def render_kitchen_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (222, 218, 210))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.60)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(236 - 20 * t), int(232 - 20 * t), int(224 - 18 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 23)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(188 - 26 * t) + jitter)),
            max(0, min(255, int(166 - 22 * t) + jitter)),
            max(0, min(255, int(142 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(138, 118, 98), width=2)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((int(size * 0.16), 24, int(size * 0.44), 196), fill=(255, 252, 242, 52))
    bd.ellipse((int(size * 0.58), 36, int(size * 0.86), 214), fill=(246, 250, 255, 44))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=22.0))
    return Image.alpha_composite(canvas.convert("RGBA"), bokeh).convert("RGB")


def draw_cellophane_corner_crinkles(card: Image.Image, rng: random.Random) -> None:
    cw, ch = card.size
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    corners = [
        (0, 0, 1, 1),
        (cw - 1, 0, -1, 1),
        (0, ch - 1, 1, -1),
        (cw - 1, ch - 1, -1, -1),
    ]
    for cx, cy, dx, dy in corners:
        od.line((cx, cy, cx + dx * 42, cy + dy * 28), fill=(255, 255, 255, 130), width=2)
        od.line((cx + dx * 6, cy, cx + dx * 32, cy + dy * 38), fill=(210, 222, 236, 95), width=1)
        for _ in range(3):
            ox = cx + dx * rng.randint(8, 36)
            oy = cy + dy * rng.randint(6, 28)
            tx = ox + dx * rng.randint(10, 24)
            ty = oy + dy * rng.randint(6, 18)
            od.line((ox, oy, tx, ty), fill=(255, 255, 255, 105), width=1)
    od.rounded_rectangle(
        (2, 2, cw - 3, ch - 3),
        radius=15,
        outline=(255, 255, 255, 92),
        width=2,
    )
    soft = overlay.filter(ImageFilter.GaussianBlur(radius=0.7))
    card.paste(Image.alpha_composite(card.convert("RGBA"), soft).convert("RGB"))


def compute_angled_off_digits_glare(
    height: int,
    width: int,
    cx: float,
    cy: float,
    angle_deg: float,
    safe_mask: np.ndarray,
) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    theta = math.radians(angle_deg)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    dx = xx - cx
    dy = yy - cy
    u = dx * cos_t + dy * sin_t
    v = -dx * sin_t + dy * cos_t

    along_env = np.exp(-0.5 * ((u / 82.0) ** 2))
    primary_core = 210.0 * np.exp(-0.5 * ((v / 7.5) ** 2)) * along_env
    fold_trough = -22.0 * np.exp(-0.5 * (((v + 12.0) / 4.5) ** 2)) * along_env
    secondary_line = 135.0 * np.exp(-0.5 * (((v - 18.0) / 4.0) ** 2)) * along_env
    fresnel_sheen = 58.0 * np.exp(-0.5 * ((v / 24.0) ** 2)) * along_env
    streak = (primary_core + fold_trough + secondary_line + fresnel_sheen) * safe_mask
    rgb_weights = np.array([0.99, 1.00, 1.02], dtype=np.float32)[None, None, :]
    return streak[:, :, None] * rgb_weights


def compute_saturated_bar_on_digits(
    height: int,
    width: int,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    angle_deg: float,
) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    cx = 0.5 * float(sx0 + sx1) + 18.0
    cy = 0.5 * float(sy0 + sy1)
    theta = math.radians(angle_deg)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    dx = xx - cx
    dy = yy - cy
    u = dx * cos_t + dy * sin_t
    v = -dx * sin_t + dy * cos_t

    half_u = 0.5 * float(sx1 - sx0) + 52.0
    half_v = 0.5 * float(sy1 - sy0) + 6.0

    u_excess = np.maximum(0.0, np.abs(u) - half_u)
    v_excess = np.maximum(0.0, np.abs(v) - half_v)

    core_u = np.exp(-0.5 * ((u_excess / 26.0) ** 2))
    core_v = np.exp(-0.5 * ((v_excess / 10.5) ** 2))
    saturated_core = 640.0 * core_u * core_v

    halo_u = np.exp(-0.5 * ((u / (half_u + 58.0)) ** 2))
    halo_v = np.exp(-0.5 * ((v / 22.0) ** 2))
    bloom_halo = 145.0 * halo_u * halo_v

    crinkle_ridge = (
        95.0
        * np.exp(-0.5 * (((v + 16.0) / 3.5) ** 2))
        * np.exp(-0.5 * ((u / (half_u + 34.0)) ** 2))
    )

    total = saturated_core + bloom_halo + crinkle_ridge
    return np.repeat(total[:, :, None], 3, axis=2).astype(np.float32)


def render_med_box_hdr(case: dict[str, Any], seed: int) -> np.ndarray:
    pad = 80
    size = 768 + 2 * pad
    bg = render_kitchen_backdrop(size, seed)
    rng = random.Random(seed + 19)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 118, pad + 700, pad + 642
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0 - 4, y0 - 4, x1 + 3, y1 + 3),
        radius=19,
        fill=(248, 252, 255, 48),
        outline=(255, 255, 255, 138),
        width=2,
    )

    card = Image.new("RGB", (bw, bh), (238, 240, 244))
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 64), fill=case["accent"])
    cd.text(
        (28, 18),
        case["header"],
        fill=(248, 250, 252),
        font=ImageFont.load_default(size=24),
    )

    cd.text(
        (28, 84),
        case["title"],
        fill=(10, 14, 20),
        font=ImageFont.load_default(size=50),
        stroke_width=1,
        stroke_fill=(10, 14, 20),
    )
    cd.text(
        (28, 150),
        case["subtitle"],
        fill=(24, 30, 38),
        font=ImageFont.load_default(size=26),
    )

    sx0, sy0, sx1, sy1 = 28, 204, 274, 294
    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=12,
        fill=(240, 246, 252),
        outline=case["accent"],
        width=4,
    )
    if case["strength_badge"]:
        cd.text(
            (sx0 + 22, sy0 + 18),
            case["strength_badge"],
            fill=(8, 12, 18),
            font=ImageFont.load_default(size=48),
            stroke_width=1,
            stroke_fill=(8, 12, 18),
        )

    if case["form_line"]:
        cd.text(
            (sx1 + 20, sy0 + 30),
            case["form_line"],
            fill=(24, 30, 38),
            font=ImageFont.load_default(size=24),
        )

    if case["pack_line"]:
        cd.text(
            (28, 344),
            case["pack_line"],
            fill=(28, 34, 42),
            font=ImageFont.load_default(size=25),
        )

    if case["expiry_line"]:
        cd.rounded_rectangle(
            (bw - 266, 404, bw - 28, 464),
            radius=8,
            fill=(244, 246, 249),
            outline=(136, 144, 154),
            width=2,
        )
        cd.text(
            (bw - 246, 418),
            case["expiry_line"],
            fill=(10, 14, 20),
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=(10, 14, 20),
        )

    draw_cellophane_corner_crinkles(card, rng)

    card_hdr = np.asarray(card, dtype=np.float32).copy()
    if case["glare_mode"] == "angled_off_digits":
        yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32)
        safe_x = np.clip((xx - 418.0) / 28.0, 0.0, 1.0)
        safe_y = np.clip((216.0 - yy) / 24.0, 0.0, 1.0)
        safe_mask = safe_x * safe_y
        card_hdr = card_hdr + compute_angled_off_digits_glare(
            height=bh,
            width=bw,
            cx=528.0,
            cy=112.0,
            angle_deg=float(case["glare_angle_deg"]),
            safe_mask=safe_mask,
        )
    else:
        card_hdr = card_hdr + compute_saturated_bar_on_digits(
            height=bh,
            width=bw,
            sx0=sx0,
            sy0=sy0,
            sx1=sx1,
            sy1=sy1,
            angle_deg=float(case["glare_angle_deg"]),
        )

    card_clipped = Image.fromarray(np.clip(card_hdr, 0.0, 255.0).astype(np.uint8), mode="RGB")
    card_excess = np.maximum(0.0, card_hdr - 255.0)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card_clipped, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(176, 184, 194, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed_rgb = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped_rgb = composed_rgb.crop((pad, pad, pad + 768, pad + 768))
    hdr_out = np.asarray(cropped_rgb, dtype=np.float32)

    if float(np.max(card_excess)) > 0.0:
        excess_canvas = np.zeros((size, size, 3), dtype=np.float32)
        mask_arr = (np.asarray(mask, dtype=np.float32) / 255.0)[:, :, None]
        excess_canvas[y0:y1, x0:x1, :] = card_excess * mask_arr
        excess_scale = float(np.max(card_excess))
        excess_u8 = Image.fromarray(
            np.clip(np.round(excess_canvas / excess_scale * 255.0), 0.0, 255.0).astype(np.uint8),
            mode="RGB",
        )
        excess_rot = excess_u8.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
        excess_crop = excess_rot.crop((pad, pad, pad + 768, pad + 768))
        hdr_out = hdr_out + (np.asarray(excess_crop, dtype=np.float32) / 255.0) * excess_scale

    return hdr_out


def render_food_pack_hdr(case: dict[str, Any], seed: int) -> np.ndarray:
    pad = 80
    size = 768 + 2 * pad
    bg = render_kitchen_backdrop(size, seed)
    rng = random.Random(seed + 47)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 82, pad + 88, pad + 686, pad + 680
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0 - 4, y0 - 4, x1 + 3, y1 + 3),
        radius=19,
        fill=(248, 252, 255, 48),
        outline=(255, 255, 255, 138),
        width=2,
    )

    carton = Image.new("RGB", (cw, ch), (240, 237, 230))
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 64), fill=case["accent"])
    cd.text(
        (26, 19),
        case["header"],
        fill=(248, 250, 248),
        font=ImageFont.load_default(size=23),
    )
    cd.text(
        (26, 82),
        case["title"],
        fill=(12, 18, 16),
        font=ImageFont.load_default(size=38),
        stroke_width=1,
        stroke_fill=(12, 18, 16),
    )
    cd.text(
        (26, 138),
        case["subtitle"],
        fill=(36, 46, 42),
        font=ImageFont.load_default(size=23),
    )

    cd.rounded_rectangle(
        (24, 192, cw - 24, 420),
        radius=12,
        fill=(254, 254, 252),
        outline=(168, 164, 154),
        width=2,
    )
    iy = 212
    for ln in case["ingredients_lines"]:
        cd.text(
            (38, iy),
            ln,
            fill=(12, 16, 16),
            font=ImageFont.load_default(size=25),
            stroke_width=1,
            stroke_fill=(12, 16, 16),
        )
        iy += 38

    iy += 16
    cd.rounded_rectangle(
        (36, iy - 8, cw - 36, iy + 52),
        radius=8,
        fill=(245, 242, 234),
        outline=(142, 128, 108),
        width=2,
    )
    cd.text(
        (48, iy + 8),
        case["allergen_line"],
        fill=(14, 18, 18),
        font=ImageFont.load_default(size=22),
        stroke_width=1,
        stroke_fill=(14, 18, 18),
    )

    cd.rounded_rectangle(
        (24, 452, 368, 516),
        radius=8,
        fill=(255, 255, 255),
        outline=(172, 168, 158),
        width=2,
    )
    cd.text(
        (38, 470),
        case["expiry_line"],
        fill=(14, 18, 20),
        font=ImageFont.load_default(size=25),
    )

    draw_cellophane_corner_crinkles(carton, rng)

    carton_hdr = np.asarray(carton, dtype=np.float32).copy()
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    bot_mask = np.clip((xx - 384.0) / 26.0, 0.0, 1.0) * np.clip((yy - 436.0) / 24.0, 0.0, 1.0)
    top_mask = np.clip((xx - 482.0) / 22.0, 0.0, 1.0) * np.clip((118.0 - yy) / 22.0, 0.0, 1.0)
    carton_hdr = (
        carton_hdr
        + compute_angled_off_digits_glare(
            height=ch,
            width=cw,
            cx=494.0,
            cy=510.0,
            angle_deg=float(case["glare_angle_deg"]),
            safe_mask=bot_mask,
        )
        + compute_angled_off_digits_glare(
            height=ch,
            width=cw,
            cx=542.0,
            cy=48.0,
            angle_deg=float(case["glare_angle_deg"]),
            safe_mask=top_mask,
        )
    )

    carton_clipped = Image.fromarray(np.clip(carton_hdr, 0.0, 255.0).astype(np.uint8), mode="RGB")
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton_clipped, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(174, 170, 160, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))
    return np.asarray(cropped, dtype=np.float32)


def shift_hdr_bilinear(arr: np.ndarray, dx: float, dy: float) -> np.ndarray:
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sx = np.clip(xx - dx, 0.0, float(w - 1))
    sy = np.clip(yy - dy, 0.0, float(h - 1))

    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)

    wx = (sx - x0)[:, :, None]
    wy = (sy - y0)[:, :, None]

    top = arr[y0, x0] * (1.0 - wx) + arr[y0, x1] * wx
    bot = arr[y1, x0] * (1.0 - wx) + arr[y1, x1] * wx
    return top * (1.0 - wy) + bot * wy


def apply_directional_tremor_hdr(
    hdr_arr: np.ndarray,
    tremor_px: float,
    angle_deg: float,
) -> np.ndarray:
    span = float(tremor_px)
    if span <= 0.05:
        return hdr_arr.copy()

    n_samples = max(9, int(math.ceil(span * 2.5)) | 1)
    theta = math.radians(angle_deg)
    ux = math.cos(theta)
    uy = math.sin(theta)

    offsets = np.linspace(-0.5 * span, 0.5 * span, n_samples, dtype=np.float64)
    acc = np.zeros_like(hdr_arr, dtype=np.float32)
    weight = 1.0 / float(n_samples)
    for s in offsets:
        acc += shift_hdr_bilinear(hdr_arr, float(s * ux), float(s * uy)) * weight
    return acc


def lcg_normal_grid(height: int, width: int, channels: int, seed: int) -> np.ndarray:
    py_rng = random.Random(seed)
    total = height * width * channels
    idx = np.arange(total, dtype=np.uint64)
    s0 = np.uint64(py_rng.getrandbits(32) | 1)
    state1 = (np.uint64(1664525) * (idx ^ s0) + np.uint64(1013904223)) & np.uint64(0xFFFFFFFF)
    state2 = (np.uint64(1664525) * state1 + np.uint64(1013904223)) & np.uint64(0xFFFFFFFF)
    state3 = (np.uint64(1664525) * state2 + np.uint64(1013904223)) & np.uint64(0xFFFFFFFF)
    u1 = (state2.astype(np.float32) + 0.5) / 4294967296.0
    u2 = (state3.astype(np.float32) + 0.5) / 4294967296.0
    z = np.sqrt(-2.0 * np.log(np.clip(u1, 1e-7, 1.0))) * np.cos(2.0 * math.pi * u2)
    return z.reshape((height, width, channels))


def apply_sensor_readout(
    hdr_arr: np.ndarray,
    iso_noise_sigma: float,
    shot_gain: float,
    seed: int,
) -> Image.Image:
    h, w, c = hdr_arr.shape
    lit = hdr_arr.copy()
    if iso_noise_sigma > 0.0 or shot_gain > 0.0:
        z_read = lcg_normal_grid(h, w, c, seed=seed * 17 + 11)
        z_shot = lcg_normal_grid(h, w, c, seed=seed * 31 + 23)
        shot_std = shot_gain * np.sqrt(np.maximum(np.minimum(lit, 255.0), 1.0))
        lit = lit + shot_std * z_shot + iso_noise_sigma * z_read
    clipped = np.clip(np.round(lit), 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(clipped, mode="RGB")


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261146 + idx * 149
    if case["scene_type"] == "med_box":
        hdr = render_med_box_hdr(case, seed)
    else:
        hdr = render_food_pack_hdr(case, seed)

    blurred_hdr = apply_directional_tremor_hdr(
        hdr_arr=hdr,
        tremor_px=float(case["tremor_px"]),
        angle_deg=float(case["tremor_angle_deg"]),
    )
    img = apply_sensor_readout(
        hdr_arr=blurred_hdr,
        iso_noise_sigma=float(case["iso_noise_sigma"]),
        shot_gain=float(case["shot_gain"]),
        seed=seed,
    )
    assert img.size == (768, 768)
    return img


def encode_jpeg(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw_bytes = buf.getvalue()
    out_path.write_bytes(raw_bytes)
    return base64.b64encode(raw_bytes).decode("ascii"), len(raw_bytes)


def build_http_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = True
    https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
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


def call_gemini_flash(
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
            latency_ms = (time.perf_counter() - t0) * 1000.0
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
                        "in": int(usage.get("promptTokenCount") or 0),
                        "out": int(usage.get("candidatesTokenCount") or 0),
                        "thinking": int(usage.get("thoughtsTokenCount") or 0),
                    }
                    return parsed, latency_ms, tok
                last_err = "empty structured output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {sanitize_obj(resp.text[:240])}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(sanitize_obj(str(exc)))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini call failed after retries: {last_err}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

    proc_env = dict(os.environ)
    extra_bins = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    cur_path = proc_env.get("PATH", "")
    proc_env["PATH"] = ":".join([p for p in extra_bins if os.path.isdir(p)] + ([cur_path] if cur_path else []))

    node_bin = shutil.which("node", path=proc_env["PATH"])
    if not node_bin:
        raise RuntimeError("node binary not found in PATH")
    return node_bin, proc_env


def evaluate_via_typescript(raw_items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node_bin, proc_env = ensure_node_runtime()
    ts_code = (
        'import fs from "node:fs";'
        'import { toLabelRead } from "./server/src/verify.ts";'
        'import { checkLabel, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
        'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
        'const payload = JSON.parse(fs.readFileSync(0, "utf8"));'
        "const now = new Date(payload.eval_now_iso);"
        "const evaluated = payload.items.map((entry) => {"
        "  const read = toLabelRead(entry.raw_json);"
        "  const verdict = checkLabel(read, DEMO_PROFILE, now);"
        "  const { read: _omit, ...verdictMeta } = verdict;"
        "  const strengthSame = entry.expected_strength ? sameStrength(read.strength.value, entry.expected_strength) : false;"
        "  return {"
        "    id: entry.id,"
        "    read,"
        "    verdict: verdictMeta,"
        "    strength_same: strengthSame,"
        "    strength_min_conf: STRENGTH_MIN_CONF"
        "  };"
        "});"
        "process.stdout.write(JSON.stringify({ evaluated }));"
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"eval_now_iso": EVAL_NOW_ISO, "items": raw_items}),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=proc_env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    parsed = json.loads(proc.stdout)
    return {row["id"]: row for row in parsed["evaluated"]}


def assert_clean_artifact(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Base64 or oversized string found in output JSON")
        if "AIza" in node:
            raise AssertionError("API key prefix found in output JSON")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_artifact(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_artifact(k)
            assert_clean_artifact(v)


def main() -> None:
    load_env_with_proxy()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    session = build_http_session()
    raw_runs: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        img = render_case_image(case, idx)
        b64_jpeg, byte_len = encode_jpeg(img, img_path)
        raw_json, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
        )
        raw_runs.append(
            {
                "case": case,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "image_bytes": byte_len,
                "raw_json": raw_json,
                "latency_ms": round(latency_ms, 1),
                "tokens_in": tok["in"],
                "tokens_out": tok["out"],
                "tokens_thinking": tok["thinking"],
            }
        )

    ts_inputs = [
        {
            "id": r["case"]["id"],
            "raw_json": r["raw_json"],
            "expected_strength": r["case"]["expected_strength"],
        }
        for r in raw_runs
    ]
    ts_by_id = evaluate_via_typescript(ts_inputs)

    items_out: list[dict[str, Any]] = []
    for run in raw_runs:
        case = run["case"]
        cid = case["id"]
        ts_row = ts_by_id[cid]
        read_obj = sanitize_obj(ts_row["read"])
        verdict_obj = sanitize_obj(ts_row["verdict"])

        pred_level = str(verdict_obj["level"])
        exp_level = str(case["expected_level"])
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        strength_same = bool(ts_row["strength_same"])
        sr = bool(case["strength_readable"])

        if sr:
            strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or s_conf >= STRENGTH_MIN_CONF
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = pred_level == "unsure"

        reasons = verdict_obj.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        has_allergen = bool(case["has_profile_allergen"])
        is_food = case["scene_type"] == "food_pack"
        alg_val = read_obj["allergens"]["value"]
        alg_conf = float(read_obj["allergens"]["confidence"])
        false_safe_allergen = bool(
            (has_allergen and not (pred_level == "warning" and allergen_reason_hit))
            or (is_food and (alg_val is None or alg_conf < ALLERGEN_MIN_CONF) and pred_level in ("info", "match"))
        )

        item_record = {
            "id": cid,
            "compound_tier": case["compound_tier"],
            "glare_mode": case["glare_mode"],
            "scene_type": case["scene_type"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "tremor_px": case["tremor_px"],
            "tremor_angle_deg": case["tremor_angle_deg"],
            "glare_angle_deg": case["glare_angle_deg"],
            "strength_readable": sr,
            "has_profile_allergen": has_allergen,
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "latency_ms": run["latency_ms"],
            "tokens_in": run["tokens_in"],
            "tokens_out": run["tokens_out"],
            "tokens_thinking": run["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_record)
        print(
            f"[{cid}] tier={case['compound_tier']} tremor={case['tremor_px']}px "
            f"glare={case['glare_mode']} exp={exp_level} pred={pred_level} "
            f"match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    moderate_items = [it for it in items_out if it["compound_tier"] == "moderate"]
    severe_items = [it for it in items_out if it["compound_tier"] == "severe"]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    moderate_compound_accuracy = round(
        sum(
            1
            for it in moderate_items
            if it["verdict_match"]
            and (not it["strength_readable"] or bool(it["strength_correct"]))
            and not it["false_safe_allergen"]
        )
        / len(moderate_items),
        4,
    )

    severe_compound_abstention_rate = round(
        sum(1 for it in severe_items if it["abstained"] and not it["confident_wrong_dose"])
        / len(severe_items),
        4,
    )

    confident_wrong_dose_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    false_safe_allergen_count = sum(1 for it in items_out if it["false_safe_allergen"])

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "n_moderate_compound": len(moderate_items),
        "n_severe_compound": len(severe_items),
        "moderate_compound_accuracy": moderate_compound_accuracy,
        "severe_compound_abstention_rate": severe_compound_abstention_rate,
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

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": DEMO_PROFILE,
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_artifact(report)
    if confident_wrong_dose_count != 0:
        raise AssertionError(f"Expected confident_wrong_dose_count == 0, got {confident_wrong_dose_count}")
    if false_safe_allergen_count != 0:
        raise AssertionError(f"Expected false_safe_allergen_count == 0, got {false_safe_allergen_count}")

    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
