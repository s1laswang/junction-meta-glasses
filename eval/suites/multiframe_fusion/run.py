from __future__ import annotations

import argparse, hashlib, io, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE, MODEL, CONF_T, NOW_ISO = "multiframe_fusion", "gemini-3.8-flash", 0.8, "2026-11-14T12:00:00+02:00"
REPO = Path(__file__).resolve().parents[3]
RESULTS_PATH = Path(__file__).resolve().parent / "results.json"
TMP_DIR = Path(tempfile.gettempdir()) / f"holdup_{SUITE}"

PROFILE: dict[str, Any] = {
    "meds": [
        {"id": "amlodipine", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]},
        {"id": "metformin", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]},
    ],
    "allergies": ["tree nuts", "peanut"], "avoid": ["NSAIDs"], "doseLog": [], "lang": "en",
}

PAIRS: list[dict[str, Any]] = [
    {"pid": "mf_01", "q": "Is this my evening pill?", "world": "match", "s_exp": "unsure", "p_exp": "match", "ing": "amlodipine", "str": "5 mg", "s_sc": "thumb_occluded_front_abstains", "p_sc": "front_plus_side_flap_5mg_matches"},
    {"pid": "mf_02", "q": "Is this my evening pill?", "world": "warning", "s_exp": "unsure", "p_exp": "warning", "ing": "amlodipine", "str": "10 mg", "s_sc": "thumb_occluded_wrong_dose_abstains", "p_sc": "front_plus_side_flap_10mg_warns"},
    {"pid": "mf_03", "q": "Can I take this metformin?", "world": "warning", "s_exp": "unsure", "p_exp": "warning", "ing": "metformin", "str": "500 mg", "s_sc": "curved_bottle_left_no_dose_abstains", "p_sc": "curved_bottle_two_views_expired_warns"},
    {"pid": "mf_04", "q": "Does this contain nuts?", "world": "warning", "s_exp": "unsure", "p_exp": "warning", "ing": None, "str": None, "s_sc": "food_front_no_allergens_abstains", "p_sc": "food_front_plus_back_hazelnut_warns"},
    {"pid": "mf_05", "q": "Is this safe with my allergies?", "world": "info", "s_exp": "unsure", "p_exp": "info", "ing": None, "str": None, "s_sc": "oat_drink_front_no_allergens_abstains", "p_sc": "oat_drink_front_plus_back_safe_info"},
    {"pid": "mf_06", "q": "Can I take this for a headache?", "world": "warning", "s_exp": "unsure", "p_exp": "warning", "ing": "ibuprofen", "str": "400 mg", "s_sc": "barcode_only_back_abstains", "p_sc": "barcode_back_plus_burana_front_warns"},
]


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


def make_card(seed: int, box: tuple[int, int, int, int], accent: tuple[int, int, int], header: str,
              lines: list[tuple[str, int, tuple[int, int, int], int]], tilt: float, thumb: bool = False, barcode: str | None = None) -> Image.Image:
    rng = random.Random(seed)
    base = Image.new("RGB", (768, 768), (196, 174, 146))
    bd = ImageDraw.Draw(base)
    for y in range(768):
        c = max(90, min(235, int(208 - 0.08 * y + rng.randint(-3, 3))))
        bd.line((0, y, 768, y), fill=(c, int(c * 0.91), int(c * 0.78)))
    layer, sh = Image.new("RGBA", (768, 768), (0, 0, 0, 0)), Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 10, y0 + 14, x1 + 14, y1 + 18), radius=16, fill=(20, 16, 12, 96))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(10)))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(box, radius=16, fill=(250, 251, 253, 255), outline=(165, 172, 180, 255), width=3)
    ld.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=(*accent, 255))
    ld.rectangle((x0, y0 + 32, x1, y0 + 62), fill=(*accent, 255))
    if header: ld.text((x0 + 24, y0 + 18), header, fill=(250, 252, 255, 255), font=ImageFont.load_default(size=22))
    for txt, dy, col, sz in lines:
        ld.text((x0 + 26, y0 + dy), txt, fill=(*col, 255), font=ImageFont.load_default(size=sz), stroke_width=1 if sz >= 34 else 0, stroke_fill=(*col, 255))
    if barcode:
        bx0, by0, bx1, by1 = (x0 + x1) // 2 - 150, y1 - 190, (x0 + x1) // 2 + 150, y1 - 36
        ld.rounded_rectangle((bx0, by0, bx1, by1), radius=8, fill=(255, 255, 255, 255), outline=(190, 195, 202, 255), width=2)
        cx = bx0 + 22
        while cx < bx1 - 24:
            bw = rng.choice((2, 3, 5))
            if cx + bw < bx1 - 22: ld.rectangle((cx, by0 + 14, cx + bw, by1 - 44), fill=(14, 16, 20, 255))
            cx += bw + rng.choice((2, 3, 4))
        ld.text((bx0 + 44, by1 - 38), barcode, fill=(12, 16, 20, 255), font=ImageFont.load_default(size=27))
    out = Image.alpha_composite(base.convert("RGBA"), layer.rotate(tilt, resample=Image.Resampling.BICUBIC))
    if thumb:
        tl = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
        td = ImageDraw.Draw(tl)
        td.rounded_rectangle((40, 340, 430, 495), radius=72, fill=(214, 165, 139, 255), outline=(170, 122, 98, 255), width=3)
        td.rounded_rectangle((330, 358, 412, 474), radius=36, fill=(238, 208, 194, 255), outline=(192, 152, 132, 255), width=2)
        out = Image.alpha_composite(out, tl.rotate(10.0, resample=Image.Resampling.BICUBIC))
    return out.convert("RGB")


def render_all(out_dir: Path) -> dict[str, list[Path]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    blue, brown, green, red, dark, mid = (20, 102, 148), (148, 82, 28), (36, 102, 94), (186, 34, 44), (14, 20, 28), (46, 54, 66)
    imgs = {
        "mf_01": (make_card(501, (84, 136, 684, 620), blue, "ORION PHARMA   Vnr 08 44 12", [("AMLODIPIN ORION", 92, dark, 46), ("tabletti", 156, mid, 28), ("Vaikuttava aine: amlodipiini", 196, mid, 24), ("98 tablettia", 420, mid, 24)], -1.8, thumb=True),
                  make_card(501, (236, 116, 566, 646), blue, "ORION PHARMA", [("AMLODIPIN ORION", 88, dark, 32), ("5 mg", 168, dark, 54), ("tabletti - amlodipiini", 248, mid, 24), ("EXP 2027-10", 418, dark, 32), ("Lot 2410A", 464, mid, 22)], 1.5)),
        "mf_02": (make_card(502, (84, 136, 684, 620), blue, "ORION PHARMA   Vnr 08 44 38", [("AMLODIPIN ORION", 92, dark, 46), ("tabletti", 156, mid, 28), ("98 tablettia", 420, mid, 24)], 1.8, thumb=True),
                  make_card(502, (236, 116, 566, 646), blue, "ORION PHARMA", [("AMLODIPIN ORION", 88, dark, 32), ("10 mg", 168, dark, 54), ("tabletti - amlodipiini", 248, mid, 24), ("EXP 2027-10", 418, dark, 32), ("Lot 2411B", 464, mid, 22)], -1.5)),
        "mf_03": (make_card(503, (190, 110, 578, 654), (32, 92, 162), "NORDIC RX BOTTLE - LEFT VIEW", [("METFORMIN", 104, dark, 50), ("Active substance: metformin", 184, mid, 25), ("Film-coated oral tablets", 230, mid, 24), ("Rotate bottle for dose & date", 310, mid, 22)], -1.2),
                  make_card(503, (190, 110, 578, 654), (32, 92, 162), "NORDIC RX BOTTLE - RIGHT VIEW", [("metformin HCl", 96, mid, 28), ("500 mg", 156, dark, 56), ("500 mg tablets", 232, dark, 30), ("Take with meals", 286, mid, 24), ("EXP 2025-02", 412, (162, 22, 22), 38)], 1.2)),
        "mf_04": (make_card(504, (92, 210, 676, 558), brown, "NORDIC CRUNCH", [("Nordic Crunch", 90, (48, 26, 12), 46), ("Granola Bar 45g", 150, (84, 46, 18), 38), ("Crispy Baked Snack Bar", 214, mid, 24), ("See back wrapper for ingredients", 290, mid, 21)], -1.6),
                  make_card(504, (82, 184, 686, 584), brown, "NORDIC CRUNCH - Granola Bar 45g", [("Ingredients: rolled oats, honey,", 92, dark, 27), ("roasted hazelnuts (14%), cocoa.", 132, dark, 27), ("Allergens: contains hazelnuts (tree nuts), oats.", 186, (124, 34, 16), 23), ("Best before: 2027-09", 272, dark, 26)], 1.5)),
        "mf_05": (make_card(505, (170, 98, 598, 684), green, "NORDIC BARISTA", [("Nordic Barista", 104, dark, 44), ("Oat Drink 1L", 166, (24, 62, 56), 40), ("Foamable Cafe Edition", 234, mid, 25), ("See back panel for ingredients", 516, mid, 21)], 1.3),
                  make_card(505, (144, 98, 624, 684), green, "NORDIC BARISTA OAT DRINK - 1L", [("Ingredients: water, oats (10%),", 112, dark, 26), ("rapeseed oil, sea salt.", 152, dark, 26), ("Allergens: contains oats (gluten).", 208, (22, 54, 48), 24), ("Best before 2027-11", 312, dark, 28)], -1.2)),
        "mf_06": (make_card(506, (88, 146, 680, 618), red, "", [], -2.0, barcode="6432100099999"),
                  make_card(506, (88, 146, 680, 618), red, "ORION PHARMA   Vnr 01 66 40", [("BURANA", 92, (164, 22, 32), 54), ("Vaikuttava aine: ibuprofeeni", 164, dark, 26), ("400 mg", 224, dark, 52), ("tabletti - 30 tablettia", 304, mid, 25), ("EXP 2027-11", 408, dark, 28)], 1.9)),
    }
    paths: dict[str, list[Path]] = {}
    for pid, (im1, im2) in imgs.items():
        p1, p2 = out_dir / f"{pid}_f1.jpg", out_dir / f"{pid}_f2.jpg"
        for im, p in ((im1, p1), (im2, p2)):
            buf = io.BytesIO(); im.save(buf, format="JPEG", quality=90); p.write_bytes(buf.getvalue())
        paths[pid] = [p1, p2]
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


def call_gemini(frame_paths: list[Path], question: str, prompt: str, schema: dict[str, Any]) -> tuple[dict[str, Any], float]:
    from google import genai
    from google.genai import types
    cli = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    parts: list[Any] = [types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg") for p in frame_paths] + [f'The person asked: "{question}"']
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


def build_specs(paths: dict[str, list[Path]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in PAIRS:
        pid = p["pid"]
        out.append({"id": f"{pid}_single", "scenario": p["s_sc"], "question": p["q"], "frames": [paths[pid][0]], "expected_level": p["s_exp"], "world": p["world"], "gt": {"ingredient": p["ing"], "visible_strength": None}})
        out.append({"id": f"{pid}_paired", "scenario": p["p_sc"], "question": p["q"], "frames": paths[pid], "expected_level": p["p_exp"], "world": p["world"], "gt": {"ingredient": p["ing"], "visible_strength": p["str"]}})
    return out


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


def run_live() -> dict[str, Any]:
    load_env()
    prompt, schema, p_hash, p_sha, s_sha = load_prompt_schema()
    specs = build_specs(render_all(TMP_DIR))
    with ThreadPoolExecutor(max_workers=3) as ex:
        reads = list(ex.map(lambda s: call_gemini(s["frames"], s["question"], prompt, schema), specs))
    return pack_results(specs, reads, p_hash, p_sha, s_sha)


def verify_cached() -> dict[str, Any]:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15000 and len(raw.splitlines()) < 200
    assert chr(35) not in raw and "\u2014" not in raw and "\u2013" not in raw and "data:image" not in raw and "base64" not in raw.lower()
    doc = json.loads(raw)
    _, _, p_hash, p_sha, s_sha = load_prompt_schema()
    assert doc["prompt_hash"] == p_hash and doc["prompt_sha256"] == p_sha and doc["schema_sha256"] == s_sha
    assert doc["n"] == 12 and doc["errors"] == 0 and doc["timeouts"] == 0 and len(doc["cases"]) == 12
    assert sum(len(v) for v in render_all(TMP_DIR).values()) == 12
    re_v = run_safety_bridge([{"read": c["read"], "profile": doc["profile"], "now": doc["eval_now_iso"]} for c in doc["cases"]])
    for c, v in zip(doc["cases"], re_v):
        assert v["level"] == c["predicted_level"] == c["actual_level"] and v["reasons"] == c["reasons"]
    return doc["summary"]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    out = verify_cached() if ap.parse_args().verify_cached else run_live()["summary"]
    sys.stdout.write(json.dumps(out, indent=2) + "\n")
