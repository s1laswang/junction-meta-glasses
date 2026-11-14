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
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

if os.path.isdir("/dev/shm"):
    os.environ.setdefault("TMPDIR", "/dev/shm")

for _cand in ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin"):
    if os.path.isdir(_cand):
        os.environ["PATH"] = f"{_cand}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SUITE_NAME = "liquid_ophthalmic"
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
        {"id": "latanoprost", "name": "Xalatan", "ingredient": "latanoprost", "strength": "50 mcg/ml", "schedule": ["evening"]},
        {"id": "timolol", "name": "Oftan Timolol", "ingredient": "timolol", "strength": "5 mg/ml", "schedule": ["morning", "evening"]},
        {"id": "paracetamol_susp", "name": "Panadol", "ingredient": "paracetamol", "strength": "24 mg/ml", "schedule": ["evening"]},
        {"id": "insulin_glargine", "name": "Lantus", "ingredient": "insulin glargine", "strength": "100 IU/ml", "schedule": ["evening"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {"id": "lo_01", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "dropper", "defect": None, "q": "Are these my evening glaucoma eye drops?", "expected": "match", "exp_str": "50 mcg/ml", "desc": "Ophthalmic squeeze-dropper bottle Xalatan (latanoprost) 50 mcg/ml EXP 2027-10 evening match", "hdr": "STERILE EYE DROPS  SILMATIPAT", "title": "Xalatan", "sub": "Active ingredient: latanoprost", "str": "50 mcg/ml", "dose": "1 drop in the affected eye in the evening", "exp": "EXP 2027-10", "cap": (28, 128, 122), "tilt": -1.3},
    {"id": "lo_02", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "amber", "defect": None, "q": "Is this my Panadol oral suspension?", "expected": "match", "exp_str": "24 mg/ml", "desc": "Amber oral suspension bottle Panadol (paracetamol) 24 mg/ml EXP 2027-11 match", "hdr": "ORAALISUSPENSIO  ORAL SUSPENSION", "title": "Panadol", "sub": "Vaikuttava aine: parasetamoli (paracetamol)", "str": "24 mg/ml", "dose": "Shake well before oral dosing", "exp": "EXP 2027-11", "cap": (236, 238, 240), "tilt": 1.4},
    {"id": "lo_03", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "pen", "defect": None, "q": "Is this my evening Lantus insulin pen?", "expected": "match", "exp_str": "100 IU/ml", "desc": "Prefilled disposable injection pen Lantus (insulin glargine) 100 IU/ml EXP 2027-09 match", "hdr": "PRE-FILLED INJECTION PEN", "title": "Lantus", "sub": "Active ingredient: insulin glargine", "str": "100 IU/ml", "dose": "Subcutaneous injection once daily in the evening", "exp": "EXP 2027-09", "cap": (118, 92, 152), "tilt": -1.2},
    {"id": "lo_04", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "dropper", "defect": None, "q": "Are these my Oftan Timolol eye drops?", "expected": "warning", "exp_str": "2.5 mg/ml", "desc": "Wrong-concentration Oftan Timolol (timolol) 2.5 mg/ml eye-drop bottle vs 5 mg/ml profile", "hdr": "SANTEN  SILMATIPAT  EYE DROPS", "title": "Oftan Timolol", "sub": "Active ingredient: timolol", "str": "2.5 mg/ml", "dose": "1 drop twice daily", "exp": "EXP 2027-10", "cap": (38, 92, 162), "tilt": 1.5},
    {"id": "lo_05", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "pen", "defect": None, "q": "Is this my evening basal insulin pen?", "expected": "warning", "exp_str": "300 IU/ml", "desc": "High-concentration Toujeo (insulin glargine) 300 IU/ml pen vs 100 IU/ml profile warning", "hdr": "CONCENTRATED INJECTION PEN", "title": "Toujeo", "sub": "Active ingredient: insulin glargine", "str": "300 IU/ml", "dose": "Subcutaneous injection once daily", "exp": "EXP 2027-10", "cap": (52, 128, 76), "tilt": -1.4},
    {"id": "lo_06", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "dropper", "defect": None, "q": "Can I put these drops in my eyes?", "expected": "warning", "exp_str": "40 mg/g + 10 mg/g", "desc": "Look-alike otic squeeze-dropper bottle Otipax (phenazone, lidocaine ear drops) mistaken for eye drops", "hdr": "KORVATIPAT  EAR DROPS ONLY", "title": "Otipax", "sub": "Active ingredients: phenazone, lidocaine", "str": "40 mg/g + 10 mg/g", "dose": "Auricular use only, do not use in eyes", "exp": "EXP 2027-08", "cap": (212, 112, 36), "tilt": 1.6},
    {"id": "lo_07", "category": "readable_liquid_ophthalmic", "degraded": False, "form": "dropper", "defect": None, "q": "Can I use these Voltaren Ophtha eye drops?", "expected": "warning", "exp_str": "1 mg/ml", "desc": "NSAID ophthalmic dropper bottle Voltaren Ophtha (diclofenac) 1 mg/ml triggering avoid warning", "hdr": "OPHTHALMIC SOLUTION  SILMATIPAT", "title": "Voltaren Ophtha", "sub": "Active ingredient: diclofenac", "str": "1 mg/ml", "dose": "1 drop 3 to 4 times daily", "exp": "EXP 2027-09", "cap": (196, 62, 54), "tilt": -1.5},
    {"id": "lo_08", "category": "finger_grip_occluded", "degraded": True, "form": "dropper", "defect": "finger", "q": "Are these my evening glaucoma eye drops?", "expected": "unsure", "exp_str": None, "desc": "Thumb gripping across the micro-printed concentration band on a tiny Xalatan dropper bottle", "hdr": "STERILE EYE DROPS  SILMATIPAT", "title": "Xalatan", "sub": "Active ingredient: latanoprost", "str": None, "dose": "1 drop in the evening", "exp": "EXP 2027-10", "cap": (28, 128, 122), "tilt": 1.8},
    {"id": "lo_09", "category": "saline_crust_glare", "degraded": True, "form": "dropper", "defect": "crust", "q": "Are these my Oftan Timolol eye drops?", "expected": "unsure", "exp_str": None, "desc": "Dried crystalline saline residue and specular highlight obliterating Oftan Timolol mg/ml concentration", "hdr": "SANTEN  SILMATIPAT  EYE DROPS", "title": "Oftan Timolol", "sub": "Active ingredient: timolol", "str": None, "dose": "1 drop twice daily", "exp": "EXP 2027-10", "cap": (38, 92, 162), "tilt": -1.7},
    {"id": "lo_10", "category": "syrup_drip_occluded", "degraded": True, "form": "amber", "defect": "syrup", "q": "Is this my Panadol oral suspension?", "expected": "unsure", "exp_str": None, "desc": "Opaque crusted pink suspension drip covering the mg/ml concentration badge on an amber Panadol bottle", "hdr": "ORAALISUSPENSIO  ORAL SUSPENSION", "title": "Panadol", "sub": "Vaikuttava aine: parasetamoli (paracetamol)", "str": None, "dose": "Shake well before oral dosing", "exp": "EXP 2027-11", "cap": (236, 238, 240), "tilt": 1.9},
    {"id": "lo_11", "category": "torn_pipette_tab", "degraded": True, "form": "pipette", "defect": "torn_tab", "q": "Are these my evening glaucoma drops?", "expected": "unsure", "exp_str": None, "desc": "Single-dose ophthalmic pipette card for Xalatan with the bottom concentration tab torn off", "hdr": "SINGLE-DOSE PIPETTE", "title": "Xalatan", "sub": "Active ingredient: latanoprost", "str": None, "dose": "Preservative-free eye drops", "exp": "EXP 2027-10", "cap": (28, 128, 122), "tilt": -1.6},
    {"id": "lo_12", "category": "uninked_ldpe_ampoule", "degraded": True, "form": "pipette", "defect": "uninked", "q": "What eye-drop pipette is this?", "expected": "unsure", "exp_str": None, "desc": "Bare translucent blow-fill-seal LDPE plastic ampoule with clear-on-clear uninked embossing and defocus", "hdr": "", "title": "", "sub": "", "str": None, "dose": "", "exp": "", "cap": (228, 234, 238), "tilt": 2.6},
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
    for p in (home_env, REPO / ".env", pathlib.Path.home() / "junction-meta-glasses" / ".env"):
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
    for d in ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin"):
        cand = pathlib.Path(d) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 15) -> Any:
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)


def render_backdrop(size: int, seed: int) -> Image.Image:
    im = Image.new("RGB", (size, size), (222, 226, 230))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    hz = int(size * 0.62)
    for y in range(hz):
        t = y / max(1, hz)
        d.line((0, y, size, y), fill=(int(236 - 18 * t), int(240 - 18 * t), int(244 - 16 * t)))
    for y in range(hz, size):
        t = (y - hz) / max(1, size - hz)
        j = rng.randint(-2, 2)
        d.line((0, y, size, y), fill=(int(206 - 20 * t) + j, int(202 - 18 * t) + j, int(196 - 16 * t) + j))
    d.line((0, hz, size, hz), fill=(168, 170, 172), width=2)
    return im


def draw_container_body(ld: ImageDraw.ImageDraw, form: str, cap: tuple[int, int, int], pad: int) -> tuple[int, int, int, int]:
    cx = pad + 384
    if form == "dropper":
        ld.polygon([(cx - 34, pad + 116), (cx + 34, pad + 116), (cx + 18, pad + 52), (cx - 18, pad + 52)], fill=(cap[0], cap[1], cap[2], 255))
        ld.rounded_rectangle((cx - 56, pad + 112, cx + 56, pad + 158), radius=8, fill=(cap[0], cap[1], cap[2], 255))
        bx0, by0, bx1, by1 = cx - 216, pad + 158, cx + 216, pad + 694
        ld.rounded_rectangle((bx0, by0, bx1, by1), radius=34, fill=(246, 248, 250, 255), outline=(196, 202, 208, 255), width=3)
        return bx0 + 20, by0 + 34, bx1 - 20, by1 - 32
    if form == "amber":
        ld.rounded_rectangle((cx - 88, pad + 66, cx + 88, pad + 134), radius=10, fill=(cap[0], cap[1], cap[2], 255), outline=(186, 190, 194, 255), width=2)
        ld.rectangle((cx - 68, pad + 134, cx + 68, pad + 168), fill=(116, 62, 24, 255))
        bx0, by0, bx1, by1 = cx - 228, pad + 166, cx + 228, pad + 704
        ld.rounded_rectangle((bx0, by0, bx1, by1), radius=38, fill=(124, 66, 24, 255), outline=(88, 44, 14, 255), width=3)
        return bx0 + 22, by0 + 42, bx1 - 22, by1 - 38
    if form == "pen":
        ld.rounded_rectangle((cx - 148, pad + 54, cx + 148, pad + 142), radius=20, fill=(cap[0], cap[1], cap[2], 255))
        bx0, by0, bx1, by1 = cx - 198, pad + 140, cx + 198, pad + 706
        ld.rounded_rectangle((bx0, by0, bx1, by1), radius=22, fill=(238, 241, 246, 255), outline=(176, 182, 190, 255), width=3)
        return bx0 + 16, by0 + 30, bx1 - 16, by1 - 44
    ld.polygon([(cx - 26, pad + 130), (cx + 26, pad + 130), (cx + 42, pad + 66), (cx - 42, pad + 66)], fill=(230, 236, 240, 220), outline=(188, 196, 202, 235))
    bx0, by0, bx1, by1 = cx - 196, pad + 130, cx + 196, pad + 686
    ld.rounded_rectangle((bx0, by0, bx1, by1), radius=24, fill=(236, 241, 245, 215), outline=(188, 196, 204, 235), width=2)
    return bx0 + 18, by0 + 28, bx1 - 18, by1 - 28


def render_case_bytes(case: dict[str, Any], idx: int) -> bytes:
    seed = 20261160 + idx * 149
    pad, size = 72, 912
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    lx0, ly0, lx1, ly1 = draw_container_body(ld, case["form"], case["cap"], pad)
    if case["defect"] == "uninked":
        for ry, rw in ((ly0 + 54, 180), (ly0 + 108, 150), (ly0 + 168, 120)):
            ld.rounded_rectangle((lx0 + 48, ry, lx0 + 48 + rw, ry + 16), radius=6, fill=(228, 234, 238, 165))
        ld.ellipse((lx0 + 10, ly0 + 20, lx1 - 10, ly1 - 40), fill=(250, 252, 255, 170))
    else:
        ld.rounded_rectangle((lx0, ly0, lx1, ly1), radius=10, fill=(252, 252, 250, 255), outline=(206, 212, 218, 255), width=2)
        ld.rounded_rectangle((lx0, ly0, lx1, ly0 + 54), radius=10, fill=(case["cap"][0], case["cap"][1], case["cap"][2], 255))
        hdr_ink = (24, 28, 34, 255) if sum(case["cap"]) > 520 else (248, 250, 252, 255)
        ld.text((lx0 + 18, ly0 + 15), case["hdr"], fill=hdr_ink, font=fit_font(ld, case["hdr"], lx1 - lx0 - 36, 21))
        ld.text((lx0 + 20, ly0 + 74), case["title"], fill=(16, 22, 30, 255), font=fit_font(ld, case["title"], lx1 - lx0 - 40, 42), stroke_width=1, stroke_fill=(16, 22, 30, 255))
        ld.text((lx0 + 20, ly0 + 134), case["sub"], fill=(42, 50, 60, 255), font=fit_font(ld, case["sub"], lx1 - lx0 - 40, 21))
        sx0, sy0, sx1, sy1 = lx0 + 20, ly0 + 182, lx1 - 20, ly0 + 268
        if case["str"]:
            ld.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(241, 246, 251, 255), outline=(52, 78, 104, 255), width=3)
            ld.text((sx0 + 18, sy0 + 18), case["str"], fill=(14, 20, 28, 255), font=fit_font(ld, case["str"], sx1 - sx0 - 36, 38), stroke_width=1, stroke_fill=(14, 20, 28, 255))
        elif case["defect"] == "finger":
            ld.rounded_rectangle((lx0 - 36, sy0 - 12, sx1 + 10, sy1 + 18), radius=48, fill=(212, 166, 140, 255), outline=(174, 128, 104, 255), width=3)
            ld.rounded_rectangle((sx1 - 56, sy0 + 6, sx1 - 4, sy1 - 6), radius=18, fill=(235, 202, 186, 255), outline=(192, 152, 132, 255), width=2)
        elif case["defect"] == "crust":
            crust = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            cd = ImageDraw.Draw(crust)
            cd.rounded_rectangle((sx0 - 8, sy0 - 10, sx1 + 8, sy1 + 12), radius=20, fill=(252, 253, 255, 255))
            rng_c = random.Random(seed + 19)
            for _ in range(36):
                rx = rng_c.randint(sx0 - 6, sx1 - 12)
                ry = rng_c.randint(sy0 - 6, sy1 - 8)
                cd.ellipse((rx, ry, rx + 24, ry + 18), fill=(246, 248, 250, 255))
            layer = Image.alpha_composite(layer, crust.filter(ImageFilter.GaussianBlur(radius=2.0)))
            ld = ImageDraw.Draw(layer)
        elif case["defect"] == "syrup":
            ld.rounded_rectangle((sx0 - 6, sy0 - 14, sx1 + 6, sy1 + 16), radius=24, fill=(224, 142, 164, 255), outline=(194, 108, 132, 255), width=3)
            ld.ellipse((sx0 + 36, sy1 - 6, sx0 + 98, sy1 + 48), fill=(224, 142, 164, 255))
        if case["defect"] == "torn_tab":
            pts = [(lx0 - 24, sy0 - 8), (lx1 + 24, sy0 + 6), (lx1 + 24, ly1 + 44), (lx0 - 24, ly1 + 44)]
            mask_tear = Image.new("L", (size, size), 255)
            ImageDraw.Draw(mask_tear).polygon(pts, fill=0)
            layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", (size, size), 0), mask_tear))
            ld = ImageDraw.Draw(layer)
            ld.line([pts[0], pts[1]], fill=(214, 218, 222, 255), width=4)
        else:
            ld.text((lx0 + 20, ly0 + 294), case["dose"], fill=(36, 44, 54, 255), font=fit_font(ld, case["dose"], lx1 - lx0 - 40, 21))
            ld.rounded_rectangle((lx0 + 20, ly0 + 344, lx0 + 252, ly0 + 394), radius=6, fill=(244, 246, 248, 255), outline=(140, 150, 160, 255), width=2)
            ld.text((lx0 + 34, ly0 + 356), case["exp"], fill=(20, 26, 34, 255), font=ImageFont.load_default(size=25), stroke_width=1, stroke_fill=(20, 26, 34, 255))
    comp = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    cropped = comp.crop((pad, pad, pad + 768, pad + 768))
    if case["defect"] == "uninked":
        cropped = cropped.filter(ImageFilter.GaussianBlur(radius=9.5))
    arr = np.asarray(cropped, dtype=np.float32)
    rng = np.random.default_rng(seed)
    arr = np.clip(np.round(arr + rng.normal(0.0, 1.4, size=arr.shape)), 0.0, 255.0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="JPEG", quality=90)
    return buf.getvalue()


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


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    sub_env = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if os.path.isdir("/dev/shm"):
        sub_env["TMPDIR"] = "/dev/shm"
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
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", norm_js], input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}), text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert len(render_case_bytes(CASES[0], 1)) > 1000
    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE_NAME
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert isinstance(data["profile"], dict) and isinstance(data["profile"].get("meds"), list)
    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    sub_env = dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL)
    if os.path.isdir("/dev/shm"):
        sub_env["TMPDIR"] = "/dev/shm"
    bridge_in = "\n".join(json.dumps({"read": c["read"], "profile": c.get("profile", data["profile"]), "now": c.get("eval_now_iso", data["eval_now_iso"])}) for c in cases) + "\n"
    proc = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=bridge_in, text=True, capture_output=True, cwd=str(REPO), env=sub_env, check=True)
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
    ap.add_argument("--check", "--verify-cached", "--offline", dest="check", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()
    if args.render_only:
        tmp_root = "/dev/shm" if os.path.isdir("/dev/shm") else None
        with tempfile.TemporaryDirectory(prefix="holdup_lo_", dir=tmp_root) as td:
            for idx, c in enumerate(CASES, 1):
                raw = render_case_bytes(c, idx)
                (pathlib.Path(td) / f"{c['id']}.jpg").write_bytes(raw)
                print(f"{c['id']} ({c['category']}): {len(raw)} bytes")
        return 0
    rendered = [{"case": c, "b64": base64.b64encode(render_case_bytes(c, idx)).decode("ascii")} for idx, c in enumerate(CASES, 1)]
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    workers = max(1, min(6, args.workers))
    with ThreadPoolExecutor(max_workers=workers) as ex:
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
        else:
            cw = bool(false_match or unsafe_reassurance or (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"])))
        verdict_ok = bool(pred == c["expected"])
        cases_out.append(sanitize({
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
        }))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}")
    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    lats = [float(x["latency_ms"]) for x in cases_out]
    clean = [x for x in cases_out if x["category"] == "readable_liquid_ophthalmic"]
    deg = [x for x in cases_out if x["category"] != "readable_liquid_ophthalmic"]
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
        "readable_liquid_accuracy": round(sum(1 for x in clean if x["verdict_ok"]) / len(clean), 4),
        "degraded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4),
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
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) > 15200:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
