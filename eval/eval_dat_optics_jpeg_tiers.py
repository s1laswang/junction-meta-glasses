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

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eval.validate_real_labels import GPS_EXIF_TAG, inspect_image, strip_exif_in_place

VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "dat_optics_jpeg_tiers"
OUT_JSON_PATH = REPO_ROOT / "eval" / "dat_optics_jpeg_tiers_results.json"

MODEL_NAME = "gemini-3.8-flash"
DAT_SDK_VERSION = "1.0.1"
PORTRAIT_WIDTH = 720
PORTRAIT_HEIGHT = 1280
RAW_PORTRAIT_JPEG_QUALITY = 90
BARREL_K1 = 0.082
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

RTT_TIERS: dict[str, dict[str, Any]] = {
    "tier_a_normal": {
        "rtt_rule": "RTT <= 250 ms",
        "max_dim_px": 768,
        "jpeg_quality": 80,
        "target_fps": 1.0,
    },
    "tier_b_moderate": {
        "rtt_rule": "250 ms < RTT <= 650 ms",
        "max_dim_px": 640,
        "jpeg_quality": 65,
        "target_fps": 0.75,
    },
    "tier_c_slow": {
        "rtt_rule": "RTT > 650 ms",
        "max_dim_px": 512,
        "jpeg_quality": 45,
        "target_fps": 0.5,
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "dat_01",
        "rtt_tier": "tier_a_normal",
        "simulated_rtt_ms": 118,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "med_box",
        "description": "DAT 720x1280 portrait barrel optics via Tier A normal (RTT 118 ms, max_dim 768, q=80): Amlodipin 5 mg evening dose match",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "dosing_line": "1 tablet in the evening",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -1.4,
    },
    {
        "id": "dat_02",
        "rtt_tier": "tier_a_normal",
        "simulated_rtt_ms": 184,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "med_box",
        "description": "DAT 720x1280 portrait barrel optics via Tier A normal (RTT 184 ms, max_dim 768, q=80): Burana 400 mg NSAID avoid warning",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "accent": (186, 34, 44),
        "header": "ORION PHARMA",
        "title": "Burana",
        "subtitle": "Active ingredient: ibuprofen",
        "strength_badge": "400 mg",
        "form_line": "tablets",
        "dosing_line": "1 tablet as needed for pain",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.5,
    },
    {
        "id": "dat_03",
        "rtt_tier": "tier_b_moderate",
        "simulated_rtt_ms": 435,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "med_box",
        "description": "DAT 720x1280 portrait barrel optics via Tier B moderate (RTT 435 ms, max_dim 640, q=65): Metformin 500 mg EXP 2025-01 expired warning",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "500 mg",
        "expected_level": "warning",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "dosing_line": "1 tablet twice daily with meals",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2025-01",
        "tilt_deg": -1.3,
    },
    {
        "id": "dat_04",
        "rtt_tier": "tier_b_moderate",
        "simulated_rtt_ms": 560,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "food_pack",
        "description": "DAT 720x1280 portrait barrel optics via Tier B moderate (RTT 560 ms, max_dim 640, q=65): Hazelnut Praline Bar tree-nut allergen warning",
        "strength_readable": None,
        "panel_readable": True,
        "has_profile_allergen": True,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (138, 72, 34),
        "header": "NORDIC CONFECTIONERY",
        "title": "Hazelnut Praline Bar",
        "subtitle": "Crispy Cocoa & Nut Bar  60 g",
        "ingredients_lines": [
            "Ingredients: oats, sugar,",
            "roasted hazelnuts (15%),",
            "cocoa butter, milk.",
        ],
        "allergen_lines": [
            "Allergens: Contains hazelnuts",
            "(tree nuts), milk, oats (gluten).",
        ],
        "expiry_line": "Best before: 2027-10-15",
        "tilt_deg": 1.2,
    },
    {
        "id": "dat_05",
        "rtt_tier": "tier_c_slow",
        "simulated_rtt_ms": 760,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "med_box",
        "description": "DAT 720x1280 portrait barrel optics via Tier C slow Wi-Fi (RTT 760 ms, max_dim 512, q=45): Amlodipin 5 mg evening dose match",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "dosing_line": "1 tablet in the evening",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -1.1,
    },
    {
        "id": "dat_06",
        "rtt_tier": "tier_c_slow",
        "simulated_rtt_ms": 845,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "med_box",
        "description": "DAT 720x1280 portrait barrel optics via Tier C slow Wi-Fi (RTT 845 ms, max_dim 512, q=45): Amlodipin 10 mg wrong-strength warning vs 5 mg profile",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "10 mg",
        "expected_level": "warning",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "10 mg",
        "form_line": "tablets",
        "dosing_line": "1 tablet once daily",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-10",
        "tilt_deg": 1.3,
    },
    {
        "id": "dat_07",
        "rtt_tier": "tier_c_slow",
        "simulated_rtt_ms": 910,
        "optics_mode": "portrait_barrel_clean",
        "scene_type": "food_pack",
        "description": "DAT 720x1280 portrait barrel optics via Tier C slow Wi-Fi (RTT 910 ms, max_dim 512, q=45): Plain Oat Drink safe info verdict",
        "strength_readable": None,
        "panel_readable": True,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "info",
        "accent": (36, 108, 92),
        "header": "NORDIC OAT MILL",
        "title": "Plain Oat Drink",
        "subtitle": "Plant-Based Oat Beverage  1 L",
        "ingredients_lines": [
            "Ingredients: water, oats (10%),",
            "rapeseed oil, sea salt.",
        ],
        "allergen_lines": [
            "Allergens: Contains oats (gluten).",
        ],
        "expiry_line": "Best before: 2027-12-10",
        "tilt_deg": -1.0,
    },
    {
        "id": "dat_08",
        "rtt_tier": "tier_a_normal",
        "simulated_rtt_ms": 145,
        "optics_mode": "portrait_edge_cutoff",
        "scene_type": "med_box",
        "description": "Severe DAT 9:16 portrait right-edge cutoff clipping strength badge outside 720x1280 FOV: Amlodipin safe abstention",
        "strength_readable": False,
        "panel_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "dosing_line": "1 tablet in the evening",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": 1.8,
    },
    {
        "id": "dat_09",
        "rtt_tier": "tier_c_slow",
        "simulated_rtt_ms": 890,
        "optics_mode": "far_arms_length_512px_q45",
        "scene_type": "med_box",
        "description": "Severe DAT far arm's-length framing + Tier C 512px q=45 DCT block collapse over strength badge: Metformin safe abstention",
        "strength_readable": False,
        "panel_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": None,
        "form_line": "tablets",
        "dosing_line": None,
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": -1.6,
    },
    {
        "id": "dat_10",
        "rtt_tier": "tier_b_moderate",
        "simulated_rtt_ms": 495,
        "optics_mode": "portrait_finger_occluded",
        "scene_type": "med_box",
        "description": "Severe DAT 720x1280 portrait first-person thumb occlusion covering strength badge: Panadol safe abstention",
        "strength_readable": False,
        "panel_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC",
        "title": "Panadol",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "dosing_line": "1 tablet as needed",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2028-02",
        "tilt_deg": 1.7,
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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, preferred: int, minimum: int = 18) -> Any:
    sz = preferred
    while sz > minimum:
        font = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=font) <= max_w:
            return font
        sz -= 1
    return ImageFont.load_default(size=minimum)


def render_portrait_backdrop(width: int, height: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (width, height), (218, 214, 206))
    draw = ImageDraw.Draw(canvas)
    rng = random.Random(seed + 17)
    horizon = int(height * 0.54)

    for y in range(horizon):
        t = y / max(1, horizon)
        j = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(234 - 22 * t) + j)),
            max(0, min(255, int(230 - 20 * t) + j)),
            max(0, min(255, int(222 - 18 * t) + j)),
        )
        draw.line((0, y, width, y), fill=c)

    for y in range(horizon, height):
        t = (y - horizon) / max(1, height - horizon)
        j = rng.randint(-4, 4)
        c = (
            max(0, min(255, int(186 - 30 * t) + j)),
            max(0, min(255, int(164 - 26 * t) + j)),
            max(0, min(255, int(138 - 22 * t) + j)),
        )
        draw.line((0, y, width, y), fill=c)
        if (y - horizon) % 19 == 0:
            knot_x = rng.randint(40, width - 120)
            draw.line((knot_x, y, knot_x + rng.randint(50, 110), y), fill=(152, 130, 106), width=1)

    draw.line((0, horizon, width, horizon), fill=(132, 114, 94), width=3)

    bokeh = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((int(width * 0.10), 60, int(width * 0.48), 310), fill=(255, 252, 242, 54))
    bd.ellipse((int(width * 0.56), 90, int(width * 0.90), 350), fill=(244, 249, 255, 46))
    bd.rectangle((int(width * 0.08), horizon - 150, int(width * 0.24), horizon - 8), fill=(192, 186, 178, 72))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=20.0))
    return Image.alpha_composite(canvas.convert("RGBA"), bokeh).convert("RGB")


def draw_subtle_lower_hand_grip(layer: Image.Image, box_x0: int, box_x1: int, box_y1: int, canvas_h: int) -> None:
    hd = ImageDraw.Draw(layer)
    cx = (box_x0 + box_x1) // 2
    hd.polygon(
        [
            (cx - 110, box_y1 - 8),
            (cx + 110, box_y1 - 8),
            (cx + 165, canvas_h),
            (cx - 165, canvas_h),
        ],
        fill=(214, 174, 148, 245),
    )
    hd.rounded_rectangle(
        (cx - 95, box_y1 - 18, cx - 26, box_y1 + 26),
        radius=16,
        fill=(222, 182, 156, 255),
        outline=(182, 140, 116, 255),
        width=2,
    )
    hd.rounded_rectangle(
        (cx + 26, box_y1 - 18, cx + 95, box_y1 + 26),
        radius=16,
        fill=(222, 182, 156, 255),
        outline=(182, 140, 116, 255),
        width=2,
    )


def draw_occluding_thumb_over_badge(
    card: Image.Image,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (0, sy0 - 18, sx1 + 42, sy1 + 28),
        radius=48,
        fill=(22, 16, 12, 125),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=9.0))
    overlay = Image.alpha_composite(overlay, shadow)

    td = ImageDraw.Draw(overlay)
    td.rounded_rectangle(
        (-28, sy0 - 24, sx1 + 34, sy1 + 22),
        radius=50,
        fill=(218, 176, 150, 255),
        outline=(176, 134, 108, 255),
        width=3,
    )
    nail_x0 = sx1 - 44
    nail_y0 = sy0 - 4
    nail_x1 = sx1 + 18
    nail_y1 = sy1 + 2
    td.rounded_rectangle(
        (nail_x0, nail_y0, nail_x1, nail_y1),
        radius=20,
        fill=(240, 214, 198, 255),
        outline=(194, 156, 134, 255),
        width=2,
    )
    knuckle_x = max(18, sx0 + 38)
    td.arc((knuckle_x, sy0 - 8, knuckle_x + 28, sy1 + 6), start=110, end=250, fill=(182, 138, 114, 220), width=3)
    td.arc((knuckle_x + 14, sy0 - 4, knuckle_x + 38, sy1 + 2), start=115, end=245, fill=(188, 146, 122, 190), width=2)
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def render_standard_med_card(case: dict[str, Any], bw: int, bh: int) -> tuple[Image.Image, tuple[int, int, int, int]]:
    card = Image.new("RGB", (bw, bh), (244, 246, 250))
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 74), fill=case["accent"])
    cd.text(
        (28, 22),
        case["header"],
        fill=(248, 250, 252),
        font=fit_font(cd, case["header"], bw - 56, 28),
    )

    cd.text(
        (28, 96),
        case["title"],
        fill=(10, 14, 20),
        font=fit_font(cd, case["title"], bw - 56, 58),
        stroke_width=1,
        stroke_fill=(10, 14, 20),
    )
    subtitle_max_w = 400 if case["optics_mode"] == "portrait_edge_cutoff" else bw - 56
    cd.text(
        (28, 174),
        case["subtitle"],
        fill=(22, 28, 36),
        font=fit_font(cd, case["subtitle"], subtitle_max_w, 30),
    )

    if case["optics_mode"] == "portrait_edge_cutoff":
        sx0, sy0, sx1, sy1 = 468, 234, 608, 338
    else:
        sx0, sy0, sx1, sy1 = 28, 234, 304, 338

    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=14,
        fill=(238, 245, 252),
        outline=case["accent"],
        width=5,
    )
    if case["strength_badge"]:
        badge_font = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 36, 58)
        cd.text(
            (sx0 + 22, sy0 + 20),
            case["strength_badge"],
            fill=(8, 12, 18),
            font=badge_font,
            stroke_width=1,
            stroke_fill=(8, 12, 18),
        )

    if case["form_line"] and case["optics_mode"] != "portrait_edge_cutoff":
        cd.text(
            (sx1 + 20, sy0 + 34),
            case["form_line"],
            fill=(24, 30, 38),
            font=fit_font(cd, case["form_line"], bw - sx1 - 36, 28),
        )
    elif case["form_line"]:
        cd.text(
            (28, 256),
            case["form_line"],
            fill=(24, 30, 38),
            font=fit_font(cd, case["form_line"], 360, 28),
        )

    if case.get("dosing_line"):
        max_dosing_w = 370 if case["optics_mode"] == "portrait_edge_cutoff" else bw - 56
        cd.text(
            (28, 372),
            case["dosing_line"],
            fill=(18, 24, 32),
            font=fit_font(cd, case["dosing_line"], max_dosing_w, 29),
        )

    if case.get("pack_line"):
        cd.text(
            (28, 430),
            case["pack_line"],
            fill=(28, 34, 42),
            font=fit_font(cd, case["pack_line"], 260, 28),
        )

    if case.get("expiry_line"):
        if case["optics_mode"] == "portrait_edge_cutoff":
            ex0, ey0, ex1, ey1 = 28, 486, 304, 558
        else:
            ex0, ey0, ex1, ey1 = bw - 304, 482, bw - 28, 556
        cd.rounded_rectangle(
            (ex0, ey0, ex1, ey1),
            radius=10,
            fill=(252, 253, 255),
            outline=(118, 128, 140),
            width=3,
        )
        cd.text(
            (ex0 + 18, ey0 + 18),
            case["expiry_line"],
            fill=(8, 12, 18),
            font=fit_font(cd, case["expiry_line"], (ex1 - ex0) - 32, 32),
            stroke_width=1,
            stroke_fill=(8, 12, 18),
        )

    if case["optics_mode"] == "portrait_finger_occluded":
        draw_occluding_thumb_over_badge(card, sx0, sy0, sx1, sy1)

    return card, (sx0, sy0, sx1, sy1)


def render_far_arms_length_med_card(case: dict[str, Any]) -> Image.Image:
    bw, bh = 236, 198
    card = Image.new("RGB", (bw, bh), (242, 245, 249))
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 28), fill=case["accent"])
    cd.text((10, 6), case["header"], fill=(246, 249, 252), font=ImageFont.load_default(size=14))
    cd.text(
        (10, 38),
        case["title"],
        fill=(10, 14, 20),
        font=fit_font(cd, case["title"], bw - 20, 28, minimum=16),
        stroke_width=1,
        stroke_fill=(10, 14, 20),
    )

    tiny_badge = Image.new("RGB", (76, 28), (236, 242, 248))
    td = ImageDraw.Draw(tiny_badge)
    td.rounded_rectangle((0, 0, 75, 27), radius=5, outline=case["accent"], width=2)
    td.rectangle((14, 11, 28, 17), fill=(154, 162, 172))
    td.rectangle((34, 12, 58, 16), fill=(164, 170, 178))
    tiny_badge = tiny_badge.filter(ImageFilter.GaussianBlur(radius=3.8))
    card.paste(tiny_badge, (10, 88))

    cd.text((10, 134), "tablets", fill=(48, 56, 66), font=ImageFont.load_default(size=15))
    return card


def render_food_card(case: dict[str, Any], cw: int, ch: int) -> Image.Image:
    carton = Image.new("RGB", (cw, ch), (242, 239, 232))
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 74), fill=case["accent"])
    cd.text(
        (26, 22),
        case["header"],
        fill=(248, 250, 248),
        font=fit_font(cd, case["header"], cw - 52, 27),
    )
    cd.text(
        (26, 94),
        case["title"],
        fill=(10, 16, 14),
        font=fit_font(cd, case["title"], cw - 52, 48),
        stroke_width=1,
        stroke_fill=(10, 16, 14),
    )
    cd.text(
        (26, 160),
        case["subtitle"],
        fill=(30, 40, 36),
        font=fit_font(cd, case["subtitle"], cw - 52, 28),
    )

    cd.rounded_rectangle(
        (22, 214, cw - 22, 540),
        radius=14,
        fill=(254, 254, 252),
        outline=(156, 152, 142),
        width=3,
    )
    iy = 234
    for ln in case["ingredients_lines"]:
        cd.text(
            (36, iy),
            ln,
            fill=(10, 14, 14),
            font=fit_font(cd, ln, cw - 76, 32),
            stroke_width=1,
            stroke_fill=(10, 14, 14),
        )
        iy += 46

    ay0 = max(iy + 12, 392)
    ay1 = ay0 + 26 + 44 * len(case["allergen_lines"])
    cd.rounded_rectangle(
        (34, ay0, cw - 34, ay1),
        radius=10,
        fill=(246, 243, 234),
        outline=(122, 110, 92),
        width=3,
    )
    ay = ay0 + 14
    for aln in case["allergen_lines"]:
        cd.text(
            (48, ay),
            aln,
            fill=(8, 12, 12),
            font=fit_font(cd, aln, cw - 98, 31),
            stroke_width=1,
            stroke_fill=(8, 12, 12),
        )
        ay += 42

    cd.rounded_rectangle(
        (22, 564, cw - 160, 636),
        radius=10,
        fill=(255, 255, 255),
        outline=(146, 142, 132),
        width=3,
    )
    cd.text(
        (38, 582),
        case["expiry_line"],
        fill=(10, 14, 16),
        font=fit_font(cd, case["expiry_line"], cw - 216, 31),
        stroke_width=1,
        stroke_fill=(10, 14, 16),
    )
    return carton


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


def apply_dat_barrel_optics(
    overscan_rgb: Image.Image,
    pad: int,
    barrel_k1: float,
    seed: int,
) -> Image.Image:
    arr = np.asarray(overscan_rgb, dtype=np.float32)
    oh, ow, _ = arr.shape
    cx = 0.5 * float(ow)
    cy = 0.5 * float(oh)
    half_diag = 0.5 * math.hypot(float(PORTRAIT_WIDTH), float(PORTRAIT_HEIGHT))

    yy, xx = np.mgrid[0:PORTRAIT_HEIGHT, 0:PORTRAIT_WIDTH].astype(np.float32)
    dx = (xx + float(pad)) - cx
    dy = (yy + float(pad)) - cy
    r2 = (dx * dx + dy * dy) / float(half_diag * half_diag)
    radial_scale = 1.0 + float(barrel_k1) * r2

    sx = np.clip(cx + dx * radial_scale, 0.0, float(ow - 1))
    sy = np.clip(cy + dy * radial_scale, 0.0, float(oh - 1))

    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    x1 = np.minimum(x0 + 1, ow - 1)
    y1 = np.minimum(y0 + 1, oh - 1)

    wx = (sx - x0)[:, :, None]
    wy = (sy - y0)[:, :, None]

    top = arr[y0, x0] * (1.0 - wx) + arr[y0, x1] * wx
    bot = arr[y1, x0] * (1.0 - wx) + arr[y1, x1] * wx
    sampled = top * (1.0 - wy) + bot * wy

    vignette = np.clip(1.0 - 0.10 * r2, 0.84, 1.0)[:, :, None]
    lit = sampled * vignette
    sensor_noise = lcg_normal_grid(PORTRAIT_HEIGHT, PORTRAIT_WIDTH, 3, seed=seed * 29 + 7) * 1.6
    out_u8 = np.clip(np.round(lit + sensor_noise), 0.0, 255.0).astype(np.uint8)
    img = Image.fromarray(out_u8, mode="RGB")
    assert img.size == (PORTRAIT_WIDTH, PORTRAIT_HEIGHT)
    return img


def render_dat_portrait_frame(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261149 + idx * 173
    pad = 72
    ow = PORTRAIT_WIDTH + 2 * pad
    oh = PORTRAIT_HEIGHT + 2 * pad

    bg = render_portrait_backdrop(ow, oh, seed)
    box_layer = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))

    mode = case["optics_mode"]
    if case["scene_type"] == "food_pack":
        cw, ch = 636, 668
        x0 = pad + (PORTRAIT_WIDTH - cw) // 2
        y0 = pad + 296
        card_img = render_food_card(case, cw, ch)
        draw_hand = True
    elif mode == "far_arms_length_512px_q45":
        card_img = render_far_arms_length_med_card(case)
        cw, ch = card_img.size
        x0 = pad + (PORTRAIT_WIDTH - cw) // 2
        y0 = pad + 548
        draw_hand = False
    elif mode == "portrait_edge_cutoff":
        cw, ch = 624, 588
        x0 = pad + 260
        y0 = pad + 336
        card_img, _ = render_standard_med_card(case, cw, ch)
        draw_hand = False
    else:
        cw, ch = 628, 588
        x0 = pad + (PORTRAIT_WIDTH - cw) // 2
        y0 = pad + 334
        card_img, _ = render_standard_med_card(case, cw, ch)
        draw_hand = True

    x1, y1 = x0 + cw, y0 + ch
    shadow = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 10, y0 + 14, x1 + 14, y1 + 18),
        radius=16,
        fill=(22, 18, 14, 92),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=11.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=14, fill=255)
    box_layer.paste(card_img, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=14,
        outline=(168, 176, 186, 255),
        width=3,
    )

    if draw_hand:
        draw_subtle_lower_hand_grip(box_layer, x0, x1, y1, oh)

    if mode == "portrait_edge_cutoff":
        rotated = box_layer
    else:
        rotated = box_layer.rotate(float(case["tilt_deg"]), resample=Image.Resampling.BICUBIC)

    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    portrait = apply_dat_barrel_optics(composed, pad=pad, barrel_k1=BARREL_K1, seed=seed)

    if mode == "portrait_edge_cutoff":
        assert portrait.size == (PORTRAIT_WIDTH, PORTRAIT_HEIGHT)

    return portrait


def inject_and_scrub_exif_then_transcode(
    portrait_img: Image.Image,
    case: dict[str, Any],
) -> dict[str, Any]:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    cid = case["id"]
    raw_portrait_path = OUT_IMG_DIR / f"{cid}_portrait_720x1280.jpg"
    tier_path = OUT_IMG_DIR / f"{cid}.jpg"

    exif = Image.Exif()
    exif[0x010F] = "Meta Wearables"
    exif[0x0110] = "Ray-Ban Meta Gen 2 DAT 1.0.1"
    exif[0x0112] = 1
    exif[0x0131] = f"mwdat-camera {DAT_SDK_VERSION}"
    exif[0x013B] = f"Synthetic Patient {cid}"
    exif[GPS_EXIF_TAG] = {
        1: "N",
        2: (60.0, 10.0, 15.0),
        3: "E",
        4: (24.0, 56.0, 12.0),
    }
    portrait_img.save(raw_portrait_path, format="JPEG", quality=RAW_PORTRAIT_JPEG_QUALITY, exif=exif.tobytes())

    before_info = inspect_image(raw_portrait_path)
    if not (
        before_info.get("valid")
        and before_info.get("width") == PORTRAIT_WIDTH
        and before_info.get("height") == PORTRAIT_HEIGHT
        and before_info.get("has_gps") is True
        and before_info.get("has_exif_pii") is True
    ):
        raise RuntimeError(f"Synthetic EXIF/GPS injection check failed for {cid}: {before_info}")

    strip_info = strip_exif_in_place(raw_portrait_path)
    if not strip_info.get("stripped"):
        raise RuntimeError(f"strip_exif_in_place did not strip EXIF for {cid}: {strip_info}")

    after_strip_info = inspect_image(raw_portrait_path)
    if after_strip_info.get("has_gps") or after_strip_info.get("has_exif_pii"):
        raise RuntimeError(f"EXIF/GPS remained on {raw_portrait_path} after strip_exif_in_place")

    with Image.open(raw_portrait_path) as clean_portrait:
        clean_rgb = Image.frombytes("RGB", clean_portrait.size, clean_portrait.convert("RGB").tobytes())

    q90_buf = io.BytesIO()
    clean_rgb.save(q90_buf, format="JPEG", quality=RAW_PORTRAIT_JPEG_QUALITY)
    q90_bytes = q90_buf.getvalue()
    raw_portrait_path.write_bytes(q90_bytes)
    portrait_q90_len = len(q90_bytes)

    verified_portrait_info = inspect_image(raw_portrait_path)
    if verified_portrait_info.get("has_gps") or verified_portrait_info.get("has_exif_pii"):
        raise RuntimeError(f"EXIF/GPS leaked in clean q90 portrait frame for {cid}")

    tier_cfg = RTT_TIERS[case["rtt_tier"]]
    max_dim = int(tier_cfg["max_dim_px"])
    jpeg_quality = int(tier_cfg["jpeg_quality"])
    scale = min(1.0, float(max_dim) / float(max(PORTRAIT_WIDTH, PORTRAIT_HEIGHT)))
    tier_w = max(1, round(PORTRAIT_WIDTH * scale))
    tier_h = max(1, round(PORTRAIT_HEIGHT * scale))

    resized = clean_rgb.resize((tier_w, tier_h), Image.Resampling.LANCZOS)
    tier_buf = io.BytesIO()
    resized.save(tier_buf, format="JPEG", quality=jpeg_quality)
    tier_bytes = tier_buf.getvalue()
    tier_path.write_bytes(tier_bytes)

    tier_info = inspect_image(tier_path)
    exif_leaked = bool(
        not tier_info.get("valid")
        or tier_info.get("has_gps")
        or tier_info.get("has_exif_pii")
        or verified_portrait_info.get("has_gps")
        or verified_portrait_info.get("has_exif_pii")
    )
    if exif_leaked:
        raise RuntimeError(f"EXIF leak detected before upload on {cid}: {tier_info}")

    return {
        "raw_portrait_path": str(raw_portrait_path.relative_to(REPO_ROOT)),
        "image_path": str(tier_path.relative_to(REPO_ROOT)),
        "portrait_720x1280_bytes": portrait_q90_len,
        "max_dim_px": max_dim,
        "jpeg_quality": jpeg_quality,
        "width": tier_w,
        "height": tier_h,
        "image_bytes": len(tier_bytes),
        "b64_jpeg": base64.b64encode(tier_bytes).decode("ascii"),
        "exif_injected_gps": bool(before_info["has_gps"]),
        "exif_injected_pii": bool(before_info["has_exif_pii"]),
        "exif_stripped": bool(strip_info["stripped"]),
        "exif_leaked": exif_leaked,
    }


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
        "/home/silas/tools/node/bin",
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
        portrait_img = render_dat_portrait_frame(case, idx)
        transcoded = inject_and_scrub_exif_then_transcode(portrait_img, case)
        raw_json, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=transcoded["b64_jpeg"],
        )
        raw_runs.append(
            {
                "case": case,
                "transcoded": transcoded,
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
        tr = run["transcoded"]
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
        sr = case["strength_readable"]

        if sr is True:
            strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        elif sr is False:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or s_conf >= STRENGTH_MIN_CONF
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = pred_level == "unsure"
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False

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

        portrait_bytes = int(tr["portrait_720x1280_bytes"])
        tier_bytes = int(tr["image_bytes"])
        tier_reduction_pct = round((1.0 - (tier_bytes / float(portrait_bytes))) * 100.0, 1)

        item_record = {
            "id": cid,
            "rtt_tier": case["rtt_tier"],
            "simulated_rtt_ms": case["simulated_rtt_ms"],
            "optics_mode": case["optics_mode"],
            "scene_type": case["scene_type"],
            "description": sanitize_obj(case["description"]),
            "raw_portrait_path": tr["raw_portrait_path"],
            "image_path": tr["image_path"],
            "source_width": PORTRAIT_WIDTH,
            "source_height": PORTRAIT_HEIGHT,
            "portrait_720x1280_bytes": portrait_bytes,
            "max_dim_px": tr["max_dim_px"],
            "jpeg_quality": tr["jpeg_quality"],
            "width": tr["width"],
            "height": tr["height"],
            "image_bytes": tier_bytes,
            "tier_bytes": tier_bytes,
            "tier_byte_reduction_pct": tier_reduction_pct,
            "barrel_k1": BARREL_K1,
            "exif_injected_gps": tr["exif_injected_gps"],
            "exif_injected_pii": tr["exif_injected_pii"],
            "exif_stripped": tr["exif_stripped"],
            "exif_leaked": tr["exif_leaked"],
            "strength_readable": sr,
            "panel_readable": bool(case["panel_readable"]),
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
            f"[{cid}] tier={case['rtt_tier']} ({tr['width']}x{tr['height']} q={tr['jpeg_quality']}) "
            f"bytes={portrait_bytes}->{tier_bytes} (-{tier_reduction_pct:.1f}%) "
            f"exif_leaked={tr['exif_leaked']} exp={exp_level} pred={pred_level} "
            f"match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    readable_items = [it for it in items_out if it["panel_readable"]]
    severe_items = [it for it in items_out if it["strength_readable"] is False]
    tier_a_items = [it for it in items_out if it["rtt_tier"] == "tier_a_normal"]
    tier_b_items = [it for it in items_out if it["rtt_tier"] == "tier_b_moderate"]
    tier_c_items = [it for it in items_out if it["rtt_tier"] == "tier_c_slow"]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    clean_field_hits = sum(
        1
        for it in readable_items
        if it["verdict_match"]
        and (it["strength_readable"] is not True or bool(it["strength_correct"]))
        and not it["false_safe_allergen"]
    )
    clean_field_accuracy = round(clean_field_hits / len(readable_items), 4)

    occluded_abstention_hits = sum(
        1
        for it in severe_items
        if it["abstained"] and it["predicted_level"] == "unsure" and not it["confident_wrong_dose"]
    )
    occluded_abstention_rate = round(occluded_abstention_hits / len(severe_items), 4)

    exif_scrubbed_ok = sum(
        1
        for it in items_out
        if it["exif_injected_gps"]
        and it["exif_injected_pii"]
        and it["exif_stripped"]
        and (it["exif_leaked"] is False)
    )
    exif_scrub_pass_rate = round(exif_scrubbed_ok / n_items, 4)
    exif_leak_count = sum(1 for it in items_out if it["exif_leaked"])

    confident_wrong_dose_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    false_safe_allergen_count = sum(1 for it in items_out if it["false_safe_allergen"])

    mean_portrait_bytes = round(statistics.mean(it["portrait_720x1280_bytes"] for it in items_out), 1)
    mean_tier_a_bytes = round(statistics.mean(it["tier_bytes"] for it in tier_a_items), 1)
    mean_tier_b_bytes = round(statistics.mean(it["tier_bytes"] for it in tier_b_items), 1)
    mean_slow_bytes = round(statistics.mean(it["tier_bytes"] for it in tier_c_items), 1)
    slow_tier_byte_reduction_pct = round(
        (1.0 - (mean_slow_bytes / mean_portrait_bytes)) * 100.0,
        1,
    )

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "strength_min_conf": STRENGTH_MIN_CONF,
        "dat_sdk_version": DAT_SDK_VERSION,
        "source_resolution": f"{PORTRAIT_WIDTH}x{PORTRAIT_HEIGHT}",
        "barrel_distortion_k1": BARREL_K1,
        "n_items": n_items,
        "n_readable_tier_cases": len(readable_items),
        "n_severe_abstention_cases": len(severe_items),
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "tier_a_normal_768px_q80_accuracy": round(
            sum(1 for it in tier_a_items if it["verdict_match"]) / len(tier_a_items), 4
        ),
        "tier_b_moderate_640px_q65_accuracy": round(
            sum(1 for it in tier_b_items if it["verdict_match"]) / len(tier_b_items), 4
        ),
        "tier_c_slow_512px_q45_accuracy": round(
            sum(1 for it in tier_c_items if it["verdict_match"]) / len(tier_c_items), 4
        ),
        "exif_injected_count": n_items,
        "exif_scrubbed_count": exif_scrubbed_ok,
        "exif_leak_count": exif_leak_count,
        "exif_scrub_pass_rate": exif_scrub_pass_rate,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "false_safe_allergen_count": false_safe_allergen_count,
        "mean_portrait_720x1280_bytes": mean_portrait_bytes,
        "mean_tier_a_768px_q80_bytes": mean_tier_a_bytes,
        "mean_tier_b_640px_q65_bytes": mean_tier_b_bytes,
        "mean_slow_512px_q45_bytes": mean_slow_bytes,
        "slow_tier_byte_reduction_pct": slow_tier_byte_reduction_pct,
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
            "rtt_tiers": RTT_TIERS,
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_artifact(report)
    if confident_wrong_dose_count != 0:
        raise AssertionError(f"Expected confident_wrong_dose_count == 0, got {confident_wrong_dose_count}")
    if false_safe_allergen_count != 0:
        raise AssertionError(f"Expected false_safe_allergen_count == 0, got {false_safe_allergen_count}")
    if exif_scrub_pass_rate != 1.0 or exif_leak_count != 0:
        raise AssertionError(f"Expected 100% EXIF scrub pass rate, got {exif_scrub_pass_rate}")

    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
