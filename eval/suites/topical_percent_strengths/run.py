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
MAX_WORKERS = 4
MAX_JSON_BYTES = 15360
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "med_hydrocortisone",
            "name": "Hydrocortison Orion",
            "ingredient": "hydrocortisone",
            "strength": "1 %",
            "schedule": ["evening"],
        },
        {
            "id": "med_fucidin",
            "name": "Fucidin",
            "ingredient": "fusidic acid",
            "strength": "2 %",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "med_aciclovir",
            "name": "Acyrax",
            "ingredient": "aciclovir",
            "strength": "50 mg/g",
            "schedule": ["morning"],
        },
        {
            "id": "med_betamethasone",
            "name": "Bemetson",
            "ingredient": "betamethasone",
            "strength": "0.1 %",
            "schedule": ["evening"],
        },
    ],
    "allergies": ["peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "fi",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "tp_01",
        "category": "percent_hydrocortison_1pct_match",
        "pack_style": "carton",
        "description": "HYDROCORTISON ORION 1 % cream carton matching saved 1 % evening topical steroid",
        "question": "Onko tama oikea Hydrocortison 1 % iltavoide?",
        "expected_level": "match",
        "rule_mode": "safe_match",
        "expected_med_id": "med_hydrocortisone",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "1 %",
        "box_angle": -1.5,
        "accent": (24, 102, 148),
        "header": "ORION PHARMA    Vnr 01 44 82",
        "title": "HYDROCORTISON ORION",
        "strength_badge": "1 %",
        "form_line": "emulsiovoide / cream",
        "sub_line": "Vaikuttava aine: hydrokortisoni (hydrocortisone)",
        "panel_title": "KOOSTUMUS JA KAYTTO:",
        "panel_lines": [
            "Vaikuttava aine: hydrokortisoni 1 %.",
            "Apuaineet: setostearyylialkoholi, glyseroli, puhdistettu vesi.",
        ],
        "dosing_line": "Ohut kerros iholle iltaisin",
        "expiry_line": "EXP 2028-04",
    },
    {
        "id": "tp_02",
        "category": "percent_hydrocortison_2_5pct_wrong_strength",
        "pack_style": "carton",
        "description": "HYDROCORTISON ORION 2,5 % cream carton caught as wrong strength against saved 1 %",
        "question": "Voinko kayttaa tata Hydrocortison-voidetta kasvoille?",
        "expected_level": "warning",
        "rule_mode": "wrong_strength",
        "expected_med_id": "med_hydrocortisone",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "2.5 %",
        "box_angle": 1.6,
        "accent": (176, 56, 38),
        "header": "ORION PHARMA    Vnr 09 31 64",
        "title": "HYDROCORTISON ORION",
        "strength_badge": "2,5 %",
        "form_line": "emulsiovoide / cream",
        "sub_line": "Vaikuttava aine: hydrokortisoni (hydrocortisone)",
        "panel_title": "KOOSTUMUS JA KAYTTO:",
        "panel_lines": [
            "Vaikuttava aine: hydrokortisoni 2,5 %.",
            "Apuaineet: setostearyylialkoholi, glyseroli, puhdistettu vesi.",
        ],
        "dosing_line": "Ohut kerros iholle 1-2 kertaa paivassa",
        "expiry_line": "EXP 2028-06",
    },
    {
        "id": "tp_03",
        "category": "mg_per_g_voltaren_forte_nsaid_avoid",
        "pack_style": "tube",
        "description": "VOLTAREN FORTE 23,2 mg/g diclofenac topical gel tube flagged by avoid NSAIDs",
        "question": "Can I rub this Voltaren Forte gel on my knee with my NSAID restriction?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "expected_med_id": None,
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "23.2 mg/g",
        "box_angle": -1.7,
        "accent": (216, 94, 24),
        "header": "HALEON NORDIC    Vnr 14 29 07",
        "title": "VOLTAREN FORTE",
        "strength_badge": "23,2 mg/g",
        "form_line": "geeli / gel",
        "sub_line": "Vaikuttava aine: diklofenaakki / diclofenac",
        "panel_title": "VAIKUTTAVA AINE:",
        "panel_lines": [
            "1 g geelia sisaltaa 23,2 mg/g diklofenaakkidietyyliamiinia.",
            "Paikalliseen nivel- ja lihaskivun hoitoon.",
        ],
        "dosing_line": "Levita iholle 2 kertaa vuorokaudessa",
        "expiry_line": "EXP 2028-03",
    },
    {
        "id": "tp_04",
        "category": "percent_fucidin_2pct_tube_match",
        "pack_style": "tube",
        "description": "FUCIDIN 2 % (fusidic acid) ointment tube matching saved 2 % antibiotic ointment",
        "question": "Is this my Fucidin 2 % ointment tube for morning and evening?",
        "expected_level": "match",
        "rule_mode": "safe_match",
        "expected_med_id": "med_fucidin",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "2 %",
        "box_angle": 1.4,
        "accent": (184, 38, 42),
        "header": "LEO PHARMA    Vnr 00 68 41",
        "title": "FUCIDIN",
        "strength_badge": "2 %",
        "form_line": "voide / ointment",
        "sub_line": "Active ingredient: fusidic acid (natriumfusidaatti)",
        "panel_title": "COMPOSITION:",
        "panel_lines": [
            "Contains fusidic acid (as sodium fusidate) 2 %.",
            "Excipients: cetyl alcohol, white soft paraffin.",
        ],
        "dosing_line": "Apply thinly twice daily",
        "expiry_line": "EXP 2028-05",
    },
    {
        "id": "tp_05",
        "category": "percent_bactroban_2pct_unlisted_warning",
        "pack_style": "carton",
        "description": "Look-alike BACTROBAN 2 % (mupirocin) ointment carton flagged as not on medication list",
        "question": "Is this my prescribed 2 % antibiotic skin ointment?",
        "expected_level": "warning",
        "rule_mode": "unlisted_med",
        "expected_med_id": None,
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "2 %",
        "box_angle": -1.8,
        "accent": (42, 92, 138),
        "header": "GSK NORDIC    Vnr 42 15 89",
        "title": "BACTROBAN",
        "strength_badge": "2 %",
        "form_line": "voide / salva / ointment",
        "sub_line": "Active ingredient: mupirocin (mupirosiini)",
        "panel_title": "COMPOSITION:",
        "panel_lines": [
            "Topical antibacterial ointment containing mupirocin 2 %.",
            "Excipients: macrogol 400, macrogol 3350.",
        ],
        "dosing_line": "Apply 2-3 times daily as prescribed",
        "expiry_line": "EXP 2028-01",
    },
    {
        "id": "tp_06",
        "category": "mg_per_g_acyrax_50mg_g_match",
        "pack_style": "tube",
        "description": "ACYRAX 50 mg/g (aciclovir) cream tube matching saved 50 mg/g morning antiviral",
        "question": "Is this my morning Acyrax 50 mg/g cream?",
        "expected_level": "match",
        "rule_mode": "safe_match",
        "expected_med_id": "med_aciclovir",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "50 mg/g",
        "box_angle": 1.7,
        "accent": (28, 114, 122),
        "header": "STADA NORDIC    Vnr 05 71 23",
        "title": "ACYRAX",
        "strength_badge": "50 mg/g",
        "form_line": "emulsiovoide / cream",
        "sub_line": "Vaikuttava aine: asikloviiri / aciclovir",
        "panel_title": "KOOSTUMUS:",
        "panel_lines": [
            "1 g emulsiovoidetta sisaltaa 50 mg/g asikloviiria.",
            "Apuaineet: propyleeniglykoli, valkovaseliini.",
        ],
        "dosing_line": "Levita ohuena kerroksena aamuisin",
        "expiry_line": "EXP 2028-02",
    },
    {
        "id": "tp_07",
        "category": "percent_comma_decimal_bemetson_0_1pct_match",
        "pack_style": "carton",
        "description": "BEMETSON 0,1 % (betamethasone) carton with Nordic comma decimal matching saved 0.1 %",
        "question": "Voinko laittaa tata Bemetson 0,1 % iltavoidetta ihottumaan?",
        "expected_level": "match",
        "rule_mode": "safe_match",
        "expected_med_id": "med_betamethasone",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "0.1 %",
        "box_angle": -1.4,
        "accent": (54, 78, 144),
        "header": "ORION PHARMA    Vnr 03 19 55",
        "title": "BEMETSON",
        "strength_badge": "0,1 %",
        "form_line": "emulsiovoide / cream",
        "sub_line": "Vaikuttava aine: betametasoni / betamethasone",
        "panel_title": "KOOSTUMUS:",
        "panel_lines": [
            "Vaikuttava aine: betametasoni (valeraattina) 0,1 %.",
            "Apuaineet: kloorikresoli, setostearyylialkoholi.",
        ],
        "dosing_line": "Ohut kerros iholle iltaisin",
        "expiry_line": "Kayt. viim. 08.2028",
    },
    {
        "id": "tp_08",
        "category": "percent_hydrocortison_0_5pct_wrong_strength",
        "pack_style": "carton",
        "description": "HYDROCORTISON ORION 0,5 % cream carton caught as wrong strength against saved 1 %",
        "question": "Onko tama minun 1 % Hydrocortison-voiteeni?",
        "expected_level": "warning",
        "rule_mode": "wrong_strength",
        "expected_med_id": "med_hydrocortisone",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "0.5 %",
        "box_angle": 1.8,
        "accent": (36, 122, 92),
        "header": "ORION PHARMA    Vnr 01 44 19",
        "title": "HYDROCORTISON ORION",
        "strength_badge": "0,5 %",
        "form_line": "emulsiovoide / cream",
        "sub_line": "Vaikuttava aine: hydrokortisoni (hydrocortisone)",
        "panel_title": "KOOSTUMUS JA KAYTTO:",
        "panel_lines": [
            "Vaikuttava aine: hydrokortisoni 0,5 %.",
            "Apuaineet: setostearyylialkoholi, glyseroli, puhdistettu vesi.",
        ],
        "dosing_line": "Ohut kerros iholle 1-2 kertaa paivassa",
        "expiry_line": "EXP 2028-04",
    },
    {
        "id": "tp_09",
        "category": "percent_orudis_ketoprofen_gel_nsaid_avoid",
        "pack_style": "tube",
        "description": "ORUDIS 2,5 % (ketoprofen) topical gel tube flagged under avoid NSAIDs",
        "question": "Sopiiko tama Orudis-kipugeeli minulle?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "expected_med_id": None,
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "2.5 %",
        "box_angle": -1.6,
        "accent": (146, 44, 78),
        "header": "SANOFI NORDIC    Vnr 08 62 30",
        "title": "ORUDIS",
        "strength_badge": "2,5 %",
        "form_line": "geeli / gel",
        "sub_line": "Vaikuttava aine: ketoprofeeni / ketoprofen",
        "panel_title": "VAIKUTTAVA AINE:",
        "panel_lines": [
            "Paikallinen kipugeeli, ketoprofeeni 2,5 %.",
            "Apuaineet: etanoli, karbomeeri, puhdistettu vesi.",
        ],
        "dosing_line": "Levita kipualueelle 2 kertaa paivassa",
        "expiry_line": "Kayt. viim. 09.2028",
    },
    {
        "id": "tp_10",
        "category": "percent_fucidin_2pct_expired_tube_warning",
        "pack_style": "tube",
        "description": "Expired FUCIDIN 2 % ointment tube (EXP 2025-05) caught despite matching med and strength",
        "question": "Can I still use this Fucidin 2 % tube from my cabinet?",
        "expected_level": "warning",
        "rule_mode": "expired",
        "expected_med_id": "med_fucidin",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "2 %",
        "box_angle": 1.5,
        "accent": (184, 38, 42),
        "header": "LEO PHARMA    Vnr 00 68 41",
        "title": "FUCIDIN",
        "strength_badge": "2 %",
        "form_line": "voide / ointment",
        "sub_line": "Active ingredient: fusidic acid (natriumfusidaatti)",
        "panel_title": "COMPOSITION:",
        "panel_lines": [
            "Contains fusidic acid (as sodium fusidate) 2 %.",
            "Excipients: cetyl alcohol, white soft paraffin.",
        ],
        "dosing_line": "Apply thinly twice daily",
        "expiry_line": "EXP 2025-05",
    },
    {
        "id": "tp_11",
        "category": "degraded_rolled_metal_tube_percent_hidden_unsure",
        "pack_style": "tube",
        "description": "Rolled metal HYDROCORTISON ORION tube hiding % strength band abstains as unsure",
        "question": "Onko tama putkilo minun 1 % Hydrocortison-voiteeni?",
        "expected_level": "unsure",
        "rule_mode": "abstain_strength",
        "expected_med_id": "med_hydrocortisone",
        "degradation": "rolled_metal_fold",
        "strength_readable": False,
        "expected_strength": None,
        "box_angle": -2.0,
        "accent": (24, 102, 148),
        "header": "ORION PHARMA",
        "title": "HYDROCORTISON ORION",
        "strength_badge": None,
        "form_line": "emulsiovoide / cream",
        "sub_line": "Ingredient: hydrocortisone",
        "panel_title": "",
        "panel_lines": [],
        "dosing_line": "",
        "expiry_line": "EXP 2028-04",
    },
    {
        "id": "tp_12",
        "category": "degraded_crimped_tube_fold_mg_per_g_hidden_unsure",
        "pack_style": "tube",
        "description": "Crimped and folded ACYRAX metal tube hiding mg/g concentration abstains as unsure",
        "question": "Is this my Acyrax 50 mg/g cream tube?",
        "expected_level": "unsure",
        "rule_mode": "abstain_strength",
        "expected_med_id": "med_aciclovir",
        "degradation": "crimped_tube_fold",
        "strength_readable": False,
        "expected_strength": None,
        "box_angle": 2.1,
        "accent": (28, 114, 122),
        "header": "STADA NORDIC",
        "title": "ACYRAX",
        "strength_badge": None,
        "form_line": "emulsiovoide / cream",
        "sub_line": "Ingredient: aciclovir",
        "panel_title": "",
        "panel_lines": [],
        "dosing_line": "",
        "expiry_line": "",
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


def parse_topical_strength(text: str | None) -> tuple[float, str] | None:
    if not text:
        return None
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).strip()
    m_mgg = re.search(r"(\d+(?:\.\d+)?)\s*mg\s*/\s*g\b", normed)
    if m_mgg:
        return (round(float(m_mgg.group(1)), 6), "mg/g")
    m_pct = re.search(r"(\d+(?:\.\d+)?)\s*%", normed)
    if m_pct:
        return (round(float(m_pct.group(1)), 6), "%")
    m_mg = re.search(r"(\d+(?:\.\d+)?)\s*mg\b", normed)
    if m_mg:
        return (round(float(m_mg.group(1)), 6), "mg")
    return None


def same_topical_strength(a: str | None, b: str | None) -> bool:
    pa = parse_topical_strength(a)
    pb = parse_topical_strength(b)
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


def render_topical_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 60, pad + 116, pad + 708, pad + 648
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(26, 22, 18, 92))
    box_layer = Image.alpha_composite(box_layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 60), fill=case["accent"])
    cd.text((28, 17), case["header"], fill=(246, 249, 252), font=fit_font(cd, case["header"], bw - 56, 22))
    cd.text(
        (28, 78),
        case["title"],
        fill=(16, 22, 30),
        font=fit_font(cd, case["title"], bw - 56, 40),
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    cd.text((28, 132), case["sub_line"], fill=(52, 60, 72), font=fit_font(cd, case["sub_line"], bw - 56, 22))

    sx0, sy0, sx1, sy1 = 28, 172, 278, 246
    cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
    f_badge = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 30, 38, 22)
    cd.text(
        (sx0 + 18, sy0 + 14),
        case["strength_badge"],
        fill=(14, 20, 28),
        font=f_badge,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )
    f_form = fit_font(cd, case["form_line"], bw - sx1 - 42, 22, 15)
    cd.text((sx1 + 16, sy0 + 24), case["form_line"], fill=(38, 46, 56), font=f_form)

    cd.rounded_rectangle((28, 266, bw - 28, 412), radius=10, fill=(243, 247, 251), outline=(176, 186, 198), width=2)
    cd.text(
        (42, 282),
        case["panel_title"],
        fill=(34, 52, 72),
        font=fit_font(cd, case["panel_title"], bw - 84, 20, 15),
        stroke_width=1,
        stroke_fill=(34, 52, 72),
    )
    py = 316
    for ln in case["panel_lines"]:
        cd.text((42, py), ln, fill=(32, 38, 46), font=fit_font(cd, ln, bw - 84, 20, 15))
        py += 32

    cd.text((28, 442), case["dosing_line"], fill=(42, 50, 60), font=fit_font(cd, case["dosing_line"], 354, 21, 14))
    cd.rounded_rectangle((bw - 252, 432, bw - 28, 484), radius=6, fill=(242, 244, 247), outline=(168, 174, 182), width=2)
    cd.text((bw - 236, 444), case["expiry_line"], fill=(20, 24, 30), font=fit_font(cd, case["expiry_line"], 204, 22, 15))

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)
    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(ambient).ellipse((-80, -100, 500, 400), fill=(255, 253, 246, 18))
    return Image.alpha_composite(composed, ambient.filter(ImageFilter.GaussianBlur(radius=30.0))).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_rolled_metal_fold(layer: Image.Image, fold_x0: int, y0: int, y1: int, wide: bool) -> Image.Image:
    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    fold_w = 278 if wide else 256
    sd.rounded_rectangle((fold_x0 - 16, y0 - 8, fold_x0 + fold_w + 14, y1 + 14), radius=18, fill=(18, 20, 24, 118))
    out = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(radius=9.0)))

    metal = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    md = ImageDraw.Draw(metal)
    n_rolls = 4 if wide else 3
    roll_w = int(fold_w / n_rolls)
    for r_idx in range(n_rolls):
        rx0 = fold_x0 + r_idx * roll_w
        rx1 = rx0 + roll_w - 2
        for x in range(rx0, rx1 + 1):
            frac = (x - rx0) / max(1, rx1 - rx0)
            wave = math.sin(frac * math.pi)
            base_v = int(126 + 116 * wave)
            col = (min(255, base_v), min(255, base_v + 3), min(255, base_v + 8), 255)
            md.line((x, y0 - 4, x, y1 + 4), fill=col)
        md.line((rx0, y0 - 4, rx0, y1 + 4), fill=(76, 82, 92, 255), width=3)
        md.line((rx1, y0 - 4, rx1, y1 + 4), fill=(92, 98, 108, 255), width=2)
    for cy in range(y0 + 6, y1 - 4, 14):
        md.line((fold_x0 + 4, cy, fold_x0 + fold_w - 6, cy + 2), fill=(154, 160, 170, 170), width=2)
    md.rounded_rectangle((fold_x0, y0 - 4, fold_x0 + fold_w - 2, y1 + 4), radius=10, outline=(86, 92, 102, 255), width=3)
    return Image.alpha_composite(out, metal)


def render_topical_tube(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    tube_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tx0, ty0, tx1, ty1 = pad + 128, pad + 184, pad + 716, pad + 592
    tw, th = tx1 - tx0, ty1 - ty0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((pad + 34, ty0 + 96, tx0 + 6, ty1 - 72), radius=12, fill=(24, 20, 16, 90))
    sd.rounded_rectangle((tx0 + 8, ty0 + 16, tx1 + 16, ty1 + 20), radius=20, fill=(24, 20, 16, 96))
    tube_layer = Image.alpha_composite(tube_layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    td = ImageDraw.Draw(tube_layer)
    cap_x0, cap_y0, cap_x1, cap_y1 = pad + 32, ty0 + 92, tx0 - 18, ty1 - 92
    td.rounded_rectangle((cap_x0, cap_y0, cap_x1, cap_y1), radius=10, fill=(242, 245, 249, 255), outline=(168, 176, 186, 255), width=3)
    for ry in range(cap_y0 + 12, cap_y1 - 10, 12):
        td.line((cap_x0 + 8, ry, cap_x1 - 8, ry), fill=(198, 204, 214, 255), width=2)
    td.polygon(
        [(tx0 - 18, cap_y0 + 14), (tx0 + 6, ty0 + 18), (tx0 + 6, ty1 - 18), (tx0 - 18, cap_y1 - 14)],
        fill=(212, 218, 226, 255),
        outline=(158, 166, 176, 255),
    )

    body = Image.new("RGB", (tw, th), (249, 250, 252))
    body = add_paper_grain(body, seed=seed, amplitude=3)
    bd = ImageDraw.Draw(body)
    for y in range(28):
        shade = int(226 + (23 * y) / 28)
        bd.line((0, y, tw, y), fill=(shade, shade + 1, shade + 3))
        bd.line((0, th - 1 - y, tw, th - 1 - y), fill=(shade - 8, shade - 6, shade - 3))

    crimp_w = 34
    label_w = tw - crimp_w - 8
    text_max_w = 268 if case["degradation"] != "none" else label_w - 44
    bd.rectangle((0, 18, label_w, 66), fill=case["accent"])
    bd.text((22, 29), case["header"], fill=(248, 250, 253), font=fit_font(bd, case["header"], text_max_w, 20, 14))

    bd.text(
        (22, 82),
        case["title"],
        fill=(16, 22, 30),
        font=fit_font(bd, case["title"], text_max_w, 38, 20),
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    bd.text((22, 132), case["sub_line"], fill=(48, 56, 68), font=fit_font(bd, case["sub_line"], text_max_w, 21, 14))

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 22, 170, 266, 238
        bd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(238, 244, 250), outline=case["accent"], width=3)
        f_badge = fit_font(bd, case["strength_badge"], (sx1 - sx0) - 26, 35, 20)
        bd.text(
            (sx0 + 14, sy0 + 13),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=f_badge,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        f_form = fit_font(bd, case["form_line"], label_w - sx1 - 28, 21, 14)
        bd.text((sx1 + 14, sy0 + 22), case["form_line"], fill=(38, 46, 56), font=f_form)
    else:
        bd.text((22, 176), case["form_line"], fill=(48, 56, 68), font=fit_font(bd, case["form_line"], 220, 21, 14))

    if case["panel_lines"]:
        bd.rounded_rectangle((22, 252, label_w - 14, 344), radius=8, fill=(242, 246, 250), outline=(182, 190, 202), width=2)
        py = 264
        for ln in case["panel_lines"]:
            bd.text((34, py), ln, fill=(32, 38, 46), font=fit_font(bd, ln, label_w - 64, 19, 13))
            py += 32

    if case["dosing_line"]:
        bd.text((22, 360), case["dosing_line"], fill=(42, 50, 60), font=fit_font(bd, case["dosing_line"], 300, 19, 13))
    if case["expiry_line"]:
        ex_x0 = 22 if case["degradation"] != "none" else label_w - 224
        ex_y0 = 342 if case["degradation"] != "none" else 352
        bd.rounded_rectangle((ex_x0, ex_y0, ex_x0 + 206, ex_y0 + 44), radius=6, fill=(240, 243, 247), outline=(164, 172, 182), width=2)
        bd.text((ex_x0 + 14, ex_y0 + 10), case["expiry_line"], fill=(18, 22, 28), font=fit_font(bd, case["expiry_line"], 180, 20, 14))

    bd.rectangle((tw - crimp_w, 0, tw - 1, th - 1), fill=(204, 210, 218))
    for cy in range(8, th - 8, 9):
        bd.line((tw - crimp_w + 4, cy, tw - 5, cy), fill=(150, 158, 168), width=2)

    mask = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tw - 1, th - 1), radius=14, fill=255)
    tube_layer.paste(body, (tx0, ty0), mask)
    ImageDraw.Draw(tube_layer).rounded_rectangle((tx0, ty0, tx1 - 1, ty1 - 1), radius=14, outline=(160, 168, 178, 255), width=3)

    if case["degradation"] == "rolled_metal_fold":
        tube_layer = render_rolled_metal_fold(tube_layer, tx0 + 318, ty0, ty1, wide=True)
    elif case["degradation"] == "crimped_tube_fold":
        tube_layer = render_rolled_metal_fold(tube_layer, tx0 + 332, ty0, ty1, wide=False)

    rotated = tube_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated)
    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(ambient).ellipse((-60, -80, 480, 380), fill=(255, 253, 246, 18))
    return Image.alpha_composite(composed, ambient.filter(ImageFilter.GaussianBlur(radius=28.0))).convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg_b64(case: dict[str, Any], idx: int) -> str:
    seed = 20261310 + idx * 53
    img = render_topical_tube(case, seed) if case["pack_style"] == "tube" else render_topical_carton(case, seed)
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


def rule_fired_as_expected(
    rule_mode: str,
    expected_med_id: str | None,
    pred_level: str,
    reasons: list[str],
    matched_med_id: str | None,
) -> bool:
    joined = " | ".join(reasons)
    if rule_mode == "safe_match":
        return pred_level == "match" and matched_med_id == expected_med_id
    if rule_mode == "wrong_strength":
        return pred_level == "warning" and "differs from your" in joined and matched_med_id == expected_med_id
    if rule_mode == "avoid":
        return pred_level == "warning" and "on your avoid list" in joined
    if rule_mode == "unlisted_med":
        return pred_level == "warning" and "not on your medication list" in joined
    if rule_mode == "expired":
        return pred_level == "warning" and "expired" in joined and matched_med_id == expected_med_id
    if rule_mode == "abstain_strength":
        return pred_level == "unsure" and "strength" in joined.lower()
    return False


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
    assert MAX_WORKERS <= 6, "MAX_WORKERS must be <= 6"

    readme_path = SUITE_DIR / "README.md"
    if readme_path.is_file():
        readme_txt = readme_path.read_text(encoding="utf-8")
        assert em_dash not in readme_txt and en_dash not in readme_txt, "Forbidden dash in README.md"
        assert not KEY_RE.search(readme_txt), "Forbidden key in README.md"

    raw_bytes = OUT_JSON_PATH.read_bytes()
    validate_output_contract(raw_bytes)
    data = json.loads(raw_bytes.decode("utf-8"))

    assert data["suite"] == SUITE_NAME == "topical_percent_strengths"
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
    for spec, c, rv in zip(CASES, cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: {rv['level']} != {c['predicted_level']}"
        exp_reasons = [sanitize_text(str(r)) for r in (rv.get("reasons") or [])][:4]
        assert exp_reasons == c["reasons"], f"{c['id']}: reasons mismatch"
        assert rv.get("matchedMedId") == c["matched_med_id"], f"{c['id']}: matchedMedId mismatch"
        assert rule_fired_as_expected(
            spec["rule_mode"], spec["expected_med_id"], c["predicted_level"], c["reasons"], c["matched_med_id"]
        ), f"{c['id']}: expected topical rule did not fire: {c['reasons']}"
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
        matched_med_id = verdict_row.get("matchedMedId")
        reasons = [sanitize_text(str(r)) for r in (verdict_row.get("reasons") or [])][:4]

        rule_ok = rule_fired_as_expected(
            case["rule_mode"], case["expected_med_id"], pred_level, reasons, matched_med_id
        )
        verdict_ok = pred_level == exp_level and rule_ok
        false_match = pred_level == "match" and exp_level != "match"
        unsafe_reassurance = exp_level == "warning" and pred_level in ("match", "info")

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        exp_strength = case["expected_strength"]
        sr = case["strength_readable"]

        wrong_crit_high_conf = False
        if sr is True:
            if s_val is not None and s_conf >= STRENGTH_MIN_CONF and not same_topical_strength(s_val, exp_strength):
                wrong_crit_high_conf = True
        elif sr is False:
            if s_val is not None and s_conf >= STRENGTH_MIN_CONF:
                wrong_crit_high_conf = True

        confident_wrong = bool(wrong_crit_high_conf or unsafe_reassurance or false_match)

        entry: dict[str, Any] = {
            "id": cid,
            "category": case["category"],
            "pack_style": case["pack_style"],
            "description": sanitize_text(case["description"])[:240],
            "question": sanitize_text(case["question"]),
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "matched_med_id": matched_med_id,
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
            f"ing={read_obj['ingredient']['value']!r} str={s_val!r} reasons={reasons} ms={latency_ms:.1f}"
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

    warn_cases = [c for c in cases_out if c["expected_level"] == "warning"]
    match_cases = [c for c in cases_out if c["expected_level"] == "match"]
    folded_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] == "abstain_strength"]

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
        "topical_warning_recall": round(sum(1 for c in warn_cases if c["verdict_ok"]) / len(warn_cases), 4),
        "topical_match_accuracy": round(sum(1 for c in match_cases if c["verdict_ok"]) / len(match_cases), 4),
        "rolled_tube_abstention_rate": round(sum(1 for c in folded_cases if c["predicted_level"] == "unsure") / len(folded_cases), 4),
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
