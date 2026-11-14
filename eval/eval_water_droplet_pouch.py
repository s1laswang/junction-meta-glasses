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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "water_droplet_pouch"
OUT_JSON_PATH = REPO_ROOT / "eval" / "water_droplet_pouch_results.json"

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
        "id": "wd_01",
        "degradation_tier": "readable_wet_pouch",
        "surface_mode": "crinkled_pouch_condensation",
        "scene_type": "food_pouch",
        "kind": "food",
        "description": "Crinkled flexible snack pouch with condensation droplets and readable ingredient list: Crunchy Peanut Trail Mix peanut allergen warning",
        "droplet_count": 12,
        "crinkle_amp_px": 1.4,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": False,
        "panel_readable": True,
        "strength_readable": False,
        "has_profile_allergen": True,
        "target_allergy": "peanut",
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (154, 78, 28),
        "body_fill": (244, 238, 226),
        "header": "NORDIC TRAIL KITCHEN",
        "title": "Crunchy Peanut Trail Mix",
        "subtitle": "Resealable Snack Pouch  220 g",
        "ingredients_lines": [
            "Ingredients: wholegrain oats, roasted peanuts (24%),",
            "raisins, sunflower seeds, honey, sea salt.",
        ],
        "allergen_line": "Allergens: Contains peanuts, oats (gluten).",
        "expiry_line": "Best before: 2027-10-18",
        "tilt_deg": -1.5,
    },
    {
        "id": "wd_02",
        "degradation_tier": "readable_wet_pouch",
        "surface_mode": "crinkled_foil_pouch",
        "scene_type": "food_pouch",
        "kind": "food",
        "description": "Wrinkled flexible foil baking pouch with light crease folds and droplets: Hazelnut Cocoa Pouch tree-nut allergen warning",
        "droplet_count": 10,
        "crinkle_amp_px": 1.6,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": False,
        "panel_readable": True,
        "strength_readable": False,
        "has_profile_allergen": True,
        "target_allergy": "tree nuts",
        "expected_strength": None,
        "expected_level": "warning",
        "accent": (104, 54, 36),
        "body_fill": (242, 236, 230),
        "header": "HELSINKI CACAO ROASTERS",
        "title": "Hazelnut Cocoa Pouch",
        "subtitle": "Rich Baking & Drink Mix  250 g",
        "ingredients_lines": [
            "Ingredients: fat-reduced cocoa powder, cane sugar,",
            "roasted hazelnuts (18%), oat flour, vanilla.",
        ],
        "allergen_line": "Allergens: Contains hazelnuts (tree nuts), oats (gluten).",
        "expiry_line": "Best before: 2027-11-12",
        "tilt_deg": 1.6,
    },
    {
        "id": "wd_03",
        "degradation_tier": "readable_wet_pouch",
        "surface_mode": "chilled_carton_condensation",
        "scene_type": "chilled_carton",
        "kind": "food",
        "description": "Chilled fridge carton with beaded condensation water droplets and readable panel: Chilled Barista Oat Drink safe info verdict",
        "droplet_count": 18,
        "crinkle_amp_px": 0.0,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": False,
        "panel_readable": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": None,
        "expected_level": "info",
        "accent": (32, 106, 96),
        "body_fill": (242, 247, 246),
        "header": "NORDIC DAIRY FREE",
        "title": "Chilled Barista Oat Drink",
        "subtitle": "Refrigerated Plant Beverage  1 L",
        "ingredients_lines": [
            "Ingredients: water, oats (11%), rapeseed oil,",
            "calcium carbonate, sea salt.",
        ],
        "allergen_line": "Allergens: Contains oats (gluten).",
        "expiry_line": "Best before: 2027-11-24",
        "tilt_deg": -1.3,
    },
    {
        "id": "wd_04",
        "degradation_tier": "readable_wet_pouch",
        "surface_mode": "sink_splash_carton",
        "scene_type": "med_pack",
        "kind": "medication",
        "is_pouch": False,
        "description": "Pharmacy carton near wet kitchen sink with water droplets off digits: Amlodipin 5 mg evening dose match",
        "droplet_count": 14,
        "crinkle_amp_px": 0.0,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": False,
        "panel_readable": True,
        "strength_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (22, 98, 152),
        "body_fill": (248, 250, 252),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-09",
        "tilt_deg": 1.4,
    },
    {
        "id": "wd_05",
        "degradation_tier": "readable_wet_pouch",
        "surface_mode": "crinkled_travel_pouch",
        "scene_type": "med_pack",
        "kind": "medication",
        "is_pouch": True,
        "description": "Crinkled resealable travel pouch with condensation droplets off digits: Burana 400 mg NSAID avoid warning",
        "droplet_count": 11,
        "crinkle_amp_px": 1.4,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": False,
        "panel_readable": True,
        "strength_readable": True,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "accent": (186, 34, 44),
        "body_fill": (248, 245, 244),
        "header": "ORION PHARMA  TRAVEL PACK",
        "title": "Burana",
        "subtitle": "Active ingredient: ibuprofen",
        "strength_badge": "400 mg",
        "form_line": "film-coated tablets",
        "pack_line": "20 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": -1.6,
    },
    {
        "id": "wd_06",
        "degradation_tier": "obliterated",
        "surface_mode": "deep_pouch_fold_crease",
        "scene_type": "food_pouch",
        "kind": "food",
        "description": "Deep flexible-pouch fold crease shadow obliterating the entire ingredient and allergen block on Savory Crunch Trail Mix: safe abstention",
        "droplet_count": 12,
        "crinkle_amp_px": 2.2,
        "deep_fold_obliterate": True,
        "fold_angle_deg": -3.5,
        "smeared_strength_droplet": False,
        "panel_readable": False,
        "strength_readable": False,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (146, 82, 34),
        "body_fill": (243, 237, 226),
        "header": "NORDIC PANTRY",
        "title": "Savory Crunch Trail Mix",
        "subtitle": "Oven-Roasted Snack Pouch  200 g",
        "ingredients_lines": [],
        "allergen_line": "",
        "expiry_line": "Best before: 2027-10-15",
        "tilt_deg": 1.9,
    },
    {
        "id": "wd_07",
        "degradation_tier": "obliterated",
        "surface_mode": "deep_pouch_fold_crease",
        "scene_type": "food_pouch",
        "kind": "food",
        "description": "Deep crumpled baking-pouch fold crease and wet smudge obliterating the entire ingredient block on Golden Cookie Baking Mix: safe abstention",
        "droplet_count": 14,
        "crinkle_amp_px": 2.4,
        "deep_fold_obliterate": True,
        "fold_angle_deg": 4.2,
        "smeared_strength_droplet": False,
        "panel_readable": False,
        "strength_readable": False,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (128, 72, 42),
        "body_fill": (244, 239, 230),
        "header": "HELSINKI BAKING CO.",
        "title": "Golden Cookie Baking Mix",
        "subtitle": "Sweet Oven-Bake Pouch  350 g",
        "ingredients_lines": [],
        "allergen_line": "",
        "expiry_line": "Best before: 2027-12-05",
        "tilt_deg": -2.1,
    },
    {
        "id": "wd_08",
        "degradation_tier": "obliterated",
        "surface_mode": "smeared_water_droplet_digits",
        "scene_type": "med_pack",
        "kind": "medication",
        "is_pouch": False,
        "description": "Smeared kitchen water droplet and dissolved ink plume distorting strength digits on Metformin: safe abstention",
        "droplet_count": 16,
        "crinkle_amp_px": 0.0,
        "deep_fold_obliterate": False,
        "smeared_strength_droplet": True,
        "panel_readable": True,
        "strength_readable": False,
        "has_profile_allergen": False,
        "target_allergy": None,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 88, 162),
        "body_fill": (247, 249, 252),
        "header": "SANDOZ",
        "title": "Metformin",
        "subtitle": "Active ingredient: metformin",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "tilt_deg": 1.8,
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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 16) -> Any:
    sz = start_size
    while sz > min_size:
        font = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=font) <= max_width:
            return font
        sz -= 1
    return ImageFont.load_default(size=min_size)


def render_kitchen_sink_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (210, 214, 218))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.58)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(228 - 18 * t), int(232 - 18 * t), int(236 - 16 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 37)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(176 - 24 * t) + jitter)),
            max(0, min(255, int(180 - 22 * t) + jitter)),
            max(0, min(255, int(184 - 20 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(128, 134, 140), width=2)

    glint = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glint)
    gd.ellipse((int(size * 0.12), 20, int(size * 0.42), 188), fill=(252, 254, 255, 48))
    gd.ellipse((int(size * 0.62), int(size * 0.66), int(size * 0.90), int(size * 0.84)), fill=(238, 244, 250, 38))
    glint = glint.filter(ImageFilter.GaussianBlur(radius=20.0))
    return Image.alpha_composite(canvas.convert("RGBA"), glint).convert("RGB")


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


def apply_pouch_crinkles(
    img: Image.Image,
    amp_px: float,
    seed: int,
) -> Image.Image:
    if amp_px <= 0.05:
        return img
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rng = random.Random(seed + 53)

    dx = np.zeros((h, w), dtype=np.float32)
    dy = np.zeros((h, w), dtype=np.float32)
    shade = np.zeros((h, w), dtype=np.float32)

    ridges = [
        (rng.uniform(-0.42, -0.24), rng.uniform(0.18, 0.34), rng.uniform(88.0, 118.0)),
        (rng.uniform(0.22, 0.38), rng.uniform(0.62, 0.78), rng.uniform(96.0, 128.0)),
        (rng.uniform(-0.18, 0.18), rng.uniform(0.44, 0.56), rng.uniform(110.0, 142.0)),
    ]
    for slope, y_frac, sigma in ridges:
        y_center = y_frac * h + slope * (xx - 0.5 * w)
        dist = yy - y_center
        env = np.exp(-0.5 * ((dist / sigma) ** 2))
        wave = np.sin(dist / 13.5) * env
        dx += amp_px * 0.55 * wave
        dy += amp_px * 0.85 * wave
        shade += 13.0 * np.cos(dist / 13.5) * env

    warped = bilinear_sample_rgb(arr, xx - dx, yy - dy)
    lit = np.clip(warped + shade[:, :, None], 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(lit, mode="RGB")


def draw_pouch_crimp_seals(card: Image.Image, accent: tuple[int, int, int]) -> None:
    cw, ch = card.size
    cd = ImageDraw.Draw(card)
    seal_top = 26
    seal_bot = 22
    top_col = (
        max(0, accent[0] - 18),
        max(0, accent[1] - 18),
        max(0, accent[2] - 18),
    )
    cd.rectangle((0, 0, cw, seal_top), fill=top_col)
    for ry in range(4, seal_top - 2, 4):
        cd.line((8, ry, cw - 8, ry), fill=(255, 255, 255), width=1)

    cd.polygon([(0, 28), (11, 33), (0, 38)], fill=(212, 216, 220))
    cd.polygon([(cw - 1, 28), (cw - 12, 33), (cw - 1, 38)], fill=(212, 216, 220))

    cd.rectangle((0, ch - seal_bot, cw, ch), fill=(218, 214, 206))
    for ry in range(ch - seal_bot + 4, ch - 2, 4):
        cd.line((10, ry, cw - 10, ry), fill=(184, 180, 172), width=1)

    cd.line((10, seal_top, 10, ch - seal_bot), fill=(255, 255, 255), width=2)
    cd.line((cw - 11, seal_top, cw - 11, ch - seal_bot), fill=(192, 188, 180), width=2)


def apply_condensation_droplets(
    card: Image.Image,
    count: int,
    safe_zones: list[tuple[int, int, int, int]],
    seed: int,
) -> Image.Image:
    if count <= 0 or not safe_zones:
        return card
    arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
    h, w, _ = arr.shape
    rng = random.Random(seed + 89)

    for i in range(count):
        zx0, zy0, zx1, zy1 = safe_zones[i % len(safe_zones)]
        if zx1 - zx0 < 22 or zy1 - zy0 < 20:
            continue
        rx = float(rng.randint(6, 12))
        ry = float(rng.randint(5, 11))
        cx = float(rng.randint(zx0 + int(rx) + 2, max(zx0 + int(rx) + 3, zx1 - int(rx) - 2)))
        cy = float(rng.randint(zy0 + int(ry) + 2, max(zy0 + int(ry) + 3, zy1 - int(ry) - 2)))

        bx0 = max(0, int(math.floor(cx - rx - 5)))
        by0 = max(0, int(math.floor(cy - ry - 5)))
        bx1 = min(w, int(math.ceil(cx + rx + 6)))
        by1 = min(h, int(math.ceil(cy + ry + 6)))
        if bx1 <= bx0 or by1 <= by0:
            continue

        yy, xx = np.mgrid[by0:by1, bx0:bx1].astype(np.float32)
        nx = (xx - cx) / rx
        ny = (yy - cy) / ry
        r2 = nx * nx + ny * ny

        shadow_r2 = ((xx - (cx + 1.8)) / (rx * 1.06)) ** 2 + ((yy - (cy + 2.4)) / (ry * 1.08)) ** 2
        ext_shadow = (shadow_r2 <= 1.0) & (r2 > 1.0)
        patch = arr[by0:by1, bx0:bx1]
        patch[ext_shadow] *= 0.84

        inside = r2 <= 1.0
        if not np.any(inside):
            continue

        nz = np.sqrt(np.maximum(0.0, 1.0 - r2))
        src_x = np.clip(xx - nx * rx * 0.28 * nz, 0.0, float(w - 1))
        src_y = np.clip(yy - ny * ry * 0.28 * nz, 0.0, float(h - 1))
        refracted = bilinear_sample_rgb(arr, src_x, src_y)

        rim_darken = 1.0 - 0.24 * np.clip((r2 - 0.62) / 0.38, 0.0, 1.0)
        caustic = 38.0 * np.exp(-(((nx - 0.28) ** 2 + (ny - 0.38) ** 2) / 0.14)) * (r2 < 0.88)
        specular = 205.0 * np.exp(-(((nx + 0.36) ** 2 + (ny + 0.40) ** 2) / 0.045))

        drop_rgb = refracted * rim_darken[:, :, None] + caustic[:, :, None] + specular[:, :, None]
        patch[inside] = np.clip(drop_rgb[inside], 0.0, 255.0)
        arr[by0:by1, bx0:bx1] = patch

    return Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")


def apply_deep_pouch_fold_obliteration(
    card: Image.Image,
    y_top: int,
    y_bot: int,
    fold_angle_deg: float,
    body_fill: tuple[int, int, int],
    seed: int,
) -> Image.Image:
    arr = np.asarray(card.convert("RGB"), dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rng = random.Random(seed + 131)

    slope = math.tan(math.radians(fold_angle_deg))
    yc = 0.5 * float(y_top + y_bot) + slope * (xx - 0.5 * float(w))
    half_span = 0.5 * float(y_bot - y_top)

    rel = yy - yc
    in_band = np.exp(-0.5 * ((rel / (half_span * 0.62)) ** 2))
    base_rgb = np.array(body_fill, dtype=np.float32)[None, None, :]

    arr = arr * (1.0 - 0.98 * in_band[:, :, None]) + base_rgb * (0.98 * in_band[:, :, None])

    canyon_core = np.exp(-0.5 * ((rel / 26.0) ** 2))
    secondary_pinch = np.exp(-0.5 * (((rel - 42.0) / 19.0) ** 2))
    upper_tuck = np.exp(-0.5 * (((rel + 46.0) / 21.0) ** 2))

    dark_mult = (
        1.0
        - 0.84 * canyon_core
        - 0.66 * secondary_pinch
        - 0.58 * upper_tuck
    )
    dark_mult = np.clip(dark_mult, 0.10, 1.0)
    arr = arr * dark_mult[:, :, None]

    upper_ridge = 96.0 * np.exp(-0.5 * (((rel + 74.0) / 8.5) ** 2))
    mid_ridge = 112.0 * np.exp(-0.5 * (((rel - 18.0) / 6.0) ** 2))
    lower_ridge = 88.0 * np.exp(-0.5 * (((rel - 68.0) / 9.0) ** 2))
    specular_foil = (upper_ridge + mid_ridge + lower_ridge)[:, :, None]
    arr = arr + specular_foil

    for _ in range(9):
        wx_c = rng.uniform(40.0, float(w - 40))
        wy_off = rng.uniform(-55.0, 55.0)
        w_ang = rng.uniform(-0.35, 0.35)
        u_line = (yy - (yc + wy_off)) - w_ang * (xx - wx_c)
        x_env = np.exp(-0.5 * (((xx - wx_c) / 95.0) ** 2))
        crease_streak = 48.0 * np.exp(-0.5 * ((u_line / 3.2) ** 2)) * x_env
        crease_trough = -36.0 * np.exp(-0.5 * (((u_line + 4.5) / 3.5) ** 2)) * x_env
        arr = arr + (crease_streak + crease_trough)[:, :, None]

    out = Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")
    fold_zones = [
        (36, y_top + 14, w - 36, y_bot - 14),
    ]
    return apply_condensation_droplets(out, 9, fold_zones, seed + 307)


def apply_smeared_water_droplet_on_digits(
    card: Image.Image,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    accent: tuple[int, int, int],
    seed: int,
) -> Image.Image:
    rng = random.Random(seed + 199)
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=12,
        fill=(232, 238, 246),
        outline=accent,
        width=3,
    )

    smear = Image.new("RGBA", card.size, (0, 0, 0, 0))
    smd = ImageDraw.Draw(smear)
    for _ in range(34):
        bx = rng.randint(sx0 + 12, sx1 - 16)
        by = rng.randint(sy0 + 14, sy1 - 14)
        rx = rng.randint(14, 34)
        ry = rng.randint(10, 22)
        smd.ellipse(
            (bx - rx, by - ry, bx + rx, by + ry),
            fill=(20, 36, 66, rng.randint(170, 238)),
        )
    smear = smear.filter(ImageFilter.GaussianBlur(radius=6.2))
    composed = Image.alpha_composite(card.convert("RGBA"), smear).convert("RGB")

    arr = np.asarray(composed, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    cx = 0.5 * float(sx0 + sx1)
    cy = 0.5 * float(sy0 + sy1)
    rx_puddle = 0.5 * float(sx1 - sx0) + 14.0
    ry_puddle = 0.5 * float(sy1 - sy0) + 10.0

    nx = (xx - cx) / rx_puddle
    ny = (yy - cy) / ry_puddle
    wobble = 0.08 * np.sin(4.0 * np.arctan2(ny, nx + 1e-5))
    r2 = nx * nx + ny * ny + wobble

    inside = r2 <= 1.0
    nz = np.sqrt(np.maximum(0.0, 1.0 - np.minimum(1.0, r2)))
    src_x = np.clip(xx - nx * 24.0 * nz, 0.0, float(w - 1))
    src_y = np.clip(yy - ny * 18.0 * nz, 0.0, float(h - 1))
    warped = bilinear_sample_rgb(arr, src_x, src_y)

    meniscus = 1.0 - 0.28 * np.clip((r2 - 0.68) / 0.32, 0.0, 1.0)
    glare_band = 215.0 * np.exp(-(((nx + 0.18) / 0.52) ** 2 + ((ny + 0.28) / 0.22) ** 2))
    caustic_arc = 55.0 * np.exp(-(((nx - 0.22) / 0.48) ** 2 + ((ny - 0.36) / 0.24) ** 2))

    wet_patch = warped * meniscus[:, :, None] + glare_band[:, :, None] + caustic_arc[:, :, None]
    arr[inside] = np.clip(wet_patch[inside], 0.0, 255.0)

    return Image.fromarray(np.clip(np.round(arr), 0.0, 255.0).astype(np.uint8), mode="RGB")


def render_food_pouch_or_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_kitchen_sink_backdrop(size, seed)
    is_pouch = case["scene_type"] == "food_pouch"

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 82, pad + 76, pad + 686, pad + 692
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=20 if is_pouch else 14,
        fill=(22, 24, 28, 96),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    pack = Image.new("RGB", (cw, ch), case["body_fill"])
    cd = ImageDraw.Draw(pack)

    header_top = 26 if is_pouch else 0
    header_h = 58 if is_pouch else 64
    cd.rectangle((0, header_top, cw, header_top + header_h), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], cw - 56, 22)
    cd.text((28, header_top + 17), case["header"], fill=(248, 250, 248), font=f_hdr)

    title_y = header_top + header_h + 16
    f_title = fit_font(cd, case["title"], cw - 56, 38)
    cd.text(
        (28, title_y),
        case["title"],
        fill=(14, 18, 18),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 18, 18),
    )

    sub_y = title_y + 52
    f_sub = fit_font(cd, case["subtitle"], cw - 56, 23)
    cd.text((28, sub_y), case["subtitle"], fill=(42, 50, 48), font=f_sub)

    panel_top = 208
    panel_bot = 446
    if not case["deep_fold_obliterate"]:
        cd.rounded_rectangle(
            (26, panel_top, cw - 26, panel_bot),
            radius=12,
            fill=(254, 254, 252),
            outline=(166, 162, 152),
            width=2,
        )
        iy = panel_top + 20
        for ln in case["ingredients_lines"]:
            f_ing = fit_font(cd, ln, cw - 76, 24)
            cd.text(
                (40, iy),
                ln,
                fill=(12, 16, 16),
                font=f_ing,
                stroke_width=1,
                stroke_fill=(12, 16, 16),
            )
            iy += 38

        iy += 14
        cd.rounded_rectangle(
            (36, iy - 6, cw - 36, iy + 52),
            radius=8,
            fill=(245, 241, 232),
            outline=(142, 128, 108),
            width=2,
        )
        f_alg = fit_font(cd, case["allergen_line"], cw - 92, 22)
        cd.text(
            (46, iy + 10),
            case["allergen_line"],
            fill=(12, 16, 16),
            font=f_alg,
            stroke_width=1,
            stroke_fill=(12, 16, 16),
        )

    exp_top = 474
    cd.rounded_rectangle(
        (26, exp_top, 392, exp_top + 58),
        radius=8,
        fill=(255, 255, 255),
        outline=(172, 168, 158),
        width=2,
    )
    f_exp = fit_font(cd, case["expiry_line"], 340, 24)
    cd.text((40, exp_top + 16), case["expiry_line"], fill=(14, 18, 20), font=f_exp)

    if is_pouch:
        draw_pouch_crimp_seals(pack, case["accent"])
        pack = apply_pouch_crinkles(pack, float(case["crinkle_amp_px"]), seed)

    if case["deep_fold_obliterate"]:
        pack = apply_deep_pouch_fold_obliteration(
            card=pack,
            y_top=196,
            y_bot=454,
            fold_angle_deg=float(case.get("fold_angle_deg", -3.0)),
            body_fill=case["body_fill"],
            seed=seed,
        )

    safe_zones = [
        (cw - 178, header_top + 6, cw - 24, header_top + header_h - 6),
        (cw - 165, sub_y - 4, cw - 24, panel_top - 6),
        (404, exp_top - 4, cw - 24, exp_top + 64),
        (36, exp_top + 64, cw - 36, ch - 30),
    ]
    if not is_pouch:
        safe_zones.append((36, panel_bot - 42, cw - 36, panel_bot - 6))
    pack = apply_condensation_droplets(pack, int(case["droplet_count"]), safe_zones, seed)

    mask = Image.new("L", (cw, ch), 0)
    if is_pouch:
        pts: list[tuple[int, int]] = []
        for py in range(0, ch, 12):
            pinch = int(round(6.0 * math.sin(math.pi * py / float(ch))))
            pts.append((pinch, py))
        pts.append((0, ch - 1))
        pts.append((cw - 1, ch - 1))
        for py in range(ch - 1, -1, -12):
            pinch = int(round(6.0 * math.sin(math.pi * py / float(ch))))
            pts.append((cw - 1 - pinch, py))
        ImageDraw.Draw(mask).polygon(pts, fill=255)
    else:
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=14, fill=255)

    box_layer.paste(pack, (x0, y0), mask)
    if not is_pouch:
        ImageDraw.Draw(box_layer).rounded_rectangle(
            (x0, y0, x1 - 1, y1 - 1),
            radius=14,
            outline=(168, 174, 178, 255),
            width=3,
        )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_med_pack(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_kitchen_sink_backdrop(size, seed)
    is_pouch = bool(case.get("is_pouch", False))

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 106, pad + 700, pad + 654
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(22, 24, 28, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card = Image.new("RGB", (bw, bh), case["body_fill"])
    cd = ImageDraw.Draw(card)

    header_top = 26 if is_pouch else 0
    header_h = 58 if is_pouch else 64
    cd.rectangle((0, header_top, bw, header_top + header_h), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], bw - 56, 23)
    cd.text((28, header_top + 18), case["header"], fill=(248, 250, 252), font=f_hdr)

    title_y = header_top + header_h + 20
    cd.text(
        (28, title_y),
        case["title"],
        fill=(10, 14, 20),
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=(10, 14, 20),
    )
    sub_y = title_y + 64
    cd.text(
        (28, sub_y),
        case["subtitle"],
        fill=(26, 32, 40),
        font=ImageFont.load_default(size=26),
    )

    sx0, sy0, sx1, sy1 = 28, sub_y + 52, 276, sub_y + 142
    if case["strength_badge"]:
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
            (sx1 + 22, sy0 + 30),
            case["form_line"],
            fill=(24, 30, 38),
            font=ImageFont.load_default(size=25),
        )

    pack_y = sy1 + 42
    if case["pack_line"]:
        cd.text(
            (28, pack_y),
            case["pack_line"],
            fill=(28, 34, 42),
            font=ImageFont.load_default(size=25),
        )

    if case["expiry_line"]:
        exp_top = bh - 104 if is_pouch else bh - 92
        cd.rounded_rectangle(
            (bw - 266, exp_top, bw - 28, exp_top + 58),
            radius=8,
            fill=(244, 246, 249),
            outline=(138, 146, 156),
            width=2,
        )
        cd.text(
            (bw - 246, exp_top + 14),
            case["expiry_line"],
            fill=(10, 14, 20),
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=(10, 14, 20),
        )

    if is_pouch:
        draw_pouch_crimp_seals(card, case["accent"])
        card = apply_pouch_crinkles(card, float(case["crinkle_amp_px"]), seed)

    if case["smeared_strength_droplet"]:
        card = apply_smeared_water_droplet_on_digits(
            card=card,
            sx0=sx0,
            sy0=sy0,
            sx1=sx1,
            sy1=sy1,
            accent=case["accent"],
            seed=seed,
        )

    safe_zones = [
        (bw - 210, header_top + 6, bw - 26, header_top + header_h - 6),
        (bw - 220, title_y, bw - 28, sub_y + 30),
        (220, pack_y - 6, bw - 280, bh - 36),
        (28, bh - 88, 220, bh - 32),
    ]
    card = apply_condensation_droplets(card, int(case["droplet_count"]), safe_zones, seed)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(168, 176, 184, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261146 + idx * 173
    if case["scene_type"] in ("food_pouch", "chilled_carton"):
        img = render_food_pouch_or_carton(case, seed)
    else:
        img = render_med_pack(case, seed)
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

        if case["kind"] == "medication":
            if sr:
                strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
                confident_wrong_dose = bool(
                    (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                    or (exp_level != "match" and pred_level == "match")
                )
            else:
                strength_correct = None
                confident_wrong_dose = bool(
                    (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                    or s_conf >= STRENGTH_MIN_CONF
                    or pred_level == "match"
                )
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or pred_level == "match"
            )

        abstained = pred_level == "unsure"

        reasons = verdict_obj.get("reasons") or []
        target_allergy = case["target_allergy"]
        if target_allergy:
            allergen_reason_hit = any(f"(allergy: {target_allergy})" in str(r) for r in reasons)
        else:
            allergen_reason_hit = any("allergy:" in str(r) for r in reasons)

        has_allergen = bool(case["has_profile_allergen"])
        is_food = case["kind"] == "food"
        panel_readable = bool(case["panel_readable"])
        alg_val = read_obj["allergens"]["value"]
        alg_conf = float(read_obj["allergens"]["confidence"])

        false_safe_allergen = bool(
            (has_allergen and not (pred_level == "warning" and allergen_reason_hit))
            or (is_food and not panel_readable and pred_level in ("info", "match"))
            or (is_food and (alg_val is None or alg_conf < ALLERGEN_MIN_CONF) and pred_level in ("info", "match"))
        )

        item_record = {
            "id": cid,
            "degradation_tier": case["degradation_tier"],
            "surface_mode": case["surface_mode"],
            "scene_type": case["scene_type"],
            "kind": case["kind"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "droplet_count": case["droplet_count"],
            "crinkle_amp_px": case["crinkle_amp_px"],
            "panel_readable": panel_readable,
            "strength_readable": sr,
            "has_profile_allergen": has_allergen,
            "target_allergy": target_allergy,
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "allergen_detected": bool(pred_level == "warning" and allergen_reason_hit),
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
            f"[{cid}] tier={case['degradation_tier']} mode={case['surface_mode']} "
            f"exp={exp_level} pred={pred_level} match={verdict_match} "
            f"strength={s_val!r} conf={s_conf:.2f} alg={alg_val!r} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    readable_items = [it for it in items_out if it["degradation_tier"] == "readable_wet_pouch"]
    obliterated_items = [it for it in items_out if it["degradation_tier"] == "obliterated"]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    readable_wet_pouch_accuracy = round(
        sum(
            1
            for it in readable_items
            if it["verdict_match"]
            and (not it["strength_readable"] or bool(it["strength_correct"]))
            and (not it["has_profile_allergen"] or bool(it["allergen_detected"]))
            and not it["false_safe_allergen"]
            and not it["confident_wrong_dose"]
        )
        / len(readable_items),
        4,
    )

    obliterated_abstention_rate = round(
        sum(
            1
            for it in obliterated_items
            if it["abstained"]
            and not it["false_safe_allergen"]
            and not it["confident_wrong_dose"]
        )
        / len(obliterated_items),
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
        "n_readable_wet_pouch": len(readable_items),
        "n_obliterated": len(obliterated_items),
        "readable_wet_pouch_accuracy": readable_wet_pouch_accuracy,
        "obliterated_abstention_rate": obliterated_abstention_rate,
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
