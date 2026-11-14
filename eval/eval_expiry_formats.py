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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "expiry_formats"
OUT_JSON_PATH = REPO_ROOT / "eval" / "expiry_formats_results.json"

MODEL_NAME = "gemini-3.8-flash"
REFERENCE_DATE = "2026-11-14"
EVAL_NOW_ISO = "2026-11-14T12:00:00Z"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60
EXPIRY_MIN_CONF = 0.70

CASES: list[dict[str, Any]] = [
    {
        "id": "ex_01",
        "kind": "medication",
        "surface": "med_carton",
        "language": "en",
        "format_family": "EN_MM_SLASH_YYYY",
        "description": "NORVASC 5 mg / amlodipine carton with expired EN MM/YYYY stamp EXP 03/2025",
        "printed_expiry": "EXP 03/2025",
        "expected_expiry_iso": "2025-03",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "header": "VIATRIS    Vnr 04 19 22",
        "title": "NORVASC",
        "subtitle": "amlodipine (as besilate)",
        "form_line": "tablets",
        "pack_line": "30 tablets    Oral use",
        "lot_line": "LOT H25031",
        "accent": (28, 74, 138),
    },
    {
        "id": "ex_02",
        "kind": "medication",
        "surface": "med_carton",
        "language": "fi",
        "format_family": "FI_KAYT_VIIM_MM_DOT_YYYY",
        "description": "METFORMIN ORION 500 mg Finnish carton with expired Kayt. viim. 02.2025",
        "printed_expiry": "Kayt. viim. 02.2025",
        "expected_expiry_iso": "2025-02",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN ORION",
        "subtitle": "Vaikuttava aine: metformiini",
        "form_line": "tabletti",
        "pack_line": "100 tablettia    Suun kautta",
        "lot_line": "Era 230219",
        "accent": (22, 104, 142),
    },
    {
        "id": "ex_03",
        "kind": "medication",
        "surface": "end_flap_inkjet",
        "language": "sv",
        "format_family": "SV_UTG_DAT_YYYY_MM",
        "description": "AMLODIPIN 5 mg Swedish carton end-flap with expired Utg.dat 2024-12",
        "printed_expiry": "Utg.dat 2024-12",
        "expected_expiry_iso": "2024-12",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "header": "ACTAVIS    Vnr 09 18 44",
        "title": "AMLODIPIN",
        "subtitle": "Aktiv substans: amlodipin",
        "form_line": "filmdragerade tabletter",
        "pack_line": "30 tabletter",
        "lot_line": "Batch 221208",
        "accent": (36, 86, 156),
    },
    {
        "id": "ex_04",
        "kind": "medication",
        "surface": "med_carton",
        "language": "de",
        "format_family": "DE_VERWENDBAR_BIS_MM_DOT_YYYY",
        "description": "METFORMIN HEXAL 500 mg German carton with expired Verwendbar bis 05.2025",
        "printed_expiry": "Verwendbar bis 05.2025",
        "expected_expiry_iso": "2025-05",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "header": "HEXAL AG    PZN 04819203",
        "title": "METFORMIN HEXAL",
        "subtitle": "Wirkstoff: Metforminhydrochlorid",
        "form_line": "Filmtabletten",
        "pack_line": "100 Filmtabletten    Zum Einnehmen",
        "lot_line": "Ch.-B. 450512",
        "accent": (24, 92, 128),
    },
    {
        "id": "ex_05",
        "kind": "medication",
        "surface": "debossed_end_flap",
        "language": "en",
        "format_family": "DEBOSSED_END_FLAP_YYYY_MM",
        "description": "PANADOL 500 mg low-contrast debossed cardboard end-flap EXP 2025-01",
        "printed_expiry": "EXP 2025-01",
        "expected_expiry_iso": "2025-01",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "paracetamol",
        "header": "HALEON    Vnr 05 82 19",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "film-coated tablets",
        "pack_line": "24 film-coated tablets",
        "lot_line": "LOT 40118",
        "accent": (20, 96, 152),
    },
    {
        "id": "ex_06",
        "kind": "medication",
        "surface": "med_carton",
        "language": "en",
        "format_family": "DAY_BOUNDARY_YESTERDAY_YYYY_MM_DD",
        "description": "AMLODIPIN ORION 5 mg carton with day-level yesterday boundary EXP 2026-11-13",
        "printed_expiry": "EXP 2026-11-13",
        "expected_expiry_iso": "2026-11-13",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "lot_line": "LOT 241113",
        "accent": (22, 108, 144),
    },
    {
        "id": "ex_07",
        "kind": "medication",
        "surface": "end_flap_inkjet",
        "language": "en",
        "format_family": "LAST_MONTH_BOUNDARY_YYYY_MM",
        "description": "METFORMIN 500 mg end-flap with last-month boundary EXP 2026-10 at 2026-11-14",
        "printed_expiry": "EXP 2026-10",
        "expected_expiry_iso": "2026-10",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "lot_line": "LOT 241009",
        "accent": (26, 98, 138),
    },
    {
        "id": "ex_08",
        "kind": "medication",
        "surface": "med_carton",
        "language": "en",
        "format_family": "CURRENT_MONTH_BOUNDARY_YYYY_MM",
        "description": "AMLODIPIN ORION 5 mg carton with current-month EXP 2026-11 valid through Nov 30",
        "printed_expiry": "EXP 2026-11",
        "expected_expiry_iso": "2026-11",
        "is_expired_ground_truth": False,
        "expected_level": "match",
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "98 tablettia",
        "lot_line": "LOT 241128",
        "accent": (22, 108, 144),
    },
    {
        "id": "ex_09",
        "kind": "medication",
        "surface": "med_carton",
        "language": "en",
        "format_family": "FUTURE_MM_SLASH_YYYY",
        "description": "PANADOL 500 mg carton with future EXP 09/2027 normalized to 2027-09",
        "printed_expiry": "EXP 09/2027",
        "expected_expiry_iso": "2027-09",
        "is_expired_ground_truth": False,
        "expected_level": "match",
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "paracetamol",
        "header": "HALEON NORDIC    Vnr 05 82 19",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets    Oral use",
        "lot_line": "LOT 250914",
        "accent": (18, 96, 158),
    },
    {
        "id": "ex_10",
        "kind": "food",
        "surface": "food_carton",
        "language": "fi",
        "format_family": "FI_PARASTA_ENNEN_DD_DOT_MM_DOT_YYYY_FOOD",
        "description": "KAURAJUOMA Finnish oat drink carton with expired Parasta ennen 14.03.2026",
        "printed_expiry": "Parasta ennen 14.03.2026",
        "expected_expiry_iso": "2026-03-14",
        "is_expired_ground_truth": True,
        "expected_level": "warning",
        "printed_strength": None,
        "expected_strength": None,
        "expected_ingredient": None,
        "header": "POHJOLAN KAURA",
        "title": "KAURAJUOMA",
        "subtitle": "Kaurapohjainen juoma / Oat Drink",
        "ingredients_lines": [
            "Ainekset: vesi, taysjyvakaura (10%),",
            "rapsioljy, kalsium, suola.",
            "Allergeenit: kaura (gluteeni). Pahkinaton.",
        ],
        "lot_line": "LOT F250314",
        "accent": (46, 114, 76),
    },
]


def load_env_files() -> None:
    comment_prefix = chr(35)
    for env_path in (pathlib.Path.home() / "momin" / ".env", REPO_ROOT / ".env"):
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
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def sanitize_obj(obj: Any) -> Any:
    em_dash = chr(8212)
    en_dash = chr(8211)
    if isinstance(obj, str):
        return obj.replace(em_dash, " - ").replace(en_dash, "-")
    if isinstance(obj, list):
        return [sanitize_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in obj.items()}
    return obj


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


def add_sensor_grain(img: Image.Image, seed: int, sigma: float = 2.4, alpha: float = 0.04) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    small_w, small_h = w // 2, h // 2
    noise_bytes = bytearray(small_w * small_h)
    for idx in range(len(noise_bytes)):
        val = int(128 + rng.gauss(0.0, sigma))
        noise_bytes[idx] = 0 if val < 0 else (255 if val > 255 else val)
    grain = Image.frombytes("L", (small_w, small_h), bytes(noise_bytes)).resize(
        (w, h), Image.Resampling.BILINEAR
    )
    rgb = img.convert("RGB")
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    return Image.blend(rgb, grain_rgb, alpha=alpha)


def draw_cabinet_backdrop(size: int, pad: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    canvas = Image.new("RGB", (size, size), (224, 220, 212))
    draw = ImageDraw.Draw(canvas)
    horizon_y = pad + 540
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        draw.line(
            (0, y, size, y),
            fill=(int(236 - 20 * t), int(232 - 20 * t), int(225 - 18 * t)),
        )
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        jitter = rng.randint(-2, 2)
        draw.line(
            (0, y, size, y),
            fill=(
                max(0, min(255, int(192 - 22 * t) + jitter)),
                max(0, min(255, int(164 - 20 * t) + jitter)),
                max(0, min(255, int(134 - 16 * t) + jitter)),
            ),
        )
    draw.line((0, horizon_y, size, horizon_y), fill=(144, 118, 92), width=3)
    return canvas


def warp_and_crop(canvas: Image.Image, pad: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    dx_tl = rng.uniform(3.5, 9.5)
    dy_tl = rng.uniform(3.5, 8.5)
    dx_tr = rng.uniform(3.5, 9.5)
    dy_tr = rng.uniform(4.0, 9.5)
    w, h = canvas.size
    src_pts = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    dst_pts = [
        (dx_tl, dy_tl),
        (float(w) - dx_tr, dy_tr),
        (float(w) - dx_tl, float(h) - dy_tl),
        (dx_tr, float(h) - dy_tr),
    ]
    coeffs = solve_perspective_coeffs(dst_pts, src_pts)
    warped = canvas.transform((w, h), Image.Transform.PERSPECTIVE, coeffs, resample=Image.Resampling.BICUBIC)
    cropped = warped.crop((pad, pad, pad + 768, pad + 768))
    return add_sensor_grain(cropped, seed=seed + 19)


def render_med_carton(case: dict[str, Any], seed: int) -> Image.Image:
    rng = random.Random(seed)
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_cabinet_backdrop(size, pad, seed)

    x0 = pad + 64 + rng.randint(-8, 8)
    y0 = pad + 138 + rng.randint(-6, 6)
    x1 = x0 + 640
    y1 = y0 + 444

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 14, y0 + 18, x1 + 18, y1 + 22), radius=18, fill=(28, 22, 16, 92))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    accent = case["accent"]
    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(170, 176, 184), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=accent)
    draw.rectangle((x0, y0 + 32, x1, y0 + 62), fill=accent)
    draw.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=accent)

    draw.text((x0 + 28, y0 + 18), case["header"], fill=(248, 250, 252), font=ImageFont.load_default(size=22))
    draw.text((x0 + 28, y0 + 82), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=42))
    draw.text((x0 + 28, y0 + 140), case["subtitle"], fill=(48, 56, 66), font=ImageFont.load_default(size=24))

    strength_txt = case["printed_strength"]
    s_font = ImageFont.load_default(size=42)
    s_bbox = draw.textbbox((0, 0), strength_txt, font=s_font)
    sx0, sy0 = x0 + 28, y0 + 190
    sx1 = sx0 + max(196, (s_bbox[2] - s_bbox[0]) + 44)
    sy1 = y0 + 274
    draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=accent, width=2)
    draw.text((sx0 + 22, sy0 + 18), strength_txt, fill=(14, 20, 28), font=s_font)
    draw.text((sx1 + 20, sy0 + 28), case["form_line"], fill=(44, 52, 62), font=ImageFont.load_default(size=23))

    draw.text((x0 + 28, y0 + 306), case["pack_line"], fill=(54, 62, 72), font=ImageFont.load_default(size=21))

    exp_font = ImageFont.load_default(size=24)
    lot_font = ImageFont.load_default(size=18)
    exp_txt = case["printed_expiry"]
    exp_bbox = draw.textbbox((0, 0), exp_txt, font=exp_font)
    box_w = max(248, (exp_bbox[2] - exp_bbox[0]) + 42)
    ex1 = x1 - 24
    ex0 = ex1 - box_w
    ey0 = y0 + 340
    ey1 = y0 + 420
    draw.rounded_rectangle((ex0, ey0, ex1, ey1), radius=8, fill=(244, 246, 249), outline=(154, 162, 172), width=2)
    draw.text((ex0 + 18, ey0 + 12), case["lot_line"], fill=(72, 80, 90), font=lot_font)
    draw.text((ex0 + 18, ey0 + 39), exp_txt, fill=(18, 24, 32), font=exp_font)

    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(ambient).ellipse((-90, -110, 540, 450), fill=(255, 252, 244, 22))
    ambient = ambient.filter(ImageFilter.GaussianBlur(radius=32.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), ambient).convert("RGB")
    return warp_and_crop(canvas, pad, seed)


def render_end_flap_inkjet(case: dict[str, Any], seed: int) -> Image.Image:
    rng = random.Random(seed)
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_cabinet_backdrop(size, pad, seed)

    x0 = pad + 88 + rng.randint(-6, 6)
    y0 = pad + 178 + rng.randint(-6, 6)
    x1 = x0 + 592
    y1 = y0 + 392

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 14, y0 + 16, x1 + 18, y1 + 20), radius=14, fill=(26, 20, 16, 96))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    accent = case["accent"]
    draw.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=(248, 248, 245), outline=(160, 164, 170), width=3)
    draw.line((x0 + 22, y0 + 18, x1 - 22, y0 + 18), fill=(208, 208, 202), width=2)
    draw.line((x0 + 22, y1 - 18, x1 - 22, y1 - 18), fill=(204, 204, 198), width=2)
    draw.rectangle((x0 + 18, y0 + 26, x0 + 34, y1 - 26), fill=accent)

    draw.text((x0 + 52, y0 + 34), case["header"], fill=(76, 84, 94), font=ImageFont.load_default(size=19))
    draw.text((x0 + 52, y0 + 68), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=38))
    draw.text((x0 + 52, y0 + 118), case["subtitle"], fill=(52, 60, 70), font=ImageFont.load_default(size=22))

    s_font = ImageFont.load_default(size=36)
    s_txt = case["printed_strength"]
    s_bbox = draw.textbbox((0, 0), s_txt, font=s_font)
    sx0, sy0 = x0 + 52, y0 + 160
    sx1 = sx0 + max(168, (s_bbox[2] - s_bbox[0]) + 36)
    sy1 = y0 + 226
    draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=8, fill=(238, 244, 250), outline=accent, width=2)
    draw.text((sx0 + 18, sy0 + 13), s_txt, fill=(14, 20, 28), font=s_font)
    draw.text((sx1 + 16, sy0 + 20), case["form_line"], fill=(46, 54, 64), font=ImageFont.load_default(size=20))
    draw.text((x0 + 52, y0 + 244), case["pack_line"], fill=(62, 70, 80), font=ImageFont.load_default(size=20))

    stamp_x0, stamp_y0 = x0 + 52, y0 + 282
    stamp_x1, stamp_y1 = x1 - 36, y1 - 28
    draw.rounded_rectangle((stamp_x0, stamp_y0, stamp_x1, stamp_y1), radius=6, fill=(239, 239, 234), outline=(186, 186, 180), width=2)
    draw.text((stamp_x0 + 18, stamp_y0 + 11), case["lot_line"], fill=(54, 58, 62), font=ImageFont.load_default(size=20))
    draw.text((stamp_x0 + 198, stamp_y0 + 24), case["printed_expiry"], fill=(28, 32, 36), font=ImageFont.load_default(size=27))

    return warp_and_crop(canvas, pad, seed)


def render_debossed_end_flap(case: dict[str, Any], seed: int) -> Image.Image:
    rng = random.Random(seed)
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_cabinet_backdrop(size, pad, seed)

    x0 = pad + 82 + rng.randint(-5, 5)
    y0 = pad + 154 + rng.randint(-5, 5)
    x1 = x0 + 604
    y1 = y0 + 448
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 14, y0 + 18, x1 + 18, y1 + 22), radius=14, fill=(24, 20, 16, 98))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    flap = Image.new("RGB", (bw, bh), (236, 234, 228))
    fd = ImageDraw.Draw(flap)
    for py in range(bh):
        t = py / max(1, bh)
        c_val = int(242 - 14 * t)
        fd.line((0, py, bw, py), fill=(c_val, c_val - 2, c_val - 7))

    flap = add_sensor_grain(flap, seed=seed + 41, sigma=3.2, alpha=0.06)
    fd = ImageDraw.Draw(flap)

    accent = case["accent"]
    fd.rectangle((0, 0, bw, 52), fill=accent)
    fd.text((26, 14), case["header"], fill=(246, 249, 252), font=ImageFont.load_default(size=20))

    fd.text((28, 70), case["title"], fill=(18, 24, 32), font=ImageFont.load_default(size=40))
    fd.text((28, 120), case["subtitle"], fill=(52, 60, 70), font=ImageFont.load_default(size=23))

    s_font = ImageFont.load_default(size=36)
    sx0, sy0, sx1, sy1 = 28, 160, 206, 224
    fd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=8, fill=(238, 244, 250), outline=accent, width=2)
    fd.text((sx0 + 20, sy0 + 12), case["printed_strength"], fill=(14, 20, 28), font=s_font)
    fd.text((sx1 + 18, sy0 + 20), case["form_line"], fill=(46, 54, 64), font=ImageFont.load_default(size=21))
    fd.text((28, 236), case["pack_line"], fill=(66, 74, 84), font=ImageFont.load_default(size=19))

    fd.line((22, 272, bw - 22, 272), fill=(196, 193, 186), width=2)
    fd.line((22, 274, bw - 22, 274), fill=(249, 247, 242), width=1)

    zone_x0, zone_y0, zone_x1, zone_y1 = 28, 290, bw - 28, bh - 24
    fd.rounded_rectangle((zone_x0, zone_y0, zone_x1, zone_y1), radius=8, fill=(230, 227, 220), outline=(206, 203, 196), width=1)

    deboss_layer = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    dd = ImageDraw.Draw(deboss_layer)
    f_lot = ImageFont.load_default(size=25)
    f_exp = ImageFont.load_default(size=36)

    lx, ly = zone_x0 + 26, zone_y0 + 18
    ex, ey = zone_x0 + 26, zone_y0 + 58

    dd.text((lx - 1, ly - 1), case["lot_line"], fill=(134, 130, 122, 215), font=f_lot)
    dd.text((lx + 2, ly + 2), case["lot_line"], fill=(252, 250, 246, 235), font=f_lot)
    dd.text((lx, ly), case["lot_line"], fill=(166, 162, 154, 255), font=f_lot)

    dd.text((ex - 2, ey - 2), case["printed_expiry"], fill=(124, 120, 112, 225), font=f_exp)
    dd.text((ex + 2, ey + 2), case["printed_expiry"], fill=(254, 252, 248, 245), font=f_exp)
    dd.text((ex, ey), case["printed_expiry"], fill=(156, 152, 144, 255), font=f_exp)

    deboss_soft = deboss_layer.filter(ImageFilter.GaussianBlur(radius=0.45))
    flap_rgba = Image.alpha_composite(flap.convert("RGBA"), deboss_soft)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=12, fill=255)
    canvas.paste(flap_rgba.convert("RGB"), (x0, y0), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=12, outline=(162, 160, 154), width=3)

    return warp_and_crop(canvas, pad, seed)


def render_food_carton(case: dict[str, Any], seed: int) -> Image.Image:
    rng = random.Random(seed)
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_cabinet_backdrop(size, pad, seed)

    x0 = pad + 136 + rng.randint(-6, 6)
    y0 = pad + 68 + rng.randint(-5, 5)
    x1 = x0 + 496
    y1 = y0 + 628
    cw, ch = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 14, y0 + 18, x1 + 18, y1 + 20), radius=18, fill=(28, 22, 16, 95))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    carton = Image.new("RGB", (cw, ch), (245, 240, 228))
    carton = add_sensor_grain(carton, seed=seed + 31, sigma=2.8, alpha=0.05)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 68), fill=(252, 251, 247))
    cd.line((0, 68, cw, 68), fill=(186, 182, 172), width=2)
    cd.text((22, 10), case["lot_line"], fill=(86, 90, 88), font=ImageFont.load_default(size=16))
    cd.text((22, 32), case["printed_expiry"], fill=(20, 24, 26), font=ImageFont.load_default(size=24))

    cd.rectangle((0, 69, cw, 134), fill=case["accent"])
    cd.text((26, 89), case["header"], fill=(244, 248, 244), font=ImageFont.load_default(size=22))

    cd.text((26, 156), case["title"], fill=(22, 44, 30), font=ImageFont.load_default(size=44))
    cd.text((26, 214), case["subtitle"], fill=(52, 70, 58), font=ImageFont.load_default(size=23))

    cd.rounded_rectangle((24, 268, cw - 24, 468), radius=12, fill=(252, 250, 244), outline=(182, 176, 162), width=2)
    iy = 290
    f_ing = ImageFont.load_default(size=21)
    for ln in case["ingredients_lines"]:
        cd.text((38, iy), ln, fill=(28, 32, 30), font=f_ing)
        iy += 36

    cd.rounded_rectangle((24, 492, cw - 24, 556), radius=8, fill=(255, 255, 255), outline=(190, 186, 176), width=2)
    cd.text((38, 510), case["printed_expiry"], fill=(20, 24, 26), font=ImageFont.load_default(size=24))
    cd.text((28, ch - 48), "1 L", fill=(54, 70, 58), font=ImageFont.load_default(size=26))

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    canvas.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(168, 162, 150), width=3)

    return warp_and_crop(canvas, pad, seed)


def render_case_image(case: dict[str, Any], index: int) -> Image.Image:
    seed = 20261114 + index * 53
    surface = case["surface"]
    if surface == "med_carton":
        return render_med_carton(case, seed)
    if surface == "end_flap_inkjet":
        return render_end_flap_inkjet(case, seed)
    if surface == "debossed_end_flap":
        return render_debossed_end_flap(case, seed)
    if surface == "food_carton":
        return render_food_carton(case, seed)
    raise ValueError(f"Unknown surface: {surface}")


def save_jpeg_and_b64(img: Image.Image, save_path: pathlib.Path) -> tuple[str, int]:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    save_path.write_bytes(raw)
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
    raise RuntimeError(f"Gemini verify failed after retries: {last_err}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    sub_env = dict(os.environ)
    extra_paths = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
        sub_env.get("PATH", ""),
    ]
    sub_env["PATH"] = ":".join(p for p in extra_paths if p)
    node_bin = shutil.which("node", path=sub_env["PATH"])
    if not node_bin:
        raise RuntimeError("node executable not found on PATH")
    return node_bin, sub_env


def evaluate_via_typescript(raw_cases: list[dict[str, Any]]) -> dict[str, Any]:
    node_bin, sub_env = ensure_node_runtime()
    ts_code = """
import fs from "node:fs";
import { toLabelRead } from "./server/src/verify.ts";
import { checkLabel, ingredientsOf, isExpired, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";
import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evalNow = new Date(2026, 10, 14, 12, 0, 0);

const items = input.cases.map((c) => {
  const read = toLabelRead(c.raw);
  const verdict = checkLabel(read, DEMO_PROFILE, evalNow);
  const tsIsExpired = read.expiry.value && read.expiry.confidence >= 0.7
    ? isExpired(read.expiry.value, evalNow) ?? null
    : null;
  const strengthSame = c.expected_strength
    ? sameStrength(read.strength.value, c.expected_strength)
    : null;
  const gotIngredients = [...ingredientsOf(read.ingredient.value, read.product.value)];
  return {
    id: c.id,
    read,
    verdict: {
      level: verdict.level,
      headline: verdict.headline,
      speech: verdict.speech,
      matchedMedId: verdict.matchedMedId ?? null,
      reasons: verdict.reasons,
      takenToday: verdict.takenToday ?? null,
    },
    tsIsExpired,
    strengthSame,
    gotIngredients,
    strengthMinConf: STRENGTH_MIN_CONF,
  };
});

process.stdout.write(JSON.stringify({ profile: DEMO_PROFILE, items }));
"""
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"cases": raw_cases}, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=sub_env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS expiry evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    return json.loads(proc.stdout)


def main() -> None:
    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.trust_env = True

    raw_batch_inputs: list[dict[str, Any]] = []
    call_meta: dict[str, dict[str, Any]] = {}

    for idx, case in enumerate(CASES, start=1):
        cid = case["id"]
        img_path = OUT_IMG_DIR / f"{cid}.jpg"
        img = render_case_image(case, idx)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 image for {cid}, got {img.size}")
        b64_jpeg, jpeg_bytes = save_jpeg_and_b64(img, img_path)

        raw_json, latency_ms, tok = call_gemini_verify(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
        )
        raw_batch_inputs.append(
            {
                "id": cid,
                "raw": raw_json,
                "expected_strength": case["expected_strength"],
            }
        )
        call_meta[cid] = {
            "image_path": str(img_path.relative_to(REPO_ROOT)),
            "jpeg_bytes": jpeg_bytes,
            "latency_ms": round(latency_ms, 1),
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
        }
        print(f"[{idx:02d}/10 {cid}] gemini latency={latency_ms:.1f}ms in={tok['in']} out={tok['out']}")

    ts_bundle = evaluate_via_typescript(raw_batch_inputs)
    demo_profile = sanitize_obj(ts_bundle["profile"])
    ts_outputs = {row["id"]: row for row in ts_bundle["items"]}

    items: list[dict[str, Any]] = []
    for case in CASES:
        cid = case["id"]
        ts_row = ts_outputs[cid]
        meta = call_meta[cid]
        read_obj = sanitize_obj(ts_row["read"])
        verdict_obj = sanitize_obj(ts_row["verdict"])

        pred_level = verdict_obj["level"]
        exp_level = case["expected_level"]
        verdict_match = pred_level == exp_level

        pred_exp_iso = read_obj["expiry"]["value"]
        exp_conf = round(float(read_obj["expiry"]["confidence"]), 4)
        exp_iso_ok = bool(
            pred_exp_iso == case["expected_expiry_iso"]
            and exp_conf >= EXPIRY_MIN_CONF
        )

        reasons_list = verdict_obj.get("reasons") or []
        is_exp_gt = bool(case["is_expired_ground_truth"])
        expired_caught: bool | None = None
        if is_exp_gt:
            expired_caught = bool(
                pred_level == "warning"
                and ts_row["tsIsExpired"] is True
                and any(str(r).startswith("expired ") for r in reasons_list)
            )

        s_val = read_obj["strength"]["value"]
        s_conf = round(float(read_obj["strength"]["confidence"]), 4)

        if case["kind"] == "medication":
            strength_readable: bool | None = True
            strength_same = bool(ts_row["strengthSame"])
            strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            ing_ok = (
                case["expected_ingredient"] in ts_row["gotIngredients"]
                and (
                    float(read_obj["ingredient"]["confidence"]) >= NAME_MIN_CONF
                    or float(read_obj["product"]["confidence"]) >= NAME_MIN_CONF
                )
            )
            clean_fields_ok = bool(
                read_obj["kind"] == "medication"
                and ing_ok
                and strength_correct
                and exp_iso_ok
            )
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
        else:
            strength_readable = None
            strength_correct = None
            clean_fields_ok = bool(
                read_obj["kind"] == "food"
                and float(read_obj["product"]["confidence"]) >= NAME_MIN_CONF
                and exp_iso_ok
            )
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or (exp_level != "match" and pred_level == "match")
            )

        item_record = {
            "id": cid,
            "kind": case["kind"],
            "surface": case["surface"],
            "language": case["language"],
            "format_family": case["format_family"],
            "description": sanitize_obj(case["description"]),
            "image_path": meta["image_path"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": meta["jpeg_bytes"],
            "printed_expiry": case["printed_expiry"],
            "expected_expiry_iso": case["expected_expiry_iso"],
            "predicted_expiry_iso": pred_exp_iso,
            "expiry_confidence": exp_conf,
            "expiry_iso_normalized": exp_iso_ok,
            "is_expired_ground_truth": is_exp_gt,
            "ts_is_expired": ts_row["tsIsExpired"],
            "expired_caught": expired_caught,
            "strength_readable": strength_readable,
            "printed_strength": case["printed_strength"],
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "clean_fields_correct": clean_fields_ok,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": meta["latency_ms"],
            "tokens_in": meta["tokens_in"],
            "tokens_out": meta["tokens_out"],
            "tokens_thinking": meta["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items.append(item_record)
        print(
            f"  -> {cid} ({case['printed_expiry']}): iso={pred_exp_iso!r} ({exp_conf:.2f}) "
            f"exp={exp_level} pred={pred_level} match={verdict_match} cwd={confident_wrong_dose}"
        )

    n_items = len(items)
    verdict_matches = sum(1 for it in items if it["verdict_match"])
    expired_gt_items = [it for it in items if it["is_expired_ground_truth"]]
    expired_catches = sum(1 for it in expired_gt_items if it["expired_caught"])
    iso_norm_count = sum(1 for it in items if it["expiry_iso_normalized"])
    clean_field_acc = round(sum(1 for it in items if it["clean_fields_correct"]) / n_items, 4)
    cwd_count = sum(1 for it in items if it["confident_wrong_dose"])

    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items)

    ex05 = next(it for it in items if it["id"] == "ex_05")
    ex07 = next(it for it in items if it["id"] == "ex_07")
    ex08 = next(it for it in items if it["id"] == "ex_08")
    ex10 = next(it for it in items if it["id"] == "ex_10")

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "reference_date": REFERENCE_DATE,
        "n_items": n_items,
        "n_expired_items": len(expired_gt_items),
        "n_valid_items": n_items - len(expired_gt_items),
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4),
        "expired_catches": expired_catches,
        "expired_catch_recall": round(expired_catches / len(expired_gt_items), 4),
        "expiry_iso_normalized_count": iso_norm_count,
        "expiry_iso_normalization_accuracy": round(iso_norm_count / n_items, 4),
        "last_month_boundary_caught": bool(ex07["expired_caught"] and ex07["verdict_match"]),
        "current_month_boundary_matched": bool(ex08["verdict_match"] and ex08["predicted_level"] == "match"),
        "debossed_end_flap_caught": bool(ex05["expired_caught"] and ex05["verdict_match"]),
        "expired_food_caught": bool(
            ex10["expired_caught"]
            and ex10["verdict_match"]
            and "past its date" in ex10["verdict"]["headline"]
        ),
        "clean_field_accuracy": clean_field_acc,
        "confident_wrong_dose_count": cwd_count,
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
            "reference_date": REFERENCE_DATE,
            "eval_now_iso": EVAL_NOW_ISO,
            "model": MODEL_NAME,
            "profile": demo_profile,
            "summary": summary,
            "items": items,
        }
    )

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if chr(8212) in serialized or chr(8211) in serialized:
        raise RuntimeError("Forbidden dash character detected in serialized report")
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
