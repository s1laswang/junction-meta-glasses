import argparse, base64, concurrent.futures, datetime, hashlib, io, json, math, os, pathlib, random, re, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE = "orientation_blind_hold"
MODEL = "gemini-3.8-flash"
EVAL_NOW = "2026-11-14T12:00:00+02:00"
QUESTION = "Read this label."
STRENGTH_MIN_CONF = 0.8
SUITE_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SUITE_DIR.parent.parent.parent
PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
SAFETY_TS = REPO_ROOT / "server" / "src" / "safety.ts"
BRIDGE_MTS = REPO_ROOT / "eval" / "safety_bridge.mts"
RESULTS_PATH = SUITE_DIR / "results.json"
EM_DASH, EN_DASH = chr(0x2014), chr(0x2013)

PROFILE = {
    "lang": "en",
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"], "barcode": "6416542002149", "gtin": "06416542002149", "notes": "Blood pressure"},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"], "barcode": "6416542003375", "gtin": "06416542003375", "notes": "Diabetes, with food"},
        {"id": "atorvastatin", "name": "Atorvastatin", "ingredient": "atorvastatin", "strength": "20 mg", "schedule": ["evening"], "barcode": "6416542004860", "gtin": "06416542004860", "notes": "Cholesterol"},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
}

EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"]
EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"]
EAN_P = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]

CASES = [
    {"id": "or_01", "scenario": "upside_down_180_amlodipine_5mg_match", "cat": "upside_down_180", "rot": 180, "persp": False, "style": "med", "exp": "match", "exp_s": "5 mg", "seed": 301, "acc": (20, 108, 142), "hdr": "ORION PHARMA    Vnr 08 44 12", "title": "Amlodipin", "sub": "Active substance: amlodipine (amlodipiini)", "str": "5 mg", "form": "tablets", "pack": "1 tablet every evening    30 tablets", "exp_txt": "EXP 2027-10", "desc": "Amlodipin 5 mg held upside-down (180 deg) matches evening med"},
    {"id": "or_02", "scenario": "sideways_90_cw_amlodipine_5mg_match", "cat": "sideways_90_cw", "rot": 90, "persp": False, "style": "med", "exp": "match", "exp_s": "5 mg", "seed": 302, "acc": (20, 108, 142), "hdr": "ORION PHARMA    Vnr 08 44 12", "title": "Amlodipin", "sub": "Active substance: amlodipine (amlodipiini)", "str": "5 mg", "form": "tablets", "pack": "1 tablet every evening    30 tablets", "exp_txt": "EXP 2027-10", "desc": "Amlodipin 5 mg held sideways (90 deg CW) matches evening med"},
    {"id": "or_03", "scenario": "sideways_270_cw_amlodipine_5mg_match", "cat": "sideways_270_cw", "rot": 270, "persp": False, "style": "med", "exp": "match", "exp_s": "5 mg", "seed": 303, "acc": (20, 108, 142), "hdr": "ORION PHARMA    Vnr 08 44 12", "title": "Amlodipin", "sub": "Active substance: amlodipine (amlodipiini)", "str": "5 mg", "form": "tablets", "pack": "1 tablet every evening    30 tablets", "exp_txt": "EXP 2027-10", "desc": "Amlodipin 5 mg held sideways (270 deg CW) matches evening med"},
    {"id": "or_04", "scenario": "upside_down_180_burana_400mg_nsaid_warning", "cat": "upside_down_180", "rot": 180, "persp": False, "style": "med", "exp": "warning", "exp_s": "400 mg", "seed": 304, "acc": (188, 34, 44), "hdr": "ORION PHARMA    Vnr 01 66 40", "title": "Burana", "sub": "Vaikuttava aine: ibuprofeeni (ibuprofen)", "str": "400 mg", "form": "tabletti", "pack": "Pain and fever relief    30 tablettia", "exp_txt": "EXP 2027-11", "desc": "Burana 400 mg held upside-down (180 deg) triggers NSAID avoid warning"},
    {"id": "or_05", "scenario": "sideways_90_cw_metformin_expired_warning", "cat": "sideways_90_cw", "rot": 90, "persp": False, "style": "med", "exp": "warning", "exp_s": "500 mg", "seed": 305, "acc": (34, 86, 162), "hdr": "SANDOZ    Vnr 41 19 05", "title": "Metformin", "sub": "Active substance: metformin hydrochloride", "str": "500 mg", "form": "film-coated tablets", "pack": "Oral use    100 tablets", "exp_txt": "EXP 2025-03", "alert": True, "desc": "Metformin 500 mg expired 2025-03 held sideways (90 deg CW) triggers warning"},
    {"id": "or_06", "scenario": "upside_down_180_hazelnut_peanut_bar_warning", "cat": "upside_down_180", "rot": 180, "persp": False, "style": "food", "exp": "warning", "exp_s": None, "seed": 306, "acc": (122, 62, 30), "fill": (248, 240, 226), "hdr": "NORDIC SNACK KITCHEN", "title": "Hazelnut Crunch Bar", "sub": "Roasted Nut and Oat Snack Bar    55 g", "ing": ["Ingredients: rolled oats, roasted", "hazelnuts (18%), peanuts (12%), honey."], "alg": ["Allergens: contains hazelnuts, peanuts."], "has_alg": True, "exp_txt": "Best before: 2027-09", "wt": "55 g", "desc": "Hazelnut and peanut bar upside-down (180 deg) triggers allergy warning"},
    {"id": "or_07", "scenario": "sideways_270_cw_oat_drink_safe_info", "cat": "sideways_270_cw", "rot": 270, "persp": False, "style": "food", "exp": "info", "exp_s": None, "seed": 307, "acc": (36, 106, 124), "fill": (243, 248, 249), "hdr": "NORDIC PLANT DAIRY", "title": "Nordic Oat Drink", "sub": "Gluten-Free Plant Drink    1 L", "ing": ["Ingredients: water, gluten-free oats", "(10%), rapeseed oil, sea salt."], "alg": ["Allergens: none (nut-free, peanut-free)."], "has_alg": False, "exp_txt": "Best before: 2027-11", "wt": "1 L", "desc": "Nut-free oat drink sideways (270 deg CW) returns safe info verdict"},
    {"id": "or_08", "scenario": "tilted_32_persp_amlodipine_10mg_wrong_strength", "cat": "tilted_32_perspective", "rot": 32, "persp": True, "style": "med", "exp": "warning", "exp_s": "10 mg", "seed": 308, "acc": (42, 74, 152), "hdr": "NORDIC GENERICS    Vnr 52 10 88", "title": "Amlodipin", "sub": "Active substance: amlodipine", "str": "10 mg", "form": "tablets", "pack": "Oral use    30 tablets", "exp_txt": "EXP 2027-10", "desc": "Amlodipin 10 mg tilted 32 deg with perspective triggers wrong-strength warning"},
    {"id": "or_09", "scenario": "upside_down_180_thumb_over_strength_unsure", "cat": "upside_down_180", "rot": 180, "persp": False, "style": "med", "exp": "unsure", "exp_s": None, "seed": 309, "acc": (20, 108, 142), "hdr": "ORION PHARMA    Vnr 08 44 12", "title": "Amlodipin", "sub": "Active substance: amlodipine (amlodipiini)", "str": None, "form": "tabletti", "pack": "Oral use    30 tablettia", "exp_txt": "EXP 2027-10", "thumb": True, "desc": "Amlodipin upside-down (180 deg) with thumb occluding strength abstains to unsure"},
    {"id": "or_10", "scenario": "upside_down_180_rear_barcode_only_unsure", "cat": "upside_down_180", "rot": 180, "persp": False, "style": "barcode", "exp": "unsure", "exp_s": None, "seed": 310, "ean": "6432100099111", "desc": "Upside-down (180 deg) blank rear carton with unknown barcode only returns unsure"},
    {"id": "or_11", "scenario": "oblique_152_persp_atorvastatin_20mg_match", "cat": "oblique_152_perspective", "rot": 152, "persp": True, "style": "med", "exp": "match", "exp_s": "20 mg", "seed": 311, "acc": (96, 52, 138), "hdr": "KRKA    Vnr 48 22 19", "title": "Atorvastatin", "sub": "Active substance: atorvastatin (atorvastatiini)", "str": "20 mg", "form": "film-coated tablets", "pack": "1 tablet in the evening    30 tablets", "exp_txt": "EXP 2028-04", "desc": "Atorvastatin 20 mg oblique upside-down (152 deg + perspective) matches evening med"},
    {"id": "or_12", "scenario": "sideways_90_cutoff_blind_hold_unsure", "cat": "sideways_cutoff_blind_hold", "rot": 90, "persp": False, "style": "med", "exp": "unsure", "exp_s": None, "seed": 312, "acc": (34, 86, 162), "hdr": "SANDOZ", "title": "Metformin", "sub": "", "str": None, "form": "", "pack": "", "exp_txt": "", "offset": (-255, 655), "desc": "Sideways (90 deg) edge-clipped blind hold with cut-off name and missing strength returns unsure"},
]

def scrub(v):
    if isinstance(v, str):
        return re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED]", v.replace(EM_DASH, " - ").replace(EN_DASH, "-"))
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, dict):
        return {str(k): scrub(val) for k, val in v.items()}
    return v

def load_env():
    cands = [pathlib.Path(os.environ["HOLDUP_ENV_FILE"])] if os.environ.get("HOLDUP_ENV_FILE") else []
    for p in (*cands, REPO_ROOT / ".env", pathlib.Path.home() / "junction-meta-glasses" / ".env", pathlib.Path.home() / "momin" / ".env"):
        if not p.is_file():
            continue
        proc = subprocess.run(["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(p)], capture_output=True, timeout=5)
        if proc.returncode == 0:
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k, val = chunk.split(b"=", 1)
                    ks = k.decode("utf-8", errors="ignore")
                    if ks and ks not in os.environ:
                        os.environ[ks] = val.decode("utf-8", errors="ignore")

def inline_refs(node, defs=None):
    if defs is None and isinstance(node, dict):
        defs = node.get("$defs") or {}
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str):
            return inline_refs(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node

def solve8(a, b):
    m = [row[:] + [ rhs ] for row, rhs in zip(a, b)]
    for col in range(8):
        piv = max(range(col, 8), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        div = m[col][col]
        for j in range(col, 9):
            m[col][j] /= div
        for r in range(8):
            if r != col and m[r][col] != 0:
                f = m[r][col]
                for j in range(col, 9):
                    m[r][j] -= f * m[col][j]
    return [m[i][8] for i in range(8)]

def fit_font(draw, text, max_w, start_sz, min_sz=16):
    sz = start_sz
    while sz > min_sz:
        f = ImageFont.load_default(size=sz)
        if draw.textlength(text, font=f) <= max_w:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_sz)

def render_case(c):
    rng = random.Random(c["seed"])
    if c["style"] == "med":
        bw, bh = 540, 390
        card = Image.new("RGB", (bw, bh), (250, 251, 253))
        cd = ImageDraw.Draw(card)
        cd.rectangle((0, 0, bw, 58), fill=c["acc"])
        cd.text((28, 17), c["hdr"], fill=(246, 249, 252), font=fit_font(cd, c["hdr"], bw - 56, 21))
        cd.text((28, 76), c["title"], fill=(14, 20, 28), font=fit_font(cd, c["title"], bw - 56, 46), stroke_width=1, stroke_fill=(14, 20, 28))
        if c["sub"]:
            cd.text((28, 136), c["sub"], fill=(48, 56, 68), font=fit_font(cd, c["sub"], bw - 56, 23))
        if c["str"] is not None or c.get("thumb"):
            cd.rounded_rectangle((28, 182, 246, 258), radius=10, fill=(239, 245, 251), outline=c["acc"], width=3)
        if c["str"] is not None:
            cd.text((46, 196), c["str"], fill=(12, 18, 26), font=fit_font(cd, c["str"], 186, 44), stroke_width=1, stroke_fill=(12, 18, 26))
        if c["form"]:
            cd.text((266, 206), c["form"], fill=(34, 42, 52), font=fit_font(cd, c["form"], bw - 290, 25))
        if c["pack"]:
            cd.text((28, 282), c["pack"], fill=(50, 58, 68), font=fit_font(cd, c["pack"], bw - 56, 22))
        if c["exp_txt"]:
            fe = fit_font(cd, c["exp_txt"], 260, 25)
            ex0 = max(28, bw - int(cd.textlength(c["exp_txt"], font=fe)) - 64)
            alert = c.get("alert", False)
            cd.rounded_rectangle((ex0, 322, bw - 28, 372), radius=8, fill=(254, 240, 240) if alert else (242, 245, 248), outline=(182, 42, 42) if alert else (160, 168, 178), width=2)
            cd.text((ex0 + 18, 334), c["exp_txt"], fill=(156, 20, 20) if alert else (18, 24, 30), font=fe, stroke_width=1 if alert else 0, stroke_fill=(156, 20, 20))
    elif c["style"] == "food":
        bw, bh = 470, 540
        card = Image.new("RGB", (bw, bh), c["fill"])
        cd = ImageDraw.Draw(card)
        cd.rectangle((0, 0, bw, 64), fill=c["acc"])
        cd.text((26, 20), c["hdr"], fill=(248, 250, 248), font=fit_font(cd, c["hdr"], bw - 52, 21))
        cd.text((26, 82), c["title"], fill=(20, 30, 26), font=fit_font(cd, c["title"], bw - 52, 38), stroke_width=1, stroke_fill=(20, 30, 26))
        cd.text((26, 134), c["sub"], fill=(56, 66, 62), font=fit_font(cd, c["sub"], bw - 52, 22))
        pb = 240 + len(c["ing"]) * 32 + len(c["alg"]) * 30 + 20
        cd.rounded_rectangle((24, 180, bw - 24, pb), radius=12, fill=(253, 252, 249), outline=(182, 176, 164), width=2)
        iy = 198
        for ln in c["ing"]:
            cd.text((38, iy), ln, fill=(22, 26, 26), font=fit_font(cd, ln, bw - 80, 22))
            iy += 32
        iy += 10
        ha = c["has_alg"]
        cd.rounded_rectangle((36, iy, bw - 36, iy + 20 + len(c["alg"]) * 30), radius=8, fill=(255, 242, 230) if ha else (238, 247, 244), outline=(196, 112, 54) if ha else (92, 148, 132), width=2)
        for idx, ln in enumerate(c["alg"]):
            ink = (112, 34, 16) if ha else (22, 62, 52)
            cd.text((48, iy + 10 + idx * 30), ln, fill=ink, font=fit_font(cd, ln, bw - 96, 22), stroke_width=1, stroke_fill=ink)
        cd.rounded_rectangle((24, pb + 18, bw - 24, pb + 72), radius=8, fill=(255, 255, 255), outline=(190, 186, 176), width=2)
        cd.text((38, pb + 32), c["exp_txt"], fill=(18, 24, 26), font=fit_font(cd, c["exp_txt"], bw - 80, 24))
        cd.text((28, bh - 46), c["wt"], fill=(54, 66, 60), font=ImageFont.load_default(size=24))
    else:
        bw, bh = 540, 390
        card = Image.new("RGB", (bw, bh), (244, 243, 238))
        cd = ImageDraw.Draw(card)
        digits = c["ean"]
        par = EAN_P[int(digits[0])]
        bits = "101" + "".join(EAN_L[int(digits[i + 1])] if par[i] == "L" else EAN_G[int(digits[i + 1])] for i in range(6)) + "01010" + "".join(EAN_R[int(digits[i + 7])] for i in range(6)) + "101"
        px0, py0 = (bw - 348) // 2, (bh - 186) // 2
        cd.rounded_rectangle((px0, py0, px0 + 348, py0 + 186), radius=8, fill=(255, 255, 255), outline=(206, 204, 198), width=2)
        bx0 = px0 + (348 - len(bits) * 3) // 2
        for idx, bit in enumerate(bits):
            if bit == "1":
                cd.rectangle((bx0 + idx * 3, py0 + 22, bx0 + idx * 3 + 2, py0 + 126 + (10 if idx < 3 or 45 <= idx < 50 or idx >= 92 else 0)), fill=(12, 14, 18))
        fn = ImageFont.load_default(size=30)
        cd.text((int(px0 + (348 - cd.textlength(digits, font=fn)) / 2), py0 + 142), digits, fill=(12, 14, 18), font=fn, stroke_width=1, stroke_fill=(12, 14, 18))

    w, h = card.size
    rgba = card.convert("RGBA")
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=16, fill=255)
    rgba.putalpha(mask)
    ImageDraw.Draw(rgba).rounded_rectangle((0, 0, w - 1, h - 1), radius=16, outline=(170, 176, 184, 255), width=3)
    if c["persp"]:
        src = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
        dst = [(18.0, 10.0), (float(w - 20), 34.0), (float(w - 34), float(h - 32)), (10.0, float(h - 12))]
        mat, rhs = [], []
        for (u, v), (x, y) in zip(src, dst):
            mat += [[x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u], [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v]]
            rhs += [u, v]
        rgba = rgba.transform((w, h), Image.Transform.PERSPECTIVE, solve8(mat, rhs), resample=Image.Resampling.BICUBIC)
    rot = c["rot"]
    if not c["persp"] and rot in (90, 180, 270):
        tmap = {180: Image.Transpose.ROTATE_180, 90: Image.Transpose.ROTATE_270, 270: Image.Transpose.ROTATE_90}
        rgba = rgba.transpose(tmap[rot])
    else:
        rgba = rgba.rotate(-float(rot), resample=Image.Resampling.BICUBIC, expand=True)

    bg = Image.new("RGBA", (768, 768), (222, 214, 202, 255))
    bd = ImageDraw.Draw(bg)
    for y in range(768):
        s = rng.randint(-2, 2) if y >= 548 else 0
        col = (int(232 - 24 * (y / 548)), int(227 - 22 * (y / 548)), int(218 - 20 * (y / 548)), 255) if y < 548 else (178 + s, 148 + s, 114 + s, 255)
        bd.line((0, y, 768, y), fill=col)
    ox, oy = c.get("offset", ((768 - rgba.size[0]) // 2, (768 - rgba.size[1]) // 2))
    sh = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    sp = Image.new("RGBA", rgba.size, (22, 18, 14, 108))
    sp.putalpha(rgba.getchannel("A"))
    sh.paste(sp, (ox + 12, oy + 16), sp)
    comp = Image.alpha_composite(bg, sh.filter(ImageFilter.GaussianBlur(radius=12.0)))
    comp.paste(rgba, (ox, oy), rgba)
    if c.get("thumb"):
        th = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(th)
        td.rounded_rectangle((392, 310, 824, 408), radius=50, fill=(208, 162, 136, 255), outline=(168, 122, 98, 255), width=3)
        td.rounded_rectangle((408, 326, 476, 392), radius=20, fill=(236, 206, 192, 255), outline=(188, 146, 126, 255), width=2)
        comp = Image.alpha_composite(comp, th.filter(ImageFilter.GaussianBlur(radius=0.7)))
    return comp.convert("RGB")

def to_label_read(j):
    clamp = lambda x: max(0.0, min(1.0, float(x))) if isinstance(x, (int, float)) else 0.0
    is_s = lambda v: isinstance(v, str) and v.strip() != ""
    is_a = lambda v: isinstance(v, list) and all(isinstance(s, str) for s in v)
    def fld(x, ok):
        v = x.get("value") if isinstance(x, dict) and ok(x.get("value")) else None
        conf = clamp(x.get("confidence") if isinstance(x, dict) else 0.0)
        return {"value": v, "confidence": min(conf, 0.3) if v is None else conf}
    j = j if isinstance(j, dict) else {}
    r = {
        "kind": j.get("kind") if j.get("kind") in ("medication", "food", "other", "unreadable") else "unreadable",
        "product": fld(j.get("product"), is_s), "ingredient": fld(j.get("ingredient"), is_s),
        "strength": fld(j.get("strength"), is_s), "dosing": fld(j.get("dosing"), is_s),
        "expiry": fld(j.get("expiry"), is_s), "allergens": fld(j.get("allergens"), is_a),
        "barcode": fld(j.get("barcode"), is_s), "readability": clamp(j.get("readability")),
    }
    if is_s(j.get("guidance")):
        r["guidance"] = j["guidance"].strip()[:120]
    if r["expiry"]["value"] and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", r["expiry"]["value"]):
        r["expiry"]["confidence"] = min(r["expiry"]["confidence"], 0.5)
    return scrub(r)

def call_gemini(b64_jpg, prompt, schema, api_key):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler())
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    body = json.dumps({
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64_jpg}}, {"text": QUESTION}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema, "thinkingConfig": {"thinkingLevel": "LOW"}, "maxOutputTokens": 4096},
    }).encode("utf-8")
    timed_out = 0
    for att in range(4):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, method="POST")
            with opener.open(req, timeout=45) as resp:
                dt = time.perf_counter() - t0
                data = json.loads(resp.read().decode("utf-8"))
            parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            txt = next((p["text"].strip() for p in parts if p.get("text") and not p.get("thought") and p["text"].strip()), "")
            if txt:
                return to_label_read(json.loads(txt)), dt, timed_out, None
        except urllib.error.HTTPError as e:
            if e.code not in (408, 429, 500, 502, 503, 504) or att == 3:
                return to_label_read({}), time.perf_counter() - t0, timed_out, scrub(f"HTTP {e.code}")
        except (TimeoutError, socket.timeout):
            timed_out += 1
            if att == 3:
                return to_label_read({}), time.perf_counter() - t0, timed_out, "timeout"
        except Exception as e:
            if att == 3:
                return to_label_read({}), time.perf_counter() - t0, timed_out, scrub(str(e)[:160])
        time.sleep(1.2 * (2 ** att))
    return to_label_read({}), 0.0, timed_out, "empty_response"

def run_safety_bridge(reads):
    env = dict(os.environ, HOLDUP_SAFETY_TS=str(SAFETY_TS))
    extra = [p for p in ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin") if os.path.isdir(p)]
    env["PATH"] = ":".join(extra + ([env["PATH"]] if env.get("PATH") else []))
    node = shutil.which("node", path=env["PATH"])
    if not node:
        raise RuntimeError("node not found for safety_bridge.mts")
    payload = "\n".join(json.dumps({"read": r, "profile": PROFILE, "now": EVAL_NOW}) for r in reads) + "\n"
    proc = subprocess.run([node, "--import", "tsx", str(BRIDGE_MTS)], cwd=str(REPO_ROOT), env=env, input=payload, text=True, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed: {proc.stderr[:300]}")
    outs = [scrub(json.loads(ln)) for ln in proc.stdout.splitlines() if ln.strip()]
    if len(outs) != len(reads) or any(o.get("level") == "error" for o in outs):
        raise RuntimeError(f"invalid safety_bridge output: {outs[:2]}")
    return outs

def wilson(k, n):
    z = 1.959963984540054
    z2 = z * z
    p = k / n
    den = 1.0 + z2 / n
    ctr = (p + z2 / (2.0 * n)) / den
    hlf = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / den
    return [max(0.0, round(ctr - hlf, 4)), min(1.0, round(ctr + hlf, 4))]

def norm_mg(s):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(mg|g|mcg|ug|mikrog)\b", (s or "").lower())
    if not m:
        return None
    val = float(m.group(1).replace(",", "."))
    u = m.group(2)
    return round(val * (1000.0 if u == "g" else 0.001 if u in ("mcg", "ug", "mikrog") else 1.0), 6)

def ensure_shm_tmpdir():
    shm = pathlib.Path("/dev/shm")
    if not os.environ.get("TMPDIR") and shm.is_dir() and os.access(shm, os.W_OK):
        os.environ["TMPDIR"] = str(shm)
        tempfile.tempdir = str(shm)

def format_report(doc):
    head = {k: v for k, v in doc.items() if k != "cases"}
    txt = json.dumps(head, ensure_ascii=False, indent=2)[:-2] + ',\n  "cases": [\n'
    txt += ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in doc["cases"]) + "\n  ]\n}\n"
    return txt

def verify_cached(p_sha, s_sha, ps_12):
    src_txt = pathlib.Path(__file__).read_text("utf-8")
    assert chr(35) not in src_txt and EM_DASH not in src_txt and EN_DASH not in src_txt
    assert not re.search(r"AIza[0-9A-Za-z_-]{20,}", src_txt)
    raw_bytes = RESULTS_PATH.read_bytes()
    assert len(raw_bytes) < 15000, f"results.json too large: {len(raw_bytes)} bytes"
    raw_txt = raw_bytes.decode("utf-8")
    assert len(raw_txt.splitlines()) < 200, f"results.json too many lines: {len(raw_txt.splitlines())}"
    assert chr(35) not in raw_txt and EM_DASH not in raw_txt and EN_DASH not in raw_txt
    assert "data:image" not in raw_txt and "base64" not in raw_txt.lower()
    assert not re.search(r"AIza[0-9A-Za-z_-]{20,}", raw_txt)
    data = json.loads(raw_txt)
    assert data["suite"] == SUITE and data["model"] == MODEL and data["thinking_level"] == "low"
    assert data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha and data["prompt_sha256_12"] == ps_12
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    with tempfile.TemporaryDirectory(prefix="holdup_verify_orient_") as td:
        td_path = pathlib.Path(td)
        for c in CASES:
            buf = io.BytesIO()
            render_case(c).save(buf, format="JPEG", quality=90)
            jpg = buf.getvalue()
            out_p = td_path / f"{c['id']}.jpg"
            out_p.write_bytes(jpg)
            assert out_p.is_file() and len(jpg) > 1000
    outs = run_safety_bridge([c["read"] for c in data["cases"]])
    for c, o in zip(data["cases"], outs):
        if c["actual_level"] != o["level"] or c["predicted_level"] != o["level"]:
            raise SystemExit(f"mismatch on {c['id']}: {c['actual_level']} != {o['level']}")
        assert c["reasons"] == o["reasons"]
        assert c["verdict_ok"] == (c["actual_level"] == c["expected_level"])
    s = data["summary"]
    assert data["pass_count"] == s["verdict_matches"] == sum(1 for c in data["cases"] if c["passed"])
    assert data["confident_wrong_dose_count"] == s["confident_wrong_count"] == sum(1 for c in data["cases"] if c["confident_wrong"])
    assert s["false_match_count"] == sum(1 for c in data["cases"] if c["false_match"])
    assert s["unsafe_reassurance_count"] == sum(1 for c in data["cases"] if c["expected_level"] == "warning" and c["actual_level"] in ("match", "info"))
    assert s["abstain_or_unsure_count"] == sum(1 for c in data["cases"] if c["actual_level"] == "unsure")
    print(json.dumps({"suite": SUITE, "verified": len(outs), "pass_count": data["pass_count"], "n": data["n"], "confident_wrong_dose_count": data["confident_wrong_dose_count"]}, indent=2))
    return 0

def main():
    ensure_shm_tmpdir()
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", "--offline", dest="verify_cached", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--out-dir", type=str, default="")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    prompt_txt, schema_txt = PROMPT_PATH.read_text("utf-8"), SCHEMA_PATH.read_text("utf-8")
    p_sha = hashlib.sha256(prompt_txt.encode("utf-8")).hexdigest()
    s_sha = hashlib.sha256(schema_txt.encode("utf-8")).hexdigest()
    ps_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]

    if args.verify_cached:
        return verify_cached(p_sha, s_sha, ps_12)

    if args.render_only:
        out_dir = pathlib.Path(args.out_dir) if args.out_dir else (pathlib.Path(tempfile.gettempdir()) / "holdup_orientation_blind_hold")
        out_dir.mkdir(parents=True, exist_ok=True)
        for c in CASES:
            buf = io.BytesIO()
            render_case(c).save(buf, format="JPEG", quality=90)
            (out_dir / f"{c['id']}.jpg").write_bytes(buf.getvalue())
        print(json.dumps({"rendered": len(CASES), "out_dir": str(out_dir)}, indent=2))
        return 0

    load_env()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY not set")
    schema = inline_refs(json.loads(schema_txt))
    with tempfile.TemporaryDirectory(prefix="holdup_orient_") as tmp:
        b64s = []
        for c in CASES:
            buf = io.BytesIO()
            render_case(c).save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            (pathlib.Path(tmp) / f"{c['id']}.jpg").write_bytes(raw)
            b64s.append(base64.b64encode(raw).decode("ascii"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(3, args.workers))) as ex:
            api_res = list(ex.map(lambda b: call_gemini(b, prompt_txt, schema, api_key), b64s))

    reads = [r[0] for r in api_res]
    verdicts = run_safety_bridge(reads)
    cases_out, errors, timeouts = [], 0, 0
    for c, (rd, dt, to_cnt, err), vd in zip(CASES, api_res, verdicts):
        timeouts += to_cnt
        if err:
            errors += 1
        act = vd["level"]
        exp = c["exp"]
        s_val, s_conf = rd["strength"]["value"], round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(max(rd["ingredient"]["confidence"] if rd["ingredient"]["value"] else 0.0, rd["product"]["confidence"] if rd["product"]["value"] else 0.0), 4)
        if c["exp_s"] is not None:
            s_ok = s_val is not None and norm_mg(s_val) == norm_mg(c["exp_s"])
            cwd = bool((s_conf >= STRENGTH_MIN_CONF and not s_ok) or (act == "match" and exp != "match"))
        else:
            cwd = bool((s_val is not None and s_conf >= STRENGTH_MIN_CONF) or (act == "match" and exp != "match"))
        fm = bool(act == "match" and exp != "match")
        ok = bool(act == exp and not cwd and err is None)
        cases_out.append({
            "id": c["id"], "scenario": c["scenario"], "category": c["cat"], "description": c["desc"], "question": QUESTION,
            "expected_level": exp, "actual_level": act, "predicted_level": act, "passed": ok, "verdict_ok": act == exp,
            "strength_read": s_val, "strength_conf": s_conf, "name_conf": n_conf, "readability": round(float(rd["readability"]), 4),
            "confident_wrong": cwd, "false_match": fm, "latency_s": round(dt, 3), "latency_ms": round(dt * 1000.0, 1),
            "error": err, "reasons": vd["reasons"], "read": rd,
        })

    n = len(cases_out)
    pc = sum(1 for x in cases_out if x["passed"])
    cwd_c = sum(1 for x in cases_out if x["confident_wrong"])
    lats = sorted(x["latency_ms"] for x in cases_out)
    q = lambda p: round(lats[int((len(lats) - 1) * p)], 1)
    p_ci, c_ci = wilson(pc, n), wilson(cwd_c, n)
    report = scrub({
        "suite": SUITE, "model": MODEL, "thinking_level": "low",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "eval_now_iso": EVAL_NOW,
        "prompt_source": "shared/verify_prompt.md+shared/label_schema.json",
        "prompt_sha256": p_sha, "schema_sha256": s_sha, "prompt_sha256_12": ps_12, "safety_module": "server/src/safety.ts",
        "n": n, "errors": errors, "timeouts": timeouts,
        "pass_count": pc, "pass_rate": round(pc / n, 4), "pass_ci95_wilson": p_ci,
        "confident_wrong_dose_count": cwd_c, "confident_wrong_dose_rate": round(cwd_c / n, 4),
        "confident_wrong_dose_ci95_wilson": c_ci, "rule_of_three_95_upper": round(3.0 / n, 4),
        "profile": PROFILE,
        "summary": {
            "n_cases": n, "errors": errors, "timeouts": timeouts, "verdict_matches": pc, "verdict_accuracy": round(pc / n, 4),
            "verdict_accuracy_ci95": p_ci, "confident_wrong_count": cwd_c, "confident_wrong_dose_count": cwd_c,
            "confident_wrong_rate": round(cwd_c / n, 4), "confident_wrong_ci95": c_ci,
            "false_match_count": sum(1 for x in cases_out if x["false_match"]),
            "unsafe_reassurance_count": sum(1 for x in cases_out if x["expected_level"] == "warning" and x["actual_level"] in ("match", "info")),
            "abstain_or_unsure_count": sum(1 for x in cases_out if x["actual_level"] == "unsure"),
            "latency_p50_ms": q(0.5), "latency_p95_ms": q(0.95),
        },
        "cases": cases_out,
    })
    txt = format_report(report)
    RESULTS_PATH.write_text(txt, encoding="utf-8")
    print(json.dumps({"suite": SUITE, "n": n, "pass_count": pc, "confident_wrong_dose_count": cwd_c, "bytes": len(txt.encode("utf-8"))}, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
