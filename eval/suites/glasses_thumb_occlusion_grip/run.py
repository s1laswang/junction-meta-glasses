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
OUT_IMG_DIR = TMP_BASE / "holdup_glasses_thumb_occlusion_grip"
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
GAZE_DEG = 30.0
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Norvasc", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PACK_SPECS: dict[str, dict[str, Any]] = {
    "norvasc5": {
        "kind": "medication",
        "substrate": "carton_white",
        "accent": (24, 96, 168),
        "hdr": "PFIZER  Vnr 01 49 22",
        "title": "NORVASC",
        "ing": "amlodipine",
        "str": "5 mg",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 2027-11",
        "pack_note": "30 film-coated tablets",
    },
    "norvasc10": {
        "kind": "medication",
        "substrate": "carton_white",
        "accent": (20, 82, 152),
        "hdr": "PFIZER  Vnr 01 49 38",
        "title": "NORVASC",
        "ing": "amlodipine",
        "str": "10 mg",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 2027-11",
        "pack_note": "30 film-coated tablets",
    },
    "metf500": {
        "kind": "medication",
        "substrate": "blister_foil",
        "accent": (20, 118, 108),
        "hdr": "ORION PHARMA  Vnr 14 88 05",
        "title": "METFORMIN",
        "ing": "metformin",
        "str": "500 mg",
        "dose": "1 tablet morning and evening",
        "exp": "EXP 2027-12",
        "pack_note": "60 tablets",
    },
    "biso25": {
        "kind": "medication",
        "substrate": "carton_white",
        "accent": (88, 56, 146),
        "hdr": "ORION PHARMA  Vnr 08 31 14",
        "title": "BISOPROLOL",
        "ing": "bisoprolol",
        "str": "2.5 mg",
        "dose": "1 tablet once daily in the morning",
        "exp": "EXP 2027-10",
        "pack_note": "30 tablets",
    },
    "burana400": {
        "kind": "medication",
        "substrate": "carton_white",
        "accent": (188, 34, 44),
        "hdr": "ORION PHARMA  Vnr 06 14 28",
        "title": "BURANA",
        "ing": "ibuprofen",
        "str": "400 mg",
        "dose": "1 tablet as needed for acute pain",
        "exp": "EXP 2027-10",
        "pack_note": "20 film-coated tablets",
    },
    "hazelnut_bar": {
        "kind": "food",
        "substrate": "pouch_cream",
        "accent": (146, 78, 32),
        "hdr": "NORDIC KITCHEN  Net 55 g",
        "title": "HAZELNUT MUESLI BAR",
        "sub": "Crunchy oat and nut snack bar",
        "ing1": "Ingredients: rolled oats, roasted hazelnuts (18%),",
        "ing2": "wildflower honey, sunflower oil.",
        "alg1": "ALLERGENS: OATS (GLUTEN), HAZELNUT.",
        "alg2": "May contain: peanut.",
        "exp": "Best before 2027-09-18",
    },
    "oat_drink": {
        "kind": "food",
        "substrate": "pouch_cream",
        "accent": (36, 108, 138),
        "hdr": "NORDIC HARVEST  1 L",
        "title": "NORDIC OAT DRINK",
        "sub": "Plant-based barista oat drink",
        "ing1": "Ingredients: water, rolled oats (10%),",
        "ing2": "rapeseed oil, sea salt.",
        "alg1": "ALLERGENS: OATS (GLUTEN).",
        "alg2": "Free from tree nuts and peanuts.",
        "exp": "Best before 2027-11-24",
    },
    "morning_muesli": {
        "kind": "food",
        "substrate": "pouch_cream",
        "accent": (52, 114, 68),
        "hdr": "NORDIC HARVEST  Net 450 g",
        "title": "NORDIC MORNING MUESLI",
        "sub": "Toasted breakfast cereal",
        "ing1": "Ingredients: rolled oats, roasted almonds (14%),",
        "ing2": "dried apple pieces, honey.",
        "alg1": "ALLERGENS: OATS (GLUTEN), ALMOND.",
        "alg2": "May contain: peanut.",
        "exp": "Best before 2027-10-15",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "tg_01",
        "category": "safe_perimeter_grip",
        "grip_mode": "bottom_left_corner_pinch",
        "pack_kind": "medication_carton",
        "degraded": False,
        "fg": "norvasc5",
        "poses": [{"grip": "bl_pinch", "tilt": -2.4, "sx": 0}],
        "bg": "oak_table",
        "q": "Is this my evening blood pressure pill?",
        "expected": "match",
        "exp_str": "5 mg",
        "desc": "Glasses POV (~30 deg) bottom-left thumb pinch on Norvasc 5 mg carton leaving identity and strength clear",
    },
    {
        "id": "tg_02",
        "category": "safe_perimeter_grip",
        "grip_mode": "lower_right_foil_pinch",
        "pack_kind": "blister_pack",
        "degraded": False,
        "fg": "metf500",
        "poses": [{"grip": "br_pinch", "tilt": 2.2, "sx": 4}],
        "bg": "kitchen_granite",
        "q": "Is this my Metformin?",
        "expected": "match",
        "exp_str": "500 mg",
        "desc": "Glasses POV (~30 deg) lower-right thumb pinch on Metformin 500 mg foil blister card keeping 500 mg clear",
    },
    {
        "id": "tg_03",
        "category": "safe_perimeter_grip",
        "grip_mode": "bottom_rim_two_finger_cradle",
        "pack_kind": "medication_carton",
        "degraded": False,
        "fg": "norvasc10",
        "poses": [{"grip": "bottom_cradle", "tilt": -1.8, "sx": -4}],
        "bg": "living_room_lap",
        "q": "Is this my evening Amlodipine?",
        "expected": "warning",
        "exp_str": "10 mg",
        "desc": "Glasses POV (~30 deg) bottom-rim finger cradle on wrong-strength Norvasc 10 mg carton vs prescribed 5 mg",
    },
    {
        "id": "tg_04",
        "category": "safe_perimeter_grip",
        "grip_mode": "top_right_corner_pinch",
        "pack_kind": "medication_carton",
        "degraded": False,
        "fg": "burana400",
        "poses": [{"grip": "tr_pinch", "tilt": 2.6, "sx": 2}],
        "bg": "bathroom_counter",
        "q": "Can I take this for my headache?",
        "expected": "warning",
        "exp_str": "400 mg",
        "desc": "Glasses POV (~30 deg) upper-right thumb pinch on Burana ibuprofen 400 mg carton triggering NSAID warning",
    },
    {
        "id": "tg_05",
        "category": "safe_perimeter_grip",
        "grip_mode": "lower_right_seam_pinch_food",
        "pack_kind": "food_wrapper",
        "degraded": False,
        "fg": "hazelnut_bar",
        "poses": [{"grip": "food_br_pinch", "tilt": -2.0, "sx": 0}],
        "bg": "oak_table",
        "q": "Is this snack bar safe with my nut allergies?",
        "expected": "warning",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) corner pinch on Hazelnut Muesli Bar wrapper leaving hazelnut and peanut text legible",
    },
    {
        "id": "tg_06",
        "category": "safe_perimeter_grip",
        "grip_mode": "top_corner_pinch_safe_food",
        "pack_kind": "food_carton",
        "degraded": False,
        "fg": "oat_drink",
        "poses": [{"grip": "tr_pinch", "tilt": 1.6, "sx": -2}],
        "bg": "kitchen_granite",
        "q": "Can I drink this with my nut allergies?",
        "expected": "info",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) upper-right thumb pinch on Nordic Oat Drink carton with legible nut-free allergen box",
    },
    {
        "id": "tg_07",
        "category": "critical_thumb_occlusion",
        "grip_mode": "thumbpad_over_strength_badge",
        "pack_kind": "medication_carton",
        "degraded": True,
        "fg": "norvasc5",
        "poses": [{"grip": "occ_str_thumb_lr", "tilt": -2.5, "sx": 0}],
        "bg": "oak_table",
        "q": "Is this my evening blood pressure pill?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) right thumbpad pressed directly over Norvasc strength badge occluding 5 mg",
    },
    {
        "id": "tg_08",
        "category": "critical_thumb_occlusion",
        "grip_mode": "angled_pinch_over_digits_and_unit",
        "pack_kind": "blister_pack",
        "degraded": True,
        "fg": "metf500",
        "poses": [{"grip": "occ_str_thumb_ur", "tilt": 2.4, "sx": 4}],
        "bg": "kitchen_granite",
        "q": "Is this my Metformin?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) angled upper-right thumb grip covering Metformin 500 mg digits and mg unit",
    },
    {
        "id": "tg_09",
        "category": "critical_thumb_occlusion",
        "grip_mode": "side_fingers_over_decimal_strength",
        "pack_kind": "medication_carton",
        "degraded": True,
        "fg": "biso25",
        "poses": [{"grip": "occ_str_two_finger", "tilt": -2.1, "sx": -4}],
        "bg": "living_room_lap",
        "q": "Is this my morning Bisoprolol?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) two side-wrapped fingers covering Bisoprolol 2.5 mg decimal strength box",
    },
    {
        "id": "tg_10",
        "category": "critical_thumb_occlusion",
        "grip_mode": "palmar_four_finger_fist_wrap",
        "pack_kind": "medication_carton",
        "degraded": True,
        "fg": "norvasc5",
        "poses": [{"grip": "occ_palmar_wrap", "tilt": 1.9, "sx": 0}],
        "bg": "bathroom_counter",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) palmar four-finger wrap across carton front occluding name, ingredient, and strength",
    },
    {
        "id": "tg_11",
        "category": "critical_thumb_occlusion",
        "grip_mode": "bimanual_grip_over_allergen_panel",
        "pack_kind": "food_carton",
        "degraded": True,
        "fg": "morning_muesli",
        "poses": [{"grip": "occ_food_allergens", "tilt": -1.5, "sx": 0}],
        "bg": "oak_table",
        "q": "Is this cereal safe with my nut allergies?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Glasses POV (~30 deg) bimanual thumbs and fingers covering ingredients and allergens box on muesli carton",
    },
    {
        "id": "tg_12",
        "category": "critical_thumb_occlusion",
        "grip_mode": "two_frame_persistent_thumb_shift",
        "pack_kind": "medication_carton",
        "degraded": True,
        "fg": "norvasc5",
        "poses": [
            {"grip": "occ_str_shift_f1", "tilt": -3.2, "sx": -10},
            {"grip": "occ_str_shift_f2", "tilt": 1.8, "sx": 10},
        ],
        "bg": "living_room_lap",
        "q": "Is this my evening Amlodipine?",
        "expected": "unsure",
        "exp_str": None,
        "desc": "Two-frame glasses POV (~30 deg) slight thumb shift where Norvasc 5 mg stays occluded under thumb in both",
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
    if (REPO / "node_modules" / "tsx").is_dir():
        return [node, "--import", "tsx", *extra_args]
    return [node, *extra_args]


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_DIR.is_dir():
        ev["TMPDIR"] = str(SHM_DIR)
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


def render_backdrop(seed: int, style: str) -> Image.Image:
    size = 768
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / (size - 1.0), yy / (size - 1.0)
    rng = np.random.default_rng(seed)
    if style == "oak_table":
        grain = np.sin(ny * 44.0 + 0.4 * np.sin(nx * 8.5)) * 7.0
        r = 182.0 - 24.0 * ny + grain + 12.0 * (1.0 - nx)
        g = 148.0 - 20.0 * ny + grain * 0.76 + 9.0 * (1.0 - nx)
        b = 112.0 - 16.0 * ny + grain * 0.50 + 6.0 * (1.0 - nx)
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 2.2, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        d.ellipse((556, 36, 728, 178), fill=(228, 232, 236), outline=(182, 188, 194), width=5)
        d.ellipse((580, 56, 704, 156), fill=(112, 78, 52))
        return im.filter(ImageFilter.GaussianBlur(radius=3.6))
    if style == "living_room_lap":
        weave = 4.0 * np.sin(xx * 0.35) + 3.5 * np.cos(yy * 0.32)
        r = 146.0 - 18.0 * ny + weave
        g = 152.0 - 18.0 * ny + weave
        b = 164.0 - 14.0 * ny + weave * 1.1
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 2.5, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        d.polygon([(80, 768), (220, 560), (560, 560), (700, 768)], fill=(92, 108, 132))
        return im.filter(ImageFilter.GaussianBlur(radius=4.2))
    if style == "bathroom_counter":
        r = 214.0 - 16.0 * ny + 8.0 * nx
        g = 222.0 - 16.0 * ny + 8.0 * nx
        b = 226.0 - 12.0 * ny + 6.0 * nx
        arr = np.stack([r, g, b], axis=-1) + rng.normal(0.0, 1.8, (size, size, 3))
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        d = ImageDraw.Draw(im)
        for gx in (140, 340, 540):
            d.line((gx, 0, gx - 24, size), fill=(188, 196, 202), width=2)
        for gy in (150, 350, 550):
            d.line((0, gy, size, gy + 12), fill=(188, 196, 202), width=2)
        return im.filter(ImageFilter.GaussianBlur(radius=3.2))
    speck = rng.normal(0.0, 6.2, (size, size, 1))
    r = 196.0 - 18.0 * ny + speck[..., 0]
    g = 198.0 - 18.0 * ny + speck[..., 0]
    b = 202.0 - 16.0 * ny + speck[..., 0]
    im = Image.fromarray(np.clip(np.stack([r, g, b], axis=-1), 0, 255).astype(np.uint8), mode="RGB")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((42, 44, 214, 158), radius=16, fill=(214, 222, 228), outline=(168, 176, 184), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=3.4))


def build_pack_card(spec: dict[str, Any], seed: int) -> Image.Image:
    w_c, h_c = 500, 340
    mask = Image.new("L", (w_c, h_c), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w_c - 1, h_c - 1), radius=14, fill=255)
    rng = np.random.default_rng(seed)
    if spec["substrate"] == "blister_foil":
        yy, xx = np.mgrid[0:h_c, 0:w_c].astype(np.float32)
        shimmer = 9.0 * np.sin(xx * 0.045 + yy * 0.02) + rng.normal(0.0, 2.4, (h_c, w_c))
        base_arr = np.clip(232.0 + shimmer[..., None] + np.array([0.0, 2.0, 5.0]), 205, 252).astype(np.uint8)
        card = Image.fromarray(base_arr, mode="RGB")
    elif spec["substrate"] == "pouch_cream":
        base_arr = np.clip(np.array([252.0, 249.0, 242.0]) + rng.normal(0.0, 1.4, (h_c, w_c, 3)), 235, 255).astype(np.uint8)
        card = Image.fromarray(base_arr, mode="RGB")
    else:
        base_arr = np.clip(np.array([250.0, 251.0, 253.0]) + rng.normal(0.0, 1.2, (h_c, w_c, 3)), 238, 255).astype(np.uint8)
        card = Image.fromarray(base_arr, mode="RGB")
    d = ImageDraw.Draw(card)
    d.rectangle((0, 0, w_c, 48), fill=spec["accent"])
    d.text((22, 14), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=18))
    if spec["kind"] == "medication":
        if spec["substrate"] == "blister_foil":
            for bx in (42, 142):
                for by in (238, 286):
                    d.ellipse((bx, by, bx + 54, by + 30), fill=(214, 220, 228), outline=(176, 184, 194), width=2)
        else:
            for bx in range(26, 146, 6):
                bw = 2 if (bx % 12 == 0) else 3
                d.rectangle((bx, 252, bx + bw, 296), fill=(32, 36, 42))
        d.text((24, 62), spec["title"], fill=(12, 18, 28), font=ImageFont.load_default(size=35))
        d.text((24, 114), "Active ingredient:", fill=(62, 70, 82), font=ImageFont.load_default(size=16))
        d.text((24, 135), spec["ing"], fill=(16, 24, 34), font=ImageFont.load_default(size=24))
        d.rounded_rectangle((300, 92, 476, 180), radius=10, fill=(238, 245, 252), outline=spec["accent"], width=3)
        s_txt = spec["str"]
        s_font = ImageFont.load_default(size=32 if len(s_txt) >= 6 else 35)
        d.text((324, 118), s_txt, fill=(10, 16, 24), font=s_font)
        d.text((24, 194), spec["dose"], fill=(34, 42, 52), font=ImageFont.load_default(size=18))
        d.text((26, 304), spec["pack_note"], fill=(68, 76, 86), font=ImageFont.load_default(size=15))
        d.text((198, 266), spec["exp"], fill=(18, 24, 32), font=ImageFont.load_default(size=22))
        d.text((374, 270), "LOT M42A", fill=(74, 82, 92), font=ImageFont.load_default(size=16))
    else:
        d.text((24, 60), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=29))
        d.text((24, 97), spec["sub"], fill=(64, 72, 82), font=ImageFont.load_default(size=17))
        d.rounded_rectangle((20, 136, 480, 256), radius=8, fill=(255, 255, 255), outline=(168, 176, 186), width=2)
        d.text((32, 146), spec["ing1"], fill=(28, 34, 42), font=ImageFont.load_default(size=17))
        d.text((32, 169), spec["ing2"], fill=(28, 34, 42), font=ImageFont.load_default(size=17))
        d.text((32, 199), spec["alg1"], fill=(12, 16, 22), font=ImageFont.load_default(size=17))
        d.text((32, 223), spec["alg2"], fill=(12, 16, 22), font=ImageFont.load_default(size=17))
        d.text((26, 284), spec["exp"], fill=(20, 26, 34), font=ImageFont.load_default(size=20))
        d.text((378, 286), "LOT F19K", fill=(78, 84, 92), font=ImageFont.load_default(size=16))
    d.rounded_rectangle((0, 0, w_c - 1, h_c - 1), radius=14, outline=(178, 186, 196), width=2)
    rgba = card.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def draw_digit_capsule(
    fg_rgba: Image.Image,
    sh_rgba: Image.Image,
    p0: tuple[float, float],
    p1: tuple[float, float],
    width: float,
    seed: int,
    with_nail: bool = True,
) -> None:
    w_im, h_im = fg_rgba.size
    rad = width * 0.5
    pad = int(math.ceil(rad + 22))
    x0 = max(0, int(math.floor(min(p0[0], p1[0]) - pad)))
    x1 = min(w_im, int(math.ceil(max(p0[0], p1[0]) + pad)))
    y0 = max(0, int(math.floor(min(p0[1], p1[1]) - pad)))
    y1 = min(h_im, int(math.ceil(max(p0[1], p1[1]) + pad)))
    if x1 <= x0 or y1 <= y0:
        return
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    seg_len = max(1.0, math.hypot(dx, dy))
    tx, ty = dx / seg_len, dy / seg_len
    nx, ny = -ty, tx

    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    rx, ry = xx - p0[0], yy - p0[1]
    s = rx * tx + ry * ty
    u = rx * nx + ry * ny
    sc = np.clip(s, 0.0, seg_len)
    r_loc = rad * (1.0 + 0.05 * np.exp(-(((s - 0.82 * seg_len) / max(8.0, 0.24 * seg_len)) ** 2)))
    dist = np.hypot(s - sc, u)

    alpha = np.clip((r_loc - dist + 0.8) / 1.4, 0.0, 1.0)
    alpha = np.where(dist <= (r_loc - 0.7), 1.0, alpha)

    u_norm = np.clip(u / np.maximum(1.0, r_loc), -1.0, 1.0)
    nz = np.sqrt(np.maximum(0.02, 1.0 - u_norm * u_norm))
    tip_taper = np.clip(1.0 - np.maximum(0.0, s - seg_len) / max(1.0, rad), 0.35, 1.0)
    shade = 0.74 + 0.28 * nz * tip_taper - 0.08 * (u_norm * 0.5)
    crease1 = np.exp(-(((s - (seg_len - 1.35 * rad) - 0.06 * (u * u) / max(1.0, rad)) / 2.2) ** 2))
    crease2 = np.exp(-(((s - (seg_len - 1.58 * rad) - 0.05 * (u * u) / max(1.0, rad)) / 2.0) ** 2))
    crease_drop = (11.0 * crease1 + 8.0 * crease2) * (np.abs(u_norm) < 0.72)

    rng = np.random.default_rng(seed)
    micro = rng.normal(0.0, 1.6, xx.shape).astype(np.float32)
    base_skin = np.array([214.0, 170.0, 144.0], dtype=np.float32)
    rgb = base_skin[None, None, :] * shade[..., None] - crease_drop[..., None] + micro[..., None]

    if with_nail:
        ns = (s - (seg_len - 0.22 * rad)) / max(1.0, 0.78 * rad)
        nu = u / max(1.0, 0.56 * rad)
        nail_r = np.hypot(ns, nu)
        nail_mask = (nail_r <= 1.0) & (dist <= r_loc - 2.0)
        lunula = nail_mask & (np.hypot((ns + 0.58) / 0.45, nu / 0.78) <= 1.0)
        free_edge = nail_mask & (ns > 0.72)
        nail_col = np.array([232.0, 194.0, 182.0], dtype=np.float32) * (0.88 + 0.14 * nz)[..., None]
        rgb = np.where(nail_mask[..., None], nail_col, rgb)
        rgb = np.where(lunula[..., None], np.array([242.0, 224.0, 216.0], dtype=np.float32), rgb)
        rgb = np.where(free_edge[..., None], np.array([244.0, 236.0, 228.0], dtype=np.float32), rgb)

    patch = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    patch[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    patch[..., 3] = np.round(alpha * 255.0).astype(np.uint8)
    fg_rgba.alpha_composite(Image.fromarray(patch, mode="RGBA"), dest=(x0, y0))

    sx_off, sy_off = 8, 10
    dist_s = np.hypot((s - sy_off * ty - sx_off * tx) - np.clip(s - sy_off * ty - sx_off * tx, 0.0, seg_len), u - sx_off * nx - sy_off * ny)
    sh_a = np.clip((r_loc + 4.0 - dist_s) / 9.0, 0.0, 1.0) * 108.0
    sh_patch = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    sh_patch[..., 0] = 20
    sh_patch[..., 1] = 16
    sh_patch[..., 2] = 14
    sh_patch[..., 3] = np.round(sh_a).astype(np.uint8)
    sh_rgba.alpha_composite(Image.fromarray(sh_patch, mode="RGBA"), dest=(x0, y0))


def grip_segments(grip_name: str) -> tuple[list[tuple[float, float, float, float]], list[tuple[tuple[float, float], tuple[float, float], float, bool]]]:
    cx0, cy0 = 130.0, 80.0
    c = lambda x, y: (cx0 + x, cy0 + y)
    if grip_name == "bl_pinch":
        return ([(84, 340, 280, 560)], [(c(-46, 376), c(116, 278), 80.0, True)])
    if grip_name == "br_pinch":
        return ([(480, 340, 676, 560)], [(c(548, 374), c(406, 282), 78.0, True)])
    if grip_name == "bottom_cradle":
        return (
            [(180, 380, 580, 565)],
            [
                (c(76, 420), c(142, 326), 76.0, True),
                (c(432, 420), c(392, 326), 72.0, True),
            ],
        )
    if grip_name == "tr_pinch":
        return ([(490, 18, 686, 210)], [(c(548, -26), c(426, 30), 74.0, True)])
    if grip_name == "food_br_pinch":
        return ([(484, 344, 680, 560)], [(c(548, 372), c(418, 304), 74.0, True)])
    if grip_name == "occ_str_thumb_lr":
        return ([(490, 170, 710, 470)], [(c(544, 174), c(356, 136), 116.0, True)])
    if grip_name == "occ_str_thumb_ur":
        return ([(496, 70, 712, 340)], [(c(544, 94), c(356, 138), 116.0, True)])
    if grip_name == "occ_str_two_finger":
        return (
            [(500, 110, 714, 410)],
            [
                (c(544, 112), c(352, 114), 78.0, True),
                (c(544, 168), c(354, 162), 78.0, True),
            ],
        )
    if grip_name == "occ_palmar_wrap":
        return (
            [(46, 54, 280, 440)],
            [
                (c(-56, 24), c(472, 22), 68.0, True),
                (c(-56, 80), c(484, 78), 70.0, True),
                (c(-56, 138), c(478, 138), 70.0, True),
                (c(-56, 196), c(456, 196), 66.0, True),
                (c(-48, -10), c(-48, 220), 84.0, False),
            ],
        )
    if grip_name == "occ_food_allergens":
        return (
            [(46, 210, 260, 520), (500, 210, 714, 520)],
            [
                (c(-54, 168), c(278, 166), 86.0, True),
                (c(-54, 228), c(272, 226), 86.0, True),
                (c(546, 196), c(222, 196), 138.0, True),
            ],
        )
    if grip_name == "occ_str_shift_f1":
        return ([(490, 174, 710, 470)], [(c(544, 178), c(354, 132), 116.0, True)])
    return ([(492, 156, 710, 462)], [(c(544, 152), c(358, 142), 116.0, True)])


def perspective_downward_gaze(im: Image.Image) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, ch = arr.shape
    out = np.zeros_like(arr)
    yy = np.arange(h, dtype=np.float32)
    t = yy / max(1.0, float(h - 1))
    scale_x = 0.94 + 0.09 * t
    temple_shift = -8.0 * (1.0 - t)
    xx_base = np.arange(w, dtype=np.float32)
    for r_idx in range(h):
        sy = int(round((t[r_idx] ** 0.96) * (h - 1)))
        src_x = (xx_base - w * 0.5 - temple_shift[r_idx]) / scale_x[r_idx] + w * 0.5
        valid = (src_x >= 0.0) & (src_x < float(w - 1))
        sx0 = np.clip(np.floor(src_x).astype(np.int32), 0, w - 2)
        fx = (src_x - sx0)[..., None]
        row = arr[sy, sx0] * (1.0 - fx) + arr[sy, sx0 + 1] * fx
        out[r_idx] = np.where(valid[..., None], row, 0.0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGBA")


def apply_glasses_vignette(im: Image.Image, strength: float = 0.14) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w * 0.5) / (w * 0.5)) ** 2 + ((yy - h * 0.5) / (h * 0.5)) ** 2
    vig = np.clip(1.0 - strength * (r2 ** 1.1), 0.74, 1.0)[..., None]
    return Image.fromarray(np.clip(arr * vig, 0, 255).astype(np.uint8), mode="RGB")


def render_single_pose(spec: dict[str, Any], pose: dict[str, Any], bg_style: str, seed: int) -> Image.Image:
    bg = render_backdrop(seed, bg_style).convert("RGBA")
    w_a, h_a = 760, 580
    assembly = Image.new("RGBA", (w_a, h_a), (0, 0, 0, 0))
    palms, digits = grip_segments(pose["grip"])

    back_hand = Image.new("RGBA", (w_a, h_a), (0, 0, 0, 0))
    bd = ImageDraw.Draw(back_hand)
    for px0, py0, px1, py1 in palms:
        bd.ellipse((px0, py0, px1, py1), fill=(196, 152, 126, 255), outline=(162, 120, 96, 255), width=3)
    assembly.alpha_composite(back_hand)

    drop = Image.new("RGBA", (w_a, h_a), (0, 0, 0, 0))
    ImageDraw.Draw(drop).rounded_rectangle((140, 94, 640, 434), radius=16, fill=(22, 18, 15, 96))
    assembly.alpha_composite(drop.filter(ImageFilter.GaussianBlur(radius=14.0)))

    card = build_pack_card(spec, seed + 5)
    assembly.alpha_composite(card, dest=(130, 80))

    fg_digits = Image.new("RGBA", (w_a, h_a), (0, 0, 0, 0))
    sh_digits = Image.new("RGBA", (w_a, h_a), (0, 0, 0, 0))
    for di, (p0, p1, width, w_nail) in enumerate(digits):
        draw_digit_capsule(fg_digits, sh_digits, p0, p1, width, seed + 31 + di * 7, with_nail=w_nail)

    sh_blur = sh_digits.filter(ImageFilter.GaussianBlur(radius=6.0))
    card_alpha = Image.new("L", (w_a, h_a), 0)
    card_alpha.paste(card.getchannel("A"), (130, 80))
    sh_np = np.asarray(sh_blur).copy()
    ca_np = np.asarray(card_alpha, dtype=np.float32) / 255.0
    sh_np[..., 3] = np.round(sh_np[..., 3].astype(np.float32) * ca_np).astype(np.uint8)
    assembly.alpha_composite(Image.fromarray(sh_np, mode="RGBA"))
    assembly.alpha_composite(fg_digits)

    warped = perspective_downward_gaze(assembly)
    rotated = warped.rotate(float(pose["tilt"]), expand=True, resample=Image.Resampling.BICUBIC)
    dx = int(round(384 + int(pose["sx"]) - rotated.width * 0.5))
    dy = int(round(404 - rotated.height * 0.5))
    bg.alpha_composite(rotated, dest=(dx, dy))
    return apply_glasses_vignette(bg.convert("RGB"))


def render_case_frames(case: dict[str, Any], idx: int) -> list[Image.Image]:
    spec = PACK_SPECS[case["fg"]]
    frames: list[Image.Image] = []
    for fi, pose in enumerate(case["poses"]):
        frames.append(render_single_pose(spec, pose, case["bg"], 202690 + idx * 41 + fi * 13))
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
    assert data["suite"] == "glasses_thumb_occlusion_grip"
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
            "grip_mode": c["grip_mode"],
            "pack_kind": c["pack_kind"],
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
    leg = [x for x in cases_out if x["category"] == "safe_perimeter_grip"]
    deg = [x for x in cases_out if x["category"] == "critical_thumb_occlusion"]
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
        "safe_perimeter_grip_accuracy": round(sum(1 for x in leg if x["verdict_ok"]) / len(leg), 4),
        "critical_thumb_occlusion_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
    }
    payload = sanitize({
        "suite": "glasses_thumb_occlusion_grip",
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
