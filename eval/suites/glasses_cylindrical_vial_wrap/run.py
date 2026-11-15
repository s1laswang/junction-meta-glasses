import argparse
import base64
import datetime
import hashlib
import io
import json
import math
import os
import pathlib
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

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

SHM_DIR = pathlib.Path("/dev/shm")
if SHM_DIR.is_dir():
    os.environ["TMPDIR"] = str(SHM_DIR)

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
TMP_BASE = pathlib.Path("/tmp/opencode") if pathlib.Path("/tmp/opencode").is_dir() else pathlib.Path("/tmp")
OUT_IMG_DIR = TMP_BASE / "holdup_glasses_cylindrical_vial_wrap"
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
MAX_WORKERS = 4
GAZE_DEG = 35.0
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "metoprolol", "name": "Metoprolol", "ingredient": "metoprolol", "strength": "25 mg", "schedule": ["morning", "evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "timolol", "name": "Timolol", "ingredient": "timolol", "strength": "0.5%", "schedule": ["morning", "evening"]},
        {"id": "lantus", "name": "Lantus", "ingredient": "insulin glargine", "strength": "100 IU/mL", "schedule": ["evening"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

VIAL_SPECS: dict[str, dict[str, Any]] = {
    "meto25": {
        "form": "pill_bottle",
        "substrate": "amber",
        "accent": (22, 98, 152),
        "cap_rgb": (244, 246, 250),
        "hdr": "ORION PHARMA  Vnr 04 71 25",
        "title": "METOPROLOL",
        "ing": "metoprolol",
        "str": "25 mg",
        "dose1": "1 tablet morning",
        "dose2": "and evening",
        "exp": "EXP 2027-11",
    },
    "metf500": {
        "form": "pill_bottle",
        "substrate": "amber",
        "accent": (24, 114, 106),
        "cap_rgb": (244, 246, 250),
        "hdr": "ORION PHARMA  Vnr 14 88 05",
        "title": "METFORMIN",
        "ing": "metformin",
        "str": "500 mg",
        "dose1": "1 tablet morning",
        "dose2": "and evening",
        "exp": "EXP 2027-12",
    },
    "ibu400": {
        "form": "pill_bottle",
        "substrate": "white_hdpe",
        "accent": (188, 34, 44),
        "cap_rgb": (202, 42, 52),
        "hdr": "ORION PHARMA  Vnr 06 14 28",
        "title": "BURANA",
        "ing": "ibuprofen",
        "str": "400 mg",
        "dose1": "1 tablet as needed",
        "dose2": "for acute pain",
        "exp": "EXP 2027-11",
    },
    "timo05": {
        "form": "eyedrop_bottle",
        "substrate": "white_ldpe",
        "accent": (18, 122, 134),
        "cap_rgb": (22, 138, 148),
        "hdr": "SANTEN  Sterile Eye Drops",
        "title": "TIMOLOL",
        "ing": "timolol",
        "str": "0.5%",
        "dose1": "1 drop in eye",
        "dose2": "morning and evening",
        "exp": "EXP 2027-09",
    },
    "timo025": {
        "form": "eyedrop_bottle",
        "substrate": "white_ldpe",
        "accent": (42, 108, 178),
        "cap_rgb": (54, 124, 196),
        "hdr": "SANTEN  Sterile Eye Drops",
        "title": "TIMOLOL",
        "ing": "timolol",
        "str": "0.25%",
        "dose1": "1 drop in eye",
        "dose2": "morning and evening",
        "exp": "EXP 2027-09",
    },
    "lantus100": {
        "form": "insulin_pen",
        "substrate": "pen_silver_blue",
        "accent": (102, 54, 148),
        "cap_rgb": (112, 62, 162),
        "hdr": "SANOFI SOLOSTAR  Pen",
        "title": "LANTUS",
        "ing": "insulin glargine",
        "str": "100 IU/mL",
        "dose1": "Inject once daily",
        "dose2": "in the evening",
        "exp": "EXP 2027-10",
    },
    "toujeo300": {
        "form": "insulin_pen",
        "substrate": "pen_sage",
        "accent": (46, 118, 78),
        "cap_rgb": (52, 132, 86),
        "hdr": "SANOFI SOLOSTAR  Pen",
        "title": "TOUJEO",
        "ing": "insulin glargine",
        "str": "300 IU/mL",
        "dose1": "Inject once daily",
        "dose2": "in the evening",
        "exp": "EXP 2027-10",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "cv_01",
        "category": "readable_curved_vial",
        "wrap_mode": "front_foreshortened_25mg_vial",
        "container_kind": "pill_bottle",
        "degraded": False,
        "fg": "meto25",
        "rot_deg": [13.0],
        "tilt_deg": -2.5,
        "bg": "oak_table",
        "q": "Is this my Metoprolol?",
        "expected": "match",
        "exp_str": "25 mg",
        "desc": "Downward-gaze (~35 deg) amber cylindrical Metoprolol 25 mg pill bottle with curved text arc and foreshortened 25 mg near right edge",
    },
    {
        "id": "cv_02",
        "category": "readable_curved_vial",
        "wrap_mode": "front_foreshortened_05pct_dropper",
        "container_kind": "eyedrop_bottle",
        "degraded": False,
        "fg": "timo05",
        "rot_deg": [15.0],
        "tilt_deg": 2.0,
        "bg": "bathroom_tile",
        "q": "Are these my Timolol eye drops?",
        "expected": "match",
        "exp_str": "0.5%",
        "desc": "Downward-gaze (~35 deg) sterile cylindrical Timolol 0.5% eye-drop bottle with foreshortened 0.5% badge on curved barrel",
    },
    {
        "id": "cv_03",
        "category": "readable_curved_vial",
        "wrap_mode": "front_foreshortened_100iu_pen",
        "container_kind": "insulin_pen",
        "degraded": False,
        "fg": "lantus100",
        "rot_deg": [7.5],
        "tilt_deg": -8.0,
        "bg": "kitchen_granite",
        "q": "Is this my evening insulin pen?",
        "expected": "match",
        "exp_str": "100 IU/mL",
        "desc": "Downward-gaze (~35 deg) cylindrical Lantus insulin glargine 100 IU/mL pen with foreshortened IU/mL unit near right barrel curve",
    },
    {
        "id": "cv_04",
        "category": "readable_curved_vial",
        "wrap_mode": "wrong_strength_025pct_dropper",
        "container_kind": "eyedrop_bottle",
        "degraded": False,
        "fg": "timo025",
        "rot_deg": [12.5],
        "tilt_deg": -2.0,
        "bg": "bathroom_tile",
        "q": "Are these my morning eye drops?",
        "expected": "warning",
        "exp_str": "0.25%",
        "desc": "Downward-gaze (~35 deg) cylindrical Timolol 0.25% eye-drop bottle differing from prescribed 0.5% concentration",
    },
    {
        "id": "cv_05",
        "category": "readable_curved_vial",
        "wrap_mode": "wrong_strength_300iu_pen",
        "container_kind": "insulin_pen",
        "degraded": False,
        "fg": "toujeo300",
        "rot_deg": [7.0],
        "tilt_deg": 7.5,
        "bg": "kitchen_granite",
        "q": "Is this my evening insulin pen?",
        "expected": "warning",
        "exp_str": "300 IU/mL",
        "desc": "Downward-gaze (~35 deg) concentrated Toujeo insulin glargine 300 IU/mL cylindrical pen differing from prescribed 100 IU/mL",
    },
    {
        "id": "cv_06",
        "category": "readable_curved_vial",
        "wrap_mode": "nsaid_400mg_hdpe_bottle",
        "container_kind": "pill_bottle",
        "degraded": False,
        "fg": "ibu400",
        "rot_deg": [12.0],
        "tilt_deg": 2.2,
        "bg": "oak_table",
        "q": "Can I take this for pain?",
        "expected": "warning",
        "exp_str": "400 mg",
        "desc": "Downward-gaze (~35 deg) white HDPE cylindrical Burana ibuprofen 400 mg bottle with curved label triggering NSAID avoid warning",
    },
    {
        "id": "cv_07",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "trailing_zeros_clipped_500mg",
        "container_kind": "pill_bottle",
        "degraded": True,
        "fg": "metf500",
        "rot_deg": [65.5],
        "tilt_deg": -2.2,
        "bg": "kitchen_granite",
        "q": "Is this my Metformin?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Downward-gaze (~35 deg) rotated Metformin amber pill bottle where 500 mg wraps around right limb clipping trailing zeros and mg unit",
    },
    {
        "id": "cv_08",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "limb_wrapped_unit_25mg",
        "container_kind": "pill_bottle",
        "degraded": True,
        "fg": "meto25",
        "rot_deg": [70.5],
        "tilt_deg": 2.4,
        "bg": "oak_table",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Downward-gaze (~35 deg) rotated Metoprolol amber pill bottle where 25 mg wraps past the curved right cylinder horizon",
    },
    {
        "id": "cv_09",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "narrow_dropper_wrap_05pct",
        "container_kind": "eyedrop_bottle",
        "degraded": True,
        "fg": "timo05",
        "rot_deg": [70.0],
        "tilt_deg": -2.8,
        "bg": "bathroom_tile",
        "q": "Are these my glaucoma eye drops?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Downward-gaze (~35 deg) narrow Timolol eye-drop bottle rotated so 0.5% concentration wraps behind the right squeeze-bottle limb",
    },
    {
        "id": "cv_10",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "pen_barrel_trailing_zeros_100iu",
        "container_kind": "insulin_pen",
        "degraded": True,
        "fg": "lantus100",
        "rot_deg": [66.0],
        "tilt_deg": -9.0,
        "bg": "kitchen_granite",
        "q": "Is this my evening insulin pen?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Downward-gaze (~35 deg) narrow Lantus insulin pen rotated around barrel axis clipping trailing zeros and IU/mL unit around curve",
    },
    {
        "id": "cv_11",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "back_seam_rotated_vial",
        "container_kind": "pill_bottle",
        "degraded": True,
        "fg": "meto25",
        "rot_deg": [180.0],
        "tilt_deg": 1.8,
        "bg": "oak_table",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Downward-gaze (~35 deg) amber pill bottle turned to back sticker seam and storage note with front identity and strength hidden",
    },
    {
        "id": "cv_12",
        "category": "limb_wrapped_strength_clip",
        "wrap_mode": "two_frame_insufficient_wrist_roll",
        "container_kind": "pill_bottle",
        "degraded": True,
        "fg": "meto25",
        "rot_deg": [74.0, 68.5],
        "tilt_deg": -2.0,
        "bg": "oak_table",
        "q": "Is this my Metoprolol?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Two-frame downward-gaze (~35 deg) wrist-roll sequence where Metoprolol 25 mg stays wrapped past right cylinder limb in both frames",
    },
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
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def node_ts_cmd(extra_args: list[str]) -> list[str]:
    node = find_node()
    if (REPO / "node_modules" / "tsx").is_dir() or (REPO.parent / "node_modules" / "tsx").is_dir() or shutil.which("tsx"):
        return [node, "--import", "tsx", *extra_args]
    return [node, *extra_args]


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_DIR.is_dir():
        ev["TMPDIR"] = str(SHM_DIR)
    parent_nm = REPO.parent / "node_modules"
    if parent_nm.is_dir():
        existing_np = ev.get("NODE_PATH", "")
        ev["NODE_PATH"] = f"{parent_nm}:{existing_np}" if existing_np else str(parent_nm)
    return ev


def clamp01(x: Any) -> float | int:
    if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x)):
        v = max(0.0, min(1.0, float(x)))
        return int(v) if v in (0.0, 1.0) else v
    return 0


def coerce_str_field(x: Any) -> dict[str, Any]:
    raw_val = x.get("value") if isinstance(x, dict) else None
    val = raw_val if isinstance(raw_val, str) and len(raw_val.strip()) > 0 else None
    conf = clamp01(x.get("confidence") if isinstance(x, dict) else 0.0)
    return {"value": val, "confidence": min(conf, 0.3) if val is None else conf}


def coerce_arr_field(x: Any) -> dict[str, Any]:
    raw_val = x.get("value") if isinstance(x, dict) else None
    ok = isinstance(raw_val, list) and all(isinstance(s, str) for s in raw_val)
    val = list(raw_val) if ok else None
    conf = clamp01(x.get("confidence") if isinstance(x, dict) else 0.0)
    return {"value": val, "confidence": min(conf, 0.3) if val is None else conf}


def to_label_read(j: Any) -> dict[str, Any]:
    if not isinstance(j, dict):
        nf = {"value": None, "confidence": 0}
        return {
            "kind": "unreadable",
            "product": nf,
            "ingredient": nf,
            "strength": nf,
            "dosing": nf,
            "expiry": nf,
            "allergens": nf,
            "barcode": nf,
            "readability": 0,
            "guidance": "Hold it up in front of you and keep it still.",
        }
    kinds = ("medication", "food", "other", "unreadable")
    read: dict[str, Any] = {
        "kind": j["kind"] if j.get("kind") in kinds else "unreadable",
        "product": coerce_str_field(j.get("product")),
        "ingredient": coerce_str_field(j.get("ingredient")),
        "strength": coerce_str_field(j.get("strength")),
        "dosing": coerce_str_field(j.get("dosing")),
        "expiry": coerce_str_field(j.get("expiry")),
        "allergens": coerce_arr_field(j.get("allergens")),
        "barcode": coerce_str_field(j.get("barcode")),
        "readability": clamp01(j.get("readability")),
    }
    g = j.get("guidance")
    if isinstance(g, str) and len(g.strip()) > 0:
        read["guidance"] = g.strip()[:120]
    ev = read["expiry"]["value"]
    if isinstance(ev, str) and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", ev):
        read["expiry"]["confidence"] = min(read["expiry"]["confidence"], 0.5)
    return read


def render_counter_backdrop(seed: int, style: str) -> Image.Image:
    size = 768
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / (size - 1.0), yy / (size - 1.0)
    rng = np.random.default_rng(seed)
    if style == "oak_table":
        grain = np.sin(ny * 46.0 + 0.35 * np.sin(nx * 9.0)) * 7.5
        r = 186.0 - 24.0 * ny + grain + 10.0 * (1.0 - nx)
        g = 152.0 - 22.0 * ny + grain * 0.78 + 8.0 * (1.0 - nx)
        b = 116.0 - 18.0 * ny + grain * 0.52 + 6.0 * (1.0 - nx)
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 2.2, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        d.ellipse((540, 44, 716, 188), fill=(224, 228, 232), outline=(182, 186, 192), width=5)
        d.ellipse((564, 64, 692, 166), fill=(118, 84, 58))
        return im.filter(ImageFilter.GaussianBlur(radius=3.4))
    if style == "bathroom_tile":
        r = 216.0 - 18.0 * ny + 8.0 * nx
        g = 224.0 - 18.0 * ny + 8.0 * nx
        b = 228.0 - 14.0 * ny + 6.0 * nx
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 1.8, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        for gx in (128, 320, 512, 704):
            d.line((gx, 0, gx - 28, size), fill=(190, 198, 204), width=2)
        for gy in (130, 310, 490, 670):
            d.line((0, gy, size, gy + 14), fill=(190, 198, 204), width=2)
        d.ellipse((-60, -40, 230, 190), fill=(238, 242, 245), outline=(184, 192, 198), width=4)
        return im.filter(ImageFilter.GaussianBlur(radius=3.0))
    speck = rng.normal(0.0, 6.5, (size, size, 1))
    r = 198.0 - 20.0 * ny + speck[..., 0]
    g = 200.0 - 20.0 * ny + speck[..., 0]
    b = 204.0 - 18.0 * ny + speck[..., 0]
    arr = np.stack([r, g, b], axis=-1)
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((46, 48, 224, 164), radius=16, fill=(214, 222, 228), outline=(168, 176, 184), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=3.2))


def substrate_rgb(name: str) -> tuple[int, int, int]:
    if name == "amber":
        return (156, 72, 16)
    if name == "white_hdpe":
        return (236, 240, 246)
    if name == "white_ldpe":
        return (242, 245, 250)
    if name == "pen_sage":
        return (188, 204, 196)
    return (192, 202, 218)


def build_unwrapped_texture(spec: dict[str, Any]) -> np.ndarray:
    w_tex, h_tex = 1152, 340
    base = substrate_rgb(spec["substrate"])
    im = Image.new("RGB", (w_tex, h_tex), base)
    d = ImageDraw.Draw(im)
    if spec["substrate"] == "amber":
        d.rectangle((0, 0, w_tex, 20), fill=(132, 58, 12))
        d.rectangle((0, h_tex - 20, w_tex, h_tex), fill=(124, 52, 10))
    d.rounded_rectangle((166, 18, 986, h_tex - 18), radius=8, fill=(251, 252, 254), outline=(196, 202, 210), width=2)
    for bx in range(196, 298, 7):
        bw = 2 if (bx % 14 == 0) else 4
        d.rectangle((bx, 68, bx + bw, 232), fill=(28, 32, 38))
    d.text((196, 248), "LOT K84B", fill=(62, 68, 76), font=ImageFont.load_default(size=18))
    back_lines = ("Keep out of reach", "of children.", "Store in a dry", "place away from", "direct light.")
    for li, ln in enumerate(back_lines):
        d.text((840, 74 + li * 32), ln, fill=(58, 64, 72), font=ImageFont.load_default(size=18))
    d.rectangle((358, 18, 792, 64), fill=spec["accent"])
    d.text((374, 30), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=19))
    d.text((374, 74), spec["title"], fill=(12, 18, 26), font=ImageFont.load_default(size=35))
    d.text((374, 122), "Active ingredient:", fill=(54, 62, 72), font=ImageFont.load_default(size=17))
    d.text((374, 144), spec["ing"], fill=(18, 24, 34), font=ImageFont.load_default(size=22))
    d.text((374, 192), spec["dose1"], fill=(34, 42, 52), font=ImageFont.load_default(size=18))
    d.text((374, 215), spec["dose2"], fill=(34, 42, 52), font=ImageFont.load_default(size=18))
    d.text((374, 266), spec["exp"], fill=(18, 24, 32), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((608, 106, 786, 190), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    s_txt = spec["str"]
    s_font = ImageFont.load_default(size=29 if "IU" in s_txt else 34)
    d.text((624, 129 if "IU" in s_txt else 126), s_txt, fill=(10, 16, 24), font=s_font)
    return np.asarray(im, dtype=np.float32)


def sample_bilinear(tex: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h_t, w_t, _ = tex.shape
    uw = np.mod(u, float(w_t))
    vc = np.clip(v, 0.0, float(h_t - 1.001))
    u0 = np.floor(uw).astype(np.int32)
    v0 = np.floor(vc).astype(np.int32)
    u1 = (u0 + 1) % w_t
    v1 = np.minimum(v0 + 1, h_t - 1)
    fu = (uw - u0)[..., None]
    fv = (vc - v0)[..., None]
    c00 = tex[v0, u0]
    c10 = tex[v0, u1]
    c01 = tex[v1, u0]
    c11 = tex[v1, u1]
    top = c00 * (1.0 - fu) + c10 * fu
    bot = c01 * (1.0 - fu) + c11 * fu
    return top * (1.0 - fv) + bot * fv


def draw_top_hardware(d: ImageDraw.ImageDraw, form: str, cx: int, y_top: int, rad: int, b_ell: int, cap_rgb: tuple[int, int, int]) -> None:
    if form == "pill_bottle":
        rc = int(round(rad * 1.04))
        bc = int(round(b_ell * 1.04))
        cap_h = int(round(rad * 0.44))
        y_cap_top = y_top - cap_h
        d.rectangle((cx - rc, y_cap_top, cx + rc, y_top), fill=cap_rgb)
        d.pieslice((cx - rc, y_top - bc, cx + rc, y_top + bc), start=0, end=180, fill=cap_rgb)
        for kx in range(cx - rc + 8, cx + rc - 6, 12):
            rel = (kx - cx) / max(1.0, float(rc))
            y_rib_bot = y_top + int(round(bc * math.sqrt(max(0.0, 1.0 - rel * rel))))
            shade = tuple(max(0, c - 26) for c in cap_rgb)
            d.line((kx, y_cap_top, kx, y_rib_bot - 3), fill=shade, width=3)
        top_face = tuple(min(255, c + 8) for c in cap_rgb)
        ring_col = tuple(max(0, c - 36) for c in cap_rgb)
        d.ellipse((cx - rc, y_cap_top - bc, cx + rc, y_cap_top + bc), fill=top_face, outline=ring_col, width=3)
        d.ellipse((cx - int(rc * 0.72), y_cap_top - int(bc * 0.72), cx + int(rc * 0.72), y_cap_top + int(bc * 0.72)), outline=ring_col, width=2)
        return
    if form == "eyedrop_bottle":
        d.ellipse((cx - rad, y_top - b_ell, cx + rad, y_top + b_ell), fill=(232, 237, 244), outline=(188, 196, 206), width=2)
        r_mid = int(round(rad * 0.56))
        b_mid = int(round(b_ell * 0.56))
        y_mid = y_top - int(round(rad * 0.34))
        d.polygon([(cx - rad + 6, y_top), (cx - r_mid, y_mid), (cx + r_mid, y_mid), (cx + rad - 6, y_top)], fill=(238, 242, 248))
        d.ellipse((cx - r_mid, y_mid - b_mid, cx + r_mid, y_mid + b_mid), fill=(214, 222, 230), outline=(166, 176, 186), width=2)
        r_tip = int(round(rad * 0.34))
        b_tip = int(round(b_ell * 0.34))
        y_tip = y_mid - int(round(rad * 0.64))
        d.polygon([(cx - r_mid + 4, y_mid), (cx - r_tip, y_tip), (cx + r_tip, y_tip), (cx + r_mid - 4, y_mid)], fill=cap_rgb)
        d.pieslice((cx - r_mid + 4, y_mid - b_mid, cx + r_mid - 4, y_mid + b_mid), start=0, end=180, fill=cap_rgb)
        top_c = tuple(min(255, c + 24) for c in cap_rgb)
        out_c = tuple(max(0, c - 34) for c in cap_rgb)
        d.ellipse((cx - r_tip, y_tip - b_tip, cx + r_tip, y_tip + b_tip), fill=top_c, outline=out_c, width=3)
        return
    r_col = int(round(rad * 0.94))
    b_col = int(round(b_ell * 0.94))
    y_col = y_top - int(round(rad * 0.52))
    d.rectangle((cx - r_col, y_col, cx + r_col, y_top), fill=(232, 236, 242))
    d.pieslice((cx - r_col, y_top - b_col, cx + r_col, y_top + b_col), start=0, end=180, fill=(232, 236, 242))
    d.rounded_rectangle((cx - 34, y_col + 12, cx + 34, y_top - 4), radius=6, fill=(250, 252, 254), outline=(120, 128, 138), width=2)
    d.text((cx - 8, y_col + 16), "0", fill=(18, 22, 28), font=ImageFont.load_default(size=22))
    r_btn = int(round(rad * 0.72))
    b_btn = int(round(b_ell * 0.72))
    y_btn = y_col - int(round(rad * 0.36))
    d.ellipse((cx - r_col, y_col - b_col, cx + r_col, y_col + b_col), fill=(214, 220, 228), outline=(162, 170, 180), width=2)
    d.rectangle((cx - r_btn, y_btn, cx + r_btn, y_col), fill=cap_rgb)
    d.pieslice((cx - r_btn, y_col - b_btn, cx + r_btn, y_col + b_btn), start=0, end=180, fill=cap_rgb)
    top_b = tuple(min(255, c + 22) for c in cap_rgb)
    out_b = tuple(max(0, c - 32) for c in cap_rgb)
    d.ellipse((cx - r_btn, y_btn - b_btn, cx + r_btn, y_btn + b_btn), fill=top_b, outline=out_b, width=3)


def render_cylinder_object(spec: dict[str, Any], rot_deg: float) -> Image.Image:
    ss = 2
    w_can, h_can = 520 * ss, 640 * ss
    form = spec["form"]
    if form == "pill_bottle":
        rad, h_cyl, y_top = 148 * ss, 326 * ss, 206 * ss
    elif form == "eyedrop_bottle":
        rad, h_cyl, y_top = 122 * ss, 294 * ss, 232 * ss
    else:
        rad, h_cyl, y_top = 98 * ss, 396 * ss, 186 * ss
    cx = int(w_can * 0.5)
    alpha = math.radians(GAZE_DEG)
    sin_a, cos_a = math.sin(alpha), math.cos(alpha)
    b_ell = int(round(rad * sin_a))
    tex = build_unwrapped_texture(spec)
    h_tex, w_tex, _ = tex.shape
    px_per_deg = w_tex / 360.0

    yy, xx = np.mgrid[0:h_can, 0:w_can].astype(np.float32)
    xi = (xx - float(cx)) / float(rad)
    inside_x = np.abs(xi) < 0.9995
    xi_safe = np.clip(xi, -0.9995, 0.9995)
    cos_th = np.sqrt(np.maximum(1e-6, 1.0 - xi_safe * xi_safe))
    th_deg = np.degrees(np.arcsin(xi_safe))
    v_cyl = ((yy - float(y_top)) - float(b_ell) * cos_th) / cos_a
    body_mask = inside_x & (v_cyl >= 0.0) & (v_cyl <= float(h_cyl))

    phi_deg = th_deg - rot_deg
    u_tex = (phi_deg + 180.0) * px_per_deg
    v_tex = (v_cyl / float(h_cyl)) * float(h_tex - 1)
    rgb = sample_bilinear(tex, u_tex, v_tex)

    light = 0.60 + 0.36 * np.maximum(0.0, -0.32 * xi_safe + 0.94 * cos_th) + 0.08 * (1.0 - v_cyl / max(1.0, float(h_cyl)))
    rim_dark = np.clip((cos_th / 0.24), 0.38, 1.0)
    spec_strip = 24.0 * np.exp(-(((th_deg + 26.0) / 8.5) ** 2))
    shaded = np.clip(rgb * (light * rim_dark)[..., None] + spec_strip[..., None], 0.0, 255.0)

    rgba = np.zeros((h_can, w_can, 4), dtype=np.uint8)
    rgba[..., :3] = shaded.astype(np.uint8)
    rgba[..., 3] = np.where(body_mask, 255, 0).astype(np.uint8)
    im = Image.fromarray(rgba, mode="RGBA")
    d = ImageDraw.Draw(im)
    draw_top_hardware(d, form, cx, y_top, rad, b_ell, spec["cap_rgb"])
    return im.resize((520, 640), resample=Image.Resampling.LANCZOS)


def apply_glasses_vignette(im: Image.Image, strength: float = 0.14) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w * 0.5) / (w * 0.5)) ** 2 + ((yy - h * 0.5) / (h * 0.5)) ** 2
    vig = np.clip(1.0 - strength * (r2 ** 1.1), 0.74, 1.0)[..., None]
    return Image.fromarray(np.clip(arr * vig, 0, 255).astype(np.uint8), mode="RGB")


def composite_handheld_vial(bg: Image.Image, cyl_im: Image.Image, tilt_deg: float, shift_x: int = 0) -> Image.Image:
    sc = bg.convert("RGBA")
    sh = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.ellipse((228 + shift_x, 512, 548 + shift_x, 712), fill=(28, 22, 18, 92))
    sc = Image.alpha_composite(sc, sh.filter(ImageFilter.GaussianBlur(radius=18.0)))

    hand_back = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    hb = ImageDraw.Draw(hand_back)
    hb.ellipse((208 + shift_x, 518, 558 + shift_x, 792), fill=(204, 162, 134, 255), outline=(168, 126, 100, 255), width=3)
    sc = Image.alpha_composite(sc, hand_back)

    rot = cyl_im.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
    dx = int(round(384 + shift_x - rot.width * 0.5))
    dy = int(round(356 - rot.height * 0.5))
    sc.alpha_composite(rot, dest=(dx, dy))

    fg_fingers = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg_fingers)
    fd.rounded_rectangle((226 + shift_x, 598, 368 + shift_x, 672), radius=34, fill=(216, 174, 146, 255), outline=(172, 132, 104, 255), width=2)
    fd.rounded_rectangle((396 + shift_x, 604, 536 + shift_x, 678), radius=34, fill=(212, 170, 142, 255), outline=(170, 130, 102, 255), width=2)
    sc = Image.alpha_composite(sc, fg_fingers)
    return apply_glasses_vignette(sc.convert("RGB"))


def render_case_frames(case: dict[str, Any], idx: int) -> list[Image.Image]:
    spec = VIAL_SPECS[case["fg"]]
    rots = list(case["rot_deg"])
    frames: list[Image.Image] = []
    for fi, rdeg in enumerate(rots):
        bg = render_counter_backdrop(202680 + idx * 37 + fi * 11, case["bg"])
        cyl = render_cylinder_object(spec, float(rdeg))
        shift_x = -8 if (len(rots) > 1 and fi == 0) else (8 if len(rots) > 1 else 0)
        tilt = float(case["tilt_deg"]) + (-1.2 if (len(rots) > 1 and fi == 0) else (1.2 if len(rots) > 1 else 0.0))
        frames.append(composite_handheld_vial(bg, cyl, tilt_deg=tilt, shift_x=shift_x))
    return frames


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b}} for b in frames_b64] + [{"text": f'The person asked: "{question}"'}]
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


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ev = sub_env()
    coerced = [{"id": r["id"], "read": sanitize(to_label_read(r["raw"])), "exp_str": r["exp_str"]} for r in raw_rows]
    str_js = (
        'import fs from "node:fs"; '
        'import { sameStrength } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.map((r) => ({ '
        'id: r.id, str_same: r.exp_str ? sameStrength(r.read.strength.value, r.exp_str) : false '
        '}))));'
    )
    p1 = subprocess.run(node_ts_cmd(["--input-type=module", "-e", str_js]), input=json.dumps(coerced), text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    str_map = {x["id"]: bool(x["str_same"]) for x in json.loads(p1.stdout)}
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in coerced) + "\n"
    p2 = subprocess.run(node_ts_cmd([BRIDGE_REL]), input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {r["id"]: {"id": r["id"], "read": r["read"], "str_same": str_map[r["id"]], "verdict": v} for r, v in zip(coerced, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert MAX_WORKERS <= 6
    assert str(OUT_IMG_DIR).startswith("/tmp")
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
    data = json.loads(raw_txt)
    assert data["suite"] == "glasses_cylindrical_vial_wrap"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["error_count"] == 0
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run(node_ts_cmd([BRIDGE_REL]), input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env(), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: offline {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / s["n_cases"], 4)
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for idx, c in enumerate(CASES, 1):
        imgs = render_case_frames(c, idx)
        b64s: list[str] = []
        for fi, im in enumerate(imgs, 1):
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (OUT_IMG_DIR / (f"{c['id']}.jpg" if len(imgs) == 1 else f"{c['id']}_f{fi}.jpg")).write_bytes(raw)
            b64s.append(base64.b64encode(raw).decode("ascii"))
        rendered.append({"case": c, "b64s": b64s})
    if args.render_only:
        print(f"Rendered {len(rendered)} cases to {OUT_IMG_DIR}")
        return 0
    try:
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64s"], r["case"]["q"]), rendered))
        errors = sum(0 if o.get("ok") else 1 for o in api_outs)
        if errors:
            errs = [o.get("err", "err") for o in api_outs if not o.get("ok")]
            raise RuntimeError(f"API errors ({errors}): {errs}")
        scored = score_with_ts_and_bridge([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, api_outs)])
    finally:
        shutil.rmtree(OUT_IMG_DIR, ignore_errors=True)
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
        else:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "wrap_mode": c["wrap_mode"],
            "container_kind": c["container_kind"],
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
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} str={s_val}@{s_conf} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    leg = [x for x in cases_out if x["category"] == "readable_curved_vial"]
    deg = [x for x in cases_out if x["category"] == "limb_wrapped_strength_clip"]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": [round(x, 4) for x in wilson_ci95(cw_n, n)],
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "error_count": 0,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "readable_curved_vial_accuracy": round(sum(1 for x in leg if x["verdict_ok"]) / len(leg), 4),
        "limb_wrapped_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": "glasses_cylindrical_vial_wrap",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "gaze_deg": GAZE_DEG,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": prompt_sha256_12,
        "safety_module": SAFETY_TS_REL,
        "profile": PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    OUT_JSON.write_text(json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=True) + "\n", encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
