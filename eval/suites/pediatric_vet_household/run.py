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


def tmp_base_dir() -> str:
    env_tmp = os.environ.get("TMPDIR")
    if env_tmp and os.path.isdir(env_tmp):
        return env_tmp
    return "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()


os.environ.setdefault("HOLDUP_OUT", os.path.join(tmp_base_dir(), "holdup_eval_out"))
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

from common import load_env, parse_json
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "pediatric_vet_household"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"
RESULTS_PATH = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"

HASH_CH = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "par", "name": "Paracetamol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
        {"id": "aml", "name": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
    ],
    "allergies": ["peanut", "penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "hh_01",
        "scenario": "own_adult_paracetamol_500mg_tablet_match",
        "household_source": "own_adult",
        "scene_type": "med_carton",
        "question": "Is this my adult 500 mg paracetamol tablet?",
        "expected_level": "match",
        "gt_strength": "500 mg",
        "accent": (22, 98, 152),
        "header": "ORION PHARMA",
        "title": "Paracetamol",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-11",
        "sticker_header": "APTEEKKI - ADULT PATIENT",
        "sticker_lines": [
            "Paracetamol 500 mg: 1 tablet as needed for pain.",
            "Adult household pack  EXP 2027-11",
        ],
        "tilt_deg": -1.3,
        "sticker_tilt_deg": 1.0,
    },
    {
        "id": "hh_02",
        "scenario": "grandchild_panadol_junior_24mg_ml_suspension_warning",
        "household_source": "grandchild_pediatric",
        "scene_type": "bottle_front",
        "bottle_plastic": "amber",
        "cap_color": (244, 244, 246),
        "occlude_thumb": False,
        "question": "Can I take this Panadol from the kitchen shelf for my headache?",
        "expected_level": "warning",
        "gt_strength": "24 mg/ml",
        "accent": (196, 42, 108),
        "header": "HALEON NORDIC - PEDIATRIC",
        "title": "Panadol Junior",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": "24 mg/ml",
        "form_line": "Oral suspension for children (strawberry)",
        "expiry_line": "EXP 2027-10",
        "sticker_header": "PEDIATRIC ORAL SYRINGE BOTTLE",
        "sticker_lines": [
            "Panadol Junior 24 mg/ml oral suspension.",
            "For child fever care  EXP 2027-10",
        ],
        "tilt_deg": 1.4,
    },
    {
        "id": "hh_03",
        "scenario": "adult_panadol_forte_1g_double_strength_warning",
        "household_source": "household_double_strength",
        "scene_type": "med_carton",
        "question": "Is this my regular 500 mg Panadol tablet?",
        "expected_level": "warning",
        "gt_strength": "1 g",
        "accent": (176, 28, 38),
        "header": "HALEON NORDIC",
        "title": "Panadol Forte",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": "1 g",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-12",
        "sticker_header": "APTEEKKI - STRONG TABLET",
        "sticker_lines": [
            "Panadol Forte 1 g: 1 tablet up to 3 times daily.",
            "Double strength carton  EXP 2027-12",
        ],
        "tilt_deg": 1.6,
        "sticker_tilt_deg": -1.2,
    },
    {
        "id": "hh_04",
        "scenario": "veterinary_rimadyl_50mg_carprofen_nsaid_warning",
        "household_source": "pet_veterinary",
        "scene_type": "bottle_front",
        "bottle_plastic": "white_hdpe",
        "cap_color": (38, 106, 72),
        "occlude_thumb": False,
        "question": "Can I take this tablet bottle from the kitchen cabinet for joint pain?",
        "expected_level": "warning",
        "gt_strength": "50 mg",
        "accent": (36, 112, 68),
        "header": "ZOETIS VETERINARY - FOR DOGS",
        "title": "Rimadyl",
        "subtitle": "Active ingredient: carprofen",
        "strength_badge": "50 mg",
        "form_line": "Chewable tablets for dogs (veterinary NSAID)",
        "expiry_line": "EXP 2027-08",
        "sticker_header": "ELAINLAAKARI - FOR DOG REX",
        "sticker_lines": [
            "Rimadyl 50 mg: 1 chewable tablet daily with food.",
            "Veterinary medicine only  EXP 2027-08",
        ],
        "tilt_deg": -1.5,
    },
    {
        "id": "hh_05",
        "scenario": "veterinary_synulox_vet_250mg_penicillin_allergy_warning",
        "household_source": "pet_veterinary",
        "scene_type": "med_carton",
        "question": "Is this antibiotic box in the cabinet safe with my penicillin allergy?",
        "expected_level": "warning",
        "gt_strength": "250 mg",
        "accent": (184, 92, 24),
        "header": "ZOETIS VETERINARY - FOR DOGS AND CATS",
        "title": "Synulox Vet",
        "subtitle": "Active ingredients: amoxicillin, clavulanic acid",
        "strength_badge": "250 mg",
        "form_line": "tablets for dogs",
        "pack_line": "20 tablets",
        "expiry_line": "EXP 2027-09",
        "sticker_header": "ELAINLAAKARI - PET ANTIBIOTIC",
        "sticker_lines": [
            "Synulox Vet 250 mg: 1 tablet twice daily.",
            "For pet treatment only  EXP 2027-09",
        ],
        "tilt_deg": 1.3,
        "sticker_tilt_deg": -1.1,
    },
    {
        "id": "hh_06",
        "scenario": "own_amlodipine_5mg_evening_pill_match",
        "household_source": "own_adult",
        "scene_type": "med_carton",
        "question": "Is this my 5 mg evening blood pressure pill?",
        "expected_level": "match",
        "gt_strength": "5 mg",
        "accent": (24, 96, 148),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "pack_line": "98 tablets",
        "expiry_line": "EXP 2027-11",
        "sticker_header": "APTEEKKI - EVENING DOSE",
        "sticker_lines": [
            "Amlodipin 5 mg: 1 tablet in the evening.",
            "Blood pressure medication  EXP 2027-11",
        ],
        "tilt_deg": -1.4,
        "sticker_tilt_deg": 1.2,
    },
    {
        "id": "hh_07",
        "scenario": "spouse_atorvastatin_20mg_not_on_list_warning",
        "household_source": "spouse_med",
        "scene_type": "med_carton",
        "question": "Is this my evening blood pressure pill or my spouse's box?",
        "expected_level": "warning",
        "gt_strength": "20 mg",
        "accent": (64, 78, 146),
        "header": "ORION PHARMA",
        "title": "Atorvastatin",
        "subtitle": "Active ingredient: atorvastatin",
        "strength_badge": "20 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-10",
        "sticker_header": "APTEEKKI - CHOLESTEROL TABLET",
        "sticker_lines": [
            "Atorvastatin 20 mg: 1 tablet once daily.",
            "Shared nightstand shelf  EXP 2027-10",
        ],
        "tilt_deg": 1.7,
        "sticker_tilt_deg": -1.3,
    },
    {
        "id": "hh_08",
        "scenario": "pediatric_burana_100mg_suppository_nsaid_avoid_warning",
        "household_source": "grandchild_pediatric",
        "scene_type": "med_carton",
        "question": "Can I use this Burana box from the bathroom cabinet?",
        "expected_level": "warning",
        "gt_strength": "100 mg",
        "accent": (202, 54, 46),
        "header": "ORION PHARMA - PEDIATRIC",
        "title": "Burana",
        "subtitle": "Active ingredient: ibuprofen",
        "strength_badge": "100 mg",
        "form_line": "suppositories",
        "pack_line": "10 suppositories for children",
        "expiry_line": "EXP 2027-09",
        "sticker_header": "PEDIATRIC FEVER SUPPOSITORY",
        "sticker_lines": [
            "Burana 100 mg suppository for children.",
            "Bathroom cabinet pack  EXP 2027-09",
        ],
        "tilt_deg": -1.5,
        "sticker_tilt_deg": 1.1,
    },
    {
        "id": "hh_09",
        "scenario": "safe_household_oat_biscuit_no_profile_allergens_info",
        "household_source": "household_pantry",
        "scene_type": "food_pack",
        "question": "Are these oat biscuits in the pantry safe with my peanut allergy?",
        "expected_level": "info",
        "gt_strength": None,
        "accent": (42, 114, 88),
        "header": "NORDIC BAKERY",
        "title": "Crunchy Oat Biscuits",
        "subtitle": "Wholegrain Oat Tea Biscuits  250 g",
        "ingredients_lines": [
            "Ingredients: wholegrain oats (62%),",
            "rapeseed oil, sugar, wheat flour, sea salt.",
        ],
        "allergen_line": "Allergens: Contains oats, wheat (gluten).",
        "sticker_header": "PANTRY DATE LABEL",
        "sticker_lines": [
            "Shared kitchen biscuit tin  Batch 304",
            "Best before: 2027-11-20",
        ],
        "tilt_deg": 1.2,
        "sticker_tilt_deg": -0.9,
    },
    {
        "id": "hh_10",
        "scenario": "grandchild_peanut_butter_puff_snack_allergy_warning",
        "household_source": "grandchild_snack",
        "scene_type": "food_pack",
        "question": "Are my grandchild's puff snacks on the counter safe for me to eat?",
        "expected_level": "warning",
        "gt_strength": None,
        "accent": (178, 96, 28),
        "header": "KIDDIE SNACKS NORDIC",
        "title": "Peanut Butter Puffs",
        "subtitle": "Baked Maize Snack for Kids  90 g",
        "ingredients_lines": [
            "Ingredients: maize grits, roasted peanuts (32%),",
            "sunflower oil, sea salt.",
        ],
        "allergen_line": "Allergens: Contains peanuts.",
        "sticker_header": "KITCHEN SNACK PACK",
        "sticker_lines": [
            "Grandchild snack bag  Batch 719",
            "Best before: 2027-10-18",
        ],
        "tilt_deg": -1.4,
        "sticker_tilt_deg": 1.1,
    },
    {
        "id": "hh_11",
        "scenario": "thumb_occluded_strength_panadol_bottle_unsure",
        "household_source": "ambiguous_household_bottle",
        "scene_type": "bottle_front",
        "bottle_plastic": "amber",
        "cap_color": (240, 242, 245),
        "occlude_thumb": True,
        "question": "Is this my adult 500 mg Panadol or the grandchild's bottle?",
        "expected_level": "unsure",
        "gt_strength": None,
        "accent": (24, 98, 156),
        "header": "HALEON NORDIC",
        "title": "Panadol",
        "subtitle": "Active ingredient: paracetamol",
        "strength_badge": None,
        "form_line": "Check front panel before dosing",
        "expiry_line": "EXP 2027-11",
        "sticker_header": "HOUSEHOLD CABINET BOTTLE",
        "sticker_lines": [
            "Verify strength on front label before use.",
            "Keep cap tightly closed  EXP 2027-11",
        ],
        "tilt_deg": 1.8,
    },
    {
        "id": "hh_12",
        "scenario": "out_of_focus_turned_away_medicine_bottle_unsure",
        "household_source": "turned_away_blurred_bottle",
        "scene_type": "bottle_unreadable",
        "question": "What medicine bottle is this on the bathroom shelf?",
        "expected_level": "unsure",
        "gt_strength": None,
        "tilt_deg": -3.2,
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


def render_cabinet_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (222, 218, 210))
    draw = ImageDraw.Draw(canvas)
    shelf_y = int(size * 0.66)
    for y in range(shelf_y):
        t = y / max(1, shelf_y)
        c = (int(232 - 20 * t), int(229 - 19 * t), int(222 - 18 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 29)
    for y in range(shelf_y, size):
        t = (y - shelf_y) / max(1, size - shelf_y)
        grain = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(198 - 26 * t) + grain)),
            max(0, min(255, int(176 - 24 * t) + grain)),
            max(0, min(255, int(148 - 20 * t) + grain)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.rectangle((0, shelf_y - 4, size, shelf_y + 4), fill=(154, 134, 110))
    return canvas


def render_sticker(width: int, height: int, header_text: str, lines: list[str], seed: int) -> Image.Image:
    paper_bg = (247, 244, 234)
    sticker = Image.new("RGB", (width, height), paper_bg)
    arr = np.asarray(sticker, dtype=np.float32)
    rng = random.Random(seed + 53)
    noise = np.zeros((height, width, 1), dtype=np.float32)
    for r in range(height):
        noise[r, :, 0] = rng.uniform(-1.8, 1.8)
    sticker = Image.fromarray(np.clip(arr + noise, 0.0, 255.0).astype(np.uint8), mode="RGB")
    sd = ImageDraw.Draw(sticker)
    sd.rounded_rectangle((1, 1, width - 2, height - 2), radius=8, outline=(168, 162, 148), width=2)
    sd.text((14, 7), header_text, fill=(30, 34, 40), font=ImageFont.load_default(size=16))
    sd.line((12, 28, width - 12, 28), fill=(142, 138, 130), width=1)
    ty = 34
    for ln in lines:
        sd.text((14, ty), ln, fill=(18, 22, 28), font=ImageFont.load_default(size=18))
        ty += 24
    return sticker


def paste_tilted_sticker(card: Image.Image, sticker: Image.Image, dest_xy: tuple[int, int], tilt_deg: float) -> None:
    sw, sh = sticker.size
    rgba = sticker.convert("RGBA")
    shadow = Image.new("RGBA", (sw + 14, sh + 14), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((7, 8, sw + 7, sh + 8), radius=8, fill=(28, 24, 20, 58))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=2.6))
    shadow.paste(rgba, (6, 6), rgba)
    rot = shadow.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
    base_rgba = card.convert("RGBA")
    base_rgba.alpha_composite(rot, dest=(dest_xy[0] - 6, dest_xy[1] - 6))
    card.paste(base_rgba.convert("RGB"))


def render_med_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_cabinet_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 100, pad + 704, pad + 668
    bw, bh = x1 - x0, y1 - y0
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 90))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card = Image.new("RGB", (bw, bh), (251, 250, 247))
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    cd.text((26, 19), case["header"], fill=(250, 251, 252), font=ImageFont.load_default(size=21))
    cd.text((26, 82), case["title"], fill=(12, 16, 22), font=ImageFont.load_default(size=44), stroke_width=1, stroke_fill=(12, 16, 22))
    cd.text((26, 146), case["subtitle"], fill=(30, 36, 44), font=ImageFont.load_default(size=21))
    sx0, sy0, sx1, sy1 = 26, 196, 274, 284
    cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=(240, 245, 251), outline=case["accent"], width=3)
    cd.text((sx0 + 22, sy0 + 18), case["strength_badge"], fill=(10, 14, 20), font=ImageFont.load_default(size=44), stroke_width=1, stroke_fill=(10, 14, 20))
    cd.text((sx1 + 20, sy0 + 28), case["form_line"], fill=(30, 36, 44), font=ImageFont.load_default(size=23))
    cd.text((26, 316), case["pack_line"], fill=(34, 40, 48), font=ImageFont.load_default(size=22))
    cd.rounded_rectangle((bw - 256, 304, bw - 26, 362), radius=8, fill=(244, 245, 247), outline=(126, 134, 144), width=2)
    cd.text((bw - 236, 318), case["expiry_line"], fill=(12, 16, 22), font=ImageFont.load_default(size=26), stroke_width=1, stroke_fill=(12, 16, 22))
    sticker = render_sticker(bw - 56, 96, case["sticker_header"], case["sticker_lines"], seed)
    paste_tilted_sticker(card, sticker, (28, 424), case["sticker_tilt_deg"])
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(156, 152, 144, 255), width=3)
    composed = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def draw_thumb_occlusion(layer: Image.Image, bx0: int, by0: int, seed: int) -> None:
    thumb = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(thumb)
    tx0 = bx0 - 54
    ty0 = by0 + 206
    tx1 = bx0 + 324
    ty1 = by0 + 324
    td.rounded_rectangle((tx0 + 8, ty0 + 10, tx1 + 12, ty1 + 14), radius=56, fill=(22, 16, 12, 105))
    thumb = thumb.filter(ImageFilter.GaussianBlur(radius=7.0))
    td = ImageDraw.Draw(thumb)
    td.rounded_rectangle((tx0, ty0, tx1, ty1), radius=54, fill=(214, 168, 142, 255), outline=(172, 126, 102, 255), width=3)
    td.rounded_rectangle((tx1 - 92, ty0 + 16, tx1 - 18, ty1 - 16), radius=26, fill=(236, 206, 190, 255), outline=(188, 148, 128, 255), width=2)
    rng = random.Random(seed + 97)
    for k in range(5):
        kx = tx0 + 128 + k * 9 + rng.randint(-2, 2)
        td.arc((kx, ty0 + 18, kx + 22, ty1 - 18), start=110, end=250, fill=(176, 130, 106, 185), width=2)
    base = Image.alpha_composite(layer, thumb)
    layer.paste(base)


def render_bottle_front(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_cabinet_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bx0, by0, bx1, by1 = pad + 134, pad + 158, pad + 634, pad + 706
    bw, bh = bx1 - bx0, by1 - by0
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((bx0 + 14, by0 + 18, bx1 + 18, by1 + 22), radius=46, fill=(22, 18, 14, 95))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(radius=13.0)))

    ld = ImageDraw.Draw(layer)
    cap_w = 240
    cx0 = (bx0 + bx1 - cap_w) // 2
    cx1 = cx0 + cap_w
    if case["bottle_plastic"] == "amber":
        body_col = (118, 62, 24, 255)
        neck_col = (102, 52, 18, 255)
        hi_col = (168, 102, 52, 85)
    else:
        body_col = (242, 244, 247, 255)
        neck_col = (226, 230, 235, 255)
        hi_col = (255, 255, 255, 110)

    ld.rectangle((cx0 + 28, pad + 112, cx1 - 28, by0 + 16), fill=neck_col)
    cap_rgba = (*case["cap_color"], 255)
    ld.rounded_rectangle((cx0, pad + 48, cx1, pad + 120), radius=14, fill=cap_rgba, outline=(128, 132, 138, 255), width=3)
    for rx in range(cx0 + 14, cx1 - 10, 12):
        ld.line((rx, pad + 56, rx, pad + 112), fill=(160, 166, 172, 180), width=2)

    ld.rounded_rectangle((bx0, by0, bx1, by1), radius=48, fill=body_col, outline=(84, 62, 46, 255), width=3)
    ld.rounded_rectangle((bx0 + 24, by0 + 18, bx0 + 78, by1 - 22), radius=24, fill=hi_col)

    lw, lh = bw - 52, bh - 88
    label = Image.new("RGB", (lw, lh), (251, 250, 247))
    cd = ImageDraw.Draw(label)
    cd.rectangle((0, 0, lw, 54), fill=case["accent"])
    cd.text((20, 16), case["header"], fill=(250, 251, 252), font=ImageFont.load_default(size=19))
    cd.text((20, 70), case["title"], fill=(12, 16, 22), font=ImageFont.load_default(size=38), stroke_width=1, stroke_fill=(12, 16, 22))
    cd.text((20, 124), case["subtitle"], fill=(30, 36, 44), font=ImageFont.load_default(size=20))
    sx0, sy0, sx1, sy1 = 20, 164, 244, 242
    if case["strength_badge"]:
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 245, 251), outline=case["accent"], width=3)
        cd.text((sx0 + 18, sy0 + 18), case["strength_badge"], fill=(10, 14, 20), font=ImageFont.load_default(size=38), stroke_width=1, stroke_fill=(10, 14, 20))
    else:
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(238, 240, 243), outline=(170, 176, 182), width=2)
    cd.text((20, 256), case["form_line"], fill=(30, 36, 44), font=ImageFont.load_default(size=19))
    cd.rounded_rectangle((lw - 216, 290, lw - 20, 338), radius=8, fill=(244, 245, 247), outline=(126, 134, 144), width=2)
    cd.text((lw - 200, 301), case["expiry_line"], fill=(12, 16, 22), font=ImageFont.load_default(size=22), stroke_width=1, stroke_fill=(12, 16, 22))
    sticker = render_sticker(lw - 36, 92, case["sticker_header"], case["sticker_lines"], seed)
    paste_tilted_sticker(label, sticker, (18, 350), 0.7)

    lmask = Image.new("L", (lw, lh), 0)
    ImageDraw.Draw(lmask).rounded_rectangle((0, 0, lw - 1, lh - 1), radius=14, fill=255)
    layer.paste(label, (bx0 + 26, by0 + 48), lmask)
    ld.rounded_rectangle((bx0 + 26, by0 + 48, bx0 + 26 + lw - 1, by0 + 48 + lh - 1), radius=14, outline=(164, 158, 148, 255), width=2)

    if case.get("occlude_thumb"):
        draw_thumb_occlusion(layer, bx0, by0, seed)

    composed = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_bottle_unreadable(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_cabinet_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    bx0, by0, bx1, by1 = pad + 178, pad + 168, pad + 594, pad + 698
    cx0, cx1 = pad + 276, pad + 496
    ld.rectangle((cx0 + 26, pad + 120, cx1 - 26, by0 + 18), fill=(96, 48, 18, 255))
    ld.rounded_rectangle((cx0, pad + 58, cx1, pad + 126), radius=14, fill=(236, 238, 240, 255))
    ld.rounded_rectangle((bx0, by0, bx1, by1), radius=52, fill=(108, 54, 20, 255))
    ld.rounded_rectangle((bx0 + 30, by0 + 24, bx0 + 86, by1 - 28), radius=26, fill=(158, 92, 42, 90))
    ld.rounded_rectangle((bx1 - 52, by0 + 62, bx1 - 6, by1 - 56), radius=10, fill=(244, 241, 232, 235))
    for gy in range(by0 + 88, by1 - 78, 28):
        ld.rectangle((bx1 - 44, gy, bx1 - 14, gy + 10), fill=(182, 178, 170, 180))
    rotated = layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    blurred = composed.filter(ImageFilter.GaussianBlur(radius=11.5))
    return blurred.crop((pad, pad, pad + 768, pad + 768))


def render_food_pack(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_cabinet_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 80, pad + 88, pad + 688, pad + 680
    cw, ch = x1 - x0, y1 - y0
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 90))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(radius=12.0)))
    carton = Image.new("RGB", (cw, ch), (250, 247, 240))
    cd = ImageDraw.Draw(carton)
    cd.rectangle((0, 0, cw, 64), fill=case["accent"])
    cd.text((26, 19), case["header"], fill=(250, 250, 248), font=ImageFont.load_default(size=22))
    cd.text((26, 84), case["title"], fill=(14, 18, 16), font=ImageFont.load_default(size=38), stroke_width=1, stroke_fill=(14, 18, 16))
    cd.text((26, 140), case["subtitle"], fill=(38, 44, 40), font=ImageFont.load_default(size=23))
    cd.rounded_rectangle((24, 188, cw - 24, 408), radius=12, fill=(253, 252, 248), outline=(164, 158, 146), width=2)
    iy = 206
    for ln in case["ingredients_lines"]:
        cd.text((38, iy), ln, fill=(14, 18, 18), font=ImageFont.load_default(size=23), stroke_width=1, stroke_fill=(14, 18, 18))
        iy += 36
    iy += 14
    cd.rounded_rectangle((34, iy - 6, cw - 34, iy + 52), radius=8, fill=(244, 240, 230), outline=(138, 124, 104), width=2)
    cd.text((44, iy + 10), case["allergen_line"], fill=(12, 16, 16), font=ImageFont.load_default(size=20), stroke_width=1, stroke_fill=(12, 16, 16))
    sticker = render_sticker(cw - 56, 96, case["sticker_header"], case["sticker_lines"], seed)
    paste_tilted_sticker(carton, sticker, (28, 444), case["sticker_tilt_deg"])
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(158, 152, 142, 255), width=3)
    composed = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt_deg"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg(case: dict[str, Any], idx: int, out_path: pathlib.Path) -> bytes:
    seed = 20261180 + idx * 149
    st = case["scene_type"]
    if st == "med_carton":
        img = render_med_carton(case, seed)
    elif st == "bottle_front":
        img = render_bottle_front(case, seed)
    elif st == "bottle_unreadable":
        img = render_bottle_unreadable(case, seed)
    else:
        img = render_food_pack(case, seed)
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


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_pediatric_vet_household_", dir=tmp_base_dir()) as tmp:
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
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["confident_wrong_dose_count"] == 0 and data["confident_wrong_dose_rate"] == 0.0
    with tempfile.TemporaryDirectory(prefix="holdup_verify_hh_", dir=tmp_base_dir()) as tmp:
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
