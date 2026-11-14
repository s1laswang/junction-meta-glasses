from __future__ import annotations

import argparse, hashlib, io, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE, MODEL, CONF_T, NOW_ISO = "back_of_box_barcode", "gemini-3.8-flash", 0.8, "2026-11-14T12:00:00+02:00"
REPO = Path(__file__).resolve().parents[3]
RESULTS_PATH = Path(__file__).resolve().parent / "results.json"

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
        {"id": "bisoprolol", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]},
    ],
    "allergies": ["tree nuts", "peanut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CASES_SPEC: list[dict[str, Any]] = [
    {"id": "bb_01", "sc": "ean13_only_white_back_abstains", "q": "Is this my evening pill?", "world": "match", "exp": "unsure", "ing": "amlodipine", "str": None, "ean": "6432100084410"},
    {"id": "bb_02", "sc": "gs1_datamatrix_fmd_back_no_name_abstains", "q": "Is this my morning bisoprolol?", "world": "match", "exp": "unsure", "ing": "bisoprolol", "str": None, "ean": "06432100012345"},
    {"id": "bb_03", "sc": "back_panel_ingredient_only_missing_strength_abstains", "q": "Is this my evening pill?", "world": "match", "exp": "unsure", "ing": "amlodipine", "str": None, "ean": "6432100084412"},
    {"id": "bb_04", "sc": "food_barcode_flap_missing_allergens_abstains", "q": "Does this contain peanuts or tree nuts?", "world": "warning", "exp": "unsure", "ing": None, "str": None, "ean": "6410405112233"},
    {"id": "bb_05", "sc": "finnish_back_composition_amlodipine_5mg_matches", "q": "Is this my evening pill?", "world": "match", "exp": "match", "ing": "amlodipine", "str": "5 mg", "ean": "6432100084412"},
    {"id": "bb_06", "sc": "swedish_pharmacy_sticker_back_bisoprolol_matches", "q": "Is this my morning pill?", "world": "match", "exp": "match", "ing": "bisoprolol", "str": "2.5 mg", "ean": "7046260491120"},
    {"id": "bb_07", "sc": "food_back_ingredients_barcode_crispbread_safe_info", "q": "Is this safe with my nut allergies?", "world": "info", "exp": "info", "ing": None, "str": None, "ean": "6410405008819"},
    {"id": "bb_08", "sc": "back_composition_wrong_strength_amlodipine_10mg_warns", "q": "Is this my evening pill?", "world": "warning", "exp": "warning", "ing": "amlodipine", "str": "10 mg", "ean": "6432100084436"},
    {"id": "bb_09", "sc": "back_active_substance_ibuprofen_nsaid_barcode_warns", "q": "Can I take this for back pain?", "world": "warning", "exp": "warning", "ing": "ibuprofen", "str": "400 mg", "ean": "6432100016640"},
    {"id": "bb_10", "sc": "back_end_stamp_expired_metformin_barcode_warns", "q": "Can I take my evening metformin from this box?", "world": "warning", "exp": "warning", "ing": "metformin", "str": "500 mg", "ean": "6432100050019"},
    {"id": "bb_11", "sc": "back_excipient_arachis_peanut_oil_capsule_warns", "q": "Is this vitamin capsule safe with my allergies?", "world": "warning", "exp": "warning", "ing": "colecalciferol", "str": "1000 IU", "ean": "6432100077214"},
    {"id": "bb_12", "sc": "finnish_food_back_may_contain_hazelnut_peanut_warns", "q": "Can I eat this dark chocolate?", "world": "warning", "exp": "warning", "ing": None, "str": None, "ean": "6410405099411"},
]


def tmp_root() -> str | None:
    env_td = os.environ.get("TMPDIR")
    if env_td and Path(env_td).is_dir() and os.access(env_td, os.W_OK): return env_td
    if Path("/dev/shm").is_dir() and os.access("/dev/shm", os.W_OK): return "/dev/shm"
    return None


def clean_str(s: Any) -> Any:
    if isinstance(s, str): return s.replace("\u2014", "-").replace("\u2013", "-").replace(chr(35), "")
    if isinstance(s, list): return [clean_str(x) for x in s]
    if isinstance(s, dict): return {k: clean_str(v) for k, v in s.items()}
    return s


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"): return
    for p in (Path.home() / "momin" / ".env", REPO / ".env", Path.home() / "junction-meta-glasses" / ".env"):
        if p.is_file():
            proc = subprocess.run(["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(p)], capture_output=True, check=False)
            if proc.returncode == 0:
                for chunk in proc.stdout.split(b"\x00"):
                    if b"=" in chunk:
                        k, v = chunk.split(b"=", 1)
                        ks = k.decode("utf-8", errors="ignore").strip()
                        if ks: os.environ.setdefault(ks, v.decode("utf-8", errors="ignore"))
            if os.environ.get("GEMINI_API_KEY"): return
    raise RuntimeError("GEMINI_API_KEY not found")


def inline_refs(s: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None: defs = s.get("$defs", {}) if isinstance(s, dict) else {}
    if isinstance(s, list): return [inline_refs(x, defs) for x in s]
    if isinstance(s, dict):
        if isinstance(s.get("$ref"), str): return inline_refs(defs[s["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in s.items() if k not in ("$defs", "$comment")}
    return s


def load_prompt_schema() -> tuple[str, dict[str, Any], str, str, str]:
    p_txt = (REPO / "shared" / "verify_prompt.md").read_text(encoding="utf-8")
    s_txt = (REPO / "shared" / "label_schema.json").read_text(encoding="utf-8")
    return (p_txt, inline_refs(json.loads(s_txt)), hashlib.sha256((p_txt + s_txt).encode("utf-8")).hexdigest()[:12],
            hashlib.sha256(p_txt.encode("utf-8")).hexdigest(), hashlib.sha256(s_txt.encode("utf-8")).hexdigest())


def draw_ean13(ld: ImageDraw.ImageDraw, rng: random.Random, x0: int, x1: int, y1: int, digits: str) -> None:
    bx0, by0, bx1, by1 = (x0 + x1) // 2 - 160, y1 - 168, (x0 + x1) // 2 + 160, y1 - 24
    ld.rounded_rectangle((bx0, by0, bx1, by1), radius=8, fill=(255, 255, 255, 255), outline=(182, 188, 196, 255), width=2)
    mid_x = (bx0 + bx1) // 2
    for gx in (bx0 + 20, bx0 + 25, mid_x - 3, mid_x + 2, bx1 - 26, bx1 - 21):
        ld.rectangle((gx, by0 + 12, gx + 2, by1 - 34), fill=(12, 14, 18, 255))
    for seg_start, seg_end in ((bx0 + 32, mid_x - 8), (mid_x + 9, bx1 - 31)):
        cx = seg_start
        while cx < seg_end:
            bw = rng.choice((2, 3, 5))
            if cx + bw < seg_end:
                ld.rectangle((cx, by0 + 12, cx + bw, by1 - 42), fill=(12, 14, 18, 255))
            cx += bw + rng.choice((2, 3, 4))
    ld.text((bx0 + 50, by1 - 37), digits, fill=(12, 16, 20, 255), font=ImageFont.load_default(size=26))


def draw_datamatrix(ld: ImageDraw.ImageDraw, rng: random.Random, x: int, y: int, cells: int = 16, cell_px: int = 11) -> None:
    span = cells * cell_px
    ld.rounded_rectangle((x - 14, y - 14, x + span + 14, y + span + 14), radius=6, fill=(255, 255, 255, 255), outline=(182, 188, 196, 255), width=2)
    for r in range(cells):
        for c in range(cells):
            on = (c == 0) or (r == cells - 1) or (r == 0 and c % 2 == 0) or (c == cells - 1 and r % 2 == 1)
            if 0 < r < cells - 1 and 0 < c < cells - 1:
                on = rng.random() < 0.48
            if on:
                ld.rectangle((x + c * cell_px, y + r * cell_px, x + (c + 1) * cell_px - 1, y + (r + 1) * cell_px - 1), fill=(12, 14, 18, 255))


def make_back_card(seed: int, box: tuple[int, int, int, int], accent: tuple[int, int, int], header: str,
                   lines: list[tuple[str, int, tuple[int, int, int], int, int]], tilt: float,
                   barcode: str | None = None, datamatrix: list[str] | None = None) -> Image.Image:
    rng = random.Random(seed)
    base = Image.new("RGB", (768, 768), (192, 172, 146))
    bd = ImageDraw.Draw(base)
    for y in range(768):
        c = max(88, min(234, int(206 - 0.08 * y + rng.randint(-3, 3))))
        bd.line((0, y, 768, y), fill=(c, int(c * 0.91), int(c * 0.79)))
    layer, sh = Image.new("RGBA", (768, 768), (0, 0, 0, 0)), Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 10, y0 + 14, x1 + 14, y1 + 18), radius=14, fill=(18, 14, 10, 96))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(10)))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(box, radius=14, fill=(249, 250, 252, 255), outline=(162, 170, 178, 255), width=3)
    ld.line((x0 + 16, y0 + 64, x1 - 16, y0 + 64), fill=(214, 220, 226, 255), width=2)
    if header:
        ld.rounded_rectangle((x0, y0, x1, y0 + 56), radius=14, fill=(*accent, 255))
        ld.rectangle((x0, y0 + 28, x1, y0 + 56), fill=(*accent, 255))
        ld.text((x0 + 24, y0 + 16), header, fill=(250, 252, 255, 255), font=ImageFont.load_default(size=21))
    for txt, dy, col, sz, dx in lines:
        ld.text((x0 + dx, y0 + dy), txt, fill=(*col, 255), font=ImageFont.load_default(size=sz), stroke_width=1 if sz >= 32 else 0, stroke_fill=(*col, 255))
    if barcode:
        draw_ean13(ld, rng, x0, x1, y1, barcode)
    if datamatrix:
        draw_datamatrix(ld, rng, x0 + 44, y0 + 148)
        for idx, dm_line in enumerate(datamatrix):
            ld.text((x0 + 252, y0 + 152 + idx * 44), dm_line, fill=(16, 22, 28, 255), font=ImageFont.load_default(size=24))
    out = Image.alpha_composite(base.convert("RGBA"), layer.rotate(tilt, resample=Image.Resampling.BICUBIC))
    return out.convert("RGB")


def render_all(out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    blue, slate, teal, brown, red, green, plum = (22, 98, 146), (62, 74, 88), (24, 108, 102), (138, 78, 30), (178, 34, 42), (38, 104, 72), (96, 44, 118)
    dark, mid, warn = (14, 20, 28), (46, 54, 66), (148, 26, 22)
    box = (76, 108, 692, 660)
    cards: dict[str, Image.Image] = {
        "bb_01": make_back_card(701, box, slate, "", [], -1.8, barcode="6432100084410"),
        "bb_02": make_back_card(702, (92, 150, 676, 590), slate, "", [], 1.6,
                                datamatrix=["(01) 06432100012345", "(21) 984102938471", "LOT AB2409", "EXP 2027-10"]),
        "bb_03": make_back_card(703, box, blue, "ORION PHARMA - TAKAPANEELI", [
            ("AMLODIPIN ORION tabletti", 84, dark, 34, 26),
            ("Vaikuttava aine: amlodipiini", 142, dark, 26, 26),
            ("Sailytys alkuperaispakkauksessa valolta suojattuna.", 196, mid, 21, 26),
            ("Katso vahvuus pakkauksen etupuolelta.", 240, mid, 22, 26),
        ], -1.5, barcode="6432100084412"),
        "bb_04": make_back_card(704, box, brown, "NORDIC BAKERY - BACK FLAP", [
            ("Nordic Crisp Cookie Pack", 84, dark, 34, 26),
            ("Net weight 180 g", 140, mid, 25, 26),
            ("Ingredients and allergens: lift back flap", 196, mid, 23, 26),
            ("Sorting: plastic wrapper", 242, mid, 21, 26),
        ], 1.7, barcode="6410405112233"),
        "bb_05": make_back_card(705, box, blue, "ORION PHARMA - TAKAPANEELI", [
            ("AMLODIPIN ORION 5 mg tabletti", 82, dark, 33, 26),
            ("1 tabletti sisaltaa amlodipiinia 5 mg.", 138, dark, 25, 26),
            ("Annostus: 1 tabletti iltaisin.", 186, mid, 24, 26),
            ("Kayt. viim. 2027-11   Era 2504A", 240, dark, 26, 26),
        ], -1.3, barcode="6432100084412"),
        "bb_06": make_back_card(706, box, teal, "APOTEKETS ETIKETT - BAKSIDA", [
            ("Bisoprolol Orion 2,5 mg tablett", 82, dark, 33, 26),
            ("Verksamt amne: bisoprolol 2,5 mg", 138, dark, 25, 26),
            ("Dosering: 1 tablett pa morgonen", 186, mid, 24, 26),
            ("Utg.dat. 08/2027   Lot 2501S", 240, dark, 26, 26),
        ], 1.4, barcode="7046260491120"),
        "bb_07": make_back_card(707, box, green, "NORDIC HARVEST - BACK PANEL", [
            ("Nordic Rye & Oat Crispbread 250 g", 80, dark, 30, 26),
            ("Ingredients: wholegrain rye flour, rolled oats,", 132, dark, 23, 26),
            ("rapeseed oil, water, sea salt.", 166, dark, 23, 26),
            ("Allergens: contains rye and oats (gluten).", 212, (24, 72, 48), 24, 26),
            ("Best before: 2027-06", 262, dark, 25, 26),
        ], -1.2, barcode="6410405008819"),
        "bb_08": make_back_card(708, box, blue, "ORION PHARMA - TAKAPANEELI", [
            ("AMLODIPIN ORION 10 mg tabletti", 82, dark, 33, 26),
            ("1 tabletti sisaltaa amlodipiinia 10 mg.", 138, dark, 25, 26),
            ("Sailytys alkuperaispakkauksessa.", 186, mid, 23, 26),
            ("EXP 2027-10   Lot 2502B", 240, dark, 26, 26),
        ], 1.5, barcode="6432100084436"),
        "bb_09": make_back_card(709, box, red, "RATIOPHARM - TAKAPANEELI", [
            ("IBUPROFEN RATIOPHARM 400 mg tabletti", 82, dark, 28, 26),
            ("Vaikuttava aine: ibuprofeeni 400 mg.", 136, dark, 25, 26),
            ("Tulehduskipulaake kivun ja kuumeen hoitoon.", 184, mid, 22, 26),
            ("EXP 2027-09   Vnr 04 18 22", 238, dark, 25, 26),
        ], -1.6, barcode="6432100016640"),
        "bb_10": make_back_card(710, box, slate, "ORION PHARMA - TAKAPANEELI", [
            ("METFORMIN ORION 500 mg tabletti", 82, dark, 32, 26),
            ("Vaikuttava aine: metformiini 500 mg.", 138, dark, 25, 26),
            ("Otetaan aterian yhteydessa.", 186, mid, 23, 26),
            ("Kayt. viim. / EXP 2025-04   Lot 2304K", 240, warn, 27, 26),
        ], 1.3, barcode="6432100050019"),
        "bb_11": make_back_card(711, box, plum, "NORDIC PHARMA - BACK PANEL", [
            ("COLECALCIFEROL 1000 IU soft capsules", 80, dark, 29, 26),
            ("Active substance: colecalciferol 1000 IU.", 132, dark, 24, 26),
            ("Excipients: refined arachis oil (peanut oil),", 180, warn, 23, 26),
            ("gelatin, glycerol.   EXP 2027-12", 220, dark, 24, 26),
        ], -1.4, barcode="6432100077214"),
        "bb_12": make_back_card(712, box, brown, "NORDIC CACAO - TAKAPUOLI / BAKSIDA", [
            ("Nordic Dark Chocolate Bar (100 g)", 80, dark, 31, 26),
            ("Ainesosat: kaakaomassa, sokeri, kaakaovoi.", 134, dark, 24, 26),
            ("Saattaa sisaltaa hasselpahkinaa ja maapahkinaa.", 182, warn, 22, 26),
            ("Parasta ennen: 15.08.2027", 236, dark, 25, 26),
        ], 1.6, barcode="6410405099411"),
    }
    paths: dict[str, Path] = {}
    for cid, im in cards.items():
        p = out_dir / f"{cid}.jpg"
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        p.write_bytes(buf.getvalue())
        paths[cid] = p
    return paths


def to_label_read(j: Any) -> dict[str, Any]:
    clamp = lambda x: max(0.0, min(1.0, float(x))) if isinstance(x, (int, float)) else 0.0
    is_s = lambda v: isinstance(v, str) and v.strip() != ""
    is_a = lambda v: isinstance(v, list) and all(isinstance(s, str) for s in v)
    def fld(x: Any, ok: Any) -> dict[str, Any]:
        v = clean_str(x.get("value")) if isinstance(x, dict) and ok(x.get("value")) else None
        c = clamp(x.get("confidence") if isinstance(x, dict) else 0.0)
        return {"value": v, "confidence": round(min(c, 0.3) if v is None else c, 4)}
    if not isinstance(j, dict): j = {}
    kind = j.get("kind") if j.get("kind") in ("medication", "food", "other", "unreadable") else "unreadable"
    r = {"kind": kind, "product": fld(j.get("product"), is_s), "ingredient": fld(j.get("ingredient"), is_s), "strength": fld(j.get("strength"), is_s),
         "dosing": fld(j.get("dosing"), is_s), "expiry": fld(j.get("expiry"), is_s), "allergens": fld(j.get("allergens"), is_a),
         "barcode": fld(j.get("barcode"), is_s), "readability": round(clamp(j.get("readability")), 4)}
    if is_s(j.get("guidance")): r["guidance"] = str(clean_str(j["guidance"])).strip()[:120]
    if r["expiry"]["value"] and not re.match(r"^\d{4}-\d{2}(-\d{2})?$", r["expiry"]["value"]):
        r["expiry"]["confidence"] = min(r["expiry"]["confidence"], 0.5)
    return r


def call_gemini(frame_path: Path, question: str, prompt: str, schema: dict[str, Any]) -> tuple[dict[str, Any], float]:
    from google import genai
    from google.genai import types
    cli = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    parts: list[Any] = [types.Part.from_bytes(data=frame_path.read_bytes(), mime_type="image/jpeg"), f'The person asked: "{question}"']
    cfg = types.GenerateContentConfig(system_instruction=prompt, response_mime_type="application/json", response_json_schema=schema,
                                      thinking_config=types.ThinkingConfig(thinking_level="low"), max_output_tokens=4096)
    for attempt in range(4):
        t0 = time.time()
        try:
            resp = cli.models.generate_content(model=MODEL, contents=parts, config=cfg)
            txt = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (resp.text or "").strip())
            return to_label_read(json.loads(txt)), round(time.time() - t0, 3)
        except Exception:
            if attempt == 3: raise
            time.sleep(1.5 * (2 ** attempt))
    raise RuntimeError("unreachable")


def run_safety_bridge(cases_in: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node = next((p for p in ("/home/silas/tools/node/bin/node", "/tmp/fleet-silas/node/bin/node", shutil.which("node")) if p and Path(p).exists()), None)
    if not node: raise RuntimeError("node binary not found")
    env = dict(os.environ, HOLDUP_SAFETY_TS=str(REPO / "server" / "src" / "safety.ts"))
    payload = "\n".join(json.dumps(c, ensure_ascii=False) for c in cases_in) + "\n"
    proc = subprocess.run([node, "--import", "tsx", str(REPO / "eval" / "safety_bridge.mts")],
                          input=payload, text=True, capture_output=True, cwd=str(REPO), env=env, timeout=60, check=True)
    return [clean_str(json.loads(ln)) for ln in proc.stdout.splitlines() if ln.strip()]


def wilson(k: int, n: int) -> tuple[float, float]:
    z = 1.959963984540054; z2 = z * z; p = k / n; den = 1.0 + z2 / n
    ctr, hlf = (p + z2 / (2.0 * n)) / den, (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / den
    return max(0.0, ctr - hlf), min(1.0, ctr + hlf)


def build_specs(paths: dict[str, Path]) -> list[dict[str, Any]]:
    return [{"id": c["id"], "scenario": c["sc"], "question": c["q"], "frame": paths[c["id"]], "expected_level": c["exp"],
             "world": c["world"], "gt": {"ingredient": c["ing"], "visible_strength": c["str"], "barcode": c["ean"]}} for c in CASES_SPEC]


def pack_results(specs: list[dict[str, Any]], reads: list[tuple[dict[str, Any], float]], p_hash: str, p_sha: str, s_sha: str) -> dict[str, Any]:
    verdicts = run_safety_bridge([{"read": r, "profile": PROFILE, "now": NOW_ISO} for r, _ in reads])
    norm = lambda s: re.sub(r"\s+", " ", (s or "").strip().lower().replace(",", "."))
    cases: list[dict[str, Any]] = []
    for s, (r, dt), v in zip(specs, reads, verdicts):
        lvl, sval, sconf = v["level"], r["strength"]["value"], float(r["strength"]["confidence"])
        nconf = round(max(float(r["product"]["confidence"]), float(r["ingredient"]["confidence"])), 4)
        vs = s["gt"]["visible_strength"]
        scw = bool(sconf >= CONF_T and (vs is None or norm(sval) != norm(vs)))
        unsafe = bool(s["world"] == "warning" and lvl in ("match", "info"))
        fmatch = bool(lvl == "match" and s["expected_level"] != "match")
        ok = bool(lvl == s["expected_level"] and not scw and not unsafe and not fmatch)
        cases.append({"id": s["id"], "scenario": s["scenario"], "question": s["question"], "expected_level": s["expected_level"],
                      "predicted_level": lvl, "actual_level": lvl, "passed": ok, "verdict_ok": ok, "strength_read": sval, "strength_conf": sconf,
                      "name_conf": nconf, "readability": r["readability"], "unsafe_reassurance": unsafe, "false_match": fmatch,
                      "confident_wrong": scw, "strength_confident_wrong": scw, "latency_s": dt, "error": None, "gt": s["gt"], "read": r, "reasons": v["reasons"]})
    n, pc, cw = len(cases), sum(c["passed"] for c in cases), sum(c["strength_confident_wrong"] for c in cases)
    ur, fm, un = sum(c["unsafe_reassurance"] for c in cases), sum(c["false_match"] for c in cases), sum(c["actual_level"] == "unsure" for c in cases)
    lats = sorted(c["latency_s"] for c in cases)
    p_lo, p_hi = wilson(pc, n); cw_lo, cw_hi = wilson(cw, n); u_lo, u_hi = wilson(ur, n)
    doc: dict[str, Any] = {
        "suite": SUITE, "model": MODEL, "thinking_level": "low", "prompt_src": "shared", "prompt_hash": p_hash, "prompt_sha256": p_sha,
        "schema_sha256": s_sha, "conf_threshold": CONF_T, "eval_now_iso": NOW_ISO, "safety_impl": "server/src/safety.ts via npx tsx",
        "profile": PROFILE, "n": n, "errors": 0, "timeouts": 0, "pass_count": pc, "pass_rate": round(pc / n, 4),
        "pass_ci95_wilson": [round(p_lo, 4), round(p_hi, 4)], "confident_wrong_dose_count": cw, "confident_wrong_dose_rate": round(cw / n, 4),
        "confident_wrong_dose_ci95_wilson": [round(cw_lo, 4), round(cw_hi, 4)], "rule_of_three_95_upper": round(3.0 / n, 4),
        "summary": {"n": n, "passed": pc, "pass_rate": round(100.0 * pc / n, 1), "pass_wilson_95_ci": [round(100.0 * p_lo, 1), round(100.0 * p_hi, 1)],
                    "unsafe_reassurance": ur, "unsafe_reassurance_rate": round(100.0 * ur / n, 1), "unsafe_wilson_95_ci": [round(100.0 * u_lo, 1), round(100.0 * u_hi, 1)],
                    "false_match": fm, "false_match_rate": round(100.0 * fm / n, 1), "strength_confident_wrong": cw,
                    "strength_confident_wrong_rate": round(100.0 * cw / n, 1), "strength_cw_wilson_95_ci": [round(100.0 * cw_lo, 1), round(100.0 * cw_hi, 1)],
                    "unsure_count": un, "unsure_rate": round(100.0 * un / n, 1),
                    "latency_s": {"p50": round(statistics.median(lats), 3), "p95": round(lats[min(n - 1, int(round(0.95 * (n - 1))))], 3), "mean": round(statistics.mean(lats), 3)},
                    "rule_of_three_95_upper_pct": round(300.0 / n, 1)},
        "cases": cases,
    }
    head = {k: v for k, v in doc.items() if k != "cases"}
    txt = json.dumps(head, ensure_ascii=False, indent=2)[:-2] + ',\n  "cases": [\n'
    txt += ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in cases) + "\n  ]\n}\n"
    RESULTS_PATH.write_text(txt, encoding="utf-8")
    return doc


def run_live(workers: int = 3) -> dict[str, Any]:
    load_env()
    prompt, schema, p_hash, p_sha, s_sha = load_prompt_schema()
    w = max(1, min(8, workers))
    with tempfile.TemporaryDirectory(prefix=f"holdup_{SUITE}_", dir=tmp_root()) as td:
        specs = build_specs(render_all(Path(td)))
        with ThreadPoolExecutor(max_workers=w) as ex:
            reads = list(ex.map(lambda s: call_gemini(s["frame"], s["question"], prompt, schema), specs))
    return pack_results(specs, reads, p_hash, p_sha, s_sha)


def verify_cached() -> dict[str, Any]:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15000 and len(raw.splitlines()) < 200
    assert chr(35) not in raw and "\u2014" not in raw and "\u2013" not in raw and "data:image" not in raw and "base64" not in raw.lower()
    doc = json.loads(raw)
    _, _, p_hash, p_sha, s_sha = load_prompt_schema()
    assert doc["suite"] == SUITE and doc["model"] == MODEL
    assert doc["prompt_hash"] == p_hash and doc["prompt_sha256"] == p_sha and doc["schema_sha256"] == s_sha
    assert doc["n"] == 12 and doc["errors"] == 0 and doc["timeouts"] == 0 and len(doc["cases"]) == 12
    assert doc["pass_count"] == 12 and doc["confident_wrong_dose_count"] == 0
    with tempfile.TemporaryDirectory(prefix=f"holdup_verify_{SUITE}_", dir=tmp_root()) as td:
        td_path = Path(td)
        rendered = render_all(td_path)
        assert len(rendered) == 12 and all(p.stat().st_size > 5000 for p in rendered.values())
    assert not td_path.exists()
    re_v = run_safety_bridge([{"read": c["read"], "profile": doc["profile"], "now": doc["eval_now_iso"]} for c in doc["cases"]])
    for c, v in zip(doc["cases"], re_v):
        assert v["level"] == c["predicted_level"] == c["actual_level"] == c["expected_level"] and v["reasons"] == c["reasons"]
        assert c["read"]["barcode"]["value"] == c["gt"]["barcode"] and c["read"]["barcode"]["confidence"] >= CONF_T
    return doc["summary"]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    out = verify_cached() if args.verify_cached else run_live(args.workers)["summary"]
    sys.stdout.write(json.dumps(out, indent=2) + "\n")
