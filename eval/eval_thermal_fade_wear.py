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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "thermal_fade_wear"
OUT_JSON_PATH = REPO_ROOT / "eval" / "thermal_fade_wear_results.json"

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
        "id": "tw_01",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "description": "Moderate wear (58% thermal fade, corner scuffs, logo crease, droplets): Amlodipin 5 mg evening dose match",
        "thermal_fade_pct": 58,
        "carton_fade_pct": 22,
        "water_droplets": 5,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 150),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "Amlodipin 5 mg: 1 tablet in the evening.",
            "Dispensed 2026-06  EXP 2027-09",
        ],
        "tilt_deg": -1.6,
        "sticker_tilt_deg": 1.3,
    },
    {
        "id": "tw_02",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "description": "Moderate wear (61% thermal fade, corner scuffs, logo crease, droplets): Burana 400 mg NSAID avoid warning",
        "thermal_fade_pct": 61,
        "carton_fade_pct": 24,
        "water_droplets": 5,
        "corner_scuff": True,
        "logo_crease": True,
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
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "Burana 400 mg: 1 tablet as needed for pain.",
            "Max 3 tablets daily  EXP 2027-11",
        ],
        "tilt_deg": 1.8,
        "sticker_tilt_deg": -1.4,
    },
    {
        "id": "tw_03",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "description": "Moderate wear (56% thermal fade, corner scuffs, logo crease, droplets): Metformin 500 mg EXP 2025-01 expired warning",
        "thermal_fade_pct": 56,
        "carton_fade_pct": 20,
        "water_droplets": 4,
        "corner_scuff": True,
        "logo_crease": True,
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
        "expiry_line": "EXP 2025-01",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "Metformin 500 mg: 1 tablet twice daily.",
            "Take with meals  EXP 2025-01",
        ],
        "tilt_deg": -1.4,
        "sticker_tilt_deg": 1.1,
    },
    {
        "id": "tw_04",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "food_pack",
        "description": "Moderate wear (62% thermal fade, corner scuffs, logo crease, droplets): Hazelnut Praline Wafers tree-nut allergen warning",
        "thermal_fade_pct": 62,
        "carton_fade_pct": 22,
        "water_droplets": 5,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
        "has_profile_allergen": True,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (136, 72, 34),
        "header": "NORDIC CONFECTIONERY",
        "title": "Hazelnut Praline Wafers",
        "subtitle": "Crispy Filled Wafer Biscuits  200 g",
        "ingredients_lines": [
            "Ingredients: wheat flour, sugar,",
            "roasted hazelnuts (14%), cocoa, milk.",
        ],
        "allergen_line": "Allergens: Contains hazelnuts (tree nuts), wheat, milk.",
        "sticker_header": "BAKERY THERMAL BATCH LABEL",
        "sticker_lines": [
            "Lot 4419  Store in a dry place",
            "Best before: 2027-10-15",
        ],
        "tilt_deg": 1.5,
        "sticker_tilt_deg": -1.2,
    },
    {
        "id": "tw_05",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "food_pack",
        "description": "Moderate wear (59% thermal fade, corner scuffs, logo crease, droplets): Plain Oat Drink safe info verdict",
        "thermal_fade_pct": 59,
        "carton_fade_pct": 21,
        "water_droplets": 5,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
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
        "allergen_line": "Allergens: Contains oats (gluten).",
        "sticker_header": "PANTRY THERMAL DATE LABEL",
        "sticker_lines": [
            "Unopened pantry carton  Batch 812",
            "Best before: 2027-12-10",
        ],
        "tilt_deg": -1.3,
        "sticker_tilt_deg": 1.0,
    },
    {
        "id": "tw_06",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "description": "Moderate wear (64% thermal fade, corner scuffs, logo crease, droplets): Amlodipin 10 mg wrong-dose warning vs 5 mg profile",
        "thermal_fade_pct": 64,
        "carton_fade_pct": 24,
        "water_droplets": 5,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": True,
        "has_profile_allergen": False,
        "expected_strength": "10 mg",
        "expected_level": "warning",
        "accent": (22, 98, 150),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "10 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-10",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "Amlodipin 10 mg: 1 tablet once daily.",
            "Dispensed 2026-07  EXP 2027-10",
        ],
        "tilt_deg": 1.7,
        "sticker_tilt_deg": -1.5,
    },
    {
        "id": "tw_07",
        "wear_tier": "severe",
        "wear_mode": "thermal_bleach_95pct",
        "scene_type": "med_box",
        "description": "Severe wear: 95% sun-bleached thermal washout patch directly over Amlodipin strength digits",
        "thermal_fade_pct": 95,
        "carton_fade_pct": 28,
        "water_droplets": 3,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (22, 98, 150),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "1 tablet once daily in the evening.",
            "Blood pressure medication  EXP 2027-09",
        ],
        "tilt_deg": -2.0,
        "sticker_tilt_deg": 1.6,
    },
    {
        "id": "tw_08",
        "wear_tier": "severe",
        "wear_mode": "wet_ink_smear",
        "scene_type": "med_box",
        "description": "Severe wear: wet-hand bathroom moisture ink smear obliterating 5 vs 10 mg on Amlodipin",
        "thermal_fade_pct": 60,
        "carton_fade_pct": 25,
        "water_droplets": 8,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (22, 98, 150),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-10",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "Take 1 tablet in the evening.",
            "Keep dry  EXP 2027-10",
        ],
        "tilt_deg": 2.1,
        "sticker_tilt_deg": -1.3,
    },
    {
        "id": "tw_09",
        "wear_tier": "severe",
        "wear_mode": "torn_pharmacy_sticker",
        "scene_type": "med_box",
        "description": "Severe wear: torn pharmacy sticker ripping paperboard layer directly off Metformin dosage number",
        "thermal_fade_pct": 58,
        "carton_fade_pct": 24,
        "water_droplets": 3,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 88, 162),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "1 tablet morning and evening with meals.",
            "Dispensed pharmacy pack  EXP 2027-11",
        ],
        "tilt_deg": -1.9,
        "sticker_tilt_deg": 1.8,
    },
    {
        "id": "tw_10",
        "wear_tier": "severe",
        "wear_mode": "heavy_crease_scratch",
        "scene_type": "med_box",
        "description": "Severe wear: heavy handbag crease and key abrasion scratches obliterating mg digits on Panadol",
        "thermal_fade_pct": 62,
        "carton_fade_pct": 28,
        "water_droplets": 4,
        "corner_scuff": True,
        "logo_crease": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC",
        "title": "Panadol",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2028-02",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "1 tablet as needed for pain or fever.",
            "Do not exceed stated dose  EXP 2028-02",
        ],
        "tilt_deg": 2.2,
        "sticker_tilt_deg": -1.7,
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


def blend_rgb(fg: tuple[int, int, int], bg: tuple[int, int, int], fade_frac: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, fade_frac))
    return (
        int(round(fg[0] * (1.0 - t) + bg[0] * t)),
        int(round(fg[1] * (1.0 - t) + bg[1] * t)),
        int(round(fg[2] * (1.0 - t) + bg[2] * t)),
    )


def render_counter_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (214, 210, 202))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.58)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(228 - 18 * t), int(224 - 18 * t), int(216 - 16 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 31)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(192 - 24 * t) + jitter)),
            max(0, min(255, int(178 - 22 * t) + jitter)),
            max(0, min(255, int(162 - 20 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(148, 136, 122), width=2)
    return canvas


def draw_scuffed_corners(card: Image.Image, rng: random.Random) -> None:
    cw, ch = card.size
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    corners = [
        (0, 0, 1, 1),
        (cw, 0, -1, 1),
        (0, ch, 1, -1),
        (cw, ch, -1, -1),
    ]
    for cx, cy, dx, dy in corners:
        r_w = rng.randint(32, 52)
        r_h = rng.randint(28, 46)
        pts = [
            (cx, cy),
            (cx + dx * r_w, cy),
            (cx + dx * int(r_w * 0.68), cy + dy * int(r_h * 0.52)),
            (cx, cy + dy * r_h),
        ]
        od.polygon(pts, fill=(196, 188, 174, 225))
        for _ in range(7):
            sx0 = cx + dx * rng.randint(3, r_w)
            sy0 = cy + dy * rng.randint(3, r_h)
            sx1 = sx0 + dx * rng.randint(8, 22)
            sy1 = sy0 + dy * rng.randint(4, 14)
            od.line((sx0, sy0, sx1, sy1), fill=(166, 156, 140, 190), width=2)
    blurred = overlay.filter(ImageFilter.GaussianBlur(radius=0.8))
    card.paste(Image.alpha_composite(card.convert("RGBA"), blurred).convert("RGB"))


def draw_diagonal_logo_crease(card: Image.Image, rng: random.Random) -> None:
    cw, ch = card.size
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    x_start = rng.randint(18, 54)
    y_start = rng.randint(68, 92)
    x_end = rng.randint(230, 310)
    y_end = rng.randint(4, 22)
    steps = 18
    pts_shadow: list[tuple[int, int]] = []
    pts_light: list[tuple[int, int]] = []
    for i in range(steps + 1):
        t = i / steps
        jitter = rng.randint(-2, 2) if 0 < i < steps else 0
        px = int(round(x_start * (1.0 - t) + x_end * t))
        py = int(round(y_start * (1.0 - t) + y_end * t)) + jitter
        pts_shadow.append((px, py))
        pts_light.append((px, py + 3))
    od.line(pts_shadow, fill=(78, 74, 68, 125), width=2)
    od.line(pts_light, fill=(252, 250, 244, 185), width=3)
    soft = overlay.filter(ImageFilter.GaussianBlur(radius=0.6))
    card.paste(Image.alpha_composite(card.convert("RGBA"), soft).convert("RGB"))


def draw_water_droplets(
    card: Image.Image,
    count: int,
    safe_zones: list[tuple[int, int, int, int]],
    rng: random.Random,
) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for i in range(count):
        zx0, zy0, zx1, zy1 = safe_zones[i % len(safe_zones)]
        if zx1 - zx0 < 20 or zy1 - zy0 < 20:
            continue
        cx = rng.randint(zx0 + 10, zx1 - 10)
        cy = rng.randint(zy0 + 10, zy1 - 10)
        rx = rng.randint(7, 13)
        ry = rng.randint(6, 11)
        od.ellipse(
            (cx - rx - 1, cy - ry + 1, cx + rx + 1, cy + ry + 2),
            fill=(145, 154, 162, 55),
            outline=(118, 128, 138, 95),
            width=1,
        )
        od.ellipse(
            (cx - rx + 2, cy - ry + 2, cx + rx - 2, cy + ry - 1),
            fill=(236, 242, 248, 70),
        )
        od.ellipse(
            (cx - rx + 3, cy - ry + 3, cx - rx + 7, cy - ry + 6),
            fill=(255, 255, 255, 185),
        )
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def render_thermal_sticker(
    width: int,
    height: int,
    header_text: str,
    lines: list[str],
    fade_pct: float,
    seed: int,
) -> Image.Image:
    paper_bg = (244, 239, 226)
    sticker = Image.new("RGB", (width, height), paper_bg)
    arr = np.asarray(sticker, dtype=np.float32)
    rng = random.Random(seed + 71)
    xs = np.linspace(0.0, 1.0, width, dtype=np.float32)
    sun_grad = (6.0 * xs)[None, :, None]
    grain = np.zeros((height, width, 1), dtype=np.float32)
    for row in range(height):
        streak = rng.uniform(-2.5, 2.5)
        grain[row, :, 0] = streak
    arr = np.clip(arr + sun_grad + grain, 0.0, 255.0).astype(np.uint8)
    sticker = Image.fromarray(arr, mode="RGB")

    sd = ImageDraw.Draw(sticker)
    fade_frac = max(0.0, min(0.96, float(fade_pct) / 100.0))
    header_ink = blend_rgb((24, 28, 34), paper_bg, min(0.92, fade_frac * 0.95))
    body_ink = blend_rgb((16, 20, 26), paper_bg, fade_frac)
    rule_ink = blend_rgb((96, 98, 102), paper_bg, fade_frac)

    sd.rounded_rectangle(
        (1, 1, width - 2, height - 2),
        radius=8,
        outline=blend_rgb((156, 150, 136), paper_bg, fade_frac * 0.5),
        width=2,
    )
    sd.text((16, 8), header_text, fill=header_ink, font=ImageFont.load_default(size=17))
    sd.line((14, 30, width - 14, 30), fill=rule_ink, width=1)

    ty = 36
    for ln in lines:
        sd.text((16, ty), ln, fill=body_ink, font=ImageFont.load_default(size=20))
        ty += 26

    return sticker


def apply_severe_dosage_damage(
    card: Image.Image,
    wear_mode: str,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    accent: tuple[int, int, int],
    seed: int,
) -> None:
    rng = random.Random(seed + 211)
    cd = ImageDraw.Draw(card)

    if wear_mode == "thermal_bleach_95pct":
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=10,
            fill=(247, 243, 231),
            outline=blend_rgb(accent, (247, 243, 231), 0.86),
            width=2,
        )
        arr = np.asarray(card, dtype=np.float32)
        h, w, _ = arr.shape
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        cx = 0.5 * (sx0 + sx1)
        cy = 0.5 * (sy0 + sy1)
        dist = ((xx - cx) / 155.0) ** 2 + ((yy - cy) / 68.0) ** 2
        bleach_mask = np.exp(-dist * 1.35)[:, :, None]
        target = np.array([250.0, 247.0, 237.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.96 * bleach_mask) + target * (0.96 * bleach_mask)
        card.paste(Image.fromarray(np.clip(arr, 0.0, 255.0).astype(np.uint8), mode="RGB"))
        return

    if wear_mode == "wet_ink_smear":
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=(236, 241, 247),
            outline=accent,
            width=3,
        )
        cd.text(
            (sx0 + 148, sy0 + 20),
            "mg",
            fill=(26, 34, 48),
            font=ImageFont.load_default(size=44),
        )
        smear = Image.new("RGBA", card.size, (0, 0, 0, 0))
        smd = ImageDraw.Draw(smear)
        smd.ellipse(
            (sx0 - 10, sy0 - 8, sx0 + 168, sy1 + 14),
            fill=(164, 178, 198, 125),
        )
        for _ in range(28):
            bx = rng.randint(sx0 + 8, sx0 + 132)
            by = rng.randint(sy0 + 10, sy1 - 14)
            rx = rng.randint(14, 34)
            ry = rng.randint(9, 20)
            smd.ellipse(
                (bx - rx, by - ry, bx + rx, by + ry),
                fill=(18, 30, 52, rng.randint(175, 245)),
            )
        for _ in range(16):
            lx0 = rng.randint(sx0 + 6, sx0 + 95)
            ly0 = rng.randint(sy0 + 14, sy1 - 14)
            lx1 = lx0 + rng.randint(36, 78)
            ly1 = ly0 + rng.randint(-10, 12)
            smd.line((lx0, ly0, lx1, ly1), fill=(24, 38, 64, 220), width=rng.randint(6, 12))
        smear = smear.filter(ImageFilter.GaussianBlur(radius=3.4))
        ring = ImageDraw.Draw(smear)
        ring.ellipse(
            (sx0 - 14, sy0 - 12, sx0 + 176, sy1 + 18),
            outline=(112, 128, 150, 120),
            width=2,
        )
        card.paste(Image.alpha_composite(card.convert("RGBA"), smear).convert("RGB"))
        return

    if wear_mode == "torn_pharmacy_sticker":
        tear = Image.new("RGBA", card.size, (0, 0, 0, 0))
        td = ImageDraw.Draw(tear)
        outer_pts: list[tuple[int, int]] = []
        inner_pts: list[tuple[int, int]] = []
        top_x = list(range(sx0 - 12, sx1 + 18, 16))
        for x in top_x:
            outer_pts.append((x, sy0 - 10 + rng.randint(-5, 6)))
            inner_pts.append((x, sy0 - 3 + rng.randint(-4, 5)))
        bot_x = list(reversed(top_x))
        for x in bot_x:
            outer_pts.append((x, sy1 + 16 + rng.randint(-6, 6)))
            inner_pts.append((x, sy1 + 8 + rng.randint(-5, 5)))
        td.polygon(outer_pts, fill=(242, 240, 234, 255))
        td.polygon(inner_pts, fill=(178, 164, 142, 255))
        for _ in range(95):
            fx = rng.randint(sx0 - 4, sx1 + 8)
            fy = rng.randint(sy0, sy1 + 4)
            fl = rng.randint(6, 18)
            td.line(
                (fx, fy, fx + fl, fy + rng.randint(-3, 3)),
                fill=(152, 138, 118, 195),
                width=rng.randint(1, 2),
            )
        card.paste(Image.alpha_composite(card.convert("RGBA"), tear).convert("RGB"))
        return

    if wear_mode == "heavy_crease_scratch":
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=(232, 234, 236),
            outline=(152, 158, 166),
            width=2,
        )
        gouge = Image.new("RGBA", card.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(gouge)
        gd.polygon(
            [
                (sx0 - 8, sy0 + 4),
                (sx1 + 14, sy0 - 4),
                (sx1 + 8, sy1 + 6),
                (sx0 - 12, sy1 + 2),
            ],
            fill=(188, 184, 176, 252),
        )
        for _ in range(42):
            gx0 = rng.randint(sx0 - 10, sx1 - 48)
            gy0 = rng.randint(sy0 - 2, sy1 + 2)
            gx1 = min(sx1 + 12, gx0 + rng.randint(28, 84))
            gy1 = gy0 + rng.randint(-18, 18)
            col = (238, 236, 230, 235) if rng.random() < 0.55 else (126, 122, 114, 210)
            gd.line((gx0, gy0, gx1, gy1), fill=col, width=rng.randint(3, 6))
        gd.line((sx0 - 24, sy0 + 44, sx1 + 16, sy0 + 26), fill=(86, 82, 76, 215), width=4)
        gd.line((sx0 - 24, sy0 + 48, sx1 + 16, sy0 + 30), fill=(250, 248, 242, 225), width=3)
        card.paste(Image.alpha_composite(card.convert("RGBA"), gouge).convert("RGB"))


def paste_tilted_sticker(
    card: Image.Image,
    sticker: Image.Image,
    dest_xy: tuple[int, int],
    tilt_deg: float,
) -> None:
    sw, sh = sticker.size
    rgba = sticker.convert("RGBA")
    shadow = Image.new("RGBA", (sw + 16, sh + 16), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (8, 9, sw + 8, sh + 9),
        radius=8,
        fill=(30, 26, 22, 65),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=3.0))
    shadow.paste(rgba, (6, 6), rgba)
    rot = shadow.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
    base_rgba = card.convert("RGBA")
    base_rgba.alpha_composite(rot, dest=(dest_xy[0] - 6, dest_xy[1] - 6))
    card.paste(base_rgba.convert("RGB"))


def render_med_box_case(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(size, seed)
    rng = random.Random(seed + 13)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 104, pad + 700, pad + 664
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 92),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card_bg = (250, 249, 246)
    card = Image.new("RGB", (bw, bh), card_bg)
    cd = ImageDraw.Draw(card)
    cfade = float(case["carton_fade_pct"]) / 100.0

    header_col = blend_rgb(case["accent"], card_bg, cfade * 0.65)
    cd.rectangle((0, 0, bw, 62), fill=header_col)
    cd.text(
        (28, 18),
        case["header"],
        fill=(248, 249, 250),
        font=ImageFont.load_default(size=23),
    )

    title_ink = blend_rgb((12, 16, 22), card_bg, cfade)
    sub_ink = blend_rgb((32, 38, 46), card_bg, cfade)
    cd.text(
        (28, 82),
        case["title"],
        fill=title_ink,
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=title_ink,
    )
    cd.text(
        (28, 146),
        case["subtitle"],
        fill=sub_ink,
        font=ImageFont.load_default(size=25),
    )

    sx0, sy0, sx1, sy1 = 28, 198, 272, 286
    if case["strength_badge"]:
        badge_bg = (240, 245, 250)
        badge_ink = blend_rgb((10, 14, 20), badge_bg, cfade)
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=badge_bg,
            outline=blend_rgb(case["accent"], badge_bg, cfade * 0.7),
            width=3,
        )
        cd.text(
            (sx0 + 22, sy0 + 17),
            case["strength_badge"],
            fill=badge_ink,
            font=ImageFont.load_default(size=46),
            stroke_width=1,
            stroke_fill=badge_ink,
        )
        if case["form_line"]:
            cd.text(
                (sx1 + 20, sy0 + 28),
                case["form_line"],
                fill=sub_ink,
                font=ImageFont.load_default(size=25),
            )
    else:
        if case["form_line"]:
            cd.text(
                (sx1 + 36, sy0 + 28),
                case["form_line"],
                fill=sub_ink,
                font=ImageFont.load_default(size=25),
            )
        apply_severe_dosage_damage(
            card=card,
            wear_mode=case["wear_mode"],
            sx0=sx0,
            sy0=sy0,
            sx1=sx1,
            sy1=sy1,
            accent=case["accent"],
            seed=seed,
        )

    if case["pack_line"]:
        cd.text(
            (28, 318),
            case["pack_line"],
            fill=sub_ink,
            font=ImageFont.load_default(size=24),
        )

    if case["expiry_line"]:
        exp_bg = (244, 245, 247)
        exp_ink = blend_rgb((12, 16, 22), exp_bg, cfade * 0.85)
        cd.rounded_rectangle(
            (bw - 262, 306, bw - 26, 364),
            radius=8,
            fill=exp_bg,
            outline=blend_rgb((128, 136, 146), exp_bg, cfade),
            width=2,
        )
        cd.text(
            (bw - 242, 320),
            case["expiry_line"],
            fill=exp_ink,
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=exp_ink,
        )

    sticker = render_thermal_sticker(
        width=bw - 64,
        height=106,
        header_text=case["sticker_header"],
        lines=case["sticker_lines"],
        fade_pct=min(66.0, float(case["thermal_fade_pct"])),
        seed=seed,
    )
    paste_tilted_sticker(card, sticker, (32, 412), case["sticker_tilt_deg"])

    if case["logo_crease"]:
        draw_diagonal_logo_crease(card, rng)
    if case["corner_scuff"]:
        draw_scuffed_corners(card, rng)
    if case["water_droplets"] > 0:
        safe_zones = [
            (bw - 180, 74, bw - 28, 142),
            (bw - 190, 198, bw - 34, 282),
            (196, 308, 344, 372),
            (380, 14, bw - 32, 54),
        ]
        draw_water_droplets(card, case["water_droplets"], safe_zones, rng)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(158, 154, 146, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_food_pack_case(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(size, seed)
    rng = random.Random(seed + 41)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 82, pad + 88, pad + 686, pad + 680
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 92),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    carton_bg = (249, 246, 239)
    carton = Image.new("RGB", (cw, ch), carton_bg)
    cd = ImageDraw.Draw(carton)
    cfade = float(case["carton_fade_pct"]) / 100.0

    cd.rectangle((0, 0, cw, 64), fill=blend_rgb(case["accent"], carton_bg, cfade * 0.6))
    cd.text(
        (26, 19),
        case["header"],
        fill=(248, 249, 246),
        font=ImageFont.load_default(size=23),
    )

    title_ink = blend_rgb((14, 18, 16), carton_bg, cfade)
    sub_ink = blend_rgb((40, 48, 44), carton_bg, cfade)
    cd.text(
        (26, 84),
        case["title"],
        fill=title_ink,
        font=ImageFont.load_default(size=38),
        stroke_width=1,
        stroke_fill=title_ink,
    )
    cd.text(
        (26, 140),
        case["subtitle"],
        fill=sub_ink,
        font=ImageFont.load_default(size=24),
    )

    panel_bg = (253, 252, 248)
    panel_ink = blend_rgb((14, 18, 18), panel_bg, cfade * 0.9)
    cd.rounded_rectangle(
        (24, 188, cw - 24, 412),
        radius=12,
        fill=panel_bg,
        outline=blend_rgb((162, 156, 144), panel_bg, cfade),
        width=2,
    )
    iy = 206
    for ln in case["ingredients_lines"]:
        cd.text(
            (38, iy),
            ln,
            fill=panel_ink,
            font=ImageFont.load_default(size=24),
            stroke_width=1,
            stroke_fill=panel_ink,
        )
        iy += 36

    iy += 12
    cd.rounded_rectangle(
        (34, iy - 6, cw - 34, iy + 52),
        radius=8,
        fill=(244, 240, 231),
        outline=blend_rgb((138, 124, 104), panel_bg, cfade),
        width=2,
    )
    cd.text(
        (44, iy + 10),
        case["allergen_line"],
        fill=panel_ink,
        font=ImageFont.load_default(size=19),
    )

    sticker = render_thermal_sticker(
        width=cw - 56,
        height=104,
        header_text=case["sticker_header"],
        lines=case["sticker_lines"],
        fade_pct=float(case["thermal_fade_pct"]),
        seed=seed,
    )
    paste_tilted_sticker(carton, sticker, (28, 444), case["sticker_tilt_deg"])

    if case["logo_crease"]:
        draw_diagonal_logo_crease(carton, rng)
    if case["corner_scuff"]:
        draw_scuffed_corners(carton, rng)
    if case["water_droplets"] > 0:
        safe_zones = [
            (cw - 148, 134, cw - 28, 178),
            (360, 12, cw - 28, 54),
            (36, 366, cw - 40, 404),
        ]
        draw_water_droplets(carton, case["water_droplets"], safe_zones, rng)

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(158, 152, 142, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261146 + idx * 137
    if case["scene_type"] == "med_box":
        img = render_med_box_case(case, seed)
    else:
        img = render_food_pack_case(case, seed)
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
            "wear_tier": case["wear_tier"],
            "wear_mode": case["wear_mode"],
            "scene_type": case["scene_type"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "thermal_fade_pct": case["thermal_fade_pct"],
            "carton_fade_pct": case["carton_fade_pct"],
            "water_droplets": case["water_droplets"],
            "corner_scuff": case["corner_scuff"],
            "logo_crease": case["logo_crease"],
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
            f"[{cid}] tier={case['wear_tier']} mode={case['wear_mode']} exp={exp_level} "
            f"pred={pred_level} match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    moderate_items = [it for it in items_out if it["wear_tier"] == "moderate"]
    severe_items = [it for it in items_out if it["wear_tier"] == "severe"]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    moderate_wear_accuracy = round(
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

    severe_wear_abstention_rate = round(
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
        "n_moderate_wear": len(moderate_items),
        "n_severe_wear": len(severe_items),
        "moderate_wear_accuracy": moderate_wear_accuracy,
        "severe_wear_abstention_rate": severe_wear_abstention_rate,
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
    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
