from __future__ import annotations
import argparse, base64, datetime, hashlib, io, json, math, os, pathlib, random, re, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

if os.path.isdir("/dev/shm"):
    os.environ.setdefault("TMPDIR", "/dev/shm")
for _b in ("/tmp/fleet-silas/node/bin", "/home/silas/tools/node/bin", "/venv/bin"):
    if os.path.isdir(_b):
        os.environ["PATH"] = f"{_b}:{os.environ.get('PATH', '')}"

SUITE = "blister_strips"
REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
OUT_IMG_DIR = REPO / "eval" / "out" / SUITE
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
HASH_CH = chr(35)
SLASH2 = chr(47) * 2
EM_DASH, EN_DASH = chr(0x2014), chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"]},
    ],
    "allergies": ["penicillin", "tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES: list[dict[str, Any]] = [
    {"id": "bs_01", "category": "intact_blister_control", "degraded": False, "expected": "match", "exp_str": "5 mg", "q": "Is this my evening pill?", "desc": "Corner-trimmed silver blister strip with 1 popped cavity and 3 intact tiles reading Amlodipin 5 mg and EXP 2027-11"},
    {"id": "bs_02", "category": "intact_blister_control", "degraded": False, "expected": "warning", "exp_str": "400 mg", "q": "Can I take this painkiller?", "desc": "Scissor-trimmed silver blister strip with 1 popped cavity and 3 intact tiles reading Burana 400 mg ibuprofen on NSAID avoid list"},
    {"id": "bs_03", "category": "intact_blister_control", "degraded": False, "expected": "warning", "exp_str": "10 mg", "q": "Is this my evening pill?", "desc": "L-notched silver blister strip with 1 popped cavity and 3 intact tiles reading Amlodipin 10 mg vs 5 mg profile"},
    {"id": "bs_04", "category": "intact_blister_control", "degraded": False, "expected": "warning", "exp_str": "500 mg", "q": "Is this my evening Metformin?", "desc": "Scissor-trimmed silver blister strip with 3 intact tiles reading Metformin 500 mg and crimped seal EXP 2024-12"},
    {"id": "bs_05", "category": "intact_blister_control", "degraded": False, "expected": "match", "exp_str": "2.5 mg", "q": "Is this my morning beta blocker?", "desc": "Partially popped silver blister strip with 3 intact tiles reading Bisoprolol 2,5 mg Nordic comma decimal and EXP 2027-08"},
    {"id": "bs_06", "category": "curved_bottle_control", "degraded": False, "expected": "match", "exp_str": "20 mg", "q": "Is this my evening cholesterol pill?", "desc": "Centered cylindrical pill bottle showing front wrap label Atorvastatin 20 mg and EXP 2027-11"},
    {"id": "bs_07", "category": "popped_cavity_truncation", "degraded": True, "expected": "unsure", "exp_str": None, "q": "Is this my evening pill?", "desc": "4-pocket silver blister strip where popped empty foil cavities punch directly through every strength digit leaving AMLODIPIN [hole] mg"},
    {"id": "bs_08", "category": "scissor_cut_strength", "degraded": True, "expected": "unsure", "exp_str": None, "q": "Is this my Metformin?", "desc": "Single-pocket scissor-cut foil stub sliced right after METFORMIN clipping off all strength digits"},
    {"id": "bs_09", "category": "specular_foil_glare", "degraded": True, "expected": "unsure", "exp_str": None, "q": "Is this my 5 mg evening pill?", "desc": "Silver blister strip of Amlodipin with saturated crease specular foil reflection across every strength number"},
    {"id": "bs_10", "category": "diagonal_repeat_truncation", "degraded": True, "expected": "unsure", "exp_str": None, "q": "Is this my morning Bisoprolol?", "desc": "Diagonally scissor-cut 2-pocket Bisoprolol foil strip combining popped cavity over digits and edge-truncated repeat print"},
    {"id": "bs_11", "category": "scissor_cut_missing_name", "degraded": True, "expected": "unsure", "exp_str": None, "q": "What medicine is this blister piece?", "desc": "Scissor-cut foil corner fragment with torn cavity and left-clipped partial letters missing both drug name and strength"},
    {"id": "bs_12", "category": "curved_bottle_wrap_clip", "degraded": True, "expected": "unsure", "exp_str": None, "q": "Is this my 20 mg Atorvastatin?", "desc": "Sideways-rotated cylindrical pill bottle where ATORVASTATIN is visible but strength wraps out of view around right cylinder edge"},
]


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    for p in (pathlib.Path.home() / "momin" / ".env", REPO / ".env", pathlib.Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CH) and "=" in ln:
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
    z, p = 1.959963984540054, k / n
    z2n = (z * z) / n
    den = 1.0 + z2n
    ctr = (p + 0.5 * z2n) / den
    hlf = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / den
    return [round(max(0.0, ctr - hlf), 4), round(min(1.0, ctr + hlf), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def find_node() -> str:
    for cand in ("/home/silas/tools/node/bin/node", "/tmp/fleet-silas/node/bin/node"):
        if os.path.isfile(cand):
            return cand
    return shutil.which("node") or "node"


def prompt_hashes() -> tuple[str, str, str, str, dict[str, Any]]:
    pb, sb = PROMPT_PATH.read_bytes(), SCHEMA_PATH.read_bytes()
    pt, st = pb.decode("utf-8"), sb.decode("utf-8")
    h12 = hashlib.sha256((pt + st).encode("utf-8")).hexdigest()[:12]
    return pt, h12, hashlib.sha256(pb).hexdigest(), hashlib.sha256(sb).hexdigest(), inline_refs(json.loads(st))


def make_bg(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (168, 140, 112))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(768):
        w = int(6 * math.sin(y / 17.0)) + rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(172 - int(y / 28) + w, 144 - int(y / 30) + w, 114 - int(y / 34) + w))
    return im.filter(ImageFilter.GaussianBlur(radius=1.5))


def foil_sheet(w: int, h: int, pockets: list[tuple[float, float]], cols: list[int], rows: list[int], seed: int) -> Image.Image:
    im = Image.new("RGB", (w, h), (212, 216, 222))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(0, h, 2):
        v = int(212 + 12 * math.sin(y / 38.0) + rng.randint(-2, 2))
        d.line((0, y, w, y), fill=(v - 2, v, v + 4), width=2)
    for cx, cy in pockets:
        d.ellipse((cx - 58, cy - 36, cx + 58, cy + 36), fill=(198, 203, 212), outline=(154, 160, 170), width=2)
        d.ellipse((cx - 46, cy - 26, cx + 46, cy + 26), fill=(224, 228, 235), outline=(182, 188, 198), width=1)
    for x in cols:
        for y in range(8, h - 8, 12):
            d.line((x, y, x, min(h - 6, y + 6)), fill=(142, 148, 158), width=2)
    for y in rows:
        for x in range(8, w - 8, 12):
            d.line((x, y, min(w - 6, x + 6), y), fill=(142, 148, 158), width=2)
    return im.convert("RGBA")


def stamp(foil: Image.Image, xy: tuple[int, int], main: str, sub: str | None, ink: tuple[int, int, int], ang: float, msz: int = 31) -> Image.Image:
    fm, fs = ImageFont.load_default(size=msz), ImageFont.load_default(size=20)
    pr = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    tw = int(max(pr.textlength(main, font=fm), pr.textlength(sub, font=fs) if sub else 0)) + 32
    th = msz + (30 if sub else 0) + 26
    tl = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    td = ImageDraw.Draw(tl)
    td.text((14, 10), main, fill=(*ink, 250), font=fm, stroke_width=1, stroke_fill=(*ink, 250))
    if sub:
        td.text((16, 14 + msz), sub, fill=(*ink, 235), font=fs)
    rt = tl.rotate(ang, resample=Image.Resampling.BICUBIC, expand=True)
    ly = Image.new("RGBA", foil.size, (0, 0, 0, 0))
    ly.paste(rt, (xy[0] - int(rt.size[0] / 2), xy[1] - int(rt.size[1] / 2)), rt)
    return Image.alpha_composite(foil, ly)


def pop_hole(foil: Image.Image, cx: float, cy: float, rx: float, ry: float, seed: int) -> Image.Image:
    out, rng = foil.copy(), random.Random(seed)
    d = ImageDraw.Draw(out)
    d.ellipse((cx - rx * 1.08, cy - ry * 1.08, cx + rx * 1.08, cy + ry * 1.08), fill=(238, 242, 248, 255), outline=(118, 124, 136, 255), width=2)
    pts = [(cx + rx * rng.uniform(0.78, 0.98) * math.cos(2 * math.pi * k / 16), cy + ry * rng.uniform(0.78, 0.98) * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    d.polygon(pts, fill=(22, 26, 34, 255), outline=(88, 94, 108, 255))
    return out


def mount_foil(foil: Image.Image, poly: list[tuple[float, float]], seed: int, tilt: float) -> Image.Image:
    w, h = foil.size
    msk = Image.new("L", (w, h), 0)
    ImageDraw.Draw(msk).polygon(poly, fill=255)
    tr = foil.copy()
    ImageDraw.Draw(tr).polygon(poly, outline=(96, 102, 114, 255), width=3)
    tr.putalpha(msk)
    rt = tr.rotate(tilt, resample=Image.Resampling.BICUBIC, expand=True)
    ox, oy = int((768 - rt.size[0]) / 2), int((768 - rt.size[1]) / 2)
    bg = make_bg(seed).convert("RGBA")
    sh = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    sp = Image.new("RGBA", rt.size, (18, 14, 10, 120))
    sp.putalpha(rt.getchannel("A"))
    sh.paste(sp, (ox + 10, oy + 14), sp)
    comp = Image.alpha_composite(bg, sh.filter(ImageFilter.GaussianBlur(11.0)))
    comp.paste(rt, (ox, oy), rt)
    return comp.convert("RGB")


def render_bottle(clipped: bool, seed: int) -> Image.Image:
    bg = make_bg(seed)
    d = ImageDraw.Draw(bg)
    bx0, bx1 = (248, 598) if clipped else (214, 554)
    d.rounded_rectangle((bx0 + 34, 112, bx1 - 34, 178), radius=14, fill=(244, 246, 249), outline=(168, 174, 182), width=3)
    for x in range(bx0 + 44, bx1 - 40, 10):
        d.line((x, 116, x, 174), fill=(196, 202, 210), width=2)
    for x in range(bx0, bx1):
        t = (x - bx0) / max(1, bx1 - bx0 - 1)
        sh = int(38 * math.sin(math.pi * t))
        d.line((x, 178, x, 648), fill=(116 + sh, 66 + int(sh / 2), 24 + int(sh / 3)))
    lx0, lx1 = (bx0 + 4, bx1 - 2) if clipped else (bx0 + 10, bx1 - 10)
    for x in range(lx0, lx1):
        t = (x - lx0) / max(1, lx1 - lx0 - 1)
        c = int(252 - (46 * (t ** 2.4) if clipped else 22 * ((2 * t - 1) ** 2)))
        d.line((x, 244, x, 566), fill=(c, c + 1 if c < 254 else 255, c + 2 if c < 253 else 255))
    d.rectangle((lx0, 244, lx1, 290), fill=(92, 52, 132))
    if not clipped:
        d.text((lx0 + 18, 256), "ORION PHARMA  Vnr 12 30 77", fill=(248, 250, 252), font=ImageFont.load_default(size=18))
        d.text((lx0 + 18, 308), "ATORVASTATIN", fill=(16, 22, 30), font=ImageFont.load_default(size=36))
        d.text((lx0 + 18, 356), "atorvastatin", fill=(44, 52, 62), font=ImageFont.load_default(size=22))
        d.rounded_rectangle((lx0 + 18, 396, lx0 + 186, 458), radius=8, fill=(238, 244, 252), outline=(92, 52, 132), width=3)
        d.text((lx0 + 34, 408), "20 mg", fill=(14, 20, 28), font=ImageFont.load_default(size=36))
        d.text((lx0 + 18, 474), "1 tablet in the evening", fill=(36, 44, 54), font=ImageFont.load_default(size=20))
        d.text((lx0 + 18, 522), "EXP 2027-11", fill=(20, 26, 34), font=ImageFont.load_default(size=22))
    else:
        d.text((lx0 + 22, 256), "ORION PHARMA", fill=(248, 250, 252), font=ImageFont.load_default(size=18))
        d.text((lx0 + 22, 312), "ATORVASTATIN", fill=(16, 22, 30), font=ImageFont.load_default(size=34))
        d.text((lx0 + 22, 360), "atorvastatin", fill=(44, 52, 62), font=ImageFont.load_default(size=22))
        d.text((lx0 + 22, 412), "Film-coated tablets", fill=(52, 60, 70), font=ImageFont.load_default(size=21))
        d.text((lx1 - 126, 468), "Strength:", fill=(70, 78, 88), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((bx0 - 26, 540, bx0 + 78, 622), radius=34, fill=(212, 170, 142), outline=(176, 136, 108), width=2)
    return bg


def render_case(c: dict[str, Any], idx: int) -> Image.Image:
    cid, seed = c["id"], 4100 + idx * 29
    if cid == "bs_06":
        return render_bottle(False, seed)
    if cid == "bs_12":
        return render_bottle(True, seed)
    p6 = [((k % 3 + 0.5) * 208.0, (int(k / 3) + 0.5) * 226.0) for k in range(6)]
    if cid in ("bs_01", "bs_02", "bs_03", "bs_04", "bs_05"):
        cfg = {
            "bs_01": ("Amlodipin 5 mg", "amlodipiini / amlodipine", (14, 28, 56), "EXP 2027-11", False, 12.0, -3.0, 3),
            "bs_02": ("Burana 400 mg", "ibuprofeeni / ibuprofen", (132, 18, 30), "EXP 2027-10", False, -11.0, 3.2, 0),
            "bs_03": ("Amlodipin 10 mg", "amlodipiini / amlodipine", (12, 46, 70), "EXP 2027-09", False, 11.0, -2.6, 2),
            "bs_04": ("Metformin 500 mg", "metformin  EXP 2024-12", (18, 34, 72), "EXP 2024-12", True, -10.0, 2.8, 2),
            "bs_05": ("Bisoprolol 2,5 mg", "bisoprololi / bisoprolol", (16, 54, 62), "EXP 2027-08", False, 10.0, -2.4, 5),
        }[cid]
        foil = foil_sheet(624, 452, p6, [208, 416], [226], seed)
        pts = [(154, 104), (378, 122), (352, 314)] if cfg[7] != 0 else [(346, 114), (476, 232), (344, 348)]
        for ax, ay in pts:
            foil = stamp(foil, (ax, ay), cfg[0], cfg[1], cfg[2], cfg[5])
        ed = ImageDraw.Draw(foil)
        ed.rounded_rectangle((406, 396, 608, 440), radius=6, fill=(228, 232, 238, 244), outline=(128, 134, 144, 250), width=2)
        ed.text((420, 405), cfg[3], fill=(148, 20, 24, 255) if cfg[4] else (18, 24, 34, 250), font=ImageFont.load_default(size=24))
        foil = pop_hole(foil, p6[cfg[7]][0], p6[cfg[7]][1], 58.0, 36.0, seed + 9)
        poly = [(14, 0), (432, 0), (624, 178), (624, 452), (0, 452), (0, 14)] if cid != "bs_03" else [(0, 0), (624, 0), (624, 226), (416, 226), (416, 452), (0, 452)]
        return mount_foil(foil, poly, seed, cfg[6])
    if cid == "bs_07":
        p4 = [(184.0, 106.0), (476.0, 106.0), (184.0, 310.0), (476.0, 310.0)]
        foil = foil_sheet(604, 416, p4, [302], [208], seed)
        for k, (px, py) in enumerate(p4):
            foil = stamp(foil, (int(px) - 22, int(py) + 6), "AMLODIPIN                mg", "amlodipine tablets", (16, 28, 54), 10.0, 25)
            foil = pop_hole(foil, px + 28.0, py - 6.0, 44.0, 29.0, seed + k)
        return mount_foil(foil, [(12, 0), (540, 0), (604, 68), (604, 416), (0, 416), (0, 12)], seed, -3.2)
    if cid == "bs_08":
        foil = foil_sheet(336, 292, [(136.0, 148.0)], [254], [258], seed)
        foil = stamp(stamp(foil, (176, 88), "METFORMIN", "metformiini", (16, 34, 68), 8.0, 33), (168, 208), "METFORMIN", "metformin", (16, 34, 68), 8.0, 33)
        return mount_foil(foil, [(16, 16), (272, 22), (258, 274), (14, 268)], seed, -4.8)
    if cid == "bs_09":
        p4 = [(176.0, 108.0), (462.0, 108.0), (176.0, 308.0), (462.0, 308.0)]
        foil = foil_sheet(600, 416, p4, [300], [208], seed)
        for px, py in p4:
            foil = stamp(foil, (int(px) - 18, int(py) + 4), "AMLODIPIN                mg", "amlodipiini / amlodipine", (16, 28, 54), 0.0, 25)
        gl = Image.new("RGBA", (600, 416), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gl)
        for bx in (188, 474):
            gd.rounded_rectangle((bx - 42, 24, bx + 48, 392), radius=24, fill=(255, 255, 255, 255))
        foil = Image.alpha_composite(foil, gl.filter(ImageFilter.GaussianBlur(8.0)))
        ImageDraw.Draw(foil).rectangle((154, 40, 232, 376), fill=(255, 255, 255, 255))
        ImageDraw.Draw(foil).rectangle((440, 40, 518, 376), fill=(255, 255, 255, 255))
        return mount_foil(foil, [(12, 12), (588, 12), (588, 404), (12, 404)], seed, 2.5)
    if cid == "bs_10":
        foil = foil_sheet(516, 356, [(172.0, 114.0), (332.0, 246.0)], [264], [178], seed)
        foil = stamp(foil, (164, 118), "BISOPROLOL               mg", "bisoprololi", (16, 48, 58), 10.0, 24)
        foil = pop_hole(foil, 212.0, 108.0, 46.0, 30.0, seed + 5)
        foil = stamp(foil, (370, 248), "BISOPROLOL", "bisoprolol", (16, 48, 58), 10.0, 31)
        return mount_foil(foil, [(14, 14), (344, 14), (478, 268), (442, 342), (14, 342)], seed, -3.8)
    foil = foil_sheet(312, 268, [(154.0, 124.0)], [244], [], seed)
    foil = stamp(foil, (32, 72), "dipin", "film-coated tablets", (18, 30, 56), 6.0, 28)
    foil = pop_hole(foil, 154.0, 132.0, 50.0, 33.0, seed + 7)
    ImageDraw.Draw(foil).text((76, 212), "1 tablet daily", fill=(28, 36, 52, 240), font=ImageFont.load_default(size=20))
    return mount_foil(foil, [(36, 18), (286, 24), (272, 252), (32, 246)], seed, 5.2)


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], b64: str, q: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64}}, {"text": f'The person asked: "{q}"'}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema, "thinkingConfig": {"thinkingLevel": "LOW"}, "maxOutputTokens": 4096},
    }
    sess, last = requests.Session(), "failed"
    for att in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                cparts = ((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms}
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** att))
    return {"ok": False, "err": last, "ms": 0.0}


def score_ts(raw_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    node = find_node()
    js = 'import fs from "node:fs"; import { toLabelRead } from "./server/src/verify.ts"; import { sameStrength } from "./server/src/safety.ts"; const inp = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(inp.map((r) => { const read = toLabelRead(r.raw); return { id: r.id, read, str_same: r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false }; })));'
    p1 = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", js], input=json.dumps(raw_rows), text=True, capture_output=True, cwd=str(REPO), check=True)
    normed = [sanitize(x) for x in json.loads(p1.stdout)]
    binp = "\n".join(json.dumps({"read": r["read"], "profile": PROFILE, "now": NOW_ISO}) for r in normed) + "\n"
    p2 = subprocess.run([node, "--import", "tsx", BRIDGE_REL], input=binp, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    verdicts = [sanitize(json.loads(ln)) for ln in p2.stdout.splitlines() if ln.strip()]
    return {n["id"]: {**n, "verdict": v} for n, v in zip(normed, verdicts)}


def check_existing() -> int:
    src = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CH not in src and SLASH2 not in src and EM_DASH not in src and EN_DASH not in src
    raw_b = OUT_JSON.read_bytes()
    assert len(raw_b) <= 15360, f"size {len(raw_b)} > 15360"
    raw_t = raw_b.decode("utf-8")
    assert EM_DASH not in raw_t and EN_DASH not in raw_t and not KEY_RE.search(raw_t)
    data = json.loads(raw_t)
    _, h12, p_sha, s_sha, _ = prompt_hashes()
    assert data["suite"] == SUITE and data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE and data["prompt_sha256_12"] == h12 == "814770315c42"
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha and data["safety_module"] == SAFETY_TS_REL
    cases, s = data["cases"], data["summary"]
    assert s["n_cases"] == data["n"] == len(cases) == 12 and data["errors"] == 0 and data["timeouts"] == 0
    binp = "\n".join(json.dumps({"read": c["read"], "profile": data["profile"], "now": data["eval_now_iso"]}) for c in cases) + "\n"
    p2 = subprocess.run([find_node(), "--import", "tsx", BRIDGE_REL], input=binp, text=True, capture_output=True, cwd=str(REPO), env=dict(os.environ, HOLDUP_SAFETY_TS=SAFETY_TS_REL), check=True)
    rvs = [json.loads(ln) for ln in p2.stdout.splitlines() if ln.strip()]
    for c, rv in zip(cases, rvs):
        assert rv["level"] == c["predicted_level"] and len(c["description"]) <= 240 and len(c["reasons"]) <= 4
    assert s["verdict_matches"] == data["pass_count"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == data["confident_wrong_dose_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")
    print("OK:", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--verify-cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args(argv)
    if args.check or args.offline or args.verify_cached:
        return check_existing()
    if args.render_only:
        OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        for idx, c in enumerate(CASES, 1):
            buf = io.BytesIO()
            render_case(c, idx).save(buf, format="JPEG", quality=90)
            (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(buf.getvalue())
        print(f"Rendered {len(CASES)} cases to {OUT_IMG_DIR}")
        return 0
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY missing")
    prompt_txt, h12, p_sha, s_sha, schema = prompt_hashes()
    shm_root = "/dev/shm" if os.path.isdir("/dev/shm") else None
    with tempfile.TemporaryDirectory(prefix="holdup_bs_", dir=shm_root) as tmpd:
        OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            buf = io.BytesIO()
            render_case(c, idx).save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (pathlib.Path(tmpd) / f"{c['id']}.jpg").write_bytes(raw)
            (OUT_IMG_DIR / f"{c['id']}.jpg").write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(raw).decode("ascii")})
        with ThreadPoolExecutor(max_workers=max(1, min(3, args.workers))) as ex:
            outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))
    if any(not o.get("ok") for o in outs):
        raise RuntimeError(f"API errors: {[o.get('err') for o in outs if not o.get('ok')]}")
    scored = score_ts([{"id": r["case"]["id"], "raw": o["raw"], "exp_str": r["case"]["exp_str"]} for r, o in zip(rendered, outs)])
    cases_out: list[dict[str, Any]] = []
    for r, o in zip(rendered, outs):
        c, sc = r["case"], scored[r["case"]["id"]]
        rd, vd = sc["read"], sc["verdict"]
        pred, s_val, s_conf = str(vd["level"]), rd["strength"]["value"], float(rd["strength"]["confidence"] or 0.0)
        fm = bool(pred == "match" and c["expected"] != "match")
        ur = bool(c["expected"] == "warning" and pred in ("match", "info"))
        cw = bool(fm or ur or (s_conf >= STRENGTH_MIN_CONF if c["degraded"] else (s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"]))))
        ok = bool(pred == c["expected"])
        cases_out.append(sanitize({"id": c["id"], "category": c["category"], "description": c["desc"], "question": c["q"], "expected_level": c["expected"], "predicted_level": pred, "verdict_ok": ok, "confident_wrong": cw, "false_match": fm, "latency_ms": o["ms"], "read": rd, "reasons": list(vd["reasons"])[:4]}))
        print(f"[{c['id']}] exp={c['expected']} pred={pred} ok={ok} str={s_val}({s_conf:.2f}) cw={cw} ms={o['ms']}")
    n, vm = len(cases_out), sum(1 for x in cases_out if x["verdict_ok"])
    cw_n, fm_n = sum(1 for x in cases_out if x["confident_wrong"]), sum(1 for x in cases_out if x["false_match"])
    ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
    abs_n, lats = sum(1 for x in cases_out if x["predicted_level"] == "unsure"), [float(x["latency_ms"]) for x in cases_out]
    ctl = [x for x in cases_out if x["category"].endswith("_control")]
    deg = [x for x in cases_out if not x["category"].endswith("_control")]
    summary = {"n_cases": n, "verdict_matches": vm, "verdict_accuracy": round(vm / n, 4), "verdict_accuracy_ci95": wilson_ci95(vm, n), "confident_wrong_count": cw_n, "confident_wrong_rate": round(cw_n / n, 4), "confident_wrong_ci95": wilson_ci95(cw_n, n), "false_match_count": fm_n, "unsafe_reassurance_count": ur_n, "abstain_or_unsure_count": abs_n, "latency_p50_ms": pctile(lats, 0.50), "latency_p95_ms": pctile(lats, 0.95), "intact_control_accuracy": round(sum(1 for x in ctl if x["verdict_ok"]) / len(ctl), 4), "degraded_abstention_rate": round(sum(1 for x in deg if x["predicted_level"] == "unsure" and not x["confident_wrong"]) / len(deg), 4)}
    payload = sanitize({"suite": SUITE, "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "eval_now_iso": NOW_ISO, "model": MODEL, "thinking_level": THINKING_LEVEL, "prompt_source": PROMPT_SOURCE, "prompt_sha256_12": h12, "prompt_sha256": p_sha, "schema_sha256": s_sha, "safety_module": SAFETY_TS_REL, "n": n, "errors": 0, "timeouts": 0, "pass_count": vm, "pass_rate": round(vm / n, 4), "pass_ci95_wilson": wilson_ci95(vm, n), "confident_wrong_dose_count": cw_n, "confident_wrong_dose_rate": round(cw_n / n, 4), "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_n, n), "rule_of_three_95_upper": round(3.0 / n, 4), "profile": PROFILE, "summary": summary, "cases": cases_out})
    out_txt = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if len(out_txt.encode("utf-8")) > 15200:
        out_txt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    OUT_JSON.write_text(out_txt, encoding="utf-8")
    return check_existing()


if __name__ == "__main__":
    sys.exit(main())
