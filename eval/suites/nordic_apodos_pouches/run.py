import argparse
import base64
import copy
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

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

SHM_DIR = pathlib.Path("/dev/shm")
if SHM_DIR.is_dir():
    os.environ["TMPDIR"] = str(SHM_DIR)

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = SHM_DIR / "holdup_apodos"
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
SUITE_NAME = "nordic_apodos_pouches"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
MAX_WORKERS = 3
NOW_ISO = "2026-11-14T14:00:00+02:00"
LOGGED_DOSE_TS = int((datetime.datetime.fromisoformat(NOW_ISO) - datetime.timedelta(minutes=30)).timestamp() * 1000)
STRENGTH_MIN_CONF = 0.80
NAME_HIGH_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "levothyroxine", "name": "Levothyroxine", "ingredient": "levothyroxine", "strength": "100 mikrog", "schedule": ["morning"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

POUCH_SPECS: dict[str, dict[str, str]] = {
    "anja_aml_5": {
        "top": "ANJA ANNOSJAKELU   APTEEKKI",
        "slot": "ILTALAAKE 20:00   1 PUSSI",
        "title": "Amlodipiini",
        "sub": "amlodipiini / amlodipine",
        "str": "5 mg",
        "dose": "1 tabletti iltaisin",
        "foot": "1 tabl (valkoinen)   EXP 2027-09",
    },
    "apodos_biso_2_5": {
        "top": "APODOS DOSPASE   APOTEK",
        "slot": "MORGON 08:00   1 PASE",
        "title": "Bisoprolol",
        "sub": "bisoprolol",
        "str": "2,5 mg",
        "dose": "1 tablett morgon",
        "foot": "1 tabl (vit rund)   EXP 2027-10",
    },
    "anja_levo_100": {
        "top": "ANJA ANNOSJAKELU   APTEEKKI",
        "slot": "AAMULAAKE 08:00   1 PUSSI",
        "title": "Levothyroxine",
        "sub": "levotyroksiini / levothyroxine",
        "str": "100 mikrog",
        "dose": "1 tabletti aamuisin",
        "foot": "1 tabl (valkoinen)   EXP 2027-11",
    },
    "apodos_ato_20": {
        "top": "APODOS DOSPASE   APOTEK",
        "slot": "KVALL 20:00   1 PASE",
        "title": "Atorvastatin",
        "sub": "atorvastatin",
        "str": "20 mg",
        "dose": "1 tablett kvall",
        "foot": "1 tabl (vit oval)   EXP 2027-11",
    },
    "anja_aml_10": {
        "top": "ANJA ANNOSJAKELU   APTEEKKI",
        "slot": "ILTALAAKE 20:00   1 PUSSI",
        "title": "Amlodipiini",
        "sub": "amlodipiini / amlodipine",
        "str": "10 mg",
        "dose": "1 tabletti iltaisin",
        "foot": "1 tabl (valkoinen)   EXP 2027-09",
    },
    "anja_ibu_400": {
        "top": "ANJA ANNOSJAKELU   APTEEKKI",
        "slot": "TARVITTAESSA   1 PUSSI",
        "title": "Ibuprofeeni",
        "sub": "ibuprofeeni / ibuprofen",
        "str": "400 mg",
        "dose": "1 tabletti tarvittaessa kipuun",
        "foot": "1 tabl (valkoinen)   EXP 2027-08",
    },
    "anja_biso_expired": {
        "top": "ANJA ANNOSJAKELU   APTEEKKI",
        "slot": "AAMULAAKE 08:00   1 PUSSI",
        "title": "Bisoprolol",
        "sub": "bisoprololi / bisoprolol",
        "str": "2,5 mg",
        "dose": "1 tabletti aamuisin",
        "foot": "1 tabl (valkoinen)   EXP 2025-03",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "ap_01",
        "category": "sharp_anja_match",
        "mode": "sharp",
        "pouch": "anja_aml_5",
        "q": "Is this my evening Amlodipine pouch?",
        "expected": "match",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "5 mg",
        "logged_med": None,
        "desc": "Sharp Finnish Anja unit-dose sachet Amlodipiini 5 mg matching evening profile",
    },
    {
        "id": "ap_02",
        "category": "sharp_apodos_comma_match",
        "mode": "sharp",
        "pouch": "apodos_biso_2_5",
        "q": "Is this my morning Bisoprolol pouch?",
        "expected": "match",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "2.5 mg",
        "logged_med": None,
        "desc": "Sharp Swedish Apodos unit-dose sachet Bisoprolol 2,5 mg matching 2.5 mg morning profile",
    },
    {
        "id": "ap_03",
        "category": "sharp_anja_microgram_match",
        "mode": "sharp",
        "pouch": "anja_levo_100",
        "q": "Is this my morning thyroid pouch?",
        "expected": "match",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "100 mikrog",
        "logged_med": None,
        "desc": "Sharp Finnish Anja unit-dose sachet Levothyroxine 100 mikrog matching morning profile",
    },
    {
        "id": "ap_04",
        "category": "sharp_apodos_match",
        "mode": "edge_crinkle_sharp",
        "pouch": "apodos_ato_20",
        "q": "Is this my evening Atorvastatin pouch?",
        "expected": "match",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "20 mg",
        "logged_med": None,
        "desc": "Sharp Swedish Apodos unit-dose sachet Atorvastatin 20 mg with off-text film crinkle matching evening profile",
    },
    {
        "id": "ap_05",
        "category": "wrong_strength_sachet",
        "mode": "sharp",
        "pouch": "anja_aml_10",
        "q": "Is this my evening Amlodipine pouch?",
        "expected": "warning",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "10 mg",
        "logged_med": None,
        "desc": "Wrong-strength Finnish Anja sachet Amlodipiini 10 mg against 5 mg evening profile",
    },
    {
        "id": "ap_06",
        "category": "unlisted_nsaid_sachet",
        "mode": "sharp",
        "pouch": "anja_ibu_400",
        "q": "Can I take this painkiller pouch?",
        "expected": "warning",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "400 mg",
        "logged_med": None,
        "desc": "Unlisted PRN pain sachet Ibuprofeeni 400 mg caught by NSAID avoid rule and medication list check",
    },
    {
        "id": "ap_07",
        "category": "expired_sachet",
        "mode": "sharp",
        "pouch": "anja_biso_expired",
        "q": "Is this Bisoprolol pouch safe to take?",
        "expected": "warning",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "2.5 mg",
        "logged_med": None,
        "desc": "Expired Finnish Anja sachet Bisoprolol 2,5 mg printed EXP 2025-03 caught as expired warning",
    },
    {
        "id": "ap_08",
        "category": "already_logged_today",
        "mode": "sharp",
        "pouch": "anja_aml_5",
        "q": "Should I take this evening Amlodipine pouch now?",
        "expected": "warning",
        "name_legible": True,
        "str_legible": True,
        "exp_str": "5 mg",
        "logged_med": "amlodipine",
        "desc": "Sharp Finnish Anja sachet Amlodipiini 5 mg flagged as warning when evening dose is already logged today",
    },
    {
        "id": "ap_09",
        "category": "crinkled_glare_strength",
        "mode": "crinkled_glare_strength",
        "pouch": "anja_aml_5",
        "q": "Is this my evening Amlodipine pouch?",
        "expected": "unsure",
        "name_legible": True,
        "str_legible": False,
        "exp_str": None,
        "logged_med": None,
        "desc": "Crinkled cellophane sachet with specular crease reflection washing out the strength digits and unit",
    },
    {
        "id": "ap_10",
        "category": "faded_thermal_strength",
        "mode": "faded_thermal_strength",
        "pouch": "apodos_biso_2_5",
        "q": "Is this my morning Bisoprolol pouch?",
        "expected": "unsure",
        "name_legible": True,
        "str_legible": False,
        "exp_str": None,
        "logged_med": None,
        "desc": "Apodos sachet with thermal printhead dropout and pocket wear erasing the strength field",
    },
    {
        "id": "ap_11",
        "category": "thumb_occluded_name",
        "mode": "thumb_over_name",
        "pouch": "anja_aml_5",
        "q": "Is this my evening blood pressure pouch?",
        "expected": "unsure",
        "name_legible": False,
        "str_legible": True,
        "exp_str": "5 mg",
        "logged_med": None,
        "desc": "Wearer thumb pinching top half of Anja sachet and covering the medicine name while 5 mg remains visible",
    },
    {
        "id": "ap_12",
        "category": "unlabeled_dosett_compartment",
        "mode": "unlabeled_dosett",
        "pouch": None,
        "q": "Are these loose pills my morning medicine?",
        "expected": "unsure",
        "name_legible": False,
        "str_legible": False,
        "exp_str": None,
        "logged_med": None,
        "desc": "Unlabeled plastic weekly Dosett pill compartment holding loose white tablets with no printed name or strength",
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


def format_compact_json(payload: dict[str, Any]) -> str:
    j = lambda v: json.dumps(v, separators=(",", ":"), ensure_ascii=True)
    head_keys = (
        "suite",
        "generated_at",
        "eval_now_iso",
        "model",
        "thinking_level",
        "prompt_source",
        "prompt_sha256_12",
        "safety_module",
        "profile",
    )
    head = ",\n".join(f" {j(k)}:{j(payload[k])}" for k in head_keys)
    sum_lines = ",\n".join(f"  {j(k)}:{j(v)}" for k, v in payload["summary"].items())
    case_lines = ",\n".join(f"  {j(c)}" for c in payload["cases"])
    return "{\n" + head + ',\n "summary":{\n' + sum_lines + '\n },\n "cases":[\n' + case_lines + "\n ]\n}\n"


def find_node() -> str:
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def sub_env() -> dict[str, str]:
    ev = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if SHM_DIR.is_dir():
        ev["TMPDIR"] = str(SHM_DIR)
    return ev


def case_profile(case: dict[str, Any]) -> dict[str, Any]:
    if not case.get("logged_med"):
        return PROFILE
    prof = copy.deepcopy(PROFILE)
    prof["doseLog"] = [{"medId": str(case["logged_med"]), "ts": LOGGED_DOSE_TS}]
    return prof


def render_nordic_kitchen(seed: int) -> Image.Image:
    size = 768
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / (size - 1.0), yy / (size - 1.0)
    rng = np.random.default_rng(seed)
    wall = ny < 0.34
    r = np.where(wall, 232.0 - 16.0 * (ny / 0.34) + 8.0 * (1.0 - nx), 206.0 - 26.0 * ((ny - 0.34) / 0.66))
    g = np.where(wall, 229.0 - 16.0 * (ny / 0.34) + 7.0 * (1.0 - nx), 178.0 - 24.0 * ((ny - 0.34) / 0.66))
    b = np.where(wall, 222.0 - 14.0 * (ny / 0.34) + 5.0 * (1.0 - nx), 144.0 - 20.0 * ((ny - 0.34) / 0.66))
    grain = np.where(wall, 0.0, np.sin(yy * 0.22 + np.sin(xx * 0.03) * 2.5) * 3.2)
    arr = np.stack([r + grain, g + grain * 0.85, b + grain * 0.65], axis=-1) + rng.normal(0.0, 1.8, (size, size, 3))
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    d = ImageDraw.Draw(im)
    d.line((0, int(size * 0.34), size, int(size * 0.34)), fill=(138, 116, 92), width=3)
    d.rounded_rectangle((598, 152, 694, 260), radius=14, fill=(198, 208, 216), outline=(154, 166, 176), width=2)
    d.arc((680, 176, 720, 236), start=-80, end=80, fill=(164, 176, 186), width=5)
    return im.filter(ImageFilter.GaussianBlur(radius=2.6))


def apply_glasses_vignette(im: Image.Image, strength: float = 0.13) -> Image.Image:
    arr = np.asarray(im, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w * 0.5) / (w * 0.5)) ** 2 + ((yy - h * 0.5) / (h * 0.5)) ** 2
    vig = np.clip(1.0 - strength * (r2 ** 1.15), 0.76, 1.0)[..., None]
    return Image.fromarray(np.clip(arr * vig, 0, 255).astype(np.uint8), mode="RGB")


def draw_thermal_text(mask_draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, size: int) -> None:
    mask_draw.text(xy, text, fill=255, font=ImageFont.load_default(size=size))


def render_sachet_pouch(
    spec: dict[str, str],
    seed: int,
    hide_top_block: bool = False,
    hide_str: bool = False,
    edge_crinkle: bool = False,
) -> Image.Image:
    w, h = 480, 496
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    film = np.full((h, w, 3), [245.0, 246.0, 248.0], dtype=np.float32)
    wave = np.sin(xx * 0.028 + yy * 0.014) * 2.2 + rng.normal(0.0, 1.1, (h, w)).astype(np.float32)
    film += wave[..., None]
    crimp_band = (yy < 32) | (yy > h - 33)
    rib = (np.floor_divide(xx.astype(np.int32), 4) % 2 == 0) & crimp_band
    film[crimp_band] -= 7.0
    film[rib] -= 6.0
    pill_d2 = ((xx - 392.0) / 34.0) ** 2 + ((yy - 322.0) / 34.0) ** 2
    pill_rim = np.exp(-((pill_d2 - 1.0) ** 2) / 0.18) * 10.0
    pill_core = np.clip(1.0 - pill_d2, 0.0, 1.0) * 5.5
    film += pill_core[..., None] - pill_rim[..., None]
    if edge_crinkle:
        ridge1 = np.exp(-(((xx - (418.0 + 0.12 * yy)) / 7.5) ** 2)) * 12.0
        ridge2 = np.exp(-(((xx - (444.0 - 0.09 * yy)) / 6.0) ** 2)) * 9.0
        film += (ridge1 + ridge2)[..., None]
    pouch = Image.fromarray(np.clip(film, 0, 255).astype(np.uint8), mode="RGB")
    pd = ImageDraw.Draw(pouch)
    for x0 in range(8, w - 8, 12):
        pd.line((x0, 33, x0 + 6, 33), fill=(176, 182, 190), width=1)
        pd.line((x0, h - 34, x0 + 6, h - 34), fill=(176, 182, 190), width=1)

    ink_mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(ink_mask)
    if not hide_top_block:
        draw_thermal_text(md, (26, 48), spec["top"], 18)
        draw_thermal_text(md, (26, 74), spec["slot"], 18)
        md.line((26, 104, w - 26, 104), fill=210, width=2)
        draw_thermal_text(md, (26, 118), spec["title"], 38)
        draw_thermal_text(md, (26, 168), spec["sub"], 21)
    if not hide_str:
        draw_thermal_text(md, (26, 208), spec["str"], 42)
    draw_thermal_text(md, (26, 278), spec["dose"], 22)
    md.line((26, 392, w - 26, 392), fill=190, width=1)
    draw_thermal_text(md, (26, 412), spec["foot"], 22)

    m_arr = np.asarray(ink_mask, dtype=np.float32) / 255.0
    dot_grid = 0.88 + 0.12 * (((xx.astype(np.int32) % 2) == 0) | ((yy.astype(np.int32) % 2) == 0)).astype(np.float32)
    alpha = np.clip(m_arr * dot_grid, 0.0, 1.0)[..., None]
    base_arr = np.asarray(pouch, dtype=np.float32)
    ink_rgb = np.array([18.0, 22.0, 28.0], dtype=np.float32)
    out_arr = base_arr * (1.0 - alpha) + ink_rgb * alpha
    out = Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8), mode="RGB")
    ImageDraw.Draw(out).rectangle((0, 0, w - 1, h - 1), outline=(188, 194, 202), width=2)
    return out


def paste_held_pouch(bg: Image.Image, pouch: Image.Image, x: int, y: int, tilt_deg: float = -1.2, draw_bottom_fingers: bool = True) -> Image.Image:
    sc = bg.convert("RGBA")
    w, h = pouch.size
    sh = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x + 8, y + 12, x + w + 8, y + h + 12), radius=8, fill=(44, 34, 24, 88))
    sc = Image.alpha_composite(sc, sh.filter(ImageFilter.GaussianBlur(radius=9.0)))
    p_rgba = pouch.convert("RGBA")
    if abs(tilt_deg) > 0.05:
        rot = p_rgba.rotate(tilt_deg, expand=True, resample=Image.Resampling.BICUBIC)
        rx = int(round(x - (rot.width - w) * 0.5))
        ry = int(round(y - (rot.height - h) * 0.5))
        sc.alpha_composite(rot, dest=(rx, ry))
    else:
        sc.alpha_composite(p_rgba, dest=(x, y))
    if draw_bottom_fingers:
        cx = x + w * 0.5
        hd = ImageDraw.Draw(sc)
        hd.rounded_rectangle((int(cx - 118), y + h - 16, int(cx - 32), y + h + 74), radius=28, fill=(214, 174, 146, 255), outline=(176, 136, 108, 255), width=2)
        hd.rounded_rectangle((int(cx + 32), y + h - 16, int(cx + 118), y + h + 74), radius=28, fill=(208, 168, 140, 255), outline=(172, 132, 104, 255), width=2)
    return sc.convert("RGB")


def apply_crinkle_glare_over_strength(pouch: Image.Image) -> Image.Image:
    arr = np.asarray(pouch, dtype=np.float32).copy()
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    band_y = 228.0 + 9.0 * np.sin(xx * 0.032) - 0.04 * (xx - 180.0)
    dy = (yy - band_y) / 28.0
    dx = (xx - 196.0) / 185.0
    r2 = dx * dx + dy * dy
    core = np.clip(1.45 - 0.92 * r2, 0.0, 1.0)
    crease1 = np.exp(-(((yy - (214.0 + 0.14 * (xx - 120.0))) / 5.5) ** 2)) * np.exp(-(((xx - 220.0) / 210.0) ** 2))
    crease2 = np.exp(-(((yy - (242.0 - 0.11 * (xx - 160.0))) / 6.5) ** 2)) * np.exp(-(((xx - 210.0) / 200.0) ** 2))
    w_tot = np.clip(core + 0.75 * crease1 + 0.70 * crease2, 0.0, 1.0)[..., None]
    arr = arr * (1.0 - w_tot) + 255.0 * w_tot
    arr[r2 <= 0.86] = 255.0
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def apply_thermal_fade_over_strength(pouch: Image.Image, seed: int) -> Image.Image:
    im = pouch.copy()
    d = ImageDraw.Draw(im)
    rng = random.Random(seed)
    for x0 in range(30, 198, 9):
        if rng.random() < 0.45:
            y0 = rng.randint(212, 244)
            d.line((x0, y0, x0, y0 + rng.randint(2, 5)), fill=(228, 230, 234), width=1)
    d.line((24, 228, 224, 228), fill=(234, 236, 239), width=2)
    return im


def apply_thumb_over_top_name(sc: Image.Image, px: int, py: int) -> Image.Image:
    ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.polygon(
        [(0, py + 24), (px + 334, py + 18), (px + 356, py + 112), (px + 330, py + 196), (0, py + 206)],
        fill=(210, 168, 140, 255),
    )
    od.ellipse((px + 258, py + 18, px + 372, py + 196), fill=(210, 168, 140, 255), outline=(170, 128, 100, 255), width=3)
    od.rounded_rectangle((px + 286, py + 44, px + 356, py + 148), radius=24, fill=(236, 206, 188, 255), outline=(188, 150, 126, 255), width=2)
    od.arc((px + 184, py + 42, px + 226, py + 174), start=110, end=250, fill=(176, 134, 106, 220), width=3)
    sh = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon(
        [(px, py + 196), (px + 344, py + 192), (px + 352, py + 208), (px, py + 214)],
        fill=(42, 30, 22, 68),
    )
    out = Image.alpha_composite(sc.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(radius=4.0)))
    return Image.alpha_composite(out, ov).convert("RGB")


def render_unlabeled_dosett(seed: int) -> Image.Image:
    bg = render_nordic_kitchen(seed)
    sc = bg.convert("RGBA")
    tray_x, tray_y, tray_w, tray_h = 84, 286, 600, 196
    sh = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((tray_x + 10, tray_y + 14, tray_x + tray_w + 10, tray_y + tray_h + 14), radius=18, fill=(36, 30, 24, 96))
    sc = Image.alpha_composite(sc, sh.filter(ImageFilter.GaussianBlur(radius=9.0)))

    tray = Image.new("RGBA", sc.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(tray)
    td.rounded_rectangle((tray_x, tray_y, tray_x + tray_w, tray_y + tray_h), radius=18, fill=(168, 204, 232, 236), outline=(104, 146, 182, 255), width=3)
    cell_w = int((tray_w - 24) / 7)
    for idx in range(7):
        cx0 = tray_x + 12 + idx * cell_w
        cx1 = cx0 + cell_w - 4
        cy0, cy1 = tray_y + 16, tray_y + tray_h - 16
        well_fill = (214, 232, 246, 242) if idx == 2 else (190, 218, 240, 228)
        td.rounded_rectangle((cx0, cy0, cx1, cy1), radius=10, fill=well_fill, outline=(118, 158, 192, 255), width=2)
        if idx == 2:
            td.rounded_rectangle((cx0 + 2, tray_y - 78, cx1 - 2, tray_y + 6), radius=10, fill=(228, 242, 252, 164), outline=(140, 176, 206, 220), width=2)
            td.ellipse((cx0 + 16, cy0 + 34, cx0 + 58, cy0 + 76), fill=(250, 251, 253, 255), outline=(204, 210, 218, 255), width=2)
            td.ellipse((cx0 + 26, cy0 + 92, cx0 + 68, cy0 + 134), fill=(249, 250, 252, 255), outline=(204, 210, 218, 255), width=2)
        elif idx in (4, 5):
            td.ellipse((cx0 + 20, cy0 + 58, cx0 + 60, cy0 + 98), fill=(236, 244, 250, 185), outline=(192, 208, 222, 190), width=1)
            td.line((cx0 + 6, cy0 + 12, cx1 - 6, cy0 + 12), fill=(244, 250, 255, 180), width=2)
        else:
            td.line((cx0 + 6, cy0 + 12, cx1 - 6, cy0 + 12), fill=(244, 250, 255, 175), width=2)
    td.rounded_rectangle((244, tray_y + tray_h - 12, 336, tray_y + tray_h + 78), radius=30, fill=(214, 174, 146, 255), outline=(176, 136, 108, 255), width=2)
    td.rounded_rectangle((432, tray_y + tray_h - 12, 524, tray_y + tray_h + 78), radius=30, fill=(208, 168, 140, 255), outline=(172, 132, 104, 255), width=2)
    sc = Image.alpha_composite(sc, tray)
    return apply_glasses_vignette(sc.convert("RGB"))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 202680 + idx * 37
    mode = case["mode"]
    if mode == "unlabeled_dosett":
        return render_unlabeled_dosett(seed)
    spec = POUCH_SPECS[str(case["pouch"])]
    bg = render_nordic_kitchen(seed)
    px, py = 144, 164
    if mode == "sharp":
        pouch = render_sachet_pouch(spec, seed)
        return apply_glasses_vignette(paste_held_pouch(bg, pouch, px, py, tilt_deg=-1.3))
    if mode == "edge_crinkle_sharp":
        pouch = render_sachet_pouch(spec, seed, edge_crinkle=True)
        return apply_glasses_vignette(paste_held_pouch(bg, pouch, px, py, tilt_deg=1.4))
    if mode == "crinkled_glare_strength":
        pouch = render_sachet_pouch(spec, seed, hide_str=True, edge_crinkle=True)
        pouch = apply_crinkle_glare_over_strength(pouch)
        return apply_glasses_vignette(paste_held_pouch(bg, pouch, px, py, tilt_deg=-1.8))
    if mode == "faded_thermal_strength":
        pouch = render_sachet_pouch(spec, seed, hide_str=True)
        pouch = apply_thermal_fade_over_strength(pouch, seed)
        return apply_glasses_vignette(paste_held_pouch(bg, pouch, px, py, tilt_deg=1.1))
    pouch = render_sachet_pouch(spec, seed, hide_top_block=True)
    sc = paste_held_pouch(bg, pouch, px, py, tilt_deg=0.0)
    sc = apply_thumb_over_top_name(sc, px, py)
    return apply_glasses_vignette(sc)


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frame_b64: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [
        {"inlineData": {"mimeType": "image/jpeg", "data": frame_b64}},
        {"text": f'The person asked: "{question}"'},
    ]
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
    sess = requests.Session()
    last = "failed"
    was_timeout = False
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
            was_timeout = False
            last = sanitize(f"HTTP {r.status_code}")
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": last, "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            was_timeout = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            was_timeout = False
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": was_timeout}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    ev = sub_env()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows}), text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    by_id = {r["id"]: r for r in raw_rows}
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": by_id[r["id"]]["profile"], "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=ev, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.png")), "image file in suite dir"
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15000, f"results.json size {len(raw_bytes)} > 15000"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    assert all(ord(ch) < 128 for ch in raw_txt), "non-ASCII in results.json"
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and SLASH2 not in readme_txt and not KEY_RE.search(readme_txt)
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and len(data["profile"].get("meds") or []) == 4
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
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / s["n_cases"], 4)
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    assert s["api_error_count"] == 0 and s["timeout_count"] == 0
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    if not SHM_DIR.is_dir():
        raise RuntimeError("/dev/shm unavailable")
    rendered: list[dict[str, Any]] = []
    try:
        OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        for idx, c in enumerate(CASES, 1):
            im = render_case_image(c, idx)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii"), "profile": case_profile(c)})
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
        timeout_count = sum(1 for o in api_outs if not o.get("ok") and o.get("timeout"))
        api_error_count = sum(1 for o in api_outs if not o.get("ok"))
        if api_error_count or timeout_count:
            raise RuntimeError(f"API errors={api_error_count} timeouts={timeout_count}")
        scored = score_with_ts_and_bridge([
            {"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"], "profile": r["profile"]}
            for r, o in zip(rendered, api_outs)
        ])
    finally:
        shutil.rmtree(OUT_IMG_DIR, ignore_errors=True)

    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        p_val = rd["product"]["value"]
        p_conf = float(rd["product"]["confidence"] or 0.0)
        i_val = rd["ingredient"]["value"]
        i_conf = float(rd["ingredient"]["confidence"] or 0.0)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        str_cw = (s_conf >= STRENGTH_MIN_CONF) if not c["str_legible"] else (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"]))
        name_cw = (not c["name_legible"]) and ((p_val is not None and p_conf >= NAME_HIGH_CONF) or (i_val is not None and i_conf >= NAME_HIGH_CONF))
        cw = bool(false_match or unsafe_reassurance or str_cw or name_cw)
        verdict_ok = bool(pred == c["expected"])
        row: dict[str, Any] = {
            "id": c["id"],
            "category": c["category"],
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
        }
        if c["logged_med"]:
            row["profile"] = r["profile"]
        cases_out.append(sanitize(row))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} name={i_val or p_val} str={s_val}@{s_conf} ms={o['ms']}")

    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    sharp_ids = {c["id"] for c in CASES if c["name_legible"] and c["str_legible"]}
    deg_ids = {c["id"] for c in CASES if not (c["name_legible"] and c["str_legible"])}
    sharp_rows = [x for x in cases_out if x["id"] in sharp_ids]
    deg_rows = [x for x in cases_out if x["id"] in deg_ids]
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
        "api_error_count": api_error_count,
        "timeout_count": timeout_count,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
        "sharp_sachet_verdict_accuracy": round(sum(1 for x in sharp_rows if x["verdict_ok"]) / len(sharp_rows), 4),
        "degraded_or_unlabeled_abstention_rate": round(sum(1 for x in deg_rows if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg_rows), 4),
    }
    payload = sanitize({
        "suite": SUITE_NAME,
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
    OUT_JSON.write_text(format_compact_json(payload), encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
