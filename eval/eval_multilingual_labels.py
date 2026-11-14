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

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "multilingual"
OUT_JSON_PATH = REPO_ROOT / "eval" / "multilingual_labels_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
LANGUAGES_TESTED = ["fi", "sv", "de", "fr", "es", "en"]

PROFILE: dict[str, Any] = {
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
        "id": "ml_01",
        "language": "fi",
        "languages": ["fi"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "AMLODIPIN ORION 5 mg tabletti / Vaikuttava aine: amlodipiini / EXP 2027-10",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "5 mg",
        "ground_truth_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": -1.8,
        "accent": (20, 104, 146),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "strength_badge": "5 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: amlodipiini",
        "pack_line": "30 tablettia    Suun kautta",
        "expiry_line": "EXP 2027-10",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_02",
        "language": "sv",
        "languages": ["sv"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "METFORMIN ACTAVIS 500 mg filmdragerade tabletter / EXP 2027-12",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "500 mg",
        "ground_truth_strength": "500 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": 1.6,
        "accent": (34, 82, 162),
        "header": "ACTAVIS    Vnr 12 73 09",
        "title": "METFORMIN ACTAVIS",
        "strength_badge": "500 mg",
        "form_line": "filmdragerade tabletter",
        "sub_line": "Aktiv substans: metforminhydroklorid",
        "pack_line": "100 filmdragerade tabletter",
        "expiry_line": "EXP 2027-12",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_03",
        "language": "fi",
        "languages": ["fi"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "BURANA 400 mg tabletti / ibuprofeeni / 30 tabl.",
        "expected_level": "warning",
        "strength_readable": True,
        "printed_strength": "400 mg",
        "ground_truth_strength": "400 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": -2.1,
        "accent": (186, 34, 44),
        "header": "ORION PHARMA    Vnr 01 66 40",
        "title": "BURANA",
        "strength_badge": "400 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: ibuprofeeni",
        "pack_line": "30 tabl.",
        "expiry_line": "EXP 2027-11",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_04",
        "language": "de",
        "languages": ["de"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "AMLODIPIN STADA 5 mg Tabletten / Wirkstoff: Amlodipin / Verwendbar bis 2027-09",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "5 mg",
        "ground_truth_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": 1.9,
        "accent": (174, 28, 42),
        "header": "STADA ARZNEIMITTEL    PZN 04128831",
        "title": "AMLODIPIN STADA",
        "strength_badge": "5 mg",
        "form_line": "Tabletten",
        "sub_line": "Wirkstoff: Amlodipin",
        "pack_line": "30 Tabletten N1    Zum Einnehmen",
        "expiry_line": "Verwendbar bis 2027-09",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_05",
        "language": "fr",
        "languages": ["fr"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "AMLODIPINE BIOGARAN 10 mg gelules / EXP 2027-08",
        "expected_level": "warning",
        "strength_readable": True,
        "printed_strength": "10 mg",
        "ground_truth_strength": "10 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": -1.5,
        "accent": (58, 66, 148),
        "header": "BIOGARAN    CIP 34009 362 41",
        "title": "AMLODIPINE BIOGARAN",
        "strength_badge": "10 mg",
        "form_line": "gelules",
        "sub_line": "Substance active : amlodipine",
        "pack_line": "30 gelules    Voie orale",
        "expiry_line": "EXP 2027-08",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_06",
        "language": "es",
        "languages": ["es"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "PARACETAMOL KERN PHARMA 500 mg comprimidos / CAD 2027-11",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "500 mg",
        "ground_truth_strength": "500 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": 2.0,
        "accent": (22, 118, 96),
        "header": "KERN PHARMA    CN 658412.4",
        "title": "PARACETAMOL KERN PHARMA",
        "strength_badge": "500 mg",
        "form_line": "comprimidos",
        "sub_line": "Principio activo: paracetamol",
        "pack_line": "20 comprimidos EFG    Via oral",
        "expiry_line": "CAD 2027-11",
        "occlude_strength_thumb": False,
    },
    {
        "id": "ml_07",
        "language": "fi",
        "languages": ["fi"],
        "kind": "food",
        "render_style": "food_carton",
        "description": "Suklainen myslipatukka / Ainesosat: kaura, sokeri, paahdettu maapahkina (15%), kaakaovoi",
        "expected_level": "warning",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": -1.7,
        "accent": (128, 68, 36),
        "pack_fill": (246, 238, 224),
        "header": "POHJOLAN HERKUT",
        "title": "Suklainen myslipatukka",
        "umlaut_a_index": None,
        "sub_title": "Rapea valipalapatukka  45 g",
        "ingredients_lines": [
            "Ainesosat: kaura, sokeri,",
            "paahdettu maapahkina (15%), kaakaovoi.",
        ],
        "allergen_lines": [
            "Sisaltaa: maapahkina, kaura.",
        ],
        "expiry_line": "Parasta ennen 2027-10",
        "weight_line": "45 g",
    },
    {
        "id": "ml_08",
        "language": "sv",
        "languages": ["sv"],
        "kind": "food",
        "render_style": "food_carton",
        "description": "Notsmorskräm / Ingredienser: socker, hasselnotter (18%), kakao",
        "expected_level": "warning",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": 1.8,
        "accent": (106, 56, 32),
        "pack_fill": (247, 239, 227),
        "header": "SVENSKA DELIKATESSER",
        "title": "Notsmorskram",
        "umlaut_a_index": 10,
        "sub_title": "Bredbar kram med kakao  350 g",
        "ingredients_lines": [
            "Ingredienser: socker,",
            "hasselnotter (18%), kakao.",
        ],
        "allergen_lines": [
            "Innehaller: hasselnotter.",
        ],
        "expiry_line": "Bast fore 2027-11",
        "weight_line": "350 g",
    },
    {
        "id": "ml_09",
        "language": "fi",
        "languages": ["fi"],
        "kind": "food",
        "render_style": "food_carton",
        "description": "Kaurajuoma / Ainesosat: vesi, kaura (10%), rypsioljy, suola. Parasta ennen 2027-11",
        "expected_level": "info",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": -1.4,
        "accent": (38, 108, 128),
        "pack_fill": (244, 248, 249),
        "header": "POHJAN KAURA",
        "title": "Kaurajuoma",
        "umlaut_a_index": None,
        "sub_title": "Kasvipohjainen juoma  1 L",
        "ingredients_lines": [
            "Ainesosat: vesi, kaura (10%),",
            "rypsioljy, suola.",
        ],
        "allergen_lines": [],
        "expiry_line": "Parasta ennen 2027-11",
        "weight_line": "1 L",
    },
    {
        "id": "ml_10",
        "language": "sv",
        "languages": ["sv"],
        "kind": "food",
        "render_style": "food_carton",
        "description": "Havredryck / Ingredienser: vatten, havre (10%), rapsolja, salt. Bast fore 2027-10",
        "expected_level": "info",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": 1.5,
        "accent": (42, 98, 146),
        "pack_fill": (244, 247, 251),
        "header": "NORDISK HAVRE",
        "title": "Havredryck",
        "umlaut_a_index": None,
        "sub_title": "Vaxtbaserad dryck  1 L",
        "ingredients_lines": [
            "Ingredienser: vatten, havre (10%),",
            "rapsolja, salt.",
        ],
        "allergen_lines": [],
        "expiry_line": "Bast fore 2027-10",
        "weight_line": "1 L",
    },
    {
        "id": "ml_11",
        "language": "en",
        "languages": ["en", "de", "fr"],
        "kind": "medication",
        "render_style": "med_box",
        "description": "AMLODIPIN / AMLODIPINE multilingual carton with thumb occluding strength completely",
        "expected_level": "unsure",
        "strength_readable": False,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "box_angle": -1.2,
        "accent": (24, 98, 134),
        "header": "EUROPAPHARMA    EU/1/24/1820",
        "title": "AMLODIPIN / AMLODIPINE",
        "strength_badge": None,
        "form_line": "Tablets / Tabletten / Gelules",
        "sub_line": "Active substance: amlodipine / Wirkstoff: Amlodipin",
        "pack_line": "Oral use / Zum Einnehmen / Voie orale",
        "expiry_line": "EXP 2027-10",
        "occlude_strength_thumb": True,
    },
    {
        "id": "ml_12",
        "language": "fr",
        "languages": ["fr", "en"],
        "kind": "food",
        "render_style": "front_biscuit_box",
        "description": "Biscuits Fins Artisanaux 250g front-of-box food carton without ingredients",
        "expected_level": "unsure",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "box_angle": 1.4,
        "accent": (36, 58, 108),
        "pack_fill": (248, 242, 228),
        "header": "MAISON DELACROIX",
        "title": "Biscuits Fins Artisanaux",
        "sub_title": "Fine Artisan Biscuits",
        "weight_line": "250g",
    },
]


def load_env_fallback() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
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


def sanitize_text(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace("\u2014", " - ").replace("\u2013", "-")
    if isinstance(val, list):
        return [sanitize_text(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_text(k): sanitize_text(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if "\u2014" in node:
            raise AssertionError(f"Em dash found in JSON string: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in JSON output")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


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


def parse_strength_mg(text: str | None) -> tuple[float, str] | None:
    if not text:
        return None
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg|ug|mikrog)\b", normed)
    if not m:
        return None
    amt = float(m.group(1))
    unit = m.group(2)
    factors = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "ug": 0.001, "mikrog": 0.001}
    return (round(amt * factors[unit], 6), "mg")


def same_strength_simple(a: str | None, b: str | None) -> bool:
    pa = parse_strength_mg(a)
    pb = parse_strength_mg(b)
    if pa is None or pb is None:
        return False
    return pa[1] == pb[1] and abs(pa[0] - pb[0]) < 1e-6


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 16) -> Any:
    size = start_size
    while size > min_size:
        font = ImageFont.load_default(size=size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 1
    return ImageFont.load_default(size=min_size)


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    noise = Image.new("L", (w // 2, h // 2))
    px = [128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range((w // 2) * (h // 2))]
    noise.putdata(px)
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    blend_alpha = 0.05
    r = Image.blend(r, noise, blend_alpha)
    g = Image.blend(g, noise, blend_alpha)
    b = Image.blend(b, noise, blend_alpha)
    return Image.merge("RGB", (r, g, b))


def render_tabletop_canvas(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (222, 214, 202))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.62)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(236 - 24 * t), int(230 - 24 * t), int(220 - 22 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 100)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(186 - 26 * t) + jitter)),
            max(0, min(255, int(158 - 22 * t) + jitter)),
            max(0, min(255, int(126 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(142, 114, 88), width=2)
    return canvas


def render_med_box(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 118, pad + 704, pad + 634
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(26, 22, 18, 92))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], bw - 56, 22)
    cd.text((28, 18), case["header"], fill=(246, 249, 252), font=f_hdr)

    title_col = (16, 22, 30)
    f_title = fit_font(cd, case["title"], bw - 56, 40)
    cd.text(
        (28, 82),
        case["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )

    f_sub = fit_font(cd, case["sub_line"], bw - 56, 23)
    cd.text((28, 140), case["sub_line"], fill=(54, 62, 74), font=f_sub)

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 186, 256, 266
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
        f_str = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 32, 42)
        cd.text(
            (sx0 + 18, sy0 + 16),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=f_str,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        f_form = fit_font(cd, case["form_line"], bw - sx1 - 44, 25)
        cd.text((sx1 + 18, sy0 + 26), case["form_line"], fill=(34, 42, 52), font=f_form)
    else:
        f_form = fit_font(cd, case["form_line"], bw - 340, 23)
        cd.text((312, 214), case["form_line"], fill=(38, 46, 56), font=f_form)

    if case["pack_line"]:
        f_pack = fit_font(cd, case["pack_line"], bw - 56, 22)
        cd.text((28, 304), case["pack_line"], fill=(52, 60, 70), font=f_pack)

    if case["expiry_line"]:
        f_exp = fit_font(cd, case["expiry_line"], 310, 24)
        exp_w = int(cd.textlength(case["expiry_line"], font=f_exp)) + 36
        ex0 = max(28, bw - exp_w - 28)
        cd.rounded_rectangle((ex0, 384, bw - 28, 440), radius=8, fill=(242, 245, 248), outline=(164, 172, 182), width=2)
        cd.text((ex0 + 18, 398), case["expiry_line"], fill=(18, 24, 30), font=f_exp)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)

    glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glare).ellipse((-90, -110, 520, 420), fill=(255, 253, 246, 20))
    glare = glare.filter(ImageFilter.GaussianBlur(radius=32.0))
    cropped = Image.alpha_composite(composed, glare).crop((pad, pad, pad + 768, pad + 768))

    if case["occlude_strength_thumb"]:
        cast_shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        csd = ImageDraw.Draw(cast_shadow)
        csd.rounded_rectangle((-40, 294, 376, 426), radius=58, fill=(24, 18, 14, 172))
        csd.ellipse((248, 298, 392, 430), fill=(24, 18, 14, 150))
        cast_shadow = cast_shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
        cropped = Image.alpha_composite(cropped, cast_shadow)

        thumb = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((-54, 300, 364, 416), radius=54, fill=(208, 162, 136, 255), outline=(168, 122, 98, 255), width=3)
        td.rounded_rectangle((-44, 308, 346, 358), radius=30, fill=(218, 174, 148, 255))
        td.rounded_rectangle((280, 318, 350, 398), radius=22, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
        td.arc((184, 316, 210, 398), start=110, end=250, fill=(166, 118, 94, 210), width=3)
        td.arc((200, 320, 224, 394), start=115, end=245, fill=(174, 126, 102, 185), width=2)
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=0.8))
        cropped = Image.alpha_composite(cropped, thumb)

    return cropped.convert("RGB")


def render_food_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 116, pad + 78, pad + 652, pad + 694
    cw, ch = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 16, 95))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    carton = Image.new("RGB", (cw, ch), case["pack_fill"])
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 72), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], cw - 52, 22)
    cd.text((26, 24), case["header"], fill=(246, 249, 246), font=f_hdr)

    title_col = (22, 34, 28)
    f_title = fit_font(cd, case["title"], cw - 52, 40)
    cd.text(
        (26, 94),
        case["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )
    umlaut_idx = case.get("umlaut_a_index")
    if isinstance(umlaut_idx, int) and 0 <= umlaut_idx < len(case["title"]):
        prefix_w = cd.textlength(case["title"][:umlaut_idx], font=f_title)
        char_w = cd.textlength(case["title"][umlaut_idx], font=f_title)
        cx = int(26 + prefix_w + char_w * 0.5)
        cy = 97
        cd.ellipse((cx - 6, cy, cx - 2, cy + 4), fill=title_col)
        cd.ellipse((cx + 2, cy, cx + 6, cy + 4), fill=title_col)

    f_sub = fit_font(cd, case["sub_title"], cw - 52, 23)
    cd.text((26, 152), case["sub_title"], fill=(56, 68, 62), font=f_sub)

    panel_bottom = 446 if case["allergen_lines"] else 390
    cd.rounded_rectangle((24, 202, cw - 24, panel_bottom), radius=12, fill=(253, 252, 248), outline=(182, 176, 164), width=2)
    iy = 222
    for ln in case["ingredients_lines"]:
        f_ing = fit_font(cd, ln, cw - 80, 23)
        cd.text((40, iy), ln, fill=(24, 28, 28), font=f_ing)
        iy += 36

    if case["allergen_lines"]:
        iy += 12
        cd.rounded_rectangle((36, iy - 6, cw - 36, iy + 54), radius=8, fill=(255, 243, 232), outline=(196, 118, 62), width=2)
        for ln in case["allergen_lines"]:
            f_alg = fit_font(cd, ln, cw - 96, 23)
            cd.text((48, iy + 8), ln, fill=(112, 36, 18), font=f_alg, stroke_width=1, stroke_fill=(112, 36, 18))
            iy += 32

    exp_y = panel_bottom + 24
    cd.rounded_rectangle((24, exp_y, cw - 24, exp_y + 62), radius=8, fill=(255, 255, 255), outline=(192, 188, 178), width=2)
    f_exp = fit_font(cd, case["expiry_line"], cw - 80, 25)
    cd.text((40, exp_y + 18), case["expiry_line"], fill=(20, 26, 28), font=f_exp)

    cd.text((28, ch - 50), case["weight_line"], fill=(56, 68, 62), font=ImageFont.load_default(size=25))

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(168, 162, 150, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_front_biscuit_box(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 104, pad + 118, pad + 664, pad + 634
    cw, ch = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=16, fill=(28, 22, 16, 95))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    carton = Image.new("RGB", (cw, ch), case["pack_fill"])
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rounded_rectangle((16, 16, cw - 16, ch - 16), radius=12, outline=case["accent"], width=3)
    cd.rounded_rectangle((48, 44, cw - 48, 118), radius=10, fill=case["accent"])

    f_brand = fit_font(cd, case["header"], cw - 130, 30)
    f_title = fit_font(cd, case["title"], cw - 64, 38)
    f_sub = fit_font(cd, case["sub_title"], cw - 80, 24)
    f_wt = ImageFont.load_default(size=28)

    cx_mid = cw // 2
    bw_t = cd.textlength(case["header"], font=f_brand)
    tw_t = cd.textlength(case["title"], font=f_title)
    sw_t = cd.textlength(case["sub_title"], font=f_sub)
    ww_t = cd.textlength(case["weight_line"], font=f_wt)

    cd.text((int(cx_mid - bw_t / 2), 64), case["header"], fill=(252, 244, 218), font=f_brand)
    cd.text((int(cx_mid - tw_t / 2), 146), case["title"], fill=(26, 40, 76), font=f_title, stroke_width=1, stroke_fill=(26, 40, 76))
    cd.text((int(cx_mid - sw_t / 2), 200), case["sub_title"], fill=(56, 68, 96), font=f_sub)

    for bx_c, by_c in ((cw // 2 - 96, 336), (cw // 2 + 8, 318), (cw // 2 + 88, 356)):
        cd.ellipse((bx_c - 52, by_c - 52, bx_c + 52, by_c + 52), fill=(224, 178, 104), outline=(184, 136, 66), width=3)
        cd.ellipse((bx_c - 32, by_c - 32, bx_c + 32, by_c + 32), outline=(202, 154, 82), width=2)

    cd.text((int(cx_mid - ww_t / 2), ch - 68), case["weight_line"], fill=(32, 44, 72), font=f_wt)

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(176, 158, 122, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261148 + idx * 41
    style = case["render_style"]
    if style == "med_box":
        return render_med_box(case, seed)
    if style == "food_carton":
        return render_food_carton(case, seed)
    if style == "front_biscuit_box":
        return render_front_biscuit_box(case, seed)
    raise ValueError(f"Unknown render_style: {style}")


def encode_jpeg(img: Image.Image, out_path: pathlib.Path) -> str:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    raw_bytes = buf.getvalue()
    out_path.write_bytes(raw_bytes)
    return base64.b64encode(raw_bytes).decode("ascii")


def call_gemini_flash(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, int, int, int]:
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
                    tok_in = int(usage.get("promptTokenCount") or 0)
                    tok_out = int(usage.get("candidatesTokenCount") or usage.get("responseTokenCount") or 0)
                    tok_think = int(usage.get("thoughtsTokenCount") or 0)
                    return parsed, latency_ms, tok_in, tok_out, tok_think
                last_err = "empty structured output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini call failed after retries: {last_err}")


def evaluate_via_typescript(
    raw_items: list[dict[str, Any]],
    profile: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    node_bin = shutil.which("node")
    if not node_bin and pathlib.Path("/tmp/fleet-silas/node/bin/node").is_file():
        node_bin = "/tmp/fleet-silas/node/bin/node"
    if not node_bin:
        raise RuntimeError("node binary not found in PATH")

    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel, sameStrength } from "./server/src/safety.ts";

const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const profile = toProfile(payload.profile);
const evaluated = payload.items.map((entry) => {
  const read = toLabelRead(entry.raw_json);
  const verdict = checkLabel(read, profile);
  const { read: _omit, ...verdictMeta } = verdict;
  const strengthMatchesExpected = entry.ground_truth_strength
    ? sameStrength(read.strength.value, entry.ground_truth_strength)
    : false;
  return { id: entry.id, read, verdict: verdictMeta, strengthMatchesExpected };
});
process.stdout.write(JSON.stringify({ evaluated }));
"""
    env = dict(os.environ)
    node_dir = str(pathlib.Path(node_bin).parent)
    env["PATH"] = f"{node_dir}:{env.get('PATH', '')}"

    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"profile": profile, "items": raw_items}),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    out = json.loads(proc.stdout)
    return {row["id"]: row for row in out["evaluated"]}


def main() -> None:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    raw_runs: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        img = render_case_image(case, idx)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 image for {case['id']}, got {img.size}")
        b64_jpeg = encode_jpeg(img, img_path)
        raw_json, latency_ms, tok_in, tok_out, tok_think = call_gemini_flash(
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
                "raw_json": raw_json,
                "latency_ms": round(latency_ms, 1),
                "tokens_in": tok_in,
                "tokens_out": tok_out,
                "tokens_thinking": tok_think,
            }
        )

    ts_payload = [
        {
            "id": r["case"]["id"],
            "raw_json": r["raw_json"],
            "ground_truth_strength": r["case"]["ground_truth_strength"],
        }
        for r in raw_runs
    ]
    ts_results = evaluate_via_typescript(ts_payload, PROFILE)

    items_out: list[dict[str, Any]] = []
    for run in raw_runs:
        case = run["case"]
        cid = case["id"]
        ts_row = ts_results[cid]
        read_obj = sanitize_text(ts_row["read"])
        verdict_obj = sanitize_text(ts_row["verdict"])

        pred_level = verdict_obj["level"]
        exp_level = case["expected_level"]
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        gt_strength = case["ground_truth_strength"]
        sr = case["strength_readable"]

        strength_correct: bool | None = None
        abstained: bool | None = None
        confident_wrong_dose = False

        if case["kind"] == "medication":
            if sr is True:
                strength_correct = bool(
                    s_val
                    and s_conf >= STRENGTH_MIN_CONF
                    and (ts_row["strengthMatchesExpected"] or same_strength_simple(s_val, gt_strength))
                )
                if (bool(s_val) and s_conf >= STRENGTH_MIN_CONF and not strength_correct) or (
                    exp_level != "match" and pred_level == "match"
                ):
                    confident_wrong_dose = True
            else:
                abstained = pred_level == "unsure"
                if (bool(s_val) and s_conf >= STRENGTH_MIN_CONF) or pred_level == "match":
                    confident_wrong_dose = True
        else:
            if not case["panel_readable"]:
                abstained = pred_level == "unsure"
            if pred_level == "match":
                confident_wrong_dose = True

        reasons = verdict_obj.get("reasons") or []
        allergen_reason_hit = any("allergy:" in str(r) for r in reasons)
        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)
        false_safe_allergen = bool(
            case["kind"] == "food"
            and (
                (case["has_profile_allergen"] and not allergen_detected)
                or (not case["panel_readable"] and pred_level in ("info", "match"))
            )
        )

        item_entry = {
            "id": cid,
            "language": case["language"],
            "languages": case["languages"],
            "description": sanitize_text(case["description"]),
            "kind": case["kind"],
            "image_path": run["image_path"],
            "strength_readable": sr,
            "printed_strength": case["printed_strength"],
            "ground_truth_strength": gt_strength,
            "has_profile_allergen": case["has_profile_allergen"],
            "panel_readable": case["panel_readable"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "allergen_detected": allergen_detected,
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
        items_out.append(item_entry)
        print(
            f"[{cid}] lang={case['language']} expected={exp_level} predicted={pred_level} "
            f"match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} fsa={false_safe_allergen} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)
    cwd_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    fsa_count = sum(1 for it in items_out if it["false_safe_allergen"])

    readable_meds = [it for it in items_out if it["strength_readable"] is True]
    trap_items = [it for it in items_out if it["expected_level"] == "unsure"]
    allergen_pos = [it for it in items_out if it["has_profile_allergen"]]

    clean_field_accuracy = round(
        sum(1 for it in readable_meds if it["strength_correct"]) / len(readable_meds),
        4,
    )
    occluded_abstention_rate = round(
        sum(1 for it in trap_items if it["abstained"]) / len(trap_items),
        4,
    )
    allergen_recall = round(
        sum(1 for it in allergen_pos if it["allergen_detected"]) / len(allergen_pos),
        4,
    )

    latencies = [it["latency_ms"] for it in items_out]
    total_tokens_in = sum(it["tokens_in"] for it in items_out)
    total_tokens_out = sum(it["tokens_out"] for it in items_out)
    total_tokens_thinking = sum(it["tokens_thinking"] for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "languages_tested": list(LANGUAGES_TESTED),
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "allergen_recall": allergen_recall,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
        "mean_tokens_in": round(total_tokens_in / n_items, 1),
        "mean_tokens_out": round(total_tokens_out / n_items, 1),
    }

    report = sanitize_text(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": PROFILE,
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_output(report)
    OUT_JSON_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
