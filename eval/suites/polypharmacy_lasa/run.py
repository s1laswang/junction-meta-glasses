from __future__ import annotations
import argparse, base64, hashlib, io, json, math, os, random, shutil, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SUITE_DIR = Path(__file__).resolve().parent
EVAL_DIR = SUITE_DIR.parent.parent
REPO_ROOT = EVAL_DIR.parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

from common import load_env, parse_json
from normalize import eq_strength
from run_eval import inline_refs, to_label_read

SUITE_NAME = "polypharmacy_lasa"
MODEL = "gemini-3.8-flash"
CONF_THRESHOLD = 0.8
NOW_ISO = "2026-11-14T20:00:00Z"
DOSE_TS_1, DOSE_TS_2 = 1794643200000, 1794682800000
RESULTS_PATH = SUITE_DIR / "results.json"

MED_AML = {"id": "aml", "name": "Amlodipine", "ingredient": "amlodipine", "strength": "5 mg", "schedule": ["evening"]}
MED_MET = {"id": "met", "name": "Metformin", "ingredient": "metformin", "strength": "500 mg", "schedule": ["morning", "evening"]}
MED_BIS = {"id": "bis", "name": "Bisoprolol", "ingredient": "bisoprolol", "strength": "2.5 mg", "schedule": ["morning"]}
MED_THY = {"id": "thy", "name": "Thyroxin", "ingredient": "levothyroxine", "strength": "25 mcg", "schedule": ["morning"]}
MED_PAR = {"id": "par", "name": "Paracetamol", "ingredient": "paracetamol", "strength": "500 mg", "schedule": ["as needed"]}
ORION = (22, 108, 144)


def prof(meds: list[dict[str, Any]], doses: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"meds": meds, "allergies": ["penicillin"], "avoid": ["NSAIDs", "opioids"], "doseLog": doses or [], "lang": "en"}


def mk(cid: str, scenario: str, expected: str, gt_prod: str, gt_ing: str, gt_str: str | None, profile: dict[str, Any],
       question: str, header: str, title: str, subtitle: str, printed_str: str, form: str, pack: str, exp: str,
       accent: tuple[int, int, int], occlude: bool = False) -> dict[str, Any]:
    return {"id": cid, "scenario": scenario, "expected_level": expected, "gt_product": gt_prod, "gt_ingredient": gt_ing,
            "gt_strength": gt_str, "profile": profile, "question": question, "header": header, "title": title,
            "subtitle": subtitle, "printed_strength": printed_str, "form": form, "pack": pack, "expiry": exp,
            "accent": accent, "occlude": occlude}


CASES: list[dict[str, Any]] = [
    mk("lasa_01", "brand_to_inn_evening_match", "match", "NORVASC", "amlodipine", "5 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my evening pill?", "VIATRIS    Vnr 04 19 22", "NORVASC", "amlodipin / amlodipine", "5 mg", "tablets", "30 tablets", "EXP 2027-10", (28, 72, 136)),
    mk("lasa_02", "nordic_comma_decimal_match", "match", "BISOPROLOL ORION", "bisoprolol", "2.5 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my morning beta blocker?", "ORION PHARMA    Vnr 49 21 60", "BISOPROLOL ORION", "bisoprololi / bisoprolol", "2,5 mg", "tabletti", "100 tablettia", "EXP 2027-11", ORION),
    mk("lasa_03", "bid_second_dose_allowed_match", "match", "METFORMIN ORION", "metformin", "500 mg", prof([MED_AML, MED_MET, MED_BIS], [{"medId": "met", "ts": DOSE_TS_1}]),
       "Can I take my second metformin dose now?", "ORION PHARMA    Vnr 14 29 71", "METFORMIN ORION", "metformin hydrochloride", "500 mg", "film-coated tablets", "100 tablets", "EXP 2027-11", ORION),
    mk("lasa_04", "once_daily_double_dose_trap", "warning", "AMLODIPIN ORION", "amlodipine", "5 mg", prof([MED_AML, MED_MET, MED_BIS], [{"medId": "aml", "ts": DOSE_TS_1}]),
       "Should I take my evening amlodipine now?", "ORION PHARMA    Vnr 08 44 12", "AMLODIPIN ORION", "amlodipiini / amlodipine", "5 mg", "tabletti", "30 tablettia", "EXP 2027-10", ORION),
    mk("lasa_05", "bid_quota_exhausted_double_dose_trap", "warning", "GLUCOPHAGE", "metformin", "500 mg", prof([MED_AML, MED_MET, MED_BIS], [{"medId": "met", "ts": DOSE_TS_1}, {"medId": "met", "ts": DOSE_TS_2}]),
       "Can I take another metformin tablet tonight?", "MERCK    Vnr 01 66 40", "GLUCOPHAGE", "metformin hydrochloride", "500 mg", "film-coated tablets", "100 tablets", "EXP 2027-12", (36, 94, 152)),
    mk("lasa_06", "same_house_2x_strength_lasa_trap", "warning", "AMLODIPIN ORION", "amlodipine", "10 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my 5 mg evening blood pressure pill?", "ORION PHARMA    Vnr 08 44 38", "AMLODIPIN ORION", "amlodipiini / amlodipine", "10 mg", "tabletti", "98 tablettia", "EXP 2027-10", ORION),
    mk("lasa_07", "decimal_vs_integer_strength_lasa_trap", "warning", "BISOPROLOL ORION", "bisoprolol", "5 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my morning bisoprolol?", "ORION PHARMA    Vnr 49 21 86", "BISOPROLOL ORION", "bisoprololi / bisoprolol", "5 mg", "tabletti", "100 tablettia", "EXP 2027-11", ORION),
    mk("lasa_08", "nordic_mikrog_4x_strength_lasa_trap", "warning", "THYROXIN", "levothyroxine", "100 mcg", prof([MED_AML, MED_BIS, MED_THY]),
       "Is this my morning thyroid tablet?", "ORION PHARMA    Vnr 07 14 23", "THYROXIN", "levotyroksiini / levothyroxine", "100 mikrog", "tabletti", "100 tablettia", "EXP 2027-09", ORION),
    mk("lasa_09", "olol_stem_house_pack_cousin_trap", "warning", "METOPROLOL ORION", "metoprolol", "25 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my morning heart pill?", "ORION PHARMA    Vnr 52 10 31", "METOPROLOL ORION", "metoprololi / metoprolol", "25 mg", "depottabletti", "100 tablettia", "EXP 2027-08", ORION),
    mk("lasa_10", "combo_opioid_coformulation_lasa_trap", "warning", "PANACOD", "paracetamol, codeine", "500 mg + 30 mg", prof([MED_AML, MED_BIS, MED_PAR]),
       "Can I take this paracetamol for my knee pain?", "SANOFI    Vnr 03 88 19", "PANACOD", "paracetamol 500 mg + codeine 30 mg", "500 mg + 30 mg", "tabletti", "20 tablettia", "EXP 2027-12", (152, 34, 48)),
    mk("lasa_11", "finnish_brand_penicillin_class_allergy_trap", "warning", "AMORION", "amoxicillin", "500 mg", prof([MED_AML, MED_MET, MED_BIS]),
       "Can I take this tablet from the medicine cabinet?", "ORION PHARMA    Vnr 06 31 15", "AMORION", "amoksisilliini / amoxicillin", "500 mg", "tabletti", "20 tablettia", "EXP 2027-12", ORION),
    mk("lasa_12", "thumb_occluded_strength_lasa_abstention", "unsure", "AMLODIPIN ORION", "amlodipine", None, prof([MED_AML, MED_MET, MED_BIS]),
       "Is this my 5 mg evening pill?", "ORION PHARMA    Vnr 08 44 12", "AMLODIPIN ORION", "amlodipiini / amlodipine", "", "tabletti", "30 tablettia", "EXP 2027-10", ORION, True),
]


def clean_str(s: str) -> str:
    return s.replace(chr(8212), "-").replace(chr(8211), "-").replace(chr(35), "no.")


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 0.0]
    z, p = 1.959963984540054, k / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    half = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)) / denom
    return [max(0.0, round(center - half, 4)), min(1.0, round(center + half, 4))]


def render_case_jpeg(case: dict[str, Any], index: int, out_path: Path) -> bytes:
    rng = random.Random(5400 + index * 31)
    size = 768
    canvas = Image.new("RGB", (size, size), (228, 222, 212))
    draw = ImageDraw.Draw(canvas)
    for y in range(size):
        c = (234 - y // 18, 228 - y // 18, 218 - y // 20) if y < 520 else (182 - (y - 520) // 12, 150 - (y - 520) // 12, 118 - (y - 520) // 14)
        draw.line((0, y, size, y), fill=c)
    x0, y0 = 72 + rng.randint(-6, 6), 140 + rng.randint(-5, 5)
    x1, y1 = x0 + 624, y0 + 432
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(28, 22, 16, 88))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(10.0))).convert("RGB")
    draw = ImageDraw.Draw(canvas)
    acc = case["accent"]
    draw.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=(251, 252, 253), outline=(168, 174, 182), width=3)
    draw.rounded_rectangle((x0, y0, x1, y0 + 62), radius=16, fill=acc)
    draw.rectangle((x0, y0 + 34, x1, y0 + 62), fill=acc)
    draw.rectangle((x0, y0 + 62, x0 + 12, y1 - 14), fill=acc)
    draw.text((x0 + 28, y0 + 18), case["header"], fill=(248, 250, 252), font=ImageFont.load_default(size=22))
    draw.text((x0 + 28, y0 + 82), case["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=42))
    draw.text((x0 + 28, y0 + 140), case["subtitle"], fill=(48, 56, 66), font=ImageFont.load_default(size=24))
    sx0, sy0, sy1 = x0 + 28, y0 + 190, y0 + 274
    if case["occlude"]:
        sx1 = sx0 + 220
        draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
        draw.text((sx1 + 24, sy0 + 28), case["form"], fill=(44, 52, 62), font=ImageFont.load_default(size=22))
    else:
        st = case["printed_strength"]
        fsz = 34 if len(st) >= 10 else 42
        fnt = ImageFont.load_default(size=fsz)
        sx1 = sx0 + max(196, draw.textbbox((0, 0), st, font=fnt)[2] + 44)
        draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=10, fill=(240, 246, 251), outline=acc, width=2)
        draw.text((sx0 + 22, sy0 + (22 if fsz <= 36 else 18)), st, fill=(14, 20, 28), font=fnt)
        draw.text((sx1 + 20, sy0 + 28), case["form"], fill=(44, 52, 62), font=ImageFont.load_default(size=22))
    draw.text((x0 + 28, y0 + 334), case["pack"], fill=(52, 60, 70), font=ImageFont.load_default(size=22))
    draw.rounded_rectangle((x1 - 238, y0 + 318, x1 - 28, y0 + 384), radius=8, fill=(245, 247, 249), outline=(158, 166, 174), width=2)
    draw.text((x1 - 220, y0 + 337), case["expiry"], fill=(20, 26, 34), font=ImageFont.load_default(size=24))
    if case["occlude"]:
        thumb = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(thumb).rounded_rectangle((x0 - 36, sy0 - 10, sx1 + 18, sy1 + 26), radius=46, fill=(30, 20, 14, 95))
        thumb = thumb.filter(ImageFilter.GaussianBlur(7.0))
        td = ImageDraw.Draw(thumb)
        td.rounded_rectangle((x0 - 44, sy0 - 16, sx1 + 12, sy1 + 18), radius=48, fill=(214, 168, 142, 255), outline=(178, 132, 108, 255), width=3)
        td.rounded_rectangle((sx1 - 62, sy0 + 2, sx1 - 4, sy1 - 4), radius=24, fill=(234, 198, 180, 255), outline=(196, 154, 134, 255), width=2)
        canvas = Image.alpha_composite(canvas.convert("RGBA"), thumb).convert("RGB")
    buf = io.BytesIO()
    canvas.rotate(rng.uniform(-1.4, 1.4), resample=Image.Resampling.BICUBIC, fillcolor=(218, 210, 198)).save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data


def call_gemini(jpeg_bytes: bytes, question: str, prompt: str, schema: dict[str, Any], cid: str) -> tuple[dict[str, Any], float]:
    user_text = f'The person asked: "{question}"'
    try:
        from google.genai import types
        from common import gen_json
        raw, _, dt = gen_json(MODEL, [types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"), user_text],
                              schema=schema, system=prompt, thinking="low", max_tokens=4096, feature=f"eval.{SUITE_NAME}", label=cid)
        return to_label_read(raw), float(dt)
    except ModuleNotFoundError:
        load_env()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ['GEMINI_API_KEY']}"
        body = json.dumps({
            "systemInstruction": {"parts": [{"text": prompt}]},
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(jpeg_bytes).decode("ascii")}}, {"text": user_text},
            ]}],
            "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema, "thinkingConfig": {"thinkingLevel": "LOW"}, "maxOutputTokens": 4096},
        }).encode("utf-8")
        for attempt in range(4):
            t0 = time.time()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=60) as resp:
                    parts = json.loads(resp.read().decode("utf-8"))["candidates"][0]["content"]["parts"]
                txt = next(p["text"] for p in parts if "text" in p and not p.get("thought"))
                return to_label_read(parse_json(txt)), time.time() - t0
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2.0 * (attempt + 1))
        raise RuntimeError("unreachable")


def run_safety_bridge(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_path = ":".join(["/home/silas/tools/node/bin", str(REPO_ROOT / "node_modules" / ".bin"), os.environ.get("PATH", "")])
    node_bin = "/home/silas/tools/node/bin/node" if os.path.exists("/home/silas/tools/node/bin/node") else (shutil.which("node", path=merged_path) or "node")
    env = dict(os.environ, PATH=merged_path, HOLDUP_SAFETY_TS=str(REPO_ROOT / "server" / "src" / "safety.ts"))
    proc = subprocess.run([node_bin, "--import", "tsx", str(EVAL_DIR / "safety_bridge.mts")],
                          input="\n".join(json.dumps(x, ensure_ascii=False) for x in batch) + "\n",
                          text=True, capture_output=True, cwd=str(REPO_ROOT), env=env, timeout=90, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"safety_bridge failed ({proc.returncode}): {proc.stderr[:300]}")
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def load_contract_files() -> tuple[str, dict[str, Any], str, str]:
    p_bytes = (REPO_ROOT / "shared" / "verify_prompt.md").read_bytes()
    s_bytes = (REPO_ROOT / "shared" / "label_schema.json").read_bytes()
    return p_bytes.decode("utf-8"), inline_refs(json.loads(s_bytes.decode("utf-8"))), hashlib.sha256(p_bytes).hexdigest(), hashlib.sha256(s_bytes).hexdigest()


def is_cw_dose(gt_strength: str | None, strength_read: str | None, strength_conf: float) -> bool:
    if strength_read is None or not str(strength_read).strip() or strength_conf < CONF_THRESHOLD:
        return False
    return True if gt_strength is None else not eq_strength(gt_strength, str(strength_read))


def run_live(workers: int) -> dict[str, Any]:
    prompt, schema, p_sha, s_sha = load_contract_files()
    with tempfile.TemporaryDirectory(prefix="holdup_polypharmacy_lasa_") as tmp:
        def job(item: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            idx, c = item
            jpg = render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")
            try:
                read, dt = call_gemini(jpg, c["question"], prompt, schema, c["id"])
                return {"read": read, "latency_s": round(dt, 3), "error": None}
            except Exception as exc:
                return {"read": None, "latency_s": 0.0, "error": clean_str(str(exc)[:180])}
        with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as ex:
            preds = list(ex.map(job, enumerate(CASES, start=1)))
    ok_idx = [i for i, r in enumerate(preds) if r["error"] is None]
    verdicts = run_safety_bridge([{"read": preds[i]["read"], "profile": CASES[i]["profile"], "now": NOW_ISO} for i in ok_idx]) if ok_idx else []
    v_map = dict(zip(ok_idx, verdicts))
    cases_out: list[dict[str, Any]] = []
    cw_count, timeouts = 0, 0
    for i, (c, pr) in enumerate(zip(CASES, preds)):
        if pr["error"] is not None:
            timeouts += int("timeout" in pr["error"].lower() or "timed out" in pr["error"].lower())
            cases_out.append({"id": c["id"], "scenario": c["scenario"], "expected_level": c["expected_level"], "actual_level": "error",
                              "passed": False, "strength_read": None, "strength_conf": 0.0, "name_conf": 0.0, "readability": 0.0,
                              "latency_s": pr["latency_s"], "error": pr["error"]})
            continue
        rd, actual = pr["read"], v_map[i]["level"]
        s_val = clean_str(rd["strength"]["value"]) if rd["strength"]["value"] is not None else None
        s_conf = round(float(rd["strength"]["confidence"]), 4)
        n_conf = round(max(float(rd["ingredient"]["confidence"]) if rd["ingredient"]["value"] else 0.0,
                           float(rd["product"]["confidence"]) if rd["product"]["value"] else 0.0), 4)
        cw_count += int(is_cw_dose(c["gt_strength"], s_val, s_conf))
        cases_out.append({"id": c["id"], "scenario": c["scenario"], "expected_level": c["expected_level"], "actual_level": actual,
                          "passed": actual == c["expected_level"], "strength_read": s_val, "strength_conf": s_conf,
                          "name_conf": n_conf, "readability": round(float(rd["readability"]), 4), "latency_s": pr["latency_s"], "error": None})
    n, errors, pass_count = len(cases_out), sum(1 for x in cases_out if x["error"] is not None), sum(1 for x in cases_out if x["passed"])
    report = {"suite": SUITE_NAME, "model": MODEL, "prompt_sha256": p_sha, "schema_sha256": s_sha, "n": n, "errors": errors, "timeouts": timeouts,
              "pass_count": pass_count, "pass_rate": round(pass_count / n, 4), "pass_ci95_wilson": wilson_ci95(pass_count, n),
              "confident_wrong_dose_count": cw_count, "confident_wrong_dose_rate": round(cw_count / n, 4),
              "confident_wrong_dose_ci95_wilson": wilson_ci95(cw_count, n), "rule_of_three_95_upper": round(3.0 / n, 4), "cases": cases_out}
    RESULTS_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{SUITE_NAME}: pass={pass_count}/{n} cw_dose={cw_count} errors={errors}")
    return report


def verify_cached() -> None:
    raw = RESULTS_PATH.read_text(encoding="utf-8")
    assert len(raw.encode("utf-8")) < 15360 and chr(8212) not in raw and chr(8211) not in raw and "base64" not in raw.lower()
    data = json.loads(raw)
    _, _, p_sha, s_sha = load_contract_files()
    assert data["suite"] == SUITE_NAME and data["model"] == MODEL and data["prompt_sha256"] == p_sha and data["schema_sha256"] == s_sha
    assert data["n"] == 12 and data["errors"] == 0 and data["timeouts"] == 0 and len(data["cases"]) == 12
    with tempfile.TemporaryDirectory(prefix="holdup_verify_lasa_") as tmp:
        for idx, c in enumerate(CASES, start=1):
            assert len(render_case_jpeg(c, idx, Path(tmp) / f"{c['id']}.jpg")) > 1000
    nf = {"value": None, "confidence": 0.0}
    batch = [{"read": {"kind": "medication", "product": {"value": s["gt_product"], "confidence": r["name_conf"]},
                       "ingredient": {"value": s["gt_ingredient"], "confidence": r["name_conf"]},
                       "strength": {"value": r["strength_read"], "confidence": r["strength_conf"]},
                       "dosing": nf, "expiry": {"value": "2027-10", "confidence": 0.95}, "allergens": nf, "barcode": nf,
                       "readability": r["readability"]}, "profile": s["profile"], "now": NOW_ISO} for s, r in zip(CASES, data["cases"])]
    for row, vd in zip(data["cases"], run_safety_bridge(batch)):
        assert vd["level"] == row["actual_level"] and (row["actual_level"] == row["expected_level"]) is row["passed"]
    print(f"verify-cached OK: {SUITE_NAME} pass={data['pass_count']}/{data['n']} cw_dose={data['confident_wrong_dose_count']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-cached", "--check", dest="verify_cached", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    verify_cached() if a.verify_cached else run_live(a.workers)
