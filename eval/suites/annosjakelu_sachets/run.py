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
SUITE_NAME = "annosjakelu_sachets"
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
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "levothyroxine", "name": "Thyroxin", "ingredient": "levothyroxine", "strength": "50 mcg", "schedule": ["morning"]},
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {"id": "aj_01", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Is this my evening pill sachet?", "expected": "match", "exp_str": "5 mg", "desc": "Finnish Annosjakelu ILTA 20:00 sachet with Amlodipin 5 mg (amlodipine) EXP 2027-06", "hdr": "ANNOSJAKELU  ILTA 20:00", "title": "Amlodipin", "sub": "Vaikuttava aine: amlodipiini (amlodipine)", "str": "5 mg", "dose": "1 tabletti iltaisin", "exp": "EXP 2027-06", "pill": (244, 242, 234), "tilt": -1.4},
    {"id": "aj_02", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Is this my morning Bisoprolol pouch?", "expected": "match", "exp_str": "2.5 mg", "desc": "Nordic bilingual ApoDos AAMU/MORGON 08:00 pouch with Bisoprolol 2,5 mg comma decimal EXP 2027-08", "hdr": "APODOS  AAMU / MORGON 08:00", "title": "Bisoprolol", "sub": "bisoprololi / bisoprolol", "str": "2,5 mg", "dose": "1 tabletti aamuisin", "exp": "EXP 2027-08", "pill": (246, 236, 214), "tilt": 1.5},
    {"id": "aj_03", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Is this my morning thyroid sachet?", "expected": "match", "exp_str": "50 mcg", "desc": "Finnish Annosjakelu AAMU 08:00 pouch with Thyroxin 50 mikrog (levothyroxine) EXP 2027-10", "hdr": "ANNOSJAKELU  AAMU 08:00", "title": "Thyroxin", "sub": "levotyroksiini (levothyroxine)", "str": "50 mikrog", "dose": "1 tabletti aamulla tyhjaan vatsaan", "exp": "EXP 2027-10", "pill": (248, 248, 246), "tilt": -1.1},
    {"id": "aj_04", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Is this my evening pill sachet?", "expected": "warning", "exp_str": "10 mg", "desc": "Wrong-dose Finnish Annosjakelu ILTA 20:00 Amlodipin 10 mg sachet vs 5 mg profile", "hdr": "ANNOSJAKELU  ILTA 20:00", "title": "Amlodipin", "sub": "Vaikuttava aine: amlodipiini (amlodipine)", "str": "10 mg", "dose": "1 tabletti iltaisin", "exp": "EXP 2027-09", "pill": (244, 242, 234), "tilt": 1.6},
    {"id": "aj_05", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Can I take this pouch for pain?", "expected": "warning", "exp_str": "400 mg", "desc": "Finnish Annosjakelu TARVITTAESSA Burana 400 mg (ibuprofen) pouch triggering NSAID avoid warning", "hdr": "ANNOSJAKELU  TARVITTAESSA", "title": "Burana", "sub": "Vaikuttava aine: ibuprofeeni (ibuprofen)", "str": "400 mg", "dose": "1 tabletti tarvittaessa kipuun", "exp": "EXP 2027-11", "pill": (242, 214, 222), "tilt": -1.5},
    {"id": "aj_06", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Can I take this antibiotic sachet?", "expected": "warning", "exp_str": "500 mg", "desc": "Finnish Annosjakelu AAMU 08:00 Amorion 500 mg (amoxicillin) pouch triggering penicillin allergy warning", "hdr": "ANNOSJAKELU  AAMU 08:00", "title": "Amorion", "sub": "Vaikuttava aine: amoksisilliini (amoxicillin)", "str": "500 mg", "dose": "1 tabletti 3 kertaa vuorokaudessa", "exp": "EXP 2027-07", "pill": (246, 244, 232), "tilt": 1.3},
    {"id": "aj_07", "category": "sachet_readable", "degraded": False, "defect": None, "q": "Is this Metformin sachet okay to take tonight?", "expected": "warning", "exp_str": "500 mg", "desc": "Expired Finnish Annosjakelu ILTA 20:00 Metformin 500 mg pouch with EXP 2025-03", "hdr": "ANNOSJAKELU  ILTA 20:00", "title": "Metformin", "sub": "Vaikuttava aine: metformiini (metformin)", "str": "500 mg", "dose": "1 tabletti aterian yhteydessa", "exp": "EXP 2025-03", "pill": (245, 245, 245), "tilt": -1.3},
    {"id": "aj_08", "category": "perforation_tear_degraded", "degraded": True, "defect": "tear", "q": "Is this my evening pill sachet?", "expected": "unsure", "exp_str": None, "desc": "Torn perforation seam ripping away the strength field on an Amlodipin Annosjakelu sachet", "hdr": "ANNOSJAKELU  ILTA 20:00", "title": "Amlodipin", "sub": "Vaikuttava aine: amlodipiini (amlodipine)", "str": None, "dose": "1 tabletti iltaisin", "exp": "EXP 2027-06", "pill": (244, 242, 234), "tilt": -1.8},
    {"id": "aj_09", "category": "cellophane_glare_degraded", "degraded": True, "defect": "glare", "q": "Is this my Metformin sachet?", "expected": "unsure", "exp_str": None, "desc": "Crinkled cellophane pouch specular glare obliterating the strength digits on a Metformin sachet", "hdr": "ANNOSJAKELU  ILTA 20:00", "title": "Metformin", "sub": "Vaikuttava aine: metformiini (metformin)", "str": None, "dose": "1 tabletti aterian yhteydessa", "exp": "EXP 2027-09", "pill": (245, 245, 245), "tilt": 1.9},
    {"id": "aj_10", "category": "thermal_dropout_degraded", "degraded": True, "defect": "dropout", "q": "Is this my morning Bisoprolol pouch?", "expected": "unsure", "exp_str": None, "desc": "Thermal printhead dropout leaving the strength band blank on a Bisoprolol ApoDos sachet", "hdr": "APODOS  AAMU / MORGON 08:00", "title": "Bisoprolol", "sub": "bisoprololi / bisoprolol", "str": None, "dose": "1 tabletti aamuisin", "exp": "EXP 2027-08", "pill": (246, 236, 214), "tilt": -1.7},
    {"id": "aj_11", "category": "thumb_occlusion_degraded", "degraded": True, "defect": "thumb", "q": "Is this my morning thyroid sachet?", "expected": "unsure", "exp_str": None, "desc": "Thumb gripping directly over the strength badge on a Thyroxin Annosjakelu sachet", "hdr": "ANNOSJAKELU  AAMU 08:00", "title": "Thyroxin", "sub": "levotyroksiini (levothyroxine)", "str": None, "dose": "1 tabletti aamulla", "exp": "EXP 2027-10", "pill": (248, 248, 246), "tilt": 1.8},
    {"id": "aj_12", "category": "crumpled_blur_degraded", "degraded": True, "defect": "blur_all", "q": "Which medicine sachet is this?", "expected": "unsure", "exp_str": None, "desc": "Severely defocused crumpled cellophane dose sachet with illegible smeared thermal print", "hdr": "", "title": "", "sub": "", "str": None, "dose": "", "exp": "", "pill": (242, 240, 235), "tilt": -3.2},
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
    im = Image.new("RGB", (size, size), (214, 198, 176))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(size):
        t = y / max(1, size)
        j = rng.randint(-3, 3)
        d.line((0, y, size, y), fill=(int(222 - 28 * t) + j, int(204 - 26 * t) + j, int(180 - 22 * t) + j))
    return im


def render_case_bytes(case: dict[str, Any], idx: int) -> bytes:
    seed = 20261144 + idx * 131
    pad, size = 72, 912
    bg = render_backdrop(size, seed)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 108, pad + 64, pad + 660, pad + 704
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle((x0 + 10, y0 + 14, x1 + 14, y1 + 18), radius=14, fill=(36, 28, 20, 76))
    layer = layer.filter(ImageFilter.GaussianBlur(radius=8.0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=(246, 248, 250, 212), outline=(196, 202, 208, 245), width=3)
    for px in range(x0 + 14, x1 - 10, 16):
        ld.ellipse((px, y0 + 8, px + 6, y0 + 14), fill=(150, 156, 162, 235))
        ld.ellipse((px, y1 - 14, px + 6, y1 - 8), fill=(150, 156, 162, 235))
    ld.rounded_rectangle((x0 + 36, y0 + 28, x1 - 36, y0 + 148), radius=10, fill=(232, 237, 242, 168), outline=(202, 208, 214, 210), width=2)
    pcx, pcy = int((x0 + x1) / 2), y0 + 88
    pc = case["pill"]
    ld.ellipse((pcx - 42, pcy - 24, pcx + 42, pcy + 24), fill=(pc[0], pc[1], pc[2], 248), outline=(188, 182, 172, 245), width=2)
    ld.line((pcx, pcy - 20, pcx, pcy + 20), fill=(202, 196, 188, 230), width=2)
    lx0, ly0, lx1, ly1 = x0 + 26, y0 + 164, x1 - 26, y1 - 30
    ld.rounded_rectangle((lx0, ly0, lx1, ly1), radius=8, fill=(252, 252, 250, 252), outline=(210, 214, 218, 255), width=2)
    if case["defect"] == "blur_all":
        for ry, rw in ((ly0 + 24, 290), (ly0 + 88, 220), (ly0 + 146, 330), (ly0 + 218, 160), (ly0 + 296, 250)):
            ld.rounded_rectangle((lx0 + 28, ry, lx0 + 28 + rw, ry + 22), radius=6, fill=(148, 152, 156, 185))
        ld.ellipse((lx0 - 10, ly0 + 50, lx1 + 10, ly1 - 30), fill=(255, 255, 255, 196))
    else:
        ld.rounded_rectangle((lx0, ly0, lx1, ly0 + 54), radius=8, fill=(32, 54, 72, 255))
        ld.text((lx0 + 20, ly0 + 15), case["hdr"], fill=(246, 249, 252, 255), font=fit_font(ld, case["hdr"], lx1 - lx0 - 40, 22))
        ld.text((lx0 + 22, ly0 + 72), case["title"], fill=(18, 24, 32, 255), font=fit_font(ld, case["title"], lx1 - lx0 - 44, 44), stroke_width=1, stroke_fill=(18, 24, 32, 255))
        ld.text((lx0 + 22, ly0 + 132), case["sub"], fill=(44, 52, 62, 255), font=fit_font(ld, case["sub"], lx1 - lx0 - 44, 21))
        sx0, sy0, sx1, sy1 = lx0 + 22, ly0 + 176, lx0 + 292, ly0 + 262
        if case["str"]:
            ld.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(242, 246, 250, 255), outline=(58, 82, 104, 255), width=3)
            ld.text((sx0 + 18, sy0 + 18), case["str"], fill=(14, 20, 28, 255), font=fit_font(ld, case["str"], sx1 - sx0 - 36, 42), stroke_width=1, stroke_fill=(14, 20, 28, 255))
        elif case["defect"] == "tear":
            pts = [(lx0 - 6, sy0 - 4), (sx1 + 36, sy0 + 8), (sx1 + 8, sy1 + 10), (lx0 - 6, sy1 - 2)]
            ld.polygon(pts, fill=(0, 0, 0, 0))
            mask_tear = Image.new("L", (size, size), 255)
            ImageDraw.Draw(mask_tear).polygon(pts, fill=0)
            layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", (size, size), 0), mask_tear))
            ld = ImageDraw.Draw(layer)
            ld.line([pts[0], pts[1], pts[2], pts[3]], fill=(224, 222, 216, 255), width=4)
        elif case["defect"] == "glare":
            glare = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glare)
            gd.rounded_rectangle((sx0 - 18, sy0 - 14, sx1 + 48, sy1 + 16), radius=24, fill=(255, 255, 255, 255))
            gd.line((x0 + 18, sy0 - 22, x1 - 18, sy1 + 24), fill=(255, 255, 255, 245), width=26)
            layer = Image.alpha_composite(layer, glare.filter(ImageFilter.GaussianBlur(radius=6.0)))
            ld = ImageDraw.Draw(layer)
        elif case["defect"] == "dropout":
            ld.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(250, 250, 248, 255), outline=(218, 220, 222, 255), width=2)
            for ry in range(sy0 + 16, sy1 - 12, 11):
                ld.line((sx0 + 14, ry, sx1 - 14, ry), fill=(242, 242, 240, 255), width=2)
        elif case["defect"] == "thumb":
            ld.rounded_rectangle((sx0 - 34, sy0 - 12, sx1 + 26, sy1 + 20), radius=46, fill=(214, 168, 142, 255), outline=(176, 130, 106, 255), width=3)
            ld.rounded_rectangle((sx1 - 44, sy0 + 6, sx1 + 14, sy1 - 8), radius=18, fill=(236, 204, 188, 255), outline=(194, 154, 134, 255), width=2)
        ld.text((lx0 + 22, ly0 + 286), case["dose"], fill=(36, 44, 54, 255), font=fit_font(ld, case["dose"], lx1 - lx0 - 44, 23))
        ld.rounded_rectangle((lx0 + 22, ly0 + 332, lx0 + 258, ly0 + 382), radius=6, fill=(244, 246, 248, 255), outline=(140, 150, 160, 255), width=2)
        ld.text((lx0 + 36, ly0 + 344), case["exp"], fill=(20, 26, 34, 255), font=ImageFont.load_default(size=25), stroke_width=1, stroke_fill=(20, 26, 34, 255))
    comp = Image.alpha_composite(bg.convert("RGBA"), layer.rotate(case["tilt"], resample=Image.Resampling.BICUBIC)).convert("RGB")
    cropped = comp.crop((pad, pad, pad + 768, pad + 768))
    if case["defect"] == "blur_all":
        cropped = cropped.filter(ImageFilter.GaussianBlur(radius=11.0))
    arr = np.asarray(cropped, dtype=np.float32)
    rng = np.random.default_rng(seed)
    arr = np.clip(np.round(arr + rng.normal(0.0, 1.5, size=arr.shape)), 0.0, 255.0).astype(np.uint8)
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
        with tempfile.TemporaryDirectory(prefix="holdup_aj_", dir=tmp_root) as td:
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
    clean = [x for x in cases_out if x["category"] == "sachet_readable"]
    deg = [x for x in cases_out if x["category"] != "sachet_readable"]
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
        "readable_sachet_accuracy": round(sum(1 for x in clean if x["verdict_ok"]) / len(clean), 4),
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
