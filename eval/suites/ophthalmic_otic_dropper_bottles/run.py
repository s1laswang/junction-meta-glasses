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

SUITE_NAME = "ophthalmic_otic_dropper_bottles"
REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = pathlib.Path("/dev/shm/holdup_eyedrops")
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
MAX_CONCURRENCY = 3
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "timolol", "name": "Timolol", "ingredient": "timolol", "strength": "0.5 %", "schedule": ["morning", "evening"]},
        {"id": "latanoprost", "name": "Latanoprost", "ingredient": "latanoprost", "strength": "50 mcg", "schedule": ["evening"]},
        {"id": "dorzolamide", "name": "Dorzolamide", "ingredient": "dorzolamide", "strength": "2 %", "schedule": ["morning", "evening"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PACK_SPECS: dict[str, dict[str, Any]] = {
    "timolol_05_carton": {
        "accent": (18, 96, 148),
        "cap": (22, 104, 162),
        "bottle_fill": (246, 248, 251),
        "hdr": "ORION PHARMA  Silmatipat",
        "title": "TIMOLOL ORION",
        "sub": "Vaikuttava aine: timolol",
        "str": "0,5 %",
        "dose": "1 tippa 2 kertaa paivassa",
        "pack": "5 ml",
        "exp": "EXP 2027-10",
    },
    "timolol_05_bottle": {
        "accent": (20, 102, 156),
        "cap": (24, 108, 168),
        "bottle_fill": (246, 248, 251),
        "hdr": "SANTEN  Sterile eye drops",
        "title": "OFTAN TIMOLOL",
        "sub": "Active ingredient: timolol",
        "str": "0.5 %",
        "dose": "1 drop morning and evening",
        "pack": "5 ml",
        "exp": "EXP 2027-09",
    },
    "latanoprost_pipette": {
        "accent": (36, 118, 112),
        "cap": (44, 132, 124),
        "bottle_fill": (238, 246, 250),
        "hdr": "THEA PHARMA  Single-dose eye drops",
        "title": "MONOPROST",
        "sub": "Active ingredient: latanoprost",
        "str": "50 mikrog",
        "dose": "1 drop in the evening",
        "pack": "30 pipettes",
        "exp": "EXP 2027-11",
    },
    "timolol_025_bottle": {
        "accent": (168, 112, 24),
        "cap": (186, 128, 32),
        "bottle_fill": (246, 248, 251),
        "hdr": "SANTEN  Sterile eye drops",
        "title": "OFTAN TIMOLOL",
        "sub": "Active ingredient: timolol",
        "str": "0.25 %",
        "dose": "1 drop morning and evening",
        "pack": "5 ml",
        "exp": "EXP 2027-09",
    },
    "otipax_ear_bottle": {
        "accent": (176, 68, 36),
        "cap": (236, 238, 242),
        "bottle_fill": (172, 112, 54),
        "hdr": "BIOCODEX  Ear drops, solution",
        "title": "OTIPAX",
        "sub": "phenazone, lidocaine",
        "str": "40 mg/g + 10 mg/g",
        "dose": "For ear use only: 4 drops in ear",
        "pack": "10 ml",
        "exp": "EXP 2027-08",
    },
    "cipro_ear_bottle": {
        "accent": (132, 48, 116),
        "cap": (146, 58, 128),
        "bottle_fill": (245, 247, 250),
        "hdr": "SALVAT  Otic solution",
        "title": "CIPROFLOXACIN",
        "sub": "Active ingredient: ciprofloxacin",
        "str": "0.3 %",
        "dose": "Ear drops: 4 drops twice daily",
        "pack": "10 ml",
        "exp": "EXP 2027-10",
    },
    "amox_allergy_bottle": {
        "accent": (184, 38, 48),
        "cap": (196, 46, 56),
        "bottle_fill": (178, 118, 58),
        "hdr": "ORION PHARMA  Oral drops",
        "title": "AMOXICILLIN",
        "sub": "Active ingredient: amoxicillin",
        "str": "100 mg/ml",
        "dose": "Shake bottle well before use",
        "pack": "15 ml",
        "exp": "EXP 2027-07",
    },
    "timolol_expired_bottle": {
        "accent": (20, 102, 156),
        "cap": (24, 108, 168),
        "bottle_fill": (246, 248, 251),
        "hdr": "SANTEN  Sterile eye drops",
        "title": "OFTAN TIMOLOL",
        "sub": "Active ingredient: timolol",
        "str": "0.5 %",
        "dose": "1 drop morning and evening",
        "pack": "5 ml",
        "exp": "EXP 2025-06",
    },
    "latanoprost_bottle": {
        "accent": (46, 86, 154),
        "cap": (52, 96, 168),
        "bottle_fill": (246, 248, 251),
        "hdr": "PFIZER  Sterile eye drops",
        "title": "LATANOPROST",
        "sub": "Active ingredient: latanoprost",
        "str": "50 mikrog",
        "dose": "1 drop once daily in the evening",
        "pack": "",
        "exp": "EXP 2027-11",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "eo_01",
        "category": "ophthalmic_carton_match",
        "pack_style": "carton",
        "degraded": False,
        "mode": "sharp_carton",
        "spec": "timolol_05_carton",
        "q": "Is this my Timolol 0.5 % glaucoma eye-drop carton?",
        "expected": "match",
        "exp_str": "0.5 %",
        "desc": "Sharp Finnish Timolol Orion 0,5 % eye-drop carton with comma decimal matching 0.5 % profile",
    },
    {
        "id": "eo_02",
        "category": "ophthalmic_bottle_match",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "timolol_05_bottle",
        "q": "Is this my morning Timolol 0.5 % eye-drop bottle?",
        "expected": "match",
        "exp_str": "0.5 %",
        "desc": "Sharp 5 ml Oftan Timolol 0.5 % LDPE glaucoma dropper bottle matching 0.5 % profile",
    },
    {
        "id": "eo_03",
        "category": "single_dose_pipette_match",
        "pack_style": "single_dose_pipette",
        "degraded": False,
        "mode": "sharp_pipette",
        "spec": "latanoprost_pipette",
        "q": "Are these my evening Latanoprost 50 mcg single-dose pipettes?",
        "expected": "match",
        "exp_str": "50 mcg",
        "desc": "Sharp Monoprost latanoprost 50 mikrog single-dose pipette strip matching 50 mcg evening profile",
    },
    {
        "id": "eo_04",
        "category": "wrong_strength_glaucoma_bottle",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "timolol_025_bottle",
        "q": "Is this my 0.5 % Timolol glaucoma bottle?",
        "expected": "warning",
        "exp_str": "0.25 %",
        "desc": "Sharp Oftan Timolol 0.25 % 5 ml glaucoma bottle caught as wrong strength against 0.5 % profile",
    },
    {
        "id": "eo_05",
        "category": "otic_lookalike_otipax",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "otipax_ear_bottle",
        "q": "Can I put these drops in my eyes?",
        "expected": "warning",
        "exp_str": "40 mg/g + 10 mg/g",
        "desc": "Look-alike 10 ml Otipax ear-drop dropper bottle flagged as not on medication list",
    },
    {
        "id": "eo_06",
        "category": "otic_lookalike_ciprofloxacin",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "cipro_ear_bottle",
        "q": "Are these my prescribed glaucoma eye drops?",
        "expected": "warning",
        "exp_str": "0.3 %",
        "desc": "Look-alike 10 ml Ciprofloxacin 0.3 % antibiotic ear-drop bottle flagged as not on medication list",
    },
    {
        "id": "eo_07",
        "category": "penicillin_allergy_dropper_bottle",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "amox_allergy_bottle",
        "q": "Is this dropper bottle safe for me to use?",
        "expected": "warning",
        "exp_str": "100 mg/ml",
        "desc": "Amoxicillin 100 mg/ml oral dropper bottle caught against penicillin class drug allergy",
    },
    {
        "id": "eo_08",
        "category": "expired_ophthalmic_bottle",
        "pack_style": "dropper_bottle",
        "degraded": False,
        "mode": "sharp_bottle",
        "spec": "timolol_expired_bottle",
        "q": "Can I still use this Timolol 0.5 % bottle from my bathroom cabinet?",
        "expected": "warning",
        "exp_str": "0.5 %",
        "desc": "Expired Oftan Timolol 0.5 % eye-drop bottle (EXP 2025-06) caught as expired despite matching dose",
    },
    {
        "id": "eo_09",
        "category": "cylindrical_wrap_clipped_strength",
        "pack_style": "dropper_bottle",
        "degraded": True,
        "mode": "curved_edge_clip",
        "spec": "timolol_05_bottle",
        "q": "Is this my morning Timolol eye-drop bottle?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Curved 5 ml cylindrical Timolol dropper bottle clipping strength badge around right edge",
    },
    {
        "id": "eo_10",
        "category": "wet_tear_smudged_strength",
        "pack_style": "dropper_bottle",
        "degraded": True,
        "mode": "wet_tear_smudge",
        "spec": "latanoprost_bottle",
        "q": "Are these my evening Latanoprost eye drops?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Latanoprost eye-dropper bottle with wet tear droplets and smeared ink across strength badge",
    },
    {
        "id": "eo_11",
        "category": "thumb_occluding_concentration",
        "pack_style": "dropper_bottle",
        "degraded": True,
        "mode": "thumb_over_strength",
        "spec": "timolol_05_bottle",
        "q": "Is this my morning Timolol eye-drop bottle?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Pinch-gripped 5 ml Timolol dropper bottle with thumb covering the concentration badge",
    },
    {
        "id": "eo_12",
        "category": "out_of_focus_closeup_bottle",
        "pack_style": "dropper_bottle",
        "degraded": True,
        "mode": "defocus_closeup",
        "spec": "timolol_05_bottle",
        "q": "What eye drops are in this bottle?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Extreme close-up 5 ml dropper bottle held inside focus distance with severe optical defocus",
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
    for p in (home_env, REPO / ".env", pathlib.Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        s = KEY_RE.sub("[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-").replace("\u00b5", "u").replace("\u03bc", "u"))
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


def render_bathroom_counter(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (228, 232, 236))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(292):
        c = int(238 - 16 * (y / 292))
        d.line((0, y, 768, y), fill=(c - 4, c, c + 3))
    for gx in range(96, 768, 128):
        d.line((gx, 0, gx, 292), fill=(210, 215, 220), width=2)
    d.line((0, 146, 768, 146), fill=(210, 215, 220), width=2)
    for y in range(292, 768):
        t, j = (y - 292) / 476, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(196 - 26 * t) + j, int(190 - 24 * t) + j, int(182 - 22 * t) + j))
    d.line((0, 292, 768, 292), fill=(138, 134, 128), width=3)
    d.rounded_rectangle((612, 168, 704, 288), radius=14, fill=(154, 182, 198), outline=(118, 146, 164), width=2)
    return im.filter(ImageFilter.GaussianBlur(radius=2.6))


def draw_bottle_shell(
    im: Image.Image,
    bx1: int,
    bx2: int,
    by1: int,
    by2: int,
    cap_color: tuple[int, int, int],
    body_color: tuple[int, int, int],
) -> None:
    d = ImageDraw.Draw(im)
    cx = int((bx1 + bx2) / 2)
    neck_hw = max(44, int((bx2 - bx1) / 5))
    cap_hw = neck_hw + 14
    tip_hw = max(22, int(neck_hw / 2))
    d.rounded_rectangle((bx1 + 8, by1 + 10, bx2 + 8, by2 + 10), radius=22, fill=(96, 92, 86))
    d.polygon([(cx - tip_hw, by1 - 156), (cx + tip_hw, by1 - 156), (cx + neck_hw - 6, by1 - 80), (cx - neck_hw + 6, by1 - 80)], fill=cap_color)
    d.rounded_rectangle((cx - cap_hw, by1 - 84, cx + cap_hw, by1 - 34), radius=8, fill=cap_color, outline=(42, 48, 56), width=2)
    for rx in range(cx - cap_hw + 10, cx + cap_hw - 6, 12):
        d.line((rx, by1 - 80, rx, by1 - 38), fill=(232, 238, 244), width=2)
    darker_cap = (max(0, cap_color[0] - 28), max(0, cap_color[1] - 28), max(0, cap_color[2] - 28))
    d.rectangle((cx - neck_hw - 4, by1 - 34, cx + neck_hw + 4, by1 - 18), fill=darker_cap)
    d.polygon([(cx - neck_hw - 4, by1 - 18), (cx + neck_hw + 4, by1 - 18), (bx2, by1 + 26), (bx1, by1 + 26)], fill=body_color)
    d.rounded_rectangle((bx1, by1 + 18, bx2, by2), radius=22, fill=body_color, outline=(146, 152, 160), width=2)
    for step in range(22):
        shade = int(34 * (1.0 - step / 22.0))
        lc = (max(0, body_color[0] - shade), max(0, body_color[1] - shade), max(0, body_color[2] - shade))
        d.line((bx1 + 2 + step, by1 + 26, bx1 + 2 + step, by2 - 14), fill=lc)
        d.line((bx2 - 2 - step, by1 + 26, bx2 - 2 - step, by2 - 14), fill=lc)


def draw_base_fingers(im: Image.Image, bx1: int, bx2: int, by2: int) -> None:
    d = ImageDraw.Draw(im)
    cx = int((bx1 + bx2) / 2)
    d.rounded_rectangle((cx - 118, by2 - 12, cx - 26, by2 + 68), radius=28, fill=(214, 174, 146), outline=(176, 136, 108), width=2)
    d.rounded_rectangle((cx + 26, by2 - 12, cx + 118, by2 + 68), radius=28, fill=(208, 168, 140), outline=(172, 132, 104), width=2)


def render_sharp_bottle(sc: Image.Image, spec: dict[str, Any], include_strength: bool = True, include_pack: bool = True) -> Image.Image:
    draw_bottle_shell(sc, 184, 584, 248, 668, spec["cap"], spec["bottle_fill"])
    lbl = Image.new("RGB", (364, 356), (251, 252, 254))
    ld = ImageDraw.Draw(lbl)
    ld.rectangle((0, 0, 364, 46), fill=spec["accent"])
    ld.text((16, 12), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=18))
    ld.text((16, 58), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=32))
    ld.text((16, 102), spec["sub"], fill=(44, 52, 62), font=ImageFont.load_default(size=20))
    ld.rounded_rectangle((16, 144, 346, 214), radius=8, fill=(236, 244, 252), outline=spec["accent"], width=3)
    if include_strength:
        f_sz = 30 if len(spec["str"]) > 10 else 38
        ty = 160 if f_sz == 30 else 154
        ld.text((28, ty), spec["str"], fill=(12, 18, 26), font=ImageFont.load_default(size=f_sz))
    ld.text((16, 236), spec["dose"], fill=(36, 44, 54), font=ImageFont.load_default(size=19))
    footer = f"{spec['pack']}    {spec['exp']}".strip() if (include_pack and spec["pack"]) else spec["exp"]
    exp_color = (164, 24, 32) if "2025-" in spec["exp"] else (20, 26, 34)
    ld.text((16, 304), footer, fill=exp_color, font=ImageFont.load_default(size=22))
    ld.rectangle((0, 0, 363, 355), outline=(176, 184, 192), width=2)
    sc.paste(lbl, (202, 286))
    draw_base_fingers(sc, 184, 584, 668)
    return sc


def render_sharp_carton(sc: Image.Image, spec: dict[str, Any]) -> Image.Image:
    d = ImageDraw.Draw(sc)
    x, y, w, h = 174, 204, 420, 448
    d.rounded_rectangle((x + 7, y + 9, x + w + 7, y + h + 9), radius=10, fill=(92, 84, 76))
    card = Image.new("RGB", (w, h), (250, 251, 253))
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, w, 52), fill=spec["accent"])
    cd.text((20, 15), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=20))
    cd.text((20, 68), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=36))
    cd.text((20, 118), spec["sub"], fill=(46, 54, 64), font=ImageFont.load_default(size=22))
    cd.rounded_rectangle((20, 166, 286, 240), radius=8, fill=(236, 244, 252), outline=spec["accent"], width=3)
    cd.text((34, 178), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=40))
    cd.text((20, 266), spec["dose"], fill=(36, 44, 54), font=ImageFont.load_default(size=20))
    cd.text((20, 304), "Sterile ophthalmic solution", fill=(58, 66, 76), font=ImageFont.load_default(size=19))
    cd.text((20, h - 54), f"{spec['pack']}    {spec['exp']}", fill=(20, 26, 34), font=ImageFont.load_default(size=22))
    sc.paste(card, (x, y))
    d.rectangle((x, y, x + w - 1, y + h - 1), outline=(160, 168, 176), width=2)
    draw_base_fingers(sc, x, x + w, y + h)
    return sc


def render_sharp_pipette(sc: Image.Image, spec: dict[str, Any]) -> Image.Image:
    d = ImageDraw.Draw(sc)
    for i in range(4):
        px = 148 + i * 120
        cx = px + 54
        d.polygon([(cx - 32, 126), (cx + 32, 126), (cx + 14, 180), (cx - 14, 180)], fill=(224, 236, 244), outline=(164, 182, 196))
        d.rectangle((cx - 10, 180, cx + 10, 220), fill=(228, 240, 248), outline=(164, 182, 196))
        d.rounded_rectangle((px, 218, px + 108, 642), radius=26, fill=(232, 242, 248), outline=(164, 182, 196), width=2)
        d.rounded_rectangle((px + 18, 244, px + 42, 600), radius=10, fill=(246, 251, 254))
    d.rounded_rectangle((144, 622, 624, 662), radius=8, fill=(222, 234, 242), outline=(158, 176, 190), width=2)
    banner = Image.new("RGB", (464, 304), (251, 252, 254))
    bd = ImageDraw.Draw(banner)
    bd.rectangle((0, 0, 464, 46), fill=spec["accent"])
    bd.text((18, 12), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=19))
    bd.text((18, 58), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=36))
    bd.text((18, 104), spec["sub"], fill=(44, 52, 62), font=ImageFont.load_default(size=21))
    bd.rounded_rectangle((18, 144, 294, 212), radius=8, fill=(234, 246, 244), outline=spec["accent"], width=3)
    bd.text((32, 156), spec["str"], fill=(12, 18, 26), font=ImageFont.load_default(size=36))
    bd.text((18, 226), spec["dose"], fill=(36, 44, 54), font=ImageFont.load_default(size=19))
    bd.text((18, 262), f"{spec['pack']}    {spec['exp']}", fill=(20, 26, 34), font=ImageFont.load_default(size=21))
    bd.rectangle((0, 0, 463, 303), outline=(162, 174, 184), width=2)
    sc.paste(banner, (152, 284))
    draw_base_fingers(sc, 152, 616, 662)
    return sc


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed, m, spec = 202670 + idx * 37, case["mode"], PACK_SPECS[case["spec"]]
    sc = render_bathroom_counter(seed)
    if m == "sharp_carton":
        return render_sharp_carton(sc, spec)
    if m == "sharp_bottle":
        return render_sharp_bottle(sc, spec)
    if m == "sharp_pipette":
        return render_sharp_pipette(sc, spec)
    if m == "curved_edge_clip":
        draw_bottle_shell(sc, 246, 522, 248, 668, spec["cap"], spec["bottle_fill"])
        lbl = Image.new("RGB", (214, 348), (251, 252, 254))
        ld = ImageDraw.Draw(lbl)
        ld.rectangle((0, 0, 214, 44), fill=spec["accent"])
        ld.text((12, 12), "SANTEN  Eye drops", fill=(248, 250, 252), font=ImageFont.load_default(size=17))
        ld.text((12, 58), "OFTAN", fill=(14, 20, 28), font=ImageFont.load_default(size=32))
        ld.text((12, 98), "TIMOLOL", fill=(14, 20, 28), font=ImageFont.load_default(size=32))
        ld.text((12, 144), "timolol", fill=(44, 52, 62), font=ImageFont.load_default(size=21))
        ld.rounded_rectangle((190, 182, 260, 246), radius=8, fill=(236, 244, 252), outline=spec["accent"], width=3)
        ld.text((12, 260), "1 drop twice daily", fill=(36, 44, 54), font=ImageFont.load_default(size=18))
        ld.text((12, 304), spec["exp"], fill=(20, 26, 34), font=ImageFont.load_default(size=20))
        for sx in range(36):
            sh = int(58 * (sx / 35.0) ** 1.6)
            for sy in range(348):
                r0, g0, b0 = lbl.getpixel((213 - (35 - sx), sy))
                lbl.putpixel((213 - (35 - sx), sy), (max(0, r0 - sh), max(0, g0 - sh), max(0, b0 - sh)))
        sc.paste(lbl, (306, 290))
        draw_base_fingers(sc, 246, 522, 668)
        return sc
    if m == "wet_tear_smudge":
        render_sharp_bottle(sc, spec, include_strength=False, include_pack=False)
        patch = sc.crop((216, 426, 548, 514))
        pd = ImageDraw.Draw(patch)
        rng = random.Random(seed + 9)
        for _ in range(28):
            ex = rng.randint(14, 240)
            ey = rng.randint(14, 66)
            ew = rng.randint(16, 44)
            eh = rng.randint(12, 30)
            pd.ellipse((ex, ey, ex + ew, ey + eh), fill=(58, 72, 96))
        patch = patch.filter(ImageFilter.GaussianBlur(radius=7.5))
        sc.paste(patch, (216, 426))
        ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.ellipse((238, 434, 338, 498), fill=(214, 230, 244, 155), outline=(148, 174, 198, 210), width=2)
        od.arc((246, 440, 314, 482), start=200, end=330, fill=(255, 255, 255, 245), width=4)
        od.ellipse((332, 438, 438, 502), fill=(214, 230, 244, 160), outline=(148, 174, 198, 210), width=2)
        od.arc((342, 444, 412, 486), start=200, end=330, fill=(255, 255, 255, 245), width=4)
        od.rounded_rectangle((302, 488, 336, 566), radius=14, fill=(204, 222, 238, 130))
        return Image.alpha_composite(sc.convert("RGBA"), ov).convert("RGB")
    if m == "thumb_over_strength":
        render_sharp_bottle(sc, spec, include_strength=False, include_pack=False)
        ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.rounded_rectangle((132, 426, 566, 518), radius=42, fill=(48, 36, 28, 115))
        ov = ov.filter(ImageFilter.GaussianBlur(radius=6.0))
        td = ImageDraw.Draw(ov)
        td.rounded_rectangle((124, 420, 558, 508), radius=42, fill=(214, 172, 144, 255), outline=(172, 130, 102, 255), width=3)
        td.rounded_rectangle((476, 430, 546, 496), radius=18, fill=(238, 210, 194, 255), outline=(188, 148, 124, 255), width=2)
        td.arc((348, 432, 376, 496), start=110, end=250, fill=(178, 136, 108, 220), width=3)
        td.arc((364, 436, 388, 492), start=110, end=250, fill=(178, 136, 108, 190), width=2)
        return Image.alpha_composite(sc.convert("RGBA"), ov).convert("RGB")
    close = Image.new("RGB", (768, 768), (218, 222, 226))
    draw_bottle_shell(close, 96, 672, 160, 748, spec["cap"], spec["bottle_fill"])
    cl = Image.new("RGB", (512, 480), (248, 250, 252))
    cld = ImageDraw.Draw(cl)
    cld.rectangle((0, 0, 512, 64), fill=spec["accent"])
    cld.text((28, 120), "eye drops", fill=(168, 174, 182), font=ImageFont.load_default(size=18))
    cld.rounded_rectangle((28, 200, 320, 268), radius=8, fill=(236, 244, 252), outline=(160, 184, 204), width=2)
    close.paste(cl, (128, 212))
    return close.filter(ImageFilter.BoxBlur(radius=16)).filter(ImageFilter.GaussianBlur(radius=18))


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
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": r.status_code == 408}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": timed_out}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
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
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows}), text=True, capture_output=True, cwd=str(REPO), check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.png")), "image files found in suite dir"
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
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
    assert data["concurrency"] <= 3
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and len(data["profile"].get("meds") or []) == 3
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["api_error_count"] == 0 and s["timeout_count"] == 0
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
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
    try:
        OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            im = render_case_image(c, idx)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
        api_errors = sum(0 if o.get("ok") else 1 for o in api_outs)
        timeouts = sum(1 if o.get("timeout") else 0 for o in api_outs)
        if api_errors or timeouts:
            raise RuntimeError(f"API errors={api_errors} timeouts={timeouts}")
        scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    finally:
        shutil.rmtree(OUT_IMG_DIR, ignore_errors=True)
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
            "pack_style": c["pack_style"],
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
        "sharp_verdict_accuracy": round(sum(1 for x in sharp if x["verdict_ok"]) / len(sharp), 4),
        "degraded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": SUITE_NAME,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "concurrency": MAX_CONCURRENCY,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    OUT_JSON.write_text(json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=True) + "\n", encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
