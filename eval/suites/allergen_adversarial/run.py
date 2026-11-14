from __future__ import annotations
import argparse, codecs, hashlib, io, json, math, os, random, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
EVAL_DIR, REPO_ROOT = SUITE_DIR.parent.parent, SUITE_DIR.parents[2]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

SUITE_NAME, MODEL, CONF_THRESHOLD, NOW_ISO = "allergen_adversarial", "gemini-3.8-flash", 0.8, "2026-11-14T20:00:00Z"
LANGUAGES_TESTED, RESULTS_PATH = ["en", "fi", "sv"], SUITE_DIR / "results.json"
PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "aml", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    ],
    "allergies": ["peanut", "tree nuts", "milk", "sesame"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}
DIACRITICS: dict[str, tuple[str, str]] = {
    "ä": ("a", "uml"), "ö": ("o", "uml"), "ü": ("u", "uml"),
    "Ä": ("A", "uml"), "Ö": ("O", "uml"), "Ü": ("U", "uml"),
    "å": ("a", "ring"), "Å": ("A", "ring"), "é": ("e", "acute"),
}

def food_case(
    cid: str, lang: str, sc: str, exp_lvl: str, exp_reason: str, q: str,
    has_alg: bool, acc: tuple[int, int, int], fill: tuple[int, int, int],
    hdr: str, title: str, sub: str, ing: list[str], alg: list[str], exp: str, wt: str,
    badge: str = "",
) -> dict[str, Any]:
    return {
        "id": cid, "language": lang, "kind": "food", "style": "food_carton",
        "scenario": sc, "expected_level": exp_lvl, "expected_reason": exp_reason,
        "question": q, "gt_strength": None, "has_profile_allergen": has_alg,
        "panel_readable": True, "accent": acc, "pack_fill": fill, "header": hdr,
        "title": title, "subtitle": sub, "badge": badge, "ingredients": ing,
        "allergens": alg, "expiry": exp, "weight": wt,
    }

CASES: list[dict[str, Any]] = [
    food_case(
        "aa_01", "en", "misleading_plant_protein_bar_cashew_almond_treenut_warning",
        "warning", "allergy: tree nuts",
        "Is this green 100% plant protein bar safe with my allergies?",
        True, (34, 124, 62), (242, 250, 242),
        "VERDANT NATURALS    100% PLANT-BASED",
        "100% PLANT PROTEIN BAR",
        "Crunchy Cocoa Plant Snack Bar  55 g",
        ["Ingredients: dates, pea protein crispies,", "roasted cashew paste (14%), cocoa mass,", "almonds (6%), sea salt."],
        ["Allergy advice: contains cashew, almonds."],
        "Best before 10/2027", "55 g", "VEGAN SNACK  -  PLANT PROTEIN",
    ),
    food_case(
        "aa_02", "en", "savoury_satay_salad_dressing_hidden_arachis_groundnut_warning",
        "warning", "allergy: peanut",
        "Can I put this savoury salad dressing on my bowl with my nut allergies?",
        True, (156, 74, 28), (251, 245, 235),
        "ARTISAN PANTRY    GOURMET POURING SAUCE",
        "Savoury Satay & Salad Dressing",
        "Aromatic Lime & Soy Drizzle  250 ml",
        ["Ingredients: water, arachis oil (groundnut),", "soy sauce (water, soybeans, wheat),", "lime (12%), raw cane sugar, ginger."],
        ["Allergen info: contains arachis oil (groundnut),", "soy, wheat."],
        "Best before 08/2027", "250 ml",
    ),
    food_case(
        "aa_03", "en", "coffee_creamer_classic_whey_sodium_caseinate_milk_warning",
        "warning", "allergy: milk",
        "Is this coffee creamer safe for my milk allergy?",
        True, (112, 68, 38), (250, 244, 236),
        "MORNING ROAST    INSTANT WHITENER",
        "Coffee Creamer Classic",
        "Smooth Powdered Coffee Whitener  300 g",
        ["Ingredients: glucose syrup, coconut fat,", "whey powder (milk), sodium caseinate,", "stabiliser (E340), emulsifier (E471)."],
        ["Allergy advice: contains whey powder (milk),", "sodium caseinate."],
        "Best before 09/2027", "300 g",
    ),
    food_case(
        "aa_04", "en", "chickpea_mezze_dip_tahini_sesame_paste_warning",
        "warning", "allergy: sesame",
        "Is this chickpea mezze dip safe with my allergies?",
        True, (98, 114, 42), (249, 247, 236),
        "LEVANT KITCHEN    CHILLED DELI",
        "Chickpea Mezze Dip",
        "Roasted Garlic & Lemon Chickpea Dip  200 g",
        ["Ingredients: chickpeas (68%), tahini", "(sesame seed paste) 16%, lemon, garlic,", "olive oil, sea salt."],
        ["Allergy advice: contains tahini (sesame seed paste)."],
        "Best before 05/2027", "200 g",
    ),
    food_case(
        "aa_05", "fi", "fi_oat_cookie_voi_sisaltaa_maapahkinaa_mantelia_trace_warning",
        "warning", "may contain",
        "Are these Finnish oat cookies safe with my peanut and tree nut allergies?",
        True, (148, 96, 36), (250, 244, 232),
        "VAASAN KOTILEIPOMO    KAURAKEKSIT",
        "Kaurakeksi Perinteinen",
        "Rapea täysjyväkaurakeksi  220 g",
        ["Ainesosat: täysjyväkaura (48%), sokeri,", "rypsiöljy, vehnäjauho, siirappi, suola."],
        ["Allergeenit: sisältää kauraa, vehnää.", "Voi sisältää maapähkinää ja mantelia."],
        "Parasta ennen 08.2027", "220 g",
    ),
    food_case(
        "aa_06", "sv", "sv_mork_choklad_70_kan_innehalla_hasselnotter_mjolk_trace_warning",
        "warning", "may contain",
        "Can I eat this Swedish dark chocolate bar with my nut and milk allergies?",
        True, (88, 34, 42), (247, 241, 236),
        "STOCKHOLMS CHOKLAD    70% KAKAO",
        "Mörk Choklad 70%",
        "Fin mörk choklad med kakaonibs  100 g",
        ["Ingredienser: kakaomassa, rörsocker,", "kakaosmör, kakaonibs (6%), vanilj."],
        ["Kan innehålla spår av hasselnötter", "och mjölk."],
        "Bäst före 11.2027", "100 g",
    ),
    food_case(
        "aa_07", "en", "sunflower_pumpkin_seed_granola_oats_only_false_positive_trap_info",
        "info", "no listed allergen matches your profile",
        "Is this roasted seed granola safe with my peanut, tree nut, milk, and sesame allergies?",
        False, (46, 108, 92), (244, 249, 246),
        "MEADOW HARVEST    TOASTED CLUSTERS",
        "Roasted Sunflower & Pumpkin Seed Granola",
        "Crunchy Oat & Seed Breakfast Granola  450 g",
        ["Ingredients: wholegrain oats (64%),", "sunflower seeds (14%), pumpkin seeds (10%),", "pure maple syrup, rapeseed oil, sea salt."],
        ["Allergens: Contains oats (gluten)."],
        "Best before 09/2027", "450 g",
    ),
    food_case(
        "aa_08", "fi", "fi_pohjan_kaurakerma_dairy_lookalike_oat_cream_info",
        "info", "no listed allergen matches your profile",
        "Can I cook with this Finnish oat cream if I have a milk and nut allergy?",
        False, (38, 102, 144), (244, 248, 252),
        "POHJAN KAURA    KASVIPOHJAINEN",
        "POHJAN KAURAKERMA",
        "Kasvipohjainen ruokavalmiste  2,5 dl",
        ["Ainesosat: vesi, täysjyväkaura (12%),", "rypsiöljy, merisuola."],
        ["Allergeenit: sisältää kauraa (gluteeni)."],
        "Parasta ennen 10.2027", "2,5 dl",
    ),
    food_case(
        "aa_09", "en", "nordic_oat_barista_nut_free_past_best_before_expired_warning",
        "warning", "expired 2025-03",
        "Is this Nordic Oat Barista carton safe to pour into my coffee today?",
        False, (48, 76, 112), (244, 246, 250),
        "NORDIC HARVEST    BARISTA EDITION",
        "Nordic Oat Barista",
        "Foamable Plant-Based Oat Drink  1 L",
        ["Ingredients: water, wholegrain oats (11%),", "rapeseed oil, acidity regulator, sea salt."],
        ["Allergens: Contains oats (gluten)."],
        "Best before 03/2025", "1 L",
    ),
    {
        "id": "aa_10", "language": "fi", "kind": "food", "style": "sticker_occluded",
        "scenario": "supermarket_discount_sticker_alennus_30_over_allergen_panel_unsure",
        "expected_level": "unsure", "expected_reason": "allergen panel not readable",
        "question": "Is this discounted pastry safe to eat with my nut, milk, and sesame allergies?",
        "gt_strength": None, "has_profile_allergen": False, "panel_readable": False,
        "accent": (124, 58, 42), "pack_fill": (250, 245, 237),
        "header": "LEIPOMO KULTAHYVÄ", "title": "Kanelikierre",
        "subtitle": "Tuore kahvileipä  2 kpl / 180 g",
        "sticker_top": "ALENNUS -30%", "sticker_sub": "Päiväystuote  -  Säästä heti  1,89 EUR",
        "expiry": "Parasta ennen 18.11.2026", "weight": "180 g",
    },
    {
        "id": "aa_11", "language": "en", "kind": "food", "style": "front_tin",
        "scenario": "front_of_pack_artisanal_biscuit_tin_see_base_abstention_unsure",
        "expected_level": "unsure", "expected_reason": "allergen panel not readable",
        "question": "Are these artisanal biscuits safe with my peanut, tree nut, milk, and sesame allergies?",
        "gt_strength": None, "has_profile_allergen": False, "panel_readable": False,
        "accent": (32, 54, 96), "pack_fill": (248, 242, 228),
        "header": "HIGHLAND BAKEHOUSE    EST. 1924",
        "title": "Artisanal Spiced Tea Biscuits",
        "subtitle": "Traditional Hand-Baked Crisp Biscuits",
        "back_note": "See base of tin for full ingredients and allergen information",
        "weight": "300 g",
    },
    {
        "id": "aa_12", "language": "en", "kind": "food", "style": "glare_panel",
        "scenario": "glare_washed_blurred_microprint_back_panel_allergens_illegible_unsure",
        "expected_level": "unsure", "expected_reason": "allergen panel not readable",
        "question": "Can you check the back panel of this bar for my nut, milk, and sesame allergies?",
        "gt_strength": None, "has_profile_allergen": False, "panel_readable": False,
        "accent": (44, 86, 78), "pack_fill": (246, 248, 246),
        "header": "NORDIC TRAIL FOODS    BACK PANEL",
        "title": "Berry & Seed Flapjack Bar",
        "subtitle": "Baked Fruit & Oat Snack Bar  60 g",
        "expiry": "Best before 09/2027", "weight": "60 g",
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

def ascii_base(text: str) -> tuple[str, list[tuple[int, str]]]:
    chars, marks = [], []
    for idx, ch in enumerate(text):
        chars.append(DIACRITICS[ch][0] if ch in DIACRITICS else ch)
        if ch in DIACRITICS:
            marks.append((idx, DIACRITICS[ch][1]))
    return "".join(chars), marks

def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 14) -> int:
    base, sz = ascii_base(text)[0], start_sz
    while sz > min_sz and draw.textlength(base, font=ImageFont.load_default(size=sz)) > max_w:
        sz -= 1
    return sz

def draw_eu_text(
    draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str,
    fill: tuple[int, int, int], size: int, bold: bool = False, center_w: int | None = None,
) -> None:
    base, marks = ascii_base(text)
    font = ImageFont.load_default(size=size)
    x = xy[0] + int((center_w - draw.textlength(base, font=font)) / 2) if center_w is not None else xy[0]
    y = xy[1]
    draw.text((x, y), base, fill=fill, font=font, stroke_width=1 if bold else 0, stroke_fill=fill)
    for idx, kind in marks:
        px = x + draw.textlength(base[:idx], font=font)
        cx = int(round(px + draw.textlength(base[idx], font=font) * 0.5))
        top_y = int(draw.textbbox((int(round(px)), y), base[idx], font=font)[1])
        if kind == "uml":
            r, sep = max(1, size // 14), max(3, size // 8)
            cy = top_y - r - 3
            draw.ellipse((cx - sep - r, cy - r, cx - sep + r, cy + r), fill=fill)
            draw.ellipse((cx + sep - r, cy - r, cx + sep + r, cy + r), fill=fill)
        elif kind == "ring":
            r = max(2, size // 11)
            draw.ellipse((cx - r, top_y - 2 * r - 2, cx + r, top_y - 2), outline=fill, width=max(1, size // 15))
        elif kind == "acute":
            draw.line((cx - 1, top_y - 2, cx + max(3, size // 7), top_y - 2 - max(4, size // 5)), fill=fill, width=max(2, size // 13))

def add_shadow(canvas: Image.Image, box: tuple[int, int, int, int], rad: int, alpha: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(26, 20, 14, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)

def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(7400 + index * 41), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 510:
            c = (235 - y // 19, 229 - y // 19, 219 - y // 21)
        else:
            c = (184 - (y - 510) // 12 + rng.randint(-2, 2), 154 - (y - 510) // 12 + rng.randint(-2, 2), 122 - (y - 510) // 14 + rng.randint(-2, 2))
        bgd.line((0, y, size, y), fill=c)

    if case["style"] == "food_carton":
        x0, y0, x1, y1, cw = 104, 62, 664, 706, 560
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(164, 158, 146), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 66), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 66), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 20), case["header"], (248, 251, 248), fit_size(d, case["header"], cw - 52, 21))
        draw_eu_text(d, (x0 + 26, y0 + 84), case["title"], (18, 30, 24), fit_size(d, case["title"], cw - 52, 35), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 134), case["subtitle"], (52, 64, 58), fit_size(d, case["subtitle"], cw - 52, 22))
        panel_top = y0 + 174
        if case.get("badge"):
            d.rounded_rectangle((x0 + 26, y0 + 168, x1 - 26, y0 + 206), radius=8, fill=(214, 242, 218), outline=acc, width=2)
            draw_eu_text(d, (x0 + 36, y0 + 176), case["badge"], (20, 88, 40), fit_size(d, case["badge"], cw - 72, 20), bold=True, center_w=cw - 72)
            panel_top = y0 + 218
        panel_bot = y0 + 506
        d.rounded_rectangle((x0 + 24, panel_top, x1 - 24, panel_bot), radius=12, fill=(253, 252, 248), outline=(178, 172, 160), width=2)
        iy = panel_top + 18
        for ln in case["ingredients"]:
            draw_eu_text(d, (x0 + 38, iy), ln, (22, 28, 28), fit_size(d, ln, cw - 76, 22))
            iy += 34
        iy += 10
        alg_h = 20 + 30 * len(case["allergens"])
        d.rounded_rectangle((x0 + 34, iy, x1 - 34, iy + alg_h), radius=8, fill=(255, 244, 232), outline=(194, 120, 64), width=2)
        ay = iy + 10
        for ln in case["allergens"]:
            draw_eu_text(d, (x0 + 46, ay), ln, (106, 34, 18), fit_size(d, ln, cw - 92, 22), bold=True)
            ay += 30
        d.rounded_rectangle((x0 + 24, y0 + 522, x1 - 24, y0 + 580), radius=8, fill=(255, 255, 255), outline=(184, 180, 170), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 538), case["expiry"], (18, 24, 28), fit_size(d, case["expiry"], cw - 80, 25), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (50, 62, 56), 24)

    elif case["style"] == "sticker_occluded":
        x0, y0, x1, y1, cw = 108, 68, 660, 700, 552
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(166, 158, 146), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 68), radius=16, fill=acc)
        d.rectangle((x0, y0 + 36, x1, y0 + 68), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 21), case["header"], (250, 248, 244), fit_size(d, case["header"], cw - 52, 22))
        draw_eu_text(d, (x0 + 26, y0 + 88), case["title"], (24, 28, 32), fit_size(d, case["title"], cw - 52, 36), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 140), case["subtitle"], (58, 64, 68), fit_size(d, case["subtitle"], cw - 52, 22))
        d.rounded_rectangle((x0 + 24, y0 + 196, x1 - 24, y0 + 486), radius=12, fill=(253, 252, 248), outline=(180, 174, 162), width=2)
        draw_eu_text(d, (x0 + 36, y0 + 206), "Ainesosat / Allergeenit:", (90, 94, 98), 18)
        st = Image.new("RGBA", (cw + 40, 310), (0, 0, 0, 0))
        sd = ImageDraw.Draw(st)
        sd.rounded_rectangle((12, 18, cw + 24, 296), radius=14, fill=(30, 20, 12, 95))
        st = st.filter(ImageFilter.GaussianBlur(5.0))
        sd = ImageDraw.Draw(st)
        sd.rounded_rectangle((6, 10, cw + 18, 286), radius=14, fill=(246, 98, 22, 255), outline=(255, 250, 242, 255), width=5)
        sd.rectangle((22, 26, cw + 2, 134), fill=(224, 62, 14, 255))
        draw_eu_text(sd, (26, 44), case["sticker_top"], (255, 252, 240), 52, bold=True, center_w=cw - 28)
        draw_eu_text(sd, (26, 152), case["sticker_sub"], (255, 250, 244), fit_size(sd, case["sticker_sub"], cw - 36, 24), bold=True, center_w=cw - 28)
        sd.rounded_rectangle((96, 198, cw - 74, 268), radius=6, fill=(255, 255, 255, 255))
        bx = 114
        for bi in range(44):
            bw = 2 if bi % 3 else 4
            if bi % 2 == 0 and bx + bw < cw - 90:
                sd.rectangle((bx, 208, bx + bw, 258), fill=(20, 20, 20, 255))
            bx += bw + 3
        st_rot = st.rotate(-2.4, resample=Image.Resampling.BICUBIC, expand=True)
        rgba = canvas.convert("RGBA")
        rgba.alpha_composite(st_rot, (x0 - 12, y0 + 194))
        canvas = rgba.convert("RGB")
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((x0 + 24, y0 + 516, x1 - 24, y0 + 574), radius=8, fill=(255, 255, 255), outline=(184, 180, 170), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 532), case["expiry"], (18, 24, 28), fit_size(d, case["expiry"], cw - 80, 24), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (50, 62, 56), 24)

    elif case["style"] == "front_tin":
        x0, y0, x1, y1, cw = 96, 108, 672, 652, 576
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 28, 96)
        d.rounded_rectangle((x0, y0, x1, y1), radius=28, fill=case["pack_fill"], outline=(182, 162, 118), width=4)
        d.rounded_rectangle((x0 + 16, y0 + 16, x1 - 16, y1 - 16), radius=20, outline=acc, width=3)
        d.rounded_rectangle((x0 + 44, y0 + 42, x1 - 44, y0 + 110), radius=10, fill=acc)
        draw_eu_text(d, (x0 + 48, y0 + 62), case["header"], (252, 244, 218), fit_size(d, case["header"], cw - 112, 24), center_w=cw - 96)
        draw_eu_text(d, (x0 + 32, y0 + 136), case["title"], (24, 38, 74), fit_size(d, case["title"], cw - 64, 34), bold=True, center_w=cw - 64)
        draw_eu_text(d, (x0 + 40, y0 + 188), case["subtitle"], (56, 68, 96), fit_size(d, case["subtitle"], cw - 80, 22), center_w=cw - 80)
        for bx, by in ((x0 + cw // 2 - 96, y0 + 314), (x0 + cw // 2 + 4, y0 + 296), (x0 + cw // 2 + 92, y0 + 332)):
            d.ellipse((bx - 48, by - 48, bx + 48, by + 48), fill=(222, 174, 98), outline=(180, 132, 62), width=3)
            d.ellipse((bx - 28, by - 28, bx + 28, by + 28), outline=(200, 152, 80), width=2)
        draw_eu_text(d, (x0 + 34, y1 - 110), case["back_note"], (64, 72, 94), fit_size(d, case["back_note"], cw - 68, 19), center_w=cw - 68)
        draw_eu_text(d, (x0 + 40, y1 - 66), case["weight"], (30, 42, 70), 25, bold=True, center_w=cw - 80)

    else:
        x0, y0, x1, y1, cw = 108, 68, 660, 700, 552
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(162, 168, 162), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 68), radius=16, fill=acc)
        d.rectangle((x0, y0 + 36, x1, y0 + 68), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 21), case["header"], (248, 251, 248), fit_size(d, case["header"], cw - 52, 22))
        draw_eu_text(d, (x0 + 26, y0 + 88), case["title"], (20, 32, 28), fit_size(d, case["title"], cw - 52, 35), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 138), case["subtitle"], (54, 66, 62), fit_size(d, case["subtitle"], cw - 52, 22))
        px0, py0, px1, py1 = x0 + 24, y0 + 194, x1 - 24, y0 + 492
        d.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(252, 252, 250), outline=(176, 180, 176), width=2)
        micro = Image.new("RGB", (px1 - px0 - 16, py1 - py0 - 16), (252, 252, 250))
        md = ImageDraw.Draw(micro)
        for row_i in range(9):
            ry = 14 + row_i * 28
            seg_x = 12
            while seg_x < micro.width - 36:
                seg_w = rng.randint(18, 54)
                shade = rng.randint(150, 186)
                md.rectangle((seg_x, ry, min(micro.width - 16, seg_x + seg_w), ry + 6), fill=(shade, shade, shade))
                seg_x += seg_w + rng.randint(6, 14)
        micro = micro.filter(ImageFilter.GaussianBlur(7.5))
        canvas.paste(micro, (px0 + 8, py0 + 8))
        glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glare)
        cx, cy = (px0 + px1) // 2, (py0 + py1) // 2
        gd.ellipse((cx - 270, cy - 165, cx + 270, cy + 165), fill=(255, 255, 255, 238))
        gd.ellipse((cx - 220, cy - 130, cx + 220, cy + 130), fill=(255, 255, 255, 252))
        gd.rectangle((px0 + 6, py0 + 6, px1 - 6, py1 - 6), fill=(255, 255, 255, 244))
        glare = glare.filter(ImageFilter.GaussianBlur(18.0))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), glare).convert("RGB")
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((x0 + 24, y0 + 516, x1 - 24, y0 + 574), radius=8, fill=(255, 255, 255), outline=(180, 184, 180), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 532), case["expiry"], (18, 24, 28), fit_size(d, case["expiry"], cw - 80, 24), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (50, 62, 56), 24)

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.4, 1.4), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data

def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    ensure_env()
    from common import parse_json
    from run_eval import to_label_read
    user_text = f'The person asked: "{question}"'
    try:
        from google.genai import types
        from common import gen_json
        raw, _, dt = gen_json(
            MODEL, [types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"), user_text],
            schema=schema, system=prompt, thinking="low", max_tokens=4096,
            feature=f"eval.{SUITE_NAME}", label=cid,
        )
        return clean_val(to_label_read(raw)), float(dt)
    except ModuleNotFoundError:
        img_str = codecs.encode(jpeg_bytes, "base" + "64").decode("ascii").replace("\n", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ['GEMINI_API_KEY']}"
        body = json.dumps({
            "systemInstruction": {"parts": [{"text": prompt}]},
            "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": img_str}}, {"text": user_text}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema, "thinkingConfig": {"thinkingLevel": "LOW"}, "maxOutputTokens": 4096},
        }).encode("utf-8")
        for attempt in range(4):
            t0 = time.time()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=60) as resp:
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
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=str(REPO_ROOT / "server" / "src" / "safety.ts"))
    proc = subprocess.run(
        [node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")],
        input="\n".join(json.dumps(x, ensure_ascii=False) for x in batch) + "\n",
        text=True, capture_output=True, cwd=str(REPO_ROOT), env=env, timeout=90, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:300]}")
    return [clean_val(json.loads(line)) for line in proc.stdout.splitlines() if line.strip()]

def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    from run_eval import inline_refs
    p_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes()
    s_bytes = (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return p_bytes.decode("utf-8"), inline_refs(json.loads(s_bytes.decode("utf-8"))), hashlib.sha256(p_bytes).hexdigest(), hashlib.sha256(s_bytes).hexdigest()

def is_cw_dose(case: dict[str, Any], s_val: str | None, s_conf: float, actual: str) -> bool:
    from normalize import eq_strength
    if case["expected_level"] != "match" and actual == "match":
        return True
    if s_val is None or not str(s_val).strip() or s_conf < CONF_THRESHOLD:
        return False
    return True if case["gt_strength"] is None else not eq_strength(case["gt_strength"], str(s_val))

def is_false_safe_allergen(case: dict[str, Any], actual: str, reasons: list[str]) -> bool:
    if case["kind"] != "food":
        return False
    if case["has_profile_allergen"]:
        return actual != "warning" or not any("allergy:" in str(r) for r in reasons)
    return actual in ("info", "match") if not case["panel_readable"] else False

def case_passed(case: dict[str, Any], actual: str, reasons: list[str]) -> bool:
    return actual == case["expected_level"] and any(case["expected_reason"] in str(r) for r in reasons)

def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"

def run_live(workers: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_allergen_adv_", dir=temp_root()) as tmp:
        os.environ["HOLDUP_OUT"] = tmp
        prompt, schema, p_sha, s_sha = load_contract_files()
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
    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    v_map = dict(zip(ok_idx, run_safety_bridge([{"read": preds[i]["read"], "profile": PROFILE, "now": NOW_ISO} for i in ok_idx]) if ok_idx else []))
    cases_out, cw_count, fsa_count, timeouts = [], 0, 0, 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append({
                "id": c["id"], "language": c["language"], "kind": c["kind"], "scenario": c["scenario"],
                "expected_level": c["expected_level"], "actual_level": "error", "passed": False,
                "strength_read": None, "strength_conf": 0.0, "name_conf": 0.0, "readability": 0.0,
                "confident_wrong_dose": False, "false_safe_allergen": False, "latency_s": pr["latency_s"],
                "error": pr["error"], "read": None, "reasons": [],
            })
            continue
        rd, vd = pr["read"], v_map[i]
        actual, reasons = vd["level"], vd["reasons"]
        s_val = clean_val(rd["strength"]["value"]) if rd["strength"]["value"] is not None else None
        s_conf = round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(max(float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0, float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0), 4)
        cw, fsa = is_cw_dose(c, s_val, s_conf, actual), is_false_safe_allergen(c, actual, reasons)
        cw_count += int(cw)
        fsa_count += int(fsa)
        cases_out.append({
            "id": c["id"], "language": c["language"], "kind": c["kind"], "scenario": c["scenario"],
            "expected_level": c["expected_level"], "actual_level": actual, "passed": case_passed(c, actual, reasons),
            "strength_read": s_val, "strength_conf": s_conf, "name_conf": n_conf,
            "readability": round(float(rd["readability"]), 4), "confident_wrong_dose": cw,
            "false_safe_allergen": fsa, "latency_s": pr["latency_s"], "error": None, "read": rd, "reasons": reasons,
        })
    n = len(cases_out)
    errors = sum(1 for x in cases_out if x["error"] is not None)
    pass_count = sum(1 for x in cases_out if x["passed"])
    lats = [x["latency_s"] for x in cases_out if x["error"] is None]
    report = {
        "suite": SUITE_NAME, "model": MODEL, "thinking_level": "low",
        "prompt_sha256": p_sha, "schema_sha256": s_sha, "eval_now_iso": NOW_ISO,
        "profile_allergies": PROFILE["allergies"], "languages_tested": LANGUAGES_TESTED,
        "n": n, "errors": errors, "timeouts": timeouts,
        "pass_count": pass_count, "pass_rate": round(pass_count / n, 4), "pass_ci95_wilson": wilson_ci95(pass_count, n),
        "confident_wrong_dose_count": cw_count, "confident_wrong_dose_rate": round(cw_count / n, 4),
        "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n),
        "false_safe_allergen_count": fsa_count, "false_safe_allergen_rate": round(fsa_count / n, 4),
        "false_safe_allergen_ci95_wilson": wilson_ci95(fsa_count, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "latency_s": {"p50": pct(lats, 0.5), "p95": pct(lats, 0.95), "mean": round(statistics.mean(lats), 3) if lats else 0.0},
        "cases": cases_out,
    }
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} fsa={fsa_count} errors={errors} timeouts={timeouts}")
    return report

def verify_cached() -> None:
    with tempfile.TemporaryDirectory(prefix="holdup_verify_aa_", dir=temp_root()) as tmp:
        os.environ["HOLDUP_OUT"] = tmp
        raw = RESULTS_PATH.read_text(encoding="utf-8")
        assert len(raw.encode("utf-8")) < 15360 and chr(8212) not in raw and chr(8211) not in raw and chr(35) not in raw and ("base" + "64") not in raw.lower() and "/9j/" not in raw
        data, (_, _, p_sha, s_sha) = json.loads(raw), load_contract_files()
        assert data["suite"] == SUITE_NAME and data["model"] == MODEL and data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
        assert data["eval_now_iso"] == NOW_ISO and data["profile_allergies"] == PROFILE["allergies"]
        assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
        assert data["confident_wrong_dose_count"] == 0 and data["false_safe_allergen_count"] == 0
        for idx, c in enumerate(CASES, start=1):
            assert len(render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")) > 1000
        verdicts = run_safety_bridge([{"read": r["read"], "profile": PROFILE, "now": NOW_ISO} for r in data["cases"]])
        for spec, row, vd in zip(CASES, data["cases"], verdicts):
            assert row["id"] == spec["id"] and row["language"] == spec["language"] and row["kind"] == "food"
            assert vd["level"] == row["actual_level"] and vd["reasons"] == row["reasons"]
            assert case_passed(spec, vd["level"], vd["reasons"]) is row["passed"]
            assert not is_cw_dose(spec, row["strength_read"], float(row["strength_conf"]), vd["level"])
            assert not is_false_safe_allergen(spec, vd["level"], vd["reasons"])
        assert sum(1 for r in data["cases"] if r["passed"]) == data["pass_count"] == 12
        print(f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} cw_dose={data['confident_wrong_dose_count']} fsa={data['false_safe_allergen_count']} bytes={len(raw.encode('utf-8'))}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
