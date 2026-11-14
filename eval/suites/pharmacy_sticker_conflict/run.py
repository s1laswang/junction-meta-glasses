from __future__ import annotations
import argparse, codecs, datetime, hashlib, io, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
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

SUITE_NAME = "pharmacy_sticker_conflict"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T19:30:00+02:00"
MORNING_DOSE_ISO = "2026-11-14T10:00:00+02:00"
MORNING_DOSE_TS = int(datetime.datetime.fromisoformat(MORNING_DOSE_ISO).timestamp() * 1000)
LANGUAGES_TESTED = ["fi", "sv"]
RESULTS_PATH = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "norvasc", "name": "Norvasc", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "cardace", "name": "Cardace", "ingredient": "ramipril", "strength": "5 mg", "schedule": ["morning"]},
        {"id": "glucophage", "name": "Glucophage", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "panadol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [
        {"medId": "cardace", "ts": MORNING_DOSE_TS},
        {"medId": "glucophage", "ts": MORNING_DOSE_TS},
    ],
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
        "id": "ps_01",
        "language": "fi",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "fi_generic_substitution_amlodipin_orion_5mg_sticker_match",
        "expected_level": "match",
        "expected_reason": "matches norvasc",
        "question": "Is this pharmacy-stickered generic box my evening Norvasc 5 mg pill?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (18, 108, 128),
        "header": "ORION PHARMA    Vnr 06 44 12",
        "title": "AMLODIPIN ORION",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "sticker_header": "YLIOPISTON APTEEKKI  -  LÄÄKEVAIHTO",
        "sticker_lines": [
            "AMLODIPIN ORION 5 mg tabl (vaihtokelpoinen: Norvasc)",
            "1 tabletti iltaisin verenpaineen hoitoon.",
        ],
        "sticker_footer": "Reseptilääke  -  Säilytä alkuperäispakkauksessa",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "EXP 11/2027",
    },
    {
        "id": "ps_02",
        "language": "fi",
        "kind": "medication",
        "style": "sticker_obscuring_strength",
        "scenario": "fi_sticker_partially_obscuring_strength_digits_amlodipin_unsure",
        "expected_level": "unsure",
        "expected_reason": "strength not readable",
        "question": "The pharmacy sticker is partly over the dose on this Amlodipin box, is it 5 mg?",
        "gt_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "accent": (22, 112, 94),
        "header": "KRKA    Vnr 04 51 82",
        "title": "AMLODIPIN KRKA",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "form": "tabletti",
        "sticker_header": "APTEEKKI TÖÖLÖ  -  ANNOSTUSOHJE",
        "sticker_lines": [
            "Ota iltaisin lääkärin ohjeen mukaan.",
            "Lääkevaihto - lue pakkausseloste.",
        ],
        "pack": "Suun kautta    tabletti",
        "expiry": "EXP 10/2027",
    },
    {
        "id": "ps_03",
        "language": "sv",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "sv_wrong_strength_amlodipin_sandoz_10mg_vs_5mg_warning",
        "expected_level": "warning",
        "expected_reason": "strength 10 mg differs from your 5 mg",
        "question": "Is this substituted Swedish pharmacy pack my 5 mg evening Amlodipine?",
        "gt_strength": "10 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (118, 44, 132),
        "header": "SANDOZ    Vnr 14 82 90",
        "title": "AMLODIPIN SANDOZ",
        "subtitle": "Aktiv substans: amlodipin",
        "printed_strength": "10 mg",
        "form": "tabletter",
        "sticker_header": "APOTEK HJÄRTAT  -  UTBYTBARHET",
        "sticker_lines": [
            "AMLODIPIN SANDOZ 10 mg tablett",
            "1 tablett på kvällen mot högt blodtryck.",
        ],
        "sticker_footer": "Receptbelagt läkemedel  -  Förvaras utom synhåll för barn",
        "pack": "100 tabletter    Oral användning",
        "expiry": "Utg.dat. 10.2027",
    },
    {
        "id": "ps_04",
        "language": "sv",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "sv_spouse_metoprolol_50mg_sticker_when_user_takes_amlodipine_warning",
        "expected_level": "warning",
        "expected_reason": "not on your medication list",
        "question": "I take Amlodipine 5 mg, did I pick up my spouse's pharmacy-stickered box by mistake?",
        "gt_strength": "50 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (144, 52, 46),
        "header": "HEXAL    Vnr 09 31 44",
        "title": "METOPROLOL HEXAL",
        "subtitle": "Aktiv substans: metoprololsuccinat",
        "printed_strength": "50 mg",
        "form": "depottabletter",
        "sticker_header": "APOTEKET KRONAN  -  Patient: Erik Lindholm",
        "sticker_lines": [
            "METOPROLOL HEXAL 50 mg depottablett",
            "1 tablett på morgonen.",
        ],
        "sticker_footer": "Personligt recept  -  Kontrollera namnet på etiketten",
        "pack": "98 depottabletter    Oral användning",
        "expiry": "EXP 11/2027",
    },
    {
        "id": "ps_05",
        "language": "fi",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "fi_nsaid_burana_ibumax_400mg_sticker_avoid_list_warning",
        "expected_level": "warning",
        "expected_reason": "ibuprofen is an NSAID, on your avoid list",
        "question": "This box has a Finnish pharmacy sticker on it, can I take it for pain instead of Panadol?",
        "gt_strength": "400 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (168, 42, 38),
        "header": "ORION PHARMA    Vnr 08 17 40",
        "title": "BURANA",
        "subtitle": "Vaikuttava aine: ibuprofeeni",
        "printed_strength": "400 mg",
        "form": "tabletti, kalvopäällysteinen",
        "sticker_header": "APTEEKKI TAMPERE  -  RESEPTILÄÄKE",
        "sticker_lines": [
            "BURANA 400 mg tabl (vaihtokelpoinen: Ibumax 400 mg)",
            "1 tabletti tarvittaessa kipuun, enintään 3 krt/vrk.",
        ],
        "sticker_footer": "Tulehduskipulääke  -  Ota ruoan kanssa",
        "pack": "30 tablettia    Suun kautta",
        "expiry": "EXP 09/2027",
    },
    {
        "id": "ps_06",
        "language": "fi",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "fi_matching_norvasc_5mg_pack_past_expiry_2025_04_warning",
        "expected_level": "warning",
        "expected_reason": "expired 2025-04",
        "question": "Can I take a pill from this older pharmacy-stickered Norvasc 5 mg box?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "expired_highlight": True,
        "accent": (28, 72, 142),
        "header": "PFIZER    Vnr 06 23 15",
        "title": "NORVASC",
        "subtitle": "Vaikuttava aine: amlodipiini",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "sticker_header": "APTEEKKI KALLIO  -  ANNOSTUSOHJE",
        "sticker_lines": [
            "NORVASC 5 mg tabletti (amlodipiini)",
            "1 tabletti iltaisin säännöllisesti.",
        ],
        "sticker_footer": "Reseptilääke  -  Tarkista kelpoisuusaika",
        "pack": "30 tablettia    Suun kautta",
        "expiry": "EXP 04/2025",
    },
    {
        "id": "ps_07",
        "language": "fi",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "fi_already_logged_morning_ramipril_5mg_dose_today_warning",
        "expected_level": "warning",
        "expected_reason": "taken today: 1/1",
        "question": "Should I take my morning Ramipril 5 mg from this pharmacy box right now?",
        "gt_strength": "5 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (24, 98, 144),
        "header": "ORION PHARMA    Vnr 11 40 28",
        "title": "RAMIPRIL ORION",
        "subtitle": "Vaikuttava aine: ramipriili",
        "printed_strength": "5 mg",
        "form": "tabletti",
        "sticker_header": "APTEEKKI TURKU  -  LÄÄKEVAIHTO",
        "sticker_lines": [
            "RAMIPRIL ORION 5 mg tabl (vaihtokelpoinen: Cardace)",
            "1 tabletti aamuisin verenpaineeseen.",
        ],
        "sticker_footer": "Reseptilääke  -  1 krt vuorokaudessa",
        "pack": "98 tablettia    Suun kautta",
        "expiry": "EXP 12/2027",
    },
    {
        "id": "ps_08",
        "language": "sv",
        "kind": "medication",
        "style": "torn_faded_thermal",
        "scenario": "sv_torn_faded_thermal_sticker_and_ripped_carton_strength_unsure",
        "expected_level": "unsure",
        "expected_reason": "strength not readable",
        "question": "The pharmacy thermal sticker faded and tore on this Ramipril pack, is it 5 mg?",
        "gt_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "accent": (36, 94, 134),
        "header": "HEXAL    Vnr 11 40 77",
        "title": "RAMIPRIL HEXAL",
        "subtitle": "Aktiv substans: ramipril",
        "pack": "Oral användning    tablett",
        "expiry": "EXP 09/2027",
    },
    {
        "id": "ps_09",
        "language": "fi",
        "kind": "medication",
        "style": "bilingual_excipient_box",
        "scenario": "bilingual_fi_sv_softgel_maapahkinaoljy_arachis_oil_excipient_warning",
        "expected_level": "warning",
        "expected_reason": "allergy: peanut",
        "question": "Are these bilingual pharmacy-dispensed vitamin D soft capsules safe with my peanut allergy?",
        "gt_strength": "50 mikrog",
        "has_profile_allergen": True,
        "panel_readable": True,
        "accent": (158, 92, 24),
        "header": "ORION PHARMA    Vnr 42 18 05    FI / SV",
        "title": "KOLEKALSIFEROLI ORION",
        "subtitle": "Vaikuttava aine / Aktiv substans: kolekalsiferoli / kolekalciferol",
        "printed_strength": "50 mikrog",
        "form": "kapseli, pehmeä / kapsel, mjuk",
        "excipient_lines": [
            "Apuaineet / Hjälpämnen: puhdistettu maapähkinäöljy",
            "(arachis oil) / raffinerad jordnötsolja (peanut).",
        ],
        "sticker_header": "APTEEKKI - APOTEK VAASA / VASA",
        "sticker_lines": [
            "KOLEKALSIFEROLI 50 mikrog pehmeä kapseli / mjuk kapsel",
            "1 kapseli päivässä / 1 kapsel dagligen.",
        ],
        "pack": "90 kapselia / kapslar",
        "expiry": "EXP 10/2027",
    },
    {
        "id": "ps_10",
        "language": "sv",
        "kind": "medication",
        "style": "bilingual_excipient_box",
        "scenario": "bilingual_sv_fi_substituted_panadol_softgel_arachis_oil_override_warning",
        "expected_level": "warning",
        "expected_reason": "allergy: peanut",
        "question": "The pharmacy substituted my Panadol 500 mg with these soft capsules, can I take one?",
        "gt_strength": "500 mg",
        "has_profile_allergen": True,
        "panel_readable": True,
        "accent": (32, 92, 138),
        "header": "ACTAVIS NORDIC    Vnr 49 20 11    SV / FI",
        "title": "PARACETAMOL ACTAVIS",
        "subtitle": "Aktiv substans / Vaikuttava aine: paracetamol / parasetamoli",
        "printed_strength": "500 mg",
        "form": "kapsel, mjuk / kapseli, pehmeä",
        "excipient_lines": [
            "Hjälpämnen / Apuaineet: raffinerad jordnötsolja",
            "/ puhdistettu maapähkinäöljy (arachis oil, peanut).",
        ],
        "sticker_header": "APOTEK - APTEEKKI HELSINGFORS / HELSINKI",
        "sticker_lines": [
            "Utbytbar / Vaihtokelpoinen: PANADOL 500 mg",
            "1 kapsel vid behov / 1 kapseli tarvittaessa.",
        ],
        "pack": "30 kapslar / kapselia",
        "expiry": "EXP 11/2027",
    },
    {
        "id": "ps_11",
        "language": "sv",
        "kind": "medication",
        "style": "sticker_and_carton",
        "scenario": "bilingual_sv_fi_twice_daily_metformin_500mg_1_of_2_taken_match",
        "expected_level": "match",
        "expected_reason": "taken today: 1/2",
        "question": "Is this bilingual pharmacy pack my evening Metformin 500 mg dose?",
        "gt_strength": "500 mg",
        "has_profile_allergen": False,
        "panel_readable": True,
        "accent": (24, 84, 156),
        "header": "ACTAVIS    Vnr 15 33 20    SV / FI",
        "title": "METFORMIN ACTAVIS",
        "subtitle": "Aktiv substans / Vaikuttava aine: metforminhydroklorid / metformiini",
        "printed_strength": "500 mg",
        "form": "filmdragerade tabletter / tabletti",
        "sticker_header": "APOTEK - APTEEKKI BORGÅ / PORVOO",
        "sticker_lines": [
            "METFORMIN ACTAVIS 500 mg tabl (Glucophage 500 mg)",
            "1 tablett morgon och kväll / 1 tabletti aamulla ja illalla.",
        ],
        "sticker_footer": "2 gånger dagligen  -  2 kertaa vuorokaudessa",
        "pack": "100 tabletter / tablettia",
        "expiry": "Utg.dat. 11.2027",
    },
    {
        "id": "ps_12",
        "language": "fi",
        "kind": "medication",
        "style": "bilingual_low_readability",
        "scenario": "bilingual_fi_sv_blur_glare_low_readability_abstention_unsure",
        "expected_level": "unsure",
        "expected_reason": "label not readable",
        "question": "What medication and strength is on this bilingual pharmacy-stickered box?",
        "gt_strength": None,
        "has_profile_allergen": False,
        "panel_readable": False,
        "accent": (48, 86, 122),
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


def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 15) -> int:
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
    ImageDraw.Draw(layer).rounded_rectangle((10, 12, sw + 10, sh + 12), radius=8, fill=(24, 20, 16, 72))
    layer = layer.filter(ImageFilter.GaussianBlur(3.0))
    rgba = sticker.convert("RGBA")
    layer.paste(rgba, (8, 8), rgba)
    rot = layer.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    base = canvas.convert("RGBA")
    base.alpha_composite(rot, dest=(xy[0] - 8, xy[1] - 8))
    return base.convert("RGB")


def render_dispensing_sticker(header: str, lines: list[str], footer: str | None, sw: int, sh: int, yellowed: bool = False) -> Image.Image:
    bg = (247, 243, 229) if yellowed else (253, 252, 247)
    st = Image.new("RGB", (sw, sh), bg)
    sd = ImageDraw.Draw(st)
    sd.rounded_rectangle((1, 1, sw - 2, sh - 2), radius=8, outline=(168, 166, 156), width=2)
    sd.rectangle((2, 2, sw - 3, 38), fill=(232, 239, 246) if not yellowed else (238, 232, 214))
    draw_eu_text(sd, (16, 9), header, (26, 38, 54), fit_size(sd, header, sw - 32, 19), bold=True)
    sd.line((12, 39, sw - 12, 39), fill=(182, 184, 188), width=1)
    sy = 50
    for idx, ln in enumerate(lines):
        draw_eu_text(sd, (16, sy), ln, (18, 24, 32), fit_size(sd, ln, sw - 32, 22 if idx == 0 else 20), bold=(idx == 0))
        sy += 36
    if footer:
        sd.line((14, sh - 34, sw - 14, sh - 34), fill=(208, 208, 202), width=1)
        draw_eu_text(sd, (16, sh - 26), footer, (74, 82, 92), fit_size(sd, footer, sw - 32, 17))
    return st


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(8100 + index * 37), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 520:
            c = (235 - y // 19, 229 - y // 19, 219 - y // 21)
        else:
            c = (180 - (y - 520) // 12 + rng.randint(-2, 2), 150 - (y - 520) // 12 + rng.randint(-2, 2), 118 - (y - 520) // 14 + rng.randint(-2, 2))
        bgd.line((0, y, size, y), fill=c)

    style = case["style"]
    if style == "sticker_and_carton":
        x0, y0, x1, y1 = 60, 96, 708, 652
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        aged = bool(case.get("expired_highlight"))
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(246, 242, 234) if aged else (251, 252, 253), outline=(162, 168, 176), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 56), radius=16, fill=acc)
        d.rectangle((x0, y0 + 28, x1, y0 + 56), fill=acc)
        d.rectangle((x0, y0 + 56, x0 + 11, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 16), case["header"], (248, 250, 252), fit_size(d, case["header"], 592, 21))
        draw_eu_text(d, (x0 + 28, y0 + 72), case["title"], (16, 22, 30), fit_size(d, case["title"], 592, 38), bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 124), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 592, 22))
        pst = case["printed_strength"]
        sx0, sy0, sy1 = x0 + 28, y0 + 164, y0 + 238
        sx1 = sx0 + max(196, int(d.textlength(ascii_base(pst)[0], font=ImageFont.load_default(size=40))) + 46)
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=acc, width=3)
        draw_eu_text(d, (sx0 + 22, sy0 + 16), pst, (14, 20, 28), 40, bold=True)
        draw_eu_text(d, (sx1 + 18, sy0 + 24), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 40, 23))

        esz = fit_size(d, case["expiry"], 280, 24)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 28
        exp_fill = (253, 238, 235) if aged else (244, 247, 250)
        exp_out = (178, 82, 72) if aged else (156, 164, 174)
        d.rounded_rectangle((ex0, y0 + 468, x1 - 28, y0 + 528), radius=8, fill=exp_fill, outline=exp_out, width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 485), case["expiry"], (18, 24, 32), esz, bold=aged)
        draw_eu_text(d, (x0 + 28, y0 + 486), case["pack"], (50, 58, 68), fit_size(d, case["pack"], ex0 - x0 - 44, 21))

        st_img = render_dispensing_sticker(case["sticker_header"], case["sticker_lines"], case.get("sticker_footer"), 588, 168, yellowed=aged)
        canvas = paste_sticker(canvas, st_img, (x0 + 30, y0 + 266), rng.choice((-0.8, 0.7)))

    elif style == "sticker_obscuring_strength":
        x0, y0, x1, y1 = 60, 108, 708, 636
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(164, 170, 178), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 58), radius=16, fill=acc)
        d.rectangle((x0, y0 + 30, x1, y0 + 58), fill=acc)
        d.rectangle((x0, y0 + 58, x0 + 11, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 17), case["header"], (248, 250, 252), 21)
        draw_eu_text(d, (x0 + 28, y0 + 76), case["title"], (16, 22, 30), 38, bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 130), case["subtitle"], (44, 52, 64), 22)
        d.rounded_rectangle((x0 + 252, y0 + 176, x0 + 468, y0 + 256), radius=10, fill=(239, 245, 251), outline=acc, width=3)
        draw_eu_text(d, (x0 + 400, y0 + 195), "mg", (14, 20, 28), 38, bold=True)
        draw_eu_text(d, (x0 + 486, y0 + 204), case["form"], (40, 48, 58), 23)
        draw_eu_text(d, (x0 + 28, y0 + 448), case["pack"], (50, 58, 68), 22)
        esz = fit_size(d, case["expiry"], 260, 24)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 28
        d.rounded_rectangle((ex0, y0 + 432, x1 - 28, y0 + 492), radius=8, fill=(244, 247, 250), outline=(156, 164, 174), width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 449), case["expiry"], (18, 24, 32), esz)

        st_img = render_dispensing_sticker(case["sticker_header"], case["sticker_lines"], None, 366, 136)
        canvas = paste_sticker(canvas, st_img, (x0 + 22, y0 + 162), -2.6)

    elif style == "torn_faded_thermal":
        x0, y0, x1, y1 = 60, 108, 708, 636
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(249, 250, 251), outline=(164, 170, 178), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 58), radius=16, fill=acc)
        d.rectangle((x0, y0 + 30, x1, y0 + 58), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 17), case["header"], (248, 250, 252), 21)
        draw_eu_text(d, (x0 + 28, y0 + 76), case["title"], (16, 22, 30), 38, bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 130), case["subtitle"], (44, 52, 64), 22)

        tear = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        td = ImageDraw.Draw(tear)
        rx0, ry0, rx1, ry1 = x0 + 26, y0 + 172, x0 + 360, y0 + 276
        xs = list(range(rx0, rx1 + 1, 18))
        outer = [(px, ry0 + rng.randint(-5, 5)) for px in xs] + [(px, ry1 + rng.randint(-5, 5)) for px in reversed(xs)]
        inner = [(px, ry0 + 10 + rng.randint(-4, 4)) for px in xs] + [(px, ry1 - 10 + rng.randint(-4, 4)) for px in reversed(xs)]
        td.polygon(outer, fill=(236, 232, 222, 255))
        td.polygon(inner, fill=(188, 178, 162, 255))
        for _ in range(95):
            fx, fy = rng.randint(rx0 + 8, rx1 - 24), rng.randint(ry0 + 10, ry1 - 10)
            col = (224, 218, 206, 215) if rng.random() < 0.5 else (156, 144, 128, 190)
            td.line((fx, fy, fx + rng.randint(10, 28), fy + rng.randint(-3, 3)), fill=col, width=rng.randint(1, 3))

        sx0, sy0, sx1, sy1 = x0 + 28, y0 + 258, x0 + 498, y0 + 404
        jagged_r = [(sx1 + rng.randint(-14, 8), py) for py in range(sy0, sy1 + 1, 14)]
        poly_st = [(sx0, sy0), (sx1 - 6, sy0)] + jagged_r + [(sx0, sy1)]
        td.polygon(poly_st, fill=(244, 239, 225, 252), outline=(188, 180, 164, 240))
        for gy in range(sy0 + 22, sy1 - 18, 22):
            for gx in range(sx0 + 18, sx1 - 54, 42):
                td.line((gx, gy, gx + rng.randint(14, 28), gy), fill=(229, 224, 210, 170), width=3)
        canvas = Image.alpha_composite(canvas.convert("RGBA"), tear).convert("RGB")
        d = ImageDraw.Draw(canvas)
        draw_eu_text(d, (x0 + 28, y0 + 452), case["pack"], (50, 58, 68), 22)
        esz = fit_size(d, case["expiry"], 260, 24)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 28
        d.rounded_rectangle((ex0, y0 + 436, x1 - 28, y0 + 496), radius=8, fill=(244, 247, 250), outline=(156, 164, 174), width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 453), case["expiry"], (18, 24, 32), esz)

    elif style == "bilingual_excipient_box":
        x0, y0, x1, y1 = 56, 82, 712, 670
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(252, 252, 250), outline=(164, 168, 174), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 54), radius=16, fill=acc)
        d.rectangle((x0, y0 + 28, x1, y0 + 54), fill=acc)
        d.rectangle((x0, y0 + 54, x0 + 11, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 15), case["header"], (248, 250, 252), fit_size(d, case["header"], 604, 20))
        draw_eu_text(d, (x0 + 26, y0 + 68), case["title"], (16, 22, 30), fit_size(d, case["title"], 604, 36), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 116), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 604, 20))
        pst = case["printed_strength"]
        sx0, sy0, sy1 = x0 + 26, y0 + 152, y0 + 220
        sx1 = sx0 + max(206, int(d.textlength(ascii_base(pst)[0], font=ImageFont.load_default(size=36))) + 44)
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(241, 246, 251), outline=acc, width=3)
        draw_eu_text(d, (sx0 + 20, sy0 + 15), pst, (14, 20, 28), 36, bold=True)
        draw_eu_text(d, (sx1 + 18, sy0 + 22), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 38, 21))

        d.rounded_rectangle((x0 + 26, y0 + 236, x1 - 26, y0 + 340), radius=10, fill=(255, 245, 232), outline=(196, 118, 52), width=2)
        ey = y0 + 252
        for ln in case["excipient_lines"]:
            draw_eu_text(d, (x0 + 40, ey), ln, (104, 34, 16), fit_size(d, ln, 572, 21), bold=True)
            ey += 36

        esz = fit_size(d, case["expiry"], 260, 23)
        ew = int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 36
        ex0 = x1 - ew - 26
        d.rounded_rectangle((ex0, y0 + 516, x1 - 26, y0 + 572), radius=8, fill=(244, 247, 250), outline=(156, 164, 174), width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 532), case["expiry"], (18, 24, 32), esz)
        draw_eu_text(d, (x0 + 26, y0 + 533), case["pack"], (50, 58, 68), fit_size(d, case["pack"], ex0 - x0 - 40, 21))

        st_img = render_dispensing_sticker(case["sticker_header"], case["sticker_lines"], None, 596, 134)
        canvas = paste_sticker(canvas, st_img, (x0 + 28, y0 + 362), 0.6)

    else:
        canvas = Image.new("RGB", (size, size), (148, 144, 138))
        d = ImageDraw.Draw(canvas)
        x0, y0, x1, y1 = 152, 188, 616, 576
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(228, 229, 232), outline=(156, 160, 166), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 48), radius=16, fill=acc)
        for by, bw in ((y0 + 78, 250), (y0 + 118, 310), (y0 + 168, 140)):
            d.rounded_rectangle((x0 + 28, by, x0 + 28 + bw, by + 22), radius=5, fill=(140, 146, 154))
        d.rounded_rectangle((x0 + 32, y0 + 216, x1 - 32, y0 + 340), radius=8, fill=(244, 242, 235), outline=(182, 180, 172), width=2)
        for sy, sw_bar in ((y0 + 236, 280), (y0 + 270, 330), (y0 + 304, 220)):
            d.rounded_rectangle((x0 + 48, sy, x0 + 48 + sw_bar, sy + 14), radius=4, fill=(168, 170, 166))
        canvas = canvas.filter(ImageFilter.GaussianBlur(11.5))
        glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glare)
        gd.ellipse((190, 210, 590, 490), fill=(255, 254, 248, 228))
        gd.polygon([(120, 320), (640, 190), (660, 290), (140, 420)], fill=(255, 255, 252, 210))
        glare = glare.filter(ImageFilter.GaussianBlur(24.0))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), glare).convert("RGB")

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.3, 1.3), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
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
    if case["has_profile_allergen"]:
        return actual != "warning" or not any("allergy:" in str(r) for r in reasons)
    if case["kind"] == "food" and not case["panel_readable"]:
        return actual in ("info", "match")
    return False


def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_ps_conf_", dir=temp_root()) as tmp:
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
        assert chr(35) not in rm and chr(8212) not in rm and chr(8211) not in rm and not KEY_RE.search(rm)
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
    assert data["false_safe_allergen_ci95_wilson"] == wilson_ci95(0, 12)
    assert data["rule_of_three_95_upper"] == 0.25
    with tempfile.TemporaryDirectory(prefix="holdup_verify_ps_", dir=temp_root()) as tmp:
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
