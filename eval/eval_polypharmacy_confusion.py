import base64
import datetime
import io
import json
import math
import os
import pathlib
import random
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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "polypharmacy"
OUT_JSON_PATH = REPO_ROOT / "eval" / "polypharmacy_confusion_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60
EXPIRY_MIN_CONF = 0.70

POLYPHARMACY_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipine",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "bis",
            "name": "Bisoprolol",
            "ingredient": "bisoprolol",
            "strength": "2.5 mg",
            "schedule": ["morning"],
        },
        {
            "id": "par",
            "name": "Paracetamol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
        },
    ],
    "allergies": ["penicillin", "peanut"],
    "avoid": ["NSAIDs", "ACE inhibitors", "anticoagulants"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "pc_01",
        "trap_category": "valid_schedule_match",
        "description": "NORVASC 5 mg / amlodipine / 30 tablets / EXP 2027-10 (doseLog empty)",
        "expected_level": "match",
        "expected_taken_today": False,
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-10",
        "dose_offsets_ms": [],
        "brand_header": "VIATRIS    Vnr 04 19 22",
        "title": "NORVASC",
        "subtitle": "amlodipine",
        "form_line": "tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-10",
        "accent": (28, 72, 136),
    },
    {
        "id": "pc_02",
        "trap_category": "double_dose",
        "description": "AMLODIPIN ORION 5 mg evaluated 20 min after evening dose already logged",
        "expected_level": "warning",
        "expected_taken_today": True,
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-10",
        "dose_offsets_ms": [{"medId": "aml", "offset_ms": -1200000}],
        "brand_header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-10",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_03",
        "trap_category": "twice_daily_second_dose_allowed",
        "description": "METFORMIN 500 mg when only 1 of 2 daily doses (morning) is in doseLog",
        "expected_level": "match",
        "expected_taken_today": True,
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "expected_expiry": "2027-11",
        "dose_offsets_ms": [{"medId": "met", "offset_ms": -28800000}],
        "brand_header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_04",
        "trap_category": "double_dose",
        "description": "METFORMIN 500 mg when 2 of 2 daily doses are already logged today",
        "expected_level": "warning",
        "expected_taken_today": True,
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "metformin",
        "expected_expiry": "2027-11",
        "dose_offsets_ms": [
            {"medId": "met", "offset_ms": -39600000},
            {"medId": "met", "offset_ms": -1200000},
        ],
        "brand_header": "ORION PHARMA    Vnr 14 29 71",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_05",
        "trap_category": "lasa_strength",
        "description": "AMLODIPIN ORION 10 mg tabletti LASA 2x strength trap vs 5 mg profile",
        "expected_level": "warning",
        "expected_taken_today": None,
        "printed_strength": "10 mg",
        "expected_strength": "10 mg",
        "expected_ingredient": "amlodipine",
        "expected_expiry": "2027-10",
        "dose_offsets_ms": [],
        "brand_header": "ORION PHARMA    Vnr 08 44 38",
        "title": "AMLODIPIN ORION",
        "subtitle": "amlodipiini / amlodipine",
        "form_line": "tabletti",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-10",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_06",
        "trap_category": "lasa_strength",
        "description": "METFORMIN 850 mg film-coated tablets LASA strength trap vs 500 mg profile",
        "expected_level": "warning",
        "expected_taken_today": None,
        "printed_strength": "850 mg",
        "expected_strength": "850 mg",
        "expected_ingredient": "metformin",
        "expected_expiry": "2027-11",
        "dose_offsets_ms": [],
        "brand_header": "ORION PHARMA    Vnr 14 29 89",
        "title": "METFORMIN",
        "subtitle": "metformin hydrochloride",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_07",
        "trap_category": "comma_decimal_match",
        "description": "BISOPROLOL ORION 2,5 mg tabletti / EXP 2027-11 Nordic comma-decimal match",
        "expected_level": "match",
        "expected_taken_today": False,
        "printed_strength": "2,5 mg",
        "expected_strength": "2.5 mg",
        "expected_ingredient": "bisoprolol",
        "expected_expiry": "2027-11",
        "dose_offsets_ms": [],
        "brand_header": "ORION PHARMA    Vnr 49 21 60",
        "title": "BISOPROLOL ORION",
        "subtitle": "bisoprololi / bisoprolol",
        "form_line": "tabletti",
        "pack_line": "100 tablettia",
        "expiry_line": "EXP 2027-11",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_08",
        "trap_category": "lasa_strength",
        "description": "PANADOL ZAP / Paracetamol 500 mg + Codeine 30 mg combination strength trap",
        "expected_level": "warning",
        "expected_taken_today": None,
        "printed_strength": "500 mg + 30 mg",
        "expected_strength": "500 mg + 30 mg",
        "expected_ingredient": "paracetamol",
        "expected_expiry": "2027-12",
        "dose_offsets_ms": [],
        "brand_header": "HALEON    Vnr 51 08 44",
        "title": "PANADOL ZAP",
        "subtitle": "Paracetamol 500 mg + Codeine 30 mg",
        "form_line": "tablets",
        "pack_line": "20 tablets",
        "expiry_line": "EXP 2027-12",
        "accent": (26, 114, 92),
    },
    {
        "id": "pc_09",
        "trap_category": "drug_class",
        "description": "AMORION 500 mg / amoksisilliini / 20 tablettia penicillin allergy brand catch",
        "expected_level": "warning",
        "expected_taken_today": None,
        "printed_strength": "500 mg",
        "expected_strength": "500 mg",
        "expected_ingredient": "amoxicillin",
        "expected_expiry": "2027-12",
        "dose_offsets_ms": [],
        "brand_header": "ORION PHARMA    Vnr 06 31 15",
        "title": "AMORION",
        "subtitle": "amoksisilliini",
        "form_line": "tabletti",
        "pack_line": "20 tablettia",
        "expiry_line": "EXP 2027-12",
        "accent": (22, 108, 144),
    },
    {
        "id": "pc_10",
        "trap_category": "drug_class",
        "description": "ELIQUIS 5 mg / apixaban film-coated tablets anticoagulant avoid brand catch",
        "expected_level": "warning",
        "expected_taken_today": None,
        "printed_strength": "5 mg",
        "expected_strength": "5 mg",
        "expected_ingredient": "apixaban",
        "expected_expiry": "2028-01",
        "dose_offsets_ms": [],
        "brand_header": "BRISTOL MYERS SQUIBB    Vnr 19 82 04",
        "title": "ELIQUIS",
        "subtitle": "apixaban",
        "form_line": "film-coated tablets",
        "pack_line": "60 film-coated tablets",
        "expiry_line": "EXP 2028-01",
        "accent": (146, 38, 82),
    },
]


def load_env_files() -> None:
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


def sanitize_obj(obj: Any) -> Any:
    em_dash = chr(8212)
    en_dash = chr(8211)
    if isinstance(obj, str):
        return obj.replace(em_dash, " - ").replace(en_dash, "-")
    if isinstance(obj, list):
        return [sanitize_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in obj.items()}
    return obj


def inline_schema_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None and isinstance(node, dict):
        defs = node.get("$defs") or {}
    if isinstance(node, list):
        return [inline_schema_refs(item, defs) for item in node]
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and defs is not None:
            ref_name = ref.rsplit("/", 1)[-1]
            return inline_schema_refs(defs[ref_name], defs)
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            out[k] = inline_schema_refs(v, defs)
        return out
    return node


def percentile(vals: list[float], q: float) -> float:
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


def solve_perspective_coeffs(
    dst_pts: list[tuple[float, float]],
    src_pts: list[tuple[float, float]],
) -> list[float]:
    matrix: list[list[float]] = []
    rhs: list[float] = []
    for (dx, dy), (sx, sy) in zip(dst_pts, src_pts):
        matrix.append([dx, dy, 1.0, 0.0, 0.0, 0.0, -sx * dx, -sx * dy])
        rhs.append(sx)
        matrix.append([0.0, 0.0, 0.0, dx, dy, 1.0, -sy * dx, -sy * dy])
        rhs.append(sy)

    n = 8
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(matrix[r][col]))
        matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
        rhs[col], rhs[pivot] = rhs[pivot], rhs[col]
        div = matrix[col][col]
        for j in range(col, n):
            matrix[col][j] /= div
        rhs[col] /= div
        for r in range(n):
            if r == col:
                continue
            factor = matrix[r][col]
            if abs(factor) < 1e-12:
                continue
            for j in range(col, n):
                matrix[r][j] -= factor * matrix[col][j]
            rhs[r] -= factor * rhs[col]
    return rhs


def add_sensor_grain(img: Image.Image, seed: int, sigma: float = 2.4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    small_w, small_h = w // 2, h // 2
    noise_bytes = bytearray(small_w * small_h)
    for idx in range(len(noise_bytes)):
        val = int(128 + rng.gauss(0.0, sigma))
        noise_bytes[idx] = 0 if val < 0 else (255 if val > 255 else val)
    grain = Image.frombytes("L", (small_w, small_h), bytes(noise_bytes)).resize(
        (w, h), Image.Resampling.BILINEAR
    )
    rgb = img.convert("RGB")
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    return Image.blend(rgb, grain_rgb, alpha=0.04)


def draw_countertop_backdrop(size: int, pad: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (226, 220, 210))
    draw = ImageDraw.Draw(canvas)
    horizon_y = pad + 532
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        draw.line(
            (0, y, size, y),
            fill=(int(238 - 22 * t), int(232 - 22 * t), int(222 - 20 * t)),
        )
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        draw.line(
            (0, y, size, y),
            fill=(int(188 - 24 * t), int(156 - 22 * t), int(122 - 18 * t)),
        )
    draw.line((0, horizon_y, size, horizon_y), fill=(140, 112, 84), width=3)
    return canvas


def render_lasa_carton(case: dict[str, Any], index: int) -> Image.Image:
    seed = 4600 + index * 29
    rng = random.Random(seed)
    pad = 64
    size = 768 + 2 * pad
    canvas = draw_countertop_backdrop(size, pad)

    jitter_x = rng.randint(-10, 10)
    jitter_y = rng.randint(-8, 8)
    x0 = pad + 72 + jitter_x
    y0 = pad + 142 + jitter_y
    x1 = x0 + 624
    y1 = y0 + 432

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x0 + 14, y0 + 18, x1 + 18, y1 + 22), radius=18, fill=(28, 22, 16, 92))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    accent = case["accent"]
    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(172, 178, 186), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=accent)
    draw.rectangle((x0, y0 + 34, x1, y0 + 62), fill=accent)
    draw.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=accent)

    draw.text(
        (x0 + 28, y0 + 18),
        case["brand_header"],
        fill=(248, 250, 252),
        font=ImageFont.load_default(size=22),
    )
    draw.text(
        (x0 + 28, y0 + 82),
        case["title"],
        fill=(16, 22, 30),
        font=ImageFont.load_default(size=42),
    )
    draw.text(
        (x0 + 28, y0 + 140),
        case["subtitle"],
        fill=(48, 56, 66),
        font=ImageFont.load_default(size=24),
    )

    strength_txt = case["printed_strength"]
    s_font_size = 34 if len(strength_txt) >= 10 else 42
    s_font = ImageFont.load_default(size=s_font_size)
    s_bbox = draw.textbbox((0, 0), strength_txt, font=s_font)
    s_tw = s_bbox[2] - s_bbox[0]

    sx0 = x0 + 28
    sy0 = y0 + 190
    sx1 = sx0 + max(196, s_tw + 44)
    sy1 = y0 + 274
    draw.rounded_rectangle(
        (sx0, sy0, sx1, sy1),
        radius=10,
        fill=(240, 246, 251),
        outline=accent,
        width=2,
    )
    text_y_offset = 22 if s_font_size <= 36 else 18
    draw.text(
        (sx0 + 22, sy0 + text_y_offset),
        strength_txt,
        fill=(14, 20, 28),
        font=s_font,
    )

    draw.text(
        (sx1 + 20, sy0 + 28),
        case["form_line"],
        fill=(44, 52, 62),
        font=ImageFont.load_default(size=22),
    )

    draw.text(
        (x0 + 28, y0 + 334),
        case["pack_line"],
        fill=(52, 60, 70),
        font=ImageFont.load_default(size=22),
    )

    ex0 = x1 - 238
    ey0 = y0 + 318
    ex1 = x1 - 28
    ey1 = y0 + 384
    draw.rounded_rectangle(
        (ex0, ey0, ex1, ey1),
        radius=8,
        fill=(245, 247, 249),
        outline=(158, 166, 174),
        width=2,
    )
    draw.text(
        (ex0 + 18, ey0 + 19),
        case["expiry_line"],
        fill=(20, 26, 34),
        font=ImageFont.load_default(size=24),
    )

    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(ambient)
    ad.ellipse((-100, -120, 560, 470), fill=(255, 252, 244, 24))
    ambient = ambient.filter(ImageFilter.GaussianBlur(radius=34.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), ambient).convert("RGB")

    dx_tl = rng.uniform(3.5, 10.5)
    dy_tl = rng.uniform(3.5, 9.5)
    dx_tr = rng.uniform(3.5, 10.5)
    dy_tr = rng.uniform(4.5, 11.0)
    w, h = canvas.size
    src_pts = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    dst_pts = [
        (dx_tl, dy_tl),
        (float(w) - dx_tr, dy_tr),
        (float(w) - dx_tl, float(h) - dy_tl),
        (dx_tr, float(h) - dy_tr),
    ]
    coeffs = solve_perspective_coeffs(dst_pts, src_pts)
    warped = canvas.transform((w, h), Image.Transform.PERSPECTIVE, coeffs, resample=Image.Resampling.BICUBIC)
    cropped = warped.crop((pad, pad, pad + 768, pad + 768))
    return add_sensor_grain(cropped, seed=seed + 17)


def encode_jpeg_b64(img: Image.Image, save_path: pathlib.Path) -> str:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    save_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii")


def call_gemini_verify(
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
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
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
                    usage_meta = body.get("usageMetadata") or {}
                    tok = {
                        "in": int(usage_meta.get("promptTokenCount") or 0),
                        "out": int(
                            usage_meta.get("candidatesTokenCount")
                            or usage_meta.get("responseTokenCount")
                            or 0
                        ),
                        "thinking": int(usage_meta.get("thoughtsTokenCount") or 0),
                    }
                    return parsed, elapsed_ms, tok
                last_err = "Empty non-thought JSON output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini verify failed after retries: {last_err}")


def ensure_node_and_deps() -> str:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    extra_paths = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
        os.environ.get("PATH", ""),
    ]
    merged_path = ":".join(p for p in extra_paths if p)
    os.environ["PATH"] = merged_path
    node_bin = shutil.which("node", path=merged_path)
    if not node_bin:
        raise RuntimeError("node executable not found on PATH")
    return node_bin


def run_ts_polypharmacy_batch(
    node_bin: str,
    base_profile: dict[str, Any],
    raw_cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel, dosesToday, ingredientsOf, sameStrength } from "./server/src/safety.ts";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evalNow = new Date(2026, 10, 14, 20, 0, 0);
const nowMs = evalNow.getTime();

const results = input.cases.map((c) => {
  const doseLog = (c.dose_offsets_ms ?? []).map((entry) => ({
    medId: entry.medId,
    ts: nowMs + Number(entry.offset_ms),
  }));
  const profile = toProfile({ ...input.base_profile, doseLog });
  const read = toLabelRead(c.raw);
  const verdict = checkLabel(read, profile, evalNow);
  const strengthSame = sameStrength(read.strength.value, c.expected_strength);
  const gotIngredients = [...ingredientsOf(read.ingredient.value, read.product.value)];
  const matchedDosesToday = verdict.matchedMedId ? dosesToday(profile, verdict.matchedMedId, evalNow) : 0;
  return {
    id: c.id,
    read,
    verdict: {
      level: verdict.level,
      headline: verdict.headline,
      speech: verdict.speech,
      matchedMedId: verdict.matchedMedId ?? null,
      reasons: verdict.reasons,
      takenToday: verdict.takenToday ?? null,
    },
    strengthSame,
    gotIngredients,
    matchedDosesToday,
  };
});

process.stdout.write(JSON.stringify(results));
"""
    stdin_payload = json.dumps(
        {"base_profile": base_profile, "cases": raw_cases},
        ensure_ascii=False,
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=stdin_payload,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS polypharmacy check failed ({proc.returncode}): {proc.stderr[:500]}")
    return json.loads(proc.stdout)


def main() -> None:
    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    node_bin = ensure_node_and_deps()
    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

    raw_batch_inputs: list[dict[str, Any]] = []
    call_meta: dict[str, dict[str, Any]] = {}

    for idx, case in enumerate(CASES, start=1):
        cid = case["id"]
        img_path = OUT_IMG_DIR / f"{cid}.jpg"
        img = render_lasa_carton(case, idx)
        if img.size != (768, 768):
            raise RuntimeError(f"Expected 768x768 image for {cid}, got {img.size}")
        b64_jpeg = encode_jpeg_b64(img, img_path)

        raw_json, latency_ms, tok = call_gemini_verify(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=b64_jpeg,
        )
        raw_batch_inputs.append(
            {
                "id": cid,
                "raw": raw_json,
                "expected_strength": case["expected_strength"],
                "dose_offsets_ms": case["dose_offsets_ms"],
            }
        )
        call_meta[cid] = {
            "image_path": str(img_path.relative_to(REPO_ROOT)),
            "latency_ms": round(latency_ms, 1),
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
        }
        print(f"[{idx:02d}/10 {cid}] gemini latency={latency_ms:.1f}ms in={tok['in']} out={tok['out']}")

    ts_outputs = {
        row["id"]: row
        for row in run_ts_polypharmacy_batch(node_bin, POLYPHARMACY_PROFILE, raw_batch_inputs)
    }

    items: list[dict[str, Any]] = []
    double_dose_catches = 0
    lasa_strength_catches = 0
    drug_class_catches = 0

    for case in CASES:
        cid = case["id"]
        ts_row = ts_outputs[cid]
        meta = call_meta[cid]
        read_obj = sanitize_obj(ts_row["read"])
        verdict_obj = sanitize_obj(ts_row["verdict"])

        pred_level = verdict_obj["level"]
        exp_level = case["expected_level"]
        exp_taken_today = case["expected_taken_today"]
        actual_taken_today = verdict_obj["takenToday"]

        taken_flag_ok = (
            True
            if exp_taken_today is None
            else (actual_taken_today is exp_taken_today)
        )
        verdict_match = (pred_level == exp_level) and taken_flag_ok

        s_val = read_obj["strength"]["value"]
        s_conf = float(read_obj["strength"]["confidence"])
        strength_same = bool(ts_row["strengthSame"])
        strength_correct = bool(s_val) and s_conf >= STRENGTH_MIN_CONF and strength_same

        ing_ok = (
            case["expected_ingredient"] in ts_row["gotIngredients"]
            and (
                float(read_obj["ingredient"]["confidence"]) >= NAME_MIN_CONF
                or float(read_obj["product"]["confidence"]) >= NAME_MIN_CONF
            )
        )
        expiry_ok = (
            read_obj["expiry"]["value"] == case["expected_expiry"]
            and float(read_obj["expiry"]["confidence"]) >= EXPIRY_MIN_CONF
        )
        clean_fields_ok = bool(read_obj["kind"] == "medication" and ing_ok and strength_correct and expiry_ok)

        confident_wrong_dose = bool(
            (s_conf >= STRENGTH_MIN_CONF and not strength_same)
            or (exp_level != "match" and pred_level == "match")
            or not taken_flag_ok
        )

        reasons_list = verdict_obj.get("reasons") or []
        trap_cat = case["trap_category"]
        trap_caught = False
        if trap_cat == "double_dose":
            trap_caught = bool(
                pred_level == "warning"
                and actual_taken_today is True
                and any("taken today:" in r for r in reasons_list)
            )
            if trap_caught:
                double_dose_catches += 1
        elif trap_cat == "lasa_strength":
            trap_caught = bool(
                pred_level == "warning"
                and any("differs from your" in r for r in reasons_list)
            )
            if trap_caught:
                lasa_strength_catches += 1
        elif trap_cat == "drug_class":
            trap_caught = bool(
                pred_level == "warning"
                and any(("allergy:" in r or "avoid list" in r) for r in reasons_list)
            )
            if trap_caught:
                drug_class_catches += 1
        else:
            trap_caught = verdict_match

        item_record = {
            "id": cid,
            "trap_category": trap_cat,
            "description": sanitize_obj(case["description"]),
            "image_path": meta["image_path"],
            "strength_readable": True,
            "printed_strength": case["printed_strength"],
            "expected_strength": case["expected_strength"],
            "expected_ingredient": case["expected_ingredient"],
            "expected_expiry": case["expected_expiry"],
            "dose_log_entries": len(case["dose_offsets_ms"]),
            "expected_level": exp_level,
            "expected_taken_today": exp_taken_today,
            "predicted_level": pred_level,
            "predicted_taken_today": actual_taken_today,
            "verdict_match": verdict_match,
            "trap_caught": trap_caught,
            "strength_correct": strength_correct,
            "clean_fields_correct": clean_fields_ok,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": meta["latency_ms"],
            "tokens_in": meta["tokens_in"],
            "tokens_out": meta["tokens_out"],
            "tokens_thinking": meta["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items.append(item_record)
        print(
            f"  -> {cid} ({trap_cat}): exp={exp_level} pred={pred_level} "
            f"takenToday={actual_taken_today} strength={s_val!r} ({s_conf:.2f}) "
            f"match={verdict_match} cwd={confident_wrong_dose}"
        )

    n_items = len(items)
    verdict_matches = sum(1 for it in items if it["verdict_match"])
    clean_field_acc = round(sum(1 for it in items if it["clean_fields_correct"]) / n_items, 4)
    cwd_count = sum(1 for it in items if it["confident_wrong_dose"])
    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items)

    pc07 = next(it for it in items if it["id"] == "pc_07")
    comma_decimal_matched = bool(
        pc07["verdict_match"] and pc07["read"]["strength"]["value"] == "2.5 mg"
    )

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4),
        "double_dose_catches": double_dose_catches,
        "lasa_strength_catches": lasa_strength_catches,
        "drug_class_catches": drug_class_catches,
        "comma_decimal_matched": comma_decimal_matched,
        "clean_field_accuracy": clean_field_acc,
        "confident_wrong_dose_count": cwd_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": POLYPHARMACY_PROFILE,
            "summary": summary,
            "items": items,
        }
    )

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if chr(8212) in serialized or chr(8211) in serialized:
        raise RuntimeError("Forbidden dash character detected in serialized report")
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print("Wrote", OUT_JSON_PATH)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
