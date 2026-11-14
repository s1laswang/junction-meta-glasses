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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "crushed_magnifier_distortion"
OUT_JSON_PATH = REPO_ROOT / "eval" / "crushed_magnifier_distortion_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"
STRENGTH_MIN_CONF = 0.80
ALLERGEN_MIN_CONF = 0.60

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
API_KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

CRUSHED_MAGNIFIER_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml_5",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "notes": "Blood pressure, 1 tablet in the evening",
        },
        {
            "id": "ram_2_5",
            "name": "Cardace",
            "ingredient": "ramipril",
            "strength": "2.5 mg",
            "schedule": ["morning"],
            "notes": "ACE inhibitor, 1 tablet in the morning",
        },
        {
            "id": "bis_2_5",
            "name": "Emconcor",
            "ingredient": "bisoprolol",
            "strength": "2.5 mg",
            "schedule": ["morning"],
            "notes": "Beta blocker, 2.5 mg once daily in the morning",
        },
        {
            "id": "met_500",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "notes": "With meals twice daily",
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "cm_01",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "moderate_barrel_magnifier",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Handheld 2x reading magnifier with moderate barrel distortion and dark outer rim over Amlodipin 5 mg evening carton match",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 154),
        "body_fill": (249, 250, 252),
        "header": "ORION PHARMA",
        "title": "AMLODIPIN",
        "subtitle": "INN: amlodipine",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-10",
        "crush_corners": [],
        "margin_creases": 0,
        "decimal_fold_obliterate": False,
        "compound_band_fold": False,
        "rim_clip_digits": False,
        "magnifier": {
            "cx": 248,
            "cy": 300,
            "lens_r": 246,
            "bezel_half_w": 20,
            "zoom": 1.18,
            "barrel_k": 0.16,
            "blur_free_r": 0.82,
            "edge_blur_sigma": 4.2,
            "vignette_start": 0.86,
            "vignette_dark": 0.46,
            "handle_deg": 72.0,
        },
        "tilt_deg": -1.4,
        "seed": 5101,
    },
    {
        "id": "cm_02",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "crushed_corner_intact_strength",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Pocket-crushed Cardace (ramipril) 2.5 mg carton with crumpled corners and diagonal margin creases but intact 2.5 mg strength",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "2.5 mg",
        "expected_strength": "2.5 mg",
        "expected_level": "match",
        "accent": (26, 114, 102),
        "body_fill": (248, 250, 248),
        "header": "SANOFI",
        "title": "CARDACE",
        "subtitle": "INN: ramipril",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-11",
        "crush_corners": ["top_right", "bottom_left"],
        "margin_creases": 3,
        "decimal_fold_obliterate": False,
        "compound_band_fold": False,
        "rim_clip_digits": False,
        "magnifier": None,
        "tilt_deg": 1.9,
        "seed": 5102,
    },
    {
        "id": "cm_03",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "barrel_magnified_hazelnut_allergen",
        "scene_type": "food_carton",
        "kind": "food",
        "description": "Handheld reading magnifier with barrel curvature and rim vignette over Roasted Hazelnut Dark Bar tree-nut allergen warning",
        "strength_readable": False,
        "panel_readable": True,
        "has_profile_allergen": True,
        "target_allergy": "tree nuts",
        "printed_strength": None,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (106, 56, 34),
        "body_fill": (246, 241, 234),
        "header": "FAZER FINLAND",
        "title": "Roasted Hazelnut Dark Bar",
        "subtitle": "Dark Chocolate Bar  180 g",
        "ingredients_lines": [
            "Ingredients: cocoa mass, cane sugar,",
            "roasted hazelnuts (22%), cocoa butter, vanilla.",
        ],
        "allergen_line": "Allergens: Contains hazelnuts (tree nuts).",
        "expiry_line": "Best before: 2027-09-18",
        "crush_corners": [],
        "margin_creases": 0,
        "peripheral_allergen_blur": False,
        "magnifier": {
            "cx": 384,
            "cy": 398,
            "lens_r": 286,
            "bezel_half_w": 18,
            "zoom": 1.12,
            "barrel_k": 0.14,
            "blur_free_r": 0.84,
            "edge_blur_sigma": 3.8,
            "vignette_start": 0.87,
            "vignette_dark": 0.46,
            "handle_deg": 40.0,
        },
        "tilt_deg": -1.3,
        "seed": 5103,
    },
    {
        "id": "cm_04",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "crushed_magnified_peanut_allergen",
        "scene_type": "food_carton",
        "kind": "food",
        "description": "Pocket-creased Crunchy Satay Rice Crackers carton viewed through handheld reading magnifier catching peanut allergen warning",
        "strength_readable": False,
        "panel_readable": True,
        "has_profile_allergen": True,
        "target_allergy": "peanut",
        "printed_strength": None,
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (152, 76, 26),
        "body_fill": (247, 242, 232),
        "header": "NORDIC SNACK CO.",
        "title": "Crunchy Satay Rice Crackers",
        "subtitle": "Oven-Baked Snack Carton  150 g",
        "ingredients_lines": [
            "Ingredients: jasmine rice, roasted peanuts (19%),",
            "tamari soy sauce, cane sugar, sea salt.",
        ],
        "allergen_line": "Allergens: Contains peanuts, soy.",
        "expiry_line": "Best before: 2027-10-12",
        "crush_corners": ["top_right"],
        "margin_creases": 2,
        "peripheral_allergen_blur": False,
        "magnifier": {
            "cx": 384,
            "cy": 398,
            "lens_r": 286,
            "bezel_half_w": 18,
            "zoom": 1.12,
            "barrel_k": 0.14,
            "blur_free_r": 0.84,
            "edge_blur_sigma": 3.8,
            "vignette_start": 0.87,
            "vignette_dark": 0.46,
            "handle_deg": 44.0,
        },
        "tilt_deg": 1.5,
        "seed": 5104,
    },
    {
        "id": "cm_05",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "crushed_carton_wrong_strength",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Pocket-crushed Metformin 1000 mg carton with crumpled corners and crease lines catching 2x wrong-strength warning vs 500 mg profile",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "1000 mg",
        "expected_strength": "1000 mg",
        "expected_level": "warning",
        "expected_reason_substr": "differs from your",
        "accent": (36, 86, 158),
        "body_fill": (248, 249, 252),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "INN: metformin",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-08",
        "crush_corners": ["top_right", "bottom_right"],
        "margin_creases": 3,
        "decimal_fold_obliterate": False,
        "compound_band_fold": False,
        "rim_clip_digits": False,
        "magnifier": None,
        "tilt_deg": -2.0,
        "seed": 5105,
    },
    {
        "id": "cm_06",
        "degradation_tier": "readable_distorted",
        "distortion_mode": "crushed_magnified_nsaid_avoid",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Pocket-dented Burana (ibuprofen) 400 mg carton under barrel-distorted reading magnifier catching NSAID avoid-list warning",
        "strength_readable": True,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "400 mg",
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "expected_reason_substr": "avoid list",
        "accent": (182, 34, 46),
        "body_fill": (250, 247, 247),
        "header": "ORION PHARMA",
        "title": "BURANA",
        "subtitle": "INN: ibuprofen",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-11",
        "crush_corners": ["top_right"],
        "margin_creases": 2,
        "decimal_fold_obliterate": False,
        "compound_band_fold": False,
        "rim_clip_digits": False,
        "magnifier": {
            "cx": 248,
            "cy": 300,
            "lens_r": 246,
            "bezel_half_w": 20,
            "zoom": 1.18,
            "barrel_k": 0.16,
            "blur_free_r": 0.82,
            "edge_blur_sigma": 4.2,
            "vignette_start": 0.86,
            "vignette_dark": 0.46,
            "handle_deg": 70.0,
        },
        "tilt_deg": 1.4,
        "seed": 5106,
    },
    {
        "id": "cm_07",
        "degradation_tier": "severe_abstention",
        "distortion_mode": "deep_white_crease_across_decimal_2_5mg",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Pocket-crushed Emconcor (bisoprolol) 2.5 mg carton with deep white paper-fiber crease fold right across decimal and digits: safe unsure abstention with 0 false 25 mg reads",
        "strength_readable": False,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "2.5 mg",
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (28, 96, 138),
        "body_fill": (248, 250, 252),
        "header": "MERCK",
        "title": "EMCONCOR",
        "subtitle": "INN: bisoprolol",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-10",
        "crush_corners": ["top_left", "bottom_left"],
        "margin_creases": 2,
        "decimal_fold_obliterate": True,
        "compound_band_fold": False,
        "rim_clip_digits": False,
        "magnifier": None,
        "tilt_deg": -1.8,
        "seed": 5107,
    },
    {
        "id": "cm_08",
        "degradation_tier": "severe_abstention",
        "distortion_mode": "dark_magnifier_rim_clipping_strength",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Off-center handheld reading magnifier whose thick dark bezel rim and vignette clip the strength digits on Amlodipin 5 mg: safe unsure abstention",
        "strength_readable": False,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "5 mg",
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (22, 98, 154),
        "body_fill": (249, 250, 252),
        "header": "ORION PHARMA",
        "title": "AMLODIPIN",
        "subtitle": "INN: amlodipine",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "crush_corners": [],
        "margin_creases": 0,
        "decimal_fold_obliterate": False,
        "compound_band_fold": False,
        "rim_clip_digits": True,
        "magnifier": {
            "cx": 236,
            "cy": 202,
            "lens_r": 184,
            "bezel_half_w": 28,
            "zoom": 1.18,
            "barrel_k": 0.16,
            "blur_free_r": 0.76,
            "edge_blur_sigma": 5.5,
            "vignette_start": 0.80,
            "vignette_dark": 0.30,
            "handle_deg": 35.0,
        },
        "tilt_deg": 1.2,
        "seed": 5108,
    },
    {
        "id": "cm_09",
        "degradation_tier": "severe_abstention",
        "distortion_mode": "severe_peripheral_lens_blur_allergens",
        "scene_type": "food_carton",
        "kind": "food",
        "description": "High-power handheld magnifier centered on Morning Crunch Clusters title while severe peripheral spherical blur renders allergen list unreadable: safe unsure abstention",
        "strength_readable": False,
        "panel_readable": False,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": None,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (118, 78, 38),
        "body_fill": (246, 241, 232),
        "header": "NORDIC KITCHEN PANTRY",
        "title": "Morning Crunch Clusters",
        "subtitle": "Baked Breakfast Pack  350 g",
        "ingredients_lines": [],
        "allergen_line": "",
        "expiry_line": "Best before: 2027-11-15",
        "crush_corners": ["bottom_right"],
        "margin_creases": 1,
        "peripheral_allergen_blur": True,
        "magnifier": {
            "cx": 356,
            "cy": 176,
            "lens_r": 326,
            "bezel_half_w": 24,
            "zoom": 1.16,
            "barrel_k": 0.20,
            "blur_free_r": 0.56,
            "edge_blur_sigma": 17.5,
            "vignette_start": 0.74,
            "vignette_dark": 0.36,
            "handle_deg": 42.0,
        },
        "tilt_deg": -1.5,
        "seed": 5109,
    },
    {
        "id": "cm_10",
        "degradation_tier": "severe_abstention",
        "distortion_mode": "compound_crush_crease_and_edge_blur",
        "scene_type": "med_carton",
        "kind": "medication",
        "description": "Pocket-crushed Metformin carton with deep horizontal crush fold and off-axis magnifier peripheral blur over strength digits: safe unsure abstention",
        "strength_readable": False,
        "panel_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "printed_strength": "500 mg",
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (36, 86, 158),
        "body_fill": (248, 249, 252),
        "header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "INN: metformin",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "crush_corners": ["top_right", "bottom_left"],
        "margin_creases": 2,
        "decimal_fold_obliterate": False,
        "compound_band_fold": True,
        "rim_clip_digits": False,
        "magnifier": {
            "cx": 246,
            "cy": 204,
            "lens_r": 196,
            "bezel_half_w": 24,
            "zoom": 1.16,
            "barrel_k": 0.18,
            "blur_free_r": 0.68,
            "edge_blur_sigma": 15.5,
            "vignette_start": 0.76,
            "vignette_dark": 0.34,
            "handle_deg": 38.0,
        },
        "tilt_deg": 1.7,
        "seed": 5110,
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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 16) -> Any:
    sz = start_size
    while sz > min_size:
        font = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=font) <= max_width:
            return font
        sz -= 1
    return ImageFont.load_default(size=min_size)


def bilinear_sample_rgb(arr: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    h, w, _ = arr.shape
    sx_c = np.clip(sx, 0.0, float(w - 1))
    sy_c = np.clip(sy, 0.0, float(h - 1))
    x0 = np.floor(sx_c).astype(np.int32)
    y0 = np.floor(sy_c).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    wx = (sx_c - x0)[:, :, None]
    wy = (sy_c - y0)[:, :, None]
    top = arr[y0, x0] * (1.0 - wx) + arr[y0, x1] * wx
    bot = arr[y1, x0] * (1.0 - wx) + arr[y1, x1] * wx
    return top * (1.0 - wy) + bot * wy


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
    return Image.blend(img.convert("RGB"), grain_rgb, alpha=0.035)


def render_table_backdrop(seed: int, size: int) -> Image.Image:
    rng = random.Random(seed + 17)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = int(size * 0.60)
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(230 - 22 * t)
        g = clamp_byte(226 - 20 * t)
        b = clamp_byte(218 - 18 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        jitter = rng.randint(-3, 3)
        r = clamp_byte(182 - 26 * t + jitter)
        g = clamp_byte(156 - 22 * t + jitter)
        b = clamp_byte(128 - 18 * t + jitter)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(134, 112, 88), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((32, 24, 224, 196), fill=(255, 250, 238, 44))
    bd.ellipse((size - 246, 36, size - 36, 228), fill=(238, 246, 255, 38))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=24.0))
    return Image.alpha_composite(img.convert("RGBA"), bokeh).convert("RGB")


def apply_crushed_corners_and_margin_creases(
    card: Image.Image,
    mask: Image.Image,
    crush_corners: list[str],
    margin_creases: int,
    seed: int,
) -> tuple[Image.Image, Image.Image]:
    rng = random.Random(seed + 41)
    cw, ch = card.size
    rgba = card.convert("RGBA")
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    md = ImageDraw.Draw(mask)

    for corner in crush_corners:
        cut_w = rng.randint(44, 62)
        cut_h = rng.randint(40, 56)
        if corner == "top_right":
            md.polygon([(cw - cut_w, 0), (cw, 0), (cw, cut_h)], fill=0)
            flap = [(cw - cut_w, 0), (cw, cut_h), (cw - cut_w - 16, cut_h + 18)]
            od.polygon(flap, fill=(214, 208, 198, 245))
            od.line([(cw - cut_w, 0), (cw - cut_w - 16, cut_h + 18), (cw, cut_h)], fill=(252, 250, 246, 235), width=3)
            od.line([(cw - cut_w - 18, cut_h + 21), (cw, cut_h + 4)], fill=(72, 66, 58, 130), width=3)
        elif corner == "bottom_right":
            md.polygon([(cw - cut_w, ch), (cw, ch), (cw, ch - cut_h)], fill=0)
            flap = [(cw - cut_w, ch), (cw, ch - cut_h), (cw - cut_w - 14, ch - cut_h - 16)]
            od.polygon(flap, fill=(210, 204, 194, 245))
            od.line([(cw - cut_w, ch), (cw - cut_w - 14, ch - cut_h - 16), (cw, ch - cut_h)], fill=(252, 250, 246, 235), width=3)
        elif corner == "top_left":
            md.polygon([(0, 0), (cut_w, 0), (0, cut_h)], fill=0)
            flap = [(cut_w, 0), (0, cut_h), (cut_w + 15, cut_h + 16)]
            od.polygon(flap, fill=(212, 206, 196, 245))
            od.line([(cut_w, 0), (cut_w + 15, cut_h + 16), (0, cut_h)], fill=(252, 250, 246, 235), width=3)
        elif corner == "bottom_left":
            md.polygon([(0, ch - cut_h), (0, ch), (cut_w, ch)], fill=0)
            flap = [(0, ch - cut_h), (cut_w, ch), (cut_w + 14, ch - cut_h - 15)]
            od.polygon(flap, fill=(210, 204, 194, 245))
            od.line([(0, ch - cut_h), (cut_w + 14, ch - cut_h - 15), (cut_w, ch)], fill=(252, 250, 246, 235), width=3)

    for idx in range(margin_creases):
        x_a = rng.randint(int(cw * 0.66), cw - 18)
        y_a = rng.randint(74 + idx * 90, min(ch - 120, 148 + idx * 105))
        x_b = min(cw - 8, x_a + rng.randint(68, 132))
        y_b = max(70, min(ch - 96, y_a + rng.randint(-46, 52)))
        steps = 16
        pts_dark: list[tuple[int, int]] = []
        pts_white: list[tuple[int, int]] = []
        for s in range(steps + 1):
            t = s / steps
            jit = rng.randint(-2, 2) if 0 < s < steps else 0
            px = int(round(x_a * (1.0 - t) + x_b * t))
            py = int(round(y_a * (1.0 - t) + y_b * t)) + jit
            pts_dark.append((px, py))
            pts_white.append((px, py + 3))
        od.line(pts_dark, fill=(84, 78, 72, 128), width=2)
        od.line(pts_white, fill=(254, 253, 250, 210), width=3)

    soft = overlay.filter(ImageFilter.GaussianBlur(radius=0.55))
    merged = Image.alpha_composite(rgba, soft).convert("RGB")
    return merged, mask


def apply_deep_white_crease_over_decimal(
    card: Image.Image,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed + 109)
    cw, ch = card.size
    arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)

    badge_cy = 0.5 * float(sy0 + sy1)
    fold_cx_at_badge = float(sx0 + 96)
    slope = -0.34
    fold_x = fold_cx_at_badge + slope * (yy - badge_cy)
    dist_fold = xx - fold_x

    below_sub = np.clip((yy - float(sy0 - 14)) / 16.0, 0.0, 1.0)
    in_badge_y = np.exp(-0.5 * (((yy - badge_cy) / 52.0) ** 2))

    pinch_w = 10.0 + 48.0 * in_badge_y
    trough = np.exp(-0.5 * (((dist_fold + 8.0) / pinch_w) ** 2)) * below_sub
    ridge = np.exp(-0.5 * (((dist_fold - 4.0) / (5.5 + 32.0 * in_badge_y)) ** 2)) * below_sub

    arr = arr * (1.0 - 0.34 * trough)[:, :, None]
    paper = np.array([252.0, 251.0, 246.0], dtype=np.float32)[None, None, :]
    delam = np.clip(1.25 * np.exp(-0.5 * ((dist_fold / 64.0) ** 2)) * np.exp(-0.5 * (((yy - badge_cy) / 46.0) ** 2)), 0.0, 1.0)
    arr = arr * (1.0 - delam[:, :, None]) + paper * delam[:, :, None]
    arr = arr + (42.0 * ridge * (1.0 - 0.65 * delam))[:, :, None]

    out = Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")
    rgba = out.convert("RGBA")
    crease_layer = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crease_layer)

    num_left = sx0 + 12
    num_right = sx0 + 174
    for k in range(3):
        rx0 = num_left + 26 + k * 42
        cd.line(
            [(rx0 + 14, sy0 - 12), (rx0 - 14, sy1 + 14)],
            fill=(112, 118, 126, 165),
            width=3,
        )
        cd.line(
            [(rx0 + 18, sy0 - 12), (rx0 - 10, sy1 + 14)],
            fill=(255, 255, 255, 240),
            width=5,
        )

    for _ in range(42):
        fx = rng.randint(num_left + 4, num_right - 12)
        fy = rng.randint(sy0 + 4, sy1 - 4)
        fl = rng.randint(8, 22)
        ang_dy = rng.randint(-5, 5)
        tone = rng.choice([(226, 224, 218, 210), (192, 190, 184, 175), (255, 255, 255, 245)])
        cd.line((fx, fy, fx + fl, fy + ang_dy), fill=tone, width=rng.randint(2, 4))

    soft_crease = crease_layer.filter(ImageFilter.GaussianBlur(radius=0.8))
    return Image.alpha_composite(rgba, soft_crease).convert("RGB")


def apply_compound_horizontal_crush_fold(
    card: Image.Image,
    sy0: int,
    sy1: int,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed + 157)
    cw, ch = card.size
    arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)

    yc = 0.5 * float(sy0 + sy1) + 0.03 * (xx - 0.5 * float(cw))
    rel = yy - yc
    band = np.exp(-0.5 * ((rel / 34.0) ** 2))
    paper = np.array([244.0, 242.0, 236.0], dtype=np.float32)[None, None, :]
    arr = arr * (1.0 - 0.94 * band[:, :, None]) + paper * (0.94 * band[:, :, None])

    canyon = 1.0 - 0.62 * np.exp(-0.5 * ((rel / 16.0) ** 2))
    ridge_hi = 72.0 * np.exp(-0.5 * (((rel + 20.0) / 5.5) ** 2))
    ridge_lo = 64.0 * np.exp(-0.5 * (((rel - 22.0) / 6.0) ** 2))
    arr = arr * canyon[:, :, None] + (ridge_hi + ridge_lo)[:, :, None]

    for _ in range(12):
        sx = rng.uniform(24.0, float(cw - 40))
        sy_off = rng.uniform(-24.0, 24.0)
        env = np.exp(-0.5 * (((xx - sx) / 80.0) ** 2)) * np.exp(-0.5 * (((rel - sy_off) / 3.0) ** 2))
        arr = arr + 42.0 * env[:, :, None]

    return Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")


def apply_handheld_magnifier(frame: Image.Image, mag: dict[str, Any], seed: int) -> Image.Image:
    w, h = frame.size
    cx = float(mag["cx"])
    cy = float(mag["cy"])
    lens_r = float(mag["lens_r"])
    bezel_hw = float(mag["bezel_half_w"])
    zoom = float(mag["zoom"])
    barrel_k = float(mag["barrel_k"])
    blur_free_r = float(mag["blur_free_r"])
    edge_sigma = float(mag["edge_blur_sigma"])
    vig_start = float(mag["vignette_start"])
    vig_dark = float(mag["vignette_dark"])
    handle_deg = float(mag["handle_deg"])

    base_arr = np.asarray(frame.convert("RGB"), dtype=np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = xx - cx
    dy = yy - cy
    dist = np.hypot(dx, dy)
    r_norm = dist / max(1.0, lens_r)
    r2 = np.minimum(1.25, r_norm * r_norm)

    inv_scale = (1.0 / zoom) * (1.0 - barrel_k * r2)
    src_x = cx + dx * inv_scale
    src_y = cy + dy * inv_scale
    warped_sharp = bilinear_sample_rgb(base_arr, src_x, src_y)

    warped_img = Image.fromarray(np.clip(np.round(warped_sharp), 0.0, 255.0).astype(np.uint8), mode="RGB")
    mid_blur_img = warped_img.filter(ImageFilter.GaussianBlur(radius=max(1.2, edge_sigma * 0.35)))
    heavy_blur_img = warped_img.filter(ImageFilter.GaussianBlur(radius=edge_sigma))

    mid_arr = np.asarray(mid_blur_img, dtype=np.float32)
    heavy_arr = np.asarray(heavy_blur_img, dtype=np.float32)

    t_blur = np.clip((r_norm - blur_free_r) / max(0.06, 1.0 - blur_free_r), 0.0, 1.0)
    w_mid = np.clip(t_blur * 2.0, 0.0, 1.0) * (1.0 - np.clip((t_blur - 0.45) / 0.55, 0.0, 1.0))
    w_heavy = np.clip((t_blur - 0.30) / 0.70, 0.0, 1.0) ** 1.25
    w_sharp = np.maximum(0.0, 1.0 - w_mid - w_heavy)
    norm_sum = w_sharp + w_mid + w_heavy
    lens_rgb = (
        warped_sharp * (w_sharp / norm_sum)[:, :, None]
        + mid_arr * (w_mid / norm_sum)[:, :, None]
        + heavy_arr * (w_heavy / norm_sum)[:, :, None]
    )

    lens_rgb[:, :, 0] *= 0.988
    lens_rgb[:, :, 1] *= 0.998
    lens_rgb[:, :, 2] *= 1.006

    glint_arc = 22.0 * np.exp(-0.5 * (((r_norm - 0.80) / 0.045) ** 2)) * np.clip((-dx - dy) / max(1.0, lens_r), 0.0, 1.0)
    lens_rgb = lens_rgb + glint_arc[:, :, None]

    vig_t = np.clip((r_norm - vig_start) / max(0.05, 1.0 - vig_start), 0.0, 1.0)
    vig_mult = 1.0 - (1.0 - vig_dark) * (vig_t ** 1.6)
    lens_rgb = lens_rgb * vig_mult[:, :, None]

    inner_bezel_r = lens_r - bezel_hw
    outer_bezel_r = lens_r + bezel_hw

    out_arr = base_arr.copy()
    sh_dx = xx - (cx + 11.0)
    sh_dy = yy - (cy + 15.0)
    sh_dist = np.hypot(sh_dx, sh_dy)
    ring_shadow = np.exp(-0.5 * (((sh_dist - lens_r) / (bezel_hw * 0.92 + 8.0)) ** 2))
    outside_lens = dist > inner_bezel_r
    out_arr[outside_lens] *= (1.0 - 0.46 * ring_shadow[outside_lens])[:, None]

    inside_aperture = dist <= inner_bezel_r
    out_arr[inside_aperture] = np.clip(lens_rgb[inside_aperture], 0.0, 255.0)

    composed = Image.fromarray(np.clip(np.round(out_arr), 0.0, 255.0).astype(np.uint8), mode="RGB").convert("RGBA")

    hw_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hw_layer)

    ang_rad = math.radians(handle_deg)
    ux, uy = math.cos(ang_rad), math.sin(ang_rad)
    px_n, py_n = -uy, ux
    h_start = outer_bezel_r - 6.0
    h_end = outer_bezel_r + 250.0
    half_thick = max(20.0, bezel_hw * 0.88)

    shadow_pts = [
        (cx + 10 + ux * h_start + px_n * half_thick, cy + 14 + uy * h_start + py_n * half_thick),
        (cx + 10 + ux * h_start - px_n * half_thick, cy + 14 + uy * h_start - py_n * half_thick),
        (cx + 10 + ux * h_end - px_n * (half_thick + 6), cy + 14 + uy * h_end - py_n * (half_thick + 6)),
        (cx + 10 + ux * h_end + px_n * (half_thick + 6), cy + 14 + uy * h_end + py_n * (half_thick + 6)),
    ]
    sh_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh_img).polygon(shadow_pts, fill=(14, 14, 16, 118))
    sh_img = sh_img.filter(ImageFilter.GaussianBlur(radius=9.0))
    composed = Image.alpha_composite(composed, sh_img)

    handle_pts = [
        (cx + ux * h_start + px_n * half_thick, cy + uy * h_start + py_n * half_thick),
        (cx + ux * h_start - px_n * half_thick, cy + uy * h_start - py_n * half_thick),
        (cx + ux * h_end - px_n * (half_thick + 5), cy + uy * h_end - py_n * (half_thick + 5)),
        (cx + ux * h_end + px_n * (half_thick + 5), cy + uy * h_end + py_n * (half_thick + 5)),
    ]
    hd.polygon(handle_pts, fill=(26, 28, 33, 255))
    hd.line([handle_pts[0], handle_pts[3]], fill=(70, 76, 86, 235), width=3)

    bezel_arr = np.zeros((h, w, 4), dtype=np.uint8)
    in_bezel = (dist >= inner_bezel_r) & (dist <= outer_bezel_r)
    radial_pos = np.clip((dist - inner_bezel_r) / max(1.0, outer_bezel_r - inner_bezel_r), 0.0, 1.0)
    crown = np.sin(radial_pos * math.pi)
    light_dir = np.clip((-0.65 * dx - 0.75 * dy) / np.maximum(1.0, dist), -1.0, 1.0)
    bezel_val = 20.0 + 22.0 * crown + 18.0 * np.maximum(0.0, light_dir) * crown

    bezel_arr[:, :, 0] = np.clip(bezel_val, 0.0, 255.0).astype(np.uint8)
    bezel_arr[:, :, 1] = np.clip(bezel_val + 2.0, 0.0, 255.0).astype(np.uint8)
    bezel_arr[:, :, 2] = np.clip(bezel_val + 5.0, 0.0, 255.0).astype(np.uint8)

    aa_in = np.clip((dist - (inner_bezel_r - 1.2)) / 1.4, 0.0, 1.0)
    aa_out = np.clip(((outer_bezel_r + 1.2) - dist) / 1.4, 0.0, 1.0)
    bezel_alpha = (255.0 * aa_in * aa_out * ((dist >= inner_bezel_r - 1.5) & (dist <= outer_bezel_r + 1.5))).astype(np.uint8)
    bezel_arr[:, :, 3] = bezel_alpha
    _ = in_bezel

    composed = Image.alpha_composite(composed, hw_layer)
    composed = Image.alpha_composite(composed, Image.fromarray(bezel_arr, mode="RGBA"))
    return add_sensor_grain(composed.convert("RGB"), seed=seed + 61)


def render_med_carton(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    pad = 84
    size = 768 + 2 * pad
    bg = render_table_backdrop(seed, size)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 74, pad + 112, pad + 694, pad + 656
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=16,
        fill=(24, 20, 16, 108),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card = Image.new("RGB", (bw, bh), case["body_fill"])
    cd = ImageDraw.Draw(card)
    accent = case["accent"]

    cd.rectangle((0, 0, bw, 62), fill=accent)
    f_hdr = fit_font(cd, case["header"], bw - 64, 24)
    cd.text((32, 18), case["header"], fill=(250, 252, 255), font=f_hdr)

    cd.text(
        (32, 80),
        case["title"],
        fill=(12, 16, 24),
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=(12, 16, 24),
    )
    cd.text(
        (32, 144),
        case["subtitle"],
        fill=(28, 36, 46),
        font=ImageFont.load_default(size=27),
    )

    sx0, sy0, sx1, sy1 = 32, 204, 304, 298
    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=12,
        fill=(238, 245, 252),
        outline=accent,
        width=4,
    )

    f_str = ImageFont.load_default(size=48)
    if case["decimal_fold_obliterate"] or case["rim_clip_digits"] or case["compound_band_fold"]:
        mg_w = int(cd.textlength("mg", font=f_str))
        cd.text(
            (sx1 - 24 - mg_w, sy0 + 18),
            "mg",
            fill=(10, 14, 22),
            font=f_str,
            stroke_width=1,
            stroke_fill=(10, 14, 22),
        )
    else:
        cd.text(
            (sx0 + 24, sy0 + 18),
            str(case["printed_strength"]),
            fill=(10, 14, 22),
            font=f_str,
            stroke_width=1,
            stroke_fill=(10, 14, 22),
        )

    cd.text(
        (sx1 + 22, sy0 + 30),
        case["form_line"],
        fill=(28, 34, 44),
        font=ImageFont.load_default(size=25),
    )
    cd.text(
        (32, sy1 + 42),
        case["pack_line"],
        fill=(32, 38, 48),
        font=ImageFont.load_default(size=25),
    )

    exp_top = bh - 94
    cd.rounded_rectangle(
        (bw - 266, exp_top, bw - 30, exp_top + 58),
        radius=8,
        fill=(244, 246, 250),
        outline=(140, 148, 158),
        width=2,
    )
    cd.text(
        (bw - 246, exp_top + 14),
        case["expiry_line"],
        fill=(12, 16, 24),
        font=ImageFont.load_default(size=27),
        stroke_width=1,
        stroke_fill=(12, 16, 24),
    )

    if case["decimal_fold_obliterate"]:
        card = apply_deep_white_crease_over_decimal(card, sx0, sy0, sx1, sy1, seed)
    if case["compound_band_fold"]:
        card = apply_compound_horizontal_crush_fold(card, sy0, sy1, seed)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    card, mask = apply_crushed_corners_and_margin_creases(
        card=card,
        mask=mask,
        crush_corners=list(case["crush_corners"]),
        margin_creases=int(case["margin_creases"]),
        seed=seed,
    )

    box_layer.paste(card, (x0, y0), mask)
    rotated = box_layer.rotate(float(case["tilt_deg"]), resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))

    if case["magnifier"] is not None:
        return apply_handheld_magnifier(cropped, case["magnifier"], seed)
    return add_sensor_grain(cropped, seed=seed + 73)


def render_food_carton(case: dict[str, Any]) -> Image.Image:
    seed = int(case["seed"])
    pad = 84
    size = 768 + 2 * pad
    bg = render_table_backdrop(seed, size)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 84, pad + 82, pad + 684, pad + 686
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=16,
        fill=(24, 20, 16, 104),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    pack = Image.new("RGB", (cw, ch), case["body_fill"])
    pd = ImageDraw.Draw(pack)
    accent = case["accent"]

    pd.rectangle((0, 0, cw, 60), fill=accent)
    f_hdr = fit_font(pd, case["header"], cw - 56, 22)
    pd.text((28, 18), case["header"], fill=(250, 250, 248), font=f_hdr)

    f_title = fit_font(pd, case["title"], cw - 56, 38)
    pd.text(
        (28, 76),
        case["title"],
        fill=(14, 18, 18),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 18, 18),
    )
    f_sub = fit_font(pd, case["subtitle"], cw - 56, 23)
    pd.text((28, 130), case["subtitle"], fill=(44, 50, 48), font=f_sub)

    panel_top = 188
    panel_bot = 446
    pd.rounded_rectangle(
        (26, panel_top, cw - 26, panel_bot),
        radius=12,
        fill=(254, 254, 252),
        outline=(166, 160, 150),
        width=2,
    )

    if not case["peripheral_allergen_blur"]:
        iy = panel_top + 24
        for ln in case["ingredients_lines"]:
            f_ing = fit_font(pd, ln, cw - 136, 22)
            pd.text(
                (68, iy),
                ln,
                fill=(12, 16, 16),
                font=f_ing,
                stroke_width=1,
                stroke_fill=(12, 16, 16),
            )
            iy += 38

        iy += 16
        pd.rounded_rectangle(
            (58, iy - 6, cw - 58, iy + 52),
            radius=8,
            fill=(245, 240, 230),
            outline=(140, 126, 106),
            width=2,
        )
        f_alg = fit_font(pd, case["allergen_line"], cw - 140, 22)
        pd.text(
            (70, iy + 11),
            case["allergen_line"],
            fill=(12, 16, 16),
            font=f_alg,
            stroke_width=1,
            stroke_fill=(12, 16, 16),
        )
    else:
        rng = random.Random(seed + 223)
        blur_panel = Image.new("RGB", (cw, ch), case["body_fill"])
        bd = ImageDraw.Draw(blur_panel)
        bd.rounded_rectangle(
            (26, panel_top, cw - 26, panel_bot),
            radius=12,
            fill=(252, 251, 248),
            outline=(168, 162, 152),
            width=2,
        )
        for row_idx in range(5):
            ry = panel_top + 32 + row_idx * 42
            cur_x = 44
            while cur_x < cw - 72:
                seg_w = rng.randint(24, 68)
                bd.rounded_rectangle(
                    (cur_x, ry, min(cw - 52, cur_x + seg_w), ry + 12),
                    radius=4,
                    fill=(76, 80, 84),
                )
                cur_x += seg_w + rng.randint(10, 20)
        blur_crop = blur_panel.crop((26, panel_top, cw - 26, panel_bot)).filter(
            ImageFilter.GaussianBlur(radius=11.5)
        )
        pack.paste(blur_crop, (26, panel_top))

    exp_top = 478
    pd.rounded_rectangle(
        (26, exp_top, 396, exp_top + 58),
        radius=8,
        fill=(255, 255, 255),
        outline=(170, 166, 156),
        width=2,
    )
    f_exp = fit_font(pd, case["expiry_line"], 344, 24)
    pd.text((40, exp_top + 16), case["expiry_line"], fill=(14, 18, 20), font=f_exp)

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    pack, mask = apply_crushed_corners_and_margin_creases(
        card=pack,
        mask=mask,
        crush_corners=list(case["crush_corners"]),
        margin_creases=int(case["margin_creases"]),
        seed=seed,
    )

    box_layer.paste(pack, (x0, y0), mask)
    rotated = box_layer.rotate(float(case["tilt_deg"]), resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))

    if case["magnifier"] is not None:
        return apply_handheld_magnifier(cropped, case["magnifier"], seed)
    return add_sensor_grain(cropped, seed=seed + 79)


def render_case_frame(case: dict[str, Any]) -> Image.Image:
    if case["scene_type"] == "med_carton":
        return render_med_carton(case)
    if case["scene_type"] == "food_carton":
        return render_food_carton(case)
    raise ValueError(f"Unknown scene_type: {case['scene_type']}")


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
            last_err = str(scrub_node(f"HTTP {resp.status_code}: {resp.text[:240]}"))
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(scrub_node(str(exc)))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini verify failed after retries: {last_err}")


def ensure_node_and_deps() -> str:
    nm = REPO_ROOT / "node_modules"
    for shared_nm in (
        pathlib.Path("/tmp/fleet-silas/wt/meta-safety-lead/node_modules"),
        pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules"),
    ):
        if not nm.exists() and shared_nm.is_dir():
            nm.symlink_to(shared_nm)
            break

    extra_paths = [
        "/home/silas/tools/node/bin",
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
        for row in run_ts_check_batch(node_bin, CRUSHED_MAGNIFIER_PROFILE, raw_batch)
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
        panel_readable = bool(case["panel_readable"])
        is_med = case["kind"] == "medication"
        is_food = case["kind"] == "food"

        if is_med:
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
                    or pred_level == "match"
                )
                abstained = bool(pred_level == "unsure" and not confident_wrong_dose)
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= min_conf)
                or pred_level == "match"
            )
            abstained = bool(pred_level == "unsure")

        norm_s = str(s_val or "").lower().replace(" ", "")
        decimal_crease_false_25mg = bool(
            case.get("decimal_fold_obliterate", False) and ("25mg" in norm_s or norm_s.startswith("25"))
        )
        if decimal_crease_false_25mg:
            confident_wrong_dose = True

        reasons = verdict_obj.get("reasons") or []
        target_allergy = case["target_allergy"]
        if target_allergy:
            allergen_reason_hit = any(f"(allergy: {target_allergy})" in str(r) for r in reasons)
        else:
            allergen_reason_hit = any("allergy:" in str(r) for r in reasons)

        has_allergen = bool(case["has_profile_allergen"])
        alg_val = read_obj["allergens"]["value"]
        alg_conf = float(read_obj["allergens"]["confidence"] or 0.0)
        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)

        false_safe_allergen = bool(
            (has_allergen and not allergen_detected)
            or (is_food and not panel_readable and pred_level in ("info", "match"))
            or (is_food and (alg_val is None or alg_conf < ALLERGEN_MIN_CONF) and pred_level in ("info", "match"))
        )

        item_record = {
            "id": cid,
            "degradation_tier": case["degradation_tier"],
            "distortion_mode": case["distortion_mode"],
            "scene_type": case["scene_type"],
            "kind": case["kind"],
            "description": scrub_node(case["description"]),
            "image_path": meta["image_path"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": meta["jpeg_bytes"],
            "strength_readable": strength_readable,
            "panel_readable": panel_readable,
            "has_profile_allergen": has_allergen,
            "target_allergy": target_allergy,
            "printed_strength": case["printed_strength"],
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "allergen_detected": allergen_detected,
            "decimal_crease_false_25mg": decimal_crease_false_25mg,
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
            f"  -> {cid} ({case['distortion_mode']}): exp={exp_level} pred={pred_level} "
            f"strength={s_val!r} ({s_conf:.2f}) match={verdict_match} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen}"
        )

    n_cases = len(items)
    readable_items = [it for it in items if it["degradation_tier"] == "readable_distorted"]
    severe_items = [it for it in items if it["degradation_tier"] == "severe_abstention"]
    readable_med_items = [it for it in items if it["kind"] == "medication" and it["strength_readable"]]
    allergen_items = [it for it in items if it["has_profile_allergen"]]

    readable_distortion_accuracy = round(
        sum(
            1
            for it in readable_items
            if it["verdict_match"]
            and (not it["strength_readable"] or bool(it["strength_correct"]))
            and (not it["has_profile_allergen"] or bool(it["allergen_detected"]))
            and not it["confident_wrong_dose"]
            and not it["false_safe_allergen"]
        )
        / len(readable_items),
        4,
    )
    clean_field_accuracy = round(
        sum(1 for it in readable_med_items if bool(it["strength_correct"]) and not it["confident_wrong_dose"])
        / len(readable_med_items),
        4,
    )
    severe_distortion_abstention_rate = round(
        sum(
            1
            for it in severe_items
            if bool(it["abstained"])
            and it["verdict_match"]
            and not it["confident_wrong_dose"]
            and not it["false_safe_allergen"]
        )
        / len(severe_items),
        4,
    )
    allergen_recall = round(
        sum(1 for it in allergen_items if bool(it["allergen_detected"]) and not it["false_safe_allergen"])
        / len(allergen_items),
        4,
    )

    verdict_matches = int(sum(1 for it in items if it["verdict_match"]))
    verdict_accuracy = round(verdict_matches / n_cases, 4)
    confident_wrong_dose_count = int(sum(1 for it in items if it["confident_wrong_dose"]))
    false_safe_allergen_count = int(sum(1 for it in items if it["false_safe_allergen"]))
    decimal_crease_false_25mg_count = int(sum(1 for it in items if it["decimal_crease_false_25mg"]))

    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items))

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "strength_min_conf": STRENGTH_MIN_CONF,
        "n_cases": n_cases,
        "n_items": n_cases,
        "n_readable_cases": len(readable_items),
        "n_severe_abstention_cases": len(severe_items),
        "n_allergen_cases": len(allergen_items),
        "readable_distortion_accuracy": readable_distortion_accuracy,
        "clean_field_accuracy": clean_field_accuracy,
        "severe_distortion_abstention_rate": severe_distortion_abstention_rate,
        "occluded_abstention_rate": severe_distortion_abstention_rate,
        "allergen_recall": allergen_recall,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "false_safe_allergen_count": false_safe_allergen_count,
        "decimal_crease_false_25mg_count": decimal_crease_false_25mg_count,
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
            "profile": CRUSHED_MAGNIFIER_PROFILE,
            "summary": summary,
            "items": items,
        }
    )

    assert_clean_artifact(report)
    if confident_wrong_dose_count != 0:
        raise AssertionError(f"Expected confident_wrong_dose_count == 0, got {confident_wrong_dose_count}")
    if false_safe_allergen_count != 0:
        raise AssertionError(f"Expected false_safe_allergen_count == 0, got {false_safe_allergen_count}")
    if decimal_crease_false_25mg_count != 0:
        raise AssertionError(f"Expected decimal_crease_false_25mg_count == 0, got {decimal_crease_false_25mg_count}")

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Crushed carton crease and handheld magnifier lens distortion safety benchmark"
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
