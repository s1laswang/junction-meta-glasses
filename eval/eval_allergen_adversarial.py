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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "allergen_adversarial"
OUT_JSON_PATH = REPO_ROOT / "eval" / "allergen_adversarial_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80

PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipine",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "notes": "Blood pressure tablet, 1 in the evening",
        }
    ],
    "allergies": ["peanut", "tree nuts", "milk", "sesame", "soy", "egg"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "aa_01",
        "category": "botanical_nordic_peanut",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Savory Chili Crisp using botanical arachis oil and Finnish maapahkinavoi without English word peanut",
        "expected_level": "warning",
        "target_allergy": "peanut",
        "adversarial_terms": ["arachis oil", "maapahkinavoi", "maapahkinaoljy"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": -1.7,
        "accent": (154, 42, 32),
        "pack_fill": (249, 243, 234),
        "header": "NORDIC BOTANICAL KITCHEN",
        "title": "Crispy Chili Condiment",
        "sub_title": "Savory Chili Oil Topping  210 g",
        "panel_lines": [
            "Ingredients: refined arachis oil (Arachis hypogaea, 58%),",
            "dried chili flakes, shallots, garlic, sea salt.",
            "Ainesosat: puhdistettu maapahkinaoljy, paahdettu",
            "maapahkinavoi (6%), chili, valkosipuli, merisuola.",
        ],
        "expiry_line": "Best before: 2027-11-15",
        "weight_line": "210 g",
    },
    {
        "id": "aa_02",
        "category": "confectionery_nordic_tree_nuts",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Dark cocoa truffles with praline paste (almond, cashew, walnut) and Finnish manteli",
        "expected_level": "warning",
        "target_allergy": "tree nuts",
        "adversarial_terms": ["praline", "almond", "manteli", "cashew", "walnut"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": 1.6,
        "accent": (98, 52, 34),
        "pack_fill": (247, 240, 231),
        "header": "HELSINKI CONFISERIE",
        "title": "Velvet Cocoa Truffles",
        "sub_title": "Artisan Dark Confectionery  180 g",
        "panel_lines": [
            "Ingredients: cocoa mass, sugar, praline paste (24%:",
            "roasted almond, cashew, walnut), cocoa butter.",
            "Ainesosat: kaakaomassa, sokeri, praliini (manteli,",
            "cashewpahkina, saksanpahkina), kaakaovoi.",
        ],
        "expiry_line": "Best before: 2027-10-20",
        "weight_line": "180 g",
    },
    {
        "id": "aa_03",
        "category": "dairy_protein_fractions",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Savory herb crackers listing sweet whey powder and casein without plain milk keyword",
        "expected_level": "warning",
        "target_allergy": "milk",
        "adversarial_terms": ["whey powder", "casein", "sodium caseinate"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": -1.5,
        "accent": (46, 94, 72),
        "pack_fill": (246, 247, 241),
        "header": "NORDIC BAKERY CO.",
        "title": "Rosemary Sea Salt Crisps",
        "sub_title": "Oven-Baked Rice Crackers  150 g",
        "panel_lines": [
            "Ingredients: rice flour, sunflower oil, sweet whey powder",
            "(7%), micellar casein, sodium caseinate, rosemary, salt.",
            "Ainesosat: riisijauho, auringonkukkaoljy, herajauhe,",
            "kaseiini, kaseinaatti, rosmariini, merisuola.",
        ],
        "expiry_line": "Best before: 2027-09-30",
        "weight_line": "150 g",
    },
    {
        "id": "aa_04",
        "category": "pharma_tablet_excipient",
        "kind": "medication",
        "render_style": "med_excipient_box",
        "description": "Scheduled AMLODIPINE ORION 5 mg tablets containing lactose monohydrate pharmaceutical excipient",
        "expected_level": "warning",
        "target_allergy": "milk",
        "adversarial_terms": ["lactose monohydrate", "laktoosimonohydraatti"],
        "strength_readable": True,
        "printed_strength": "5 mg",
        "ground_truth_strength": "5 mg",
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": 1.8,
        "accent": (22, 102, 146),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPINE ORION",
        "strength_badge": "5 mg",
        "form_line": "film-coated tablets",
        "sub_line": "Active substance: amlodipine (as besilate)",
        "excipient_lines": [
            "Excipients: lactose monohydrate (64 mg per tablet),",
            "microcrystalline cellulose, magnesium stearate.",
            "Apuaineet: laktoosimonohydraatti, selluloosa.",
        ],
        "pack_line": "30 tablets    Oral use",
        "expiry_line": "EXP 2027-11",
    },
    {
        "id": "aa_05",
        "category": "culinary_paste_sesame",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Roasted garlic chickpea dip containing stone-ground tahini (Sesamum indicum / sesame)",
        "expected_level": "warning",
        "target_allergy": "sesame",
        "adversarial_terms": ["tahini", "sesame"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": -1.9,
        "accent": (166, 108, 34),
        "pack_fill": (250, 246, 236),
        "header": "LEVANT MEZZE KITCHEN",
        "title": "Roasted Garlic Chickpea Dip",
        "sub_title": "Mediterranean Mezze Spread  200 g",
        "panel_lines": [
            "Ingredients: cooked chickpeas (68%), stone-ground tahini",
            "(18%, crushed sesame / Sesamum indicum), olive oil,",
            "lemon juice, roasted garlic, cumin, sea salt.",
            "Ainesosat: kikherne, tahini (seesami), oliivioljy, suola.",
        ],
        "expiry_line": "Best before: 2027-08-18",
        "weight_line": "200 g",
    },
    {
        "id": "aa_06",
        "category": "emulsifier_soy_lecithin",
        "kind": "food",
        "render_style": "food_carton",
        "description": "70% dark cocoa bar with emulsifier E322 (soy lecithin / soijalesitiini)",
        "expected_level": "warning",
        "target_allergy": "soy",
        "adversarial_terms": ["soy lecithin", "soijalesitiini"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": 1.4,
        "accent": (72, 42, 54),
        "pack_fill": (248, 243, 241),
        "header": "NORDIC CACAO ATELIER",
        "title": "70% Dark Cocoa Bar",
        "sub_title": "Single-Origin Dark Chocolate  100 g",
        "panel_lines": [
            "Ingredients: cocoa mass (70%), cane sugar, cocoa butter,",
            "emulsifier: E322 (soy lecithin), natural vanilla.",
            "Ainesosat: kaakaomassa, ruokosokeri, kaakaovoi,",
            "emulgointiaine E322 (soijalesitiini), vanilja.",
        ],
        "expiry_line": "Best before: 2027-12-05",
        "weight_line": "100 g",
    },
    {
        "id": "aa_07",
        "category": "protein_fraction_egg",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Artisan rice-maize pasta bound with dried albumin (egg white) and ovalbumin",
        "expected_level": "warning",
        "target_allergy": "egg",
        "adversarial_terms": ["albumin", "egg white", "ovalbumin"],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "box_angle": -1.6,
        "accent": (142, 98, 28),
        "pack_fill": (251, 248, 236),
        "header": "PASTIFICIO NORDICO",
        "title": "Artisan Golden Tagliatelle",
        "sub_title": "Bronze-Die Dried Pasta  250 g",
        "panel_lines": [
            "Ingredients: white rice flour, maize flour, water,",
            "dried albumin (egg white, 5%), ovalbumin.",
            "Ainesosat: riisijauho, maissijauho, vesi,",
            "kuivattu albumiini (munavalkuainen).",
        ],
        "expiry_line": "Best before: 2028-02-14",
        "weight_line": "250 g",
    },
    {
        "id": "aa_08",
        "category": "negative_control_water",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Clean allergen-free negative control: 100% Pure Spring Water with explicit zero-allergen panel",
        "expected_level": "info",
        "target_allergy": None,
        "adversarial_terms": [],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": 1.3,
        "accent": (24, 108, 156),
        "pack_fill": (243, 249, 252),
        "header": "LAPONIA NATURAL SPRING",
        "title": "100% Pure Spring Water",
        "sub_title": "Still Natural Spring Water  500 ml",
        "panel_lines": [
            "Ingredients: 100% Pure Spring Water.",
            "Allergen declaration: Allergen-free (0 allergens).",
            "Ainesosat: 100% puhdas lahdevesi.",
        ],
        "expiry_line": "Best before: 2028-06-01",
        "weight_line": "500 ml",
    },
    {
        "id": "aa_09",
        "category": "negative_control_oats",
        "kind": "food",
        "render_style": "food_carton",
        "description": "Clean negative control for profile: Plain Rolled Oats, water, sea salt",
        "expected_level": "info",
        "target_allergy": None,
        "adversarial_terms": [],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": True,
        "box_angle": -1.4,
        "accent": (48, 114, 78),
        "pack_fill": (245, 248, 242),
        "header": "POHJAN HARVEST MILL",
        "title": "Plain Rolled Oats",
        "sub_title": "Simple Wholegrain Porridge Cup  250 g",
        "panel_lines": [
            "Ingredients: Plain rolled oats, water, sea salt.",
            "Allergen information: Contains oats.",
            "Ainesosat: taysjyvakaurahiutale, vesi, merisuola.",
        ],
        "expiry_line": "Best before: 2027-11-30",
        "weight_line": "250 g",
    },
    {
        "id": "aa_10",
        "category": "front_of_pack_no_ingredients",
        "kind": "food",
        "render_style": "front_pack",
        "description": "Front-of-pack biscuit carton with zero ingredient list or allergen declaration",
        "expected_level": "unsure",
        "target_allergy": None,
        "adversarial_terms": [],
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "box_angle": 1.5,
        "accent": (36, 58, 108),
        "pack_fill": (248, 242, 228),
        "header": "MAISON NORDIQUE",
        "title": "Artisan Crunchy Biscuits",
        "sub_title": "Golden Oven-Baked Tea Biscuits",
        "weight_line": "Net wt 250 g",
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
    em_dash = chr(8212)
    en_dash = chr(8211)
    if isinstance(val, str):
        return val.replace(em_dash, " - ").replace(en_dash, "-")
    if isinstance(val, list):
        return [sanitize_text(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_text(k): sanitize_text(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    em_dash = chr(8212)
    en_dash = chr(8211)
    if isinstance(node, str):
        if em_dash in node or en_dash in node:
            raise AssertionError(f"Forbidden dash found in JSON string: {node[:80]}")
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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 15) -> Any:
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


def render_food_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 92, pad + 72, pad + 676, pad + 696
    cw, ch = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 16, 95))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    carton = Image.new("RGB", (cw, ch), case["pack_fill"])
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 68), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], cw - 52, 22)
    cd.text((26, 22), case["header"], fill=(246, 249, 246), font=f_hdr)

    title_col = (20, 30, 26)
    f_title = fit_font(cd, case["title"], cw - 52, 38)
    cd.text(
        (26, 88),
        case["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )

    f_sub = fit_font(cd, case["sub_title"], cw - 52, 22)
    cd.text((26, 144), case["sub_title"], fill=(54, 66, 60), font=f_sub)

    lines = case["panel_lines"]
    panel_top = 190
    panel_bottom = panel_top + 36 + len(lines) * 38
    cd.rounded_rectangle(
        (22, panel_top, cw - 22, panel_bottom),
        radius=12,
        fill=(253, 252, 249),
        outline=(176, 170, 158),
        width=2,
    )
    iy = panel_top + 18
    for ln in lines:
        f_ing = fit_font(cd, ln, cw - 72, 22)
        cd.text((36, iy), ln, fill=(22, 26, 28), font=f_ing)
        iy += 38

    exp_y = panel_bottom + 22
    cd.rounded_rectangle((22, exp_y, cw - 22, exp_y + 58), radius=8, fill=(255, 255, 255), outline=(188, 184, 174), width=2)
    f_exp = fit_font(cd, case["expiry_line"], cw - 72, 24)
    cd.text((36, exp_y + 16), case["expiry_line"], fill=(20, 26, 28), font=f_exp)

    cd.text((26, ch - 46), case["weight_line"], fill=(52, 64, 58), font=ImageFont.load_default(size=24))

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(168, 162, 150, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)

    glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glare).ellipse((-90, -110, 520, 420), fill=(255, 253, 246, 18))
    glare = glare.filter(ImageFilter.GaussianBlur(radius=32.0))
    return Image.alpha_composite(composed, glare).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_med_excipient_box(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 98, pad + 704, pad + 662
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(26, 22, 18, 92))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 60), fill=case["accent"])
    f_hdr = fit_font(cd, case["header"], bw - 56, 22)
    cd.text((28, 18), case["header"], fill=(246, 249, 252), font=f_hdr)

    title_col = (16, 22, 30)
    f_title = fit_font(cd, case["title"], bw - 56, 40)
    cd.text(
        (28, 78),
        case["title"],
        fill=title_col,
        font=f_title,
        stroke_width=1,
        stroke_fill=title_col,
    )

    f_sub = fit_font(cd, case["sub_line"], bw - 56, 22)
    cd.text((28, 134), case["sub_line"], fill=(52, 60, 72), font=f_sub)

    sx0, sy0, sx1, sy1 = 28, 174, 244, 250
    cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
    f_str = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 32, 42)
    cd.text(
        (sx0 + 20, sy0 + 14),
        case["strength_badge"],
        fill=(14, 20, 28),
        font=f_str,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )
    f_form = fit_font(cd, case["form_line"], bw - sx1 - 44, 24)
    cd.text((sx1 + 18, sy0 + 24), case["form_line"], fill=(34, 42, 52), font=f_form)

    cd.rounded_rectangle((28, 272, bw - 28, 412), radius=10, fill=(247, 249, 252), outline=(176, 184, 194), width=2)
    ey = 288
    for ln in case["excipient_lines"]:
        f_exc = fit_font(cd, ln, bw - 84, 21)
        cd.text((42, ey), ln, fill=(24, 30, 38), font=f_exc)
        ey += 36

    f_pack = fit_font(cd, case["pack_line"], 320, 22)
    cd.text((28, 452), case["pack_line"], fill=(52, 60, 70), font=f_pack)

    f_exp = fit_font(cd, case["expiry_line"], 260, 24)
    exp_w = int(cd.textlength(case["expiry_line"], font=f_exp)) + 36
    ex0 = max(28, bw - exp_w - 28)
    cd.rounded_rectangle((ex0, 438, bw - 28, 494), radius=8, fill=(242, 245, 248), outline=(164, 172, 182), width=2)
    cd.text((ex0 + 18, 452), case["expiry_line"], fill=(18, 24, 30), font=f_exp)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)

    glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glare).ellipse((-90, -110, 520, 420), fill=(255, 253, 246, 18))
    glare = glare.filter(ImageFilter.GaussianBlur(radius=32.0))
    return Image.alpha_composite(composed, glare).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_front_pack(case: dict[str, Any], seed: int) -> Image.Image:
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
    seed = 20261188 + idx * 43
    style = case["render_style"]
    if style == "food_carton":
        return render_food_carton(case, seed)
    if style == "med_excipient_box":
        return render_med_excipient_box(case, seed)
    if style == "front_pack":
        return render_front_pack(case, seed)
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
        raise RuntimeError("node binary not found in PATH")
    return node_bin


def evaluate_via_typescript(
    node_bin: str,
    raw_items: list[dict[str, Any]],
    profile: dict[str, Any],
) -> dict[str, dict[str, Any]]:
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
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"profile": profile, "items": raw_items}),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
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

    node_bin = ensure_node_and_deps()
    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

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
    ts_results = evaluate_via_typescript(node_bin, ts_payload, PROFILE)

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
            if pred_level == "match" or (bool(s_val) and s_conf >= STRENGTH_MIN_CONF):
                confident_wrong_dose = True

        reasons = verdict_obj.get("reasons") or []
        target_allergy = case["target_allergy"]
        if target_allergy:
            allergen_reason_hit = any(f"(allergy: {target_allergy})" in str(r) for r in reasons)
        else:
            allergen_reason_hit = any("allergy:" in str(r) for r in reasons)

        allergen_detected = bool(pred_level == "warning" and allergen_reason_hit)
        false_safe_allergen = bool(
            (case["has_profile_allergen"] and not allergen_detected)
            or (not case["panel_readable"] and pred_level in ("info", "match"))
        )

        item_entry = {
            "id": cid,
            "category": case["category"],
            "description": sanitize_text(case["description"]),
            "kind": case["kind"],
            "image_path": run["image_path"],
            "target_allergy": target_allergy,
            "adversarial_terms": list(case["adversarial_terms"]),
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
            f"[{cid}] cat={case['category']} expected={exp_level} predicted={pred_level} "
            f"match={verdict_match} alg_hit={allergen_detected} "
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

    clean_field_accuracy = (
        round(sum(1 for it in readable_meds if it["strength_correct"]) / len(readable_meds), 4)
        if readable_meds
        else None
    )
    occluded_abstention_rate = (
        round(sum(1 for it in trap_items if it["abstained"]) / len(trap_items), 4)
        if trap_items
        else None
    )
    allergen_recall = round(
        sum(1 for it in allergen_pos if it["allergen_detected"]) / len(allergen_pos),
        4,
    )

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "allergen_recall": allergen_recall,
        "false_safe_allergen_count": fsa_count,
        "confident_wrong_dose_count": cwd_count,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "allergies_tested": list(PROFILE["allergies"]),
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
