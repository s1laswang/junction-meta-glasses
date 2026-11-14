"""Eval harness for verify_label: runs the product's verify prompt + schema over every image
and scores per-field accuracy, abstention, confident-wrong rate, calibration, latency and
the end-to-end safety verdict.

  python eval/run_eval.py predict --set synthetic   # Gemini calls (I/O bound; login node, niced)
  python eval/run_eval.py predict --set real
  python eval/run_eval.py score                     # CPU only: metrics -> eval/out/results.json + docs/EVAL.md tables

Prompt/schema: uses shared/verify_prompt.md + shared/label_schema.json (the server's real
files) when present, else eval/draft/*. The source and a hash are recorded in results.json.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import statistics
from collections import defaultdict
from pathlib import Path

from common import (DATA, EVAL_DIR, OUT, REPO, SHARED, VERIFY_MODEL, append_jsonl, gen_json, log, pmap,
                    read_jsonl)
from normalize import COMPARE, canon_allergens
from safety import verdict as py_verdict

FIELDS = ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode"]
CONF_T = 0.8
REAL = EVAL_DIR / "real"


# ---------------------------------------------------------------- prompt + schema
def load_prompt_schema():
    p, s = SHARED / "verify_prompt.md", SHARED / "label_schema.json"
    src = "shared"
    if not (p.exists() and s.exists()):
        p, s = EVAL_DIR / "draft" / "verify_prompt.md", EVAL_DIR / "draft" / "label_schema.json"
        src = "eval/draft"
    prompt, schema_txt = p.read_text(), s.read_text()
    h = hashlib.sha256((prompt + schema_txt).encode()).hexdigest()[:12]
    schema = json.loads(schema_txt)
    # allow a wrapper {"schema": {...}} or {"name":..., "schema": ...}
    if "schema" in schema and "properties" not in schema:
        schema = schema["schema"]
    return prompt, schema, src, h


USER_TEXT = os.environ.get("VERIFY_USER_TEXT", "Read this label.")
THINKING = os.environ.get("VERIFY_THINKING", "low")


def predict_one(img_bytes: bytes, prompt: str, schema: dict, mime="image/jpeg"):
    from google.genai import types

    contents = [types.Part.from_bytes(data=img_bytes, mime_type=mime), USER_TEXT]
    data, _, dt = gen_json(VERIFY_MODEL, contents, schema=schema, system=prompt, thinking=THINKING,
                           max_tokens=4096, feature="eval.verify_label", label="verify")
    return data, dt


# ---------------------------------------------------------------- datasets
def synthetic_rows():
    return read_jsonl(DATA / "dataset.jsonl")


def real_rows():
    f = REAL / "labels.csv"
    rows = []
    if not f.exists():
        return rows
    for r in csv.DictReader(f.open()):
        fn = (r.get("file") or "").strip()
        if not fn or fn == "example.jpg" or not (REAL / fn).exists():
            continue
        gt = {}
        for k in FIELDS:
            v = (r.get(k) or "").strip()
            if k == "allergens":
                if r.get("kind") != "food":
                    gt[k] = {"value": None, "status": "excluded"}
                    continue
                if v.lower() in ("none", "-", "[]"):
                    gt[k] = {"value": [], "status": "visible"}
                elif v:
                    gt[k] = {"value": sorted(canon_allergens([x for x in v.replace(";", ",").split(",")])),
                             "status": "visible"}
                else:
                    gt[k] = {"value": None, "status": "excluded"}
            else:
                gt[k] = {"value": v or None, "status": "visible" if v else "excluded"}
        rows.append({"img_id": "real/" + fn, "file": str(REAL / fn), "kind": r.get("kind") or "other",
                     "deg": "real", "sev": 0, "gt": gt, "notes": r.get("notes", ""), "spec_id": fn})
    return rows


def preds_path(which):
    return OUT / f"preds_{which}.jsonl"


def cmd_predict(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = synthetic_rows() if a.set == "synthetic" else real_rows()
    if a.limit:
        random.Random(0).shuffle(rows)
        rows = rows[: a.limit]
    pp = preds_path(a.set)
    done = {r["img_id"] for r in read_jsonl(pp) if r.get("prompt_hash") == h and not r.get("error")}
    todo = [r for r in rows if r["img_id"] not in done]
    log(f"predict {a.set}: {len(todo)} to do, {len(done)} cached; prompt={src} hash={h} model={VERIFY_MODEL}")

    def run(r):
        path = Path(r["file"]) if os.path.isabs(r["file"]) else DATA / r["file"]
        try:
            pred, dt = predict_one(path.read_bytes(), prompt, schema)
            out = {"img_id": r["img_id"], "pred": pred, "latency_s": round(dt, 3), "prompt_hash": h,
                   "prompt_src": src, "model": VERIFY_MODEL}
        except Exception as e:  # noqa: BLE001
            out = {"img_id": r["img_id"], "error": str(e)[:300], "prompt_hash": h}
        append_jsonl(pp, out)
        return out

    res = pmap(run, todo, workers=a.workers, desc=f"verify {a.set}")
    log(f"errors: {sum(1 for r in res if r.get('error'))}")


# ---------------------------------------------------------------- scoring
def gt_value(row, f):
    g = row["gt"]
    if f == "allergens" and "may_contain" in g:
        if row["kind"] != "food":
            return None, "excluded"
        v = sorted(set((g["allergens"]["value"] or []) + (g["may_contain"]["value"] or [])))
        st = g["allergens"]["status"]
        if g["may_contain"]["value"] and g["may_contain"]["status"] in ("hidden", "partial") and st == "visible":
            st = "partial"
        return v, st
    x = g.get(f) or {"value": None, "status": "excluded"}
    if f == "allergens" and row["kind"] != "food":
        return None, "excluded"
    return x["value"], x["status"]


def pred_field(pred, f):
    x = pred.get(f) if isinstance(pred, dict) else None
    if not isinstance(x, dict):
        return None, 0.0
    v = x.get("value")
    if v == "" or (isinstance(v, str) and v.strip().lower() in ("null", "none", "unknown", "n/a")):
        v = None
    return v, float(x.get("confidence") or 0.0)


def classify(row, pred, f):
    """-> dict(status, outcome in {correct, wrong, abstain}, conf) or None if unscored."""
    if row["kind"] == "food" and f in ("ingredient", "strength", "dosing"):
        return None
    if row["kind"] == "medication" and f == "allergens":
        return None
    gv, st = gt_value(row, f)
    if st == "excluded":
        return None
    pv, conf = pred_field(pred, f)
    if st != "hidden" and gv in (None, ""):
        # field doesn't exist on this item (e.g. no dosing printed): treat as hidden
        st = "hidden"
    if pv is None or (isinstance(pv, list) and f != "allergens" and not pv):
        return {"status": st, "outcome": "abstain", "conf": conf}
    if gv in (None, ""):
        return {"status": st, "outcome": "wrong", "conf": conf}  # invented a value for a field that isn't there
    ok = COMPARE[f](gv, pv) if f != "allergens" else COMPARE[f](gv, pv if isinstance(pv, list) else [pv])
    return {"status": st, "outcome": "correct" if ok else "wrong", "conf": conf}


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def agg(items):
    """items: list of classify() outputs."""
    vis = [i for i in items if i["status"] == "visible"]
    par = [i for i in items if i["status"] == "partial"]
    hid = [i for i in items if i["status"] == "hidden"]
    answered = [i for i in items if i["outcome"] != "abstain"]
    cw = [i for i in items if i["outcome"] == "wrong" and i["conf"] >= CONF_T]
    return {
        "n": len(items), "n_visible": len(vis), "n_partial": len(par), "n_hidden": len(hid),
        "acc_visible": pct(sum(i["outcome"] == "correct" for i in vis), len(vis)),
        "abstain_visible": pct(sum(i["outcome"] == "abstain" for i in vis), len(vis)),
        "wrong_visible": pct(sum(i["outcome"] == "wrong" for i in vis), len(vis)),
        "acc_partial": pct(sum(i["outcome"] == "correct" for i in par), len(par)),
        "abstain_partial": pct(sum(i["outcome"] == "abstain" for i in par), len(par)),
        "wrong_partial": pct(sum(i["outcome"] == "wrong" for i in par), len(par)),
        "abstain_hidden": pct(sum(i["outcome"] == "abstain" for i in hid), len(hid)),
        "guess_hidden": pct(sum(i["outcome"] != "abstain" for i in hid), len(hid)),
        "wrong_hidden": pct(sum(i["outcome"] == "wrong" for i in hid), len(hid)),
        "precision_answered": pct(sum(i["outcome"] == "correct" for i in answered), len(answered)),
        "confident_wrong": len(cw),
        "confident_wrong_rate": pct(len(cw), len(items)),
        "confident_wrong_of_confident": pct(len(cw), sum(1 for i in answered if i["conf"] >= CONF_T)),
    }


def calibration(items, bins=(0, .5, .6, .7, .8, .9, .95, 1.0001)):
    out = []
    ans = [i for i in items if i["outcome"] != "abstain"]
    for lo, hi in zip(bins[:-1], bins[1:]):
        b = [i for i in ans if lo <= i["conf"] < hi]
        out.append({"bin": f"[{lo:.2f},{min(hi,1):.2f}{']' if hi > 1 else ')'}", "n": len(b),
                    "mean_conf": round(statistics.mean(i["conf"] for i in b), 3) if b else None,
                    "accuracy": pct(sum(i["outcome"] == "correct" for i in b), len(b))})
    # ECE
    n = len(ans)
    ece = sum((x["n"] / n) * abs((x["accuracy"] or 0) / 100 - (x["mean_conf"] or 0)) for x in out if x["n"]) if n else None
    return {"bins": out, "ece": round(ece, 3) if ece is not None else None}


def threshold_sweep(items, ts=(0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95)):
    """If the safety check only trusts values with conf >= t: coverage on readable fields vs wrong-trusted."""
    out = []
    readable = [i for i in items if i["status"] == "visible"]
    for t in ts:
        trusted = [i for i in items if i["outcome"] != "abstain" and i["conf"] >= t]
        wrong = [i for i in trusted if i["outcome"] == "wrong"]
        cov = [i for i in readable if i["outcome"] == "correct" and i["conf"] >= t]
        out.append({"t": t, "coverage_visible": pct(len(cov), len(readable)),
                    "trusted": len(trusted), "trusted_wrong": len(wrong),
                    "trusted_wrong_rate": pct(len(wrong), len(trusted)),
                    "trusted_wrong_per_item": pct(len(wrong), len(items))})
    return out


# ---------------------------------------------------------------- safety scenarios
DECOY_MEDS = [
    {"id": "d1", "name": "Furesis", "ingredient": "furosemide", "strength": "40 mg", "schedule": ["morning"]},
    {"id": "d2", "name": "Levaxin", "ingredient": "levothyroxine", "strength": "100 mikrog", "schedule": ["morning"]},
    {"id": "d3", "name": "Primaspan", "ingredient": "acetylsalicylic acid", "strength": "100 mg", "schedule": ["morning"]},
]


def other_strength(s: str) -> str:
    import re
    m = re.search(r"(\d+(?:[.,]\d+)?)", s or "")
    if not m:
        return "999 mg"
    n = float(m.group(1).replace(",", "."))
    alt = n * 2 if n < 400 else n / 2
    alt_s = str(int(alt)) if alt == int(alt) else str(alt)
    return s[: m.start()] + alt_s + s[m.end():]


def scenarios(row):
    """Profiles to test this image against, with the scenario name."""
    g = row["gt"]
    out = []
    if row["kind"] == "medication":
        ing, st, prod = g["ingredient"]["value"], g["strength"]["value"], g["product"]["value"]
        if not ing or not st:
            return out
        base = {"allergies": [], "avoid": [], "doseLog": [], "lang": "en"}
        out.append(("on_list_same_strength", dict(base, meds=DECOY_MEDS + [
            {"id": "m1", "name": prod, "ingredient": ing, "strength": st, "schedule": ["evening"]}])))
        out.append(("on_list_other_strength", dict(base, meds=DECOY_MEDS + [
            {"id": "m1", "name": prod, "ingredient": ing, "strength": other_strength(st), "schedule": ["evening"]}])))
        out.append(("not_on_list", dict(base, meds=DECOY_MEDS)))
    elif row["kind"] == "food":
        al = sorted(set((g["allergens"]["value"] or []) + ((g.get("may_contain") or {}).get("value") or [])))
        base = {"meds": DECOY_MEDS, "avoid": [], "doseLog": [], "lang": "en"}
        if al:
            out.append(("allergic_to_contained", dict(base, allergies=[al[0].replace("_", " ")])))
        absent = [a for a in ("peanut", "sesame", "fish", "egg", "milk") if a not in al]
        if absent:
            out.append(("allergic_to_absent", dict(base, allergies=[absent[0]])))
    return out


def gt_read(row, visible_only: bool):
    """Ideal LabelRead from ground truth. visible_only=False -> the true world state."""
    g = row["gt"]
    def fld(f):
        v, st = gt_value(row, f)
        if v in (None, "") or (visible_only and st != "visible"):
            return {"value": None, "confidence": 0.0}
        if f == "allergens":
            v = [x.replace("_", " ") for x in v]
        if f == "expiry":
            v = (g.get("expiry") or {}).get("value") or v
        return {"value": v, "confidence": 1.0}
    read = {f: fld(f) for f in FIELDS}
    read["kind"] = row["kind"]
    read["readability"] = 1.0
    return read


def run_safety(rows, preds, t):
    """Returns list of per-(image,scenario) verdict records."""
    recs = []
    for r in rows:
        p = preds.get(r["img_id"])
        if not p or p.get("error"):
            continue
        for name, prof in scenarios(r):
            world = py_verdict(gt_read(r, False), prof, t=t)["level"]
            seen = py_verdict(gt_read(r, True), prof, t=t)["level"]
            got = py_verdict(p["pred"], prof, t=t)["level"]
            recs.append({"img_id": r["img_id"], "deg": r["deg"], "sev": r["sev"], "kind": r["kind"],
                         "scenario": name, "world": world, "visible": seen, "pred": got})
    return recs


def safety_summary(recs):
    n = len(recs)
    unsafe = [x for x in recs if x["world"] == "warning" and x["pred"] in ("match", "info")]
    false_match = [x for x in recs if x["pred"] == "match" and x["world"] != "match"]
    correct = [x for x in recs if x["pred"] == x["world"]]
    unsure = [x for x in recs if x["pred"] == "unsure"]
    agree_vis = [x for x in recs if x["pred"] == x["visible"]]
    by_scen = defaultdict(list)
    for x in recs:
        by_scen[x["scenario"]].append(x)
    return {
        "n": n, "unsafe_reassurance": len(unsafe), "unsafe_reassurance_rate": pct(len(unsafe), n),
        "false_match": len(false_match), "false_match_rate": pct(len(false_match), n),
        "verdict_correct_vs_world": pct(len(correct), n), "unsure_rate": pct(len(unsure), n),
        "agree_with_ideal_reader": pct(len(agree_vis), n),
        "by_scenario": {k: {"n": len(v), "correct": pct(sum(x["pred"] == x["world"] for x in v), len(v)),
                            "unsure": pct(sum(x["pred"] == "unsure" for x in v), len(v)),
                            "unsafe": sum(1 for x in v if x["world"] == "warning" and x["pred"] in ("match", "info"))}
                        for k, v in sorted(by_scen.items())},
        "unsafe_examples": unsafe[:15],
    }


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 2)


def score_set(rows, preds, label):
    per_field = defaultdict(list)
    per_field_deg = defaultdict(list)
    per_field_degsev = defaultdict(list)
    wrong_examples = []
    lat = []
    errors = 0
    for r in rows:
        p = preds.get(r["img_id"])
        if not p:
            continue
        if p.get("error"):
            errors += 1
            continue
        lat.append(p["latency_s"])
        for f in FIELDS:
            c = classify(r, p["pred"], f)
            if c is None:
                continue
            per_field[f].append(c)
            per_field_deg[(f, r["deg"])].append(c)
            per_field_degsev[(f, r["deg"], r["sev"])].append(c)
            if c["outcome"] == "wrong" and c["conf"] >= CONF_T and len(wrong_examples) < 60:
                gv, st = gt_value(r, f)
                wrong_examples.append({"img_id": r["img_id"], "field": f, "status": st, "gt": gv,
                                       "pred": pred_field(p["pred"], f)[0], "conf": c["conf"]})
    allf = [c for f in FIELDS for c in per_field[f]]
    res = {
        "label": label, "images_scored": len(lat), "errors": errors,
        "latency_s": {"p50": quantile(lat, .5), "p95": quantile(lat, .95), "mean": round(statistics.mean(lat), 2) if lat else None},
        "overall": agg(allf),
        "per_field": {f: agg(v) for f, v in per_field.items()},
        "per_field_deg": {f"{f}|{d}": agg(v) for (f, d), v in sorted(per_field_deg.items())},
        "per_field_deg_sev": {f"{f}|{d}|{s}": agg(v) for (f, d, s), v in sorted(per_field_degsev.items())},
        "calibration_all": calibration(allf),
        "calibration_strength": calibration(per_field["strength"]),
        "threshold_sweep_strength": threshold_sweep(per_field["strength"]),
        "threshold_sweep_all": threshold_sweep(allf),
        "confident_wrong_examples": wrong_examples,
    }
    sweeps = {}
    for t in (0.6, 0.7, 0.8, 0.9):
        sweeps[str(t)] = safety_summary(run_safety(rows, preds, t))
    res["safety"] = sweeps
    return res


def cmd_score(a):
    prompt, schema, src, h = load_prompt_schema()
    results = {"model": VERIFY_MODEL, "prompt_src": src, "prompt_hash": h, "conf_threshold": CONF_T,
               "thinking": THINKING, "safety_impl": "python port (eval/safety.py)"}
    for which, rows in (("synthetic", synthetic_rows()), ("real", real_rows())):
        preds = {}
        for p in read_jsonl(preds_path(which)):
            if p.get("prompt_hash") == (a.hash or h):
                if p["img_id"] not in preds or not p.get("error"):
                    preds[p["img_id"]] = p
        if not preds:
            continue
        results[which] = score_set(rows, preds, which)
        if which == "synthetic":
            results[which]["dataset"] = {
                "specs": len({r["spec_id"] for r in rows}),
                "images": len(rows),
                "by_deg": {d: sum(1 for r in rows if r["deg"] == d) for d in sorted({r["deg"] for r in rows})},
                "by_kind": {k: sum(1 for r in rows if r["kind"] == k) for k in sorted({r["kind"] for r in rows})},
            }
            ren = read_jsonl(DATA / "renders.jsonl")
            drop = read_jsonl(DATA / "renders_dropped.jsonl")
            results[which]["dataset"]["renders_kept"] = len(ren)
            results[which]["dataset"]["renders_dropped"] = len(drop)
    led = read_jsonl(OUT / "ledger.jsonl")
    by = defaultdict(lambda: {"calls": 0, "ok": 0, "in": 0, "out": 0, "thinking": 0})
    for l in led:
        k = f"{l['feature']}|{l['model']}"
        by[k]["calls"] += 1; by[k]["ok"] += 1 if l["ok"] else 0
        for t in ("in", "out", "thinking"):
            by[k][t] += l.get(t) or 0
    results["ledger"] = dict(by)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    log(f"wrote {OUT/'results.json'}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("predict")
    p.add_argument("--set", choices=["synthetic", "real"], default="synthetic")
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--limit", type=int, default=0)
    s = sub.add_parser("score")
    s.add_argument("--hash", default=None, help="score predictions made with this prompt hash")
    a = ap.parse_args()
    {"predict": cmd_predict, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
