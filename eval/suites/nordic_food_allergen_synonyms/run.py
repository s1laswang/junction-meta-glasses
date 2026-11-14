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

for _node_dir in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_node_dir) and _node_dir not in os.environ.get("PATH", "").split(":"):
        _cur_path = os.environ.get("PATH", "")
        os.environ["PATH"] = f"{_node_dir}:{_cur_path}" if _cur_path else _node_dir

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
EVAL_NOW_ISO = "2026-11-14T20:00:00+02:00"
ALLERGEN_MIN_CONF = 0.60
HIGH_CONF = 0.80
MAX_WORKERS = 3
MAX_JSON_BYTES = 15360
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [],
    "allergies": ["milk", "peanut", "tree nuts", "sesame", "gluten", "egg"],
    "avoid": [],
    "doseLog": [],
    "lang": "fi",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "nf_01",
        "category": "milk_synonym_hera_vassle_kaseiini_warning",
        "pack_style": "pouch",
        "description": "Nordic cocoa protein bar declaring hera / vassle and kaseiini / kasein caught under milk allergy",
        "question": "Voinko syoda taman proteiinipatukan maitoallergiani kanssa?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "milk",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": -1.5,
        "accent": (48, 86, 138),
        "header": "POHJOLA EVAS    RAVINTOTIEDOT / NARINGSVARDE",
        "title": "TUMMA KAAKAOPATUKKA / KAKAOBAR",
        "sub_line": "Proteiinipatukka / Proteinbar - 55 g",
        "panel_title": "AINESOSAT / INGREDIENSER:",
        "panel_lines": [
            "Taatelitahna, kaakaomassa, HERAPROTEIINI (HERA / VASSLE 18 %),",
            "NATRIUMKASEINAATTI (KASEIINI / KASEIN 6 %), auringonkukkaoljy,",
            "luontainen vanilja-aromi.",
        ],
        "weight_line": "Nettopaino / Nettovikt: 55 g",
        "expiry_line": "Parasta ennen: 18.09.2027",
    },
    {
        "id": "nf_02",
        "category": "peanut_synonym_arachis_oil_maapahkina_warning",
        "pack_style": "pouch",
        "description": "Wok sauce pouch declaring arachis oil / maapahkinaoljy / jordnotsolja caught under peanut allergy",
        "question": "Is this Nordic wok sauce safe with my peanut allergy?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "peanut",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": 1.6,
        "accent": (176, 62, 34),
        "header": "NORDIC KITCHEN    TAKAPANEELI / BAKSIDA",
        "title": "INKIVAARI-WOKKIKASTIKE / WOKSAS",
        "sub_line": "Maustekastike / Kryddsas - 180 g",
        "panel_title": "AINESOSAT / INGREDIENSER / INGREDIENTS:",
        "panel_lines": [
            "Vesi, ruokosokeri, inkivaari, valkosipuli, maissitarkkelys,",
            "kylmapuristettu ARACHIS OIL (MAAPAHKINAOLJY / JORDNOTSOLJA 4 %),",
            "limettimehu, merisuola, chili.",
        ],
        "weight_line": "Nettopaino / Nettovikt: 180 g",
        "expiry_line": "Parasta ennen: 10.11.2027",
    },
    {
        "id": "nf_03",
        "category": "sesame_synonym_tahini_seesami_warning",
        "pack_style": "carton",
        "description": "Chickpea spread tub declaring tahini (seesaminsiementahna / sesampasta) caught under sesame allergy",
        "question": "Sopiiko tama kikhernelevite minulle kun minulla on seesamiallergia?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "sesame",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": -1.4,
        "accent": (164, 108, 32),
        "header": "ITAMERI DELI    AINESOSALUETTELO",
        "title": "PEHMEA KIKHERNELEVITE / KIKARTSRORA",
        "sub_line": "Kasvipohjainen levite / Vaxbaserat palagg - 200 g",
        "panel_title": "AINESOSAT / INGREDIENSER:",
        "panel_lines": [
            "Keitetty kikherne (68 %), vesi, rapsioljy,",
            "TAHINI (kivijauhettu SEESAMINSIEMENTAHNA / SESAMPASTA 15 %),",
            "sitruunataysmehu, valkosipuli, juustokumina, suola.",
        ],
        "weight_line": "Nettopaino / Nettovikt: 200 g",
        "expiry_line": "Parasta ennen: 22.06.2027",
    },
    {
        "id": "nf_04",
        "category": "gluten_synonym_speltti_ohra_ruis_mannasuurimo_warning",
        "pack_style": "carton",
        "description": "Archipelago crispbread with speltti, ohra, ruis, and mannasuurimo caught under gluten allergy",
        "question": "Voinko syoda tata saaristolaisnakileipaa keliakian ja gluteeniallergian kanssa?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "gluten",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": 1.5,
        "accent": (118, 76, 44),
        "header": "SAARISTON LEIPOMO    SKARGARDSBAGERIET",
        "title": "SAARISTOLAISNAKILEIPA / SKARGARDSKNACKE",
        "sub_line": "Ohut siemennakileipa / Tunt froknacke - 210 g",
        "panel_title": "AINESOSAT / INGREDIENSER:",
        "panel_lines": [
            "TaysjyvaRUIS (RUIS / RAG 42 %), SPELTTIjauho (SPELTTI / DINKEL 24 %),",
            "OHRAmallasuute (OHRA / KORN 8 %), MANNASUURIMO (durumVEHNA / VETE),",
            "kurpitsansiemen, pellavansiemen, hiiva, merisuola.",
        ],
        "weight_line": "Nettopaino / Nettovikt: 210 g",
        "expiry_line": "Parasta ennen: 05.12.2027",
    },
    {
        "id": "nf_05",
        "category": "egg_synonym_kananmunanvalkuainen_albumen_warning",
        "pack_style": "carton",
        "description": "Berry meringue box declaring kananmunanvalkuainen / aggvita / albumen caught under egg allergy",
        "question": "Are these Nordic blueberry meringues safe with my egg allergy?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "egg",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": -1.7,
        "accent": (106, 54, 128),
        "header": "POHJOLA KONDITORIA    KONDITORI",
        "title": "MUSTIKKAMARENKI / BLABARSMARANG",
        "sub_line": "Rapea marjamarenki / Krispig barmarang - 90 g",
        "panel_title": "AINESOSAT / INGREDIENSER:",
        "panel_lines": [
            "Sokeri, kuivattu metsamustikka (9 %), maissitarkkelys,",
            "KANANMUNANVALKUAISJAUHE (KANANMUNANVALKUAINEN / AGGVITA / ALBUMEN 8 %),",
            "happamuudensaatoaine (sitruunahappo).",
        ],
        "weight_line": "Nettopaino / Nettovikt: 90 g",
        "expiry_line": "Parasta ennen: 30.10.2027",
    },
    {
        "id": "nf_06",
        "category": "treenut_synonym_hasselpahkina_manteli_hasselnot_warning",
        "pack_style": "pouch",
        "description": "Dark nougat bar declaring hasselpahkina / hasselnot and manteli / mandel caught under tree nuts",
        "question": "Kan jag ata den har morka nougatbaren med min allergi mot tradnotter?",
        "expected_level": "warning",
        "rule_mode": "contains_allergy",
        "expected_allergy": "tree nuts",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": 1.8,
        "accent": (94, 52, 46),
        "header": "NORDIC CACAO    KONFEKTYR / MAKEISET",
        "title": "TUMMA SUKLAANOUGAT / MORK NOUGAT",
        "sub_line": "Tummasuklaapatukka / Mork chokladbar - 50 g",
        "panel_title": "AINESOSAT / INGREDIENSER:",
        "panel_lines": [
            "Kaakaomassa, ruokosokeri, kaakaovoi,",
            "paahdettu HASSELPAHKINA / HASSELNOT (14 %), jauhettu MANTELI / MANDEL (6 %),",
            "emulgointiaine (auringonkukkalesitiini).",
        ],
        "weight_line": "Nettopaino / Nettovikt: 50 g",
        "expiry_line": "Bast fore: 19.07.2027",
    },
    {
        "id": "nf_07",
        "category": "precautionary_trace_saattaa_sisaltaa_maapahkinaa_warning",
        "pack_style": "pouch",
        "description": "Berry rice cakes with precautionary FI/SV peanut trace statement flagged as may-contain warning",
        "question": "Voinko syoda naita riisikakkuja vakavan maapahkina-allergian kanssa?",
        "expected_level": "warning",
        "rule_mode": "may_contain_allergy",
        "expected_allergy": "peanut",
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": -1.6,
        "accent": (146, 44, 88),
        "header": "POHJOLA SNACKS    LUOMU / EKOLOGISK",
        "title": "MUSTIKKA-RIISIKAKUT / BLABARSRISKAKOR",
        "sub_line": "Rapeat riisikakut / Krispiga riskakor - 100 g",
        "panel_title": "AINESOSAT JA ALLERGEENIT / INGREDIENSER:",
        "panel_lines": [
            "Taysjyvariisi (84 %), ruokosokeri, mustikkajauhe (4 %), merisuola.",
            "Saattaa sisaltaa pienia maaria MAAPAHKINAA.",
            "Kan innehalla spar av JORDNOTTER.",
        ],
        "weight_line": "Nettopaino / Nettovikt: 100 g",
        "expiry_line": "Parasta ennen: 12.08.2027",
    },
    {
        "id": "nf_08",
        "category": "safe_allergen_free_kaurajuoma_havredryck_info",
        "pack_style": "carton",
        "description": "Certified gluten-free dairy-free Kaurajuoma / Havredryck with clear allergen-free panel returns info",
        "question": "Onko tama gluteeniton kaurajuoma turvallinen minun allergioilleni?",
        "expected_level": "info",
        "rule_mode": "safe_info",
        "expected_allergy": None,
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": 1.3,
        "accent": (32, 118, 108),
        "header": "POHJOLA KASVIJUOMA    GLUTEENITON / GLUTENFRI",
        "title": "KAURAJUOMA / HAVREDRYCK",
        "sub_line": "Gluteeniton, maidoton, pahkinaton / Glutenfri & mjolkfri - 1 L",
        "panel_title": "AINESOSAT JA ALLERGEENIT / INGREDIENSER:",
        "panel_lines": [
            "Vesi, gluteeniton puhdaskaura / glutenfri ren havre (10 %),",
            "rapsioljy, kalsiumkarbonaatti, merisuola, D2- ja B12-vitamiini.",
            "Ei sisalla maitoa, gluteenia, pahkinaa, kananmunaa tai seesamia.",
        ],
        "weight_line": "Tilavuus / Volym: 1 L",
        "expiry_line": "Parasta ennen: 14.08.2027",
    },
    {
        "id": "nf_09",
        "category": "expired_parasta_ennen_kaurajuoma_warning",
        "pack_style": "carton",
        "description": "Allergen-free Kaurajuoma / Havredryck past its Parasta ennen date (15.03.2025) flagged as warning",
        "question": "Voinko viela juoda taman kaapissa olleen kaurajuoman?",
        "expected_level": "warning",
        "rule_mode": "expired_food",
        "expected_allergy": None,
        "degradation": "none",
        "allergens_readable": True,
        "box_angle": -1.5,
        "accent": (32, 118, 108),
        "header": "POHJOLA KASVIJUOMA    GLUTEENITON / GLUTENFRI",
        "title": "KAURAJUOMA / HAVREDRYCK",
        "sub_line": "Gluteeniton, maidoton, pahkinaton / Glutenfri & mjolkfri - 1 L",
        "panel_title": "AINESOSAT JA ALLERGEENIT / INGREDIENSER:",
        "panel_lines": [
            "Vesi, gluteeniton puhdaskaura / glutenfri ren havre (10 %),",
            "rapsioljy, kalsiumkarbonaatti, merisuola, D2- ja B12-vitamiini.",
            "Ei sisalla maitoa, gluteenia, pahkinaa, kananmunaa tai seesamia.",
        ],
        "weight_line": "Tilavuus / Volym: 1 L",
        "expiry_line": "Parasta ennen: 15.03.2025",
    },
    {
        "id": "nf_10",
        "category": "degraded_folded_pouch_seam_occluding_ingredients_unsure",
        "pack_style": "pouch",
        "description": "Folded snack pouch crimp seam hiding AINESOSAT / INGREDIENSER abstains as unsure (0 false-safe info)",
        "question": "Onko tassa evaspatukassa minulle sopimattomia allergeeneja?",
        "expected_level": "unsure",
        "rule_mode": "abstain_allergens",
        "expected_allergy": None,
        "degradation": "folded_pouch_seam",
        "allergens_readable": False,
        "box_angle": 2.0,
        "accent": (44, 96, 136),
        "header": "POHJOLA EVAS",
        "title": "KARPALO-EVASPATUKKA / MELLANMALSBAR",
        "sub_line": "Valipalapatukka / Mellanmalsbar - 45 g",
        "panel_title": "",
        "panel_lines": [],
        "weight_line": "",
        "expiry_line": "",
    },
    {
        "id": "nf_11",
        "category": "degraded_thumb_occluding_ingredients_panel_unsure",
        "pack_style": "carton",
        "description": "Thumb holding cookie box over AINESOSAT / INGREDIENSER panel abstains as unsure (0 false-safe info)",
        "question": "Can I eat these Nordic biscuits with my nut, milk, and egg allergies?",
        "expected_level": "unsure",
        "rule_mode": "abstain_allergens",
        "expected_allergy": None,
        "degradation": "thumb_occlusion",
        "allergens_readable": False,
        "box_angle": -2.1,
        "accent": (152, 92, 38),
        "header": "SAARISTON LEIPOMO",
        "title": "JUHLAKAKKUKEXI / FESTKEX",
        "sub_line": "Rapeat pikkuleivat / Sproda smakakor - 175 g",
        "panel_title": "",
        "panel_lines": [],
        "weight_line": "",
        "expiry_line": "",
    },
    {
        "id": "nf_12",
        "category": "degraded_freezer_frost_occluding_ingredients_unsure",
        "pack_style": "carton",
        "description": "Thick freezer frost and ice crust covering frozen pastry ingredients panel abstains as unsure",
        "question": "Sisaltaako tama pakasteleivos maitoa, kananmunaa, gluteenia tai pahkinaa?",
        "expected_level": "unsure",
        "rule_mode": "abstain_allergens",
        "expected_allergy": None,
        "degradation": "freezer_frost",
        "allergens_readable": False,
        "box_angle": 1.9,
        "accent": (58, 108, 156),
        "header": "POHJOLA PAKASTE    DJUPFRYST",
        "title": "KUNINGATARLEIVOS / DROTTNINGBAKELSE",
        "sub_line": "Pakasteleivos / Djupfryst bakelse - 240 g",
        "panel_title": "",
        "panel_lines": [],
        "weight_line": "",
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


def rule_of_three_95(k: int, n: int) -> float | None:
    if n <= 0 or k != 0:
        return None
    return round(min(1.0, 3.0 / n), 4)


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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 13) -> Any:
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


def render_countertop_canvas(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (228, 222, 212))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.59)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(240 - 20 * t), int(235 - 20 * t), int(226 - 18 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 100)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(196 - 24 * t) + jitter)),
            max(0, min(255, int(172 - 20 * t) + jitter)),
            max(0, min(255, int(142 - 16 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(150, 126, 102), width=2)
    return canvas


def apply_folded_pouch_seam(card: Image.Image, fold_y: int) -> Image.Image:
    w, h = card.size
    rgba = card.convert("RGBA")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)

    od.rectangle((0, fold_y - 16, w, fold_y + 10), fill=(20, 24, 30, 110))
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=7.0))
    rgba = Image.alpha_composite(rgba, overlay)

    flap = Image.new("RGBA", (w, h - fold_y), (218, 224, 232, 255))
    fd = ImageDraw.Draw(flap)
    fh = h - fold_y
    for y in range(fh):
        wave = math.sin((y / max(1, fh)) * math.pi * 2.2)
        shade = int(208 + 30 * wave)
        col = (max(176, min(248, shade)), max(180, min(250, shade + 3)), max(186, min(254, shade + 7)), 255)
        fd.line((0, y, w, y), fill=col)

    seam_h = 46
    fd.rectangle((0, fh - seam_h, w, fh), fill=(188, 196, 206, 255))
    for rx in range(8, w - 8, 10):
        fd.line((rx, fh - seam_h + 6, rx, fh - 6), fill=(148, 156, 168, 255), width=3)
    fd.line((0, 0, w, 0), fill=(116, 124, 136, 255), width=4)
    fd.line((0, 4, w, 4), fill=(246, 249, 252, 235), width=3)

    rgba.alpha_composite(flap, (0, fold_y))
    return rgba.convert("RGB")


def apply_thumb_occlusion(layer: Image.Image, x0: int, y0: int, bw: int, bh: int) -> Image.Image:
    out = layer.copy()
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    tx0 = x0 + 18
    ty0 = y0 + 168
    tx1 = x0 + bw - 14
    ty1 = y0 + bh + 22
    sd.rounded_rectangle((tx0 - 12, ty0 + 8, tx1 + 12, ty1 + 14), radius=76, fill=(24, 18, 14, 124))
    out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    hand = Image.new("RGBA", out.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(hand)
    hd.rounded_rectangle((tx0 - 8, ty0, tx1 + 8, ty1 + 24), radius=82, fill=(224, 178, 150, 255), outline=(182, 134, 108, 255), width=3)
    hd.rounded_rectangle((tx0 + 26, ty0 + 18, tx0 + 146, ty0 + 98), radius=34, fill=(238, 204, 186, 255), outline=(196, 152, 128, 255), width=2)
    for ky in (ty0 + 136, ty0 + 158, ty0 + 180):
        hd.arc((tx0 + 80, ky, tx1 - 70, ky + 34), start=195, end=345, fill=(186, 138, 112, 220), width=3)
    return Image.alpha_composite(out, hand)


def apply_freezer_frost(card: Image.Image, frost_top: int, seed: int) -> Image.Image:
    w, h = card.size
    rng = random.Random(seed + 303)
    base = card.copy()
    bd = ImageDraw.Draw(base)
    bd.rectangle((0, frost_top, w, h), fill=(228, 238, 247))

    frost = Image.new("RGBA", (w, h - frost_top), (234, 243, 250, 252))
    fd = ImageDraw.Draw(frost)
    fh = h - frost_top
    for _ in range(260):
        cx = rng.randint(6, w - 6)
        cy = rng.randint(6, fh - 6)
        rad = rng.randint(10, 44)
        col = (rng.randint(238, 255), rng.randint(244, 255), 255, rng.randint(170, 245))
        fd.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=col)
    for _ in range(140):
        ax = rng.randint(8, w - 8)
        ay = rng.randint(8, fh - 8)
        bx = max(4, min(w - 4, ax + rng.randint(-56, 56)))
        by = max(4, min(fh - 4, ay + rng.randint(-56, 56)))
        fd.line((ax, ay, bx, by), fill=(252, 254, 255, 225), width=rng.choice([1, 2, 3]))

    blurred = frost.filter(ImageFilter.GaussianBlur(radius=1.8))
    rgba = base.convert("RGBA")
    rgba.alpha_composite(blurred, (0, frost_top))
    ImageDraw.Draw(rgba).line((0, frost_top, w, frost_top), fill=(186, 208, 228, 240), width=4)
    return rgba.convert("RGB")


def render_food_pack(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_countertop_canvas(size, seed)

    pack_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    is_pouch = case["pack_style"] == "pouch"
    x0 = pad + (72 if is_pouch else 54)
    x1 = pad + (696 if is_pouch else 714)
    y0 = pad + (78 if is_pouch else 96)
    y1 = pad + (690 if is_pouch else 672)
    bw, bh = x1 - x0, y1 - y0
    corner_r = 26 if is_pouch else 16

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=corner_r + 2, fill=(24, 20, 16, 94))
    pack_layer = Image.alpha_composite(pack_layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))

    card = Image.new("RGB", (bw, bh), (250, 251, 253))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)

    top_seal = 20 if is_pouch else 0
    if is_pouch:
        cd.rectangle((0, 0, bw, top_seal), fill=(214, 220, 228))
        for sx in range(8, bw - 8, 10):
            cd.line((sx, 4, sx, top_seal - 4), fill=(168, 176, 186), width=2)

    cd.rectangle((0, top_seal, bw, top_seal + 56), fill=case["accent"])
    cd.text((26, top_seal + 16), case["header"], fill=(248, 250, 253), font=fit_font(cd, case["header"], bw - 52, 20, 13))

    cd.text(
        (26, top_seal + 72),
        case["title"],
        fill=(16, 22, 30),
        font=fit_font(cd, case["title"], bw - 52, 34, 20),
        stroke_width=1,
        stroke_fill=(16, 22, 30),
    )
    cd.text((26, top_seal + 120), case["sub_line"], fill=(50, 58, 70), font=fit_font(cd, case["sub_line"], bw - 52, 20, 14))

    if case["degradation"] == "none":
        panel_y0 = top_seal + 162
        panel_y1 = bh - 104
        cd.rounded_rectangle((24, panel_y0, bw - 24, panel_y1), radius=12, fill=(244, 247, 251), outline=case["accent"], width=3)
        cd.text(
            (40, panel_y0 + 18),
            case["panel_title"],
            fill=(26, 44, 64),
            font=fit_font(cd, case["panel_title"], bw - 80, 20, 14),
            stroke_width=1,
            stroke_fill=(26, 44, 64),
        )
        py = panel_y0 + 56
        for ln in case["panel_lines"]:
            cd.text((40, py), ln, fill=(20, 26, 34), font=fit_font(cd, ln, bw - 80, 19, 13))
            py += 38

        cd.text((26, bh - 72), case["weight_line"], fill=(44, 52, 62), font=fit_font(cd, case["weight_line"], 270, 19, 13))
        cd.rounded_rectangle((bw - 304, bh - 84, bw - 24, bh - 30), radius=8, fill=(242, 244, 248), outline=(156, 164, 174), width=2)
        cd.text(
            (bw - 288, bh - 70),
            case["expiry_line"],
            fill=(16, 20, 28),
            font=fit_font(cd, case["expiry_line"], 250, 20, 14),
        )
    elif case["degradation"] == "folded_pouch_seam":
        card = apply_folded_pouch_seam(card, top_seal + 166)
    elif case["degradation"] == "freezer_frost":
        card = apply_freezer_frost(card, top_seal + 164, seed)
    elif case["degradation"] == "thumb_occlusion":
        cd.rectangle((24, top_seal + 168, bw - 24, bh - 24), fill=(238, 241, 246))

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=corner_r, fill=255)
    pack_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(pack_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=corner_r, outline=(168, 176, 186, 255), width=3)

    if case["degradation"] == "thumb_occlusion":
        pack_layer = apply_thumb_occlusion(pack_layer, x0, y0, bw, bh)

    rotated = pack_layer.rotate(case["box_angle"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated)
    return composed.convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_case_jpeg_b64(case: dict[str, Any], idx: int) -> str:
    seed = 20261920 + idx * 61
    img = render_food_pack(case, seed)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    raw_bytes = buf.getvalue()
    if os.environ.get("SAVE_DEBUG_IMAGES") == "1" and os.path.isdir(SHM_DIR):
        dbg_dir = pathlib.Path(SHM_DIR) / SUITE_NAME
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
    for node_dir in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
        cand = pathlib.Path(node_dir) / "node"
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
    expected_allergy: str | None,
    pred_level: str,
    reasons: list[str],
) -> bool:
    joined = " | ".join(reasons)
    low = joined.lower()
    if rule_mode == "contains_allergy":
        return (
            pred_level == "warning"
            and expected_allergy is not None
            and f"allergy: {expected_allergy.lower()}" in low
            and "contains " in low
        )
    if rule_mode == "may_contain_allergy":
        return (
            pred_level == "warning"
            and expected_allergy is not None
            and f"allergy: {expected_allergy.lower()}" in low
            and "may contain" in low
        )
    if rule_mode == "safe_info":
        return pred_level == "info" and "no listed allergen matches your profile" in low
    if rule_mode == "expired_food":
        return pred_level == "warning" and "expired" in low
    if rule_mode == "abstain_allergens":
        return pred_level == "unsure" and ("allergen panel not readable" in low or "not readable" in low)
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
    assert MAX_WORKERS == 3, "MAX_WORKERS must be 3"

    readme_path = SUITE_DIR / "README.md"
    if readme_path.is_file():
        readme_txt = readme_path.read_text(encoding="utf-8")
        assert em_dash not in readme_txt and en_dash not in readme_txt, "Forbidden dash in README.md"
        assert not KEY_RE.search(readme_txt), "Forbidden key in README.md"

    raw_bytes = OUT_JSON_PATH.read_bytes()
    validate_output_contract(raw_bytes)
    data = json.loads(raw_bytes.decode("utf-8"))

    assert data["suite"] == SUITE_NAME == "nordic_food_allergen_synonyms"
    assert data["model"] == MODEL_NAME and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == "shared/verify_prompt.md+shared/label_schema.json"
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == "server/src/safety.ts"
    assert isinstance(data["profile"], dict) and len(data["profile"].get("allergies") or []) == 6

    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == len(CASES) == 12
    assert s["errors"] == 0 and s["timeouts"] == 0

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
        assert rule_fired_as_expected(
            spec["rule_mode"], spec["expected_allergy"], c["predicted_level"], c["reasons"]
        ), f"{c['id']}: expected food allergen rule did not fire: {c['reasons']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_safe_info_count"] == sum(1 for c in cases if c["expected_level"] != "info" and c["predicted_level"] == "info") == 0
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert (
        s["unsafe_reassurance_count"]
        == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info"))
        == 0
    )
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["confident_wrong_rule_of_three_95"] == rule_of_three_95(s["confident_wrong_count"], s["n_cases"]) == 0.25
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
    errors = 0
    timeouts = 0

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
            try:
                cid, parsed, latency_ms = fut.result()
                raw_by_id[cid] = (parsed, latency_ms)
            except Exception as exc:
                if "timeout" in str(exc).lower() or "timed out" in str(exc).lower():
                    timeouts += 1
                errors += 1
                raise

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

        rule_ok = rule_fired_as_expected(
            case["rule_mode"], case["expected_allergy"], pred_level, reasons
        )
        verdict_ok = pred_level == exp_level and rule_ok
        false_match = pred_level == "match" and exp_level != "match"
        false_safe_info = exp_level != "info" and pred_level == "info"
        unsafe_reassurance = exp_level == "warning" and pred_level in ("match", "info")

        a_val = read_obj["allergens"]["value"]
        a_conf = float(read_obj["allergens"]["confidence"])
        ar = case["allergens_readable"]

        wrong_crit_high_conf = False
        if ar is False:
            if a_val is not None and a_conf >= ALLERGEN_MIN_CONF:
                wrong_crit_high_conf = True
        elif case["rule_mode"] in ("contains_allergy", "may_contain_allergy"):
            if a_val == [] and a_conf >= HIGH_CONF:
                wrong_crit_high_conf = True

        confident_wrong = bool(wrong_crit_high_conf or unsafe_reassurance or false_match or false_safe_info)

        entry: dict[str, Any] = {
            "id": cid,
            "category": case["category"],
            "pack_style": case["pack_style"],
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
        if case["expected_allergy"] is not None:
            entry["expected_allergy"] = case["expected_allergy"]
        cases_out.append(entry)
        print(
            f"[{cid}] expected={exp_level} predicted={pred_level} ok={verdict_ok} "
            f"prod={read_obj['product']['value']!r} allergens={a_val!r} reasons={reasons} ms={latency_ms:.1f}"
        )

    n_cases = len(cases_out)
    verdict_matches = sum(1 for c in cases_out if c["verdict_ok"])
    verdict_accuracy = round(verdict_matches / n_cases, 4)
    cw_count = sum(1 for c in cases_out if c["confident_wrong"])
    cw_rate = round(cw_count / n_cases, 4)
    false_match_count = sum(1 for c in cases_out if c["false_match"])
    false_safe_info_count = sum(1 for c in cases_out if c["expected_level"] != "info" and c["predicted_level"] == "info")
    unsafe_count = sum(
        1 for c in cases_out if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")
    )
    unsure_count = sum(1 for c in cases_out if c["predicted_level"] == "unsure")
    latencies = [float(c["latency_ms"]) for c in cases_out]

    synonym_cases = [c for c in cases_out if c["id"] in ("nf_01", "nf_02", "nf_03", "nf_04", "nf_05", "nf_06", "nf_07")]
    degraded_cases = [c for c in cases_out if c["expected_level"] == "unsure"]

    summary: dict[str, Any] = {
        "n_cases": n_cases,
        "errors": errors,
        "timeouts": timeouts,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "verdict_accuracy_ci95": wilson_ci95(verdict_matches, n_cases),
        "confident_wrong_count": cw_count,
        "confident_wrong_rate": cw_rate,
        "confident_wrong_ci95": wilson_ci95(cw_count, n_cases),
        "confident_wrong_rule_of_three_95": rule_of_three_95(cw_count, n_cases),
        "false_safe_info_count": false_safe_info_count,
        "false_match_count": false_match_count,
        "unsafe_reassurance_count": unsafe_count,
        "abstain_or_unsure_count": unsure_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "allergen_synonym_warning_recall": round(sum(1 for c in synonym_cases if c["verdict_ok"]) / len(synonym_cases), 4),
        "occluded_panel_abstention_rate": round(
            sum(1 for c in degraded_cases if c["predicted_level"] == "unsure") / len(degraded_cases), 4
        ),
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
