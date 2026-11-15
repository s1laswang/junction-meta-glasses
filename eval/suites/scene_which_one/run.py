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
import tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BINS = ("/usr/local/bin", "/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = "scene_which_one"
TMP_ROOT = pathlib.Path("/dev/shm") if pathlib.Path("/dev/shm").is_dir() else pathlib.Path(tempfile.gettempdir())
TMP_IMG_DIR = TMP_ROOT / "holdup_scene_which_one"
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
FIND_PROMPT_PATH = REPO / "shared" / "find_prompt.md"
VERIFY_PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCENE_SCHEMA_PATH = REPO / "shared" / "scene_schema.json"
LABEL_SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_MODULE_REL = "server/src/find.ts"
PROMPT_SOURCE = "shared/find_prompt.md+shared/verify_prompt.md+shared/scene_schema.json+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T18:00:00Z"
DOSE_TAKEN_TS = int(datetime.datetime(2026, 11, 14, 14, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)
STRENGTH_MIN_CONF = 0.80
MAX_RESULTS_BYTES = 15360
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{8,}")
B64_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")
DOSE_TOKEN_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|mikrog|ml|iu|%)\b", re.IGNORECASE)

BASE_PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "paracetamol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PACK_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {
        "kind": "medication",
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPINE",
        "sub": "amlodipiini / amlodipine",
        "str": "5 mg",
        "form": "Film-coated tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2027-10",
        "exp_str": "5 mg",
    },
    "aml10": {
        "kind": "medication",
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA  Vnr 09 22 41",
        "title": "AMLODIPINE",
        "sub": "amlodipiini / amlodipine",
        "str": "10 mg",
        "form": "Film-coated tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2027-10",
        "exp_str": "10 mg",
    },
    "aml5_exp": {
        "kind": "medication",
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPINE",
        "sub": "amlodipiini / amlodipine",
        "str": "5 mg",
        "form": "Film-coated tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2024-09",
        "exp_str": "5 mg",
    },
    "ibu400": {
        "kind": "medication",
        "accent": (188, 34, 44),
        "hdr": "ORION PHARMA  Vnr 06 14 28",
        "title": "BURANA",
        "sub": "ibuprofeeni / ibuprofen",
        "str": "400 mg",
        "form": "Film-coated tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2027-11",
        "exp_str": "400 mg",
    },
    "par500": {
        "kind": "medication",
        "accent": (26, 118, 96),
        "hdr": "GSK CONSUMER  Vnr 04 19 55",
        "title": "PANADOL",
        "sub": "parasetamoli / paracetamol",
        "str": "500 mg",
        "form": "Film-coated tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2027-11",
        "exp_str": "500 mg",
    },
    "met500": {
        "kind": "medication",
        "accent": (88, 56, 142),
        "hdr": "ORION PHARMA  Vnr 14 88 05",
        "title": "METFORMIN",
        "sub": "metformiini / metformin",
        "str": "500 mg",
        "form": "Film-coated tablets",
        "pack": "100 tabl.",
        "exp": "EXP 2027-12",
        "exp_str": "500 mg",
    },
    "nap250": {
        "kind": "medication",
        "accent": (176, 68, 28),
        "hdr": "ORION PHARMA  Vnr 01 73 40",
        "title": "PRONAXEN",
        "sub": "naprokseeni / naproxen",
        "str": "250 mg",
        "form": "Tablets",
        "pack": "30 tabl.",
        "exp": "EXP 2027-09",
        "exp_str": "250 mg",
    },
    "asp500": {
        "kind": "medication",
        "accent": (34, 112, 68),
        "hdr": "BAYER NORDIC  Vnr 05 62 11",
        "title": "ASPIRIN",
        "sub": "acetylsalicylic acid",
        "str": "500 mg",
        "form": "Tablets",
        "pack": "20 tabl.",
        "exp": "EXP 2027-08",
        "exp_str": "500 mg",
    },
    "unreadable_back": {
        "kind": "unreadable_box",
        "accent": (118, 124, 134),
    },
    "hazelnut_bar": {
        "kind": "food",
        "accent": (142, 74, 28),
        "hdr": "NORDIC BAKERY   220 g",
        "title": "Hazelnut Oat Bar",
        "ing": [
            "Ingredients: rolled oats (58%),",
            "roasted hazelnuts (18%), honey,",
            "rapeseed oil, cocoa, sea salt.",
        ],
        "alg": [
            "Allergens: contains hazelnuts",
            "(tree nuts), oats (gluten).",
        ],
        "exp": "Best before: 2027-09-18",
        "has_allergen": True,
    },
    "peanut_crunch": {
        "kind": "food",
        "accent": (156, 52, 44),
        "hdr": "ARCTIC SNACKS   300 g",
        "title": "Peanut Crunch Mix",
        "ing": [
            "Ingredients: toasted oats (60%),",
            "roasted peanuts (24%), syrup,",
            "sunflower seeds, sea salt.",
        ],
        "alg": [
            "Allergens: contains peanuts,",
            "oats (gluten).",
        ],
        "exp": "Best before: 2027-10-12",
        "has_allergen": True,
    },
    "safe_oat_biscuits": {
        "kind": "food",
        "accent": (42, 114, 84),
        "hdr": "HELSINKI BAKEHOUSE  250 g",
        "title": "Nordic Oat Biscuits",
        "ing": [
            "Ingredients: wholegrain oats",
            "(78%), rapeseed oil, cane sugar,",
            "sodium bicarbonate, sea salt.",
        ],
        "alg": [
            "Allergens: contains oats",
            "(gluten) only.",
        ],
        "exp": "Best before: 2027-11-24",
        "has_allergen": False,
    },
    "cropped_berry_granola": {
        "kind": "food_cropped",
        "accent": (72, 62, 124),
        "hdr": "NORDIC MILL   375 g",
        "title": "Berry Oat Granola",
        "sub": "Toasted Wholegrain Breakfast Crunch",
    },
    "front_rye_crackers": {
        "kind": "food_front_only",
        "accent": (68, 92, 54),
        "hdr": "HELSINKI CRISPBREAD   180 g",
        "title": "Classic Rye Thins",
        "sub": "Thin Oven-Baked Crispbread",
        "note": "See back of pack for ingredients and allergens.",
        "exp": "Best before: 2027-10-20",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "sw_01",
        "category": "clean_lineup",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("par500", "sharp"), ("ibu400", "sharp"), ("aml5", "sharp")],
        "target": "Which one is my evening pill?",
        "expected_level": "match",
        "expected_pos": "right",
        "expected_item_levels": ["match", "warning", "match"],
        "desc": "Clean 3-box lineup with Panadol left, Burana center, and Amlodipine 5 mg at right",
    },
    {
        "id": "sw_02",
        "category": "clean_lineup",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("aml5", "sharp"), ("par500", "sharp"), ("ibu400", "sharp")],
        "target": "Which one is my evening pill?",
        "expected_level": "match",
        "expected_pos": "left",
        "expected_item_levels": ["match", "match", "warning"],
        "desc": "Clean 3-box lineup with Amlodipine 5 mg at left, Panadol center, and Burana right",
    },
    {
        "id": "sw_03",
        "category": "clean_lineup",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("ibu400", "sharp"), ("aml5", "sharp"), ("par500", "sharp")],
        "target": "Which one is my evening pill?",
        "expected_level": "match",
        "expected_pos": "center",
        "expected_item_levels": ["warning", "match", "match"],
        "desc": "Clean 3-box lineup with Burana left, Amlodipine 5 mg at center, and Panadol right",
    },
    {
        "id": "sw_04",
        "category": "degraded_strength_occlusion",
        "degraded": True,
        "layout": "three_meds",
        "slots": [("par500", "sharp"), ("ibu400", "sharp"), ("aml5", "thumb_occlude")],
        "target": "Which one is my evening pill?",
        "expected_level": "unsure",
        "expected_pos": None,
        "expected_item_levels": ["match", "warning", "unsure"],
        "desc": "Thumb occluding 5 mg strength badge on right Amlodipine box while neighbours stay sharp",
    },
    {
        "id": "sw_05",
        "category": "degraded_blur_and_unreadable",
        "degraded": True,
        "layout": "three_meds",
        "slots": [("aml5", "motion_blur"), ("par500", "sharp"), ("unreadable_back", "unreadable")],
        "target": "Which one is my evening pill?",
        "expected_level": "unsure",
        "expected_pos": None,
        "expected_item_levels": ["unsure", "match", "unsure"],
        "desc": "Motion-blurred left Amlodipine strength badge, sharp center Panadol, and unreadable right carton",
    },
    {
        "id": "sw_06",
        "category": "wrong_strength_trap",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("par500", "sharp"), ("aml10", "sharp"), ("met500", "sharp")],
        "target": "Which one is my evening pill?",
        "expected_level": "warning",
        "expected_pos": "center",
        "expected_item_levels": ["match", "warning", "match"],
        "desc": "Look-alike Amlodipine 10 mg wrong-strength box in center against 5 mg evening profile",
    },
    {
        "id": "sw_07",
        "category": "duplicate_boxes_taken_today",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("met500", "sharp"), ("aml5", "sharp"), ("aml5", "sharp")],
        "target": "Which one is my evening pill?",
        "dose_taken": True,
        "expected_level": "warning",
        "expected_pos": "center",
        "expected_item_levels": ["match", "warning", "warning"],
        "desc": "Duplicate Amlodipine 5 mg boxes at center and right when today evening dose is already logged",
    },
    {
        "id": "sw_08",
        "category": "nsaid_avoid_unlisted",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("ibu400", "sharp"), ("nap250", "sharp"), ("asp500", "sharp")],
        "target": "Can I take Burana 400 mg for pain?",
        "expected_level": "warning",
        "expected_pos": None,
        "expected_item_levels": ["warning", "warning", "warning"],
        "desc": "Unlisted OTC NSAID painkiller lineup (Burana 400 mg, Pronaxen 250 mg, Aspirin 500 mg)",
    },
    {
        "id": "sw_09",
        "category": "food_allergen_table",
        "degraded": False,
        "layout": "three_foods",
        "slots": [("hazelnut_bar", "sharp"), ("peanut_crunch", "sharp"), ("safe_oat_biscuits", "sharp")],
        "target": "Which pack has no nuts?",
        "expected_level": "info",
        "expected_pos": "right",
        "expected_item_levels": ["warning", "warning", "info"],
        "desc": "3 food packs: Hazelnut Bar left, Peanut Crunch center, and nut-free Oat Biscuits right",
    },
    {
        "id": "sw_10",
        "category": "food_cropped_panel",
        "degraded": True,
        "layout": "two_foods_cropped",
        "slots": [("cropped_berry_granola", "cropped"), ("front_rye_crackers", "front_only")],
        "target": "Which pack has no nuts?",
        "expected_level": "unsure",
        "expected_pos": None,
        "expected_item_levels": ["unsure", "unsure"],
        "desc": "2 food packs with bottom-cropped and back-panel-only missing allergen declarations",
    },
    {
        "id": "sw_11",
        "category": "expired_target_med",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("par500", "sharp"), ("aml5_exp", "sharp"), ("met500", "sharp")],
        "target": "Which one is my evening pill?",
        "expected_level": "warning",
        "expected_pos": "center",
        "expected_item_levels": ["match", "warning", "match"],
        "desc": "Expired target Amlodipine 5 mg box (EXP 2024-09) in center between valid neighbours",
    },
    {
        "id": "sw_12",
        "category": "no_target_overview",
        "degraded": False,
        "layout": "three_meds",
        "slots": [("met500", "sharp"), ("ibu400", "sharp"), ("aml5", "sharp")],
        "target": "",
        "expected_level": "info",
        "expected_pos": None,
        "expected_item_levels": ["match", "warning", "match"],
        "desc": "No-target tabletop overview describing Metformin left, Burana center, Amlodipine right",
    },
]


def case_profile(case: dict[str, Any]) -> dict[str, Any]:
    prof = json.loads(json.dumps(BASE_PROFILE))
    if case.get("dose_taken"):
        prof["doseLog"] = [{"medId": "amlodipine", "ts": DOSE_TAKEN_TS}]
    return prof


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    candidates = [pathlib.Path.home() / "momin" / ".env", REPO / ".env"]
    for p in candidates:
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        s = KEY_RE.sub("[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-").replace("\u00b5", "u").replace("\u03bc", "u"))
        return s.encode("ascii", "ignore").decode("ascii")
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


def build_find_prompt_and_schema() -> tuple[str, dict[str, Any], str]:
    find_txt = FIND_PROMPT_PATH.read_text(encoding="utf-8")
    verify_txt = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    scene_txt = SCENE_SCHEMA_PATH.read_text(encoding="utf-8")
    label_txt = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
    full_prompt = find_txt + "\n\n" + verify_txt
    label_schema = inline_refs(json.loads(label_txt))
    scene_raw = json.loads(scene_txt)
    scene_raw.pop("$comment", None)
    scene_raw["properties"]["items"]["items"]["properties"]["read"] = label_schema
    sha12 = hashlib.sha256((full_prompt + scene_txt + label_txt).encode("utf-8")).hexdigest()[:12]
    return full_prompt, scene_raw, sha12


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt(max(0.0, (p * (1.0 - p) + 0.25 * z2n) / n))) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def find_node() -> str:
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def build_node_env() -> tuple[dict[str, str], str]:
    env = dict(os.environ)
    env["GEMINI_API_KEY"] = env.get("GEMINI_API_KEY") or "offline-check"
    env["TMPDIR"] = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
    nm_candidates = [
        REPO / "node_modules",
        REPO.parent / "node_modules",
        pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules"),
    ]
    nm_dirs = [str(p) for p in nm_candidates if p.is_dir()]
    if env.get("NODE_PATH"):
        nm_dirs.append(env["NODE_PATH"])
    if nm_dirs:
        env["NODE_PATH"] = ":".join(nm_dirs)
    tsx_arg = "tsx"
    if not (REPO / "node_modules" / "tsx").exists() and not (REPO.parent / "node_modules" / "tsx").exists():
        shared_loader = pathlib.Path("/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules/tsx/dist/loader.mjs")
        if shared_loader.is_file():
            tsx_arg = str(shared_loader)
    return env, tsx_arg


def pack_scene_item(it: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(it.get("box_2d"), list) and len(it["box_2d"]) == 4:
        out["b"] = [int(round(float(x))) for x in it["box_2d"]]
    if it.get("answers_target") is True:
        out["a"] = True
    rd = it.get("read") if isinstance(it.get("read"), dict) else {}
    out["k"] = str(rd.get("kind") or "unreadable")
    field_map = (
        ("product", "p"),
        ("ingredient", "i"),
        ("strength", "s"),
        ("dosing", "d"),
        ("expiry", "e"),
        ("allergens", "al"),
        ("barcode", "bc"),
    )
    for src_key, short_key in field_map:
        fobj = rd.get(src_key)
        if isinstance(fobj, dict):
            val = fobj.get("value")
            conf = round(float(fobj.get("confidence") or 0.0), 3)
            if val is not None:
                out[short_key] = [val, conf]
    out["r"] = round(float(rd.get("readability") or 0.0), 3)
    if isinstance(rd.get("guidance"), str) and rd["guidance"].strip():
        out["g"] = rd["guidance"].strip()[:120]
    return sanitize(out)


def unpack_scene_item(it: dict[str, Any]) -> dict[str, Any]:
    def to_f(pair: Any) -> dict[str, Any]:
        if isinstance(pair, list) and len(pair) == 2:
            return {"value": pair[0], "confidence": float(pair[1])}
        return {"value": None, "confidence": 0.0}

    rd: dict[str, Any] = {
        "kind": it.get("k", "unreadable"),
        "product": to_f(it.get("p")),
        "ingredient": to_f(it.get("i")),
        "strength": to_f(it.get("s")),
        "dosing": to_f(it.get("d")),
        "expiry": to_f(it.get("e")),
        "allergens": to_f(it.get("al")),
        "barcode": to_f(it.get("bc")),
        "readability": float(it.get("r", 0.0)),
    }
    if isinstance(it.get("g"), str) and it["g"]:
        rd["guidance"] = it["g"]
    res: dict[str, Any] = {"read": rd, "answers_target": bool(it.get("a"))}
    if isinstance(it.get("b"), list) and len(it["b"]) == 4:
        res["box_2d"] = it["b"]
    return res


def render_tabletop(seed: int) -> Image.Image:
    w, h = 1080, 640
    im = Image.new("RGB", (w, h), (224, 219, 210))
    d = ImageDraw.Draw(im)
    rng = random.Random(seed)
    for y in range(206):
        c = int(232 - 20 * (y / 206))
        d.line((0, y, w, y), fill=(c, c - 4, c - 9))
    d.rounded_rectangle((86, 68, 214, 198), radius=10, fill=(198, 202, 206), outline=(170, 176, 182), width=2)
    d.rounded_rectangle((882, 86, 976, 200), radius=14, fill=(92, 118, 136), outline=(66, 92, 108), width=2)
    for y in range(206, h):
        t = (y - 206) / float(h - 206)
        j = rng.randint(-2, 2)
        d.line((0, y, w, y), fill=(int(188 - 28 * t) + j, int(162 - 24 * t) + j, int(132 - 20 * t) + j))
    d.line((0, 206, w, 206), fill=(124, 100, 78), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=1.8))


def paste_on_table(bg: Image.Image, card: Image.Image, x: int, y: int) -> None:
    d = ImageDraw.Draw(bg)
    w, h = card.size
    d.rounded_rectangle((x + 6, y + 8, x + w + 6, y + h + 8), radius=8, fill=(96, 80, 64))
    d.polygon([(x, y), (x + 10, y - 10), (x + w + 10, y - 10), (x + w, y)], fill=(232, 235, 240), outline=(168, 174, 182))
    d.polygon([(x + w, y), (x + w + 10, y - 10), (x + w + 10, y + h - 10), (x + w, y + h)], fill=(214, 219, 226), outline=(160, 166, 174))
    bg.paste(card, (x, y))
    d.rectangle((x, y, x + w - 1, y + h - 1), outline=(156, 162, 170), width=2)


def render_med_card(spec: dict[str, Any], mode: str) -> Image.Image:
    w, h = 316, 360
    if spec["kind"] == "unreadable_box":
        im = Image.new("RGB", (w, h), (242, 244, 247))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, w, 40), fill=spec["accent"])
        for ry in (74, 108, 152, 198, 246, 294):
            d.rectangle((26, ry, w - 44, ry + 14), fill=(182, 186, 192))
        return im.filter(ImageFilter.GaussianBlur(radius=8.5))
    im = Image.new("RGB", (w, h), (250, 251, 253))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w, 44), fill=spec["accent"])
    d.text((16, 13), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=16))
    d.text((16, 58), spec["title"], fill=(14, 20, 28), font=ImageFont.load_default(size=30))
    d.text((16, 100), spec["sub"], fill=(44, 52, 62), font=ImageFont.load_default(size=18))
    d.rounded_rectangle((16, 142, 220, 210), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    if mode == "sharp":
        d.text((30, 156), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=34))
    elif mode == "motion_blur":
        band = Image.new("RGB", (196, 58), (238, 245, 252))
        bd = ImageDraw.Draw(band)
        bd.rectangle((22, 18, 154, 40), fill=(48, 54, 62))
        bd.rectangle((36, 12, 138, 46), fill=(76, 84, 94))
        acc: Image.Image | None = None
        shifts = list(range(-48, 50, 4))
        for idx_s, dx in enumerate(shifts):
            sh = Image.new("RGB", band.size, (238, 245, 252))
            sh.paste(band, (dx, int((idx_s % 3) - 1) * 3))
            acc = sh if acc is None else Image.blend(acc, sh, 1.0 / (idx_s + 1))
        assert acc is not None
        im.paste(acc.filter(ImageFilter.GaussianBlur(radius=7.5)), (20, 147))
        d.rounded_rectangle((16, 142, 220, 210), radius=8, outline=spec["accent"], width=3)
    d.text((16, 232), spec["form"], fill=(58, 66, 76), font=ImageFont.load_default(size=16))
    d.text((16, h - 46), f"{spec['pack']}    {spec['exp']}", fill=(20, 26, 34), font=ImageFont.load_default(size=19))
    return im


def render_food_card(spec: dict[str, Any], w: int = 316, h: int = 380) -> Image.Image:
    im = Image.new("RGB", (w, h), (249, 245, 237))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w, 44), fill=spec["accent"])
    d.text((16, 13), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=15))
    d.text((16, 56), spec["title"], fill=(18, 22, 28), font=ImageFont.load_default(size=25))
    if spec["kind"] == "food_front_only":
        d.text((16, 98), spec["sub"], fill=(54, 60, 66), font=ImageFont.load_default(size=18))
        d.rounded_rectangle((16, 142, w - 16, 252), radius=8, fill=(240, 236, 226), outline=(176, 170, 158), width=2)
        d.text((28, 172), "CRISPY NORDIC RYE", fill=(52, 68, 44), font=ImageFont.load_default(size=22))
        d.text((28, 206), spec["note"], fill=(68, 72, 76), font=ImageFont.load_default(size=15))
        d.text((16, h - 46), spec["exp"], fill=(22, 26, 30), font=ImageFont.load_default(size=18))
        return im
    if spec["kind"] == "food_cropped":
        d.text((16, 98), spec["sub"], fill=(54, 60, 66), font=ImageFont.load_default(size=18))
        d.rounded_rectangle((16, 138, w - 16, 210), radius=8, fill=(242, 238, 248), outline=spec["accent"], width=2)
        d.text((26, 156), "HIGH FIBRE BREAKFAST", fill=(42, 36, 78), font=ImageFont.load_default(size=20))
        return im
    d.rounded_rectangle((14, 96, w - 14, 206), radius=7, fill=(254, 253, 250), outline=(184, 178, 166), width=2)
    for idx_ln, ln in enumerate(spec["ing"]):
        d.text((22, 108 + idx_ln * 28), ln, fill=(22, 26, 28), font=ImageFont.load_default(size=16))
    alg_fill = (255, 242, 230) if spec["has_allergen"] else (236, 248, 240)
    alg_out = (192, 112, 54) if spec["has_allergen"] else (42, 114, 84)
    d.rounded_rectangle((14, 218, w - 14, 308), radius=7, fill=alg_fill, outline=alg_out, width=2)
    for idx_ln, ln in enumerate(spec["alg"]):
        d.text((22, 232 + idx_ln * 30), ln, fill=(20, 26, 24), font=ImageFont.load_default(size=17))
    d.text((16, h - 44), spec["exp"], fill=(22, 26, 30), font=ImageFont.load_default(size=18))
    return im


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    sc = render_tabletop(202611 + idx * 53)
    layout = case["layout"]
    if layout == "three_meds":
        xs = (34, 382, 730)
        for (pack_id, mode), x in zip(case["slots"], xs):
            card = render_med_card(PACK_SPECS[pack_id], mode)
            paste_on_table(sc, card, x, 228)
            if mode == "thumb_occlude":
                ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
                od = ImageDraw.Draw(ov)
                od.rounded_rectangle((x + 6, 360, x + 236, 448), radius=36, fill=(76, 62, 50, 96))
                od.rounded_rectangle((x + 2, 356, x + 232, 442), radius=36, fill=(214, 174, 146, 255), outline=(174, 134, 106, 255), width=3)
                od.rounded_rectangle((x + 14, 368, x + 64, 428), radius=18, fill=(236, 206, 188, 255), outline=(188, 150, 126, 255), width=1)
                sc = Image.alpha_composite(sc.convert("RGBA"), ov).convert("RGB")
        return sc
    if layout == "three_foods":
        xs = (34, 382, 730)
        for (pack_id, _mode), x in zip(case["slots"], xs):
            card = render_food_card(PACK_SPECS[pack_id], 316, 380)
            paste_on_table(sc, card, x, 214)
        return sc
    left_spec = PACK_SPECS[case["slots"][0][0]]
    right_spec = PACK_SPECS[case["slots"][1][0]]
    left_card = render_food_card(left_spec, 420, 240)
    sc.paste(left_card.crop((0, 0, 420, 170)), (76, 470))
    d = ImageDraw.Draw(sc)
    d.rectangle((76, 470, 495, 639), outline=(156, 162, 170), width=2)
    right_card = render_food_card(right_spec, 420, 360)
    paste_on_table(sc, right_card, 584, 228)
    return sc


def call_flash_scene(api_key: str, prompt: str, schema: dict[str, Any], frame_b64: str, target: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    user_text = f'The person asked: "{target.strip()[:200]}"' if target.strip() else "Describe which package is which."
    parts = [
        {"inlineData": {"mimeType": "image/jpeg", "data": frame_b64}},
        {"text": user_text},
    ]
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 8192,
        },
    }
    import requests
    sess = requests.Session()
    last = "failed"
    timed_out = False
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
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": timed_out}


def gt_slot_meta(case: dict[str, Any]) -> list[dict[str, Any]]:
    meta: list[dict[str, Any]] = []
    for pack_id, mode in case["slots"]:
        sp = PACK_SPECS[pack_id]
        is_deg = mode in ("thumb_occlude", "motion_blur", "unreadable", "cropped", "front_only")
        meta.append({
            "pack_id": pack_id,
            "mode": mode,
            "degraded": is_deg,
            "exp_str": None if is_deg else sp.get("exp_str"),
            "has_allergen": bool(sp.get("has_allergen", False)),
        })
    return meta


def score_scenes_with_find_ts(rows: list[dict[str, Any]], verify_meta: bool = False) -> tuple[dict[str, dict[str, Any]], dict[str, Any] | None]:
    node = find_node()
    env, tsx_arg = build_node_env()
    ts_code = (
        'import fs from "node:fs"; '
        'import assert from "node:assert/strict"; '
        'import { FIND_PROMPT, SCENE_SCHEMA, toRawItems, buildSceneVerdict } from "./server/src/find.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'const rows = inp.rows.map((r) => { '
        'const rawItems = toRawItems(r.raw); '
        'const verdict = buildSceneVerdict(rawItems, r.profile, r.target, new Date(r.now)); '
        'const items = (verdict.items || []).map((it, idx) => { '
        'const gt = (r.gt || [])[idx] || null; '
        'return { '
        'position: it.position, '
        'level: it.level, '
        'headline: it.headline, '
        'matchedMedId: it.matchedMedId || null, '
        'strength_val: it.read.strength.value, '
        'strength_conf: it.read.strength.confidence, '
        'allergens_conf: it.read.allergens.confidence, '
        'str_same: Boolean(gt && gt.exp_str && sameStrength(it.read.strength.value, gt.exp_str)), '
        'alg_hits: allergenHits(it.read, r.profile.allergies).length '
        '}; '
        '}); '
        'return { id: r.id, verdict, items }; '
        '}); '
        'let meta = null; '
        'if (inp.verifyMeta) { '
        'const prof = inp.baseProfile; '
        'const now = new Date(inp.nowIso); '
        'const mkMed = (ing, str, sc = 0.99, exp = "2027-10") => ({ '
        'kind: "medication", product: { value: ing.toUpperCase(), confidence: 0.99 }, '
        'ingredient: { value: ing, confidence: 0.99 }, strength: { value: str, confidence: sc }, '
        'dosing: { value: null, confidence: 0 }, expiry: { value: exp, confidence: 0.98 }, '
        'allergens: { value: null, confidence: 0 }, barcode: { value: null, confidence: 0 }, readability: 0.95 '
        '}); '
        'const boxes = [[300, 40, 800, 310], [300, 380, 800, 650], [300, 720, 800, 980]]; '
        'const perms = [[0, 1, 2, "left"], [1, 0, 2, "center"], [2, 0, 1, "right"]]; '
        'for (const [ia, ib, ic, wantPos] of perms) { '
        'const vSwap = buildSceneVerdict(toRawItems({ items: [ '
        '{ box_2d: boxes[ic], read: mkMed("paracetamol", "500 mg") }, '
        '{ box_2d: boxes[ia], read: mkMed("amlodipine", "5 mg"), answers_target: true }, '
        '{ box_2d: boxes[ib], read: mkMed("ibuprofen", "400 mg") } '
        '] }), prof, "Which one is my evening pill?", now); '
        'assert.equal(vSwap.level, "match"); '
        'assert.equal(vSwap.items.find((x) => x.matchedMedId === "amlodipine").position, wantPos); '
        '} '
        'const vDup = buildSceneVerdict(toRawItems({ items: [ '
        '{ box_2d: boxes[0], read: mkMed("amlodipine", "5 mg") }, '
        '{ box_2d: boxes[1], read: mkMed("ibuprofen", "400 mg") }, '
        '{ box_2d: boxes[2], read: mkMed("amlodipine", "10 mg") } '
        '] }), prof, "Which one is my evening pill?", now); '
        'assert.equal(vDup.level, "match"); '
        'assert.equal(vDup.items[0].level, "match"); '
        'assert.equal(vDup.items[2].level, "warning"); '
        'const vUnr = buildSceneVerdict(toRawItems({ items: [ '
        '{ box_2d: boxes[0], answers_target: true, read: { kind: "unreadable", readability: 0.1 } }, '
        '{ box_2d: boxes[1], read: mkMed("ibuprofen", "400 mg") } '
        '] }), prof, "Which one is my evening pill?", now); '
        'assert.equal(vUnr.level, "unsure"); '
        'assert.equal(vUnr.items[1].level, "warning"); '
        'const vLow = buildSceneVerdict(toRawItems({ items: [ '
        '{ box_2d: boxes[0], read: mkMed("amlodipine", "5 mg", 0.79), answers_target: true }, '
        '{ box_2d: boxes[1], read: mkMed("paracetamol", "500 mg", 0.99) } '
        '] }), prof, "Which one is my evening pill?", now); '
        'assert.equal(vLow.level, "unsure"); '
        'assert.ok(!vLow.speech.includes("5 mg") && !vLow.headline.includes("5 mg") && !vLow.items[0].headline.includes("5 mg")); '
        'meta = { promptLen: FIND_PROMPT.length, schema: SCENE_SCHEMA, invariantsOk: true }; '
        '} '
        'process.stdout.write(JSON.stringify({ rows, meta }));'
    )
    proc = subprocess.run(
        [node, "--import", tsx_arg, "--input-type=module", "-e", ts_code],
        input=json.dumps({"rows": rows, "verifyMeta": verify_meta, "baseProfile": BASE_PROFILE, "nowIso": NOW_ISO}),
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=env,
        timeout=30,
        check=True,
    )
    parsed = json.loads(proc.stdout)
    by_id = {r["id"]: sanitize(r) for r in parsed["rows"]}
    return by_id, parsed.get("meta")


def derive_predicted_position(case: dict[str, Any], items: list[dict[str, Any]], pred_level: str) -> str | None:
    if not items:
        return None
    if case["category"] == "food_allergen_table":
        hit = next((it for it in items if it["level"] == "info"), None)
        return hit["position"] if hit else None
    if pred_level in ("match", "warning") and case.get("expected_pos"):
        aml = next((it for it in items if it["matchedMedId"] == "amlodipine" or "amlodipine" in it["headline"].lower()), None)
        if aml:
            return aml["position"]
    return None


def evaluate_case(case: dict[str, Any], scored_row: dict[str, Any], latency_ms: float, packed_items: list[dict[str, Any]]) -> dict[str, Any]:
    vd = scored_row["verdict"]
    items = scored_row["items"]
    pred = str(vd["level"])
    exp = str(case["expected_level"])
    gt_list = gt_slot_meta(case)
    pred_pos = derive_predicted_position(case, items, pred)
    exp_pos = case.get("expected_pos")
    pos_ok = (exp_pos is None) or (pred_pos == exp_pos)
    item_levels = [str(it["level"]) for it in items]
    item_positions = [str(it["position"]) for it in items]
    exp_positions = ["left", "right"] if len(gt_list) == 2 else ["left", "center", "right"]
    items_ok = item_levels == case["expected_item_levels"] and item_positions == exp_positions

    pos_swap_false_match = bool(pred == "match" and exp_pos is not None and pred_pos != exp_pos)
    false_match = bool((pred == "match" and exp != "match") or pos_swap_false_match)
    unsafe_reassurance = bool(
        (exp == "warning" and pred in ("match", "info"))
        or (case["category"] == "food_cropped_panel" and (pred in ("match", "info") or any(lv in ("match", "info") for lv in item_levels)))
    )

    item_cw = False
    low_conf_leak = False
    for idx_i, it in enumerate(items):
        s_val = it["strength_val"]
        s_conf = float(it["strength_conf"] or 0.0)
        if s_conf < STRENGTH_MIN_CONF:
            if DOSE_TOKEN_RE.search(str(it["headline"])):
                low_conf_leak = True
            if pred == "match" and exp_pos is not None and it["position"] == pred_pos:
                low_conf_leak = True
        gt = gt_list[idx_i] if idx_i < len(gt_list) else None
        if gt is None:
            continue
        if gt["degraded"]:
            if s_conf >= STRENGTH_MIN_CONF or DOSE_TOKEN_RE.search(str(it["headline"])):
                item_cw = True
        elif gt["exp_str"] is not None:
            if s_conf >= STRENGTH_MIN_CONF and (s_val is None or not it["str_same"]):
                item_cw = True
        else:
            if s_val is not None and s_conf >= STRENGTH_MIN_CONF:
                item_cw = True
            if gt["has_allergen"] and float(it["allergens_conf"] or 0.0) >= 0.80 and int(it["alg_hits"]) == 0:
                item_cw = True

    cw = bool(false_match or unsafe_reassurance or item_cw or low_conf_leak)
    verdict_ok = bool(pred == exp and pos_ok and items_ok and not cw)
    return sanitize({
        "id": case["id"],
        "category": case["category"],
        "description": case["desc"],
        "question": case["target"],
        "expected_level": exp,
        "predicted_level": pred,
        "expected_position": exp_pos,
        "predicted_position": pred_pos,
        "verdict_ok": verdict_ok,
        "confident_wrong": cw,
        "false_match": false_match,
        "unsafe_reassurance": unsafe_reassurance,
        "pos_swap": pos_swap_false_match,
        "dose_leak": low_conf_leak,
        "latency_ms": latency_ms,
        "headline": vd["headline"],
        "reasons": list(vd["reasons"])[:4],
        "scene_items": packed_items,
    })


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= MAX_RESULTS_BYTES, f"results.json size {len(raw_bytes)} > {MAX_RESULTS_BYTES}"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt) and not B64_RE.search(raw_txt)
    assert all(ord(ch) < 128 for ch in raw_txt), "non-ASCII in results.json"
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"

    data = json.loads(raw_txt)
    prompt_txt, scene_schema, sha12 = build_find_prompt_and_schema()
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == sha12
    assert data["safety_module"] == SAFETY_MODULE_REL
    assert data["errors"] == 0 and data["timeouts"] == 0

    cases = data["cases"]
    case_defs = {c["id"]: c for c in CASES}
    assert len(cases) == len(CASES) == 12
    replay_rows = []
    for c in cases:
        cdef = case_defs[c["id"]]
        unpacked = {"items": [unpack_scene_item(it) for it in c["scene_items"]]}
        replay_rows.append({
            "id": c["id"],
            "raw": unpacked,
            "profile": case_profile(cdef),
            "target": c["question"],
            "now": data["eval_now_iso"],
            "gt": gt_slot_meta(cdef),
        })

    re_scored, ts_meta = score_scenes_with_find_ts(replay_rows, verify_meta=True)
    assert ts_meta is not None and ts_meta["invariantsOk"] is True
    assert ts_meta["promptLen"] == len(prompt_txt)
    assert ts_meta["schema"] == scene_schema

    for c in cases:
        cdef = case_defs[c["id"]]
        re_eval = evaluate_case(cdef, re_scored[c["id"]], float(c["latency_ms"]), c["scene_items"])
        assert re_eval["predicted_level"] == c["predicted_level"], f"{c['id']}: {re_eval['predicted_level']} != {c['predicted_level']}"
        assert re_eval["predicted_position"] == c["predicted_position"], f"{c['id']}: position mismatch"
        assert re_eval["verdict_ok"] == c["verdict_ok"], f"{c['id']}: verdict_ok mismatch"
        assert re_eval["confident_wrong"] == c["confident_wrong"] is False, f"{c['id']}: confident_wrong"
        assert re_eval["false_match"] == c["false_match"] is False, f"{c['id']}: false_match"
        assert re_eval["unsafe_reassurance"] == c["unsafe_reassurance"] is False, f"{c['id']}: unsafe_reassurance"
        assert re_eval["pos_swap"] == c["pos_swap"] is False, f"{c['id']}: pos_swap"
        assert re_eval["dose_leak"] == c["dose_leak"] is False, f"{c['id']}: dose_leak"

    s = data["summary"]
    assert s["n_cases"] == 12
    assert s["errors"] == 0 and s["timeouts"] == 0
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["unsafe_reassurance"]) == 0
    assert s["position_swap_false_match_count"] == sum(1 for c in cases if c["pos_swap"]) == 0
    assert s["low_conf_dose_leak_count"] == sum(1 for c in cases if c["dose_leak"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def format_compact_results(payload: dict[str, Any]) -> str:
    top_parts: list[str] = ["{"]
    keys = [k for k in payload.keys() if k != "cases"]
    for k in keys:
        top_parts.append(f'"{k}":{json.dumps(payload[k], separators=(",", ":"), ensure_ascii=True)},')
    top_parts.append('"cases":[')
    case_lines = [json.dumps(c, separators=(",", ":"), ensure_ascii=True) for c in payload["cases"]]
    top_parts.append(",\n".join(case_lines))
    top_parts.append("]}")
    return "\n".join(top_parts) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()

    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")

    prompt_txt, scene_schema, sha12 = build_find_prompt_and_schema()
    TMP_IMG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            im = render_case_image(c, idx)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw_jpg = buf.getvalue()
            (TMP_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw_jpg)
            rendered.append({"case": c, "b64": base64.b64encode(raw_jpg).decode("ascii")})

        with ThreadPoolExecutor(max_workers=4) as ex:
            api_outs = list(ex.map(lambda r: call_flash_scene(api_key, prompt_txt, scene_schema, r["b64"], r["case"]["target"]), rendered))
    finally:
        shutil.rmtree(TMP_IMG_DIR, ignore_errors=True)

    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    timeouts = sum(1 for o in api_outs if o.get("timeout"))
    if errors or timeouts:
        errs = [f"{r['case']['id']}:{o.get('err')}" for r, o in zip(rendered, api_outs) if not o.get("ok")]
        raise RuntimeError(f"API errors={errors} timeouts={timeouts} details={errs}")

    score_inputs = []
    packed_by_id: dict[str, list[dict[str, Any]]] = {}
    for r, o in zip(rendered, api_outs):
        c = r["case"]
        raw_items_list = (o["raw"].get("items") or [])[:6] if isinstance(o["raw"], dict) else []
        packed = [pack_scene_item(it) for it in raw_items_list if isinstance(it, dict)]
        packed_by_id[c["id"]] = packed
        score_inputs.append({
            "id": c["id"],
            "raw": {"items": [unpack_scene_item(it) for it in packed]},
            "profile": case_profile(c),
            "target": c["target"],
            "now": NOW_ISO,
            "gt": gt_slot_meta(c),
        })

    scored_map, _ = score_scenes_with_find_ts(score_inputs, verify_meta=True)
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c = r["case"]
        cid = c["id"]
        row_out = evaluate_case(c, scored_map[cid], float(o["ms"]), packed_by_id[cid])
        cases_out.append(row_out)
        print(
            f"[{cid}] exp={row_out['expected_level']} pred={row_out['predicted_level']} "
            f"pos={row_out['predicted_position']} ok={row_out['verdict_ok']} cw={row_out['confident_wrong']} ms={row_out['latency_ms']}"
        )

    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["unsafe_reassurance"])
    ps_n = sum(1 for x in cases_out if x["pos_swap"])
    dl_n = sum(1 for x in cases_out if x["dose_leak"])
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    pos_cases = [x for x in cases_out if x["expected_position"] is not None]
    pos_ok_n = sum(1 for x in pos_cases if x["predicted_position"] == x["expected_position"])
    deg_cases = [x for x in cases_out if next(c["degraded"] for c in CASES if c["id"] == x["id"])]
    lats = [float(x["latency_ms"]) for x in cases_out]

    summary = {
        "n_cases": n,
        "errors": errors,
        "timeouts": timeouts,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "spatial_position_matches": pos_ok_n,
        "spatial_position_cases": len(pos_cases),
        "spatial_position_accuracy": round(pos_ok_n / len(pos_cases), 4) if pos_cases else 1.0,
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "position_swap_false_match_count": ps_n,
        "low_conf_dose_leak_count": dl_n,
        "abstain_or_unsure_count": abs_n,
        "degraded_abstention_rate": round(sum(1 for x in deg_cases if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg_cases), 4),
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
    }
    payload = sanitize({
        "suite": SUITE_NAME,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "eval_now_iso": NOW_ISO,
        "model": MODEL,
        "thinking_level": THINKING_LEVEL,
        "prompt_source": PROMPT_SOURCE,
        "prompt_sha256_12": sha12,
        "safety_module": SAFETY_MODULE_REL,
        "errors": errors,
        "timeouts": timeouts,
        "profile": BASE_PROFILE,
        "summary": summary,
        "cases": cases_out,
    })
    OUT_JSON.write_text(format_compact_results(payload), encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
