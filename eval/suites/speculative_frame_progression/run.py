from __future__ import annotations

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

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

for _nb in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
    if os.path.isdir(_nb) and _nb not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

SUITE_DIR = pathlib.Path(__file__).resolve().parent
REPO = SUITE_DIR.parents[2]
OUT_IMG_DIR = REPO / "eval" / "out" / "speculative_frame_progression"
OUT_JSON = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
BRIDGE_REL = "eval/safety_bridge.mts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"

MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
SPEC_MIN_READABILITY = 0.60
MAX_WORKERS = 4

HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_PREFIX = "AI" + "za"
KEY_RE = re.compile(KEY_PREFIX + r"[0-9A-Za-z_-]{8,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "amlodipine",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "metformin",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "atorvastatin",
            "name": "Atorvastatin",
            "ingredient": "atorvastatin",
            "strength": "20 mg",
            "schedule": ["evening"],
        },
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PACK_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {
        "food": False,
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA   Vnr 08 44 12",
        "title": "AMLODIPIN ORION",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "dose": "1 tablet once daily in the evening",
        "exp": "EXP 2027-10",
        "gt_ing": "amlodipine",
        "gt_str": "5 mg",
        "allergen_hit": False,
        "q": "Is this my evening blood pressure pill?",
        "final_expected": "match",
    },
    "aml10": {
        "food": False,
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA   Vnr 09 22 41",
        "title": "AMLODIPIN ORION",
        "sub": "Active ingredient: amlodipine",
        "str": "10 mg",
        "dose": "1 tablet once daily",
        "exp": "EXP 2027-11",
        "gt_ing": "amlodipine",
        "gt_str": "10 mg",
        "allergen_hit": False,
        "q": "Is this my 5 mg evening pill?",
        "final_expected": "warning",
    },
    "cookies_nut": {
        "food": True,
        "accent": (146, 78, 28),
        "hdr": "NORDIC BAKEHOUSE   350 g",
        "title": "Morning Harvest Cookies",
        "ing": "Ingredients: wheat flour, roasted hazelnuts (14%),\npeanuts (8%), cane sugar, rapeseed oil.",
        "alg": "Allergens: contains hazelnuts (tree nuts), peanuts, wheat.",
        "exp": "Best before: 2027-10-18",
        "gt_ing": None,
        "gt_str": None,
        "allergen_hit": True,
        "q": "Are these cookies safe with my nut allergies?",
        "final_expected": "warning",
    },
    "biscuits_safe": {
        "food": True,
        "accent": (42, 114, 84),
        "hdr": "NORDIC BAKEHOUSE   250 g",
        "title": "Golden Tea Biscuits",
        "ing": "Ingredients: wheat flour, wholegrain oats (18%),\nrapeseed oil, sea salt.",
        "alg": "Allergens: contains wheat, oats (gluten).",
        "exp": "Best before: 2027-11-24",
        "gt_ing": None,
        "gt_str": None,
        "allergen_hit": False,
        "q": "Are these biscuits safe with my nut allergies?",
        "final_expected": "info",
    },
}


def build_cases() -> list[dict[str, Any]]:
    seq_order = [
        ("aml5", 16.0, "Amlodipin 5 mg"),
        ("aml10", -16.0, "Amlodipin 10 mg"),
        ("cookies_nut", -17.0, "Morning Harvest Cookies"),
        ("biscuits_safe", 17.0, "Golden Tea Biscuits"),
    ]
    rows: list[dict[str, Any]] = []
    idx = 1
    for pack_key, angle, label_desc in seq_order:
        spec = PACK_SPECS[pack_key]
        occluded_part = "allergens" if spec["food"] else "strength"
        steps = [
            (
                1,
                "frame_1_far_blur",
                "unsure",
                f"F1/3 {label_desc}: far motion-blurred capture",
            ),
            (
                2,
                "frame_2_rotated_occluded",
                "unsure",
                f"F2/3 {label_desc}: rotated {angle:+.0f} deg, thumb over {occluded_part}",
            ),
            (
                3,
                "frame_3_sharp_front",
                spec["final_expected"],
                f"F3/3 {label_desc}: steady sharp front view",
            ),
        ]
        for step_num, cat, exp_lvl, desc in steps:
            rows.append(
                {
                    "id": f"sfp_{idx:02d}",
                    "pack_key": pack_key,
                    "frame_step": step_num,
                    "angle": angle,
                    "category": cat,
                    "degraded": step_num < 3,
                    "expected": exp_lvl,
                    "q": spec["q"],
                    "desc": desc,
                }
            )
            idx += 1
    return rows


CASES = build_cases()


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k, v = chunk.split(b"=", 1)
                    ks = k.decode("utf-8", "ignore").strip()
                    if ks and ks not in os.environ:
                        os.environ[ks] = v.decode("utf-8", "ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    cands = [
        home_env,
        REPO / ".env",
        pathlib.Path.home() / "junction-meta-glasses" / ".env",
    ]
    if os.environ.get("HOLDUP_ENV_FILE"):
        cands.insert(0, pathlib.Path(os.environ["HOLDUP_ENV_FILE"]))
    for p in cands:
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


def jpeg_sharpness(raw_jpeg: bytes, w: int = 768, h: int = 768) -> float:
    return round(max(0.0, min(1.0, len(raw_jpeg) / (w * h) / 0.35)), 4)


def find_node() -> str:
    for d in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin"):
        cand = pathlib.Path(d) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def render_counter(seed: int, grain: int = 2, blur_radius: float = 1.2) -> Image.Image:
    im = Image.new("RGB", (768, 768), (224, 219, 210))
    d = ImageDraw.Draw(im)
    rng = random.Random(seed)
    for y in range(300):
        c = int(230 - 16 * (y / 300))
        j = rng.randint(-grain, grain)
        d.line((0, y, 768, y), fill=(max(0, min(255, c + j)), max(0, min(255, c - 4 + j)), max(0, min(255, c - 9 + j))))
    for y in range(300, 768):
        t = (y - 300) / 468
        j = rng.randint(-grain, grain)
        r = max(0, min(255, int(182 - 26 * t) + j))
        g = max(0, min(255, int(154 - 22 * t) + j))
        b = max(0, min(255, int(124 - 18 * t) + j))
        d.line((0, y, 768, y), fill=(r, g, b))
    d.line((0, 300, 768, 300), fill=(124, 100, 78), width=3)
    if blur_radius > 0:
        return im.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return im


def motion_blur_horizontal(im: Image.Image, radius_px: int = 16) -> Image.Image:
    acc: list[Image.Image] = []
    shifts = list(range(-radius_px, radius_px + 1, 4))
    for dx in shifts:
        dy = int(dx * 0.35)
        shifted = im.transform(im.size, Image.Transform.AFFINE, (1, 0, dx, 0, 1, dy), resample=Image.Resampling.BILINEAR)
        acc.append(shifted)
    out = acc[0].convert("RGBA")
    for idx, layer in enumerate(acc[1:], 2):
        out = Image.blend(out, layer.convert("RGBA"), 1.0 / idx)
    return out.convert("RGB").filter(ImageFilter.GaussianBlur(radius=4.2))


def render_pack_card(
    spec: dict[str, Any],
    w: int,
    h: int,
    occlude_critical: bool = False,
) -> Image.Image:
    bg_col = (248, 243, 234) if spec["food"] else (250, 251, 253)
    im = Image.new("RGB", (w, h), bg_col)
    d = ImageDraw.Draw(im)
    compact = w < 520
    hdr_h = 46 if compact else 54
    d.rectangle((0, 0, w, hdr_h), fill=spec["accent"])
    d.text((20, 14 if compact else 16), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=17 if compact else 20))
    d.text((20, 64 if compact else 74), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=30 if compact else 36))

    if spec["food"]:
        if not occlude_critical:
            d.rounded_rectangle((18, 132, w - 18, h - 76), radius=8, fill=(254, 253, 249), outline=(182, 176, 164), width=2)
            d.text((28, 150), spec["ing"], fill=(24, 28, 26), font=ImageFont.load_default(size=16 if compact else 18))
            d.rounded_rectangle((28, 206, w - 28, 276), radius=6, fill=(255, 244, 232), outline=(196, 124, 66), width=2)
            d.text((36, 228), spec["alg"], fill=(104, 38, 20), font=ImageFont.load_default(size=16 if compact else 19))
            d.text((22, h - 52), spec["exp"], fill=(22, 26, 30), font=ImageFont.load_default(size=19 if compact else 22))
        else:
            d.rounded_rectangle((14, 124, w - 14, h - 18), radius=34, fill=(212, 172, 144), outline=(172, 132, 104), width=3)
            d.rounded_rectangle((w - 120, 148, w - 34, 224), radius=20, fill=(234, 204, 184), outline=(188, 148, 122), width=2)
        return im

    d.text((20, 114 if compact else 128), spec["sub"], fill=(46, 54, 64), font=ImageFont.load_default(size=19 if compact else 22))
    bx1, by1 = 20, (158 if compact else 174)
    bx2, by2 = bx1 + (196 if compact else 224), by1 + (66 if compact else 72)
    if not occlude_critical:
        d.rounded_rectangle((bx1, by1, bx2, by2), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
        d.text((bx1 + 18, by1 + 14), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=32 if compact else 40))
        d.text((20, by2 + 24), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=18 if compact else 21))
        d.text((20, h - 52), f"30 tablets    {spec['exp']}", fill=(24, 30, 38), font=ImageFont.load_default(size=19 if compact else 22))
    else:
        d.rounded_rectangle((8, by1 - 12, bx2 + 78, by2 + 28), radius=36, fill=(212, 172, 144), outline=(172, 132, 104), width=3)
        d.rounded_rectangle((bx2 + 6, by1 + 4, bx2 + 66, by2 + 12), radius=18, fill=(234, 204, 184), outline=(188, 148, 122), width=2)
        d.text((20, h - 48), spec["exp"], fill=(28, 34, 42), font=ImageFont.load_default(size=18))
    return im


def encode_jpeg(im: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def render_sequence_frames(pack_key: str, angle: float, seq_idx: int) -> list[bytes]:
    spec = PACK_SPECS[pack_key]
    seed = 202690 + seq_idx * 53

    f1_bg = render_counter(seed, grain=0, blur_radius=6.0)
    d1 = ImageDraw.Draw(f1_bg)
    d1.rounded_rectangle((328, 386, 444, 472), radius=6, fill=(242, 242, 240), outline=(188, 186, 182), width=2)
    d1.rectangle((328, 386, 444, 400), fill=spec["accent"])
    d1.rounded_rectangle((352, 462, 420, 512), radius=18, fill=(208, 168, 140))
    f1 = motion_blur_horizontal(f1_bg, radius_px=20)

    f2_bg = render_counter(seed + 11, grain=2, blur_radius=2.2).convert("RGBA")
    card2 = render_pack_card(spec, 468, 352, occlude_critical=True).convert("RGBA")
    rot2 = card2.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    px2 = int((768 - rot2.width) / 2)
    py2 = int((768 - rot2.height) / 2) + 24
    f2_bg.alpha_composite(rot2, (px2, py2))
    f2 = f2_bg.convert("RGB").filter(ImageFilter.GaussianBlur(radius=0.5))

    f3 = render_counter(seed + 23, grain=9, blur_radius=0.0)
    card3 = render_pack_card(spec, 592, 436, occlude_critical=False)
    x3, y3 = int((768 - 592) / 2), 198
    d3 = ImageDraw.Draw(f3)
    d3.rounded_rectangle((x3 + 6, y3 + 8, x3 + 598, y3 + 444), radius=10, fill=(90, 76, 62))
    f3.paste(card3, (x3, y3))
    d3.rectangle((x3, y3, x3 + 591, y3 + 435), outline=(156, 162, 170), width=2)
    cx = x3 + 296
    d3.rounded_rectangle((cx - 116, y3 + 424, cx - 30, y3 + 506), radius=28, fill=(212, 172, 144), outline=(176, 136, 108), width=2)
    d3.rounded_rectangle((cx + 30, y3 + 424, cx + 116, y3 + 506), radius=28, fill=(208, 168, 140), outline=(174, 134, 106), width=2)

    return [encode_jpeg(f1, quality=78), encode_jpeg(f2, quality=88), encode_jpeg(f3, quality=95)]


def pick_ring_frames(seq_jpegs: list[bytes], up_to_step: int, k: int = 2) -> tuple[list[str], list[int], list[float]]:
    avail = []
    for idx in range(up_to_step):
        raw = seq_jpegs[idx]
        avail.append((jpeg_sharpness(raw), idx + 1, base64.b64encode(raw).decode("ascii")))
    ordered = sorted(avail, key=lambda item: (item[0], item[1]), reverse=True)[:k]
    return [x[2] for x in ordered], [x[1] for x in ordered], [x[0] for x in ordered]


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frames_b64: list[str], question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"inlineData": {"mimeType": "image/jpeg", "data": b}} for b in frames_b64] + [
        {"text": f'The person asked: "{question}"'}
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
    timed_out = False
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(
                url,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                json=payload,
                timeout=45,
            )
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next(
                    (p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()),
                    "",
                )
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2**attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": timed_out}


def score_with_ts_and_bridge(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    norm_js = (
        'import fs from "node:fs"; '
        'import { toLabelRead } from "./server/src/verify.ts"; '
        'import { sameStrength, allergenHits } from "./server/src/safety.ts"; '
        'const inp = JSON.parse(fs.readFileSync(0, "utf8")); '
        "process.stdout.write(JSON.stringify(inp.rows.map((r) => { "
        "const read = toLabelRead(r.raw); "
        "return { id: r.id, read, str_same: r.gt_str ? sameStrength(read.strength.value, r.gt_str) : false, "
        "alg_hits: allergenHits(read, inp.allergies).length }; "
        "})));"
    )
    p1 = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "-e", norm_js],
        input=json.dumps({"rows": raw_rows, "allergies": PROFILE["allergies"]}),
        text=True,
        capture_output=True,
        cwd=str(REPO),
        check=True,
    )
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    bridge_in = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run(
        [node, "--import", "tsx", BRIDGE_REL],
        input=bridge_in,
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL),
        check=True,
    )
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def compute_prompt_hashes() -> tuple[str, str, str]:
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    p_sha = hashlib.sha256(prompt_txt.encode("utf-8")).hexdigest()
    s_sha = hashlib.sha256(schema_txt.encode("utf-8")).hexdigest()
    combo_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
    return combo_12, p_sha, s_sha


def check_existing() -> int:
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and EM_DASH not in src_py and EN_DASH not in src_py
    assert README_PATH.is_file()
    readme_txt = README_PATH.read_text(encoding="utf-8")
    assert readme_txt.strip() and EM_DASH not in readme_txt and EN_DASH not in readme_txt and KEY_PREFIX not in readme_txt

    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) <= 15360, f"results.json size {len(raw_bytes)} > 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and KEY_PREFIX not in raw_txt and not KEY_RE.search(raw_txt)

    data = json.loads(raw_txt)
    combo_12, p_sha, s_sha = compute_prompt_hashes()
    assert data["suite"] == "speculative_frame_progression"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == combo_12 == "814770315c42"
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["safety_module"] == SAFETY_TS_REL
    assert data["errors"] == 0 and data["timeouts"] == 0

    cases = data["cases"]
    s = data["summary"]
    assert len(cases) == 12 and s["n_cases"] == 12
    for seq_start in range(0, 12, 3):
        f1, f2, f3 = cases[seq_start : seq_start + 3]
        assert [f1["frame_step"], f2["frame_step"], f3["frame_step"]] == [1, 2, 3]
        assert f1["sharpness_top"] < f2["sharpness_top"] < f3["sharpness_top"]
        assert f1["expected_level"] == "unsure" and f2["expected_level"] == "unsure"

    bridge_in = "\n".join(
        json.dumps({"read": c["read"], "profile": data["profile"], "now": data["eval_now_iso"]}) for c in cases
    ) + "\n"
    proc = subprocess.run(
        [find_node(), "--import", "tsx", BRIDGE_REL],
        input=bridge_in,
        text=True,
        capture_output=True,
        cwd=str(REPO),
        env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL),
        check=True,
    )
    re_verdicts = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert len(re_verdicts) == len(cases)
    for c, rv in zip(cases, re_verdicts):
        assert rv["level"] == c["predicted_level"], f"{c['id']}: bridge {rv['level']} != {c['predicted_level']}"
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"]) == 12
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_dose_count"] == 0
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert (
        s["unsafe_reassurance_count"]
        == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info"))
        == 0
    )
    assert s["early_frame_premature_match_count"] == 0
    assert s["early_frame_abstention_rate"] == 1.0
    assert s["final_frame_verdict_accuracy"] == 1.0
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    if args.check or args.offline:
        return check_existing()

    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    seq_Order_keys = ["aml5", "aml10", "cookies_nut", "biscuits_safe"]
    seq_angles = {"aml5": 16.0, "aml10": -16.0, "cookies_nut": -17.0, "biscuits_safe": 17.0}
    seq_jpegs: dict[str, list[bytes]] = {}
    for s_idx, pk in enumerate(seq_Order_keys, 1):
        jpegs = render_sequence_frames(pk, seq_angles[pk], s_idx)
        seq_jpegs[pk] = jpegs
        for f_idx, raw in enumerate(jpegs, 1):
            (OUT_IMG_DIR / f"{pk}_f{f_idx}.jpg").write_bytes(raw)
        sh = [jpeg_sharpness(x) for x in jpegs]
        assert sh[0] < sh[1] < sh[2], f"{pk}: sharpness not strictly increasing: {sh}"

    prepared: list[dict[str, Any]] = []
    for c in CASES:
        b64s, picked_steps, picked_sharp = pick_ring_frames(seq_jpegs[c["pack_key"]], c["frame_step"], k=2)
        prepared.append(
            {
                "case": c,
                "b64s": b64s,
                "picked_steps": picked_steps,
                "sharpness_top": picked_sharp[0],
            }
        )

    if args.render_only:
        for item in prepared:
            c = item["case"]
            print(f"{c['id']} step={c['frame_step']} picked={item['picked_steps']} sharp_top={item['sharpness_top']}")
        return 0

    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")

    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    combo_12, p_sha, s_sha = compute_prompt_hashes()
    schema = inline_refs(json.loads(schema_txt))

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64s"], r["case"]["q"]), prepared))

    errors = sum(0 if o.get("ok") else 1 for o in api_outs)
    timeouts = sum(1 if o.get("timeout") else 0 for o in api_outs)
    if errors:
        raise RuntimeError(f"API errors: {errors} (timeouts={timeouts})")

    scored = score_with_ts_and_bridge(
        [
            {
                "id": r["case"]["id"],
                "raw": o["raw"],
                "gt_str": PACK_SPECS[r["case"]["pack_key"]]["gt_str"],
            }
            for r, o in zip(prepared, api_outs)
        ]
    )

    cases_out: list[dict[str, Any]] = []
    cw_dose_n = 0
    for r, o in zip(prepared, api_outs):
        c = r["case"]
        spec = PACK_SPECS[c["pack_key"]]
        sc = scored[c["id"]]
        rd = sc["read"]
        vd = sc["verdict"]
        pred = str(vd["level"])
        s_val = rd["strength"]["value"]
        s_conf = float(rd["strength"]["confidence"] or 0.0)

        false_match = bool(pred == "match" and c["expected"] != "match")
        unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
        if c["degraded"]:
            cw_dose = bool(s_conf >= STRENGTH_MIN_CONF)
            premature_food_info = bool(spec["food"] and pred in ("match", "info"))
            cw = bool(false_match or unsafe_reassurance or cw_dose or premature_food_info)
        elif not spec["food"]:
            cw_dose = bool(s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"]))
            cw = bool(false_match or unsafe_reassurance or cw_dose)
        else:
            cw_dose = bool(s_val is not None and s_conf >= STRENGTH_MIN_CONF)
            alg_miss = bool(spec["allergen_hit"] and float(rd["allergens"]["confidence"] or 0.0) >= 0.8 and sc["alg_hits"] == 0)
            cw = bool(false_match or unsafe_reassurance or cw_dose or alg_miss)
        if cw_dose:
            cw_dose_n += 1

        verdict_ok = bool(pred == c["expected"])
        cases_out.append(
            sanitize(
                {
                    "id": c["id"],
                    "frame_step": c["frame_step"],
                    "sharpness_top": r["sharpness_top"],
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
            )
        )
        print(
            f"[{c['id']}] step={c['frame_step']} picked={r['picked_steps']} "
            f"exp={c['expected']} pred={pred} ok={verdict_ok} cw={cw} ms={o['ms']}"
        )

    n = len(cases_out)
    v_matches = sum(1 for x in cases_out if x["verdict_ok"])
    cw_n = sum(1 for x in cases_out if x["confident_wrong"])
    fm_n = sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
    early = [x for x in cases_out if x["frame_step"] < 3]
    final = [x for x in cases_out if x["frame_step"] == 3]
    premature_match_n = sum(1 for x in early if x["predicted_level"] in ("match", "info"))
    early_cacheable_n = sum(
        1 for x in early if x["read"]["kind"] != "unreadable" and float(x["read"]["readability"] or 0.0) >= SPEC_MIN_READABILITY
    )
    lats = [float(x["latency_ms"]) for x in cases_out]

    summary = {
        "n_cases": n,
        "errors": errors,
        "timeouts": timeouts,
        "verdict_matches": v_matches,
        "verdict_accuracy": round(v_matches / n, 4),
        "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
        "confident_wrong_count": cw_n,
        "confident_wrong_dose_count": cw_dose_n,
        "confident_wrong_rate": round(cw_n / n, 4),
        "confident_wrong_ci95": wilson_ci95(cw_n, n),
        "false_match_count": fm_n,
        "unsafe_reassurance_count": ur_n,
        "abstain_or_unsure_count": abs_n,
        "early_frame_cacheable_count": early_cacheable_n,
        "early_frame_premature_match_count": premature_match_n,
        "early_frame_abstention_rate": round(sum(1 for x in early if x["predicted_level"] == "unsure") / len(early), 4),
        "final_frame_verdict_accuracy": round(sum(1 for x in final if x["verdict_ok"]) / len(final), 4),
        "latency_p50_ms": pctile(lats, 0.50),
        "latency_p95_ms": pctile(lats, 0.95),
    }

    payload = sanitize(
        {
            "suite": "speculative_frame_progression",
            "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "eval_now_iso": NOW_ISO,
            "model": MODEL,
            "thinking_level": THINKING_LEVEL,
            "prompt_source": PROMPT_SOURCE,
            "prompt_sha256_12": combo_12,
            "prompt_sha256": p_sha,
            "schema_sha256": s_sha,
            "safety_module": SAFETY_TS_REL,
            "n": n,
            "errors": errors,
            "timeouts": timeouts,
            "pass_count": v_matches,
            "pass_rate": round(v_matches / n, 4),
            "pass_ci95_wilson": wilson_ci95(v_matches, n),
            "confident_wrong_dose_count": cw_dose_n,
            "confident_wrong_dose_rate": round(cw_dose_n / n, 4),
            "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_dose_n, n),
            "rule_of_three_95_upper": round(min(1.0, 3.0 / n), 4),
            "profile": PROFILE,
            "summary": summary,
            "cases": cases_out,
        }
    )
    OUT_JSON.write_text(json.dumps(payload, indent=1, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
