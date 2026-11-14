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
SYNTH_DIR = REPO_ROOT / "eval" / "synthetic" / "batch1"
OUT_JSON_PATH = REPO_ROOT / "eval" / "results_batch1.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60
EXPIRY_MIN_CONF = 0.70

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
        "id": "b1_01",
        "category": "clean",
        "description": "AMLODIPIN ORION 5 mg tabletti / EXP 2027-08",
        "strength_readable": True,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-08",
        "brand_header": "ORION PHARMA",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-08",
        "accent": (22, 114, 138),
    },
    {
        "id": "b1_02",
        "category": "clean",
        "description": "AMLODIPIN 10 mg tabletti / EXP 2027-08 (wrong strength trap 10 mg vs 5 mg)",
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "10 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-08",
        "brand_header": "NORDIC GENERICS",
        "title": "AMLODIPIN",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-08",
        "accent": (38, 92, 148),
    },
    {
        "id": "b1_03",
        "category": "clean",
        "description": "METFORMIN 500 mg film-coated tablets / EXP 2027-11",
        "strength_readable": True,
        "expected_level": "match",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "expected_expiry": "2027-11",
        "brand_header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "accent": (34, 88, 168),
    },
    {
        "id": "b1_04",
        "category": "clean",
        "description": "BURANA 400 mg ibuprofeeni tabletti / EXP 2027-10 (NSAID avoid)",
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "400 mg",
        "expected_ingredient": "ibuprofen",
        "expected_expiry": "2027-10",
        "brand_header": "ORION PHARMA",
        "title": "BURANA",
        "subtitle": "ibuprofeeni / ibuprofen",
        "form_line": "tabletti",
        "pack_line": "20 tablettia",
        "expiry_line": "EXP 2027-10",
        "accent": (196, 32, 42),
    },
    {
        "id": "b1_05",
        "category": "clean",
        "description": "PANADOL 500 mg paracetamol tablets / EXP 2027-12",
        "strength_readable": True,
        "expected_level": "match",
        "expected_strength": "500 mg",
        "expected_ingredient": "paracetamol",
        "expected_expiry": "2027-12",
        "brand_header": "HALEON",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "tablets",
        "pack_line": "24 tablets",
        "expiry_line": "EXP 2027-12",
        "accent": (24, 118, 86),
    },
    {
        "id": "b1_06",
        "category": "clean",
        "description": "MAREVAN 3 mg varfariini / 100 tablettia (not on list)",
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "3 mg",
        "expected_ingredient": "warfarin",
        "expected_expiry": None,
        "brand_header": "ORION PHARMA",
        "title": "MAREVAN",
        "subtitle": "varfariini / warfarin",
        "form_line": "tabletti",
        "pack_line": "100 tablettia",
        "expiry_line": "",
        "accent": (42, 116, 178),
    },
    {
        "id": "b1_07",
        "category": "clean",
        "description": "THYROXIN 100 mikrog levotyroksiini (not on list)",
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "100 mikrog",
        "expected_ingredient": "levothyroxine",
        "expected_expiry": None,
        "brand_header": "ORION PHARMA",
        "title": "THYROXIN",
        "subtitle": "levotyroksiini / levothyroxine",
        "form_line": "tabletti",
        "pack_line": "tabletti",
        "expiry_line": "",
        "accent": (104, 62, 148),
    },
    {
        "id": "b1_08",
        "category": "clean",
        "description": "NORVASC 5 mg amlodipine tablets / EXP 2027-09 (brand synonym)",
        "strength_readable": True,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-09",
        "brand_header": "VIATRIS",
        "title": "NORVASC",
        "subtitle": "amlodipine",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-09",
        "accent": (28, 64, 128),
    },
    {
        "id": "b1_09",
        "category": "clean",
        "description": "METFORMIN 500 mg tablets / EXP 2025-04 (expired)",
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "expected_expiry": "2025-04",
        "brand_header": "TEVA",
        "title": "METFORMIN",
        "subtitle": "metformin",
        "form_line": "tablets",
        "pack_line": "60 tablets",
        "expiry_line": "EXP 2025-04",
        "accent": (46, 94, 136),
    },
    {
        "id": "b1_10",
        "category": "occluded_trap",
        "trap_kind": "thumb_occlusion",
        "description": "AMLODIPIN ORION with skin-toned thumb covering the strength band",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": "amlodipine",
        "expected_expiry": None,
        "brand_header": "ORION PHARMA",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini",
        "form_line": "tabletti",
        "pack_line": "",
        "expiry_line": "",
        "accent": (22, 114, 138),
    },
    {
        "id": "b1_11",
        "category": "occluded_trap",
        "trap_kind": "lower_motion_blur",
        "description": "METFORMIN with heavy motion blur (GaussianBlur(14)) over the lower box",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": "metformin",
        "expected_expiry": None,
        "brand_header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "",
        "form_line": "",
        "pack_line": "",
        "expiry_line": "",
        "accent": (34, 88, 168),
    },
    {
        "id": "b1_12",
        "category": "occluded_trap",
        "trap_kind": "specular_glare",
        "description": "PANADOL with bright specular glare ellipse washing out the strength area",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": "paracetamol",
        "expected_expiry": None,
        "brand_header": "HALEON",
        "title": "PANADOL",
        "subtitle": "paracetamol",
        "form_line": "tablets",
        "pack_line": "",
        "expiry_line": "",
        "accent": (24, 118, 86),
    },
    {
        "id": "b1_13",
        "category": "occluded_trap",
        "trap_kind": "rear_barcode_only",
        "description": "Rear side of white pharmacy carton with barcode 6432100012345 only",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": None,
        "expected_expiry": None,
    },
    {
        "id": "b1_14",
        "category": "occluded_trap",
        "trap_kind": "cropped_top_edge",
        "description": "Tightly cropped top edge showing only AMLODIPIN",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": "amlodipine",
        "expected_expiry": None,
    },
    {
        "id": "b1_15",
        "category": "occluded_trap",
        "trap_kind": "defocused_bottle",
        "description": "Heavily out-of-focus medicine bottle (GaussianBlur(18))",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": None,
        "expected_expiry": None,
    },
    {
        "id": "b1_16",
        "category": "occluded_trap",
        "trap_kind": "dim_noisy_night",
        "description": "Extreme dim noisy night frame with illegible text",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": None,
        "expected_expiry": None,
    },
    {
        "id": "b1_17",
        "category": "occluded_trap",
        "trap_kind": "side_flap_storage_only",
        "description": "Side flap printed only 'Keep out of reach of children. Store below 25 C'",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": None,
        "expected_expiry": None,
    },
    {
        "id": "b1_18",
        "category": "occluded_trap",
        "trap_kind": "torn_pharmacy_sticker",
        "description": "IBUPROFEN box with torn white pharmacy sticker covering where mg would be",
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "expected_ingredient": "ibuprofen",
        "expected_expiry": None,
        "brand_header": "RATIOPHARM",
        "title": "IBUPROFEN",
        "subtitle": "",
        "form_line": "tablets",
        "pack_line": "",
        "expiry_line": "",
        "accent": (188, 38, 48),
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
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def sanitize_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        return obj.replace("\u2014", " - ").replace("\u2013", "-")
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


def add_sensor_grain(img: Image.Image, seed: int, sigma: float = 2.6) -> Image.Image:
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
    return Image.blend(rgb, grain_rgb, alpha=0.04)


def draw_indoor_backdrop(size: int, pad: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (224, 218, 208))
    draw = ImageDraw.Draw(canvas)
    table_y = pad + 528
    for y in range(table_y):
        t = y / max(1, table_y)
        draw.line(
            (0, y, size, y),
            fill=(int(236 - 24 * t), int(230 - 24 * t), int(220 - 22 * t)),
        )
    for y in range(table_y, size):
        t = (y - table_y) / max(1, size - table_y)
        draw.line(
            (0, y, size, y),
            fill=(int(184 - 26 * t), int(152 - 24 * t), int(118 - 20 * t)),
        )
    draw.line((0, table_y, size, table_y), fill=(138, 108, 80), width=3)
    return canvas


def render_carton_scene(case: dict[str, Any], include_strength: bool, seed: int) -> Image.Image:
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_indoor_backdrop(size, pad)

    x0 = pad + 88
    y0 = pad + 146
    x1 = pad + 680
    y1 = pad + 566

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x0 + 14, y0 + 18, x1 + 18, y1 + 22), radius=18, fill=(30, 24, 18, 92))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    accent = case["accent"]
    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(250, 251, 252), outline=(172, 178, 186), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=accent)
    draw.rectangle((x0, y0 + 34, x1, y0 + 62), fill=accent)

    draw.text(
        (x0 + 28, y0 + 18),
        case["brand_header"],
        fill=(248, 250, 252),
        font=ImageFont.load_default(size=23),
    )
    draw.text(
        (x0 + 28, y0 + 82),
        case["title"],
        fill=(16, 22, 30),
        font=ImageFont.load_default(size=42),
    )
    if case.get("subtitle"):
        draw.text(
            (x0 + 28, y0 + 140),
            case["subtitle"],
            fill=(52, 60, 70),
            font=ImageFont.load_default(size=23),
        )

    sx0 = x0 + 28
    sy0 = y0 + 190
    sx1 = x0 + 312
    sy1 = y0 + 276
    if include_strength and case.get("expected_strength"):
        strength_txt = case["expected_strength"]
        s_font_size = 36 if len(strength_txt) >= 9 else 42
        draw.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=10,
            fill=(240, 246, 251),
            outline=accent,
            width=2,
        )
        draw.text(
            (sx0 + 20, sy0 + 18),
            strength_txt,
            fill=(14, 20, 28),
            font=ImageFont.load_default(size=s_font_size),
        )
    else:
        draw.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=10,
            fill=(241, 243, 245),
            outline=(212, 216, 220),
            width=1,
        )

    if case.get("form_line"):
        draw.text(
            (sx1 + 18, sy0 + 28),
            case["form_line"],
            fill=(46, 54, 64),
            font=ImageFont.load_default(size=21),
        )

    if case.get("pack_line"):
        draw.text(
            (x0 + 28, y0 + 324),
            case["pack_line"],
            fill=(54, 62, 72),
            font=ImageFont.load_default(size=22),
        )

    if case.get("expiry_line"):
        ex0 = x1 - 242
        ey0 = y0 + 310
        ex1 = x1 - 28
        ey1 = y0 + 378
        draw.rounded_rectangle(
            (ex0, ey0, ex1, ey1),
            radius=8,
            fill=(246, 247, 249),
            outline=(156, 164, 172),
            width=2,
        )
        draw.text(
            (ex0 + 18, ey0 + 20),
            case["expiry_line"],
            fill=(22, 28, 36),
            font=ImageFont.load_default(size=25),
        )

    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(ambient)
    ad.ellipse((-100, -120, 560, 480), fill=(255, 252, 242, 24))
    ambient = ambient.filter(ImageFilter.GaussianBlur(radius=34.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), ambient).convert("RGB")

    rng = random.Random(seed)
    dx_tl = rng.uniform(4.0, 12.0)
    dy_tl = rng.uniform(4.0, 11.0)
    dx_tr = rng.uniform(4.0, 12.0)
    dy_tr = rng.uniform(5.0, 13.0)
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
    return add_sensor_grain(cropped, seed=seed)


def render_case_image(case: dict[str, Any], index: int) -> Image.Image:
    seed = 1000 + index
    if case["category"] == "clean":
        return render_carton_scene(case, include_strength=True, seed=seed)

    trap = case["trap_kind"]

    if trap == "thumb_occlusion":
        base = render_carton_scene(case, include_strength=False, seed=seed).convert("RGBA")
        cast_shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        csd = ImageDraw.Draw(cast_shadow)
        csd.rounded_rectangle((-30, 314, 444, 466), radius=62, fill=(24, 18, 14, 168))
        csd.ellipse((300, 320, 462, 472), fill=(24, 18, 14, 148))
        cast_shadow = cast_shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
        comp = Image.alpha_composite(base, cast_shadow)

        thumb = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((-50, 324, 426, 448), radius=58, fill=(208, 162, 136, 255), outline=(168, 122, 98, 255), width=3)
        td.rounded_rectangle((-40, 332, 408, 386), radius=32, fill=(218, 174, 148, 255))
        td.rounded_rectangle((338, 344, 412, 428), radius=24, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
        td.arc((226, 342, 254, 430), start=110, end=250, fill=(166, 118, 94, 210), width=3)
        td.arc((242, 346, 268, 426), start=115, end=245, fill=(174, 126, 102, 185), width=2)
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=0.8))
        return add_sensor_grain(Image.alpha_composite(comp, thumb).convert("RGB"), seed=seed + 50)

    if trap == "lower_motion_blur":
        base = render_carton_scene(case, include_strength=False, seed=seed)
        draw_b = ImageDraw.Draw(base)
        draw_b.rectangle((124, 346, 292, 374), fill=(92, 100, 112))
        draw_b.rectangle((328, 354, 520, 372), fill=(116, 124, 134))
        draw_b.rectangle((124, 456, 268, 474), fill=(118, 126, 136))

        offsets = [-24, -16, -8, 0, 8, 16, 24]
        acc = base.copy().convert("RGBA")
        for idx_o, dx in enumerate(offsets):
            shifted = base.transform(
                (768, 768),
                Image.Transform.AFFINE,
                (1, 0, -dx, 0, 1, -2),
                resample=Image.Resampling.BILINEAR,
            )
            alpha = 1.0 / (idx_o + 1)
            acc = Image.blend(acc, shifted.convert("RGBA"), alpha)
        smeared = acc.convert("RGB").filter(ImageFilter.GaussianBlur(14))

        mask = Image.new("L", (768, 768), 0)
        md = ImageDraw.Draw(mask)
        md.rectangle((0, 292, 768, 768), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(radius=18.0))
        merged = Image.composite(smeared, base, mask)
        return add_sensor_grain(merged, seed=seed + 51)

    if trap == "specular_glare":
        base = render_carton_scene(case, include_strength=False, seed=seed).convert("RGBA")
        glare = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glare)
        gd.polygon([(130, 0), (470, 0), (560, 520), (80, 520)], fill=(255, 255, 246, 135))
        gd.ellipse((74, 276, 540, 496), fill=(255, 255, 255, 255))
        gd.ellipse((104, 304, 492, 468), fill=(255, 255, 255, 255))
        glare = glare.filter(ImageFilter.GaussianBlur(radius=18.0))
        comp = Image.alpha_composite(base, glare)
        hot = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hot)
        hd.ellipse((96, 314, 456, 452), fill=(255, 255, 255, 255))
        hot = hot.filter(ImageFilter.GaussianBlur(radius=8.0))
        return add_sensor_grain(Image.alpha_composite(comp, hot).convert("RGB"), seed=seed + 52)

    if trap == "rear_barcode_only":
        pad = 64
        scene = draw_indoor_backdrop(768 + 2 * pad, pad)
        cropped = scene.crop((pad, pad, pad + 768, pad + 768))
        shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((154, 132, 634, 616), radius=14, fill=(28, 22, 16, 88))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
        img = Image.alpha_composite(cropped.convert("RGBA"), shadow).convert("RGB")
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((140, 118, 618, 600), radius=14, fill=(248, 248, 246), outline=(182, 182, 176), width=3)
        d.line((152, 184, 606, 184), fill=(224, 224, 218), width=2)
        d.line((379, 184, 379, 596), fill=(232, 232, 226), width=2)
        bx0, by0, bx1, by1 = 258, 388, 500, 538
        d.rectangle((bx0, by0, bx1, by1), fill=(255, 255, 255), outline=(206, 206, 202), width=2)
        pattern_widths = [3, 1, 2, 2, 1, 3, 1, 2, 1, 3, 2, 1, 1, 3, 2, 1, 2, 3, 1, 1, 2, 2, 3, 1, 2, 1, 3, 1, 2, 3]
        cur_x = bx0 + 20
        for w_bar in pattern_widths:
            d.rectangle((cur_x, by0 + 16, cur_x + w_bar, by0 + 106), fill=(20, 20, 22))
            cur_x += w_bar + 4
        d.text(
            (bx0 + 36, by0 + 112),
            "6432100012345",
            fill=(22, 22, 24),
            font=ImageFont.load_default(size=22),
        )
        return add_sensor_grain(img, seed=seed + 53)

    if trap == "cropped_top_edge":
        img = Image.new("RGB", (768, 768), (222, 216, 206))
        d = ImageDraw.Draw(img)
        for y in range(768):
            t = y / 768.0
            d.line((0, y, 768, y), fill=(int(232 - 24 * t), int(226 - 24 * t), int(216 - 22 * t)))
        shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((68, 492, 724, 920), radius=22, fill=(26, 20, 16, 95))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
        img = Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB")
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((54, 476, 708, 900), radius=22, fill=(250, 251, 252), outline=(170, 176, 184), width=4)
        d.rounded_rectangle((54, 476, 708, 574), radius=22, fill=(22, 114, 138))
        d.rectangle((54, 530, 708, 574), fill=(22, 114, 138))
        d.text((96, 508), "ORION PHARMA", fill=(246, 250, 252), font=ImageFont.load_default(size=30))
        d.text((96, 628), "AMLODIPIN", fill=(16, 22, 30), font=ImageFont.load_default(size=68))
        return add_sensor_grain(img, seed=seed + 54)

    if trap == "defocused_bottle":
        pad = 64
        scene = draw_indoor_backdrop(768 + 2 * pad, pad).crop((pad, pad, pad + 768, pad + 768))
        d = ImageDraw.Draw(scene)
        d.rounded_rectangle((286, 152, 482, 224), radius=14, fill=(244, 244, 240), outline=(188, 188, 182), width=3)
        for rx in range(296, 474, 12):
            d.line((rx, 158, rx, 218), fill=(214, 214, 208), width=2)
        d.rectangle((312, 224, 456, 260), fill=(138, 74, 28))
        d.rounded_rectangle((256, 252, 512, 624), radius=34, fill=(146, 78, 28), outline=(104, 52, 16), width=3)
        d.rectangle((276, 272, 308, 600), fill=(176, 102, 44))
        d.rectangle((264, 332, 504, 544), fill=(248, 247, 242), outline=(196, 194, 188), width=2)
        d.rectangle((286, 360, 462, 384), fill=(44, 88, 136))
        d.rectangle((286, 408, 442, 426), fill=(72, 76, 82))
        d.rectangle((286, 446, 412, 462), fill=(112, 116, 122))
        d.rectangle((286, 482, 388, 496), fill=(132, 136, 142))
        blurred = scene.filter(ImageFilter.GaussianBlur(18))
        return add_sensor_grain(blurred, seed=seed + 55)

    if trap == "dim_noisy_night":
        rng = random.Random(seed + 56)
        img = Image.new("RGB", (768, 768), (10, 11, 14))
        d = ImageDraw.Draw(img)
        for y in range(768):
            v = int(8 + 8 * (y / 768.0))
            d.line((0, y, 768, y), fill=(v, v + 1, v + 3))
        d.rounded_rectangle((148, 186, 620, 558), radius=16, fill=(19, 20, 25), outline=(25, 26, 32), width=2)
        d.rectangle((184, 246, 418, 274), fill=(24, 25, 31))
        d.rectangle((184, 304, 356, 326), fill=(22, 23, 29))
        img = img.filter(ImageFilter.GaussianBlur(radius=6.0))
        raw = bytearray(img.tobytes())
        for i in range(0, len(raw), 3):
            lum = rng.gauss(0.0, 14.0)
            for c in range(3):
                nv = int(raw[i + c] + lum + rng.gauss(0.0, 4.5))
                raw[i + c] = 0 if nv < 0 else (255 if nv > 255 else nv)
        return Image.frombytes("RGB", (768, 768), bytes(raw))

    if trap == "side_flap_storage_only":
        pad = 64
        scene = draw_indoor_backdrop(768 + 2 * pad, pad).crop((pad, pad, pad + 768, pad + 768))
        shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((226, 136, 566, 636), radius=12, fill=(28, 22, 16, 90))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
        img = Image.alpha_composite(scene.convert("RGBA"), shadow).convert("RGB")
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((212, 122, 552, 622), radius=12, fill=(249, 250, 248), outline=(176, 180, 178), width=3)
        d.line((218, 172, 546, 172), fill=(216, 220, 218), width=2)
        d.line((218, 572, 546, 572), fill=(216, 220, 218), width=2)
        d.text(
            (238, 332),
            "Keep out of reach of children.",
            fill=(30, 34, 40),
            font=ImageFont.load_default(size=20),
        )
        d.text(
            (238, 368),
            "Store below 25 C",
            fill=(30, 34, 40),
            font=ImageFont.load_default(size=20),
        )
        return add_sensor_grain(img, seed=seed + 57)

    if trap == "torn_pharmacy_sticker":
        base = render_carton_scene(case, include_strength=False, seed=seed).convert("RGBA")
        sticker_shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        ssd = ImageDraw.Draw(sticker_shadow)
        torn_poly = [
            (102, 314),
            (418, 308),
            (432, 328),
            (414, 352),
            (436, 376),
            (412, 404),
            (428, 430),
            (398, 454),
            (292, 448),
            (196, 456),
            (104, 446),
        ]
        ssd.polygon([(px + 3, py + 4) for px, py in torn_poly], fill=(30, 26, 22, 95))
        sticker_shadow = sticker_shadow.filter(ImageFilter.GaussianBlur(radius=3.5))
        comp = Image.alpha_composite(base, sticker_shadow)

        sticker = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        std = ImageDraw.Draw(sticker)
        fringe_poly = [(px + (5 if px > 390 else 0), py + (4 if py > 430 else 0)) for px, py in torn_poly]
        std.polygon(fringe_poly, fill=(232, 230, 224, 245))
        std.polygon(torn_poly, fill=(252, 251, 247, 255), outline=(208, 206, 198, 255))
        std.line((118, 336, 386, 334), fill=(64, 118, 88, 210), width=3)
        std.text((120, 348), "APTEEKKI / APOTEK", fill=(72, 76, 80, 235), font=ImageFont.load_default(size=17))
        std.line((120, 384, 344, 382), fill=(196, 196, 190, 220), width=2)
        std.line((120, 412, 298, 410), fill=(204, 204, 198, 220), width=2)
        return add_sensor_grain(Image.alpha_composite(comp, sticker).convert("RGB"), seed=seed + 58)

    raise ValueError(f"Unsupported trap_kind: {trap}")


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


def ensure_node_and_deps() -> str:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    extra_paths = [
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


def run_ts_safety_batch(
    node_bin: str,
    profile: dict[str, Any],
    raw_cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ts_code = """
import fs from "node:fs";
import { toLabelRead } from "./server/src/verify.ts";
import { checkLabel, ingredientsOf, sameStrength } from "./server/src/safety.ts";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evalNow = new Date("2026-11-14T12:00:00Z");
const results = input.cases.map((c) => {
  const read = toLabelRead(c.raw);
  const verdict = checkLabel(read, input.profile, evalNow);
  const strengthSame = c.expected_strength ? sameStrength(read.strength.value, c.expected_strength) : false;
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
    strengthSame,
    gotIngredients,
  };
});
process.stdout.write(JSON.stringify(results));
"""
    stdin_payload = json.dumps({"profile": profile, "cases": raw_cases}, ensure_ascii=False)
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "-e", ts_code],
        input=stdin_payload,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS safety evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    return json.loads(proc.stdout)


def main() -> None:
    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    node_bin = ensure_node_and_deps()
    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    SYNTH_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

    raw_batch_inputs: list[dict[str, Any]] = []
    call_meta: dict[str, dict[str, Any]] = {}

    for idx, case in enumerate(CASES, start=1):
        cid = case["id"]
        img_path = SYNTH_DIR / f"{cid}.jpg"
        img = render_case_image(case, idx)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 image for {cid}, got {img.size}")
        b64_jpeg = encode_jpeg_b64(img, img_path)

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
            "latency_ms": round(latency_ms, 1),
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
        }
        print(f"[{idx:02d}/18 {cid}] gemini latency={latency_ms:.1f}ms in={tok['in']} out={tok['out']}")

    ts_outputs = {row["id"]: row for row in run_ts_safety_batch(node_bin, DEMO_PROFILE, raw_batch_inputs)}

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

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        strength_same = bool(ts_row["strengthSame"])

        if case["strength_readable"]:
            ing_ok = (
                case["expected_ingredient"] in ts_row["gotIngredients"]
                and (
                    float(read_obj["ingredient"]["confidence"]) >= NAME_MIN_CONF
                    or float(read_obj["product"]["confidence"]) >= NAME_MIN_CONF
                )
            )
            strength_ok = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            exp_expected = case["expected_expiry"]
            if exp_expected is not None:
                expiry_ok = (
                    read_obj["expiry"]["value"] == exp_expected
                    and float(read_obj["expiry"]["confidence"]) >= EXPIRY_MIN_CONF
                )
            else:
                expiry_ok = True
            strength_correct = strength_ok
            clean_fields_ok = bool(read_obj["kind"] == "medication" and ing_ok and strength_ok and expiry_ok)
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        else:
            strength_correct = s_val is None and s_conf < STRENGTH_MIN_CONF
            clean_fields_ok = None
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF)
                or (pred_level == "match")
            )
            abstained = pred_level == "unsure"

        item_record = {
            "id": cid,
            "category": case["category"],
            "description": sanitize_obj(case["description"]),
            "image_path": meta["image_path"],
            "strength_readable": case["strength_readable"],
            "expected_level": exp_level,
            "expected_strength": case["expected_strength"],
            "expected_ingredient": case["expected_ingredient"],
            "expected_expiry": case["expected_expiry"],
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "clean_fields_correct": clean_fields_ok,
            "abstained": abstained,
            "dose_abstained": bool(s_val is None or s_conf < STRENGTH_MIN_CONF),
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
            f"  -> {cid}: exp={exp_level} pred={pred_level} match={verdict_match} "
            f"strength={s_val!r} ({s_conf:.2f}) cwd={confident_wrong_dose}"
        )

    n_items = len(items)
    verdict_matches = sum(1 for it in items if it["verdict_match"])
    clean_items = [it for it in items if it["strength_readable"]]
    occ_items = [it for it in items if not it["strength_readable"]]

    clean_field_acc = round(
        sum(1 for it in clean_items if it["clean_fields_correct"]) / len(clean_items),
        4,
    )
    occ_abstention_rate = round(
        sum(1 for it in occ_items if it["abstained"]) / len(occ_items),
        4,
    )
    cwd_count = sum(1 for it in items if it["confident_wrong_dose"])
    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items)

    summary = {
        "model": MODEL_NAME,
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4),
        "clean_field_accuracy": clean_field_acc,
        "occluded_abstention_rate": occ_abstention_rate,
        "confident_wrong_dose_count": cwd_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile_summary": {
                "meds": [f'{m["name"]} {m["strength"]}' for m in DEMO_PROFILE["meds"]],
                "allergies": DEMO_PROFILE["allergies"],
                "avoid": DEMO_PROFILE["avoid"],
            },
            "summary": summary,
            "items": items,
        }
    )

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if "\u2014" in serialized or "\u2013" in serialized:
        raise RuntimeError("Forbidden dash character detected in serialized report")
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
