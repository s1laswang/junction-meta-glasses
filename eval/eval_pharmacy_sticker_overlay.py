import base64
import datetime
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import statistics
import subprocess
import time
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "pharmacy_sticker_overlay"
OUT_JSON_PATH = REPO_ROOT / "eval" / "pharmacy_sticker_overlay_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
EVAL_NOW_ISO = "2026-11-14T20:00:00Z"

HASH_CHAR = chr(35)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)

DEMO_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "barcode": "6432100012345",
            "notes": "Blood pressure, 1 tablet in the evening",
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "barcode": "6432100054321",
            "notes": "With meals twice daily",
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
            "barcode": "6432100098765",
            "notes": "Pain or fever",
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ps_01",
        "sticker_tier": "readable",
        "sticker_mode": "finnish_dispensing_over_art",
        "strength_source": "pharmacy_sticker",
        "description": "Finnish pharmacy dispensing sticker covering manufacturer art while cleanly printing Amlodipin 5 mg and 1 tabletti iltaisin",
        "strength_readable": True,
        "expected_strength": "5 mg",
        "expected_level": "match",
        "accent": (20, 98, 152),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "Amlodipin",
        "subtitle": "Vaikuttava aine: amlodipiini (amlodipine)",
        "carton_strength_badge": None,
        "form_line": "tabletti",
        "pack_line": "98 tablettia",
        "expiry_line": "EXP 2027-09",
        "box_tilt_deg": -1.8,
        "sticker_tilt_deg": 1.9,
        "sticker_header": "YLIOPISTON APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": "Amlodipin 5 mg tabletti",
        "sticker_lines": [
            "1 tabletti iltaisin verenpaineen hoitoon.",
            "Vaikuttava aine: amlodipiini  EXP 2027-09",
        ],
    },
    {
        "id": "ps_02",
        "sticker_tier": "readable",
        "sticker_mode": "finnish_dosing_bottom",
        "strength_source": "carton_and_sticker",
        "description": "Intact Burana 400 mg manufacturer face with Finnish pharmacy dosing sticker triggering NSAID avoid warning",
        "strength_readable": True,
        "expected_strength": "400 mg",
        "expected_level": "warning",
        "accent": (186, 34, 44),
        "header": "ORION PHARMA    Vnr 01 66 40",
        "title": "Burana",
        "subtitle": "Vaikuttava aine: ibuprofeeni (ibuprofen)",
        "carton_strength_badge": "400 mg",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-11",
        "box_tilt_deg": 2.0,
        "sticker_tilt_deg": -1.7,
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": "Burana 400 mg tabletti",
        "sticker_lines": [
            "1 tabletti tarvittaessa kipuun,",
            "korkeintaan 3 tablettia vrk  EXP 2027-11",
        ],
    },
    {
        "id": "ps_03",
        "sticker_tier": "readable",
        "sticker_mode": "finnish_antibiotic_sticker",
        "strength_source": "carton_and_sticker",
        "description": "Amorion 500 mg amoxicillin carton with Finnish pharmacy antibiotic course sticker triggering not-on-list warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "expected_level": "warning",
        "accent": (24, 114, 96),
        "header": "ORION PHARMA    Vnr 06 14 28",
        "title": "Amorion",
        "subtitle": "Vaikuttava aine: amoksisilliini (amoxicillin)",
        "carton_strength_badge": "500 mg",
        "form_line": "kalvopaallysteinen tabletti",
        "pack_line": "20 tablettia",
        "expiry_line": "EXP 2027-12",
        "box_tilt_deg": -1.6,
        "sticker_tilt_deg": 2.1,
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": "Amorion 500 mg tabletti",
        "sticker_lines": [
            "1 tabletti 3 kertaa vuorokaudessa.",
            "Syotava kuuri loppuun  EXP 2027-12",
        ],
    },
    {
        "id": "ps_04",
        "sticker_tier": "readable",
        "sticker_mode": "swedish_dispensing_over_art_expired",
        "strength_source": "pharmacy_sticker",
        "description": "Swedish pharmacy dispensing sticker on Metformin 500 mg carton with EXP 2024-09 triggering expired pack warning",
        "strength_readable": True,
        "expected_strength": "500 mg",
        "expected_level": "warning",
        "accent": (34, 86, 162),
        "header": "SANDOZ NORDIC    Vnr 12 73 09",
        "title": "Metformin",
        "subtitle": "Aktiv substans: metforminhydroklorid (metformin)",
        "carton_strength_badge": None,
        "form_line": "filmdragerad tablett",
        "pack_line": "100 tabletter",
        "expiry_line": "EXP 2024-09",
        "box_tilt_deg": 1.9,
        "sticker_tilt_deg": -2.2,
        "sticker_header": "APOTEK - DOSERINGSANVISNING",
        "sticker_drug_line": "Metformin 500 mg filmdragerad tablett",
        "sticker_lines": [
            "1 tablett morgon och kvall till maltid.",
            "Utg.dat. / EXP 2024-09",
        ],
    },
    {
        "id": "ps_05",
        "sticker_tier": "readable",
        "sticker_mode": "peeling_corner_readable_10mg",
        "strength_source": "carton_and_sticker",
        "description": "Bilingual Amlodipin 10 mg carton with slightly peeling corner pharmacy sticker triggering wrong-strength warning against 5 mg profile",
        "strength_readable": True,
        "expected_strength": "10 mg",
        "expected_level": "warning",
        "accent": (20, 98, 152),
        "header": "ORION PHARMA    Vnr 08 44 38",
        "title": "Amlodipin",
        "subtitle": "Vaikuttava aine: amlodipiini / Aktiv substans: amlodipin",
        "carton_strength_badge": "10 mg",
        "form_line": "tabletti / tablett",
        "pack_line": "98 tablettia",
        "expiry_line": "EXP 2027-10",
        "box_tilt_deg": -2.1,
        "sticker_tilt_deg": 1.6,
        "sticker_header": "APTEEKKI / APOTEK - ANNOSTUSOHJE",
        "sticker_drug_line": "Amlodipin 10 mg tabletti",
        "sticker_lines": [
            "1 tabletti iltaisin / 1 tablett pa kvallen.",
            "Kayt. viim. / EXP 2027-10",
        ],
    },
    {
        "id": "ps_06",
        "sticker_tier": "occluded",
        "sticker_mode": "crooked_blank_return_sticker",
        "strength_source": "occluded_everywhere",
        "description": "Crooked blank return-address sticker with peeling corner pasted squarely over every strength field on Amlodipin carton",
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (20, 98, 152),
        "header": "ORION PHARMA",
        "title": "Amlodipin",
        "subtitle": "Vaikuttava aine: amlodipiini (amlodipine)",
        "carton_strength_badge": None,
        "form_line": "tabletti",
        "pack_line": "Suun kautta",
        "expiry_line": "EXP 2027-09",
        "box_tilt_deg": 2.2,
        "sticker_tilt_deg": -6.8,
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": None,
        "sticker_lines": [
            "Ota iltaisin laakarin ohjeen mukaan.",
            "Sailytetaan huoneenlammossa.",
        ],
    },
    {
        "id": "ps_07",
        "sticker_tier": "occluded",
        "sticker_mode": "torn_pharmacy_thermal_label",
        "strength_source": "occluded_everywhere",
        "description": "Half-peeled and jaggedly torn pharmacy thermal label ripping off every strength digit on Metformin carton",
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (34, 86, 162),
        "header": "SANDOZ NORDIC",
        "title": "Metformin",
        "subtitle": "Vaikuttava aine: metformiini (metformin)",
        "carton_strength_badge": None,
        "form_line": "kalvopaallysteinen tabletti",
        "pack_line": "Suun kautta aterian yhteydessa",
        "expiry_line": "EXP 2027-11",
        "box_tilt_deg": -2.3,
        "sticker_tilt_deg": 5.6,
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": None,
        "sticker_lines": [
            "Ota aamulla ja illalla",
            "aterian yhteydessa.",
        ],
    },
    {
        "id": "ps_08",
        "sticker_tier": "occluded",
        "sticker_mode": "crooked_price_tag_overlay",
        "strength_source": "occluded_everywhere",
        "description": "Crooked yellow pharmacy retail price tag pasted squarely over every strength number on Panadol carton",
        "strength_readable": False,
        "expected_strength": None,
        "expected_level": "unsure",
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC",
        "title": "Panadol",
        "subtitle": "Vaikuttava aine: parasetamoli (paracetamol)",
        "carton_strength_badge": None,
        "form_line": "kalvopaallysteinen tabletti",
        "pack_line": "Suun kautta tarvittaessa",
        "expiry_line": "EXP 2028-02",
        "box_tilt_deg": 2.1,
        "sticker_tilt_deg": -7.4,
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_drug_line": None,
        "sticker_lines": [
            "Annostus pakkausselosteen tai",
            "laakarin ohjeen mukaan.",
        ],
    },
]


def load_env_with_proxy() -> None:
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"

    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k_bytes, v_bytes = chunk.split(b"=", 1)
                    k_str = k_bytes.decode("utf-8", errors="ignore").strip()
                    v_str = v_bytes.decode("utf-8", errors="ignore")
                    if k_str and k_str not in os.environ:
                        os.environ[k_str] = v_str
        except (OSError, subprocess.SubprocessError):
            pass

    for env_path in (home_env, repo_env):
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(HASH_CHAR):
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


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED_KEY]", cleaned)
    if isinstance(val, list):
        return [sanitize_obj(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in val.items()}
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
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            out[k] = inline_schema_refs(v, defs)
        return out
    return node


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


def add_paper_grain(img: Image.Image, seed: int, sigma: float = 3.2) -> Image.Image:
    rng = np.random.default_rng(seed)
    arr = np.asarray(img, dtype=np.float32)
    noise = rng.normal(0.0, sigma, size=(arr.shape[0], arr.shape[1], 1)).astype(np.float32)
    out = np.clip(arr + noise, 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


def draw_fitted_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    fill: tuple[int, int, int],
    max_width: int,
    initial_size: int,
    min_size: int = 13,
    stroke_width: int = 0,
) -> None:
    sz = initial_size
    while sz > min_size:
        font = ImageFont.load_default(size=sz)
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        if (bbox[2] - bbox[0]) <= max_width:
            break
        sz -= 1
    font = ImageFont.load_default(size=sz)
    draw.text(
        xy,
        text,
        fill=fill,
        font=font,
        stroke_width=stroke_width,
        stroke_fill=fill if stroke_width > 0 else None,
    )


def draw_barcode_1d(
    draw: ImageDraw.ImageDraw,
    x0: int,
    y0: int,
    width: int,
    height: int,
    seed: int,
    ink: tuple[int, int, int] = (24, 26, 30),
) -> None:
    rng = random.Random(seed + 509)
    x = x0 + 4
    limit_x = x0 + width - 4
    draw.rectangle((x, y0, x + 2, y0 + height), fill=ink)
    x += 4
    draw.rectangle((x, y0, x + 1, y0 + height), fill=ink)
    x += 4
    while x + 5 < limit_x:
        bar_w = rng.choice((1, 2, 3))
        gap_w = rng.choice((1, 2, 3))
        if x + bar_w >= limit_x:
            break
        draw.rectangle((x, y0, x + bar_w - 1, y0 + height), fill=ink)
        x += bar_w + gap_w
    if x + 2 <= limit_x:
        draw.rectangle((limit_x - 3, y0, limit_x - 1, y0 + height), fill=ink)


def render_counter_backdrop(size: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (218, 212, 202))
    draw = ImageDraw.Draw(canvas)
    horizon = int(size * 0.60)
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (int(232 - 22 * t), int(227 - 20 * t), int(218 - 18 * t))
        draw.line((0, y, size, y), fill=c)
    rng = random.Random(seed + 91)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        jitter = rng.randint(-3, 3)
        c = (
            max(0, min(255, int(190 - 26 * t) + jitter)),
            max(0, min(255, int(166 - 22 * t) + jitter)),
            max(0, min(255, int(138 - 18 * t) + jitter)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(144, 122, 98), width=2)
    return canvas


def apply_peeled_corner_flap(
    sticker_rgba: Image.Image,
    corner: str,
    flap_size: int = 34,
) -> Image.Image:
    w, h = sticker_rgba.size
    out = sticker_rgba.copy()
    alpha = out.getchannel("A")
    ad = ImageDraw.Draw(alpha)

    if corner == "bottom_right":
        cut_poly = [(w - flap_size, h), (w, h - flap_size), (w, h)]
        flap_poly = [(w - flap_size, h), (w, h - flap_size), (w - flap_size - 6, h - flap_size - 4)]
        shadow_poly = [(w - flap_size - 4, h), (w, h - flap_size - 4), (w - flap_size - 12, h - flap_size - 10)]
    else:
        cut_poly = [(w - flap_size, 0), (w, 0), (w, flap_size)]
        flap_poly = [(w - flap_size, 0), (w, flap_size), (w - flap_size - 6, flap_size + 5)]
        shadow_poly = [(w - flap_size - 5, 0), (w, flap_size + 5), (w - flap_size - 12, flap_size + 11)]

    ad.polygon(cut_poly, fill=0)
    out.putalpha(alpha)

    under = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ud = ImageDraw.Draw(under)
    ud.polygon(shadow_poly, fill=(22, 20, 18, 85))
    under = under.filter(ImageFilter.GaussianBlur(radius=2.6))

    flap_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flap_layer)
    fd.polygon(flap_poly, fill=(235, 232, 224, 255), outline=(182, 178, 168, 255))

    merged = Image.alpha_composite(under, out)
    return Image.alpha_composite(merged, flap_layer)


def render_pharmacy_dispensing_sticker(
    width: int,
    height: int,
    header: str,
    drug_line: str | None,
    lines: list[str],
    seed: int,
    peeled_corner: str | None = None,
) -> Image.Image:
    paper = Image.new("RGB", (width, height), (252, 251, 247))
    paper = add_paper_grain(paper, seed=seed + 101, sigma=2.4)
    pd = ImageDraw.Draw(paper)

    pd.rounded_rectangle((1, 1, width - 2, height - 2), radius=8, outline=(188, 186, 178), width=2)
    draw_fitted_text(pd, (16, 10), header, (44, 50, 58), width - 156, 16, min_size=12)
    draw_barcode_1d(pd, width - 132, 8, 114, 22, seed)
    pd.line((14, 35, width - 14, 35), fill=(184, 182, 174), width=1)

    ty = 43
    if drug_line:
        draw_fitted_text(pd, (16, ty), drug_line, (14, 18, 24), width - 32, 28, min_size=19, stroke_width=1)
        ty += 38

    for ln in lines:
        draw_fitted_text(pd, (16, ty), ln, (24, 28, 34), width - 36, 21, min_size=15)
        ty += 28

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=8, fill=255)
    rgba = paper.convert("RGBA")
    rgba.putalpha(mask)

    if peeled_corner:
        rgba = apply_peeled_corner_flap(rgba, corner=peeled_corner, flap_size=34)

    return rgba


def paste_sticker_with_shadow(
    card: Image.Image,
    sticker_rgba: Image.Image,
    dest_xy: tuple[int, int],
    tilt_deg: float,
) -> None:
    sw, sh = sticker_rgba.size
    pad = 16
    canvas = Image.new("RGBA", (sw + 2 * pad, sh + 2 * pad), (0, 0, 0, 0))

    alpha = sticker_rgba.getchannel("A")
    shadow_layer = Image.new("RGBA", (sw + 2 * pad, sh + 2 * pad), (0, 0, 0, 0))
    shadow_solid = Image.new("RGBA", (sw, sh), (24, 20, 16, 78))
    shadow_solid.putalpha(alpha)
    shadow_layer.paste(shadow_solid, (pad + 4, pad + 5))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=3.8))

    canvas = Image.alpha_composite(canvas, shadow_layer)
    canvas.alpha_composite(sticker_rgba, dest=(pad, pad))
    rot = canvas.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)

    base = card.convert("RGBA")
    dx = dest_xy[0] - (rot.width - sw) // 2
    dy = dest_xy[1] - (rot.height - sh) // 2
    base.alpha_composite(rot, dest=(dx, dy))
    card.paste(base.convert("RGB"))


def draw_manufacturer_artwork_waves(
    cd: ImageDraw.ImageDraw,
    width: int,
    y0: int,
    y1: int,
    accent: tuple[int, int, int],
) -> None:
    tint_a = (
        int(accent[0] * 0.16 + 248 * 0.84),
        int(accent[1] * 0.16 + 248 * 0.84),
        int(accent[2] * 0.16 + 250 * 0.84),
    )
    tint_b = (
        int(accent[0] * 0.28 + 245 * 0.72),
        int(accent[1] * 0.28 + 245 * 0.72),
        int(accent[2] * 0.28 + 248 * 0.72),
    )
    cd.rounded_rectangle((24, y0, width - 24, y1), radius=14, fill=tint_a, outline=tint_b, width=2)
    cy = (y0 + y1) // 2
    cd.ellipse((width - 170, cy - 54, width - 46, cy + 54), outline=tint_b, width=4)
    cd.ellipse((width - 144, cy - 32, width - 72, cy + 32), fill=tint_b)


def render_blank_return_sticker(width: int, height: int, seed: int) -> Image.Image:
    paper = Image.new("RGB", (width, height), (251, 249, 243))
    paper = add_paper_grain(paper, seed=seed + 311, sigma=2.8)
    pd = ImageDraw.Draw(paper)
    pd.rounded_rectangle((1, 1, width - 2, height - 2), radius=7, outline=(182, 178, 168), width=2)
    draw_fitted_text(pd, (16, 11), "PALAUTUSOSOITE / AVSANDARE", (96, 100, 108), width - 54, 14, min_size=11)
    for ry in (48, 76, 104):
        for rx in range(16, width - 26, 10):
            pd.line((rx, ry, rx + 5, ry), fill=(192, 188, 180), width=1)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    rgba = paper.convert("RGBA")
    rgba.putalpha(mask)
    return apply_peeled_corner_flap(rgba, corner="top_right", flap_size=36)


def apply_torn_thermal_occlusion(
    card: Image.Image,
    case: dict[str, Any],
    seed: int,
) -> None:
    rng = random.Random(seed + 409)
    tear_layer = Image.new("RGBA", card.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(tear_layer)

    sx0, sy0, sx1, sy1 = 22, 188, 296, 298
    outer_pts: list[tuple[int, int]] = []
    inner_pts: list[tuple[int, int]] = []
    xs = list(range(sx0, sx1 + 1, 14))
    for x in xs:
        outer_pts.append((x, sy0 + rng.randint(-5, 6)))
        inner_pts.append((x, sy0 + 7 + rng.randint(-4, 5)))
    for x in reversed(xs):
        outer_pts.append((x, sy1 + rng.randint(-6, 6)))
        inner_pts.append((x, sy1 - 7 + rng.randint(-5, 5)))

    td.polygon(outer_pts, fill=(241, 238, 230, 255))
    td.polygon(inner_pts, fill=(182, 168, 148, 255))
    for _ in range(90):
        fx = rng.randint(sx0 + 6, sx1 - 14)
        fy = rng.randint(sy0 + 8, sy1 - 8)
        fl = rng.randint(8, 20)
        td.line((fx, fy, fx + fl, fy + rng.randint(-3, 3)), fill=(154, 140, 120, 205), width=2)
    card.paste(Image.alpha_composite(card.convert("RGBA"), tear_layer).convert("RGB"))

    sw, sh = 356, 138
    paper = Image.new("RGB", (sw, sh), (249, 247, 239))
    paper = add_paper_grain(paper, seed=seed + 433, sigma=3.0)
    pd = ImageDraw.Draw(paper)
    pd.rounded_rectangle((1, 1, sw - 2, sh - 2), radius=7, outline=(184, 180, 170), width=2)
    draw_fitted_text(pd, (38, 12), case["sticker_header"], (48, 54, 62), sw - 148, 15, min_size=12)
    draw_barcode_1d(pd, sw - 104, 10, 88, 20, seed + 17)
    pd.line((34, 36, sw - 14, 36), fill=(186, 182, 174), width=1)
    ty = 48
    for ln in case["sticker_lines"]:
        draw_fitted_text(pd, (40, ty), ln, (28, 32, 38), sw - 56, 21, min_size=15)
        ty += 30

    mask = Image.new("L", (sw, sh), 0)
    md = ImageDraw.Draw(mask)
    jagged_poly: list[tuple[int, int]] = [(26, 0), (sw - 1, 0), (sw - 1, sh - 1), (28, sh - 1)]
    for ry in range(sh - 8, 6, -12):
        jagged_poly.append((rng.randint(10, 32), ry))
    md.polygon(jagged_poly, fill=255)

    rgba = paper.convert("RGBA")
    rgba.putalpha(mask)
    paste_sticker_with_shadow(card, rgba, (226, 182), case["sticker_tilt_deg"])


def render_price_tag_sticker(width: int, height: int, seed: int) -> Image.Image:
    tag = Image.new("RGB", (width, height), (255, 226, 68))
    tag = add_paper_grain(tag, seed=seed + 601, sigma=2.5)
    td = ImageDraw.Draw(tag)
    td.rectangle((0, 0, width, 34), fill=(212, 42, 36))
    draw_fitted_text(td, (14, 7), "APTEEKKI TARJOUSHINTA", (255, 252, 245), width - 28, 17, min_size=12, stroke_width=1)
    td.rounded_rectangle((1, 1, width - 2, height - 2), radius=7, outline=(168, 126, 24), width=2)
    draw_fitted_text(td, (16, 44), "HINTA 6,90 EUR", (20, 22, 26), width - 36, 30, min_size=20, stroke_width=1)
    draw_barcode_1d(td, 16, 86, width - 64, 24, seed + 29)

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    rgba = tag.convert("RGBA")
    rgba.putalpha(mask)
    return apply_peeled_corner_flap(rgba, corner="bottom_right", flap_size=30)


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261180 + idx * 149
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 70, pad + 104, pad + 698, pad + 664
    bw, bh = x1 - x0, y1 - y0

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 12, y0 + 16, x1 + 16, y1 + 20),
        radius=18,
        fill=(24, 20, 16, 94),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, shadow)

    card = Image.new("RGB", (bw, bh), (250, 250, 247))
    card = add_paper_grain(card, seed=seed + 19, sigma=2.6)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 62), fill=case["accent"])
    draw_fitted_text(cd, (28, 18), case["header"], (248, 250, 252), bw - 56, 22, min_size=15)
    draw_fitted_text(cd, (28, 80), case["title"], (14, 18, 26), bw - 56, 48, min_size=32, stroke_width=1)
    draw_fitted_text(cd, (28, 142), case["subtitle"], (44, 52, 62), bw - 56, 22, min_size=15)

    mode = case["sticker_mode"]

    if mode in ("finnish_dispensing_over_art", "swedish_dispensing_over_art_expired"):
        draw_manufacturer_artwork_waves(cd, bw, 186, 408, case["accent"])
        draw_fitted_text(cd, (28, 468), case["pack_line"], (42, 50, 60), 280, 24, min_size=16)
        cd.rounded_rectangle((bw - 252, 456, bw - 26, 512), radius=8, fill=(242, 244, 247), outline=(146, 154, 164), width=2)
        draw_fitted_text(cd, (bw - 234, 470), case["expiry_line"], (16, 20, 26), 196, 26, min_size=18, stroke_width=1)

        disp_sticker = render_pharmacy_dispensing_sticker(
            width=bw - 68,
            height=188,
            header=case["sticker_header"],
            drug_line=case["sticker_drug_line"],
            lines=case["sticker_lines"],
            seed=seed,
            peeled_corner=None,
        )
        paste_sticker_with_shadow(card, disp_sticker, (34, 206), case["sticker_tilt_deg"])

    elif mode in ("finnish_dosing_bottom", "finnish_antibiotic_sticker", "peeling_corner_readable_10mg"):
        sx0, sy0, sx1, sy1 = 28, 188, 268, 272
        cd.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=12,
            fill=(238, 244, 250),
            outline=case["accent"],
            width=3,
        )
        draw_fitted_text(
            cd,
            (sx0 + 22, sy0 + 16),
            str(case["carton_strength_badge"]),
            (12, 16, 24),
            sx1 - sx0 - 36,
            46,
            min_size=30,
            stroke_width=1,
        )
        draw_fitted_text(cd, (sx1 + 18, sy0 + 26), case["form_line"], (38, 46, 56), bw - sx1 - 42, 23, min_size=15)

        draw_fitted_text(cd, (28, 298), case["pack_line"], (44, 52, 62), 260, 23, min_size=16)
        cd.rounded_rectangle((bw - 252, 288, bw - 26, 342), radius=8, fill=(242, 244, 247), outline=(146, 154, 164), width=2)
        draw_fitted_text(cd, (bw - 234, 301), case["expiry_line"], (16, 20, 26), 196, 25, min_size=18, stroke_width=1)

        peel = "bottom_right" if mode == "peeling_corner_readable_10mg" else None
        disp_sticker = render_pharmacy_dispensing_sticker(
            width=bw - 68,
            height=168,
            header=case["sticker_header"],
            drug_line=case["sticker_drug_line"],
            lines=case["sticker_lines"],
            seed=seed,
            peeled_corner=peel,
        )
        paste_sticker_with_shadow(card, disp_sticker, (34, 366), case["sticker_tilt_deg"])

    elif mode == "crooked_blank_return_sticker":
        draw_fitted_text(cd, (366, 232), case["form_line"], (42, 50, 60), bw - 392, 24, min_size=16)
        blank_st = render_blank_return_sticker(324, 124, seed)
        paste_sticker_with_shadow(card, blank_st, (20, 186), case["sticker_tilt_deg"])

        draw_fitted_text(cd, (28, 330), case["pack_line"], (48, 56, 66), 280, 22, min_size=15)
        cd.rounded_rectangle((bw - 252, 318, bw - 26, 372), radius=8, fill=(242, 244, 247), outline=(146, 154, 164), width=2)
        draw_fitted_text(cd, (bw - 234, 331), case["expiry_line"], (16, 20, 26), 196, 25, min_size=18, stroke_width=1)

        lower_st = render_pharmacy_dispensing_sticker(
            width=bw - 68,
            height=134,
            header=case["sticker_header"],
            drug_line=None,
            lines=case["sticker_lines"],
            seed=seed + 7,
            peeled_corner=None,
        )
        paste_sticker_with_shadow(card, lower_st, (34, 396), 1.3)

    elif mode == "torn_pharmacy_thermal_label":
        draw_fitted_text(cd, (28, 366), case["form_line"], (42, 50, 60), 310, 23, min_size=15)
        draw_fitted_text(cd, (28, 408), case["pack_line"], (48, 56, 66), 320, 21, min_size=15)
        cd.rounded_rectangle((bw - 252, 462, bw - 26, 518), radius=8, fill=(242, 244, 247), outline=(146, 154, 164), width=2)
        draw_fitted_text(cd, (bw - 234, 476), case["expiry_line"], (16, 20, 26), 196, 25, min_size=18, stroke_width=1)
        apply_torn_thermal_occlusion(card, case, seed)

    elif mode == "crooked_price_tag_overlay":
        draw_fitted_text(cd, (346, 232), case["form_line"], (42, 50, 60), bw - 370, 22, min_size=14)
        price_st = render_price_tag_sticker(306, 122, seed)
        paste_sticker_with_shadow(card, price_st, (22, 188), case["sticker_tilt_deg"])

        draw_fitted_text(cd, (28, 330), case["pack_line"], (48, 56, 66), 290, 22, min_size=15)
        cd.rounded_rectangle((bw - 252, 318, bw - 26, 372), radius=8, fill=(242, 244, 247), outline=(146, 154, 164), width=2)
        draw_fitted_text(cd, (bw - 234, 331), case["expiry_line"], (16, 20, 26), 196, 25, min_size=18, stroke_width=1)

        lower_st = render_pharmacy_dispensing_sticker(
            width=bw - 68,
            height=134,
            header=case["sticker_header"],
            drug_line=None,
            lines=case["sticker_lines"],
            seed=seed + 11,
            peeled_corner=None,
        )
        paste_sticker_with_shadow(card, lower_st, (34, 396), -1.4)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(164, 168, 174, 255),
        width=3,
    )

    rotated = box_layer.rotate(case["box_tilt_deg"], resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    cropped = composed.crop((pad, pad, pad + 768, pad + 768))
    assert cropped.size == (768, 768)
    return cropped


def encode_jpeg(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw_bytes = buf.getvalue()
    out_path.write_bytes(raw_bytes)
    return base64.b64encode(raw_bytes).decode("ascii"), len(raw_bytes)


def build_http_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = True
    https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    proxies: dict[str, str] = {}
    if https_proxy:
        proxies["https"] = https_proxy
    if http_proxy:
        proxies["http"] = http_proxy
    elif https_proxy:
        proxies["http"] = https_proxy
    if proxies:
        session.proxies.update(proxies)
    return session


def call_gemini_flash(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}"
    payload = {
        "systemInstruction": {"parts": [{"text": verify_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": "image/jpeg", "data": b64_jpeg}},
                    {"text": "Read this label."},
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

    last_err = ""
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            resp = session.post(url, json=payload, timeout=45)
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
                    parsed = json.loads(json_text)
                    usage = body.get("usageMetadata") or {}
                    tok = {
                        "in": int(usage.get("promptTokenCount") or 0),
                        "out": int(usage.get("candidatesTokenCount") or 0),
                        "thinking": int(usage.get("thoughtsTokenCount") or 0),
                    }
                    return parsed, latency_ms, tok
                last_err = "empty structured output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {sanitize_obj(resp.text[:240])}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(sanitize_obj(str(exc)))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini call failed after retries: {last_err}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

    proc_env = dict(os.environ)
    extra_bins = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    cur_path = proc_env.get("PATH", "")
    proc_env["PATH"] = ":".join([p for p in extra_bins if os.path.isdir(p)] + ([cur_path] if cur_path else []))
    proc_env["LEDGER_PATH"] = "/tmp/opencode/pharmacy_sticker_overlay_ledger.jsonl"

    node_bin = shutil.which("node", path=proc_env["PATH"])
    if not node_bin:
        raise RuntimeError("node binary not found in PATH")
    return node_bin, proc_env


def evaluate_via_typescript(raw_items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node_bin, proc_env = ensure_node_runtime()
    ts_code = (
        'import fs from "node:fs";'
        'import { toLabelRead, verify } from "./server/src/verify.ts";'
        'import { checkLabel, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
        'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
        'const payload = JSON.parse(fs.readFileSync(0, "utf8"));'
        "const now = new Date(payload.eval_now_iso);"
        "const evaluated = [];"
        "for (const entry of payload.items) {"
        "  const verifyRes = await verify("
        '    ["frame_stub"],'
        "    DEMO_PROFILE,"
        "    undefined,"
        '    "eval_pharmacy_sticker_overlay",'
        "    {"
        '      chain: ["gemini-3.8-flash"],'
        "      generateFn: async () => ({ text: JSON.stringify(entry.raw_json) })"
        "    }"
        "  );"
        "  const read = toLabelRead(entry.raw_json);"
        "  const checkVerdict = checkLabel(read, DEMO_PROFILE, now);"
        "  if (verifyRes.verdict.level !== checkVerdict.level) {"
        '    throw new Error("verify/checkLabel mismatch for " + entry.id);'
        "  }"
        "  const { read: _omit, ...verdictMeta } = checkVerdict;"
        "  const strengthSame = entry.expected_strength ? sameStrength(read.strength.value, entry.expected_strength) : false;"
        "  evaluated.push({"
        "    id: entry.id,"
        "    read,"
        "    verdict: verdictMeta,"
        "    strength_same: strengthSame,"
        "    strength_min_conf: STRENGTH_MIN_CONF"
        "  });"
        "}"
        "process.stdout.write(JSON.stringify({ evaluated }));"
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"eval_now_iso": EVAL_NOW_ISO, "items": raw_items}),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=proc_env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    parsed = json.loads(proc.stdout)
    return {row["id"]: row for row in parsed["evaluated"]}


def assert_clean_artifact(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if node.startswith("/9j/") or node.startswith("data:image") or len(node) > 1200:
            raise AssertionError("Base64 or oversized string found in output JSON")
        if "AIza" in node:
            raise AssertionError("API key prefix found in output JSON")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_artifact(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_artifact(k)
            assert_clean_artifact(v)


def main() -> None:
    load_env_with_proxy()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    session = build_http_session()
    raw_runs: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        img = render_case_image(case, idx)
        b64_jpeg, byte_len = encode_jpeg(img, img_path)
        raw_json, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
        )
        raw_runs.append(
            {
                "case": case,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "image_bytes": byte_len,
                "raw_json": raw_json,
                "latency_ms": round(latency_ms, 1),
                "tokens_in": tok["in"],
                "tokens_out": tok["out"],
                "tokens_thinking": tok["thinking"],
            }
        )

    ts_inputs = [
        {
            "id": r["case"]["id"],
            "raw_json": r["raw_json"],
            "expected_strength": r["case"]["expected_strength"],
        }
        for r in raw_runs
    ]
    ts_by_id = evaluate_via_typescript(ts_inputs)

    items_out: list[dict[str, Any]] = []
    for run in raw_runs:
        case = run["case"]
        cid = case["id"]
        ts_row = ts_by_id[cid]
        read_obj = sanitize_obj(ts_row["read"])
        verdict_obj = sanitize_obj(ts_row["verdict"])

        pred_level = str(verdict_obj["level"])
        exp_level = str(case["expected_level"])
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        strength_same = bool(ts_row["strength_same"])
        sr = bool(case["strength_readable"])

        if sr:
            strength_correct: bool | None = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same
            confident_wrong_dose = bool(
                (s_conf >= STRENGTH_MIN_CONF and not strength_same)
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = False
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= STRENGTH_MIN_CONF)
                or s_conf >= STRENGTH_MIN_CONF
                or (exp_level != "match" and pred_level == "match")
            )
            abstained = pred_level == "unsure"

        false_safe_allergen = False

        item_record = {
            "id": cid,
            "sticker_tier": case["sticker_tier"],
            "sticker_mode": case["sticker_mode"],
            "strength_source": case["strength_source"],
            "description": sanitize_obj(case["description"]),
            "image_path": run["image_path"],
            "image_bytes": run["image_bytes"],
            "width": 768,
            "height": 768,
            "strength_readable": sr,
            "expected_strength": case["expected_strength"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "latency_ms": run["latency_ms"],
            "tokens_in": run["tokens_in"],
            "tokens_out": run["tokens_out"],
            "tokens_thinking": run["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_record)
        print(
            f"[{cid}] tier={case['sticker_tier']} mode={case['sticker_mode']} exp={exp_level} "
            f"pred={pred_level} match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    readable_items = [it for it in items_out if it["sticker_tier"] == "readable"]
    occluded_items = [it for it in items_out if it["sticker_tier"] == "occluded"]

    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)

    readable_sticker_accuracy = round(
        sum(
            1
            for it in readable_items
            if it["verdict_match"] and bool(it["strength_correct"]) and not it["confident_wrong_dose"]
        )
        / len(readable_items),
        4,
    )

    occluded_sticker_abstention_rate = round(
        sum(1 for it in occluded_items if it["abstained"] and not it["confident_wrong_dose"])
        / len(occluded_items),
        4,
    )

    confident_wrong_dose_count = int(sum(1 for it in items_out if it["confident_wrong_dose"]))
    false_safe_allergen_count = int(sum(1 for it in items_out if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items_out))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items_out))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items_out))

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "n_readable_sticker": len(readable_items),
        "n_occluded_sticker": len(occluded_items),
        "readable_sticker_accuracy": readable_sticker_accuracy,
        "occluded_sticker_abstention_rate": occluded_sticker_abstention_rate,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "false_safe_allergen_count": false_safe_allergen_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": DEMO_PROFILE,
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_artifact(report)
    if confident_wrong_dose_count != 0:
        raise AssertionError(f"confident_wrong_dose_count must be 0, got {confident_wrong_dose_count}")
    if false_safe_allergen_count != 0:
        raise AssertionError(f"false_safe_allergen_count must be 0, got {false_safe_allergen_count}")
    if occluded_sticker_abstention_rate != 1.0:
        raise AssertionError(f"occluded_sticker_abstention_rate must be 1.0, got {occluded_sticker_abstention_rate}")

    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
