import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import math
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SHM_ROOT = pathlib.Path("/dev/shm")
TMP_IMG_DIR = SHM_ROOT / "holdup_dm_spoof_compound"
if SHM_ROOT.is_dir():
    os.environ.setdefault("TMPDIR", str(SHM_ROOT))

for _nd in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_nd) and _nd not in os.environ.get("PATH", "").split(":"):
        _cp = os.environ.get("PATH", "")
        os.environ["PATH"] = f"{_nd}:{_cp}" if _cp else _nd

SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = "datamatrix_spoof_compound"
REPO = SUITE_DIR.parents[2]
OUT_JSON = SUITE_DIR / "results.json"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-15T09:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
MAX_WORKERS = 4
MAX_RESULTS_BYTES = 15360

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
DOC3 = chr(34) * 3
SQ3 = chr(39) * 3
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
GS_CHAR = "\x1d"
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{8,}")

FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

AML_GTIN = "09501101530003"
ATO_EAN13 = "6432100098767"
ATO_GTIN14 = "06432100098767"
MET_GTIN = "06432100012343"

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "aml", "name": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"], "gtin": AML_GTIN},
        {"id": "ato", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"], "barcode": ATO_EAN13},
        {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"], "gtin": MET_GTIN},
    ],
    "allergies": ["peanut", "tree nuts", "milk", "sesame", "crustacean", "mustard", "celery", "lupin", "sulphite"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ds_01",
        "category": "dm_verified_match",
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "match",
        "exp_agrees": True,
        "exp_str": "5 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"]d201{AML_GTIN}1728063010K4182{GS_CHAR}21SN8401",
        "desc": "Intact Amlodipin 5 mg carton with matching EU FMD GS1 DataMatrix GTIN and 2028-06 expiry",
        "accent": (20, 96, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "Amlodipin",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "pack": "98 tablets  1 tablet in the evening",
        "exp": "EXP 2028-06",
        "occlude": None,
        "tilt": -1.1,
    },
    {
        "id": "ds_02",
        "category": "dm_sleeve_swap_spoof",
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_agrees": False,
        "exp_str": "5 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){ATO_GTIN14}(17)280630(10)A902(21)SN5512",
        "desc": "Sleeve-swap spoof: printed Amlodipin 5 mg carton paired with saved Atorvastatin GS1 DataMatrix GTIN",
        "accent": (20, 96, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "Amlodipin",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "pack": "98 tablets  1 tablet in the evening",
        "exp": "EXP 2028-06",
        "occlude": None,
        "tilt": 1.2,
    },
    {
        "id": "ds_03",
        "category": "dm_unlisted_print_spoof",
        "food": False,
        "q": "Can I take this tablet?",
        "expected": "unsure",
        "exp_agrees": False,
        "exp_str": "400 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){AML_GTIN}(17)280630(10)B104(21)SN3319",
        "desc": "Unlisted Burana ibuprofen 400 mg carton paired with spoofed saved Amlodipin GS1 DataMatrix GTIN",
        "accent": (182, 34, 46),
        "bg": (252, 248, 248),
        "hdr": "ORION PHARMA",
        "title": "Burana",
        "sub": "Active ingredient: ibuprofen",
        "str": "400 mg",
        "pack": "30 tablets  For pain and fever",
        "exp": "EXP 2028-06",
        "occlude": None,
        "tilt": -1.3,
    },
    {
        "id": "ds_04",
        "category": "dm_expiry_month_mismatch",
        "food": False,
        "q": "Is this my Metformin?",
        "expected": "unsure",
        "exp_agrees": False,
        "exp_str": "500 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){MET_GTIN}(17)271100(10)M771(21)SN2098",
        "desc": "Printed EXP 2028-06 on Metformin 500 mg conflicts with GS1 DataMatrix expiry 2027-11",
        "accent": (32, 86, 158),
        "bg": (248, 250, 252),
        "hdr": "SANDOZ NORDIC",
        "title": "Metformin",
        "sub": "Active ingredient: metformin",
        "str": "500 mg",
        "pack": "100 tablets  Twice daily with meals",
        "exp": "EXP 2028-06",
        "occlude": None,
        "tilt": 1.1,
    },
    {
        "id": "ds_05",
        "category": "dm_expired_code_rescue",
        "food": False,
        "q": "Is this my evening cholesterol pill?",
        "expected": "warning",
        "exp_agrees": True,
        "exp_str": "20 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){ATO_GTIN14}(17)250400(10)A112(21)SN1104",
        "desc": "Atorvastatin 20 mg with rubbed-off printed expiry caught as expired 2025-04 via GS1 DataMatrix",
        "accent": (88, 52, 134),
        "bg": (250, 249, 252),
        "hdr": "ORION PHARMA",
        "title": "Atorvastatin",
        "sub": "Active ingredient: atorvastatin",
        "str": "20 mg",
        "pack": "98 tablets  1 tablet in the evening",
        "exp": None,
        "occlude": "scuffed_expiry",
        "tilt": -1.0,
    },
    {
        "id": "ds_06",
        "category": "dm_valid_code_expiry_rescue",
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "match",
        "exp_agrees": True,
        "exp_str": "5 mg",
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){AML_GTIN}(17)280630(10)K419(21)SN8821",
        "desc": "Amlodipin 5 mg with abraded printed expiry rescued to verified match via valid GS1 DataMatrix expiry",
        "accent": (20, 96, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "Amlodipin",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "pack": "98 tablets  1 tablet in the evening",
        "exp": None,
        "occlude": "scuffed_expiry",
        "tilt": 0.9,
    },
    {
        "id": "ds_07",
        "category": "dm_thumb_occluded_strength",
        "food": False,
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_agrees": True,
        "exp_str": None,
        "str_occluded": True,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": f"(01){AML_GTIN}(17)280630(10)K418(21)SN8409",
        "desc": "Thumb-occluded strength on Amlodipin remains unsure despite matching GS1 DataMatrix GTIN and expiry",
        "accent": (20, 96, 154),
        "bg": (249, 250, 252),
        "hdr": "ORION PHARMA",
        "title": "Amlodipin",
        "sub": "Active ingredient: amlodipine",
        "str": None,
        "pack": "98 tablets  1 tablet in the evening",
        "exp": "EXP 2028-06",
        "occlude": "thumb_strength",
        "tilt": -1.4,
    },
    {
        "id": "ds_08",
        "category": "nordic_compound_allergen_warning",
        "food": True,
        "q": "Is this snack bar safe with my nut, milk, and sesame allergies?",
        "expected": "warning",
        "exp_agrees": None,
        "exp_str": None,
        "str_occluded": False,
        "alg_present": True,
        "alg_occluded": False,
        "gs1_raw": None,
        "desc": "Finnish/Swedish nut-seed bar with hasselpahkina/hasselnot, manteli/mandel, hera/mjolk, seesami plus voi sisaltaa maapahkina",
        "accent": (112, 62, 34),
        "bg": (248, 244, 236),
        "hdr": "POHJOLA EVÄS  AINESOSAT / INGREDIENSER",
        "title": "PÄHKINÄ-SIEMENPATUKKA / NÖTBAR",
        "sub": "Välipalapatukka / Mellanmålsbar  60 g",
        "ing": [
            "Ainesosat: kaura, HASSELPÄHKINÄ (14 %), MANTELI (8 %),",
            "HERAPROTEIINI (MAITO), SEESAMINSIEMEN (5 %), hunaja.",
            "Ingredienser: havre, HASSELNÖT, MANDEL, VASSLE (MJÖLK), SESAM.",
        ],
        "alg": "Allergeenit: Voi sisältää MAAPÄHKINÄÄ / Kan innehålla JORDNÖT.",
        "exp": "Parasta ennen / Bäst före: 2027-10-15",
        "occlude": None,
        "tilt": -0.9,
    },
    {
        "id": "ds_09",
        "category": "nordic_compound_allergen_warning",
        "food": True,
        "q": "Can I eat this soup with my shellfish, mustard, celery, lupin, and sulphite allergies?",
        "expected": "warning",
        "exp_agrees": None,
        "exp_str": None,
        "str_occluded": False,
        "alg_present": True,
        "alg_occluded": False,
        "gs1_raw": None,
        "desc": "Finnish/Swedish Skagen soup with katkarapu, selleri, sinappi/senap, rikkidioksidi and voi sisaltaa lupiinia",
        "accent": (28, 92, 118),
        "bg": (246, 250, 252),
        "hdr": "SAARISTON HERKKU  TUOTESELOSTE / INNEHÅLL",
        "title": "SKAGENKEITTO / SKAGENSOPPA",
        "sub": "Äyriäiskeitto / Skaldjurssoppa  350 g",
        "ing": [
            "Ainesosat: vesi, KATKARAPU (18 %), SELLERI, SINAPPI,",
            "valkoviinietikka (RIKKIDIOKSIDI), rapsiöljy, tilli.",
            "Ingredienser: vatten, RÄKOR, SELLERI, SENAP, SVAVELDIOXID.",
        ],
        "alg": "Voi sisältää LUPIINIA / Kan innehålla spår av LUPIN.",
        "exp": "Parasta ennen / Bäst före: 2027-08-22",
        "occlude": None,
        "tilt": 1.0,
    },
    {
        "id": "ds_10",
        "category": "nordic_may_contain_warning",
        "food": True,
        "q": "Are these oat cookies safe with my peanut, tree nut, and sesame allergies?",
        "expected": "warning",
        "exp_agrees": None,
        "exp_str": None,
        "str_occluded": False,
        "alg_present": True,
        "alg_occluded": False,
        "gs1_raw": None,
        "desc": "Finnish/Swedish oat cookies with voi sisaltaa / kan innehalla traces of maapahkina/jordnot, hasselpahkina/hasselnot, seesami/sesam",
        "accent": (128, 82, 38),
        "bg": (249, 245, 238),
        "hdr": "NORDIC BAKEHOUSE  AINESOSAT / INGREDIENSER",
        "title": "KAURAKEKSI / HAVREKEX",
        "sub": "Rapea täysjyväkaurakeksi  200 g",
        "ing": [
            "Ainesosat: täysjyväkaura (68 %), rapsiöljy, ruokosokeri, suola.",
            "Ingredienser: fullkornshavre (68 %), rapsolja, rörsocker, salt.",
        ],
        "alg": "Voi sisältää MAAPÄHKINÄÄ, HASSELPÄHKINÄÄ, SEESAMIA / Kan innehålla JORDNÖT, HASSELNÖT, SESAM.",
        "exp": "Parasta ennen / Bäst före: 2027-11-30",
        "occlude": None,
        "tilt": -0.8,
    },
    {
        "id": "ds_11",
        "category": "nordic_safe_food_info",
        "food": True,
        "q": "Is this crispbread safe with my nut, milk, and sesame allergies?",
        "expected": "info",
        "exp_agrees": None,
        "exp_str": None,
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": False,
        "gs1_raw": None,
        "desc": "Sharp Finnish/Swedish rye-oat crispbread with complete gluten-only allergen panel passing 0.95/0.80 safe gate",
        "accent": (44, 102, 72),
        "bg": (246, 249, 244),
        "hdr": "POHJANMAA LEIPOMO  AINESOSAT / INGREDIENTS",
        "title": "RUIS-KAURANÄKKILEIPÄ / CRISPBREAD",
        "sub": "Wholegrain Rye-Oat Crispbread  250 g",
        "ing": [
            "Ingredients / Ainesosat: wholegrain rye / täysjyväruis (58 %),",
            "wholegrain oats / täysjyväkaura (38 %), water / vesi, sea salt (1.1 %).",
        ],
        "alg": "Allergens / Allergeenit: Contains rye, oats (gluten).",
        "exp": "Best before / Parasta ennen: 2027-12-15",
        "occlude": None,
        "tilt": 0.5,
    },
    {
        "id": "ds_12",
        "category": "nordic_occluded_allergen_unsure",
        "food": True,
        "q": "Is this oat snack safe with my allergies?",
        "expected": "unsure",
        "exp_agrees": None,
        "exp_str": None,
        "str_occluded": False,
        "alg_present": False,
        "alg_occluded": True,
        "gs1_raw": None,
        "desc": "Nordic oat snack pouch with torn shipping label and thumb occluding entire ingredients and allergen panel",
        "accent": (58, 94, 128),
        "bg": (247, 249, 251),
        "hdr": "POHJOLA EVÄS  VÄLIPALA / MELLANMÅL",
        "title": "KAURAVÄLIPALA / HAVREBAR",
        "sub": "Kaurapatukka / Havrebar  55 g",
        "ing": [],
        "alg": "",
        "exp": None,
        "occlude": "sticker_thumb_food",
        "tilt": 1.6,
    },
]


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)], capture_output=True, check=True, timeout=5)
            for ch in proc.stdout.split(b"\x00"):
                if b"=" in ch:
                    k, v = ch.split(b"=", 1)
                    ks = k.decode("utf-8", "ignore").strip()
                    if ks and ks not in os.environ:
                        os.environ[ks] = v.decode("utf-8", "ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    for p in (home_env, REPO / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        return KEY_RE.sub("[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-"))
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, dict):
        return {sanitize(str(k)): sanitize(val) for k, val in v.items()}
    return v


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    defs = (node.get("$defs") or {}) if (defs is None and isinstance(node, dict)) else defs
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str) and defs is not None:
            return inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt(max(0.0, (p * (1.0 - p) + 0.25 * z2n) / n))) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def compute_prompt_sha12() -> str:
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    return hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]


def find_node() -> str:
    for nd in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
        cand = pathlib.Path(nd) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_ROOT.is_dir():
        ev["TMPDIR"] = str(SHM_ROOT)
    parent_nm = REPO.parent / "node_modules"
    if parent_nm.is_dir():
        cur_np = ev.get("NODE_PATH", "")
        if str(parent_nm) not in cur_np.split(":"):
            ev["NODE_PATH"] = f"{parent_nm}:{cur_np}" if cur_np else str(parent_nm)
    return ev


def load_font(sz: int, bold: bool = False) -> Any:
    fpath = FONT_BOLD if bold else FONT_REG
    if os.path.isfile(fpath):
        return ImageFont.truetype(fpath, sz)
    return ImageFont.load_default(size=sz)


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 12, bold: bool = False) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = load_font(sz, bold=bold)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return load_font(min_sz, bold=bold)


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size))
    d, rng = ImageDraw.Draw(im), random.Random(seed + 29)
    hz = int(size * 0.60)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(234 - 18 * t), int(231 - 16 * t), int(225 - 14 * t)))
    for y in range(hz, size):
        t, j = (y - hz) / max(1, size - hz), rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(188 - 24 * t) + j, int(166 - 20 * t) + j, int(138 - 16 * t) + j))
    d.line((0, hz, size, hz), fill=(142, 120, 96), width=3)
    return im


def draw_datamatrix(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], seed: int) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0, y0, x1, y1), radius=8, fill=(255, 255, 255, 255), outline=(168, 178, 192, 255), width=2)
    rng, cell, gn = random.Random(seed + 409), 6, 18
    mx0 = x0 + int((x1 - x0 - gn * cell) / 2)
    my0 = y0 + 18
    for r in range(gn):
        for c in range(gn):
            bit = True if (c == 0 or r == gn - 1) else ((c % 2 == 0) if r == 0 else ((r % 2 == 1) if c == gn - 1 else rng.random() < 0.48))
            if bit:
                draw.rectangle((mx0 + c * cell, my0 + r * cell, mx0 + (c + 1) * cell - 1, my0 + (r + 1) * cell - 1), fill=(16, 20, 28, 255))
    cap = "EU FMD 2D"
    cf = fit_font(draw, cap, x1 - x0 - 16, 15, 11, bold=True)
    draw.text((x0 + int((x1 - x0 - draw.textlength(cap, font=cf)) / 2), my0 + gn * cell + 16), cap, font=cf, fill=(44, 52, 66, 255))


def apply_occlusion(card: Image.Image, mode: str, seed: int) -> None:
    rng = random.Random(seed + 97)
    cw, ch = card.size
    d = ImageDraw.Draw(card)
    if mode == "scuffed_expiry":
        bx0, by0, bx1, by1 = 26, 424, 292, 486
        d.rounded_rectangle((bx0, by0, bx1, by1), radius=8, fill=(224, 220, 214, 255), outline=(182, 178, 170, 255), width=2)
        for _ in range(95):
            sx = rng.randint(bx0 + 8, bx1 - 26)
            sy = rng.randint(by0 + 8, by1 - 8)
            g = rng.randint(188, 232)
            d.line((sx, sy, sx + rng.randint(10, 24), sy + rng.randint(-2, 2)), fill=(g, g - 2, g - 5, 255), width=3)
    elif mode == "thumb_strength":
        thumb = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((-30, 186, 332, 322), radius=64, fill=(34, 26, 22, 92))
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=9.0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((-36, 182, 324, 314), radius=62, fill=(224, 178, 150, 255), outline=(188, 140, 114, 255), width=3)
        td.rounded_rectangle((226, 198, 308, 296), radius=34, fill=(242, 214, 198, 255), outline=(204, 164, 142, 255), width=2)
        card.alpha_composite(thumb)
    elif mode == "sticker_thumb_food":
        d.rounded_rectangle((20, 184, cw - 20, ch - 20), radius=10, fill=(238, 235, 228, 255), outline=(186, 180, 170, 255), width=2)
        for _ in range(120):
            sx = rng.randint(28, cw - 48)
            sy = rng.randint(194, ch - 30)
            g = rng.randint(204, 236)
            d.line((sx, sy, sx + rng.randint(12, 28), sy + rng.randint(-3, 3)), fill=(g, g - 3, g - 8, 255), width=3)
        thumb = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((cw - 270, ch - 210, cw + 30, ch - 28), radius=66, fill=(222, 176, 148, 255), outline=(186, 138, 112, 255), width=3)
        card.alpha_composite(thumb)


def render_case(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 8100 + idx * 37
    pad, size = 72, 912
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 44, pad + 92, pad + 724, pad + 668
    bw, bh = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 10, y0 + 14, x1 + 14, y1 + 18), radius=18, fill=(24, 22, 20, 82))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(radius=11.0)))
    card = Image.new("RGBA", (bw, bh), (*case["bg"], 255))
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 58), fill=(*case["accent"], 255))
    cd.text((24, 16), case["hdr"], fill=(248, 250, 252, 255), font=fit_font(cd, case["hdr"], bw - 48, 21, 14, bold=True))
    if case["food"]:
        cd.text((24, 76), case["title"], fill=(16, 22, 32, 255), font=fit_font(cd, case["title"], bw - 48, 32, 18, bold=True))
        cd.text((24, 124), case["sub"], fill=(46, 54, 68, 255), font=fit_font(cd, case["sub"], bw - 48, 21, 14))
        if case["ing"]:
            cd.rounded_rectangle((22, 168, bw - 22, 434), radius=10, fill=(255, 254, 250, 255), outline=(168, 160, 148, 255), width=2)
            iy = 186
            for ln in case["ing"]:
                cd.text((34, iy), ln, fill=(18, 22, 26, 255), font=fit_font(cd, ln, bw - 68, 20, 13))
                iy += 34
            cd.rounded_rectangle((32, 322, bw - 32, 416), radius=8, fill=(255, 245, 232, 255), outline=(192, 118, 58, 255), width=2)
            cd.text((42, 354), case["alg"], fill=(88, 32, 14, 255), font=fit_font(cd, case["alg"], bw - 84, 19, 12, bold=True))
        if case["exp"]:
            cd.text((26, bh - 56), case["exp"], fill=(18, 24, 32, 255), font=fit_font(cd, case["exp"], bw - 52, 22, 14, bold=True))
    else:
        seam_x = bw - 176
        cd.rectangle((seam_x, 58, bw - 4, bh - 4), fill=(case["bg"][0] - 6, case["bg"][1] - 6, case["bg"][2] - 5, 255))
        cd.line((seam_x, 58, seam_x, bh - 4), fill=(176, 184, 194, 255), width=2)
        cd.text((26, 80), case["title"], fill=(16, 22, 32, 255), font=fit_font(cd, case["title"], seam_x - 40, 44, 24, bold=True))
        cd.text((26, 140), case["sub"], fill=(44, 52, 66, 255), font=fit_font(cd, case["sub"], seam_x - 40, 22, 15))
        if case["str"]:
            cd.rounded_rectangle((26, 200, 272, 290), radius=12, fill=(238, 245, 252, 255), outline=(*case["accent"], 255), width=3)
            cd.text((48, 220), case["str"], fill=(14, 20, 30, 255), font=load_font(42, bold=True))
        if case["pack"]:
            cd.text((26, 334), case["pack"], fill=(36, 44, 56, 255), font=fit_font(cd, case["pack"], seam_x - 40, 21, 14))
        if case["exp"]:
            cd.rounded_rectangle((26, 424, 292, 486), radius=8, fill=(244, 247, 250, 255), outline=(172, 180, 192, 255), width=2)
            cd.text((44, 440), case["exp"], fill=(18, 24, 34, 255), font=load_font(25, bold=True))
        draw_datamatrix(cd, (seam_x + 14, 224, bw - 14, 412), seed)
    if case["occlude"]:
        apply_occlusion(card, case["occlude"], seed)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)
    comp = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return comp.crop((pad, pad, pad + 768, pad + 768))


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64_jpg: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": f'The person asked: "{question}"'}]
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }
    sess, last = requests.Session(), "failed"
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            last = sanitize(str(exc))
            if attempt == 3:
                return {"ok": False, "err": last, "ms": 0.0, "timeout": True}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": False}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    ev = sub_env()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { parseGs1 } from "./server/src/gs1.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'const code = r.gs1_raw ? (parseGs1(r.gs1_raw) ?? null) : null; '
        'return { id: r.id, read, code, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false, alg_hits: allergenHits(read, inp.allergies).length }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    normed = json.loads(p1.stdout)
    bridge_lines = []
    for r in normed:
        row_in: dict[str, Any] = {"read": r["read"], "profile": PROFILE, "now": NOW_ISO}
        if r["code"] is not None:
            row_in["code"] = r["code"]
        bridge_lines.append(json.dumps(row_in))
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input="\n".join(bridge_lines) + "\n", text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    out: dict[str, dict[str, Any]] = {}
    for n, v in zip(normed, verdicts):
        clean_code = None
        if isinstance(n["code"], dict):
            clean_code = {k: v_k for k, v_k in n["code"].items() if k != "raw"}
            clean_code["raw"] = n["code"]["raw"].replace(GS_CHAR, "<GS>")
        out[n["id"]] = {"read": sanitize(n["read"]), "code": sanitize(clean_code), "raw_code": n["code"], "str_same": n["str_same"], "alg_hits": n["alg_hits"], "verdict": v}
    return out


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and DOC3 not in src_py and SQ3 not in src_py
    assert EM_DASH not in src_py and EN_DASH not in src_py and not KEY_RE.search(src_py)
    assert not TMP_IMG_DIR.exists(), f"temporary image dir {TMP_IMG_DIR} still exists"
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) < MAX_RESULTS_BYTES, f"results.json size {len(raw_bytes)} >= {MAX_RESULTS_BYTES}"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12()
    assert data["safety_module"] == SAFETY_TS_REL
    assert data["errors"] == 0 and data["timeouts"] == 0
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["errors"] == 0 and s["timeouts"] == 0
    bridge_lines = []
    for c in cases:
        row_in: dict[str, Any] = {"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}
        if c.get("code") is not None:
            code_obj = dict(c["code"])
            if isinstance(code_obj.get("raw"), str):
                code_obj["raw"] = code_obj["raw"].replace("<GS>", GS_CHAR)
            row_in["code"] = code_obj
        bridge_lines.append(json.dumps(row_in))
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input="\n".join(bridge_lines) + "\n", text=True, capture_output=True, cwd=str(REPO), env=sub_env(), check=True, timeout=10)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        re_agrees = (rv.get("crossCheck") or {}).get("agrees") if rv.get("crossCheck") else None
        exp_cached = c.get("crosscheck_agrees")
        assert re_agrees == exp_cached or (rv["level"] != "match" and exp_cached is True and re_agrees is None), f"{c['id']}: crosscheck {re_agrees} != {exp_cached}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c.get("unsafe_reassurance")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--verify-cached", dest="verify_cached", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.verify_cached or args.offline:
        return check_existing()
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    rendered: list[dict[str, Any]] = []
    TMP_IMG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        for idx, c in enumerate(CASES, 1):
            im = render_case(c, idx)
            jpg_path = TMP_IMG_DIR / f"{c['id']}.jpg"
            im.save(jpg_path, format="JPEG", quality=90)
            b64 = base64.b64encode(jpg_path.read_bytes()).decode("ascii")
            rendered.append({"case": c, "b64": b64})
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    finally:
        shutil.rmtree(TMP_IMG_DIR, ignore_errors=True)
    timeouts = sum(1 for o in api_outs if o.get("timeout"))
    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    if errors or timeouts:
        raise RuntimeError(f"API errors={errors} timeouts={timeouts}: {[o.get('err') for o in api_outs if not o.get('ok')]}")
    scored = score_with_ts_and_bridge(
        [{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"], "gs1_raw": r["case"]["gs1_raw"]} for r, o in zip(rendered, api_outs)]
    )
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        cc = vd.get("crossCheck")
        cc_agrees = cc.get("agrees") if isinstance(cc, dict) else None
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        a_conf = float(rd["allergens"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool((c["expected"] == "warning" and pred in ("match", "info")) or (c["alg_occluded"] and pred == "info"))
        if c["str_occluded"]:
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
        elif c["exp_str"] is not None:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        elif c["alg_occluded"]:
            cw = bool(false_match or unsafe_reassurance or a_conf >= STRENGTH_MIN_CONF or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        else:
            alg_miss = bool(c["alg_present"] and a_conf >= STRENGTH_MIN_CONF and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or alg_miss or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        agrees_ok = (cc_agrees == c["exp_agrees"]) or (pred != "match" and c["exp_agrees"] is True and cc_agrees is None)
        verdict_ok = bool(pred == c["expected"] and agrees_ok)
        row_out: dict[str, Any] = {
            "id": c["id"],
            "category": c["category"],
            "description": c["desc"],
            "question": c["q"],
            "expected_level": c["expected"],
            "predicted_level": pred,
            "crosscheck_agrees": cc_agrees,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "unsafe_reassurance": unsafe_reassurance,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }
        if sc["code"] is not None:
            row_out["code"] = sc["code"]
        cases_out.append(sanitize(row_out))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} agrees={cc_agrees} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["unsafe_reassurance"])
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    dm_cases = [x for x in cases_out if x["id"] in ("ds_01", "ds_02", "ds_03", "ds_04", "ds_05", "ds_06", "ds_07")]
    nordic_cases = [x for x in cases_out if x["id"] in ("ds_08", "ds_09", "ds_10", "ds_11", "ds_12")]
    summary = {
        "n_cases": n,
        "errors": 0,
        "timeouts": 0,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "datamatrix_spoof_matrix_accuracy": round(sum(1 for x in dm_cases if x["verdict_ok"]) / len(dm_cases), 4),
        "nordic_compound_allergen_accuracy": round(sum(1 for x in nordic_cases if x["verdict_ok"]) / len(nordic_cases), 4),
    }
    payload = sanitize({
        "suite": SUITE_NAME,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "errors": 0,
        "timeouts": 0,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) >= 15000:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
