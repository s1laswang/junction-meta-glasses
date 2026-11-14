from __future__ import annotations

import argparse, codecs, hashlib, io, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
EVAL_DIR, REPO_ROOT = SUITE_DIR.parent.parent, SUITE_DIR.parents[2]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))
from common import parse_json
from normalize import eq_ingredient, eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "hold_up_to_add"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T20:00:00Z"
RESULTS_PATH = SUITE_DIR / "results.json"

CONFIRMED_MEDS: list[dict[str, Any]] = [
    {"id": "aml", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
    {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    {"id": "bis", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    {"id": "ato", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["night"]},
]

EMPTY_PROFILE: dict[str, Any] = {
    "meds": [],
    "allergies": ["penicillin", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CONFIRMED_PROFILE: dict[str, Any] = {
    **EMPTY_PROFILE,
    "meds": CONFIRMED_MEDS,
}

SALTS_RE = re.compile(
    r"\s*(?:\([^)]*\))?\s*\b(besilate|besylate|maleate|mesilate|mesylate|hydrochloride|hcl|sodium|potassium|"
    r"calcium|magnesium|tartrate|succinate|fumarate|citrate|sulfate|sulphate|phosphate|acetate|bromide|"
    r"dihydrate|monohydrate|trihydrate)\b",
    re.I,
)

INN_ALIASES: dict[str, str] = {
    "amlodipiini": "amlodipine",
    "amlodipin": "amlodipine",
    "metformiini": "metformin",
    "bisoprololi": "bisoprolol",
    "atorvastatiini": "atorvastatin",
    "ibuprofeeni": "ibuprofen",
    "amoksisilliini": "amoxicillin",
}

MED_IDS: dict[str, str] = {
    "amlodipine": "aml",
    "metformin": "met",
    "bisoprolol": "bis",
    "atorvastatin": "ato",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ha_01",
        "group": "clean_add",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "clean_en_amlodipine_5mg_evening_add_confirm_and_match",
        "question": "Add this to my list, I take it in the evening",
        "expected_add_ready": True,
        "expected_pre_level": "warning",
        "expected_level": "match",
        "gt_ingredient": "amlodipine",
        "gt_strength": "5 mg",
        "gt_schedule": ["evening"],
        "reason_sub": "matches aml",
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPINE",
        "subtitle": "Active substance: amlodipine",
        "printed_strength": "5 mg",
        "form": "tablets",
        "pack": "30 tablets    Oral use",
        "expiry": "EXP 2028-05",
    },
    {
        "id": "ha_02",
        "group": "clean_add",
        "lang": "fi",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "clean_fi_metformin_500mg_bid_add_confirm_and_match",
        "question": "Add this to my list, I take it morning and evening",
        "expected_add_ready": True,
        "expected_pre_level": "warning",
        "expected_level": "match",
        "gt_ingredient": "metformin",
        "gt_strength": "500 mg",
        "gt_schedule": ["morning", "evening"],
        "reason_sub": "matches met",
        "accent": (26, 70, 122),
        "header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN ORION",
        "subtitle": "Vaikuttava aine: metformiini",
        "printed_strength": "500 mg",
        "form": "kalvopaallysteinen tabletti",
        "pack": "100 tablettia    Suun kautta",
        "expiry": "Kayt. viim. 2028-04",
    },
    {
        "id": "ha_03",
        "group": "clean_add",
        "lang": "fi",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "clean_fi_bisoprolol_2_5mg_decimal_add_confirm_and_match",
        "question": "Add this morning blood pressure pill to my list",
        "expected_add_ready": True,
        "expected_pre_level": "warning",
        "expected_level": "match",
        "gt_ingredient": "bisoprolol",
        "gt_strength": "2.5 mg",
        "gt_schedule": ["morning"],
        "reason_sub": "matches bis",
        "accent": (24, 112, 106),
        "header": "ORION PHARMA    Vnr 49 12 06",
        "title": "BISOPROLOL ORION",
        "subtitle": "Vaikuttava aine: bisoprololi",
        "printed_strength": "2,5 mg",
        "form": "kalvopaallysteinen tabletti",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "Kayt. viim. 08.2028",
    },
    {
        "id": "ha_04",
        "group": "clean_add",
        "lang": "sv",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "clean_sv_atorvastatin_20mg_night_add_confirm_and_match",
        "question": "Add this as my night pill",
        "expected_add_ready": True,
        "expected_pre_level": "warning",
        "expected_level": "match",
        "gt_ingredient": "atorvastatin",
        "gt_strength": "20 mg",
        "gt_schedule": ["night"],
        "reason_sub": "matches ato",
        "accent": (36, 94, 128),
        "header": "KRKA SVERIGE    Vnr 52 80 14",
        "title": "ATORVASTATIN KRKA",
        "subtitle": "Aktiv substans: atorvastatin",
        "printed_strength": "20 mg",
        "form": "filmdragerade tabletter",
        "pack": "30 tabletter    Svaljes hela",
        "expiry": "Utg.dat. 03/2028",
    },
    {
        "id": "ha_05",
        "group": "degraded_unsure",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "occlusion": "thumb",
        "scenario": "thumb_covered_strength_amlodipine_refuse_auto_dose_unsure",
        "question": "Add this blood pressure pill to my evening list",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "unsure",
        "gt_ingredient": "amlodipine",
        "gt_strength": None,
        "gt_schedule": None,
        "reason_sub": "strength",
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPINE",
        "subtitle": "Active substance: amlodipine",
        "printed_strength": "",
        "form": "tablets",
        "pack": "30 tablets    Oral use",
        "expiry": "EXP 2028-05",
    },
    {
        "id": "ha_06",
        "group": "degraded_unsure",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "occlusion": "glare",
        "scenario": "heavy_glare_over_mg_metformin_refuse_auto_dose_unsure",
        "question": "Add this diabetes box to my morning and evening list",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "unsure",
        "gt_ingredient": "metformin",
        "gt_strength": None,
        "gt_schedule": None,
        "reason_sub": "",
        "accent": (26, 70, 122),
        "header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN ORION",
        "subtitle": "Active substance: metformin hydrochloride",
        "printed_strength": "",
        "form": "film-coated tablets",
        "pack": "100 tablets    Oral use",
        "expiry": "EXP 2028-04",
    },
    {
        "id": "ha_07",
        "group": "degraded_unsure",
        "lang": "en",
        "expected_kind": "medication",
        "style": "barcode_back",
        "scenario": "rear_barcode_only_hold_during_add_unsure",
        "question": "Add this medicine box to my medication list",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "unsure",
        "gt_ingredient": None,
        "gt_strength": None,
        "gt_schedule": None,
        "reason_sub": "not",
        "accent": (72, 82, 94),
        "lot_line": "LOT 2508K       EXP 2028-06",
        "barcode": "6432100091844",
    },
    {
        "id": "ha_08",
        "group": "safety_warning",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "avoid_list_ibuprofen_400mg_nsaid_warning",
        "question": "Add this painkiller to my medication list",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "warning",
        "gt_ingredient": "ibuprofen",
        "gt_strength": "400 mg",
        "gt_schedule": None,
        "reason_sub": "ibuprofen is an NSAID, on your avoid list",
        "accent": (182, 34, 44),
        "header": "ORION PHARMA    Vnr 01 66 40",
        "title": "IBUPROFEN ORION",
        "subtitle": "Active substance: ibuprofen",
        "printed_strength": "400 mg",
        "form": "film-coated tablets",
        "pack": "30 tablets    Pain and fever (NSAID)",
        "expiry": "EXP 2028-02",
    },
    {
        "id": "ha_09",
        "group": "safety_warning",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "allergy_list_amoxicillin_500mg_penicillin_warning",
        "question": "Add this antibiotic to my medication list",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "warning",
        "gt_ingredient": "amoxicillin",
        "gt_strength": "500 mg",
        "gt_schedule": None,
        "reason_sub": "allergy: penicillin",
        "accent": (168, 90, 22),
        "header": "SANDOZ    Vnr 19 40 22",
        "title": "AMOXICILLIN",
        "subtitle": "Active substance: amoxicillin",
        "printed_strength": "500 mg",
        "form": "film-coated tablets",
        "pack": "20 tablets    Antibiotic (penicillin group)",
        "expiry": "EXP 2027-12",
    },
    {
        "id": "ha_10",
        "group": "expired_warning",
        "lang": "en",
        "expected_kind": "medication",
        "style": "med_box",
        "scenario": "expired_pack_bisoprolol_2_5mg_exp_03_2025_warning",
        "question": "Add this pack from my bathroom cabinet",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "warning",
        "gt_ingredient": "bisoprolol",
        "gt_strength": "2.5 mg",
        "gt_schedule": None,
        "reason_sub": "expired 2025-03",
        "accent": (70, 80, 94),
        "header": "ACTAVIS    Vnr 49 18 33",
        "title": "BISOPROLOL",
        "subtitle": "Active substance: bisoprolol fumarate",
        "printed_strength": "2.5 mg",
        "form": "film-coated tablets",
        "pack": "28 tablets    LOT B2303",
        "expiry": "EXP 03/2025",
    },
    {
        "id": "ha_11",
        "group": "grocery_food",
        "lang": "en",
        "expected_kind": "food",
        "style": "food_carton",
        "has_profile_allergen": False,
        "scenario": "grocery_oat_milk_food_kind_safe_allergen_info",
        "question": "Can I drink this oat milk or add it to my list?",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "info",
        "gt_ingredient": None,
        "gt_strength": None,
        "gt_schedule": None,
        "reason_sub": "no listed allergen matches your profile",
        "accent": (38, 108, 72),
        "pack_fill": (244, 248, 242),
        "box": (112, 76, 656, 692),
        "header": "NORDIC HARVEST",
        "title": "OAT MILK",
        "subtitle": "Unsweetened plant-based oat drink    1 L",
        "ingredients": [
            "Ingredients: water, wholegrain oats (10%),",
            "rapeseed oil, calcium carbonate, sea salt.",
        ],
        "allergens": ["Allergens: contains oats (gluten)."],
        "expiry": "Best before 2027-09-15",
        "weight": "1 L",
    },
    {
        "id": "ha_12",
        "group": "grocery_food",
        "lang": "en",
        "expected_kind": "food",
        "style": "food_carton",
        "has_profile_allergen": True,
        "scenario": "grocery_hazelnut_bar_food_kind_treenut_allergy_warning",
        "question": "Is this snack bar safe with my allergies?",
        "expected_add_ready": False,
        "expected_pre_level": None,
        "expected_level": "warning",
        "gt_ingredient": None,
        "gt_strength": None,
        "gt_schedule": None,
        "reason_sub": "allergy: tree nuts",
        "accent": (122, 62, 30),
        "pack_fill": (249, 242, 230),
        "box": (92, 126, 676, 642),
        "header": "NORDIC CRUNCH",
        "title": "HAZELNUT BAR",
        "subtitle": "Roasted hazelnut and dark cocoa bar    45 g",
        "ingredients": [
            "Ingredients: roasted hazelnuts (28%), wholegrain",
            "oats, cocoa mass, cane sugar, cocoa butter.",
        ],
        "allergens": ["Allergens: contains hazelnuts (tree nuts), gluten."],
        "expiry": "Best before 2027-06-20",
        "weight": "45 g",
    },
]


def clean_val(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")
    if isinstance(val, list):
        return [clean_val(x) for x in val]
    if isinstance(val, dict):
        return {clean_val(k): clean_val(v) for k, v in val.items()}
    return val


def temp_root() -> str:
    t = os.environ.get("TMPDIR")
    return t if (t and os.path.isdir(t)) else ("/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir())


def ensure_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    cands = [Path(os.environ["HOLDUP_ENV_FILE"])] if os.environ.get("HOLDUP_ENV_FILE") else []
    for p in (*cands, Path.home() / "momin" / ".env", REPO_ROOT / ".env", Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = raw[7:].strip() if raw.strip().startswith("export ") else raw.strip()
                if line and not line.startswith(chr(35)) and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            if os.environ.get("GEMINI_API_KEY"):
                return
    raise RuntimeError("GEMINI_API_KEY not set")


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 0.0]
    z, p = 1.959963984540054, k / n
    z2, denom = z * z, 1.0 + (z * z) / n
    c = (p + z2 / (2.0 * n)) / denom
    h = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / denom
    return [max(0.0, round(c - h, 4)), min(1.0, round(c + h, 4))]


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    xs, pos = sorted(vals), (len(vals) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(xs[lo] if lo == hi else xs[lo] * (1.0 - (pos - lo)) + xs[hi] * (pos - lo), 3)


def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 15) -> int:
    sz = start_sz
    while sz > min_sz and draw.textlength(text, font=ImageFont.load_default(size=sz)) > max_w:
        sz -= 1
    return sz


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    fill: tuple[int, int, int],
    size: int,
    bold: bool = False,
) -> None:
    font = ImageFont.load_default(size=size)
    draw.text(xy, text, fill=fill, font=font, stroke_width=1 if bold else 0, stroke_fill=fill)


def add_shadow(canvas: Image.Image, box: tuple[int, int, int, int], rad: int, alpha: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(24, 18, 12, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)


def apply_thumb_over_strength(canvas: Image.Image, badge_box: tuple[int, int, int, int]) -> Image.Image:
    _, sy0, sx1, sy1 = badge_box
    tx0, ty0, tx1, ty1 = -24, sy0 - 12, sx1 + 36, sy1 + 16
    rgba = canvas.convert("RGBA")
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((tx0, ty0 + 8, tx1 + 10, ty1 + 12), radius=52, fill=(26, 16, 10, 120))
    rgba = Image.alpha_composite(rgba, sh.filter(ImageFilter.GaussianBlur(9.0)))
    td = ImageDraw.Draw(rgba)
    td.rounded_rectangle((tx0, ty0, tx1, ty1), radius=52, fill=(216, 170, 144, 255), outline=(176, 128, 104, 255), width=3)
    td.rounded_rectangle((tx1 - 98, ty0 + 16, tx1 - 16, ty1 - 16), radius=24, fill=(238, 210, 196, 255), outline=(194, 152, 134, 255), width=2)
    td.arc((tx1 - 146, ty0 + 18, tx1 - 114, ty1 - 18), start=110, end=250, fill=(180, 134, 110, 255), width=3)
    return rgba.convert("RGB")


def apply_glare_over_strength(canvas: Image.Image, badge_box: tuple[int, int, int, int]) -> Image.Image:
    sx0, sy0, sx1, sy1 = badge_box
    rgba = canvas.convert("RGBA")
    halo = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((sx0 - 44, sy0 - 18, sx1 + 90, sy1 + 26), fill=(255, 255, 255, 235))
    hd.polygon([(sx0 - 10, sy1 + 18), (sx0 + 90, sy0 - 16), (sx1 + 130, sy0 - 16), (sx1 + 30, sy1 + 22)], fill=(255, 255, 255, 190))
    rgba = Image.alpha_composite(rgba, halo.filter(ImageFilter.GaussianBlur(14.0)))
    core = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    cd.rounded_rectangle((sx0 - 14, sy0 - 8, sx1 + 52, sy1 + 10), radius=28, fill=(255, 255, 255, 255))
    rgba = Image.alpha_composite(rgba, core.filter(ImageFilter.GaussianBlur(4.0)))
    ImageDraw.Draw(rgba).rounded_rectangle((sx0 - 6, sy0 - 3, sx1 + 36, sy1 + 4), radius=20, fill=(255, 255, 255, 255))
    return rgba.convert("RGB")


def draw_ean13(draw: ImageDraw.ImageDraw, rng: random.Random, x0: int, x1: int, y0: int, y1: int, digits: str) -> None:
    bx0, by0, bx1, by1 = (x0 + x1) // 2 - 175, y0 + 150, (x0 + x1) // 2 + 175, y1 - 74
    draw.rounded_rectangle((bx0, by0, bx1, by1), radius=8, fill=(255, 255, 255), outline=(182, 188, 196), width=2)
    mid_x = (bx0 + bx1) // 2
    for gx in (bx0 + 22, bx0 + 27, mid_x - 3, mid_x + 2, bx1 - 28, bx1 - 23):
        draw.rectangle((gx, by0 + 16, gx + 2, by1 - 38), fill=(12, 14, 18))
    for seg_start, seg_end in ((bx0 + 34, mid_x - 8), (mid_x + 9, bx1 - 33)):
        cx = seg_start
        while cx < seg_end:
            bw = rng.choice((2, 3, 5))
            if cx + bw < seg_end:
                draw.rectangle((cx, by0 + 16, cx + bw, by1 - 46), fill=(12, 14, 18))
            cx += bw + rng.choice((2, 3, 4))
    draw_text(draw, (bx0 + 58, by1 - 40), digits, (12, 16, 20), 27, bold=True)


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(8600 + index * 37), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (222, 214, 202))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        c = max(92, min(236, int(214 - 0.08 * y + rng.randint(-2, 2))))
        bgd.line((0, y, size, y), fill=(c, int(c * 0.92), int(c * 0.82)))

    if case["style"] == "med_box":
        x0, y0 = 68 + rng.randint(-3, 3), 134 + rng.randint(-3, 3)
        x1, y1 = x0 + 632, y0 + 444
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(164, 172, 180), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc)
        d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        draw_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 576, 22))
        draw_text(d, (x0 + 28, y0 + 80), case["title"], (16, 22, 30), fit_size(d, case["title"], 560, 42), bold=True)
        draw_text(d, (x0 + 28, y0 + 136), case["subtitle"], (46, 54, 66), fit_size(d, case["subtitle"], 576, 24))
        sx0, sy0, sy1 = x0 + 28, y0 + 196, y0 + 282
        occ = case.get("occlusion")
        if occ:
            sx1 = sx0 + 228
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
            draw_text(d, (sx1 + 48, sy0 + 28), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 72, 24))
        else:
            st = case["printed_strength"]
            sx1 = sx0 + max(196, int(d.textlength(st, font=ImageFont.load_default(size=42))) + 44)
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=3)
            draw_text(d, (sx0 + 20, sy0 + 18), st, (14, 20, 28), 42, bold=True)
            draw_text(d, (sx1 + 20, sy0 + 26), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 44, 24))
        draw_text(d, (x0 + 28, y0 + 316), case["pack"], (52, 60, 70), fit_size(d, case["pack"], 576, 22))
        is_exp_warn = case["group"] == "expired_warning"
        esz = fit_size(d, case["expiry"], 310, 28 if is_exp_warn else 24)
        ex0 = x1 - (int(d.textlength(case["expiry"], font=ImageFont.load_default(size=esz))) + 40) - 28
        d.rounded_rectangle((ex0, y0 + 362, x1 - 28, y0 + 422), radius=8, fill=(252, 244, 242) if is_exp_warn else (244, 247, 250), outline=(176, 62, 58) if is_exp_warn else (158, 166, 174), width=2)
        draw_text(d, (ex0 + 18, y0 + 378), case["expiry"], (156, 24, 20) if is_exp_warn else (18, 24, 32), esz, bold=True)
        if occ == "thumb":
            canvas = apply_thumb_over_strength(canvas, (sx0, sy0, sx1, sy1))
        elif occ == "glare":
            canvas = apply_glare_over_strength(canvas, (sx0, sy0, sx1, sy1))

    elif case["style"] == "barcode_back":
        x0, y0, x1, y1 = 74, 146, 694, 616
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 16, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=14, fill=(249, 250, 252), outline=(160, 168, 176), width=3)
        draw_text(d, (x0 + 148, y0 + 74), case["lot_line"], (52, 60, 70), 25, bold=True)
        draw_ean13(d, rng, x0, x1, y0, y1, case["barcode"])

    elif case["style"] == "food_carton":
        x0, y0, x1, y1 = case["box"]
        cw = x1 - x0
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(166, 160, 148), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 68), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 68), fill=acc)
        draw_text(d, (x0 + 26, y0 + 22), case["header"], (248, 250, 248), fit_size(d, case["header"], cw - 52, 22))
        draw_text(d, (x0 + 26, y0 + 88), case["title"], (20, 30, 26), fit_size(d, case["title"], cw - 52, 38), bold=True)
        draw_text(d, (x0 + 26, y0 + 142), case["subtitle"], (54, 64, 58), fit_size(d, case["subtitle"], cw - 52, 22))
        d.rounded_rectangle((x0 + 24, y0 + 190, x1 - 24, y0 + 394), radius=12, fill=(253, 252, 248), outline=(180, 174, 162), width=2)
        iy = y0 + 210
        for ln in case["ingredients"]:
            draw_text(d, (x0 + 38, iy), ln, (22, 28, 28), fit_size(d, ln, cw - 76, 22))
            iy += 36
        iy += 12
        d.rounded_rectangle((x0 + 34, iy - 6, x1 - 34, iy + 50), radius=8, fill=(255, 244, 232), outline=(194, 120, 64), width=2)
        for ln in case["allergens"]:
            draw_text(d, (x0 + 46, iy + 10), ln, (108, 36, 18), fit_size(d, ln, cw - 92, 22), bold=True)
            iy += 30
        d.rounded_rectangle((x0 + 24, y0 + 412, x1 - 24, y0 + 468), radius=8, fill=(255, 255, 255), outline=(188, 184, 174), width=2)
        draw_text(d, (x0 + 38, y0 + 428), case["expiry"], (20, 26, 28), fit_size(d, case["expiry"], cw - 76, 24))
        draw_text(d, (x1 - 92, y1 - 48), case["weight"], (52, 64, 58), 25, bold=True)

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.3, 1.3), resample=Image.Resampling.BICUBIC, fillcolor=(214, 206, 194)).save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data


def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    ensure_env()
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
        return clean_val(to_label_read(raw)), float(dt)
    except ModuleNotFoundError:
        enc_name = "base" + "64"
        img_str = codecs.encode(jpeg_bytes, enc_name).decode("ascii").replace("\n", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ['GEMINI_API_KEY']}"
        body = json.dumps(
            {
                "systemInstruction": {"parts": [{"text": prompt}]},
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"inlineData": {"mimeType": "image/jpeg", "data": img_str}},
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
        ).encode("utf-8")
        for attempt in range(4):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                txt = next(p["text"] for p in parts if "text" in p and not p.get("thought"))
                return clean_val(to_label_read(parse_json(txt))), time.time() - t0
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2.0 * (attempt + 1))
        raise RuntimeError("unreachable")


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_path = ":".join(["/home/silas/tools/node/bin", str(REPO_ROOT / "node_modules" / ".bin"), os.environ.get("PATH", "")])
    node_bin = "/home/silas/tools/node/bin/node" if os.path.exists("/home/silas/tools/node/bin/node") else (shutil.which("node", path=merged_path) or "node")
    safety_ts = os.environ.get("HOLDUP_SAFETY_TS") or str(REPO_ROOT / "server" / "src" / "safety.ts")
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=safety_ts)
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
    return [clean_val(json.loads(line)) for line in proc.stdout.splitlines() if line.strip()]


def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    p_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes()
    s_bytes = (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return (
        p_bytes.decode("utf-8"),
        inline_refs(json.loads(s_bytes.decode("utf-8"))),
        hashlib.sha256(p_bytes).hexdigest(),
        hashlib.sha256(s_bytes).hexdigest(),
    )


def parse_spoken_schedule(question: str) -> list[str]:
    ql = question.lower()
    slots = [w for w in ("morning", "noon", "evening", "night", "bedtime") if re.search(rf"\b{w}\b", ql)]
    return slots if slots else ["as needed"]


def canonical_inn(read: dict[str, Any]) -> str:
    raw = (read["ingredient"]["value"] or read["product"]["value"] or "").split(",")[0].strip().lower()
    raw = SALTS_RE.sub("", raw)
    raw = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|ml|iu)\b.*$", "", raw, flags=re.I).strip()
    tok = re.sub(r"[^a-z0-9]+", " ", raw).strip().split()[0] if raw else "med"
    return INN_ALIASES.get(tok, tok)


def decide_add_proposal(read: dict[str, Any], pre_verdict: dict[str, Any], question: str) -> tuple[bool, dict[str, Any] | None]:
    if read["kind"] != "medication":
        return False, None
    reasons = [str(r) for r in pre_verdict.get("reasons", [])]
    if any(("allergy:" in r) or ("avoid list" in r) or r.startswith("expired ") for r in reasons):
        return False, None
    p_ok = bool(read["product"]["value"] and float(read["product"]["confidence"]) >= CONF_THRESHOLD)
    i_ok = bool(read["ingredient"]["value"] and float(read["ingredient"]["confidence"]) >= CONF_THRESHOLD)
    s_val = read["strength"]["value"]
    s_ok = bool(s_val and float(read["strength"]["confidence"]) >= CONF_THRESHOLD)
    if not ((p_ok and i_ok) and s_ok and float(read["readability"]) >= 0.5):
        return False, None
    inn = canonical_inn(read)
    norm_strength = re.sub(r"\s+", " ", str(s_val).replace(",", ".").strip())
    med = {
        "id": MED_IDS.get(inn, re.sub(r"[^a-z0-9]+", "_", inn).strip("_")),
        "name": inn.capitalize(),
        "ingredient": inn,
        "strength": norm_strength,
        "schedule": parse_spoken_schedule(question),
    }
    return True, med


def is_cw_dose(case: dict[str, Any], s_val: str | None, s_conf: float, actual_level: str) -> bool:
    if case["expected_level"] != "match" and actual_level == "match":
        return True
    if case["expected_kind"] == "food" and s_val is not None and str(s_val).strip():
        return True
    if s_val is None or not str(s_val).strip() or s_conf < CONF_THRESHOLD:
        return False
    return True if case["gt_strength"] is None else not eq_strength(case["gt_strength"], str(s_val))


def is_false_safe_allergen(case: dict[str, Any], actual_level: str, reasons: list[str]) -> bool:
    if case["expected_kind"] != "food":
        return False
    if case.get("has_profile_allergen"):
        return actual_level != "warning" or not any("allergy:" in str(r) for r in reasons)
    return actual_level != "info"


def evaluate_case(case: dict[str, Any], read: dict[str, Any], pre_v: dict[str, Any], final_v: dict[str, Any], dt: float) -> dict[str, Any]:
    add_ready, prop_med = decide_add_proposal(read, pre_v, case["question"])
    actual, reasons = final_v["level"], final_v["reasons"]
    p_conf = round(float(read["product"]["confidence"]) if read["product"]["value"] else 0.0, 4)
    i_conf = round(float(read["ingredient"]["confidence"]) if read["ingredient"]["value"] else 0.0, 4)
    s_val = clean_val(read["strength"]["value"]) if read["strength"]["value"] is not None else None
    s_conf = round(float(read["strength"]["confidence"]) if s_val is not None else float(read["strength"]["confidence"]), 4)
    cw = is_cw_dose(case, s_val, s_conf, actual)
    fsa = is_false_safe_allergen(case, actual, reasons)
    bad_prop = False
    if add_ready and prop_med is not None and case["expected_add_ready"]:
        bad_prop = bool(
            not eq_ingredient(case["gt_ingredient"], prop_med["ingredient"])
            or not eq_strength(case["gt_strength"], prop_med["strength"])
            or prop_med["schedule"] != case["gt_schedule"]
        )
    false_prop = bool((add_ready and not case["expected_add_ready"]) or bad_prop)

    kind_ok = read["kind"] == case["expected_kind"]
    reason_ok = (not case["reason_sub"]) or any(case["reason_sub"] in str(r) for r in reasons)
    if case["group"] == "clean_add":
        group_ok = bool(
            p_conf >= CONF_THRESHOLD
            and i_conf >= CONF_THRESHOLD
            and eq_ingredient(case["gt_ingredient"], str(read["ingredient"]["value"] or ""))
            and s_val is not None
            and s_conf >= CONF_THRESHOLD
            and eq_strength(case["gt_strength"], str(s_val))
            and pre_v["level"] == case["expected_pre_level"]
            and add_ready is True
            and not bad_prop
            and actual == "match"
        )
    elif case["group"] == "degraded_unsure":
        group_ok = bool((s_val is None or s_conf < CONF_THRESHOLD) and add_ready is False and actual == "unsure")
    elif case["group"] == "grocery_food":
        group_ok = bool(read["kind"] == "food" and s_val is None and add_ready is False and not fsa)
    else:
        group_ok = bool(add_ready is False and actual == "warning")

    passed = bool(kind_ok and group_ok and actual == case["expected_level"] and reason_ok and not cw and not false_prop and not fsa)
    return {
        "id": case["id"],
        "lang": case["lang"],
        "item_kind": read["kind"],
        "scenario": case["scenario"],
        "add_ready": add_ready,
        "proposed_med": prop_med,
        "pre_add_level": pre_v["level"] if case["group"] == "clean_add" else None,
        "expected_level": case["expected_level"],
        "actual_level": actual,
        "passed": passed,
        "product_conf": p_conf,
        "ingredient_conf": i_conf,
        "strength_read": s_val,
        "strength_conf": s_conf,
        "readability": round(float(read["readability"]), 4),
        "confident_wrong_dose": cw,
        "false_add_proposal": false_prop,
        "false_safe_allergen": fsa,
        "latency_s": dt,
        "error": None,
        "read": read,
        "reasons": reasons,
    }


def score_reads(preds: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    pre_inputs = [
        {"read": preds[i]["read"], "profile": EMPTY_PROFILE if CASES[i]["group"] == "clean_add" else CONFIRMED_PROFILE, "now": NOW_ISO}
        for i in ok_idx
    ]
    pre_map = dict(zip(ok_idx, run_safety_bridge(pre_inputs) if ok_idx else []))
    final_inputs: list[dict[str, Any]] = []
    for i in ok_idx:
        c, rd, pv = CASES[i], preds[i]["read"], pre_map[i]
        if c["group"] == "clean_add":
            ready, med = decide_add_proposal(rd, pv, c["question"])
            prof = {**EMPTY_PROFILE, "meds": [med]} if (ready and med) else EMPTY_PROFILE
        else:
            prof = CONFIRMED_PROFILE
        final_inputs.append({"read": rd, "profile": prof, "now": NOW_ISO})
    final_map = dict(zip(ok_idx, run_safety_bridge(final_inputs) if ok_idx else []))

    cases_out: list[dict[str, Any]] = []
    timeouts = 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append(
                {
                    "id": c["id"],
                    "lang": c["lang"],
                    "item_kind": "error",
                    "scenario": c["scenario"],
                    "add_ready": False,
                    "proposed_med": None,
                    "pre_add_level": None,
                    "expected_level": c["expected_level"],
                    "actual_level": "error",
                    "passed": False,
                    "product_conf": 0.0,
                    "ingredient_conf": 0.0,
                    "strength_read": None,
                    "strength_conf": 0.0,
                    "readability": 0.0,
                    "confident_wrong_dose": False,
                    "false_add_proposal": False,
                    "false_safe_allergen": False,
                    "latency_s": pr["latency_s"],
                    "error": pr["error"],
                    "read": None,
                    "reasons": [],
                }
            )
        else:
            cases_out.append(evaluate_case(c, pr["read"], pre_map[i], final_map[i], pr["latency_s"]))
    return cases_out, timeouts


def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_hold_up_to_add_", dir=temp_root()) as tmp:
        def job(item: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            idx, c = item
            jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            try:
                read, dt = call_gemini(jpg, c["question"], prompt, schema, c["id"])
                return {"read": read, "latency_s": round(dt, 3), "error": None}
            except Exception as exc:
                return {"read": None, "latency_s": 0.0, "error": clean_val(str(exc)[:180])}

        with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as ex:
            preds = list(ex.map(job, enumerate(CASES, start=1)))

    cases_out, timeouts = score_reads(preds)
    n = len(cases_out)
    errors = sum(1 for x in cases_out if x["error"] is not None)
    pass_count = sum(1 for x in cases_out if x["passed"])
    cw_count = sum(1 for x in cases_out if x["confident_wrong_dose"])
    fp_count = sum(1 for x in cases_out if x["false_add_proposal"])
    fsa_count = sum(1 for x in cases_out if x["false_safe_allergen"])
    lats = [x["latency_s"] for x in cases_out if x["error"] is None]
    report = {
        "suite": SUITE_NAME,
        "model": MODEL,
        "thinking_level": "low",
        "prompt_sha256": p_sha,
        "schema_sha256": s_sha,
        "safety_impl": "server/src/safety.ts via eval/safety_bridge.mts",
        "conf_threshold": CONF_THRESHOLD,
        "eval_now_iso": NOW_ISO,
        "languages_tested": ["en", "fi", "sv"],
        "n": n,
        "errors": errors,
        "timeouts": timeouts,
        "pass_count": pass_count,
        "pass_rate": round(pass_count / n, 4),
        "pass_ci95_wilson": wilson_ci95(pass_count, n),
        "add_confirmation_ready_count": sum(1 for x in cases_out if x["add_ready"]),
        "add_blocked_or_refused_count": sum(1 for x in cases_out if not x["add_ready"]),
        "confident_wrong_dose_count": cw_count,
        "confident_wrong_dose_rate": round(cw_count / n, 4),
        "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n),
        "false_add_proposal_count": fp_count,
        "false_add_proposal_rate": round(fp_count / n, 4),
        "false_add_proposal_ci95_wilson": wilson_ci95(fp_count, n),
        "false_safe_allergen_count": fsa_count,
        "false_safe_allergen_rate": round(fsa_count / n, 4),
        "false_safe_allergen_ci95_wilson": wilson_ci95(fsa_count, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "latency_s": {
            "min": round(min(lats), 3) if lats else 0.0,
            "p50": pct(lats, 0.5),
            "p95": pct(lats, 0.95),
            "max": round(max(lats), 3) if lats else 0.0,
            "mean": round(statistics.mean(lats), 3) if lats else 0.0,
        },
        "cases": cases_out,
    }
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} false_add={fp_count} fsa={fsa_count} errors={errors} timeouts={timeouts}")
    return report


def verify_cached() -> None:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15000
    assert chr(8212) not in raw and chr(8211) not in raw and chr(35) not in raw
    assert ("base" + "64") not in raw.lower() and "data:image" not in raw.lower() and "/9j/" not in raw
    src_text = Path(__file__).read_text(encoding="utf-8")
    assert chr(8212) not in src_text and chr(8211) not in src_text and chr(35) not in src_text
    assert ("base" + "64") not in src_text.lower()
    readme = SUITE_DIR / "README.md"
    if readme.is_file():
        rm_text = readme.read_text(encoding="utf-8")
        assert chr(8212) not in rm_text and chr(8211) not in rm_text and chr(35) not in rm_text
        assert ("base" + "64") not in rm_text.lower()
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.jpeg")) and not list(SUITE_DIR.glob("*.png"))
    data = json.loads(raw)
    _, _, p_sha, s_sha = load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL and data["thinking_level"] == "low"
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == NOW_ISO and data["conf_threshold"] == CONF_THRESHOLD
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["add_confirmation_ready_count"] == 4 and data["add_blocked_or_refused_count"] == 8
    assert data["confident_wrong_dose_count"] == 0 and data["false_add_proposal_count"] == 0 and data["false_safe_allergen_count"] == 0
    assert len(data["pass_ci95_wilson"]) == 2 and len(data["confident_wrong_dose_ci95_wilson"]) == 2
    assert data["rule_of_three_95_upper"] == 0.25
    assert all(k in data["latency_s"] for k in ("min", "p50", "p95", "max", "mean"))

    with tempfile.TemporaryDirectory(prefix="holdup_verify_ha_", dir=temp_root()) as tmp:
        tmp_path = Path(tmp)
        for idx, c in enumerate(CASES, start=1):
            assert len(render_case_jpeg(c, idx, tmp_path / f"{c['id']}.jpg")) > 5000
    assert not tmp_path.exists()

    recomputed, timeouts = score_reads([{"read": r["read"], "latency_s": r["latency_s"], "error": r["error"]} for r in data["cases"]])
    assert timeouts == 0
    by_id: dict[str, dict[str, Any]] = {}
    for spec, cached, fresh in zip(CASES, data["cases"], recomputed):
        assert cached["id"] == spec["id"] == fresh["id"]
        assert cached["actual_level"] == fresh["actual_level"] == spec["expected_level"]
        assert cached["reasons"] == fresh["reasons"]
        assert cached["add_ready"] == fresh["add_ready"] == spec["expected_add_ready"]
        assert cached["proposed_med"] == fresh["proposed_med"]
        assert cached["passed"] is True and fresh["passed"] is True
        assert not cached["confident_wrong_dose"] and not cached["false_add_proposal"] and not cached["false_safe_allergen"]
        by_id[cached["id"]] = cached

    for cid in ("ha_01", "ha_02", "ha_03", "ha_04"):
        row = by_id[cid]
        assert row["product_conf"] >= 0.8 and row["ingredient_conf"] >= 0.8 and row["strength_conf"] >= 0.8
        assert row["pre_add_level"] == "warning" and row["actual_level"] == "match" and row["add_ready"] is True
    for cid in ("ha_05", "ha_06", "ha_07"):
        row = by_id[cid]
        assert (row["strength_read"] is None or row["strength_conf"] < 0.8) and row["actual_level"] == "unsure" and row["add_ready"] is False
    assert by_id["ha_08"]["actual_level"] == "warning" and any("NSAID" in r for r in by_id["ha_08"]["reasons"])
    assert by_id["ha_09"]["actual_level"] == "warning" and any("allergy: penicillin" in r for r in by_id["ha_09"]["reasons"])
    assert by_id["ha_10"]["actual_level"] == "warning" and "expired 2025-03" in by_id["ha_10"]["reasons"]
    assert by_id["ha_11"]["item_kind"] == "food" and by_id["ha_11"]["strength_read"] is None and by_id["ha_11"]["actual_level"] == "info"
    assert by_id["ha_12"]["item_kind"] == "food" and by_id["ha_12"]["strength_read"] is None and by_id["ha_12"]["actual_level"] == "warning"
    assert any("allergy: tree nuts" in r for r in by_id["ha_12"]["reasons"])

    print(
        f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} "
        f"add_ready={data['add_confirmation_ready_count']} cw_dose={data['confident_wrong_dose_count']} "
        f"false_add={data['false_add_proposal_count']} bytes={len(raw.encode('utf-8'))}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
