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
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "parallel_import_substitution"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T20:00:00Z"
LANGUAGES_TESTED = ["fi", "sv", "en"]
RESULTS_PATH = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "norvasc", "name": "Norvasc", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "glucophage", "name": "Glucophage", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "panadol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
        {"id": "emconcor", "name": "Emconcor", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

DIACRITICS: dict[str, tuple[str, str]] = {
    "ä": ("a", "uml"), "ö": ("o", "uml"), "ü": ("u", "uml"),
    "Ä": ("A", "uml"), "Ö": ("O", "uml"), "Ü": ("U", "uml"),
    "å": ("a", "ring"), "Å": ("A", "ring"),
    "é": ("e", "acute"), "á": ("a", "acute"), "ó": ("o", "acute"), "í": ("i", "acute"),
}

CASES: list[dict[str, Any]] = [
    {
        "id": "pi_01",
        "language": "fi",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "fi_generic_amlodipin_krka_5mg_match",
        "expected_level": "match",
        "expected_reason": "matches norvasc",
        "question": "Is this substituted pharmacy box my evening Norvasc 5 mg pill?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (18, 112, 96),
        "header": "KRKA    Vnr 04 51 82",
        "title": "AMLODIPIN KRKA",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "EXP 10/2027",
    },
    {
        "id": "pi_02",
        "language": "fi",
        "kind": "medication",
        "style": "parallel_oversticker",
        "scenario": "eu_parallel_import_orifarm_norvasc_5mg_match",
        "expected_level": "match",
        "expected_reason": "matches norvasc",
        "question": "Is this parallel-import over-stickered box my evening Norvasc 5 mg?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (30, 68, 132),
        "foreign_header": "PFIZER EUROPE    CN 653219.1",
        "foreign_footer": "30 comprimidos    Via oral",
        "sticker_header": "ORIFARM OY  |  Rinnakkaistuonti  |  Vnr 51 82 04",
        "title": "NORVASC 5 mg tabletti - amlodipiini",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "printed_strength": "5 mg",
        "form": "30 tablettia    Suun kautta",
        "expiry": "EXP 2027-09",
    },
    {
        "id": "pi_03",
        "language": "sv",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "sv_generic_metformin_sandoz_500mg_match",
        "expected_level": "match",
        "expected_reason": "matches glucophage",
        "question": "Is this Swedish generic box my Glucophage 500 mg tablet?",
        "gt_strength": "500 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (28, 78, 158),
        "header": "SANDOZ    Vnr 14 29 88",
        "title": "METFORMIN SANDOZ",
        "subtitle": "Aktiv substans: metforminhydroklorid",
        "printed_strength": "500 mg",
        "form": "filmdragerade tabletter",
        "pack": "100 filmdragerade tabletter",
        "expiry": "Utg.dat. 12.2027",
    },
    {
        "id": "pi_04",
        "language": "fi",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "fi_comma_decimal_bisoprolol_ratiopharm_2_5mg_match",
        "expected_level": "match",
        "expected_reason": "matches emconcor",
        "question": "Is this substituted box my morning Emconcor 2.5 mg tablet?",
        "gt_strength": "2.5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (24, 96, 142),
        "header": "RATIOPHARM    Vnr 09 61 35",
        "title": "BISOPROLOL RATIOPHARM",
        "subtitle": "Vaikuttava aine: bisoprololi",
        "printed_strength": "2,5 mg",
        "form": "tabletti",
        "pack": "100 tablettia    Suun kautta",
        "expiry": "Käyt. viim. 11.2027",
    },
    {
        "id": "pi_05",
        "language": "en",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "generic_amlodipine_accord_10mg_strength_mismatch_warning",
        "expected_level": "warning",
        "expected_reason": "strength 10 mg differs from your 5 mg",
        "question": "The pharmacy substituted my Norvasc, is this my 5 mg evening pill?",
        "gt_strength": "10 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (118, 42, 134),
        "header": "ACCORD HEALTHCARE    Vnr 16 74 20",
        "title": "AMLODIPINE ACCORD",
        "subtitle": "Active substance: amlodipine",
        "printed_strength": "10 mg",
        "form": "tablets",
        "pack": "98 tablets    Oral use",
        "expiry": "EXP 11/2027",
    },
    {
        "id": "pi_06",
        "language": "fi",
        "kind": "medication",
        "style": "parallel_oversticker",
        "scenario": "parallel_import_bisoprolol_teva_5mg_2x_strength_warning",
        "expected_level": "warning",
        "expected_reason": "strength 5 mg differs from your 2.5 mg",
        "question": "Is this parallel-import beta-blocker my morning 2.5 mg dose?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (146, 54, 42),
        "foreign_header": "TEVA PHARMA EU    Ch.-B. 88310",
        "foreign_footer": "100 Tabletten    Zum Einnehmen",
        "sticker_header": "PARANOVA OY  |  Rinnakkaistuonti  |  Vnr 48 19 33",
        "title": "BISOPROLOL TEVA",
        "subtitle": "Vaikuttava aine: bisoprololi",
        "printed_strength": "5 mg",
        "form": "100 tablettia    Suun kautta",
        "expiry": "EXP 2027-10",
    },
    {
        "id": "pi_07",
        "language": "fi",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "painkiller_lookalike_pronaxen_500mg_nsaid_avoid_warning",
        "expected_level": "warning",
        "expected_reason": "NSAID",
        "question": "Can I take this 500 mg painkiller instead of my Panadol?",
        "gt_strength": "500 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (26, 98, 152),
        "header": "ORION PHARMA    Vnr 01 89 52",
        "title": "PRONAXEN",
        "subtitle": "Vaikuttava aine: naprokseeni",
        "printed_strength": "500 mg",
        "form": "tabletti",
        "pack": "30 tablettia    Suun kautta",
        "expiry": "Käyt. viim. 10.2027",
    },
    {
        "id": "pi_08",
        "language": "fi",
        "kind": "medication",
        "style": "generic_box",
        "scenario": "unlisted_cardiovascular_ramipril_hexal_5mg_warning",
        "expected_level": "warning",
        "expected_reason": "not on your medication list",
        "question": "Is this 5 mg box my evening blood pressure pill?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (22, 104, 138),
        "header": "HEXAL    Vnr 11 40 77",
        "title": "RAMIPRIL HEXAL",
        "subtitle": "Vaikuttava aine: ramipriili",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "EXP 09/2027",
    },
    {
        "id": "pi_09",
        "language": "fi",
        "kind": "medication",
        "style": "worn_brand_box",
        "scenario": "pre_substitution_travel_pouch_norvasc_5mg_expired_warning",
        "expected_level": "warning",
        "expected_reason": "expired 2025-04",
        "question": "Can I take this old Norvasc 5 mg box from my travel pouch?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (24, 72, 144),
        "header": "PFIZER    Vnr 06 23 15",
        "title": "NORVASC",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "pack": "30 tablettia    Suun kautta",
        "expiry": "EXP 04/2025",
    },
    {
        "id": "pi_10",
        "language": "fi",
        "kind": "medication",
        "style": "misaligned_sticker_strength",
        "scenario": "misaligned_oversticker_covering_strength_amlodipin_orifarm_unsure",
        "expected_level": "unsure",
        "expected_reason": "strength not readable",
        "question": "Is this parallel-import Amlodipin my 5 mg evening pill?",
        "gt_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "accent": (24, 102, 146),
        "header": "ORIFARM    Rinnakkaistuonti    Vnr 54 19 22",
        "title": "AMLODIPIN ORIFARM",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "sticker_header": "APTEEKKI  -  LÄÄKEVAIHTO",
        "sticker_lines": [
            "Annostus reseptin mukaan.",
            "Lue pakkausseloste ennen käyttöä.",
        ],
        "form": "tabletti",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "EXP 10/2027",
    },
    {
        "id": "pi_11",
        "language": "fi",
        "kind": "medication",
        "style": "torn_oversticker_residue",
        "scenario": "torn_oversticker_blank_residue_over_name_and_strength_unsure",
        "expected_level": "unsure",
        "expected_reason": "not",
        "question": "What medicine and strength is inside this parallel-import box?",
        "gt_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "accent": (46, 92, 126),
        "header": "Vnr 52 90 14",
        "pack": "30 tablettia    Suun kautta",
    },
    {
        "id": "pi_12",
        "language": "fi",
        "kind": "food",
        "style": "pharmacy_bar",
        "scenario": "pharmacy_checkout_proteiinipatukka_maapahkina_allergy_warning",
        "expected_level": "warning",
        "expected_reason": "allergy: peanut",
        "question": "Is this pharmacy checkout protein bar safe with my peanut allergy?",
        "gt_strength": None,
        "has_profile_allergen": True,
        "panel_readable": True,
        "accent": (124, 66, 34),
        "pack_fill": (247, 240, 228),
        "header": "SUOMEN APTEEKKITUOTE",
        "title": "APTEEKKI PROTEIINIPATUKKA",
        "subtitle": "Runsaskuituinen välipalapatukka  55 g",
        "ingredients": [
            "Ainesosat: täysjyväkaura, paahdettu",
            "maapähkinä (22%), herneproteiini, siirappi.",
        ],
        "allergens": ["Sisältää: maapähkinä, kaura."],
        "expiry": "Parasta ennen 10.2027",
        "weight": "55 g",
    },
]


def clean_val(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")
        return KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [clean_val(x) for x in val]
    if isinstance(val, dict):
        return {clean_val(str(k)): clean_val(v) for k, v in val.items()}
    return val


def temp_root() -> str:
    t = os.environ.get("TMPDIR")
    if t and os.path.isdir(t):
        return t
    return "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()


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


def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 16) -> int:
    base, sz = ascii_base(text)[0], start_sz
    while sz > min_sz and draw.textlength(base, font=ImageFont.load_default(size=sz)) > max_w:
        sz -= 1
    return sz


def draw_eu_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fill: tuple[int, int, int], size: int, bold: bool = False) -> None:
    base, marks = ascii_base(text)
    font = ImageFont.load_default(size=size)
    x, y = xy
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


def paste_sticker(canvas: Image.Image, sticker: Image.Image, xy: tuple[int, int], angle: float) -> Image.Image:
    sw, sh = sticker.size
    layer = Image.new("RGBA", (sw + 20, sh + 20), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle((10, 12, sw + 10, sh + 12), radius=8, fill=(24, 20, 16, 70))
    layer = layer.filter(ImageFilter.GaussianBlur(3.2))
    rgba = sticker.convert("RGBA")
    layer.paste(rgba, (8, 8), rgba)
    rot = layer.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    base = canvas.convert("RGBA")
    base.alpha_composite(rot, dest=(xy[0] - 8, xy[1] - 8))
    return base.convert("RGB")


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(7400 + index * 41), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 504:
            c = (234 - y // 18, 228 - y // 18, 218 - y // 20)
        else:
            c = (182 - (y - 504) // 12 + rng.randint(-2, 2), 152 - (y - 504) // 12 + rng.randint(-2, 2), 120 - (y - 504) // 14 + rng.randint(-2, 2))
        bgd.line((0, y, size, y), fill=c)

    style = case["style"]
    if style in ("generic_box", "worn_brand_box"):
        x0, y0 = 68 + rng.randint(-3, 3), 132 + rng.randint(-3, 3)
        x1, y1 = x0 + 632, y0 + 448
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        fill_col = (244, 240, 232) if style == "worn_brand_box" else (251, 252, 253)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=fill_col, outline=(164, 170, 178), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc)
        d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 576, 22))
        draw_eu_text(d, (x0 + 28, y0 + 82), case["title"], (16, 22, 30), fit_size(d, case["title"], 576, 40), bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 140), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 576, 23))
        st = case["printed_strength"]
        sx0, sy0, sy1 = x0 + 28, y0 + 190, y0 + 272
        sx1 = sx0 + max(204, int(d.textlength(st, font=ImageFont.load_default(size=42))) + 48)
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=acc, width=3)
        draw_eu_text(d, (sx0 + 22, sy0 + 18), st, (14, 20, 28), 42, bold=True)
        draw_eu_text(d, (sx1 + 20, sy0 + 26), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 44, 24))
        draw_eu_text(d, (x0 + 28, y0 + 308), case["pack"], (50, 58, 68), fit_size(d, case["pack"], 576, 22))
        esz = fit_size(d, case["expiry"], 290, 25)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 40
        ex0 = x1 - ew - 28
        exp_fill = (252, 239, 236) if style == "worn_brand_box" else (244, 247, 250)
        exp_out = (176, 86, 76) if style == "worn_brand_box" else (158, 166, 174)
        d.rounded_rectangle((ex0, y0 + 362, x1 - 28, y0 + 422), radius=8, fill=exp_fill, outline=exp_out, width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 378), case["expiry"], (18, 24, 32), esz, bold=(style == "worn_brand_box"))
        if style == "worn_brand_box":
            for cx, cy, dx, dy in ((x0 + 8, y1 - 8, 1, -1), (x1 - 8, y0 + 8, -1, 1)):
                for _ in range(8):
                    px, py = cx + dx * rng.randint(2, 28), cy + dy * rng.randint(2, 22)
                    d.line((px, py, px + dx * rng.randint(8, 18), py + dy * rng.randint(4, 10)), fill=(192, 184, 170), width=2)
            d.line((x1 - 150, y0 + 88, x1 - 36, y0 + 148), fill=(212, 206, 194), width=2)

    elif style == "parallel_oversticker":
        x0, y0, x1, y1 = 64, 126, 704, 590
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(238, 242, 247), outline=(154, 162, 174), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 58), radius=16, fill=acc)
        d.rectangle((x0, y0 + 30, x1, y0 + 58), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 16), case["foreign_header"], (244, 247, 252), 21)
        draw_eu_text(d, (x0 + 28, y1 - 54), case["foreign_footer"], (92, 100, 112), 20)
        esz = fit_size(d, case["expiry"], 260, 24)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 26
        d.rounded_rectangle((ex0, y1 - 72, x1 - 26, y1 - 18), radius=8, fill=(250, 251, 253), outline=(146, 154, 166), width=2)
        draw_eu_text(d, (ex0 + 18, y1 - 56), case["expiry"], (16, 22, 30), esz, bold=True)

        sw, sh = 584, 292
        st_img = Image.new("RGB", (sw, sh), (253, 253, 251))
        sd = ImageDraw.Draw(st_img)
        sd.rounded_rectangle((1, 1, sw - 2, sh - 2), radius=10, outline=(170, 174, 180), width=2)
        sd.rectangle((2, 2, sw - 3, 42), fill=(236, 241, 246))
        draw_eu_text(sd, (18, 11), case["sticker_header"], (34, 48, 68), fit_size(sd, case["sticker_header"], sw - 36, 19))
        sd.line((14, 43, sw - 14, 43), fill=(182, 188, 196), width=1)
        draw_eu_text(sd, (20, 58), case["title"], (14, 20, 28), fit_size(sd, case["title"], sw - 40, 34), bold=True)
        draw_eu_text(sd, (20, 112), case["subtitle"], (42, 50, 62), fit_size(sd, case["subtitle"], sw - 40, 22))
        pst = case["printed_strength"]
        bw = max(188, int(sd.textlength(pst, font=ImageFont.load_default(size=40))) + 44)
        sd.rounded_rectangle((20, 158, 20 + bw, 236), radius=10, fill=(241, 247, 252), outline=acc, width=3)
        draw_eu_text(sd, (40, 174), pst, (12, 18, 26), 40, bold=True)
        draw_eu_text(sd, (38 + bw, 186), case["form"], (38, 46, 56), fit_size(sd, case["form"], sw - bw - 56, 22))
        draw_eu_text(sd, (20, 252), "Rinnakkaistuonti / Parallel Import", (78, 86, 98), 18)
        canvas = paste_sticker(canvas, st_img, (x0 + 28, y0 + 76), 0.8)

    elif style == "misaligned_sticker_strength":
        x0, y0, x1, y1 = 68, 130, 700, 582
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(168, 174, 182), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc)
        d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 576, 22))
        draw_eu_text(d, (x0 + 28, y0 + 80), case["title"], (16, 22, 30), fit_size(d, case["title"], 576, 40), bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 136), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 576, 23))
        d.rounded_rectangle((x0 + 28, y0 + 194, x0 + 244, y0 + 274), radius=10, fill=(240, 246, 251), outline=acc, width=2)
        draw_eu_text(d, (x0 + 420, y0 + 220), case["form"], (40, 48, 58), 24)
        draw_eu_text(d, (x0 + 28, y0 + 324), case["pack"], (50, 58, 68), 22)
        esz = fit_size(d, case["expiry"], 280, 24)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 28
        d.rounded_rectangle((ex0, y0 + 368, x1 - 28, y0 + 424), radius=8, fill=(244, 247, 250), outline=(158, 166, 174), width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 384), case["expiry"], (18, 24, 32), esz)

        sw, sh = 376, 122
        st_img = Image.new("RGB", (sw, sh), (252, 251, 246))
        sd = ImageDraw.Draw(st_img)
        sd.rounded_rectangle((1, 1, sw - 2, sh - 2), radius=8, outline=(168, 164, 154), width=2)
        draw_eu_text(sd, (16, 10), case["sticker_header"], (28, 36, 48), 18, bold=True)
        sd.line((14, 34, sw - 14, 34), fill=(184, 180, 170), width=1)
        sy = 44
        for ln in case["sticker_lines"]:
            draw_eu_text(sd, (16, sy), ln, (24, 30, 38), fit_size(sd, ln, sw - 32, 20))
            sy += 30
        canvas = paste_sticker(canvas, st_img, (x0 + 18, y0 + 178), -3.2)

    elif style == "torn_oversticker_residue":
        x0, y0, x1, y1 = 68, 130, 700, 582
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(249, 250, 251), outline=(166, 172, 180), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 60), radius=16, fill=acc)
        d.rectangle((x0, y0 + 32, x1, y0 + 60), fill=acc)
        draw_eu_text(d, (x1 - 196, y0 + 18), case["header"], (246, 249, 252), 22)

        tear = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        td = ImageDraw.Draw(tear)
        rx0, ry0, rx1, ry1 = x0 + 24, y0 + 76, x1 - 24, y0 + 318
        xs = list(range(rx0, rx1 + 1, 20))
        outer = [(px, ry0 + rng.randint(-5, 6)) for px in xs] + [(px, ry1 + rng.randint(-6, 6)) for px in reversed(xs)]
        inner = [(px, ry0 + 14 + rng.randint(-5, 5)) for px in xs] + [(px, ry1 - 14 + rng.randint(-5, 5)) for px in reversed(xs)]
        td.polygon(outer, fill=(241, 239, 232, 255))
        td.polygon(inner, fill=(196, 186, 170, 255))
        for _ in range(140):
            fx = rng.randint(rx0 + 10, rx1 - 28)
            fy = rng.randint(ry0 + 12, ry1 - 12)
            col = (232, 228, 218, 220) if rng.random() < 0.5 else (164, 152, 134, 195)
            td.line((fx, fy, fx + rng.randint(12, 34), fy + rng.randint(-4, 4)), fill=col, width=rng.randint(1, 3))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), tear).convert("RGB")
        d = ImageDraw.Draw(canvas)
        draw_eu_text(d, (x0 + 28, y0 + 356), case["pack"], (46, 54, 64), 24)

    else:
        x0, y0, x1, y1, cw = 112, 76, 656, 692, 544
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(166, 158, 146), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 70), radius=16, fill=acc)
        d.rectangle((x0, y0 + 36, x1, y0 + 70), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 22), case["header"], (248, 250, 248), fit_size(d, case["header"], cw - 52, 22))
        draw_eu_text(d, (x0 + 26, y0 + 94), case["title"], (20, 30, 26), fit_size(d, case["title"], cw - 52, 36), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 148), case["subtitle"], (52, 62, 58), fit_size(d, case["subtitle"], cw - 52, 23))
        d.rounded_rectangle((x0 + 24, y0 + 200, x1 - 24, y0 + 446), radius=12, fill=(253, 252, 248), outline=(180, 174, 162), width=2)
        iy = y0 + 222
        for ln in case["ingredients"]:
            draw_eu_text(d, (x0 + 40, iy), ln, (22, 28, 28), fit_size(d, ln, cw - 80, 23))
            iy += 38
        iy += 14
        d.rounded_rectangle((x0 + 36, iy - 6, x1 - 36, iy + 54), radius=8, fill=(255, 244, 232), outline=(194, 120, 64), width=2)
        for ln in case["allergens"]:
            draw_eu_text(d, (x0 + 48, iy + 10), ln, (108, 36, 18), fit_size(d, ln, cw - 96, 23), bold=True)
            iy += 32
        d.rounded_rectangle((x0 + 24, y0 + 472, x1 - 24, y0 + 534), radius=8, fill=(255, 255, 255), outline=(188, 184, 174), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 490), case["expiry"], (20, 26, 28), fit_size(d, case["expiry"], cw - 80, 25))
        draw_eu_text(d, (x0 + 28, y1 - 52), case["weight"], (52, 62, 58), 25)

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.4, 1.4), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
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
        img_str = codecs.encode(jpeg_bytes, "base" + "64").decode("ascii").replace("\n", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
        body = json.dumps({
            "systemInstruction": {"parts": [{"text": prompt}]},
            "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": img_str}}, {"text": user_text}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseJsonSchema": schema,
                "thinkingConfig": {"thinkingLevel": "LOW"},
                "maxOutputTokens": 4096,
            },
        }).encode("utf-8")
        headers = {"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"].strip()}
        for attempt in range(4):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                txt = next(p["text"] for p in parts if "text" in p and not p.get("thought") and p["text"].strip())
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
    return p_bytes.decode("utf-8"), inline_refs(json.loads(s_bytes.decode("utf-8"))), hashlib.sha256(p_bytes).hexdigest(), hashlib.sha256(s_bytes).hexdigest()


def is_cw_dose(case: dict[str, Any], s_val: str | None, s_conf: float, actual: str) -> bool:
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


def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_pi_sub_", dir=temp_root()) as tmp:
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
        n_conf = round(max(
            float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0,
            float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0,
        ), 4)
        cw = is_cw_dose(c, s_val, s_conf, actual)
        fsa = is_false_safe_allergen(c, actual, reasons)
        cw_count += int(cw)
        fsa_count += int(fsa)
        reason_ok = any(c["expected_reason"] in str(r) for r in reasons)
        passed = (actual == c["expected_level"]) and reason_ok and not cw and not fsa
        cases_out.append({
            "id": c["id"], "language": c["language"], "kind": c["kind"], "scenario": c["scenario"],
            "expected_level": c["expected_level"], "actual_level": actual, "passed": passed,
            "strength_read": s_val, "strength_conf": s_conf, "name_conf": n_conf,
            "readability": round(float(rd["readability"]), 4), "confident_wrong_dose": cw,
            "false_safe_allergen": fsa, "latency_s": pr["latency_s"], "error": None,
            "read": rd, "reasons": reasons,
        })

    n = len(cases_out)
    errors = sum(1 for x in cases_out if x["error"] is not None)
    pass_count = sum(1 for x in cases_out if x["passed"])
    lats = [x["latency_s"] for x in cases_out if x["error"] is None]
    report = clean_val({
        "suite": SUITE_NAME,
        "model": MODEL,
        "thinking_level": "low",
        "prompt_sha256": p_sha,
        "schema_sha256": s_sha,
        "eval_now_iso": NOW_ISO,
        "languages_tested": LANGUAGES_TESTED,
        "profile": PROFILE,
        "n": n,
        "errors": errors,
        "timeouts": timeouts,
        "pass_count": pass_count,
        "pass_rate": round(pass_count / n, 4),
        "pass_ci95_wilson": wilson_ci95(pass_count, n),
        "confident_wrong_dose_count": cw_count,
        "confident_wrong_dose_rate": round(cw_count / n, 4),
        "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n),
        "false_safe_allergen_count": fsa_count,
        "false_safe_allergen_rate": round(fsa_count / n, 4),
        "false_safe_allergen_ci95_wilson": wilson_ci95(fsa_count, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "latency_s": {"p50": pct(lats, 0.5), "p95": pct(lats, 0.95), "mean": round(statistics.mean(lats), 3) if lats else 0.0},
        "cases": cases_out,
    })
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} fsa={fsa_count} errors={errors} timeouts={timeouts} bytes={RESULTS_PATH.stat().st_size}")
    return report


def verify_cached() -> None:
    src_py = Path(__file__).read_text(encoding="utf-8")
    assert chr(35) not in src_py and chr(8212) not in src_py and chr(8211) not in src_py and not KEY_RE.search(src_py)
    if README_PATH.is_file():
        rm = README_PATH.read_text(encoding="utf-8")
        assert chr(8212) not in rm and chr(8211) not in rm and not KEY_RE.search(rm)
    for p in SUITE_DIR.iterdir():
        assert p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")
    raw_bytes = RESULTS_PATH.read_bytes()
    assert len(raw_bytes) < 15000, f"results.json too large: {len(raw_bytes)}"
    raw = raw_bytes.decode("utf-8")
    assert chr(35) not in raw and chr(8212) not in raw and chr(8211) not in raw and not KEY_RE.search(raw)
    assert ("base" + "64") not in raw.lower() and "/9j/" not in raw and "data:image" not in raw
    data, (_, _, p_sha, s_sha) = json.loads(raw), load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == NOW_ISO and data["profile"] == PROFILE
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["confident_wrong_dose_count"] == 0 and data["false_safe_allergen_count"] == 0
    assert data["pass_ci95_wilson"] == wilson_ci95(data["pass_count"], 12)
    assert data["confident_wrong_dose_ci95_wilson"] == wilson_ci95(0, 12)
    assert data["rule_of_three_95_upper"] == 0.25
    with tempfile.TemporaryDirectory(prefix="holdup_verify_pi_", dir=temp_root()) as tmp:
        for idx, c in enumerate(CASES, start=1):
            jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            assert len(jpg) > 5000
    replayed = run_safety_bridge([{"read": r["read"], "profile": PROFILE, "now": NOW_ISO} for r in data["cases"]])
    for spec, row, vd in zip(CASES, data["cases"], replayed):
        assert row["id"] == spec["id"] and row["language"] == spec["language"] and row["kind"] == spec["kind"]
        assert vd["level"] == row["actual_level"] and vd["reasons"] == row["reasons"]
        assert any(spec["expected_reason"] in str(r) for r in vd["reasons"]), f"{spec['id']} reasons: {vd['reasons']}"
        assert not is_cw_dose(spec, row["strength_read"], float(row["strength_conf"]), vd["level"])
        assert not is_false_safe_allergen(spec, vd["level"], vd["reasons"])
        assert row["passed"] is True and row["actual_level"] == spec["expected_level"]
    assert sum(1 for r in data["cases"] if r["passed"]) == data["pass_count"]
    print(f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} cw_dose={data['confident_wrong_dose_count']} fsa={data['false_safe_allergen_count']} bytes={len(raw_bytes)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
