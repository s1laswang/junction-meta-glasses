import base64
import datetime
import io
import json
import math
import os
import pathlib
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
PROBE_OUT_DIR = REPO_ROOT / "eval" / "out" / "model_probe"
OUT_JSON_PATH = REPO_ROOT / "eval" / "model_comparison.json"

EVAL_NOW_ISO = "2026-11-14T12:00:00Z"
PRIMARY_CANDIDATE_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash",
]

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
HASH_CHAR = chr(35)


def clean_str(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).replace(EM_DASH, " - ").replace(EN_DASH, "-")
    return " ".join(s.split())


def scrub_obj(node: Any) -> Any:
    if isinstance(node, str):
        s = node.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED_KEY]", s)
    if isinstance(node, list):
        return [scrub_obj(x) for x in node]
    if isinstance(node, dict):
        return {str(k): scrub_obj(v) for k, v in node.items()}
    return node


def load_env_fallback() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    candidates = [
        pathlib.Path.home() / "momin" / ".env",
        REPO_ROOT / ".env",
    ]
    for env_path in candidates:
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
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def ensure_node_env() -> tuple[str, dict[str, str]]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

    proc_env = dict(os.environ)
    extra_bins = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    current_path = proc_env.get("PATH", "")
    proc_env["PATH"] = ":".join(extra_bins + ([current_path] if current_path else []))

    node_bin = shutil.which("node", path=proc_env["PATH"])
    if not node_bin:
        raise RuntimeError("node executable not found in PATH")
    return node_bin, proc_env


def load_ts_config() -> dict[str, Any]:
    node_bin, proc_env = ensure_node_env()
    ts_code = (
        'import { env } from "./server/src/env.ts";'
        'import { STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
        'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
        "process.stdout.write(JSON.stringify({"
        "verifyModels: env.verifyModels,"
        "strengthMinConf: STRENGTH_MIN_CONF,"
        "profile: DEMO_PROFILE"
        "}));"
    )
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        cwd=str(REPO_ROOT),
        env=proc_env,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def evaluate_batch_with_ts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node_bin, proc_env = ensure_node_env()
    ts_code = (
        'import fs from "node:fs";'
        'import { toLabelRead } from "./server/src/verify.ts";'
        'import { allergenHits, avoidHits, checkLabel, matchMed, norm, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";'
        'import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";'
        'const payload = JSON.parse(fs.readFileSync(0, "utf8"));'
        "const now = new Date(payload.eval_now_iso);"
        "const out = payload.items.map((it) => {"
        "  const read = toLabelRead(it.raw_json);"
        "  const verdict = checkLabel(read, DEMO_PROFILE, now);"
        "  const strengthSame = it.expected_strength ? sameStrength(read.strength.value, it.expected_strength) : null;"
        "  const matchedMed = matchMed(read, DEMO_PROFILE.meds) ?? null;"
        "  const allergy = allergenHits(read, DEMO_PROFILE.allergies);"
        "  const avoid = avoidHits(read, DEMO_PROFILE.avoid);"
        "  return {"
        "    read,"
        "    verdict,"
        "    strength_same: strengthSame,"
        "    matched_med_id: matchedMed ? matchedMed.id : null,"
        "    allergy_hits: allergy,"
        "    avoid_hits: avoid,"
        "    norm_product: norm(read.product.value),"
        "    norm_ingredient: norm(read.ingredient.value),"
        "    strength_min_conf: STRENGTH_MIN_CONF"
        "  };"
        "});"
        "process.stdout.write(JSON.stringify(out));"
    )
    stdin_text = json.dumps({"eval_now_iso": EVAL_NOW_ISO, "items": items})
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=stdin_text,
        cwd=str(REPO_ROOT),
        env=proc_env,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


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
        cleaned: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            cleaned[k] = inline_schema_refs(v, defs)
        return cleaned
    return node


def percentile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
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


def render_table_backdrop(size: int = 768) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (226, 220, 210))
    draw = ImageDraw.Draw(canvas)
    table_y = 536
    for y in range(table_y):
        t = y / max(1, table_y)
        r = int(236 - 22 * t)
        g = int(230 - 22 * t)
        b = int(220 - 20 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(table_y, size):
        t = (y - table_y) / max(1, size - table_y)
        r = int(184 - 24 * t)
        g = int(154 - 22 * t)
        b = int(122 - 18 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, table_y, size, table_y), fill=(138, 108, 80), width=3)
    return canvas


def draw_wrapped_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: int,
    y: int,
    max_width: int,
    font_size: int,
    fill: tuple[int, int, int],
    line_gap: int = 7,
) -> int:
    font = ImageFont.load_default(size=font_size)
    words = text.split(" ")
    lines: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}".strip() if cur else w
        if draw.textlength(cand, font=font) <= max_width or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    cy = y
    for ln in lines:
        draw.text((x, cy), ln, fill=fill, font=font)
        cy += font_size + line_gap
    return cy


def add_carton_shell(
    base: Image.Image,
    accent: tuple[int, int, int],
    header_text: str,
    box_coords: tuple[int, int, int, int] = (92, 136, 676, 600),
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    x0, y0, x1, y1 = box_coords
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 18), radius=18, fill=(28, 22, 18, 92))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12.0))
    comp = Image.alpha_composite(base.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(comp)
    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(176, 182, 190), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=accent)
    draw.rectangle((x0, y0 + 34, x1, y0 + 62), fill=accent)
    if header_text:
        draw.text((x0 + 28, y0 + 17), header_text, fill=(248, 250, 252), font=ImageFont.load_default(size=24))
    return comp, box_coords


def render_med_card(
    header: str,
    title: str,
    subtitle: str,
    strength_text: str | None,
    form_line: str,
    pack_line: str,
    expiry_line: str,
    accent: tuple[int, int, int],
) -> tuple[Image.Image, tuple[int, int, int, int], tuple[int, int, int, int]]:
    canvas = render_table_backdrop(768)
    canvas, (x0, y0, x1, y1) = add_carton_shell(canvas, accent, header)
    draw = ImageDraw.Draw(canvas)

    draw.text((x0 + 28, y0 + 84), title, fill=(16, 22, 30), font=ImageFont.load_default(size=46))
    draw.text((x0 + 28, y0 + 146), subtitle, fill=(52, 60, 72), font=ImageFont.load_default(size=23))

    sx0, sy0, sx1, sy1 = x0 + 28, y0 + 196, x0 + 278, y0 + 282
    if strength_text is not None:
        draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=accent, width=2)
        draw.text((sx0 + 20, sy0 + 16), strength_text, fill=(14, 20, 28), font=ImageFont.load_default(size=44))
    else:
        draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(238, 240, 243), outline=(210, 214, 220), width=1)

    if form_line:
        draw.text((sx1 + 20, sy0 + 28), form_line, fill=(48, 56, 68), font=ImageFont.load_default(size=23))
    if pack_line:
        draw.text((x0 + 28, y0 + 314), pack_line, fill=(52, 60, 70), font=ImageFont.load_default(size=24))
    if expiry_line:
        draw.text((x0 + 28, y0 + 362), expiry_line, fill=(38, 46, 56), font=ImageFont.load_default(size=24))

    bx0, by0 = x1 - 178, y0 + 318
    draw.rectangle((bx0, by0, x1 - 28, y0 + 404), fill=(255, 255, 255), outline=(208, 212, 218), width=1)
    for i in range(28):
        bx = bx0 + 12 + i * 4
        bw = 3 if i % 5 == 0 else (2 if i % 2 == 0 else 1)
        draw.rectangle((bx, by0 + 10, bx + bw, by0 + 74), fill=(26, 28, 32))

    return canvas, (x0, y0, x1, y1), (sx0, sy0, sx1, sy1)


def render_food_card(
    header: str,
    title: str,
    subtitle: str,
    panel_lines: list[str] | None,
    footer_line: str,
    accent: tuple[int, int, int],
    front_only_art: bool = False,
) -> Image.Image:
    canvas = render_table_backdrop(768)
    canvas, (x0, y0, x1, y1) = add_carton_shell(canvas, accent, header)
    draw = ImageDraw.Draw(canvas)

    draw.text((x0 + 28, y0 + 82), title, fill=(20, 24, 30), font=ImageFont.load_default(size=42))
    draw.text((x0 + 28, y0 + 140), subtitle, fill=(66, 72, 82), font=ImageFont.load_default(size=22))

    if panel_lines is not None:
        px0, py0, px1, py1 = x0 + 26, y0 + 186, x1 - 26, y0 + 368
        draw.rounded_rectangle((px0, py0, px1, py1), radius=10, fill=(246, 248, 250), outline=(188, 194, 202), width=2)
        cy = py0 + 18
        for pline in panel_lines:
            cy = draw_wrapped_text(draw, pline, px0 + 18, cy, (px1 - px0) - 36, 23, (22, 28, 36), line_gap=8)
            cy += 6
    elif front_only_art:
        cx, cy = (x0 + x1) // 2, y0 + 278
        for ox, oy, rad in [(-54, -8, 52), (48, 4, 50), (-4, 26, 48)]:
            draw.ellipse(
                (cx + ox - rad, cy + oy - rad, cx + ox + rad, cy + oy + rad),
                fill=(228, 186, 112),
                outline=(184, 138, 66),
                width=3,
            )
            for dx, dy in [(-16, -12), (12, -8), (-6, 14), (16, 12)]:
                draw.ellipse(
                    (cx + ox + dx - 3, cy + oy + dy - 3, cx + ox + dx + 3, cy + oy + dy + 3),
                    fill=(164, 118, 52),
                )

    if footer_line:
        draw.text((x0 + 28, y0 + 398), footer_line, fill=(44, 52, 62), font=ImageFont.load_default(size=22))

    return canvas


def build_probe_cards() -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []

    img1, _, _ = render_med_card(
        header="ORION PHARMA",
        title="AMLODIPINE",
        subtitle="Active substance: amlodipine",
        strength_text="5 mg",
        form_line="film-coated tablets",
        pack_line="30 tablets",
        expiry_line="EXP 2027-08",
        accent=(22, 114, 138),
    )
    specs.append(
        {
            "id": "01_clean_en_amlodipine_5mg",
            "index": 1,
            "label": "AMLODIPINE 5 mg / 30 tablets / EXP 2027-08",
            "category": "clean_med",
            "expected_verdict": "match",
            "expected_kind": "medication",
            "expected_ingredient": "amlodipine",
            "expected_strength": "5 mg",
            "expected_expiry": "2027-08",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": True,
            "strength_readable": True,
            "image": img1,
        }
    )

    img2, _, _ = render_med_card(
        header="ORION PHARMA",
        title="AMLODIPINE",
        subtitle="Active substance: amlodipine",
        strength_text="10 mg",
        form_line="film-coated tablets",
        pack_line="30 tablets",
        expiry_line="EXP 2027-08",
        accent=(38, 84, 148),
    )
    specs.append(
        {
            "id": "02_wrong_strength_amlodipine_10mg",
            "index": 2,
            "label": "AMLODIPINE 10 mg / 30 tablets / EXP 2027-08",
            "category": "clean_med_wrong_strength",
            "expected_verdict": "warning",
            "expected_kind": "medication",
            "expected_ingredient": "amlodipine",
            "expected_strength": "10 mg",
            "expected_expiry": "2027-08",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": True,
            "strength_readable": True,
            "image": img2,
        }
    )

    img3, _, _ = render_med_card(
        header="ORION PHARMA",
        title="BURANA",
        subtitle="Vaikuttava aine: ibuprofeeni",
        strength_text="400 mg",
        form_line="tabletti",
        pack_line="30 tablettia",
        expiry_line="EXP 2027-09",
        accent=(188, 36, 46),
    )
    specs.append(
        {
            "id": "03_clean_fi_burana_400mg",
            "index": 3,
            "label": "BURANA 400 mg / ibuprofeeni / 30 tablettia / EXP 2027-09",
            "category": "clean_med_fi_avoid",
            "expected_verdict": "warning",
            "expected_kind": "medication",
            "expected_ingredient": "ibuprofen",
            "expected_strength": "400 mg",
            "expected_expiry": "2027-09",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": True,
            "strength_readable": True,
            "image": img3,
        }
    )

    img4, _, _ = render_med_card(
        header="SANDOZ",
        title="METFORMIN",
        subtitle="Active substance: metformin",
        strength_text="500 mg",
        form_line="film-coated tablets",
        pack_line="100 tablets",
        expiry_line="EXP 2025-03",
        accent=(34, 88, 168),
    )
    specs.append(
        {
            "id": "04_expired_metformin_500mg",
            "index": 4,
            "label": "METFORMIN 500 mg / EXP 2025-03",
            "category": "clean_med_expired",
            "expected_verdict": "warning",
            "expected_kind": "medication",
            "expected_ingredient": "metformin",
            "expected_strength": "500 mg",
            "expected_expiry": "2025-03",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": True,
            "strength_readable": True,
            "image": img4,
        }
    )

    img5_base, _, (sx0, sy0, sx1, sy1) = render_med_card(
        header="ORION PHARMA",
        title="AMLODIPINE",
        subtitle="Active substance: amlodipine",
        strength_text=None,
        form_line="film-coated tablets",
        pack_line="30 tablets",
        expiry_line="EXP 2027-08",
        accent=(22, 114, 138),
    )
    rgba5 = img5_base.convert("RGBA")
    shadow5 = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    sd5 = ImageDraw.Draw(shadow5)
    sd5.rounded_rectangle((-30, sy0 - 18, sx1 + 52, sy1 + 26), radius=58, fill=(24, 18, 14, 165))
    shadow5 = shadow5.filter(ImageFilter.GaussianBlur(radius=12.0))
    rgba5 = Image.alpha_composite(rgba5, shadow5)
    thumb5 = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    td5 = ImageDraw.Draw(thumb5)
    td5.rounded_rectangle((-45, sy0 - 10, sx1 + 36, sy1 + 14), radius=52, fill=(208, 162, 136, 255), outline=(168, 122, 98, 255), width=3)
    td5.rounded_rectangle((sx1 - 44, sy0 + 4, sx1 + 24, sy1 - 4), radius=22, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
    thumb5 = thumb5.filter(ImageFilter.GaussianBlur(radius=0.8))
    img5 = Image.alpha_composite(rgba5, thumb5).convert("RGB")
    specs.append(
        {
            "id": "05_occluded_thumb_amlodipine",
            "index": 5,
            "label": "AMLODIPINE with thumb patch over strength",
            "category": "occluded_med_thumb",
            "expected_verdict": "unsure",
            "expected_kind": "medication",
            "expected_ingredient": "amlodipine",
            "expected_strength": None,
            "expected_expiry": "2027-08",
            "is_clean": False,
            "is_occluded": True,
            "is_medication": True,
            "strength_readable": False,
            "image": img5,
        }
    )

    img6_base, (x0_6, y0_6, x1_6, y1_6), (sx0_6, sy0_6, sx1_6, sy1_6) = render_med_card(
        header="SANDOZ",
        title="METFORMIN",
        subtitle="Active substance: metformin",
        strength_text=None,
        form_line="film-coated tablets",
        pack_line="100 tablets",
        expiry_line="EXP 2027-10",
        accent=(34, 88, 168),
    )
    draw6 = ImageDraw.Draw(img6_base)
    for bar_i in range(5):
        bx = sx0_6 + 24 + bar_i * 34
        draw6.rounded_rectangle((bx, sy0_6 + 28, bx + 20, sy0_6 + 56), radius=4, fill=(142, 148, 156))
    blurred_full6 = img6_base.filter(ImageFilter.GaussianBlur(radius=12.0))
    mask6 = Image.new("L", (768, 768), 0)
    md6 = ImageDraw.Draw(mask6)
    md6.rectangle((x0_6 - 12, sy0_6 - 16, x1_6 + 12, y1_6 + 12), fill=255)
    mask6 = mask6.filter(ImageFilter.GaussianBlur(radius=8.0))
    img6 = Image.composite(blurred_full6, img6_base, mask6)
    specs.append(
        {
            "id": "06_occluded_blur_metformin",
            "index": 6,
            "label": "METFORMIN with GaussianBlur(12) over lower strength area",
            "category": "occluded_med_blur",
            "expected_verdict": "unsure",
            "expected_kind": "medication",
            "expected_ingredient": "metformin",
            "expected_strength": None,
            "expected_expiry": None,
            "is_clean": False,
            "is_occluded": True,
            "is_medication": True,
            "strength_readable": False,
            "image": img6,
        }
    )

    img7_base, _, (sx0_7, sy0_7, sx1_7, sy1_7) = render_med_card(
        header="GSK HEALTHCARE",
        title="PANADOL",
        subtitle="Active substance: paracetamol",
        strength_text=None,
        form_line="film-coated tablets",
        pack_line="20 tablets",
        expiry_line="EXP 2028-02",
        accent=(24, 128, 84),
    )
    glare7 = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    gd7 = ImageDraw.Draw(glare7)
    gd7.polygon([(sx0_7 - 30, sy0_7 - 80), (sx1_7 + 110, sy0_7 - 80), (sx1_7 + 150, sy1_7 + 70), (sx0_7 - 60, sy1_7 + 70)], fill=(255, 255, 248, 165))
    gd7.ellipse((sx0_7 - 36, sy0_7 - 28, sx1_7 + 84, sy1_7 + 34), fill=(255, 255, 255, 255))
    glare7 = glare7.filter(ImageFilter.GaussianBlur(radius=16.0))
    core7 = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    cd7 = ImageDraw.Draw(core7)
    cd7.rounded_rectangle((sx0_7 - 12, sy0_7 - 10, sx1_7 + 30, sy1_7 + 12), radius=18, fill=(255, 255, 255, 255))
    core7 = core7.filter(ImageFilter.GaussianBlur(radius=4.0))
    img7 = Image.alpha_composite(Image.alpha_composite(img7_base.convert("RGBA"), glare7), core7).convert("RGB")
    specs.append(
        {
            "id": "07_glare_strength_panadol",
            "index": 7,
            "label": "PANADOL with white glare wash over strength",
            "category": "occluded_med_glare",
            "expected_verdict": "unsure",
            "expected_kind": "medication",
            "expected_ingredient": "paracetamol",
            "expected_strength": None,
            "expected_expiry": "2028-02",
            "is_clean": False,
            "is_occluded": True,
            "is_medication": True,
            "strength_readable": False,
            "image": img7,
        }
    )

    img8 = render_food_card(
        header="NORDIC PANTRY",
        title="Chocolate Spread",
        subtitle="Smooth cocoa spread",
        panel_lines=[
            "Ingredients: sugar, cocoa, arachis oil, lecithin.",
        ],
        footer_line="Net wt 350 g          Best before 2027-11",
        accent=(108, 62, 38),
    )
    specs.append(
        {
            "id": "08_food_synonym_chocolate_spread",
            "index": 8,
            "label": "Chocolate Spread / Ingredients: sugar, cocoa, arachis oil, lecithin",
            "category": "clean_food_allergen_synonym",
            "expected_verdict": "warning",
            "expected_kind": "food",
            "expected_product": "chocolate spread",
            "expected_allergen_type": "peanut",
            "expected_strength": None,
            "expected_expiry": "2027-11",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": False,
            "strength_readable": None,
            "image": img8,
        }
    )

    img9 = render_food_card(
        header="SUOMEN LEIPOMO",
        title="Kaurakeksi",
        subtitle="Rapea kaurakeksi",
        panel_lines=[
            "Ainesosat: kaura, sokeri.",
            "Voi sisaltaa hasselpahkinaa.",
        ],
        footer_line="200 g          Parasta ennen 2027-10",
        accent=(176, 112, 34),
    )
    specs.append(
        {
            "id": "09_fi_allergen_trace_kaurakeksi",
            "index": 9,
            "label": "Kaurakeksi / Ainesosat: kaura, sokeri. Voi sisaltaa hasselpahkinaa.",
            "category": "clean_food_fi_trace",
            "expected_verdict": "warning",
            "expected_kind": "food",
            "expected_product": "kaurakeksi",
            "expected_allergen_type": "tree nuts",
            "expected_strength": None,
            "expected_expiry": "2027-10",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": False,
            "strength_readable": None,
            "image": img9,
        }
    )

    img10 = render_food_card(
        header="NORDIC HARVEST",
        title="Oat Drink",
        subtitle="Plant-based oat drink",
        panel_lines=[
            "Ingredients: water, oats 10%, rapeseed oil, salt.",
            "Allergens: contains oats (gluten).",
        ],
        footer_line="1 L          Best before 2027-12",
        accent=(42, 118, 166),
    )
    specs.append(
        {
            "id": "10_safe_food_oat_drink",
            "index": 10,
            "label": "Oat Drink / Ingredients: water, oats 10%, rapeseed oil, salt. Best before 2027-12",
            "category": "clean_food_safe",
            "expected_verdict": "info",
            "expected_kind": "food",
            "expected_product": "oat drink",
            "expected_allergen_type": "none_matching",
            "expected_strength": None,
            "expected_expiry": "2027-12",
            "is_clean": True,
            "is_occluded": False,
            "is_medication": False,
            "strength_readable": None,
            "image": img10,
        }
    )

    img11 = render_food_card(
        header="ROYAL BAKERY",
        title="Butter Cookies",
        subtitle="Traditional crisp biscuits",
        panel_lines=None,
        footer_line="Net weight 250 g",
        accent=(168, 118, 44),
        front_only_art=True,
    )
    specs.append(
        {
            "id": "11_unreadable_allergens_butter_cookies",
            "index": 11,
            "label": "Butter Cookies front of pack with no ingredients",
            "category": "occluded_food_missing_panel",
            "expected_verdict": "unsure",
            "expected_kind": "food",
            "expected_product": "butter cookies",
            "expected_allergen_type": None,
            "expected_strength": None,
            "expected_expiry": None,
            "is_clean": False,
            "is_occluded": True,
            "is_medication": False,
            "strength_readable": None,
            "image": img11,
        }
    )

    img12_base = render_table_backdrop(768)
    d12 = ImageDraw.Draw(img12_base)
    d12.rounded_rectangle((170, 190, 590, 540), radius=24, fill=(238, 236, 232), outline=(196, 194, 190), width=2)
    d12.rectangle((170, 190, 590, 244), fill=(112, 134, 152))
    d12.rectangle((210, 290, 470, 326), fill=(168, 172, 178))
    d12.rectangle((210, 356, 390, 386), fill=(184, 188, 192))
    img12 = img12_base.filter(ImageFilter.GaussianBlur(radius=28.0))
    specs.append(
        {
            "id": "12_blurred_unreadable_frame",
            "index": 12,
            "label": "Completely blurred unreadable frame",
            "category": "occluded_frame_blur",
            "expected_verdict": "unsure",
            "expected_kind": "unreadable",
            "expected_strength": None,
            "expected_expiry": None,
            "is_clean": False,
            "is_occluded": True,
            "is_medication": False,
            "strength_readable": False,
            "image": img12,
        }
    )

    return specs


def save_card_jpeg_b64(img: Image.Image, path: pathlib.Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    path.write_bytes(raw)
    return base64.b64encode(raw).decode("ascii")


def call_gemini_verify(
    session: requests.Session,
    api_key: str,
    model: str,
    verify_prompt: str,
    label_schema: dict[str, Any],
    b64_jpeg: str,
) -> dict[str, Any]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
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
    last_status: int | None = None
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            resp = session.post(url, headers=headers, json=payload, timeout=45)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            last_status = resp.status_code

            if resp.status_code == 404:
                err_msg = resp.text[:300]
                try:
                    err_msg = resp.json().get("error", {}).get("message") or err_msg
                except ValueError:
                    pass
                return {
                    "ok": False,
                    "status_code": 404,
                    "error_kind": "not_found",
                    "error": clean_str(scrub_obj(err_msg)),
                    "latency_ms": round(elapsed_ms, 1),
                }

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
                    tokens_in = int(usage.get("promptTokenCount") or 0)
                    tokens_out = int(usage.get("candidatesTokenCount") or usage.get("responseTokenCount") or 0)
                    tokens_thinking = int(usage.get("thoughtsTokenCount") or 0)
                    return {
                        "ok": True,
                        "status_code": 200,
                        "raw_json": scrub_obj(parsed),
                        "latency_ms": round(elapsed_ms, 1),
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "tokens_thinking": tokens_thinking,
                    }
                last_err = "Empty non-thought JSON output"
                time.sleep(0.8 * (attempt + 1))
                continue

            last_err = f"HTTP {resp.status_code}: {resp.text[:240]}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            return {
                "ok": False,
                "status_code": resp.status_code,
                "error_kind": "bad_request" if resp.status_code == 400 else "http_error",
                "error": clean_str(scrub_obj(last_err)),
                "latency_ms": round(elapsed_ms, 1),
            }
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_err = str(exc)
            time.sleep(1.2 * (2 ** attempt))

    return {
        "ok": False,
        "status_code": last_status,
        "error_kind": "retry_exhausted",
        "error": clean_str(scrub_obj(last_err)),
        "latency_ms": None,
    }


def score_clean_fields(card: dict[str, Any], ts_eval: dict[str, Any]) -> tuple[int, int, dict[str, bool]]:
    read = ts_eval["read"]
    checks: dict[str, bool] = {}
    if not card["is_clean"]:
        return 0, 0, checks

    if card["is_medication"]:
        checks["kind"] = read["kind"] == "medication"
        want_ing = card["expected_ingredient"]
        norm_ing = ts_eval["norm_ingredient"]
        norm_prod = ts_eval["norm_product"]
        if want_ing == "ibuprofen":
            checks["ingredient"] = ("ibuprofen" in norm_ing) or ("ibuprofeeni" in norm_ing) or ("burana" in norm_prod)
        else:
            checks["ingredient"] = (want_ing in norm_ing) or (want_ing in norm_prod)
        checks["strength"] = bool(
            ts_eval["strength_same"]
            and read["strength"]["value"] is not None
            and float(read["strength"]["confidence"]) >= float(ts_eval["strength_min_conf"])
        )
        checks["expiry"] = read["expiry"]["value"] == card["expected_expiry"]
    else:
        checks["kind"] = read["kind"] == "food"
        checks["product"] = card["expected_product"] in ts_eval["norm_product"]
        allergy_hits = ts_eval["allergy_hits"]
        want_allergy = card["expected_allergen_type"]
        if want_allergy == "peanut":
            checks["allergens"] = any(h.get("allergy") == "peanut" for h in allergy_hits)
        elif want_allergy == "tree nuts":
            checks["allergens"] = any(h.get("allergy") == "tree nuts" for h in allergy_hits)
        else:
            checks["allergens"] = (
                read["allergens"]["value"] is not None
                and float(read["allergens"]["confidence"]) >= 0.60
                and len(allergy_hits) == 0
            )
            checks["expiry"] = read["expiry"]["value"] == card["expected_expiry"]

    passed = sum(1 for ok in checks.values() if ok)
    return passed, len(checks), checks


def is_confident_wrong_dose(card: dict[str, Any], ts_eval: dict[str, Any]) -> bool:
    read = ts_eval["read"]
    verdict_level = ts_eval["verdict"]["level"]
    s_val = read["strength"]["value"]
    s_conf = float(read["strength"]["confidence"])
    min_conf = float(ts_eval["strength_min_conf"])

    if card["strength_readable"] is True:
        if s_conf >= min_conf and (not s_val or not ts_eval["strength_same"]):
            return True
        if card["expected_verdict"] != "match" and verdict_level == "match":
            return True
        return False

    if card["strength_readable"] is False:
        if s_val is not None and s_conf >= min_conf:
            return True
        if verdict_level == "match":
            return True
        return False

    return False


def main() -> int:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in environment")

    ts_cfg = load_ts_config()
    env_verify_models: list[str] = list(ts_cfg["verifyModels"])
    strength_min_conf = float(ts_cfg["strengthMinConf"])

    verify_prompt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    label_schema = inline_schema_refs(raw_schema)

    PROBE_OUT_DIR.mkdir(parents=True, exist_ok=True)
    cards = build_probe_cards()
    for card in cards:
        img_path = PROBE_OUT_DIR / f'{card["id"]}.jpg'
        card["b64_jpeg"] = save_card_jpeg_b64(card["image"], img_path)
        card["image_path"] = str(img_path.relative_to(REPO_ROOT))
        del card["image"]

    session = requests.Session()
    candidate_queue = list(PRIMARY_CANDIDATE_MODELS)
    for fallback_m in env_verify_models:
        if fallback_m not in candidate_queue:
            candidate_queue.append(fallback_m)

    active_models: list[str] = []
    unavailable_models: dict[str, Any] = {}
    raw_calls_by_model: dict[str, list[dict[str, Any]]] = {}

    for model in candidate_queue:
        if len(active_models) >= 3:
            break
        first_res = call_gemini_verify(
            session=session,
            api_key=api_key,
            model=model,
            verify_prompt=verify_prompt,
            label_schema=label_schema,
            b64_jpeg=cards[0]["b64_jpeg"],
        )
        if not first_res["ok"] and first_res.get("status_code") == 404:
            replacement = next(
                (m for m in env_verify_models if m not in PRIMARY_CANDIDATE_MODELS and m not in active_models),
                None,
            )
            unavailable_models[model] = {
                "available": False,
                "status_code": 404,
                "error_kind": first_res.get("error_kind", "not_found"),
                "error": first_res.get("error", ""),
                "probe_latency_ms": first_res.get("latency_ms"),
                "replaced_by": replacement,
            }
            print(f"[{model}] HTTP 404 unavailable -> recorded and falling back to {replacement}")
            continue

        active_models.append(model)
        model_calls = [first_res]
        print(
            f'[{model}] [{cards[0]["id"]}] ok={first_res["ok"]} '
            f'ms={first_res.get("latency_ms")} '
            f'in={first_res.get("tokens_in")} out={first_res.get("tokens_out")} '
            f'think={first_res.get("tokens_thinking")}'
        )
        for card in cards[1:]:
            res = call_gemini_verify(
                session=session,
                api_key=api_key,
                model=model,
                verify_prompt=verify_prompt,
                label_schema=label_schema,
                b64_jpeg=card["b64_jpeg"],
            )
            model_calls.append(res)
            print(
                f'[{model}] [{card["id"]}] ok={res["ok"]} '
                f'ms={res.get("latency_ms")} '
                f'in={res.get("tokens_in")} out={res.get("tokens_out")} '
                f'think={res.get("tokens_thinking")}'
            )
        raw_calls_by_model[model] = model_calls

    models_summary: dict[str, Any] = {}
    per_model_items: dict[str, list[dict[str, Any]]] = {}

    for model in active_models:
        calls = raw_calls_by_model[model]
        ts_inputs = [
            {
                "raw_json": c["raw_json"] if c["ok"] else None,
                "expected_strength": cards[idx]["expected_strength"],
            }
            for idx, c in enumerate(calls)
        ]
        ts_outputs = evaluate_batch_with_ts(ts_inputs)

        verdict_matches = 0
        clean_fields_ok = 0
        clean_fields_total = 0
        occluded_abstained = 0
        occluded_total = 0
        occluded_dose_abstained = 0
        occluded_dose_total = 0
        cwd_count = 0

        latencies: list[float] = []
        toks_in: list[int] = []
        toks_out: list[int] = []
        toks_think: list[int] = []
        card_rows: list[dict[str, Any]] = []

        for idx, card in enumerate(cards):
            call_res = calls[idx]
            ts_eval = ts_outputs[idx]
            read = scrub_obj(ts_eval["read"])
            verdict = scrub_obj(ts_eval["verdict"])

            pred_level = verdict["level"] if call_res["ok"] else "unsure"
            verdict_ok = pred_level == card["expected_verdict"]
            if verdict_ok:
                verdict_matches += 1

            cf_ok, cf_tot, cf_detail = score_clean_fields(card, ts_eval)
            clean_fields_ok += cf_ok
            clean_fields_total += cf_tot

            abstained_here: bool | None = None
            if card["is_occluded"]:
                occluded_total += 1
                abstained_here = pred_level == "unsure"
                if abstained_here:
                    occluded_abstained += 1

            if card["strength_readable"] is False:
                occluded_dose_total += 1
                if pred_level == "unsure" and not (
                    read["strength"]["value"] is not None
                    and float(read["strength"]["confidence"]) >= strength_min_conf
                ):
                    occluded_dose_abstained += 1

            cwd_here = is_confident_wrong_dose(card, ts_eval)
            if cwd_here:
                cwd_count += 1

            if call_res.get("latency_ms") is not None:
                latencies.append(float(call_res["latency_ms"]))
            if call_res["ok"]:
                toks_in.append(int(call_res["tokens_in"]))
                toks_out.append(int(call_res["tokens_out"]))
                toks_think.append(int(call_res["tokens_thinking"]))

            card_rows.append(
                {
                    "id": card["id"],
                    "index": card["index"],
                    "label": card["label"],
                    "category": card["category"],
                    "image_path": card["image_path"],
                    "expected_verdict": card["expected_verdict"],
                    "predicted_verdict": pred_level,
                    "verdict_match": verdict_ok,
                    "headline": clean_str(verdict.get("headline")),
                    "speech": clean_str(verdict.get("speech")),
                    "reasons": [clean_str(r) for r in verdict.get("reasons", [])],
                    "strength_readable": card["strength_readable"],
                    "strength_value": read["strength"]["value"],
                    "strength_confidence": round(float(read["strength"]["confidence"]), 4),
                    "clean_field_checks": cf_detail,
                    "abstained": abstained_here,
                    "confident_wrong_dose": cwd_here,
                    "latency_ms": call_res.get("latency_ms"),
                    "tokens_in": call_res.get("tokens_in"),
                    "tokens_out": call_res.get("tokens_out"),
                    "tokens_thinking": call_res.get("tokens_thinking"),
                    "read": read,
                }
            )

        n_cards = len(cards)
        models_summary[model] = {
            "n_cards": n_cards,
            "calls_succeeded": sum(1 for c in calls if c["ok"]),
            "verdict_matches": verdict_matches,
            "verdict_accuracy": round(verdict_matches / n_cards, 4),
            "clean_fields_matched": clean_fields_ok,
            "clean_fields_total": clean_fields_total,
            "clean_field_accuracy": round(clean_fields_ok / clean_fields_total, 4) if clean_fields_total else 0.0,
            "confident_wrong_dose_count": cwd_count,
            "occluded_abstained": occluded_abstained,
            "occluded_total": occluded_total,
            "occluded_abstention_rate": round(occluded_abstained / occluded_total, 4) if occluded_total else 0.0,
            "occluded_dose_abstention_rate": round(occluded_dose_abstained / occluded_dose_total, 4) if occluded_dose_total else 0.0,
            "latency_p50_ms": percentile(latencies, 0.50),
            "latency_p95_ms": percentile(latencies, 0.95),
            "latency_mean_ms": round(statistics.mean(latencies), 1) if latencies else None,
            "mean_tokens_in": round(statistics.mean(toks_in), 1) if toks_in else None,
            "mean_tokens_out": round(statistics.mean(toks_out), 1) if toks_out else None,
            "mean_tokens_thinking": round(statistics.mean(toks_think), 1) if toks_think else None,
        }
        per_model_items[model] = card_rows

    card_manifest = [
        {
            "id": c["id"],
            "index": c["index"],
            "label": c["label"],
            "category": c["category"],
            "expected_verdict": c["expected_verdict"],
            "is_clean": c["is_clean"],
            "is_occluded": c["is_occluded"],
            "strength_readable": c["strength_readable"],
            "image_path": c["image_path"],
        }
        for c in cards
    ]

    report = scrub_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": EVAL_NOW_ISO,
            "strength_min_conf": strength_min_conf,
            "env_verify_models": env_verify_models,
            "benchmarked_models": active_models,
            "unavailable_models": unavailable_models,
            "n_cards": len(cards),
            "total_benchmark_calls": sum(len(v) for v in raw_calls_by_model.values()),
            "total_api_requests_including_probes": sum(len(v) for v in raw_calls_by_model.values()) + len(unavailable_models),
            "models": models_summary,
            "cards": card_manifest,
            "results_by_model": per_model_items,
        }
    )

    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if EM_DASH in serialized or EN_DASH in serialized:
        raise RuntimeError("Forbidden dash character detected in output JSON")
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print(f"Wrote {OUT_JSON_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
