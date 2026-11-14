import argparse
import base64
import datetime
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
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

for _nb in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = REPO / "eval" / "out" / "expiry_formats"
OUT_JSON = SUITE_DIR / "results.json"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
EXPIRY_MIN_CONF = 0.70
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "panadol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {"id": "ex_01", "category": "expired_intl", "degraded": False, "surface": "med_carton", "hdr": "VIATRIS  Vnr 04 19 22", "title": "NORVASC", "sub": "amlodipine (as besilate)", "str": "5 mg", "form": "tablets", "pack": "30 tablets  1 tablet once daily in the evening", "lot": "LOT H25031", "printed_exp": "EXP 03/2025", "exp_iso": "2025-03", "is_exp": True, "exp_str": "5 mg", "q": "Is this my evening pill?", "expected": "warning", "accent": (28, 74, 138), "desc": "NORVASC 5 mg carton with expired EN MM/YYYY stamp EXP 03/2025"},
    {"id": "ex_02", "category": "expired_nordic", "degraded": False, "surface": "med_carton", "hdr": "ORION PHARMA  Vnr 14 29 71", "title": "METFORMIN ORION", "sub": "Vaikuttava aine: metformiini", "str": "500 mg", "form": "tabletti", "pack": "100 tablettia  Suun kautta", "lot": "Era 230219", "printed_exp": "Käyt. viim. 02.2025", "exp_iso": "2025-02", "is_exp": True, "exp_str": "500 mg", "q": "Can I take my Metformin from this box?", "expected": "warning", "accent": (22, 104, 142), "desc": "METFORMIN ORION 500 mg Finnish carton with expired Käyt. viim. 02.2025"},
    {"id": "ex_03", "category": "expired_nordic", "degraded": False, "surface": "end_flap", "hdr": "ACTAVIS  Vnr 09 18 44", "title": "AMLODIPIN", "sub": "Aktiv substans: amlodipin", "str": "5 mg", "form": "filmdragerade tabletter", "pack": "30 tabletter", "lot": "Batch 221208", "printed_exp": "Utg.dat 2024-12", "exp_iso": "2024-12", "is_exp": True, "exp_str": "5 mg", "q": "Is this my evening blood pressure pill?", "expected": "warning", "accent": (36, 86, 156), "desc": "AMLODIPIN 5 mg Swedish end-flap with expired Utg.dat 2024-12"},
    {"id": "ex_04", "category": "expired_intl", "degraded": False, "surface": "med_carton", "hdr": "HEXAL AG  PZN 04819203", "title": "METFORMIN HEXAL", "sub": "Wirkstoff: Metforminhydrochlorid", "str": "500 mg", "form": "Filmtabletten", "pack": "100 Filmtabletten  Zum Einnehmen", "lot": "Ch.-B. 450512", "printed_exp": "Verwendbar bis 05.2025", "exp_iso": "2025-05", "is_exp": True, "exp_str": "500 mg", "q": "Is this my Metformin?", "expected": "warning", "accent": (24, 92, 128), "desc": "METFORMIN HEXAL 500 mg German carton with expired Verwendbar bis 05.2025"},
    {"id": "ex_05", "category": "debossed_flap", "degraded": False, "surface": "debossed", "hdr": "HALEON  Vnr 05 82 19", "title": "PANADOL", "sub": "paracetamol", "str": "500 mg", "form": "film-coated tablets", "pack": "24 film-coated tablets", "lot": "LOT 40118", "printed_exp": "EXP 2025-01", "exp_iso": "2025-01", "is_exp": True, "exp_str": "500 mg", "q": "Can I take this Panadol?", "expected": "warning", "accent": (20, 96, 152), "desc": "PANADOL 500 mg low-contrast debossed cardboard end-flap EXP 2025-01"},
    {"id": "ex_06", "category": "boundary_date", "degraded": False, "surface": "med_carton", "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "AMLODIPIN ORION", "sub": "amlodipiini / amlodipine", "str": "5 mg", "form": "tabletti", "pack": "30 tablettia", "lot": "LOT 241113", "printed_exp": "EXP 2026-11-13", "exp_iso": "2026-11-13", "is_exp": True, "exp_str": "5 mg", "q": "Is this my evening pill?", "expected": "warning", "accent": (22, 108, 144), "desc": "AMLODIPIN ORION 5 mg carton with yesterday day-boundary EXP 2026-11-13"},
    {"id": "ex_07", "category": "boundary_date", "degraded": False, "surface": "end_flap", "hdr": "ORION PHARMA  Vnr 14 29 71", "title": "METFORMIN", "sub": "metformin hydrochloride", "str": "500 mg", "form": "film-coated tablets", "pack": "100 tablets", "lot": "LOT 241009", "printed_exp": "EXP 2026-10", "exp_iso": "2026-10", "is_exp": True, "exp_str": "500 mg", "q": "Is this my Metformin?", "expected": "warning", "accent": (26, 98, 138), "desc": "METFORMIN 500 mg end-flap with last-month boundary EXP 2026-10"},
    {"id": "ex_08", "category": "boundary_date", "degraded": False, "surface": "med_carton", "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "AMLODIPIN ORION", "sub": "amlodipiini / amlodipine", "str": "5 mg", "form": "tabletti", "pack": "98 tablettia", "lot": "LOT 241128", "printed_exp": "EXP 2026-11", "exp_iso": "2026-11", "is_exp": False, "exp_str": "5 mg", "q": "Is this my evening pill?", "expected": "match", "accent": (22, 108, 144), "desc": "AMLODIPIN ORION 5 mg carton with current-month EXP 2026-11 valid through Nov 30"},
    {"id": "ex_09", "category": "valid_future", "degraded": False, "surface": "med_carton", "hdr": "HALEON NORDIC  Vnr 05 82 19", "title": "PANADOL", "sub": "paracetamol", "str": "500 mg", "form": "film-coated tablets", "pack": "30 tablets  Oral use", "lot": "LOT 250914", "printed_exp": "EXP 09/2027", "exp_iso": "2027-09", "is_exp": False, "exp_str": "500 mg", "q": "Can I take this Panadol?", "expected": "match", "accent": (18, 96, 158), "desc": "PANADOL 500 mg carton with future EXP 09/2027 normalized to 2027-09"},
    {"id": "ex_10", "category": "expired_food", "degraded": False, "surface": "food_carton", "hdr": "POHJOLAN KAURA  1 L", "title": "KAURAJUOMA", "sub": "Kaurapohjainen juoma / Oat Drink", "ing": ["Ainekset: vesi, kaura (10%), rapsioljy, suola.", "Allergens: contains oats (gluten). Nut-free."], "lot": "LOT F250314", "printed_exp": "Parasta ennen 14.03.2026", "exp_iso": "2026-03-14", "is_exp": True, "exp_str": None, "q": "Is this oat drink still in date and safe?", "expected": "warning", "accent": (46, 114, 76), "desc": "KAURAJUOMA Finnish oat drink carton with expired Parasta ennen 14.03.2026"},
    {"id": "ex_11", "category": "valid_future", "degraded": False, "surface": "food_carton", "hdr": "NORDIC PLANT DAIRY  1 L", "title": "Nordic Oat Drink", "sub": "Original wholegrain oat drink", "ing": ["Ingredients: water, wholegrain oats (10%), salt.", "Allergens: contains oats (gluten)."], "lot": "LOT F260918", "printed_exp": "Best before 18 SEP 27", "exp_iso": "2027-09-18", "is_exp": False, "exp_str": None, "q": "Is this oat drink safe and within its best-before date?", "expected": "info", "accent": (42, 114, 84), "desc": "Nordic Oat Drink carton with 2-digit year month-abbrev Best before 18 SEP 27"},
    {"id": "ex_12", "category": "degraded_unreadable", "degraded": True, "surface": "abraded_flap", "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "AMLODIPIN ORION", "sub": "amlodipiini / amlodipine", "str": None, "form": "tabletti", "pack": "30 tablettia", "lot": "LOT", "printed_exp": None, "exp_iso": None, "is_exp": False, "exp_str": None, "q": "Is this my evening pill and is it still in date?", "expected": "unsure", "accent": (22, 108, 144), "desc": "Abraded end-flap with rubbed-off strength badge and torn expiry stamp"},
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
    half = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / denom
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
    for p in ("/tmp/fleet-silas/node/bin/node", "/home/silas/tools/node/bin/node"):
        if os.path.isfile(p):
            return p
    return shutil.which("node") or "node"


def add_grain(im: Image.Image, seed: int, sigma: float = 2.4, alpha: float = 0.04) -> Image.Image:
    rng = random.Random(seed)
    w, h = im.size
    sw, sh = int(w / 2), int(h / 2)
    nb = bytearray(sw * sh)
    for i in range(len(nb)):
        v = int(128 + rng.gauss(0.0, sigma))
        nb[i] = 0 if v < 0 else (255 if v > 255 else v)
    g = Image.frombytes("L", (sw, sh), bytes(nb)).resize((w, h), Image.Resampling.BILINEAR)
    return Image.blend(im.convert("RGB"), Image.merge("RGB", (g, g, g)), alpha=alpha)


def render_backdrop(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (226, 221, 212))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(520):
        t = y / 520.0
        d.line((0, y, 768, y), fill=(int(236 - 20 * t), int(232 - 20 * t), int(224 - 18 * t)))
    for y in range(520, 768):
        t, j = (y - 520) / 248.0, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(188 - 22 * t) + j, int(160 - 20 * t) + j, int(130 - 16 * t) + j))
    d.line((0, 520, 768, 520), fill=(140, 114, 90), width=3)
    return im


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261114 + idx * 53
    rng = random.Random(seed)
    bg = render_backdrop(seed)
    d = ImageDraw.Draw(bg)
    sf = case["surface"]
    acc = case["accent"]
    if sf == "med_carton":
        x0, y0 = 64 + rng.randint(-6, 6), 136 + rng.randint(-5, 5)
        x1, y1 = x0 + 640, y0 + 444
        d.rounded_rectangle((x0 + 10, y0 + 14, x1 + 12, y1 + 16), radius=16, fill=(138, 122, 106))
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(170, 176, 184), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 32, x1, y0 + 62), fill=acc)
        d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        d.text((x0 + 28, y0 + 18), case["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=22))
        d.text((x0 + 28, y0 + 82), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=42))
        d.text((x0 + 28, y0 + 140), case["sub"], fill=(48, 56, 66), font=ImageFont.load_default(size=24))
        sfnt = ImageFont.load_default(size=42)
        sw = d.textbbox((0, 0), case["str"], font=sfnt)[2]
        sx0, sy0, sx1, sy1 = x0 + 28, y0 + 190, x0 + 28 + max(196, sw + 44), y0 + 274
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
        d.text((sx0 + 22, sy0 + 18), case["str"], fill=(14, 20, 28), font=sfnt)
        d.text((sx1 + 20, sy0 + 28), case["form"], fill=(44, 52, 62), font=ImageFont.load_default(size=23))
        d.text((x0 + 28, y0 + 304), case["pack"], fill=(54, 62, 72), font=ImageFont.load_default(size=20))
        efnt = ImageFont.load_default(size=24)
        ew = d.textbbox((0, 0), case["printed_exp"], font=efnt)[2]
        ex1 = x1 - 24
        ex0 = ex1 - max(254, ew + 42)
        d.rounded_rectangle((ex0, y0 + 340, ex1, y0 + 420), radius=8, fill=(244, 246, 249), outline=(154, 162, 172), width=2)
        d.text((ex0 + 18, y0 + 352), case["lot"], fill=(72, 80, 90), font=ImageFont.load_default(size=18))
        d.text((ex0 + 18, y0 + 379), case["printed_exp"], fill=(18, 24, 32), font=efnt)
    elif sf == "end_flap":
        x0, y0 = 88 + rng.randint(-5, 5), 178 + rng.randint(-5, 5)
        x1, y1 = x0 + 592, y0 + 392
        d.rounded_rectangle((x0 + 10, y0 + 14, x1 + 12, y1 + 16), radius=12, fill=(134, 118, 102))
        d.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=(248, 248, 245), outline=(160, 164, 170), width=3)
        d.rectangle((x0 + 18, y0 + 26, x0 + 34, y1 - 26), fill=acc)
        d.text((x0 + 52, y0 + 34), case["hdr"], fill=(76, 84, 94), font=ImageFont.load_default(size=19))
        d.text((x0 + 52, y0 + 68), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=38))
        d.text((x0 + 52, y0 + 118), case["sub"], fill=(52, 60, 70), font=ImageFont.load_default(size=22))
        sfnt = ImageFont.load_default(size=36)
        sw = d.textbbox((0, 0), case["str"], font=sfnt)[2]
        sx0, sy0, sx1, sy1 = x0 + 52, y0 + 160, x0 + 52 + max(168, sw + 36), y0 + 226
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=8, fill=(238, 244, 250), outline=acc, width=2)
        d.text((sx0 + 18, sy0 + 13), case["str"], fill=(14, 20, 28), font=sfnt)
        d.text((sx1 + 16, sy0 + 20), case["form"], fill=(46, 54, 64), font=ImageFont.load_default(size=20))
        d.text((x0 + 52, y0 + 244), case["pack"], fill=(62, 70, 80), font=ImageFont.load_default(size=20))
        d.rounded_rectangle((x0 + 52, y0 + 282, x1 - 36, y1 - 28), radius=6, fill=(239, 239, 234), outline=(186, 186, 180), width=2)
        d.text((x0 + 70, y0 + 294), case["lot"], fill=(54, 58, 62), font=ImageFont.load_default(size=20))
        d.text((x0 + 244, y0 + 306), case["printed_exp"], fill=(28, 32, 36), font=ImageFont.load_default(size=27))
    elif sf == "debossed":
        x0, y0, bw, bh = 82, 154, 604, 448
        d.rounded_rectangle((x0 + 10, y0 + 14, x0 + bw + 12, y0 + bh + 16), radius=12, fill=(132, 116, 100))
        flap = Image.new("RGB", (bw, bh), (236, 234, 228))
        fd = ImageDraw.Draw(flap)
        for py in range(bh):
            c = int(242 - 14 * (py / bh))
            fd.line((0, py, bw, py), fill=(c, c - 2, c - 7))
        flap = add_grain(flap, seed + 41, sigma=3.0, alpha=0.06)
        fd = ImageDraw.Draw(flap)
        fd.rectangle((0, 0, bw, 52), fill=acc)
        fd.text((26, 14), case["hdr"], fill=(246, 249, 252), font=ImageFont.load_default(size=20))
        fd.text((28, 70), case["title"], fill=(18, 24, 32), font=ImageFont.load_default(size=40))
        fd.text((28, 120), case["sub"], fill=(52, 60, 70), font=ImageFont.load_default(size=23))
        fd.rounded_rectangle((28, 160, 206, 224), radius=8, fill=(238, 244, 250), outline=acc, width=2)
        fd.text((48, 172), case["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=36))
        fd.text((224, 180), case["form"], fill=(46, 54, 64), font=ImageFont.load_default(size=21))
        fd.text((28, 236), case["pack"], fill=(66, 74, 84), font=ImageFont.load_default(size=19))
        fd.rounded_rectangle((28, 290, bw - 28, bh - 24), radius=8, fill=(230, 227, 220), outline=(206, 203, 196), width=1)
        deb = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
        dd = ImageDraw.Draw(deb)
        fl, fe = ImageFont.load_default(size=25), ImageFont.load_default(size=36)
        dd.text((53, 307), case["lot"], fill=(134, 130, 122, 215), font=fl)
        dd.text((56, 310), case["lot"], fill=(252, 250, 246, 235), font=fl)
        dd.text((54, 308), case["lot"], fill=(166, 162, 154, 255), font=fl)
        dd.text((52, 346), case["printed_exp"], fill=(120, 116, 108, 230), font=fe)
        dd.text((56, 350), case["printed_exp"], fill=(254, 252, 248, 245), font=fe)
        dd.text((54, 348), case["printed_exp"], fill=(150, 146, 138, 255), font=fe)
        flap = Image.alpha_composite(flap.convert("RGBA"), deb.filter(ImageFilter.GaussianBlur(0.45))).convert("RGB")
        bg.paste(flap, (x0, y0))
        d.rounded_rectangle((x0, y0, x0 + bw - 1, y0 + bh - 1), radius=12, outline=(162, 160, 154), width=3)
    elif sf == "food_carton":
        x0, y0, cw, ch = 136, 70, 496, 624
        d.rounded_rectangle((x0 + 10, y0 + 14, x0 + cw + 12, y0 + ch + 16), radius=16, fill=(132, 116, 100))
        d.rounded_rectangle((x0, y0, x0 + cw, y0 + ch), radius=16, fill=(245, 240, 228), outline=(168, 162, 150), width=3)
        d.rectangle((x0 + 3, y0 + 68, x0 + cw - 3, y0 + 132), fill=acc)
        d.text((x0 + 24, y0 + 14), case["lot"], fill=(86, 90, 88), font=ImageFont.load_default(size=16))
        d.text((x0 + 24, y0 + 34), case["printed_exp"], fill=(20, 24, 26), font=ImageFont.load_default(size=24))
        d.text((x0 + 26, y0 + 88), case["hdr"], fill=(244, 248, 244), font=ImageFont.load_default(size=22))
        d.text((x0 + 26, y0 + 154), case["title"], fill=(22, 44, 30), font=ImageFont.load_default(size=40))
        d.text((x0 + 26, y0 + 210), case["sub"], fill=(52, 70, 58), font=ImageFont.load_default(size=22))
        d.rounded_rectangle((x0 + 24, y0 + 264, x0 + cw - 24, y0 + 452), radius=12, fill=(252, 250, 244), outline=(182, 176, 162), width=2)
        iy = y0 + 288
        for ln in case["ing"]:
            d.text((x0 + 38, iy), ln, fill=(28, 32, 30), font=ImageFont.load_default(size=20))
            iy += 44
        d.rounded_rectangle((x0 + 24, y0 + 484, x0 + cw - 24, y0 + 548), radius=8, fill=(255, 255, 255), outline=(190, 186, 176), width=2)
        d.text((x0 + 38, y0 + 502), case["printed_exp"], fill=(20, 24, 26), font=ImageFont.load_default(size=24))
    else:
        x0, y0, x1, y1 = 68, 146, 700, 578
        d.rounded_rectangle((x0 + 10, y0 + 14, x1 + 12, y1 + 16), radius=16, fill=(134, 118, 102))
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(170, 176, 184), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 32, x1, y0 + 62), fill=acc)
        d.text((x0 + 28, y0 + 18), case["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=22))
        d.text((x0 + 28, y0 + 82), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=42))
        d.text((x0 + 28, y0 + 140), case["sub"], fill=(48, 56, 66), font=ImageFont.load_default(size=24))
        d.rounded_rectangle((x0 + 24, y0 + 186, x1 - 24, y1 - 22), radius=10, fill=(208, 202, 192), outline=(176, 170, 160), width=2)
        for sy in range(y0 + 196, y1 - 30, 9):
            d.line((x0 + 34, sy, x1 - 34, sy + rng.randint(-3, 3)), fill=(192 + rng.randint(-8, 8), 186, 176), width=4)
    return add_grain(bg.rotate(rng.uniform(-1.3, 1.3), resample=Image.Resampling.BICUBIC, fillcolor=(220, 214, 204)), seed + 19)


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64_jpg: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": f'The person asked: "{question}"'}]}],
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
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength, isExpired } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'const now = new Date(inp.now); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'const expFlag = read.expiry.value && read.expiry.confidence >= 0.7 ? (isExpired(read.expiry.value, now) ?? null) : null; '
        'return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false, ts_expired: expFlag }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "now": NOW_ISO}), text=True, capture_output=True, cwd=str(REPO), check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15000, f"results.json size {len(raw_bytes)} > 15000"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == "expiry_formats"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": data["profile"], "now": data["eval_now_iso"]}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    assert s["expired_catch_count"] == sum(1 for c in cases if c["expired_caught"])
    assert s["expiry_iso_normalized_count"] == sum(1 for c in cases if c["expiry_iso_ok"])
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--verify-cached", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.offline or args.verify_cached:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        im = render_case_image(c, idx)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        raw = buf.getvalue()
        (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
        rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
        return 0
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    with ThreadPoolExecutor(max_workers=4) as ex:
        api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    if errors:
        raise RuntimeError(f"API errors: {errors}")
    scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        e_val = rd["expiry"]["value"]
        e_conf = float(rd["expiry"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["degraded"]:
            exp_iso_ok = bool(e_val is None or e_conf < EXPIRY_MIN_CONF)
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF or (e_val is not None and e_conf >= EXPIRY_MIN_CONF))
        else:
            exp_iso_ok = bool(e_val == c["exp_iso"] and e_conf >= EXPIRY_MIN_CONF)
            wrong_exp_conf = bool(e_conf >= 0.80 and e_val != c["exp_iso"])
            if c["exp_str"] is not None:
                cw = bool(false_match or unsafe_reassurance or wrong_exp_conf or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
            else:
                cw = bool(false_match or unsafe_reassurance or wrong_exp_conf or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        expired_caught = bool(c["is_exp"] and pred == "warning" and sc["ts_expired"] is True)
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "description": c["desc"],
            "question": c["q"],
            "printed_expiry": c["printed_exp"],
            "expected_expiry_iso": c["exp_iso"],
            "expiry_iso_ok": exp_iso_ok,
            "expired_caught": expired_caught,
            "expected_level": c["expected"],
            "predicted_level": pred,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }))
        print(f"[{c['id']}] exp_iso={e_val}({e_conf:.2f}) exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    exp_gt_n = sum(1 for c in CASES if c["is_exp"])
    exp_catches = sum(1 for x in cases_out if x["expired_caught"])
    iso_ok_n = sum(1 for x in cases_out if x["expiry_iso_ok"])
    lats = [float(x["latency_ms"]) for x in cases_out]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "expired_ground_truth_count": exp_gt_n,
        "expired_catch_count": exp_catches,
        "expired_catch_recall": round(exp_catches / exp_gt_n, 4),
        "expiry_iso_normalized_count": iso_ok_n,
        "expiry_iso_normalization_rate": round(iso_ok_n / n, 4),
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
    }
    payload = sanitize({
        "suite": "expiry_formats",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    OUT_JSON.write_text(json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
