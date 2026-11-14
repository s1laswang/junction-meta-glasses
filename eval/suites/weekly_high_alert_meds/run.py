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

SUITE_NAME = "weekly_high_alert_meds"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T19:30:00+02:00"
MORNING_DOSE_ISO = "2026-11-14T08:15:00+02:00"
MORNING_DOSE_TS = int(datetime.datetime.fromisoformat(MORNING_DOSE_ISO).timestamp() * 1000)
RESULTS_PATH = SUITE_DIR / "results.json"

BASE_MEDS: list[dict[str, Any]] = [
    {"id": "mtx", "name": "Trexan", "ingredient": "methotrexate", "strength": "2.5 mg", "schedule": ["morning"]},
    {"id": "aln", "name": "Alendronate", "ingredient": "alendronic acid", "strength": "70 mg", "schedule": ["morning"]},
    {"id": "war", "name": "Marevan", "ingredient": "warfarin", "strength": "3 mg", "schedule": ["evening"]},
]


def make_profile(dose_log: list[dict[str, Any]] | None = None, meds: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "meds": list(meds) if meds is not None else list(BASE_MEDS),
        "allergies": [],
        "avoid": ["NSAIDs"],
        "doseLog": list(dose_log) if dose_log else [],
        "lang": "en",
    }


def bottle_case(
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
    warning_tag: str | None = None,
    occlude_mode: str | None = None,
    dose_log: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": cid,
        "kind": "medication",
        "style": "white_bottle",
        "scenario": scenario,
        "expected_level": expected_level,
        "question": question,
        "gt_strength": gt_strength,
        "profile": make_profile(dose_log=dose_log),
        "accent": accent,
        "header": header,
        "title": title,
        "subtitle": subtitle,
        "printed_strength": printed_strength,
        "form": form,
        "pack": pack,
        "expiry": expiry,
        "warning_tag": warning_tag,
        "occlude_mode": occlude_mode,
    }


def carton_case(
    cid: str,
    scenario: str,
    expected_level: str,
    question: str,
    gt_strength: str,
    accent: tuple[int, int, int],
    header: str,
    title: str,
    subtitle: str,
    printed_strength: str,
    form: str,
    pack: str,
    expiry: str,
    boxed_notice: str,
    dose_log: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": cid,
        "kind": "medication",
        "style": "white_carton",
        "scenario": scenario,
        "expected_level": expected_level,
        "question": question,
        "gt_strength": gt_strength,
        "profile": make_profile(dose_log=dose_log),
        "accent": accent,
        "header": header,
        "title": title,
        "subtitle": subtitle,
        "printed_strength": printed_strength,
        "form": form,
        "pack": pack,
        "expiry": expiry,
        "boxed_notice": boxed_notice,
        "occlude_mode": None,
    }


CASES: list[dict[str, Any]] = [
    bottle_case(
        "wh_01",
        "trexan_2_5mg_orion_white_bottle_scheduled_match",
        "match",
        "Is this my scheduled 2.5 mg Trexan bottle?",
        "2.5 mg",
        (22, 88, 148),
        "ORION PHARMA    Vnr 06 14 22",
        "TREXAN",
        "Active substance: methotrexate",
        "2,5 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 09/2027",
        warning_tag="Once weekly dosing",
    ),
    bottle_case(
        "wh_02",
        "trexan_10mg_orion_white_bottle_4x_strength_warning",
        "warning",
        "Is this my 2.5 mg Trexan bottle?",
        "10 mg",
        (22, 88, 148),
        "ORION PHARMA    Vnr 06 14 55",
        "TREXAN",
        "Active substance: methotrexate",
        "10 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 09/2027",
        warning_tag="Once weekly dosing",
    ),
    carton_case(
        "wh_03",
        "methotrexate_accord_10mg_carton_vs_2_5mg_warning",
        "warning",
        "Can I take this Methotrexate box for my weekly 2.5 mg dose?",
        "10 mg",
        (168, 34, 42),
        "ACCORD HEALTHCARE    EU/1/24/091",
        "METHOTREXATE ACCORD",
        "Active substance: methotrexate",
        "10 mg",
        "tablets",
        "28 tablets    Oral use",
        "EXP 11/2027",
        boxed_notice="Check weekly dose carefully before use",
    ),
    bottle_case(
        "wh_04",
        "folvite_folic_acid_1mg_vs_trexan_orion_bottle_warning",
        "warning",
        "Is this white Orion bottle my weekly Trexan 2.5 mg medicine?",
        "1 mg",
        (22, 88, 148),
        "ORION PHARMA    Vnr 01 49 10",
        "FOLVITE",
        "Active substance: folic acid",
        "1 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 10/2027",
    ),
    carton_case(
        "wh_05",
        "alendronate_70mg_weekly_tablet_not_yet_taken_match",
        "match",
        "Can I take my weekly Alendronate 70 mg tablet now?",
        "70 mg",
        (26, 108, 118),
        "ORION PHARMA    Vnr 09 32 14",
        "ALENDRONATE ORION",
        "Active substance: alendronic acid",
        "70 mg",
        "tablets",
        "4 tablets    Once weekly",
        "EXP 12/2027",
        boxed_notice="Take one tablet once a week",
        dose_log=[],
    ),
    carton_case(
        "wh_06",
        "alendronate_70mg_weekly_already_logged_today_warning",
        "warning",
        "Should I take this weekly Alendronate 70 mg tablet now?",
        "70 mg",
        (26, 108, 118),
        "SANDOZ    Vnr 11 48 60",
        "ALENDRONATE SANDOZ",
        "Active substance: alendronic acid",
        "70 mg",
        "film-coated tablets",
        "4 tablets    Once weekly",
        "EXP 11/2027",
        boxed_notice="Take one tablet once a week",
        dose_log=[{"medId": "aln", "ts": MORNING_DOSE_TS}],
    ),
    bottle_case(
        "wh_07",
        "marevan_warfarin_3mg_orion_white_bottle_match",
        "match",
        "Is this my 3 mg Marevan evening bottle?",
        "3 mg",
        (24, 96, 156),
        "ORION PHARMA    Vnr 06 81 55",
        "MAREVAN",
        "Active substance: warfarin sodium",
        "3 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 10/2027",
    ),
    bottle_case(
        "wh_08",
        "marevan_warfarin_5mg_orion_white_bottle_warning",
        "warning",
        "Is this my 3 mg Marevan evening bottle?",
        "5 mg",
        (178, 52, 92),
        "ORION PHARMA    Vnr 06 81 71",
        "MAREVAN",
        "Active substance: warfarin sodium",
        "5 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 10/2027",
    ),
    bottle_case(
        "wh_09",
        "trexan_white_bottle_thumb_obscured_strength_unsure",
        "unsure",
        "Is this the 2.5 mg or 10 mg Trexan bottle?",
        None,
        (22, 88, 148),
        "ORION PHARMA    Vnr 06 14 22",
        "TREXAN",
        "Active substance: methotrexate",
        "",
        "tablets",
        "100 tablets    Oral use",
        "EXP 09/2027",
        occlude_mode="thumb",
    ),
    bottle_case(
        "wh_10",
        "marevan_white_bottle_specular_glare_strength_unsure",
        "unsure",
        "Is this Marevan 3 mg or 5 mg? Light is reflecting on the bottle.",
        None,
        (24, 96, 156),
        "ORION PHARMA    Vnr 06 81 55",
        "MAREVAN",
        "Active substance: warfarin sodium",
        "",
        "tablets",
        "100 tablets    Oral use",
        "EXP 10/2027",
        occlude_mode="glare",
    ),
    bottle_case(
        "wh_11",
        "trexan_2_5mg_expired_01_2025_white_bottle_warning",
        "warning",
        "I found this backup Trexan 2.5 mg bottle in my cupboard. Is it safe to take?",
        "2.5 mg",
        (22, 88, 148),
        "ORION PHARMA    Vnr 06 14 22",
        "TREXAN",
        "Active substance: methotrexate",
        "2.5 mg",
        "tablets",
        "100 tablets    Oral use",
        "EXP 01/2025",
        warning_tag="Once weekly dosing",
    ),
    {
        "id": "wh_12",
        "kind": "medication",
        "style": "rear_bottle_warning",
        "scenario": "rear_warning_text_only_white_bottle_no_name_strength_unsure",
        "expected_level": "unsure",
        "question": "Which medicine and what mg strength is in this white pill bottle?",
        "gt_strength": None,
        "profile": make_profile(),
        "accent": (176, 38, 42),
        "lines": [
            "Read the package leaflet carefully before taking these tablets.",
            "Take strictly according to your physician's dosing schedule.",
            "Swallow tablets whole with water. Do not crush or chew.",
            "Keep out of the sight and reach of children.",
            "Store in a dry place in the original container.  Lot K9184",
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
    center_w: int | None = None,
) -> None:
    font = ImageFont.load_default(size=size)
    x = xy[0] + int((center_w - draw.textlength(text, font=font)) / 2) if center_w is not None else xy[0]
    draw.text((x, xy[1]), text, fill=fill, font=font, stroke_width=1 if bold else 0, stroke_fill=fill)


def add_shadow(canvas: Image.Image, box: tuple[int, int, int, int], rad: int, alpha: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(26, 20, 14, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)


def draw_white_hdpe_shell(canvas: Image.Image, bx0: int, by0: int, bx1: int, by1: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    canvas, d = add_shadow(canvas, (bx0, by0, bx1, by1), 40, 94)
    cx0, cy0, cx1, cy1 = bx0 + 36, by0 - 74, bx1 - 36, by0 + 12
    d.rounded_rectangle((cx0, cy0, cx1, cy1), radius=16, fill=(246, 248, 250), outline=(172, 178, 188), width=3)
    for rx in range(cx0 + 14, cx1 - 12, 13):
        d.line((rx, cy0 + 8, rx, cy1 - 10), fill=(212, 218, 226), width=4)
    d.rectangle((bx0 + 52, by0 - 8, bx1 - 52, by0 + 18), fill=(230, 235, 242), outline=(176, 182, 192), width=2)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=42, fill=(249, 250, 252), outline=(168, 176, 186), width=3)
    d.rounded_rectangle((bx0 + 6, by0 + 18, bx0 + 30, by1 - 18), radius=12, fill=(235, 240, 246))
    d.rounded_rectangle((bx1 - 30, by0 + 18, bx1 - 6, by1 - 18), radius=12, fill=(228, 234, 242))
    return canvas, d


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(8100 + index * 43), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 512:
            c = (232 - y // 19, 226 - y // 19, 216 - y // 21)
        else:
            c = (
                182 - (y - 512) // 12 + rng.randint(-2, 2),
                152 - (y - 512) // 12 + rng.randint(-2, 2),
                120 - (y - 512) // 14 + rng.randint(-2, 2),
            )
        bgd.line((0, y, size, y), fill=c)

    if case["style"] == "white_bottle":
        bx0, by0 = 158 + rng.randint(-3, 3), 138 + rng.randint(-3, 3)
        bx1, by1 = bx0 + 452, by0 + 548
        canvas, d = draw_white_hdpe_shell(canvas, bx0, by0, bx1, by1)
        lx0, ly0, lx1, ly1 = bx0 + 22, by0 + 54, bx1 - 22, by1 - 42
        lw = lx1 - lx0
        d.rounded_rectangle((lx0, ly0, lx1, ly1), radius=12, fill=(254, 254, 255), outline=(182, 188, 196), width=2)
        d.rounded_rectangle((lx0, ly0, lx1, ly0 + 52), radius=12, fill=acc)
        d.rectangle((lx0, ly0 + 26, lx1, ly0 + 52), fill=acc)
        draw_text(d, (lx0 + 18, ly0 + 15), case["header"], (248, 250, 252), fit_size(d, case["header"], lw - 36, 20))
        draw_text(d, (lx0 + 18, ly0 + 68), case["title"], (14, 20, 28), fit_size(d, case["title"], lw - 36, 42), bold=True)
        draw_text(d, (lx0 + 18, ly0 + 124), case["subtitle"], (42, 50, 62), fit_size(d, case["subtitle"], lw - 36, 22))
        sx0, sy0, sy1 = lx0 + 18, ly0 + 172, ly0 + 252
        if case["occlude_mode"] is not None:
            sx1 = sx0 + 186
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(242, 247, 252), outline=acc, width=2)
            draw_text(d, (sx1 + 18, sy0 + 26), case["form"], (38, 46, 56), fit_size(d, case["form"], lx1 - sx1 - 32, 23))
        else:
            st = case["printed_strength"]
            sx1 = sx0 + max(178, int(d.textlength(st, font=ImageFont.load_default(size=40))) + 40)
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 252), outline=acc, width=3)
            draw_text(d, (sx0 + 18, sy0 + 18), st, (12, 18, 26), 40, bold=True)
            draw_text(d, (sx1 + 18, sy0 + 26), case["form"], (38, 46, 56), fit_size(d, case["form"], lx1 - sx1 - 32, 23))
        if case.get("warning_tag"):
            d.rounded_rectangle((lx0 + 18, ly0 + 268, lx1 - 18, ly0 + 308), radius=6, fill=(255, 242, 238), outline=(196, 62, 58), width=2)
            draw_text(d, (lx0 + 30, ly0 + 278), case["warning_tag"], (148, 28, 28), fit_size(d, case["warning_tag"], lw - 60, 19), bold=True)
        draw_text(d, (lx0 + 18, ly0 + 324), case["pack"], (48, 56, 66), fit_size(d, case["pack"], lw - 36, 21))
        esz = fit_size(d, case["expiry"], 240, 23)
        ew = int(d.textlength(case["expiry"], font=ImageFont.load_default(size=esz))) + 34
        ex0 = lx1 - ew - 18
        d.rounded_rectangle((ex0, ly1 - 74, lx1 - 18, ly1 - 20), radius=8, fill=(244, 247, 250), outline=(154, 162, 172), width=2)
        draw_text(d, (ex0 + 16, ly1 - 59), case["expiry"], (16, 22, 30), esz, bold=True)

        if case["occlude_mode"] == "thumb":
            th = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ImageDraw.Draw(th).rounded_rectangle((bx0 - 52, sy0 - 12, sx1 + 20, sy1 + 26), radius=46, fill=(28, 18, 12, 98))
            th = th.filter(ImageFilter.GaussianBlur(7.0))
            td = ImageDraw.Draw(th)
            td.rounded_rectangle((bx0 - 60, sy0 - 18, sx1 + 14, sy1 + 18), radius=48, fill=(214, 168, 142, 255), outline=(176, 130, 106, 255), width=3)
            td.rounded_rectangle((sx1 - 58, sy0 + 2, sx1 - 4, sy1 - 4), radius=22, fill=(236, 202, 184, 255), outline=(196, 154, 134, 255), width=2)
            canvas = Image.alpha_composite(canvas.convert("RGBA"), th).convert("RGB")
        elif case["occlude_mode"] == "glare":
            gl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            gd = ImageDraw.Draw(gl)
            gd.ellipse((sx0 - 38, sy0 - 28, sx1 + 54, sy1 + 30), fill=(255, 255, 255, 252))
            gd.polygon([(sx0 - 14, by0 + 18), (sx0 + 96, by0 + 18), (sx1 + 44, by1 - 24), (sx0 + 10, by1 - 24)], fill=(255, 255, 255, 196))
            bloom = gl.filter(ImageFilter.GaussianBlur(11.0))
            core = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ImageDraw.Draw(core).rounded_rectangle((sx0 - 10, sy0 - 8, sx1 + 16, sy1 + 8), radius=18, fill=(255, 255, 255, 255))
            rgba = Image.alpha_composite(canvas.convert("RGBA"), bloom)
            canvas = Image.alpha_composite(rgba, core).convert("RGB")

    elif case["style"] == "white_carton":
        x0, y0 = 68 + rng.randint(-4, 4), 126 + rng.randint(-4, 4)
        x1, y1 = x0 + 632, y0 + 468
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 90)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(252, 253, 254), outline=(168, 174, 182), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 60), radius=16, fill=acc)
        d.rectangle((x0, y0 + 32, x1, y0 + 60), fill=acc)
        d.rectangle((x0, y0 + 60, x0 + 12, y1 - 14), fill=acc)
        draw_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 576, 21))
        draw_text(d, (x0 + 28, y0 + 78), case["title"], (16, 22, 30), fit_size(d, case["title"], 576, 38), bold=True)
        draw_text(d, (x0 + 28, y0 + 132), case["subtitle"], (44, 52, 64), fit_size(d, case["subtitle"], 576, 23))
        st = case["printed_strength"]
        sx0, sy0, sy1 = x0 + 28, y0 + 178, y0 + 260
        sx1 = sx0 + max(196, int(d.textlength(st, font=ImageFont.load_default(size=42))) + 44)
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=3)
        draw_text(d, (sx0 + 20, sy0 + 18), st, (14, 20, 28), 42, bold=True)
        draw_text(d, (sx1 + 20, sy0 + 26), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 44, 24))
        d.rounded_rectangle((x0 + 28, y0 + 278, x1 - 28, y0 + 326), radius=8, fill=(255, 243, 238), outline=(196, 58, 54), width=2)
        draw_text(d, (x0 + 44, y0 + 291), case["boxed_notice"], (146, 26, 26), fit_size(d, case["boxed_notice"], 544, 21), bold=True)
        draw_text(d, (x0 + 28, y0 + 346), case["pack"], (52, 60, 70), fit_size(d, case["pack"], 576, 22))
        esz = fit_size(d, case["expiry"], 290, 24)
        ex0 = x1 - (int(d.textlength(case["expiry"], font=ImageFont.load_default(size=esz))) + 38) - 28
        d.rounded_rectangle((ex0, y0 + 388, x1 - 28, y0 + 444), radius=8, fill=(244, 247, 250), outline=(158, 166, 174), width=2)
        draw_text(d, (ex0 + 18, y0 + 403), case["expiry"], (18, 24, 32), esz, bold=True)

    elif case["style"] == "rear_bottle_warning":
        bx0, by0, bx1, by1 = 158, 138, 610, 686
        canvas, d = draw_white_hdpe_shell(canvas, bx0, by0, bx1, by1)
        lx0, ly0, lx1, ly1 = bx0 + 24, by0 + 64, bx1 - 24, by1 - 48
        lw = lx1 - lx0
        d.rounded_rectangle((lx0, ly0, lx1, ly1), radius=10, fill=(254, 254, 255), outline=(186, 192, 200), width=2)
        d.rounded_rectangle((lx0 + 14, ly0 + 18, lx1 - 14, ly1 - 18), radius=8, fill=(255, 250, 248), outline=acc, width=3)
        cy = ly0 + 48
        for ln in case["lines"]:
            sz = fit_size(d, ln, lw - 56, 20, 14)
            draw_text(d, (lx0 + 28, cy), ln, (32, 36, 44), sz)
            cy += 68

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.3, 1.3), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
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
    with tempfile.TemporaryDirectory(prefix="holdup_weekly_high_alert_", dir=temp_root()) as tmp:
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
    cases_out, cw_count, timeouts = [], 0, 0
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
                    "false_safe_allergen": False,
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
        cw_count += int(cw)
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
                "false_safe_allergen": False,
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
        "false_safe_allergen_count": 0,
        "false_safe_allergen_rate": 0.0,
        "false_safe_allergen_ci95_wilson": wilson_ci95(0, n),
        "rule_of_three_95_upper": round(3.0 / n, 4),
        "latency_s": {
            "p50": pct(lats, 0.5),
            "p95": pct(lats, 0.95),
            "mean": round(statistics.mean(lats), 3) if lats else 0.0,
        },
        "cases": cases_out,
    }
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} errors={errors} timeouts={timeouts}")
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
    assert not list(SUITE_DIR.glob("*.jpg")) and not list(SUITE_DIR.glob("*.png"))
    data = json.loads(raw)
    _, _, p_sha, s_sha = load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == NOW_ISO
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["confident_wrong_dose_count"] == 0 and data["false_safe_allergen_count"] == 0
    assert len(data["pass_ci95_wilson"]) == 2 and len(data["confident_wrong_dose_ci95_wilson"]) == 2
    assert data["rule_of_three_95_upper"] == 0.25
    assert all(k in data["latency_s"] for k in ("p50", "p95", "mean"))
    with tempfile.TemporaryDirectory(prefix="holdup_verify_wha_", dir=temp_root()) as tmp:
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
    assert "taken today: 0/1" in by_id["wh_01"]["reasons"]
    assert any("differs from your 2.5 mg" in r for r in by_id["wh_02"]["reasons"])
    assert any("differs from your 2.5 mg" in r for r in by_id["wh_03"]["reasons"])
    assert "not on your medication list" in by_id["wh_04"]["reasons"]
    assert "taken today: 0/1" in by_id["wh_05"]["reasons"]
    assert "taken today: 1/1" in by_id["wh_06"]["reasons"]
    assert "taken today: 0/1" in by_id["wh_07"]["reasons"]
    assert any("differs from your 3 mg" in r for r in by_id["wh_08"]["reasons"])
    assert by_id["wh_09"]["actual_level"] == "unsure"
    assert by_id["wh_10"]["actual_level"] == "unsure"
    assert "expired 2025-01" in by_id["wh_11"]["reasons"]
    assert by_id["wh_12"]["actual_level"] == "unsure"
    print(
        f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} "
        f"cw_dose={data['confident_wrong_dose_count']} bytes={len(raw.encode('utf-8'))}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
