import argparse
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
import sys
import time
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "curved_blister"
OUT_JSON_PATH = REPO_ROOT / "eval" / "curved_blister_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T12:00:00Z"
STRENGTH_MIN_CONF = 0.80

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)

CASE_SPECS: list[dict[str, Any]] = [
    {
        "id": "cb_01",
        "surface": "curved_amber_bottle",
        "description": "Curved amber bottle front-centered AMLODIPINE 5 mg / Take 1 tablet every evening / EXP 2027-09",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "seed": 201,
    },
    {
        "id": "cb_02",
        "surface": "curved_amber_bottle_rotated_55deg",
        "description": "Curved amber bottle rotated 55 deg with AMLODIPINE visible while strength wraps out of sight",
        "strength_readable": False,
        "is_occluded": True,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 202,
    },
    {
        "id": "cb_03",
        "surface": "curved_amber_bottle",
        "description": "Curved amber bottle AMLODIPINE 10 mg wrong strength vs 5 mg profile",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "warning",
        "expected_strength": "10 mg",
        "seed": 203,
    },
    {
        "id": "cb_04",
        "surface": "curved_white_bottle",
        "description": "Curved white bottle IBUPROFEN 400 mg tablets NSAID avoid catch",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "warning",
        "expected_strength": "400 mg",
        "seed": 204,
    },
    {
        "id": "cb_05",
        "surface": "curved_white_bottle",
        "description": "Curved white bottle METFORMIN 500 mg / EXP 2025-01 expired medication catch",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "warning",
        "expected_strength": "500 mg",
        "seed": 205,
    },
    {
        "id": "cb_06",
        "surface": "silver_blister_foil",
        "description": "Silver blister foil back AMLODIPIN 5 mg repeated diagonally across foil pockets",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "seed": 206,
    },
    {
        "id": "cb_07",
        "surface": "silver_blister_foil",
        "description": "Silver blister foil back PANADOL 500 mg / paracetamol readable across pockets",
        "strength_readable": True,
        "is_occluded": False,
        "expected_level": "match",
        "expected_strength": "500 mg",
        "seed": 207,
    },
    {
        "id": "cb_08",
        "surface": "silver_blister_foil_glare",
        "description": "Silver blister foil with bright diagonal specular light streak washing out mg digits",
        "strength_readable": False,
        "is_occluded": True,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 208,
    },
    {
        "id": "cb_09",
        "surface": "silver_blister_foil_popped_torn",
        "description": "Popped-out empty silver blister foil with jagged torn foil across the text",
        "strength_readable": False,
        "is_occluded": True,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 209,
    },
    {
        "id": "cb_10",
        "surface": "curved_glass_jar",
        "description": "Curved glass jar Hazelnut Cocoa Spread with hazelnuts (13%), skim milk, cocoa",
        "strength_readable": False,
        "is_occluded": False,
        "expected_level": "warning",
        "expected_strength": None,
        "seed": 210,
    },
]


def scrub_node(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED]", cleaned)
    if isinstance(val, list):
        return [scrub_node(item) for item in val]
    if isinstance(val, dict):
        return {str(k): scrub_node(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in output JSON")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


def load_env_files() -> None:
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"
    if home_env.is_file() and (not os.environ.get("GEMINI_API_KEY") or not os.environ.get("HTTPS_PROXY")):
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k_b, v_b = chunk.split(b"=", 1)
                    k_s = k_b.decode("utf-8", errors="ignore")
                    v_s = v_b.decode("utf-8", errors="ignore")
                    if k_s and k_s not in os.environ:
                        os.environ[k_s] = v_s
        except (OSError, subprocess.SubprocessError):
            pass

    for env_path in (home_env, repo_env):
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(COMMENT_CHAR):
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


def clamp_byte(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(round(v))


def render_counter_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = 556
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(234 - 26 * t)
        g = clamp_byte(229 - 25 * t)
        b = clamp_byte(220 - 22 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        streak = rng.randint(-3, 3)
        r = clamp_byte(178 - 28 * t + streak)
        g = clamp_byte(148 - 24 * t + streak)
        b = clamp_byte(114 - 18 * t + streak)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(132, 102, 74), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((34, 28, 224, 206), fill=(255, 250, 236, 44))
    bd.ellipse((538, 48, 736, 236), fill=(238, 246, 255, 36))
    bd.ellipse((280, 12, 468, 162), fill=(255, 246, 232, 26))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=26.0))
    return Image.alpha_composite(img.convert("RGBA"), bokeh).convert("RGB")


def wrap_lines(draw: ImageDraw.ImageDraw, text: str, font: Any, max_w: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    out: list[str] = []
    cur = words[0]
    for w in words[1:]:
        cand = f"{cur} {w}"
        if draw.textlength(cand, font=font) <= max_w:
            cur = cand
        else:
            out.append(cur)
            cur = w
    out.append(cur)
    return out


def make_unwrapped_bottle_label(
    header_band: tuple[int, int, int],
    header_text: str,
    title: str,
    strength_badge: str | None,
    body_lines: list[str],
    expiry_text: str | None,
    expiry_alert: bool = False,
    align_left_for_rotation: bool = False,
    paper_fill: tuple[int, int, int] = (252, 251, 247),
    tex_w: int = 960,
    tex_h: int = 660,
) -> Image.Image:
    tex = Image.new("RGB", (tex_w, tex_h), paper_fill)
    draw = ImageDraw.Draw(tex)

    draw.rectangle((0, 0, tex_w - 1, tex_h - 1), outline=(196, 192, 182), width=6)
    draw.rectangle((6, 6, tex_w - 7, 96), fill=header_band)

    f_hdr = ImageFont.load_default(size=34)
    f_title = ImageFont.load_default(size=78 if len(title) <= 12 else 60)
    f_str = ImageFont.load_default(size=78)
    f_body = ImageFont.load_default(size=44)
    f_exp = ImageFont.load_default(size=48)

    margin_x = 58 if align_left_for_rotation else 124
    usable_w = tex_w - 2 * margin_x

    draw.text((margin_x, 28), header_text, fill=(250, 252, 254), font=f_hdr)
    draw.text(
        (margin_x, 122),
        title,
        fill=(14, 20, 28),
        font=f_title,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )

    cur_y = 226
    if strength_badge is not None:
        bw = int(draw.textlength(strength_badge, font=f_str)) + 56
        bh = 108
        draw.rounded_rectangle(
            (margin_x, cur_y, margin_x + bw, cur_y + bh),
            radius=16,
            fill=(238, 245, 252),
            outline=header_band,
            width=4,
        )
        draw.text(
            (margin_x + 28, cur_y + 12),
            strength_badge,
            fill=(12, 18, 26),
            font=f_str,
            stroke_width=1,
            stroke_fill=(12, 18, 26),
        )
        cur_y += bh + 28
    else:
        cur_y += 18

    draw.line((margin_x, cur_y, tex_w - margin_x, cur_y), fill=(210, 206, 198), width=3)
    cur_y += 22

    for line in body_lines:
        for wline in wrap_lines(draw, line, f_body, usable_w):
            draw.text((margin_x, cur_y), wline, fill=(24, 30, 38), font=f_body)
            cur_y += 56

    if expiry_text:
        exp_y = max(cur_y + 10, tex_h - 94)
        exp_color = (164, 24, 24) if expiry_alert else (20, 26, 34)
        draw.text(
            (margin_x, exp_y),
            expiry_text,
            fill=exp_color,
            font=f_exp,
            stroke_width=1,
            stroke_fill=exp_color,
        )

    return tex


def sample_tex_bilinear(
    tex_bytes: bytes,
    tex_w: int,
    tex_h: int,
    u: float,
    v: float,
) -> tuple[float, float, float]:
    u_clamped = max(0.0, min(float(tex_w - 1), u))
    v_clamped = max(0.0, min(float(tex_h - 1), v))
    x0 = int(math.floor(u_clamped))
    y0 = int(math.floor(v_clamped))
    x1 = min(tex_w - 1, x0 + 1)
    y1 = min(tex_h - 1, y0 + 1)
    fx = u_clamped - x0
    fy = v_clamped - y0

    i00 = (y0 * tex_w + x0) * 3
    i10 = (y0 * tex_w + x1) * 3
    i01 = (y1 * tex_w + x0) * 3
    i11 = (y1 * tex_w + x1) * 3

    w00 = (1.0 - fx) * (1.0 - fy)
    w10 = fx * (1.0 - fy)
    w01 = (1.0 - fx) * fy
    w11 = fx * fy

    r = tex_bytes[i00] * w00 + tex_bytes[i10] * w10 + tex_bytes[i01] * w01 + tex_bytes[i11] * w11
    g = tex_bytes[i00 + 1] * w00 + tex_bytes[i10 + 1] * w10 + tex_bytes[i01 + 1] * w01 + tex_bytes[i11 + 1] * w11
    b = tex_bytes[i00 + 2] * w00 + tex_bytes[i10 + 2] * w10 + tex_bytes[i01 + 2] * w01 + tex_bytes[i11 + 2] * w11
    return r, g, b


def cylinder_body_base_rgb(style: str, theta: float, y_norm: float) -> tuple[float, float, float]:
    cos_t = math.cos(theta)
    light = max(0.0, math.cos(theta + 0.42))
    rim_spec = math.exp(-((theta + 1.08) / 0.14) ** 2) * 0.65 + math.exp(-((theta - 1.24) / 0.11) ** 2) * 0.30

    if style == "amber":
        trans = (cos_t ** 1.45) * (0.68 + 0.32 * math.sin(y_norm * math.pi))
        pill_shadow = 1.0
        if y_norm > 0.76:
            pill_wave = 0.5 + 0.5 * math.cos(theta * 5.0 + y_norm * 9.0)
            pill_shadow = 0.72 + 0.20 * pill_wave
        r = (58.0 + 148.0 * trans + 34.0 * light) * pill_shadow + 115.0 * rim_spec
        g = (20.0 + 72.0 * trans + 18.0 * light) * pill_shadow + 92.0 * rim_spec
        b = (4.0 + 14.0 * trans + 6.0 * light) * pill_shadow + 64.0 * rim_spec
        return r, g, b

    if style == "white":
        shade = 0.68 + 0.30 * light + 0.06 * cos_t
        r = 244.0 * shade + 28.0 * rim_spec
        g = 246.0 * shade + 28.0 * rim_spec
        b = 250.0 * shade + 28.0 * rim_spec
        return r, g, b

    cocoa_shade = 0.52 + 0.36 * light + 0.14 * cos_t
    glass_spec = math.exp(-((theta + 1.02) / 0.11) ** 2) * 0.85 + math.exp(-((theta - 1.18) / 0.09) ** 2) * 0.42
    r = 86.0 * cocoa_shade + 140.0 * glass_spec
    g = 48.0 * cocoa_shade + 132.0 * glass_spec
    b = 28.0 * cocoa_shade + 124.0 * glass_spec
    return r, g, b


def render_cylindrical_bottle_scene(
    seed: int,
    body_style: str,
    label_tex: Image.Image,
    theta_rot_deg: float = 0.0,
    label_span_deg: float = 138.0,
    radius: int = 192,
) -> Image.Image:
    canvas = render_counter_backdrop(seed, 768)
    xc = 384
    is_jar = body_style == "cocoa_jar"

    cap_r = int(radius * (0.90 if is_jar else 0.76))
    cap_y0 = 108 if is_jar else 98
    cap_y1 = 166 if is_jar else 174
    neck_y1 = 196 if is_jar else 214
    body_y0 = neck_y1
    body_y1 = 646
    label_y0 = 242 if is_jar else 252
    label_y1 = 594 if is_jar else 592
    sag_px = 11.0

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((xc - radius - 22, body_y1 - 24, xc + radius + 28, body_y1 + 36), fill=(24, 18, 12, 118))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    draw = ImageDraw.Draw(canvas)

    for dx in range(-cap_r, cap_r + 1):
        s_cap = max(-0.999, min(0.999, dx / max(1.0, float(cap_r))))
        th = math.asin(s_cap)
        rib = 0.94 + 0.06 * math.cos(th * 28.0)
        light = 0.66 + 0.34 * max(0.0, math.cos(th + 0.45))
        if is_jar:
            cr = clamp_byte((206.0 * light) * rib)
            cg = clamp_byte((168.0 * light) * rib)
            cb = clamp_byte((92.0 * light) * rib)
        else:
            cr = clamp_byte((246.0 * light) * rib)
            cg = clamp_byte((248.0 * light) * rib)
            cb = clamp_byte((251.0 * light) * rib)
        sag_c = int(round(5.0 * (1.0 - math.cos(th))))
        draw.line((xc + dx, cap_y0 + sag_c, xc + dx, cap_y1 + sag_c), fill=(cr, cg, cb))

    top_fill = (224, 188, 112) if is_jar else (250, 251, 253)
    draw.ellipse((xc - cap_r, cap_y0 - 10, xc + cap_r, cap_y0 + 12), fill=top_fill, outline=(176, 178, 182))

    for y in range(cap_y1, neck_y1):
        t = (y - cap_y1) / max(1, neck_y1 - cap_y1)
        cur_r = int(round(cap_r * 0.92 * (1.0 - t) + radius * t))
        for dx in range(-cur_r, cur_r + 1):
            s_n = max(-0.999, min(0.999, dx / max(1.0, float(cur_r))))
            th = math.asin(s_n)
            r_b, g_b, b_b = cylinder_body_base_rgb(body_style, th, 0.05)
            draw.point((xc + dx, y), fill=(clamp_byte(r_b), clamp_byte(g_b), clamp_byte(b_b)))

    tex_rgb = label_tex.convert("RGB")
    tex_w, tex_h = tex_rgb.size
    tex_bytes = tex_rgb.tobytes()

    theta_rot = math.radians(theta_rot_deg)
    label_span = math.radians(label_span_deg)
    half_span = 0.5 * label_span
    label_h = float(label_y1 - label_y0)

    canvas_bytes = bytearray(canvas.tobytes())

    sub_offsets = (-0.33, 0.0, 0.33)
    for dx in range(-radius, radius + 1):
        px = xc + dx
        if px < 0 or px >= 768:
            continue

        s_mid = max(-0.9995, min(0.9995, dx / float(radius)))
        theta_mid = math.asin(s_mid)
        sag = sag_px * math.cos(theta_mid)

        col_top = body_y0
        col_bot = int(round(body_y1 + sag))

        u_samples: list[float] = []
        in_label = True
        for off in sub_offsets:
            s_sub = max(-0.9995, min(0.9995, (dx + off) / float(radius)))
            th_sub = math.asin(s_sub)
            phi_sub = th_sub - theta_rot
            if abs(phi_sub) > half_span:
                in_label = False
                break
            u_samples.append(((phi_sub / label_span) + 0.5) * (tex_w - 1))

        paper_shade = 0.63 + 0.37 * max(0.0, math.cos(theta_mid + 0.38))
        paper_spec = math.exp(-((theta_mid + 1.08) / 0.16) ** 2) * 26.0

        lbl_top_y = label_y0 + sag
        lbl_bot_y = label_y1 + sag

        for py in range(max(0, col_top), min(768, col_bot)):
            y_norm = (py - col_top) / max(1.0, float(col_bot - col_top))
            if in_label and lbl_top_y <= py <= lbl_bot_y:
                v_coord = ((py - lbl_top_y) / max(1.0, label_h)) * (tex_h - 1)
                acc_r = 0.0
                acc_g = 0.0
                acc_b = 0.0
                for u_c in u_samples:
                    sr, sg, sb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u_c, v_coord)
                    acc_r += sr
                    acc_g += sg
                    acc_b += sb
                inv_n = 1.0 / len(u_samples)
                pr = (acc_r * inv_n) * paper_shade + paper_spec
                pg = (acc_g * inv_n) * paper_shade + paper_spec
                pb = (acc_b * inv_n) * paper_shade + paper_spec
            else:
                pr, pg, pb = cylinder_body_base_rgb(body_style, theta_mid, y_norm)

            idx = (py * 768 + px) * 3
            canvas_bytes[idx] = clamp_byte(pr)
            canvas_bytes[idx + 1] = clamp_byte(pg)
            canvas_bytes[idx + 2] = clamp_byte(pb)

    out_img = Image.frombytes("RGB", (768, 768), bytes(canvas_bytes))
    return out_img


def create_metallic_foil_sheet(w: int, h: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    buf = bytearray(w * h * 3)

    pockets: list[tuple[float, float]] = []
    for r_idx in range(2):
        for c_idx in range(3):
            px = (c_idx + 0.5) * (w / 3.0)
            py = (r_idx + 0.5) * (h / 2.0)
            pockets.append((px, py))

    rx = 66.0
    ry = 42.0

    brush_row = [rng.uniform(-4.5, 4.5) for _ in range(h)]
    for y in range(h):
        b_row = brush_row[y]
        for x in range(w):
            aniso = 22.0 * math.sin((x * 0.72 + y * 0.68) / 62.0) + 11.0 * math.cos((x * 0.35 - y * 0.88) / 39.0)
            knurl = 4.5 if ((x % 6 == 0) or (y % 6 == 0)) else -1.5

            pocket_delta = 0.0
            for cx, cy in pockets:
                ndx = (x - cx) / rx
                ndy = (y - cy) / ry
                d2 = ndx * ndx + ndy * ndy
                if d2 < 1.18:
                    if d2 > 0.86:
                        pocket_delta = -16.0
                    else:
                        dome = math.sqrt(max(0.0, 1.0 - d2))
                        pocket_delta = 14.0 * dome - 5.0 * ndx - 4.0 * ndy
                    knurl *= 0.25
                    break

            luma = 196.0 + aniso + knurl + b_row + pocket_delta + rng.uniform(-2.0, 2.0)
            idx = (y * w + x) * 3
            buf[idx] = clamp_byte(luma - 2.0)
            buf[idx + 1] = clamp_byte(luma)
            buf[idx + 2] = clamp_byte(luma + 5.0)

    foil = Image.frombytes("RGB", (w, h), bytes(buf))
    draw = ImageDraw.Draw(foil)
    for c_sep in (w // 3, (2 * w) // 3):
        for y_dash in range(10, h - 10, 12):
            draw.line((c_sep, y_dash, c_sep, y_dash + 6), fill=(142, 148, 156), width=2)
    mid_y = h // 2
    for x_dash in range(10, w - 10, 12):
        draw.line((x_dash, mid_y, x_dash + 6, mid_y), fill=(142, 148, 156), width=2)
    draw.rounded_rectangle((2, 2, w - 3, h - 3), radius=24, outline=(138, 144, 152), width=3)
    return foil


def mount_foil_on_backdrop(foil: Image.Image, seed: int, tilt_deg: float) -> Image.Image:
    bg = render_counter_backdrop(seed, 768).convert("RGBA")
    w, h = foil.size

    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, w - 1, h - 1), radius=24, fill=255)

    foil_rgba = foil.convert("RGBA")
    foil_rgba.putalpha(mask)
    rotated = foil_rgba.rotate(tilt_deg, resample=Image.Resampling.BICUBIC, expand=True)

    rw, rh = rotated.size
    ox = (768 - rw) // 2
    oy = (768 - rh) // 2

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    alpha_ch = rotated.getchannel("A")
    shadow_patch = Image.new("RGBA", (rw, rh), (22, 18, 14, 118))
    shadow_patch.putalpha(alpha_ch)
    shadow.paste(shadow_patch, (ox + 12, oy + 16), shadow_patch)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))

    comp = Image.alpha_composite(bg, shadow)
    comp.paste(rotated, (ox, oy), rotated)
    return comp.convert("RGB")


def draw_diagonal_foil_stamps(
    foil: Image.Image,
    main_line: str,
    sub_line: str,
    ink_rgb: tuple[int, int, int],
    angle_deg: float = 20.0,
    rim_expiry: str | None = None,
) -> Image.Image:
    w, h = foil.size
    overlay = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    f_main = ImageFont.load_default(size=35)
    f_sub = ImageFont.load_default(size=23)

    step_x = 300
    step_y = 128
    for row in range(1, 7):
        y_pos = row * step_y
        x_shift = (row % 2) * 130
        for col in range(0, 4):
            x_pos = 70 + col * step_x + x_shift
            od.text(
                (x_pos, y_pos),
                main_line,
                fill=(*ink_rgb, 242),
                font=f_main,
                stroke_width=1,
                stroke_fill=(*ink_rgb, 242),
            )
            od.text((x_pos + 4, y_pos + 42), sub_line, fill=(*ink_rgb, 224), font=f_sub)

    rotated_text = overlay.rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=False)
    cx = (w * 2 - w) // 2
    cy = (h * 2 - h) // 2
    cropped_text = rotated_text.crop((cx, cy, cx + w, cy + h))

    comp = Image.alpha_composite(foil.convert("RGBA"), cropped_text)

    if rim_expiry:
        rd = ImageDraw.Draw(comp)
        f_exp = ImageFont.load_default(size=22)
        rd.rounded_rectangle((w - 196, h - 44, w - 22, h - 12), radius=6, fill=(214, 218, 224, 215))
        rd.text((w - 184, h - 40), rim_expiry, fill=(24, 28, 36, 245), font=f_exp)

    spec = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    spd = ImageDraw.Draw(spec)
    spd.ellipse((-40, -30, 170, 130), fill=(255, 255, 255, 78))
    spec = spec.filter(ImageFilter.GaussianBlur(radius=22.0))
    comp = Image.alpha_composite(comp, spec)
    return comp.convert("RGB")


def render_glare_blister_case(seed: int) -> Image.Image:
    w, h = 556, 436
    foil = create_metallic_foil_sheet(w, h, seed).convert("RGBA")
    draw = ImageDraw.Draw(foil)
    f_main = ImageFont.load_default(size=38)
    f_sub = ImageFont.load_default(size=23)

    rows = [
        (52, 74),
        (92, 194),
        (132, 314),
    ]
    for rx, ry in rows:
        draw.text(
            (rx, ry),
            "AMLODIPIN",
            fill=(18, 28, 48, 245),
            font=f_main,
            stroke_width=1,
            stroke_fill=(18, 28, 48, 245),
        )
        draw.text((rx + 4, ry + 45), "amlodipine tablets", fill=(28, 38, 58, 225), font=f_sub)

    wide_glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    wgd = ImageDraw.Draw(wide_glow)
    wgd.polygon(
        [(210, -60), (470, -60), (585, h + 60), (325, h + 60)],
        fill=(255, 255, 252, 175),
    )
    wide_glow = wide_glow.filter(ImageFilter.GaussianBlur(radius=38.0))

    bloom = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    bd.polygon(
        [(258, -40), (432, -40), (544, h + 40), (370, h + 40)],
        fill=(255, 255, 255, 245),
    )
    bloom = bloom.filter(ImageFilter.GaussianBlur(radius=18.0))

    core = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    cd.polygon(
        [(286, -20), (410, -20), (518, h + 20), (394, h + 20)],
        fill=(255, 255, 255, 255),
    )
    core = core.filter(ImageFilter.GaussianBlur(radius=8.0))

    foil = Image.alpha_composite(foil, wide_glow)
    foil = Image.alpha_composite(foil, bloom)
    foil = Image.alpha_composite(foil, core)
    return mount_foil_on_backdrop(foil.convert("RGB"), seed, tilt_deg=-4.5)


def render_popped_torn_blister_case(seed: int) -> Image.Image:
    rng = random.Random(seed)
    w, h = 556, 436
    base_foil = create_metallic_foil_sheet(w, h, seed)
    foil = draw_diagonal_foil_stamps(
        foil=base_foil,
        main_line="AMLODIPINE",
        sub_line="amlodipine tablets",
        ink_rgb=(18, 28, 46),
        angle_deg=19.0,
        rim_expiry=None,
    )
    draw = ImageDraw.Draw(foil)

    for r_idx in range(2):
        for c_idx in range(3):
            cx = (c_idx + 0.5) * (w / 3.0)
            cy = (r_idx + 0.5) * (h / 2.0)
            draw.ellipse((cx - 68, cy - 44, cx + 68, cy + 44), fill=(78, 84, 94), outline=(126, 132, 142), width=3)

            cavity_pts: list[tuple[float, float]] = []
            flap_outer: list[tuple[float, float]] = []
            n_verts = 16
            for k in range(n_verts):
                ang = (2.0 * math.pi * k) / n_verts
                jag = rng.uniform(0.72, 1.12)
                rad_x = 56.0 * jag
                rad_y = 36.0 * jag
                cavity_pts.append((cx + rad_x * math.cos(ang), cy + rad_y * math.sin(ang)))
                curl = rng.uniform(6.0, 18.0) if k % 2 == 0 else rng.uniform(2.0, 7.0)
                flap_outer.append((cx + (rad_x + curl) * math.cos(ang), cy + (rad_y + 0.8 * curl) * math.sin(ang)))

            draw.polygon(flap_outer, fill=(236, 240, 246), outline=(132, 138, 148))
            draw.polygon(cavity_pts, fill=(24, 27, 34), outline=(96, 102, 112))
            draw.arc((cx - 42, cy - 24, cx + 42, cy + 24), start=20, end=195, fill=(64, 70, 82), width=2)

            tear_angle = rng.uniform(-0.45, 0.45)
            tx1 = cx + 78.0 * math.cos(tear_angle)
            ty1 = cy + 46.0 * math.sin(tear_angle)
            tx2 = cx - 74.0 * math.cos(tear_angle)
            ty2 = cy - 42.0 * math.sin(tear_angle)
            mid_x = 0.5 * (tx1 + tx2) + rng.uniform(-10.0, 10.0)
            mid_y = 0.5 * (ty1 + ty2) + rng.uniform(-12.0, 12.0)
            draw.polygon(
                [
                    (tx2, ty2 - 6),
                    (mid_x, mid_y - 11),
                    (tx1, ty1 - 5),
                    (tx1, ty1 + 7),
                    (mid_x, mid_y + 10),
                    (tx2, ty2 + 5),
                ],
                fill=(30, 34, 42),
                outline=(228, 233, 240),
            )

    return mount_foil_on_backdrop(foil, seed, tilt_deg=3.8)


def render_case(spec: dict[str, Any]) -> Image.Image:
    cid = spec["id"]
    seed = int(spec["seed"])

    if cid == "cb_01":
        tex = make_unwrapped_bottle_label(
            header_band=(24, 112, 136),
            header_text="PHARMACY DISPENSING LABEL",
            title="AMLODIPINE",
            strength_badge="5 mg",
            body_lines=["Active substance: amlodipine", "Take 1 tablet every evening"],
            expiry_text="EXP 2027-09",
        )
        return render_cylindrical_bottle_scene(seed, "amber", tex, theta_rot_deg=0.0)

    if cid == "cb_02":
        tex = make_unwrapped_bottle_label(
            header_band=(24, 112, 136),
            header_text="PHARMACY LABEL",
            title="AMLODIPINE",
            strength_badge=None,
            body_lines=["Active substance: amlodipine", "Film-coated tablets"],
            expiry_text=None,
            align_left_for_rotation=True,
        )
        return render_cylindrical_bottle_scene(seed, "amber", tex, theta_rot_deg=55.0)

    if cid == "cb_03":
        tex = make_unwrapped_bottle_label(
            header_band=(36, 82, 148),
            header_text="PHARMACY DISPENSING LABEL",
            title="AMLODIPINE",
            strength_badge="10 mg",
            body_lines=["Active substance: amlodipine", "Film-coated tablets"],
            expiry_text="EXP 2027-11",
        )
        return render_cylindrical_bottle_scene(seed, "amber", tex, theta_rot_deg=0.0)

    if cid == "cb_04":
        tex = make_unwrapped_bottle_label(
            header_band=(184, 38, 44),
            header_text="PAIN RELIEF TABLETS",
            title="IBUPROFEN",
            strength_badge="400 mg",
            body_lines=["IBUPROFEN 400 mg tablets", "Active substance: ibuprofen"],
            expiry_text="EXP 2027-10",
        )
        return render_cylindrical_bottle_scene(seed, "white", tex, theta_rot_deg=0.0)

    if cid == "cb_05":
        tex = make_unwrapped_bottle_label(
            header_band=(32, 92, 162),
            header_text="PRESCRIPTION TABLETS",
            title="METFORMIN",
            strength_badge="500 mg",
            body_lines=["Active substance: metformin", "Film-coated tablets"],
            expiry_text="EXP 2025-01",
            expiry_alert=True,
        )
        return render_cylindrical_bottle_scene(seed, "white", tex, theta_rot_deg=0.0)

    if cid == "cb_06":
        foil = create_metallic_foil_sheet(556, 436, seed)
        stamped = draw_diagonal_foil_stamps(
            foil=foil,
            main_line="AMLODIPIN 5 mg",
            sub_line="amlodipine 5 mg",
            ink_rgb=(16, 26, 48),
            angle_deg=20.0,
            rim_expiry="EXP 2027-11",
        )
        return mount_foil_on_backdrop(stamped, seed, tilt_deg=-3.5)

    if cid == "cb_07":
        foil = create_metallic_foil_sheet(556, 436, seed)
        stamped = draw_diagonal_foil_stamps(
            foil=foil,
            main_line="PANADOL 500 mg",
            sub_line="paracetamol",
            ink_rgb=(14, 44, 34),
            angle_deg=17.0,
            rim_expiry="EXP 2028-03",
        )
        return mount_foil_on_backdrop(stamped, seed, tilt_deg=4.0)

    if cid == "cb_08":
        return render_glare_blister_case(seed)

    if cid == "cb_09":
        return render_popped_torn_blister_case(seed)

    if cid == "cb_10":
        tex = make_unwrapped_bottle_label(
            header_band=(104, 54, 30),
            header_text="NORDIC PANTRY",
            title="Hazelnut Cocoa Spread",
            strength_badge=None,
            body_lines=[
                "Ingredients: sugar, hazelnuts (13%), skim milk, cocoa.",
                "Allergens: contains hazelnuts, milk.",
            ],
            expiry_text="Best before: 2027-11",
            paper_fill=(252, 248, 239),
        )
        return render_cylindrical_bottle_scene(
            seed,
            "cocoa_jar",
            tex,
            theta_rot_deg=0.0,
            label_span_deg=142.0,
            radius=210,
        )

    raise ValueError(f"Unknown case id: {cid}")


def save_jpeg_and_b64(img: Image.Image, out_path: pathlib.Path) -> tuple[str, int]:
    if img.size != (768, 768):
        raise RuntimeError(f"Expected 768x768 image for {out_path.name}, got {img.size}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii"), len(raw)


def call_gemini_flash(
    session: requests.Session,
    api_key: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }
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
            resp = session.post(url, headers=headers, json=payload, timeout=45)
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
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
                        "tokens_in": int(usage.get("promptTokenCount") or 0),
                        "tokens_out": int(
                            usage.get("candidatesTokenCount")
                            or usage.get("responseTokenCount")
                            or 0
                        ),
                        "tokens_thinking": int(usage.get("thoughtsTokenCount") or 0),
                    }
                    return scrub_node(parsed), latency_ms, tok
                last_err = "Empty structured response"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(scrub_node(last_err))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini API call failed after retries: {scrub_node(last_err)}")


def ensure_node_runtime() -> tuple[str, dict[str, str]]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

    sub_env = dict(os.environ)
    extra_bins = ["/tmp/fleet-silas/node/bin", str(pathlib.Path.home() / ".local" / "bin")]
    cur_path = sub_env.get("PATH", "")
    sub_env["PATH"] = ":".join([p for p in extra_bins if os.path.isdir(p)] + ([cur_path] if cur_path else []))

    node_bin = shutil.which("node", path=sub_env["PATH"])
    if not node_bin:
        raise RuntimeError("node binary not found on PATH")
    return node_bin, sub_env


def evaluate_with_typescript(entries: list[dict[str, Any]]) -> dict[str, Any]:
    node_bin, sub_env = ensure_node_runtime()
    ts_script = (
        'import fs from "node:fs";'
        'import { toLabelRead } from "./server/src/verify.ts";'
        'import { checkLabel, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
        'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
        'const payload = JSON.parse(fs.readFileSync(0, "utf8"));'
        "const now = new Date(payload.eval_now_iso);"
        "const items = payload.items.map((entry) => {"
        "  const read = toLabelRead(entry.raw);"
        "  const verdict = checkLabel(read, DEMO_PROFILE, now);"
        "  const strengthMatches = entry.expected_strength"
        "    ? sameStrength(read.strength.value, entry.expected_strength)"
        "    : null;"
        "  return {"
        "    read,"
        "    verdict,"
        "    strengthMatches,"
        "    strengthMinConf: STRENGTH_MIN_CONF"
        "  };"
        "});"
        "process.stdout.write(JSON.stringify({ profile: DEMO_PROFILE, items }));"
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_script],
        cwd=str(REPO_ROOT),
        env=sub_env,
        input=json.dumps({"eval_now_iso": EVAL_NOW_ISO, "items": entries}),
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript checkLabel failed ({proc.returncode}): {proc.stderr[:400]}")
    return json.loads(proc.stdout)


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


def run_benchmark(render_only: bool = False) -> dict[str, Any]:
    load_env_files()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)

    rendered_records: list[dict[str, Any]] = []
    for spec in CASE_SPECS:
        img = render_case(spec)
        img_path = OUT_IMG_DIR / f'{spec["id"]}.jpg'
        b64_jpeg, jpeg_bytes = save_jpeg_and_b64(img, img_path)
        rendered_records.append(
            {
                "spec": spec,
                "image_path": str(img_path.relative_to(REPO_ROOT)),
                "jpeg_bytes": jpeg_bytes,
                "b64_jpeg": b64_jpeg,
            }
        )

    if render_only:
        return {"rendered": len(rendered_records), "out_dir": str(OUT_IMG_DIR.relative_to(REPO_ROOT))}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    session = requests.Session()
    session.trust_env = True

    api_records: list[dict[str, Any]] = []
    for rec in rendered_records:
        spec = rec["spec"]
        raw_pred, latency_ms, tok = call_gemini_flash(
            session=session,
            api_key=api_key,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=rec["b64_jpeg"],
        )
        api_records.append(
            {
                "spec": spec,
                "image_path": rec["image_path"],
                "jpeg_bytes": rec["jpeg_bytes"],
                "raw": raw_pred,
                "latency_ms": latency_ms,
                "tokens": tok,
            }
        )

    ts_bundle = evaluate_with_typescript(
        [
            {"raw": r["raw"], "expected_strength": r["spec"]["expected_strength"]}
            for r in api_records
        ]
    )
    demo_profile = scrub_node(ts_bundle["profile"])
    ts_items = ts_bundle["items"]

    items_out: list[dict[str, Any]] = []
    for rec, ts_res in zip(api_records, ts_items):
        spec = rec["spec"]
        read_obj = scrub_node(ts_res["read"])
        verdict_full = scrub_node(ts_res["verdict"])
        min_conf = float(ts_res["strengthMinConf"])

        pred_level = str(verdict_full["level"])
        exp_level = str(spec["expected_level"])
        verdict_match = pred_level == exp_level

        s_field = read_obj.get("strength") or {}
        s_val = s_field.get("value")
        s_conf = round(float(s_field.get("confidence") or 0.0), 4)
        strength_readable = bool(spec["strength_readable"])

        if strength_readable:
            strength_correct: bool | None = bool(
                s_val is not None
                and s_conf >= min_conf
                and bool(ts_res["strengthMatches"])
            )
            confident_wrong_dose = bool(
                (s_conf >= min_conf and (s_val is None or not bool(ts_res["strengthMatches"])))
                or (exp_level != "match" and pred_level == "match")
            )
        else:
            strength_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= min_conf)
                or (exp_level != "match" and pred_level == "match")
            )

        abstained: bool | None = None
        if spec["is_occluded"]:
            abstained = bool(pred_level == "unsure" and not confident_wrong_dose)

        verdict_compact: dict[str, Any] = {
            "level": pred_level,
            "headline": verdict_full["headline"],
            "speech": verdict_full["speech"],
            "reasons": verdict_full.get("reasons") or [],
        }
        if "matchedMedId" in verdict_full:
            verdict_compact["matchedMedId"] = verdict_full["matchedMedId"]
        if "takenToday" in verdict_full:
            verdict_compact["takenToday"] = verdict_full["takenToday"]

        item_row = {
            "id": spec["id"],
            "surface": spec["surface"],
            "description": spec["description"],
            "image_path": rec["image_path"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": rec["jpeg_bytes"],
            "strength_readable": strength_readable,
            "is_occluded": bool(spec["is_occluded"]),
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "expected_strength": spec["expected_strength"],
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "latency_ms": rec["latency_ms"],
            "tokens_in": rec["tokens"]["tokens_in"],
            "tokens_out": rec["tokens"]["tokens_out"],
            "tokens_thinking": rec["tokens"]["tokens_thinking"],
            "read": read_obj,
            "verdict": verdict_compact,
        }
        items_out.append(item_row)
        print(
            f'[{spec["id"]}] exp={exp_level} pred={pred_level} match={verdict_match} '
            f"strength={s_val} (conf={s_conf:.2f}) cwd={confident_wrong_dose} ms={rec['latency_ms']:.1f}"
        )

    n_items = len(items_out)
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    readable_items = [it for it in items_out if it["strength_readable"]]
    readable_hits = sum(1 for it in readable_items if it["strength_correct"])
    occluded_items = [it for it in items_out if it["is_occluded"]]
    occluded_abstained = sum(1 for it in occluded_items if it["abstained"])
    cwd_count = sum(1 for it in items_out if it["confident_wrong_dose"])

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tokens_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tokens_thinking = sum(int(it["tokens_thinking"]) for it in items_out)

    readable_recall = round(readable_hits / len(readable_items), 4) if readable_items else 0.0
    occluded_abstention_rate = round(occluded_abstained / len(occluded_items), 4) if occluded_items else 0.0

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4) if n_items else 0.0,
        "readable_recall": readable_recall,
        "clean_field_accuracy": readable_recall,
        "occluded_abstention_rate": occluded_abstention_rate,
        "confident_wrong_dose_count": cwd_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1) if latencies else 0.0,
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = scrub_node(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": EVAL_NOW_ISO,
            "model": MODEL_NAME,
            "profile_summary": {
                "meds": [
                    f"{m['name']} {m['strength']} ({'/'.join(m['schedule'])})"
                    for m in demo_profile.get("meds", [])
                ],
                "allergies": list(demo_profile.get("allergies", [])),
                "avoid": list(demo_profile.get("avoid", [])),
            },
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_output(report)
    OUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Cylindrical pill bottle and metallic blister-pack foil glare live benchmark"
    )
    parser.add_argument("--render-only", action="store_true", help="Render 768x768 JPEGs without API calls")
    args = parser.parse_args(argv)

    res = run_benchmark(render_only=args.render_only)
    if args.render_only:
        print(json.dumps(res, indent=2))
    else:
        print(json.dumps(res["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
