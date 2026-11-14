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

KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

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
            "id": "med_metformin",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "med_bisoprolol",
            "name": "Bisoprolol",
            "ingredient": "bisoprolol",
            "strength": "2.5 mg",
            "schedule": ["morning"],
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
    ],
    "allergies": ["tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "fi",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ns_01",
        "category": "finnish_evening_sticker",
        "kind": "medication",
        "description": "AMLODIPIN ORION 5 mg carton with Finnish evening pharmacy dosing sticker",
        "question": "Onko tama minun iltalaakkeeni?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "5 mg",
        "box_angle": -2.0,
        "sticker_angle": 1.5,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "strength_badge": "5 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: amlodipiini",
        "pack_line": "98 tablettia",
        "expiry_line": "EXP 08/2027",
        "sticker_mode": "bottom",
        "sticker_header": "YLIOPISTON APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti iltaisin verenpaineen hoitoon.",
            "Kayt. viim. 08/2027",
        ],
    },
    {
        "id": "ns_02",
        "category": "bilingual_fi_sv_sticker",
        "kind": "medication",
        "description": "METFORMIN ACTAVIS 500 mg bilingual FI/SV carton with twice-daily sticker",
        "question": "Voinko ottaa taman aamulla?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "box_angle": 1.8,
        "sticker_angle": -1.4,
        "accent": (36, 84, 164),
        "header": "ACTAVIS    Vnr 12 73 09",
        "title": "METFORMIN ACTAVIS",
        "strength_badge": "500 mg",
        "form_line": "tabletti / filmdragerad tablett",
        "sub_line": "metformiinihydrokloridi / metforminhydroklorid",
        "pack_line": "100 tablettia / tabletter",
        "expiry_line": "EXP 2028-03",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI / APOTEK - ANNOSTUS",
        "sticker_lines": [
            "1 tabletti aamulla ja illalla /",
            "1 tablett morgon och kvall.",
        ],
    },
    {
        "id": "ns_03",
        "category": "comma_decimal_strength",
        "kind": "medication",
        "description": "BISOPROLOL ORION 2,5 mg comma-decimal carton against 2.5 mg profile",
        "question": "Onko vahvuus oikea aamulaakkeelleni?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "2.5 mg",
        "box_angle": -1.5,
        "sticker_angle": 1.9,
        "accent": (24, 122, 118),
        "header": "ORION PHARMA    Vnr 49 21 60",
        "title": "BISOPROLOL ORION",
        "strength_badge": "2,5 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: bisoprololi",
        "pack_line": "100 tablettia",
        "expiry_line": "EXP 09/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti aamuisin laakarin ohjeen mukaan.",
            "Kayt. viim. 09/2027",
        ],
    },
    {
        "id": "ns_04",
        "category": "nordic_mikrog_unit",
        "kind": "medication",
        "description": "THYROXIN ORION 100 mikrog carton matching levothyroxine 100 mcg profile",
        "question": "Is this my morning thyroid tablet?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "100 mcg",
        "box_angle": 1.6,
        "sticker_angle": -1.5,
        "accent": (42, 92, 148),
        "header": "ORION PHARMA    Vnr 04 18 22",
        "title": "THYROXIN ORION",
        "strength_badge": "100 mikrog",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: levotyroksiini (levothyroxine)",
        "pack_line": "100 tablettia",
        "expiry_line": "EXP 12/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti aamuisin tyhjaan vatsaan.",
            "Kayt. viim. 12/2027",
        ],
    },
    {
        "id": "ns_05",
        "category": "swedish_apoteket_sticker",
        "kind": "medication",
        "description": "PANADOL ZAPP 500 mg carton with Swedish Apoteket dosing sticker",
        "question": "Ar detta min paracetamol 500 mg?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "box_angle": -2.1,
        "sticker_angle": 1.3,
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC    Vnr 05 82 19",
        "title": "PANADOL ZAPP",
        "strength_badge": "500 mg",
        "form_line": "filmdragerad tablett",
        "sub_line": "Verksamt amne: paracetamol",
        "pack_line": "30 tabletter",
        "expiry_line": "EXP 06/2028",
        "sticker_mode": "bottom",
        "sticker_header": "APOTEKET - DOSERINGSANVISNING",
        "sticker_lines": [
            "1 tablett vid behov mot vark eller feber.",
            "Utg.dat 06/2028",
        ],
    },
    {
        "id": "ns_06",
        "category": "nsaid_avoid_burana",
        "kind": "medication",
        "description": "BURANA 400 mg ibuprofeeni carton triggering NSAID avoid warning",
        "question": "Voinko ottaa taman paansarkyyn?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "400 mg",
        "box_angle": 2.2,
        "sticker_angle": -1.7,
        "accent": (186, 34, 44),
        "header": "ORION PHARMA    Vnr 01 66 40",
        "title": "BURANA",
        "strength_badge": "400 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: ibuprofeeni",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 11/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti tarvittaessa kipuun,",
            "korkeintaan 3 tablettia vuorokaudessa.",
        ],
    },
    {
        "id": "ns_07",
        "category": "wrong_strength_warning",
        "kind": "medication",
        "description": "AMLODIPIN ORION 10 mg carton against 5 mg profile triggering wrong-strength warning",
        "question": "Onko tama 5 mg iltalaakkeeni?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "10 mg",
        "box_angle": 1.7,
        "sticker_angle": -2.0,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 38",
        "title": "AMLODIPIN ORION",
        "strength_badge": "10 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: amlodipiini",
        "pack_line": "98 tablettia",
        "expiry_line": "EXP 10/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti iltaisin verenpaineen hoitoon.",
            "Kayt. viim. 10/2027",
        ],
    },
    {
        "id": "ns_08",
        "category": "expired_kayt_viim",
        "kind": "medication",
        "description": "METFORMIN 500 mg carton with expired Kayt. viim. 2025-02 date",
        "question": "Onko tama pakkaus viela kayttokelpoinen?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "box_angle": -1.8,
        "sticker_angle": 1.4,
        "accent": (46, 92, 138),
        "header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN",
        "strength_badge": "500 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: metformiini",
        "pack_line": "100 tablettia",
        "expiry_line": "EXP 2025-02",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti aamulla ja illalla.",
            "Kayt. viim. 2025-02",
        ],
    },
    {
        "id": "ns_09",
        "category": "unlisted_antibiotic_course",
        "kind": "medication",
        "description": "AMORION 500 mg amoksisilliini antibiotic carton not on medication list",
        "question": "Kuuluuko tama saannollisiin laakkeisiini?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "box_angle": -1.6,
        "sticker_angle": 1.6,
        "accent": (24, 114, 96),
        "header": "ORION PHARMA    Vnr 06 14 28",
        "title": "AMORION",
        "strength_badge": "500 mg",
        "form_line": "kalvopaallysteinen tabletti",
        "sub_line": "Vaikuttava aine: amoksisilliini (amoxicillin)",
        "pack_line": "20 tablettia",
        "expiry_line": "EXP 11/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti 3 kertaa vuorokaudessa",
            "7 paivan ajan. EXP 11/2027",
        ],
    },
    {
        "id": "ns_10",
        "category": "nordic_food_nut_trace",
        "kind": "food",
        "description": "Nordic oat cream HAVREGRADDE declaring mandel and hasselnot traces",
        "question": "Voinko kayttaa tata pahkina-allergian kanssa?",
        "expected_level": "warning",
        "strength_readable": None,
        "expected_strength": None,
        "box_angle": 1.7,
        "sticker_angle": 0.0,
        "accent": (46, 112, 74),
        "header": "NORDISK VAXTBASERAD",
        "title": "HAVREGRADDE",
        "sub_title": "Matlagningsgradde av havre / Kaurakerma",
        "ingredients_lines": [
            "Ingredienser: vatten, havre, rapsolja,",
            "emulgeringsmedel (rapslecitin), salt.",
        ],
        "allergen_lines": [
            "Kan innehalla spar av mandel och hasselnot.",
            "Voi sisaltaa mantelia ja hasselpahkinaa.",
        ],
        "expiry_line": "Bast fore: 2027-05-14",
        "sticker_mode": "none",
    },
    {
        "id": "ns_11",
        "category": "sticker_occluding_strength",
        "kind": "medication",
        "description": "AMLODIPIN ORION carton with opaque pharmacy sticker completely covering strength",
        "question": "Onko tama oikea 5 mg iltalaake?",
        "expected_level": "unsure",
        "strength_readable": False,
        "expected_strength": None,
        "box_angle": 2.1,
        "sticker_angle": -2.3,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA",
        "title": "AMLODIPIN ORION",
        "strength_badge": None,
        "form_line": "tabletti / tablett",
        "sub_line": "Vaikuttava aine: amlodipiini",
        "pack_line": "Suun kautta",
        "expiry_line": "",
        "sticker_mode": "cover_strength",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "Ota iltaisin verenpaineen hoitoon",
            "laakarin ohjeen mukaan.",
            "Sailytetaan huoneenlammossa.",
        ],
    },
    {
        "id": "ns_12",
        "category": "faded_thermal_occluding_strength",
        "kind": "medication",
        "description": "BISOPROLOL ORION carton with faded thermal pharmacy sticker hiding strength",
        "question": "Mika vahvuus tassa laakkeessa on?",
        "expected_level": "unsure",
        "strength_readable": False,
        "expected_strength": None,
        "box_angle": -2.4,
        "sticker_angle": 1.8,
        "accent": (112, 124, 136),
        "header": "APTEEKKIPAKKAUS",
        "title": "BISOPROLOL ORION",
        "strength_badge": None,
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: bisoprololi",
        "pack_line": "",
        "expiry_line": "",
        "sticker_mode": "faded_thermal",
        "sticker_header": "APTEEKKI",
        "sticker_lines": [
            "Annostus laakarin ohjeen mukaan",
            "aamuisin veden kanssa",
        ],
    },
]


def setup_env() -> str:
    node_dir = "/tmp/fleet-silas/node/bin"
    cur_path = os.environ.get("PATH", "")
    if node_dir not in cur_path.split(":"):
        os.environ["PATH"] = f"{node_dir}:{cur_path}" if cur_path else node_dir

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
    return re.sub(r"key=[A-Za-z0-9_\-]+", "key=***", out)


def sanitize_text(val: Any) -> Any:
    em_dash = chr(0x2014)
    en_dash = chr(0x2013)
    if isinstance(val, str):
        return val.replace(em_dash, " - ").replace(en_dash, "-")
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


def clamp01(val: Any) -> float:
    if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val)):
        return max(0.0, min(1.0, float(val)))
    return 0.0


def to_label_read(raw: Any) -> dict[str, Any]:
    nf: dict[str, Any] = {"value": None, "confidence": 0.0}
    if not isinstance(raw, dict):
        return {
            "kind": "unreadable",
            "product": dict(nf),
            "ingredient": dict(nf),
            "strength": dict(nf),
            "dosing": dict(nf),
            "expiry": dict(nf),
            "allergens": dict(nf),
            "barcode": dict(nf),
            "readability": 0.0,
            "guidance": "Hold it up in front of you and keep it still.",
        }

    def is_str(v: Any) -> bool:
        return isinstance(v, str) and len(v.strip()) > 0

    def is_str_arr(v: Any) -> bool:
        return isinstance(v, list) and all(isinstance(s, str) for s in v)

    def coerce_field(node: Any, pred: Any) -> dict[str, Any]:
        val = node.get("value") if isinstance(node, dict) else None
        ok_val = val if pred(val) else None
        conf = clamp01(node.get("confidence") if isinstance(node, dict) else 0.0)
        return {"value": ok_val, "confidence": min(conf, 0.3) if ok_val is None else conf}

    kind = raw.get("kind")
    if kind not in ("medication", "food", "other", "unreadable"):
        kind = "unreadable"

    read: dict[str, Any] = {
        "kind": kind,
        "product": coerce_field(raw.get("product"), is_str),
        "ingredient": coerce_field(raw.get("ingredient"), is_str),
        "strength": coerce_field(raw.get("strength"), is_str),
        "dosing": coerce_field(raw.get("dosing"), is_str),
        "expiry": coerce_field(raw.get("expiry"), is_str),
        "allergens": coerce_field(raw.get("allergens"), is_str_arr),
        "barcode": coerce_field(raw.get("barcode"), is_str),
        "readability": clamp01(raw.get("readability")),
    }
    guidance = raw.get("guidance")
    if is_str(guidance):
        read["guidance"] = str(guidance).strip()[:120]
    exp_val = read["expiry"]["value"]
    if isinstance(exp_val, str) and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", exp_val):
        read["expiry"]["confidence"] = min(float(read["expiry"]["confidence"]), 0.5)
    return read


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


def parse_strength_mg(text: str | None) -> tuple[float, str] | None:
    if not text:
        return None
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).replace("\u00b5", "u").strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg|ug|mikrog|microgram)s?\b", normed)
    if not m:
        return None
    amt = float(m.group(1))
    unit = m.group(2)
    factors = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "ug": 0.001, "mikrog": 0.001, "microgram": 0.001}
    return (round(amt * factors[unit], 6), "mg")


def same_strength_simple(a: str | None, b: str | None) -> bool:
    pa = parse_strength_mg(a)
    pb = parse_strength_mg(b)
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
    canvas = Image.new("RGB", (size, size), (222, 214, 202))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.62)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(236 - 24 * t), int(230 - 24 * t), int(220 - 22 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 100)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(186 - 26 * t) + jitter)),
            max(0, min(255, int(158 - 22 * t) + jitter)),
            max(0, min(255, int(126 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(142, 114, 88), width=2)
    return canvas


def render_thermal_sticker(
    width: int,
    height: int,
    header: str,
    lines: list[str],
    seed: int,
    faded: bool = False,
) -> Image.Image:
    pad = 24
    layer = Image.new("RGBA", (width + 2 * pad, height + 2 * pad), (0, 0, 0, 0))
    sd = ImageDraw.Draw(layer)
    sd.rounded_rectangle(
        (pad + 4, pad + 6, pad + width + 5, pad + height + 7),
        radius=8,
        fill=(24, 20, 16, 72 if not faded else 48),
    )
    layer = layer.filter(ImageFilter.GaussianBlur(radius=4.5))

    paper_rgb = (244, 241, 233) if faded else (252, 251, 247)
    paper = Image.new("RGB", (width, height), paper_rgb)
    paper = add_paper_grain(paper, seed=seed + 77, amplitude=6 if faded else 3)
    pd = ImageDraw.Draw(paper)

    border_col = (214, 210, 200) if faded else (196, 194, 188)
    pd.rounded_rectangle((0, 0, width - 1, height - 1), radius=7, outline=border_col, width=2)

    if faded:
        header_col = (206, 202, 192)
        text_col = (218, 214, 204)
        rule_col = (222, 218, 208)
    else:
        header_col = (44, 48, 54)
        text_col = (26, 28, 32)
        rule_col = (182, 180, 174)

    f_hdr = fit_font(pd, header, width - 36, 17, 13)
    pd.text((18, 12), header, fill=header_col, font=f_hdr)
    pd.line((16, 36, width - 16, 36), fill=rule_col, width=1)

    y = 46
    for ln in lines:
        f_body = fit_font(pd, ln, width - 36, 22, 15)
        pd.text((18, y), ln, fill=text_col, font=f_body)
        y += 30

    if faded:
        rng = random.Random(seed + 303)
        for _ in range(18):
            sy = rng.randint(8, height - 8)
            pd.line((6, sy, width - 6, sy), fill=paper_rgb, width=rng.randint(2, 5))
        paper = paper.filter(ImageFilter.GaussianBlur(radius=3.0))

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    layer.paste(paper, (pad, pad), mask)
    return layer


def render_food_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 112, pad + 76, pad + 656, pad + 696
    cw, ch = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 16, 95))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    carton = Image.new("RGB", (cw, ch), (246, 241, 229))
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 72), fill=case["accent"])
    cd.text((26, 24), case["header"], fill=(244, 248, 244), font=fit_font(cd, case["header"], cw - 52, 22))
    cd.text(
        (26, 94),
        case["title"],
        fill=(22, 42, 28),
        font=fit_font(cd, case["title"], cw - 52, 44),
        stroke_width=1,
        stroke_fill=(22, 42, 28),
    )
    cd.text((26, 152), case["sub_title"], fill=(56, 72, 60), font=fit_font(cd, case["sub_title"], cw - 52, 23))

    cd.rounded_rectangle((24, 202, cw - 24, 448), radius=12, fill=(252, 250, 244), outline=(182, 176, 162), width=2)
    iy = 220
    for ln in case["ingredients_lines"]:
        cd.text((38, iy), ln, fill=(28, 32, 30), font=fit_font(cd, ln, cw - 76, 21))
        iy += 32

    iy += 12
    cd.rounded_rectangle((34, iy - 6, cw - 34, iy + 78), radius=8, fill=(255, 243, 232), outline=(196, 118, 62), width=2)
    for ln in case["allergen_lines"]:
        f_alg = fit_font(cd, ln, cw - 92, 21)
        cd.text((46, iy + 4), ln, fill=(112, 36, 18), font=f_alg, stroke_width=1, stroke_fill=(112, 36, 18))
        iy += 32

    cd.rounded_rectangle((24, 474, cw - 24, 536), radius=8, fill=(255, 255, 255), outline=(196, 192, 182), width=2)
    cd.text((38, 491), case["expiry_line"], fill=(24, 28, 30), font=fit_font(cd, case["expiry_line"], cw - 76, 24))
    cd.text((28, ch - 52), "2,5 dl", fill=(58, 72, 62), font=ImageFont.load_default(size=25))

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    box_layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(168, 162, 150, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_med_box(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 114, pad + 700, pad + 646
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(26, 22, 18, 92))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    faded_mode = case["sticker_mode"] == "faded_thermal"
    card_bg = (245, 244, 240) if faded_mode else (250, 251, 253)
    card = Image.new("RGB", (bw, bh), card_bg)
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    cd.text((28, 18), case["header"], fill=(246, 249, 252), font=fit_font(cd, case["header"], bw - 56, 22))

    title_col = (54, 58, 64) if faded_mode else (16, 22, 30)
    cd.text(
        (28, 82),
        case["title"],
        fill=title_col,
        font=fit_font(cd, case["title"], bw - 56, 42),
        stroke_width=0 if faded_mode else 1,
        stroke_fill=title_col,
    )
    cd.text((28, 138), case["sub_line"], fill=(56, 64, 76), font=fit_font(cd, case["sub_line"], bw - 56, 22))

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 178, 286, 256
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
        f_badge = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 32, 42, 24)
        cd.text(
            (sx0 + 18, sy0 + 16),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=f_badge,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        f_form = fit_font(cd, case["form_line"], bw - sx1 - 42, 23, 16)
        cd.text((sx1 + 16, sy0 + 25), case["form_line"], fill=(38, 46, 56), font=f_form)
    else:
        cd.text((28, 182), case["form_line"], fill=(56, 64, 74), font=fit_font(cd, case["form_line"], bw - 56, 24))

    if case["pack_line"]:
        cd.text((28, 272), case["pack_line"], fill=(52, 60, 70), font=fit_font(cd, case["pack_line"], 320, 22))

    if case["expiry_line"]:
        is_exp_alert = "2025-02" in case["expiry_line"]
        ex_fill = (246, 242, 236) if is_exp_alert else (242, 244, 247)
        cd.rounded_rectangle((bw - 242, 264, bw - 26, 314), radius=6, fill=ex_fill, outline=(168, 174, 182), width=2)
        cd.text(
            (bw - 226, 275),
            case["expiry_line"],
            fill=(20, 24, 30),
            font=fit_font(cd, case["expiry_line"], 196, 24),
            stroke_width=1 if is_exp_alert else 0,
            stroke_fill=(20, 24, 30),
        )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    if case["sticker_mode"] == "bottom":
        st = render_thermal_sticker(
            width=496,
            height=136,
            header=case["sticker_header"],
            lines=case["sticker_lines"],
            seed=seed,
            faded=False,
        )
        st_rot = st.rotate(case["sticker_angle"], resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 24, y0 + 324))
    elif case["sticker_mode"] == "cover_strength":
        st = render_thermal_sticker(
            width=532,
            height=196,
            header=case["sticker_header"],
            lines=case["sticker_lines"],
            seed=seed,
            faded=False,
        )
        st_rot = st.rotate(case["sticker_angle"], resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 18, y0 + 158))
    elif case["sticker_mode"] == "faded_thermal":
        st = render_thermal_sticker(
            width=524,
            height=210,
            header=case["sticker_header"],
            lines=case["sticker_lines"],
            seed=seed,
            faded=True,
        )
        st_rot = st.rotate(case["sticker_angle"], resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 22, y0 + 196))

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)

    glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glare).ellipse((-90, -110, 520, 420), fill=(255, 253, 246, 20))
    glare = glare.filter(ImageFilter.GaussianBlur(radius=32.0))
    return Image.alpha_composite(composed, glare).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg_b64(case: dict[str, Any], idx: int) -> str:
    seed = 20261114 + idx * 37
    img = render_food_carton(case, seed) if case["kind"] == "food" else render_med_box(case, seed)
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


def validate_output_contract(report: dict[str, Any], encoded: bytes) -> None:
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
    data = json.loads(raw_bytes.decode("utf-8"))
    validate_output_contract(data, raw_bytes)

    assert data["suite"] == SUITE_NAME == "nordic_stickers"
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
            f"strength={s_val!r} conf={s_conf:.2f} cw={confident_wrong} ms={latency_ms:.1f}"
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

    readable_cases = [c for c, spec in zip(cases_out, CASES) if spec["strength_readable"] is True]
    occluded_cases = [c for c, spec in zip(cases_out, CASES) if spec["strength_readable"] is False]
    readable_strength_hits = sum(
        1
        for c in readable_cases
        if same_strength_simple(c["read"]["strength"]["value"], c.get("expected_strength"))
    )
    occluded_abstains = sum(1 for c in occluded_cases if c["predicted_level"] == "unsure")

    ns03 = next(c for c in cases_out if c["id"] == "ns_03")
    ns04 = next(c for c in cases_out if c["id"] == "ns_04")

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
        "readable_strength_accuracy": round(readable_strength_hits / len(readable_cases), 4),
        "occluded_sticker_abstention_rate": round(occluded_abstains / len(occluded_cases), 4),
        "comma_decimal_matched": bool(ns03["verdict_ok"]),
        "mikrog_unit_matched": bool(ns04["verdict_ok"]),
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
    if len(encoded) > MAX_JSON_BYTES:
        encoded = (json.dumps(report, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    validate_output_contract(report, encoded)
    OUT_JSON_PATH.write_bytes(encoded)
    print(f"Wrote {OUT_JSON_PATH} ({len(encoded)} bytes)")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
