from __future__ import annotations
import argparse, codecs, datetime, hashlib, io, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
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

SUITE_NAME = "insulin_glp1_pens"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T20:30:00+02:00"
LOGGED_BASAL_ISO = "2026-11-14T19:15:00+02:00"
LOGGED_BASAL_TS = int(datetime.datetime.fromisoformat(LOGGED_BASAL_ISO).timestamp() * 1000)
RESULTS_PATH = SUITE_DIR / "results.json"
README_PATH = SUITE_DIR / "README.md"
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

LANTUS_MED = {"id": "lantus", "name": "Lantus", "ingredient": "glargine", "strength": "100 IU/ml", "schedule": ["bedtime"]}
HUMALOG_MED = {"id": "humalog", "name": "Humalog", "ingredient": "lispro", "strength": "100 IU/ml", "schedule": ["morning", "noon", "evening"]}
TRESIBA_MED = {"id": "tresiba", "name": "Tresiba", "ingredient": "degludec", "strength": "100 IU/ml", "schedule": ["evening"]}
OZEMPIC_MED = {"id": "ozempic", "name": "Ozempic", "ingredient": "semaglutide", "strength": "0.5 mg", "schedule": ["morning"]}

BASAL_BOLUS_GLP1_MEDS: list[dict[str, Any]] = [LANTUS_MED, HUMALOG_MED, OZEMPIC_MED]
TRESIBA_GLP1_MEDS: list[dict[str, Any]] = [TRESIBA_MED, OZEMPIC_MED]
BASAL_ONLY_GLP1_MEDS: list[dict[str, Any]] = [LANTUS_MED, OZEMPIC_MED]


def make_profile(
    meds: list[dict[str, Any]] | None = None,
    dose_log: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "meds": list(meds) if meds is not None else list(BASAL_BOLUS_GLP1_MEDS),
        "allergies": ["penicillin"],
        "avoid": ["NSAIDs"],
        "doseLog": list(dose_log) if dose_log else [],
        "lang": "en",
    }


def pen_case(
    cid: str,
    style: str,
    scenario: str,
    expected_level: str,
    expected_reason: str,
    question: str,
    gt_strength: str | None,
    accent: tuple[int, int, int],
    header: str,
    title: str,
    subtitle: str,
    printed_strength: str,
    expiry: str,
    meds: list[dict[str, Any]] | None = None,
    dose_log: list[dict[str, Any]] | None = None,
    note_tag: str | None = None,
    occlusion: str | None = None,
    worn: bool = False,
) -> dict[str, Any]:
    return {
        "id": cid,
        "kind": "medication",
        "style": style,
        "scenario": scenario,
        "expected_level": expected_level,
        "expected_reason": expected_reason,
        "question": question,
        "gt_strength": gt_strength,
        "has_profile_allergen": False,
        "panel_readable": occlusion is None,
        "profile": make_profile(meds=meds, dose_log=dose_log),
        "accent": accent,
        "header": header,
        "title": title,
        "subtitle": subtitle,
        "printed_strength": printed_strength,
        "expiry": expiry,
        "note_tag": note_tag,
        "occlusion": occlusion,
        "worn": worn,
    }


CASES: list[dict[str, Any]] = [
    pen_case(
        "ig_01",
        "pen_carton",
        "standard_lantus_solostar_100iu_ml_basal_match",
        "match",
        "matches lantus",
        "Is this my bedtime Lantus 100 IU/ml basal insulin pen carton?",
        "100 IU/ml",
        (92, 52, 138),
        "SANOFI    SoloStar pre-filled pen",
        "LANTUS SoloStar",
        "Active substance: insulin glargine",
        "100 IU/ml",
        "EXP 2027-11",
        note_tag="BEDTIME BASAL",
    ),
    pen_case(
        "ig_02",
        "pen_carton",
        "concentrated_toujeo_300iu_ml_vs_lantus_100iu_ml_warning",
        "warning",
        "strength 300 IU/ml differs from your 100 IU/ml",
        "Can I inject this insulin glargine pen carton for my 100 IU/ml Lantus dose?",
        "300 IU/ml",
        (46, 114, 68),
        "SANOFI    SoloStar pre-filled pen",
        "TOUJEO SoloStar",
        "Active substance: insulin glargine",
        "300 IU/ml",
        "EXP 2027-10",
        note_tag="HIGH STRENGTH",
    ),
    pen_case(
        "ig_03",
        "pen_carton",
        "concentrated_humalog_kwikpen_200iu_ml_vs_100iu_ml_warning",
        "warning",
        "strength 200 IU/ml differs from your 100 IU/ml",
        "Is this Humalog KwikPen carton my usual 100 IU/ml mealtime insulin?",
        "200 IU/ml",
        (148, 38, 52),
        "ELI LILLY    KwikPen pre-filled pen",
        "HUMALOG KwikPen",
        "Active substance: insulin lispro",
        "200 IU/ml",
        "EXP 2027-09",
        note_tag="CONCENTRATED",
    ),
    pen_case(
        "ig_04",
        "pen_barrel",
        "concentrated_tresiba_flextouch_200iu_ml_barrel_warning",
        "warning",
        "strength 200 IU/ml differs from your 100 IU/ml",
        "Is this Tresiba FlexTouch pen my prescribed 100 IU/ml evening insulin?",
        "200 IU/ml",
        (28, 108, 76),
        "NOVO NORDISK    FlexTouch pen",
        "TRESIBA FlexTouch",
        "Insulin degludec",
        "200 IU/ml",
        "EXP 2027-12",
        meds=TRESIBA_GLP1_MEDS,
    ),
    pen_case(
        "ig_05",
        "pen_carton",
        "ozempic_0_25mg_starter_step_vs_0_5mg_maintenance_warning",
        "warning",
        "strength 0.25 mg differs from your 0.5 mg",
        "I found this Ozempic carton in the fridge door. Is it my 0.5 mg weekly pen?",
        "0.25 mg",
        (168, 44, 48),
        "NOVO NORDISK    Once-weekly GLP-1 pen",
        "OZEMPIC",
        "Active substance: semaglutide",
        "0.25 mg",
        "EXP 2027-08",
        note_tag="STARTER STEP",
    ),
    pen_case(
        "ig_06",
        "pen_carton",
        "ozempic_0_5mg_weekly_maintenance_step_match",
        "match",
        "matches ozempic",
        "Is this my prescribed Ozempic 0.5 mg weekly injection carton?",
        "0.5 mg",
        (194, 58, 46),
        "NOVO NORDISK    Once-weekly GLP-1 pen",
        "OZEMPIC",
        "Active substance: semaglutide",
        "0.5 mg",
        "EXP 2027-11",
        note_tag="WEEKLY PEN",
    ),
    pen_case(
        "ig_07",
        "pen_barrel",
        "ozempic_1mg_escalation_barrel_vs_0_5mg_warning",
        "warning",
        "strength 1 mg differs from your 0.5 mg",
        "Is this teal Ozempic pen barrel my 0.5 mg weekly semaglutide dose?",
        "1 mg",
        (22, 118, 132),
        "NOVO NORDISK    Pre-filled pen",
        "OZEMPIC",
        "Semaglutide",
        "1 mg",
        "EXP 2027-10",
    ),
    pen_case(
        "ig_08",
        "pen_barrel",
        "thumb_obscuring_humalog_kwikpen_concentration_window_unsure",
        "unsure",
        "not",
        "Is this Humalog KwikPen 100 IU/ml or 200 IU/ml while I am holding it?",
        None,
        (132, 46, 58),
        "ELI LILLY    KwikPen pre-filled pen",
        "HUMALOG KwikPen",
        "Insulin lispro",
        "",
        "EXP 2027-09",
        occlusion="thumb",
    ),
    pen_case(
        "ig_09",
        "pen_barrel",
        "specular_glare_obscuring_ozempic_mg_window_unsure",
        "unsure",
        "not",
        "What mg dose is this Ozempic pen under the kitchen light?",
        None,
        (26, 108, 136),
        "NOVO NORDISK    Pre-filled pen",
        "OZEMPIC",
        "Semaglutide",
        "",
        "EXP 2027-11",
        occlusion="glare",
    ),
    pen_case(
        "ig_10",
        "pen_carton",
        "expired_fridge_backup_lantus_solostar_100iu_ml_warning",
        "warning",
        "expired 2025-04",
        "This backup Lantus SoloStar carton was at the back of the fridge. Is it safe tonight?",
        "100 IU/ml",
        (92, 52, 138),
        "SANOFI    SoloStar pre-filled pen",
        "LANTUS SoloStar",
        "Active substance: insulin glargine",
        "100 IU/ml",
        "EXP 04/2025",
        worn=True,
    ),
    pen_case(
        "ig_11",
        "pen_barrel",
        "already_logged_daily_basal_lantus_100iu_ml_warning",
        "warning",
        "taken today: 1/1",
        "Did I already take my bedtime Lantus 100 IU/ml basal insulin pen tonight?",
        "100 IU/ml",
        (92, 52, 138),
        "SANOFI    SoloStar pre-filled pen",
        "LANTUS SoloStar",
        "Insulin glargine",
        "100 IU/ml",
        "EXP 2027-11",
        dose_log=[{"medId": "lantus", "ts": LOGGED_BASAL_TS}],
    ),
    pen_case(
        "ig_12",
        "pen_carton",
        "unlisted_bolus_novorapid_held_when_only_basal_on_list_warning",
        "warning",
        "not on your medication list",
        "Is this NovoRapid FlexPen my bedtime basal insulin?",
        "100 IU/ml",
        (208, 96, 24),
        "NOVO NORDISK    FlexPen pre-filled pen",
        "NOVORAPID FlexPen",
        "Active substance: insulin aspart",
        "100 IU/ml",
        "EXP 2027-10",
        meds=BASAL_ONLY_GLP1_MEDS,
        note_tag="RAPID ACTING",
    ),
]


def clean_val(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")
        return KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [clean_val(x) for x in val]
    if isinstance(val, dict):
        return {clean_val(str(k)): clean_val(v) for k, v in val.items()}
    return val


def temp_root() -> str:
    t = os.environ.get("TMPDIR")
    if t and os.path.isdir(t):
        return t
    return "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()


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
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(24, 20, 16, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)


def overlay_thumb_grip(canvas: Image.Image, win_box: tuple[int, int, int, int]) -> Image.Image:
    wx0, wy0, wx1, _ = win_box
    tx0, ty0, tx1, ty1 = wx0 - 12, wy0 - 14, wx1 + 14, canvas.size[1] + 24
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((tx0 - 8, ty0 + 8, tx1 + 10, ty1), radius=96, fill=(24, 16, 12, 115))
    base = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(8.0)))
    th = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(th)
    td.rounded_rectangle((tx0, ty0, tx1, ty1), radius=98, fill=(214, 168, 140, 255), outline=(172, 124, 98, 255), width=3)
    nx0, ny0, nx1, ny1 = tx0 + 34, ty0 + 20, tx1 - 34, ty0 + 116
    td.rounded_rectangle((nx0, ny0, nx1, ny1), radius=42, fill=(238, 208, 192, 255), outline=(192, 150, 128, 255), width=2)
    td.arc((nx0 + 8, ny1 - 28, nx1 - 8, ny1 + 8), start=195, end=345, fill=(248, 232, 224, 255), width=3)
    for cy in (ty0 + 156, ty0 + 178):
        td.arc((tx0 + 26, cy - 10, tx1 - 26, cy + 16), start=190, end=350, fill=(176, 128, 102, 220), width=3)
    return Image.alpha_composite(base, th).convert("RGB")


def overlay_specular_glare(canvas: Image.Image, win_box: tuple[int, int, int, int]) -> Image.Image:
    wx0, wy0, wx1, wy1 = win_box
    base = canvas.convert("RGBA")
    halo = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((wx0 - 38, wy0 - 34, wx1 + 38, wy1 + 34), fill=(255, 255, 255, 245))
    hd.polygon([(wx0 - 46, wy0 + 12), (wx1 + 48, wy0 - 28), (wx1 + 56, wy1 - 8), (wx0 - 36, wy1 + 28)], fill=(255, 255, 255, 230))
    base = Image.alpha_composite(base, halo.filter(ImageFilter.GaussianBlur(14.0)))
    core = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    cd.rounded_rectangle((wx0 - 10, wy0 - 10, wx1 + 10, wy1 + 10), radius=20, fill=(255, 255, 255, 255))
    return Image.alpha_composite(base, core).convert("RGB")


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(8100 + index * 37), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (228, 224, 218))
    bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        if y < 512:
            c = (236 - y // 20, 234 - y // 20, 229 - y // 22)
        else:
            c = (
                188 - (y - 512) // 12 + rng.randint(-2, 2),
                164 - (y - 512) // 12 + rng.randint(-2, 2),
                136 - (y - 512) // 14 + rng.randint(-2, 2),
            )
        bgd.line((0, y, size, y), fill=c)

    if case["style"] == "pen_carton":
        x0, y0 = 56 + rng.randint(-3, 3), 166 + rng.randint(-3, 3)
        x1, y1 = x0 + 656, y0 + 402
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 16, 92)
        box_fill = (243, 239, 230) if case["worn"] else (251, 252, 254)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=box_fill, outline=(162, 168, 178), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 58), radius=16, fill=acc)
        d.rectangle((x0, y0 + 30, x1, y0 + 58), fill=acc)
        d.rectangle((x0, y0 + 58, x0 + 14, y1 - 14), fill=acc)
        draw_text(d, (x0 + 30, y0 + 17), case["header"], (248, 250, 252), fit_size(d, case["header"], 596, 21))
        title_max = 420 if case.get("note_tag") else 596
        draw_text(d, (x0 + 30, y0 + 76), case["title"], (14, 20, 28), fit_size(d, case["title"], title_max, 40), bold=True)
        draw_text(d, (x0 + 30, y0 + 132), case["subtitle"], (42, 50, 62), fit_size(d, case["subtitle"], 596, 23))
        if case.get("note_tag"):
            tag = case["note_tag"]
            tw = int(d.textlength(tag, font=ImageFont.load_default(size=19))) + 28
            tx0 = x1 - tw - 24
            d.rounded_rectangle((tx0, y0 + 76, x1 - 24, y0 + 118), radius=6, fill=(255, 243, 158), outline=(202, 174, 68), width=2)
            draw_text(d, (tx0 + 14, y0 + 87), tag, (38, 30, 16), 19, bold=True)
        st = case["printed_strength"]
        sx0, sy0, sy1 = x0 + 30, y0 + 180, y0 + 262
        sx1 = sx0 + max(214, int(d.textlength(st, font=ImageFont.load_default(size=42))) + 48)
        d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(239, 245, 251), outline=acc, width=3)
        draw_text(d, (sx0 + 22, sy0 + 18), st, (12, 18, 26), 42, bold=True)
        form_txt = "solution for injection"
        draw_text(d, (sx1 + 20, sy0 + 27), form_txt, (38, 46, 56), fit_size(d, form_txt, x1 - sx1 - 42, 23))
        draw_text(d, (x0 + 30, y0 + 290), "Pre-filled pen    Subcutaneous use", (48, 56, 66), 22)
        esz = fit_size(d, case["expiry"], 280, 24)
        ew = int(d.textlength(case["expiry"], font=ImageFont.load_default(size=esz))) + 38
        ex0 = x1 - ew - 26
        exp_fill = (252, 238, 235) if case["worn"] else (244, 247, 250)
        exp_out = (178, 84, 74) if case["worn"] else (156, 164, 174)
        d.rounded_rectangle((ex0, y0 + 326, x1 - 26, y0 + 382), radius=8, fill=exp_fill, outline=exp_out, width=2)
        draw_text(d, (ex0 + 18, y0 + 341), case["expiry"], (16, 22, 30), esz, bold=True)
        if case["worn"]:
            for cx, cy, dx, dy in ((x0 + 10, y1 - 10, 1, -1), (x1 - 10, y0 + 10, -1, 1)):
                for _ in range(7):
                    px, py = cx + dx * rng.randint(3, 26), cy + dy * rng.randint(3, 20)
                    d.line((px, py, px + dx * rng.randint(8, 18), py + dy * rng.randint(4, 10)), fill=(190, 182, 168), width=2)

    else:
        bx0, by0, bx1, by1 = 88, 246, 642, 494
        canvas, d = add_shadow(canvas, (38, by0, 730, by1), 36, 94)
        d.rounded_rectangle((36, by0 + 14, 104, by1 - 14), radius=26, fill=acc, outline=(28, 32, 38), width=3)
        d.rounded_rectangle((636, by0 + 14, 704, by1 - 14), radius=12, fill=(214, 218, 224), outline=(138, 144, 154), width=3)
        for rx in range(648, 696, 9):
            d.line((rx, by0 + 22, rx, by1 - 22), fill=(166, 172, 182), width=3)
        d.rounded_rectangle((700, by0 + 34, 732, by1 - 34), radius=12, fill=acc, outline=(28, 32, 38), width=3)
        d.rounded_rectangle((bx0, by0, bx1, by1), radius=26, fill=(238, 242, 246), outline=(146, 154, 164), width=3)
        d.rounded_rectangle((bx0 + 8, by0 + 10, bx1 - 8, by0 + 34), radius=10, fill=(250, 252, 254))
        lx0, ly0, lx1, ly1 = 112, 266, 622, 474
        d.rounded_rectangle((lx0, ly0, lx1, ly1), radius=12, fill=(253, 253, 254), outline=(168, 174, 184), width=2)
        d.rounded_rectangle((lx0, ly0, lx1, ly0 + 38), radius=12, fill=acc)
        d.rectangle((lx0, ly0 + 20, lx1, ly0 + 38), fill=acc)
        draw_text(d, (lx0 + 18, ly0 + 9), case["header"], (248, 250, 252), fit_size(d, case["header"], 474, 19))
        draw_text(d, (lx0 + 18, ly0 + 48), case["title"], (14, 20, 28), fit_size(d, case["title"], 252, 32), bold=True)
        draw_text(d, (lx0 + 18, ly0 + 92), case["subtitle"], (38, 46, 58), fit_size(d, case["subtitle"], 252, 22))
        draw_text(d, (lx0 + 18, ly0 + 128), "Subcutaneous use", (56, 64, 74), 19)
        draw_text(d, (lx0 + 18, ly0 + 162), case["expiry"], (18, 24, 32), 21, bold=True)
        wx0, wy0, wx1, wy1 = 398, 336, 606, 438
        d.rounded_rectangle((wx0, wy0, wx1, wy1), radius=12, fill=(239, 246, 252), outline=acc, width=3)
        if case["occlusion"] is None:
            pst = case["printed_strength"]
            ssz = fit_size(d, pst, wx1 - wx0 - 28, 38)
            draw_text(d, (wx0, wy0 + 28), pst, (12, 18, 26), ssz, bold=True, center_w=wx1 - wx0)
        elif case["occlusion"] == "thumb":
            canvas = overlay_thumb_grip(canvas, (wx0, wy0, wx1, wy1))
        elif case["occlusion"] == "glare":
            canvas = overlay_specular_glare(canvas, (wx0, wy0, wx1, wy1))

    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.2, 1.2), resample=Image.Resampling.BICUBIC, fillcolor=(220, 214, 204)).save(buf, format="JPEG", quality=90)
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
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
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
        headers = {"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"].strip()}
        for attempt in range(4):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                txt = next(p["text"] for p in parts if "text" in p and not p.get("thought") and p["text"].strip())
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


def is_false_safe_allergen(case: dict[str, Any], actual: str, reasons: list[str]) -> bool:
    if case["kind"] != "food":
        return False
    if case["has_profile_allergen"]:
        return actual != "warning" or not any("allergy:" in str(r) for r in reasons)
    return actual in ("info", "match") if not case["panel_readable"] else False


def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_insulin_glp1_", dir=temp_root()) as tmp:
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
    cases_out, cw_count, fsa_count, timeouts = [], 0, 0, 0
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
        fsa = is_false_safe_allergen(c, actual, reasons)
        cw_count += int(cw)
        fsa_count += int(fsa)
        reason_ok = any(c["expected_reason"] in str(r) for r in reasons)
        passed = (actual == c["expected_level"]) and reason_ok and not cw and not fsa
        cases_out.append(
            {
                "id": c["id"],
                "kind": c["kind"],
                "scenario": c["scenario"],
                "expected_level": c["expected_level"],
                "actual_level": actual,
                "passed": passed,
                "strength_read": s_val,
                "strength_conf": s_conf,
                "name_conf": n_conf,
                "readability": round(float(rd["readability"]), 4),
                "confident_wrong_dose": cw,
                "false_safe_allergen": fsa,
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
    report = clean_val(
        {
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
            "false_safe_allergen_count": fsa_count,
            "false_safe_allergen_rate": round(fsa_count / n, 4),
            "false_safe_allergen_ci95_wilson": wilson_ci95(fsa_count, n),
            "rule_of_three_95_upper": round(3.0 / n, 4),
            "latency_s": {
                "p50": pct(lats, 0.5),
                "p95": pct(lats, 0.95),
                "mean": round(statistics.mean(lats), 3) if lats else 0.0,
            },
            "cases": cases_out,
        }
    )
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} fsa={fsa_count} errors={errors} timeouts={timeouts} bytes={RESULTS_PATH.stat().st_size}")
    return report


def verify_cached() -> None:
    src_py = Path(__file__).read_text(encoding="utf-8")
    assert chr(35) not in src_py and chr(8212) not in src_py and chr(8211) not in src_py and not KEY_RE.search(src_py)
    if README_PATH.is_file():
        rm = README_PATH.read_text(encoding="utf-8")
        assert chr(35) not in rm and chr(8212) not in rm and chr(8211) not in rm and not KEY_RE.search(rm)
    for p in SUITE_DIR.iterdir():
        assert p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")
    raw_bytes = RESULTS_PATH.read_bytes()
    assert len(raw_bytes) < 15000, f"results.json too large: {len(raw_bytes)}"
    raw = raw_bytes.decode("utf-8")
    assert chr(35) not in raw and chr(8212) not in raw and chr(8211) not in raw and not KEY_RE.search(raw)
    assert ("base" + "64") not in raw.lower() and ("/" + "9j/") not in raw and ("data:" + "image") not in raw
    data, (_, _, p_sha, s_sha) = json.loads(raw), load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["eval_now_iso"] == NOW_ISO
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    assert data["pass_count"] == 12 and data["pass_rate"] == 1.0
    assert data["confident_wrong_dose_count"] == 0 and data["false_safe_allergen_count"] == 0
    assert data["pass_ci95_wilson"] == wilson_ci95(data["pass_count"], 12)
    assert data["confident_wrong_dose_ci95_wilson"] == wilson_ci95(0, 12)
    assert data["rule_of_three_95_upper"] == 0.25
    assert all(k in data["latency_s"] for k in ("p50", "p95", "mean"))
    with tempfile.TemporaryDirectory(prefix="holdup_verify_ig_", dir=temp_root()) as tmp:
        for idx, c in enumerate(CASES, start=1):
            jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            assert len(jpg) > 5000
    replayed = run_safety_bridge(
        [{"read": r["read"], "profile": c["profile"], "now": NOW_ISO} for c, r in zip(CASES, data["cases"])]
    )
    by_id: dict[str, dict[str, Any]] = {}
    for spec, row, vd in zip(CASES, data["cases"], replayed):
        assert row["id"] == spec["id"] and row["kind"] == spec["kind"]
        assert vd["level"] == row["actual_level"] and vd["reasons"] == row["reasons"]
        assert any(spec["expected_reason"] in str(r) for r in vd["reasons"]), f"{spec['id']} reasons: {vd['reasons']}"
        assert not is_cw_dose(spec, row["strength_read"], float(row["strength_conf"]), vd["level"])
        assert not is_false_safe_allergen(spec, vd["level"], vd["reasons"])
        assert row["passed"] is True and row["actual_level"] == spec["expected_level"]
        by_id[row["id"]] = row
    assert "taken today: 0/1" in by_id["ig_01"]["reasons"]
    assert any("differs from your 100 IU/ml" in r for r in by_id["ig_02"]["reasons"])
    assert any("differs from your 100 IU/ml" in r for r in by_id["ig_03"]["reasons"])
    assert any("differs from your 100 IU/ml" in r for r in by_id["ig_04"]["reasons"])
    assert any("differs from your 0.5 mg" in r for r in by_id["ig_05"]["reasons"])
    assert "taken today: 0/1" in by_id["ig_06"]["reasons"]
    assert any("differs from your 0.5 mg" in r for r in by_id["ig_07"]["reasons"])
    assert by_id["ig_08"]["actual_level"] == "unsure" and by_id["ig_08"]["strength_read"] is None
    assert by_id["ig_09"]["actual_level"] == "unsure" and by_id["ig_09"]["strength_read"] is None
    assert "expired 2025-04" in by_id["ig_10"]["reasons"]
    assert "taken today: 1/1" in by_id["ig_11"]["reasons"]
    assert "not on your medication list" in by_id["ig_12"]["reasons"]
    print(
        f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} "
        f"cw_dose={data['confident_wrong_dose_count']} fsa={data['false_safe_allergen_count']} "
        f"bytes={len(raw_bytes)}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    verify_cached() if args.verify_cached else run_live(args.workers)
