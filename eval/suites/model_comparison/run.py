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
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SHM_IMG_DIR = pathlib.Path("/dev/shm/holdup_model_comparison")
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
MAX_JSON_BYTES = 25000
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")
KEY_PARAM_RE = re.compile(r"key=[A-Za-z0-9_-]+")

MODELS: list[dict[str, Any]] = [
    {"model": "gemini-3.8-flash", "thinking_level": "low", "prefer_schema": True},
    {"model": "gemini-3.5-flash", "thinking_level": "low", "prefer_schema": True},
    {"model": "gemma-4-31b-it", "thinking_level": "none", "prefer_schema": True},
]
GEMMA_SEM = threading.Semaphore(1)

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "thyroxin", "name": "Thyroxin", "ingredient": "levothyroxine", "strength": "100 mcg", "schedule": ["morning"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "marevan", "name": "Marevan", "ingredient": "warfarin", "strength": "3 mg", "schedule": ["evening"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

BOX_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {"accent": (20, 102, 148), "hdr": "ORION PHARMA  Vnr 08 44 12", "title": "AMLODIPINE", "sub": "Active ingredient: amlodipine", "str": "5 mg", "dose": "1 tablet once daily in the evening", "exp": "EXP 2027-10"},
    "aml10": {"accent": (20, 102, 148), "hdr": "ORION PHARMA  Vnr 09 22 41", "title": "AMLODIPINE", "sub": "Active ingredient: amlodipine", "str": "10 mg", "dose": "1 tablet once daily", "exp": "EXP 2027-10"},
    "ibu400": {"accent": (188, 34, 44), "hdr": "ORION PHARMA  Vnr 06 14 28", "title": "BURANA", "sub": "Active ingredient: ibuprofen", "str": "400 mg", "dose": "1 tablet as needed for pain", "exp": "EXP 2027-11"},
    "thy100": {"accent": (36, 94, 142), "hdr": "ORION PHARMA  Vnr 01 49 67", "title": "THYROXIN", "sub": "Active ingredient: levothyroxine", "str": "100 mikrog", "dose": "1 tablet once daily in the morning", "exp": "EXP 2027-09"},
    "bis25": {"accent": (22, 116, 104), "hdr": "ORION PHARMA  Vnr 46 21 09", "title": "BISOPROLOL", "sub": "Active ingredient: bisoprolol", "str": "2,5 mg", "dose": "1 tablet once daily in the morning", "exp": "EXP 2027-08"},
    "mar3_exp": {"accent": (142, 44, 88), "hdr": "ORION PHARMA  Vnr 04 33 15", "title": "MAREVAN", "sub": "Active ingredient: warfarin", "str": "3 mg", "dose": "1 tablet in the evening as directed", "exp": "EXP 2025-04"},
    "peanut_bar": {"food": True, "accent": (146, 78, 28), "hdr": "NORDIC BAKERY  60 g", "title": "Peanut & Hazelnut Bar", "ing": "Ingredients: oats, roasted peanuts (26%), hazelnuts (10%).", "alg": "Allergens: contains peanuts, hazelnuts (tree nuts), oats.", "exp": "Best before: 2027-09-18"},
    "oat_drink": {"food": True, "accent": (42, 114, 84), "hdr": "NORDIC PLANT DAIRY  1 L", "title": "Nordic Oat Drink", "ing": "Ingredients: water, wholegrain oats (10%), rapeseed oil, salt.", "alg": "Allergens: contains oats (gluten).", "exp": "Best before: 2027-11-24"},
    "berry_biscuit": {"food_occluded": True, "accent": (118, 52, 92), "hdr": "NORDIC BAKERY  200 g", "title": "Nordic Berry Biscuit", "exp": "Best before: 2027-10-15"},
}

CASES: list[dict[str, Any]] = [
    {"id": "mc_01", "category": "med_match", "degraded": False, "mode": "single", "box": "aml5", "q": "Is this my evening pill?", "expected": "match", "exp_str": "5 mg", "allergen": False, "desc": "Sharp Amlodipine 5 mg box matching evening pill on profile"},
    {"id": "mc_02", "category": "med_wrong_strength", "degraded": False, "mode": "single", "box": "aml10", "q": "Is this my evening pill?", "expected": "warning", "exp_str": "10 mg", "allergen": False, "desc": "Sharp Amlodipine 10 mg wrong-strength box against 5 mg profile"},
    {"id": "mc_03", "category": "med_avoid_nsaid", "degraded": False, "mode": "single", "box": "ibu400", "q": "Can I take this for pain?", "expected": "warning", "exp_str": "400 mg", "allergen": False, "desc": "Sharp Burana ibuprofen 400 mg box triggering NSAID avoid warning"},
    {"id": "mc_04", "category": "med_mikrog_match", "degraded": False, "mode": "single", "box": "thy100", "q": "Is this my morning thyroid pill?", "expected": "match", "exp_str": "100 mikrog", "allergen": False, "desc": "Sharp Thyroxin 100 mikrog Nordic unit box matching 100 mcg profile"},
    {"id": "mc_05", "category": "med_comma_decimal", "degraded": False, "mode": "single", "box": "bis25", "q": "Is this my morning Bisoprolol?", "expected": "match", "exp_str": "2.5 mg", "allergen": False, "desc": "Sharp Bisoprolol 2,5 mg Nordic comma-decimal box matching 2.5 mg profile"},
    {"id": "mc_06", "category": "med_expired", "degraded": False, "mode": "single", "box": "mar3_exp", "q": "Can I take this Marevan?", "expected": "warning", "exp_str": "3 mg", "allergen": False, "desc": "Sharp Marevan warfarin 3 mg box expired in 2025-04"},
    {"id": "mc_07", "category": "med_thumb_occluded", "degraded": True, "mode": "thumb_occlude", "box": "aml5", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Amlodipine box with thumb completely occluding the strength badge"},
    {"id": "mc_08", "category": "med_motion_blur", "degraded": True, "mode": "motion_blur", "box": "aml5", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Severely motion-blurred medicine box with illegible text and strength"},
    {"id": "mc_09", "category": "med_coplanar_twins", "degraded": True, "mode": "twin", "left": "aml5", "right": "aml10", "q": "Is this my evening pill?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Co-planar Amlodipine 5 mg and 10 mg boxes held side-by-side equally sharp"},
    {"id": "mc_10", "category": "food_allergen_warning", "degraded": False, "mode": "single", "box": "peanut_bar", "q": "Does this contain peanuts or tree nuts?", "expected": "warning", "exp_str": None, "allergen": True, "desc": "Sharp Peanut and Hazelnut Bar carton triggering nut allergy warning"},
    {"id": "mc_11", "category": "food_safe_info", "degraded": False, "mode": "single", "box": "oat_drink", "q": "Is this safe with my nut allergies?", "expected": "info", "exp_str": None, "allergen": False, "desc": "Sharp Nordic Oat Drink carton with legible nut-free oat ingredient panel"},
    {"id": "mc_12", "category": "food_unreadable_allergens", "degraded": True, "mode": "food_occluded", "box": "berry_biscuit", "q": "Does this contain peanuts or tree nuts?", "expected": "unsure", "exp_str": None, "allergen": False, "desc": "Food carton with ingredients and allergen panel occluded by hand and glare"},
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
        s = v.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        raw_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if raw_key:
            s = s.replace(raw_key, "[REDACTED]")
        s = KEY_RE.sub("[REDACTED]", s)
        return KEY_PARAM_RE.sub("key=[REDACTED]", s)
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


def rule_of_three_upper(k: int, n: int) -> float | None:
    if k != 0 or n <= 0:
        return None
    return round(min(1.0, 3.0 / n), 4)


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


def strip_json_fences(txt: str) -> str:
    s = txt.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()
    if not s.startswith("{") and "{" in s and "}" in s:
        s = s[s.find("{") : s.rfind("}") + 1]
    return s


def render_counter(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (226, 221, 212))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(310):
        c = int(232 - 18 * (y / 310))
        d.line((0, y, 768, y), fill=(c, c - 4, c - 10))
    for y in range(310, 768):
        t, j = (y - 310) / 458, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(184 - 28 * t) + j, int(156 - 24 * t) + j, int(126 - 20 * t) + j))
    d.line((0, 310, 768, 310), fill=(128, 104, 82), width=3)
    return im.filter(ImageFilter.GaussianBlur(radius=1.4))


def render_box(spec: dict[str, Any], w: int, h: int, hide_str: bool = False) -> Image.Image:
    is_food = bool(spec.get("food") or spec.get("food_occluded"))
    im = Image.new("RGB", (w, h), (248, 243, 234) if is_food else (250, 251, 253))
    d, cp = ImageDraw.Draw(im), w < 400
    d.rectangle((0, 0, w, 44 if cp else 52), fill=spec["accent"])
    d.text((18, 12 if cp else 15), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=16 if cp else 20))
    d.text((18, 60 if cp else 70), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=28 if cp else 38))
    if spec.get("food"):
        d.rounded_rectangle((18, 128, w - 18, 294), radius=8, fill=(254, 253, 249), outline=(182, 176, 164), width=2)
        d.text((28, 146), spec["ing"], fill=(24, 28, 26), font=ImageFont.load_default(size=17 if cp else 19))
        d.rounded_rectangle((28, 206, w - 28, 272), radius=6, fill=(255, 244, 232), outline=(196, 124, 66), width=2)
        d.text((38, 228), spec["alg"], fill=(104, 38, 20), font=ImageFont.load_default(size=17 if cp else 19))
        d.text((22, h - 54), spec["exp"], fill=(22, 26, 30), font=ImageFont.load_default(size=20 if cp else 22))
        return im
    if spec.get("food_occluded"):
        d.rounded_rectangle((18, 128, w - 18, 304), radius=8, fill=(244, 241, 235), outline=(182, 176, 164), width=2)
        for ry in (152, 174, 196, 224, 248, 270):
            d.rounded_rectangle((34, ry, w - 54, ry + 9), radius=4, fill=(214, 210, 204))
        d.ellipse((110, 118, w - 24, 312), fill=(254, 254, 252))
        d.text((22, h - 54), spec["exp"], fill=(22, 26, 30), font=ImageFont.load_default(size=20 if cp else 22))
        return im
    d.text((18, 104 if cp else 122), spec["sub"], fill=(48, 56, 66), font=ImageFont.load_default(size=17 if cp else 22))
    str_font = ImageFont.load_default(size=30 if cp else 38)
    tb = d.textbbox((0, 0), spec["str"], font=str_font)
    bw = max(152 if cp else 214, (tb[2] - tb[0]) + 36)
    d.rounded_rectangle((18, 148 if cp else 168, 18 + bw, 212 if cp else 238), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    if not hide_str:
        d.text((32, 162 if cp else 182), spec["str"], fill=(14, 20, 28), font=str_font)
    d.text((18, 236 if cp else 266), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=16 if cp else 20))
    d.text((18, h - 52), f"30 tablets    {spec['exp']}", fill=(24, 30, 38), font=ImageFont.load_default(size=18 if cp else 22))
    return im


def paste_held(bg: Image.Image, card: Image.Image, x: int, y: int) -> None:
    d, (w, h), cx = ImageDraw.Draw(bg), card.size, x + int(card.size[0] / 2)
    d.rounded_rectangle((x + 6, y + 8, x + w + 6, y + h + 8), radius=10, fill=(92, 78, 64))
    bg.paste(card, (x, y))
    d.rectangle((x, y, x + w - 1, y + h - 1), outline=(164, 170, 178), width=2)
    d.rounded_rectangle((cx - 108, y + h - 14, cx - 26, y + h + 68), radius=28, fill=(212, 172, 144), outline=(176, 136, 108), width=2)
    d.rounded_rectangle((cx + 26, y + h - 14, cx + 108, y + h + 68), radius=28, fill=(208, 168, 140), outline=(174, 134, 106), width=2)


def apply_heavy_motion_blur(im: Image.Image) -> Image.Image:
    base = im.filter(ImageFilter.GaussianBlur(radius=9.0))
    acc: Image.Image | None = None
    offsets = [(-84 + 7 * k, int(4 * math.sin(k))) for k in range(25)]
    for idx, (dx, dy) in enumerate(offsets):
        shifted = Image.new("RGB", base.size, (196, 184, 168))
        shifted.paste(base, (dx, dy))
        acc = shifted if acc is None else Image.blend(acc, shifted, 1.0 / (idx + 1))
    assert acc is not None
    return acc.filter(ImageFilter.GaussianBlur(radius=6.0))


def render_case_frames(case: dict[str, Any], idx: int) -> list[Image.Image]:
    seed, m = 202641 + idx * 43, case["mode"]
    sc = render_counter(seed)
    if m == "single":
        paste_held(sc, render_box(BOX_SPECS[case["box"]], 560, 420), 104, 240)
        return [sc]
    if m == "thumb_occlude":
        paste_held(sc, render_box(BOX_SPECS[case["box"]], 560, 420, hide_str=True), 104, 240)
        d = ImageDraw.Draw(sc)
        d.rounded_rectangle((82, 396, 362, 492), radius=42, fill=(214, 174, 146), outline=(176, 136, 108), width=3)
        return [sc]
    if m == "motion_blur":
        blank_box = Image.new("RGB", (560, 420), (246, 248, 251))
        bd = ImageDraw.Draw(blank_box)
        bd.rectangle((0, 0, 560, 52), fill=(20, 102, 148))
        for ry, rw in ((86, 240), (134, 310), (192, 160), (274, 340), (372, 290)):
            bd.rounded_rectangle((24, ry, 24 + rw, ry + 18), radius=6, fill=(138, 146, 158))
        paste_held(sc, blank_box, 104, 240)
        return [apply_heavy_motion_blur(sc)]
    if m == "twin":
        paste_held(sc, render_box(BOX_SPECS[case["left"]], 332, 416), 34, 220)
        paste_held(sc, render_box(BOX_SPECS[case["right"]], 332, 416), 402, 220)
        return [sc]
    paste_held(sc, render_box(BOX_SPECS[case["box"]], 560, 420), 104, 240)
    d = ImageDraw.Draw(sc)
    d.rounded_rectangle((96, 366, 672, 548), radius=38, fill=(214, 174, 146), outline=(176, 136, 108), width=3)
    return [sc]


def build_candidate_payloads(model_spec: dict[str, Any], prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> list[tuple[str, str, dict[str, Any]]]:
    img_parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b}} for b in frames_b64]
    q_part = {"text": f'The person asked: "{question}"'}
    out: list[tuple[str, str, dict[str, Any]]] = []
    if model_spec["prefer_schema"] and model_spec["thinking_level"] != "none":
        out.append((
            "responseJsonSchema",
            "low",
            {
                "systemInstruction": {"parts": [{"text": prompt}]},
                "contents": [{"role": "user", "parts": img_parts + [q_part]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseJsonSchema": schema,
                    "thinkingConfig": {"thinkingLevel": "LOW"},
                    "maxOutputTokens": 4096,
                },
            },
        ))
    if model_spec["prefer_schema"]:
        out.append((
            "responseJsonSchema",
            "none",
            {
                "systemInstruction": {"parts": [{"text": prompt}]},
                "contents": [{"role": "user", "parts": img_parts + [q_part]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseJsonSchema": schema,
                    "maxOutputTokens": 4096,
                },
            },
        ))
    fallback_txt = (
        f"{prompt}\n\nJSON Schema:\n{json.dumps(schema)}\n\n"
        f'The person asked: "{question}"\n'
        "Return ONLY a valid JSON object matching the schema with no markdown code fences."
    )
    out.append((
        "json_prompt_fallback",
        "none",
        {
            "contents": [{"role": "user", "parts": img_parts + [{"text": fallback_txt}]}],
            "generationConfig": {"maxOutputTokens": 4096},
        },
    ))
    return out


def post_once(sess: requests.Session, url: str, api_key: str, payload: dict[str, Any], is_gemma: bool) -> tuple[requests.Response, float]:
    if is_gemma:
        with GEMMA_SEM:
            t0 = time.perf_counter()
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=60)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            time.sleep(2.2)
            return r, ms
    t0 = time.perf_counter()
    r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=60)
    ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return r, ms


def call_model(api_key: str, model_spec: dict[str, Any], prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> dict[str, Any]:
    model_name = model_spec["model"]
    is_gemma = model_name.startswith("gemma-")
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    candidates = build_candidate_payloads(model_spec, prompt, schema, frames_b64, question)
    sess, last = requests.Session(), "failed"
    for schema_mode, thinking_used, payload in candidates:
        advance_mode = False
        for attempt in range(7):
            ms = 0.0
            try:
                r, ms = post_once(sess, url, api_key, payload, is_gemma)
                if r.status_code == 200:
                    body = r.json()
                    cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                    txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                    if txt:
                        parsed = json.loads(strip_json_fences(txt))
                        return {
                            "ok": True,
                            "raw": sanitize(parsed),
                            "ms": ms,
                            "schema_mode": schema_mode,
                            "thinking_level": thinking_used,
                        }
                    last = "empty_text"
                elif r.status_code == 400:
                    last = sanitize(f"HTTP 400: {r.text[:160]}")
                    advance_mode = True
                    break
                elif r.status_code not in (408, 429, 500, 502, 503, 504):
                    return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
                else:
                    last = sanitize(f"HTTP {r.status_code}")
            except json.JSONDecodeError as exc:
                last = sanitize(f"json_decode: {exc}")
                if attempt >= 1:
                    advance_mode = True
                    break
            except requests.RequestException as exc:
                last = sanitize(str(exc))
            wait_s = min(28.0, 2.5 * (1.85 ** attempt) + random.uniform(0.2, 1.4))
            time.sleep(wait_s)
        if not advance_mode:
            break
    return {"ok": False, "err": last, "ms": 0.0}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        'process.stdout.write(JSON.stringify(inp.rows.map((r) => { '
        'const read = toLabelRead(r.raw); '
        'return { key: r.key, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false, alg_hits: allergenHits(read, inp.allergies).length }; '
        '})));'
    )
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["key"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def evaluate_flags(case: dict[str, Any], rd: dict[str, Any], str_same: bool, alg_hits: int, pred: str) -> tuple[bool, bool, bool, bool]:
    s_val = rd["strength"]["value"]
    s_conf = float(rd["strength"]["confidence"] or 0.0)
    alg_val = rd["allergens"]["value"]
    alg_conf = float(rd["allergens"]["confidence"] or 0.0)
    false_match = bool(pred == "match" and case["expected"] != "match")
    unsafe_reassurance = bool(case["expected"] == "warning" and pred in ("match", "info"))
    if case["mode"] == "food_occluded":
        cw = bool(false_match or unsafe_reassurance or pred == "info" or (alg_val is not None and alg_conf >= 0.80) or s_conf >= STRENGTH_MIN_CONF)
    elif case["degraded"]:
        cw = bool(false_match or unsafe_reassurance or s_conf >= STRENGTH_MIN_CONF)
    elif case["exp_str"] is not None:
        cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not str_same)))
    else:
        alg_wrong = bool((case["allergen"] and alg_conf >= 0.80 and alg_hits == 0) or ((not case["allergen"]) and alg_conf >= 0.80 and alg_hits > 0))
        cw = bool(false_match or unsafe_reassurance or alg_wrong or (s_val is not None and s_conf >= STRENGTH_MIN_CONF))
    verdict_ok = bool(pred == case["expected"])
    return verdict_ok, cw, false_match, unsafe_reassurance


def compact_read(rd: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in rd.items() if k not in ("dosing", "barcode")}


def format_compact_json(payload: dict[str, Any]) -> str:
    top_lines = ["{"]
    keys = list(payload.keys())
    for ki, k in enumerate(keys):
        comma = "," if ki + 1 < len(keys) else ""
        val = payload[k]
        if k == "per_model":
            top_lines.append(' "per_model": {')
            mkeys = list(val.keys())
            for mi, mk in enumerate(mkeys):
                mcomma = "," if mi + 1 < len(mkeys) else ""
                inner = json.dumps(val[mk], indent=2, ensure_ascii=False).replace("\n", "\n  ")
                top_lines.append(f'  {json.dumps(mk)}: {inner}{mcomma}')
            top_lines.append(f" }}{comma}")
        elif k == "cases":
            top_lines.append(' "cases": [')
            for ci, c in enumerate(val):
                ccomma = "," if ci + 1 < len(val) else ""
                top_lines.append("  {")
                for fk in ("id", "category", "description", "question", "expected_level", "image_sha256_12"):
                    top_lines.append(f'   {json.dumps(fk)}: {json.dumps(c[fk], ensure_ascii=False)},')
                top_lines.append('   "results": {')
                rkeys = list(c["results"].keys())
                for ri, rk in enumerate(rkeys):
                    rcomma = "," if ri + 1 < len(rkeys) else ""
                    rline = json.dumps(c["results"][rk], separators=(",", ":"), ensure_ascii=False)
                    top_lines.append(f'    {json.dumps(rk)}: {rline}{rcomma}')
                top_lines.append("   }")
                top_lines.append(f"  }}{ccomma}")
            top_lines.append(f" ]{comma}")
        else:
            top_lines.append(f" {json.dumps(k)}: {json.dumps(val, separators=(',', ':'), ensure_ascii=False)}{comma}")
    top_lines.append("}\n")
    return "\n".join(top_lines)


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= MAX_JSON_BYTES, f"results.json size {len(raw_bytes)} > {MAX_JSON_BYTES}"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and not KEY_RE.search(readme_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == "model_comparison"
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    model_names = [m["model"] for m in MODELS]
    assert [m["model"] for m in data["models"]] == model_names
    cases = data["cases"]
    assert len(cases) == 12
    bridge_rows: list[tuple[str, str, str, dict[str, Any]]] = []
    for c in cases:
        assert len(c["description"]) <= 240
        for mn in model_names:
            mr = c["results"][mn]
            bridge_rows.append((c["id"], c["expected_level"], mn, mr))
    bridge_in = "\n".join(json.dumps({"read": mr["read"], "profile": data["profile"], "now": data["eval_now_iso"]}) for _, _, _, mr in bridge_rows) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(bridge_rows) == 36
    safety_sha12 = hashlib.sha256((REPO / SAFETY_TS_REL).read_bytes()).hexdigest()[:12]
    for (cid, exp_lvl, mn, mr), rv in zip(bridge_rows, re_verdicts):
        if safety_sha12 == "9c6aebad416b":
            assert rv["level"] == mr["predicted_level"], f"{cid}/{mn}: offline {rv['level']} != {mr['predicted_level']}"
        else:
            upgraded_false_match = (
                mr["predicted_level"] == "match"
                and exp_lvl != "match"
                and rv["level"] in ("warning", "unsure")
            )
            assert rv["level"] == mr["predicted_level"] or upgraded_false_match, f"{cid}/{mn}: offline {rv['level']} != {mr['predicted_level']}"
        assert len(mr["reasons"]) <= 4
    for mn in model_names:
        s = data["per_model"][mn]
        m_runs = [(c, c["results"][mn]) for c in cases]
        assert s["n"] == 12
        assert s["verdict_matches"] == sum(1 for _, mr in m_runs if mr["verdict_ok"])
        assert s["verdict_accuracy"] == round(s["verdict_matches"] / 12, 4)
        assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], 12)
        assert s["confident_wrong_count"] == sum(1 for _, mr in m_runs if mr["confident_wrong"])
        assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / 12, 4)
        assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], 12)
        assert s["rule_of_three_upper_95"] == rule_of_three_upper(s["confident_wrong_count"], 12)
        assert s["false_match_count"] == sum(1 for _, mr in m_runs if mr["false_match"])
        assert s["unsafe_reassurance_count"] == sum(1 for c, mr in m_runs if c["expected_level"] == "warning" and mr["predicted_level"] in ("match", "info"))
        assert s["abstain_or_unsure_count"] == sum(1 for _, mr in m_runs if mr["predicted_level"] == "unsure")
    print("OK:", json.dumps({mn: data["per_model"][mn] for mn in model_names}))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--keep-images", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.offline:
        return check_existing()
    SHM_IMG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            imgs = render_case_frames(c, idx)
            b64s: list[str] = []
            sha_acc = hashlib.sha256()
            for fi, im in enumerate(imgs, 1):
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=90)
                raw = buf.getvalue()
                sha_acc.update(raw)
                fname = f"{c['id']}.jpg" if len(imgs) == 1 else f"{c['id']}_f{fi}.jpg"
                (SHM_IMG_DIR / fname).write_bytes(raw)
                b64s.append(base64.b64encode(raw).decode("ascii"))
            rendered.append({"case": c, "b64s": b64s, "sha12": sha_acc.hexdigest()[:12]})
        if args.render_only:
            print(f"Rendered {len(rendered)} cases to {SHM_IMG_DIR}")
            return 0
        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))
        tasks: list[tuple[dict[str, Any], dict[str, Any]]] = [(ms, r) for r in rendered for ms in MODELS]
        with ThreadPoolExecutor(max_workers=4) as ex:
            api_outs = list(ex.map(lambda t: call_model(api_key, t[0], prompt_txt, schema, t[1]["b64s"], t[1]["case"]["q"]), tasks))
        bad = [(t[0]["model"], t[1]["case"]["id"], o.get("err")) for t, o in zip(tasks, api_outs) if not o.get("ok")]
        if bad:
            raise RuntimeError(f"API errors: {bad}")
        raw_rows = [
            {"key": f"{t[0]['model']}::{t[1]['case']['id']}", "raw": o["raw"], "exp_str": t[1]["case"]["exp_str"]}
            for t, o in zip(tasks, api_outs)
        ]
        scored = score_with_ts_and_bridge(raw_rows)
        by_case_model: dict[tuple[str, str], dict[str, Any]] = {}
        modes_by_model: dict[str, list[tuple[str, str]]] = {ms["model"]: [] for ms in MODELS}
        for (ms, r), o in zip(tasks, api_outs):
            mn, cid = ms["model"], r["case"]["id"]
            sc = scored[f"{mn}::{cid}"]
            rd, vd = sc["read"], sc["verdict"]
            pred = str(vd["level"])
            verdict_ok, cw, fm, _ = evaluate_flags(r["case"], rd, bool(sc["str_same"]), int(sc["alg_hits"]), pred)
            modes_by_model[mn].append((str(o["thinking_level"]), str(o["schema_mode"])))
            mr_entry: dict[str, Any] = {
                "predicted_level": pred,
                "verdict_ok": verdict_ok,
                "confident_wrong": cw,
                "false_match": fm,
                "latency_ms": o["ms"],
                "read": compact_read(rd),
                "reasons": list(vd["reasons"])[:2],
            }
            if o["schema_mode"] != "responseJsonSchema":
                mr_entry["schema_mode"] = o["schema_mode"]
            by_case_model[(cid, mn)] = sanitize(mr_entry)
            print(f"[{mn} | {cid}] exp={r['case']['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']} mode={o['schema_mode']}")
        cases_out: list[dict[str, Any]] = []
        for r in rendered:
            c = r["case"]
            cases_out.append(sanitize({
                "id": c["id"],
                "category": c["category"],
                "description": c["desc"],
                "question": c["q"],
                "expected_level": c["expected"],
                "image_sha256_12": r["sha12"],
                "results": {ms["model"]: by_case_model[(c["id"], ms["model"])] for ms in MODELS},
            }))
        per_model: dict[str, Any] = {}
        models_meta: list[dict[str, Any]] = []
        for ms in MODELS:
            mn = ms["model"]
            th_lvl = modes_by_model[mn][0][0]
            fb_n = sum(1 for _, sm in modes_by_model[mn] if sm != "responseJsonSchema")
            sc_mode = "responseJsonSchema+json_prompt_fallback" if fb_n > 0 else "responseJsonSchema"
            models_meta.append({"model": mn, "thinking_level": th_lvl, "schema_mode": sc_mode, "fallback_count": fb_n})
            m_runs = [(c, c["results"][mn]) for c in cases_out]
            n = len(m_runs)
            v_matches = sum(1 for _, mr in m_runs if mr["verdict_ok"])
            cw_n = sum(1 for _, mr in m_runs if mr["confident_wrong"])
            fm_n = sum(1 for _, mr in m_runs if mr["false_match"])
            ur_n = sum(1 for c, mr in m_runs if c["expected_level"] == "warning" and mr["predicted_level"] in ("match", "info"))
            abs_n = sum(1 for _, mr in m_runs if mr["predicted_level"] == "unsure")
            lats = [float(mr["latency_ms"]) for _, mr in m_runs]
            per_model[mn] = {
                "thinking_level": th_lvl,
                "schema_mode": sc_mode,
                "fallback_count": fb_n,
                "n": n,
                "verdict_matches": v_matches,
                "verdict_accuracy": round(v_matches / n, 4),
                "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
                "confident_wrong_count": cw_n,
                "confident_wrong_rate": round(cw_n / n, 4),
                "confident_wrong_ci95": wilson_ci95(cw_n, n),
                "rule_of_three_upper_95": rule_of_three_upper(cw_n, n),
                "false_match_count": fm_n,
                "unsafe_reassurance_count": ur_n,
                "abstain_or_unsure_count": abs_n,
                "latency_p50_ms": pctile(lats, 0.50),
                "latency_p95_ms": pctile(lats, 0.95),
            }
        payload = sanitize({
            "suite": "model_comparison",
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": NOW_ISO,
            "prompt_source": PROMPT_SOURCE,
            "prompt_sha256_12": prompt_sha256_12,
            "safety_module": SAFETY_TS_REL,
            "models": models_meta,
            "profile": PROFILE,
            "per_model": per_model,
            "cases": cases_out,
        })
        OUT_JSON.write_text(format_compact_json(payload), encoding="utf-8")
        return check_existing()
    finally:
        if not args.render_only and not args.keep_images and SHM_IMG_DIR.exists():
            shutil.rmtree(SHM_IMG_DIR, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
