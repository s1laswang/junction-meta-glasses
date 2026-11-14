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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "braille_tactile_markers"
OUT_JSON_PATH = REPO_ROOT / "eval" / "braille_tactile_markers_results.json"

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
        "id": "bt_01",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_braille_and_two_bands",
        "scene_type": "med_box",
        "description": "EU Art. 56a embossed Braille dots across face + 2 blue evening rubber bands in right margin: Amlodipin 5 mg match",
        "braille_rows": 2,
        "rubber_bands": 2,
        "band_color": (38, 98, 186),
        "bumpon_color": None,
        "marker_note": "ILTA / EVENING",
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
        "tilt_deg": -1.5,
    },
    {
        "id": "bt_02",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_braille_and_bumpon",
        "scene_type": "med_box",
        "description": "Embossed Braille dots + raised orange tactile Bumpon warning dot in safe corner: Burana 400 mg NSAID avoid warning",
        "braille_rows": 2,
        "rubber_bands": 0,
        "band_color": None,
        "bumpon_color": (226, 94, 28),
        "marker_note": "PAIN ONLY",
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
        "id": "bt_03",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_braille_and_band",
        "scene_type": "med_box",
        "description": "Embossed Braille dots + green rubber band in safe right zone: Metformin 500 mg EXP 2025-01 expired pack warning",
        "braille_rows": 2,
        "rubber_bands": 1,
        "band_color": (42, 138, 84),
        "bumpon_color": (32, 36, 42),
        "marker_note": "WITH MEALS",
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
        "tilt_deg": -1.3,
    },
    {
        "id": "bt_04",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_braille_and_bumpon",
        "scene_type": "med_box",
        "description": "Embossed Braille dots + yellow tactile Bumpon dot + caregiver note: Amlodipin 10 mg wrong-dose warning vs 5 mg profile",
        "braille_rows": 2,
        "rubber_bands": 1,
        "band_color": (196, 152, 44),
        "bumpon_color": (232, 184, 28),
        "marker_note": "CHECK DOSE",
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
        "tilt_deg": 1.8,
    },
    {
        "id": "bt_05",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_food_tactile",
        "scene_type": "food_pack",
        "description": "Raised red tactile warning Bumpon + pantry rubber band off-panel: Hazelnut Praline Wafers tree-nut allergen warning",
        "braille_rows": 1,
        "rubber_bands": 1,
        "band_color": (184, 52, 48),
        "bumpon_color": (214, 42, 42),
        "marker_note": "GUEST SNACK",
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
        "expiry_line": "Best before: 2027-10-15",
        "tilt_deg": 1.4,
    },
    {
        "id": "bt_06",
        "tactile_tier": "readable_tactile",
        "occlusion_mode": "safe_zone_food_tactile",
        "scene_type": "food_pack",
        "description": "Raised green tactile Bumpon dot + rubber band off-panel: Plain Oat Drink safe info verdict",
        "braille_rows": 1,
        "rubber_bands": 1,
        "band_color": (46, 138, 102),
        "bumpon_color": (38, 156, 92),
        "marker_note": "SAFE OAT",
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
        "expiry_line": "Best before: 2027-12-10",
        "tilt_deg": -1.2,
    },
    {
        "id": "bt_07",
        "tactile_tier": "occluded_tactile",
        "occlusion_mode": "wide_rubber_band_over_strength",
        "scene_type": "med_box",
        "description": "Zero-guess trap: opaque tan rubber band + EVENING PILL caregiver note covering Amlodipin strength digits",
        "braille_rows": 2,
        "rubber_bands": 0,
        "band_color": (198, 162, 108),
        "bumpon_color": None,
        "marker_note": "EVENING PILL",
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
        "tilt_deg": -1.9,
    },
    {
        "id": "bt_08",
        "tactile_tier": "occluded_tactile",
        "occlusion_mode": "bumpon_stickers_over_digits",
        "scene_type": "med_box",
        "description": "Zero-guess trap: two 3D black hemispherical tactile Bumpon dots stuck directly over Metformin dosage digits",
        "braille_rows": 2,
        "rubber_bands": 0,
        "band_color": None,
        "bumpon_color": (22, 24, 28),
        "marker_note": "TWICE DAILY",
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
        "tilt_deg": 2.0,
    },
    {
        "id": "bt_09",
        "tactile_tier": "occluded_tactile",
        "occlusion_mode": "sharpie_scrawl_over_strength",
        "scene_type": "med_box",
        "description": "Zero-guess trap: thick black felt-tip caregiver marker scrawl obliterating Panadol strength badge",
        "braille_rows": 2,
        "rubber_bands": 0,
        "band_color": None,
        "bumpon_color": None,
        "marker_note": "FOR FEVER",
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
        "tilt_deg": -2.1,
    },
    {
        "id": "bt_10",
        "tactile_tier": "occluded_tactile",
        "occlusion_mode": "braille_dymo_tape_over_strength",
        "scene_type": "med_box",
        "description": "Zero-guess trap: opaque blue Dymo Braille embossing tape strip stuck directly over Amlodipin strength digits",
        "braille_rows": 2,
        "rubber_bands": 0,
        "band_color": None,
        "bumpon_color": None,
        "marker_note": "1 TAB EVENING",
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
        "expiry_line": "EXP 2027-10",
        "tilt_deg": 1.9,
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


def render_table_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (218, 214, 206))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.57)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(232 - 18 * t), int(228 - 18 * t), int(220 - 16 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 29)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(186 - 24 * t) + jitter)),
            max(0, min(255, int(168 - 22 * t) + jitter)),
            max(0, min(255, int(148 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(138, 122, 104), width=2)
    return canvas


def draw_embossed_braille_grid(
    card: Image.Image,
    x_start: int,
    y_start: int,
    n_cells: int,
    n_rows: int,
    rng: random.Random,
) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for row_idx in range(n_rows):
        base_y = y_start + row_idx * 34
        for cell_idx in range(n_cells):
            base_x = x_start + cell_idx * 22
            for dot_r in range(3):
                for dot_c in range(2):
                    if rng.random() < 0.42:
                        continue
                    dx = base_x + dot_c * 8
                    dy = base_y + dot_r * 8
                    od.ellipse((dx + 1, dy + 1, dx + 6, dy + 6), fill=(116, 122, 132, 82))
                    od.ellipse((dx - 1, dy - 1, dx + 4, dy + 4), fill=(255, 255, 255, 165))
                    od.ellipse((dx, dy, dx + 4, dy + 4), fill=(242, 244, 248, 90))
    soft = overlay.filter(ImageFilter.GaussianBlur(radius=0.45))
    card.paste(Image.alpha_composite(card.convert("RGBA"), soft).convert("RGB"))


def draw_vertical_rubber_bands(
    card: Image.Image,
    count: int,
    band_color: tuple[int, int, int] | None,
    x_anchor: int,
) -> None:
    if count <= 0 or band_color is None:
        return
    cw, ch = card.size
    overlay = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for idx in range(count):
        bx = x_anchor + idx * 24
        od.rectangle((bx + 3, 0, bx + 16, ch), fill=(18, 18, 22, 72))
        od.rectangle((bx, 0, bx + 13, ch), fill=(band_color[0], band_color[1], band_color[2], 238))
        hi = (
            min(255, band_color[0] + 44),
            min(255, band_color[1] + 44),
            min(255, band_color[2] + 44),
            160,
        )
        od.line((bx + 3, 0, bx + 3, ch), fill=hi, width=2)
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def draw_tactile_bumpon(
    card: Image.Image,
    cx: int,
    cy: int,
    radius: int,
    color: tuple[int, int, int],
) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse(
        (cx - radius + 2, cy - radius + 4, cx + radius + 4, cy + radius + 6),
        fill=(18, 18, 22, 105),
    )
    od.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        fill=(color[0], color[1], color[2], 252),
        outline=(max(0, color[0] - 32), max(0, color[1] - 32), max(0, color[2] - 32), 255),
        width=2,
    )
    spec_r = max(3, radius // 3)
    od.ellipse(
        (cx - radius // 2, cy - radius // 2, cx - radius // 2 + spec_r * 2, cy - radius // 2 + spec_r * 2),
        fill=(255, 255, 255, 148),
    )
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def draw_caregiver_marker_note(card: Image.Image, text: str, x: int, y: int) -> None:
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle(
        (x - 8, y - 4, x + 196, y + 34),
        radius=6,
        fill=(252, 248, 214, 215),
        outline=(188, 174, 112, 210),
        width=2,
    )
    od.text(
        (x, y + 3),
        text,
        fill=(24, 26, 36, 238),
        font=ImageFont.load_default(size=20),
        stroke_width=1,
        stroke_fill=(24, 26, 36, 200),
    )
    card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def apply_tactile_occlusion_trap(
    card: Image.Image,
    mode: str,
    sx0: int,
    sy0: int,
    sx1: int,
    sy1: int,
    marker_note: str,
    seed: int,
) -> None:
    cw, _ = card.size
    rng = random.Random(seed + 311)
    overlay = Image.new("RGBA", card.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)

    if mode == "wide_rubber_band_over_strength":
        by0 = sy0 + 6
        by1 = sy1 - 6
        od.rectangle((0, by0 + 5, cw, by1 + 9), fill=(22, 18, 14, 92))
        od.rectangle((0, by0, cw, by1), fill=(198, 162, 108, 255))
        od.line((0, by0 + 4, cw, by0 + 4), fill=(228, 198, 148, 220), width=3)
        od.line((0, by1 - 3, cw, by1 - 3), fill=(154, 120, 74, 235), width=3)
        od.text(
            (sx0 + 18, by0 + 22),
            marker_note,
            fill=(26, 22, 18, 245),
            font=ImageFont.load_default(size=28),
            stroke_width=1,
            stroke_fill=(26, 22, 18, 245),
        )
        card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))
        return

    if mode == "bumpon_stickers_over_digits":
        cd = ImageDraw.Draw(card)
        cd.text(
            (sx0 + 158, sy0 + 20),
            "mg",
            fill=(16, 20, 28),
            font=ImageFont.load_default(size=44),
        )
        card_out = card.copy()
        draw_tactile_bumpon(card_out, sx0 + 52, (sy0 + sy1) // 2, 38, (20, 22, 26))
        draw_tactile_bumpon(card_out, sx0 + 114, (sy0 + sy1) // 2, 38, (20, 22, 26))
        card.paste(card_out)
        return

    if mode == "sharpie_scrawl_over_strength":
        for _ in range(26):
            x_a = rng.randint(sx0 - 6, sx0 + 60)
            y_a = rng.randint(sy0 + 6, sy1 - 8)
            x_b = rng.randint(sx1 - 54, sx1 + 10)
            y_b = rng.randint(sy0 + 6, sy1 - 8)
            od.line((x_a, y_a, x_b, y_b), fill=(14, 14, 18, 252), width=rng.randint(12, 18))
        for cx in range(sx0 + 12, sx1 - 12, 18):
            od.ellipse((cx - 16, sy0 + 10, cx + 16, sy1 - 10), fill=(12, 12, 16, 255))
        soft = overlay.filter(ImageFilter.GaussianBlur(radius=0.8))
        card.paste(Image.alpha_composite(card.convert("RGBA"), soft).convert("RGB"))
        return

    if mode == "braille_dymo_tape_over_strength":
        tx0 = sx0 - 10
        ty0 = sy0 + 10
        tx1 = sx1 + 14
        ty1 = sy1 - 8
        od.rounded_rectangle((tx0 + 3, ty0 + 4, tx1 + 5, ty1 + 6), radius=4, fill=(16, 20, 28, 95))
        od.rounded_rectangle(
            (tx0, ty0, tx1, ty1),
            radius=4,
            fill=(24, 78, 152, 255),
            outline=(16, 56, 114, 255),
            width=2,
        )
        for cell in range(9):
            bx = tx0 + 18 + cell * 26
            for dr in range(3):
                for dc in range(2):
                    if (cell + dr + dc) % 2 == 0:
                        px = bx + dc * 8
                        py = ty0 + 16 + dr * 12
                        od.ellipse((px + 1, py + 1, px + 6, py + 6), fill=(12, 42, 92, 210))
                        od.ellipse((px, py, px + 5, py + 5), fill=(214, 232, 255, 240))
        card.paste(Image.alpha_composite(card.convert("RGBA"), overlay).convert("RGB"))


def render_med_box_case(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_table_backdrop(size, seed)
    rng = random.Random(seed + 17)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 106, pad + 704, pad + 662
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

    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    cd.text(
        (28, 18),
        case["header"],
        fill=(248, 249, 250),
        font=ImageFont.load_default(size=23),
    )

    cd.text(
        (28, 82),
        case["title"],
        fill=(12, 16, 22),
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=(12, 16, 22),
    )
    cd.text(
        (28, 146),
        case["subtitle"],
        fill=(30, 36, 44),
        font=ImageFont.load_default(size=25),
    )

    sx0, sy0, sx1, sy1 = 28, 198, 274, 288
    cd.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=12,
        fill=(240, 245, 250),
        outline=case["accent"],
        width=3,
    )
    if case["strength_badge"]:
        cd.text(
            (sx0 + 22, sy0 + 18),
            case["strength_badge"],
            fill=(10, 14, 20),
            font=ImageFont.load_default(size=46),
            stroke_width=1,
            stroke_fill=(10, 14, 20),
        )

    if case["form_line"]:
        cd.text(
            (sx1 + 20, sy0 + 30),
            case["form_line"],
            fill=(30, 36, 44),
            font=ImageFont.load_default(size=25),
        )

    if case["pack_line"]:
        cd.text(
            (28, 324),
            case["pack_line"],
            fill=(30, 36, 44),
            font=ImageFont.load_default(size=24),
        )

    if case["expiry_line"]:
        cd.rounded_rectangle(
            (28, 462, 276, 520),
            radius=8,
            fill=(244, 245, 247),
            outline=(128, 136, 146),
            width=2,
        )
        cd.text(
            (46, 476),
            case["expiry_line"],
            fill=(12, 16, 22),
            font=ImageFont.load_default(size=27),
            stroke_width=1,
            stroke_fill=(12, 16, 22),
        )

    draw_embossed_braille_grid(
        card=card,
        x_start=32,
        y_start=376,
        n_cells=14,
        n_rows=int(case["braille_rows"]),
        rng=rng,
    )

    if case["tactile_tier"] == "readable_tactile":
        if case["marker_note"]:
            draw_caregiver_marker_note(card, case["marker_note"], bw - 268, 86)
        if case["bumpon_color"] is not None:
            draw_tactile_bumpon(card, bw - 148, 396, 22, case["bumpon_color"])
        draw_vertical_rubber_bands(card, int(case["rubber_bands"]), case["band_color"], bw - 68)
    else:
        if case["marker_note"] and case["occlusion_mode"] != "wide_rubber_band_over_strength":
            draw_caregiver_marker_note(card, case["marker_note"], bw - 252, 86)
        apply_tactile_occlusion_trap(
            card=card,
            mode=case["occlusion_mode"],
            sx0=sx0,
            sy0=sy0,
            sx1=sx1,
            sy1=sy1,
            marker_note=case["marker_note"] or "PILL",
            seed=seed,
        )

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
    bg = render_table_backdrop(size, seed)
    rng = random.Random(seed + 53)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 80, pad + 88, pad + 688, pad + 680
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 92),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    carton = Image.new("RGB", (cw, ch), (249, 246, 239))
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 64), fill=case["accent"])
    cd.text(
        (26, 19),
        case["header"],
        fill=(248, 249, 246),
        font=ImageFont.load_default(size=23),
    )
    cd.text(
        (26, 84),
        case["title"],
        fill=(14, 18, 16),
        font=ImageFont.load_default(size=36),
        stroke_width=1,
        stroke_fill=(14, 18, 16),
    )
    cd.text(
        (26, 138),
        case["subtitle"],
        fill=(40, 48, 44),
        font=ImageFont.load_default(size=23),
    )

    cd.rounded_rectangle(
        (24, 188, cw - 76, 412),
        radius=12,
        fill=(253, 252, 248),
        outline=(162, 156, 144),
        width=2,
    )
    iy = 206
    for ln in case["ingredients_lines"]:
        cd.text(
            (36, iy),
            ln,
            fill=(14, 18, 18),
            font=ImageFont.load_default(size=22),
            stroke_width=1,
            stroke_fill=(14, 18, 18),
        )
        iy += 34

    iy += 12
    cd.rounded_rectangle(
        (32, iy - 6, cw - 84, iy + 52),
        radius=8,
        fill=(244, 240, 231),
        outline=(138, 124, 104),
        width=2,
    )
    cd.text(
        (42, iy + 10),
        case["allergen_line"],
        fill=(14, 18, 18),
        font=ImageFont.load_default(size=18),
    )

    cd.rounded_rectangle(
        (24, 444, 344, 502),
        radius=8,
        fill=(255, 255, 255),
        outline=(168, 162, 152),
        width=2,
    )
    cd.text(
        (38, 460),
        case["expiry_line"],
        fill=(14, 18, 20),
        font=ImageFont.load_default(size=23),
    )

    draw_embossed_braille_grid(carton, 32, 520, 12, int(case["braille_rows"]), rng)
    if case["marker_note"]:
        draw_caregiver_marker_note(carton, case["marker_note"], cw - 280, 518)
    if case["bumpon_color"] is not None:
        draw_tactile_bumpon(carton, cw - 118, 468, 22, case["bumpon_color"])
    draw_vertical_rubber_bands(carton, int(case["rubber_bands"]), case["band_color"], cw - 48)

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
    seed = 20261188 + idx * 151
    if case["scene_type"] == "med_box":
        img = render_med_box_case(case, seed)
    else:
        img = render_food_pack_case(case, seed)
    assert img.size == (768, 768)
    arr = np.asarray(img, dtype=np.float32)
    rng = np.random.default_rng(seed)
    noisy = np.clip(np.round(arr + rng.normal(0.0, 1.4, size=arr.shape)), 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(noisy, mode="RGB")


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
            "tactile_tier": case["tactile_tier"],
            "occlusion_mode": case["occlusion_mode"],
            "scene_type": case["scene_type"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "braille_rows": case["braille_rows"],
            "rubber_bands": case["rubber_bands"],
            "marker_note": case["marker_note"],
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
            f"[{cid}] tier={case['tactile_tier']} mode={case['occlusion_mode']} exp={exp_level} "
            f"pred={pred_level} match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    readable_tactile_items = [it for it in items_out if it["tactile_tier"] == "readable_tactile"]
    occluded_tactile_items = [it for it in items_out if it["tactile_tier"] == "occluded_tactile"]
    readable_med_items = [it for it in items_out if it["strength_readable"]]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    readable_tactile_accuracy = round(
        sum(
            1
            for it in readable_tactile_items
            if it["verdict_match"]
            and (not it["strength_readable"] or bool(it["strength_correct"]))
            and not it["false_safe_allergen"]
        )
        / len(readable_tactile_items),
        4,
    )
    clean_field_accuracy = round(
        sum(1 for it in readable_med_items if bool(it["strength_correct"])) / len(readable_med_items),
        4,
    )
    occluded_tactile_abstention_rate = round(
        sum(1 for it in occluded_tactile_items if it["abstained"] and not it["confident_wrong_dose"])
        / len(occluded_tactile_items),
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
        "strength_min_conf": STRENGTH_MIN_CONF,
        "n_items": n_items,
        "n_readable_tactile": len(readable_tactile_items),
        "n_occluded_tactile": len(occluded_tactile_items),
        "readable_tactile_accuracy": readable_tactile_accuracy,
        "occluded_tactile_abstention_rate": occluded_tactile_abstention_rate,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_tactile_abstention_rate,
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
