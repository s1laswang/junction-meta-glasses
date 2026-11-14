from __future__ import annotations
import argparse, codecs, hashlib, io, json, math, os, random, shutil, statistics, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
EVAL_DIR, REPO_ROOT = SUITE_DIR.parent.parent, SUITE_DIR.parents[2]
if str(EVAL_DIR) not in sys.path: sys.path.insert(0, str(EVAL_DIR))
from common import parse_json
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME, MODEL, CONF_THRESHOLD, NOW_ISO = "multilingual_eu", "gemini-3.8-flash", 0.8, "2026-11-14T20:00:00Z"
LANGUAGES_TESTED, RESULTS_PATH = ["fi", "sv", "de", "fr", "es", "en"], SUITE_DIR / "results.json"
PROFILE: dict[str, Any] = {"meds": [
    {"id": "aml", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
    {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    {"id": "par", "name": "Paracetamol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]},
], "allergies": ["peanut", "tree nuts"], "avoid": ["NSAIDs"], "doseLog": [], "lang": "en"}
DIACRITICS: dict[str, tuple[str, str]] = {"ä": ("a", "uml"), "ö": ("o", "uml"), "ü": ("u", "uml"), "Ä": ("A", "uml"), "Ö": ("O", "uml"), "Ü": ("U", "uml"), "å": ("a", "ring"), "Å": ("A", "ring"), "é": ("e", "acute"), "á": ("a", "acute"), "ó": ("o", "acute"), "í": ("i", "acute")}

def med(cid: str, lang: str, sc: str, exp_lvl: str, q: str, gt_s: str | None, acc: tuple[int, int, int], hdr: str, title: str, sub: str, p_str: str, form: str, pack: str, exp: str, occ: bool = False) -> dict[str, Any]:
    return {"id": cid, "language": lang, "kind": "medication", "style": "med_box", "scenario": sc, "expected_level": exp_lvl, "question": q, "gt_strength": gt_s, "has_profile_allergen": False, "panel_readable": not occ, "accent": acc, "header": hdr, "title": title, "subtitle": sub, "printed_strength": p_str, "form": form, "pack": pack, "expiry": exp, "occlude": occ}

def food(cid: str, lang: str, sc: str, exp_lvl: str, q: str, has_alg: bool, acc: tuple[int, int, int], fill: tuple[int, int, int], hdr: str, title: str, sub: str, ing: list[str], alg: list[str], exp: str, wt: str) -> dict[str, Any]:
    return {"id": cid, "language": lang, "kind": "food", "style": "food_carton", "scenario": sc, "expected_level": exp_lvl, "question": q, "gt_strength": None, "has_profile_allergen": has_alg, "panel_readable": True, "accent": acc, "pack_fill": fill, "header": hdr, "title": title, "subtitle": sub, "ingredients": ing, "allergens": alg, "expiry": exp, "weight": wt}

CASES: list[dict[str, Any]] = [
    med("ml_01", "fi", "fi_amlodipiini_5mg_evening_match", "match", "Is this my evening blood pressure pill?", "5 mg", (20, 104, 146), "ORION PHARMA    Vnr 08 44 12", "AMLODIPIN ORION", "Vaikuttava aine: amlodipiini", "5 mg", "tabletti", "30 tablettia    Suun kautta", "Käyt. viim. 10.2027"),
    med("ml_02", "sv", "sv_metforminhydroklorid_500mg_match", "match", "Is this my metformin 500 mg tablet?", "500 mg", (34, 82, 162), "ACTAVIS    Vnr 12 73 09", "METFORMIN ACTAVIS", "Aktiv substans: metforminhydroklorid", "500 mg", "filmdragerade tabletter", "100 filmdragerade tabletter", "Utg.dat. 12.2027"),
    med("ml_03", "fi", "fi_burana_ibuprofeeni_nsaid_avoid_warning", "warning", "Can I take this for headache pain?", "400 mg", (186, 34, 44), "ORION PHARMA    Vnr 01 66 40", "BURANA", "Vaikuttava aine: ibuprofeeni", "400 mg", "tabletti", "30 tablettia    Suun kautta", "Käyt. viim. 11.2027"),
    med("ml_04", "de", "de_amlodipin_5mg_verwendbar_bis_match", "match", "Is this my 5 mg evening pill?", "5 mg", (174, 28, 42), "STADA ARZNEIMITTEL    PZN 04128831", "AMLODIPIN STADA", "Wirkstoff: Amlodipin", "5 mg", "Tabletten", "30 Tabletten N1    Zum Einnehmen", "Verwendbar bis 09.2027"),
    med("ml_05", "fr", "fr_amlodipine_10mg_2x_strength_warning", "warning", "Is this my 5 mg evening pill?", "10 mg", (58, 66, 148), "BIOGARAN    CIP 34009 362 41", "AMLODIPINE BIOGARAN", "Substance active : amlodipine", "10 mg", "gélules", "30 gélules    Voie orale", "EXP 08/2027"),
    med("ml_06", "es", "es_paracetamol_500mg_cad_match", "match", "Can I take this paracetamol for fever?", "500 mg", (22, 118, 96), "KERN PHARMA    CN 658412.4", "PARACETAMOL KERN PHARMA", "Principio activo: paracetamol", "500 mg", "comprimidos", "20 comprimidos EFG    Vía oral", "CAD 11/2027"),
    food("ml_07", "fi", "fi_food_maapahkina_peanut_allergy_warning", "warning", "Is this snack bar safe with my nut allergies?", True, (128, 68, 36), (246, 238, 224), "POHJOLAN HERKUT", "Suklainen myslipatukka", "Rapea välipalapatukka  45 g", ["Ainesosat: kaura, sokeri,", "paahdettu maapähkinä (15%), kaakaovoi."], ["Sisältää: maapähkinä, kaura."], "Parasta ennen 10.2027", "45 g"),
    food("ml_08", "sv", "sv_food_hasselnotter_treenut_allergy_warning", "warning", "Does this spread contain any nuts?", True, (106, 56, 32), (247, 239, 227), "SVENSKA DELIKATESSER", "Nötsmörskräm", "Bredbar kräm med kakao  350 g", ["Ingredienser: socker,", "rostade hasselnötter (18%), kakao."], ["Innehåller: hasselnötter."], "Bäst före 11.2027", "350 g"),
    food("ml_09", "fi", "fi_food_kaurajuoma_nut_free_panel_info", "info", "Is this oat drink safe with my nut allergies?", False, (38, 108, 128), (244, 248, 249), "POHJAN KAURA", "Kaurajuoma", "Kasvipohjainen juoma  1 L", ["Ainesosat: vesi, täysjyväkaura (10%),", "rypsiöljy, merisuola."], ["Allergeenit: sisältää kauraa (gluteeni)."], "Parasta ennen 11.2027", "1 L"),
    food("ml_10", "sv", "sv_food_havredryck_nut_free_panel_info", "info", "Can I drink this with my peanut and tree nut allergies?", False, (42, 98, 146), (244, 247, 251), "NORDISK HAVRE", "Havredryck", "Växtbaserad dryck  1 L", ["Ingredienser: vatten, fullkornshavre (10%),", "rapsolja, havssalt."], ["Allergener: innehåller havre (gluten)."], "Bäst före 10.2027", "1 L"),
    med("ml_11", "en", "eu_trilingual_thumb_occluded_strength_abstention", "unsure", "Is this my 5 mg evening pill?", None, (24, 98, 134), "EUROPAPHARMA    EU/1/24/1820", "AMLODIPIN / AMLODIPINE", "Active substance: amlodipine / Wirkstoff: Amlodipin", "", "Tablets / Tabletten / Comprimés", "Oral use / Zum Einnehmen / Voie orale", "EXP 2027-10", True),
    {"id": "ml_12", "language": "fr", "kind": "food", "style": "front_biscuit_box", "scenario": "fr_front_biscuit_carton_no_allergen_panel_abstention", "expected_level": "unsure", "question": "Are these French biscuits safe with my nut allergy?",
     "gt_strength": None, "has_profile_allergen": False, "panel_readable": False, "accent": (36, 58, 108), "pack_fill": (248, 242, 228), "header": "MAISON DELACROIX", "title": "Biscuits Fins Artisanaux", "subtitle": "Recette traditionnelle de France", "back_note": "Voir ingrédients et allergènes au dos", "weight": "250 g"},
]

def clean_val(val: Any) -> Any:
    if isinstance(val, str): return val.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")
    return [clean_val(x) for x in val] if isinstance(val, list) else ({clean_val(k): clean_val(v) for k, v in val.items()} if isinstance(val, dict) else val)

def temp_root() -> str:
    t = os.environ.get("TMPDIR")
    return t if (t and os.path.isdir(t)) else ("/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir())

def ensure_env() -> None:
    if os.environ.get("GEMINI_API_KEY"): return
    cands = [Path(os.environ["HOLDUP_ENV_FILE"])] if os.environ.get("HOLDUP_ENV_FILE") else []
    for p in (*cands, Path.home() / "momin" / ".env", REPO_ROOT / ".env", Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = raw[7:].strip() if raw.strip().startswith("export ") else raw.strip()
                if line and not line.startswith(chr(35)) and "=" in line:
                    k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            if os.environ.get("GEMINI_API_KEY"): return
    raise RuntimeError("GEMINI_API_KEY not set")

def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0: return [0.0, 0.0]
    z, p = 1.959963984540054, k / n
    z2, denom = z * z, 1.0 + (z * z) / n
    c, h = (p + z2 / (2.0 * n)) / denom, (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / denom
    return [max(0.0, round(c - h, 4)), min(1.0, round(c + h, 4))]

def pct(vals: list[float], q: float) -> float:
    if not vals: return 0.0
    xs, pos = sorted(vals), (len(vals) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(xs[lo] if lo == hi else xs[lo] * (1.0 - (pos - lo)) + xs[hi] * (pos - lo), 3)

def ascii_base(text: str) -> tuple[str, list[tuple[int, str]]]:
    chars, marks = [], []
    for idx, ch in enumerate(text):
        chars.append(DIACRITICS[ch][0] if ch in DIACRITICS else ch)
        if ch in DIACRITICS: marks.append((idx, DIACRITICS[ch][1]))
    return "".join(chars), marks

def fit_size(draw: ImageDraw.ImageDraw, text: str, max_w: int, start_sz: int, min_sz: int = 16) -> int:
    base, sz = ascii_base(text)[0], start_sz
    while sz > min_sz and draw.textlength(base, font=ImageFont.load_default(size=sz)) > max_w: sz -= 1
    return sz

def draw_eu_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fill: tuple[int, int, int], size: int, bold: bool = False, center_w: int | None = None) -> None:
    base, marks = ascii_base(text); font = ImageFont.load_default(size=size)
    x, y = (xy[0] + int((center_w - draw.textlength(base, font=font)) / 2) if center_w is not None else xy[0]), xy[1]
    draw.text((x, y), base, fill=fill, font=font, stroke_width=1 if bold else 0, stroke_fill=fill)
    for idx, kind in marks:
        px = x + draw.textlength(base[:idx], font=font)
        cx, top_y = int(round(px + draw.textlength(base[idx], font=font) * 0.5)), int(draw.textbbox((int(round(px)), y), base[idx], font=font)[1])
        if kind == "uml":
            r, sep = max(1, size // 14), max(3, size // 8); cy = top_y - r - 3
            draw.ellipse((cx - sep - r, cy - r, cx - sep + r, cy + r), fill=fill); draw.ellipse((cx + sep - r, cy - r, cx + sep + r, cy + r), fill=fill)
        elif kind == "ring":
            r = max(2, size // 11); draw.ellipse((cx - r, top_y - 2 * r - 2, cx + r, top_y - 2), outline=fill, width=max(1, size // 15))
        elif kind == "acute": draw.line((cx - 1, top_y - 2, cx + max(3, size // 7), top_y - 2 - max(4, size // 5)), fill=fill, width=max(2, size // 13))

def add_shadow(canvas: Image.Image, box: tuple[int, int, int, int], rad: int, alpha: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((box[0] + 12, box[1] + 16, box[2] + 16, box[3] + 20), radius=rad, fill=(26, 20, 14, alpha))
    out = Image.alpha_composite(canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    return out, ImageDraw.Draw(out)

def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng, size, acc = random.Random(6200 + index * 37), 768, case["accent"]
    canvas = Image.new("RGB", (size, size), (226, 218, 206)); bgd = ImageDraw.Draw(canvas)
    for y in range(size):
        c = (234 - y // 18, 228 - y // 18, 218 - y // 20) if y < 500 else (184 - (y - 500) // 12 + rng.randint(-2, 2), 154 - (y - 500) // 12 + rng.randint(-2, 2), 122 - (y - 500) // 14 + rng.randint(-2, 2))
        bgd.line((0, y, size, y), fill=c)
    if case["style"] == "med_box":
        x0, y0 = 68 + rng.randint(-4, 4), 134 + rng.randint(-4, 4); x1, y1 = x0 + 632, y0 + 444
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 90)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(168, 174, 182), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc); d.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc); d.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
        draw_eu_text(d, (x0 + 28, y0 + 18), case["header"], (248, 250, 252), fit_size(d, case["header"], 576, 22))
        draw_eu_text(d, (x0 + 28, y0 + 82), case["title"], (16, 22, 30), fit_size(d, case["title"], 576, 40), bold=True)
        draw_eu_text(d, (x0 + 28, y0 + 140), case["subtitle"], (46, 54, 66), fit_size(d, case["subtitle"], 576, 23))
        sx0, sy0, sy1 = x0 + 28, y0 + 190, y0 + 272
        if case["occlude"]:
            sx1 = sx0 + 220; d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
            draw_eu_text(d, (sx1 + 22, sy0 + 28), case["form"], (40, 48, 58), fit_size(d, case["form"], 330, 22))
        else:
            st = case["printed_strength"]; sx1 = sx0 + max(196, int(d.textlength(st, font=ImageFont.load_default(size=42))) + 44)
            d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=3)
            draw_eu_text(d, (sx0 + 20, sy0 + 18), st, (14, 20, 28), 42, bold=True)
            draw_eu_text(d, (sx1 + 20, sy0 + 26), case["form"], (40, 48, 58), fit_size(d, case["form"], x1 - sx1 - 44, 24))
        draw_eu_text(d, (x0 + 28, y0 + 308), case["pack"], (52, 60, 70), fit_size(d, case["pack"], 576, 22))
        esz = fit_size(d, case["expiry"], 290, 24); ex0 = x1 - (int(d.textlength(ascii_base(case["expiry"])[0], font=ImageFont.load_default(size=esz))) + 38) - 28
        d.rounded_rectangle((ex0, y0 + 362, x1 - 28, y0 + 420), radius=8, fill=(244, 247, 250), outline=(158, 166, 174), width=2)
        draw_eu_text(d, (ex0 + 18, y0 + 378), case["expiry"], (18, 24, 32), esz)
        if case["occlude"]:
            th = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ImageDraw.Draw(th).rounded_rectangle((x0 - 36, sy0 - 10, sx1 + 18, sy1 + 26), radius=46, fill=(30, 20, 14, 96))
            th = th.filter(ImageFilter.GaussianBlur(7.0)); td = ImageDraw.Draw(th)
            td.rounded_rectangle((x0 - 44, sy0 - 16, sx1 + 12, sy1 + 18), radius=48, fill=(214, 168, 142, 255), outline=(176, 130, 106, 255), width=3)
            td.rounded_rectangle((sx1 - 62, sy0 + 2, sx1 - 4, sy1 - 4), radius=24, fill=(236, 202, 184, 255), outline=(196, 154, 134, 255), width=2)
            canvas = Image.alpha_composite(canvas.convert("RGBA"), th).convert("RGB")
    elif case["style"] == "food_carton":
        x0, y0, x1, y1, cw = 112, 76, 656, 692, 544
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 18, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(166, 160, 148), width=3)
        d.rounded_rectangle((x0, y0, x1, y0 + 70), radius=16, fill=acc); d.rectangle((x0, y0 + 36, x1, y0 + 70), fill=acc)
        draw_eu_text(d, (x0 + 26, y0 + 22), case["header"], (248, 250, 248), fit_size(d, case["header"], cw - 52, 22))
        draw_eu_text(d, (x0 + 26, y0 + 94), case["title"], (20, 32, 26), fit_size(d, case["title"], cw - 52, 38), bold=True)
        draw_eu_text(d, (x0 + 26, y0 + 150), case["subtitle"], (54, 66, 60), fit_size(d, case["subtitle"], cw - 52, 23))
        d.rounded_rectangle((x0 + 24, y0 + 202, x1 - 24, y0 + 448), radius=12, fill=(253, 252, 248), outline=(180, 174, 162), width=2); iy = y0 + 224
        for ln in case["ingredients"]: draw_eu_text(d, (x0 + 40, iy), ln, (22, 28, 28), fit_size(d, ln, cw - 80, 23)); iy += 38
        iy += 14; d.rounded_rectangle((x0 + 36, iy - 6, x1 - 36, iy + 54), radius=8, fill=(255, 244, 232), outline=(194, 120, 64), width=2)
        for ln in case["allergens"]: draw_eu_text(d, (x0 + 48, iy + 10), ln, (108, 36, 18), fit_size(d, ln, cw - 96, 23), bold=True); iy += 32
        d.rounded_rectangle((x0 + 24, y0 + 472, x1 - 24, y0 + 534), radius=8, fill=(255, 255, 255), outline=(188, 184, 174), width=2)
        draw_eu_text(d, (x0 + 40, y0 + 490), case["expiry"], (20, 26, 28), fit_size(d, case["expiry"], cw - 80, 25)); draw_eu_text(d, (x0 + 28, y1 - 52), case["weight"], (52, 64, 58), 25)
    else:
        x0, y0, x1, y1, cw = 104, 118, 664, 638, 560
        canvas, d = add_shadow(canvas, (x0, y0, x1, y1), 16, 92)
        d.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=case["pack_fill"], outline=(174, 156, 120), width=3)
        d.rounded_rectangle((x0 + 16, y0 + 16, x1 - 16, y1 - 16), radius=12, outline=acc, width=3); d.rounded_rectangle((x0 + 48, y0 + 44, x1 - 48, y0 + 116), radius=10, fill=acc)
        draw_eu_text(d, (x0 + 48, y0 + 64), case["header"], (252, 244, 218), fit_size(d, case["header"], cw - 120, 28), center_w=cw - 96)
        draw_eu_text(d, (x0 + 32, y0 + 144), case["title"], (26, 40, 76), fit_size(d, case["title"], cw - 64, 36), bold=True, center_w=cw - 64)
        draw_eu_text(d, (x0 + 40, y0 + 198), case["subtitle"], (56, 68, 96), fit_size(d, case["subtitle"], cw - 80, 23), center_w=cw - 80)
        for bx, by in ((x0 + cw // 2 - 92, y0 + 320), (x0 + cw // 2 + 6, y0 + 304), (x0 + cw // 2 + 86, y0 + 338)):
            d.ellipse((bx - 48, by - 48, bx + 48, by + 48), fill=(224, 178, 104), outline=(184, 136, 66), width=3); d.ellipse((bx - 28, by - 28, bx + 28, by + 28), outline=(202, 154, 82), width=2)
        draw_eu_text(d, (x0 + 40, y1 - 108), case["back_note"], (68, 76, 98), fit_size(d, case["back_note"], cw - 80, 20), center_w=cw - 80)
        draw_eu_text(d, (x0 + 40, y1 - 66), case["weight"], (32, 44, 72), 26, center_w=cw - 80)
    buf = io.BytesIO(); canvas.rotate(rng.uniform(-1.5, 1.5), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
    data = buf.getvalue(); out_path.write_bytes(data); return data

def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    ensure_env(); user_text = f'The person asked: "{question}"'
    try:
        from google.genai import types
        from common import gen_json
        raw, _, dt = gen_json(MODEL, [types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"), user_text], schema=schema, system=prompt, thinking="low", max_tokens=4096, feature=f"eval.{SUITE_NAME}", label=cid)
        return clean_val(to_label_read(raw)), float(dt)
    except ModuleNotFoundError:
        img_str = codecs.encode(jpeg_bytes, "base" + "64").decode("ascii").replace("\n", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ['GEMINI_API_KEY']}"
        body = json.dumps({"systemInstruction": {"parts": [{"text": prompt}]}, "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": img_str}}, {"text": user_text}]}],
                           "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema, "thinkingConfig": {"thinkingLevel": "LOW"}, "maxOutputTokens": 4096}}).encode("utf-8")
        for attempt in range(4):
            t0 = time.time()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                return clean_val(to_label_read(parse_json(next(p["text"] for p in parts if "text" in p and not p.get("thought"))))), time.time() - t0
            except Exception:
                if attempt == 3: raise
                time.sleep(2.0 * (attempt + 1))
        raise RuntimeError("unreachable")

def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_path = ":".join(["/home/silas/tools/node/bin", str(REPO_ROOT / "node_modules" / ".bin"), os.environ.get("PATH", "")])
    node_bin = "/home/silas/tools/node/bin/node" if os.path.exists("/home/silas/tools/node/bin/node") else (shutil.which("node", path=merged_path) or "node")
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=str(REPO_ROOT / "server" / "src" / "safety.ts"))
    proc = subprocess.run([node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")], input="\n".join(json.dumps(x, ensure_ascii=False) for x in batch) + "\n", text=True, capture_output=True, cwd=str(REPO_ROOT), env=env, timeout=90, check=False)
    if proc.returncode != 0: raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:300]}")
    return [clean_val(json.loads(line)) for line in proc.stdout.splitlines() if line.strip()]

def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    p_bytes, s_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes(), (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return p_bytes.decode("utf-8"), inline_refs(json.loads(s_bytes.decode("utf-8"))), hashlib.sha256(p_bytes).hexdigest(), hashlib.sha256(s_bytes).hexdigest()

def is_cw_dose(case: dict[str, Any], s_val: str | None, s_conf: float, actual: str) -> bool:
    if case["expected_level"] != "match" and actual == "match": return True
    if s_val is None or not str(s_val).strip() or s_conf < CONF_THRESHOLD: return False
    return True if case["gt_strength"] is None else not eq_strength(case["gt_strength"], str(s_val))

def is_false_safe_allergen(case: dict[str, Any], actual: str, reasons: list[str]) -> bool:
    if case["kind"] != "food": return False
    if case["has_profile_allergen"]: return actual != "warning" or not any("allergy:" in str(r) for r in reasons)
    return actual in ("info", "match") if not case["panel_readable"] else False

def format_report_json(report: dict[str, Any]) -> str:
    top = json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in report["cases"])
    return top[:-2] + ",\n  \"cases\": [\n" + rows + "\n  ]\n}\n"

def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_multilingual_eu_", dir=temp_root()) as tmp:
        def job(item: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            idx, c = item; jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            try:
                read, dt = call_gemini(jpg, c["question"], prompt, schema, c["id"])
                return {"read": read, "latency_s": round(dt, 3), "error": None}
            except Exception as exc:
                return {"read": None, "latency_s": 0.0, "error": clean_val(str(exc)[:180])}
        with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as ex: preds = list(ex.map(job, enumerate(CASES, start=1)))
    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    v_map = dict(zip(ok_idx, run_safety_bridge([{"read": preds[i]["read"], "profile": PROFILE, "now": NOW_ISO} for i in ok_idx]) if ok_idx else []))
    cases_out, cw_count, fsa_count, timeouts = [], 0, 0, 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append({"id": c["id"], "language": c["language"], "kind": c["kind"], "scenario": c["scenario"], "expected_level": c["expected_level"], "actual_level": "error", "passed": False,
                              "strength_read": None, "strength_conf": 0.0, "name_conf": 0.0, "readability": 0.0, "confident_wrong_dose": False, "false_safe_allergen": False, "latency_s": pr["latency_s"], "error": pr["error"], "read": None, "reasons": []})
            continue
        rd, vd = pr["read"], v_map[i]; actual, reasons = vd["level"], vd["reasons"]
        s_val = clean_val(rd["strength"]["value"]) if rd["strength"]["value"] is not None else None
        s_conf = round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(max(float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0, float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0), 4)
        cw, fsa = is_cw_dose(c, s_val, s_conf, actual), is_false_safe_allergen(c, actual, reasons)
        cw_count += int(cw); fsa_count += int(fsa)
        cases_out.append({"id": c["id"], "language": c["language"], "kind": c["kind"], "scenario": c["scenario"], "expected_level": c["expected_level"], "actual_level": actual, "passed": actual == c["expected_level"],
                          "strength_read": s_val, "strength_conf": s_conf, "name_conf": n_conf, "readability": round(float(rd["readability"]), 4), "confident_wrong_dose": cw, "false_safe_allergen": fsa, "latency_s": pr["latency_s"], "error": None, "read": rd, "reasons": reasons})
    n, errors, pass_count = len(cases_out), sum(1 for x in cases_out if x["error"] is not None), sum(1 for x in cases_out if x["passed"])
    lats = [x["latency_s"] for x in cases_out if x["error"] is None]
    report = {"suite": SUITE_NAME, "model": MODEL, "thinking_level": "low", "prompt_sha256": p_sha, "schema_sha256": s_sha, "eval_now_iso": NOW_ISO, "languages_tested": LANGUAGES_TESTED, "n": n, "errors": errors, "timeouts": timeouts,
              "pass_count": pass_count, "pass_rate": round(pass_count / n, 4), "pass_ci95_wilson": wilson_ci95(pass_count, n), "confident_wrong_dose_count": cw_count, "confident_wrong_dose_rate": round(cw_count / n, 4),
              "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n), "false_safe_allergen_count": fsa_count, "false_safe_allergen_rate": round(fsa_count / n, 4), "rule_of_three_95_upper": round(3.0 / n, 4),
              "latency_s": {"p50": pct(lats, 0.5), "p95": pct(lats, 0.95), "mean": round(statistics.mean(lats), 3) if lats else 0.0}, "cases": cases_out}
    RESULTS_PATH.write_text(format_report_json(report), encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} fsa={fsa_count} errors={errors} timeouts={timeouts}")
    return report

def verify_cached() -> None:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15360 and chr(8212) not in raw and chr(8211) not in raw and chr(35) not in raw and ("base" + "64") not in raw.lower() and "/9j/" not in raw
    data, (_, _, p_sha, s_sha) = json.loads(raw), load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL and data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12 and data["confident_wrong_dose_count"] == 0 and data["false_safe_allergen_count"] == 0
    with tempfile.TemporaryDirectory(prefix="holdup_verify_ml_eu_", dir=temp_root()) as tmp:
        for idx, c in enumerate(CASES, start=1): assert len(render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")) > 1000
    for spec, row, vd in zip(CASES, data["cases"], run_safety_bridge([{"read": r["read"], "profile": PROFILE, "now": NOW_ISO} for r in data["cases"]])):
        assert row["id"] == spec["id"] and row["language"] == spec["language"] and vd["level"] == row["actual_level"] and ((row["actual_level"] == row["expected_level"]) is row["passed"])
        assert not is_cw_dose(spec, row["strength_read"], float(row["strength_conf"]), vd["level"]) and not is_false_safe_allergen(spec, vd["level"], vd["reasons"])
    assert sum(1 for r in data["cases"] if r["passed"]) == data["pass_count"]
    print(f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} cw_dose={data['confident_wrong_dose_count']} bytes={len(raw.encode('utf-8'))}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true"); ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args(); verify_cached() if args.verify_cached else run_live(args.workers)
