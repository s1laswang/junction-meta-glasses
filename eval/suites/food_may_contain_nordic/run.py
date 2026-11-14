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

SUITE_NAME, MODEL, CONF_THRESHOLD, NOW_ISO = "food_may_contain_nordic", "gemini-3.8-flash", 0.8, "2026-11-14T20:00:00Z"
LANGUAGES_TESTED, RESULTS_PATH = ["fi", "sv", "en"], SUITE_DIR / "results.json"
PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "aml", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    ],
    "allergies": ["peanut", "tree nuts", "milk", "egg", "soy", "sesame"],
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
    cid: str, lang: str, sc: str, exp_lvl: str, exp_reasons: list[str], q: str,
    has_alg: bool, acc: tuple[int, int, int], fill: tuple[int, int, int],
    hdr: str, title: str, sub: str, ing: list[str], alg: list[str], exp: str, wt: str,
    badge: str = "",
) -> dict[str, Any]:
    return {
        "id": cid, "language": lang, "kind": "food", "style": "food_carton",
        "scenario": sc, "expected_level": exp_lvl, "expected_reasons": exp_reasons,
        "question": q, "gt_strength": None, "has_profile_allergen": has_alg,
        "panel_readable": True, "accent": acc, "pack_fill": fill, "header": hdr,
        "title": title, "subtitle": sub, "badge": badge, "ingredients": ing,
        "allergens": alg, "expiry": exp, "weight": wt,
    }

CASES: list[dict[str, Any]] = [
    food_case(
        "nf_01", "fi", "fi_puolukka_mysli_saattaa_sisaltaa_maapahkinaa_precautionary_warning",
        "warning", ["may contain", "allergy: peanut"],
        "Is this Finnish lingonberry oat muesli safe with my peanut allergy?",
        True, (146, 44, 52), (251, 245, 242),
        "POHJOLAN MYLLY    SUOMALAINEN AAMUPALA",
        "Puolukka & Kaura Mysli",
        "Rapea täysjyvämysli metsäpuolukalla  450 g",
        ["Ainesosat: täysjyväkaurahiutale (74%),", "kuivattu puolukka (9%), auringonkukansiemen,", "omenatiiviste, rypsiöljy, merisuola."],
        ["Allergeenit: sisältää kauraa (gluteeni).", "Saattaa sisältää maapähkinää."],
        "Parasta ennen 09/2027", "450 g",
    ),
    food_case(
        "nf_02", "sv", "sv_kardemummaskorpor_kan_innehalla_spar_av_hasselnotter_warning",
        "warning", ["may contain", "allergy: tree nuts"],
        "Can I eat these Swedish cardamom rusks with my tree nut allergy?",
        True, (132, 78, 36), (250, 244, 234),
        "SKÅNSKA BAGERIET    KLASSISKA SKORPOR",
        "Kardemummaskorpor",
        "Krispiga skorpor bakade med kardemumma  225 g",
        ["Ingredienser: vetemjöl, socker, rapsolja,", "kardemumma (1,5%), jäst, havssalt."],
        ["Allergener: innehåller vete (gluten).", "Kan innehålla spår av hasselnötter."],
        "Bäst före 10/2027", "225 g",
    ),
    food_case(
        "nf_03", "en", "en_nordic_rye_thins_may_contain_traces_of_sesame_warning",
        "warning", ["may contain", "allergy: sesame"],
        "Are these Nordic seeded rye thins safe with my sesame allergy?",
        True, (72, 92, 54), (246, 248, 241),
        "HELSINKI BAKEHOUSE    NORDIC CRISPBREAD",
        "Flax & Pumpkin Rye Thins",
        "Oven-Baked Wholegrain Rye Crackers  180 g",
        ["Ingredients: wholegrain rye flour (72%),", "brown flaxseed (12%), pumpkin seeds (9%),", "rapeseed oil, yeast, sea salt."],
        ["Allergy advice: contains rye (gluten).", "May contain traces of sesame."],
        "Best before 11/2027", "180 g",
    ),
    food_case(
        "nf_04", "en", "en_bilberry_oat_clusters_may_contain_traces_of_tree_nuts_warning",
        "warning", ["may contain", "allergy: tree nuts"],
        "Is this box of wild bilberry oat clusters safe with my tree nut allergy?",
        True, (48, 62, 118), (244, 245, 251),
        "NORDIC FORAGE    ARCTIC BERRY BREAKFAST",
        "Wild Bilberry Oat Clusters",
        "Toasted Wholegrain Oat & Berry Crunch  375 g",
        ["Ingredients: wholegrain oats (76%),", "Nordic bilberries (8%), maple syrup,", "sunflower seeds, rapeseed oil, sea salt."],
        ["Allergy advice: contains oats (gluten).", "May contain traces of tree nuts (almonds, walnuts)."],
        "Best before 12/2027", "375 g",
    ),
    food_case(
        "nf_05", "fi", "fi_sv_yrttisipsit_hidden_herajauhe_vasslepulver_milk_warning",
        "warning", ["contains", "allergy: milk"],
        "Are these archipelago herb potato crisps safe for my milk allergy?",
        True, (42, 108, 74), (244, 249, 244),
        "SAARISTON HERKKU    PERUNALASTUT / POTATISCHIPS",
        "Saaristolais Yrttisipsit",
        "Rapeat perunalastut tillillä & ruohosipulilla  200 g",
        [
            "Ainesosat: peruna, rypsiöljy, suola,",
            "sipulijauhe, HERAJAUHE, tilli, ruohosipuli.",
            "Ingredienser: potatis, rapsolja, salt,",
            "lökpulver, VASSLEPULVER, dill, gräslök.",
        ],
        ["Allergeenit / Allergener: HERAJAUHE / VASSLEPULVER."],
        "Parasta ennen 09/2027", "200 g", "KASVIÖLJYSSÄ PAAHDETTU  -  KOTIMAINEN PERUNA",
    ),
    food_case(
        "nf_06", "sv", "sv_fi_havrevafflor_hidden_kananmunajauhe_aggvita_egg_warning",
        "warning", ["contains", "allergy: egg"],
        "Can I eat these dairy-free Nordic oat wafers with my egg and milk allergies?",
        True, (148, 92, 38), (251, 246, 236),
        "NORDISKA KAKOR    KEX & VÅFFLOR",
        "Krispiga Havrevåfflor",
        "Tunna spröda kex med vanilj / Rapeat kauravohvelit  175 g",
        [
            "Ingredienser: havremjöl, socker, rapsolja,",
            "potatisstärkelse, ÄGGVITA (4%), vanilj, salt.",
            "Ainesosat: kaurajauho, sokeri, rypsiöljy,",
            "perunatärkkelys, KANANMUNAJAUHE (4%), vanilja.",
        ],
        ["Allergener / Allergeenit: havre, ÄGGVITA / KANANMUNAJAUHE."],
        "Bäst före 10/2027", "175 g", "MJÖLKFRI  -  MAIDOTON",
    ),
    food_case(
        "nf_07", "fi", "fi_kaakaokaurapala_hidden_soijalesitiini_soy_warning",
        "warning", ["contains", "allergy: soy"],
        "Are these plant-based dark cocoa oat bites safe with my soy, milk, and nut allergies?",
        True, (92, 52, 38), (249, 244, 239),
        "KORPIHERKKU    KAURAVÄLIPALA",
        "Tumma Kaakao-Kaurapala",
        "Täyteläinen kauravälipala kaakaolla  160 g",
        [
            "Ainesosat: täysjyväkaura (54%), ruokosokeri,",
            "kaakaomassa, kaakaovoi, rypsiöljy,",
            "emulgointiaine (SOIJALESITIINI), merisuola.",
        ],
        ["Allergeenit: sisältää kauraa (gluteeni), SOIJALESITIINI."],
        "Parasta ennen 11/2027", "160 g", "MAIDOTON & PÄHKINÄTÖN  -  KASVIPOHJAINEN",
    ),
    food_case(
        "nf_08", "fi", "fi_pohjolan_kaurajuoma_clean_safe_oat_drink_info",
        "info", ["no listed allergen matches your profile"],
        "Is this Finnish oat drink carton safe with my allergies?",
        False, (34, 98, 138), (243, 248, 252),
        "POHJOLAN KAURA    KASVIPOHJAINEN JUOMA",
        "Täyteläinen Kaurajuoma",
        "Suomalainen täysjyväkaurajuoma kahviin & ruokaan  1 L",
        [
            "Ainesosat: vesi, täysjyväkaura (11%),",
            "rypsiöljy, kalsiumkarbonaatti, merisuola.",
            "Ingredienser: vatten, fullkornshavre (11%),",
            "rapsolja, kalciumkarbonat, havssalt.",
        ],
        ["Allergeenit / Allergener: sisältää kauraa / innehåller havre."],
        "Parasta ennen 11/2027", "1 L",
    ),
    food_case(
        "nf_09", "sv", "sv_nordiskt_ragknackebrod_clean_safe_rye_crisp_info",
        "info", ["no listed allergen matches your profile"],
        "Can I eat this Nordic rye crispbread with my nut, milk, egg, soy, and sesame allergies?",
        False, (116, 76, 42), (249, 245, 237),
        "KVARNENS BRÖD    KLASSISKT KNÄCKEBRÖD",
        "Nordiskt Rågknäckebröd",
        "Traditionellt fullkornsknäcke / Ruisnäkkileipä  250 g",
        [
            "Ingredienser: fullkornsrågmjöl (84%), vatten,",
            "jäst, joderat salt.",
            "Ainesosat: täysjyväruisjauho (84%), vesi,",
            "hiiva, jodioitu suola.",
        ],
        ["Allergener / Allergeenit: innehåller råg / sisältää ruista (gluten)."],
        "Bäst före 12/2027", "250 g",
    ),
    food_case(
        "nf_10", "fi", "fi_puolukkahillo_expired_parasta_ennen_02_2025_warning",
        "warning", ["expired 2025-02"],
        "Is this Finnish lingonberry jam safe and in date to eat today?",
        False, (138, 32, 46), (251, 244, 244),
        "KAINUUN MARJA    KOTIMAINEN MARJAHILLO",
        "Perinteinen Puolukkahillo",
        "Suomalaisista metsäpuolukoista keitetty hillo  400 g",
        [
            "Ainesosat: puolukka (52%), sokeri, vesi,",
            "hyytelöimisaine (pektiini), sitruunahappo.",
            "Ingredienser: lingon (52%), socker, vatten, pektin.",
        ],
        ["Allergeenit / Allergener: ei sisällä allergeeneja / inga allergener."],
        "Parasta ennen 02/2025", "400 g",
    ),
    {
        "id": "nf_11", "language": "fi", "kind": "food", "style": "thumb_occluded",
        "scenario": "fi_thumb_covered_ainesosat_ingredienser_panel_unsure",
        "expected_level": "unsure", "expected_reasons": ["allergen panel not readable"],
        "question": "Is this Finnish snack bar safe with my peanut, tree nut, milk, egg, soy, and sesame allergies?",
        "gt_strength": None, "has_profile_allergen": False, "panel_readable": False,
        "accent": (46, 94, 68), "pack_fill": (246, 249, 245),
        "header": "TAMPEREEN HYVÄ    VÄLIPALAPATUKKA",
        "title": "Pohjolan Välipalapatukka",
        "subtitle": "Pehmeä marja-viljapatukka  55 g",
        "panel_heading": "Ainesosat / Ingredienser:",
        "expiry": "Parasta ennen 09/2027", "weight": "55 g",
    },
    {
        "id": "nf_12", "language": "sv", "kind": "food", "style": "condensation_blurred",
        "scenario": "sv_condensation_blurred_ingredienser_ainesosat_panel_unsure",
        "expected_level": "unsure", "expected_reasons": ["allergen panel not readable"],
        "question": "Can you check the ingredients on this chilled Nordic beetroot salad for my allergies?",
        "gt_strength": None, "has_profile_allergen": False, "panel_readable": False,
        "accent": (36, 86, 122), "pack_fill": (242, 247, 251),
        "header": "SKÄRGÅRDENS KÖK    KYLD DELIKATESS",
        "title": "Nordisk Rödbetssallad",
        "subtitle": "Kyld delikatesssallad / Kylmä punajuurisalaatti  350 g",
        "panel_heading": "Ingredienser / Ainesosat:",
        "expiry": "Bäst före 12/2026", "weight": "350 g",
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
    rng, size, acc = random.Random(8300 + index * 47), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 510:
            c = (234 - y // 19, 228 - y // 19, 218 - y // 21)
        else:
            c = (182 - (y - 510) // 12 + rng.randint(-2, 2), 154 - (y - 510) // 12 + rng.randint(-2, 2), 124 - (y - 510) // 14 + rng.randint(-2, 2))
        bgd.line((0, y, size, y), fill=c)

    if case["style"] == "food_carton":
        x0, y0, x1, y1, cw = 104, 62, 664, 706, 560
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(164, 158, 146), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 66), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 66), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 20), case["header"], (248, 251, 248), fit_size(d, case["header"], cw - 52, 21))
        draw_eu_text(d, (x0 + 26, y0 + 84), case["title"], (18, 30, 24), fit_size(d, case["title"], cw - 52, 35), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 134), case["subtitle"], (52, 64, 58), fit_size(d, case["subtitle"], cw - 52, 21))
        panel_top = y0 + 174
        if case.get("badge"):
            d.rounded_rectangle((x0 + 26, y0 + 168, x1 - 26, y0 + 204), radius=8, fill=(216, 242, 220), outline=acc, width=2)
            draw_eu_text(d, (x0 + 36, y0 + 175), case["badge"], (20, 86, 40), fit_size(d, case["badge"], cw - 72, 19), bold=True, center_w=cw - 72)
            panel_top = y0 + 214
        panel_bot = y0 + 512
        d.rounded_rectangle((x0 + 24, panel_top, x1 - 24, panel_bot), radius=12, fill=(253, 252, 248), outline=(178, 172, 160), width=2)
        iy = panel_top + 16
        for ln in case["ingredients"]:
            draw_eu_text(d, (x0 + 38, iy), ln, (22, 28, 28), fit_size(d, ln, cw - 76, 21))
            iy += 31
        iy += 10
        alg_h = 20 + 30 * len(case["allergens"])
        d.rounded_rectangle((x0 + 34, iy, x1 - 34, iy + alg_h), radius=8, fill=(255, 244, 232), outline=(194, 120, 64), width=2)
        ay = iy + 10
        for ln in case["allergens"]:
            draw_eu_text(d, (x0 + 46, ay), ln, (106, 34, 18), fit_size(d, ln, cw - 92, 21), bold=True)
            ay += 30
        d.rounded_rectangle((x0 + 24, y0 + 524, x1 - 24, y0 + 582), radius=8, fill=(255, 255, 255), outline=(184, 180, 170), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 540), case["expiry"], (18, 24, 28), fit_size(d, case["expiry"], cw - 80, 25), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (50, 62, 56), 24)

    elif case["style"] == "thumb_occluded":
        x0, y0, x1, y1, cw = 104, 62, 664, 706, 560
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(164, 162, 152), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 66), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 66), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 20), case["header"], (248, 251, 248), fit_size(d, case["header"], cw - 52, 21))
        draw_eu_text(d, (x0 + 26, y0 + 84), case["title"], (18, 30, 24), fit_size(d, case["title"], cw - 52, 35), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 134), case["subtitle"], (52, 64, 58), fit_size(d, case["subtitle"], cw - 52, 22))
        px0, py0, px1, py1 = x0 + 24, y0 + 186, x1 - 24, y0 + 502
        d.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(253, 252, 248), outline=(178, 174, 162), width=2)
        draw_eu_text(d, (px0 + 16, py0 + 12), case["panel_heading"], (52, 58, 62), 21, bold=True)
        d.rounded_rectangle((x0 + 24, y0 + 524, x1 - 24, y0 + 582), radius=8, fill=(255, 255, 255), outline=(184, 180, 170), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 540), case["expiry"], (18, 24, 28), fit_size(d, case["expiry"], cw - 80, 25), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (50, 62, 56), 24)
        hand_sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hsd = ImageDraw.Draw(hand_sh)
        hsd.rounded_rectangle((-30, py0 + 44, px1 + 14, py1 + 18), radius=96, fill=(24, 16, 12, 118))
        hand_sh = hand_sh.filter(ImageFilter.GaussianBlur(9.0))
        hand = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hand)
        hd.rounded_rectangle((-46, py0 + 36, px1 + 8, py1 + 8), radius=98, fill=(224, 180, 154, 255), outline=(186, 138, 114, 255), width=4)
        hd.rounded_rectangle((-30, py0 + 56, px1 - 24, py1 - 16), radius=84, fill=(231, 189, 164, 255))
        hd.rounded_rectangle((px1 - 118, py0 + 68, px1 - 18, py1 - 36), radius=38, fill=(245, 224, 214, 255), outline=(204, 166, 148, 255), width=3)
        for kx in (230, 248, 412, 428):
            hd.arc((kx, py0 + 62, kx + 26, py1 - 28), start=110, end=250, fill=(192, 144, 120, 210), width=3)
        rgba = Image.alpha_composite(canvas.convert("RGBA"), hand_sh)
        canvas = Image.alpha_composite(rgba, hand).convert("RGB")

    else:
        x0, y0, x1, y1, cw = 104, 62, 664, 706, 560
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(154, 168, 180), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 66), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 66), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 20), case["header"], (246, 250, 253), fit_size(d, case["header"], cw - 52, 21))
        draw_eu_text(d, (x0 + 26, y0 + 84), case["title"], (16, 30, 44), fit_size(d, case["title"], cw - 52, 35), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 134), case["subtitle"], (48, 64, 78), fit_size(d, case["subtitle"], cw - 52, 21))
        px0, py0, px1, py1 = x0 + 24, y0 + 186, x1 - 24, y0 + 502
        d.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(248, 251, 253), outline=(168, 180, 190), width=2)
        draw_eu_text(d, (px0 + 16, py0 + 12), case["panel_heading"], (54, 68, 80), 21, bold=True)
        micro = Image.new("RGB", (px1 - px0 - 16, py1 - py0 - 52), (248, 251, 253))
        md = ImageDraw.Draw(micro)
        for row_i in range(8):
            ry = 14 + row_i * 29
            seg_x = 12
            while seg_x < micro.width - 34:
                seg_w = rng.randint(18, 52)
                shade = rng.randint(146, 182)
                md.rectangle((seg_x, ry, min(micro.width - 14, seg_x + seg_w), ry + 6), fill=(shade - 6, shade, shade + 6))
                seg_x += seg_w + rng.randint(6, 14)
        micro = micro.filter(ImageFilter.GaussianBlur(8.5))
        canvas.paste(micro, (px0 + 8, py0 + 44))
        fog = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fog)
        fd.rounded_rectangle((px0 + 4, py0 + 38, px1 - 4, py1 - 4), radius=10, fill=(236, 244, 252, 232))
        fog = fog.filter(ImageFilter.GaussianBlur(8.0))
        drops = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        dd = ImageDraw.Draw(drops)
        for _ in range(96):
            dx = rng.randint(px0 + 14, px1 - 18)
            dy = rng.randint(py0 + 44, py1 - 14)
            dr = rng.randint(3, 9)
            dd.ellipse((dx - dr, dy - dr + 1, dx + dr, dy + dr + 2), fill=(150, 174, 194, 145))
            dd.ellipse((dx - dr, dy - dr, dx + dr, dy + dr), fill=(244, 250, 255, 224))
            hr = max(1, dr // 3)
            dd.ellipse((dx - dr // 2 - hr, dy - dr // 2 - hr, dx - dr // 2 + hr, dy - dr // 2 + hr), fill=(255, 255, 255, 248))
        for sx in (px0 + 112, px0 + 264, px0 + 398):
            dd.line((sx, py0 + 48, sx + rng.randint(-6, 6), py1 - 18), fill=(246, 251, 255, 196), width=5)
        rgba = Image.alpha_composite(canvas.convert("RGBA"), fog)
        canvas = Image.alpha_composite(rgba, drops).convert("RGB")
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((x0 + 24, y0 + 524, x1 - 24, y0 + 582), radius=8, fill=(255, 255, 255), outline=(176, 184, 192), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 540), case["expiry"], (18, 24, 32), fit_size(d, case["expiry"], cw - 80, 25), bold=True)
        draw_eu_text(d, (x0 + 28, y1 - 46), case["weight"], (48, 62, 74), 24)

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.3, 1.3), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
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
    return actual == case["expected_level"] and any(all(req in str(r) for req in case["expected_reasons"]) for r in reasons)

def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"

def run_live(workers: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_nordic_food_", dir=temp_root()) as tmp:
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
    with tempfile.TemporaryDirectory(prefix="holdup_verify_nf_", dir=temp_root()) as tmp:
        os.environ["HOLDUP_OUT"] = tmp
        py_raw = Path(__file__).read_text(encoding="utf-8")
        assert chr(35) not in py_raw and chr(8212) not in py_raw and chr(8211) not in py_raw and ("base" + "64") not in py_raw.lower()
        readme_path = SUITE_DIR / "README.md"
        if readme_path.is_file():
            md_raw = readme_path.read_text(encoding="utf-8")
            assert chr(35) not in md_raw and chr(8212) not in md_raw and chr(8211) not in md_raw and ("base" + "64") not in md_raw.lower()
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
