import base64
import datetime
import io
import json
import math
import os
import pathlib
import random
import shutil
import statistics
import subprocess
import time
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
BATCH2_OUT_DIR = REPO_ROOT / "eval" / "synthetic" / "batch2"
OUT_JSON_PATH = REPO_ROOT / "eval" / "results_batch2.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80

DEMO_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipine",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "b2_01",
        "language": "en",
        "style": "wrapper",
        "brand": "NORDIC HARVEST",
        "title": "Granola Bar",
        "subtitle": "Honey & Oat Snack Bar  45 g",
        "body_lines": [
            "Ingredients: Oats, honey, roasted hazelnuts (14%), cocoa.",
            "Best before: 2027-10-18",
        ],
        "accent": (146, 84, 38),
        "pack_fill": (236, 224, 204),
        "tilt_seed": 101,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Granola bar with roasted hazelnuts (14%) in English",
    },
    {
        "id": "b2_02",
        "language": "en",
        "style": "jar",
        "brand": "CHOCO VELVET",
        "title": "Chocolate Spread",
        "subtitle": "Smooth Cocoa Spread  Net wt 350 g",
        "body_lines": [
            "Ingredients: Sugar, vegetable oil (arachis oil), cocoa, skim milk.",
            "Best before: 2027-12-01",
        ],
        "accent": (98, 52, 32),
        "jar_tint": (74, 40, 24),
        "tilt_seed": 102,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Chocolate spread synonym trap with arachis oil (= peanut)",
    },
    {
        "id": "b2_03",
        "language": "fi",
        "style": "carton",
        "brand": "KOTILEIPOMO",
        "title": "Voikeksi",
        "subtitle": "Perinteinen leipomokeksi  200 g",
        "body_lines": [
            "Ainesosat: vehnajauho, sokeri, voi. Voi sisaltaa hasselpahkinaa ja mantelia.",
            "Parasta ennen: 2027-10-05",
        ],
        "accent": (168, 108, 42),
        "pack_fill": (250, 246, 236),
        "tilt_seed": 103,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Finnish cookie box with may-contain hazelnut and almond warning",
    },
    {
        "id": "b2_04",
        "language": "sv",
        "style": "pouch",
        "brand": "SKANDIA SNACKS",
        "title": "Kvallssnacks",
        "subtitle": "Krispiga rostade snacks  150 g",
        "body_lines": [
            "Ingredienser: rostade jordnotter, havssalt.",
            "Bast fore: 2027-09-30",
        ],
        "accent": (182, 58, 36),
        "pack_fill": (244, 232, 212),
        "tilt_seed": 104,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Swedish roasted peanut snack (rostade jordnotter)",
    },
    {
        "id": "b2_05",
        "language": "en",
        "style": "drink_carton",
        "brand": "PURE NORDIC",
        "title": "Oat Drink",
        "subtitle": "Plant-Based Original  1 L",
        "body_lines": [
            "Ingredients: Water, oats (10%), rapeseed oil, sea salt.",
            "Best before: 2027-11-15",
        ],
        "accent": (46, 112, 152),
        "pack_fill": (244, 248, 250),
        "tilt_seed": 105,
        "expected_level": "info",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Safe oat drink in English with future best-before date",
    },
    {
        "id": "b2_06",
        "language": "fi",
        "style": "carton",
        "brand": "POHJAN MYLLY",
        "title": "Kaurapuuro",
        "subtitle": "Kaurahiutale  500 g",
        "body_lines": [
            "Ainesosat: taysjyvakaura (100%).",
            "Parasta ennen 2027-08",
        ],
        "accent": (48, 118, 78),
        "pack_fill": (246, 247, 241),
        "tilt_seed": 106,
        "expected_level": "info",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Finnish 100% wholegrain oat porridge carton",
    },
    {
        "id": "b2_07",
        "language": "en",
        "style": "wrapper",
        "brand": "LUBECK CONFECTIONERY",
        "title": "Almond Marzipan",
        "subtitle": "Classic Marzipan Loaf  100 g",
        "body_lines": [
            "Ingredients: sugar, almonds (42%), glucose syrup.",
            "Best before: 2027-09-15",
        ],
        "accent": (158, 36, 48),
        "pack_fill": (248, 238, 222),
        "tilt_seed": 107,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Almond marzipan wrapper with 42% almonds",
    },
    {
        "id": "b2_08",
        "language": "en",
        "style": "jar",
        "brand": "VERDE CUCINA",
        "title": "Basil Pesto",
        "subtitle": "Italian Herb Pasta Sauce  190 g",
        "body_lines": [
            "Ingredients: basil, olive oil, cashews, garlic, salt.",
            "Best before: 2027-07-22",
        ],
        "accent": (46, 118, 54),
        "jar_tint": (62, 102, 44),
        "tilt_seed": 108,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Cashew basil pesto jar",
    },
    {
        "id": "b2_09",
        "language": "en",
        "style": "tub",
        "brand": "AEGEAN DAIRY",
        "title": "Plain Greek Yogurt",
        "subtitle": "Natural Strained Yogurt  400 g",
        "body_lines": [
            "Ingredients: pasteurized milk, live yogurt cultures.",
            "Best before 2027-06-20",
        ],
        "accent": (32, 96, 164),
        "pack_fill": (250, 252, 254),
        "tilt_seed": 109,
        "expected_level": "info",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Plain Greek yogurt (milk only, safe for nut-only profile)",
    },
    {
        "id": "b2_10",
        "language": "en",
        "style": "drink_carton",
        "brand": "DAILY GRAIN",
        "title": "Oat Drink Classic",
        "subtitle": "Unsweetened Oat Beverage  1 L",
        "body_lines": [
            "Ingredients: water, oats, salt.",
            "Best before: 2025-03-10",
        ],
        "accent": (72, 104, 128),
        "pack_fill": (245, 246, 244),
        "tilt_seed": 110,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Expired oat drink carton (Best before 2025-03-10)",
    },
    {
        "id": "b2_11",
        "language": "en",
        "style": "front_cookie_box",
        "brand": "Artisan Bakery",
        "title": "Butter Cookies",
        "subtitle": "Net wt 250g",
        "body_lines": [],
        "accent": (34, 58, 108),
        "pack_fill": (248, 242, 228),
        "tilt_seed": 111,
        "expected_level": "unsure",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": False,
        "expected_strength": None,
        "description": "Front of cookie box with no ingredient list printed",
    },
    {
        "id": "b2_12",
        "language": "en",
        "style": "occluded_wrapper",
        "brand": "TRAIL PEAK",
        "title": "Cereal Snack Bar",
        "subtitle": "Net wt 45 g",
        "body_lines": [],
        "accent": (132, 78, 42),
        "pack_fill": (238, 228, 212),
        "tilt_seed": 112,
        "expected_level": "unsure",
        "expected_kind": "food",
        "has_profile_allergen": False,
        "panel_readable": False,
        "expected_strength": None,
        "description": "Snack wrapper with thumb and glare completely covering ingredients",
    },
    {
        "id": "b2_13",
        "language": "en",
        "style": "blurred_pouch",
        "brand": "NATURE MIX",
        "title": "Snack Mix",
        "subtitle": "150 g",
        "body_lines": [
            "Ingredients: oats, seeds, dried fruit.",
            "Best before: 2027-08-12",
        ],
        "accent": (88, 118, 68),
        "pack_fill": (236, 234, 224),
        "tilt_seed": 113,
        "expected_level": "unsure",
        "expected_kind": "unreadable",
        "has_profile_allergen": False,
        "panel_readable": False,
        "expected_strength": None,
        "description": "Heavily blurred food pouch (GaussianBlur(16)) unreadable",
    },
    {
        "id": "b2_14",
        "language": "en",
        "style": "carton",
        "brand": "HEARTH BAKERY",
        "title": "Bakery Brownie Pack",
        "subtitle": "Rich Dark Chocolate Slices  220 g",
        "body_lines": [
            "Ingredients: dark chocolate, butter, walnuts, eggs, flour.",
            "Best before: 2027-05-18",
        ],
        "accent": (86, 44, 56),
        "pack_fill": (248, 244, 240),
        "tilt_seed": 114,
        "expected_level": "warning",
        "expected_kind": "food",
        "has_profile_allergen": True,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Walnut brownie pack with walnuts, milk, egg, wheat",
    },
    {
        "id": "b2_15",
        "language": "en",
        "style": "supplement_bottle",
        "brand": "NORDIC PHARMA",
        "title": "Vitamin D3 1000 IU",
        "subtitle": "Colecalciferol 1000 IU (25 mcg)",
        "body_lines": [
            "Daily supplement: 1 tablet once daily.",
            "90 tablets    EXP 2027-12",
        ],
        "accent": (204, 128, 24),
        "pack_fill": (252, 252, 250),
        "tilt_seed": 115,
        "expected_level": "warning",
        "expected_kind": "medication",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": "1000 IU",
        "description": "Vitamin D3 1000 IU supplement bottle not on medication list",
    },
    {
        "id": "b2_16",
        "language": "en",
        "style": "lotion_tube",
        "brand": "DERMA SOFT",
        "title": "Hand Cream",
        "subtitle": "Unscented Daily Moisturizing Lotion  100 ml",
        "body_lines": [
            "Aqua, Glycerin, Cetearyl Alcohol",
            "External cosmetic skincare use",
        ],
        "accent": (58, 134, 142),
        "pack_fill": (250, 252, 252),
        "tilt_seed": 116,
        "expected_level": "info",
        "expected_kind": "other",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Unscented hand lotion cosmetic tube",
    },
    {
        "id": "b2_17",
        "language": "en",
        "style": "dish_soap",
        "brand": "SPARKLE CLEAN",
        "title": "Hand Dishwashing Liquid",
        "subtitle": "Lemon  500 ml",
        "body_lines": [
            "Hand Dishwashing Liquid Lemon 500 ml",
            "Household dish detergent for glassware and pots",
        ],
        "accent": (42, 138, 68),
        "pack_fill": (244, 232, 92),
        "tilt_seed": 117,
        "expected_level": "info",
        "expected_kind": "other",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expected_strength": None,
        "description": "Household lemon dish soap bottle 500 ml",
    },
    {
        "id": "b2_18",
        "language": "n/a",
        "style": "dark_occluded",
        "brand": "",
        "title": "",
        "subtitle": "",
        "body_lines": [],
        "accent": (0, 0, 0),
        "pack_fill": (0, 0, 0),
        "tilt_seed": 118,
        "expected_level": "unsure",
        "expected_kind": "unreadable",
        "has_profile_allergen": False,
        "panel_readable": False,
        "expected_strength": None,
        "description": "Completely dark occluded camera frame",
    },
]


def load_env_fallback() -> None:
    comment_prefix = chr(35)
    candidates = [
        pathlib.Path.home() / "momin" / ".env",
        REPO_ROOT / ".env",
    ]
    for env_path in candidates:
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(comment_prefix):
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


def sanitize_dashes(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace("\u2014", " - ").replace("\u2013", "-")
    if isinstance(val, list):
        return [sanitize_dashes(x) for x in val]
    if isinstance(val, dict):
        return {k: sanitize_dashes(v) for k, v in val.items()}
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


def solve_perspective_coeffs(
    dst_pts: list[tuple[float, float]],
    src_pts: list[tuple[float, float]],
) -> list[float]:
    matrix: list[list[float]] = []
    rhs: list[float] = []
    for (dx, dy), (sx, sy) in zip(dst_pts, src_pts):
        matrix.append([dx, dy, 1.0, 0.0, 0.0, 0.0, -sx * dx, -sx * dy])
        rhs.append(sx)
        matrix.append([0.0, 0.0, 0.0, dx, dy, 1.0, -sy * dx, -sy * dy])
        rhs.append(sy)

    n = 8
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(matrix[r][col]))
        matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
        rhs[col], rhs[pivot] = rhs[pivot], rhs[col]
        div = matrix[col][col]
        for j in range(col, n):
            matrix[col][j] /= div
        rhs[col] /= div
        for r in range(n):
            if r == col:
                continue
            factor = matrix[r][col]
            if abs(factor) < 1e-12:
                continue
            for j in range(col, n):
                matrix[r][j] -= factor * matrix[col][j]
            rhs[r] -= factor * rhs[col]
    return rhs


def wrap_text_px(draw: ImageDraw.ImageDraw, text: str, font: Any, max_width: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        cand = f"{cur} {w}"
        if draw.textlength(cand, font=font) <= max_width:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def draw_wrapped_block(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    lines_in: list[str],
    font_size: int,
    max_width: int,
    fill: tuple[int, int, int] = (18, 22, 28),
    line_gap: int = 8,
) -> int:
    font = ImageFont.load_default(size=font_size)
    cur_y = y
    for paragraph in lines_in:
        for wl in wrap_text_px(draw, paragraph, font, max_width):
            draw.text((x, cur_y), wl, fill=fill, font=font)
            cur_y += font_size + line_gap
        cur_y += 6
    return cur_y


def make_kitchen_canvas(size: int, pad: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    canvas = Image.new("RGB", (size, size), (226, 220, 210))
    draw = ImageDraw.Draw(canvas)
    counter_y = pad + 540
    for y in range(counter_y):
        t = y / max(1, counter_y)
        r = int(236 - 24 * t)
        g = int(230 - 24 * t)
        b = int(220 - 22 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(counter_y, size):
        t = (y - counter_y) / max(1, size - counter_y)
        grain = rng.randint(-3, 3)
        r = max(0, min(255, int(186 - 28 * t) + grain))
        g = max(0, min(255, int(154 - 24 * t) + grain))
        b = max(0, min(255, int(118 - 18 * t) + grain))
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, counter_y, size, counter_y), fill=(138, 108, 78), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((pad + 30, pad + 20, pad + 220, pad + 190), fill=(255, 252, 240, 38))
    bd.ellipse((pad + 540, pad + 50, pad + 730, pad + 240), fill=(240, 248, 255, 32))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=28.0))
    return Image.alpha_composite(canvas.convert("RGBA"), bokeh).convert("RGB")


def add_drop_shadow(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    radius: int = 18,
) -> Image.Image:
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    x0, y0, x1, y1 = box
    sd.rounded_rectangle((x0 + 10, y0 + 16, x1 + 16, y1 + 20), radius=radius, fill=(28, 22, 16, 88))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    return Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")


def apply_subtle_perspective_and_grain(scene: Image.Image, pad: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    w, h = scene.size
    dx_tl = rng.uniform(8.0, 20.0)
    dy_tl = rng.uniform(6.0, 16.0)
    dx_tr = rng.uniform(8.0, 20.0)
    dy_tr = rng.uniform(8.0, 18.0)
    dx_br = rng.uniform(8.0, 18.0)
    dy_br = rng.uniform(6.0, 16.0)
    dx_bl = rng.uniform(6.0, 18.0)
    dy_bl = rng.uniform(8.0, 18.0)

    src_pts = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    dst_pts = [
        (dx_tl, dy_tl),
        (float(w) - dx_tr, dy_tr),
        (float(w) - dx_br, float(h) - dy_br),
        (dx_bl, float(h) - dy_bl),
    ]
    coeffs = solve_perspective_coeffs(dst_pts, src_pts)
    warped = scene.transform((w, h), Image.Transform.PERSPECTIVE, coeffs, resample=Image.Resampling.BICUBIC)
    cropped = warped.crop((pad, pad, pad + 768, pad + 768)).convert("RGB")

    grain_small = Image.new("L", (192, 192))
    g_bytes = bytes(128 + rng.randint(-9, 9) for _ in range(192 * 192))
    grain_small.frombytes(g_bytes)
    grain_full = grain_small.resize((768, 768), Image.Resampling.BILINEAR)
    r_ch, g_ch, b_ch = cropped.split()
    r_out = Image.blend(r_ch, grain_full, 0.035)
    g_out = Image.blend(g_ch, grain_full, 0.035)
    b_out = Image.blend(b_ch, grain_full, 0.035)
    return Image.merge("RGB", (r_out, g_out, b_out))


def draw_mini_barcode(draw: ImageDraw.ImageDraw, x0: int, y0: int, w: int = 126, h: int = 56) -> None:
    draw.rectangle((x0, y0, x0 + w, y0 + h), fill=(255, 255, 255), outline=(204, 208, 212), width=1)
    for i in range(24):
        bx = x0 + 10 + i * 4
        bw = 3 if i % 5 == 0 else (2 if i % 2 == 0 else 1)
        draw.rectangle((bx, y0 + 8, bx + bw, y0 + h - 8), fill=(24, 26, 28))


def render_case_image(case: dict[str, Any]) -> Image.Image:
    style = case["style"]
    seed = int(case["tilt_seed"])

    if style == "dark_occluded":
        rng = random.Random(seed)
        img = Image.new("RGB", (768, 768))
        raw = bytearray(768 * 768 * 3)
        idx = 0
        for y in range(768):
            vy = (y - 384.0) / 384.0
            for x in range(768):
                vx = (x - 384.0) / 384.0
                vig = max(0.0, 1.0 - 0.55 * (vx * vx + vy * vy))
                base = int(6 * vig)
                raw[idx] = max(0, min(14, base + rng.randint(0, 4)))
                raw[idx + 1] = max(0, min(12, base + rng.randint(0, 3)))
                raw[idx + 2] = max(0, min(12, base + rng.randint(0, 3)))
                idx += 3
        img.frombytes(bytes(raw))
        return img.filter(ImageFilter.GaussianBlur(radius=1.2))

    pad = 64
    size = 768 + 2 * pad
    scene = make_kitchen_canvas(size, pad, seed)

    if style in ("wrapper", "occluded_wrapper"):
        x0, y0, x1, y1 = pad + 88, pad + 188, pad + 680, pad + 560
        scene = add_drop_shadow(scene, (x0, y0, x1, y1), radius=14)
        draw = ImageDraw.Draw(scene)
        for crimp_x in (x0 - 22, x1):
            draw.rectangle((crimp_x, y0 + 10, crimp_x + 22, y1 - 10), fill=(198, 194, 186), outline=(156, 150, 142), width=2)
            for ry in range(y0 + 16, y1 - 12, 10):
                draw.line((crimp_x + 3, ry, crimp_x + 19, ry), fill=(148, 142, 134), width=2)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=14, fill=case["pack_fill"], outline=(168, 158, 144), width=3)
        draw.rounded_rectangle((x0, y0, x1, y0 + 96), radius=14, fill=case["accent"])
        draw.rectangle((x0, y0 + 64, x1, y0 + 96), fill=case["accent"])
        draw.text((x0 + 28, y0 + 14), case["brand"], fill=(246, 242, 234), font=ImageFont.load_default(size=19))
        draw.text((x0 + 28, y0 + 40), case["title"], fill=(255, 255, 255), font=ImageFont.load_default(size=38))
        draw.text((x0 + 28, y0 + 108), case["subtitle"], fill=(48, 42, 36), font=ImageFont.load_default(size=21))

        px0, py0, px1, py1 = x0 + 24, y0 + 144, x1 - 24, y1 - 24
        draw.rounded_rectangle((px0, py0, px1, py1), radius=10, fill=(252, 252, 250), outline=(196, 190, 180), width=2)
        if style == "wrapper":
            draw_wrapped_block(draw, px0 + 18, py0 + 18, case["body_lines"], font_size=24, max_width=(px1 - px0 - 36))
            foil = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            fd = ImageDraw.Draw(foil)
            fd.polygon([(x0 + 40, y0), (x0 + 110, y0), (x0 + 60, y1), (x0 + 10, y1)], fill=(255, 255, 255, 28))
            foil = foil.filter(ImageFilter.GaussianBlur(radius=8.0))
            scene = Image.alpha_composite(scene.convert("RGBA"), foil).convert("RGB")
            return apply_subtle_perspective_and_grain(scene, pad, seed)

        draw.text((px0 + 18, py0 + 14), "Ingredients:", fill=(24, 28, 34), font=ImageFont.load_default(size=22))
        cropped = apply_subtle_perspective_and_grain(scene, pad, seed).convert("RGBA")
        shadow_l = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        sld = ImageDraw.Draw(shadow_l)
        sld.rounded_rectangle((150, 320, 690, 566), radius=64, fill=(24, 18, 14, 175))
        shadow_l = shadow_l.filter(ImageFilter.GaussianBlur(radius=14.0))
        cropped = Image.alpha_composite(cropped, shadow_l)

        thumb = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((176, 330, 548, 542), radius=76, fill=(210, 164, 138, 255), outline=(168, 122, 98, 255), width=3)
        td.rounded_rectangle((440, 352, 532, 496), radius=34, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
        td.arc((330, 348, 364, 516), start=110, end=250, fill=(164, 116, 92, 210), width=3)
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=0.9))
        cropped = Image.alpha_composite(cropped, thumb)

        glare = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glare)
        gd.ellipse((390, 290, 710, 565), fill=(255, 255, 252, 255))
        gd.ellipse((430, 320, 680, 535), fill=(255, 255, 255, 255))
        glare = glare.filter(ImageFilter.GaussianBlur(radius=18.0))
        return Image.alpha_composite(cropped, glare).convert("RGB")

    if style == "jar":
        jx0, jy0, jx1, jy1 = pad + 132, pad + 118, pad + 636, pad + 642
        scene = add_drop_shadow(scene, (jx0, jy0 + 40, jx1, jy1), radius=48)
        draw = ImageDraw.Draw(scene)
        draw.rounded_rectangle((jx0 + 36, jy0, jx1 - 36, jy0 + 58), radius=10, fill=(212, 186, 118), outline=(156, 132, 74), width=3)
        for rx in range(jx0 + 48, jx1 - 44, 12):
            draw.line((rx, jy0 + 6, rx, jy0 + 52), fill=(176, 150, 88), width=2)
        draw.rounded_rectangle((jx0, jy0 + 48, jx1, jy1), radius=54, fill=case["jar_tint"], outline=(52, 34, 24), width=3)

        lx0, ly0, lx1, ly1 = jx0 + 18, jy0 + 124, jx1 - 18, jy1 - 56
        draw.rounded_rectangle((lx0, ly0, lx1, ly1), radius=14, fill=(252, 250, 245), outline=(188, 180, 168), width=2)
        draw.rounded_rectangle((lx0, ly0, lx1, ly0 + 86), radius=14, fill=case["accent"])
        draw.rectangle((lx0, ly0 + 56, lx1, ly0 + 86), fill=case["accent"])
        draw.text((lx0 + 24, ly0 + 12), case["brand"], fill=(246, 240, 230), font=ImageFont.load_default(size=18))
        draw.text((lx0 + 24, ly0 + 36), case["title"], fill=(255, 255, 255), font=ImageFont.load_default(size=36))
        draw.text((lx0 + 24, ly0 + 98), case["subtitle"], fill=(46, 40, 36), font=ImageFont.load_default(size=20))
        draw.line((lx0 + 24, ly0 + 132, lx1 - 24, ly0 + 132), fill=(210, 204, 194), width=2)
        draw_wrapped_block(draw, lx0 + 24, ly0 + 148, case["body_lines"], font_size=23, max_width=(lx1 - lx0 - 48))

        spec = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        spd = ImageDraw.Draw(spec)
        spd.rounded_rectangle((jx0 + 26, jy0 + 66, jx0 + 68, jy1 - 24), radius=16, fill=(255, 255, 255, 34))
        spec = spec.filter(ImageFilter.GaussianBlur(radius=9.0))
        scene = Image.alpha_composite(scene.convert("RGBA"), spec).convert("RGB")
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style in ("carton", "drink_carton"):
        x0, y0, x1, y1 = pad + 116, pad + 108, pad + 652, pad + 646
        scene = add_drop_shadow(scene, (x0, y0, x1, y1), radius=16)
        draw = ImageDraw.Draw(scene)
        if style == "drink_carton":
            draw.polygon([(x0 + 28, y0 - 34), (x1 - 28, y0 - 34), (x1, y0 + 10), (x0, y0 + 10)], fill=(228, 234, 238), outline=(172, 180, 188))
            draw.ellipse((x0 + 216, y0 - 48, x0 + 312, y0 - 6), fill=(245, 247, 249), outline=(176, 182, 188), width=2)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(174, 178, 182), width=3)
        draw.rounded_rectangle((x0, y0, x1, y0 + 104), radius=16, fill=case["accent"])
        draw.rectangle((x0, y0 + 72, x1, y0 + 104), fill=case["accent"])
        draw.text((x0 + 28, y0 + 14), case["brand"], fill=(244, 248, 252), font=ImageFont.load_default(size=19))
        draw.text((x0 + 28, y0 + 42), case["title"], fill=(255, 255, 255), font=ImageFont.load_default(size=38))
        draw.text((x0 + 28, y0 + 120), case["subtitle"], fill=(42, 48, 56), font=ImageFont.load_default(size=22))

        px0, py0, px1, py1 = x0 + 24, y0 + 164, x1 - 24, y1 - 98
        draw.rounded_rectangle((px0, py0, px1, py1), radius=10, fill=(255, 255, 255), outline=(196, 202, 208), width=2)
        draw_wrapped_block(draw, px0 + 20, py0 + 22, case["body_lines"], font_size=24, max_width=(px1 - px0 - 40))
        draw_mini_barcode(draw, x1 - 160, y1 - 80)
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style in ("pouch", "blurred_pouch"):
        x0, y0, x1, y1 = pad + 126, pad + 104, pad + 642, pad + 648
        scene = add_drop_shadow(scene, (x0, y0, x1, y1), radius=24)
        draw = ImageDraw.Draw(scene)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=26, fill=case["pack_fill"], outline=(168, 160, 148), width=3)
        draw.line((x0 + 16, y0 + 28, x1 - 16, y0 + 28), fill=(152, 144, 132), width=3)
        draw.rounded_rectangle((x0 + 16, y0 + 48, x1 - 16, y0 + 146), radius=14, fill=case["accent"])

        if style == "pouch":
            draw.text((x0 + 36, y0 + 60), case["brand"], fill=(250, 244, 236), font=ImageFont.load_default(size=19))
            draw.text((x0 + 36, y0 + 88), case["title"], fill=(255, 255, 255), font=ImageFont.load_default(size=38))
            draw.text((x0 + 36, y0 + 164), case["subtitle"], fill=(46, 40, 34), font=ImageFont.load_default(size=22))
            px0, py0, px1, py1 = x0 + 26, y0 + 208, x1 - 26, y1 - 44
            draw.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(253, 252, 249), outline=(196, 188, 176), width=2)
            draw_wrapped_block(draw, px0 + 20, py0 + 24, case["body_lines"], font_size=25, max_width=(px1 - px0 - 40))
            return apply_subtle_perspective_and_grain(scene, pad, seed)

        draw.text((x0 + 36, y0 + 68), case["brand"], fill=(242, 242, 236), font=ImageFont.load_default(size=14))
        draw.text((x0 + 36, y0 + 96), case["title"], fill=(248, 248, 244), font=ImageFont.load_default(size=18))
        px0, py0, px1, py1 = x0 + 28, y0 + 208, x1 - 28, y1 - 56
        draw.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(248, 247, 242))
        draw_wrapped_block(draw, px0 + 20, py0 + 24, case["body_lines"], font_size=13, max_width=(px1 - px0 - 40), fill=(92, 94, 90))
        sharp = apply_subtle_perspective_and_grain(scene, pad, seed)
        return sharp.filter(ImageFilter.GaussianBlur(radius=16))

    if style == "tub":
        x0, y0, x1, y1 = pad + 118, pad + 156, pad + 650, pad + 612
        scene = add_drop_shadow(scene, (x0 + 14, y0, x1 - 14, y1), radius=24)
        draw = ImageDraw.Draw(scene)
        draw.polygon([(x0, y0 + 38), (x1, y0 + 38), (x1 - 34, y1), (x0 + 34, y1)], fill=case["pack_fill"], outline=(182, 190, 198))
        draw.rounded_rectangle((x0 - 14, y0, x1 + 14, y0 + 44), radius=12, fill=case["accent"], outline=(24, 72, 128), width=2)
        lx0, ly0, lx1, ly1 = x0 + 38, y0 + 66, x1 - 38, y1 - 28
        draw.rounded_rectangle((lx0, ly0, lx1, ly1), radius=14, fill=(255, 255, 255), outline=(196, 206, 218), width=2)
        draw.rounded_rectangle((lx0, ly0, lx1, ly0 + 84), radius=14, fill=case["accent"])
        draw.rectangle((lx0, ly0 + 54, lx1, ly0 + 84), fill=case["accent"])
        draw.text((lx0 + 22, ly0 + 10), case["brand"], fill=(238, 246, 255), font=ImageFont.load_default(size=18))
        draw.text((lx0 + 22, ly0 + 34), case["title"], fill=(255, 255, 255), font=ImageFont.load_default(size=34))
        draw.text((lx0 + 22, ly0 + 98), case["subtitle"], fill=(38, 48, 60), font=ImageFont.load_default(size=20))
        draw_wrapped_block(draw, lx0 + 22, ly0 + 140, case["body_lines"], font_size=23, max_width=(lx1 - lx0 - 44))
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style == "front_cookie_box":
        x0, y0, x1, y1 = pad + 112, pad + 124, pad + 656, pad + 628
        scene = add_drop_shadow(scene, (x0, y0, x1, y1), radius=16)
        draw = ImageDraw.Draw(scene)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(182, 162, 122), width=3)
        draw.rounded_rectangle((x0 + 18, y0 + 18, x1 - 18, y1 - 18), radius=12, outline=case["accent"], width=3)
        draw.rounded_rectangle((x0 + 52, y0 + 52, x1 - 52, y0 + 132), radius=10, fill=case["accent"])
        f_brand = ImageFont.load_default(size=34)
        f_title = ImageFont.load_default(size=48)
        f_sub = ImageFont.load_default(size=26)
        bw = draw.textlength(case["brand"], font=f_brand)
        tw = draw.textlength(case["title"], font=f_title)
        sw = draw.textlength(case["subtitle"], font=f_sub)
        cx_mid = (x0 + x1) // 2
        draw.text((int(cx_mid - bw / 2), y0 + 72), case["brand"], fill=(252, 244, 218), font=f_brand)
        draw.text((int(cx_mid - tw / 2), y0 + 164), case["title"], fill=(28, 42, 78), font=f_title)
        for cx, cy in ((pad + 300, pad + 420), (pad + 410, pad + 404), (pad + 474, pad + 448)):
            draw.ellipse((cx - 56, cy - 56, cx + 56, cy + 56), fill=(224, 178, 102), outline=(184, 136, 66), width=3)
            draw.ellipse((cx - 34, cy - 34, cx + 34, cy + 34), outline=(202, 154, 82), width=2)
        draw.text((int(cx_mid - sw / 2), y1 - 68), case["subtitle"], fill=(42, 52, 74), font=f_sub)
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style == "supplement_bottle":
        bx0, by0, bx1, by1 = pad + 178, pad + 104, pad + 590, pad + 648
        scene = add_drop_shadow(scene, (bx0, by0 + 60, bx1, by1), radius=36)
        draw = ImageDraw.Draw(scene)
        draw.rounded_rectangle((bx0 + 48, by0, bx1 - 48, by0 + 70), radius=12, fill=(246, 248, 250), outline=(182, 188, 194), width=3)
        for rx in range(bx0 + 60, bx1 - 56, 10):
            draw.line((rx, by0 + 8, rx, by0 + 62), fill=(208, 214, 220), width=2)
        draw.rounded_rectangle((bx0, by0 + 62, bx1, by1), radius=42, fill=(138, 76, 24), outline=(92, 48, 14), width=3)
        lx0, ly0, lx1, ly1 = bx0 + 14, by0 + 132, bx1 - 14, by1 - 44
        draw.rounded_rectangle((lx0, ly0, lx1, ly1), radius=10, fill=case["pack_fill"], outline=(202, 198, 188), width=2)
        draw.rounded_rectangle((lx0, ly0, lx1, ly0 + 54), radius=10, fill=case["accent"])
        draw.rectangle((lx0, ly0 + 34, lx1, ly0 + 54), fill=case["accent"])
        draw.text((lx0 + 22, ly0 + 14), case["brand"], fill=(255, 252, 244), font=ImageFont.load_default(size=20))
        draw.text((lx0 + 22, ly0 + 74), case["title"], fill=(18, 24, 30), font=ImageFont.load_default(size=36))
        draw.text((lx0 + 22, ly0 + 124), case["subtitle"], fill=(46, 54, 62), font=ImageFont.load_default(size=21))
        draw.line((lx0 + 22, ly0 + 162, lx1 - 22, ly0 + 162), fill=(214, 216, 218), width=2)
        draw_wrapped_block(draw, lx0 + 22, ly0 + 178, case["body_lines"], font_size=22, max_width=(lx1 - lx0 - 44))
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style == "lotion_tube":
        tx0, ty0, tx1, ty1 = pad + 172, pad + 88, pad + 596, pad + 656
        scene = add_drop_shadow(scene, (tx0 + 18, ty0, tx1 - 18, ty1), radius=22)
        draw = ImageDraw.Draw(scene)
        draw.rectangle((tx0, ty0, tx1, ty0 + 28), fill=(228, 234, 236), outline=(176, 184, 188), width=2)
        draw.polygon([(tx0, ty0 + 28), (tx1, ty0 + 28), (tx1 - 42, ty1 - 74), (tx0 + 42, ty1 - 74)], fill=case["pack_fill"], outline=(182, 192, 196))
        draw.rounded_rectangle((tx0 + 86, ty1 - 74, tx1 - 86, ty1), radius=12, fill=(236, 242, 244), outline=(172, 182, 186), width=2)
        draw.rectangle((tx0 + 22, ty0 + 68, tx1 - 22, ty0 + 126), fill=case["accent"])
        draw.text((tx0 + 44, ty0 + 84), case["brand"], fill=(246, 252, 252), font=ImageFont.load_default(size=24))
        draw.text((tx0 + 44, ty0 + 152), case["title"], fill=(20, 32, 38), font=ImageFont.load_default(size=42))
        draw_wrapped_block(draw, tx0 + 48, ty0 + 214, [case["subtitle"]], font_size=20, max_width=(tx1 - tx0 - 96), fill=(52, 66, 72))
        draw.line((tx0 + 52, ty0 + 284, tx1 - 52, ty0 + 284), fill=(202, 212, 216), width=2)
        draw_wrapped_block(draw, tx0 + 52, ty0 + 304, case["body_lines"], font_size=22, max_width=(tx1 - tx0 - 104))
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    if style == "dish_soap":
        sx0, sy0, sx1, sy1 = pad + 168, pad + 88, pad + 600, pad + 654
        scene = add_drop_shadow(scene, (sx0, sy0 + 80, sx1, sy1), radius=38)
        draw = ImageDraw.Draw(scene)
        draw.rounded_rectangle((sx0 + 154, sy0, sx1 - 154, sy0 + 52), radius=8, fill=case["accent"], outline=(28, 98, 46), width=2)
        draw.rounded_rectangle((sx0 + 124, sy0 + 46, sx1 - 124, sy0 + 96), radius=10, fill=(242, 244, 240), outline=(182, 188, 180), width=2)
        draw.rounded_rectangle((sx0, sy0 + 88, sx1, sy1), radius=52, fill=case["pack_fill"], outline=(196, 178, 52), width=3)
        lx0, ly0, lx1, ly1 = sx0 + 24, sy0 + 168, sx1 - 24, sy1 - 52
        draw.rounded_rectangle((lx0, ly0, lx1, ly1), radius=16, fill=(254, 254, 252), outline=(184, 194, 182), width=2)
        draw.rounded_rectangle((lx0, ly0, lx1, ly0 + 62), radius=16, fill=case["accent"])
        draw.rectangle((lx0, ly0 + 38, lx1, ly0 + 62), fill=case["accent"])
        draw.text((lx0 + 22, ly0 + 18), case["brand"], fill=(246, 255, 248), font=ImageFont.load_default(size=22))
        draw_wrapped_block(draw, lx0 + 22, ly0 + 80, [case["title"]], font_size=32, max_width=(lx1 - lx0 - 44), fill=(18, 34, 22))
        draw.text((lx0 + 22, ly0 + 168), case["subtitle"], fill=(34, 108, 48), font=ImageFont.load_default(size=28))
        draw.line((lx0 + 22, ly0 + 212, lx1 - 22, ly0 + 212), fill=(214, 220, 212), width=2)
        draw_wrapped_block(draw, lx0 + 22, ly0 + 228, case["body_lines"], font_size=21, max_width=(lx1 - lx0 - 44))
        return apply_subtle_perspective_and_grain(scene, pad, seed)

    raise ValueError(f"Unsupported style: {style}")


def encode_jpeg_b64(img: Image.Image, save_path: pathlib.Path) -> str:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    save_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii")


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
                        "tokens_in": int(usage_meta.get("promptTokenCount") or 0),
                        "tokens_out": int(
                            usage_meta.get("candidatesTokenCount")
                            or usage_meta.get("responseTokenCount")
                            or 0
                        ),
                        "tokens_thinking": int(usage_meta.get("thoughtsTokenCount") or 0),
                    }
                    return parsed, elapsed_ms, tok
                last_err = "Empty non-thought JSON output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini verify call failed after retries: {last_err}")


def resolve_tsx_cmd() -> list[str]:
    tsx_candidates = [
        REPO_ROOT / "node_modules" / ".bin" / "tsx",
        pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules/.bin/tsx"),
    ]
    for cand in tsx_candidates:
        if cand.exists():
            return [str(cand)]
    found_tsx = shutil.which("tsx")
    if found_tsx:
        return [found_tsx]
    return ["npx", "tsx"]


def evaluate_with_typescript(
    raw_model_outputs: list[dict[str, Any]],
    profile: dict[str, Any],
) -> list[dict[str, Any]]:
    ts_code = (
        "import fs from 'node:fs';"
        "import { toLabelRead } from './server/src/verify.ts';"
        "import { checkLabel, sameStrength } from './server/src/safety.ts';"
        "const input = JSON.parse(fs.readFileSync(0, 'utf8'));"
        "const now = new Date('2026-11-14T12:00:00Z');"
        "const out = input.items.map((entry) => {"
        "  const read = toLabelRead(entry.raw);"
        "  const verdict = checkLabel(read, input.profile, now);"
        "  const strengthMatchesExpected = entry.expected_strength"
        "    ? sameStrength(read.strength.value, entry.expected_strength)"
        "    : false;"
        "  return { read, verdict, strengthMatchesExpected };"
        "});"
        "process.stdout.write(JSON.stringify(out));"
    )
    sub_env = dict(os.environ)
    extra_paths = ["/tmp/fleet-silas/node/bin", str(pathlib.Path.home() / ".local" / "bin")]
    sub_env["PATH"] = ":".join(extra_paths + [sub_env.get("PATH", "")])

    cmd = resolve_tsx_cmd() + ["-e", ts_code]
    proc = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        env=sub_env,
        input=json.dumps({"profile": profile, "items": raw_model_outputs}),
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript evaluation failed ({proc.returncode}): {proc.stderr}")
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


def main() -> None:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in environment")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    BATCH2_OUT_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    raw_records: list[dict[str, Any]] = []

    for case in CASES:
        cid = case["id"]
        img_path = BATCH2_OUT_DIR / f"{cid}.jpg"
        img = render_case_image(case)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 image for {cid}, got {img.size}")
        b64_jpeg = encode_jpeg_b64(img, img_path)
        raw_pred, latency_ms, tok = call_gemini_verify(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
        )
        raw_records.append(
            {
                "case": case,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "raw": raw_pred,
                "latency_ms": round(latency_ms, 1),
                "tokens": tok,
                "expected_strength": case["expected_strength"],
            }
        )

    ts_evals = evaluate_with_typescript(
        [
            {"raw": rec["raw"], "expected_strength": rec["expected_strength"]}
            for rec in raw_records
        ],
        DEMO_PROFILE,
    )

    items_out: list[dict[str, Any]] = []
    for rec, ts_res in zip(raw_records, ts_evals):
        case = rec["case"]
        read_obj = sanitize_dashes(ts_res["read"])
        verdict_full = sanitize_dashes(ts_res["verdict"])
        pred_level = verdict_full["level"]
        exp_level = case["expected_level"]
        verdict_match = pred_level == exp_level

        reasons = verdict_full.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)

        false_safe_allergen = bool(
            (case["has_profile_allergen"] or not case["panel_readable"])
            and pred_level in ("info", "match")
        )

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        if case["expected_strength"] is not None:
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not ts_res["strengthMatchesExpected"])
                or pred_level == "match"
            )
        else:
            confident_wrong_dose = bool(
                (read_obj["kind"] == "medication" and s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or pred_level == "match"
            )

        verdict_compact: dict[str, Any] = {
            "level": pred_level,
            "headline": verdict_full["headline"],
            "speech": verdict_full["speech"],
            "reasons": reasons,
        }
        if "matchedMedId" in verdict_full:
            verdict_compact["matchedMedId"] = verdict_full["matchedMedId"]

        item_entry = {
            "id": case["id"],
            "description": case["description"],
            "language": case["language"],
            "image_path": rec["image_path"],
            "expected_kind": case["expected_kind"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "has_profile_allergen": case["has_profile_allergen"],
            "panel_readable": case["panel_readable"],
            "allergen_detected": allergen_detected,
            "false_safe_allergen": false_safe_allergen,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": rec["latency_ms"],
            "tokens_in": rec["tokens"]["tokens_in"],
            "tokens_out": rec["tokens"]["tokens_out"],
            "tokens_thinking": rec["tokens"]["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_compact,
        }
        items_out.append(item_entry)
        print(
            f"[{case['id']}] exp={exp_level} pred={pred_level} match={verdict_match} "
            f"kind={read_obj['kind']} allergens={read_obj['allergens']['value']} "
            f"(conf={read_obj['allergens']['confidence']:.2f}) ms={rec['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    allergen_pos = [it for it in items_out if it["has_profile_allergen"]]
    allergen_hits_count = sum(1 for it in allergen_pos if it["allergen_detected"])
    false_safe_allergen_count = sum(1 for it in items_out if it["false_safe_allergen"])
    confident_wrong_dose_count = sum(1 for it in items_out if it["confident_wrong_dose"])

    unreadable_cases = [it for it in items_out if not it["panel_readable"]]
    occluded_abstained = sum(1 for it in unreadable_cases if it["predicted_level"] == "unsure")
    readable_cases = [it for it in items_out if it["panel_readable"]]
    clean_correct = sum(1 for it in readable_cases if it["verdict_match"])

    latencies = [it["latency_ms"] for it in items_out]
    total_tokens_in = sum(it["tokens_in"] for it in items_out)
    total_tokens_out = sum(it["tokens_out"] for it in items_out)
    total_tokens_thinking = sum(it["tokens_thinking"] for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4),
        "allergen_positive_count": len(allergen_pos),
        "allergen_detected_count": allergen_hits_count,
        "allergen_recall": round(allergen_hits_count / len(allergen_pos), 4),
        "false_safe_allergen_count": false_safe_allergen_count,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "clean_field_accuracy": round(clean_correct / len(readable_cases), 4),
        "occluded_abstention_rate": round(occluded_abstained / len(unreadable_cases), 4),
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
        "mean_tokens_in": round(total_tokens_in / n_items, 1),
        "mean_tokens_out": round(total_tokens_out / n_items, 1),
    }

    report = sanitize_dashes(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": DEMO_PROFILE,
            "summary": summary,
            "items": items_out,
        }
    )

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Summary:", json.dumps(summary, indent=2))
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
