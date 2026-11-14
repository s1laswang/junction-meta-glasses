from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
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
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SHM_DIR = "/dev/shm"
if os.path.isdir(SHM_DIR):
    os.environ.setdefault("TMPDIR", SHM_DIR)

NODE_BIN_DIR = "/tmp/fleet-silas/node/bin"
if os.path.isdir(NODE_BIN_DIR) and NODE_BIN_DIR not in os.environ.get("PATH", "").split(":"):
    _cur_path = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{NODE_BIN_DIR}:{_cur_path}" if _cur_path else NODE_BIN_DIR

SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = SUITE_DIR.name
REPO_ROOT = SUITE_DIR.parent.parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
SAFETY_TS_PATH = REPO_ROOT / "server" / "src" / "safety.ts"
SAFETY_BRIDGE_PATH = REPO_ROOT / "eval" / "safety_bridge.mts"
OUT_JSON_PATH = SUITE_DIR / "results.json"

MODEL_NAME = "gemini-3.8-flash"
THINKING_LEVEL = "low"
EVAL_NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
MAX_WORKERS = 6
MAX_JSON_BYTES = 15360
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "med_amlodipine",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "med_levothyroxine",
            "name": "Thyroxin",
            "ingredient": "levothyroxine",
            "strength": "100 mcg",
            "schedule": ["morning"],
        },
        {
            "id": "med_paracetamol",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["noon"],
        },
        {
            "id": "med_bisoprolol",
            "name": "Bisoprolol",
            "ingredient": "bisoprolol",
            "strength": "2.5 mg",
            "schedule": ["morning"],
        },
    ],
    "allergies": ["peanut", "lactose", "soy", "gluten", "sulphites", "penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ae_01",
        "category": "excipient_lactose_generic_swap",
        "kind": "medication",
        "description": "AMLODIPIN SANDOZ 5 mg generic carton declaring lactose monohydrate excipient",
        "question": "Can I take this evening blood pressure pill with my allergies?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "5 mg",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": -1.7,
        "accent": (28, 96, 152),
        "header": "SANDOZ NORDIC    Vnr 19 42 08",
        "title": "AMLODIPIN SANDOZ",
        "strength_badge": "5 mg",
        "form_line": "tabletti / tablet",
        "sub_line": "Active ingredient: amlodipine (as besilate)",
        "excipient_alert": True,
        "panel_title": "EU ANNEX II EXCIPIENT NOTICE:",
        "panel_lines": [
            "Contains lactose monohydrate (laktoosimonohydraatti).",
            "Consult leaflet if you have lactose intolerance or allergy.",
        ],
        "dosing_line": "1 tablet in the evening",
        "expiry_line": "EXP 2027-10",
    },
    {
        "id": "ae_02",
        "category": "excipient_arachis_oil_softgel",
        "kind": "medication",
        "description": "DIVISUN D3 1000 IU softgel capsules declaring refined arachis (peanut) oil",
        "question": "Are these vitamin D capsules safe for my peanut allergy?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "1000 IU",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": 1.6,
        "accent": (168, 78, 24),
        "header": "NORDIC PHARMA    Vnr 33 10 54",
        "title": "DIVISUN SOFTCAPS",
        "strength_badge": "1000 IU",
        "form_line": "soft capsule / pehmea kapseli",
        "sub_line": "Active ingredient: colecalciferol (vitamin D3)",
        "excipient_alert": True,
        "panel_title": "EXCIPIENT ALLERGEN WARNING:",
        "panel_lines": [
            "Contains refined arachis oil (peanut oil / maapahkinaoljy).",
            "Do not use if you are allergic to peanut or groundnut.",
        ],
        "dosing_line": "1 capsule once daily",
        "expiry_line": "EXP 2028-02",
    },
    {
        "id": "ae_03",
        "category": "excipient_soya_lecithin_capsule",
        "kind": "medication",
        "description": "PANADOL SOFTCAPS 500 mg capsules declaring soya oil and soy lecithin excipient",
        "question": "Can I take this Panadol 500 mg capsule at noon?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": -1.5,
        "accent": (24, 104, 148),
        "header": "HALEON NORDIC    Vnr 07 65 11",
        "title": "PANADOL SOFTCAPS",
        "strength_badge": "500 mg",
        "form_line": "soft capsule",
        "sub_line": "Active ingredient: paracetamol",
        "excipient_alert": True,
        "panel_title": "EXCIPIENT WITH KNOWN EFFECT:",
        "panel_lines": [
            "Capsule shell and fill contain refined soya oil",
            "and soy lecithin (soijaoljy, soijalesitiini).",
        ],
        "dosing_line": "1 capsule as needed at noon",
        "expiry_line": "EXP 2027-11",
    },
    {
        "id": "ae_04",
        "category": "excipient_wheat_starch_tablet",
        "kind": "medication",
        "description": "THYROXIN GENERIC 100 mcg tablets declaring wheat starch (gluten) excipient",
        "question": "Is this morning thyroid tablet safe with my gluten allergy?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "100 mcg",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": 1.8,
        "accent": (52, 86, 146),
        "header": "TEVA NORDIC    Vnr 41 28 90",
        "title": "THYROXIN TEVA",
        "strength_badge": "100 mcg",
        "form_line": "tablet / tabletti",
        "sub_line": "Active ingredient: levothyroxine sodium",
        "excipient_alert": True,
        "panel_title": "EU ANNEX II EXCIPIENTS:",
        "panel_lines": [
            "Contains wheat starch (vehna, gluten / vehnatarkkelys)",
            "and microcrystalline cellulose.",
        ],
        "dosing_line": "1 tablet in the morning",
        "expiry_line": "EXP 2027-09",
    },
    {
        "id": "ae_05",
        "category": "excipient_sulphite_oral_solution",
        "kind": "medication",
        "description": "PANADOL ORAL SOLUTION 500 mg declaring sodium metabisulphite (sulphites)",
        "question": "Can I use this liquid Panadol with my sulphite allergy?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": -1.9,
        "accent": (32, 112, 128),
        "header": "PHARMA NORDIC    Vnr 52 19 04",
        "title": "PANADOL ORAL DOSE",
        "strength_badge": "500 mg",
        "form_line": "oral solution sachet",
        "sub_line": "Active ingredient: paracetamol",
        "excipient_alert": True,
        "panel_title": "PRESERVATIVE & EXCIPIENT WARNING:",
        "panel_lines": [
            "Contains sodium metabisulphite E223 (sulphites,",
            "sulphur dioxide / rikkidioksidi). May cause reactions.",
        ],
        "dosing_line": "1 sachet (500 mg) per dose",
        "expiry_line": "EXP 2027-08",
    },
    {
        "id": "ae_06",
        "category": "drug_class_penicillin_allergy",
        "kind": "medication",
        "description": "AMOXICILLIN ORION 500 mg antibiotic triggering penicillin class cross-allergy",
        "question": "Is this antibiotic safe for me to take?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "has_allergen_risk": True,
        "panel_occluded": False,
        "box_angle": 1.5,
        "accent": (156, 38, 46),
        "header": "ORION PHARMA    Vnr 06 14 28",
        "title": "AMOXICILLIN ORION",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablet",
        "sub_line": "Active ingredient: amoxicillin (amoksisilliini)",
        "excipient_alert": False,
        "panel_title": "EXCIPIENTS:",
        "panel_lines": [
            "Microcrystalline cellulose, povidone, magnesium stearate.",
            "Beta-lactam antibacterial.",
        ],
        "dosing_line": "1 tablet 3 times daily",
        "expiry_line": "EXP 2027-12",
    },
    {
        "id": "ae_07",
        "category": "excipient_free_amlodipin_match",
        "kind": "medication",
        "description": "AMLODIPIN ORION 5 mg carton with non-allergenic cellulose excipients",
        "question": "Is this my safe evening blood pressure tablet?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "5 mg",
        "has_allergen_risk": False,
        "panel_occluded": False,
        "box_angle": -1.4,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "strength_badge": "5 mg",
        "form_line": "tabletti / tablet",
        "sub_line": "Active ingredient: amlodipine",
        "excipient_alert": False,
        "panel_title": "EXCIPIENTS (FULL LIST):",
        "panel_lines": [
            "Microcrystalline cellulose, calcium hydrogen phosphate,",
            "sodium carboxymethylcellulose, magnesium stearate.",
        ],
        "dosing_line": "1 tablet in the evening",
        "expiry_line": "EXP 2028-01",
    },
    {
        "id": "ae_08",
        "category": "excipient_free_thyroxin_mikrog_match",
        "kind": "medication",
        "description": "THYROXIN ORION 100 mikrog carton with mannitol excipients matching 100 mcg",
        "question": "Can I take my morning Thyroxin tablet?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "100 mcg",
        "has_allergen_risk": False,
        "panel_occluded": False,
        "box_angle": 1.6,
        "accent": (38, 92, 144),
        "header": "ORION PHARMA    Vnr 04 18 22",
        "title": "THYROXIN ORION",
        "strength_badge": "100 mikrog",
        "form_line": "tabletti / tablet",
        "sub_line": "Active ingredient: levothyroxine",
        "excipient_alert": False,
        "panel_title": "EXCIPIENTS (FULL LIST):",
        "panel_lines": [
            "Mannitol (E421), povidone, sodium citrate,",
            "croscarmellose sodium, magnesium stearate.",
        ],
        "dosing_line": "1 tablet every morning",
        "expiry_line": "EXP 2027-12",
    },
    {
        "id": "ae_09",
        "category": "excipient_free_bisoprolol_comma_match",
        "kind": "medication",
        "description": "BISOPROLOL ACTAVIS 2,5 mg carton with benign excipients matching 2.5 mg",
        "question": "Is this my morning Bisoprolol 2.5 mg?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "2.5 mg",
        "has_allergen_risk": False,
        "panel_occluded": False,
        "box_angle": -1.6,
        "accent": (24, 118, 108),
        "header": "ACTAVIS NORDIC    Vnr 49 21 60",
        "title": "BISOPROLOL ACTAVIS",
        "strength_badge": "2,5 mg",
        "form_line": "tabletti / tablet",
        "sub_line": "Active ingredient: bisoprolol fumarate",
        "excipient_alert": False,
        "panel_title": "EXCIPIENTS (FULL LIST):",
        "panel_lines": [
            "Colloidal anhydrous silica, crospovidone,",
            "microcrystalline cellulose, macrogol 6000.",
        ],
        "dosing_line": "1 tablet in the morning",
        "expiry_line": "EXP 2028-04",
    },
    {
        "id": "ae_10",
        "category": "non_profile_allergen_food_info",
        "kind": "food",
        "description": "Nordic brown rice crisps declaring mustard allergen not on user allergy list",
        "question": "Are these rice crisps safe with my peanut, soy, lactose, and gluten allergies?",
        "expected_level": "info",
        "strength_readable": None,
        "expected_strength": None,
        "has_allergen_risk": False,
        "panel_occluded": False,
        "box_angle": 1.4,
        "accent": (46, 112, 74),
        "header": "NORDIC HARVEST    150 g",
        "title": "SPICED RICE CRISPS",
        "sub_title": "Puffed Wholegrain Rice Crackers with Mustard Seed",
        "ingredients_lines": [
            "Ingredients: puffed brown rice (92%), rapeseed oil,",
            "yellow mustard seed (4%), sea salt.",
        ],
        "allergen_lines": [
            "Allergens: Contains mustard (sinappi / senap).",
        ],
        "expiry_line": "Best before: 2027-11-20",
    },
    {
        "id": "ae_11",
        "category": "occluded_allergen_panel_food_unsure",
        "kind": "food",
        "description": "Protein snack bar with damaged retail markdown sticker covering allergen panel",
        "question": "Is this snack bar safe with my peanut and soy allergies?",
        "expected_level": "unsure",
        "strength_readable": None,
        "expected_strength": None,
        "has_allergen_risk": False,
        "panel_occluded": True,
        "box_angle": -2.1,
        "accent": (92, 68, 48),
        "header": "NORDIC NUTRITION    60 g",
        "title": "ENERGY SNACK BAR",
        "sub_title": "High-Fibre Nutrition Bar",
        "ingredients_lines": [],
        "allergen_lines": [],
        "expiry_line": "Best before: 2027-09-30",
        "sticker_header": "CLEARANCE TAG - REDUCED PRICE",
        "sticker_lines": [
            "SKU 9940128   -30% MARKDOWN",
            "NO RETURNS ON CLEARANCE ITEMS",
        ],
    },
    {
        "id": "ae_12",
        "category": "occluded_strength_and_excipients_med_unsure",
        "kind": "medication",
        "description": "PANADOL carton with worn pharmacy sticker covering strength and excipient panel",
        "question": "Can I take this Panadol tablet safely?",
        "expected_level": "unsure",
        "strength_readable": False,
        "expected_strength": None,
        "has_allergen_risk": False,
        "panel_occluded": True,
        "box_angle": 2.2,
        "accent": (88, 102, 118),
        "header": "HALEON NORDIC",
        "title": "PANADOL",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "sub_line": "Active ingredient: paracetamol",
        "excipient_alert": False,
        "panel_title": "",
        "panel_lines": [],
        "dosing_line": "",
        "expiry_line": "",
        "sticker_header": "APTEEKKI - DISPENSING LABEL",
        "sticker_lines": [
            "Take as directed by your physician",
            "with a full glass of water.",
            "Keep out of reach of children.",
        ],
    },
]


def setup_env() -> str:
    comment_char = chr(35)
    cands = [
        pathlib.Path.home() / "momin" / ".env",
        REPO_ROOT / ".env",
        pathlib.Path.home() / "junction-meta-glasses" / ".env",
    ]
    for env_path in cands:
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(comment_char):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    return api_key


def redact_secrets(text: str) -> str:
    out = text
    for k in ("GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"):
        v = os.environ.get(k, "")
        if v:
            out = out.replace(v, "***")
    return KEY_RE.sub("[REDACTED]", re.sub(r"key=[A-Za-z0-9_\-]+", "key=***", out))


def sanitize_text(val: Any) -> Any:
    em_dash = chr(0x2014)
    en_dash = chr(0x2013)
    if isinstance(val, str):
        cleaned = val.replace(em_dash, " - ").replace(en_dash, "-")
        return KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [sanitize_text(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_text(k): sanitize_text(v) for k, v in val.items()}
    return val


def inline_schema_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None and isinstance(node, dict):
        defs = node.get("$defs") or {}
    if isinstance(node, list):
        return [inline_schema_refs(item, defs) for item in node]
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and defs is not None:
            ref_key = ref.rsplit("/", 1)[-1]
            return inline_schema_refs(defs[ref_key], defs)
        return {k: inline_schema_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    margin = (z / denom) * math.sqrt((p * (1.0 - p) / n) + (z2 / (4.0 * n * n)))
    return [round(max(0.0, min(1.0, center - margin)), 4), round(max(0.0, min(1.0, center + margin)), 4)]


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def parse_strength_norm(text: str | None) -> tuple[float, str] | None:
    if not text:
        return None
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).replace("\u00b5", "u").strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg|ug|mikrog|microgram|iu|ky)s?\b", normed)
    if not m:
        return None
    amt = float(m.group(1))
    unit = m.group(2)
    if unit in ("iu", "ky"):
        return (round(amt, 6), "iu")
    factors = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "ug": 0.001, "mikrog": 0.001, "microgram": 0.001}
    return (round(amt * factors[unit], 6), "mg")


def same_strength_simple(a: str | None, b: str | None) -> bool:
    pa = parse_strength_norm(a)
    pb = parse_strength_norm(b)
    if pa is None or pb is None:
        return False
    return pa[1] == pb[1] and abs(pa[0] - pb[0]) < 1e-6


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 15) -> Any:
    size = start_size
    while size > min_size:
        font = ImageFont.load_default(size=size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 1
    return ImageFont.load_default(size=min_size)


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    hw = max(1, w >> 1)
    hh = max(1, h >> 1)
    noise = Image.new("L", (hw, hh))
    px = [128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range(hw * hh)]
    noise.putdata(px)
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    alpha = 0.05
    return Image.merge("RGB", (Image.blend(r, noise, alpha), Image.blend(g, noise, alpha), Image.blend(b, noise, alpha)))


def render_tabletop_canvas(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (224, 216, 204))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.61)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(238 - 22 * t), int(232 - 22 * t), int(222 - 20 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 100)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(188 - 24 * t) + jitter)),
            max(0, min(255, int(160 - 20 * t) + jitter)),
            max(0, min(255, int(128 - 16 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(144, 118, 92), width=2)
    return canvas


def render_opaque_sticker(width: int, height: int, header: str, lines: list[str], seed: int) -> Image.Image:
    pad = 20
    layer = Image.new("RGBA", (width + 2 * pad, height + 2 * pad), (0, 0, 0, 0))
    sd = ImageDraw.Draw(layer)
    sd.rounded_rectangle((pad + 4, pad + 6, pad + width + 5, pad + height + 7), radius=8, fill=(24, 20, 16, 78))
    layer = layer.filter(ImageFilter.GaussianBlur(radius=4.0))

    paper = Image.new("RGB", (width, height), (250, 246, 234))
    paper = add_paper_grain(paper, seed=seed + 55, amplitude=5)
    pd = ImageDraw.Draw(paper)
    pd.rounded_rectangle((0, 0, width - 1, height - 1), radius=7, outline=(192, 184, 168), width=2)
    pd.rectangle((2, 2, width - 3, 38), fill=(224, 92, 44))
    pd.text((16, 10), header, fill=(255, 252, 246), font=fit_font(pd, header, width - 32, 18, 13))

    y = 52
    for ln in lines:
        pd.text((18, y), ln, fill=(32, 34, 38), font=fit_font(pd, ln, width - 36, 21, 14))
        y += 32

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    layer.paste(paper, (pad, pad), mask)
    return layer


def render_food_pack(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 104, pad + 78, pad + 664, pad + 694
    cw, ch = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 16, 92))
    box_layer = Image.alpha_composite(box_layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    carton = Image.new("RGB", (cw, ch), (247, 243, 233))
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 68), fill=case["accent"])
    cd.text((26, 22), case["header"], fill=(246, 249, 246), font=fit_font(cd, case["header"], cw - 52, 22))
    cd.text(
        (26, 90),
        case["title"],
        fill=(22, 36, 28),
        font=fit_font(cd, case["title"], cw - 52, 42),
        stroke_width=1,
        stroke_fill=(22, 36, 28),
    )
    cd.text((26, 148), case["sub_title"], fill=(56, 68, 60), font=fit_font(cd, case["sub_title"], cw - 52, 22))

    if not case["panel_occluded"]:
        cd.rounded_rectangle((24, 198, cw - 24, 434), radius=12, fill=(253, 251, 246), outline=(182, 176, 162), width=2)
        iy = 218
        for ln in case["ingredients_lines"]:
            cd.text((38, iy), ln, fill=(28, 32, 30), font=fit_font(cd, ln, cw - 76, 21))
            iy += 34
        iy += 14
        cd.rounded_rectangle((34, iy - 4, cw - 34, iy + 68), radius=8, fill=(255, 244, 232), outline=(196, 124, 62), width=2)
        for ln in case["allergen_lines"]:
            f_alg = fit_font(cd, ln, cw - 92, 22)
            cd.text((46, iy + 16), ln, fill=(108, 38, 18), font=f_alg, stroke_width=1, stroke_fill=(108, 38, 18))
            iy += 32

    cd.rounded_rectangle((24, 486, cw - 24, 548), radius=8, fill=(255, 255, 255), outline=(194, 190, 180), width=2)
    cd.text((38, 503), case["expiry_line"], fill=(24, 28, 30), font=fit_font(cd, case["expiry_line"], cw - 76, 24))

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(168, 162, 150, 255), width=3)

    if case["panel_occluded"]:
        st = render_opaque_sticker(508, 242, case["sticker_header"], case["sticker_lines"], seed)
        st_rot = st.rotate(-2.2, resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 6, y0 + 184))

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_med_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 64, pad + 96, pad + 704, pad + 668
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(26, 22, 18, 92))
    box_layer = Image.alpha_composite(box_layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    cd.text((28, 18), case["header"], fill=(246, 249, 252), font=fit_font(cd, case["header"], bw - 56, 22))
    cd.text(
        (28, 80),
        case["title"],
        fill=(16, 22, 30),
        font=fit_font(cd, case["title"], bw - 56, 42),
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    cd.text((28, 136), case["sub_line"], fill=(52, 60, 72), font=fit_font(cd, case["sub_line"], bw - 56, 22))

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 176, 286, 252
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
        f_badge = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 32, 40, 24)
        cd.text(
            (sx0 + 18, sy0 + 15),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=f_badge,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        f_form = fit_font(cd, case["form_line"], bw - sx1 - 42, 22, 16)
        cd.text((sx1 + 16, sy0 + 25), case["form_line"], fill=(38, 46, 56), font=f_form)
    else:
        cd.text((28, 180), case["form_line"], fill=(56, 64, 74), font=fit_font(cd, case["form_line"], bw - 56, 23))

    if not case["panel_occluded"]:
        if case["excipient_alert"]:
            p_bg, p_bd, hdr_col, body_col = (255, 243, 232), (204, 108, 48), (136, 38, 16), (48, 24, 16)
        else:
            p_bg, p_bd, hdr_col, body_col = (243, 247, 251), (176, 186, 198), (34, 52, 72), (32, 38, 46)
        cd.rounded_rectangle((28, 272, bw - 28, 426), radius=10, fill=p_bg, outline=p_bd, width=2)
        cd.text(
            (42, 288),
            case["panel_title"],
            fill=hdr_col,
            font=fit_font(cd, case["panel_title"], bw - 84, 21, 15),
            stroke_width=1,
            stroke_fill=hdr_col,
        )
        py = 324
        for ln in case["panel_lines"]:
            cd.text((42, py), ln, fill=body_col, font=fit_font(cd, ln, bw - 84, 21, 15))
            py += 34

        if case["dosing_line"]:
            cd.text((28, 456), case["dosing_line"], fill=(42, 50, 60), font=fit_font(cd, case["dosing_line"], 340, 22))
        if case["expiry_line"]:
            cd.rounded_rectangle((bw - 246, 446, bw - 28, 498), radius=6, fill=(242, 244, 247), outline=(168, 174, 182), width=2)
            cd.text((bw - 230, 458), case["expiry_line"], fill=(20, 24, 30), font=fit_font(cd, case["expiry_line"], 198, 24))

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    if case["panel_occluded"]:
        st = render_opaque_sticker(556, 290, case["sticker_header"], case["sticker_lines"], seed)
        st_rot = st.rotate(-1.9, resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 18, y0 + 162))

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)
    glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glare).ellipse((-80, -100, 500, 400), fill=(255, 253, 246, 18))
    return Image.alpha_composite(composed, glare.filter(ImageFilter.GaussianBlur(radius=30.0))).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg_b64(case: dict[str, Any], idx: int) -> str:
    seed = 20261170 + idx * 43
    img = render_food_pack(case, seed) if case["kind"] == "food" else render_med_carton(case, seed)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    raw_bytes = buf.getvalue()
    if os.environ.get("SAVE_DEBUG_IMAGES") == "1":
        dbg_dir = REPO_ROOT / "eval" / "out" / SUITE_NAME
        dbg_dir.mkdir(parents=True, exist_ok=True)
        (dbg_dir / f"{case['id']}.jpg").write_bytes(raw_bytes)
    return base64.b64encode(raw_bytes).decode("ascii")


def call_gemini_flash(
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
    question: str,
) -> tuple[dict[str, Any], float]:
    slash2 = chr(47) * 2
    url = f"https:{slash2}generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    user_prompt = f'The person asked: "{question.strip()[:300]}"' if question.strip() else "Read this label."
    payload = {
        "systemInstruction": {"parts": [{"text": verify_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": "image/jpeg", "data": b64_jpeg}},
                    {"text": user_prompt},
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": label_schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }

    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    last_err = ""
    for attempt in range(5):
        t0 = time.perf_counter()
        try:
            resp = session.post(url, headers=headers, json=payload, timeout=45)
            latency_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status_code == 200:
                body = resp.json()
                cands = body.get("candidates") or []
                parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
                json_text = ""
                for part in parts:
                    if "text" in part and not part.get("thought") and part["text"].strip():
                        json_text = part["text"].strip()
                        break
                if json_text:
                    if json_text.startswith("```"):
                        json_text = re.sub(r"^```[a-zA-Z]*\n?", "", json_text)
                        json_text = re.sub(r"\n?```$", "", json_text)
                    return json.loads(json_text), round(latency_ms, 1)
                last_err = "empty structured output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = redact_secrets(f"HTTP {resp.status_code}: {resp.text[:200]}")
            if resp.status_code in (408, 429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = redact_secrets(str(exc))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(redact_secrets(f"Gemini call failed after retries: {last_err}"))


def find_node_bin() -> str:
    cand = pathlib.Path(NODE_BIN_DIR) / "node"
    if cand.is_file():
        return str(cand)
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("node binary not available")


def make_subproc_env() -> dict[str, str]:
    env = dict(os.environ)
    if os.path.isdir(SHM_DIR):
        env["TMPDIR"] = SHM_DIR
    env["HOLDUP_SAFETY_TS"] = str(SAFETY_TS_PATH)
    return env


def coerce_via_verify_ts(raw_items: list[Any]) -> list[dict[str, Any]]:
    node_bin = find_node_bin()
    js_code = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'const arr = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(arr.map((x) => toLabelRead(x))));'
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", js_code],
        input=json.dumps(raw_items, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=make_subproc_env(),
        timeout=120,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"verify.ts toLabelRead failed ({proc.returncode}): {proc.stderr[:400]}")
    outs = json.loads(proc.stdout)
    if not isinstance(outs, list) or len(outs) != len(raw_items):
        raise RuntimeError("Unexpected verify.ts output length")
    return [sanitize_text(x) for x in outs]


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node_bin = find_node_bin()
    cmd = [node_bin, "--import", "tsx", str(SAFETY_BRIDGE_PATH)]
    stdin_lines = "\n".join(json.dumps(item, ensure_ascii=False) for item in batch) + "\n"
    proc = subprocess.run(
        cmd,
        input=stdin_lines,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=make_subproc_env(),
        timeout=120,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:400]}")
    outs = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    if len(outs) != len(batch):
        raise RuntimeError(f"Expected {len(batch)} safety_bridge rows, got {len(outs)}")
    return outs


def compute_prompt_sha12() -> str:
    prompt_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
    return hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]


def validate_output_contract(encoded: bytes) -> None:
    if len(encoded) > MAX_JSON_BYTES:
        raise AssertionError(f"results.json size {len(encoded)} exceeds {MAX_JSON_BYTES}")
    em_dash = chr(0x2014)
    en_dash = chr(0x2013)
    txt = encoded.decode("utf-8")
    if em_dash in txt or en_dash in txt:
        raise AssertionError("Forbidden dash character in results.json")
    if "/9j/" in txt:
        raise AssertionError("Unexpected base64 image data in results.json")
    if KEY_RE.search(txt):
        raise AssertionError("Unexpected API key pattern in results.json")


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    hash_ch = chr(35)
    slash2 = chr(47) * 2
    em_dash = chr(0x2014)
    en_dash = chr(0x2013)
    assert hash_ch not in src_py, "Forbidden comment char in run.py"
    assert slash2 not in src_py, "Forbidden double-slash in run.py"
    assert em_dash not in src_py and en_dash not in src_py, "Forbidden dash in run.py"
    assert not KEY_RE.search(src_py), "Forbidden key in run.py"

    readme_path = SUITE_DIR / "README.md"
    if readme_path.is_file():
        readme_txt = readme_path.read_text(encoding="utf-8")
        assert em_dash not in readme_txt and en_dash not in readme_txt, "Forbidden dash in README.md"
        assert not KEY_RE.search(readme_txt), "Forbidden key in README.md"

    raw_bytes = OUT_JSON_PATH.read_bytes()
    validate_output_contract(raw_bytes)
    data = json.loads(raw_bytes.decode("utf-8"))

    assert data["suite"] == SUITE_NAME == "allergen_excipients"
    assert data["model"] == MODEL_NAME and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == "shared/verify_prompt.md+shared/label_schema.json"
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == "server/src/safety.ts"
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)

    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == len(CASES) == 12

    for idx, spec in enumerate(CASES, start=1):
        b64_jpg = render_case_jpeg_b64(spec, idx)
        assert len(b64_jpg) > 1000

    coerced = coerce_via_verify_ts([c["read"] for c in cases])
    for c, cr in zip(cases, coerced):
        assert cr == c["read"], f"{c['id']}: verify.ts toLabelRead mismatch"

    re_verdicts = run_safety_bridge(
        [{"read": c["read"], "profile": data["profile"], "now": data["eval_now_iso"]} for c in cases]
    )
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: {rv['level']} != {c['predicted_level']}"
        exp_reasons = [sanitize_text(str(r)) for r in (rv.get("reasons") or [])][:4]
        assert exp_reasons == c["reasons"], f"{c['id']}: reasons mismatch"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert (
        s["unsafe_reassurance_count"]
        == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info"))
        == 0
    )
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--verify-cached", "--offline", dest="check", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    args = ap.parse_args(argv)

    if args.check:
        return check_existing()
    if args.render_only:
        for idx, case in enumerate(CASES, start=1):
            b64_jpg = render_case_jpeg_b64(case, idx)
            print(f"{case['id']} ({case['category']}): b64_len={len(b64_jpg)}")
        return 0

    api_key = setup_env()
    prompt_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = compute_prompt_sha12()
    label_schema = inline_schema_refs(json.loads(schema_txt))

    indexed_cases = list(enumerate(CASES, start=1))
    raw_by_id: dict[str, tuple[dict[str, Any], float]] = {}

    def worker(item: tuple[int, dict[str, Any]]) -> tuple[str, dict[str, Any], float]:
        idx, case = item
        b64_jpeg = render_case_jpeg_b64(case, idx)
        parsed, latency_ms = call_gemini_flash(
            api_key=api_key,
            verify_prompt=prompt_txt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
            question=case["question"],
        )
        return case["id"], parsed, latency_ms

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = [pool.submit(worker, it) for it in indexed_cases]
        for fut in as_completed(futs):
            cid, parsed, latency_ms = fut.result()
            raw_by_id[cid] = (parsed, latency_ms)

    ts_coerced = coerce_via_verify_ts([sanitize_text(raw_by_id[c["id"]][0]) for c in CASES])
    coerced_reads: dict[str, dict[str, Any]] = {}
    bridge_inputs: list[dict[str, Any]] = []
    for case, read_obj in zip(CASES, ts_coerced):
        cid = case["id"]
        coerced_reads[cid] = read_obj
        bridge_inputs.append({"read": read_obj, "profile": PROFILE, "now": EVAL_NOW_ISO})

    bridge_outputs = run_safety_bridge(bridge_inputs)

    cases_out: list[dict[str, Any]] = []
    for case, verdict_row in zip(CASES, bridge_outputs):
        cid = case["id"]
        _, latency_ms = raw_by_id[cid]
        read_obj = coerced_reads[cid]
        pred_level = str(verdict_row["level"])
        exp_level = str(case["expected_level"])
        reasons = [sanitize_text(str(r)) for r in (verdict_row.get("reasons") or [])][:4]

        verdict_ok = pred_level == exp_level
        false_match = pred_level == "match" and exp_level != "match"
        unsafe_reassurance = exp_level == "warning" and pred_level in ("match", "info")

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        exp_strength = case["expected_strength"]
        sr = case["strength_readable"]

        wrong_crit_high_conf = False
        if case["kind"] == "medication":
            if sr is True:
                if s_val is not None and s_conf >= STRENGTH_MIN_CONF and not same_strength_simple(s_val, exp_strength):
                    wrong_crit_high_conf = True
            elif sr is False:
                if s_val is not None and s_conf >= STRENGTH_MIN_CONF:
                    wrong_crit_high_conf = True
        if case["panel_occluded"] and read_obj["allergens"]["value"] is not None and float(read_obj["allergens"]["confidence"]) >= 0.8:
            wrong_crit_high_conf = True

        confident_wrong = bool(wrong_crit_high_conf or unsafe_reassurance or false_match)

        entry: dict[str, Any] = {
            "id": cid,
            "category": case["category"],
            "description": sanitize_text(case["description"])[:240],
            "question": sanitize_text(case["question"]),
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_ok": verdict_ok,
            "confident_wrong": confident_wrong,
            "false_match": false_match,
            "latency_ms": latency_ms,
            "read": read_obj,
            "reasons": reasons,
        }
        if exp_strength is not None:
            entry["expected_strength"] = exp_strength
        cases_out.append(entry)
        print(
            f"[{cid}] expected={exp_level} predicted={pred_level} ok={verdict_ok} "
            f"allergens={read_obj['allergens']['value']!r} cw={confident_wrong} ms={latency_ms:.1f}"
        )

    n_cases = len(cases_out)
    verdict_matches = sum(1 for c in cases_out if c["verdict_ok"])
    verdict_accuracy = round(verdict_matches / n_cases, 4)
    cw_count = sum(1 for c in cases_out if c["confident_wrong"])
    cw_rate = round(cw_count / n_cases, 4)
    false_match_count = sum(1 for c in cases_out if c["false_match"])
    unsafe_count = sum(
        1 for c in cases_out if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")
    )
    unsure_count = sum(1 for c in cases_out if c["predicted_level"] == "unsure")
    latencies = [float(c["latency_ms"]) for c in cases_out]

    risk_cases = [c for c, spec in zip(cases_out, CASES) if spec["has_allergen_risk"]]
    safe_med_cases = [c for c in cases_out if c["expected_level"] == "match"]
    occluded_cases = [c for c, spec in zip(cases_out, CASES) if spec["panel_occluded"]]

    summary: dict[str, Any] = {
        "n_cases": n_cases,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "verdict_accuracy_ci95": wilson_ci95(verdict_matches, n_cases),
        "confident_wrong_count": cw_count,
        "confident_wrong_rate": cw_rate,
        "confident_wrong_ci95": wilson_ci95(cw_count, n_cases),
        "false_match_count": false_match_count,
        "unsafe_reassurance_count": unsafe_count,
        "abstain_or_unsure_count": unsure_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "excipient_and_class_recall": round(sum(1 for c in risk_cases if c["predicted_level"] == "warning") / len(risk_cases), 4),
        "safe_excipient_match_rate": round(sum(1 for c in safe_med_cases if c["verdict_ok"]) / len(safe_med_cases), 4),
        "occluded_panel_abstention_rate": round(sum(1 for c in occluded_cases if c["predicted_level"] == "unsure") / len(occluded_cases), 4),
    }

    report: dict[str, Any] = sanitize_text(
        {
            "suite": SUITE_NAME,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "eval_now_iso": EVAL_NOW_ISO,
            "model": MODEL_NAME,
            "thinking_level": THINKING_LEVEL,
            "prompt_source": "shared/verify_prompt.md+shared/label_schema.json",
            "prompt_sha256_12": prompt_sha256_12,
            "safety_module": "server/src/safety.ts",
            "profile": PROFILE,
            "summary": summary,
            "cases": cases_out,
        }
    )

    encoded = (json.dumps(report, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > 15100:
        encoded = (json.dumps(report, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    validate_output_contract(encoded)
    OUT_JSON_PATH.write_bytes(encoded)
    print(f"Wrote {OUT_JSON_PATH} ({len(encoded)} bytes)")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
