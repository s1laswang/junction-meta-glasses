from __future__ import annotations
import argparse
import base64
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
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = pathlib.Path(__file__).resolve().parent
EVAL_DIR = SUITE_DIR.parent.parent
REPO_ROOT = EVAL_DIR.parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

from common import load_env, parse_json
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "thermal_fade_wear"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
ALLERGEN_MIN_CONF = 0.6
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"
RESULTS_PATH = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"

HASH_CH = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "aml", "name": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "par", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
        {"id": "bis", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "tw_01",
        "scenario": "moderate_wear_evening_med_match",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "question": "Is this my evening blood pressure pill?",
        "expected_level": "match",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "thermal_fade_pct": 58,
        "carton_fade_pct": 22,
        "water_droplets": 5,
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
        "scenario": "moderate_wear_nsaid_avoid_warning",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "question": "Can I take this tablet for pain?",
        "expected_level": "warning",
        "gt_strength": "400 mg",
        "has_profile_allergen": False,
        "thermal_fade_pct": 61,
        "carton_fade_pct": 24,
        "water_droplets": 5,
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
        "scenario": "moderate_wear_expired_med_warning",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "question": "Can I take my Metformin from this box?",
        "expected_level": "warning",
        "gt_strength": "500 mg",
        "has_profile_allergen": False,
        "thermal_fade_pct": 56,
        "carton_fade_pct": 20,
        "water_droplets": 4,
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
        "scenario": "moderate_wear_treenut_allergen_warning",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "food_pack",
        "question": "Are these wafers safe with my nut allergy?",
        "expected_level": "warning",
        "gt_strength": None,
        "has_profile_allergen": True,
        "thermal_fade_pct": 62,
        "carton_fade_pct": 22,
        "water_droplets": 5,
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
        "scenario": "moderate_wear_safe_food_info",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "food_pack",
        "question": "Is this oat drink safe with my nut allergies?",
        "expected_level": "info",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 59,
        "carton_fade_pct": 21,
        "water_droplets": 5,
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
        "scenario": "moderate_wear_wrong_strength_10mg_warning",
        "wear_tier": "moderate",
        "wear_mode": "moderate_wear",
        "scene_type": "med_box",
        "question": "Is this my 5 mg evening pill?",
        "expected_level": "warning",
        "gt_strength": "10 mg",
        "has_profile_allergen": False,
        "thermal_fade_pct": 64,
        "carton_fade_pct": 24,
        "water_droplets": 5,
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
        "scenario": "severe_uv_thermal_bleach_strength_abstention",
        "wear_tier": "severe",
        "wear_mode": "thermal_bleach_95pct",
        "scene_type": "med_box",
        "question": "Is this my 5 mg evening Amlodipin?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 95,
        "carton_fade_pct": 28,
        "water_droplets": 3,
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
        "scenario": "severe_wet_ink_smear_strength_abstention",
        "wear_tier": "severe",
        "wear_mode": "wet_ink_smear",
        "scene_type": "med_box",
        "question": "Is this 5 mg or 10 mg Amlodipin?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 60,
        "carton_fade_pct": 25,
        "water_droplets": 8,
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
        "scenario": "severe_torn_pharmacy_sticker_strength_abstention",
        "wear_tier": "severe",
        "wear_mode": "torn_pharmacy_sticker",
        "scene_type": "med_box",
        "question": "Is this my 500 mg Metformin?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 58,
        "carton_fade_pct": 24,
        "water_droplets": 3,
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
        "scenario": "severe_key_abrasion_crease_strength_abstention",
        "wear_tier": "severe",
        "wear_mode": "heavy_crease_scratch",
        "scene_type": "med_box",
        "question": "What strength is this Panadol?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 62,
        "carton_fade_pct": 28,
        "water_droplets": 4,
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
    {
        "id": "tw_11",
        "scenario": "severe_heat_blackened_thermal_patch_abstention",
        "wear_tier": "severe",
        "wear_mode": "heat_blackened_patch",
        "scene_type": "med_box",
        "question": "Is this my 2.5 mg morning Bisoprolol?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 63,
        "carton_fade_pct": 26,
        "water_droplets": 3,
        "accent": (24, 104, 146),
        "header": "ORION PHARMA",
        "title": "Bisoprolol",
        "subtitle": "Active ingredient: bisoprolol",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-12",
        "sticker_header": "APTEEKKI - PHARMACY LABEL",
        "sticker_lines": [
            "1 tablet once daily in the morning.",
            "Morning heart tablet  EXP 2027-12",
        ],
        "tilt_deg": -1.8,
        "sticker_tilt_deg": 1.4,
    },
    {
        "id": "tw_12",
        "scenario": "severe_abraded_allergen_panel_abstention",
        "wear_tier": "severe",
        "wear_mode": "abraded_allergen_panel",
        "scene_type": "food_pack",
        "question": "Is this snack bar safe with my peanut and tree nut allergies?",
        "expected_level": "unsure",
        "gt_strength": None,
        "has_profile_allergen": False,
        "thermal_fade_pct": 64,
        "carton_fade_pct": 26,
        "water_droplets": 4,
        "accent": (144, 86, 36),
        "header": "NORDIC BAKERY",
        "title": "Crispy Cereal Bar",
        "subtitle": "Single Snack Bar  50 g",
        "ingredients_lines": [],
        "allergen_line": "",
        "sticker_header": "PANTRY THERMAL BATCH LABEL",
        "sticker_lines": [
            "Snack multipack unit  Batch 519",
            "Best before: 2027-11-20",
        ],
        "tilt_deg": 1.9,
        "sticker_tilt_deg": -1.5,
    },
]


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, "-").replace(EN_DASH, "-")
        return KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [sanitize_obj(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_obj(str(k)): sanitize_obj(v) for k, v in val.items()}
    return val


def ensure_api_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    for p in (home_env, REPO_ROOT / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if not ln or ln.startswith(HASH_CH) or "=" not in ln:
                    continue
                if ln.startswith("export "):
                    ln = ln[7:].strip()
                k, v = ln.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    if not os.environ.get("GEMINI_API_KEY"):
        load_env()


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 0.0]
    z = 1.959963984540054
    p = k / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    half = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / denom
    return [max(0.0, round(center - half, 4)), min(1.0, round(center + half, 4))]


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
    for cx, cy, dx, dy in ((0, 0, 1, 1), (cw, 0, -1, 1), (0, ch, 1, -1), (cw, ch, -1, -1)):
        r_w, r_h = rng.randint(32, 52), rng.randint(28, 46)
        pts = [(cx, cy), (cx + dx * r_w, cy), (cx + dx * int(r_w * 0.68), cy + dy * int(r_h * 0.52)), (cx, cy + dy * r_h)]
        od.polygon(pts, fill=(196, 188, 174, 225))
        for _ in range(7):
            sx0, sy0 = cx + dx * rng.randint(3, r_w), cy + dy * rng.randint(3, r_h)
            od.line((sx0, sy0, sx0 + dx * rng.randint(8, 22), sy0 + dy * rng.randint(4, 14)), fill=(166, 156, 140, 190), width=2)
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay.filter(ImageFilter.GaussianBlur(radius=0.8))).convert("RGB"))


def draw_diagonal_logo_crease(card: Image.Image, rng: random.Random) -> None:
    cw, ch = card.size
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    x_start, y_start = rng.randint(18, 54), rng.randint(68, 92)
    x_end, y_end = rng.randint(230, 310), rng.randint(4, 22)
    pts_shadow: list[tuple[int, int]] = []
    pts_light: list[tuple[int, int]] = []
    for i in range(19):
        t = i / 18
        jitter = rng.randint(-2, 2) if 0 < i < 18 else 0
        px = int(round(x_start * (1.0 - t) + x_end * t))
        py = int(round(y_start * (1.0 - t) + y_end * t)) + jitter
        pts_shadow.append((px, py))
        pts_light.append((px, py + 3))
    od.line(pts_shadow, fill=(78, 74, 68, 125), width=2)
    od.line(pts_light, fill=(252, 250, 244, 185), width=3)
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay.filter(ImageFilter.GaussianBlur(radius=0.6))).convert("RGB"))


def draw_water_droplets(card: Image.Image, count: int, safe_zones: list[tuple[int, int, int, int]], rng: random.Random) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for i in range(count):
        zx0, zy0, zx1, zy1 = safe_zones[i % len(safe_zones)]
        if zx1 - zx0 < 20 or zy1 - zy0 < 20:
            continue
        cx, cy = rng.randint(zx0 + 10, zx1 - 10), rng.randint(zy0 + 10, zy1 - 10)
        rx, ry = rng.randint(7, 13), rng.randint(6, 11)
        od.ellipse((cx - rx - 1, cy - ry + 1, cx + rx + 1, cy + ry + 2), fill=(145, 154, 162, 55), outline=(118, 128, 138, 95), width=1)
        od.ellipse((cx - rx + 2, cy - ry + 2, cx + rx - 2, cy + ry - 1), fill=(236, 242, 248, 70))
        od.ellipse((cx - rx + 3, cy - ry + 3, cx - rx + 7, cy - ry + 6), fill=(255, 255, 255, 185))
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def render_thermal_sticker(width: int, height: int, header_text: str, lines: list[str], fade_pct: float, seed: int) -> Image.Image:
    paper_bg = (244, 239, 226)
    sticker = Image.new("RGB", (width, height), paper_bg)
    arr = np.asarray(sticker, dtype=np.float32)
    rng = random.Random(seed + 71)
    sun_grad = (6.0 * np.linspace(0.0, 1.0, width, dtype=np.float32))[None, :, None]
    grain = np.zeros((height, width, 1), dtype=np.float32)
    for row in range(height):
        grain[row, :, 0] = rng.uniform(-2.5, 2.5)
    sticker = Image.fromarray(np.clip(arr + sun_grad + grain, 0.0, 255.0).astype(np.uint8), mode="RGB")
    sd = ImageDraw.Draw(sticker)
    fade_frac = max(0.0, min(0.96, float(fade_pct) / 100.0))
    sd.rounded_rectangle((1, 1, width - 2, height - 2), radius=8, outline=blend_rgb((156, 150, 136), paper_bg, fade_frac * 0.5), width=2)
    sd.text((16, 8), header_text, fill=blend_rgb((24, 28, 34), paper_bg, min(0.92, fade_frac * 0.95)), font=ImageFont.load_default(size=17))
    sd.line((14, 30, width - 14, 30), fill=blend_rgb((96, 98, 102), paper_bg, fade_frac), width=1)
    ty = 36
    body_ink = blend_rgb((16, 20, 26), paper_bg, fade_frac)
    for ln in lines:
        sd.text((16, ty), ln, fill=body_ink, font=ImageFont.load_default(size=20))
        ty += 26
    return sticker


def paste_tilted_sticker(card: Image.Image, sticker: Image.Image, dest_xy: tuple[int, int], tilt_deg: float) -> None:
    sw, sh = sticker.size
    rgba = sticker.convert("RGBA")
    shadow = Image.new("RGBA", (sw + 16, sh + 16), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((8, 9, sw + 8, sh + 9), radius=8, fill=(30, 26, 22, 65))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=3.0))
    shadow.paste(rgba, (6, 6), rgba)
    rot = shadow.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
    base_rgba = card.convert("RGBA")
    base_rgba.alpha_composite(rot, dest=(dest_xy[0] - 6, dest_xy[1] - 6))
    card.paste(base_rgba.convert("RGB"))


def apply_severe_dosage_damage(card: Image.Image, wear_mode: str, sx0: int, sy0: int, sx1: int, sy1: int, accent: tuple[int, int, int], seed: int) -> None:
    rng = random.Random(seed + 211)
    cd = ImageDraw.Draw(card)
    if wear_mode == "thermal_bleach_95pct":
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(247, 243, 231), outline=blend_rgb(accent, (247, 243, 231), 0.86), width=2)
        arr = np.asarray(card, dtype=np.float32)
        h, w, _ = arr.shape
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dist = ((xx - 0.5 * (sx0 + sx1)) / 155.0) ** 2 + ((yy - 0.5 * (sy0 + sy1)) / 68.0) ** 2
        bleach_mask = np.exp(-dist * 1.35)[:, :, None]
        target = np.array([250.0, 247.0, 237.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.96 * bleach_mask) + target * (0.96 * bleach_mask)
        card.paste(Image.fromarray(np.clip(arr, 0.0, 255.0).astype(np.uint8), mode="RGB"))
        return
    if wear_mode == "wet_ink_smear":
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=(236, 241, 247), outline=accent, width=3)
        cd.text((sx0 + 148, sy0 + 20), "mg", fill=(26, 34, 48), font=ImageFont.load_default(size=44))
        smear = Image.new("RGBA", card.size, (0, 0, 0, 0))
        smd = ImageDraw.Draw(smear)
        smd.ellipse((sx0 - 10, sy0 - 8, sx0 + 168, sy1 + 14), fill=(164, 178, 198, 125))
        for _ in range(28):
            bx, by = rng.randint(sx0 + 8, sx0 + 132), rng.randint(sy0 + 10, sy1 - 14)
            rx, ry = rng.randint(14, 34), rng.randint(9, 20)
            smd.ellipse((bx - rx, by - ry, bx + rx, by + ry), fill=(18, 30, 52, rng.randint(175, 245)))
        for _ in range(16):
            lx0, ly0 = rng.randint(sx0 + 6, sx0 + 95), rng.randint(sy0 + 14, sy1 - 14)
            smd.line((lx0, ly0, lx0 + rng.randint(36, 78), ly0 + rng.randint(-10, 12)), fill=(24, 38, 64, 220), width=rng.randint(6, 12))
        smear = smear.filter(ImageFilter.GaussianBlur(radius=3.4))
        ImageDraw.Draw(smear).ellipse((sx0 - 14, sy0 - 12, sx0 + 176, sy1 + 18), outline=(112, 128, 150, 120), width=2)
        card.paste(Image.alpha_composite(card.convert("RGBA"), smear).convert("RGB"))
        return
    if wear_mode == "torn_pharmacy_sticker":
        tear = Image.new("RGBA", card.size, (0, 0, 0, 0))
        td = ImageDraw.Draw(tear)
        top_x = list(range(sx0 - 12, sx1 + 18, 16))
        outer_pts = [(x, sy0 - 10 + rng.randint(-5, 6)) for x in top_x] + [(x, sy1 + 16 + rng.randint(-6, 6)) for x in reversed(top_x)]
        inner_pts = [(x, sy0 - 3 + rng.randint(-4, 5)) for x in top_x] + [(x, sy1 + 8 + rng.randint(-5, 5)) for x in reversed(top_x)]
        td.polygon(outer_pts, fill=(242, 240, 234, 255))
        td.polygon(inner_pts, fill=(178, 164, 142, 255))
        for _ in range(95):
            fx, fy = rng.randint(sx0 - 4, sx1 + 8), rng.randint(sy0, sy1 + 4)
            td.line((fx, fy, fx + rng.randint(6, 18), fy + rng.randint(-3, 3)), fill=(152, 138, 118, 195), width=rng.randint(1, 2))
        card.paste(Image.alpha_composite(card.convert("RGBA"), tear).convert("RGB"))
        return
    if wear_mode == "heavy_crease_scratch":
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=(232, 234, 236), outline=(152, 158, 166), width=2)
        gouge = Image.new("RGBA", card.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(gouge)
        gd.polygon([(sx0 - 8, sy0 + 4), (sx1 + 14, sy0 - 4), (sx1 + 8, sy1 + 6), (sx0 - 12, sy1 + 2)], fill=(188, 184, 176, 252))
        for _ in range(42):
            gx0, gy0 = rng.randint(sx0 - 10, sx1 - 48), rng.randint(sy0 - 2, sy1 + 2)
            col = (238, 236, 230, 235) if rng.random() < 0.55 else (126, 122, 114, 210)
            gd.line((gx0, gy0, min(sx1 + 12, gx0 + rng.randint(28, 84)), gy0 + rng.randint(-18, 18)), fill=col, width=rng.randint(3, 6))
        gd.line((sx0 - 24, sy0 + 44, sx1 + 16, sy0 + 26), fill=(86, 82, 76, 215), width=4)
        gd.line((sx0 - 24, sy0 + 48, sx1 + 16, sy0 + 30), fill=(250, 248, 242, 225), width=3)
        card.paste(Image.alpha_composite(card.convert("RGBA"), gouge).convert("RGB"))
        return
    if wear_mode == "heat_blackened_patch":
        scorch = Image.new("RGBA", card.size, (0, 0, 0, 0))
        scd = ImageDraw.Draw(scorch)
        scd.rounded_rectangle((sx0 - 14, sy0 - 10, sx1 + 18, sy1 + 12), radius=16, fill=(78, 62, 44, 165))
        scd.rounded_rectangle((sx0 - 6, sy0 - 4, sx1 + 10, sy1 + 6), radius=12, fill=(32, 28, 26, 248))
        for _ in range(36):
            bx, by = rng.randint(sx0 - 4, sx1 + 6), rng.randint(sy0 - 2, sy1 + 4)
            scd.ellipse((bx - 18, by - 10, bx + 18, by + 10), fill=(24, 22, 20, rng.randint(190, 250)))
        scorch = scorch.filter(ImageFilter.GaussianBlur(radius=2.2))
        card.paste(Image.alpha_composite(card.convert("RGBA"), scorch).convert("RGB"))


def render_med_box_case(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(size, seed)
    rng = random.Random(seed + 13)
    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 104, pad + 700, pad + 664
    bw, bh = x1 - x0, y1 - y0
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 92))
    box_layer = Image.alpha_composite(box_layer, shadow.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card_bg = (250, 249, 246)
    card = Image.new("RGB", (bw, bh), card_bg)
    cd = ImageDraw.Draw(card)
    cfade = float(case["carton_fade_pct"]) / 100.0
    cd.rectangle((0, 0, bw, 62), fill=blend_rgb(case["accent"], card_bg, cfade * 0.65))
    cd.text((28, 18), case["header"], fill=(248, 249, 250), font=ImageFont.load_default(size=23))
    title_ink = blend_rgb((12, 16, 22), card_bg, cfade)
    sub_ink = blend_rgb((32, 38, 46), card_bg, cfade)
    cd.text((28, 82), case["title"], fill=title_ink, font=ImageFont.load_default(size=48), stroke_width=1, stroke_fill=title_ink)
    cd.text((28, 146), case["subtitle"], fill=sub_ink, font=ImageFont.load_default(size=25))
    sx0, sy0, sx1, sy1 = 28, 198, 272, 286
    if case["strength_badge"]:
        badge_bg = (240, 245, 250)
        badge_ink = blend_rgb((10, 14, 20), badge_bg, cfade)
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=badge_bg, outline=blend_rgb(case["accent"], badge_bg, cfade * 0.7), width=3)
        cd.text((sx0 + 22, sy0 + 17), case["strength_badge"], fill=badge_ink, font=ImageFont.load_default(size=46), stroke_width=1, stroke_fill=badge_ink)
        if case["form_line"]:
            cd.text((sx1 + 20, sy0 + 28), case["form_line"], fill=sub_ink, font=ImageFont.load_default(size=25))
    else:
        if case["form_line"]:
            cd.text((sx1 + 36, sy0 + 28), case["form_line"], fill=sub_ink, font=ImageFont.load_default(size=25))
        apply_severe_dosage_damage(card, case["wear_mode"], sx0, sy0, sx1, sy1, case["accent"], seed)
    if case["pack_line"]:
        cd.text((28, 318), case["pack_line"], fill=sub_ink, font=ImageFont.load_default(size=24))
    if case["expiry_line"]:
        exp_bg = (244, 245, 247)
        exp_ink = blend_rgb((12, 16, 22), exp_bg, cfade * 0.85)
        cd.rounded_rectangle((bw - 262, 306, bw - 26, 364), radius=8, fill=exp_bg, outline=blend_rgb((128, 136, 146), exp_bg, cfade), width=2)
        cd.text((bw - 242, 320), case["expiry_line"], fill=exp_ink, font=ImageFont.load_default(size=27), stroke_width=1, stroke_fill=exp_ink)
    sticker = render_thermal_sticker(bw - 64, 106, case["sticker_header"], case["sticker_lines"], min(66.0, float(case["thermal_fade_pct"])), seed)
    paste_tilted_sticker(card, sticker, (32, 412), case["sticker_tilt_deg"])
    draw_diagonal_logo_crease(card, rng)
    draw_scuffed_corners(card, rng)
    safe_zones = [(bw - 180, 74, bw - 28, 142), (bw - 190, 198, bw - 34, 282), (196, 308, 344, 372), (380, 14, bw - 32, 54)]
    draw_water_droplets(card, case["water_droplets"], safe_zones, rng)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(158, 154, 146, 255), width=3)
    composed = Image.alpha_composite(bg.convert("RGBA"), box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)).convert("RGB")
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
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 92))
    box_layer = Image.alpha_composite(box_layer, shadow.filter(ImageFilter.GaussianBlur(radius=12.0)))
    carton_bg = (249, 246, 239)
    carton = Image.new("RGB", (cw, ch), carton_bg)
    cd = ImageDraw.Draw(carton)
    cfade = float(case["carton_fade_pct"]) / 100.0
    cd.rectangle((0, 0, cw, 64), fill=blend_rgb(case["accent"], carton_bg, cfade * 0.6))
    cd.text((26, 19), case["header"], fill=(248, 249, 246), font=ImageFont.load_default(size=23))
    title_ink = blend_rgb((14, 18, 16), carton_bg, cfade)
    sub_ink = blend_rgb((40, 48, 44), carton_bg, cfade)
    cd.text((26, 84), case["title"], fill=title_ink, font=ImageFont.load_default(size=38), stroke_width=1, stroke_fill=title_ink)
    cd.text((26, 140), case["subtitle"], fill=sub_ink, font=ImageFont.load_default(size=24))
    if case["wear_mode"] == "abraded_allergen_panel":
        scar = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        sd = ImageDraw.Draw(scar)
        top_x = list(range(20, cw - 16, 18))
        outer_pts = [(x, 184 + rng.randint(-6, 6)) for x in top_x] + [(x, 416 + rng.randint(-6, 6)) for x in reversed(top_x)]
        inner_pts = [(x, 194 + rng.randint(-5, 5)) for x in top_x] + [(x, 406 + rng.randint(-5, 5)) for x in reversed(top_x)]
        sd.polygon(outer_pts, fill=(238, 234, 224, 255))
        sd.polygon(inner_pts, fill=(176, 162, 140, 255))
        for _ in range(160):
            fx, fy = rng.randint(28, cw - 42), rng.randint(196, 404)
            sd.line((fx, fy, fx + rng.randint(12, 34), fy + rng.randint(-5, 5)), fill=(146, 132, 112, 205), width=rng.randint(1, 3))
        carton.paste(Image.alpha_composite(carton.convert("RGBA"), scar).convert("RGB"))
    else:
        panel_bg = (253, 252, 248)
        panel_ink = blend_rgb((14, 18, 18), panel_bg, cfade * 0.9)
        cd.rounded_rectangle((24, 188, cw - 24, 412), radius=12, fill=panel_bg, outline=blend_rgb((162, 156, 144), panel_bg, cfade), width=2)
        iy = 206
        for ln in case["ingredients_lines"]:
            cd.text((38, iy), ln, fill=panel_ink, font=ImageFont.load_default(size=24), stroke_width=1, stroke_fill=panel_ink)
            iy += 36
        iy += 12
        cd.rounded_rectangle((34, iy - 6, cw - 34, iy + 52), radius=8, fill=(244, 240, 231), outline=blend_rgb((138, 124, 104), panel_bg, cfade), width=2)
        cd.text((44, iy + 10), case["allergen_line"], fill=panel_ink, font=ImageFont.load_default(size=19))
    sticker = render_thermal_sticker(cw - 56, 104, case["sticker_header"], case["sticker_lines"], float(case["thermal_fade_pct"]), seed)
    paste_tilted_sticker(carton, sticker, (28, 444), case["sticker_tilt_deg"])
    draw_diagonal_logo_crease(carton, rng)
    draw_scuffed_corners(carton, rng)
    safe_zones = [(cw - 148, 134, cw - 28, 178), (360, 12, cw - 28, 54), (36, 366, cw - 40, 404)]
    draw_water_droplets(carton, case["water_droplets"], safe_zones, rng)
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(158, 152, 142, 255), width=3)
    composed = Image.alpha_composite(bg.convert("RGBA"), box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg(case: dict[str, Any], idx: int, out_path: pathlib.Path) -> bytes:
    seed = 20261146 + idx * 137
    img = render_med_box_case(case, seed) if case["scene_type"] == "med_box" else render_food_pack_case(case, seed)
    assert img.size == (768, 768)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data


def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    p_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes()
    s_bytes = (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return (
        p_bytes.decode("utf-8"),
        inline_refs(json.loads(s_bytes.decode("utf-8"))),
        hashlib.sha256(p_bytes).hexdigest(),
        hashlib.sha256(s_bytes).hexdigest(),
    )


def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    ensure_api_env()
    user_text = f'The person asked: "{question}"'
    try:
        from google.genai import types
        from common import gen_json
        raw, _, dt = gen_json(
            MODEL,
            [types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"), user_text],
            schema=schema,
            system=prompt,
            thinking="low",
            max_tokens=4096,
            feature=f"eval.{SUITE_NAME}",
            label=cid,
        )
        return sanitize_obj(to_label_read(raw)), float(dt)
    except ModuleNotFoundError:
        import requests
        api_key = os.environ["GEMINI_API_KEY"].strip()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": prompt}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(jpeg_bytes).decode("ascii")}},
                        {"text": user_text},
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseJsonSchema": schema,
                "thinkingConfig": {"thinkingLevel": "LOW"},
                "maxOutputTokens": 4096,
            },
        }
        sess = requests.Session()
        sess.trust_env = True
        for attempt in range(4):
            t0 = time.perf_counter()
            try:
                resp = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=60)
                dt = time.perf_counter() - t0
                if resp.status_code == 200:
                    parts = ((resp.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                    txt = next((p["text"] for p in parts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                    if txt:
                        return sanitize_obj(to_label_read(parse_json(txt))), dt
                if resp.status_code not in (429, 500, 502, 503, 504) and attempt == 3:
                    raise RuntimeError(f"HTTP {resp.status_code}")
            except Exception:
                if attempt == 3:
                    raise
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError("Gemini call exhausted retries")


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_path = ":".join([
        "/home/silas/tools/node/bin",
        "/tmp/fleet-silas/node/bin",
        str(REPO_ROOT / "node_modules" / ".bin"),
        os.environ.get("PATH", ""),
    ])
    node_bin = shutil.which("node", path=merged_path) or "node"
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=str(REPO_ROOT / "server" / "src" / "safety.ts"))
    proc = subprocess.run(
        [node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")],
        input="\n".join(json.dumps(x, ensure_ascii=False) for x in batch) + "\n",
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        timeout=90,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:300]}")
    return [sanitize_obj(json.loads(line)) for line in proc.stdout.splitlines() if line.strip()]


def is_cw_dose(gt_strength: str | None, strength_read: str | None, strength_conf: float) -> bool:
    if strength_read is None or not str(strength_read).strip() or strength_conf < CONF_THRESHOLD:
        return False
    return True if gt_strength is None else not eq_strength(gt_strength, str(strength_read))


def tmp_base_dir() -> str:
    env_tmp = os.environ.get("TMPDIR")
    if env_tmp and os.path.isdir(env_tmp):
        return env_tmp
    return "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_thermal_fade_wear_", dir=tmp_base_dir()) as tmp:
        def job(item: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            idx, c = item
            jpg = render_case_jpeg(c, idx, pathlib.Path(tmp) / f"{c['id']}.jpg")
            try:
                read, dt = call_gemini(jpg, c["question"], prompt, schema, c["id"])
                return {"read": read, "latency_s": round(dt, 3), "error": None}
            except Exception as exc:
                return {"read": None, "latency_s": 0.0, "error": str(sanitize_obj(str(exc)[:180]))}

        with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as ex:
            preds = list(ex.map(job, enumerate(CASES, start=1)))

    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    verdicts = run_safety_bridge([{"read": preds[i]["read"], "profile": PROFILE, "now": EVAL_NOW_ISO} for i in ok_idx]) if ok_idx else []
    v_map = dict(zip(ok_idx, verdicts))

    cases_out: list[dict[str, Any]] = []
    cw_dose_count = 0
    timeouts = 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append({
                "id": c["id"],
                "scenario": c["scenario"],
                "expected_level": c["expected_level"],
                "actual_level": "error",
                "predicted_level": "error",
                "passed": False,
                "verdict_ok": False,
                "confident_wrong": False,
                "strength_read": None,
                "strength_conf": 0.0,
                "name_conf": 0.0,
                "readability": 0.0,
                "latency_s": pr["latency_s"],
                "read": None,
                "error": pr["error"],
            })
            continue
        rd = pr["read"]
        actual = str(v_map[i]["level"])
        s_val = str(sanitize_obj(rd["strength"]["value"])) if rd["strength"]["value"] is not None else None
        s_conf = round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(max(
            float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0,
            float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0,
        ), 4)
        cw_dose = is_cw_dose(c["gt_strength"], s_val, s_conf)
        cw_dose_count += int(cw_dose)
        false_match = actual == "match" and c["expected_level"] != "match"
        unsafe_reassurance = c["expected_level"] in ("warning", "unsure") and actual in ("match", "info")
        cw = bool(cw_dose or false_match or unsafe_reassurance)
        passed = actual == c["expected_level"]
        cases_out.append({
            "id": c["id"],
            "scenario": c["scenario"],
            "expected_level": c["expected_level"],
            "actual_level": actual,
            "predicted_level": actual,
            "passed": passed,
            "verdict_ok": passed,
            "confident_wrong": cw,
            "strength_read": s_val,
            "strength_conf": s_conf,
            "name_conf": n_conf,
            "readability": round(float(rd["readability"]), 4),
            "latency_s": pr["latency_s"],
            "read": rd,
            "error": None,
        })

    n = len(cases_out)
    errors = sum(1 for x in cases_out if x["error"] is not None)
    pass_count = sum(1 for x in cases_out if x["passed"])
    report = sanitize_obj({
        "suite": SUITE_NAME,
        "model": MODEL,
        "eval_now_iso": EVAL_NOW_ISO,
        "prompt_sha256": p_sha,
        "schema_sha256": s_sha,
        "profile": PROFILE,
        "n": n,
        "errors": errors,
        "timeouts": timeouts,
        "pass_count": pass_count,
        "pass_rate": round(pass_count / n, 4),
        "pass_ci95_wilson": wilson_ci95(pass_count, n),
        "confident_wrong_dose_count": cw_dose_count,
        "confident_wrong_dose_rate": round(cw_dose_count / n, 4),
        "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_dose_count, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "cases": cases_out,
    })
    RESULTS_PATH.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_dose_count} errors={errors} bytes={RESULTS_PATH.stat().st_size}")
    return report


def verify_cached() -> None:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CH not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    if README_PATH.is_file():
        rm = README_PATH.read_text(encoding="utf-8")
        assert EM_DASH not in rm and EN_DASH not in rm and not KEY_RE.search(rm)
    raw_bytes = RESULTS_PATH.read_bytes()
    assert len(raw_bytes) < 15360, f"results.json too large: {len(raw_bytes)}"
    raw = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw and EN_DASH not in raw and not KEY_RE.search(raw)
    assert "/9j/" not in raw and "data:image" not in raw and ("base" + "64") not in raw.lower()
    data = json.loads(raw)
    _, _, p_sha, s_sha = load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == EVAL_NOW_ISO and isinstance(data["profile"], dict)
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["confident_wrong_dose_count"] == 0 and data["confident_wrong_dose_rate"] == 0.0
    with tempfile.TemporaryDirectory(prefix="holdup_verify_tw_", dir=tmp_base_dir()) as tmp:
        for idx, c in enumerate(CASES, start=1):
            assert len(render_case_jpeg(c, idx, pathlib.Path(tmp) / f"{c['id']}.jpg")) > 5000
    batch = [
        {"read": row["read"], "profile": row.get("profile", data["profile"]), "now": row.get("eval_now_iso", data["eval_now_iso"])}
        for row in data["cases"]
    ]
    replayed = run_safety_bridge(batch)
    assert len(replayed) == len(data["cases"])
    for row, vd in zip(data["cases"], replayed):
        assert vd["level"] == row["predicted_level"] == row["actual_level"]
        assert (row["actual_level"] == row["expected_level"]) is row["passed"] is row["verdict_ok"]
        assert row["confident_wrong"] is False
    assert data["pass_count"] == sum(1 for r in data["cases"] if r["passed"])
    print(f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} cw_dose={data['confident_wrong_dose_count']} bytes={len(raw_bytes)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    if args.verify_cached or args.offline:
        verify_cached()
    else:
        run_live(args.workers)
        verify_cached()
