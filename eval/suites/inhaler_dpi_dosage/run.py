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
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

for _nb in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = "inhaler_dpi_dosage"
SHM_BASE = pathlib.Path("/dev/shm") if os.path.isdir("/dev/shm") else pathlib.Path(tempfile.gettempdir())
OUT_IMG_DIR = SHM_BASE / f"holdup_{SUITE_NAME}"
OUT_JSON = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
MAX_WORKERS = 3
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "buventol", "name": "Buventol", "ingredient": "salbutamol", "strength": "100 mcg/dose", "schedule": ["morning"]},
        {"id": "bufomix", "name": "Bufomix", "ingredient": "budesonide, formoterol", "strength": "160/4.5 mcg/dose", "schedule": ["morning", "evening"]},
        {"id": "avamys", "name": "Avamys", "ingredient": "fluticasone furoate", "strength": "27.5 mcg/spray", "schedule": ["morning"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["ipratropium"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ih_01",
        "category": "clean_prescribed_match",
        "device_type": "orion_easyhaler_dpi",
        "failure_mode": "none_clean_dpi_match",
        "degraded": False,
        "q": "Is this my prescribed Buventol inhaler?",
        "expected": "match",
        "exp_str": "100 mcg/dose",
        "desc": "Orion Pharma Buventol Easyhaler 100 mikrog/annos (salbutamol) Finnish dry-powder inhaler carton matching 100 mcg/dose",
        "accent": (18, 96, 164),
        "bg": (248, 250, 253),
        "hdr": "ORION PHARMA  FINLAND",
        "title": "BUVENTOL EASYHALER",
        "sub": "Vaikuttava aine: salbutamoli (salbutamol)",
        "str": "100 mikrog/annos",
        "str_sub": "Inhalaatiojauhe  (100 mcg/dose)",
        "counter": None,
        "pack": "1 x 200 annosta  1 annos tarvittaessa / aamulla",
        "exp": "EXP 2028-04",
        "tilt": -1.1,
    },
    {
        "id": "ih_02",
        "category": "clean_prescribed_match",
        "device_type": "orion_easyhaler_dpi",
        "failure_mode": "none_combo_dpi_match",
        "degraded": False,
        "q": "Is this my morning Bufomix inhaler?",
        "expected": "match",
        "exp_str": "160/4.5 mcg/dose",
        "desc": "Orion Pharma Bufomix Easyhaler 160/4,5 mikrog/annos (budesonide, formoterol) combination DPI matching 160/4.5 mcg/dose",
        "accent": (148, 28, 62),
        "bg": (252, 248, 250),
        "hdr": "ORION PHARMA  FINLAND",
        "title": "BUFOMIX EASYHALER",
        "sub": "Vaikuttavat aineet: budesonidi, formoteroli (budesonide, formoterol)",
        "str": "160/4,5 mikrog/annos",
        "str_sub": "Inhalaatiojauhe  (160/4.5 mcg/dose)",
        "counter": None,
        "pack": "120 annosta  1 annos aamulla ja illalla",
        "exp": "EXP 2028-06",
        "tilt": 1.3,
    },
    {
        "id": "ih_03",
        "category": "clean_prescribed_match",
        "device_type": "nasal_spray",
        "failure_mode": "none_nasal_spray_match",
        "degraded": False,
        "q": "Is this my morning nasal spray?",
        "expected": "match",
        "exp_str": "27.5 mcg/spray",
        "desc": "GSK Nordic Avamys 27,5 mikrog/suihke (fluticasone furoate) nasal spray carton matching 27.5 mcg/spray",
        "accent": (18, 124, 128),
        "bg": (247, 252, 252),
        "hdr": "GSK NORDIC",
        "title": "AVAMYS",
        "sub": "Vaikuttava aine: flutikasonifuroaatti (fluticasone furoate)",
        "str": "27,5 mikrog/suihke",
        "str_sub": "Nenasumute, suspensio  (27.5 mcg/spray)",
        "counter": None,
        "pack": "120 suihketta  1-2 suihketta aamulla",
        "exp": "EXP 2028-03",
        "tilt": -1.4,
    },
    {
        "id": "ih_04",
        "category": "wrong_per_actuation_strength",
        "device_type": "orion_easyhaler_dpi",
        "failure_mode": "double_strength_200_vs_100",
        "degraded": False,
        "q": "Is this my Buventol inhaler?",
        "expected": "warning",
        "exp_str": "200 mcg/dose",
        "desc": "Buventol Easyhaler 200 mikrog/annos DPI carton catching 2x per-actuation strength mismatch vs prescribed 100 mcg/dose",
        "accent": (18, 96, 164),
        "bg": (248, 250, 253),
        "hdr": "ORION PHARMA  FINLAND",
        "title": "BUVENTOL EASYHALER",
        "sub": "Vaikuttava aine: salbutamoli (salbutamol)",
        "str": "200 mikrog/annos",
        "str_sub": "Inhalaatiojauhe  (200 mcg/dose)",
        "counter": None,
        "pack": "200 annosta  Inhalaatiojauhe",
        "exp": "EXP 2028-05",
        "tilt": 1.5,
    },
    {
        "id": "ih_05",
        "category": "wrong_per_actuation_strength",
        "device_type": "orion_easyhaler_dpi",
        "failure_mode": "double_combo_320_9_vs_160_4_5",
        "degraded": False,
        "q": "Is this my evening Bufomix inhaler?",
        "expected": "warning",
        "exp_str": "320/9 mcg/dose",
        "desc": "Bufomix Easyhaler 320/9 mikrog/annos high-strength DPI catching per-actuation mismatch vs prescribed 160/4.5 mcg/dose",
        "accent": (148, 28, 62),
        "bg": (252, 248, 250),
        "hdr": "ORION PHARMA  FINLAND",
        "title": "BUFOMIX EASYHALER",
        "sub": "Vaikuttavat aineet: budesonidi, formoteroli (budesonide, formoterol)",
        "str": "320/9 mikrog/annos",
        "str_sub": "Inhalaatiojauhe  (320/9 mcg/dose)",
        "counter": None,
        "pack": "60 annosta  Inhalaatiojauhe",
        "exp": "EXP 2028-07",
        "tilt": -1.6,
    },
    {
        "id": "ih_06",
        "category": "dose_counter_distractor",
        "device_type": "metered_dose_inhaler",
        "failure_mode": "prominent_200_doses_vs_100_mcg_strength",
        "degraded": False,
        "q": "Can I use this salbutamol inhaler?",
        "expected": "match",
        "exp_str": "100 mcg/dose",
        "desc": "Ventoline Evohaler MDI with giant 200 annosta / 200 doses pack badge while actual per-actuation strength is 100 mikrog/annos",
        "accent": (24, 108, 178),
        "bg": (247, 250, 254),
        "hdr": "GSK NORDIC",
        "title": "VENTOLINE EVOHALER",
        "sub": "Vaikuttava aine: salbutamoli (salbutamol)",
        "str": "100 mikrog/annos",
        "str_sub": "Inhalaatiosumute, suspensio",
        "counter": "200 annosta / 200 doses",
        "pack": "Paineistettu inhalaatiosumute",
        "exp": "EXP 2028-08",
        "tilt": 1.2,
    },
    {
        "id": "ih_07",
        "category": "avoid_unlisted_expired_warning",
        "device_type": "metered_dose_inhaler",
        "failure_mode": "avoid_list_anticholinergic_mdi",
        "degraded": False,
        "q": "Can I take a puff of this inhaler?",
        "expected": "warning",
        "exp_str": "20 mcg/dose",
        "desc": "Atrovent 20 mikrog/annos (ipratropium bromide) pressurized MDI triggering avoid-list and unlisted medication warnings",
        "accent": (36, 118, 78),
        "bg": (248, 252, 249),
        "hdr": "BOEHRINGER INGELHEIM",
        "title": "ATROVENT",
        "sub": "Vaikuttava aine: ipratropiumbromidi (ipratropium bromide)",
        "str": "20 mikrog/annos",
        "str_sub": "Inhalaatiosumute, liuos  (20 mcg/dose)",
        "counter": "200 annosta / 200 doses",
        "pack": "Paineistettu inhalaatiosumute",
        "exp": "EXP 2028-02",
        "tilt": -1.3,
    },
    {
        "id": "ih_08",
        "category": "avoid_unlisted_expired_warning",
        "device_type": "diskus_dpi",
        "failure_mode": "unlisted_diskus_dpi",
        "degraded": False,
        "q": "Is this one of my prescribed inhalers?",
        "expected": "warning",
        "exp_str": "50 mcg/dose",
        "desc": "Serevent Diskus 50 mikrog/annos (salmeterol) Nordic dry-powder inhaler with 60 annosta counter not on medication list",
        "accent": (92, 54, 138),
        "bg": (250, 248, 253),
        "hdr": "GSK NORDIC",
        "title": "SEREVENT DISKUS",
        "sub": "Vaikuttava aine: salmeteroli (salmeterol)",
        "str": "50 mikrog/annos",
        "str_sub": "Inhalaatiojauhe, annosteltu  (50 mcg/dose)",
        "counter": "60 annosta / 60 doses",
        "pack": "Moniannosjauheinhalaattori",
        "exp": "EXP 2028-09",
        "tilt": 1.4,
    },
    {
        "id": "ih_09",
        "category": "avoid_unlisted_expired_warning",
        "device_type": "turbuhaler_dpi",
        "failure_mode": "expired_turbuhaler_dpi",
        "degraded": False,
        "q": "Can I use this Symbicort Turbuhaler today?",
        "expected": "warning",
        "exp_str": "160/4.5 mcg/dose",
        "desc": "Expired Symbicort Turbuhaler 160/4,5 mikrog/annos (budesonide, formoterol) DPI with Kayt. viim. 04.2025 warning",
        "accent": (172, 34, 42),
        "bg": (252, 249, 248),
        "hdr": "ASTRAZENECA NORDIC",
        "title": "SYMBICORT TURBUHALER",
        "sub": "Vaikuttavat aineet: budesonidi, formoteroli (budesonide, formoterol)",
        "str": "160/4,5 mikrog/annos",
        "str_sub": "Inhalaatiojauhe  (160/4.5 mcg/dose)",
        "counter": "120 annosta / 120 doses",
        "pack": "Inhalaatiojauhe",
        "exp": "Kayt. viim. 04.2025",
        "tilt": -1.2,
    },
    {
        "id": "ih_10",
        "category": "degraded_zero_guess",
        "device_type": "orion_easyhaler_dpi",
        "failure_mode": "thumb_over_mikrog_annos_digits",
        "degraded": True,
        "q": "Is this my 100 microgram Buventol inhaler?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Thumb covering per-actuation strength digits before mikrog/annos on Buventol Easyhaler carton requiring zero-guess unsure",
        "accent": (18, 96, 164),
        "bg": (248, 250, 253),
        "hdr": "ORION PHARMA  FINLAND",
        "title": "BUVENTOL EASYHALER",
        "sub": "Vaikuttava aine: salbutamoli (salbutamol)",
        "str": None,
        "str_sub": "Inhalaatiojauhe",
        "counter": "200 annosta / 200 doses",
        "pack": "Inhalaatiojauhe",
        "exp": "EXP 2028-04",
        "tilt": 1.6,
    },
    {
        "id": "ih_11",
        "category": "degraded_zero_guess",
        "device_type": "metallic_mdi_canister",
        "failure_mode": "metallic_canister_specular_glare",
        "degraded": True,
        "q": "Is this my 100 microgram salbutamol inhaler?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Brushed aluminum Ventoline Evohaler MDI canister with specular glare streak erasing strength digits before mikrog/annos",
        "accent": (24, 108, 178),
        "bg": (236, 240, 245),
        "hdr": "GSK NORDIC",
        "title": "VENTOLINE EVOHALER",
        "sub": "salbutamoli / salbutamol",
        "str": None,
        "str_sub": "Inhalaatiosumute",
        "counter": "200 annosta",
        "pack": "Pressurized canister",
        "exp": "EXP 2028-08",
        "tilt": -2.1,
    },
    {
        "id": "ih_12",
        "category": "degraded_zero_guess",
        "device_type": "nasal_spray",
        "failure_mode": "heavy_tremor_motion_blur",
        "degraded": True,
        "q": "Is this my morning nasal spray?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Heavy hand-tremor motion blur across Avamys nasal spray carton rendering name and per-spray strength illegible",
        "accent": (18, 124, 128),
        "bg": (247, 252, 252),
        "hdr": "GSK NORDIC",
        "title": "AVAMYS",
        "sub": "flutikasonifuroaatti",
        "str": "27,5 mikrog/suihke",
        "str_sub": "Nenasumute",
        "counter": None,
        "pack": "120 suihketta",
        "exp": "EXP 2028-03",
        "tilt": 3.4,
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
    half = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def rule_of_three_upper95(k: int, n: int) -> float:
    if n <= 0:
        return 1.0
    if k == 0:
        return round(min(1.0, 3.0 / n), 4)
    return wilson_ci95(k, n)[1]


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
    for d in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
        cand = pathlib.Path(d) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def run_tsx(args: list[str], stdin_txt: str) -> str:
    shm_dir = "/dev/shm" if os.path.isdir("/dev/shm") else None
    with tempfile.TemporaryDirectory(prefix="holdup-tsx-", dir=shm_dir) as tmpd:
        ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL, TMPDIR=tmpd)
        proc = subprocess.run([find_node(), "--import", "tsx", *args], input=stdin_txt, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
        return proc.stdout


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 13) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size))
    d, rng = ImageDraw.Draw(im), random.Random(seed + 23)
    hz = int(size * 0.58)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(232 - 20 * t), int(229 - 18 * t), int(222 - 16 * t)))
    for y in range(hz, size):
        t, j = (y - hz) / max(1, size - hz), rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(178 - 24 * t) + j, int(154 - 20 * t) + j, int(126 - 18 * t) + j))
    d.line((0, hz, size, hz), fill=(132, 110, 88), width=3)
    bk = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(bk).ellipse((36, 28, 240, 210), fill=(255, 250, 240, 48))
    return Image.alpha_composite(im.convert("RGBA"), bk.filter(ImageFilter.GaussianBlur(radius=22.0))).convert("RGB")


def draw_device_graphic(cd: ImageDraw.ImageDraw, dev: str, accent: tuple[int, int, int], bw: int, bh: int) -> None:
    gx0 = bw - 142
    gy0 = 156
    if dev == "orion_easyhaler_dpi":
        cd.rounded_rectangle((gx0 + 28, gy0, gx0 + 92, gy0 + 168), radius=12, fill=(235, 240, 246), outline=(120, 130, 144), width=2)
        cd.rounded_rectangle((gx0 + 24, gy0, gx0 + 96, gy0 + 44), radius=10, fill=accent)
        cd.rounded_rectangle((gx0 + 8, gy0 + 132, gx0 + 92, gy0 + 178), radius=10, fill=accent)
        cd.rectangle((gx0 + 44, gy0 + 74, gx0 + 76, gy0 + 98), fill=(252, 252, 250), outline=(90, 98, 110), width=2)
    elif dev == "metered_dose_inhaler":
        cd.rounded_rectangle((gx0 + 36, gy0, gx0 + 88, gy0 + 62), radius=8, fill=(198, 206, 216), outline=(108, 116, 128), width=2)
        cd.rounded_rectangle((gx0 + 26, gy0 + 48, gx0 + 98, gy0 + 172), radius=12, fill=accent)
        cd.rounded_rectangle((gx0 + 4, gy0 + 128, gx0 + 96, gy0 + 176), radius=10, fill=accent)
    elif dev == "diskus_dpi":
        cd.ellipse((gx0 + 4, gy0 + 26, gx0 + 120, gy0 + 142), fill=accent, outline=(62, 34, 98), width=3)
        cd.ellipse((gx0 + 32, gy0 + 54, gx0 + 92, gy0 + 114), fill=(228, 222, 238), outline=(92, 64, 128), width=2)
        cd.rectangle((gx0 + 50, gy0 + 34, gx0 + 74, gy0 + 50), fill=(252, 250, 255), outline=(70, 50, 96), width=2)
    elif dev == "turbuhaler_dpi":
        cd.polygon([(gx0 + 46, gy0 + 4), (gx0 + 78, gy0 + 4), (gx0 + 90, gy0 + 52), (gx0 + 34, gy0 + 52)], fill=(242, 244, 248), outline=(128, 134, 144))
        cd.rectangle((gx0 + 34, gy0 + 52, gx0 + 90, gy0 + 144), fill=(245, 246, 250), outline=(128, 134, 144), width=2)
        cd.rounded_rectangle((gx0 + 30, gy0 + 140, gx0 + 94, gy0 + 178), radius=8, fill=accent)
        cd.rectangle((gx0 + 50, gy0 + 88, gx0 + 74, gy0 + 108), fill=(255, 248, 248), outline=(120, 80, 84), width=2)
    elif dev == "nasal_spray":
        cd.polygon([(gx0 + 52, gy0 + 4), (gx0 + 72, gy0 + 4), (gx0 + 80, gy0 + 54), (gx0 + 44, gy0 + 54)], fill=(242, 247, 248), outline=(118, 132, 136))
        cd.rounded_rectangle((gx0 + 28, gy0 + 54, gx0 + 96, gy0 + 174), radius=16, fill=(236, 245, 246), outline=(112, 130, 134), width=2)
        cd.polygon([(gx0 + 94, gy0 + 72), (gx0 + 118, gy0 + 84), (gx0 + 94, gy0 + 112)], fill=accent)


def apply_thumb_over_strength(frame: Image.Image, x0: int, y0: int) -> Image.Image:
    rgba = frame.convert("RGBA")
    w, h = rgba.size
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    tx1 = x0 + 168
    ty0 = y0 + 194
    ty1 = y0 + 318
    sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((-30, ty0 + 8, tx1 + 14, ty1 + 18), radius=58, fill=(24, 16, 12, 135))
    rgba = Image.alpha_composite(rgba, sh.filter(ImageFilter.GaussianBlur(radius=10.0)))
    od.rounded_rectangle((-40, ty0, tx1, ty1), radius=56, fill=(214, 166, 140, 255), outline=(168, 120, 96, 255), width=3)
    od.rounded_rectangle((tx1 - 76, ty0 + 18, tx1 - 14, ty1 - 20), radius=24, fill=(236, 202, 184, 255), outline=(188, 144, 122, 255), width=2)
    od.line((tx1 - 96, ty0 + 22, tx1 - 96, ty1 - 22), fill=(176, 128, 104, 190), width=3)
    od.line((tx1 - 108, ty0 + 28, tx1 - 108, ty1 - 28), fill=(182, 134, 110, 160), width=2)
    return Image.alpha_composite(rgba, ov).convert("RGB")


def render_metallic_canister_glare(case: dict[str, Any], seed: int) -> Image.Image:
    size = 768
    bg = render_backdrop(size, seed)
    arr = np.asarray(bg, dtype=np.float32)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cx0, cx1 = 208, 560
    cy0, cy1 = 76, 616
    cw = cx1 - cx0
    ch = cy1 - cy0
    can = np.zeros((ch, cw, 3), dtype=np.float32)
    xc = np.linspace(-1.0, 1.0, cw, dtype=np.float32)[None, :]
    cyl = 186.0 + 46.0 * np.cos(xc * 1.35) + 18.0 * np.exp(-0.5 * (((xc + 0.28) / 0.18) ** 2))
    rng = np.random.default_rng(seed + 71)
    brush = rng.normal(0.0, 2.2, size=(ch, 1)).astype(np.float32)
    for c_i, tint in enumerate((-4.0, 0.0, 6.0)):
        can[:, :, c_i] = np.clip(cyl + brush + tint, 110.0, 248.0)
    can_im = Image.fromarray(can.astype(np.uint8), mode="RGB")
    cd = ImageDraw.Draw(can_im)
    cd.rectangle((0, 38, cw, 196), fill=(244, 248, 252))
    cd.rectangle((0, 38, cw, 78), fill=case["accent"])
    cd.text((22, 48), case["hdr"], fill=(250, 252, 255), font=ImageFont.load_default(size=20))
    cd.text((22, 92), case["title"], fill=(12, 18, 28), font=fit_font(cd, case["title"], cw - 44, 30))
    cd.text((22, 138), case["sub"], fill=(30, 40, 54), font=fit_font(cd, case["sub"], cw - 44, 21))
    cd.rounded_rectangle((18, 224, cw - 18, 314), radius=10, fill=(236, 243, 250), outline=case["accent"], width=3)
    f_unit = ImageFont.load_default(size=30)
    uw = int(cd.textlength("mikrog/annos", font=f_unit))
    cd.text((cw - 32 - uw, 252), "mikrog/annos", fill=(16, 22, 32), font=f_unit)
    cd.text((24, 340), "200 annosta / 200 doses", fill=(24, 32, 44), font=ImageFont.load_default(size=22))
    cd.rounded_rectangle((22, 392, cw - 22, 446), radius=8, fill=(246, 248, 252), outline=(130, 140, 152), width=2)
    cd.text((38, 406), case["exp"], fill=(14, 20, 28), font=ImageFont.load_default(size=24))
    c_arr = np.asarray(can_im, dtype=np.float32)
    gy, gx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    streak_cx = 82.0 + 0.06 * (gy - 268.0)
    dx_g = (gx - streak_cx) / 48.0
    dy_g = (gy - 268.0) / 46.0
    core = np.exp(-0.5 * (dx_g * dx_g + dy_g * dy_g))
    axial = np.exp(-0.5 * (((gx - 84.0) / 28.0) ** 2)) * np.exp(-0.5 * (((gy - 268.0) / 118.0) ** 2))
    glare = np.clip(1.65 * core + 0.85 * axial, 0.0, 1.0)
    c_arr = c_arr * (1.0 - glare[:, :, None]) + 255.0 * glare[:, :, None]
    can_final = Image.fromarray(np.clip(np.round(c_arr), 0.0, 255.0).astype(np.uint8), mode="RGB")
    scene = Image.fromarray(arr.astype(np.uint8), mode="RGB").convert("RGBA")
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((cx0 + 14, cy0 + 18, cx1 + 18, cy1 + 90), radius=24, fill=(20, 18, 16, 110))
    scene = Image.alpha_composite(scene, sh.filter(ImageFilter.GaussianBlur(radius=14.0)))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cmask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(cmask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=22, fill=255)
    layer.paste(can_final, (cx0, cy0), cmask)
    bd = ImageDraw.Draw(layer)
    bd.rounded_rectangle((cx0 - 18, cy1 - 36, cx1 + 18, cy1 + 92), radius=22, fill=(28, 98, 168, 255), outline=(16, 66, 118, 255), width=3)
    return Image.alpha_composite(scene, layer.rotate(float(case["tilt"]), resample=Image.Resampling.BICUBIC)).convert("RGB")


def apply_heavy_tremor_blur(im: Image.Image) -> Image.Image:
    arr = np.asarray(im.filter(ImageFilter.GaussianBlur(radius=5.5)), dtype=np.float32)
    h, w, _ = arr.shape
    acc = np.zeros_like(arr)
    wsum = 0.0
    steps = 25
    for i in range(steps):
        t = (i / (steps - 1)) * 2.0 - 1.0
        sx = int(round(t * 34.0 + 7.0 * math.sin(t * 4.5)))
        sy = int(round(t * 19.0 + 6.0 * math.cos(t * 3.8)))
        wt = 1.15 - 0.35 * abs(t)
        shifted = np.roll(np.roll(arr, sy, axis=0), sx, axis=1)
        if sy > 0:
            shifted[:sy, :, :] = arr[0:1, :, :]
        elif sy < 0:
            shifted[h + sy:, :, :] = arr[-1:, :, :]
        if sx > 0:
            shifted[:, :sx, :] = shifted[:, sx:sx + 1, :]
        elif sx < 0:
            shifted[:, w + sx:, :] = shifted[:, w + sx - 1:w + sx, :]
        acc += shifted * wt
        wsum += wt
    out = Image.fromarray(np.clip(np.round(acc / wsum), 0.0, 255.0).astype(np.uint8), mode="RGB")
    return out.filter(ImageFilter.GaussianBlur(radius=3.2))


def render_case(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 6200 + idx * 31
    if case["failure_mode"] == "metallic_canister_specular_glare":
        return render_metallic_canister_glare(case, seed)
    pad, size = 84, 936
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 108, pad + 704, pad + 660
    bw, bh = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=16, fill=(24, 20, 16, 98))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card = Image.new("RGB", (bw, bh), case["bg"])
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 58), fill=case["accent"])
    cd.text((28, 17), case["hdr"], fill=(250, 252, 255), font=fit_font(cd, case["hdr"], bw - 56, 22))
    cd.text((32, 76), case["title"], fill=(12, 16, 24), font=fit_font(cd, case["title"], bw - 64, 42))
    cd.text((32, 134), case["sub"], fill=(30, 38, 50), font=fit_font(cd, case["sub"], bw - 64, 21))
    draw_device_graphic(cd, case["device_type"], case["accent"], bw, bh)
    sx0, sy0, sx1, sy1 = 30, 198, 466, 304
    cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=(238, 245, 252), outline=case["accent"], width=4)
    if case["str"]:
        f_str = fit_font(cd, case["str"], sx1 - sx0 - 36, 38)
        cd.text((sx0 + 18, sy0 + 16), case["str"], fill=(10, 14, 22), font=f_str)
        cd.text((sx0 + 18, sy0 + 66), case["str_sub"], fill=(40, 50, 64), font=fit_font(cd, case["str_sub"], sx1 - sx0 - 36, 19))
    else:
        f_unit = ImageFont.load_default(size=34)
        uw = int(cd.textlength("mikrog/annos", font=f_unit))
        cd.text((sx1 - 24 - uw, sy0 + 22), "mikrog/annos", fill=(10, 14, 22), font=f_unit)
        cd.text((sx1 - 24 - uw, sy0 + 68), case["str_sub"], fill=(40, 50, 64), font=ImageFont.load_default(size=19))
    if case["counter"]:
        is_trap = case["category"] == "dose_counter_distractor"
        cy_top = 324
        cy_bot = 398 if is_trap else 380
        c_fill = (255, 242, 206) if is_trap else (244, 246, 250)
        c_out = (204, 122, 18) if is_trap else (146, 154, 168)
        cd.rounded_rectangle((30, cy_top, 466, cy_bot), radius=10, fill=c_fill, outline=c_out, width=3 if is_trap else 2)
        c_font = fit_font(cd, case["counter"], 408, 33 if is_trap else 24)
        cd.text((46, cy_top + (16 if is_trap else 14)), case["counter"], fill=(20, 22, 26), font=c_font)
        cd.text((32, cy_bot + 18), case["pack"], fill=(36, 44, 56), font=fit_font(cd, case["pack"], 430, 21))
    else:
        cd.text((32, 336), case["pack"], fill=(34, 42, 54), font=fit_font(cd, case["pack"], 440, 23))
    if case["exp"]:
        ex_w = 304
        cd.rounded_rectangle((bw - ex_w - 26, bh - 92, bw - 26, bh - 34), radius=8, fill=(244, 246, 250), outline=(142, 150, 162), width=2)
        cd.text((bw - ex_w - 8, bh - 76), case["exp"], fill=(14, 20, 28), font=fit_font(cd, case["exp"], ex_w - 28, 24))
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    cropped = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(float(case["tilt"]), resample=Image.Resampling.BICUBIC)).convert("RGB").crop((pad, pad, pad + 768, pad + 768))
    if case["failure_mode"] == "thumb_over_mikrog_annos_digits":
        return apply_thumb_over_strength(cropped, x0 - pad, y0 - pad)
    if case["failure_mode"] == "heavy_tremor_motion_blur":
        return apply_heavy_tremor_blur(cropped)
    return cropped


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
    sess, last, timed_out = requests.Session(), "failed", False
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
                    return {"ok": True, "timeout": False, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "timeout": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "timeout": timed_out, "err": last, "ms": 0.0}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false }; '
        '})));'
    )
    s1 = run_tsx(["--input-type=module", "-e", norm_js], json.dumps({"rows": raw_rows}))
    normed = [sanitize(x) for x in json.loads(s1)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    s2 = run_tsx([BRIDGE_REL], bridge_in)
    verdicts = [sanitize(json.loads(ln)) for ln in s2.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py and not KEY_RE.search(src_py)
    if README_PATH.is_file():
        rd_txt = README_PATH.read_text(encoding="utf-8")
        assert EM_DASH not in rd_txt and EN_DASH not in rd_txt and not KEY_RE.search(rd_txt)
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["errors"] == 0 and s["timeouts"] == 0
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    s_out = run_tsx([BRIDGE_REL], bridge_in)
    re_verdicts = [json.loads(ln) for ln in s_out.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--verify-cached", dest="verify_cached", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.verify_cached or args.offline:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        im = render_case(c, idx)
        assert im.size == (768, 768)
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
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    timeouts = sum(1 if o.get("timeout") else 0 for o in api_outs)
    if errors or timeouts:
        raise RuntimeError(f"API errors={errors} timeouts={timeouts}")
    scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["degraded"]:
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
        else:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "device_type": c["device_type"],
            "failure_mode": c["failure_mode"],
            "description": c["desc"],
            "question": c["q"],
            "expected_level": c["expected"],
            "predicted_level": pred,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} str={s_val}({s_conf:.2f}) ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    clean = [x for x in cases_out if x["category"] != "degraded_zero_guess"]
    warns = [x for x in cases_out if x["expected_level"] == "warning"]
    deg = [x for x in cases_out if x["category"] == "degraded_zero_guess"]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "confident_wrong_rule_of_three_95_upper": rule_of_three_upper95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "errors": errors,
        "timeouts": timeouts,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "readable_case_accuracy": round(sum(1 for x in clean if x["verdict_ok"]) / len(clean), 4),
        "warning_recall": round(sum(1 for x in warns if x["predicted_level"] == "warning") / len(warns), 4),
        "degraded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
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
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) > 15200:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
