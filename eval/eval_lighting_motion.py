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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "lighting_motion"
OUT_JSON_PATH = REPO_ROOT / "eval" / "lighting_motion_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
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
        "id": "lm_01",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "clean",
        "scene_type": "med_box",
        "description": "Bright daylight 100% luminance AMLODIPINE 5 mg / EXP 2027-08",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 0.0,
        "shot_gain": 0.0,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": True,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (24, 96, 152),
        "header": "NORDIC PHARMA",
        "title": "AMLODIPINE",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-08",
        "tilt_deg": -1.2,
    },
    {
        "id": "lm_02",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "moderate",
        "scene_type": "med_box",
        "description": "Indoor evening lamp 50% luminance + mild ISO grain AMLODIPINE 5 mg / EXP 2027-08",
        "luminance_pct": 50,
        "warm_tint": True,
        "iso_noise_sigma": 5.5,
        "shot_gain": 0.35,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": True,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (24, 96, 152),
        "header": "NORDIC PHARMA",
        "title": "AMLODIPINE",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-08",
        "tilt_deg": 1.4,
    },
    {
        "id": "lm_03",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "moderate",
        "scene_type": "med_box",
        "description": "Dim bedroom 25% luminance + moderate ISO grain BURANA 400 mg / ibuprofeeni",
        "luminance_pct": 25,
        "warm_tint": True,
        "iso_noise_sigma": 9.0,
        "shot_gain": 0.50,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": True,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "accent": (188, 32, 42),
        "header": "ORION PHARMA",
        "title": "BURANA",
        "subtitle": "Vaikuttava aine: ibuprofeeni",
        "strength_badge": "400 mg",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-10",
        "tilt_deg": -1.6,
    },
    {
        "id": "lm_04",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "moderate",
        "scene_type": "food_pack",
        "description": "Dim kitchen 25% luminance Roasted Hazelnut Bar / Ingredients: oats, hazelnuts, honey",
        "luminance_pct": 25,
        "warm_tint": True,
        "iso_noise_sigma": 6.5,
        "shot_gain": 0.40,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (132, 74, 34),
        "header": "NORDIC BAKERY",
        "title": "Roasted Hazelnut Bar",
        "subtitle": "Crunchy Oat & Nut Snack Bar",
        "ingredients_lines": [
            "Ingredients: oats, hazelnuts, honey.",
        ],
        "allergen_line": "Allergens: Contains hazelnuts (tree nuts), oats.",
        "expiry_line": "Best before: 2027-09-18",
        "tilt_deg": 1.3,
    },
    {
        "id": "lm_05",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "severe",
        "scene_type": "dark_silhouette",
        "description": "Near-pitch-black 3% luminance + heavy sensor noise with no readable text",
        "luminance_pct": 3,
        "warm_tint": False,
        "iso_noise_sigma": 26.0,
        "shot_gain": 1.40,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "tilt_deg": -2.5,
    },
    {
        "id": "lm_06",
        "sweep_group": "ambient_lighting",
        "degradation_tier": "severe",
        "scene_type": "med_box",
        "description": "Blown-out overexposed flashlight hotspot completely washing out the strength digits on METFORMIN",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 2.5,
        "shot_gain": 0.15,
        "flashlight_hotspot": True,
        "motion_blur_px": 0,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 88, 162),
        "header": "ORION PHARMA",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "strength_badge": None,
        "form_line": "",
        "pack_line": "",
        "expiry_line": "",
        "tilt_deg": 1.8,
    },
    {
        "id": "lm_07",
        "sweep_group": "motion_blur",
        "degradation_tier": "clean",
        "scene_type": "med_box",
        "description": "Crisp static hold (0px blur) METFORMIN 500 mg / EXP 2027-11",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 0.0,
        "shot_gain": 0.0,
        "flashlight_hotspot": False,
        "motion_blur_px": 0,
        "strength_readable": True,
        "expected_strength": "500 mg",
        "expected_level": "match",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": -1.0,
    },
    {
        "id": "lm_08",
        "sweep_group": "motion_blur",
        "degradation_tier": "moderate",
        "scene_type": "med_box",
        "description": "Mild hand tremor (3px horizontal motion blur) METFORMIN 500 mg / EXP 2027-11",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 1.8,
        "shot_gain": 0.10,
        "flashlight_hotspot": False,
        "motion_blur_px": 3,
        "strength_readable": True,
        "expected_strength": "500 mg",
        "expected_level": "match",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.5,
    },
    {
        "id": "lm_09",
        "sweep_group": "motion_blur",
        "degradation_tier": "moderate",
        "scene_type": "med_box",
        "description": "Mild hand tremor (3px blur) AMLODIPINE 10 mg wrong-strength trap",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 1.8,
        "shot_gain": 0.10,
        "flashlight_hotspot": False,
        "motion_blur_px": 3,
        "strength_readable": True,
        "expected_strength": "10 mg",
        "expected_level": "warning",
        "accent": (24, 96, 152),
        "header": "NORDIC PHARMA",
        "title": "AMLODIPINE",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "10 mg",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-10",
        "tilt_deg": -1.7,
    },
    {
        "id": "lm_10",
        "sweep_group": "motion_blur",
        "degradation_tier": "severe",
        "scene_type": "med_box",
        "description": "Severe fast swipe (22px motion blur + omitted illegible strength) on AMLODIPINE",
        "luminance_pct": 92,
        "warm_tint": False,
        "iso_noise_sigma": 3.0,
        "shot_gain": 0.15,
        "flashlight_hotspot": False,
        "motion_blur_px": 22,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (24, 96, 152),
        "header": "NORDIC PHARMA",
        "title": "AMLODIPINE",
        "subtitle": "amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "",
        "expiry_line": "",
        "tilt_deg": -3.2,
    },
    {
        "id": "lm_11",
        "sweep_group": "motion_blur",
        "degradation_tier": "severe",
        "scene_type": "unidentifiable_pack",
        "description": "Severe fast swipe (24px motion blur) on unidentifiable package",
        "luminance_pct": 88,
        "warm_tint": False,
        "iso_noise_sigma": 4.0,
        "shot_gain": 0.20,
        "flashlight_hotspot": False,
        "motion_blur_px": 24,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "tilt_deg": 4.5,
    },
    {
        "id": "lm_12",
        "sweep_group": "motion_blur",
        "degradation_tier": "moderate",
        "scene_type": "food_pack",
        "description": "Mild tremor (3px blur) on safe Oat Drink / Ingredients: water, oats (10%), rapeseed oil, salt",
        "luminance_pct": 100,
        "warm_tint": False,
        "iso_noise_sigma": 1.8,
        "shot_gain": 0.10,
        "flashlight_hotspot": False,
        "motion_blur_px": 3,
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "info",
        "accent": (38, 108, 92),
        "header": "NORDIC DAIRY FREE",
        "title": "Oat Drink",
        "subtitle": "Plant-Based Drink  1 L",
        "ingredients_lines": [
            "Ingredients: water, oats (10%),",
            "rapeseed oil, salt.",
        ],
        "allergen_line": "Allergens: Contains oats.",
        "expiry_line": "Best before: 2027-12-03",
        "tilt_deg": 1.2,
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


def render_nightstand_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (220, 214, 204))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.63)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(234 - 22 * t), int(228 - 22 * t), int(218 - 20 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 17)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(176 - 26 * t) + jitter)),
            max(0, min(255, int(146 - 22 * t) + jitter)),
            max(0, min(255, int(116 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(132, 104, 78), width=2)
    return canvas


def render_med_box_base(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_nightstand_backdrop(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 72, pad + 132, pad + 696, pad + 628
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card = Image.new("RGB", (bw, bh), (252, 252, 254))
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 64), fill=case["accent"])
    cd.text(
        (28, 18),
        case["header"],
        fill=(248, 250, 252),
        font=ImageFont.load_default(size=24),
    )

    cd.text(
        (28, 86),
        case["title"],
        fill=(10, 14, 20),
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=(10, 14, 20),
    )
    cd.text(
        (28, 150),
        case["subtitle"],
        fill=(28, 34, 42),
        font=ImageFont.load_default(size=26),
    )

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 204, 276, 294
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=(240, 246, 252),
            outline=case["accent"],
            width=4,
        )
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
                font=ImageFont.load_default(size=26),
            )
    elif case["form_line"]:
        cd.text(
            (28, 218),
            case["form_line"],
            fill=(64, 72, 82),
            font=ImageFont.load_default(size=24),
        )

    if case["pack_line"]:
        cd.text(
            (28, 336),
            case["pack_line"],
            fill=(30, 36, 44),
            font=ImageFont.load_default(size=24),
        )

    if case["expiry_line"]:
        cd.rounded_rectangle(
            (bw - 258, 324, bw - 26, 382),
            radius=8,
            fill=(244, 246, 249),
            outline=(140, 148, 158),
            width=2,
        )
        cd.text(
            (bw - 240, 338),
            case["expiry_line"],
            fill=(10, 14, 20),
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=(10, 14, 20),
        )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(164, 170, 178, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_food_pack_base(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_nightstand_backdrop(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 92, pad + 96, pad + 676, pad + 672
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    carton = Image.new("RGB", (cw, ch), (250, 248, 242))
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 68), fill=case["accent"])
    cd.text(
        (28, 20),
        case["header"],
        fill=(248, 250, 248),
        font=ImageFont.load_default(size=24),
    )
    cd.text(
        (28, 92),
        case["title"],
        fill=(12, 18, 16),
        font=ImageFont.load_default(size=42),
        stroke_width=1,
        stroke_fill=(12, 18, 16),
    )
    cd.text(
        (28, 152),
        case["subtitle"],
        fill=(38, 48, 44),
        font=ImageFont.load_default(size=25),
    )

    cd.rounded_rectangle(
        (24, 204, cw - 24, 434),
        radius=12,
        fill=(254, 254, 252),
        outline=(168, 164, 154),
        width=2,
    )
    iy = 224
    for ln in case["ingredients_lines"]:
        cd.text(
            (40, iy),
            ln,
            fill=(12, 16, 16),
            font=ImageFont.load_default(size=26),
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
        (48, iy + 6),
        case["allergen_line"],
        fill=(14, 18, 18),
        font=ImageFont.load_default(size=24),
        stroke_width=1,
        stroke_fill=(14, 18, 18),
    )

    cd.rounded_rectangle(
        (24, 464, cw - 24, 526),
        radius=8,
        fill=(255, 255, 255),
        outline=(176, 172, 162),
        width=2,
    )
    cd.text(
        (40, 480),
        case["expiry_line"],
        fill=(14, 18, 20),
        font=ImageFont.load_default(size=26),
    )

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(164, 160, 150, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_dark_silhouette_base(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_nightstand_backdrop(size, seed)
    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 110, pad + 170, pad + 658, pad + 590
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1, y1),
        radius=16,
        fill=(182, 186, 192, 255),
        outline=(140, 144, 150, 255),
        width=2,
    )
    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_unidentifiable_pack_base(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_nightstand_backdrop(size, seed)
    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 130, pad + 150, pad + 640, pad + 606
    bw, bh = x1 - x0, y1 - y0

    card = Image.new("RGB", (bw, bh), (232, 234, 236))
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 44), fill=(116, 128, 142))
    rng = random.Random(seed + 91)
    for row_y in range(96, bh - 64, 28):
        seg_w = rng.randint(120, bw - 90)
        cd.rectangle((36, row_y, 36 + seg_w, row_y + 7), fill=(184, 188, 194))

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=14, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def apply_flashlight_hotspot(img: Image.Image) -> Image.Image:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx = w * 0.44
    cy = h * 0.56
    dist_sq = ((xx - cx) / 1.18) ** 2 + ((yy - cy) / 0.88) ** 2
    core = 460.0 * np.exp(-dist_sq / (2.0 * (128.0 ** 2)))
    halo = 135.0 * np.exp(-dist_sq / (2.0 * (235.0 ** 2)))
    flare = (core + halo)[:, :, None]
    out = np.clip(arr + flare, 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


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


def apply_lighting_and_sensor_noise(
    img: Image.Image,
    luminance_pct: float,
    warm_tint: bool,
    iso_noise_sigma: float,
    shot_gain: float,
    seed: int,
) -> Image.Image:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    scale = float(luminance_pct) / 100.0
    if warm_tint:
        channel_gains = np.array([1.03, 0.99, 0.92], dtype=np.float32) * scale
    else:
        channel_gains = np.array([scale, scale, scale], dtype=np.float32)
    lit = arr * channel_gains[None, None, :]

    if iso_noise_sigma > 0.0 or shot_gain > 0.0:
        h, w, c = lit.shape
        z_read = lcg_normal_grid(h, w, c, seed=seed * 13 + 7)
        z_shot = lcg_normal_grid(h, w, c, seed=seed * 29 + 19)
        shot_std = shot_gain * np.sqrt(np.maximum(lit, 1.0))
        lit = lit + shot_std * z_shot + iso_noise_sigma * z_read

    clipped = np.clip(np.round(lit), 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(clipped, mode="RGB")


def apply_horizontal_motion_blur(img: Image.Image, blur_px: int) -> Image.Image:
    k = int(blur_px)
    if k <= 1:
        return img.convert("RGB")
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    kernel = np.full(k, 1.0 / float(k), dtype=np.float32)
    pad_left = k // 2
    pad_right = k - 1 - pad_left
    padded = np.pad(arr, ((0, 0), (pad_left, pad_right), (0, 0)), mode="edge")
    h, w, c = arr.shape
    acc = np.zeros((h, w, c), dtype=np.float32)
    for offset in range(k):
        acc += padded[:, offset : offset + w, :] * kernel[offset]
    out = np.clip(np.round(acc), 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261114 + idx * 101
    scene_type = case["scene_type"]
    if scene_type == "med_box":
        img = render_med_box_base(case, seed)
    elif scene_type == "food_pack":
        img = render_food_pack_base(case, seed)
    elif scene_type == "dark_silhouette":
        img = render_dark_silhouette_base(case, seed)
    else:
        img = render_unidentifiable_pack_base(case, seed)

    if case["flashlight_hotspot"]:
        img = apply_flashlight_hotspot(img)

    if case["motion_blur_px"] > 0:
        img = apply_horizontal_motion_blur(img, case["motion_blur_px"])

    img = apply_lighting_and_sensor_noise(
        img=img,
        luminance_pct=case["luminance_pct"],
        warm_tint=case["warm_tint"],
        iso_noise_sigma=case["iso_noise_sigma"],
        shot_gain=case["shot_gain"],
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

        item_record = {
            "id": cid,
            "sweep_group": case["sweep_group"],
            "degradation_tier": case["degradation_tier"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "luminance_pct": case["luminance_pct"],
            "iso_noise_sigma": case["iso_noise_sigma"],
            "flashlight_hotspot": case["flashlight_hotspot"],
            "motion_blur_px": case["motion_blur_px"],
            "strength_readable": sr,
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": run["latency_ms"],
            "tokens_in": run["tokens_in"],
            "tokens_out": run["tokens_out"],
            "tokens_thinking": run["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_record)
        print(
            f"[{cid}] tier={case['degradation_tier']} exp={exp_level} pred={pred_level} "
            f"match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    moderate_items = [it for it in items_out if it["degradation_tier"] == "moderate"]
    moderate_degradation_recall = round(
        sum(
            1
            for it in moderate_items
            if it["verdict_match"] and (not it["strength_readable"] or bool(it["strength_correct"]))
        )
        / len(moderate_items),
        4,
    )

    severe_items = [it for it in items_out if it["degradation_tier"] == "severe"]
    severe_degradation_abstention_rate = round(
        sum(1 for it in severe_items if it["abstained"] and not it["confident_wrong_dose"])
        / len(severe_items),
        4,
    )

    readable_med_items = [it for it in items_out if it["strength_readable"]]
    clean_field_accuracy = round(
        sum(1 for it in readable_med_items if bool(it["strength_correct"])) / len(readable_med_items),
        4,
    )

    confident_wrong_dose_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "moderate_degradation_recall": moderate_degradation_recall,
        "severe_degradation_abstention_rate": severe_degradation_abstention_rate,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": severe_degradation_abstention_rate,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
        "mean_tokens_in": round(total_tokens_in / n_items, 1),
        "mean_tokens_out": round(total_tokens_out / n_items, 1),
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
    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
