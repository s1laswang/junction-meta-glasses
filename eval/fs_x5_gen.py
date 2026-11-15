"""Meta WS5: FieldSpotter Data x5 generator (8,000 box-labelled first-person images in YOLO format).

Matches eval/make_yolo.py's exact YOLO layout and class order:
  0: product
  1: strength
  2: expiry
  3: allergens

Focus conditions:
  - clean_glasses_pov      : eye-level smart-glasses first-person view
  - glasses_pov_wide_tilt  : wide-FOV glasses perspective + head tilt with exact 2D affine box projection
  - thumb_over_dose_full   : thumb/finger occluding >=85% of the strength box (strength box suppressed -> teaches 'covered')
  - thumb_over_dose_part   : thumb/finger occluding ~38% of strength or gripping pack edge (clipped visible box)
  - motion_blur            : head-turn / hand-tremor directional blur + blur_status gating
  - partial_view           : off-frame edge crops (top/bottom/left/right) with exact cropped-window box reprojection
  - glare_and_lowlight     : overhead specular glare on label & dim indoor lighting
  - multiple_boxes         : 2-box and 3-box tabletop/two-hand scenes with all packs' boxes projected (strictly split-isolated!)
  - back_of_box            : barcode/manufacturer reverse views (0 foreground boxes -> hard negatives)

Zero direct gemini-4-carbon API calls: specs & box_2d checks load-balance across gemini-4-hydrogen and gemini-4-argon;
renders use gemini-3.1-flash-image. Writes all binaries outside git to ~/carbon/out/fieldspotter-x5/ and checkpoints
manifest.json + checksums.sha256 every ~1,000 images.
"""
from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import io
import json
import math
import os
import random
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
sys.path.insert(0, str(EVAL_DIR))

import common as C  # noqa: E402
import degrade as DEG  # noqa: E402
import gen_images as GI  # noqa: E402
from gen_specs import CANON_ALLERGENS, SPEC_SCHEMA  # noqa: E402

CLASSES = ["product", "strength", "expiry", "allergens"]
AUDIT_MODELS = ["gemini-4-hydrogen", "gemini-4-argon"]
IMG_SIZE = 640

WS5_MED_THEMES = [
    "Finnish pharmacy cartons (Orion, Ratiopharm, Sandoz, Krka, Teva) held at smart-glasses eye level: antihypertensives, statins, diabetes, thyroid, anticoagulants; clear strength and Käyt. viim. expiry",
    "Blister strips (läpipainopakkaus / blisterkarta) and unit-dose pouches (annosjakelupussi): silver/white foil and tear sachets with clear printed product, strength, and expiry",
    "Cylindrical pill bottles, oral solution bottles (mg/ml), eye-dropper bottles (silmätipat), topical tubes (mg/g, %), and Nordic inhalers (Easyhaler, Turbuhaler, mikrog/annos)",
    "Insulin pens and cartons (100 IU/ml, 100 KY/ml, 200 IU/ml), OTC painkillers (Burana, Panadol, Ibumax, Primaspan), antibiotics (Amorion, V-Pen), and vitamin bottles (Devisol, B12)",
]
WS5_FOOD_THEMES = [
    "Finnish and Swedish grocery packages (Fazer, Valio, Pirkka, Oatly, Coop, Paulig, Atria) held to show bold product title, ingredients/allergen panel, and Parasta ennen / Bäst före date",
    "Plant-based drinks, protein bars, muesli, pestos, nut spreads, sauces, biscuits, and ready meals with bold allergen declarations and 'Saattaa sisältää' / 'May contain' lines",
]


def build_ws5_spec_prompt(kind: str, theme: str, n: int, seed: int) -> str:
    base = (
        f"Generate {n} distinct, realistic product label specifications for training a bounding-box detector on smart glasses "
        f"(seed {seed}). Theme: {theme}. Use realistic Nordic/EU brands, strengths, and expiry dates (2025-06 to 2029-11). "
        "Keep front_text crisp (3-6 short lines) and never include personal human names."
    )
    if kind == "medication":
        return base + (
            " All items have kind='medication'. Ensure product, strength, and expiry_printed are all non-empty and included in front_text."
        )
    return base + (
        " All items have kind='food'. Ensure product, ingredients_text (with bold/caps allergens), and expiry_printed are all non-empty so product, allergens, and expiry fields are all visible."
    )


def fast_dual_check(jpg: bytes, s: dict, back: bool, idx: int) -> dict:
    from google.genai import types

    model = AUDIT_MODELS[idx % len(AUDIT_MODELS)]
    exp = GI.expected_fields(s)
    exp_txt = "\n".join(f"- {k}: {v}" for k, v in exp.items() if v)
    prompt = (
        "You are labelling bounding boxes for a 4-class package field detector (product, strength, expiry, allergens). "
        "For EVERY field listed below, determine if its text is legible in this photo, transcribe what is printed, "
        "check if it matches the expected spec, and return its tight [ymin,xmin,ymax,xmax] bounding box in 0..1000 "
        f"(or [] if not visible).\n\nExpected ({'BACK barcode side' if back else 'main label'}):\n{exp_txt}"
    )
    contents = [types.Part.from_bytes(data=jpg, mime_type="image/jpeg"), prompt]
    data, _, _ = C.gen_json(
        model, contents, schema=GI.CHECK_SCHEMA, thinking="low", max_tokens=4096,
        feature="ws5.check_boxes", label=f"ws5-chk-{model[-5:]}",
    )
    return data


def import_seed_specs_and_renders(work_dir: Path, seed_v3_dir: Path | None) -> None:
    """Reuse already-verified v3 specs & renders (audited by gemini-4-argon) to jumpstart Wave 1 immediately."""
    if not seed_v3_dir or not seed_v3_dir.exists():
        return
    dst_specs = work_dir / "specs.jsonl"
    dst_renders = work_dir / "renders.jsonl"
    if dst_specs.exists() and dst_renders.exists():
        return
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "clean").mkdir(parents=True, exist_ok=True)
    if (seed_v3_dir / "specs.jsonl").exists() and not dst_specs.exists():
        shutil.copy2(seed_v3_dir / "specs.jsonl", dst_specs)
    if (seed_v3_dir / "renders.jsonl").exists() and not dst_renders.exists():
        kept = []
        for r in C.read_jsonl(seed_v3_dir / "renders.jsonl"):
            src_img = seed_v3_dir / r["file"]
            if src_img.exists():
                shutil.copy2(src_img, work_dir / r["file"])
                kept.append(r)
        C.write_jsonl(dst_renders, kept)
        C.log(f"imported {len(kept)} verified argon-audited renders + specs from {seed_v3_dir}")


def ensure_specs(work_dir: Path, target_meds: int = 1300, target_foods: int = 700, workers: int = 20) -> list[dict]:
    sp_path = work_dir / "specs.jsonl"
    existing = C.read_jsonl(sp_path)
    meds = [s for s in existing if s["kind"] == "medication"]
    foods = [s for s in existing if s["kind"] == "food"]
    need_m = max(0, target_meds - len(meds))
    need_f = max(0, target_foods - len(foods))
    if need_m == 0 and need_f == 0:
        return existing

    batch = 18
    jobs = []
    for i in range((need_m + batch - 1) // batch + 2 if need_m else 0):
        jobs.append(("medication", WS5_MED_THEMES[i % len(WS5_MED_THEMES)], batch, 700000 + i, AUDIT_MODELS[i % 2]))
    for i in range((need_f + batch - 1) // batch + 2 if need_f else 0):
        jobs.append(("food", WS5_FOOD_THEMES[i % len(WS5_FOOD_THEMES)], batch, 800000 + i, AUDIT_MODELS[i % 2]))

    C.log(f"ws5 specs: generating +{need_m} meds, +{need_f} foods across {len(jobs)} batches (have {len(existing)})")

    def worker(job):
        kind, theme, n, seed, model = job
        data, _, _ = C.gen_json(
            model, build_ws5_spec_prompt(kind, theme, n, seed), schema=SPEC_SCHEMA,
            thinking="low", max_tokens=16384, feature="ws5.gen_specs", label=f"ws5-spec-{kind[:3]}",
        )
        return kind, data.get("items", [])

    res = C.pmap(worker, jobs, workers=workers, desc="ws5-specs")
    seen = {(s["product"].lower(), s.get("strength", "").lower()) for s in existing}
    next_m = len(meds)
    next_f = len(foods)
    for r in res:
        if isinstance(r, dict):
            continue
        kind, items = r
        for it in items:
            if it.get("kind") != kind or not (it.get("product") or "").strip():
                continue
            key = (it["product"].strip().lower(), (it.get("strength") or "").strip().lower())
            if key in seen:
                continue
            seen.add(key)
            if kind == "medication" and len(meds) < target_meds:
                meds.append({"id": f"ws5med{next_m:04d}", **it})
                next_m += 1
            elif kind == "food" and len(foods) < target_foods:
                foods.append({"id": f"ws5food{next_f:04d}", **it})
                next_f += 1

    merged = meds + foods
    C.write_jsonl(sp_path, merged)
    C.log(f"ws5 specs ready: {len(merged)} total ({len(meds)} meds, {len(foods)} foods)")
    return merged


def render_wave(specs: list[dict], work_dir: Path, target_front: int, target_back: int, workers: int = 18) -> list[dict]:
    renders_path = work_dir / "renders.jsonl"
    dropped_path = work_dir / "renders_dropped.jsonl"
    cur_renders = C.read_jsonl(renders_path)
    done = {r["id"] for r in cur_renders} | {r["id"] for r in C.read_jsonl(dropped_path)}

    have_front = sum(1 for r in cur_renders if r["view"] == "front")
    have_back = sum(1 for r in cur_renders if r["view"] == "back")
    need_front = max(0, target_front - have_front)
    need_back = max(0, target_back - have_back)
    if need_front == 0 and need_back == 0:
        return cur_renders

    # Interleave medications (65%) and foods (35%) so allergens gets rich box coverage!
    med_specs = [s for s in specs if s["kind"] == "medication" and s["id"] not in done]
    food_specs = [s for s in specs if s["kind"] == "food" and s["id"] not in done]
    interleaved = []
    mi = fi = 0
    while (mi < len(med_specs) or fi < len(food_specs)) and len(interleaved) < need_front + 20:
        for _ in range(2):
            if mi < len(med_specs):
                interleaved.append(med_specs[mi]); mi += 1
        if fi < len(food_specs):
            interleaved.append(food_specs[fi]); fi += 1

    jobs: list[tuple[int, dict, bool]] = []
    for s in interleaved[: need_front + 12]:
        jobs.append((len(jobs), s, False))

    back_cands = [s for s in specs if s["kind"] == "medication" and (s["id"] + "_back") not in done]
    rng = random.Random(505)
    rng.shuffle(back_cands)
    for s in back_cands[: need_back + 4]:
        jobs.append((len(jobs), s, True))

    C.log(f"ws5 render_wave: running {len(jobs)} jobs (currently have front={have_front}/{target_front}, back={have_back}/{target_back})")
    (work_dir / "clean").mkdir(parents=True, exist_ok=True)

    def worker(job: tuple[int, dict, bool]) -> dict:
        idx, s, back = job
        tries = []
        models = ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"]
        for attempt in range(2):
            order = models if attempt == 0 else models[1:] + models[:1]
            png, model = GI.render(GI.render_prompt(s, back=back), order)
            jpg = GI.to_jpeg(png, size=896)
            chk = fast_dual_check(jpg, s, back, idx + attempt)
            gt = GI.gt_from_check(s, chk)
            ok = (not back and GI.keep(s, gt, chk)) or (back and gt["strength"]["status"] != "visible" and gt["product"]["status"] != "visible")
            tries.append({"model": model, "ok": ok})
            if ok:
                rid = s["id"] + ("_back" if back else "")
                rel = f"clean/{rid}.jpg"
                (work_dir / rel).write_bytes(jpg)
                row = {"id": rid, "spec_id": s["id"], "kind": s["kind"], "view": "back" if back else "front", "file": rel, "render_model": model, "gt": gt}
                C.append_jsonl(renders_path, row)
                return row
        rid = s["id"] + ("_back" if back else "")
        C.append_jsonl(dropped_path, {"id": rid, "spec_id": s["id"], "dropped": True})
        return {"dropped": True}

    if jobs:
        C.pmap(worker, jobs, workers=workers, desc="ws5-renders")
    return C.read_jsonl(renders_path)


# ----------------------------------------------------------------- Geometric Box & Image Transforms
def extract_norm_boxes(gt: dict) -> list[tuple[int, float, float, float, float, int]]:
    """Returns [(cls_idx, x0, y0, x1, y1, lines), ...] in [0..1] for visible/partial fields."""
    out = []
    for ci, cname in enumerate(CLASSES):
        g = gt.get(cname) or {}
        b = g.get("box") or []
        if len(b) != 4 or g.get("status") not in ("visible", "partial"):
            continue
        y0, x0, y1, x1 = [max(0.0, min(1000.0, float(v))) / 1000.0 for v in b]
        if x1 - x0 > 0.008 and y1 - y0 > 0.008:
            out.append((ci, x0, y0, x1, y1, max(1, int(g.get("lines") or 1))))
    return out


def format_yolo_lines(boxes: list[tuple[int, float, float, float, float]]) -> list[str]:
    lines = []
    for ci, x0, y0, x1, y1 in boxes:
        x0c, y0c = max(0.0, min(1.0, x0)), max(0.0, min(1.0, y0))
        x1c, y1c = max(0.0, min(1.0, x1)), max(0.0, min(1.0, y1))
        bw, bh = x1c - x0c, y1c - y0c
        if bw > 0.008 and bh > 0.008:
            lines.append(f"{ci} {(x0c + x1c) / 2:.5f} {(y0c + y1c) / 2:.5f} {bw:.5f} {bh:.5f}")
    return lines


def make_glasses_pov_wide(im: Image.Image, boxes: list, rng: random.Random, variant: int) -> tuple[Image.Image, list]:
    """Simulates wider eye-level smart-glasses FOV (item smaller in frame + slight head tilt) with exact 2D affine box transform."""
    S = IMG_SIZE
    bg_col = rng.choice([(44, 42, 39), (58, 55, 50), (35, 38, 43), (66, 61, 55)])
    canvas = Image.new("RGB", (S, S), bg_col)
    # Subtle blurred room background from edge pixels
    bg = im.resize((S, S), Image.BILINEAR).filter(ImageFilter.GaussianBlur(22))
    bg = ImageEnhance.Brightness(bg).enhance(0.55)
    canvas.paste(bg, (0, 0))

    scale = rng.uniform(0.60, 0.78) if variant == 0 else rng.uniform(0.66, 0.84)
    nw, nh = int(S * scale), int(S * scale)
    ox = rng.randint(int(S * 0.06), max(int(S * 0.06), S - nw - int(S * 0.06)))
    oy = rng.randint(int(S * 0.08), max(int(S * 0.08), S - nh - int(S * 0.06)))
    fg = im.resize((nw, nh), Image.LANCZOS)
    canvas.paste(fg, (ox, oy))

    ang = rng.uniform(-16.0, 16.0)
    if abs(ang) < 4.0:
        ang = 9.5 if variant == 0 else -11.0
    canvas = canvas.rotate(ang, resample=Image.BICUBIC, expand=False, fillcolor=bg_col)
    rad = -math.radians(ang)
    cos_a, sin_a = math.cos(rad), math.sin(rad)

    new_boxes = []
    for ci, x0, y0, x1, y1, _ in boxes:
        px0, py0 = ox + x0 * nw, oy + y0 * nh
        px1, py1 = ox + x1 * nw, oy + y1 * nh
        corners = [(px0, py0), (px1, py0), (px1, py1), (px0, py1)]
        rx, ry = [], []
        for x, y in corners:
            dx, dy = x - S / 2.0, y - S / 2.0
            rx.append(S / 2.0 + dx * cos_a - dy * sin_a)
            ry.append(S / 2.0 + dx * sin_a + dy * cos_a)
        nx0, ny0, nx1, ny1 = min(rx) / S, min(ry) / S, max(rx) / S, max(ry) / S
        new_boxes.append((ci, nx0, ny0, nx1, ny1))
    return canvas, new_boxes


def draw_skin_thumb(im: Image.Image, rect_px: tuple[int, int, int, int], rng: random.Random) -> Image.Image:
    S = IMG_SIZE
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    skin = rng.choice([(214, 168, 143, 253), (195, 144, 118, 253), (229, 188, 164, 253), (168, 118, 94, 253)])
    nail = (min(255, skin[0] + 22), min(255, skin[1] + 22), min(255, skin[2] + 24), 235)
    x0, y0, x1, y1 = rect_px
    d.rounded_rectangle([x0, y0, x1, y1], radius=max(16, min(abs(x1 - x0), abs(y1 - y0)) // 2), fill=skin)
    # Subtle fingernail highlight near tip
    nx0 = x0 + int((x1 - x0) * 0.52)
    ny0 = y0 + int((y1 - y0) * 0.18)
    nx1 = x1 - int((x1 - x0) * 0.10)
    ny1 = y1 - int((y1 - y0) * 0.18)
    if nx1 > nx0 + 6 and ny1 > ny0 + 6:
        d.rounded_rectangle([nx0, ny0, nx1, ny1], radius=8, fill=nail)
    overlay = overlay.filter(ImageFilter.GaussianBlur(2.6))
    return Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")


def make_thumb_occlusion(im: Image.Image, boxes: list, rng: random.Random, mode: str) -> tuple[Image.Image, list]:
    """mode in {'full_dose', 'partial_dose', 'grip_edge'}."""
    S = IMG_SIZE
    s_box = next((b for b in boxes if b[0] == 1), None)
    tgt = s_box or next((b for b in boxes if b[0] == 3), None) or (boxes[0] if boxes else (0, 0.35, 0.45, 0.65, 0.55, 1))
    _, tx0, ty0, tx1, ty1, _ = tgt

    if mode == "full_dose":
        # Thumb covers >=90% of the target dose/allergen box from left or bottom
        rx0 = max(0, int(tx0 * S) - 48)
        ry0 = max(0, int(ty0 * S) - 14)
        rx1 = min(S, int(tx1 * S) + 16)
        ry1 = min(S, max(int(ty1 * S) + 20, ry0 + 54))
    elif mode == "partial_dose":
        # Thumb covers left ~38% of target box; right ~62% stays visible!
        bw = (tx1 - tx0) * S
        rx0 = max(0, int(tx0 * S) - 55)
        rx1 = int(tx0 * S + bw * 0.38)
        ry0 = max(0, int(ty0 * S) - 10)
        ry1 = min(S, max(int(ty1 * S) + 16, ry0 + 48))
    else:
        # Finger grips outer edge of package without covering main dose digits
        side_left = rng.random() < 0.5
        rx0 = 0 if side_left else int(S * 0.80)
        rx1 = int(S * 0.20) if side_left else S
        ry0 = int(S * rng.uniform(0.32, 0.52))
        ry1 = min(S, ry0 + int(S * 0.16))

    out_im = draw_skin_thumb(im, (rx0, ry0, rx1, ry1), rng)
    ox0, oy0, ox1, oy1 = rx0 / S, ry0 / S, rx1 / S, ry1 / S

    kept = []
    for ci, x0, y0, x1, y1, _ in boxes:
        ix0, iy0 = max(x0, ox0), max(y0, oy0)
        ix1, iy1 = min(x1, ox1), min(y1, oy1)
        inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
        area = max(1e-6, (x1 - x0) * (y1 - y0))
        occ_frac = inter / area
        if occ_frac >= 0.58:
            continue  # occluded -> hidden (no false box!)
        if occ_frac > 0.12 and ox1 < x1 and ox0 <= x0:
            # Left side covered by thumb: clip box left edge to thumb tip
            x0 = max(x0, ox1 - 0.01)
        kept.append((ci, x0, y0, x1, y1))
    return out_im, kept


def make_partial_crop(im: Image.Image, boxes: list, rng: random.Random, sev: int) -> tuple[Image.Image, list]:
    """Crops off one side of the label and EXACTLY reprojects surviving boxes into the cropped frame."""
    S = IMG_SIZE
    cut = [0.24, 0.42, 0.56][sev - 1]
    if boxes:
        ux0 = min(b[1] for b in boxes); uy0 = min(b[2] for b in boxes)
        ux1 = max(b[3] for b in boxes); uy1 = max(b[4] for b in boxes)
    else:
        ux0, uy0, ux1, uy1 = 0.25, 0.25, 0.75, 0.75

    side = rng.choice(["left", "right", "top", "bottom"])
    cx0, cy0, cx1, cy1 = 0.0, 0.0, 1.0, 1.0
    if side == "left":
        cx0 = min(0.65, ux0 + cut * (ux1 - ux0))
    elif side == "right":
        cx1 = max(0.35, ux1 - cut * (ux1 - ux0))
    elif side == "top":
        cy0 = min(0.65, uy0 + cut * (uy1 - uy0))
    else:
        cy1 = max(0.35, uy1 - cut * (uy1 - uy0))

    cw, ch = max(0.2, cx1 - cx0), max(0.2, cy1 - cy0)
    cropped = im.crop((int(cx0 * S), int(cy0 * S), int(cx1 * S), int(cy1 * S))).resize((S, S), Image.LANCZOS)

    new_boxes = []
    for ci, x0, y0, x1, y1, _ in boxes:
        ix0, iy0 = max(x0, cx0), max(y0, cy0)
        ix1, iy1 = min(x1, cx1), min(y1, cy1)
        vis = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0) / max(1e-6, (x1 - x0) * (y1 - y0))
        if vis >= 0.35:
            new_boxes.append((ci, (ix0 - cx0) / cw, (iy0 - cy0) / ch, (ix1 - cx0) / cw, (iy1 - cy0) / ch))
    return cropped, new_boxes


def make_motion_blur_view(im: Image.Image, boxes: list, rng: random.Random, sev: int) -> tuple[Image.Image, list]:
    S = IMG_SIZE
    L = [8, 16][sev - 1]
    ang = rng.uniform(0, 180)
    blurred = DEG.motion_blur(im, L, ang)
    kept = []
    for ci, x0, y0, x1, y1, lines in boxes:
        lh = (y1 - y0) * S / max(1, lines)
        if lh >= 1.1 * (L / 2.0):
            kept.append((ci, x0, y0, x1, y1))
    return blurred, kept


def make_glare_or_lowlight(im: Image.Image, boxes: list, rng: random.Random, kind: str) -> tuple[Image.Image, list]:
    S = IMG_SIZE
    gt_dummy = {
        c: {"status": "visible", "box": [], "lines": 1} for c in CLASSES
    }
    for ci, x0, y0, x1, y1, lines in boxes:
        gt_dummy[CLASSES[ci]] = {
            "status": "visible",
            "box": [int(y0 * 1000), int(x0 * 1000), int(y1 * 1000), int(x1 * 1000)],
            "lines": lines,
        }
    out_im, gt_after, _ = DEG.apply(im, gt_dummy, kind, 2, rng)
    kept = []
    for ci, x0, y0, x1, y1, _ in boxes:
        if gt_after[CLASSES[ci]]["status"] in ("visible", "partial"):
            kept.append((ci, x0, y0, x1, y1))
    return out_im, kept


def make_multi_box_scene(
    primary_im: Image.Image,
    primary_boxes: list,
    peers: list[tuple[Image.Image, list]],
    rng: random.Random,
    n_packs: int,
) -> tuple[Image.Image, list]:
    """Places 2 or 3 packages from the SAME split onto a tabletop glasses-POV canvas and projects ALL boxes."""
    S = IMG_SIZE
    bg_col = rng.choice([(48, 45, 41), (62, 58, 52), (38, 41, 46)])
    canvas = Image.new("RGB", (S, S), bg_col)
    if n_packs == 2 or len(peers) < 2:
        slots = [
            (int(S * 0.02), int(S * 0.20), int(S * 0.49), int(S * 0.56)),
            (int(S * 0.50), int(S * 0.16), int(S * 0.48), int(S * 0.56)),
        ]
        chosen = [(primary_im, primary_boxes), peers[0]]
    else:
        slots = [
            (int(S * 0.01), int(S * 0.24), int(S * 0.32), int(S * 0.48)),
            (int(S * 0.34), int(S * 0.18), int(S * 0.33), int(S * 0.50)),
            (int(S * 0.68), int(S * 0.24), int(S * 0.31), int(S * 0.48)),
        ]
        chosen = [(primary_im, primary_boxes), peers[0], peers[1]]
    rng.shuffle(chosen)

    all_boxes = []
    for (pim, pboxes), (ox, oy, sw, sh) in zip(chosen, slots):
        resized = pim.resize((sw, sh), Image.LANCZOS)
        canvas.paste(resized, (ox, oy))
        for ci, x0, y0, x1, y1, _ in pboxes:
            all_boxes.append((ci, (ox + x0 * sw) / S, (oy + y0 * sh) / S, (ox + x1 * sw) / S, (oy + y1 * sh) / S))
    return canvas, all_boxes


def write_yolo_sample(out_dir: Path, split: str, img_id: str, im: Image.Image, boxes: list[tuple[int, float, float, float, float]]) -> tuple[int, list[int], str, str, int]:
    img_path = out_dir / "images" / split / f"{img_id}.jpg"
    lbl_path = out_dir / "labels" / split / f"{img_id}.txt"
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=83)
    jb = buf.getvalue()
    img_path.write_bytes(jb)
    lines = format_yolo_lines(boxes)
    lbl_bytes = ("\n".join(lines)).encode("utf-8")
    lbl_path.write_bytes(lbl_bytes)
    cls_counts = [0, 0, 0, 0]
    for ln in lines:
        cls_counts[int(ln.split()[0])] += 1
    img_sha = hashlib.sha256(jb).hexdigest()
    lbl_sha = hashlib.sha256(lbl_bytes).hexdigest()
    return len(lines), cls_counts, img_sha, lbl_sha, len(jb)


def write_checkpoint(
    out_dir: Path,
    records: list[dict],
    val_src_ids: set[str],
    repo_manifest_path: Path | None = None,
) -> dict:
    counts = {"train": 0, "val": 0}
    boxes = {"train": [0, 0, 0, 0], "val": [0, 0, 0, 0]}
    by_cond = collections.Counter()
    by_cond_boxes = collections.defaultdict(lambda: [0, 0, 0, 0])
    total_bytes = 0
    sha_lines = []

    for rec in records:
        sp = rec["split"]
        counts[sp] += 1
        by_cond[rec["condition"]] += 1
        total_bytes += rec["bytes"]
        for ci in range(4):
            boxes[sp][ci] += rec["cls_counts"][ci]
            by_cond_boxes[rec["condition"]][ci] += rec["cls_counts"][ci]
        sha_lines.append(f"{rec['img_sha256']}  images/{sp}/{rec['img_id']}.jpg")
        sha_lines.append(f"{rec['lbl_sha256']}  labels/{sp}/{rec['img_id']}.txt")

    (out_dir / "data.yaml").write_text(
        f"path: {out_dir}\ntrain: images/train\nval: images/val\nnames:\n"
        + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES))
    )
    split_obj = {
        "images": counts,
        "boxes": {s: dict(zip(CLASSES, v)) for s, v in boxes.items()},
        "val_src_ids": sorted(val_src_ids),
        "split": "by src_id, 80/20, seed 42 (strictly isolated across multi-box composites; 0 src_id leakage)",
    }
    (out_dir / "split.json").write_text(json.dumps(split_obj, indent=2) + "\n")

    checksum_txt = "\n".join(sha_lines) + "\n"
    checksum_path = out_dir / "checksums.sha256"
    checksum_path.write_text(checksum_txt)
    checksum_root_sha = hashlib.sha256(checksum_txt.encode("utf-8")).hexdigest()

    total_boxes_per_class = {
        c: boxes["train"][i] + boxes["val"][i] for i, c in enumerate(CLASSES)
    }
    manifest = {
        "dataset": "fieldspotter-x5",
        "version": "v1",
        "yolo_layout": "compatible with eval/make_yolo.py and eval/fs_eval.py",
        "image_size_px": [IMG_SIZE, IMG_SIZE],
        "classes": {str(i): c for i, c in enumerate(CLASSES)},
        "models_used": {
            "spec_generators": ["gemini-4-hydrogen", "gemini-4-argon"],
            "image_renderer": "gemini-3.1-flash-image",
            "box_auditors": ["gemini-4-hydrogen", "gemini-4-argon"],
            "direct_carbon_api_calls": 0,
        },
        "total_images": len(records),
        "total_boxes": sum(total_boxes_per_class.values()),
        "total_jpeg_bytes": total_bytes,
        "unique_base_renders": len({r["base_src_id"] for r in records}),
        "zero_train_val_src_leakage": True,
        "images_by_split": counts,
        "boxes_by_split": {s: dict(zip(CLASSES, v)) for s, v in boxes.items()},
        "boxes_by_class_total": total_boxes_per_class,
        "images_by_condition": dict(sorted(by_cond.items())),
        "boxes_by_condition": {k: dict(zip(CLASSES, v)) for k, v in sorted(by_cond_boxes.items())},
        "checksums_file": "checksums.sha256",
        "checksums_entries": len(sha_lines),
        "checksums_sha256": checksum_root_sha,
        "sample_checksums_first_10": sha_lines[:10],
        "sample_checksums_last_10": sha_lines[-10:],
        "updated_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if repo_manifest_path is not None:
        repo_manifest_path.parent.mkdir(parents=True, exist_ok=True)
        repo_manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def synthesize_yolo_dataset(
    renders: list[dict],
    work_dir: Path,
    out_dir: Path,
    target_total: int = 8000,
    checkpoint_every: int = 1000,
    status_md: Path | None = None,
    repo_manifest_path: Path | None = None,
) -> dict:
    for sp in ("train", "val"):
        (out_dir / "images" / sp).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / sp).mkdir(parents=True, exist_ok=True)

    # Split strictly by spec_id (base item), 80/20, seed 42 (never put front in train and back in val!)
    spec_ids = sorted({r["spec_id"] for r in renders})
    rng_split = random.Random(42)
    shuffled_specs = list(spec_ids)
    rng_split.shuffle(shuffled_specs)
    val_specs = set(shuffled_specs[: max(1, len(shuffled_specs) // 5)])

    front_renders = [r for r in renders if r["view"] == "front" and (work_dir / r["file"]).exists()]
    back_renders = [r for r in renders if r["view"] == "back" and (work_dir / r["file"]).exists()]

    # Preload resized 640x640 images + boxes per split for fast multi-box compositing
    loaded_front: dict[str, list[tuple[dict, Image.Image, list]]] = {"train": [], "val": []}
    for r in front_renders:
        sp = "val" if r["spec_id"] in val_specs else "train"
        im = Image.open(work_dir / r["file"]).convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.LANCZOS)
        bxs = extract_norm_boxes(r["gt"])
        loaded_front[sp].append((r, im, bxs))

    records: list[dict] = []
    last_ckpt = 0

    def maybe_ckpt():
        nonlocal last_ckpt
        if len(records) - last_ckpt >= checkpoint_every:
            last_ckpt = (len(records) // checkpoint_every) * checkpoint_every
            m = write_checkpoint(out_dir, records, val_specs, repo_manifest_path)
            C.log(f"CHECKPOINT {len(records)}/{target_total} images -> {out_dir / 'manifest.json'} (boxes={m['total_boxes']})")
            if status_md and status_md.exists():
                ts_str = time.strftime("%H:%M EET")
                line = (
                    f"- {ts_str} | Meta WS5 (FieldSpotter x5) | CHECKPOINT {len(records)}/{target_total} | "
                    f"~/carbon/out/fieldspotter-x5/manifest.json: {len(records)} YOLO images ({m['images_by_split']['train']} train / {m['images_by_split']['val']} val), "
                    f"{m['total_boxes']} boxes {m['boxes_by_class_total']}, sha256={m['checksums_sha256'][:12]}\n"
                )
                with status_md.open("a", encoding="utf-8") as sf:
                    sf.write(line)

    # 1. Back-of-box hard negatives first (4 views per back render)
    for bi, r in enumerate(back_renders):
        if len(records) >= target_total:
            break
        sp = "val" if r["spec_id"] in val_specs else "train"
        im = Image.open(work_dir / r["file"]).convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.LANCZOS)
        rng = random.Random(90000 + bi)
        variants = [
            ("back_of_box", im),
            ("back_of_box", make_glasses_pov_wide(im, [], rng, 0)[0]),
            ("back_of_box", DEG.motion_blur(im, 9, rng.uniform(0, 180))),
        ]
        for vi, (cond, vim) in enumerate(variants):
            if len(records) >= target_total:
                break
            img_id = f"{r['id']}__{cond}_{vi}"
            _, cls_c, isha, lsha, nbytes = write_yolo_sample(out_dir, sp, img_id, vim, [])
            records.append({"img_id": img_id, "base_src_id": r["spec_id"], "split": sp, "condition": cond, "cls_counts": cls_c, "img_sha256": isha, "lbl_sha256": lsha, "bytes": nbytes})
            maybe_ckpt()

    # 2. Compute exact views per front render so we hit target_total cleanly
    rem = max(0, target_total - len(records))
    all_front = loaded_front["train"] + loaded_front["val"]
    # Interleave train/val in original order for balanced checkpoints
    front_map = {r["id"]: (sp, r, im, bxs) for sp in ("train", "val") for (r, im, bxs) in loaded_front[sp]}
    ordered_front = [front_map[r["id"]] for r in front_renders if r["id"] in front_map]

    if not ordered_front:
        return write_checkpoint(out_dir, records, val_specs, repo_manifest_path)

    views_per_front = math.ceil(rem / len(ordered_front))

    for fi, (sp, r, im, bxs) in enumerate(ordered_front):
        if len(records) >= target_total:
            break
        rng = random.Random(10000 + fi)
        peers_pool = [(pim, pbxs) for (pr, pim, pbxs) in loaded_front[sp] if pr["spec_id"] != r["spec_id"]]

        # Canonical suite of up to 18 rich first-person glasses views per base render
        recipe: list[tuple[str, Image.Image, list]] = []
        # (a) Clean glasses POV
        recipe.append(("clean_glasses_pov", im, [(c, x0, y0, x1, y1) for c, x0, y0, x1, y1, _ in bxs]))
        # (b) Wide-FOV glasses-height POV + head tilt (x2)
        recipe.append(("glasses_pov_wide_tilt", *make_glasses_pov_wide(im, bxs, rng, 0)))
        recipe.append(("glasses_pov_wide_tilt", *make_glasses_pov_wide(im, bxs, rng, 1)))
        # (c) Thumb / finger over dose (x3: full cover -> dose hidden, partial cover -> dose clipped, edge grip)
        recipe.append(("thumb_over_dose_full", *make_thumb_occlusion(im, bxs, rng, "full_dose")))
        recipe.append(("thumb_over_dose_partial", *make_thumb_occlusion(im, bxs, rng, "partial_dose")))
        recipe.append(("finger_grip_edge", *make_thumb_occlusion(im, bxs, rng, "grip_edge")))
        # (d) Motion blur (x2)
        recipe.append(("motion_blur", *make_motion_blur_view(im, bxs, rng, 1)))
        recipe.append(("motion_blur", *make_motion_blur_view(im, bxs, rng, 2)))
        # (e) Partial views / off-frame edge crops (x3)
        recipe.append(("partial_view_crop", *make_partial_crop(im, bxs, rng, 1)))
        recipe.append(("partial_view_crop", *make_partial_crop(im, bxs, rng, 2)))
        recipe.append(("partial_view_crop", *make_partial_crop(im, bxs, rng, 3)))
        # (f) Specular glare & dim indoor low-light (x2)
        recipe.append(("specular_glare", *make_glare_or_lowlight(im, bxs, rng, "glare")))
        recipe.append(("low_light", *make_glare_or_lowlight(im, bxs, rng, "low_light")))
        # (g) Multiple boxes in frame (x3: 2-box side-by-side, 3-box tabletop, 2-box with thumb over one)
        if len(peers_pool) >= 2:
            p2 = rng.sample(peers_pool, 2)
            m2_im, m2_bxs = make_multi_box_scene(im, bxs, p2[:1], rng, 2)
            recipe.append(("multiple_boxes", m2_im, m2_bxs))
            m3_im, m3_bxs = make_multi_box_scene(im, bxs, p2, rng, 3)
            recipe.append(("multiple_boxes", m3_im, m3_bxs))
            p2_alt = rng.sample(peers_pool, 2)
            m2b_im, m2b_bxs = make_multi_box_scene(im, bxs, p2_alt[1:], rng, 2)
            recipe.append(("multiple_boxes", m2b_im, m2b_bxs))
        # Extra thumb + wide POV combo if needed to top up exact count
        w_im, w_bxs_raw = make_glasses_pov_wide(im, bxs, rng, 0)
        w_bxs_6 = [(c, x0, y0, x1, y1, 1) for c, x0, y0, x1, y1 in w_bxs_raw]
        recipe.append(("thumb_over_dose_full", *make_thumb_occlusion(w_im, w_bxs_6, rng, "full_dose")))
        recipe.append(("partial_view_crop", *make_partial_crop(im, bxs, rng, 2)))

        for vi, (cond, vim, vbox) in enumerate(recipe[:views_per_front]):
            if len(records) >= target_total:
                break
            img_id = f"{r['id']}__{cond}_{vi:02d}"
            _, cls_c, isha, lsha, nbytes = write_yolo_sample(out_dir, sp, img_id, vim, vbox)
            records.append({
                "img_id": img_id,
                "base_src_id": r["spec_id"],
                "split": sp,
                "condition": cond,
                "cls_counts": cls_c,
                "img_sha256": isha,
                "lbl_sha256": lsha,
                "bytes": nbytes,
            })
            maybe_ckpt()

    return write_checkpoint(out_dir, records, val_specs, repo_manifest_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", default=str(EVAL_DIR / "synthetic" / "ws5"))
    ap.add_argument("--seed-v3-dir", default="/Users/silaswang/carbon/holdup-ws4/eval/synthetic/v3")
    ap.add_argument("--out-dir", default="/Users/silaswang/carbon/out/fieldspotter-x5")
    ap.add_argument("--repo-manifest", default=str(REPO_ROOT / "eval" / "results" / "fieldspotter_x5_manifest.json"))
    ap.add_argument("--status-md", default="/Users/silaswang/carbon/STATUS.md")
    ap.add_argument("--front-renders", type=int, default=475)
    ap.add_argument("--back-renders", type=int, default=75)
    ap.add_argument("--target-images", type=int, default=8000)
    ap.add_argument("--checkpoint-every", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=18)
    args = ap.parse_args()

    work_dir = Path(args.work_dir)
    out_dir = Path(args.out_dir)
    C.OUT = EVAL_DIR / "out" / "ws5"
    C.LEDGER = C.OUT / "ledger.jsonl"

    import_seed_specs_and_renders(work_dir, Path(args.seed_v3_dir) if args.seed_v3_dir else None)
    specs = ensure_specs(work_dir, target_meds=1200, target_foods=600, workers=args.workers)
    renders = render_wave(specs, work_dir, target_front=args.front_renders, target_back=args.back_renders, workers=args.workers)
    C.log(f"ws5 base renders ready: {len(renders)} total ({sum(r['view']=='front' for r in renders)} front, {sum(r['view']=='back' for r in renders)} back)")

    manifest = synthesize_yolo_dataset(
        renders=renders,
        work_dir=work_dir,
        out_dir=out_dir,
        target_total=args.target_images,
        checkpoint_every=args.checkpoint_every,
        status_md=Path(args.status_md) if args.status_md else None,
        repo_manifest_path=Path(args.repo_manifest) if args.repo_manifest else None,
    )
    C.log(f"DONE: {manifest['total_images']} YOLO images, {manifest['total_boxes']} boxes -> {out_dir}")


if __name__ == "__main__":
    main()
