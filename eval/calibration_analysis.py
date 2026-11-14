import base64
import datetime
import io
import json
import math
import os
import pathlib
import re
import statistics
import time
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
SWEEP_OUT_DIR = REPO_ROOT / "eval" / "out" / "calibration_sweep"
OUT_JSON_PATH = REPO_ROOT / "eval" / "calibration_curve.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
NAME_MIN_CONF = 0.60
THRESHOLDS = [0.50, 0.60, 0.70, 0.80, 0.90, 0.95]

MEDICATIONS = [
    {
        "slug": "amlodipine_5mg",
        "label": "Amlodipine 5 mg",
        "med_id": "aml",
        "brand_header": "ORION PHARMA",
        "title": "AMLODIPINE",
        "subtitle": "Active substance: amlodipine",
        "expected_ingredient": "amlodipine",
        "expected_strength": "5 mg",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-08",
        "accent": (22, 114, 138),
    },
    {
        "slug": "metformin_500mg",
        "label": "Metformin 500 mg",
        "med_id": "met",
        "brand_header": "SANDOZ",
        "title": "METFORMIN",
        "subtitle": "Active substance: metformin",
        "expected_ingredient": "metformin",
        "expected_strength": "500 mg",
        "form_line": "film-coated tablets",
        "pack_line": "100 tablets",
        "expiry_line": "EXP 2027-10",
        "accent": (34, 88, 168),
    },
    {
        "slug": "ibuprofen_400mg",
        "label": "Ibuprofen 400 mg",
        "med_id": "ibu",
        "brand_header": "RATIOPHARM",
        "title": "IBUPROFEN",
        "subtitle": "Active substance: ibuprofen",
        "expected_ingredient": "ibuprofen",
        "expected_strength": "400 mg",
        "form_line": "film-coated tablets",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-11",
        "accent": (188, 38, 48),
    },
    {
        "slug": "paracetamol_500mg",
        "label": "Paracetamol 500 mg",
        "med_id": "par",
        "brand_header": "TEVA",
        "title": "PARACETAMOL",
        "subtitle": "Active substance: paracetamol",
        "expected_ingredient": "paracetamol",
        "expected_strength": "500 mg",
        "form_line": "tablets",
        "pack_line": "20 tablets",
        "expiry_line": "EXP 2028-02",
        "accent": (36, 132, 86),
    },
]

TIERS = [
    {
        "index": 0,
        "key": "tier_0_clean",
        "degradation": "clean",
        "strength_readable": True,
        "description": "Sharp 768x768 print under natural indoor lighting",
    },
    {
        "index": 1,
        "key": "tier_1_mild",
        "degradation": "mild_blur",
        "strength_readable": True,
        "description": "GaussianBlur(2.0) plus slight perspective tilt, still human-legible",
    },
    {
        "index": 2,
        "key": "tier_2_heavy",
        "degradation": "heavy_blur_glare",
        "strength_readable": False,
        "description": "Strength line occluded before GaussianBlur(9.0) plus bright specular wash",
    },
    {
        "index": 3,
        "key": "tier_3_occluded",
        "degradation": "severe_occlusion",
        "strength_readable": False,
        "description": "Thumb and cast shadow completely covering strength digits",
    },
]

UNIT_FACTORS = {
    "mg": ("mg", 1.0),
    "g": ("mg", 1000.0),
    "mcg": ("mg", 0.001),
    "ug": ("mg", 0.001),
    "mikrog": ("mg", 0.001),
    "microgram": ("mg", 0.001),
    "ml": ("ml", 1.0),
    "iu": ("iu", 1.0),
    "ky": ("iu", 1.0),
    "%": ("%", 1.0),
}


def load_env_fallback() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    candidates = [
        pathlib.Path.home() / "momin" / ".env",
        REPO_ROOT / ".env",
    ]
    comment_char = chr(35)
    for env_path in candidates:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(comment_char):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def sanitize_dashes(text: str) -> str:
    return text.replace("\u2014", " - ").replace("\u2013", "-")


def inline_schema_refs(node, defs=None):
    if defs is None:
        defs = node.get("$defs", {}) if isinstance(node, dict) else {}
    if isinstance(node, list):
        return [inline_schema_refs(item, defs) for item in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str):
            ref_name = node["$ref"].split("/")[-1]
            return inline_schema_refs(defs[ref_name], defs)
        out = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            out[k] = inline_schema_refs(v, defs)
        return out
    return node


def solve_perspective_coeffs(dst_pts: list[tuple[float, float]], src_pts: list[tuple[float, float]]) -> list[float]:
    matrix = []
    rhs = []
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


def render_base_scene(med: dict, include_strength: bool) -> Image.Image:
    pad = 64
    size = 768 + 2 * pad
    canvas = Image.new("RGB", (size, size), (224, 218, 208))
    draw = ImageDraw.Draw(canvas)

    table_y = pad + 520
    for y in range(table_y):
        t = y / max(1, table_y)
        r = int(234 - 22 * t)
        g = int(228 - 22 * t)
        b = int(218 - 20 * t)
        draw.line((0, y, size, y), fill=(r, g, b))

    for y in range(table_y, size):
        t = (y - table_y) / max(1, size - table_y)
        r = int(182 - 24 * t)
        g = int(152 - 22 * t)
        b = int(120 - 18 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, table_y, size, table_y), fill=(138, 108, 80), width=3)

    x0 = pad + 112
    y0 = pad + 148
    x1 = pad + 656
    y1 = pad + 566

    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    sd.rounded_rectangle((x0 + 12, y0 + 18, x1 + 18, y1 + 20), radius=18, fill=(32, 26, 20, 90))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=12.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow_layer).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(250, 251, 252), outline=(176, 182, 188), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 64), radius=16, fill=med["accent"])
    draw.rectangle((x0, y0 + 36, x1, y0 + 64), fill=med["accent"])

    draw.text(
        (x0 + 30, y0 + 18),
        med["brand_header"],
        fill=(248, 250, 252),
        font=ImageFont.load_default(size=24),
    )
    draw.text(
        (x0 + 30, y0 + 88),
        med["title"],
        fill=(18, 24, 32),
        font=ImageFont.load_default(size=46),
    )
    draw.text(
        (x0 + 30, y0 + 148),
        med["subtitle"],
        fill=(54, 62, 72),
        font=ImageFont.load_default(size=23),
    )

    sx0 = x0 + 28
    sy0 = y0 + 194
    sx1 = x0 + 276
    sy1 = y0 + 280
    if include_strength:
        draw.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=10,
            fill=(241, 246, 250),
            outline=med["accent"],
            width=2,
        )
        draw.text(
            (sx0 + 22, sy0 + 16),
            med["expected_strength"],
            fill=(14, 20, 28),
            font=ImageFont.load_default(size=46),
        )
    else:
        draw.rounded_rectangle(
            (sx0, sy0, sx1, sy1),
            radius=10,
            fill=(238, 240, 242),
            outline=(212, 216, 220),
            width=1,
        )

    draw.text(
        (sx1 + 20, sy0 + 28),
        med["form_line"],
        fill=(48, 56, 66),
        font=ImageFont.load_default(size=24),
    )
    draw.text(
        (x0 + 30, y0 + 308),
        med["pack_line"],
        fill=(58, 66, 76),
        font=ImageFont.load_default(size=23),
    )
    draw.text(
        (x0 + 30, y0 + 350),
        med["expiry_line"],
        fill=(46, 54, 64),
        font=ImageFont.load_default(size=22),
    )

    bx0 = x1 - 178
    by0 = y0 + 304
    draw.rectangle((bx0, by0, x1 - 28, y0 + 388), fill=(255, 255, 255), outline=(210, 214, 218), width=1)
    for i in range(28):
        bx = bx0 + 12 + i * 4
        bw = 3 if i % 5 == 0 else (2 if i % 2 == 0 else 1)
        draw.rectangle((bx, by0 + 10, bx + bw, by0 + 72), fill=(26, 28, 30))

    ambient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(ambient)
    ad.ellipse((-120, -140, 560, 480), fill=(255, 252, 244, 26))
    ambient = ambient.filter(ImageFilter.GaussianBlur(radius=36.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), ambient).convert("RGB")
    return canvas


def render_tier_image(med: dict, tier_key: str) -> Image.Image:
    pad = 64
    crop_box = (pad, pad, pad + 768, pad + 768)

    if tier_key == "tier_0_clean":
        scene = render_base_scene(med, include_strength=True)
        return scene.crop(crop_box)

    if tier_key == "tier_1_mild":
        scene = render_base_scene(med, include_strength=True)
        w, h = scene.size
        src_pts = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
        dst_pts = [
            (26.0, 18.0),
            (float(w) - 18.0, 38.0),
            (float(w) - 30.0, float(h) - 16.0),
            (12.0, float(h) - 32.0),
        ]
        coeffs = solve_perspective_coeffs(dst_pts, src_pts)
        tilted = scene.transform(
            (w, h),
            Image.Transform.PERSPECTIVE,
            coeffs,
            resample=Image.Resampling.BICUBIC,
        )
        cropped = tilted.crop(crop_box)
        return cropped.filter(ImageFilter.GaussianBlur(radius=2.0))

    if tier_key == "tier_2_heavy":
        scene = render_base_scene(med, include_strength=False)
        cropped = scene.crop(crop_box)
        blurred = cropped.filter(ImageFilter.GaussianBlur(radius=9.0)).convert("RGBA")

        glare = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glare)
        gd.polygon([(150, 0), (470, 0), (590, 560), (95, 560)], fill=(255, 255, 246, 130))
        gd.ellipse((86, 262, 548, 496), fill=(255, 255, 255, 252))
        gd.ellipse((124, 302, 476, 462), fill=(255, 255, 255, 255))
        glare = glare.filter(ImageFilter.GaussianBlur(radius=22.0))
        return Image.alpha_composite(blurred, glare).convert("RGB")

    if tier_key == "tier_3_occluded":
        scene = render_base_scene(med, include_strength=False)
        cropped = scene.crop(crop_box).convert("RGBA")

        cast_shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        csd = ImageDraw.Draw(cast_shadow)
        csd.rounded_rectangle((-30, 316, 434, 468), radius=62, fill=(24, 18, 14, 165))
        csd.ellipse((290, 322, 452, 474), fill=(24, 18, 14, 145))
        cast_shadow = cast_shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
        with_shadow = Image.alpha_composite(cropped, cast_shadow)

        thumb = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((-50, 326, 412, 446), radius=58, fill=(208, 162, 136, 255), outline=(168, 122, 98, 255), width=3)
        td.rounded_rectangle((-40, 334, 396, 386), radius=32, fill=(218, 174, 148, 255))
        td.rounded_rectangle((326, 344, 398, 426), radius=24, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
        td.arc((218, 342, 246, 430), start=110, end=250, fill=(166, 118, 94, 210), width=3)
        td.arc((232, 346, 258, 426), start=115, end=245, fill=(174, 126, 102, 185), width=2)
        thumb = thumb.filter(ImageFilter.GaussianBlur(radius=0.8))
        return Image.alpha_composite(with_shadow, thumb).convert("RGB")

    raise ValueError(f"Unknown tier_key: {tier_key}")


def encode_jpeg_b64(img: Image.Image, save_path: pathlib.Path) -> str:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    save_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii")


def clamp01(val) -> float:
    if isinstance(val, (int, float)) and math.isfinite(val):
        return max(0.0, min(1.0, float(val)))
    return 0.0


def coerce_str_field(obj) -> dict:
    raw_val = obj.get("value") if isinstance(obj, dict) else None
    val = raw_val.strip() if isinstance(raw_val, str) and raw_val.strip() else None
    conf = clamp01(obj.get("confidence") if isinstance(obj, dict) else 0.0)
    return {
        "value": val,
        "confidence": min(conf, 0.3) if val is None else conf,
    }


def coerce_arr_field(obj) -> dict:
    raw_val = obj.get("value") if isinstance(obj, dict) else None
    is_valid = isinstance(raw_val, list) and all(isinstance(x, str) for x in raw_val)
    val = [sanitize_dashes(x) for x in raw_val] if is_valid else None
    conf = clamp01(obj.get("confidence") if isinstance(obj, dict) else 0.0)
    return {
        "value": val,
        "confidence": min(conf, 0.3) if val is None else conf,
    }


def to_label_read(raw_json: dict) -> dict:
    kinds = ("medication", "food", "other", "unreadable")
    kind = raw_json.get("kind") if raw_json.get("kind") in kinds else "unreadable"
    strength = coerce_str_field(raw_json.get("strength"))
    if strength["value"] is not None:
        s_val = re.sub(r"(\d),(?=\d)", r"\1.", strength["value"])
        s_val = re.sub(r"\s+", " ", s_val).strip()
        strength["value"] = sanitize_dashes(s_val)

    product = coerce_str_field(raw_json.get("product"))
    if product["value"] is not None:
        product["value"] = sanitize_dashes(product["value"])

    ingredient = coerce_str_field(raw_json.get("ingredient"))
    if ingredient["value"] is not None:
        ingredient["value"] = sanitize_dashes(ingredient["value"])

    dosing = coerce_str_field(raw_json.get("dosing"))
    if dosing["value"] is not None:
        dosing["value"] = sanitize_dashes(dosing["value"])

    expiry = coerce_str_field(raw_json.get("expiry"))
    if expiry["value"] is not None:
        expiry["value"] = sanitize_dashes(expiry["value"])
        if not re.match(r"^\d{4}-\d{2}(-\d{2})?$", expiry["value"]):
            expiry["confidence"] = min(expiry["confidence"], 0.5)

    barcode = coerce_str_field(raw_json.get("barcode"))
    read_obj = {
        "kind": kind,
        "product": product,
        "ingredient": ingredient,
        "strength": strength,
        "dosing": dosing,
        "expiry": expiry,
        "allergens": coerce_arr_field(raw_json.get("allergens")),
        "barcode": barcode,
        "readability": clamp01(raw_json.get("readability")),
    }
    guidance = raw_json.get("guidance")
    if isinstance(guidance, str) and guidance.strip():
        read_obj["guidance"] = sanitize_dashes(guidance.strip()[:120])
    return read_obj


def parse_strength(text: str | None) -> list[tuple[float, str]]:
    if not text:
        return []
    t = text.lower()
    t = re.sub(r"(\d),(\d)", r"\1.\2", t).replace("\u00b5", "u")
    out = []
    pattern = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|mcg|ug|g|ml|iu|ky|mikrog|microgram)s?\b|(\d+(?:\.\d+)?)\s*(%)")
    for m in pattern.finditer(t):
        num_str = m.group(1) or m.group(3)
        unit_str = m.group(2) or m.group(4)
        if unit_str not in UNIT_FACTORS:
            continue
        norm_unit, factor = UNIT_FACTORS[unit_str]
        out.append((round(float(num_str) * factor, 6), norm_unit))
    return out


def same_strength(a: str | None, b: str | None) -> bool:
    pa = parse_strength(a)
    pb = parse_strength(b)
    if not pa or not pb:
        return False
    short, long_list = (pa, pb) if len(pa) <= len(pb) else (pb, pa)
    return all(
        any(u_x == u_y and abs(amt_x - amt_y) < 1e-6 for amt_y, u_y in long_list)
        for amt_x, u_x in short
    )


def norm_token(text: str | None) -> str:
    if not text:
        return ""
    s = text.lower()
    s = re.sub(r"[^a-z0-9.,%/+ -]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def levenshtein(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 2:
        return 99
    dp = [list(range(len(b) + 1))]
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            row[j] = min(dp[i - 1][j] + 1, row[j - 1] + 1, dp[i - 1][j - 1] + cost)
        dp.append(row)
    return dp[len(a)][len(b)]


def matches_expected_med(read_obj: dict, expected_ing: str) -> bool:
    candidates = []
    for fld in ("ingredient", "product"):
        val = read_obj[fld]["value"]
        if val:
            candidates.extend(re.split(r"[\s,/+()-]+", norm_token(val)))
    want = norm_token(expected_ing)
    for tok in candidates:
        if len(tok) < 4 or tok[0].isdigit():
            continue
        if tok == want or (len(tok) >= 6 and len(want) >= 6 and levenshtein(tok, want) <= 2):
            return True
    return False


def simulate_verdict_level(read_obj: dict, med: dict, strength_threshold: float) -> str:
    ing_ok = bool(read_obj["ingredient"]["value"]) and read_obj["ingredient"]["confidence"] >= NAME_MIN_CONF
    prod_ok = bool(read_obj["product"]["value"]) and read_obj["product"]["confidence"] >= NAME_MIN_CONF
    name_ok = ing_ok or prod_ok

    if read_obj["kind"] == "unreadable" or (not name_ok and read_obj["readability"] < 0.5):
        return "unsure"

    if read_obj["kind"] == "medication":
        matched = name_ok and matches_expected_med(read_obj, med["expected_ingredient"])
        if not matched:
            if not name_ok:
                return "unsure"
            return "warning"
        strength_ok = (
            bool(read_obj["strength"]["value"])
            and read_obj["strength"]["confidence"] >= strength_threshold
        )
        if not strength_ok:
            return "unsure"
        if not same_strength(read_obj["strength"]["value"], med["expected_strength"]):
            return "warning"
        return "match"

    return "unsure" if not name_ok else "info"


def call_gemini_verify(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict,
    b64_jpeg: str,
) -> tuple[dict, float]:
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

    last_err = None
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
                    return parsed, elapsed_ms
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
    raise RuntimeError(f"Gemini verify call failed after retries: {last_err}")


def compute_ece(items: list[dict], num_bins: int = 10) -> tuple[float, list[dict]]:
    n = len(items)
    bins_out = []
    ece_sum = 0.0
    for b in range(num_bins):
        lo = round(b / num_bins, 2)
        hi = round((b + 1) / num_bins, 2)
        if b == 0:
            members = [it for it in items if lo <= it["strength_confidence"] <= hi]
        else:
            members = [it for it in items if lo < it["strength_confidence"] <= hi]
        if not members:
            continue
        mean_conf = statistics.mean(it["strength_confidence"] for it in members)
        emp_acc = statistics.mean(1.0 if it["strength_match"] else 0.0 for it in members)
        gap = abs(emp_acc - mean_conf)
        ece_sum += (len(members) / n) * gap
        bins_out.append(
            {
                "bin_lower": lo,
                "bin_upper": hi,
                "count": len(members),
                "mean_confidence": round(mean_conf, 4),
                "empirical_accuracy": round(emp_acc, 4),
                "abs_gap": round(gap, 4),
            }
        )
    return round(ece_sum, 4), bins_out


def compute_threshold_sweep(items: list[dict], thresholds: list[float]) -> list[dict]:
    readable_items = [it for it in items if it["strength_readable"]]
    unreadable_items = [it for it in items if not it["strength_readable"]]
    total_n = len(items)
    curve = []

    for thr in thresholds:
        clean_accepted_correct = sum(
            1
            for it in readable_items
            if bool(it["strength_value"])
            and it["strength_confidence"] >= thr
            and it["strength_match"]
        )
        clean_recall = clean_accepted_correct / len(readable_items)

        unreadable_abstained = sum(
            1
            for it in unreadable_items
            if simulate_verdict_level(it["read"], it["_med"], thr) == "unsure"
        )
        unreadable_abstention_rate = unreadable_abstained / len(unreadable_items)

        accepted_all = [
            it
            for it in items
            if bool(it["strength_value"]) and it["strength_confidence"] >= thr
        ]
        confident_wrong_dose_count = sum(
            1
            for it in items
            if it["strength_confidence"] >= thr
            and (
                not it["strength_readable"]
                or not bool(it["strength_value"])
                or not it["strength_match"]
            )
        )

        coverage = len(accepted_all) / total_n
        selective_risk = (
            confident_wrong_dose_count / len(accepted_all) if accepted_all else 0.0
        )

        curve.append(
            {
                "threshold": round(thr, 2),
                "clean_recall": round(clean_recall, 4),
                "unreadable_abstention_rate": round(unreadable_abstention_rate, 4),
                "confident_wrong_dose_count": confident_wrong_dose_count,
                "accepted_count": len(accepted_all),
                "coverage": round(coverage, 4),
                "selective_risk": round(selective_risk, 4),
            }
        )
    return curve


def main() -> None:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in environment")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)
    SWEEP_OUT_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    items = []

    for med in MEDICATIONS:
        for tier in TIERS:
            item_id = f'{med["slug"]}__{tier["key"]}'
            img_path = SWEEP_OUT_DIR / f"{item_id}.jpg"
            img = render_tier_image(med, tier["key"])
            b64_jpeg = encode_jpeg_b64(img, img_path)

            raw_model_json, latency_ms = call_gemini_verify(
                session=session,
                api_key=api_key,
                verify_prompt=verify_prompt,
                label_schema=label_schema,
                b64_jpeg=b64_jpeg,
            )

            raw_strength_obj = raw_model_json.get("strength") if isinstance(raw_model_json, dict) else {}
            raw_strength_val = raw_strength_obj.get("value") if isinstance(raw_strength_obj, dict) else None
            if isinstance(raw_strength_val, str):
                raw_strength_val = sanitize_dashes(raw_strength_val)
            raw_strength_conf = clamp01(
                raw_strength_obj.get("confidence") if isinstance(raw_strength_obj, dict) else 0.0
            )

            read_obj = to_label_read(raw_model_json)
            strength_val = read_obj["strength"]["value"]
            strength_conf = round(read_obj["strength"]["confidence"], 4)
            is_strength_match = bool(
                tier["strength_readable"]
                and strength_val is not None
                and same_strength(strength_val, med["expected_strength"])
            )
            verdict_080 = simulate_verdict_level(read_obj, med, STRENGTH_MIN_CONF)

            item_rec = {
                "id": item_id,
                "medication": med["label"],
                "expected_ingredient": med["expected_ingredient"],
                "expected_strength": med["expected_strength"],
                "tier_index": tier["index"],
                "tier": tier["key"],
                "degradation": tier["degradation"],
                "strength_readable": tier["strength_readable"],
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "latency_ms": round(latency_ms, 1),
                "raw_strength_value": raw_strength_val,
                "raw_strength_confidence": round(raw_strength_conf, 4),
                "strength_value": strength_val,
                "strength_confidence": strength_conf,
                "strength_match": is_strength_match,
                "verdict_at_0_80": verdict_080,
                "read": read_obj,
                "_med": med,
            }
            items.append(item_rec)
            print(
                f'[{item_id}] readable={tier["strength_readable"]} '
                f'val={strength_val!r} conf={strength_conf:.2f} '
                f'match={is_strength_match} verdict@0.80={verdict_080} '
                f'ms={latency_ms:.1f}'
            )

    mean_conf_by_tier = {}
    for tier in TIERS:
        tier_confs = [it["strength_confidence"] for it in items if it["tier"] == tier["key"]]
        mean_conf_by_tier[tier["key"]] = round(statistics.mean(tier_confs), 4)

    threshold_curve = compute_threshold_sweep(items, THRESHOLDS)
    ece_val, cal_bins = compute_ece(items, num_bins=10)
    brier = round(
        statistics.mean(
            (it["strength_confidence"] - (1.0 if it["strength_match"] else 0.0)) ** 2
            for it in items
        ),
        4,
    )

    for it in items:
        it.pop("_med", None)

    latencies = [it["latency_ms"] for it in items]
    prod_entry = next(row for row in threshold_curve if abs(row["threshold"] - 0.80) < 1e-6)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "production_strength_min_conf": STRENGTH_MIN_CONF,
        "total_items": len(items),
        "readable_items": sum(1 for it in items if it["strength_readable"]),
        "unreadable_items": sum(1 for it in items if not it["strength_readable"]),
        "mean_strength_confidence_by_tier": mean_conf_by_tier,
        "ece": ece_val,
        "brier_score": brier,
        "at_production_threshold_0_80": prod_entry,
        "threshold_sweep": threshold_curve,
        "latency_ms": {
            "mean": round(statistics.mean(latencies), 1),
            "p50": round(statistics.median(latencies), 1),
            "max": round(max(latencies), 1),
        },
    }

    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "summary": summary,
        "threshold_curve": threshold_curve,
        "calibration_bins": cal_bins,
        "items": items,
    }

    OUT_JSON_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Wrote", OUT_JSON_PATH)


if __name__ == "__main__":
    main()
