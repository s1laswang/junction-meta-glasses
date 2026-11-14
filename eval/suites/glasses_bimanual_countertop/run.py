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
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

SHM_DIR = pathlib.Path("/dev/shm")
if SHM_DIR.is_dir():
    os.environ["TMPDIR"] = str(SHM_DIR)

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
TMP_BASE = pathlib.Path("/tmp/opencode") if pathlib.Path("/tmp/opencode").is_dir() else pathlib.Path("/tmp")
OUT_IMG_DIR = TMP_BASE / "holdup_glasses_bimanual_countertop"
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
MAX_WORKERS = 4
GAZE_DEG = 35.0
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PACK_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPINE",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 2027-10",
    },
    "met500": {
        "accent": (24, 114, 106),
        "hdr": "ORION PHARMA  Vnr 14 88 05",
        "title": "METFORMIN",
        "sub": "Active ingredient: metformin",
        "str": "500 mg",
        "dose": "1 tablet morning and evening",
        "exp": "EXP 2027-12",
    },
    "biso10": {
        "accent": (116, 56, 138),
        "hdr": "ORION PHARMA  Vnr 11 52 39",
        "title": "BISOPROLOL",
        "sub": "Active ingredient: bisoprolol",
        "str": "10 mg",
        "dose": "1 tablet once daily in the morning",
        "exp": "EXP 2027-11",
    },
    "ibu400": {
        "accent": (188, 34, 44),
        "hdr": "ORION PHARMA  Vnr 06 14 28",
        "title": "BURANA",
        "sub": "Active ingredient: ibuprofen",
        "str": "400 mg",
        "dose": "1 tablet as needed for pain",
        "exp": "EXP 2027-11",
    },
    "peanut_bar": {
        "food": True,
        "accent": (148, 76, 26),
        "hdr": "NORDIC SPORT NUTRITION",
        "title": "Peanut Protein Bar",
        "ing1": "Ingredients: oats, roasted peanuts,",
        "ing2": "whey protein (milk), cocoa, honey.",
        "alg": "Allergens: contains peanuts, milk, oats.",
        "exp": "Best before: 2027-09-18",
    },
    "oat_drink": {
        "food": True,
        "accent": (38, 116, 84),
        "hdr": "NORDIC PLANT DAIRY",
        "title": "Nordic Oat Drink",
        "ing1": "Ingredients: water, wholegrain oats,",
        "ing2": "rapeseed oil, calcium, sea salt.",
        "alg": "Allergens: contains oats (gluten).",
        "exp": "Best before: 2027-11-24",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "gbc_01",
        "category": "foreground_bimanual_clear",
        "scene_mode": "amlodipine_with_water_glass",
        "secondary_prop": "water_glass",
        "degraded": False,
        "fg": "aml5",
        "q": "Is this my evening pill?",
        "expected": "match",
        "exp_str": "5 mg",
        "allergen": False,
        "desc": "Left hand holds Amlodipine 5 mg carton while right hand holds water glass over newspaper and cereal clutter",
    },
    {
        "id": "gbc_02",
        "category": "foreground_bimanual_clear",
        "scene_mode": "metformin_with_white_cane",
        "secondary_prop": "white_cane",
        "degraded": False,
        "fg": "met500",
        "q": "Is this my Metformin?",
        "expected": "match",
        "exp_str": "500 mg",
        "allergen": False,
        "desc": "Left hand holds Metformin 500 mg carton while right hand holds folded white cane over kitchen counter clutter",
    },
    {
        "id": "gbc_03",
        "category": "foreground_bimanual_clear",
        "scene_mode": "wrong_strength_bisoprolol_organizer",
        "secondary_prop": "pill_organizer",
        "degraded": False,
        "fg": "biso10",
        "q": "Is this my morning Bisoprolol?",
        "expected": "warning",
        "exp_str": "10 mg",
        "allergen": False,
        "desc": "Left hand holds Bisoprolol 10 mg vs prescribed 2.5 mg while right hand holds 7-day pill organizer over clutter",
    },
    {
        "id": "gbc_04",
        "category": "foreground_bimanual_clear",
        "scene_mode": "ibuprofen_nsaid_with_water_glass",
        "secondary_prop": "water_glass",
        "degraded": False,
        "fg": "ibu400",
        "q": "Can I take this for pain?",
        "expected": "warning",
        "exp_str": "400 mg",
        "allergen": False,
        "desc": "Left hand holds Burana ibuprofen 400 mg NSAID carton while right hand holds water glass over cluttered counter",
    },
    {
        "id": "gbc_05",
        "category": "foreground_bimanual_clear",
        "scene_mode": "peanut_protein_bar_with_cane",
        "secondary_prop": "white_cane",
        "degraded": False,
        "fg": "peanut_bar",
        "q": "Can I eat this protein bar?",
        "expected": "warning",
        "exp_str": None,
        "allergen": True,
        "desc": "Left hand holds Peanut Protein Bar wrapper while right hand holds folded white cane over countertop clutter",
    },
    {
        "id": "gbc_06",
        "category": "foreground_bimanual_clear",
        "scene_mode": "nordic_oat_drink_with_glass",
        "secondary_prop": "water_glass",
        "degraded": False,
        "fg": "oat_drink",
        "q": "Is this oat drink safe with my nut allergies?",
        "expected": "info",
        "exp_str": None,
        "allergen": False,
        "desc": "Left hand holds allergen-clear Nordic Oat Drink carton while right hand holds glass over cluttered counter",
    },
    {
        "id": "gbc_07",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "spine_only_with_bg_amlodipine_decoy",
        "secondary_prop": "water_glass",
        "degraded": True,
        "fg": "aml5",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Foreground hand holds carton barcode-spine-only with water glass while blurred Amlodipine decoy sits on counter",
    },
    {
        "id": "gbc_08",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "two_boxes_gripped_one_hand",
        "secondary_prop": "pill_organizer",
        "degraded": True,
        "fg": "aml5",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Two different pill cartons Amlodipine and Metformin gripped together in left hand with strengths occluded",
    },
    {
        "id": "gbc_09",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "wet_condensation_smeared_strength",
        "secondary_prop": "water_glass",
        "degraded": True,
        "fg": "aml5",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Wet-glass condensation droplets smear and blur strength digits on handheld Amlodipine carton",
    },
    {
        "id": "gbc_10",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "top_flap_lot_date_only",
        "secondary_prop": "white_cane",
        "degraded": True,
        "fg": "aml5",
        "q": "Is this my morning pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Foreground carton held showing top end-flap with LOT and EXP date only alongside folded white cane",
    },
    {
        "id": "gbc_11",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "unheld_counter_background_decoys",
        "secondary_prop": "pill_organizer",
        "degraded": True,
        "fg": "aml5",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Hands hold only water glass and pill organizer with no pack raised while blurred medicine decoys sit on counter",
    },
    {
        "id": "gbc_12",
        "category": "ambiguous_bimanual_clutter",
        "scene_mode": "two_frame_organizer_occluding_strength",
        "secondary_prop": "pill_organizer",
        "degraded": True,
        "fg": "met500",
        "q": "Is this my Metformin?",
        "expected": "unsure",
        "exp_str": None,
        "allergen": False,
        "desc": "Two-frame bimanual check where 7-day pill organizer held in right hand occludes Metformin strength in both frames",
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


def node_ts_cmd(extra_args: list[str]) -> list[str]:
    node = find_node()
    if (REPO / "node_modules" / "tsx").is_dir():
        return [node, "--import", "tsx", *extra_args]
    return [node, *extra_args]


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_DIR.is_dir():
        ev["TMPDIR"] = str(SHM_DIR)
    return ev


def clamp01(x: Any) -> float | int:
    if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x)):
        v = max(0.0, min(1.0, float(x)))
        return int(v) if v in (0.0, 1.0) else v
    return 0


def coerce_str_field(x: Any) -> dict[str, Any]:
    raw_val = x.get("value") if isinstance(x, dict) else None
    val = raw_val if isinstance(raw_val, str) and len(raw_val.strip()) > 0 else None
    conf = clamp01(x.get("confidence") if isinstance(x, dict) else 0.0)
    return {"value": val, "confidence": min(conf, 0.3) if val is None else conf}


def coerce_arr_field(x: Any) -> dict[str, Any]:
    raw_val = x.get("value") if isinstance(x, dict) else None
    ok = isinstance(raw_val, list) and all(isinstance(s, str) for s in raw_val)
    val = list(raw_val) if ok else None
    conf = clamp01(x.get("confidence") if isinstance(x, dict) else 0.0)
    return {"value": val, "confidence": min(conf, 0.3) if val is None else conf}


def to_label_read(j: Any) -> dict[str, Any]:
    if not isinstance(j, dict):
        nf = {"value": None, "confidence": 0}
        return {
            "kind": "unreadable",
            "product": nf,
            "ingredient": nf,
            "strength": nf,
            "dosing": nf,
            "expiry": nf,
            "allergens": nf,
            "barcode": nf,
            "readability": 0,
            "guidance": "Hold it up in front of you and keep it still.",
        }
    kinds = ("medication", "food", "other", "unreadable")
    read: dict[str, Any] = {
        "kind": j["kind"] if j.get("kind") in kinds else "unreadable",
        "product": coerce_str_field(j.get("product")),
        "ingredient": coerce_str_field(j.get("ingredient")),
        "strength": coerce_str_field(j.get("strength")),
        "dosing": coerce_str_field(j.get("dosing")),
        "expiry": coerce_str_field(j.get("expiry")),
        "allergens": coerce_arr_field(j.get("allergens")),
        "barcode": coerce_str_field(j.get("barcode")),
        "readability": clamp01(j.get("readability")),
    }
    g = j.get("guidance")
    if isinstance(g, str) and len(g.strip()) > 0:
        read["guidance"] = g.strip()[:120]
    ev = read["expiry"]["value"]
    if isinstance(ev, str) and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", ev):
        read["expiry"]["confidence"] = min(read["expiry"]["confidence"], 0.5)
    return read


def apply_glasses_vignette(im: Image.Image, strength: float = 0.13) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w * 0.5) / (w * 0.5)) ** 2 + ((yy - h * 0.5) / (h * 0.5)) ** 2
    vig = np.clip(1.0 - strength * (r2 ** 1.1), 0.75, 1.0)[..., None]
    return Image.fromarray(np.clip(arr * vig, 0, 255).astype(np.uint8), mode="RGB")


def render_cluttered_countertop(seed: int, decoy_mode: str = "none") -> Image.Image:
    size = 768
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / (size - 1.0), yy / (size - 1.0)
    rng = np.random.default_rng(seed)
    grain = np.sin(ny * 44.0 + 0.32 * np.sin(nx * 10.0)) * 5.5
    r = 198.0 - 26.0 * ny + grain + 8.0 * (1.0 - nx)
    g = 172.0 - 24.0 * ny + grain * 0.8 + 6.0 * (1.0 - nx)
    b = 140.0 - 20.0 * ny + grain * 0.55 + 4.0 * (1.0 - nx)
    arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 2.2, (size, size, 3))
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    d = ImageDraw.Draw(im)

    np_im = Image.new("RGBA", (310, 188), (235, 232, 224, 255))
    nd = ImageDraw.Draw(np_im)
    nd.rectangle((0, 0, 309, 187), outline=(176, 172, 164, 255), width=2)
    nd.text((14, 10), "MORNING GAZETTE", fill=(38, 40, 44, 255), font=ImageFont.load_default(size=22))
    nd.line((14, 38, 294, 38), fill=(72, 74, 78, 255), width=2)
    nd.text((14, 46), "CITY WEATHER AND TRANSIT", fill=(54, 56, 60, 255), font=ImageFont.load_default(size=15))
    for col_x in (14, 110, 206):
        for ly in range(72, 174, 11):
            nd.line((col_x, ly, col_x + 82, ly), fill=(96, 98, 102, 255), width=3)
    im_rgba = im.convert("RGBA")
    im_rgba.alpha_composite(np_im.rotate(-7.0, expand=True, resample=Image.Resampling.BICUBIC), (18, 16))

    cer = Image.new("RGBA", (204, 162), (242, 186, 58, 255))
    cd = ImageDraw.Draw(cer)
    cd.rectangle((0, 0, 203, 161), outline=(182, 122, 24, 255), width=3)
    cd.rectangle((0, 0, 203, 38), fill=(196, 64, 28, 255))
    cd.text((14, 9), "SUNRISE FLAKES", fill=(252, 248, 238, 255), font=ImageFont.load_default(size=18))
    cd.text((16, 50), "CRISPY CORN CEREAL", fill=(54, 34, 16, 255), font=ImageFont.load_default(size=15))
    cd.ellipse((54, 82, 152, 148), fill=(248, 242, 228, 255), outline=(156, 98, 34, 255), width=3)
    im_rgba.alpha_composite(cer.rotate(6.0, expand=True, resample=Image.Resampling.BICUBIC), (528, 14))

    blurred_bg = im_rgba.convert("RGB").filter(ImageFilter.GaussianBlur(radius=4.4))

    if decoy_mode in ("aml_decoy", "dual_decoy"):
        dec_canvas = blurred_bg.copy()
        dec = Image.new("RGBA", (186, 126), (248, 250, 252, 255))
        dd = ImageDraw.Draw(dec)
        dd.rectangle((0, 0, 185, 26), fill=(20, 102, 148, 255))
        dd.rectangle((14, 38, 136, 54), fill=(28, 34, 44, 255))
        dd.rounded_rectangle((14, 68, 86, 98), radius=5, fill=(234, 242, 250, 255), outline=(20, 102, 148, 255), width=2)
        dd.rectangle((26, 78, 68, 88), fill=(24, 30, 38, 255))
        dd.rectangle((0, 0, 185, 125), outline=(168, 174, 182, 255), width=2)
        dec_rgba = dec_canvas.convert("RGBA")
        dec_rgba.alpha_composite(dec.rotate(-5.0, expand=True, resample=Image.Resampling.BICUBIC), (346, 52))
        if decoy_mode == "dual_decoy":
            dec2 = Image.new("RGBA", (174, 118), (248, 250, 252, 255))
            dd2 = ImageDraw.Draw(dec2)
            dd2.rectangle((0, 0, 173, 24), fill=(188, 34, 44, 255))
            dd2.rectangle((14, 36, 118, 52), fill=(28, 34, 44, 255))
            dd2.rounded_rectangle((14, 64, 84, 92), radius=5, fill=(248, 238, 238, 255), outline=(188, 34, 44, 255), width=2)
            dec_rgba.alpha_composite(dec2.rotate(8.0, expand=True, resample=Image.Resampling.BICUBIC), (124, 78))
        sharp_dec = dec_rgba.convert("RGB")
        blurred_dec = sharp_dec.filter(ImageFilter.GaussianBlur(radius=7.5))
        mask = Image.new("L", (size, size), 0)
        md = ImageDraw.Draw(mask)
        md.rectangle((326, 32, 560, 206), fill=255)
        if decoy_mode == "dual_decoy":
            md.rectangle((104, 58, 326, 226), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(radius=10.0))
        return Image.composite(blurred_dec, blurred_bg, mask)
    return blurred_bg


def draw_secondary_prop(sc_rgba: Image.Image, prop: str, sweating: bool = False, side: str = "right") -> None:
    layer = Image.new("RGBA", sc_rgba.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bx = 544 if side == "right" else 68
    by = 296

    if prop == "water_glass":
        d.ellipse((bx + 8, by + 236, bx + 188, by + 314), fill=(36, 30, 24, 76))
        d.polygon([(bx + 14, by + 26), (bx + 182, by + 26), (bx + 162, by + 276), (bx + 34, by + 276)], fill=(214, 234, 246, 138), outline=(154, 184, 204, 220))
        d.polygon([(bx + 24, by + 108), (bx + 172, by + 108), (bx + 158, by + 268), (bx + 38, by + 268)], fill=(164, 212, 238, 168))
        d.ellipse((bx + 22, by + 92, bx + 174, by + 126), fill=(196, 230, 248, 210), outline=(138, 184, 210, 225), width=2)
        d.ellipse((bx + 14, by + 6, bx + 182, by + 46), fill=(236, 246, 252, 165), outline=(162, 192, 212, 235), width=3)
        d.line((bx + 44, by + 48, bx + 54, by + 252), fill=(250, 253, 255, 190), width=6)
        if sweating:
            rng = random.Random(909)
            for _ in range(26):
                rx = rng.randint(bx + 36, bx + 156)
                ry = rng.randint(by + 62, by + 254)
                rr = rng.randint(4, 8)
                d.ellipse((rx - rr, ry - rr, rx + rr, ry + rr + 2), fill=(232, 246, 255, 215), outline=(128, 168, 194, 220), width=1)
        for fy in (by + 132, by + 178, by + 224):
            fx0 = bx + 138 if side == "right" else bx - 22
            d.rounded_rectangle((fx0, fy, fx0 + 82, fy + 38), radius=18, fill=(210, 170, 142, 255), outline=(172, 132, 104, 255), width=2)
        sc_rgba.alpha_composite(layer)
        return

    if prop == "white_cane":
        for off_x, tilt in ((0, 0), (32, 4), (64, -2)):
            sx = bx + 36 + off_x
            d.rounded_rectangle((sx, by - 26, sx + 24, by + 330), radius=10, fill=(246, 248, 250, 255), outline=(168, 174, 182, 255), width=2)
            d.rectangle((sx + 2, by + 214, sx + 22, by + 306), fill=(208, 38, 42, 255))
        d.rounded_rectangle((bx + 28, by - 54, bx + 64, by + 58), radius=14, fill=(38, 42, 48, 255), outline=(22, 24, 28, 255), width=2)
        d.arc((bx + 12, by - 92, bx + 84, by - 28), start=180, end=360, fill=(44, 48, 54, 255), width=5)
        for fy in (by + 74, by + 118, by + 162):
            d.rounded_rectangle((bx + 88, fy, bx + 206, fy + 38), radius=18, fill=(210, 170, 142, 255), outline=(172, 132, 104, 255), width=2)
        sc_rgba.alpha_composite(layer)
        return

    d.rounded_rectangle((bx - 6, by + 44, bx + 196, by + 318), radius=14, fill=(216, 234, 248, 242), outline=(98, 142, 178, 255), width=3)
    days = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
    for i, day in enumerate(days):
        cy0 = by + 54 + i * 36
        d.rounded_rectangle((bx + 6, cy0, bx + 184, cy0 + 31), radius=6, fill=(238, 246, 252, 248), outline=(126, 164, 196, 255), width=2)
        d.text((bx + 18, cy0 + 7), day, fill=(46, 76, 106, 255), font=ImageFont.load_default(size=14))
        if i % 2 == 0:
            d.ellipse((bx + 124, cy0 + 8, bx + 144, cy0 + 24), fill=(248, 244, 224, 255), outline=(188, 180, 156, 255), width=1)
    for fy in (by + 144, by + 192, by + 240):
        d.rounded_rectangle((bx + 144, fy, bx + 224, fy + 40), radius=18, fill=(210, 170, 142, 255), outline=(172, 132, 104, 255), width=2)
    sc_rgba.alpha_composite(layer)


def render_pack_card(spec: dict[str, Any], w: int = 468, h: int = 392, hide_str: bool = False, wet_smear: bool = False) -> Image.Image:
    bg_col = (248, 244, 236) if spec.get("food") else (250, 251, 253)
    im = Image.new("RGB", (w, h), bg_col)
    d = ImageDraw.Draw(im)
    cp = w < 380
    d.rectangle((0, 0, w, 46 if cp else 52), fill=spec["accent"])
    d.text((18, 13 if cp else 15), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=16 if cp else 19))
    d.text((18, 62 if cp else 68), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=26 if cp else 34))

    if spec.get("food"):
        d.rounded_rectangle((18, 124, w - 18, 296), radius=8, fill=(254, 253, 249), outline=(180, 174, 162), width=2)
        d.text((28, 138), spec["ing1"], fill=(22, 26, 24), font=ImageFont.load_default(size=18))
        d.text((28, 164), spec["ing2"], fill=(22, 26, 24), font=ImageFont.load_default(size=18))
        d.rounded_rectangle((28, 204, w - 28, 276), radius=6, fill=(255, 244, 232), outline=(194, 122, 64), width=2)
        d.text((38, 228), spec["alg"], fill=(98, 36, 18), font=ImageFont.load_default(size=18))
        d.text((20, h - 50), spec["exp"], fill=(20, 24, 28), font=ImageFont.load_default(size=21))
        d.rectangle((0, 0, w - 1, h - 1), outline=(162, 168, 176), width=2)
        return im

    d.text((18, 104 if cp else 118), spec["sub"], fill=(46, 54, 64), font=ImageFont.load_default(size=16 if cp else 21))
    bw = 154 if cp else 208
    by0 = 146 if cp else 164
    by1 = 208 if cp else 234
    d.rounded_rectangle((18, by0, 18 + bw, by1), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    if not hide_str and not wet_smear:
        d.text((32, by0 + 16), spec["str"], fill=(12, 18, 26), font=ImageFont.load_default(size=28 if cp else 36))
    if wet_smear:
        patch = Image.new("RGB", (bw - 8, by1 - by0 - 8), (232, 240, 248))
        pd = ImageDraw.Draw(patch)
        pd.ellipse((14, 12, 92, 48), fill=(154, 172, 192))
        pd.ellipse((78, 16, 152, 46), fill=(168, 184, 202))
        patch = patch.filter(ImageFilter.GaussianBlur(radius=9.0))
        im.paste(patch, (22, by0 + 4))
        for wx, wy, wr in ((44, by0 + 22, 13), (86, by0 + 34, 16), (128, by0 + 26, 14), (168, by0 + 32, 11)):
            d.ellipse((wx - wr, wy - wr, wx + wr, wy + wr), fill=(224, 238, 250), outline=(146, 176, 202), width=2)
            d.ellipse((wx - int(wr * 0.4), wy - int(wr * 0.5), wx - 1, wy - 1), fill=(252, 254, 255))
    d.text((18, 228 if cp else 262), spec["dose"], fill=(36, 44, 54), font=ImageFont.load_default(size=15 if cp else 19))
    d.text((18, h - 48), f"30 tablets    {spec['exp']}", fill=(22, 28, 36), font=ImageFont.load_default(size=17 if cp else 21))
    d.rectangle((0, 0, w - 1, h - 1), outline=(162, 168, 176), width=2)
    return im


def paste_left_hand_card(sc_rgba: Image.Image, card: Image.Image, x: int, y: int, tilt_deg: float = -2.0) -> None:
    card_rgba = card.convert("RGBA")
    rot = card_rgba.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
    sh = Image.new("RGBA", sc_rgba.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((x + 12, y + 18, x + rot.width + 10, y + rot.height + 16), radius=14, fill=(32, 26, 20, 88))
    sc_rgba.alpha_composite(sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    sc_rgba.alpha_composite(rot, (x, y))

    hand = Image.new("RGBA", sc_rgba.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(hand)
    cx = x + int(rot.width * 0.44)
    hy = y + rot.height - 18
    hd.rounded_rectangle((cx - 118, hy, cx - 22, hy + 84), radius=28, fill=(214, 174, 146, 255), outline=(174, 134, 106, 255), width=2)
    hd.rounded_rectangle((cx + 12, hy + 4, cx + 108, hy + 88), radius=28, fill=(208, 168, 140, 255), outline=(170, 130, 102, 255), width=2)
    sc_rgba.alpha_composite(hand)


def render_case_frames(case: dict[str, Any], idx: int) -> list[Image.Image]:
    seed = 202690 + idx * 41
    mode = case["scene_mode"]

    if not case["degraded"]:
        bg = render_cluttered_countertop(seed).convert("RGBA")
        draw_secondary_prop(bg, case["secondary_prop"], sweating=False, side="right")
        card = render_pack_card(PACK_SPECS[case["fg"]], 468, 392)
        tilt = -2.2 if (idx % 2 == 1) else 1.8
        paste_left_hand_card(bg, card, 34, 204, tilt_deg=tilt)
        return [apply_glasses_vignette(bg.convert("RGB"))]

    if mode == "spine_only_with_bg_amlodipine_decoy":
        bg = render_cluttered_countertop(seed, decoy_mode="aml_decoy").convert("RGBA")
        draw_secondary_prop(bg, "water_glass", sweating=False, side="right")
        spine = Image.new("RGB", (152, 404), (249, 250, 252))
        sd = ImageDraw.Draw(spine)
        sd.rectangle((0, 0, 151, 36), fill=(20, 102, 148))
        for by in range(66, 214, 6):
            bh = 2 if (by % 12 == 0) else 4
            sd.rectangle((26, by, 118, by + bh), fill=(24, 28, 34))
        sd.text((18, 236), "Store in a dry", fill=(54, 60, 68), font=ImageFont.load_default(size=15))
        sd.text((18, 258), "place away from", fill=(54, 60, 68), font=ImageFont.load_default(size=15))
        sd.text((18, 280), "direct light.", fill=(54, 60, 68), font=ImageFont.load_default(size=15))
        sd.text((18, 314), "Keep out of reach", fill=(54, 60, 68), font=ImageFont.load_default(size=15))
        sd.text((18, 336), "of children.", fill=(54, 60, 68), font=ImageFont.load_default(size=15))
        sd.rectangle((0, 0, 151, 403), outline=(160, 166, 174), width=2)
        paste_left_hand_card(bg, spine, 184, 206, tilt_deg=-2.5)
        return [apply_glasses_vignette(bg.convert("RGB"))]

    if mode == "two_boxes_gripped_one_hand":
        bg = render_cluttered_countertop(seed).convert("RGBA")
        draw_secondary_prop(bg, "pill_organizer", sweating=False, side="right")
        back_card = render_pack_card(PACK_SPECS["aml5"], 356, 326, hide_str=True)
        front_card = render_pack_card(PACK_SPECS["met500"], 356, 326, hide_str=True)
        bg.alpha_composite(back_card.convert("RGBA").rotate(-7.0, expand=True, resample=Image.Resampling.BICUBIC), (24, 152))
        bg.alpha_composite(front_card.convert("RGBA").rotate(5.0, expand=True, resample=Image.Resampling.BICUBIC), (46, 276))
        grip = Image.new("RGBA", bg.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(grip)
        gd.rounded_rectangle((42, 412, 278, 508), radius=42, fill=(214, 174, 146, 255), outline=(174, 134, 106, 255), width=3)
        gd.rounded_rectangle((112, 562, 248, 652), radius=30, fill=(208, 168, 140, 255), outline=(170, 130, 102, 255), width=2)
        bg.alpha_composite(grip)
        return [apply_glasses_vignette(bg.convert("RGB"))]

    if mode == "wet_condensation_smeared_strength":
        bg = render_cluttered_countertop(seed).convert("RGBA")
        draw_secondary_prop(bg, "water_glass", sweating=True, side="right")
        card = render_pack_card(PACK_SPECS["aml5"], 468, 392, wet_smear=True)
        paste_left_hand_card(bg, card, 34, 204, tilt_deg=-1.8)
        return [apply_glasses_vignette(bg.convert("RGB"))]

    if mode == "top_flap_lot_date_only":
        bg = render_cluttered_countertop(seed).convert("RGBA")
        draw_secondary_prop(bg, "white_cane", sweating=False, side="right")
        flap = Image.new("RGB", (396, 172), (247, 249, 252))
        fd = ImageDraw.Draw(flap)
        fd.rectangle((0, 0, 395, 22), fill=(20, 102, 148))
        fd.line((0, 34, 395, 34), fill=(192, 198, 206), width=2)
        fd.text((34, 58), "LOT K4821", fill=(36, 42, 50), font=ImageFont.load_default(size=24))
        fd.text((34, 98), "EXP 2027-10", fill=(28, 34, 42), font=ImageFont.load_default(size=26))
        fd.rectangle((0, 0, 395, 171), outline=(158, 164, 172), width=2)
        paste_left_hand_card(bg, flap, 68, 294, tilt_deg=2.2)
        return [apply_glasses_vignette(bg.convert("RGB"))]

    if mode == "unheld_counter_background_decoys":
        bg = render_cluttered_countertop(seed, decoy_mode="dual_decoy").convert("RGBA")
        draw_secondary_prop(bg, "water_glass", sweating=False, side="left")
        draw_secondary_prop(bg, "pill_organizer", sweating=False, side="right")
        return [apply_glasses_vignette(bg.convert("RGB"))]

    frames: list[Image.Image] = []
    for fi, shift in enumerate((0, 12)):
        bg = render_cluttered_countertop(seed + fi * 13).convert("RGBA")
        card = render_pack_card(PACK_SPECS["met500"], 452, 384, hide_str=True)
        paste_left_hand_card(bg, card, 32, 206, tilt_deg=-1.5 + fi * 1.4)
        occ = Image.new("RGBA", bg.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(occ)
        ox = 42 + shift
        oy = 352
        od.rounded_rectangle((ox, oy, ox + 468, oy + 116), radius=12, fill=(214, 232, 248, 252), outline=(92, 136, 174, 255), width=3)
        for di, dtxt in enumerate(("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")):
            cx0 = ox + 10 + di * 64
            od.rounded_rectangle((cx0, oy + 12, cx0 + 58, oy + 102), radius=6, fill=(238, 246, 252, 255), outline=(124, 162, 194, 255), width=2)
            od.text((cx0 + 10, oy + 22), dtxt, fill=(44, 74, 104, 255), font=ImageFont.load_default(size=14))
        od.rounded_rectangle((ox + 382, oy + 28, ox + 528, oy + 98), radius=28, fill=(212, 172, 144, 255), outline=(172, 132, 104, 255), width=2)
        bg.alpha_composite(occ)
        frames.append(apply_glasses_vignette(bg.convert("RGB")))
    return frames


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b}} for b in frames_b64] + [{"text": f'The person asked: "{question}"'}]
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
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ev = sub_env()
    coerced = [{"id": r["id"], "read": sanitize(to_label_read(r["raw"])), "exp_str": r["exp_str"]} for r in raw_rows]
    str_js = (
        'import fs from "node:fs"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => ({ '
        'id: r.id, '
        'str_same: r.exp_str ? sameStrength(r.read.strength.value, r.exp_str) : false, '
        'alg_hits: allergenHits(r.read, inp.allergies).length '
        '}))));'
    )
    p1 = subprocess.run(
        node_ts_cmd(["--input-type=module", "-e", str_js]),
        input=json.dumps({"rows": coerced, "allergies": PROFILE["allergies"]}),
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=ev,
        check=True,
    )
    meta_map = {x["id"]: {"str_same": bool(x["str_same"]), "alg_hits": int(x["alg_hits"])} for x in json.loads(p1.stdout)}
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in coerced) + "\n"
    p2 = subprocess.run(node_ts_cmd([BRIDGE_REL]), input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {
        r["id"]: {
            "id": r["id"],
            "read": r["read"],
            "str_same": meta_map[r["id"]]["str_same"],
            "alg_hits": meta_map[r["id"]]["alg_hits"],
            "verdict": v,
        }
        for r, v in zip(coerced, verdicts)
    }


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert MAX_WORKERS <= 4
    assert str(OUT_IMG_DIR).startswith("/tmp")
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
    data = json.loads(raw_txt)
    assert data["suite"] == "glasses_bimanual_countertop"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["error_count"] == 0
    assert s["timeout_count"] == 0
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run(node_ts_cmd([BRIDGE_REL]), input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env(), check=True)
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
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        imgs = render_case_frames(c, idx)
        b64s: list[str] = []
        for fi, im in enumerate(imgs, 1):
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (OUT_IMG_DIR / (f"{c['id']}.jpg" if len(imgs) == 1 else f"{c['id']}_f{fi}.jpg")).write_bytes(raw)
            b64s.append(base64.b64encode(raw).decode("ascii"))
        rendered.append({"case": c, "b64s": b64s})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
        return 0
    try:
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64s"], r["case"]["q"]), rendered))
        errors = sum(0 if o.get("ok") else 1 for o in api_outs)
        if errors:
            errs = [o.get("err", "err") for o in api_outs if not o.get("ok")]
            raise RuntimeError(f"API errors ({errors}): {errs}")
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
        elif c["exp_str"] is not None:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        else:
            alg_miss = bool(c["allergen"] and float(rd["allergens"]["confidence"] or 0.0) >= 0.8 and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or alg_miss or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "scene_mode": c["scene_mode"],
            "secondary_prop": c["secondary_prop"],
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
    fg = [x for x in cases_out if x["category"] == "foreground_bimanual_clear"]
    amb = [x for x in cases_out if x["category"] == "ambiguous_bimanual_clutter"]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": [round(x, 4) for x in wilson_ci95(cw_n, n)],
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "error_count": 0,
        "timeout_count": 0,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "foreground_bimanual_accuracy": round(sum(1 for x in fg if x["verdict_ok"]) / len(fg), 4),
        "ambiguous_clutter_abstention_rate": round(sum(1 for x in amb if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(amb), 4),
    }
    payload = sanitize({
        "suite": "glasses_bimanual_countertop",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "gaze_deg": GAZE_DEG,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    raw_out = json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=True) + "\n"
    if len(raw_out.encode("utf-8")) > 15360:
        raw_out = json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n"
    OUT_JSON.write_text(raw_out, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
