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

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "pastel_tint_contrast"
OUT_JSON_PATH = REPO_ROOT / "eval" / "pastel_tint_contrast_results.json"

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

LENS_PROFILES: dict[str, dict[str, Any]] = {
    "warm_2700k_cast": {
        "illuminant_rgb": (1.06, 0.95, 0.77),
        "lens_transmittance_rgb": (0.98, 0.97, 0.94),
        "ambient_veil_lin": (0.016, 0.014, 0.010),
    },
    "amber_photochromic": {
        "illuminant_rgb": (1.05, 0.95, 0.78),
        "lens_transmittance_rgb": (0.95, 0.86, 0.62),
        "ambient_veil_lin": (0.022, 0.017, 0.009),
    },
    "transitions_brown": {
        "illuminant_rgb": (1.05, 0.94, 0.77),
        "lens_transmittance_rgb": (0.84, 0.74, 0.58),
        "ambient_veil_lin": (0.020, 0.015, 0.010),
    },
    "transitions_grey": {
        "illuminant_rgb": (1.04, 0.95, 0.79),
        "lens_transmittance_rgb": (0.74, 0.75, 0.73),
        "ambient_veil_lin": (0.018, 0.017, 0.015),
    },
    "transitions_brown_heavy": {
        "illuminant_rgb": (1.06, 0.93, 0.74),
        "lens_transmittance_rgb": (0.52, 0.43, 0.31),
        "ambient_veil_lin": (0.026, 0.019, 0.011),
    },
    "transitions_grey_heavy": {
        "illuminant_rgb": (1.04, 0.94, 0.78),
        "lens_transmittance_rgb": (0.46, 0.47, 0.45),
        "ambient_veil_lin": (0.024, 0.022, 0.019),
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "pt_01",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_mint_warm_2700k",
        "pastel_palette": "pastel_mint",
        "lens_tint": "warm_2700k_cast",
        "illuminant_kelvin": 2700,
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Moderate low-contrast pastel mint carton under warm 2700K indoor cast: Amlodipin 5 mg evening dose match",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "carton_bg": (214, 236, 225),
        "header_bg": (146, 186, 169),
        "header_ink": (48, 76, 66),
        "title_ink": (74, 106, 94),
        "sub_ink": (96, 126, 114),
        "badge_bg": (223, 240, 231),
        "badge_border": (166, 198, 184),
        "badge_ink": (106, 134, 123),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets  1 tablet in the evening",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -1.4,
        "iso_noise_sigma": 1.4,
    },
    {
        "id": "pt_02",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_blush_amber_photochromic",
        "pastel_palette": "pastel_blush",
        "lens_tint": "amber_photochromic",
        "illuminant_kelvin": 2700,
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Moderate low-contrast pastel blush carton through amber photochromic lens under 2700K light: Burana 400 mg NSAID avoid warning",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "carton_bg": (243, 222, 226),
        "header_bg": (198, 146, 156),
        "header_ink": (76, 44, 52),
        "title_ink": (108, 72, 80),
        "sub_ink": (128, 92, 100),
        "badge_bg": (246, 229, 232),
        "badge_border": (208, 168, 176),
        "badge_ink": (142, 104, 112),
        "header": "ORION PHARMA",
        "title": "Burana",
        "subtitle": "Active ingredient: ibuprofen",
        "strength_badge": "400 mg",
        "form_line": "tablets",
        "pack_line": "30 tablets  1 tablet as needed for pain",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.5,
        "iso_noise_sigma": 1.5,
    },
    {
        "id": "pt_03",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_cream_transitions_brown",
        "pastel_palette": "pastel_cream",
        "lens_tint": "transitions_brown",
        "illuminant_kelvin": 2700,
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Moderate low-contrast pastel cream carton through brown Transitions lens under 2700K light: Metformin 500 mg EXP 2025-02 expired warning",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_strength": "500 mg",
        "expected_level": "warning",
        "carton_bg": (244, 237, 218),
        "header_bg": (194, 176, 142),
        "header_ink": (68, 56, 38),
        "title_ink": (102, 86, 64),
        "sub_ink": (122, 106, 82),
        "badge_bg": (247, 241, 225),
        "badge_border": (204, 190, 160),
        "badge_ink": (136, 118, 92),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets  1 tablet twice daily",
        "expiry_line": "EXP 2025-02",
        "tilt_deg": -1.3,
        "iso_noise_sigma": 1.5,
    },
    {
        "id": "pt_04",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_lavender_transitions_grey",
        "pastel_palette": "pastel_lavender",
        "lens_tint": "transitions_grey",
        "illuminant_kelvin": 2700,
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Moderate low-contrast pastel lavender carton through grey Transitions lens under 2700K light: Amlodipin 10 mg wrong-strength warning vs 5 mg profile",
        "strength_readable": True,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_strength": "10 mg",
        "expected_level": "warning",
        "carton_bg": (231, 225, 243),
        "header_bg": (172, 160, 198),
        "header_ink": (56, 48, 76),
        "title_ink": (88, 78, 112),
        "sub_ink": (108, 98, 132),
        "badge_bg": (236, 231, 246),
        "badge_border": (188, 178, 210),
        "badge_ink": (122, 112, 146),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "10 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets  1 tablet once daily",
        "expiry_line": "EXP 2027-10",
        "tilt_deg": 1.6,
        "iso_noise_sigma": 1.5,
    },
    {
        "id": "pt_05",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_peach_amber_photochromic_allergen",
        "pastel_palette": "pastel_blush_cream",
        "lens_tint": "amber_photochromic",
        "illuminant_kelvin": 2700,
        "scene_type": "food_pack",
        "kind": "food",
        "description": "Moderate low-contrast pastel blush-cream food carton through amber photochromic lens: Hazelnut and Almond Praline Wafers tree-nut allergen warning",
        "strength_readable": False,
        "is_occluded": False,
        "has_profile_allergen": True,
        "expected_strength": None,
        "expected_level": "warning",
        "carton_bg": (244, 230, 220),
        "header_bg": (196, 158, 136),
        "header_ink": (72, 50, 38),
        "title_ink": (104, 78, 62),
        "sub_ink": (124, 98, 80),
        "panel_bg": (248, 237, 229),
        "panel_border": (212, 184, 168),
        "panel_ink": (136, 110, 92),
        "header": "NORDIC PASTEL BAKERY",
        "title": "Hazelnut & Almond Wafers",
        "subtitle": "Crispy Praline Pastry Squares  180 g",
        "ingredients_lines": [
            "Ingredients: wheat flour, cane sugar,",
            "roasted hazelnuts (12%), almonds (8%), milk.",
        ],
        "allergen_line": "Allergens: Contains hazelnuts, almonds (tree nuts), wheat, milk.",
        "expiry_line": "Best before: 2027-10-20",
        "tilt_deg": -1.2,
        "iso_noise_sigma": 1.4,
    },
    {
        "id": "pt_06",
        "contrast_tier": "moderate",
        "tint_mode": "pastel_sage_transitions_grey_safe_food",
        "pastel_palette": "pastel_mint_cream",
        "lens_tint": "transitions_grey",
        "illuminant_kelvin": 2700,
        "scene_type": "food_pack",
        "kind": "food",
        "description": "Moderate low-contrast pastel mint-cream food carton through grey Transitions lens: Nordic Pastel Oat Drink safe info verdict",
        "strength_readable": False,
        "is_occluded": False,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "info",
        "carton_bg": (225, 237, 227),
        "header_bg": (158, 184, 164),
        "header_ink": (48, 68, 54),
        "title_ink": (78, 102, 86),
        "sub_ink": (98, 122, 106),
        "panel_bg": (233, 242, 234),
        "panel_border": (178, 200, 184),
        "panel_ink": (110, 134, 118),
        "header": "NORDIC OAT MILL",
        "title": "Nordic Pastel Oat Drink",
        "subtitle": "Plant-Based Oat Beverage  1 L",
        "ingredients_lines": [
            "Ingredients: water, wholegrain oats (10%),",
            "rapeseed oil, calcium carbonate, sea salt.",
        ],
        "allergen_line": "Allergens: Contains oats (gluten).",
        "expiry_line": "Best before: 2027-12-10",
        "tilt_deg": 1.3,
        "iso_noise_sigma": 1.4,
    },
    {
        "id": "pt_07",
        "contrast_tier": "severe",
        "tint_mode": "silver_on_ivory_warm_washout",
        "pastel_palette": "ivory_silver",
        "lens_tint": "warm_2700k_cast",
        "illuminant_kelvin": 2700,
        "washout_mode": "silver_on_ivory",
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Severe washout: ultra-pale metallic silver strength badge on warm ivory carton washed out under 2700K lamp glare while Amlodipin title stays legible",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "carton_bg": (247, 244, 236),
        "header_bg": (156, 176, 192),
        "header_ink": (24, 36, 48),
        "title_ink": (22, 32, 44),
        "sub_ink": (46, 58, 72),
        "badge_bg": (245, 242, 234),
        "badge_border": (236, 232, 223),
        "badge_ink": (242, 239, 231),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "98 tablets  Take in the evening",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": -1.8,
        "iso_noise_sigma": 1.8,
    },
    {
        "id": "pt_08",
        "contrast_tier": "severe",
        "tint_mode": "bleached_yellow_on_cream_amber_washout",
        "pastel_palette": "cream_bleached_yellow",
        "lens_tint": "amber_photochromic",
        "illuminant_kelvin": 2700,
        "washout_mode": "bleached_yellow_on_cream",
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Severe washout: bleached pastel yellow strength badge on cream carton collapsed by amber photochromic lens and 2700K cast while Metformin title stays legible",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "carton_bg": (248, 244, 229),
        "header_bg": (164, 174, 194),
        "header_ink": (26, 34, 48),
        "title_ink": (24, 32, 46),
        "sub_ink": (48, 56, 70),
        "badge_bg": (247, 243, 226),
        "badge_border": (240, 235, 214),
        "badge_ink": (245, 240, 220),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets  Take with meals",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.9,
        "iso_noise_sigma": 1.8,
    },
    {
        "id": "pt_09",
        "contrast_tier": "severe",
        "tint_mode": "heavy_brown_transitions_warm_glare_washout",
        "pastel_palette": "pastel_blush_cream",
        "lens_tint": "transitions_brown_heavy",
        "illuminant_kelvin": 2700,
        "washout_mode": "heavy_tint_warm_glare",
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Severe washout: heavy residual dark-brown Transitions lens tint plus warm 2700K glare washing out strength badge on Panadol while title stays visible",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "carton_bg": (242, 234, 228),
        "header_bg": (152, 168, 188),
        "header_ink": (18, 26, 38),
        "title_ink": (16, 22, 34),
        "sub_ink": (36, 44, 58),
        "badge_bg": (244, 237, 230),
        "badge_border": (232, 224, 216),
        "badge_ink": (241, 234, 227),
        "header": "HALEON NORDIC",
        "title": "Panadol",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets  For pain or fever",
        "expiry_line": "EXP 2028-02",
        "tilt_deg": -2.0,
        "iso_noise_sigma": 2.1,
    },
    {
        "id": "pt_10",
        "contrast_tier": "severe",
        "tint_mode": "heavy_grey_transitions_lilac_glare_washout",
        "pastel_palette": "pastel_lavender_mist",
        "lens_tint": "transitions_grey_heavy",
        "illuminant_kelvin": 2700,
        "washout_mode": "heavy_tint_warm_glare",
        "scene_type": "med_box",
        "kind": "medication",
        "description": "Severe washout: heavy residual dark-grey Transitions lens tint plus warm lamp veil washing out pale lilac strength badge on Amlodipin while title stays visible",
        "strength_readable": False,
        "is_occluded": True,
        "has_profile_allergen": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "carton_bg": (236, 233, 242),
        "header_bg": (156, 152, 182),
        "header_ink": (18, 20, 34),
        "title_ink": (16, 18, 32),
        "sub_ink": (38, 40, 58),
        "badge_bg": (238, 235, 243),
        "badge_border": (228, 224, 235),
        "badge_ink": (235, 232, 240),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": None,
        "form_line": "tablets",
        "pack_line": "30 tablets  Once daily",
        "expiry_line": "EXP 2027-10",
        "tilt_deg": 2.0,
        "iso_noise_sigma": 2.1,
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


def srgb_u8_to_linear(arr_u8: np.ndarray) -> np.ndarray:
    c = np.clip(arr_u8.astype(np.float32) / 255.0, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def linear_to_srgb_u8(lin: np.ndarray) -> np.ndarray:
    c = np.clip(lin, 0.0, 1.0)
    srgb = np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)
    return np.clip(np.round(srgb * 255.0), 0.0, 255.0).astype(np.uint8)


def relative_luminance_from_u8(arr_u8: np.ndarray) -> np.ndarray:
    lin = srgb_u8_to_linear(arr_u8)
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def measure_roi_contrast(img: Image.Image, roi_mask: Image.Image) -> dict[str, float]:
    rgb_arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
    mask_arr = np.asarray(roi_mask.convert("L"), dtype=np.uint8) > 200
    lum = relative_luminance_from_u8(rgb_arr)[mask_arr]
    if lum.size < 32:
        raise RuntimeError("Target ROI mask contains insufficient pixels for contrast measurement")
    y_low = float(np.quantile(lum, 0.02))
    y_high = float(np.quantile(lum, 0.95))
    l_max = max(y_high, y_low)
    l_min = min(y_high, y_low)
    wcag_ratio = (l_max + 0.05) / (l_min + 0.05)
    denom = l_max + l_min
    michelson = (l_max - l_min) / denom if denom > 1e-9 else 0.0
    return {
        "wcag_contrast_ratio": round(float(wcag_ratio), 4),
        "michelson_contrast": round(max(0.0, min(1.0, float(michelson))), 4),
        "fg_luminance": round(float(l_min), 4),
        "bg_luminance": round(float(l_max), 4),
    }


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


def apply_warm_cast_and_lens_tint(
    img: Image.Image,
    lens_tint: str,
    iso_noise_sigma: float,
    seed: int,
) -> Image.Image:
    spec = LENS_PROFILES[lens_tint]
    arr_u8 = np.asarray(img.convert("RGB"), dtype=np.uint8)
    lin = srgb_u8_to_linear(arr_u8)

    illum = np.array(spec["illuminant_rgb"], dtype=np.float32)[None, None, :]
    trans = np.array(spec["lens_transmittance_rgb"], dtype=np.float32)[None, None, :]
    veil = np.array(spec["ambient_veil_lin"], dtype=np.float32)[None, None, :]

    h, w, c = lin.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lamp_falloff = 1.04 - 0.08 * (((xx - 0.36 * w) / w) ** 2 + ((yy - 0.28 * h) / h) ** 2)
    filtered_lin = lin * illum * trans * lamp_falloff[:, :, None] + veil

    out_f = linear_to_srgb_u8(filtered_lin).astype(np.float32)
    if iso_noise_sigma > 0.0:
        noise = lcg_normal_grid(h, w, c, seed=seed * 29 + 17) * float(iso_noise_sigma)
        out_f = np.clip(np.round(out_f + noise), 0.0, 255.0)
    return Image.fromarray(out_f.astype(np.uint8), mode="RGB")


def render_warm_living_room_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (226, 216, 198))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.59)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(238 - 18 * t), int(226 - 18 * t), int(206 - 16 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 43)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(198 - 24 * t) + jitter)),
            max(0, min(255, int(176 - 22 * t) + jitter)),
            max(0, min(255, int(148 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(154, 134, 110), width=2)

    lamp_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(lamp_glow)
    gd.ellipse((int(size * 0.10), 18, int(size * 0.48), 210), fill=(255, 242, 214, 62))
    lamp_glow = lamp_glow.filter(ImageFilter.GaussianBlur(radius=24.0))
    return Image.alpha_composite(canvas.convert("RGBA"), lamp_glow).convert("RGB")


def apply_severe_badge_washout(
    card: Image.Image,
    washout_mode: str,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    badge_bg: tuple[int, int, int],
    badge_border: tuple[int, int, int],
    seed: int,
) -> None:
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=12,
        fill=badge_bg,
        outline=badge_border,
        width=2,
    )
    arr = np.asarray(card, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx = 0.5 * float(sx0 + sx1)
    cy = 0.5 * float(sy0 + sy1)

    if washout_mode == "silver_on_ivory":
        sheen_env = np.exp(-(((xx - cx) / 138.0) ** 2 + ((yy - cy) / 52.0) ** 2))
        target = np.array([248.0, 245.0, 238.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.88 * sheen_env[:, :, None]) + target * (0.88 * sheen_env[:, :, None])
    elif washout_mode == "bleached_yellow_on_cream":
        bleach_env = np.exp(-(((xx - cx) / 142.0) ** 2 + ((yy - cy) / 54.0) ** 2))
        target = np.array([249.0, 245.0, 229.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.90 * bleach_env[:, :, None]) + target * (0.90 * bleach_env[:, :, None])
    else:
        glare_env = np.exp(-(((xx - (cx + 8.0)) / 148.0) ** 2 + ((yy - cy) / 56.0) ** 2))
        warm_veil = np.array([252.0, 244.0, 228.0], dtype=np.float32)[None, None, :]
        arr = arr * (1.0 - 0.92 * glare_env[:, :, None]) + warm_veil * (0.92 * glare_env[:, :, None])

    rng = random.Random(seed + 109)
    bx0, by0 = max(0, sx0 + 8), max(0, sy0 + 8)
    bx1, by1 = min(w, sx1 - 8), min(h, sy1 - 8)
    for row in range(by0, by1):
        fib = rng.uniform(-1.2, 1.2)
        arr[row, bx0:bx1, :] += fib

    card.paste(Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB"))


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 16) -> Any:
    sz = start_size
    while sz > min_size:
        font = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=font) <= max_width:
            return font
        sz -= 1
    return ImageFont.load_default(size=min_size)


def render_med_box_case(case: dict[str, Any], seed: int) -> tuple[Image.Image, Image.Image]:
    pad = 80
    size = 768 + 2 * pad
    bg = render_warm_living_room_backdrop(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    roi_canvas = Image.new("L", (size, size), 0)
    x0, y0, x1, y1 = pad + 68, pad + 104, pad + 700, pad + 664
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(32, 26, 20, 82),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card = Image.new("RGB", (bw, bh), case["carton_bg"])
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 62), fill=case["header_bg"])
    cd.text(
        (28, 18),
        case["header"],
        fill=case["header_ink"],
        font=ImageFont.load_default(size=23),
    )

    cd.text(
        (28, 84),
        case["title"],
        fill=case["title_ink"],
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=case["title_ink"],
    )
    cd.text(
        (28, 148),
        case["subtitle"],
        fill=case["sub_ink"],
        font=ImageFont.load_default(size=25),
    )

    sx0, sy0, sx1, sy1 = 28, 204, 276, 294
    if case["strength_badge"]:
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=case["badge_bg"],
            outline=case["badge_border"],
            width=3,
        )
        cd.text(
            (sx0 + 22, sy0 + 18),
            case["strength_badge"],
            fill=case["badge_ink"],
            font=ImageFont.load_default(size=46),
            stroke_width=1,
            stroke_fill=case["badge_ink"],
        )
        if case["form_line"]:
            cd.text(
                (sx1 + 22, sy0 + 30),
                case["form_line"],
                fill=case["sub_ink"],
                font=ImageFont.load_default(size=25),
            )
    else:
        if case["form_line"]:
            cd.text(
                (sx1 + 32, sy0 + 30),
                case["form_line"],
                fill=case["sub_ink"],
                font=ImageFont.load_default(size=25),
            )
        apply_severe_badge_washout(
            card=card,
            washout_mode=str(case.get("washout_mode", "silver_on_ivory")),
            sx0=sx0,
            sy0=sy0,
            sx1=sx1,
            sy1=sy1,
            badge_bg=case["badge_bg"],
            badge_border=case["badge_border"],
            seed=seed,
        )

    ImageDraw.Draw(roi_canvas).rectangle(
        (x0 + sx0 + 10, y0 + sy0 + 10, x0 + sx1 - 10, y0 + sy1 - 10),
        fill=255,
    )

    if case["pack_line"]:
        f_pack = fit_font(cd, case["pack_line"], bw - 56, 24)
        cd.text(
            (28, 336),
            case["pack_line"],
            fill=case["sub_ink"],
            font=f_pack,
        )

    if case["expiry_line"]:
        cd.rounded_rectangle(
            (bw - 270, 420, bw - 28, 482),
            radius=8,
            fill=case["badge_bg"],
            outline=case["badge_border"],
            width=2,
        )
        exp_ink = case["badge_ink"] if case["strength_badge"] else case["sub_ink"]
        cd.text(
            (bw - 248, 435),
            case["expiry_line"],
            fill=exp_ink,
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=exp_ink,
        )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(184, 178, 168, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    roi_rot = roi_canvas.rotate(case["tilt_deg"], resample=Image.Resampling.BILINEAR)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))
    roi_cropped = roi_rot.crop((pad, pad, pad + 768, pad + 768))
    return cropped, roi_cropped


def render_food_pack_case(case: dict[str, Any], seed: int) -> tuple[Image.Image, Image.Image]:
    pad = 80
    size = 768 + 2 * pad
    bg = render_warm_living_room_backdrop(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    roi_canvas = Image.new("L", (size, size), 0)
    x0, y0, x1, y1 = pad + 82, pad + 88, pad + 686, pad + 680
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(32, 26, 20, 82),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    carton = Image.new("RGB", (cw, ch), case["carton_bg"])
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 64), fill=case["header_bg"])
    cd.text(
        (26, 19),
        case["header"],
        fill=case["header_ink"],
        font=ImageFont.load_default(size=23),
    )

    f_title = fit_font(cd, case["title"], cw - 52, 38)
    cd.text(
        (26, 84),
        case["title"],
        fill=case["title_ink"],
        font=f_title,
        stroke_width=1,
        stroke_fill=case["title_ink"],
    )
    cd.text(
        (26, 140),
        case["subtitle"],
        fill=case["sub_ink"],
        font=ImageFont.load_default(size=24),
    )

    px0, py0, px1, py1 = 24, 190, cw - 24, 422
    cd.rounded_rectangle(
        (px0, py0, px1, py1),
        radius=12,
        fill=case["panel_bg"],
        outline=case["panel_border"],
        width=2,
    )
    iy = 212
    for ln in case["ingredients_lines"]:
        f_ing = fit_font(cd, ln, cw - 76, 24)
        cd.text(
            (38, iy),
            ln,
            fill=case["panel_ink"],
            font=f_ing,
            stroke_width=1,
            stroke_fill=case["panel_ink"],
        )
        iy += 38

    iy += 14
    cd.rounded_rectangle(
        (34, iy - 6, cw - 34, iy + 52),
        radius=8,
        fill=case["panel_bg"],
        outline=case["panel_border"],
        width=2,
    )
    f_alg = fit_font(cd, case["allergen_line"], cw - 88, 21)
    cd.text(
        (44, iy + 10),
        case["allergen_line"],
        fill=case["panel_ink"],
        font=f_alg,
        stroke_width=1,
        stroke_fill=case["panel_ink"],
    )

    ImageDraw.Draw(roi_canvas).rectangle(
        (x0 + px0 + 14, y0 + py0 + 14, x0 + px1 - 14, y0 + py1 - 14),
        fill=255,
    )

    cd.rounded_rectangle(
        (24, 456, 386, 518),
        radius=8,
        fill=case["panel_bg"],
        outline=case["panel_border"],
        width=2,
    )
    cd.text(
        (38, 473),
        case["expiry_line"],
        fill=case["panel_ink"],
        font=ImageFont.load_default(size=25),
        stroke_width=1,
        stroke_fill=case["panel_ink"],
    )

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(184, 176, 166, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    roi_rot = roi_canvas.rotate(case["tilt_deg"], resample=Image.Resampling.BILINEAR)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))
    roi_cropped = roi_rot.crop((pad, pad, pad + 768, pad + 768))
    return cropped, roi_cropped


def render_case_image_and_roi(case: dict[str, Any], idx: int) -> tuple[Image.Image, Image.Image]:
    seed = 20261146 + idx * 157
    if case["scene_type"] == "med_box":
        raw_img, roi_mask = render_med_box_case(case, seed)
    else:
        raw_img, roi_mask = render_food_pack_case(case, seed)
    tinted_img = apply_warm_cast_and_lens_tint(
        img=raw_img,
        lens_tint=str(case["lens_tint"]),
        iso_noise_sigma=float(case["iso_noise_sigma"]),
        seed=seed,
    )
    assert tinted_img.size == (768, 768)
    return tinted_img, roi_mask


def encode_jpeg_and_measure_contrast(
    img: Image.Image,
    roi_mask: Image.Image,
    out_path: pathlib.Path,
) -> tuple[str, int, dict[str, float]]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw_bytes = buf.getvalue()
    out_path.write_bytes(raw_bytes)
    decoded = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    contrast_metrics = measure_roi_contrast(decoded, roi_mask)
    return base64.b64encode(raw_bytes).decode("ascii"), len(raw_bytes), contrast_metrics


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
        str(pathlib.Path.home() / "tools" / "node" / "bin"),
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


def run_benchmark(render_only: bool = False) -> dict[str, Any]:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered_records: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        img, roi_mask = render_case_image_and_roi(case, idx)
        b64_jpeg, byte_len, contrast_metrics = encode_jpeg_and_measure_contrast(img, roi_mask, img_path)
        rendered_records.append(
            {
                "case": case,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "image_bytes": byte_len,
                "b64_jpeg": b64_jpeg,
                "contrast_metrics": contrast_metrics,
            }
        )

    if render_only:
        return {
            "rendered_count": len(rendered_records),
            "items": [
                {
                    "id": rec["case"]["id"],
                    "contrast_tier": rec["case"]["contrast_tier"],
                    "tint_mode": rec["case"]["tint_mode"],
                    "lens_tint": rec["case"]["lens_tint"],
                    "image_path": rec["image_path"],
                    "image_bytes": rec["image_bytes"],
                    **rec["contrast_metrics"],
                }
                for rec in rendered_records
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

    raw_runs: list[dict[str, Any]] = []
    for rec in rendered_records:
        raw_json, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=rec["b64_jpeg"],
        )
        raw_runs.append(
            {
                "case": rec["case"],
                "image_path": rec["image_path"],
                "image_bytes": rec["image_bytes"],
                "contrast_metrics": rec["contrast_metrics"],
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
        cm = run["contrast_metrics"]

        pred_level = str(verdict_obj["level"])
        exp_level = str(case["expected_level"])
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = round(float(read_obj["strength"]["confidence"]), 4)
        strength_same = bool(ts_row["strength_same"])
        sr = bool(case["strength_readable"])
        is_occluded = bool(case["is_occluded"])
        is_food = case["kind"] == "food"

        if sr:
            strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        elif is_food:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or pred_level == "match"
            )
            abstained = pred_level == "unsure"
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or s_conf >= STRENGTH_MIN_CONF
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = bool(pred_level == "unsure" and not confident_wrong_dose)

        reasons = verdict_obj.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        has_allergen = bool(case["has_profile_allergen"])
        alg_val = read_obj["allergens"]["value"]
        alg_conf = float(read_obj["allergens"]["confidence"])
        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)
        false_safe_allergen = bool(
            (has_allergen and not allergen_detected)
            or (is_food and (alg_val is None or alg_conf < ALLERGEN_MIN_CONF) and pred_level in ("info", "match"))
        )

        target_region = "strength_badge" if case["scene_type"] == "med_box" else "allergen_panel"

        item_record = {
            "id": cid,
            "contrast_tier": case["contrast_tier"],
            "tint_mode": case["tint_mode"],
            "pastel_palette": case["pastel_palette"],
            "lens_tint": case["lens_tint"],
            "illuminant_kelvin": int(case["illuminant_kelvin"]),
            "scene_type": case["scene_type"],
            "kind": case["kind"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": int(run["image_bytes"]),
            "width": 768,
            "height": 768,
            "target_region": target_region,
            "wcag_contrast_ratio": cm["wcag_contrast_ratio"],
            "michelson_contrast": cm["michelson_contrast"],
            "fg_luminance": cm["fg_luminance"],
            "bg_luminance": cm["bg_luminance"],
            "strength_readable": sr,
            "is_occluded": is_occluded,
            "has_profile_allergen": has_allergen,
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "allergen_detected": allergen_detected,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "latency_ms": run["latency_ms"],
            "tokens_in": int(run["tokens_in"]),
            "tokens_out": int(run["tokens_out"]),
            "tokens_thinking": int(run["tokens_thinking"]),
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_record)
        print(
            f"[{cid}] tier={case['contrast_tier']} lens={case['lens_tint']} "
            f"wcag={cm['wcag_contrast_ratio']:.2f} michelson={cm['michelson_contrast']:.3f} "
            f"exp={exp_level} pred={pred_level} match={verdict_match} "
            f"strength={s_val!r} conf={s_conf:.2f} cwd={confident_wrong_dose} "
            f"fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    moderate_items = [it for it in items_out if it["contrast_tier"] == "moderate"]
    severe_items = [it for it in items_out if it["contrast_tier"] == "severe"]
    readable_med_items = [it for it in items_out if it["strength_readable"]]
    allergen_items = [it for it in items_out if it["has_profile_allergen"]]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    clean_field_accuracy = round(
        sum(1 for it in readable_med_items if bool(it["strength_correct"])) / len(readable_med_items),
        4,
    )
    occluded_abstention_rate = round(
        sum(1 for it in severe_items if it["abstained"] and not it["confident_wrong_dose"]) / len(severe_items),
        4,
    )
    moderate_contrast_accuracy = round(
        sum(
            1
            for it in moderate_items
            if it["verdict_match"]
            and (not it["strength_readable"] or bool(it["strength_correct"]))
            and not it["false_safe_allergen"]
            and not it["confident_wrong_dose"]
        )
        / len(moderate_items),
        4,
    )
    severe_washout_abstention_rate = occluded_abstention_rate
    allergen_recall = (
        round(sum(1 for it in allergen_items if it["allergen_detected"]) / len(allergen_items), 4)
        if allergen_items
        else 1.0
    )

    mean_mod_wcag = round(statistics.mean(float(it["wcag_contrast_ratio"]) for it in moderate_items), 4)
    mean_sev_wcag = round(statistics.mean(float(it["wcag_contrast_ratio"]) for it in severe_items), 4)
    mean_mod_mich = round(statistics.mean(float(it["michelson_contrast"]) for it in moderate_items), 4)
    mean_sev_mich = round(statistics.mean(float(it["michelson_contrast"]) for it in severe_items), 4)

    confident_wrong_dose_count = int(sum(1 for it in items_out if it["confident_wrong_dose"]))
    false_safe_allergen_count = int(sum(1 for it in items_out if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items_out))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items_out))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items_out))

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "strength_min_conf": STRENGTH_MIN_CONF,
        "n_items": int(n_items),
        "n_moderate_contrast": int(len(moderate_items)),
        "n_severe_washout": int(len(severe_items)),
        "verdict_matches": int(verdict_matches),
        "verdict_accuracy": verdict_accuracy,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "moderate_contrast_accuracy": moderate_contrast_accuracy,
        "severe_washout_abstention_rate": severe_washout_abstention_rate,
        "allergen_recall": allergen_recall,
        "mean_moderate_wcag_contrast_ratio": mean_mod_wcag,
        "mean_severe_wcag_contrast_ratio": mean_sev_wcag,
        "mean_moderate_michelson_contrast": mean_mod_mich,
        "mean_severe_michelson_contrast": mean_sev_mich,
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
            "eval_now_iso": EVAL_NOW_ISO,
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
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Low-contrast pastel packaging, warm 2700K cast, and Transitions tinted-lens benchmark"
    )
    parser.add_argument("--render-only", action="store_true", help="Render 768x768 JPEGs and measure contrast only")
    args = parser.parse_args(argv)
    res = run_benchmark(render_only=args.render_only)
    if args.render_only:
        print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
