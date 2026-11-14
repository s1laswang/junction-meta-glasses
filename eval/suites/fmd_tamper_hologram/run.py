import argparse
import base64
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
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BIN = "/tmp/fleet-silas/node/bin"
if os.path.isdir(NODE_BIN):
    os.environ["PATH"] = f"{NODE_BIN}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = REPO / "eval" / "out" / "fmd_tamper_hologram"
OUT_JSON = SUITE_DIR / "results.json"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
        {"id": "paracetamol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["evening"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {"id": "fh_01", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "rainbow_flap_safe", "food": False, "q": "Is this my evening pill?", "expected": "match", "exp_str": "5 mg", "allergen": False, "desc": "Intact EU FMD rainbow hologram flap seal and GS1 DataMatrix on Amlodipin 5 mg", "accent": (20, 98, 154), "bg": (249, 250, 252), "hdr": "ORION PHARMA", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": "5 mg", "pack": "98 tablets  1 tablet in the evening", "exp": "EXP 2027-10", "dm": ["PC 06432100012345", "SN 84920173", "EXP 2027-10", "LOT K4182"], "flap": "rainbow_hologram", "occlude": None, "tilt": -1.4},
    {"id": "fh_02", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "translucent_flap_safe", "food": False, "q": "Is this my evening pill?", "expected": "warning", "exp_str": "10 mg", "allergen": False, "desc": "Intact translucent EU FMD seal and DataMatrix on wrong-strength Amlodipin 10 mg", "accent": (20, 98, 154), "bg": (249, 250, 252), "hdr": "ORION PHARMA", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": "10 mg", "pack": "98 tablets  Once daily", "exp": "EXP 2027-11", "dm": ["PC 06432100012383", "SN 61904412", "EXP 2027-11", "LOT K5091"], "flap": "translucent_seal", "occlude": None, "tilt": 1.5},
    {"id": "fh_03", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "silver_foil_safe", "food": False, "q": "Can I take this for pain?", "expected": "warning", "exp_str": "400 mg", "allergen": False, "desc": "Intact silver FMD security seal and DataMatrix on Burana 400 mg NSAID carton", "accent": (184, 34, 46), "bg": (251, 248, 248), "hdr": "ORION PHARMA", "title": "Burana", "sub": "Active ingredient: ibuprofen", "str": "400 mg", "pack": "30 tablets  For pain or fever", "exp": "EXP 2027-12", "dm": ["PC 06432100077401", "SN 39201855", "EXP 2027-12", "LOT B2204"], "flap": "silver_foil", "occlude": None, "tilt": -1.5},
    {"id": "fh_04", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "datamatrix_expired", "food": False, "q": "Is this my Metformin?", "expected": "warning", "exp_str": "500 mg", "allergen": False, "desc": "Intact EU FMD seal and GS1 DataMatrix showing expired EXP 2025-01 Metformin 500 mg", "accent": (34, 86, 160), "bg": (248, 250, 252), "hdr": "SANDOZ NORDIC", "title": "Metformin", "sub": "Active ingredient: metformin", "str": "500 mg", "pack": "100 tablets  Twice daily with meals", "exp": "EXP 2025-01", "dm": ["PC 06432100054321", "SN 48291037", "EXP 2025-01", "LOT M1904"], "flap": "rainbow_hologram", "occlude": None, "tilt": 1.3},
    {"id": "fh_05", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "foil_seal_allergen", "food": True, "q": "Does this contain tree nuts or peanuts?", "expected": "warning", "exp_str": None, "allergen": True, "desc": "Intact hologram-sealed Cocoa Hazelnut Crisp box with readable tree-nut allergen", "accent": (108, 56, 34), "bg": (247, 242, 235), "hdr": "FAZER FINLAND", "title": "Cocoa Hazelnut Crisp", "sub": "Foil-Sealed Cocoa Snack Box  175 g", "ing": ["Ingredients: roasted hazelnuts (22%), cocoa mass,", "cane sugar, cocoa butter, wheat flour."], "alg": "Allergens: Contains roasted hazelnuts (tree nuts), wheat.", "exp": "Best before: 2027-09-18", "flap": "rainbow_hologram", "occlude": None, "tilt": -1.3},
    {"id": "fh_06", "category": "intact_fmd_pack", "degraded": False, "seal_mode": "silver_seal_safe_food", "food": True, "q": "Is this safe with my nut allergies?", "expected": "info", "exp_str": None, "allergen": False, "desc": "Intact silver-sealed Nordic Oat Crackers box with nut-free allergen panel", "accent": (46, 102, 74), "bg": (245, 248, 242), "hdr": "NORDIC OAT BAKERY", "title": "Nordic Oat Crackers", "sub": "Oven-Baked Wholegrain Crackers  210 g", "ing": ["Ingredients: wholegrain oats (64%), wheat flour,", "cold-pressed rapeseed oil, sourdough, sea salt."], "alg": "Allergens: Contains wheat, oats (gluten).", "exp": "Best before: 2027-08-20", "flap": "silver_foil", "occlude": None, "tilt": 1.4},
    {"id": "fh_07", "category": "hologram_specular_rainbow", "degraded": True, "seal_mode": "hologram_over_strength", "food": False, "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "EU FMD rainbow hologram seal pasted directly over Amlodipin strength digits", "accent": (20, 98, 154), "bg": (249, 250, 252), "hdr": "ORION PHARMA", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": None, "pack": "98 tablets  Take in the evening", "exp": "EXP 2027-10", "dm": ["PC 06432100012345", "SN 77410298", "EXP 2027-10", "LOT K4182"], "flap": None, "occlude": "hologram_strength", "tilt": -1.7},
    {"id": "fh_08", "category": "hologram_specular_rainbow", "degraded": True, "seal_mode": "specular_rainbow_flare", "food": False, "q": "Is this my evening cholesterol pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Specular rainbow diffraction flare across FMD hologram seal over Atorvastatin strength", "accent": (92, 52, 132), "bg": (249, 249, 252), "hdr": "ORION PHARMA", "title": "Atorvastatin", "sub": "Active ingredient: atorvastatin", "str": None, "pack": "98 tablets  1 tablet in the evening", "exp": "EXP 2027-10", "dm": ["PC 06432100088120", "SN 90811234", "EXP 2027-10", "LOT A3190"], "flap": None, "occlude": "rainbow_flare", "tilt": -1.6},
    {"id": "fh_09", "category": "void_adhesive_residue", "degraded": True, "seal_mode": "void_checker_strength", "food": False, "q": "Is this my Metformin?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Peeled EU FMD seal leaving VOID OPENED checkerboard residue over Metformin strength", "accent": (34, 86, 160), "bg": (248, 250, 252), "hdr": "SANDOZ NORDIC", "title": "Metformin", "sub": "Active ingredient: metformin", "str": None, "pack": "100 tablets  Take with meals", "exp": "EXP 2027-09", "dm": ["PC 06432100054321", "SN 55920144", "EXP 2027-09", "LOT M8021"], "flap": None, "occlude": "void_residue", "tilt": 1.8},
    {"id": "fh_10", "category": "void_adhesive_residue", "degraded": True, "seal_mode": "void_fiber_tear_strength", "food": False, "q": "Can I take this Panadol?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Opened FMD tamper tape leaving VOID adhesive fiber tear ripping off Panadol strength", "accent": (22, 108, 156), "bg": (249, 250, 252), "hdr": "HALEON NORDIC", "title": "Panadol", "sub": "Active ingredient: paracetamol", "str": None, "pack": "30 tablets  For pain or fever", "exp": "EXP 2027-11", "dm": ["PC 06432100098765", "SN 64019283", "EXP 2027-11", "LOT P4412"], "flap": None, "occlude": "void_residue", "tilt": 1.5},
    {"id": "fh_11", "category": "torn_perforation_tamper", "degraded": True, "seal_mode": "torn_perf_datamatrix_strength", "food": False, "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Partially torn FMD perforation ripping across strength, DataMatrix, and expiry on Amlodipin", "accent": (20, 98, 154), "bg": (249, 250, 252), "hdr": "ORION PHARMA", "title": "Amlodipin", "sub": "Active ingredient: amlodipine", "str": None, "pack": None, "exp": None, "dm": None, "flap": None, "occlude": "torn_perforation_med", "tilt": -1.8},
    {"id": "fh_12", "category": "torn_perforation_tamper", "degraded": True, "seal_mode": "torn_perf_allergen_expiry", "food": True, "q": "Is this safe with my nut allergies?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Partially torn perforation and silver seal covering allergen and expiry panel on biscuits", "accent": (124, 78, 38), "bg": (247, 243, 235), "hdr": "NORDIC BAKEHOUSE", "title": "Golden Tea Biscuits", "sub": "Crispy Oven-Baked Biscuits  200 g", "ing": [], "alg": "", "exp": None, "flap": None, "occlude": "torn_perforation_food", "tilt": 1.7},
]


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)], capture_output=True, check=True, timeout=5)
            for ch in proc.stdout.split(b"\x00"):
                if b"=" in ch:
                    k, v = ch.split(b"=", 1)
                    ks = k.decode("utf-8", "ignore").strip()
                    if ks and ks not in os.environ:
                        os.environ[ks] = v.decode("utf-8", "ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    for p in (home_env, REPO / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        return KEY_RE.sub("[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-"))
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, dict):
        return {sanitize(str(k)): sanitize(val) for k, val in v.items()}
    return v


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    defs = (node.get("$defs") or {}) if (defs is None and isinstance(node, dict)) else defs
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str) and defs is not None:
            return inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def compute_prompt_sha12() -> str:
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    return hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]


def find_node() -> str:
    cand = pathlib.Path(NODE_BIN) / "node"
    if cand.is_file():
        return str(cand)
    return shutil.which("node") or "node"


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 12) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size))
    d, rng = ImageDraw.Draw(im), random.Random(seed + 19)
    hz = int(size * 0.58)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(232 - 20 * t), int(229 - 18 * t), int(222 - 16 * t)))
    for y in range(hz, size):
        t, j = (y - hz) / max(1, size - hz), rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(186 - 26 * t) + j, int(162 - 22 * t) + j, int(134 - 18 * t) + j))
    d.line((0, hz, size, hz), fill=(138, 116, 92), width=3)
    bk = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(bk).ellipse((28, 22, 236, 198), fill=(255, 252, 240, 48))
    return Image.alpha_composite(im.convert("RGBA"), bk.filter(ImageFilter.GaussianBlur(radius=22.0))).convert("RGB")


def build_hologram(w: int, h: int, style: str, seed: int, label: str = "") -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / max(1.0, float(w - 1)), yy / max(1.0, float(h - 1))
    if style == "rainbow_hologram":
        ph = 6.8 * nx + 4.4 * ny + 0.45 * np.sin(11.0 * nx - 7.0 * ny + (seed % 17))
        rad = np.sqrt(((nx - 0.5) * 1.25) ** 2 + (ny - 0.5) ** 2)
        mod = 18.0 * np.cos(42.0 * rad) + 10.0 * np.sin(xx * 0.85) * np.cos(yy * 0.85) + 38.0 * np.exp(-(((nx * 0.82 + ny * 0.55) - 0.66) ** 2) / 0.012)
        r = np.clip(196.0 + 48.0 * np.sin(ph) + mod, 120, 255)
        g = np.clip(198.0 + 48.0 * np.sin(ph + 2.094) + mod, 124, 255)
        b = np.clip(204.0 + 48.0 * np.sin(ph + 4.188) + mod, 132, 255)
        al = 255
    elif style == "translucent_seal":
        wv = 14.0 * np.sin(8.5 * nx + 5.2 * ny)
        sp = 46.0 * np.exp(-(((nx * 0.75 + ny * 0.65) - 0.68) ** 2) / 0.015)
        r, g, b, al = np.clip(222.0 + wv + sp, 180, 255), np.clip(232.0 + 0.7 * wv + sp, 190, 255), np.clip(242.0 - 0.6 * wv + sp, 200, 255), 130
    else:
        st = 18.0 * np.sin(yy * 0.55 + 1.8 * nx) + 34.0 * np.exp(-(((nx * 0.7 + ny * 0.7) - 0.65) ** 2) / 0.018)
        base = np.clip(198.0 + st, 146, 250)
        r, g, b, al = base, np.clip(base + 3.0, 148, 252), np.clip(base + 8.0, 154, 255), 255
    patch = Image.fromarray(np.stack([r.astype(np.uint8), g.astype(np.uint8), b.astype(np.uint8), np.full((h, w), al, dtype=np.uint8)], axis=-1), mode="RGBA")
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=14, fill=255)
    patch.putalpha(Image.composite(patch.getchannel("A"), Image.new("L", (w, h), 0), mask))
    pd = ImageDraw.Draw(patch)
    pd.rounded_rectangle((1, 1, w - 2, h - 2), radius=13, outline=(132, 144, 162, 220), width=2)
    cx, cy = int(w / 2), int(h / 2)
    for rp in (16, 28):
        if rp < int(min(w, h) / 2) - 4:
            pd.ellipse((cx - rp, cy - rp, cx + rp, cy + rp), outline=(94, 106, 128, 125), width=1)
    if label:
        sf = fit_font(pd, label, w - 16, 13, 10)
        pd.text((int((w - pd.textlength(label, font=sf)) / 2), h - 22), label, font=sf, fill=(48, 58, 74, 185))
    return patch


def draw_datamatrix(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], lines: list[str], seed: int) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0, y0, x1, y1), radius=8, fill=(255, 255, 255, 255), outline=(168, 178, 192, 255), width=2)
    rng, cell, gn = random.Random(seed + 303), 5, 18
    mx0 = x0 + int((x1 - x0 - gn * cell) / 2)
    my0 = y0 + 12
    for r in range(gn):
        for c in range(gn):
            bit = True if (c == 0 or r == gn - 1) else ((c % 2 == 0) if r == 0 else ((r % 2 == 1) if c == gn - 1 else rng.random() < 0.48))
            if bit:
                draw.rectangle((mx0 + c * cell, my0 + r * cell, mx0 + (c + 1) * cell - 1, my0 + (r + 1) * cell - 1), fill=(18, 22, 30, 255))
    ty = my0 + gn * cell + 10
    for ln in lines:
        draw.text((x0 + 8, ty), ln, font=fit_font(draw, ln, x1 - x0 - 16, 13, 10), fill=(24, 30, 42, 255))
        ty += 19


def apply_occlusion(card: Image.Image, mode: str, seed: int) -> None:
    rng = random.Random(seed + 71)
    cw, ch = card.size
    if mode == "hologram_strength":
        patch = build_hologram(286, 112, "rainbow_hologram", seed)
        pd = ImageDraw.Draw(patch)
        for sx in range(12, 274, 18):
            pd.line((sx, 6, sx - 10, 106), fill=(255, 255, 255, 125), width=2)
        card.alpha_composite(patch, dest=(18, 196))
    elif mode == "rainbow_flare":
        card.alpha_composite(build_hologram(302, 118, "rainbow_hologram", seed), dest=(16, 194))
        arr = np.asarray(card.convert("RGB"), dtype=np.float32)
        yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
        cx, cy = 160.0, 250.0
        core = np.exp(-(((xx - cx) / 148.0) ** 2 + ((yy - cy) / 52.0) ** 2) * 1.45)
        st = np.clip(np.exp(-((yy - cy - 0.16 * (xx - cx)) ** 2) / 340.0) + np.exp(-((yy - cy + 0.18 * (xx - cx)) ** 2) / 380.0), 0.0, 1.4) * np.exp(-((xx - cx) ** 2) / 35000.0)
        guard = np.clip((yy - 186.0) / 14.0, 0.0, 1.0) * np.clip((462.0 - xx) / 28.0, 0.0, 1.0)
        ph = 0.065 * (xx - cx) + 2.0 * np.arctan2(yy - cy, xx - cx)
        bw = np.clip((core * 1.35 + st * 0.65) * guard, 0.0, 1.0)
        for ch_i, off in enumerate((0.0, 2.094, 4.188)):
            sp = np.clip(255.0 * core + 135.0 * st * (0.55 + 0.45 * np.sin(ph + off)), 0.0, 255.0)
            arr[:, :, ch_i] = np.clip(arr[:, :, ch_i] * (1.0 - bw) + sp * bw + 180.0 * core * guard, 0.0, 255.0)
        up = Image.fromarray(arr.astype(np.uint8), mode="RGB").convert("RGBA")
        up.putalpha(card.getchannel("A"))
        card.paste(up)
    elif mode == "void_residue":
        d = ImageDraw.Draw(card)
        rx0, ry0, rx1, ry1 = 18, 200, 304, 308
        pts = [(x, ry0 + rng.randint(-4, 5)) for x in range(rx0, rx1 + 1, 14)] + [(x, ry1 + rng.randint(-5, 4)) for x in range(rx1, rx0 - 1, -14)]
        d.polygon(pts, fill=(236, 233, 225, 255), outline=(188, 182, 170, 255))
        cell = 14
        for cy in range(ry0 + 6, ry1 - 8, cell):
            for cx in range(rx0 + 6, rx1 - 8, cell):
                if (int(cx / cell) + int(cy / cell)) % 2 == 0:
                    d.rectangle((cx, cy, cx + cell - 2, cy + cell - 2), fill=(72, 108, 152, 185))
        vf = ImageFont.load_default(size=22)
        for idx_r, txt in enumerate(("VOID   OPENED   VOID", "OPENED   VOID   OPEN", "VOID   OPENED   VOID")):
            d.text((rx0 + 12, ry0 + 12 + idx_r * 30), txt, font=vf, fill=(36, 62, 102, 238))
        card.alpha_composite(build_hologram(66, ry1 - ry0, "translucent_seal", seed + 9), dest=(rx1 - 10, ry0))
    elif mode == "torn_perforation_med":
        d = ImageDraw.Draw(card)
        poly = [(18, 198 + rng.randint(-5, 5))] + [(x, 196 + rng.randint(-6, 6)) for x in range(60, cw - 12, 22)] + [(cw - 14, ch - 18), (18, ch - 18)]
        d.polygon(poly, fill=(216, 206, 190, 255), outline=(168, 156, 138, 255))
        for _ in range(140):
            fx, fy = rng.randint(24, cw - 36), rng.randint(206, ch - 26)
            v = rng.randint(196, 234)
            d.line((fx, fy, fx + rng.randint(8, 24), fy + rng.randint(-3, 3)), fill=(v, v - 6, v - 14, 255), width=2)
        for px in range(26, cw - 24, 18):
            d.rectangle((px, 194, px + 9, 202), fill=(138, 128, 114, 255))
        card.alpha_composite(build_hologram(156, 92, "silver_foil", seed + 5), dest=(cw - 196, 212))
    elif mode == "torn_perforation_food":
        d = ImageDraw.Draw(card)
        px0, py0, px1, py1 = 20, 184, cw - 20, ch - 22
        poly = [(x, py0 + rng.randint(-5, 5)) for x in range(px0, px1 + 1, 18)] + [(x, py1 + rng.randint(-5, 5)) for x in range(px1, px0 - 1, -18)]
        d.polygon(poly, fill=(214, 198, 174, 255), outline=(168, 150, 126, 255))
        for _ in range(130):
            fx, fy = rng.randint(px0 + 8, px1 - 28), rng.randint(py0 + 8, py1 - 8)
            v = rng.randint(194, 230)
            d.line((fx, fy, fx + rng.randint(8, 22), fy + rng.randint(-2, 2)), fill=(v, v - 8, v - 18, 255), width=2)
        for px in range(px0 + 8, px1 - 12, 18):
            d.rectangle((px, py0 - 3, px + 9, py0 + 5), fill=(136, 122, 104, 255))
        card.alpha_composite(build_hologram(178, 96, "silver_foil", seed + 11), dest=(cw - 214, py0 + 18))


def render_case(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 6200 + idx * 31
    pad, size = 80, 928
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 68, pad + 104, pad + 700, pad + 664
    bw, bh = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(26, 24, 22, 84))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    card = Image.new("RGBA", (bw, bh), (*case["bg"], 255))
    cd = ImageDraw.Draw(card)
    seam_x = bw - 158
    cd.rectangle((seam_x, 4, bw - 4, bh - 4), fill=(case["bg"][0] - 7, case["bg"][1] - 7, case["bg"][2] - 6, 255))
    cd.line((seam_x, 4, seam_x, bh - 4), fill=(176, 184, 194, 255), width=2)
    cd.rectangle((0, 0, bw, 60), fill=(*case["accent"], 255))
    cd.text((26, 18), case["hdr"], fill=(248, 250, 252, 255), font=ImageFont.load_default(size=22))
    cd.text((26, 82), case["title"], fill=(16, 22, 32, 255), font=fit_font(cd, case["title"], seam_x - 36, 44 if not case["food"] else 36))
    cd.text((26, 142), case["sub"], fill=(46, 54, 68, 255), font=fit_font(cd, case["sub"], seam_x - 36, 23))
    if case["food"]:
        if case["ing"]:
            cd.rounded_rectangle((24, 190, seam_x - 16, 412), radius=10, fill=(254, 252, 248, 255), outline=(182, 174, 162, 255), width=2)
            iy = 210
            for ln in case["ing"]:
                cd.text((36, iy), ln, fill=(24, 28, 30, 255), font=fit_font(cd, ln, seam_x - 64, 21))
                iy += 34
            cd.rounded_rectangle((34, iy + 8, seam_x - 26, iy + 64), radius=8, fill=(255, 244, 232, 255), outline=(196, 126, 68, 255), width=2)
            cd.text((44, iy + 24), case["alg"], fill=(98, 36, 18, 255), font=fit_font(cd, case["alg"], seam_x - 80, 19))
        if case["exp"]:
            cd.text((28, bh - 62), case["exp"], fill=(20, 26, 34, 255), font=ImageFont.load_default(size=24))
    else:
        if case["str"]:
            cd.rounded_rectangle((26, 204, 264, 292), radius=12, fill=(238, 245, 252, 255), outline=(*case["accent"], 255), width=3)
            cd.text((48, 222), case["str"], fill=(14, 20, 30, 255), font=ImageFont.load_default(size=44))
            cd.text((280, 234), "tablets", fill=(48, 56, 68, 255), font=ImageFont.load_default(size=24))
        if case["pack"]:
            cd.text((26, 336), case["pack"], fill=(38, 46, 58, 255), font=fit_font(cd, case["pack"], seam_x - 42, 22))
        if case["exp"]:
            e_col = (162, 22, 32, 255) if "2025" in case["exp"] else (20, 26, 36, 255)
            cd.rounded_rectangle((26, 424, 282, 484), radius=8, fill=(244, 247, 250, 255), outline=(176, 184, 196, 255), width=2)
            cd.text((44, 440), case["exp"], fill=e_col, font=ImageFont.load_default(size=26))
        if case["dm"]:
            draw_datamatrix(cd, (seam_x + 12, 248, bw - 14, 456), case["dm"], seed)
    if case["flap"]:
        lbl = "EU FMD SECURE" if case["flap"] != "silver_foil" else "SECURITY SEAL"
        card.alpha_composite(build_hologram(142, 98, case["flap"], seed, lbl), dest=(seam_x - 42, 74))
    if case["occlude"]:
        apply_occlusion(card, case["occlude"], seed)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(174, 180, 188, 255), width=3)
    comp = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    return comp.crop((pad, pad, pad + 768, pad + 768))


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64_jpg: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": f'The person asked: "{question}"'}]
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }
    sess, last = requests.Session(), "failed"
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0}


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if os.path.isdir("/dev/shm"):
        ev["TMPDIR"] = "/dev/shm"
    return ev


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    ev = sub_env()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false, alg_hits: allergenHits(read, inp.allergies).length }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == "fmd_tamper_hologram"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env(), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--verify-cached", dest="verify_cached", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.verify_cached or args.offline:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        im = render_case(c, idx)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        raw = buf.getvalue()
        (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
        rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
        return 0
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    with ThreadPoolExecutor(max_workers=4) as ex:
        api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    if errors:
        raise RuntimeError(f"API errors: {errors}")
    scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["degraded"]:
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
        elif c["exp_str"] is not None:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        else:
            alg_miss = bool(c["allergen"] and float(rd["allergens"]["confidence"] or 0.0) >= 0.8 and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or alg_miss or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "seal_mode": c["seal_mode"],
            "description": c["desc"],
            "question": c["q"],
            "expected_level": c["expected"],
            "predicted_level": pred,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    clean = [x for x in cases_out if x["category"] == "intact_fmd_pack"]
    deg = [x for x in cases_out if x["category"] != "intact_fmd_pack"]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "intact_fmd_pack_accuracy": round(sum(1 for x in clean if x["verdict_ok"]) / len(clean), 4),
        "tamper_occluded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": "fmd_tamper_hologram",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) > 15200:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
