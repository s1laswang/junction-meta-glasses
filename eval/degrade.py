"""Step 3: programmatic degradations with PIL (CPU only, no network: run in a Slurm job).

For every clean front render: clean (resized to the 768 px glasses frame size) plus
--types random degradation types x 3 severities. Back-of-box renders are evaluated clean.

Degradations: motion_blur, defocus, rotation, crop (partial label), glare, low_light.
(back_of_box is a separate render made by gen_images.py.)

Ground truth is adjusted per field using the field's bounding box from the render check:
  visible  - must be read; scored for accuracy
  partial  - degraded/partly occluded; abstaining is fine, a wrong value is still wrong
  hidden   - not readable; the honest answer is null (or low confidence)
  excluded - rendered text differed from spec; never scored

Usage: python eval/degrade.py [--types 3] [--size 768]
Output: $HOLDUP_DATA/images/<id>__<deg>_<sev>.jpg and $HOLDUP_DATA/dataset.jsonl
"""
from __future__ import annotations

import argparse
import copy
import math
import random
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from common import DATA, log, read_jsonl, write_jsonl

DEGS = ["motion_blur", "defocus", "rotation", "crop", "glare", "low_light"]
SIZE = 768


def box_px(box, w, h):
    if not box:
        return None
    y0, x0, y1, x1 = box
    return (x0 / 1000 * w, y0 / 1000 * h, x1 / 1000 * w, y1 / 1000 * h)


def line_height(f, h):
    b = f.get("box")
    if not b:
        return None
    return (b[2] - b[0]) / 1000 * h / max(1, f.get("lines") or 1)


def downgrade(f, new):
    order = {"visible": 0, "partial": 1, "hidden": 2}
    if f["status"] == "excluded" or f["status"] not in order:
        return
    if order[new] > order[f["status"]]:
        f["status"] = new


def motion_blur(im, length, angle):
    a = np.asarray(im).astype(np.float32)
    acc = np.zeros_like(a)
    n = max(1, int(length))
    dx, dy = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    for i in range(n):
        t = i - (n - 1) / 2
        acc += np.roll(np.roll(a, int(round(t * dy)), axis=0), int(round(t * dx)), axis=1)
    return Image.fromarray(np.clip(acc / n, 0, 255).astype(np.uint8))


def blur_status(gt, size_px, h, k_vis=2.2, k_hid=1.1):
    """Text whose line height is small relative to the blur extent becomes partial/hidden."""
    for f in gt.values():
        lh = line_height(f, h)
        if lh is None:
            continue
        if lh < k_hid * size_px:
            downgrade(f, "hidden")
        elif lh < k_vis * size_px:
            downgrade(f, "partial")


def apply(im: Image.Image, gt: dict, deg: str, sev: int, rng: random.Random):
    w, h = im.size
    gt = copy.deepcopy(gt)
    meta = {}
    if deg == "motion_blur":
        L = [7, 15, 30][sev - 1]
        ang = rng.uniform(0, 180)
        im = motion_blur(im, L, ang)
        blur_status(gt, L / 2, h)
        meta = {"length_px": L, "angle": round(ang)}
    elif deg == "defocus":
        r = [1.5, 3.0, 6.0][sev - 1]
        im = im.filter(ImageFilter.GaussianBlur(r))
        blur_status(gt, r * 1.6, h)
        meta = {"radius": r}
    elif deg == "rotation":
        ang = [20, 60, 150][sev - 1] * rng.choice([-1, 1])
        im = im.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=(40, 40, 40)).resize((w, h))
        # expand+resize shrinks text by |cos|+|sin| factor; treat sev 3 small text as partial
        if sev == 3:
            blur_status(gt, 2.0, h, k_vis=6.0, k_hid=2.5)
        meta = {"angle": ang}
    elif deg == "crop":
        # The frame catches only part of the label: cut a straight edge through the
        # union of the field boxes, removing `cut` of the label from one side.
        cut = [0.25, 0.5, 0.7][sev - 1]
        boxes = [box_px(f["box"], w, h) for f in gt.values() if f.get("box")]
        if boxes:
            ux0 = min(b[0] for b in boxes); uy0 = min(b[1] for b in boxes)
            ux1 = max(b[2] for b in boxes); uy1 = max(b[3] for b in boxes)
        else:
            ux0, uy0, ux1, uy1 = w * 0.3, h * 0.3, w * 0.7, h * 0.7
        side = rng.choice(["left", "right", "top", "bottom"])
        x0, y0, x1, y1 = 0, 0, w, h
        if side == "left":
            x0 = int(ux0 + cut * (ux1 - ux0))
        elif side == "right":
            x1 = int(ux1 - cut * (ux1 - ux0))
        elif side == "top":
            y0 = int(uy0 + cut * (uy1 - uy0))
        else:
            y1 = int(uy1 - cut * (uy1 - uy0))
        for f in gt.values():
            b = box_px(f.get("box"), w, h)
            if not b:
                continue
            area = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
            ix = max(0, min(b[2], x1) - max(b[0], x0)); iy = max(0, min(b[3], y1) - max(b[1], y0))
            inside = ix * iy / area
            if inside < 0.35:
                downgrade(f, "hidden")
            elif inside < 0.92:
                downgrade(f, "partial")
        im = im.crop((x0, y0, x1, y1))  # keeps scale; aspect becomes non-square like a real partial frame
        meta = {"window": [x0, y0, x1, y1], "side": side, "cut": cut}
    elif deg == "glare":
        # specular hotspot centred on a key field (strength for meds, allergens for food)
        targets = [k for k in ("strength", "allergens", "expiry", "product") if gt[k].get("box") and gt[k]["status"] == "visible"]
        tgt = targets[0] if targets else None
        b = box_px(gt[tgt]["box"], w, h) if tgt else (w * 0.4, h * 0.4, w * 0.6, h * 0.6)
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        rad = max(b[2] - b[0], b[3] - b[1]) * [0.45, 0.7, 0.9][sev - 1] + 12
        peak = [0.55, 0.85, 1.0][sev - 1]
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.sqrt(((xx - cx) / rad) ** 2 + ((yy - cy) / (rad * 0.7)) ** 2)
        mask = np.clip(1.25 - d, 0, 1) ** 1.2 * peak
        mask = np.clip(mask * 1.6, 0, 1)[..., None]
        a = np.asarray(im).astype(np.float32)
        a = a * (1 - mask) + 255 * mask
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        for k, f in gt.items():
            fb = box_px(f.get("box"), w, h)
            if not fb:
                continue
            fx, fy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
            dd = math.hypot((fx - cx) / rad, (fy - cy) / (rad * 0.7))
            if dd < 0.6 and sev == 3:
                downgrade(f, "hidden")
            elif dd < 0.8 and sev >= 2:
                downgrade(f, "partial")
        meta = {"target": tgt, "radius": round(rad), "peak": peak}
    elif deg == "low_light":
        bf = [0.4, 0.2, 0.09][sev - 1]
        sigma = [4, 9, 16][sev - 1]
        im = ImageEnhance.Brightness(im).enhance(bf)
        im = ImageEnhance.Color(im).enhance(0.6)
        a = np.asarray(im).astype(np.float32) + np.random.default_rng(rng.randint(0, 10**6)).normal(0, sigma, (h, w, 3))
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6 * sev))
        if sev >= 2:
            blur_status(gt, [0, 2.0, 4.0][sev - 1], h, k_vis=4.0, k_hid=2.0)
        meta = {"brightness": bf, "noise": sigma}
    return im, gt, meta


def do_one(args):
    r, types_n, size, seed = args
    rng = random.Random(seed)
    src = Image.open(DATA / r["file"]).convert("RGB").resize((size, size), Image.LANCZOS)
    (DATA / "images").mkdir(parents=True, exist_ok=True)
    rows = []
    name = f"{r['id']}__clean_0.jpg"
    src.save(DATA / "images" / name, "JPEG", quality=82)
    rows.append({"img_id": f"{r['id']}__clean_0", "file": f"images/{name}", "src_id": r["id"], "spec_id": r["spec_id"],
                 "kind": r["kind"], "view": r["view"], "deg": "back_of_box" if r["view"] == "back" else "clean",
                 "sev": 0, "gt": r["gt"], "meta": {}})
    if r["view"] == "back":
        return rows
    for deg in rng.sample(DEGS, types_n):
        for sev in (1, 2, 3):
            im, gt, meta = apply(src, r["gt"], deg, sev, rng)
            name = f"{r['id']}__{deg}_{sev}.jpg"
            im.save(DATA / "images" / name, "JPEG", quality=82)
            rows.append({"img_id": f"{r['id']}__{deg}_{sev}", "file": f"images/{name}", "src_id": r["id"],
                         "spec_id": r["spec_id"], "kind": r["kind"], "view": r["view"], "deg": deg, "sev": sev,
                         "gt": gt, "meta": meta})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", type=int, default=3, help="degradation types per clean image (x3 severities)")
    ap.add_argument("--size", type=int, default=SIZE)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    renders = read_jsonl(DATA / "renders.jsonl")
    jobs = [(r, a.types, a.size, 1000 + i) for i, r in enumerate(renders)]
    out = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for rows in ex.map(do_one, jobs):
            out.extend(rows)
    write_jsonl(DATA / "dataset.jsonl", out)
    from collections import Counter
    log(f"wrote {len(out)} images from {len(renders)} renders:", dict(Counter(r['deg'] for r in out)))


if __name__ == "__main__":
    main()
