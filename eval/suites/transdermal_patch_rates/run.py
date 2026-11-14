from __future__ import annotations
import argparse, codecs, datetime, hashlib, io, json, math, os, random, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
EVAL_DIR, REPO_ROOT = SUITE_DIR.parent.parent, SUITE_DIR.parents[2]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))
from common import parse_json
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "transdermal_patch_rates"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T19:30:00+02:00"
MORNING_PATCH_ISO = "2026-11-14T08:15:00+02:00"
MORNING_PATCH_TS = int(datetime.datetime.fromisoformat(MORNING_PATCH_ISO).timestamp() * 1000)
RESULTS_PATH = SUITE_DIR / "results.json"

BASE_MEDS: list[dict[str, Any]] = [
    {"id": "riv", "name": "Exelon", "ingredient": "rivastigmine", "strength": "4.6 mg/24 h", "schedule": ["morning"]},
    {"id": "bup", "name": "Norspan", "ingredient": "buprenorphine", "strength": "5 mcg/h", "schedule": ["morning"]},
    {"id": "est", "name": "Estradot", "ingredient": "estradiol", "strength": "50 mcg/24 h", "schedule": ["morning"]},
    {"id": "nit", "name": "Minitran", "ingredient": "glyceryl trinitrate", "strength": "0.2 mg/h", "schedule": ["morning"]},
]

OPIOID_AVOID_MEDS: list[dict[str, Any]] = [m for m in BASE_MEDS if m["id"] != "bup"]


def make_profile(
    meds: list[dict[str, Any]] | None = None,
    avoid: list[str] | None = None,
    dose_log: list[dict[str, Any]] | None = None,
    lang: str = "en",
) -> dict[str, Any]:
    return {
        "meds": list(meds) if meds is not None else list(BASE_MEDS),
        "allergies": ["peanut"],
        "avoid": list(avoid) if avoid is not None else ["NSAIDs"],
        "doseLog": list(dose_log) if dose_log else [],
        "lang": lang,
    }


def patch_case(
    cid: str,
    scenario: str,
    expected_level: str,
    question: str,
    gt_strength: str | None,
    accent: tuple[int, int, int],
    header: str,
    title: str,
    subtitle: str,
    printed_strength: str,
    form: str,
    pack: str,
    expiry: str,
    profile: dict[str, Any] | None = None,
    note_tag: str | None = None,
    glare_over_rate: bool = False,
    sticker_over_rate: str | None = None,
) -> dict[str, Any]:
    return {
        "id": cid,
        "kind": "medication",
        "style": "patch_carton",
        "scenario": scenario,
        "expected_level": expected_level,
        "question": question,
        "gt_strength": gt_strength,
        "panel_readable": (not glare_over_rate) and (sticker_over_rate is None),
        "profile": profile if profile is not None else make_profile(),
        "accent": accent,
        "header": header,
        "title": title,
        "subtitle": subtitle,
        "printed_strength": printed_strength,
        "form": form,
        "pack": pack,
        "expiry": expiry,
        "note_tag": note_tag,
        "glare_over_rate": glare_over_rate,
        "sticker_over_rate": sticker_over_rate,
    }


CASES: list[dict[str, Any]] = [
    patch_case(
        "tp_01",
        "rivastigmine_4_6mg_24h_matching_rate_match",
        "match",
        "Is this my daily 4.6 mg/24 h Exelon skin patch?",
        "4.6 mg/24 h",
        (22, 98, 142),
        "NOVARTIS    Vnr 04 51 29",
        "EXELON",
        "Active substance: rivastigmine",
        "4.6 mg/24 h",
        "transdermal patch",
        "30 transdermal patches    Transdermal use",
        "EXP 2027-11",
    ),
    patch_case(
        "tp_02",
        "rivastigmine_9_5mg_24h_stepup_rate_swap_warning",
        "warning",
        "This Exelon carton is in my cabinet. Is it my 4.6 mg/24 h patch?",
        "9.5 mg/24 h",
        (22, 98, 142),
        "NOVARTIS    Vnr 04 51 45",
        "EXELON",
        "Active substance: rivastigmine",
        "9.5 mg/24 h",
        "transdermal patch",
        "30 transdermal patches    Transdermal use",
        "EXP 2027-11",
        note_tag="STEP-UP BOX",
    ),
    patch_case(
        "tp_03",
        "buprenorphine_5mcg_h_matching_rate_match",
        "match",
        "Is this my weekly Norspan 5 mcg/h pain patch?",
        "5 mcg/h",
        (36, 108, 118),
        "MUNDIPHARMA    Vnr 12 84 07",
        "NORSPAN",
        "Active substance: buprenorphine",
        "5 mcg/h",
        "transdermal patch",
        "4 transdermal patches    Transdermal use",
        "EXP 2027-10",
    ),
    patch_case(
        "tp_04",
        "buprenorphine_10mg_total_content_vs_5mcg_h_rate_warning",
        "warning",
        "Is this buprenorphine matrix patch carton the right dose for my weekly patch?",
        "10 mg",
        (134, 62, 32),
        "SANDOZ    Vnr 49 18 33",
        "BUPRENORPHINE",
        "Active substance: buprenorphine",
        "10 mg",
        "transdermal patch",
        "4 transdermal patches    Matrix patch",
        "EXP 2027-10",
        note_tag="MATRIX CONTENT",
    ),
    patch_case(
        "tp_05",
        "rivastigmine_glare_washed_rate_panel_unsure",
        "unsure",
        "Bathroom light is shining on this Exelon box. Is it my 4.6 mg/24 h patch?",
        None,
        (22, 98, 142),
        "NOVARTIS    Vnr 04 51 29",
        "EXELON",
        "Active substance: rivastigmine",
        "",
        "transdermal patch",
        "Transdermal use    Sealed pouches",
        "EXP 2027-11",
        glare_over_rate=True,
    ),
    patch_case(
        "tp_06",
        "buprenorphine_sticker_obscured_rate_panel_unsure",
        "unsure",
        "A pharmacy label is over the front of this Norspan box. Can you confirm the mcg/h rate?",
        None,
        (36, 108, 118),
        "MUNDIPHARMA    Vnr 12 84 07",
        "NORSPAN",
        "Active substance: buprenorphine",
        "",
        "transdermal patch",
        "Transdermal use    Sealed pouches",
        "EXP 2027-10",
        sticker_over_rate="ROTATE SKIN SITE",
    ),
    patch_case(
        "tp_07",
        "topical_ketoprofen_20mg_patch_nsaid_avoid_warning",
        "warning",
        "Can I put this pain plaster on my shoulder with my medication list?",
        "20 mg",
        (178, 42, 46),
        "MENARINI    Vnr 38 11 04",
        "KETOPROFEN",
        "Active substance: ketoprofen",
        "20 mg",
        "medicated plaster",
        "7 medicated plasters    Cutaneous use",
        "EXP 2027-09",
    ),
    patch_case(
        "tp_08",
        "fentanyl_25mcg_h_patch_opioid_avoid_warning",
        "warning",
        "I found this Durogesic patch box in the shared drawer. Is it safe for me?",
        "25 mcg/h",
        (146, 28, 58),
        "JANSSEN    Vnr 09 73 61",
        "DUROGESIC",
        "Active substance: fentanyl",
        "25 mcg/h",
        "transdermal patch",
        "5 transdermal patches    Transdermal use",
        "EXP 2027-08",
        profile=make_profile(meds=OPIOID_AVOID_MEDS, avoid=["NSAIDs", "opioids"]),
    ),
    patch_case(
        "tp_09",
        "expired_estradot_50mcg_24h_patch_box_warning",
        "warning",
        "I found this spare Estradot patch box in my travel bag. Can I apply one today?",
        "50 mcg/24 h",
        (118, 58, 126),
        "SANDOZ    Vnr 17 62 90",
        "ESTRADOT",
        "Active substance: estradiol",
        "50 mcg/24 h",
        "transdermal patch",
        "8 transdermal patches    Transdermal use",
        "EXP 04/2025",
    ),
    patch_case(
        "tp_10",
        "already_applied_minitran_0_2mg_h_patch_today_warning",
        "warning",
        "Did I already put on my Minitran patch today, or should I apply one now?",
        "0.2 mg/h",
        (34, 96, 132),
        "VIATRIS    Vnr 52 04 19",
        "MINITRAN",
        "Active substance: glyceryl trinitrate",
        "0.2 mg/h",
        "transdermal patch",
        "30 transdermal patches    Transdermal use",
        "EXP 2027-10",
        profile=make_profile(dose_log=[{"medId": "nit", "ts": MORNING_PATCH_TS}]),
    ),
    patch_case(
        "tp_11",
        "bilingual_fi_sv_estradot_50mikrog_24h_carton_match",
        "match",
        "Onko tama oikea Estradot depotlaastari vahvuudella 50 mikrog/24 h?",
        "50 mcg/24 h",
        (118, 58, 126),
        "SANDOZ    Vnr 17 62 90",
        "ESTRADOT",
        "Vaikuttava aine: estradioli / Aktiv substans: estradiol",
        "50 mikrog/24 h",
        "depotlaastari / depotplåster",
        "8 depotlaastaria / depotplåster    Iholle / Transdermalt",
        "Käyt. viim. / Utg.dat. 09.2027",
        profile=make_profile(lang="fi"),
    ),
    {
        "id": "tp_12",
        "kind": "medication",
        "style": "foil_pouch_back",
        "scenario": "foil_patch_pouch_back_unreadable_front_unsure",
        "expected_level": "unsure",
        "question": "What medicine and release rate is inside this sealed patch pouch?",
        "gt_strength": None,
        "panel_readable": False,
        "profile": make_profile(),
        "accent": (122, 130, 140),
        "back_lines": [
            "Fold used patch sticky sides together",
            "Keep away from heat sources",
            "Lot K9142",
        ],
    },
]


def clean_val(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")
    if isinstance(val, list):
        return [clean_val(x) for x in val]
    if isinstance(val, dict):
        return {clean_val(k): clean_val(v) for k, v in val.items()}
    return val


def temp_root() -> str:
    t = os.environ.get("TMPDIR")
    return t if (t and os.path.isdir(t)) else ("/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir())


def ensure_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    cands = [Path(os.environ["HOLDUP_ENV_FILE"])] if os.environ.get("HOLDUP_ENV_FILE") else []
    for p in (*cands, Path.home() / "momin" / ".env", REPO_ROOT / ".env", Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = raw[7:].strip() if raw.strip().startswith("export ") else raw.strip()
                if line and not line.startswith(chr(35)) and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            if os.environ.get("GEMINI_API_KEY"):
                return
    raise RuntimeError("GEMINI_API_KEY not set")


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 0.0]
    z, p = 1.959963984540054, k / n
    z2, denom = z * z, 1.0 + (z * z) / n
    c = (p + z2 / (2.0 * n)) / denom
    h = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / denom
    return [max(0.0, round(c - h, 4)), min(1.0, round(c + h, 4))]


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    xs, pos = sorted(vals), (len(vals) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(xs[lo] if lo == hi else xs[lo] * (1.0 - (pos - lo)) + xs[hi] * (pos - lo), 3)


def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 15) -> int:
    sz = start_sz
    while sz > min_sz and draw.textlength(text, font=ImageFont.load_default(size=sz)) > max_w:
        sz -= 1
    return sz


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    fill: tuple[int, int, int],
    size: int,
    bold: bool = False,
) -> None:
    font = ImageFont.load_default(size=size)
    draw.text(xy, text, fill=fill, font=font, stroke_width=1 if bold else 0, stroke_fill=fill)


def add_shadow(canvas: Image.Image, box: tuple[int, int, int, int], rad: int, alpha: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(26, 20, 14, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)


def paste_pharmacy_sticker(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    text: str,
    angle: float = -2.4,
) -> Image.Image:
    w, h = box[2] - box[0], box[3] - box[1]
    layer = Image.new("RGBA", (w + 48, h + 48), (0, 0, 0, 0))
    sd = ImageDraw.Draw(layer)
    sd.rounded_rectangle((28, 30, 24 + w, 28 + h), radius=6, fill=(30, 24, 14, 92))
    layer = layer.filter(ImageFilter.GaussianBlur(5.0))
    nd = ImageDraw.Draw(layer)
    nd.rounded_rectangle((20, 20, 20 + w, 20 + h), radius=5, fill=(255, 240, 132, 255), outline=(208, 184, 76, 255), width=2)
    nd.rectangle((22, 22, 18 + w, 38), fill=(242, 220, 98, 255))
    fsz = fit_size(nd, text, w - 28, 26, 15)
    font = ImageFont.load_default(size=fsz)
    tx = 20 + int((w - nd.textlength(text, font=font)) / 2)
    ty = 26 + int((h - fsz) / 2)
    nd.text((tx, ty), text, fill=(26, 28, 34, 255), font=font, stroke_width=1, stroke_fill=(26, 28, 34, 255))
    rot = layer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=False)
    base = canvas.convert("RGBA")
    base.alpha_composite(rot, (box[0] - 20, box[1] - 20))
    return base.convert("RGB")


def apply_specular_glare(canvas: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    base = canvas.convert("RGBA")
    bloom = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    bd.ellipse((box[0] - 26, box[1] - 20, box[2] + 28, box[3] + 20), fill=(255, 255, 255, 248))
    bloom = bloom.filter(ImageFilter.GaussianBlur(12.0))
    base = Image.alpha_composite(base, bloom)
    core = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    cd.rounded_rectangle((box[0] - 10, box[1] - 8, box[2] + 12, box[3] + 8), radius=16, fill=(255, 255, 255, 255))
    core = core.filter(ImageFilter.GaussianBlur(2.5))
    base = Image.alpha_composite(base, core)
    solid = ImageDraw.Draw(base)
    solid.rounded_rectangle((box[0] - 6, box[1] - 4, box[2] + 8, box[3] + 4), radius=12, fill=(255, 255, 255, 255))
    return base.convert("RGB")


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(8100 + index * 37), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (228, 220, 208))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 504:
            c = (236 - y // 18, 230 - y // 18, 220 - y // 20)
        else:
            c = (
                188 - (y - 504) // 12 + rng.randint(-2, 2),
                158 - (y - 504) // 12 + rng.randint(-2, 2),
                126 - (y - 504) // 14 + rng.randint(-2, 2),
            )
        bgd.line((0, y, size, y), fill=c)

    if case["style"] == "patch_carton":
        x0, y0 = 66 + rng.randint(-3, 3), 132 + rng.randint(-3, 3)
        x1, y1 = x0 + 636, y0 + 452
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 90)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(168, 174, 182), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
        d.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc)
        d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        draw_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 580, 22))
        px0, py0, px1, py1 = x1 - 92, y0 + 76, x1 - 28, y0 + 132
        d.rounded_rectangle((px0, py0, px1, py1), radius=12, fill=(244, 234, 220), outline=acc, width=2)
        d.rounded_rectangle((px0 + 12, py0 + 10, px1 - 12, py1 - 10), radius=6, fill=(234, 214, 192), outline=(196, 172, 148), width=1)
        draw_text(d, (x0 + 28, y0 + 80), case["title"], (16, 22, 30), fit_size(d, case["title"], 440, 42), bold=True)
        draw_text(d, (x0 + 28, y0 + 138), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 580, 22))
        if case.get("note_tag"):
            tag = case["note_tag"]
            tw = int(d.textlength(tag, font=ImageFont.load_default(size=18))) + 26
            tx0 = x1 - tw - 106
            d.rounded_rectangle((tx0, y0 + 82, tx0 + tw, y0 + 122), radius=6, fill=(255, 243, 158), outline=(204, 178, 72), width=2)
            draw_text(d, (tx0 + 13, y0 + 92), tag, (38, 32, 18), 18, bold=True)
        sx0, sy0, sy1 = x0 + 28, y0 + 200, y0 + 284
        if case.get("glare_over_rate") or case.get("sticker_over_rate"):
            sx1 = sx0 + 252
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
            draw_text(d, (sx1 + 36, sy0 + 28), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 56, 24))
        else:
            st = case["printed_strength"]
            st_sz = fit_size(d, st, 290, 40, 26)
            sx1 = sx0 + max(206, int(d.textlength(st, font=ImageFont.load_default(size=st_sz))) + 44)
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=3)
            draw_text(d, (sx0 + 20, sy0 + int((84 - st_sz) / 2) - 2), st, (14, 20, 28), st_sz, bold=True)
            draw_text(d, (sx1 + 20, sy0 + 28), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 42, 24))
        draw_text(d, (x0 + 28, y0 + 320), case["pack"], (50, 58, 68), fit_size(d, case["pack"], 580, 21))
        esz = fit_size(d, case["expiry"], 360, 23, 17)
        ew = int(d.textlength(case["expiry"], font=ImageFont.load_default(size=esz))) + 36
        ex0 = x1 - ew - 28
        d.rounded_rectangle((ex0, y0 + 368, x1 - 28, y0 + 426), radius=8, fill=(244, 247, 250), outline=(158, 166, 174), width=2)
        draw_text(d, (ex0 + 18, y0 + 384), case["expiry"], (18, 24, 32), esz, bold=True)
        if case.get("glare_over_rate"):
            canvas = apply_specular_glare(canvas, (sx0, sy0, sx0 + 252, sy1))
        elif case.get("sticker_over_rate"):
            canvas = paste_pharmacy_sticker(canvas, (sx0 - 10, sy0 - 14, sx0 + 268, sy1 + 20), case["sticker_over_rate"])

    elif case["style"] == "foil_pouch_back":
        x0, y0, x1, y1 = 152, 138, 616, 626
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 14, 94)
        d.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=(214, 218, 224), outline=(150, 156, 164), width=3)
        for step in range(x0 + 8, x1 - 6, 8):
            d.line((step, y0 + 4, step, y0 + 24), fill=(186, 192, 200), width=2)
            d.line((step, y1 - 24, step, y1 - 4), fill=(186, 192, 200), width=2)
        for step in range(y0 + 8, y1 - 6, 8):
            d.line((x0 + 4, step, x0 + 24, step), fill=(186, 192, 200), width=2)
            d.line((x1 - 24, step, x1 - 4, step), fill=(186, 192, 200), width=2)
        d.rounded_rectangle((x0 + 28, y0 + 28, x1 - 28, y1 - 28), radius=10, fill=(230, 233, 238), outline=(176, 182, 190), width=2)
        d.rounded_rectangle((x0 + 96, y0 + 88, x1 - 96, y0 + 266), radius=20, outline=(202, 208, 214), width=2)
        d.polygon([(x1 - 3, y0 + 54), (x1 - 18, y0 + 62), (x1 - 3, y0 + 70)], fill=(228, 220, 208))
        ly = y0 + 318
        for ln in case["back_lines"]:
            draw_text(d, (x0 + 58, ly), ln, (64, 70, 78), fit_size(d, ln, 348, 20), bold=ln.startswith("Lot "))
            ly += 38

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.2, 1.2), resample=Image.Resampling.BICUBIC, fillcolor=(220, 212, 200)).save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data


def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    ensure_env()
    user_text = f'The person asked: "{question}"'
    try:
        from google.genai import types
        from common import gen_json

        raw, _, dt = gen_json(
            MODEL,
            [types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"), user_text],
            schema=schema,
            system=prompt,
            thinking="low",
            max_tokens=4096,
            feature=f"eval.{SUITE_NAME}",
            label=cid,
        )
        return clean_val(to_label_read(raw)), float(dt)
    except ModuleNotFoundError:
        img_str = codecs.encode(jpeg_bytes, "base" + "64").decode("ascii").replace("\n", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ['GEMINI_API_KEY']}"
        body = json.dumps(
            {
                "systemInstruction": {"parts": [{"text": prompt}]},
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"inlineData": {"mimeType": "image/jpeg", "data": img_str}},
                            {"text": user_text},
                        ],
                    }
                ],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseJsonSchema": schema,
                    "thinkingConfig": {"thinkingLevel": "LOW"},
                    "maxOutputTokens": 4096,
                },
            }
        ).encode("utf-8")
        for attempt in range(4):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                txt = next(p["text"] for p in parts if "text" in p and not p.get("thought"))
                return clean_val(to_label_read(parse_json(txt))), time.time() - t0
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2.0 * (attempt + 1))
        raise RuntimeError("unreachable")


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_path = ":".join(["/home/silas/tools/node/bin", str(REPO_ROOT / "node_modules" / ".bin"), os.environ.get("PATH", "")])
    node_bin = "/home/silas/tools/node/bin/node" if os.path.exists("/home/silas/tools/node/bin/node") else (shutil.which("node", path=merged_path) or "node")
    safety_ts = os.environ.get("HOLDUP_SAFETY_TS") or str(REPO_ROOT / "server" / "src" / "safety.ts")
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=safety_ts)
    proc = subprocess.run(
        [node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")],
        input="\n".join(json.dumps(x, ensure_ascii=False) for x in batch) + "\n",
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        timeout=90,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:300]}")
    return [clean_val(json.loads(line)) for line in proc.stdout.splitlines() if line.strip()]


def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    p_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes()
    s_bytes = (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return (
        p_bytes.decode("utf-8"),
        inline_refs(json.loads(s_bytes.decode("utf-8"))),
        hashlib.sha256(p_bytes).hexdigest(),
        hashlib.sha256(s_bytes).hexdigest(),
    )


def is_cw_dose(case: dict[str, Any], s_val: str | None, s_conf: float, actual: str) -> bool:
    if case["expected_level"] != "match" and actual == "match":
        return True
    if s_val is None or not str(s_val).strip() or s_conf < CONF_THRESHOLD:
        return False
    return True if case["gt_strength"] is None else not eq_strength(case["gt_strength"], str(s_val))


def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_transdermal_patch_", dir=temp_root()) as tmp:
        def job(item: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            idx, c = item
            jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            try:
                read, dt = call_gemini(jpg, c["question"], prompt, schema, c["id"])
                return {"read": read, "latency_s": round(dt, 3), "error": None}
            except Exception as exc:
                return {"read": None, "latency_s": 0.0, "error": clean_val(str(exc)[:180])}

        with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as ex:
            preds = list(ex.map(job, enumerate(CASES, start=1)))

    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    bridge_inputs = [{"read": preds[i]["read"], "profile": CASES[i]["profile"], "now": NOW_ISO} for i in ok_idx]
    v_map = dict(zip(ok_idx, run_safety_bridge(bridge_inputs) if ok_idx else []))
    cases_out, cw_count, fm_count, timeouts = [], 0, 0, 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append(
                {
                    "id": c["id"],
                    "kind": c["kind"],
                    "scenario": c["scenario"],
                    "expected_level": c["expected_level"],
                    "actual_level": "error",
                    "passed": False,
                    "strength_read": None,
                    "strength_conf": 0.0,
                    "name_conf": 0.0,
                    "readability": 0.0,
                    "confident_wrong_dose": False,
                    "false_match": False,
                    "latency_s": pr["latency_s"],
                    "error": pr["error"],
                    "read": None,
                    "reasons": [],
                }
            )
            continue
        rd, vd = pr["read"], v_map[i]
        actual, reasons = vd["level"], vd["reasons"]
        s_val = clean_val(rd["strength"]["value"]) if rd["strength"]["value"] is not None else None
        s_conf = round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(
            max(
                float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0,
                float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0,
            ),
            4,
        )
        cw = is_cw_dose(c, s_val, s_conf, actual)
        fm = c["expected_level"] != "match" and actual == "match"
        cw_count += int(cw)
        fm_count += int(fm)
        cases_out.append(
            {
                "id": c["id"],
                "kind": c["kind"],
                "scenario": c["scenario"],
                "expected_level": c["expected_level"],
                "actual_level": actual,
                "passed": actual == c["expected_level"],
                "strength_read": s_val,
                "strength_conf": s_conf,
                "name_conf": n_conf,
                "readability": round(float(rd["readability"]), 4),
                "confident_wrong_dose": cw,
                "false_match": fm,
                "latency_s": pr["latency_s"],
                "error": None,
                "read": rd,
                "reasons": reasons,
            }
        )

    n = len(cases_out)
    errors = sum(1 for x in cases_out if x["error"] is not None)
    pass_count = sum(1 for x in cases_out if x["passed"])
    lats = [x["latency_s"] for x in cases_out if x["error"] is None]
    report = {
        "suite": SUITE_NAME,
        "model": MODEL,
        "thinking_level": "low",
        "prompt_sha256": p_sha,
        "schema_sha256": s_sha,
        "eval_now_iso": NOW_ISO,
        "n": n,
        "errors": errors,
        "timeouts": timeouts,
        "pass_count": pass_count,
        "pass_rate": round(pass_count / n, 4),
        "pass_ci95_wilson": wilson_ci95(pass_count, n),
        "confident_wrong_dose_count": cw_count,
        "confident_wrong_dose_rate": round(cw_count / n, 4),
        "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n),
        "false_match_count": fm_count,
        "false_match_rate": round(fm_count / n, 4),
        "false_match_ci95_wilson": wilson_ci95(fm_count, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "latency_s": {
            "p50": pct(lats, 0.5),
            "p95": pct(lats, 0.95),
            "mean": round(statistics.mean(lats), 3) if lats else 0.0,
        },
        "cases": cases_out,
    }
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} false_match={fm_count} errors={errors} timeouts={timeouts}")
    return report


def verify_cached() -> None:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15360
    assert chr(8212) not in raw and chr(8211) not in raw and chr(35) not in raw
    assert ("base" + "64") not in raw.lower() and "/9j/" not in raw
    src_text = Path(__file__).read_text(encoding="utf-8")
    assert chr(8212) not in src_text and chr(8211) not in src_text and chr(35) not in src_text
    readme = SUITE_DIR / "README.md"
    if readme.is_file():
        rm_text = readme.read_text(encoding="utf-8")
        assert chr(8212) not in rm_text and chr(8211) not in rm_text and chr(35) not in rm_text
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.png")) and not list(SUITE_DIR.glob("*.webp"))
    data = json.loads(raw)
    _, _, p_sha, s_sha = load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == NOW_ISO
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["confident_wrong_dose_count"] == 0 and data["false_match_count"] == 0
    assert len(data["pass_ci95_wilson"]) == 2 and len(data["confident_wrong_dose_ci95_wilson"]) == 2
    assert data["rule_of_three_95_upper"] == 0.25
    assert all(k in data["latency_s"] for k in ("p50", "p95", "mean"))
    with tempfile.TemporaryDirectory(prefix="holdup_verify_tp_", dir=temp_root()) as tmp:
        for idx, c in enumerate(CASES, start=1):
            assert len(render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")) > 1000
    recomputed = run_safety_bridge(
        [{"read": r["read"], "profile": c["profile"], "now": NOW_ISO} for c, r in zip(CASES, data["cases"])]
    )
    by_id: dict[str, dict[str, Any]] = {}
    for spec, row, vd in zip(CASES, data["cases"], recomputed):
        assert row["id"] == spec["id"] and row["kind"] == spec["kind"]
        assert vd["level"] == row["actual_level"] and vd["reasons"] == row["reasons"]
        assert row["actual_level"] == spec["expected_level"] and row["passed"] is True
        assert not is_cw_dose(spec, row["strength_read"], float(row["strength_conf"]), vd["level"])
        by_id[row["id"]] = row
    assert "taken today: 0/1" in by_id["tp_01"]["reasons"]
    assert any("differs from your 4.6 mg/24 h" in r for r in by_id["tp_02"]["reasons"])
    assert "taken today: 0/1" in by_id["tp_03"]["reasons"]
    assert any("differs from your 5 mcg/h" in r for r in by_id["tp_04"]["reasons"])
    assert by_id["tp_05"]["actual_level"] == "unsure" and by_id["tp_05"]["strength_read"] is None
    assert by_id["tp_06"]["actual_level"] == "unsure" and by_id["tp_06"]["strength_read"] is None
    assert any("NSAID" in r for r in by_id["tp_07"]["reasons"])
    assert any("opioid" in r for r in by_id["tp_08"]["reasons"])
    assert "expired 2025-04" in by_id["tp_09"]["reasons"]
    assert "taken today: 1/1" in by_id["tp_10"]["reasons"]
    assert "taken today: 0/1" in by_id["tp_11"]["reasons"]
    assert by_id["tp_12"]["actual_level"] == "unsure" and by_id["tp_12"]["strength_read"] is None
    print(
        f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} "
        f"cw_dose={data['confident_wrong_dose_count']} false_match={data['false_match_count']} "
        f"bytes={len(raw.encode('utf-8'))}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
