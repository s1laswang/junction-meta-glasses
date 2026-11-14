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
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

os.environ["TZ"] = "Europe/Helsinki"
if hasattr(time, "tzset"):
    time.tzset()
if os.path.isdir("/dev/shm"):
    os.environ["TMPDIR"] = "/dev/shm"
for _nb in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T20:30:00+02:00"
STRENGTH_MIN_CONF = 0.80
MATCH_NAME_MIN_CONF = 0.80
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")


def iso_ms(iso_str: str) -> int:
    return int(datetime.datetime.fromisoformat(iso_str).timestamp() * 1000)


PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "bisoprolol", "name": "Emconcor", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["08:00"]},
        {"id": "simvastatin", "name": "Simvastatin", "ingredient": "simvastatin", "strength": "20 mg", "schedule": ["21:30"]},
        {"id": "panadol", "name": "Panadol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {
        "id": "dd_01",
        "category": "once_daily_untaken",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [],
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPINE 5 mg",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 08/2027",
        "accent": (20, 102, 148),
        "q": "Is this my evening pill, and have I taken it today?",
        "expected": "match",
        "exp_str": "5 mg",
        "dup_block": False,
        "desc": "Once-daily Amlodipine 5 mg (evening schedule) with empty doseLog at 20:30",
    },
    {
        "id": "dd_02",
        "category": "once_daily_duplicate",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [{"medId": "amlodipine", "ts": iso_ms("2026-11-14T19:15:00+02:00")}],
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPIN ORION 5 mg",
        "sub": "Active ingredient: amlodipine (as besilate)",
        "str": "5 mg",
        "form": "tablets",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 10/2027",
        "accent": (24, 92, 152),
        "q": "Can I take my evening Amlodipine now?",
        "expected": "warning",
        "exp_str": "5 mg",
        "dup_block": True,
        "desc": "Once-daily Amlodipine 5 mg with 1 dose already logged today at 19:15",
    },
    {
        "id": "dd_03",
        "category": "midnight_reset_yesterday",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [{"medId": "amlodipine", "ts": iso_ms("2026-11-13T23:55:00+02:00")}],
        "hdr": "SANDOZ  Vnr 11 32 08",
        "title": "AMLODIPINE SANDOZ 5 mg",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "form": "tablets",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 09/2027",
        "accent": (28, 86, 144),
        "q": "Did I take this today or was that last night?",
        "expected": "match",
        "exp_str": "5 mg",
        "dup_block": False,
        "desc": "Once-daily Amlodipine 5 mg with 1 dose logged yesterday before midnight (day-boundary reset)",
    },
    {
        "id": "dd_04",
        "category": "midnight_post_boundary",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [{"medId": "amlodipine", "ts": iso_ms("2026-11-14T02:05:00+02:00")}],
        "hdr": "ACTAVIS  Vnr 09 18 44",
        "title": "AMLODIPIN ACTAVIS 5 mg",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet once daily",
        "exp": "EXP 11/2027",
        "accent": (32, 96, 158),
        "q": "Is it safe to take my Amlodipine 5 mg tonight?",
        "expected": "warning",
        "exp_str": "5 mg",
        "dup_block": True,
        "desc": "Once-daily Amlodipine 5 mg with 1 dose logged today post-midnight (00:05 UTC / 02:05 EET)",
    },
    {
        "id": "dd_05",
        "category": "twice_daily_partial",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "metformin",
        "schedule": ["morning", "evening"],
        "dose_log": [{"medId": "metformin", "ts": iso_ms("2026-11-14T08:15:00+02:00")}],
        "hdr": "ORION PHARMA  Vnr 14 29 71",
        "title": "METFORMIN 500 mg",
        "sub": "Active ingredient: metformin hydrochloride",
        "str": "500 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet morning and evening with meals",
        "exp": "EXP 12/2027",
        "accent": (24, 108, 118),
        "q": "Can I take my evening Metformin now?",
        "expected": "match",
        "exp_str": "500 mg",
        "dup_block": False,
        "desc": "Twice-daily Metformin 500 mg (morning, evening) with 1 of 2 doses logged today at 08:15",
    },
    {
        "id": "dd_06",
        "category": "twice_daily_complete",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "metformin",
        "schedule": ["morning", "evening"],
        "dose_log": [
            {"medId": "metformin", "ts": iso_ms("2026-11-14T08:15:00+02:00")},
            {"medId": "metformin", "ts": iso_ms("2026-11-14T19:45:00+02:00")},
        ],
        "hdr": "TEVA  Vnr 42 18 65",
        "title": "METFORMIN TEVA 500 mg",
        "sub": "Active ingredient: metformin hydrochloride",
        "str": "500 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet twice daily",
        "exp": "EXP 07/2027",
        "accent": (22, 104, 134),
        "q": "Have I already taken both Metformin doses today?",
        "expected": "warning",
        "exp_str": "500 mg",
        "dup_block": True,
        "desc": "Twice-daily Metformin 500 mg with 2 doses already logged today at 08:15 and 19:45",
    },
    {
        "id": "dd_07",
        "category": "clock_schedule_taken",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "bisoprolol",
        "schedule": ["08:00"],
        "dose_log": [{"medId": "bisoprolol", "ts": iso_ms("2026-11-14T08:10:00+02:00")}],
        "hdr": "MERCK  Vnr 01 66 40",
        "title": "EMCONCOR 2.5 mg",
        "sub": "Active ingredient: bisoprolol fumarate",
        "str": "2.5 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet once daily at 08:00",
        "exp": "EXP 06/2027",
        "accent": (148, 52, 68),
        "q": "Can I take this Emconcor tablet now?",
        "expected": "warning",
        "exp_str": "2.5 mg",
        "dup_block": True,
        "desc": "Clock-schedule Emconcor / bisoprolol 2.5 mg (08:00) with 1 dose logged today at 08:10",
    },
    {
        "id": "dd_08",
        "category": "clock_schedule_untaken",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "simvastatin",
        "schedule": ["21:30"],
        "dose_log": [],
        "hdr": "KRKA  Vnr 51 09 33",
        "title": "SIMVASTATIN 20 mg",
        "sub": "Active ingredient: simvastatin",
        "str": "20 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet in the evening at 21:30",
        "exp": "EXP 09/2027",
        "accent": (72, 66, 138),
        "q": "Is this my night cholesterol pill?",
        "expected": "match",
        "exp_str": "20 mg",
        "dup_block": False,
        "desc": "Clock-schedule Simvastatin 20 mg (21:30) with empty doseLog",
    },
    {
        "id": "dd_09",
        "category": "wrong_strength_precedence",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [],
        "hdr": "ORION PHARMA  Vnr 08 44 55",
        "title": "AMLODIPINE 10 mg",
        "sub": "Active ingredient: amlodipine",
        "str": "10 mg",
        "form": "tablets",
        "dose": "1 tablet once daily",
        "exp": "EXP 08/2027",
        "accent": (172, 46, 38),
        "q": "Is this my 5 mg evening Amlodipine?",
        "expected": "warning",
        "exp_str": "10 mg",
        "dup_block": False,
        "desc": "Wrong-strength precedence: Amlodipine 10 mg carton checked against 5 mg profile",
    },
    {
        "id": "dd_10",
        "category": "expired_precedence",
        "degraded": False,
        "mode": "med_clean",
        "med_id": "panadol",
        "schedule": ["as needed"],
        "dose_log": [],
        "hdr": "HALEON NORDIC  Vnr 05 82 19",
        "title": "PANADOL 500 mg",
        "sub": "Active ingredient: paracetamol",
        "str": "500 mg",
        "form": "film-coated tablets",
        "dose": "1 tablet as needed for pain",
        "exp": "EXP 04/2025",
        "accent": (22, 94, 162),
        "q": "Can I take this Panadol 500 mg?",
        "expected": "warning",
        "exp_str": "500 mg",
        "dup_block": False,
        "desc": "Expired precedence: Panadol 500 mg carton expired EXP 04/2025 with empty doseLog",
    },
    {
        "id": "dd_11",
        "category": "degraded_strength_zero_guess",
        "degraded": True,
        "mode": "med_thumb_glare",
        "med_id": "amlodipine",
        "schedule": ["evening"],
        "dose_log": [{"medId": "amlodipine", "ts": iso_ms("2026-11-14T19:15:00+02:00")}],
        "hdr": "ORION PHARMA  Vnr 08 44 12",
        "title": "AMLODIPINE",
        "sub": "Active ingredient: amlodipine",
        "form": "film-coated tablets",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 08/2027",
        "accent": (20, 102, 148),
        "q": "Is this my 5 mg evening Amlodipine?",
        "expected": "unsure",
        "exp_str": None,
        "dup_block": False,
        "desc": "Degraded zero-guess precedence: thumb and glare occluding strength digits on Amlodipine with 1 dose logged today",
    },
    {
        "id": "dd_12",
        "category": "degraded_name_zero_guess",
        "degraded": True,
        "mode": "med_blur_crop",
        "med_id": "metformin",
        "schedule": ["morning", "evening"],
        "dose_log": [{"medId": "metformin", "ts": iso_ms("2026-11-14T08:15:00+02:00")}],
        "hdr": "ORION PHARMA",
        "frag": "RMIN",
        "form": "tablets",
        "accent": (24, 108, 118),
        "q": "Is this my Metformin box for my second dose?",
        "expected": "unsure",
        "exp_str": None,
        "dup_block": False,
        "desc": "Degraded zero-guess precedence: motion-blurred and cropped medicine name on Metformin carton with 1 of 2 doses logged",
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
    for p in ("/tmp/fleet-silas/node/bin/node", "/home/silas/tools/node/bin/node"):
        if os.path.isfile(p):
            return p
    return shutil.which("node") or "node"


def case_profile(base_profile: dict[str, Any], dose_log: list[dict[str, Any]]) -> dict[str, Any]:
    return {**base_profile, "doseLog": [dict(d) for d in dose_log]}


def format_results_json(payload: dict[str, Any]) -> str:
    head = {k: v for k, v in payload.items() if k != "cases"}
    base = json.dumps(head, indent=1, separators=(",", ":"), ensure_ascii=False)
    lines = ",\n ".join(json.dumps(c, separators=(",", ":"), ensure_ascii=False) for c in payload["cases"])
    return base[:-2] + ',\n "cases":[\n ' + lines + "\n ]\n}\n"


def desk_bg(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (228, 226, 220))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(260):
        c = int(234 - 18 * (y / 260.0))
        d.line((0, y, 768, y), fill=(c, c - 2, c - 5))
    for y in range(260, 768):
        t, j = (y - 260) / 508.0, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(184 - 28 * t) + j, int(156 - 24 * t) + j, int(128 - 20 * t) + j))
    d.line((0, 260, 768, 260), fill=(132, 108, 86), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=0.6))


def motion_blur_horiz(im: Image.Image, radius_px: int) -> Image.Image:
    w, h = im.size
    pad = radius_px + 8
    big = Image.new("RGB", (w + 2 * pad, h), (200, 186, 170))
    big.paste(im, (pad, 0))
    for px in range(pad):
        big.paste(im.crop((0, 0, 1, h)), (px, 0))
        big.paste(im.crop((w - 1, 0, w, h)), (pad + w + px, 0))
    acc: Image.Image | None = None
    offsets = list(range(-radius_px, radius_px + 1, 3))
    for idx, dx in enumerate(offsets, 1):
        shifted = big.crop((pad + dx, 0, pad + dx + w, h))
        acc = shifted if acc is None else Image.blend(acc, shifted, 1.0 / idx)
    return (acc or im).filter(ImageFilter.GaussianBlur(radius=2.4))


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    sc = desk_bg(20261114 + idx * 53)
    d = ImageDraw.Draw(sc)
    mode = case["mode"]
    if mode == "med_clean":
        x0, y0, bw, bh = 86 + (idx % 3) * 8, 186 + (idx % 2) * 10, 588, 428
        d.rounded_rectangle((x0 + 8, y0 + 12, x0 + bw + 10, y0 + bh + 12), radius=16, fill=(96, 80, 66))
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=16, fill=(250, 251, 253), outline=(166, 172, 180), width=3)
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + 56), radius=16, fill=case["accent"])
        d.rectangle((x0, y0 + 28, x0 + bw, y0 + 56), fill=case["accent"])
        d.text((x0 + 26, y0 + 16), case["hdr"], fill=(246, 250, 252), font=ImageFont.load_default(size=21))
        d.text((x0 + 26, y0 + 74), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=37))
        d.text((x0 + 26, y0 + 126), case["sub"], fill=(54, 62, 72), font=ImageFont.load_default(size=22))
        d.rounded_rectangle((x0 + 26, y0 + 170, x0 + 244, y0 + 242), radius=10, fill=(238, 245, 252), outline=case["accent"], width=3)
        d.text((x0 + 42, y0 + 184), case["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=38))
        d.text((x0 + 262, y0 + 192), case["form"], fill=(38, 46, 56), font=ImageFont.load_default(size=23))
        d.text((x0 + 26, y0 + 268), case["dose"], fill=(34, 42, 50), font=ImageFont.load_default(size=21))
        d.rounded_rectangle((x0 + bw - 242, y0 + 348, x0 + bw - 24, y0 + 402), radius=8, fill=(242, 245, 248), outline=(164, 172, 180), width=2)
        d.text((x0 + bw - 222, y0 + 362), case["exp"], fill=(18, 22, 28), font=ImageFont.load_default(size=24))
        return sc
    if mode == "med_thumb_glare":
        x0, y0, bw, bh = 90, 190, 588, 428
        d.rounded_rectangle((x0 + 8, y0 + 12, x0 + bw + 10, y0 + bh + 12), radius=16, fill=(96, 80, 66))
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=16, fill=(250, 251, 253), outline=(166, 172, 180), width=3)
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + 56), radius=16, fill=case["accent"])
        d.rectangle((x0, y0 + 28, x0 + bw, y0 + 56), fill=case["accent"])
        d.text((x0 + 26, y0 + 16), case["hdr"], fill=(246, 250, 252), font=ImageFont.load_default(size=21))
        d.text((x0 + 26, y0 + 74), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=40))
        d.text((x0 + 26, y0 + 130), case["sub"], fill=(54, 62, 72), font=ImageFont.load_default(size=22))
        d.text((x0 + 268, y0 + 194), case["form"], fill=(38, 46, 56), font=ImageFont.load_default(size=23))
        d.text((x0 + 26, y0 + 286), case["dose"], fill=(34, 42, 50), font=ImageFont.load_default(size=21))
        d.rounded_rectangle((x0 + bw - 242, y0 + 348, x0 + bw - 24, y0 + 402), radius=8, fill=(242, 245, 248), outline=(164, 172, 180), width=2)
        d.text((x0 + bw - 222, y0 + 362), case["exp"], fill=(18, 22, 28), font=ImageFont.load_default(size=24))
        d.ellipse((x0 + 10, y0 + 152, x0 + 262, y0 + 262), fill=(255, 255, 255), outline=(248, 250, 254), width=4)
        d.rounded_rectangle((x0 - 28, y0 + 166, x0 + 236, y0 + 258), radius=44, fill=(214, 174, 146), outline=(182, 142, 114), width=3)
        return sc
    x0, y0, bw, bh = -236, 136, 588, 412
    d.rounded_rectangle((x0 + 8, y0 + 12, x0 + bw + 10, y0 + bh + 12), radius=16, fill=(96, 80, 66))
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=16, fill=(248, 250, 252), outline=(166, 172, 180), width=3)
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + 56), radius=16, fill=case["accent"])
    d.rectangle((x0, y0 + 28, x0 + bw, y0 + 56), fill=case["accent"])
    d.text((-18, y0 + 76), case["frag"], fill=(56, 62, 70), font=ImageFont.load_default(size=36))
    d.text((34, y0 + 194), case["form"], fill=(72, 80, 90), font=ImageFont.load_default(size=22))
    return motion_blur_horiz(sc, 32)


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64_jpg: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": f'The person asked: "{question}"'}]}],
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
    node = find_node()
    sub_env = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL, TZ="Europe/Helsinki")
    if os.path.isdir("/dev/shm"):
        sub_env["TMPDIR"] = "/dev/shm"
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { checkLabel, sameStrength, dosesToday } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'const now = new Date(inp.now); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'const fullV = checkLabel(read, r.profile, now); '
        'const dt = dosesToday(r.profile, r.med_id, now); '
        'return { id: r.id, read, headline: fullV.headline, speech: fullV.speech, taken_today: Boolean(fullV.takenToday), doses_today: dt, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "now": NOW_ISO}), text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    row_by_id = {r["id"]: r for r in raw_rows}
    bridge_in = "\n".join(json.dumps({"read": n["read"], "profile": row_by_id[n["id"]]["profile"], "now": NOW_ISO}) for n in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def run_bridge_in_tz(cases: list[dict[str, Any]], base_profile: dict[str, Any], now_iso: str, tz_name: str) -> list[dict[str, Any]]:
    sub_env = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL, TZ=tz_name)
    if os.path.isdir("/dev/shm"):
        sub_env["TMPDIR"] = "/dev/shm"
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": case_profile(base_profile, c["doseLog"]), "now": now_iso}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
    return [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py and not KEY_RE.search(src_py)
    if README_MD.is_file():
        rm_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in rm_txt and EN_DASH not in rm_txt and SLASH2 not in rm_txt and not KEY_RE.search(rm_txt)
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15000, f"results.json size {len(raw_bytes)} > 15000"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == "double_dose_schedule"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["eval_now_iso"] == NOW_ISO
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    for tz_name in ("Europe/Helsinki", "UTC"):
        re_verdicts = run_bridge_in_tz(cases, data["profile"], data["eval_now_iso"], tz_name)
        assert len(re_verdicts) == len(cases)
        for c, rv in zip(cases, re_verdicts):
            assert rv["level"] == c["predicted_level"], f"{c['id']} ({tz_name}): offline {rv['level']} != {c['predicted_level']}"
            assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure") == 2
    assert s["duplicate_dose_block_count"] == sum(1 for c in cases if c["category"] in ("once_daily_duplicate", "midnight_post_boundary", "twice_daily_complete", "clock_schedule_taken") and c["verdict_ok"])
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--verify-cached", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.offline or args.verify_cached:
        return check_existing()
    shm_root = "/dev/shm" if os.path.isdir("/dev/shm") else None
    if args.render_only:
        out_dir = pathlib.Path(shm_root or "/tmp") / "holdup_double_dose_schedule"
        out_dir.mkdir(parents=True, exist_ok=True)
        for idx, c in enumerate(CASES, 1):
            buf = io.BytesIO()
            render_case_image(c, idx).save(buf, format="JPEG", quality=90)
            (out_dir / f"{c['id']}.jpg").write_bytes(buf.getvalue())
        print(f"Rendered {len(CASES)} cases to {out_dir}")
        return 0
    rendered: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="holdup_dd_", dir=shm_root) as tmp_d:
        tdir = pathlib.Path(tmp_d)
        for idx, c in enumerate(CASES, 1):
            buf = io.BytesIO()
            render_case_image(c, idx).save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (tdir / f"{c['id']}.jpg").write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
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
    raw_rows = [
        {
            "id": r["case"]["id"],
            "raw": o["raw"],
            "exp_str": r["case"]["exp_str"],
            "med_id": r["case"]["med_id"],
            "profile": case_profile(PROFILE, r["case"]["dose_log"]),
        }
        for r, o in zip(rendered, api_outs)
    ]
    scored = score_with_ts_and_bridge(raw_rows)
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, api_outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)
        p_conf = float(rd["product"]["confidence"] or 0.0) if rd["product"]["value"] else 0.0
        i_conf = float(rd["ingredient"]["confidence"] or 0.0) if rd["ingredient"]["value"] else 0.0
        name_conf = max(p_conf, i_conf)
        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["id"] == "dd_12":
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF or name_conf >= MATCH_NAME_MIN_CONF)
        elif c["degraded"]:
            cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
        else:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
            "id": c["id"],
            "category": c["category"],
            "description": c["desc"],
            "question": c["q"],
            "schedule": c["schedule"],
            "doseLog": c["dose_log"],
            "doses_today": sc["doses_today"],
            "expected_level": c["expected"],
            "predicted_level": pred,
            "verdict_ok": verdict_ok,
            "confident_wrong": cw,
            "false_match": false_match,
            "latency_ms": o["ms"],
            "read": rd,
            "reasons": list(vd["reasons"])[:4],
        }))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} dt={sc['doses_today']} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    dup_cases = [x for x in cases_out if x["category"] in ("once_daily_duplicate", "midnight_post_boundary", "twice_daily_complete", "clock_schedule_taken")]
    dup_ok = sum(1 for x in dup_cases if x["verdict_ok"])
    lats = [float(x["latency_ms"]) for x in cases_out]
    summary = {
        "n_cases": n,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "duplicate_dose_block_count": dup_ok,
        "duplicate_dose_block_rate": round(dup_ok / len(dup_cases), 4),
        "duplicate_dose_block_ci95": wilson_ci95(dup_ok, len(dup_cases)),
        "confident_wrong_count": cw_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "tz_invariant_utc_eet": True,
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
    }
    payload = sanitize({
        "suite": "double_dose_schedule",
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
    OUT_JSON.write_text(format_results_json(payload), encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
