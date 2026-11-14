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

BASE_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "med_amlodipine",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
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
    "allergies": [],
    "avoid": [],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "dc_01",
        "category": "nsaid_avoid_fi_aspirin_primaspan",
        "description": "Finnish PRIMASPAN 100 mg (asetyylisalisyylihappo) carton flagged under avoid NSAIDs",
        "question": "Voinko ottaa taman Primaspan-tabletin kun minun pitaa valttaa tulehduskipulaakkeita?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "100 mg",
        "profile_override": {"allergies": [], "avoid": ["NSAIDs"], "lang": "fi"},
        "box_angle": -1.6,
        "accent": (168, 42, 48),
        "header": "ORION PHARMA    Vnr 02 18 47",
        "title": "PRIMASPAN",
        "strength_badge": "100 mg",
        "form_line": "enterotabletti",
        "sub_line": "Vaikuttava aine: asetyylisalisyylihappo",
        "panel_title": "KOOSTUMUS JA KAYTTO:",
        "panel_lines": [
            "1 enterotabletti sisaltaa 100 mg asetyylisalisyylihappoa.",
            "Apuaineet: maissitarkkelys, selluloosajauhe.",
        ],
        "dosing_line": "1 enterotabletti vuorokaudessa",
        "expiry_line": "Kayt. viim. 10.2027",
    },
    {
        "id": "dc_02",
        "category": "nsaid_avoid_fi_alias_pronaxen",
        "description": "Finnish PRONAXEN 500 mg (naprokseeni) carton flagged by Finnish avoid alias tulehduskipulaake",
        "question": "Sopiiko tama Pronaxen 500 mg kipulaake minulle?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "profile_override": {"allergies": [], "avoid": ["tulehduskipulaake"], "lang": "fi"},
        "box_angle": 1.7,
        "accent": (28, 92, 150),
        "header": "ORION PHARMA    Vnr 06 53 19",
        "title": "PRONAXEN",
        "strength_badge": "500 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: naprokseeni",
        "panel_title": "VAIKUTTAVA AINE JA APUAINEET:",
        "panel_lines": [
            "1 tabletti sisaltaa 500 mg naprokseenia.",
            "Apuaineet: povidoni, talkki, magnesiumstearaatti.",
        ],
        "dosing_line": "1 tabletti tarvittaessa laakarin ohjeella",
        "expiry_line": "Kayt. viim. 03.2028",
    },
    {
        "id": "dc_03",
        "category": "nsaid_avoid_sv_voltaren_anti_inflammatories",
        "description": "Swedish VOLTAREN 25 mg (diklofenak / diclofenac) carton flagged by avoid anti-inflammatories",
        "question": "Kan jag ta den har Voltaren 25 mg tabletten mot vark?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "25 mg",
        "profile_override": {"allergies": [], "avoid": ["anti-inflammatories"], "lang": "sv"},
        "box_angle": -1.8,
        "accent": (214, 96, 28),
        "header": "HALEON SVERIGE    Vnr 09 41 27",
        "title": "VOLTAREN",
        "strength_badge": "25 mg",
        "form_line": "filmdragerade tabletter",
        "sub_line": "Aktiv substans: diklofenakkalium (diklofenak / diclofenac)",
        "panel_title": "DEKLARATION:",
        "panel_lines": [
            "1 tablett innehaller 25 mg diklofenakkalium.",
            "Hjalpamnen: kalciumfosfat, majsstarkelse, povidon.",
        ],
        "dosing_line": "1 tablett vid behov, hogst 3 per dygn",
        "expiry_line": "Utg.dat. 2028-01",
    },
    {
        "id": "dc_04",
        "category": "nsaid_avoid_cox2_etoricoxib",
        "description": "Selective COX-2 NSAID ETORICOXIB ORION 90 mg carton flagged under avoid NSAIDs",
        "question": "Is this Etoricoxib 90 mg tablet safe with my avoid list?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "90 mg",
        "profile_override": {"allergies": [], "avoid": ["NSAIDs"], "lang": "en"},
        "box_angle": 1.5,
        "accent": (36, 106, 128),
        "header": "ORION PHARMA    Vnr 16 83 45",
        "title": "ETORICOXIB ORION",
        "strength_badge": "90 mg",
        "form_line": "film-coated tablet / tabletti",
        "sub_line": "Active ingredient: etoricoxib (etorikoksibi)",
        "panel_title": "COMPOSITION:",
        "panel_lines": [
            "Each film-coated tablet contains 90 mg etoricoxib.",
            "Excipients: calcium hydrogen phosphate, cellulose.",
        ],
        "dosing_line": "1 tablet once daily",
        "expiry_line": "EXP 2028-04",
    },
    {
        "id": "dc_05",
        "category": "penicillin_allergy_fi_amorion",
        "description": "AMORION 500 mg (amoksisilliini / amoxicillin) intercepted by Finnish allergy penisilliini",
        "question": "Voinko ottaa taman Amorion 500 mg antibiootin kun minulla on penisilliiniallergia?",
        "expected_level": "warning",
        "rule_mode": "allergy",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "profile_override": {"allergies": ["penisilliini"], "avoid": [], "lang": "fi"},
        "box_angle": -1.5,
        "accent": (152, 36, 52),
        "header": "ORION PHARMA    Vnr 06 14 28",
        "title": "AMORION",
        "strength_badge": "500 mg",
        "form_line": "kalvopaallysteinen tabletti",
        "sub_line": "Vaikuttava aine: amoksisilliini / amoxicillin",
        "panel_title": "VAIKUTTAVA AINE JA APUAINEET:",
        "panel_lines": [
            "1 tabletti sisaltaa 500 mg amoksisilliinia.",
            "Apuaineet: mikrokiteinen selluloosa, magnesiumstearaatti.",
        ],
        "dosing_line": "1 tabletti 3 kertaa vuorokaudessa",
        "expiry_line": "Kayt. viim. 12.2027",
    },
    {
        "id": "dc_06",
        "category": "penicillin_allergy_extended_selexid",
        "description": "Extended-spectrum penicillin SELEXID 200 mg (pivmecillinam) intercepted by penicillin allergy",
        "question": "Is this Selexid 200 mg antibiotic safe with my penicillin allergy?",
        "expected_level": "warning",
        "rule_mode": "allergy",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "200 mg",
        "profile_override": {"allergies": ["penicillin"], "avoid": [], "lang": "en"},
        "box_angle": 1.9,
        "accent": (42, 84, 148),
        "header": "LEO PHARMA NORDIC    Vnr 01 72 85",
        "title": "SELEXID",
        "strength_badge": "200 mg",
        "form_line": "film-coated tablet / filmdragerad tablett",
        "sub_line": "Active ingredient: pivmecillinam (pivmecillinam hydrochloride)",
        "panel_title": "COMPOSITION:",
        "panel_lines": [
            "Each film-coated tablet contains 200 mg pivmecillinam.",
            "Excipients: microcrystalline cellulose, paraffin.",
        ],
        "dosing_line": "1 tablet 3 times daily",
        "expiry_line": "EXP 2028-05",
    },
    {
        "id": "dc_07",
        "category": "benzodiazepine_avoid_opamox",
        "description": "OPAMOX 15 mg (oksatsapaami / oxazepam) carton flagged under avoid benzodiazepines",
        "question": "Is this Opamox 15 mg tablet safe for me to take tonight?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "15 mg",
        "profile_override": {"allergies": [], "avoid": ["benzodiazepines"], "lang": "fi"},
        "box_angle": -1.7,
        "accent": (66, 72, 138),
        "header": "ORION PHARMA    Vnr 03 82 14",
        "title": "OPAMOX",
        "strength_badge": "15 mg",
        "form_line": "tabletti / tablet",
        "sub_line": "Vaikuttava aine: oksatsapaami / oxazepam",
        "panel_title": "KOOSTUMUS:",
        "panel_lines": [
            "1 tabletti sisaltaa 15 mg oksatsepaamia (oxazepam).",
            "Apuaineet: maissitarkkelys, esigelatinoitu tarkkelys.",
        ],
        "dosing_line": "1 tabletti laakarin ohjeen mukaan",
        "expiry_line": "Kayt. viim. 06.2028",
    },
    {
        "id": "dc_08",
        "category": "opioid_combo_panacod_overrides_panadol_match",
        "description": "PANACOD 500 mg / 30 mg (paracetamol, codeine) overrides Panadol 500 mg med match via avoid opioids",
        "question": "Is this my noon Panadol 500 mg painkiller?",
        "expected_level": "warning",
        "rule_mode": "avoid_override_med",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "500 mg + 30 mg",
        "profile_override": {"allergies": [], "avoid": ["opioids"], "lang": "fi"},
        "box_angle": 1.6,
        "accent": (176, 48, 44),
        "header": "SANOFI NORDIC    Vnr 07 24 91",
        "title": "PANACOD",
        "strength_badge": "500 mg / 30 mg",
        "form_line": "tabletti / tablet",
        "sub_line": "Vaikuttavat aineet: parasetamoli + kodeiini / paracetamol, codeine",
        "panel_title": "VAIKUTTAVAT AINEET:",
        "panel_lines": [
            "1 tabletti sisaltaa 500 mg parasetamolia ja 30 mg kodeiinia.",
            "Apuaineet: maissitarkkelys, povidoni, kaliumsorbaatti.",
        ],
        "dosing_line": "1-2 tablettia tarvittaessa",
        "expiry_line": "EXP 2028-02",
    },
    {
        "id": "dc_09",
        "category": "statin_avoid_atorvastatin",
        "description": "ATORVASTATIN ORION 20 mg (atorvastatiini / atorvastatin) flagged under avoid statins",
        "question": "Can I take this Atorvastatin Orion 20 mg tablet?",
        "expected_level": "warning",
        "rule_mode": "avoid",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "20 mg",
        "profile_override": {"allergies": [], "avoid": ["statins"], "lang": "fi"},
        "box_angle": -1.4,
        "accent": (32, 114, 102),
        "header": "ORION PHARMA    Vnr 45 19 62",
        "title": "ATORVASTATIN ORION",
        "strength_badge": "20 mg",
        "form_line": "kalvopaallysteinen tabletti / tablet",
        "sub_line": "Vaikuttava aine: atorvastatiini / atorvastatin",
        "panel_title": "KOOSTUMUS:",
        "panel_lines": [
            "1 tabletti sisaltaa 20 mg atorvastatiinia (atorvastatin).",
            "Apuaineet: kalsiumkarbonaatti, mikrokiteinen selluloosa.",
        ],
        "dosing_line": "1 tabletti kerran vuorokaudessa",
        "expiry_line": "EXP 2028-07",
    },
    {
        "id": "dc_10",
        "category": "safe_non_nsaid_non_opioid_panadol_match",
        "description": "Safe PANADOL 500 mg (paracetamol) matches profile.meds under avoid NSAIDs, opioids, benzodiazepines",
        "question": "Can I take my noon Panadol 500 mg tablet with my avoid list?",
        "expected_level": "match",
        "rule_mode": "safe_match",
        "degradation": "none",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "profile_override": {"allergies": [], "avoid": ["NSAIDs", "opioids", "benzodiazepines"], "lang": "en"},
        "box_angle": 1.5,
        "accent": (22, 104, 152),
        "header": "HALEON NORDIC    Vnr 04 92 18",
        "title": "PANADOL",
        "strength_badge": "500 mg",
        "form_line": "film-coated tablet / tabletti",
        "sub_line": "Active ingredient: paracetamol (parasetamoli)",
        "panel_title": "COMPOSITION & EXCIPIENTS:",
        "panel_lines": [
            "Each film-coated tablet contains 500 mg paracetamol.",
            "Excipients: maize starch, povidone, potassium sorbate.",
        ],
        "dosing_line": "1 tablet at noon as needed",
        "expiry_line": "EXP 2028-03",
    },
    {
        "id": "dc_11",
        "category": "degraded_thumb_sticker_identity_occluded_unsure",
        "description": "Analgesic carton with thumb and pharmacy sticker covering brand and active ingredient abstains as unsure",
        "question": "Is this painkiller safe with my NSAID and opioid restrictions?",
        "expected_level": "unsure",
        "rule_mode": "abstain_identity",
        "degradation": "thumb_and_sticker",
        "strength_readable": False,
        "expected_strength": None,
        "profile_override": {"allergies": ["penicillin"], "avoid": ["NSAIDs", "opioids"], "lang": "fi"},
        "box_angle": -2.4,
        "accent": (86, 98, 114),
        "header": "",
        "title": "",
        "strength_badge": None,
        "form_line": "kalvopaallysteinen tabletti",
        "sub_line": "",
        "panel_title": "",
        "panel_lines": [],
        "dosing_line": "Saryyn ja kuumeeseen",
        "expiry_line": "",
        "sticker_header": "APTEEKKI - PALAUTUSMERKINTA",
        "sticker_lines": [
            "TARKISTA VAIKUTTAVA AINE",
            "EI SAA LUOVUTTAA ILMAN OHJETTA",
        ],
    },
    {
        "id": "dc_12",
        "category": "degraded_specular_glare_strength_unclear_unsure",
        "description": "PANADOL carton on profile.meds (500 mg) with specular glare washing out strength digits abstains as unsure",
        "question": "Can I take this Panadol tablet now?",
        "expected_level": "unsure",
        "rule_mode": "abstain_strength",
        "degradation": "strength_glare",
        "strength_readable": False,
        "expected_strength": None,
        "profile_override": {"allergies": [], "avoid": ["NSAIDs"], "lang": "en"},
        "box_angle": 1.8,
        "accent": (22, 104, 152),
        "header": "HALEON NORDIC    Vnr 04 92 18",
        "title": "PANADOL",
        "strength_badge": None,
        "form_line": "film-coated tablets",
        "sub_line": "Active ingredient: paracetamol (parasetamoli)",
        "panel_title": "COMPOSITION & EXCIPIENTS:",
        "panel_lines": [
            "Film-coated paracetamol analgesic tablets.",
            "Excipients: maize starch, povidone, potassium sorbate.",
        ],
        "dosing_line": "Take according to package leaflet",
        "expiry_line": "EXP 2028-03",
    },
]


def build_case_profile(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    merged["meds"] = list(override.get("meds", base["meds"]))
    merged["allergies"] = list(override.get("allergies", base["allergies"]))
    merged["avoid"] = list(override.get("avoid", base["avoid"]))
    merged["doseLog"] = list(override.get("doseLog", base["doseLog"]))
    merged["lang"] = str(override.get("lang", base["lang"]))
    return merged


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


def parse_strength_list(text: str | None) -> list[tuple[float, str]]:
    if not text:
        return []
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).replace("\u00b5", "u").strip()
    factors = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "ug": 0.001, "mikrog": 0.001, "microgram": 0.001}
    out: list[tuple[float, str]] = []
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg|ug|mikrog|microgram|iu|ky)s?\b", normed):
        amt = float(m.group(1))
        unit = m.group(2)
        if unit in ("iu", "ky"):
            out.append((round(amt, 6), "iu"))
        else:
            out.append((round(amt * factors[unit], 6), "mg"))
    return out


def same_strength_eval(a: str | None, b: str | None) -> bool:
    pa = parse_strength_list(a)
    pb = parse_strength_list(b)
    if not pa or not pb or len(pa) != len(pb):
        return False
    return all(ua == ub and abs(va - vb) < 1e-6 for (va, ua), (vb, ub) in zip(pa, pb))


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
    sd.rounded_rectangle((pad + 4, pad + 6, pad + width + 5, pad + height + 7), radius=8, fill=(24, 20, 16, 86))
    layer = layer.filter(ImageFilter.GaussianBlur(radius=4.0))

    paper = Image.new("RGB", (width, height), (248, 244, 232))
    paper = add_paper_grain(paper, seed=seed + 55, amplitude=5)
    pd = ImageDraw.Draw(paper)
    pd.rounded_rectangle((0, 0, width - 1, height - 1), radius=7, outline=(188, 180, 164), width=2)
    pd.rectangle((2, 2, width - 3, 40), fill=(218, 86, 40))
    pd.text((16, 10), header, fill=(255, 252, 246), font=fit_font(pd, header, width - 32, 18, 13))

    y = 54
    for ln in lines:
        pd.text((18, y), ln, fill=(32, 34, 38), font=fit_font(pd, ln, width - 36, 20, 14))
        y += 32

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    layer.paste(paper, (pad, pad), mask)
    return layer


def render_thumb_grip(size: int) -> Image.Image:
    thumb = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(thumb)
    td.polygon(
        [(0, 260), (240, 210), (430, 250), (468, 326), (432, 408), (220, 444), (0, 468)],
        fill=(24, 18, 14, 96),
    )
    thumb = thumb.filter(ImageFilter.GaussianBlur(radius=10.0))
    skin = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sk = ImageDraw.Draw(skin)
    sk.polygon(
        [(0, 248), (236, 198), (420, 238), (456, 314), (420, 392), (212, 428), (0, 452)],
        fill=(208, 164, 140, 255),
    )
    sk.ellipse((356, 254, 446, 366), fill=(228, 192, 174, 255), outline=(182, 138, 116, 255), width=2)
    skin = skin.filter(ImageFilter.GaussianBlur(radius=1.8))
    return Image.alpha_composite(thumb, skin)


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
    if case["header"]:
        cd.text((28, 18), case["header"], fill=(246, 249, 252), font=fit_font(cd, case["header"], bw - 56, 22))
    if case["title"]:
        cd.text(
            (28, 80),
            case["title"],
            fill=(16, 22, 30),
            font=fit_font(cd, case["title"], bw - 56, 42),
            stroke_width=1,
            stroke_fill=(16, 22, 30),
        )
    if case["sub_line"]:
        cd.text((28, 136), case["sub_line"], fill=(52, 60, 72), font=fit_font(cd, case["sub_line"], bw - 56, 22))

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 176, 306, 252
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
        f_badge = fit_font(cd, case["strength_badge"], (sx1 - sx0) - 28, 38, 22)
        cd.text(
            (sx0 + 16, sy0 + 16),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=f_badge,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        f_form = fit_font(cd, case["form_line"], bw - sx1 - 42, 22, 15)
        cd.text((sx1 + 16, sy0 + 25), case["form_line"], fill=(38, 46, 56), font=f_form)
    elif case["degradation"] == "strength_glare":
        sx0, sy0, sx1, sy1 = 28, 176, 306, 252
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(252, 253, 255), outline=(218, 226, 236), width=2)
        f_form = fit_font(cd, case["form_line"], bw - sx1 - 42, 22, 15)
        cd.text((sx1 + 16, sy0 + 25), case["form_line"], fill=(38, 46, 56), font=f_form)
    else:
        cd.text((28, 310), case["form_line"], fill=(72, 78, 88), font=fit_font(cd, case["form_line"], bw - 56, 22))

    if case["panel_lines"]:
        cd.rounded_rectangle((28, 272, bw - 28, 426), radius=10, fill=(243, 247, 251), outline=(176, 186, 198), width=2)
        cd.text(
            (42, 288),
            case["panel_title"],
            fill=(34, 52, 72),
            font=fit_font(cd, case["panel_title"], bw - 84, 21, 15),
            stroke_width=1,
            stroke_fill=(34, 52, 72),
        )
        py = 324
        for ln in case["panel_lines"]:
            cd.text((42, py), ln, fill=(32, 38, 46), font=fit_font(cd, ln, bw - 84, 21, 15))
            py += 34

    if case["dosing_line"]:
        cd.text((28, 456), case["dosing_line"], fill=(42, 50, 60), font=fit_font(cd, case["dosing_line"], 356, 21, 14))
    if case["expiry_line"]:
        cd.rounded_rectangle((bw - 254, 446, bw - 28, 498), radius=6, fill=(242, 244, 247), outline=(168, 174, 182), width=2)
        cd.text((bw - 238, 458), case["expiry_line"], fill=(20, 24, 30), font=fit_font(cd, case["expiry_line"], 204, 22, 15))

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    if case["degradation"] == "thumb_and_sticker":
        st = render_opaque_sticker(572, 278, case["sticker_header"], case["sticker_lines"], seed)
        st_rot = st.rotate(-2.4, resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 12, y0 + 8))
        box_layer = Image.alpha_composite(box_layer, render_thumb_grip(size))

    if case["degradation"] == "strength_glare":
        bloom = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bloom)
        bd.ellipse((x0 + 4, y0 + 158, x0 + 334, y0 + 272), fill=(255, 255, 252, 248))
        bloom = bloom.filter(ImageFilter.GaussianBlur(radius=14.0))
        core = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(core).rounded_rectangle((x0 + 18, y0 + 168, x0 + 314, y0 + 258), radius=18, fill=(255, 255, 255, 255))
        core = core.filter(ImageFilter.GaussianBlur(radius=4.0))
        box_layer = Image.alpha_composite(box_layer, bloom)
        box_layer = Image.alpha_composite(box_layer, core)

    rotated_box = box_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated_box)
    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(ambient).ellipse((-80, -100, 500, 400), fill=(255, 253, 246, 18))
    out_rgb = Image.alpha_composite(composed, ambient.filter(ImageFilter.GaussianBlur(radius=30.0))).convert("RGB")
    cropped = out_rgb.crop((pad, pad, pad + 768, pad + 768))
    if case["degradation"] == "thumb_and_sticker":
        cropped = cropped.filter(ImageFilter.GaussianBlur(radius=3.2))
    return cropped


def render_case_jpeg_b64(case: dict[str, Any], idx: int) -> str:
    seed = 20261240 + idx * 47
    img = render_med_carton(case, seed)
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


def rule_fired_as_expected(rule_mode: str, pred_level: str, reasons: list[str], matched_med_id: str | None) -> bool:
    joined = " | ".join(reasons)
    if rule_mode == "avoid":
        return pred_level == "warning" and "on your avoid list" in joined
    if rule_mode == "avoid_override_med":
        return pred_level == "warning" and "on your avoid list" in joined and matched_med_id in ("med_paracetamol", None)
    if rule_mode == "allergy":
        return pred_level == "warning" and "allergy:" in joined
    if rule_mode == "safe_match":
        return pred_level == "match" and matched_med_id == "med_paracetamol"
    if rule_mode in ("abstain_identity", "abstain_strength"):
        return pred_level == "unsure"
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
    assert MAX_WORKERS <= 4, "MAX_WORKERS must be <= 4"

    readme_path = SUITE_DIR / "README.md"
    if readme_path.is_file():
        readme_txt = readme_path.read_text(encoding="utf-8")
        assert em_dash not in readme_txt and en_dash not in readme_txt, "Forbidden dash in README.md"
        assert not KEY_RE.search(readme_txt), "Forbidden key in README.md"

    raw_bytes = OUT_JSON_PATH.read_bytes()
    validate_output_contract(raw_bytes)
    data = json.loads(raw_bytes.decode("utf-8"))

    assert data["suite"] == SUITE_NAME == "drug_class_contraindications"
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
        [
            {
                "read": c["read"],
                "profile": build_case_profile(data["profile"], c["profile_override"]),
                "now": data["eval_now_iso"],
            }
            for c in cases
        ]
    )
    for spec, c, rv in zip(CASES, cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: {rv['level']} != {c['predicted_level']}"
        exp_reasons = [sanitize_text(str(r)) for r in (rv.get("reasons") or [])]
        assert rule_fired_as_expected(spec["rule_mode"], rv["level"], exp_reasons, rv.get("matchedMedId")), (
            f"{c['id']}: live drug-class rule did not fire: {exp_reasons}"
        )
        if c["predicted_level"] == "match":
            assert rv.get("matchedMedId") == c["matched_med_id"], f"{c['id']}: matchedMedId mismatch"
        assert rule_fired_as_expected(spec["rule_mode"], c["predicted_level"], c["reasons"], c["matched_med_id"]), (
            f"{c['id']}: expected drug-class rule did not fire: {c['reasons']}"
        )
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    c11 = next(c for c in cases if c["id"] == "dc_11")
    c11_name_conf = max(
        float(c11["read"]["product"]["confidence"]) if c11["read"]["product"]["value"] else 0.0,
        float(c11["read"]["ingredient"]["confidence"]) if c11["read"]["ingredient"]["value"] else 0.0,
    )
    assert c11_name_conf < 0.6 and float(c11["read"]["readability"]) < 0.5, f"dc_11 thresholds not met: {c11['read']}"

    c12 = next(c for c in cases if c["id"] == "dc_12")
    assert "strength" in " ".join(c12["reasons"]).lower(), f"dc_12 expected strength unclear reason: {c12['reasons']}"

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
        case_prof = build_case_profile(BASE_PROFILE, case["profile_override"])
        bridge_inputs.append({"read": read_obj, "profile": case_prof, "now": EVAL_NOW_ISO})

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

        rule_ok = rule_fired_as_expected(case["rule_mode"], pred_level, reasons, matched_med_id)
        verdict_ok = pred_level == exp_level and rule_ok
        false_match = pred_level == "match" and exp_level != "match"
        unsafe_reassurance = exp_level == "warning" and pred_level in ("match", "info")

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        exp_strength = case["expected_strength"]
        sr = case["strength_readable"]

        wrong_crit_high_conf = False
        if sr is True:
            if s_val is not None and s_conf >= STRENGTH_MIN_CONF and not same_strength_eval(s_val, exp_strength):
                wrong_crit_high_conf = True
        elif sr is False:
            if s_val is not None and s_conf >= STRENGTH_MIN_CONF:
                wrong_crit_high_conf = True
        if case["degradation"] == "thumb_and_sticker":
            if (read_obj["product"]["value"] is not None and float(read_obj["product"]["confidence"]) >= 0.8) or (
                read_obj["ingredient"]["value"] is not None and float(read_obj["ingredient"]["confidence"]) >= 0.8
            ):
                wrong_crit_high_conf = True

        confident_wrong = bool(wrong_crit_high_conf or unsafe_reassurance or false_match)

        entry: dict[str, Any] = {
            "id": cid,
            "category": case["category"],
            "description": sanitize_text(case["description"])[:240],
            "question": sanitize_text(case["question"]),
            "profile_override": sanitize_text(case["profile_override"]),
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

    contra_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] in ("avoid", "avoid_override_med", "allergy")]
    avoid_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] in ("avoid", "avoid_override_med")]
    allergy_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] == "allergy"]
    safe_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] == "safe_match"]
    degraded_cases = [c for c, s in zip(cases_out, CASES) if s["rule_mode"] in ("abstain_identity", "abstain_strength")]

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
        "contraindication_warning_recall": round(sum(1 for c in contra_cases if c["verdict_ok"]) / len(contra_cases), 4),
        "class_avoid_recall": round(sum(1 for c in avoid_cases if c["verdict_ok"]) / len(avoid_cases), 4),
        "class_allergy_recall": round(sum(1 for c in allergy_cases if c["verdict_ok"]) / len(allergy_cases), 4),
        "safe_control_match_rate": round(sum(1 for c in safe_cases if c["verdict_ok"]) / len(safe_cases), 4),
        "degraded_abstention_rate": round(sum(1 for c in degraded_cases if c["predicted_level"] == "unsure") / len(degraded_cases), 4),
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
            "profile": BASE_PROFILE,
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
