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

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "nordic_stickers"
OUT_JSON_PATH = REPO_ROOT / "eval" / "nordic_stickers_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80

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
            "id": "med_paracetamol",
            "name": "Paracetamol",
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
        "kind": "medication",
        "description": "AMLODIPIN ORION 5 mg / 98 tablettia + Finnish evening dosing sticker",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "5 mg",
        "ground_truth_strength": "5 mg",
        "box_angle": -2.1,
        "sticker_angle": 1.6,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "strength_badge": "5 mg",
        "form_line": "tabletti",
        "sub_line": "Vaikuttava aine: amlodipiini",
        "pack_line": "98 tablettia",
        "expiry_line": "EXP 08/2027",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti iltaisin verenpaineen hoitoon.",
            "Kayt. viim. 08/2027",
        ],
    },
    {
        "id": "ns_02",
        "kind": "medication",
        "description": "METFORMIN ACTAVIS 500 mg bilingual FI/SV box + twice-daily sticker",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "500 mg",
        "ground_truth_strength": "500 mg",
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
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti aamulla ja illalla",
            "aterian yhteydessa.",
        ],
    },
    {
        "id": "ns_03",
        "kind": "medication",
        "description": "BISOPROLOL ORION 2,5 mg comma-decimal strength box against 2.5 mg profile",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "2,5 mg",
        "ground_truth_strength": "2.5 mg",
        "box_angle": -1.5,
        "sticker_angle": 2.0,
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
        "kind": "medication",
        "description": "BURANA 400 mg tabletti / ibuprofeeni triggering NSAID avoid warning",
        "expected_level": "warning",
        "strength_readable": True,
        "printed_strength": "400 mg",
        "ground_truth_strength": "400 mg",
        "box_angle": 2.4,
        "sticker_angle": -1.8,
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
        "id": "ns_05",
        "kind": "medication",
        "description": "PANADOL ZAPP 500 mg matching paracetamol 500 mg profile",
        "expected_level": "match",
        "strength_readable": True,
        "printed_strength": "500 mg",
        "ground_truth_strength": "500 mg",
        "box_angle": -2.3,
        "sticker_angle": 1.2,
        "accent": (18, 96, 158),
        "header": "HALEON NORDIC    Vnr 05 82 19",
        "title": "PANADOL ZAPP",
        "strength_badge": "500 mg",
        "form_line": "kalvopaallysteinen tabletti",
        "sub_line": "Vaikuttava aine: parasetamoli / paracetamol",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 06/2028",
        "sticker_mode": "bottom",
        "sticker_header": "APTEEKKI - ANNOSTUSOHJE",
        "sticker_lines": [
            "1 tabletti tarvittaessa sarkyyn tai kuumeeseen.",
            "Kayt. viim. 06/2028",
        ],
    },
    {
        "id": "ns_06",
        "kind": "medication",
        "description": "AMLODIPIN ORION 10 mg tabletti against 5 mg profile (wrong strength)",
        "expected_level": "warning",
        "strength_readable": True,
        "printed_strength": "10 mg",
        "ground_truth_strength": "10 mg",
        "box_angle": 1.6,
        "sticker_angle": -2.1,
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
        "id": "ns_07",
        "kind": "medication",
        "description": "METFORMIN 500 mg / EXP 2025-02 triggering expired pack warning",
        "expected_level": "warning",
        "strength_readable": True,
        "printed_strength": "500 mg",
        "ground_truth_strength": "500 mg",
        "box_angle": -1.9,
        "sticker_angle": 1.5,
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
            "EXP 2025-02",
        ],
    },
    {
        "id": "ns_08",
        "kind": "medication",
        "description": "AMLODIPIN ORION with white pharmacy sticker completely covering strength region",
        "expected_level": "unsure",
        "strength_readable": False,
        "printed_strength": None,
        "ground_truth_strength": None,
        "box_angle": 2.2,
        "sticker_angle": -2.4,
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
        "id": "ns_09",
        "kind": "medication",
        "description": "Faded low-contrast thermal pharmacy sticker where strength is omitted/illegible",
        "expected_level": "unsure",
        "strength_readable": False,
        "printed_strength": None,
        "ground_truth_strength": None,
        "box_angle": -2.6,
        "sticker_angle": 1.9,
        "accent": (118, 128, 138),
        "header": "APTEEKKIPAKKAUS",
        "title": "METFORMIN",
        "strength_badge": None,
        "form_line": "tabletti",
        "sub_line": "metformiini",
        "pack_line": "",
        "expiry_line": "",
        "sticker_mode": "faded_thermal",
        "sticker_header": "APTEEKKI",
        "sticker_lines": [
            "Annostus laakarin ohjeen mukaan",
            "aterian yhteydessa",
        ],
    },
    {
        "id": "ns_10",
        "kind": "food",
        "description": "Swedish oat cream HAVREGRADDE with mandel och hasselnot trace declaration",
        "expected_level": "warning",
        "strength_readable": None,
        "printed_strength": None,
        "ground_truth_strength": None,
        "box_angle": 1.7,
        "sticker_angle": 0.0,
        "accent": (46, 112, 74),
        "header": "NORDISK VAXTBASERAD",
        "title": "HAVREGRADDE",
        "sub_title": "Matlagningsgradde av havre",
        "ingredients_lines": [
            "Ingredienser: vatten, havre, rapsolja,",
            "emulgeringsmedel (rapslecitin), salt.",
        ],
        "allergen_lines": [
            "Kan innehalla spar av mandel",
            "och hasselnot.",
        ],
        "expiry_line": "Bast fore: 2027-05-14",
        "sticker_mode": "none",
    },
]


def load_env_fallback() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    comment_prefix = chr(35)
    for env_path in (pathlib.Path.home() / "momin" / ".env", REPO_ROOT / ".env"):
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(comment_prefix):
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


def sanitize_text(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace("\u2014", " - ").replace("\u2013", "-")
    if isinstance(val, list):
        return [sanitize_text(x) for x in val]
    if isinstance(val, dict):
        return {k: sanitize_text(v) for k, v in val.items()}
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


def parse_strength_mg(text: str | None) -> tuple[float, str] | None:
    if not text:
        return None
    normed = re.sub(r"(\d),(\d)", r"\1.\2", text.lower()).strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg|ug|mikrog)\b", normed)
    if not m:
        return None
    amt = float(m.group(1))
    unit = m.group(2)
    factors = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "ug": 0.001, "mikrog": 0.001}
    return (round(amt * factors[unit], 6), "mg")


def same_strength_simple(a: str | None, b: str | None) -> bool:
    pa = parse_strength_mg(a)
    pb = parse_strength_mg(b)
    if pa is None or pb is None:
        return False
    return pa[1] == pb[1] and abs(pa[0] - pb[0]) < 1e-6


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 5) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    noise = Image.new("L", (w // 2, h // 2))
    px = [128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range((w // 2) * (h // 2))]
    noise.putdata(px)
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    blend_alpha = 0.06
    r = Image.blend(r, noise, blend_alpha)
    g = Image.blend(g, noise, blend_alpha)
    b = Image.blend(b, noise, blend_alpha)
    return Image.merge("RGB", (r, g, b))


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

    f_hdr = ImageFont.load_default(size=17)
    f_body = ImageFont.load_default(size=22)

    pd.text((18, 12), header, fill=header_col, font=f_hdr)
    pd.line((16, 36, width - 16, 36), fill=rule_col, width=1)

    y = 46
    for ln in lines:
        pd.text((18, y), ln, fill=text_col, font=f_body)
        y += 30

    if faded:
        rng = random.Random(seed + 303)
        for _ in range(18):
            sy = rng.randint(8, height - 8)
            pd.line((6, sy, width - 6, sy), fill=paper_rgb, width=rng.randint(2, 5))
        paper = paper.filter(ImageFilter.GaussianBlur(radius=3.0))

    mask = Image.new("L", (width, height), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, width - 1, height - 1), radius=7, fill=255)
    layer.paste(paper, (pad, pad), mask)
    return layer


def render_food_carton(case: dict[str, Any], seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_tabletop_canvas(size, seed)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 146, pad + 78, pad + 622, pad + 694

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shd = ImageDraw.Draw(sh)
    shd.rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 16, 95))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    carton = Image.new("RGB", (x1 - x0, y1 - y0), (246, 241, 229))
    carton = add_paper_grain(carton, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(carton)
    cw, ch = carton.size

    cd.rectangle((0, 0, cw, 74), fill=case["accent"])
    cd.text((26, 24), case["header"], fill=(244, 248, 244), font=ImageFont.load_default(size=22))
    cd.text(
        (26, 96),
        case["title"],
        fill=(22, 42, 28),
        font=ImageFont.load_default(size=46),
        stroke_width=1,
        stroke_fill=(22, 42, 28),
    )
    cd.text((26, 156), case["sub_title"], fill=(56, 72, 60), font=ImageFont.load_default(size=25))

    cd.rounded_rectangle((24, 206, cw - 24, 444), radius=12, fill=(252, 250, 244), outline=(182, 176, 162), width=2)
    f_ing = ImageFont.load_default(size=22)
    iy = 224
    for ln in case["ingredients_lines"]:
        cd.text((40, iy), ln, fill=(28, 32, 30), font=f_ing)
        iy += 32

    iy += 14
    cd.rounded_rectangle((36, iy - 6, cw - 36, iy + 74), radius=8, fill=(255, 243, 232), outline=(196, 118, 62), width=2)
    f_alg = ImageFont.load_default(size=23)
    for ln in case["allergen_lines"]:
        cd.text((48, iy + 4), ln, fill=(112, 36, 18), font=f_alg, stroke_width=1, stroke_fill=(112, 36, 18))
        iy += 31

    cd.rounded_rectangle((24, 470, cw - 24, 534), radius=8, fill=(255, 255, 255), outline=(196, 192, 182), width=2)
    cd.text((40, 488), case["expiry_line"], fill=(24, 28, 30), font=ImageFont.load_default(size=25))
    cd.text((28, ch - 52), "2,5 dl", fill=(58, 72, 62), font=ImageFont.load_default(size=26))

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
    x0, y0, x1, y1 = pad + 72, pad + 118, pad + 696, pad + 642
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
    cd.text((28, 18), case["header"], fill=(246, 249, 252), font=ImageFont.load_default(size=22))

    title_col = (54, 58, 64) if faded_mode else (16, 22, 30)
    cd.text(
        (28, 82),
        case["title"],
        fill=title_col,
        font=ImageFont.load_default(size=42),
        stroke_width=0 if faded_mode else 1,
        stroke_fill=title_col,
    )
    cd.text((28, 138), case["sub_line"], fill=(62, 70, 80), font=ImageFont.load_default(size=22))

    if case["strength_badge"]:
        sx0, sy0, sx1, sy1 = 28, 178, 252, 256
        cd.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=case["accent"], width=3)
        cd.text(
            (sx0 + 20, sy0 + 14),
            case["strength_badge"],
            fill=(14, 20, 28),
            font=ImageFont.load_default(size=44),
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )
        cd.text((sx1 + 18, sy0 + 24), case["form_line"], fill=(38, 46, 56), font=ImageFont.load_default(size=24))
    else:
        cd.text((28, 182), case["form_line"], fill=(56, 64, 74), font=ImageFont.load_default(size=24))

    if case["pack_line"]:
        cd.text((28, 272), case["pack_line"], fill=(52, 60, 70), font=ImageFont.load_default(size=22))

    if case["expiry_line"]:
        is_exp_alert = "2025-02" in case["expiry_line"]
        ex_fill = (246, 242, 236) if is_exp_alert else (242, 244, 247)
        cd.rounded_rectangle((bw - 238, 264, bw - 26, 314), radius=6, fill=ex_fill, outline=(168, 174, 182), width=2)
        cd.text(
            (bw - 222, 275),
            case["expiry_line"],
            fill=(20, 24, 30),
            font=ImageFont.load_default(size=24),
            stroke_width=1 if is_exp_alert else 0,
            stroke_fill=(20, 24, 30),
        )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(172, 178, 186, 255), width=3)

    if case["sticker_mode"] == "bottom":
        st = render_thermal_sticker(
            width=486,
            height=136,
            header=case["sticker_header"],
            lines=case["sticker_lines"],
            seed=seed,
            faded=False,
        )
        st_rot = st.rotate(case["sticker_angle"], resample=Image.Resampling.BICUBIC, expand=True)
        box_layer.alpha_composite(st_rot, dest=(x0 + 26, y0 + 324))
    elif case["sticker_mode"] == "cover_strength":
        st = render_thermal_sticker(
            width=524,
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
            width=516,
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
    ImageDraw.Draw(glare).ellipse((-90, -110, 520, 420), fill=(255, 253, 246, 22))
    glare = glare.filter(ImageFilter.GaussianBlur(radius=32.0))
    composed = Image.alpha_composite(composed, glare).convert("RGB")

    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 20261114 + idx * 37
    if case["kind"] == "food":
        return render_food_carton(case, seed)
    return render_med_box(case, seed)


def encode_jpeg(img: Image.Image, out_path: pathlib.Path) -> str:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    raw_bytes = buf.getvalue()
    out_path.write_bytes(raw_bytes)
    return base64.b64encode(raw_bytes).decode("ascii")


def call_gemini_flash(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, int, int]:
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
                    tok_in = int(usage.get("promptTokenCount") or 0)
                    tok_out = int(usage.get("candidatesTokenCount") or 0)
                    return parsed, latency_ms, tok_in, tok_out
                last_err = "empty structured output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini call failed after retries: {last_err}")


def evaluate_via_typescript(
    raw_items: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], bool]:
    node_bin = shutil.which("node")
    if not node_bin and pathlib.Path("/tmp/fleet-silas/node/bin/node").is_file():
        node_bin = "/tmp/fleet-silas/node/bin/node"
    if not node_bin:
        raise RuntimeError("node binary not found in PATH")

    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel } from "./server/src/safety.ts";

const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const profile = toProfile(payload.profile);
const evaluated = payload.items.map((entry) => {
  const read = toLabelRead(entry.raw_json);
  const verdict = checkLabel(read, profile);
  const { read: _omit, ...verdictMeta } = verdict;
  return { id: entry.id, read, verdict: verdictMeta };
});

const commaProbeRead = toLabelRead({
  kind: "medication",
  product: { value: "BISOPROLOL ORION", confidence: 0.98 },
  ingredient: { value: "bisoprolol", confidence: 0.98 },
  strength: { value: "2,5 mg", confidence: 0.96 },
  dosing: { value: "1 tabletti aamuisin", confidence: 0.92 },
  expiry: { value: "2027-09", confidence: 0.95 },
  allergens: { value: null, confidence: 0.1 },
  barcode: { value: null, confidence: 0.1 },
  readability: 0.96,
});
const commaProbeVerdict = checkLabel(commaProbeRead, profile);
const commaNormOk = commaProbeRead.strength.value === "2.5 mg" && commaProbeVerdict.level === "match";

process.stdout.write(JSON.stringify({ evaluated, commaNormOk }));
"""
    env = dict(os.environ)
    node_dir = str(pathlib.Path(node_bin).parent)
    env["PATH"] = f"{node_dir}:{env.get('PATH', '')}"

    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=json.dumps({"profile": profile, "items": raw_items}),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript evaluation failed ({proc.returncode}): {proc.stderr[:500]}")
    out = json.loads(proc.stdout)
    by_id = {row["id"]: row for row in out["evaluated"]}
    return by_id, bool(out["commaNormOk"])


def main() -> None:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    raw_runs: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        img = render_case_image(case, idx)
        b64_jpeg = encode_jpeg(img, img_path)
        raw_json, latency_ms, tok_in, tok_out = call_gemini_flash(
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
                "raw_json": raw_json,
                "latency_ms": round(latency_ms, 1),
                "tokens_in": tok_in,
                "tokens_out": tok_out,
            }
        )

    ts_payload = [{"id": r["case"]["id"], "raw_json": r["raw_json"]} for r in raw_runs]
    ts_results, ts_comma_probe_ok = evaluate_via_typescript(ts_payload, PROFILE)

    items_out: list[dict[str, Any]] = []
    for run in raw_runs:
        case = run["case"]
        cid = case["id"]
        ts_row = ts_results[cid]
        read_obj = sanitize_text(ts_row["read"])
        verdict_obj = sanitize_text(ts_row["verdict"])

        raw_strength = run["raw_json"].get("strength") if isinstance(run["raw_json"], dict) else {}
        raw_strength_val = raw_strength.get("value") if isinstance(raw_strength, dict) else None

        pred_level = verdict_obj["level"]
        exp_level = case["expected_level"]
        verdict_match = pred_level == exp_level

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        gt_strength = case["ground_truth_strength"]
        sr = case["strength_readable"]

        strength_correct: bool | None = None
        abstained: bool | None = None
        confident_wrong_dose = False

        if case["kind"] == "medication":
            if sr is True:
                strength_correct = bool(s_val) and same_strength_simple(s_val, gt_strength)
                if (bool(s_val) and s_conf >= STRENGTH_MIN_CONF and not strength_correct) or (
                    exp_level != "match" and pred_level == "match"
                ):
                    confident_wrong_dose = True
            else:
                abstained = pred_level == "unsure"
                if (bool(s_val) and s_conf >= STRENGTH_MIN_CONF) or pred_level == "match":
                    confident_wrong_dose = True

        item_entry = {
            "id": cid,
            "description": sanitize_text(case["description"]),
            "kind": case["kind"],
            "image_path": run["image_path"],
            "strength_readable": sr,
            "printed_strength": case["printed_strength"],
            "ground_truth_strength": gt_strength,
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "strength_correct": strength_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": run["latency_ms"],
            "tokens_in": run["tokens_in"],
            "tokens_out": run["tokens_out"],
            "raw_strength_value": sanitize_text(raw_strength_val),
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_entry)
        print(
            f"[{cid}] expected={exp_level} predicted={pred_level} "
            f"match={verdict_match} strength={s_val!r} conf={s_conf:.2f} "
            f"cwd={confident_wrong_dose} ms={run['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    verdict_accuracy = round(verdict_matches / n_items, 4)
    cwd_count = sum(1 for it in items_out if it["confident_wrong_dose"])

    ns03 = next(it for it in items_out if it["id"] == "ns_03")
    comma_decimal_matched = bool(
        ts_comma_probe_ok
        and ns03["verdict_match"]
        and ns03["read"]["strength"]["value"] == "2.5 mg"
    )

    readable_meds = [it for it in items_out if it["strength_readable"] is True]
    occluded_meds = [it for it in items_out if it["strength_readable"] is False]
    clean_field_accuracy = round(
        sum(1 for it in readable_meds if it["strength_correct"]) / len(readable_meds),
        4,
    )
    occluded_abstention_rate = round(
        sum(1 for it in occluded_meds if it["abstained"]) / len(occluded_meds),
        4,
    )

    ns10 = next(it for it in items_out if it["id"] == "ns_10")
    allergen_recall = 1.0 if ns10["predicted_level"] == "warning" else 0.0
    false_safe_allergen_count = 0 if ns10["predicted_level"] == "warning" else 1

    latencies = [it["latency_ms"] for it in items_out]
    tok_ins = [it["tokens_in"] for it in items_out if it["tokens_in"] > 0]
    tok_outs = [it["tokens_out"] for it in items_out if it["tokens_out"] > 0]

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": verdict_accuracy,
        "comma_decimal_matched": comma_decimal_matched,
        "confident_wrong_dose_count": cwd_count,
        "clean_field_accuracy": clean_field_accuracy,
        "occluded_abstention_rate": occluded_abstention_rate,
        "allergen_recall": allergen_recall,
        "false_safe_allergen_count": false_safe_allergen_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": round(statistics.mean(tok_ins), 1) if tok_ins else None,
        "tokens_out": round(statistics.mean(tok_outs), 1) if tok_outs else None,
    }

    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "model": MODEL_NAME,
        "profile": PROFILE,
        "summary": summary,
        "items": items_out,
    }

    OUT_JSON_PATH.write_text(
        json.dumps(sanitize_text(report), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
