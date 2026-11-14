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

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SHM_DIR = pathlib.Path("/dev/shm")
OUT_IMG_DIR = SHM_DIR / "holdup_insulin_inhaler"
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
SUITE_NAME = "insulin_inhaler_high_alert"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
MAX_WORKERS = 3
NOW_ISO = "2026-11-14T16:00:00+02:00"
TAKEN_TS_MS = int(datetime.datetime.fromisoformat("2026-11-14T15:15:00+02:00").timestamp() * 1000)
STRENGTH_MIN_CONF = 0.80
MAX_JSON_BYTES = 15000
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "glargine", "name": "Lantus", "ingredient": "glargine", "strength": "100 IU/ml", "schedule": ["evening"]},
        {"id": "budesonide", "name": "Pulmicort", "ingredient": "budesonide", "strength": "200 mcg", "schedule": ["morning", "evening"]},
        {"id": "salbutamol", "name": "Ventoline", "ingredient": "salbutamol", "strength": "100 mcg", "schedule": ["morning"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

TAKEN_PROFILE: dict[str, Any] = {
    **PROFILE,
    "doseLog": [{"medId": "glargine", "ts": TAKEN_TS_MS}],
}

SPECS: dict[str, dict[str, Any]] = {
    "lantus_pen_100": {
        "shape": "pen",
        "accent": (98, 54, 142),
        "hdr": "SANOFI    SoloStar",
        "title": "LANTUS SoloStar",
        "sub": "insulin glargine",
        "str": "100 IU/ml",
        "dose": "Once daily subcutaneous injection",
        "pack": "Pre-filled pen",
        "exp": "EXP 2027-11",
    },
    "abasaglar_carton_100_ky": {
        "shape": "carton",
        "accent": (32, 114, 128),
        "hdr": "LILLY    Vnr 51 84 20",
        "title": "ABASAGLAR KwikPen",
        "sub": "insuliiniglargiini / insulin glargine",
        "str": "100 KY/ml",
        "dose": "1 pistos iltaisin ihon alle",
        "pack": "Esitaytetty kyna",
        "exp": "EXP 2027-10",
    },
    "toujeo_pen_300": {
        "shape": "pen",
        "accent": (36, 108, 72),
        "hdr": "SANOFI    SoloStar",
        "title": "TOUJEO SoloStar",
        "sub": "insulin glargine",
        "str": "300 IU/ml",
        "dose": "Concentrated basal insulin",
        "pack": "Pre-filled pen",
        "exp": "EXP 2027-11",
    },
    "novorapid_pen_100": {
        "shape": "pen",
        "accent": (208, 96, 24),
        "hdr": "NOVO NORDISK    FlexPen",
        "title": "NovoRapid FlexPen",
        "sub": "insulin aspart",
        "str": "100 IU/ml",
        "dose": "Rapid-acting mealtime insulin",
        "pack": "Pre-filled pen",
        "exp": "EXP 2027-09",
    },
    "pulmicort_dpi_200": {
        "shape": "dpi",
        "accent": (166, 78, 52),
        "hdr": "ASTRAZENECA  Vnr 04 18 22",
        "title": "PULMICORT",
        "form": "Turbuhaler",
        "sub": "budesonidi / budesonide",
        "str": "200 mikrog",
        "dose": "1 inhalaatio aamuin illoin",
        "pack": "Inhalaatiojauhe",
        "exp": "EXP 2027-08",
    },
    "ventoline_mdi_100": {
        "shape": "mdi",
        "accent": (28, 98, 174),
        "hdr": "GSK    Vnr 09 61 40",
        "title": "VENTOLINE",
        "form": "Evohaler",
        "sub": "salbutamoli / salbutamol",
        "str": "100 mikrog",
        "dose": "Inhalaatiosumute hengitykseen",
        "pack": "Inhalaatiosumute",
        "exp": "EXP 2027-09",
    },
    "pulmicort_dpi_400": {
        "shape": "dpi",
        "accent": (166, 78, 52),
        "hdr": "ASTRAZENECA  Vnr 04 18 55",
        "title": "PULMICORT",
        "form": "Turbuhaler",
        "sub": "budesonidi / budesonide",
        "str": "400 mikrog",
        "dose": "1 inhalaatio aamuin illoin",
        "pack": "Inhalaatiojauhe",
        "exp": "EXP 2027-08",
    },
    "lantus_carton_expired": {
        "shape": "carton",
        "accent": (98, 54, 142),
        "hdr": "SANOFI    Vnr 01 44 82",
        "title": "LANTUS SoloStar",
        "sub": "insuliiniglargiini / insulin glargine",
        "str": "100 IU/ml",
        "dose": "1 injection in the evening",
        "pack": "Pre-filled pen carton",
        "exp": "EXP 2025-05",
    },
    "lantus_carton_valid": {
        "shape": "carton",
        "accent": (98, 54, 142),
        "hdr": "SANOFI    Vnr 01 44 82",
        "title": "LANTUS SoloStar",
        "sub": "insuliiniglargiini / insulin glargine",
        "str": "100 IU/ml",
        "dose": "1 injection in the evening",
        "pack": "Pre-filled pen carton",
        "exp": "EXP 2027-11",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ih_01",
        "category": "matching_basal_pen_iu",
        "degraded": False,
        "mode": "sharp",
        "spec": "lantus_pen_100",
        "taken": False,
        "q": "Is this my evening basal insulin pen?",
        "expected": "match",
        "exp_str": "100 IU/ml",
        "desc": "Sharp Lantus SoloStar insulin glargine 100 IU/ml pen matching evening basal profile",
    },
    {
        "id": "ih_02",
        "category": "nordic_ky_iu_equivalence",
        "degraded": False,
        "mode": "sharp",
        "spec": "abasaglar_carton_100_ky",
        "taken": False,
        "q": "Is this my evening insulin?",
        "expected": "match",
        "exp_str": "100 IU/ml",
        "desc": "Sharp Finnish Abasaglar insulin glargine 100 KY/ml carton equivalent to 100 IU/ml profile",
    },
    {
        "id": "ih_03",
        "category": "concentrated_u300_pen",
        "degraded": False,
        "mode": "sharp",
        "spec": "toujeo_pen_300",
        "taken": False,
        "q": "Is this my evening basal insulin pen?",
        "expected": "warning",
        "exp_str": "300 IU/ml",
        "desc": "Concentrated Toujeo SoloStar insulin glargine 300 IU/ml U-300 pen against 100 IU/ml profile",
    },
    {
        "id": "ih_04",
        "category": "rapid_vs_basal_lookalike",
        "degraded": False,
        "mode": "sharp",
        "spec": "novorapid_pen_100",
        "taken": False,
        "q": "Is this my evening basal insulin pen?",
        "expected": "warning",
        "exp_str": "100 IU/ml",
        "desc": "Rapid-acting NovoRapid FlexPen insulin aspart 100 IU/ml look-alike held instead of basal glargine",
    },
    {
        "id": "ih_05",
        "category": "matching_dpi_mikrog_mcg",
        "degraded": False,
        "mode": "sharp",
        "spec": "pulmicort_dpi_200",
        "taken": False,
        "q": "Is this my maintenance steroid inhaler?",
        "expected": "match",
        "exp_str": "200 mikrog",
        "desc": "Sharp Pulmicort Turbuhaler budesonide 200 mikrog dry-powder inhaler matching 200 mcg profile",
    },
    {
        "id": "ih_06",
        "category": "matching_mdi_salbutamol",
        "degraded": False,
        "mode": "sharp",
        "spec": "ventoline_mdi_100",
        "taken": False,
        "q": "Is this my morning Ventoline rescue inhaler?",
        "expected": "match",
        "exp_str": "100 mikrog",
        "desc": "Sharp Ventoline Evohaler salbutamol 100 mikrog metered inhaler matching 100 mcg profile",
    },
    {
        "id": "ih_07",
        "category": "wrong_strength_inhaler",
        "degraded": False,
        "mode": "sharp",
        "spec": "pulmicort_dpi_400",
        "taken": False,
        "q": "Is this my maintenance steroid inhaler?",
        "expected": "warning",
        "exp_str": "400 mikrog",
        "desc": "Wrong-strength Pulmicort Turbuhaler budesonide 400 mikrog inhaler against 200 mcg profile",
    },
    {
        "id": "ih_08",
        "category": "expired_insulin_carton",
        "degraded": False,
        "mode": "sharp",
        "spec": "lantus_carton_expired",
        "taken": False,
        "q": "Can I use this Lantus insulin pen carton tonight?",
        "expected": "warning",
        "exp_str": "100 IU/ml",
        "desc": "Expired Lantus SoloStar insulin glargine 100 IU/ml carton with EXP 2025-05",
    },
    {
        "id": "ih_09",
        "category": "already_taken_basal_insulin",
        "degraded": False,
        "mode": "sharp",
        "spec": "lantus_carton_valid",
        "taken": True,
        "q": "Did I already take my evening basal insulin?",
        "expected": "warning",
        "exp_str": "100 IU/ml",
        "desc": "Valid Lantus SoloStar 100 IU/ml carton when today's evening glargine dose is already logged",
    },
    {
        "id": "ih_10",
        "category": "thumb_occluded_pen_concentration",
        "degraded": True,
        "mode": "thumb_pen",
        "spec": "lantus_pen_100",
        "taken": False,
        "q": "Is this my 100 IU/ml evening insulin pen?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Insulin glargine pen barrel with thumb covering concentration digits before IU/ml",
    },
    {
        "id": "ih_11",
        "category": "glare_inhaler_microgram_badge",
        "degraded": True,
        "mode": "glare_inhaler",
        "spec": "pulmicort_dpi_200",
        "taken": False,
        "q": "Is this my 200 mcg steroid inhaler?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Pulmicort Turbuhaler with bright specular glare washing out the microgram badge",
    },
    {
        "id": "ih_12",
        "category": "heavy_motion_blur",
        "degraded": True,
        "mode": "motion_blur",
        "spec": "ventoline_mdi_100",
        "taken": False,
        "q": "Which inhaler am I holding right now?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Handheld metered inhaler with heavy directional motion blur smearing all text and dose digits",
    },
]


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
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
        s = KEY_RE.sub(
            "[REDACTED]",
            v.replace(EM_DASH, " - ").replace(EN_DASH, "-").replace("\u00b5", "u").replace("\u03bc", "u"),
        )
        return s.encode("ascii", "ignore").decode("ascii")
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
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def format_results_json(payload: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in payload.items() if k != "cases"}, indent=2, ensure_ascii=True)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=True, separators=(",", ":")) for c in payload["cases"])
    return top[:-2] + ',\n  "cases": [\n' + rows + "\n  ]\n}\n"


def render_counter(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (224, 219, 210))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(296):
        c = int(236 - 22 * (y / 296))
        d.line((0, y, 768, y), fill=(c, c - 4, c - 8))
    for y in range(296, 768):
        t, j = (y - 296) / 472, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(184 - 28 * t) + j, int(156 - 24 * t) + j, int(126 - 20 * t) + j))
    d.line((0, 296, 768, 296), fill=(124, 102, 80), width=3)
    d.rounded_rectangle((616, 174, 712, 290), radius=12, fill=(92, 118, 138), outline=(64, 88, 106), width=2)
    d.rounded_rectangle((54, 212, 134, 290), radius=10, fill=(198, 194, 186), outline=(154, 148, 140), width=2)
    return im.filter(ImageFilter.GaussianBlur(radius=2.4))


def draw_insulin_pen(sc: Image.Image, spec: dict[str, Any], occlude_digits: bool = False) -> Image.Image:
    d = ImageDraw.Draw(sc)
    d.rounded_rectangle((318, 444, 412, 746), radius=34, fill=(208, 166, 138), outline=(170, 130, 102), width=2)
    d.rounded_rectangle((416, 452, 506, 748), radius=34, fill=(202, 160, 132), outline=(166, 126, 98), width=2)
    d.rounded_rectangle((170, 258, 638, 468), radius=18, fill=(84, 72, 60))
    d.rounded_rectangle((44, 338, 76, 378), radius=6, fill=(192, 198, 206), outline=(128, 134, 142), width=2)
    d.rounded_rectangle((72, 286, 172, 430), radius=12, fill=(224, 236, 244), outline=(138, 148, 158), width=3)
    d.rectangle((92, 294, 114, 422), fill=(116, 122, 130))
    for tx in range(122, 166, 12):
        d.line((tx, 300, tx, 318), fill=(88, 96, 106), width=2)
    d.rounded_rectangle((166, 250, 636, 462), radius=16, fill=(238, 240, 245), outline=(146, 152, 162), width=3)
    d.rectangle((170, 254, 632, 266), fill=(216, 220, 228))
    d.rectangle((170, 446, 632, 458), fill=(198, 204, 214))
    d.rounded_rectangle((634, 266, 694, 446), radius=10, fill=(214, 218, 226), outline=(136, 142, 152), width=2)
    d.rounded_rectangle((644, 330, 686, 382), radius=5, fill=(250, 252, 254), outline=(82, 88, 96), width=2)
    d.text((657, 338), "0", fill=(18, 22, 28), font=ImageFont.load_default(size=28))
    d.rounded_rectangle((692, 286, 738, 426), radius=14, fill=spec["accent"], outline=(48, 52, 58), width=2)
    d.rounded_rectangle((182, 264, 622, 448), radius=8, fill=(252, 253, 255), outline=(168, 174, 182), width=2)
    d.rectangle((182, 264, 622, 298), fill=spec["accent"])
    d.text((196, 270), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=18))
    d.text((196, 304), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=32))
    d.text((196, 342), spec["sub"], fill=(42, 50, 60), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((196, 374, 418, 434), radius=8, fill=(238, 244, 252), outline=spec["accent"], width=3)
    if occlude_digits:
        d.text((318, 384), "IU/ml", fill=(14, 20, 28), font=ImageFont.load_default(size=33))
    else:
        d.text((210, 384), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=34))
    d.text((434, 392), spec["exp"], fill=(22, 28, 36), font=ImageFont.load_default(size=22))
    if not occlude_digits:
        return sc
    ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.rounded_rectangle((196, 358, 316, 710), radius=38, fill=(76, 58, 46, 120))
    od.rounded_rectangle((190, 354, 312, 712), radius=38, fill=(214, 172, 144, 255), outline=(172, 130, 102, 255), width=3)
    od.rounded_rectangle((208, 366, 294, 422), radius=18, fill=(236, 208, 190, 255), outline=(188, 148, 122, 255), width=2)
    od.line((204, 466, 298, 466), fill=(176, 134, 108, 220), width=3)
    od.line((210, 478, 292, 478), fill=(184, 142, 116, 200), width=2)
    return Image.alpha_composite(sc.convert("RGBA"), ov).convert("RGB")


def draw_pen_carton(sc: Image.Image, spec: dict[str, Any]) -> Image.Image:
    w, h, x, y = 560, 404, 104, 238
    card = Image.new("RGB", (w, h), (251, 252, 254))
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, w, 54), fill=spec["accent"])
    cd.text((22, 16), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=20))
    cd.text((22, 70), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=38))
    cd.text((22, 120), spec["sub"], fill=(46, 54, 64), font=ImageFont.load_default(size=22))
    cd.rounded_rectangle((22, 164, 306, 238), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    cd.text((38, 178), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=40))
    cd.rounded_rectangle((344, 184, 514, 218), radius=8, fill=(230, 234, 240), outline=(150, 158, 168), width=2)
    cd.rounded_rectangle((512, 188, 534, 214), radius=5, fill=spec["accent"])
    cd.text((22, 262), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=21))
    cd.text((22, h - 54), f"{spec['pack']}    {spec['exp']}", fill=(20, 26, 34), font=ImageFont.load_default(size=23))
    sd = ImageDraw.Draw(sc)
    sd.rounded_rectangle((x + 6, y + 8, x + w + 6, y + h + 8), radius=10, fill=(90, 76, 62))
    sc.paste(card, (x, y))
    sd.rectangle((x, y, x + w - 1, y + h - 1), outline=(162, 168, 176), width=2)
    cx = x + int(w / 2)
    sd.rounded_rectangle((cx - 114, y + h - 14, cx - 28, y + h + 74), radius=28, fill=(212, 172, 144), outline=(176, 136, 108), width=2)
    sd.rounded_rectangle((cx + 28, y + h - 14, cx + 114, y + h + 74), radius=28, fill=(206, 166, 138), outline=(172, 132, 104), width=2)
    return sc


def draw_dpi_inhaler(sc: Image.Image, spec: dict[str, Any], glare_badge: bool = False) -> Image.Image:
    d = ImageDraw.Draw(sc)
    d.rounded_rectangle((220, 178, 562, 654), radius=22, fill=(88, 74, 62))
    d.polygon([(316, 66), (452, 66), (486, 152), (282, 152)], fill=(242, 244, 248), outline=(156, 162, 170))
    d.rounded_rectangle((256, 150, 512, 182), radius=8, fill=(224, 228, 236), outline=(150, 156, 166), width=2)
    d.rounded_rectangle((214, 180, 554, 548), radius=18, fill=(244, 246, 250), outline=(152, 158, 168), width=3)
    d.rectangle((218, 186, 232, 542), fill=(222, 226, 234))
    d.rectangle((536, 186, 550, 542), fill=(214, 218, 228))
    d.rounded_rectangle((228, 194, 540, 530), radius=8, fill=(252, 253, 255), outline=(174, 180, 188), width=2)
    d.rectangle((228, 194, 540, 236), fill=spec["accent"])
    d.text((240, 205), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=17))
    d.text((242, 248), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=35))
    d.text((242, 288), spec["form"], fill=(38, 46, 56), font=ImageFont.load_default(size=25))
    d.text((242, 324), spec["sub"], fill=(44, 52, 62), font=ImageFont.load_default(size=21))
    d.rounded_rectangle((242, 362, 524, 430), radius=8, fill=(246, 238, 234), outline=spec["accent"], width=3)
    if glare_badge:
        d.text((414, 380), "mikrog", fill=(196, 198, 204), font=ImageFont.load_default(size=28))
    else:
        d.text((258, 374), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=36))
    d.text((242, 446), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=19))
    d.text((242, 486), f"{spec['pack']}   {spec['exp']}", fill=(20, 26, 34), font=ImageFont.load_default(size=19))
    d.rounded_rectangle((208, 546, 560, 646), radius=14, fill=spec["accent"], outline=(112, 48, 30), width=3)
    for rx in range(226, 548, 18):
        d.line((rx, 552, rx, 640), fill=(132, 58, 38), width=3)
    d.rounded_rectangle((150, 492, 236, 594), radius=30, fill=(212, 172, 144), outline=(174, 134, 106), width=2)
    d.rounded_rectangle((532, 500, 622, 608), radius=30, fill=(206, 166, 138), outline=(170, 130, 102), width=2)
    if not glare_badge:
        return sc
    base_rgba = sc.convert("RGBA")
    halo = Image.new("RGBA", sc.size, (255, 255, 255, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((212, 330, 456, 462), fill=(255, 255, 255, 250))
    hd.polygon([(186, 392), (506, 368), (506, 412), (186, 424)], fill=(255, 255, 255, 236))
    halo = halo.filter(ImageFilter.GaussianBlur(radius=11.0))
    core = Image.new("RGBA", sc.size, (255, 255, 255, 0))
    ImageDraw.Draw(core).ellipse((232, 346, 426, 444), fill=(255, 255, 255, 255))
    core = core.filter(ImageFilter.GaussianBlur(radius=2.5))
    return Image.alpha_composite(Image.alpha_composite(base_rgba, halo), core).convert("RGB")


def draw_mdi_inhaler(sc: Image.Image, spec: dict[str, Any]) -> Image.Image:
    d = ImageDraw.Draw(sc)
    d.rounded_rectangle((228, 174, 552, 654), radius=22, fill=(84, 72, 60))
    d.rounded_rectangle((266, 76, 502, 180), radius=14, fill=(198, 204, 212), outline=(132, 138, 148), width=3)
    d.rectangle((296, 82, 332, 174), fill=(224, 228, 236))
    d.rounded_rectangle((222, 172, 546, 558), radius=20, fill=(74, 136, 204), outline=(38, 86, 146), width=3)
    d.rounded_rectangle((202, 554, 566, 648), radius=16, fill=(32, 82, 148), outline=(20, 56, 108), width=3)
    d.rounded_rectangle((238, 194, 530, 530), radius=8, fill=(252, 253, 255), outline=(164, 172, 184), width=2)
    d.rectangle((238, 194, 530, 236), fill=spec["accent"])
    d.text((252, 205), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=18))
    d.text((252, 248), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=35))
    d.text((252, 288), spec["form"], fill=(38, 46, 56), font=ImageFont.load_default(size=25))
    d.text((252, 324), spec["sub"], fill=(44, 52, 62), font=ImageFont.load_default(size=20))
    d.rounded_rectangle((252, 362, 514, 430), radius=8, fill=(236, 244, 254), outline=spec["accent"], width=3)
    d.text((268, 374), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=36))
    d.text((252, 446), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=18))
    d.text((252, 486), spec["exp"], fill=(20, 26, 34), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((148, 468, 234, 574), radius=30, fill=(212, 172, 144), outline=(174, 134, 106), width=2)
    d.rounded_rectangle((534, 474, 622, 584), radius=30, fill=(206, 166, 138), outline=(170, 130, 102), width=2)
    return sc


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261114 + idx * 53
    sc = render_counter(seed)
    spec = SPECS[case["spec"]]
    mode = case["mode"]
    if mode == "thumb_pen":
        return draw_insulin_pen(sc, spec, occlude_digits=True)
    if mode == "glare_inhaler":
        return draw_dpi_inhaler(sc, spec, glare_badge=True)
    if mode == "motion_blur":
        sharp_im = draw_mdi_inhaler(sc.copy(), spec)
        acc: Image.Image | None = None
        shifts = list(range(-96, 100, 4))
        for idx_s, dx in enumerate(shifts):
            shifted = sc.copy()
            dy = int((idx_s % 7) - 3) * 4
            shifted.paste(sharp_im, (dx, dy))
            acc = shifted if acc is None else Image.blend(acc, shifted, 1.0 / (idx_s + 1))
        assert acc is not None
        return acc.filter(ImageFilter.GaussianBlur(radius=8.0))
    shape = spec["shape"]
    if shape == "pen":
        return draw_insulin_pen(sc, spec, occlude_digits=False)
    if shape == "carton":
        return draw_pen_carton(sc, spec)
    if shape == "dpi":
        return draw_dpi_inhaler(sc, spec, glare_badge=False)
    return draw_mdi_inhaler(sc, spec)


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frame_b64: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [
        {"inlineData": {"mimeType": "image/jpeg", "data": frame_b64}},
        {"text": f'The person asked: "{question}"'},
    ]
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
            r = sess.post(
                url,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                json=payload,
                timeout=45,
            )
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next(
                    (p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()),
                    "",
                )
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timed_out": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timed_out": False}
            last = sanitize(f"HTTP {r.status_code}")
            timed_out = False
        except requests.Timeout as exc:
            last = sanitize(str(exc))
            timed_out = True
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
            timed_out = False
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timed_out": timed_out}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        "process.stdout.write(JSON.stringify(inp.rows.map((r) => { "
        "const read = toLabelRead(r.raw); "
        "return { id: r.id, read, taken: r.taken, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false }; "
        "})));"
    )
    p1 = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "-e", norm_js],
        input=json.dumps({"rows": raw_rows}),
        text=True,
        capture_output=True,
        cwd=str(REPO),
        check=True,
    )
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = (
        "\n".join(
            json.dumps(
                {
                    "read": r["read"],
                    "profile": TAKEN_PROFILE if r["taken"] else PROFILE,
                    "now": NOW_ISO,
                }
            )
            for r in normed
        )
        + "\n"
    )
    p2 = subprocess.run(
        [node, "--import", "tsx", BRIDGE_REL],
        input=bridge_in,
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL),
        check=True,
    )
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"
    assert not OUT_IMG_DIR.exists(), "temp /dev/shm dir was not cleaned up"
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.png")), "image files found in suite dir"
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= MAX_JSON_BYTES, f"results.json size {len(raw_bytes)} > {MAX_JSON_BYTES}"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    assert all(ord(ch) < 128 for ch in raw_txt), "non-ASCII in results.json"
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and len(data["profile"].get("meds") or []) == 3
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["api_error_count"] == 0 and s["timeout_count"] == 0
    bridge_in = (
        "\n".join(
            json.dumps(
                {
                    "read": c["read"],
                    "profile": c.get("profile", data["profile"]),
                    "now": c.get("eval_now_iso", data["eval_now_iso"]),
                }
            )
            for c in cases
        )
        + "\n"
    )
    proc = subprocess.run(
        [find_node(), "--import", "tsx", BRIDGE_REL],
        input=bridge_in,
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL),
        check=True,
    )
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(
        1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")
    ) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / s["n_cases"], 4)
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    assert SHM_DIR.is_dir(), "/dev/shm is required"
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    rendered: list[dict[str, Any]] = []
    api_outs: list[dict[str, Any]] = []
    try:
        OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        for idx, c in enumerate(CASES, 1):
            im = render_case_image(c, idx)
            jpg_path = OUT_IMG_DIR / f"{c['id']}.jpg"
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            jpg_path.write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(jpg_path.read_bytes()).decode("ascii")})
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    finally:
        shutil.rmtree(OUT_IMG_DIR, ignore_errors=True)
    api_errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    timeouts = sum(1 if (not o.get("ok") and o.get("timed_out")) else 0 for o in api_outs)
    if api_errors or timeouts:
        raise RuntimeError(f"API failures: errors={api_errors} timeouts={timeouts}")
    scored = score_with_ts_and_bridge(
        [
            {
                "id": r["case"]["id"],
                "raw": o["raw"],
                "exp_str": r["case"]["exp_str"],
                "taken": r["case"]["taken"],
            }
            for r, o in zip(rendered, api_outs)
        ]
    )
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
        entry: dict[str, Any] = {
            "id": c["id"],
            "category": c["category"],
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
        }
        if c["taken"]:
            entry["profile"] = TAKEN_PROFILE
        cases_out.append(sanitize(entry))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} str={s_val}@{s_conf} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    sharp = [x for x in cases_out if not next(c["degraded"] for c in CASES if c["id"] == x["id"])]
    deg = [x for x in cases_out if next(c["degraded"] for c in CASES if c["id"] == x["id"])]
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
        "api_error_count": api_errors,
        "timeout_count": timeouts,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "sharp_high_alert_accuracy": round(sum(1 for x in sharp if x["verdict_ok"]) / len(sharp), 4),
        "degraded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize(
        {
            "suite": SUITE_NAME,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": NOW_ISO,
            "model": MODEL,
            "thinking_level": THINKING_LEVEL,
            "concurrency": MAX_WORKERS,
            "prompt_source": PROMPT_SOURCE,
            "prompt_sha256_12": prompt_sha256_12,
            "safety_module": SAFETY_TS_REL,
            "profile": PROFILE,
            "summary": summary,
            "cases": cases_out,
        }
    )
    OUT_JSON.write_text(format_results_json(payload), encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
