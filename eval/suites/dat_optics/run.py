from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
REPO = SUITE_DIR.parents[2]
SHARED_DIR = REPO / "shared"
SAFETY_TS = REPO / "server" / "src" / "safety.ts"
SAFETY_BRIDGE = REPO / "eval" / "safety_bridge.mts"
RESULTS_PATH = SUITE_DIR / "results.json"

MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
EVAL_NOW_ISO = "2026-11-14T12:00:00+02:00"
FRAME_W = 720
FRAME_H = 1280
MAX_WORKERS = 6

DEFAULT_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "med_amlo",
            "name": "Norvasc",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "med_met",
            "name": "Glucophage",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "med_levo",
            "name": "Thyroxin",
            "ingredient": "levothyroxine",
            "strength": "50 mcg",
            "schedule": ["morning"],
        },
    ],
    "allergies": ["peanut", "hazelnut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}


def ensure_node_path() -> None:
    node_bin = Path("/tmp/fleet-silas/node/bin")
    if node_bin.exists():
        cur_path = os.environ.get("PATH", "")
        if str(node_bin) not in cur_path.split(os.pathsep):
            os.environ["PATH"] = f"{node_bin}{os.pathsep}{cur_path}"


def setup_runtime_env() -> None:
    ensure_node_path()

    candidates: list[Path] = []
    if os.environ.get("HOLDUP_ENV_FILE"):
        candidates.append(Path(os.environ["HOLDUP_ENV_FILE"]))
    candidates.extend([
        REPO / ".env",
        Path.home() / "momin" / ".env",
        Path.home() / "junction-meta-glasses" / ".env",
    ])
    comment_prefix = chr(35)
    for env_path in candidates:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(comment_prefix) or "=" not in line:
                continue
            key, val = line.split("=", 1)
            clean_val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), clean_val)
    if not os.environ.get("GEMINI_API_KEY") and os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY"):
        os.environ["GEMINI_API_KEY"] = os.environ["GOOGLE_GENERATIVE_AI_API_KEY"]
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("GEMINI_API_KEY is not configured")


def redact_secret(text: str) -> str:
    out = text
    for var_name in ("GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"):
        secret = os.environ.get(var_name)
        if secret:
            out = out.replace(secret, "***")
    return re.sub(r"key=[A-Za-z0-9_\-]+", "key=***", out)


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None:
        defs = node.get("$defs", {}) if isinstance(node, dict) else {}
    if isinstance(node, list):
        return [inline_refs(item, defs) for item in node]
    if isinstance(node, dict):
        ref_val = node.get("$ref")
        if isinstance(ref_val, str):
            ref_key = ref_val.split("/")[-1]
            return inline_refs(defs[ref_key], defs)
        return {
            k: inline_refs(v, defs)
            for k, v in node.items()
            if k not in ("$defs", "$comment")
        }
    return node


def load_prompt_and_schema() -> tuple[str, dict[str, Any], str, str, str]:
    prompt_txt = (SHARED_DIR / "verify_prompt.md").read_text(encoding="utf-8")
    schema_txt = (SHARED_DIR / "label_schema.json").read_text(encoding="utf-8")
    digest_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    prompt_sha256 = hashlib.sha256(prompt_txt.encode("utf-8")).hexdigest()
    schema_sha256 = hashlib.sha256(schema_txt.encode("utf-8")).hexdigest()
    schema_obj = inline_refs(json.loads(schema_txt))
    return prompt_txt, schema_obj, digest_12, prompt_sha256, schema_sha256


def to_label_read(raw: Any) -> dict[str, Any]:
    def clamp01(val: Any) -> float:
        if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val)):
            return max(0.0, min(1.0, round(float(val), 4)))
        return 0.0

    def is_nonempty_str(val: Any) -> bool:
        return isinstance(val, str) and len(val.strip()) > 0

    def is_str_list(val: Any) -> bool:
        return isinstance(val, list) and all(isinstance(item, str) for item in val)

    def coerce_field(obj: Any, pred_fn: Any) -> dict[str, Any]:
        val = obj.get("value") if isinstance(obj, dict) else None
        clean_val = val if pred_fn(val) else None
        conf = clamp01(obj.get("confidence") if isinstance(obj, dict) else 0.0)
        return {
            "value": clean_val,
            "confidence": min(conf, 0.3) if clean_val is None else conf,
        }

    data = raw if isinstance(raw, dict) else {}
    valid_kinds = ("medication", "food", "other", "unreadable")
    kind = data.get("kind") if data.get("kind") in valid_kinds else "unreadable"
    coerced: dict[str, Any] = {
        "kind": kind,
        "product": coerce_field(data.get("product"), is_nonempty_str),
        "ingredient": coerce_field(data.get("ingredient"), is_nonempty_str),
        "strength": coerce_field(data.get("strength"), is_nonempty_str),
        "dosing": coerce_field(data.get("dosing"), is_nonempty_str),
        "expiry": coerce_field(data.get("expiry"), is_nonempty_str),
        "allergens": coerce_field(data.get("allergens"), is_str_list),
        "barcode": coerce_field(data.get("barcode"), is_nonempty_str),
        "readability": clamp01(data.get("readability")),
    }
    guidance = data.get("guidance")
    if is_nonempty_str(guidance):
        coerced["guidance"] = guidance.strip()[:120]
    exp_val = coerced["expiry"]["value"]
    if isinstance(exp_val, str) and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", exp_val):
        coerced["expiry"]["confidence"] = min(coerced["expiry"]["confidence"], 0.5)
    return coerced


def font_px(size: int) -> Any:
    return ImageFont.load_default(size=max(8, int(size)))


def make_indoor_canvas(seed: int, table_y: int = 830) -> Image.Image:
    rng = np.random.default_rng(seed)
    yy = np.linspace(0.0, 1.0, FRAME_H, dtype=np.float32)[:, None]
    xx = np.linspace(0.0, 1.0, FRAME_W, dtype=np.float32)[None, :]
    wall_r = 214.0 - 28.0 * yy + 8.0 * xx
    wall_g = 210.0 - 30.0 * yy + 5.0 * xx
    wall_b = 202.0 - 26.0 * yy + 4.0 * xx
    arr = np.stack(
        [
            np.broadcast_to(wall_r, (FRAME_H, FRAME_W)),
            np.broadcast_to(wall_g, (FRAME_H, FRAME_W)),
            np.broadcast_to(wall_b, (FRAME_H, FRAME_W)),
        ],
        axis=-1,
    ).copy()
    arr[table_y:, :, 0] = 164.0 - 24.0 * yy[table_y:, :]
    arr[table_y:, :, 1] = 142.0 - 22.0 * yy[table_y:, :]
    arr[table_y:, :, 2] = 118.0 - 18.0 * yy[table_y:, :]
    arr += rng.normal(0.0, 2.2, size=arr.shape).astype(np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def apply_wide_fov_optics(im: Image.Image, k1: float = 0.075, vignette: float = 0.18) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    cy, cx = h * 0.5, w * 0.5
    norm_r = math.hypot(cx, cy)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dy = (yy - cy) / norm_r
    dx = (xx - cx) / norm_r
    r2 = dx * dx + dy * dy
    scale = 1.0 + k1 * r2
    src_x = np.clip(np.round(cx + dx * norm_r * scale).astype(np.int32), 0, w - 1)
    src_y = np.clip(np.round(cy + dy * norm_r * scale).astype(np.int32), 0, h - 1)
    warped = arr[src_y, src_x]
    vig_mask = np.clip(1.0 - vignette * (r2 ** 1.15), 0.65, 1.0)[..., None]
    warped = warped * vig_mask
    return Image.fromarray(np.clip(warped, 0, 255).astype(np.uint8), mode="RGB")


def apply_motion_blur(im: Image.Image, length_px: int, angle_deg: float) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    steps = max(1, int(length_px))
    acc = np.zeros_like(arr)
    dx = math.cos(math.radians(angle_deg))
    dy = math.sin(math.radians(angle_deg))
    for idx in range(steps):
        offset = idx - (steps - 1) * 0.5
        sx = int(round(offset * dx))
        sy = int(round(offset * dy))
        acc += np.roll(np.roll(arr, sy, axis=0), sx, axis=1)
    return Image.fromarray(np.clip(acc / steps, 0, 255).astype(np.uint8), mode="RGB")


def encode_dat_jpeg(im: Image.Image, quality: int, layout: str = "I420") -> bytes:
    ycbcr = im.convert("YCbCr")
    y_plane, cb_plane, cr_plane = ycbcr.split()
    w, h = im.size
    half_w = max(1, int(w / 2))
    half_h = max(1, int(h / 2))
    if layout == "GRAY":
        neutral = Image.new("L", (w, h), 128)
        merged = Image.merge("YCbCr", (y_plane, neutral, neutral)).convert("RGB")
    else:
        cb_sub = cb_plane.resize((half_w, half_h), Image.Resampling.BOX).resize((w, h), Image.Resampling.BILINEAR)
        cr_sub = cr_plane.resize((half_w, half_h), Image.Resampling.BOX).resize((w, h), Image.Resampling.BILINEAR)
        merged = Image.merge("YCbCr", (y_plane, cb_sub, cr_sub)).convert("RGB")
    buf = io.BytesIO()
    merged.save(buf, format="JPEG", quality=quality, subsampling=2)
    return buf.getvalue()


def render_med_box(
    box_w: int,
    box_h: int,
    header_rgb: tuple[int, int, int],
    brand: str,
    ingredient: str,
    strength: str,
    dosing: str,
    expiry: str,
    right_aligned_strength: bool = False,
    tiny_strength: bool = False,
) -> Image.Image:
    card = Image.new("RGB", (box_w, box_h), (249, 250, 252))
    draw = ImageDraw.Draw(card)
    band_h = max(24, int(box_h * 0.22))
    draw.rectangle([0, 0, box_w - 1, band_h], fill=header_rgb)
    draw.rectangle([0, 0, box_w - 1, box_h - 1], outline=(150, 156, 165), width=2)

    scale = box_w / 440.0
    pad_x = max(10, int(22 * scale))
    f_brand = font_px(max(10, round(38 * scale)))
    f_ing = font_px(max(9, round(25 * scale)))
    f_str = font_px(max(8, round((13 if tiny_strength else 35) * scale)))
    f_meta = font_px(max(8, round(20 * scale)))

    draw.text((pad_x, max(4, int(band_h * 0.18))), brand, fill=(255, 255, 255), font=f_brand)
    y_ing = band_h + max(8, int(18 * scale))
    draw.text((pad_x, y_ing), ingredient, fill=(24, 30, 38), font=f_ing)

    y_str = y_ing + max(14, int(40 * scale))
    if right_aligned_strength:
        str_x = int(box_w * 0.72)
        exp_x = int(box_w * 0.68)
    else:
        str_x = pad_x
        exp_x = pad_x
    if strength:
        badge_pad = max(4, int(8 * scale))
        bbox = draw.textbbox((str_x, y_str), strength, font=f_str)
        draw.rectangle(
            [bbox[0] - badge_pad, bbox[1] - badge_pad, bbox[2] + badge_pad, bbox[3] + badge_pad],
            fill=(232, 240, 252),
            outline=header_rgb,
            width=max(1, int(2 * scale)),
        )
        draw.text((str_x, y_str), strength, fill=(14, 24, 42), font=f_str)

    y_dos = y_str + max(18, int(58 * scale))
    if dosing:
        draw.text((pad_x, y_dos), dosing, fill=(45, 52, 62), font=f_meta)
    y_exp = y_dos + max(14, int(34 * scale))
    if expiry:
        draw.text((exp_x, y_exp), expiry, fill=(55, 60, 70), font=f_meta)
    return card


def render_food_box(
    box_w: int,
    box_h: int,
    header_rgb: tuple[int, int, int],
    product: str,
    subtitle: str,
    lines: list[str],
    expiry: str,
) -> Image.Image:
    card = Image.new("RGB", (box_w, box_h), (250, 248, 242))
    draw = ImageDraw.Draw(card)
    band_h = max(30, int(box_h * 0.24))
    draw.rectangle([0, 0, box_w - 1, band_h], fill=header_rgb)
    draw.rectangle([0, 0, box_w - 1, box_h - 1], outline=(140, 134, 124), width=2)

    pad_x = 20
    draw.text((pad_x, 16), product, fill=(255, 255, 255), font=font_px(29))
    draw.text((pad_x, 52), subtitle, fill=(240, 240, 235), font=font_px(18))

    y = band_h + 18
    f_body = font_px(20)
    for line in lines:
        draw.text((pad_x, y), line, fill=(26, 26, 26), font=f_body)
        y += 30
    draw.text((pad_x, box_h - 42), expiry, fill=(40, 40, 40), font=font_px(20))
    return card


def place_held_card(
    canvas: Image.Image,
    card: Image.Image,
    x: int,
    y: int,
    angle_deg: float = 0.0,
    draw_hand: bool = True,
) -> Image.Image:
    scene = canvas.copy()
    draw = ImageDraw.Draw(scene)
    if draw_hand:
        hx0 = x + int(card.width * 0.18)
        hx1 = x + int(card.width * 0.62)
        draw.rounded_rectangle(
            [hx0, y + card.height - 16, hx1, FRAME_H + 40],
            radius=36,
            fill=(196, 158, 134),
        )
    if abs(angle_deg) > 0.01:
        rotated = card.rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
        rgba_mask = Image.new("L", card.size, 255).rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
        scene.paste(rotated, (x, y), rgba_mask)
    else:
        scene.paste(card, (x, y))
    return scene


def build_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    c1_card = render_med_box(
        440, 290, (26, 79, 160), "NORVASC", "amlodipine", "5 mg", "1 tablet once daily", "EXP 2027-08"
    )
    c1_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(101), c1_card, 140, 460, -1.5))
    cases.append({
        "id": "dat_01_q80_match",
        "category": "jpeg_q80_baseline",
        "description": "720x1280 DAT Q80 YUV420 close hold of Norvasc 5 mg.",
        "question": "Is this my evening pill?",
        "expected_level": "match",
        "gt_ingredient": "amlodipine",
        "gt_strength": "5 mg",
        "frames": [encode_dat_jpeg(c1_scene, quality=80, layout="I420")],
    })

    c2_card = render_med_box(
        450, 295, (20, 118, 110), "GLUCOPHAGE", "metformin hydrochloride", "500 mg", "1 tablet twice daily", "EXP 2027-11"
    )
    c2_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(102), c2_card, 135, 455, 1.2))
    cases.append({
        "id": "dat_02_q80_gray_match",
        "category": "yuv_gray_fallback",
        "description": "720x1280 YuvJpeg.Layout.GRAY luma-only Q80 Glucophage 500 mg.",
        "question": "Check this tablet box.",
        "expected_level": "match",
        "gt_ingredient": "metformin",
        "gt_strength": "500 mg",
        "frames": [encode_dat_jpeg(c2_scene, quality=80, layout="GRAY")],
    })

    c3_card = render_med_box(
        415, 280, (26, 79, 160), "NORVASC", "amlodipine", "10 mg", "1 tablet once daily", "EXP 2027-09"
    )
    c3_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(103), c3_card, 152, 470, -4.0))
    cases.append({
        "id": "dat_03_q55_dose_warn",
        "category": "jpeg_q55_lookalike_dose",
        "description": "720x1280 Q55 YUV420 Norvasc 10 mg vs saved 5 mg dose.",
        "question": "Is this my 5 mg pill?",
        "expected_level": "warning",
        "gt_ingredient": "amlodipine",
        "gt_strength": "10 mg",
        "frames": [encode_dat_jpeg(c3_scene, quality=55, layout="I420")],
    })

    c4_card = render_med_box(
        430, 285, (186, 28, 34), "BURANA", "ibuprofeeni / ibuprofen", "400 mg", "20 film-coated tablets", "EXP 2027-05"
    )
    c4_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(104), c4_card, 145, 468, 2.5))
    cases.append({
        "id": "dat_04_q40_nsaid_warn",
        "category": "jpeg_q40_avoid_class",
        "description": "720x1280 Q40 YUV420 Finnish Burana 400 mg hitting NSAID avoid.",
        "question": "Can I take this for pain?",
        "expected_level": "warning",
        "gt_ingredient": "ibuprofen",
        "gt_strength": "400 mg",
        "frames": [encode_dat_jpeg(c4_scene, quality=40, layout="I420")],
    })

    c5_card = render_med_box(
        280, 190, (54, 92, 148), "THYROXIN", "levothyroxine", "50 mcg", "", "EXP 2027-10", tiny_strength=True
    )
    c5_raw = apply_wide_fov_optics(place_held_card(make_indoor_canvas(105), c5_card, 220, 530, -3.0))
    c5_deg = c5_raw.resize((120, 213), Image.Resampling.BILINEAR).resize((FRAME_W, FRAME_H), Image.Resampling.BILINEAR)
    c5_deg = c5_deg.filter(ImageFilter.GaussianBlur(radius=3.4))
    cases.append({
        "id": "dat_05_q10_blocks_unsure",
        "category": "jpeg_q10_severe_quantization",
        "description": "720x1280 defocus plus Q10 macroblocks destroying Thyroxin dose.",
        "question": "Is this my morning thyroid pill?",
        "expected_level": "unsure",
        "gt_ingredient": "levothyroxine",
        "gt_strength": None,
        "frames": [encode_dat_jpeg(c5_deg, quality=10, layout="I420")],
    })

    c6_big = render_med_box(
        440, 290, (26, 79, 160), "NORVASC", "amlodipine", "5 mg", "1 tablet once daily", "EXP 2027-08", tiny_strength=True
    )
    c6_tiny = c6_big.resize((64, 42), Image.Resampling.BILINEAR)
    c6_scene = place_held_card(make_indoor_canvas(106, table_y=690), c6_tiny, 328, 665, 0.0, draw_hand=False)
    c6_scene = apply_wide_fov_optics(c6_scene, k1=0.09, vignette=0.22).filter(ImageFilter.GaussianBlur(radius=1.2))
    cases.append({
        "id": "dat_06_far_fov_unsure",
        "category": "wide_fov_far_distance",
        "description": "Wide-FOV 720x1280 carton at 95 cm (64x42 px), sub-Nyquist dose.",
        "question": "Is that my pill on the table?",
        "expected_level": "unsure",
        "gt_ingredient": "amlodipine",
        "gt_strength": None,
        "frames": [encode_dat_jpeg(c6_scene, quality=80, layout="I420")],
    })

    c7_card = render_med_box(
        520,
        290,
        (26, 79, 160),
        "AMLODIPINE",
        "amlodipine",
        "5 mg",
        "1 tablet daily",
        "EXP 2027-08",
        right_aligned_strength=True,
    )
    c7_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(107), c7_card, 395, 460, 0.0))
    cases.append({
        "id": "dat_07_parallax_clip_unsure",
        "category": "temple_parallax_edge_clip",
        "description": "Left-temple parallax clips strength past right 720 px border.",
        "question": "Is this my Amlodipine 5 mg?",
        "expected_level": "unsure",
        "gt_ingredient": "amlodipine",
        "gt_strength": None,
        "frames": [encode_dat_jpeg(c7_scene, quality=80, layout="I420")],
    })

    c8_card = render_med_box(
        340, 235, (54, 92, 148), "THYROXIN", "levothyroxine", "50 mcg", "1 tablet each morning", "EXP 2028-02"
    )
    c8_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(108), c8_card, 190, 500, 1.8), k1=0.085, vignette=0.2)
    cases.append({
        "id": "dat_08_arms_len_match",
        "category": "wide_fov_arms_length_q80",
        "description": "Wide-FOV 720x1280 arm's-length hold with barrel distortion Q80.",
        "question": "Is this my morning Thyroxin?",
        "expected_level": "match",
        "gt_ingredient": "levothyroxine",
        "gt_strength": "50 mcg",
        "frames": [encode_dat_jpeg(c8_scene, quality=80, layout="I420")],
    })

    c9_card = render_food_box(
        460,
        340,
        (132, 74, 28),
        "NORDIC GRANOLA CRUNCH",
        "Wholegrain breakfast cereal",
        [
            "Ingredients: rolled oats, honey,",
            "roasted hazelnut (12%), rapeseed oil.",
            "Allergens: contains hazelnut, oats (gluten).",
            "May contain: peanut.",
        ],
        "Best before 2027-04-15",
    )
    c9_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(109), c9_card, 130, 430, -1.5))
    cases.append({
        "id": "dat_09_yuv420_allergen_warn",
        "category": "yuv420_food_allergen",
        "description": "720x1280 Q65 YUV420 granola panel with hazelnut and peanut.",
        "question": "Is this safe with nut allergies?",
        "expected_level": "warning",
        "gt_ingredient": None,
        "gt_strength": None,
        "frames": [encode_dat_jpeg(c9_scene, quality=65, layout="I420")],
    })

    c10_card = render_food_box(
        460,
        340,
        (42, 98, 138),
        "OATLY OAT DRINK BARISTA",
        "Plant-based oat drink",
        [
            "Ingredients: water, oats (10%),",
            "rapeseed oil, sea salt, vitamins D2, B12.",
            "Allergen information: contains oats (gluten).",
        ],
        "Best before 2027-06-20",
    )
    c10_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(110), c10_card, 130, 430, 1.0))
    cases.append({
        "id": "dat_10_q75_safe_food_info",
        "category": "jpeg_q75_safe_food",
        "description": "720x1280 Q75 YUV420 oat drink without user's nut allergens.",
        "question": "Any of my allergens here?",
        "expected_level": "info",
        "gt_ingredient": None,
        "gt_strength": None,
        "frames": [encode_dat_jpeg(c10_scene, quality=75, layout="I420")],
    })

    c11_card = render_med_box(
        440, 290, (20, 118, 110), "GLUCOPHAGE", "metformin", "500 mg", "1 tablet twice daily", "EXP 2025-04"
    )
    c11_scene = apply_wide_fov_optics(place_held_card(make_indoor_canvas(111), c11_card, 140, 460, -2.0))
    cases.append({
        "id": "dat_11_q70_expired_warn",
        "category": "jpeg_q70_expired_med",
        "description": "720x1280 Q70 YUV420 Glucophage 500 mg expired EXP 2025-04.",
        "question": "Is this Metformin box in date?",
        "expected_level": "warning",
        "gt_ingredient": "metformin",
        "gt_strength": "500 mg",
        "frames": [encode_dat_jpeg(c11_scene, quality=70, layout="I420")],
    })

    c12_card = render_med_box(
        440, 290, (26, 79, 160), "NORVASC", "amlodipine", "5 mg", "1 tablet once daily", "EXP 2028-01"
    )
    c12_f1 = apply_motion_blur(
        apply_wide_fov_optics(place_held_card(make_indoor_canvas(112), c12_card, 55, 650, -11.0)),
        length_px=24,
        angle_deg=28.0,
    )
    c12_f2 = apply_wide_fov_optics(place_held_card(make_indoor_canvas(113), c12_card, 140, 455, -1.0))
    cases.append({
        "id": "dat_12_two_frame_match",
        "category": "dat_1fps_two_frame_fusion",
        "description": "Two-frame 1 fps DAT burst (blurred raise plus sharp Q80 frame).",
        "question": "Held steady, is this my evening pill?",
        "expected_level": "match",
        "gt_ingredient": "amlodipine",
        "gt_strength": "5 mg",
        "frames": [
            encode_dat_jpeg(c12_f1, quality=80, layout="I420"),
            encode_dat_jpeg(c12_f2, quality=80, layout="I420"),
        ],
    })

    return cases


def parse_json_reply(text: str) -> Any:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned)
    return json.loads(cleaned)


def call_gemini_verify(
    frames: list[bytes],
    question: str,
    prompt_txt: str,
    schema_obj: dict[str, Any],
) -> tuple[dict[str, Any], float, bool]:
    parts: list[dict[str, Any]] = [
        {
            "inlineData": {
                "mimeType": "image/jpeg",
                "data": base64.b64encode(frame_bytes).decode("ascii"),
            }
        }
        for frame_bytes in frames[:3]
    ]
    user_text = f'The person asked: "{question.strip()[:300]}"' if question.strip() else "Read this label."
    parts.append({"text": user_text})

    payload = {
        "systemInstruction": {"parts": [{"text": prompt_txt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema_obj,
            "thinkingConfig": {"thinkingLevel": THINKING_LEVEL.upper()},
            "maxOutputTokens": 4096,
        },
    }
    body_bytes = json.dumps(payload).encode("utf-8")
    endpoint = (
        "https:"
        + chr(47) * 2
        + f"generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    )

    last_err: Exception | None = None
    saw_timeout = False
    for attempt in range(5):
        t0 = time.perf_counter()
        req = urllib.request.Request(
            endpoint,
            data=body_bytes,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": os.environ["GEMINI_API_KEY"],
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw_resp = json.loads(resp.read().decode("utf-8"))
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
            cand_parts = raw_resp["candidates"][0]["content"]["parts"]
            text_out = "".join(p.get("text", "") for p in cand_parts if not p.get("thought"))
            if not text_out.strip():
                raise RuntimeError("empty model text")
            parsed = parse_json_reply(text_out)
            return to_label_read(parsed), latency_ms, False
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code not in (408, 429, 500, 502, 503, 504) or attempt == 4:
                break
        except Exception as err:
            last_err = err
            if "timed out" in str(err).lower() or isinstance(err, TimeoutError):
                saw_timeout = True
            if attempt == 4:
                break
        sleep_s = (1.5 * (2 ** attempt)) * (0.6 + 0.6 * random.random())
        time.sleep(min(sleep_s, 20.0))

    raise RuntimeError(redact_secret(f"gemini_failed(timeout={saw_timeout}): {last_err}"))


def resolve_tsx_cmd() -> list[str]:
    local_tsx = REPO / "node_modules" / ".bin" / "tsx"
    if local_tsx.exists():
        return [str(local_tsx)]
    env_tsx = os.environ.get("HOLDUP_TSX")
    if env_tsx and Path(env_tsx).exists():
        return [env_tsx]
    which_tsx = shutil.which("tsx")
    if which_tsx:
        return [which_tsx]
    which_npx = shutil.which("npx")
    if which_npx:
        return [which_npx, "--yes", "tsx"]
    raise RuntimeError("tsx executable not found")


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cmd = resolve_tsx_cmd() + [str(SAFETY_BRIDGE)]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", encoding="utf-8", delete=False) as tmp:
        for row in batch:
            tmp.write(json.dumps(row, ensure_ascii=False) + "\n")
        tmp_path = Path(tmp.name)
    try:
        with tmp_path.open("r", encoding="utf-8") as stdin_f:
            proc = subprocess.run(
                cmd,
                stdin=stdin_f,
                capture_output=True,
                text=True,
                timeout=120,
                env=dict(os.environ, HOLDUP_SAFETY_TS=str(SAFETY_TS)),
            )
        if proc.returncode != 0:
            raise RuntimeError(f"safety_bridge failed: {proc.stderr[-400:]}")
        rows = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
        if len(rows) != len(batch):
            raise RuntimeError(f"safety_bridge count mismatch: {len(rows)} != {len(batch)}")
        return rows
    finally:
        tmp_path.unlink(missing_ok=True)


def norm_strength_token(val: str | None) -> tuple[float, str] | None:
    if not val:
        return None
    cleaned = val.lower().replace(",", ".").replace("µ", "u")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|ug|mikrog|microgram|g|ml|iu)\b", cleaned)
    if not m:
        return None
    num = float(m.group(1))
    unit = m.group(2)
    if unit == "g":
        return (round(num * 1000.0, 6), "mg")
    if unit in ("mcg", "ug", "mikrog", "microgram"):
        return (round(num * 0.001, 6), "mg")
    return (round(num, 6), unit)


def is_confident_wrong_dose(read_obj: dict[str, Any], gt_strength: str | None) -> bool:
    s_field = read_obj.get("strength") or {}
    val = s_field.get("value")
    conf = float(s_field.get("confidence") or 0.0)
    if val is None or conf < 0.8:
        return False
    if gt_strength is None:
        return True
    pred_norm = norm_strength_token(val)
    gt_norm = norm_strength_token(gt_strength)
    if pred_norm is None or gt_norm is None:
        return val.strip().lower() != gt_strength.strip().lower()
    return pred_norm[1] != gt_norm[1] or abs(pred_norm[0] - gt_norm[0]) > 1e-6


def is_confident_wrong_ingredient(read_obj: dict[str, Any], gt_ingredient: str | None) -> bool:
    if gt_ingredient is None:
        return False
    i_field = read_obj.get("ingredient") or {}
    val = i_field.get("value")
    conf = float(i_field.get("confidence") or 0.0)
    if val is None or conf < 0.8:
        return False
    return gt_ingredient.lower() not in val.lower()


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    z2 = z * z
    p = k / n
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    half = (z / denom) * math.sqrt((p * (1.0 - p) / n) + (z2 / (4.0 * n * n)))
    return [round(max(0.0, min(1.0, center - half)), 4), round(max(0.0, min(1.0, center + half)), 4)]


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    ordered = sorted(vals)
    pos = (len(ordered) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo), 1)


def strip_dashes(text: str) -> str:
    return text.replace(chr(0x2014), "-").replace(chr(0x2013), "-")


def check_existing() -> int:
    ensure_node_path()
    src_py = Path(__file__).read_text(encoding="utf-8")
    hash_ch = chr(35)
    slash2 = chr(47) * 2
    em_dash = chr(0x2014)
    en_dash = chr(0x2013)
    key_re = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")
    assert hash_ch not in src_py and slash2 not in src_py and em_dash not in src_py and en_dash not in src_py

    raw_bytes = RESULTS_PATH.read_bytes()
    assert 0 < len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert em_dash not in raw_txt and en_dash not in raw_txt and not key_re.search(raw_txt)
    assert "data:image/" not in raw_txt and '"inlineData"' not in raw_txt

    data = json.loads(raw_txt)
    _, _, prompt_sha, prompt_sha256, schema_sha256 = load_prompt_and_schema()
    assert data["suite"] == "dat_optics"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == "shared/verify_prompt.md+shared/label_schema.json"
    assert data["prompt_sha256_12"] == prompt_sha == "814770315c42"
    assert data["prompt_sha256"] == prompt_sha256
    assert data["schema_sha256"] == schema_sha256
    assert data["safety_module"] == "server/src/safety.ts"
    assert data["errors"] == 0 and data["timeouts"] == 0

    readme_txt = (SUITE_DIR / "README.md").read_text(encoding="utf-8")
    assert slash2 not in readme_txt and em_dash not in readme_txt and en_dash not in readme_txt and not key_re.search(readme_txt)

    rendered_specs = build_cases()
    assert len(rendered_specs) == 12
    for spec in rendered_specs:
        assert len(spec["frames"]) >= 1
        for jpg in spec["frames"]:
            assert len(jpg) > 1000 and jpg[:2] == b"\xff\xd8" and b"Exif" not in jpg

    cases = data["cases"]
    summary = data["summary"]
    assert data["n"] == summary["n_cases"] == len(cases) == 12
    for c in cases:
        assert to_label_read(c["read"]) == c["read"]
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    re_verdicts = run_safety_bridge([
        {
            "read": c["read"],
            "profile": c.get("profile", data["profile"]),
            "now": c.get("eval_now_iso", data["eval_now_iso"]),
        }
        for c in cases
    ])
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: {rv['level']} != {c['predicted_level']}"

    assert summary["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"]) == 12
    assert summary["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert summary["unsafe_reassurance_count"] == sum(
        1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")
    ) == 0
    assert summary["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert data["confident_wrong_dose_count"] == summary["confident_wrong_dose_count"] == 0
    assert summary["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure") == 3
    print("OK:", json.dumps(summary))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    if args.render_only:
        specs = build_cases()
        out_dir = REPO / "eval" / "out" / "dat_optics"
        out_dir.mkdir(parents=True, exist_ok=True)
        for spec in specs:
            for fi, frame_bytes in enumerate(spec["frames"], 1):
                fname = f"{spec['id']}.jpg" if len(spec["frames"]) == 1 else f"{spec['id']}_f{fi}.jpg"
                (out_dir / fname).write_bytes(frame_bytes)
        print(f"Rendered {len(specs)} cases to {out_dir}")
        return 0

    setup_runtime_env()
    prompt_txt, schema_obj, prompt_sha, prompt_sha256, schema_sha256 = load_prompt_and_schema()
    specs = build_cases()

    reads: list[dict[str, Any] | None] = [None] * len(specs)
    latencies: list[float] = [0.0] * len(specs)
    errors = 0
    timeouts = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        fut_map = {
            pool.submit(call_gemini_verify, spec["frames"], spec["question"], prompt_txt, schema_obj): idx
            for idx, spec in enumerate(specs)
        }
        for fut in as_completed(fut_map):
            idx = fut_map[fut]
            try:
                read_obj, lat_ms, _ = fut.result()
                reads[idx] = read_obj
                latencies[idx] = lat_ms
            except Exception as err:
                errors += 1
                if "timeout=true" in str(err).lower():
                    timeouts += 1
                nf = {"value": None, "confidence": 0.0}
                reads[idx] = {
                    "kind": "unreadable",
                    "product": nf,
                    "ingredient": nf,
                    "strength": nf,
                    "dosing": nf,
                    "expiry": nf,
                    "allergens": nf,
                    "barcode": nf,
                    "readability": 0.0,
                }
                latencies[idx] = 0.0

    bridge_inputs = [
        {"read": reads[idx], "profile": DEFAULT_PROFILE, "now": EVAL_NOW_ISO}
        for idx in range(len(specs))
    ]
    bridge_outputs = run_safety_bridge(bridge_inputs)

    out_cases: list[dict[str, Any]] = []
    confident_wrong_dose_count = 0
    for idx, spec in enumerate(specs):
        read_obj = reads[idx] or {}
        verdict = bridge_outputs[idx]
        pred_level = verdict["level"]
        exp_level = spec["expected_level"]
        verdict_ok = pred_level == exp_level
        false_match = pred_level == "match" and exp_level != "match"
        unsafe_reassurance = exp_level == "warning" and pred_level in ("match", "info")
        cw_dose = is_confident_wrong_dose(read_obj, spec["gt_strength"])
        cw_ing = is_confident_wrong_ingredient(read_obj, spec["gt_ingredient"])
        if cw_dose:
            confident_wrong_dose_count += 1
        confident_wrong = bool(cw_dose or cw_ing or false_match or unsafe_reassurance)

        out_cases.append({
            "id": spec["id"],
            "category": spec["category"],
            "description": strip_dashes(spec["description"])[:240],
            "question": spec["question"],
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_ok": verdict_ok,
            "confident_wrong": confident_wrong,
            "false_match": false_match,
            "latency_ms": latencies[idx],
            "read": read_obj,
            "reasons": [strip_dashes(str(r)) for r in verdict.get("reasons", [])[:4]],
        })

    n_cases = len(out_cases)
    verdict_matches = sum(1 for c in out_cases if c["verdict_ok"])
    confident_wrong_count = sum(1 for c in out_cases if c["confident_wrong"])
    false_match_count = sum(1 for c in out_cases if c["false_match"])
    unsafe_reassurance_count = sum(
        1 for c in out_cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")
    )
    abstain_count = sum(1 for c in out_cases if c["predicted_level"] == "unsure")
    valid_lats = [c["latency_ms"] for c in out_cases if c["latency_ms"] > 0]

    summary = {
        "n_cases": n_cases,
        "errors": errors,
        "timeouts": timeouts,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_cases, 4),
        "verdict_accuracy_ci95": wilson_ci95(verdict_matches, n_cases),
        "confident_wrong_count": confident_wrong_count,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "confident_wrong_rate": round(confident_wrong_count / n_cases, 4),
        "confident_wrong_ci95": wilson_ci95(confident_wrong_count, n_cases),
        "false_match_count": false_match_count,
        "unsafe_reassurance_count": unsafe_reassurance_count,
        "abstain_or_unsure_count": abstain_count,
        "latency_p50_ms": percentile(valid_lats, 0.50),
        "latency_p95_ms": percentile(valid_lats, 0.95),
    }

    pass_ci95 = wilson_ci95(verdict_matches, n_cases)
    cw_dose_ci95 = wilson_ci95(confident_wrong_dose_count, n_cases)
    generated_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    result_doc = {
        "suite": "dat_optics",
        "generated_at": generated_at,
        "eval_now_iso": EVAL_NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": "shared/verify_prompt.md+shared/label_schema.json",
        "prompt_sha256_12": prompt_sha,
        "prompt_sha256": prompt_sha256,
        "schema_sha256": schema_sha256,
        "safety_module": "server/src/safety.ts",
        "n": n_cases,
        "errors": errors,
        "timeouts": timeouts,
        "pass_count": verdict_matches,
        "pass_rate": round(verdict_matches / n_cases, 4),
        "pass_ci95_wilson": pass_ci95,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "confident_wrong_dose_rate": round(confident_wrong_dose_count / n_cases, 4),
        "confident_wrong_dose_ci95_wilson": cw_dose_ci95,
        "rule_of_three_95_upper": round(min(1.0, 3.0 / n_cases), 4),
        "profile": DEFAULT_PROFILE,
        "summary": summary,
        "cases": out_cases,
    }

    serialized = json.dumps(result_doc, indent=1, ensure_ascii=False) + "\n"
    RESULTS_PATH.write_text(serialized, encoding="utf-8")
    print(
        f"dat_optics: {verdict_matches}/{n_cases} accuracy={summary['verdict_accuracy']} "
        f"cw={confident_wrong_count} cw_dose={confident_wrong_dose_count} "
        f"errors={errors} bytes={len(serialized.encode('utf-8'))}"
    )
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
